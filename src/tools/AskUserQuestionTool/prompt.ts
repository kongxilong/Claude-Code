/**
 * ============================================================================
 *  【文件总览】src/tools/AskUserQuestionTool/prompt.ts —— 交互式提问的文案层
 * ============================================================================
 *
 *  【一句话定位】
 *  存放 AskUserQuestion 工具的名字常量、一句话描述、给模型的完整使用说明，
 *  以及一份「预览功能」的可选附加说明（markdown 版 / html 版二选一）。
 *
 *  【在架构中的位置】
 *      系统提示词组装
 *        └─> AskUserQuestionTool.prompt()          ← AskUserQuestionTool.tsx
 *              ├─> ASK_USER_QUESTION_TOOL_PROMPT   ← ★ 本文件（主说明）
 *              └─> PREVIEW_FEATURE_PROMPT[format]  ← ★ 本文件（预览功能说明，可选）
 *      其它模块也引用本文件的常量：
 *        ASK_USER_QUESTION_TOOL_NAME        → 工具注册 / 权限规则
 *        ASK_USER_QUESTION_TOOL_CHIP_WIDTH  → UI 里 header 标签的最大宽度
 *                                              （同时被 zod schema 的 describe 引用）
 *
 *  【本文件包含什么】
 *   1. ASK_USER_QUESTION_TOOL_NAME          工具名 'AskUserQuestion'
 *   2. ASK_USER_QUESTION_TOOL_CHIP_WIDTH    12，header 标签的字符数上限
 *   3. DESCRIPTION                          一句话描述（权限弹窗等地方用）
 *   4. PREVIEW_FEATURE_PROMPT               { markdown, html } 两版预览功能说明
 *   5. ASK_USER_QUESTION_TOOL_PROMPT        给模型的完整使用说明（本文件主体）
 *
 *  【为什么要有「预览」这个功能和两套文案】
 *  有些选择题光看文字选不出来，比如"这两种 UI 布局你选哪个"。
 *  所以给选项加了一个可选的 preview 字段，可以放 ASCII 草图或 HTML 片段。
 *  但预览的**渲染能力取决于调用方**（SDK 使用者）：
 *      · 终端 TUI 只能渲染 markdown/等宽文本 → 用 markdown 版说明
 *      · 网页端能渲染 HTML 片段 → 用 html 版说明，并附带安全约束
 *  所以在 AskUserQuestionTool.prompt() 里按 getQuestionPreviewFormat() 的
 *  返回值决定**是否追加、追加哪一版**——没有选格式就不追加（避免给模型
 *  讲一个它用不了的功能，反而诱导它错误使用）。
 *
 *  【那段 "Plan mode note" 为什么写得这么啰嗦】
 *  这是在**堵一个真实的模型行为漏洞**：模型在 plan mode 下很容易用
 *  AskUserQuestion 去问"我的计划可以吗？"，但那时用户根本看不到计划
 *  （计划要等 ExitPlanMode 才展示），于是用户被问了一个莫名其妙的问题。
 *  所以提示词里明确：计划审批请用 ExitPlanMode，且**不要在问题里提到"计划"**。
 *  这种"把踩过的坑写进提示词"的段落在本仓库很常见。
 *
 *  【TS 语法速查】
 *   - `export const X = '...'`     导出常量 ≈ Java 的 public static final String
 *   - `{ markdown: `...`, html: `...` } as const`
 *                                  `as const` 让字面量类型**收窄成字面量本身**，
 *                                  而不是退化成 string；并且让所有属性变 readonly。
 *                                  ≈ Java 里没有；近似枚举 + 不可变 Map
 *   - 反引号模板字符串             可换行、可嵌 `${...}`
 *                                  ≈ Java 的文本块（"""）/ String.format
 *   - `${EXIT_PLAN_MODE_TOOL_NAME}`  在提示词里**引用另一个常量**而不是写死字符串，
 *                                  这样改名时提示词自动跟着变（避免文案与代码脱节）
 * ============================================================================
 */
import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

// 中文补充：header 标签的字符数上限（12）。
// 为什么这么小？因为这个标签在 UI 上是一个**小 chip/标签**，宽度必须固定，
// 否则选项列表会被挤歪。它同时被 schema 的 describe 文案引用
// （"max ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} chars"），
// 这样模型在生成时就直接被告知了长度限制，不用等校验报错。
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

// 中文补充：给权限弹窗等活动状态用的一句话描述。
// 注意它比 ASK_USER_QUESTION_TOOL_PROMPT 短得多——因为弹窗空间有限，
// 只需要让用户知道"这是要问我问题"。
export const DESCRIPTION =
  'Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.'

// 中文补充：preview 功能的说明，按渲染能力分两版（原因见文件头）。
//   · markdown 版：允许 ASCII 草图、代码块、配置样例，说明里提到
//     "有 preview 时 UI 会切换成左右分栏"
//   · html 版：额外强调**必须是 HTML 片段**——不能有 <html>/<body> 包裹，
//     不能有 <script>/<style>（因为 SDK 使用者通常用 innerHTML 塞进去，
//     放行脚本等于让用户被 XSS）。这份约束会在代码里再校验一次
//     （见 AskUserQuestionTool.tsx 的 validateHtmlPreview）。
//   · 两版都强调：简单的偏好题不要用 preview（标签+描述就够了，
//     加预览反而增加噪音和 token 成本）；且 preview **只支持单选**。
export const PREVIEW_FEATURE_PROMPT = {
  markdown: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`,
  html: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- HTML mockups of UI layouts or components
- Formatted code snippets showing different implementations
- Visual comparisons or diagrams

Preview content must be a self-contained HTML fragment (no <html>/<body> wrapper, no <script> or <style> tags — use inline style attributes instead). Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`,
} as const

/**
 * 给模型的完整使用说明（系统提示词的一部分）。
 * 中文要点（原文是英文，这里解释每一条为什么写）：
 *  - 开头列举 4 种使用场景：收集偏好、澄清歧义、拿决策、给方向选择。
 *    这是在**限定工具的适用边界**，防止模型拿它问废话（比如"要继续吗"）。
 *  - "用户总能选 Other 输入自定义文本"：告诉模型**不要自己造一个 Other 选项**
 *    （下面 schema 里也明确写了 There should be no 'Other' option）。
 *    两处重复是因为实测模型经常自己加 Other，导致出现两个 Other。
 *  - "推荐的选项放第一个并加 (Recommended)"：这是 UI 约定，
 *    第一个选项会被高亮/预选，把推荐项放首位能提升用户采纳率。
 *  - Plan mode 那一大段：见文件头说明，是在堵"问用户看不见的计划"这个漏洞。
 * 【为什么它是 `const` 而不是函数】因为它不含动态内容
 *    （对比 WebSearchTool/prompt.ts 里的 getWebSearchPrompt()，那个要取当前年月）。
 */
export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ${EXIT_PLAN_MODE_TOOL_NAME}. If you need plan approval, use ${EXIT_PLAN_MODE_TOOL_NAME} instead.
`
