/**
 * ============================================================================
 *  【文件总览】src/tools/TaskUpdateTool/prompt.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  TaskUpdate 工具的说明文本。纯常量，不依赖任何运行时开关。
 *
 *  【为什么这段 prompt 写得这么长？重点在两处"防忽悠"】
 *  ① 用大篇幅定义"什么情况下**不许**标 completed"：测试挂了、只做了一半、
 *     还有没解决的错误、找不到依赖文件 —— 都不算完成。
 *     因为模型天然倾向于"尽快把任务划掉"，这会骗过用户，必须显式约束。
 *  ② 单独列了"Staleness"一节：改任务前**先用 TaskGet 读一遍最新状态**。
 *     任务是被多个 agent 共享的磁盘文件，你手里的信息随时可能过期。
 *
 *  【在架构中的位置】
 *      TaskUpdateTool.description() → DESCRIPTION
 *      TaskUpdateTool.prompt()      → PROMPT
 *
 *  【注意】这些英文是**给模型看的**，不要翻译；中文注释才是给你看的。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `export const PROMPT = \`...\``：导出一个模板字符串常量
 *    ≈ Java 的 `public static final String PROMPT = """...""";`（文本块）。
 *  - 模板里出现的 `` \`pending\` `` 是**转义后的反引号** ——
 *    因为外层已经是模板字符串了，里面想显示反引号必须写 \`。
 *    这是初学者最容易看晕的一处（Java 文本块里没有这问题）。
 */
export const DESCRIPTION = 'Update a task in the task list'

// 一句话描述（给 UI 的工具列表 / 权限弹框用）。
export const PROMPT = `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\`
`
