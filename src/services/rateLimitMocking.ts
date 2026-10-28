/**
 * ============================================================================
 *  【文件总览】src/services/rateLimitMocking.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  限流打桩：提供把限流响应「录制/回放」的能力，便于测试。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：processRateLimitHeaders、shouldProcessRateLimits、checkMockRateLimitError、isMockRateLimitError
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
 * Facade for rate limit header processing
 * This isolates mock logic from production code
 */

import { APIError } from '@anthropic-ai/sdk'
import {
  applyMockHeaders,
  checkMockFastModeRateLimit,
  getMockHeaderless429Message,
  getMockHeaders,
  isMockFastModeRateLimitScenario,
  shouldProcessMockLimits,
} from './mockRateLimits.js'

/**
 * Process headers, applying mocks if /mock-limits command is active
 */
export function processRateLimitHeaders(
  headers: globalThis.Headers,
): globalThis.Headers {
  // Only apply mocks for Ant employees using /mock-limits command
  if (shouldProcessMockLimits()) {
    return applyMockHeaders(headers)
  }
  return headers
}

/**
 * Check if we should process rate limits (either real subscriber or /mock-limits command)
 */
export function shouldProcessRateLimits(isSubscriber: boolean): boolean {
  return isSubscriber || shouldProcessMockLimits()
}

/**
 * Check if mock rate limits should throw a 429 error
 * Returns the error to throw, or null if no error should be thrown
 * @param currentModel The model being used for the current request
 * @param isFastModeActive Whether fast mode is currently active (for fast-mode-only mocks)
 */
export function checkMockRateLimitError(
  currentModel: string,
  isFastModeActive?: boolean,
): APIError | null {
  if (!shouldProcessMockLimits()) {
    return null
  }

  const headerlessMessage = getMockHeaderless429Message()
  if (headerlessMessage) {
    return new APIError(
      429,
      { error: { type: 'rate_limit_error', message: headerlessMessage } },
      headerlessMessage,
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      new globalThis.Headers(),
    )
  }

  const mockHeaders = getMockHeaders()
  if (!mockHeaders) {
    return null
  }

  // Check if we should throw a 429 error
  // Only throw if:
  // 1. Status is rejected AND
  // 2. Either no overage headers OR overage is also rejected
  // 3. For Opus-specific limits, only throw if actually using an Opus model
  const status = mockHeaders['anthropic-ratelimit-unified-status']
  const overageStatus =
    mockHeaders['anthropic-ratelimit-unified-overage-status']
  const rateLimitType =
    mockHeaders['anthropic-ratelimit-unified-representative-claim']

  // Check if this is an Opus-specific rate limit
  const isOpusLimit = rateLimitType === 'seven_day_opus'

  // Check if current model is an Opus model (handles all variants including aliases)
  const isUsingOpus = currentModel.includes('opus')

  // For Opus limits, only throw 429 if actually using Opus
  // This simulates the real API behavior where fallback to Sonnet succeeds
  if (isOpusLimit && !isUsingOpus) {
    return null
  }

  // Check for mock fast mode rate limits (handles expiry, countdown, etc.)
  if (isMockFastModeRateLimitScenario()) {
    const fastModeHeaders = checkMockFastModeRateLimit(isFastModeActive)
    if (fastModeHeaders === null) {
      return null
    }
    // Create a mock 429 error with the fast mode headers
    const error = new APIError(
      429,
      { error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } },
      'Rate limit exceeded',
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      new globalThis.Headers(
        Object.entries(fastModeHeaders).filter(([_, v]) => v !== undefined) as [
          string,
          string,
        ][],
      ),
    )
    return error
  }

  const shouldThrow429 =
    status === 'rejected' && (!overageStatus || overageStatus === 'rejected')

  if (shouldThrow429) {
    // Create a mock 429 error with the appropriate headers
    const error = new APIError(
      429,
      { error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } },
      'Rate limit exceeded',
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      new globalThis.Headers(
        Object.entries(mockHeaders).filter(([_, v]) => v !== undefined) as [
          string,
          string,
        ][],
      ),
    )
    return error
  }

  return null
}

/**
 * Check if this is a mock 429 error that shouldn't be retried
 */
export function isMockRateLimitError(error: APIError): boolean {
  return shouldProcessMockLimits() && error.status === 429
}

/**
 * Check if /mock-limits command is currently active (for UI purposes)
 */
export { shouldProcessMockLimits }
