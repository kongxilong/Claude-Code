/**
 * ============================================================================
 *  【文件总览】src/services/claudeAiLimits.ts —— 订阅额度（quota）状态追踪
 * ============================================================================
 *
 *  一句话定位：
 *  追踪「这个 Claude 订阅账号还能不能用、用了多少、什么时候重置」，
 *  并在额度快用完 / 已用完时通知 UI 显示提示。
 *  数据来源**不是**专门查一次接口，而是从**每次 API 响应头**里顺手读出来的。
 *
 *  在架构中的位置：
 *      src/services/api/claude.ts（每次 API 响应回来后）
 *        ├─> extractQuotaStatusFromHeaders(response.headers)  正常响应：读响应头
 *        └─> extractQuotaStatusFromError(error)               429 限流错误：读错误头
 *                                                              ↑ ★ 本文件
 *              ├─> computeNewLimitsFromHeaders()  把响应头解析成 ClaudeAILimits
 *              ├─> emitStatusChange()             通知所有监听者（触发 UI 更新）
 *              └─> processRateLimitHeaders()      ← ./rateLimitMocking.js（测试时注入伪造头）
 *
 *      UI 组件（状态栏 / 提示条）
 *        └─> useClaudeAiLimits()          ← ./claudeAiLimitsHook.js（React Hook 版订阅）
 *              └─> statusListeners        ← ★ 本文件导出的监听者集合
 *
 *      src/services/rateLimitMessages.ts ← 本文件把它的文案函数**转手再导出**，
 *                                          让调用方只 import 这一个模块即可
 *
 * ---------------------------------------------------------------------------
 *  【核心设计 1：为什么额度信息来自「响应头」而不是单独查接口】
 * ---------------------------------------------------------------------------
 *  如果要知道额度，最直观的做法是提供一个 `/quota` 接口去查。
 *  但那样每次想显示额度都要多一次网络请求。
 *  这里的做法是：**服务端把额度状态塞进每一次 API 响应的 HTTP 头里**
 *  （形如 `anthropic-ratelimit-unified-*` 的一堆头），
 *  客户端只要在每次响应回来时顺便读一下头，就能零成本地保持额度状态最新。
 *  ≈ Java 里服务端用响应头传递元数据（如 RateLimit-Limit / Retry-After）的升级版。
 *
 *  只有一种情况需要**主动发一次请求**：会话刚开始、还没发过任何请求时，
 *  界面想知道「我还有额度吗」。这时才走 checkQuotaStatus() → makeTestQuery()，
 *  发一个 max_tokens=1 的极小请求，纯粹为了读它的响应头。
 *
 * ---------------------------------------------------------------------------
 *  【核心设计 2：三层额度状态 + 超额（overage）机制】
 * ---------------------------------------------------------------------------
 *  QuotaStatus（额度状态）有三档，理解这个三档是理解本文件的关键：
 *      'allowed'          正常，随便用
 *      'allowed_warning'  还能用，但**快到上限了**（提前预警，让你心里有数）
 *      'rejected'         已经用完了，请求会被拒
 *
 *  overage（超额/额外用量）：主额度用完后，如果账号开通了「超额付费」，
 *  还能继续用（按量计费）。所以有独立的 overageStatus / isUsingOverage 字段。
 *  isUsingOverage 的判定逻辑是：主额度被拒 **且** 超额额度还允许。
 *
 * ---------------------------------------------------------------------------
 *  【核心设计 3：两种「提前预警」机制（本文件最复杂的部分）】
 * ---------------------------------------------------------------------------
 *  目标：在用户真的被限流**之前**就提醒他「你用得有点快」。
 *  实现了两套，前者优先、后者兜底：
 *
 *  ① **服务端判定**（getHeaderBasedEarlyWarning）：
 *     服务端直接返回一个 `...-surpassed-threshold` 头，说「你已越过第 N 档阈值」。
 *     最准，因为服务端掌握全局信息。
 *
 *  ② **客户端时间相对推算**（getTimeRelativeEarlyWarning）：
 *     老服务端不发上面那个头，只能客户端自己算。思路很聪明：
 *         如果「已用掉的比例」很高，而「时间才过了一点点」→ 说明消耗速度过快
 *     比如 7 天额度：才过了 15% 的时间（约 1 天）就用掉了 25% 的额度，
 *     照这个速度肯定撑不到第 7 天，于是提前预警。
 *     EARLY_WARNING_CONFIGS 里那三组阈值就是这个意思（越早发现越严）。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   1. 类型：QuotaStatus / RateLimitType / OverageDisabledReason / ClaudeAILimits
 *   2. EARLY_WARNING_CONFIGS      客户端推算用的阈值表
 *   3. getRateLimitDisplayName()  把限流类型转成给人看的文案
 *   4. computeTimeProgress()      算「时间窗口过去了百分之几」
 *   5. currentLimits / statusListeners / emitStatusChange()   全局状态 + 发布订阅
 *   6. getRawUtilization() / extractRawUtilization()  原始用量（给状态栏脚本用）
 *   7. makeTestQuery() / checkQuotaStatus()   主动探测额度（发一个极小的请求）
 *   8. getHeaderBasedEarlyWarning() / getTimeRelativeEarlyWarning() / getEarlyWarningFromHeaders()
 *                                             两种提前预警的实现
 *   9. computeNewLimitsFromHeaders()          响应头 → ClaudeAILimits（核心解析）
 *  10. extractQuotaStatusFromHeaders() / extractQuotaStatusFromError()  对外两个入口
 *  11. cacheExtraUsageDisabledReason()        把「超额为何被禁」写进全局配置（跨会话保留）
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `type RateLimitType = 'five_hour' | 'seven_day' | ...`
 *      **字符串字面量联合类型**。≈ Java 的 enum，但运行时就是普通字符串。
 *      好处：从 JSON / HTTP 头读来的字符串可以直接当这个类型用，无需转换。
 *
 *  - `Record<RateLimitType, string>`  工具类型：键为 RateLimitType、值为 string 的对象。
 *      ≈ Java 的 `EnumMap<RateLimitType, String>`，而且**强制每个键都必须有值**
 *      （少写一个编译器就报错，这是防漏的好设计）。
 *
 *  - `export let currentLimits: ClaudeAILimits = {...}`  用 `let` 导出的可变模块变量。
 *      注意：ES 模块的导出是「活绑定」，外部 import 后能读到最新值，
 *      但**不能直接赋值**。改它必须走本模块的 emitStatusChange()。
 *      ≈ Java 里 public static 字段，但通过 setter 收敛修改入口。
 *
 *  - `export { getRateLimitErrorMessage, ... } from './rateLimitMessages.js'`
 *      **转手再导出（re-export）**。本文件不实现这些函数，只是「代售」，
 *      让调用方只需要 import 本模块一个地方。≈ Java 里没有直接对应，
 *      可以想成「把别处的静态方法也在本类的 import 里列出来」。
 *
 *  - `for (const [key, abbrev] of [...] as const)`
 *      数组解构 + `as const`。`as const` 把数组元素类型锁成字面量，
 *      这样解出来的 key 才能安全地当对象的键用，而不是宽泛的 string。
 *
 *  - `headers.get(...) !== null`  Headers.get 在头不存在时返回 **null**。
 *      这是 Web 标准 API 的约定。所以本文件到处是 `!== null` 判断，
 *      然后用三元表达式在 undefined 和数值之间转换。
 *
 *  - `...(rateLimitType && { rateLimitType })`  **条件展开**（见 tokenEstimation.ts 说明）：
 *      只有头存在时才把这个字段放进对象，避免塞一个 null 进去。
 *
 *  - `(headers.get(...) as QuotaStatus) || 'allowed'`
 *      `as` 断言 + `||` 兜底。注意这里用 `||` 而非 `??`：
 *      空字符串 `''` 也算「没取到」，要兜底成 'allowed'。
 *
 *  - `?? null`  `headers.get()` 已经返回 null，`??` 把它统一成 null（显式化）。
 *
 *  - `saveGlobalConfig(current => ({ ...current, field: value }))`
 *      **不可变更新** + 回调式 setter：接收当前配置，返回新配置对象。
 *      ≈ Java 里 `config = Config.builder(config).field(value).build()`。
 *
 *  - `isEqual(currentLimits, newLimits)`  lodash 的**深比较**。
 *      ≈ Java 的 `Objects.equals()`，但会递归比较嵌套结构。
 *      为什么需要：每次 API 响应都会解析出新对象，若不加判断就广播，
 *      UI 会被无意义的重复刷新淹没。
 *
 *  - `error instanceof APIError`  和 Java 的 instanceof 完全一致。
 *
 *  - `globalThis.Headers`  显式引用全局的 Headers 类型，
 *      因为本项目里可能有多个 Headers 类型定义（Node / DOM / undici），写全限定名避免歧义。
 *
 *  - `type StatusChangeListener = (limits: ClaudeAILimits) => void`
 *      **函数类型别名**。≈ Java 的 `Consumer<ClaudeAILimits>` 函数式接口。
 * ============================================================================
 */
import { APIError } from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import isEqual from 'lodash-es/isEqual.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { isClaudeAISubscriber } from '../utils/auth.js'
import { getModelBetas } from '../utils/betas.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getSmallFastModel } from '../utils/model/model.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from './analytics/index.js'
import { logEvent } from './analytics/index.js'
import { getAPIMetadata } from './api/claude.js'
import { getAnthropicClient } from './api/client.js'
import {
  processRateLimitHeaders,
  shouldProcessRateLimits,
} from './rateLimitMocking.js'

// 转手再导出：本文件不实现这几个文案函数，只是「代售」rateLimitMessages 的，
// 这样调用方只 import 本模块一处就够了（facade 门面模式的简化版）。
// Re-export message functions from centralized location
export {
  getRateLimitErrorMessage,
  getRateLimitWarning,
  getUsingOverageText,
} from './rateLimitMessages.js'

// 额度状态三档：正常 / 快到上限（预警）/ 已用完（会被拒）
type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'

type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage'

export type { RateLimitType }

/**
 * 一条「提前预警」阈值。含义是：
 * 当「已用比例 ≥ utilization」**且**「时间才过去 ≤ timePct」时，就该预警了。
 * 两个条件必须同时成立——只用了很多但时间也过去很多，那是正常节奏，不用管。
 */
type EarlyWarningThreshold = {
  utilization: number // 0-1 scale: trigger warning when usage >= this
  timePct: number // 0-1 scale: trigger warning when time elapsed <= this
}

type EarlyWarningConfig = {
  rateLimitType: RateLimitType
  claimAbbrev: '5h' | '7d'
  windowSeconds: number
  thresholds: EarlyWarningThreshold[]
}

// 中文补注：这张表是「客户端自己推算是否该预警」的阈值清单，按优先级从上到下检查。
// 只在服务端**没有**返回 surpassed-threshold 头时才会用到（兜底方案）。
// 核心思想：「用量比例高 + 时间才过去一点点 = 消耗速度过快，撑不到窗口结束」。
//
// 以 7 天窗口为例，三条阈值从松到严：
//   用了 25% 但时间才过 15%  → 预警（照这速度 4 天就见底）
//   用了 50% 但时间才过 35%  → 预警
//   用了 75% 但时间才过 60%  → 预警
// 5 小时窗口只设一档（90% / 72%），因为短窗口内波动大，阈值太密会误报。
// Early warning configurations in priority order (checked first to last)
// Used as fallback when server doesn't send surpassed-threshold header
// Warns users when they're consuming quota faster than the time window allows
const EARLY_WARNING_CONFIGS: EarlyWarningConfig[] = [
  {
    rateLimitType: 'five_hour',
    claimAbbrev: '5h',
    windowSeconds: 5 * 60 * 60,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    rateLimitType: 'seven_day',
    claimAbbrev: '7d',
    windowSeconds: 7 * 24 * 60 * 60,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
]

// 中文补注：把 HTTP 头里用的缩写（5h / 7d / overage）映射回内部的类型名。
// 因为头名是 `anthropic-ratelimit-unified-5h-...` 这种带缩写的格式。
// Maps claim abbreviations to rate limit types for header-based detection
const EARLY_WARNING_CLAIM_MAP: Record<string, RateLimitType> = {
  '5h': 'five_hour',
  '7d': 'seven_day',
  overage: 'overage',
}

// 限流类型 → 给人看的文案。Record<RateLimitType, string> 要求**每个类型都必须写**，
// 漏一个编译器就报错（这是把「枚举 → 文案」映射写全的保障）。
const RATE_LIMIT_DISPLAY_NAMES: Record<RateLimitType, string> = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  overage: 'extra usage limit',
}

/**
 * 把限流类型转成界面上显示的友好名称。
 *
 * 为什么需要：内部类型名是 `five_hour` 这种机器味十足的标识符，
 * 直接显示给用户看不懂，要换成 "session limit"。
 *
 * 最后 `|| type` 是兜底：万一将来服务端返回了新类型、这张表还没来得及补，
 * 至少显示原始值而不是空白。
 *
 * @param type 限流类型
 * @returns 友好名称；查不到时原样返回 type
 */
export function getRateLimitDisplayName(type: RateLimitType): string {
  return RATE_LIMIT_DISPLAY_NAMES[type] || type
}

/**
 * Calculate what fraction of a time window has elapsed.
 * Used for time-relative early warning fallback.
 * @param resetsAt - Unix epoch timestamp in seconds when the limit resets
 * @param windowSeconds - Duration of the window in seconds
 * @returns fraction (0-1) of the window that has elapsed
 */
/**
 * 中文说明：算出「这个时间窗口已经过去了百分之几」。
 *
 * 为什么需要：判断消耗速度是否过快，光看「用了多少」不够，
 * 必须结合「用了多长时间」——同样的 50% 用量，
 * 花了一整天还是花了一小时，含义完全不同。
 *
 * 算法：窗口起点 = 重置时刻 - 窗口长度，已过时间 = 现在 - 窗口起点，
 * 再除以窗口长度。最后 clamp 到 [0,1]，
 * 防止时钟不同步导致算出负数或大于 1 的怪值。
 *
 * @param resetsAt      额度重置的 Unix 时间戳（秒）
 * @param windowSeconds 窗口总长度（秒）
 * @returns 0~1 的小数，表示已过去的比例
 */
function computeTimeProgress(resetsAt: number, windowSeconds: number): number {
  const nowSeconds = Date.now() / 1000
  const windowStart = resetsAt - windowSeconds
  const elapsed = nowSeconds - windowStart
  return Math.max(0, Math.min(1, elapsed / windowSeconds))
}

// 中文补注：下面这一大串联合类型，是「超额用量（extra usage）为什么用不了」的原因码。
// 之所以细分这么多种，是因为不同原因要给用户**不同的引导**：
//   - out_of_credits            → 提示充值
//   - org_level_disabled        → 提示找管理员开通
//   - member_level_disabled     → 提示是账号级别被关了
//   - ..._zero_credit_limit     → 提示额度上限被设成了 0
// 全部由服务端的统一限流器（unified limiter）返回。
// Reason why overage is disabled/rejected
// These values come from the API's unified limiter
export type OverageDisabledReason =
  | 'overage_not_provisioned' // Overage is not provisioned for this org or seat tier
  | 'org_level_disabled' // Organization doesn't have overage enabled
  | 'org_level_disabled_until' // Organization overage temporarily disabled
  | 'out_of_credits' // Organization has insufficient credits
  | 'seat_tier_level_disabled' // Seat tier doesn't have overage enabled
  | 'member_level_disabled' // Account specifically has overage disabled
  | 'seat_tier_zero_credit_limit' // Seat tier has a zero credit limit
  | 'group_zero_credit_limit' // Resolved group limit has a zero credit limit
  | 'member_zero_credit_limit' // Account has a zero credit limit
  | 'org_service_level_disabled' // Org service specifically has overage disabled
  | 'org_service_zero_credit_limit' // Org service has a zero credit limit
  | 'no_limits_configured' // No overage limits configured for account
  | 'unknown' // Unknown reason, should not happen

/**
 * 一份完整的额度状态快照（本模块对外传递的核心数据结构）。
 * 大量字段是可选的（`?`），因为服务端只在有意义时才返回对应头。
 */
export type ClaudeAILimits = {
  status: QuotaStatus
  // unifiedRateLimitFallbackAvailable is currently used to warn users that set
  // their model to Opus whenever they are about to run out of quota. It does
  // not change the actual model that is used.
  unifiedRateLimitFallbackAvailable: boolean
  resetsAt?: number
  rateLimitType?: RateLimitType
  utilization?: number
  overageStatus?: QuotaStatus
  overageResetsAt?: number
  overageDisabledReason?: OverageDisabledReason
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

// 中文补注：全局唯一的「当前额度状态」。用 let 导出是为了让测试能直接改它，
// 但正常代码路径**必须**走 emitStatusChange() 修改，因为它还要广播给监听者。
// Exported for testing only
export let currentLimits: ClaudeAILimits = {
  status: 'allowed',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
}

/**
 * Raw per-window utilization from response headers, tracked on every API
 * response (unlike currentLimits.utilization which is only set when a warning
 * threshold fires). Exposed to statusline scripts via getRawUtilization().
 */
type RawWindowUtilization = {
  utilization: number // 0-1 fraction
  resets_at: number // unix epoch seconds
}
type RawUtilization = {
  five_hour?: RawWindowUtilization
  seven_day?: RawWindowUtilization
}
let rawUtilization: RawUtilization = {}

/**
 * 取出未经加工的原始用量数据。
 *
 * 为什么需要：currentLimits.utilization 只在「触发预警」时才会被设置，
 * 而状态栏脚本想在**任何时候**都显示「已用 37%」这种实时进度条。
 * 所以另外存一份「每次响应都更新、不做任何阈值判断」的原始数据。
 *
 * @returns 5 小时 / 7 天两个窗口的用量与重置时间
 */
export function getRawUtilization(): RawUtilization {
  return rawUtilization
}

/**
 * 从响应头里抽出原始用量数据。
 *
 * 为什么只取 5h 和 7d 两个窗口：这两个是订阅制的主要额度维度，
 * 其余（Opus/Sonnet 专属、overage）不在状态栏展示范围内。
 *
 * 为什么 `util !== null && reset !== null` 两个都要有才记：
 * 只有用量没有重置时间（或反之）的数据是不完整的，
 * 拿它算进度会出错，宁可记为「未知」。
 *
 * @param headers HTTP 响应头
 * @returns 抽出的用量数据；头缺失时对应字段为 undefined
 */
function extractRawUtilization(headers: globalThis.Headers): RawUtilization {
  const result: RawUtilization = {}
  for (const [key, abbrev] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const util = headers.get(
      `anthropic-ratelimit-unified-${abbrev}-utilization`,
    )
    const reset = headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)
    if (util !== null && reset !== null) {
      result[key] = { utilization: Number(util), resets_at: Number(reset) }
    }
  }
  return result
}

type StatusChangeListener = (limits: ClaudeAILimits) => void
export const statusListeners: Set<StatusChangeListener> = new Set()

/**
 * 更新全局额度状态并广播给所有监听者（本模块唯一的「写入口」）。
 *
 * 为什么需要：UI 需要「额度一变就立刻刷新」，而不是等下一次轮询。
 * 这里用最朴素的发布-订阅：维护一个监听器 Set，状态变化时逐个回调。
 * （React 侧的订阅封装见 claudeAiLimitsHook.ts）
 *
 * 关键步骤：
 *   ① 更新 currentLimits
 *   ② 逐个通知监听器（UI 收到后触发重渲染）
 *   ③ 顺便埋点上报「状态变了、还有几小时重置」，用于观察限流对用户的影响
 *
 * @param limits 新的额度状态
 */
export function emitStatusChange(limits: ClaudeAILimits) {
  currentLimits = limits
  statusListeners.forEach(listener => listener(limits))
  const hoursTillReset = Math.round(
    (limits.resetsAt ? limits.resetsAt - Date.now() / 1000 : 0) / (60 * 60),
  )

  logEvent('tengu_claudeai_limits_status_changed', {
    status:
      limits.status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    unifiedRateLimitFallbackAvailable: limits.unifiedRateLimitFallbackAvailable,
    hoursTillReset,
  })
}

/**
 * 发一个「极小的真实请求」，目的只是为了读它的响应头。
 *
 * 为什么需要：会话刚开始、还没发过任何请求时，界面想知道「我还剩多少额度」，
 * 此时没有任何响应头可读，只能主动发一次。
 *
 * 怎么把成本压到最低：
 *   ① 用最便宜的小快模型（getSmallFastModel）
 *   ② max_tokens: 1 —— 让它几乎不输出任何内容
 *   ③ 消息内容就一个词 'quota'
 *   ④ maxRetries: 0 —— 失败就失败，绝不多试（这只是一次探测）
 *
 * 为什么用 `.asResponse()` 而不是普通调用：
 * 普通 SDK 调用只返回解析后的消息体，**拿不到 HTTP 头**；
 * asResponse() 返回原始 Response 对象，才能读到我们关心的那些响应头。
 *
 * @returns 原始 HTTP 响应（含 headers）
 */
async function makeTestQuery() {
  const model = getSmallFastModel()
  const anthropic = await getAnthropicClient({
    maxRetries: 0,
    model,
    source: 'quota_check',
  })
  const messages: MessageParam[] = [{ role: 'user', content: 'quota' }]
  const betas = getModelBetas(model)
  // biome-ignore lint/plugin: quota check needs raw response access via asResponse()
  return anthropic.beta.messages
    .create({
      model,
      max_tokens: 1,
      messages,
      metadata: getAPIMetadata(),
      ...(betas.length > 0 ? { betas } : {}),
    })
    .asResponse()
}

/**
 * 主动探测一次额度（会话启动时调用）。
 *
 * 为什么平时不需要它：正常流程下每次 API 响应都会顺带把额度状态带回来，
 * 本函数只在「还没有任何响应可参考」的冷启动场景才真正发请求。
 *
 * 三道提前返回（都是为了避免做无意义的网络请求）：
 *   ① 用户设置了「仅必要流量」隐私档 → 不发
 *   ② 不是订阅用户（也没开 mock 测试）→ 额度概念不适用，不发
 *   ③ 非交互模式（-p 一行流）→ 紧接着就要发真实请求了，
 *      那次响应头自然会带上额度，没必要先浪费一次往返
 *
 * 出错时的处理：如果是 APIError（含 429 限流），
 * 反而是个**有效信号**——从错误头里照样能读出额度状态，所以交给
 * extractQuotaStatusFromError() 处理；其它错误则忽略。
 */
export async function checkQuotaStatus(): Promise<void> {
  // Skip network requests if nonessential traffic is disabled
  if (isEssentialTrafficOnly()) {
    return
  }

  // Check if we should process rate limits (real subscriber or mock testing)
  if (!shouldProcessRateLimits(isClaudeAISubscriber())) {
    return
  }

  // In non-interactive mode (-p), the real query follows immediately and
  // extractQuotaStatusFromHeaders() will update limits from its response
  // headers (claude.ts), so skip this pre-check API call.
  if (getIsNonInteractiveSession()) {
    return
  }

  try {
    // Make a minimal request to check quota
    const raw = await makeTestQuery()

    // Update limits based on the response
    extractQuotaStatusFromHeaders(raw.headers)
  } catch (error) {
    if (error instanceof APIError) {
      extractQuotaStatusFromError(error)
    }
  }
}

/**
 * Check if early warning should be triggered based on surpassed-threshold header.
 * Returns ClaudeAILimits if a threshold was surpassed, null otherwise.
 */
/**
 * 提前预警方案 ①：直接读服务端给的 `surpassed-threshold` 头。
 *
 * 为什么这是首选方案：服务端掌握全局数据和最新策略，
 * 由它判定「你已越过第 N 档阈值」比客户端自己推算更准、更能及时调整。
 *
 * 做法：遍历三种 claim（5h / 7d / overage），
 * 谁带了这个头就说明谁越过了阈值，立刻构造一条 allowed_warning 状态返回。
 *
 * @param headers HTTP 响应头
 * @param unifiedRateLimitFallbackAvailable 是否允许降级到其它模型
 * @returns 需要预警时返回完整状态；否则返回 null
 */
function getHeaderBasedEarlyWarning(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  // Check each claim type for surpassed threshold header
  for (const [claimAbbrev, rateLimitType] of Object.entries(
    EARLY_WARNING_CLAIM_MAP,
  )) {
    const surpassedThreshold = headers.get(
      `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`,
    )

    // If threshold header is present, user has crossed a warning threshold
    if (surpassedThreshold !== null) {
      const utilizationHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
      )
      const resetHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
      )

      const utilization = utilizationHeader
        ? Number(utilizationHeader)
        : undefined
      const resetsAt = resetHeader ? Number(resetHeader) : undefined

      return {
        status: 'allowed_warning',
        resetsAt,
        rateLimitType: rateLimitType as RateLimitType,
        utilization,
        unifiedRateLimitFallbackAvailable,
        isUsingOverage: false,
        surpassedThreshold: Number(surpassedThreshold),
      }
    }
  }

  return null
}

/**
 * Check if time-relative early warning should be triggered for a rate limit type.
 * Fallback when server doesn't send surpassed-threshold header.
 * Returns ClaudeAILimits if thresholds are exceeded, null otherwise.
 */
/**
 * 提前预警方案 ②（兜底）：客户端按「用量 vs 时间」自己推算。
 *
 * 什么时候会走到这里：老版本服务端不发 surpassed-threshold 头，
 * 只能靠客户端算。
 *
 * 核心逻辑（一句话）：**用得多 + 时间还早 = 消耗速度过快 = 该提醒了**。
 * 具体到 7 天窗口：才过了 15% 的时间就用掉 25% 额度，
 * 照这个速度第 4~5 天就会见底，所以现在就预警。
 *
 * 为什么两个头缺一个就直接返回 null：
 * 没有用量算不出比例，没有重置时间算不出时间进度，缺一不可。
 *
 * @param headers HTTP 响应头
 * @param config 该窗口的阈值配置
 * @param unifiedRateLimitFallbackAvailable 是否允许降级到其它模型
 * @returns 需要预警时返回完整状态；否则返回 null
 */
function getTimeRelativeEarlyWarning(
  headers: globalThis.Headers,
  config: EarlyWarningConfig,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  const { rateLimitType, claimAbbrev, windowSeconds, thresholds } = config

  const utilizationHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
  )
  const resetHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
  )

  if (utilizationHeader === null || resetHeader === null) {
    return null
  }

  const utilization = Number(utilizationHeader)
  const resetsAt = Number(resetHeader)
  const timeProgress = computeTimeProgress(resetsAt, windowSeconds)

  // Check if any threshold is exceeded: high usage early in the window
  const shouldWarn = thresholds.some(
    t => utilization >= t.utilization && timeProgress <= t.timePct,
  )

  if (!shouldWarn) {
    return null
  }

  return {
    status: 'allowed_warning',
    resetsAt,
    rateLimitType,
    utilization,
    unifiedRateLimitFallbackAvailable,
    isUsingOverage: false,
  }
}

/**
 * Get early warning limits using header-based detection with time-relative fallback.
 * 1. First checks for surpassed-threshold header (new server-side approach)
 * 2. Falls back to time-relative thresholds (client-side calculation)
 */
/**
 * 提前预警的总入口：先试服务端判定，不行再自己推算。
 *
 * 为什么要有两级：服务端能力是逐步上线的，
 * 在新旧服务端并存的过渡期，客户端必须两套都支持，
 * 否则连到老服务端就完全失去预警能力了。
 *
 * 顺序很重要：**服务端优先**。因为它的判定更权威，
 * 客户端那套只是没有服务端信号时的近似替代。
 *
 * @returns 需要预警时返回完整状态；否则返回 null（表示一切正常）
 */
function getEarlyWarningFromHeaders(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  // Try header-based detection first (preferred when API sends the header)
  const headerBasedWarning = getHeaderBasedEarlyWarning(
    headers,
    unifiedRateLimitFallbackAvailable,
  )
  if (headerBasedWarning) {
    return headerBasedWarning
  }

  // Fallback: Use time-relative thresholds (client-side calculation)
  // This catches users burning quota faster than sustainable
  for (const config of EARLY_WARNING_CONFIGS) {
    const timeRelativeWarning = getTimeRelativeEarlyWarning(
      headers,
      config,
      unifiedRateLimitFallbackAvailable,
    )
    if (timeRelativeWarning) {
      return timeRelativeWarning
    }
  }

  return null
}

/**
 * 本文件的**核心解析函数**：把一堆 HTTP 响应头翻译成结构化的额度状态。
 *
 * 为什么集中在这里：额度相关的头有十几个，
 * 分散在各处解析必然不一致，集中一处才能保证「头 → 状态」的映射唯一且可测。
 *
 * 关键步骤：
 *   ① 读状态头（allowed / allowed_warning / rejected），缺失时按 'allowed' 兜底
 *   ② 读重置时间、是否允许模型降级（fallback）
 *   ③ 读限流类型、超额额度状态、超额重置时间、超额被禁原因
 *   ④ 判定是否正在使用超额：主额度被拒 **但** 超额额度还允许
 *   ⑤ 如果主状态是正常/预警，再查一次「提前预警」，命中就直接返回预警状态
 *   ⑥ 组装返回；只把确实存在的字段塞进对象（用条件展开，避免塞 null）
 *
 * @param headers HTTP 响应头（已过 processRateLimitHeaders，可能含 mock 注入值）
 * @returns 解析出的完整额度状态
 */
function computeNewLimitsFromHeaders(
  headers: globalThis.Headers,
): ClaudeAILimits {
  const status =
    (headers.get('anthropic-ratelimit-unified-status') as QuotaStatus) ||
    'allowed'
  const resetsAtHeader = headers.get('anthropic-ratelimit-unified-reset')
  const resetsAt = resetsAtHeader ? Number(resetsAtHeader) : undefined
  const unifiedRateLimitFallbackAvailable =
    headers.get('anthropic-ratelimit-unified-fallback') === 'available'

  // Headers for rate limit type and overage support
  const rateLimitType = headers.get(
    'anthropic-ratelimit-unified-representative-claim',
  ) as RateLimitType | null
  const overageStatus = headers.get(
    'anthropic-ratelimit-unified-overage-status',
  ) as QuotaStatus | null
  const overageResetsAtHeader = headers.get(
    'anthropic-ratelimit-unified-overage-reset',
  )
  const overageResetsAt = overageResetsAtHeader
    ? Number(overageResetsAtHeader)
    : undefined

  // Reason why overage is disabled (spending cap or wallet empty)
  const overageDisabledReason = headers.get(
    'anthropic-ratelimit-unified-overage-disabled-reason',
  ) as OverageDisabledReason | null

  // Determine if we're using overage (standard limits rejected but overage allowed)
  const isUsingOverage =
    status === 'rejected' &&
    (overageStatus === 'allowed' || overageStatus === 'allowed_warning')

  // Check for early warning based on surpassed-threshold header
  // If status is allowed/allowed_warning and we find a surpassed threshold, show warning
  let finalStatus: QuotaStatus = status
  if (status === 'allowed' || status === 'allowed_warning') {
    const earlyWarning = getEarlyWarningFromHeaders(
      headers,
      unifiedRateLimitFallbackAvailable,
    )
    if (earlyWarning) {
      return earlyWarning
    }
    // No early warning threshold surpassed
    finalStatus = 'allowed'
  }

  return {
    status: finalStatus,
    resetsAt,
    unifiedRateLimitFallbackAvailable,
    ...(rateLimitType && { rateLimitType }),
    ...(overageStatus && { overageStatus }),
    ...(overageResetsAt && { overageResetsAt }),
    ...(overageDisabledReason && { overageDisabledReason }),
    isUsingOverage,
  }
}

/**
 * Cache the extra usage disabled reason from API headers.
 */
/**
 * 把「超额用量为啥用不了」这个原因码写进全局配置，跨会话保留。
 *
 * 为什么需要缓存：这个原因只有发请求时才会在响应头里出现。
 * 万一用户在**离线或刚启动**时打开设置界面，我们也要能解释
 * 「为什么超额选项是灰的」——所以要持久化下来。
 *
 * 为什么先比较再写（`if (cached !== reason)`）：
 * 写配置要落盘，是无谓的 I/O；值没变就别写。
 *
 * @param headers HTTP 响应头
 */
function cacheExtraUsageDisabledReason(headers: globalThis.Headers): void {
  // A null reason means extra usage is enabled (no disabled reason header)
  const reason =
    headers.get('anthropic-ratelimit-unified-overage-disabled-reason') ?? null
  const cached = getGlobalConfig().cachedExtraUsageDisabledReason
  if (cached !== reason) {
    saveGlobalConfig(current => ({
      ...current,
      cachedExtraUsageDisabledReason: reason,
    }))
  }
}

/**
 * 对外入口 ①：每次 API **正常响应**回来后调用，从响应头更新额度状态。
 *
 * 为什么需要：这是额度状态最主要的更新途径——零额外请求，顺手就更新了。
 *
 * 关键步骤：
 *   ① 不是订阅用户（也没开 mock）→ 清空既有额度状态并广播（防止残留旧状态骗人）
 *   ② 过一遍 processRateLimitHeaders：若用户用 /mock-limits 命令开了模拟，
 *      这里会把真实头替换成伪造头（测试专用，见 rateLimitMocking.ts）
 *   ③ 抽出原始用量（给状态栏用）
 *   ④ 解析出完整状态
 *   ⑤ 把超额被禁原因缓存进配置
 *   ⑥ **深比较**后只有真的变了才广播，避免 UI 被无意义的重复刷新淹没
 *
 * @param headers 本次 API 响应的 HTTP 头
 */
export function extractQuotaStatusFromHeaders(
  headers: globalThis.Headers,
): void {
  // Check if we need to process rate limits
  const isSubscriber = isClaudeAISubscriber()

  if (!shouldProcessRateLimits(isSubscriber)) {
    // If we have any rate limit state, clear it
    rawUtilization = {}
    if (currentLimits.status !== 'allowed' || currentLimits.resetsAt) {
      const defaultLimits: ClaudeAILimits = {
        status: 'allowed',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }
      emitStatusChange(defaultLimits)
    }
    return
  }

  // Process headers (applies mocks from /mock-limits command if active)
  const headersToUse = processRateLimitHeaders(headers)
  rawUtilization = extractRawUtilization(headersToUse)
  const newLimits = computeNewLimitsFromHeaders(headersToUse)

  // Cache extra usage status (persists across sessions)
  cacheExtraUsageDisabledReason(headersToUse)

  if (!isEqual(currentLimits, newLimits)) {
    emitStatusChange(newLimits)
  }
}

/**
 * 对外入口 ②：请求被 **429 限流** 时调用，从错误头更新额度状态。
 *
 * 为什么需要：被限流时压根没有正常响应可读，
 * 但错误信息里同样带着那些额度头（甚至更关键——它直接告诉我们「你被拒了」）。
 *
 * 关键步骤：
 *   ① 只处理订阅用户的 429 错误，其它一概不管
 *   ② 有头就照常解析（同正常响应路径）
 *   ③ **无论如何强制把 status 置为 'rejected'**——
 *      这是刻意的设计：即使服务端没给头，收到 429 就说明确实被拒了，
 *      不能因为「没解析出状态」就显示成一切正常
 *   ④ 变了才广播
 *
 * 整个函数包在 try/catch 里：解析头失败绝不能掩盖原始的 429 错误。
 *
 * @param error SDK 抛出的 APIError（仅处理 status === 429）
 */
export function extractQuotaStatusFromError(error: APIError): void {
  if (
    !shouldProcessRateLimits(isClaudeAISubscriber()) ||
    error.status !== 429
  ) {
    return
  }

  try {
    let newLimits = { ...currentLimits }
    if (error.headers) {
      // Process headers (applies mocks from /mock-limits command if active)
      const headersToUse = processRateLimitHeaders(error.headers)
      rawUtilization = extractRawUtilization(headersToUse)
      newLimits = computeNewLimitsFromHeaders(headersToUse)

      // Cache extra usage status (persists across sessions)
      cacheExtraUsageDisabledReason(headersToUse)
    }
    // For errors, always set status to rejected even if headers are not present.
    newLimits.status = 'rejected'

    if (!isEqual(currentLimits, newLimits)) {
      emitStatusChange(newLimits)
    }
  } catch (e) {
    logError(e as Error)
  }
}
