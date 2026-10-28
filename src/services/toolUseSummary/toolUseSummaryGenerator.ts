/**
 * ============================================================================
 *  【文件总览】src/services/toolUseSummary/toolUseSummaryGenerator.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 toolUseSummaryGenerator.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：GenerateToolUseSummaryParams、generateToolUseSummary
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
 * Tool Use Summary Generator
 *
 * Generates human-readable summaries of completed tool batches using Haiku.
 * Used by the SDK to provide high-level progress updates to clients.
 */

import { E_TOOL_USE_SUMMARY_GENERATION_FAILED } from '../../constants/errorIds.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryHaiku } from '../api/claude.js'

const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. It appears as a single-line row in a mobile app and truncates around 30 characters, so think git-commit-subject, not sentence.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`

type ToolInfo = {
  name: string
  input: unknown
  output: unknown
}

export type GenerateToolUseSummaryParams = {
  tools: ToolInfo[]
  signal: AbortSignal
  isNonInteractiveSession: boolean
  lastAssistantText?: string
}

/**
 * Generates a human-readable summary of completed tools.
 *
 * @param params - Parameters including tools executed and their results
 * @returns A brief summary string, or null if generation fails
 */
export async function generateToolUseSummary({
  tools,
  signal,
  isNonInteractiveSession,
  lastAssistantText,
}: GenerateToolUseSummaryParams): Promise<string | null> {
  if (tools.length === 0) {
    return null
  }

  try {
    // Build a concise representation of what tools did
    const toolSummaries = tools
      .map(tool => {
        const inputStr = truncateJson(tool.input, 300)
        const outputStr = truncateJson(tool.output, 300)
        return `Tool: ${tool.name}\nInput: ${inputStr}\nOutput: ${outputStr}`
      })
      .join('\n\n')

    const contextPrefix = lastAssistantText
      ? `User's intent (from assistant's last message): ${lastAssistantText.slice(0, 200)}\n\n`
      : ''

    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([TOOL_USE_SUMMARY_SYSTEM_PROMPT]),
      userPrompt: `${contextPrefix}Tools completed:\n\n${toolSummaries}\n\nLabel:`,
      signal,
      options: {
        querySource: 'tool_use_summary_generation',
        enablePromptCaching: true,
        agents: [],
        isNonInteractiveSession,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    const summary = response.message.content
      .filter(block => block.type === 'text')
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()

    return summary || null
  } catch (error) {
    // Log but don't fail - summaries are non-critical
    const err = toError(error)
    err.cause = { errorId: E_TOOL_USE_SUMMARY_GENERATION_FAILED }
    logError(err)
    return null
  }
}

/**
 * Truncates a JSON value to a maximum length for the prompt.
 */
function truncateJson(value: unknown, maxLength: number): string {
  try {
    const str = jsonStringify(value)
    if (str.length <= maxLength) {
      return str
    }
    return str.slice(0, maxLength - 3) + '...'
  } catch {
    return '[unable to serialize]'
  }
}
