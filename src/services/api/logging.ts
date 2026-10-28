/**
 * 【一句话定位】★ API 调用的「记帐与监控中心」：每一次请求/成功/失败都在这里
 *           上报分析事件（tengu_api_query / tengu_api_success / tengu_api_error），
 *           记录 token 用量、耗时、成本、缓存命中情况、错误分类等。
 *
 * 【在架构中的位置】
 *   调用链：src/services/api/claude.ts（真正发请求的那层，请求前后各调一次）
 *           → 本文件 logAPIQuery()（请求发出**前**：记录这次请求的形态）
 *           → 本文件 logAPISuccessAndDuration()（请求成功**后**：记用量/耗时/成本）
 *             → detectGateway()（从响应头判断是不是走了第三方 AI 网关）
 *             → logAPISuccess()（内部：拼出 tengu_api_success 事件）
 *             → utils/telemetry/events.js（logOTelEvent：OpenTelemetry 侧上报）
 *             → utils/telemetry/sessionTracing.js（endLLMRequestSpan：链路追踪）
 *           → 本文件 logAPIError()（请求失败**后**：记错误分类与连接层细节）
 *             → errors.ts 的 classifyAPIError()（错误分类，决定可不可重试）
 *             → errorUtils.ts 的 extractConnectionErrorDetails()（挖 SSL/网络根因）
 *     下游公共依赖：../analytics/index.js（logEvent，最终落到 Statsig/BigQuery）
 *
 * 【★ usage（token 用量）各字段的含义 —— 这是理解成本的关键】
 *   一次 API 响应里会带回这么几个计数（单位都是 token）：
 *   · input_tokens          ：本次**新算**的输入 token（没命中缓存的那部分），按全价计费。
 *   · cache_read_input_tokens：本次**命中**缓存、直接读出来的 token，约全价的 1/10 —— 最便宜。
 *   · cache_creation_input_tokens：本次**写入**缓存的 token，约全价的 1.25 倍 —— 最贵。
 *   · output_tokens        ：模型生成的输出 token，约全价的 5 倍 —— 单价最高。
 *   · cache_deleted_input_tokens（可选）：被主动删除的缓存量，仅在开启 cache editing 时出现。
 *   直观理解：一个长会话里，system prompt + 工具定义 + 历史消息 构成一个很长的**前缀**。
 *   只要前缀不变，每一轮都能命中缓存（cache_read 很大 → 省钱）；
 *   一旦前缀变了（换模型、改 system prompt、改工具），就要重新付 cache_creation，
 *   之后每轮的 input_tokens 也会涨 —— 这就是「烧钱」。
 *   所以本文件把 cachedInputTokens / uncachedInputTokens 分开上报，
 *   就是为了让人能从数据里看出「缓存到底有没有在生效」。
 *
 * 【本文件包含什么】
 *   - GlobalCacheStrategy：全局缓存策略类型。
 *   - getErrorMessage()：从错误对象里安全地取出消息文本。
 *   - KnownGateway / GATEWAY_FINGERPRINTS / GATEWAY_HOST_SUFFIXES / detectGateway()：
 *     识别请求是否经由第三方 AI 网关（LiteLLM / Helicone / Portkey / Cloudflare / Kong / Braintrust / Databricks）。
 *   - getAnthropicEnvMetadata()：把几个环境变量一并上报（便于分析用户配置）。
 *   - getBuildAgeMinutes()：当前二进制的「年龄」（分钟），用于分析版本新鲜度。
 *   - logAPIQuery()：请求前事件。
 *   - logAPIError()：失败事件。
 *   - logAPISuccess()：内部成功事件。
 *   - logAPISuccessAndDuration()：★ 对外成功入口（算耗时、抽内容长度、发 OTel、结束 span）。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. ★ `feature('CACHED_MICROCOMPACT')`：这是 Bun 打包器的**编译期特性开关**。
 *      它≈ C 语言的 `#ifdef`，不是运行时的 if！打包时如果是 false，
 *      整段代码会被**直接删掉**（连带着里面的 import 也可能被 tree-shake 掉）。
 *      所以你不能在里面写「运行时才决定」的逻辑——它在编译时就定死了。
 *      本文件还有 feature('CONNECTOR_TEXT')，同理。
 *      Java 完全没有对应机制（最接近的是 Maven profile + 类替换，或者 JIT 的死代码消除）。
 *   2. `import { feature } from 'bun:bundle'`：从 Bun 的虚拟模块导入（不是 npm 包）。
 *   3. `export type { NonNullableUsage }` / `export { EMPTY_USAGE }`：
 *      ★ **再导出（re-export）**。本文件把从别处导入的东西原样导出，
 *      让调用方可以「只 import 这一个文件」就拿到相关的类型和常量。
 *      Java 类比：Facade 类里 public static 引用别的包的常量。
 *   4. `Partial<Record<KnownGateway, { prefixes: string[] }>>`：
 *      ★ 两个**内置工具类型**嵌套使用：
 *      - `Record<K, V>` ≈ 一个键为 K、值为 V 的 Map（键的集合由联合类型 K 决定）；
 *      - `Partial<T>` = 把 T 的所有字段变成可选。
 *      合起来的意思：「每种网关都可以配一组前缀，但不要求全部都配」。
 *      Java 里没有这种类型运算，只能靠「Map + 运行时判空」。
 *   5. `Object.entries(obj)`：把对象转成 [key, value] 数组，然后可以 for...of 遍历。
 *      ≈ Java 的 map.entrySet()。配合解构 `for (const [gw, {prefixes}] of ...)` 使用。
 *   6. `headers.forEach((_, key) => headerNames.push(key))`：
 *      Headers 的 forEach 回调是 (value, key)，这里用 `_` 表示不用第一个参数。
 *   7. `globalThis.Headers`：显式使用全局的 Headers 类型（避免跟本地同名类型冲突）。
 *      `globalThis` ≈ 浏览器的 window / Node 的 global，是标准写法。
 *   8. `...(cond ? { k: v } : {})`：条件展开（本文件用了几十次！）。
 *      作用：「这个字段有值才上报」。好处是分析事件里不会出现一堆 undefined 字段，
 *      数据量更小、查询更快。这是本文件最密集出现的模式，看一遍就习惯了。
 *   9. `x as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`：
 *      一个超长的类型名，本质是 string 别名；命名本身是一句**人工声明**：
 *      「我确认这个值不是代码、也不是文件路径」。用于隐私合规审查——
 *      因为分析系统不允许上传用户的代码或路径。
 *      Java 类比：用 @PiiSafe 之类的注解做静态检查，只不过这里靠类型系统 + 命名约定。
 *  10. `ttftMs ?? undefined`：把 null 归一化成 undefined。
 *      为什么要归一？因为分析事件的字段一般希望是「有值或缺失」，不要出现 null。
 *  11. `String(status)` / `String(usage.input_tokens)`：
 *      OTel 的事件要求属性是字符串，所以要显式 String() 转换。
 *      Java 类比：String.valueOf(x)。
 *  12. `void logOTelEvent(...)`：`void` 表示「故意不 await」，让它后台跑，不阻塞主流程。
 *  13. `error instanceof APIError ? String(error.status) : undefined`：
 *      instanceof + 三元，跟 Java 一致。
 *  14. `flatMap(m => ...)`：★ 先 map 再拍平一层。这里用来「把所有消息的所有文本块
 *      收集成一个字符串数组」。Java：stream.flatMap(...).collect(toList())。
 *  15. `(usage as unknown as { cache_deleted_input_tokens?: number })`：
 *      双重断言，用来访问一个**官方类型里没有**的字段（因为是内部实验字段）。
 *      注释里解释了：这个字段故意不在 NonNullableUsage 上，外部构建里看不到它。
 *  16. `process.stdout.isTTY ?? false`：isTTY 表示「输出是不是终端」（用于区分人用还是脚本用）。
 *  17. `MACRO.BUILD_TIME`：一个编译期宏（同样是打包时替换的常量）。
 *  18. `new Date(x).getTime()` + `isNaN(...)`：JS 解析日期失败不抛异常而是返回 NaN，
 *      所以必须显式 isNaN 检查（Java 的 parse 会抛 DateTimeParseException）。
 */
import { feature } from 'bun:bundle'
import { APIError } from '@anthropic-ai/sdk'
import type {
  BetaStopReason,
  BetaUsage as Usage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  addToTotalDurationState,
  consumePostCompaction,
  getIsNonInteractiveSession,
  getLastApiCompletionTimestamp,
  getTeleportedSessionInfo,
  markFirstTeleportMessageLogged,
  setLastApiCompletionTimestamp,
} from 'src/bootstrap/state.js'
import type { QueryChainTracking } from 'src/Tool.js'
import { isConnectorTextBlock } from 'src/types/connectorText.js'
import type { AssistantMessage } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { EffortLevel } from 'src/utils/effort.js'
import { logError } from 'src/utils/log.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import type { PermissionMode } from 'src/utils/permissions/PermissionMode.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import {
  endLLMRequestSpan,
  isBetaTracingEnabled,
  type Span,
} from 'src/utils/telemetry/sessionTracing.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../analytics/metadata.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import { classifyAPIError } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

export type { NonNullableUsage }
export { EMPTY_USAGE }

// 全局 prompt 缓存策略：
//   tool_based     —— 把 cache_control 打在工具定义上；
//   system_prompt  —— 把 cache_control 打在 system prompt 上；
//   none           —— 不用缓存。
// 三种策略对应不同的缓存前缀位置，会影响命中率。
// Strategy used for global prompt caching
export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

// 从任意错误对象里取出消息文本。三级兜底：
// APIError 的嵌套 error.error.message → Error.message → String(error)。
// 为什么要这么绕？因为错误可能是任意形状（字符串、普通对象、SDK 错误）。
function getErrorMessage(error: unknown): string {
  if (error instanceof APIError) {
// `error.error as {...} | undefined`：断言成嵌套结构再逐层可选访问。
    const body = error.error as { error?: { message?: string } } | undefined
    if (body?.error?.message) return body.error.message
  }
  return error instanceof Error ? error.message : String(error)
}

// 已知的第三方 AI 网关名单。识别它们很重要：
// 出问题时能快速判断「是不是用户走的是代理」，而不是我们自己的 bug。
type KnownGateway =
  | 'litellm'
  | 'helicone'
  | 'portkey'
  | 'cloudflare-ai-gateway'
  | 'kong'
  | 'braintrust'
  | 'databricks'

// Gateway fingerprints for detecting AI gateways from response headers
// ★ 网关指纹：靠**响应头前缀**识别。比如响应里出现 x-litellm-* 就说明走了 LiteLLM。
// Partial<Record<...>> 表示「这些网关里，想配几个就配几个」。
const GATEWAY_FINGERPRINTS: Partial<
  Record<KnownGateway, { prefixes: string[] }>
> = {
  // https://docs.litellm.ai/docs/proxy/response_headers
  litellm: {
    prefixes: ['x-litellm-'],
  },
  // https://docs.helicone.ai/helicone-headers/header-directory
  helicone: {
    prefixes: ['helicone-'],
  },
  // https://portkey.ai/docs/api-reference/response-schema
  portkey: {
    prefixes: ['x-portkey-'],
  },
  // https://developers.cloudflare.com/ai-gateway/evaluations/add-human-feedback-api/
  'cloudflare-ai-gateway': {
    prefixes: ['cf-aig-'],
  },
  // https://developer.konghq.com/ai-gateway/ — X-Kong-Upstream-Latency, X-Kong-Proxy-Latency
  kong: {
    prefixes: ['x-kong-'],
  },
  // https://www.braintrust.dev/docs/guides/proxy — x-bt-used-endpoint, x-bt-cached
  braintrust: {
    prefixes: ['x-bt-'],
  },
}

// Gateways that use provider-owned domains (not self-hosted), so the
// ANTHROPIC_BASE_URL hostname is a reliable signal even without a
// distinctive response header.
// 另一类网关用**自己拥有的域名**（不是用户自部署的），
// 所以光看 base URL 的主机名就能确定（比如 *.cloud.databricks.com）。
const GATEWAY_HOST_SUFFIXES: Partial<Record<KnownGateway, string[]>> = {
  // https://docs.databricks.com/aws/en/ai-gateway/
  databricks: [
    '.cloud.databricks.com',
    '.azuredatabricks.net',
    '.gcp.databricks.com',
  ],
}

// ★ 网关探测：先查响应头，再查 base URL 主机名。返回 undefined 表示没走网关。
function detectGateway({
  headers,
  baseUrl,
}: {
  headers?: globalThis.Headers
  baseUrl?: string
}): KnownGateway | undefined {
  if (headers) {
// Headers API 的 key 已经是小写（HTTP 头不区分大小写，标准库统一转小写了）。
    // Header names are already lowercase from the Headers API
    const headerNames: string[] = []
    headers.forEach((_, key) => headerNames.push(key))
// Object.entries ≈ map.entrySet()，配合解构一次拿到 key 和 value。
// `gw as KnownGateway`：Object.entries 返回的 key 类型是 string，这里断言回联合类型。
    for (const [gw, { prefixes }] of Object.entries(GATEWAY_FINGERPRINTS)) {
      if (prefixes.some(p => headerNames.some(h => h.startsWith(p)))) {
        return gw as KnownGateway
      }
    }
  }

  if (baseUrl) {
// new URL(x).hostname：解析 URL 取主机名。可能抛异常（格式不对），所以包在 try 里。
    try {
      const host = new URL(baseUrl).hostname.toLowerCase()
      for (const [gw, suffixes] of Object.entries(GATEWAY_HOST_SUFFIXES)) {
        if (suffixes.some(s => host.endsWith(s))) {
          return gw as KnownGateway
        }
      }
    } catch {
      // malformed URL — ignore
    }
  }

  return undefined
}

// 把几个关键环境变量一起上报，方便分析「用户是怎么配的」。
// 注意每个都用条件展开：没配就不上报这个字段。
function getAnthropicEnvMetadata() {
  return {
    ...(process.env.ANTHROPIC_BASE_URL
      ? {
          baseUrl: process.env
            .ANTHROPIC_BASE_URL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(process.env.ANTHROPIC_MODEL
      ? {
          envModel: process.env
            .ANTHROPIC_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(process.env.ANTHROPIC_SMALL_FAST_MODEL
      ? {
          envSmallFastModel: process.env
            .ANTHROPIC_SMALL_FAST_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
  }
}

// 二进制「年龄」：从编译时间到现在过了多少分钟。
// 用途：分析用户是不是还在用很老的版本（老版本的 bug 可能已经修了）。
function getBuildAgeMinutes(): number | undefined {
// MACRO.BUILD_TIME 是编译期宏，打包时被替换成实际字符串。
  if (!MACRO.BUILD_TIME) return undefined
  const buildTime = new Date(MACRO.BUILD_TIME).getTime()
// ★ JS 的坑：new Date('非法字符串') 不抛异常，而是得到一个 Invalid Date，
// getTime() 返回 NaN。所以必须显式 isNaN 判断（Java 里会直接抛异常）。
  if (isNaN(buildTime)) return undefined
  return Math.floor((Date.now() - buildTime) / 60000)
}

// 【请求发出前】记录这次请求的「形态」：用什么模型、多少条消息、什么温度、
// 哪些 beta 头、什么权限模式、从哪来的（querySource）等。
// 配合后面的成功/失败事件，就能算出各种维度的成功率。
export function logAPIQuery({
  model,
  messagesLength,
  temperature,
  betas,
  permissionMode,
  querySource,
  queryTracking,
  thinkingType,
  effortValue,
  fastMode,
  previousRequestId,
}: {
  model: string
  messagesLength: number
  temperature: number
  betas?: string[]
  permissionMode?: PermissionMode
  querySource: string
  queryTracking?: QueryChainTracking
  thinkingType?: 'adaptive' | 'enabled' | 'disabled'
  effortValue?: EffortLevel | null
  fastMode?: boolean
  previousRequestId?: string | null
}): void {
// 事件名 tengu_api_query。字段全部用条件展开：有值才带，避免一堆 undefined。
  logEvent('tengu_api_query', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messagesLength,
// temperature：采样温度。0 表示尽量确定，越高越随机。
    temperature: temperature,
    provider: getAPIProviderForStatsig(),
    buildAgeMins: getBuildAgeMinutes(),
    ...(betas?.length
      ? {
          betas: betas.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    permissionMode:
      permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
// queryDepth：query 链的嵌套深度（主 query 调子 agent，子 agent 再调……），
// 用来分析深度对成功率/延迟的影响。
          queryDepth: queryTracking.depth,
        }
      : {}),
    thinkingType:
      thinkingType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    effortValue:
      effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    fastMode,
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...getAnthropicEnvMetadata(),
  })
}

// 【请求失败后】记录错误详情。这是排查线上问题最重要的数据来源。
export function logAPIError({
  error,
  model,
  messageCount,
  messageTokens,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  requestId,
  clientRequestId,
  didFallBackToNonStreaming,
  promptCategory,
  headers,
  queryTracking,
  querySource,
  llmSpan,
  fastMode,
  previousRequestId,
}: {
  error: unknown
  model: string
  messageCount: number
  messageTokens?: number
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  requestId?: string | null
// clientRequestId：客户端自己生成的请求 ID（见 client.ts 的 buildFetch）。
// ★ 它的重要性在于：**超时**的请求拿不到服务端返回的 request id，
// 只有这个客户端 ID 能拿去跟服务端日志对上。所以注释里专门写了用途。
  /** Client-generated ID sent as x-client-request-id header (survives timeouts) */
  clientRequestId?: string
  didFallBackToNonStreaming?: boolean
  promptCategory?: string
  headers?: globalThis.Headers
  queryTracking?: QueryChainTracking
  querySource?: string
  /** The span from startLLMRequestSpan - pass this to correctly match responses to requests */
  llmSpan?: Span
  fastMode?: boolean
  previousRequestId?: string | null
}): void {
// 先探测网关：如果是 APIError，优先用它自带的 headers（更准确）。
  const gateway = detectGateway({
    headers:
      error instanceof APIError && error.headers ? error.headers : headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

// getErrorMessage 统一取消息文本（不管错误是什么形状）。
  const errStr = getErrorMessage(error)
  const status = error instanceof APIError ? String(error.status) : undefined
// ★ classifyAPIError：把错误归成一个枚举类别（比如 overloaded / rate_limit / invalid_request）。
// 这是 errors.ts 的核心能力，决定了哪些错误可重试 —— 两个文件要对照着看。
  const errorType = classifyAPIError(error)

  // Log detailed connection error info to debug logs (visible via --debug)
// 连接层错误（SSL / DNS / 超时等）单独打一条详细日志，
// 因为这类错误在 --debug 下才可见，但对排查企业网络问题极其关键。
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    const sslLabel = connectionDetails.isSSLError ? ' (SSL error)' : ''
    logForDebugging(
      `Connection error details: code=${connectionDetails.code}${sslLabel}, message=${connectionDetails.message}`,
      { level: 'error' },
    )
  }

// consumeInvokingRequestId()：「取走」当前这次调用的上下文 ID。
// 叫 consume 是因为它取完就清空（一次性），防止串到下一次调用。
  const invocation = consumeInvokingRequestId()

  if (clientRequestId) {
    logForDebugging(
      `API error x-client-request-id=${clientRequestId} (give this to the API team for server-log lookup)`,
      { level: 'error' },
    )
  }

// 同时把错误记录到本地错误日志（logError）。
  logError(error as Error)
// 事件名 tengu_api_error。
  logEvent('tengu_api_error', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error: errStr as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    status:
      status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    errorType:
      errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messageCount,
    messageTokens,
// 两个耗时：单次尝试的耗时 与 含重试的总耗时。
// 分开记录才能看出「重试花了多少时间」。
    durationMs,
    durationMsIncludingRetries,
    attempt,
// attempt：第几次尝试成功/失败的（1 表示第一次就失败）。
    provider: getAPIProviderForStatsig(),
    requestId:
      (requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ||
      undefined,
    ...(invocation
      ? {
          invokingRequestId:
            invocation.invokingRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          invocationKind:
            invocation.invocationKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    clientRequestId:
      (clientRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ||
      undefined,
// didFallBackToNonStreaming：是否从流式降级成了非流式（见 claude.ts）。
// 这个字段能帮我们统计「流式失败率」。
    didFallBackToNonStreaming,
    ...(promptCategory
      ? {
          promptCategory:
            promptCategory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(gateway
      ? {
          gateway:
            gateway as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    ...(querySource
      ? {
          querySource:
            querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    fastMode,
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...getAnthropicEnvMetadata(),
  })

  // Log API error event for OTLP
// 同时发一份到 OpenTelemetry（OTLP）。注意所有值都转成 String——
// OTel 的属性通常要求标量字符串。
// `void` 表示不等它完成（遥测是旁路，不能拖慢主流程）。
  void logOTelEvent('api_error', {
    model: model,
    error: errStr,
    status_code: String(status),
    duration_ms: String(durationMs),
    attempt: String(attempt),
    speed: fastMode ? 'fast' : 'normal',
  })

  // Pass the span to correctly match responses to requests when beta tracing is enabled
// 结束链路追踪的 span，并标记失败。传 llmSpan 是为了把「响应」和「请求」正确配对，
// 否则重试多次时 span 会错乱。
  endLLMRequestSpan(llmSpan, {
    success: false,
    statusCode: status ? parseInt(status) : undefined,
    error: errStr,
    attempt,
  })

  // Log first error for teleported sessions (reliability tracking)
// teleport（会话迁移）场景：如果是迁移过来的会话，记录它的第一条消息是否成功，
// 用于衡量迁移功能的可靠性。markFirstTeleportMessageLogged 保证只记一次。
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    logEvent('tengu_teleport_first_message_error', {
      session_id:
        teleportInfo.sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_type:
        errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    markFirstTeleportMessageLogged()
  }
}

// 【内部】拼装 tengu_api_success 事件。真正对外的入口是下面的 logAPISuccessAndDuration。
function logAPISuccess({
  model,
  preNormalizedModel,
  messageCount,
  messageTokens,
  usage,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  ttftMs,
  requestId,
  stopReason,
  costUSD,
  didFallBackToNonStreaming,
  querySource,
  gateway,
  queryTracking,
  permissionMode,
  globalCacheStrategy,
  textContentLength,
  thinkingContentLength,
  toolUseContentLengths,
  connectorTextBlockCount,
  fastMode,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  messageCount: number
  messageTokens: number
  usage: Usage
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  ttftMs: number | null
  requestId: string | null
  stopReason: BetaStopReason | null
  costUSD: number
  didFallBackToNonStreaming: boolean
  querySource: string
  gateway?: KnownGateway
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  globalCacheStrategy?: GlobalCacheStrategy
  textContentLength?: number
  thinkingContentLength?: number
  toolUseContentLengths?: Record<string, number>
  connectorTextBlockCount?: number
  fastMode?: boolean
  previousRequestId?: string | null
  betas?: string[]
}): void {
// 判断这次调用处于什么场景：非交互会话？压缩之后的第一条？带 -p/--print 参数？
// 这些维度对分析「不同用法下的表现」很重要。
  const isNonInteractiveSession = getIsNonInteractiveSession()
// consumePostCompaction()：同样是「取走即清空」的一次性标记，
// 表示「这条请求是压缩之后的第一次请求」。
  const isPostCompaction = consumePostCompaction()
  const hasPrintFlag =
    process.argv.includes('-p') || process.argv.includes('--print')

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
// 距上次 API 调用多久。这个数字对分析缓存命中率很关键——
// 间隔太久会导致服务端缓存 TTL 过期（见 promptCacheBreakDetection.ts）。
  const timeSinceLastApiCallMs =
    lastCompletion !== null ? now - lastCompletion : undefined

  const invocation = consumeInvokingRequestId()

// ★ 事件名 tengu_api_success —— 本文件的核心产物。
  logEvent('tengu_api_success', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
// preNormalizedModel：归一化**之前**的模型名。只有跟归一化后不同才上报，
// 用来分析「用户写的模型别名」都被解析成了什么。
    ...(preNormalizedModel !== model
      ? {
          preNormalizedModel:
            preNormalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(betas?.length
      ? {
          betas: betas.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    messageCount,
    messageTokens,
// ★★ usage 上报区 —— 这四行就是「钱花在哪」的全貌：
// inputTokens        = usage.input_tokens              本次新算的输入（全价）
    inputTokens: usage.input_tokens,
// outputTokens       = usage.output_tokens             模型输出（最贵，约输入 5 倍）
    outputTokens: usage.output_tokens,
// cachedInputTokens  = usage.cache_read_input_tokens   命中缓存、直接读出来的（最便宜，约 1/10）
//   ↑ 这个数越大越省钱。它占总输入的比例就是「缓存命中率」。
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
// uncachedInputTokens = usage.cache_creation_input_tokens  本次写入缓存的（约 1.25 倍，最贵）
//   ↑ 这个值突然变大，说明缓存刚刚失效、正在重建（配合 promptCacheBreakDetection 看）。
// 两个都用了 `?? 0`：某些 provider（bedrock/vertex/网关）不会返回这两个字段，兜 0 避免 NaN。
    uncachedInputTokens: usage.cache_creation_input_tokens ?? 0,
    durationMs: durationMs,
    durationMsIncludingRetries: durationMsIncludingRetries,
    attempt: attempt,
// ttftMs：Time To First Token，首字节延迟 —— 衡量「用户多久看到第一个字」，
// 是流式体验最关键的指标。
    ttftMs: ttftMs ?? undefined,
    buildAgeMins: getBuildAgeMinutes(),
    provider: getAPIProviderForStatsig(),
    requestId:
      (requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ??
      undefined,
    ...(invocation
      ? {
          invokingRequestId:
            invocation.invokingRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          invocationKind:
            invocation.invocationKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
// stop_reason：模型为什么停下（end_turn / max_tokens / tool_use / stop_sequence 等）。
// max_tokens 占比高说明输出经常被打断。
    stop_reason:
      (stopReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ??
      undefined,
// costUSD：本次调用折算的美元成本（由 cost-tracker 之类算出）。
    costUSD,
    didFallBackToNonStreaming,
    isNonInteractiveSession,
    print: hasPrintFlag,
// isTTY：输出是不是终端。`?? false` 兜底（某些环境没有这个属性）。
    isTTY: process.stdout.isTTY ?? false,
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(gateway
      ? {
          gateway:
            gateway as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    permissionMode:
      permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(globalCacheStrategy
      ? {
          globalCacheStrategy:
            globalCacheStrategy as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
// 下面几项统计「输出内容的构成」：文本多长、思考过程多长、
// 每个工具的入参多长、连接器文本块有几个。
// 注意用 `!== undefined` 判断而不是 falsy 判断 —— 因为 0 也是有意义的（长度为 0）。
    ...(textContentLength !== undefined
      ? ({
          textContentLength,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(thinkingContentLength !== undefined
      ? ({
          thinkingContentLength,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(toolUseContentLengths !== undefined
      ? ({
          toolUseContentLengths: jsonStringify(
            toolUseContentLengths,
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(connectorTextBlockCount !== undefined
      ? ({
          connectorTextBlockCount,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    fastMode,
    // Log cache_deleted_input_tokens for cache editing analysis. Casts needed
    // because the field is intentionally not on NonNullableUsage (excluded from
    // external builds). Set by updateUsage() when cache editing is active.
// ★ feature('CACHED_MICROCOMPACT')：编译期开关（≈ #ifdef），
// 打包时是 false 的话，这一整块会被删掉。
// cache_deleted_input_tokens 是 cache editing 功能的实验字段，
// 故意不在公开的 NonNullableUsage 类型里，所以要用双重断言才能访问。
    ...(feature('CACHED_MICROCOMPACT') &&
    ((usage as unknown as { cache_deleted_input_tokens?: number })
      .cache_deleted_input_tokens ?? 0) > 0
      ? {
          cacheDeletedInputTokens: (
            usage as unknown as { cache_deleted_input_tokens: number }
          ).cache_deleted_input_tokens,
        }
      : {}),
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(isPostCompaction ? { isPostCompaction } : {}),
    ...getAnthropicEnvMetadata(),
    timeSinceLastApiCallMs,
  })

// 记下本次完成时间，供下一次计算「距上次调用多久」。
  setLastApiCompletionTimestamp(now)
}

// ★【对外成功入口】请求成功之后由 claude.ts 调用。
// 它做四件事：①算耗时；②从响应消息里统计内容构成；③调 logAPISuccess 上报；
// ④发 OTel 事件 + 结束链路 span + 处理 teleport 埋点。
export function logAPISuccessAndDuration({
  model,
  preNormalizedModel,
  start,
  startIncludingRetries,
  ttftMs,
  usage,
  attempt,
  messageCount,
  messageTokens,
  requestId,
  stopReason,
  didFallBackToNonStreaming,
  querySource,
  headers,
  costUSD,
  queryTracking,
  permissionMode,
  newMessages,
  llmSpan,
  globalCacheStrategy,
  requestSetupMs,
  attemptStartTimes,
  fastMode,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  start: number
  startIncludingRetries: number
  ttftMs: number | null
  usage: NonNullableUsage
  attempt: number
  messageCount: number
  messageTokens: number
  requestId: string | null
  stopReason: BetaStopReason | null
  didFallBackToNonStreaming: boolean
  querySource: string
  headers?: globalThis.Headers
  costUSD: number
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  /** Assistant messages from the response - used to extract model_output and thinking_output
   *  when beta tracing is enabled */
  newMessages?: AssistantMessage[]
  /** The span from startLLMRequestSpan - pass this to correctly match responses to requests */
  llmSpan?: Span
  /** Strategy used for global prompt caching: 'tool_based', 'system_prompt', or 'none' */
  globalCacheStrategy?: GlobalCacheStrategy
  /** Time spent in pre-request setup before the successful attempt */
  requestSetupMs?: number
  /** Timestamps (Date.now()) of each attempt start — used for retry sub-spans in Perfetto */
  attemptStartTimes?: number[]
  fastMode?: boolean
  /** Request ID from the previous API call in this session */
  previousRequestId?: string | null
  betas?: string[]
}): void {
  const gateway = detectGateway({
    headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  let textContentLength: number | undefined
  let thinkingContentLength: number | undefined
  let toolUseContentLengths: Record<string, number> | undefined
  let connectorTextBlockCount: number | undefined

// 遍历新产生的 assistant 消息，统计各类内容块的长度。
  if (newMessages) {
    let textLen = 0
    let thinkingLen = 0
    let hasToolUse = false
    const toolLengths: Record<string, number> = {}
    let connectorCount = 0

    for (const msg of newMessages) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          textLen += block.text.length
// ★ feature('CONNECTOR_TEXT')：同样是编译期开关。
// 注意它放在 else-if 链的**前面**：因为连接器文本块也是一种 text 块，
// 要先判断是不是连接器块，否则会被上面的 text 分支吃掉。
        } else if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(block)) {
          connectorCount++
        } else if (block.type === 'thinking') {
          thinkingLen += block.thinking.length
        } else if (
          block.type === 'tool_use' ||
          block.type === 'server_tool_use' ||
          block.type === 'mcp_tool_use'
        ) {
          const inputLen = jsonStringify(block.input).length
// 工具名要脱敏再上报（避免把 MCP 工具名里的用户路径传上去）。
          const sanitizedName = sanitizeToolNameForAnalytics(block.name)
          toolLengths[sanitizedName] =
// `(toolLengths[name] ?? 0) + inputLen`：同一个工具可能被调多次，累加。
            (toolLengths[sanitizedName] ?? 0) + inputLen
          hasToolUse = true
        }
      }
    }

    textContentLength = textLen
// 长度为 0 时上报 undefined（而不是 0）——分析侧更好区分「没有」和「长度为 0」。
    thinkingContentLength = thinkingLen > 0 ? thinkingLen : undefined
    toolUseContentLengths = hasToolUse ? toolLengths : undefined
    connectorTextBlockCount = connectorCount > 0 ? connectorCount : undefined
  }

// 两个耗时：本次尝试的、以及含重试的（startIncludingRetries 是在第一次尝试前记录的）。
  const durationMs = Date.now() - start
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
// 累加到全局耗时统计（用于最终展示「总共花了多少时间」）。
  addToTotalDurationState(durationMsIncludingRetries, durationMs)

  logAPISuccess({
    model,
    preNormalizedModel,
    messageCount,
    messageTokens,
    usage,
    durationMs,
    durationMsIncludingRetries,
    attempt,
    ttftMs,
    requestId,
    stopReason,
    costUSD,
    didFallBackToNonStreaming,
    querySource,
    gateway,
    queryTracking,
    permissionMode,
    globalCacheStrategy,
    textContentLength,
    thinkingContentLength,
    toolUseContentLengths,
    connectorTextBlockCount,
    fastMode,
    previousRequestId,
    betas,
  })
  // Log API request event for OTLP
// 发一份 OTel 事件，把 token 用量和成本一并带上（同样全部转成 String）。
  void logOTelEvent('api_request', {
    model,
    input_tokens: String(usage.input_tokens),
    output_tokens: String(usage.output_tokens),
    cache_read_tokens: String(usage.cache_read_input_tokens),
    cache_creation_tokens: String(usage.cache_creation_input_tokens),
    cost_usd: String(costUSD),
    duration_ms: String(durationMs),
    speed: fastMode ? 'fast' : 'normal',
  })

  // Extract model output, thinking output, and tool call flag when beta tracing is enabled
  let modelOutput: string | undefined
  let thinkingOutput: string | undefined
  let hasToolCall: boolean | undefined

// 只有开启 beta tracing 才抽取模型输出内容（这是个昂贵操作，默认不做）。
  if (isBetaTracingEnabled() && newMessages) {
    // Model output - visible to all users
    modelOutput =
// ★ flatMap：把所有消息的 text 块收集出来，拼成一个字符串。
// 末尾 `|| undefined`：空字符串转成 undefined（不上报空值）。
      newMessages
        .flatMap(m =>
          m.message.content
            .filter(c => c.type === 'text')
            .map(c => (c as { type: 'text'; text: string }).text),
        )
        .join('\n') || undefined

    // Thinking output - Ant-only (build-time gated)
// thinking（思考过程）只对内部用户（USER_TYPE=ant）上报，外部构建里这段会被裁掉。
    if (process.env.USER_TYPE === 'ant') {
      thinkingOutput =
        newMessages
          .flatMap(m =>
            m.message.content
              .filter(c => c.type === 'thinking')
              .map(c => (c as { type: 'thinking'; thinking: string }).thinking),
          )
          .join('\n') || undefined
    }

    // Check if any tool_use blocks were in the output
// some ≈ anyMatch：只要任意一条消息里有 tool_use 就为 true。
    hasToolCall = newMessages.some(m =>
      m.message.content.some(c => c.type === 'tool_use'),
    )
  }

  // Pass the span to correctly match responses to requests when beta tracing is enabled
// 结束 span 并标记成功，把 token 用量写进 span（这样在 Perfetto 等工具里能直接看到）。
  endLLMRequestSpan(llmSpan, {
    success: true,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    attempt,
    modelOutput,
    thinkingOutput,
    hasToolCall,
    ttftMs: ttftMs ?? undefined,
    requestSetupMs,
    attemptStartTimes,
  })

  // Log first successful message for teleported sessions (reliability tracking)
// teleport 会话的第一条成功消息埋点（跟失败侧对应）。
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    logEvent('tengu_teleport_first_message_success', {
      session_id:
        teleportInfo.sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    markFirstTeleportMessageLogged()
  }
}
