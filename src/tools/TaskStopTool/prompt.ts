/**
 * ============================================================================
 *  【文件总览】src/tools/TaskStopTool/prompt.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  TaskStop 工具的**名字常量 + 说明文本**。
 *  注意：和大多数工具的目录不同，本目录**没有** constants.ts ——
 *  工具名常量直接放在了这里（TASK_STOP_TOOL_NAME）。
 *
 *  【在架构中的位置】
 *      TaskStopTool.name   → TASK_STOP_TOOL_NAME（本文件）
 *      TaskStopTool.prompt → DESCRIPTION（本文件）
 *
 *  【注意】这些英文是**给模型看的**，不要翻译；中文注释才是给你看的。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `export const X = \`...\``：导出一个模板字符串常量
 *    ≈ Java 的 `public static final String X = """...""";`（文本块）。
 *  - 这里用模板字符串而不是普通引号，是因为内容**多行**且想让首尾换行清晰。
 */
export const TASK_STOP_TOOL_NAME = 'TaskStop'

// 给模型看的说明（简洁的 4 条要点）。
export const DESCRIPTION = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
`
