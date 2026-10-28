/**
 * ============================================================================
 *  【文件总览】src/services/tips/tipScheduler.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 tipScheduler.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：selectTipWithLongestTimeSinceShown、getTipToShowOnSpinner、recordShownTip
 *
 *  【TS 语法速查】（针对本文件实际用到的，逐条 Java 对照）
 *    · `?.` 可选链 ≈ Java 里 `obj != null ? obj.x : null`
 *    · `??` 空值合并 ≈ `a != null ? a : b`（注意与 `||` 区别：`??` 只在 null/undefined 时兜底，0 和 '' 不会被动替换）
 *    · `!` 非空断言（如 `x!`）≈ 强制类型转换，骗过编译器；运行时并不做检查，乱用会抛错
 *    · `as X` ≈ Java 的 `(X)obj` 强制转换
 *    · `type X = {...}` ≈ record，但 TS 是结构化（鸭子）类型：形状对得上就算同一类型，不要求显式 implements
 *    · `A | B` 联合类型 ≈ 受限的 sealed interface / 代数数据类型
 *    · `{...obj, k: v}` 展开 ≈ 生成新对象（不可变更新），原对象不变
 *    · `x is T` 类型谓词 ≈ Java 的 `instanceof` 模式守卫，用于收窄类型
 *    · `async function*` + `yield` + `for await` ≈ Java 的 Flux / 响应式流（一边产出一边消费）
 *    · `feature('X')` 是编译期开关（类似 #ifdef），不是运行时 if
 *    · `arr.at(-1)` 取最后一个元素（Java 没有，要 `arr.get(arr.size()-1)`）
 *    · 类型标注写在变量名**后面**（`x: string`），Java 写在前面（`String x`）——这是最容易看串行的地方
 *    · 箭头函数 `x => x.y` ≈ Java 的 lambda
 */

import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getSessionsSinceLastShown, recordTipShown } from './tipHistory.js'
import { getRelevantTips } from './tipRegistry.js'
import type { Tip, TipContext } from './types.js'

export function selectTipWithLongestTimeSinceShown(
  availableTips: Tip[],
): Tip | undefined {
  if (availableTips.length === 0) {
    return undefined
  }

  if (availableTips.length === 1) {
    return availableTips[0]
  }

  // Sort tips by sessions since last shown (descending) and take the first one
  // This is the tip that hasn't been shown for the longest time
  const tipsWithSessions = availableTips.map(tip => ({
    tip,
    sessions: getSessionsSinceLastShown(tip.id),
  }))

  tipsWithSessions.sort((a, b) => b.sessions - a.sessions)
  return tipsWithSessions[0]?.tip
}

export async function getTipToShowOnSpinner(
  context?: TipContext,
): Promise<Tip | undefined> {
  // Check if tips are disabled (default to true if not set)
  if (getSettings_DEPRECATED().spinnerTipsEnabled === false) {
    return undefined
  }

  const tips = await getRelevantTips(context)
  if (tips.length === 0) {
    return undefined
  }

  return selectTipWithLongestTimeSinceShown(tips)
}

export function recordShownTip(tip: Tip): void {
  // Record in history
  recordTipShown(tip.id)

  // Log event for analytics
  logEvent('tengu_tip_shown', {
    tipIdLength:
      tip.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    cooldownSessions: tip.cooldownSessions,
  })
}
