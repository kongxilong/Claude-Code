/**
 * 【一句话定位】按当前**权限模式（permission mode）**决定命令能否自动放行：
 * 主要场景是 acceptEdits（接受编辑）模式下，把"改文件系统"的 PowerShell cmdlet
 * 直接自动批准，不再弹框打扰用户。
 *
 * 【在架构中的位置】
 *   powershellPermissions.ts（权限判定的主流程）
 *        ──调用──> checkPermissionMode(input, parsed, toolPermissionContext)  ←── 本文件
 *   PowerShellTool.tsx ──> powershellPermissions.ts ──> 本文件
 *   本文件 ──> powershell/parser.js（AST 派生的安全标记、pipeline 分段、破折号字符表）
 *             ──> readOnlyValidation.js（resolveToCanonical / isSafeOutputCommand /
 *                 isAllowlistedPipelineTail / isCwdChangingCmdlet / argLeaksValue）
 *             ──> pathValidation.ts（真正做路径约束检查的是 CMDLET_PATH_CONFIG，
 *                 本文件只负责"按模式决定要不要走那条路"）
 *
 *   对照 BashTool：src/tools/BashTool/modeValidation.ts 是**同构移植**，
 *   连函数名 checkPermissionMode、返回值 PermissionResult 都一致。
 *   差异只在：Unix 版允许的是 sed/awk/rm 这类命令，这里允许的是
 *   Set-Content/Add-Content/Remove-Item/Clear-Content 这些 cmdlet。
 *   原文注释里 "Follows the same patterns as BashTool/modeValidation.ts" 说的就是这个。
 *
 * 【什么叫"按模式放行"】
 *   Claude Code 有几种权限模式：default / acceptEdits / plan / bypassPermissions / dontAsk。
 *   acceptEdits 的含义是"用户已经表态：你可以直接改我的文件"，
 *   所以本文件把**写类 cmdlet** 从 ask 降级为 allow，让编辑类操作不再逐条弹框。
 *   但注意：降级不等于"不校验" —— 路径约束仍由 pathValidation.ts 执行，
 *   本文件只做"这个 cmdlet 属不属于可放行的那一类"的粗筛。
 *
 * 【贯穿全文件的设计原则：拿不准就 passthrough】
 *   返回值有三种语义：
 *     allow       = 本模式直接批准
 *     passthrough = 本模块不表态，交回主权限流程按常规规则处理（即可能弹框）
 *     （deny 不在这里产生）
 *   凡是遇到无法静态判定的东西（变量、子表达式、脚本块、链接、cd 等），
 *   一律 passthrough 而不是放行 —— 这就是 fail-safe：
 *   宁可让用户多点一次确认，也不能把未知命令放过去。
 *
 * 【本文件包含什么】
 *   ACCEPT_EDITS_ALLOWED_CMDLETS   ：acceptEdits 模式下可自动放行的写类 cmdlet 集合。
 *   isAcceptEditsAllowedCmdlet()    ：单个 cmdlet 名（含别名解析）是否在放行集合里。
 *   LINK_ITEM_TYPES                ：New-Item 里会创建"链接"的 -ItemType 取值。
 *   isItemTypeParamAbbrev()         ：判断参数是不是 -ItemType / -Type 的缩写。
 *   isSymlinkCreatingCommand()      ：这条命令是不是在创建符号链接/联接/硬链接。
 *   checkPermissionMode()           ：对外主入口，返回 PermissionResult。
 *
 * 【TS 语法速查】
 *   import type { X } from '...'
 *     ≈ 只导入类型，编译后被完全擦除（不会进入运行时依赖图）。
 *   PermissionResult 这种"多形态返回值"
 *     ≈ Java 的 sealed interface / 带 tag 的 union：behavior 字段决定后面
 *       有哪些字段可用（编译器会根据 behavior 自动收窄 —— 这叫可辨识联合
 *       discriminated union，是 TS 模拟 Java sealed interface 的标准手法）。
 *   new Set([...]) / Set.has()
 *     ≈ Java HashSet<String>；has() 是 O(1) 查找，本项目到处用它做白名单表。
 *   cmd.args[i] ?? ''
 *     ?? 空值合并：只在 null/undefined 时取默认值（与 || 的区别：0 和 '' 不会被替换）。
 *   raw[0]!
 *     ! 非空断言 ≈ Java 强制转型：骗编译器"我保证非空"，运行时不检查。
 *   for (let i = 0; i < n; i++)
 *     与 Java 的 for 完全一样；本项目也大量用 for...of（≈ 增强 for）。
 */
/**
 * PowerShell permission mode validation.
 *
 * Checks if commands should be auto-allowed based on the current permission mode.
 * In acceptEdits mode, filesystem-modifying PowerShell cmdlets are auto-allowed.
 * Follows the same patterns as BashTool/modeValidation.ts.
 */

// 三个 import type：只拿类型不拿实现，编译后这些 import 会被完全删掉，
// 因此不会引入运行时循环依赖 —— TS 项目里这是很常用的解耦手段。
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { ParsedPowerShellCommand } from '../../utils/powershell/parser.js'
// 从 parser.js 拿的三样东西：
//   deriveSecurityFlags → 从 AST 上算出「有没有子表达式/脚本块/ splatting」等危险特征
//   getPipelineSegments  → 把 AST 切成一段段 pipeline，每段里再拆出命令
//   PS_TOKENIZER_DASH_CHARS → PowerShell 里各种「长得像减号」的字符集合（含 Unicode 破折号）
import {
  deriveSecurityFlags,
  getPipelineSegments,
  PS_TOKENIZER_DASH_CHARS,
} from '../../utils/powershell/parser.js'
// 从 readOnlyValidation.js 复用五个判定工具：别名解析、安全输出命令、
// 会改 cwd 的 cmdlet、管道尾部白名单、参数是否会「漏值」。
// 复用而不是重写，是为了保证 acceptEdits 模式和只读模式的口径完全一致。
import {
  argLeaksValue,
  isAllowlistedPipelineTail,
  isCwdChangingCmdlet,
  isSafeOutputCommand,
  resolveToCanonical,
} from './readOnlyValidation.js'

/**
 * 【中文】acceptEdits 模式下允许自动放行的**写类 cmdlet**（存小写规范名）。
 *
 * 为什么只放这四个（对应上方英文注释）：
 *   曾经把 New-Item / Copy-Item / Move-Item 等（所谓 Tier 3）也放进来，
 *   但它们的**参数绑定方式复杂**（多个位置参数、参数集互斥），
 *   静态校验很容易把 -Value 和 -Path 认错，风险大于收益。
 *   于是只保留「第一个位置参数必然是 -Path」的简单写类 cmdlet，
 *   它们能稳稳地走 pathValidation.ts 的 CMDLET_PATH_CONFIG 路径校验。
 *   其余一律落回 ask（弹框）。
 */
/**
 * Filesystem-modifying cmdlets that are auto-allowed in acceptEdits mode.
 * Stored as canonical (lowercase) cmdlet names.
 *
 * Tier 3 cmdlets with complex parameter binding removed — they fall through to
 * 'ask'. Only simple write cmdlets (first positional = -Path) are auto-allowed
 * here, and they get path validation via CMDLET_PATH_CONFIG in pathValidation.ts.
 */
// 存**规范名（小写）**而不是原始名：PowerShell 的 cmdlet 名大小写不敏感，
// 而且有大量别名（rm/del/ri 都指向 Remove-Item），统一成规范名才能一网打尽。
const ACCEPT_EDITS_ALLOWED_CMDLETS = new Set([
  'set-content',
  'add-content',
  'remove-item',
  'clear-content',
])

/**
 * 【中文】判断某个 cmdlet 名（可能写成别名）是否属于 acceptEdits 放行集合。
 *
 * @param name 命令里的原始命令名（可能是 rm、del、ri 这类别名）
 * @returns true = 可自动放行；false = 交回主流程按常规处理（通常弹框）
 *
 * 关键点：先经 resolveToCanonical 把别名解析成规范名再查表。
 *   于是 rm / del / ri → remove-item → 命中；
 *   而 mkdir / ni / cp / mv → new-item / copy-item … → 不在集合里 → 落回 ask。
 * 好处：新增一个别名不需要改这张表，改 COMMON_ALIASES 一处即可。
 */
function isAcceptEditsAllowedCmdlet(name: string): boolean {
  // resolveToCanonical handles aliases via COMMON_ALIASES, so e.g. 'rm' → 'remove-item',
  // 'ac' → 'add-content'. Any alias that resolves to an allowed cmdlet is automatically
  // allowed. Tier 3 cmdlets (new-item, copy-item, move-item, etc.) and their aliases
  // (mkdir, ni, cp, mv, etc.) resolve to cmdlets NOT in the set and fall through to 'ask'.
// 别名解析是这里的**安全前提**：攻击者用别名绕过白名单是最常见的手法，
// 所以必须在查表前先把名字还原成唯一的规范形式。
  const canonical = resolveToCanonical(name)
  return ACCEPT_EDITS_ALLOWED_CMDLETS.has(canonical)
}

/**
 * 【中文】New-Item 的 -ItemType 里会创建**文件系统链接**的三个取值。
 *
 * 为什么这三类危险（对应上方英文注释）：
 *   SymbolicLink / Junction 是目录或文件的**重解析点**，HardLink 是文件 inode 的别名 ——
 *   三者都会在**运行时**把路径解析重定向到别处。
 *   后果：校验器当时看到的 ./link 和实际运行时跟随到的目标不是同一个地方，
 *   于是「后面一句相对路径的写入」就落到校验视野之外了（典型的 TOCTOU）。
 */
/**
 * New-Item -ItemType values that create filesystem links (reparse points or
 * hard links). All three redirect path resolution at runtime — symbolic links
 * and junctions are directory/file reparse points; hard links alias a file's
 * inode. Any of these let a later relative-path write land outside the
 * validator's view.
 */
// 只有这三个值会「重定向路径解析」；-ItemType File/Directory 是正常创建，不拦。
const LINK_ITEM_TYPES = new Set(['symboliclink', 'junction', 'hardlink'])

/**
 * 【中文】判断这个参数是不是 New-Item 的 -ItemType / -Type 的**缩写**。
 *
 * PowerShell 允许参数缩写到「无歧义的最短前缀」，所以 -it / -ite / -itemtype
 * 都合法。这里必须覆盖所有缩写，否则攻击者写 -it 就能绕过检测。
 *
 * 为什么最短要 3 个字符（含 -）：
 *   -t 会跟 -Target 撞车（歧义），所以 -Type 只能缩到 -ty；
 *   -i 系列也可能跟别的参数混淆。取 3 是为了避开有歧义的短前缀。
 *
 * @param p 已小写、已归一化破折号、已剥掉冒号值的参数文本
 * @returns true = 这是 -ItemType / -Type 的某种写法
 */
/**
 * Check if a lowered, dash-normalized arg (colon-value stripped) is an
 * unambiguous PowerShell abbreviation of New-Item's -ItemType or -Type param.
 * Min prefixes: `-it` (avoids ambiguity with other New-Item params), `-ty`
 * (avoids `-t` colliding with `-Target`).
 */
function isItemTypeParamAbbrev(p: string): boolean {
// 写法巧思：`'-itemtype'.startsWith(p)` —— 反过来用完整名去「以 p 开头」判断，
// 比枚举所有缩写简洁得多。前提是要限制 p 的最短长度，否则 '-' 会匹配一切。
  return (
    (p.length >= 3 && '-itemtype'.startsWith(p)) ||
    (p.length >= 3 && '-type'.startsWith(p))
  )
}

/**
 * 【中文】检测这条命令是不是在创建文件系统链接（New-Item -ItemType SymbolicLink 等）。
 *
 * 为什么单独一个函数：链接一旦建出来，**后面所有相对路径的校验都失真了** ——
 *   例：New-Item -ItemType SymbolicLink -Path ./link -Value /etc; Get-Content ./link/passwd
 *   校验时 ./link/passwd 还是个不存在的相对路径（看起来在 cwd 内，放行），
 *   运行时却被链接带到 /etc/passwd（越权读取）。
 *   这与 Set-Location 造成的 cwd 失同步是同一类问题（都是「校验与使用不一致」）。
 *
 * @param cmd 单个命令（name + args），来自 AST 分段结果
 * @returns true = 在创建链接，调用方应拒绝自动放行
 *
 * 步骤：① 先把命令名规范化，不是 new-item 直接返回 false
 *      ② 逐个参数：归一化破折号 → 小写 → 拆冒号绑定值 → 去掉反引号转义
 *      ③ 判断是不是 -ItemType 的参数缩写
 *      ④ 取值（冒号绑定取冒号后，空格分隔取下一个参数），去转义去引号后查表
 *
 * 兼容性处理（对应英文注释里的 bug 编号）：
 *   bug #26 各种 Unicode 破折号与 / 前缀；bug #22 反引号转义（`-Item`Type`）；
 *   bug #6 值外面套单/双引号。
 */
/**
 * Detects New-Item creating a filesystem link (-ItemType SymbolicLink /
 * Junction / HardLink, or the -Type alias). Links poison subsequent path
 * resolution the same way Set-Location/New-PSDrive do: a relative path
 * through the link resolves to the link target, not the validator's view.
 * Finding #18.
 *
 * Handles PS parameter abbreviation (`-it`, `-ite`, ... `-itemtype`; `-ty`,
 * `-typ`, `-type`), unicode dash prefixes (en-dash/em-dash/horizontal-bar),
 * and colon-bound values (`-it:Junction`).
 */
// 形参类型是**对象字面量**：{ name: string; args: string[] }。
// TS 里这种匿名结构类型非常常见（≈ Java 需要为此专门定义一个 record）。
export function isSymlinkCreatingCommand(cmd: {
  name: string
  args: string[]
}): boolean {
  const canonical = resolveToCanonical(cmd.name)
// 只关心 New-Item：其它 cmdlet 不会创建链接，早退省掉后面的逐个参数扫描。
  if (canonical !== 'new-item') return false
  for (let i = 0; i < cmd.args.length; i++) {
// `?? ''`：args[i] 理论上不会越界，但 TS 默认开启 noUncheckedIndexedAccess 时
// 索引访问的类型是 string | undefined，所以要用 ?? 给个兜底。
    const raw = cmd.args[i] ?? ''
    if (raw.length === 0) continue
    // Normalize unicode dash prefixes (–, —, ―) and forward-slash (PS 5.1
    // parameter prefix) → ASCII `-` so prefix comparison works. PS tokenizer
    // treats all four dash chars plus `/` as parameter markers. (bug #26)
    const normalized =
// raw[0]! 的 ! 是**非空断言** ≈ Java 的强制转型：告诉编译器「我保证非空」，
// 运行时不做检查。上面判过 raw.length === 0 就 continue，所以这里是安全的。
      PS_TOKENIZER_DASH_CHARS.has(raw[0]!) || raw[0] === '/'
        ? '-' + raw.slice(1)
        : raw
    const lower = normalized.toLowerCase()
// PowerShell 的冒号绑定写法：-it:SymbolicLink 等价于 -it SymbolicLink。
// 不拆开的话，paramRaw 会是整个 '-it:symboliclink'，就匹配不上 -itemtype 了。
    // Split colon-bound value: -it:SymbolicLink → param='-it', val='symboliclink'
    const colonIdx = lower.indexOf(':', 1)
    const paramRaw = colonIdx > 0 ? lower.slice(0, colonIdx) : lower
    // Strip backtick escapes: -Item`Type → -ItemType (bug #22)
// 反引号 ` 是 PowerShell 的转义符（**不是**反斜杠！）。
// `-Item`Type` 在 PS 里就是 -ItemType，不去掉会漏判。
    const param = paramRaw.replace(/`/g, '')
    if (!isItemTypeParamAbbrev(param)) continue
    const rawVal =
      colonIdx > 0
        ? lower.slice(colonIdx + 1)
// 取值的两种来源：冒号绑定取本参数冒号后面；空格分隔则取**下一个**参数。
// `cmd.args[i + 1]?.toLowerCase() ?? ''`：
//   ?. 可选链 —— args[i+1] 不存在时整条短路成 undefined，不会抛异常；
//   ?? 再兜底成空串。这是 TS 里「安全地取隔壁元素」的标准写法。
        : (cmd.args[i + 1]?.toLowerCase() ?? '')
    // Strip backtick escapes from colon-bound value: -it:Sym`bolicLink → symboliclink
    // Mirrors the param-name strip at L103. Space-separated args use .value
    // (backtick-resolved by .NET parser), but colon-bound uses .text (raw source).
    // Strip surrounding quotes: -it:'SymbolicLink' or -it:"Junction" (bug #6)
// 冒号绑定的值来自源码原始文本（.text），空格分隔的值由 .NET 解析器处理过（.value），
// 所以**只有冒号绑定**需要额外去掉反引号 —— 这个不对称是有原因的，别删。
    const val = rawVal.replace(/`/g, '').replace(/^['"]|['"]$/g, '')
    if (LINK_ITEM_TYPES.has(val)) return true
  }
  return false
}

/**
 * 【中文】对外主入口：结合当前权限模式，决定这条命令能否自动放行。
 *
 * @param input 工具入参（含原始 command 文本，某些判定需要看原文）
 * @param parsed PowerShell AST 解析结果（.valid 表示是否解析成功）
 * @param toolPermissionContext 含当前 mode（acceptEdits / bypassPermissions / dontAsk ...）
 * @returns PermissionResult：
 *          behavior='allow'       → 本模块批准，命令直接执行
 *          behavior='passthrough' → 本模块不表态，交回主流程（多数情况会弹框）
 *
 * 整体思路（一条长长的「不予放行」清单，全过才 allow）：
 *   ① bypass / dontAsk 另有处理，直接 passthrough（避免重复决策）
 *   ② 不是 acceptEdits 模式 → passthrough
 *   ③ AST 解析失败 → passthrough（看不懂就不能放行）
 *   ④ 含子表达式/脚本块/成员调用/splatting/赋值/--%/可展开字符串 → passthrough
 *   ⑤ 复合命令里含 cd 类 + 写操作 → passthrough（cwd 失同步）
 *   ⑥ 复合命令里含创建链接 → passthrough（路径解析被劫持）
 *   ⑦ 逐命令检查：非 CommandAst、路径式命令名、参数类型不可判定 → passthrough
 *   ⑧ 命令不在放行集合 → passthrough
 *   ⑨ 参数会「漏值」（含哈希表/变量等无法静态解析的东西）→ passthrough
 *   全部通过 → allow，并带上 decisionReason 说明是 acceptEdits 模式放行的
 */
/**
 * Checks if commands should be handled differently based on the current permission mode.
 *
 * In acceptEdits mode, auto-allows filesystem-modifying PowerShell cmdlets.
 * Uses the AST to resolve aliases before checking the allowlist.
 *
 * @param input - The PowerShell command input
 * @param parsed - The parsed AST of the command
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'allow' if the current mode permits auto-approval
 * - 'passthrough' if no mode-specific handling applies
 */
export function checkPermissionMode(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
// 这两种模式在主权限流程里已经有专门分支处理，这里必须**早退**，
// 否则会出现「两个模块都觉得自己该负责」的重复放行/重复拒绝。
  // Skip bypass and dontAsk modes (handled elsewhere)
  if (
    toolPermissionContext.mode === 'bypassPermissions' ||
    toolPermissionContext.mode === 'dontAsk'
  ) {
    return {
      behavior: 'passthrough',
      message: 'Mode is handled in main permission flow',
    }
  }

// 只有 acceptEdits 需要本模块的特殊处理，其它模式一律交回主流程。
  if (toolPermissionContext.mode !== 'acceptEdits') {
    return {
      behavior: 'passthrough',
      message: 'No mode-specific validation required',
    }
  }

  // acceptEdits mode: check if all commands are filesystem-modifying cmdlets
// AST 解析失败说明命令里有我们看不懂的语法 —— 看不懂就绝不放行。
// 这是全文件反复出现的判定原则：fail-safe（失效即拒绝）。
  if (!parsed.valid) {
    return {
      behavior: 'passthrough',
      message: 'Cannot validate mode for unparsed command',
    }
  }

// ===== 危险语法特征检查 =====
// deriveSecurityFlags 从 AST 上提取一组布尔标记。只要命中任一标记，
// 说明命令里藏了「静态看不出结果」的构造（子表达式 $() 、脚本块 {} 、
// 成员调用 .Invoke()、splatting @args、赋值、--% 停止解析、可展开字符串）。
// 这些都能把任意代码伪装成一个「看起来只是路径」的参数，所以必须拒绝自动放行。
  // SECURITY: Check for subexpressions, script blocks, or member invocations
  // that could be used to smuggle arbitrary code through acceptEdits mode.
  const securityFlags = deriveSecurityFlags(parsed)
  if (
    securityFlags.hasSubExpressions ||
    securityFlags.hasScriptBlocks ||
    securityFlags.hasMemberInvocations ||
    securityFlags.hasSplatting ||
    securityFlags.hasAssignments ||
    securityFlags.hasStopParsing ||
    securityFlags.hasExpandableStrings
  ) {
    return {
      behavior: 'passthrough',
      message:
        'Command contains subexpressions, script blocks, or member invocations that require approval',
    }
  }

// 把 AST 切成 pipeline 段：后续所有检查都以「段 → 命令 → 参数」三层结构展开。
  const segments = getPipelineSegments(parsed)

  // SECURITY: Empty segments with valid parse = no commands to check, don't auto-allow
// 解析成功却没有任何命令 = 空语句（比如只有注释或只有分号）。
// 空命令不该被自动放行 —— 放行一个「空」是没意义且可能掩盖解析异常的。
  if (segments.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'No commands found to validate for acceptEdits mode',
    }
  }

// ===== 复合命令的 cwd 失同步防护（与 BashTool 完全同构）=====
// 中文复述上面这段英文注释：
//   复合命令里若某句改了当前目录（Set-Location / Push-Location / Pop-Location
//   或其别名 cd/sl/chdir/pushd/popd），那么**后面语句里的相对路径**
//   相对的是新的 cwd，而路径校验用的是**陈旧的**进程 cwd。
//   例：Set-Location ./.claude; Set-Content ./settings.json '...'
//     校验器以为写的是 /project/settings.json
//     PowerShell 实际写的是 /project/.claude/settings.json
//   于是「校验通过」完全失去了意义。对策：这种组合一律不放行。
//   （BashTool 里对应的是 compoundCommandHasCd，逻辑一模一样。）
  // SECURITY: Compound cwd desync guard — BashTool parity.
  // When any statement in a compound contains Set-Location/Push-Location/Pop-Location
  // (or aliases like cd, sl, chdir, pushd, popd), the cwd changes between statements.
  // Path validation resolves relative paths against the stale process cwd, so a write
  // cmdlet in a later statement targets a different directory than the validator checked.
  // Example: `Set-Location ./.claude; Set-Content ./settings.json '...'` — the validator
  // sees ./settings.json as /project/settings.json, but PowerShell writes to
  // /project/.claude/settings.json. Refuse to auto-allow any write operation in a
  // compound that contains a cwd-changing command. This matches BashTool's
  // compoundCommandHasCd guard (BashTool/pathValidation.ts:630-655).
// reduce 求和：统计整条复合命令里一共有多少条命令。
// ≈ Java: segments.stream().mapToInt(s -> s.commands.size()).sum()
// 只有 > 1（即确实是复合命令）才需要做下面的失同步检查。
  const totalCommands = segments.reduce(
    (sum, seg) => sum + seg.commands.length,
    0,
  )
  if (totalCommands > 1) {
    let hasCdCommand = false
    let hasSymlinkCreate = false
    let hasWriteCommand = false
// 双层循环：外层遍历所有 pipeline 段，内层遍历段内命令。
// for...of ≈ Java 的增强 for；这里只累积三个布尔标记，不做提前退出。
    for (const seg of segments) {
      for (const cmd of seg.commands) {
// elementType !== 'CommandAst' 的元素（表达式、控制流等）不参与本轮统计，
// 它们在下面第 244 行起的主循环里会被单独拦下。
        if (cmd.elementType !== 'CommandAst') continue
        if (isCwdChangingCmdlet(cmd.name)) hasCdCommand = true
        if (isSymlinkCreatingCommand(cmd)) hasSymlinkCreate = true
        if (isAcceptEditsAllowedCmdlet(cmd.name)) hasWriteCommand = true
      }
    }
// 「改目录 + 写操作」同时出现才拒绝：
// 单独改目录（不写文件）无害，单独写文件（没改目录）cwd 没变也没问题。
    if (hasCdCommand && hasWriteCommand) {
      return {
        behavior: 'passthrough',
        message:
          'Compound command contains a directory-changing command (Set-Location/Push-Location/Pop-Location) with a write operation — cannot auto-allow because path validation uses stale cwd',
      }
    }
// ===== 链接创建防护（finding #18）=====
// 中文复述：与上面的 cd 防护同形，但**不要求**同时存在写操作 ——
// 因为通过刚创建的链接**读取**同样危险（Get-Content ./link/etc/shadow 就是越权读），
// 而且任何在链接之后使用路径的命令都无法再被校验。
// 三种链接类型（SymbolicLink / Junction / HardLink）都会劫持运行时路径解析，都要拦。
    // SECURITY: Link-create compound guard (finding #18). Mirrors the cd
    // guard above. `New-Item -ItemType SymbolicLink -Path ./link -Value /etc;
    // Get-Content ./link/passwd` — path validation resolves ./link/passwd
    // against cwd (no link there at validation time), but runtime follows
    // the just-created link to /etc/passwd. Same TOCTOU shape as cwd desync.
    // Applies to SymbolicLink, Junction, and HardLink — all three redirect
    // path resolution at runtime.
    // No `hasWriteCommand` requirement: read-through-symlink is equally
    // dangerous (exfil via Get-Content ./link/etc/shadow), and any other
    // command using paths after a just-created link is unvalidatable.
    if (hasSymlinkCreate) {
      return {
        behavior: 'passthrough',
        message:
          'Compound command creates a filesystem link (New-Item -ItemType SymbolicLink/Junction/HardLink) — cannot auto-allow because path validation cannot follow just-created links',
      }
    }
  }

// ===== 逐命令细查（真正的主循环）=====
  for (const segment of segments) {
    for (const cmd of segment.commands) {
// ===== 非 CommandAst 一律拒绝（上方英文注释强调这是「承重墙」，别改窄）=====
// 三种情况都靠这一条兜住：
//  ① 表达式管道源：'/etc/passwd' | Remove-Item —— 字符串是 CommandExpressionAst，
//     管道把它绑到 -Path 上，我们静态上无法知道它代表哪个路径。
//  ② 控制流语句：foreach ($x in ...) { Remove-Item $x } —— $x 是循环变量，无法校验。
//  ③ 非 PipelineAst 的重定向（cmd > /tmp 之类，以及 && 连接的语句）也会落到这里。
// 这里的共同点是：**无法静态确定它到底作用于哪个路径** → 拒绝。
      if (cmd.elementType !== 'CommandAst') {
        // SECURITY: This guard is load-bearing for THREE cases. Do not narrow it.
        //
        // 1. Expression pipeline sources (designed): '/etc/passwd' | Remove-Item
        //    — the string literal is CommandExpressionAst, piped value binds to
        //    -Path. We cannot statically know what path it represents.
        //
        // 2. Control-flow statements (accidental but relied upon):
        //    foreach ($x in ...) { Remove-Item $x }. Non-PipelineAst statements
        //    produce a synthetic CommandExpressionAst entry in segment.commands
        //    (parser.ts transformStatement). Without this guard, Remove-Item $x
        //    in nestedCommands would be checked below and auto-allowed — but $x
        //    is a loop-bound variable we cannot validate.
        //
        // 3. Non-PipelineAst redirection coverage (accidental): cmd && cmd2 > /tmp
        //    also produces a synthetic element here. isReadOnlyCommand relies on
        //    the same accident (its allowlist rejects the synthetic element's
        //    full-text name), so both paths fail safe together.
        return {
          behavior: 'passthrough',
          message: `Pipeline contains expression source (${cmd.elementType}) that cannot be statically validated`,
        }
      }
// nameType='application' 表示命令名里带路径字符（. \ /），
// 例如 scripts\Remove-Item：剥掉前缀后看起来是 Remove-Item（会命中放行集合），
// 但 PowerShell 实际执行的是 scripts\Remove-Item.ps1 这个**脚本**。
// 名字被「伪造」成内置 cmdlet 是最经典的绕过手法，必须拦。
      // SECURITY: nameType is computed from the raw name before stripModulePrefix.
      // 'application' = raw name had path chars (. \\ /). scripts\\Remove-Item
      // strips to Remove-Item and would match ACCEPT_EDITS_ALLOWED_CMDLETS below,
      // but PowerShell runs scripts\\Remove-Item.ps1. Same gate as isAllowlistedCommand.
      if (cmd.nameType === 'application') {
        return {
          behavior: 'passthrough',
          message: `Command '${cmd.name}' resolved from a path-like name and requires approval`,
        }
      }
// ===== 参数元素类型白名单（acceptEdits 侧的等价闸门）=====
// 中文复述上面那段很长的英文注释：
//  只接受 StringConstant（字面量）和 Parameter（参数名）两类元素。
//  典型绕过：Remove-Item $env:PATH —— 元素类型是 Variable，
//  deriveSecurityFlags 不会报警（没有子表达式），checkPathConstraints 会把
//  字面文本 '$env:PATH' 当成一个相对路径（判定在 cwd 内 → 放行），
//  但运行时 PowerShell 会把 $env:PATH **展开**成真实环境变量值去删除。
//  这就是「字面文本 ≠ 运行时值」的经典陷阱，必须用类型白名单挡住。
      // SECURITY: elementTypes whitelist — same as isAllowlistedCommand.
      // deriveSecurityFlags above checks hasSubExpressions/etc. but does NOT
      // flag bare Variable/Other elementTypes. `Remove-Item $env:PATH`:
      //   elementTypes = ['StringConstant', 'Variable']
      //   deriveSecurityFlags: no subexpression → passes
      //   checkPathConstraints: resolves literal text '$env:PATH' as relative
      //     path → cwd/$env:PATH → inside cwd → allow
      //   RUNTIME: PowerShell expands $env:PATH → deletes actual env value path
      // isAllowlistedCommand rejects non-StringConstant/Parameter; this is the
      // acceptEdits parity gate.
      //
      // Also check colon-bound expression metachars (same as isAllowlistedCommand's
      // colon-bound check). `Remove-Item -Path:(1 > /tmp/x)`:
      //   elementTypes = ['StringConstant', 'Parameter'] — passes whitelist above
      //   deriveSecurityFlags: ParenExpressionAst in .Argument not detected by
      //     Get-SecurityPatterns (ParenExpressionAst not in FindAll filter)
      //   checkPathConstraints: literal text '-Path:(1 > /tmp/x)' not a path
      //   RUNTIME: paren evaluates, redirection writes /tmp/x → arbitrary write
      if (cmd.elementTypes) {
// 从下标 1 开始：elementTypes[0] 是命令名本身，不需要检查。
        for (let i = 1; i < cmd.elementTypes.length; i++) {
          const t = cmd.elementTypes[i]
          if (t !== 'StringConstant' && t !== 'Parameter') {
            return {
              behavior: 'passthrough',
              message: `Command argument has unvalidatable type (${t}) — variable paths cannot be statically resolved`,
            }
          }
// 参数是「冒号绑定值」时还要再查一次：值里若含 $( @ { [ 等表达式元字符，
// 说明这个值是**要被求值的**（如 -Path:(1 > /tmp/x) 会真的写文件），
// 静态判定不出结果，必须拒绝。
          if (t === 'Parameter') {
// elementTypes[i] 对应 args[i-1]：因为 elementTypes[0] 占了个命令名位。
// 这种「下标错位」是本项目里最容易写错的地方，改动时务必连着一起改。
            // elementTypes[i] ↔ args[i-1] (elementTypes[0] is the command name).
            const arg = cmd.args[i - 1] ?? ''
            const colonIdx = arg.indexOf(':')
            if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
              return {
                behavior: 'passthrough',
                message:
                  'Colon-bound parameter contains an expression that cannot be statically validated',
              }
            }
          }
        }
      }
// 安全输出类命令（Out-Null 等）与「管道尾部变换器」（Format-* / Measure-Object /
// Select-Object 等）不改变前面命令的语义，直接跳过，
// 否则 `Remove-Item ./foo | Out-Null` 会因为尾巴上的 Out-Null 不被放行而误伤。
// 注意：这些「管道尾部」命令本身无害的前提是它们的参数不漏值，
// 所以走的是 isAllowlistedPipelineTail + argLeaksValue 双重确认。
      // Safe output cmdlets (Out-Null, etc.) and allowlisted pipeline-tail
      // transformers (Format-*, Measure-Object, Select-Object, etc.) don't
      // affect the semantics of the preceding command. Skip them so
      // `Remove-Item ./foo | Out-Null` or `Set-Content ./foo hi | Format-Table`
      // auto-allows the same as the bare write cmdlet. isAllowlistedPipelineTail
      // is the narrow fallback for cmdlets moved from SAFE_OUTPUT_CMDLETS to
      // CMDLET_ALLOWLIST (argLeaksValue validates their args).
      if (
        isSafeOutputCommand(cmd.name) ||
        isAllowlistedPipelineTail(cmd, input.command)
      ) {
        continue
      }
// 不在放行集合里（比如 New-Item / Copy-Item 这类 Tier 3）→ 交回主流程弹框。
// 这是「只放行最有把握的四个 cmdlet」这一决策的落点。
      if (!isAcceptEditsAllowedCmdlet(cmd.name)) {
        return {
          behavior: 'passthrough',
          message: `No mode-specific handling for '${cmd.name}' in acceptEdits mode`,
        }
      }
// ===== argLeaksValue：参数里是否藏着无法静态解析的东西 =====
// 'Other' 类型涵盖 HashtableAst、ConvertExpressionAst、BinaryExpressionAst ——
// 它们都可能内嵌重定向或表达式。最典型的例子：
//   @{k='payload' > ~/.bashrc} 作为 -Value 参数时会通过表层检查，
//   但运行时那个 > 是真的把内容写进了 ~/.bashrc。
// 与只读模式（isAllowlistedCommand）用的是同一个函数，保证口径一致。
      // SECURITY: Reject commands with unclassifiable argument types. 'Other'
      // covers HashtableAst, ConvertExpressionAst, BinaryExpressionAst — all
      // can contain nested redirections or code that the parser cannot fully
      // decompose. isAllowlistedCommand (readOnlyValidation.ts) already
      // enforces this whitelist via argLeaksValue; this closes the same gap
      // in acceptEdits mode. Without this, @{k='payload' > ~/.bashrc} as a
      // -Value argument passes because HashtableAst maps to 'Other'.
      // argLeaksValue also catches colon-bound variables (-Flag:$env:SECRET).
      if (argLeaksValue(cmd.name, cmd)) {
        return {
          behavior: 'passthrough',
          message: `Arguments in '${cmd.name}' cannot be statically validated in acceptEdits mode`,
        }
      }
    }

// 控制流语句（if / foreach / while 的花括号体）里的命令由解析器收集到
// nestedCommands，这里再按**同样**的标准过一遍 —— 不能只查顶层。
    // Also check nested commands from control flow statements
    if (segment.nestedCommands) {
      for (const cmd of segment.nestedCommands) {
// 与控制流体外的判断同构：非 CommandAst 的元素无法静态判定路径来源。
        if (cmd.elementType !== 'CommandAst') {
          // SECURITY: Same as above — non-CommandAst element in nested commands
          // (control flow bodies) cannot be statically validated as a path source.
          return {
            behavior: 'passthrough',
            message: `Nested expression element (${cmd.elementType}) cannot be statically validated`,
          }
        }
// 同上：路径式命令名（scripts\xxx）在嵌套位置同样要拦。
        if (cmd.nameType === 'application') {
          return {
            behavior: 'passthrough',
            message: `Nested command '${cmd.name}' resolved from a path-like name and requires approval`,
          }
        }
        if (
          isSafeOutputCommand(cmd.name) ||
          isAllowlistedPipelineTail(cmd, input.command)
        ) {
          continue
        }
        if (!isAcceptEditsAllowedCmdlet(cmd.name)) {
          return {
            behavior: 'passthrough',
            message: `No mode-specific handling for '${cmd.name}' in acceptEdits mode`,
          }
        }
        // SECURITY: Same argLeaksValue check as the main command loop above.
        if (argLeaksValue(cmd.name, cmd)) {
          return {
            behavior: 'passthrough',
            message: `Arguments in nested '${cmd.name}' cannot be statically validated in acceptEdits mode`,
          }
        }
      }
    }
  }

  // All commands are filesystem-modifying cmdlets -- auto-allow
// 所有检查都通过 → 放行。注意返回的 updatedInput 是**原样回传** input：
// 本模块不改写命令内容，只是「批准」。
// decisionReason 记录放行原因（mode=acceptEdits），用于审计/UI 展示。
  return {
    behavior: 'allow',
    updatedInput: input,
// decisionReason.type='mode' 表示「这是按模式放行的」，与按规则放行区分开，
// 便于事后回溯「这条命令为什么没弹框」。
    decisionReason: {
      type: 'mode',
      mode: 'acceptEdits',
    },
  }
}
