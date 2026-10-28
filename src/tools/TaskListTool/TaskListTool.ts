/**
 * ============================================================================
 *  【文件总览】src/tools/TaskListTool/TaskListTool.ts
 *              —— 列出任务清单的摘要（任务系统的"总览视图"）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 TaskList 工具：把当前任务列表里所有任务以**摘要**形式列出来。
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "TaskList"）
 *        └─> 本文件 TaskListTool.call()                    ← ★ 你在这里
 *              └─> listTasks()   src/utils/tasks.ts        → 扫描任务目录，读出所有 JSON
 *
 *  【两个容易忽略、但很重要的细节】
 *  ① **过滤内部任务**：`!t.metadata?._internal`。
 *     系统自己会往同一个任务列表里塞一些内部任务（比如后台 agent 的追踪项），
 *     这些不该展示给模型，否则它会以为是自己要干的活。
 *  ② **过滤已完成的依赖**：blockedBy 里如果某个前置任务已经 completed，
 *     就把它从列表里剔掉 —— 因为"被一个已完成的任务挡住"等于没被挡住。
 *     这一步是为了让模型看到的 blockedBy **始终表示"真正的障碍"**，
 *     否则模型会以为自己无事可做，白白空等。
 *
 *  【三个状态在这里怎么体现】
 *  输出里带着每条任务的 status（pending / in_progress / completed），
 *  模型据此判断"哪些活儿还没人认领"。配合 owner 字段就能挑活：
 *      pending + 没有 owner + blockedBy 为空  = 可以认领的活
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `z.strictObject({})`：空对象 schema —— 本工具**不需要任何入参**。
 *    strict 表示模型传任何字段都会被拒绝（防止它自作主张加参数）。
 *  - `new Set(...)` / `.has(id)`：集合，≈ Java 的 HashSet / contains。
 *    这里用它做 O(1) 的成员判断，避免嵌套循环。
 *  - `.filter(...)` / `.map(...)` ≈ Java 的 stream().filter() / map()，返回新数组。
 *  - `t => !t.metadata?._internal` 箭头函数 ≈ lambda；`?.` 防 null。
 *  - `task.owner ? ` (${task.owner})` : ''` 三元表达式 ≈ Java 的三目运算符。
 *  - `async call()` 没有参数：因为入参 schema 是空的。
 */
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  TaskStatusSchema,
} from '../../utils/tasks.js'
import { TASK_LIST_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

// 入参是**空对象**：列任务不需要任何参数。
// 用 strictObject 是为了挡住模型自己发明参数（strict 模式下多余字段会报错）。
const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

// 出参：任务数组，每条只带 5 个**摘要**字段（不含 description）。
// 这是刻意的省 token 设计：完整描述要的任务请用 TaskGet 单条取。
const outputSchema = lazySchema(() =>
  z.object({
    tasks: z.array(
      z.object({
        id: z.string(),
        subject: z.string(),
        status: TaskStatusSchema(),
        owner: z.string().optional(),
        blockedBy: z.array(z.string()),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * TaskListTool 本体。isReadOnly() = true：只读，不弹权限框。
 */
export const TaskListTool = buildTool({
  name: TASK_LIST_TOOL_NAME,
  // 给 ToolSearch 用的一句话。
  searchHint: 'list all tasks',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TaskList'
  },
  // 延迟加载，省上下文。
  shouldDefer: true,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return true
  // todo v2 开关没开就不注册。
  },
  isReadOnly() {
    return true
  // 只读，可并行。
  },
  renderToolUseMessage() {
    return null
  // 只读：不弹权限框。
  },
  /**
   * 列出所有任务的摘要。
   *
   * 为什么需要：这是模型"找活干"和"看全局进度"的入口。
   * 多 agent 场景下，一个空闲的 teammate 就是靠它发现还有哪些 pending 任务。
   *
   * @returns `{ data: { tasks } }`，每条含 id/subject/status/owner/blockedBy。
   *
   * 关键步骤：
   *   ① listTasks() 读出全部任务（扫描磁盘上的任务目录）
   *   ② 过滤掉 metadata._internal 的内部任务 —— 它们不是给模型干的活
   *   ③ 收集所有 completed 任务的 id 放进 Set，用来在下一步剔除"假障碍"
   *   ④ 逐条映射成摘要，并把 blockedBy 里已完成的前置任务过滤掉
   */
  async call() {
    const taskListId = getTaskListId()

    // 过滤内部任务：系统自己也会往这个列表里放东西（如后台 agent 的追踪项），
    // 那些不是模型该管的活，混进来会让它误判工作量。
    const allTasks = (await listTasks(taskListId)).filter(
      t => !t.metadata?._internal,
    )

    // Build a set of resolved task IDs for filtering
    // 【英文注释：Build a set of resolved task IDs for filtering】
    // 【中文补充】收集所有已完成任务的 id，存进 Set（≈ HashSet）以便 O(1) 查询。
    const resolvedTaskIds = new Set(
      allTasks.filter(t => t.status === 'completed').map(t => t.id),
    )

    // 逐条压缩成摘要。注意这里**不**带 description（省 token）。
    const tasks = allTasks.map(task => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      owner: task.owner,
      // 关键：把"已经完成的前置任务"从 blockedBy 里剔除。
      // 否则模型会看到 "被 #2 挡住"，但 #2 其实早就做完了 —— 于是它以为自己
      // 还不能开工，白白空转。这行保证了 blockedBy 的语义恒等于"真正的障碍"。
      blockedBy: task.blockedBy.filter(id => !resolvedTaskIds.has(id)),
    }))

    return {
      data: {
        tasks,
      },
    }
  },
  /**
   * 把任务列表渲染成给模型看的纯文本（每行一条）。
   *
   * 格式示例：`#3 [pending] 修复登录鉴权 bug (alice) [blocked by #1]`
   * 括号里的 owner 和 blockedBy 只在**有值时**才追加，空列表不浪费字符。
   *
   * @param content   call() 的返回值。
   * @param toolUseID 对应的 tool_use id，原样回传。
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { tasks } = content as Output
    if (tasks.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No tasks found',
      }
    }

    // map ≈ stream().map()：把每条任务转成一行字符串。
    // owner / blockedBy 用三元表达式做条件拼接，没有就不出现。
    const lines = tasks.map(task => {
      const owner = task.owner ? ` (${task.owner})` : ''
      const blocked =
        task.blockedBy.length > 0
          ? ` [blocked by ${task.blockedBy.map(id => `#${id}`).join(', ')}]`
          : ''
      return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`
    })

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
