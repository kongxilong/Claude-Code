/**
 * ============================================================================
 *  【文件总览】src/tools/TaskListTool/prompt.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  TaskList 工具的说明文本。内容随"是否开启多 agent 协作"变化，所以是函数不是常量。
 *
 *  【为什么开了 swarm 就要多写一大段？】
 *  因为在多 agent 场景下，TaskList 承担了**任务派发**的角色：
 *  空闲的 teammate 靠它找活 → 认领（TaskUpdate 设 owner）→ 干活。
 *  这套流程必须写清楚，否则多个 agent 会抢同一个任务，或者都干等着没人认领。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `isAgentSwarmsEnabled() ? A : ''`：**运行时**三元（不是编译期 feature()）。
 *  - 模板字符串里 `${teammateWorkflow}` 把整段可选内容拼进去，避免留下空行。
 */
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

// 一句话描述（给 UI 用）。
export const DESCRIPTION = 'List all tasks in the task list'

/**
 * 生成 TaskList 的使用说明。
 *
 * @returns Markdown 文本。核心三块：
 *          ① 什么时候用（找活 / 看进度 / 找被挡住的任务）
 *          ② 输出有哪些字段（尤其解释了 blockedBy 的含义）
 *          ③ 多 agent 时的认领流程（可选追加）
 */
export function getPrompt(): string {
  // 开了 swarm 才追加"派活前先看列表"这条用例。
  const teammateUseCase = isAgentSwarmsEnabled()
    ? `- Before assigning tasks to teammates, to see what's available
`
    : ''

  // 两个分支文案目前完全一样，是刻意保留的结构：
  // 将来要给单 agent / 多 agent 分别写不同说明时，改这里就行，不用动模板。
  const idDescription = isAgentSwarmsEnabled()
    ? '- **id**: Task identifier (use with TaskGet, TaskUpdate)'
    : '- **id**: Task identifier (use with TaskGet, TaskUpdate)'

  // 多 agent 专属：teammate 的"找活 → 认领 → 干活"标准流程。
  // 其中"优先做 id 小的任务"是经验规则（靠前的任务往往为后面的铺路）。
  const teammateWorkflow = isAgentSwarmsEnabled()
    ? `
## Teammate Workflow

When working as a teammate:
1. After completing your current task, call TaskList to find available work
2. Look for tasks with status 'pending', no owner, and empty blockedBy
3. **Prefer tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones
4. Claim an available task using TaskUpdate (set \`owner\` to your name), or wait for leader assignment
5. If blocked, focus on unblocking tasks or notify the team lead
`
    : ''

  // 正文模板。注意末尾 ${teammateWorkflow} 紧跟在正文后面，
  // 这样没开 swarm 时（它是空串）不会多出一个空行。
  return `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
${teammateUseCase}- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
${idDescription}
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.
${teammateWorkflow}`
}
