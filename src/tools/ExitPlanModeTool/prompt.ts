/**
 * ============================================================================
 *  【文件总览】src/tools/ExitPlanModeTool/prompt.ts
 * ============================================================================
 *
 *  一句话定位：
 *  「退出 plan mode」这个工具写给模型看的**使用说明书**。
 *  核心是反复强调一件事：**这个工具不接受方案正文作为参数**，
 *  方案是从磁盘上的计划文件读的。
 *
 *  为什么提示词要单独放一个文件？
 *    ① 提示词是几百行的多行文本，混在逻辑代码里会彻底淹没结构；
 *    ② 提示词需要频繁润色（改一个措辞，模型行为就变），
 *       和逻辑分开能让 reviewer 一眼看出"这次只改了文案，没碰逻辑"；
 *    ③ 提示词有对外版/内部版之分（本文件就是"对外 stub 版"）。
 *
 *  在架构中的位置：
 *      ExitPlanModeV2Tool.ts 的 prompt() 钩子
 *        └─> EXIT_PLAN_MODE_V2_TOOL_PROMPT   ← ★ 本文件唯一的导出
 *      最终这段文本进模型的工具清单，成为它"什么时候该调这个工具"的依据。
 *
 *  本文件包含什么：
 *   1. ASK_USER_QUESTION_TOOL_NAME   硬编码的工具名（见下方注释说明原因）
 *   2. EXIT_PLAN_MODE_V2_TOOL_PROMPT  提示词正文
 *
 *  TS 语法速查（Java 工程师视角）：
 *   - 反引号 `` ` `` 包起来的是**模板字符串**：
 *       可以跨多行，并用 ${expr} 插值。
 *     ≈ Java 15+ 的文本块 `"""..."""`，但 TS 从诞生就有，且支持插值。
 *     ⚠️ 模板字符串里的换行和缩进**全部原样保留**，
 *        所以本文件那段提示词顶格写——不是格式乱了，
 *        是为了最终发给模型的 Markdown 保持正确缩进。
 *
 *   - `export const X = ...`  对外公开一个不可重新赋值的常量。
 *     ≈ Java 的 `public static final String X`。
 *     注意这里**没有**写 `: string` 类型标注——TS 能从右侧字面量推断出来，
 *     这叫类型推断，≈ Java 10+ 的 `var`。
 *
 *   - `//` 行注释，和 Java 的 `//` 完全一样。
 */
// External stub for ExitPlanModeTool prompt - excludes Ant-only allowedPrompts section

// Hardcoded to avoid relative import issues in stub
// 【中文补注】上面英文说明：这个工具名**故意硬编码**在这里，
// 而不是从 ../AskUserQuestionTool/prompt.js import 过来。
// 为什么？因为本文件是对外发布的"stub（存根）版"提示词，
// 会被单独打包。如果引入一个相对路径的 import，
// 打包时会把一整条依赖链（那个文件又 import 别的……）都拖进来，
// 在 stub 这种"不该有依赖"的场景下很容易出路径问题。
// 用硬编码换取"零依赖"，是深思熟虑后的取舍。
// ⚠️ 代价：AskUserQuestion 工具改名时，这里不会报错，只会静默失效。
//    所以看到硬编码的工具名要知道——这是有意为之，不是疏漏。
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

/**
 * 提示词正文。
 *
 * 这段文案反复强调三件事（每一条背后都是真实踩过的坑）：
 *
 *  ① "This tool does NOT take the plan content as a parameter"
 *     （本工具不接受方案正文作为参数）
 *     为什么反复说？因为第一版 ExitPlanModeTool **就是**把方案当参数传的，
 *     模型被训练/提示成了"要传 plan"。升级到 V2 改成读磁盘之后，
 *     模型还是习惯性地塞一个 plan 参数进来，既浪费 token 又可能传错。
 *     所以提示词必须明确纠正这个旧习惯。
 *
 *  ② 这个工具只用于"规划实现步骤"，不用于"调研"
 *     为什么强调？因为模型很容易在完成一个调研任务后顺手调 ExitPlanMode，
 *     弹出一个毫无意义的审批窗（用户根本没让它写代码）。
 *     文案里专门给了反例："搜索并理解 vim mode 的实现"→ 不要用本工具。
 *
 *  ③ 不要用 AskUserQuestion 来问"这个方案行吗"
 *     因为"请求批准方案"这件事**就是** ExitPlanMode 的职责。
 *     如果模型先用 AskUserQuestion 问一遍，再调 ExitPlanMode，
 *     用户就要回答两次同样的问题。
 */
export const EXIT_PLAN_MODE_V2_TOOL_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use ${ASK_USER_QUESTION_TOOL_NAME} first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use ${ASK_USER_QUESTION_TOOL_NAME} to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use ${ASK_USER_QUESTION_TOOL_NAME} first, then use exit plan mode tool after clarifying the approach.
`
