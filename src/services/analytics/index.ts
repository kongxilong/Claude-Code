/**
 * 【一句话定位】
 * 埋点（analytics）的「对外统一入口」：全项目任何地方要上报一个事件，都调这里的 logEvent() / logEventAsync()。
 * 它本身不含任何上报实现，只负责「接收事件 → 转给后端（sink）」，以及在后端还没就绪时先把事件排队。
 *
 * 【在架构中的位置】
 * 调用链：
 *   全项目各处（工具、命令、API 调用…）
 *     → 本文件 logEvent() / logEventAsync()
 *       → sink.ts initializeAnalyticsSink() 注入进来的实现（真正的路由）
 *         → datadog.ts（Datadog 后端）、firstPartyEventLogger.ts（一方后端）
 * 关键设计（英文注释里的 DESIGN）：本文件【刻意零依赖】，避免循环 import。
 * 所以「真正的后端」是在应用启动时由 sink.ts 反向注入进来的（依赖倒置）。
 *
 * 【为什么要「先排队、后注入」】
 * 应用启动早期（读配置、解析参数阶段）就可能需要打点，但那时网络后端还没初始化好。
 * 如果直接丢弃会丢数据；如果同步等待会拖慢启动。所以这里是：
 *   早期事件进 eventQueue → 应用启动时 attachAnalyticsSink() → 用 queueMicrotask 异步排空队列。
 * 类比 Java：一个静态的 BlockingQueue + 后台消费者线程，但这里用微任务队列代替线程。
 *
 * 【本文件包含什么】
 * - type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS：隐私标记类型（= never）。
 * - type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED：PII 标记类型（= never）。
 * - stripProtoFields()：把 `_PROTO_` 开头的敏感字段从载荷里剔除。
 * - type LogEventMetadata / QueuedEvent / AnalyticsSink：内部数据结构定义。
 * - eventQueue / sink：两个模块级状态（队列 + 当前后端）。
 * - attachAnalyticsSink()：注入后端并排空队列。
 * - logEvent() / logEventAsync()：两个对外上报入口（同步/异步）。
 * - _resetForTesting()：测试用重置。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `export type X = never`：`never` 是「永不存在的类型」，不能给它赋任何值。
 *   这里把两个「隐私确认标记」定义成 never，是一个非常巧妙的【强制走 as 断言】的技巧：
 *   因为直接赋值会编译报错，你只能写 `x as AnalyticsMetadata_I_...`，
 *   而写 as 就意味着你在源码里留下了「我已人工确认这个值不含代码/路径」的证据。
 *   ≈ Java 里没有对应物，最接近的是「必须显式调用一个 unsafe 工厂方法才能构造的类型」。
 * - `type LogEventMetadata = { [key: string]: boolean | number | undefined }`：
 *   索引签名 + 联合类型：键任意，值只能是布尔/数字/undefined。
 *   【刻意不允许 string】——这样就不可能不小心把代码片段或文件路径上报上去。
 *   真要上报字符串，必须写成 `s as AnalyticsMetadata_I_VERIFIED_...`（见上一条）。
 *   这是用类型系统做隐私防护的典型例子。
 * - `let sink: AnalyticsSink | null = null`：`| null` 显式声明可空，编译器会强迫你判空。
 * - `void sink!.logEventAsync(...)`：
 *   `sink!` 非空断言（保证此刻不是 null）；`void` 前缀表示「故意不等这个 Promise」。
 * - `queueMicrotask(() => {...})`：把回调放进微任务队列，当前同步代码跑完立刻执行。
 *   ≈ Java 的 `CompletableFuture.runAsync(..., sameThreadExecutor)`，但更轻、不占线程池。
 * - `const queuedEvents = [...eventQueue]`：`...` 数组展开 = 复制一份快照。
 *   ≈ Java 的 `new ArrayList<>(queue)`。必须复制，因为下面要清空原队列。
 * - `eventQueue.length = 0`：清空数组（保留引用）。≈ Java 的 `list.clear()`。
 * - `if (event.async) { ... } else { ... }`：队列里记录了每个事件当初是用同步还是异步接口上报的，
 *   排空时按原样回放——保证语义一致。
 * - `export function`（没有 default）：具名导出 ≈ Java 的 public static 方法。
 * - `for (const key in metadata)`：for-in 遍历对象的【键名】（不是值）。
 *   ≈ Java 的 `for (String key : map.keySet())`。
 *   注意别和 for-of（`for (const x of arr)` 遍历值）搞混。
 * - `let result: Record<string, V> | undefined` 然后 `result = { ...metadata }`：
 *   「懒拷贝」优化——只有真的发现要删字段时才复制对象，否则直接返回原引用，
 *   避免每次调用都产生一次无谓的对象拷贝（高频调用路径上的常见优化）。
 * - `return result ?? metadata`：没改动就返回原对象（同一引用），改过就返回新对象。
 * - 泛型 `<V>`：stripProtoFields<V> 可以处理任意值类型的对象。
 *   ≈ Java 的 `<V> Map<String,V> stripProtoFields(Map<String,V> m)`。
 */
/**
 * Analytics service - public API for event logging
 *
 * This module serves as the main entry point for analytics events in Claude CLI.
 *
 * DESIGN: This module has NO dependencies to avoid import cycles.
 * Events are queued until attachAnalyticsSink() is called during app initialization.
 * The sink handles routing to Datadog and 1P event logging.
 */

// 中文补充（隐私设计，这是本文件最值得学的地方）：
// 埋点最大的风险是「不小心把用户的代码或文件路径上报到服务器」。
// Claude Code 用【类型系统】来堵这个漏洞，而不是靠人工 review：
//   ① metadata 的值类型被限制成 boolean | number | undefined，压根放不进字符串
//   ② 万一真要上报字符串，必须写 `s as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
//   ③ 那个类型 = never，正常赋值编译不过，只有显式 as 才能绕过
// 于是「谁上报了字符串、谁确认过安全」在代码里一目了然，review 时看类型名就知道。
/**
 * Marker type for verifying analytics metadata doesn't contain sensitive data
 *
 * This type forces explicit verification that string values being logged
 * don't contain code snippets, file paths, or other sensitive information.
 *
 * Usage: `myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

// 中文补充：第二个隐私标记，用于「可以上报个人信息（PII）」的场景。
// 这些值通过 `_PROTO_` 开头的键传递，只进一方后端的特权列（有独立访问控制），
// 不会进 Datadog 这种通用后端——stripProtoFields() 会在转发给 Datadog 前把它们剔掉。
/**
 * Marker type for values routed to PII-tagged proto columns via `_PROTO_*`
 * payload keys. The destination BQ column has privileged access controls,
 * so unredacted values are acceptable — unlike general-access backends.
 *
 * sink.ts strips `_PROTO_*` keys before Datadog fanout; only the 1P
 * exporter (firstPartyEventLoggingExporter) sees them and hoists them to the
 * top-level proto field. A single stripProtoFields call guards all non-1P
 * sinks — no per-sink filtering to forget.
 *
 * Usage: `rawName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

/**
 * Strip `_PROTO_*` keys from a payload destined for general-access storage.
 * Used by:
 *   - sink.ts: before Datadog fanout (never sees PII-tagged values)
 *   - firstPartyEventLoggingExporter: defensive strip of additional_metadata
 *     after hoisting known _PROTO_* keys to proto fields — prevents a future
 *     unrecognized _PROTO_foo from silently landing in the BQ JSON blob.
 *
 * Returns the input unchanged (same reference) when no _PROTO_ keys present.
 */
// 把 `_PROTO_` 前缀的字段剔除（这些是给一方后端特权列用的 PII，不能进通用后端）。
// @param metadata 原始载荷
// @returns 剔除后的载荷；如果没有要剔除的字段，返回【原对象本身】（同一个引用，省一次拷贝）
// 设计意图：只在「一处」统一拦截（而不是每个 sink 各自过滤），
// 这样以后新增 sink 也不会漏掉——英文注释里叫 "no per-sink filtering to forget"。
export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V> {
  let result: Record<string, V> | undefined
// for-in 遍历的是「键名」（不是值），和 for-of 遍历值要区分开。
  for (const key in metadata) {
    if (key.startsWith('_PROTO_')) {
// 懒拷贝：发现第一个要删的字段时才复制，避免每次调用都白白拷贝一个对象（这是高频路径）。
      if (result === undefined) {
        result = { ...metadata }
      }
      delete result[key]
    }
  }
  return result ?? metadata
}

// Internal type for logEvent metadata - different from the enriched EventMetadata in metadata.ts
// 注意这里【不允许 string】：值只能是 boolean / number / undefined。
// 这是防止误报代码/路径的第一道防线（第二道是上面的 never 标记类型）。
type LogEventMetadata = { [key: string]: boolean | number | undefined }

type QueuedEvent = {
  eventName: string
  metadata: LogEventMetadata
  async: boolean
}

// 后端接口（sink）。两个方法：同步上报、异步上报。
// 用「接口 + 注入」而不是直接 import 具体实现，是为了让本文件零依赖、避免循环 import。
/**
 * Sink interface for the analytics backend
 */
export type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (
    eventName: string,
    metadata: LogEventMetadata,
  ) => Promise<void>
}

// Event queue for events logged before sink is attached
// 早期事件（后端还没就绪时产生的）先存在这里，等后端注入后一次性回放。
const eventQueue: QueuedEvent[] = []

// Sink - initialized during app startup
let sink: AnalyticsSink | null = null

/**
 * Attach the analytics sink that will receive all events.
 * Queued events are drained asynchronously via queueMicrotask to avoid
 * adding latency to the startup path.
 *
 * Idempotent: if a sink is already attached, this is a no-op. This allows
 * calling from both the preAction hook (for subcommands) and setup() (for
 * the default command) without coordination.
 */
// 注入真正的后端（由 sink.ts 在应用启动时调用）。
// @param newSink 实现了 logEvent / logEventAsync 的对象
// 幂等：已经注入过就直接返回。这样 preAction 钩子和 setup() 都可以放心各调一次，无需互相协调。
// 关键步骤：① 设置 sink ② 复制并清空队列 ③ 用 queueMicrotask 异步回放
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) {
    return
  }
  sink = newSink

  // Drain the queue asynchronously to avoid blocking startup
// 为什么用 queueMicrotask 而不是直接同步回放：
// attachAnalyticsSink 通常在启动关键路径上被调用，同步回放几百个事件会明显拖慢启动。
// 微任务会在当前同步代码结束后【立刻】执行（不等事件循环下一轮），既快又不阻塞。
  if (eventQueue.length > 0) {
// 先复制快照再清空原队列：防止回放过程中新产生的事件混进来造成重复或死循环。
    const queuedEvents = [...eventQueue]
    eventQueue.length = 0

    // Log queue size for ants to help debug analytics initialization timing
// USER_TYPE === 'ant' 是内部（Anthropic 员工）才开的调试日志，方便排查埋点初始化时序问题。
    if (process.env.USER_TYPE === 'ant') {
      sink.logEvent('analytics_sink_attached', {
        queued_event_count: queuedEvents.length,
      })
    }

    queueMicrotask(() => {
      for (const event of queuedEvents) {
        if (event.async) {
          void sink!.logEventAsync(event.eventName, event.metadata)
        } else {
          sink!.logEvent(event.eventName, event.metadata)
        }
      }
    })
  }
}

/**
 * Log an event to analytics backends (synchronous)
 *
 * Events may be sampled based on the 'tengu_event_sampling_config' dynamic config.
 * When sampled, the sample_rate is added to the event metadata.
 *
 * If no sink is attached, events are queued and drained when the sink attaches.
 */
// 同步上报入口（最常用）。
// @param eventName 事件名（如 'tengu_oauth_token_refresh_success'）
// @param metadata  附加数据（只能是 boolean/number/undefined，见上面类型的说明）
// 行为：后端没就绪 → 入队；就绪 → 直接转发。
// 注意「采样」不在这里做，而在 sink 里做——本文件只管转发。
export function logEvent(
  eventName: string,
  // intentionally no strings unless AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  // to avoid accidentally logging code/filepaths
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}

/**
 * Log an event to analytics backends (asynchronous)
 *
 * Events may be sampled based on the 'tengu_event_sampling_config' dynamic config.
 * When sampled, the sample_rate is added to the event metadata.
 *
 * If no sink is attached, events are queued and drained when the sink attaches.
 */
// 异步版上报：返回 Promise，调用方可以 await 确保真的发出去了（比如进程退出前）。
// 为什么要有两个版本：绝大多数场景 fire-and-forget 就够（用 logEvent）；
// 但「进程即将退出」「需要确保送达」的场景必须能等（用 logEventAsync）。
export async function logEventAsync(
  eventName: string,
  // intentionally no strings, to avoid accidentally logging code/filepaths
  metadata: LogEventMetadata,
): Promise<void> {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: true })
    return
  }
  await sink.logEventAsync(eventName, metadata)
}

/**
 * Reset analytics state for testing purposes only.
 * @internal
 */
// 仅测试用：把 sink 置空、队列清空，让每个测试用例从干净状态开始。
export function _resetForTesting(): void {
  sink = null
  eventQueue.length = 0
}
