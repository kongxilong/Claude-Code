/**
 * 【一句话定位】「推荐好友送 guest pass（访客通行证）」功能：查资格、查已邀请名单、
 *           以及把结果缓存到磁盘（24 小时）。
 *
 * 【在架构中的位置】
 *   调用链：CLI 启动预热 → 本文件 prefetchPassesEligibility()
 *           → getCachedOrFetchPassesEligibility()（永不阻塞网络的主入口）
 *             → checkCachedPassesEligibility()（纯读盘，给 UI 用）
 *             → fetchAndStorePassesEligibility()（真正拉网络 + 落盘）
 *               → fetchReferralEligibility() / fetchReferralRedemptions()
 *                 → utils/teleport/api.ts（prepareApiRequest / getOAuthHeaders）
 *                 → axios.get → `${BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/*`
 *           → utils/config.ts（passesEligibilityCache 落盘）
 *   还有几个纯展示用的工具：getCachedReferrerReward() / getCachedRemainingPasses() / formatCreditAmount()。
 *
 * 【核心设计：永不阻塞网络】
 *   这是本文件最值得学的一点。查询资格的接口可能很慢，但它是启动路径上的旁路功能，
 *   绝不能拖慢 CLI 启动。所以策略是：
 *   ①有新鲜缓存 → 直接返回；
 *   ②缓存过期 → 返回**旧值**，同时后台发起刷新（stale-while-revalidate）；
 *   ③完全没缓存（冷启动）→ 返回 null 并后台拉取，本次会话该功能不可用，下次启动才生效。
 *   Java 类比：Guava Cache 的 refreshAfterWrite（异步刷新 + 返回旧值）。
 *
 * 【本文件包含什么】
 *   - CACHE_EXPIRATION_MS：缓存有效期（24h）。
 *   - fetchInProgress：模块级的「在途请求」Promise，用于合并并发调用。
 *   - fetchReferralEligibility() / fetchReferralRedemptions()：两个纯网络查询。
 *   - shouldCheckForPasses()：前置资格判断（有组织 + 订阅者 + Max 套餐）。
 *   - checkCachedPassesEligibility()：纯读缓存，返回「是否合格 + 是否需要刷新」。
 *   - CURRENCY_SYMBOLS / formatCreditAmount()：币种符号与金额格式化。
 *   - getCachedReferrerReward() / getCachedRemainingPasses()：从缓存里取展示字段。
 *   - fetchAndStorePassesEligibility()：拉网络 + 落盘（带并发去重）。
 *   - getCachedOrFetchPassesEligibility()：主入口。
 *   - prefetchPassesEligibility()：启动时预热。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `let fetchInProgress: Promise<ReferralEligibilityResponse | null> | null = null`：
 *      模块级可变状态。JS 模块是单例（整个进程只有一份），所以这个变量能跨调用保存。
 *      ≈ Java 的 static 字段。
 *   2. `Promise<T> | null`：既可能是 Promise 也可能是 null，用之前必须判空。
 *   3. `fetchInProgress = (async () => {...})()`：
 *      ★ 立即执行函数表达式（IIFE）。`(async () => {...})` 定义一个 async 箭头函数，
 *      最后那个 `()` 立刻调用它，所以整体得到一个**已经启动**的 Promise。
 *      这是「把异步任务存起来供别人复用」的关键写法。
 *      Java 类比：CompletableFuture.supplyAsync(...) 然后把 future 存到 static 字段。
 *   4. `const { timestamp, ...response } = cachedEntry`：
 *      ★ **剩余属性解构（rest destructuring）**。取出 timestamp，
 *      剩下的所有字段打包进 response 对象。
 *      用途：缓存条目 = 业务字段 + timestamp，返回给业务时要剥掉 timestamp。
 *      Java 没有对应语法（要手动 new 一个 DTO 逐个复制）。
 *   5. `response as ReferralEligibilityResponse`：`as X` ≈ **强制类型转换**，
 *      告诉编译器「相信我，它就是 X」。⚠️ 不做运行时检查（不像 Java 的 (X) 会抛 ClassCastException），
 *      TS 的 as 编译后就被删掉了，用错了运行时才发现。
 *   6. `Record<string, string>`：内置工具类型，≈ Map<String, String> / 一个键为 string 的对象。
 *   7. `CURRENCY_SYMBOLS[reward.currency] ?? `${reward.currency} ``：
 *      查不到符号就退化成「币种代码 + 空格」（比如显示成 `JPY 100`）。
 *   8. `void fetchAndStorePassesEligibility()`：void 表示故意不 await（fire-and-forget）。
 *   9. `finally { fetchInProgress = null }`：finally 跟 Java 一样，无论成功失败都执行，
 *      这里用来保证在途标记一定被清掉，不会永久卡住后续调用。
 *  10. 函数参数默认值 `campaign: ReferralCampaign = 'claude_code_guest_pass'`：
 *      ≈ Java 的方法重载，调用时可省略该参数。
 */
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getOauthAccountInfo,
  getSubscriptionType,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import type {
  ReferralCampaign,
  ReferralEligibilityResponse,
  ReferralRedemptionsResponse,
  ReferrerRewardInfo,
} from '../oauth/types.js'

// 24 小时：资格只在「订阅变动 / 实验分组变动」时才会变，一天一查足够。
// Cache expiration time: 24 hours (eligibility changes only on subscription/experiment changes)
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

// ★ 并发去重用的在途 Promise。场景：CLI 启动时可能有 5 个地方同时问「我能不能送 pass」，
// 如果不去重就会打出 5 个一模一样的 HTTP 请求。
// 存的是 Promise 本身，所以后到的调用者 `return fetchInProgress` 就能共享同一个结果。
// Java 类比：把 CompletableFuture 缓存进 static 字段做 single-flight。
// Track in-flight fetch to prevent duplicate API calls
let fetchInProgress: Promise<ReferralEligibilityResponse | null> | null = null

// 查「我有没有资格送 guest pass」。默认活动名 claude_code_guest_pass，
// 说明这套 referral 机制是按 campaign 分桶的，将来能开别的活动。
export async function fetchReferralEligibility(
  campaign: ReferralCampaign = 'claude_code_guest_pass',
): Promise<ReferralEligibilityResponse> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/eligibility`

  const response = await axios.get(url, {
    headers,
    params: { campaign },
    timeout: 5000, // 5 second timeout for background fetch
  })

  return response.data
}

// 查「我送出去了多少、被兑了多少」。注意超时给的是 10 秒（比 eligibility 的 5 秒长），
// 因为这个接口可能要聚合更多数据。
export async function fetchReferralRedemptions(
  campaign: string = 'claude_code_guest_pass',
): Promise<ReferralRedemptionsResponse> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/redemptions`

  const response = await axios.get<ReferralRedemptionsResponse>(url, {
    headers,
    params: { campaign },
    timeout: 10000, // 10 second timeout
  })

  return response.data
}

/**
 * Prechecks for if user can access guest passes feature
 */
// 前置资格：必须 ①有组织 ②是订阅用户 ③订阅类型是 max。
// 三个条件在本地就能判断，不用打网络——先本地挡一道，能省掉绝大多数无效请求。
// 末尾的 `!!(...)` 是把任意值强制转成 boolean 的惯用写法（Java：(boolean) 强转 / x != null）。
function shouldCheckForPasses(): boolean {
  return !!(
    getOauthAccountInfo()?.organizationUuid &&
    isClaudeAISubscriber() &&
    getSubscriptionType() === 'max'
  )
}

/**
 * Check cached passes eligibility from GlobalConfig
 * Returns current cached state and cache status
 */
// 纯同步、纯读缓存，专门给渲染路径用（不能 await）。
// 返回值把「合不合格」「要不要刷新」「有没有缓存」拆成三个布尔，
// 让 UI 能区分「明确不合格」和「还不知道」（后者可以显示 loading 或干脆不显示）。
export function checkCachedPassesEligibility(): {
  eligible: boolean
  needsRefresh: boolean
  hasCache: boolean
} {
// 前置资格不满足：三个 false，UI 直接不显示这个功能入口。
  if (!shouldCheckForPasses()) {
    return {
      eligible: false,
      needsRefresh: false,
      hasCache: false,
    }
  }

  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) {
    return {
      eligible: false,
      needsRefresh: false,
      hasCache: false,
    }
  }

  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]

  if (!cachedEntry) {
    // No cached entry, needs fetch
    return {
      eligible: false,
      needsRefresh: true,
      hasCache: false,
    }
  }

// 解构出 eligible 和 timestamp 两个字段。
// 等价 Java：boolean eligible = e.eligible; long timestamp = e.timestamp;
  const { eligible, timestamp } = cachedEntry
  const now = Date.now()
  const needsRefresh = now - timestamp > CACHE_EXPIRATION_MS

  return {
    eligible,
    needsRefresh,
    hasCache: true,
  }
}

// Record<string, string> ≈ Map<String, String>，币种代码 → 货币符号。
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  SGD: 'S$',
}

// 金额同样是「最小单位整数」存储，除以 100 得到元。
// `amount % 1 === 0` 判断是否为整数：是整数就不带小数位（$10），否则保留两位（$10.50）。
export function formatCreditAmount(reward: ReferrerRewardInfo): string {
  const symbol = CURRENCY_SYMBOLS[reward.currency] ?? `${reward.currency} `
  const amount = reward.amount_minor_units / 100
  const formatted = amount % 1 === 0 ? amount.toString() : amount.toFixed(2)
  return `${symbol}${formatted}`
}

/**
 * Get cached referrer reward info from eligibility cache
 * Returns the reward info if the user is in a v1 campaign, null otherwise
 */
// 从缓存里取「推荐人能拿到的奖励」。注意走的是同一个 passesEligibilityCache，
// 说明服务端把奖励信息塞进了 eligibility 响应里，不用再打一次接口。
export function getCachedReferrerReward(): ReferrerRewardInfo | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
// `?.` 两级可选链：没有 orgId → undefined；没有缓存条目 → undefined；
// 有条目但没这个字段 → undefined。三种情况都安全返回 null。
  return cachedEntry?.referrer_reward ?? null
}

/**
 * Get the cached remaining passes count from eligibility cache
 * Returns the number of remaining passes, or null if not available
 */
export function getCachedRemainingPasses(): number | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  return cachedEntry?.remaining_passes ?? null
}

/**
 * Fetch passes eligibility and store in GlobalConfig
 * Returns the fetched response or null on error
 */
// 真正拉网络并落盘的函数。调用它通常是 fire-and-forget（不 await）。
export async function fetchAndStorePassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  // Return existing promise if fetch is already in progress
// 已经在飞了 → 直接复用同一个 Promise，共享结果。这就是第 23 行那个变量的作用。
  if (fetchInProgress) {
    logForDebugging('Passes: Reusing in-flight eligibility fetch')
    return fetchInProgress
  }

  const orgId = getOauthAccountInfo()?.organizationUuid

  if (!orgId) {
    return null
  }

  // Store the promise to share with concurrent calls
// ★ IIFE：`(async () => {...})()`。外层括号包住 async 箭头函数，
// 末尾 `()` 立刻执行，于是右侧整体是一个「已经在跑的 Promise」。
// 必须先赋值给 fetchInProgress 再 return，否则并发的第二次调用会错过这个标记。
  fetchInProgress = (async () => {
    try {
      const response = await fetchReferralEligibility()

// 把响应原样展开、再补一个 timestamp，就是缓存条目。
// 好处：以后服务端加字段，客户端不用改代码就自动缓存上了。
      const cacheEntry = {
        ...response,
        timestamp: Date.now(),
      }

// 写盘。注意 `...current.passesEligibilityCache` 展开旧表再覆盖当前 org，
// 保证其它组织的缓存不被冲掉。
      saveGlobalConfig(current => ({
        ...current,
        passesEligibilityCache: {
          ...current.passesEligibilityCache,
          [orgId]: cacheEntry,
        },
      }))

      logForDebugging(
        `Passes eligibility cached for org ${orgId}: ${response.eligible}`,
      )

      return response
    } catch (error) {
      logForDebugging('Failed to fetch and cache passes eligibility')
      logError(error as Error)
      return null
// finally 里清标记：无论成功失败都必须清，
// 否则一次失败会让后续所有调用永远复用那个已经 reject 的 Promise。
    } finally {
      // Clear the promise when done
      fetchInProgress = null
    }
  })()

  return fetchInProgress
}

/**
 * Get cached passes eligibility data or fetch if needed
 * Main entry point for all eligibility checks
 *
 * This function never blocks on network - it returns cached data immediately
 * and fetches in the background if needed. On cold start (no cache), it returns
 * null and the passes command won't be available until the next session.
 */
// 【主入口】约定：这个函数**永不阻塞在网络上**，最坏情况也只是返回 null 或旧缓存。
export async function getCachedOrFetchPassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  if (!shouldCheckForPasses()) {
    return null
  }

  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) {
    return null
  }

  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  const now = Date.now()

  // No cache - trigger background fetch and return null (non-blocking)
  // The passes command won't be available this session, but will be next time
// 冷启动：直接返回 null（本次会话该功能不可用），后台去拉。
// 这是一个明确的取舍：宁可功能晚一会话可用，也不让 CLI 启动变慢。
  if (!cachedEntry) {
    logForDebugging(
      'Passes: No cache, fetching eligibility in background (command unavailable this session)',
    )
// `void` = 故意不 await，让它在后台跑完自己写盘，下次启动就能用上。
    void fetchAndStorePassesEligibility()
    return null
  }

  // Cache exists but is stale - return stale cache and trigger background refresh
// ★ stale-while-revalidate：缓存过期时**先返回旧值**，同时后台刷新。
// 这是缓存设计的经典模式，Guava/Caffeine 的 refreshAfterWrite 就是这个语义。
// 好处：用户永远不会因为缓存过期而多等一次网络往返。
  if (now - cachedEntry.timestamp > CACHE_EXPIRATION_MS) {
    logForDebugging(
      'Passes: Cache stale, returning cached data and refreshing in background',
    )
    void fetchAndStorePassesEligibility() // Background refresh
// ★ 剩余解构：把 timestamp 单独拎出来丢掉，其余字段打包成 response。
// 因为业务类型 ReferralEligibilityResponse 里没有 timestamp 这个字段，
// 直接把整个缓存条目返回出去会在下游造成类型不匹配。
// 末尾的 `as` 是因为展开出来的类型是推断的结构，编译器无法证明它完全等于目标类型，
// 需要人工断言一次（不做运行时检查）。
    const { timestamp, ...response } = cachedEntry
    return response as ReferralEligibilityResponse
  }

  // Cache is fresh - return it immediately
  logForDebugging('Passes: Using fresh cached eligibility data')
  const { timestamp, ...response } = cachedEntry
  return response as ReferralEligibilityResponse
}

/**
 * Prefetch passes eligibility on startup
 */
// 启动预热入口。内部同样是 fire-and-forget，不 await。
export async function prefetchPassesEligibility(): Promise<void> {
  // Skip network requests if nonessential traffic is disabled
// 隐私总开关：只允许必要流量时，连这种促销活动查询都不发。
  if (isEssentialTrafficOnly()) {
    return
  }

// 注意这里是 `void getCachedOrFetchPassesEligibility()` 而不是 await：
// 预热的目的只是「早点把缓存填上」，不需要等它完成。
  void getCachedOrFetchPassesEligibility()
}
