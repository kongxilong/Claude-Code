/**
 * 【一句话定位】PowerShell 通用参数（Common Parameters）清单。这些参数由
 * [CmdletBinding()] 隐式挂到**所有** cmdlet 上，不属于任何一个具体 cmdlet。
 *
 * 【在架构中的位置】
 *   pathValidation.ts      ──import──> COMMON_PARAMETERS
 *   readOnlyValidation.ts  ──import──> COMMON_PARAMETERS
 *         └── 两者把这张表并进各自的"已知参数集合 / 安全 flag 集合"，
 *             否则每条命令里写个 -ErrorAction 都会被误判成未知参数 → 误报风险。
 *
 *   这个文件之所以独立存在（见原文注释）：pathValidation 和 readOnlyValidation
 *   互相 import，如果常量放其中任一个里面就成环了。抽出来当叶子文件断环。
 *
 *   对照 BashTool：bash 世界里没有"通用参数"这个概念，
 *   BashTool/commandSemantics.ts、bashPermissions.ts 是各自维护自己的常量表。
 *
 * 【本文件包含什么】
 *   COMMON_SWITCHES      ：开关型通用参数（不带值），如 -Verbose。
 *   COMMON_VALUE_PARAMS  ：需要带值的通用参数，如 -ErrorAction SilentlyContinue。
 *   COMMON_PARAMETERS    ：上面两个的并集，供查表用。
 *
 * 【为什么要分开关 / 带值两类】
 *   语义涉析时要知道这个参数会不会"吃掉"后面的 token：
 *     -ErrorAction Stop    → Stop 是这个参数的值，不是路径、不是命令
 *     -Verbose             → 后面紧跟的 token 就是下一个参数或路径
 *   分错了就会把 `-ErrorAction Stop` 里的 Stop 当成文件路径去做路径校验，
 *   导致误判（allow 变 ask）。
 *
 * 【TS 语法速查】
 *   new Set([...A, ...B])
 *     `...` 是**展开运算符**：把数组元素平铺出来。
 *     ≈ Java: Stream.concat(A.stream(), B.stream()).collect(toSet())
 *     Java 没有 ...数组 这种语法（Java 的 ... 是可变参数，位置在形参上，别混淆）。
 *   ReadonlySet<string> 类型标注
 *     ≈ Java 的 Set<String>，但只读是编译期约定，运行时可强转后修改。
 *   为什么用 Set 而不是 Array：Set.has() 是 O(1)（HashMap 语义），
 *     Array.includes() 是 O(n)；这批表会被每条命令查很多次。
 */
/**
 * PowerShell Common Parameters (available on all cmdlets via [CmdletBinding()]).
 * Source: about_CommonParameters (PowerShell docs) + Get-Command output.
 *
 * Shared between pathValidation.ts (merges into per-cmdlet known-param sets)
 * and readOnlyValidation.ts (merges into safeFlags check). Split out to break
 * what would otherwise be an import cycle between those two files.
 *
 * Stored lowercase with leading dash — callers `.toLowerCase()` their input.
 */

// 开关型：自身就是完整的布尔标记，不消耗后面的 token。
export const COMMON_SWITCHES = ['-verbose', '-debug']

// 带值型：后面必须跟一个值（如 SilentlyContinue）。解析 pipeline 时
// 必须把它们「吃掉」的那个 token 一并跳过，否则会把值误认成路径/命令。
export const COMMON_VALUE_PARAMS = [
  '-erroraction',
  '-warningaction',
  '-informationaction',
  '-progressaction',
  '-errorvariable',
  '-warningvariable',
  '-informationvariable',
  '-outvariable',
  '-outbuffer',
  '-pipelinevariable',
]

export const COMMON_PARAMETERS: ReadonlySet<string> = new Set([
// 并集 Set：上方两个数组的去重合并结果，查表统一走这里。
  ...COMMON_SWITCHES,
  ...COMMON_VALUE_PARAMS,
])
