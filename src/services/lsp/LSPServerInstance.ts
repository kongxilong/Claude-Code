/**
 * 【一句话定位】
 * 单个 LSP（Language Server Protocol）服务进程的「生命周期管理器」：负责启动、初始化、健康检查、
 * 请求转发、优雅停止与重启。可以理解为 Java 里的一个对象池 Element 包装类 + 状态机。
 *
 * 【在架构中的位置】
 * 调用链（自顶向下）：
 *   LSP 相关工具（跳转定义 / 找引用 / 取诊断）/ passiveFeedback / LSPDiagnosticRegistry
 *     → LSPServerManager（按文件后缀挑选并缓存 server 实例）
 *       → 本文件 createLSPServerInstance()（状态机 + 重试 + 超时 + 崩溃恢复）
 *         → LSPClient.ts createLSPClient()（真正 spawn 子进程、跑 JSON-RPC 编解码）
 *           → 外部 language server 进程（typescript-language-server / pyright / gopls / rust-analyzer …）
 * 一句话区分：本文件是「策略层」（什么时候重试、什么时候算挂了），LSPClient.ts 是「传输层」（怎么收发字节）。
 * 熟悉 Eclipse 的读者可以类比：JDT LS 就是那个子进程，本文件就是管理 JDT LS 进程的那层代码。
 *
 * 【本文件包含什么】
 * - LSP_ERROR_CONTENT_MODIFIED / MAX_RETRIES_FOR_TRANSIENT_ERRORS / RETRY_BASE_DELAY_MS：
 *   处理「服务器还在建索引」这类瞬时错误的重试常量。
 * - type LSPServerInstance：一个 server 实例对外暴露的接口（只读状态 + 生命周期方法）。
 * - createLSPServerInstance()：工厂函数，用闭包封装私有状态，返回上面那个接口。
 * - start() / stop() / restart() / isHealthy()：生命周期与状态机。
 * - sendRequest() / sendNotification() / onNotification() / onRequest()：与 server 双向通信。
 * - withTimeout()：给任意 Promise 加超时的小工具（防止某个 server 初始化时永久卡住）。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `export type X = { ... }`：类型别名。≈ Java 的 record/interface，但 TS 是「结构化鸭子类型」——
 *   只要字段类型和名字对得上就算兼容，不要求显式 implements。
 * - `readonly name: string`：只读属性 ≈ Java 的 final 字段（编译期约束，运行期不强制）。
 * - `start(): Promise<void>`：返回「承诺」的方法 ≈ Java 的 `CompletableFuture<Void> start()`；
 *   `await` ≈ `future.join()`，但不会阻塞 OS 线程。
 * - `sendRequest<T>(...): Promise<T>`：泛型方法 ≈ Java 的 `<T> CompletableFuture<T> sendRequest(...)`；
 *   注意 TS 泛型写在函数名「后面」，Java 写在「前面」，最容易看串。
 * - `let startTime: Date | undefined`：`|` 是联合类型 ≈ Java 的 sealed interface 或 Optional，
 *   表示「要么是 Date，要么是 undefined」。undefined ≈ Java 的 null，但更偏向「没赋值」语义。
 * - `config.maxRestarts ?? 3`：`??` 是空值合并运算符。只在 null/undefined 时取默认值。
 *   与 `||` 的区别很关键：`||` 会把 0、''、false 也当作「假」而替换掉；
 *   这里 maxRestarts=0 是合法配置（一次都不许重启），所以必须用 `??` 不能用 `||`。
 * - `config.args || []`：这里反过来用 `||`，因为只想兜住 undefined / 空字符串，0 没意义。
 * - `error as Error`：`as` ≈ Java 的强制类型转换 `(Error) error`。编译期生效，运行期完全不检查。
 * - `(error as { code?: number }).code`：鸭子类型取字段。为什么不用 `instanceof`？因为依赖树里可能
 *   同时存在多个版本的 vscode-jsonrpc（8.2.0 / 8.2.1），不同版本的类 instanceof 会判 false。
 * - `code?: number`：可选属性 ≈ 这个字段可以不存在，等价于 `number | undefined`。
 * - `get state() { return state }`：getter。外部写 `instance.state` 时会自动调用它，
 *   这样读到的是闭包里的「最新值」，而不是构造返回对象那一刻的快照。
 * - `client.stop().catch(() => {})`：Promise 的 catch ≈ try-catch 的异步版；
 *   `() => {}` 是箭头函数 ≈ Java lambda `() -> {}`，空实现即「故意忽略错误」。
 * - `initPromise?.catch(() => {})`：`?.` 可选链 ≈ `if (initPromise != null) initPromise.catch(...)` 的糖。
 * - `async function` / `await`：≈ Java 的 CompletableFuture 链式调用，但可以用同步的书写顺序写异步代码。
 * - `import type { X } from '...'`：只导入类型。编译后被完全擦除，不产生任何运行时依赖
 *   （Java 里没有直接对应物，可以理解为「只借用签名，不产生 import 的字节码」）。
 * - `require('./LSPClient.js') as { createLSPClient: typeof createLSPClientType }`：
 *   运行时动态 require ≈ Java 的 Class.forName 反射。这里是为了「懒加载」——只有真的要起
 *   language server 时才把 vscode-jsonrpc（约 129KB）拉进内存，CLI 冷启动更快。
 * - `Promise.race([a, b]).finally(...)`：谁先完成用谁 ≈ CompletableFuture.anyOf；
 *   `.finally` ≈ Java 的 finally 块，无论成功失败都执行（这里用来清掉定时器）。
 * - `timer!`：后缀 `!` 是非空断言 ≈ 告诉编译器「我保证它不是 null」，
 *   类似 Java 的强制转换，编译期擦除、运行期不检查，用错就是 NPE。
 * - `new Promise<never>((_, reject) => {...})`：手工构造 Promise。`reject` 相当于抛异常；
 *   下划线 `_` 是「这个参数我不关心」的命名惯例（这里是 resolve，本例只用来超时拒绝）。
 * - `for (let attempt = 0; attempt <= N; attempt++)`：和 Java 的 for 循环写法完全一致。
 * - `Math.pow(2, attempt)`：指数退避，2 的 attempt 次方。
 */
import * as path from 'path'
import { pathToFileURL } from 'url'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import type { createLSPClient as createLSPClientType } from './LSPClient.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'

/**
 * LSP error code for "content modified" - indicates the server's state changed
 * during request processing (e.g., rust-analyzer still indexing the project).
 * This is a transient error that can be retried.
 */
// 中文补充：LSP 规范里 -32801 表示 ContentModified（内容被修改）。它不是「出错」，而是服务器在说
// 「我正忙（比如 rust-analyzer 还在建项目索引），你等会儿再来」。按规范客户端应当静默重试。
// Java 类比：类似数据库抛的死锁/超时异常，属于可重试异常，不该直接上报给用户。
const LSP_ERROR_CONTENT_MODIFIED = -32801

/**
 * Maximum number of retries for transient LSP errors like "content modified".
 */
// 中文补充：最多重试 3 次。再多就没意义了——说明这个 server 真的需要很长时间才能就绪。
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3

/**
 * Base delay in milliseconds for exponential backoff on transient errors.
 * Actual delays: 500ms, 1000ms, 2000ms
 */
const RETRY_BASE_DELAY_MS = 500
// 中文补充：指数退避的基数。实际等待 500ms → 1000ms → 2000ms，避免把还在忙的 server 打爆。
/**
 * LSP server instance interface returned by createLSPServerInstance.
 * Manages the lifecycle of a single LSP server with state tracking and health monitoring.
 */
// 中文补充：这是本工厂函数返回给上层的「公开接口」。上层（LSPServerManager）只认这个接口，
// 看不到闭包里的私有变量，从而实现封装——和 Java 用接口隐藏实现类是一回事。
// 类型里既有数据（name/config/state…）又有方法（start/stop/…），
// 在 Java 里就是一个 interface 里既有 getter 又有方法，TS 里很常见。
export type LSPServerInstance = {
  /** Unique server identifier */
  readonly name: string
  /** Server configuration */
  readonly config: ScopedLspServerConfig
  /** Current server state */
  readonly state: LspServerState
  /** When the server was last started */
  readonly startTime: Date | undefined
  /** Last error encountered */
  readonly lastError: Error | undefined
  /** Number of times restart() has been called */
  readonly restartCount: number
  /** Start the server and initialize it */
  start(): Promise<void>
  /** Stop the server gracefully */
  stop(): Promise<void>
  /** Manually restart the server (stop then start) */
  restart(): Promise<void>
  /** Check if server is healthy and ready for requests */
  isHealthy(): boolean
  /** Send an LSP request to the server */
  sendRequest<T>(method: string, params: unknown): Promise<T>
  /** Send an LSP notification to the server (fire-and-forget) */
  sendNotification(method: string, params: unknown): Promise<void>
  /** Register a handler for LSP notifications */
  onNotification(method: string, handler: (params: unknown) => void): void
  /** Register a handler for LSP requests from the server */
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
}

/**
 * Creates and manages a single LSP server instance.
 *
 * Uses factory function pattern with closures for state encapsulation (avoiding classes).
 * Provides state tracking, health monitoring, and request forwarding for an LSP server.
 * Supports manual restart with configurable retry limits.
 *
 * State machine transitions:
 * - stopped → starting → running
 * - running → stopping → stopped
 * - any → error (on failure)
 * - error → starting (on retry)
 *
 * @param name - Unique identifier for this server instance
 * @param config - Server configuration including command, args, and limits
 * @returns LSP server instance with lifecycle management methods
 *
 * @example
 * const instance = createLSPServerInstance('my-server', config)
 * await instance.start()
 * const result = await instance.sendRequest('textDocument/definition', params)
 * await instance.stop()
 */
// 中文补充（为什么用工厂函数而不是 class）：
// 这里刻意用「工厂函数 + 闭包」代替 class。闭包里的 state/startTime/lastError 天然是私有的，
// 外部无法直接改，只能通过返回的 getter 读——相当于 Java 的 private 字段 + public getter，
// 而且不需要写 this，重构时更不容易出错。
// 状态机：stopped → starting → running；running → stopping → stopped；任意状态 → error；error → starting（重试）。
export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig,
): LSPServerInstance {
  // Validate that unimplemented fields are not set
// 为什么「直接抛错」而不是静默忽略：如果用户在配置里写了我们还不支持的字段，
// 静默忽略会让用户以为配置生效了，最后排查很久。宁可启动即失败（fail fast）。
  if (config.restartOnCrash !== undefined) {
    throw new Error(
      `LSP server '${name}': restartOnCrash is not yet implemented. Remove this field from the configuration.`,
    )
  }
  if (config.shutdownTimeout !== undefined) {
    throw new Error(
      `LSP server '${name}': shutdownTimeout is not yet implemented. Remove this field from the configuration.`,
    )
  }

  // Private state encapsulated via closures. Lazy-require LSPClient so
  // vscode-jsonrpc (~129KB) only loads when an LSP server is actually
  // instantiated, not when the static import chain reaches this module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createLSPClient } = require('./LSPClient.js') as {
    createLSPClient: typeof createLSPClientType
  }
// 以下 5 个变量就是「闭包私有状态」，Java 里相当于 private 字段。
// TS 类型标注在变量名「后面」（Java 在前面），这是 Java 工程师最容易看串的地方。
// LspServerState 是 './types.js' 里的字符串联合类型，≈ Java 的 enum。
  let state: LspServerState = 'stopped'
  let startTime: Date | undefined
  let lastError: Error | undefined
  let restartCount = 0
  let crashRecoveryCount = 0
  // Propagate crash state so ensureServerStarted can restart on next use.
  // Without this, state stays 'running' after crash and the server is never
  // restarted (zombie state).
// 把「崩溃回调」注入给传输层：子进程一旦异常退出，LSPClient 会回调这里，我们据此把状态置为 error，
// 这样下一次 ensureServerStarted 才会真的重启它，否则状态永远停在 running（僵尸状态，请求全部失败）。
  const client = createLSPClient(name, error => {
    state = 'error'
    lastError = error
    crashRecoveryCount++
  })

  /**
   * Starts the LSP server and initializes it with workspace information.
   *
   * If the server is already running or starting, this method returns immediately.
   * On failure, sets state to 'error', logs for monitoring, and throws.
   *
   * @throws {Error} If server fails to start or initialize
   */
// 中文补充：start() 干三件事——① 拉起子进程 ② 发送 initialize 请求（握手）③ 发送 initialized 通知。
// 只有走完这三步，server 才算真正可用（isHealthy() 才返回 true）。
  async function start(): Promise<void> {
    if (state === 'running' || state === 'starting') {
      return
    }

    // Cap crash-recovery attempts so a persistently crashing server doesn't
    // spawn unbounded child processes on every incoming request.
// `??` 空值合并：仅当值为 undefined/null 时取默认 3。注意不能写成 `||`，否则 maxRestarts=0 会被替换掉。
    const maxRestarts = config.maxRestarts ?? 3
    if (state === 'error' && crashRecoveryCount > maxRestarts) {
      const error = new Error(
        `LSP server '${name}' exceeded max crash recovery attempts (${maxRestarts})`,
      )
      lastError = error
      logError(error)
      throw error
    }

    let initPromise: Promise<unknown> | undefined
    try {
      state = 'starting'
      logForDebugging(`Starting LSP server instance: ${name}`)

      // Start the client
// 真正 spawn 子进程的地方（在 LSPClient 里用 child_process.spawn）。
// 类比 Java：new ProcessBuilder(command, args).directory(cwd).environment(env).start()
// 注意 cwd 传的是 workspaceFolder——language server 只有在正确的项目根目录下才能找到 tsconfig/pyproject 等配置。
      await client.start(config.command, config.args || [], {
        env: config.env,
        cwd: config.workspaceFolder,
      })

      // Initialize with workspace info
// 兜底：配置里没写工作目录就用当前进程的工作目录（getCwd()）。
      const workspaceFolder = config.workspaceFolder || getCwd()
// LSP 里所有路径都必须是 file:// 形式的 URI（不是裸路径）——因为 LSP 协议同时支持 file/ftp/内存虚拟文件等。
// 类比 Java：new File(path).toURI().toString()
      const workspaceUri = pathToFileURL(workspaceFolder).href

      const initParams: InitializeParams = {
        processId: process.pid,

        // Pass server-specific initialization options from plugin config
        // Required by vue-language-server, optional for others
        // Provide empty object as default to avoid undefined errors in servers
        // that expect this field to exist
// 某些 server 靠这个字段收插件私有配置（比如 vue-language-server 必须要有），
// 所以即使没配也传空对象 {}，而不是 undefined——避免对端读字段时直接炸。
        initializationOptions: config.initializationOptions ?? {},

        // Modern approach (LSP 3.16+) - required for Pyright, gopls
        workspaceFolders: [
          {
            uri: workspaceUri,
            name: path.basename(workspaceFolder),
          },
        ],

        // Deprecated fields - some servers still need these for proper URI resolution
        rootPath: workspaceFolder, // Deprecated in LSP 3.8 but needed by some servers
        rootUri: workspaceUri, // Deprecated in LSP 3.16 but needed by typescript-language-server for goToDefinition

        // Client capabilities - declare what features we support
// capabilities = 「客户端能力声明」。这是 LSP 握手的核心：客户端先说清自己支持什么，
// server 才不会发来我们处理不了的反向请求（比如 workspace/configuration）。
// 类比 Java：类似 HTTP 请求头里的 Accept / Content-Type 协商。
        capabilities: {
          workspace: {
            // Don't claim to support workspace/configuration since we don't implement it
            // This prevents servers from requesting config we can't provide
            configuration: false,
            // Don't claim to support workspace folders changes since we don't handle
            // workspace/didChangeWorkspaceFolders notifications
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
// publishDiagnostics 相关能力：这决定了 server 会不会把类型错误「推」回来。
// Claude Code 能「看到编译器报错」就是靠这个（详细见 LSPDiagnosticRegistry.ts）。
              relatedInformation: true,
              tagSupport: {
                valueSet: [1, 2], // Unnecessary (1), Deprecated (2)
              },
              versionSupport: false,
              codeDescriptionSupport: true,
              dataSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: {
              dynamicRegistration: false,
            },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: {
              dynamicRegistration: false,
            },
          },
          general: {
// 位置编码用 utf-16：这是 VSCode/TypeScript 生态的约定。LSP 的 line/character 里
// character 是 UTF-16 码元下标，不是 Unicode 码点——处理 emoji 时容易踩坑。
            positionEncodings: ['utf-16'],
          },
        },
      }

// initialize 是 LSP 的握手请求（有响应）。必须先于任何其他请求发出。
      initPromise = client.initialize(initParams)
// 为什么要超时：某些 language server（尤其 Java 的 JDT LS、C# 的 OmniSharp）首次启动要几十秒，
// 甚至可能一直卡住。加超时可以避免整个 CLI 被一个 server 拖死。
      if (config.startupTimeout !== undefined) {
        await withTimeout(
          initPromise,
          config.startupTimeout,
          `LSP server '${name}' timed out after ${config.startupTimeout}ms during initialization`,
        )
      } else {
        await initPromise
      }

// 只有到这里才算「可用」。在此之前 state 一直是 'starting'，
// 此时上层若发请求会被 sendRequest 的健康检查挡掉（而不是打到半死的 server 上）。
      state = 'running'
      startTime = new Date()
      crashRecoveryCount = 0
      logForDebugging(`LSP server instance started: ${name}`)
    } catch (error) {
      // Clean up the spawned child process on timeout/error
// 关键：启动失败必须把子进程杀掉，否则会留下一堆孤儿进程（macOS 上能看到一堆 python/gopls 常驻）。
// client.stop() 可能自己也失败，所以加 .catch(() => {}) 吞掉，避免掩盖真正的启动错误。
// 同理 initPromise 若已被放弃也要 catch，否则会触发 Node 的 unhandledRejection 把进程搞崩。
      client.stop().catch(() => {})
      // Prevent unhandled rejection from abandoned initialize promise
      initPromise?.catch(() => {})
      state = 'error'
      lastError = error as Error
      logError(error)
      throw error
    }
  }

  /**
   * Stops the LSP server gracefully.
   *
   * If already stopped or stopping, returns immediately.
   * On failure, sets state to 'error', logs for monitoring, and throws.
   *
   * @throws {Error} If server fails to stop
   */
// 中文补充：优雅停止 = 先发 shutdown 请求，再发 exit 通知，最后 kill 进程。
// 不优雅停止的后果：server 来不及把 .tsbuildinfo / 缓存索引落盘，下次启动又要全量重建。
  async function stop(): Promise<void> {
    if (state === 'stopped' || state === 'stopping') {
      return
    }

    try {
      state = 'stopping'
      await client.stop()
      state = 'stopped'
      logForDebugging(`LSP server instance stopped: ${name}`)
    } catch (error) {
      state = 'error'
      lastError = error as Error
      logError(error)
      throw error
    }
  }

  /**
   * Manually restarts the server by stopping and starting it.
   *
   * Increments restartCount and enforces maxRestarts limit.
   * Note: This is NOT automatic - must be called explicitly.
   *
   * @throws {Error} If stop or start fails, or if restartCount exceeds config.maxRestarts (default: 3)
   */
// 中文补充：restart 是「手动」的，本文件不会自动重启崩溃的 server（那是上层 manager 的事）。
// 这里额外维护 restartCount，防止调用方死循环重启。
  async function restart(): Promise<void> {
    try {
      await stop()
    } catch (error) {
      const stopError = new Error(
        `Failed to stop LSP server '${name}' during restart: ${errorMessage(error)}`,
      )
      logError(stopError)
      throw stopError
    }

    restartCount++

    const maxRestarts = config.maxRestarts ?? 3
    if (restartCount > maxRestarts) {
      const error = new Error(
        `Max restart attempts (${maxRestarts}) exceeded for server '${name}'`,
      )
      logError(error)
      throw error
    }

    try {
      await start()
    } catch (error) {
      const startError = new Error(
        `Failed to start LSP server '${name}' during restart (attempt ${restartCount}/${maxRestarts}): ${errorMessage(error)}`,
      )
      logError(startError)
      throw startError
    }
  }

  /**
   * Checks if the server is healthy and ready to handle requests.
   *
   * @returns true if state is 'running' AND the client has completed initialization
   */
// 两个条件都要满足：状态是 running，且底层 client 已完成 initialize 握手。
// 只看 state 是不够的——state 在 await initialize 之前就可能被别处改过。
  function isHealthy(): boolean {
    return state === 'running' && client.isInitialized
  }

  /**
   * Sends an LSP request to the server with retry logic for transient errors.
   *
   * Checks server health before sending and wraps errors with context.
   * Automatically retries on "content modified" errors (code -32801) which occur
   * when servers like rust-analyzer are still indexing. This is expected LSP behavior
   * and clients should retry silently per the LSP specification.
   *
   * @param method - LSP method name (e.g., 'textDocument/definition')
   * @param params - Method-specific parameters
   * @returns The server's response
   * @throws {Error} If server is not healthy or request fails after all retries
   */
// 中文补充：这是上层最常用的方法（跳转定义、找引用、取符号都走它）。
// 它在「传输层」之上加了两层保护：① 健康检查 ② 瞬时错误指数退避重试。
  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send request to LSP server '${name}': server is ${state}` +
          `${lastError ? `, last error: ${lastError.message}` : ''}`,
      )
      logError(error)
      throw error
    }

    let lastAttemptError: Error | undefined

// 注意是 attempt <= MAX，所以实际最多尝试 4 次（首次 + 3 次重试）。
    for (
      let attempt = 0;
      attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS;
      attempt++
    ) {
      try {
        return await client.sendRequest(method, params)
      } catch (error) {
        lastAttemptError = error as Error

        // Check if this is a transient "content modified" error that we should retry
        // This commonly happens with rust-analyzer during initial project indexing.
        // We use duck typing instead of instanceof because there may be multiple
        // versions of vscode-jsonrpc in the dependency tree (8.2.0 vs 8.2.1).
// 为什么用鸭子类型而不是 instanceof：依赖树里可能同时装了 vscode-jsonrpc 8.2.0 和 8.2.1，
// 两个版本的 ResponseError 类是不同的构造函数，instanceof 会判 false 导致重试逻辑失效。
// 直接读 code 字段最稳。Java 类比：OSGi/多 ClassLoader 环境下 instanceof 失效的同类问题。
        const errorCode = (error as { code?: number }).code
        const isContentModifiedError =
          typeof errorCode === 'number' &&
          errorCode === LSP_ERROR_CONTENT_MODIFIED

        if (
          isContentModifiedError &&
          attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS
        ) {
// 指数退避：第 0 次重试等 500ms、第 1 次 1000ms、第 2 次 2000ms。
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          logForDebugging(
            `LSP request '${method}' to '${name}' got ContentModified error, ` +
              `retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES_FOR_TRANSIENT_ERRORS})…`,
          )
          await sleep(delay)
          continue
        }

        // Non-retryable error or max retries exceeded
        break
      }
    }

    // All retries failed or non-retryable error
    const requestError = new Error(
// 统一包装错误：把底层 JSON-RPC 的原始错误包装成带 server 名和方法名的错误，
// 否则日志里只有一句 "ContentModified"，根本不知道是哪个 server 哪个请求出的问题。
      `LSP request '${method}' failed for server '${name}': ${lastAttemptError?.message ?? 'unknown error'}`,
    )
    logError(requestError)
    throw requestError
  }

// notification 与 request 的区别（LSP/JSON-RPC 核心概念）：
// - request：有 id、有响应，需要 await 结果（如 textDocument/definition）
// - notification：无 id、无响应，发了就不管（如 textDocument/didOpen、didChange）
// 类比 Java：request ≈ 同步 RPC 调用；notification ≈ 发个消息到 MQ 不等回执。
  /**
   * Send a notification to the LSP server (fire-and-forget).
   * Used for file synchronization (didOpen, didChange, didClose).
   */
  async function sendNotification(
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send notification to LSP server '${name}': server is ${state}`,
      )
      logError(error)
      throw error
    }

    try {
      await client.sendNotification(method, params)
    } catch (error) {
      const notificationError = new Error(
        `LSP notification '${method}' failed for server '${name}': ${errorMessage(error)}`,
      )
      logError(notificationError)
      throw notificationError
    }
  }

  /**
   * Registers a handler for LSP notifications from the server.
   *
   * @param method - LSP notification method (e.g., 'window/logMessage')
   * @param handler - Callback function to handle the notification
   */
// 注册「server → 客户端」方向的通知处理器。最典型的是 publishDiagnostics（诊断信息回流），
// 也有 window/logMessage 之类。注意方向：这里是 server 主动推给我们。
  function onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): void {
    client.onNotification(method, handler)
  }

  /**
   * Registers a handler for LSP requests from the server.
   *
   * Some LSP servers send requests TO the client (reverse direction).
   * This allows registering handlers for such requests.
   *
   * @param method - LSP request method (e.g., 'workspace/configuration')
   * @param handler - Callback function to handle the request and return a response
   */
// 注册「server → 客户端」方向的请求处理器（反向请求，server 向我们要东西，必须应答）。
// 常见如 workspace/configuration、client/registerCapability。
// 泛型两个参数：TParams 入参类型、TResult 返回类型；返回 TResult | Promise<TResult>
// 表示「同步返回也行，异步返回也行」——≈ Java 的方法可以返回 T 也可以返回 CompletableFuture<T>。
  function onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void {
    client.onRequest(method, handler)
  }

// 返回的对象就是对外公开的 API。注意 state/startTime 等用的是 getter（get xxx()），
// 所以外部每次读到的都是闭包里的当前值，而不是这里构造时的快照值。
  // Return public API
  return {
    name,
    config,
    get state() {
      return state
    },
    get startTime() {
      return startTime
    },
    get lastError() {
      return lastError
    },
    get restartCount() {
      return restartCount
    },
    start,
    stop,
    restart,
    isHealthy,
    sendRequest,
    sendNotification,
    onNotification,
    onRequest,
  }
}

/**
 * Race a promise against a timeout. Cleans up the timer regardless of outcome
 * to avoid unhandled rejections from orphaned setTimeout callbacks.
 */
// 中文补充：通用的「给 Promise 加超时」工具。为什么不用 Promise 自带的 API？因为标准库没有 timeout。
// Java 类比：CompletableFuture.orTimeout(ms, MILLISECONDS)（Java 9+）。
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
// 先声明后赋值：timer 在 Promise 构造函数的同步执行过程中被赋值，所以在 finally 里一定已经有值。
// `ReturnType<typeof setTimeout>` ≈ 取 setTimeout 返回类型（Node 里是 Timeout 对象，浏览器里是 number），
// 这样一套代码能同时跑在两种环境。Java 类比：用 var 或直接引用常量类型避免写死具体类。
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
// setTimeout 的第三个及之后的参数会作为回调的实参传入，这里把 reject 和 message 直接传进去，
// 省掉一层箭头函数闭包。这是 Node/浏览器 setTimeout 的通用特性。
    timer = setTimeout((rej, msg) => rej(new Error(msg)), ms, reject, message)
  })
  return Promise.race([promise, timeoutPromise]).finally(() =>
// `timer!` 非空断言：编译器不知道 timer 一定被赋过值，我们手动保证。
// 必须清定时器，否则即使 Promise 早已完成，定时器仍会让事件循环多留 ms 毫秒（影响 CLI 退出）。
    clearTimeout(timer!),
  )
}
