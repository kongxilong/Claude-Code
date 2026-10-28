/**
 * 【一句话定位】
 * analytics 的「路由器（sink 实现）」：把事件分发到两个真实后端——Datadog 和一方（1P）事件日志；
 * 同时在分发前做采样（sampling）和敏感字段剥离。
 *
 * 【在架构中的位置】
 * 调用链：
 *   应用启动时 main.tsx 的 setupBackend()
 *     → 本文件 initializeAnalyticsGates()（拉取功能开关）+ initializeAnalyticsSink()（注入后端）
 *       → index.ts attachAnalyticsSink()（把本文件的实现注册进去）
 *   运行期：index.ts logEvent() → 本文件 logEventImpl()
 *     → datadog.ts trackDatadogEvent()（受功能开关控制）
 *     → firstPartyEventLogger.ts logEventTo1P()（一方后端，总是发）
 * 依赖：growthbook.ts（功能开关）、sinkKillswitch.ts（单后端熔断）。
 *
 * 【两个后端的区别（重要）】
 * - Datadog：通用可观测性后端，访问权限较宽 → 所以发之前必须 stripProtoFields() 剔掉 PII 字段，
 *   而且受功能开关和熔断开关双重控制。
 * - 1P（first-party）：Anthropic 自己的事件管线，其中 PII 字段进的是有独立访问控制的特权列
 *   → 所以可以发完整载荷（含 _PROTO_ 字段），由 firstPartyEventLoggingExporter 自己分流。
 *
 * 【本文件包含什么】
 * - type LogEventMetadata：本地复刻 index.ts 的元数据类型（避免 import 造成耦合）。
 * - DATADOG_GATE_NAME / isDatadogGateEnabled：Datadog 功能开关的名字与缓存值。
 * - shouldTrackDatadog()：三重判断（熔断 → 本地缓存 → 远端缓存值）。
 * - logEventImpl() / logEventAsyncImpl()：同步/异步两个上报实现。
 * - initializeAnalyticsGates() / initializeAnalyticsSink()：两个启动期初始化函数。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `let isDatadogGateEnabled: boolean | undefined = undefined`：
 *   三态！true / false / undefined（还没初始化）。这是 TS 里表达「未初始化」的常用手法，
 *   ≈ Java 的 `Boolean flag = null;`（包装类型用 null 表示未设置）。
 *   注意写成 boolean 就只能两态，无法区分「明确是 false」和「还没问过服务器」。
 * - `if (isDatadogGateEnabled !== undefined) return isDatadogGateEnabled`：
 *   这里必须显式和 undefined 比较。不能写成 `if (isDatadogGateEnabled)`，
 *   否则 false 会被当成「没值」而去查缓存——典型的布尔三态踩坑点。
 * - `catch { ... }`：【可选 catch 绑定】（ES2019+），不需要写 `catch (e)`。
 *   ≈ Java 的 `catch (Exception ignored) {}`，但更简洁。
 *   这里表示「拿不到开关值就算了，按关闭处理」——fail-safe 设计。
 * - `const metadataWithSampleRate = cond ? { ...metadata, sample_rate: r } : metadata`：
 *   对象展开做「条件性加字段」，不修改原对象。
 *   ≈ Java 的 `cond ? new HashMap<>(m){{put(...)}} : m`。
 * - `void trackDatadogEvent(...)`：`void` 前缀 = 明确「我故意不 await」。
 *   trackDatadogEvent 返回 Promise，但上报不该阻塞主流程。
 * - `function logEventAsyncImpl(...): Promise<void> { ...; return Promise.resolve() }`：
 *   手工返回一个「已完成的 Promise」。≈ Java 的 `CompletableFuture.completedFuture(null)`。
 *   英文注释说明了保留它的原因：Segment 后端移除后，两个 sink 都是 fire-and-forget，
 *   异步版其实没差别，但为了保持接口契约（AnalyticsSink 要求有这个方法）仍然留着。
 * - `attachAnalyticsSink({ logEvent: logEventImpl, logEventAsync: logEventAsyncImpl })`：
 *   把两个函数【作为值】传进去。TS 里函数是一等公民，可以当参数传、当字段存。
 *   ≈ Java 的方法引用 `this::logEventImpl`（Java 8+ 也支持，但语义上要转成函数式接口）。
 * - `import { attachAnalyticsSink, stripProtoFields } from './index.js'`：
 *   从同目录的 index.ts 导入。注意这是「实现 → 接口」的反向依赖，靠 index.ts 零依赖来避免循环。
 * - 模块级 `let` 变量做缓存：≈ Java 的 private static 字段缓存。
 */
/**
 * Analytics sink implementation
 *
 * This module contains the actual analytics routing logic and should be
 * initialized during app startup. It routes events to Datadog and 1P event
 * logging.
 *
 * Usage: Call initializeAnalyticsSink() during app startup to attach the sink.
 */

import { trackDatadogEvent } from './datadog.js'
import { logEventTo1P, shouldSampleEvent } from './firstPartyEventLogger.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from './growthbook.js'
import { attachAnalyticsSink, stripProtoFields } from './index.js'
import { isSinkKilled } from './sinkKillswitch.js'

// Local type matching the logEvent metadata signature
// 本地复刻一份类型（而不是从 index.ts import）——刻意保持解耦，避免为了一个类型引入依赖。
// 代价是两边类型要手动保持同步，收益是依赖图更干净。
type LogEventMetadata = { [key: string]: boolean | number | undefined }

// 功能开关（feature gate）的名字。所谓 gate：服务端可以远程把某个后端整条链路关掉，
// 出事故时用它紧急止血，不用发新版本。详细见 growthbook.ts。
const DATADOG_GATE_NAME = 'tengu_log_datadog_events'

// Module-level gate state - starts undefined, initialized during startup
// 三态：undefined=还没问过服务器，true/false=已确定（本地缓存或服务端拉取的结果）。
let isDatadogGateEnabled: boolean | undefined = undefined

/**
 * Check if Datadog tracking is enabled.
 * Falls back to cached value from previous session if not yet initialized.
 */
// 三重判断：① 熔断开关（本地硬关）② 本地已缓存的值 ③ 上一次会话缓存下来的值。
// 为什么要「上一次会话的缓存」：应用刚启动时还没来得及问服务器，
// 直接用缓存值可以避免「启动初期所有事件都丢失」。
// 失败一律按 false 处理（fail-safe）：宁可少收数据，也不能因为拿开关失败而卡住上报。
function shouldTrackDatadog(): boolean {
  if (isSinkKilled('datadog')) {
    return false
  }
  if (isDatadogGateEnabled !== undefined) {
    return isDatadogGateEnabled
  }

  // Fallback to cached value from previous session
  try {
    return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
  } catch {
    return false
  }
}

/**
 * Log an event (synchronous implementation)
 */
// 路由核心。步骤：
// ① 采样判断：返回 0 表示这条事件被丢弃（采样没选中）
// ② 非 null 的采样率写进 metadata（后端据此还原真实量级）
// ③ 如果 Datadog 开着 → 转发（先剔掉 _PROTO_ 敏感字段）
// ④ 一方后端总是发，且发完整载荷（它自己会把 _PROTO_ 分流到特权列）
function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  // Check if this event should be sampled
  const sampleResult = shouldSampleEvent(eventName)

  // If sample result is 0, the event was not selected for logging
// 采样返回 0 = 没被选中，直接丢弃。这是控制上报量、省钱的关键手段。
  if (sampleResult === 0) {
    return
  }

  // If sample result is a positive number, add it to metadata
  const metadataWithSampleRate =
// sampleResult 为 null 表示「没启用采样」，此时不要往 metadata 里塞 sample_rate。
    sampleResult !== null
      ? { ...metadata, sample_rate: sampleResult }
      : metadata

// Datadog 是通用后端（访问权限宽），所以必须先把 _PROTO_ 开头的 PII 字段剔掉再发。
  if (shouldTrackDatadog()) {
    // Datadog is a general-access backend — strip _PROTO_* keys
    // (unredacted PII-tagged values meant only for the 1P privileged column).
// `void` 前缀：明确「故意不 await」，上报绝不能阻塞主流程。
    void trackDatadogEvent(eventName, stripProtoFields(metadataWithSampleRate))
  }

  // 1P receives the full payload including _PROTO_* — the exporter
  // destructures and routes those keys to proto fields itself.
// 一方后端拿到完整载荷（含 _PROTO_），由 firstPartyEventLoggingExporter 负责分流到特权列。
  logEventTo1P(eventName, metadataWithSampleRate)
}

/**
 * Log an event (asynchronous implementation)
 *
 * With Segment removed the two remaining sinks are fire-and-forget, so this
 * just wraps the sync impl — kept to preserve the sink interface contract.
 */
function logEventAsyncImpl(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  logEventImpl(eventName, metadata)
  return Promise.resolve()
}

/**
 * Initialize analytics gates during startup.
 *
 * Updates gate values from server. Early events use cached values from previous
 * session to avoid data loss during initialization.
 *
 * Called from main.tsx during setupBackend().
 */
// 启动时拉取一次功能开关的值并缓存到模块变量，之后每次判断就不用再查了。
// 为什么只在启动时拉一次：开关不会一天变很多次，而上报是极高频操作，不能每次都查。
export function initializeAnalyticsGates(): void {
  isDatadogGateEnabled =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
}

/**
 * Initialize the analytics sink.
 *
 * Call this during app startup to attach the analytics backend.
 * Any events logged before this is called will be queued and drained.
 *
 * Idempotent: safe to call multiple times (subsequent calls are no-ops).
 */
// 把本文件的两个实现注册给 index.ts，完成「依赖倒置」的最后一步。
// 幂等：index.ts 里的 attachAnalyticsSink 自己保证重复调用是空操作。
export function initializeAnalyticsSink(): void {
  attachAnalyticsSink({
    logEvent: logEventImpl,
    logEventAsync: logEventAsyncImpl,
  })
}
