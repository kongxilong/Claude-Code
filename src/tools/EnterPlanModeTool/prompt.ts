/**
 * ============================================================================
 *  【文件总览】src/tools/EnterPlanModeTool/prompt.ts
 * ============================================================================
 *
 *  一句话定位：
 *  「进入 plan mode」这个工具的**提示词（prompt）**。也就是写给模型看的
 *  使用说明书——什么时候该用、什么时候别用、举一堆正例反例。
 *
 *  为什么提示词要单独放一个文件？
 *    ① 提示词通常是几百行的多行文本，混在逻辑代码里会彻底淹没结构；
 *    ② 提示词需要频繁润色（改一个措辞模型行为就变），和逻辑代码分开
 *       能让 review 的人一眼看出"这次只改了文案，没碰逻辑"；
 *    ③ 有些工具需要根据用户身份/实验分组给出**不同版本**的提示词，
 *       本文件就有两套（External 和 Ant）。
 *
 *  在架构中的位置：
 *      EnterPlanModeTool.ts 的 prompt() 钩子
 *        └─> getEnterPlanModeToolPrompt()   ← ★ 本文件第 166 行
 *              ├─> getEnterPlanModeToolPromptExternal()   对外用户版
 *              └─> getEnterPlanModeToolPromptAnt()        内部员工版
 *      最终这段文本会进模型的工具清单，成为模型决策"要不要进 plan mode"的依据。
 *
 *  本文件包含什么：
 *   1. WHAT_HAPPENS_SECTION               可复用的"进 plan mode 后会怎样"段落
 *   2. getEnterPlanModeToolPromptExternal()  对外版提示词（更鼓励多用）
 *   3. getEnterPlanModeToolPromptAnt()       内部版提示词（更克制，嫌啰嗦）
 *   4. getEnterPlanModeToolPrompt()          ★统一入口，按环境变量二选一
 *
 *  TS 语法速查（Java 工程师视角）：
 *   - 反引号 `` ` `` 包起来的叫**模板字符串（template literal）**：
 *       可以跨多行书写，并且用 `${expr}` 在任意位置插值。
 *     ≈ Java 15+ 的文本块 `"""..."""`，但 TS 从语言诞生就支持插值。
 *     本文件通篇都是它，因为提示词天然就是长文本。
 *     ⚠️ 注意：模板字符串里的换行和缩进**都会被原样保留**，
 *        所以你会看到代码里这些反引号内容顶格写——那不是格式乱了，
 *        是为了让最终发给模型的文本保持正确的缩进。
 *
 *   - `` `${ASK_USER_QUESTION_TOOL_NAME}` `` 在模板字符串里插值另一个常量。
 *     ≈ Java 的 String.format("...%s...", NAME)。
 *     为什么不用硬编码 'AskUserQuestion'？因为工具名可能被改名，
 *     引用常量能保证提示词里写的名字和实际注册的名字永远一致。
 *     这一点很重要：提示词里写错工具名，模型就会调用一个不存在的工具。
 *
 *   - `process.env.USER_TYPE`  读环境变量。
 *     ≈ Java 的 System.getenv("USER_TYPE")。
 *     TS 里 process.env 的每个键类型都是 `string | undefined`（可能没设），
 *     所以严谨的写法要配 `??` 兜底；这里直接和 'ant' 比较，
 *     undefined === 'ant' 为 false，走 else 分支，行为正确。
 *
 *   - `cond ? a : b` 三元表达式，和 Java 完全一样。
 *     本文件用在两处：决定要不要插入 WHAT_HAPPENS_SECTION、
 *     以及决定返回哪一套提示词。
 *
 *   - `''` 空字符串。注意 TS 里单引号和双引号都表示字符串（完全等价），
 *     反引号才是模板字符串。Java 里单引号是 char，别混淆。
 */
import { isPlanModeInterviewPhaseEnabled } from '../../utils/planModeV2.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

/**
 * 「进 plan mode 之后会发生什么」这段说明。
 *
 * 为什么要抽成模块级常量而不是内联到函数里？
 *   因为下面两个提示词版本（External / Ant）都要用同一段文字。
 *   抽出来才能保证两边措辞一致——否则改了一处忘了另一处，
 *   两版用户看到的说明就不一样了。
 *
 * 为什么要能整段省略（见下面两个函数里的三元判断）？
 *   因为灰度开关 isPlanModeInterviewPhaseEnabled() 打开时，
 *   更详细的分步流程会通过另一条通道（plan_mode 附件）发给模型，
 *   这里再说一遍就是重复烧 token。所以打开时这里传空串 ''。
 */
const WHAT_HAPPENS_SECTION = `## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use ${ASK_USER_QUESTION_TOOL_NAME} if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

`

/**
 * 对外用户版提示词（默认走这条）。
 *
 * 这套文案的**基调是"鼓励多用"**：
 *   开篇就是 "Use this tool proactively when you're about to start a
 *   non-trivial implementation task"，然后列了 7 条"该用"的条件，
 *   而"不该用"只列了 4 条，且都强调"仅限简单任务"。
 *
 * 为什么对外部用户要这么写？
 *   外部用户最怕 AI 不问青红皂白就把代码库改乱。
 *   多进几次 plan mode 的代价只是多一轮对话，
 *   少进一次的代价可能是几百行要返工的代码。
 *   所以拿不准时宁可让模型多问一句——
 *   文案里那句 "If unsure whether to use it, err on the side of planning"
 *   （拿不准就倾向于先规划）就是这个意思。
 *
 * 返回值：完整的提示词字符串，进模型的工具清单。
 */
function getEnterPlanModeToolPromptExternal(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  // 【中文补注】灰度开关打开时，把"会发生什么"整段留空（''），
  // 因为详细流程会走 plan_mode 附件那条通道单独下发，避免重复烧 token。
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use ${ASK_USER_QUESTION_TOOL_NAME} to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with explore agent instead)

${whatHappens}## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase
`
}

/**
 * 内部员工版（Ant）提示词。
 *
 * 这套文案的**基调是"克制"**，和上面对外版形成鲜明对比：
 *   · 开篇从 "proactively"（主动用）降级成
 *     "when a task has genuine ambiguity about the right approach"
 *     （只有方案真的有歧义时才用）
 *   · "该用"的条件从 7 条砍到 3 条，且都强调"歧义要真实存在"
 *   · "不该用"从 4 条扩到 6 条，还专门列了
 *     "用户说'我们搞一下 X'时直接开干，别去规划"
 *   · 结尾反过来强调："拿不准就先动手，用 AskUserQuestion 问具体的点，
 *     别动不动就进完整规划阶段"
 *
 * 为什么要给内部员工一版更激进的？
 *   内部用户（ant）是自己人，天天用、熟悉这套工具，
 *   反复被问"要不要先规划"对他们来说是纯粹的噪音。
 *   而且内部用户的任务往往上下文明确，真的需要规划的比例本来就低。
 *   所以同一份功能，对两类人群给出完全不同的默认倾向。
 *
 * ⚠️ 这是个很值得注意的产品设计手法：
 *   「同一段代码，靠环境变量分流出两套行为」，
 *   而不是为两类人群各写一份工具实现。改动提示词的成本远低于改代码。
 */
function getEnterPlanModeToolPromptAnt(): string {
  // When interview phase is enabled, omit the "What Happens" section —
  // detailed workflow instructions arrive via the plan_mode attachment (messages.ts).
  // 【中文补注】和上面 External 版的处理完全一致：灰度开关打开时留空。
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `Use this tool when a task has genuine ambiguity about the right approach and getting user input before coding would prevent significant rework. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

Plan mode is valuable when the implementation approach is genuinely unclear. Use it when:

1. **Significant Architectural Ambiguity**: Multiple reasonable approaches exist and the choice meaningfully affects the codebase
   - Example: "Add caching to the API" - Redis vs in-memory vs file-based
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling

2. **Unclear Requirements**: You need to explore and clarify before you can make progress
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Refactor this module" - need to understand what the target architecture should be

3. **High-Impact Restructuring**: The task will significantly restructure existing code and getting buy-in first reduces risk
   - Example: "Redesign the authentication system"
   - Example: "Migrate from one state management approach to another"

## When NOT to Use This Tool

Skip plan mode when you can reasonably infer the right approach:
- The task is straightforward even if it touches multiple files
- The user's request is specific enough that the implementation path is clear
- You're adding a feature with an obvious implementation pattern (e.g., adding a button, a new endpoint following existing conventions)
- Bug fixes where the fix is clear once you understand the bug
- Research/exploration tasks (use the Agent tool instead)
- The user says something like "can we work on X" or "let's do X" — just get started

When in doubt, prefer starting work and using ${ASK_USER_QUESTION_TOOL_NAME} for specific questions over entering a full planning phase.

${whatHappens}## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Genuinely ambiguous: session vs JWT, where to store tokens, middleware structure

User: "Redesign the data pipeline"
- Major restructuring where the wrong approach wastes significant effort

### BAD - Don't use EnterPlanMode:
User: "Add a delete button to the user profile"
- Implementation path is clear; just do it

User: "Can we work on the search feature?"
- User wants to get started, not plan

User: "Update the error handling in the API"
- Start working; ask specific questions if needed

User: "Fix the typo in the README"
- Straightforward, no planning needed

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
`
}

/**
 * ★ 统一入口：EnterPlanModeTool.ts 的 prompt() 钩子只需要调这一个函数。
 *
 * 为什么要有这个"薄薄一层"的转发函数，而不是让调用方自己判断？
 *   因为"选哪一版提示词"这个决策属于本模块的内部细节。
 *   将来如果分流规则变了（比如加个实验分组、或者再出一版提示词），
 *   只需要改这一个函数，调用方一行都不用动。
 *   ≈ Java 里的工厂方法 / 策略模式的入口。
 *
 * 注意 process.env.USER_TYPE 的类型是 `string | undefined`
 * （环境变量可能压根没设）。这里没有用 `??` 兜底也没问题：
 * undefined === 'ant' 结果是 false，自然落到 else 分支，
 * 也就是"默认给外部用户版"——这正是我们想要的默认行为。
 *
 * 语法点：`cond ? A() : B()` 三元表达式，和 Java 一模一样。
 * 两个分支都是函数调用，只有被选中的那一支会真的执行（惰性求值）。
 */
export function getEnterPlanModeToolPrompt(): string {
  return process.env.USER_TYPE === 'ant'
    ? getEnterPlanModeToolPromptAnt()
    : getEnterPlanModeToolPromptExternal()
}
