/**
 * 【一句话定位】fork 子 Agent 机制的核心：**复制父 Agent 的完整上下文**给一个子 Agent，
 * 让它带着「已经聊过的一切」去干一件独立的活。
 *
 * 【在架构中的位置】
 *   上游：
 *     AgentTool.tsx（省略 subagent_type 且开关打开时走 fork 路径）、
 *     /fork 斜杠命令、resumeAgent.ts（判断是不是 fork 续跑）。
 *   下游：只依赖常量（constants/xml.js）和 createUserMessage，本身不调任何执行逻辑。
 *
 * 【fork 与普通 subagent 的本质区别】
 *   ┌────────────┬──────────────────────────┬────────────────────────────┐
 *   │            │ 普通 subagent             │ fork 子 Agent              │
 *   ├────────────┼──────────────────────────┼────────────────────────────┤
 *   │ system     │ agent 自己的 prompt      │ **父级**已渲染的 prompt     │
 *   │ prompt     │                          │ （字节级一致，为了命中 cache）│
 *   ├────────────┼──────────────────────────┼────────────────────────────┤
 *   │ 对话上下文 │ 零                       │ 父级完整对话（含所有 tool） │
 *   ├────────────┼──────────────────────────┼────────────────────────────┤
 *   │ 工具池     │ 按 agent 定义裁剪        │ 父级**完全一样**的数组      │
 *   │            │                          │ （useExactTools: true）     │
 *   ├────────────┼──────────────────────────┼────────────────────────────┤
 *   │ thinking   │ 关闭（省输出 token）     │ 继承父级配置               │
 *   ├────────────┼──────────────────────────┼────────────────────────────┤
 *   │ 模型       │ 按 agent 定义            │ inherit（跟父级一致）       │
 *   └────────────┴──────────────────────────┴────────────────────────────┘
 *   一句话总结：fork = 「复制我自己」，普通 subagent = 「另起一个新人」。
 *
 * 【为什么这么在意「字节级一致」】
 *   Anthropic 的 prompt cache 是按**请求前缀**匹配的。多个 fork 孩子如果前缀字节完全一致，
 *   只有最后那条指令不同，那么它们能共享同一份 cache，成本极低。
 *   所以 buildForkedMessages 里所有 tool_result 都用**同一个占位字符串**（不能用各自的结果，
 *   否则前缀就不一样了）。这也是为什么 FORK_AGENT 的 getSystemPrompt 返回空字符串、
 *   而真正用的是父级渲染好的字节——重新调一次 getSystemPrompt() 可能因 GrowthBook 状态变化
 *   而产出不同字节，把 cache 打散。
 *
 * 【本文件包含什么】
 *   - isForkSubagentEnabled()：fork 功能的总开关（编译期 feature + 运行时 coordinator/非交互互斥检查）。
 *   - FORK_SUBAGENT_TYPE / FORK_AGENT：fork 用的合成 agent 类型名和合成定义。
 *   - isInForkChild()：防递归守卫——扫历史消息里有没有 fork 样板标签。
 *   - FORK_PLACEHOLDER_RESULT：所有 fork 孩子共用的占位 tool_result 文本。
 *   - buildForkedMessages()：造出给 fork 孩子的初始消息（父级 assistant + 占位结果 + 本孩子指令）。
 *   - buildChildMessage()：给 fork 孩子的「你是 fork 工人」指令文本（10 条硬规则 + 输出格式）。
 *   - buildWorktreeNotice()：fork + worktree 组合时的路径翻译提示。
 *
 * 【TS 语法速查】(针对本文件实际出现的语法)
 *   - `feature('X')` 来自 'bun:bundle'：这是**编译期**宏，≈ C 的 #ifdef。
 *     构建时 false 的分支会被整段删除（dead code elimination），不是运行时 if。
 *   - `satisfies BuiltInAgentDefinition`：检查对象是否满足某个类型，
 *     但**不改变**推导出的字面量类型（比 `as` 安全，因为 as 会放宽类型、掩盖错误）。
 *   - `(block): block is BetaToolUseBlock => block.type === 'tool_use'`：
 *     内联类型谓词。TS 的 filter 用它可以把数组元素类型收窄（≈ Stream.filter + 自动 cast）。
 *   - `as const`：`{ type: 'tool_result' as const }` 把字符串锁成字面量类型，
 *     否则会被推导成 string，后面联合类型收窄就失效了。
 *   - 展开语法 `{ ...obj }` = 浅拷贝；`[...arr]` = 数组浅拷贝。
 *     本文件到处用它保证「不改动父级原始对象」（fork 绝不能污染父级上下文）。
 *   - 模板字符串 `` `a${b}c` `` ≈ Java 的 String.format / 文本块，但直接在语言层面支持插值。
 *   - `\u2014` 是 Unicode 转义（长破折号 ——），写在这里是为了避免源文件编码问题。
 *   - `arr.some(fn)` / `arr.filter(fn)` / `arr.map(fn)` ≈ Stream.anyMatch / filter / map。
 *   - `Array.isArray(x)`：TS 里联合类型要先这么判才能当数组用（编译期 narrowing）。
 *   - `const X: T = {...}` 里 T 是显式类型标注（写在变量名后面，Java 写在前面）。
 *   - `import type {...}` 只导入类型，编译后整行消失。
 *   - 箭头函数 `(a, b) => expr` ≈ Java lambda `(a, b) -> expr`。
 */
import { feature } from 'bun:bundle'
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type {
  AssistantMessage,
  Message as MessageType,
} from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../../utils/messages.js'
import type { BuiltInAgentDefinition } from './loadAgentsDir.js'

/**
 * fork 功能的总开关。三个条件**全部**满足才开：
 *   ① 编译期 feature('FORK_SUBAGENT') 为真（否则整块代码被打包器删掉）
 *   ② 不在 coordinator 模式（coordinator 已经有自己的一套委派模型，两者互斥）
 *   ③ 不是非交互会话（SDK/管道场景没有终端可以显示 fork 的进度）
 */
/**
 * Fork subagent feature gate.
 *
 * When enabled:
 * - `subagent_type` becomes optional on the Agent tool schema
 * - Omitting `subagent_type` triggers an implicit fork: the child inherits
 *   the parent's full conversation context and system prompt
 * - All agent spawns run in the background (async) for a unified
 *   `<task-notification>` interaction model
 * - `/fork <directive>` slash command is available
 *
 * Mutually exclusive with coordinator mode — coordinator already owns the
 * orchestration role and has its own delegation model.
 */
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false
    if (getIsNonInteractiveSession()) return false
    return true
  }
  return false
}

// 合成 agent 类型名。它**不**注册在 builtInAgents 里，所以模型没法用 subagent_type: 'fork' 显式选它，
// 只能通过「省略 subagent_type」来隐式触发。
/** Synthetic agent type name used for analytics when the fork path fires. */
export const FORK_SUBAGENT_TYPE = 'fork'

/**
 * fork 用的合成 agent 定义。几个字段都是刻意设计的：
 *   - tools: ['*'] 配合 useExactTools → 孩子拿到父级**完全一样**的工具数组（cache 前缀一致）
 *   - permissionMode: 'bubble' → 权限请求弹回父级终端（孩子自己没有 UI）
 *   - model: 'inherit' → 跟父级同模型，保持上下文长度一致
 *   - getSystemPrompt: () => '' → 这个函数实际上**不会被调用**！
 *     fork 路径走 override.systemPrompt，传的是父级已渲染好的字节。
 *     重新调 getSystemPrompt() 可能因 GrowthBook 冷启动→热启动而变化，把 cache 打散。
 */
/**
 * Synthetic agent definition for the fork path.
 *
 * Not registered in builtInAgents — used only when `!subagent_type` and the
 * experiment is active. `tools: ['*']` with `useExactTools` means the fork
 * child receives the parent's exact tool pool (for cache-identical API
 * prefixes). `permissionMode: 'bubble'` surfaces permission prompts to the
 * parent terminal. `model: 'inherit'` keeps the parent's model for context
 * length parity.
 *
 * The getSystemPrompt here is unused: the fork path passes
 * `override.systemPrompt` with the parent's already-rendered system prompt
 * bytes, threaded via `toolUseContext.renderedSystemPrompt`. Reconstructing
 * by re-calling getSystemPrompt() can diverge (GrowthBook cold→warm) and
 * bust the prompt cache; threading the rendered bytes is byte-exact.
 */
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  whenToUse:
    'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type when the fork experiment is active.',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
} satisfies BuiltInAgentDefinition

/**
 * 防递归 fork 守卫：扫一遍历史消息，看有没有 fork 的样板标签。
 * 为什么需要运行时守卫而不是只靠工具裁剪：
 * fork 孩子为了保持工具定义字节一致，工具池里**仍然保留** Agent 工具，
 * 所以它可能真的再发起一次 fork。这条消息扫描就是兜底：
 * 只要历史里出现过一次 fork 样板，就说明「我本身就是个 fork 孩子」，拒绝再 fork。
 */
/**
 * Guard against recursive forking. Fork children keep the Agent tool in their
 * tool pool for cache-identical tool definitions, so we reject fork attempts
 * at call time by detecting the fork boilerplate tag in conversation history.
 */
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

// 所有 fork 孩子的 tool_result 都用**同一句**占位文本。
// 这是 cache 共享的关键：如果每个孩子拿到各自真实的结果，请求前缀就不一样了，
// 多孩子并行的成本优势就没了。
/** Placeholder text used for all tool_result blocks in the fork prefix.
 * Must be identical across all fork children for prompt cache sharing. */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

/**
 * 造出 fork 孩子的初始消息。产出结构是：
 *   [ 父级完整 assistant 消息（含所有 tool_use、thinking、text），
 *     一条 user 消息（N 个占位 tool_result + 本孩子的指令） ]
 * 这样多个孩子的前缀（父级 assistant + 占位结果）**字节完全相同**，
 * 只有最后那条指令文本不同 —— cache 命中率最大化。
 *
 * @param directive 派给这个孩子的指令（一句话说清范围）
 * @param assistantMessage 父级那条发起 fork 的 assistant 消息（含多个 Agent tool_use）
 */
/**
 * Build the forked conversation messages for the child agent.
 *
 * For prompt cache sharing, all fork children must produce byte-identical
 * API request prefixes. This function:
 * 1. Keeps the full parent assistant message (all tool_use blocks, thinking, text)
 * 2. Builds a single user message with tool_results for every tool_use block
 *    using an identical placeholder, then appends a per-child directive text block
 *
 * Result: [...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * Only the final text block differs per child, maximizing cache hits.
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
// 浅拷贝父级 assistant 消息并换新 uuid：绝不能改动父级原始对象，
// 否则多个并行 fork 会互相污染（也避免改动主 Agent 自己的对话）
  // Clone the assistant message to avoid mutating the original, keeping all
  // content blocks (thinking, text, and every tool_use)
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],
    },
  }

  // Collect all tool_use blocks from the assistant message
  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

// 父级那条消息里一个 tool_use 都没有（异常路径，比如模型直接输出了 fork 指令）：
// 记一条 error 日志，退化成「只发一条指令」的简单形式
  if (toolUseBlocks.length === 0) {
    logForDebugging(
      `No tool_use blocks found in assistant message for fork directive: ${directive.slice(0, 50)}...`,
      { level: 'error' },
    )
    return [
      createUserMessage({
        content: [
          { type: 'text' as const, text: buildChildMessage(directive) },
        ],
      }),
    ]
  }

// 给每个 tool_use 配一个 tool_result，内容全是同一句占位文本
  // Build tool_result blocks for every tool_use, all with identical placeholder text
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [
      {
        type: 'text' as const,
        text: FORK_PLACEHOLDER_RESULT,
      },
    ],
  }))

  // Build a single user message: all placeholder tool_results + the per-child directive
// 一条 user 消息里装下所有占位结果 + 本孩子的指令。
// 指令放在最后，作为孩子看到的最后一段内容（最重要、最新鲜）。
  // TODO(smoosh): this text sibling creates a [tool_result, text] pattern on the wire
  // (renders as </function_results>\n\nHuman:<text>). One-off per-child construction,
  // not a repeated teacher, so low-priority. If we ever care, use smooshIntoToolResult
  // from src/utils/messages.ts to fold the directive into the last tool_result.content.
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      {
        type: 'text' as const,
        text: buildChildMessage(directive),
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}

/**
 * 给 fork 孩子的指令文本——一份很硬的「行为合同」。
 * 为什么要这么强硬：fork 孩子继承了父级的完整 system prompt，而那份 prompt 里写着
 * 「默认要 fork」。如果不明确告诉它「你就是那个 fork，别再 fork 了」，它会无限套娃。
 * 10 条规则解决三件事：① 别再派生 ② 别寒暄、直接干活 ③ 报告格式固定且简短。
 */
export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT \u2014 that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * fork + worktree 组合时的提示。
 * 需要它的原因：孩子继承的上下文里的路径都是**父级工作目录**的，
 * 而它自己跑在一个独立的 git worktree 里（同仓库、同相对结构、不同工作副本），
 * 路径必须自己翻译；而且父级在它启动之后可能又改过文件，所以改之前要重新读一遍。
 */
/**
 * Notice injected into fork children running in an isolated worktree.
 * Tells the child to translate paths from the inherited context, re-read
 * potentially stale files, and that its changes are isolated.
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`
}
