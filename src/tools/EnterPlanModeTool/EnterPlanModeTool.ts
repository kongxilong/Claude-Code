/**
 * ============================================================================
 *  【文件总览】src/tools/EnterPlanModeTool/EnterPlanModeTool.ts
 * ============================================================================
 *
 *  一句话定位：
 *  「进入 plan mode（计划模式）」这个工具的**实现主体**。模型调用它，
 *  就等于向用户举手说："这个活儿不简单，我先只读调研、写个方案给你过目，
 *  批准了我再动手改代码。"
 *
 *  ---------------------------------------------------------------------------
 *  【先搞懂：plan mode 到底是什么？】（本目录的核心概念，务必先看这段）
 *  ---------------------------------------------------------------------------
 *  plan mode 是 Claude Code 的一种**只读（read-only）模式**。切进去之后：
 *
 *    · 模型可以：读文件、grep、glob、搜代码、用 AskUserQuestion 反问你
 *    · 模型不可以：写文件、改文件、执行会改动的 bash 命令
 *    · 唯一允许写的文件：计划文件（plan file，形如 ~/.claude/plans/*.md）
 *
 *  为什么要这么设计？因为 AI 一口气写 500 行代码，写歪了就是 500 行的返工。
 *  plan mode 把「想清楚」和「动手做」拆成两个阶段，中间插一道**人工审批闸门**：
 *  模型先调研、出方案，用户在弹窗里点同意（甚至可以直接编辑方案文本），
 *  然后才真正开始改文件。这跟 Java 里 「先出设计方案评审，再写代码」是一个道理，
 *  只不过这道闸门是产品级的强制约束，不是流程约定。
 *
 *  两个工具如何切换这个模式（本文件是「进」，隔壁目录是「出」）：
 *
 *      EnterPlanMode（本文件）                    ExitPlanMode（../ExitPlanModeTool）
 *      ─────────────────────────                ────────────────────────────────
 *      把权限模式的 mode 改成 'plan'              把 mode 改回进 plan 之前的那个模式
 *      （旧模式存进 prePlanMode 字段）            （从 prePlanMode 字段读回来）
 *      同时剥掉一部分危险权限                     同时把危险权限恢复回去
 *
 *  所以在代码层面，"我是否在 plan mode" 这个状态，
 *  **不存在本文件里**，而是存在全局 AppState 的
 *      toolPermissionContext.mode === 'plan'
 *  这个字段里。本文件只是那个「把 mode 改成 'plan' 的动作」。
 *  真正的权限拦截在别处（utils/permissions/ 那一坨），
 *  它看到 mode === 'plan' 就会拒绝所有写操作。
 *
 *  ---------------------------------------------------------------------------
 *  【在架构中的位置】调用链
 *  ---------------------------------------------------------------------------
 *      模型输出 tool_use: { name: 'EnterPlanMode' }
 *        └─> 工具调度层 src/services/tools/toolOrchestration.ts（按名字找到工具）
 *              └─> Tool.validateInput()      ← 本文件没实现，走默认（直接通过）
 *              └─> Tool.checkPermissions()   ← 本文件没实现，走默认 = 弹窗问用户
 *                                              （shouldDefer: true 让它排进延迟工具队列）
 *              └─> ★ EnterPlanModeTool.call() ← 本文件第 77 行，真正改模式的地方
 *                    └─> prepareContextForPlanMode()  ../../utils/permissions/permissionSetup.js
 *                    └─> applyPermissionUpdate()      ../../utils/permissions/PermissionUpdate.js
 *                          └─> context.setAppState(...)  修改全局 AppState
 *              └─> mapToolResultToToolResultBlockParam()  ← 本文件第 103 行
 *                    把"你现在是只读模式了，按这 6 步来"这段指令回灌给模型
 *
 *  关键点：本文件自己**不做任何权限拦截**，它只负责翻转 mode 这个开关。
 *  拦截是 mode 变成 'plan' 之后，权限系统自己产生的效果。
 *  这是典型的「声明式」设计——改状态，行为由别处根据状态决定。
 *
 *  ---------------------------------------------------------------------------
 *  【本文件包含什么】
 *  ---------------------------------------------------------------------------
 *   1. inputSchema / outputSchema      用 zod 声明的入参、出参结构（本工具入参为空）
 *   2. EnterPlanModeTool               工具对象本体，一个大的配置对象（第 36 行起）
 *      ├─ isEnabled()                  编译期 + 运行期双重开关：--channels 下禁用
 *      ├─ isConcurrencySafe()           true：可以和别的工具并发跑
 *      ├─ isReadOnly()                 true：本工具自己不改任何文件
 *      ├─ call()                      ★核心：把 mode 切成 'plan'
 *      └─ mapToolResultToToolResultBlockParam()
 *                                      ★核心：把 plan mode 的行为准则回灌给模型
 *
 *  ---------------------------------------------------------------------------
 *  【TS 语法速查】Java 工程师视角（按在本文件出现的顺序）
 *  ---------------------------------------------------------------------------
 *  - `import type { Tool } from '../../Tool.js'`
 *      `import type` 表示只导入「类型」，编译后这行会被完全删掉。
 *      ≈ Java 里只有 import 一种形式，TS 需要区分是为了避免产生运行时依赖。
 *      混在一起的写法是 `import { buildTool, type ToolDef } from '../../Tool.js'`，
 *      即同一个 import 语句里，普通值照常导入，类型前面加 `type` 标注。
 *
 *  - `lazySchema(() => z.strictObject({...}))`
 *      lazySchema 是个自定义包装（../../utils/lazySchema.js）：
 *      外面套一层「懒加载」，只有第一次真正用到时才执行箭头函数里的构造逻辑。
 *      ≈ Java 的 Supplier + 自己写的 memoize（缓存一次结果）。
 *      为什么？zod 的 schema 构造有成本，一个 CLI 进程里有上百个工具，
 *      启动时全建一遍会拖慢启动速度。
 *
 *  - `z` 就是 zod 库（import { z } from 'zod/v4'）
 *      作用 ≈ Java 的 Bean Validation（@NotNull/@Size）+ Jackson 的反序列化校验。
 *      区别：zod 校验的同时**推导出 TS 类型**，一份声明两用。
 *
 *  - `type InputSchema = ReturnType<typeof inputSchema>`
 *      `typeof inputSchema` 取某个**值**的类型；`ReturnType<F>` 取函数 F 的返回类型。
 *      合起来 = "inputSchema 这个函数的返回值是什么类型"。
 *      ≈ Java 没有对应物（Java 没有"取方法的返回类型"这种类型运算）。
 *      这么写是为了避免手写两遍类型定义，改 schema 时类型自动跟着变。
 *
 *  - `export type Output = z.infer<OutputSchema>`
 *      ★ 这是 zod 最核心的用法：从 schema **推导**出 TS 类型。
 *      `z.infer<...>` 会把 { message: z.string() } 变成 { message: string }。
 *      ≈ Java 里手写 record Output(String message) {}，
 *        但 TS 这边是自动生成的，schema 改了类型自动跟着改，不会写歪。
 *
 *  - 类型标注在**变量名后面**：`let n: number`
 *    （Java 是 `int n`，方向相反，初学最容易看串）
 *
 *  - `async description() { ... }` / `get inputSchema(): InputSchema { ... }`
 *      这是「对象字面量里的方法简写」。
 *      `async description() {...}`  ≈ Java 的 `CompletableFuture<String> description()`
 *      `get inputSchema() {...}`    ≈ Java 的 getter `getInputSchema()`
 *      注意：`get` 关键字让调用方写 `tool.inputSchema` 而不是 `tool.inputSchema()`，
 *            看起来像字段，实际每次访问都会重新执行函数体。
 *            本文件里 getter 每次都重新调 inputSchema()，靠 lazySchema 内部缓存兜底。
 *
 *  - `?.` 可选链：`a?.b` ≈ Java 的 `a != null ? a.b : null`。
 *    本文件 `context.getAppState()` 前的各种 `?.` 都是防 null 的安全写法。
 *
 *  - `??` 空值合并：`a ?? b`，只有 a 是 null/undefined 时才用 b。
 *    ⚠️ 与 Java 的 `||` 不同：`0` 和 `''`（空串）不会被 `??` 替换掉，
 *       但会被 `||` 替换掉。这是 TS/JS 最常见的踩坑点。
 *
 *  - `? :` 三元运算符：`cond ? a : b`，和 Java 完全一样。
 *
 *  - `!` 非空断言：`x!.foo` = "我保证 x 不是 null，编译器别管了"。
 *    ≈ Java 的 `(Foo) x` 强转：运行时不做检查，纯粹骗编译器。
 *
 *  - `as X` 类型断言：`(e as Error).message`
 *    也是"我比你更清楚这玩意儿是什么类型"。≈ Java 的强制转换 `(Error) e`。
 *
 *  - `{ ...prev, toolPermissionContext: ... }` 对象展开
 *    ≈ Java 没有对应语法。语义是「浅拷贝 prev，再用后面这些字段覆盖」。
 *    这是本文件乃至整个仓库的**核心手法——不可变更新**：
 *    不修改原对象，而是造一个新对象。好处是别处持有的旧快照不会被偷偷改掉，
 *    React 也能靠引用变化判断"要不要重渲染"。
 *
 *  - `context.setAppState(prev => ({ ...prev, ... }))`
 *      `prev => ({...})` 是箭头函数 ≈ Java 的 lambda `prev -> {...}`。
 *      这里传的是「更新函数」而不是新值，≈ Java 的
 *      `map.replaceAll(k, v -> newState)` —— 框架把当前值喂给你，你返回新值。
 *      这么设计是为了避免并发下读到的 prev 已经过期。
 *
 *  - `_input`、`_options` 这种下划线开头的参数名
 *      团队约定：表示"这个参数我用不上"。因为 TS 的 noUnusedParameters 检查
 *      会报unused 错误，加下划线前缀可豁免。
 *      ≈ Java 里对未使用参数只能干瞪眼或加 @SuppressWarnings。
 *
 *  - `feature('KAIROS')`  ★重要：这是**编译期**常量，不是运行时 if！
 *      来自 `bun:bundle`。打包时会被替换成字面量 true/false，
 *      再被 tree-shaking（DCE）把整段代码从产物里彻底删掉。
 *      ≈ Java 没有；近似 C 的 `#ifdef KAIROS`。
 *      副作用：它**只能用在 if/三元的条件位置**，不能先赋给变量再判断
 *      （那样打包器就认不出来了）。所以本文件 isEnabled() 里
 *      `feature('KAIROS') || feature('KAIROS_CHANNELS')` 必须直接写在 if 里。
 *
 *  - `} satisfies ToolDef<InputSchema, Output>)`  ★本文件最后一行
 *      `satisfies` 是 TS 4.9 的新关键字。
 *      语义："请检查这个对象是否符合 ToolDef 类型，但**不要**把它的类型
 *      收窄成 ToolDef"。这样对象里每个字段的字面量类型都保留着，
 *      call() 里就能精确知道 input 是 { } 而不是宽泛的 unknown。
 *      ≈ Java 的 `implements` 但不会丢失具体类型信息；
 *        换成 `: ToolDef<...>` 注解就会丢，这是两者唯一的区别。
 *
 *  - `100_000` 数字分隔符，和 Java 7+ 的 `100_000` 一模一样，纯可读性。
 */
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  handlePlanModeTransition,
} from '../../bootstrap/state.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'
import { prepareContextForPlanMode } from '../../utils/permissions/permissionSetup.js'
import { isPlanModeInterviewPhaseEnabled } from '../../utils/planModeV2.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from './constants.js'
import { getEnterPlanModeToolPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/**
 * 入参 schema：本工具**不需要任何参数**（模型只要喊一声"我要进 plan mode"就够了）
 *
 * 为什么还要写一个空的对象？
 *   因为工具框架要求每个工具都得有 inputSchema，没有的话模型在调用时
 *   不知道该传什么，某些 SDK 路径会直接报错。写个空壳是最明确的表达方式。
 *
 * 为什么用 `strictObject` 而不是 `object`？
 *   z.strictObject 是**严格模式**：模型要是多传了任何额外字段，直接报错拒绝。
 *   ≈ Jackson 的 @JsonIgnoreProperties(ignoreUnknown = false)。
 *   这么严格是有意的——模型偶尔会幻觉出参数名，宽松模式会静默吞掉，
 *   严格模式能立刻把错误暴露出来（对"切换模式"这种动作尤其重要）。
 *
 * 语法点：`lazySchema(() => ...)` 把构造过程包进箭头函数，延迟到首次调用才执行，
 * 之后结果被缓存。≈ Java 的 Supplier + 记忆化。详见文件头注释。
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    // No parameters needed
  }),
)
// 从 schema 反推出 TS 类型，避免手写两遍（schema 改了类型自动跟着改）
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 出参 schema：只有一句话，用来告诉模型"你已经进 plan mode 了"。
 *
 * 注意这里用的是 z.object 而不是 z.strictObject——出参是我们自己造的，
 * 不需要像入参那样防模型乱传字段。
 *
 * `.describe('...')` 是给字段写人类可读说明。
 * 这个说明会**原样出现在发给模型的 JSON Schema 里**，所以它是
 * 「写给模型看的文档」，不是写给程序员看的注释——措辞很关键。
 */
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Confirmation that plan mode was entered'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
/**
 * 对外导出的出参类型，由 schema 自动推导得到（≈ { message: string }）。
 * UI.tsx 会 import 这个类型来渲染结果——所以它是本文件和 UI 之间的契约。
 */
export type Output = z.infer<OutputSchema>

/**
 * ★ 工具本体。
 *
 * 注意它**不是**一个 class，而是一个用 buildTool(...) 包起来的**大对象字面量**。
 * ≈ Java 里你会写 `class EnterPlanModeTool extends AbstractTool { ... }`，
 *   而 TS/JS 这边更常见的做法是「配置对象 + 工厂函数」：
 *   把一堆钩子函数（description/prompt/call/isEnabled...）塞进一个普通对象，
 *   交给 buildTool 统一装配成工具实例。
 * 好处是轻量、好测试、可以任意组合；代价是没有编译期的"必须实现哪些方法"检查
 * （靠最后那句 `satisfies ToolDef<...>` 补上）。
 *
 * 这些钩子按调用时机大致分三类：
 *   ① 元数据类（模型会看到）  name / searchHint / description / prompt / inputSchema
 *   ② 准入判定类（框架会调）  isEnabled / isConcurrencySafe / isReadOnly / shouldDefer
 *   ③ 生命周期类（真干活）    call / mapToolResultToToolResultBlockParam / render*
 */
export const EnterPlanModeTool: Tool<InputSchema, Output> = buildTool({
  // 工具的唯一标识。模型输出 tool_use 时靠这个名字匹配到本工具。
  // 用常量而不是字面量，是为了让别处（权限判定/UI）引用同一个来源，改名不会漏。
  name: ENTER_PLAN_MODE_TOOL_NAME,
  // 给"工具检索/推荐"用的描述。工具太多时（几百个），
  // 框架会先用这句话做语义匹配，粗筛出候选工具再塞进模型的上下文。
  searchHint: 'switch to plan mode to design an approach before coding',
  // 工具结果最多允许多少字符。超过就截断，防止某个工具吐出 10MB 日志
  // 把整个模型上下文撑爆。100_000 的下划线是数字分隔符，和 Java 一样纯为可读。
  maxResultSizeChars: 100_000,
  // 一句话描述，会出现在模型的工具清单里。
  // 写成 async 是因为框架允许某些工具去读配置/远程开关再决定措辞，
  // 统一成异步能让调用方无脑 await。（本工具直接返回常量即可）
  async description() {
    return 'Requests permission to enter plan mode for complex tasks requiring exploration and design'
  },
  async prompt() {
    return getEnterPlanModeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 展示给用户的名字。返回空串 '' 是**有意为之**：
   * 表示"这个工具不需要在自己的行上单独显示一个标题"，
   * 结果会直接以普通文本的形式融进对话流里。
   * （对比：EnterWorktreeTool 返回 'Creating worktree'，那种就需要一行标题）
   */
  userFacingName() {
    return ''
  },
  /**
   * shouldDefer: true —— 「延迟加载」开关。
   *
   * 为什么需要？Claude Code 注册了几百个工具，全塞进系统提示词会把上下文撑爆。
   * 于是框架把工具分成两批：
   *   · 立即加载（核心工具，如 Read/Write/Bash）
   *   · 延迟加载（deferred）——只在系统提示词里放一行名字 + 一句话简介，
   *     模型真想用的时候，再通过一个「工具检索」步骤把完整定义拉进来。
   * 本工具属于"偶尔才用一次"的那一类，所以标 true。
   * 代价：模型需要先意识到"我需要进 plan mode"，多一步；收益：省上下文。
   */
  shouldDefer: true,
  /**
   * 这个工具在当前环境里**可不可用**（不可用的话模型根本看不到它）。
   *
   * 这里是双重开关：
   *   ① 编译期：feature('KAIROS') || feature('KAIROS_CHANNELS')
   *      —— 见文件头说明，打包时被替换成 true/false，整段可能被 DCE 删掉。
   *   ② 运行期：getAllowedChannels().length > 0
   *      —— 用户是不是用 `--channels` 启动的（接了 Telegram/Discord 之类的渠道）。
   *
   * 为什么渠道模式下要禁用？
   *   进 plan mode 需要用户同意，出 plan mode（ExitPlanMode）还需要再一次
   *   用户同意——而那个确认弹窗是**终端里的 TUI 弹窗**。
   *   如果用户在 Telegram 上聊天，根本没人去点那个弹窗，
   *   模型就会"进得去出不来"，卡死在一个永远退不出的只读模式里。
   *   所以干脆在入口就关掉，避免造成死局（代码注释里叫 trap，陷阱）。
   *   ⚠️ 这也是为什么 ExitPlanModeTool 里有一模一样的判断——两边必须成对开关。
   */
  isEnabled() {
    // When --channels is active, ExitPlanMode is disabled (its approval
    // dialog needs the terminal). Disable entry too so plan mode isn't a
    // trap the model can enter but never leave.
    // 【中文补注】上面这段英文注释的意思：渠道模式下 ExitPlanMode 被禁用了，
    // 所以 Enter 也一并禁用，否则就成了一个"只能进不能出"的陷阱。
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  /**
   * 声明"我自己是幂等/无副作用的，可以和其它工具并发执行"。
   * true = 框架可以把它和别的工具一起并行跑，不用串行等待。
   * 本工具只是读取状态，确实安全。
   */
  isConcurrencySafe() {
    return true
  },
  /**
   * 声明"这个工具是只读的，不会修改文件系统"。
   * ⚠️ 注意区分两个层面的"只读"：
   *   · isReadOnly() = true   → **本工具自己**不写文件（它只改内存里的 AppState）
   *   · plan mode 的只读      → 进模式之后，**其它所有工具**都被禁止写文件
   * 本工具是"开启只读模式的开关"，开关本身当然不是只读操作的结果——
   * 它改的是内存状态，不是磁盘，所以标 true 没问题。
   */
  isReadOnly() {
    return true
  },
  // 下面三行是「简写属性」：当变量名和字段名一模一样时，
  // `{ renderToolUseMessage }` 等价于 `{ renderToolUseMessage: renderToolUseMessage }`。
  // 这三个渲染函数实现在 UI.tsx 里（JSX/React 组件），负责终端里画成什么样。
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  /**
   * ★★★ 本文件的核心：真正把模式切成 'plan' 的地方。
   *
   * 做什么：
   *   把全局权限上下文（toolPermissionContext）的 mode 字段改成 'plan'，
   *   并顺带做进入 plan mode 该做的权限准备工作。
   *
   * 为什么需要（不复述代码的部分）：
   *   这里**没有**任何"禁止写文件"的判断。因为拦截不在这里做。
   *   这套设计的思路是「改状态，让别处按状态行事」：
   *     mode 变成 'plan' 之后，权限系统（utils/permissions/）
   *     在每次工具调用前检查 mode，发现是 'plan' 就拒绝写操作。
   *   好处是 plan mode 的约束能一次性覆盖**所有**工具（包括将来新加的），
   *   不用在每个写操作工具里各写一遍 if (inPlanMode) throw。
   *
   * 入参：
   *   _input   本工具没有入参（下划线前缀 = 我故意不用它）
   *   context  工具执行上下文，≈ Java 里注入进来的 ExecutionContext，
   *            能拿到全局状态、发通知、拿中断信号等
   *
   * 返回值：
   *   { data: { message: string } }  —— 必须符合前面 outputSchema 声明的形状，
   *   否则 zod 校验会失败。
   *
   * 关键步骤：
   *   ① 拒绝在「子 Agent 上下文」里调用（子 Agent 不能自己决定进 plan mode）
   *   ② 先记一次「模式迁移」事件，供内部状态机/埋点使用
   *   ③ 用不可变更新把 AppState 里的 mode 改成 'plan'
   */
  async call(_input, context) {
    // ① 子 Agent 禁止调用。原因：plan mode 需要一个能跟用户对话的终端来审批，
    //    子 Agent（被 Agent 工具派生出来的）没有独立的用户界面，
    //    让它进 plan mode 会导致它卡在只读状态里没人放行。
    //    `if (context.agentId)` 用的是 JS 的「真值判断」：
    //    agentId 是空串/undefined 时算 false，有值时算 true。
    if (context.agentId) {
      throw new Error('EnterPlanMode tool cannot be used in agent contexts')
    }

    const appState = context.getAppState()
    // ② 通知内部状态机："我要从 X 模式迁移到 plan 模式了"。
    //    这一步是给「分类器（classifier）」之类的旁路逻辑用的，
    //    它需要在模式切换的瞬间做一些副作用（比如记录/激活某些判定逻辑）。
    handlePlanModeTransition(appState.toolPermissionContext.mode, 'plan')

    // Update the permission mode to 'plan'. prepareContextForPlanMode runs
    // the classifier activation side effects when the user's defaultMode is
    // 'auto' — see permissionSetup.ts for the full lifecycle.
    // 【中文补注】上面的英文说的是：prepareContextForPlanMode() 除了剥权限之外，
    // 还会在用户的默认模式是 'auto' 时，顺带激活那个"对话分类器"——
    // 这是一处副作用，完整生命周期写在 permissionSetup.ts 里。
    //
    // ③ 不可变更新 AppState。这里有三层嵌套，逐层拆解给 Java 同学看：
    context.setAppState(prev => ({
      // 最外层：把旧状态 prev 的所有字段浅拷贝过来（不改原对象）
      ...prev,
      // 只覆盖 toolPermissionContext 这一个字段，值由下面两步加工得到
      toolPermissionContext: applyPermissionUpdate(
        // 第一步：prepareContextForPlanMode —— "进入 plan 前的权限预处理"
        //   它会把旧模式记到一个叫 prePlanMode 的字段里（供 ExitPlanMode 恢复用），
        //   并且剥掉一批危险权限。
        //   这就是 Enter/Exit 这对工具之间的**状态契约**：
        //   Enter 存 prePlanMode，Exit 读 prePlanMode。
        prepareContextForPlanMode(prev.toolPermissionContext),
        // 第二步：applyPermissionUpdate —— 套用一条"改模式"的权限变更指令
        //   { type: 'setMode', mode: 'plan', destination: 'session' }
        //   ≈ Java 里传一个 Command 对象给命令处理器：
        //     type = 指令类型；mode = 目标模式；
        //     destination: 'session' = 这条变更只在**本次会话**生效，
        //     不写进用户的配置文件（否则用户下次启动还在 plan mode，就坑了）。
        { type: 'setMode', mode: 'plan', destination: 'session' },
      ),
    }))
    // 语法点：`prev => ({...})` 是箭头函数 ≈ Java lambda `prev -> {...}`。
    // 注意 `({...})` 外面那对小括号——因为箭头函数直接返回**对象字面量**时，
    // 大括号会和函数体的大括号冲突，所以必须用小括号包起来。
    // 这是 TS/JS 新手最常见的语法坑之一。

    return {
      data: {
        // 这句 message 既是给 UI 显示的文案，也是下一站
        // mapToolResultToToolResultBlockParam() 的原材料（它会在此基础上追加指令）。
        message:
          'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.',
      },
    }
  },
  /**
   * ★★★ 本文件第二个核心：把"进 plan mode 之后你该怎么做"这段指令
   *      回灌给模型。
   *
   * 做什么：
   *   把 call() 返回的那句简短 message，加工成一整段**行为准则**，
   *   作为 tool_result 的内容发回给模型。
   *
   * 为什么需要（这是理解整个 plan mode 设计的关键）：
   *   "mode 改成 plan" 只是让**权限系统**拒绝写操作。但模型自己并不知道
   *   这意味着什么——它可能还是会不停尝试写文件，然后不停被拒绝，
   *   白白浪费好几轮对话。
   *   所以必须在工具结果里**明确用自然语言告诉它**：
   *   "你现在是只读模式了，按这 6 步来：先探索、再设计、最后调 ExitPlanMode"。
   *   这是「用提示词约束」和「用权限系统强制」双管齐下：
   *     软约束（提示词）让模型少走弯路；
   *     硬约束（权限）保证即使模型犯傻也改不了文件。
   *
   * 入参：
   *   { message }  —— 注意这是**解构**：直接从 call() 的输出对象里
   *                   把 message 字段抽出来当局部变量用。
   *                   ≈ Java 21+ 的记录模式匹配，但 TS 里是日常操作。
   *   toolUseID    —— 模型发起这次调用时给的 ID，回传结果时必须原样带上，
   *                   否则模型对不上是哪次调用的结果（API 会报格式错）。
   *
   * 返回值：
   *   一个 tool_result 块（Anthropic API 约定的格式）。
   *
   * 关键步骤：
   *   ① 根据「访谈阶段」开关是否打开，选择两套不同的指令文案
   *   ② 拼成一个 tool_result 块返回
   */
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    // ① 两套文案的取舍：
    //    · 访谈阶段（interview phase）打开时 —— 只说"别写文件，详细流程稍后到"。
    //      因为更详细的分步流程会通过另一条通道（plan_mode 附件，见 messages.ts）
    //      单独发给模型，这里再说一遍就是重复浪费 token。
    //    · 未打开时 —— 直接把 6 步流程写在这里。
    //    isPlanModeInterviewPhaseEnabled() 是个 A/B 实验开关（灰度），
    //    所以两套行为会同时存在于代码里，靠它来分流。
    //    语法点：`cond ? a : b` 三元表达式，和 Java 完全一样。
    const instructions = isPlanModeInterviewPhaseEnabled()
    const instructions = isPlanModeInterviewPhaseEnabled()
      ? `${message}

DO NOT write or edit any files except the plan file. Detailed workflow instructions will follow.`
      : `${message}

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`
    // 上面这段是**模板字符串**（反引号 ` 包起来）：可以换行、可以 ${插值}。
    // ≈ Java 15+ 的文本块（"""..."""），但 TS 里从语言诞生就有，且支持插值。
    // 这里用它是因为要给模型看的指令天然是多行文本，
    // 用普通字符串 + \n 拼会非常难读。

    // ② 组装 tool_result 块。
    //    'tool_result' 这个字符串字面量后面的 `as const` 没写在这里，
    //    但 TS 能从对象字面量推断出字面量类型，配合 satisfies 就够严了。
    return {
      type: 'tool_result',
      content: instructions,
      tool_use_id: toolUseID,
    }
  },
  // 最后这行 `satisfies ToolDef<InputSchema, Output>` 是编译期契约检查：
  // "请验证上面这个对象确实实现了工具接口，但不要把它的类型擦成 ToolDef"。
  // 好处：既保证漏写 call() 之类的方法会报错，
  //      又保留了每个字段的精确类型（call() 里 input 依然能推导出具体形状）。
  // ≈ Java 的 implements，但不丢泛型细节。
} satisfies ToolDef<InputSchema, Output>)
