/**
 * 【一句话定位】★★★ 整个 Claude Code 的「HTTP 请求核心」：真正调用 Claude 模型 API 的地方。
 *           负责拼装请求参数、发起**流式（streaming）**请求、把 SSE 字节流解析成事件、
 *           累积成 assistant 消息、统计 token 用量与成本、处理各种降级与错误。
 *
 * 【在架构中的位置】（这一层是「真正发 HTTP 请求给 Claude 模型」的地方）
 *   调用链：src/query.ts（对话主循环）
 *           → 本文件 queryModelWithStreaming() / queryModelWithoutStreaming()
 *             → 本文件 queryModel()（★ 核心，约 1900 行的 async generator）
 *               → 本文件 paramsFromContext()（拼装完整请求参数）
 *                 → addCacheBreakpoints()（在消息上打缓存断点）
 *                 → buildSystemPromptBlocks()（拼 system prompt 块）
 *                 → getAnthropicClient()（见 ./client.ts，造 SDK client）
 *               → ./withRetry.ts 的 withRetry()（重试循环）
 *                 → anthropic.beta.messages.create({stream: true}).withResponse()
 *                   ★ 这一步就是真正的 HTTP 请求，返回 SSE 流
 *               → `for await (const part of stream)`（★ 逐事件消费流）
 *                 → 按事件类型累积内容块 → 拼成 AssistantMessage → yield 给上层
 *               → ./logging.ts 的 logAPIQuery / logAPISuccessAndDuration / logAPIError
 *               → ./promptCacheBreakDetection.ts 的 recordPromptState / checkResponseForCacheBreak
 *               → ./errors.ts 的 getAssistantMessageFromError（出错时生成用户可见消息）
 *   失败降级链：流式失败 → executeNonStreamingRequest()（改发非流式请求重试）
 *              → 连续 529 → withRetry 抛 FallbackTriggeredError → 上层换模型
 *   其它入口：queryHaiku()（用小模型做摘要/分类）、queryWithModel()（指定模型单次问答）、
 *             verifyApiKey()（校验 API key 是否有效）。
 *
 * 【★★ 流式请求是怎么建立的（本文件最需要理解的部分）】
 *   Java 工程师请注意：这一步在 Java 里通常要用 WebClient + Reactor（Flux）才能做到，
 *   而这里靠 `async function*` + `for await` 就实现了，代码看起来是**同步**的。
 *
 *   完整链路分五层：
 *
 *   ①【发起请求】anthropic.beta.messages.create({...params, stream: true})
 *     加 `stream: true` 后，服务端不再返回一整个 JSON，而是返回
 *     `Content-Type: text/event-stream`（即 SSE，Server-Sent Events）的**长连接响应**。
 *     `.withResponse()` 是 SDK 提供的方法：除了拿到数据，还额外拿到原始 Response 对象
 *     （里面有响应头，用于读 request_id、配额状态等）。
 *
 *   ②【网络字节层】HTTP 响应的 body 是一个 ReadableStream（字节流）。
 *     SSE 的报文格式长这样（事件之间用**空行**分隔）：
 *         event: message_start\ndata: {"type":"message_start",...}\n\n
 *         event: content_block_delta\ndata: {"type":"content_block_delta",...}\n\n
 *     注意：一次网络 read 拿到的字节**不一定**正好是一个完整事件
 *     （可能半个事件、也可能好几个事件粘在一起），所以需要缓冲+切分。
 *     （本目录的 dumpPrompts.ts 里有手工版实现，可以对照着看。）
 *
 *   ③【SDK 解析层】SDK 内部把字节 → 文本 → 按 SSE 格式切分 → JSON.parse，
 *     产出一个 Stream<BetaRawMessageStreamEvent>（原始事件流）。
 *     ⚠️ 这里刻意用的是 **raw stream** 而不是 SDK 的 BetaMessageStream：
 *     因为后者会在每个 input_json_delta 上做一次 partialParse（O(n²) 的 Partial JSON 解析），
 *     而工具入参的累积我们自己处理就够了，没必要付这个代价。
 *
 *   ④【消费层】★ `for await (const part of stream)
 *     Stream 实现了「异步可迭代协议」（Symbol.asyncIterator），所以可以直接 for await。
 *     每循环一次 = 收到一个事件。这一步看起来跟遍历 List 一样，
 *     但实际上是**边收边处理**的：收到一个字节块就解析出一个事件、立刻 yield 给上层，
 *     用户就能看到模型「一个字一个字往外吐」。
 *     Java 类比：Flux<Event>.doOnNext(...).subscribe(...)，或者 WebClient 的 
 *     `bodyToFlux(String.class)`。这里省掉了一整套 Reactor 的算子链。
 *
 *   ⑤【业务层】本文件的 switch (part.type) 把事件累积成内容块：
 *     message_start        → 初始化消息骨架 + 记录 usage、TTFT
 *     content_block_start  → 新建一个内容块（text / thinking / tool_use ...）
 *     content_block_delta  → 往内容块里**追加**一小段（这是最频繁的事件）
 *     content_block_stop   → 这个块写完了 → 拼成 AssistantMessage 并 yield
 *     message_delta        → 更新最终 usage 和 stop_reason、累加成本
 *     message_stop         → 流结束
 *     之后再把原始事件作为 {type:'stream_event', event} 也 yield 出去，
 *     让 UI 层能做打字机效果。
 *
 * 【★ 生成器（generator）在本文件的用法】
 *   本文件几乎每个函数都是 `async function*`（异步生成器）：
 *   - `yield m`：产出一条消息给上层，但不结束（上层 for await 收到一条）；
 *   - `yield* otherGen()`：**委托**给另一个生成器（把它的产出原样透传），
 *     约等于 Java 的 flux.flatMap(x -> otherFlux)；
 *   - `return value`：结束生成器，返回值（AsyncGenerator<Y, R> 里的 R）。
 *   配合 withRetry 的 yield（重试提示），一个 for await 循环就同时收到了
 *   「重试进度」和「业务消息」两类事件。
 *
 * 【★ 为什么要有「流式 → 非流式」降级】
 *   流式更慢的路径更多（代理、网关、长连接），失败率更高。
 *   所以流式一旦出错，就**改发一次非流式请求**重试（executeNonStreamingRequest），
 *   保证用户最终能拿到结果。代价：非流式要等完整响应，没有打字机效果。
 *
 * 【★ 关于 prompt 缓存（本文件里大量代码都是为了「别把缓存弄失效」）】
 *   服务端按「请求前缀」缓存。只要前缀里任何一个字节变了，缓存就失效，
 *   就要重新付一次「写入缓存」的钱。所以你会看到本文件里：
 *   - addCacheBreakpoints：只在**一个**位置放缓存断点标记；
 *   - 各种 beta 头一旦发过就「粘滞（latch）」住，整个会话保持不变；
 *   - system prompt / 工具定义的顺序、内容都尽量稳定。
 *   详见 ./promptCacheBreakDetection.ts（专门监测缓存有没有被弄失效）。
 *
 * 【本文件包含什么】（按出现顺序）
 *   - getExtraBodyParams()：读取 CLAUDE_CODE_EXTRA_BODY 等额外请求参数。
 *   - getPromptCachingEnabled() / getCacheControl() / should1hCacheTTL()：缓存开关与 TTL 决策。
 *   - configureEffortParams() / configureTaskBudgetParams()：推理强度 / token 预算参数。
 *   - getAPIMetadata()：请求元数据（user_id / device_id / session_id）。
 *   - verifyApiKey()：用一次最小请求校验 API key 是否有效。
 *   - userMessageToMessageParam() / assistantMessageToMessageParam()：内部消息 → API 消息格式。
 *   - Options：★ 本文件最重要的配置类型（几十个字段）。
 *   - queryModelWithoutStreaming() / queryModelWithStreaming()：两个对外入口。
 *   - executeNonStreamingRequest()：★ 非流式降级请求。
 *   - stripExcessMediaItems()：媒体（图片/PDF）数量超限时的裁剪。
 *   - queryModel()：★★★ 核心实现。
 *   - cleanupStream() / releaseStreamResources()：流资源释放（防内存泄漏）。
 *   - updateUsage() / accumulateUsage()：★ token 用量累积。
 *   - addCacheBreakpoints() / buildSystemPromptBlocks()：缓存断点与 system prompt 块。
 *   - queryHaiku() / queryWithModel()：两个便捷的单次问答入口。
 *   - adjustParamsForNonStreaming() / getMaxOutputTokensForModel()：参数调整。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. ★★ `async function*` + `yield` + `for await`：异步生成器三件套。
 *      见上面「流式请求」部分的说明。Java 对应：Flux / Publisher + subscribe。
 *      这是本文件（也是整个项目）最重要的一个语法点。
 *   2. ★ `yield* gen()`：生成器委托（把另一个生成器的产出透传出来）。
 *      Java 类比：flux.flatMap(...)。本文件用它把 withRetry / executeNonStreamingRequest
 *      的事件流拼进自己的事件流里，非常干净。
 *   3. `AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>`：
 *      每 yield 一个「联合类型」的值（三种消息之一），最终 return void。
 *      上层用 switch (msg.type) 区分——联合类型 + 字面量标签 = 可辨识联合。
 *   4. `import type { X } from '...'`：只导入类型（编译后被删掉）。
 *      本文件开头几十行 import 大部分都是 type-only，运行时零开销。
 *   5. `type JsonValue = string | number | boolean | null | JsonObject | JsonArray`：
 *      ★ **递归类型**（JsonObject 引用 JsonValue）。用来描述「任意 JSON」。
 *      Java 里通常用 Object 或 Jackson 的 JsonNode 表示，做不到这么精确。
 *   6. `type JsonObject = { [key: string]: JsonValue }`：
 *      索引签名——「键是 string、值是 JsonValue 的对象」。≈ Map<String, JsonValue>。
 *   7. `feature('XXX')`：★ **编译期开关**（Bun 打包器提供），≈ C 的 #ifdef。
 *      打包时若为 false，整段代码被删除。本文件有十几处，
 *      用于把内部功能（CONNECTOR_TEXT、CACHED_MICROCOMPACT、TRANSCRIPT_CLASSIFIER ...）
 *      从外部构建里裁掉。注意：它**不是**运行时 if，不能在里面写动态逻辑。
 *   8. `const mod = feature('X') ? (require('...') as typeof import('...')) : null`：
 *      ★ 条件 require + `typeof import('...')`。作用：只在特性开启时才加载模块，
 *      并且**复用**它的类型。Java 类比：Class.forName + 反射，但类型安全。
 *   9. `satisfies T`（如 `thinking = {...} satisfies BetaMessageStreamParams['thinking']`）：
 *      ★ `satisfies` 是 TS 4.9 的运算符：既要**检查**是否符合 T，又**不改变**表达式的推断类型。
 *      比 `as T` 安全（as 会强行改变类型，可能掩盖错误）。Java 没有对应语法。
 *  10. `Omit<Options, 'model' | 'getToolPermissionContext'>`：
 *      ★ 内置工具类型 Omit：从 Options 里**去掉**这几个字段，得到新类型。
 *      Java 没有类型运算，只能另写一个接口。
 *  11. `Options['fetchOverride']`：索引访问类型（取某个字段的类型）。
 *      `BetaMessageStreamParams['thinking']` 同理。
 *  12. `{ ...params, stream: true }` 与 `...(cond ? { k: v } : {})`：
 *      对象展开与条件展开（本文件无处不在）。
 *  13. `messages.map((msg, index) => ...)` / `.filter(...)` / `.some(...)` / `.at(-1)`：
 *      ≈ Java Stream 的 map/filter/anyMatch；`.at(-1)` 取最后一个元素。
 *  14. `new Set<string>()` + `.has()` / `.add()`：集合，≈ HashSet。
 *  15. `ReturnType<typeof setTimeout>`：取函数返回值类型（这里是定时器的句柄类型）。
 *  16. `contentBlocks[part.index] = {...}`：用下标直接赋值到数组（JS 数组是稀疏的，
 *      下标可以乱序赋）。这里用事件里的 index 来定位内容块。
 *  17. `block is { type: 'tool_result'; tool_use_id: string }`：
 *      ★ 类型谓词（自定义 instanceof），if 之后类型自动收窄。
 *  18. `'cache_control' in block` / `'research' in part`：in 运算符做属性存在性检查（类型守卫）。
 *  19. `void promise.then(...)`：fire-and-forget（不等待结果）。
 *      本文件用它上报日志，避免阻塞请求。
 *  20. `try { ... } catch { ... } finally { ... }`：跟 Java 一样，
 *      但注意：**生成器的 finally 在消费者提前 break 时也会执行**（见第 2808 行的注释）。
 *  21. `performance.now()`：高精度时间戳（Java：System.nanoTime()）。
 *  22. `'text' as const` / `type: 'ephemeral'`：字面量类型（不加 as const 会推断成 string）。
 *  23. `let stream: Stream<...> | undefined = undefined`：显式标注联合类型并初始化。
 *  24. `64_000` / `90_000` / `30_000`：数字下划线分隔符（可读性，Java 7+ 也支持）。
 */
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaUsage,
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { randomUUID } from 'crypto'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  type ConnectorTextBlock,
  type ConnectorTextDelta,
  isConnectorTextBlock,
} from '../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type CacheScope,
  logAPIPrefix,
  splitSysPromptPrefix,
  toolToAPISchema,
} from '../../utils/api.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import {
  getBedrockExtraBodyParamsBetas,
  getMergedBetas,
  getModelBetas,
} from '../../utils/betas.js'
import { getOrCreateUserID } from '../../utils/config.js'
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
} from '../../utils/context.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { captureAPIRequest, logError } from '../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../utils/messages.js'
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
  isNonCustomOpusModel,
} from '../../utils/model/model.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { getDynamicConfig_BLOCKS_ON_INIT } from '../analytics/growthbook.js'
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../claudeAiLimits.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'

/* eslint-disable @typescript-eslint/no-require-imports */
// ★ 条件 require：只在 TRANSCRIPT_CLASSIFIER 特性开启时才加载这个模块。
// `as typeof import('...')` 是「动态导入的类型」写法——不写 as 的话类型是 any。
// 这样既能按需加载（减小包体积），又保留完整类型检查。
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null

import { feature } from 'bun:bundle'
import type { ClientOptions } from '@anthropic-ai/sdk'
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk/error'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getFastModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getSessionId,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setFastModeHeaderLatched,
  setLastMainRequestId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
  setThinkingClearLatched,
} from 'src/bootstrap/state.js'
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { AgentId } from 'src/types/ids.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { isClaudeAISubscriber } from 'src/utils/auth.js'
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/utils/claudeInChrome/common.js'
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from 'src/utils/claudeInChrome/prompt.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type EffortValue, modelSupportsEffort } from 'src/utils/effort.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from 'src/utils/fastMode.js'
import { returnValue } from 'src/utils/generators.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isMcpInstructionsDeltaEnabled } from 'src/utils/mcpInstructionsDelta.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabled,
} from 'src/utils/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import { count } from '../../utils/array.js'
import { insertBlockAfterToolResults } from '../../utils/contentArray.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { safeParseJSON } from '../../utils/json.js'
import { getInferenceProfileBackingModel } from '../../utils/model/bedrock.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../utils/telemetry/sessionTracing.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
  markToolsSentToAPIState,
  pinCacheEdits,
} from '../compact/microCompact.js'
import { getInitializationStatus } from '../lsp/manager.js'
import { isToolFromMcpServer } from '../mcp/utils.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from './client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

// Define a type that represents valid JSON values
// 用递归类型描述「任意 JSON 值」。注意 JsonObject/JsonArray 反过来引用 JsonValue，
// TS 允许这种自引用（Java 里通常只能用 Object / JsonNode 表示）。
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

/**
 * Assemble the extra body parameters for the API request, based on the
 * CLAUDE_CODE_EXTRA_BODY environment variable if present and on any beta
 * headers (primarily for Bedrock requests).
 *
 * @param betaHeaders - An array of beta headers to include in the request.
 * @returns A JSON object representing the extra body parameters.
 */
// 组装「额外请求参数」。来源有两个：
//   ①环境变量 CLAUDE_CODE_EXTRA_BODY（用户/运维想塞给 API 的任意参数）；
//   ②某些 beta 头（主要给 Bedrock 用，它要求把 beta 放进 body 而不是 header）。
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // Parse user's extra body parameters first
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      // Parse as JSON, which can be null, boolean, number, string, array or object
      const parsed = safeParseJSON(extraBodyStr)
      // We expect an object with key-value pairs to spread into API parameters
// ★ 为什么要 `{ ...(parsed as JsonObject) }` 浅拷贝一层？
// 注释解释得很清楚：safeParseJSON 带 LRU 缓存，同一个字符串会返回**同一个对象引用**。
// 如果直接改它，就把缓存里那份也给改了（缓存污染），下次拿到的是脏数据。
// 这是「缓存 + 可变对象」的经典陷阱。
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Shallow clone — safeParseJSON is LRU-cached and returns the same
        // object reference for the same string. Mutating `result` below
        // would poison the cache, causing stale values to persist.
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing CLAUDE_CODE_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  // Anti-distillation: send fake_tools opt-in for 1P CLI only
// feature('ANTI_DISTILLATION_CC')：编译期开关，外部构建里整段被删掉。
  if (
    feature('ANTI_DISTILLATION_CC')
      ? process.env.CLAUDE_CODE_ENTRYPOINT === 'cli' &&
        shouldIncludeFirstPartyOnlyBetas() &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_anti_distill_fake_tool_injection',
          false,
        )
      : false
  ) {
    result.anti_distillation = ['fake_tools']
  }

  // Handle beta headers if provided
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      // Add to existing array, avoiding duplicates
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      // Create new array with the beta headers
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

// 是否启用 prompt 缓存。提供三个环境变量分别针对小模型 / Sonnet / Opus 单独关闭，
// 便于线上出问题时**按模型粒度**快速止血。
export function getPromptCachingEnabled(model: string): boolean {
  // Global disable takes precedence
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // Check if we should disable for small/fast model
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const smallFastModel = getSmallFastModel()
    if (model === smallFastModel) return false
  }

  // Check if we should disable for default Sonnet
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const defaultSonnet = getDefaultSonnetModel()
    if (model === defaultSonnet) return false
  }

  // Check if we should disable for default Opus
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const defaultOpus = getDefaultOpusModel()
    if (model === defaultOpus) return false
  }

  return true
}

// 生成 cache_control 标记（告诉服务端「这里是一个缓存断点」）。
// 条件展开：1h TTL 才带 ttl 字段，global 作用域才带 scope 字段。
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * Determines if 1h TTL should be used for prompt caching.
 *
 * Only applied when:
 * 1. User is eligible (ant or subscriber within rate limits)
 * 2. The query source matches a pattern in the GrowthBook allowlist
 *
 * GrowthBook config shape: { allowlist: string[] }
 * Patterns support trailing '*' for prefix matching.
 * Examples:
 * - { allowlist: ["repl_main_thread*", "sdk"] } — main thread + SDK only
 * - { allowlist: ["repl_main_thread*", "sdk", "agent:*"] } — also subagents
 * - { allowlist: ["*"] } — all sources
 *
 * The allowlist is cached in STATE for session stability — prevents mixed
 * TTLs when GrowthBook's disk cache updates mid-request.
 */
// ★ 是否用 1 小时 TTL（默认 5 分钟）。这个函数有两个「稳定性」设计，很值得学：
//   ①把「用户是否够格」算一次之后**存进全局状态**（latch）；
//   ②把灰度配置（allowlist）也缓存下来。
// 原因（注释里说了）：如果中途因为超额用量之类的状态翻转导致 TTL 从 1h 变回 5m，
// 服务端的缓存键就变了 → 整份前缀缓存失效 → 白花约 2 万 token 的钱。
// 教训：**影响缓存键的开关必须在一个会话内保持稳定**。
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 3P Bedrock users get 1h TTL when opted in via env var — they manage their own billing
  // No GrowthBook gating needed since 3P users don't have GrowthBook configured
  if (
    getAPIProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  // Latch eligibility in bootstrap state for session stability — prevents
  // mid-session overage flips from changing the cache_control TTL, which
  // would bust the server-side prompt cache (~20K tokens per flip).
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible =
      process.env.USER_TYPE === 'ant' ||
      (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false

  // Cache allowlist in bootstrap state for session stability — prevents mixed
  // TTLs when GrowthBook's disk cache updates mid-request
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowlist?: string[]
    }>('tengu_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
  }

// 白名单匹配支持结尾的 `*`（前缀匹配），比如 'repl_main_thread*' 能匹配所有变体。
  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}

/**
 * Configure effort parameters for API request.
 *
 */
// 配置「推理强度（effort）」参数。三种情况：
//   ①没指定 → 只加 beta 头；
//   ②字符串 → 直接放进 output_config.effort；
//   ③数字 → 内部用户专用，塞进 anthropic_internal（不发 SDK 标准字段）。
// 注意这个函数是**修改入参**（void 返回），属于命令式风格。
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === undefined) {
    betas.push(EFFORT_BETA_HEADER)
  } else if (typeof effortValue === 'string') {
    // Send string effort level as is
    outputConfig.effort = effortValue
    betas.push(EFFORT_BETA_HEADER)
  } else if (process.env.USER_TYPE === 'ant') {
    // Numeric effort override - ant-only (uses anthropic_internal)
    const existingInternal =
      (extraBodyParams.anthropic_internal as Record<string, unknown>) || {}
    extraBodyParams.anthropic_internal = {
      ...existingInternal,
      effort_override: effortValue,
    }
  }
}

// output_config.task_budget — API-side token budget awareness for the model.
// Stainless SDK types don't yet include task_budget on BetaOutputConfig, so we
// define the wire shape locally and cast. The API validates on receipt; see
// api/api/schemas/messages/request/output_config.py:12-39 in the monorepo.
// Beta: task-budgets-2026-03-13 (EAP, claude-strudel-eap only as of Mar 2026).
// SDK 的类型里还没有 task_budget 这个新字段，所以本地定义一个「线上形状」再断言过去。
// 注释里还标了服务端校验 schema 的位置，方便对齐。
type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}

export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

// 请求的 metadata：把 user_id / device_id / account_uuid / session_id 打包成一个 JSON 字符串。
// 后端靠它做计费归因与排障。可选的环境变量 CLAUDE_CODE_EXTRA_METADATA 可以附加自定义字段。
export function getAPIMetadata() {
  // https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q/edit?tab=t.0#heading=h.5g7nec5b09w5
  let extra: JsonObject = {}
  const extraStr = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `CLAUDE_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      // Only include OAuth account UUID when actively using OAuth authentication
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

// 校验 API key 是否有效：发一个「最小」请求（max_tokens: 1，内容 'test'）。
// 非交互模式（claude -p）直接跳过——避免为了校验而多花一次请求的钱和时间。
export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  // Skip API verification if running in print mode (isNonInteractiveSession)
  if (isNonInteractiveSession) {
    return true
  }

  try {
    // WARNING: if you change this to use a non-Haiku model, this request will fail in 1P unless it uses getCLISyspromptPrefix.
// ★ 注释里的 WARNING 很重要：如果换成非 Haiku 模型，第一方环境会因为没有 CLI 专用
// system prompt 前缀而失败。这是「平台侧有校验规则」的典型例子。
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
// returnValue(generator)：一个小工具，把「异步生成器」当 Promise 用——
// 驱动它跑完，只取最终 return 的值（忽略中间的 yield）。
    return await returnValue(
      withRetry(
        () =>
          getAnthropicClient({
            apiKey,
            maxRetries: 3,
            model,
            source: 'verify_api_key',
          }),
        async anthropic => {
          const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
          // biome-ignore lint/plugin: API key verification is intentionally a minimal direct call
          await anthropic.beta.messages.create({
            model,
            max_tokens: 1,
            messages,
            temperature: 1,
            ...(betas.length > 0 && { betas }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          })
          return true
        },
        { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } }, // Use fewer retries for API key verification
      ),
    )
  } catch (errorFromRetry) {
    let error = errorFromRetry
// CannotRetryError 是个包装异常，真正的错误在 .originalError 里。
// 这里要「拆包」才能判断是不是 key 无效。
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    // Check for authentication error
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

// 内部 UserMessage → API 的 MessageParam 格式。
// addCache=true 时，在**最后一个内容块**上加 cache_control 标记（= 打一个缓存断点）。
export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
// ★ 为什么要 `[...message.message.content]` 复制一份数组？
// 注释解释：下游（addCacheBreakpoints）会往数组里 splice 插入块，
// 如果共享同一个数组，多次调用会插入**重复**的缓存编辑块，还会污染原始消息。
// 这是「防御式拷贝」，Java 里也有同样的考量（返回 new ArrayList<>(list)）。
  // Clone array content to prevent in-place mutations (e.g., insertCacheEditsBlock's
  // splice) from contaminating the original message. Without cloning, multiple calls
  // to addCacheBreakpoints share the same array and each splices in duplicate cache_edits.
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

// 内部 AssistantMessage → API 的 MessageParam 格式。
// 注意缓存断点**不能**打在 thinking / redacted_thinking 块上（服务端不支持）。
export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking' &&
          (feature('CONNECTOR_TEXT') ? !isConnectorTextBlock(_) : true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

// ★ Options：本文件最核心的配置类型，几十个字段涵盖：
//   模型与回退模型、工具与权限上下文、prompt 缓存开关、thinking 配置、
//   温度、输出格式、fast mode、effort、任务预算、query 来源与追踪、agent 上下文等。
// 它一路从 query.ts 传下来，是「一次查询的完整配置」。
export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: BetaToolUnion[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId // Only set for subagents
  outputFormat?: BetaJSONOutputFormat
  fastMode?: boolean
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  // API-side task budget (output_config.task_budget). Distinct from the
  // tokenBudget.ts +500k auto-continue feature — this one is sent to the API
  // so the model can pace itself. `remaining` is computed by the caller
  // (query.ts decrements across the agentic loop).
  taskBudget?: { total: number; remaining?: number }
}

// 【对外入口一：非流式】内部其实还是走流式生成器，但**不把中间事件 yield 出去**，
// 只取最终的 assistant 消息。
// 为什么要「继续消费完生成器」？注释说了：用量统计（logAPISuccessAndDuration）
// 是在所有 yield 之后才执行的，中途 break 会导致统计丢失。
export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // Store the assistant message but continue consuming the generator to ensure
  // logAPISuccessAndDuration gets called (which happens after all yields)
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // If the signal was aborted, throw APIUserAbortError instead of a generic error
    // This allows callers to handle abort scenarios gracefully
// 用户中止（Ctrl-C）时抛专门的 APIUserAbortError，让上层能优雅处理，
// 而不是当成普通错误弹一个报错给用户。
    if (signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

// 【对外入口二：流式】把 queryModel 的事件流原样透传出去（yield* 委托）。
// withStreamingVCR 是一个「录制/回放」包装（测试用），生产环境基本是透传。
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
// ★ `return yield* g()`：yield* 把内部生成器的所有产出透传，
// 同时它的值就是内部生成器的 return 值，再 return 出去。一行搞定「转发 + 返回值」。
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

/**
 * Determines if an LSP tool should be deferred (tool appears with defer_loading: true)
 * because LSP initialization is not yet complete.
 */
function shouldDeferLspTool(tool: Tool): boolean {
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  // Defer when pending or not started
  return status.status === 'pending' || status.status === 'not-started'
}

/**
 * Per-attempt timeout for non-streaming fallback requests, in milliseconds.
 * Reads API_TIMEOUT_MS when set so slow backends and the streaming path
 * share the same ceiling.
 *
 * Remote sessions default to 120s to stay under CCR's container idle-kill
 * (~5min) so a hung fallback to a wedged backend surfaces a clean
 * APIConnectionTimeoutError instead of stalling past SIGKILL.
 *
 * Otherwise defaults to 300s — long enough for slow backends without
 * approaching the API's 10-minute non-streaming boundary.
 */
// 非流式降级的单次超时：远程会话用 120 秒（要比容器的空闲杀掉时间 ~5min 短，
// 这样能拿到一个干净的超时错误而不是被 SIGKILL），否则 300 秒。
function getNonstreamingFallbackTimeoutMs(): number {
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) return override
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? 120_000 : 300_000
}

/**
 * Helper generator for non-streaming API requests.
 * Encapsulates the common pattern of creating a withRetry generator,
 * iterating to yield system messages, and returning the final BetaMessage.
 */
// ★【非流式降级请求】流式失败时改发一次非流式请求。
// 结构跟流式那套一样：用 withRetry 包住，每次尝试都调 paramsFromContext 重新拼参数。
// 注意它返回 AsyncGenerator<SystemAPIErrorMessage, BetaMessage>：
//   中途 yield「正在重试」的系统消息，最终 return 完整的 BetaMessage。
export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    fastMode?: boolean
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: BetaMessageStreamParams) => void,
  /**
   * Request ID of the failed streaming attempt this fallback is recovering
   * from. Emitted in tengu_nonstreaming_fallback_error for funnel correlation.
   */
  originatingRequestId?: string | null,
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  const generator = withRetry(
    () =>
      getAnthropicClient({
// maxRetries: 0 —— 关掉 SDK 自带的重试，全部交给 withRetry 统一管理（避免两层重试叠加）。
        maxRetries: 0,
        model: clientOptions.model,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (anthropic, attempt, context) => {
      const start = Date.now()
      const retryParams = paramsFromContext(context)
      captureRequest(retryParams)
      onAttempt(attempt, start, retryParams.max_tokens)

// 非流式要额外限制 max_tokens（见 MAX_NON_STREAMING_TOKENS 的说明）。
      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )

      try {
        // biome-ignore lint/plugin: non-streaming API call
        return await anthropic.beta.messages.create(
          {
            ...adjustedParams,
            model: normalizeModelStringForAPI(adjustedParams.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs,
          },
        )
// 用户中止不算错误，直接抛出去，不记录、不重试。
      } catch (err) {
        // User aborts are not errors — re-throw immediately without logging
        if (err instanceof APIUserAbortError) throw err

        // Instrumentation: record when the non-streaming request errors (including
        // timeouts). Lets us distinguish "fallback hung past container kill"
        // (no event) from "fallback hit the bounded timeout" (this event).
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        logEvent('tengu_nonstreaming_fallback_error', {
          model:
            clientOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            err instanceof Error
              ? (err.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attempt,
          timeout_ms: fallbackTimeoutMs,
          request_id: (originatingRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw err
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      ...(isFastModeEnabled() && { fastMode: retryOptions.fastMode }),
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

// ★ 手工驱动生成器：do { e = await generator.next() } while (!e.done)
// 每次拿到一个值：如果是系统消息就 yield 出去（让 UI 显示「正在重试」）；
// done 为 true 时 e.value 就是生成器的 return 值（即 BetaMessage）。
// 这就是「AsyncGenerator<Y, R>」里 R 的用法。
  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as BetaMessage
}

/**
 * Extracts the request ID from the most recent assistant message in the
 * conversation. Used to link consecutive API requests in analytics so we can
 * join them for cache-hit-rate analysis and incremental token tracking.
 *
 * Deriving this from the message array (rather than global state) ensures each
 * query chain (main thread, subagent, teammate) tracks its own request chain
 * independently, and rollback/undo naturally updates the value.
 */
// 从消息历史里倒着找最近一条 assistant 消息的 requestId。
// 为什么从消息数组里推导而不是用全局变量？注释解释：这样每条 query 链
// （主线程 / 子 agent / 队友）各自独立，互不干扰，而且撤销操作会自动生效。
function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

// 两个类型谓词函数（自定义 instanceof）：判断块是不是媒体 / 是不是 tool_result。
function isMedia(
  block: BetaContentBlockParam,
): block is BetaImageBlockParam | BetaRequestDocumentBlock {
  return block.type === 'image' || block.type === 'document'
}

function isToolResult(
  block: BetaContentBlockParam,
): block is BetaToolResultBlockParam {
  return block.type === 'tool_result'
}

/**
 * Ensures messages contain at most `limit` media items (images + documents).
 * Strips oldest media first to preserve the most recent.
 */
// 媒体（图片 + 文档）数量超过上限时，从**最老的**开始删，保留最近的。
// 为什么不直接报错？注释说明：服务端会返回一个很难懂的错误，
// 与其让用户无从下手，不如静默裁剪掉最老的，保证请求能发出去。
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  return messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    const stripped = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length
          ? block
          : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

// ★★★【核心函数】queryModel —— 整个文件（乃至整个 API 层）的心脏。
// 它是一个 async generator：
//   yield：StreamEvent（原始流事件，供 UI 做打字机）/ AssistantMessage（完整消息）/
//          SystemAPIErrorMessage（重试提示或错误消息）；
//   return：void。
//
// 大致流程：
//   ①前置检查（人工限流开关等）；
//   ②解析模型、算 beta 头、决定工具搜索 / 缓存策略；
//   ③规范化消息、裁剪媒体、打缓存断点、拼 system prompt；
//   ④记录 prompt 状态（供缓存失效检测）；
//   ⑤用 withRetry 发起**流式**请求；
//   ⑥for await 消费事件流，累积内容块，yield 消息；
//   ⑦失败 → 降级成非流式重试；再失败 → 生成错误消息；
//   ⑧finally 释放流资源、上报用量与成本。
//
// 读这段代码时请对照文件头「流式请求是怎么建立的」那一段。
async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // Check cheap conditions first — the off-switch await blocks on GrowthBook
  // init (~10ms). For non-Opus models (haiku, sonnet) this skips the await
  // entirely. Subscribers don't hit this path at all.
// 人工限流开关（Opus 过载时紧急降流量）。
// 注释说明为什么要「先判断便宜条件」：后面那个 await 会阻塞在灰度配置初始化上（~10ms），
// 先用 model / 订阅类型判断可以跳过绝大多数请求。这是很实在的性能优化。
  if (
    !isClaudeAISubscriber() &&
    isNonCustomOpusModel(options.model) &&
    (
      await getDynamicConfig_BLOCKS_ON_INIT<{ activated: boolean }>(
        'tengu-off-switch',
        {
          activated: false,
        },
      )
    ).activated
  ) {
    logEvent('tengu_off_switch_query', {})
    yield getAssistantMessageFromError(
      new Error(CUSTOM_OFF_SWITCH_MESSAGE),
      options.model,
    )
    return
  }

  // Derive previous request ID from the last assistant message in this query chain.
  // This is scoped per message array (main thread, subagent, teammate each have their own),
  // so concurrent agents don't clobber each other's request chain tracking.
  // Also naturally handles rollback/undo since removed messages won't be in the array.
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

// Bedrock 的 inference profile 需要解析出背后的真实模型名（用于计费等）。
  const resolvedModel =
    getAPIProvider() === 'bedrock' &&
    options.model.includes('application-inference-profile')
      ? ((await getInferenceProfileBackingModel(options.model)) ??
        options.model)
      : options.model

// 判断这是不是「agentic」查询（会用工具的那种）。
// 影响 beta 头的选择——比如压缩、side_question 这类非 agentic 调用不需要某些头。
  queryCheckpoint('query_tool_schema_build_start')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // Always send the advisor beta header when advisor is enabled, so
  // non-agentic queries (compact, side_question, extract_memories, etc.)
  // can parse advisor server_tool_use blocks already in the conversation history.
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel

    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        // Override the advisor model if the base model matches. We
        // should only have experiment models if the user cannot
        // configure it themselves.
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }

// 工具搜索（tool search）：把大量工具延迟加载，只在需要时才把 schema 发给模型。
// 这是控制 prompt 体积和成本的重要手段。
  // Check if tool search is enabled (checks mode, model support, and threshold for auto mode)
  // This is async because it may need to calculate MCP tool description sizes for TstAuto mode
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

// ★ 性能细节：isDeferredTool 每次调用要做 2 次灰度配置查询，
// 所以这里**预先**把结果算好存进 Set，避免在循环里反复查。
  // Precompute once — isDeferredTool does 2 GrowthBook lookups per call
  const deferredToolNames = new Set<string>()
  if (useToolSearch) {
    for (const t of tools) {
      if (isDeferredTool(t)) deferredToolNames.add(t.name)
    }
  }

  // Even if tool search mode is enabled, skip if there are no deferred tools
  // AND no MCP servers are still connecting. When servers are pending, keep
  // ToolSearch available so the model can discover tools after they connect.
  if (
    useToolSearch &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      'Tool search disabled: no deferred tools available to search',
    )
    useToolSearch = false
  }

  // Filter out ToolSearchTool if tool search is not enabled for this model
  // ToolSearchTool returns tool_reference blocks which unsupported models can't handle
  let filteredTools: Tools

  if (useToolSearch) {
    // Dynamic tool loading: Only include deferred tools that have been discovered
    // via tool_reference blocks in the message history. This eliminates the need
    // to predeclare all deferred tools upfront and removes limits on tool quantity.
    const discoveredToolNames = extractDiscoveredToolNames(messages)

    filteredTools = tools.filter(tool => {
      // Always include non-deferred tools
      if (!deferredToolNames.has(tool.name)) return true
      // Always include ToolSearchTool (so it can discover more tools)
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
      // Only include deferred tools that have been discovered
      return discoveredToolNames.has(tool.name)
    })
  } else {
    filteredTools = tools.filter(
      t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME),
    )
  }

  // Add tool search beta header if enabled - required for defer_loading to be accepted
  // Header differs by provider: 1P/Foundry use advanced-tool-use, Vertex/Bedrock use tool-search-tool
  // For Bedrock, this header must go in extraBodyParams, not the betas array
  const toolSearchHeader = useToolSearch ? getToolSearchBetaHeader() : null
  if (toolSearchHeader && getAPIProvider() !== 'bedrock') {
    if (!betas.includes(toolSearchHeader)) {
      betas.push(toolSearchHeader)
    }
  }

  // Determine if cached microcompact is enabled for this model.
  // Computed once here (in async context) and captured by paramsFromContext.
  // The beta header is also captured here to avoid a top-level import of the
  // ant-only CACHE_EDITING_BETA_HEADER constant.
// cached microcompact（缓存编辑）：允许主动删除已缓存的内容。
// 用动态 import 而不是顶层 import，是因为这些模块只在特性开启时才需要。
  let cachedMCEnabled = false
  let cacheEditingBetaHeader = ''
  if (feature('CACHED_MICROCOMPACT')) {
    const {
      isCachedMicrocompactEnabled,
      isModelSupportedForCacheEditing,
      getCachedMCConfig,
    } = await import('../compact/cachedMicrocompact.js')
    const betas = await import('src/constants/betas.js')
    cacheEditingBetaHeader = betas.CACHE_EDITING_BETA_HEADER
    const featureEnabled = isCachedMicrocompactEnabled()
    const modelSupported = isModelSupportedForCacheEditing(options.model)
    cachedMCEnabled = featureEnabled && modelSupported
    const config = getCachedMCConfig()
    logForDebugging(
      `Cached MC gate: enabled=${featureEnabled} modelSupported=${modelSupported} model=${options.model} supportedModels=${jsonStringify(config.supportedModels)}`,
    )
  }

// 全局缓存作用域（global scope）：让缓存跨会话共享。
// 但 MCP 工具是**每个用户不一样**的，所以只要有 MCP 工具要渲染，就只能退化成不共享。
  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  const willDefer = (t: Tool) =>
    useToolSearch && (deferredToolNames.has(t.name) || shouldDeferLspTool(t))
  // MCP tools are per-user → dynamic tool section → can't globally cache.
  // Only gate when an MCP tool will actually render (not defer_loading).
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some(t => t.isMcp === true && !willDefer(t))

  // Ensure prompt_caching_scope beta header is present when global cache is enabled.
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // Determine global cache strategy for logging
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? 'none'
      : 'system_prompt'
    : 'none'

  // Build tool schemas, adding defer_loading for MCP tools when tool search is enabled
  // Note: We pass the full `tools` list (not filteredTools) to toolToAPISchema so that
  // ToolSearchTool's prompt can list ALL available MCP tools. The filtering only affects
  // which tools are actually sent to the API, not what the model sees in tool descriptions.
// Promise.all + map：并行构建所有工具的 schema。
// toolToAPISchema 可能是异步的（要读权限上下文等），所以必须 await Promise.all。
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  )

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, t =>
      deferredToolNames.has(t.name),
    )
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    )
  }

  queryCheckpoint('query_tool_schema_build_end')

  // Normalize messages before building system prompt (needed for fingerprinting)
  // Instrumentation: Track message count before normalization
  logEvent('tengu_api_before_normalize', {
    preNormalizedMessageCount: messages.length,
  })

  queryCheckpoint('query_message_normalization_start')
// 规范化消息：把内部消息格式转成 API 要求的格式（比如合并连续的同角色消息等）。
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  queryCheckpoint('query_message_normalization_end')

  // Model-specific post-processing: strip tool-search-specific fields if the
  // selected model doesn't support tool search.
  //
  // Why is this needed in addition to normalizeMessagesForAPI?
  // - normalizeMessagesForAPI uses isToolSearchEnabledNoModelCheck() because it's
  //   called from ~20 places (analytics, feedback, sharing, etc.), many of which
  //   don't have model context. Adding model to its signature would be a large refactor.
  // - This post-processing uses the model-aware isToolSearchEnabled() check
  // - This handles mid-conversation model switching (e.g., Sonnet → Haiku) where
  //   stale tool-search fields from the previous model would cause 400 errors
  //
  // Note: For assistant messages, normalizeMessagesForAPI already normalized the
  // tool inputs, so stripCallerFieldFromAssistantMessage only needs to remove the
  // 'caller' field (not re-normalize inputs).
// ★ 这里有一段很长的注释解释「为什么还要再做一次后处理」：
// normalizeMessagesForAPI 被大约 20 个地方调用，很多地方没有模型上下文，
// 所以它是「模型无关」的；而这里知道具体模型，可以做模型相关的修补
// （比如中途从 Sonnet 换成 Haiku 后，残留的工具搜索字段会导致 400）。
  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map(msg => {
      switch (msg.type) {
        case 'user':
          // Strip tool_reference blocks from tool_result content
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          // Strip 'caller' field from tool_use blocks
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  }

  // Repair tool_use/tool_result pairing mismatches that can occur when resuming
  // remote/teleport sessions. Inserts synthetic error tool_results for orphaned
  // tool_uses and strips orphaned tool_results referencing non-existent tool_uses.
// 修复 tool_use / tool_result 配对错乱（恢复远程会话时可能发生）。
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // Strip advisor blocks — the API rejects them without the beta header.
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // Strip excess media items before making the API call.
  // The API rejects requests with >100 media items but returns a confusing error.
  // Rather than erroring (which is hard to recover from in Cowork/CCD), we
  // silently drop the oldest media items to stay within the limit.
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // Instrumentation: Track message count after normalization
  logEvent('tengu_api_after_normalize', {
    postNormalizedMessageCount: messagesForAPI.length,
  })

  // Compute fingerprint from first user message for attribution.
  // Must run BEFORE injecting synthetic messages (e.g. deferred tool names)
  // so the fingerprint reflects the actual user input.
// 计算「指纹」用于归因。注释特意说明：必须在注入任何合成消息**之前**算，
// 否则指纹就不能反映真实的用户输入了。
  const fingerprint = computeFingerprintFromMessages(messagesForAPI)

  // When the delta attachment is enabled, deferred tools are announced
  // via persisted deferred_tools_delta attachments instead of this
  // ephemeral prepend (which busts cache whenever the pool changes).
// ★ 注释点出了缓存考量：把「延迟加载工具列表」塞进 system prompt 会导致
// 工具池一变就缓存失效。所以新版本改成用持久化的 attachment 来传递（不进 system prompt）。
  if (useToolSearch && !isDeferredToolsDeltaEnabled()) {
    const deferredToolList = tools
      .filter(t => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
          isMeta: true,
        }),
        ...messagesForAPI,
      ]
    }
  }

  // Chrome tool-search instructions: when the delta attachment is enabled,
  // these are carried as a client-side block in mcp_instructions_delta
  // (attachments.ts) instead of here. This per-request sys-prompt append
  // busts the prompt cache when chrome connects late.
  const hasChromeTools = filteredTools.some(t =>
    isToolFromMcpServer(t.name, CLAUDE_IN_CHROME_MCP_SERVER_NAME),
  )
  const injectChromeHere =
    useToolSearch && hasChromeTools && !isMcpInstructionsDeltaEnabled()

  // filter(Boolean) works by converting each element to a boolean - empty strings become false and are filtered out.
// 拼装 system prompt：归因头 + CLI 前缀 + 用户自定义部分 + advisor 指令 + chrome 指令。
// `.filter(Boolean)` 过滤掉空字符串（利用布尔转换）。
  systemPrompt = asSystemPrompt(
    [
      getAttributionHeader(fingerprint),
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
      ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  // Prepend system prompt block for easy API identification
  logAPIPrefix(systemPrompt)

// 把 system prompt 切成若干块，并给需要缓存的块加 cache_control。
  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  })
  const useBetas = betas.length > 0

  // Build minimal context for detailed tracing (when beta tracing is enabled)
  // Note: The actual new_context message extraction is done in sessionTracing.ts using
  // hash-based tracking per querySource (agent) from the messagesForAPI array
  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (advisorModel) {
    // Server tools must be in the tools array by API contract. Appended after
    // toolSchemas (which carries the cache_control marker) so toggling /advisor
    // only churns the small suffix, not the cached prefix.
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as BetaToolUnion)
  }
  const allTools = [...toolSchemas, ...extraToolSchemas]

// fast mode 判定：多个开关都要满足（功能启用、可用、不在冷却期、模型支持、调用方要求）。
  const isFastMode =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(options.model) &&
    !!options.fastMode

// ★★「粘滞（latch）」机制 —— 本文件最重要的缓存保护设计之一。
// 规则：某个 beta 头一旦发过，之后整个会话**一直**发；即使中途用户关掉了该功能。
// 为什么？因为请求头是服务端缓存键的一部分，一旦头变化，
// 之前缓存的 5~7 万 token 全部作废，要重新付钱。
// 所以宁可「多发一个头」也不要「缓存失效」。
// 这些 latch 会在 /clear 和 /compact 时统一清除。
  // Sticky-on latches for dynamic beta headers. Each header, once first
  // sent, keeps being sent for the rest of the session so mid-session
  // toggles don't change the server-side cache key and bust ~50-70K tokens.
  // Latches are cleared on /clear and /compact via clearBetaHeaderLatches().
  // Per-call gates (isAgenticQuery, querySource===repl_main_thread) stay
  // per-call so non-agentic queries keep their own stable header set.

  let afkHeaderLatched = getAfkModeHeaderLatched() === true
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (
      !afkHeaderLatched &&
      isAgenticQuery &&
      shouldIncludeFirstPartyOnlyBetas() &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    ) {
      afkHeaderLatched = true
      setAfkModeHeaderLatched(true)
    }
  }

  let fastModeHeaderLatched = getFastModeHeaderLatched() === true
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true
    setFastModeHeaderLatched(true)
  }

  let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
  if (feature('CACHED_MICROCOMPACT')) {
    if (
      !cacheEditingHeaderLatched &&
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread'
    ) {
      cacheEditingHeaderLatched = true
      setCacheEditingHeaderLatched(true)
    }
  }

  // Only latch from agentic queries so a classifier call doesn't flip the
  // main thread's context_management mid-turn.
// 距上次调用超过 1 小时 → 把 thinking 清空的开关也 latch 住（同样是为了缓存稳定）。
// 注意只在 agentic 查询上 latch，避免分类器之类的小请求影响主线程。
  let thinkingClearLatched = getThinkingClearLatched() === true
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue)

// ★ 请求**发出前**记录 prompt 状态（阶段一），供缓存失效检测用。
// 注意两个细节：
//   ①排除掉了 defer_loading 的工具（服务端会剥掉它们，不影响缓存键，
//     算进去只会产生误报）；
//   ②传的是 **latch 之后**的值（而不是用户当前的开关状态），
//     因为真正发送的是 latch 值——检测必须反映实际发出的东西。
  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    // Exclude defer_loading tools from the hash -- the API strips them from the
    // prompt, so they never affect the actual cache key. Including them creates
    // false-positive "tool schemas changed" breaks when tools are discovered or
    // MCP servers reconnect.
    const toolsForCacheDetection = allTools.filter(
      t => !('defer_loading' in t && t.defer_loading),
    )
    // Capture everything that could affect the server-side cache key.
    // Pass latched header values (not live state) so break detection
    // reflects what we actually send, not what the user toggled.
    recordPromptState({
      system,
      toolSchemas: toolsForCacheDetection,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      fastMode: fastModeHeaderLatched,
      globalCacheStrategy,
      betas,
      autoModeActive: afkHeaderLatched,
      isUsingOverage: currentLimits.isUsingOverage ?? false,
      cachedMCEnabled: cacheEditingHeaderLatched,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    })
  }

  const newContext: LLMRequestNewContext | undefined = isBetaTracingEnabled()
    ? {
        systemPrompt: systemPrompt.join('\n\n'),
        querySource: options.querySource,
        tools: jsonStringify(allTools),
      }
    : undefined

  // Capture the span so we can pass it to endLLMRequestSpan later
  // This ensures responses are matched to the correct request when multiple requests run in parallel
// 开启链路追踪的 span。保存引用，后面结束时要用它来正确配对请求与响应。
  const llmSpan = startLLMRequestSpan(
    options.model,
    newContext,
    messagesForAPI,
    isFastMode,
  )

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  let stream: Stream<BetaRawMessageStreamEvent> | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in Node 18+ and is used by the SDK
  let streamResponse: Response | undefined = undefined

  // Release all stream resources to prevent native memory leaks.
  // The Response object holds native TLS/socket buffers that live outside the
  // V8 heap (observed on the Node.js/npm path; see GH #32920), so we must
  // explicitly cancel and release it regardless of how the generator exits.
// ★★ 释放流资源（防止内存泄漏）。注释里说明了原因，很重要：
// Response 对象持有 **V8 堆之外**的原生 TLS/socket 缓冲区，
// JS 的垃圾回收管不到它们，必须显式 cancel + abort，否则会一直泄漏。
// 在 Node/npm 那条路径上就真实发生过（GH #32920）。
// Java 里对应的是「必须显式 close 网络连接」——不 close 就会句柄泄漏。
  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // Consume pending cache edits ONCE before paramsFromContext is defined.
  // paramsFromContext is called multiple times (logging, retries), so consuming
  // inside it would cause the first call to steal edits from subsequent calls.
// ★ 为什么要在外面**一次性**消费掉待处理的缓存编辑？
// 注释说明：paramsFromContext 会被调用多次（日志一次、每次重试一次），
// 如果在它内部消费，第一次调用就会把编辑「偷走」，后面几次就拿不到了。
  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

  // Capture the betas sent in the last API request, including the ones that
  // were dynamically added, so we can log and send it to telemetry.
  let lastRequestBetas: string[] | undefined

// ★★ paramsFromContext：拼装**完整请求参数**的函数（本文件里被调用最多次的地方）。
// 它是个闭包，捕获了上面算好的 system / messagesForAPI / allTools / betas 等。
// 每次重试都会重新调用它（因为 retryContext 可能变了，比如 maxTokensOverride）。
// 返回的对象就是最终发给 API 的 body（外加 stream: true 在调用处加上）。
  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas]

    // Append 1M beta dynamically for the Sonnet 1M experiment.
    if (
      !betasParams.includes(CONTEXT_1M_BETA_HEADER) &&
      getSonnet1mExpTreatmentEnabled(retryContext.model)
    ) {
      betasParams.push(CONTEXT_1M_BETA_HEADER)
    }

    // For Bedrock, include both model-based betas and dynamically-added tool search header
    const bedrockBetas =
      getAPIProvider() === 'bedrock'
        ? [
            ...getBedrockExtraBodyParamsBetas(retryContext.model),
            ...(toolSearchHeader ? [toolSearchHeader] : []),
          ]
        : []
    const extraBodyParams = getExtraBodyParams(bedrockBetas)

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    // Merge outputFormat into extraBodyParams.output_config alongside effort
    // Requires structured-outputs beta header per SDK (see parse() in messages.mjs)
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      // Add beta header if not already present and provider supports it
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    // Retry context gets preference because it tries to course correct if we exceed the context window limit
// max_tokens 的优先级：重试上下文（超上下文窗口后调整过的值）> 调用方指定 > 模型默认值。
// 注释说明：重试上下文优先，因为它是「为了修复错误而算出来的」。
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

// thinking（思考）配置。注释里有一句很重的提醒：不要随便改 adaptive 与 budget 的选择逻辑，
// 这会显著影响模型质量——属于「改动需通知负责人」的敏感区域。
    const hasThinking =
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)
    let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined

    // IMPORTANT: Do not change the adaptive-vs-budget thinking selection below
    // without notifying the model launch DRI and research. This is a sensitive
    // setting that can greatly affect model quality and bashing.
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        // For models that support adaptive thinking, always use adaptive
        // thinking without a budget.
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        // For models that do not support adaptive thinking, use the default
        // thinking budget unless explicitly specified.
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } satisfies BetaMessageStreamParams['thinking']
      }
    }

    // Get API context management strategies if enabled
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

// ★ 又一个缓存稳定性技巧：fast mode 的 **beta 头**是 latch 的（稳定），
// 但请求体里的 speed='fast' 是**动态**的（可以随冷却状态变）。
// 这样既能让冷却立即生效（不发 fast 请求），又不改变缓存键。
    // Fast mode: header is latched session-stable (cache-safe), but
    // `speed='fast'` stays dynamic so cooldown still suppresses the actual
    // fast-mode request without changing the cache key.
    let speed: BetaMessageStreamParams['speed']
    const isFastModeForRetry =
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model) &&
      !!retryContext.fastMode
    if (isFastModeForRetry) {
      speed = 'fast'
    }
    if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
      betasParams.push(FAST_MODE_BETA_HEADER)
    }

    // AFK mode beta: latched once auto mode is first activated. Still gated
    // by isAgenticQuery per-call so classifiers/compaction don't get it.
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (
        afkHeaderLatched &&
        shouldIncludeFirstPartyOnlyBetas() &&
        isAgenticQuery &&
        !betasParams.includes(AFK_MODE_BETA_HEADER)
      ) {
        betasParams.push(AFK_MODE_BETA_HEADER)
      }
    }

    // Cache editing beta: header is latched session-stable; useCachedMC
    // (controls cache_edits body behavior) stays live so edits stop when
    // the feature disables but the header doesn't flip.
    const useCachedMC =
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging(
        'Cache editing beta header enabled for cached microcompact',
      )
    }

    // Only send temperature when thinking is disabled — the API requires
    // temperature: 1 when thinking is enabled, which is already the default.
// 只在关闭 thinking 时才显式传 temperature（开启 thinking 时 API 要求 temperature=1，
// 而 1 本来就是默认值，没必要传）。
    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    lastRequestBetas = betasParams

    return {
      model: normalizeModelStringForAPI(options.model),
// addCacheBreakpoints：在消息上打缓存断点（详见该函数）。
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        useCachedMC,
        consumedCacheEdits,
        consumedPinnedEdits,
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
      ...(speed !== undefined && { speed }),
    }
  }

// ★ 性能细节：把要上报的标量**提前算好**，再丢进 fire-and-forget 的 .then() 里。
// 原因：如果闭包捕获了 paramsFromContext 的完整作用域（messagesForAPI、system、
// allTools …），这些大对象会一直被钉在内存里直到 promise 完成。
// 只捕获 primitive 就能立刻释放。这是很地道的 JS 内存优化。
  // Compute log scalars synchronously so the fire-and-forget .then() closure
  // captures only primitives instead of paramsFromContext's full closure scope
  // (messagesForAPI, system, allTools, betas — the entire request-building
  // context), which would otherwise be pinned until the promise resolves.
  {
    const queryParams = paramsFromContext({
      model: options.model,
      thinkingConfig,
    })
    const logMessagesLength = queryParams.messages.length
    const logBetas = useBetas ? (queryParams.betas ?? []) : []
    const logThinkingType = queryParams.thinking?.type ?? 'disabled'
    const logEffortValue = queryParams.output_config?.effort
    void options.getToolPermissionContext().then(permissionContext => {
      logAPIQuery({
        model: options.model,
        messagesLength: logMessagesLength,
        temperature: options.temperatureOverride ?? 1,
        betas: logBetas,
        permissionMode: permissionContext.mode,
        querySource: options.querySource,
        queryTracking: options.queryTracking,
        thinkingType: logThinkingType,
        effortValue: logEffortValue,
        fastMode: isFastMode,
        previousRequestId,
      })
    })
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: BetaMessage | undefined = undefined
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: BetaStopReason | null = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined = undefined
  let research: unknown = undefined
  let isFastModeRequest = isFastMode // Keep separate state as it may change if falling back
  let isAdvisorInProgress = false

// ===== 正式发请求 =====
  try {
    queryCheckpoint('query_client_creation_start')
// ★ withRetry：把「发请求」这件事包进重试循环（详见 ./withRetry.ts）。
// 第一个回调 getClient 负责造 client（鉴权失效时会重新调它）；
// 第二个回调 operation 是真正发请求（会被调用 1~N 次）。
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0, // Disabled auto-retry in favor of manual implementation
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
// operation 的三个参数：client、第几次尝试、重试上下文（可能带 maxTokensOverride 等）。
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        isFastModeRequest = context.fastMode ?? false
        start = Date.now()
        attemptStartTimes.push(start)
        // Client has been created by withRetry's getClient() call. This fires
        // once per attempt; on retries the client is usually cached (withRetry
        // only calls getClient() again after auth errors), so the delta from
        // client_creation_start is meaningful on attempt 1.
        queryCheckpoint('query_client_creation_end')

        const params = paramsFromContext(context)
        captureAPIRequest(params, options.querySource) // Capture for bug reports

        maxOutputTokens = params.max_tokens

        // Fire immediately before the fetch is dispatched. .withResponse() below
        // awaits until response headers arrive, so this MUST be before the await
        // or the "Network TTFB" phase measurement is wrong.
// 性能埋点必须在 await **之前**打：withResponse() 会一直等到响应头到达，
// 放在它后面测到的就不是「网络请求发出」的时刻了。
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        // Generate and track client request ID so timeouts (which return no
        // server request ID) can still be correlated with server logs.
        // First-party only — 3P providers don't log it (inc-4029 class).
// 客户端请求 ID：只给第一方 API 加（第三方不记录这个头，加了反而可能被严格代理拒绝）。
        clientRequestId =
          getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined

        // Use raw stream instead of BetaMessageStream to avoid O(n²) partial JSON parsing
        // BetaMessageStream calls partialParse() on every input_json_delta, which we don't need
        // since we handle tool input accumulation ourselves
        // biome-ignore lint/plugin: main conversation loop handles attribution separately
// ★★★ 这里就是「真正发 HTTP 请求」的那一行！
// `stream: true` → 服务端返回 SSE（text/event-stream）长连接响应；
// `.withResponse()` → 额外拿到原始 Response（含 headers）与 request_id。
//
// ★ 注释解释了为什么用 raw stream 而不是 SDK 的 BetaMessageStream：
//   后者在每个 input_json_delta 上都做一次 partialParse（O(n²)），
//   而工具入参我们自己累积就行，没必要付这个代价。
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse()
        queryCheckpoint('query_response_headers_received')
        streamRequestId = result.request_id
        streamResponse = result.response
        return result.data
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
        signal,
        querySource: options.querySource,
      },
    )

// ★ 手工驱动 withRetry 生成器：
//   每次 next() 可能得到①一条系统消息（重试提示）或②最终的 stream。
//   判断方式很巧妙：`!('controller' in e.value)` —— stream 才有 controller 属性，
//   系统消息没有。区分之后：系统消息 yield 出去、stream 留下自己消费。
    let e
    do {
      e = await generator.next()

      // yield API error messages (the stream has a 'controller' property, error messages don't)
      if (!('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
// 到这里 e.done 为 true，e.value 就是 withRetry 的返回值：那个 SSE 事件流。
    stream = e.value as Stream<BetaRawMessageStreamEvent>

    // reset state
    newMessages.length = 0
    ttftMs = 0
    partialMessage = undefined
    contentBlocks.length = 0
    usage = EMPTY_USAGE
    stopReason = null
    isAdvisorInProgress = false

// ★ 流式空闲看门狗（watchdog）：如果超过 90 秒一个字节都没收到，主动掐断。
// 为什么需要？注释说明：SDK 的超时只覆盖**发起请求**那一步，不覆盖流式 body。
// 所以连接被静默断开时，for await 会永远挂着，整个会话卡死。
    // Streaming idle timeout watchdog: abort the stream if no chunks arrive
    // for STREAM_IDLE_TIMEOUT_MS. Unlike the stall detection below (which only
    // fires when the *next* chunk arrives), this uses setTimeout to actively
    // kill hung streams. Without this, a silently dropped connection can hang
    // the session indefinitely since the SDK's request timeout only covers the
    // initial fetch(), not the streaming body.
    const streamWatchdogEnabled = isEnvTruthy(
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
    )
    const STREAM_IDLE_TIMEOUT_MS =
      parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
    const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
    let streamIdleAborted = false
    // performance.now() snapshot when watchdog fires, for measuring abort propagation delay
    let streamWatchdogFiredAt: number | null = null
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    function clearStreamIdleTimers(): void {
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer)
        streamIdleWarningTimer = null
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }
// 每收到一个事件就重置计时器（有数据就不算卡住）。
    function resetStreamIdleTimer(): void {
      clearStreamIdleTimers()
      if (!streamWatchdogEnabled) {
        return
      }
      streamIdleWarningTimer = setTimeout(
        warnMs => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
            { level: 'warn' },
          )
          logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
        },
        STREAM_IDLE_WARNING_MS,
        STREAM_IDLE_WARNING_MS,
      )
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        logForDebugging(
          `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        logEvent('tengu_streaming_idle_timeout', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          timeout_ms: STREAM_IDLE_TIMEOUT_MS,
        })
        releaseStreamResources()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    resetStreamIdleTimer()

// 标记会话「正在活动」，防止被外部判定为空闲而杀掉。
    startSessionActivity('api_call')
    try {
      // stream in and accumulate state
      let isFirstChunk = true
      let lastEventTime: number | null = null // Set after first chunk to avoid measuring TTFB as a stall
      const STALL_THRESHOLD_MS = 30_000 // 30 seconds
      let totalStallTime = 0
      let stallCount = 0

// ★★★ `for await (const part of stream)` —— 整个流式处理的核心循环。
// Stream 实现了异步可迭代协议，所以能直接 for await：
//   每收到一个 SSE 事件就循环一次，事件解析由 SDK 完成。
// Java 类比：Flux<Event> 的 subscribe / WebClient 的 bodyToFlux。
// 这里是「边收边处理」：收到一个事件就立刻处理并 yield，用户就能看到逐字输出。
      for await (const part of stream) {
        resetStreamIdleTimer()
        const now = Date.now()

        // Detect and log streaming stalls (only after first event to avoid counting TTFB)
// 卡顿检测：两个事件之间超过 30 秒就记一条（用于分析服务端/网络是否抖动）。
// 注意第一条事件不算（那段时间是 TTFB，不是卡顿）。
        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++
            totalStallTime += timeSinceLastEvent
            logForDebugging(
              `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: 'warn' },
            )
            logEvent('tengu_streaming_stall', {
              stall_duration_ms: timeSinceLastEvent,
              stall_count: stallCount,
              total_stall_time_ms: totalStallTime,
              event_type:
                part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
        }
        lastEventTime = now

// 收到第一个 chunk：记录 TTFT（首字节时间）——流式体验最重要的指标。
        if (isFirstChunk) {
          logForDebugging('Stream started - received first chunk')
          queryCheckpoint('query_first_chunk_received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
          }
          endQueryProfile()
          isFirstChunk = false
        }

// ★ switch (part.type)：按事件类型分别处理。
// 六种事件对应「流的一辈子」：
//   message_start → content_block_start → content_block_delta × N →
//   content_block_stop → message_delta → message_stop
// 下面逐个分支都有说明。
        switch (part.type) {
// message_start：流的第一个事件，带来消息的骨架和初始 usage。
// ttftMs = 现在 - 本次尝试开始 → 这就是首字节延迟。
          case 'message_start': {
            partialMessage = part.message
            ttftMs = Date.now() - start
            usage = updateUsage(usage, part.message?.usage)
            // Capture research from message_start if available (internal only).
            // Always overwrite with the latest value.
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part.message as unknown as Record<string, unknown>)
            ) {
              research = (part.message as unknown as Record<string, unknown>)
                .research
            }
            break
          }
// content_block_start：一个新内容块开始了（text / thinking / tool_use / server_tool_use …）。
// 这里**初始化**一个空块，后面靠 delta 一点点往里填。
          case 'content_block_start':
            switch (part.content_block.type) {
              case 'tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '',
                }
                break
              case 'server_tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '' as unknown as { [key: string]: unknown },
                }
                if ((part.content_block.name as string) === 'advisor') {
                  isAdvisorInProgress = true
                  logForDebugging(`[AdvisorTool] Advisor tool called`)
                  logEvent('tengu_advisor_tool_call', {
                    model:
                      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    advisor_model: (advisorModel ??
                      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                }
                break
// ★ 注意这里的坑（原注释）：SDK 有时会在 content_block_start 里就带上文本，
// 然后在 content_block_delta 里**再发一遍同样的文本**。
// 所以这里故意把 text 初始化成空串——宁可等 delta，也不要重复累加。
              case 'text':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // awkwardly, the sdk sometimes returns text as part of a
                  // content_block_start message, then returns the same text
                  // again in a content_block_delta message. we ignore it here
                  // since there doesn't seem to be a way to detect when a
                  // content_block_delta message duplicates the text.
                  text: '',
                }
                break
// thinking 块：同样初始化成空，并且**预置 signature 字段**——
// 注释说明：确保即使后面 signature_delta 一直不来，这个字段也存在（避免 undefined）。
              case 'thinking':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // also awkward
                  thinking: '',
                  // initialize signature to ensure field exists even if signature_delta never arrives
                  signature: '',
                }
                break
// ★ default 分支的注释很关键：SDK 会**就地修改**文本内容块，
// 而我们希望块是不可变的、状态由我们自己累积，所以这里用展开复制一份。
              default:
                // even more awkwardly, the sdk mutates the contents of text blocks
                // as it works. we want the blocks to be immutable, so that we can
                // accumulate state ourselves.
                contentBlocks[part.index] = { ...part.content_block }
                if (
                  (part.content_block.type as string) === 'advisor_tool_result'
                ) {
                  isAdvisorInProgress = false
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
                break
            }
            break
// content_block_delta：★ 最频繁的事件 —— 往块里追加一小段内容。
          case 'content_block_delta': {
            const contentBlock = contentBlocks[part.index]
            const delta = part.delta as typeof part.delta | ConnectorTextDelta
            if (!contentBlock) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (
              feature('CONNECTOR_TEXT') &&
              delta.type === 'connector_text_delta'
            ) {
              if (contentBlock.type !== 'connector_text') {
                logEvent('tengu_streaming_error', {
                  error_type:
                    'content_block_type_mismatch_connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  expected_type:
                    'connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  actual_type:
                    contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                throw new Error('Content block is not a connector_text block')
              }
              contentBlock.connector_text += delta.connector_text
            } else {
              switch (delta.type) {
                case 'citations_delta':
                  // TODO: handle citations
                  break
// input_json_delta：工具入参是**分片**发来的 JSON 片段（不是完整 JSON）。
// 所以这里是把片段字符串**拼接**起来（contentBlock.input += delta.partial_json），
// 等块结束时再一次性解析。这也是为什么 tool_use 块的 input 先初始化成空字符串。
                case 'input_json_delta':
                  if (
                    contentBlock.type !== 'tool_use' &&
                    contentBlock.type !== 'server_tool_use'
                  ) {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_input_json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'tool_use' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a input_json block')
                  }
                  if (typeof contentBlock.input !== 'string') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_input_not_string' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      input_type:
                        typeof contentBlock.input as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block input is not a string')
                  }
                  contentBlock.input += delta.partial_json
                  break
// text_delta：追加一小段文本（打字机效果就是从这里来的）。
                case 'text_delta':
                  if (contentBlock.type !== 'text') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a text block')
                  }
                  contentBlock.text += delta.text
                  break
                case 'signature_delta':
                  if (
                    feature('CONNECTOR_TEXT') &&
                    contentBlock.type === 'connector_text'
                  ) {
                    contentBlock.signature = delta.signature
                    break
                  }
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_signature' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.signature = delta.signature
                  break
// thinking_delta：追加一小段思考过程。
                case 'thinking_delta':
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.thinking += delta.thinking
                  break
              }
            }
            // Capture research from content_block_delta if available (internal only).
            // Always overwrite with the latest value.
            if (process.env.USER_TYPE === 'ant' && 'research' in part) {
              research = (part as { research: unknown }).research
            }
            break
          }
// content_block_stop：这个块写完了 → 把它归一化后拼成一条 AssistantMessage 并 yield。
// ⚠️ 注意：此刻的 usage 还是 message_start 时的（output_tokens 为 0），
// 真正的最终值要等 message_delta，后面会「回填」。
          case 'content_block_stop': {
            const contentBlock = contentBlocks[part.index]
            if (!contentBlock) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_stop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (!partialMessage) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'partial_message_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              throw new Error('Message not found')
            }
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                content: normalizeContentFromAPI(
                  [contentBlock] as BetaContentBlock[],
                  tools,
                  options.agentId,
                ),
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(process.env.USER_TYPE === 'ant' &&
                research !== undefined && { research }),
              ...(advisorModel && { advisorModel }),
            }
            newMessages.push(m)
            yield m
            break
          }
// message_delta：带来**最终**的 usage 和 stop_reason。
          case 'message_delta': {
            usage = updateUsage(usage, part.usage)
            // Capture research from message_delta if available (internal only).
            // Always overwrite with the latest value. Also write back to
            // already-yielded messages since message_delta arrives after
            // content_block_stop.
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part as unknown as Record<string, unknown>)
            ) {
              research = (part as unknown as Record<string, unknown>).research
              for (const msg of newMessages) {
                msg.research = research
              }
            }

// ★★ 这里有一段非常重要的注释，讲为什么要「直接修改属性」而不是「替换对象」：
// 会话落盘队列持有的是 message.message 的**引用**，并且是延迟序列化（100ms 刷一次）。
// 如果这里用 `{ ...lastMsg.message, usage }` 替换对象，队列里那份引用就断开了，
// 落盘的还是旧值（usage 为 0）。所以必须 lastMsg.message.usage = usage 直接改。
// 这是「引用共享 + 延迟序列化」场景的经典坑。
            // Write final usage and stop_reason back to the last yielded
            // message. Messages are created at content_block_stop from
            // partialMessage, which was set at message_start before any tokens
            // were generated (output_tokens: 0, stop_reason: null).
            // message_delta arrives after content_block_stop with the real
            // values.
            //
            // IMPORTANT: Use direct property mutation, not object replacement.
            // The transcript write queue holds a reference to message.message
            // and serializes it lazily (100ms flush interval). Object
            // replacement ({ ...lastMsg.message, usage }) would disconnect
            // the queued reference; direct mutation ensures the transcript
            // captures the final values.
            stopReason = part.delta.stop_reason

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage
              lastMsg.message.stop_reason = stopReason
            }

            // Update cost
// 按更新后的 usage 计算美元成本，并累加到会话总成本。
            const costUSDForPart = calculateUSDCost(resolvedModel, usage)
            costUSD += addToTotalSessionCost(
              costUSDForPart,
              usage,
              options.model,
            )

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
            )
            if (refusalMessage) {
              yield refusalMessage
            }

// stop_reason = max_tokens：输出被截断了 → 产出一条错误消息告诉用户怎么调大上限。
            if (stopReason === 'max_tokens') {
              logEvent('tengu_max_tokens_reached', {
                max_tokens: maxOutputTokens,
              })
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: Claude's response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }

// stop_reason = model_context_window_exceeded：上下文窗口满了。
// 复用 max_output_tokens 的恢复路径（对模型来说两者都是「被打断，请继续」）。
            if (stopReason === 'model_context_window_exceeded') {
              logEvent('tengu_context_window_exceeded', {
                max_tokens: maxOutputTokens,
                output_tokens: usage.output_tokens,
              })
              // Reuse the max_output_tokens recovery path — from the model's
              // perspective, both mean "response was cut off, continue from
              // where you left off."
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }
            break
          }
// message_stop：流结束，不需要额外处理。
          case 'message_stop':
            break
        }

// ★ 除了业务消息，还要把**原始事件**也 yield 出去（type: 'stream_event'），
// 让 UI 层能做逐字渲染、工具进度条等。message_start 时额外带上 ttftMs。
        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs } : undefined),
        }
      }
      // Clear the idle timeout watchdog now that the stream loop has exited
      clearStreamIdleTimers()

      // If the stream was aborted by our idle timeout watchdog, fall back to
      // non-streaming retry rather than treating it as a completed stream.
// 如果是看门狗掐断的：记录一条「循环确实退出了」的遥测（区分「真卡死」和「报错退出」），
// 然后抛错，走到下面的非流式降级。
      if (streamIdleAborted) {
        // Instrumentation: proves the for-await exited after the watchdog fired
        // (vs. hung forever). exit_delay_ms measures abort propagation latency:
        // 0-10ms = abort worked; >>1000ms = something else woke the loop.
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'clean' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // Prevent double-emit: this throw lands in the catch block below,
        // whose exit_path='error' probe guards on streamWatchdogFiredAt.
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // Detect when the stream completed without producing any assistant messages.
      // This covers two proxy failure modes:
      // 1. No events at all (!partialMessage): proxy returned 200 with non-SSE body
      // 2. Partial events (partialMessage set but no content blocks completed AND
      //    no stop_reason received): proxy returned message_start but stream ended
      //    before content_block_stop and before message_delta with stop_reason
      // BetaMessageStream had the first check in _endRequest() but the raw Stream
      // does not - without it the generator silently returns no assistant messages,
      // causing "Execution error" in -p mode.
      // Note: We must check stopReason to avoid false positives. For example, with
      // structured output (--json-schema), the model calls a StructuredOutput tool
      // on turn 1, then on turn 2 responds with end_turn and no content blocks.
      // That's a legitimate empty response, not an incomplete stream.
// ★ 防御：流正常结束了但**一条 assistant 消息都没产出**。
// 注释列举了两种代理故障：①一个事件都没有（返回了非 SSE 的 200）；
// ②只有 message_start 就断了。不处理的话会静默返回空，在 -p 模式下报「Execution error」。
// 另外特意检查了 stopReason，避免把「结构化输出导致的合法空响应」误判成故障。
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
            : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
          { level: 'error' },
        )
        logEvent('tengu_stream_no_events', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new Error('Stream ended without receiving any events')
      }

      // Log summary if any stalls occurred during streaming
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: 'warn' },
        )
        logEvent('tengu_streaming_stall_summary', {
          stall_count: stallCount,
          total_stall_time_ms: totalStallTime,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      // Check if the cache actually broke based on response tokens
// ★ 请求成功后，把本次的缓存读写 token 数交给缓存失效检测（阶段二）。
// 详见 ./promptCacheBreakDetection.ts。
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        void checkResponseForCacheBreak(
          options.querySource,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          messages,
          options.agentId,
          streamRequestId,
        )
      }

      // Process fallback percentage header and quota status if available
      // streamResponse is set when the stream is created in the withRetry callback above
      // TypeScript's control flow analysis can't track that streamResponse is set in the callback
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
// 从原始响应头里读配额状态、并保存 headers 供网关检测用。
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
        // Store headers for gateway detection
        responseHeaders = resp.headers
      }
// ===== 流式出错的处理 ===== 
    } catch (streamingError) {
      // Clear the idle timeout watchdog on error path too
      clearStreamIdleTimers()

      // Instrumentation: if the watchdog had already fired and the for-await
      // threw (rather than exiting cleanly), record that the loop DID exit and
      // how long after the watchdog. Distinguishes true hangs from error exits.
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_name:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

// ★ 区分「用户按 ESC 中止」和「SDK 超时」：
// 两者都会抛 APIUserAbortError，但只有 signal.aborted 为真才是用户主动中止；
// 否则是 SDK 内部超时，要转成 APIConnectionTimeoutError 上报。
      if (streamingError instanceof APIUserAbortError) {
        // Check if the abort signal was triggered by the user (ESC key)
        // If the signal is aborted, it's a user-initiated abort
        // If not, it's likely a timeout from the SDK
        if (signal.aborted) {
          // This is a real user abort (ESC key was pressed)
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          if (isAdvisorInProgress) {
            logEvent('tengu_advisor_tool_interrupted', {
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              advisor_model: (advisorModel ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
          throw streamingError
        } else {
          // The SDK threw APIUserAbortError but our signal wasn't aborted
          // This means it's a timeout from the SDK's internal timeout
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          // Throw a more specific error for timeout
          throw new APIConnectionTimeoutError({ message: 'Request timed out' })
        }
      }

      // When the flag is enabled, skip the non-streaming fallback and let the
      // error propagate to withRetry. The mid-stream fallback causes double tool
      // execution when streaming tool execution is active: the partial stream
      // starts a tool, then the non-streaming retry produces the same tool_use
      // and runs it again. See inc-4258.
// 可以关掉「流式 → 非流式」降级。原因（注释 + issue 编号）：
// 流式失败前可能已经**开始执行工具**了，非流式重试会产出同一个 tool_use 再执行一次，
// 造成重复执行。所以开启流式工具执行时建议关掉这个降级。
      const disableFallback =
        isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_streaming_to_non_streaming_fallback',
          false,
        )

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        logEvent('tengu_streaming_fallback_to_non_streaming', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : (String(
                  streamingError,
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attemptNumber,
          maxOutputTokens,
          thinkingType:
            thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_disabled: true,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_cause: (streamIdleAborted
            ? 'watchdog'
            : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw streamingError
      }

      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
// 标记「降级过」，并回调通知上层（用于 UI 提示或埋点）。
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          streamingError instanceof Error
            ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : (String(
                streamingError,
              ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_disabled: false,
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // Fall back to non-streaming mode with retries.
      // If the streaming failure was itself a 529, count it toward the
      // consecutive-529 budget so total 529s-before-model-fallback is the
      // same whether the overload was hit in streaming or non-streaming mode.
      // This is a speculative fix for https://github.com/anthropics/claude-code/issues/1513
      // Instrumentation: proves executeNonStreamingRequest was entered (vs. the
      // fallback event firing but the call itself hanging at dispatch).
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      logEvent('tengu_nonstreaming_fallback_started', {
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
// ★ `yield* executeNonStreamingRequest(...)`：委托给非流式降级生成器。
// 它的返回值（return 值）就是完整的 BetaMessage。
// 注意 initialConsecutive529Errors：如果流式那次本身就是 529，就计 1 次，
// 让「几次 529 后换模型」的总数在两种模式下一致。
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          ...(isFastModeEnabled() && { fastMode: isFastMode }),
          signal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          querySource: options.querySource,
        },
        paramsFromContext,
        (attempt, _startTime, tokens) => {
          attemptNumber = attempt
          maxOutputTokens = tokens
        },
        params => captureAPIRequest(params, options.querySource),
        streamRequestId,
      )

      const m: AssistantMessage = {
        message: {
          ...result,
          content: normalizeContentFromAPI(
            result.content,
            tools,
            options.agentId,
          ),
        },
        requestId: streamRequestId ?? undefined,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(process.env.USER_TYPE === 'ant' &&
          research !== undefined && {
            research,
          }),
        ...(advisorModel && {
          advisorModel,
        }),
      }
      newMessages.push(m)
      fallbackMessage = m
      yield m
// finally：无论正常还是异常都要清掉看门狗计时器（否则定时器会一直挂着）。
    } finally {
      clearStreamIdleTimers()
    }
// ===== withRetry 抛出错误（重试次数耗尽 / 不可重试）=====
  } catch (errorFromRetry) {
    // FallbackTriggeredError must propagate to query.ts, which performs the
    // actual model switch. Swallowing it here would turn the fallback into a
    // no-op — the user would just see "Model fallback triggered: X -> Y" as
    // an error message with no actual retry on the fallback model.
// ★★ FallbackTriggeredError **必须原样向上抛**（注释解释得很清楚）：
// 换模型这件事要由 query.ts 来做。如果在这里吞掉，用户只会看到一句
// 「Model fallback triggered: X -> Y」的报错，而实际并没有真的换模型重试。
// 教训：用来传递「结构性信号」的异常，中途绝不能当普通错误处理掉。
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    // Check if this is a 404 error during stream creation that should trigger
    // non-streaming fallback. This handles gateways that return 404 for streaming
    // endpoints but work fine with non-streaming. Before v2.1.8, BetaMessageStream
    // threw 404s during iteration (caught by inner catch with fallback), but now
    // with raw streams, 404s are thrown during creation (caught here).
// 流式端点返回 404（某些网关不支持流式但支持非流式）→ 也走一次非流式降级。
// 注释说明：改用 raw stream 之后，404 是在**创建流**时抛的（以前是在遍历时抛），
// 所以必须在这个 catch 里单独处理。
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      // 404 is thrown at .withResponse() before streamRequestId is assigned,
      // and CannotRetryError means every retry failed — so grab the failed
      // request's ID from the error header instead.
      const failedRequestId =
        (errorFromRetry.originalError as APIError).requestID ?? 'unknown'
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id:
          failedRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      try {
        // Fall back to non-streaming mode
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          params => captureAPIRequest(params, options.querySource),
          failedRequestId,
        )

        const m: AssistantMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ),
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(process.env.USER_TYPE === 'ant' &&
            research !== undefined && { research }),
          ...(advisorModel && { advisorModel }),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m

        // Continue to success logging below
      } catch (fallbackError) {
        // Propagate model-fallback signal to query.ts (see comment above).
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        // Fallback also failed, handle as normal error
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        if (error instanceof APIError) {
          extractQuotaStatusFromError(error)
        }

        const requestId =
          streamRequestId ||
          (error instanceof APIError ? error.requestID : undefined) ||
          (error instanceof APIError
            ? (error.error as { request_id?: string })?.request_id
            : undefined)

        logAPIError({
          error,
          model: errorModel,
          messageCount: messagesForAPI.length,
          messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
          durationMs: Date.now() - start,
          durationMsIncludingRetries: Date.now() - startIncludingRetries,
          attempt: attemptNumber,
          requestId,
          clientRequestId,
          didFallBackToNonStreaming,
          queryTracking: options.queryTracking,
          querySource: options.querySource,
          llmSpan,
          fastMode: isFastModeRequest,
          previousRequestId,
        })

        if (error instanceof APIUserAbortError) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        })
        releaseStreamResources()
        return
      }
// 其它错误：记录日志、上报分析事件、生成用户可见的错误消息。
    } else {
      // Original error handling for non-404 errors
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

// CannotRetryError 是个包装，要拆出原始错误和当时的模型名再上报。
      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      // Extract quota status from error headers if it's a rate limit error
      if (error instanceof APIError) {
        extractQuotaStatusFromError(error)
      }

      // Extract requestId from stream, error header, or error body
      const requestId =
        streamRequestId ||
        (error instanceof APIError ? error.requestID : undefined) ||
        (error instanceof APIError
          ? (error.error as { request_id?: string })?.request_id
          : undefined)

      logAPIError({
        error,
        model: errorModel,
        messageCount: messagesForAPI.length,
        messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
        durationMs: Date.now() - start,
        durationMsIncludingRetries: Date.now() - startIncludingRetries,
        attempt: attemptNumber,
        requestId,
        clientRequestId,
        didFallBackToNonStreaming,
        queryTracking: options.queryTracking,
        querySource: options.querySource,
        llmSpan,
        fastMode: isFastModeRequest,
        previousRequestId,
      })

      // Don't yield an assistant error message for user aborts
      // The interruption message is handled in query.ts
// 用户中止：不产出错误消息（中断提示由 query.ts 统一处理），直接返回。
      if (error instanceof APIUserAbortError) {
        releaseStreamResources()
        return
      }

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
// ★★ finally：释放流资源 + 补记降级产生的成本。
// 注释特别强调「必须在 finally 里」：如果消费者提前 break（生成器的 .return() 被调用），
// try 之后的代码根本不会执行，Response 的原生缓冲区就会泄漏到 GC 为止。
// Java 类比：必须在 finally / try-with-resources 里 close 连接。
  } finally {
    stopSessionActivity('api_call')
    // Must be in the finally block: if the generator is terminated early
    // via .return() (e.g. consumer breaks out of for-await-of, or query.ts
    // encounters an abort), code after the try/finally never executes.
    // Without this, the Response object's native TLS/socket buffers leak
    // until the generator itself is GC'd (see GH #32920).
    releaseStreamResources()

    // Non-streaming fallback cost: the streaming path tracks cost in the
    // message_delta handler before any yield. Fallback pushes to newMessages
    // then yields, so tracking must be here to survive .return() at the yield.
// 降级路径的成本要在这里补记：因为降级是先 yield 消息再返回，
// 而在 yield 处被 .return() 打断的话，yield 之后的代码不会执行。
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage)
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage,
        options.model,
      )
    }
  }

  // Mark all registered tools as sent to API so they become eligible for deletion
  if (feature('CACHED_MICROCOMPACT') && cachedMCEnabled) {
    markToolsSentToAPIState()
  }

  // Track the last requestId for the main conversation chain so shutdown
  // can send a cache eviction hint to inference. Exclude backgrounded
  // sessions (Ctrl+B) which share the repl_main_thread querySource but
  // run inside an agent context — they are independent conversation chains
  // whose cache should not be evicted when the foreground session clears.
// 记录主会话链最后一次请求的 ID（关停时用来给推理端发缓存驱逐提示）。
// 排除后台会话（Ctrl+B 挂起的）——它们是独立的对话链，不该被前台清缓存时误伤。
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // Precompute scalars so the fire-and-forget .then() closure doesn't pin the
  // full messagesForAPI array (the entire conversation up to the context window
  // limit) until getToolPermissionContext() resolves.
  const logMessageCount = messagesForAPI.length
  const logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI)
// ★ 上报成功事件（含用量、耗时、成本）。同样是 fire-and-forget（不 await）。
// 同样先把标量算好，避免闭包把整个 messagesForAPI 数组钉在内存里。
  void options.getToolPermissionContext().then(permissionContext => {
    logAPISuccessAndDuration({
      model:
        newMessages[0]?.message.model ?? partialMessage?.model ?? options.model,
      preNormalizedModel: options.model,
      usage,
      start,
      startIncludingRetries,
      attempt: attemptNumber,
      messageCount: logMessageCount,
      messageTokens: logMessageTokens,
      requestId: streamRequestId ?? null,
      stopReason,
      ttftMs,
      didFallBackToNonStreaming,
      querySource: options.querySource,
      headers: responseHeaders,
      costUSD,
      queryTracking: options.queryTracking,
      permissionMode: permissionContext.mode,
      // Pass newMessages for beta tracing - extraction happens in logging.ts
      // only when beta tracing is enabled
      newMessages,
      llmSpan,
      globalCacheStrategy,
      requestSetupMs: start - startIncludingRetries,
      attemptStartTimes,
      fastMode: isFastModeRequest,
      previousRequestId,
      betas: lastRequestBetas,
    })
  })

  // Defensive: also release on normal completion (no-op if finally already ran).
  releaseStreamResources()
}

/**
 * Cleans up stream resources to prevent memory leaks.
 * @internal Exported for testing
 */
// 主动 abort 流（通过其 controller）。整体 try/catch 吞异常——流可能已经关了。
// 导出是为了方便测试。
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  if (!stream) {
    return
  }
  try {
    // Abort the stream via its controller if not already aborted
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // Ignore - stream may already be closed
  }
}

/**
 * Updates usage statistics with new values from streaming API events.
 * Note: Anthropic's streaming API provides cumulative usage totals, not incremental deltas.
 * Each event contains the complete usage up to that point in the stream.
 *
 * Input-related tokens (input_tokens, cache_creation_input_tokens, cache_read_input_tokens)
 * are typically set in message_start and remain constant. message_delta events may send
 * explicit 0 values for these fields, which should not overwrite the values from message_start.
 * We only update these fields if they have a non-null, non-zero value.
 */
// ★★ updateUsage：累积 token 用量。注释里有一个非常关键的事实：
// Anthropic 的流式 API 返回的 usage 是**累计值**而不是增量。
// 而且 message_delta 事件有时会把 input 相关的字段发成 **0**，
// 如果无脑覆盖，就会把 message_start 里的真实值抹掉。
// 所以 input 相关的三个字段只在「非 null 且 > 0」时才更新。
// 这是一个真实踩过的坑（B 端经常出现「用量为 0」的诡异数据）。
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: BetaMessageDeltaUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
// SDK 的类型里漏了 cache_creation 字段，但它真实存在——所以要断言过去再取。
      // SDK type BetaMessageDeltaUsage is missing cache_creation, but it's real!
      ephemeral_1h_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
// cache_deleted_input_tokens：缓存编辑功能返回的「被删除的缓存量」。
// 故意不放进 NonNullableUsage 类型，这样外部构建里这个字符串会被死代码消除掉。
    // cache_deleted_input_tokens: returned by the API when cache editing
    // deletes KV cache content, but not in SDK types. Kept off NonNullableUsage
    // so the string is eliminated from external builds by dead code elimination.
    // Uses the same > 0 guard as other token fields to prevent message_delta
    // from overwriting the real value with 0.
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            (partUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens != null &&
            (partUsage as unknown as { cache_deleted_input_tokens: number })
              .cache_deleted_input_tokens > 0
              ? (partUsage as unknown as { cache_deleted_input_tokens: number })
                  .cache_deleted_input_tokens
              : ((usage as unknown as { cache_deleted_input_tokens?: number })
                  .cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: (partUsage as BetaUsage).speed ?? usage.speed,
  }
}

/**
 * Accumulates usage from one message into a total usage object.
 * Used to track cumulative usage across multiple assistant turns.
 */
// 把一次请求的 usage 累加到总用量上（用于整个会话的统计）。
// 注意 service_tier / inference_geo / iterations / speed 取**最新**的（不是累加）。
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // Use the most recent service tier
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    // See comment in updateUsage — field is not on NonNullableUsage to keep
    // the string out of external builds.
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            ((totalUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens ?? 0) +
            ((
              messageUsage as unknown as { cache_deleted_input_tokens?: number }
            ).cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: messageUsage.inference_geo, // Use the most recent
    iterations: messageUsage.iterations, // Use the most recent
    speed: messageUsage.speed, // Use the most recent
  }
}

function isToolResultBlock(
  block: unknown,
): block is { type: 'tool_result'; tool_use_id: string } {
  return (
    block !== null &&
    typeof block === 'object' &&
    'type' in block &&
    (block as { type: string }).type === 'tool_result' &&
    'tool_use_id' in block
  )
}

type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}

type CachedMCPinnedEdits = {
  userMessageIndex: number
  block: CachedMCEditsBlock
}

// Exported for testing cache_reference placement constraints
// ★★ addCacheBreakpoints：在消息上放缓存断点（cache_control 标记）。
// 注释里有一段深入的解释：每个请求**只放一个**标记。
// 因为服务端的 KV 页淘汰机制，放两个会导致「倒数第二个位置」也被保护，
// 那些页会多存活一轮却永远不会被复用——浪费服务端资源。
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): MessageParam[] {
  logEvent('tengu_api_cache_breakpoints', {
    totalMessageCount: messages.length,
    cachingEnabled: enablePromptCaching,
    skipCacheWrite,
  })

  // Exactly one message-level cache_control marker per request. Mycro's
  // turn-to-turn eviction (page_manager/index.rs: Index::insert) frees
  // local-attention KV pages at any cached prefix position NOT in
  // cache_store_int_token_boundaries. With two markers the second-to-last
  // position is protected and its locals survive an extra turn even though
  // nothing will ever resume from there — with one marker they're freed
  // immediately. For fire-and-forget forks (skipCacheWrite) we shift the
  // marker to the second-to-last message: that's the last shared-prefix
  // point, so the write is a no-op merge on mycro (entry already exists)
  // and the fork doesn't leave its own tail in the KVCC. Dense pages are
  // refcounted and survive via the new hash either way.
// skipCacheWrite（一次性的分支请求）：把标记挪到倒数第二条消息，
// 这样这次写入是「空操作合并」（缓存里已经有了），不会留下自己的尾巴。
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })

  if (!useCachedMC) {
    return result
  }

  // Track all cache_references being deleted to prevent duplicates across blocks.
  const seenDeleteRefs = new Set<string>()

  // Helper to deduplicate a cache_edits block against already-seen deletions
  const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
    const uniqueEdits = block.edits.filter(edit => {
      if (seenDeleteRefs.has(edit.cache_reference)) {
        return false
      }
      seenDeleteRefs.add(edit.cache_reference)
      return true
    })
    return { ...block, edits: uniqueEdits }
  }

  // Re-insert all previously-pinned cache_edits at their original positions
  for (const pinned of pinnedEdits ?? []) {
    const msg = result[pinned.userMessageIndex]
    if (msg && msg.role === 'user') {
      if (!Array.isArray(msg.content)) {
        msg.content = [{ type: 'text', text: msg.content as string }]
      }
      const dedupedBlock = deduplicateEdits(pinned.block)
      if (dedupedBlock.edits.length > 0) {
        insertBlockAfterToolResults(msg.content, dedupedBlock)
      }
    }
  }

  // Insert new cache_edits into the last user message and pin them
  if (newCacheEdits && result.length > 0) {
    const dedupedNewEdits = deduplicateEdits(newCacheEdits)
    if (dedupedNewEdits.edits.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]
        if (msg && msg.role === 'user') {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: msg.content as string }]
          }
          insertBlockAfterToolResults(msg.content, dedupedNewEdits)
          // Pin so this block is re-sent at the same position in future calls
          pinCacheEdits(i, newCacheEdits)

          logForDebugging(
            `Added cache_edits block with ${dedupedNewEdits.edits.length} deletion(s) to message[${i}]: ${dedupedNewEdits.edits.map(e => e.cache_reference).join(', ')}`,
          )
          break
        }
      }
    }
  }

  // Add cache_reference to tool_result blocks that are within the cached prefix.
  // Must be done AFTER cache_edits insertion since that modifies content arrays.
  if (enablePromptCaching) {
    // Find the last message containing a cache_control marker
    let lastCCMsg = -1
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            lastCCMsg = i
          }
        }
      }
    }

    // Add cache_reference to tool_result blocks that are strictly before
// 给缓存前缀内的 tool_result 块加 cache_reference（供缓存编辑定位）。
// 用严格「早于」最后一个标记（而不是「早于等于」），避免块插入导致的下标偏移问题。
    // the last cache_control marker. The API requires cache_reference to
    // appear "before or on" the last cache_control — we use strict "before"
    // to avoid edge cases where cache_edits splicing shifts block indices.
    //
    // Create new objects instead of mutating in-place to avoid contaminating
    // blocks reused by secondary queries that use models without cache_editing support.
    if (lastCCMsg >= 0) {
      for (let i = 0; i < lastCCMsg; i++) {
        const msg = result[i]!
        if (msg.role !== 'user' || !Array.isArray(msg.content)) {
          continue
        }
        let cloned = false
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block && isToolResultBlock(block)) {
            if (!cloned) {
              msg.content = [...msg.content]
              cloned = true
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.tool_use_id,
            })
          }
        }
      }
    }
  }

  return result
}

// 把 system prompt 切成块并加缓存标记。
// ★ 注释警告：不要再加更多块了，否则会 400（服务端对缓存断点数量有限制）。
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  // IMPORTANT: Do not add any more blocks for caching or you will get a 400
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}

// Omit<Options, 'model' | 'getToolPermissionContext'>：
// Haiku 调用固定用小模型、不需要权限上下文，所以从 Options 里把这两个字段**去掉**。
type HaikuOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

// 便捷入口：用最小的 Haiku 模型做一次非流式问答（摘要、分类、生成标题等）。
// 默认关掉 prompt 缓存（这类一次性请求缓存命中率低，写了反而多花钱）。
export async function queryHaiku({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: HaikuOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getSmallFastModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // We don't use streaming for Haiku so this is safe
  return result[0]! as AssistantMessage
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * Query a specific model through the Claude Code infrastructure.
 * This goes through the full query pipeline including proper authentication,
 * betas, and headers - unlike direct API calls.
 */
// 便捷入口：指定模型做一次问答（走完整的鉴权 / beta / 请求头流程）。
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}

// Non-streaming requests have a 10min max per the docs:
// https://platform.claude.com/docs/en/api/errors#long-requests
// The SDK's 21333-token cap is derived from 10min × 128k tokens/hour, but we
// bypass it by setting a client-level timeout, so we can cap higher.
// 非流式请求的 max_tokens 上限 64k。
// 注释解释：文档说非流式最多 10 分钟；SDK 的 21333 上限是按 10min × 128k/小时 推的，
// 而我们通过设 client 级超时绕开了这个推导，所以可以设得更高。
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * Adjusts thinking budget when max_tokens is capped for non-streaming fallback.
 * Ensures the API constraint: max_tokens > thinking.budget_tokens
 *
 * @param params - The parameters that will be sent to the API
 * @param maxTokensCap - The maximum allowed tokens (MAX_NON_STREAMING_TOKENS)
 * @returns Adjusted parameters with thinking budget capped if needed
 */
// 非流式时如果 max_tokens 被压小，thinking 的预算也要跟着压，
// 必须满足「max_tokens > budget_tokens」这个 API 约束。
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // Adjust thinking budget if it would exceed capped max_tokens
  // to maintain the constraint: max_tokens > thinking.budget_tokens
  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // Must be at least 1 less than max_tokens
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

function isMaxTokensCapEnabled(): boolean {
  // 3P default: false (not validated on Bedrock/Vertex)
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
}

// 计算本次请求的最大输出 token。
// 注释说明了一个很实在的成本优化：线上统计显示 p99 输出只有 4911 token，
// 而默认 32k/64k 相当于预留了 8~16 倍的槽位（浪费）。所以灰度把默认降到 8k，
// 真撞到上限时再干净地重试一次 64k。
// 注意 Math.min 保证「模型原生上限更低」的模型（比如老 Opus 的 4k）不会被抬高。
export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  // Slot-reservation cap: drop default to 8k for all models. BQ p99 output
  // = 4,911 tokens; 32k/64k defaults over-reserve 8-16× slot capacity.
  // Requests hitting the cap get one clean retry at 64k (query.ts
  // max_output_tokens_escalate). Math.min keeps models with lower native
  // defaults (e.g. claude-3-opus at 4k) at their native value. Applied
  // before the env-var override so CLAUDE_CODE_MAX_OUTPUT_TOKENS still wins.
  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
    : maxOutputTokens.default

  const result = validateBoundedIntEnvVar(
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    defaultTokens,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
