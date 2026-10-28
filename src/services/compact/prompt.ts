/**
 * 【一句话定位】压缩用的**提示词模板仓库**：这里存放「让模型生成摘要」的那几段提示词，
 * 以及把模型返回的 XML 摘要清洗成可读文本的格式化函数。整个文件不碰任何压缩算法，只负责「说什么」和「怎么洗」。
 *
 * 【在架构中的位置】
 * - 上游：src/services/compact/compact.ts。它在构造压缩请求时调用本文件的
 *   getCompactPrompt()（整段压缩）或 getPartialCompactPrompt()（部分压缩）拿到提示词，
 *   模型返回摘要后再调用 formatCompactSummary() 清洗、getCompactUserSummaryMessage() 包装。
 *   而 compact.ts 本身是由 src/query.ts 的主循环调用的。
 * - 下游：可选的 ../../proactive/index.js（自主/主动模式下追加一段提示）；其余无外部依赖。
 * - 调用链：src/query.ts（主循环）→ compact/autoCompact.ts（判定是否要压）→ compact/compact.ts（发起压缩请求）→ 本文件（取提示词 / 洗摘要）
 *
 * 【关键认知：压缩本身就是一次模型调用】
 * 很多人以为压缩是「程序自动截断历史」。不是。Claude Code 的压缩是**再问一次模型**：
 *   ① 把（几乎）完整的对话历史原样作为上下文
 *   ② 配上本文件里这段提示词，要求模型输出一个结构化的 XML 摘要
 *   ③ 拿到摘要后，把原始历史全部丢弃，只留「摘要 + 边界消息 + 最近若干条原文」
 * 所以压缩是有成本的（一次额外的 API 调用 + 延迟），也必须像普通请求一样防止模型乱来
 * —— 这就是下面 NO_TOOLS_PREAMBLE / NO_TOOLS_TRAILER 存在的原因。
 *
 * 【本文件包含什么】
 * - NO_TOOLS_PREAMBLE：放最开头的「禁止调工具」强硬声明。
 * - DETAILED_ANALYSIS_INSTRUCTION_BASE / _PARTIAL：要求模型先在 <analysis> 里打草稿的两套措辞。
 * - BASE_COMPACT_PROMPT：整段压缩（第四级 autocompact）用的主提示词。
 * - PARTIAL_COMPACT_PROMPT：只压缩「某点之后最近部分」时的提示词（direction='from'）。
 * - PARTIAL_COMPACT_UP_TO_PROMPT：只压缩「某点之前的前缀」时的提示词（direction='up_to'）。
 * - NO_TOOLS_TRAILER：放最后再强调一遍「别调工具」。
 * - getPartialCompactPrompt()：拼出部分压缩提示词（可选追加自定义指令）。
 * - getCompactPrompt()：拼出整段压缩提示词（可选追加自定义指令）。
 * - formatCompactSummary()：剥掉 <analysis> 草稿，把 <summary> 换成可读标题。
 * - getCompactUserSummaryMessage()：把摘要包成一条「本次会话是从上次续下来的」用户消息。
 *
 * 【TS 语法速查】
 * - `` `...` `` 反引号包起来的是**模板字符串**：可以跨多行、可以用 `${expr}` 插值，
 *   ≈ Java 15+ 的文本块 `"""..."""` + Java 21 的 StringTemplate（预览特性）。
 * - `${DETAILED_ANALYSIS_INSTRUCTION_BASE}`：把另一个常量插进模板，
 *   这是把「长提示词拆成几块再拼」的常规手法，便于复用与单独调整。
 * - `direction: PartialCompactDirection = 'from'`：参数带**默认值**，调用方可省略；
 *   ≈ Java 只能靠重载或 @Nullable + 手动兜底来模拟。
 * - `customInstructions?: string`：可选参数，函数体内类型为 `string | undefined`。
 * - `/<analysis>[\s\S]*?<\/analysis>/`：正则字面量（`/.../` 就是 Pattern），
 *   `[\s\S]` 表示「任意字符（含换行）」——因为 JS 正则里 `.` 默认**不匹配换行**，
 *   想跨行匹配就得这么写；`*?` 是非贪婪，尽量少匹配。
 * - `str.replace(regex, '')` / `str.match(regex)`：与 Java 的 Matcher 同族，
 *   match 返回 null 或数组，数组 [0] 是整段、[1] 是第一个捕获组。
 * - `summaryMatch[1] || ''`：`||` 做兜底（这里捕获组可能为空串）；
 *   注意 `??` 只在 null/undefined 时兜底，`||` 对 '' / 0 也兜底，二者别混用。
 * - `feature('PROACTIVE') || feature('KAIROS')`：`feature()` 是**编译期**常量，
 *   打包时替换为 true/false，为 false 的分支会被整体删除（≈ C 的 #ifdef），不是运行时判断。
 * - `proactiveModule?.isProactiveActive()`：`?.` 可选链，≈ 一长串 null 检查；
 *   proactiveModule 为 null 时整句短路返回 undefined，不抛异常。
 * - `let prompt = ...` + `prompt += ...`：这里用 let 是因为后面要反复 `+=` 拼接。
 */
import { feature } from 'bun:bundle'
import type { PartialCompactDirection } from '../../types/message.js'

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
// 中文补充：这是**条件 require**（运行时 require，而不是顶层 import）。
// 为什么这么做：顶层 import 会无条件把 ../../proactive/index.js 及其一整条依赖链拉进包里，
// 而只有 PROACTIVE / KAIROS 这两个编译期 feature 打开时才用得上它。
// 配合 feature()（编译期常量），feature 关闭时整个三元表达式会被折叠成 `null`，
// require 那一行随之被 tree-shaking 掉 —— 这就是英文注释说的 Dead code elimination。
// 代价：牺牲了静态类型检查（require 返回 any），所以后面要用 `as typeof import(...)` 手动补类型。
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

// Aggressive no-tools preamble. The cache-sharing fork path inherits the
// parent's full tool set (required for cache-key match), and on Sonnet 4.6+
// adaptive-thinking models the model sometimes attempts a tool call despite
// the weaker trailer instruction. With maxTurns: 1, a denied tool call means
// no text output → falls through to the streaming fallback (2.79% on 4.6 vs
// 0.01% on 4.5). Putting this FIRST and making it explicit about rejection
// consequences prevents the wasted turn.
// 中文讲解上面那段英文（这是本文件最值得记住的经验）：
// 压缩请求是用 maxTurns: 1 发的 —— 模型**只有一次机会**输出文本。
// 如果模型不听话去调工具，工具会被拒绝，这一轮就什么文本都没产出，
// 只能退化到流式兜底路径（更慢、更贵）。
// 实测在 Sonnet 4.6+ 的 adaptive-thinking 模型上，这种「白跑一轮」的发生率是 2.79%，
// 而 4.5 上只有 0.01% —— 所以必须把禁令放在**最开头**、并且把后果说得很重
// （会被拒绝 / 会浪费唯一一次机会 / 会任务失败），而不只是文末轻轻带一句。
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

// Two variants: BASE scopes to "the conversation", PARTIAL scopes to "the
// recent messages". The <analysis> block is a drafting scratchpad that
// formatCompactSummary() strips before the summary reaches context.
// 中文补充上面那段英文：两个变体的唯一区别是**摘要范围**——
//   BASE    = 「整个对话」      → 用于整段压缩（第四级 autocompact）
//   PARTIAL = 「最近的这些消息」 → 用于部分压缩（只压历史的一截）
// 至于 <analysis> 块：它是给模型的**草稿纸**，先让它把思路写下来再输出正式摘要，
// 实测能明显提高摘要质量；但它本身没有信息价值，所以 formatCompactSummary() 会把它剥掉，
// 保证进入 context 的只有干净的摘要正文。
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

// 【整段压缩主提示词】第四级 autocompact 用的那段话。
// 它要求的 9 个小节是有讲究的，覆盖了「恢复工作」真正需要的全部信息：
//   1 用户的原始诉求（最重要，丢了就跑偏了）
//   2 涉及的技术概念 / 框架
//   3 动过和看过的文件 + 代码片段（含「为什么读/改它」）
//   4 踩过的坑和修法（防止重复踩）
//   5 已解决 / 待解决的问题
//   6 所有真实用户消息（用来理解用户意图的**变化**）
//   7 还没做的任务
//   8 压缩前最后一刻在干什么（最要紧——决定下一步从哪接）
//   9 下一步建议（并要求原文引用，防止模型自己脑补导致任务漂移）
// 注意它反复强调「用户反馈」：用户说「别这样做」这类纠正必须被记下来，否则压缩后会重犯。
const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages: 
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response. 

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
`

// 【部分压缩提示词 · from 方向】用于「从某个切分点**之后**的这部分消息」需要被摘要的场景：
// 更早的历史原样保留、不需要动，所以提示词里明确写了「前面的消息保持原样，不用总结」。
// 好处是省 token —— 只对真正需要压缩的那一截调用模型。
const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
`

// 'up_to': model sees only the summarized prefix (cache hit). Summary will
// precede kept recent messages, hence "Context for Continuing Work" section.
// 【部分压缩提示词 · up_to 方向】中文讲解上面那段英文：
// 这一版里模型**只看得到要被摘要的前缀**，看不到后面的新消息。
// 而摘要生成后会被放到最前面、后面接上保留的新消息，由**另一个**模型来继续工作。
// 所以提示词的第 9 小节从 Optional Next Step 换成了 Context for Continuing Work ——
// 重点不再是「你接下来该干什么」（模型看不到后续，说了也是瞎猜），
// 而是「把后续读者需要知道的上下文、决策和状态交代清楚」。
// 『同一个摘要给不同的人看，要写不同的东西』——这是提示词设计里很容易被忽略的一点。
const PARTIAL_COMPACT_UP_TO_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents in detail
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks.
8. Work Completed: Describe what was accomplished by the end of this portion.
9. Context for Continuing Work: Summarize any context, decisions, or state that would be needed to understand and continue the work in subsequent messages.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Work Completed:
   [Description of what was accomplished]

9. Context for Continuing Work:
   [Key context, decisions, or state needed to continue the work]

</summary>
</example>

Please provide your summary following this structure, ensuring precision and thoroughness in your response.
`

// 尾部再强调一次「别调工具」。为什么首尾都要写：模型对开头和结尾的指令最敏感，
// 中间大段模板（示例、小节说明）会稀释开头的禁令，所以结尾必须补一刀。
// 这里用 `+` 拼接而不是用一个超长模板字符串，是为了把每行控制在可读的宽度内。
const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

/**
 * 拼出**部分压缩**用的完整提示词：前置禁令 + 模板 +（可选）自定义指令 + 尾部禁令。
 *
 * 为什么需要：压缩不一定非要把整段历史重写。很多时候只有「中间那一截」膨胀了，
 * 那就只压那一截，其余原样保留 —— 省 token 也省时间。
 *
 * @param customInstructions 用户 / 上层额外追加的指令（可以为空）。
 * @param direction 部分压缩的方向，决定用哪个模板：
 *        'from'  = 摘要「某切分点之后」的最近消息（更早的历史原样保留）
 *        'up_to' = 摘要「某切分点之前」的前缀（摘要后面会接上保留的新消息）
 *        默认值 'from' —— 调用方不写就是这个。
 * @returns 可以直接当作压缩请求提示词使用的完整字符串。
 *
 * 关键步骤：
 *   ① 按 direction 选出模板（三元表达式，默认走 PARTIAL_COMPACT_PROMPT）
 *   ② 拼上 NO_TOOLS_PREAMBLE（禁令在前，避免模型走神去调工具）
 *   ③ 若自定义指令非空，追加一段 Additional Instructions
 *   ④ 拼上 NO_TOOLS_TRAILER（禁令再强调一次）
 */
export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: PartialCompactDirection = 'from',
): string {
  // 三元表达式 ≈ Java 的 `cond ? a : b`；direction 没传时取默认值 'from'，走 PARTIAL_COMPACT_PROMPT
  const template =
    direction === 'up_to'
      ? PARTIAL_COMPACT_UP_TO_PROMPT
      : PARTIAL_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template

    // 为什么还要 trim()：只判断 truthy 的话，一串空格也会被当成「有自定义指令」，
    // 结果在提示词末尾多出一段空标题，白白浪费 token 还干扰模型。
  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

/**
 * 拼出**整段压缩**（第四级 autocompact）用的完整提示词。
 *
 * 为什么需要：这是最重的一级压缩。当上下文快撑爆、轻一级的手段已经不够时，
 * 就把整个历史交给模型压成一份完整摘要。代价是丢的细节最多，所以只在万不得已时用。
 * 与 getPartialCompactPrompt() 的区别：这里没有 direction —— 范围永远是整个对话。
 *
 * @param customInstructions 用户 / 上层额外追加的指令（可以为空）。
 * @returns 完整的压缩提示词字符串。
 *
 * 关键步骤：
 *   ① 拼上 NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT
 *   ② 若自定义指令非空（且不是纯空白），追加 Additional Instructions
 *   ③ 拼上 NO_TOOLS_TRAILER 后返回
 *
 * 注意：本函数与 getPartialCompactPrompt() 的拼装逻辑几乎一样，只是模板不同；
 * 两处都保留了各自独立的判断，方便分别调整措辞而不互相影响。
 */
export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

/**
 * Formats the compact summary by stripping the <analysis> drafting scratchpad
 * and replacing <summary> XML tags with readable section headers.
 * @param summary The raw summary string potentially containing <analysis> and <summary> XML tags
 * @returns The formatted summary with analysis stripped and summary tags replaced by headers
 */
/**
 * 清洗模型返回的原始摘要：剥掉 <analysis> 草稿，把 <summary> 标签换成可读标题。
 *
 * 为什么需要：模型被要求「先打草稿再输出正式摘要」，所以它返回的是
 * `<analysis>...</analysis><summary>...</summary>` 两段。草稿只是提高质量的副产品，
 * 留着不仅没用还要占 token；而 XML 标签对模型也不友好，换成「Summary:」这种
 * 自然语言标题更省 token、也更容易被后续模型正确理解。
 * 这是「提示词里要它写草稿」和「context 里不要草稿」这对矛盾的解决办法。
 *
 * @param summary 模型返回的原始字符串，可能包含 <analysis> 和 <summary> 标签。
 * @returns 清洗后的摘要文本（已 trim）。模型没按格式输出时，原样返回（不会抛错）。
 *
 * 关键步骤：
 *   ① 用正则把 <analysis>...</analysis> 整段替换成空字符串（非贪婪，只剥第一段）
 *   ② 用 match 取出 <summary> 的捕获组内容
 *   ③ 把 <summary>...</summary> 整段替换成「Summary:」+ 正文
 *   ④ 把连续多个换行压成两个（清理剥除后留下的空洞）
 *   ⑤ trim 后返回
 */
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  // Strip analysis section — it's a drafting scratchpad that improves summary
  // quality but has no informational value once the summary is written.
  // 正则里的 [\s\S] = 「任意字符，含换行」。JS 正则的 `.` 默认不匹配换行，
  // 想跨行匹配就必须写 [\s\S]（或加 s 标志）。`*?` 是非贪婪：只剥到第一个 </analysis> 为止。
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  // Extract and format summary section
  // match 返回 null（没匹配上）或数组：数组[0] 是整段，数组[1] 是括号捕获的内容。
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    // `|| ''` 兜底：捕获组理论上不会是 undefined，但写成这样可以让类型从 `string | undefined` 收窄成 `string`。
    // （这里用 || 而不是 ??，是因为空串也想一并兜住。）
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }

  // Clean up extra whitespace between sections
  // `g` 标志 = 全局替换（Java 里是 replaceAll）。把 3 个以上的连续换行压回 2 个，
  // 因为上面剥掉 analysis 之后会留下大片空白。
  formattedSummary = formattedSummary.replace(/\n\n+/g, '\n\n')

  return formattedSummary.trim()
}

/**
 * 把清洗好的摘要**包装成一条用户消息**：告诉模型「这是一段续接的会话，下面是之前发生的事」。
 *
 * 为什么需要：压缩后的第一条消息必须是**用户消息**——API 要求对话以 user 开头，
 * 而且必须用自然语言交代清楚「这是摘要、不是用户真的说了这些话」，
 * 否则模型会把摘要内容误当成用户的真实指令。
 *
 * @param summary 模型生成的原始摘要（会被 formatCompactSummary() 清洗）。
 * @param suppressFollowUpQuestions 为 true 时追加「不要反问用户，直接接着干」的指令；
 *        用于自动压缩这种「用户没主动要求、系统自己触发」的场景。
 * @param transcriptPath 完整 transcript 的落盘路径。有值就告诉模型「需要细节可以去读这个文件」，
 *        这样压缩时可以更放心地丢掉细节 —— 反正原文还在磁盘上。
 * @param recentMessagesPreserved 是否保留了最近若干条原文。为 true 时明确说明，
 *        让模型知道摘要后面还有原文，不要把两者搞混。
 * @returns 可以直接作为用户消息内容发送的完整字符串。
 *
 * 关键步骤：
 *   ① 先清洗摘要（剥草稿、换标题）
 *   ② 套上「本会话因上下文耗尽而续接」的说明
 *   ③ 按三个可选参数依次追加提示（transcript 路径 / 最近消息保留 / 不要反问）
 *   ④ 返回
 */
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  // 模板字符串跨多行书写：换行原样保留，所以排版即最终文本，不用手动拼 \n。
  // ≈ Java 15+ 的文本块 """..."""。
  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`

  if (transcriptPath) {
    baseSummary += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    baseSummary += `\n\nRecent messages are preserved verbatim.`
  }

  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`

    if (
    // `feature('PROACTIVE')` 是**编译期**常量（打包时替换成 true/false），不是运行时 if。
    // 后面再跟 `?.` 是因为 proactiveModule 在 feature 关闭时就是 null，
    // 运行时还得再兜一层 —— 两层保护解决的是不同层面的问题。
      (feature('PROACTIVE') || feature('KAIROS')) &&
      proactiveModule?.isProactiveActive()
    ) {
      continuation += `

You are running in autonomous/proactive mode. This is NOT a first wake-up — you were already working autonomously before compaction. Continue your work loop: pick up where you left off based on the summary above. Do not greet the user or ask what to work on.`
    }

    return continuation
  }

  return baseSummary
}
