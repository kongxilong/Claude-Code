/**
 * ============================================================================
 *  【文件总览】src/services/AgentSummary/agentSummary.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 agentSummary.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：startAgentSummarization
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
 * Periodic background summarization for coordinator mode sub-agents.
 *
 * Forks the sub-agent's conversation every ~30s using runForkedAgent()
 * to generate a 1-2 sentence progress summary. The summary is stored
 * on AgentProgress for UI display.
 *
 * Cache sharing: uses the same CacheSafeParams as the parent agent
 * to share the prompt cache. Tools are kept in the request for cache
 * key matching but denied via canUseTool callback.
 */

import type { TaskContext } from '../../Task.js'
import { updateAgentSummary } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { filterIncompleteToolCalls } from '../../tools/AgentTool/runAgent.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  type CacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentTranscript } from '../../utils/sessionStorage.js'

const SUMMARY_INTERVAL_MS = 30_000

function buildSummaryPrompt(previousSummary: string | null): string {
  const prevLine = previousSummary
    ? `\nPrevious: "${previousSummary}" — say something NEW.\n`
    : ''

  return `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.
${prevLine}
Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`
}

export function startAgentSummarization(
  taskId: string,
  agentId: AgentId,
  cacheSafeParams: CacheSafeParams,
  setAppState: TaskContext['setAppState'],
): { stop: () => void } {
  // Drop forkContextMessages from the closure — runSummary rebuilds it each
  // tick from getAgentTranscript(). Without this, the original fork messages
  // (passed from AgentTool.tsx) are pinned for the lifetime of the timer.
  const { forkContextMessages: _drop, ...baseParams } = cacheSafeParams
  let summaryAbortController: AbortController | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let previousSummary: string | null = null

  async function runSummary(): Promise<void> {
    if (stopped) return

    logForDebugging(`[AgentSummary] Timer fired for agent ${agentId}`)

    try {
      // Read current messages from transcript
      const transcript = await getAgentTranscript(agentId)
      if (!transcript || transcript.messages.length < 3) {
        // Not enough context yet — finally block will schedule next attempt
        logForDebugging(
          `[AgentSummary] Skipping summary for ${taskId}: not enough messages (${transcript?.messages.length ?? 0})`,
        )
        return
      }

      // Filter to clean message state
      const cleanMessages = filterIncompleteToolCalls(transcript.messages)

      // Build fork params with current messages
      const forkParams: CacheSafeParams = {
        ...baseParams,
        forkContextMessages: cleanMessages,
      }

      logForDebugging(
        `[AgentSummary] Forking for summary, ${cleanMessages.length} messages in context`,
      )

      // Create abort controller for this summary
      summaryAbortController = new AbortController()

      // Deny tools via callback, NOT by passing tools:[] - that busts cache
      const canUseTool = async () => ({
        behavior: 'deny' as const,
        message: 'No tools needed for summary',
        decisionReason: { type: 'other' as const, reason: 'summary only' },
      })

      // DO NOT set maxOutputTokens here. The fork piggybacks on the main
      // thread's prompt cache by sending identical cache-key params (system,
      // tools, model, messages prefix, thinking config). Setting maxOutputTokens
      // would clamp budget_tokens, creating a thinking config mismatch that
      // invalidates the cache.
      //
      // ContentReplacementState is cloned by default in createSubagentContext
      // from forkParams.toolUseContext (the subagent's LIVE state captured at
      // onCacheSafeParams time). No explicit override needed.
      const result = await runForkedAgent({
        promptMessages: [
          createUserMessage({ content: buildSummaryPrompt(previousSummary) }),
        ],
        cacheSafeParams: forkParams,
        canUseTool,
        querySource: 'agent_summary',
        forkLabel: 'agent_summary',
        overrides: { abortController: summaryAbortController },
        skipTranscript: true,
      })

      if (stopped) return

      // Extract summary text from result
      for (const msg of result.messages) {
        if (msg.type !== 'assistant') continue
        // Skip API error messages
        if (msg.isApiErrorMessage) {
          logForDebugging(
            `[AgentSummary] Skipping API error message for ${taskId}`,
          )
          continue
        }
        const textBlock = msg.message.content.find(b => b.type === 'text')
        if (textBlock?.type === 'text' && textBlock.text.trim()) {
          const summaryText = textBlock.text.trim()
          logForDebugging(
            `[AgentSummary] Summary result for ${taskId}: ${summaryText}`,
          )
          previousSummary = summaryText
          updateAgentSummary(taskId, summaryText, setAppState)
          break
        }
      }
    } catch (e) {
      if (!stopped && e instanceof Error) {
        logError(e)
      }
    } finally {
      summaryAbortController = null
      // Reset timer on completion (not initiation) to prevent overlapping summaries
      if (!stopped) {
        scheduleNext()
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    timeoutId = setTimeout(runSummary, SUMMARY_INTERVAL_MS)
  }

  function stop(): void {
    logForDebugging(`[AgentSummary] Stopping summarization for ${taskId}`)
    stopped = true
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (summaryAbortController) {
      summaryAbortController.abort()
      summaryAbortController = null
    }
  }

  // Start the first timer
  scheduleNext()

  return { stop }
}
