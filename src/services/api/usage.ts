/**
 * 【一句话定位】拉取当前组织/账号的「用量额度」信息（5 小时窗口、7 天窗口、额外用量等），
 *           对应 CLI 里 /usage 之类的展示。
 *
 * 【在架构中的位置】
 *   调用链：UI 层（用量展示组件、`/usage` 命令）
 *           → 本文件 fetchUtilization()
 *           → utils/auth.ts（isClaudeAISubscriber / hasProfileScope / getClaudeAIOAuthTokens）
 *           → services/oauth/client.ts（isOAuthTokenExpired）
 *           → utils/http.ts（getAuthHeaders）
 *           → axios.get → `${BASE_API_URL}/api/oauth/usage`
 *
 * 【本文件包含什么】
 *   - RateLimit：单个限额窗口（利用率 + 重置时间）。
 *   - ExtraUsage：额外用量（extra usage）开关与用量。
 *   - Utilization：整体用量视图，按模型/窗口分列。
 *   - fetchUtilization()：唯一导出函数，拿用量；不满足前置条件返回 {} 或 null。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `utilization: number | null`：联合类型 ≈ Java 的 @Nullable Double。
 *      TS 强制你在用它之前处理 null，否则 strictNullChecks 下编译不过——
 *      相当于把空指针检查提前到编译期。
 *   2. `resets_at?: string | null`：字段名后的 `?` 表示**可选属性**，
 *      等价于 `string | null | undefined`。Java 里没有语法对应，只能靠注释说明。
 *      注意 `?`（字段可以不存在）和 `| null`（字段存在但值为空）是两回事。
 *   3. `axios.get<Utilization>(url, {...})`：尖括号传「泛型参数」≈ Java 的 
 *      `<Utilization>` 泛型方法。作用：告诉编译器 response.data 是什么类型，
 *      之后 `response.data.five_hour` 才有代码提示和类型检查。
 *   4. 反引号模板字符串 `` `${x}/api/oauth/usage` `` ≈ Java 15+ 的文本块 / 
 *      String.format + 拼接。比 + 号拼接可读性更好。
 *   5. `throw new Error(...)`：跟 Java 完全一样，但 JS 的 Error 可以 throw 任何值；
 *      这里按惯例 throw Error 实例。
 */
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'
/**
 * 单个限额窗口。服务端用 sliding window（滑动窗口）限流，这里是窗口的当前状态。
 */

// utilization：窗口已用百分比，0~100。null = 服务端没给（Java 里千万别用 0 代替 null，
// 因为 0% 和「未知」语义不同）。
export type RateLimit = {
// resets_at：窗口重置时间，ISO 8601 字符串。JS 里日期通常先当字符串传，
// 真正要用时才 new Date() 解析——避免时区在序列化/反序列化时被改写。
  utilization: number | null // a percentage from 0 to 100
  resets_at: string | null // ISO 8601 timestamp
}
/**
 * 额外用量（extra usage）：配额用完后允许继续用、改成按量计费的那部分。
 * monthly_limit / used_credits 用「credits（积分）」而非 token 计数，
 * 因为不同模型单价不同，用金额粒度更容易统一。
 */

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}
/**
 * 整体用量视图。每个字段都是可选的：不同地层/套餐下服务端返回的字段不同，
 * 比如只有 Opus 用户才有 seven_day_opus。用 `?` 可选字段而不是填 null，
 * 是为了让「没有这个窗口」和「有窗口但值为空」能区分开。
 */

// five_hour：短窗口限额，防突发流量（相当于 Java 限流里的 QPS 桶）。
export type Utilization = {
// seven_day：长窗口限额，防持续超量使用（周级总量控制）。
  five_hour?: RateLimit | null
// seven_day_oauth_apps：专门针对 OAuth 应用身份的那一路调用单独限额。
  seven_day?: RateLimit | null
// seven_day_opus：Opus 模型单独一个窗口——因为 Opus 贵得多，
// 不能跟 Sonnet 共用一个池子。
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
}

/**
 * 取当前用量。返回 null 的两种情况要区分：
 *   - 返回 `{}`（空对象）：完全没资格查（非订阅者/没 profile scope），连试都不试；
 *   - 返回 `null`：本来有资格，但 token 过期了，这次查不了。
 * 调用方通常对这两种情况都「不展示用量区块」，所以语义上等价但便于排查问题。
 */
export async function fetchUtilization(): Promise<Utilization | null> {
// 两道前置门禁：不是订阅者、或者缺 profile scope。
// 后者很关键——service key 类型的 OAuth token 没有 user:profile scope，
// 打过去只会吃一个 403，不如本地直接挡掉（省一次网络往返，也避免服务端被打）。
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return {}
  }

// token 已过期就别打了：明知会 401。这里选择静默返回 null 而不是抛错，
// 因为 `/usage` 展示失败不值得让命令崩掉。
  // Skip API call if OAuth token is expired to avoid 401 errors
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    return null
  }

// Result 风格返回值：{ headers } | { error }，不抛异常。
  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

// 展开运算符拼 header：先固定 Content-Type / User-Agent，
// 再展开 authResult.headers（Authorization 等），后者可覆盖前者。
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 second timeout
// 5 秒超时：这是给用户看的展示型请求，宁可超时也不拖慢 UI。
  })

  return response.data
}
