/**
 * 【一句话定位】
 * 「一方（1P，即 Anthropic 自家）事件日志」的初始化与发送：基于 OpenTelemetry 的日志 SDK，
 * 把事件攒批后 POST 到自家后端 /api/event_logging/batch。
 *
 * 【在架构中的位置】
 * 调用链：
 *   应用启动 → 本文件 initialize1PEventLogging()（建 LoggerProvider + 批处理器 + Exporter）
 *   运行期：sink.ts logEventImpl() → 本文件 logEventTo1P() → logEventTo1PAsync()
 *     → metadata.ts getEventMetadata()（补环境/版本/账号等元数据）
 *     → OpenTelemetry BatchLogRecordProcessor（攒批）
 *       → firstPartyEventLoggingExporter.ts（真正的 HTTP 发送 + 磁盘重试）
 *   GrowthBook 配置刷新 → 本文件 reinitialize1PEventLoggingIfConfigChanged()（配置变了就重建管线）
 *   应用退出 → 本文件 shutdown1PEventLogging()（flush 剩余事件）
 *
 * 【为什么用 OpenTelemetry（Java 工程师很熟）】
 * OTel 是 CNCF 的「可观测性标准」，Java 生态里通过 javaagent 或 Micrometer 接入。
 * 这里用的是它的 JS 版 SDK：LoggerProvider（≈ Tracer/Logger 工厂）+ BatchLogRecordProcessor
 * （≈ BatchSpanProcessor，攒批）+ Exporter（≈ SpanExporter，真正发送）。
 * 关键约束（英文注释强调）：这条管线【独立于客户的 OTLP 遥测】，
 * 双方不能混用——内部事件绝不能漏到客户自己的监控系统里，反之亦然。
 *
 * 【本文件包含什么】
 * - type EventSamplingConfig / getEventSamplingConfig() / shouldSampleEvent()：采样配置与采样判定。
 * - BATCH_CONFIG_NAME / type BatchConfig / getBatchConfig()：批处理参数（来自 GrowthBook 动态配置）。
 * - firstPartyEventLogger / firstPartyEventLoggerProvider / lastBatchConfig：三个模块级状态。
 * - shutdown1PEventLogging()：退出前 flush。
 * - is1PEventLoggingEnabled()：是否启用（复用 config.ts 的总闸）。
 * - logEventTo1PAsync() / logEventTo1P()：异步实现 + 同步入口（fire-and-forget）。
 * - type GrowthBookExperimentData / logGrowthBookExperimentTo1P()：A/B 实验分组事件的上报。
 * - initialize1PEventLogging()：初始化整条 OTel 管线。
 * - reinitialize1PEventLoggingIfConfigChanged()：配置变化时热重建。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `import type { AnyValueMap, Logger, logs } from '@opentelemetry/api-logs'`：
 *   一次性导入多个【类型】。≈ Java 的 import，但编译后完全擦除。
 * - `let firstPartyEventLogger: ReturnType<typeof logs.getLogger> | null = null`：
 *   `ReturnType<typeof f>` 是内置工具类型，取「函数 f 的返回类型」。
 *   ≈ Java 里没法直接表达（要靠泛型推断），TS 这样可以避免手写那个长长的类名。
 * - `metadata: Record<string, number | boolean | undefined> = {}`：
 *   带默认值的参数（不传就是空对象）。≈ Java 的重载或 Optional 参数。
 *   同样【禁止 string】，理由同 index.ts：防止误报代码/路径。
 * - `as unknown as AnyValueMap`：「双重断言」。先转成 unknown 再转成目标类型。
 *   什么时候需要：两个类型差距太大 TS 不允许直接 as，就先「抹成 unknown」再转。
 *   ≈ Java 的 `(T)(Object) x` 双重强制转换。英文注释解释了原因：
 *   嵌套对象结构上兼容但缺索引签名，TS 不认，只能这样绕。
 * - `...(userId && { device_id: userId })`：条件展开。
 *   userId 为空时 `&&` 返回空值，展开空值等于什么都不做 → 这个字段就不存在。
 *   实现「有值才加这个字段」，比 Java 的 `if (x != null) map.put(...)` 紧凑。
 * - `catch { ... }`：可选 catch 绑定（不需要异常变量名）。≈ Java 的 `catch (Exception ignored)`。
 * - `void logEventTo1PAsync(...)`：`void` 前缀 = 故意不 await（fire-and-forget）。
 *   英文注释说明：不阻塞在元数据补充上，上报绝不能拖慢主流程。
 * - `const { accountUuid, organizationUuid } = getCoreUserData(true)`：对象解构取两个字段。
 * - `isEqual(newConfig, lastBatchConfig)`：lodash 的深比较。
 *   ≈ Java 的 `Objects.equals()` 只适用于浅比较，深比较要 Apache EqualsBuilder 或手写。
 * - `[ATTR_SERVICE_NAME]: 'claude-code'`：计算属性名（方括号里的表达式作为键）。
 *   ≈ Java 的 `map.put(ATTR_SERVICE_NAME, "claude-code")`。
 * - `MACRO.VERSION`：构建期宏（类似 C 的 #define），打包时被替换成实际版本号字符串。
 *   Java 里对应 Maven/Gradle 的资源过滤占位符。
 * - `batchConfig.scheduledDelayMillis || parseInt(...)`：`||` 做「没配就用默认值」，
 *   这里用 || 是安全的（0 毫秒没有意义）。
 * - `new LoggerProvider({ resource, processors: [...] })`：
 *   OTel 的标准构造方式，和 Java 版 OTel SDK 的 API 形状几乎一致。
 * - `isKilled: () => isSinkKilled('firstParty')`：传一个【函数】给 exporter，
 *   让它在每次发送前自行检查熔断状态。≈ Java 传一个 Supplier / Predicate。
 *   好处：exporter 不需要反向依赖本模块，且每次都能拿到最新状态。
 * - `async function` 里 `await oldProvider.forceFlush()`：
 *   forceFlush ≈ Java OTel 的 forceFlush()，把缓冲区立刻导出（不攒批等待）。
 * - `void oldProvider.shutdown().catch(() => {})`：后台关闭并吞掉异常。
 * - `profileCheckpoint('1p_event_logging_start')`：启动性能打点，用于分析启动耗时分布。
 */
import type { AnyValueMap, Logger, logs } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import { randomUUID } from 'crypto'
import { isEqual } from 'lodash-es'
import { getOrCreateUserID } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getPlatform, getWslVersion } from '../../utils/platform.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import { getCoreUserData } from '../../utils/user.js'
import { isAnalyticsDisabled } from './config.js'
import { FirstPartyEventLoggingExporter } from './firstPartyEventLoggingExporter.js'
import type { GrowthBookUserAttributes } from './growthbook.js'
import { getDynamicConfig_CACHED_MAY_BE_STALE } from './growthbook.js'
import { getEventMetadata } from './metadata.js'
import { isSinkKilled } from './sinkKillswitch.js'

/**
 * Configuration for sampling individual event types.
 * Each event name maps to an object containing sample_rate (0-1).
 * Events not in the config are logged at 100% rate.
 */
// 中文补充：采样配置的类型——事件名 → { sample_rate }。
// sample_rate = 0.01 表示「每一万条只留一百条」。没配的事件默认全量上报。
export type EventSamplingConfig = {
  [eventName: string]: {
    sample_rate: number
  }
}

// 采样配置也放在 GrowthBook 远程动态配置里，可以线上随时调整上报量（省钱/降载）。
const EVENT_SAMPLING_CONFIG_NAME = 'tengu_event_sampling_config'
/**
 * Get the event sampling configuration from GrowthBook.
 * Uses cached value if available, updates cache in background.
 */
// 读采样配置（带缓存，后台异步刷新）。见 growthbook.ts 里 _CACHED_MAY_BE_STALE 的含义。
export function getEventSamplingConfig(): EventSamplingConfig {
  return getDynamicConfig_CACHED_MAY_BE_STALE<EventSamplingConfig>(
    EVENT_SAMPLING_CONFIG_NAME,
    {},
  )
}

/**
 * Determine if an event should be sampled based on its sample rate.
 * Returns the sample rate if sampled, null if not sampled.
 *
 * @param eventName - Name of the event to check
 * @returns The sample_rate if event should be logged, null if it should be dropped
 */
// 采样判定：决定这条事件是不是要发。
// @param eventName 事件名
// @returns null = 全量上报（不用加采样率字段）；正数 = 被选中，返回采样率；0 = 丢弃
// 为什么返回「采样率」而不是布尔：后端需要知道采样率才能把收到的量还原成真实量级，
// 所以这个值会被写进 metadata 一起上报（在 sink.ts 里写入 sample_rate）。
// 关键步骤：
// ① 没配这个事件 → null（全量）
// ② 采样率非法（不是数字 / 不在 0~1）→ null（当作全量，fail-open）
// ③ >= 1 → null（全量，且不需要记采样率）
// ④ <= 0 → 0（全丢）
// ⑤ 其余 → 抛随机数决定，中了返回采样率、没中返回 0
export function shouldSampleEvent(eventName: string): number | null {
  const config = getEventSamplingConfig()
  const eventConfig = config[eventName]

  // If no config for this event, log at 100% rate (no sampling)
  if (!eventConfig) {
    return null
  }

  const sampleRate = eventConfig.sample_rate

  // Validate sample rate is in valid range
// 非法值按「全量」处理（fail-open）：宁可多收数据，也不要因为配置写错就静默丢光。
  if (typeof sampleRate !== 'number' || sampleRate < 0 || sampleRate > 1) {
    return null
  }

  // Sample rate of 1 means log everything (no need to add metadata)
// 采样率为 1 时不往 metadata 里塞 sample_rate——后端默认就是 1，没必要多传一个字段。
  if (sampleRate >= 1) {
    return null
  }

  // Sample rate of 0 means drop everything
  if (sampleRate <= 0) {
    return 0
  }

  // Randomly decide whether to sample this event
// Math.random() < sampleRate：经典的概率采样。这里不需要密码学随机，够快就行。
  return Math.random() < sampleRate ? sampleRate : 0
}

// 批处理参数（间隔、批大小、队列上限、重试次数、端点路径）同样来自 GrowthBook，可远程调节。
const BATCH_CONFIG_NAME = 'tengu_1p_event_batch_config'
type BatchConfig = {
  scheduledDelayMillis?: number
  maxExportBatchSize?: number
  maxQueueSize?: number
  skipAuth?: boolean
  maxAttempts?: number
  path?: string
  baseUrl?: string
}
function getBatchConfig(): BatchConfig {
  return getDynamicConfig_CACHED_MAY_BE_STALE<BatchConfig>(
    BATCH_CONFIG_NAME,
    {},
  )
}

// Module-local state for event logging (not exposed globally)
// 三个模块级状态：OTel 的 logger、provider，以及「上次用的批处理配置」（用于判断是否需要重建）。
// 注意都是模块私有（没有 export），外部只能通过本文件暴露的函数间接操作。
let firstPartyEventLogger: ReturnType<typeof logs.getLogger> | null = null
let firstPartyEventLoggerProvider: LoggerProvider | null = null
// Last batch config used to construct the provider — used by
// reinitialize1PEventLoggingIfConfigChanged to decide whether a rebuild is
// needed when GrowthBook refreshes.
// 记住上次建管线时用的配置：GrowthBook 刷新后比对，变了才重建（避免无谓地反复重建）。
let lastBatchConfig: BatchConfig | null = null
/**
 * Flush and shutdown the 1P event logger.
 * This should be called as the final step before process exit to ensure
 * all events (including late ones from API responses) are exported.
 */
// 退出前的 flush：把缓冲区里还没攒够一批的事件全部发出去。
// 英文注释强调要在 process.exit() 之前【显式】调用——自动的 beforeExit 钩子来不及跑。
export async function shutdown1PEventLogging(): Promise<void> {
  if (!firstPartyEventLoggerProvider) {
    return
  }
  try {
    await firstPartyEventLoggerProvider.shutdown()
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('1P event logging: final shutdown complete')
    }
// 关闭失败也无所谓（已经要退出了），忽略即可。
  } catch {
    // Ignore shutdown errors
  }
}

/**
 * Check if 1P event logging is enabled.
 * Respects the same opt-outs as other analytics sinks:
 * - Test environment
 * - Third-party cloud providers (Bedrock/Vertex)
 * - Global telemetry opt-outs
 * - Non-essential traffic disabled
 *
 * Note: Unlike BigQuery metrics, event logging does NOT check organization-level
 * metrics opt-out via API. It follows the same pattern as Statsig event logging.
 */
// 一方上报是否启用：直接复用 config.ts 的总闸，保证「要么全关、要么全开」。
// 英文注释特别说明：这里【不】检查组织级别的指标开关（和 BigQuery 指标不同），
// 因为事件日志走的是和 Statsig 一样的规则。
export function is1PEventLoggingEnabled(): boolean {
  // Respect standard analytics opt-outs
  return !isAnalyticsDisabled()
}

/**
 * Log a 1st-party event for internal analytics (async version).
 * Events are batched and exported to /api/event_logging/batch
 *
 * This enriches the event with core metadata (model, session, env context, etc.)
 * at log time, similar to logEventToStatsig.
 *
 * @param eventName - Name of the event (e.g., 'tengu_api_query')
 * @param metadata - Additional metadata for the event (intentionally no strings, to avoid accidentally logging code/filepaths)
 */
// 异步实现：补元数据 → 组装 OTel 属性 → emit。
// @param metadata 事件自带字段（只允许 number/boolean/undefined，防误报字符串）
// 关键步骤：
// ① 调 getEventMetadata 补齐版本/平台/账号等通用元数据
// ② 组装 attributes：事件名、事件 ID（UUID）、核心元数据、用户元数据、事件元数据
// ③ 补 user_id（如有）
// ④ emit 给 OTel（之后由 BatchLogRecordProcessor 攒批、Exporter 发送）
async function logEventTo1PAsync(
  firstPartyEventLogger: Logger,
  eventName: string,
  metadata: Record<string, number | boolean | undefined> = {},
): Promise<void> {
  try {
    // Enrich with core metadata at log time (similar to Statsig pattern)
    const coreMetadata = await getEventMetadata({
      model: metadata.model,
      betas: metadata.betas,
    })

    // Build attributes - OTel supports nested objects natively via AnyValueMap
    // Cast through unknown since our nested objects are structurally compatible
    // with AnyValue but TS doesn't recognize it due to missing index signatures
// OTel 原生支持嵌套对象属性，不需要自己 JSON 序列化。
// `as unknown as AnyValueMap` 双重断言：结构上兼容但缺索引签名，TS 不认，只能绕一下。
    const attributes = {
      event_name: eventName,
// event_id 用 UUID：后端靠它做幂等去重（网络重试会产生重复投递）。
      event_id: randomUUID(),
      // Pass objects directly - no JSON serialization needed
      core_metadata: coreMetadata,
      user_metadata: getCoreUserData(true),
      event_metadata: metadata,
    } as unknown as AnyValueMap

    // Add user_id if available
    const userId = getOrCreateUserID()
    if (userId) {
      attributes.user_id = userId
    }

    // Debug logging when debug mode is enabled
// USER_TYPE=ant 是 Anthropic 内部员工的标记，只有他们才打这类详细调试日志（避免打扰普通用户）。
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `[ANT-ONLY] 1P event: ${eventName} ${jsonStringify(metadata, null, 0)}`,
      )
    }

    // Emit log record
// emit = 把一条日志记录交给 OTel 管线。之后就是 OTel 的事了（攒批 → 导出）。
    firstPartyEventLogger.emit({
      body: eventName,
      attributes,
    })
// 开发环境直接抛（方便开发者发现问题），生产环境静默吞掉（埋点绝不能影响用户）。
  } catch (e) {
    if (process.env.NODE_ENV === 'development') {
      throw e
    }
    if (process.env.USER_TYPE === 'ant') {
      logError(e as Error)
    }
    // swallow
  }
}

/**
 * Log a 1st-party event for internal analytics.
 * Events are batched and exported to /api/event_logging/batch
 *
 * @param eventName - Name of the event (e.g., 'tengu_api_query')
 * @param metadata - Additional metadata for the event (intentionally no strings, to avoid accidentally logging code/filepaths)
 */
// 同步入口：两道闸门（总闸 + 熔断）之后 fire-and-forget 转发给异步实现。
// 为什么这里不 await：logEvent 是被高频调用的，等待元数据补充（可能涉及 IO）会拖慢主流程。
export function logEventTo1P(
  eventName: string,
  metadata: Record<string, number | boolean | undefined> = {},
): void {
  if (!is1PEventLoggingEnabled()) {
    return
  }

// 第二道闸门：① logger 还没初始化好 ② 这个后端被远程熔断了 → 都直接丢弃。
  if (!firstPartyEventLogger || isSinkKilled('firstParty')) {
    return
  }

  // Fire and forget - don't block on metadata enrichment
  void logEventTo1PAsync(firstPartyEventLogger, eventName, metadata)
}

/**
 * GrowthBook experiment event data for logging
 */
// A/B 实验的「分组结果」事件：记录这个用户被分到了哪个实验的哪个组。
// 这是做数据分析的基础——没有分组记录，就无法评估实验效果。
export type GrowthBookExperimentData = {
  experimentId: string
  variationId: number
  userAttributes?: GrowthBookUserAttributes
  experimentMetadata?: Record<string, unknown>
}

// api.anthropic.com only serves the "production" GrowthBook environment
// (see starling/starling/cli/cli.py DEFAULT_ENVIRONMENTS). Staging and
// development environments are not exported to the prod API.
// 固定返回 'production'：api.anthropic.com 只提供生产环境的 GrowthBook 配置，
// 所以开发环境/预发环境无从选择，硬编码即可（英文注释给了原因）。
function getEnvironmentForGrowthBook(): string {
  return 'production'
}

/**
 * Log a GrowthBook experiment assignment event to 1P.
 * Events are batched and exported to /api/event_logging/batch
 *
 * @param data - GrowthBook experiment assignment data
 */
// 上报一次实验分组。步骤：① 两道闸门 ② 组装属性（条件展开，有值才带）③ emit。
// 注意 user_attributes 和 experiment_metadata 这里【做了 JSON 序列化】——
// 因为它们是任意结构，OTel 属性要求固定形状，所以先转成字符串。
export function logGrowthBookExperimentTo1P(
  data: GrowthBookExperimentData,
): void {
  if (!is1PEventLoggingEnabled()) {
    return
  }

  if (!firstPartyEventLogger || isSinkKilled('firstParty')) {
    return
  }

  const userId = getOrCreateUserID()
  const { accountUuid, organizationUuid } = getCoreUserData(true)

  // Build attributes for GrowthbookExperimentEvent
  const attributes = {
    event_type: 'GrowthbookExperimentEvent',
    event_id: randomUUID(),
    experiment_id: data.experimentId,
    variation_id: data.variationId,
// `...(userId && { device_id: userId })`：条件展开——userId 有值才加这个字段，
// 没有就连字段都不出现（而不是出现一个 undefined）。下游处理起来更干净。
    ...(userId && { device_id: userId }),
    ...(accountUuid && { account_uuid: accountUuid }),
    ...(organizationUuid && { organization_uuid: organizationUuid }),
    ...(data.userAttributes && {
      session_id: data.userAttributes.sessionId,
      user_attributes: jsonStringify(data.userAttributes),
    }),
    ...(data.experimentMetadata && {
      experiment_metadata: jsonStringify(data.experimentMetadata),
    }),
    environment: getEnvironmentForGrowthBook(),
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[ANT-ONLY] 1P GrowthBook experiment: ${data.experimentId} variation=${data.variationId}`,
    )
  }

  firstPartyEventLogger.emit({
    body: 'growthbook_experiment',
    attributes,
  })
}

const DEFAULT_LOGS_EXPORT_INTERVAL_MS = 10000
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 200
const DEFAULT_MAX_QUEUE_SIZE = 8192

/**
 * Initialize 1P event logging infrastructure.
 * This creates a separate LoggerProvider for internal event logging,
 * independent of customer OTLP telemetry.
 *
 * This uses its own minimal resource configuration with just the attributes
 * we need for internal analytics (service name, version, platform info).
 */
// 初始化整条一方上报管线。步骤：
// ① 总闸检查 ② 读批处理配置 ③ 构造 OTel resource（服务名/版本/WSL 信息）
// ④ 建 Exporter（firstPartyEventLoggingExporter）与 BatchLogRecordProcessor（攒批）
// ⑤ 建 LoggerProvider，并从【这个 provider】取 logger（不能用全局的，见下面 IMPORTANT 注释）
export function initialize1PEventLogging(): void {
  profileCheckpoint('1p_event_logging_start')
  const enabled = is1PEventLoggingEnabled()

  if (!enabled) {
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('1P event logging not enabled')
    }
    return
  }

  // Fetch batch processor configuration from GrowthBook dynamic config
  // Uses cached value if available, refreshes in background
// 批参数来自远程配置，好处是线上发现上报太频繁/太慢时可以远程调，不用发版。
  const batchConfig = getBatchConfig()
  lastBatchConfig = batchConfig
  profileCheckpoint('1p_event_after_growthbook_config')

  const scheduledDelayMillis =
    batchConfig.scheduledDelayMillis ||
    parseInt(
      process.env.OTEL_LOGS_EXPORT_INTERVAL ||
        DEFAULT_LOGS_EXPORT_INTERVAL_MS.toString(),
    )

  const maxExportBatchSize =
    batchConfig.maxExportBatchSize || DEFAULT_MAX_EXPORT_BATCH_SIZE

  const maxQueueSize = batchConfig.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE

  // Build our own resource for 1P event logging with minimal attributes
  const platform = getPlatform()
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: 'claude-code',
    [ATTR_SERVICE_VERSION]: MACRO.VERSION,
  }

  // Add WSL-specific attributes if running on WSL
  if (platform === 'wsl') {
    const wslVersion = getWslVersion()
    if (wslVersion) {
      attributes['wsl.version'] = wslVersion
    }
  }

// OTel 的 Resource：描述「这些日志来自谁」（服务名、版本等），后端据此区分来源。
  const resource = resourceFromAttributes(attributes)

  // Create a new LoggerProvider with the EventLoggingExporter
  // NOTE: This is kept separate from customer telemetry logs to ensure
  // internal events don't leak to customer endpoints and vice versa.
  // We don't register this globally - it's only used for internal event logging.
// 传入 isKilled 回调：让 exporter 每次发送前自己查熔断状态。
// 用「传函数」而不是「传值」，保证每次都是最新判断（不会建好之后就永远不更新）。
  const eventLoggingExporter = new FirstPartyEventLoggingExporter({
    maxBatchSize: maxExportBatchSize,
    skipAuth: batchConfig.skipAuth,
    maxAttempts: batchConfig.maxAttempts,
    path: batchConfig.path,
    baseUrl: batchConfig.baseUrl,
    isKilled: () => isSinkKilled('firstParty'),
  })
// 注意【没有】注册成全局 provider——刻意隔离，避免内部事件混进客户的 OTLP 遥测，反之亦然。
  firstPartyEventLoggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(eventLoggingExporter, {
        scheduledDelayMillis,
        maxExportBatchSize,
        maxQueueSize,
      }),
    ],
  })

  // Initialize event logger from our internal provider (NOT from global API)
  // IMPORTANT: We must get the logger from our local provider, not logs.getLogger()
  // because logs.getLogger() returns a logger from the global provider, which is
  // separate and used for customer telemetry.
// 必须从【自己的 provider】取 logger。用 logs.getLogger() 会拿到全局 provider 的 logger，
// 那是给客户遥测用的，混用会导致内部事件发到客户端点（数据事故）。
  firstPartyEventLogger = firstPartyEventLoggerProvider.getLogger(
    'com.anthropic.claude_code.events',
    MACRO.VERSION,
  )
}

/**
 * Rebuild the 1P event logging pipeline if the batch config changed.
 * Register this with onGrowthBookRefresh so long-running sessions pick up
 * changes to batch size, delay, endpoint, etc.
 *
 * Event-loss safety:
 * 1. Null the logger first — concurrent logEventTo1P() calls hit the
 *    !firstPartyEventLogger guard and bail during the swap window. This drops
 *    a handful of events but prevents emitting to a draining provider.
 * 2. forceFlush() drains the old BatchLogRecordProcessor buffer to the
 *    exporter. Export failures go to disk at getCurrentBatchFilePath() which
 *    is keyed by module-level BATCH_UUID + sessionId — unchanged across
 *    reinit — so the NEW exporter's disk-backed retry picks them up.
 * 3. Swap to new provider/logger; old provider shutdown runs in background
 *    (buffer already drained, just cleanup).
 */
// GrowthBook 配置刷新后调用：批参数变了就重建管线。
// 为什么需要它：长会话（比如跑几个小时的 agent）里，远程配置可能中途更新，
// 不重建的话新配置永远不生效。
// 防丢事件的三步设计（英文 Event-loss safety 讲得很细）：
// ① 先把 logger 置空 → 并发的 logEventTo1P 会因闸门直接返回（丢少量，但不会写进正在下线的 provider）
// ② forceFlush 把旧缓冲区排干；失败的会落盘，而落盘路径与 provider 无关，新 exporter 能接着重试
// ③ 换上新 provider/logger，旧的在后台 shutdown（缓冲区已排空，只是清理）
export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {
  if (!is1PEventLoggingEnabled() || !firstPartyEventLoggerProvider) {
    return
  }

  const newConfig = getBatchConfig()

// isEqual 是深比较：配置对象里每个字段都比对，没变就直接返回（避免无谓重建）。
  if (isEqual(newConfig, lastBatchConfig)) {
    return
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `1P event logging: ${BATCH_CONFIG_NAME} changed, reinitializing`,
    )
  }

  const oldProvider = firstPartyEventLoggerProvider
  const oldLogger = firstPartyEventLogger
// 先置空 logger：这个「切换窗口」内进来的上报会被闸门挡掉。
// 取舍：宁可丢几条，也不能把事件写进一个正在下线的 provider（那样既丢又乱）。
  firstPartyEventLogger = null

  try {
// forceFlush：把攒着的批次立刻导出，不等定时器。
    await oldProvider.forceFlush()
  } catch {
    // Export failures are already on disk; new exporter will retry them.
  }

  firstPartyEventLoggerProvider = null
  try {
    initialize1PEventLogging()
// 重建失败必须「还原旧 provider」：否则两个变量都成 null，
// 函数开头的 `!firstPartyEventLoggerProvider` 判断会永远直接返回，再也恢复不了。
  } catch (e) {
    // Restore so the next GrowthBook refresh can retry. oldProvider was
    // only forceFlush()'d, not shut down — it's still functional. Without
    // this, both stay null and the !firstPartyEventLoggerProvider gate at
    // the top makes recovery impossible.
    firstPartyEventLoggerProvider = oldProvider
    firstPartyEventLogger = oldLogger
    logError(e)
    return
  }

// 旧 provider 已在上面 forceFlush 过（缓冲区空了），这里只是后台清理资源，失败无所谓。
  void oldProvider.shutdown().catch(() => {})
}
