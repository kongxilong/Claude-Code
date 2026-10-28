/**
 * 【一句话定位】自动压缩的**决策层**：负责回答「现在要不要压缩」，以及要压缩时把流程真正跑起来。
 * 它自己**不生成摘要**——真正的摘要生成在 ./compact.ts。
 *
 * 【在架构中的位置】
 * - 上游：src/query.ts 的主循环。query.ts 从本文件 import 了
 *   calculateTokenWarningState / isAutoCompactEnabled / AutoCompactTrackingState（见 query.ts:8-12），
 *   在每一轮循环拿到新的 token 用量后询问本模块。
 * - 下游：
 *   · ./compact.js 的 compactConversation() —— 真正调模型生成摘要（第四级压缩）
 *   · ./sessionMemoryCompact.js 的 trySessionMemoryCompaction() —— 优先尝试的「会话记忆压缩」
 *   · ./postCompactCleanup.js 的 runPostCompactCleanup() —— 压缩后清理缓存
 *   · ../api/promptCacheBreakDetection.js、../SessionMemory/sessionMemoryUtils.js、src/bootstrap/state.js
 * - 调用链：src/query.ts（主循环）→ 本文件（shouldAutoCompact 判阈值 → autoCompactIfNeeded 执行）
 *           → compact.ts 的 compactConversation() → 再发一次模型请求生成摘要
 *
 * 【阈值判定逻辑】（本文件的核心，务必看懂下面这几个量）
 * 先搞清楚四个「容量」的关系：
 *   ① context window（如 200k）= 模型宣传的上下文窗口总大小
 *   ② MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000 = 压缩请求本身要留给**模型输出摘要**的 output token
 *      （依据：摘要长度的 p99.99 是 17,387 token，取 20k 留足余量）
 *   ③ effective context window = ① − ② = 真正能用来**装输入**的空间
 *   ④ AUTOCOMPACT_BUFFER_TOKENS = 13_000 = 触发自动压缩前留的安全余量
 * 于是：autoCompactThreshold = ③ − ④ = getEffectiveContextWindowSize(model) − 13_000
 *
 * 举个具体数字（200k 窗口、模型 max output 32k）：
 *   reserved = min(32_000, 20_000) = 20_000
 *   effective = 200_000 − 20_000 = 180_000
 *   threshold = 180_000 − 13_000 = 167_000  → 输入 token 到 167k 就触发压缩
 *
 * 为什么要叠这么多层余量：
 *   ① 摘要本身要占输出位（不留的话模型写到一半被截断，摘要就是残缺的）
 *   ② 压缩是异步的：从「判定要压」到「真正压完」之间，用户和工具还在产生新 token
 *   ③ 万一压缩失败，还得留出一轮正常请求的余量，不至于立刻 413（请求实体过大）
 *
 * 另外三个 buffer：
 *   WARNING_THRESHOLD_BUFFER_TOKENS = 20_000 → UI 开始显示「context 快用完了」黄色警告
 *   ERROR_THRESHOLD_BUFFER_TOKENS  = 20_000 → UI 显示红色错误提示
 *   MANUAL_COMPACT_BUFFER_TOKENS   = 3_000  → 手动 /compact 的阻塞线，比自动线**宽松得多**，
 *     因为这是用户主动要求的：既然用户都说了要压，就压到接近极限为止，不要过早拒绝。
 *
 * 【熔断机制】MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
 * 连续失败 3 次就停止尝试。背景（原英文注释里的数据）：某次统计发现 1,279 个会话
 * 出现过 50 次以上连续失败（最高 3,272 次），全球每天浪费约 25 万次 API 调用。
 * 因为有些上下文是「无论如何都压不下去」的（例如 prompt_too_long），重试纯属徒劳。
 *
 * 【四级压缩中的位置】本文件管的是最重的第四级 autocompact（整段压成摘要）。
 * 触发顺序上，轻的三级（snip → microcompact → collapse）会先被尝试，本文件是最后兜底。
 *
 * 【本文件包含什么】
 * - MAX_OUTPUT_TOKENS_FOR_SUMMARY：压缩请求预留的 output token 常量。
 * - getEffectiveContextWindowSize()：算出「真正能装输入」的窗口大小。
 * - type AutoCompactTrackingState：跨轮次跟踪压缩状态的小结构（是否已压过、轮数、连续失败数）。
 * - AUTOCOMPACT_BUFFER_TOKENS 等四个 buffer 常量。
 * - MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES：熔断阈值。
 * - getAutoCompactThreshold()：算出触发压缩的 token 阈值。
 * - calculateTokenWarningState()：一次性算出百分比与各档阈值判定结果（给 UI 用）。
 * - isAutoCompactEnabled()：自动压缩功能是否被关闭（环境变量 / 用户配置）。
 * - shouldAutoCompact()：主循环每轮调用的判定函数。
 * - autoCompactIfNeeded()：判定 + 执行的完整入口。
 *
 * 【TS 语法速查】
 * - `export const X = 13_000`：导出常量；数字里的 `_` 只是分隔符，等于 13000（Java 7+ 同样支持）。
 * - `export type X = {...}`：只导出**类型**，编译后消失；`{...}` 是结构化鸭子类型，
 *   ≈ Java 的 record，但不需要 implements 就能赋值。
 * - `?:` 可选属性 / 可选参数：`consecutiveFailures?: number` 表示可以没有这个字段，
 *   读出来类型是 `number | undefined`（≈ Java 的 Optional / @Nullable，但 TS 强制你处理）。
 * - `??` 空值合并：`a ?? 0` 只在 a 为 null/undefined 时取 0；
 *   **注意与 `||` 的区别**：`||` 会把 0、'' 也当成「假」替换掉，`??` 不会。
 *   本文件 `tracking?.consecutiveFailures ?? 0` 正是要用 0 这个真实值，所以必须用 `??`。
 * - `?.` 可选链：`tracking?.compacted` ≈ `tracking == null ? undefined : tracking.compacted`。
 * - 对象字面量简写 `return { percentLeft, isAboveWarningThreshold }`：
 *   属性名与变量名相同时可以只写一次，≈ Java 里没有的简写（Java 必须写 percentLeft=percentLeft）。
 * - `async function` + `await`：`await` 会**暂停**函数执行直到 Promise 完成，但**不阻塞线程**，
 *   ≈ Java 的 CompletableFuture + 虚拟线程里的同步写法。
 * - `Promise<{ wasCompacted: boolean; ... }>`：返回「将来会有一个对象」，
 *   ≈ Java 的 `CompletableFuture<Result>`。
 * - 解构 `const { isAboveAutoCompactThreshold } = calculateTokenWarningState(...)`：
 *   只取返回对象里需要的字段，等价于 Java 里 `var r = f(); r.isAboveAutoCompactThreshold`。
 * - `feature('X')` 是**编译期**常量（打包时替换成 true/false），不是运行时 if；
 *   为 false 时整个 if 块会被删掉（≈ C 的 #ifdef）。
 * - `parseInt(x, 10)` / `parseFloat(x)` / `isNaN(x)`：与 Java 的 Integer.parseInt / Double.parseDouble
 *   / Double.isNaN 对应；注意 TS 的 isNaN 是全局函数，且 parseInt 建议**总带上 10 这个进制参数**。
 */
import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
// 中文补充上面那段英文：压缩请求本身也是一次模型调用，模型要**输出**一份摘要，
// 这部分必须算进 output token 里。取 20_000 是因为实测摘要长度的 p99.99 是 17,387 token。
// 不留够会怎样：模型写到一半撞上 max_tokens 被截断，摘要残缺 —— 比不压缩还糟。
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// Returns the context window size minus the max output tokens for the model
/**
 * 算出「真正能用来装输入」的上下文窗口大小 = 模型窗口 − 摘要输出预留。
 *
 * 为什么需要：模型宣传的 context window（如 200k）是**输入 + 输出**的总额度。
 * 而压缩请求必须给输出留一大块（摘要），所以可装输入的部分要比 200k 小不少。
 * 所有阈值计算都必须基于这个「有效窗口」，直接用 200k 去算会得出一个根本达不到的阈值。
 *
 * @param model 当前使用的模型名（不同模型窗口不同，例如 200k / 1M）。
 * @returns 有效上下文窗口大小（token 数）。
 *
 * 关键步骤：
 *   ① 取「模型自身 max output」与「我们的 20k 预留」中较小的那个作为预留量
 *      —— 取小是因为不能超出模型本身的输出上限（比如某模型只支持 8k 输出）
 *   ② 拿到该模型的上下文窗口（还要考虑 SDK beta 是否开启长上下文）
 *   ③ 允许用环境变量 CLAUDE_CODE_AUTO_COMPACT_WINDOW 人为**调小**窗口（便于测试 / 限流），
 *      注意这里是 Math.min —— 只能调小、不能调大，防止误配把窗口撑爆
 *   ④ 返回 窗口 − 预留
 */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  // 窗口大小不是查表就完事：同一个模型在开启某些 SDK beta（长上下文）时窗口会更大，
  // 所以要把当前生效的 betas 一起传进去。
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  // 环境变量覆盖：给测试 / 限流用。下面用 Math.min 而不是直接赋值，
  // 意思是「只能把窗口调小，不能调大」—— 防止有人手滑配了个超过模型上限的值，
  // 结果阈值比窗口还高，永远压不下去也永远撑不爆，进入诡异状态。
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

/**
 * 跨轮次跟踪自动压缩状态的小结构。由 query.ts 的主循环持有，每轮传回本模块。
 *
 * 为什么需要：压缩不是一次性的。会话可能压完又涨满、再压一次；
 * 也可能连续失败。主循环需要把这些「上一轮发生过什么」告诉本模块，
 * 否则每次都像第一次一样盲目重试。
 */
export type AutoCompactTrackingState = {
  /** 本次会话是否**已经压缩过**至少一次。用于判断这是一次「再压缩（recompact）」。 */
  compacted: boolean
  /** 距上次压缩已经过了多少轮。用于评估「压缩是不是压得太频繁」。 */
  turnCounter: number
  // Unique ID per turn
  /** 当前轮次的唯一 ID。压缩后主循环会换一个新的轮次 ID，用来标记边界。 */
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  /**
   * 连续失败次数，成功时归零。用作**熔断器**：上下文如果是「无论如何都压不下去」的
   * （例如已经 prompt_too_long），再试多少次都是浪费，达到阈值就彻底放弃。
   * 为什么是可选字段：没失败过时这个字段根本不存在，用 undefined 表达「零次」更省事。
   */
  consecutiveFailures?: number
}

// 四个「安全余量」常量（单位 token）。它们共同决定了 UI 什么时候变色、什么时候自动压：
//   AUTOCOMPACT 13_000 —— 距有效窗口还剩 13k 就触发**自动压缩**
//   WARNING     20_000 —— 距阈值还剩 20k 时 UI 开始**黄色警告**（见下一行）
//   ERROR       20_000 —— 距阈值还剩 20k 时 UI 显示**红色错误**（与 WARNING 同值）
//   MANUAL       3_000 —— **手动** /compact 的阻塞线，比自动线宽松得多：
//     用户主动要求压缩时，宁可压到接近极限也不要轻易拒绝他。
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
// 中文补充上面那段英文（这是很典型的生产事故驱动的设计）：
// 曾经统计到 1,279 个会话出现过 50 次以上连续压缩失败，最多的达到 3,272 次，
// 全球每天白白烧掉约 25 万次 API 调用。原因就是有些上下文**根本压不下去**，
// 而代码每轮都在重试。所以加个熔断器：连续失败 3 次之后本会话不再尝试。
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

/**
 * 算出**触发自动压缩**的 token 阈值：输入 token 用到这么多就该压了。
 *
 * 为什么需要：阈值不是写死的常数。不同模型的窗口大小、输出上限都不一样，
 * 必须按模型算；而且还要留出摘要输出位和 13k 安全余量。
 *
 * @param model 当前模型名。
 * @returns 触发阈值（token 数）= 有效窗口 − 13_000。
 *
 * 关键步骤：
 *   ① 先算有效窗口 getEffectiveContextWindowSize(model)
 *   ② 减去 AUTOCOMPACT_BUFFER_TOKENS 得到默认阈值
 *   ③ 支持用环境变量 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 按百分比**调低**阈值（只为方便测试），
 *      同样用 Math.min 保证只能调低不能调高
 *   ④ 返回
 */
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold =
    // 减掉的这 13k 是「从判定要压，到真正压完」之间的缓冲：
    // 压缩是异步的，期间用户还会说话、工具还会产出，必须留出这段增量，否则压完立刻又满了。
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // Override for easier testing of autocompact
  // 测试专用开关：把阈值直接设成「有效窗口的百分之几」，方便在小上下文下复现压缩流程。
  // 校验条件很严（>0 且 <=100 且不是 NaN），配错就静默忽略、走回默认阈值 —— 宁可不生效也不能算错。
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

/**
 * 一次性算出当前 context 使用情况的**全部**判定结果，供 UI 与压缩决策共用。
 *
 * 为什么需要：UI 要显示「还剩百分之多少」、要不要变黄、要不要变红，
 * 压缩逻辑要知道「到没到自动压缩线」。这些判定共用同一套阈值，
 * 放在一起算可以保证 UI 上看到的数字和真正触发压缩的条件**完全一致**，不会出现
 * 「UI 说还很充裕，结果突然就压缩了」这种割裂。
 *
 * @param tokenUsage 当前已使用的 token 数（来自上一次 API 响应的 usage）。
 * @param model 当前模型名。
 * @returns 五个字段：percentLeft（剩余百分比，最小 0）、isAboveWarningThreshold、
 *         isAboveErrorThreshold、isAboveAutoCompactThreshold、isAtBlockingLimit。
 *
 * 关键步骤：
 *   ① 选出基准阈值：自动压缩开着就用「自动压缩阈值」，关了就用「有效窗口」本身
 *      —— 关掉自动压缩后，UI 的百分比应该按**整个窗口**算而不是按压缩线算，否则会显示负数
 *   ② 算剩余百分比（用 Math.max(0, ...) 兜住负数，Math.round 取整）
 *   ③ 分别减去两个 buffer 得到警告线 / 错误线，逐一比较
 *   ④ 自动压缩线只在「功能开启」时才可能为 true
 *   ⑤ 阻塞线（blocking limit）单独算：用有效窗口 − 3k，并支持环境变量覆盖（测试用）
 *   ⑥ 一次性返回全部结果（对象字面量简写）
 */
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  // 注意这里：自动压缩**关闭**时，百分比要按「有效窗口」算而不是按「压缩阈值」算。
  // 否则关掉自动压缩的用户会看到 percentLeft 变成负数或者莫名其妙的数字。
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  // Math.max(0, ...) 兜底：tokenUsage 超过阈值时算出来是负的，
  // UI 显示「还剩 -5%」很怪，统一夹到 0。
  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  // 两个条件缺一不可：功能必须开着（&& 左边），且 token 确实超线（&& 右边）。
  // 少了左边，关掉自动压缩的用户也会被判定为「该压了」。
  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  // blocking limit = 「再不走就发不出请求了」的最后防线，用于**手动** /compact 之类场景，
  // 比自动压缩线（−13k）宽松得多（−3k），因为用户主动要求时应该尽量满足而不是拒绝。
  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

/**
 * 判断自动压缩功能当前是否可用（有没有被关掉）。
 *
 * 为什么需要：自动压缩是**可以关**的。有些用户/场景不希望系统偷偷改写历史，
 * 也有人只是为了调试。所有阈值判定都必须先问这一句。
 *
 * @returns true 表示自动压缩可用。
 *
 * 三道关闭开关（逐级变细）：
 *   ① DISABLE_COMPACT       —— 连**手动** /compact 一起禁用（最狠）
 *   ② DISABLE_AUTO_COMPACT  —— 只禁自动压缩，**保留**手动 /compact（原英文注释特别强调这点）
 *   ③ 用户配置 autoCompactEnabled —— 用户在全局配置里关掉
 */
export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
    // 只关自动压缩，**手动 /compact 仍然可用** —— 这是与 DISABLE_COMPACT 的关键区别：
    // 用户可能只是不想被系统偷偷压缩，但仍然希望能在需要时自己按一下。
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  // 最后一个值是配置里的布尔值（没配过就是 undefined）。
  // 注意这里直接 `return userConfig.autoCompactEnabled`：TS 里 undefined 也是「假值」，
  // 但函数声明了返回 boolean，说明类型上认为它一定是 boolean（配置项有默认值）。
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

/**
 * 【主循环每轮调用】判断当前是否需要自动压缩。
 *
 * 为什么需要：这是四级压缩里最重的第四级的**触发判定**。返回 false 时，
 * 系统会退回靠更轻的三级（snip / microcompact / collapse）来腾空间。
 *
 * @param messages 当前历史消息（用来估算 token 用量）。
 * @param model 当前模型名（影响阈值）。
 * @param querySource 查询来源。用来做**递归保护**：某些来源本身就是在做压缩的 fork 代理，
 *        让它们再触发压缩会死锁。
 * @param snipTokensFreed snip（第一级）已经释放掉的 token 数。
 *        为什么需要这个参数（原英文注释的核心）：snip 把最老的几轮**删掉了**，
 *        但留下来的那条 assistant 消息里的 usage 字段仍然记录着**删之前**的用量，
 *        所以 tokenCountWithEstimation() 看不到 snip 省下的这部分 —— 必须手动减掉，
 *        否则会误判「还是很满」而触发本不必触发的重压缩。
 * @returns Promise<boolean>：true 表示应该压缩。
 *
 * 关键步骤：
 *   ① 递归保护：session_memory / compact 这两个来源直接返回 false（它们本身就在压缩，会死锁）
 *   ② marble_origami（ctx-agent）也返回 false —— 它的压缩会连带清掉主线程的已提交日志
 *   ③ 功能开关检查 isAutoCompactEnabled()
 *   ④ reactive-only 模式：关掉主动压缩，只留「撞上 prompt_too_long 再压」的被动路径
 *   ⑤ context-collapse 模式：折叠本身就是上下文管理系统，让折叠去管，别抢
 *   ⑥ 算 token 用量（减去 snip 已释放的部分），与阈值比较后返回
 */
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
    // 递归保护（原英文注释：Recursion guards）。session_memory 和 compact 都是
    // **被 fork 出来做压缩的代理**，如果它们自己也触发自动压缩，就会无限套娃 / 死锁。
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
    // 中文补充英文注释：marble_origami 是「ctx-agent」。
    // 如果它的上下文爆了并触发自动压缩，runPostCompactCleanup() 会调用
    // resetContextCollapse()，而那个状态是**模块级共享**的（fork 与主线程共用），
    // 于是会顺手把主线程的已提交日志一起清掉 —— 典型的跨 fork 状态踩踏。
    // 外面裹一层 feature() 是为了让这个内部代号字符串在外部构建里被 DCE 掉（见 excluded-strings.txt）。
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
    // 中文补充英文注释：「reactive-only 模式」—— 关掉**主动**压缩（proactive），
    // 只保留「API 报 prompt_too_long 之后再压」的被动路径。
    // 这是一种实验配置：用更激进的方式省掉主动压缩的开销，代价是偶尔会撞一次超长错误。
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
    // 中文补充上面那一大段英文（很值得读，讲的是一个真实的设计冲突）：
    // 折叠（context collapse）开启时，它自己就是上下文管理系统：90% 开始提交、95% 阻塞。
    // 而自动压缩的触发点 ≈ 有效窗口的 93%，正好夹在 90% 和 95% 中间 ——
    // 两者会**抢同一块空间**，而且自动压缩通常更快，会把折叠刚要保存的细粒度上下文直接抹掉。
    // 所以这里让折叠优先：折叠开着就不做自动压缩。
    //
    // 为什么放在**这里**而不是放在 isAutoCompactEnabled() 里（原英文注释的关键）：
    //   放进 isAutoCompactEnabled() 会连 reactiveCompact（413 兜底）一起关掉，那才是真的危险；
    //   放在这里则只影响「主动压缩」这一条路径，sessionMemory 与手动 /compact 也都还能用。
    // 另外用 require() 而不是顶层 import，是为了打破初始化时的循环依赖：
    //   本文件导出的 getEffectiveContextWindowSize 正是 collapse/index.ts 要 import 的。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  // 减去 snip 已经释放的 token：snip 删掉了消息，但留下的 usage 还是旧数字，
  // 不减这里就会高估用量、提前触发本不必要的重压缩。
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  // 只解构出需要的那一个字段，其余（百分比、警告线等）在这一步用不上。
  // 好处是「阈值判定」只有一份实现，UI 与这里不会算出不一致的结果。
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

/**
 * 【完整入口】先判断要不要压缩，要就执行压缩，并返回结果给主循环。
 *
 * 为什么需要：把「判定」和「执行」打包成一个入口，主循环只需调用一次，
 * 不用关心内部是先试会话记忆压缩还是直接整段压缩。
 *
 * @param messages 当前历史消息。
 * @param toolUseContext 工具执行上下文（内含当前模型等重要信息）。
 * @param cacheSafeParams 与 prompt 缓存兼容的请求参数（压缩请求也要尽量命中缓存）。
 * @param querySource 查询来源，用于递归保护与清理时的主线程判断。
 * @param tracking 跨轮次的压缩跟踪状态（含连续失败次数，用于熔断）。
 * @param snipTokensFreed snip 已释放的 token 数，透传给 shouldAutoCompact()。
 * @returns Promise<{ wasCompacted, compactionResult?, consecutiveFailures? }>：
 *         wasCompacted=true 表示历史**已经被替换**，主循环必须用新的消息数组继续；
 *         consecutiveFailures 方便调用方把这个数字带回下一轮（熔断用）。
 *
 * 关键步骤：
 *   ① 总开关检查（DISABLE_COMPACT）与熔断器检查（连续失败 >= 3 就直接放弃）
 *   ② 调 shouldAutoCompact() 判定；不需要就返回 wasCompacted=false
 *   ③ 组装 recompactionInfo（告诉下游这是不是「再压缩」、距上次压缩几轮等）
 *   ④ **优先尝试**会话记忆压缩 trySessionMemoryCompaction() —— 它更轻、更便宜
 *   ⑤ 会话记忆压缩没成，才走重的整段压缩 compactConversation()（第四级）
 *   ⑥ 成功：重置 lastSummarizedMessageId（旧 uuid 已不存在）+ 跑压缩后清理 + 失败数清零
 *   ⑦ 失败：记日志（用户主动中止不算错误）+ 失败数 +1 返回给调用方
 */
export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  // DISABLE_COMPACT 是总开关：连手动 /compact 都禁掉，所以这里直接放弃。
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  // 熔断器：连续失败达到 3 次就不再尝试。
  // `tracking?.consecutiveFailures !== undefined` 这一层判断是为了区分「0 次」和「字段不存在」——
  // 用 `?? 0` 虽然也能兜底，但显式判 undefined 语义更清楚。
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  // 把「这次压缩在整个会话里的位置」告诉下游：是不是第二次压、距上次压了几轮。
  // 下游（compact.ts）会据此调整提示词与保留策略 —— 反复压缩的会话需要更保守。
  // `tracking?.turnCounter ?? -1`：没跟踪过就传 -1，表示「未知」。
  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // 中文补充：**优先**尝试会话记忆压缩（session memory compaction），它比整段压缩轻得多，
  // 代价小、保留的信息多；只有它搞不定时才降级到第四级整段压缩。
  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // 中文补充：压缩会**删掉**消息，之前记录的「最后一条被摘要的消息 ID」指向的对象已经不存在了，
    // 必须清掉，否则后续逻辑会拿着一个悬空的 uuid 去查找。
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    // 中文补充：压缩后 cache read 会自然下降，如果不重置基线，监控系统会把它
    // 误报成「prompt 缓存被打断了」。compactConversation() 内部已经做了这件事，
    // 但会话记忆压缩这条路径没有 —— 所以这里补一次。
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

    // 会话记忆压缩没能解决，走到这里：第四级——整段压缩（最重的一级）。
    // 它内部会**再发一次模型请求**，让模型把整个历史压成一份摘要。
  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      // 三个布尔入参的含义（位置参数，靠行尾注释说明各自是什么）：
      //   ① true  = 压缩后**不要反问用户**（自动压缩是系统行为，用户没让你问，直接接着干）
      //   ② undefined = 没有自定义压缩指令（手动 /compact 才会带）
      //   ③ true  = 这是**自动**压缩（区别于用户手动触发）
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
    }
    // 压缩失败不能让整个会话崩掉：返回 wasCompacted=false，让主循环照常继续，
    // 同时把失败次数 +1 交回去（下一轮可能就触发熔断了）。
  } catch (error) {
      // 用户主动中止（比如按了 Esc）**不算错误**，不需要记错误日志，否则日志里全是噪音。
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
