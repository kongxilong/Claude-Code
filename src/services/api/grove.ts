/**
 * 【一句话定位】Grove 功能（消费者条款/隐私政策更新的告知弹窗）的服务端读写层 + 磁盘缓存。
 *           Grove 本身是「通知用户新版条款生效、并让用户选择是否参与改进 Claude」的一个弹窗。
 *
 * 【在架构中的位置】
 *   调用链：UI 组件（Grove.tsx 弹窗、privacy-settings.tsx 隐私设置页）
 *           → 本文件 isQualifiedForGrove()（是否够格/要不要弹，永不阻塞网络）
 *             → fetchAndStoreGroveConfig()（后台拉取并落盘）
 *               → getGroveNoticeConfig()（拿 Grove 的 Statsig 配置，memoize 缓存）
 *           → 本文件 getGroveSettings()（读账户设置）
 *           → 本文件 updateGroveSettings()（用户改开关）/ markGroveNoticeViewed()（标记已看过）
 *           → 本文件 calculateShouldShowGrove()（纯函数：综合两个结果决定弹不弹）
 *           → 本文件 checkGroveForNonInteractive()（非交互模式下把提示打到 stderr）
 *     所有 HTTP 调用都走：utils/http.ts（getAuthHeaders / withOAuth401Retry）+ axios
 *     落盘走：utils/config.ts（getGlobalConfig / saveGlobalConfig）
 *
 * 【本文件包含什么】
 *   - GROVE_CACHE_EXPIRATION_MS：磁盘缓存有效期（24h）。
 *   - AccountSettings / GroveConfig：两类服务端数据结构。
 *   - ApiResult<T>：★ 本文件自己定义的 Result 类型（成功带 data / 失败无 data）。
 *   - getGroveSettings()：读账户设置（memoize 缓存，失败会主动清缓存）。
 *   - markGroveNoticeViewed() / updateGroveSettings()：两个写操作（写完清缓存）。
 *   - isQualifiedForGrove()：非阻塞主入口。
 *   - fetchAndStoreGroveConfig()：后台拉取落盘。
 *   - getGroveNoticeConfig()：读 Grove 配置（memoize）。
 *   - calculateShouldShowGrove()：纯判断函数（无 IO，最好测）。
 *   - checkGroveForNonInteractive()：非交互（`claude -p`）场景的提示与退出。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. ★ `export type ApiResult<T> = { success: true; data: T } | { success: false }`：
 *      **可辨识联合 + 泛型**。≈ Java 的 sealed interface Result<T> 有两个实现。
 *      妙处在于：判断 `if (result.success)` 之后，TS 自动知道 result 一定有 .data；
 *      写成 `if (!result.success) return` 之后，后面就能放心用 result.data。
 *      这叫「类型收窄」，编译器帮你省掉了 (Success) result 这种强转。
 *      为什么不用异常？因为这是 UI 渲染路径，失败是**预期内**的 Branch，不值得抛异常。
 *   2. `export const getGroveSettings = memoize(async (): Promise<...> => {...})`：
 *      lodash 的 memoize 把 async 函数包一层，返回的是**带缓存的函数对象**。
 *      注意：memoize 缓存的是它返回的 **Promise**，所以并发调用共享同一个 Promise。
 *      Java 类比：Caffeine.get(key, loader)，key 由参数决定（这里无参，所以只有一份）。
 *   3. `getGroveSettings.cache.clear?.()`：
 *      - lodash 给被 memoize 的函数挂了一个 `.cache` 属性（Map）；
 *      - `?.()` 是「可选调用」：方法不存在就不调用（不会因为类型不符而崩）。
 *      Java 类比：cache.invalidateAll()，但加了空安全。
 *   4. `async (): Promise<X> => {...}`：async 箭头函数，返回值自动被包成 Promise。
 *   5. `withOAuth401Retry(() => {...})`：传一个**同步**箭头函数，里面返回 axios 的 Promise，
 *      外部再 await。遇到 401 会刷新 token 并重跑这个函数。
 *   6. `const { a, b, c } = response.data`：解构赋值（Java 无对应语法，要三行 getter）。
 *   7. `domain_excluded ?? false` / `notice_is_grace_period ?? true`：
 *      空值合并给默认值。注意两个默认值**不同**：前者默认 false（不排除），
 *      后者默认 true（默认处于宽限期——即「出问题时不骚扰用户」的保守选择）。
 *   8. `const [settingsResult, configResult] = await Promise.all([...])`：
 *      ★ 数组解构 + Promise.all。≈ Java 的 CompletableFuture.allOf(...).join() 然后逐个 get()，
 *      但 TS 一行就能拿到两个结果，且是**并行**执行的。
 *   9. `config?.notice_is_grace_period as X`：先可选链再断言类型，
 *      `as` ≈ Java 强制转换（编译期，运行时不检查）。
 *  10. `return viewedAt === null || viewedAt === undefined`：显式区分两种空值，
 *      更简洁的等价写法是 `viewedAt == null`（宽松相等同时命中两者）。
 */
import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getOauthAccountInfo, isConsumerSubscriber } from 'src/utils/auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { isEssentialTrafficOnly } from 'src/utils/privacyLevel.js'
import { writeToStderr } from 'src/utils/process.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  getAuthHeaders,
  getUserAgent,
  withOAuth401Retry,
} from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

// 24 小时：跟 referral.ts / metricsOptOut.ts 的磁盘缓存策略一致（一天一查）。
// Cache expiration: 24 hours
const GROVE_CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

// 账户级设置（存在服务端）。grove_enabled 是三态：true/false/**null**——
// null 专门表示「用户还没做过选择」，这正是弹窗要出现的条件。
// Java 里要用 Boolean（包装类）才能表达这个三态，不能用 boolean。
export type AccountSettings = {
  grove_enabled: boolean | null
  grove_notice_viewed_at: string | null
}

// Grove 的功能配置（灰度/运营参数），由后端（Statsig）下发：
// domain_excluded：该域名/组织被排除（比如企业域不该弹这个消费者条款弹窗）；
// notice_is_grace_period：是否还处于「宽限期」（宽限期内只是告知，不强制）；
// notice_reminder_frequency：隔多少天再提醒一次。
export type GroveConfig = {
  grove_enabled: boolean
  domain_excluded: boolean
  notice_is_grace_period: boolean
  notice_reminder_frequency: number | null
}

/**
 * Result type that distinguishes between API failure and success.
 * - success: true means API call succeeded (data may still contain null fields)
 * - success: false means API call failed after retry
 */
// ★ 本文件自造的 Result 类型。为什么不用 undefined 表示失败？
// 因为「成功但 data 里字段是 null」和「请求失败」是两回事，必须区分——
// 下面 calculateShouldShowGrove 就靠它决定「API 挂了就不弹窗」。
export type ApiResult<T> = { success: true; data: T } | { success: false }

/**
 * Get the current Grove settings for the user account.
 * Returns ApiResult to distinguish between API failure and success.
 * Uses existing OAuth 401 retry, then returns failure if that doesn't help.
 *
 * Memoized for the session to avoid redundant per-render requests.
 * Cache is invalidated in updateGroveSettings() so post-toggle reads are fresh.
 */
// memoize 包一层：UI 每次重渲染都问「设置是啥」，不加缓存会打出成百上千个请求。
export const getGroveSettings = memoize(
  async (): Promise<ApiResult<AccountSettings>> => {
    // Grove is a notification feature; during an outage, skipping it is correct.
// 隐私总开关：Grove 只是个通知功能，故障期间直接跳过它是最正确的降级。
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
// 注意这个回调是**同步**函数但里面 return 了 Promise：
// withOAuth401Retry 需要能在 401 之后重新执行整个函数（重新读一次 authHeaders），
// 所以认证头的获取必须放在回调**内部**——跟 bootstrap.ts 里重读 token 是同一个道理。
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
        }
        return axios.get<AccountSettings>(
          `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getClaudeCodeUserAgent(),
            },
          },
        )
      })
      return { success: true, data: response.data }
    } catch (err) {
      logError(err)
// ★ 失败时主动清掉 memoize 缓存。注释解释得很清楚，这是一个**死锁**场景：
// 弹窗要渲染开关，就得 getGroveSettings 成功；而清缓存的唯一其它入口是
// updateGroveSettings（用户点开关）。如果失败被缓存住，用户就永远点不到开关，
// 也就永远无法清缓存 —— 一次网络抖动会把用户永久锁死。
// 教训：**不要缓存失败结果**，尤其是失败会导致无法重试的失败。
      // Don't cache failures — transient network issues would lock the user
      // out of privacy settings for the entire session (deadlock: dialog needs
      // success to render the toggle, toggle calls updateGroveSettings which
      // is the only other place the cache is cleared).
      getGroveSettings.cache.clear?.()
      return { success: false }
    }
  },
)

/**
 * Mark that the Grove notice has been viewed by the user
 */
// 告诉服务端「用户看过这个通知了」。服务端会改 grove_notice_viewed_at 字段。
export async function markGroveNoticeViewed(): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
      }
      return axios.post(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/grove_notice_viewed`,
        {},
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getClaudeCodeUserAgent(),
          },
        },
      )
    })
// ★ 写操作之后必须清缓存：这次写改的是服务端状态，
// 而 Grove.tsx 是靠读 grove_notice_viewed_at 决定弹不弹窗的。
// 不清缓存的话，同一次会话里组件重新挂载还会读到旧的 null，于是弹窗反复出现。
    // This mutates grove_notice_viewed_at server-side — Grove.tsx:87 reads it
    // to decide whether to show the dialog. Without invalidation a same-session
    // remount would read stale viewed_at:null and re-show the dialog.
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * Update Grove settings for the user account
 */
// 用户在隐私设置页里改开关。PATCH 语义（局部更新），只传一个字段。
export async function updateGroveSettings(
  groveEnabled: boolean,
): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
      }
      return axios.patch(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
        {
          grove_enabled: groveEnabled,
        },
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getClaudeCodeUserAgent(),
          },
        },
      )
    })
    // Invalidate memoized settings so the post-toggle confirmation
    // read in privacy-settings.tsx picks up the new value.
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * Check if user is qualified for Grove (non-blocking, cache-first).
 *
 * This function never blocks on network - it returns cached data immediately
 * and fetches in the background if needed. On cold start (no cache), it returns
 * false and the Grove dialog won't show until the next session.
 */
// 【非阻塞主入口】跟 referral.ts 的 getCachedOrFetchPassesEligibility 是同一套套路：
// 缓存优先、过期返回旧值 + 后台刷新、冷启动返回 false 且本次会话不弹窗。
export async function isQualifiedForGrove(): Promise<boolean> {
// 只有消费者订阅用户才涉及这个（企业用户走的是另一套条款流程）。
  if (!isConsumerSubscriber()) {
    return false
  }

// 缓存按 accountUuid 分桶（跟 referral 按 orgUuid 分桶同理），
// 避免一台机器切换账号后读到别人的配置。
  const accountId = getOauthAccountInfo()?.accountUuid
  if (!accountId) {
    return false
  }

  const globalConfig = getGlobalConfig()
  const cachedEntry = globalConfig.groveConfigCache?.[accountId]
  const now = Date.now()

  // No cache - trigger background fetch and return false (non-blocking)
  // The Grove dialog won't show this session, but will next time if eligible
// 冷启动：本次会话不弹窗，后台去拉，下次启动才生效。
// 这是「宁可功能迟到，也不让启动变慢」的取舍。
  if (!cachedEntry) {
    logForDebugging(
      'Grove: No cache, fetching config in background (dialog skipped this session)',
    )
    void fetchAndStoreGroveConfig(accountId)
    return false
  }

  // Cache exists but is stale - return cached value and refresh in background
// 过期但仍返回旧值（stale-while-revalidate），后台刷新。
  if (now - cachedEntry.timestamp > GROVE_CACHE_EXPIRATION_MS) {
    logForDebugging(
      'Grove: Cache stale, returning cached data and refreshing in background',
    )
    void fetchAndStoreGroveConfig(accountId)
    return cachedEntry.grove_enabled
  }

  // Cache is fresh - return it immediately
  logForDebugging('Grove: Using fresh cached config')
  return cachedEntry.grove_enabled
}

/**
 * Fetch Grove config from API and store in cache
 */
// 后台拉取 + 落盘。注意它是 async 但调用方用 `void` 不等待。
async function fetchAndStoreGroveConfig(accountId: string): Promise<void> {
  try {
    const result = await getGroveNoticeConfig()
    if (!result.success) {
      return
    }
    const groveEnabled = result.data.grove_enabled
    const cachedEntry = getGlobalConfig().groveConfigCache?.[accountId]
// 跟 overageCreditGrant.ts 一样的写法：值没变**且**时间戳还新鲜才跳过写盘，
// 否则只刷新时间戳（防止每次都触发网络请求）。
    if (
      cachedEntry?.grove_enabled === groveEnabled &&
      Date.now() - cachedEntry.timestamp <= GROVE_CACHE_EXPIRATION_MS
    ) {
      return
    }
    saveGlobalConfig(current => ({
      ...current,
      groveConfigCache: {
        ...current.groveConfigCache,
        [accountId]: {
          grove_enabled: groveEnabled,
          timestamp: Date.now(),
        },
      },
    }))
  } catch (err) {
    logForDebugging(`Grove: Failed to fetch and store config: ${err}`)
  }
}

/**
 * Get Grove Statsig configuration from the API.
 * Returns ApiResult to distinguish between API failure and success.
 * Uses existing OAuth 401 retry, then returns failure if that doesn't help.
 */
// 另一个 memoize 的请求：拿 Grove 的运营配置。
export const getGroveNoticeConfig = memoize(
  async (): Promise<ApiResult<GroveConfig>> => {
    // Grove is a notification feature; during an outage, skipping it is correct.
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
        }
        return axios.get<GroveConfig>(
          `${getOauthConfig().BASE_API_URL}/api/claude_code_grove`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getUserAgent(),
            },
// 3 秒超时，比一般的 5 秒更短——弹窗是锦上添花，慢了就直接不弹。
            timeout: 3000, // Short timeout - if slow, skip Grove dialog
          },
        )
      })

      // Map the API response to the GroveConfig type
// 解构出四个字段，下面重新组装（顺便补默认值）。
      const {
        grove_enabled,
        domain_excluded,
        notice_is_grace_period,
        notice_reminder_frequency,
      } = response.data

      return {
        success: true,
        data: {
          grove_enabled,
// ★ 两个默认值方向相反，值得注意：
// domain_excluded 默认 false（默认不排除，正常弹）；
// notice_is_grace_period 默认 true（默认当作宽限期，只温和告知）。
// 后者是「出错时选择对用户影响最小的那个分支」——安全降级的典型思路。
          domain_excluded: domain_excluded ?? false,
          notice_is_grace_period: notice_is_grace_period ?? true,
          notice_reminder_frequency,
        },
      }
    } catch (err) {
      logForDebugging(`Failed to fetch Grove notice config: ${err}`)
      return { success: false }
    }
  },
)

/**
 * Determines whether the Grove dialog should be shown.
 * Returns false if either API call failed (after retry) - we hide the dialog on API failure.
 */
// ★ 纯函数：不碰网络、不碰磁盘，三个入参全给齐就能算出结果。
// 这种函数最好写单元测试（不用 mock 任何东西），是本文件最值得测的一段。
// 判断顺序：
//   ①任一 API 失败 → 不弹；
//   ②用户已经做过选择（grove_enabled 不是 null）→ 不弹；
//   ③调用方强制要求显示 → 弹；
//   ④不在宽限期了（条款已生效，必须处理）→ 弹；
//   ⑤宽限期内 → 按提醒频率判断是否该再提醒一次；
//   ⑥从没看过 → 弹。
export function calculateShouldShowGrove(
  settingsResult: ApiResult<AccountSettings>,
  configResult: ApiResult<GroveConfig>,
  showIfAlreadyViewed: boolean,
): boolean {
  // Hide dialog on API failure (after retry)
  if (!settingsResult.success || !configResult.success) {
    return false
  }

  const settings = settingsResult.data
  const config = configResult.data

// `grove_enabled !== null` 就是「用户已选择」的判据——三态布尔的经典用法。
  const hasChosen = settings.grove_enabled !== null
  if (hasChosen) {
    return false
  }
  if (showIfAlreadyViewed) {
    return true
  }
  if (!config.notice_is_grace_period) {
    return true
  }
  // Check if we need to remind the user to accept the terms and choose
  // whether to help improve Claude.
// 只在「配置了提醒频率」且「看过」的情况下才计算天数；
// 否则走 else 分支（从没看过就弹）。
  const reminderFrequency = config.notice_reminder_frequency
  if (reminderFrequency !== null && settings.grove_notice_viewed_at) {
// 时间差算天数：毫秒差 / (1000*60*60*24)，再向下取整。
// Math.floor 而不是 round：不足一天不算一天。
    const daysSinceViewed = Math.floor(
      (Date.now() - new Date(settings.grove_notice_viewed_at).getTime()) /
        (1000 * 60 * 60 * 24),
    )
    return daysSinceViewed >= reminderFrequency
  } else {
    // Show if never viewed before
    const viewedAt = settings.grove_notice_viewed_at
    return viewedAt === null || viewedAt === undefined
  }
}

// 非交互场景（比如 `claude -p` 跑脚本）：不能弹窗，只能往 stderr 打文字。
// 如果宽限期已过，那就不是「告知」而是「必须处理」，直接退出进程。
export async function checkGroveForNonInteractive(): Promise<void> {
// ★ Promise.all 并行发两个请求，再用数组解构一次拿两个结果。
// 并行而不是串行：省掉一半的等待时间。
// Java：CompletableFuture.allOf(a, b).join(); var x = a.join(); var y = b.join();
  const [settingsResult, configResult] = await Promise.all([
    getGroveSettings(),
    getGroveNoticeConfig(),
  ])

  // Check if user hasn't made a choice yet (returns false on API failure)
  const shouldShowGrove = calculateShouldShowGrove(
    settingsResult,
    configResult,
    false,
  )

  if (shouldShowGrove) {
    // shouldShowGrove is only true if both API calls succeeded
// 能走到这里说明两个 API 都成功了（calculateShouldShowGrove 为 true 的前提），
// 但 TS 的类型系统不知道这一点，所以还是要写三元判断来收窄类型。
    const config = configResult.success ? configResult.data : null
    logEvent('tengu_grove_print_viewed', {
      dismissable:
        config?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
// 宽限期还在 → 温和提示 + 标记已看过，程序继续跑；
// 宽限期已过 → 强制提示 + 退出（exit code 1）。
    if (config === null || config.notice_is_grace_period) {
      // Grace period is still active - show informational message and continue
      writeToStderr(
        '\nAn update to our Consumer Terms and Privacy Policy will take effect on October 8, 2025. Run `claude` to review the updated terms.\n\n',
      )
      await markGroveNoticeViewed()
    } else {
      // Grace period has ended - show error message and exit
      writeToStderr(
        '\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.\n\n',
      )
      await gracefulShutdown(1)
    }
  }
}
