/**
 * ============================================================================
 *  【文件总览】src/tools/TodoWriteTool/TodoWriteTool.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 TodoWriteTool.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  由主循环 src/query.ts 在需要对应能力时，通过工具调度（runTools → 工具 execute）调用本文件；本文件属于「工具层」，负责把某一类能力封装成一个可被模型点名的 Tool。
 *
 *  【本文件包含什么】
 *  主要导出/定义：Output、TodoWriteTool
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

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isTodoV2Enabled } from '../../utils/tasks.js'
import { TodoListSchema } from '../../utils/todo/types.js'
import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    todos: TodoListSchema().describe('The updated todo list'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    oldTodos: TodoListSchema().describe('The todo list before the update'),
    newTodos: TodoListSchema().describe('The todo list after the update'),
    verificationNudgeNeeded: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TodoWriteTool = buildTool({
  name: TODO_WRITE_TOOL_NAME,
  searchHint: 'manage the session task checklist',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  shouldDefer: true,
  isEnabled() {
    return !isTodoV2Enabled()
  },
  toAutoClassifierInput(input) {
    return `${input.todos.length} items`
  },
  async checkPermissions(input) {
    // No permission checks required for todo operations
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async call({ todos }, context) {
    const appState = context.getAppState()
    const todoKey = context.agentId ?? getSessionId()
    const oldTodos = appState.todos[todoKey] ?? []
    const allDone = todos.every(_ => _.status === 'completed')
    const newTodos = allDone ? [] : todos

    // Structural nudge: if the main-thread agent is closing out a 3+ item
    // list and none of those items was a verification step, append a reminder
    // to the tool result. Fires at the exact loop-exit moment where skips
    // happen ("when the last task closed, the loop exited").
    let verificationNudgeNeeded = false
    if (
      feature('VERIFICATION_AGENT') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
      !context.agentId &&
      allDone &&
      todos.length >= 3 &&
      !todos.some(t => /verif/i.test(t.content))
    ) {
      verificationNudgeNeeded = true
    }

    context.setAppState(prev => ({
      ...prev,
      todos: {
        ...prev.todos,
        [todoKey]: newTodos,
      },
    }))

    return {
      data: {
        oldTodos,
        newTodos: todos,
        verificationNudgeNeeded,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ verificationNudgeNeeded }, toolUseID) {
    const base = `Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable`
    const nudge = verificationNudgeNeeded
      ? `\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, spawn the verification agent (subagent_type="${VERIFICATION_AGENT_TYPE}"). You cannot self-assign PARTIAL by listing caveats in your summary \u2014 only the verifier issues a verdict.`
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: base + nudge,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
