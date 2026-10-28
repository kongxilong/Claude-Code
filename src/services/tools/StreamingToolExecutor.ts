/**
 * 【一句话定位】流式工具执行器：模型【还没说完】就开始执行它已经吐出来的工具调用，
 * 同时管理并发、保序、错误级联与中断。
 *
 * 【在架构中的位置】
 *   上游：src/query.ts（当 tengu_streaming_tool_execution2 开关打开时，主循环用本类替代 runTools 的批量模式）
 *   下游：./toolExecution.ts（runToolUse，单个工具的完整执行管线）、../../utils/abortController.js
 *   调用链：
 *     流式响应 → 每收到一个完整的 tool_use → addTool(block, assistantMessage)
 *       → 立即判断能否开跑（并发规则）→ 能就 executeTool 起一个 Promise
 *       → 主循环周期性调 getCompletedResults() / getRemainingResults() 取回已完成的消息
 *       → 消息按【工具到达顺序】有序吐出（即便完成顺序是乱的）
 *
 * 【为什么能在模型还没说完时就开始执行】（这是本文件存在的理由）
 *   传统（批量）模式要等整条响应结束（message_stop），收集全部 tool_use 后统一执行。
 *   但实际上：模型是【逐块流式输出】的，一个 tool_use 块的参数一收全（input_json_delta 累积完毕），
 *   这个工具就已经可以执行了——没必要等后面的块、更没必要等整条消息结束。
 *   于是主循环每确认一个完整 tool_use 就调 addTool()，本类立刻判定并发条件并启动执行，
 *   后面还在生成的工具则继续排队。这样把「模型输出」与「工具执行」两条时间轴重叠起来，
 *   对「先读 5 个文件再说」这类场景能省下可观的等待。
 *   代价是复杂度：结果必须【缓冲并按到达顺序】吐出（见 getCompletedResults 的保序逻辑），
 *   因为 API 与 UI 都要求 tool_result 的顺序与 tool_use 的顺序对应。
 *
 * 【并发规则】
 *   · 并发安全（只读）工具：可以和其它并发安全工具同时跑
 *   · 非并发安全（有副作用）工具：必须独占——没有任何工具在跑时才能开始
 *   · 顺序敏感：遇到还没轮到的非并发安全工具就停下（break），保证前面的先跑完
 *
 * 【本文件包含什么】
 *   StreamingToolExecutor 类：
 *     addTool()               —— 收到一个 tool_use 就登记（并尝试立刻开跑）
 *     discard()               —— 流式回退时丢弃全部结果
 *     getCompletedResults()   —— 【同步】取出已完成的结果与进度消息（保序）
 *     getRemainingResults()   —— 【异步】边等边取，直到全部完成
 *     getUpdatedContext()     —— 取可能被 contextModifier 改过的上下文
 *     processQueue / canExecuteTool / executeTool —— 内部的排队与执行
 *     createSyntheticErrorMessage / getAbortReason —— 取消/回退时造合成错误结果
 *     getToolInterruptBehavior / updateInterruptibleState —— 中断语义与 UI 状态
 *   TrackedTool —— 被跟踪的工具：状态机 queued → executing → completed → yielded
 *
 * 【TS 语法速查】
 *   1. 【class 与访问修饰符】`private tools: TrackedTool[] = []`：private ≈ Java 的 private 字段；
 *      `private readonly x` ≈ private final（构造后不能再赋值）。
 *   2. 【构造参数属性】`constructor(private readonly toolDefinitions: Tools, ...)`：
 *      在构造参数前加 private readonly，TS 会自动把它变成同名字段并赋值——
 *      省掉「声明字段 + 构造函数里赋值」两行样板（Java 没有这个语法糖）。
 *   3. 【同步生成器】`*getCompletedResults(): Generator<T, void>`：方法名前加 *，用 yield 产出，
 *      调用方用普通 for...of（不是 for await）消费。
 *   4. 【异步生成器方法】`async *getRemainingResults(): AsyncGenerator<T, void>`：
 *      既能 await 又能 yield，调用方用 for await 消费。
 *   5. `void promise` 表示「故意不 await」：触发后立刻往下走（fire-and-forget）。
 *      本文件用它启动队列处理与「跑完后继续处理队列」的回调，避免阻塞当前流程。
 *   6. `promise.finally(() => {...})` ≈ Java 的 whenComplete：无论成功失败都执行。
 *   7. `Promise.race([...ps])` ≈ CompletableFuture.anyOf：谁先完成就先返回谁。
 *      本文件用它实现「要么某个工具跑完、要么有新进度消息」就醒过来。
 *   8. `new Promise<void>(resolve => { this.progressAvailableResolve = resolve })`：
 *      手工造一个「将来某个时刻由别人 resolve」的 Promise——相当于一个一次性唤醒信号（≈ CountDownLatch(1)）。
 *   9. `tool.promise!` 与 `arr.shift()!` 的 `!` 是非空断言：向编译器担保不是 undefined。
 *  10. `input?.command ?? input?.file_path ?? input?.pattern ?? ''`：?? 链，依次取第一个非 null/undefined 的值。
 *  11. `status: 'queued' | 'executing' | 'completed' | 'yielded'` 是字面量联合类型 ≈ enum，但编译后就是字符串。
 *  12. `Array<(c: ToolUseContext) => ToolUseContext>` 是「函数数组」类型 ≈ Java 的 List<UnaryOperator<Ctx>>。
 *  13. `this.toolUseContext.setXxx?.()` 可选调用：该回调在非交互环境下可能不存在。
 *  14. `signal.addEventListener('abort', fn, { once: true })` ≈ Java 给 Future 加一次性取消回调。
 */
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  createUserMessage,
  REJECT_MESSAGE,
  withMemoryCorrectionHint,
} from 'src/utils/messages.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type Tools, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { runToolUse } from './toolExecution.js'

// 每吐出一条：可选的消息 + 可选的新上下文（流式模式下上下文可能还没变，所以是可选的）。
type MessageUpdate = {
  message?: Message
  newContext?: ToolUseContext
}

// 单个被跟踪工具的状态机：
//   queued    已收到、还没开始（可能在等并发条件）
//   executing 正在跑
//   completed 跑完了、结果已缓冲
//   yielded   结果已经吐给主循环了（终态）
type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

// 一条被跟踪的工具调用。注意 pendingProgress 单独存放：
// 进度消息要【立刻】吐出去（用户想实时看到输出），而结果消息必须【按序】吐出，两者节奏不同。
type TrackedTool = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: Message[]
  // Progress messages are stored separately and yielded immediately
  pendingProgress: Message[]
  contextModifiers?: Array<(context: ToolUseContext) => ToolUseContext>
}

/**
 * Executes tools as they stream in with concurrency control.
 * - Concurrent-safe tools can execute in parallel with other concurrent-safe tools
 * - Non-concurrent tools must execute alone (exclusive access)
 * - Results are buffered and emitted in the order tools were received
 */
/** 流式工具执行器（上面英文注释三行就是它的并发契约）：
 *    · 并发安全工具可以彼此并行
 *    · 非并发安全工具必须独占执行
 *    · 结果被缓冲，并按【工具到达的顺序】吐出
 *  「边收边跑 + 按序输出」这两件事合起来，就是它能提前开工又不打乱顺序的关键。
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private hasErrored = false
  private erroredToolDescription = ''
  // Child of toolUseContext.abortController. Fires when a Bash tool errors
  // so sibling subprocesses die immediately instead of running to completion.
  // Aborting this does NOT abort the parent — query.ts won't end the turn.
  private siblingAbortController: AbortController
// siblingAbortController 是主 abortController 的【子控制器】：
// 当某个 Bash 工具出错时，用它把并行的兄弟子进程立刻杀掉（Bash 的子进程监听这个信号）。
// 关键：abort 它【不会】波及父控制器，也就是不会因此结束整个回合——
// 只是让那些已经没意义的并行命令停下来。
  private discarded = false
  // Signal to wake up getRemainingResults when progress is available
  private progressAvailableResolve?: () => void

/** 构造时创建一个子 abort 控制器（用于「兄弟工具出错时互相叫停」，见字段注释）。 */
  constructor(
    private readonly toolDefinitions: Tools,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) {
    this.toolUseContext = toolUseContext
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController,
    )
  }

  /**
   * Discards all pending and in-progress tools. Called when streaming fallback
   * occurs and results from the failed attempt should be abandoned.
   * Queued tools won't start, and in-progress tools will receive synthetic errors.
   */
/** 丢弃全部结果：流式【回退】（fallback）时用。
 *  背景：流式执行中途如果响应失败需要整体重试，这一轮已经跑出来的结果就作废了。
 *  置 discarded 后：还没开始的不再开始，正在跑的会收到合成错误结果。
 */
  discard(): void {
    this.discarded = true
  }

  /**
   * Add a tool to the execution queue. Will start executing immediately if conditions allow.
   */
/** 【流式入口】收到一个完整的 tool_use 就登记进来，并尝试立刻开跑。
 *  入参 block：tool_use 块；assistantMessage：触发它的 assistant 消息
 *  步骤：
 *    ① 找不到工具 → 直接塞一个「没有这个工具」的错误结果，标记为已完成（不必真跑）
 *    ② 用 zod 解析入参 → 调 isConcurrencySafe 判断能否并发（异常一律按不可并发处理）
 *    ③ 以 queued 状态入队
 *    ④ 触发 processQueue（不 await，让它异步去调度）
 *  这一步【非常轻量、不阻塞】，所以模型继续往下输出时这边已经在跑了——
 *  这就是「模型还没说完就开始执行工具」的具体实现点。
 */
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
    const toolDefinition = findToolByName(this.toolDefinitions, block.name)
    if (!toolDefinition) {
      this.tools.push({
        id: block.id,
        block,
        assistantMessage,
        status: 'completed',
        isConcurrencySafe: true,
        pendingProgress: [],
        results: [
          createUserMessage({
            content: [
              {
                type: 'tool_result',
                content: `<tool_use_error>Error: No such tool available: ${block.name}</tool_use_error>`,
                is_error: true,
                tool_use_id: block.id,
              },
            ],
            toolUseResult: `Error: No such tool available: ${block.name}`,
            sourceToolAssistantUUID: assistantMessage.uuid,
          }),
        ],
      })
      return
    }

    const parsedInput = toolDefinition.inputSchema.safeParse(block.input)
// 先用 zod 解析入参再判断并发安全性；解析失败或抛异常都按「不可并发」处理（fail-closed）。
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
          } catch {
            return false
          }
        })()
      : false
    this.tools.push({
      id: block.id,
      block,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()
// void：故意不 await——让队列调度在后台进行，addTool 立刻返回，好让流式收包继续。
  }

  /**
   * Check if a tool can execute based on current concurrency state
   */
/** 判断这个工具现在能不能开跑：
 *  · 没有任何工具在跑 → 可以（无论是否并发安全）
 *  · 有工具在跑，且【全部】都是并发安全的，而本工具也是并发安全的 → 可以
 *  · 其它情况（本工具非安全 / 正在跑的里有非安全的）→ 不行
 *  即：非并发安全工具享受「独占锁」的语义。
 */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    )
  }

  /**
   * Process the queue, starting tools when concurrency conditions allow
   */
/** 扫描队列并启动能启动的工具。
 *  注意那个 break：如果排在前面的【非并发安全】工具还不能跑，就必须停在这里，
 *  不能跳过去先跑后面的——否则会破坏模型给定的执行顺序（写操作的顺序是有语义的）。
 *  而并发安全工具不能开跑时可以跳过（它本来就不要求顺序）。
 */
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else {
        // Can't execute this tool yet, and since we need to maintain order for non-concurrent tools, stop here
        if (!tool.isConcurrencySafe) break
// 只允许跳过【并发安全】的工具；非并发安全工具卡住时必须停下等待，以保住执行顺序。
      }
    }
  }

/** 造一条【合成的错误结果】——用于那些根本没真正执行、但需要补一个结果的场景。
 *  三种原因：
 *    user_interrupted   —— 用户按 ESC 中断：文案用 REJECT_MESSAGE，UI 会显示「用户拒绝了」而不是「出错」
 *    streaming_fallback —— 流式回退，本轮结果作废
 *    sibling_error      —— 并行的兄弟工具出错，本工具被连带取消（会带上出错工具的名字，便于理解）
 *  为什么必须造结果：API 要求每个 tool_use 都有配对的 tool_result，缺了就 400。
 */
  private createSyntheticErrorMessage(
    toolUseId: string,
    reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
    assistantMessage: AssistantMessage,
  ): Message {
    // For user interruptions (ESC to reject), use REJECT_MESSAGE so the UI shows
    // "User rejected edit" instead of "Error editing file"
    if (reason === 'user_interrupted') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: withMemoryCorrectionHint(REJECT_MESSAGE),
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'User rejected tool use',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    if (reason === 'streaming_fallback') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content:
              '<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>',
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'Streaming fallback - tool execution discarded',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    const desc = this.erroredToolDescription
    const msg = desc
      ? `Cancelled: parallel tool call ${desc} errored`
      : 'Cancelled: parallel tool call errored'
    return createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: `<tool_use_error>${msg}</tool_use_error>`,
          is_error: true,
          tool_use_id: toolUseId,
        },
      ],
      toolUseResult: msg,
      sourceToolAssistantUUID: assistantMessage.uuid,
    })
  }

  /**
   * Determine why a tool should be cancelled.
   */
/** 判断这个工具该不该被取消，以及因为什么被取消。
 *  优先级：已 discard（回退） > 有兄弟工具出错 > 用户中断。
 *  中断这里有个细节：abort 的 reason 是 'interrupt'（用户中途插话）时，
 *  只有 interruptBehavior 为 'cancel' 的工具才被取消；'block' 的工具应当继续跑完——
 *  因为中断它们的副作用已经产生了，中途停会留下半成品状态。
 */
  private getAbortReason(
    tool: TrackedTool,
  ): 'sibling_error' | 'user_interrupted' | 'streaming_fallback' | null {
    if (this.discarded) {
      return 'streaming_fallback'
    }
    if (this.hasErrored) {
      return 'sibling_error'
    }
    if (this.toolUseContext.abortController.signal.aborted) {
      // 'interrupt' means the user typed a new message while tools were
      // running. Only cancel tools whose interruptBehavior is 'cancel';
      // 'block' tools shouldn't reach here (abort isn't fired).
      if (this.toolUseContext.abortController.signal.reason === 'interrupt') {
        return this.getToolInterruptBehavior(tool) === 'cancel'
          ? 'user_interrupted'
          : null
      }
      return 'user_interrupted'
    }
    return null
  }

/** 读工具的 interruptBehavior（可选方法），没实现或抛异常都按 'block' 处理（保守：不停）。 */
  private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
    const definition = findToolByName(this.toolDefinitions, tool.block.name)
    if (!definition?.interruptBehavior) return 'block'
    try {
      return definition.interruptBehavior()
    } catch {
      return 'block'
    }
  }

/** 拼一句人类可读的工具描述（工具名 + 命令/路径/模式的前 40 字），用于错误提示里指明是哪个工具。 */
  private getToolDescription(tool: TrackedTool): string {
    const input = tool.block.input as Record<string, unknown> | undefined
    const summary = input?.command ?? input?.file_path ?? input?.pattern ?? ''
    if (typeof summary === 'string' && summary.length > 0) {
      const truncated =
        summary.length > 40 ? summary.slice(0, 40) + '\u2026' : summary
      return `${tool.block.name}(${truncated})`
    }
    return tool.block.name
  }

/** 更新 UI 的「当前有可中断工具在跑」状态：只有【所有】正在跑的工具都可中断时才置 true。 */
  private updateInterruptibleState(): void {
    const executing = this.tools.filter(t => t.status === 'executing')
    this.toolUseContext.setHasInterruptibleToolInProgress?.(
      executing.length > 0 &&
        executing.every(t => this.getToolInterruptBehavior(t) === 'cancel'),
    )
  }

  /**
   * Execute a tool and collect its results
   */
/** 真正启动一个工具的执行（但不等待它完成）。
 *  做法：把执行过程包成一个 async 函数 collectResults()，立刻调用得到 promise 并【存起来】，
 *  然后注册 finally 回调：跑完后再触发一次 processQueue（好让后面排队的工具开工）。
 *  这样 executeTool 本身很快就返回，队列能继续推进。
 *  collectResults 内部：
 *    ① 开跑前先查一次取消原因，已取消就直接塞合成错误结果
 *    ② 为每个工具创建【子 abort 控制器】（父子链条：主 → sibling → 本工具），
 *       并监听 abort 事件把取消向上冒泡（但兄弟错误不冒泡，见下方注释）
 *    ③ 调 runToolUse 并把产出的消息分成两类：progress 进 pendingProgress（立即吐出），
 *       其余进 results（按序吐出）
 *    ④ 若本工具的结果带 is_error 且是 Bash → 标记全局出错并 abort 兄弟控制器
 *    ⑤ 完成后把状态置 completed，并按情况应用 contextModifier
 */
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = 'executing'
    this.toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(tool.id),
    )
    this.updateInterruptibleState()

    const messages: Message[] = []
    const contextModifiers: Array<(context: ToolUseContext) => ToolUseContext> =
      []

    const collectResults = async () => {
// 注意：这个函数【立即调用】但结果存成 promise，executeTool 本身不 await 它——
// 这样排队里的下一个工具才有机会被启动。
      // If already aborted (by error or user), generate synthetic error block instead of running the tool
      const initialAbortReason = this.getAbortReason(tool)
      if (initialAbortReason) {
        messages.push(
          this.createSyntheticErrorMessage(
            tool.id,
            initialAbortReason,
            tool.assistantMessage,
          ),
        )
        tool.results = messages
        tool.contextModifiers = contextModifiers
        tool.status = 'completed'
        this.updateInterruptibleState()
        return
      }

      // Per-tool child controller. Lets siblingAbortController kill running
      // subprocesses (Bash spawns listen to this signal) when a Bash error
      // cascades. Permission-dialog rejection also aborts this controller
      // (PermissionContext.ts cancelAndAbort) — that abort must bubble up to
      // the query controller so the query loop's post-tool abort check ends
      // the turn. Without bubble-up, ExitPlanMode "clear context + auto"
      // sends REJECT_MESSAGE to the model instead of aborting (#21056 regression).
// 每个工具再挂一层子控制器（主 → siblingAbortController → 本工具）：
//   · sibling 出错时杀掉本工具的子进程，但【不】冒泡到主控制器（不该结束整个回合）
//   · 权限弹窗被拒绝时也会 abort 本控制器，这种取消【必须】冒泡到主控制器，
//     否则主循环收不到中断信号，会继续把 REJECT_MESSAGE 当成普通结果发给模型（#21056 的回归 bug）
      const toolAbortController = createChildAbortController(
        this.siblingAbortController,
      )
      toolAbortController.signal.addEventListener(
        'abort',
        () => {
          if (
            toolAbortController.signal.reason !== 'sibling_error' &&
            !this.toolUseContext.abortController.signal.aborted &&
            !this.discarded
          ) {
            this.toolUseContext.abortController.abort(
              toolAbortController.signal.reason,
            )
          }
        },
        { once: true },
      )

      const generator = runToolUse(
        tool.block,
        tool.assistantMessage,
        this.canUseTool,
        { ...this.toolUseContext, abortController: toolAbortController },
      )

      // Track if this specific tool has produced an error result.
      // This prevents the tool from receiving a duplicate "sibling error"
      // message when it is the one that caused the error.
      let thisToolErrored = false
// thisToolErrored 用来避免「自己出错却还收到一条『兄弟出错了』的取消消息」这种重复与误导。

      for await (const update of generator) {
        // Check if we were aborted by a sibling tool error or user interruption.
        // Only add the synthetic error if THIS tool didn't produce the error.
        const abortReason = this.getAbortReason(tool)
        if (abortReason && !thisToolErrored) {
          messages.push(
            this.createSyntheticErrorMessage(
              tool.id,
              abortReason,
              tool.assistantMessage,
            ),
          )
          break
        }

        const isErrorResult =
          update.message.type === 'user' &&
          Array.isArray(update.message.message.content) &&
          update.message.message.content.some(
            _ => _.type === 'tool_result' && _.is_error === true,
          )

        if (isErrorResult) {
          thisToolErrored = true
          // Only Bash errors cancel siblings. Bash commands often have implicit
          // dependency chains (e.g. mkdir fails → subsequent commands pointless).
          // Read/WebFetch/etc are independent — one failure shouldn't nuke the rest.
          if (tool.block.name === BASH_TOOL_NAME) {
            this.hasErrored = true
            this.erroredToolDescription = this.getToolDescription(tool)
            this.siblingAbortController.abort('sibling_error')
          }
        }
// 只有 Bash 出错才会【级联取消】兄弟工具：Bash 命令之间常有隐式依赖（mkdir 失败 → 后续命令都没意义）。
// 而 Read / WebFetch 之类彼此独立，一个失败不该把其它并行的读取全部干掉。

        if (update.message) {
          // Progress messages go to pendingProgress for immediate yielding
          if (update.message.type === 'progress') {
            tool.pendingProgress.push(update.message)
            // Signal that progress is available
            if (this.progressAvailableResolve) {
              this.progressAvailableResolve()
              this.progressAvailableResolve = undefined
            }
          } else {
            messages.push(update.message)
          }
        }
// 分流：progress 消息立刻可吐（实时性优先），其它消息攒起来按序吐（顺序优先）。
        if (update.contextModifier) {
          contextModifiers.push(update.contextModifier.modifyContext)
        }
      }
      tool.results = messages
      tool.contextModifiers = contextModifiers
      tool.status = 'completed'
      this.updateInterruptibleState()

      // NOTE: we currently don't support context modifiers for concurrent
      //       tools. None are actively being used, but if we want to use
      //       them in concurrent tools, we need to support that here.
// 历史限制：并发工具产生的 contextModifier 目前【不生效】——并发时改上下文语义不明，
// 而当前也没有工具真用到它，所以只在非并发工具上应用。
      if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
        for (const modifier of contextModifiers) {
          this.toolUseContext = modifier(this.toolUseContext)
        }
      }
    }

    const promise = collectResults()
    tool.promise = promise

    // Process more queue when done
    void promise.finally(() => {
      void this.processQueue()
    })
// 跑完后（无论成败）再推进一次队列：腾出的位置可以让后面的工具开工。
  }

  /**
   * Get any completed results that haven't been yielded yet (non-blocking)
   * Maintains order where necessary
   * Also yields any pending progress messages immediately
   */
/** 【同步、非阻塞】取出「已经可以吐出」的结果与进度消息。
 *  保序逻辑（这是流式执行的难点）：按工具【到达顺序】扫描——
 *    · 先把每个工具的 pendingProgress 全吐出去（进度不管顺序，越实时越好）
 *    · 已 completed 的：整批结果吐出，并标记为 yielded
 *    · 遇到【正在执行且非并发安全】的工具：必须 break（它没跑完，后面的结果不能抢在它前面出去）
 *  这样即便后面的只读工具先跑完，也会等前面的写操作出结果后才吐出，顺序始终与模型输出一致。
 */
  *getCompletedResults(): Generator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    for (const tool of this.tools) {
      // Always yield pending progress messages immediately, regardless of tool status
      while (tool.pendingProgress.length > 0) {
        const progressMessage = tool.pendingProgress.shift()!
        yield { message: progressMessage, newContext: this.toolUseContext }
      }
// 进度消息优先、且不受顺序约束：用户在等的时候最想看到「正在输出什么」。

      if (tool.status === 'yielded') {
        continue
      }

      if (tool.status === 'completed' && tool.results) {
        tool.status = 'yielded'

        for (const message of tool.results) {
          yield { message, newContext: this.toolUseContext }
        }

        markToolUseAsComplete(this.toolUseContext, tool.id)
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        break
      }
// 遇到还没跑完的非并发安全工具就停下：后面的结果不能越过它（保序的关键）。
    }
  }

  /**
   * Check if any tool has pending progress messages
   */
/** 是否有待吐出的进度消息（用来决定要不要提前唤醒等待循环）。 */
  private hasPendingProgress(): boolean {
    return this.tools.some(t => t.pendingProgress.length > 0)
  }

  /**
   * Wait for remaining tools and yield their results as they complete
   * Also yields progress messages as they become available
   */
/** 【异步】等待剩余工具完成，并边等边吐出结果。
 *  循环步骤：
 *    ① 先推进一次队列（可能有工具刚腾出位置）
 *    ② 把当前可吐出的结果全部 yield
 *    ③ 如果还有工具在跑、但既没有新结果也没有新进度 → 进入等待
 *       等待用 Promise.race：要么某个正在跑的工具完成，要么有新进度消息（唤醒信号）
 *  用 race 而不是傻等全部完成，是为了让进度消息也能被及时吐出去（界面不卡顿）。
 */
  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    while (this.hasUnfinishedTools()) {
      await this.processQueue()

      for (const result of this.getCompletedResults()) {
        yield result
      }

      // If we still have executing tools but nothing completed, wait for any to complete
      // OR for progress to become available
      if (
        this.hasExecutingTools() &&
        !this.hasCompletedResults() &&
        !this.hasPendingProgress()
      ) {
        const executingPromises = this.tools
          .filter(t => t.status === 'executing' && t.promise)
          .map(t => t.promise!)

        // Also wait for progress to become available
        const progressPromise = new Promise<void>(resolve => {
          this.progressAvailableResolve = resolve
        })
// 手工造一个「一次性唤醒信号」：把 resolve 存到字段上，
// 等有新进度消息到来时（executeTool 里）调用它，等待就被唤醒了（≈ Java 的 CountDownLatch(1)）。

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise])
        }
// Promise.race ≈ CompletableFuture.anyOf：谁先完成谁赢，从而既不漏结果也不漏进度。
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result
    }
  }

  /**
   * Check if there are any completed results ready to yield
   */
/** 是否有已跑完、可以吐出的工具。 */
  private hasCompletedResults(): boolean {
    return this.tools.some(t => t.status === 'completed')
  }

  /**
   * Check if there are any tools still executing
   */
/** 是否还有工具在执行中。 */
  private hasExecutingTools(): boolean {
    return this.tools.some(t => t.status === 'executing')
  }

  /**
   * Check if there are any unfinished tools
   */
/** 是否还有没吐出去的工具（含 queued / executing / completed 三种）。 */
  private hasUnfinishedTools(): boolean {
    return this.tools.some(t => t.status !== 'yielded')
  }

  /**
   * Get the current tool use context (may have been modified by context modifiers)
   */
/** 取当前上下文（可能被非并发工具的 contextModifier 改过）。 */
  getUpdatedContext(): ToolUseContext {
    return this.toolUseContext
  }
}

/** 把工具从「进行中」集合里摘掉（用 new Set(prev) 拷贝后删，不直接改原集合）。 */
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
