/**
 * 【一句话定位】拼装 Bash 工具交给大模型的「提示词 / 使用说明」——
 *   告诉模型这个工具能干什么、该怎么用、有哪些禁忌（超时、后台、沙箱、git 操作规范等）。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx（工具定义里引用 prompt）、以及系统提示词组装流程
 *   下游：constants/prompts.js（prependBullets  bullets 化）、utils/timeouts.js（超时默认值）、
 *        utils/sandbox/sandbox-adapter.js（沙箱配置）、utils/permissions/filesystem.js（临时目录）、
 *        utils/attribution.js（署名文案）、utils/undercover.js、utils/gitSettings.js、
 *        utils/embeddedTools.js、以及各工具的 TOOL_NAME 常量
 *   调用链：工具定义 -> getSimplePrompt() -> getCommitAndPRInstructions() / getSimpleSandboxSection()
 *
 * 【本文件包含什么】
 *   - getDefaultTimeoutMs() / getMaxTimeoutMs()：默认超时与最大超时（给提示词里写死数值用）
 *   - getBackgroundUsageNote()：run_in_background 参数的使用说明（功能被禁用时返回 null）
 *   - getCommitAndPRInstructions()：git 提交与 PR 的完整安全规范（内部版 vs 外部版两套）
 *   - dedup()：小工具，数组去重（用于精简提示词体积）
 *   - getSimpleSandboxSection()：把当前沙箱配置渲染成提示词里的一节
 *   - getSimplePrompt()：对外主入口，拼出完整的 Bash 工具说明
 *
 * 【提示词的组织逻辑】（读这个文件的要点）
 *   ① 先说「工具是什么」（执行 bash 并返回输出）
 *   ② 再强调「优先用专用工具」：读文件用 Read 而不是 cat、搜索用 Grep 而不是 grep……
 *      ——目的是让模型产出可被权限系统精确识别、可被用户直观审阅的调用
 *   ③ 然后是具体指令：路径加引号、保持工作目录、超时上限、多命令怎么拼、git 禁忌、别乱 sleep
 *   ④ 再拼沙箱章节（有沙箱才拼）
 *   ⑤ 最后拼 git 提交 / PR 章节
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `feature('X')` 是**编译期**开关（类似 C 的 #ifdef），不是运行时 if：
 *     打包时未启用的分支会被整段剔除，所以别指望运行时改配置能切换
 *   - 模板字符串 `...${expr}...`：用反引号包住，${} 内可以写任意表达式（≈ Java 的 String.format 但更强）
 *   - `...(cond ? [a] : [])`：数组里的条件展开，条件不满足就展开成 0 个元素（非常常见的写法）
 *   - `...(cond && { k: v })`：对象里的条件展开——&& 短路后若 cond 为假则展开 undefined，等于什么都不加
 *   - `Array<string | string[]>`：元素是「字符串或字符串数组」，用来表达「标题 + 子项列表」的层级结构
 *   - 泛型函数 `function dedup<T>(arr: T[])` ≈ Java 的 `<T> List<T> dedup(List<T> arr)`
 *   - `[...new Set(arr)]`：Set 去重后再展开回数组（Java: new ArrayList<>(new HashSet<>(arr))）
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import { feature } from 'bun:bundle'
import { prependBullets } from '../../constants/prompts.js'
import { getAttributionTexts } from '../../utils/attribution.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { shouldIncludeGitInstructions } from '../../utils/gitSettings.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import {
  getUndercoverInstructions,
  isUndercover,
} from '../../utils/undercover.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { TodoWriteTool } from '../TodoWriteTool/TodoWriteTool.js'
import { BASH_TOOL_NAME } from './toolName.js'

// 包一层而不是直接用常量：提示词里要展示超时数值，这里统一收口，改默认值时不用改提示词文本
export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

// 最大值：模型传的 timeout 参数超过它会被拒，提示词里必须写清楚上限，否则模型会瞎填
export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

/**
 * 【做什么】生成 run_in_background 参数的使用说明
 * 【为什么需要】后台执行是高频能力，但模型容易误用（比如同时加 & 和该参数），需要显式说明
 * 【返回】说明文案；功能被环境变量禁用时返回 null（调用方据此整段省略）
 */
function getBackgroundUsageNote(): string | null {
  // 环境变量总开关：某些环境（如受限沙箱/IDE 插件）不支持后台任务，就干脆不在提示词里提它
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return "You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter."
}

/**
 * 【做什么】生成 git 提交与 Pull Request 的操作规范（本文件最长的一段文案）
 * 【为什么需要】git 是最容易「一失手成千古恨」的场景（force push、reset --hard、amend），
 *   必须用提示词把安全协议写死，光靠权限系统拦不住模型主动发起的破坏性操作
 * 【返回】规范文案（可能为空串）
 * 【关键步骤】
 *   ① 先拼「保密（undercover）」段落——内部环境专用，且必须**无条件保留**：
 *      即使用户关掉了 git 指令，也要防止模型在提交信息里泄露内部代号（防御纵深）
 *   ② 用户关闭了 git 指令 → 直接返回（只剩保密段落）
 *   ③ 内部用户（ant）走「简短版」：引导去用 /commit、/commit-push-pr 这类技能
 *   ④ 外部用户走「完整版」：把 git 安全协议、提交步骤、PR 步骤全部内联写清楚
 */
function getCommitAndPRInstructions(): string {
  // Defense-in-depth: undercover instructions must survive even if the user
  // 中文补充（设计意图）：这段代码刻意放在 return 的**最前面**——
  //   即使用户完全关掉了 git 相关指令，这段「别暴露内部信息」的要求也必须留下。
  //   因为删署名、藏模型 ID 都是机械操作，而「别在提交信息里写出内部代号」只能靠提示词约束
  // has disabled git instructions entirely. Attribution stripping and model-ID
  // hiding are mechanical and work regardless, but the explicit "don't blow
  // your cover" instructions are the last line of defense against the model
  // volunteering an internal codename in a commit message.
  const undercoverSection =
    process.env.USER_TYPE === 'ant' && isUndercover()
      ? getUndercoverInstructions() + '\n'
      : ''

  if (!shouldIncludeGitInstructions()) return undercoverSection

  // For ant users, use the short version pointing to skills
  // 两套文案的原因：内部用户有 /commit 等技能可用，提示词只需指路；
  //   外部用户没有这些技能，必须把每一步都写清楚，否则模型会乱来
  if (process.env.USER_TYPE === 'ant') {
    const skillsSection = !isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
      ? `For git commits and pull requests, use the \`/commit\` and \`/commit-push-pr\` skills:
- \`/commit\` - Create a git commit with staged changes
- \`/commit-push-pr\` - Commit, push, and create a pull request

These skills handle git safety protocols, proper commit message formatting, and PR creation.

Before creating a pull request, run \`/simplify\` to review your changes, then test end-to-end (e.g. via \`/tmux\` for interactive features).

`
      : ''
    return `${undercoverSection}# Git operations

${skillsSection}IMPORTANT: NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it.

Use the gh command via the Bash tool for other GitHub-related tasks including working with issues, checks, and releases. If given a Github URL use the gh command to get the information needed.

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`
  }

  // For external users, include full inline instructions
  // 解构时改名：`{ 原字段名: 新变量名 }`。署名文案（如 Co-Authored-By 行）需要拼进提交信息与 PR 正文
  const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()

  return `# Committing changes with git

Only create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:

You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. The numbered steps below indicate which commands should be batched in parallel.

Git Safety Protocol:
- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions 
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive

1. Run the following bash commands in parallel, each using the ${BASH_TOOL_NAME} tool:
  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.
  - Run a git diff command to see both staged and unstaged changes that will be committed.
  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.
2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:
  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.).
  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
  - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"
  - Ensure it accurately reflects the changes and their purpose
3. Run the following commands in parallel:
   - Add relevant untracked files to the staging area.
   - Create the commit with a message${commitAttribution ? ` ending with:\n   ${commitAttribution}` : '.'}
   - Run git status after the commit completes to verify success.
   Note: git status depends on the commit completing, so run it sequentially after the commit.
4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit

Important notes:
- NEVER run additional commands to read or explore code, besides git bash commands
- NEVER use the ${TodoWriteTool.name} or ${AGENT_TOOL_NAME} tools
- DO NOT push to the remote repository unless the user explicitly asks you to do so
- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.
- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:
<example>
git commit -m "$(cat <<'EOF'
   Commit message here.${commitAttribution ? `\n\n   ${commitAttribution}` : ''}
   EOF
   )"
</example>

# Creating pull requests
Use the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.

IMPORTANT: When the user asks you to create a pull request, follow these steps carefully:

1. Run the following bash commands in parallel using the ${BASH_TOOL_NAME} tool, in order to understand the current state of the branch since it diverged from the main branch:
   - Run a git status command to see all untracked files (never use -uall flag)
   - Run a git diff command to see both staged and unstaged changes that will be committed
   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote
   - Run a git log command and \`git diff [base-branch]...HEAD\` to understand the full commit history for the current branch (from the time it diverged from the base branch)
2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:
   - Keep the PR title short (under 70 characters)
   - Use the description/body for details, not the title
3. Run the following commands in parallel:
   - Create new branch if needed
   - Push to remote with -u flag if needed
   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.
<example>
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]${prAttribution ? `\n\n${prAttribution}` : ''}
EOF
)"
</example>

Important:
- DO NOT use the ${TodoWriteTool.name} or ${AGENT_TOOL_NAME} tools
- Return the PR URL when you're done, so the user can see it

# Other common operations
- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments`
}

// SandboxManager merges config from multiple sources (settings layers, defaults,
// CLI flags) without deduping, so paths like ~/.cache appear 3× in allowOnly.
// Dedup here before inlining into the prompt — affects only what the model sees,
// not sandbox enforcement. Saves ~150-200 tokens/request when sandbox is enabled.
/**
 * 【做什么】数组去重（保留原顺序由 Set 保证）
 * 【为什么需要】沙箱配置来自多个配置层（settings、默认值、CLI 参数）且未做去重，
 *   像 ~/.cache 这类路径会在 allowOnly 里出现三四次；写进提示词就是白白浪费 token
 * 【入参/返回】数组或 undefined（空数组/空值原样返回，不额外分配对象）
 * 【关键步骤】
 *   ① 空值或空数组直接返回（快路径）
 *   ② new Set(arr) 去重 → 展开回数组
 * 注意：这里只影响「模型看到什么」，**不影响**沙箱的实际执行策略
 */
function dedup<T>(arr: T[] | undefined): T[] | undefined {
  if (!arr || arr.length === 0) return arr
  return [...new Set(arr)]
}

/**
 * 【做什么】把当前沙箱的读写/网络限制渲染成提示词里的一节
 * 【为什么需要】模型如果不知道沙箱边界，会反复尝试被拒绝的操作、或误以为命令出错；
 *   把限制写清楚，模型才能主动规避（比如临时文件写 $TMPDIR 而不是 /tmp）
 * 【返回】章节文案；沙箱未启用时返回空串（整节不出现）
 * 【关键步骤】
 *   ① 沙箱没开 → 直接返回空串
 *   ② 从 SandboxManager 取四类配置：文件读、文件写、网络、unix socket、以及是否允许无沙箱命令
 *   ③ 把带 UID 的临时目录字面量替换成 $TMPDIR——这样不同用户拿到的是同一份提示词，
 *      可以复用全局 prompt cache（省 token 的关键技巧，不是安全问题）
 *   ④ 拼限制说明行（Filesystem / Network / Ignored violations）
 *   ⑤ 按「是否允许跳出沙箱」生成两套不同的行为准则
 *   ⑥ 末尾统一加上「临时文件请用 $TMPDIR」的提醒
 */
function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''
  }

  const fsReadConfig = SandboxManager.getFsReadConfig()
  const fsWriteConfig = SandboxManager.getFsWriteConfig()
  const networkRestrictionConfig = SandboxManager.getNetworkRestrictionConfig()
  const allowUnixSockets = SandboxManager.getAllowUnixSockets()
  const ignoreViolations = SandboxManager.getIgnoreViolations()
  const allowUnsandboxedCommands =
    SandboxManager.areUnsandboxedCommandsAllowed()

  // Replace the per-UID temp dir literal (e.g. /private/tmp/claude-1001/) with
  // "$TMPDIR" so the prompt is identical across users — avoids busting the
  // cross-user global prompt cache. The sandbox already sets $TMPDIR at runtime.
  const claudeTempDir = getClaudeTempDir()
  // 为什么要把真实路径换成 $TMPDIR 字面量：
  //   /private/tmp/claude-1001/ 这种路径因人而异，写进提示词会让每个用户的提示词都不同，
  //   全局 prompt cache 直接失效。换成 $TMPDIR 后提示词统一，命中率大幅提升
  const normalizeAllowOnly = (paths: string[]): string[] =>
    [...new Set(paths)].map(p => (p === claudeTempDir ? '$TMPDIR' : p))

  const filesystemConfig = {
    read: {
      // 读权限的模型：denyOnly（只禁止这些）/ allowWithinDeny（禁止区里的例外）
      denyOnly: dedup(fsReadConfig.denyOnly),
      // `...(条件 && { 字段 })`：条件为真才把这个字段加进对象。
      //   原理：&& 短路后左边为假则整个表达式为假值，展开假值等于什么都不加（这是 TS 里很常见的条件字段写法）
      ...(fsReadConfig.allowWithinDeny && {
        allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
      }),
    },
    write: {
      // 写权限的模型：allowOnly（只允许这些）/ denyWithinAllow（允许区里的例外）——
      //   注意写权限是**白名单**思路，比读权限严格得多
      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
      denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
    },
  }

  const networkConfig = {
    ...(networkRestrictionConfig?.allowedHosts && {
      allowedHosts: dedup(networkRestrictionConfig.allowedHosts),
    }),
    ...(networkRestrictionConfig?.deniedHosts && {
      deniedHosts: dedup(networkRestrictionConfig.deniedHosts),
    }),
    ...(allowUnixSockets && { allowUnixSockets: dedup(allowUnixSockets) }),
  }

  // 用数组收集再 join，而不是一路拼字符串：避免末尾多余换行，也方便按条件增删行
  const restrictionsLines = []
  if (Object.keys(filesystemConfig).length > 0) {
    restrictionsLines.push(`Filesystem: ${jsonStringify(filesystemConfig)}`)
  }
  if (Object.keys(networkConfig).length > 0) {
    restrictionsLines.push(`Network: ${jsonStringify(networkConfig)}`)
  }
  if (ignoreViolations) {
    restrictionsLines.push(
      `Ignored violations: ${jsonStringify(ignoreViolations)}`,
    )
  }

  // Array<string | string[]> 的含义：每一项要么是一句话（string），要么是一组要点（string[]），
  //   这样可以用同一套 prependBullets 渲染出「标题 + 子列表」的层级结构
  const sandboxOverrideItems: Array<string | string[]> =
    allowUnsandboxedCommands
      ? [
          'You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:',
          [
            // 允许跳出沙箱的三个前提之一：用户明确要求。强调 explicit 是为了防止模型「我觉得用户可能需要」就自作主张
            'The user *explicitly* asks you to bypass sandbox',
            'A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).',
          ],
          'Evidence of sandbox-caused failures includes:',
          [
            '"Operation not permitted" errors for file/network operations',
            'Access denied to specific paths outside allowed directories',
            'Network connection failures to non-whitelisted hosts',
            'Unix socket connection errors',
          ],
          'When you see evidence of sandbox-caused failure:',
          [
            // 「别问，直接重试」的用意：已经确认是沙箱导致的失败，再问一次只是徒增往返
            "Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)",
            'Briefly explain what sandbox restriction likely caused the failure. Be sure to mention that the user can use the `/sandbox` command to manage restrictions.',
            'This will prompt the user for permission',
          ],
          'Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.',
          'Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.',
        ]
      : [
          // 策略层禁用了跳出沙箱时，提示词必须说死，避免模型反复尝试一个根本不存在的逃生口
          'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.',
          'Commands cannot run outside the sandbox under any circumstances.',
          'If a command fails due to sandbox restrictions, work with the user to adjust sandbox settings instead.',
        ]

  const items: Array<string | string[]> = [
    ...sandboxOverrideItems,
    'For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.',
  ]

  return [
    '',
    '## Command sandbox',
    'By default, your command will be run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.',
    '',
    'The sandbox has the following restrictions:',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

/**
 * 【做什么】拼出 Bash 工具的完整使用说明（对外主入口）
 * 【为什么需要】工具描述越精确，模型越倾向用专用工具而不是裸 bash，
 *   这对权限系统的可识别性、对用户审阅体验都是决定性的
 * 【返回】完整提示词字符串
 * 【关键步骤】
 *   ① 判断是否内嵌了搜索工具（bfs/ugrep），据此调整「该用哪个工具」的建议清单
 *   ② 组装「工具偏好」清单：搜索用 Glob/Grep、读用 Read、改用 Edit、写用 Write
 *   ③ 组装指令清单：路径加引号、保持 cwd、超时说明、后台说明、多命令怎么拼、git 禁忌、别乱 sleep
 *   ④ 拼接：工具定义 → 偏好清单 → 指令 → 沙箱章节 → git/PR 章节
 *   ⑤ 所有条目通过 prependBullets 统一渲染成列表
 */
export function getSimplePrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep in Claude's shell,
  // so we don't steer away from them (and Glob/Grep tools are removed).
  // 内嵌版（ant-native）把 find/grep 换成了自带的 bfs/ugrep，性能更好，
  //   所以这时候**不再**劝模型避开 find/grep（劝了反而变慢）
  const embedded = hasEmbeddedSearchTools()

  // 核心策略：能用专用工具就别用 bash。原因有二——
  //   ① 专用工具的调用可被权限系统精确识别（Bash(git:*) 这种规则才有意义）
  //   ② 用户在确认框里看到 Read(file) 比看到 cat file 更容易判断
  const toolPreferenceItems = [
    // 条件展开：内嵌搜索工具时不出现 find/ls 相关提示（见上方 embedded 的说明）
    ...(embedded
      ? []
      : [
          `File search: Use ${GLOB_TOOL_NAME} (NOT find or ls)`,
          `Content search: Use ${GREP_TOOL_NAME} (NOT grep or rg)`,
        ]),
    `Read files: Use ${FILE_READ_TOOL_NAME} (NOT cat/head/tail)`,
    `Edit files: Use ${FILE_EDIT_TOOL_NAME} (NOT sed/awk)`,
    `Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
    'Communication: Output text directly (NOT echo/printf)',
  ]

  const avoidCommands = embedded
    ? '`cat`, `head`, `tail`, `sed`, `awk`, or `echo`'
    : '`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`'

  // 多命令的组织规则：能并行就多次调用、有依赖就 &&、不在乎失败才用 ;、
  //   **不能**用换行分隔命令（换行只在引号内字符串里才安全）
  const multipleCommandsSubitems = [
    `If the commands are independent and can run in parallel, make multiple ${BASH_TOOL_NAME} tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two ${BASH_TOOL_NAME} tool calls in parallel.`,
    `If the commands depend on each other and must run sequentially, use a single ${BASH_TOOL_NAME} call with '&&' to chain them together.`,
    "Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.",
    'DO NOT use newlines to separate commands (newlines are ok in quoted strings).',
  ]

  // git 的三条红线：优先新建 commit 而不是 amend、破坏性操作先想替代方案、绝不跳过 hook 和签名
  const gitSubitems = [
    'Prefer to create a new commit rather than amending an existing commit.',
    'Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.',
    'Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.',
  ]

  // 为什么专门劝模型别 sleep：sleep 是最典型的「假装在工作」行为，
  //   既拖慢任务又占着上下文。正确做法是用后台任务 + 完成通知
  const sleepSubitems = [
    'Do not sleep between commands that can run immediately — just run them.',
    // `feature('MONITOR_TOOL')` 是**编译期**开关（≈ C 的 #ifdef）：
    //   打包时若未启用该特性，整个分支会被删掉，运行时改配置也切不动
    ...(feature('MONITOR_TOOL')
      ? [
          'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.',
        ]
      : []),
    'If your command is long running and you would like to be notified when it finishes — use `run_in_background`. No sleep needed.',
    'Do not retry failing commands in a sleep loop — diagnose the root cause.',
    'If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.',
    // 同一个编译期开关的第二处用法：启用 Monitor 工具时，首命令 sleep≥2s 会被直接拦掉
    ...(feature('MONITOR_TOOL')
      ? [
          '`sleep N` as the first command with N ≥ 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.',
        ]
      : [
          'If you must poll an external process, use a check command (e.g. `gh run view`) rather than sleeping first.',
          'If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.',
        ]),
  ]
  // 后台说明可能为 null（功能被禁用），下面用 `!== null ? [x] : []` 决定要不要插入
  const backgroundNote = getBackgroundUsageNote()

  // 指令清单（同样支持「一句话」和「子项列表」两种条目）
  const instructionItems: Array<string | string[]> = [
    'If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.',
    'Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")',
    'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.',
    `You may specify an optional timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} minutes). By default, your command will timeout after ${getDefaultTimeoutMs()}ms (${getDefaultTimeoutMs() / 60000} minutes).`,
    // 为什么用 `!== null` 而不是 `&&`：backgroundNote 是字符串，空串也会被 && 判为假，
    //   但这里要的是「有文案就插入」，所以必须显式和 null 比较
    ...(backgroundNote !== null ? [backgroundNote] : []),
    'When issuing multiple commands:',
    multipleCommandsSubitems,
    'For git commands:',
    gitSubitems,
    'Avoid unnecessary `sleep` commands:',
    sleepSubitems,
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ]

  // 最终拼接：工具说明 → 禁忌工具清单 → 指令 → 沙箱 → git/PR。
  //   用数组 join('\n') 而不是 += 拼字符串，可读性和性能都更好
  return [
    'Executes a given bash command and returns its output.',
    '',
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
    '',
    `IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:`,
    '',
    ...prependBullets(toolPreferenceItems),
    `While the ${BASH_TOOL_NAME} tool can do similar things, it’s better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.`,
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    // 沙箱章节未启用时返回空串，插进来也不会产生多余空行（外层已单独加了 '' 占位行）
    getSimpleSandboxSection(),
    // 注意这里调用了**两次** getCommitAndPRInstructions()：一次判空、一次取值。
    //   代价很小（纯字符串拼装），换来的是写法上的简洁；若要优化可先存变量
    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
  ].join('\n')
}
