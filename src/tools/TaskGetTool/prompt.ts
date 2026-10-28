/**
 * ============================================================================
 *  【文件总览】src/tools/TaskGetTool/prompt.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  TaskGet 工具的说明文本。这里只有常量、没有函数 —— 因为内容不依赖任何运行时开关，
 *  直接导出一个字符串常量即可（比 TaskCreate 的 getPrompt() 更简单）。
 *
 *  【在架构中的位置】
 *      TaskGetTool.description() → DESCRIPTION
 *      TaskGetTool.prompt()      → PROMPT
 *
 *  【注意】这些英文是**给模型看的**，不要翻译；本文件的中文注释才是给你看的。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `export const PROMPT = \`...\``：导出一个模板字符串常量。
 *    ≈ Java 的 `public static final String PROMPT = """...""";`（文本块，Java 15+）。
 */
export const DESCRIPTION = 'Get a task by ID from the task list'

// 一句话描述（给 UI 用）。
export const PROMPT = `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.
`
