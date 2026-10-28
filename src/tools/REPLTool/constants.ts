/**
 * ============================================================================
 *  【文件总览】src/tools/REPLTool/constants.ts
 *              —— REPL 模式的「开关判定 + 受限工具名单」
 * ============================================================================
 *
 *  一句话定位：
 *  本文件回答两个问题：
 *      (1) 现在要不要开启 REPL 模式？        → isReplModeEnabled()
 *      (2) 开了之后，哪些工具要从模型眼前藏起来？ → REPL_ONLY_TOOLS
 *  它是整个 REPL 特性的**配置中枢**，本身没有任何副作用。
 *
 *  什么是 REPL 模式？
 *      普通模式下，模型每做一件事就要单独发起一次工具调用：
 *          Read(a.txt) → 等结果 → Read(b.txt) → 等结果 → Grep("foo") → 等结果 …
 *      每一轮都要把上下文重发给模型，慢且费 token。
 *      REPL 模式下，模型改为在一个**持久化的 JS 沙箱**里写一段代码：
 *          for (const f of files) print(read(f))
 *      一次调用批量完成所有操作。
 *      为此要把 Read/Write/Edit/Bash 等单个工具藏起来，逼模型走 REPL 这条路。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】调用链
 * ---------------------------------------------------------------------------
 *
 *      src/tools.ts: getAllTools()
 *        └─> isReplModeEnabled()        ← ★ 本文件（决定要不要进 REPL 模式）
 *              └─> REPL_ONLY_TOOLS      ← ★ 本文件（进了之后要藏哪些工具）
 *                    └─> 过滤后的工具表发给模型
 *
 *      配套文件：
 *      ./primitiveTools.ts  —— 那份「藏着但仍然存在」的工具清单（给内部与渲染端用）
 *      ../AgentTool/constants.js、../BashTool/toolName.js …
 *                           —— 本文件引用的各个工具名常量，全都来自工具自己的目录，
 *                              避免把 "Bash" 这种字符串在多处硬编码。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   1. REPL_TOOL_NAME   —— 常量 'REPL'，REPL 工具自己的名字
 *   2. isReplModeEnabled() —— 唯一的开关判定函数（下面详细讲它的三个条件）
 *   3. REPL_ONLY_TOOLS  —— 一个 Set，装着 REPL 模式下对模型隐藏的 8 个工具名
 *
 * ---------------------------------------------------------------------------
 *  【★ isReplModeEnabled() 三个条件的优先级，以及为什么这么绕】
 * ---------------------------------------------------------------------------
 *      if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_REPL)) return false   ← ① 显式关
 *      if (isEnvTruthy(process.env.CLAUDE_REPL_MODE))       return true    ← ② 老开关兼容
 *      return USER_TYPE === 'ant' && CLAUDE_CODE_ENTRYPOINT === 'cli'      ← ③ 默认策略
 *
 *   ① 「显式关」优先级最高：环境变量被显式设成假值（0/false/no）就立刻关掉。
 *      为什么不用简单的 truthy 判断？因为 `CLAUDE_CODE_REPL=` 这种存在但为空的情况
 *      语义模糊，专门抽一个 isEnvDefinedFalsy 来统一处理。
 *      ≈ Java 里 Boolean.parseBoolean 之外还要区分「没设」和「设了 false」两种状态。
 *
 *   ② CLAUDE_REPL_MODE 是**历史遗留开关**，为了不破坏已有的脚本和用户习惯保留兼容。
 *      新开关优先、老开关兜底，是这类迁移的标准做法。
 *
 *   ③ 默认只给「内部用户（ant）+ 交互式命令行（cli）」开启。
 *      为什么要把 SDK 排除在外？上面那段英文注释讲得很清楚，这里用中文复述：
 *      SDK 的使用者（sdk-ts / sdk-py / sdk-cli）是在自己写的脚本里**直接调** Bash、Read
 *      这些工具的；一旦开 REPL 模式把它们藏起来，那些既有脚本会全部失效。
 *      而 USER_TYPE 是构建时就 --define 进去的编译期常量——如果不检查 ENTRYPOINT，
 *      ant 原生二进制**派生出来的每一个 SDK 子进程**都会被强制打开 REPL 模式，
 *      与调用方实际传的环境变量无关。这就是最后还要 && 上 entrypoint 判断的原因。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（本文件实际出现的写法，Java 工程师对照看）
 * ---------------------------------------------------------------------------
 *  - `export const REPL_TOOL_NAME = 'REPL'`
 *      ≈ Java 的 public static final String。惯例是把工具名放常量而不是到处写字面量，
 *        这样改名/IDE 跳转都能一次性搞定。
 *
 *  - `export function isReplModeEnabled(): boolean { ... }`
 *      注意返回类型标在函数**后面**（Java 的 `boolean foo()` 写在前面，正好相反）。
 *
 *  - `process.env.CLAUDE_CODE_REPL`
 *      Node 的全局对象 process.env，即环境变量表。
 *      ≈ Java 的 System.getenv("CLAUDE_CODE_REPL")，但这里是当普通对象属性访问。
 *      类型是 `string | undefined`（没设这个变量时就是 undefined）。
 *
 *  - `process.env.USER_TYPE === 'ant'`
 *      看着像运行时读环境变量，其实 USER_TYPE 是**构建期 --define 替换**的常量：
 *      打包时会被替换成 "ant" 或 "external" 这样的字面量，
 *      再被 tree-shaking 把走不到的分支删掉。≈ C 的 #ifdef，Java 里没有对应物。
 *
 *  - `new Set([...])`
 *      集合。≈ Java 的 HashSet。用 Set 而不是数组是为了 has() 是 O(1)——
 *      过滤工具表时每条工具都要查一次，数组线性查找会让复杂度平方级上升。
 *
 *  - `export const REPL_ONLY_TOOLS = new Set([ ... ])`
 *      注意导入的每一项（FILE_READ_TOOL_NAME 等）本身是 string，
 *      所以这里会被推断成 `Set<string>`。
 *      如果想让类型更精确，可以写 `new Set<SomeToolNameUnion>([...])`。
 *
 *  - `readonly` 在 primitiveTools.ts 里出现过，本文件没有；
 *      Set 天然就没有字面量修改语法，语义上已经是「只读集合」了。
 *
 * ============================================================================
 */
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'

// REPL 工具自己的名字。模型写工具调用时用的就是 'REPL' 这个字符串。
export const REPL_TOOL_NAME = 'REPL'

/**
 * REPL mode is default-on for ants in the interactive CLI (opt out with
 * CLAUDE_CODE_REPL=0). The legacy CLAUDE_REPL_MODE=1 also forces it on.
 *
 * SDK entrypoints (sdk-ts, sdk-py, sdk-cli) are NOT defaulted on — SDK
 * consumers script direct tool calls (Bash, Read, etc.) and REPL mode
 * hides those tools. USER_TYPE is a build-time --define, so the ant-native
 * binary would otherwise force REPL mode on every SDK subprocess regardless
 * of the env the caller passes.
 *
 * 【上面那段英文注释的中文重述】（原文保留，这里只是给英文不便的读者补一份）
 *
 *   做什么：判断当前进程要不要启用 REPL 模式。
 *
 *   为什么需要：REPL 模式会改变「模型能看见哪些工具」这件大事，
 *              所以这个开关必须集中在一处判定，不能散落在各个调用点。
 *
 *   三个判定条件的含义（详见文件头【isReplModeEnabled 三个条件】一节）：
 *     ① CLAUDE_CODE_REPL 被显式设为假值 → 直接 false（最高优先级，用户说了算）
 *     ② CLAUDE_REPL_MODE 为真值         → 直接 true（老开关，向后兼容）
 *     ③ 二者都没设的话，默认只对「内部 ant 用户 + 交互式 cli 入口」开放
 *        —— 刻意把 SDK 排除掉，因为 SDK 脚本依赖直接调用 Bash/Read，藏起来就废了。
 *
 *   入参：无（直接读 process.env）
 *   返回值：boolean —— true 表示开启 REPL 模式
 *   关键步骤：三条 if / return 依次短路，先到先得。
 */
export function isReplModeEnabled(): boolean {
  // ① 显式设为假：直接关掉，后面的条件不再判断（优先级最高）
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_REPL)) return false
  // ② 老环境变量兼容：只要 CLAUDE_REPL_MODE 为真就强制开启
  if (isEnvTruthy(process.env.CLAUDE_REPL_MODE)) return true
  // ③ 兜底默认策略：只对「内部用户 + 交互式 CLI」默认开启，SDK 一律不开
  return (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_ENTRYPOINT === 'cli'
  )
}

/**
 * Tools that are only accessible via REPL when REPL mode is enabled.
 * When REPL mode is on, these tools are hidden from Claude's direct use,
 * forcing Claude to use REPL for batch operations.
 */
 * 【上面那段英文注释的中文重述】
 *
 *   这是什么：REPL 模式下「只能通过 REPL 访问」的工具名黑名单，共 8 个。
 *
 *   为什么需要：光把 REPL 加进来没用——模型出于肌肉记忆还是会去调单个工具。
 *     必须把它们从可用工具表里摘掉，模型才会走 REPL 这条批量路径。
 *     这就是所谓的「强迫式默认」（forcing function）。
 *
 *   用法：过滤工具表时 `if (!REPL_ONLY_TOOLS.has(tool.name)) 保留`。
 *     has() 是 O(1)，因为底层是哈希集合。
 *
 *   注意：这里存的是**名字字符串**，不是工具对象。
 *     存名字可以避免在模块初始化阶段就去 import 那些工具实现——
 *     那样会引入与工具模块的循环依赖（对比 primitiveTools.ts 需要用惰性 getter 才能拿到对象）。
 */
export const REPL_ONLY_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  AGENT_TOOL_NAME,
])
