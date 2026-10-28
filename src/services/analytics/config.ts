/**
 * 【一句话定位】
 * 埋点的「总开关」：判断当前环境是否应该完全禁用 analytics（上报）。
 * 只有两个函数，但它是所有上报路径的第一道闸门。
 *
 * 【在架构中的位置】
 * 调用链：
 *   datadog.ts / firstPartyEventLogger.ts / growthbook.ts 等在真正上报前
 *     → 本文件 isAnalyticsDisabled()（关了就直接 return，一个字节都不发）
 *       → utils/privacyLevel.js isTelemetryDisabled()（读用户隐私设置）
 * 单独抽成一个文件的理由（见英文注释）：Datadog 和一方上报两条链路都要用同一套判断，
 * 抽出来才能保证「要么都关、要么都开」，不会出现只关了一半的情况。
 *
 * 【本文件包含什么】
 * - isAnalyticsDisabled()：是否禁用全部埋点。
 * - isFeedbackSurveyDisabled()：是否禁用「反馈问卷」提示（判断条件比上面宽松）。
 *
 * 【TS 语法速查】
 * - `export function isAnalyticsDisabled(): boolean {`：返回 boolean 的普通函数。
 *   ≈ Java 的 `public static boolean isAnalyticsDisabled()`。
 * - `return a || b || c || d`：`||` 是逻辑或，且会【短路】（前一个为真就不再算后面）。和 Java 一样。
 *   这一串 || 表达的是「只要命中任一条件就禁用」。
 * - `process.env.NODE_ENV`：Node 的环境变量对象。
 *   ≈ Java 的 `System.getenv("NODE_ENV")`，但 TS 里 process.env 是个普通对象，直接点属性即可。
 *   注意：不存在时返回 undefined（不是 null）。
 * - `isEnvTruthy(x)`：工具函数，把 '1'/'true'/'yes' 这类字符串统一判为真。
 *   之所以要它：环境变量都是字符串，'0' 直接当布尔用是 true（非空字符串即真），很容易踩坑。
 * - 为什么两个函数判断条件不同：
 *   isAnalyticsDisabled 包含 Bedrock/Vertex/Foundry（第三方云）→ 这些环境数据不能出境到 Anthropic；
 *   isFeedbackSurveyDisabled 不包含它们 → 问卷只是本地 UI 弹窗，不涉及数据传输，
 *   企业客户自己用 OTEL 收集即可，没必要连带禁掉。
 *   这体现了「按数据的敏感程度分级管控」而不是一刀切。
 * - `@internal` / JSDoc：和 Java 的 Javadoc 完全一样的写法（/** ... */ + @param/@returns）。
 */
/**
 * Shared analytics configuration
 *
 * Common logic for determining when analytics should be disabled
 * across all analytics systems (Datadog, 1P)
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

/**
 * Check if analytics operations should be disabled
 *
 * Analytics is disabled in the following cases:
 * - Test environment (NODE_ENV === 'test')
 * - Third-party cloud providers (Bedrock/Vertex)
 * - Privacy level is no-telemetry or essential-traffic
 */
// 中文补充：埋点总闸。以下任一情况成立就完全关闭上报：
//   ① 测试环境（NODE_ENV=test）—— 别让测试用例的调用污染真实数据
//   ② 走 Bedrock / Vertex / Foundry 第三方云 —— 数据不出客户自己的云，不发给 Anthropic
//   ③ 用户隐私设置里关了遥测（isTelemetryDisabled）
// 顺序上把「便宜的判断」放前面：process.env 读取是纯内存操作，最快；
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
    isTelemetryDisabled()
  )
}

/**
 * Check if the feedback survey should be suppressed.
 *
 * Unlike isAnalyticsDisabled(), this does NOT block on 3P providers
 * (Bedrock/Vertex/Foundry). The survey is a local UI prompt with no
 * transcript data — enterprise customers capture responses via OTEL.
 */
// 中文补充：反馈问卷的开关，条件比 isAnalyticsDisabled 更宽松（不管第三方云）。
// 原因：问卷只是本地弹个提示问「体验怎么样」，不涉及把对话内容传出去，
// 企业客户可以自己通过 OTEL 接走，没必要因为用了 Bedrock 就禁用。
export function isFeedbackSurveyDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
