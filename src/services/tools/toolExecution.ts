/**
 * 【一句话定位】工具执行的【核心管线】：模型点名一个工具之后，从这里开始走完
 * 「找到工具 → 校验入参 → PreToolUse hook → 权限判定 → 真正执行 → PostToolUse hook → 结果规整/落盘」
 * 的全过程，并把每一阶段产生的消息以流的方式吐给上层。
 *
 * 【在架构中的位置】
 *   上游：src/services/tools/toolOrchestration.ts（决定哪些工具并发/串行后，逐个调用 runToolUse）
 *        src/services/tools/StreamingToolExecutor.ts（流式执行模式下也会走这条管线）
 *        src/query.ts（主循环把工具结果消息收进 messages）
 *   下游：./toolHooks.ts（PreToolUse / PostToolUse / PostToolUseFailure / PermissionDenied 四类 hook）
 *        ../../utils/permissions/*（权限判定）、../../utils/toolResultStorage.js（超大结果落盘）
 *        ../../Tool.js（工具接口：inputSchema、validateInput、call、mapToolResultToToolResultBlockParam）
 *        ../../utils/messages.js（把结果包装成 user 消息 / progress 消息）
 *   完整调用链：
 *     模型输出 tool_use
 *       → toolOrchestration / StreamingToolExecutor
 *       → runToolUse(toolUse, assistantMessage, canUseTool, toolUseContext)  【本文件入口】
 *       → streamedCheckPermissionsAndCallTool()（把回调式进度转成异步流）
 *       → checkPermissionsAndCallTool()  【本文件主体，见下方 7 步】
 *       → 产出 user 消息（tool_result）/ progress 消息 → 回灌给模型，进入下一轮
 *
 * 【一次工具调用的 7 个阶段】（理解本文件的主线）
 *   ① 找工具：在当前工具池里按 name 找；找不到再去全量清单里按【别名】找（兼容旧会话里的旧工具名）
 *   ② 入参校验（两道）：
 *       · inputSchema.safeParse() —— zod 校验类型与结构（模型生成合法 JSON 的能力其实并不好）
 *       · tool.validateInput()    —— 工具自己的业务校验（文件是否存在、路径是否允许等）
 *      失败都回一条 is_error 的 tool_result，把原因回灌给模型让它自己改，而不是中断整个会话
 *   ③ PreToolUse hook：用户可在此改写入参（updatedInput）、直接批准/拒绝、注入额外上下文、
 *      甚至要求「停止继续」（preventContinuation）
 *   ④ 权限判定（canUseTool）：allow → 继续；deny/ask → 生成拒绝文案；
 *      auto 模式下还会先跑安全分类器；Bash 还会【投机性】提前启动分类器以省时间
 *   ⑤ 真正执行 tool.call()：期间工具通过 onProgress 回调持续上报进度（转成 progress 消息流出去）
 *   ⑥ PostToolUse hook：可以改写工具输出（MCP 工具尤其如此）、追加上下文、或要求停止
 *   ⑦ 结果规整：mapToolResultToToolResultBlockParam 序列化 → 超过 maxResultSizeChars 就落盘只留预览
 *      → 连同「用户批准时的反馈文本 / 粘贴的图片」一起包装成 user 消息返回
 *
 * 【本文件包含什么】
 *   runToolUse()                     —— 对外主入口（异步生成器）：一次工具调用的完整流程
 *   streamedCheckPermissionsAndCallTool() —— 把「回调式进度 + Promise 结果」桥接成一条异步流
 *   checkPermissionsAndCallTool()    —— 真正的执行主体（上面 7 步都在这里）
 *   buildSchemaNotSentHint()         —— 工具被 defer 但没被 ToolSearch 加载时，给模型的补救提示
 *   classifyToolError()              —— 把异常归成「可安全上报」的字符串（压缩混淆会毁掉类名）
 *   ruleSourceToOTelSource / decisionReasonToOTelSource —— 把权限来源映射成 OTel 的标准取值
 *   getNextImagePasteId()            —— 给新粘贴的图片分配递增编号（用于 UI 上的图片标签）
 *   findMcpServerConnection / getMcpServerType / getMcpServerBaseUrlFromToolName —— MCP 服务器信息查询
 *   MessageUpdateLazy / McpServerType —— 两个导出类型
 *
 * 【TS 语法速查】（针对本文件实际出现的写法，Java 工程师对照看）
 *   1. 【异步生成器】`export async function* runToolUse(...): AsyncGenerator<T, void>`：
 *      函数体里用 yield 逐个吐出结果，调用方用 `for await (const x of runToolUse(...))` 逐个接收。
 *      ≈ Java 的 Flux<T>（Reactor）/ 异步流：边产出边消费，不用等全部完成。
 *      `yield*` 则是「把另一个生成器的元素原样转发出来」（本文件用 for await + yield 达到同样效果）。
 *   2. `AsyncIterable<T>` / `AsyncGenerator<T, void>`：前者是「可被 for await 遍历的东西」，
 *      后者是「用 async function* 造出来的那个东西」。第二个类型参数 void = 函数没有返回值。
 *   3. `for await (const x of asyncIterable)` ≈ Reactor 的 `.subscribe()` / 逐个 take：
 *      每次循环体执行前会 await 下一个元素。
 *   4. `Promise<T>` ≈ CompletableFuture<T>；`.then().catch().finally()` 与 Java 的
 *      thenApply/exceptionally/whenComplete 一一对应。
 *   5. `x instanceof SomeError` 与 Java 完全一致，且在 TS 里还能起到【类型收窄】作用。
 *   6. `'command' in obj` 是【in 运算符】：判断对象有没有这个键；TS 会据此收窄类型（比 as 安全）。
 *   7. `as unknown as X` / `as X` ≈ Java 强制转换：编译期断言，运行时什么也不做。
 *      本文件里大量 `xxx as AnalyticsMetadata_...` 是在向日志系统担保「这个字符串不含代码或路径」。
 *   8. 【对象解构 + rest】`const { _simulatedSedEdit: _, ...rest } = obj`：
 *      取出某个字段（重命名成 _ 表示丢弃），其余字段打包进 rest——不可变地「删除一个字段」。
 *   9. `[...a, ...b]` / `{...a, b: 1}` 展开 ≈ 不可变地拼接 / 覆盖更新。
 *  10. `?.` 可选调用 `tool.validateInput?.(...)`：方法可能不存在，存在才调用（≈ 先判 null）。
 *      `tool.backfillObservableInput!(...)` 的 `!` 是非空断言：向编译器担保它一定存在。
 *  11. `??` 空值合并；`??=` 不存在时的赋值。注意与 `||` 的区别：0 和 '' 不会被 ?? 替换。
 *  12. 【条件展开】`...(cond && { key: value })`：条件成立才把这个字段加进对象（falsy 时什么也不加）。
 *      `...(a !== undefined && { a })` 同理——只在有值时才带该字段，避免塞一堆 undefined。
 *  13. `ReturnType<typeof getLoggingSafeMcpBaseUrl>`：取某个函数的返回类型当类型用，避免手写重复。
 *  14. 【函数内定义函数】`async function addToolResult(...) {}` 定义在另一个函数体内，
 *      形成闭包（可以直接用外层的 tool、permissionDecision 等变量）≈ Java 里的局部内部类/lambda 捕获。
 *  15. `void somePromise()` 表示「故意不 await」：触发异步操作但不阻塞当前流程（fire-and-forget）。
 *  16. `try / catch / finally` 与 Java 一致；生成器里 finally 会在流被提前关闭时也执行（清理资源）。
 *  17. `Record<string, string | number | boolean>` ≈ Map<String, Object>（值限定为这三类）。
 *  18. 泛型约束 `MessageUpdateLazy<M extends Message = Message>` ≈ Java `<M extends Message>`，
 *      但 TS 允许给类型参数设默认值。
 *  19. `switch (result.type) { case 'message': ... }` 是可辨识联合的判别方式：
 *      case 命中后编译器自动把 result 窄化成对应分支的类型。
 *  20. `const _exhaustive: never = x` 穷尽性检查：联合类型加了新分支却漏处理时，这里会编译报错。
 */
import { feature } from 'bun:bundle'
import type {
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  extractMcpToolDetails,
  extractSkillName,
  extractToolInputForTelemetry,
  getFileExtensionForAnalytics,
  getFileExtensionsFromBashCommand,
  isToolDetailsLoggingEnabled,
  mcpToolDetailsForAnalytics,
  sanitizeToolNameForAnalytics,
} from 'src/services/analytics/metadata.js'
import {
  addToToolDuration,
  getCodeEditToolDecisionCounter,
  getStatsStore,
} from '../../bootstrap/state.js'
import {
  buildCodeEditToolAttributes,
  isCodeEditingTool,
} from '../../hooks/toolPermission/permissionLogging.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  findToolByName,
  type Tool,
  type ToolProgress,
  type ToolProgressData,
  type ToolUseContext,
} from '../../Tool.js'
import type { BashToolInput } from '../../tools/BashTool/BashTool.js'
import { startSpeculativeClassifierCheck } from '../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { parseGitCommitId } from '../../tools/shared/gitOperationTracking.js'
import {
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import { getAllBaseTools } from '../../tools.js'
import type { HookProgress } from '../../types/hooks.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  StopHookInfo,
} from '../../types/message.js'
import { count } from '../../utils/array.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  AbortError,
  errorMessage,
  getErrnoCode,
  ShellError,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../utils/errors.js'
import { executePermissionDeniedHooks } from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import {
  CANCEL_MESSAGE,
  createProgressMessage,
  createStopHookSummaryMessage,
  createToolResultStopMessage,
  createUserMessage,
  withMemoryCorrectionHint,
} from '../../utils/messages.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { Stream } from '../../utils/stream.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import {
  addToolContentEvent,
  endToolBlockedOnUserSpan,
  endToolExecutionSpan,
  endToolSpan,
  isBetaTracingEnabled,
  startToolBlockedOnUserSpan,
  startToolExecutionSpan,
  startToolSpan,
} from '../../utils/telemetry/sessionTracing.js'
import {
  formatError,
  formatZodValidationError,
} from '../../utils/toolErrors.js'
import {
  processPreMappedToolResultBlock,
  processToolResultBlock,
} from '../../utils/toolResultStorage.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
} from '../../utils/toolSearch.js'
import {
  McpAuthError,
  McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../mcp/client.js'
import { mcpInfoFromString } from '../mcp/mcpStringUtils.js'
import { normalizeNameForMCP } from '../mcp/normalization.js'
import type { MCPServerConnection } from '../mcp/types.js'
import {
  getLoggingSafeMcpBaseUrl,
  getMcpServerScopeFromToolName,
  isMcpTool,
} from '../mcp/utils.js'
import {
  resolveHookPermissionDecision,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from './toolHooks.js'

/** Minimum total hook duration (ms) to show inline timing summary */
// hook 总耗时超过这个毫秒数才在界面上显示一行耗时摘要——低于阈值显示反而扰乱视线。
export const HOOK_TIMING_DISPLAY_THRESHOLD_MS = 500
/** Log a debug warning when hooks/permission-decision block for this long. Matches
 * BashTool's PROGRESS_THRESHOLD_MS — the collapsed view feels stuck past this. */
const SLOW_PHASE_LOG_THRESHOLD_MS = 2000

/**
 * Classify a tool execution error into a telemetry-safe string.
 *
 * In minified/external builds, `error.constructor.name` is mangled into
 * short identifiers like "nJT" or "Chq" — useless for diagnostics.
 * This function extracts structured, telemetry-safe information instead:
 * - TelemetrySafeError: use its telemetryMessage (already vetted)
 * - Node.js fs errors: log the error code (ENOENT, EACCES, etc.)
 * - Known error types: use their unminified name
 * - Fallback: "Error" (better than a mangled 3-char identifier)
 */
/** 把一个异常归成「可以安全上报」的字符串。
 *  为什么不能直接记 error.constructor.name：压缩混淆后的构建里类名会变成 nJT、Chq 这种短标识符，
 *  完全没有诊断价值。所以按优先级取更有意义的信息：
 *    ① 带 telemetryMessage 的错误（已人工审核过可上报）→ 截前 200 字符
 *    ② Node 的文件系统错误 → 取 errno code，如 Error:ENOENT、Error:EACCES（既安全又好用）
 *    ③ 有稳定 name 的自定义错误（ShellError、ImageSizeError 等）→ 取 name
 *    ④ 兜底 'Error' / 'UnknownError'——总比三个乱码字符强
 */
export function classifyToolError(error: unknown): string {
  if (
    error instanceof TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  ) {
    return error.telemetryMessage.slice(0, 200)
  }
  if (error instanceof Error) {
    // Node.js filesystem errors have a `code` property (ENOENT, EACCES, etc.)
    // These are safe to log and much more useful than the constructor name.
    const errnoCode = getErrnoCode(error)
    if (typeof errnoCode === 'string') {
      return `Error:${errnoCode}`
    }
    // ShellError, ImageSizeError, etc. have stable `.name` properties
    // that survive minification (they're set in the constructor).
    if (error.name && error.name !== 'Error' && error.name.length > 3) {
      return error.name.slice(0, 60)
    }
    return 'Error'
  }
  return 'UnknownError'
}

/**
 * Map a rule's origin to the documented OTel `source` vocabulary, matching
 * the interactive path's semantics (permissionLogging.ts:81): session-scoped
 * grants are temporary, on-disk grants are permanent, and user-authored
 * denies are user_reject regardless of persistence. Everything the user
 * didn't write (cliArg, policySettings, projectSettings, flagSettings) is
 * config.
 */
/** 把「权限规则的来源」翻译成 OTel 规定的标准取值。
 *  语义约定：会话级放行 = 临时授权（user_temporary）；写进磁盘的 = 永久授权（user_permanent）；
 *  用户自己写的 deny 一律算 user_reject（不管是否持久化）；其余来自配置/策略的一律算 config。
 */
function ruleSourceToOTelSource(
  ruleSource: string,
  behavior: 'allow' | 'deny',
): string {
  switch (ruleSource) {
    case 'session':
      return behavior === 'allow' ? 'user_temporary' : 'user_reject'
    case 'localSettings':
    case 'userSettings':
      return behavior === 'allow' ? 'user_permanent' : 'user_reject'
    default:
      return 'config'
  }
}

/**
 * Map a PermissionDecisionReason to the OTel `source` label for the
 * non-interactive tool_decision path, staying within the documented
 * vocabulary (config, hook, user_permanent, user_temporary, user_reject).
 *
 * For permissionPromptTool, the SDK host may set decisionClassification on
 * the PermissionResult to tell us exactly what happened (once vs always vs
 * cache hit — the host knows, we can't tell from {behavior:'allow'} alone).
 * Without it, we fall back conservatively: allow → user_temporary,
 * deny → user_reject.
 */
/** 把「权限判定理由」翻译成 OTel 的 source 标签。
 *  注意 permissionPromptTool 这一支：宿主（SDK 集成方）可能直接在结果里给出 decisionClassification
 *  （一次性 / 永久 / 缓存命中），因为它才知道用户到底怎么选的；
 *  单看 { behavior: 'allow' } 是判断不出来的。没给就保守回落：allow→user_temporary，deny→user_reject。
 *  入参 reason：权限判定理由（可能为 undefined）；behavior：最终行为
 */
function decisionReasonToOTelSource(
  reason: PermissionDecisionReason | undefined,
  behavior: 'allow' | 'deny',
): string {
  if (!reason) {
    return 'config'
  }
  switch (reason.type) {
    case 'permissionPromptTool': {
      // toolResult is typed `unknown` on PermissionDecisionReason but carries
      // the parsed Output from PermissionPromptToolResultSchema. Narrow at
      // runtime rather than widen the cross-file type.
      const toolResult = reason.toolResult as
        | { decisionClassification?: string }
        | undefined
      const classified = toolResult?.decisionClassification
      if (
        classified === 'user_temporary' ||
        classified === 'user_permanent' ||
        classified === 'user_reject'
      ) {
        return classified
      }
      return behavior === 'allow' ? 'user_temporary' : 'user_reject'
    }
    case 'rule':
      return ruleSourceToOTelSource(reason.rule.source, behavior)
    case 'hook':
      return 'hook'
    case 'mode':
    case 'classifier':
    case 'subcommandResults':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return 'config'
    default: {
      const _exhaustive: never = reason
// `const _exhaustive: never = reason` 是穷尽性检查：
// 将来 PermissionDecisionReason 新增一种取值而这里忘了处理，这行赋值就会编译报错（把值赋给 never 类型非法）。
      return 'config'
    }
  }
}

/** 取下一个可用的「粘贴图片编号」（在已有最大值上 +1），让每张图片在 UI 上有各自独立的标签。 */
function getNextImagePasteId(messages: Message[]): number {
  let maxId = 0
  for (const message of messages) {
    if (message.type === 'user' && message.imagePasteIds) {
      for (const id of message.imagePasteIds) {
        if (id > maxId) maxId = id
      }
    }
  }
  return maxId + 1
}

// 一次工具执行可能产出【多条消息】（进度、结果、hook 输出、工具自带的新消息），
// 所以用这个结构把「消息」和可选的「上下文修改器」打包后逐条 yield 出去。
export type MessageUpdateLazy<M extends Message = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifyContext: (context: ToolUseContext) => ToolUseContext
  }
}

// MCP 服务器的传输类型联合：stdio / sse / http / ws / sdk，外加两个 IDE 特化与代理类型；
// undefined 表示「不是 MCP 工具」或「服务器未连接」。
export type McpServerType =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'ws'
  | 'sdk'
  | 'sse-ide'
  | 'ws-ide'
  | 'claudeai-proxy'
  | undefined

/** 按工具名（形如 mcp__server__tool）反查出对应的 MCP 服务器连接。
 *  坑点：工具名里的 serverName 是【规范化】过的（如 claude_ai_Slack），而连接对象上的 name 是原名
 *  （如 claude.ai Slack），所以两边都要先规范化再比，否则匹配不上。
 */
function findMcpServerConnection(
  toolName: string,
  mcpClients: MCPServerConnection[],
): MCPServerConnection | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  const mcpInfo = mcpInfoFromString(toolName)
  if (!mcpInfo) {
    return undefined
  }

  // mcpInfo.serverName is normalized (e.g., "claude_ai_Slack"), but client.name
  // is the original name (e.g., "claude.ai Slack"). Normalize both for comparison.
  return mcpClients.find(
    client => normalizeNameForMCP(client.name) === mcpInfo.serverName,
  )
}

/**
 * Extracts the MCP server transport type from a tool name.
 * Returns the server type (stdio, sse, http, ws, sdk, etc.) for MCP tools,
 * or undefined for built-in tools.
 */
/** 取该 MCP 服务器的传输类型；stdio 配置里 type 字段可省略，默认按 stdio 处理。 */
function getMcpServerType(
  toolName: string,
  mcpClients: MCPServerConnection[],
): McpServerType {
  const serverConnection = findMcpServerConnection(toolName, mcpClients)

  if (serverConnection?.type === 'connected') {
    // Handle stdio configs where type field is optional (defaults to 'stdio')
    return serverConnection.config.type ?? 'stdio'
  }

  return undefined
}

/**
 * Extracts the MCP server base URL for a tool by looking up its server connection.
 * Returns undefined for stdio servers, built-in tools, or if the server is not connected.
 */
/** 取该 MCP 服务器对外可安全记录的 base URL（stdio 服务器没有 URL，返回 undefined）。 */
function getMcpServerBaseUrlFromToolName(
  toolName: string,
  mcpClients: MCPServerConnection[],
): string | undefined {
  const serverConnection = findMcpServerConnection(toolName, mcpClients)
  if (serverConnection?.type !== 'connected') {
    return undefined
  }
  return getLoggingSafeMcpBaseUrl(serverConnection.config)
}

/** 【对外主入口】执行一次模型点名的工具调用。这是一个【异步生成器】：
 *  每完成一个阶段就 yield 一条消息（进度消息、hook 消息、最终 tool_result 消息……），
 *  调用方用 `for await` 边收边渲染，界面因此能实时看到工具在干什么。
 *  入参：
 *    toolUse          模型输出的 tool_use 块（含 name、id、input）
 *    assistantMessage 触发这次调用的那条 assistant 消息（提供 message.id、requestId、uuid 等关联信息）
 *    canUseTool      权限判定的回调（工具内部若还要临时申请权限也用它）
 *    toolUseContext  运行时上下文（工具池、权限、AppState、消息历史、abortController 等）
 *  返回 AsyncGenerator<MessageUpdateLazy, void>：逐条产出的消息
 *  关键步骤：
 *    ① 在当前工具池里按名字找工具；找不到再去全量清单里按别名找（兼容旧会话里的旧工具名）
 *    ② 找不到工具 → 记日志 + 产出一条 is_error 的 tool_result（把「没有这个工具」回灌给模型）
 *    ③ 已经 abort（用户中断）→ 产出取消消息
 *    ④ 否则把 streamedCheckPermissionsAndCallTool 产出的每条消息原样转发上去
 *    ⑤ 全程包在 try/catch 里：任何意外异常都变成一条 is_error 的 tool_result，绝不向上抛
 *  设计取向：工具调用【永远不抛异常给主循环】——失败也要以消息形式告诉模型，让它自己决定下一步。
 */
export async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  const toolName = toolUse.name
  // First try to find in the available tools (what the model sees)
  let tool = findToolByName(toolUseContext.options.tools, toolName)
// 先在「模型当前能看到的工具池」里找。这个池子可能已经被 deny 规则、agent 类型等裁剪过。

  // If not found, check if it's a deprecated tool being called by alias
  // (e.g., old transcripts calling "KillShell" which is now an alias for "TaskStop")
  // Only fall back for tools where the name matches an alias, not the primary name
  if (!tool) {
    const fallbackTool = findToolByName(getAllBaseTools(), toolName)
    // Only use fallback if the tool was found via alias (deprecated name)
    if (fallbackTool && fallbackTool.aliases?.includes(toolName)) {
      tool = fallbackTool
    }
  }
// 兜底：有些老会话里存的是旧工具名（如 KillShell 现在是 TaskStop 的别名），
// 这时从全量清单里找，但【只接受别名命中】——避免把「当前不该出现的工具」又放进来。
  const messageId = assistantMessage.message.id
  const requestId = assistantMessage.requestId
  const mcpServerType = getMcpServerType(
    toolName,
    toolUseContext.options.mcpClients,
  )
  const mcpServerBaseUrl = getMcpServerBaseUrlFromToolName(
    toolName,
    toolUseContext.options.mcpClients,
  )

  // Check if the tool exists
// 工具不存在：不抛异常，而是回一条 is_error 的 tool_result。
// 这样模型能收到「没有这个工具」的反馈并自我纠正（比如改用 ToolSearch 去加载它）。
  if (!tool) {
    const sanitizedToolName = sanitizeToolNameForAnalytics(toolName)
    logForDebugging(`Unknown tool ${toolName}: ${toolUse.id}`)
    logEvent('tengu_tool_use_error', {
      error:
        `No such tool available: ${sanitizedToolName}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizedToolName,
      toolUseID:
        toolUse.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      isMcp: toolName.startsWith('mcp__'),
      queryChainId: toolUseContext.queryTracking
        ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && {
        mcpServerType:
          mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(mcpServerBaseUrl && {
        mcpServerBaseUrl:
          mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(requestId && {
        requestId:
          requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...mcpToolDetailsForAnalytics(toolName, mcpServerType, mcpServerBaseUrl),
    })
    yield {
      message: createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: `Error: No such tool available: ${toolName}`,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    }
    return
  }

  const toolInput = toolUse.input as { [key: string]: string }
// 从这里开始进入真正的执行流程；整个块用 try/catch 包住，任何异常都降级成一条错误消息。
  try {
// 取消检查：用户按了 ESC / 超时 / 父任务取消。此时直接产出取消消息，不再执行工具。
    if (toolUseContext.abortController.signal.aborted) {
      logEvent('tengu_tool_use_cancelled', {
        toolName: sanitizeToolNameForAnalytics(tool.name),
        toolUseID:
          toolUse.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        isMcp: tool.isMcp ?? false,

        queryChainId: toolUseContext.queryTracking
          ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        queryDepth: toolUseContext.queryTracking?.depth,
        ...(mcpServerType && {
          mcpServerType:
            mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(mcpServerBaseUrl && {
          mcpServerBaseUrl:
            mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(requestId && {
          requestId:
            requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...mcpToolDetailsForAnalytics(
          tool.name,
          mcpServerType,
          mcpServerBaseUrl,
        ),
      })
      const content = createToolResultStopMessage(toolUse.id)
      content.content = withMemoryCorrectionHint(CANCEL_MESSAGE)
      yield {
        message: createUserMessage({
          content: [content],
          toolUseResult: CANCEL_MESSAGE,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      }
      return
    }

// 把内部异步生成器产出的每一条更新【原样转发】给上层（for await + yield 是转发流的标准写法）。
    for await (const update of streamedCheckPermissionsAndCallTool(
      tool,
      toolUse.id,
      toolInput,
      toolUseContext,
      canUseTool,
      assistantMessage,
      messageId,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
      yield update
    }
  } catch (error) {
// 兜底的错误处理：即便内部流程炸了，也要给模型回一条错误结果，保证 tool_use 一定会被配对。
    logError(error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    const toolInfo = tool ? ` (${tool.name})` : ''
    const detailedError = `Error calling tool${toolInfo}: ${errorMessage}`

    yield {
      message: createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: `<tool_use_error>${detailedError}</tool_use_error>`,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: detailedError,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    }
  }
}

/** 【桥接层】把「回调式上报的进度」和「Promise 形式的最终结果」合成【一条异步流】。
 *  为什么需要它：tool.call 的进度是通过 onProgress 回调往外推的（推模式），
 *  而上层希望能用 for await 顺序消费（拉模式）。这里用一个 Stream 队列做中间缓冲：
 *    · 每来一个 progress 回调 → enqueue 一条 progress 消息
 *    · Promise resolve 后 → 把结果消息们依次 enqueue
 *    · Promise reject → stream.error(error)
 *    · 最后一定 stream.done() 关闭流
 *  注意这里【没有 await】那个 Promise：函数立即返回流，让调用方边跑边收（见上方英文注释里的 self-criticism）。
 *  入参 onProgress 以外的参数都原样传给 checkPermissionsAndCallTool。
 */
function streamedCheckPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: { [key: string]: boolean | string | number },
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: ReturnType<typeof getLoggingSafeMcpBaseUrl>,
): AsyncIterable<MessageUpdateLazy> {
  // This is a bit of a hack to get progress events and final results
  // into a single async iterable.
  //
  // Ideally the progress reporting and tool call reporting would
  // be via separate mechanisms.
  const stream = new Stream<MessageUpdateLazy>()
// Stream 是一个手写的异步队列：支持 enqueue / done / error，可以被 for await 消费。
  checkPermissionsAndCallTool(
    tool,
    toolUseID,
    input,
    toolUseContext,
    canUseTool,
    assistantMessage,
    messageId,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
    progress => {
      logEvent('tengu_tool_use_progress', {
        messageID:
          messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        toolName: sanitizeToolNameForAnalytics(tool.name),
        isMcp: tool.isMcp ?? false,

        queryChainId: toolUseContext.queryTracking
          ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        queryDepth: toolUseContext.queryTracking?.depth,
        ...(mcpServerType && {
          mcpServerType:
            mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(mcpServerBaseUrl && {
          mcpServerBaseUrl:
            mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(requestId && {
          requestId:
            requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...mcpToolDetailsForAnalytics(
          tool.name,
          mcpServerType,
          mcpServerBaseUrl,
        ),
      })
      stream.enqueue({
        message: createProgressMessage({
          toolUseID: progress.toolUseID,
          parentToolUseID: toolUseID,
          data: progress.data,
        }),
      })
    },
  )
    .then(results => {
      for (const result of results) {
        stream.enqueue(result)
      }
    })
    .catch(error => {
      stream.error(error)
    })
    .finally(() => {
      stream.done()
    })
  return stream
}

/**
 * Appended to Zod errors when a deferred tool wasn't in the discovered-tool
 * set — re-runs the claude.ts schema-filter scan dispatch-time to detect the
 * mismatch. The raw Zod error ("expected array, got string") doesn't tell the
 * model to re-load the tool; this hint does. Null if the schema was sent.
 */
/** 生成「工具 schema 没被发给模型」时的补救提示。
 *  背景：工具被 defer（延迟加载）时，模型手里没有它的 schema，于是会把数组/数字等类型参数
 *  全当成字符串发过来，被客户端解析拒绝。这时候光报 zod 错误没用，得明确告诉模型
 *  「先调 ToolSearch 加载这个工具，再重试」。
 *  返回 null 表示不需要这个提示（schema 本来就在 prompt 里、或工具不属于 defer 类、或已发现过）。
 *  判据（见英文注释）用了乐观估计：完整重算 claude.ts 的 useToolSearch 太脆弱，
 *  宁可偶尔误判（多一次往返）也不要指向一个不可调用的 ToolSearch。
 */
export function buildSchemaNotSentHint(
  tool: Tool,
  messages: Message[],
  tools: readonly { name: string }[],
): string | null {
  // Optimistic gating — reconstructing claude.ts's full useToolSearch
  // computation is fragile. These two gates prevent pointing at a ToolSearch
  // that isn't callable; occasional misfires (Haiku, tst-auto below threshold)
  // cost one extra round-trip on an already-failing path.
  if (!isToolSearchEnabledOptimistic()) return null
  if (!isToolSearchToolAvailable(tools)) return null
  if (!isDeferredTool(tool)) return null
  const discovered = extractDiscoveredToolNames(messages)
  if (discovered.has(tool.name)) return null
  return (
    `\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. ` +
    `Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ` +
    `Load the tool first: call ${TOOL_SEARCH_TOOL_NAME} with query "select:${tool.name}", then retry this call.`
  )
}

/** 【执行主体】完成一次工具调用的全部流程（本文件最长的函数）。
 *  入参：
 *    tool / toolUseID / input —— 工具对象、本次调用的 ID、模型给的入参
 *    toolUseContext / canUseTool / assistantMessage —— 上下文、权限回调、触发消息
 *    messageId / requestId / mcpServerType / mcpServerBaseUrl —— 埋点与 MCP 相关信息
 *    onToolProgress —— 进度上报回调（会被转成 progress 消息流出去）
 *  返回 MessageUpdateLazy[]：本次调用产生的全部消息（进度另走回调，不在这里）
 *  七个阶段（与文件头的总览一一对应）：
 *    ① zod 结构校验：失败 → 返回 InputValidationError（并可能附带 ToolSearch 补救提示）
 *    ② tool.validateInput() 业务校验：失败 → 返回带 message 的错误结果
 *    ③ PreToolUse hook：可改写入参 / 直接决定权限 / 注入上下文 / 要求停止
 *    ④ 权限判定 resolveHookPermissionDecision：allow 才继续；否则返回拒绝消息
 *    ⑤ tool.call() 真正执行（期间通过 onToolProgress 上报进度）
 *    ⑥ PostToolUse hook：可改写输出（MCP 尤其）、追加上下文、要求停止
 *    ⑦ 结果规整：序列化 → 超限落盘 → 连同反馈/图片一起包装成 user 消息
 *  失败路径（catch）：记日志 + 跑 PostToolUseFailure hook + 返回 is_error 结果
 *  finally：停止会话活动心跳、清理本次的权限决策记录
 */
async function checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: { [key: string]: boolean | string | number },
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: ReturnType<typeof getLoggingSafeMcpBaseUrl>,
  onToolProgress: (
    progress: ToolProgress<ToolProgressData> | ProgressMessage<HookProgress>,
  ) => void,
): Promise<MessageUpdateLazy[]> {
  // Validate input types with zod (surprisingly, the model is not great at generating valid input)
// 【阶段 ①】用 zod 校验入参的结构与类型。英文注释那句吐槽很实在：模型生成合法入参的能力其实并不好。
  const parsedInput = tool.inputSchema.safeParse(input)
  if (!parsedInput.success) {
    let errorContent = formatZodValidationError(tool.name, parsedInput.error)

    const schemaHint = buildSchemaNotSentHint(
      tool,
      toolUseContext.messages,
      toolUseContext.options.tools,
    )
    if (schemaHint) {
      logEvent('tengu_deferred_tool_schema_not_sent', {
        toolName: sanitizeToolNameForAnalytics(tool.name),
        isMcp: tool.isMcp ?? false,
      })
      errorContent += schemaHint
    }

    logForDebugging(
      `${tool.name} tool input error: ${errorContent.slice(0, 200)}`,
    )
    logEvent('tengu_tool_use_error', {
      error:
        'InputValidationError' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      errorDetails: errorContent.slice(
        0,
        2000,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(tool.name),
      isMcp: tool.isMcp ?? false,

      queryChainId: toolUseContext.queryTracking
        ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && {
        mcpServerType:
          mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(mcpServerBaseUrl && {
        mcpServerBaseUrl:
          mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(requestId && {
        requestId:
          requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl),
    })
    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: `<tool_use_error>InputValidationError: ${errorContent}</tool_use_error>`,
              is_error: true,
              tool_use_id: toolUseID,
            },
          ],
          toolUseResult: `InputValidationError: ${parsedInput.error.message}`,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      },
    ]
  }

  // Validate input values. Each tool has its own validation logic
// 【阶段 ②】工具自己的业务校验（validateInput 是可选方法，故用 ?. 调用）。
// 与 ① 的分工：① 管「参数长得对不对」，② 管「在这个环境下行不行得通」（文件是否存在、是否被允许等）。
  const isValidCall = await tool.validateInput?.(
    parsedInput.data,
    toolUseContext,
  )
  if (isValidCall?.result === false) {
    logForDebugging(
      `${tool.name} tool validation error: ${isValidCall.message?.slice(0, 200)}`,
    )
    logEvent('tengu_tool_use_error', {
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(tool.name),
      error:
        isValidCall.message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      errorCode: isValidCall.errorCode,
      isMcp: tool.isMcp ?? false,

      queryChainId: toolUseContext.queryTracking
        ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && {
        mcpServerType:
          mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(mcpServerBaseUrl && {
        mcpServerBaseUrl:
          mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(requestId && {
        requestId:
          requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl),
    })
    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: `<tool_use_error>${isValidCall.message}</tool_use_error>`,
              is_error: true,
              tool_use_id: toolUseID,
            },
          ],
          toolUseResult: `Error: ${isValidCall.message}`,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      },
    ]
  }
  // Speculatively start the bash allow classifier check early so it runs in
  // parallel with pre-tool hooks, deny/ask classifiers, and permission dialog
  // setup. The UI indicator (setClassifierChecking) is NOT set here — it's
  // set in interactiveHandler.ts only when the permission check returns `ask`
  // with a pendingClassifierCheck. This avoids flashing "classifier running"
  // for commands that auto-allow via prefix rules.
// 投机性优化：Bash 命令的安全分类器判断很慢，这里【提前】把它启动起来，
// 让它与后面的 PreToolUse hook、权限判定、弹窗准备【并行】跑，省下整段等待时间。
// 但界面上的「正在检查」指示器不在这里点亮——只有权限判定确实返回 ask 且有待定分类器时才点亮，
// 否则那些靠前缀规则直接放行的命令会莫名其妙闪一下「检查中」。
  if (
    tool.name === BASH_TOOL_NAME &&
    parsedInput.data &&
    'command' in parsedInput.data
  ) {
    const appState = toolUseContext.getAppState()
    startSpeculativeClassifierCheck(
      (parsedInput.data as BashToolInput).command,
      appState.toolPermissionContext,
      toolUseContext.abortController.signal,
      toolUseContext.options.isNonInteractiveSession,
    )
  }

  const resultingMessages = []

  // Defense-in-depth: strip _simulatedSedEdit from model-provided Bash input.
  // This field is internal-only — it must only be injected by the permission
  // system (SedEditPermissionRequest) after user approval. If the model supplies
  // it, the schema's strictObject should already reject it, but we strip here
  // as a safeguard against future regressions.
// 纵深防御：_simulatedSedEdit 是【内部专用】字段，只允许权限系统在用户批准 sed 类编辑后注入。
// 如果模型自己塞了这个字段（绕过授权），这里直接剥掉——schema 的 strictObject 本该挡住，多一层保险。
  let processedInput = parsedInput.data
  if (
    tool.name === BASH_TOOL_NAME &&
    processedInput &&
    typeof processedInput === 'object' &&
    '_simulatedSedEdit' in processedInput
  ) {
    const { _simulatedSedEdit: _, ...rest } =
      processedInput as typeof processedInput & {
        _simulatedSedEdit: unknown
      }
    processedInput = rest as typeof processedInput
  }

  // Backfill legacy/derived fields on a shallow clone so hooks/canUseTool see
  // them without affecting tool.call(). SendMessageTool adds fields; file
  // tools overwrite file_path with expandPath — that mutation must not reach
  // call() because tool results embed the input path verbatim (e.g. "File
  // created successfully at: {path}"), and changing it alters the serialized
  // transcript and VCR fixture hashes. If a hook/permission later returns a
  // fresh updatedInput, callInput converges on it below — that replacement
  // is intentional and should reach call().
// 这里有个很微妙的双份入参设计（processedInput vs callInput）：
//   · backfilledClone 是给【hook / canUseTool / SDK / transcript】看的副本，补上了兼容字段与展开后的路径
//   · callInput 仍是模型给的原始入参，交给 tool.call() 使用
// 为什么必须分开：工具结果文本里会把路径原样拼进去（如 File created successfully at: {path}），
// 一旦用展开后的路径，序列化结果就变了，transcript 与 VCR 测试固件的哈希都会漂移。
// 只有当 hook/权限【明确返回】新入参时，才让 callInput 收敛到它——那种替换是有意为之、应当生效的。
  let callInput = processedInput
  const backfilledClone =
    tool.backfillObservableInput &&
    typeof processedInput === 'object' &&
    processedInput !== null
      ? ({ ...processedInput } as typeof processedInput)
      : null
  if (backfilledClone) {
    tool.backfillObservableInput!(backfilledClone as Record<string, unknown>)
    processedInput = backfilledClone
  }

  let shouldPreventContinuation = false
  let stopReason: string | undefined
  let hookPermissionResult: PermissionResult | undefined
  const preToolHookInfos: StopHookInfo[] = []
// 下面这几个变量用来收集 PreToolUse 阶段的各种「副作用」决定，稍后再统一处理。
  const preToolHookStart = Date.now()
// 【阶段 ③】跑 PreToolUse hook。它也是一个异步生成器：
// hook 可能逐个产出多条消息（进度、附件、上下文、权限决定……），这里边收边分派。
  for await (const result of runPreToolUseHooks(
    toolUseContext,
    tool,
    processedInput,
    toolUseID,
    assistantMessage.message.id,
    requestId,
    mcpServerType,
    mcpServerBaseUrl,
  )) {
    switch (result.type) {
// hook 的产出按 type 判别（可辨识联合）：
//   message              —— 进度消息走 onToolProgress，其余收进结果列表
//   hookPermissionResult —— hook 直接给出了权限决定（allow/deny/ask）
//   hookUpdatedInput     —— hook 改写入参但没做权限决定（透传），后续仍走正常权限流程
//   preventContinuation / stopReason —— hook 要求停止继续
//   stop                 —— 立即终止，返回一条「被 hook 停止」的错误结果
      case 'message':
        if (result.message.message.type === 'progress') {
          onToolProgress(result.message.message)
        } else {
          resultingMessages.push(result.message)
          const att = result.message.message.attachment
          if (
            att &&
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            preToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            })
          }
        }
        break
      case 'hookPermissionResult':
        hookPermissionResult = result.hookPermissionResult
        break
      case 'hookUpdatedInput':
        // Hook provided updatedInput without making a permission decision (passthrough)
        // Update processedInput so it's used in the normal permission flow
        processedInput = result.updatedInput
        break
      case 'preventContinuation':
        shouldPreventContinuation = result.shouldPreventContinuation
        break
      case 'stopReason':
        stopReason = result.stopReason
        break
      case 'additionalContext':
        resultingMessages.push(result.message)
        break
      case 'stop':
        getStatsStore()?.observe(
          'pre_tool_hook_duration_ms',
          Date.now() - preToolHookStart,
        )
        resultingMessages.push({
          message: createUserMessage({
            content: [createToolResultStopMessage(toolUseID)],
            toolUseResult: `Error: ${stopReason}`,
            sourceToolAssistantUUID: assistantMessage.uuid,
          }),
        })
        return resultingMessages
    }
  }
  const preToolHookDurationMs = Date.now() - preToolHookStart
// 记下 PreToolUse 的实际耗时，并上报指标；超过 2 秒就打一条 info 日志（后面排查卡顿时很有用）。
  getStatsStore()?.observe('pre_tool_hook_duration_ms', preToolHookDurationMs)
  if (preToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
    logForDebugging(
      `Slow PreToolUse hooks: ${preToolHookDurationMs}ms for ${tool.name} (${preToolHookInfos.length} hooks)`,
      { level: 'info' },
    )
  }

  // Emit PreToolUse summary immediately so it's visible while the tool executes.
  // Use wall-clock time (not sum of individual durations) since hooks run in parallel.
// 耗时用【墙上时钟】而不是各 hook 耗时之和——因为多个 hook 是并行跑的，加起来会虚高。
  if (process.env.USER_TYPE === 'ant' && preToolHookInfos.length > 0) {
    if (preToolHookDurationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS) {
      resultingMessages.push({
        message: createStopHookSummaryMessage(
          preToolHookInfos.length,
          preToolHookInfos,
          [],
          false,
          undefined,
          false,
          'suggestion',
          undefined,
          'PreToolUse',
          preToolHookDurationMs,
        ),
      })
    }
  }

  const toolAttributes: Record<string, string | number | boolean> = {}
  if (processedInput && typeof processedInput === 'object') {
    if (tool.name === FILE_READ_TOOL_NAME && 'file_path' in processedInput) {
      toolAttributes.file_path = String(processedInput.file_path)
    } else if (
      (tool.name === FILE_EDIT_TOOL_NAME ||
        tool.name === FILE_WRITE_TOOL_NAME) &&
      'file_path' in processedInput
    ) {
      toolAttributes.file_path = String(processedInput.file_path)
    } else if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
      const bashInput = processedInput as BashToolInput
      toolAttributes.full_command = bashInput.command
    }
  }

// 开启 OTel 追踪跨度：整次工具调用一个 span，其中「等待用户决策」单独一段（后面会结束它）。
  startToolSpan(
    tool.name,
    toolAttributes,
    isBetaTracingEnabled() ? jsonStringify(processedInput) : undefined,
  )
  startToolBlockedOnUserSpan()

  // Check whether we have permission to use the tool,
  // and ask the user for permission if we don't
// 【阶段 ④】权限判定。这是安全的关键闸门：把 hook 的决定、工具自己的 checkPermissions、
// 通用权限规则、auto 模式分类器、以及必要时的用户交互，合并成一个最终决定。
  const permissionMode = toolUseContext.getAppState().toolPermissionContext.mode
  const permissionStart = Date.now()

  const resolved = await resolveHookPermissionDecision(
    hookPermissionResult,
    tool,
    processedInput,
    toolUseContext,
    canUseTool,
    assistantMessage,
    toolUseID,
  )
  const permissionDecision = resolved.decision
// 权限判定可能同时改写入参（例如把相对路径展开、把 sed 编辑改写成安全的等价形式），所以取回新入参。
  processedInput = resolved.input
  const permissionDurationMs = Date.now() - permissionStart
  // In auto mode, canUseTool awaits the classifier (side_query) — if that's
  // slow the collapsed view shows "Running…" with no (Ns) tick since
  // bash_progress hasn't started yet. Auto-only: in default mode this timer
  // includes interactive-dialog wait (user think time), which is just noise.
  if (
    permissionDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS &&
    permissionMode === 'auto'
  ) {
    logForDebugging(
      `Slow permission decision: ${permissionDurationMs}ms for ${tool.name} ` +
        `(mode=${permissionMode}, behavior=${permissionDecision.behavior})`,
      { level: 'info' },
    )
  }

  // Emit tool_decision OTel event and code-edit counter if the interactive
  // permission path didn't already log it (headless mode bypasses permission
  // logging, so we need to emit both the generic event and the code-edit
  // counter here)
// 补发 tool_decision 埋点：交互路径（interactiveHandler）已经发过了，
// 而 headless 模式不走那条路，所以要在这里补发，同时补上代码编辑类工具的计数器。
  if (
    permissionDecision.behavior !== 'ask' &&
    !toolUseContext.toolDecisions?.has(toolUseID)
  ) {
    const decision =
      permissionDecision.behavior === 'allow' ? 'accept' : 'reject'
    const source = decisionReasonToOTelSource(
      permissionDecision.decisionReason,
      permissionDecision.behavior,
    )
    void logOTelEvent('tool_decision', {
      decision,
      source,
      tool_name: sanitizeToolNameForAnalytics(tool.name),
    })

    // Increment code-edit tool decision counter for headless mode
    if (isCodeEditingTool(tool.name)) {
      void buildCodeEditToolAttributes(
        tool,
        processedInput,
        decision,
        source,
      ).then(attributes => getCodeEditToolDecisionCounter()?.add(1, attributes))
    }
  }

  // Add message if permission was granted/denied by PermissionRequest hook
  if (
    permissionDecision.decisionReason?.type === 'hook' &&
    permissionDecision.decisionReason.hookName === 'PermissionRequest' &&
    permissionDecision.behavior !== 'ask'
  ) {
    resultingMessages.push({
      message: createAttachmentMessage({
        type: 'hook_permission_decision',
        decision: permissionDecision.behavior,
        toolUseID,
        hookEvent: 'PermissionRequest',
      }),
    })
  }

// 【拒绝分支】权限没通过（deny 或用户拒绝 ask）：结束追踪跨度、记日志，
// 然后组装一条 is_error 的 tool_result 把原因回灌给模型。
  if (permissionDecision.behavior !== 'allow') {
    logForDebugging(`${tool.name} tool permission denied`)
    const decisionInfo = toolUseContext.toolDecisions?.get(toolUseID)
    endToolBlockedOnUserSpan('reject', decisionInfo?.source || 'unknown')
    endToolSpan()

    logEvent('tengu_tool_use_can_use_tool_rejected', {
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(tool.name),

      queryChainId: toolUseContext.queryTracking
        ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && {
        mcpServerType:
          mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(mcpServerBaseUrl && {
        mcpServerBaseUrl:
          mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(requestId && {
        requestId:
          requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl),
    })
    let errorMessage = permissionDecision.message
    // Only use generic "Execution stopped" message if we don't have a detailed hook message
    if (shouldPreventContinuation && !errorMessage) {
      errorMessage = `Execution stopped by PreToolUse hook${stopReason ? `: ${stopReason}` : ''}`
    }
// 优先使用 hook/权限给出的详细原因；只有在 hook 要求停止、但没给具体原因时才用通用的「执行已停止」。

    // Build top-level content: tool_result (text-only for is_error compatibility) + images alongside
    const messageContent: ContentBlockParam[] = [
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ]

    // Add image blocks at top level (not inside tool_result, which rejects non-text with is_error)
// 图片必须放在 tool_result【外面】作为兄弟块：API 规定 is_error 的 tool_result 里只能有文本块，
// 把图片塞进去会直接 400。
    const rejectContentBlocks =
      permissionDecision.behavior === 'ask'
        ? permissionDecision.contentBlocks
        : undefined
    if (rejectContentBlocks?.length) {
      messageContent.push(...rejectContentBlocks)
    }

    // Generate sequential imagePasteIds so each image renders with a distinct label
    let rejectImageIds: number[] | undefined
    if (rejectContentBlocks?.length) {
      const imageCount = count(
        rejectContentBlocks,
        (b: ContentBlockParam) => b.type === 'image',
      )
      if (imageCount > 0) {
        const startId = getNextImagePasteId(toolUseContext.messages)
        rejectImageIds = Array.from(
          { length: imageCount },
          (_, i) => startId + i,
        )
      }
    }

    resultingMessages.push({
      message: createUserMessage({
        content: messageContent,
        imagePasteIds: rejectImageIds,
        toolUseResult: `Error: ${errorMessage}`,
        sourceToolAssistantUUID: assistantMessage.uuid,
      }),
    })

    // Run PermissionDenied hooks for auto mode classifier denials.
    // If a hook returns {retry: true}, tell the model it may retry.
    if (
      feature('TRANSCRIPT_CLASSIFIER') &&
      permissionDecision.decisionReason?.type === 'classifier' &&
      permissionDecision.decisionReason.classifier === 'auto-mode'
    ) {
      let hookSaysRetry = false
      for await (const result of executePermissionDeniedHooks(
        tool.name,
        toolUseID,
        processedInput,
        permissionDecision.decisionReason.reason ?? 'Permission denied',
        toolUseContext,
        permissionMode,
        toolUseContext.abortController.signal,
      )) {
        if (result.retry) hookSaysRetry = true
      }
      if (hookSaysRetry) {
        resultingMessages.push({
          message: createUserMessage({
            content:
              'The PermissionDenied hook indicated this command is now approved. You may retry it if you would like.',
            isMeta: true,
          }),
        })
      }
    }

    return resultingMessages
  }
// 权限通过，继续往下执行（到这里才真正要跑工具了）。
  logEvent('tengu_tool_use_can_use_tool_allowed', {
    messageID:
      messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    toolName: sanitizeToolNameForAnalytics(tool.name),

    queryChainId: toolUseContext.queryTracking
      ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    queryDepth: toolUseContext.queryTracking?.depth,
    ...(mcpServerType && {
      mcpServerType:
        mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(mcpServerBaseUrl && {
      mcpServerBaseUrl:
        mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(requestId && {
      requestId:
        requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl),
  })

  // Use the updated input from permissions if provided
  // (Don't overwrite if undefined - processedInput may have been modified by passthrough hooks)
  if (permissionDecision.updatedInput !== undefined) {
    processedInput = permissionDecision.updatedInput
  }
// 权限/ hook 可能给了改写后的入参；只在确实给了（!== undefined）时才覆盖，
// 否则保留前面透传 hook 已经改过的 processedInput（英文注释里点明了这个坑）。

  // Prepare tool parameters for logging in tool_result event.
  // Gated by OTEL_LOG_TOOL_DETAILS — tool parameters can contain sensitive
  // content (bash commands, MCP server names, etc.) so they're opt-in only.
  const telemetryToolInput = extractToolInputForTelemetry(processedInput)
  let toolParameters: Record<string, unknown> = {}
  if (isToolDetailsLoggingEnabled()) {
    if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
      const bashInput = processedInput as BashToolInput
      const commandParts = bashInput.command.trim().split(/\s+/)
      const bashCommand = commandParts[0] || ''

      toolParameters = {
        bash_command: bashCommand,
        full_command: bashInput.command,
        ...(bashInput.timeout !== undefined && {
          timeout: bashInput.timeout,
        }),
        ...(bashInput.description !== undefined && {
          description: bashInput.description,
        }),
        ...('dangerouslyDisableSandbox' in bashInput && {
          dangerouslyDisableSandbox: bashInput.dangerouslyDisableSandbox,
        }),
      }
    }

    const mcpDetails = extractMcpToolDetails(tool.name)
    if (mcpDetails) {
      toolParameters.mcp_server_name = mcpDetails.serverName
      toolParameters.mcp_tool_name = mcpDetails.mcpToolName
    }
    const skillName = extractSkillName(tool.name, processedInput)
    if (skillName) {
      toolParameters.skill_name = skillName
    }
  }

  const decisionInfo = toolUseContext.toolDecisions?.get(toolUseID)
  endToolBlockedOnUserSpan(
    decisionInfo?.decision || 'unknown',
    decisionInfo?.source || 'unknown',
  )
  startToolExecutionSpan()

  const startTime = Date.now()

  startSessionActivity('tool_exec')
// 标记「会话正在活动」：长时间工具执行期间要维持心跳（避免被判定为空闲、影响超时与状态显示）。
  // If processedInput still points at the backfill clone, no hook/permission
  // replaced it — pass the pre-backfill callInput so call() sees the model's
  // original field values. Otherwise converge on the hook-supplied input.
  // Permission/hook flows may return a fresh object derived from the
  // backfilled clone (e.g. via inputSchema.parse). If its file_path matches
  // the backfill-expanded value, restore the model's original so the tool
  // result string embeds the path the model emitted — keeps transcript/VCR
  // hashes stable. Other hook modifications flow through unchanged.
  if (
    backfilledClone &&
    processedInput !== callInput &&
    typeof processedInput === 'object' &&
    processedInput !== null &&
    'file_path' in processedInput &&
    'file_path' in (callInput as Record<string, unknown>) &&
    (processedInput as Record<string, unknown>).file_path ===
      (backfilledClone as Record<string, unknown>).file_path
  ) {
    callInput = {
      ...processedInput,
      file_path: (callInput as Record<string, unknown>).file_path,
    } as typeof processedInput
  } else if (processedInput !== backfilledClone) {
    callInput = processedInput
  }
// 这一段在「还原 file_path」：如果权限流程基于 backfill 后的副本又造了一个新对象，
// 且它的 file_path 与 backfill 后的值相同，就把路径换回模型原始写法，
// 保证工具结果里的路径文本与模型发给的一致（transcript / VCR 哈希稳定）。
// 其它被 hook 有意改动的字段则原样保留。
  try {
// 【阶段 ⑤】真正调用工具的 call()。注意第二个参数里补充了 toolUseId 与 userModified，
// 让工具知道「自己这次被调用的 ID」以及「用户是否改过入参」。
    const result = await tool.call(
      callInput,
      {
        ...toolUseContext,
        toolUseId: toolUseID,
        userModified: permissionDecision.userModified ?? false,
      },
      canUseTool,
      assistantMessage,
      progress => {
        onToolProgress({
          toolUseID: progress.toolUseID,
          data: progress.data,
        })
      },
    )
// result 是 ToolResult<Output>：data 是业务结果，另外可能带 newMessages（工具想追加的消息）
// 与 contextModifier（工具想修改后续上下文，例如切换权限模式）。
    const durationMs = Date.now() - startTime
    addToToolDuration(durationMs)

    // Log tool content/output as span event if enabled
    if (result.data && typeof result.data === 'object') {
      const contentAttributes: Record<string, string | number | boolean> = {}

      // Read tool: capture file_path and content
      if (tool.name === FILE_READ_TOOL_NAME && 'content' in result.data) {
        if ('file_path' in processedInput) {
          contentAttributes.file_path = String(processedInput.file_path)
        }
        contentAttributes.content = String(result.data.content)
      }

      // Edit/Write tools: capture file_path and diff
      if (
        (tool.name === FILE_EDIT_TOOL_NAME ||
          tool.name === FILE_WRITE_TOOL_NAME) &&
        'file_path' in processedInput
      ) {
        contentAttributes.file_path = String(processedInput.file_path)

        // For Edit, capture the actual changes made
        if (tool.name === FILE_EDIT_TOOL_NAME && 'diff' in result.data) {
          contentAttributes.diff = String(result.data.diff)
        }
        // For Write, capture the written content
        if (tool.name === FILE_WRITE_TOOL_NAME && 'content' in processedInput) {
          contentAttributes.content = String(processedInput.content)
        }
      }

      // Bash tool: capture command
      if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
        const bashInput = processedInput as BashToolInput
        contentAttributes.bash_command = bashInput.command
        // Also capture output if available
        if ('output' in result.data) {
          contentAttributes.output = String(result.data.output)
        }
      }

      if (Object.keys(contentAttributes).length > 0) {
        addToolContentEvent('tool.output', contentAttributes)
      }
    }

    // Capture structured output from tool result if present
    if (typeof result === 'object' && 'structured_output' in result) {
      // Store the structured output in an attachment message
      resultingMessages.push({
        message: createAttachmentMessage({
          type: 'structured_output',
          data: result.structured_output,
        }),
      })
    }

    endToolExecutionSpan({ success: true })
    // Pass tool result for new_context logging
    const toolResultStr =
      result.data && typeof result.data === 'object'
        ? jsonStringify(result.data)
        : String(result.data ?? '')
    endToolSpan(toolResultStr)

    // Map the tool result to API format once and cache it. This block is reused
    // by addToolResult (skipping the remap) and measured here for analytics.
    const mappedToolResultBlock = tool.mapToolResultToToolResultBlockParam(
      result.data,
      toolUseID,
    )
// 把结果序列化成 API 的 tool_result 块，并且【只做一次】——后面 addToolResult 会复用它，
// 顺便在这里量出结果大小用于埋点（避免重复序列化）。
    const mappedContent = mappedToolResultBlock.content
    const toolResultSizeBytes = !mappedContent
      ? 0
      : typeof mappedContent === 'string'
        ? mappedContent.length
        : jsonStringify(mappedContent).length

    // Extract file extension for file-related tools
    let fileExtension: ReturnType<typeof getFileExtensionForAnalytics>
    if (processedInput && typeof processedInput === 'object') {
      if (
        (tool.name === FILE_READ_TOOL_NAME ||
          tool.name === FILE_EDIT_TOOL_NAME ||
          tool.name === FILE_WRITE_TOOL_NAME) &&
        'file_path' in processedInput
      ) {
        fileExtension = getFileExtensionForAnalytics(
          String(processedInput.file_path),
        )
      } else if (
        tool.name === NOTEBOOK_EDIT_TOOL_NAME &&
        'notebook_path' in processedInput
      ) {
        fileExtension = getFileExtensionForAnalytics(
          String(processedInput.notebook_path),
        )
      } else if (tool.name === BASH_TOOL_NAME && 'command' in processedInput) {
        const bashInput = processedInput as BashToolInput
        fileExtension = getFileExtensionsFromBashCommand(
          bashInput.command,
          bashInput._simulatedSedEdit?.filePath,
        )
      }
    }

    logEvent('tengu_tool_use_success', {
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(tool.name),
      isMcp: tool.isMcp ?? false,
      durationMs,
      preToolHookDurationMs,
      toolResultSizeBytes,
      ...(fileExtension !== undefined && { fileExtension }),

      queryChainId: toolUseContext.queryTracking
        ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: toolUseContext.queryTracking?.depth,
      ...(mcpServerType && {
        mcpServerType:
          mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(mcpServerBaseUrl && {
        mcpServerBaseUrl:
          mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(requestId && {
        requestId:
          requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...mcpToolDetailsForAnalytics(tool.name, mcpServerType, mcpServerBaseUrl),
    })

    // Enrich tool parameters with git commit ID from successful git commit output
    if (
      isToolDetailsLoggingEnabled() &&
      (tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME) &&
      'command' in processedInput &&
      typeof processedInput.command === 'string' &&
      processedInput.command.match(/\bgit\s+commit\b/) &&
      result.data &&
      typeof result.data === 'object' &&
      'stdout' in result.data
    ) {
      const gitCommitId = parseGitCommitId(String(result.data.stdout))
      if (gitCommitId) {
        toolParameters.git_commit_id = gitCommitId
      }
    }

    // Log tool result event for OTLP with tool parameters and decision context
    const mcpServerScope = isMcpTool(tool)
      ? getMcpServerScopeFromToolName(tool.name)
      : null

    void logOTelEvent('tool_result', {
      tool_name: sanitizeToolNameForAnalytics(tool.name),
      success: 'true',
      duration_ms: String(durationMs),
      ...(Object.keys(toolParameters).length > 0 && {
        tool_parameters: jsonStringify(toolParameters),
      }),
      ...(telemetryToolInput && { tool_input: telemetryToolInput }),
      tool_result_size_bytes: String(toolResultSizeBytes),
      ...(decisionInfo && {
        decision_source: decisionInfo.source,
        decision_type: decisionInfo.decision,
      }),
      ...(mcpServerScope && { mcp_server_scope: mcpServerScope }),
    })

    // Run PostToolUse hooks
// 【阶段 ⑥】跑 PostToolUse hook。它可以改写工具输出（MCP 工具尤其依赖这一点）、追加上下文、
// 或者要求停止继续。因此 MCP 工具的结果消息必须等 hook 跑完后才生成（见下面两处 addToolResult 的时机差异）。
    let toolOutput = result.data
    const hookResults = []
    const toolContextModifier = result.contextModifier
    const mcpMeta = result.mcpMeta

    async function addToolResult(
      toolUseResult: unknown,
      preMappedBlock?: ToolResultBlockParam,
    ) {
/** 把工具结果包装成一条 user 消息（tool_result 块）并追加到结果列表。
 *  入参 toolUseResult：工具的返回值；preMappedBlock：可选，前面已经序列化好的 tool_result 块
 *  步骤：
 *    ① 结果规整：优先复用已映射好的块（省一次序列化），否则重新映射；
 *       两者都会经过 processToolResultBlock —— 超过 maxResultSizeChars 就落盘、只留预览与文件路径
 *    ② 把用户批准时附带的反馈文本（acceptFeedback）作为兄弟文本块追加
 *    ③ 把批准时粘贴的图片作为兄弟块追加（不能放进 tool_result 内部）
 *    ④ 给这些图片分配连续的 imagePasteIds
 *    ⑤ 子 agent 场景下丢弃结构化结果与 MCP 元数据（它们不该出现在父会话的 transcript 里）
 *    ⑥ 若工具返回了 contextModifier，一并带上（由上层决定如何应用到后续上下文）
 */
      // Use the pre-mapped block when available (non-MCP tools where hooks
      // don't modify the output), otherwise map from scratch.
      const toolResultBlock = preMappedBlock
        ? await processPreMappedToolResultBlock(
            preMappedBlock,
            tool.name,
            tool.maxResultSizeChars,
          )
        : await processToolResultBlock(tool, toolUseResult, toolUseID)

      // Build content blocks - tool result first, then optional feedback
      const contentBlocks: ContentBlockParam[] = [toolResultBlock]
      // Add accept feedback if user provided feedback when approving
      // (acceptFeedback only exists on PermissionAllowDecision, which is guaranteed here)
      if (
        'acceptFeedback' in permissionDecision &&
        permissionDecision.acceptFeedback
      ) {
        contentBlocks.push({
          type: 'text',
          text: permissionDecision.acceptFeedback,
        })
      }

      // Add content blocks (e.g., pasted images) from the permission decision
      const allowContentBlocks =
        'contentBlocks' in permissionDecision
          ? permissionDecision.contentBlocks
          : undefined
      if (allowContentBlocks?.length) {
        contentBlocks.push(...allowContentBlocks)
      }

      // Generate sequential imagePasteIds so each image renders with a distinct label
      let allowImageIds: number[] | undefined
      if (allowContentBlocks?.length) {
        const imageCount = count(
          allowContentBlocks,
          (b: ContentBlockParam) => b.type === 'image',
        )
        if (imageCount > 0) {
          const startId = getNextImagePasteId(toolUseContext.messages)
          allowImageIds = Array.from(
            { length: imageCount },
            (_, i) => startId + i,
          )
        }
      }

      resultingMessages.push({
        message: createUserMessage({
          content: contentBlocks,
          imagePasteIds: allowImageIds,
          toolUseResult:
            toolUseContext.agentId && !toolUseContext.preserveToolUseResults
              ? undefined
              : toolUseResult,
          mcpMeta: toolUseContext.agentId ? undefined : mcpMeta,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
        contextModifier: toolContextModifier
          ? {
              toolUseID: toolUseID,
              modifyContext: toolContextModifier,
            }
          : undefined,
      })
    }

    // TOOD(hackyon): refactor so we don't have different experiences for MCP tools
    if (!isMcpTool(tool)) {
      await addToolResult(toolOutput, mappedToolResultBlock)
    }
// 非 MCP 工具：hook 一般不会改它的输出，所以【先】生成结果消息（用户能更快看到输出），再跑 hook。

    const postToolHookInfos: StopHookInfo[] = []
    const postToolHookStart = Date.now()
    for await (const hookResult of runPostToolUseHooks(
      toolUseContext,
      tool,
      toolUseID,
      assistantMessage.message.id,
      processedInput,
      toolOutput,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
// 遍历 PostToolUse hook 的产出：MCP 工具的输出可能被 hook 改写（updatedMCPToolOutput），
// 所以 MCP 的结果消息要等到 hook 跑完之后才生成。
      if ('updatedMCPToolOutput' in hookResult) {
        if (isMcpTool(tool)) {
          toolOutput = hookResult.updatedMCPToolOutput
        }
      } else if (isMcpTool(tool)) {
        hookResults.push(hookResult)
        if (hookResult.message.type === 'attachment') {
          const att = hookResult.message.attachment
          if (
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            postToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            })
          }
        }
      } else {
        resultingMessages.push(hookResult)
        if (hookResult.message.type === 'attachment') {
          const att = hookResult.message.attachment
          if (
            'command' in att &&
            att.command !== undefined &&
            'durationMs' in att &&
            att.durationMs !== undefined
          ) {
            postToolHookInfos.push({
              command: att.command,
              durationMs: att.durationMs,
            })
          }
        }
      }
    }
    const postToolHookDurationMs = Date.now() - postToolHookStart
    if (postToolHookDurationMs >= SLOW_PHASE_LOG_THRESHOLD_MS) {
      logForDebugging(
        `Slow PostToolUse hooks: ${postToolHookDurationMs}ms for ${tool.name} (${postToolHookInfos.length} hooks)`,
        { level: 'info' },
      )
    }

    if (isMcpTool(tool)) {
      await addToolResult(toolOutput)
    }
// MCP 工具在 hook 之后才生成结果消息（因为输出可能已被 hook 改写），这也是上面那句 TODO 提到的
// 「MCP 与非 MCP 走不同路径」的历史遗留。

    // Show PostToolUse hook timing inline below tool result when > 500ms.
    // Use wall-clock time (not sum of individual durations) since hooks run in parallel.
    if (process.env.USER_TYPE === 'ant' && postToolHookInfos.length > 0) {
      if (postToolHookDurationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS) {
        resultingMessages.push({
          message: createStopHookSummaryMessage(
            postToolHookInfos.length,
            postToolHookInfos,
            [],
            false,
            undefined,
            false,
            'suggestion',
            undefined,
            'PostToolUse',
            postToolHookDurationMs,
          ),
        })
      }
    }

    // If the tool provided new messages, add them to the list to return.
    if (result.newMessages && result.newMessages.length > 0) {
      for (const message of result.newMessages) {
        resultingMessages.push({ message })
      }
    }
// 工具可以通过 ToolResult.newMessages 往会话里追加自己的消息
// （典型例子：子 agent 把完整 transcript 塞回来、或产出附件型消息）。
    // If hook indicated to prevent continuation after successful execution, yield a stop reason message
    if (shouldPreventContinuation) {
      resultingMessages.push({
        message: createAttachmentMessage({
          type: 'hook_stopped_continuation',
          message: stopReason || 'Execution stopped by hook',
          hookName: `PreToolUse:${tool.name}`,
          toolUseID: toolUseID,
          hookEvent: 'PreToolUse',
        }),
      })
    }

    // Yield the remaining hook results after the other messages are sent
    for (const hookResult of hookResults) {
      resultingMessages.push(hookResult)
    }
    return resultingMessages
  } catch (error) {
// 【失败路径】工具执行抛异常：记耗时与追踪、区分中断（AbortError）与真错误，
// 跑 PostToolUseFailure hook，最后仍然返回一条 is_error 的 tool_result（而不是让异常往上冒）。
    const durationMs = Date.now() - startTime
    addToToolDuration(durationMs)

    endToolExecutionSpan({
      success: false,
      error: errorMessage(error),
    })
    endToolSpan()

    // Handle MCP auth errors by updating the client status to 'needs-auth'
    // This updates the /mcp display to show the server needs re-authorization
// MCP 鉴权失败的特殊处理：把该 MCP 服务器在 UI 上的状态改成 needs-auth，提示用户重新授权。
    if (error instanceof McpAuthError) {
      toolUseContext.setAppState(prevState => {
        const serverName = error.serverName
        const existingClientIndex = prevState.mcp.clients.findIndex(
          c => c.name === serverName,
        )
        if (existingClientIndex === -1) {
          return prevState
        }
        const existingClient = prevState.mcp.clients[existingClientIndex]
        // Only update if client was connected (don't overwrite other states)
        if (!existingClient || existingClient.type !== 'connected') {
          return prevState
        }
        const updatedClients = [...prevState.mcp.clients]
        updatedClients[existingClientIndex] = {
          name: serverName,
          type: 'needs-auth' as const,
          config: existingClient.config,
        }
        return {
          ...prevState,
          mcp: {
            ...prevState.mcp,
            clients: updatedClients,
          },
        }
      })
    }

    if (!(error instanceof AbortError)) {
// 用户主动中断（AbortError）不算错误，不记错误日志与失败埋点——避免把正常的取消行为污染成故障率。
      const errorMsg = errorMessage(error)
      logForDebugging(
        `${tool.name} tool error (${durationMs}ms): ${errorMsg.slice(0, 200)}`,
      )
      if (!(error instanceof ShellError)) {
        logError(error)
      }
      logEvent('tengu_tool_use_error', {
        messageID:
          messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        toolName: sanitizeToolNameForAnalytics(tool.name),
        error: classifyToolError(
          error,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        isMcp: tool.isMcp ?? false,

        queryChainId: toolUseContext.queryTracking
          ?.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        queryDepth: toolUseContext.queryTracking?.depth,
        ...(mcpServerType && {
          mcpServerType:
            mcpServerType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(mcpServerBaseUrl && {
          mcpServerBaseUrl:
            mcpServerBaseUrl as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(requestId && {
          requestId:
            requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...mcpToolDetailsForAnalytics(
          tool.name,
          mcpServerType,
          mcpServerBaseUrl,
        ),
      })
      // Log tool result error event for OTLP with tool parameters and decision context
      const mcpServerScope = isMcpTool(tool)
        ? getMcpServerScopeFromToolName(tool.name)
        : null

      void logOTelEvent('tool_result', {
        tool_name: sanitizeToolNameForAnalytics(tool.name),
        use_id: toolUseID,
        success: 'false',
        duration_ms: String(durationMs),
        error: errorMessage(error),
        ...(Object.keys(toolParameters).length > 0 && {
          tool_parameters: jsonStringify(toolParameters),
        }),
        ...(telemetryToolInput && { tool_input: telemetryToolInput }),
        ...(decisionInfo && {
          decision_source: decisionInfo.source,
          decision_type: decisionInfo.decision,
        }),
        ...(mcpServerScope && { mcp_server_scope: mcpServerScope }),
      })
    }
    const content = formatError(error)
// formatError 会把各种异常（含 ShellError、MCP 错误）格式化成一段给模型看的友好文本。

    // Determine if this was a user interrupt
    const isInterrupt = error instanceof AbortError

    // Run PostToolUseFailure hooks
// 跑 PostToolUseFailure hook（与 PostToolUse 对应，只是这次是失败场景），
// 并把 hook 产出的消息排在主错误结果之后返回。
    const hookMessages: MessageUpdateLazy<
      AttachmentMessage | ProgressMessage<HookProgress>
    >[] = []
    for await (const hookResult of runPostToolUseFailureHooks(
      toolUseContext,
      tool,
      toolUseID,
      messageId,
      processedInput,
      content,
      isInterrupt,
      requestId,
      mcpServerType,
      mcpServerBaseUrl,
    )) {
      hookMessages.push(hookResult)
    }

    return [
      {
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content,
              is_error: true,
              tool_use_id: toolUseID,
            },
          ],
          toolUseResult: `Error: ${content}`,
          mcpMeta: toolUseContext.agentId
            ? undefined
            : error instanceof
                McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
              ? error.mcpMeta
              : undefined,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      },
      ...hookMessages,
    ]
  } finally {
// finally 保证一定执行：停掉活动心跳，并清掉本次调用留下的权限决策记录（避免无限累积）。
    stopSessionActivity('tool_exec')
    // Clean up decision info after logging
    if (decisionInfo) {
      toolUseContext.toolDecisions?.delete(toolUseID)
    }
  }
}
