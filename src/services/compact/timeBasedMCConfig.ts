/**
 * 【一句话定位】microcompact（第二级压缩）的**按时间触发**策略配置：
 * 距上一条助手消息太久（默认 1 小时）时，主动清理掉老的 tool result。
 *
 * 【在架构中的位置】
 * - 上游：src/services/compact/microCompact.ts 的 microcompactMessages()，
 *   后者由 src/query.ts 的主循环在每次调用模型前调用。
 * - 下游：../analytics/growthbook.js（GrowthBook 远程配置 / A-B 实验平台）。
 * - 调用链：src/query.ts（主循环）→ compact/microCompact.ts → 本文件（读远程配置）
 *
 * 【为什么按时间触发】（本文件最有价值的设计点，务必理解）
 * 服务端有 **prompt 缓存**（server-side prompt cache），TTL 通常 5 分钟 / 1 小时：
 * 如果两次请求间隔很短，之前那大段 prompt 会命中缓存，重复发送也几乎不花钱、不耗时。
 * 但如果间隔超过 1 小时，缓存**几乎肯定已经过期**，这次请求无论如何都要把整个 prefix 重写一遍。
 * 既然横竖都要重写，那就在发请求**之前**先把老的 tool result 清掉，让「要重写的东西」变小——
 * 这一级的收益就是白捡的，代价为零。
 *
 * 【为什么要放在 API 调用之前】（原英文注释的核心）
 * 必须在 microcompactMessages() 里、callModel 之前跑，这样被缩小的是**真正要发出去的** prompt。
 * 如果等到第一次 cache miss 之后再清理，就只会对**后续**轮次有帮助，这一轮该付的钱已经付了。
 *
 * 【为什么只限主线程】
 * 子代理（subagent）生命周期很短，通常是「一口气跑完」，不存在「闲置一小时」的场景，
 * 按时间驱逐对它没有意义。
 *
 * 【本文件包含什么】
 * - type TimeBasedMCConfig：配置结构（总开关 + 时间阈值 + 保留条数）。
 * - TIME_BASED_MC_CONFIG_DEFAULTS：内置默认值，全部指向「关闭 / 保守」。
 * - getTimeBasedMCConfig()：从 GrowthBook 读配置，读不到就用默认值。
 *
 * 【TS 语法速查】
 * - `export type X = { a: boolean }`：≈ Java 的 record/接口，但它是**结构化鸭子类型**——
 *   只要字段对得上就算这个类型，不需要 implements；编译后类型信息完全消失。
 * - 字段后面可选 `?`：`enabled?: boolean` 表示**可选字段**，≈ Java 的 @Nullable 字段（但 TS 会强制你判空）。
 * - `A | B` 联合类型 ≈ Java 的 sealed interface（只能是其中一种）；
 *   本文件里 `keep: { type: 'thinking_turns'; value: number } | 'all'` 表示「要么是这个对象，要么是字符串 'all'」。
 * - `'clear_tool_uses_20250919'` 这种用**字面量**当类型：叫字面量类型，
 *   ≈ Java 里用 enum 限定取值范围，但写法上就是个字符串常量。
 * - `180_000`：数字里的下划线只是**分隔符**，方便看位数，等于 180000（Java 7+ 同样支持）。
 */
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/**
 * GrowthBook config for time-based microcompact.
 *
 * Triggers content-clearing microcompact when the gap since the last main-loop
 * assistant message exceeds a threshold — the server-side prompt cache has
 * almost certainly expired, so the full prefix will be rewritten anyway.
 * Clearing old tool results before the request shrinks what gets rewritten.
 *
 * Runs BEFORE the API call (in microcompactMessages, upstream of callModel)
 * so the shrunk prompt is what actually gets sent. Running after the first
 * miss would only help subsequent turns.
 *
 * Main thread only — subagents have short lifetimes where gap-based eviction
 * doesn't apply.
 */
// 远程下发的「按时间 microcompact」配置结构。三个字段都由 GrowthBook 控制，
// 这样不用发版就能调整策略、做 A/B 实验。
export type TimeBasedMCConfig = {
  /** Master switch. When false, time-based microcompact is a no-op. */
  enabled: boolean
  /** Trigger when (now − last assistant timestamp) exceeds this many minutes.
   *  60 is the safe choice: the server's 1h cache TTL is guaranteed expired
   *  for all users, so we never force a miss that wouldn't have happened. */
  gapThresholdMinutes: number
  /** Keep this many most-recent compactable tool results.
   *  When set, takes priority over any default; older results are cleared. */
  keepRecent: number
}

const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
  enabled: false,
  gapThresholdMinutes: 60,
  keepRecent: 5,
}

/**
 * 读取「按时间 microcompact」的当前配置。
 *
 * 为什么需要：策略参数（开不开、多久算闲置、保留几条）需要能远程调整、做实验，
 * 不能写死在代码里。统一从这里读，调用方只管拿结果。
 *
 * @returns 远程配置；读不到（网络失败 / 实验未命中）时返回内置默认值，
 *          而默认值是 enabled=false，即**默认关闭**——出任何问题都退化成「不清理」，安全方向。
 *
 * 关键步骤：① 无条件先调一次 GrowthBook 读取（见下面行内注释的原因）
 *          ② 把远程配置与默认值合并 ③ 返回完整配置对象（调用方不需要再判空）
 */
export function getTimeBasedMCConfig(): TimeBasedMCConfig {
  // Hoist the GB read so exposure fires on every eval path, not just when
  // the caller's other conditions (querySource, messages.length) pass.
  // 中文补充上面那段英文：把 GrowthBook 的读取「提升」到这里、无条件先执行一次，
  // 是为了让「曝光（exposure）」在**每一条**求值路径上都打点，
  // 而不是只在调用方那堆条件（querySource、messages.length）都成立时才打点——否则 A/B 实验的数据会统计偏。
  // 泛型 `<TimeBasedMCConfig>` 写在函数名后面，≈ Java 的 `this.<TimeBasedMCConfig>getFeatureValue(...)`。
  return getFeatureValue_CACHED_MAY_BE_STALE<TimeBasedMCConfig>(
    // 'tengu_slate_heron' 是 GrowthBook 里这个实验 / 配置的 key（随机生成的代号，没有字面含义）。
    // 第二个参数是兜底默认值：远程没配、或读取失败时就用它。
    'tengu_slate_heron',
    TIME_BASED_MC_CONFIG_DEFAULTS,
  )
}
