/**
 * 【一句话定位】SDK MCP 的传输桥：让「跑在 SDK 进程里的 MCP server」和「跑在 CLI 进程里的 MCP client」互通。
 *
 * 【MCP 背景】
 * 普通 MCP server 是独立进程（stdio）或远端服务（SSE/HTTP）。但 type: 'sdk' 的 server 是 SDK 使用者
 * 用代码直接写在自己进程里的，它跟 CLI 不在同一个进程，所以不能像 InProcessTransport 那样内存直连，
 * 必须借道 SDK ↔ CLI 之间已有的 control 消息通道（走 stdout/stdin 传 JSON-RPC）。
 *
 * 【在架构中的位置】
 * - 上游：client.ts（为 sdk 类型的 server 选用 SdkControlClientTransport）；
 *   SDK 侧（query.ts 收到 control 请求后交给 SdkControlServerTransport）。
 * - 下游：实现 MCP SDK 的 Transport 接口。
 *
 * 【本文件包含什么】
 * - SendMcpMessageCallback：回调类型，(serverName, message) => Promise<响应消息>。
 * - SdkControlClientTransport：CLI 侧。send() 把 MCP 消息包成 control 请求发出去，拿回响应再喂给 client。
 * - SdkControlServerTransport：SDK 侧。纯转发，send() 直接把响应交给回调。
 *
 * 【TS 语法速查】
 * - `constructor(private serverName: string, ...)`：构造参数前加 private/readonly 是 TS 的
 *   「参数属性」语法糖——等于同时声明字段 + 赋值，Java 必须手写 `this.serverName = serverName`。
 * - `export type F = (a: string) => Promise<B>`：函数类型别名 ≈ Java 的 functional interface。
 * - `async send(...)` 里 `await` 一个 Promise：≈ Java 的 CompletableFuture.get()，但不阻塞线程。
 */
/**
 * SDK MCP Transport Bridge
 *
 * This file implements a transport bridge that allows MCP servers running in the SDK process
 * to communicate with the Claude Code CLI process through control messages.
 *
 * ## Architecture Overview
 *
 * Unlike regular MCP servers that run as separate processes, SDK MCP servers run in-process
 * within the SDK. This requires a special transport mechanism to bridge communication between:
 * - The CLI process (where the MCP client runs)
 * - The SDK process (where the SDK MCP server runs)
 *
 * ## Message Flow
 *
 * ### CLI → SDK (via SdkControlClientTransport)
 * 1. CLI's MCP Client calls a tool → sends JSONRPC request to SdkControlClientTransport
 * 2. Transport wraps the message in a control request with server_name and request_id
 * 3. Control request is sent via stdout to the SDK process
 * 4. SDK's StructuredIO receives the control response and routes it back to the transport
 * 5. Transport unwraps the response and returns it to the MCP Client
 *
 * ### SDK → CLI (via SdkControlServerTransport)
 * 1. Query receives control request with MCP message and calls transport.onmessage
 * 2. MCP server processes the message and calls transport.send() with response
 * 3. Transport calls sendMcpMessage callback with the response
 * 4. Query's callback resolves the pending promise with the response
 * 5. Query returns the response to complete the control request
 *
 * ## Key Design Points
 *
 * - SdkControlClientTransport: StructuredIO tracks pending requests
 * - SdkControlServerTransport: Query tracks pending requests
 * - The control request wrapper includes server_name to route to the correct SDK server
 * - The system supports multiple SDK MCP servers running simultaneously
 * - Message IDs are preserved through the entire flow for proper correlation
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * Callback function to send an MCP message and get the response
 */
export type SendMcpMessageCallback = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>

/**
 * CLI-side transport for SDK MCP servers.
 *
 * This transport is used in the CLI process to bridge communication between:
 * - The CLI's MCP Client (which wants to call tools on SDK MCP servers)
 * - The SDK process (where the actual MCP server runs)
 *
 * It converts MCP protocol messages into control requests that can be sent
 * through stdout/stdin to the SDK process.
 */
  /**
   * 中文：CLI 侧的 transport。MCP Client 调 tool 时会调到它的 send()，
   * 它把消息通过 control 通道发给 SDK 进程，等回包，再把回包塞回 Client 的 onmessage。
   * 为什么要等回包再回灌：MCP Client 的请求-响应是按 JSON-RPC id 配对的，
   * 必须让响应以「收到消息」的形式回到 Client，否则 Client 会一直挂在这个请求上。
   */
export class SdkControlClientTransport implements Transport {
  private isClosed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(
    private serverName: string,
    private sendMcpMessage: SendMcpMessageCallback,
  ) {}
  // 中文：参数属性语法糖——private serverName 既声明了字段，也把构造入参自动赋给了它

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
  /**
   * 中文：发一条 MCP 消息。
   * 入参 message：待发的 JSON-RPC 消息。
   * 注意这不是「发完就完」——它会 await 到 SDK 侧处理完并返回响应为止。
   */
    if (this.isClosed) {
      throw new Error('Transport is closed')
    }

    // Send the message and wait for the response
    // 中文：control 请求里带 serverName，因为 SDK 进程里可能同时跑着多个 sdk server，要路由到正确的那个
    const response = await this.sendMcpMessage(this.serverName, message)

    // Pass the response back to the MCP client
    if (this.onmessage) {
      this.onmessage(response)
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    this.onclose?.()
  }
}

/**
 * SDK-side transport for SDK MCP servers.
 *
 * This transport is used in the SDK process to bridge communication between:
 * - Control requests coming from the CLI (via stdin)
 * - The actual MCP server running in the SDK process
 *
 * It acts as a simple pass-through that forwards messages to the MCP server
 * and sends responses back via a callback.
 *
 * Note: Query handles all request/response correlation and async flow.
 */
  /**
   * 中文：SDK 侧的 transport。方向相反：收到 CLI 发来的 MCP 消息就交给本地 MCP server，
   * server 回的响应通过构造时传入的回调送出去。
   * 请求/响应的配对（id 关联）由 SDK 侧的 Query 负责，所以这里只做最朴素的转发。
   */
export class SdkControlServerTransport implements Transport {
  private isClosed = false

  constructor(private sendMcpMessage: (message: JSONRPCMessage) => void) {}
  // 中文：参数是个函数类型，等价于 Java 的 Consumer<JSONRPCMessage>

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport is closed')
    }

    // Simply pass the response back through the callback
    // 中文：同步直接回调即可，不需要 await —— 真正的异步编排在 SDK 的 Query 那一层做
    this.sendMcpMessage(message)
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    this.onclose?.()
  }
}
