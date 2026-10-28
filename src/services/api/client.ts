/**
 * 【一句话定位】★ API 客户端工厂：根据环境变量与登录态，造出一个能发请求的 Anthropic SDK client。
 *           支持四种后端：官方 Anthropic API / AWS Bedrock / Azure Foundry / GCP Vertex。
 *
 * 【在架构中的位置】（这是整个 api 层的“入口”，非常重要）
 *   调用链：src/query.ts（每次要发请求前）
 *           → 本文件 getAnthropicClient()
 *             → utils/auth.ts（checkAndRefreshOAuthTokenIfNeeded / getAnthropicApiKey /
 *                              getClaudeAIOAuthTokens / refreshAndGetAwsCredentials /
 *                              refreshGcpCredentialsIfNeeded / getApiKeyFromApiKeyHelper）
 *             → utils/model/providers.ts（getAPIProvider / isFirstPartyAnthropicBaseUrl）
 *             → utils/proxy.js（getProxyFetchOptions）
 *             → utils/envUtils.js（getAWSRegion / getVertexRegionForModel / isEnvTruthy）
 *             → 动态 import：@anthropic-ai/bedrock-sdk / foundry-sdk / vertex-sdk / @azure/identity
 *             → 本文件 buildFetch()（包装 fetch：注入 request id、打调试日志）
 *           → 造出的 client 交给 src/services/api/claude.ts 去发流式请求
 *
 * 【为什么要分四种后端】
 *   企业用户往往不能直连 api.anthropic.com，而要经由自己云厂商的托管服务
 *   （Bedrock/Vertex/Foundry）。它们的 URL、鉴权、region 规则都不同，
 *   所以这里用一个工厂函数统一收口，上层只管拿到一个 Anthropic 实例。
 *
 * 【本文件包含什么】
 *   - createStderrLogger()：SDK 内部日志重定向到 stderr（调试用）。
 *   - getAnthropicClient()：★ 主入口，造 client。
 *   - configureApiKeyHeaders()：非订阅者路径，补 Authorization 头。
 *   - getCustomHeaders()：解析 ANTHROPIC_CUSTOM_HEADERS 环境变量。
 *   - CLIENT_REQUEST_ID_HEADER：自定义请求 ID 头名。
 *   - buildFetch()：包装 fetch，注入 x-client-request-id。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `async function getAnthropicClient({ apiKey, maxRetries }: { apiKey?: string, maxRetries: number })`：
 *      ★ **参数解构 + 整体类型标注**。参数不是一个个列，而是直接解构一个对象，
 *      类型标注写在 `{...}` 后面。好处：调用方可以按名字传参、顺序无所谓、可省略。
 *      Java 类比：传一个 DTO/record 进来，然后在方法体里 getter。
 *   2. `apiKey?: string`：`?` 表示可选属性（可以传也可以不传）。
 *   3. `...(cond ? { k: v } : {})`：
 *      ★ **条件展开**。三元返回对象或空对象，展开后等于「条件成立时才加这个字段」。
 *      这是 TS 里「可选地往对象里塞字段」的惯用写法，比在外面 if 里赋值更简洁。
 *      Java 里只能先 new 出对象再 if (cond) put(k, v)。
 *   4. `as unknown as Anthropic`：★ **双重断言**。
 *      当两个类型差异太大（没有继承关系）时，TS 不允许直接 as；
 *      先断言成 unknown（万能中间态）再断言成目标类型，就能强行通过。
 *      注释里自嘲「we have always been lying about the return type」——
 *      Bedrock/Vertex 的 client 其实并不完全兼容 Anthropic（不支持 batching/models），
 *      但为了上层统一使用，只能骗一下编译器。
 *      ⚠️ as 不做运行时检查，这种「撒谎」是潜在风险，属于工程上的妥协。
 *   5. `ConstructorParameters<typeof AnthropicBedrock>[0]`：
 *      ★ **内置工具类型**。`typeof C` 取类/构造函数的类型，
 *      `ConstructorParameters<T>` 取出构造函数参数列表（元组），`[0]` 取第一个参数。
 *      效果：「AnthropicBedrock 的构造参数对象的类型」——不需要 SDK 额外导出这个类型。
 *      Java 里没有对应能力（要靠反射）。
 *   6. `const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')`：
 *      ★ **动态 import**。跟 Java 的 Class.forName 有点像，但这里是标准的 ES 特性：
 *      返回 Promise，可以 await。好处：只有真的要用 Bedrock 时才加载这个包
 *      （懒加载），避免所有用户启动时都要解析几十 MB 的 AWS SDK。
 *   7. `ClientOptions['fetch']`：索引访问类型——取 ClientOptions 里 fetch 字段的类型。
 *   8. `input instanceof Request ? input.url : String(input)`：
 *      instanceof 跟 Java 一样；三元运算符返回表达式的值。
 *      fetch 的第一个参数可能是 URL 对象、字符串、或 Request 对象，三种都要兼容。
 *   9. `new Headers(init?.headers)`：标准 Web API（浏览器和 Node 都有）。
 *      ≈ Java 的 HttpHeaders 集合类。
 *  10. `(msg, ...args) => console.error(...)`：`...args` 是**剩余参数**（可变参数），
 *      Java 的 `String... args`。调用时 `...args` 又变成**展开**。
 *      同一个 `...` 语法在两个位置含义相反，是初学者的常见困惑点。
 *  11. `Promise<T>` / `await`：≈ CompletableFuture<T> / .join()。
 *  12. `process.env.X`：环境变量，跟 Java 的 System.getenv 一样。TS 里它是 string | undefined。
 */
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { GoogleAuth } from 'google-auth-library'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import {
  getAWSRegion,
  getVertexRegionForModel,
  isEnvTruthy,
} from '../../utils/envUtils.js'

// ============ 下面这一大段是「环境变量说明书」============
// 这一段是给运维/使用者的文档，说明每种后端该配哪些环境变量。
// 值得注意的几点（中文摘要）：
//   · 直连 API：需要 ANTHROPIC_API_KEY
//   · Bedrock：需要 AWS 凭证 + region（默认 us-east-1）
//   · Foundry(Azure)：ANTHROPIC_FOUNDRY_RESOURCE 或 ANTHROPIC_FOUNDRY_BASE_URL，
//     没配 API key 时会走 Azure AD（DefaultAzureCredential）
//   · Vertex：需要 ANTHROPIC_VERTEX_PROJECT_ID + GCP 凭证，region 可按模型单独指定
// region 的优先级：模型专用环境变量 > CLOUD_ML_REGION > 配置默认值 > us-east5
/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 * - AWS_REGION or AWS_DEFAULT_REGION: Sets the AWS region for all models (default: us-east-1)
 * - ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: Optional. Override AWS region specifically for the small fast model (Haiku)
 *
 * Foundry (Azure):
 * - ANTHROPIC_FOUNDRY_RESOURCE: Your Azure resource name (e.g., 'my-resource')
 *   For the full endpoint: https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * - ANTHROPIC_FOUNDRY_BASE_URL: Optional. Alternative to resource - provide full base URL directly
 *   (e.g., 'https://my-resource.services.ai.azure.com')
 *
 * Authentication (one of the following):
 * - ANTHROPIC_FOUNDRY_API_KEY: Your Microsoft Foundry API key (if using API key auth)
 * - Azure AD authentication: If no API key is provided, uses DefaultAzureCredential
 *   which supports multiple auth methods (environment variables, managed identity,
 *   Azure CLI, etc.). See: https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU: Region for Claude 3.5 Haiku model
 *   - VERTEX_REGION_CLAUDE_HAIKU_4_5: Region for Claude Haiku 4.5 model
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET: Region for Claude 3.5 Sonnet model
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET: Region for Claude 3.7 Sonnet model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - ANTHROPIC_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
 */

// 把 SDK 内部的日志转打到 stderr。为什么不直接 console.error？
// 因为 stdout 是给程序输出（比如 `claude -p` 的机器可读结果）用的，
// 日志混进去会破坏解析，所以一律走 stderr。
function createStderrLogger(): ClientOptions['logger'] {
  return {
// 四个级别全用 console.error（而不是 console.log/warn/info），
// 目的同样是保证所有 SDK 日志都只出现在 stderr 上。
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

// ★ 主入口：造一个 Anthropic SDK client。
// 参数用的是「对象解构」——调用方写 getAnthropicClient({ maxRetries: 3, model: 'x' })，
// 不用记参数顺序，也能只传关心的那几个。
// 返回 Promise<Anthropic>：因为可能要 await 刷新 OAuth token、动态 import SDK。
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
// 从环境变量读「运行在哪类容器/远程会话里」，用于后端做灰度与排障。
  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
// 默认请求头。x-app=cli 让后端知道这是 CLI 而不是 Web/API。
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
// 展开顺序即优先级：customHeaders 可以覆盖前面的默认值，
// 后面几个条件展开的 header 优先级更高。
// `...(cond ? {k:v} : {})` 是「条件加字段」的惯用写法。
    ...customHeaders,
    ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
    ...(remoteSessionId
      ? { 'x-claude-remote-session-id': remoteSessionId }
      : {}),
// SDK 的接入方（比如把 Claude Code 嵌进自己产品的库）可以自报身份，后端做统计分析。
    // SDK consumers can identify their app/library for backend analytics
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // Log API client configuration for HFI debugging
// 调试日志。注意 `${!!process.env.X}`：双感叹号把「有没有值」转成布尔，
// 日志里只关心「配了没配」，不关心具体值（避免把密钥打进日志）。
  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // Add additional protection header if enabled via env var
// 额外的安全/合规保护开关，由环境变量启用。
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

// ★ 发请求之前先确保 OAuth token 没过期（必要时刷新）。
// 必须 await：否则可能在 token 过期的情况下把 client 造出来。
  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

// 非订阅用户（用 API key 的那批）走另一套认证：补 Authorization 头。
  if (!isClaudeAISubscriber()) {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }

// 包装 fetch：注入 request id、打日志。fetchOverride 是上层（比如 dumpPrompts）传进来的。
  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
// 默认超时 10 分钟（600 * 1000 ms）。为什么这么长？
// 因为一次长请求（大上下文 + 长输出）本身可能就好几分钟；
// 而流式请求会在收到第一个字节后持续推进，超时只针对「完全没响应」。
// parseInt(..., 10) 的第二个参数 10 是进制，必须写——不写会有前导 0 被当八进制的风险。
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
// dangerouslyAllowBrowser：允许在浏览器环境里跑（CLI 里其实是在 Node 里，
// 但打包成 bundle 后环境检测可能误判，所以显式打开）。
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
// 代理配置（企业网络常见）。as 断言是因为 SDK 的类型和本地工具函数类型不完全一致。
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
// ===== 分支一：AWS Bedrock =====
// isEnvTruthy 判断环境变量是否为真（'1'/'true'/'yes' 等都算）。
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    // Use region override for small fast model if specified
// 小模型（Haiku）可以单独指定 region：不同模型在不同 region 有不同配额/可用性。
    const awsRegion =
      model === getSmallFastModel() &&
      process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        : getAWSRegion()

// ConstructorParameters<typeof AnthropicBedrock>[0]：
// 直接取出「AnthropicBedrock 构造函数的第一个参数」的类型，
// 不需要 SDK 额外导出一个 Options 类型。这是 TS 类型编程的实用技巧。
    const bedrockArgs: ConstructorParameters<typeof AnthropicBedrock>[0] = {
      ...ARGS,
      awsRegion,
// 条件展开：SKIP_BEDROCK_AUTH 时才加 skipAuth 字段（测试/代理场景用）。
      ...(isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH) && {
        skipAuth: true,
      }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }

    // Add API key authentication if available
// Bedrock 也支持 API key（Bearer）方式：这时要跳过 SDK 自己的 AWS SigV4 签名。
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      bedrockArgs.skipAuth = true
      // Add the Bearer token for Bedrock API key authentication
      bedrockArgs.defaultHeaders = {
        ...bedrockArgs.defaultHeaders,
        Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
      }
// 否则走标准 AWS 凭证链：刷新并拿到临时凭证（accessKey/secret/sessionToken）。
// 之所以要「手动」传凭证，是因为要配合缓存清理（避免用过期凭证）。
    } else if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
      // Refresh auth and get credentials with cache clearing
      const cachedCredentials = await refreshAndGetAwsCredentials()
      if (cachedCredentials) {
        bedrockArgs.awsAccessKey = cachedCredentials.accessKeyId
        bedrockArgs.awsSecretKey = cachedCredentials.secretAccessKey
        bedrockArgs.awsSessionToken = cachedCredentials.sessionToken
      }
    }
    // we have always been lying about the return type - this doesn't support batching or models
// ★ `as unknown as Anthropic`：双重断言。Bedrock 的 client 跟 Anthropic 类型不兼容
// （不支持 batching / models 那些 API），但上层代码统一按 Anthropic 使用，
// 所以只能骗编译器。注释里那句「we have always been lying」就是在自嘲这件事。
    return new AnthropicBedrock(bedrockArgs) as unknown as Anthropic
  }
// ===== 分支二：Azure Foundry =====
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
    // Determine Azure AD token provider based on configuration
    // SDK reads ANTHROPIC_FOUNDRY_API_KEY by default
// azureADTokenProvider 的类型是「返回 Promise<string> 的函数」——
// 这是一个**函数类型标注**：(() => Promise<string>) | undefined。
// Java 类比：Supplier<CompletableFuture<String>>。
    let azureADTokenProvider: (() => Promise<string>) | undefined
// 没配 API key 才需要 Azure AD；否则 SDK 会自己读 ANTHROPIC_FOUNDRY_API_KEY。
    if (!process.env.ANTHROPIC_FOUNDRY_API_KEY) {
      if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
        // Mock token provider for testing/proxy scenarios (similar to Vertex mock GoogleAuth)
// 测试/代理场景：返回一个空 token 的假 provider（跳过真实认证）。
        azureADTokenProvider = () => Promise.resolve('')
      } else {
        // Use real Azure AD authentication with DefaultAzureCredential
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider,
        } = await import('@azure/identity')
// 真实场景：DefaultAzureCredential 是 Azure 官方的「凭证链」，
// 会依次尝试环境变量 / 托管身份 / Azure CLI 等多种方式。
// getBearerTokenProvider 把它包成一个「拿 token 的函数」，
// 这样 token 过期时 SDK 能自己重新取（而不是写死一个字符串）。
        azureADTokenProvider = getBearerTokenProvider(
          new AzureCredential(),
          'https://cognitiveservices.azure.com/.default',
        )
      }
    }

    const foundryArgs: ConstructorParameters<typeof AnthropicFoundry>[0] = {
      ...ARGS,
      ...(azureADTokenProvider && { azureADTokenProvider }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new AnthropicFoundry(foundryArgs) as unknown as Anthropic
  }
// ===== 分支三：GCP Vertex =====
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // Refresh GCP credentials if gcpAuthRefresh is configured and credentials are expired
    // This is similar to how we handle AWS credential refresh for Bedrock
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded()
    }

// ★ Promise.all 并行 import 两个包：省一半加载时间。
// 数组解构一次拿到两个模块命名空间对象。
    const [{ AnthropicVertex }, { GoogleAuth }] = await Promise.all([
      import('@anthropic-ai/vertex-sdk'),
      import('google-auth-library'),
    ])
// TODO（原注释保留）：目前每次调用都 new 一个 GoogleAuth，会重复走认证流程、
// 查询 metadata server。想缓存又要处理凭证刷新/环境变量变化/跨请求状态，比较棘手。
    // TODO: Cache either GoogleAuth instance or AuthClient to improve performance
    // Currently we create a new GoogleAuth instance for every getAnthropicClient() call
    // This could cause repeated authentication flows and metadata server checks
    // However, caching needs careful handling of:
    // - Credential refresh/expiration
    // - Environment variable changes (GOOGLE_APPLICATION_CREDENTIALS, project vars)
    // - Cross-request auth state management
    // See: https://github.com/googleapis/google-auth-library-nodejs/issues/390 for caching challenges

// ★ 这一段是本文件最长的注释，讲的是一个真实踩过的坑：
// google-auth-library 找不到 projectId 时会去查 GCE metadata server，
// 在非 GCP 环境（比如本地开发机）上会**卡 12 秒才超时**。
// 解决办法：只在用户确实没配任何 project 来源时，才用 ANTHROPIC_VERTEX_PROJECT_ID 兜底。
    // Prevent metadata server timeout by providing projectId as fallback
    // google-auth-library checks project ID in this order:
    // 1. Environment variables (GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT, etc.)
    // 2. Credential files (service account JSON, ADC file)
    // 3. gcloud config
    // 4. GCE metadata server (causes 12s timeout outside GCP)
    //
    // We only set projectId if user hasn't configured other discovery methods
    // to avoid interfering with their existing auth setup

    // Check project environment variables in same order as google-auth-library
    // See: https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts
// 按 google-auth-library 的查找顺序，逐个检查用户是否已经配了 project。
    const hasProjectEnvVar =
      process.env['GCLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['gcloud_project'] ||
      process.env['google_cloud_project']

    // Check for credential file paths (service account or ADC)
    // Note: We're checking both standard and lowercase variants to be safe,
    // though we should verify what google-auth-library actually checks
// 同时也检查凭证文件路径（大写与小写两种写法都查，防御不同系统习惯）。
    const hasKeyFile =
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
      process.env['google_application_credentials']

// 测试场景用假的 GoogleAuth（返回空 header），避免真的去走网络认证。
    const googleAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)
      ? ({
          // Mock GoogleAuth for testing/proxy scenarios
          getClient: () => ({
            getRequestHeaders: () => ({}),
          }),
        } as unknown as GoogleAuth)
      : new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          // Only use ANTHROPIC_VERTEX_PROJECT_ID as last resort fallback
          // This prevents the 12-second metadata server timeout when:
          // - No project env vars are set AND
          // - No credential keyfile is specified AND
          // - ADC file exists but lacks project_id field
          //
// 原注释指出一个风险：如果「认证用的 project」和「API 调用的 project」不是同一个，
// 可能导致计费/审计串到别的 project 上。缓解措施是让用户显式设 GOOGLE_CLOUD_PROJECT。
          // Risk: If auth project != API target project, this could cause billing/audit issues
          // Mitigation: Users can set GOOGLE_CLOUD_PROJECT to override
          ...(hasProjectEnvVar || hasKeyFile
            ? {}
            : {
                projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
              }),
        })

// Vertex 的 region 可以按模型单独指定（不同模型在不同 region 开放）。
    const vertexArgs: ConstructorParameters<typeof AnthropicVertex>[0] = {
      ...ARGS,
      region: getVertexRegionForModel(model),
      googleAuth,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new AnthropicVertex(vertexArgs) as unknown as Anthropic
  }

// ===== 分支四（默认）：官方 Anthropic API =====
  // Determine authentication method based on available tokens
  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
// 订阅用户用 OAuth token（authToken），非订阅用户用 apiKey（x-api-key）。
// 注意订阅用户这里 apiKey 传 null：SDK 看到 authToken 会改用 Bearer 认证。
    apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
    authToken: isClaudeAISubscriber()
      ? getClaudeAIOAuthTokens()?.accessToken
      : undefined,
    // Set baseURL from OAuth config when using staging OAuth
// 内部用户（USER_TYPE=ant）+ 开了 staging 开关时，把 baseURL 指向 staging 环境。
    ...(process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new Anthropic(clientConfig)
}

// 补 Authorization 头（Bearer token）。token 来源优先级：
// ①ANTHROPIC_AUTH_TOKEN 环境变量；②apiKeyHelper（外部命令/脚本动态取）。
async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

// 解析 ANTHROPIC_CUSTOM_HEADERS：允许用户自定义附加请求头（调试、网关鉴权等）。
function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // Split by newlines to support multiple headers
// 支持用换行分隔多个 header（用正则 /\n|\r\n/ 兼容 Windows 换行）。
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

// ★ 为什么用 indexOf(':') 手动切，而不是 split(':') 或正则？
// 原注释说明：避免正则回溯（malformed 的长 header 行可能导致灾难性回溯，
// 即 ReDoS）。而且 header value 里本来就可能含冒号（比如时间 12:30），
// 只按**第一个**冒号切才是对的。这是很典型的安全编码细节。
    // Parse header in format "Name: Value" (curl style). Split on first `:`
    // then trim — avoids regex backtracking on malformed long header lines.
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

// 自定义请求 ID 头名，导出给其它模块复用。
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

// ★ 包装 fetch 的经典示例（装饰器模式）：
// 拿一个原始 fetch（可能是上层传来的 override，也可能是全局 fetch），
// 返回一个签名相同的新函数，在调用前后加点料。
function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
// `fetchOverride ?? globalThis.fetch`：没传就用全局的。
  const inner = fetchOverride ?? globalThis.fetch
  // Only send to the first-party API — Bedrock/Vertex/Foundry don't log it
// ★ 只给第一方的 Anthropic API 注入这个头。原因（原注释）：
// ① Bedrock/Vertex/Foundry 不会记录它，加了没用；
// ② 严格的企业代理可能会**拒绝**未知请求头（inc-4029 那类线上事故）。
// 教训：给第三方网关发请求时，别随便加自定义头。
  // and unknown headers risk rejection by strict proxies (inc-4029 class).
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
// ★ 为什么要客户端自己生成 request id？
// 因为**超时**的请求根本拿不到服务端返回的 request id，排查时无从下手。
// 有了客户端 id，就能拿它去服务端日志里关联。
// `!headers.has(...)` 表示：调用方如果已经自己设了，就不要覆盖。
    // Generate a client-side request ID so timeouts (which return no server
    // request ID) can still be correlated with server logs by the API team.
    // Callers that want to track the ID themselves can pre-set the header.
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
// input 可能是 Request 对象 / URL / 字符串，三种都要能拿到 url 字符串。
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
// 日志这块整体 try/catch：绝不能因为打日志把 fetch 搞崩（原注释明说）。
    } catch {
      // never let logging crash the fetch
    }
// `{ ...init, headers }`：复制原 init 但**替换** headers（放后面所以覆盖）。
// 注意这里把改过的 headers 传进去，原始 init 没被改动（不可变更新）。
    return inner(input, { ...init, headers })
  }
}
