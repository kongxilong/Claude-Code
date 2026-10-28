/**
 * 【一句话定位】
 * Datadog 后端的具体上报实现：把事件攒成批（batch），每 15 秒或满 100 条打包 POST 到 Datadog 的
 * HTTP 日志接口。同时负责字段脱敏、降基数（cardinality reduction）与标签构造。
 *
 * 【在架构中的位置】
 * 调用链：
 *   sink.ts logEventImpl()（已做过采样和 PII 剥离）
 *     → 本文件 trackDatadogEvent()
 *       → metadata.ts getEventMetadata()（补充通用的环境/版本/账号等元数据）
 *       → config.ts isAnalyticsDisabled()（总闸）
 *       → Datadog HTTP 接口（https://http-intake.logs.us5.datadoghq.com/api/v2/logs）
 * 应用退出时：gracefulShutdown() → 本文件 shutdownDatadog()（强制 flush 剩余日志）。
 * 注意英文注释的提醒：不要直接调这里，统一走 analytics/index.ts 的 logEvent。
 *
 * 【为什么要「批量 + 定时」上报】
 * 每个事件单独发一个 HTTP 请求，在高频场景（一次会话几百个事件）下会：
 * ① 打满连接池 ② 拖慢主流程 ③ 烧钱。所以这里攒批：满 100 条立刻发，或每 15 秒发一次。
 * 这是所有埋点 SDK 的标准做法（Java 里对应 Micrometer/OTLP 的 BatchSpanProcessor）。
 *
 * 【本文件包含什么】
 * - DATADOG_LOGS_ENDPOINT / DATADOG_CLIENT_TOKEN / DEFAULT_FLUSH_INTERVAL_MS / MAX_BATCH_SIZE /
 *   NETWORK_TIMEOUT_MS：连接与批量策略常量。
 * - DATADOG_ALLOWED_EVENTS：白名单——只有名单里的事件名才允许上报（隐私/成本控制）。
 * - TAG_FIELDS：哪些字段要额外做成 Datadog 标签（便于检索聚合）。
 * - camelToSnakeCase()：驼峰转蛇命（Datadog 的字段命名约定）。
 * - type DatadogLog：单条日志的结构。
 * - logBatch / flushTimer / datadogInitialized：三个模块级状态。
 * - flushLogs() / scheduleFlush()：真正发送与定时调度。
 * - initializeDatadog() / shutdownDatadog()：初始化与优雅收尾。
 * - trackDatadogEvent()：主入口（构造日志 → 入批 → 触发 flush）。
 * - getUserBucket()：把用户 ID 哈希成 30 个桶之一（既保护隐私又降低基数）。
 * - getFlushIntervalMs()：flush 间隔（测试可覆盖）。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `import memoize from 'lodash-es/memoize.js'`：默认导入（default import）。
 *   ≈ Java 的 import，但 TS 里一个模块只能有一个 default 导出。
 * - `export const initializeDatadog = memoize(async (): Promise<boolean> => {...})`：
 *   把一个 async 箭头函数传给 memoize 包装，效果 = 「结果只算一次，之后直接返回缓存」。
 *   ≈ Java 的懒加载单例 / Guava Suppliers.memoize。
 * - `new Set([...])` + `.has(x)`：Set ≈ Java 的 HashSet，has ≈ contains。
 *   这里用它做「事件白名单」，O(1) 查找。
 * - `let flushTimer: NodeJS.Timeout | null = null`：定时器句柄，可能为 null。
 *   ≈ Java 的 `ScheduledFuture<?> flushTimer = null;`。
 * - `.unref()`：Node 特有。表示「这个定时器不要阻止进程退出」。
 *   不加的话，只要定时器还在，Node 进程就退不出去——CLI 工具必踩的坑。
 * - `let datadogInitialized: boolean | null = null`：三态（true/false/null=还没判断）。
 *   下面用 `if (initialized === null)` 判断，不能写成 `if (!initialized)`，
 *   否则 false 会被误当成「没初始化」而重复调用。
 * - `const logsToSend = logBatch; logBatch = []`：
 *   「先把引用交给局部变量，再换新数组」——这样后续新事件进的是新数组，
 *   不会和正在发送的这一批打架。≈ Java 里 swap 出一个待发送列表。
 * - 对象 rest 解构：`const { envContext, ...restMetadata } = metadata`：
 *   把 envContext 单独取出，其余所有字段收进 restMetadata。
 *   ≈ Java 没有对应语法（要手写一堆 getter）。这里是为了避免 envContext 既嵌套又平铺出现两次。
 * - 多层展开 `{ ...restMetadata, ...envContext, ...properties, userBucket: ... }`：
 *   按优先级从低到高依次覆盖，后面的覆盖前面的。这是「合并配置」的标准写法。
 * - `allData.toolName.startsWith('mcp__')`：字符串前缀判断 ≈ Java 的 startsWith。
 * - `shortName in MODEL_COSTS`：`in` 运算符判断对象是否有这个键。
 *   ≈ Java 的 `MODEL_COSTS.containsKey(shortName)`。
 * - `String(allData.status)` / `parseInt(hash.slice(0,8), 16)`：
 *   String() ≈ String.valueOf()；parseInt(s, 16) ≈ Integer.parseInt(s, 16)（第二个参数是进制）。
 * - `allData.version.replace(/^(\d+\.\d+\.\d+-dev\.\d{8})\.t\d+\.sha[a-f0-9]+$/, '$1')`：
 *   正则替换，`$1` 引用第一个捕获组。≈ Java 的 `s.replaceAll(regex, "$1")`。
 * - `delete allData.status`：删除对象属性。≈ Java 的 `map.remove("status")`。
 * - `[key: string]: unknown` 索引签名：DatadogLog 除了几个固定字段，还允许任意附加字段。
 * - `for (const [key, value] of Object.entries(allData))`：遍历对象的键值对并解构。
 *   ≈ Java 的 `for (Map.Entry<String,Object> e : map.entrySet())`。
 * - `TAG_FIELDS.filter(...).map(field => \`${camelToSnakeCase(field)}:${...}\`)`：
 *   filter + map 链式 ≈ Java Stream 的 filter().map()；模板字符串拼出 `key:value` 形式的标签。
 * - `tags.join(',')`：数组拼字符串 ≈ Java 的 String.join(",", list)。
 * - `process.env.NODE_ENV !== 'production'`：只在生产环境上报，开发和测试环境直接 return。
 * - 整个函数体包在 try/catch 里且只 logError：埋点绝不能影响主流程（fail-silent 原则）。
 */
import axios from 'axios'
import { createHash } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { getOrCreateUserID } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { MODEL_COSTS } from '../../utils/modelCost.js'
import { isAnalyticsDisabled } from './config.js'
import { getEventMetadata } from './metadata.js'

// Datadog 的 HTTP 日志接收端点（us5 区）。
const DATADOG_LOGS_ENDPOINT =
  'https://http-intake.logs.us5.datadoghq.com/api/v2/logs'
// 这是 Datadog 的【客户端令牌】（public token），只能「写入日志」不能读取，
// 所以硬编码在客户端里是可以接受的（类似 Google Analytics 的 measurement id）。
const DATADOG_CLIENT_TOKEN = 'pubbbf48e6d78dae54bceaa4acf463299bf'
// 15 秒攒一批。太短→请求太多；太长→进程退出时丢数据（所以退出时要 shutdownDatadog 强制 flush）。
const DEFAULT_FLUSH_INTERVAL_MS = 15000
// 单批最多 100 条，防止一次 POST 的 body 过大被服务端拒。
const MAX_BATCH_SIZE = 100
const NETWORK_TIMEOUT_MS = 5000

// 【事件白名单】——本文件最重要的隐私/成本控制机制。
// 只有在名单里的事件名才会被发到 Datadog。为什么需要它：
// ① 防止以后新增事件「自动」就流到第三方（必须有人显式加进来，等于一次 review）
// ② 控制成本（Datadog 按日志量收费）
// ③ 降低误报敏感信息的风险
// 用 Set 而不是数组：has() 是 O(1)，这个判断在每条事件上都会跑。
const DATADOG_ALLOWED_EVENTS = new Set([
  'chrome_bridge_connection_succeeded',
  'chrome_bridge_connection_failed',
  'chrome_bridge_disconnected',
  'chrome_bridge_tool_call_completed',
  'chrome_bridge_tool_call_error',
  'chrome_bridge_tool_call_started',
  'chrome_bridge_tool_call_timeout',
  'tengu_api_error',
  'tengu_api_success',
  'tengu_brief_mode_enabled',
  'tengu_brief_mode_toggled',
  'tengu_brief_send',
  'tengu_cancel',
  'tengu_compact_failed',
  'tengu_exit',
  'tengu_flicker',
  'tengu_init',
  'tengu_model_fallback_triggered',
  'tengu_oauth_error',
  'tengu_oauth_success',
  'tengu_oauth_token_refresh_failure',
  'tengu_oauth_token_refresh_success',
  'tengu_oauth_token_refresh_lock_acquiring',
  'tengu_oauth_token_refresh_lock_acquired',
  'tengu_oauth_token_refresh_starting',
  'tengu_oauth_token_refresh_completed',
  'tengu_oauth_token_refresh_lock_releasing',
  'tengu_oauth_token_refresh_lock_released',
  'tengu_query_error',
  'tengu_session_file_read',
  'tengu_started',
  'tengu_tool_use_error',
  'tengu_tool_use_granted_in_prompt_permanent',
  'tengu_tool_use_granted_in_prompt_temporary',
  'tengu_tool_use_rejected_in_prompt',
  'tengu_tool_use_success',
  'tengu_uncaught_exception',
  'tengu_unhandled_rejection',
  'tengu_voice_recording_started',
  'tengu_voice_toggled',
  'tengu_team_mem_sync_pull',
  'tengu_team_mem_sync_push',
  'tengu_team_mem_sync_started',
  'tengu_team_mem_entries_capped',
])

// 这些字段会额外做成 Datadog 的 tag。
// tag 的本质是「可检索、可聚合的索引列」，所以只挑枚举值少、查询常用的字段——
// 高基数字段（比如 user id）做成 tag 会把 Datadog 的索引撑爆。
const TAG_FIELDS = [
  'arch',
  'clientType',
  'errorType',
  'http_status_range',
  'http_status',
  'kairosActive',
  'model',
  'platform',
  'provider',
  'skillMode',
  'subscriptionType',
  'toolName',
  'userBucket',
  'userType',
  'version',
  'versionBase',
]

// 驼峰转蛇命：Datadog 生态（以及后端数仓）的字段命名惯例是 snake_case。
function camelToSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

// 单条日志结构。前五个是 Datadog 的保留字段，其余通过索引签名 [key: string]: unknown 自由扩展。
type DatadogLog = {
  ddsource: string
  ddtags: string
  message: string
  service: string
  hostname: string
  [key: string]: unknown
}

// 三个模块级状态（≈ Java 的 private static 字段）：待发送批次、定时器句柄、初始化结果三态。
let logBatch: DatadogLog[] = []
let flushTimer: NodeJS.Timeout | null = null
let datadogInitialized: boolean | null = null

// 真正发送：把当前批次「换出」后 POST 出去。
// 失败只记日志——埋点失败绝不能影响用户使用（fail-silent）。
async function flushLogs(): Promise<void> {
  if (logBatch.length === 0) return

// 关键点：先把 logBatch 的引用交给局部变量，再立刻换新数组。
// 这样 flush 期间新产生的事件会进新数组，不会和正在发的这批混在一起（也不会被误清空）。
  const logsToSend = logBatch
  logBatch = []

  try {
    await axios.post(DATADOG_LOGS_ENDPOINT, logsToSend, {
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': DATADOG_CLIENT_TOKEN,
      },
      timeout: NETWORK_TIMEOUT_MS,
    })
  } catch (error) {
    logError(error)
  }
}

// 定时 flush（幂等：已有定时器就不重复安排）。
function scheduleFlush(): void {
  if (flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushLogs()
// .unref() 是必须的：不加这个，Node 会因为「还有个定时器没跑完」而拒绝退出，
// CLI 就会出现「命令执行完了但进程卡住不退出」。
  }, getFlushIntervalMs()).unref()
}

// memoize 包装 = 只真正执行一次，后续调用直接返回缓存结果。
// ≈ Java 的懒加载单例（double-checked locking 的效果，但由 lodash 提供）。
// 返回 false 表示「本环境不该上报」。
export const initializeDatadog = memoize(async (): Promise<boolean> => {
  if (isAnalyticsDisabled()) {
    datadogInitialized = false
    return false
  }

  try {
    datadogInitialized = true
    return true
  } catch (error) {
    logError(error)
    datadogInitialized = false
    return false
  }
})

/**
 * Flush remaining Datadog logs and shut down.
 * Called from gracefulShutdown() before process.exit() since
 * forceExit() prevents the beforeExit handler from firing.
 */
// 优雅退出：清掉定时器 + 立刻把剩余日志发出去。
// 为什么必须显式调用：进程直接 exit 的话，还没攒够一批的日志就全丢了。
// 英文注释解释了原因：forceExit() 会让 beforeExit 钩子来不及触发，所以要在退出前手动 flush。
export async function shutdownDatadog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flushLogs()
}

// NOTE: use via src/services/analytics/index.ts > logEvent
// 主入口：把一条事件变成一条日志，塞进批次。
// @param eventName  事件名（必须在白名单里，否则直接丢弃）
// @param properties 事件自带的字段（只能是 boolean/number/undefined）
// 关键步骤：
// ① 四道闸门：非生产环境 / 第三方云 / 未初始化 / 不在白名单 → 直接返回
// ② 补元数据（getEventMetadata：版本、平台、账号等）并和 properties 合并
// ③ 降基数处理（MCP 工具名归一、模型名归一、dev 版本号截断）
// ④ status 改名为 http_status（避开 Datadog 保留字段）
// ⑤ 构造 tag 列表与日志对象，入批
// ⑥ 满 100 条立刻 flush，否则安排 15 秒后 flush
export async function trackDatadogEvent(
  eventName: string,
  properties: { [key: string]: boolean | number | undefined },
): Promise<void> {
// 第一道闸门：只有 production 构建才上报，开发/测试环境不污染线上数据。
  if (process.env.NODE_ENV !== 'production') {
    return
  }

  // Don't send events for 3P providers (Bedrock, Vertex, Foundry)
// 第二道闸门：Bedrock/Vertex/Foundry 第三方云客户的数据不出他们的云，一律不发给 Datadog。
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  // Fast path: use cached result if available to avoid await overhead
// 第三道闸门：初始化结果缓存。注意用 `=== null` 判断「还没判断过」，
// 不能写 `if (!initialized)`——false 是有效结果，不是「没结果」。
  let initialized = datadogInitialized
  if (initialized === null) {
    initialized = await initializeDatadog()
  }
// 第四道闸门：白名单。不在名单里的事件一律不发（详见 DATADOG_ALLOWED_EVENTS 的说明）。
  if (!initialized || !DATADOG_ALLOWED_EVENTS.has(eventName)) {
    return
  }

  try {
    const metadata = await getEventMetadata({
      model: properties.model,
      betas: properties.betas,
    })
    // Destructure to avoid duplicate envContext (once nested, once flattened)
// rest 解构：把 envContext 单独拿走，其余字段留在 restMetadata。
// 目的：envContext 是个嵌套对象，下面会把它【平铺】进最终载荷；
// 不解构走的话，同一个信息会以「嵌套 + 平铺」两种形式各出现一次，浪费字段还容易混淆。
    const { envContext, ...restMetadata } = metadata
// 按优先级依次展开合并：元数据 < 环境上下文 < 事件自带字段 < userBucket。
// 后面的覆盖前面的，所以事件自带字段优先级最高。
    const allData: Record<string, unknown> = {
      ...restMetadata,
      ...envContext,
      ...properties,
      userBucket: getUserBucket(),
    }

// 降基数（cardinality reduction）：MCP 工具名形如 mcp__xxx__yyy，每个插件都不一样，
// 直接上报会产生海量不同的 tag 值，把 Datadog 索引撑爆。统一归成 'mcp'。
    // Normalize MCP tool names to "mcp" for cardinality reduction
    if (
      typeof allData.toolName === 'string' &&
      allData.toolName.startsWith('mcp__')
    ) {
      allData.toolName = 'mcp'
    }

    // Normalize model names for cardinality reduction (external users only)
// 模型名也做归一：只保留已知模型名，未知的（比如内部测试模型）一律归成 'other'。
// 内部员工（USER_TYPE=ant）不做归一，方便他们按真实模型名排查问题。
    if (process.env.USER_TYPE !== 'ant' && typeof allData.model === 'string') {
// 先去掉尾部可能带的 [1m] 后缀（1M 上下文版本的标记），再取规范名。
      const shortName = getCanonicalName(allData.model.replace(/\[1m]$/i, ''))
      allData.model = shortName in MODEL_COSTS ? shortName : 'other'
    }

    // Truncate dev version to base + date (remove timestamp and sha for cardinality reduction)
    // e.g. "2.0.53-dev.20251124.t173302.sha526cc6a" -> "2.0.53-dev.20251124"
// dev 版本号形如 2.0.53-dev.20251124.t173302.sha526cc6a，
// 里面带时间戳和 git sha，每个开发者每个构建都不同 —— 典型的超高基数字段。
// 截断到 2.0.53-dev.20251124，只保留「版本 + 日期」。
    if (typeof allData.version === 'string') {
      allData.version = allData.version.replace(
        /^(\d+\.\d+\.\d+-dev\.\d{8})\.t\d+\.sha[a-f0-9]+$/,
        '$1',
      )
    }

    // Transform status to http_status and http_status_range to avoid Datadog reserved field
// status 是 Datadog 的保留字段（有内置语义），直接写会被覆盖或报错，
// 所以改名成 http_status，同时额外算一个 http_status_range（2xx/4xx/5xx）方便聚合告警。
    if (allData.status !== undefined && allData.status !== null) {
      const statusCode = String(allData.status)
      allData.http_status = statusCode

      // Determine status range (1xx, 2xx, 3xx, 4xx, 5xx)
// charAt(0) 取第一位数字，拼成 '4xx' 这种区间标签——告警规则按区间配比按具体码稳定得多。
      const firstDigit = statusCode.charAt(0)
      if (firstDigit >= '1' && firstDigit <= '5') {
        allData.http_status_range = `${firstDigit}xx`
      }

      // Remove original status field to avoid conflict with Datadog's reserved field
      delete allData.status
    }

    // Build ddtags with high-cardinality fields for filtering.
    // event:<name> is prepended so the event name is searchable via the
    // log search API — the `message` field (where eventName also lives)
    // is a DD reserved field and is NOT queryable from dashboard widget
    // queries or the aggregation API. See scripts/release/MONITORING.md.
    const allDataRecord = allData
// 构造 tag 列表。event:<名字> 放在最前面是刻意的：
// Datadog 里 message 字段是保留字段、不可用于查询/聚合，
// 所以必须把事件名额外做成一个 tag 才能按事件名检索。
    const tags = [
      `event:${eventName}`,
      ...TAG_FIELDS.filter(
        field =>
          allDataRecord[field] !== undefined && allDataRecord[field] !== null,
      ).map(field => `${camelToSnakeCase(field)}:${allDataRecord[field]}`),
    ]

    const log: DatadogLog = {
      ddsource: 'nodejs',
      ddtags: tags.join(','),
      message: eventName,
      service: 'claude-code',
      hostname: 'claude-code',
      env: process.env.USER_TYPE,
    }

    // Add all fields as searchable attributes (not duplicated in tags)
// 其余字段也全部写进日志体（作为可检索属性），但不重复进 tag——避免双倍占用。
    for (const [key, value] of Object.entries(allData)) {
      if (value !== undefined && value !== null) {
        log[camelToSnakeCase(key)] = value
      }
    }

// 入批。真正发送由 flush 触发（批量是性能与成本的关键）。
    logBatch.push(log)

    // Flush immediately if batch is full, otherwise schedule
// 满批立刻发（不等 15 秒），否则安排定时 flush。
    if (logBatch.length >= MAX_BATCH_SIZE) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      void flushLogs()
    } else {
      scheduleFlush()
    }
// 兜底 catch：构造日志过程中任何异常都不能冒出去影响主流程。
  } catch (error) {
    logError(error)
  }
}

const NUM_USER_BUCKETS = 30

/**
 * Gets a 'bucket' that the user ID falls into.
 *
 * For alerting purposes, we want to alert on the number of users impacted
 * by an issue, rather than the number of events- often a small number of users
 * can generate a large number of events (e.g. due to retries). To approximate
 * this without ruining cardinality by counting user IDs directly, we hash the user ID
 * and assign it to one of a fixed number of buckets.
 *
 * This allows us to estimate the number of unique users by counting unique buckets,
 * while preserving user privacy and reducing cardinality.
 */
// 「用户桶」：把用户 ID 做 SHA-256 后取前 8 位十六进制，对 30 取模，得到 0~29 的桶号。
// 目的（英文注释讲得很清楚）：告警时要统计「影响了多少用户」而不是「多少条事件」——
// 少量用户重试可能刷出海量事件。但直接存 user id 既侵犯隐私又高基数。
// 折中方案：哈希分桶，用「不同桶的数量」近似估算「不同用户数」，两边都照顾到。
// memoize：一个进程内只算一次（用户 ID 不会变）。
const getUserBucket = memoize((): number => {
  const userId = getOrCreateUserID()
  const hash = createHash('sha256').update(userId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % NUM_USER_BUCKETS
})

// flush 间隔允许用环境变量覆盖，主要是给测试用（不想等 15 秒）。
// `parseInt(...) || DEFAULT` 的 || 在这里是「解析失败（NaN）就用默认值」——
// NaN 是假值，所以 || 能兜住；0 也会被兜住，但 0 毫秒的间隔没意义，可以接受。
function getFlushIntervalMs(): number {
  // Allow tests to override to not block on the default flush interval.
  return (
    parseInt(process.env.CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS || '', 10) ||
    DEFAULT_FLUSH_INTERVAL_MS
  )
}
