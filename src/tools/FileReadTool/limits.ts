/**
 * ============================================================================
 *  【文件总览】src/tools/FileReadTool/limits.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 limits.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  由主循环 src/query.ts 在需要对应能力时，通过工具调度（runTools → 工具 execute）调用本文件；本文件属于「工具层」，负责把某一类能力封装成一个可被模型点名的 Tool。
 *
 *  【本文件包含什么】
 *  主要导出/定义：DEFAULT_MAX_OUTPUT_TOKENS、FileReadingLimits、getDefaultFileReadingLimits
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

/**
 * Read tool output limits.  Two caps apply to text reads:
 *
 *   | limit         | default | checks                    | cost          | on overflow     |
 *   |---------------|---------|---------------------------|---------------|-----------------|
 *   | maxSizeBytes  | 256 KB  | TOTAL FILE SIZE (not out) | 1 stat        | throws pre-read |
 *   | maxTokens     | 25000   | actual output tokens      | API roundtrip | throws post-read|
 *
 * Known mismatch: maxSizeBytes gates on total file size, not the slice.
 * Tested truncating instead of throwing for explicit-limit reads that
 * exceed the byte cap (#21841, Mar 2026).  Reverted: tool error rate
 * dropped but mean tokens rose — the throw path yields a ~100-byte error
 * tool-result while truncation yields ~25K tokens of content at the cap.
 */
import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { MAX_OUTPUT_SIZE } from 'src/utils/file.js'
export const DEFAULT_MAX_OUTPUT_TOKENS = 25000

/**
 * Env var override for max output tokens. Returns undefined when unset/invalid
 * so the caller can fall through to the next precedence tier.
 */
function getEnvMaxTokens(): number | undefined {
  const override = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
  if (override) {
    const parsed = parseInt(override, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return undefined
}

export type FileReadingLimits = {
  maxTokens: number
  maxSizeBytes: number
  includeMaxSizeInPrompt?: boolean
  targetedRangeNudge?: boolean
}

/**
 * Default limits for Read tool when the ToolUseContext doesn't supply an
 * override. Memoized so the GrowthBook value is fixed at first call — avoids
 * the cap changing mid-session as the flag refreshes in the background.
 *
 * Precedence for maxTokens: env var > GrowthBook > DEFAULT_MAX_OUTPUT_TOKENS.
 * (Env var is a user-set override, should beat experiment infrastructure.)
 *
 * Defensive: each field is individually validated; invalid values fall
 * through to the hardcoded defaults (no route to cap=0).
 */
export const getDefaultFileReadingLimits = memoize((): FileReadingLimits => {
  const override =
    getFeatureValue_CACHED_MAY_BE_STALE<Partial<FileReadingLimits> | null>(
      'tengu_amber_wren',
      {},
    )

  const maxSizeBytes =
    typeof override?.maxSizeBytes === 'number' &&
    Number.isFinite(override.maxSizeBytes) &&
    override.maxSizeBytes > 0
      ? override.maxSizeBytes
      : MAX_OUTPUT_SIZE

  const envMaxTokens = getEnvMaxTokens()
  const maxTokens =
    envMaxTokens ??
    (typeof override?.maxTokens === 'number' &&
    Number.isFinite(override.maxTokens) &&
    override.maxTokens > 0
      ? override.maxTokens
      : DEFAULT_MAX_OUTPUT_TOKENS)

  const includeMaxSizeInPrompt =
    typeof override?.includeMaxSizeInPrompt === 'boolean'
      ? override.includeMaxSizeInPrompt
      : undefined

  const targetedRangeNudge =
    typeof override?.targetedRangeNudge === 'boolean'
      ? override.targetedRangeNudge
      : undefined

  return {
    maxSizeBytes,
    maxTokens,
    includeMaxSizeInPrompt,
    targetedRangeNudge,
  }
})
