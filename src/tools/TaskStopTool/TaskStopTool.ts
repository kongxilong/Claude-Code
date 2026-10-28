/**
 * ============================================================================
 *  【文件总览】src/tools/TaskStopTool/TaskStopTool.ts
 *              —— 按 id 停掉一个正在跑的后台任务（旧名 KillShell）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 TaskStop 工具：给定任务 id，把那个**正在运行的后台任务**杀掉。
 *
 *  【★ 重点区分：这里的"任务"和 TaskCreate/TaskList 的"任务"不是一回事！】
 *  这是本仓库里最容易混淆的一组概念，务必分清楚：
 *
 *    ┌────────────────┬──────────────────────────┬────────────────────────────┐
 *    │                │ TaskCreate/List/Get/Update │ TaskStop / TaskOutput      │
 *    ├────────────────┼──────────────────────────┼────────────────────────────┤
 *    │ 是什么         │ 待办清单（TODO item）     │ 真正在后台跑的进程/子 agent │
 *    │ 存在哪         │ 磁盘 JSON 文件            │ AppState.tasks（内存）      │
 *    │ 谁能看见       │ 团队内共享（跨进程）      │ 只有当前进程               │
 *    │ 状态           │ pending/in_progress/...   │ running/completed/failed   │
 *    │ 干什么用的     │ 规划与跟踪进度            │ 起后台任务 + 取回输出      │
 *    └────────────────┴──────────────────────────┴────────────────────────────┘
 *
 *  简单记：TaskCreate 那套是「记事本」，TaskStop/TaskOutput 这套是「进程管理器」。
 *  本文件杀的是后者 —— 比如一个跑太久的 Bash 后台命令、或者一个跑偏了的子 agent。
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "TaskStop"，或旧名 "KillShell"）
 *        └─> 本文件 TaskStopTool.call()                     ← ★ 你在这里
 *              └─> stopTask()   src/tasks/stopTask.ts       → 触发该任务的 abortController，
 *                                                              并把它标记为已停止
 *
 *  【本文件包含什么】
 *   1. inputSchema / outputSchema   入参出参的 zod 规则
 *   2. validateInput()              执行**前**先校验：id 存在吗？任务真的在跑吗？
 *   3. call()                       调用 stopTask() 真正停掉它
 *   4. 渲染函数来自 ./UI.js（不在本文件）
 *
 *  【为什么"校验"要单独放在 validateInput 里而不是 call 里？】
 *  因为 validateInput 返回的是**结构化错误**，框架会把 message 原样喂回给模型，
 *  模型就能自己纠正（比如换一个 id）。而 call() 里抛异常会被当成"工具坏了"。
 *  对"用户给错了 id"这类可恢复问题，前者体验好得多。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（Java 工程师视角，只列本文件真正出现的）
 * ---------------------------------------------------------------------------
 *  - `task_id ?? shell_id ?? ''`：`??` 空值合并，**可以链式串联**。
 *    ≈ "task_id 有就用它，没有就看 shell_id，还没有就用空串"。
 *    ⚠️ 用 `??` 而不是 `||`：这样空字符串 '' 也能被当成"有值"传下去
 *    （用 `||` 的话空串会被跳过，行为就变了）。
 *  - 参数解构：`async validateInput({ task_id, shell_id }, { getAppState })`
 *    两层解构：第一个参数是入参对象，第二个是上下文对象，都直接拆字段。
 *    ≈ Java 21 的记录模式匹配，但 TS 里是日常写法。
 *  - `appState.tasks?.[id]`：`?.` 是可选链，**`?.[id]` 是可选链的下标形式** ——
 *    意思是"tasks 可能为 null，那就整体得到 undefined，别报错"。
 *    ≈ Java 的 `tasks == null ? null : tasks.get(id)`。
 *  - `as TaskStateBase | undefined`：`as` 是类型断言 ≈ Java 强转，运行时不校验。
 *    `A | undefined` 联合类型 ≈ Java 的 Optional<A>（写法上更轻）。
 *  - `userFacingName: () => (cond ? '' : 'Stop Task')`：
 *    这里字段值是一个**箭头函数**（≈ lambda），而不是普通函数写法。
 *    返回 '' 表示"这个工具不显示名字"（内部定制用法）。
 *  - `aliases: ['KillShell']`：别名。旧名字要继续能用，否则历史 transcript
 *    和老版本 SDK 用户会直接坏掉 —— 这是向后兼容的常规做法。
 *  - `process.env.USER_TYPE === 'ant'`：读环境变量判断是不是内部用户，
 *    用来对内部/外部展示不同文案（≈ Java 的 System.getenv）。
 *  - `errorCode: 1 / 3`：给框架的错误分类码，不同的码可能对应不同的重试策略。
 */
import { z } from 'zod/v4'
import type { TaskStateBase } from '../../Task.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { stopTask } from '../../tasks/stopTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DESCRIPTION, TASK_STOP_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

// ── 入参：任务 id（新旧两种字段名都要支持，见下面 shell_id 的注释）──────
const inputSchema = lazySchema(() =>
  z.strictObject({
    // 注意字段名是**下划线风格** task_id / shell_id，不是驼峰。
    // 原因：这是暴露给模型的 JSON schema 字段名，历史上定下来就不能改了
    // （改了所有历史 transcript 都会失效）。TS 代码风格是驼峰，但对外接口可以不一样。
    task_id: z
      .string()
      .optional()
      .describe('The ID of the background task to stop'),
    // 【中文补充】shell_id 是为了兼容已废弃的 KillShell 工具而保留的旧字段名。
    // 【中文补充】为什么不直接删掉：历史 transcript 里还写着 shell_id，
    // 用 --resume 回放时如果字段没了会校验失败。旧字段只能"留着不用"，不能删。
    // shell_id is accepted for backward compatibility with the deprecated KillShell tool
    shell_id: z.string().optional().describe('Deprecated: use task_id instead'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// ── 出参 schema ──────────────────────────────────────────────────────
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Status message about the operation'),
    task_id: z.string().describe('The ID of the task that was stopped'),
    task_type: z.string().describe('The type of the task that was stopped'),
    // Optional: tool outputs are persisted to transcripts and replayed on --resume
    // without re-validation, so sessions from before this field was added lack it.
    // 【中文补充】command 是可选字段。
    // 【中文补充】为什么：工具结果会被持久化到 transcript，用 --resume 回放时
    // 是**不重新校验**的；这个字段是新加的，老会话里根本没有它。
    command: z
      .string()
      .optional()
      .describe('The command or description of the stopped task'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * TaskStopTool 本体。
 *
 * 三个值得注意的配置：
 *   aliases: ['KillShell']  旧名保留为别名，保证历史 transcript 能继续回放
 *   shouldDefer: true       延迟加载，模型要先 ToolSearch 才能用到
 *   isConcurrencySafe()     可以并行（杀一个任务不影响别的任务）
 */
export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  // 给 ToolSearch 用的一句话（"杀掉一个正在跑的后台任务"）。
  searchHint: 'kill a running background task',
  // 【中文补充】KillShell 是废弃的旧名字，保留成别名是为了向后兼容。
  // KillShell is the deprecated name - kept as alias for backward compatibility
  // with existing transcripts and SDK users
  // 别名列表：模型写 "KillShell" 也能命中本工具。
  aliases: ['KillShell'],
  // 结果超过 10 万字符就落盘（防止一次大输出撑爆上下文）。
  maxResultSizeChars: 100_000,
  // 对内部用户（USER_TYPE=ant）隐藏工具名（返回空串），对外显示 'Stop Task'。
  // 用箭头函数（≈ lambda）而不是方法写法，是为了少写一层 function。
  userFacingName: () => (process.env.USER_TYPE === 'ant' ? '' : 'Stop Task'),
  // 懒加载 schema。
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 延迟加载，省上下文。
  shouldDefer: true,
  // 可并行：杀 A 任务不会影响 B 任务。
  isConcurrencySafe() {
    return true
  },
  /**
   * 给安全分类器的一句话摘要。
   * 为什么回 id（而不是一句描述）：杀任务的危险程度取决于杀的是**哪个**任务，
   * 把 id 交给分类器，让它自己去查那个任务是什么。
   */
  toAutoClassifierInput(input) {
    // 两个 id 字段二选一，都没有就回空串（表示"这个工具对安全判断没意义"）。
    return input.task_id ?? input.shell_id ?? ''
  },
  /**
   * 执行**前**的校验：确认这个 id 能停、值得停。
   *
   * 为什么要在 call 之前单独校验：validateInput 返回的结构化错误会被框架
   * 原样喂回给模型，模型能据此**自己纠正**（换个 id、或者先去查一下）。
   * 这比在 call 里抛异常友好得多。
   *
   * @param input             已解构的入参 { task_id, shell_id }。
   * @param contextPartiallyUsed 上下文；这里只用到 getAppState（同样解构取出）。
   * @returns `{result: false, message, errorCode}` 表示拒绝执行；
   *          `{result: true}` 表示放行。
   *
   * 关键步骤：
   *   ① 两个 id 字段都没有 → 拒绝（errorCode 1）
   *   ② 在 AppState.tasks 里找不到这个 id → 拒绝（errorCode 1）
   *   ③ 找到了但**不是 running 状态** → 拒绝（errorCode 3）
   *      —— 停一个已经结束的任务没有意义，多半是模型记错了 id
   */
  async validateInput({ task_id, shell_id }, { getAppState }) {
    // 【中文补充】同时支持 task_id 和 shell_id（后者是废弃字段，仅为兼容保留）。
    // Support both task_id and shell_id (deprecated KillShell compat)
    // `??` 链：优先用新字段 task_id，没有就退回旧字段 shell_id。
    const id = task_id ?? shell_id
    // 两个都没有 → 报错让模型补上。errorCode 1 表示"参数缺失类"错误。
    if (!id) {
      return {
        result: false,
        message: 'Missing required parameter: task_id',
        errorCode: 1,
      }
    }

    // 后台任务都在 AppState.tasks 这个 map 里（**内存**，不是磁盘文件）。
    // 这也是它和 TaskCreate 那套"任务"的本质区别：进程没了，任务也就没了。
    const appState = getAppState()
    const task = appState.tasks?.[id] as TaskStateBase | undefined

    // 找不到 → 大概率是模型记错了 id，或者任务早就结束并被清理了。
    if (!task) {
      return {
        result: false,
        message: `No task found with ID: ${id}`,
        errorCode: 1,
      }
    }

    // 任务存在但没在跑（已经 completed / failed / stopped）→ 拒绝。
    // 用不同的 errorCode(3)：这是"状态不对"，和上面"参数缺失"(1) 是两类问题。
    if (task.status !== 'running') {
      return {
        result: false,
        message: `Task ${id} is not running (status: ${task.status})`,
        errorCode: 3,
      }
    }

    // 三项检查都过了 → 放行。
    return { result: true }
  },
  // 给 UI 看的描述。返回的是模板字符串（这里没有插值，等价于普通字符串）。
  async description() {
    return `Stop a running background task by ID`
  },
  // 给模型看的说明（常量在 prompt.ts）。
  async prompt() {
    return DESCRIPTION
  },
  /**
   * 把返回值转成 API 要求的 tool_result 块。
   * 这里直接把整个 output 对象 JSON 序列化成文本 —— 因为出参字段较多，
   * 让模型读结构化 JSON 比拼一句自然语言更不容易丢信息。
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  /**
   * 真正停掉一个后台任务。
   *
   * 为什么需要：后台任务（长时间跑的 Bash 命令、子 agent）可能跑偏或者跑太久，
   * 用户/模型需要一个"终止它的手段"，否则只能干等或杀掉整个 Claude Code。
   *
   * @param input   已解构的入参 { task_id, shell_id }。
   * @param context 上下文；这里取 getAppState / setAppState 交给 stopTask 用。
   * @returns `{ data: { message, task_id, task_type, command } }`。
   *
   * 关键步骤：
   *   ① 两个 id 字段二选一（兼容旧名）；都没有就抛错
   *      —— 注意：正常流程下 validateInput 已经挡过一次了，这里是**双保险**
   *   ② stopTask() 触发该任务的 abortController，并把它标记为已停止
   *   ③ 把结果包装成出参返回（message 里带上被停的命令，方便用户确认停对了）
   */
  async call(
    { task_id, shell_id },
    { getAppState, setAppState, abortController },
  ) {
    // 【中文补充】同样要兼容 task_id 和 shell_id 两个字段名。
    // Support both task_id and shell_id (deprecated KillShell compat)
    // 这一句和 validateInput 里是重复的 —— 属于"防御性冗余"。
    // 为什么明知校验过了还要再查：call() 是公开入口，可能有别的调用路径
    // 不经过 validateInput；而 id 为 undefined 时后面会得到很难懂的报错。
    const id = task_id ?? shell_id
    // 这里用 throw 而不是返回结构化错误：能走到这一步说明**校验被绕过了**，
    // 属于程序 bug 而不是用户输入问题，抛异常才合适（让它在开发期就暴露）。
    if (!id) {
      throw new Error('Missing required parameter: task_id')
    }

    // stopTask 内部会：找到任务 → 调用它的 abortController.abort()
    // → 把状态改成 stopped → 通过 setAppState 更新内存状态。
    // ≈ Java 里对 Future 调 cancel(true)：请求中断，具体怎么响应看任务自己。
    const result = await stopTask(id, {
      getAppState,
      setAppState,
    })

    // 回给模型的信息里带上被停掉的 command：
    // 让它（和用户）能一眼确认"停的是不是我想停的那个"。
    return {
      data: {
        message: `Successfully stopped task: ${result.taskId} (${result.command})`,
        task_id: result.taskId,
        task_type: result.taskType,
        command: result.command,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
