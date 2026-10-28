/**
 * 【一句话定位】Agent 工具的「工具间」：放那些 AgentTool.tsx 和 resumeAgent.ts 都要用、但又不适合
 * 放进主文件的纯逻辑——工具池裁剪、结果收敛、后台生命周期、进度上报、handoff 安全分类。
 *
 * 【在架构中的位置】
 *   上游：AgentTool.tsx（同步/异步两条路）、resumeAgent.ts（续跑）、UI.tsx（少量）。
 *   下游：
 *     constants/tools.js —— 三张工具禁表（ALL_AGENT_DISALLOWED_TOOLS 等）
 *     tasks/LocalAgentTask/LocalAgentTask.ts —— 进度追踪器、任务状态、完成/失败/通知
 *     services/AgentSummary/agentSummary.ts —— 后台 agent 的周期摘要
 *     utils/permissions/yoloClassifier.ts —— auto 模式下的 handoff 安全分类器
 *   抽出来的目的：AgentTool.tsx 已经 1400 行了，而 resumeAgent.ts 需要**完全相同**的后台流程，
 *   把 runAsyncAgentLifecycle 放这里才能两边共用一份实现。
 *
 * 【本文件包含什么】
 *   - filterToolsForAgent()：按「全局禁表 + 自定义 agent 禁表 + 异步白名单」裁剪工具池。
 *   - resolveAgentTools()：把 agent 定义里的 tools/disallowedTools 字符串解析成真实工具数组。
 *   - agentToolResultSchema / AgentToolResult：子 Agent 最终结果的 schema 与类型。
 *   - countToolUses() / finalizeAgentTool()：统计工具调用次数并把整段对话收敛成最终结果。
 *   - getLastToolUseName() / emitTaskProgress()：取最后用的工具名、把进度推给 SDK。
 *   - classifyHandoffIfNeeded()：子 Agent 交还控制权时，用分类器审一遍它的行为是否违规。
 *   - extractPartialResult()：被杀掉的 agent 也要把已完成的部分文本捞回来。
 *   - runAsyncAgentLifecycle()：后台 agent 从启动到发出完成通知的完整生命周期。
 *
 * 【子 Agent 的工具是怎么被裁剪的】(本文件最值得看的一段)
 *   三道过滤，按顺序：
 *   ① ALL_AGENT_DISALLOWED_TOOLS：所有子 Agent 都不能用（典型是 Agent/Task 本身——
 *      默认不允许子 Agent 再生子 Agent，避免无限套娃）。
 *   ② CUSTOM_AGENT_DISALLOWED_TOOLS：只对非内置 agent 生效（用户自己写的 agent 额外禁一批）。
 *   ③ ASYNC_AGENT_ALLOWED_TOOLS：异步 agent 走**白名单**，不在名单里的一律砍掉
 *      （异步 agent 没人看着，权限面要小）。
 *   两个豁免：mcp__ 开头的 MCP 工具一律放行；plan 模式下的 ExitPlanMode 放行。
 *   另外 in-process teammate 额外放行 Agent 工具和 task 工具（它要能协调共享任务列表）。
 *   然后再叠加 agent 定义自己的 tools（白名单）/ disallowedTools（黑名单）。
 *
 * 【TS 语法速查】(针对本文件实际出现的语法)
 *   - `Pick<AgentDefinition, 'tools' | 'disallowedTools' | ...>` 工具类型：
 *     从一个大类型里只挑几个字段组成新类型 ≈ 「只依赖我关心的那几个属性」，
 *     好处是调用方传一个完整 AgentDefinition 也能通过（结构化鸭子类型，见下）。
 *   - 结构化（鸭子）类型：TS 不看类名，只看形状。只要有那几个字段就兼容，
 *     ≈ Java 的 interface 但**不需要** implements 声明，是隐式的。
 *   - `type X = { ... }` ≈ Java record，但更灵活（可选字段、联合类型、索引签名都行）。
 *   - `Set<A> / Map<K,V>` 与 Java 同名同类；`new Set(arr)` ≈ new HashSet<>(Arrays.asList(arr))。
 *   - `arr.filter(fn)` / `arr.map(fn)` / `arr.some(fn)` / `arr.every(fn)`：
 *     ≈ Stream.filter / map / anyMatch / allMatch。
 *   - `arr.findLast(fn)`：从后往前找第一个匹配的（Java 没有直接对应，得倒着遍历）。
 *   - `arr.at(-1)`：取最后一个元素，负索引从末尾数（Java 的 list.get(size-1)）。
 *   - `??` 空值合并：只在 null/undefined 时取右边（0 和 '' 不会被替换，与 || 的关键区别）。
 *   - `??=` 逻辑赋值：`a ??= b` ≈ `if (a == null) a = b`。
 *   - `?.()` 可选调用：`fn?.()` 只有 fn 不是 null/undefined 时才调用。
 *   - `!` 后缀非空断言：`messages[i]!` 告诉编译器「我保证这个下标有值」
 *     （TS 默认不认为 arr[i] 一定存在，除非开 noUncheckedIndexedAccess）。
 *   - `x is T` 类型谓词 ≈ instanceof 模式匹配（见 AgentTool.tsx 头部说明）。
 *   - `{ ...obj, k: v }` 展开 = 不可变更新；`{ ...(cond && { k: v }) }` 是条件展开：
 *     cond 为 false 时展开 `false`，展开 false 等于什么都不加（很常用的技巧）。
 *   - `as unknown as X` / `as X`：强制转换；`as` 不做运行时检查，只是骗过编译器。
 *   - `async function` + `await` ≈ Java 的 CompletableFuture + join，但语法上像同步代码。
 *   - `for await (const x of gen)` ≈ Flux 的顺序消费（配合 async generator）。
 *   - `error instanceof AbortError` 和 Java 的 instanceof 完全一样。
 *   - `function f(a: T = defaultValue)`：默认参数，≈ Java 的重载省略版。
 *   - `let x: (() => void) | undefined`：类型为「无参无返回的函数 或 undefined」，
 *     `() => void` 就是 Java 的 Runnable。
 *   - 三元嵌套 `a ? b : c ? d : e` 在 TS 里很常见（本文件多处），等价于 else-if 链。
 */
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import type { AppState } from '../../state/AppState.js'
import type {
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import {
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  type ProgressTracker,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import type { Message as MessageType } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { isInProtectedNamespace } from '../../utils/envUtils.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import {
  buildTranscriptForClassifier,
  classifyYoloAction,
} from '../../utils/permissions/yoloClassifier.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/sdkProgress.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
// 工具解析结果：hasWildcard 表示用了 '*'（全部允许），
// validTools/invalidTools 用于给模型反馈「你写的工具名哪些是无效的」，
// allowedAgentTypes 是从 `Agent(worker, researcher)` 这种语法里解析出的可派生 agent 类型列表。
export type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}

/**
 * 按三张全局禁表裁剪工具池——这是「子 Agent 不能用哪些工具」的第一道闸。
 * 顺序：MCP 工具一律放行 → plan 模式的 ExitPlanMode 放行 → 全局禁表 → 自定义 agent 禁表 → 异步白名单。
 * @param isBuiltIn 是否内置 agent（内置的可信度高，少禁一些）
 * @param isAsync 是否异步（异步走白名单，砍得最狠）
 * @param permissionMode 用于豁免 plan 模式下的 ExitPlanMode
 */
export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
}): Tools {
// 箭头函数 ≈ Java lambda：`tool => {...}` 等价 `(tool) -> {...}`
  return tools.filter(tool => {
    // Allow MCP tools for all agents
// MCP 工具（名字以 mcp__ 开头）一律放行——它们是用户/插件显式配的，不在禁表管辖范围
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // Allow ExitPlanMode for agents in plan mode (e.g., in-process teammates)
    // This bypasses both the ALL_AGENT_DISALLOWED_TOOLS and async tool filters
// 豁免：plan 模式下的 agent 需要 ExitPlanMode 来交计划，
// 这一条要同时绕过全局禁表和异步白名单，所以放在所有判断之前
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_V2_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
// 异步 agent 走白名单：不在 ASYNC_AGENT_ALLOWED_TOOLS 里的一律砍掉。
// 理由：后台跑没人盯着，权限面必须最小。
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        // Allow AgentTool for in-process teammates to spawn sync subagents.
        // Validation in AgentTool.call() prevents background agents and teammate spawning.
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) {
          return true
        }
        // Allow task tools for in-process teammates to coordinate via shared task list
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) {
          return true
        }
      }
      return false
    }
    return true
  })
}

/**
 * 把 agent 定义里的 tools / disallowedTools 字符串数组解析成真正的工具对象数组。
 * 支持两种写法：
 *   - `tools: ['*']` 或干脆不写 → 全部允许（前面已按禁表过滤过）
 *   - `tools: ['Read', 'Bash', 'Agent(worker, researcher)']` → 白名单，且解析出允许的 agent 类型
 * @param isMainThread 主线程时跳过禁表过滤（主线程的工具池本来就由 useMergedTools 正确组装好了）
 */
/**
 * Resolves and validates agent tools against available tools
 * Handles wildcard expansion and validation in one place
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {
  const {
    tools: agentTools,
    disallowedTools,
    source,
    permissionMode,
  } = agentDefinition
// 主线程不做子 Agent 那套裁剪——主线程工具池是完整且正确的，套用禁表反而会误伤
  // When isMainThread is true, skip filterToolsForAgent entirely — the main
  // thread's tool pool is already properly assembled by useMergedTools(), so
  // the sub-agent disallow lists shouldn't apply.
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
      })

  // Create a set of disallowed tool names for quick lookup
// disallowedTools 里写的是形如 'Bash(git commit:*)' 的规则串，这里只取括号前的工具名
  const disallowedToolSet = new Set(
    disallowedTools?.map(toolSpec => {
      const { toolName } = permissionRuleValueFromString(toolSpec)
      return toolName
    }) ?? [],
  )

  // Filter available tools based on disallowed list
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !disallowedToolSet.has(tool.name),
  )

// `tools` 不写或写 ['*'] 都视为「全允许」
  // If tools is undefined or ['*'], allow all tools (after filtering disallowed)
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    }
  }

  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolved: Tool[] = []
  const resolvedToolsSet = new Set<Tool>()
  let allowedAgentTypes: string[] | undefined

// 每条规则串形如 'Bash(rm:*)'，permissionRuleValueFromString 拆出工具名和权限模式
  for (const toolSpec of agentTools) {
    // Parse the tool spec to extract the base tool name and any permission pattern
    const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)

    // Special case: Agent tool carries allowedAgentTypes metadata in its spec
// 特例：`Agent(worker, researcher)` 这种写法不是工具限制，而是「允许派生哪些 agent 类型」
    if (toolName === AGENT_TOOL_NAME) {
      if (ruleContent) {
        // Parse comma-separated agent types: "worker, researcher" → ["worker", "researcher"]
        allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
      }
      // For sub-agents, Agent is excluded by filterToolsForAgent — mark the spec
      // valid for allowedAgentTypes tracking but skip tool resolution.
// 子 Agent 的 Agent 工具已被 filterToolsForAgent 剔除，这里只登记 allowedAgentTypes 不加入工具池
      if (!isMainThread) {
        validTools.push(toolSpec)
        continue
      }
      // For main thread, filtering was skipped so Agent is in availableToolMap —
      // fall through to normal resolution below.
    }

    const tool = availableToolMap.get(toolName)
    if (tool) {
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else {
      invalidTools.push(toolSpec)
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools: resolved,
    allowedAgentTypes,
  }
}

/**
 * 子 Agent 最终结果的 zod schema。
 * agentType 是可选的（老会话落盘的结果没有这个字段，resume 时是原样重放不做校验），
 * 它用来决定「一次性内置 agent（Explore/Plan）」要不要省掉 SendMessage 提示尾巴。
 */
export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    // Optional: older persisted sessions won't have this (resume replays
    // results verbatim without re-validation). Used to gate the sync
    // result trailer — one-shot built-ins skip the SendMessage hint.
    agentType: z.string().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable(),
      cache_read_input_tokens: z.number().nullable(),
      server_tool_use: z
        .object({
          web_search_requests: z.number(),
          web_fetch_requests: z.number(),
        })
        .nullable(),
      service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cache_creation: z
        .object({
          ephemeral_1h_input_tokens: z.number(),
          ephemeral_5m_input_tokens: z.number(),
        })
        .nullable(),
    }),
  }),
)

export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>

/**
 * 统计整段对话里子 Agent 一共用了多少次工具（数 assistant 消息里的 tool_use 块）。
 */
export function countToolUses(messages: MessageType[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') {
          count++
        }
      }
    }
  }
  return count
}

/**
 * 把子 Agent 攒下的所有消息收敛成一个 AgentToolResult——这是「结果回传给主 Agent」的核心一步。
 * 关键步骤：
 *   ① 取最后一条 assistant 消息的文本当 content
 *   ② 如果最后一条是纯 tool_use（循环在半轮被打断），往前找最近一条**带文本**的 assistant 消息兜底
 *   ③ 统计 token、工具调用次数、耗时
 *   ④ 埋点 tengu_agent_tool_completed，并发一条 cache eviction 提示（子 Agent 结束了，它的 cache 链可以回收）
 * @throws 一条 assistant 消息都没有时抛错（说明子 Agent 压根没跑起来）
 */
export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
  },
): AgentToolResult {
  const {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent,
    startTime,
    agentType,
    isAsync,
  } = metadata

// getLastAssistantMessage：取最后一条 assistant 消息（≈ 倒着遍历找第一个 type==='assistant'）
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }
// 兜底逻辑：最后一条 assistant 可能只有 tool_use 没有文本（比如刚发出工具调用就被打断），
// 这时往回找最近一条带文本的，否则主 Agent 会收到一个空结果。
  // Extract text content from the agent's response. If the final assistant
  // message is a pure tool_use block (loop exited mid-turn), fall back to
  // the most recent assistant message that has text content.
  let content = lastAssistantMessage.message.content.filter(
    _ => _.type === 'text',
  )
  if (content.length === 0) {
    for (let i = agentMessages.length - 1; i >= 0; i--) {
      const m = agentMessages[i]!
      if (m.type !== 'assistant') continue
      const textBlocks = m.message.content.filter(_ => _.type === 'text')
      if (textBlocks.length > 0) {
        content = textBlocks
        break
      }
    }
  }

  const totalTokens = getTokenCountFromUsage(lastAssistantMessage.message.usage)
  const totalToolUseCount = countToolUses(agentMessages)

  logEvent('tengu_agent_tool_completed', {
    agent_type:
      agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_char_count: prompt.length,
    response_char_count: content.length,
    assistant_message_count: agentMessages.length,
    total_tool_uses: totalToolUseCount,
    duration_ms: Date.now() - startTime,
    total_tokens: totalTokens,
    is_built_in_agent: isBuiltInAgent,
    is_async: isAsync,
  })

  // Signal to inference that this subagent's cache chain can be evicted.
  const lastRequestId = lastAssistantMessage.requestId
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'subagent_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  return {
    agentId,
    agentType,
    content,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message.usage,
  }
}

/**
 * 取一条 assistant 消息里最后一个 tool_use 块的工具名。
 * 用于进度上报——告诉 UI/SDK「子 Agent 现在正在跑哪个工具」。
 * @returns 工具名；不是 assistant 消息或没有 tool_use 时返回 undefined
 */
/**
 * Returns the name of the last tool_use block in an assistant message,
 * or undefined if the message is not an assistant message with tool_use.
 */
export function getLastToolUseName(message: MessageType): string | undefined {
  if (message.type !== 'assistant') return undefined
  const block = message.message.content.findLast(b => b.type === 'tool_use')
  return block?.type === 'tool_use' ? block.name : undefined
}

/**
 * 把当前进度推给 SDK（VS Code 的子 Agent 面板等）。
 * 描述优先用「最近一次活动的可读描述」（比如 `Read src/a.ts`），没有才退回原始的 description。
 */
export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
): void {
  const progress = getProgressUpdate(tracker)
  emitTaskProgressEvent({
    taskId,
    toolUseId,
    description: progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: progress.tokenCount,
    toolUses: progress.toolUseCount,
    lastToolName,
  })
}

/**
 * handoff 安全检查：子 Agent 干完活把控制权交回主 Agent 时，审一遍它做过的事有没有违规。
 * 只在 auto 模式（permissionMode === 'auto'）下才跑。
 * 为什么要这一步：auto 模式下主 Agent 是自动放行的，如果子 Agent 偷偷做了危险操作，
 * 主 Agent 拿到结果就去执行，等于绕过了审查。
 * @returns 需要警告时返回一段警告文本（会被拼到结果最前面），没问题返回 null
 */
export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
}: {
  agentMessages: MessageType[]
  tools: Tools
  toolPermissionContext: AppState['toolPermissionContext']
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
}): Promise<string | null> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
// 非 auto 模式不审——其它模式本来就有权限框/规则把关
    if (toolPermissionContext.mode !== 'auto') return null

    const agentTranscript = buildTranscriptForClassifier(agentMessages, tools)
    if (!agentTranscript) return null

    const classifierResult = await classifyYoloAction(
      agentMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: "Sub-agent has finished and is handing back control to the main agent. Review the sub-agent's work based on the block rules and let the main agent know if any file is dangerous (the main agent will see the reason).",
          },
        ],
      },
      tools,
      toolPermissionContext as ToolPermissionContext,
      abortSignal,
    )

// 三种结论：分类器不可用（unavailable）/ 判定拦截（blocked）/ 放行（allowed）
    const handoffDecision = classifierResult.unavailable
      ? 'unavailable'
      : classifierResult.shouldBlock
        ? 'blocked'
        : 'allowed'
    logEvent('tengu_auto_mode_decision', {
      decision:
        handoffDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName:
        // Use legacy name for analytics continuity across the Task→Agent rename
        LEGACY_AGENT_TOOL_NAME as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inProtectedNamespace: isInProtectedNamespace(),
      classifierModel:
        classifierResult.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agentType:
        subagentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolUseCount: totalToolUseCount,
      isHandoff: true,
      // For handoff, the relevant agent completion is the subagent's final
      // assistant message — the last thing the classifier transcript shows
      // before the handoff review prompt.
      agentMsgId: getLastAssistantMessage(agentMessages)?.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage:
        classifierResult.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1RequestId:
        classifierResult.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1MsgId:
        classifierResult.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2RequestId:
        classifierResult.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2MsgId:
        classifierResult.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

// 分类器不可用时的处理很关键：不能因为分类器挂了就把子 Agent 的成果全丢掉，
// 而是照常返回 + 附一句「分类器不可用，请人工复核」的警告。
// 真被判定拦截时，返回的文本前面带 SECURITY WARNING，让主 Agent 明确看到风险。
    if (classifierResult.shouldBlock) {
      // When classifier is unavailable, still propagate the sub-agent's
      // results but with a warning so the parent agent can verify the work.
      if (classifierResult.unavailable) {
        logForDebugging(
          'Handoff classifier unavailable, allowing sub-agent output with warning',
          { level: 'warn' },
        )
        return `Note: The safety classifier was unavailable when reviewing this sub-agent's work. Please carefully verify the sub-agent's actions and output before acting on them.`
      }

      logForDebugging(
        `Handoff classifier flagged sub-agent output: ${classifierResult.reason}`,
        { level: 'warn' },
      )
      return `SECURITY WARNING: This sub-agent performed actions that may violate security policy. Reason: ${classifierResult.reason}. Review the sub-agent's actions carefully before acting on its output.`
    }
  }

  return null
}

/**
 * 从已攒下的消息里倒着找最近一段有文本的内容。
 * 用于异步 agent 被 kill 时把「已经做到的部分」捞回来，不至于让用户白等一场。
 */
/**
 * Extract a partial result string from an agent's accumulated messages.
 * Used when an async agent is killed to preserve what it accomplished.
 * Returns undefined if no text content is found.
 */
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) {
      return text
    }
  }
  return undefined
}

// setAppState 的类型别名：`(prev: AppState) => AppState` 是 React 风格的函数式更新，
// 传新值而不是改旧值（不可变更新）
type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * 后台 agent 的完整生命周期：从启动流到最后发出完成通知。
 * AgentTool 的「一开始就异步」和 resumeAgent 的续跑**共用这一个实现**，
 * 保证两条路的进度上报、状态流转、通知格式完全一致。
 *
 * 关键步骤：
 *   ① 建进度追踪器，按开关决定是否挂周期摘要（startAgentSummarization）
 *   ② for-await 消费消息流，逐条：追加到 AppState（若 UI 持有该任务）、更新进度、上报 task_progress
 *   ③ 流结束后 finalizeAgentTool 收敛结果
 *   ④ **先**标记任务完成，再做 handoff 分类和 worktree 清理（这两步可能卡住，绝不能挡住状态流转）
 *   ⑤ 发 enqueueAgentNotification，把最终文本 + 用量塞进通知
 *   ⑥ catch：AbortError 走 killed（带部分结果），其它走 failed
 *   ⑦ finally：清 skills 缓存和 dumpState
 *
 * @param makeStream 工厂函数：传入 onCacheSafeParams 回调，返回一个异步消息流
 *       （做成工厂而不是直接传流，是因为摘要开关要在建流之前就知道）
 * @param getWorktreeResult 清理 worktree 并回传路径/分支（由调用方注入，本文件不关心 git 细节）
 */
/**
 * Drives a background agent from spawn to terminal notification.
 * Shared between AgentTool's async-from-start path and resumeAgentBackground.
 */
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams) => void) | undefined,
  ) => AsyncGenerator<MessageType, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
}): Promise<void> {
  let stopSummarization: (() => void) | undefined
  const agentMessages: MessageType[] = []
  try {
    const tracker = createProgressTracker()
    const resolveActivity = createActivityDescriptionResolver(
      toolUseContext.options.tools,
    )
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams) => {
          const { stop } = startAgentSummarization(
            taskId,
            asAgentId(taskId),
            params,
            rootSetAppState,
          )
          stopSummarization = stop
        }
      : undefined
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
// 若 UI 正持有这个任务（retain=true），把消息即时追加进 AppState.tasks，让面板能实时看到。
// 之所以能安全地「先落盘再 yield」：落盘早于 yield，磁盘上永远是磁盘内容的后缀，
// bootstrap 并行读盘时按 uuid 合并前缀，顺序一定是正确的。
// 又是一次不可变更新：复制 prev → 复制 tasks → 覆盖这一个 task。
      // Append immediately when UI holds the task (retain). Bootstrap reads
      // disk in parallel and UUID-merges the prefix — disk-write-before-yield
      // means live is always a suffix of disk, so merge is order-correct.
      rootSetAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || !t.retain) return prev
        const base = t.messages ?? []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...t, messages: [...base, message] },
          },
        }
      })
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      updateAsyncAgentProgress(
        taskId,
        getProgressUpdate(tracker),
        rootSetAppState,
      )
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
        )
      }
    }

    stopSummarization?.()

    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)

// 顺序很重要（gh-20236）：先切 completed，TaskOutput(block=true) 才能立刻解除阻塞。
// classifyHandoffIfNeeded（调 API）和 getWorktreeResult（跑 git）都可能卡住，
// 它们只是通知的润色，绝不能挡住状态流转。
    // Mark task completed FIRST so TaskOutput(block=true) unblocks
    // immediately. classifyHandoffIfNeeded (API call) and getWorktreeResult
    // (git exec) are notification embellishments that can hang — they must
    // not gate the status transition (gh-20236).
    completeAsyncAgent(agentResult, rootSetAppState)

    let finalMessage = extractTextContent(agentResult.content, '\n')

    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const handoffWarning = await classifyHandoffIfNeeded({
        agentMessages,
        tools: toolUseContext.options.tools,
        toolPermissionContext:
          toolUseContext.getAppState().toolPermissionContext,
        abortSignal: abortController.signal,
        subagentType: metadata.agentType,
        totalToolUseCount: agentResult.totalToolUseCount,
      })
      if (handoffWarning) {
        finalMessage = `${handoffWarning}\n\n${finalMessage}`
      }
    }

    const worktreeResult = await getWorktreeResult()

    enqueueAgentNotification({
      taskId,
      description,
      status: 'completed',
      setAppState: rootSetAppState,
      finalMessage,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: agentResult.totalToolUseCount,
        durationMs: agentResult.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } catch (error) {
    stopSummarization?.()
// killAsyncAgent 在 TaskStop 已经把状态设成 killed 时是 no-op，
// 但**只有这个 catch 块**手里有 agentMessages，所以通知必须无条件发出（不能因为状态已变就不发）。
// 同样先切状态再清 worktree，防止 git 卡住导致 TaskOutput 一直阻塞。
    if (error instanceof AbortError) {
      // killAsyncAgent is a no-op if TaskStop already set status='killed' —
      // but only this catch handler has agentMessages, so the notification
      // must fire unconditionally. Transition status BEFORE worktree cleanup
      // so TaskOutput unblocks even if git hangs (gh-20236).
      killAsyncAgent(taskId, rootSetAppState)
      logEvent('tengu_agent_tool_terminated', {
        agent_type:
          metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: Date.now() - metadata.startTime,
        is_async: true,
        is_built_in_agent: metadata.isBuiltInAgent,
        reason:
          'user_kill_async' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const worktreeResult = await getWorktreeResult()
      const partialResult = extractPartialResult(agentMessages)
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        ...worktreeResult,
      })
      return
    }
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    const worktreeResult = await getWorktreeResult()
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: msg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
// finally：清掉这个 agent 攒下的 skills 缓存和 dumpState 条目，防止无限增长
  } finally {
    clearInvokedSkillsForAgent(agentIdForCleanup)
    clearDumpState(agentIdForCleanup)
  }
}
