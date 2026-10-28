/**
 * 【一句话定位】处理 MCP 的 elicitation（向用户「索取信息」）请求：把 server 的提问转成 UI 弹窗，并把用户答复还回去。
 *
 * 【MCP 背景：什么是 elicitation】
 * MCP 里除了 tool（模型调server）、resource（模型读数据）、prompt（用户主动触发的模板），
 * 还有 elicitation：server 反过来向用户提问——可能是一张表单（form 模式），
 * 也可能是「请打开这个 URL 完成登录/授权」（url 模式）。这是 MCP 2025-06 之后引入的能力。
 *
 * 【在架构中的位置】
 * - 上游：client.ts 建连成功后调用 registerElicitationHandler(client, serverName, setAppState)。
 * - 下游：AppState（把请求放进 elicitation.queue 让 UI 渲染）、hooks（让脚本也能程序化地回答）。
 *
 * 【本文件包含什么】
 * - ElicitationWaitingState / ElicitationRequestEvent：UI 需要的数据结构。
 * - getElicitationMode / findElicitationInQueue：两个小工具函数。
 * - registerElicitationHandler：注册「收到 elicitation 请求」和「收到完成通知」两个处理器。
 * - runElicitationHooks：在弹窗之前先跑 hooks，让脚本有机会程序化地作答。
 * - runElicitationResultHooks：用户答完之后再跑 hooks，允许改写或拦截答复。
 *
 * 【整体时序】
 * server 发 elicitation/create → 先跑 hooks（可能直接给出答案）→ 没答案就把事件推进 AppState 队列
 * → UI 弹窗 → 用户操作 → respond() 兑现 Promise → 跑 result hooks → 把最终结果回给 server。
 *
 * 【TS 语法速查】
 * - `new Promise<T>(resolve => {...})`：手动构造 Promise，把「将来才会发生的事」包成异步值，
 *   ≈ Java 的 CompletableFuture + 手动 complete()；这里的 resolve 被存进队列等 UI 回调来触发。
 * - `setAppState(prev => ({ ...prev, x: y }))`：React 的函数式状态更新，
 *   入参是「旧状态 → 新状态」，返回新对象而不是修改旧的（不可变更新的铁律）。
 * - `as const`：把字面量固化成字面量类型（'cancel' 而不是 string），≈ 让编译器按枚举对待它。
 * - `extra.signal`：AbortSignal ≈ Java 的 CancellationException 机制，用来在请求被取消时中止等待。
 * - `'elicitationId' in params`：in 运算符做类型收窄（见 utils.ts 的说明）。
 * - `queue[idx]!`：非空断言。
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  ElicitationCompleteNotificationSchema,
  type ElicitRequestParams,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from '../../state/AppState.js'
import {
  executeElicitationHooks,
  executeElicitationResultHooks,
  executeNotificationHooks,
} from '../../utils/hooks.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

  // 中文：url 模式下的「等待中」状态——用户点了链接去浏览器里操作时，对话框要显示等待提示和按钮
/** Configuration for the waiting state shown after the user opens a URL. */
export type ElicitationWaitingState = {
  /** Button label, e.g. "Retry now" or "Skip confirmation" */
  actionLabel: string
  /** Whether to show a visible Cancel button (e.g. for error-based retry flow) */
  showCancel?: boolean
}

  // 中文：一次 elicitation 请求的完整描述：来自哪个 server、请求 id、参数、取消信号，
  //       以及 respond()（UI 调用它把结果交回给这里挂起的 Promise）
export type ElicitationRequestEvent = {
  serverName: string
  /** The JSON-RPC request ID, unique per server connection. */
  requestId: string | number
  params: ElicitRequestParams
  signal: AbortSignal
  /**
   * Resolves the elicitation. For explicit elicitations, all actions are
   * meaningful. For error-based retry (-32042), 'accept' is a no-op —
   * the retry is driven by onWaitingDismiss instead.
   */
  respond: (response: ElicitResult) => void
  /** For URL elicitations: shown after user opens the browser. */
  waitingState?: ElicitationWaitingState
  /** Called when phase 2 (waiting) is dismissed by user action or completion. */
  onWaitingDismiss?: (action: 'dismiss' | 'retry' | 'cancel') => void
  /** Set to true by the completion notification handler when the server confirms completion. */
  completed?: boolean
}

  /**
   * 中文：判断这次 elicitation 是 form（表单）还是 url（打开链接）模式；默认 form。
   */
function getElicitationMode(params: ElicitRequestParams): 'form' | 'url' {
  return params.mode === 'url' ? 'url' : 'form'
}

/** Find a queued elicitation event by server name and elicitationId. */
  // 中文：在队列里按 (server 名 + elicitationId) 找事件，返回下标；找不到是 -1（findIndex 的约定）
function findElicitationInQueue(
  queue: ElicitationRequestEvent[],
  serverName: string,
  elicitationId: string,
): number {
  return queue.findIndex(
    e =>
      e.serverName === serverName &&
      e.params.mode === 'url' &&
      'elicitationId' in e.params &&
      e.params.elicitationId === elicitationId,
  )
}

  /**
   * 中文：给某个 MCP client 装上 elicitation 相关的处理器。
   * 入参 client：MCP client 句柄；serverName：用于日志与 UI 展示；setAppState：React 状态更新函数。
   * 步骤：① 注册「收到 elicitation 请求」的处理器（server → CC）；
   *      ② 注册「elicitation 已完成」的通知处理器（url 模式下 server 告知用户已操作完）。
   * 为什么整体包在 try/catch 里：client 若没在能力声明里带 elicitation，
   * setRequestHandler 会直接抛错——那只是「这个 server 不支持」，不该让连接失败。
   */
export function registerElicitationHandler(
  client: Client,
  serverName: string,
  setAppState: (f: (prevState: AppState) => AppState) => void,
): void {
  // Register the elicitation request handler.
  // Wrapped in try/catch because setRequestHandler throws if the client wasn't
  // created with elicitation capability declared.
    // 中文：能力未声明时 setRequestHandler 会抛错，所以整段都要包起来（英文注释已说明）
  try {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      logMCPDebug(
        serverName,
        `Received elicitation request: ${jsonStringify(request)}`,
      )

      const mode = getElicitationMode(request.params)
      // 中文：先判定模式，后续几乎所有逻辑（埋点、hooks、UI）都按 form/url 分叉

      logEvent('tengu_mcp_elicitation_shown', {
        mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      try {
        // Run elicitation hooks first - they can provide a response programmatically
        // 中文：hooks 优先——脚本/插件可以程序化地回答，从而完全不打扰用户（自动化场景的关键）
        const hookResponse = await runElicitationHooks(
          serverName,
          request.params,
          extra.signal,
        )
        if (hookResponse) {
          logMCPDebug(
            serverName,
            `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`,
          )
          logEvent('tengu_mcp_elicitation_response', {
            mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            action:
              hookResponse.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return hookResponse
        }

        const elicitationId =
          mode === 'url' && 'elicitationId' in request.params
            ? (request.params.elicitationId as string | undefined)
            : undefined
        // 中文：只有 url 模式才有 elicitationId（用来和后续的「完成通知」配对）

        // 中文：★ 核心技巧——手动 new 一个 Promise，把它的 resolve 存进 AppState 队列，
        //       等用户在 UI 上点了按钮再回来 resolve。这样「异步等待用户」和「同步返回给 server」就对上了。
        const response = new Promise<ElicitResult>(resolve => {
          const onAbort = () => {
            resolve({ action: 'cancel' })
          }

        // 中文：用户按了取消（或连接断了）→ 直接当作 cancel 回答，避免 Promise 永远悬着
          if (extra.signal.aborted) {
            onAbort()
            return
          }

          const waitingState: ElicitationWaitingState | undefined =
            elicitationId ? { actionLabel: 'Skip confirmation' } : undefined

        // 中文：把事件推进队列（不可变更新：用展开运算符造新数组，而不是 push 改原数组）
          setAppState(prev => ({
            ...prev,
            elicitation: {
              queue: [
                ...prev.elicitation.queue,
                {
                  serverName,
                  requestId: extra.requestId,
                  params: request.params,
                  signal: extra.signal,
                  waitingState,
                  respond: (result: ElicitResult) => {
                    extra.signal.removeEventListener('abort', onAbort)
                    logEvent('tengu_mcp_elicitation_response', {
                      mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      action:
                        result.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    resolve(result)
                  },
                },
              ],
            },
          }))

          extra.signal.addEventListener('abort', onAbort, { once: true })
        // 中文：监听 abort 信号：once:true 表示触发一次就自动解绑，避免监听器泄漏
        })
        const rawResult = await response
        // 中文：await 在这里挂起，直到 UI 调用 respond()（或 abort 触发 onAbort）才继续往下走
        logMCPDebug(
          serverName,
          `Elicitation response: ${jsonStringify(rawResult)}`,
        )
        const result = await runElicitationResultHooks(
          serverName,
          rawResult,
          extra.signal,
          mode,
          elicitationId,
        )
        return result
        // 中文：任何异常都降级成 cancel——宁可让 server 收到「用户取消」，也不要把请求吊死
      } catch (error) {
        logMCPError(serverName, `Elicitation error: ${error}`)
        return { action: 'cancel' as const }
      }
    })

    // Register handler for elicitation completion notifications (URL mode).
    // Sets `completed: true` on the matching queue event; the dialog reacts to this flag.
    // 中文：url 模式专用：server 通知「用户已经在浏览器里完成了」，据此把队列项标记为 completed
    client.setNotificationHandler(
      ElicitationCompleteNotificationSchema,
      notification => {
        const { elicitationId } = notification.params
        logMCPDebug(
          serverName,
          `Received elicitation completion notification: ${elicitationId}`,
        )
        void executeNotificationHooks({
          message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
          notificationType: 'elicitation_complete',
        })
        let found = false
      // 中文：用闭包变量 found 记录是否命中——因为 setAppState 的更新函数应该是纯函数，不宜在里面做副作用
        setAppState(prev => {
          const idx = findElicitationInQueue(
            prev.elicitation.queue,
            serverName,
            elicitationId,
          )
          if (idx === -1) return prev
      // 中文：没找到对应事件就原样返回 prev（返回同一个对象引用，React 会跳过重渲染）
          found = true
          const queue = [...prev.elicitation.queue]
      // 中文：先浅拷贝数组再改指定下标，保证不修改旧状态（不可变更新）
          queue[idx] = { ...queue[idx]!, completed: true }
      // 中文：`queue[idx]!` 的 ! 是非空断言——idx 已经检查过不是 -1，但 TS 无法自动推断
          return { ...prev, elicitation: { queue } }
        })
        if (!found) {
          logMCPDebug(
            serverName,
            `Ignoring completion notification for unknown elicitation: ${elicitationId}`,
          )
        }
      },
    )
  } catch {
    // Client wasn't created with elicitation capability - nothing to register
    return
  }
}

  /**
   * 中文：在弹窗之前跑 elicitation hooks，让脚本有机会直接给出答复。
   * 返回：有答复就返回 ElicitResult（调用方直接回给 server）；没有就返回 undefined（继续弹窗）。
   * 出错也返回 undefined——hooks 出问题不应该阻断正常的用户交互流程。
   */
export async function runElicitationHooks(
  serverName: string,
  params: ElicitRequestParams,
  signal: AbortSignal,
): Promise<ElicitResult | undefined> {
  try {
    const mode = params.mode === 'url' ? 'url' : 'form'
    const url = 'url' in params ? (params.url as string) : undefined
    // 中文：'url' in params 是类型收窄：先确认字段存在，才敢把它当 string 读出来
    const elicitationId =
      'elicitationId' in params
        ? (params.elicitationId as string | undefined)
        : undefined

    const { elicitationResponse, blockingError } =
      await executeElicitationHooks({
        serverName,
        message: params.message,
        requestedSchema:
          'requestedSchema' in params
            ? (params.requestedSchema as Record<string, unknown>)
            : undefined,
        signal,
        mode,
        url,
        elicitationId,
      })

    // 中文：blockingError 表示 hook 明确要求拦截 → 按 decline（拒绝）处理，不再问用户
    if (blockingError) {
      return { action: 'decline' }
    }

    if (elicitationResponse) {
      return {
        action: elicitationResponse.action,
        content: elicitationResponse.content,
      }
    }

    return undefined
  } catch (error) {
    logMCPError(serverName, `Elicitation hook error: ${error}`)
    return undefined
  }
}

/**
 * Run ElicitationResult hooks after the user has responded, then fire a
 * `elicitation_response` notification. Returns a (potentially modified)
 * ElicitResult — hooks may override the action/content or block the response.
 */
  /**
   * 中文：用户答完之后再跑一轮 hooks，hooks 可以改写 action/content，或者干脆拦下来。
   * 返回：最终要回给 server 的 ElicitResult（可能被 hooks 改过）。
   */
export async function runElicitationResultHooks(
  serverName: string,
  result: ElicitResult,
  signal: AbortSignal,
  mode?: 'form' | 'url',
  elicitationId?: string,
): Promise<ElicitResult> {
  try {
    const { elicitationResultResponse, blockingError } =
      await executeElicitationResultHooks({
        serverName,
        action: result.action,
        content: result.content as Record<string, unknown> | undefined,
        signal,
        mode,
        elicitationId,
      })

    // 中文：hook 拦截时除了返回 decline，还要发一个通知（让外部可观测到这次拒绝）
    if (blockingError) {
      void executeNotificationHooks({
        message: `Elicitation response for server "${serverName}": decline`,
        notificationType: 'elicitation_response',
      })
      return { action: 'decline' }
    }

    const finalResult = elicitationResultResponse
      ? {
          action: elicitationResultResponse.action,
          content: elicitationResultResponse.content ?? result.content,
        }
      : result

    // Fire a notification for observability
    void executeNotificationHooks({
      message: `Elicitation response for server "${serverName}": ${finalResult.action}`,
      notificationType: 'elicitation_response',
    })

    return finalResult
  } catch (error) {
    logMCPError(serverName, `ElicitationResult hook error: ${error}`)
    // Fire notification even on error
    void executeNotificationHooks({
      message: `Elicitation response for server "${serverName}": ${result.action}`,
      notificationType: 'elicitation_response',
    })
    return result
  }
}
