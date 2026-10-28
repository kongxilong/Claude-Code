/**
 * 【一句话定位】定义 Claude Code 里「一个工具（tool）」长什么样：一个工具的完整接口（有哪些方法、各自什么时候被调用），
 * 以及工具运行时能拿到的上下文（ToolUseContext）。这是理解全部 50+ 个具体工具的基础契约。
 *
 * 【在架构中的位置】
 *   上游（谁依赖本文件）：
 *     src/tools.ts                        —— 聚合所有具体工具，产出 Tool[] 交给主循环
 *     src/query.ts / src/QueryEngine.ts   —— 主循环：把工具列表发给模型，收到 tool_use 后回调工具的 call()
 *     src/services/tools/toolExecution.ts —— 工具执行的真正入口（权限 → hook → 执行 → hook → 结果规整）
 *     src/services/tools/toolOrchestration.ts —— 决定哪些工具可以并发跑
 *     src/commands.ts                     —— 斜杠命令与工具共享 Command/Tool 体系
 *   下游（本文件依赖谁）：
 *     zod（z.infer）                      —— 入参 schema 与静态类型推导
 *     ./types/message.js、./types/permissions.js、./types/tools.js —— 消息、权限、进度的类型定义
 *   一次工具调用的完整链路：
 *     模型输出 tool_use 块
 *       → tools.ts 的 findToolByName() 按 name/aliases 找到 Tool 对象
 *       → toolOrchestration.ts 用 isConcurrencySafe() 判定并发还是串行
 *       → toolExecution.ts：validateInput() → checkPermissions()/通用权限 → PreToolUse hook
 *       → Tool.call()（工具真正的业务逻辑）
 *       → PostToolUse hook → mapToolResultToToolResultBlockParam() 包装成 tool_result
 *       → 结果回灌给模型，进入下一轮主循环
 *
 * 【本文件包含什么】
 *   Tool<Input, Output, P>       —— 核心：一个工具的完整接口（下面按 7 组职责展开讲）
 *   ToolUseContext               —— 工具执行时能拿到的运行时上下文大礼包（工具列表、权限、AppState、消息历史、UI 回调）
 *   ToolPermissionContext        —— 权限模式（default/acceptEdits/plan/bypassPermissions）与 allow/deny/ask 规则集
 *   ToolResult<T>                —— 工具返回值包装：data + 可选 newMessages + 可选 contextModifier
 *   ValidationResult             —— validateInput() 的返回：通过 / 不通过（带 message 与 errorCode）
 *   ToolDef / BuiltTool / buildTool —— 工具构造器：具体工具只写差异，缺省方法由 TOOL_DEFAULTS 补齐
 *   TOOL_DEFAULTS                —— 那组缺省实现（fail-closed：默认不可并发、默认非只读）
 *   findToolByName / toolMatchesName —— 按主名或别名查找工具
 *   Tools                        —— readonly Tool[] 的别名（用别名是为了方便全局追踪工具集的流转）
 *   filterToolProgressMessages   —— 从进度消息里滤掉 hook 进度，只留工具进度
 *
 * 【TS 语法速查】（针对本文件实际出现的写法，Java 工程师对照看）
 *   1. 类型标注在变量名【后面】：`const x: number = 1` ≈ Java 的 `int x = 1`。这是最容易看串的地方，务必习惯。
 *   2. `type X = { a: string; b?: number }` ≈ Java record / 接口，但它是【结构化鸭子类型】：
 *      字段对得上就兼容，不要求显式 implements。
 *   3. `A | B` 联合类型 ≈ Java sealed interface：值只能是其中一种，通常靠某个字面量字段（如 type）判别，
 *      这种写法叫「可辨识联合（discriminated union）」，本文件里 ValidationResult、CompactProgressEvent 都是。
 *   4. `readonly xxx: T` ≈ final 字段；`readonly Tool[]` ≈ 只读 List（编译期约束，运行时不强制）。
 *   5. `foo?: T` 可选属性（该字段可以不存在）≈ Java 里可能为 null 的字段，但 TS 会强制你先判空再用。
 *   6. `foo?(): string` 是【可选方法】：接口里可以不实现，调用必须写 `tool.foo?.()`，
 *      等价语义 `if (tool.foo != null) tool.foo()`；`?.` ≈ 一层 null 检查链。
 *   7. `??` 空值合并：仅当左侧是 null/undefined 才取右侧；与 `||` 不同——0 和 '' 不会被替换
 *      （Java 没有对应运算符，别当成 orElse 用）。
 *   8. `z.infer<Input>` 是 zod 的【类型推导】：从运行时 schema 反推出静态类型，编译期完成。
 *   9. 泛型可以带默认值：`Tool<Input extends AnyObject = AnyObject, Output = unknown>` ≈ Java `<Input extends AnyObject>`，
 *      但 TS 允许 = 给出默认实参。
 *  10. 函数类型写法 `type SetToolJSXFn = (args: {...}) => void` ≈ Java 的 functional interface（lambda 的类型）。
 *  11. 箭头函数 `() => true` ≈ Java lambda `() -> true`；`(prev) => ({...prev, x: 1})` 这种 setter 形式 ≈ UnaryOperator。
 *  12. `Promise<T>` ≈ Java CompletableFuture<T>；async 函数里的 await ≈ get()/join()，但不会阻塞线程。
 *  13. `Omit<T,K>` / `Pick<T,K>` / `Partial<T>` / `DeepImmutable<T>` 是【类型工具】≈ 编译期对类型做投影变换：
 *      Omit 去掉字段、Pick 只留字段、Partial 全部变可选、DeepImmutable 递归加 readonly。
 *  14. `keyof Theme` ≈ 取一个类型的所有字段名组成的联合类型，类似反射拿字段名，但编译期且类型安全。
 *  15. `typeof TOOL_DEFAULTS`：把【值】的类型取出来当类型用（Java 无对应物，想象成从对象实例反推它的类）。
 *  16. `-?` 出现在映射类型里表示【去掉可选】：`[K in Keys]-?: T` 即结果里该字段必填（见 BuiltTool）。
 *  17. `as BuiltTool<D>` ≈ Java 强制类型转换 `(BuiltTool) x`：编译期断言，运行时不做任何检查。
 *  18. `React.ReactNode` 是 React 渲染节点类型（Claude Code 的终端 UI 就是 React 渲染的），本文件只用它作返回类型。
 *  19. `x is T`（类型谓词，见 filterToolProgressMessages）≈ Java 的 instanceof 模式匹配：返回 true 时编译器把 x 窄化成 T。
 *  20. `import type {...}` 表示【只导入类型】，编译后会被完全擦除；用它来避免运行时循环依赖。
 */
import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { UUID } from 'crypto'
import type { z } from 'zod/v4'
import type { Command } from './commands.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { ThinkingConfig } from './utils/thinking.js'

/** 工具入参的 JSON Schema 形态，专供 MCP 工具使用。
 *  为什么需要它：普通工具用 zod 的 inputSchema；MCP 工具来自外部服务器，天生只有 JSON Schema，没有 zod。
 *  `[x: string]: unknown` 是「索引签名」≈ 允许任意额外键（类似 Map<String,Object> 的字段形式），
 *  加上 `type: 'object'` 这个字面量类型（注意是字符串字面量当类型用，不是 string）。
 */
export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

import type { Notification } from './context/notifications.js'
import type {
  MCPServerConnection,
  ServerResource,
} from './services/mcp/types.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from './tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from './types/message.js'
// Import permission types from centralized location to break import cycles
// Import PermissionResult from centralized location to break import cycles
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionResult,
} from './types/permissions.js'
// Import tool progress types from centralized location to break import cycles
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
} from './types/tools.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
import type { SystemPrompt } from './utils/systemPromptType.js'
import type { ContentReplacementState } from './utils/toolResultStorage.js'

// Re-export progress types for backwards compatibility
export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  WebSearchProgress,
}

import type { SpinnerMode } from './components/Spinner.js'
import type { QuerySource } from './constants/querySource.js'
import type { SDKStatus } from './entrypoints/agentSdkTypes.js'
import type { AppState } from './state/AppState.js'
import type {
  HookProgress,
  PromptRequest,
  PromptResponse,
} from './types/hooks.js'
import type { AgentId } from './types/ids.js'
import type { DeepImmutable } from './types/utils.js'
import type { AttributionState } from './utils/commitAttribution.js'
import type { FileHistoryState } from './utils/fileHistory.js'
import type { Theme, ThemeName } from './utils/theme.js'

/** 查询链追踪信息：chainId 标识一整条调用链，depth 表示当前嵌套第几层（主线程 0，子 agent 逐级 +1）。
 *  用途：telemetry 统计、调试，以及防止子 agent 无限递归地派生子 agent。
 */
export type QueryChainTracking = {
  chainId: string
  depth: number
}

/** validateInput() 的返回值，是【可辨识联合】：要么 `result: true`（通过），
 *  要么 `result: false` 且必须带 message 与 errorCode。用 result 字段区分两种形态。
 *  ≈ Java sealed interface 配两个 record，再 switch 模式匹配。
 *  失败时的 message 会被回灌给模型，告诉它这次调用为什么失败（让它自己改参数重试），而不是直接报错中断。
 */
export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

/** 往终端 REPL 里塞一块 React 组件（JSX）的回调：工具想画自定义 UI（例如选择面板、进度面板）就通过它。
 *  类型是 `(args: {...} | null) => void`：入参本身又是「对象 | null」联合，传 null 表示清空当前 JSX。
 *  `shouldContinueAnimation?: true` 这种「?: 字面量类型」写法表示：要么不传，要么只能是 true（比 boolean 更精确）。
 */
export type SetToolJSXFn = (
  args: {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    shouldContinueAnimation?: true
    showSpinner?: boolean
    isLocalJSXCommand?: boolean
    isImmediate?: boolean
    /** Set to true to clear a local JSX command (e.g., from its onDone callback) */
    clearLocalJSX?: boolean
  } | null,
) => void

// Import tool permission types from centralized location to break import cycles
import type { ToolPermissionRulesBySource } from './types/permissions.js'

// Re-export for backwards compatibility
export type { ToolPermissionRulesBySource }

// Apply DeepImmutable to the imported type
/** 权限上下文：判断「这个工具这一次能不能跑」所需的全部规则状态。
 *  mode 取值如 default / acceptEdits / plan / bypassPermissions；alwaysAllow/Deny/AskRules 是用户配置的规则集。
 *  外层套 DeepImmutable<T> ≈ 把所有字段递归变成 final：防止工具执行过程中偷偷改权限配置（安全上的硬约束）。
 *  为什么这些类型要绕一圈再 export：Tool.ts 被几乎所有文件 import，而权限类型原本定义在 permissions.ts，
 *  直接互相 import 会形成循环依赖，所以统一放到 types/permissions.ts 再由此处 re-export（见上面英文注释里的 break import cycles）。
 */
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  strippedDangerousRules?: ToolPermissionRulesBySource
  /** When true, permission prompts are auto-denied (e.g., background agents that can't show UI) */
  shouldAvoidPermissionPrompts?: boolean
  /** When true, automated checks (classifier, hooks) are awaited before showing the permission dialog (coordinator workers) */
  awaitAutomatedChecksBeforeDialog?: boolean
  /** Stores the permission mode before model-initiated plan mode entry, so it can be restored on exit */
  prePlanMode?: PermissionMode
}>

/** 造一个「空权限上下文」的工厂，用于测试或还没有真实配置的早期阶段。
 *  写法 `const f: () => ToolPermissionContext = () => ({...})`：先声明「无参、返回 T 的函数类型」，再用箭头函数实现。
 *  默认值是最保守的一档：mode='default'、三个规则集都为空、bypass 模式不可用（fail-closed 思路）。
 */
export const getEmptyToolPermissionContext: () => ToolPermissionContext =
  () => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  })

/** compact（上下文压缩）过程中的进度事件，同样是可辨识联合（type 字段区分三种）：
 *  hooks_start 表示即将跑压缩相关的 hook（pre_compact / post_compact / session_start），
 *  compact_start / compact_end 用于 UI 显示「正在压缩上下文…」并让上层等待。
 */
export type CompactProgressEvent =
  | {
      type: 'hooks_start'
      hookType: 'pre_compact' | 'post_compact' | 'session_start'
    }
  | { type: 'compact_start' }
  | { type: 'compact_end' }

/** 【最关键的上下文类型】工具执行时拿到的「运行时大礼包」，每个工具 call() 的第二个参数就是它。
 *  可类比 Java 里一个巨大的 Context 对象，但 TS 里它是鸭子类型：谁都能构造，只要字段齐了就行。
 *  内部分组（便于记忆）：
 *    - options：静态配置（工具列表 tools、斜杠命令 commands、MCP 客户端与资源、子 agent 定义、模型名、debug/verbose 开关）
 *    - 状态读写：getAppState / setAppState / setAppStateForTasks / updateFileHistoryState / updateAttributionState
 *    - UI 回调：setToolJSX / addNotification / sendOSNotification / setStreamMode / openMessageSelector
 *    - 取消与消息：abortController（≈ Java 中断标志）、messages（当前会话完整历史）
 *  注意大量字段是可选的（`xxx?:`）：REPL 交互模式才提供 UI 回调，SDK/子 agent 模式下没有，所以工具用之前要判空。
 */
export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    /** Custom system prompt that replaces the default system prompt */
    customSystemPrompt?: string
    /** Additional system prompt appended after the main system prompt */
    appendSystemPrompt?: string
    /** Override querySource for analytics tracking */
    querySource?: QuerySource
    /** Optional callback to get the latest tools (e.g., after MCP servers connect mid-query) */
    refreshTools?: () => Tools
  }
// options 到此结束。下面都是「能力 / 回调」，且大多是可选的——非交互（SDK、后台 agent）场景下它们缺失是常态，
// 工具里用到时必须写成 `context.setToolJSX?.(...)` 这种可选调用形式，否则会运行时报错。
  abortController: AbortController
// abortController：用户按 ESC、超时或父任务取消时它会被 abort。
// 长时间运行的工具（尤其 Bash）必须把它传给子进程 / fetch，否则「取消」只是 UI 上消失了，底层进程还在跑。
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  /**
   * Always-shared setAppState for session-scoped infrastructure (background
   * tasks, session hooks). Unlike setAppState, which is no-op for async agents
   * (see createSubagentContext), this always reaches the root store so agents
   * at any nesting depth can register/clean up infrastructure that outlives
   * a single turn. Only set by createSubagentContext; main-thread contexts
   * fall back to setAppState.
   */
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  /**
   * Optional handler for URL elicitations triggered by tool call errors (-32042).
   * In print/SDK mode, this delegates to structuredIO.handleElicitation.
   * In REPL mode, this is undefined and the queue-based UI path is used.
   */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: Notification) => void
  /** Append a UI-only system message to the REPL message list. Stripped at the
   *  normalizeMessagesForAPI boundary — the Exclude<> makes that type-enforced. */
  appendSystemMessage?: (
    msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
  ) => void
  /** Send an OS-level notification (iTerm2, Kitty, Ghostty, bell, etc.) */
  sendOSNotification?: (opts: {
    message: string
    notificationType: string
  }) => void
  nestedMemoryAttachmentTriggers?: Set<string>
  /**
   * CLAUDE.md paths already injected as nested_memory attachments this
   * session. Dedup for memoryFilesToAttachments — readFileState is an LRU
   * that evicts entries in busy sessions, so its .has() check alone can
   * re-inject the same CLAUDE.md dozens of times.
   */
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  /** Skill names surfaced via skill_discovery this session. Telemetry only (feeds was_discovered). */
  discoveredSkillNames?: Set<string>
  userModified?: boolean
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
// 告诉 UI 当前有哪些 toolUseID 在跑（Set<string>），用于渲染 spinner 与「可中断工具」提示。
  /** Only wired in interactive (REPL) contexts; SDK/QueryEngine don't set this. */
  setHasInterruptibleToolInProgress?: (v: boolean) => void
  setResponseLength: (f: (prev: number) => number) => void
  /** Ant-only: push a new API metrics entry for OTPS tracking.
   *  Called by subagent streaming when a new API request starts. */
  pushApiMetricsEntry?: (ttftMs: number) => void
  setStreamMode?: (mode: SpinnerMode) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  setSDKStatus?: (status: SDKStatus) => void
  openMessageSelector?: () => void
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void
  updateAttributionState: (
    updater: (prev: AttributionState) => AttributionState,
  ) => void
  setConversationId?: (id: UUID) => void
  agentId?: AgentId // Only set for subagents; use getSessionId() for session ID. Hooks use this to distinguish subagent calls.
  agentType?: string // Subagent type name. For the main thread's --agent type, hooks fall back to getMainThreadAgentType().
  /** When true, canUseTool must always be called even when hooks auto-approve.
   *  Used by speculation for overlay file path rewriting. */
  requireCanUseTool?: boolean
  messages: Message[]
// 当前会话的完整消息历史。工具原则上只读它；要往会话里加东西请走 ToolResult.newMessages，
// 直接改这个数组会破坏消息一致性（压缩、去重、tool_use/tool_result 配对都依赖它）。
  fileReadingLimits?: {
    maxTokens?: number
    maxSizeBytes?: number
  }
  globLimits?: {
    maxResults?: number
  }
  toolDecisions?: Map<
    string,
    {
      source: string
      decision: 'accept' | 'reject'
      timestamp: number
    }
  >
  queryTracking?: QueryChainTracking
  /** Callback factory for requesting interactive prompts from the user.
   * Returns a prompt callback bound to the given source name.
   * Only available in interactive (REPL) contexts. */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolUseId?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  /** When true, preserve toolUseResult on messages even for subagents.
   * Used by in-process teammates whose transcripts are viewable by the user. */
  preserveToolUseResults?: boolean
  /** Local denial tracking state for async subagents whose setAppState is a
   *  no-op. Without this, the denial counter never accumulates and the
   *  fallback-to-prompting threshold is never reached. Mutable — the
   *  permissions code updates it in place. */
  localDenialTracking?: DenialTrackingState
  /**
   * Per-conversation-thread content replacement state for the tool result
   * budget. When present, query.ts applies the aggregate tool result budget.
   * Main thread: REPL provisions once (never resets — stale UUID keys
   * are inert). Subagents: createSubagentContext clones the parent's state
   * by default (cache-sharing forks need identical decisions), or
   * resumeAgentBackground threads one reconstructed from sidechain records.
   */
  contentReplacementState?: ContentReplacementState
  /**
   * Parent's rendered system prompt bytes, frozen at turn start.
   * Used by fork subagents to share the parent's prompt cache — re-calling
   * getSystemPrompt() at fork-spawn time can diverge (GrowthBook cold→warm)
   * and bust the cache. See forkSubagent.ts.
   */
  renderedSystemPrompt?: SystemPrompt
}

// Re-export ToolProgressData from centralized location
export type { ToolProgressData }

/** 进度事件的大联合：可能来自工具自身（ToolProgressData），也可能来自 hook（HookProgress）。
 *  合并它们的理由：UI 只关心「现在在跑什么、显示什么」，不关心事件来源是工具还是 hook。
 */
export type Progress = ToolProgressData | HookProgress

/** 一条工具进度 = 属于哪个 toolUseID + 具体进度数据。
 *  toolUseID 用来把进度事件对回它所属的那一次工具调用（并发跑多个工具时全靠它区分）。
 *  `ToolProgress<P extends ToolProgressData>` 是泛型约束 ≈ Java 的 `<P extends ToolProgressData>`。
 */
export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}

/** 从进度消息里滤掉 hook 进度，只保留工具进度（供工具的 renderToolUseProgressMessage 渲染）。
 */
export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
// `(msg): msg is ProgressMessage<ToolProgressData> => ...` 是【类型谓词】≈ Java 的 instanceof 模式匹配：
// 一旦返回 true，编译器就把 msg 窄化成该类型，filter 之后数组的元素类型也随之变精确（否则还得到处 as 强转）。
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      msg.data?.type !== 'hook_progress',
  )
}

/** 工具执行完的返回值包装，三个字段各有讲究：
 *  1. data：真正的业务结果，类型由工具的 Output 泛型决定，随后交给 mapToolResultToToolResultBlockParam 序列化给模型。
 *  2. newMessages?：工具可以顺带往会话里追加消息（例如子 agent 把自己的完整 transcript 塞回来）。
 *     走返回值而不是直接改 context.messages，是为了让「消息变更」这件事对主循环可见、可控。
 *  3. contextModifier?：工具可以修改 ToolUseContext（例如切换模型、调整权限模式）。
 *     上面英文注释强调只有【非并发安全】的工具才生效：并发执行时多个工具同时改上下文会互相打架。
 *  另外 mcpMeta 是 MCP 协议的透传元数据（structuredContent / _meta），原样带给 SDK 使用者。
 */
export type ToolResult<T> = {
  data: T
  newMessages?: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[]
  // contextModifier is only honored for tools that aren't concurrency safe.
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  /** MCP protocol metadata (structuredContent, _meta) to pass through to SDK consumers */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

/** 工具上报进度的回调类型：`(progress: ToolProgress<P>) => void`。
 *  耗时工具在 call() 里周期性调用它（例如 Bash 每输出一行报一次），UI 才能实时刷新而不是傻等。
 */
export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

// Type for any schema that outputs an object with string keys
/** 「任意对象 schema」：产出 `{ [key: string]: unknown }` 的 zod schema。
 *  工具的入参必须是一个对象（不能是裸字符串或数组），所以用 AnyObject 约束泛型 Input。
 */
export type AnyObject = z.ZodType<{ [key: string]: unknown }>

/**
 * Checks if a tool matches the given name (primary name or alias).
 */
/** 判断某个工具是否匹配给定名字：先比主名，再比别名列表。
 *  为什么要有别名：工具改名后，历史会话、旧版配置、用户口头习惯里可能还在用旧名，别名保证向后兼容。
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
// `tool.aliases?.includes(name) ?? false`：aliases 可能没定义 → 整段是 undefined → 用 ?? 回落成 false。
// 这里用 ?? 而不是 ||：?? 只在 null/undefined 时替换，而 || 会把 false/0/'' 也吃掉（本例恰好等价，但习惯上要分清）。
}

/**
 * Finds a tool by name or alias from a list of tools.
 */
/** 在一堆工具里按名字 / 别名查找，找不到返回 undefined（所以返回类型写成 `Tool | undefined`）。
 *  这是主循环拿到模型的 tool_use 之后的第一步：没有它，模型点名的工具无从查起。
 *  找不到工具时，主循环会给模型回一个「没有这个工具」的错误，让模型自己纠正。
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
// `tools.find(t => ...)` ≈ Java 的 stream().filter().findFirst().orElse(null)；箭头函数 t => ... 就是 lambda。
}

/** ═══════════════════════════════════════════════════════════════════════════
 *  【核心】Tool<Input, Output, P>：Claude Code 里「一个工具」的完整契约。
 *  全部 50+ 个工具（Bash / Read / Edit / Grep / Glob / Agent / WebFetch / TodoWrite ...）都是这个类型的实例。
 *
 *  三个泛型参数：
 *    Input  —— 入参的 zod schema（extends AnyObject，即必须是个对象），用 z.infer<Input> 反推出入参的静态类型
 *    Output —— 工具返回的业务数据（也就是 ToolResult.data 的类型），默认 unknown ≈ Java 的 Object
 *    P      —— 进度数据类型，默认 ToolProgressData
 *
 *  下面这一大坨方法，按「谁在什么时候调用它」分成 7 组，建议按 ①→⑦ 的顺序理解：
 *
 *  ①【身份与发现】（模型怎么知道有这个工具、怎么用）
 *     name             —— 唯一主名（如 Bash），模型 tool_use 块里写的就是它
 *     aliases?         —— 旧名 / 别名，向后兼容用
 *     searchHint?      —— 一句话能力描述，供 ToolSearch 做关键词匹配（工具被 defer 时，模型靠它找到工具）
 *     shouldDefer?     —— true 表示该工具「延迟加载」：prompt 里只给占位，模型想用必须先 ToolSearch 一轮
 *     alwaysLoad?      —— true 表示永不被 defer，第一轮就必须完整出现在 prompt 里（模型必须立刻能看到的工具）
 *     prompt()         —— 生成写进 system prompt 的工具用法说明（教模型怎么用）
 *     inputSchema      —— zod 入参 schema（发给 API 的 tools[].input_schema 由它转换而来）
 *     inputJSONSchema? —— MCP 工具专用：直接给 JSON Schema，省去从 zod 反推
 *     outputSchema?    —— 出参 schema，可选（目前 TungstenTool 就没定义）
 *
 *  ②【能不能用 / 要不要问用户】（安全闸门，真正编排顺序见 toolExecution.ts）
 *     isEnabled()              —— 当前环境是否可用（例如只有检测到 IDE 才启用 IDE 相关工具）
 *     validateInput?()         —— 入参合法性校验（不弹任何 UI；失败把 message 回灌给模型让它自己改）
 *     checkPermissions()       —— 工具自己的权限判断（只管工具特有逻辑，通用规则在 permissions.ts）
 *     preparePermissionMatcher?() —— 为 hook 的 if 条件（如 Bash(git *)）准备匹配器：昂贵的解析只做一次，返回闭包复用
 *     isReadOnly(input)        —— 是否只读（只读工具在很多模式下可免询问）
 *     isDestructive?(input)    —— 是否不可逆（删除 / 覆盖 / 发送），影响权限提示的措辞与强度
 *     isOpenWorld?(input)      —— 能否触达「开放世界」（如 Bash 理论上能干任何事），权限上要更保守
 *     requiresUserInteraction?() —— 是否必须有人参与（例如 AskUserQuestion）
 *
 *  ③【调度与并发】（决定能不能和别的工具一起跑）
 *     isConcurrencySafe(input) —— 只读 / 无副作用 → true 可并发；要写文件 → false 必须串行
 *     interruptBehavior?()     —— 用户中途插话时怎么办：'cancel' 放弃这次调用，'block' 跑完再说（默认 block）
 *
 *  ④【真正干活】
 *     call(args, context, canUseTool, parentMessage, onProgress?) —— 工具的业务主体
 *         args          模型给的结构化入参（已按 inputSchema 校验过）
 *         context       ToolUseContext，上面那个运行时大礼包
 *         canUseTool    再次向权限系统 / 用户确认的回调（工具内部想临时再申请权限时用它）
 *         parentMessage 触发这次调用的 assistant 消息（能拿到上下文、父级 tool_use 等）
 *         onProgress    上报进度的回调（耗时工具用它做流式刷新）
 *
 *  ⑤【结果转换】（工具返回值 → 模型能读懂的 tool_result 块）
 *     mapToolResultToToolResultBlockParam(content, toolUseID) —— 必填，把 Output 序列化成 API 的 tool_result
 *     maxResultSizeChars —— 结果超过这个字符数就落盘，只给模型「已保存到文件 + 路径 + 预览」，
 *                           防止一次大输出把上下文撑爆；设为 Infinity 表示永不落盘
 *     getPath?(input)    —— 工具操作的文件路径（权限规则匹配、去重、文件变化追踪都要用）
 *     inputsEquivalent?(a,b) —— 两次调用入参是否等价（用于去重 / 缓存 / 合并展示）
 *     backfillObservableInput?(input) —— 在给 hook / SDK / transcript 看的【副本】上补字段（必须幂等），
 *                                        绝不改原始入参，否则会破坏 prompt cache
 *
 *  ⑥【终端 UI 渲染】（全部可选，不实现就用兜底组件）
 *     renderToolUseMessage(input, opts)      —— 调用发生时显示什么（注意 input 是 Partial：模型还在流式输出，参数没齐就开始渲染了）
 *     renderToolResultMessage?(content, ...) —— 结果显示什么；不实现就什么都不显示（如 TodoWrite 的结果在侧栏面板里）
 *     renderToolUseProgressMessage?(...)     —— 执行中显示什么（进度条 / spinner）
 *     renderToolUseRejectedMessage?(...)     —— 被拒绝时的自定义 UI（如 Edit 展示被拒的 diff）
 *     renderToolUseErrorMessage?(...)        —— 出错时的自定义 UI（如「文件不存在」而不是原始堆栈）
 *     renderToolUseTag?(input)               —— 调用行尾的小标签（超时、模型名、resume id 等元信息）
 *     renderGroupedToolUse?(...)             —— 多个同类工具调用合并成一屏展示（如并行 5 个 Read）
 *     renderToolUseQueuedMessage?()          —— 排队中显示什么
 *
 *  ⑦【给分类器 / 压缩 / 搜索用的辅助信息】
 *     toAutoClassifierInput(input) —— 给 auto 模式安全分类器看的一句话摘要（如 ls -la）；返回 '' 表示跳过该工具
 *     getToolUseSummary?(input)    —— 紧凑视图下的一句话摘要
 *     getActivityDescription?(input) —— spinner 旁的进行时描述（如 Reading src/foo.ts）
 *     userFacingName(input)        —— 给用户看的友好名字（可以和主名不同）
 *     isSearchOrReadCommand?(input)—— 是否是可折叠的搜索 / 读操作（Grep / Glob / Read / ls 等）
 *     isResultTruncated?(output)   —— 非 verbose 渲染是否被截断（决定能否点开看更多）
 *     extractSearchText?(out)      —— 给 transcript 全文检索用的纯文本（必须与屏幕上真渲染出来的文字一致）
 *
 *  本类型里反复出现的 TS 写法：
 *    - `xxx?(...): T` 可选方法，调用要写 `tool.xxx?.(args)`（≈ 先判 null）
 *    - `readonly xxx: T` 不可重新赋值（≈ final）
 *    - `Partial<X>` 把 X 的所有字段变可选（渲染类方法常用，因为入参可能还没流完）
 *    - `z.infer<Input>` 从 zod schema 反推入参类型（编译期）
 *    - `React.ReactNode` React 渲染节点（Claude Code 的终端 UI 就是 React 渲染的）
 * ═══════════════════════════════════════════════════════════════════════════ */
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  /**
   * Optional aliases for backwards compatibility when a tool is renamed.
   * The tool can be looked up by any of these names in addition to its primary name.
   */
  aliases?: string[]
  /**
   * One-line capability phrase used by ToolSearch for keyword matching.
   * Helps the model find this tool via keyword search when it's deferred.
   * 3–10 words, no trailing period.
   * Prefer terms not already in the tool name (e.g. 'jupyter' for NotebookEdit).
   */
  searchHint?: string
// 【④ 真正干活】工具的业务主体。所有工具都必须实现它，返回 Promise<ToolResult<Output>>。
// 它是整个接口里唯一「必做实事」的方法，其余方法基本都是围绕它做前置校验、后置规整与展示。
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
// 【① 身份】入参 schema：既用于校验模型给的参数，也用于生成发给 API 的 tools[].input_schema。
// 标成 readonly：schema 是工具的定义的一部分，运行期不允许被替换（改它等于改工具的契约）。
  readonly inputSchema: Input
  // Type for MCP tools that can specify their input schema directly in JSON Schema format
  // rather than converting from Zod schema
// MCP 工具专用通道：外部 MCP 服务器只提供 JSON Schema，没有 zod，所以单独留一个字段绕过 zod 转换。
  readonly inputJSONSchema?: ToolInputJSONSchema
  // Optional because TungstenTool doesn't define this. TODO: Make it required.
  // When we do that, we can also go through and make this a bit more type-safe.
// 出参 schema。之所以是可选的：TungstenTool 没定义它（见上方英文 TODO），将来收紧成必填时会更类型安全。
  outputSchema?: z.ZodType<unknown>
// 判断两次调用的入参是否「等价」。用处：去重（同参数重复调用可复用结果）、UI 合并展示、缓存命中判定。
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
// 【③ 调度】能否与其他工具并发执行。这是主循环吞吐量的关键开关：
// 只读工具（Read / Grep / Glob）返回 true，模型一次输出 5 个 tool_use 就能并行跑；
// 有写操作的工具（Edit / Write / Bash）返回 false，必须串行，否则会出现「读-改-写」竞态。
  isConcurrencySafe(input: z.infer<Input>): boolean
// 该工具在当前环境是否可用（不是「允不允许用」，而是「有没有」）。
// 例：依赖 IDE 的工具在没有 IDE 连接时返回 false，压根不会出现在发给模型的工具列表里。
  isEnabled(): boolean
// 是否只读。权限系统据此放宽：只读工具在 acceptEdits 等模式下通常免询问（不产生副作用就没风险）。
  isReadOnly(input: z.infer<Input>): boolean
  /** Defaults to false. Only set when the tool performs irreversible operations (delete, overwrite, send). */
// 是否不可逆（删除 / 覆盖 / 发送邮件等）。默认是 false；置 true 会让权限提示更强硬，也给安全分类器更多信号。
  isDestructive?(input: z.infer<Input>): boolean
  /**
   * What should happen when the user submits a new message while this tool
   * is running.
   *
   * - `'cancel'` — stop the tool and discard its result
   * - `'block'`  — keep running; the new message waits
   *
   * Defaults to `'block'` when not implemented.
   */
// 用户中途插入新消息时该工具怎么办：
//   'cancel' —— 立刻停掉并丢弃结果（适合已无意义的调用，比如被用户一句话推翻的长时间搜索）
//   'block'  —— 继续跑完（默认，适合已经产生副作用、中途停会留下半成品状态的工具）
  interruptBehavior?(): 'cancel' | 'block'
  /**
   * Returns information about whether this tool use is a search or read operation
   * that should be collapsed into a condensed display in the UI. Examples include
   * file searching (Grep, Glob), file reading (Read), and bash commands like find,
   * grep, wc, etc.
   *
   * Returns an object indicating whether the operation is a search or read operation:
   * - `isSearch: true` for search operations (grep, find, glob patterns)
   * - `isRead: true` for read operations (cat, head, tail, file read)
   * - `isList: true` for directory-listing operations (ls, tree, du)
   * - All can be false if the operation shouldn't be collapsed
   */
// 是否属于「可折叠」的搜索 / 读操作。返回 isSearch / isRead / isList 三个标志，
// UI 据此把大量同质调用（如 20 个 Grep）折叠成一两行，避免刷屏；与权限无关，纯展示优化。
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
// 是否能触达「开放世界」：例如 Bash 可以执行任意命令、WebFetch 可以访问任意网址。
// 这类工具无法用静态规则穷举其影响，权限上必须更谨慎（也更依赖分类器与用户确认）。
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean
  isMcp?: boolean
  isLsp?: boolean
  /**
   * When true, this tool is deferred (sent with defer_loading: true) and requires
   * ToolSearch to be used before it can be called.
   */
// 延迟加载标志：true 时该工具只以一个占位出现在 prompt 里（defer_loading），模型必须先调 ToolSearch 才能用它。
// 目的：工具越来越多（尤其接了大量 MCP 服务器后），全量 schema 会吃掉大量上下文，defer 能显著省 token。
  readonly shouldDefer?: boolean
  /**
   * When true, this tool is never deferred — its full schema appears in the
   * initial prompt even when ToolSearch is enabled. For MCP tools, set via
   * `_meta['anthropic/alwaysLoad']`. Use for tools the model must see on
   * turn 1 without a ToolSearch round-trip.
   */
// 永不延迟加载：即使开了 ToolSearch，这些工具也要在首轮完整出现（模型必须立刻能用的核心工具）。
// MCP 工具可通过 _meta['anthropic/alwaysLoad'] 来声明这一点。
  readonly alwaysLoad?: boolean
  /**
   * For MCP tools: the server and tool names as received from the MCP server (unnormalized).
   * Present on all MCP tools regardless of whether `name` is prefixed (mcp__server__tool)
   * or unprefixed (CLAUDE_AGENT_SDK_MCP_NO_PREFIX mode).
   */
// MCP 工具保留「服务器名 + 工具原名」：因为对模型暴露的名字可能带前缀（mcp__server__tool）也可能不带，
// 而 hook / 权限规则 / 日志里需要原始名字，不能依赖被改写过的 name。
  mcpInfo?: { serverName: string; toolName: string }
// 工具的唯一主名，模型 tool_use 块里写的就是它，findToolByName 也靠它匹配。
  readonly name: string
  /**
   * Maximum size in characters for tool result before it gets persisted to disk.
   * When exceeded, the result is saved to a file and Claude receives a preview
   * with the file path instead of the full content.
   *
   * Set to Infinity for tools whose output must never be persisted (e.g. Read,
   * where persisting creates a circular Read→file→Read loop and the tool
   * already self-bounds via its own limits).
   */
// 【⑤ 结果转换】结果落盘阈值（字符数）。超过就把完整结果写到文件，只给模型「路径 + 预览」。
// 这是上下文保护机制：一次 cat 大日志就能吃掉整个窗口。
// 设为 Infinity 表示永不落盘——Read 就是典型：落盘会形成「读文件 → 存文件 → 再读文件」的循环，
// 而且 Read 自己已经有行数 / 字节数限制，不需要再靠落盘兜底。
  maxResultSizeChars: number
  /**
   * When true, enables strict mode for this tool, which causes the API to
   * more strictly adhere to tool instructions and parameter schemas.
   * Only applied when the tengu_tool_pear is enabled.
   */
// strict 模式：让 API 更严格地遵循工具的参数 schema（减少模型乱传参数），仅在特定开关下生效。
  readonly strict?: boolean

  /**
   * Called on copies of tool_use input before observers see it (SDK stream,
   * transcript, canUseTool, PreToolUse/PostToolUse hooks). Mutate in place
   * to add legacy/derived fields. Must be idempotent. The original API-bound
   * input is never mutated (preserves prompt cache). Not re-applied when a
   * hook/permission returns a fresh updatedInput — those own their shape.
   */
// 在「给别人看的入参副本」上补字段（给 SDK 流、transcript、canUseTool、Pre/PostToolUse hook 用），必须幂等。
// 为什么要用副本：原始入参是要发给 API 的，改了它就会破坏 prompt cache（字节级必须一致才能命中缓存）。
// 所以这里只能在副本上做手脚；而 hook / 权限返回的 updatedInput 是「他们自己造的新对象」，不再重复施加。
  backfillObservableInput?(input: Record<string, unknown>): void

  /**
   * Determines if this tool is allowed to run with this input in the current context.
   * It informs the model of why the tool use failed, and does not directly display any UI.
   * @param input
   * @param context
   */
// 【② 能不能用】入参校验。与 checkPermissions 的分工：
//   这里校验「参数本身对不对、环境支不支持」（例如文件路径不存在、给定的行号越界），失败信息回灌给模型；
//   那里判断「要不要问用户」。执行顺序是先 validateInput，通过后才会走到权限检查（见上方英文注释）。
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  /**
   * Determines if the user is asked for permission. Only called after validateInput() passes.
   * General permission logic is in permissions.ts. This method contains tool-specific logic.
   * @param input
   * @param context
   */
// 【② 权限】工具自己的权限判断（唯一一个「必填」的权限相关方法）。
// 它只负责工具特有的逻辑（例如 Read 判断是否在允许目录内）；通用的 allow/deny/ask 规则在 permissions.ts，
// 由 toolExecution.ts 把两者结果合并。返回 PermissionResult（allow / deny / ask 之一）。
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  // Optional method for tools that operate on a file path
// 工具操作的文件路径。用途很广：权限规则匹配（Edit(src/**)）、去重、文件修改追踪、以及 hook 的 if 条件。
  getPath?(input: z.infer<Input>): string

  /**
   * Prepare a matcher for hook `if` conditions (permission-rule patterns like
   * "git *" from "Bash(git *)"). Called once per hook-input pair; any
   * expensive parsing happens here. Returns a closure that is called per
   * hook pattern. If not implemented, only tool-name-level matching works.
   */
// 为 hook 的 if 条件（形如 Bash(git *)）准备匹配器。
// 设计要点：昂贵的解析（编译 pattern）在这里做一次，返回一个闭包给每条规则复用——避免每条规则都重新解析一遍。
// 不实现的话，就只能做「工具名级别」的粗匹配（Bash 里具体是什么命令就匹配不到了）。
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>

// 【① 身份】生成写进 system prompt 的工具说明——相当于给模型看的「使用手册」。
// 入参里给了 getToolPermissionContext 等，是因为说明文案要随权限模式变化（例如 plan 模式下要提醒只能只读）。
  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
// 给用户看的友好名字（UI 上显示的标题），可以随入参变化（例如 Read 显示成 Reading src/foo.ts）。
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  userFacingNameBackgroundColor?(
    input: Partial<z.infer<Input>> | undefined,
  ): keyof Theme | undefined
  /**
   * Transparent wrappers (e.g. REPL) delegate all rendering to their progress
   * handler, which emits native-looking blocks for each inner tool call.
   * The wrapper itself shows nothing.
   */
// 透明包装器（如 REPL）：所有渲染都交给它的进度回调，由它为每个内部工具调用发出「看起来原生」的块，
// 包装器自己不显示任何东西——避免套娃式地把内层调用再包一层显示。
  isTransparentWrapper?(): boolean
  /**
   * Returns a short string summary of this tool use for display in compact views.
   * @param input The tool input
   * @returns A short string summary, or null to not display
   */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  /**
   * Returns a human-readable present-tense activity description for spinner display.
   * Example: "Reading src/foo.ts", "Running bun test", "Searching for pattern"
   * @param input The tool input
   * @returns Activity description string, or null to fall back to tool name
   */
// spinner 旁的进行时描述（现在进行时，如 Searching for pattern），让用户在等待时知道在干什么。
  getActivityDescription?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | null
  /**
   * Returns a compact representation of this tool use for the auto-mode
   * security classifier. Examples: `ls -la` for Bash, `/tmp/x: new content`
   * for Edit. Return '' to skip this tool in the classifier transcript
   * (e.g. tools with no security relevance). May return an object to avoid
   * double-encoding when the caller JSON-wraps the value.
   */
// 【⑦ 分类器输入】给 auto 模式安全分类器看的一句话摘要（如 ls -la、/tmp/x: new content）。
// 返回 '' 表示这个工具对安全判断没意义、直接跳过；可以返回对象以避免调用方再做一次 JSON 编码。
  toAutoClassifierInput(input: z.infer<Input>): unknown
// 【⑤ 结果转换】把工具的 Output 序列化成 API 需要的 tool_result 块（必填）。
// 这是「模型看到的最终结果」的生产者：无论是成功数据、错误提示还是落盘后的预览，都要从这里出去。
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam
  /**
   * Optional. When omitted, the tool result renders nothing (same as returning
   * null). Omit for tools whose results are surfaced elsewhere (e.g., TodoWrite
   * updates the todo panel, not the transcript).
   */
// 【⑥ UI】结果渲染。注意它是【可选】的：不实现就什么都不显示。
// 典型例子是 TodoWrite——它的结果体现在侧边 todo 面板里，不需要在对话流里再渲染一遍。
  renderToolResultMessage?(
    content: Output,
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
      isBriefOnly?: boolean
      /** Original tool_use input, when available. Useful for compact result
       * summaries that reference what was requested (e.g. "Sent to #foo"). */
      input?: unknown
    },
  ): React.ReactNode
  /**
   * Flattened text of what renderToolResultMessage shows IN TRANSCRIPT
   * MODE (verbose=true, isTranscriptMode=true). For transcript search
   * indexing: the index counts occurrences in this string, the highlight
   * overlay scans the actual screen buffer. For count ≡ highlight, this
   * must return the text that ends up visible — not the model-facing
   * serialization from mapToolResultToToolResultBlockParam (which adds
   * system-reminders, persisted-output wrappers).
   *
   * Chrome can be skipped (under-count is fine). "Found 3 files in 12ms"
   * isn't worth indexing. Phantoms are not fine — text that's claimed
   * here but doesn't render is a count≠highlight bug.
   *
   * Optional: omitted → field-name heuristic in transcriptSearch.ts.
   * Drift caught by test/utils/transcriptSearch.renderFidelity.test.tsx
   * which renders sample outputs and flags text that's indexed-but-not-
   * rendered (phantom) or rendered-but-not-indexed (under-count warning).
   */
// 给 transcript 全文检索用的纯文本。硬约束：必须与「屏幕上真正渲染出来的文字」完全一致，
// 否则会出现「搜索命中 3 处但高亮只有 2 处」的 phantom bug（少算可以接受，多算不行）。
// 不能用 mapToolResultToToolResultBlockParam 的输出顶替——那份是给模型看的，带了 system-reminder 等额外包装。
  extractSearchText?(out: Output): string
  /**
   * Render the tool use message. Note that `input` is partial because we render
   * the message as soon as possible, possibly before tool parameters have fully
   * streamed in.
   */
// 【⑥ UI】调用发生时渲染什么。关键细节：入参是 Partial<...>（部分字段），
// 因为模型是流式吐参数的，UI 想在第一个 token 到达时就显示点东西，此时参数还没完整——渲染必须能容忍残缺入参。
  renderToolUseMessage(
    input: Partial<z.infer<Input>>,
    options: { theme: ThemeName; verbose: boolean; commands?: Command[] },
  ): React.ReactNode
  /**
   * Returns true when the non-verbose rendering of this output is truncated
   * (i.e., clicking to expand would reveal more content). Gates
   * click-to-expand in fullscreen — only messages where verbose actually
   * shows more get a hover/click affordance. Unset means never truncated.
   */
// 非 verbose 渲染是否被截断：只有「点开确实能看到更多」的消息才给出展开入口，避免到处都是无效的点击提示。
  isResultTruncated?(output: Output): boolean
  /**
   * Renders an optional tag to display after the tool use message.
   * Used for additional metadata like timeout, model, resume ID, etc.
   * Returns null to not display anything.
   */
// 调用行尾的小标签，展示超时时间、模型名、resume id 之类元信息；返回 null 表示不显示。
  renderToolUseTag?(input: Partial<z.infer<Input>>): React.ReactNode
  /**
   * Optional. When omitted, no progress UI is shown while the tool runs.
   */
// 执行中的进度渲染（可选）：不实现就没有任何进行时 UI，工具看起来会「卡住」一段时间才出结果。
  renderToolUseProgressMessage?(
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      tools: Tools
      verbose: boolean
      terminalSize?: { columns: number; rows: number }
      inProgressToolCallCount?: number
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
// 排队等待时显示什么（例如被串行化后等待前面的工具跑完）。
  renderToolUseQueuedMessage?(): React.ReactNode
  /**
   * Optional. When omitted, falls back to <FallbackToolUseRejectedMessage />.
   * Only define this for tools that need custom rejection UI (e.g., file edits
   * that show the rejected diff).
   */
// 被拒绝时的自定义 UI。只对「需要展示被拒内容」的工具实现——最典型是 Edit：被拒也要把 diff 显示出来，
// 否则用户根本不知道自己拒绝了什么。其余工具用统一的 FallbackToolUseRejectedMessage。
  renderToolUseRejectedMessage?(
    input: z.infer<Input>,
    options: {
      columns: number
      messages: Message[]
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      progressMessagesForMessage: ProgressMessage<P>[]
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  /**
   * Optional. When omitted, falls back to <FallbackToolUseErrorMessage />.
   * Only define this for tools that need custom error UI (e.g., search tools
   * that show "File not found" instead of the raw error).
   */
// 出错时的自定义 UI。用途是把技术性错误翻译成人话（如把 ENOENT 显示成 File not found），
// 不实现就退回 FallbackToolUseErrorMessage 直接显示原始错误文本。
  renderToolUseErrorMessage?(
    result: ToolResultBlockParam['content'],
    options: {
      progressMessagesForMessage: ProgressMessage<P>[]
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
    },
  ): React.ReactNode

  /**
   * Renders multiple parallel instances of this tool as a group.
   * @returns React node to render, or null to fall back to individual rendering
   */
  /**
   * Renders multiple tool uses as a group (non-verbose mode only).
   * In verbose mode, individual tool uses render at their original positions.
   * @returns React node to render, or null to fall back to individual rendering
   */
// 把多个同类工具调用合并渲染成一屏（只在非 verbose 模式生效；verbose 下各调用保持在原位逐一显示）。
// 返回 null 表示不合并、按普通方式逐个渲染。典型场景：一次性并行读 10 个文件，合成一行「Read 10 files」。
  renderGroupedToolUse?(
    toolUses: Array<{
      param: ToolUseBlockParam
      isResolved: boolean
      isError: boolean
      isInProgress: boolean
      progressMessages: ProgressMessage<P>[]
      result?: {
        param: ToolResultBlockParam
        output: unknown
      }
    }>,
    options: {
      shouldAnimate: boolean
      tools: Tools
    },
  ): React.ReactNode | null
}
// 工具集合类型。刻意定义成 readonly Tool[] 的别名而不是直接用 Tool[]：
// 这样全局搜索 Tools 就能追踪「工具集在哪里被组装、传递、过滤」，是代码可维护性上的小心机。

/**
 * A collection of tools. Use this type instead of `Tool[]` to make it easier
 * to track where tool sets are assembled, passed, and filtered across the codebase.
 */
export type Tools = readonly Tool[]

/**
 * Methods that `buildTool` supplies a default for. A `ToolDef` may omit these;
 * the resulting `Tool` always has them.
 */
// 可以由 buildTool 兜底的字段名列表。写法是字符串字面量联合类型 'isEnabled' | 'isConcurrencySafe' | ...，
// 后面用 Omit / Pick 直接消费这个联合——相当于「字段名常量表」，编译期就能检查有没有写错字段名。
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

/**
 * Tool definition accepted by `buildTool`. Same shape as `Tool` but with the
 * defaultable methods optional — `buildTool` fills them in so callers always
 * see a complete `Tool`.
 */
// 工具的「定义形态」：和 Tool 一样，但把可兜底的那几个方法变成可选（Partial<Pick<...>>）。
// 好处：具体工具只写自己关心的部分（比如 Bash 必须写 isConcurrencySafe，Read 可以省掉 isEnabled），
// 剩下的由 buildTool 从 TOOL_DEFAULTS 补齐，最后对外仍然是一个字段完整的 Tool。
// `Omit<Tool, K> & Partial<Pick<Tool, K>>` 读法：先去掉那几个键，再以「可选」的形式把它们加回来。
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * Type-level spread mirroring `{ ...TOOL_DEFAULTS, ...def }`. For each
 * defaultable key: if D provides it (required), D's type wins; if D omits
 * it or has it optional (inherited from Partial<> in the constraint), the
 * default fills in. All other keys come from D verbatim — preserving arity,
 * optional presence, and literal types exactly as `satisfies Tool` did.
 */
// 类型层的「对象展开」：精确模拟运行时的 { ...TOOL_DEFAULTS, ...def }。
// 逐键判断（K extends keyof D ? ... : ...）≈ 编译期三元表达式：D 里提供了就用 D 的，没提供就用默认的。
// 末尾的 -? 把「可选」去掉，保证产出的 Tool 这些字段一定存在（调用方就不用再写 ?. 判空了）。
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * Build a complete `Tool` from a partial definition, filling in safe defaults
 * for the commonly-stubbed methods. All tool exports should go through this so
 * that defaults live in one place and callers never need `?.() ?? default`.
 *
 * Defaults (fail-closed where it matters):
 * - `isEnabled` → `true`
 * - `isConcurrencySafe` → `false` (assume not safe)
 * - `isReadOnly` → `false` (assume writes)
 * - `isDestructive` → `false`
 * - `checkPermissions` → `{ behavior: 'allow', updatedInput }` (defer to general permission system)
 * - `toAutoClassifierInput` → `''` (skip classifier — security-relevant tools must override)
 * - `userFacingName` → `name`
 */
// 工具的缺省实现集合。设计原则是【fail-closed（失败时按最保守处理）】：
//   isEnabled → true（默认可用）
//   isConcurrencySafe → false（默认【不能】并发：宁可慢，也不能让两个写操作互相覆盖）
//   isReadOnly → false（默认【当作会写】：不确定的就按有副作用处理）
//   isDestructive → false
//   checkPermissions → 直接 allow，把决定权交给通用权限系统
//   toAutoClassifierInput → ''（默认跳过安全分类器：真正有安全影响的工具必须自己实现，不能靠兜底蒙混）
//   userFacingName → ''（下面 buildTool 会把它覆盖成 def.name）
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

// The defaults type is the ACTUAL shape of TOOL_DEFAULTS (optional params so
// both 0-arg and full-arg call sites type-check — stubs varied in arity and
// tests relied on that), not the interface's strict signatures.
// 注意这里取的是 TOOL_DEFAULTS 的【实际】类型（参数全是可选的，好让 0 参和全参的调用点都能通过类型检查），
// 而不是接口里那些严格签名。历史原因：各处的 stub 参数个数不一致，测试还依赖这种宽松性。
type ToolDefaults = typeof TOOL_DEFAULTS

// D infers the concrete object-literal type from the call site. The
// constraint provides contextual typing for method parameters; `any` in
// constraint position is structural and never leaks into the return type.
// BuiltTool<D> mirrors runtime `{...TOOL_DEFAULTS, ...def}` at the type level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// 约束位上的 any 只是「结构性的」，用来给方法参数提供上下文类型推导，不会泄漏到返回类型里。
// 真正的返回值由 BuiltTool<D> 精确推导出来，所以调用方拿到的依然是强类型。
type AnyToolDef = ToolDef<any, any, any>

/** 由一个「部分定义」造出完整 Tool：把 TOOL_DEFAULTS 铺在下面，再用具体工具的定义覆盖。
 *  为什么要有它：以前每个工具都得把 isEnabled/isReadOnly/toAutoClassifierInput 这些无聊的桩方法抄一遍，
 *  而且调用方到处写 `tool.isEnabled?.() ?? true`。集中到这一处之后，默认值只有一个来源，调用方不用再判空。
 *  入参 def：工具定义（只需写自己关心的字段，可兜底的那几个可以省略）
 *  返回 BuiltTool<D>：类型上等价于「默认值与定义按展开规则合并」后的完整工具
 *  关键步骤：
 *    ① 展开 TOOL_DEFAULTS 作为基座
 *    ② 用 () => def.name 覆盖 userFacingName（默认只能返回空串，因为 defaults 里拿不到工具名）
 *    ③ 再展开 def，让具体工具的定义覆盖所有默认值
 *    ④ 用 as BuiltTool<D> 桥接：运行时的展开很简单，但类型层面要把「结构性 any 约束」收敛成精确的 BuiltTool<D>
 *  注意顺序不能反：...def 必须在最后，否则默认值会把工具自己的实现覆盖掉。
 */
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  // The runtime spread is straightforward; the `as` bridges the gap between
  // the structural-any constraint and the precise BuiltTool<D> return. The
  // type semantics are proven by the 0-error typecheck across all 60+ tools.
  return {
// 运行期就是一次普通的对象展开（后面的覆盖前面的）；as 只是告诉编译器「相信我，这就是 BuiltTool<D>」。
// 之所以敢这么断言：全仓库 60+ 个工具的类型检查 0 error，证明这套类型语义是成立的。
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
