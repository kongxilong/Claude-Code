/**
 * ============================================================================
 *  【文件总览】src/tools/TaskCreateTool/prompt.ts
 *              —— TaskCreate 工具「什么时候该用」的说明（喂给模型看）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件拼出 TaskCreate 的使用说明。没有业务逻辑，只有提示词文本。
 *
 *  【为什么这个文件有一半篇幅在讲"什么时候不该用"？】
 *  因为模型特别容易**过度使用**任务工具 —— 一件小事也要建个任务，
 *  结果任务列表被一堆无意义的条目塞满，反而掩盖了真正的进度。
 *  所以 prompt 里明确列了"只有一件事就别建""三步以内就别建"这类反例。
 *  这是踩过坑之后补上的约束，读代码时别以为是凑字数。
 *
 *  【在架构中的位置】
 *      TaskCreateTool.description() / .prompt()  ← 取用本文件的 DESCRIPTION / getPrompt()
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - 模板字符串 `` `...${x}...` `` ≈ Java 的文本块（"""），可换行、可插值。
 *  - `isAgentSwarmsEnabled() ? A : ''`：**运行时**判断（不是编译期的 feature()）。
 *    开启了多 agent 协作才追加"可以分配给队友"那段说明。
 *  - `${teammateTips}` 这种把整段拼进去的写法，是为了让"可选内容"不留空行。
 */
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

// 一句话描述（给 UI 的工具列表 / 权限弹框用）。
export const DESCRIPTION = 'Create a new task in the task list'

/**
 * 生成 TaskCreate 的完整使用说明。
 *
 * @returns Markdown 文本。核心内容两块：
 *          ① 什么时候该用 / 不该用（防模型滥用）
 *          ② 每个字段怎么填（subject 用祈使句、activeForm 是进行时）
 *
 * 关键步骤：
 *   ① 按 isAgentSwarmsEnabled()（运行时开关）决定要不要提"可以分配给队友"
 *   ② 拼进主模板返回
 */
export function getPrompt(): string {
  // 运行时开关：开了 swarm 才告诉模型"任务还可以派给队友"。
  // 关着的时候说这个只会让模型去找不存在的队友。
  const teammateContext = isAgentSwarmsEnabled()
    ? ' and potentially assigned to teammates'
    : ''

  // 多 agent 场景下的额外提醒：描述要写得让**别的 agent** 也能看懂（不能假设共享上下文），
  // 以及新任务是 pending + 无 owner，要用 TaskUpdate 指派。
  const teammateTips = isAgentSwarmsEnabled()
    ? `- Include enough detail in the description for another agent to understand and complete the task
- New tasks are created with status 'pending' and no owner - use TaskUpdate with the \`owner\` parameter to assign them
`
    : ''

  // 正文。注意反引号里的 `pending` 是给模型看的字面量，别改大小写。
  return `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations${teammateContext}
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
${teammateTips}- Check TaskList first to avoid creating duplicate tasks
`
}
