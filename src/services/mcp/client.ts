/**
 * 【一句话定位】MCP 客户端核心：负责「连上」一个 MCP server，并把 server 暴露的 tool / prompt / resource
 *               翻译成 Claude Code 内部能直接交给模型的 Tool / Command 对象；同时负责调用、超时、
 *               断线重连与进程退出时的清理。整个目录里最重要、最长的一个文件。
 *
 * 【在架构中的位置】
 *   上游调用方：
 *     - src/services/mcp/useManageMCPConnections.ts —— REPL 里管理 MCP 连接状态的 React hook
 *     - src/main.tsx / src/print.ts —— 启动时批量建立所有 MCP 连接
 *     - src/services/mcp/MCPConnectionManager.tsx —— 界面上展示连接状态
 *     - 工具执行主循环 —— 通过每个 MCP tool 上的 call() 回调重新回到本文件
 *   下游依赖：
 *     - @modelcontextprotocol/sdk —— 官方 SDK，提供 Client 和各种 Transport（stdio / SSE / HTTP / WS）
 *     - ./config.ts —— 读取 MCP server 配置（local / project / user 三种作用域）
 *     - ./auth.ts —— 远程 server 的 OAuth 授权（ClaudeAuthProvider）
 *     - ./elicitationHandler.ts、./channelNotification.ts —— server 反向向用户提问 / 推送消息
 *     - ./headersHelper.ts、./envExpansion.ts、./normalization.ts、./mcpStringUtils.ts —— 头部、环境变量、名字规范化
 *   调用链示例：
 *     main.tsx
 *       → getMcpToolsCommandsAndResources()   （并发连接所有 server）
 *       → connectToServer()                   （按 type 选 transport，连上，注册回调）
 *       → fetchToolsForClient()               （拉 tools/list）
 *       → buildMcpToolName()                  （拼出 mcp__<server>__<tool>）
 *       → Tool 对象                            （交给模型）
 *     模型调用该 tool
 *       → tool.call()                          （本文件在 fetchToolsForClient 里塞进去的闭包）
 *       → ensureConnectedClient()              （确保连接还活着，断了就重建）
 *       → callMCPToolWithUrlElicitationRetry() → callMCPTool()
 *       → client.request({ method: 'tools/call' })
 *       → processMCPResult()                   （把返回值规范成模型能读的内容块）
 *
 * 【本文件包含什么】
 *   1. connectToServer() —— 本文件最大的函数：选 transport、连上、注册回调、封装成 MCPServerConnection
 *   2. ensureConnectedClient() —— 每次真正调用前确认连接仍有效（断线就重建）
 *   3. fetchToolsForClient() —— 拉 tools/list，并把 MCP tool 转成内部 Tool（**重点，见函数内注释**）
 *   4. fetchResourcesForClient() / fetchCommandsForClient() —— 拉 resources/list、prompts/list
 *   5. getMcpToolsCommandsAndResources() —— 启动时并发连接所有 server；prefetchAllMcpResources() 是它的 Promise 包装
 *   6. reconnectMcpServerImpl() —— /mcp 界面里「重连」按钮背后的实现
 *   7. callMCPTool() / callMCPToolWithUrlElicitationRetry() —— 真正发 tools/call，处理超时、401、URL 引导
 *   8. transformMCPResult() / processMCPResult() / transformResultContent() —— 返回值规范化
 *   9. clearServerCache() / clearMcpAuthCache() / getServerCacheKey() —— 缓存管理
 *  10. McpAuthError / McpSessionExpiredError / McpToolCallError_* —— 三种自定义异常
 *  11. setupSdkMcpClients() —— SDK 内部 server（跑在本进程里）的连接入口
 *
 * 【TS 语法速查】（只列本文件真实用到的，全部给 Java 对照）
 *   - `type X = A | B`：联合类型，≈ Java 的 sealed interface；用 `x.type === 'a'` 缩小类型（判别联合）
 *   - `x?.y`：可选链，≈ `if (x != null) x.y()`；`x ?? d` 空值合并，≈ `x != null ? x : d`
 *     （注意与 `||` 的区别：0 和空字符串不会被 ?? 替换，但会被 || 替换）
 *   - `x!`：非空断言，≈ 强制类型转换，告诉编译器「我保证不是 null/undefined」，运行时不检查
 *   - `as X` / `as const`：类型断言 ≈ Java 强转；`as const` 把字面量锁成最窄的字面量类型
 *   - `(x: T): R => {}`：箭头函数 ≈ Java lambda；`async () => {}` ≈ 返回 CompletableFuture 的 lambda
 *   - `memoize(fn, keyFn)` / `memoizeWithLRU(fn, keyFn, size)`：给异步函数加缓存，
 *     ≈ Guava Cache / Caffeine 的 cache.get(key, loader)
 *   - `feature('X') ? A : B`：**编译期**开关（来自 bun:bundle），打包时求值并内联，不是运行期 if
 *   - `Promise.race([a, b])` ≈ CompletableFuture.anyOf；`Promise.allSettled` ≈ 全部执行完但不抛异常
 *   - `new Promise<never>((_, reject) => { ... })`：把「回调 / 定时器」桥接成 await，
 *     ≈ Java 里手动 new CompletableFuture 再 completeExceptionally
 *   - `await import('...')`：动态导入 ≈ Java 反射式懒加载，避免启动时把重型依赖拖进来
 *   - `Record<string, V>` ≈ Map<String, V>；`Partial<T>` ≈ 所有字段可选的 DTO；`unknown` ≈ Object 但必须先校验
 *   - 类型标注写在**变量名后面**（`const a: string`），Java 写在前面 —— 这是最容易看错的地方
 *   - `for (let i = 0; ; i++)`：中间的条件位置是空的，即**无条件无限循环**，靠内部 return/break 退出
 */
import { feature } from 'bun:bundle'
import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createFetchWithInit,
  type FetchLike,
  type Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  type ElicitRequestURLParams,
  type ElicitResult,
  ErrorCode,
  type JSONRPCMessage,
  type ListPromptsResult,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListRootsRequestSchema,
  type ListToolsResult,
  ListToolsResultSchema,
  McpError,
  type PromptMessage,
  type ResourceLink,
} from '@modelcontextprotocol/sdk/types.js'
import mapValues from 'lodash-es/mapValues.js'
import memoize from 'lodash-es/memoize.js'
import zipObject from 'lodash-es/zipObject.js'
import pMap from 'p-map'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { PRODUCT_URL } from '../../constants/product.js'
import type { AppState } from '../../state/AppState.js'
import {
  type Tool,
  type ToolCallProgress,
  toolMatchesName,
} from '../../Tool.js'
import { ListMcpResourcesTool } from '../../tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { type MCPProgress, MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { createMcpAuthTool } from '../../tools/McpAuthTool/McpAuthTool.js'
import { ReadMcpResourceTool } from '../../tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { createAbortController } from '../../utils/abortController.js'
import { count } from '../../utils/array.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { detectCodeIndexingFromMcpServerName } from '../../utils/codeIndexing.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import {
  errorMessage,
  TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../utils/errors.js'
import { getMCPUserAgent } from '../../utils/http.js'
import { maybeNotifyIDEConnected } from '../../utils/ide.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import {
  getBinaryBlobSavedMessage,
  getFormatDescription,
  getLargeOutputInstructions,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import {
  getContentSizeEstimate,
  type MCPToolResult,
  mcpContentNeedsTruncation,
  truncateMcpContentIfNeeded,
} from '../../utils/mcpValidation.js'
import { WebSocketTransport } from '../../utils/mcpWebSocketTransport.js'
import { memoizeWithLRU } from '../../utils/memoize.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import {
  getProxyFetchOptions,
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from '../../utils/proxy.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import {
  isPersistError,
  persistToolResult,
} from '../../utils/toolResultStorage.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type ElicitationWaitingState,
  runElicitationHooks,
  runElicitationResultHooks,
} from './elicitationHandler.js'
import { buildMcpToolName } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import { getLoggingSafeMcpBaseUrl } from './utils.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? (
      require('../../skills/mcpSkills.js') as typeof import('../../skills/mcpSkills.js')
    ).fetchMcpSkillsForClient
  : null

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { AssistantMessage } from 'src/types/message.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { classifyMcpToolForCollapse } from '../../tools/MCPTool/classifyForCollapse.js'
import { clearKeychainCache } from '../../utils/secureStorage/macOsKeychainHelpers.js'
import { sleep } from '../../utils/sleep.js'
import {
  ClaudeAuthProvider,
  hasMcpDiscoveryButNoToken,
  wrapFetchWithStepUpDetection,
} from './auth.js'
import { markClaudeAiMcpConnected } from './claudeai.js'
import { getAllMcpConfigs, isMcpServerDisabled } from './config.js'
import { getMcpServerHeaders } from './headersHelper.js'
import { SdkControlClientTransport } from './SdkControlTransport.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'

/**
 * 【中文补充】McpAuthError：MCP 工具调用因「认证失效」失败时抛出（典型场景：OAuth token 过期，server 回 401）。
 * 为什么要单独定义：上层工具执行层需要区分「认证问题」和「工具本身报错」——
 *   认证问题 → 把该 server 的连接状态改成 needs-auth，引导用户重新授权；
 *   工具报错 → 直接把错误文本回给模型。
 * Java 对照：≈ 自定义 RuntimeException 子类，靠 catch(McpAuthError e) 做分支处理。
 * 注意构造函数里手写了 `this.name = 'McpAuthError'`：JS 的 Error 不会自动带上子类名，
 *   想让日志里能看到类型名必须自己赋值（Java 里 getClass().getSimpleName() 是自动就有的）。
 */
/**
 * Custom error class to indicate that an MCP tool call failed due to
 * authentication issues (e.g., expired OAuth token returning 401).
 * This error should be caught at the tool execution layer to update
 * the client's status to 'needs-auth'.
 */
export class McpAuthError extends Error {
  serverName: string
  constructor(serverName: string, message: string) {
    super(message)
    this.name = 'McpAuthError'
    this.serverName = serverName
  }
}

/**
 * 【中文补充】McpSessionExpiredError：server 端的 session（会话）过期时抛出。
 * 背景：Streamable HTTP 这种传输是**有状态**的——首次连接时 server 下发一个 session id，之后每个请求都要带上；
 *   如果 server 重启或超时回收了这个 session，请求就会失败，此时单纯重试没有意义，必须**重新连接**。
 * 约定：抛出方同时清掉连接缓存；调用方用 ensureConnectedClient() 拿到新连接后整体重试一次。
 * 这个类没有 export，是本文件内部专用（≈ Java 的 private static 内部类）。
 */
/**
 * Thrown when an MCP session has expired and the connection cache has been cleared.
 * The caller should get a fresh client via ensureConnectedClient and retry.
 */
class McpSessionExpiredError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" session expired`)
    this.name = 'McpSessionExpiredError'
  }
}

/**
 * 【中文补充】McpToolCallError：MCP 工具返回 `isError: true` 时抛出。
 * 为什么要额外带一个 mcpMeta 字段：按 MCP 规范，`_meta` 挂在基础 Result 上，**错误结果里也是合法的**，
 *   里面可能装着 SDK 调用方需要的追踪信息，不能因为「这是错误」就丢掉。
 * 类名后缀 _I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS 是仓库约定：表示「里面的字符串已人工确认不含代码/文件路径」，
 *   允许进遥测日志（≈ Java 里一个 @TelemetrySafe 标记接口）。
 * `readonly mcpMeta?` 写在构造签名里是 TS 的「构造参数属性」简写：自动变成同名字段，
 *   ≈ Java 的 `private final X mcpMeta;` 加构造函数赋值，一行搞定。
 */
/**
 * Thrown when an MCP tool returns `isError: true`. Carries the result's `_meta`
 * so SDK consumers can still receive it — per the MCP spec, `_meta` is on the
 * base Result type and is valid on error results.
 */
export class McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  constructor(
    message: string,
    telemetryMessage: string,
    readonly mcpMeta?: { _meta?: Record<string, unknown> },
  ) {
    super(message, telemetryMessage)
    this.name = 'McpToolCallError'
  }
}

/**
 * 【中文补充】判断一个 Error 是不是 MCP 的「session 不存在」错误。
 * 为什么要同时看两个信号（HTTP 404 + JSON-RPC code -32001）：
 *   只看 404 会误判 —— URL 写错、服务下线也会返回 404；
 *   只看 code 又拿不到 —— code 藏在响应体文本里，不是结构化字段。
 *   两个都对上才认定「session 过期」，避免把普通 404 当成可重试的 session 失效。
 * @param error 捕获到的异常（签名要求是 Error，调用前需自己先确认类型）
 * @returns true 表示这是 session 过期，调用方应当重连后再重试
 * TS 语法：`'code' in error` 用 in 运算符判断属性是否存在（≈ Java 的反射字段检查）；
 *   `(error as Error & { code?: number })` 是类型断言（≈ 强转），把运行时多出来的字段「告诉」编译器。
 */
/**
 * Detects whether an error is an MCP "Session not found" error (HTTP 404 + JSON-RPC code -32001).
 * Per the MCP spec, servers return 404 when a session ID is no longer valid.
 * We check both signals to avoid false positives from generic 404s (wrong URL, server gone, etc.).
 */
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus =
    'code' in error ? (error as Error & { code?: number }).code : undefined
  if (httpStatus !== 404) {
    return false
  }
  // The SDK embeds the response body text in the error message.
  // MCP servers return: {"error":{"code":-32001,"message":"Session not found"},...}
  // Check for the JSON-RPC error code to distinguish from generic web server 404s.
  return (
    error.message.includes('"code":-32001') ||
    error.message.includes('"code": -32001')
  )
}

/**
 * 【中文补充】MCP 工具调用的默认超时：1 亿毫秒 ≈ 27.8 小时，约等于「不超时」。
 * 为什么默认这么夸张：MCP server 干什么的都有（跑测试、拉大型索引、等人工审批），
 *   设一个「看起来合理」的超时反而会打断正常长任务；真正的中断交给用户 Ctrl-C / abortController。
 * `100_000_000` 里的下划线是**数字分隔符**，只为好读，等价于 100000000（Java 7+ 也支持这个写法）。
 */
/**
 * Default timeout for MCP tool calls (effectively infinite - ~27.8 hours).
 */
const DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000

/**
 * 【中文补充】工具描述 / server 指令（instructions）发给模型前的长度上限：2048 字符。
 * 背景：由 OpenAPI 自动生成的 MCP server 会把 15~60KB 的接口文档整个塞进 tool.description，
 *   全量送进上下文会挤爆 prompt；截掉尾部在绝大多数场景下不影响模型理解这个工具是干什么的。
 */
/**
 * Cap on MCP tool descriptions and server instructions sent to the model.
 * OpenAPI-generated MCP servers have been observed dumping 15-60KB of endpoint
 * docs into tool.description; this caps the p95 tail without losing the intent.
 */
const MAX_MCP_DESCRIPTION_LENGTH = 2048

/**
 * 【中文补充】读取 MCP 工具调用超时：优先用环境变量 MCP_TOOL_TIMEOUT，没配就用上面的默认值。
 * 为什么留这个口子：CI / 自动化测试里不能真等 27 小时，靠环境变量把超时压到几秒。
 * JS 坑点：`parseInt(...) || 默认值` 是常见写法 —— parseInt 失败返回 NaN，而 NaN 是 falsy，所以 || 能兜底；
 *   这里**不能**换成 `??`，因为 ?? 只在 null/undefined 时兜底，NaN 会直接漏过去。
 */
/**
 * Gets the timeout for MCP tool calls in milliseconds.
 * Uses MCP_TOOL_TIMEOUT environment variable if set, otherwise defaults to ~27.8 hours.
 */
function getMcpToolTimeoutMs(): number {
  return (
    parseInt(process.env.MCP_TOOL_TIMEOUT || '', 10) ||
    DEFAULT_MCP_TOOL_TIMEOUT_MS
  )
}

// 【中文补充】下面这几个声明故意写在文件中段而不是顶部：它们都是「惰性加载」的重型依赖
// （会连带拉起 React/ink 或原生模块），只有真的连上了对应 MCP server 才会被用到。
// TS/JS 里 `import x from 'y'` 可以出现在文件任意位置（会被提升），但 `require(...)` 是**运行时**调用，
// 写在箭头函数体里才能真正做到「用到才加载」—— ≈ Java 的 Class.forName() 延迟初始化。
import { isClaudeInChromeMCPServer } from '../../utils/claudeInChrome/common.js'

// Lazy: toolRendering.tsx pulls React/ink; only needed when Claude-in-Chrome MCP server is connected
/* eslint-disable @typescript-eslint/no-require-imports */
const claudeInChromeToolRendering =
  (): typeof import('../../utils/claudeInChrome/toolRendering.js') =>
    require('../../utils/claudeInChrome/toolRendering.js')
// Lazy: wrapper.tsx → hostAdapter.ts → executor.ts pulls both native modules
// (@ant/computer-use-input + @ant/computer-use-swift). Runtime-gated by
// GrowthBook tengu_malort_pedway (see gates.ts).
const computerUseWrapper = feature('CHICAGO_MCP')
  ? (): typeof import('../../utils/computerUse/wrapper.js') =>
      require('../../utils/computerUse/wrapper.js')
  : undefined
const isComputerUseMCPServer = feature('CHICAGO_MCP')
  ? (
      require('../../utils/computerUse/common.js') as typeof import('../../utils/computerUse/common.js')
    ).isComputerUseMCPServer
  : undefined
// 【中文补充】上面几个常量都用 `feature('CHICAGO_MCP') ? ... : undefined` 的形式：
// feature() 是 **编译期**开关（打包时求值并内联），不是运行期的 if ——
//   未开启时整段代码会被从产物里删掉，连 require 都不留，因此不会把原生模块拖进包体。
//   Java 里最接近的对照是 C 的 #ifdef / Maven 资源过滤，而不是运行期读配置。
// 另外后面会有 `isComputerUseMCPServer!(name)` 这种写法，末尾的 `!` 是**非空断言**：
//   告诉编译器「我保证这里不是 undefined」，≈ Java 的强制类型转换，运行时不做任何检查，赌错了就是 NPE。

import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

// 【中文补充】「刚刚 401 过」这件事的记忆时长：15 分钟。
// 目的：某个远程 server 返回 401（需要授权）后，短期内别每次启动都去重试一遍 ——
//   每次重试都是一次网络往返 + OAuth 服务发现，批量启动时很浪费。
// 记在磁盘文件里（Claude 配置目录下的 mcp-needs-auth-cache.json），所以**进程重启后仍然有效**；
// 用户跑一次 /mcp 完成授权就会清掉这条记录。
const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000 // 15 min

// 【中文补充】缓存的数据结构：server 名 → { 时间戳 }。
// `Record<string, { timestamp: number }>` ≈ Java 的 Map<String, Pojo>，Pojo 里只有一个 long timestamp 字段。
// 只记时间戳、不记 token：这里记的是「**失败过**」这件事本身，不是凭证，避免往磁盘写敏感信息。
type McpAuthCacheData = Record<string, { timestamp: number }>

/**
 * 【中文补充】缓存文件放在 Claude 的配置目录下（~/.claude），因此跨进程、跨会话都能共享。
 */
function getMcpAuthCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'mcp-needs-auth-cache.json')
}

// 【中文补充】整份缓存只在内存里读一次（memoize），避免批量连接时 N 个 server 各读一遍同一个文件；
// 写入或清空时把它置回 null，下次读取自然重新去磁盘拿最新内容。
// 这里没用 lodash 的 memoize：那个只能「按 key 删除」，而我们需要的是「整体作废」。
// Memoized so N concurrent isMcpAuthCached() calls during batched connection
// share a single file read instead of N reads of the same file. Invalidated
// on write (setMcpAuthCacheEntry) and clear (clearMcpAuthCache). Not using
// lodash memoize because we need to null out the cache, not delete by key.
let authCachePromise: Promise<McpAuthCacheData> | null = null

function getMcpAuthCache(): Promise<McpAuthCacheData> {
  if (!authCachePromise) {
    authCachePromise = readFile(getMcpAuthCachePath(), 'utf-8')
      .then(data => jsonParse(data) as McpAuthCacheData)
      .catch(() => ({}))
  }
  return authCachePromise
}

/**
 * 【中文补充】判断某个 server 是否「最近刚 401 过」，是的话本次启动就跳过连接、直接标成 needs-auth。
 * @param serverId MCP server 名
 * @returns true 表示 15 分钟内刚失败过，应跳过连接
 */
async function isMcpAuthCached(serverId: string): Promise<boolean> {
  const cache = await getMcpAuthCache()
  const entry = cache[serverId]
  if (!entry) {
    return false
  }
  return Date.now() - entry.timestamp < MCP_AUTH_CACHE_TTL_MS
}

// 【中文补充】所有写缓存的操作串到同一条 Promise 链上（`writeChain = writeChain.then(...)`）。
// 目的：同一批连接里多个 server 同时 401，如果各自「读文件 → 改 → 写文件」，后写的会覆盖先写的（丢更新）。
// 串成一条链后写操作天然串行，≈ Java 里用单线程 ExecutorService 串行提交写任务，或加 synchronized。
// Serialize cache writes through a promise chain to prevent concurrent
// read-modify-write races when multiple servers return 401 in the same batch
let writeChain = Promise.resolve()

function setMcpAuthCacheEntry(serverId: string): void {
  writeChain = writeChain
    .then(async () => {
      const cache = await getMcpAuthCache()
      cache[serverId] = { timestamp: Date.now() }
      const cachePath = getMcpAuthCachePath()
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, jsonStringify(cache))
      // Invalidate the read cache so subsequent reads see the new entry.
      // Safe because writeChain serializes writes: the next write's
      // getMcpAuthCache() call will re-read the file with this entry present.
      authCachePromise = null
    })
    .catch(() => {
      // Best-effort cache write
    })
}

/**
 * 【中文补充】清空「401 记忆」：用户完成授权（跑完 /mcp 的 OAuth 流程）后调用，
 * 让下一次连接尝试不再被 15 分钟的跳过逻辑拦住。
 */
export function clearMcpAuthCache(): void {
  authCachePromise = null
  void unlink(getMcpAuthCachePath()).catch(() => {
    // Cache file may not exist
  })
}

/**
 * 【中文补充】给遥测事件补一个字段：server 的 base URL（已去掉 query 参数，确保可以安全打日志）。
 * 为什么单独抽成函数：原来是一句内联三元表达式，会把取 URL 的函数调用两次；抽出来只调一次。
 * 返回值写成 `{ mcpServerBaseUrl?: ... }` 是为了能直接用 `...` 展开进事件对象
 *   （≈ Java 里把一个只有 0~1 项的 Map putAll 进另一个 Map）。
 */
/**
 * Spread-ready analytics field for the server's base URL. Calls
 * getLoggingSafeMcpBaseUrl once (not twice like the inline ternary it replaces).
 * Typed as AnalyticsMetadata since the URL is query-stripped and safe to log.
 */
function mcpBaseUrlAnalytics(serverRef: ScopedMcpServerConfig): {
  mcpServerBaseUrl?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
} {
  const url = getLoggingSafeMcpBaseUrl(serverRef)
  return url
    ? {
        mcpServerBaseUrl:
          url as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }
    : {}
}

/**
 * 【中文补充】连接阶段遇到 401 的统一收口（sse / http / claudeai-proxy 三种远程传输共用）：
 *   ① 打一个 tengu_mcp_server_needs_auth 遥测事件；
 *   ② 往磁盘缓存里记一笔「这个 server 刚 401」；
 *   ③ 返回一个 `type: 'needs-auth'` 的连接结果 —— 注意**这不是异常**，而是合法的连接状态之一，
 *      UI 会显示成「需要授权」并给用户一个去授权的入口。
 * @param name server 名
 * @param serverRef server 配置
 * @param transportType 哪种传输出的错（只影响日志里的展示文案）
 * @returns 一个 needs-auth 状态的 MCPServerConnection
 */
/**
 * Shared handler for sse/http/claudeai-proxy auth failures during connect:
 * emits tengu_mcp_server_needs_auth, caches the needs-auth entry, and returns
 * the needs-auth connection result.
 */
function handleRemoteAuthFailure(
  name: string,
  serverRef: ScopedMcpServerConfig,
  transportType: 'sse' | 'http' | 'claudeai-proxy',
): MCPServerConnection {
  logEvent('tengu_mcp_server_needs_auth', {
    transportType:
      transportType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...mcpBaseUrlAnalytics(serverRef),
  })
  const label: Record<typeof transportType, string> = {
    sse: 'SSE',
    http: 'HTTP',
    'claudeai-proxy': 'claude.ai proxy',
  }
  logMCPDebug(
    name,
    `Authentication required for ${label[transportType]} server`,
  )
  setMcpAuthCacheEntry(name)
  return { name, type: 'needs-auth', config: serverRef }
}

/**
 * 【中文补充】给 claude.ai 代理类型的 MCP server 包一层 fetch：
 *   ① 每个请求自动带上 OAuth Bearer token；
 *   ② 遇到 401 时尝试强制刷新 token，**只有 token 真的变了**才重试一次。
 * 为什么要「只有 token 变了才重试」：很多 connector 本来就需要用户授权，盲目重试会让每个 server 多花一次往返；
 *   判断依据是「本次发出去的 token」和「刷新后的 token」是否不同，而不是再看一次 keychain（并发下会被别的连接改掉）。
 * 返回类型 FetchLike 是一个 `(url, init) => Promise<Response>` 的函数类型，
 *   ≈ Java 的函数式接口，可以替换掉全局 fetch 做拦截（类似 OkHttp Interceptor / Servlet Filter）。
 */
/**
 * Fetch wrapper for claude.ai proxy connections. Attaches the OAuth bearer
 * token and retries once on 401 via handleOAuth401Error (force-refresh).
 *
 * The Anthropic API path has this retry (withRetry.ts, grove.ts) to handle
 * memoize-cache staleness and clock drift. Without the same here, a single
 * stale token mass-401s every claude.ai connector and sticks them all in the
 * 15-min needs-auth cache.
 */
export function createClaudeAiProxyFetch(innerFetch: FetchLike): FetchLike {
  return async (url, init) => {
    const doRequest = async () => {
      await checkAndRefreshOAuthTokenIfNeeded()
      const currentTokens = getClaudeAIOAuthTokens()
      if (!currentTokens) {
        throw new Error('No claude.ai OAuth token available')
      }
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${currentTokens.accessToken}`)
      const response = await innerFetch(url, { ...init, headers })
      // Return the exact token that was sent. Reading getClaudeAIOAuthTokens()
      // again after the request is wrong under concurrent 401s: another
      // connector's handleOAuth401Error clears the memoize cache, so we'd read
      // the NEW token from keychain, pass it to handleOAuth401Error, which
      // finds same-as-keychain → returns false → skips retry. Same pattern as
      // bridgeApi.ts withOAuthRetry (token passed as fn param).
      return { response, sentToken: currentTokens.accessToken }
    }

    const { response, sentToken } = await doRequest()
    if (response.status !== 401) {
      return response
    }
    // handleOAuth401Error returns true only if the token actually changed
    // (keychain had a newer one, or force-refresh succeeded). Gate retry on
    // that — otherwise we double round-trip time for every connector whose
    // downstream service genuinely needs auth (the common case: 30+ servers
    // with "MCP server requires authentication but no OAuth token configured").
    const tokenChanged = await handleOAuth401Error(sentToken).catch(() => false)
    logEvent('tengu_mcp_claudeai_proxy_401', {
      tokenChanged:
        tokenChanged as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (!tokenChanged) {
      // ELOCKED contention: another connector may have won the lockfile and refreshed — check if token changed underneath us
      const now = getClaudeAIOAuthTokens()?.accessToken
      if (!now || now === sentToken) {
        return response
      }
    }
    try {
      return (await doRequest()).response
    } catch {
      // Retry itself failed (network error). Return the original 401 so the
      // outer handler can classify it.
      return response
    }
  }
}

// 【中文补充】只声明 ws 实例上我们真正会用到的三个成员（readyState / close / send）。
// 这体现了 TS 的**结构化类型**（structural typing）：只要一个对象「长得像」这个类型就算匹配，
//   不需要它真的 implements 该接口 —— ≈ Java 接口的鸭子类型版，没有 implements 关键字。
// 好处：底层用 node 的 ws 包还是 Bun 的 shim，都能塞进来。
// Minimal interface for WebSocket instances passed to mcpWebSocketTransport
type WsClientLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

/**
 * 【中文补充】创建一个 WebSocket 客户端，并声明使用 MCP 子协议（第二个参数 ['mcp']）。
 * 为什么要 `as unknown as new (...) => WsClientLike` 这种双重断言：
 *   Bun 自带的 ws 类型声明里没有「三参数构造函数」(url, protocols, options)，直接 new 会编译报错；
 *   先转成 unknown（≈ Object）再转成目标构造函数类型，等于告诉编译器「别管，我知道它长这样」。
 * `await import('ws')` 是动态导入：只有真要连 ws 时才加载这个包（≈ Java 反射式懒加载）。
 */
/**
 * Create a ws.WebSocket client with the MCP protocol.
 * Bun's ws shim types lack the 3-arg constructor (url, protocols, options)
 * that the real ws package supports, so we cast the constructor here.
 */
async function createNodeWsClient(
  url: string,
  options: Record<string, unknown>,
): Promise<WsClientLike> {
  const wsModule = await import('ws')
  const WS = wsModule.default as unknown as new (
    url: string,
    protocols: string[],
    options: Record<string, unknown>,
  ) => WsClientLike
  return new WS(url, ['mcp'], options)
}

// 【中文补充】MCP 返回图片时，只有这几种 MIME 类型走「图片内容块」路径；其他二进制按通用 blob 处理。
// `new Set([...])` ≈ Java 的 HashSet，has() 是 O(1)。
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

/**
 * 【中文补充】**建立连接**阶段的超时：环境变量 MCP_TIMEOUT，默认 30 秒。
 * 注意区分：这是「连上」的超时，和工具调用的超时 MCP_TOOL_TIMEOUT 是两回事。
 */
function getConnectionTimeoutMs(): number {
  return parseInt(process.env.MCP_TIMEOUT || '', 10) || 30000
}

/**
 * 【中文补充】单个 MCP 请求（鉴权、工具调用等）的默认超时：60 秒。
 */
/**
 * Default timeout for individual MCP requests (auth, tool calls, etc.)
 */
const MCP_REQUEST_TIMEOUT_MS = 60000

/**
 * 【中文补充】Streamable HTTP 规范要求客户端在每个 POST 上都声明
 * `Accept: application/json, text/event-stream`，意思是「JSON 和 SSE 两种响应格式我都能收」。
 * 不带的后果：严格执行规范的 server 会直接回 406 Not Acceptable。
 */
/**
 * MCP Streamable HTTP spec requires clients to advertise acceptance of both
 * JSON and SSE on every POST. Servers that enforce this strictly reject
 * requests without it (HTTP 406).
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server
 */
const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream'

/**
 * 【中文补充】给 fetch 加一层包装，做两件事：
 *   ① **每个请求都用一个新的超时信号**：如果建连时就造好一个 AbortSignal.timeout(60s)，
 *      60 秒后这个 signal 就「过期」了，之后所有请求会立刻失败（这是曾经踩过的真实 bug），所以改成每次现造；
 *   ② 补齐 MCP 规范要求的 Accept 头：放在**最外层**包装（离真正的 fetch 最近）才能保证它真的被发出去。
 * 为什么 GET 不加超时：MCP 里的 GET 是用来接收 SSE 长流的，本来就该一直开着，加超时反而会把它掐断。
 * @param baseFetch 原始 fetch（可以是全局 fetch，也可以是前面加过 token 的那层）
 * @returns 包装后的 fetch，签名不变（装饰器模式，≈ Java 的 OkHttp Interceptor）
 */
/**
 * Wraps a fetch function to apply a fresh timeout signal to each request.
 * This avoids the bug where a single AbortSignal.timeout() created at connection
 * time becomes stale after 60 seconds, causing all subsequent requests to fail
 * immediately with "The operation timed out." Uses a 60-second timeout.
 *
 * Also ensures the Accept header required by the MCP Streamable HTTP spec is
 * present on POSTs. The MCP SDK sets this inside StreamableHTTPClientTransport.send(),
 * but it is attached to a Headers instance that passes through an object spread here,
 * and some runtimes/agents have been observed dropping it before it reaches the wire.
 * See https://github.com/anthropics/claude-agent-sdk-typescript/issues/202.
 * Normalizing here (the last wrapper before fetch()) guarantees it is sent.
 *
 * GET requests are excluded from the timeout since, for MCP transports, they are
 * long-lived SSE streams meant to stay open indefinitely. (Auth-related GETs use
 * a separate fetch wrapper with its own timeout in auth.ts.)
 *
 * @param baseFetch - The fetch function to wrap
 */
export function wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike {
  return async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()

    // Skip timeout for GET requests - in MCP transports, these are long-lived SSE streams.
    // (OAuth discovery GETs in auth.ts use a separate createAuthFetch() with its own timeout.)
    if (method === 'GET') {
      return baseFetch(url, init)
    }

    // Normalize headers and guarantee the Streamable-HTTP Accept value. new Headers()
    // accepts HeadersInit | undefined and copies from plain objects, tuple arrays,
    // and existing Headers instances — so whatever shape the SDK handed us, the
    // Accept value survives the spread below as an own property of a concrete object.
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    if (!headers.has('accept')) {
      headers.set('accept', MCP_STREAMABLE_HTTP_ACCEPT)
    }

    // Use setTimeout instead of AbortSignal.timeout() so we can clearTimeout on
    // completion. AbortSignal.timeout's internal timer is only released when the
    // signal is GC'd, which in Bun is lazy — ~2.4KB of native memory per request
    // lingers for the full 60s even when the request completes in milliseconds.
    const controller = new AbortController()
    const timer = setTimeout(
      c =>
        c.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      MCP_REQUEST_TIMEOUT_MS,
      controller,
    )
    timer.unref?.()

    const parentSignal = init?.signal
    const abort = () => controller.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', abort)
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason)
    }

    const cleanup = () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abort)
    }

    try {
      const response = await baseFetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
      cleanup()
      return response
    } catch (error) {
      cleanup()
      throw error
    }
  }
}

/**
 * 【中文补充】本地（stdio / sdk）server 的并发连接数，默认 3。
 * 为什么本地要小：每个 stdio server 都要 fork 一个子进程，并发太高会瞬间吃满 CPU 和文件描述符。
 */
export function getMcpServerConnectionBatchSize(): number {
  return parseInt(process.env.MCP_SERVER_CONNECTION_BATCH_SIZE || '', 10) || 3
}

/**
 * 【中文补充】远程（http / sse / ws）server 的并发连接数，默认 20。
 * 远程只是网络往返、没有进程开销，所以可以开得比本地大一个数量级。
 */
function getRemoteMcpServerConnectionBatchSize(): number {
  return (
    parseInt(process.env.MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE || '', 10) ||
    20
  )
}

/**
 * 【中文补充】判断一个 server 是不是「本地」：没写 type（默认就是 stdio）、或显式 stdio、或 sdk。
 * 用途：把 server 分流到上面两个不同并发度的批次里。
 * `!config.type` 利用了 JS 的 falsy 规则：undefined / '' / 0 都算假，这里表示「用户没配 type」。
 */
function isLocalMcpServer(config: ScopedMcpServerConfig): boolean {
  return !config.type || config.type === 'stdio' || config.type === 'sdk'
}

// 【中文补充】IDE 自带的 MCP server（工具名以 mcp__ide__ 开头）里，只允许这两个工具进入给模型的工具列表；
// 其余是 IDE 内部实现细节，对模型没意义却白占上下文，所以要过滤掉。
// For the IDE MCP servers, we only include specific tools
const ALLOWED_IDE_TOOLS = ['mcp__ide__executeCode', 'mcp__ide__getDiagnostics']
/**
 * 【中文补充】工具过滤规则：不是 `mcp__ide__` 前缀的一律放行；是的话必须命中上面的白名单。
 * 用在 fetchToolsForClient 的最后一步 `.filter(isIncludedMcpTool)`。
 * 对比说明：如果返回值写成 `tool is SomeType`，那就成了**类型谓词**，
 *   ≈ Java 的 instanceof 模式匹配，能让编译器自动把变量窄化到某个子类型（本函数只是普通布尔判断）。
 */
function isIncludedMcpTool(tool: Tool): boolean {
  return (
    !tool.name.startsWith('mcp__ide__') || ALLOWED_IDE_TOOLS.includes(tool.name)
  )
}

/**
 * 【中文补充】生成连接缓存的 key：server 名 + 配置的 JSON 序列化结果。
 * 为什么要把整个配置序列化进去：配置变了（改 URL、改 args、改 env）必须算作**另一个连接**，
 *   否则会复用旧连接，导致用户改了配置却不生效。
 * 它同时是 connectToServer 的 memoize keyFn（见 memoize 调用的第三个参数位置）。
 */
/**
 * Generates the cache key for a server connection
 * @param name Server name
 * @param serverRef Server configuration
 * @returns Cache key string
 */
export function getServerCacheKey(
  name: string,
  serverRef: ScopedMcpServerConfig,
): string {
  return `${name}-${jsonStringify(serverRef)}`
}

/**
 * 【中文补充】本文件**最核心**的函数：把一个 MCP server 连起来，返回包装好的连接对象。
 *
 * 整体流程（对应函数体内的 ① ~ ⑧）：
 *   ① 按 server.type 选传输层：stdio 起子进程 / sse 建 SSE 长连接 / http 用 Streamable HTTP /
 *      ws 用 WebSocket / sdk 走同进程 / claudeai-proxy 走代理 / Chrome 与 Computer Use 走进程内直连；
 *   ② 为 stdio 挂上 stderr 收集（连接失败时才能看到子进程自己打印的报错）；
 *   ③ new Client(...) 并声明客户端能力（roots、elicitation）；
 *   ④ 用 Promise.race 给连接加超时，超时即视为失败；
 *   ⑤ 失败时分类：401 → needs-auth，其他 → failed；
 *   ⑥ 成功后取能力集 / 版本 / instructions（instructions 过长要截断）；
 *   ⑦ 挂上 onerror / onclose：连续 3 次致命错误就主动断开，让下次调用重新连接；
 *   ⑧ 注册 cleanup（退出时优雅关闭，必要时 SIGTERM / SIGKILL 兜底）。
 *
 * 返回值是一个**判别联合**（discriminated union）：type 为 'connected' | 'failed' | 'needs-auth'，
 *   ≈ Java 的 sealed interface，调用方必须先判断 type 再取其它字段，编译器会强制你不漏分支。
 *
 * 关于 memoize：同名同配置只连一次，结果缓存在 connectToServer.cache 里；
 *   断线时 client.onclose 会主动 cache.delete(key)，下次调用自然重连 —— 这是本文件重连机制的关键。
 *
 * @param name server 名（也是工具名前缀的一部分）
 * @param serverRef 带作用域的 server 配置
 * @param serverStats 可选，本次启动的 server 统计，只用于遥测
 * @returns MCPServerConnection（connected / failed / needs-auth 三者之一）
 */
/**
 * TODO (ollie): The memoization here increases complexity by a lot, and im not sure it really improves performance
 * Attempts to connect to a single MCP server
 * @param name Server name
 * @param serverRef Scoped server configuration
 * @returns A wrapped client (either connected or failed)
 */
export const connectToServer = memoize(
  async (
    name: string,
    serverRef: ScopedMcpServerConfig,
    serverStats?: {
      totalServers: number
      stdioCount: number
      sseCount: number
      httpCount: number
      sseIdeCount: number
      wsIdeCount: number
    },
  ): Promise<MCPServerConnection> => {
    // 【中文补充】记录连接开始时间，用于成功/失败日志与遥测里统计耗时。
    const connectStartTime = Date.now()
    let inProcessServer:
      | { connect(t: Transport): Promise<void>; close(): Promise<void> }
      | undefined
    try {
      // 【中文补充】transport 是 MCP SDK 里的「传输层」抽象：stdio / SSE / HTTP / WS 各有一个实现类，
      // 下面的 if-else 链就是按配置挑实现 —— ≈ Java 里根据配置选不同 Transport 实现（策略模式）。
      // `let transport` 没有写类型，交给 TS 从所有分支的赋值里自动推断（≈ Java 10+ 的 var）。
      let transport

      // If we have the session ingress JWT, we will connect via the session ingress rather than
      // to remote MCP's directly.
      const sessionIngressToken = getSessionIngressAuthToken()

      // 【中文补充】下面这一长串 if/else 就是「按 server.type 选传输方式」。三种主要传输的区别：
      //   stdio —— 起一个**子进程**，用它的 stdin/stdout 收发 JSON-RPC。本地工具最常用，零网络、零鉴权。
      //   sse   —— 老式远程传输：POST 发请求，另开一条长连接的 SSE 流收响应（**两条通道**）。
      //   http  —— Streamable HTTP（现行推荐）：单条通道即可，server 也可按需把响应升级成 SSE 流。
      //   ws    —— WebSocket，全双工。
      // 此外 sdk / claudeai-proxy / 进程内（Chrome、Computer Use）是 Claude Code 自己内部的特殊通道。
      if (serverRef.type === 'sse') {
        // Create an auth provider for this server
        const authProvider = new ClaudeAuthProvider(name, serverRef)

        // Get combined headers (static + dynamic)
        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        // Use the auth provider with SSEClientTransport
        const transportOptions: SSEClientTransportOptions = {
          authProvider,
          // Use fresh timeout per request to avoid stale AbortSignal bug.
          // Step-up detection wraps innermost so the 403 is seen before the
          // SDK's handler calls auth() → tokens().
          fetch: wrapFetchWithTimeout(
            wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
          ),
          requestInit: {
            headers: {
              'User-Agent': getMCPUserAgent(),
              ...combinedHeaders,
            },
          },
        }

        // IMPORTANT: Always set eventSourceInit with a fetch that does NOT use the
        // timeout wrapper. The EventSource connection is long-lived (stays open indefinitely
        // to receive server-sent events), so applying a 60-second timeout would kill it.
        // The timeout is only meant for individual API requests (POST, auth refresh), not
        // the persistent SSE stream.
        transportOptions.eventSourceInit = {
          fetch: async (url: string | URL, init?: RequestInit) => {
            // Get auth headers from the auth provider
            const authHeaders: Record<string, string> = {}
            const tokens = await authProvider.tokens()
            if (tokens) {
              authHeaders.Authorization = `Bearer ${tokens.access_token}`
            }

            const proxyOptions = getProxyFetchOptions()
            // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
            return fetch(url, {
              ...init,
              ...proxyOptions,
              headers: {
                'User-Agent': getMCPUserAgent(),
                ...authHeaders,
                ...init?.headers,
                ...combinedHeaders,
                Accept: 'text/event-stream',
              },
            })
          },
        }

        transport = new SSEClientTransport(
          new URL(serverRef.url),
          transportOptions,
        )
        logMCPDebug(name, `SSE transport initialized, awaiting connection`)
      // 【中文补充】sse-ide：IDE 插件（VS Code / JetBrains）在本机起的 SSE server，走本地回环地址。
      } else if (serverRef.type === 'sse-ide') {
        logMCPDebug(name, `Setting up SSE-IDE transport to ${serverRef.url}`)
        // IDE servers don't need authentication
        // TODO: Use the auth token provided in the lockfile
        const proxyOptions = getProxyFetchOptions()
        const transportOptions: SSEClientTransportOptions =
          proxyOptions.dispatcher
            ? {
                eventSourceInit: {
                  fetch: async (url: string | URL, init?: RequestInit) => {
                    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
                    return fetch(url, {
                      ...init,
                      ...proxyOptions,
                      headers: {
                        'User-Agent': getMCPUserAgent(),
                        ...init?.headers,
                      },
                    })
                  },
                },
              }
            : {}

        transport = new SSEClientTransport(
          new URL(serverRef.url),
          Object.keys(transportOptions).length > 0
            ? transportOptions
            : undefined,
        )
      // 【中文补充】ws-ide：同样是 IDE 插件起的 server，但用 WebSocket 而不是 SSE（全双工，延迟更低）。
      } else if (serverRef.type === 'ws-ide') {
        const tlsOptions = getWebSocketTLSOptions()
        const wsHeaders = {
          'User-Agent': getMCPUserAgent(),
          ...(serverRef.authToken && {
            'X-Claude-Code-Ide-Authorization': serverRef.authToken,
          }),
        }

        let wsClient: WsClientLike
        if (typeof Bun !== 'undefined') {
          // Bun's WebSocket supports headers/proxy/tls options but the DOM typings don't
          // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
          wsClient = new globalThis.WebSocket(serverRef.url, {
            protocols: ['mcp'],
            headers: wsHeaders,
            proxy: getWebSocketProxyUrl(serverRef.url),
            tls: tlsOptions || undefined,
          } as unknown as string[])
        } else {
          wsClient = await createNodeWsClient(serverRef.url, {
            headers: wsHeaders,
            agent: getWebSocketProxyAgent(serverRef.url),
            ...(tlsOptions || {}),
          })
        }
        transport = new WebSocketTransport(wsClient)
      // 【中文补充】ws：标准的 WebSocket 远程 MCP server，用上面 createNodeWsClient 建的客户端。
      } else if (serverRef.type === 'ws') {
        logMCPDebug(
          name,
          `Initializing WebSocket transport to ${serverRef.url}`,
        )

        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        const tlsOptions = getWebSocketTLSOptions()
        const wsHeaders = {
          'User-Agent': getMCPUserAgent(),
          ...(sessionIngressToken && {
            Authorization: `Bearer ${sessionIngressToken}`,
          }),
          ...combinedHeaders,
        }

        // Redact sensitive headers before logging
        const wsHeadersForLogging = mapValues(wsHeaders, (value, key) =>
          key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
        )

        logMCPDebug(
          name,
          `WebSocket transport options: ${jsonStringify({
            url: serverRef.url,
            headers: wsHeadersForLogging,
            hasSessionAuth: !!sessionIngressToken,
          })}`,
        )

        let wsClient: WsClientLike
        if (typeof Bun !== 'undefined') {
          // Bun's WebSocket supports headers/proxy/tls options but the DOM typings don't
          // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
          wsClient = new globalThis.WebSocket(serverRef.url, {
            protocols: ['mcp'],
            headers: wsHeaders,
            proxy: getWebSocketProxyUrl(serverRef.url),
            tls: tlsOptions || undefined,
          } as unknown as string[])
        } else {
          wsClient = await createNodeWsClient(serverRef.url, {
            headers: wsHeaders,
            agent: getWebSocketProxyAgent(serverRef.url),
            ...(tlsOptions || {}),
          })
        }
        transport = new WebSocketTransport(wsClient)
      // 【中文补充】http：Streamable HTTP，官方现行推荐的远程传输方式（单通道，可按需升级为 SSE 流）。
      } else if (serverRef.type === 'http') {
        logMCPDebug(name, `Initializing HTTP transport to ${serverRef.url}`)
        logMCPDebug(
          name,
          `Node version: ${process.version}, Platform: ${process.platform}`,
        )
        logMCPDebug(
          name,
          `Environment: ${jsonStringify({
            NODE_OPTIONS: process.env.NODE_OPTIONS || 'not set',
            UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || 'default',
            HTTP_PROXY: process.env.HTTP_PROXY || 'not set',
            HTTPS_PROXY: process.env.HTTPS_PROXY || 'not set',
            NO_PROXY: process.env.NO_PROXY || 'not set',
          })}`,
        )

        // Create an auth provider for this server
        const authProvider = new ClaudeAuthProvider(name, serverRef)

        // Get combined headers (static + dynamic)
        const combinedHeaders = await getMcpServerHeaders(name, serverRef)

        // Check if this server has stored OAuth tokens. If so, the SDK's
        // authProvider will set Authorization — don't override with the
        // session ingress token (SDK merges requestInit AFTER authProvider).
        // CCR proxy URLs (ccr_shttp_mcp) have no stored OAuth, so they still
        // get the ingress token. See PR #24454 discussion.
        const hasOAuthTokens = !!(await authProvider.tokens())

        // Use the auth provider with StreamableHTTPClientTransport
        const proxyOptions = getProxyFetchOptions()
        logMCPDebug(
          name,
          `Proxy options: ${proxyOptions.dispatcher ? 'custom dispatcher' : 'default'}`,
        )

        const transportOptions: StreamableHTTPClientTransportOptions = {
          authProvider,
          // Use fresh timeout per request to avoid stale AbortSignal bug.
          // Step-up detection wraps innermost so the 403 is seen before the
          // SDK's handler calls auth() → tokens().
          fetch: wrapFetchWithTimeout(
            wrapFetchWithStepUpDetection(createFetchWithInit(), authProvider),
          ),
          requestInit: {
            ...proxyOptions,
            headers: {
              'User-Agent': getMCPUserAgent(),
              ...(sessionIngressToken &&
                !hasOAuthTokens && {
                  Authorization: `Bearer ${sessionIngressToken}`,
                }),
              ...combinedHeaders,
            },
          },
        }

        // Redact sensitive headers before logging
        const headersForLogging = transportOptions.requestInit?.headers
          ? mapValues(
              transportOptions.requestInit.headers as Record<string, string>,
              (value, key) =>
                key.toLowerCase() === 'authorization' ? '[REDACTED]' : value,
            )
          : undefined

        logMCPDebug(
          name,
          `HTTP transport options: ${jsonStringify({
            url: serverRef.url,
            headers: headersForLogging,
            hasAuthProvider: !!authProvider,
            timeoutMs: MCP_REQUEST_TIMEOUT_MS,
          })}`,
        )

        transport = new StreamableHTTPClientTransport(
          new URL(serverRef.url),
          transportOptions,
        )
        logMCPDebug(name, `HTTP transport created successfully`)
      // 【中文补充】sdk 类型不该走到这里 —— SDK 内的 MCP server 跑在**本进程**里，
      // 由文件末尾的 setupSdkMcpClients() 统一连接（见 print.ts 的调用）。这里直接抛错防止误用。
      } else if (serverRef.type === 'sdk') {
        throw new Error('SDK servers should be handled in print.ts')
      // 【中文补充】claudeai-proxy：不直连第三方 server，而是走 claude.ai 的代理地址，
      // 好处是凭证统一由 claude.ai 的 OAuth token 提供，第三方 server 不需要各自做 OAuth。
      } else if (serverRef.type === 'claudeai-proxy') {
        logMCPDebug(
          name,
          `Initializing claude.ai proxy transport for server ${serverRef.id}`,
        )

        const tokens = getClaudeAIOAuthTokens()
        if (!tokens) {
          throw new Error('No claude.ai OAuth token found')
        }

        const oauthConfig = getOauthConfig()
        const proxyUrl = `${oauthConfig.MCP_PROXY_URL}${oauthConfig.MCP_PROXY_PATH.replace('{server_id}', serverRef.id)}`

        logMCPDebug(name, `Using claude.ai proxy at ${proxyUrl}`)

        // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        const fetchWithAuth = createClaudeAiProxyFetch(globalThis.fetch)

        const proxyOptions = getProxyFetchOptions()
        const transportOptions: StreamableHTTPClientTransportOptions = {
          // Wrap fetchWithAuth with fresh timeout per request
          fetch: wrapFetchWithTimeout(fetchWithAuth),
          requestInit: {
            ...proxyOptions,
            headers: {
              'User-Agent': getMCPUserAgent(),
              'X-Mcp-Client-Session-Id': getSessionId(),
            },
          },
        }

        transport = new StreamableHTTPClientTransport(
          new URL(proxyUrl),
          transportOptions,
        )
        logMCPDebug(name, `claude.ai proxy transport created successfully`)
      // 【中文补充】Chrome MCP server 跑在**进程内**：正常做法要 fork 一个子进程，而 Chrome 相关依赖
      // 会占约 325MB 内存，所以这里用一对「互联的 transport」直接在内存里收发消息（见 ./InProcessTransport.ts）。
      } else if (
        (serverRef.type === 'stdio' || !serverRef.type) &&
        isClaudeInChromeMCPServer(name)
      ) {
        // Run the Chrome MCP server in-process to avoid spawning a ~325 MB subprocess
        const { createChromeContext } = await import(
          '../../utils/claudeInChrome/mcpServer.js'
        )
        const { createClaudeForChromeMcpServer } = await import(
          '@ant/claude-for-chrome-mcp'
        )
        const { createLinkedTransportPair } = await import(
          './InProcessTransport.js'
        )
        const context = createChromeContext(serverRef.env)
        inProcessServer = createClaudeForChromeMcpServer(context)
        const [clientTransport, serverTransport] = createLinkedTransportPair()
        await inProcessServer.connect(serverTransport)
        transport = clientTransport
        logMCPDebug(name, `In-process Chrome MCP server started`)
      // 【中文补充】Computer Use（操作电脑的 MCP server）同样走进程内直连；整段代码被 feature('CHICAGO_MCP')
      // 这个编译期开关包着，未开启时不会出现在产物里（原生模块也就不会被打进包）。
      } else if (
        feature('CHICAGO_MCP') &&
        (serverRef.type === 'stdio' || !serverRef.type) &&
        isComputerUseMCPServer!(name)
      ) {
        // Run the Computer Use MCP server in-process — same rationale as
        // Chrome above. The package's CallTool handler is a stub; real
        // dispatch goes through wrapper.tsx's .call() override.
        const { createComputerUseMcpServerForCli } = await import(
          '../../utils/computerUse/mcpServer.js'
        )
        const { createLinkedTransportPair } = await import(
          './InProcessTransport.js'
        )
        inProcessServer = await createComputerUseMcpServerForCli()
        const [clientTransport, serverTransport] = createLinkedTransportPair()
        await inProcessServer.connect(serverTransport)
        transport = clientTransport
        logMCPDebug(name, `In-process Computer Use MCP server started`)
      // 【中文补充】stdio（默认）：最经典的 MCP 传输 —— 把 server 当子进程启动，用它的 stdin/stdout 说 JSON-RPC。
      // 注意 env 用 `{ ...subprocessEnv(), ...serverRef.env }` 展开合并：后写的覆盖先写的，
      //   所以用户在配置里写的 env 优先（≈ Java 里先 putAll 系统变量再 putAll 用户变量）。
      // `stderr: 'pipe'` 很关键：不接管的话子进程的报错会直接糊到用户终端上。
      } else if (serverRef.type === 'stdio' || !serverRef.type) {
        const finalCommand =
          process.env.CLAUDE_CODE_SHELL_PREFIX || serverRef.command
        const finalArgs = process.env.CLAUDE_CODE_SHELL_PREFIX
          ? [[serverRef.command, ...serverRef.args].join(' ')]
          : serverRef.args
        transport = new StdioClientTransport({
          command: finalCommand,
          args: finalArgs,
          env: {
            ...subprocessEnv(),
            ...serverRef.env,
          } as Record<string, string>,
          stderr: 'pipe', // prevents error output from the MCP server from printing to the UI
        })
      // 【中文补充】兜底分支：配置里写了不认识的 type，直接抛错而不是默默用默认值连接。
      } else {
        throw new Error(`Unsupported server type: ${serverRef.type}`)
      }

      // Set up stderr logging for stdio transport before connecting in case there are any stderr
      // outputs emitted during the connection start (this can be useful for debugging failed connections).
      // Store handler reference for cleanup to prevent memory leaks
      let stderrHandler: ((data: Buffer) => void) | undefined
      let stderrOutput = ''
      // 【中文补充】提前把子进程的 stderr 收集起来（配合上面的 'pipe'），
      // 这样连接失败时能把子进程自己打印的原因一并记进日志 —— 否则 stdio server 挂了只会看到一个空泛的超时。
      // 收集时有 64MB 上限：一个跑飞的 server 可能无限输出，不能让它把内存吃光。
      if (serverRef.type === 'stdio' || !serverRef.type) {
        const stdioTransport = transport as StdioClientTransport
        if (stdioTransport.stderr) {
          stderrHandler = (data: Buffer) => {
            // Cap stderr accumulation to prevent unbounded memory growth
            if (stderrOutput.length < 64 * 1024 * 1024) {
              try {
                stderrOutput += data.toString()
              } catch {
                // Ignore errors from exceeding max string length
              }
            }
          }
          stdioTransport.stderr.on('data', stderrHandler)
        }
      }

      // 【中文补充】new Client(...) 创建 MCP 客户端，第二个参数是「客户端能力声明」：
      //   roots       —— 告诉 server 我可以提供工作目录列表；
      //   elicitation —— 告诉 server 我支持「反向向用户提问」（用 `{}` 空对象即可，
      //                  写成 {form:{},url:{}} 会让 Java 版服务端（Spring AI）反序列化失败）。
      const client = new Client(
        {
          name: 'claude-code',
          title: 'Claude Code',
          version: MACRO.VERSION ?? 'unknown',
          description: "Anthropic's agentic coding tool",
          websiteUrl: PRODUCT_URL,
        },
        {
          capabilities: {
            roots: {},
            // Empty object declares the capability. Sending {form:{},url:{}}
            // breaks Java MCP SDK servers (Spring AI) whose Elicitation class
            // has zero fields and fails on unknown properties.
            elicitation: {},
          },
        },
      )

      // Add debug logging for client events if available
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Client created, setting up request handler`)
      }

      // 【中文补充】注册 roots/list 的处理函数：server 主动来问「当前工作目录有哪些」时回它。
      // 这是 MCP 的「请求-响应」是双向的体现 —— 不只是我们调 server，server 也能调我们。
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        logMCPDebug(name, `Received ListRoots request from server`)
        return {
          roots: [
            {
              uri: `file://${getOriginalCwd()}`,
            },
          ],
        }
      })

      // Add a timeout to connection attempts to prevent tests from hanging indefinitely
      logMCPDebug(
        name,
        `Starting connection with timeout of ${getConnectionTimeoutMs()}ms`,
      )

      // For HTTP transport, try a basic connectivity test first
      if (serverRef.type === 'http') {
        logMCPDebug(name, `Testing basic HTTP connectivity to ${serverRef.url}`)
        try {
          const testUrl = new URL(serverRef.url)
          logMCPDebug(
            name,
            `Parsed URL: host=${testUrl.hostname}, port=${testUrl.port || 'default'}, protocol=${testUrl.protocol}`,
          )

          // Log DNS resolution attempt
          if (
            testUrl.hostname === '127.0.0.1' ||
            testUrl.hostname === 'localhost'
          ) {
            logMCPDebug(name, `Using loopback address: ${testUrl.hostname}`)
          }
        } catch (urlError) {
          logMCPDebug(name, `Failed to parse URL: ${urlError}`)
        }
      }

      // 【中文补充】用 Promise.race 给连接过程加超时：
      //   connectPromise  —— 真正的连接（可能永远挂住，比如 server 起了但从不响应）；
      //   timeoutPromise  —— 到点就 reject（注意类型是 Promise<never>，表示它只会失败不会成功）。
      // 两者赛跑，谁先出结果算谁 —— ≈ Java 的 CompletableFuture.anyOf(...).get(timeout)。
      const connectPromise = client.connect(transport)
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timeoutId = setTimeout(() => {
          const elapsed = Date.now() - connectStartTime
          logMCPDebug(
            name,
            `Connection timeout triggered after ${elapsed}ms (limit: ${getConnectionTimeoutMs()}ms)`,
          )
          if (inProcessServer) {
            inProcessServer.close().catch(() => {})
          }
          transport.close().catch(() => {})
          reject(
            new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `MCP server "${name}" connection timed out after ${getConnectionTimeoutMs()}ms`,
              'MCP connection timeout',
            ),
          )
        }, getConnectionTimeoutMs())

        // Clean up timeout if connect resolves or rejects
        connectPromise.then(
          () => {
            clearTimeout(timeoutId)
          },
          _error => {
            clearTimeout(timeoutId)
          },
        )
      })

      try {
        await Promise.race([connectPromise, timeoutPromise])
        if (stderrOutput) {
          logMCPError(name, `Server stderr: ${stderrOutput}`)
          stderrOutput = '' // Release accumulated string to prevent memory growth
        }
        const elapsed = Date.now() - connectStartTime
        logMCPDebug(
          name,
          `Successfully connected (transport: ${serverRef.type || 'stdio'}) in ${elapsed}ms`,
        )
      // 【中文补充】连接失败的分类处理：
      //   401（UnauthorizedError）→ 交给 handleRemoteAuthFailure，返回 needs-auth 状态（不是抛异常）；
      //   其它错误 → 关掉 transport、记下 stderr，然后原样抛出，由外层 catch 统一转成 failed 状态。
      } catch (error) {
        const elapsed = Date.now() - connectStartTime
        // SSE-specific error logging
        if (serverRef.type === 'sse' && error instanceof Error) {
          logMCPDebug(
            name,
            `SSE Connection failed after ${elapsed}ms: ${jsonStringify({
              url: serverRef.url,
              error: error.message,
              errorType: error.constructor.name,
              stack: error.stack,
            })}`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(name, serverRef, 'sse')
          }
        } else if (serverRef.type === 'http' && error instanceof Error) {
          const errorObj = error as Error & {
            cause?: unknown
            code?: string
            errno?: string | number
            syscall?: string
          }
          logMCPDebug(
            name,
            `HTTP Connection failed after ${elapsed}ms: ${error.message} (code: ${errorObj.code || 'none'}, errno: ${errorObj.errno || 'none'})`,
          )
          logMCPError(name, error)

          if (error instanceof UnauthorizedError) {
            return handleRemoteAuthFailure(name, serverRef, 'http')
          }
        } else if (
          serverRef.type === 'claudeai-proxy' &&
          error instanceof Error
        ) {
          logMCPDebug(
            name,
            `claude.ai proxy connection failed after ${elapsed}ms: ${error.message}`,
          )
          logMCPError(name, error)

          // StreamableHTTPError has a `code` property with the HTTP status
          const errorCode = (error as Error & { code?: number }).code
          if (errorCode === 401) {
            return handleRemoteAuthFailure(name, serverRef, 'claudeai-proxy')
          }
        } else if (
          serverRef.type === 'sse-ide' ||
          serverRef.type === 'ws-ide'
        ) {
          logEvent('tengu_mcp_ide_server_connection_failed', {
            connectionDurationMs: elapsed,
          })
        }
        if (inProcessServer) {
          inProcessServer.close().catch(() => {})
        }
        transport.close().catch(() => {})
        if (stderrOutput) {
          logMCPError(name, `Server stderr: ${stderrOutput}`)
        }
        throw error
      }

      // 【中文补充】连接成功后，向 server 询问三件事：
      //   capabilities —— 它支持哪些能力（有没有 tools / resources / prompts / 订阅），后面拉列表前都要先查这个；
      //   serverVersion / instructions —— 版本信息和「使用说明」（instructions 会作为系统提示的一部分给模型，所以要截断）。
      const capabilities = client.getServerCapabilities()
      const serverVersion = client.getServerVersion()
      const rawInstructions = client.getInstructions()
      let instructions = rawInstructions
      if (
        rawInstructions &&
        rawInstructions.length > MAX_MCP_DESCRIPTION_LENGTH
      ) {
        instructions =
          rawInstructions.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
        logMCPDebug(
          name,
          `Server instructions truncated from ${rawInstructions.length} to ${MAX_MCP_DESCRIPTION_LENGTH} chars`,
        )
      }

      // Log successful connection details
      logMCPDebug(
        name,
        `Connection established with capabilities: ${jsonStringify({
          hasTools: !!capabilities?.tools,
          hasPrompts: !!capabilities?.prompts,
          hasResources: !!capabilities?.resources,
          hasResourceSubscribe: !!capabilities?.resources?.subscribe,
          serverVersion: serverVersion || 'unknown',
        })}`,
      )
      logForDebugging(
        `[MCP] Server "${name}" connected with subscribe=${!!capabilities?.resources?.subscribe}`,
      )

      // Register default elicitation handler that returns cancel during the
      // window before registerElicitationHandler overwrites it in
      // onConnectionAttempt (useManageMCPConnections).
      // 【中文补充】先注册一个「默认」的 elicitation（server 反向提问）处理器，一律回 cancel。
      // 原因：连接刚建立、真正的 UI 处理器还没挂上的这段窗口期里，server 就可能发问；
      // 没有处理器会让 SDK 报错，所以先兜一个「取消」，稍后 ./elicitationHandler.ts 会把它替换掉。
      client.setRequestHandler(ElicitRequestSchema, async request => {
        logMCPDebug(
          name,
          `Elicitation request received during initialization: ${jsonStringify(request)}`,
        )
        return { action: 'cancel' as const }
      })

      if (serverRef.type === 'sse-ide' || serverRef.type === 'ws-ide') {
        const ideConnectionDurationMs = Date.now() - connectStartTime
        logEvent('tengu_mcp_ide_server_connection_succeeded', {
          connectionDurationMs: ideConnectionDurationMs,
          serverVersion:
            serverVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        try {
          void maybeNotifyIDEConnected(client)
        } catch (error) {
          logMCPError(
            name,
            `Failed to send ide_connected notification: ${error}`,
          )
        }
      }

      // 【中文补充】从这里往下是**连接健康度监控**，目标是「掉了能自动恢复」。
      // 生命周期概览：pending（还没连）→ connected / failed / needs-auth；已连上的连接掉线后，
      // onclose 会清掉缓存，下次调用 connectToServer 时会重新走一遍完整流程（相当于回到 pending）。
      // Enhanced connection drop detection and logging for all transport types
      const connectionStartTime = Date.now()
      let hasErrorOccurred = false

      // Store original handlers
      const originalOnerror = client.onerror
      const originalOnclose = client.onclose

      // 【中文补充】SDK 的 transport 在连接出错时会调 onerror，但**不会**调 onclose，
      // 而 Claude Code 的重连逻辑挂在 onclose 上。所以这里自己数「连续的致命错误」：
      // 攒够 MAX_ERRORS_BEFORE_RECONNECT 次就手动关掉连接，把 onerror 桥接到重连流程上。
      // hasTriggeredClose 是防重入的：close() 会中断在途的流，可能又触发一次 onerror，
      //   不挡住就会递归关闭（≈ Java 里用一个 AtomicBoolean 做 once 语义）。
      // The SDK's transport calls onerror on connection failures but doesn't call onclose,
      // which CC uses to trigger reconnection. We bridge this gap by tracking consecutive
      // terminal errors and manually closing after MAX_ERRORS_BEFORE_RECONNECT failures.
      let consecutiveConnectionErrors = 0
      const MAX_ERRORS_BEFORE_RECONNECT = 3

      // Guard against re-entry: close() aborts in-flight streams which may fire
      // onerror again before the close chain completes.
      let hasTriggeredClose = false

      // client.close() → transport.close() → transport.onclose → SDK's _onclose():
      // rejects all pending request handlers (so hung callTool() promises fail with
      // McpError -32000 "Connection closed") and then invokes our client.onclose
      // handler below (which clears the memo cache so the next call reconnects).
      // Calling client.onclose?.() directly would only clear the cache — pending
      // tool calls would stay hung.
      const closeTransportAndRejectPending = (reason: string) => {
        if (hasTriggeredClose) return
        hasTriggeredClose = true
        logMCPDebug(name, `Closing transport (${reason})`)
        void client.close().catch(e => {
          logMCPDebug(name, `Error during close: ${errorMessage(e)}`)
        })
      }

      // 【中文补充】判断一条错误消息是不是「连接彻底断了」（ECONNRESET / EPIPE / SSE 流断开 等）。
      // 只有致命错误才计数重试；业务层面的报错（比如工具返回格式不对）不该触发重连。
      // 这里用「字符串包含」而不是错误类型判断，因为 SDK 经常把真实网络错误包一层，类型信息会丢。
      const isTerminalConnectionError = (msg: string): boolean => {
        return (
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('EPIPE') ||
          msg.includes('EHOSTUNREACH') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('Body Timeout Error') ||
          msg.includes('terminated') ||
          // SDK SSE reconnection intermediate errors — may be wrapped around the
          // actual network error, so the substrings above won't match
          msg.includes('SSE stream disconnected') ||
          msg.includes('Failed to reconnect SSE stream')
        )
      }

      // 【中文补充】onerror：连接出错时的钩子。做三件事：记日志、累计致命错误次数、
      // 攒够次数就关掉 transport 让后续调用重新连接。最后一定要把原始的 onerror 也调一遍（不能吞掉 SDK 的行为）。
      // Enhanced error handler with detailed logging
      client.onerror = (error: Error) => {
        const uptime = Date.now() - connectionStartTime
        hasErrorOccurred = true
        const transportType = serverRef.type || 'stdio'

        // Log the connection drop with context
        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection dropped after ${Math.floor(uptime / 1000)}s uptime`,
        )

        // Log specific error details for debugging
        if (error.message) {
          if (error.message.includes('ECONNRESET')) {
            logMCPDebug(
              name,
              `Connection reset - server may have crashed or restarted`,
            )
          } else if (error.message.includes('ETIMEDOUT')) {
            logMCPDebug(
              name,
              `Connection timeout - network issue or server unresponsive`,
            )
          } else if (error.message.includes('ECONNREFUSED')) {
            logMCPDebug(name, `Connection refused - server may be down`)
          } else if (error.message.includes('EPIPE')) {
            logMCPDebug(
              name,
              `Broken pipe - server closed connection unexpectedly`,
            )
          } else if (error.message.includes('EHOSTUNREACH')) {
            logMCPDebug(name, `Host unreachable - network connectivity issue`)
          } else if (error.message.includes('ESRCH')) {
            logMCPDebug(
              name,
              `Process not found - stdio server process terminated`,
            )
          } else if (error.message.includes('spawn')) {
            logMCPDebug(
              name,
              `Failed to spawn process - check command and permissions`,
            )
          } else {
            logMCPDebug(name, `Connection error: ${error.message}`)
          }
        }

        // For HTTP transports, detect session expiry (404 + JSON-RPC -32001)
        // and close the transport so pending tool calls reject and the next
        // call reconnects with a fresh session ID.
        if (
          (transportType === 'http' || transportType === 'claudeai-proxy') &&
          isMcpSessionExpiredError(error)
        ) {
          logMCPDebug(
            name,
            `MCP session expired (server returned 404 with session-not-found), triggering reconnection`,
          )
          closeTransportAndRejectPending('session expired')
          if (originalOnerror) {
            originalOnerror(error)
          }
          return
        }

        // For remote transports (SSE/HTTP), track terminal connection errors
        // and trigger reconnection via close if we see repeated failures.
        if (
          transportType === 'sse' ||
          transportType === 'http' ||
          transportType === 'claudeai-proxy'
        ) {
          // The SDK's StreamableHTTP transport fires this after exhausting its
          // own SSE reconnect attempts (default maxRetries: 2) — but it never
          // calls onclose, so pending callTool() promises hang indefinitely.
          // This is the definitive "transport gave up" signal.
          if (error.message.includes('Maximum reconnection attempts')) {
            closeTransportAndRejectPending('SSE reconnection exhausted')
            if (originalOnerror) {
              originalOnerror(error)
            }
            return
          }

          if (isTerminalConnectionError(error.message)) {
            consecutiveConnectionErrors++
            logMCPDebug(
              name,
              `Terminal connection error ${consecutiveConnectionErrors}/${MAX_ERRORS_BEFORE_RECONNECT}`,
            )

            if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
              consecutiveConnectionErrors = 0
              closeTransportAndRejectPending('max consecutive terminal errors')
            }
          } else {
            // Non-terminal error (e.g., transient issue), reset counter
            consecutiveConnectionErrors = 0
          }
        }

        // Call original handler
        if (originalOnerror) {
          originalOnerror(error)
        }
      }

      // 【中文补充】onclose：连接关闭时的钩子，是**重连机制的核心** ——
      // 把 connectToServer 的缓存以及 tools / resources / commands 三个 fetch 缓存全部清掉，
      // 这样下一次调用就会真的重连、重新拉列表，而不是复用一份已经死掉的连接和过期数据。
      // Enhanced close handler with connection drop context
      client.onclose = () => {
        const uptime = Date.now() - connectionStartTime
        const transportType = serverRef.type ?? 'unknown'

        logMCPDebug(
          name,
          `${transportType.toUpperCase()} connection closed after ${Math.floor(uptime / 1000)}s (${hasErrorOccurred ? 'with errors' : 'cleanly'})`,
        )

        // Clear the memoization cache so next operation reconnects
        const key = getServerCacheKey(name, serverRef)

        // Also clear fetch caches (keyed by server name). Reconnection
        // creates a new connection object; without clearing, the next
        // fetch would return stale tools/resources from the old connection.
        fetchToolsForClient.cache.delete(name)
        fetchResourcesForClient.cache.delete(name)
        fetchCommandsForClient.cache.delete(name)
        if (feature('MCP_SKILLS')) {
          fetchMcpSkillsForClient!.cache.delete(name)
        }

        connectToServer.cache.delete(key)
        logMCPDebug(name, `Cleared connection cache for reconnection`)

        if (originalOnclose) {
          originalOnclose()
        }
      }

      // 【中文补充】cleanup：进程退出 / 主动断开时调用，负责把子进程收干净。
      // 策略是「先礼后兵」：先 SIGINT 请它自己退出，等一会儿还在就 SIGTERM，再不行 SIGKILL。
      // 这一步不能省 —— MCP server 是外部进程，父进程直接退出会把它们变成孤儿进程一直挂着。
      const cleanup = async () => {
        // In-process servers (e.g. Chrome MCP) don't have child processes or stderr
        if (inProcessServer) {
          try {
            await inProcessServer.close()
          } catch (error) {
            logMCPDebug(name, `Error closing in-process server: ${error}`)
          }
          try {
            await client.close()
          } catch (error) {
            logMCPDebug(name, `Error closing client: ${error}`)
          }
          return
        }

        // Remove stderr event listener to prevent memory leaks
        if (stderrHandler && (serverRef.type === 'stdio' || !serverRef.type)) {
          const stdioTransport = transport as StdioClientTransport
          stdioTransport.stderr?.off('data', stderrHandler)
        }

        // For stdio transports, explicitly terminate the child process with proper signals
        // NOTE: StdioClientTransport.close() only sends an abort signal, but many MCP servers
        // (especially Docker containers) need explicit SIGINT/SIGTERM signals to trigger graceful shutdown
        if (serverRef.type === 'stdio') {
          try {
            const stdioTransport = transport as StdioClientTransport
            const childPid = stdioTransport.pid

            if (childPid) {
              logMCPDebug(name, 'Sending SIGINT to MCP server process')

              // First try SIGINT (like Ctrl+C)
              try {
                process.kill(childPid, 'SIGINT')
              } catch (error) {
                logMCPDebug(name, `Error sending SIGINT: ${error}`)
                return
              }

              // Wait for graceful shutdown with rapid escalation (total 500ms to keep CLI responsive)
              await new Promise<void>(async resolve => {
                let resolved = false

                // Set up a timer to check if process still exists
                const checkInterval = setInterval(() => {
                  try {
                    // process.kill(pid, 0) checks if process exists without killing it
                    process.kill(childPid, 0)
                  } catch {
                    // Process no longer exists
                    if (!resolved) {
                      resolved = true
                      clearInterval(checkInterval)
                      clearTimeout(failsafeTimeout)
                      logMCPDebug(name, 'MCP server process exited cleanly')
                      resolve()
                    }
                  }
                }, 50)

                // Absolute failsafe: clear interval after 600ms no matter what
                const failsafeTimeout = setTimeout(() => {
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    logMCPDebug(
                      name,
                      'Cleanup timeout reached, stopping process monitoring',
                    )
                    resolve()
                  }
                }, 600)

                try {
                  // Wait 100ms for SIGINT to work (usually much faster)
                  await sleep(100)

                  if (!resolved) {
                    // Check if process still exists
                    try {
                      process.kill(childPid, 0)
                      // Process still exists, SIGINT failed, try SIGTERM
                      logMCPDebug(
                        name,
                        'SIGINT failed, sending SIGTERM to MCP server process',
                      )
                      try {
                        process.kill(childPid, 'SIGTERM')
                      } catch (termError) {
                        logMCPDebug(name, `Error sending SIGTERM: ${termError}`)
                        resolved = true
                        clearInterval(checkInterval)
                        clearTimeout(failsafeTimeout)
                        resolve()
                        return
                      }
                    } catch {
                      // Process already exited
                      resolved = true
                      clearInterval(checkInterval)
                      clearTimeout(failsafeTimeout)
                      resolve()
                      return
                    }

                    // Wait 400ms for SIGTERM to work (slower than SIGINT, often used for cleanup)
                    await sleep(400)

                    if (!resolved) {
                      // Check if process still exists
                      try {
                        process.kill(childPid, 0)
                        // Process still exists, SIGTERM failed, force kill with SIGKILL
                        logMCPDebug(
                          name,
                          'SIGTERM failed, sending SIGKILL to MCP server process',
                        )
                        try {
                          process.kill(childPid, 'SIGKILL')
                        } catch (killError) {
                          logMCPDebug(
                            name,
                            `Error sending SIGKILL: ${killError}`,
                          )
                        }
                      } catch {
                        // Process already exited
                        resolved = true
                        clearInterval(checkInterval)
                        clearTimeout(failsafeTimeout)
                        resolve()
                      }
                    }
                  }

                  // Final timeout - always resolve after 500ms max (total cleanup time)
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    clearTimeout(failsafeTimeout)
                    resolve()
                  }
                } catch {
                  // Handle any errors in the escalation sequence
                  if (!resolved) {
                    resolved = true
                    clearInterval(checkInterval)
                    clearTimeout(failsafeTimeout)
                    resolve()
                  }
                }
              })
            }
          } catch (processError) {
            logMCPDebug(name, `Error terminating process: ${processError}`)
          }
        }

        // Close the client connection (which also closes the transport)
        try {
          await client.close()
        } catch (error) {
          logMCPDebug(name, `Error closing client: ${error}`)
        }
      }

      // 【中文补充】把 cleanup 注册到全局退出钩子里，**所有**传输类型都注册（不只是 stdio），
      // 保证 Claude Code 退出时不会漏掉任何一个 MCP server。
      // Register cleanup for all transport types - even network transports might need cleanup
      // This ensures all MCP servers get properly terminated, not just stdio ones
      const cleanupUnregister = registerCleanup(cleanup)

      // Create the wrapped cleanup that includes unregistering
      const wrappedCleanup = async () => {
        cleanupUnregister?.()
        await cleanup()
      }

      const connectionDurationMs = Date.now() - connectStartTime
      logEvent('tengu_mcp_server_connection_succeeded', {
        connectionDurationMs,
        transportType: (serverRef.type ??
          'stdio') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        totalServers: serverStats?.totalServers,
        stdioCount: serverStats?.stdioCount,
        sseCount: serverStats?.sseCount,
        httpCount: serverStats?.httpCount,
        sseIdeCount: serverStats?.sseIdeCount,
        wsIdeCount: serverStats?.wsIdeCount,
        ...mcpBaseUrlAnalytics(serverRef),
      })
      // 【中文补充】连接成功，返回 connected 状态的对象：
      //   client      —— SDK 的客户端，后面发请求都用它；
      //   capabilities / serverInfo / instructions —— 上面从 server 问来的元信息；
      //   cleanup     —— 交给上层，在需要时主动断开（判别联合的 'connected' 分支才有这个字段）。
      return {
        name,
        client,
        type: 'connected' as const,
        capabilities: capabilities ?? {},
        serverInfo: serverVersion,
        instructions,
        config: serverRef,
        cleanup: wrappedCleanup,
      }
    // 【中文补充】外层 catch：连接过程中任何异常统一转成 `type: 'failed'` 返回，
    // **不向上抛** —— 因为一个 server 连不上不该让整个 Claude Code 启动失败，
    // 而是把这个 server 单独标成 failed，UI 上显示出来让用户自己处理。
    } catch (error) {
      const connectionDurationMs = Date.now() - connectStartTime
      logEvent('tengu_mcp_server_connection_failed', {
        connectionDurationMs,
        totalServers: serverStats?.totalServers || 1,
        stdioCount:
          serverStats?.stdioCount || (serverRef.type === 'stdio' ? 1 : 0),
        sseCount: serverStats?.sseCount || (serverRef.type === 'sse' ? 1 : 0),
        httpCount:
          serverStats?.httpCount || (serverRef.type === 'http' ? 1 : 0),
        sseIdeCount:
          serverStats?.sseIdeCount || (serverRef.type === 'sse-ide' ? 1 : 0),
        wsIdeCount:
          serverStats?.wsIdeCount || (serverRef.type === 'ws-ide' ? 1 : 0),
        transportType: (serverRef.type ??
          'stdio') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...mcpBaseUrlAnalytics(serverRef),
      })
      logMCPDebug(
        name,
        `Connection failed after ${connectionDurationMs}ms: ${errorMessage(error)}`,
      )
      logMCPError(name, `Connection failed: ${errorMessage(error)}`)

      if (inProcessServer) {
        inProcessServer.close().catch(() => {})
      }
      // 【中文补充】failed 状态：带上 error 字符串给用户看。注意函数结尾没有再抛异常，
      // 也就是说 connectToServer 的返回值里「失败」是一种正常结果。
      return {
        name,
        type: 'failed' as const,
        config: serverRef,
        error: errorMessage(error),
      }
    }
  },
  getServerCacheKey,
)

/**
 * 【中文补充】清掉某个 server 的连接缓存，并顺手把已建立的连接关掉。
 * 用在「重连」和「配置变更」两种场景：不清缓存的话，connectToServer 会直接返回旧连接，改了配置也不生效。
 * @param name server 名
 * @param serverRef server 配置（用于算缓存 key）
 */
/**
 * Clears the memoize cache for a specific server
 * @param name Server name
 * @param serverRef Server configuration
 */
export async function clearServerCache(
  name: string,
  serverRef: ScopedMcpServerConfig,
): Promise<void> {
  const key = getServerCacheKey(name, serverRef)

  try {
    const wrappedClient = await connectToServer(name, serverRef)

    if (wrappedClient.type === 'connected') {
      await wrappedClient.cleanup()
    }
  } catch {
    // Ignore errors - server might have failed to connect
  }

  // Clear from cache (both connection and fetch caches so reconnect
  // fetches fresh tools/resources/commands instead of stale ones)
  connectToServer.cache.delete(key)
  fetchToolsForClient.cache.delete(name)
  fetchResourcesForClient.cache.delete(name)
  fetchCommandsForClient.cache.delete(name)
  if (feature('MCP_SKILLS')) {
    fetchMcpSkillsForClient!.cache.delete(name)
  }
}

/**
 * 【中文补充】每次真正要用连接之前都过一遍这个函数，确保拿到的是**活着的**连接。
 * 为什么需要：上面的 onclose 会在断线时清掉缓存，但已经发给模型的工具列表里还持有旧的 client 对象；
 *   调用时重新走一次 connectToServer，缓存被清了就会自动重连，缓存还在就复用（零成本）。
 * 特例：sdk 类型的 server 跑在本进程里，不存在「断线」，直接原样返回。
 * @param client 之前拿到的已连接对象
 * @returns 一个保证可用的 ConnectedMCPServer
 * @throws 重连后仍不是 connected 状态时抛错（往上冒泡成工具调用失败）
 */
/**
 * Ensures a valid connected client for an MCP server.
 * For most server types, uses the memoization cache if available, or reconnects
 * if the cache was cleared (e.g., after onclose). This ensures tool/resource
 * calls always use a valid connection.
 *
 * SDK MCP servers run in-process and are handled separately via setupSdkMcpClients,
 * so they are returned as-is without going through connectToServer.
 *
 * @param client The connected MCP server client
 * @returns Connected MCP server client (same or reconnected)
 * @throws Error if server cannot be connected
 */
export async function ensureConnectedClient(
  client: ConnectedMCPServer,
): Promise<ConnectedMCPServer> {
  // SDK MCP servers run in-process and are handled separately via setupSdkMcpClients
  if (client.config.type === 'sdk') {
    return client
  }

  const connectedClient = await connectToServer(client.name, client.config)
  if (connectedClient.type !== 'connected') {
    throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
      `MCP server "${client.name}" is not connected`,
      'MCP server not connected',
    )
  }
  return connectedClient
}

/**
 * 【中文补充】判断两个 server 配置是否等价（用于「配置变了就要重连」的判断）。
 * 做法：把配置序列化成 JSON 字符串再比。
 * 为什么要先剔除 scope 字段：`{ scope: _scopeA, ...configA }` 用了解构 + rest，
 *   把 scope 摘出来扔掉（变量名下划线开头表示「故意不用」），剩下的才拼成 configA ——
 *   scope 只是「这个配置来自哪个作用域」的元数据，换了作用域但连接参数没变就不该重连。
 * Java 对照：`...configA` 展开 ≈ new HashMap<>(old) 的浅拷贝写法。
 */
/**
 * Compares two MCP server configurations to determine if they are equivalent.
 * Used to detect when a server needs to be reconnected due to config changes.
 */
export function areMcpConfigsEqual(
  a: ScopedMcpServerConfig,
  b: ScopedMcpServerConfig,
): boolean {
  // Quick type check first
  if (a.type !== b.type) return false

  // Compare by serializing - this handles all config variations
  // We exclude 'scope' from comparison since it's metadata, not connection config
  const { scope: _scopeA, ...configA } = a
  const { scope: _scopeB, ...configB } = b
  return jsonStringify(configA) === jsonStringify(configB)
}

// 【中文补充】下面三个 fetch 缓存（tools / resources / commands）的容量上限：20 个 server。
// key 用 server **名**而不是连接对象：连接断了会重建，对象引用会变，用名字才能在重连后依然命中/失效。
// 限容量是为了防止接了几十上百个 MCP server 时缓存无限增长（LRU = 最近最少使用淘汰，≈ LinkedHashMap(accessOrder)）。
// Max cache size for fetch* caches. Keyed by server name (stable across
// reconnects), bounded to prevent unbounded growth with many MCP servers.
const MCP_FETCH_CACHE_SIZE = 20

/**
 * 【中文补充】把 MCP 工具的入参编码成一行文本，供「自动模式」的安全分类器判断这次调用危不危险。
 * 没有参数时退化成只返回工具名 —— 至少让分类器知道调的是哪个工具。
 * 导出是为了让自动模式的评测脚本能复用同一套编码逻辑，避免线上线下不一致。
 */
/**
 * Encode MCP tool input for the auto-mode security classifier.
 * Exported so the auto-mode eval scripts can mirror production encoding
 * for `mcp__*` tool stubs without duplicating this logic.
 */
export function mcpToolInputToAutoClassifierInput(
  input: Record<string, unknown>,
  toolName: string,
): string {
  const keys = Object.keys(input)
  return keys.length > 0
    ? keys.map(k => `${k}=${String(input[k])}`).join(' ')
    : toolName
}

/**
 * 【中文补充】拉一个 server 的工具列表（MCP 的 tools/list），并把每个 MCP tool 转成 Claude Code 内部的 Tool。
 * **这是理解 MCP 与主循环结合的关键函数**，转换细节见函数内的中文注释。
 * 结果用 memoizeWithLRU 缓存，key 是 server 名（连接断开时会由 onclose 主动清掉）。
 * @param client 已连接的 server
 * @returns 内部 Tool 数组；未连接 / 不支持 tools / 请求失败时返回空数组（不抛异常，避免一个 server 拖垮全局）
 */
export const fetchToolsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Tool[]> => {
    // 【中文补充】没连上（failed / needs-auth / disabled）就没有工具，返回空数组而不是报错。
    if (client.type !== 'connected') return []

    try {
      // 【中文补充】server 的能力声明里没有 tools 就不去问 tools/list —— 省一次往返，
      // 也避免某些 server 对不支持的方法返回奇怪的错误。
      if (!client.capabilities?.tools) {
        return []
      }

      // 【中文补充】发 MCP 标准请求 tools/list，并用 ListToolsResultSchema 校验返回结构（zod schema ≈ Java 的 Bean Validation）。
      const result = (await client.client.request(
        { method: 'tools/list' },
        ListToolsResultSchema,
      )) as ListToolsResult

      // Sanitize tool data from MCP server
      // 【中文补充】清洗一遍 Unicode：server 返回的字符串可能带不可见字符 / 非法代理对，
    // 直接进 prompt 或写进终端会出问题，所以先统一消毒。
      const toolsToProcess = recursivelySanitizeUnicode(result.tools)

      // Check if we should skip the mcp__ prefix for SDK MCP servers
      // 【中文补充】SDK 场景下可以用环境变量关掉 mcp__ 前缀，让 MCP 工具能按原名「顶替」内置工具；
    // 权限检查仍然靠下面的 mcpInfo 字段来识别它是 MCP 工具。
      const skipPrefix =
        client.config.type === 'sdk' &&
        isEnvTruthy(process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX)

      // Convert MCP tools to our Tool format
      // 【中文补充】★★ 下面就是「MCP tool → Claude Code 内部 Tool」的转换，逐字段说明：
      //   name       —— 统一拼成 `mcp__<server名>__<工具名>`（buildMcpToolName），加前缀是为了
      //                 和内置工具区分开、也方便权限规则精确匹配；
      //   mcpInfo    —— 记住 { serverName, toolName } 原信息，权限判断、日志、重连都靠它；
      //   isMcp      —— 打标记，让主循环知道这是个外部工具（走 MCP 的调用路径）；
      //   inputJSONSchema —— 直接复用 MCP 给的 JSON Schema，模型据此填参数（≈ Java 里把第三方
      //                 OpenAPI 的 schema 转成内部参数定义）；
      //   description() / prompt() —— 给模型看的描述，prompt() 会按 MAX_MCP_DESCRIPTION_LENGTH 截断；
      //   isReadOnly() / isDestructive() / isOpenWorld() —— 读 MCP 的 annotations 提示位
      //                 （readOnlyHint / destructiveHint / openWorldHint），决定权限提示的强弱；
      //   isConcurrencySafe() —— 只读工具才能并发跑，避免两个「写」操作互相踩；
      //   call()      —— **最重要的字段**：真正执行时调用的闭包，见下面 call 处的注释。
      // Java 对照：整个对象字面量 ≈ 一个匿名内部类的实例（一堆回调方法），`...MCPTool` 是
      //   把基础模板的字段先铺开再覆盖（≈ 复制构造 + setter 覆盖），属于「不可变更新」写法。
      return toolsToProcess
        .map((tool): Tool => {
          const fullyQualifiedName = buildMcpToolName(client.name, tool.name)
          return {
            ...MCPTool,
            // In skip-prefix mode, use the original name for model invocation so MCP tools
            // can override builtins by name. mcpInfo is used for permission checking.
            name: skipPrefix ? tool.name : fullyQualifiedName,
            // 【中文补充】mcpInfo 保留「原始」server 名与工具名，因为对外暴露的 name 可能带前缀、也可能被规范化过。
            mcpInfo: { serverName: client.name, toolName: tool.name },
            isMcp: true,
            // Collapse whitespace: _meta is open to external MCP servers, and
            // a newline here would inject orphan lines into the deferred-tool
            // list (formatDeferredToolLine joins on '\n').
            searchHint:
              typeof tool._meta?.['anthropic/searchHint'] === 'string'
                ? tool._meta['anthropic/searchHint']
                    .replace(/\s+/g, ' ')
                    .trim() || undefined
                : undefined,
            alwaysLoad: tool._meta?.['anthropic/alwaysLoad'] === true,
            // 【中文补充】description() 和 prompt() 都是**方法**而不是字段：
            //   延迟到真正需要时才计算（有的 server 描述很长，平时没必要一直占着内存）。
            //   `async` 方法 ≈ Java 里返回 CompletableFuture<String> 的方法。
            async description() {
              return tool.description ?? ''
            },
            async prompt() {
              const desc = tool.description ?? ''
              return desc.length > MAX_MCP_DESCRIPTION_LENGTH
                ? desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
                : desc
            },
            // 【中文补充】只读的工具才允许并发执行 —— 两个「写」操作并发跑可能互相覆盖结果。
            // `?? false` 是空值合并：annotations 或 readOnlyHint 没给（undefined）就当 false（保守起见按「有副作用」处理）。
            isConcurrencySafe() {
              return tool.annotations?.readOnlyHint ?? false
            },
            isReadOnly() {
              return tool.annotations?.readOnlyHint ?? false
            },
            toAutoClassifierInput(input) {
              return mcpToolInputToAutoClassifierInput(input, tool.name)
            },
            // 【中文补充】destructiveHint（有破坏性）/ openWorldHint（会访问外部世界）来自 MCP 的 annotations，
            // 用来决定给用户的权限提示要不要更醒目。server 不声明时按 false 处理。
            isDestructive() {
              return tool.annotations?.destructiveHint ?? false
            },
            isOpenWorld() {
              return tool.annotations?.openWorldHint ?? false
            },
            isSearchOrReadCommand() {
              return classifyMcpToolForCollapse(client.name, tool.name)
            },
            // 【中文补充】把 MCP 工具自带的 JSON Schema 原样交给模型，作为填参数的依据。
            // `as Tool['inputJSONSchema']` 是类型断言：两边的 schema 类型结构上等价但声明不同，断言一下即可（≈ 强转）。
            inputJSONSchema: tool.inputSchema as Tool['inputJSONSchema'],
            async checkPermissions() {
              return {
                behavior: 'passthrough' as const,
                message: 'MCPTool requires permission.',
                suggestions: [
                  {
                    type: 'addRules' as const,
                    rules: [
                      {
                        toolName: fullyQualifiedName,
                        ruleContent: undefined,
                      },
                    ],
                    behavior: 'allow' as const,
                    destination: 'localSettings' as const,
                  },
                ],
              }
            },
            // 【中文补充】★★ call()：模型真的要调用这个工具时走这里，流程是
            //   ① 从父消息里取出 toolUseId（把这次调用和界面上的进度条对上）；
            //   ② ensureConnectedClient 确保连接活着（断了就重连）；
            //   ③ callMCPToolWithUrlElicitationRetry 发真正的 tools/call，并处理 server 要求用户去网页授权的场合；
            //   ④ 会话过期（session 失效）时自动重连重试一次（最多 MAX_SESSION_RETRIES 次）。
            async call(
              args: Record<string, unknown>,
              context,
              _canUseTool,
              parentMessage,
              onProgress?: ToolCallProgress<MCPProgress>,
            ) {
              const toolUseId = extractToolUseId(parentMessage)
              const meta = toolUseId
                ? { 'claudecode/toolUseId': toolUseId }
                : {}

              // Emit progress when tool starts
              if (onProgress && toolUseId) {
                onProgress({
                  toolUseID: toolUseId,
                  data: {
                    type: 'mcp_progress',
                    status: 'started',
                    serverName: client.name,
                    toolName: tool.name,
                  },
                })
              }

              const startTime = Date.now()
              const MAX_SESSION_RETRIES = 1
              // 【中文补充】`for (let attempt = 0; ; attempt++)` 中间的条件是空的，即**无限循环**，
              // 靠内部 return（成功）或抛出（重试次数用完）退出 —— 用它是因为重试次数要按「错误类型」分别判断。
              for (let attempt = 0; ; attempt++) {
                try {
                  const connectedClient = await ensureConnectedClient(client)
                  const mcpResult = await callMCPToolWithUrlElicitationRetry({
                    client: connectedClient,
                    clientConnection: client,
                    tool: tool.name,
                    args,
                    meta,
                    signal: context.abortController.signal,
                    setAppState: context.setAppState,
                    onProgress:
                      onProgress && toolUseId
                        ? progressData => {
                            onProgress({
                              toolUseID: toolUseId,
                              data: progressData,
                            })
                          }
                        : undefined,
                    handleElicitation: context.handleElicitation,
                  })

                  // Emit progress when tool completes successfully
                  if (onProgress && toolUseId) {
                    onProgress({
                      toolUseID: toolUseId,
                      data: {
                        type: 'mcp_progress',
                        status: 'completed',
                        serverName: client.name,
                        toolName: tool.name,
                        elapsedTimeMs: Date.now() - startTime,
                      },
                    })
                  }

                  return {
                    data: mcpResult.content,
                    ...((mcpResult._meta || mcpResult.structuredContent) && {
                      mcpMeta: {
                        ...(mcpResult._meta && {
                          _meta: mcpResult._meta,
                        }),
                        ...(mcpResult.structuredContent && {
                          structuredContent: mcpResult.structuredContent,
                        }),
                      },
                    }),
                  }
                } catch (error) {
                  // Session expired — the connection cache has been
                  // cleared, so retry with a fresh client.
                  if (
                    error instanceof McpSessionExpiredError &&
                    attempt < MAX_SESSION_RETRIES
                  ) {
                    logMCPDebug(
                      client.name,
                      `Retrying tool '${tool.name}' after session recovery`,
                    )
                    continue
                  }

                  // Emit progress when tool fails
                  if (onProgress && toolUseId) {
                    onProgress({
                      toolUseID: toolUseId,
                      data: {
                        type: 'mcp_progress',
                        status: 'failed',
                        serverName: client.name,
                        toolName: tool.name,
                        elapsedTimeMs: Date.now() - startTime,
                      },
                    })
                  }
                  // Wrap MCP SDK errors so telemetry gets useful context
                  // instead of just "Error" or "McpError" (the constructor
                  // name). MCP SDK errors are protocol-level messages and
                  // don't contain user file paths or code.
                  if (
                    error instanceof Error &&
                    !(
                      error instanceof
                      TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
                    )
                  ) {
                    const name = error.constructor.name
                    if (name === 'Error') {
                      throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                        error.message,
                        error.message.slice(0, 200),
                      )
                    }
                    // McpError has a numeric `code` with the JSON-RPC error
                    // code (e.g. -32000 ConnectionClosed, -32001 RequestTimeout)
                    if (
                      name === 'McpError' &&
                      'code' in error &&
                      typeof error.code === 'number'
                    ) {
                      throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
                        error.message,
                        `McpError ${error.code}`,
                      )
                    }
                  }
                  throw error
                }
              }
            },
            userFacingName() {
              // Prefer title annotation if available, otherwise use tool name
              const displayName = tool.annotations?.title || tool.name
              return `${client.name} - ${displayName} (MCP)`
            },
            ...(isClaudeInChromeMCPServer(client.name) &&
            (client.config.type === 'stdio' || !client.config.type)
              ? claudeInChromeToolRendering().getClaudeInChromeMCPToolOverrides(
                  tool.name,
                )
              : {}),
            ...(feature('CHICAGO_MCP') &&
            (client.config.type === 'stdio' || !client.config.type) &&
            isComputerUseMCPServer!(client.name)
              ? computerUseWrapper!().getComputerUseMCPToolOverrides(tool.name)
              : {}),
          }
        })
        // 【中文补充】最后按 IDE 白名单过滤一遍（见 isIncludedMcpTool），把 IDE 内部工具挡在模型视野之外。
        .filter(isIncludedMcpTool)
    } catch (error) {
      logMCPError(client.name, `Failed to fetch tools: ${errorMessage(error)}`)
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

/**
 * 【中文补充】拉 resource 列表（MCP 的 resources/list），比如文件、数据库记录这类「可被读取的资源」。
 * 每个 resource 上补一个 server 字段，标记它来自哪个 MCP server（原返回里没有这个信息）。
 * 同样做了缓存；server 不支持 resources 时直接返回空数组。
 */
export const fetchResourcesForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<ServerResource[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.resources) {
        return []
      }

      const result = await client.client.request(
        { method: 'resources/list' },
        ListResourcesResultSchema,
      )

      if (!result.resources) return []

      // Add server name to each resource
      return result.resources.map(resource => ({
        ...resource,
        server: client.name,
      }))
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch resources: ${errorMessage(error)}`,
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

/**
 * 【中文补充】拉 prompt 列表（MCP 的 prompts/list），并转成内部的 Command（斜杠命令）。
 * 命名规则和工具一样：`mcp__<server>__<prompt名>`，用户就能用 /mcp__xxx__yyy 这样的斜杠命令触发。
 */
export const fetchCommandsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.prompts) {
        return []
      }

      // Request prompts list from client
      const result = (await client.client.request(
        { method: 'prompts/list' },
        ListPromptsResultSchema,
      )) as ListPromptsResult

      if (!result.prompts) return []

      // Sanitize prompt data from MCP server
      const promptsToProcess = recursivelySanitizeUnicode(result.prompts)

      // Convert MCP prompts to our Command format
      // 【中文补充】MCP 的 prompt 在这里被当成**斜杠命令**暴露给用户：
      //   name    —— 加 mcp__<server>__ 前缀，避免和内置命令撞名；
      //   arguments —— prompt 声明的入参名列表，用户在命令后面填；
      //   contentLength: 0 —— 内容长度是动态的（要真正执行才知道），这里先写 0。
      return promptsToProcess.map(prompt => {
        const argNames = Object.values(prompt.arguments ?? {}).map(k => k.name)
        return {
          type: 'prompt' as const,
          name: 'mcp__' + normalizeNameForMCP(client.name) + '__' + prompt.name,
          description: prompt.description ?? '',
          hasUserSpecifiedDescription: !!prompt.description,
          contentLength: 0, // Dynamic MCP content
          isEnabled: () => true,
          isHidden: false,
          isMcp: true,
          progressMessage: 'running',
          userFacingName() {
            // Use prompt.name (programmatic identifier) not prompt.title (display name)
            // to avoid spaces breaking slash command parsing
            return `${client.name}:${prompt.name} (MCP)`
          },
          argNames,
          source: 'mcp',
          async getPromptForCommand(args: string) {
            const argsArray = args.split(' ')
            try {
              const connectedClient = await ensureConnectedClient(client)
              const result = await connectedClient.client.getPrompt({
                name: prompt.name,
                arguments: zipObject(argNames, argsArray),
              })
              const transformed = await Promise.all(
                result.messages.map(message =>
                  transformResultContent(message.content, connectedClient.name),
                ),
              )
              return transformed.flat()
            } catch (error) {
              logMCPError(
                client.name,
                `Error running command '${prompt.name}': ${errorMessage(error)}`,
              )
              throw error
            }
          },
        }
      })
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch commands: ${errorMessage(error)}`,
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)

/**
 * 【中文补充】把 IDE 的工具当成一次「远程过程调用」直接调用（不经过模型），
 * 主要用于诊断类功能（比如拉一下当前文件的报错列表）。
 * @param toolName IDE 工具名
 * @param args 工具入参
 * @param client IDE 对应的已连接 server
 * @returns 工具返回的内容块（字符串或内容块数组）
 */
/**
 * Call an IDE tool directly as an RPC
 * @param toolName The name of the tool to call
 * @param args The arguments to pass to the tool
 * @param client The IDE client to use for the RPC call
 * @returns The result of the tool call
 */
export async function callIdeRpc(
  toolName: string,
  args: Record<string, unknown>,
  client: ConnectedMCPServer,
): Promise<string | ContentBlockParam[] | undefined> {
  const result = await callMCPTool({
    client,
    tool: toolName,
    args,
    signal: createAbortController().signal,
  })
  return result.content
}

/**
 * 【中文补充】「重连某个 server」的实现（/mcp 界面里的重连按钮、以及 OAuth 完成后都会走这里）。
 * 步骤：① 清掉连接缓存 → ② 重新连接 → ③ 重新拉 tools / commands / skills / resources → ④ 返回给 UI。
 * 注意：UI 组件**不应该**直接调它，应该用 useManageMCPConnections 里的 reconnectMcpServer（那边会顺带更新 React 状态）。
 * 失败时不抛异常，而是返回 type 为 failed 的连接对象和空工具列表，让界面显示「连接失败」。
 */
/**
 * Note: This should not be called by UI components directly, they should use the reconnectMcpServer
 * function from useManageMcpConnections.
 * @param name Server name
 * @param config Server configuration
 * @returns Object containing the client connection and its resources
 */
export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{
  client: MCPServerConnection
  tools: Tool[]
  commands: Command[]
  resources?: ServerResource[]
}> {
  try {
    // Invalidate the keychain cache so we read fresh credentials from disk.
    // This is necessary when another process (e.g. the VS Code extension host)
    // has modified stored tokens (cleared auth, saved new OAuth tokens) and then
    // asks the CLI subprocess to reconnect.  Without this, the subprocess would
    // use stale cached data and never notice the tokens were removed.
    clearKeychainCache()

    await clearServerCache(name, config)
    const client = await connectToServer(name, config)

    if (client.type !== 'connected') {
      return {
        client,
        tools: [],
        commands: [],
      }
    }

    if (config.type === 'claudeai-proxy') {
      markClaudeAiMcpConnected(name)
    }

    const supportsResources = !!client.capabilities?.resources

    const [tools, mcpCommands, mcpSkills, resources] = await Promise.all([
      fetchToolsForClient(client),
      fetchCommandsForClient(client),
      feature('MCP_SKILLS') && supportsResources
        ? fetchMcpSkillsForClient!(client)
        : Promise.resolve([]),
      supportsResources ? fetchResourcesForClient(client) : Promise.resolve([]),
    ])
    const commands = [...mcpCommands, ...mcpSkills]

    // Check if we need to add resource tools
    // 【中文补充】只有当这个 server 支持 resources 时，才补上「列出资源 / 读取资源」两个内置工具；
    // 而且只补一次（多个 server 都支持时不能重复添加）—— 用 hasResourceTools 先查一遍已有的工具列表。
    const resourceTools: Tool[] = []
    if (supportsResources) {
      // Only add resource tools if no other server has them
      const hasResourceTools = [ListMcpResourcesTool, ReadMcpResourceTool].some(
        tool => tools.some(t => toolMatchesName(t, tool.name)),
      )
      if (!hasResourceTools) {
        resourceTools.push(ListMcpResourcesTool, ReadMcpResourceTool)
      }
    }

    return {
      client,
      tools: [...tools, ...resourceTools],
      commands,
      resources: resources.length > 0 ? resources : undefined,
    }
  } catch (error) {
    // Handle errors gracefully - connection might have closed during fetch
    logMCPError(name, `Error during reconnection: ${errorMessage(error)}`)

    // Return with failed status
    return {
      client: { name, type: 'failed' as const, config },
      tools: [],
      commands: [],
    }
  }
}

/**
 * 【中文补充】带并发上限地处理一批任务。
 * 为什么用 pMap 而不是「固定批次」：固定批次是「第 1 批全部跑完才开第 2 批」，
 *   一个慢 server 会把它后面整批都堵住；pMap 是「空出一个坑就补一个」，并发上限一样但调度更划算。
 * Java 对照：≈ 固定线程池 + 提交 N 个任务，但不是 CompletableFuture.allOf 那种一次性全放。
 */
// Replaced 2026-03: previous implementation ran fixed-size sequential batches
// (await batch 1 fully, then start batch 2). That meant one slow server in
// batch N held up ALL servers in batch N+1, even if the other 19 slots were
// idle. pMap frees each slot as soon as its server completes, so a single
// slow server only occupies one slot instead of blocking an entire batch
// boundary. Same concurrency ceiling, same results, better scheduling.
async function processBatched<T>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<void>,
): Promise<void> {
  await pMap(items, processor, { concurrency })
}

/**
 * 【中文补充】启动时（或配置变更后）连接**所有** MCP server 的总入口。
 * 流程：
 *   ① 读配置 → 把被禁用的 server 直接标成 disabled，不建连接；
 *   ② 统计各传输类型的数量（只用于遥测）；
 *   ③ 按本地/远程拆成两组，用不同并发度并行连接（本地慢、要 fork 进程，所以并发小）；
 *   ④ 每连好一个就回调 onConnectionAttempt，让 UI 可以「陆续显示」而不是等全部完成。
 * @param onConnectionAttempt 每个 server 有结果时的回调（连接对象 + 工具 + 命令 + 资源）
 * @param mcpConfigs 可选，不传就自己去 config.ts 读全量配置
 */
export async function getMcpToolsCommandsAndResources(
  onConnectionAttempt: (params: {
    client: MCPServerConnection
    tools: Tool[]
    commands: Command[]
    resources?: ServerResource[]
  }) => void,
  mcpConfigs?: Record<string, ScopedMcpServerConfig>,
): Promise<void> {
  let resourceToolsAdded = false

  const allConfigEntries = Object.entries(
    mcpConfigs ?? (await getAllMcpConfigs()).servers,
  )

  // Partition into disabled and active entries — disabled servers should
  // never generate HTTP connections or flow through batch processing
  // 【中文补充】被禁用的 server 完全不碰：既不建 HTTP 连接，也不进并发批次，
  // 只是生成一个 disabled 状态的结果，让 UI 上还能看到它（用户可以去启用）。
  const configEntries: typeof allConfigEntries = []
  for (const entry of allConfigEntries) {
    if (isMcpServerDisabled(entry[0])) {
      onConnectionAttempt({
        client: { name: entry[0], type: 'disabled', config: entry[1] },
        tools: [],
        commands: [],
      })
    } else {
      configEntries.push(entry)
    }
  }

  // 【中文补充】下面几个 count(...) 只是统计各传输类型的数量，纯粹为了遥测；
  // `([_, c]) => c.type === 'stdio'` 里的 `_` 是「这个位置我不用」的惯用写法。
  // Calculate transport counts for logging
  const totalServers = configEntries.length
  const stdioCount = count(configEntries, ([_, c]) => c.type === 'stdio')
  const sseCount = count(configEntries, ([_, c]) => c.type === 'sse')
  const httpCount = count(configEntries, ([_, c]) => c.type === 'http')
  const sseIdeCount = count(configEntries, ([_, c]) => c.type === 'sse-ide')
  const wsIdeCount = count(configEntries, ([_, c]) => c.type === 'ws-ide')

  // 【中文补充】本地与远程分开跑，原因是「慢」的性质不同：
  // 本地要 fork 子进程（吃 CPU / 文件描述符），并发必须小；远程只是网络往返，可以一次开很多。
  // Split servers by type: local (stdio/sdk) need lower concurrency due to
  // process spawning, remote servers can connect with higher concurrency
  const localServers = configEntries.filter(([_, config]) =>
    isLocalMcpServer(config),
  )
  const remoteServers = configEntries.filter(
    ([_, config]) => !isLocalMcpServer(config),
  )

  const serverStats = {
    totalServers,
    stdioCount,
    sseCount,
    httpCount,
    sseIdeCount,
    wsIdeCount,
  }

  // 【中文补充】真正处理单个 server 的闭包。每个 server 独立 try/catch：
  // 一个 server 出问题绝不能影响其它 server 的连接（≈ Java 里每个任务自己 try，不往线程池外抛）。
  const processServer = async ([name, config]: [
    string,
    ScopedMcpServerConfig,
  ]): Promise<void> => {
    try {
      // Check if server is disabled - if so, just add it to state without connecting
      // 【中文补充】再查一次是否被禁用 —— 因为从读配置到现在可能已经过了若干 await，状态可能变了。
      if (isMcpServerDisabled(name)) {
        onConnectionAttempt({
          client: {
            name,
            type: 'disabled',
            config,
          },
          tools: [],
          commands: [],
        })
        return
      }

      // Skip connection for servers that recently returned 401 (15min TTL),
      // or that we have probed before but hold no token for. The second
      // check closes the gap the TTL leaves open: without it, every 15min
      // we re-probe servers that cannot succeed until the user runs /mcp.
      // Each probe is a network round-trip for connect-401 plus OAuth
      // discovery, and print mode awaits the whole batch (main.tsx:3503).
      // 【中文补充】跳过「刚刚 401 过」或「探测过但根本没 token」的远程 server：
      // 每次无效探测都是一次网络往返 + OAuth 服务发现，批量启动时累积起来很慢，
      // 而且 print 模式会等整批结束，用户会觉得卡。
      if (
        (config.type === 'claudeai-proxy' ||
          config.type === 'http' ||
          config.type === 'sse') &&
        ((await isMcpAuthCached(name)) ||
          ((config.type === 'http' || config.type === 'sse') &&
            hasMcpDiscoveryButNoToken(name, config)))
      ) {
        logMCPDebug(name, `Skipping connection (cached needs-auth)`)
        onConnectionAttempt({
          client: { name, type: 'needs-auth' as const, config },
          tools: [createMcpAuthTool(name, config)],
          commands: [],
        })
        return
      }

      // 【中文补充】真正发起连接。拿到结果后先判状态：非 connected（failed / needs-auth）就只把状态报给 UI，
      // needs-auth 时额外塞一个「去授权」的工具，让模型/用户有入口完成 OAuth。
      const client = await connectToServer(name, config, serverStats)

      if (client.type !== 'connected') {
        onConnectionAttempt({
          client,
          tools:
            client.type === 'needs-auth'
              ? [createMcpAuthTool(name, config)]
              : [],
          commands: [],
        })
        return
      }

      if (config.type === 'claudeai-proxy') {
        markClaudeAiMcpConnected(name)
      }

      // 【中文补充】并发拉四类东西：tools / commands / skills / resources，
      // 但它们内部各自有缓存，所以实际只在第一次真正发请求（≈ Java 的 CompletableFuture.allOf）。
      const supportsResources = !!client.capabilities?.resources

      const [tools, mcpCommands, mcpSkills, resources] = await Promise.all([
        fetchToolsForClient(client),
        fetchCommandsForClient(client),
        // Discover skills from skill:// resources
        feature('MCP_SKILLS') && supportsResources
          ? fetchMcpSkillsForClient!(client)
          : Promise.resolve([]),
        // Fetch resources if supported
        supportsResources
          ? fetchResourcesForClient(client)
          : Promise.resolve([]),
      ])
      const commands = [...mcpCommands, ...mcpSkills]

      // If this server resources and we haven't added resource tools yet,
      // include our resource tools with this client's tools
      const resourceTools: Tool[] = []
      if (supportsResources && !resourceToolsAdded) {
        resourceToolsAdded = true
        resourceTools.push(ListMcpResourcesTool, ReadMcpResourceTool)
      }

      onConnectionAttempt({
        client,
        tools: [...tools, ...resourceTools],
        commands,
        resources: resources.length > 0 ? resources : undefined,
      })
    } catch (error) {
      // Handle errors gracefully - connection might have closed during fetch
      logMCPError(
        name,
        `Error fetching tools/commands/resources: ${errorMessage(error)}`,
      )

      // Still update with the client but no tools/commands
      onConnectionAttempt({
        client: { name, type: 'failed' as const, config },
        tools: [],
        commands: [],
      })
    }
  }

  // Process both groups concurrently, each with their own concurrency limits:
  // - Local servers (stdio/sdk): lower concurrency to avoid process spawning resource contention
  // - Remote servers: higher concurrency since they're just network connections
  await Promise.all([
    processBatched(
      localServers,
      getMcpServerConnectionBatchSize(),
      processServer,
    ),
    processBatched(
      remoteServers,
      getRemoteMcpServerConnectionBatchSize(),
      processServer,
    ),
  ])
}

/**
 * 【中文补充】启动时「预取」所有 MCP 资源的入口，本质是上面 getMcpToolsCommandsAndResources 的 Promise 包装
 * （那边是回调式的，这里是等全部完成后一次性 resolve）。
 * 为什么**不**给这个函数加缓存：它本身只在启动/重配置时调 2~3 次，内部的 connectToServer、fetch* 已经各自缓存了；
 * 而且调用方每次都新建配置对象，按对象引用做 key 的 memoize 永远命中不了。
 */
// Not memoized: called only 2-3 times at startup/reconfig. The inner work
// (connectToServer, fetch*ForClient) is already cached. Memoizing here by
// mcpConfigs object ref leaked — main.tsx creates fresh config objects each call.
export function prefetchAllMcpResources(
  mcpConfigs: Record<string, ScopedMcpServerConfig>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
}> {
  return new Promise(resolve => {
    let pendingCount = 0
    let completedCount = 0

    pendingCount = Object.keys(mcpConfigs).length

    if (pendingCount === 0) {
      void resolve({
        clients: [],
        tools: [],
        commands: [],
      })
      return
    }

    const clients: MCPServerConnection[] = []
    const tools: Tool[] = []
    const commands: Command[] = []

    getMcpToolsCommandsAndResources(result => {
      clients.push(result.client)
      tools.push(...result.tools)
      commands.push(...result.commands)

      completedCount++
      if (completedCount >= pendingCount) {
        const commandsMetadataLength = commands.reduce((sum, command) => {
          const commandMetadataLength =
            command.name.length +
            (command.description ?? '').length +
            (command.argumentHint ?? '').length
          return sum + commandMetadataLength
        }, 0)
        logEvent('tengu_mcp_tools_commands_loaded', {
          tools_count: tools.length,
          commands_count: commands.length,
          commands_metadata_length: commandsMetadataLength,
        })

        void resolve({
          clients,
          tools,
          commands,
        })
      }
    }, mcpConfigs).catch(error => {
      logMCPError(
        'prefetchAllMcpResources',
        `Failed to get MCP resources: ${errorMessage(error)}`,
      )
      // Still resolve with empty results
      void resolve({
        clients: [],
        tools: [],
        commands: [],
      })
    })
  })
}

/**
 * 【中文补充】把 MCP 返回的一块内容（工具结果或 prompt 内容）翻译成模型能读的内容块数组。
 * 按 type 分支：text 直接透传；audio / image 先存成文件再回一句「存在哪」（不把大 blob 塞进上下文）；
 * resource / resource_link 要再取一次真正的资源内容。
 * @param resultContent MCP 返回的单块内容
 * @param serverName 来自哪个 server（只在存文件起名字时用）
 * @returns 模型消息用的内容块数组
 */
/**
 * Transform result content from an MCP tool or MCP prompt into message blocks
 */
export async function transformResultContent(
  resultContent: PromptMessage['content'],
  serverName: string,
): Promise<Array<ContentBlockParam>> {
  switch (resultContent.type) {
    case 'text':
      return [
        {
          type: 'text',
          text: resultContent.text,
        },
      ]
    case 'audio': {
      const audioData = resultContent as {
        type: 'audio'
        data: string
        mimeType?: string
      }
      return await persistBlobToTextBlock(
        Buffer.from(audioData.data, 'base64'),
        audioData.mimeType,
        serverName,
        `[Audio from ${serverName}] `,
      )
    }
    case 'image': {
      // Resize and compress image data, enforcing API dimension limits
      const imageBuffer = Buffer.from(String(resultContent.data), 'base64')
      const ext = resultContent.mimeType?.split('/')[1] || 'png'
      const resized = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        ext,
      )
      return [
        {
          type: 'image',
          source: {
            data: resized.buffer.toString('base64'),
            media_type:
              `image/${resized.mediaType}` as Base64ImageSource['media_type'],
            type: 'base64',
          },
        },
      ]
    }
    case 'resource': {
      const resource = resultContent.resource
      const prefix = `[Resource from ${serverName} at ${resource.uri}] `

      if ('text' in resource) {
        return [
          {
            type: 'text',
            text: `${prefix}${resource.text}`,
          },
        ]
      } else if ('blob' in resource) {
        const isImage = IMAGE_MIME_TYPES.has(resource.mimeType ?? '')

        if (isImage) {
          // Resize and compress image blob, enforcing API dimension limits
          const imageBuffer = Buffer.from(resource.blob, 'base64')
          const ext = resource.mimeType?.split('/')[1] || 'png'
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imageBuffer,
            imageBuffer.length,
            ext,
          )
          const content: MessageParam['content'] = []
          if (prefix) {
            content.push({
              type: 'text',
              text: prefix,
            })
          }
          content.push({
            type: 'image',
            source: {
              data: resized.buffer.toString('base64'),
              media_type:
                `image/${resized.mediaType}` as Base64ImageSource['media_type'],
              type: 'base64',
            },
          })
          return content
        } else {
          return await persistBlobToTextBlock(
            Buffer.from(resource.blob, 'base64'),
            resource.mimeType,
            serverName,
            prefix,
          )
        }
      }
      return []
    }
    case 'resource_link': {
      const resourceLink = resultContent as ResourceLink
      let text = `[Resource link: ${resourceLink.name}] ${resourceLink.uri}`
      if (resourceLink.description) {
        text += ` (${resourceLink.description})`
      }
      return [
        {
          type: 'text',
          text,
        },
      ]
    }
    default:
      return []
  }
}

/**
 * 【中文补充】把二进制内容（图片/音频）写到磁盘，然后只回一小段「已保存到 xxx 路径」的文本。
 * 为什么不直接把 base64 塞进上下文：base64 会让 token 数膨胀约 33%，而且模型也看不懂原始字节；
 * 存成文件后模型可以用 Read 工具按需读取，成本可控得多。
 */
/**
 * Decode base64 binary content, write it to disk with the proper extension,
 * and return a small text block with the file path. Replaces the old behavior
 * of dumping raw base64 into the context.
 */
async function persistBlobToTextBlock(
  bytes: Buffer,
  mimeType: string | undefined,
  serverName: string,
  sourceDescription: string,
): Promise<Array<ContentBlockParam>> {
  const persistId = `mcp-${normalizeNameForMCP(serverName)}-blob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const result = await persistBinaryContent(bytes, mimeType, persistId)

  if ('error' in result) {
    return [
      {
        type: 'text',
        text: `${sourceDescription}Binary content (${mimeType || 'unknown type'}, ${bytes.length} bytes) could not be saved to disk: ${result.error}`,
      },
    ]
  }

  return [
    {
      type: 'text',
      text: getBinaryBlobSavedMessage(
        result.filepath,
        mimeType,
        result.size,
        sourceDescription,
      ),
    },
  ]
}

// 【中文补充】MCP 工具返回值的三种形态（判别联合，≈ Java 的 enum / sealed interface）：
//   toolResult        —— 非标准字段，有些 server 会把结果整个塞在 toolResult 里；
//   structuredContent —— 结构化结果（MCP 规范建议的方式，带 JSON Schema）；
//   contentArray      —— 最传统的 content: [...] 内容块数组。
// 三种都要兼容，因为现实中的 MCP server 实现参差不齐。
/**
 * Processes MCP tool result into a normalized format.
 */
export type MCPResultType = 'toolResult' | 'structuredContent' | 'contentArray'

// 【中文补充】transformMCPResult 的输出：规范化的内容 + 它是哪种形态 + 推断出的紧凑 schema 描述。
// `schema?: string` 的问号表示**可选字段**（≈ Java 里可能为 null 的字段，但 TS 会强制你判空才能用）。
export type TransformedMCPResult = {
  content: MCPToolResult
  type: MCPResultType
  schema?: string
}

/**
 * 【中文补充】给一个值生成紧凑的「类型签名」字符串，例如 `{title: string, items: [{id: number}]}`，
 * 目的是告诉模型「这份数据长什么样」，方便它自己写 jq 去取字段，而不用把整份数据都读进来。
 * depth 控制递归深度：默认只看两层，再深就写 `{...}`，避免签名自己变得巨大。
 */
/**
 * Generates a compact, jq-friendly type signature for a value.
 * e.g. "{title: string, items: [{id: number, name: string}]}"
 */
export function inferCompactSchema(value: unknown, depth = 2): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${inferCompactSchema(value[0], depth - 1)}]`
  }
  if (typeof value === 'object') {
    if (depth <= 0) return '{...}'
    const entries = Object.entries(value).slice(0, 10)
    const props = entries.map(
      ([k, v]) => `${k}: ${inferCompactSchema(v, depth - 1)}`,
    )
    const suffix = Object.keys(value).length > 10 ? ', ...' : ''
    return `{${props.join(', ')}${suffix}}`
  }
  return typeof value
}

/**
 * 【中文补充】把 MCP 的原始返回值归一化成上面的三种形态之一（兼容各种不规范的 server）。
 * @param result SDK 返回的原始结果（类型是 unknown，必须先做形状检查才能安全访问字段）
 * @param tool 工具名（只用于错误信息和日志）
 * @param name server 名（同上）
 * @returns 规范化后的内容和类型标记；实在认不出来就按 contentArray 处理并兜一个文本
 */
export async function transformMCPResult(
  result: unknown,
  tool: string, // Tool name for validation (e.g., "search")
  name: string, // Server name for transformation (e.g., "slack")
): Promise<TransformedMCPResult> {
  if (result && typeof result === 'object') {
    if ('toolResult' in result) {
      return {
        content: String(result.toolResult),
        type: 'toolResult',
      }
    }

    if (
      'structuredContent' in result &&
      result.structuredContent !== undefined
    ) {
      return {
        content: jsonStringify(result.structuredContent),
        type: 'structuredContent',
        schema: inferCompactSchema(result.structuredContent),
      }
    }

    if ('content' in result && Array.isArray(result.content)) {
      const transformedContent = (
        await Promise.all(
          result.content.map(item => transformResultContent(item, name)),
        )
      ).flat()
      return {
        content: transformedContent,
        type: 'contentArray',
        schema: inferCompactSchema(transformedContent),
      }
    }
  }

  const errorMessage = `MCP server "${name}" tool "${tool}": unexpected response format`
  logMCPError(name, errorMessage)
  throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    errorMessage,
    'MCP tool unexpected response format',
  )
}

/**
 * 【中文补充】判断内容里有没有图片块。
 * 用途：结果很大时本可以存成文件，但**图片例外** —— 存成 JSON 会破坏图片压缩、也没法预览，
 * 所以图片走「截断」而不是「存文件」。
 */
/**
 * Check if MCP content contains any image blocks.
 * Used to decide whether to persist to file (images should use truncation instead
 * to preserve image compression and viewability).
 */
function contentContainsImages(content: MCPToolResult): boolean {
  if (!content || typeof content === 'string') {
    return false
  }
  return content.some(block => block.type === 'image')
}

/**
 * 【中文补充】处理已规范化的 MCP 结果，重点是**体积控制**：
 *   ① ide server 的结果不进模型，直接返回，不用处理；
 *   ② 不大的直接返回；
 *   ③ 太大且开了大文件开关 → 存到磁盘，返回「文件在哪 + 怎么用 jq 取字段」的指引；
 *   ④ 太大但没开开关、或内容含图片 → 退化成截断。
 * @param result 已规范化的结果
 * @param tool 工具名
 * @param name server 名
 * @returns 给模型看的内容块数组
 */
export async function processMCPResult(
  result: unknown,
  tool: string, // Tool name for validation (e.g., "search")
  name: string, // Server name for IDE check and transformation (e.g., "slack")
): Promise<MCPToolResult> {
  const { content, type, schema } = await transformMCPResult(result, tool, name)

  // IDE tools are not going to the model directly, so we don't need to
  // handle large output.
  if (name === 'ide') {
    return content
  }

  // Check if content needs truncation (i.e., is too large)
  if (!(await mcpContentNeedsTruncation(content))) {
    return content
  }

  const sizeEstimateTokens = getContentSizeEstimate(content)

  // If large output files feature is disabled, fall back to old truncation behavior
  if (isEnvDefinedFalsy(process.env.ENABLE_MCP_LARGE_OUTPUT_FILES)) {
    logEvent('tengu_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'env_disabled',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    return await truncateMcpContentIfNeeded(content)
  }

  // Save large output to file and return instructions for reading it
  // Content is guaranteed to exist at this point (we checked mcpContentNeedsTruncation)
  if (!content) {
    return content
  }

  // If content contains images, fall back to truncation - persisting images as JSON
  // defeats the image compression logic and makes them non-viewable
  if (contentContainsImages(content)) {
    logEvent('tengu_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'contains_images',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    return await truncateMcpContentIfNeeded(content)
  }

  // Generate a unique ID for the persisted file (server__tool-timestamp)
  const timestamp = Date.now()
  const persistId = `mcp-${normalizeNameForMCP(name)}-${normalizeNameForMCP(tool)}-${timestamp}`
  // Convert to string for persistence (persistToolResult expects string or specific block types)
  const contentStr =
    typeof content === 'string' ? content : jsonStringify(content, null, 2)
  const persistResult = await persistToolResult(contentStr, persistId)

  if (isPersistError(persistResult)) {
    // If file save failed, fall back to returning truncated content info
    const contentLength = contentStr.length
    logEvent('tengu_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'persist_failed',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    return `Error: result (${contentLength.toLocaleString()} characters) exceeds maximum allowed tokens. Failed to save output to file: ${persistResult.error}. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data.`
  }

  logEvent('tengu_mcp_large_result_handled', {
    outcome: 'persisted',
    reason: 'file_saved',
    sizeEstimateTokens,
    persistedSizeChars: persistResult.originalSize,
  } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

  const formatDescription = getFormatDescription(type, schema)
  return getLargeOutputInstructions(
    persistResult.filepath,
    persistResult.originalSize,
    formatDescription,
  )
}

// 【中文补充】一次 MCP 工具调用的返回结构：内容 + 可选的 _meta + 可选的 structuredContent。
// 后面带 `?` 的都是可选字段 —— TS 里可选 ≈ Java 里 @Nullable，读之前必须判空，否则编译不过。
/**
 * Call an MCP tool, handling UrlElicitationRequiredError (-32042) by
 * displaying the URL elicitation to the user, waiting for the completion
 * notification, and retrying the tool call.
 */
type MCPToolCallResult = {
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}

/** @internal Exported for testing. */
/**
 * 【中文补充】调用 MCP 工具，并处理一种特殊情况：server 返回 -32042（UrlElicitationRequired），
 * 意思是「这个操作需要用户先去某个网页完成授权/确认」。处理方式是 → 把 URL 展示给用户 → 等完成通知 → 自动重试。
 * 为什么要判断 `error.code` 而不是 instanceof：SDK 的 Protocol 对错误响应只会造出普通的 McpError，
 *   并没有带具体的子类类型，所以只能靠 code 认。
 * `callToolFn` 做成可注入参数是为了单测能替换掉真实调用（≈ Java 的构造器注入 mock）。
 */
export async function callMCPToolWithUrlElicitationRetry({
  client: connectedClient,
  clientConnection,
  tool,
  args,
  meta,
  signal,
  setAppState,
  onProgress,
  callToolFn = callMCPTool,
  handleElicitation,
}: {
  client: ConnectedMCPServer
  clientConnection: MCPServerConnection
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  setAppState: (f: (prev: AppState) => AppState) => void
  onProgress?: (data: MCPProgress) => void
  /** Injectable for testing. Defaults to callMCPTool. */
  callToolFn?: (opts: {
    client: ConnectedMCPServer
    tool: string
    args: Record<string, unknown>
    meta?: Record<string, unknown>
    signal: AbortSignal
    onProgress?: (data: MCPProgress) => void
  }) => Promise<MCPToolCallResult>
  /** Handler for URL elicitations when no hook handles them.
   * In print/SDK mode, delegates to structuredIO. In REPL, falls back to queue. */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
}): Promise<MCPToolCallResult> {
  // 【中文补充】URL 引导最多重试 3 次就放弃，防止 server 一直要求授权导致死循环。
  const MAX_URL_ELICITATION_RETRIES = 3
  for (let attempt = 0; ; attempt++) {
    try {
      return await callToolFn({
        client: connectedClient,
        tool,
        args,
        meta,
        signal,
        onProgress,
      })
    } catch (error) {
      // The MCP SDK's Protocol creates plain McpError (not UrlElicitationRequiredError)
      // for error responses, so we check the error code instead of instanceof.
      if (
        !(error instanceof McpError) ||
        error.code !== ErrorCode.UrlElicitationRequired
      ) {
        throw error
      }

      // Limit the number of URL elicitation retries
      if (attempt >= MAX_URL_ELICITATION_RETRIES) {
        throw error
      }

      const errorData = error.data
      const rawElicitations =
        errorData != null &&
        typeof errorData === 'object' &&
        'elicitations' in errorData &&
        Array.isArray(errorData.elicitations)
          ? (errorData.elicitations as unknown[])
          : []

      // Validate each element has the required fields for ElicitRequestURLParams
      const elicitations = rawElicitations.filter(
        (e): e is ElicitRequestURLParams => {
          if (e == null || typeof e !== 'object') return false
          const obj = e as Record<string, unknown>
          return (
            obj.mode === 'url' &&
            typeof obj.url === 'string' &&
            typeof obj.elicitationId === 'string' &&
            typeof obj.message === 'string'
          )
        },
      )

      const serverName =
        clientConnection.type === 'connected'
          ? clientConnection.name
          : 'unknown'

      if (elicitations.length === 0) {
        logMCPDebug(
          serverName,
          `Tool '${tool}' returned -32042 but no valid elicitations in error data`,
        )
        throw error
      }

      logMCPDebug(
        serverName,
        `Tool '${tool}' requires URL elicitation (error -32042, attempt ${attempt + 1}), processing ${elicitations.length} elicitation(s)`,
      )

      // Process each URL elicitation from the error.
      // The completion notification handler (in registerElicitationHandler) sets
      // `completed: true` on the matching queue event; the dialog reacts to this flag.
      for (const elicitation of elicitations) {
        const { elicitationId } = elicitation

        // Run elicitation hooks — they can resolve URL elicitations programmatically
        const hookResponse = await runElicitationHooks(
          serverName,
          elicitation,
          signal,
        )
        if (hookResponse) {
          logMCPDebug(
            serverName,
            `URL elicitation ${elicitationId} resolved by hook: ${jsonStringify(hookResponse)}`,
          )
          if (hookResponse.action !== 'accept') {
            return {
              content: `URL elicitation was ${hookResponse.action === 'decline' ? 'declined' : hookResponse.action + 'ed'} by a hook. The tool "${tool}" could not complete because it requires the user to open a URL.`,
            }
          }
          // Hook accepted — skip the UI and proceed to retry
          continue
        }

        // Resolve the URL elicitation via callback (print/SDK mode) or queue (REPL mode).
        let userResult: ElicitResult
        if (handleElicitation) {
          // Print/SDK mode: delegate to structuredIO which sends a control request
          userResult = await handleElicitation(serverName, elicitation, signal)
        } else {
          // REPL mode: queue for ElicitationDialog with two-phase consent/waiting flow
          const waitingState: ElicitationWaitingState = {
            actionLabel: 'Retry now',
            showCancel: true,
          }
          userResult = await new Promise<ElicitResult>(resolve => {
            const onAbort = () => {
              void resolve({ action: 'cancel' })
            }
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })

            setAppState(prev => ({
              ...prev,
              elicitation: {
                queue: [
                  ...prev.elicitation.queue,
                  {
                    serverName,
                    requestId: `error-elicit-${elicitationId}`,
                    params: elicitation,
                    signal,
                    waitingState,
                    respond: result => {
                      // Phase 1 consent: accept is a no-op (doesn't resolve retry Promise)
                      if (result.action === 'accept') {
                        return
                      }
                      // Decline or cancel: resolve the retry Promise
                      signal.removeEventListener('abort', onAbort)
                      void resolve(result)
                    },
                    onWaitingDismiss: action => {
                      signal.removeEventListener('abort', onAbort)
                      if (action === 'retry') {
                        void resolve({ action: 'accept' })
                      } else {
                        void resolve({ action: 'cancel' })
                      }
                    },
                  },
                ],
              },
            }))
          })
        }

        // Run ElicitationResult hooks — they can modify or block the response
        const finalResult = await runElicitationResultHooks(
          serverName,
          userResult,
          signal,
          'url',
          elicitationId,
        )

        if (finalResult.action !== 'accept') {
          logMCPDebug(
            serverName,
            `User ${finalResult.action === 'decline' ? 'declined' : finalResult.action + 'ed'} URL elicitation ${elicitationId}`,
          )
          return {
            content: `URL elicitation was ${finalResult.action === 'decline' ? 'declined' : finalResult.action + 'ed'} by the user. The tool "${tool}" could not complete because it requires the user to open a URL.`,
          }
        }

        logMCPDebug(
          serverName,
          `Elicitation ${elicitationId} completed, retrying tool call`,
        )
      }

      // Loop back to retry the tool call
    }
  }
}

/**
 * 【中文补充】真正向 MCP server 发 `tools/call` 请求的函数（本文件最底层的调用点）。
 * 三件事：① 起一个每 30 秒的进度日志定时器；② 自己用 Promise.race 加一层超时兜底
 *         （SDK 内置的 timeout 在 SSE 流中断等场景下不生效）；③ 结果交给 processMCPResult 规范化。
 * 参数用的是**对象解构**：`{ client: { client, name, config }, tool, args, ... }`，
 *   左边第一层解开入参对象，里面 `client: { client, name, config }` 又是一次嵌套解构 ——
 *   ≈ Java 里一次性把多个 getter 的结果赋给局部变量。
 */
async function callMCPTool({
  client: { client, name, config },
  tool,
  args,
  meta,
  signal,
  onProgress,
}: {
  client: ConnectedMCPServer
  tool: string
  args: Record<string, unknown>
  meta?: Record<string, unknown>
  signal: AbortSignal
  onProgress?: (data: MCPProgress) => void
}): Promise<{
  content: MCPToolResult
  _meta?: Record<string, unknown>
  structuredContent?: Record<string, unknown>
}> {
  const toolStartTime = Date.now()
  let progressInterval: NodeJS.Timeout | undefined

  try {
    logMCPDebug(name, `Calling MCP tool: ${tool}`)

    // Set up progress logging for long-running tools (every 30 seconds)
    progressInterval = setInterval(
      (startTime, name, tool) => {
        const elapsed = Date.now() - startTime
        const elapsedSeconds = Math.floor(elapsed / 1000)
        const duration = `${elapsedSeconds}s`
        logMCPDebug(name, `Tool '${tool}' still running (${duration} elapsed)`)
      },
      30000, // Log every 30 seconds
      toolStartTime,
      name,
      tool,
    )

    // Use Promise.race with our own timeout to handle cases where SDK's
    // internal timeout doesn't work (e.g., SSE stream breaks mid-request)
    // 【中文补充】超时时间取自 MCP_TOOL_TIMEOUT（默认约等于不超时），同时也会传给 SDK 自己的 timeout 参数。
    const timeoutMs = getMcpToolTimeoutMs()
    let timeoutId: NodeJS.Timeout | undefined

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        (reject, name, tool, timeoutMs) => {
          reject(
            new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `MCP server "${name}" tool "${tool}" timed out after ${Math.floor(timeoutMs / 1000)}s`,
              'MCP tool timeout',
            ),
          )
        },
        timeoutMs,
        reject,
        name,
        tool,
        timeoutMs,
      )
    })

    // 【中文补充】真请求与超时定时器赛跑；`.finally(...)` 里清掉定时器，避免赢了比赛却留下一个悬着的 timer。
    // Java 对照：≈ CompletableFuture.anyOf(...) 之后在 finally 里 shutdown 掉那个超时用的 ScheduledExecutor。
    const result = await Promise.race([
      client.callTool(
        {
          name: tool,
          arguments: args,
          _meta: meta,
        },
        CallToolResultSchema,
        {
          signal,
          timeout: timeoutMs,
          onprogress: onProgress
            ? sdkProgress => {
                onProgress({
                  type: 'mcp_progress',
                  status: 'progress',
                  serverName: name,
                  toolName: tool,
                  progress: sdkProgress.progress,
                  total: sdkProgress.total,
                  progressMessage: sdkProgress.message,
                })
              }
            : undefined,
        },
      ),
      timeoutPromise,
    ]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    })

    // 【中文补充】MCP 工具可以用 `isError: true` 表示「调用本身成功、但业务上失败了」
    // （比如查了个不存在的用户）—— 这时要抛异常把错误文本交给模型，而不是当成系统错误。
    // 抛之前把 _meta 带上（见文件开头 McpToolCallError 的注释）。
    if ('isError' in result && result.isError) {
      let errorDetails = 'Unknown error'
      if (
        'content' in result &&
        Array.isArray(result.content) &&
        result.content.length > 0
      ) {
        const firstContent = result.content[0]
        if (
          firstContent &&
          typeof firstContent === 'object' &&
          'text' in firstContent
        ) {
          errorDetails = firstContent.text
        }
      } else if ('error' in result) {
        // Fallback for legacy error format
        errorDetails = String(result.error)
      }
      logMCPError(name, errorDetails)
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        errorDetails,
        'MCP tool returned error',
        '_meta' in result && result._meta ? { _meta: result._meta } : undefined,
      )
    }
    const elapsed = Date.now() - toolStartTime
    const duration =
      elapsed < 1000
        ? `${elapsed}ms`
        : elapsed < 60000
          ? `${Math.floor(elapsed / 1000)}s`
          : `${Math.floor(elapsed / 60000)}m ${Math.floor((elapsed % 60000) / 1000)}s`

    logMCPDebug(name, `Tool '${tool}' completed successfully in ${duration}`)

    // Log code indexing tool usage
    const codeIndexingTool = detectCodeIndexingFromMcpServerName(name)
    if (codeIndexingTool) {
      logEvent('tengu_code_indexing_tool_used', {
        tool: codeIndexingTool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        source:
          'mcp' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
      })
    }

    // 【中文补充】走到这里说明调用成功：规范化结果后，连同 _meta / structuredContent 一起返回给上层 Tool 对象。
    const content = await processMCPResult(result, tool, name)
    return {
      content,
      _meta: result._meta as Record<string, unknown> | undefined,
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
    }
  } catch (e) {
    // Clear intervals on error
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }

    const elapsed = Date.now() - toolStartTime

    if (e instanceof Error && e.name !== 'AbortError') {
      logMCPDebug(
        name,
        `Tool '${tool}' failed after ${Math.floor(elapsed / 1000)}s: ${e.message}`,
      )
    }

    // Check for 401 errors indicating expired/invalid OAuth tokens
    // The MCP SDK's StreamableHTTPError has a `code` property with the HTTP status
    if (e instanceof Error) {
      const errorCode = 'code' in e ? (e.code as number | undefined) : undefined
      if (errorCode === 401 || e instanceof UnauthorizedError) {
        logMCPDebug(
          name,
          `Tool call returned 401 Unauthorized - token may have expired`,
        )
        logEvent('tengu_mcp_tool_call_auth_error', {})
        throw new McpAuthError(
          name,
          `MCP server "${name}" requires re-authorization (token expired)`,
        )
      }

      // Check for session expiry — two error shapes can surface here:
      // 1. Direct 404 + JSON-RPC -32001 from the server (StreamableHTTPError)
      // 2. -32000 "Connection closed" (McpError) — the SDK closes the transport
      //    after the onerror handler fires, so the pending callTool() rejects
      //    with this derived error instead of the original 404.
      // In both cases, clear the connection cache so the next tool call
      // creates a fresh session.
      const isSessionExpired = isMcpSessionExpiredError(e)
      const isConnectionClosedOnHttp =
        'code' in e &&
        (e as Error & { code?: number }).code === -32000 &&
        e.message.includes('Connection closed') &&
        (config.type === 'http' || config.type === 'claudeai-proxy')
      if (isSessionExpired || isConnectionClosedOnHttp) {
        logMCPDebug(
          name,
          `MCP session expired during tool call (${isSessionExpired ? '404/-32001' : 'connection closed'}), clearing connection cache for re-initialization`,
        )
        logEvent('tengu_mcp_session_expired', {})
        await clearServerCache(name, config)
        throw new McpSessionExpiredError(name)
      }
    }

    // When the users hits esc, avoid logspew
    if (!(e instanceof Error) || e.name !== 'AbortError') {
      throw e
    }
    return { content: undefined }
  } finally {
    // Always clear intervals
    if (progressInterval !== undefined) {
      clearInterval(progressInterval)
    }
  }
}

/**
 * 【中文补充】从 assistant 消息里取出 tool_use 的 id，用于把「这次工具调用」和界面上的进度显示对上。
 * `content[0]?.type` 的可选链在这里很关键：消息内容可能是空的，不判空就会 NPE。
 * 返回值 `string | undefined` 是联合类型：可能没有，调用方必须处理 undefined（编译器会强制）。
 */
function extractToolUseId(message: AssistantMessage): string | undefined {
  if (message.message.content[0]?.type !== 'tool_use') {
    return undefined
  }
  return message.message.content[0].id
}

/**
 * 【中文补充】连接「SDK 内部 MCP server」的入口：这类 server 不 fork 子进程，而是跑在 Claude Code 自己的进程里，
 * 通过一个控制通道（SdkControlClientTransport）收发 JSON-RPC 消息。
 * 用 Promise.allSettled 而不是 Promise.all：某个 server 失败不影响其它 server 的结果收集
 *   （≈ Java 里遍历 CompletableFuture 列表，逐个检查 isCompletedExceptionally）。
 * @param sdkMcpConfigs SDK 类型的 server 配置
 * @param sendMcpMessage 把 MCP 消息通过控制通道发出去的回调
 * @returns 连接成功的客户端数组和对应的工具列表
 */
/**
 * Sets up SDK MCP clients by creating transports and connecting them.
 * This is used for SDK MCP servers that run in the same process as the SDK.
 *
 * @param sdkMcpConfigs - The SDK MCP server configurations
 * @param sendMcpMessage - Callback to send MCP messages through the control channel
 * @returns Connected clients, their tools, and transport map for message routing
 */
export async function setupSdkMcpClients(
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  sendMcpMessage: (
    serverName: string,
    message: JSONRPCMessage,
  ) => Promise<JSONRPCMessage>,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tool[]
}> {
  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []

  // Connect to all servers in parallel
  const results = await Promise.allSettled(
    Object.entries(sdkMcpConfigs).map(async ([name, config]) => {
      const transport = new SdkControlClientTransport(name, sendMcpMessage)

      const client = new Client(
        {
          name: 'claude-code',
          title: 'Claude Code',
          version: MACRO.VERSION ?? 'unknown',
          description: "Anthropic's agentic coding tool",
          websiteUrl: PRODUCT_URL,
        },
        {
          capabilities: {},
        },
      )

      try {
        // Connect the client
        await client.connect(transport)

        // Get capabilities from the server
        const capabilities = client.getServerCapabilities()

        // Create the connected client object
        const connectedClient: MCPServerConnection = {
          type: 'connected',
          name,
          capabilities: capabilities || {},
          client,
          config: { ...config, scope: 'dynamic' as const },
          cleanup: async () => {
            await client.close()
          },
        }

        // Fetch tools if the server has them
        const serverTools: Tool[] = []
        if (capabilities?.tools) {
          const sdkTools = await fetchToolsForClient(connectedClient)
          serverTools.push(...sdkTools)
        }

        return {
          client: connectedClient,
          tools: serverTools,
        }
      } catch (error) {
        // If connection fails, return failed server
        logMCPError(name, `Failed to connect SDK MCP server: ${error}`)
        return {
          client: {
            type: 'failed' as const,
            name,
            config: { ...config, scope: 'user' as const },
          },
          tools: [],
        }
      }
    }),
  )

  // Process results and collect clients and tools
  for (const result of results) {
    if (result.status === 'fulfilled') {
      clients.push(result.value.client)
      tools.push(...result.value.tools)
    }
    // If rejected (unexpected), the error was already logged inside the promise
  }

  return { clients, tools }
}
