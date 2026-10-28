/**
 * 【一句话定位】★ API 调用的「重试引擎」：把一次可能失败的模型调用包起来，
 *           按策略判断要不要重试、要不要换模型、要不要等更久，直到成功或彻底放弃。
 *
 * 【在架构中的位置】
 *   调用链：src/query.ts / src/services/api/claude.ts（要发请求时）
 *           → 本文件 withRetry()（★ 核心，一个 async generator）
 *             → getClient()（回调：拿一个 Anthropic client，可能要刷新鉴权）
 *             → operation(client, attempt, retryContext)（回调：真正发请求）
 *             → shouldRetry(error)（判断这个错误能不能重试）
 *             → getRetryDelay(attempt, retryAfter)（算退避时长）
 *             → sleep(...) + yield 一条系统消息（通知 UI「正在重试」）
 *             → 达到 529 上限 → throw FallbackTriggeredError（★ 触发模型降级）
 *             → 彻底放弃 → throw CannotRetryError
 *   相关模块：
 *     - ./errors.ts：REPEATED_529_ERROR_MESSAGE 等错误文案与分类
 *     - ./errorUtils.ts：extractConnectionErrorDetails（挖 ECONNRESET/EPIPE）
 *     - ../../utils/fastMode.js：fast mode 的降级与冷却
 *     - ../../utils/auth.js：OAuth/API key/AWS/GCP 各类鉴权刷新与缓存清理
 *
 * 【★ 重试策略总览（本文件最需要理解的部分）】
 *   哪些错误**可重试**：
 *     · 连接类错误（APIConnectionError）——网络抖动，可重试
 *     · 408 请求超时 / 409 锁超时
 *     · 429 限流 —— 但**订阅用户不重试**（他们的配额是硬性窗口，重试也没用），
 *       企业用户（通常按量付费）可以重试
 *     · 5xx 服务端错误（含 529 overloaded）
 *     · 401 —— 先清 API key 缓存 / 刷新 OAuth token 再重试
 *     · 403 且消息含「OAuth token has been revoked」——同上，刷新后重试
 *     · Bedrock / Vertex 的凭证失效 —— 清缓存后重试
 *     · max_tokens 超出上下文窗口（400）—— **调整 max_tokens 后**重试（不是盲目重试）
 *     · 服务端在 x-should-retry 头里明确说 true（并满足订阅类型条件）
 *   哪些错误**不可重试**：
 *     · /mock-limits 造出来的假错误（测试用）
 *     · x-should-retry: false（除非是内部用户遇到 5xx）
 *     · 其它 4xx（参数错误之类，重试一万次也是错）
 *
 * 【★ 退避（backoff）算法】
 *   基础公式（getRetryDelay）：
 *     baseDelay = min(BASE_DELAY_MS * 2^(attempt-1), maxDelayMs)   // 指数增长，默认封顶 32 秒
 *     jitter    = random() * 0.25 * baseDelay                      // 抖动，最多 +25%
 *     delay     = baseDelay + jitter
 *   为什么要加 jitter（抖动）？因为如果所有客户端都在同一时刻退避重试，
 *   会造成「惊群（thundering herd）」——服务端刚缓过来就又被一轮齐射打垮。
 *   加随机抖动能把重试请求在时间上摊开。这是分布式系统里非常标准的做法。
 *   另外：如果响应带了 Retry-After 头，就**直接听服务端的**（它的信息更准）。
 *
 * 【★ FallbackTriggeredError 什么时候抛】
 *   529（overloaded，服务端过载）是「服务端忙不过来」的信号。
 *   策略：连续遇到 529 达到 MAX_529_RETRIES（3 次）时，
 *     - 如果调用方指定了 fallbackModel → 抛 FallbackTriggeredError，
 *       由上层（claude.ts）换一个模型（比如从 Opus 换到 Sonnet）重来。
 *       ★ 注意它**不是**「再试一次」，而是「换个更可能有容量的模型从头来」，
 *       所以要用一个专门的错误类型向上传递信号，让调用方做**结构性**的改变。
 *     - 没有 fallbackModel 且是外部用户 → 抛 CannotRetryError 并带上
 *       REPEATED_529_ERROR_MESSAGE（让用户知道是服务端持续过载）。
 *   还有一个前提：只对「非订阅用户 + 非自定义 Opus 模型」计数，
 *   （或环境变量 FALLBACK_FOR_ALL_PRIMARY_MODELS 强制开启）。
 *
 * 【★ 为什么 withRetry 是 async generator（async function*）】
 *   它在重试等待期间会 `yield` 出一条 SystemAPIErrorMessage（「正在重试，还需 N 秒」），
 *   上层用 `for await (...)` 就能收到并显示在界面上。
 *   也就是说：它既是「重试循环」，又是「进度事件流」。
 *   Java 类比：返回一个 Flux<SystemAPIErrorMessage>，最终以 T 结束（Mono 的返回值）。
 *
 * 【本文件包含什么】
 *   - DEFAULT_MAX_RETRIES / BASE_DELAY_MS / MAX_529_RETRIES / FLOOR_OUTPUT_TOKENS：重试常量。
 *   - FOREGROUND_529_RETRY_SOURCES + shouldRetry529()：哪些来源允许重试 529。
 *   - PERSISTENT_* / HEARTBEAT_INTERVAL_MS + isPersistentRetryEnabled()：无人值守模式的持久重试。
 *   - isTransientCapacityError() / isStaleConnectionError()：两类特殊错误判定。
 *   - RetryContext / RetryOptions：重试上下文与配置类型。
 *   - CannotRetryError / FallbackTriggeredError：★ 两个自定义异常。
 *   - withRetry()：★ 主函数。
 *   - getRetryAfter() / getRetryDelay()：退避时长计算。
 *   - parseMaxTokensContextOverflowError()：解析上下文溢出错误并算出新的 max_tokens。
 *   - isFastModeNotEnabledError() / is529Error() / isOAuthTokenRevokedError() /
 *     isBedrockAuthError() / isVertexAuthError() / isGoogleAuthLibraryCredentialError()：各类错误判定。
 *   - handleAwsCredentialError() / handleGcpCredentialError()：清云厂商凭证缓存。
 *   - shouldRetry()：★ 可重试判定总表。
 *   - getDefaultMaxRetries() / getMaxRetries()：重试次数。
 *   - getRetryAfterMs() / getRateLimitResetDelayMs()：Retry-After 与配额重置时间。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. ★★ `export async function* withRetry<T>(...): AsyncGenerator<SystemAPIErrorMessage, T>`：
 *      **异步生成器（async generator）**。拆开看：
 *      - `async function*` = 异步 + 生成器。函数体里可以用 await，也可以用 yield。
 *      - `AsyncGenerator<Y, R>` = 每次 yield 出 Y 类型的值，最终 return 一个 R 类型的值。
 *      - 调用方写成 `for await (const msg of withRetry(...)) { ... }`，
 *        循环收 Y；循环结束后整个表达式的值就是 R。
 *      Java 类比：返回 Flux<Y>，并且用 `.then(...)` 拿到最终的 Mono<R>——
 *      Reactor 里要组合两个概念，TS 里一个语法就搞定了。
 *      ★ 对 Java 工程师来说这是本文件最大的思维差异点。
 *   2. `getClient: () => Promise<Anthropic>` / `operation: (client, attempt, ctx) => Promise<T>`：
 *      ★ 参数是**函数类型**（高阶函数）。withRetry 不知道怎么建 client、怎么发请求，
 *      只负责「重试」，具体动作由调用方以回调形式注入。
 *      Java 类比：传两个函数式接口（Supplier<CompletableFuture<Anthropic>> 和
 *      TriFunction<Anthropic, Integer, RetryContext, CompletableFuture<T>>）。
 *      这么设计的好处：重试逻辑完全跟业务逻辑解耦。
 *   3. `throw` 在 generator 里：会终止整个生成器（for await 会收到异常）。
 *   4. `yield createSystemAPIErrorMessage(...)`：产出一条「正在重试」的消息但不结束。
 *   5. `export class CannotRetryError extends Error`：自定义异常类。
 *      `constructor(public readonly originalError: unknown, public readonly retryContext: RetryContext)`：
 *      ★ **参数属性**——在构造参数前加 `public readonly` 会自动创建并赋值同名字段。
 *      Java 要写三行：字段声明 + 构造函数参数 + this.x = x。TS 一行搞定。
 *   6. `super(message)` / `this.name = 'RetryError'`：跟 Java 一样调用父类构造、设置属性。
 *      注意 JS 里必须手动设 name，否则日志里看到的都是 'Error'。
 *   7. `this.stack = originalError.stack`：保留原始堆栈（否则排查时只能看到重试这一层）。
 *   8. `new Set<QuerySource>([...])` + `.has(x)`：集合，≈ Java HashSet。
 *      `...(feature('X') ? (['y'] as const) : [])`：编译期开关决定是否往集合里加元素。
 *      `as const` 把数组收紧成字面量元组，才能满足 Set<QuerySource> 的类型要求。
 *   9. `error instanceof APIError && error.status === 401`：instanceof 与 Java 一致。
 *  10. `error.headers?.get('x-should-retry')`：可选链 + Headers.get。
 *      `?.get?.('...')`（见 getRateLimitResetDelayMs）是**双重可选**：
 *      headers 可能没有、get 方法也可能不是标准的 —— 防御得很彻底。
 *  11. `error.message?.includes('...') ?? false`：
 *      可选链得到 `boolean | undefined`，再用 `?? false` 兜成确定的 boolean。
 *      这是「把可能缺失的判断变布尔」的标准写法。
 *  12. `(error as { headers?: { 'retry-after'?: string } }).headers?.['retry-after']`：
 *      先断言成「可能有这个字段的形状」，再用可选链取值。
 *      `?.['key']` 是可选链 + 索引访问（key 带连字符必须用索引，不能用点号）。
 *  13. `for (let attempt = 1; attempt <= maxRetries + 1; attempt++)`：
 *      注意是 maxRetries **+1**：因为第一次执行不算「重试」，所以总尝试次数 = 重试次数 + 1。
 *  14. `while (remaining > 0) { ... remaining -= chunk }`：
 *      把一次长睡眠切成若干小段（心跳），每段中间 yield 一条消息。
 *  15. `Math.random() * 0.25 * baseDelay`：抖动（jitter）。
 *      `Math.min(a, b)` / `Math.max(a, b)` / `Math.pow(2, n)`：跟 Java 的 Math 完全一样。
 *  16. `options.signal?.aborted` + `throw new APIUserAbortError()`：
 *      AbortSignal 用于外部取消（用户 Ctrl-C）。sleep 也接受 signal，能立刻醒过来。
 *  17. `parseInt(x, 10)`：必须写第二个参数 10（十进制）。Java 的 Integer.parseInt 默认就是十进制。
 *  18. `Number.isFinite(x)`：判断是不是有限数字（NaN/Infinity 都返回 false）。
 *      Java：Double.isFinite。
 *  19. `const [a, b] = ...` 数组解构、`{ ...obj, ...(cond ? {k:v} : {}) }` 条件展开：都跟前面文件一致。
 *  20. `function getRetryDelay(attempt, retryAfterHeader?, maxDelayMs = 32000)`：
 *      `?` 可选参数 + 默认值参数，Java 要用重载实现。
 */
import { feature } from 'bun:bundle'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

// abortError 是一个工厂函数：sleep 被中断时用它造一个「用户中止」异常，
// 而不是普通的 Error —— 这样上层能区分「用户按了 Ctrl-C」和「真出错」。
// `const f = () => new X()` 是箭头函数的简写（函数体只有一句且是返回值）。
const abortError = () => new APIUserAbortError()

// 默认最多重试 10 次（总尝试次数 11 次）。可用环境变量 CLAUDE_CODE_MAX_RETRIES 覆盖。
const DEFAULT_MAX_RETRIES = 10
// FLOOR_OUTPUT_TOKENS：调整 max_tokens 时的下限，保证模型至少还能输出这么多 token，
// 否则「调整后能发出去」也毫无意义（马上就被截断）。
const FLOOR_OUTPUT_TOKENS = 3000
// 连续 529 达到 3 次就触发模型降级（fallback）。
const MAX_529_RETRIES = 3
// 退避基数 500ms（导出是为了让测试能校验退避曲线）。
export const BASE_DELAY_MS = 500

// ★ 这个白名单是「容量雪崩」场景下的重要保护，注释解释得很清楚：
// 只有「用户正在等着结果」的前台来源才重试 529。
// 其它来源（生成摘要、标题、建议、分类）立即放弃——因为在服务端过载时，
// 每次重试都会给网关带来 3~10 倍的放大效应，而这些失败用户根本看不见。
// 设计原则：**后台任务不参与重试放大**。新增来源默认不重试（保守）。
// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway. New sources
// default to no-retry — add here only if the user is waiting on the result.
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
// 安全分类器必须跑完，否则 auto-mode 的正确性没法保证，所以进白名单。
  // Security classifiers — must complete for auto-mode correctness.
  // yoloClassifier.ts uses 'auto_mode' (not 'yolo_classifier' — that's
  // type-only). bash_classifier is ant-only; feature-gate so the string
  // tree-shakes out of external builds (excluded-strings.txt).
  'auto_mode',
// ★ feature('BASH_CLASSIFIER')：编译期开关。
// 注释里特意说明用它的原因是：让这个字符串在没有该特性的构建里被 tree-shake 掉
//（外部构建不该出现内部功能名）。这是「编译期开关」的一个实用副作用。
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

// 未标注来源（undefined）默认**允许**重试（保守选择：宁可多试也别让主流程失败）。
function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → retry (conservative for untagged call paths)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// ===== 无人值守模式（unattended / persistent retry）=====
// 场景：后台跑的长任务（比如 CI 里），没人在旁边看着。
// 这时宁可一直等（重试 429/529 无限次），也不要轻易失败。
// 配套机制：
//   PERSISTENT_MAX_BACKOFF_MS  单次退避封顶 5 分钟
//   PERSISTENT_RESET_CAP_MS    总等待封顶 6 小时
//   HEARTBEAT_INTERVAL_MS      每 30 秒心跳一次（防止宿主判定会话空闲）
// CLAUDE_CODE_UNATTENDED_RETRY: for unattended sessions (ant-only). Retries 429/529
// indefinitely with higher backoff and periodic keep-alive yields so the host
// environment does not mark the session idle mid-wait.
// TODO（原注释保留）：目前靠 yield 系统消息来当心跳是权宜之计，
// 理想情况是有一条专门的心跳通道。
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

// 双重条件：编译期开关 + 运行时环境变量，两个都开了才算启用。
function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

// 「暂时性的容量问题」：529（过载）或 429（限流）。
// 只有这两类才配得上「无限重试」。
function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

// ★ 陈旧连接错误：ECONNRESET（连接被对端重置）/ EPIPE（管道破裂）。
// 典型原因：keep-alive 的连接池里有个连接已经被服务端关掉了，
// 我们拿来用就炸。解决办法是关掉 keep-alive 重新建连（见下面的 disableKeepAlive）。
function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

// RetryContext：会在重试之间**跨尝试传递**的可变上下文。
// maxTokensOverride 就是典型：第一次因为上下文溢出失败，第二次带上调整后的值。
export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
// initialConsecutive529Errors：允许调用方**预置** 529 计数器。
// 场景（注释里说了）：流式请求先 529 了，然后降级成非流式重试，
// 这时应该把流式那次的 529 计入总数，否则「总共几次 529 才降级」会不一致。
  initialConsecutive529Errors?: number
}

// ★ 自定义异常：表示「已经决定不再重试，这是最终结果」。
// 它带着 originalError（原始错误）和 retryContext（当时的上下文），
// 让上层能展示「为什么放弃」以及「当时用的是什么配置」。
// `public readonly originalError: unknown` 这种写法叫**参数属性**，
// TS 会自动生成同名字段并赋值——Java 要写三行（声明 + 参数 + 赋值）。
export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
// 注意这里 name 设成了 'RetryError'（跟类名不同）——是历史遗留，日志里要注意。
    this.name = 'RetryError'

    // Preserve the original stack trace if available
// ★ 保留原始堆栈：非常重要。否则所有失败的堆栈都指向 withRetry 这一行，
// 根本看不出是哪里出的错。Java 里对应做法是 `new RuntimeException(e)`（带 cause）。
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

// ★ 自定义异常：表示「该换模型了」的信号弹。
// 它不是「失败」，而是「请上层用另一个模型重新开始」——所以携带了原模型和新模型两个信息。
// 上层（claude.ts）捕获它之后会用 fallbackModel 重建请求。
export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

// ★★【主函数】异步生成器版本的重试包装。三个参数：
//   ①getClient：怎么造 client（回调，因为可能需要刷新鉴权后重建）；
//   ②operation：真正要重试的动作（回调，会被调用 1~N 次）；
//   ③options：重试配置。
// 返回值 AsyncGenerator<SystemAPIErrorMessage, T>：
//   过程中会 yield 若干条「正在重试」的系统消息，最终 return 一个 T（业务结果）。
// 用法（调用方）：
//   const it = withRetry(...)
//   for await (const msg of it) { 显示 msg }   // 收到的是重试进度
//   // 循环正常结束 = 生成器 return 了 T（但 for await 拿不到返回值，
//   //   所以实际上层会自己 break 或用别的方式取 —— 见 claude.ts）
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
// 重试次数：options 里指定优先，否则用默认（环境变量可覆盖）。
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
// 条件展开：只有启用了 fast mode 才把 fastMode 放进上下文。
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
// ★ 循环上界是 maxRetries + 1：第一次执行 + 最多 maxRetries 次重试。
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
// 每轮开头都检查取消信号：用户按了 Ctrl-C 就立刻放弃（不等当前重试）。
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // Capture whether fast mode is active before this attempt
    // (fallback may change the state mid-loop)
// 在本次尝试**之前**先记下 fast mode 是否生效——因为循环中间可能会被改掉，
// 后面判断「要不要走 fast mode 降级逻辑」要用这个快照。
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // Check for mock rate limits (used by /mock-limits command for Ant employees)
// 内部用户专用：/mock-limits 命令可以人为造一个限流错误来测试重试 UI。
      if (process.env.USER_TYPE === 'ant') {
        const mockError = checkMockRateLimitError(
          retryContext.model,
          wasFastModeActive,
        )
        if (mockError) {
          throw mockError
        }
      }

// ★ 什么时候需要**重建 client**（而不是复用）：
//   ①第一次调用（client 还是 null）；
//   ②401（token 过期）；
//   ③403 且提示 token 被吊销（别的进程已经刷新过了，我们这份作废）；
//   ④Bedrock / Vertex 的凭证失效；
//   ⑤ECONNRESET/EPIPE（连接池里有坏连接）。
// 为什么要重建？因为鉴权信息在 client 创建时就被固化进去了，
// 光改请求头不够，必须重新构造。
      // Get a fresh client instance on first attempt or after authentication errors
      // - 401 for first-party API authentication failures
      // - 403 "OAuth token has been revoked" (another process refreshed the token)
      // - Bedrock-specific auth errors (403 or CredentialsProviderError)
      // - Vertex-specific auth errors (credential refresh failures, 401)
      // - ECONNRESET/EPIPE: stale keep-alive socket; disable pooling and reconnect
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
// 灰度开关控制：只有开启时才在遇到陈旧连接时关掉 keep-alive，
// 这样可以先小范围验证「关掉 keep-alive 是否真的有效」。
// _CACHED_MAY_BE_STALE 后缀表示这个值可能是缓存里的旧值（不保证实时）。
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof APIError && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
      ) {
// 401 / token 被吊销：先主动触发一次 token 刷新，再重建 client。
        // On 401 "token expired" or 403 "token revoked", force a token refresh
        if (
          (lastError instanceof APIError && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
// 把「出错的那个 token」传给刷新函数：服务端能据此判断是不是真的需要刷新，
// 避免多个进程同时刷新互相踩踏。
          const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
        }
        client = await getClient()
      }

// ★ 成功就直接 return —— 生成器的 return 值就是最终的 T，
// 调用方的 for await 循环随之结束。
      return await operation(client, attempt, retryContext)
    } catch (error) {
// 把错误存到 lastError，下一轮开头要用到（判断要不要重建 client）。
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

// ===== fast mode 的降级策略（一段很讲究的逻辑）=====
// 遇到 429/529 时分两种处理：
//   A. 服务端给的 Retry-After 很短（< 20 秒）→ 等一会儿，
//      **保持 fast mode** 重试。原因：换模型会导致 prompt 缓存失效，
//      而短时间内重试能保住缓存（省下重建缓存的钱和时间）。
//   B. Retry-After 很长或没有 → 进入冷却，切回标准速度的模型。
//      （注释里管这个叫 avoid cache thrashing —— 避免缓存反复失效重建）
      // Fast mode fallback: on 429/529, either wait and retry (short delays)
      // or fall back to standard speed (long delays) to avoid cache thrashing.
      // Skip in persistent mode: the short-retry path below loops with fast
      // mode still active, so its `continue` never reaches the attempt clamp
      // and the for-loop terminates. Persistent sessions want the chunked
      // keep-alive path instead of fast-mode cache-preservation anyway.
// 持久重试模式下不走这条路径：注释解释得很清楚——这里的 continue 会跳过
// attempt 计数上限的判断，导致 for 循环提前结束，反而达不到「无限重试」的目的。
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // If the 429 is specifically because extra usage (overage) is not
        // available, permanently disable fast mode with a specific message.
// 服务端专门给的头：说明这次 429 是因为「超额用量（overage）不可用」。
// 这种情况不是等一等就能好的，直接永久关掉 fast mode。
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

// 读 Retry-After 头（服务端建议的重试等待时间）。
        const retryAfterMs = getRetryAfterMs(error)
// 短等待：sleep 后 continue —— 注意这里 **continue 不消耗 attempt 计数之外**的逻辑，
// 只是回到循环开头重来一次（attempt 已经在 for 里自增了）。
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // Short retry-after: wait and retry with fast mode still active
          // to preserve prompt cache (same model name on retry).
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // Long or unknown retry-after: enter cooldown (switches to standard
        // speed model), with a minimum floor to avoid flip-flopping.
// 长等待：进入冷却。取 max(服务端建议, 默认 30 分钟)，并且不低于 10 分钟下限。
// 下限的作用（注释里说了）：避免在两种速度之间来回抖动（flip-flopping）。
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
// 记录冷却到什么时候，以及原因（overloaded / rate_limit），供 UI 与后续判断使用。
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast mode fallback: if the API rejects the fast mode parameter
      // (e.g., org doesn't have fast mode enabled), permanently disable fast
      // mode and retry at standard speed.
// 另一种情况：服务端根本不支持 fast mode（返回 400 说没启用）。
// 这跟限流不同——是永久性的，所以直接关掉（handleFastModeRejectedByAPI）。
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // Non-foreground sources bail immediately on 529 — no retry amplification
      // during capacity cascades. User never sees these fail.
// ★ 后台来源遇到 529 立即放弃（见第 57 行白名单的说明），
// 并上报一条 tengu_api_529_background_dropped 事件用于统计被丢弃了多少。
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

// 连续 529 计数。注意条件：
//   · 环境变量 FALLBACK_FOR_ALL_PRIMARY_MODELS 强制开启；或
//   · 非订阅用户 且 用的是非自定义 Opus 模型。
// （原注释里还有一条 TODO 在反思这个 Opus 判断是不是历史遗留。）
      // Track consecutive 529 errors
      if (
        is529Error(error) &&
        // If FALLBACK_FOR_ALL_PRIMARY_MODELS is not set, fall through only if the primary model is a non-custom Opus model.
        // TODO: Revisit if the isNonCustomOpusModel check should still exist, or if isNonCustomOpusModel is a stale artifact of when Claude Code was hardcoded on Opus.
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
// 达到 3 次：如果配了备用模型 → 抛 FallbackTriggeredError，交由上层换模型。
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // Check if fallback model is specified
          if (options.fallbackModel) {
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // Throw special error to indicate fallback was triggered
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

// 没配备用模型、且是外部用户、且不是持久模式 → 抛 CannotRetryError，
// 消息用 REPEATED_529_ERROR_MESSAGE（告诉用户服务端持续过载）。
// 沙箱环境（IS_SANDBOX）除外。
          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled()
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // Only retry if the error indicates we should
// 持久模式：只有 429/529 才无限重试，其它错误照常走次数上限。
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
// ★ 次数用尽且不是持久模式 → 放弃（抛 CannotRetryError）。
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

// 云厂商的凭证错误不一定包装成 APIError，所以要单独判断并处理（清缓存）。
// handledCloudAuthError 为 true 表示「已处理，可以重试」。
      // AWS/GCP errors aren't always APIError, but can be retried
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
// 既不是云凭证错误、又不在「可重试」清单里 → 放弃。
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

// ★ max_tokens 超出上下文窗口的处理（本文件里唯一会**改参数再重试**的地方）：
// 服务端报「input length + max_tokens 超过上下文上限」，
// 我们就把 max_tokens 调小到「上下文剩余空间」，然后重试。
// 注意原注释：开启 extended-context-window beta 之后，API 不再返回这个 400，
// 而是返回 stop_reason = model_context_window_exceeded；这里保留是为了兼容老行为。
      // Handle max tokens context overflow errors by adjusting max_tokens for the next attempt
      // NOTE: With extended-context-window beta, this 400 error should not occur.
      // The API now returns 'model_context_window_exceeded' stop_reason instead.
      // Keeping for backward compatibility.
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

// 安全余量 1000 token：给估算误差留点空间，别刚好卡在边界上。
          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
// 剩余空间连下限（3000）都不够 → 放弃（调了也没意义）。
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // Ensure we have enough tokens for thinking + at least 1 output token
// 至少要保证「thinking 预算 + 1 个输出 token」，否则模型连一个字都吐不出来。
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
// 取三者最大值：既不低于下限、也不超过可用空间、还要满足 thinking 的最低需求。
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
// 写进 retryContext —— 下一次 operation 调用会拿到这个 override。
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

// ===== 常规退避 ===== 
      // For other errors, proceed with normal retry logic
      // Get retry-after header if available
// 优先读服务端的 Retry-After 头。
      const retryAfter = getRetryAfter(error)
      let delayMs: number
// 持久模式 + 429：优先等「配额窗口重置」而不是每 5 分钟空轮询一次。
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // Window-based limits (e.g. 5hr Max/Pro) include a reset timestamp.
        // Wait until reset rather than polling every 5 min uselessly.
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
// 持久模式的其它情况（比如 529）：指数退避，但封顶 6 小时，
// 防止服务端给了个病态的 Retry-After 导致无限等待。
      } else if (persistent) {
        persistentAttempt++
        // Retry-After is a server directive and bypasses maxDelayMs inside
        // getRetryDelay (intentional — honoring it is correct). Cap at the
        // 6hr reset-cap here so a pathological header can't wait unbounded.
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
// 普通模式：标准指数退避（封顶 32 秒）。
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // In persistent mode the for-loop `attempt` is clamped at maxRetries+1;
      // use persistentAttempt for telemetry/yields so they show the true count.
// 持久模式下 for 循环的 attempt 会被钳住（见第 506 行），
// 所以上报遥测要用单独的 persistentAttempt 才看得出真实次数。
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

// ===== 持久模式的分片睡眠（心跳）=====
// 一次睡 5 分钟的话，宿主环境（比如 CI）可能认为会话空闲而把它杀掉。
// 所以切成 30 秒一段，每段之间 yield 一条消息（相当于心跳）。
      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('tengu_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // Chunk long sleeps so the host sees periodic stdout activity and
        // does not mark the session idle. Each yield surfaces as
        // {type:'system', subtype:'api_retry'} on stdout via QueryEngine.
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
// ★ yield：把「还要等多久」作为一条系统消息推给上层，
// 上层会渲染成「API 繁忙，X 秒后重试（第 N 次）」。
// 这就是本函数是 generator 的意义所在。
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
// 每段最多睡 30 秒，睡完扣掉，继续下一片。
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
// ★ 把 attempt 钳在 maxRetries：让 for 循环**永不结束**（实现无限重试）。
// 退避时长的增长靠独立的 persistentAttempt 计数（它一直涨到 5 分钟封顶）。
// 这是一个有点 hack 但很实用的写法。
        // Clamp so the for-loop never terminates. Backoff uses the separate
        // persistentAttempt counter which keeps growing to the 5-min cap.
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
// 普通模式：yield 一条重试提示，然后睡够再进入下一轮。
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

// 循环跑完都没成功（理论上只有普通模式会走到这里）→ 放弃。
  throw new CannotRetryError(lastError, retryContext)
}

// 取 Retry-After 头。两种来源都要试：
//   ①普通对象的 headers['retry-after']（反序列化出来的错误）；
//   ②标准 Headers 对象的 .get('retry-after')（真实响应）。
// `?.get?.(...)` 双重可选：headers 可能没有、get 也可能不是函数。
function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

// ★ 退避算法本体（见文件头说明）：
//  ①有 Retry-After → 直接用它（服务端最清楚）；
//  ②否则指数退避 min(500 * 2^(n-1), maxDelayMs)；
//  ③再加 0~25% 的随机抖动（jitter）。
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
// ★ jitter 的作用：打散重试时刻，避免「惊群」。
// 如果不加抖动，成千上万个客户端会在同一秒一起重试，把刚恢复的服务端再次打垮。
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

// 解析「输入 + max_tokens 超过上下文上限」这类 400 错误。
// 返回 undefined 表示不是这类错误（调用方据此决定要不要重试）。
// 返回类型是 `{...} | undefined` —— 又一个「用返回值表达结果」的例子。
export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

// 错误信息的例子：input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000
// 用正则把三个数字抓出来。注意正则里的 \+ 和 \> 要转义。
  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

// match.length !== 4：整个匹配 + 三个捕获组，一共 4 项。
  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO（原注释保留）：靠**匹配错误文案**判断「fast mode 没启用」是脆弱的，
// 服务端改一个字就失效。理想方案是服务端给一个专用响应头。
// TODO: Replace with a response header check once the API adds a dedicated
// header for fast-mode rejection (e.g., x-fast-mode-rejected). String-matching
// the error message is fragile and will break if the API wording changes.
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

// ★ 529 判定有两路：状态码 == 529，或者消息里含 "type":"overloaded_error"。
// 后者是补丁：SDK 在**流式**响应里有时拿不到 529 状态码，只能从消息体里认。
export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // See below: the SDK sometimes fails to properly pass the 529 status code during streaming
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

// 403 + 「OAuth token has been revoked」：说明别的进程已经刷新过 token，我们这份作废了。
function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

// Bedrock 的鉴权错误有两类：
//   ①AWS SDK 在本地就发现凭证过期（CredentialsProviderError，压根没发请求）；
//   ②请求发出去后收到 403。两种情况都要清缓存重建 client。
function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // AWS libs reject without an API call if .aws holds a past Expiration value
    // otherwise, API calls that receive expired tokens give generic 403
    // "The security token included in the request is invalid"
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * Clear AWS auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// GCP 的 SDK 不像 AWS 那样有专门的错误类型，只能匹配错误文案（原注释说明了原因）。
// google-auth-library throws plain Error (no typed name like AWS's
// CredentialsProviderError). Match common SDK-level credential-failure messages.
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

// Vertex 的鉴权错误：SDK 层（拿凭证失败）或服务端层（401）。
function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // SDK-level: google-auth-library fails in prepareOptions() before the HTTP call
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // Server-side: Vertex returns 401 for expired/invalid tokens
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * Clear GCP auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

// ★★【可重试总表】判断一个 APIError 要不要重试。判断顺序很重要，从上到下依次：
// ①mock 错误 → 不重试；
// ②持久模式下的 429/529 → 重试；
// ③远程模式（CCR）下的 401/403 → 重试（那里的 token 是基础设施发的，过期是瞬时故障）；
// ④消息含 overloaded_error → 重试；
// ⑤max_tokens 上下文溢出 → 重试（会先调参数）；
// ⑥x-should-retry: true 且（非订阅用户 或 企业用户）→ 重试；
// ⑦x-should-retry: false → 不重试（内部用户遇到 5xx 例外）；
// ⑧APIConnectionError → 重试；
// ⑨408/409 → 重试；
// ⑩429 → 非订阅用户 或 企业用户才重试；
// ⑪401 → 清 API key 缓存后重试；
// ⑫403 token 被吊销 → 重试；
// ⑬5xx → 重试；
// ⑭其它 → 不重试。
function shouldRetry(error: APIError): boolean {
  // Never retry mock errors - they're from /mock-limits command for testing
  if (isMockRateLimitError(error)) {
    return false
  }

  // Persistent mode: 429/529 always retryable, bypass subscriber gates and
  // x-should-retry header.
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR mode: auth is via infrastructure-provided JWTs, so a 401/403 is a
  // transient blip (auth service flap, network hiccup) rather than bad
  // credentials. Bypass x-should-retry:false — the server assumes we'd retry
  // the same bad key, but our key is fine.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // Check for overloaded errors first by examining the message content
  // The SDK sometimes fails to properly pass the 529 status code during streaming,
  // so we need to check the error message directly
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // Check for max tokens context overflow errors that we can handle
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // Note this is not a standard header.
// x-should-retry 不是标准 HTTP 头，是 Anthropic 自定义的。
  const shouldRetryHeader = error.headers?.get('x-should-retry')

// 为什么订阅用户即使服务端说可以重试也不重试？
// 注释解释：Max/Pro 用户的 should-retry 往往意味着「几小时后再来」，
// 在 CLI 里等几小时没意义。企业用户通常按量付费（PAYG），重试是合理的。
  // If the server explicitly says whether or not to retry, obey.
  // For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
  // Enterprise users can retry because they typically use PAYG instead of rate limits.
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

// 内部用户可以忽略 x-should-retry: false —— 但**仅限 5xx**，
// 其它状态码（401/403/400/429）仍然尊重服务端的判断。
  // Ants can ignore x-should-retry: false for 5xx server errors only.
  // For other status codes (401, 403, 400, 429, etc.), respect the header.
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts.
  if (error.status === 409) return true

  // Retry on rate limits, but not for ClaudeAI Subscription users
  // Enterprise users can retry because they typically use PAYG instead of rate limits
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

// 401 时清掉 API key helper 的缓存（下次会重新去取），然后允许重试。
  // Clear API key cache on 401 and allow retry.
  // OAuth token handling is done in the main retry loop via handleOAuth401Error.
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // Retry on 403 "token revoked" (same refresh logic as 401, see above)
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

  return false
}

// 重试次数：环境变量 CLAUDE_CODE_MAX_RETRIES 优先，否则默认 10。
export function getDefaultMaxRetries(): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    return parseInt(process.env.CLAUDE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

// fast mode 降级的默认「保持时长」：30 分钟（在此期间用标准速度）。
const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
// 20 秒以内算「短等待」——值得等，因为能保住 prompt 缓存。
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
// 冷却时长下限 10 分钟——防止在两种速度之间来回抖动。
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

// 读配额窗口重置时间（Unix 秒），换算成「还要等多久」。
// 用 Number.isFinite 而不是 isNaN：能同时挡住 NaN 和 Infinity。
function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
