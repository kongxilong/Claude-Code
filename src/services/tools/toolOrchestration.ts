/**
 * 【一句话定位】工具调用的【调度器】：把模型一次性点名的多个工具切成批次，
 * 只读类（并发安全）的一批并行跑，有副作用的串行跑，并把结果以流的方式按序吐出。
 *
 * 【在架构中的位置】
 *   上游：src/query.ts / QueryEngine.ts —— 主循环在收到模型响应后调用 runTools() 批量执行工具
 *   下游：./toolExecution.ts（runToolUse，单个工具的完整执行管线）、../../utils/generators.js（all，并发限流）
 *   调用链：
 *     模型返回 N 个 tool_use 块
 *       → runTools() → partitionToolCalls() 切成若干批次（每批要么全是并发安全的，要么是单独一个非安全工具）
 *       → 并发批次交给 runToolsConcurrently（受最大并发数限制）
 *       → 串行批次交给 runToolsSerially（一个跑完再下一个）
 *       → 两者最终都调用 runToolUse（真正的执行管线在 toolExecution.ts）
 *       → 产出的消息逐条 yield 给主循环，主循环收进 messages 后进入下一轮
 *
 * 【本文件包含什么】
 *   runTools()             —— 对外主入口（异步生成器）：分批调度并逐条产出消息
 *   partitionToolCalls()   —— 把工具调用切成批次（核心调度策略）
 *   runToolsConcurrently() —— 并发执行一批（带最大并发限制）
 *   runToolsSerially()     —— 串行执行一批
 *   getMaxToolUseConcurrency() —— 读环境变量得到最大并发数（默认 10）
 *   markToolUseAsComplete()    —— 执行完把 ID 从「进行中」集合里摘掉
 *   MessageUpdate / Batch —— 两个类型
 *
 * 【为什么要分批而不是一刀切并发】
 *   好处：连续的只读调用（如一次读 5 个文件）可以真正并行，显著缩短等待时间；
 *   风险：写操作如果并行会出现「读-改-写」竞态、覆盖别人的结果。
 *   折中：只有【连续】的并发安全工具才合成一批；一旦遇到非安全工具就单独成批、独占执行。
 *
 * 【TS 语法速查】
 *   1. 【异步生成器】`async function* f(...): AsyncGenerator<T, void>` + `yield`：
 *      ≈ Java 的 Flux<T>：调用方用 `for await (const x of f())` 边产出边消费。
 *   2. `yield* g()` 是【生成器委托】：把另一个生成器的所有元素原样转发出来，
 *      相当于把 g 的产出「内联」到当前流里（本文件用它把 runToolUse 的产出接上来）。
 *   3. `for await (...)` ≈ 逐个订阅并 await，是消费异步流的标准写法。
 *   4. 立即执行函数 `(() => { ... })()` —— 定义一个箭头函数并马上调用，
 *      用于在表达式位置写多语句逻辑（这里是为了把 isConcurrencySafe 包进 try/catch）。
 *   5. `tool?.inputSchema.safeParse(x)`：可选链，tool 为 undefined 时整段为 undefined。
 *      safeParse 返回 { success: true, data } 或 { success: false, error }，不抛异常（zod 的风格）。
 *   6. `parsedInput?.success ? A : false`：三元表达式 ≈ Java 的 `cond ? A : B`。
 *   7. `acc[acc.length - 1]!` 的 `!` 是非空断言：向编译器担保这个元素一定存在。
 *   8. `reduce((acc, x) => {...}, [])` ≈ Java Stream.reduce：把数组归纳成一个值（这里归纳成批次数组）。
 *   9. `async function* (toolUse) {...}` 作为 map 的回调——它是一个异步生成器函数，
 *      map 之后得到的是「一组异步生成器」，再交给 all() 统一并发驱动。
 *  10. `new Set(prev)` 是 Set 的拷贝构造：不可变地「加一个元素」（先复制再改，不动原集合）。
 *  11. `parseInt(x, 10) || 10`：`||` 在这里当「NaN 或 0 时取默认」用（NaN 是 falsy）。
 *      注意与 ?? 的区别：?? 只在 null/undefined 时替换，NaN 不会被替换。
 */
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { all } from '../../utils/generators.js'
import { type MessageUpdateLazy, runToolUse } from './toolExecution.js'

/** 读环境变量 CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY 得到最大并发数，没配或配错就用 10。 */
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}

// 每次 yield 的内容：可选的新消息 + 【当前】上下文。
// 为什么要带上 newContext：工具的 contextModifier 可能改了上下文（如切换模型/权限模式），
// 主循环需要同步拿到最新的那一份。
export type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

/** 【对外主入口】批量执行模型点名的工具调用，逐条产出执行过程中产生的消息。
 *  入参：
 *    toolUseMessages  本次要执行的 tool_use 块列表（按模型输出顺序）
 *    assistantMessages 相关的 assistant 消息列表（每个工具要找回触发它的那条消息）
 *    canUseTool      权限判定回调
 *    toolUseContext  运行时上下文（可能被工具的 contextModifier 修改）
 *  返回 AsyncGenerator<MessageUpdate, void>：逐条产出消息与最新上下文
 *  步骤：
 *    ① partitionToolCalls 把工具切成批次（连续并发安全的一批；非并发安全的各成一批）
 *    ② 并发批次：交给 runToolsConcurrently，边跑边把消息 yield 出去；
 *       注意【上下文修改要延后】——并发期间不允许改上下文（多个工具同时改会打架），
 *       所以先收集起来，整批跑完后按工具顺序依次应用，最后再 yield 一次新上下文
 *    ③ 串行批次：交给 runToolsSerially，每条更新里的新上下文立刻生效并继续往下传
 *  顺序保证：批次严格按模型输出的顺序推进，所以消息顺序与工具调用顺序一致（API 与 UI 都依赖这一点）。
 */
export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(
    toolUseMessages,
    currentContext,
  )) {
// 批次是严格按顺序推进的：上一批完全结束后才会进入下一批。
    if (isConcurrencySafe) {
      const queuedContextModifiers: Record<
        string,
        ((context: ToolUseContext) => ToolUseContext)[]
      > = {}
// 并发批次的上下文修改要【先攒着】：并发期间改上下文会让并行中的工具看到不一致的状态。
      // Run read-only batch concurrently
// 只读批次：全部一起并发跑（内部还有最大并发数限制）。
      for await (const update of runToolsConcurrently(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.contextModifier) {
          const { toolUseID, modifyContext } = update.contextModifier
          if (!queuedContextModifiers[toolUseID]) {
            queuedContextModifiers[toolUseID] = []
          }
          queuedContextModifiers[toolUseID].push(modifyContext)
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
      for (const block of blocks) {
// 整批跑完后，按【工具被调用的顺序】依次应用攒下来的上下文修改——保证结果与串行执行等价。
        const modifiers = queuedContextModifiers[block.id]
        if (!modifiers) {
          continue
        }
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext)
        }
      }
      yield { newContext: currentContext }
    } else {
      // Run non-read-only batch serially
// 非并发批次：严格串行，前一个工具的上下文修改立刻对下一个工具生效。
      for await (const update of runToolsSerially(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.newContext) {
          currentContext = update.newContext
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
    }
  }
}

// 批次：isConcurrencySafe=true 表示这一批可以并行；false 表示必须独占（通常只有一个元素）。
type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-read-only tool, or
 * 2. Multiple consecutive read-only tools
 */
/** 【调度策略的核心】把一串工具调用切成批次。
 *  规则：
 *    · 连续的「并发安全」工具合并成一个批次（可并行）
 *    · 一旦出现非并发安全工具，它单独成批（独占执行）
 *  为什么要「连续」：顺序是有意义的——模型先读文件、再改文件、再读文件，
 *  如果把第二个读和第一个读合并成一批并行，就会越过中间的写操作，读到旧内容。
 *  判定细节：先用 zod 解析入参（解析失败就按「不安全」处理，保守优先）；
 *  再调用工具的 isConcurrencySafe()，并用 try/catch 包住——
 *  万一它因为入参里的怪异内容（如 shell 引号解析失败）抛异常，也按不安全处理。
 *  这就是 fail-closed：拿不准就串行，慢一点没关系，出错才可怕。
 */
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            // If isConcurrencySafe throws (e.g., due to shell-quote parse failure),
            // treat as not concurrency-safe to be conservative
            return false
          }
// 用 try/catch 包住 isConcurrencySafe：某些工具解析入参时可能抛异常（如 shell 引号解析失败），
// 此时按「不并发安全」处理——宁可串行慢一点，也不能让有副作用的工具并发跑。
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}

/** 串行执行一批工具：一个跑完再跑下一个，并把上下文修改及时传递下去。
 *  步骤：① 把工具 ID 加进「进行中」集合（UI 显示 spinner）
 *       ② 找到触发它的那条 assistant 消息 → 调 runToolUse
 *       ③ 每收到一条更新就应用其中的 contextModifier 并 yield
 *       ④ 跑完把 ID 从「进行中」集合摘掉
 *  注意并发安全工具虽然也可能走这里（当它无法与邻居合批时），但语义一致：逐个执行。
 */
async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
// 登记「这个 tool_use 正在执行」：UI 据此显示 spinner 与「可中断」提示。
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    )
    for await (const update of runToolUse(
      toolUse,
      assistantMessages.find(_ =>
        _.message.content.some(
          _ => _.type === 'tool_use' && _.id === toolUse.id,
        ),
      )!,
// 末尾的 `!` 是非空断言：assistantMessages 里一定能找到包含该 tool_use 的那条消息，
// 由开发者向编译器担保（如果找不到就会是运行时错误，这是有意为之的「不该发生」假设）。
      canUseTool,
      currentContext,
    )) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext)
      }
      yield {
        message: update.message,
        newContext: currentContext,
      }
    }
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}

/** 并发执行一批工具。
 *  做法：把每个工具包成一个异步生成器，交给 all() 统一驱动；
 *  all() 会把它们的结果【交织】成一条流，并且最多只允许 N 个同时跑（N = getMaxToolUseConcurrency()）。
 *  `yield* all(...)` 的 yield* 表示「把 all 产出的每一条原样转发给我的调用方」。
 *  注意：并发模式下【不处理】contextModifier（收集与应用在调用方 runTools 里做）——
 *  因为并发时立刻应用会破坏一致性。
 */
async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
// all(...generators, maxConcurrency)：并发驱动多个异步生成器，但同时在跑的最多 N 个，
// 并把它们的产出合并成一条交错流（谁先完成谁先出）。
    toolUseMessages.map(async function* (toolUse) {
      toolUseContext.setInProgressToolUseIDs(prev =>
        new Set(prev).add(toolUse.id),
      )
      yield* runToolUse(
        toolUse,
        assistantMessages.find(_ =>
          _.message.content.some(
            _ => _.type === 'tool_use' && _.id === toolUse.id,
          ),
        )!,
        canUseTool,
        toolUseContext,
      )
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),
  )
}

/** 把一个工具从「进行中」集合里移除。注意用 new Set(prev) 拷贝后再删——不可变更新，不直接改原集合。 */
function markToolUseAsComplete(
  toolUseContext: ToolUseContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
