// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * ============================================================================
 *  【文件总览】src/query.ts —— Claude Code 的 Agent 主循环（Turn Loop）
 * ============================================================================
 *
 *  一句话定位：
 *  本文件是整个 Claude Code 的「推理执行引擎」。用户敲下回车提交一条消息后，
 *  代码最终会走到这里，进入一个不断重复的循环：
 *
 *      调模型 → 模型说"我要用工具" → 执行工具 → 把结果喂回模型 → 再调模型 → …
 *
 *  直到模型不再请求任何工具（直接给出最终答复），这一轮（turn）才算结束。
 *
 *  在整个仓库中的调用层级：
 *
 *      UI 层 (src/screens/REPL.tsx)
 *        └─> QueryEngine.submitMessage()              ← src/QueryEngine.ts
 *              └─> query()                           ← ★ 本文件 src/query.ts
 *                    ├─> deps.callModel(...)         ← src/services/api/claude.ts（真正发 HTTP 请求给模型）
 *                    ├─> runTools(...)               ← src/services/tools/toolOrchestration.ts（执行工具）
 *                    ├─> deps.autocompact(...)       ← src/services/compact/autoCompact.ts（上下文超长时自动压缩）
 *                    └─> handleStopHooks(...)        ← src/query/stopHooks.ts（Stop hook 拦截）
 *
 *  打个比方：如果 Claude Code 是一个"人"，那么
 *    - src/QueryEngine.ts 是「前额叶」：决定这轮要说什么、维护会话状态、对外产出 SDK 事件；
 *    - src/query.ts     是「脑干」：负责呼吸——也就是上面那条不停循环的反射弧。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含的东西】（就这么 5 个，别被 1700 行吓到）
 * ---------------------------------------------------------------------------
 *   1. query()                        唯一对外入口，被 QueryEngine 调用
 *   2. queryLoop()                    真正的循环体（占了文件 90% 的篇幅，内部函数）
 *   3. yieldMissingToolResultBlocks() 出错/中断时补齐 tool_result 的「补洞」工具
 *   4. isWithheldMaxOutputTokens()    判断某条错误要不要"暂时扣住不往外抛"
 *   5. QueryParams / State            query() 的入参类型 / 循环跨轮次携带的可变状态
 *
 * ---------------------------------------------------------------------------
 *  【为什么要用"生成器"这种写法？——Java 工程师最需要先跨过的一道坎】
 * ---------------------------------------------------------------------------
 *  query() 的签名是 `async function* query(...)`：它既 async 又 generator。
 *
 *  Java 里没有直接对应的东西，最接近的 mental model 是：
 *      「一个可以暂停的、边跑边往外吐元素的响应式流」
 *   ≈ Java 的  Iterator<T> + CompletableFuture + Reactor 的 Flux  三者合体。
 *
 *  为什么非要这么写？因为 AI 交互是**流式**的：模型是一个字一个字吐回来的。
 *  如果用 Java 常见的 "先收集完 List 再 return"，用户在屏幕上就要干等 30 秒
 *  才看到第一个字。而用生成器，每收到一小块就 `yield` 出去，UI 立刻能渲染。
 *
 *  关键语法（下面代码里会反复出现，先混个脸熟）：
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ `yield x`        吐出一个值，函数在此"暂停"，下次被要值时从这行继续跑 │
 *   │                  ≈ Java 里没有；想象成 Flux 的 sink.next(x) 后让出   │
 *   │                                                                      │
 *   │ `yield* g()`    把另一个生成器的产出**原样透传**出去（委托）         │
 *   │                  ≈ 把内层 Flux 直接 flatMap 摊平到外层流里           │
 *   │                  （注意与 `yield x` 区别：yield 会包一层，yield* 不会）│
 *   │                                                                      │
 *   │ `for await (const m of gen)`                                         │
 *   │                  消费一个异步生成器。每次循环体执行前，会 await 到     │
 *   │                  下一个值；生成器 return 后循环自然结束               │
 *   │                  ≈ Java 的 for-each，但支持异步                       │
 *   │                                                                      │
 *   │ AsyncGenerator<T, TReturn>                                           │
 *   │                  返回类型。T = yield 出去的元素类型，                 │
 *   │                  TReturn = 函数最终 return 的值类型                   │
 *   │                  （对应本文件的 `Terminal`——循环是怎么结束的）        │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 *  所以 `query()` 的调用方长这样（在 QueryEngine 里）：
 *      for await (const event of query(params)) { ... 立刻渲染 ... }
 *  而 query() 内部则是一边流式收模型输出、一边 `yield` 给外面。
 *
 * ---------------------------------------------------------------------------
 *  【其它 TS 语法，Java 工程师视角速查】（按在本文件出现的频率排序）
 * ---------------------------------------------------------------------------
 *  - `feature('XXX')`  ：**编译期**常量，不是运行时 if！来自 `bun:bundle`。
 *                        打包时会被替换成 true/false，再被 tree-shaking 掉，
 *                        从而把整段代码从产物里彻底删掉（Dead Code Elimination）。
 *                        ≈ Java 里没有；近似 C 的 `#ifdef XXX`。
 *                        副作用：它只能用在 if/三元的条件位置，不能赋给变量再判断。
 *                        所以你会在本文件看到嵌套的 if 里套 feature() 这种写法，
 *                        那不是代码风格差，是 DCE 的硬性约束。
 *
 *  - `const { a, b } = obj`     解构赋值。≈ Java 的记录模式匹配（Java 21+），
 *                               但 TS 里是日常操作，随处可见。
 *
 *  - `?.` 可选链：`a?.b?.c` ≈ Java 的 `a != null && a.b != null ? a.b.c : null`
 *  - `??` 空值合并：`a ?? b` 只在 a 是 null/undefined 时用 b。
 *                   ⚠️ 与 Java 的 `||` 不同：`0` 和 `''` 不会被 `??` 替换掉。
 *  - `!`  非空断言：`x!.foo` = "我保证 x 不是 null，编译器别管了"。
 *                   ≈ Java 的 `(Foo) x` 强转，运行时不做检查，骗编译器而已。
 *  - `x ??= v` / `x ||= v` / `x &&= v`  逻辑赋值运算符。
 *
 *  - 类型标注在**后面**：`let n: number`、`function f(a: string): void`
 *    （Java 是 `int n`、`void f(String a)`，正好反过来，初期最容易看串）
 *
 *  - `type X = { a: string; b?: number }` 结构化类型。
 *    ≈ Java 的 record/class，但**按结构匹配（鸭子类型）**，不需要 implements。
 *    `b?: number` 表示 b 可选，等价于 `number | undefined`。
 *    `[k: string]: string` 是索引签名 ≈ `Map<String,String>` 的写法。
 *
 *  - `a | b` 联合类型 ≈ Java 的 sealed interface 的两个实现，但轻量得多。
 *  - `msg is AssistantMessage` 类型谓词：返回 boolean 的函数，但能**收窄**类型。
 *    一旦 if 进去，编译器就知道 msg 是 AssistantMessage 了。
 *    ≈ Java 的 `if (o instanceof Foo f) { ... }`（Java 16+ 的模式匹配）。
 *
 *  - `{ ...obj, a: 1 }` 展开。≈ Java 没有；想象成 new 一个副本并覆盖某字段。
 *    本文件里 `state = { ...state, turnCount: n }` 是核心手法——
 *    **不可变更新**：不修改原对象，而是复制一份新的。好处是旧快照不会被人偷偷改掉。
 *
 *  - `.at(-1)` 取最后一个元素（负索引，Java 的 list.get(size-1) 没有这语法糖）
 *  - `.filter(c => c.type === 'tool_use')`  ≈ stream().filter(...)
 *  - `void someAsyncFn()`  = 明确表示"我知道它返回 Promise，但我故意不 await"。
 *    即「发射后不管」≈ Java 的 executor.submit(...) 但不 get()。
 *
 *  - `using x = getResource()`  TC39 显式资源管理（很新的语法）。
 *    ≈ Java 的 try-with-resources，作用域结束时自动调用 dispose()。
 *    本文件的 `using pendingMemoryPrefetch = ...` 就是这个用法。
 *
 * ---------------------------------------------------------------------------
 *  【一句话理解本文件的核心难点】
 * ---------------------------------------------------------------------------
 *  这个文件之所以长，不是因为逻辑复杂，而是因为**它要为各种"意外"兜底**：
 *  上下文超长了怎么办（snip/microcompact/collapse/autocompact 四级瘦身）、
 *  模型输出被 max_tokens 截断了怎么办（提高上限重试 / 注入"接着说"提示）、
 *  用户 Ctrl+C 了怎么办（补齐缺失的 tool_result，否则 API 会报格式错）、
 *  主模型挂了怎么办（切 fallbackModel 重跑）。
 *  主干逻辑其实只有「调模型 → 执行工具 → 再调模型」这一句，其余全是容错。
 * ============================================================================
 */
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
} from './services/api/errors.js'
import { logAntError, logForDebugging } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getRuntimeMainLoopModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 【补洞工具】为「只有 tool_use、没有 tool_result」的孤儿消息补齐结果块。
 *
 * 为什么需要它？
 * Anthropic API 有一条硬性格式约束：**每一个 tool_use 块，都必须有配对的 tool_result 块**，
 * 否则下次请求会直接 400 报错（就像数据库里外键约束没满足）。
 *
 * 而以下几种情况会破坏这个配对关系：
 *   - 用户在模型输出 tool_use 之后、工具执行之前按了 Ctrl+C（中断）
 *   - 主模型挂了，要切 fallbackModel 重跑（旧的那批 tool_use 就作废了）
 *   - 流式中途抛了未预期的异常
 * 这时如果不补，会话历史里就留着"悬空"的 tool_use，后续请求必炸。
 * 本函数就是给每个悬空的 tool_use 补一个 `is_error: true` 的 tool_result，
 * 让历史重新合法——相当于"把话说完，哪怕说的是'这事没干成'"。
 *
 * 关于语法：注意这是 `function*`（普通生成器），不是 `async function*`。
 * 因为它内部没有任何 await，只是同步地遍历 + yield。
 * 调用方统一用 `yield* yieldMissingToolResultBlocks(...)` 把产出透传给外层。
 *
 * @param assistantMessages 本轮已经产出的所有 assistant 消息（里面可能含孤儿 tool_use）
 * @param errorMessage      填进 tool_result 里的错误文案（会展示给用户 / 回传给模型）
 */
function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // Extract all tool use blocks from this assistant message
    // 语法点：`content.filter(...) as ToolUseBlock[]`
    //   filter 的返回值类型仍是宽泛的 ContentBlock 联合类型，
    //   光靠 c.type === 'tool_use' 这个判断，TS 编译器还不足以自动收窄类型，
    //   所以末尾要用 `as` 断言一下（等价于 Java 的强制类型转换）。
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // Emit an interruption message for each tool use
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * The rules of thinking are lengthy and fortuitous. They require plenty of thinking
 * of most long duration and deep meditation for a wizard to wrap one's noggin around.
 *
 * The rules follow:
 * 1. A message that contains a thinking or redacted_thinking block must be part of a query whose max_thinking_length > 0
 * 2. A thinking block may not be the last message in a block
 * 3. Thinking blocks must be preserved for the duration of an assistant trajectory (a single turn, or if that turn includes a tool_use block then also its subsequent tool_result and the following assistant message)
 *
 * Heed these rules well, young wizard. For they are the rules of thinking, and
 * the rules of thinking are the rules of the universe. If ye does not heed these
 * rules, ye will be punished with an entire day of debugging and hair pulling.
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * Is this a max_output_tokens error message? If so, the streaming loop should
 * withhold it from SDK callers until we know whether the recovery loop can
 * continue. Yielding early leaks an intermediate error to SDK callers (e.g.
 * cowork/desktop) that terminate the session on any `error` field — the
 * recovery loop keeps running but nobody is listening.
 *
 * Mirrors reactiveCompact.isWithheldPromptTooLong.
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

/**
 * query() 的入参。**整个 Agent 主循环的全部输入都装在这一个对象里**。
 *
 * 设计上刻意分成两类，理解这个划分对读懂 queryLoop 很关键：
 *   - 只读参数（messages / systemPrompt / userContext / canUseTool / querySource 等）：
 *     自始至终不变。它们在 queryLoop 开头被一次性解构出来，之后绝不重新赋值。
 *   - 可变状态（turnCount / autoCompactTracking / maxOutputTokensOverride 等）：
 *     每轮都在变，单独抽到下面的 `State` 类型里，靠 `state = { ... }` 整体替换。
 *
 * 为什么要分？因为循环体会在 7 个不同的地方 `continue`（继续下一轮），
 * 如果状态是一堆散落的 let 变量，每个 continue 前都得写 9 行赋值，极易漏。
 * 收敛成一个 State 对象后，每个 continue 前只需 `state = { ...state, 改的字段 }` 一行。
 *
 * 语法点：`fallbackModel?: string` 里的 `?` 表示该字段可选（可能不存在），
 * 读出来时类型是 `string | undefined`。≈ Java 的 Optional 但更轻量，是编译期概念。
 */
export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API task_budget (output_config.task_budget, beta task-budgets-2026-03-13).
  // Distinct from the tokenBudget +500k auto-continue feature. `total` is the
  // budget for the whole agentic turn; `remaining` is computed per iteration
  // from cumulative API usage. See configureTaskBudgetParams in claude.ts.
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// -- query loop state

// Mutable state carried between loop iterations
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  // Why the previous iteration continued. Undefined on first iteration.
  // Lets tests assert recovery paths fired without inspecting message contents.
  transition: Continue | undefined
}

/**
 * 【对外唯一入口】跑完一整个 Agent 轮次（turn）。
 *
 * 职责其实很薄——它只是一层"收尾外壳"，真正 1500 行的循环体在下面的 queryLoop() 里。
 * 它自己只多干一件事：确保**被消费掉的排队命令**在循环正常结束后被标记为 completed。
 *
 * 这里有个很精妙的生成器语义细节（Java 工程师务必注意，这是个真实踩过的坑）：
 *
 *     const terminal = yield* queryLoop(...)      ← 委托给内层生成器
 *     for (const uuid of consumedCommandUuids) {  ← 只有"正常走到这"才会执行
 *
 * 因为生成器的三种退出方式行为不同：
 *   1. queryLoop 正常 return  → 会执行到下面的 for 循环 ✅ 命令标记 completed
 *   2. queryLoop 内部抛异常    → 异常直接穿透 yield* 往外冒，下面的 for 被跳过 ❌
 *   3. 外部调用 .return()      → 两个生成器一起被关闭，下面的 for 也被跳过 ❌
 *
 * 这正是想要的效果：命令「已开始但没完成」和「已完成」必须能区分开，
 * 否则 UI 上的命令会永远卡在 spinning 状态。
 *
 * 语法点：返回类型 `AsyncGenerator<StreamEvent | RequestStartEvent | ... , Terminal>`
 *   - 第一个泛型参数是一长串 `A | B | C` 联合类型 = yield 出去的元素可能是其中任意一种
 *   - 第二个泛型参数 Terminal = 函数最终 return 的值，表示「这个循环是怎么结束的」
 *     （正常完成 / 用户中断 / 超长被阻断 / 达到最大轮数 / 出错 …）
 *   调用方既能在 for-await 里逐个拿到流式事件，又能在结束后知道终止原因。
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // Only reached if queryLoop returned normally. Skipped on throw (error
  // propagates through yield*) and on .return() (Return completion closes
  // both generators). This gives the same asymmetric started-without-completed
  // signal as print.ts's drainCommandQueue when the turn fails.
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

/**
 * 【真正的循环体】Agent 主循环。整个 Claude Code 的心脏，占了本文件 90% 篇幅。
 *
 * ============================================================================
 *                     主循环骨架（先背下来，再看代码）
 * ============================================================================
 *
 *   while (true) {                              ← 无限循环，靠 continue / return 控制
 *
 *     ┌─ 阶段 0：轮次初始化 ────────────────────────────────────────────┐
 *     │ 解构出本轮状态；开启技能预取；递增 queryChain 追踪 ID             │
 *     └───────────────────────────────────────────────────────────────┘
 *                              │
 *     ┌─ 阶段 1：上下文瘦身（四级，从轻到重，依次尝试）────────────────┐
 *     │ ① snip        剪掉历史里最老的若干轮（最轻量）                  │
 *     │ ② microcompact 把超大的单条工具结果替换成占位符                 │
 *     │ ③ collapse    把多轮折叠成摘要（保留粒度，比 compact 好）        │
 *     │ ④ autocompact 兜底：把整段历史压缩成一段摘要（最重，会丢细节）   │
 *     │ 顺序很讲究：轻的先做，够了就不做重的——能保留多少细节就保留多少。│
 *     └───────────────────────────────────────────────────────────────┘
 *                              │
 *     ┌─ 阶段 2：硬阻断检查 ──────────────────────────────────────────┐
 *     │ 若上下文已经撑爆且自动压缩被关掉，直接报错退出，                 │
 *     │ 把 token 空间留给用户手动 /compact。                            │
 *     └───────────────────────────────────────────────────────────────┘
 *                              │
 *     ┌─ 阶段 3：调用模型 + 流式消费（本文件最核心的一段）─────────────┐
 *     │ for await (const message of deps.callModel(...)) {              │
 *     │     · 边收边 yield 给 UI（流式渲染的关键，就在这里）            │
 *     │     · 顺手收集 tool_use 块 → 记到 toolUseBlocks，并置           │
 *     │       needsFollowUp = true（这是**唯一的循环继续信号**）         │
 *     │     · 可恢复的错误（超长/超媒体/超输出）先**扣住不 yield**，     │
 *     │       交给后面的恢复逻辑处理，处理不了才抛给用户                │
 *     │     · 若主模型挂了 → 切 fallbackModel，continue 重跑本轮        │
 *     │ }                                                              │
 *     └───────────────────────────────────────────────────────────────┘
 *                              │
 *     ┌─ 阶段 4：流式中断处理 ────────────────────────────────────────┐
 *     │ 用户在模型吐字过程中按了 Ctrl+C：补齐 tool_result，收尾退出。    │
 *     └───────────────────────────────────────────────────────────────┘
 *                              │
 *              ┌───────────────┴───────────────┐
 *              │                               │
 *   needsFollowUp === false            needsFollowUp === true
 *   （模型没要工具 → 这轮该收尾了）      （模型要了工具 → 得去执行）
 *              │                               │
 *     ┌────────▼─────────────────┐    ┌─────────▼──────────────────┐
 *     │ 阶段 5：收尾            │    │ 阶段 6：执行工具            │
 *     │ · 413 超长 → 尝试恢复   │    │ runTools(...) 逐个执行，     │
 *     │ · 超 token → 提升上限   │    │ 结果塞进 toolResults        │
 *     │   重试 / 注入"接着说"   │    └─────────┬──────────────────┘
 *     │ · Stop hook 拦截        │              │
 *     │ · token budget 续写     │    ┌─────────▼──────────────────┐
 *     │ · 都没有 → return 完成  │    │ 阶段 7：中断/防继续检查     │
 *     └────────────────────────┘    └─────────┬──────────────────┘
 *                                             │
 *     ┌─ 阶段 8：附件注入 ──────────────────────────────────────────┐
 *     │ 排队的用户消息 / 后台任务通知 / 记忆文件 / 技能建议，        │
 *     │ 都在这时作为 attachment 塞进下一轮的上下文。                 │
 *     └───────────────────────────────────────────────────────────────┘
 *                              │
 *     ┌─ 阶段 9：装配下一轮 ────────────────────────────────────────┐
 *     │ state = { ...历史, ...本轮assistant回复, ...toolResults }     │
 *     │ continue  → 回到 while(true) 顶部，进入下一轮                │
 *     └───────────────────────────────────────────────────────────────┘
 *
 * ============================================================================
 *                          读这份代码时的 4 个要点
 * ============================================================================
 *
 * ① 循环怎么退出？
 *    只有两条路。要么走到 `return { reason: ... }`（各种终止原因），
 *    要么 needsFollowUp 为 false 走到阶段 5 的 `return { reason: 'completed' }`。
 *    **没有任何 break**——看到 while(true) 别慌，找 return 就行。
 *
 * ② `continue` 不等于"跳过"。
 *    本函数里 continue 前必然伴随着 `state = { ... }` 的整体替换，
 *    所以是「带着新状态进入下一轮」，而不是「什么都不做再来一次」。
 *
 * ③ 为什么大量状态不直接用 let 变量？
 *    见上面 State 类型的说明——为了 7 个 continue 站点都不会漏掉某个字段。
 *
 * ④ 为什么到处是 `feature('XXX')`？
 *    编译期开关（见文件头）。读代码时可以先把它当成 `true` 忽略掉，
 *    这样能少看掉一半的分支，主干逻辑会清晰很多。
 */
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // Immutable params — never reassigned during the query loop.
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // Mutable cross-iteration state. The loop body destructures this at the top
  // of each iteration so reads stay bare-name (`messages`, `toolUseContext`).
  // Continue sites write `state = { ... }` instead of 9 separate assignments.
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // task_budget.remaining tracking across compaction boundaries. Undefined
  // until first compact fires — while context is uncompacted the server can
  // see the full history and handles the countdown from {total} itself (see
  // api/api/sampling/prompt/renderer.py:292). After a compact, the server sees
  // only the summary and would under-count spend; remaining tells it the
  // pre-compact final window that got summarized away. Cumulative across
  // multiple compacts: each subtracts the final context at that compact's
  // trigger point. Loop-local (not on State) to avoid touching the 7 continue
  // sites.
  let taskBudgetRemaining: number | undefined = undefined

  // Snapshot immutable env/statsig/session state once at entry. See QueryConfig
  // for what's included and why feature() gates are intentionally excluded.
  const config = buildQueryConfig()

  // Fired once per user turn — the prompt is invariant across loop iterations,
  // so per-iteration firing would ask sideQuery the same question N times.
  // Consume point polls settledAt (never blocks). `using` disposes on all
  // generator exit paths — see MemoryPrefetch for dispose/telemetry semantics.
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ▼▼▼ 阶段 0：轮次初始化 ▼▼▼
    // Destructure state at the top of each iteration. toolUseContext alone
    // is reassigned within an iteration (queryTracking, messages updates);
    // the rest are read-only between continue sites.
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    // Skill discovery prefetch — per-iteration (uses findWritePivot guard
    // that returns early on non-write iterations). Discovery runs while the
    // model streams and tools execute; awaited post-tools alongside the
    // memory prefetch consume. Replaces the blocking assistant_turn path
    // that ran inside getAttachmentMessages (97% of those calls found
    // nothing in prod). Turn-0 user-input discovery still blocks in
    // userInputAttachments — that's the one signal where there's no prior
    // work to hide under.
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // Record query start for headless latency tracking (skip for subagents)
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // Initialize or increment query chain tracking
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    // ▼▼▼ 阶段 1：上下文瘦身（snip → microcompact → collapse → autocompact，由轻到重依次尝试）▼▼▼
    // 先取最近的 compact 边界之后的全部消息作为本轮的上下文输入。
    // 语法点：[...arr] 是数组展开复制，≈ Java 的 new ArrayList<>(arr)，
    //         目的是不污染原数组（保持不可变，避免别处拿到意外修改）。
    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    let tracking = autoCompactTracking

    // Enforce per-message budget on aggregate tool result size. Runs BEFORE
    // microcompact — cached MC operates purely by tool_use_id (never inspects
    // content), so content replacement is invisible to it and the two compose
    // cleanly. No-ops when contentReplacementState is undefined (feature off).
    // Persist only for querySources that read records back on resume: agentId
    // routes to sidechain file (AgentTool resume) or session file (/resume).
    // Ephemeral runForkedAgent callers (agent_summary etc.) don't persist.
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // Apply snip before microcompact (both may run — they are not mutually exclusive).
    // snipTokensFreed is plumbed to autocompact so its threshold check reflects
    // what snip removed; tokenCountWithEstimation alone can't see it (reads usage
    // from the protected-tail assistant, which survives snip unchanged).
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage
      }
      queryCheckpoint('query_snip_end')
    }

    // Apply microcompact before autocompact
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // For cached microcompact (cache editing), defer boundary message until after
    // the API response so we can use actual cache_deleted_input_tokens.
    // Gated behind feature() so the string is eliminated from external builds.
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // Project the collapsed context view and maybe commit more collapses.
    // Runs BEFORE autocompact so that if collapse gets us under the
    // autocompact threshold, autocompact is a no-op and we keep granular
    // context instead of a single summary.
    //
    // Nothing is yielded — the collapsed view is a read-time projection
    // over the REPL's full history. Summary messages live in the collapse
    // store, not the REPL array. This is what makes collapses persist
    // across turns: projectView() replays the commit log on every entry.
    // Within a turn, the view flows forward via state.messages at the
    // continue site (query.ts:1192), and the next projectView() no-ops
    // because the archived messages are already gone from its input.
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // task_budget: capture pre-compact final context window before
      // messagesForQuery is replaced with postCompactMessages below.
      // iterations[-1] is the authoritative final window (post server tool
      // loops); see #304930.
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // Reset on every compact so turnCounter/turnId reflect the MOST RECENT
      // compact. recompactionInfo (autoCompact.ts:190) already captured the
      // old values for turnsSincePreviousCompact/previousCompactTurnId before
      // the call, so this reset doesn't lose those.
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      for (const message of postCompactMessages) {
        yield message
      }

      // Continue on with the current query call using the post compact messages
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // Autocompact failed — propagate failure count so the circuit breaker
      // can stop retrying on the next iteration.
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    //TODO: no need to set toolUseContext.messages during set-up since it is updated here
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // 下面这两个变量是**整个循环的开关**，理解它们就理解了循环何时继续：
    //   toolUseBlocks  —— 本轮模型要求使用的所有工具
    //   needsFollowUp  —— 只要上面的数组非空就为 true，是唯一的"继续下一轮"信号
    //                     一旦为 false，模型就是直接给答案了，走到阶段 5 收尾。
    //
    // 为什么不直接用 API 返回的 stop_reason === 'tool_use' 来判断？
    // 见下面一行 —— 那个字段在流式场景下并不总是可靠。
    // @see https://docs.claude.com/en/docs/build-with-claude/tool-use
    // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly.
    // Set during streaming whenever a tool_use block arrives — the sole
    // loop-exit signal. If false after streaming, we're done (modulo stop-hook retry).
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // Create fetch wrapper once per query session to avoid memory retention.
    // Each call to createDumpPromptsFetch creates a closure that captures the request body.
    // Creating it once means only the latest request body is retained (~700KB),
    // instead of all request bodies from the session (~500MB for long sessions).
    // Note: agentId is effectively constant during a query() call - it only changes
    // between queries (e.g., /clear command or session resume).
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // Block if we've hit the hard blocking limit (only applies when auto-compact is OFF)
    // This reserves space so users can still run /compact manually
    // Skip this check if compaction just happened - the compaction result is already
    // validated to be under the threshold, and tokenCountWithEstimation would use
    // stale input_tokens from kept messages that reflect pre-compaction context size.
    // Same staleness applies to snip: subtract snipTokensFreed (otherwise we'd
    // falsely block in the window where snip brought us under autocompact threshold
    // but the stale usage is still above blocking limit — before this PR that
    // window never existed because autocompact always fired on the stale count).
    // Also skip for compact/session_memory queries — these are forked agents that
    // inherit the full conversation and would deadlock if blocked here (the compact
    // agent needs to run to REDUCE the token count).
    // Also skip when reactive compact is enabled and automatic compaction is
    // allowed — the preempt's synthetic error returns before the API call,
    // so reactive compact would never see a prompt-too-long to react to.
    // Widened to walrus so RC can act as fallback when proactive fails.
    //
    // Same skip for context-collapse: its recoverFromOverflow drains
    // staged collapses on a REAL API 413, then falls through to
    // reactiveCompact. A synthetic preempt here would return before the
    // API call and starve both recovery paths. The isAutoCompactEnabled()
    // conjunct preserves the user's explicit "no automatic anything"
    // config — if they set DISABLE_AUTO_COMPACT, they get the preempt.
    // ▼▼▼ 阶段 2：硬阻断检查（上下文撑爆且自动压缩被关掉时，直接报错退出）▼▼▼
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) &&
        isAutoCompactEnabled()
    }
    // Hoist media-recovery gate once per turn. Withholding (inside the
    // stream loop) and recovery (after) must agree; CACHED_MAY_BE_STALE can
    // flip during the 5-30s stream, and withhold-without-recover would eat
    // the message. PTL doesn't hoist because its withholding is ungated —
    // it predates the experiment and is already the control-arm baseline.
    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    // ▼▼▼ 阶段 3：调用模型 + 流式消费（★ 本文件最核心的一段）▼▼▼
    // 外层 while 是为了 fallback 重试准备的：主模型挂了就切成 fallbackModel 再跑一遍。
    let attemptWithFallback = true

    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          // ★★ 整个文件最核心的一行 ★★
          // deps.callModel(...) 返回一个异步生成器，每收到模型的一小块输出就产出一个 message。
          // `for await` 会逐个 await 它 —— 这就实现了"流式"：
          //   UI 那边每拿到一个 message 就能立刻渲染，不用等模型全部说完。
          //
          // Java 视角：≈ Flux<Message>.subscribe(...)，但写成了同步风格的 for 循环，
          //            既好读又不会 callback hell。这是 async/await 最大的价值。
          //
          // 注意这个 for 循环体内做了 5 件事（下面按顺序排列）：
          //   ① fallback 发生时，先把上一批半成品作废（tombstone 墓碑消息）
          //   ② 回填 tool_use 的 input 字段（为了 transcript 序列化，但要克隆，
          //      改原对象会破坏 prompt caching 的字节比对）
          //   ③ 判断这条错误要不要"扣住不往外抛"（可恢复的错误先扣着）
          //   ④ 收集 tool_use 块，有就置 needsFollowUp = true
          //   ⑤ 把流式执行器已完成的工具结果也 yield 出去
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
          })) {
            // We won't use the tool_calls from the first attempt
            // We could.. but then we'd have to merge assistant messages
            // with different ids and double up on full the tool_results
            if (streamingFallbackOccured) {
              // Yield tombstones for orphaned messages so they're removed from UI and transcript.
              // These partial messages (especially thinking blocks) have invalid signatures
              // that would cause "thinking blocks cannot be modified" API errors.
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('tengu_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // Discard pending results from the failed streaming attempt and create
              // a fresh executor. This prevents orphan tool_results (with old tool_use_ids)
              // from being yielded after the fallback response arrives.
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // Backfill tool_use inputs on a cloned message before yield so
            // SDK stream output and transcript serialization see legacy/derived
            // fields. The original `message` is left untouched for
            // assistantMessages.push below — it flows back to the API and
            // mutating it would break prompt caching (byte mismatch).
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              let clonedContent: typeof message.message.content | undefined
              for (let i = 0; i < message.message.content.length; i++) {
                const block = message.message.content[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // Only yield a clone when backfill ADDED fields; skip if
                    // it only OVERWROTE existing ones (e.g. file tools
                    // expanding file_path). Overwrites change the serialized
                    // transcript and break VCR fixture hashes on resume,
                    // while adding nothing the SDK stream needs — hooks get
                    // the expanded path via toolExecution.ts separately.
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...message.message.content]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...message.message, content: clonedContent },
                }
              }
            }
            // Withhold recoverable errors (prompt-too-long, max-output-tokens)
            // until we know whether recovery (collapse drain / reactive
            // compact / truncation retry) can succeed. Still pushed to
            // assistantMessages so the recovery checks below find them.
            // Either subsystem's withhold is sufficient — they're
            // independent so turning one off doesn't break the other's
            // recovery path.
            //
            // feature() only works in if/ternary conditions (bun:bundle
            // tree-shaking constraint), so the collapse check is nested
            // rather than composed.
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message,
                  isPromptTooLongMessage,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              assistantMessages.push(message)

              const msgToolUseBlocks = message.message.content.filter(
                content => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, message)
                }
              }
            }

            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')

          // Yield deferred microcompact boundary message using actual API-reported
          // token deletion count instead of client-side estimates.
          // Entire block gated behind feature() so the excluded string
          // is eliminated from external builds.
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // The API field is cumulative/sticky across requests, so we
            // subtract the baseline captured before this request to get the delta.
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // Fallback was triggered - switch model and retry
            currentModel = fallbackModel
            attemptWithFallback = true

            // Clear assistant messages since we'll retry the entire request
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // Discard pending results from the failed attempt and create a
            // fresh executor. This prevents orphan tool_results (with old
            // tool_use_ids) from leaking into the retry.
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // Update tool use context with new model
            toolUseContext.options.mainLoopModel = fallbackModel

            // Thinking signatures are model-bound: replaying a protected-thinking
            // block (e.g. capybara) to an unprotected fallback (e.g. opus) 400s.
            // Strip before retry so the fallback model gets clean history.
            if (process.env.USER_TYPE === 'ant') {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            // Log the fallback event
            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // Yield system message about fallback — use 'warning' level so
            // users see the notification without needing verbose mode
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('tengu_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          _.message.content.filter(content => content.type === 'tool_use'),
        ).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // Handle image size/resize errors with user-friendly messages
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // Generally queryModelWithStreaming should not throw errors but instead
      // yield them as synthetic assistant messages. However if it does throw
      // due to a bug, we may end up in a state where we have already emitted
      // a tool_use block but will stop before emitting the tool_result.
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // Surface the real error instead of a misleading "[Request interrupted
      // by user]" — this path is a model/runtime failure, not a user action.
      // SDK consumers were seeing phantom interrupts on e.g. Node 18's missing
      // Array.prototype.with(), masking the actual cause.
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // To help track down bugs, log loudly for ants
      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }

    // Execute post-sampling hooks after model response is complete
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // ▼▼▼ 阶段 4：流式中断处理（用户在模型吐字过程中按了 Ctrl+C）▼▼▼
    // We need to handle a streaming abort before anything else.
    // When using streamingToolExecutor, we must consume getRemainingResults() so the
    // executor can generate synthetic tool_result blocks for queued/in-progress tools.
    // Without this, tool_use blocks would lack matching tool_result blocks.
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // Consume remaining results - executor generates synthetic tool_results for
        // aborted tools since it checks the abort signal in executeTool()
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }
      // chicago MCP: auto-unhide + lock release on interrupt. Same cleanup
      // as the natural turn-end path in stopHooks.ts. Main thread only —
      // see stopHooks.ts for the subagent-releasing-main's-lock rationale.
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // Failures are silent — this is dogfooding cleanup, not critical path
        }
      }

      // Skip the interruption message for submit-interrupts — the queued
      // user message that follows provides sufficient context.
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // Yield tool use summary from previous turn — haiku (~1s) resolved during model streaming (5-30s)
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    // ▼▼▼ 阶段 5：收尾（模型没有再要工具 → 本轮该结束了）▼▼▼
    // 但"该结束"不等于"直接结束"：还要先尝试从各种可恢复的错误中捞回来。
    if (!needsFollowUp) {
      // 语法点：`.at(-1)` 取数组最后一个元素（支持负索引）。
      // Java 里要写 list.get(list.size()-1)，且空列表会抛异常；
      // 这里空数组返回 undefined，所以后面到处是 `?.` 可选链。
      const lastMessage = assistantMessages.at(-1)

      // Prompt-too-long recovery: the streaming loop withheld the error
      // (see withheldByCollapse / withheldByReactive above). Try collapse
      // drain first (cheap, keeps granular context), then reactive compact
      // (full summary). Single-shot on each — if a retry still 413's,
      // the next stage handles it or the error surfaces.
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // Media-size rejections (image/PDF/many-image) are recoverable via
      // reactive compact's strip-retry. Unlike PTL, media errors skip the
      // collapse drain — collapse doesn't strip images. mediaRecoveryEnabled
      // is the hoisted gate from before the stream loop (same value as the
      // withholding check — these two must agree or a withheld message is
      // lost). If the oversized media is in the preserved tail, the
      // post-compact turn will media-error again; hasAttemptedReactiveCompact
      // prevents a spiral and the error surfaces.
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // First: drain all staged context-collapses. Gated on the PREVIOUS
        // transition not being collapse_drain_retry — if we already drained
        // and the retry still 413'd, fall through to reactive compact.
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // task_budget: same carryover as the proactive path above.
          // messagesForQuery still holds the pre-compact array here (the
          // 413-failed attempt's input).
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // No recovery — surface the withheld error and exit. Do NOT fall
        // through to stop hooks: the model never produced a valid response,
        // so hooks have nothing meaningful to evaluate. Running stop hooks
        // on prompt-too-long creates a death spiral: error → hook blocking
        // → retry → error → … (the hook injects more tokens each cycle).
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // reactiveCompact compiled out but contextCollapse withheld and
        // couldn't recover (staged queue empty/stale). Surface. Same
        // early-return rationale — don't fall through to stop hooks.
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      // Check for max_output_tokens and inject recovery message. The error
      // was withheld from the stream above; only surface it if recovery
      // exhausts.
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // Escalating retry: if we used the capped 8k default and hit the
        // limit, retry the SAME request at 64k — no meta message, no
        // multi-turn dance. This fires once per turn (guarded by the
        // override check), then falls through to multi-turn recovery if
        // 64k also hits the cap.
        // 3P default: false (not validated on Bedrock/Vertex)
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // Recovery exhausted — surface the withheld error now.
        yield lastMessage
      }

      // Skip stop hooks when the last message is an API error (rate limit,
      // prompt-too-long, auth failure, etc.). The model never produced a
      // real response — hooks evaluating it create a death spiral:
      // error → hook blocking → retry → error → …
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // Preserve the reactive compact guard — if compact already ran and
          // couldn't recover from prompt-too-long, retrying after a stop-hook
          // blocking error will produce the same result. Resetting to false
          // here caused an infinite loop: compact → still too long → error →
          // stop hook blocking → compact → … burning thousands of API calls.
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('tengu_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')


    if (streamingToolExecutor) {
      logEvent('tengu_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('tengu_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // ▼▼▼ 阶段 6：执行工具（模型要求用工具 → 真正去干活）▼▼▼
    // 两条路径：
    //   · streamingToolExecutor —— 「边流式收边执行」，模型还没吐完就开始跑工具，省时间
    //   · runTools              —— 传统路径，等模型说完再统一执行
    // 两者产出的都是异步生成器，所以下面统一用 for await 消费，调用方无需区分。
    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    // 逐个等待工具执行结果。每拿到一个就立刻 yield 出去给 UI 渲染，
    // 用户因此能看到工具一个接一个完成，而不是全部跑完才一起显示。
    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // Generate tool use summary after tool batch completes — passed to next recursive call
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // subagents don't surface in mobile UI — skip the Haiku call
    ) {
      // Extract the last assistant text block for context
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = lastAssistantMessage.message.content.filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // Collect tool info for summary generation
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // Find the corresponding tool result
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // Fire off summary generation without blocking the next API call
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // ▼▼▼ 阶段 7：工具执行期间的中断 / 防继续检查 ▼▼▼
    // We were aborted during tool calls
    if (toolUseContext.abortController.signal.aborted) {
      // chicago MCP: auto-unhide + lock release when aborted mid-tool-call.
      // This is the most likely Ctrl+C path for CU (e.g. slow screenshot).
      // Main thread only — see stopHooks.ts for the subagent rationale.
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // Failures are silent — this is dogfooding cleanup, not critical path
        }
      }
      // Skip the interruption message for submit-interrupts — the queued
      // user message that follows provides sufficient context.
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // Check maxTurns before returning when aborted
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    // If a hook indicated to prevent continuation, stop here
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('tengu_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // Be careful to do this after tool calls are done, because the API
    // will error if we interleave tool_result messages with regular user messages.

    // Instrumentation: Track message count before attachments
    logEvent('tengu_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // Get queued commands snapshot before processing attachments.
    // These will be sent as attachments so Claude can respond to them in the current turn.
    //
    // Drain pending notifications. LocalShellTask completions are 'next'
    // (when MONITOR_TOOL is on) and drain without Sleep. Other task types
    // (agent/workflow/framework) still default to 'later' — the Sleep flush
    // covers those. If all task types move to 'next', this branch could go.
    //
    // Slash commands are excluded from mid-turn drain — they must go through
    // processSlashCommand after the turn ends (via useQueueProcessor), not be
    // sent to the model as text. Bash-mode commands are already excluded by
    // INLINE_NOTIFICATION_MODES in getQueuedCommandAttachments.
    //
    // Agent scoping: the queue is a process-global singleton shared by the
    // coordinator and all in-process subagents. Each loop drains only what's
    // addressed to it — main thread drains agentId===undefined, subagents
    // drain their own agentId. User prompts (mode:'prompt') still go to main
    // only; subagents never see the prompt stream.
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // Subagents only drain task-notifications addressed to them — never
      // user prompts, even if someone stamps an agentId on one.
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    // ▼▼▼ 阶段 8：附件注入（把排队消息/任务通知/记忆/技能建议塞进下一轮上下文）▼▼▼
    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // Memory prefetch consume: only if settled and not already consumed on
    // an earlier iteration. If not settled yet, skip (zero-wait) and retry
    // next iteration — the prefetch gets as many chances as there are loop
    // iterations before the turn ends. readFileState (cumulative across
    // iterations) filters out memories the model already Read/Wrote/Edited
    // — including in earlier iterations, which the per-iteration
    // toolUseBlocks array would miss.
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }


    // Inject prefetched skill discovery. collectSkillDiscoveryPrefetch emits
    // hidden_by_main_turn — true when the prefetch resolved before this point
    // (should be >98% at AKI@250ms / Haiku@573ms vs turn durations of 2-30s).
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // Remove only commands that were actually consumed as attachments.
    // Prompt and task-notification commands are converted to attachments above.
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // Instrumentation: Track file change attachments after they're added
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('tengu_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // Refresh tools between turns so newly-connected MCP servers become available
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // Each time we have tool results and are about to recurse, that's a turn
    const nextTurnCount = turnCount + 1

    // Periodic task summary for `claude ps` — fires mid-turn so a
    // long-running agent still refreshes what it's working on. Gated
    // only on !agentId so every top-level conversation (REPL, SDK, HFI,
    // remote) generates summaries; subagents/forks don't.
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
          ],
        })
      }
    }

    // Check if we've reached the max turns limit
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    // ▼▼▼ 阶段 9：装配下一轮的状态，continue 回到循环顶部 ▼▼▼
    // messages = 之前的历史 + 本轮模型的回复 + 本轮工具的结果
    // 这个拼接顺序不能乱：API 要求 assistant(tool_use) 后面必须紧跟 user(tool_result)。
    queryCheckpoint('query_recursive_call')
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
