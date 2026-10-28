/**
 * ============================================================================
 *  【文件总览】src/services/SessionMemory/sessionMemoryUtils.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 sessionMemoryUtils.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：SessionMemoryConfig、DEFAULT_SESSION_MEMORY_CONFIG、getLastSummarizedMessageId、setLastSummarizedMessageId、markExtractionStarted、markExtractionCompleted、waitForSessionMemoryExtraction、getSessionMemoryContent、setSessionMemoryConfig、getSessionMemoryConfig、recordExtractionTokenCount、isSessionMemoryInitialized、markSessionMemoryInitialized、hasMetInitializationThreshold、hasMetUpdateThreshold、getToolCallsBetweenUpdates、resetSessionMemoryState
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
 * Session Memory utility functions that can be imported without circular dependencies.
 * These are separate from the main sessionMemory.ts to avoid importing runAgent.
 */

import { isFsInaccessible } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { sleep } from '../../utils/sleep.js'
import { logEvent } from '../analytics/index.js'

const EXTRACTION_WAIT_TIMEOUT_MS = 15000
const EXTRACTION_STALE_THRESHOLD_MS = 60000 // 1 minute

/**
 * Configuration for session memory extraction thresholds
 */
export type SessionMemoryConfig = {
  /** Minimum context window tokens before initializing session memory.
   * Uses the same token counting as autocompact (input + output + cache tokens)
   * to ensure consistent behavior between the two features. */
  minimumMessageTokensToInit: number
  /** Minimum context window growth (in tokens) between session memory updates.
   * Uses the same token counting as autocompact (tokenCountWithEstimation)
   * to measure actual context growth, not cumulative API usage. */
  minimumTokensBetweenUpdate: number
  /** Number of tool calls between session memory updates */
  toolCallsBetweenUpdates: number
}

// Default configuration values
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
}

// Current session memory configuration
let sessionMemoryConfig: SessionMemoryConfig = {
  ...DEFAULT_SESSION_MEMORY_CONFIG,
}

// Track the last summarized message ID (shared state)
let lastSummarizedMessageId: string | undefined

// Track extraction state with timestamp (set by sessionMemory.ts)
let extractionStartedAt: number | undefined

// Track context size at last memory extraction (for minimumTokensBetweenUpdate)
let tokensAtLastExtraction = 0

// Track whether session memory has been initialized (met minimumMessageTokensToInit)
let sessionMemoryInitialized = false

/**
 * Get the message ID up to which the session memory is current
 */
export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

/**
 * Set the last summarized message ID (called from sessionMemory.ts)
 */
export function setLastSummarizedMessageId(
  messageId: string | undefined,
): void {
  lastSummarizedMessageId = messageId
}

/**
 * Mark extraction as started (called from sessionMemory.ts)
 */
export function markExtractionStarted(): void {
  extractionStartedAt = Date.now()
}

/**
 * Mark extraction as completed (called from sessionMemory.ts)
 */
export function markExtractionCompleted(): void {
  extractionStartedAt = undefined
}

/**
 * Wait for any in-progress session memory extraction to complete (with 15s timeout)
 * Returns immediately if no extraction is in progress or if extraction is stale (>1min old).
 */
export async function waitForSessionMemoryExtraction(): Promise<void> {
  const startTime = Date.now()
  while (extractionStartedAt) {
    const extractionAge = Date.now() - extractionStartedAt
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) {
      // Extraction is stale, don't wait
      return
    }

    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) {
      // Timeout - continue anyway
      return
    }

    await sleep(1000)
  }
}

/**
 * Get the current session memory content
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const fs = getFsImplementation()
  const memoryPath = getSessionMemoryPath()

  try {
    const content = await fs.readFile(memoryPath, { encoding: 'utf-8' })

    logEvent('tengu_session_memory_loaded', {
      content_length: content.length,
    })

    return content
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

/**
 * Set the session memory configuration
 */
export function setSessionMemoryConfig(
  config: Partial<SessionMemoryConfig>,
): void {
  sessionMemoryConfig = {
    ...sessionMemoryConfig,
    ...config,
  }
}

/**
 * Get the current session memory configuration
 */
export function getSessionMemoryConfig(): SessionMemoryConfig {
  return { ...sessionMemoryConfig }
}

/**
 * Record the context size at the time of extraction.
 * Used to measure context growth for minimumTokensBetweenUpdate threshold.
 */
export function recordExtractionTokenCount(currentTokenCount: number): void {
  tokensAtLastExtraction = currentTokenCount
}

/**
 * Check if session memory has been initialized (met minimumTokensToInit threshold)
 */
export function isSessionMemoryInitialized(): boolean {
  return sessionMemoryInitialized
}

/**
 * Mark session memory as initialized
 */
export function markSessionMemoryInitialized(): void {
  sessionMemoryInitialized = true
}

/**
 * Check if we've met the threshold to initialize session memory.
 * Uses total context window tokens (same as autocompact) for consistent behavior.
 */
export function hasMetInitializationThreshold(
  currentTokenCount: number,
): boolean {
  return currentTokenCount >= sessionMemoryConfig.minimumMessageTokensToInit
}

/**
 * Check if we've met the threshold for the next update.
 * Measures actual context window growth since last extraction
 * (same metric as autocompact and initialization threshold).
 */
export function hasMetUpdateThreshold(currentTokenCount: number): boolean {
  const tokensSinceLastExtraction = currentTokenCount - tokensAtLastExtraction
  return (
    tokensSinceLastExtraction >= sessionMemoryConfig.minimumTokensBetweenUpdate
  )
}

/**
 * Get the configured number of tool calls between updates
 */
export function getToolCallsBetweenUpdates(): number {
  return sessionMemoryConfig.toolCallsBetweenUpdates
}

/**
 * Reset session memory state (useful for testing)
 */
export function resetSessionMemoryState(): void {
  sessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG }
  tokensAtLastExtraction = 0
  sessionMemoryInitialized = false
  lastSummarizedMessageId = undefined
  extractionStartedAt = undefined
}
