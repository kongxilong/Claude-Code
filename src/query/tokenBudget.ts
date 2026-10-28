/**
 * 【一句话定位】「本轮输出 token 预算」的看门人：当模型这一轮的输出逼近预算上限时，
 * 决定是【继续（并给模型一句催促提示）】还是【停止】，同时识别「收益递减」（模型在反复打转）的情况。
 *
 * 【在架构中的位置】
 *   上游：src/query.ts —— 主循环每收到一段流式响应后调用 checkTokenBudget() 询问「还能继续吗」
 *   下游：utils/tokenBudget.js（getBudgetContinuationMessage——生成给模型的催促文案）
 *   调用链：主循环迭代 → checkTokenBudget(tracker, agentId, budget, globalTurnTokens)
 *     → 'continue'：把 nudgeMessage 追加进上下文，让模型收尾 → 继续生成
 *     → 'stop'：结束本轮，并可带上 completionEvent 做埋点
 *
 * 【本文件包含什么】
 *   BudgetTracker —— 跨迭代的追踪状态：已催促几次、上次增量、上次总量、起始时间
 *   createBudgetTracker() —— 造一个新的追踪器
 *   ContinueDecision / StopDecision / TokenBudgetDecision —— 决策结果（可辨识联合，按 action 判别）
 *   checkTokenBudget() —— 核心：本轮预算检查与决策
 *   COMPLETION_THRESHOLD (0.9) / DIMINISHING_THRESHOLD (500) —— 两个阈值常量
 *
 * 【TS 语法速查】
 *   1. `type A = {...}` 与 `type B = {...}` 再用 `type C = A | B` 组成联合，
 *      且两者都有 `action: 'continue'` / `action: 'stop'` 这样的【字面量字段】——叫可辨识联合，
 *      ≈ Java sealed interface 配两个 record，用 switch 按 action 分支处理。
 *   2. `agentId: string | undefined` 表示「字符串或 undefined」；调用方必须处理 undefined 的情况。
 *   3. `budget: number | null` 中的 null 表示「没有设预算」，与 0 语义不同（0 是「预算为零」）。
 *   4. `tracker.continuationCount++` 直接修改入参对象的字段——这里 tracker 是【可变】的，
 *      不是不可变风格：它本来就是跨迭代累积的计数器，属于刻意的例外。
 *   5. `Math.round(...)` 与 Java 一致；`Date.now()` ≈ System.currentTimeMillis()。
 */
import { getBudgetContinuationMessage } from '../utils/tokenBudget.js'

// 完成阈值 0.9：本轮已用 token 达到预算的 90% 就不再让它继续自由发挥了，要开始收尾。
const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500
// 收益递减阈值 500 token：如果连续两次检查之间只新增了不到 500 token，
// 说明模型基本在原地打转（反复输出同样的东西），再给预算也没意义。

/** 预算追踪器：跨多次检查累积的状态（注意它是【可变】对象，靠副作用逐步更新）。
 *  字段说明：
 *    continuationCount     —— 已经催促过几次（第几次续命）
 *    lastDeltaTokens       —— 上一次检查时「新增了多少 token」
 *    lastGlobalTurnTokens  —— 上一次检查时的本轮总 token 数（用来算增量）
 *    startedAt             —— 起始时间戳（最后算总耗时用）
 */
export type BudgetTracker = {
  continuationCount: number
  lastDeltaTokens: number
  lastGlobalTurnTokens: number
  startedAt: number
}

/** 造一个新的预算追踪器（计数器归零、时间戳取当前）。
 *  每轮主循环开始时创建一份，只服务于这一轮。
 */
export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  }
}

type ContinueDecision = {
// 继续决策：还能写，但要把 nudgeMessage（催促文案）塞给模型，让它知道该收尾了。
  action: 'continue'
  nudgeMessage: string
  continuationCount: number
  pct: number
  turnTokens: number
  budget: number
}

// 停止决策：结束本轮。completionEvent 为 null 表示「没什么值得上报的」（例如压根没设预算），
// 非 null 时里面带上统计信息供埋点使用（催促次数、占比、是否收益递减、总耗时）。
type StopDecision = {
  action: 'stop'
  completionEvent: {
    continuationCount: number
    pct: number
    turnTokens: number
    budget: number
    diminishingReturns: boolean
    durationMs: number
  } | null
}

// 决策结果类型。调用方写 `if (d.action === 'continue')` 之后，TS 会自动把 d 窄化成 ContinueDecision，
// 于是可以直接访问 d.nudgeMessage 而不必强转——这就是可辨识联合的好处。
export type TokenBudgetDecision = ContinueDecision | StopDecision

/** 【核心】检查本轮 token 预算，决定继续还是停止。
 *  入参：
 *    tracker          —— 预算追踪器（会被就地更新：催促计数、上次增量等）
 *    agentId          —— 当前 agent 的 ID；【有值就直接不启用预算机制】（见下）
 *    budget           —— 本轮 token 预算；null 或 <= 0 表示没有预算
 *    globalTurnTokens —— 本轮到目前为止已产出的 token 总数
 *  返回：ContinueDecision（带催促文案）或 StopDecision（可带埋点事件）
 *  判断步骤：
 *    ① 前置排除：子 agent（有 agentId）或没设预算 → 直接 stop 且不上报事件
 *       （预算机制只服务【主线程】的一轮对话，子 agent 有自己的生命周期管理）
 *    ② 算已用百分比 pct 与「距上次检查的增量」delta
 *    ③ 判收益递减：催促过 >= 3 次，且【本次增量】和【上次增量】都小于 500 token → 认定在打转
 *    ④ 若未递减且用量未达 90% → 允许继续：累加催促计数、更新追踪器、返回催促文案
 *    ⑤ 否则停止：带 completionEvent（含 diminishingReturns 标记与总耗时）
 *    ⑥ 兜底：没催促过就直接超预算的情况 → 静默停止（不上报，因为没什么可统计的）
 *  设计要点：催促文案是【追加给模型的内容】，属于「软着陆」——不是硬截断输出，
 *  而是告诉模型「预算快到了，请收尾」，通常能得到一个体面的结尾。
 */
export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  if (agentId || budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null }
  }
// 前置排除：子 agent 不参与预算控制（它们有自己的生命周期），没设预算或预算非正也不启用。
// 返回 { action: 'stop', completionEvent: null }：静默停止，不产生埋点噪音。

  const turnTokens = globalTurnTokens
  const pct = Math.round((turnTokens / budget) * 100)
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens

  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD

// 收益递减判定为什么要看【两次】增量：只看一次的话，模型可能刚好停顿了一下（比如在等工具结果），
// 会被误判成打转。连续两次都很小，才比较可信。另外要求催促过 3 次以上，避免刚开场就误伤。
  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = deltaSinceLastCheck
    tracker.lastGlobalTurnTokens = globalTurnTokens
    return {
      action: 'continue',
      nudgeMessage: getBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget,
    }
  }
// 继续分支：注意这里【就地修改】了 tracker（continuationCount++、更新两个上次值），
// 因为 tracker 是跨迭代累积的可变状态——这是本文件刻意不使用不可变风格的地方。

  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: 'stop',
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    }
  }
// 停止分支：只要「收益递减」或者「曾经催促过」就带事件上报——这两类才有统计价值。

  return { action: 'stop', completionEvent: null }
// 兜底：一次都没催促过就停了（说明首轮就超预算或压根没预算），没有可统计的东西，静默返回。
}
