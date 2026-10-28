/**
 * ============================================================================
 *  【文件总览】src/tools/ScheduleCronTool/CronDeleteTool.ts
 *              —— 按 id 取消一个定时任务
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 CronDelete 工具：给一个 job id，把那个定时任务取消掉。
 *  它是 CronCreateTool 的反向操作（一个是加，一个是删）。
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "CronDelete"）
 *        └─> 本文件 CronDeleteTool.call()                     ← ★ 你在这里
 *              ├─> listAllCronTasks()  src/utils/cronTasks.ts → 列出全部（校验时要先查）
 *              ├─> removeCronTasks()   src/utils/cronTasks.ts → 真正删除
 *              └─> getTeammateContext() src/utils/teammateContext.ts → 判断"我是谁"
 *
 *  【本文件包含什么】
 *   1. validateInput()   两道校验：id 存在吗？是我的吗？
 *   2. call()            调 removeCronTasks([id]) 删除
 *
 *  【★ 权限隔离：只能删自己的任务】
 *  多 agent 场景下，每个定时任务都记着创建它的 agentId。
 *  一个 teammate **只能删除自己创建的**任务；team-lead（没有 teammate 上下文）
 *  则可以删除所有任务。这防止了 agent 之间互相拆台。
 *  ≈ Java 里给资源加 owner 字段，删之前先比对当前用户。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `tasks.find(t => t.id === input.id)`：
 *    `find` ≈ Java 的 `stream().filter(...).findFirst()`，返回元素或 undefined。
 *    箭头函数 `t => ...` ≈ lambda。
 *  - `Promise<ValidationResult>`：显式返回类型。标注在**后面**（Java 在前面）。
 *  - `async call({ id })`：解构出 id。
 *  - `await removeCronTasks([id])`：注意传的是**数组**（批量接口），
 *    虽然这里只删一个 —— 复用同一个 API 比再造一个单删接口更简单。
 *  - `X ? A : B` 三元 ≈ Java 三目运算符（prompt.ts 里用得多）。
 */
import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getCronFilePath,
  listAllCronTasks,
  removeCronTasks,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronDeletePrompt,
  CRON_DELETE_DESCRIPTION,
  CRON_DELETE_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderDeleteResultMessage, renderDeleteToolUseMessage } from './UI.js'

// 入参只有一个 id（CronCreate 返回给模型的那个）。
const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 出参也只有 id —— 取消动作本身没有别的信息值得回传。
const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type DeleteOutput = z.infer<OutputSchema>

/**
 * CronDeleteTool 本体。isEnabled() 同样是 isKairosCronEnabled() 总开关。
 */
export const CronDeleteTool = buildTool({
  name: CRON_DELETE_TOOL_NAME,
  // 给 ToolSearch 用的一句话。
  searchHint: 'cancel a scheduled cron job',
  maxResultSizeChars: 100_000,
  // 延迟加载，省上下文。
  shouldDefer: true,
  // 懒加载 schema。
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 总开关没开就不注册。
  isEnabled() {
    return isKairosCronEnabled()
  },
  /**
   * 给安全分类器的一句话摘要：回 job id 即可 ——
   * 分类器可以拿它去查这个任务是什么，再判断取消它是否安全。
   */
  toAutoClassifierInput(input) {
    return input.id
  },
  // 一句话描述（常量在 prompt.ts）。
  async description() {
    return CRON_DELETE_DESCRIPTION
  },
  // 说明文案随"是否支持 durable"变化（见 prompt.ts）。
  async prompt() {
    return buildCronDeletePrompt(isDurableCronEnabled())
  },
  /**
   * 和 CronCreate 一样返回定时任务文件路径：
   * 让权限规则和文件变化追踪对"创建/删除"两个动作保持一致的处理。
   */
  getPath() {
    return getCronFilePath()
  },
  /**
   * 执行前校验：id 存在吗？是我的吗？
   *
   * 为什么放在 validateInput：返回的结构化错误会喂回给模型，
   * 模型可以据此换一个 id 或先调 CronList 看看有哪些任务。
   *
   * @returns 校验结果；errorCode 1 = 找不到该 id，2 = 不是自己的任务。
   *
   * 关键步骤：
   *   ① 列出全部任务（**内存 + 磁盘**都要查，所以用 listAllCronTasks）
   *   ② 按 id 找；找不到 → errorCode 1
   *   ③ 如果当前是 teammate，比对 agentId；不是自己的 → errorCode 2
   */
  async validateInput(input): Promise<ValidationResult> {
    // 为什么要列全量再找：任务可能只存在于内存（会话内），也可能已经写盘（durable），
    // 只有 listAllCronTasks 会把两处合并起来。
    const tasks = await listAllCronTasks()
    // `find` ≈ stream().filter().findFirst()，找不到返回 undefined。
    const task = tasks.find(t => t.id === input.id)
    // id 不存在：多半是模型记错了，或者任务已经触发完自动删除了。
    if (!task) {
      return {
        result: false,
        message: `No scheduled job with id '${input.id}'`,
        errorCode: 1,
      }
    }
    // 【中文补充】teammate 只能删除**自己**创建的任务。
    // Teammates may only delete their own crons.
    // 拿"我是谁"。主线程（team-lead）时返回 null，表示"没有归属限制"。
    const ctx = getTeammateContext()
      // 【中文补充】越权检查：任务的 agentId 和我不一致 → 拒绝。
      // 目的：防止多个 agent 互相把对方的定时任务删掉（协作场景下很容易出这种事故）。
      // 注意只有 ctx 存在时才检查 —— 主线程没有 ctx，可以删任何人的任务（它是管理者）。
    if (ctx && task.agentId !== ctx.agentId) {
      return {
        result: false,
        message: `Cannot delete cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    // 校验通过，放行。
    return { result: true }
  },
  /**
   * 真正删除一个定时任务。
   *
   * @param input 已解构的入参 { id }。
   * @returns `{ data: { id } }` —— 把删掉的 id 回传，让模型确认删对了。
   *
   * 关键步骤：
   *   ① removeCronTasks([id]) 删除（传数组是因为这是个批量接口）
   *   ② 把 id 原样返回
   *
   * 注意：这里不需要再校验一次 —— 正常流程下 validateInput 已经查过存在性和归属了。
   */
  async call({ id }) {
    // 传数组：removeCronTasks 是批量接口，即使只删一个也要包成数组。
    await removeCronTasks([id])
    return { data: { id } }
  },
  /**
   * 把结果转成 tool_result。一句话就够了 —— 取消动作没有复杂结果。
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Cancelled job ${output.id}.`,
    }
  },
  // 渲染函数在 UI.tsx。
  renderToolUseMessage: renderDeleteToolUseMessage,
  renderToolResultMessage: renderDeleteResultMessage,
} satisfies ToolDef<InputSchema, DeleteOutput>)
