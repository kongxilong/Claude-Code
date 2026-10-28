/**
 * 【一句话定位】判断当前组织是否开启了「指标上报 / metrics」，结果带两级缓存（磁盘 + 内存）。
 *
 * 【在架构中的位置】
 *   调用链：src/services/analytics/bigqueryExporter.ts（决定要不要把事件导出到 BigQuery）
 *           → 本文件 checkMetricsEnabled()
 *             → refreshMetricsStatus()（落盘）
 *               → memoizedCheckMetrics（内存 TTL 缓存，包住下面的函数）
 *                 → _checkMetricsEnabledAPI()
 *                   → utils/privacyLevel.ts（isEssentialTrafficOnly 总开关）
 *                   → utils/http.ts（getAuthHeaders / withOAuth401Retry）
 *                   → _fetchMetricsEnabled() → axios.get → api.anthropic.com/.../metrics_enabled
 *             → utils/config.ts（getGlobalConfig / saveGlobalConfig 读写磁盘缓存）
 *
 * 【为什么要两级缓存】CLI 可能被高频启动（脚本里循环 `claude -p`），
 *   如果每次都打这个接口，服务端会被打爆。所以要：
 *   ①磁盘缓存 24h：跨进程存活。命中新鲜磁盘缓存时**完全不打网络**（0 次请求）；
 *   ②内存缓存 1h：同一个进程内的多次调用只打一次。
 *
 * 【本文件包含什么】
 *   - MetricsEnabledResponse / MetricsStatus：响应与内部状态类型。
 *   - CACHE_TTL_MS / DISK_CACHE_TTL_MS：两级缓存的过期时间常量。
 *   - _fetchMetricsEnabled()：纯网络调用（无任何缓存）。
 *   - _checkMetricsEnabledAPI()：网络 + 错误降级。
 *   - memoizedCheckMetrics：上面那个函数的带缓存版本。
 *   - refreshMetricsStatus()：拿缓存结果并按需落盘。
 *   - checkMetricsEnabled()：唯一对外入口，先读盘后上网。
 *   - _clearMetricsEnabledCacheForTesting()：测试专用清缓存钩子。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `memoizeWithTTLAsync(fn, ttl)`：高阶函数——吃一个函数、吐一个带缓存的新函数。
 *      ≈ Java 里包一层 Caffeine/Guava Cache 的 get(key, loader)，只不过这里是
 *      「给函数加缓存」而不是「给值加缓存」。JS 里函数是一等公民，可以随便传来传去。
 *   2. `void refreshMetricsStatus().catch(logError)`：
 *      - `void X` 显式丢弃 Promise，表示「我故意不 await」（fire-and-forget，异步触发）。
 *      - `.catch(logError)`：把 logError 当回调函数传进去（Java：方法引用 this::logError）。
 *      - 必须 catch，否则 Promise 被拒绝会成为 unhandled rejection，可能让进程退出。
 *   3. `export const f = (): void => {...}`：箭头函数常量。
 *      ≈ Java 的 `Runnable f = () -> {...}`，注意 `(): void` 是返回类型标注。
 *   4. `cached !== undefined && cached.enabled === result.enabled`：
 *      TS 的 `===` 严格相等（不做类型转换），Java 里对对象而言 `==` 就是比较引用，
 *      但对基本类型要注意 JS 还有个会做转换的 `==`，本项目一律用 `===`。
 *   5. 下划线前缀 `_fetchMetricsEnabled` 只是命名约定，表示「内部用，别直接调」，
 *      语言层面没有 private 效果（仍可 export）。
 */
import axios from 'axios'
import { hasProfileScope, isClaudeAISubscriber } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getAuthHeaders, withOAuth401Retry } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { memoizeWithTTLAsync } from '../../utils/memoize.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

// 服务端响应体：只有一个布尔。
type MetricsEnabledResponse = {
  metrics_logging_enabled: boolean
}

// 对外统一的状态模型。为什么要有 hasError 字段？
// 因为「查询失败」和「查询成功且关闭」必须区分：前者不该被写进磁盘缓存
// （否则一次网络抖动会把正确的配置污染成关闭）。
type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

// 内存 TTL：1 小时。同一个 CLI 进程内多次调用只打一次网络。
// In-memory TTL — dedupes calls within a single process
const CACHE_TTL_MS = 60 * 60 * 1000

// 磁盘 TTL：24 小时。这是最有价值的一层——它把 N 次 `claude -p` 调用
// 折叠成「每天约 1 次 API 请求」。组织的开关极少变动，24h 足够新鲜。
// Disk TTL — org settings rarely change. When disk cache is fresher than this,
// we skip the network entirely (no background refresh). This is what collapses
// N `claude -p` invocations into ~1 API call/day.
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Internal function to call the API and check if metrics are enabled
 * This is wrapped by memoizeWithTTLAsync to add caching behavior
 */
// 最内层的纯网络函数：不带任何缓存、不做任何降级，
// 失败就抛（由外层统一处理）。这种「分层」写法让每一层职责单一。
async function _fetchMetricsEnabled(): Promise<MetricsEnabledResponse> {
  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const endpoint = `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled`
  const response = await axios.get<MetricsEnabledResponse>(endpoint, {
    headers,
    timeout: 5000,
  })
  return response.data
}

// 这一层负责「降级」：网络失败不能让整个调用链崩掉，
// 统一转成 { enabled: false, hasError: true }。
async function _checkMetricsEnabledAPI(): Promise<MetricsStatus> {
  // Incident kill switch: skip the network call when nonessential traffic is disabled.
  // Returning enabled:false sheds load at the consumer (bigqueryExporter skips
  // export). Matches the non-subscriber early-return shape below.
// 故障总开关：隐私模式（只发必要流量）下直接判定为关闭。
// 返回 enabled:false 的效果是让消费方（bigqueryExporter）跳过整批导出，
// 从而在服务端出事时能快速「甩负载」——这就是注释里说的 shed load。
  if (isEssentialTrafficOnly()) {
    return { enabled: false, hasError: false }
  }

  try {
// withOAuth401Retry：遇到 401 自动刷新 token 后重试一次。
// `also403Revoked: true` 是额外选项——403 且表示 token 被吊销时也走刷新重试。
// 传的是函数引用 `_fetchMetricsEnabled`（不带括号），Java 类比传方法引用。
    const data = await withOAuth401Retry(_fetchMetricsEnabled, {
      also403Revoked: true,
    })

    logForDebugging(
      `Metrics opt-out API response: enabled=${data.metrics_logging_enabled}`,
    )

    return {
      enabled: data.metrics_logging_enabled,
      hasError: false,
    }
  } catch (error) {
    logForDebugging(
      `Failed to check metrics opt-out status: ${errorMessage(error)}`,
    )
    logError(error)
// 关键：hasError=true，外层 refreshMetricsStatus 看到这个标记就不会写盘。
    return { enabled: false, hasError: true }
  }
}

// Create memoized version with custom error handling
// ★ 高阶函数：把 _checkMetricsEnabledAPI 包一层，得到一个带 1h 缓存的新函数。
// 调用方后面一律用 memoizedCheckMetrics，不用原函数。
const memoizedCheckMetrics = memoizeWithTTLAsync(
  _checkMetricsEnabledAPI,
  CACHE_TTL_MS,
)

/**
 * Fetch (in-memory memoized) and persist to disk on change.
 * Errors are not persisted — a transient failure should not overwrite a
 * known-good disk value.
 */
// 这一层负责「持久化」：把内存缓存的结果写到磁盘。
// 注意它不直接被 UI 调用，而是被下面的 checkMetricsEnabled 调用。
async function refreshMetricsStatus(): Promise<MetricsStatus> {
  const result = await memoizedCheckMetrics()
// 出错的结果坚决不落盘——一次网络抖动不该覆盖掉已经确认过的正确值。
  if (result.hasError) {
    return result
  }

  const cached = getGlobalConfig().metricsStatusCache
// 两个条件同时满足才跳过写盘：值没变 **且** 时间戳还新鲜。
// 只判「值没变」是不够的：如果磁盘条目已过期，虽然值一样，
// 也得把时间戳刷新一下，否则每个进程都会认为「过期了要刷新」，
// 于是反复触发网络请求 —— 缓存就白做了。
  const unchanged = cached !== undefined && cached.enabled === result.enabled
  // Skip write when unchanged AND timestamp still fresh — avoids config churn
  // when concurrent callers race past a stale disk entry and all try to write.
  if (unchanged && Date.now() - cached.timestamp < DISK_CACHE_TTL_MS) {
    return result
  }

  saveGlobalConfig(current => ({
    ...current,
    metricsStatusCache: {
      enabled: result.enabled,
      timestamp: Date.now(),
    },
  }))
  return result
}

/**
 * Check if metrics are enabled for the current organization.
 *
 * Two-tier cache:
 * - Disk (24h TTL): survives process restarts. Fresh disk cache → zero network.
 * - In-memory (1h TTL): dedupes the background refresh within a process.
 *
 * The caller (bigqueryExporter) tolerates stale reads — a missed export or
 * an extra one during the 24h window is acceptable.
 */
// 【对外唯一入口】两级缓存的调度都在这里。
export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  // Service key OAuth sessions lack user:profile scope → would 403.
  // API key users (non-subscribers) fall through and use x-api-key auth.
  // This check runs before the disk read so we never persist auth-state-derived
  // answers — only real API responses go to disk. Otherwise a service-key
  // session would poison the cache for a later full-OAuth session.
// ★ 这一行有一个很隐蔽的正确性要求：必须在读磁盘缓存**之前**判断。
// 因为「service key 缺 scope → 关闭」是**登录态推导出来的结论**，不是服务端答复，
// 绝不能写进磁盘缓存；否则一个 service-key 会话会把缓存写脏，
// 之后换回完整 OAuth 的会话读到的仍是错的 false。
  if (isClaudeAISubscriber() && !hasProfileScope()) {
    return { enabled: false, hasError: false }
  }

  const cached = getGlobalConfig().metricsStatusCache
// 磁盘缓存命中：直接返回，零网络。
  if (cached) {
// 缓存过期：后台异步刷新（fire-and-forget），本次仍返回旧值。
// 这样用户永远不会因为这个旁路请求而等待——宁可数据稍旧。
    if (Date.now() - cached.timestamp > DISK_CACHE_TTL_MS) {
      // saveGlobalConfig's fallback path (config.ts:731) can throw if both
      // locked and fallback writes fail — catch here so fire-and-forget
      // doesn't become an unhandled rejection.
// `void` + `catch` 是 fire-and-forget 的标准写法：
// void 表示「我故意不等它」，catch 是必须的（否则异常没人接，Node 会警告甚至退出）。
      void refreshMetricsStatus().catch(logError)
    }
    return {
      enabled: cached.enabled,
      hasError: false,
    }
  }

// 冷启动（本机第一次运行）：磁盘没缓存，只能阻塞等网络，把结果写下去。
  // First-ever run on this machine: block on the network to populate disk.
  return refreshMetricsStatus()
}

// Export for testing purposes only
// 下划线 + ForTesting 后缀：约定俗成的「仅测试使用」标记，业务代码不该调。
export const _clearMetricsEnabledCacheForTesting = (): void => {
  memoizedCheckMetrics.cache.clear()
}
