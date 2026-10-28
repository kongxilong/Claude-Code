/**
 * 【一句话定位】拼装 PowerShell 工具发给大模型的**系统提示词（system prompt）**：
 * 告诉模型「这个工具能干嘛、PowerShell 语法要注意什么、超时多少、别用哪些命令」。
 *
 * 【在架构中的位置】
 *   PowerShellTool.tsx（构造 Tool 对象时）
 *        ──调用──> getPrompt()  ←── 本文件对外主入口
 *   本文件 ──> toolName.js（工具名，已成环的断环点）
 *             ──> powershellDetection.js（探测本机是 Windows PowerShell 5.1 还是 pwsh 7+）
 *             ──> timeouts.js / outputLimits.js（超时与输出长度上限）
 *             ──> 其它工具的 prompt.js（FileRead/FileWrite/FileEdit/Glob/Grep 的工具名，
 *                 用来在提示词里写「别用 PowerShell 干这个，用 XX 工具」）
 *
 *   对照 BashTool：src/tools/BashTool/prompt.ts 是 Unix 版，结构几乎一致
 *   （同样的 Usage notes / git 注意事项 / 后台任务说明），
 *   差异集中在 PowerShell 语法段：转义字符是反引号而不是反斜杠、
 *   变量带 $ 前缀、管道传的是对象不是文本、here-string 的 '@ 必须顶格写。
 *
 * 【为什么提示词要按 PowerShell 版本分叉】（见 getEditionSection）
 *   模型的训练数据同时见过 Windows PowerShell 5.1 和 PowerShell 7+ 两种语法，
 *   但它不知道当前机器上装的是哪个。如果不告诉它：
 *     - 在 5.1 上生成 && / ?? / ?. → 直接 parser error，命令根本跑不起来
 *     - 在 7+ 上又过度保守地回避这些语法 → 啰嗦且易错
 *   所以启动时探测一次版本，把对应语法规则写进提示词。
 *
 * 【本文件包含什么】
 *   getDefaultTimeoutMs() / getMaxTimeoutMs()：超时默认值与上限（复用 bash 的通用配置）。
 *   getBackgroundUsageNote()：是否告知模型可以用 run_in_background 后台执行。
 *   getSleepGuidance()      ：劝阻模型用 Start-Sleep 轮询（后台任务会主动通知）。
 *   getEditionSection()    ：按 PowerShell 版本给出语法注意事项。
 *   getPrompt()            ：把上面几块拼成一个大字符串返回。
 *
 * 【TS 语法速查】
 *   `...` 反引号字符串 = **模板字符串（template literal）**
 *     ≈ Java 15+ 的文本块（三个双引号）**加上** 字符串插值：${expr} 会把表达式算出来嵌进去。
 *     Java 的文本块不能插值，只能 String.format / concat —— 这是本文件最需要适应的点。
 *     行尾写一个反斜杠 \ 表示"这一行的换行不算数"（行续行符），
 *     本文件用它来把 ${x ? y : ''} 这种条件拼接塞进模板而不产生空行。
 *   async function getPrompt(): Promise<string>
 *     ≈ Java 的 CompletableFuture<String>；await ≈ .join()/get()，但不会阻塞线程。
 *     本文件必须 async，因为探测 PowerShell 版本要真的去跑一次进程。
 *   string | null 返回类型
 *     联合类型 ≈ 值可能是字符串也可能是 null，编译器强制调用方先判空，
 *     这正是本文件写 `backgroundNote ? backgroundNote + '\n' : ''` 的原因。
 *   isEnvTruthy(process.env.X)
 *     process.env ≈ Java 的 System.getenv() 返回的 Map；TS 里它的值类型是
 *     string | undefined（可能没这个环境变量），所以要经 isEnvTruthy 兜底。
 */
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getMaxOutputLength } from '../../utils/shell/outputLimits.js'
import {
  getPowerShellEdition,
  type PowerShellEdition,
} from '../../utils/shell/powershellDetection.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { POWERSHELL_TOOL_NAME } from './toolName.js'

/**
 * 【中文】默认超时（毫秒）。命令不显式指定 timeout 时用它。
 *
 * 为什么复用 bash 的通用配置（getDefaultBashTimeoutMs）：
 * 超时是」等子进程多久「的通用策略，跟具体 shell 无关，
 * 让 PowerShell 与 Bash 保持一致的体验，避免用户困惑。
 * @returns 默认超时毫秒数
 */
export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

/**
 * 【中文】超时上限（毫秒）。模型可以指定 timeout，但不能超过这个值。
 *
 * 为什么要有上限：一个挂死的命令会一直占着终端和后台任务槽位，
 * 上限保证最坏情况下用户也能在可预期的时间内拿回控制权。
 * @returns 允许的最大超时毫秒数
 */
export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

/**
 * 【中文】生成「可以用 run_in_background 后台执行」这段提示。
 *
 * @returns 提示文案；若用户通过环境变量 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
 *          关闭了后台任务，则返回 null（提示词里就不会出现这一条，
 *          否则模型会去用一个不存在的参数）
 *
 * 设计要点：提示词必须跟**当前可用能力**保持一致 —— 能力关了，提示也要跟着消失。
 */
function getBackgroundUsageNote(): string | null {
// process.env.X 的类型是 string | undefined（环境变量可能没设）。
// isEnvTruthy 把 '1'/'true'/'yes' 之类统一成布尔，undefined 当 false。
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return `  - You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes.`
}

/**
 * 【中文】生成「别用 Start-Sleep 轮询」这段提示。
 *
 * 为什么要专门劝阻：模型很容易写出 `Start-Sleep 30; 检查结果` 这种代码，
 * 白白阻塞用户几十秒。而后台任务完成时系统会主动通知，
 * 所以正确姿势是 run_in_background + 等通知，而不是 sleep 轮询。
 *
 * @returns 提示文案；后台任务被关闭时返回 null（此时确实只能 sleep，就不劝了）
 */
function getSleepGuidance(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return `  - Avoid unnecessary \`Start-Sleep\` commands:
    - Do not sleep between commands that can run immediately — just run them.
    - If your command is long running and you would like to be notified when it finishes — simply run your command using \`run_in_background\`. There is no need to sleep in this case.
    - Do not retry failing commands in a sleep loop — diagnose the root cause or consider an alternative approach.
    - If waiting for a background task you started with \`run_in_background\`, you will be notified when it completes — do not poll.
    - If you must poll an external process, use a check command rather than sleeping first.
    - If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.`
}

/**
 * 【中文】按探测到的 PowerShell 版本生成」语法注意事项「段落。
 *
 * @param edition 'desktop' = Windows PowerShell 5.1（powershell.exe）；
 *                'core' = PowerShell 7+（pwsh）；
 *                null = 还没探测出来（首次构建提示词时）或机器上没装 PowerShell
 * @returns 一整段多行提示文本
 *
 * 三条分支的取舍：
 *   ① 5.1：明确列出 && || ?: ?? ?. **不可用**（写进去就是语法错误）
 *   ② 7+ ：告诉模型这些**可以用**、并且优先用 && 而不是 ; 串联
 *   ③ 未知：按最保守的 5.1 兼容子集来要求 —— 宁可少用语法特性，
 *            也不能让命令解析失败。这是 fail-safe 的典型写法。
 *
 * 另外 5.1 分支里特意提醒了两件事：
 *   - 别写 2>&1：5.1 会把原生命令的 stderr 包装成 ErrorRecord，
 *     即使 exe 返回 0 也会把 $? 置为 false（假失败）。stderr 本来就已被捕获。
 *   - 默认编码是 UTF-16 LE with BOM：写文件给别的工具读时要显式 -Encoding utf8。
 */
/**
 * Version-specific syntax guidance. The model's training data covers both
 * editions but it can't tell which one it's targeting, so it either emits
 * pwsh-7 syntax on 5.1 (parser error → exit 1) or needlessly avoids && on 7.
 */
// `PowerShellEdition | null`：联合类型，值只可能是这三种字面量之一。
// ≈ Java 的 enum 加 @Nullable，但 TS 用字符串字面量联合更轻（不需要定义 enum）。
function getEditionSection(edition: PowerShellEdition | null): string {
  if (edition === 'desktop') {
// ===== 分支一：Windows PowerShell 5.1（老而广泛，语法最受限）=====
    return `PowerShell edition: Windows PowerShell 5.1 (powershell.exe)
   - Pipeline chain operators \`&&\` and \`||\` are NOT available — they cause a parser error. To run B only if A succeeds: \`A; if ($?) { B }\`. To chain unconditionally: \`A; B\`.
   - Ternary (\`?:\`), null-coalescing (\`??\`), and null-conditional (\`?.\`) operators are NOT available. Use \`if/else\` and explicit \`$null -eq\` checks instead.
   - Avoid \`2>&1\` on native executables. In 5.1, redirecting a native command's stderr inside PowerShell wraps each line in an ErrorRecord (NativeCommandError) and sets \`$?\` to \`$false\` even when the exe returned exit code 0. stderr is already captured for you — don't redirect it.
   - Default file encoding is UTF-16 LE (with BOM). When writing files other tools will read, pass \`-Encoding utf8\` to \`Out-File\`/\`Set-Content\`.
   - \`ConvertFrom-Json\` returns a PSCustomObject, not a hashtable. \`-AsHashtable\` is not available.`
  }
// ===== 分支二：PowerShell 7+（pwsh，语法接近现代语言）=====
  if (edition === 'core') {
    return `PowerShell edition: PowerShell 7+ (pwsh)
   - Pipeline chain operators \`&&\` and \`||\` ARE available and work like bash. Prefer \`cmd1 && cmd2\` over \`cmd1; cmd2\` when cmd2 should only run if cmd1 succeeds.
   - Ternary (\`$cond ? $a : $b\`), null-coalescing (\`??\`), and null-conditional (\`?.\`) operators are available.
   - Default file encoding is UTF-8 without BOM.`
  }
// ===== 分支三：探测未完成 / 没装 PowerShell =====（对应上面英文注释）
// 取最保守子集：把 7+ 才有的语法全禁掉，这样无论实际是哪个版本都能跑通。
  // Detection not yet resolved (first prompt build before any tool call) or
  // PS not installed. Give the conservative 5.1-safe guidance.
  return `PowerShell edition: unknown — assume Windows PowerShell 5.1 for compatibility
   - Do NOT use \`&&\`, \`||\`, ternary \`?:\`, null-coalescing \`??\`, or null-conditional \`?.\`. These are PowerShell 7+ only and parser-error on 5.1.
   - To chain commands conditionally: \`A; if ($?) { B }\`. Unconditionally: \`A; B\`.`
}

/**
 * 【中文】本文件的对外主入口：拼出完整的 PowerShell 工具提示词。
 *
 * @returns 一个巨大的多行字符串，直接作为工具描述发给模型
 *
 * 为什么是 async：内部要 await getPowerShellEdition()，
 * 而版本探测需要真的启动一次 powershell 进程问它版本号（I/O，必须异步）。
 *
 * 步骤：① 并行无关地准备好后台任务提示 / sleep 提示 / 版本段落
 *      ② 用一个反引号模板字符串把固定文案与这些变量插值拼起来
 *      ③ 若干处用 `${x ? x + '\n' : ''}` 做」有内容才输出「的条件拼接
 *
 * 内容编排上的几个意图：
 *   - 开头就声明「工作目录持续、shell 状态不持续」，纠正模型对会话的误解；
 *   - 明确划清边界：文件读写/搜索一律用专用工具，别用 PowerShell；
 *   - 列出会**挂住**的交互命令（Read-Host / Get-Credential / pause 等），
 *     因为本工具是以 -NonInteractive 运行的，一交互就永远不返回。
 */
export async function getPrompt(): Promise<string> {
// 先并行取三个片段。注意这里没有 await 全部 —— 下面 return 前才真正需要它们。
  const backgroundNote = getBackgroundUsageNote()
  const sleepGuidance = getSleepGuidance()
  const edition = await getPowerShellEdition()

// 从这里开始就是一整个**模板字符串**（反引号），相当于一份多行文本模板，
// ${...} 里可以是任意表达式：变量、函数返回值、三元判断都行。
// 首段刻意声明两点：工作目录跨调用保持，但 shell 变量/函数不保持。
  return `Executes a given PowerShell command with optional timeout. Working directory persists between commands; shell state (variables, functions) does not.

IMPORTANT: This tool is for terminal operations via PowerShell: git, npm, docker, and PS cmdlets. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

// 把版本相关的语法段落插进来 —— 这是本提示词唯一」运行时动态「的大块内容。
${getEditionSection(edition)}

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`Get-ChildItem\` (or \`ls\`) to verify the parent directory exists and is the correct location

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes
   - Capture the output of the command.

PowerShell Syntax Notes:
   - Variables use $ prefix: $myVar = "value"
   - Escape character is backtick (\`), not backslash
   - Use Verb-Noun cmdlet naming: Get-ChildItem, Set-Location, New-Item, Remove-Item
   - Common aliases: ls (Get-ChildItem), cd (Set-Location), cat (Get-Content), rm (Remove-Item)
   - Pipe operator | works similarly to bash but passes objects, not text
   - Use Select-Object, Where-Object, ForEach-Object for filtering and transformation
   - String interpolation: "Hello $name" or "Hello $($obj.Property)"
   - Registry access uses PSDrive prefixes: \`HKLM:\\SOFTWARE\\...\`, \`HKCU:\\...\` — NOT raw \`HKEY_LOCAL_MACHINE\\...\`
   - Environment variables: read with \`$env:NAME\`, set with \`$env:NAME = "value"\` (NOT \`Set-Variable\` or bash \`export\`)
   - Call native exe with spaces in path via call operator: \`& "C:\\Program Files\\App\\app.exe" arg1 arg2\`

// 交互命令黑名单：本工具以 -NonInteractive 启动，Read-Host 之类会永久挂起，
// 直到超时。与其等超时，不如在提示词层面就禁掉。
Interactive and blocking commands (will hang — this tool runs with -NonInteractive):
   - NEVER use \`Read-Host\`, \`Get-Credential\`, \`Out-GridView\`, \`$Host.UI.PromptForChoice\`, or \`pause\`
   - Destructive cmdlets (\`Remove-Item\`, \`Stop-Process\`, \`Clear-Content\`, etc.) may prompt for confirmation. Add \`-Confirm:$false\` when you intend the action to proceed. Use \`-Force\` for read-only/hidden items.
   - Never use \`git rebase -i\`, \`git add -i\`, or other commands that open an interactive editor

// here-string 段：'@ 必须顶格（第 0 列）是 PowerShell 的硬性语法要求，
// 一旦缩进就是解析错误。这是模型最容易踩的 PowerShell 坑之一，所以专门给了示例。
Passing multiline strings (commit messages, file content) to native executables:
   - Use a single-quoted here-string so PowerShell does not expand \`$\` or backticks inside. The closing \`'@\` MUST be at column 0 (no leading whitespace) on its own line — indenting it is a parse error:
<example>
git commit -m @'
Commit message here.
Second line with $literal dollar signs.
'@
</example>
   - Use \`@'...'@\` (single-quoted, literal) not \`@"..."@\` (double-quoted, interpolated) unless you need variable expansion
// --% 是 PowerShell 的 stop-parsing 标记：后面的内容原样传给原生 exe，
// 不再被 PS 当作操作符解析（git log 的 %H 之类会被 PS 误解析，必须用它）。
   - For arguments containing \`-\`, \`@\`, or other characters PowerShell parses as operators, use the stop-parsing token: \`git log --% --format=%H\`

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} minutes). If not specified, commands will timeout after ${getDefaultTimeoutMs()}ms (${getDefaultTimeoutMs() / 60000} minutes).
  - It is very helpful if you write a clear, concise description of what this command does.
  - If the output exceeds ${getMaxOutputLength()} characters, output will be truncated before being returned to you.
// 行尾的反斜杠 \ 是模板字符串里的**行续行符**：表示「这里的换行不要输出」，
// 这样 `${backgroundNote ? ... : ''}` 在关闭后台任务时就不会留下一个空行。
// （Java 文本块里没有这个语法，只能靠拼接或 strip。）
${backgroundNote ? backgroundNote + '\n' : ''}\
  - Avoid using PowerShell to run commands that have dedicated tools, unless explicitly instructed:
    - File search: Use ${GLOB_TOOL_NAME} (NOT Get-ChildItem -Recurse)
    - Content search: Use ${GREP_TOOL_NAME} (NOT Select-String)
    - Read files: Use ${FILE_READ_TOOL_NAME} (NOT Get-Content)
    - Edit files: Use ${FILE_EDIT_TOOL_NAME}
    - Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT Set-Content/Out-File)
    - Communication: Output text directly (NOT Write-Output/Write-Host)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple ${POWERSHELL_TOOL_NAME} tool calls in a single message.
    - If the commands depend on each other and must run sequentially, chain them in a single ${POWERSHELL_TOOL_NAME} call (see edition-specific chaining syntax above).
    - Use \`;\` only when you need to run commands sequentially but don't care if earlier commands fail.
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings and here-strings)
// 明确禁止用 cd/Set-Location 切目录：工作目录已由框架设好，
// 模型自己 cd 反而会造成」工作目录漂移「，后续命令落错位置。
  - Do NOT prefix commands with \`cd\` or \`Set-Location\` -- the working directory is already set to the correct project directory automatically.
${sleepGuidance ? sleepGuidance + '\n' : ''}\
  - For git commands:
    - Prefer to create a new commit rather than amending an existing commit.
// git 安全段的意图（与 BashTool/prompt.ts 一致）：
// 提醒模型在执行破坏性 git 操作前先考虑更安全的替代方案，
// 并且**绝不要**用 --no-verify 之类绕过 hook —— 那是用户才有的决定权。
    - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
    - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.`
}
