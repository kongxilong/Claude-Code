/**
 * ============================================================================
 *  【文件总览】src/tools/TaskGetTool/TaskGetTool.ts
 *              —— 按 id 取回一条任务的完整详情（TaskList 是"摘要"，本工具是"全文"）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 TaskGet 工具：给一个任务 id，返回这条任务的**完整字段**
 *  （subject / description / status / blocks / blockedBy）。
 *
 *  【它和 TaskList 的分工】
 *      TaskList → 列出**所有**任务的**摘要**（id + 标题 + 状态 + owner + 被谁挡住）
 *      TaskGet  → 只看**一条**任务的**全文**（含完整的 description 和双向依赖）
 *  这是典型的两级设计：先便宜地扫一遍全貌，再对感兴趣的少数几条花代价取详情。
 *  原因很实际：任务多的时候，把所有 description 全塞进上下文会非常浪费 token。
 *
 *  【任务存在哪？】
 *  磁盘上的 JSON 文件：~/.claude/tasks/<taskListId>/<taskId>.json
 *  （详见 TaskCreateTool.ts 文件头的说明）。本工具只是把它读出来。
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "TaskGet"）
 *        └─> 本文件 TaskGetTool.call()                ← ★ 你在这里
 *              └─> getTask()   src/utils/tasks.ts     → 读那个 JSON 文件（读不到返回 null）
 *
 *  【本文件包含什么】
 *   1. inputSchema / outputSchema  入参出参的 zod 规则
 *   2. call()                      读任务；**找不到不报错，返回 null**
 *   3. mapToolResultToToolResultBlockParam()  把任务渲染成几行纯文本给模型看
 *
 *  【一个重要的设计选择：找不到时"不抛错"】
 *  call() 里 `if (!task) return { data: { task: null } }`：
 *  任务不存在是**正常的业务结果**（可能被删了、或模型记错 id），
 *  抛异常会让整个工具调用变成"错误"，模型容易被吓得重来一遍。
 *  返回 null + 一句 "Task not found" 让模型自己去纠正，体验更稳。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `.nullable()`：允许这个字段是 null。所以出参类型是 `{ task: {...} | null }`，
 *    ≈ Java 的 Optional 或者说"可空字段"，用之前必须先判空。
 *  - `z.array(z.string())` ≈ `List<String>`。
 *  - `content as Output`：`as` 是类型断言 ≈ Java 的强制类型转换，运行时不校验。
 *    这里因为框架传进来的参数是宽类型，需要断言成我们自己的 Output 才能用。
 *  - `t => !t.metadata?._internal` 箭头函数 ≈ lambda；`?.` 可选链防 null。
 *  - `lines.push(...)` / `lines.join('\n')`：数组 ≈ Java 的 ArrayList。
 *    （下方 mapToolResult... 里用得多）
 *  - `task.blockedBy.map(id => `#${id}`).join(', ')`：
 *    map（≈ stream().map）+ join（≈ String.join），一行完成转换拼接。
 */
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getTask,
  getTaskListId,
  isTodoV2Enabled,
  TaskStatusSchema,
} from '../../utils/tasks.js'
import { TASK_GET_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

// 入参只有一个 taskId。用 strictObject：模型如果多塞字段会被直接拒绝。
const inputSchema = lazySchema(() =>
  z.strictObject({
    // 任务 id 是**字符串**（不是数字）。历史上它是自增整数，但对外一律按字符串处理，
    // 这样将来换成 UUID 之类的格式不会破坏兼容性。
    taskId: z.string().describe('The ID of the task to retrieve'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 出参：一个可能为 null 的 task。
const outputSchema = lazySchema(() =>
  z.object({
    task: z
      .object({
        id: z.string(),
        subject: z.string(),
        description: z.string(),
        status: TaskStatusSchema(),
        blocks: z.array(z.string()),
        blockedBy: z.array(z.string()),
      })
      .nullable(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * TaskGetTool 本体。
 *
 * 注意 isReadOnly() 返回 true：本工具只读一个 JSON 文件，
 * 不改任何状态 —— 因此可以免权限弹框直接放行。
 */
export const TaskGetTool = buildTool({
  name: TASK_GET_TOOL_NAME,
  // 延迟加载模式下给 ToolSearch 用的一句话。
  searchHint: 'retrieve a task by ID',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  // 懒加载：用到时才构造 schema。
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  // 出参 schema：让模型知道会拿到哪些字段（用于结构化输出）。
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TaskGet'
  },
  // 延迟加载，省上下文。
  shouldDefer: true,
  // todo v2 开关没开就不注册。
  isEnabled() {
    return isTodoV2Enabled()
  },
  // 只读操作，可以和其它工具并行跑。
  isConcurrencySafe() {
    return true
  },
  // 只读：不弹权限框，直接放行（读自己磁盘上的任务文件没有安全风险）。
  isReadOnly() {
    return true
  },
  /**
   * 给安全分类器的一句话摘要。这里回 taskId —— 光看 id 判断不了危险性，
   * 但读任务本身无害，所以给个标识让分类器知道"这是在读任务"即可。
   */
  toAutoClassifierInput(input) {
    return input.taskId
  },
  // 用框架默认渲染。
  renderToolUseMessage() {
    return null
  },
  /**
   * 按 id 读取一条任务的完整信息。
   *
   * 为什么需要：模型领到一个任务后，需要完整的需求描述（description）和
   * 依赖关系才知道怎么下手 —— 而这些在 TaskList 的摘要里是没有的。
   *
   * @param input 已解构的入参 { taskId }。
   * @returns `{ data: { task } }`；task 为 null 表示任务不存在。
   *
   * 关键步骤：
   *   ① getTaskListId() 定位"当前这份任务列表"（团队共享 / 会话独占）
   *   ② getTask() 读对应的 JSON 文件
   *   ③ 读不到 → 返回 null（不抛错，让模型自己纠正）
   *   ④ 读到 → 逐字段挑出来返回（**不**直接把整个对象透传，避免内部字段外泄）
   */
  async call({ taskId }) {
    const taskListId = getTaskListId()

    const task = await getTask(taskListId, taskId)

    // 任务不存在：返回 null 而不是抛异常。
    // 理由：这是"正常的查询结果为空"，不是程序错误；抛错会让模型误以为工具坏了。
    if (!task) {
      return {
        data: {
          task: null,
        },
      }
    }

    return {
      data: {
        task: {
          id: task.id,
          subject: task.subject,
          description: task.description,
          status: task.status,
          blocks: task.blocks,
          blockedBy: task.blockedBy,
        },
      },
    }
  },
  /**
   * 把任务渲染成给模型看的几行文本。
   *
   * 为什么不直接回 JSON：纯文本更省 token，模型也更容易读。
   * 依赖（blockedBy / blocks）只在**非空时**才追加一行 ——
   * 大多数任务没有依赖，白打两行只会浪费上下文。
   *
   * @param content   call() 的返回值。
   * @param toolUseID 对应的 tool_use id，必须原样回传。
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    if (!task) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'Task not found',
      }
    }

    // 拼成一个字符串数组，最后用换行 join。
    // 依赖行是**条件追加**的：没有依赖就不出现，省 token 也减少干扰。
    const lines = [
      `Task #${task.id}: ${task.subject}`,
      `Status: ${task.status}`,
      `Description: ${task.description}`,
    ]

    if (task.blockedBy.length > 0) {
      lines.push(`Blocked by: ${task.blockedBy.map(id => `#${id}`).join(', ')}`)
    }
    if (task.blocks.length > 0) {
      lines.push(`Blocks: ${task.blocks.map(id => `#${id}`).join(', ')}`)
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
