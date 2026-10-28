/**
 * 【一句话定位】MCP 子系统的「类型与 schema 总表」：定义 server 配置长什么样、连接有哪几种状态。
 *
 * 【在架构中的位置】
 * - 上游：本目录几乎所有文件（client / config / auth / useManageMCPConnections / utils 等）都 import 这里的类型。
 * - 下游：依赖 @modelcontextprotocol/sdk 的类型 + zod（运行时校验）。
 *
 * 【本文件包含什么】
 * - ConfigScope / Transport：作用域与传输方式的枚举。
 * - McpStdioServerConfig / McpSSEServerConfig / McpHTTPServerConfig / McpWebSocketServerConfig /
 *   McpSdkServerConfig / McpClaudeAIProxyServerConfig / 两个 IDE 专用配置：各类 server 的配置 schema。
 * - ScopedMcpServerConfig：配置 + scope（还可以带 pluginSource）。
 * - ConnectedMCPServer / FailedMCPServer / NeedsAuthMCPServer / PendingMCPServer / DisabledMCPServer：
 *   连接的 5 种状态；MCPServerConnection 是它们的联合类型。
 * - SerializedTool / SerializedClient / MCPCliState：`claude mcp ...` 命令输出用的序列化结构。
 *
 * 【TS 语法速查】
 * - `z.infer<typeof Schema>`：从 zod schema「反推」出 TS 类型——一份定义同时给运行时和编译期用，
 *   ≈ Java 里用注解生成 DTO，但这里是纯类型层面的推导，零运行时开销。
 * - `z.literal('stdio')`：要求该字段必须恰好是 'stdio'，用于做「可辨识联合」的判别字段。
 * - `z.union([...])` ≈ 联合类型 `A | B | C` 的运行时版本（按序尝试，第一个匹配成功的为准）。
 * - `z.record(z.string(), z.string())` ≈ Map<String,String> 的校验器。
 * - 交叉类型 `A & B`：两个类型的字段都要有（≈ 同时实现两个接口）。
 * - `type:` 字段是 TS 里的「判别式」：运行时靠它区分联合类型的具体分支（见下面 MCPServerConnection）。
 * - `ReturnType<typeof f>`：取函数返回值类型——因为 schema 是工厂函数返回的，要绕一层。
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type {
  Resource,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

// Configuration schemas and types
  // 中文：下面所有 schema 都用 lazySchema 包一层工厂：zod 的 schema 构造有成本，
  //       且各 schema 之间可能互相引用，延迟构造能避开初始化顺序问题与循环依赖
export const ConfigScopeSchema = lazySchema(() =>
  z.enum([
    'local',
    'user',
    'project',
    'dynamic',
    'enterprise',
    'claudeai',
    'managed',
  ]),
)
export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>
  // 中文：z.infer 从 schema 反推出联合字面量类型 ≈ enum：local / user / project / dynamic / enterprise / claudeai / managed

export const TransportSchema = lazySchema(() =>
  z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk']),
)
export type Transport = z.infer<ReturnType<typeof TransportSchema>>
  // 中文：transport 类型枚举：stdio（子进程）/ sse / sse-ide（IDE 扩展）/ http / ws（WebSocket）/ sdk（进程内）

export const McpStdioServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('stdio').optional(), // Optional for backwards compatibility
    command: z.string().min(1, 'Command cannot be empty'),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
)

// Cross-App Access (XAA / SEP-990): just a per-server flag. IdP connection
  // 中文：XAA（Cross-App Access / SEP-990）只是一个「是否启用」的布尔开关。
  //       IdP 的具体信息（issuer、clientId、callbackPort）不写在单个 server 上，而是放在全局 settings.xaaIdp，
  //       一次配置、所有 XAA server 共享；本文件里的 clientId/clientSecret 则是「MCP server 自己的 AS」用的。
// details (issuer, clientId, callbackPort) come from settings.xaaIdp — configured
// once, shared across all XAA-enabled servers. clientId/clientSecret (parent
// oauth config + keychain slot) are for the MCP server's AS.
const McpXaaConfigSchema = lazySchema(() => z.boolean())

const McpOAuthConfigSchema = lazySchema(() =>
  z.object({
    clientId: z.string().optional(),
    callbackPort: z.number().int().positive().optional(),
    authServerMetadataUrl: z
      .string()
      .url()
      .startsWith('https://', {
        message: 'authServerMetadataUrl must use https://',
      })
      .optional(),
    xaa: McpXaaConfigSchema().optional(),
  }),
)

  /**
   * 中文：SSE（Server-Sent Events）类型的远程 server 配置。
   * SSE 是什么：client 用普通 HTTP POST 发请求，server 用一条长连接的 SSE 流把响应推回来。
   * 它是 MCP 早期支持的远程传输方式；现在更推荐 http（Streamable HTTP），SSE 主要为了向后兼容。
   * 字段：url（必填）、headers（静态请求头）、headersHelper（动态取请求头的脚本，见 headersHelper.ts）、
   * oauth（OAuth 配置，见 auth.ts）。
   */
export const McpSSEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: McpOAuthConfigSchema().optional(),
  }),
)

// Internal-only server type for IDE extensions
  // 中文：sse-ide 是内部专用类型，给 IDE 扩展（VSCode / JetBrains）用，用户不会手写这种配置
export const McpSSEIDEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse-ide'),
    url: z.string(),
    ideName: z.string(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)

// Internal-only server type for IDE extensions
export const McpWebSocketIDEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('ws-ide'),
    url: z.string(),
    ideName: z.string(),
    authToken: z.string().optional(),
    ideRunningInWindows: z.boolean().optional(),
  }),
)

  /**
   * 中文：HTTP（Streamable HTTP）类型的远程 server 配置——目前远程 MCP 的主推传输方式。
   * 与 SSE 的区别：SSE 需要两条通道（POST 发 + SSE 收），http 类型一条通道就够——
   * 响应可以按需流式返回，也可以一次返回；断线重连和无状态部署都更简单。
   * 对使用者来说两者配置几乎一样（url + headers + oauth），差别在 SDK 内部的 transport 实现。
   */
export const McpHTTPServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: McpOAuthConfigSchema().optional(),
  }),
)

  /**
   * 中文：WebSocket 类型的远程 server 配置。全双工长连接，延迟最低，但需要 server 侧支持 ws，
   * 且代理/网关对 ws 的支持不如 HTTP 普及，所以用得相对少。
   */
export const McpWebSocketServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('ws'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
  }),
)

  /**
   * 中文：sdk 类型的 server——server 由 SDK 使用者的代码在 SDK 进程内提供（见 SdkControlTransport.ts），
   * 配置里只需要一个 name，真正的实现在 SDK 那边。
   */
export const McpSdkServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sdk'),
    name: z.string(),
  }),
)

// Config type for Claude.ai proxy servers
  // 中文：claudeai-proxy：由 claude.ai 组织下发的 server（见 claudeai.ts），走 claude.ai 代理而不是直连
export const McpClaudeAIProxyServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('claudeai-proxy'),
    url: z.string(),
    id: z.string(),
  }),
)

  /**
   * 中文：把上面 8 种配置合成一个联合类型。z.union 会按顺序尝试，靠 type 字段区分具体是哪种。
   * 为什么用 union 而不是一个「所有字段都可选」的大对象：联合类型能让编译器在 switch(type) 之后
   * 精确知道每个分支有哪些字段（可辨识联合），写错字段会直接编译报错。
   */
export const McpServerConfigSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpSSEIDEServerConfigSchema(),
    McpWebSocketIDEServerConfigSchema(),
    McpHTTPServerConfigSchema(),
    McpWebSocketServerConfigSchema(),
    McpSdkServerConfigSchema(),
    McpClaudeAIProxyServerConfigSchema(),
  ]),
)

export type McpStdioServerConfig = z.infer<
  ReturnType<typeof McpStdioServerConfigSchema>
>
export type McpSSEServerConfig = z.infer<
  ReturnType<typeof McpSSEServerConfigSchema>
>
export type McpSSEIDEServerConfig = z.infer<
  ReturnType<typeof McpSSEIDEServerConfigSchema>
>
export type McpWebSocketIDEServerConfig = z.infer<
  ReturnType<typeof McpWebSocketIDEServerConfigSchema>
>
export type McpHTTPServerConfig = z.infer<
  ReturnType<typeof McpHTTPServerConfigSchema>
>
export type McpWebSocketServerConfig = z.infer<
  ReturnType<typeof McpWebSocketServerConfigSchema>
>
export type McpSdkServerConfig = z.infer<
  ReturnType<typeof McpSdkServerConfigSchema>
>
export type McpClaudeAIProxyServerConfig = z.infer<
  ReturnType<typeof McpClaudeAIProxyServerConfigSchema>
>
export type McpServerConfig = z.infer<ReturnType<typeof McpServerConfigSchema>>

  /**
   * 中文：带作用域的配置 = 配置本体 + scope 字段。这是运行时真正到处传递的形态。
   * pluginSource 是可选的：插件提供的 server 会记下提供者的来源（如 'slack@anthropic'），
   * 这样 channel 的准入判断不必再去等 AppState.plugins.enabled 加载完（避免竞态）。
   */
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  // For plugin-provided servers: the providing plugin's LoadedPlugin.source
  // (e.g. 'slack@anthropic'). Stashed at config-build time so the channel
  // gate doesn't have to race AppState.plugins.enabled hydration.
  pluginSource?: string
}

export const McpJsonConfigSchema = lazySchema(() =>
  z.object({
    mcpServers: z.record(z.string(), McpServerConfigSchema()),
  }),
)

export type McpJsonConfig = z.infer<ReturnType<typeof McpJsonConfigSchema>>

// Server connection types
  /**
   * 中文：连接成功后的 server。除了 client 句柄，还保存了：
   * capabilities（server 声明了哪些能力：有没有 tool / resource / prompt）、
   * serverInfo（server 自报的名字与版本）、instructions（server 给模型的使用说明）、
   * config（原始配置，重连时要用）、cleanup（关闭时释放资源的回调）。
   */
export type ConnectedMCPServer = {
  client: Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: {
    name: string
    version: string
  }
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}

  /**
   * 中文：连接失败的 server。保留 error 文案，供 /mcp 界面展示失败原因。
   */
export type FailedMCPServer = {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string
}

  /**
   * 中文：需要 OAuth 授权的 server——连上了但被要求先授权。此时不会自动重试，
   * 要等用户走完 OAuth 流程（见 auth.ts）再重连。
   */
export type NeedsAuthMCPServer = {
  name: string
  type: 'needs-auth'
  config: ScopedMcpServerConfig
}

  /**
   * 中文：待连接（排队中）的 server。带重连计数：reconnectAttempt 是当前已尝试次数，
   * maxReconnectAttempts 是上限——超过就不再自动重试，避免对挂掉的 server 无限重连。
   */
export type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}

  /**
   * 中文：被用户手动禁用（或按策略禁用）的 server。配置还在，只是不连。
   */
export type DisabledMCPServer = {
  name: string
  type: 'disabled'
  config: ScopedMcpServerConfig
}

  /**
   * 中文：★ MCP 连接的「状态机」类型——一个 server 在任意时刻必然是这 5 种状态之一。
   * 典型流转：pending → connected（成功）/ failed（失败）/ needs-auth（要授权）；
   * connected 掉线后会退回 pending 再重试；用户可把它置为 disabled。
   * 用联合类型 + type 判别字段表达状态机，是 TS 里替代 enum + 一堆可空字段的惯用做法：
   * 编译器会强制你处理每一种状态，也保证不会出现「既 connected 又有 error」这种不可能的状态。
   */
export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer

// Resource types
  // 中文：resource（MCP 里可被读取的资源，如文件、API 返回）额外带上它来自哪个 server
export type ServerResource = Resource & { server: string }

// MCP CLI State types
  /**
   * 中文：`claude mcp list` 这类命令输出用的 tool 结构（要能 JSON 序列化，所以不含函数字段）。
   * inputJSONSchema：tool 入参的 JSON Schema，会原样交给模型。
   * originalToolName：MCP server 给的原始 tool 名（因为对外展示的可能被规范化/加过前缀）。
   */
export interface SerializedTool {
  name: string
  description: string
  inputJSONSchema?: {
    [x: string]: unknown
    type: 'object'
    properties?: {
      [x: string]: unknown
    }
  }
  isMcp?: boolean
  originalToolName?: string // Original unnormalized tool name from MCP server
}

  // 中文：序列化后的 client 摘要，只保留名字、状态和能力（不能序列化真正的 client 句柄）
export interface SerializedClient {
  name: string
  type: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  capabilities?: ServerCapabilities
}

  /**
   * 中文：`claude mcp ...` 命令对外输出的完整状态快照。
   * normalizedNames：规范化名 → 原始名的映射，方便命令行/UI 在两种名字之间对照。
   */
export interface MCPCliState {
  clients: SerializedClient[]
  configs: Record<string, ScopedMcpServerConfig>
  tools: SerializedTool[]
  resources: Record<string, ServerResource[]>
  normalizedNames?: Record<string, string> // Maps normalized names to original names
}
