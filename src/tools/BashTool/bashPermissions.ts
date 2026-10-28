/**
 * 【一句话定位】Bash 工具的**权限判定中枢**：把一条 bash 命令拆成子命令，
 *   依次过「规则表（deny/ask/allow）→ 路径校验 → sed 约束 → 模式 → 只读规则」这套流水线，
 *   最后给出 allow / deny / ask 三种结论之一（ask 时还会附带「建议保存什么规则」）。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx 的 needsPermissions / 权限弹窗流程
 *   下游：几乎调用了本目录的所有模块——bashCommandHelpers.js（管道/子 shell）、
 *        bashSecurity.js（语法层安全扫描）、modeValidation.js（模式）、pathValidation.js（路径）、
 *        sedValidation.js（sed 约束）、shouldUseSandbox.js（沙箱）、
 *        utils/permissions/*（规则存储与匹配）、utils/bash/ast.js（tree-sitter 解析）、
 *        utils/permissions/bashClassifier.js（用 Haiku 做语义分类）
 *   调用链：BashTool.needsPermissions -> bashToolHasPermission -> [AST 解析 → 沙箱自动放行 →
 *            精确规则 → 分类器 → 管道处理 → 安全扫描 → 拆分 → 逐子命令 bashToolCheckPermission]
 *
 * 【本文件包含什么】
 *   - 常量：MAX_SUBCOMMANDS_FOR_SECURITY_CHECK、MAX_SUGGESTED_RULES_FOR_COMPOUND、
 *     SAFE_ENV_VARS / ANT_ONLY_SAFE_ENV_VARS（可安全剥离的环境变量白名单）、
 *     BARE_SHELL_PREFIXES（禁止被建议成规则的命令前缀）、BINARY_HIJACK_VARS
 *   - 建议生成：getSimpleCommandPrefix / getFirstWordPrefix / suggestionForExactCommand /
 *     suggestionForPrefix / extractPrefixBeforeHeredoc
 *   - 规则匹配：bashPermissionRule / matchWildcardPattern / permissionRuleExtractPrefix /
 *     filterRulesByContentsMatchingInput / matchingRulesForInput /
 *     bashToolCheckExactMatchPermission / bashToolCheckPermission
 *   - 归一化：stripCommentLines / stripSafeWrappers / stripWrappersFromArgv /
 *     stripAllLeadingEnvVars / skipTimeoutFlags
 *   - 分类器：buildPendingClassifierCheck / startSpeculativeClassifierCheck /
 *     consumeSpeculativeClassifierCheck / awaitClassifierAutoApproval / executeAsyncClassifierCheck
 *   - 主流程：checkCommandAndSuggestRules / checkSandboxAutoAllow / bashToolHasPermission
 *   - 命令识别：isNormalizedGitCommand / isNormalizedCdCommand / commandHasAnyCd
 *
 * 【权限判定的顺序（理解本目录的关键）】
 *   一条命令要「被允许」，必须依次通过下面这些关卡（任何一关 deny 就终止，ask 就弹窗）：
 *   ① **语法层解析**：tree-sitter 解析成功 → 得到干净的子命令；解析不出/结构太复杂 → 直接 ask
 *   ② **沙箱自动放行**：开了沙箱且策略允许 → 只要没有显式 deny/ask 规则就放行
 *   ③ **精确匹配规则**：deny > ask > allow（Bash(git status) 这种整条命令的规则）
 *   ④ **分类器**：用 Haiku 判断命令是否命中用户用自然语言写的 deny/ask 描述
 *   ⑤ **管道 / 子 shell**：拆成段，逐段递归走完整流程，并拦 cd+git 组合
 *   ⑥ **安全扫描**（bashSecurity）：反引号、$()、混淆 flag、反斜杠操作符…
 *   ⑦ **拆分 + 逐子命令**：前缀规则 deny > ask > 路径校验 > 精确 allow > 前缀 allow >
 *     sed 约束 > 模式（acceptEdits）> 只读规则
 *   ⑧ 都没命中 → passthrough（弹窗询问），并给出可保存的规则建议
 *
 * 【规则的分类逻辑】
 *   - deny 规则：优先级最高，且匹配时**更激进**（会剥掉所有环境变量前缀、也会逐子命令匹配），
 *     因为「被禁止的命令换个写法也必须禁止」
 *   - allow 规则：匹配时**更保守**（只剥白名单里的环境变量、且不允许匹配复合命令），
 *     因为「放行的口子不能开太大」
 *   - 规则写法三种：exact（Bash(git status)）、prefix（Bash(git:*)）、wildcard（Bash(git *:*)）
 *   这条「deny 从严、allow 从宽（反过来说是 allow 从紧）」的不对称设计，是本文件的核心安全思路
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `feature('X')` 是**编译期**开关（≈ C 的 #ifdef）：打包时未启用的分支会被整段删除，
 *     运行时改配置切不动。本文件多处 `...(feature('BASH_CLASSIFIER') ? {...} : {})` 就是这个用途
 *   - `...(cond ? { a: 1 } : {})`：条件展开对象——条件为真才把字段加进去
 *   - `??=` 空值赋值的简写：`a ??= b` ≈ `if (a === null || a === undefined) a = b`
 *   - `readonly string[]` 只读数组；`as const` 把字面量锁成具体类型
 *   - `Record<K,V>` / `Map<K,V>` / `Set<T>` ≈ Java 的 Map / HashMap / HashSet
 *   - 解构默认值 `function f(input, { a = false }: { a?: boolean } = {})`：不传就是空对象
 *   - `Promise.all([...])` ≈ CompletableFuture.allOf，并发等待
 *   - `arr.flatMap(fn)` ≈ flatMap；`arr.some/every/find/filter` ≈ anyMatch/allMatch/findFirst/filter
 *   - `Awaited<ReturnType<typeof f>>`：工具类型，取「f 返回值的 Promise 里包的类型」
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import { feature } from 'bun:bundle'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import type { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { PendingClassifierCheck } from '../../types/permissions.js'
import { count } from '../../utils/array.js'
import {
  checkSemantics,
  nodeTypeId,
  type ParseForSecurityResult,
  parseForSecurityFromAst,
  type Redirect,
  type SimpleCommand,
} from '../../utils/bash/ast.js'
import {
  type CommandPrefixResult,
  extractOutputRedirections,
  getCommandSubcommandPrefix,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { parseCommandRaw } from '../../utils/bash/parser.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { AbortError } from '../../utils/errors.js'
import type {
  ClassifierBehavior,
  ClassifierResult,
} from '../../utils/permissions/bashClassifier.js'
import {
  classifyBashCommand,
  getBashPromptAllowDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
  isClassifierPermissionsEnabled,
} from '../../utils/permissions/bashClassifier.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import type {
  PermissionRule,
  PermissionRuleValue,
} from '../../utils/permissions/PermissionRule.js'
import { extractRules } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForTool,
} from '../../utils/permissions/permissions.js'
import {
  parsePermissionRule,
  type ShellPermissionRule,
  matchWildcardPattern as sharedMatchWildcardPattern,
  permissionRuleExtractPrefix as sharedPermissionRuleExtractPrefix,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
  suggestionForPrefix as sharedSuggestionForPrefix,
} from '../../utils/permissions/shellRuleMatching.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import { BashTool } from './BashTool.js'
import { checkCommandOperatorPermissions } from './bashCommandHelpers.js'
import {
  bashCommandIsSafeAsync_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from './bashSecurity.js'
import { checkPermissionMode } from './modeValidation.js'
import { checkPathConstraints } from './pathValidation.js'
import { checkSedConstraints } from './sedValidation.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'

// DCE cliff: Bun's feature() evaluator has a per-function complexity budget.
// bashToolHasPermission is right at the limit. `import { X as Y }` aliases
// inside the import block count toward this budget; when they push it over
// the threshold Bun can no longer prove feature('BASH_CLASSIFIER') is a
// constant and silently evaluates the ternaries to `false`, dropping every
// pendingClassifierCheck spread. Keep aliases as top-level const rebindings
// instead. (See also the comment on checkSemanticsDeny below.)
// 为什么要把 import 改名成顶层 const：Bun 的 feature() 求值有「单函数复杂度预算」，
//   在 import 语句里写 `import { X as Y }` 会计入这个预算，一旦超阈值 Bun 就无法证明
//   feature('BASH_CLASSIFIER') 是常量，会把下面的三元表达式静默求值成 false（真实事故）。
//   所以改用顶层常量重新绑定（本文件里好几处注释都在讲这个坑）
const bashCommandIsSafeAsync = bashCommandIsSafeAsync_DEPRECATED
const splitCommand = splitCommand_DEPRECATED

// Env-var assignment prefix (VAR=value). Shared across three while-loops that
// skip safe env vars before extracting the command name.
// 环境变量赋值前缀（VAR=value）的识别正则，三个地方共用
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/

// CC-643: On complex compound commands, splitCommand_DEPRECATED can produce a
// very large subcommands array (possible exponential growth; #21405's ReDoS fix
// may have been incomplete). Each subcommand then runs tree-sitter parse +
// ~20 validators + logEvent (bashSecurity.ts), and with memoized metadata the
// resulting microtask chain starves the event loop — REPL freeze at 100% CPU,
// strace showed /proc/self/stat reads at ~127Hz with no epoll_wait. Fifty is
// generous: legitimate user commands don't split that wide. Above the cap we
// fall back to 'ask' (safe default — we can't prove safety, so we prompt).
// 子命令数量的上限（性能保护）：复杂复合命令可能拆出极多的子命令，
//   每个都要跑一次 tree-sitter 解析 + 约 20 个验证器 + 埋点，会把事件循环饿死（REPL 卡死）。
//   超过上限直接 ask —— 证明不了安全就问用户，这是安全侧的默认取向
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50

// GH#11380: Cap the number of per-subcommand rules suggested for compound
// commands. Beyond this, the "Yes, and don't ask again for X, Y, Z…" label
// degrades to "similar commands" anyway, and saving 10+ rules from one prompt
// is more likely noise than intent. Users chaining this many write commands
// in one && list are rare; they can always approve once and add rules manually.
// 一次最多建议几条规则：再多 UI 上就退化成「类似命令」了，而且多半是噪音不是用户本意
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

/**
 * [ANT-ONLY] Log classifier evaluation results for analysis.
 * This helps us understand which classifier rules are being evaluated
 * and how the classifier is deciding on commands.
 */
// 仅内部环境（ant）才记录分类器结果：因为命令原文属于「代码/路径」类敏感数据，
//   外部版本不允许把它写进埋点。注意每个字段都用 as 标记了「已确认非代码/路径」的类型
function logClassifierResultForAnts(
  command: string,
  behavior: ClassifierBehavior,
  descriptions: string[],
  result: ClassifierResult,
): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  logEvent('tengu_internal_bash_classifier_result', {
    behavior:
      behavior as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    descriptions: jsonStringify(
      descriptions,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    matches: result.matches,
    matchedDescription: (result.matchedDescription ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    confidence:
      result.confidence as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason:
      result.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // Note: command contains code/filepaths - this is ANT-ONLY so it's OK
    command:
      command as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * Extract a stable command prefix (command + subcommand) from a raw command string.
 * Skips leading env var assignments only if they are in SAFE_ENV_VARS (or
 * ANT_ONLY_SAFE_ENV_VARS for ant users). Returns null if a non-safe env var is
 * encountered (to fall back to exact match), or if the second token doesn't look
 * like a subcommand (lowercase alphanumeric, e.g., "commit", "run").
 *
 * Examples:
 *   'git commit -m "fix typo"' → 'git commit'
 *   'NODE_ENV=prod npm run build' → 'npm run' (NODE_ENV is safe)
 *   'MY_VAR=val npm run build' → null (MY_VAR is not safe)
 *   'ls -la' → null (flag, not a subcommand)
 *   'cat file.txt' → null (filename, not a subcommand)
 *   'chmod 755 file' → null (number, not a subcommand)
 */
/**
 * 【做什么】从命令里提取「命令 + 子命令」这个两词前缀（如 git commit、npm run）
 * 【为什么需要】建议给用户保存的规则要有复用性：存 Bash(git commit:*) 比存整条命令有用得多
 * 【入参】command：命令原文
 * 【返回】两词前缀；无法提取时返回 null（调用方会退回整条命令的建议）
 * 【关键步骤】
 *   ① 按空白切词；先跳过开头的环境变量赋值（VAR=value）
 *   ② 遇到**不在安全白名单里**的环境变量就返回 null：
 *      因为这类前缀规则在真正匹配时永远匹配不上（stripSafeWrappers 不会剥它），存了也没用
 *   ③ 第二个词必须「像子命令」：小写字母开头、可含连字符，
 *      以此排除 flag（-rf）、文件名（file.txt）、路径（/tmp）、数字（755）
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // Skip env var assignments (VAR=value) at the start, but only if they are
  // in SAFE_ENV_VARS (or ANT_ONLY_SAFE_ENV_VARS for ant users). If a non-safe
  // env var is encountered, return null to fall back to exact match. This
  // prevents generating prefix rules like Bash(npm run:*) that can never match
  // at allow-rule check time, because stripSafeWrappers only strips safe vars.
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const remaining = tokens.slice(i)
  if (remaining.length < 2) return null
  const subcmd = remaining[1]!
  // Second token must look like a subcommand (e.g., "commit", "run", "compose"),
  // not a flag (-rf), filename (file.txt), path (/tmp), URL, or number (755).
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subcmd)) return null
  return remaining.slice(0, 2).join(' ')
}

// Bare-prefix suggestions like `bash:*` or `sh:*` would allow arbitrary code
// via `-c`. Wrapper suggestions like `env:*` or `sudo:*` would do the same:
// `env` is NOT in SAFE_WRAPPER_PATTERNS, so `env bash -c "evil"` survives
// stripSafeWrappers unchanged and hits the startsWith("env ") check at
// the prefix-rule matcher. Shell list mirrors DANGEROUS_SHELL_PREFIXES in
// src/utils/shell/prefix.ts which guarded the old Haiku extractor.
// 绝不能作为「建议规则」出现的命令前缀。原因：
//   Bash(bash:*) 等于放行任意代码（-c 参数可以执行任何东西）；
//   env / xargs / sudo 等「把参数当命令执行」的包装命令同理；
//   nice / stdbuf / nohup / timeout / time 被 checkSemantics 剥掉后，
//   建议 Bash(nice:*) 实际效果≈ Bash(*)，属于开了一个大口子
const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  // wrappers that exec their args as a command
  'env',
  'xargs',
  // SECURITY: checkSemantics (ast.ts) strips these wrappers to check the
  // wrapped command. Suggesting `Bash(nice:*)` would be ≈ `Bash(*)` — users
  // would add it after a prompt, then `nice rm -rf /` passes semantics while
  // deny/cd+git gates see 'nice' (SAFE_WRAPPER_PATTERNS below didn't strip
  // bare `nice` until this fix). Block these from ever being suggested.
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  // privilege escalation — sudo:* from `sudo -u foo ...` would auto-approve
  // any future sudo invocation
  'sudo',
  'doas',
  'pkexec',
])

/**
 * UI-only fallback: extract the first word alone when getSimpleCommandPrefix
 * declines. In external builds TREE_SITTER_BASH is off, so the async
 * tree-sitter refinement in BashPermissionRequest never fires — without this,
 * pipes and compounds (`python3 file.py 2>&1 | tail -20`) dump into the
 * editable field verbatim.
 *
 * Deliberately not used by suggestionForExactCommand: a backend-suggested
 * `Bash(rm:*)` is too broad to auto-generate, but as an editable starting
 * point it's what users expect (Slack C07VBSHV7EV/p1772670433193449).
 *
 * Reuses the same SAFE_ENV_VARS gate as getSimpleCommandPrefix — a rule like
 * `Bash(python3:*)` can never match `RUN=/path python3 ...` at check time
 * because stripSafeWrappers won't strip RUN.
 */
/**
 * 【做什么】UI 兜底：只取第一个词作为可编辑的起始值
 * 【为什么需要】外部版本没有 tree-sitter 的异步优化，像 `python3 file.py 2>&1 | tail -20`
 *   这类管道/复合命令会原样塞进可编辑框，体验很差
 * 【注意】只用于 UI 展示，**不用于自动生成规则**——Bash(rm:*) 这种规则太宽，不能自动提议
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const cmd = tokens[i]
  if (!cmd) return null
  // Same shape check as the subcommand regex in getSimpleCommandPrefix:
  // rejects paths (./script.sh, /usr/bin/python), flags, numbers, filenames.
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(cmd)) return null
  if (BARE_SHELL_PREFIXES.has(cmd)) return null
  return cmd
}

/**
 * 【做什么】为「这条命令该怎么存成规则」生成建议
 * 【为什么需要】用户点「是的，以后不再问」时，要给出一条**能复用**的规则
 * 【返回】建议数组（PermissionUpdate）
 * 【关键步骤】
 *   ① 含 heredoc：正文每次都变，存精确匹配毫无意义 → 取 heredoc 之前的前缀
 *   ② 多行命令：存整段会产出「中间带 :* 」的非法模式 → 只取第一行
 *   ③ 单行命令：尝试取两词前缀（如 git commit）
 *   ④ 都取不到 → 退回整条命令的精确规则
 */
function suggestionForExactCommand(command: string): PermissionUpdate[] {
  // Heredoc commands contain multi-line content that changes each invocation,
  // making exact-match rules useless (they'll never match again). Extract a
  // stable prefix before the heredoc operator and suggest a prefix rule instead.
  const heredocPrefix = extractPrefixBeforeHeredoc(command)
  if (heredocPrefix) {
    return sharedSuggestionForPrefix(BashTool.name, heredocPrefix)
  }

  // Multiline commands without heredoc also make poor exact-match rules.
  // Saving the full multiline text can produce patterns containing `:*` in
  // the middle, which fails permission validation and corrupts the settings
  // file. Use the first line as a prefix rule instead.
  if (command.includes('\n')) {
    const firstLine = command.split('\n')[0]!.trim()
    if (firstLine) {
      return sharedSuggestionForPrefix(BashTool.name, firstLine)
    }
  }

  // Single-line commands: extract a 2-word prefix for reusable rules.
  // Without this, exact-match rules are saved that never match future
  // invocations with different arguments.
  const prefix = getSimpleCommandPrefix(command)
  if (prefix) {
    return sharedSuggestionForPrefix(BashTool.name, prefix)
  }

  return sharedSuggestionForExactCommand(BashTool.name, command)
}

/**
 * If the command contains a heredoc (<<), extract the command prefix before it.
 * Returns the first word(s) before the heredoc operator as a stable prefix,
 * or null if the command doesn't contain a heredoc.
 *
 * Examples:
 *   'git commit -m "$(cat <<\'EOF\'\n...\nEOF\n)"' → 'git commit'
 *   'cat <<EOF\nhello\nEOF' → 'cat'
 *   'echo hello' → null (no heredoc)
 */
// heredoc 之前的部分才是「稳定的」：正文每次都不一样，不能进规则
function extractPrefixBeforeHeredoc(command: string): string | null {
  if (!command.includes('<<')) return null

  const idx = command.indexOf('<<')
  if (idx <= 0) return null

  const before = command.substring(0, idx).trim()
  if (!before) return null

  const prefix = getSimpleCommandPrefix(before)
  if (prefix) return prefix

  // Fallback: skip safe env var assignments and take up to 2 tokens.
  // This preserves flag tokens (e.g., "python3 -c" stays "python3 -c",
  // not just "python3") and skips safe env var prefixes like "NODE_ENV=test".
  // If a non-safe env var is encountered, return null to avoid generating
  // prefix rules that can never match (same rationale as getSimpleCommandPrefix).
  const tokens = before.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }
  if (i >= tokens.length) return null
  return tokens.slice(i, i + 2).join(' ') || null
}

function suggestionForPrefix(prefix: string): PermissionUpdate[] {
  return sharedSuggestionForPrefix(BashTool.name, prefix)
}

/**
 * Extract prefix from legacy :* syntax (e.g., "npm:*" -> "npm")
 * Delegates to shared implementation.
 */
export const permissionRuleExtractPrefix = sharedPermissionRuleExtractPrefix

/**
 * Match a command against a wildcard pattern (case-sensitive for Bash).
 * Delegates to shared implementation.
 */
// 通配符匹配（如 Bash(git *:*)）。委托给共享实现，避免在 Bash 与其它 shell 之间行为不一致
export function matchWildcardPattern(
  pattern: string,
  command: string,
): boolean {
  return sharedMatchWildcardPattern(pattern, command)
}

/**
 * Parse a permission rule into a structured rule object.
 * Delegates to shared implementation.
 */
export const bashPermissionRule: (
  permissionRule: string,
) => ShellPermissionRule = parsePermissionRule

/**
 * Whitelist of environment variables that are safe to strip from commands.
 * These variables CANNOT execute code or load libraries.
 *
 * SECURITY: These must NEVER be added to the whitelist:
 * - PATH, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_* (execution/library loading)
 * - PYTHONPATH, NODE_PATH, CLASSPATH, RUBYLIB (module loading)
 * - GOFLAGS, RUSTFLAGS, NODE_OPTIONS (can contain code execution flags)
 * - HOME, TMPDIR, SHELL, BASH_ENV (affect system behavior)
 */
// 「可以安全剥离」的环境变量白名单。判定标准是**这个变量不能影响代码执行或库加载**：
//   GOOS/RUST_LOG/NODE_ENV/LANG/TERM/颜色类 → 只影响输出与行为，安全；
//   而 PATH / LD_PRELOAD / LD_LIBRARY_PATH / DYLD_* / PYTHONPATH / NODE_PATH /
//   CLASSPATH / GOFLAGS / NODE_OPTIONS / HOME / TMPDIR / BASH_ENV 一律**禁止**加入——
//   它们能改变「实际运行哪个程序」或「加载什么库」，剥掉就等于放行了一次劫持
const SAFE_ENV_VARS = new Set([
  // Go - build/runtime settings only
  'GOEXPERIMENT', // experimental features
  'GOOS', // target OS
  'GOARCH', // target architecture
  'CGO_ENABLED', // enable/disable CGO
  'GO111MODULE', // module mode

  // Rust - logging/debugging only
  'RUST_BACKTRACE', // backtrace verbosity
  'RUST_LOG', // logging filter

  // Node - environment name only (not NODE_OPTIONS!)
  'NODE_ENV',

  // Python - behavior flags only (not PYTHONPATH!)
  'PYTHONUNBUFFERED', // disable buffering
  'PYTHONDONTWRITEBYTECODE', // no .pyc files

  // Pytest - test configuration
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD', // disable plugin loading
  'PYTEST_DEBUG', // debug output

  // API keys and authentication
  'ANTHROPIC_API_KEY', // API authentication

  // Locale and character encoding
  'LANG', // default locale
  'LANGUAGE', // language preference list
  'LC_ALL', // override all locale settings
  'LC_CTYPE', // character classification
  'LC_TIME', // time format
  'CHARSET', // character set preference

  // Terminal and display
  'TERM', // terminal type
  'COLORTERM', // color terminal indicator
  'NO_COLOR', // disable color output (universal standard)
  'FORCE_COLOR', // force color output
  'TZ', // timezone

  // Color configuration for various tools
  'LS_COLORS', // colors for ls (GNU)
  'LSCOLORS', // colors for ls (BSD/macOS)
  'GREP_COLOR', // grep match color (deprecated)
  'GREP_COLORS', // grep color scheme
  'GCC_COLORS', // GCC diagnostic colors

  // Display formatting
  'TIME_STYLE', // time display format for ls
  'BLOCK_SIZE', // block size for du/df
  'BLOCKSIZE', // alternative block size
])

/**
 * ANT-ONLY environment variables that are safe to strip from commands.
 * These are only enabled when USER_TYPE === 'ant'.
 *
 * SECURITY: These env vars are stripped before permission-rule matching, which
 * means `DOCKER_HOST=tcp://evil.com docker ps` matches a `Bash(docker ps:*)`
 * rule after stripping. This is INTENTIONALLY ANT-ONLY (gated at line ~380)
 * and MUST NEVER ship to external users. DOCKER_HOST redirects the Docker
 * daemon endpoint — stripping it defeats prefix-based permission restrictions
 * by hiding the network endpoint from the permission check. KUBECONFIG
 * similarly controls which cluster kubectl talks to. These are convenience
 * strippings for internal power users who accept the risk.
 *
 * Based on analysis of 30 days of tengu_internal_bash_tool_use_permission_request events.
 */
// 仅内部环境可用的补充白名单。注意 DOCKER_HOST / KUBECONFIG：它们决定「连哪个守护进程/集群」，
//   剥掉之后 `DOCKER_HOST=tcp://evil.com docker ps` 会匹配上 Bash(docker ps:*) 规则。
//   这对外部用户是危险的，所以严格限制在 ant 环境（英文注释里写明了这是内部便利与风险的取舍）
const ANT_ONLY_SAFE_ENV_VARS = new Set([
  // Kubernetes and container config (config file pointers, not execution)
  'KUBECONFIG', // kubectl config file path — controls which cluster kubectl uses
  'DOCKER_HOST', // Docker daemon socket/endpoint — controls which daemon docker talks to

  // Cloud provider project/profile selection (just names/identifiers)
  'AWS_PROFILE', // AWS profile name selection
  'CLOUDSDK_CORE_PROJECT', // GCP project ID
  'CLUSTER', // generic cluster name

  // Anthropic internal cluster selection (just names/identifiers)
  'COO_CLUSTER', // coo cluster name
  'COO_CLUSTER_NAME', // coo cluster name (alternate)
  'COO_NAMESPACE', // coo namespace
  'COO_LAUNCH_YAML_DRY_RUN', // dry run mode

  // Feature flags (boolean/string flags only)
  'SKIP_NODE_VERSION_CHECK', // skip version check
  'EXPECTTEST_ACCEPT', // accept test expectations
  'CI', // CI environment indicator
  'GIT_LFS_SKIP_SMUDGE', // skip LFS downloads

  // GPU/Device selection (just device IDs)
  'CUDA_VISIBLE_DEVICES', // GPU device selection
  'JAX_PLATFORMS', // JAX platform selection

  // Display/terminal settings
  'COLUMNS', // terminal width
  'TMUX', // TMUX socket info

  // Test/debug configuration
  'POSTGRESQL_VERSION', // postgres version string
  'FIRESTORE_EMULATOR_HOST', // emulator host:port
  'HARNESS_QUIET', // quiet mode flag
  'TEST_CROSSCHECK_LISTS_MATCH_UPDATE', // test update flag
  'DBT_PER_DEVELOPER_ENVIRONMENTS', // DBT config
  'STATSIG_FORD_DB_CHECKS', // statsig DB check flag

  // Build configuration
  'ANT_ENVIRONMENT', // Anthropic environment name
  'ANT_SERVICE', // Anthropic service name
  'MONOREPO_ROOT_DIR', // monorepo root path

  // Version selectors
  'PYENV_VERSION', // Python version selection

  // Credentials (approved subset - these don't change exfil risk)
  'PGPASSWORD', // Postgres password
  'GH_TOKEN', // GitHub token
  'GROWTHBOOK_API_KEY', // self-hosted growthbook
])

/**
 * Strips full-line comments from a command.
 * This handles cases where Claude adds comments in bash commands, e.g.:
 *   "# Check the logs directory\nls /home/user/logs"
 * Should be stripped to: "ls /home/user/logs"
 *
 * Only strips full-line comments (lines where the entire line is a comment),
 * not inline comments that appear after a command on the same line.
 */
/**
 * 【做什么】去掉「整行都是注释」的行（模型喜欢在命令开头写 # 说明在干嘛）
 * 【为什么需要】注释行不该参与命令名提取，否则第一条命令会被识别成注释
 * 【注意】只去整行注释，**不去行内注释**（`ls # 注释` 里的 # 后面内容保留），
 *   因为行内注释的 # 可能其实是参数的一部分
 */
function stripCommentLines(command: string): string {
  const lines = command.split('\n')
  const nonCommentLines = lines.filter(line => {
    const trimmed = line.trim()
    // Keep lines that are not empty and don't start with #
    return trimmed !== '' && !trimmed.startsWith('#')
  })

  // If all lines were comments/empty, return original
  if (nonCommentLines.length === 0) {
    return command
  }

  return nonCommentLines.join('\n')
}

/**
 * 【做什么】把命令开头的「安全包装」剥掉：环境变量赋值 + timeout / time / nice / stdbuf / nohup
 * 【为什么需要】规则匹配看的是命令名；若被 `timeout 10 rm -rf /` 这样的包装挡住，
 *   规则就永远匹配不到真实的 rm（等于给危险命令开了通行证）
 * 【入参】command：命令原文
 * 【返回】剥掉包装后的命令
 * 【关键步骤】
 *   ① 阶段一：只剥注释行与**白名单内**的环境变量（VAR=val cmd 在 bash 里是真正的赋值，可安全剥离）
 *   ② 阶段二：只剥包装命令与注释，**不再剥环境变量**——
 *      包装命令用 execvp 执行参数，它后面的 VAR=val 会被当成**要执行的命令**而不是赋值
 *      （这是 HackerOne 上发现的真实问题，两阶段顺序不能合并）
 *   ③ 循环到不再变化为止（可能有多层包装，如 `time timeout 5 cmd`）
 * 【安全细节】正则里统一用 [ \t]+ 而不是 \s+：\s 会匹配换行，
 *   跨行剥离会把「下一行的另一条命令」也一起剥掉
 */
export function stripSafeWrappers(command: string): string {
  // SECURITY: Use [ \t]+ not \s+ — \s matches \n/\r which are command
  // separators in bash. Matching across a newline would strip the wrapper from
  // one line and leave a different command on the next line for bash to execute.
  //
  // SECURITY: `(?:--[ \t]+)?` consumes the wrapper's own `--` so
  // `nohup -- rm -- -/../foo` strips to `rm -- -/../foo` (not `-- rm ...`
  // which would skip path validation with `--` as an unknown baseCmd).
  // 包装命令的剥离模式表。timeout 那条特别长，因为它要把 GNU 的各种 flag 形态都枚举清楚
  //   （--foreground、--kill-after=5、--kill-after 5、-k 5、-k5 …），
  //   而且 flag 的值只允许 [A-Za-z0-9_.+-]：否则 `timeout -k$(id) 10 ls` 会被剥成 ls 而 $(id) 照样执行
  const SAFE_WRAPPER_PATTERNS = [
    // timeout: enumerate GNU long flags — no-value (--foreground,
    // --preserve-status, --verbose), value-taking in both =fused and
    // space-separated forms (--kill-after=5, --kill-after 5, --signal=TERM,
    // --signal TERM). Short: -v (no-arg), -k/-s with separate or fused value.
    // SECURITY: flag VALUES use allowlist [A-Za-z0-9_.+-] (signals are
    // TERM/KILL/9, durations are 5/5s/10.5). Previously [^ \t]+ matched
    // $ ( ) ` | ; & — `timeout -k$(id) 10 ls` stripped to `ls`, matched
    // Bash(ls:*), while bash expanded $(id) during word splitting BEFORE
    // timeout ran. Contrast ENV_VAR_PATTERN below which already allowlists.
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    // SECURITY: keep in sync with checkSemantics wrapper-strip (ast.ts
    // ~:1990-2080) AND stripWrappersFromArgv (pathValidation.ts ~:1260).
    // Previously this pattern REQUIRED `-n N`; checkSemantics already handled
    // bare `nice` and legacy `-N`. Asymmetry meant checkSemantics exposed the
    // wrapped command to semantic checks but deny-rule matching and the cd+git
    // gate saw the wrapper name. `nice rm -rf /` with Bash(rm:*) deny became
    // ask instead of deny; `cd evil && nice git status` skipped the bare-repo
    // RCE gate. PR #21503 fixed stripWrappersFromArgv; this was missed.
    // Now matches: `nice cmd`, `nice -n N cmd`, `nice -N cmd` (all forms
    // checkSemantics strips).
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    // stdbuf: fused short flags only (-o0, -eL). checkSemantics handles more
    // (space-separated, long --output=MODE), but we fail-closed on those
    // above so not over-stripping here is safe. Main need: `stdbuf -o0 cmd`.
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ] as const

  // Pattern for environment variables:
  // ^([A-Za-z_][A-Za-z0-9_]*)  - Variable name (standard identifier)
  // =                           - Equals sign
  // ([A-Za-z0-9_./:-]+)         - Value: alphanumeric + safe punctuation only
  // [ \t]+                      - Required HORIZONTAL whitespace after value
  //
  // SECURITY: Only matches unquoted values with safe characters (no $(), `, $var, ;|&).
  //
  // SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+.
  // \s matches \n/\r. If reconstructCommand emits an unquoted newline between
  // `TZ=UTC` and `echo`, \s+ would match across it and strip `TZ=UTC<NL>`,
  // leaving `echo curl evil.com` to match Bash(echo:*). But bash treats the
  // newline as a command separator. Defense-in-depth with needsQuoting fix.
  // 值的字符类只放开「字母数字 + . / : - _」：刻意不含 $ ` ; | & 等，
  //   避免把 `FOO=$(id) cmd` 这类带命令替换的赋值当成普通赋值剥掉
  const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/

  let stripped = command
  let previousStripped = ''

  // Phase 1: Strip leading env vars and comments only.
  // 中文补充：阶段一与阶段二**必须分开**且顺序固定。
  //   命令前面（包装命令之前）的 VAR=val 是真正的 shell 赋值；
  //   而包装命令**之后**的 VAR=val 会被当成要执行的命令名——剥错了就会放行本该拦截的东西
  // In bash, env var assignments before a command (VAR=val cmd) are genuine
  // shell-level assignments. These are safe to strip for permission matching.
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const envVarMatch = stripped.match(ENV_VAR_PATTERN)
    if (envVarMatch) {
      const varName = envVarMatch[1]!
      const isAntOnlySafe =
        process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
      if (SAFE_ENV_VARS.has(varName) || isAntOnlySafe) {
        stripped = stripped.replace(ENV_VAR_PATTERN, '')
      }
    }
  }

  // Phase 2: Strip wrapper commands and comments only. Do NOT strip env vars.
  // 中文补充：阶段二里 `nohup -- rm ...` 的 -- 也要一起吃掉，
  //   否则剩下的 `-- rm ...` 会被当成「命令名是 --」而跳过路径校验
  // Wrapper commands (timeout, time, nice, nohup) use execvp to run their
  // arguments, so VAR=val after a wrapper is treated as the COMMAND to execute,
  // not as an env var assignment. Stripping env vars here would create a
  // mismatch between what the parser sees and what actually executes.
  // (HackerOne #3543050)
  previousStripped = ''
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, '')
    }
  }

  return stripped.trim()
}

// SECURITY: allowlist for timeout flag VALUES (signals are TERM/KILL/9,
// durations are 5/5s/10.5). Rejects $ ( ) ` | ; & and newlines that
// previously matched via [^ \t]+ — `timeout -k$(id) 10 ls` must NOT strip.
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * Parse timeout's GNU flags (long + short, fused + space-separated) and
 * return the argv index of the DURATION token, or -1 if flags are unparseable.
 * Enumerates: --foreground/--preserve-status/--verbose (no value),
 * --kill-after/--signal (value, both =fused and space-separated), -v (no
 * value), -k/-s (value, both fused and space-separated).
 *
 * Extracted from stripWrappersFromArgv to keep bashToolHasPermission under
 * Bun's feature() DCE complexity threshold — inlining this breaks
 * feature('BASH_CLASSIFIER') evaluation in classifier tests.
 */
/**
 * 【做什么】解析 timeout 的各类 flag，返回「时长参数」所在下标
 * 【为什么需要】只有越过所有 flag 才能找到真正的被包装命令
 * 【返回】时长下标；遇到不认识的 flag 返回 -1（**失败即保守**：不剥，交给人工确认）
 */
function skipTimeoutFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (
      arg === '--foreground' ||
      arg === '--preserve-status' ||
      arg === '--verbose'
    )
      i++
    else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (arg === '--') {
      i++
      break
    } // end-of-options marker
    else if (arg.startsWith('--')) return -1
    else if (arg === '-v') i++
    else if (
      (arg === '-k' || arg === '-s') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (arg.startsWith('-')) return -1
    else break
  }
  return i
}

/**
 * Argv-level counterpart to stripSafeWrappers. Strips the same wrapper
 * commands (timeout, time, nice, nohup) from AST-derived argv. Env vars
 * are already separated into SimpleCommand.envVars so no env-var stripping.
 *
 * KEEP IN SYNC with SAFE_WRAPPER_PATTERNS above — if you add a wrapper
 * there, add it here too.
 */
// 与 stripSafeWrappers 对应，但作用于 AST 解析好的 argv 数组（环境变量已被单独分离）。
//   注意：`for(;;)` 是无限循环，靠内部的 return 退出——可以处理 `time timeout 10 cmd` 这种多层包装
export function stripWrappersFromArgv(argv: string[]): string[] {
  // SECURITY: Consume optional `--` after wrapper options, matching what the
  // wrapper does. Otherwise `['nohup','--','rm','--','-/../foo']` yields `--`
  // as baseCmd and skips path validation. See SAFE_WRAPPER_PATTERNS comment.
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (
      a[0] === 'nice' &&
      a[1] === '-n' &&
      a[2] &&
      /^-?\d+$/.test(a[2])
    ) {
      a = a.slice(a[3] === '--' ? 4 : 3)
    } else {
      return a
    }
  }
}

/**
 * Env vars that make a *different binary* run (injection or resolution hijack).
 * Heuristic only — export-&& form bypasses this, and excludedCommands isn't a
 * security boundary anyway.
 */
// 会改变「实际执行哪个二进制/加载哪个库」的变量：LD_*/DYLD_* 控制动态链接，PATH 控制命令查找路径
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/

/**
 * Strip ALL leading env var prefixes from a command, regardless of whether the
 * var name is in the safe-list.
 *
 * Used for deny/ask rule matching: when a user denies `claude` or `rm`, the
 * command should stay blocked even if prefixed with arbitrary env vars like
 * `FOO=bar claude`. The safe-list restriction in stripSafeWrappers is correct
 * for allow rules (prevents `DOCKER_HOST=evil docker ps` from auto-matching
 * `Bash(docker ps:*)`), but deny rules must be harder to circumvent.
 *
 * Also used for sandbox.excludedCommands matching (not a security boundary —
 * permission prompts are), with BINARY_HIJACK_VARS as a blocklist.
 *
 * SECURITY: Uses a broader value pattern than stripSafeWrappers. The value
 * pattern excludes only actual shell injection characters ($, backtick, ;, |,
 * &, parens, redirects, quotes, backslash) and whitespace. Characters like
 * =, +, @, ~, , are harmless in unquoted env var assignment position and must
 * be matched to prevent trivial bypass via e.g. `FOO=a=b denied_command`.
 *
 * @param blocklist - optional regex tested against each var name; matching vars
 *   are NOT stripped (and stripping stops there). Omit for deny rules; pass
 *   BINARY_HIJACK_VARS for excludedCommands.
 */
/**
 * 【做什么】剥掉开头**所有**环境变量赋值（不看白名单）
 * 【为什么需要】deny 规则必须「更难绕过」：用户禁了 claude，那么 `FOO=bar claude` 也必须被禁。
 *   而 allow 规则用的是白名单版本（防止 `DOCKER_HOST=evil docker ps` 自动匹配放行规则）
 * 【入参】command：命令；blocklist：可选，命中的变量**不剥**并停止（如 BINARY_HIJACK_VARS）
 * 【返回】剥离后的命令
 */
export function stripAllLeadingEnvVars(
  command: string,
  blocklist?: RegExp,
): string {
  // Broader value pattern for deny-rule stripping. Handles:
  //
  // - Standard assignment (FOO=bar), append (FOO+=bar), array (FOO[0]=bar)
  // - Single-quoted values: '[^'\n\r]*' — bash suppresses all expansion
  // - Double-quoted values with backslash escapes: "(?:\\.|[^"$`\\\n\r])*"
  //   In bash double quotes, only \$, \`, \", \\, and \newline are special.
  //   Other \x sequences are harmless, so we allow \. inside double quotes.
  //   We still exclude raw $ and ` (without backslash) to block expansion.
  // - Unquoted values: excludes shell metacharacters, allows backslash escapes
  // - Concatenated segments: FOO='x'y"z" — bash concatenates adjacent segments
  //
  // SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+.
  //
  // The outer * matches one atomic unit per iteration: a complete quoted
  // string, a backslash-escape pair, or a single unquoted safe character.
  // The inner double-quote alternation (?:...|...)* is bounded by the
  // closing ", so it cannot interact with the outer * for backtracking.
  //
  // Note: $ is excluded from unquoted/double-quoted value classes to block
  // dangerous forms like $(cmd), ${var}, and $((expr)). This means
  // FOO=$VAR is not stripped — adding $VAR matching creates ReDoS risk
  // (CodeQL #671) and $VAR bypasses are low-priority.
  const ENV_VAR_PATTERN =
    /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*[ \t]+/

  let stripped = command
  let previousStripped = ''

  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const m = stripped.match(ENV_VAR_PATTERN)
    if (!m) continue
    if (blocklist?.test(m[1]!)) break
    stripped = stripped.slice(m[0].length)
  }

  return stripped.trim()
}

/**
 * 【做什么】在一批规则里筛出「能匹配当前命令」的那些
 * 【为什么需要】这是 allow / deny / ask 三类规则共用的匹配引擎，
 *   也是「deny 从宽匹配、allow 从严匹配」这条不对称策略的落点
 * 【入参】input：工具入参；rules：规则表；matchMode：'exact' 或 'prefix'；
 *       选项：stripAllEnvVars（deny/ask 用）、skipCompoundCheck
 * 【返回】命中的规则数组
 * 【关键步骤】
 *   ① 先去掉输出重定向（让 Bash(python:*) 能匹配 `python a.py > out.txt`；
 *      重定向目标本身的安全性由 checkPathConstraints 单独校验）
 *   ② 生成若干「候选写法」：原文 + 剥包装后的版本（deny/ask 还会再叠加剥全部环境变量的版本），
 *      迭代到不再产生新候选（不动点），以处理 `nohup FOO=bar timeout 5 claude` 这种交错
 *   ③ 预计算每个候选是不是复合命令
 *   ④ 按规则类型匹配：exact 全等；prefix 要求「整条等于前缀」或「前缀 + 空格开头」（保证词边界）；
 *      wildcard 只在 prefix 模式下才允许匹配（exact 模式下通配符会跨过 && 等操作符，不安全）
 *   ⑤ prefix / wildcard 都**拒绝匹配复合命令**（Bash(cd:*) 不该匹配 `cd /x && python3 evil.py`）
 */
function filterRulesByContentsMatchingInput(
  input: z.infer<typeof BashTool.inputSchema>,
  rules: Map<string, PermissionRule>,
  matchMode: 'exact' | 'prefix',
  {
    stripAllEnvVars = false,
    skipCompoundCheck = false,
  }: { stripAllEnvVars?: boolean; skipCompoundCheck?: boolean } = {},
): PermissionRule[] {
  const command = input.command.trim()

  // Strip output redirections for permission matching
  // This allows rules like Bash(python:*) to match "python script.py > output.txt"
  // Security validation of redirection targets happens separately in checkPathConstraints
  const commandWithoutRedirections =
    extractOutputRedirections(command).commandWithoutRedirections

  // For exact matching, try both the original command (to preserve quotes)
  // and the command without redirections (to allow rules without redirections to match)
  // For prefix matching, only use the command without redirections
  const commandsForMatching =
    matchMode === 'exact'
      ? [command, commandWithoutRedirections]
      : [commandWithoutRedirections]

  // Strip safe wrapper commands (timeout, time, nice, nohup) and env vars for matching
  // This allows rules like Bash(npm install:*) to match "timeout 10 npm install foo"
  // or "GOOS=linux go build"
  const commandsToTry = commandsForMatching.flatMap(cmd => {
    const strippedCommand = stripSafeWrappers(cmd)
    return strippedCommand !== cmd ? [cmd, strippedCommand] : [cmd]
  })

  // SECURITY: For deny/ask rules, also try matching after stripping ALL leading
  // env var prefixes. This prevents bypass via `FOO=bar denied_command` where
  // FOO is not in the safe-list. The safe-list restriction in stripSafeWrappers
  // is intentional for allow rules (see HackerOne #3543050), but deny rules
  // must be harder to circumvent — a denied command should stay denied
  // regardless of env var prefixes.
  //
  // We iteratively apply both stripping operations to all candidates until no
  // new candidates are produced (fixed-point). This handles interleaved patterns
  // like `nohup FOO=bar timeout 5 claude` where:
  //   1. stripSafeWrappers strips `nohup` → `FOO=bar timeout 5 claude`
  //   2. stripAllLeadingEnvVars strips `FOO=bar` → `timeout 5 claude`
  //   3. stripSafeWrappers strips `timeout 5` → `claude` (deny match)
  //
  // Without iteration, single-pass compositions miss multi-layer interleaving.
  if (stripAllEnvVars) {
    const seen = new Set(commandsToTry)
    let startIdx = 0

    // Iterate until no new candidates are produced (fixed-point)
    while (startIdx < commandsToTry.length) {
      const endIdx = commandsToTry.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = commandsToTry[i]
        if (!cmd) {
          continue
        }
        // Try stripping env vars
        const envStripped = stripAllLeadingEnvVars(cmd)
        if (!seen.has(envStripped)) {
          commandsToTry.push(envStripped)
          seen.add(envStripped)
        }
        // Try stripping safe wrappers
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          commandsToTry.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }
  }

  // Precompute compound-command status for each candidate to avoid re-parsing
  // inside the rule filter loop (which would scale splitCommand calls with
  // rules.length × commandsToTry.length). The compound check only applies to
  // prefix/wildcard matching in 'prefix' mode, and only for allow rules.
  // SECURITY: deny/ask rules must match compound commands so they can't be
  // bypassed by wrapping a denied command in a compound expression.
  // 预先算好「每个候选是不是复合命令」，避免在规则循环里反复拆分（规则数 × 候选数 会很慢）
  const isCompoundCommand = new Map<string, boolean>()
  if (matchMode === 'prefix' && !skipCompoundCheck) {
    for (const cmd of commandsToTry) {
      if (!isCompoundCommand.has(cmd)) {
        isCompoundCommand.set(cmd, splitCommand(cmd).length > 1)
      }
    }
  }

  return Array.from(rules.entries())
    .filter(([ruleContent]) => {
      const bashRule = bashPermissionRule(ruleContent)

      return commandsToTry.some(cmdToMatch => {
        switch (bashRule.type) {
          case 'exact':
            return bashRule.command === cmdToMatch
          case 'prefix':
            switch (matchMode) {
              // In 'exact' mode, only return true if the command exactly matches the prefix rule
              case 'exact':
                return bashRule.prefix === cmdToMatch
              case 'prefix': {
                // SECURITY: Don't allow prefix rules to match compound commands.
                // 中文补充：为什么还要在这里**再拆一次**——外层虽然已经拆过，但 shell 转义能让第一次拆分失效，
                //   例如 `cd src\&\& python3 hello.py` 拆出来还是一条「以 cd 开头」的命令。再拆一次才能识破
                // e.g., Bash(cd:*) must NOT match "cd /path && python3 evil.py".
                // In the normal flow commands are split before reaching here, but
                // shell escaping can defeat the first splitCommand pass — e.g.,
                //   cd src\&\& python3 hello.py  →  splitCommand  →  ["cd src&& python3 hello.py"]
                // which then looks like a single command that starts with "cd ".
                // Re-splitting the candidate here catches those cases.
                if (isCompoundCommand.get(cmdToMatch)) {
                  return false
                }
                // Ensure word boundary: prefix must be followed by space or end of string
                // This prevents "ls:*" from matching "lsof" or "lsattr"
                if (cmdToMatch === bashRule.prefix) {
                  return true
                }
                if (cmdToMatch.startsWith(bashRule.prefix + ' ')) {
                  return true
                }
                // Also match "xargs <prefix>" for bare xargs with no flags.
                // This allows Bash(grep:*) to match "xargs grep pattern",
                // and deny rules like Bash(rm:*) to block "xargs rm file".
                // Natural word-boundary: "xargs -n1 grep" does NOT start with
                // "xargs grep " so flagged xargs invocations are not matched.
                // 让 Bash(grep:*) 也能匹配 `xargs grep pattern`：xargs 不带 flag 时就是把参数当命令跑。
                //   而 `xargs -n1 grep` 不算（带了 flag，语义不同），这也让带 flag 的 xargs 不会被误放行
                const xargsPrefix = 'xargs ' + bashRule.prefix
                if (cmdToMatch === xargsPrefix) {
                  return true
                }
                return cmdToMatch.startsWith(xargsPrefix + ' ')
              }
            }
            break
          case 'wildcard':
            // SECURITY FIX: In exact match mode, wildcards must NOT match because we're
            // checking the full unparsed command. Wildcard matching on unparsed commands
            // allows "foo *" to match "foo arg && curl evil.com" since .* matches operators.
            // Wildcards should only match after splitting into individual subcommands.
            if (matchMode === 'exact') {
              return false
            }
            // SECURITY: Same as for prefix rules, don't allow wildcard rules to match
            // compound commands in prefix mode. e.g., Bash(cd *) must not match
            // "cd /path && python3 evil.py" even though "cd *" pattern would match it.
            if (isCompoundCommand.get(cmdToMatch)) {
              return false
            }
            // In prefix mode (after splitting), wildcards can safely match subcommands
            return matchWildcardPattern(bashRule.pattern, cmdToMatch)
        }
      })
    })
    .map(([, rule]) => rule)
}

/**
 * 【做什么】一次性取出当前命令命中的 deny / ask / allow 三类规则
 * 【为什么需要】三类规则的匹配策略不同（deny/ask 激进、allow 保守），在这里统一区分清楚
 * 【返回】{ matchingDenyRules, matchingAskRules, matchingAllowRules }
 */
function matchingRulesForInput(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  matchMode: 'exact' | 'prefix',
  { skipCompoundCheck = false }: { skipCompoundCheck?: boolean } = {},
) {
  const denyRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'deny',
  )
  // SECURITY: Deny/ask rules use aggressive env var stripping so that
  // `FOO=bar denied_command` still matches a deny rule for `denied_command`.
  const matchingDenyRules = filterRulesByContentsMatchingInput(
    input,
    denyRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const askRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'ask',
  )
  const matchingAskRules = filterRulesByContentsMatchingInput(
    input,
    askRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const allowRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'allow',
  )
  const matchingAllowRules = filterRulesByContentsMatchingInput(
    input,
    allowRuleByContents,
    matchMode,
    { skipCompoundCheck },
  )

  return {
    matchingDenyRules,
    matchingAskRules,
    matchingAllowRules,
  }
}

/**
 * Checks if the subcommand is an exact match for a permission rule
 */
/**
 * 【做什么】只用「整条命令精确匹配」的规则做判定
 * 【为什么需要】精确规则是用户显式指定过的，优先级最高；先判它可以避免被宽泛的前缀规则抢先
 * 【返回】deny（命中 deny 规则）/ ask / allow / passthrough（没命中，继续走前缀匹配）
 */
export const bashToolCheckExactMatchPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult => {
  const command = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')

  // 1. Deny if exact command was denied
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2. Ask if exact command was in ask rules
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. Allow if exact command was allowed
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 4. Otherwise, passthrough
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // Suggest exact match rule to user
    // this may be overridden by prefix suggestions in `checkCommandAndSuggestRules()`
    suggestions: suggestionForExactCommand(command),
  }
}

/**
 * 【做什么】单条子命令的完整权限判定（本文件最常用的判定函数）
 * 【为什么需要】把「规则 → 路径 → sed → 模式 → 只读」这条链路收在一处，顺序即策略
 * 【返回】deny / ask / allow / passthrough
 * 【关键步骤】
 *   ① 先做精确匹配；命中 deny/ask 直接返回
 *   ② 再做前缀匹配（deny > ask）——**刻意排在路径校验之前**，
 *      否则「项目外绝对路径」会因为路径校验先返回 ask 而绕过 deny 规则
 *   ③ 路径校验（checkPathConstraints）
 *   ④ 精确 allow → 前缀 allow
 *   ⑤ sed 约束（拦 w/e 这类危险操作，即使处于 acceptEdits 模式）
 *   ⑥ 模式判断（acceptEdits 下的文件系统命令白名单）
 *   ⑦ 只读规则（isReadOnly）
 *   ⑧ 都没命中 → passthrough + 给出规则建议
 */
export const bashToolCheckPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astCommand?: SimpleCommand,
): PermissionResult => {
  const command = input.command.trim()

  // 1. Check exact match first
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 1a. Deny/ask if exact command has a rule
  if (
    exactMatchResult.behavior === 'deny' ||
    exactMatchResult.behavior === 'ask'
  ) {
    return exactMatchResult
  }

  // 2. Find all matching rules (prefix or exact)
  // SECURITY FIX: Check Bash deny/ask rules BEFORE path constraints to prevent bypass
  // via absolute paths outside the project directory (HackerOne report)
  // When AST-parsed, the subcommand is already atomic — skip the legacy
  // splitCommand re-check that misparses mid-word # as compound.
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'prefix', {
      skipCompoundCheck: astCommand !== undefined,
    })

  // 2a. Deny if command has a deny rule
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. Ask if command has an ask rule
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. Check path constraints
  // This check comes after deny/ask rules so explicit rules take precedence.
  // SECURITY: When AST-derived argv is available for this subcommand, pass
  // it through so checkPathConstraints uses it directly instead of re-parsing
  // with shell-quote (which has a single-quote backslash bug that causes
  // parseCommandArguments to return [] and silently skip path validation).
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    toolPermissionContext,
    compoundCommandHasCd,
    astCommand?.redirects,
    astCommand ? [astCommand] : undefined,
  )
  if (pathResult.behavior !== 'passthrough') {
    return pathResult
  }

  // 4. Allow if command had an exact match allow
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 5. Allow if command has an allow rule
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 5b. Check sed constraints (blocks dangerous sed operations before mode auto-allow)
  const sedConstraintResult = checkSedConstraints(input, toolPermissionContext)
  if (sedConstraintResult.behavior !== 'passthrough') {
    return sedConstraintResult
  }

  // 6. Check for mode-specific permission handling
  const modeResult = checkPermissionMode(input, toolPermissionContext)
  if (modeResult.behavior !== 'passthrough') {
    return modeResult
  }

  // 7. Check read-only rules
  if (BashTool.isReadOnly(input)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Read-only command is allowed',
      },
    }
  }

  // 8. Passthrough since no rules match, will trigger permission prompt
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // Suggest exact match rule to user
    // this may be overridden by prefix suggestions in `checkCommandAndSuggestRules()`
    suggestions: suggestionForExactCommand(command),
  }
}

/**
 * Processes an individual subcommand and applies prefix checks & suggestions
 */
/**
 * 【做什么】处理单条子命令：先判权限，再补上「建议保存什么规则」
 * 【为什么需要】弹窗上要显示「是否允许 xxx，并记住规则」，建议内容在这里生成
 * 【入参】input、上下文、commandPrefixResult（前缀提取结果）、compoundCommandHasCd、
 *       astParseSucceeded（AST 解析是否成功，成功时可跳过旧版正则扫描以减少误报）
 * 【返回】PermissionResult（含 suggestions）
 * 【关键步骤】
 *   ① 精确匹配 → ② 前缀匹配 → ③ 安全扫描（bashCommandIsSafeAsync）→ ④ allow
 *   ⑤ 落到 ask/passthrough 时附上建议：能取到两词前缀就用前缀规则，否则用整条命令
 */
export async function checkCommandAndSuggestRules(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commandPrefixResult: CommandPrefixResult | null | undefined,
  compoundCommandHasCd?: boolean,
  astParseSucceeded?: boolean,
): Promise<PermissionResult> {
  // 1. Check exact match first
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }

  // 2. Check the command prefix
  const permissionResult = bashToolCheckPermission(
    input,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  // 2a. Deny/ask if command was explictly denied/asked
  if (
    permissionResult.behavior === 'deny' ||
    permissionResult.behavior === 'ask'
  ) {
    return permissionResult
  }

  // 3. Ask for permission if command injection is detected. Skip when the
  // AST parse already succeeded — tree-sitter has verified there are no
  // hidden substitutions or structural tricks, so the legacy regex-based
  // validators (backslash-escaped operators, etc.) would only add FPs.
  if (
    !astParseSucceeded &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const safetyResult = await bashCommandIsSafeAsync(input.command)

    if (safetyResult.behavior !== 'passthrough') {
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason:
          safetyResult.behavior === 'ask' && safetyResult.message
            ? safetyResult.message
            : 'This command contains patterns that could pose security risks and requires approval',
      }

      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        decisionReason,
        // 中文补充：安全扫描判定为「可疑」时**刻意不给建议**——
        //   否则用户一点「记住」就把一条危险命令永久放行了
        suggestions: [], // Don't suggest saving a potentially dangerous command
      }
    }
  }

  // 4. Allow if command was allowed
  if (permissionResult.behavior === 'allow') {
    return permissionResult
  }

  // 5. Suggest prefix if available, otherwise exact command
  const suggestedUpdates = commandPrefixResult?.commandPrefix
    ? suggestionForPrefix(commandPrefixResult.commandPrefix)
    : suggestionForExactCommand(input.command)

  return {
    ...permissionResult,
    suggestions: suggestedUpdates,
  }
}

/**
 * Checks if a command should be auto-allowed when sandboxed.
 * Returns early if there are explicit deny/ask rules that should be respected.
 *
 * NOTE: This function should only be called when sandboxing and auto-allow are enabled.
 *
 * @param input - The bash tool input
 * @param toolPermissionContext - The permission context
 * @returns PermissionResult with:
 *   - deny/ask if explicit rule exists (exact or prefix)
 *   - allow if no explicit rules (sandbox auto-allow applies)
 *   - passthrough should not occur since we're in auto-allow mode
 */
/**
 * 【做什么】沙箱开启且策略允许「沙箱内自动放行」时的判定
 * 【为什么需要】既然命令被关进沙箱（写不了项目外的文件），就可以大胆放行以提升体验
 * 【返回】deny / ask（有显式规则）/ allow（没有显式规则 → 沙箱自动放行）
 * 【关键步骤】
 *   ① 先查整条命令的 deny / ask 规则
 *   ② 复合命令要**逐子命令**再查一遍 deny：
 *      因为 Bash(rm:*) 这种前缀规则匹配不上 `echo hello && rm -rf /`（它不以 rm 开头）
 *   ③ 顺序上 deny 必须**全部查完**再返回 ask，避免把 deny 降级成 ask
 */
function checkSandboxAutoAllow(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()

  // Check for explicit deny/ask rules on the full command (exact + prefix)
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  )

  // Return immediately if there's an explicit deny rule on the full command
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // SECURITY: For compound commands, check each subcommand against deny/ask
  // rules. Prefix rules like Bash(rm:*) won't match the full compound command
  // (e.g., "echo hello && rm -rf /" doesn't start with "rm"), so we must
  // check each subcommand individually.
  // IMPORTANT: Subcommand deny checks must run BEFORE full-command ask returns.
  // Otherwise a wildcard ask rule matching the full command (e.g., Bash(*echo*))
  // would return 'ask' before a prefix deny rule on a subcommand (e.g., Bash(rm:*))
  // gets checked, downgrading a deny to an ask.
  const subcommands = splitCommand(command)
  if (subcommands.length > 1) {
    let firstAskRule: PermissionRule | undefined
    for (const sub of subcommands) {
      const subResult = matchingRulesForInput(
        { command: sub },
        toolPermissionContext,
        'prefix',
      )
      // Deny takes priority — return immediately
      if (subResult.matchingDenyRules[0] !== undefined) {
        return {
          behavior: 'deny',
          message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
          decisionReason: {
            type: 'rule',
            rule: subResult.matchingDenyRules[0],
          },
        }
      }
      // Stash first ask match; don't return yet (deny across all subs takes priority)
      // `??=` 是「只在还没值时才赋值」的简写：先记下第一个 ask 规则，但**不立即返回**，
      //   因为后面可能还有子命令命中 deny（deny 优先级更高，不能让先遇到的 ask 抢先返回）
      firstAskRule ??= subResult.matchingAskRules[0]
    }
    if (firstAskRule) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name),
        decisionReason: {
          type: 'rule',
          rule: firstAskRule,
        },
      }
    }
  }

  // Full-command ask check (after all deny sources have been exhausted)
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }
  // No explicit rules, so auto-allow with sandbox

  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'other',
      reason: 'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)',
    },
  }
}

/**
 * Filter out `cd ${cwd}` prefix subcommands, keeping astCommands aligned.
 * Extracted to keep bashToolHasPermission under Bun's feature() DCE
 * complexity threshold — inlining this breaks pendingClassifierCheck
 * attachment in ~10 classifier tests.
 */
function filterCdCwdSubcommands(
  rawSubcommands: string[],
  astCommands: SimpleCommand[] | undefined,
  cwd: string,
  cwdMingw: string,
): { subcommands: string[]; astCommandsByIdx: (SimpleCommand | undefined)[] } {
  const subcommands: string[] = []
  const astCommandsByIdx: (SimpleCommand | undefined)[] = []
  for (let i = 0; i < rawSubcommands.length; i++) {
    const cmd = rawSubcommands[i]!
    if (cmd === `cd ${cwd}` || cmd === `cd ${cwdMingw}`) continue
    subcommands.push(cmd)
    astCommandsByIdx.push(astCommands?.[i])
  }
  return { subcommands, astCommandsByIdx }
}

/**
 * Early-exit deny enforcement for the AST too-complex and checkSemantics
 * paths. Returns the exact-match result if non-passthrough (deny/ask/allow),
 * then checks prefix/wildcard deny rules. Returns null if neither matched,
 * meaning the caller should fall through to ask. Extracted to keep
 * bashToolHasPermission under Bun's feature() DCE complexity threshold.
 */
// 「结构太复杂」与「语义检查失败」这两条早退路径共用的 deny 强制执行：
//   先精确匹配，再前缀 deny。返回 null 表示没命中，调用方再按 ask 处理
function checkEarlyExitDeny(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult | null {
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }
  const denyMatch = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  ).matchingDenyRules[0]
  if (denyMatch !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }
  return null
}

/**
 * checkSemantics-path deny enforcement. Calls checkEarlyExitDeny (exact-match
 * + full-command prefix deny), then checks each individual SimpleCommand .text
 * span against prefix deny rules. The per-subcommand check is needed because
 * filterRulesByContentsMatchingInput has a compound-command guard
 * (splitCommand().length > 1 → prefix rules return false) that defeats
 * `Bash(eval:*)` matching against a full pipeline like `echo foo | eval rm`.
 * Each SimpleCommand span is a single command, so the guard doesn't fire.
 *
 * Separate helper (not folded into checkEarlyExitDeny or inlined at the call
 * site) because bashToolHasPermission is tight against Bun's feature() DCE
 * complexity threshold — adding even ~5 lines there breaks
 * feature('BASH_CLASSIFIER') evaluation and drops pendingClassifierCheck.
 */
/**
 * 【做什么】对 AST 解析出的每个 SimpleCommand 再查一遍 deny 规则
 * 【为什么需要】filterRulesByContentsMatchingInput 有个「复合命令保护」
 *   （拆出多于一条就拒绝前缀匹配），导致 Bash(eval:*) 匹配不上 `echo foo | eval rm` 这种管道。
 *   而 AST 的每个 SimpleCommand 本身就是单条命令，不会触发那个保护
 */
function checkSemanticsDeny(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commands: readonly { text: string }[],
): PermissionResult | null {
  const fullCmd = checkEarlyExitDeny(input, toolPermissionContext)
  if (fullCmd !== null) return fullCmd
  for (const cmd of commands) {
    const subDeny = matchingRulesForInput(
      { ...input, command: cmd.text },
      toolPermissionContext,
      'prefix',
    ).matchingDenyRules[0]
    if (subDeny !== undefined) {
      return {
        behavior: 'deny',
        message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
        decisionReason: { type: 'rule', rule: subDeny },
      }
    }
  }
  return null
}

/**
 * Builds the pending classifier check metadata if classifier is enabled and has allow descriptions.
 * Returns undefined if classifier is disabled, in auto mode, or no allow descriptions exist.
 */
// 构造「待执行的分类器检查」元数据。分类器在后台跑（弹窗显示时并行），
//   若高置信度判定为 allow 且用户还没操作，就自动批准
function buildPendingClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
): { command: string; cwd: string; descriptions: string[] } | undefined {
  if (!isClassifierPermissionsEnabled()) {
    return undefined
  }
  // Skip in auto mode - auto mode classifier handles all permission decisions
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto')
    return undefined
  if (toolPermissionContext.mode === 'bypassPermissions') return undefined

  const allowDescriptions = getBashPromptAllowDescriptions(
    toolPermissionContext,
  )
  if (allowDescriptions.length === 0) return undefined

  return {
    command,
    cwd: getCwd(),
    descriptions: allowDescriptions,
  }
}

// 「投机执行」的分类器结果缓存：提前发起分类请求，等真要用时直接取，省掉等待时间
const speculativeChecks = new Map<string, Promise<ClassifierResult>>()

/**
 * Start a speculative bash allow classifier check early, so it runs in
 * parallel with pre-tool hooks, deny/ask classifiers, and permission dialog setup.
 * The result can be consumed later by executeAsyncClassifierCheck via
 * consumeSpeculativeClassifierCheck.
 */
export function peekSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  return speculativeChecks.get(command)
}

/**
 * 【做什么】提前发起一次分类器调用（不等结果）
 * 【为什么需要】分类器要调模型，耗时长；与前置 hook、权限弹窗准备并行跑可以显著减少等待
 * 【返回】是否成功发起
 */
export function startSpeculativeClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): boolean {
  // Same guards as buildPendingClassifierCheck
  if (!isClassifierPermissionsEnabled()) return false
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto')
    return false
  if (toolPermissionContext.mode === 'bypassPermissions') return false
  const allowDescriptions = getBashPromptAllowDescriptions(
    toolPermissionContext,
  )
  if (allowDescriptions.length === 0) return false

  const cwd = getCwd()
  const promise = classifyBashCommand(
    command,
    cwd,
    allowDescriptions,
    'allow',
    signal,
    isNonInteractiveSession,
  )
  // Prevent unhandled rejection if the signal aborts before this promise is consumed.
  // The original promise (which may reject) is still stored in the Map for consumers to await.
  // 必须挂一个空的 catch：若请求在结果被消费前因 abort 而 reject，
  //   没有 catch 就会变成「未处理的 Promise 拒绝」而报错。真正的 promise 仍留在 Map 里供消费
  promise.catch(() => {})
  speculativeChecks.set(command, promise)
  return true
}

/**
 * Consume a speculative classifier check result for the given command.
 * Returns the promise if one exists (and removes it from the map), or undefined.
 */
export function consumeSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  const promise = speculativeChecks.get(command)
  if (promise) {
    speculativeChecks.delete(command)
  }
  return promise
}

export function clearSpeculativeChecks(): void {
  speculativeChecks.clear()
}

/**
 * Await a pending classifier check and return a PermissionDecisionReason if
 * high-confidence allow, or undefined otherwise.
 *
 * Used by swarm agents (both tmux and in-process) to gate permission
 * forwarding: run the classifier first, and only escalate to the leader
 * if the classifier doesn't auto-approve.
 */
// swarm 子智能体用：先跑分类器，只有分类器不批准时才上报给主智能体请求权限
export async function awaitClassifierAutoApproval(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionDecisionReason | undefined> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)
  const classifierResult = speculativeResult
    ? await speculativeResult
    : await classifyBashCommand(
        command,
        cwd,
        descriptions,
        'allow',
        signal,
        isNonInteractiveSession,
      )

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    return {
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    }
  }
  return undefined
}

type AsyncClassifierCheckCallbacks = {
  shouldContinue: () => boolean
  onAllow: (decisionReason: PermissionDecisionReason) => void
  onComplete?: () => void
}

/**
 * Execute the bash allow classifier check asynchronously.
 * This runs in the background while the permission prompt is shown.
 * If the classifier allows with high confidence and the user hasn't interacted, auto-approves.
 *
 * @param pendingCheck - Classifier check metadata from bashToolHasPermission
 * @param signal - Abort signal
 * @param isNonInteractiveSession - Whether this is a non-interactive session
 * @param callbacks - Callbacks to check if we should continue and handle approval
 */
/**
 * 【做什么】在权限弹窗显示期间后台跑分类器；高置信度 allow 且用户未操作 → 自动批准
 * 【入参】pendingCheck、signal、isNonInteractiveSession、callbacks（shouldContinue / onAllow / onComplete）
 * 【返回】无（结果通过回调传出）
 * 【关键步骤】
 *   ① 优先复用投机执行的结果
 *   ② 捕获异常：因取消（APIUserAbortError / AbortError）导致的失败属正常，静默结束；其它异常继续抛出
 *   ③ 用户已经操作过（方向键/tab/输入）就不再自动批准（shouldContinue）
 *   ④ 高置信度命中 → onAllow；否则 onComplete（用于清掉「检查中」的 UI 提示）
 */
export async function executeAsyncClassifierCheck(
  pendingCheck: { command: string; cwd: string; descriptions: string[] },
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  callbacks: AsyncClassifierCheckCallbacks,
): Promise<void> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)

  let classifierResult: ClassifierResult
  try {
    classifierResult = speculativeResult
      ? await speculativeResult
      : await classifyBashCommand(
          command,
          cwd,
          descriptions,
          'allow',
          signal,
          isNonInteractiveSession,
        )
  } catch (error: unknown) {
    // When the coordinator session is cancelled, the abort signal fires and the
    // classifier API call rejects with APIUserAbortError. This is expected and
    // should not surface as an unhandled promise rejection.
    if (error instanceof APIUserAbortError || error instanceof AbortError) {
      callbacks.onComplete?.()
      return
    }
    callbacks.onComplete?.()
    throw error
  }

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  // Don't auto-approve if user already made a decision or has interacted
  // with the permission dialog (e.g., arrow keys, tab, typing)
  if (!callbacks.shouldContinue()) return

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    callbacks.onAllow({
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    })
  } else {
    // No match — notify so the checking indicator is cleared
    callbacks.onComplete?.()
  }
}

/**
 * The main implementation to check if we need to ask for user permission to call BashTool with a given input
 */
/**
 * 【做什么】Bash 权限判定的**总入口**（本文件最重要的函数）
 * 【为什么需要】把「解析 → 沙箱 → 规则 → 分类器 → 管道 → 扫描 → 拆分 → 逐子命令」串成一条完整流水线
 * 【入参】input：工具入参；context：工具执行上下文（含权限上下文、abort 控制器等）；
 *       getCommandSubcommandPrefixFn：可注入的前缀提取函数（测试用）
 * 【返回】PermissionResult：allow / deny / ask / passthrough
 * 【关键步骤】
 *   ① AST 解析：成功得到干净子命令；太复杂 → 先查 deny，否则 ask；不可用 → 走旧版 shell-quote 路径
 *   ② 语义检查（checkSemantics）：zsh 内建、eval 这类「名字就危险」的命令 → 查 deny 后 ask
 *   ③ 沙箱自动放行（若开启）
 *   ④ 精确规则匹配（deny 直接返回）
 *   ⑤ 分类器：并行跑 deny 与 ask 描述（Haiku），deny 优先
 *   ⑥ 管道/子 shell 处理；若各段都 allow，还要回头校验**原始命令**的重定向与安全性
 *   ⑦ 旧版安全扫描（仅在 AST 不可用时）
 *   ⑧ 拆分子命令、过滤掉 `cd ${cwd}` 前缀、限制子命令数量上限
 *   ⑨ 多个 cd → ask；cd + git → ask（防裸仓库攻击）
 *   ⑩ 逐子命令判定；汇总 deny / ask / allow，并生成规则建议
 */
export async function bashToolHasPermission(
  input: z.infer<typeof BashTool.inputSchema>,
  context: ToolUseContext,
  getCommandSubcommandPrefixFn = getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  let appState = context.getAppState()

  // 0. AST-based security parse. This replaces both tryParseShellCommand
  // (the shell-quote pre-check) and the bashCommandIsSafe misparsing gate.
  // tree-sitter produces either a clean SimpleCommand[] (quotes resolved,
  // no hidden substitutions) or 'too-complex' — which is exactly the signal
  // we need to decide whether splitCommand's output can be trusted.
  //
  // When tree-sitter WASM is unavailable OR the injection check is disabled
  // via env var, we fall back to the old path (legacy gate at ~1370 runs).
  const injectionCheckDisabled = isEnvTruthy(
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK,
  )
  // GrowthBook killswitch for shadow mode — when off, skip the native parse
  // entirely. Computed once; feature() must stay inline in the ternary below.
  const shadowEnabled = feature('TREE_SITTER_BASH_SHADOW')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_birch_trellis', true)
    : false
  // Parse once here; the resulting AST feeds both parseForSecurityFromAst
  // and bashToolCheckCommandOperatorPermissions.
  let astRoot = injectionCheckDisabled
    ? null
    : feature('TREE_SITTER_BASH_SHADOW') && !shadowEnabled
      ? null
      : await parseCommandRaw(input.command)
  let astResult: ParseForSecurityResult = astRoot
    ? parseForSecurityFromAst(input.command, astRoot)
    : { kind: 'parse-unavailable' }
  let astSubcommands: string[] | null = null
  let astRedirects: Redirect[] | undefined
  let astCommands: SimpleCommand[] | undefined
  let shadowLegacySubs: string[] | undefined

  // Shadow-test tree-sitter: record its verdict, then force parse-unavailable
  // so the legacy path stays authoritative. parseCommand stays gated on
  // TREE_SITTER_BASH (not SHADOW) so legacy internals remain pure regex.
  // One event per bash call captures both divergence AND unavailability
  // reasons; module-load failures are separately covered by the
  // session-scoped tengu_tree_sitter_load event.
  if (feature('TREE_SITTER_BASH_SHADOW')) {
    const available = astResult.kind !== 'parse-unavailable'
    let tooComplex = false
    let semanticFail = false
    let subsDiffer = false
    if (available) {
      tooComplex = astResult.kind === 'too-complex'
      semanticFail =
        astResult.kind === 'simple' && !checkSemantics(astResult.commands).ok
      const tsSubs =
        astResult.kind === 'simple'
          ? astResult.commands.map(c => c.text)
          : undefined
      const legacySubs = splitCommand(input.command)
      shadowLegacySubs = legacySubs
      subsDiffer =
        tsSubs !== undefined &&
        (tsSubs.length !== legacySubs.length ||
          tsSubs.some((s, i) => s !== legacySubs[i]))
    }
    logEvent('tengu_tree_sitter_shadow', {
      available,
      astTooComplex: tooComplex,
      astSemanticFail: semanticFail,
      subsDiffer,
      injectionCheckDisabled,
      killswitchOff: !shadowEnabled,
      cmdOverLength: input.command.length > 10000,
    })
    // Always force legacy — shadow mode is observational only.
    astResult = { kind: 'parse-unavailable' }
    astRoot = null
  }

  // 解析成功但结构无法静态分析（命令替换、展开、控制流、解析器差异）→
  //   先尊重显式规则（精确 + 前缀 deny），都没有才 ask。**不能把 deny 降级成 ask**
  if (astResult.kind === 'too-complex') {
    // Parse succeeded but found structure we can't statically analyze
    // (command substitution, expansion, control flow, parser differential).
    // Respect exact-match deny/ask/allow, then prefix/wildcard deny. Only
    // fall through to ask if no deny matched — don't downgrade deny to ask.
    const earlyExit = checkEarlyExitDeny(input, appState.toolPermissionContext)
    if (earlyExit !== null) return earlyExit
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason: astResult.reason,
    }
    logEvent('tengu_bash_ast_too_complex', {
      nodeTypeId: nodeTypeId(astResult.nodeType),
    })
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      suggestions: [],
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  // 干净解析：再查一层「语义」——分词没问题但**名字本身危险**的情况（zsh 内建、eval 等）
  if (astResult.kind === 'simple') {
    // Clean parse: check semantic-level concerns (zsh builtins, eval, etc.)
    // that tokenize fine but are dangerous by name.
    const sem = checkSemantics(astResult.commands)
    if (!sem.ok) {
      // Same deny-rule enforcement as the too-complex path: a user with
      // `Bash(eval:*)` deny expects `eval "rm"` blocked, not downgraded.
      const earlyExit = checkSemanticsDeny(
        input,
        appState.toolPermissionContext,
        astResult.commands,
      )
      if (earlyExit !== null) return earlyExit
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason: sem.reason,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        suggestions: [],
      }
    }
    // Stash the tokenized subcommands for use below. Downstream code (rule
    // matching, path extraction, cd detection) still operates on strings, so
    // we pass the original source span for each SimpleCommand. Downstream
    // processing (stripSafeWrappers, parseCommandArguments) re-tokenizes
    // these spans — that re-tokenization has known bugs (stripCommentLines
    // mishandles newlines inside quotes), but checkSemantics already caught
    // any argv element containing a newline, so those bugs can't bite here.
    // Migrating downstream to operate on argv directly is a later commit.
    astSubcommands = astResult.commands.map(c => c.text)
    astRedirects = astResult.commands.flatMap(c => c.redirects)
    astCommands = astResult.commands
  }

  // Legacy shell-quote pre-check. Only reached on 'parse-unavailable'
  // (tree-sitter not loaded OR TREE_SITTER_BASH feature gated off). Falls
  // through to the full legacy path below.
  if (astResult.kind === 'parse-unavailable') {
    logForDebugging(
      'bashToolHasPermission: tree-sitter unavailable, using legacy shell-quote path',
    )
    const parseResult = tryParseShellCommand(input.command)
    if (!parseResult.success) {
      const decisionReason = {
        type: 'other' as const,
        reason: `Command contains malformed syntax that cannot be parsed: ${parseResult.error}`,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  // Check sandbox auto-allow (which respects explicit deny/ask rules)
  // 中文补充：沙箱内自动放行是「体验优化」，但**必须**让位于用户显式写的 deny/ask 规则
  // Only call this if sandboxing and auto-allow are both enabled
  if (
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  ) {
    const sandboxAutoAllowResult = checkSandboxAutoAllow(
      input,
      appState.toolPermissionContext,
    )
    if (sandboxAutoAllowResult.behavior !== 'passthrough') {
      return sandboxAutoAllowResult
    }
  }

  // Check exact match first
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    appState.toolPermissionContext,
  )

  // Exact command was denied
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // Check Bash prompt deny and ask rules in parallel (both use Haiku).
  // Deny takes precedence over ask, and both take precedence over allow rules.
  // Skip when in auto mode - auto mode classifier handles all permission decisions
  if (
    isClassifierPermissionsEnabled() &&
    !(
      feature('TRANSCRIPT_CLASSIFIER') &&
      appState.toolPermissionContext.mode === 'auto'
    )
  ) {
    const denyDescriptions = getBashPromptDenyDescriptions(
      appState.toolPermissionContext,
    )
    const askDescriptions = getBashPromptAskDescriptions(
      appState.toolPermissionContext,
    )
    const hasDeny = denyDescriptions.length > 0
    const hasAsk = askDescriptions.length > 0

    if (hasDeny || hasAsk) {
      const [denyResult, askResult] = await Promise.all([
        hasDeny
          ? classifyBashCommand(
              input.command,
              getCwd(),
              denyDescriptions,
              'deny',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
        hasAsk
          ? classifyBashCommand(
              input.command,
              getCwd(),
              askDescriptions,
              'ask',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
      ])

      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }

      if (denyResult) {
        logClassifierResultForAnts(
          input.command,
          'deny',
          denyDescriptions,
          denyResult,
        )
      }
      if (askResult) {
        logClassifierResultForAnts(
          input.command,
          'ask',
          askDescriptions,
          askResult,
        )
      }

      // Deny takes precedence
      if (denyResult?.matches && denyResult.confidence === 'high') {
        return {
          behavior: 'deny',
          message: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          decisionReason: {
            type: 'other',
            reason: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          },
        }
      }

      if (askResult?.matches && askResult.confidence === 'high') {
        // Skip the Haiku call — the UI computes the prefix locally
        // and lets the user edit it. Still call the injected function
        // when tests override it.
        let suggestions: PermissionUpdate[]
        if (getCommandSubcommandPrefixFn === getCommandSubcommandPrefix) {
          suggestions = suggestionForExactCommand(input.command)
        } else {
          const commandPrefixResult = await getCommandSubcommandPrefixFn(
            input.command,
            context.abortController.signal,
            context.options.isNonInteractiveSession,
          )
          if (context.abortController.signal.aborted) {
            throw new AbortError()
          }
          suggestions = commandPrefixResult?.commandPrefix
            ? suggestionForPrefix(commandPrefixResult.commandPrefix)
            : suggestionForExactCommand(input.command)
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name),
          decisionReason: {
            type: 'other',
            reason: `Required by Bash prompt rule: "${askResult.matchedDescription}"`,
          },
          suggestions,
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // Check for non-subcommand Bash operators like `>`, `|`, etc.
  // This must happen before dangerous path checks so that piped commands
  // are handled by the operator logic (which generates "multiple operations" messages)
  // 管道 / 子 shell / 命令组：这些「非普通子命令」的结构要先单独处理（会递归调用本函数）
  const commandOperatorResult = await checkCommandOperatorPermissions(
    input,
    (i: z.infer<typeof BashTool.inputSchema>) =>
      bashToolHasPermission(i, context, getCommandSubcommandPrefixFn),
    { isNormalizedCdCommand, isNormalizedGitCommand },
    astRoot,
  )
  if (commandOperatorResult.behavior !== 'passthrough') {
    // SECURITY FIX: When pipe segment processing returns 'allow', we must still validate
    // the ORIGINAL command. The pipe segment processing strips redirections before
    // checking each segment, so commands like:
    //   echo 'x' | xargs printf '%s' >> /tmp/file
    // would have both segments allowed (echo and xargs printf) but the >> redirection
    // would bypass validation. We must check:
    // 1. Path constraints for output redirections
    // 2. Command safety for dangerous patterns (backticks, etc.) in redirect targets
    // 危险点：管道处理时会先把重定向剥掉再逐段判定，于是
    //   `echo 'x' | xargs printf '%s' >> /tmp/file` 的每一段都合法、但 >> 本身没被校验过。
    //   所以这里要**回头**对原始命令补一次安全性与路径校验
    if (commandOperatorResult.behavior === 'allow') {
      // Check for dangerous patterns (backticks, $(), etc.) in the original command
      // This catches cases like: echo x | xargs echo > `pwd`/evil.txt
      // where the backtick is in the redirect target (stripped from segments)
      // Gate on AST: when astSubcommands is non-null, tree-sitter already
      // validated structure (backticks/$() in redirect targets would have
      // returned too-complex). Matches gating at ~1481, ~1706, ~1755.
      // Avoids FP: `find -exec {} \; | grep x` tripping on backslash-;.
      // bashCommandIsSafe runs the full legacy regex battery (~20 patterns) —
      // only call it when we'll actually use the result.
      const safetyResult =
        astSubcommands === null
          ? await bashCommandIsSafeAsync(input.command)
          : null
      if (
        safetyResult !== null &&
        safetyResult.behavior !== 'passthrough' &&
        safetyResult.behavior !== 'allow'
      ) {
        // Attach pending classifier check - may auto-approve before user responds
        appState = context.getAppState()
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name, {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          }),
          decisionReason: {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          },
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }

      appState = context.getAppState()
      // SECURITY: Compute compoundCommandHasCd from the full command, NOT
      // hardcode false. The pipe-handling path previously passed `false` here,
      // disabling the cd+redirect check at pathValidation.ts:821. Appending
      // `| echo done` to `cd .claude && echo x > settings.json` routed through
      // this path with compoundCommandHasCd=false, letting the redirect write
      // to .claude/settings.json without the cd+redirect block firing.
      // 注意这里传的是 commandHasAnyCd(input.command) 而不是硬编码 false：
      //   否则 `cd .claude && echo x > settings.json | echo done` 会绕过 cd+重定向 的拦截
      const pathResult = checkPathConstraints(
        input,
        getCwd(),
        appState.toolPermissionContext,
        commandHasAnyCd(input.command),
        astRedirects,
        astCommands,
      )
      if (pathResult.behavior !== 'passthrough') {
        return pathResult
      }
    }

    // When pipe segments return 'ask' (individual segments not allowed by rules),
    // attach pending classifier check - may auto-approve before user responds.
    if (commandOperatorResult.behavior === 'ask') {
      appState = context.getAppState()
      return {
        ...commandOperatorResult,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }

    return commandOperatorResult
  }

  // SECURITY: Legacy misparsing gate. Only runs when the tree-sitter module
  // is not loaded. Timeout/abort is fail-closed via too-complex (returned
  // early above), not routed here. When the AST parse succeeded,
  // astSubcommands is non-null and we've already validated structure; this
  // block is skipped entirely. The AST's 'too-complex' result subsumes
  // everything isBashSecurityCheckForMisparsing covered — both answer the
  // same question: "can splitCommand be trusted on this input?"
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const originalCommandSafetyResult = await bashCommandIsSafeAsync(
      input.command,
    )
    if (
      originalCommandSafetyResult.behavior === 'ask' &&
      originalCommandSafetyResult.isBashSecurityCheckForMisparsing
    ) {
      // Compound commands with safe heredoc patterns ($(cat <<'EOF'...EOF))
      // trigger the $() check on the unsplit command. Strip the safe heredocs
      // and re-check the remainder — if other misparsing patterns exist
      // (e.g. backslash-escaped operators), they must still block.
      const remainder = stripSafeHeredocSubstitutions(input.command)
      const remainderResult =
        remainder !== null ? await bashCommandIsSafeAsync(remainder) : null
      if (
        remainder === null ||
        (remainderResult?.behavior === 'ask' &&
          remainderResult.isBashSecurityCheckForMisparsing)
      ) {
        // Allow if the exact command has an explicit allow permission — the user
        // made a conscious choice to permit this specific command.
        appState = context.getAppState()
        const exactMatchResult = bashToolCheckExactMatchPermission(
          input,
          appState.toolPermissionContext,
        )
        if (exactMatchResult.behavior === 'allow') {
          return exactMatchResult
        }
        // Attach pending classifier check - may auto-approve before user responds
        const decisionReason: PermissionDecisionReason = {
          type: 'other' as const,
          reason: originalCommandSafetyResult.message,
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(
            BashTool.name,
            decisionReason,
          ),
          decisionReason,
          suggestions: [], // Don't suggest saving a potentially dangerous command
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // Split into subcommands. Prefer the AST-extracted spans; fall back to
  // splitCommand only when tree-sitter was unavailable. The cd-cwd filter
  // strips the `cd ${cwd}` prefix that models like to prepend.
  const cwd = getCwd()
  const cwdMingw =
    getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd
  const rawSubcommands =
    astSubcommands ?? shadowLegacySubs ?? splitCommand(input.command)
  const { subcommands, astCommandsByIdx } = filterCdCwdSubcommands(
    rawSubcommands,
    astCommands,
    cwd,
    cwdMingw,
  )

  // CC-643: Cap subcommand fanout. Only the legacy splitCommand path can
  // explode — the AST path returns a bounded list (astSubcommands !== null)
  // or short-circuits to 'too-complex' for structures it can't represent.
  if (
    astSubcommands === null &&
    subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK
  ) {
    logForDebugging(
      `bashPermissions: ${subcommands.length} subcommands exceeds cap (${MAX_SUBCOMMANDS_FOR_SECURITY_CHECK}) — returning ask`,
      { level: 'debug' },
    )
    const decisionReason = {
      type: 'other' as const,
      reason: `Command splits into ${subcommands.length} subcommands, too many to safety-check individually`,
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
    }
  }

  // Ask if there are multiple `cd` commands
  const cdCommands = subcommands.filter(subCommand =>
    isNormalizedCdCommand(subCommand),
  )
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason:
        'Multiple directory changes in one command require approval for clarity',
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // Track if compound command contains cd for security validation
  // This prevents bypassing path checks via: cd .claude/ && mv test.txt settings.json
  const compoundCommandHasCd = cdCommands.length > 0

  // SECURITY: Block compound commands that have both cd AND git
  // 中文补充：这一层检查必须放在「逐子命令判定」**之前**。
  //   因为逐子命令判定时，单独看 `git status` 是安全的（它不知道整条命令里还有个 cd），
  //   于是 cd+git 的组合就被漏掉了
  // This prevents sandbox escape via: cd /malicious/dir && git status
  // where the malicious directory contains a bare git repo with core.fsmonitor.
  // This check must happen HERE (before subcommand-level permission checks)
  // because bashToolCheckPermission checks each subcommand independently via
  // BashTool.isReadOnly(), which would re-derive compoundCommandHasCd=false
  // from just "git status" alone, bypassing the readOnlyValidation.ts check.
  if (compoundCommandHasCd) {
    const hasGitCommand = subcommands.some(cmd =>
      isNormalizedGitCommand(cmd.trim()),
    )
    if (hasGitCommand) {
      const decisionReason = {
        type: 'other' as const,
        reason:
          'Compound commands with cd and git require approval to prevent bare repository attacks',
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  appState = context.getAppState() // re-compute the latest in case the user hit shift+tab

  // SECURITY FIX: Check Bash deny/ask rules BEFORE path constraints
  // This ensures that explicit deny rules like Bash(ls:*) take precedence over
  // path constraint checks that return 'ask' for paths outside the project.
  // Without this ordering, absolute paths outside the project (e.g., ls /home)
  // would bypass deny rules because checkPathConstraints would return 'ask' first.
  //
  // Note: bashToolCheckPermission calls checkPathConstraints internally, which handles
  // output redirection validation on each subcommand. However, since splitCommand strips
  // redirections before we get here, we MUST validate output redirections on the ORIGINAL
  // command AFTER checking deny rules but BEFORE returning results.
  // 逐子命令判定。注意 map 里是**同步**调用（bashToolCheckPermission 不是 async），
  //   所以这里不需要 await；结果顺序与 subcommands 一一对应
  const subcommandPermissionDecisions = subcommands.map((command, i) =>
    bashToolCheckPermission(
      { command },
      appState.toolPermissionContext,
      compoundCommandHasCd,
      astCommandsByIdx[i],
    ),
  )

  // Deny if any subcommands are denied
  const deniedSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'deny',
  )
  if (deniedSubresult !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // Validate output redirections on the ORIGINAL command (before splitCommand stripped them)
  // This must happen AFTER checking deny rules but BEFORE returning results.
  // Output redirections like "> /etc/passwd" are stripped by splitCommand, so the per-subcommand
  // checkPathConstraints calls won't see them. We validate them here on the original input.
  // SECURITY: When AST data is available, pass AST-derived redirects so
  // checkPathConstraints uses them directly instead of re-parsing with
  // shell-quote (which has a known single-quote backslash misparsing bug
  // that can silently hide redirect operators).
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    appState.toolPermissionContext,
    compoundCommandHasCd,
    astRedirects,
    astCommands,
  )
  if (pathResult.behavior === 'deny') {
    return pathResult
  }

  const askSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'ask',
  )
  const nonAllowCount = count(
    subcommandPermissionDecisions,
    _ => _.behavior !== 'allow',
  )

  // SECURITY (GH#28784): Only short-circuit on a path-constraint 'ask' when no
  // 中文补充（一个 UI 与安全的耦合问题）：路径校验给的 ask 只带「读某目录」的建议，
  //   若直接返回，用户看到的是「允许读取 <dir>」，一点就把整条（含 python3 执行）放行了。
  //   所以只有当没有子命令自己提出 ask 时才短路返回，否则走下面的汇总流程，
  //   把所有需要批准的子命令对应的 Bash 规则都收集起来一起展示
  // subcommand independently produced an 'ask'. checkPathConstraints re-runs the
  // path-command loop on the full input, so `cd <outside-project> && python3 foo.py`
  // produces an ask with ONLY a Read(<dir>/**) suggestion — the UI renders it as
  // "Yes, allow reading from <dir>/" and picking that option silently approves
  // python3. When a subcommand has its own ask (e.g. the cd subcommand's own
  // path-constraint ask), fall through: either the askSubresult short-circuit
  // below fires (single non-allow subcommand) or the merge flow collects Bash
  // rule suggestions for every non-allow subcommand. The per-subcommand
  // checkPathConstraints call inside bashToolCheckPermission already captures
  // the Read rule for the cd target in that path.
  //
  // When no subcommand asked (all allow, or all passthrough like `printf > file`),
  // pathResult IS the only ask — return it so redirection checks surface.
  if (pathResult.behavior === 'ask' && askSubresult === undefined) {
    return pathResult
  }

  // Ask if any subcommands require approval (e.g., ls/cd outside boundaries).
  // Only short-circuit when exactly ONE subcommand needs approval — if multiple
  // do (e.g. cd-outside-project ask + python3 passthrough), fall through to the
  // merge flow so the prompt surfaces Bash rule suggestions for all of them
  // instead of only the first ask's Read rule (GH#28784).
  if (askSubresult !== undefined && nonAllowCount === 1) {
    return {
      ...askSubresult,
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  // Allow if exact command was allowed
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // If all subcommands are allowed via exact or prefix match, allow the
  // command — but only if no command injection is possible. When the AST
  // parse succeeded, each subcommand is already known-safe (no hidden
  // substitutions, no structural tricks); the per-subcommand re-check is
  // redundant. When on the legacy path, re-run bashCommandIsSafeAsync per sub.
  let hasPossibleCommandInjection = false
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    // CC-643: Batch divergence telemetry into a single logEvent. The per-sub
    // logEvent was the hot-path syscall driver (each call → /proc/self/stat
    // via process.memoryUsage()). Aggregate count preserves the signal.
    let divergenceCount = 0
    const onDivergence = () => {
      divergenceCount++
    }
    const results = await Promise.all(
      subcommands.map(c => bashCommandIsSafeAsync(c, onDivergence)),
    )
    hasPossibleCommandInjection = results.some(
      r => r.behavior !== 'passthrough',
    )
    if (divergenceCount > 0) {
      logEvent('tengu_tree_sitter_security_divergence', {
        quoteContextDivergence: true,
        count: divergenceCount,
      })
    }
  }
  if (
    subcommandPermissionDecisions.every(_ => _.behavior === 'allow') &&
    !hasPossibleCommandInjection
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // Query Haiku for command prefixes
  // Skip the Haiku call — the UI computes the prefix locally and
  // lets the user edit it. Still call when a custom fn is injected (tests).
  let commandSubcommandPrefix: Awaited<
    ReturnType<typeof getCommandSubcommandPrefixFn>
  > = null
  if (getCommandSubcommandPrefixFn !== getCommandSubcommandPrefix) {
    commandSubcommandPrefix = await getCommandSubcommandPrefixFn(
      input.command,
      context.abortController.signal,
      context.options.isNonInteractiveSession,
    )
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }
  }

  // If there is only one command, no need to process subcommands
  appState = context.getAppState() // re-compute the latest in case the user hit shift+tab
  if (subcommands.length === 1) {
    const result = await checkCommandAndSuggestRules(
      { command: subcommands[0]! },
      appState.toolPermissionContext,
      commandSubcommandPrefix,
      compoundCommandHasCd,
      astSubcommands !== null,
    )
    // If command wasn't allowed, attach pending classifier check.
    // At this point, 'ask' can only come from bashCommandIsSafe (security check inside
    // checkCommandAndSuggestRules), NOT from explicit ask rules - those were already
    // filtered out at step 13 (askSubresult check). The classifier can bypass security.
    if (result.behavior === 'ask' || result.behavior === 'passthrough') {
      return {
        ...result,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }
    return result
  }

  // Check subcommand permission results
  const subcommandResults: Map<string, PermissionResult> = new Map()
  for (const subcommand of subcommands) {
    subcommandResults.set(
      subcommand,
      await checkCommandAndSuggestRules(
        {
          // Pass through input params like `sandbox`
          ...input,
          command: subcommand,
        },
        appState.toolPermissionContext,
        commandSubcommandPrefix?.subcommandPrefixes.get(subcommand),
        compoundCommandHasCd,
        astSubcommands !== null,
      ),
    )
  }

  // Allow if all subcommands are allowed
  // Note that this is different than 6b because we are checking the command injection results.
  if (
    subcommands.every(subcommand => {
      const permissionResult = subcommandResults.get(subcommand)
      return permissionResult?.behavior === 'allow'
    })
  ) {
    // Keep subcommandResults as PermissionResult for decisionReason
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: subcommandResults,
      },
    }
  }

  // Otherwise, ask for permission
  const collectedRules: Map<string, PermissionRuleValue> = new Map()

  for (const [subcommand, permissionResult] of subcommandResults) {
    if (
      permissionResult.behavior === 'ask' ||
      permissionResult.behavior === 'passthrough'
    ) {
      const updates =
        'suggestions' in permissionResult
          ? permissionResult.suggestions
          : undefined

      const rules = extractRules(updates)
      for (const rule of rules) {
        // Use string representation as key for deduplication
        const ruleKey = permissionRuleValueToString(rule)
        collectedRules.set(ruleKey, rule)
      }

      // GH#28784 follow-up: security-check asks (compound-cd+write, process
      // substitution, etc.) carry no suggestions. In a compound command like
      // `cd ~/out && rm -rf x`, that means only cd's Read rule gets collected
      // and the UI labels the prompt "Yes, allow reading from <dir>/" — never
      // mentioning rm. Synthesize a Bash(exact) rule so the UI shows the
      // chained command. Skip explicit ask rules (decisionReason.type 'rule')
      // where the user deliberately wants to review each time.
      if (
        permissionResult.behavior === 'ask' &&
        rules.length === 0 &&
        permissionResult.decisionReason?.type !== 'rule'
      ) {
        for (const rule of extractRules(
          suggestionForExactCommand(subcommand),
        )) {
          const ruleKey = permissionRuleValueToString(rule)
          collectedRules.set(ruleKey, rule)
        }
      }
      // Note: We only collect rules, not other update types like mode changes
      // This is appropriate for bash subcommands which primarily need rule suggestions
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: subcommandResults,
  }

  // GH#11380: Cap at MAX_SUGGESTED_RULES_FOR_COMPOUND. Map preserves insertion
  // order (subcommand order), so slicing keeps the leftmost N.
  const cappedRules = Array.from(collectedRules.values()).slice(
    0,
    MAX_SUGGESTED_RULES_FOR_COMPOUND,
  )
  const suggestedUpdates: PermissionUpdate[] | undefined =
    cappedRules.length > 0
      ? [
          {
            type: 'addRules',
            rules: cappedRules,
            behavior: 'allow',
            destination: 'localSettings',
          },
        ]
      : undefined

  // Attach pending classifier check - may auto-approve before user responds.
  // Behavior is 'ask' if any subcommand was 'ask' (e.g., path constraint or ask
  // rule) — before the GH#28784 fix, ask subresults always short-circuited above
  // so this path only saw 'passthrough' subcommands and hardcoded that.
  return {
    behavior: askSubresult !== undefined ? 'ask' : 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestedUpdates,
    ...(feature('BASH_CLASSIFIER')
      ? {
          pendingClassifierCheck: buildPendingClassifierCheck(
            input.command,
            appState.toolPermissionContext,
          ),
        }
      : {}),
  }
}

/**
 * Checks if a subcommand is a git command after normalizing away safe wrappers
 * (env vars, timeout, etc.) and shell quotes.
 *
 * SECURITY: Must normalize before matching to prevent bypasses like:
 *   'git' status    — shell quotes hide the command from a naive regex
 *   NO_COLOR=1 git status — env var prefix hides the command
 */
/**
 * 【做什么】判断一条子命令是不是 git 命令（先归一化再判断）
 * 【为什么需要】cd+git 这类组合攻击的判定依赖它；而 `'git' status`、
 *   `NO_COLOR=1 git status` 这些写法会让朴素的 /^git / 正则失效
 * 【返回】true = 是 git 命令
 * 【关键步骤】
 *   ① 快路径：最常见形态直接前缀判断，省掉解析开销
 *   ② 剥掉安全包装与环境变量后再分词判断
 *   ③ `xargs git ...` 也算：xargs 会在当前目录执行 git，风险与普通 git 完全相同
 */
export function isNormalizedGitCommand(command: string): boolean {
  // Fast path: catch the most common case before any parsing
  if (command.startsWith('git ') || command === 'git') {
    return true
  }
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    // Direct git command
    if (parsed.tokens[0] === 'git') {
      return true
    }
    // "xargs git ..." — xargs runs git in the current directory,
    // so it must be treated as a git command for cd+git security checks.
    // This matches the xargs prefix handling in filterRulesByContentsMatchingInput.
    if (parsed.tokens[0] === 'xargs' && parsed.tokens.includes('git')) {
      return true
    }
    return false
  }
  return /^git(?:\s|$)/.test(stripped)
}

/**
 * Checks if a subcommand is a cd command after normalizing away safe wrappers
 * (env vars, timeout, etc.) and shell quotes.
 *
 * SECURITY: Must normalize before matching to prevent bypasses like:
 *   FORCE_COLOR=1 cd sub — env var prefix hides the cd from a naive /^cd / regex
 *   This mirrors isNormalizedGitCommand to ensure symmetric normalization.
 *
 * Also matches pushd/popd — they change cwd just like cd, so
 *   pushd /tmp/bare-repo && git status
 * must trigger the same cd+git guard. Mirrors PowerShell's
 * DIRECTORY_CHANGE_ALIASES (src/utils/powershell/parser.ts).
 */
/**
 * 【做什么】判断一条子命令是不是 cd（含 pushd / popd）
 * 【为什么需要】pushd/popd 同样会改变工作目录，
 *   `pushd /tmp/bare-repo && git status` 与 cd 版本的风险完全一致，必须一起拦
 */
export function isNormalizedCdCommand(command: string): boolean {
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    const cmd = parsed.tokens[0]
    return cmd === 'cd' || cmd === 'pushd' || cmd === 'popd'
  }
  return /^(?:cd|pushd|popd)(?:\s|$)/.test(stripped)
}

/**
 * Checks if a compound command contains any cd command,
 * using normalized detection that handles env var prefixes and shell quotes.
 */
// 整条命令里有没有任何 cd —— 供路径校验判断「是否处于 cd 之后的写操作」场景
export function commandHasAnyCd(command: string): boolean {
  return splitCommand(command).some(subcmd =>
    isNormalizedCdCommand(subcmd.trim()),
  )
}
