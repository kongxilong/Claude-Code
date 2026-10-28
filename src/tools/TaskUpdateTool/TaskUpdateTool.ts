/**
 * ============================================================================
 *  【文件总览】src/tools/TaskUpdateTool/TaskUpdateTool.ts
 *              —— 修改一条任务：改状态、改归属、建依赖、删任务
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 TaskUpdate 工具。它是任务系统里**唯一负责"改"**的工具，
 *  任务的全部状态流转都发生在这里。
 *
 *  【★ 状态机：整个 Task* 家族的核心，务必先记住这张图】
 *
 *      (TaskCreate 新建)
 *            │
 *            ▼
 *        pending ──── status='in_progress' ────> in_progress
 *            ▲                                        │
 *            │                                        │ status='completed'
 *            └────────────────────────────────────────┘
 *                                                     │
 *            status='deleted' ──> 直接从磁盘删除（终态，不可逆）
 *
 *  三个字段的语义：
 *    pending      还没人开始做（新建任务的初始状态）
 *    in_progress  正在做；此时会自动把 owner 设成当前 agent（见下面 ③ ）
 *    completed    做完了；会触发用户的 TaskCompleted hook，hook 可以否决这次完成
 *    deleted      特殊值：**不是状态，而是一个"删除动作"**，直接删掉那个 JSON 文件
 *
 *  【任务存在哪？】
 *  磁盘上的一个个 JSON 文件：~/.claude/tasks/<taskListId>/<taskId>.json
 *  （taskListId 通常是团队名，所以同一团队的多个 agent 共享同一份任务列表；
 *   因此读写都要加文件锁 —— 见 src/utils/tasks.ts）
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "TaskUpdate"）
 *        └─> 本文件 TaskUpdateTool.call()                          ← ★ 你在这里
 *              ├─> getTask()      src/utils/tasks.ts     → 先读出当前值（后面要做 diff）
 *              ├─> updateTask()   src/utils/tasks.ts     → 写回（内部加文件锁）
 *              ├─> deleteTask()   src/utils/tasks.ts     → status='deleted' 时删除文件
 *              ├─> blockTask()    src/utils/tasks.ts     → 建立依赖关系（双向都要写）
 *              ├─> executeTaskCompletedHooks() src/utils/hooks.ts → 完成时的用户扩展点
 *              └─> writeToMailbox() src/utils/teammateMailbox.ts  → 通知新 owner"活派给你了"
 *
 *  【本文件包含什么】
 *   1. inputSchema / outputSchema   入参出参的 zod 规则
 *   2. call()                       主体，分成 6 段（见下方 call 的 JSDoc）
 *   3. mapToolResultToToolResultBlockParam()  把结果渲染成文本，并在末尾追加"下一步提醒"
 *
 *  【两个最容易看漏的设计点】
 *  ① **"只有变化才写"**：每个字段都先和 existingTask 比对，一样就不写。
 *     目的不只是省 IO，更重要的是让返回的 updatedFields **准确反映"这次真的改了什么"**，
 *     模型靠它判断操作是否生效。
 *  ② **依赖是双向的**：addBlocks 和 addBlockedBy 最终都调用 blockTask()，
 *     区别只在参数的**方向**（谁挡谁）。见下面 313 行附近的注释。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（Java 工程师视角，只列本文件真正出现的）
 * ---------------------------------------------------------------------------
 *  - `feature('VERIFICATION_AGENT')`：**编译期**开关（来自 `bun:bundle`）。
 *    打包时替换成 true/false 并把整段 tree-shaking 掉（DCE）。≈ C 的 `#ifdef`。
 *    所以你看到它只能出现在 if 条件位置 —— 那是 DCE 的硬性约束，不是写得丑。
 *  - `X().or(Y())`：zod 的 union 写法，等价于 `X | Y`。
 *    `TaskStatusSchema().or(z.literal('deleted'))` = 三个正常状态 + 一个特殊动作。
 *  - `??` 空值合并：`a ?? b` 只在 a 是 null/undefined 时取 b。
 *    ⚠️ 与 `||` 区别：`0` / `''` / `false` 不会被 `??` 换掉，但会被 `||` 换掉。
 *    本文件 `existingTask.metadata ?? {}` 必须用 `??`：
 *    如果 metadata 是空对象 {}（falsy 判定里 {} 是 truthy，所以两者都行），
 *    但换成数字 0 之类就会出 bug —— 养成用 `??` 的习惯。
 *  - `?.` 可选链：`context?.abortController?.signal` ≈ 一串 null 检查后取属性，不会 NPE。
 *  - `{ ...(existingTask.metadata ?? {}) }` 展开复制：**不可变更新**的惯用法，
 *    先复制一份再改，不碰原对象（≈ Java 里 new 一个 HashMap 拷贝后再 put）。
 *  - `Object.entries(obj)` / `for (const [k, v] of ...)`：
 *    遍历 map 的键值对。≈ Java 的 `for (Map.Entry<K,V> e : map.entrySet())`，
 *    方括号 `[k, v]` 是数组解构。
 *  - `delete merged[key]`：删掉对象上的一个属性（≈ Java 的 map.remove(key)）。
 *  - `statusChange?.to === 'completed'`：`?.` 让"对象本身可能不存在"也安全。
 *  - `for await (const x of generator)`：消费**异步生成器**（≈ Java 订阅 Flux）。
 *    hook 可能产出多条结果，所以要用流的方式逐条收。
 *  - `Record<string, unknown>`：值类型未知的 map。≈ `Map<String, Object>`。
 *  - `Object.keys(o).length > 0`：判断对象有没有任何字段（≈ map.isEmpty() 取反）。
 *  - `updates.status !== undefined ? {...} : undefined` 三元 ≈ Java 三目运算符。
 *  - `/verif/i.test(subject)`：正则 + `i` 标志表示忽略大小写。≈ Java 的
 *    `Pattern.compile("verif", CASE_INSENSITIVE).matcher(s).find()`。
 */
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  executeTaskCompletedHooks,
  getTaskCompletedHookMessage,
} from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  blockTask,
  deleteTask,
  getTask,
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  type TaskStatus,
  TaskStatusSchema,
  updateTask,
} from '../../utils/tasks.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { VERIFICATION_AGENT_TYPE } from '../AgentTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

// ── 入参 schema ──────────────────────────────────────────────────────
// 字段全部 optional：这是一个"打补丁"式（PATCH 语义）的更新接口，
// 传哪个字段就改哪个字段，不传就不动。≈ HTTP PATCH 而不是 PUT。
const inputSchema = lazySchema(() => {
  // Extended status schema that includes 'deleted' as a special action
  // 【中文补充】status 的取值 = 三个正常状态（pending/in_progress/completed）
  // **外加**一个特殊值 'deleted'。'deleted' 不是状态，而是一个"删除动作"：
  // 它不会把任务改成某个状态，而是直接把那个 JSON 文件删掉（不可逆）。
  const TaskUpdateStatusSchema = TaskStatusSchema().or(z.literal('deleted'))

  // strictObject：模型多塞字段会被拒绝。
  // 这里尤其重要 —— 本工具字段名多（addBlocks / addBlockedBy 很像），
  // 模型容易拼错，strict 能立刻报错让它改，而不是静默忽略。
  return z.strictObject({
    taskId: z.string().describe('The ID of the task to update'),
    subject: z.string().optional().describe('New subject for the task'),
    description: z.string().optional().describe('New description for the task'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    // 状态字段。不传 = 不改状态。
    status: TaskUpdateStatusSchema.optional().describe(
      'New status for the task',
    ),
    // addBlocks：声明"本任务挡住了哪些任务"（本任务完成后，它们才能开始）。
    addBlocks: z
      .array(z.string())
      .optional()
      .describe('Task IDs that this task blocks'),
    // addBlockedBy：声明"哪些任务挡住了本任务"（它们完成后，本任务才能开始）。
    addBlockedBy: z
      .array(z.string())
      .optional()
      .describe('Task IDs that block this task'),
    // owner：把任务指派给某个 agent（多 agent 协作时的"认领"动作）。
    owner: z.string().optional().describe('New owner for the task'),
    // metadata：**合并**语义（不是覆盖）。把传进来的 key 合并进已有 metadata，
    // 把某个 key 设为 null 表示删除它。这样不用为了改一个 key 而传整个对象。
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Metadata keys to merge into the task. Set a key to null to delete it.',
      ),
  })
})
type InputSchema = ReturnType<typeof inputSchema>

// ── 出参 schema ──────────────────────────────────────────────────────
// 出参刻意做得"信息密集"：模型要从中判断 (1) 成功没 (2) 改了哪些字段
// (3) 状态从哪变到哪 (4) 要不要补一个验证步骤。
const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    taskId: z.string(),
    updatedFields: z.array(z.string()),
    error: z.string().optional(),
    // statusChange 记录"从哪个状态变到哪个状态"，让模型（和 UI）能确认流转符合预期。
    statusChange: z
      .object({
        from: z.string(),
        to: z.string(),
      })
      .optional(),
    // verificationNudgeNeeded：给模型的一个"提醒位"。
    // 当它认为你该跑一遍验证 agent 时置 true，下面 mapToolResult 会据此追加一段话。
    verificationNudgeNeeded: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * TaskUpdateTool 本体。
 *
 * 注意：**没有** isReadOnly() —— 默认按"会写"处理（src/Tool.ts 的 fail-closed 原则：
 * 不确定的就当它有副作用）。本工具确实会改磁盘状态，所以是对的。
 */
export const TaskUpdateTool = buildTool({
  name: TASK_UPDATE_TOOL_NAME,
  searchHint: 'update a task',
  maxResultSizeChars: 100_000,
  // 给 UI 看的简短描述（文案常量在 prompt.ts）。
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
    return 'TaskUpdate'
  },
  // 延迟加载：模型要先 ToolSearch 才能用到，省上下文 token。
  shouldDefer: true,
  // todo v2 开关没开就不注册。
  isEnabled() {
    return isTodoV2Enabled()
  },
  // 可并行：它改的是自己的任务文件，不和其它工具抢资源。
  isConcurrencySafe() {
    return true
  },
  /**
   * 给安全分类器的一句话摘要。
   * 为什么要把 taskId + status + subject 拼起来：本工具**最有风险的动作用法是
   * "把任务标成 completed"**（等于宣称活干完了），所以必须让分类器看到状态变化。
   */
  toAutoClassifierInput(input) {
    const parts = [input.taskId]
    if (input.status) parts.push(input.status)
    if (input.subject) parts.push(input.subject)
    return parts.join(' ')
  },
  // 用框架默认渲染。
  renderToolUseMessage() {
    return null
  },
  /**
   * 主体：更新一条任务。
   *
   * 为什么需要：任务系统的全部状态流转都靠它 —— 开始做（in_progress）、
   * 做完（completed）、派活（owner）、建依赖（addBlocks/addBlockedBy）、删除（deleted）。
   *
   * @param input   已解构的入参（全部可选，传什么改什么）。
   * @param context 运行时上下文（AppState、abort 信号、agentId 等）。
   * @returns `{ data: { success, taskId, updatedFields, statusChange, ... } }`。
   *
   * 关键步骤（call() 长达 240 行，按这 6 段读就不乱了）：
   *   ① 【前置】自动展开任务面板 UI；读出任务当前值（后面所有修改都要和它比对）
   *   ② 【普通字段】subject/description/activeForm/owner/metadata 逐个 diff 后写入 updates
   *   ③ 【状态】deleted → 删文件并提前返回；completed → 先跑 hook（可被否决）
   *   ④ 【落盘】只有 updates 非空才真的写（updateTask）
   *   ⑤ 【通知 + 依赖】owner 变了就给新 owner 发信箱消息；addBlocks/addBlockedBy 建立双向依赖
   *   ⑥ 【提醒】判断要不要提示模型"你该跑一遍验证 agent"
   */
  async call(
    {
      taskId,
      subject,
      description,
      activeForm,
      status,
      owner,
      addBlocks,
      addBlockedBy,
      metadata,
    },
    context,
  ) {
    // 定位"当前这份任务列表"。团队场景下它是团队名 —— 也就是说
    // 同一团队的多个 agent 操作的是**同一批文件**，这也是各处要加文件锁的原因。
    const taskListId = getTaskListId()

    // 【中文补充】自动展开任务面板，让用户立刻看到变化。
    // 用 `prev => ...` 函数式更新（≈ React 的 setState(fn)）：
    // 传函数而不是传对象，可以避免拿到过期的状态快照（并发更新时尤其重要）。
    // Auto-expand task list when updating tasks
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    // 【中文补充】必须先读出当前值：后面每个字段都要和它比对（只写真正变化的部分），
    // 同时 completed 时还要拿它的 subject/description 去跑 hook。
    // Check if task exists
    const existingTask = await getTask(taskListId, taskId)
    // 任务不存在 → 返回 success:false，**不抛异常**。
    // 理由：这是正常的业务结果（任务可能已被清理），抛错会让模型误以为工具坏了。
    if (!existingTask) {
      return {
        data: {
          success: false,
          taskId,
          updatedFields: [],
          error: 'Task not found',
        },
      }
    }

    // updatedFields 记录"这次真正改了哪些字段"，会原样回给模型，
    // 让它能确认操作生效。所以下面每处赋值都要 push 一次，别漏。
    const updatedFields: string[] = []

    // 先攒 updates（一个"待写补丁"），最后统一写盘。
    // 好处：只有一处 IO、只有一次加锁（updateTask），也方便中途判断"到底有没有变化"。
    // Update basic fields if provided and different from current value
    const updates: {
      subject?: string
      description?: string
      activeForm?: string
      status?: TaskStatus
      owner?: string
      metadata?: Record<string, unknown>
    } = {}
    // 「传了」且「和现在不一样」才写 —— 两个条件缺一不可：
    // `!== undefined` 区分"没传"和"传了空串"；`!== 现有值` 避免无意义的写入。
    if (subject !== undefined && subject !== existingTask.subject) {
      updates.subject = subject
      updatedFields.push('subject')
    }
    if (description !== undefined && description !== existingTask.description) {
      updates.description = description
      updatedFields.push('description')
    }
    if (activeForm !== undefined && activeForm !== existingTask.activeForm) {
      updates.activeForm = activeForm
      updatedFields.push('activeForm')
    }
    // owner 变更：多 agent 场景下这就是"把活派给谁 / 认领这个活"。
    if (owner !== undefined && owner !== existingTask.owner) {
      updates.owner = owner
      updatedFields.push('owner')
    }
    // 【中文补充】自动认领：一个 teammate 把任务标成 in_progress 却没写 owner 时，
    // 自动把 owner 填成他自己。
    // Auto-set owner when a teammate marks a task as in_progress without
    // explicitly providing an owner. This ensures the task list can match
    // todo items to teammates for showing activity status.
      // 为什么要自动补 owner：UI 上要显示"谁在做什么"（任务旁边的活动状态），
      // 如果没人认领就显示不出来。模型经常忘记填 owner，所以这里兜底。
      // 条件是"原本没有 owner" —— 已经有人认领的任务不会被抢走。
    if (
      isAgentSwarmsEnabled() &&
      status === 'in_progress' &&
      owner === undefined &&
      !existingTask.owner
    ) {
      const agentName = getAgentName()
      if (agentName) {
        updates.owner = agentName
        updatedFields.push('owner')
      }
    }
    // metadata 是**合并**语义：先复制现有的，再逐 key 覆盖/删除。
    if (metadata !== undefined) {
      // `{ ...(x ?? {}) }` 两步都在防 null：
      //   `?? {}`  现有 metadata 为 null 时用空对象兜底
      //   `{...}`  复制一份再改，不修改原对象（不可变更新，避免副作用外泄）
      const merged = { ...(existingTask.metadata ?? {}) }
      for (const [key, value] of Object.entries(metadata)) {
        // 约定：value === null 表示"删掉这个 key"。
        // 为什么不直接删字段？因为 JSON 里没法表达"这个 key 不存在"，
        // 用一个显式的值（null）当删除指令是最简单的协议。
        if (value === null) {
          delete merged[key]
        } else {
          merged[key] = value
        }
      }
      updates.metadata = merged
      updatedFields.push('metadata')
    }
    // ── 状态变更（本工具最复杂的一段）────────────────────────────────
    if (status !== undefined) {
      // Handle deletion - delete the task file and return early
      // 'deleted' 不是状态而是动作：直接删文件并**提前返回**，
      // 后面的落盘、通知、依赖建立都不再执行（任务都没了）。
      if (status === 'deleted') {
        // deleteTask 返回 boolean（删成功 / 文件本来就不存在）。
        // 这里把"删失败"也当成一种结果返回，而不是抛异常 —— 同上面"任务不存在"的处理一致。
        const deleted = await deleteTask(taskListId, taskId)
        return {
          data: {
            success: deleted,
            taskId,
            updatedFields: deleted ? ['deleted'] : [],
            error: deleted ? undefined : 'Failed to delete task',
            statusChange: deleted
              ? { from: existingTask.status, to: 'deleted' }
              : undefined,
          },
        }
      }

      // For regular status updates, validate and apply if different
      // 状态没变就不写（幂等）。避免"重复标 completed"触发两次 hook。
      if (status !== existingTask.status) {
        // Run TaskCompleted hooks when marking a task as completed
        // 标记完成前先跑用户的 TaskCompleted hook，hook 可以**否决**这次完成
        // （比如"测试还没跑，不许标完成"）。这是 quality gate 的扩展点。
        if (status === 'completed') {
          const blockingErrors: string[] = []

          // hook 是异步生成器：可能有多个 hook、每个产出一条结果，
          // 所以要流式收集（≈ Java 订阅 Flux 后 collectList）。
          const generator = executeTaskCompletedHooks(
            taskId,
            existingTask.subject,
            existingTask.description,
            getAgentName(),
            getTeamName(),
            undefined,
            context?.abortController?.signal,
            undefined,
            context,
          )

          // `for await` ≈ 逐个 await 流里的元素。这里只挑出 blockingError（阻断性错误）。
          for await (const result of generator) {
            if (result.blockingError) {
              blockingErrors.push(
                getTaskCompletedHookMessage(result.blockingError),
              )
            }
          }

          // hook 否决 → 直接返回失败，**不**修改状态。
          // 也就是"任务保持 in_progress"，模型得先解决 hook 指出的问题再回来标完成。
          if (blockingErrors.length > 0) {
            return {
              data: {
                success: false,
                taskId,
                updatedFields: [],
                error: blockingErrors.join('\n'),
              },
            }
          }
        }

        // 走到这里说明：状态确实变了、且（如果涉及 completed）hook 已经放行。
        updates.status = status
        updatedFields.push('status')
      }
    }

    // 只有真的有变化才落盘。空补丁直接跳过，省一次文件锁和一次写 IO。
    if (Object.keys(updates).length > 0) {
      await updateTask(taskListId, taskId, updates)
    }

    // 【中文补充】owner 变了 → 给新 owner 发一条信箱消息通知他。
    // 为什么要通知：被指派的人（另一个 agent）不会主动去看任务列表，
    // 没有通知的话他会一直闲着，而派活的人以为他已经开工了。
    // Notify new owner via mailbox when ownership changes
    if (updates.owner && isAgentSwarmsEnabled()) {
      const senderName = getAgentName() || 'team-lead'
      const senderColor = getTeammateColor()
      // 信箱里存的永远是**字符串**，所以结构化内容要先 JSON 编码。
      // 收件方读到后自己解析（type='task_assignment' 是约定的消息类型）。
      const assignmentMessage = JSON.stringify({
        type: 'task_assignment',
        taskId,
        subject: existingTask.subject,
        description: existingTask.description,
        assignedBy: senderName,
        timestamp: new Date().toISOString(),
      })
      // 注意第三个参数用的是 taskListId 而不是 teamName：
      // 任务列表的归属和信箱的归属用的是同一个 id，保证两边对得上。
      await writeToMailbox(
        updates.owner,
        {
          from: senderName,
          text: assignmentMessage,
          timestamp: new Date().toISOString(),
          color: senderColor,
        },
        taskListId,
      )
    }

    // ── 建立依赖（两个方向）──────────────────────────────────────────
    // addBlocks：本任务挡住别人  → blockTask(本任务, 被挡的那个)
    // Add blocks if provided and not already present
    if (addBlocks && addBlocks.length > 0) {
      // 先过滤掉已经存在的依赖（幂等），避免重复写、也避免 updatedFields 虚报。
      const newBlocks = addBlocks.filter(
        id => !existingTask.blocks.includes(id),
      )
      for (const blockId of newBlocks) {
        await blockTask(taskListId, taskId, blockId)
      }
      if (newBlocks.length > 0) {
        updatedFields.push('blocks')
      }
    }

    // 【中文补充】addBlockedBy：别人挡住本任务 → blockTask(那个挡路的, 本任务)
    // 注意**参数顺序反过来了**：两个字段最终都调 blockTask(A, B) 表示"A 挡住 B"，
    // 区别只在方向。这是最容易看错的一处。
    // Add blockedBy if provided and not already present (reverse: the blocker blocks this task)
    if (addBlockedBy && addBlockedBy.length > 0) {
      const newBlockedBy = addBlockedBy.filter(
        id => !existingTask.blockedBy.includes(id),
      )
        // 方向反转：addBlockedBy=['1'] 表示"任务 1 挡住本任务"，
        // 所以调用 blockTask(blockerId='1', taskId=本任务)。
      for (const blockerId of newBlockedBy) {
        await blockTask(taskListId, blockerId, taskId)
      }
      if (newBlockedBy.length > 0) {
        updatedFields.push('blockedBy')
      }
    }

    // 【中文补充】"验证提醒"：主线程 agent 一口气做完 3 个以上任务、
    // 且其中没有任何一个验证类任务时，提醒它去跑一遍验证 agent。
    // Structural verification nudge: if the main-thread agent just closed
    // out a 3+ task list and none of those tasks was a verification step,
    // append a reminder to the tool result. Fires at the loop-exit moment
    // where skips happen ("when the last task closed, the loop exited").
    // Mirrors the TodoWriteTool nudge for V1 sessions; this covers V2
    // (interactive CLI). TaskUpdateToolOutput is @internal so this field
    // does not touch the public SDK surface.
    // 这个标志会通过出参回给框架，下面 mapToolResult 里据此追加一段提示文本。
    // 之所以放在工具结果里而不是系统提示里：它只在"刚好收尾"这个时刻才有意义。
    let verificationNudgeNeeded = false
      // 三重条件（注意 feature() 是编译期开关，另外两个是运行时判断）：
      //   feature('VERIFICATION_AGENT')                    编译期：这个功能有没有编进产物
      //   getFeatureValue_CACHED_MAY_BE_STALE(...)         运行时：灰度开关（可能读到陈旧缓存值）
      //   !context.agentId                                 只在主线程（不是某个子 agent）才提醒
      //   updates.status === 'completed'                   只在"刚收尾一个任务"这个时刻触发
    if (
      feature('VERIFICATION_AGENT') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
      !context.agentId &&
      updates.status === 'completed'
    ) {
      // 判断"是不是整个清单都做完了"——只有都做完了才谈得上"收尾前该验证一下"。
      const allTasks = await listTasks(taskListId)
      const allDone = allTasks.every(t => t.status === 'completed')
      // 三个条件：全部完成、任务数 ≥3（说明确实是一批活，不是随手一个）、
      // 且**没有任何一个**任务的标题里带 verif（不区分大小写）—— 说明确实漏了验证。
      if (
        allDone &&
        allTasks.length >= 3 &&
        !allTasks.some(t => /verif/i.test(t.subject))
      ) {
        verificationNudgeNeeded = true
      }
    }

    // 统一出口：把这次改了什么、状态怎么变的告诉模型。
    return {
      data: {
        success: true,
        taskId,
        updatedFields,
        statusChange:
          updates.status !== undefined
            ? { from: existingTask.status, to: updates.status }
            : undefined,
        verificationNudgeNeeded,
      },
    }
  },
  /**
   * 把结果渲染成给模型看的文本，并**追加"下一步该干什么"的提醒**。
   *
   * 为什么提醒要写在这里而不写在系统提示里：
   * 这类提醒只在特定时刻（刚完成一个任务 / 刚收尾一批任务）才有意义，
   * 塞进系统提示会全程占用上下文且大部分时间是噪声。
   *
   * @param content   call() 的返回值。
   * @param toolUseID 对应的 tool_use id，必须原样回传。
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    // 解构出参：把 content 对象里的字段直接拆成局部变量。
    // `content as Output` 是类型断言（≈ Java 强转），因为框架传进来的是宽类型。
    const {
      success,
      taskId,
      updatedFields,
      error,
      statusChange,
      verificationNudgeNeeded,
    } = content as Output
    // 【中文补充】失败时**故意不标记成 is_error**。
    if (!success) {
      // 【中文补充】为什么失败也不标 is_error：StreamingToolExecutor 见到 error
      // 会把同批次的其它工具调用一起取消掉。而"任务不存在"是良性情况
      // （比如任务列表刚被清理完），模型自己能处理，不该连坐取消别的工具。
      // Return as non-error so it doesn't trigger sibling tool cancellation
      // in StreamingToolExecutor. "Task not found" is a benign condition
      // (e.g., task list already cleaned up) that the model can handle.
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: error || `Task #${taskId} not found`,
      }
    }

    // 基础结果文本："Updated task #3 status, owner"。
    let resultContent = `Updated task #${taskId} ${updatedFields.join(', ')}`

    // Add reminder for teammates when they complete a task (supports in-process teammates)
    // 给 teammate 的下一步提醒：做完一个任务后立刻去看下一个。
    // 三个条件同时成立才追加：刚变成 completed + 自己确实是个 agent + 开了 swarm。
    if (
      statusChange?.to === 'completed' &&
      getAgentId() &&
      isAgentSwarmsEnabled()
    ) {
      resultContent +=
        '\n\nTask completed. Call TaskList now to find your next available task or see if your work unblocked others.'
    }

    // 验证提醒：收尾了一批任务却没做验证 → 提示去派生验证 agent。
    // 措辞很硬（"你不能自己给自己判 PARTIAL"）是刻意的：
    // 模型很容易在总结里写一堆 caveat 就当验证过了，这里明确堵死这条路。
    if (verificationNudgeNeeded) {
      resultContent += `\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, spawn the verification agent (subagent_type="${VERIFICATION_AGENT_TYPE}"). You cannot self-assign PARTIAL by listing caveats in your summary — only the verifier issues a verdict.`
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: resultContent,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
