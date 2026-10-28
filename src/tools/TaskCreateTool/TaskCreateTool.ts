/**
 * ============================================================================
 *  【文件总览】src/tools/TaskCreateTool/TaskCreateTool.ts
 *              —— 在任务列表里新建一条任务（Task* 工具家族的"写"入口）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 TaskCreate 工具：往任务列表里新增一条任务。
 *  它就是 Claude Code 那个「TODO 列表 / 任务清单」的创建端。
 *
 *  【先搞清楚：任务存在哪？——这是理解整个 Task* 家族的前提】
 *  任务**不在内存里，也不在某个数据库里，而是磁盘上的一个个 JSON 文件**：
 *
 *      ~/.claude/tasks/<taskListId>/<taskId>.json      ← 一条任务 = 一个文件
 *
 *  其中 taskListId 由 getTaskListId() 决定（见 src/utils/tasks.ts）：
 *  优先取环境变量 → 否则取团队名（这样同一团队的所有 agent 共享同一份任务列表）
 *  → 再退化为当前 session id（单人会话独占一份）。
 *  推论：**多个 agent / 多个进程是共享同一批任务文件的**，所以创建时要加文件锁
 *  （createTask 内部用了 lockfile），否则并发创建会撞出重复 id。
 *  ≈ Java 里多个 JVM 进程读写同一个目录，靠 FileLock 协调。
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "TaskCreate"）
 *        └─> 工具编排层
 *              └─> 本文件 TaskCreateTool.call()                  ← ★ 你在这里
 *                    ├─> createTask()     src/utils/tasks.ts      → 分配 id + 写 JSON 文件 + 加文件锁
 *                    ├─> deleteTask()     src/utils/tasks.ts      → 校验失败时回滚（删掉刚建的）
 *                    └─> executeTaskCreatedHooks()  src/utils/hooks.ts → 触发用户的 TaskCreated hook
 *
 *  【本文件包含什么】
 *   1. inputSchema / outputSchema  入参和出参的 zod 校验规则
 *   2. TaskCreateTool              工具本体，核心就是 call() 一个方法
 *
 *  【任务的三个状态怎么流转？】
 *  新建出来的任务**永远是 pending**（见下面 call() 里写死的 status: 'pending'）：
 *
 *      pending ──(TaskUpdate: status='in_progress')──> in_progress
 *               ──(TaskUpdate: status='completed')──> completed
 *
 *  本文件只负责把任务"生出来"（pending），后续状态变更在 TaskUpdateTool 里。
 *  另外新建时 owner 是 undefined（没人认领）、blocks/blockedBy 是空数组，
 *  依赖关系要等后续用 TaskUpdate 建立 —— 因为建任务时后面的任务还不存在。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（Java 工程师视角，只列本文件真正出现的）
 * ---------------------------------------------------------------------------
 *  - `z.strictObject({...})`：和 z.object 的区别是**多余字段会直接报错**。
 *    用在这里是刻意的：模型偶尔会自己发明字段，strict 能立刻挡回去让它改。
 *  - `z.record(z.string(), z.unknown())`：值类型任意的 map。
 *    ≈ Java 的 `Map<String, Object>`。
 *  - `ReturnType<typeof f>`：取函数返回值类型（配合下面的懒加载工厂用）。
 *  - `get inputSchema()` / `get outputSchema()`：getter，访问时才真正构造 schema（懒加载）。
 *    ≈ Java 里把字段换成 `getXxx()` 方法，内部做懒初始化。
 *  - `async call({ subject, description, activeForm, metadata }, context)`：
 *    第一个参数是**解构赋值**——直接把入参对象的字段拆成局部变量。
 *    ≈ Java 21 的记录模式匹配，但 TS 里这是日常写法。
 *  - `for await (const x of gen)`：消费**异步生成器**。
 *    ≈ Java 的 Reactor Flux 订阅，或 Iterator + CompletableFuture 合体。
 *    这里 hook 是逐个产出的（可能有多条），所以要用流的方式收。
 *  - `context?.abortController?.signal`：可选链 `?.` 一路问下去，
 *    ≈ Java 的 `if (c != null && c.getAbortController() != null) ... .getSignal()`，
 *    但一行搞定且不会 NPE。
 *  - `prev => ({ ...prev, expandedView: 'tasks' })`：
 *    `{...prev}` 是展开复制，`=>` 是箭头函数（≈ lambda）。
 *    这是 React 的**不可变更新**惯用法：不改原对象，返回新对象。
 *  - `100_000` 下划线是千位分隔符，等价于 100000（Java 也有）。
 *  - `satisfies ToolDef<...>`（文件最末）：「按 ToolDef 检查我，但别把我的类型拓宽」。
 */
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  executeTaskCreatedHooks,
  getTaskCreatedHookMessage,
} from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  createTask,
  deleteTask,
  getTaskListId,
  isTodoV2Enabled,
} from '../../utils/tasks.js'
import { getAgentName, getTeamName } from '../../utils/teammate.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

// ── 入参 schema ──────────────────────────────────────────────────────
// 注意 .describe() 里的文字是**给模型看的**，所以是英文，不要翻译。
const inputSchema = lazySchema(() =>
  z.strictObject({
    // subject = 一句话标题，用祈使句（"修复登录鉴权 bug"），列表里显示的就是它。
    subject: z.string().describe('A brief title for the task'),
    description: z.string().describe('What needs to be done'),
    // activeForm = 进行时形态（"正在修复登录鉴权 bug"），任务处于 in_progress 时
    // 显示在 spinner（转圈的那个提示符）旁边。不填就退回显示 subject。
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    // metadata = 任意附加信息。类型是不限值的 map，给上层业务/插件自己塞东西用，
    // 本工具不理解也不校验它的内容。
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arbitrary metadata to attach to the task'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// ── 出参 schema ──────────────────────────────────────────────────────
// 只回 id 和 subject 两个字段：够了，而且**省 token**。
// 模型下一步要拿 id 去调 TaskUpdate / TaskGet，subject 用来确认自己创建对了。
const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * TaskCreateTool 本体：用 buildTool() 组装成工具对象（缺省实现由 src/Tool.ts 补齐）。
 *
 * 下面字段里几个值得注意的：
 *   isEnabled()      → 只有 isTodoV2Enabled() 才注册（v1 的 todo 用的是别的实现）
 *   isConcurrencySafe() → true：可以和其他工具并行跑（它只是写个文件，无副作用冲突）
 *   shouldDefer      → true：延迟加载，模型要先 ToolSearch 才能用到它
 */
export const TaskCreateTool = buildTool({
  name: TASK_CREATE_TOOL_NAME,
  // 延迟加载模式下，模型靠这句话在 ToolSearch 里找到本工具。
  searchHint: 'create a task in the task list',
  maxResultSizeChars: 100_000,
  // 给 UI 看的简短描述（文案常量在 prompt.ts）。async 是因为框架允许异步生成。
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  // getter：真正用到时才构造 schema（lazySchema 的目的是省掉不必要的构造开销）。
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  // 出参 schema 也要给模型：Claude 支持"结构化输出"，模型会按这个形状来填。
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 给用户看的名字（终端 UI 上显示用）。
  userFacingName() {
    return 'TaskCreate'
  },
  // 延迟加载：prompt 里只放占位，模型想用必须先 ToolSearch 一轮，省上下文 token。
  shouldDefer: true,
  // 开关没开（todo v2 未启用）就根本不注册这个工具，模型也就看不到它。
  isEnabled() {
    return isTodoV2Enabled()
  },
  // 并发安全 = 允许和别的工具同时执行。创建任务只是追加一个独立文件，
  // 不会和别的工具抢同一份资源，所以标 true 让框架并行调度、省时间。
  isConcurrencySafe() {
    return true
  },
  /**
   * 给 auto 模式安全分类器的一句话摘要。
   * 为什么只回 subject：创建任务的"危险性"全在标题里体现，
   * 给分类器看标题就够了，塞全文只会浪费分类器的上下文。
   */
  toAutoClassifierInput(input) {
    return input.subject
  },
  // 不做特殊渲染（返回 null = 用框架默认样式）。
  renderToolUseMessage() {
    return null
  },
  /**
   * 真正干活：创建一条新任务。
   *
   * 为什么需要：这是任务清单的入口。模型在开始一件复杂工作前先建任务，
   * 好处是 (1) 用户能看见进度；(2) 模型自己也不容易被长任务带偏。
   *
   * @param input   已解构的入参 {subject, description, activeForm, metadata}。
   * @param context 运行时上下文（AppState、abort 信号等）。
   * @returns `{ data: { task: { id, subject } } }` —— 回给模型的最小信息。
   *
   * 关键步骤：
   *   ① createTask() 分配一个不重复的自增 id，写 JSON 文件（内部加文件锁防并发）
   *   ② 跑一遍用户的 TaskCreated hook，收集其中的"阻断性错误"（blockingError）
   *   ③ 如果有 hook 阻断 → **回滚**（删掉刚建的任务）再抛错，保证不留下脏数据
   *   ④ 自动把 UI 的任务面板展开，让用户立刻看到新任务
   */
  async call({ subject, description, activeForm, metadata }, context) {
    // 新建任务的初始状态**写死为 pending**、owner 为空、依赖关系为空 ——
    // 因为刚建的时候还不知道谁来做、要依赖谁，这些只能后面用 TaskUpdate 补。
    // 注意 createTask 内部会加文件锁：多个 agent 共享同一份任务列表时，
    // 并发创建可能撞出重复 id（这就是"共享磁盘状态"必须加锁的原因）。
    const taskId = await createTask(getTaskListId(), {
      subject,
      description,
      activeForm,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata,
    })

    // ── 执行用户配置的 TaskCreated hook ──────────────────────────────
    // hook 是用户用脚本挂的扩展点，可以校验甚至否决这次创建。
    // 它可能返回"阻断性错误"（blockingError），表示"这个任务不该被创建"。
    const blockingErrors: string[] = []
    const generator = executeTaskCreatedHooks(
      taskId,
      subject,
      description,
      getAgentName(),
      getTeamName(),
      undefined,
      context?.abortController?.signal,
      undefined,
      context,
    )
      // `for await` 消费异步生成器（≈ Java 订阅一个 Flux）：
      // hook 可能有多条结果，逐条产出，这里逐条收集其中的阻断错误。
    for await (const result of generator) {
      if (result.blockingError) {
        blockingErrors.push(getTaskCreatedHookMessage(result.blockingError))
      }
    }

    // 有 hook 否决 → 先回滚再抛错。顺序很重要：
    // 先 deleteTask 删掉刚写进去的文件，保证磁盘状态和"没创建过"一致；
    // 再 throw，把错误抛给框架 → 变成 tool_result 里的错误文本回给模型，让它知道为什么失败。
    if (blockingErrors.length > 0) {
      await deleteTask(getTaskListId(), taskId)
      throw new Error(blockingErrors.join('\n'))
    }

    // 【中文补充】自动展开任务面板：新建了任务就该让用户马上看见。
    // 注意这里用的是 `prev => ...` 的函数式更新（≈ React 的 setState(fn)）：
    // 传函数而不是传对象，可以避免拿到过期的快照。
    // Auto-expand task list when creating tasks
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    // 只回 id + subject：模型拿到 id 就能继续调 TaskUpdate / TaskGet，
    // 回太多字段纯属浪费上下文 token。
    return {
      data: {
        task: {
          id: taskId,
          subject,
        },
      },
    }
  },
  /**
   * 把返回值转成 API 要求的 tool_result 块（模型最终看到的东西）。
   *
   * 为什么这里直接拼字符串而不是 JSON：模型读一句话比读 JSON 更省 token 也不容易误解。
   * "Task #3 created successfully: xxx" 已经包含了模型需要的全部信息。
   *
   * @param content     call() 返回的 data。
   * @param toolUseID   模型那次 tool_use 的 id，必须原样回传才能对上号。
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${task.id} created successfully: ${task.subject}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
