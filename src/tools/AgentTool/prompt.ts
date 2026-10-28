/**
 * 【一句话定位】生成 Agent 工具**给模型看的描述文本**（tool description）：可用 agent 列表、
 * 什么时候该用/不该用、怎么写 prompt、示例用法。
 *
 * 【在架构中的位置】
 *   上游：AgentTool.tsx 的 prompt() 回调（工具框架在组装 tools 块时调用）。
 *   下游：forkSubagent.ts（判断 fork 开关）、utils/embeddedTools.js（判断是否有内嵌搜索工具）。
 *   产出：一段 Markdown 文本，会被放进发往模型的 tools[].description 里。
 *
 * 【本文件包含什么】
 *   - getToolsDescription()：把一个 agent 的 tools/disallowedTools 描述成一句人话。
 *   - formatAgentLine()：agent 列表里的一行 `- type: whenToUse (Tools: ...)`。
 *   - shouldInjectAgentListInMessages()：决定 agent 列表是内联在描述里，还是走 attachment 消息。
 *   - getPrompt()：**主入口**，拼出完整的工具描述。
 *
 * 【为什么要做「列表走 attachment」这个优化】(shouldInjectAgentListInMessages)
 *   把可用 agent 列表直接写进 tool description，意味着这份列表进入了 tools 块的 prompt cache 前缀。
 *   而这份列表是会变的（MCP 异步连上、/reload-plugins、权限模式切换都会增减 agent），
 *   一变就导致整个 tools 块 cache 失效。实测占全平台 cache_creation token 的约 10.2%。
 *   所以改成：description 保持静态，agent 列表以 agent_listing_delta attachment 消息的形式
 *   注入到对话里（对话消息的变化不会破坏 tools 块的 cache）。
 *
 * 【TS 语法速查】(针对本文件实际出现的语法)
 *   - 模板字符串 `` `...${x}...` ``：反引号包裹，支持换行和 `${}` 插值，
 *     ≈ Java 的文本块（Text Block）+ String.formatted，但语言层面直接支持。
 *     本文件几乎所有内容都是模板字符串（大段的 Markdown 提示词）。
 *   - 嵌套模板字符串：`` `a ${cond ? `x` : `y`} b` `` 在 ${} 里再写一个模板字符串，完全合法。
 *   - `\u2014` 是 Unicode 转义（长破折号 ——）。
 *   - `\`` 转义反引号：模板字符串里要输出一个反引号就得转义（用了大量 Markdown 代码块）。
 *   - 三元嵌套 `a ? b : c ? d : e` ≈ else-if 链，本文件多处用来在 fork 开关下换文案。
 *   - `Partial<T>` 与可选属性 `?:`；`??` 空值合并。
 *   - `const { tools, disallowedTools } = agent` 解构 ≈ 一次取多个字段。
 *   - `arr.filter(fn).map(fn).join('\n')` ≈ Stream.filter.map.collect(joining("\n"))。
 *   - `new Set(arr)` ≈ new HashSet<>(list)；`set.has(x)` ≈ set.contains(x)。
 *   - `process.env.X` 读环境变量（Node 全局）；`isEnvTruthy()` / `isEnvDefinedFalsy()` 是封装，
 *     因为环境变量永远是字符串，'false' 用普通 if 判断是 truthy，必须专门的函数处理。
 *   - `export async function`：导出异步函数，返回 Promise<string>。
 *   - `Promise<string>` ≈ CompletableFuture<String>。
 */
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { isTeammate } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * 把一个 agent 的工具限制描述成一句人话，给模型看。
 * 四种情况：
 *   - 白名单+黑名单都有 → 先从白名单里减掉黑名单（和运行时行为保持一致）
 *   - 只有白名单 → 直接列出
 *   - 只有黑名单 → "All tools except X, Y"
 *   - 都没有 → "All tools"
 */
function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // Both defined: filter allowlist by denylist to match runtime behavior
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // Allowlist only: show the specific tools available
    return tools.join(', ')
  } else if (hasDenylist) {
    // Denylist only: show "All tools except X, Y, Z"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // No restrictions
  return 'All tools'
}

/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
/**
 * 格式化 agent 列表里的一行：`- Explore: 快速探索代码库 (Tools: All tools except Edit, Write)`。
 * 用在 agent_listing_delta attachment 消息里。
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

/**
 * 决定 agent 列表是内联在工具描述里，还是作为 attachment 消息注入。
 * 默认走 attachment（省 cache，理由见文件头）。
 * 优先级：环境变量显式指定 > GrowthBook 开关 tengu_agent_list_attach。
 */
/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description. When true, getPrompt() returns a static
 * description and attachments.ts emits an agent_listing_delta attachment.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 *
 * Override with CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false for testing.
 */
// isEnvTruthy / isEnvDefinedFalsy 是专门处理环境变量的：
// 环境变量永远是字符串，'false' 用普通 if 判断反而是 true，所以要么显式真要么显式假才算数
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}

/**
 * 拼出 Agent 工具完整的 description（给模型看的那段话）。
 *
 * 关键步骤：
 *   ① 若调用方限定了 allowedAgentTypes（来自 Agent(x,y) 语法），先把列表收窄
 *   ② fork 开关打开时插入「When to fork」章节 + 换成 fork 风格的示例
 *   ③ 拼 agent 列表（内联 or 指向 attachment）
 *   ④ coordinator 模式只返回共享核心段（它的 system prompt 已经讲了用法和示例，不重复）
 *   ⑤ 非 coordinator 再追加：什么时候不该用 / Usage notes / 示例
 *
 * @param agentDefinitions 当前生效的 agent 定义列表（已按权限和 MCP 依赖过滤过）
 * @param isCoordinator 是否 coordinator 模式（返回精简版）
 * @param allowedAgentTypes 允许派生的 agent 类型白名单
 */
export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // Filter agents by allowed types when Agent(x,y) restricts which agents can be spawned
// Agent(x,y) 语法限定了只能派生哪些 agent，这里相应收窄列表，
// 免得模型看到列表里有但一调用就报错
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // Fork subagent feature: when enabled, insert the "When to fork" section
  // (fork semantics, directive-style prompts) and swap in fork-aware examples.
  const forkEnabled = isForkSubagentEnabled()

// fork 开关打开时的专属章节。核心是教模型「什么时候该 fork 自己」：
// 判据是「中间的工具输出我还需不需要」，而不是任务大小。
  const whenToForkSection = forkEnabled
    ? `

## When to fork

Fork yourself (omit \`subagent_type\`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative \u2014 "will I need this output again" \u2014 not task size.
- **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this \u2014 it inherits context and shares your cache.
- **Implementation**: prefer to fork implementation work that requires more than a couple of edits. Do research before jumping to implementation.

// 两条规定很关键：
// ① 别偷看 output_file —— 读到一半会把 fork 的工具噪音带进自己的上下文，fork 就白做了
// ② 别抢跑 —— fork 结果还没回来时绝不能编造或预测，只能说「还在跑」
Forks are cheap because they share your prompt cache. Don't set \`model\` on a fork \u2014 a different model can't reuse the parent's cache. Pass a short \`name\` (one or two words, lowercase) so the user can see the fork in the teams panel and steer it mid-run.

**Don't peek.** The tool result includes an \`output_file\` path — do not Read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running — give status, not a guess.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.
`
    : ''

// 「怎么写 prompt」章节。fork 开启时措辞要变：
// fork 继承了上下文，所以 prompt 是「指令」；普通 subagent 零上下文，要把背景写全
  const writingThePromptSection = `

## Writing the prompt

${forkEnabled ? 'When spawning a fresh agent (with a `subagent_type`), it starts with zero context. ' : ''}Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

${forkEnabled ? 'For fresh agents, terse' : 'Terse'} command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
`

// fork 版本的示例：重点演示「回合在这里结束，通知是后面单独一轮从外面来的」
  const forkExamples = `Example usage:

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>Forking this \u2014 it's a survey question. I want the punch list, not the git output in my context.</thinking>
${AGENT_TOOL_NAME}({
  name: "ship-audit",
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list \u2014 done vs. missing. Under 200 words."
})
assistant: Ship-readiness audit running.
<commentary>
Turn ends here. The coordinator knows nothing about the findings yet. What follows is a SEPARATE turn \u2014 the notification arrives from outside, as a user-role message. It is not something the coordinator writes.
</commentary>
[later turn \u2014 notification arrives as user message]
assistant: Audit's back. Three blockers: no tests for the new prompt path, GrowthBook gate wired but not in build_flags.yaml, and one uncommitted file.
</example>

<example>
user: "so is the gate wired up or not"
<commentary>
User asks mid-wait. The audit fork was launched to answer exactly this, and it hasn't returned. The coordinator does not have this answer. Give status, not a fabricated result.
</commentary>
assistant: Still waiting on the audit \u2014 that's one of the things it's checking. Should land shortly.
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read.</thinking>
<commentary>
A subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The briefing explains what to assess and why.
</commentary>
${AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
`

// 非 fork 版本的示例（传统用法）
  const currentExamples = `Example usage:

<example_agent_descriptions>
"test-runner": use this agent after you are done writing code to run tests
"greeting-responder": use this agent to respond to user greetings with a friendly joke
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: I'm going to use the ${FILE_WRITE_TOOL_NAME} tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the test-runner agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the greeting-responder agent"
</example>
`

  // When the gate is on, the agent list lives in an agent_listing_delta
  // attachment (see attachments.ts) instead of inline here. This keeps the
  // tool description static across MCP/plugin/permission changes so the
  // tools-block prompt cache doesn't bust every time an agent loads.
// 开关打开时列表走 attachment，description 保持静态 → tools 块 cache 不会被 agent 变动打散
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // Shared core prompt used by both coordinator and non-coordinator modes
// 共享核心段：这个工具是干什么的 + 有哪些 agent 可用 + 怎么选
  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

${
  forkEnabled
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself — a fork inherits your full conversation context.`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`
}`

  // Coordinator mode gets the slim prompt -- the coordinator system prompt
  // already covers usage notes, examples, and when-not-to-use guidance.
// coordinator 模式到此为止：它自己的 system prompt 已经讲了用法、示例和禁忌，重复只会浪费 token
  if (isCoordinator) {
    return shared
  }

  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find via Bash instead.
// ant 内部构建把 find/grep 换成内嵌的 bfs/ugrep，并移除了 Glob/Grep 工具，
// 所以提示里要指向 Bash 里的 find/grep
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // The "class Foo" example is about content search. Non-embedded stays Glob
  // (original intent: find-the-file-containing). Embedded gets grep because
  // find -name doesn't look at file contents.
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
// fork 模式下删掉「什么时候不该用 Agent」这一节：
// fork 的定位变了（不再只是「找不到文件时才用」），这一节会和 fork 语义打架
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use ${contentSearchHint} instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`

  // When listing via attachment, the "launch multiple agents" note is in the
  // attachment message (conditioned on subscription there). When inline, keep
  // the existing per-call getSubscriptionType() check.
// 并发提示：只在列表内联时才在这里按订阅类型判断；走 attachment 时这段放到 attachment 里了
  const concurrencyNote =
    !listViaAttachment && getSubscriptionType() !== 'pro'
      ? `
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses`
      : ''

// 非 coordinator：追加「什么时候不该用」+ Usage notes + 示例，返回完整描述
  // Non-coordinator gets the full prompt with all sections
  return `${shared}
${whenNotToUseSection}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do${concurrencyNote}
// 重要的一条：子 Agent 的结果**不会**直接显示给用户，
// 主 Agent 必须自己再总结一遍告诉用户（否则用户看不到子 Agent 干了什么）
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.${
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammate() &&
    !forkEnabled
      ? `
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.`
      : ''
  }
// 告诉模型可以用 SendMessage 续跑某个 agent（靠 agentId），
// 同时强调「每次新的 Agent 调用都是零起步，要把任务描述写全」
- To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved. ${forkEnabled ? 'Each fresh Agent invocation with a subagent_type starts without context — provide a complete task description.' : 'Each Agent invocation starts fresh — provide a complete task description.'}
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkEnabled ? '' : ", since it is not aware of the user's intent"}
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
// 明确要求：用户说「并行」时必须在**一条**消息里发多个 tool_use 块（而不是分多条消息）
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.${
    process.env.USER_TYPE === 'ant'
      ? `\n- You can set \`isolation: "remote"\` to run the agent in a remote CCR environment. This is always a background task; you'll be notified when it completes. Use for long-running tasks that need a fresh sandbox.`
      : ''
  }${
    isInProcessTeammate()
      ? `
// 按调用方身份裁剪可用参数：in-process teammate 不支持后台/name/team_name/mode；
// 普通 teammate 不能派生 teammate。把不支持的参数从描述里去掉，模型就不会去调
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammate()
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${whenToForkSection}${writingThePromptSection}

${forkEnabled ? forkExamples : currentExamples}`
}
