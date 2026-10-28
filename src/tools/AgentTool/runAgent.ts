/**
 * 【一句话定位】真正「跑」一个子 Agent 的地方：为子 Agent 造一套独立的上下文（system prompt /
 * 工具池 / 权限 / MCP / skills），然后开一个自己的 query 循环，并把产生的消息一条条 yield 出来。
 *
 * 【在架构中的位置】
 *   上游：AgentTool.tsx 的 call()（同步和异步两条路都走这里）、resumeAgent.ts（续跑也走这里）。
 *   下游：
 *     query.ts —— 复用主 Agent 那一套主循环（发请求、跑工具、再发请求）
 *     utils/forkedAgent.ts 的 createSubagentContext() —— 由父级 ToolUseContext 派生子上下文
 *     agentToolUtils.ts 的 resolveAgentTools() —— 按 agent 定义裁剪工具池
 *     utils/sessionStorage.ts 的 recordSidechainTranscript() —— 把对话落盘（resume 的基础）
 *   注意：本文件**不** import tools.ts（会造成循环依赖），工具池由调用方算好从 availableTools 传进来。
 *
 * 【本文件包含什么】
 *   - initializeAgentMcpServers()：连接 agent frontmatter 里声明的专属 MCP server，并返回清理函数。
 *   - QueryMessage / isRecordableMessage()：判断 query() 吐出的哪些消息值得落盘。
 *   - runAgent()：主函数，async generator（异步生成器），逐条 yield 子 Agent 产生的消息。
 *   - filterIncompleteToolCalls()：剔除「有 tool_use 但没有 tool_result」的孤儿消息。
 *   - getAgentSystemPrompt()：拼出子 Agent 的 system prompt（agent 自己的 + 环境信息）。
 *   - resolveSkillName()：把 frontmatter 里写的 skill 名解析成已注册的命令名（含插件命名空间）。
 *
 * 【子 Agent 是怎么被隔离的】(对应本文件的关键代码)
 *   - 上下文隔离：createSubagentContext() 派生出新的 ToolUseContext，带自己的 agentId / messages /
 *     readFileState。异步 agent 连 abortController 都是全新的（不跟父级联动），同步 agent 则共享父级的。
 *   - 工具隔离：resolveAgentTools() 按 agent 定义的 tools / disallowedTools 过滤，再叠加三张全局禁表
 *     （所有 agent 都不能用某些工具；自定义 agent 额外禁用一批；异步 agent 只能用白名单里的）。
 *   - 权限隔离：agentGetAppState() 造一个「改过 permissionMode 的」appState 副本，
 *     父级是 bypassPermissions / acceptEdits 时不覆盖（更宽松的优先）。
 *   - 提示词隔离：子 Agent 用**自己的** system prompt；只有 fork 路径会传入父级的（override.systemPrompt）。
 *   - 记忆隔离：readFileState 用 cloneFileStateCache 克隆一份（fork）或新建一份带上限的（普通），
 *     子 Agent 读过哪些文件不污染父级。
 *   - 瘦身：Explore / Plan 这类只读 agent 会丢掉 CLAUDE.md 和 gitStatus（省 token，每周几十 Gtok）。
 *
 * 【TS 语法速查】(针对本文件实际出现的语法)
 *   - `export async function* runAgent(...)`：`async function*` = 异步生成器，
 *     既能 await 又能 yield，返回 AsyncGenerator<T>。≈ Java 里没有的直接对应，
 *     最接近的是 Reactor 的 Flux.generate()：调用方用 `for await (const x of it)` 逐条消费。
 *   - `yield x`：产出一条消息并**暂停**在这里，直到调用方要下一条才继续往下执行。
 *     这是「边跑边把进度推给上层」的关键（主 Agent 才能实时显示子 Agent 在干嘛）。
 *   - `for await (const x of asyncIterable)`：异步版的 for-each，≈ Flux.subscribe 的顺序消费。
 *   - `Promise.all([a, b])` ≈ CompletableFuture.allOf，并发等两个异步操作，返回数组。
 *   - 解构时忽略字段：`const { claudeMd: _omitted, ...rest } = obj` —— 把 claudeMd 赋给一个
 *     下划线开头的临时变量（表示「故意不用」），其余全部收进 rest。≈ 从 Map 里 remove 后再用。
 *   - `A | B` 联合类型 ≈ sealed interface；`msg is A | B | C` 类型谓词 ≈ instanceof 模式匹配。
 *   - `Pick<ToolUseContext, 'options'>` 工具类型：从 T 里只挑 'options' 这个键，
 *     ≈ 「只依赖某个大对象的一个字段」，降低耦合。
 *   - `Parameters<typeof runAgent>[0]`：取函数第一个参数的类型（typeof 在类型位置 = 取函数签名）。
 *   - `?:` 可选属性 / `??` 空值合并 / `?.` 可选链：见 AgentTool.tsx 头部的说明。
 *   - `as const`：`{ type: 'disabled' as const }` 把 'disabled' 锁成字面量类型而非 string。
 *   - `void promise.catch(...)`：fire-and-forget。`void` 运算符表示「故意丢弃返回值」，
 *     .catch 是必须的，否则失败会变成 unhandled rejection 让进程崩掉。
 *   - `initialMessages.length = 0`：把数组长度置 0 = 清空并释放引用（帮助 GC 回收克隆的 fork 上下文）。
 *   - `Object.entries(obj)` ≈ map.entrySet()；`Array.from(set)` ≈ new ArrayList<>(set)。
 *   - `feature('X')` 是编译期 #ifdef（见 AgentTool.tsx 头部说明），不是运行时 if。
 *   - `switch` + `case` 在 TS 里没有 fall-through 限制但同样要 break；本文件用它配合联合类型做穷尽处理。
 */
import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

/**
 * 连接 agent frontmatter 里声明的专属 MCP server（对父级已有的 MCP client 是**叠加**关系）。
 * 为什么需要：某些 agent 只想额外挂一两个 server（比如 code-review 要挂 slack），
 * 不该为了它把父级 MCP 全量搬过来，也不该让父级被它污染。
 *
 * @param agentDefinition agent 定义，含可选的 mcpServers（字符串=按名字引用已配置的；对象=内联定义）
 * @param parentClients 父级已有的 MCP 连接
 * @returns clients（父级+本 agent 的）、tools（本 agent 专属 server 提供的工具）、cleanup（清理函数）
 */
/**
 * Initialize agent-specific MCP servers
 * Agents can define their own MCP servers in their frontmatter that are additive
 * to the parent's MCP clients. These servers are connected when the agent starts
 * and cleaned up when the agent finishes.
 *
 * @param agentDefinition The agent definition with optional mcpServers
 * @param parentClients MCP clients inherited from parent context
 * @returns Merged clients (parent + agent-specific), agent MCP tools, and cleanup function
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // If no agent-specific servers defined, return parent clients as-is
// 没有声明专属 server，原样返回父级的（不是返回空数组——父级的 MCP 子 Agent 照样能用）
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

// 安全策略：MCP 被锁成「只用插件提供的」时，只拦**用户自己写的** agent 的 frontmatter MCP。
// 插件 / 内置 / 策略下发的 agent 属于管理员信任范围，它们的 frontmatter MCP 是审批过的一部分，
// 拦掉的话插件 agent 就废了（与「插件提供的总是加载」这条原则冲突）。
  // When MCP is locked to plugin-only, skip frontmatter MCP servers for
  // USER-CONTROLLED agents only. Plugin, built-in, and policySettings agents
  // are admin-trusted — their frontmatter MCP is part of the admin-approved
  // surface. Blocking them (as the first cut did) breaks plugin agents that
  // legitimately need MCP, contradicting "plugin-provided always loads."
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
// 区分「新建的」和「从父级共享的」：只有内联定义的（新建的）才需要在结束时清理，
// 按名字引用的走的是全局 memoize 的连接，父级还在用，关掉会出事。
  // Track which clients were newly created (inline definitions) vs. shared from parent
  // Only newly created clients should be cleaned up when the agent finishes
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

// 形式一：字符串 = 引用一个已经在设置里配好的 server（走 memoize 的 connectToServer，可能拿到共享连接）
    if (typeof spec === 'string') {
      // Reference by name - look up in existing MCP configs
      // This uses the memoized connectToServer, so we may get a shared client
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
// 形式二：对象 = 内联定义 { 名字: 配置 }，是 agent 专属的，结束时必须清理
    } else {
      // Inline definition as { [name]: config }
      // These are agent-specific servers that should be cleaned up
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
// `entries[0]!` 的 `!` 是非空断言：上面已判断 length===1，但 TS 不知道，用它强行消掉 undefined
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // Connect to the server
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // Fetch tools if connected
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // Create cleanup function for agent-specific servers
  // Only clean up newly created clients (inline definitions), not shared/referenced ones
  // Shared clients (referenced by string name) are memoized and used by the parent context
// 只清理新建的 client。共享的（按名字引用的）是 memoized 的，父级还在用。
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // Return merged clients (parent + agent-specific) and agent tools
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

// query() 吐出来的 message 是个大联合类型（含流式事件、tombstone 等），
// 这里列出所有可能的成员，下面用类型谓词过滤出值得落盘的那些。
type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * 类型谓词：判断一条 query() 消息是否值得记录到 transcript。
 * `msg is A | B | C` 这种返回类型是 TS 的类型谓词：函数返回 true 后，
 * TS 会在作用域内自动把 msg 收窄成 A|B|C（≈ Java 的 instanceof 模式匹配）。
 * 只记 assistant / user / progress / compact_boundary，其它（流式 delta 等）丢弃。
 */
/**
 * Type guard to check if a message from query() is a recordable Message type.
 * Matches the types we want to record: assistant, user, progress, or system compact_boundary.
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

/**
 * 跑一个子 Agent。这是 async generator：调用方用 `for await` 逐条拿到它产生的消息，
 * 因此可以「边跑边看」，而不是等它全部结束才拿到结果。
 *
 * 关键步骤：
 *   ① 解析模型、生成 agentId、注册 perfetto 追踪
 *   ② 组装初始消息：fork 上下文（若传了）+ promptMessages；并过滤掉孤儿 tool_use
 *   ③ 解析 userContext / systemContext（并对只读 agent 做 CLAUDE.md / gitStatus 瘦身）
 *   ④ 造 agentGetAppState()：按 agent 定义改写 permissionMode、shouldAvoidPermissionPrompts、allow 规则
 *   ⑤ 裁剪工具池 resolveAgentTools()，拼 system prompt（或直接用 override 传入的）
 *   ⑥ 决定 abortController：异步用全新的（不跟父级联动），同步共享父级的
 *   ⑦ 跑 SubagentStart 钩子、注册 frontmatter hooks、预加载 skills、连专属 MCP
 *   ⑧ createSubagentContext() 造子上下文 → 落盘初始消息 → 进 query() 循环，逐条 yield
 *   ⑨ finally 里统一清理：MCP、session hooks、cache 追踪、fileState、perfetto、todos、后台 shell 任务
 *
 * @param agentDefinition 选中要跑的 agent 定义
 * @param promptMessages 初始 prompt 消息（普通路径通常就是一条 user message）
 * @param toolUseContext 父级上下文，用来派生子上下文
 * @param isAsync 是否后台运行（影响 abortController、是否弹权限框等）
 * @param forkContextMessages fork 路径下传入的父级完整对话；普通路径为 undefined
 * @param availableTools 调用方（AgentTool.tsx）预先算好的工具池
 * @param useExactTools fork 路径专用：直接用 availableTools 不过滤，并且继承父级 thinkingConfig
 * @param worktreePath / description 会写进 metadata，供 resume 还原 cwd 和通知文案
 * @returns AsyncGenerator<Message, void>，逐条产出子 Agent 的消息
 */
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** Whether this agent can show permission prompts. Defaults to !isAsync.
   * Set to true for in-process teammates that run async but share the terminal. */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** Preserve toolUseResult on messages for subagents with viewable transcripts */
  preserveToolUseResults?: boolean
  /** Precomputed tool pool for the worker agent. Computed by the caller
   * (AgentTool.tsx) to avoid a circular dependency between runAgent and tools.ts.
   * Always contains the full tool pool assembled with the worker's own permission
   * mode, independent of the parent's tool restrictions. */
  availableTools: Tools
  /** Tool permission rules to add to the agent's session allow rules.
   * When provided, replaces ALL allow rules so the agent only has what's
   * explicitly listed (parent approvals don't leak through). */
  allowedTools?: string[]
  /** Optional callback invoked with CacheSafeParams after constructing the agent's
   * system prompt, context, and tools. Used by background summarization to fork
   * the agent's conversation for periodic progress summaries. */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** Replacement state reconstructed from a resumed sidechain transcript so
   * the same tool results are re-replaced (prompt cache stability). When
   * omitted, createSubagentContext clones the parent's state. */
  contentReplacementState?: ContentReplacementState
  /** When true, use availableTools directly without filtering through
   * resolveAgentTools(). Also inherits the parent's thinkingConfig and
   * isNonInteractiveSession instead of overriding them. Used by the fork
   * subagent path to produce byte-identical API request prefixes for
   * prompt cache hits. */
  useExactTools?: boolean
  /** Worktree path if the agent was spawned with isolation: "worktree".
   * Persisted to metadata so resume can restore the correct cwd. */
  worktreePath?: string
  /** Original task description from AgentTool input. Persisted to metadata
   * so a resumed agent's notification can show the original description. */
  description?: string
  /** Optional subdirectory under subagents/ to group this agent's transcript
   * with related ones (e.g. workflows/<runId> for workflow subagents). */
  transcriptSubdir?: string
  /** Optional callback fired on every message yielded by query() — including
   * stream_event deltas that runAgent otherwise drops. Use to detect liveness
   * during long single-block streams (e.g. thinking) where no assistant
   * message is yielded for >60s. */
  onQueryProgress?: () => void
}): AsyncGenerator<Message, void> {
  // Track subagent usage for feature discovery

// 通往**根** AppState store 的写通道。为什么要单开一条：当父级自己也是异步 agent 时，
// toolUseContext.setAppState 会退化成 no-op（嵌套 async→async），
// 那些要写到 session 级的东西（hooks、bash 任务）必须走 setAppStateForTasks 才能生效。
  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // Always-shared channel to the root AppState store. toolUseContext.setAppState
  // is a no-op when the *parent* is itself an async agent (nested async→async),
  // so session-scoped writes (hooks, bash tasks) must go through this instead.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

// agentId 优先用 override 传进来的（异步任务的 id 要在注册时就定好），否则现生成一个
  const agentId = override?.agentId ? override.agentId : createAgentId()

  // Route this agent's transcript into a grouping subdirectory if requested
  // (e.g. workflow subagents write to subagents/workflows/<runId>/).
// 可以把这个 agent 的 transcript 归到某个子目录下（比如 workflow 的 subagents/workflows/<runId>/）
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // Register agent in Perfetto trace for hierarchy visualization
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // Log API calls path for subagents (ant-only)
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[Subagent ${agentDefinition.agentType}] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}`,
    )
  }

  // Handle message forking for context sharing
  // Filter out incomplete tool calls from parent messages to avoid API errors
// fork 上下文要先过滤：父级对话里可能有「只发了 tool_use 还没收到 tool_result」的尾巴，
// 直接发给 API 会报「orphaned tool call」错误。
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

// 文件读取状态缓存：fork 路径克隆父级的（继承「已读过哪些文件」），
// 普通路径新建一个带容量上限的（子 Agent 自己攒）。
  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

// userContext（CLAUDE.md 等）和 systemContext（gitStatus 等）并发获取
  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // Read-only agents (Explore, Plan) don't act on commit/PR/lint rules from
  // CLAUDE.md — the main agent has full context and interprets their output.
  // Dropping claudeMd here saves ~5-15 Gtok/week across 34M+ Explore spawns.
  // Explicit override.userContext from callers is preserved untouched.
  // Kill-switch defaults true; flip tengu_slim_subagent_claudemd=false to revert.
// 对只读 agent（Explore/Plan）去掉 CLAUDE.md：它们不需要提交/PR/lint 规范，
// 主 Agent 有完整 CLAUDE.md 并且会解读它们的输出。省下的是真金白银（每周 5-15 Gtok）。
// 显式传进来的 override.userContext 原样保留，不受影响。
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
// 解构排除字段：`claudeMd` 取出来赋给 `_omittedClaudeMd`（下划线表示故意不用），
// 其余展开进 userContextNoClaudeMd。≈ Java 里 copy 一个 Map 再 remove 一个 key。
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd
    : baseUserContext

  // Explore/Plan are read-only search agents — the parent-session-start
  // gitStatus (up to 40KB, explicitly labeled stale) is dead weight. If they
  // need git info they run `git status` themselves and get fresh data.
  // Saves ~1-3 Gtok/week fleet-wide.
// 同理去掉 gitStatus：父 session 启动时的 git status 最大 40KB 且明确标了「可能过期」，
// Explore/Plan 需要 git 信息时自己跑一次拿新鲜的。
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit
      : baseSystemContext

  // Override permission mode if agent defines one
  // However, don't override if parent is in bypassPermissions or acceptEdits mode - those should always take precedence
  // For async agents, also set shouldAvoidPermissionPrompts since they can't show UI
// agent 定义里可以写 permissionMode，用来给这个 agent 单独收紧或放宽权限。
// 但父级是 bypassPermissions / acceptEdits 时不覆盖——更宽松的模式优先，避免意外收紧。
  const agentPermissionMode = agentDefinition.permissionMode
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // Override permission mode if agent defines one (unless parent is bypassPermissions, acceptEdits, or auto)
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // Set flag to auto-deny prompts for agents that can't show UI
    // Use explicit canShowPermissionPrompts if provided, otherwise:
    //   - bubble mode: always show prompts (bubbles to parent terminal)
    //   - default: !isAsync (sync agents show prompts, async agents don't)
// 子 Agent 大多没法弹权限框（异步的更是完全没 UI），所以默认自动 deny，
// 只有在 bubble 模式（弹回父级终端）或显式声明能弹时才允许弹。
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // For background agents that can show prompts, await automated checks
    // (classifier, permission hooks) before showing the permission dialog.
    // Since these are background agents, waiting is fine — the user should
    // only be interrupted when automated checks can't resolve the permission.
    // This applies to bubble mode (always) and explicit canShowPermissionPrompts.
// 异步 agent 若能弹框，先等自动检查（分类器、权限钩子）跑完再弹，
// 免得用户被一堆其实能自动判定的请求打断。
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // Scope tool permissions: when allowedTools is provided, use them as session rules.
    // IMPORTANT: Preserve cliArg rules (from SDK's --allowedTools) since those are
    // explicit permissions from the SDK consumer that should apply to all agents.
    // Only clear session-level rules from the parent to prevent unintended leakage.
// 传了 allowedTools 就**替换**全部 session 级 allow 规则（父级的审批不外泄给子 Agent），
// 但保留 cliArg 级规则（SDK 消费者用 --allowedTools 显式给的，应该对所有 agent 生效）。
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // Preserve SDK-level permissions from --allowedTools
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // Use the provided allowedTools as session-level permissions
          session: [...allowedTools],
        },
      }
    }

    // Override effort level if agent defines one
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

// 小优化：如果算下来 appState 一点没变，直接返回原对象引用（React 里能省一次重渲染）
    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

// fork 路径（useExactTools）直接用传入的工具数组不过滤——为了和父级字节级一致命中 cache；
// 普通路径走 resolveAgentTools() 按 agent 定义裁剪。
  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

// system prompt：override 优先（fork 传的是父级已渲染的字节），否则按 agent 定义重新算
  const agentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
          resolvedTools,
        ),
      )

  // Determine abortController:
  // - Override takes precedence
  // - Async agents get a new unlinked controller (runs independently)
  // - Sync agents share parent's controller
// abortController 三选一：override > 异步（新建一个不联动的）> 同步（共享父级的，父级取消它也停）
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

// SubagentStart 钩子可以往子 Agent 的对话里塞额外上下文
// （和 SessionStart / UserPromptSubmit 钩子行为一致，都用 attachment 消息承载）
  // Execute SubagentStart hooks and collect additional context
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // Add SubagentStart hook context as a user message (consistent with SessionStart/UserPromptSubmit)
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

// 注册 agent frontmatter 里写的 hooks，生命周期跟着这个 agent（agent 结束就清掉）
// isAgent=true 会把 Stop 钩子转成 SubagentStop——子 Agent 结束触发的是 SubagentStop 不是 Stop
  // Register agent's frontmatter hooks (scoped to agent lifecycle)
  // Pass isAgent=true to convert Stop hooks to SubagentStop (since subagents trigger SubagentStop)
  // Same admin-trusted gate for frontmatter hooks: under ["hooks"] alone
  // (skills/agents not locked), user agents still load — block their
  // frontmatter-hook REGISTRATION here where source is known, rather than
  // blanket-blocking all session hooks at execution time (which would
  // also kill plugin agents' hooks).
// 同样的「管理员信任」门禁：MCP/hooks 被锁成插件专用时，仍放行插件/内置/策略来源的 agent
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent - converts Stop to SubagentStop
    )
  }

  // Preload skills from agent frontmatter
// 预加载 frontmatter 里声明的 skills：把 skill 内容直接塞进初始消息，
// 省得子 Agent 再花一轮去调 Skill 工具
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // Filter valid skills and warn about missing ones
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // Resolve the skill name, trying multiple strategies:
      // 1. Exact match (hasCommand checks name, userFacingName, aliases)
      // 2. Fully-qualified with agent's plugin prefix (e.g., "my-skill" → "plugin:my-skill")
      // 3. Suffix match on ":skillName" for plugin-namespaced skills
// skill 名解析要兜好几种情况：精确匹配 → 加上 agent 所属插件前缀 → 匹配 ':skillName' 后缀
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // Load all skill contents concurrently and add to initial messages
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // Add command-message metadata so the UI shows which skill is loading
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

// 连专属 MCP server（对父级是叠加的）
  // Initialize agent-specific MCP servers (additive to parent's servers)
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )

  // Merge agent MCP tools with resolved agent tools, deduplicating by name.
  // resolvedTools is already deduplicated (see resolveAgentTools), so skip
  // the spread + uniqBy overhead when there are no agent-specific MCP tools.
// 合并 agent 专属 MCP 工具。resolvedTools 已经去重过了，所以没专属工具时直接跳过
// uniqBy 的开销（数组可能很大）。
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // Build agent-specific options
// 子 Agent 自己的 options。注意 commands: [] —— 子 Agent **不能**用斜杠命令
  const agentOptions: ToolUseContext['options'] = {
// isNonInteractiveSession：fork 路径继承父级的（保持一致），否则异步一律 true，同步继承父级
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,
    commands: [],
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    // For fork children (useExactTools), inherit thinking config to match the
    // parent's API request prefix for prompt cache hits. For regular
    // sub-agents, disable thinking to control output token costs.
// thinking 配置：fork 孩子继承父级的（API 请求前缀要一致才能命中 cache）；
// 普通子 Agent 直接关掉 thinking，控制输出 token 成本。
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // Fork children (useExactTools path) need querySource on context.options
    // for the recursive-fork guard at AgentTool.tsx call() — it checks
    // options.querySource === 'agent:builtin:fork'. This survives autocompact
    // (which rewrites messages, not context.options). Without this, the guard
    // reads undefined and only the message-scan fallback fires — which
    // autocompact defeats by replacing the fork-boilerplate message.
// fork 孩子必须把 querySource 带到 context.options 上：AgentTool 的防递归 fork 守卫读这个字段。
// 它存在 options 里而不是 messages 里，是因为 autocompact 会重写 messages 但不动 options。
    ...(useExactTools && { querySource }),
  }

  // Create subagent context using shared helper
  // - Sync agents share setAppState, setResponseLength, abortController with parent
  // - Async agents are fully isolated (but with explicit unlinked abortController)
// 派生子上下文。shareSetAppState: !isAsync —— 同步 agent 和父级共享状态更新，异步的完全隔离
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // Sync agents share these callbacks with parent
    shareSetAppState: !isAsync,
    shareSetResponseLength: true, // Both sync and async contribute to response metrics
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // Preserve tool use results for subagents with viewable transcripts (in-process teammates)
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // Expose cache-safe params for background summarization (prompt cache sharing)
// 把「构造好的可缓存参数」交给回调（background summarization 用它 fork 一份对话做周期摘要）
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // Record initial messages before the query loop starts, plus the agentType
  // so resume can route correctly when subagent_type is omitted. Both writes
  // are fire-and-forget — persistence failure shouldn't block the agent.
// 落盘初始消息 + agentType。两个写都是 fire-and-forget：持久化失败不该阻塞 agent 运行。
// agentType 也要写，因为 resume 时可能没传 subagent_type，得靠它路由回正确的 agent 定义。
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`Failed to record sidechain transcript: ${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))

  // Track the last recorded message UUID for parent chain continuity
// 记录最后一条已落盘消息的 uuid，下一条消息以它为 parentUuid，形成链式结构（resume 要靠它还原顺序）
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
    })) {
      onQueryProgress?.()
// 只转发「请求开始」这一条流式事件给父级指标面板（让 TTFT/OTPS 在子 Agent 运行时也更新），
// 其余流式事件一律丢掉——上层拿几千条 delta 没有意义。
      // Forward subagent API request starts to parent's metrics display
      // so TTFT/OTPS update during subagent execution.
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_start' &&
        message.ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
        continue
      }

      // Yield attachment messages (e.g., structured_output) without recording them
// attachment 消息（如结构化输出）直接 yield 但**不**落盘
      if (message.type === 'attachment') {
        // Handle max turns reached signal from query.ts
// query.ts 用 max_turns_reached 这个 attachment 来通知「到达最大轮数」，这里据此跳出循环
        if (message.attachment.type === 'max_turns_reached') {
          logForDebugging(
            `[Agent
: $
{
  agentDefinition.agentType
}
] Reached max turns limit ($
{
  message.attachment.maxTurns
}
)`,
          )
          break
        }
        yield message
        continue
      }

// 值得记录的消息：增量落盘（O(1)），带上 parentUuid 串成链
      if (isRecordableMessage(message)) {
        // Record only the new message with correct parent (O(1) per message)
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`Failed to record sidechain transcript: ${err}`),
        )
// progress 消息没有 uuid，不能作为下一条的 parent，所以不更新 lastRecordedUuid
        if (message.type !== 'progress') {
          lastRecordedUuid = message.uuid
        }
        yield message
      }
    }

// 循环正常结束但 abortController 被 abort 了 → 抛 AbortError 让上层按「用户取消」处理
    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // Run callback if provided (only built-in agents have callbacks)
// 内置 agent 才可以带 callback（跑完后的收尾动作，比如统计）
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
// finally 统一清理：正常结束、被取消、出错都会走这里
  } finally {
    // Clean up agent-specific MCP servers (runs on normal completion, abort, or error)
    await mcpCleanup()
    // Clean up agent's session hooks
// 清掉这个 agent 注册的 session hooks（frontmatter hooks 的生命周期到此为止）
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // Clean up prompt cache tracking state for this agent
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      cleanupAgentTracking(agentId)
    }
    // Release cloned file state cache memory
    agentToolUseContext.readFileState.clear()
    // Release the cloned fork context messages
    initialMessages.length = 0
    // Release perfetto agent registry entry
    unregisterPerfettoAgent(agentId)
    // Release transcript subdir mapping
    clearAgentTranscriptSubdir(agentId)
    // Release this agent's todos entry. Without this, every subagent that
    // called TodoWrite leaves a key in AppState.todos forever (even after all
    // items complete, the value is [] but the key stays). Whale sessions
    // spawn hundreds of agents; each orphaned key is a small leak that adds up.
// 清掉 AppState.todos 里这个 agent 的条目。不清的话每个调过 TodoWrite 的子 Agent 都会
// 永远留一个 key（即使所有 todo 都完成了，值只是空数组但 key 还在）。
// 长会话能起几百个 agent，每个都是一次小泄漏。
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
// 又一次「解构排除字段」：把 todos 里 key 为 agentId 的那项剔除，其余保留
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // Kill any background bash tasks this agent spawned. Without this, a
    // `run_in_background` shell loop (e.g. test fixture fake-logs.sh) outlives
    // the agent as a PPID=1 zombie once the main session eventually exits.
// 杀掉这个 agent 起的后台 bash 任务。否则一个 run_in_background 的 shell 循环会在
// agent 结束后变成 PPID=1 的僵尸进程一直存活。
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (feature('MONITOR_TOOL')) {
      const mcpMod =
        require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js')
      mcpMod.killMonitorMcpTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

/**
 * 过滤掉「有 tool_use 但没有对应 tool_result」的 assistant 消息。
 * 为什么需要：fork 时克隆父级对话，或者 resume 时读回 transcript，都可能拿到
 * 「模型刚发出 tool_use 就被打断」的半截消息。这种消息发给 API 会直接报
 * "tool_use blocks without tool_result" 错误。
 * 做法：先扫一遍收集所有出现过的 tool_result 的 tool_use_id，
 * 再剔除那些含未被覆盖 tool_use 的 assistant 消息。
 */
/**
 * Filters out assistant messages with incomplete tool calls (tool uses without results).
 * This prevents API errors when sending messages with orphaned tool calls.
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // Build a set of tool use IDs that have results
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // Filter out assistant messages that contain tool calls without results
  return messages.filter(message => {
    if (message?.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        // Check if this assistant message has any tool uses without results
        const hasIncompleteToolCall = content.some(
          block =>
            block.type === 'tool_use' &&
            block.id &&
            !toolUseIdsWithResults.has(block.id),
        )
        // Exclude messages with incomplete tool calls
        return !hasIncompleteToolCall
      }
    }
    // Keep all non-assistant messages and assistant messages without tool calls
    return true
  })
}

/**
 * 拼出子 Agent 的 system prompt：agent 定义里的 prompt + 环境信息（cwd、平台、目录结构等）。
 * 出错时退化成 DEFAULT_AGENT_PROMPT——宁可用通用提示词跑下去，也不要整个子 Agent 崩掉。
 * enabledToolNames 会传给 enhanceSystemPromptWithEnvDetails，
 * 让环境信息里只提这个 agent 真正有的工具（不然会误导模型去用它没有的工具）。
 */
async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  try {
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  } catch (_error) {
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  }
}

/**
 * 把 frontmatter 里写的 skill 名解析成已注册的命令名。
 * 为什么要三级兜底：插件提供的 skill 注册时是带命名空间的（`my-plugin:my-skill`），
 * 但 agent 的 frontmatter 里习惯写裸名（`my-skill`）。
 * @returns 解析出的命令名，找不到返回 null（调用方会打 warn 日志并跳过）
 */
/**
 * Resolve a skill name from agent frontmatter to a registered command name.
 *
 * Plugin skills are registered with namespaced names (e.g., "my-plugin:my-skill")
 * but agents reference them with bare names (e.g., "my-skill"). This function
 * tries multiple resolution strategies:
 *
 * 1. Exact match via hasCommand (name, userFacingName, aliases)
 * 2. Prefix with agent's plugin name (e.g., "my-skill" → "my-plugin:my-skill")
 * 3. Suffix match — find any command whose name ends with ":skillName"
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. Direct match
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. Try prefixing with the agent's plugin name
  // Plugin agents have agentType like "pluginName:agentName"
// 插件 agent 的 agentType 形如 `pluginName:agentName`，取冒号前那段当插件前缀
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. Suffix match — find a skill whose name ends with ":skillName"
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}
