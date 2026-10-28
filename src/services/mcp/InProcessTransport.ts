/**
 * 【一句话定位】进程内 MCP 传输对（transport pair）：让 MCP server 和 client 跑在同一个进程里，不 fork 子进程。
 *
 * 【MCP 背景：什么是 transport】
 * MCP 是 Anthropic 提出的开放协议，规定「模型侧(client) 与 工具侧(server) 如何交换 JSON-RPC 消息」，
 * 但不规定消息走哪条物理通道——这条通道就是 transport。常见三种：
 *   ① stdio：fork 一个子进程，用它的 stdin/stdout 收发消息（本地命令行 MCP server 最常用）；
 *   ② SSE / HTTP：走网络，client 用 HTTP 发、server 用 SSE 或流式 HTTP 回（远程 MCP server）；
 *   ③ 进程内直连（本文件）：两端都在本进程内存里，send() 直接把消息交给对端。
 *
 * 【在架构中的位置】
 * - 上游：type: 'sdk' 的 MCP server（SDK 内嵌 server）、以及单元测试——都不想真的起子进程。
 * - 下游：实现 @modelcontextprotocol/sdk 的 Transport 接口，被 Client / McpServer 各持一端。
 *
 * 【本文件包含什么】
 * - class InProcessTransport：Transport 实现，持有 peer（对端），send 就是递给对端的 onmessage。
 * - createLinkedTransportPair()：唯一导出，返回 [clientTransport, serverTransport] 一对互连传输。
 *
 * 【TS 语法速查】
 * - `implements Transport` ≈ Java 的 implements，编译期强制实现接口全部成员。
 * - `private peer: InProcessTransport | undefined`：联合类型 `A | undefined` ≈ Java 的 @Nullable，
 *   但编译器会强制你先判空（不像 Java 要等到运行时才 NPE）。
 * - `onmessage?: (message: JSONRPCMessage) => void`：可选的函数字段，
 *   ≈ Java 的 `@Nullable Consumer<JSONRPCMessage>` 字段；`?` 表示可以不赋值。
 * - `this.peer?.onmessage?.(message)`：两层可选链 + 可选调用，
 *   ≈ Java 的 `if (peer != null && peer.onmessage != null) peer.onmessage.accept(message)`。
 * - `[Transport, Transport]`：元组类型，长度和每个位置的类型都固定 ≈ 定长 Object[] 但类型安全。
 * - `async start(): Promise<void>` ≈ Java 的 `CompletableFuture<Void> start()`；
 *   方法体为空是“实现了接口但什么都不必做”（内存直连不需要建连）。
 * - `await` 只能出现在 async 函数里；async 函数的返回值会被自动包成 Promise。
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * In-process linked transport pair for running an MCP server and client
 * in the same process without spawning a subprocess.
 *
 * `send()` on one side delivers to `onmessage` on the other.
 * `close()` on either side calls `onclose` on both.
 */
  /**
   * 中文：一端 transport。它和对端（peer）互相持有引用，send() 只做一件事：把消息交给对端的 onmessage。
   * 为什么必须成对存在：MCP 的 Client 与 Server 各自只持有「一个」transport，只往自己的 transport 写、
   * 只从自己的 onmessage 读，所以必须有个对象把「写这头」和「读那头」接起来。
   */
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined
  private closed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  /** @internal */
  _setPeer(peer: InProcessTransport): void {
    this.peer = peer
  }

  async start(): Promise<void> {}

  /**
   * 中文：把消息投递给对端。
   * 入参 message：一条 JSON-RPC 消息（请求 / 响应 / 通知 三选一）。
   * 返回 Promise<void>：只表示“投递动作完成”，不代表对端已处理完。
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('Transport is closed')
    }
    // Deliver to the other side asynchronously to avoid stack depth issues
    // with synchronous request/response cycles
    // 中文：必须异步投递。若同步调用 peer.onmessage，请求-响应会一层层嵌在同一个调用栈里：
    //        server 处理完立刻回响应 → client 又立刻发下一个 → 栈越堆越深，最终 stack overflow。
    //        queueMicrotask 把回调推到下一个微任务，让当前调用栈先退出（≈ Java 里把活丢给别的线程/队列）。
    queueMicrotask(() => {
      this.peer?.onmessage?.(message)
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.onclose?.()
    // Close the peer if it hasn't already closed
    // 中文：关一端时要顺带关对端，否则对端会一直以为连接还在（半开连接，资源泄漏）
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true
      this.peer.onclose?.()
    }
  }
}

/**
 * Creates a pair of linked transports for in-process MCP communication.
 * Messages sent on one transport are delivered to the other's `onmessage`.
 *
 * @returns [clientTransport, serverTransport]
 */
  /**
   * 中文：工厂函数，造一对互连的 transport。
   * 返回 [clientTransport, serverTransport]，顺序是约定：第一个给 MCP Client，第二个给 MCP Server。
   */
export function createLinkedTransportPair(): [Transport, Transport] {
  const a = new InProcessTransport()
  const b = new InProcessTransport()
  a._setPeer(b)
  b._setPeer(a)
  return [a, b]
}
