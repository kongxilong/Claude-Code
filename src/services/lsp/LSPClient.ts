/**
 * 【一句话定位】
 * LSP 的「传输层」：真正用 child_process.spawn 拉起 language server 子进程，并通过 stdio（标准输入/输出）
 * 用 JSON-RPC 协议与之双向通信。LSPServerInstance.ts 是策略层，本文件是它下面的干活层。
 *
 * 【在架构中的位置】
 * 调用链（自顶向下）：
 *   LSPServerInstance.ts（策略：重试 / 超时 / 状态机）
 *     → 本文件 createLSPClient()（传输：spawn 子进程 + JSON-RPC 编解码）
 *       → vscode-jsonrpc/node（第三方库：把字节流解析成 JSON-RPC 消息）
 *         → 子进程 stdio（stdin 写入请求、stdout 读取响应、stderr 读日志）
 * 上游只有 LSPServerInstance.ts 一个调用方；下游依赖 vscode-jsonrpc 与 Node 的 child_process。
 *
 * 【JSON-RPC / LSP 通信原理（Java 工程师速通版）】
 * Claude Code 之所以能「看懂代码、报类型错误、跳转定义」，全靠这一层：
 * 1. 每种语言（TS/Python/Go/Rust…）各有一个 language server 程序，
 *    它就是那个语言官方编译器/IDE 的「无界面后台服务版」（TS 对应 tsserver，Java 对应 Eclipse JDT LS）。
 * 2. 本文件用 spawn 把它当子进程启动，双方通过 stdin/stdout 收发 JSON-RPC 消息。
 *    消息格式形如：Content-Length: 78\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize",...}
 *    （和 HTTP 类似：头部声明长度 + 空行 + JSON 体，因为 TCP/管道是字节流，必须自己分帧）
 * 3. 交互顺序固定：initialize（握手，客户端声明能力）→ initialized（通知）→ 业务请求/通知。
 * 4. server 会在后台主动「推」诊断信息（publishDiagnostics），Claude Code 收到后存起来，
 *    再在合适时机喂给模型——这就是模型能知道「你这段代码有个类型错误」的原因。
 * 类比 Java：这就是 Eclipse JDT LS 的工作方式，VSCode 的 Java 插件也是这么跟 JDT LS 通信的。
 *
 * 【本文件包含什么】
 * - type LSPClient：一个 LSP 客户端对外暴露的接口（能力、是否已初始化、start/initialize/收发/停止）。
 * - createLSPClient()：工厂函数，闭包持有子进程与连接对象，返回上面的接口。
 * - checkStartFailed()：内部小工具，启动失败时后续所有调用都快速失败（fail fast）。
 * - start()：spawn 进程 → 建立 JSON-RPC 连接 → 注册错误/关闭回调 → listen() → 补挂排队中的 handler。
 * - initialize()：发 initialize 握手请求 + initialized 通知，成功后记录 server 能力。
 * - sendRequest() / sendNotification() / onNotification() / onRequest() / stop()：其余通信能力。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `import { type ChildProcess, spawn } from 'child_process'`：
 *   `type` 前缀表示「只导入类型」，值 spawn 正常导入。≈ Java 的 import，但类型导入编译后会被擦除。
 * - `Array<{ method: string; handler: (params: unknown) => void }>`：
 *   数组类型写成 `T[]` 或 `Array<T>` 都行；元素类型是个内联对象类型 ≈ Java 的 List<匿名 record>。
 * - `handler: (params: unknown) => void`：函数类型。≈ Java 的 `Consumer<Object>` 函数式接口；
 *   `(params: unknown) => void` 就是 lambda 的类型声明形式。
 * - `unknown`：比 any 安全的「未知类型」，使用前必须先做类型收窄。
 *   ≈ Java 的 Object，但强制你先 instanceof/校验才能用（any 才等价于完全不检查的 Object）。
 * - `onCrash?: (error: Error) => void`：参数名后带 `?` 表示可选参数 ≈ 可以调用时不传，类型自动加 | undefined。
 * - `onCrash?.(crashError)`：可选调用。等价于 `if (onCrash) onCrash(crashError)`，
 *   ≈ Java 里 `if (callback != null) callback.accept(...)` 的语法糖。
 * - `{ ...subprocessEnv(), ...options?.env }`：`...` 是对象展开运算符。
 *   语义是「浅拷贝 + 覆盖」：先把基础环境变量铺开，再用用户自定义 env 覆盖同名字段。
 *   ≈ Java 的 `Map<String,String> m = new HashMap<>(base); m.putAll(override);`
 *   这是函数式「不可变更新」的惯用法——不修改原对象，而是生成一个新对象。
 * - `options?.cwd`：可选链。≈ `options != null ? options.cwd : null`，整条链上任意一环为空都短路返回 undefined。
 * - `await new Promise<void>((resolve, reject) => {...})`：把「基于回调（事件）的异步 API」包装成 Promise，
 *   这样可以 await 它。Java 类比：CompletableFuture 的 complete()/completeExceptionally() 手动完成。
 * - `process.on('exit', (code, _signal) => {...})`：Node 的事件监听。
 *   ≈ Java 的 addListener；`(code, _signal) => {}` 是 lambda。下划线前缀 `_signal` 表示「这个参数用不上」的惯例。
 * - `connection.onError(([error, _message, _code]) => {...})`：
 *   参数里的 `[a, b, c]` 是数组解构 ≈ Java 没有直接对应，等价于从数组按下标取出三个元素。
 * - `const err = error as Error`：catch 到的变量在 TS 里默认是 unknown，用 `as` 断言成 Error 才能读 .message。
 *   ≈ Java 的 `(Error) e` 强制转换。
 * - `get capabilities() {...}`：对象字面量里的 getter，外部读 `client.capabilities` 会调用它。
 * - `pendingHandlers.length = 0`：清空数组的惯用写法（保留同一个数组引用）。
 *   ≈ Java 的 `list.clear()`。
 * - `try { ... } catch { ... } finally { ... }`：和 Java 完全一样。
 * - `async stop()` 里 `await` + `finally`：≈ Java 的 try-with-resources + finally 清理。
 */
import { type ChildProcess, spawn } from 'child_process'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from 'vscode-jsonrpc/node.js'
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
/**
 * LSP client interface.
 */
// 中文补充：这就是「一个 LSP 客户端」的契约。注意 start/initialize 是分开的两步——
// start 只是把子进程拉起来并连上管道，initialize 才是 LSP 协议层面的握手（会拿到 server 的能力清单）。
// 类型里的 `start: (command, args, options?) => Promise<void>` 这种写法叫「函数类型属性」，
// ≈ Java 接口里声明一个返回 CompletableFuture<Void> 的方法，只是这里定义成了字段形式。
export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start: (
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string>
      cwd?: string
    },
  ) => Promise<void>
  initialize: (params: InitializeParams) => Promise<InitializeResult>
  sendRequest: <TResult>(method: string, params: unknown) => Promise<TResult>
  sendNotification: (method: string, params: unknown) => Promise<void>
  onNotification: (method: string, handler: (params: unknown) => void) => void
  onRequest: <TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ) => void
  stop: () => Promise<void>
}

/**
 * Create an LSP client wrapper using vscode-jsonrpc.
 * Manages communication with an LSP server process via stdio.
 *
 * @param onCrash - Called when the server process exits unexpectedly (non-zero
 *   exit code during operation, not during intentional stop). Allows the owner
 *   to propagate crash state so the server can be restarted on next use.
 */
// 中文补充（入参/返回值 / 设计意图）：
// @param serverName 只用于日志与错误信息，方便从日志里分辨是哪个语言的 server。
// @param onCrash    「子进程非正常退出」的回调。为什么需要它？因为进程崩溃是异步事件，
//                   没有 await 可等，只能用回调把「崩溃」这件事冒泡给上层的状态机去处理。
//                   Java 类比：给 ExecutorService 注册一个 UncaughtExceptionHandler。
// @returns LSPClient 接口实现（闭包封装，外部拿不到内部的 process/connection 变量）。
// 为什么用工厂函数而不是 class：和 LSPServerInstance.ts 一样的理由——闭包私有状态 + 不用写 this。
export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LSPClient {
  // State variables in closure
// 以下都是闭包里的私有状态 ≈ Java 的 private 字段。
// `let process: ChildProcess | undefined`：联合类型，表示「要么有子进程，要么还没有」。
// 注意变量名 process 把 Node 的全局 process 遮蔽了（本文件后面用的 process.pid 之类不在这里，所以没冲突）。
  let process: ChildProcess | undefined
  let connection: MessageConnection | undefined
  let capabilities: ServerCapabilities | undefined
  let isInitialized = false
  let startFailed = false
  let startError: Error | undefined
// 这个标志位很关键：主动停止（stop）时子进程必然退出、连接必然关闭，
// 这些是「预期内」的事件，不该当成崩溃去打错误日志吓唬用户。
  let isStopping = false // Track intentional shutdown to avoid spurious error logging
  // Queue handlers registered before connection ready (lazy initialization support)
// 为什么要有 pendingHandlers 队列：上层可能在 start() 之前就注册了 handler（比如先注册
// publishDiagnostics 监听再去连 server）。这时候 connection 还不存在，只能先攒着，
// 等 start() 建好连接后再补挂上去。这是一个典型的「延迟初始化」缓冲设计。
  const pendingHandlers: Array<{
    method: string
    handler: (params: unknown) => void
  }> = []
  const pendingRequestHandlers: Array<{
    method: string
    handler: (params: unknown) => unknown | Promise<unknown>
  }> = []

// 快速失败：一旦启动就失败了，后面每个调用都直接抛同一个错误，
// 而不是让上层拿到一个半死的连接后报出莫名其妙的底层错误。
// `startError || new Error(...)`：`||` 在这里表示「startError 为空就用兜底错误对象」。
  function checkStartFailed(): void {
    if (startFailed) {
      throw startError || new Error(`LSP server ${serverName} failed to start`)
    }
  }

// 返回的对象就是对外 API。下面每个方法都是闭包函数，共享上面的私有状态。
  return {
    get capabilities(): ServerCapabilities | undefined {
      return capabilities
    },

    get isInitialized(): boolean {
      return isInitialized
    },

// start() 关键步骤：
// ① spawn 子进程（stdio 用 pipe，因为我们就是要通过管道说 JSON-RPC）
// ② await 等待 'spawn' 事件确认真的启动成功（否则命令不存在会异步抛 ENOENT）
// ③ 挂上 stderr / error / exit / stdin-error 四个监听
// ④ 用 StreamMessageReader/Writer 包住 stdout/stdin，建立 JSON-RPC 连接
// ⑤ connection.listen() 开始读消息；最后补挂排队中的 handler
// 下面代码里的 1 / 1.5 / 2 / 2.5 / 3 / 3.5 / 4 / 5 编号就是对应这些步骤。
    async start(
      command: string,
      args: string[],
      options?: {
        env?: Record<string, string>
        cwd?: string
      },
    ): Promise<void> {
      try {
        // 1. Spawn LSP server process
// spawn ≈ Java 的 new ProcessBuilder(...).start()。三个 pipe 分别对应 stdin/stdout/stderr，
// 全部用管道（而不是 inherit 继承父进程终端）是因为我们要独占读写它们来跑协议。
// 如果 inherit，language server 的调试输出会直接打到用户的终端上，把 Claude Code 的 UI 冲花。
        process = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
// `{ ...subprocessEnv(), ...options?.env }`：对象展开做「基础环境变量 + 用户覆盖」。
// subprocessEnv() 负责继承并清理宿主环境（比如去掉会干扰 Node 的 NODE_OPTIONS）。
// 顺序很重要：options.env 写在后面才能覆盖前面的同名键——写反了用户配置就失效了。
          env: { ...subprocessEnv(), ...options?.env },
          cwd: options?.cwd,
          // Prevent visible console window on Windows (no-op on other platforms)
          windowsHide: true,
        })

// 防御性检查：stdio 配成 pipe 后正常一定有值，但 TS 类型上它们是 `Stream | null`，
// 不判空的话后面 new StreamMessageReader(process.stdout) 会类型报错。
        if (!process.stdout || !process.stdin) {
          throw new Error('LSP server process stdio not available')
        }

        // 1.5. Wait for process to successfully spawn before using streams
        // This is CRITICAL: spawn() returns immediately, but the 'error' event
        // (e.g., ENOENT for command not found) fires asynchronously.
        // If we use the streams before confirming spawn succeeded, we get
        // unhandled promise rejections when writes fail on invalid streams.
        const spawnedProcess = process // Capture for closure
// 为什么必须等 'spawn' 事件：spawn() 是「发起」而不是「完成」，命令不存在（ENOENT）时
// 错误是在下一个事件循环才抛出的。如果立刻就去写 stdin，会得到一个已损坏的流，
// 然后触发 unhandledRejection，在 Node 里这会直接让进程退出——非常难查的坑。
// `new Promise((resolve, reject) => ...)` ≈ Java 里 new CompletableFuture 然后手动 complete。
        await new Promise<void>((resolve, reject) => {
          const onSpawn = (): void => {
            cleanup()
            resolve()
          }
          const onError = (error: Error): void => {
            cleanup()
            reject(error)
          }
          const cleanup = (): void => {
            spawnedProcess.removeListener('spawn', onSpawn)
            spawnedProcess.removeListener('error', onError)
          }
          spawnedProcess.once('spawn', onSpawn)
          spawnedProcess.once('error', onError)
        })

        // Capture stderr for server diagnostics and errors
// stderr 不是协议通道，只是 server 的人读日志（比如 pyright 打印的启动信息）。
// 抓下来打到 debug 日志里，出问题时是唯一的线索来源。
        if (process.stderr) {
          process.stderr.on('data', (data: Buffer) => {
            const output = data.toString().trim()
            if (output) {
              logForDebugging(`[LSP SERVER ${serverName}] ${output}`)
            }
          })
        }

        // Handle process errors (after successful spawn, e.g., crash during operation)
// 注意这里只处理「spawn 成功之后」的错误（spawn 失败的错误已在上面 await 里被 reject 了）。
        process.on('error', error => {
          if (!isStopping) {
            startFailed = true
            startError = error
            logError(
              new Error(
                `LSP server ${serverName} failed to start: ${error.message}`,
              ),
            )
          }
        })

// 崩溃检测：非 0 退出码 + 不是我们主动停止 → 判定为崩溃，通过 onCrash 回调通知上层状态机。
// `code !== null` 是必要的：被信号杀死时 code 为 null（那时 signal 才有值）。
// 这里刻意不设 startFailed（崩溃 ≠ 启动失败），把状态留给上层的崩溃恢复逻辑去处理。
        process.on('exit', (code, _signal) => {
          if (code !== 0 && code !== null && !isStopping) {
            isInitialized = false
            startFailed = false
            startError = undefined
            const crashError = new Error(
              `LSP server ${serverName} crashed with exit code ${code}`,
            )
            logError(crashError)
            onCrash?.(crashError)
          }
        })

        // Handle stdin stream errors to prevent unhandled promise rejections
        // when the LSP server process exits before we finish writing
// 为什么要单独监听 stdin 的 error：server 可能先挂了，此时我们再写 stdin 会触发 EPIPE。
// 不监听的话会变成 unhandled rejection 把主进程带崩——纯日志即可，真正的错误由 connection 层兜。
        process.stdin.on('error', (error: Error) => {
          if (!isStopping) {
            logForDebugging(
              `LSP server ${serverName} stdin error: ${error.message}`,
            )
          }
          // Error is logged but not thrown - the connection error handler will catch this
        })

        // 2. Create JSON-RPC connection
// LSP 的消息分帧：Content-Length 头 + 空行 + JSON 体。这两个类就是把「字节流」和「JSON 消息」互转的编解码器。
// 类比 Java：Socket 的 InputStream 包一层 ObjectInputStream。
        const reader = new StreamMessageReader(process.stdout)
        const writer = new StreamMessageWriter(process.stdin)
// createMessageConnection 建立的是「双向」连接：既能发请求等响应，也能接 server 主动推来的消息/请求。
        connection = createMessageConnection(reader, writer)

        // 2.5. Register error/close handlers BEFORE listen() to catch all errors
        // This prevents unhandled promise rejections when the server crashes or closes unexpectedly
// 用数组解构 `([error, _message, _code])` 取出回调参数。只需要 error，其余用 `_` 前缀表示忽略。
        connection.onError(([error, _message, _code]) => {
          // Only log if not intentionally stopping (avoid spurious errors during shutdown)
          if (!isStopping) {
            startFailed = true
            startError = error
            logError(
              new Error(
                `LSP server ${serverName} connection error: ${error.message}`,
              ),
            )
          }
        })

// 连接关闭在「主动停止」时是正常现象，所以只在非停止状态下记录 isInitialized=false。
        connection.onClose(() => {
          // Only treat as error if not intentionally stopping
          if (!isStopping) {
            isInitialized = false
            // Don't set startFailed here - the connection may close after graceful shutdown
            logForDebugging(`LSP server ${serverName} connection closed`)
          }
        })

        // 3. Start listening for messages
// listen() 才开始真正从 stdout 读数据。之前只是把 reader/writer 接好。
// 顺序要求：错误/关闭回调必须在 listen() 之前注册，否则可能漏掉最早的那批事件。
        connection.listen()

        // 3.5. Enable protocol tracing for debugging
        // Note: trace() sends a $/setTrace notification which can fail if the server
        // process has already exited. We catch and log the error rather than letting
        // it become an unhandled promise rejection.
// trace：把每一条 JSON-RPC 报文都打到 debug 日志（排查「为什么 server 没响应」的利器）。
// 它本身会发一条 $/setTrace 通知，若 server 已退出就会失败，所以必须 .catch 掉，
// 否则又是一个 unhandled rejection。
        connection
          .trace(Trace.Verbose, {
            log: (message: string) => {
              logForDebugging(`[LSP PROTOCOL ${serverName}] ${message}`)
            },
          })
          .catch((error: Error) => {
            logForDebugging(
              `Failed to enable tracing for ${serverName}: ${error.message}`,
            )
          })

        // 4. Apply any queued notification handlers
// `for (const { method, handler } of pendingHandlers)`：for-of + 对象解构。
// ≈ Java 的 `for (Handler h : pendingHandlers) { h.method; h.handler; }`，只是这里直接把字段解出来了。
        for (const { method, handler } of pendingHandlers) {
          connection.onNotification(method, handler)
          logForDebugging(
            `Applied queued notification handler for ${serverName}.${method}`,
          )
        }
        pendingHandlers.length = 0 // Clear the queue

        // 5. Apply any queued request handlers
        for (const { method, handler } of pendingRequestHandlers) {
          connection.onRequest(method, handler)
          logForDebugging(
            `Applied queued request handler for ${serverName}.${method}`,
          )
        }
        pendingRequestHandlers.length = 0 // Clear the queue

        logForDebugging(`LSP client started for ${serverName}`)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(`LSP server ${serverName} failed to start: ${err.message}`),
        )
        throw error
      }
    },

// LSP 握手：initialize 是有响应的请求，返回体里带 server 的 capabilities（能力清单），
// 告诉客户端「我支持跳转定义吗？支持找引用吗？」。后续上层可以按能力决定是否发某类请求。
    async initialize(params: InitializeParams): Promise<InitializeResult> {
      if (!connection) {
        throw new Error('LSP client not started')
      }

      checkStartFailed()

      try {
        const result: InitializeResult = await connection.sendRequest(
          'initialize',
          params,
        )

        capabilities = result.capabilities

        // Send initialized notification
// initialized 是通知（无响应）。按 LSP 规范，客户端必须发这一条，server 才开始正常工作；
// 少了它，很多 server 会一直不返回诊断信息（很常见的踩坑点）。
        await connection.sendNotification('initialized', {})

        isInitialized = true
        logForDebugging(`LSP server ${serverName} initialized`)

        return result
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} initialize failed: ${err.message}`,
          ),
        )
        throw error
      }
    },

// 泛型方法 `<TResult>`：调用方可以写 `await sendRequest<Location[]>('textDocument/definition', p)`，
// 返回值直接就是 Location[]。≈ Java 的 `<T> CompletableFuture<T> sendRequest(...)`，泛型也在方法名后。
    async sendRequest<TResult>(
      method: string,
      params: unknown,
    ): Promise<TResult> {
      if (!connection) {
        throw new Error('LSP client not started')
      }

      checkStartFailed()

// 顺序检查：没走完 initialize 握手就不允许发业务请求，否则 server 会按规范回一个
// "ServerNotInitialized" 错误，排查起来很绕。
      if (!isInitialized) {
        throw new Error('LSP server not initialized')
      }

      try {
        return await connection.sendRequest(method, params)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} request ${method} failed: ${err.message}`,
          ),
        )
        throw error
      }
    },

// notification = 发后不管（JSON-RPC 里没有 id 字段，对端不回包）。用于 didOpen/didChange 这类文件同步。
    async sendNotification(method: string, params: unknown): Promise<void> {
      if (!connection) {
        throw new Error('LSP client not started')
      }

      checkStartFailed()

      try {
        await connection.sendNotification(method, params)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} notification ${method} failed: ${err.message}`,
          ),
        )
        // Don't re-throw for notifications - they're fire-and-forget
// 中文补充：故意「吞掉」通知的失败——因为通知本来就不要求对方确认，
// 比如 server 正在关闭时我们同步文件状态失败是很正常的，不该让上层跟着报错。
        logForDebugging(`Notification ${method} failed but continuing`)
      }
    },

// 注册「server 主动推给我」的通知处理器。最重要的一条是 textDocument/publishDiagnostics（诊断回流），
// 它是 Claude Code 能拿到类型错误/语法错误的入口（交给 LSPDiagnosticRegistry 汇总）。
// 连接还没建好时先入队，等 start() 里补挂——这样调用方不用关心时序。
    onNotification(method: string, handler: (params: unknown) => void): void {
      if (!connection) {
        // Queue handler for application when connection is ready (lazy initialization)
        pendingHandlers.push({ method, handler })
        logForDebugging(
          `Queued notification handler for ${serverName}.${method} (connection not ready)`,
        )
        return
      }

      checkStartFailed()

      connection.onNotification(method, handler)
    },

// 注册「server 反向请求我」的处理器（server 问客户端要东西，必须应答，否则 server 会一直等）。
// `handler as (params: unknown) => unknown | Promise<unknown>`：
// 这是一个「向下兼容」的强制转换。队列的声明类型故意放宽成 unknown，是为了能存下各种泛型的 handler；
// 真要挂到 connection 上时再转回来。Java 类比：往 List<Object> 里塞各种类型，取用时强转。
    onRequest<TParams, TResult>(
      method: string,
      handler: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      if (!connection) {
        // Queue handler for application when connection is ready (lazy initialization)
        pendingRequestHandlers.push({
          method,
          handler: handler as (params: unknown) => unknown | Promise<unknown>,
        })
        logForDebugging(
          `Queued request handler for ${serverName}.${method} (connection not ready)`,
        )
        return
      }

      checkStartFailed()

      connection.onRequest(method, handler)
    },

// 优雅停止：先 shutdown（请求，等响应）→ 再 exit（通知）→ 最后 kill 兜底。
// 顺序不能反：先 exit 的话 server 会立刻退出，shutdown 就永远等不到响应了。
// 全部放在 try/finally 里，保证「无论怎么失败，子进程和连接都一定被清理」——防孤儿进程。
    async stop(): Promise<void> {
      let shutdownError: Error | undefined

      // Mark as stopping to prevent error handlers from logging spurious errors
      isStopping = true

      try {
        if (connection) {
          // Try to send shutdown request and exit notification
          await connection.sendRequest('shutdown', {})
          await connection.sendNotification('exit', {})
        }
      } catch (error) {
        const err = error as Error
        logError(
          new Error(`LSP server ${serverName} stop failed: ${err.message}`),
        )
        shutdownError = err
        // Continue to cleanup despite shutdown failure
// finally ≈ Java 的 finally：即使 shutdown 抛错，资源也必须回收。
// 注意是「先清理完再抛错」（错误存到 shutdownError，最后在函数末尾 throw），
// 这样调用方既能知道失败了，又不会留下泄漏的进程。
      } finally {
        // Always cleanup resources, even if shutdown/exit failed
        if (connection) {
          try {
            connection.dispose()
          } catch (error) {
            // Log but don't throw - disposal errors are less critical
            logForDebugging(
              `Connection disposal failed for ${serverName}: ${errorMessage(error)}`,
            )
          }
          connection = undefined
        }

        if (process) {
          // Remove event listeners to prevent memory leaks
          process.removeAllListeners('error')
          process.removeAllListeners('exit')
          if (process.stdin) {
            process.stdin.removeAllListeners('error')
          }
          if (process.stderr) {
            process.stderr.removeAllListeners('data')
          }

          try {
            process.kill()
          } catch (error) {
            // Process might already be dead, which is fine
            logForDebugging(
              `Process kill failed for ${serverName} (may already be dead): ${errorMessage(error)}`,
            )
          }
          process = undefined
        }

        isInitialized = false
        capabilities = undefined
        isStopping = false // Reset for potential restart
        // Don't reset startFailed - preserve error state for diagnostics
        // startFailed and startError remain as-is
        if (shutdownError) {
          startFailed = true
          startError = shutdownError
        }

        logForDebugging(`LSP client stopped for ${serverName}`)
      }

      // Re-throw shutdown error after cleanup is complete
      if (shutdownError) {
        throw shutdownError
      }
    },
  }
}
