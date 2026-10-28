/**
 * ============================================================================
 * 【一句话定位】
 * ============================================================================
 * 本文件是 Claude Code 对外的「SDK 门面」：把一个会话（conversation）的全部状态
 * （消息历史、已读文件缓存、token 用量、权限拒绝记录）装进 class QueryEngine，
 * 并把引擎内部产生的内部消息（Message / StreamEvent）翻译成对外承诺的
 * SDKMessage 事件流。headless / -p / Agent SDK 三条路都从这里进出。
 *
 * ============================================================================
 * 【在架构中的位置】调用链
 * ============================================================================
 *   入口层：entrypoints/sdk.ts / print.ts（非交互） 或 UI 层 REPL.tsx（交互）
 *        │
 *        ▼
 *   ask()                        ← 本文件底部的一次性便利包装：new 一个
 *        │                        QueryEngine，再把它的事件 yield* 转发出来
 *        ▼
 *   QueryEngine.submitMessage()  ← 本文件核心（约 950 行）。负责：
 *        │                        · 装配 system prompt / userContext / systemContext
 *        │                        · 处理用户输入、附件、slash command
 *        │                        · 注册工具与结构化输出钩子
 *        │                        · 把内部事件翻译成 SDKMessage
 *        │                        · 会话持久化（transcript）与收尾 result 事件
 *        ▼
 *   src/query.ts 的 query()      ← 内部真正的「模型 ↔ 工具」主循环（agentic loop）
 *        │
 *        ▼
 *   src/services/api/claude.ts   ← 发 HTTP 请求、解析 SSE 流、重试、用量统计
 *
 *   QueryEngine 与 query.ts 的职责分工（读码时最容易混淆的地方）：
 *   ┌─────────────────────────┬───────────────────────────────────────────┐
 *   │ QueryEngine（本文件）   │ query.ts                                  │
 *   ├─────────────────────────┼───────────────────────────────────────────┤
 *   │ 对外：产出 SDK 事件     │ 对内：产出内部 Message / StreamEvent      │
 *   │ 会话状态管理（有状态）  │ 无状态：靠一个 State 对象在循环间传递     │
 *   │ 消息规整 normalizeMessage│ 消息生成：组 prompt、跑工具、压缩上下文   │
 *   │ 边界 = 用户的一次提问   │ 边界 = 一次提问内部可能有 N 轮工具往返    │
 *   │ 计费 / 用量 / 落盘      │ 只管把循环跑完，返回 Terminal             │
 *   └─────────────────────────┴───────────────────────────────────────────┘
 *   Java 类比：QueryEngine ≈ Controller（协议转换 + 会话状态），
 *              query.ts     ≈ Service 里的 while 循环（业务流程）。
 *
 * ============================================================
 * 【本文件包含什么】
 * ============================================================
 * · type QueryEngineConfig —— 构造 QueryEngine 所需的全部依赖（≈ 手写的 DI 容器）
 * · class QueryEngine      —— 一个会话一个实例，公开方法：
 *     - submitMessage()    异步生成器：提交一次用户输入，持续产出 SDKMessage
 *     - interrupt()        中断当前请求（abort 掉 AbortController）
 *     - getMessages()      取当前会话的完整（只读）消息历史
 *     - getReadFileState() 取文件读取缓存（给 /undo、改动检测用）
 *     - getSessionId()     取当前 session id
 *     - setModel()         运行时切换模型（下一次提问生效）
 * · ask()                  —— 一次性调用的便利函数：new QueryEngine 并转发其事件
 *
 * ============================================================
 * 【TS 语法速查】本文件实际出现的写法，逐条对照 Java
 * ============================================================
 * 1.  类型标注在变量名「后面」：`let x: number = 1`；Java 在前面 `int x = 1`。
 *     这是 Java 工程师最容易看串的一点，读函数签名时尤其注意。
 * 2.  `type X = { a: string; b?: number }` ≈ Java record，但它是「结构化鸭子类型」：
 *     只要字段结构对得上就能赋值，不要求真的 implements 同一个接口。
 *     字段后的 `?` 表示可选（等价于 a: number | undefined）。
 * 3.  `A | B` 联合类型 ≈ Java sealed interface + 模式匹配。必须先「收窄」
 *     （switch (x.type) 或 if (x.type === 'assistant')）才能访问各自独有的字段。
 * 4.  `?.` 可选链 ≈ 一串 null 检查：`a?.b?.c` ≈ a!=null && a.b!=null ? a.b.c : null。
 * 5.  `??` 空值合并：只有 null / undefined 才取右边。与 `||` 的关键区别——
 *     `0`、`''`、`false` 不会被 `??` 替换，却会被 `||` 替换。
 *     本文件 `message.error.status ?? null` 就是冲着这个语义来的。
 * 6.  `!` 非空断言 ≈ 强制类型转换：只骗编译器，运行时不检查（照样可能炸）。
 *     例：snipProjection!.isSnipBoundaryMessage(...)，靠外层 feature() 保证非 null。
 * 7.  `as X` ≈ 强制类型转换（编译期，运行时擦除）。`as const` 表示「字面量类型」，
 *     把 'compact_boundary' 从 string 收窄成字面量常量，好塞进联合类型。
 * 8.  `{ ...obj }` 展开 ≈ 不可变更新（copy-on-write），Java 要手写 builder。
 *     `{ ...prev, fileHistory: updated }` ≈ 复制 prev 再覆盖一个字段。
 *     数组同理：`[...arr, newItem]`；`f(...arr)` 是把数组元素逐个当实参传进去。
 * 9.  `x is T` 类型谓词 ≈ Java 的 instanceof 模式匹配：函数返回 true 时编译器
 *     自动把 x 收窄成 T。本文件用到 isResultSuccessful(result, lastStopReason)。
 * 10. `async function*` + `yield` + `yield*`：异步生成器 ≈ Reactor 的 Flux。
 *     `yield v` 吐一个元素；`yield* gen` 把另一个生成器的元素「平铺」进来
 *     （≈ flatMap，不是把 gen 整体当一个值吐出去——这是最常见的写错点）。
 *     消费端 `for await (const x of gen)` ≈ 订阅后逐个处理。
 *     返回类型 AsyncGenerator<T, void, unknown>：T = 产出类型，void = return 值类型。
 * 11. `feature('X')` 是「编译期 #ifdef」而不是运行时 if：打包时分支被整体删掉
 *     （dead code elimination），所以同一个变量在产物里恒为常量。
 * 12. `using x = ...` ≈ try-with-resources（本文件没出现，query.ts 里有）。
 * 13. `.at(-1)` 取最后一个元素（Java 要 arr.get(arr.size()-1)）。
 *     同理 `findLast` / `findLastIndex` 是从后往前找。
 * 14. `private` / `public` 与 Java 同义，但可省略（默认 public）。
 *     TS 还有「参数属性」写法 `constructor(private x: T)`，一行声明字段；
 *     本文件没用这招，是在 constructor 体里手写的赋值。
 * 15. 函数类型字段：`setAppState: (f: (prev: AppState) => AppState) => void`
 *     ≈ Function<Function<AppState,AppState>, Void>，高阶函数（函数接收函数）。
 * 16. `void promise` ≈ 显式声明「我知道它是 Promise 但我不 await」（fire-and-forget），
 *     用来告诉 linter 不是忘了 await。
 * 17. `switch (message.type) { case 'assistant': ... }` 内 message 会自动窄化，
 *     可以直接访问该类型独有的字段——这叫判别联合（discriminated union）。
 * 18. 模板字符串：反引号 + ${}，`` `<${TAG}>` `` ≈ Java 的 String.format / 文本块。
 * 19. `Promise.all([a(), b()])` ≈ CompletableFuture.allOf，并行等两件事。
 * 20. 解构时给默认值：`const { verbose = false } = cfg` ≈ Optional.orElse，
 *     但只对 undefined 生效（null 不会被替换）。
 * 21. `Set<string>` / `Map<K,V>` 与 Java 同义；`new Set()` 后 add/has 用法一致。
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import { accumulateUsage, updateUsage } from 'src/services/api/claude.js'
import type { NonNullableUsage } from 'src/services/api/logging.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import { countToolCalls, SYNTHETIC_MESSAGES } from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

// 【中文】延迟 require：MessageSelector.tsx 会顺带拉进 React/ink（很重的依赖），
// 而它只在「查询时过滤消息」这一处用得上。所以这里存的是一个「返回模块的函数」，
// 而不是模块本身——调用 messageSelector() 时才真的 require（懒加载）。
// TS 对照：返回类型写 `typeof import('...')`，≈ Java 里 Class.forName 的编译期类型标注。
// Lazy: MessageSelector.tsx pulls React/ink; only needed for message filtering at query time
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector =
  (): typeof import('src/components/MessageSelector.js') =>
    require('src/components/MessageSelector.js')

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// 【中文】feature('COORDINATOR_MODE') 是「编译期开关」（≈ C 的 #ifdef）：打包时若为 false，
// require('./coordinator/coordinatorMode.js') 这一整支会被删掉（dead code elimination），
// 该模块根本不会进产物。所以别把它当运行时 if 读——运行时它恒为常量。
// 三元表达式的 false 分支给了空实现 () => ({})，是为了让函数签名始终存在、类型不缺口。
// Dead code elimination: conditional import for coordinator mode
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

// Dead code elimination: conditional import for snip compaction
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const snipProjection = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipProjection.js') as typeof import('./services/compact/snipProjection.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 【中文】QueryEngineConfig —— 构造一个 QueryEngine 所需的全部依赖。
 *
 * 定位：这就是一个手写的「依赖注入容器」。QueryEngine 自己不 new 任何东西，
 * 所有外部世界（工具、命令、MCP 客户端、权限判定、AppState 读写）都从这里传进来。
 * 好处：① 单测可以随便塞假实现；② 交互 REPL 与 headless/SDK 可以共用同一套引擎。
 *
 * TS 对照：这是一个「对象类型」（≈ Java record / 一个纯数据的 DTO），
 * 带 `?` 的字段是可选的（≈ 可以为 null，但语义上是「没传」而不是「传了 null」）。
 */
export type QueryEngineConfig = {
// 【中文】当前工作目录。每次 submitMessage 开头都会 setCwd(cwd) 同步给全局单例。
  cwd: string
// 【中文】本次会话可用的全部工具（内置工具 + MCP 工具 + 插件工具）。
  tools: Tools
// 【中文】slash command 列表（/help、/compact、/model 之类）。
  commands: Command[]
// 【中文】已经连上的 MCP server 客户端列表。
  mcpClients: MCPServerConnection[]
// 【中文】可用的 subagent 定义（AgentTool 派生子任务时用）。
  agents: AgentDefinition[]
// 【中文】权限判定函数：每次工具真正执行前都会问它「允不允许」。
  canUseTool: CanUseToolFn
// 【中文】读全局可变状态（≈ getter）。AppState 里有权限上下文、fileHistory、attribution 等。
  getAppState: () => AppState
// 【中文】写全局状态：接收一个 updater（prev => next），由实现方合并后写回。
// 高阶函数，≈ Java 的 Function<Function<AppState,AppState>, Void>，用法同 React 的 setState(fn)。
  setAppState: (f: (prev: AppState) => AppState) => void
// 【中文】恢复会话时传入的历史消息（--resume / --continue）。注意是直接持有引用，后续会被 push。
  initialMessages?: Message[]
// 【中文】文件读取缓存。引擎内部会持续修改它；ask() 里会先 clone 一份再传进来，避免污染调用方。
  readFileCache: FileStateCache
// 【中文】调用方自定义系统提示词：传了就是「替换」默认提示词，不是追加。
  customSystemPrompt?: string
// 【中文】在（自定义或默认）系统提示词「之后」再追加的一段文本。
  appendSystemPrompt?: string
// 【中文】用户显式指定的模型（profile 名或模型 id）；不传就用默认主循环模型。
  userSpecifiedModel?: string
// 【中文】兜底模型：主模型过载/降级时自动切过去（由 withRetry 触发）。
  fallbackModel?: string
// 【中文】thinking（思考模式）配置：adaptive / enabled / disabled。不传则按默认策略推断。
  thinkingConfig?: ThinkingConfig
// 【中文】本轮最多允许多少次「模型 ↔ 工具」往返；超了就发 max_turns_reached 并结束。
  maxTurns?: number
// 【中文】本轮 USD 花费上限（熔断用）。注意比较的是「累计花费」，不是单次请求花费。
  maxBudgetUsd?: number
// 【中文】API 侧的 task_budget（output_config.task_budget，beta 特性）。
// 注意：它和本地那个「token 预算用尽自动 +500k 续跑」是两套完全不同的东西，别混。
  taskBudget?: { total: number }
// 【中文】Record<string, unknown> ≈ Java 的 Map<String, Object>。
// 一旦传了就启用「结构化输出」模式：模型必须最终产出一个符合该 schema 的 JSON。
  jsonSchema?: Record<string, unknown>
// 【中文】是否输出详细日志。headless 下 stdout 往往是协议通道，开它会污染输出。
  verbose?: boolean
// 【中文】是否把用户消息「回放」给 SDK 调用方（部分客户端需要自己重放一遍原始输入）。
  replayUserMessages?: boolean
// 【中文】MCP 工具返回 -32042（需要用户去某个 URL 完成授权）时的处理回调。
  /** Handler for URL elicitations triggered by MCP tool -32042 errors. */
  handleElicitation?: ToolUseContext['handleElicitation']
// 【中文】是否透传流式中间事件（stream_event）。开了一轮下来事件量很大，默认关。
  includePartialMessages?: boolean
// 【中文】把 SDK 状态（compacting / searching 等）回传给调用方做 UI 展示。
  setSDKStatus?: (status: SDKStatus) => void
// 【中文】外部注入的中断信号；不传就自己 new 一个。多个组件共享同一个时，一处 abort 全停。
  abortController?: AbortController
// 【中文】「孤儿权限」：上个进程遗留下来、还没裁决的权限请求，需要在新会话里补处理一次。
  orphanedPermission?: OrphanedPermission
  /**
   * Snip-boundary handler: receives each yielded system message plus the
   * current mutableMessages store. Returns undefined if the message is not a
   * snip boundary; otherwise returns the replayed snip result. Injected by
   * ask() when HISTORY_SNIP is enabled so feature-gated strings stay inside
   * the gated module (keeps QueryEngine free of excluded strings and testable
   * despite feature() returning false under bun test). SDK-only: the REPL
   * keeps full history for UI scrollback and projects on demand via
   * projectSnippedView; QueryEngine truncates here to bound memory in long
   * headless sessions (no UI to preserve).
   */
// 【中文】snip 边界回调，由 ask() 注入。为什么用回调而不是直接 import？
// 因为 snip 相关的字符串是 feature 门控的，写在本文件会让「排除字符串」检查失败，
// 而且 feature() 在 bun test 下恒为 false，直接 import 就没法测了。
// 返回值语义：undefined = 这条消息不是 snip 边界，按普通 system 消息处理。
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine owns the query lifecycle and session state for a conversation.
 * It extracts the core logic from ask() into a standalone class that can be
 * used by both the headless/SDK path and (in a future phase) the REPL.
 *
 * One QueryEngine per conversation. Each submitMessage() call starts a new
 * turn within the same conversation. State (messages, file cache, usage, etc.)
 * persists across turns.
 */
/**
 * 【中文】class QueryEngine —— 一个会话（conversation）对应一个实例。
 *
 * 它做三件事：
 *   ① 会话状态管理：消息历史、已读文件缓存、累计 token 用量、被拒权限列表；
 *   ② 对外 SDK 事件产出：把 query() 吐出的内部消息翻译成 SDKMessage；
 *   ③ 消息规整：把内部 Message 归一化（normalizeMessage）后逐个 yield 出去。
 *
 * 生命周期：new QueryEngine(config) → 多次 submitMessage()（每调用一次 = 一轮对话）
 * → interrupt() 可随时中断。状态跨轮保留，这是它与一次性 ask() 的关键区别。
 *
 * TS 对照：`private x: T = ...` 与 Java 完全一致；字段必须显式初始化（strict 模式下
 * 没有初始化的字段必须标注 `| undefined`，否则编译报错）。
 */
export class QueryEngine {
  // 【中文】依赖注入进来的全部配置。注意它是可变的：setModel() 会直接改它的字段。
  private config: QueryEngineConfig
  // 【中文】会话的权威消息历史。getMessages() 返回的是 readonly 视图，
  // 但底层就是同一个数组（不是拷贝）—— readonly 只是编译期约束。
  private mutableMessages: Message[]
  // 【中文】整个会话共用一个中断信号；interrupt() 干的事就是 abort 它。
  private abortController: AbortController
  // 【中文】累积所有被拒绝的工具调用，最后塞进 result.permission_denials 回传给调用方。
  private permissionDenials: SDKPermissionDenial[]
  // 【中文】跨 turn 累计的 token 用量（不随单条消息清零，跨 submitMessage 也保留）。
  private totalUsage: NonNullableUsage
  // 【中文】一次性开关：孤儿权限在一整个 engine 生命周期里只补处理一次。
  private hasHandledOrphanedPermission = false
  // 【中文】已读文件的状态缓存：支撑 /undo 回滚和「文件被外部改了」的检测提示。
  private readFileState: FileStateCache
  // 【中文】本轮已发现的 skill 名字集合（喂给埋点 was_discovered）。
  // 每次 submitMessage 开头都会 clear()，防止 SDK 长会话里多轮累积导致无限膨胀。
  // Turn-scoped skill discovery tracking (feeds was_discovered on
  // tengu_skill_tool_invocation). Must persist across the two
  // processUserInputContext rebuilds inside submitMessage, but is cleared
  // at the start of each submitMessage to avoid unbounded growth across
  // many turns in SDK mode.
  private discoveredSkillNames = new Set<string>()
  // 【中文】Set<string> ≈ HashSet<String>。跨 turn 记住已加载过的嵌套记忆路径，避免重复注入。
  private loadedNestedMemoryPaths = new Set<string>()

/**
 * 【中文】构造函数。
 *
 * TS/Java 差异：这里只有一个参数 config，但它是个对象——这是 TS 的「命名参数」惯用法，
 * 用来避免 `new QueryEngine(a, b, c, d, e...)` 记不住顺序的问题（≈ Java 的 Builder）。
 *
 * 注意下面几处都是「直接持有传入引用」而不是拷贝：调用方传进来的数组/缓存
 * 会被引擎就地修改。需要隔离时（如 ask()）由调用方自己先 clone。
 */
  constructor(config: QueryEngineConfig) {
    this.config = config
    // 【中文】?? 空值合并：没传 initialMessages 就用空数组。注意这是直接持有引用。
    this.mutableMessages = config.initialMessages ?? []
    // 【中文】允许外部注入 abortController（多个组件共享同一个中断信号）；不注入才自建。
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    // 【中文】注意是「直接引用」不是 clone——clone 发生在 ask() 里，由调用方负责。
    this.readFileState = config.readFileCache
    // 【中文】EMPTY_USAGE 是共享的零值常量，避免每次 new 一个空用量对象。
    this.totalUsage = EMPTY_USAGE
  }

/**
 * 【中文】submitMessage() —— 提交一次用户输入，并以异步生成器方式持续产出 SDKMessage。
 *
 * 这是全文件（也是整个仓库）第二核心的函数：一次调用 = 一轮完整的 Agent 交互。
 * 它是 `async *`（异步生成器）：调用方用 `for await (const msg of engine.submitMessage(...))`
 * 逐个取事件，取到一个就能立刻渲染，不用等整轮跑完。
 *
 * 返回值 AsyncGenerator<SDKMessage, void, unknown>：产出 SDKMessage，没有 return 值。
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ submitMessage() 分阶段导航图（先记骨架，再看 950 行代码就不迷路）          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *  ① 初始化
 *     ├─ 解构 this.config（把 DI 进来的参数摊平成局部变量）
 *     ├─ discoveredSkillNames.clear() / setCwd(cwd) / startTime = Date.now()
 *     └─ 包装 canUseTool：所有「非 allow」的判定都记进 permissionDenials
 *                                                                       ↓
 *  ② 系统提示词装配
 *     ├─ initialMainLoopModel：用户指定 > 默认主循环模型
 *     ├─ initialThinkingConfig：显式 > 默认策略 > disabled
 *     ├─ fetchSystemPromptParts() → defaultSystemPrompt / userContext / systemContext
 *     ├─ 叠加 coordinator 上下文、memory 机制提示、调用方 appendSystemPrompt
 *     └─ asSystemPrompt([...]) 拼成最终的 systemPrompt（后写的优先级更高）
 *                                                                       ↓
 *  ③ 工具与钩子注册
 *     └─ 传了 jsonSchema 且有结构化输出工具 → registerStructuredOutputEnforcement()
 *                                                                       ↓
 *  ④ 用户输入处理（processUserInputContext 第 1 次构建）
 *     ├─ 先补处理「孤儿权限」（一生只一次）
 *     ├─ processUserInput()：展开 slash command、skill、附件、命令替换
 *     ├─ push 进 mutableMessages，并「抢在进循环前」写 transcript（保证可 --resume）
 *     ├─ 算出 replayableMessages（哪些用户消息要回放到 SDK）
 *     ├─ 把 allowedTools 同步进 AppState.toolPermissionContext
 *     └─ 用更新后的 messages / model 重建 processUserInputContext（第 2 次构建）
 *                                                                       ↓
 *  ⑤ 技能 / 插件发现 + 产出 system init 事件
 *     ├─ Promise.all([getSlashCommandToolSkills(), loadAllPluginsCacheOnly()])
 *     └─ yield buildSystemInitMessage(...)   ← SDK 调用方收到的第一条消息
 *                                                                       ↓
 *  ⑥ 短路出口：!shouldQuery（本地 slash command 已经把事办完了，不用问模型）
 *     ├─ 把本地命令输出 / 压缩边界转成 SDKMessage 逐条 yield
 *     └─ yield result(success) 然后 return
 *                                                                       ↓
 *  ⑦ 进入 query 循环（真正的 agentic loop 在 src/query.ts，不在这里）
 *     └─ for await (const message of query({ ... }))
 *                                                                       ↓
 *  ⑧ 消费事件并翻译成 SDK 消息（本方法最长的一段）
 *     ├─ 落盘：assistant / user / compact_boundary → recordTranscript
 *     ├─ switch (message.type)：
 *     │    tombstone             忽略（内部「删除消息」信令，不对外）
 *     │    assistant             记 stop_reason，push + yield* normalizeMessage()
 *     │    progress              落盘 + 转发
 *     │    user                  push + 转发（并 turnCount++）
 *     │    stream_event          累计 usage；includePartialMessages 时透传
 *     │    attachment            取结构化输出 / max_turns_reached / queued_command
 *     │    stream_request_start  忽略（一次 HTTP 请求开始的纯内部信号）
 *     │    system                snip 回放 / compact_boundary / api_error→api_retry
 *     │    tool_use_summary      转发
 *     └─ 每轮末尾两个熔断检查：累计 USD 超预算 / 结构化输出重试次数超限
 *                                                                       ↓
 *  ⑨ 收尾
 *     ├─ messages.findLast(assistant | user) 取「最终结果」消息
 *     ├─ flushSessionStorage()（桌面端收到 result 就杀进程，必须先刷盘）
 *     ├─ 判定失败 → yield result(error_during_execution) 并 return
 *     └─ 判定成功 → 抽出最后一段 text → yield result(success)
 *
 * 口诀：装提示词 → 理输入 → 进循环 → 翻译事件 → 出结果。
 *
 * @param prompt  用户输入。可以是纯字符串，也可以是 ContentBlockParam[]（多模态：图文混排）
 * @param options.uuid   调用方指定的消息 id（用于去重 / 回放对齐）
 * @param options.isMeta 是否为「元消息」（系统内部注入的提示，不是用户真实输入）
 */
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    this.discoveredSkillNames.clear()
    // 【中文】每轮开头清空本轮的 skill 发现集合（跨轮不累积）。
    // setCwd 是把工作目录同步给全局单例 Shell —— 很多工具靠它决定相对路径怎么解析。
    setCwd(cwd)
    // 【中文】是否要把会话写进 transcript（某些 CI / --no-session-persistence 场景会关掉）。
    const persistSession = !isSessionPersistenceDisabled()
    // 【中文】整轮耗时基准，最后 result.duration_ms 用它算。
    const startTime = Date.now()

    // 【中文】装饰器模式：包一层 canUseTool，唯一目的是在「拒绝」时留痕，
    // 原函数的行为完全不变（先原样调用，再判断结果）。
    // Wrap canUseTool to track permission denials
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // Track denials for SDK reporting
      // 【中文】behavior 是判别联合：allow / deny / ask。只要不是 allow 都算一次拒绝，
      // 因为 ask 最终若被用户否掉也会走到这里。
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    // 【中文】先快照一份 AppState 和模型，后面 result 事件里的 permission_mode / fast_mode
    // 都用这份「入口快照」，而不是循环中被改过的值（保证前后一致）。
    const initialAppState = getAppState()
    // 【中文】三元表达式：用户显式指定了就解析它，否则取默认主循环模型。
    // TS 的 `cond ? a : b` 与 Java 完全一致，可以整个当一个表达式用。
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    // 【中文】嵌套三元（≈ Java 的三元链式）：显式传了 > 默认策略允许 > 关闭。
    // `shouldEnableThinkingByDefault() !== false` 故意写成 !== false：
    // 因为该函数可能返回 undefined，只有明确 === false 才算「关」。
    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    // 【中文】headless 启动耗时埋点（只在开了 profiling 时有意义，平时基本是 no-op）。
    headlessProfilerCheckpoint('before_getSystemPrompt')
    // Narrow once so TS tracks the type through the conditionals below.
    // 【中文】「收窄（narrowing）」技巧：把 string | undefined 存进一个 const，
    // TS 才会在后续的条件分支里记住它已经是 string（否则每次判断都要重新推导）。
    const customPrompt =
      typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    // 【中文】拉取系统提示词的各个片段：工具描述、MCP、额外工作目录等。
    // 注意这里是 await（有磁盘/网络 IO），是启动关键路径上最重的一步。
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    // 【中文】对象展开合并：后写的覆盖先写的（不可变更新写法，不改动 baseUserContext）。
    // 这里把 coordinator 模式（子代理协调）需要的上下文追加进 userContext。
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    // When an SDK caller provides a custom system prompt AND has set
    // CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, inject the memory-mechanics prompt.
    // The env var is an explicit opt-in signal — the caller has wired up
    // a memory directory and needs Claude to know how to use it (which
    // Write/Edit tools to call, MEMORY.md filename, loading semantics).
    // The caller can layer their own policy text via appendSystemPrompt.
    // 【中文】只有当「调用方给了自定义系统提示词」且「显式设了 memory 路径覆盖」时，
    // 才注入 memory 机制说明。理由：自定义提示词意味着默认提示词（含 memory 用法）被替换了，
    // 而设了路径覆盖说明调用方确实接了 memory 目录，得教模型怎么用。
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    // 【中文】三段拼接，顺序有语义：① 自定义（或默认）② memory 机制 ③ 调用方追加。
    // 后出现的在提示词里更靠后，通常对模型影响更强。
    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    // Register function hook for structured output enforcement
    // 【中文】tools.some(...) ≈ Java 的 stream().anyMatch(...)。
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    // 【中文】注册一个「函数 hook」：如果模型到点还没给出结构化输出，
    // 就靠这个 hook 强制它再补一次（StructuredOutput 工具的兜底机制）。
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    // 【中文】构建 processUserInput 的上下文（一个很大的对象字面量）。
    // 注意它是 let：下面处理完 slash command 后会整体重建一次（见 ④ 的第 2 次构建）。
    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // Slash commands that mutate the message array (e.g. /force-snip)
      // call setMessages(fn).  In interactive mode this writes back to
      // AppState; in print mode we write back to mutableMessages so the
      // rest of the query loop (push at :389, snapshot at :392) sees
      // the result.  The second processUserInputContext below (after
      // slash-command processing) keeps the no-op — nothing else calls
      // setMessages past that point.
      // 【中文】只有会改消息数组的 slash command（如 /force-snip）才会走这里，
      // 所以给它一个写回 mutableMessages 的口子；其他情况这个回调没人调。
      setMessages: fn => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      // 【中文】headless 下没有「换 API key」的交互，填空实现。不能省略——类型是必填函数。
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
      // 【中文】headless 模式下 stdout 就是协议通道，任何 debug 输出都会污染它，故强制关掉。
        debug: false, // we use stdout, so don't want to clobber it
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
      // 【中文】关键标志位：告诉下游「这是非交互会话」，
      // 于是下游不会弹权限确认、不会反问用户，缺权限就直接拒绝。
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
      // 【中文】allAgents 传空数组：headless 不做 agent 名字补全（没有交互 UI 需要它）。
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      // 【中文】高阶函数：接收一个 updater，内部再包一层 setAppState。
      // `if (updated === prev.fileHistory) return prev` 是「引用相等短路」——
      // 没变化就返回原对象，避免触发无谓的重算/重渲染（≈ Java 里用 == 判断同引用）。
      updateFileHistoryState: (
        updater: (prev: FileHistoryState) => FileHistoryState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (
        updater: (prev: AttributionState) => AttributionState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    // Handle orphaned permission (only once per engine lifetime)
    // 【中文】孤儿权限：上个进程被杀时留下来的、还没裁决的权限请求。
    // 这里补着处理一次，并把结果消息直接 yield 出去。
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      // 【中文】先置位再处理：handleOrphanedPermission 内部可能重入，防止重复 yield。
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    // 【中文】把用户输入「规整」成一串消息：展开 slash command、skill、附件、命令替换等。
    // 返回的 shouldQuery=false 表示本地命令就办完了，压根不用去问模型。
    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      // 【中文】没有 UI，渲染 JSX 的回调只能填空实现。
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      // 【中文】来源标记，用于埋点和行为区分（'sdk' / 'repl_main_thread' / 'agent:xxx'）。
      querySource: 'sdk',
    })

    // Push new messages, including user input and any attachments
    // 【中文】`...arr` 展开：把数组元素逐个 push 进去，
    // 而不是 push 一个数组进去（写成 push(messagesFromUserInput) 就错了）。
    this.mutableMessages.push(...messagesFromUserInput)

    // Update params to reflect updates from processing /slash commands
    // 【中文】快照一份「本轮循环用」的局部数组。
    // mutableMessages 是跨轮的权威历史，messages 是本轮落盘/查找用的工作副本。
    const messages = [...this.mutableMessages]

    // Persist the user's message(s) to transcript BEFORE entering the query
    // loop. The for-await below only calls recordTranscript when ask() yields
    // an assistant/user/compact_boundary message — which doesn't happen until
    // the API responds. If the process is killed before that (e.g. user clicks
    // Stop in cowork seconds after send), the transcript is left with only
    // queue-operation entries; getLastSessionLog filters those out, returns
    // null, and --resume fails with "No conversation found". Writing now makes
    // the transcript resumable from the point the user message was accepted,
    // even if no API response ever arrives.
    //
    // --bare / SIMPLE: fire-and-forget. Scripted calls don't --resume after
    // kill-mid-request. The await is ~4ms on SSD, ~30ms under disk contention
    // — the single largest controllable critical-path cost after module eval.
    // Transcript is still written (for post-hoc debugging); just not blocking.
    // 【中文】关键坑：必须「抢在进循环前」把用户消息落盘。
    // 否则进程在 API 响应前被杀（用户在 cowork 点了 Stop），transcript 里只剩队列操作记录，
    // getLastSessionLog 过滤掉它们后返回 null，--resume 直接报「找不到会话」。
    // --bare 模式改成 fire-and-forget（void）：脚本化调用不会中途 kill 后再 resume，
    // 而这次 await 是启动关键路径上最大的一笔可控开销（SSD 约 4ms，磁盘争用时约 30ms）。
    if (persistSession && messagesFromUserInput.length > 0) {
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode()) {
        void transcriptPromise
      } else {
        await transcriptPromise
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }
    }

    // Filter messages that should be acknowledged after transcript
    // 【中文】筛出「需要回放到 SDK 调用方」的消息。
    // 排除项都有讲究：isMeta（系统合成的提示，不是用户原话）、toolUseResult（工具结果）。
    const replayableMessages = messagesFromUserInput.filter(
      msg =>
        (msg.type === 'user' &&
          !msg.isMeta && // Skip synthetic caveat messages
          !msg.toolUseResult && // Skip tool results (they'll be acked from query)
          messageSelector().selectableUserMessagesFilter(msg)) || // Skip non-user-authored messages (task notifications, etc.)
        (msg.type === 'system' && msg.subtype === 'compact_boundary'), // Always ack compact boundaries
    )
    // 【中文】replayUserMessages 是调用方开关；默认关，所以默认是空数组（什么都不回放）。
    const messagesToAck = replayUserMessages ? replayableMessages : []

    // Update the ToolPermissionContext based on user input processing (as necessary)
    // 【中文】把用户输入处理（如 /allowed-tools）得到的白名单命令写回 AppState。
    // 三层展开嵌套更新：AppState → toolPermissionContext → alwaysAllowRules → command。
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    // 【中文】?? 空值合并：slash command（如 /model）可能改了模型，改了就用新的，没改就用初始的。
    // 这里用 ?? 而不是 ||，是因为语义上只想在「确实没值」时回退。
    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // Recreate after processing the prompt to pick up updated messages and
    // model (from slash commands).
    // 【中文】为什么要重建整个上下文？三个原因：
    // ① 消息数组变了（用户输入刚 push 进去）；② 模型可能被 slash command 改了；
    // ③ setMessages 之后的路径不再需要写回能力。
    // 这是「不可变重建」的写法：不逐字段改，而是整体换一个新对象。
    processUserInputContext = {
      messages,
      // 【中文】第二次之后没人再改消息数组了，所以这里退化成空实现。
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    headlessProfilerCheckpoint('before_skills_plugins')
    // Cache-only: headless/SDK/CCR startup must not block on network for
    // ref-tracked plugins. CCR populates the cache via CLAUDE_CODE_SYNC_PLUGIN_INSTALL
    // (headlessPluginInstall) or CLAUDE_CODE_PLUGIN_SEED_DIR before this runs;
    // SDK callers that need fresh source can call /reload-plugins.
    // 【中文】两件慢事并行做（磁盘扫描 + 缓存读取），避免串行把启动延迟叠加。
    // 左侧解构是「数组解构 + 对象解构」嵌套：`[{ enabled: enabledPlugins }]` 顺便重命名了字段。
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')

    // 【中文】SDK 协议约定：第一条必须是 system/init，把工具清单、模型、权限模式、
    // 命令、agent、skill、插件状态一次性告诉调用方（客户端靠它初始化 UI）。
    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext
        .mode as PermissionMode, // TODO: avoid the cast
        // 【中文】`as PermissionMode` 是强制类型转换，没做运行时校验——是已知的技术债（见 TODO）。
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
      fastMode: initialAppState.fastMode,
    })

    // 【中文】埋点：system 消息已产出（headless 启动延迟分析用）。
    // Record when system message is yielded for headless latency tracking
    headlessProfilerCheckpoint('system_message_yielded')

    // 【中文】短路分支：本地 slash command（如 /help）已经给出答案，不需要问模型。
    // 注意这里用的是 messagesFromUserInput 而不是 replayableMessages——
    // 因为 selectableUserMessagesFilter 会把本地命令输出（stdout 标签）过滤掉。
    if (!shouldQuery) {
      // Return the results of local slash commands.
      // Use messagesFromUserInput (not replayableMessages) for command output
      // because selectableUserMessagesFilter excludes local-command-stdout tags.
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === 'user' &&
          typeof msg.message.content === 'string' &&
          (msg.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: 'user',
            message: {
              ...msg.message,
            // 【中文】stripAnsi：去掉终端颜色转义符，保证 SDK 调用方拿到的是纯文本。
              content: stripAnsi(msg.message.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
              // 【中文】压缩摘要不算「回放」：它是系统新生成的产物，不是用户的原话。
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as SDKUserMessageReplay
        }

        // 【中文】为什么本地命令输出要伪装成 assistant 消息？
        // 因为移动端客户端和 session-ingress 只认 assistant 文本，
        // 这样 /help 之类的输出才能在会话里正常显示为「助手说的一段话」。
        // Local command output — yield as a synthetic assistant message so
        // RC renders it as assistant-style text rather than a user bubble.
        // Emitted as assistant (not the dedicated SDKLocalCommandOutputMessage
        // system subtype) so mobile clients + session-ingress can parse it.
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        // 【中文】压缩边界也要透出，否则调用方手上的历史与我们内部的不一致。
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(msg.compactMetadata),
          } as SDKCompactBoundaryMessage
        }
      }

      // 【中文】本地命令路径也要落盘 + 刷盘（同上：客户端可能立刻杀进程）。
      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      // 【中文】本地命令路径的 result 事件：num_turns 直接用 messages.length - 1，
      // 因为压根没真正跑过模型 turn。
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        // 【中文】没有真实的 turn 计数，用消息条数近似。
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
      }
      return
    }

    // 【中文】给用户消息对应的文件做快照（支撑 /undo 之类的回滚）。
    // 只对「可选择的」用户消息做，避免给工具结果之类也建快照。
    if (fileHistoryEnabled() && persistSession) {
      messagesFromUserInput
        .filter(messageSelector().selectableUserMessagesFilter)
        .forEach(message => {
          // 【中文】`void` + Promise：故意不 await——快照是后台行为，不该阻塞主流程。
          void fileHistoryMakeSnapshot(
            (updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory),
              }))
            },
            message.uuid,
          )
        })
    }

    // 【中文】下面这一组 let 是本轮循环的累加器。
    // 生成器的局部变量在挂起（yield）期间会保留，所以能跨事件累积状态。
    // Track current message usage (reset on each message_start)
    // 【中文】单条消息的用量：message_start 重置 → message_delta 累加 → message_stop 汇总进 totalUsage。
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    // 【中文】轮次计数器：每收到一条 user 消息（= 一次工具结果往返）就 +1。
    let turnCount = 1
    // 【中文】保证「回放初始用户消息」只做一次，不重复 yield。
    let hasAcknowledgedInitialMessages = false
    // Track structured output from StructuredOutput tool calls
    // 【中文】StructuredOutput 工具给出的结构化结果，最后放进 result.structured_output。
    let structuredOutputFromTool: unknown
    // Track the last stop_reason from assistant messages
    // 【中文】最近一次 stop_reason。注意真值只在 message_delta 里才拿得到（见下面）。
    let lastStopReason: string | null = null
    // Reference-based watermark so error_during_execution's errors[] is
    // turn-scoped. A length-based index breaks when the 100-entry ring buffer
    // shift()s during the turn — the index slides. If this entry is rotated
    // out, lastIndexOf returns -1 and we include everything (safe fallback).
    // 【中文】用「引用」而不是「下标」做水位线，是因为内存错误日志是 100 条环形缓冲：
    // 满了会 shift()，下标会整体滑动，用下标就会错位。若这条被轮出去了，
    // lastIndexOf 返回 -1，+1 后变 0，退化成「全量输出」（安全兜底）。
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // Snapshot count before this query for delta-based retry limiting
    // 【中文】进入循环前的基线调用次数。后面用「当前 - 基线」算本轮重试了几次，
    // 这样多轮会话不会把上一轮的次数算进来。
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    // ★【中文】进入真正的 agentic loop（src/query.ts 的 query()）。
    // 本 for-await 只负责三件事：翻译事件、落盘、熔断检查。
    // 真正的「调模型 → 拿 tool_use → 跑工具 → 再调模型」循环不在这个文件里。
    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      // 【中文】传的是「包装后」的 canUseTool（带拒绝留痕），不是 config 里的原始版本。
      canUseTool: wrappedCanUseTool,
      // 【中文】ProcessUserInputContext 与 ToolUseContext 结构兼容（鸭子类型），
      // 所以可以直接当 ToolUseContext 传——不需要真的实现同一个接口。
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })) {
      // 【中文】需要落盘的三种消息类型：assistant、user、compact_boundary。
      // Record assistant, user, and compact boundary messages
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        // Before writing a compact boundary, flush any in-memory-only
        // messages up through the preservedSegment tail. Attachments and
        // progress are now recorded inline (their switch cases below), but
        // this flush still matters for the preservedSegment tail walk.
        // If the SDK subprocess restarts before then (claude-desktop kills
        // between turns), tailUuid points to a never-written message →
        // applyPreservedSegmentRelinks fails its tail→head walk → returns
        // without pruning → resume loads full pre-compact history.
        // 【中文】坑：压缩边界里引用了 preservedSegment.tailUuid。
        // 如果 tail 指向的那条消息还没落盘，进程就被杀了，resume 时 tail→head 链路走不通，
        // 结果是整段压缩前历史都恢复不出来。所以先把 tail 之前的所有消息强制写出去。
        if (
          persistSession &&
          message.type === 'system' &&
          message.subtype === 'compact_boundary'
        ) {
          const tailUuid = message.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex(
              m => m.uuid === tailUuid,
            )
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        // 【中文】局部工作副本也要同步，因为 recordTranscript(messages) 用的是它。
        messages.push(message)
        if (persistSession) {
          // Fire-and-forget for assistant messages. claude.ts yields one
          // assistant message per content block, then mutates the last
          // one's message.usage/stop_reason on message_delta — relying on
          // the write queue's 100ms lazy jsonStringify. Awaiting here
          // blocks ask()'s generator, so message_delta can't run until
          // every block is consumed; the drain timer (started at block 1)
          // elapses first. Interactive CC doesn't hit this because
          // useLogMessages.ts fire-and-forgets. enqueueWrite is
          // order-preserving so fire-and-forget here is safe.
          // 【中文】为什么不 await？await 会卡住生成器，导致 message_delta
          // （补 usage / stop_reason 的那一步）迟迟跑不了；而 claude.ts 是靠
          // 「就地修改最后一条 assistant 消息」来补这些字段的。写入队列保证顺序，
          // 所以 fire-and-forget 是安全的。user 消息没有这个问题，照常 await。
          if (message.type === 'assistant') {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // Acknowledge initial user messages after first transcript recording
        // 【中文】放在「第一次落盘之后」才回放：保证 transcript 里用户消息先于回放事件，
        // 否则恢复会话时消息顺序会错乱。
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === 'user') {
              yield {
                type: 'user',
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as SDKUserMessageReplay
            }
          }
        }
      }

      // 【中文】一条 user 消息 = 完成了一次工具往返，所以算一轮。
      if (message.type === 'user') {
        turnCount++
      }

      // 【中文】判别联合（discriminated union）：switch 之后 message 会被自动窄化，
      // 每个 case 内部可以直接访问该类型独有的字段（≈ Java switch 模式匹配）。
      switch (message.type) {
          // 【中文】tombstone 是内部「删除某条消息」的控制信令，不对 SDK 暴露。
        case 'tombstone':
          // Tombstone messages are control signals for removing messages, skip them
          break
          // 【中文】assistant 消息：先记 stop_reason，再入历史，最后转发。
          // 注意用 yield*（平铺）而不是 yield——normalizeMessage 本身是个生成器。
        case 'assistant':
          // Capture stop_reason if already set (synthetic messages). For
          // streamed responses, this is null at content_block_stop time;
          // the real value arrives via message_delta (handled below).
            // 【中文】!= null 同时覆盖 null 和 undefined（≈ Java 的 != null，但 TS 有两个空值）。
            // 流式响应在这一步 stop_reason 还是 null，真值要等 message_delta。
          if (message.message.stop_reason != null) {
            lastStopReason = message.message.stop_reason
          }
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
          // 【中文】进度消息也必须落盘：否则下一轮 ask() 的去重逻辑会认错 parentUuid，
          // 把会话链分叉，resume 时整段会话变成孤儿。
        case 'progress':
          this.mutableMessages.push(message)
          // Record inline so the dedup loop in the next ask() call sees it
          // as already-recorded. Without this, deferred progress interleaves
          // with already-recorded tool_results in mutableMessages, and the
          // dedup walk freezes startingParentUuid at the wrong message —
          // forking the chain and orphaning the conversation on resume.
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(message)
          break
          // 【中文】user 消息多半是工具结果（tool_result），入历史后转发给 SDK。
        case 'user':
          this.mutableMessages.push(message)
          yield* normalizeMessage(message)
          break
          // 【中文】流式事件：只做用量累计，默认不透传（除非调用方开了 includePartialMessages）。
        case 'stream_event':
            // 【中文】新消息开始：先把累加器清零，再并入 message_start 自带的用量（如 cache 写入量）。
          if (message.event.type === 'message_start') {
            // Reset current message usage for new message
            currentMessageUsage = EMPTY_USAGE
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.message.usage,
            )
          }
            // 【中文】stop_reason 的真值只在这里才拿得到（assistant 消息是在
            // content_block_stop 时 yield 的，那时 stop_reason 还是 null）。
            // 少了这一步，最终 result.stop_reason 永远是 null。
          if (message.event.type === 'message_delta') {
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              message.event.usage,
            )
            // Capture stop_reason from message_delta. The assistant message
            // is yielded at content_block_stop with stop_reason=null; the
            // real value only arrives here (see claude.ts message_delta
            // handler). Without this, result.stop_reason is always null.
            if (message.event.delta.stop_reason != null) {
              lastStopReason = message.event.delta.stop_reason
            }
          }
            // 【中文】accumulateUsage ≈ 把两个用量对象按字段相加。
          if (message.event.type === 'message_stop') {
            // Accumulate current message usage into total
            this.totalUsage = accumulateUsage(
              this.totalUsage,
              currentMessageUsage,
            )
          }

          // 【中文】只有调用方显式要求才透传原始流事件（否则一轮下来事件量爆炸）。
          if (includePartialMessages) {
            yield {
              type: 'stream_event' as const,
              event: message.event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
          // 【中文】attachment 是「旁路信息」：不进模型上下文，只用于内部记账和对外通知。
        case 'attachment':
          this.mutableMessages.push(message)
          // Record inline (same reason as progress above).
          if (persistSession) {
            messages.push(message)
            void recordTranscript(messages)
          }

          // Extract structured output from StructuredOutput tool calls
            // 【中文】结构化输出工具的结果，先存着，最后放进 result.structured_output。
          if (message.attachment.type === 'structured_output') {
            structuredOutputFromTool = message.attachment.data
          }
          // Handle max turns reached signal from query.ts
            // 【中文】query.ts 达到 maxTurns 上限发来的信号 → 立刻结束整轮（注意是 return 不是 break）。
          else if (message.attachment.type === 'max_turns_reached') {
            if (persistSession) {
              if (
                isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
                isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: message.attachment.turnCount,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(
                mainLoopModel,
                initialAppState.fastMode,
              ),
              uuid: randomUUID(),
              errors: [
                `Reached maximum number of turns (${message.attachment.maxTurns})`,
              ],
            }
            return
          }
          // Yield queued_command attachments as SDK user message replays
            // 【中文】队列里的命令被消费了，回放成一条 user 消息给 SDK 调用方。
          else if (
            replayUserMessages &&
            message.attachment.type === 'queued_command'
          ) {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: message.attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: message.attachment.source_uuid || message.uuid,
              timestamp: message.timestamp,
              isReplay: true,
            } as SDKUserMessageReplay
          }
          break
          // 【中文】纯内部信号（「一次 HTTP 请求开始了」），不对外暴露。
        case 'stream_request_start':
          // Don't yield stream request start messages
          break
          // 【中文】system 消息有三类用途：snip 回放、压缩边界、API 重试通知。
        case 'system': {
          // Snip boundary: replay on our store to remove zombie messages and
          // stale markers. The yielded boundary is a signal, not data to push —
          // the replay produces its own equivalent boundary. Without this,
          // markers persist and re-trigger on every turn, and mutableMessages
          // never shrinks (memory leak in long SDK sessions). The subtype
          // check lives inside the injected callback so feature-gated strings
          // stay out of this file (excluded-strings check).
            // 【中文】snip 压缩：把历史「剪掉」一大段，只保留 replay 之后的结果。
            // 为什么必须做？否则 snip 标记会一直留在历史里、每轮重复触发，
            // 而且 mutableMessages 永不缩小（长会话 = 内存泄漏）。
          const snipResult = this.config.snipReplay?.(
            message,
            this.mutableMessages,
          )
          if (snipResult !== undefined) {
            if (snipResult.executed) {
              // 【中文】原地清空再 push，不能写成 this.mutableMessages = [...]，
              // 因为外部可能已经持有了同一个数组引用（那样就断链了）。
              this.mutableMessages.length = 0
              this.mutableMessages.push(...snipResult.messages)
            }
            break
          }
          this.mutableMessages.push(message)
          // Yield compact boundary messages to SDK
            // 【中文】压缩边界：对外透出，同时释放压缩前的消息给 GC。
            // 因为 query.ts 内部本来就只看 getMessagesAfterCompactBoundary() 之后的内容。
          if (
            message.subtype === 'compact_boundary' &&
            message.compactMetadata
          ) {
            // Release pre-compaction messages for GC. The boundary was just
            // pushed so it's the last element. query.ts already uses
            // getMessagesAfterCompactBoundary() internally, so only
            // post-boundary messages are needed going forward.
              // 【中文】边界刚 push 进去，所以它一定是最后一个元素；
              // splice(0, idx) 会保留 idx 那一条本身（边界要留着）。
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            // 【中文】局部工作副本做同样的裁剪，保持两边一致。
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: message.uuid,
              compact_metadata: toSDKCompactMetadata(message.compactMetadata),
            }
          }
            // 【中文】内部 api_error 翻译成 SDK 的 api_retry（带上第几次重试、还要等多久）。
          if (message.subtype === 'api_error') {
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: message.retryAttempt,
              max_retries: message.maxRetries,
              retry_delay_ms: message.retryInMs,
              error_status: message.error.status ?? null,
              error: categorizeRetryableAPIError(message.error),
              session_id: getSessionId(),
              uuid: message.uuid,
            }
          }
          // Don't yield other system messages in headless mode
          break
        }
          // 【中文】工具调用摘要（给 UI 展示「我刚才都干了什么」）。
        case 'tool_use_summary':
          // Yield tool use summary messages to SDK
          yield {
            type: 'tool_use_summary' as const,
            summary: message.summary,
            preceding_tool_use_ids: message.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: message.uuid,
          }
          break
      }

      // 【中文】熔断 ①：累计花费达到上限就立刻收尾。
      // Check if USD budget has been exceeded
      // 【中文】用 >= 而不是 >：正好等于上限也算超。
      // maxBudgetUsd !== undefined 是前置判断（undefined 表示调用方没设限）。
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        if (persistSession) {
          if (
            isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            mainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [`Reached maximum budget ($${maxBudgetUsd})`],
        }
        return
      }

      // 【中文】熔断 ②：结构化输出重试次数超限（只在收到 user 消息时检查，即每次往返后）。
      // Check if structured output retry limit exceeded (only on user messages)
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        // 【中文】环境变量读出来是 string，必须 parseInt；第二个参数 10 不能省——
        // 历史上不带进制会把 '010' 当八进制解析。
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )
          // 【中文】用「本轮调用次数」而不是历史总数，靠的就是进入循环前存的那条基线。
        if (callsThisQuery >= maxRetries) {
          if (persistSession) {
            if (
              isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              mainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `Failed to provide valid structured output after ${maxRetries} attempts`,
            ],
          }
          return
        }
      }
    }

      // 【中文】为什么不能直接 last(messages) 取结果？
      // 因为 stop hook 会在 assistant 之后追加 progress / attachment，
      // 那样取到的就不是 assistant 了，文本抽取会得到空串（-p 模式输出一个空行）。
    // Stop hooks yield progress/attachment messages AFTER the assistant
    // response (via yield* handleStopHooks in query.ts). Since #23537 pushes
    // those to `messages` inline, last(messages) can be a progress/attachment
    // instead of the assistant — which makes textResult extraction below
    // return '' and -p mode emit a blank line. Allowlist to assistant|user:
    // isResultSuccessful handles both (user with all tool_result blocks is a
    // valid successful terminal state).
    // 【中文】从后往前找第一条 assistant 或 user 作为「最终结果」。
    // findLast(pred) ≈ Java 里倒序遍历找第一个满足条件的元素。
    const result = messages.findLast(
      m => m.type === 'assistant' || m.type === 'user',
    )
    // Capture for the error_during_execution diagnostic — isResultSuccessful
    // is a type predicate (message is Message), so inside the false branch
    // `result` narrows to never and these accesses don't typecheck.
    // 【中文】必须「提前」把诊断信息算出来存好：isResultSuccessful 是类型谓词（x is T），
    // 进了它的 false 分支后 result 会被窄化成 never，那时再访问 .type 编译不过。
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContentType =
      result?.type === 'assistant'
        ? (last(result.message.content)?.type ?? 'none')
        : 'n/a'

    // 【中文】桌面端（claude-desktop）收到 result 后会立刻 kill 掉 CLI 进程，
    // 所以任何还在缓冲里的写入必须先 flush，否则会话记录就丢了。
    // Flush buffered transcript writes before yielding result.
    // The desktop app kills the CLI process immediately after receiving the
    // result message, so any unflushed writes would be lost.
    if (persistSession) {
      if (
        isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    // 【中文】类型谓词调用：false 分支里 result 会窄化成 never，所以上面的诊断字段要提前算。
    if (!isResultSuccessful(result, lastStopReason)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        // Diagnostic prefix: these are what isResultSuccessful() checks — if
        // the result type isn't assistant-with-text/thinking or user-with-
        // tool_result, and stop_reason isn't end_turn, that's why this fired.
        // errors[] is turn-scoped via the watermark; previously it dumped the
        // entire process's logError buffer (ripgrep timeouts, ENOENT, etc).
        // 【中文】立即执行函数（IIFE，(() => { ... })()）：就地算出 errors 数组。
        // 用「水位线之后的错误」而不是全量，保证 errors[] 只包含本轮的错误，
        // 不会把整个进程历史里无关的报错（ripgrep 超时、ENOENT 等）都倒给调用方。
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark
            ? all.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map(_ => _.error),
          ]
        })(),
      }
      return
    }

    // 【中文】抽取最终要回给调用方的文本结果。
    // Extract the text result based on message type
    // 【中文】只取「最后一段」text——中间段落是模型的中间自言自语，不算结论。
    let textResult = ''
    let isApiError = false

    // 【中文】assistant 结果：取最后一个 content block 的文本。
    if (result.type === 'assistant') {
      const lastContent = last(result.message.content)
      if (
      // 【中文】排除 SYNTHETIC_MESSAGES：那是系统内部合成的占位文本（如「No response requested.」），
      // 不能当成真正的回答回给用户。
        lastContent?.type === 'text' &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      // 【中文】「流程走完了但 API 报过错」：subtype 仍是 success，但 is_error 置 true。
      isApiError = Boolean(result.isApiErrorMessage)
    }

    // 【中文】正常收尾的 result 事件。与失败分支相比，多带一个 structured_output 字段。
    yield {
      type: 'result',
      subtype: 'success',
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(
        mainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  }

/**
 * 【中文】interrupt() —— 中断当前正在进行的请求。
 *
 * 原理：abort 掉本会话的 AbortController。所有监听这个 signal 的地方
 * （HTTP 请求、正在执行的工具、子代理）会收到通知并自行退出，
 * ≈ Java 的 Future.cancel(true) / 线程 interrupt：是「协作式」的，不是强杀。
 *
 * 调用时机：用户在客户端点 Stop、或上层判断要放弃这一轮时。
 */
  interrupt(): void {
    // 【中文】abort() 只是发出信号。submitMessage 的 for-await 会在下一个事件点感知到，
    // 然后走收尾逻辑（该落盘的落盘），不会把进程硬杀掉。
    this.abortController.abort()
  }

/**
 * 【中文】getMessages() —— 取当前会话的完整消息历史。
 *
 * 返回类型 readonly Message[]：这是 TS 的「只读数组」约束（编译期禁止 push/splice），
 * 但运行时底层就是同一个数组实例——不是拷贝，调用方别指望改不动它。
 *
 * 用途：--resume 时把历史交给新的 QueryEngine，或调试时 dump 会话。
 */
  getMessages(): readonly Message[] {
    // 【中文】返回的是同一个数组的只读视图（零拷贝，性能好，但调用方不能改）。
    return this.mutableMessages
  }

/**
 * 【中文】getReadFileState() —— 取文件读取状态缓存。
 *
 * 这个缓存记录了「读过哪些文件、读的时候内容是什么」，是两件事的基础：
 *   ① /undo 回滚（知道改之前长什么样）；
 *   ② 改动检测（文件被外部改了要提示模型重新读）。
 *
 * ask() 在 finally 里会把它写回给调用方，所以长生命周期的调用方能跨 ask 复用。
 */
  getReadFileState(): FileStateCache {
    return this.readFileState
  }

/**
 * 【中文】getSessionId() —— 取当前会话 id。
 *
 * 注意：这是转发到全局 bootstrap state，不是本实例的字段——
 * session id 是「进程级」的，整个进程里所有 QueryEngine 共享同一个。
 */
  getSessionId(): string {
    // 【中文】直接转发全局单例（src/bootstrap/state.js），本类不持有这个状态。
    return getSessionId()
  }

/**
 * 【中文】setModel() —— 运行时切换模型。
 *
 * 生效时机：只影响「下一次」submitMessage；正在跑的那一轮不受影响
 * （因为它的 mainLoopModel 已经在进入循环前算好并传进 query() 了）。
 *
 * 实现上就是改 config 对象里的一个字段（config 是可变引用）。
 *
 * @param model 模型名或 profile 名，语义同 QueryEngineConfig.userSpecifiedModel
 */
  setModel(model: string): void {
    // 【中文】改的是 config 引用里的字段，简单直接；
    // 之所以不在跑着的循环里生效，是因为模型在 submitMessage 开头就被快照进 mainLoopModel 了。
    this.config.userSpecifiedModel = model
  }
}

/**
 * Sends a single prompt to the Claude API and returns the response.
 * Assumes that claude is being used non-interactively -- will not
 * ask the user for permissions or further input.
 *
 * Convenience wrapper around QueryEngine for one-shot usage.
 */
/**
 * 【中文】ask() —— 一次性调用的便利函数（QueryEngine 的门面）。
 *
 * 定位：给「一问一答、用完即弃」的场景（如 -p 单次执行、SDK 的一次性调用）用的糖。
 * 它做的事就三步：new 一个 QueryEngine → yield* 转发它的全部事件 → finally 里把
 * 文件缓存写回调用方。
 *
 * 与 QueryEngine 的差别：ask() 无状态（每次调用都新建引擎）；
 * 需要多轮对话、要中断、要取历史时，请直接用 QueryEngine。
 *
 * 参数说明：这里把一大堆参数写成「一个对象 + 解构」的形式（TS 命名参数惯用法），
 * 等价于 Java 的 Builder，避免 positional 参数记不住顺序。带 `= 默认值` 的是可选参数。
 *
 * @returns AsyncGenerator<SDKMessage, void, unknown> —— 调用方用 for await 逐个取事件
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  // 【中文】这对 getter/setter 回调是成对的：进引擎前 clone 一份快照，
  // 出来后（finally 里）写回。这样多次 ask() 之间能共享同一份文件缓存。
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  setSDKStatus?: (status: SDKStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  // 【中文】每次 ask() 都新建一个引擎：一次性调用，用完即弃，不做跨调用的状态管理。
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents,
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    // 【中文】为什么要 clone？引擎内部会持续修改这份文件缓存；
    // clone 保证调用方手上的那份不被污染（QueryEngine 自己是直接持有引用的）。
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
    // 【中文】「条件字段」惯用法：{ ...(cond ? { 字段 } : {}) }。
    // 条件为假时展开一个空对象，等于什么都没加——比在对象字面量里写 if 优雅。
    // 而且 feature() 是编译期常量，为 false 时整段会被打包器删掉。
    ...(feature('HISTORY_SNIP')
      ? {
          snipReplay: (yielded: Message, store: Message[]) => {
            // 【中文】`!` 非空断言：feature('HISTORY_SNIP') 为真时它必然不是 null，
            // 但 TS 推不出来（两个变量独立声明），只能手动断言。运行时不做检查。
            if (!snipProjection!.isSnipBoundaryMessage(yielded))
              return undefined
            return snipModule!.snipCompactIfNeeded(store, { force: true })
          },
        }
      : {}),
  })

  // 【中文】try/finally：无论正常跑完、还是被 interrupt、还是抛异常，
  // 都要把文件缓存写回调用方——否则下一次调用就拿不到「读过什么」的记录，
  // /undo 和改动检测会失效。
  try {
    // 【中文】yield* 平铺转发：ask() 产出的事件 == 引擎产出的事件，不额外包一层。
    // 写成 yield（不带星）就错了——那会把整个生成器当一个值吐出去。
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    // 【中文】写回文件缓存。注意在 finally 里，所以异常路径也会执行。
    setReadFileCache(engine.getReadFileState())
  }
}
