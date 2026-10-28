/**
 * 【一句话定位】
 * LSP 的「多实例调度中心」：把多个 language server 实例管起来，按文件后缀（.ts/.py/.go…）路由到
 * 对应的 server，并负责文件内容的同步（didOpen/didChange/didSave/didClose）。
 *
 * 【在架构中的位置】
 * 调用链（自顶向下）：
 *   LSPDiagnosticRegistry / passiveFeedback / 各类 LSP 工具
 *     → 本文件 createLSPServerManager()（按后缀选 server + 同步文件内容）
 *       → LSPServerInstance.ts（单实例状态机）→ LSPClient.ts（spawn + JSON-RPC）→ language server 子进程
 * 横向依赖：config.ts 的 getAllLspServers() 提供「有哪些 server、各自负责哪些后缀」的配置。
 * 一句话概括本文件的价值：上层只需要说「帮我查 /a/b.ts 的定义」，不需要知道用的是哪个 server。
 *
 * 【为什么需要文件同步这一步】
 * language server 是「有状态」的：它内部维护着一份虚拟文件缓冲区。你直接改磁盘上的文件，
 * 它是不知道的。必须显式用 didOpen/didChange 通知它，它才会重新分析并给出最新诊断。
 * 类比 Java：JDT LS 里也有 ICompilationUnit 的工作副本（working copy）概念，不 discarding/refresh 就不会重编。
 *
 * 【本文件包含什么】
 * - type LSPServerManager：管理器对外接口（initialize/shutdown/路由/文件同步）。
 * - createLSPServerManager()：工厂函数，闭包持有 servers、extensionMap、openedFiles 三张表。
 * - initialize()：读配置 → 校验 → 建「后缀 → server」映射 → 创建实例 → 注册反向请求处理器。
 * - shutdown()：并发停止所有 server（allSettled 保证一个失败不影响其他）。
 * - getServerForFile() / ensureServerStarted() / sendRequest()：路由三件套。
 * - openFile() / changeFile() / saveFile() / closeFile() / isFileOpen()：文件同步五件套。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `Map<string, LSPServerInstance>`：≈ Java 的 HashMap，语法几乎一样（new Map()/get/set/has/clear/size）。
 *   注意取大小是 `.size` 属性（不是 Java 的 size() 方法）。
 * - `Object.entries(serverConfigs)`：把对象转成 `[key, value][]` 二维数组。
 *   ≈ Java 的 `map.entrySet()`；配合 `for (const [k, v] of ...)` 就是遍历 Entry，
 *   方括号里的 `[serverName, config]` 叫「数组解构」，直接把两个元素解成两个变量。
 * - `Object.keys(obj)`：取对象的所有键，返回 string[]。≈ Java 的 map.keySet()。
 * - `Record<string, ScopedLspServerConfig>`：内置工具类型，等价于「键是 string、值是 X 的对象」。
 *   ≈ Java 的 `Map<String, X>`，但 TS 里它是普通对象而不是 Map 实例。
 * - `server.state === 'stopped' || server.state === 'error'`：
 *   state 是字符串字面量联合类型（'stopped' | 'starting' | ...）。
 *   ≈ Java 的 enum 比较，但 TS 里可以直接写 `=== 'stopped'`，编译器还能检查你有没有写错拼写。
 * - `Promise.allSettled([...])`：并发执行并「等待全部结束」，且不会因为某一个 reject 就整体失败。
 *   ≈ Java 里把所有 CompletableFuture 都 handle() 一遍再 join。
 *   对比：`Promise.all` 是「一个失败就整体失败」（fail fast）。这里要停掉所有 server，所以用 allSettled。
 * - `r.status === 'rejected' ? ... : null`：三元运算符，和 Java 的 `? :` 一样。
 * - `.filter((e): e is string => e !== null)`：
 *   `e is string` 是「类型谓词」——告诉编译器「返回 true 时，e 一定是 string」。
 *   ≈ Java 16+ 的 `instanceof String s` 模式匹配：判断的同时顺带收窄类型。
 *   没有它，filter 之后的数组类型仍是 (string|null)[]，后面 join 会报错。
 * - `toStop[i]![0]`：末尾 `!` 是非空断言（保证不是 undefined），`[0]` 取数组第一个元素。
 *   合起来 ≈ Java 的 `toStop.get(i).getKey()`，但 TS 数组下标访问不检查越界，所以要自己保证。
 * - `server.config.extensionToLanguage[ext] || 'plaintext'`：
 *   `||` 在这里当「取不到就兜底」用。注意它同时会把空字符串 '' 也替换掉（这里正好是我们想要的）。
 * - `async function openFile(...): Promise<void>` 里 `return openFile(...)`：
 *   在 async 函数里 return 一个 Promise 是合法的，等价于 await 后再返回。
 * - 函数声明 `function foo() {}` 会被「提升」，所以 return 在定义之前也没问题（Java 没有这个特性）。
 * - `params.items.map(() => null)`：数组的 map ≈ Java Stream 的 map；箭头函数忽略参数写成 `() =>`。
 * - `catch (error) { const err = error as Error ... }`：catch 变量默认是 unknown，必须 as 断言才能用。
 */
import * as path from 'path'
import { pathToFileURL } from 'url'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getAllLspServers } from './config.js'
import {
  createLSPServerInstance,
  type LSPServerInstance,
} from './LSPServerInstance.js'
import type { ScopedLspServerConfig } from './types.js'
/**
 * LSP Server Manager interface returned by createLSPServerManager.
 * Manages multiple LSP server instances and routes requests based on file extensions.
 */
// 中文补充：这是「多 server 调度器」的契约。核心是三件事——初始化、按后缀路由、文件同步。
// 注意返回值里大量出现 `| undefined`（如 getServerForFile 返回 LSPServerInstance | undefined）：
// 这是 TS 的风格，表示「可能找不到」。≈ Java 的 Optional<T>，只是 TS 用联合类型表达，
// 调用方必须用 if (!server) 判空，否则编译器会拦住你（比 Java 的 NPE 友好）。
export type LSPServerManager = {
  /** Initialize the manager by loading all configured LSP servers */
  initialize(): Promise<void>
  /** Shutdown all running servers and clear state */
  shutdown(): Promise<void>
  /** Get the LSP server instance for a given file path */
  getServerForFile(filePath: string): LSPServerInstance | undefined
  /** Ensure the appropriate LSP server is started for the given file */
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>
  /** Send a request to the appropriate LSP server for the given file */
  sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined>
  /** Get all running server instances */
  getAllServers(): Map<string, LSPServerInstance>
  /** Synchronize file open to LSP server (sends didOpen notification) */
  openFile(filePath: string, content: string): Promise<void>
  /** Synchronize file change to LSP server (sends didChange notification) */
  changeFile(filePath: string, content: string): Promise<void>
  /** Synchronize file save to LSP server (sends didSave notification) */
  saveFile(filePath: string): Promise<void>
  /** Synchronize file close to LSP server (sends didClose notification) */
  closeFile(filePath: string): Promise<void>
  /** Check if a file is already open on a compatible LSP server */
  isFileOpen(filePath: string): boolean
}

/**
 * Creates an LSP server manager instance.
 *
 * Manages multiple LSP server instances and routes requests based on file extensions.
 * Uses factory function pattern with closures for state encapsulation (avoiding classes).
 *
 * @returns LSP server manager instance
 *
 * @example
 * const manager = createLSPServerManager()
 * await manager.initialize()
 * const result = await manager.sendRequest('/path/to/file.ts', 'textDocument/definition', params)
 * await manager.shutdown()
 */
// 中文补充（设计意图）：
// 为什么要单独一层 Manager？因为一个项目往往混合多种语言，每种语言一个 server 进程，
// 而且这些进程要「按需启动」（用到 .py 才起 pyright，不能一上来全起，太吃内存）。
// Manager 就是那个「按需启动 + 按后缀路由」的调度器。
// 同样用工厂函数 + 闭包来避免 class 和 this。
export function createLSPServerManager(): LSPServerManager {
  // Private state managed via closures
// 三张核心表（闭包私有状态，≈ Java private final Map）：
// servers:      server 名字 → 实例
// extensionMap: 文件后缀（如 '.ts'）→ 能处理它的 server 名字列表
// openedFiles:  文件 URI → 当前在哪个 server 上打开着（避免重复 didOpen）
  const servers: Map<string, LSPServerInstance> = new Map()
  const extensionMap: Map<string, string[]> = new Map()
  // Track which files have been opened on which servers (URI -> server name)
  const openedFiles: Map<string, string> = new Map()

  /**
   * Initialize the manager by loading all configured LSP servers.
   *
   * @throws {Error} If configuration loading fails
   */
// 关键步骤：① 读配置 ② 逐个校验并建「后缀 → server」映射 ③ 创建实例 ④ 注册反向请求处理器。
// 注意：这里只是「登记」server，并不会真的启动子进程——真正的启动推迟到 ensureServerStarted（懒加载）。
  async function initialize(): Promise<void> {
    let serverConfigs: Record<string, ScopedLspServerConfig>

    try {
// getAllLspServers() 会合并内置默认配置 + 用户配置（见同目录 config.ts）。
      const result = await getAllLspServers()
      serverConfigs = result.servers
      logForDebugging(
        `[LSP SERVER MANAGER] getAllLspServers returned ${Object.keys(serverConfigs).length} server(s)`,
      )
    } catch (error) {
      const err = error as Error
      logError(
        new Error(`Failed to load LSP server configuration: ${err.message}`),
      )
      throw error
    }

    // Build extension → server mapping
// 容错设计：单个 server 配置有问题时只记日志、跳过它，不影响其他 server。
// 否则用户配错一个 pyright，整个 LSP 功能（包括好用的 TS）就全挂了，代价太大。
    for (const [serverName, config] of Object.entries(serverConfigs)) {
      try {
        // Validate config before using it
// command 是必填：没有启动命令就无法 spawn 子进程。
        if (!config.command) {
          throw new Error(
            `Server ${serverName} missing required 'command' field`,
          )
        }
        if (
          !config.extensionToLanguage ||
          Object.keys(config.extensionToLanguage).length === 0
        ) {
          throw new Error(
            `Server ${serverName} missing required 'extensionToLanguage' field`,
          )
        }

        // Map file extensions to this server (derive from extensionToLanguage)
// 后缀统一转小写：文件系统对大小写敏感度不一（macOS 默认不敏感，Linux 敏感），
// 不归一化的话 .TS 和 .ts 会被当成两种后缀。
        const fileExtensions = Object.keys(config.extensionToLanguage)
        for (const ext of fileExtensions) {
          const normalized = ext.toLowerCase()
          if (!extensionMap.has(normalized)) {
            extensionMap.set(normalized, [])
          }
// 为什么 Map.get() 之后还要判空：TS 的 Map.get 返回 `V | undefined`，
// 编译器不知道这个 key 一定存在（虽然我们上一行刚 set 过），所以必须再判一次。
          const serverList = extensionMap.get(normalized)
          if (serverList) {
            serverList.push(serverName)
          }
        }

        // Create server instance
// 创建实例但不启动——真正的 spawn 在 ensureServerStarted 里按需触发。
        const instance = createLSPServerInstance(serverName, config)
        servers.set(serverName, instance)

        // Register handler for workspace/configuration requests from the server
        // Some servers (like TypeScript) send these even when we say we don't support them
// 反向请求处理器：server 问我们要配置（workspace/configuration）。
// 为什么明明在 capabilities 里声明了 configuration: false 还要处理？
// 因为有些 server（尤其 typescript-language-server）不遵守规范，照样会发。
// 不回应的话它会一直等超时，表现为「LSP 突然变慢」。这里回一串 null 把它打发掉最省事。
        instance.onRequest(
          'workspace/configuration',
          (params: { items: Array<{ section?: string }> }) => {
            logForDebugging(
              `LSP: Received workspace/configuration request from ${serverName}`,
            )
            // Return empty/null config for each requested item
            // This satisfies the protocol without providing actual configuration
// 每个 item 回一个 null，凑成和请求等长的数组——LSP 规范要求按序一一对应。
            return params.items.map(() => null)
          },
        )
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `Failed to initialize LSP server ${serverName}: ${err.message}`,
          ),
        )
        // Continue with other servers - don't fail entire initialization
      }
    }

    logForDebugging(`LSP manager initialized with ${servers.size} servers`)
  }

  /**
   * Shutdown all running servers and clear state.
   * Only servers in 'running' state are explicitly stopped;
   * servers in other states are cleared without shutdown.
   *
   * @throws {Error} If one or more servers fail to stop
   */
// 关键步骤：① 挑出需要停的（running 或 error 状态）② 并发停 ③ 清空三张表 ④ 汇总错误统一抛出。
// 为什么 error 状态的也要停：它可能是「启动失败但子进程已经拉起来」的半死状态，有残留进程要清。
  async function shutdown(): Promise<void> {
    const toStop = Array.from(servers.entries()).filter(
      ([, s]) => s.state === 'running' || s.state === 'error',
    )

// Promise.allSettled：即使某个 server 停失败，也要保证其他 server 都被停掉。
// 如果用 Promise.all，第一个失败就会短路，剩下的进程会变成孤儿进程。
    const results = await Promise.allSettled(
      toStop.map(([, server]) => server.stop()),
    )

    servers.clear()
    extensionMap.clear()
    openedFiles.clear()

// 把结果映射成「错误描述字符串数组」，过滤掉成功的（null）。
// `.filter((e): e is string => e !== null)` 里的 `e is string` 是类型谓词，
// 作用类似 Java 的 `instanceof String s` 模式匹配——判定的同时把类型收窄成 string，
// 否则后面 errors.join() 会因为数组里还有 null 而编译报错。
    const errors = results
      .map((r, i) =>
        r.status === 'rejected'
          ? `${toStop[i]![0]}: ${errorMessage(r.reason)}`
          : null,
      )
      .filter((e): e is string => e !== null)

    if (errors.length > 0) {
      const err = new Error(
        `Failed to stop ${errors.length} LSP server(s): ${errors.join('; ')}`,
      )
      logError(err)
      throw err
    }
  }

  /**
   * Get the LSP server instance for a given file path.
   * If multiple servers handle the same extension, returns the first registered server.
   * Returns undefined if no server handles this file type.
   */
// 路由核心：后缀 → server 名字列表 → 取第一个。
// 设计取舍：多个 server 都支持同一后缀时（比如 .ts 可能同时被 tsserver 和 vue-language-server 支持），
// 目前简单地取「先注册的那个」，没有做优先级。TODO 就留在这。
  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = path.extname(filePath).toLowerCase()
    const serverNames = extensionMap.get(ext)

    if (!serverNames || serverNames.length === 0) {
      return undefined
    }

// serverNames[0] 的类型是 `string | undefined`（TS 默认不保证下标存在），所以还要判一次空。
// Java 里数组越界是运行时异常；TS 这里直接把返回值类型标成可能 undefined，逼你编译期处理。
    // Use first server (can add priority later)
    const serverName = serverNames[0]
    if (!serverName) {
      return undefined
    }

    return servers.get(serverName)
  }

  /**
   * Ensure the appropriate LSP server is started for the given file.
   * Returns undefined if no server handles this file type.
   *
   * @throws {Error} If server fails to start
   */
// 懒启动的唯一入口：上层所有操作都先调它，保证「用到才起、起了就复用」。
// 只在 stopped / error 两种状态下才真正 start——starting/running 时直接复用已有实例，
// 避免并发请求导致重复 spawn 出多个相同进程（很常见的资源泄漏坑）。
  async function ensureServerStarted(
    filePath: string,
  ): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(filePath)
    if (!server) return undefined

    if (server.state === 'stopped' || server.state === 'error') {
      try {
        await server.start()
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `Failed to start LSP server for file ${filePath}: ${err.message}`,
          ),
        )
        throw error
      }
    }

    return server
  }

  /**
   * Send a request to the appropriate LSP server for the given file.
   * Returns undefined if no server handles this file type.
   *
   * @throws {Error} If server fails to start or request fails
   */
// 最上层的便捷方法：自动选 server + 自动启动 + 发请求。
// 返回 `T | undefined`：undefined 表示「这个后缀没有对应的 server」，不是错误，调用方要区分对待。
  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath)
    if (!server) return undefined

    try {
      return await server.sendRequest<T>(method, params)
    } catch (error) {
      const err = error as Error
      logError(
        new Error(
          `LSP request failed for file ${filePath}, method '${method}': ${err.message}`,
        ),
      )
      throw error
    }
  }

  // Return public interface
  function getAllServers(): Map<string, LSPServerInstance> {
    return servers
  }

// didOpen：把文件内容「交给」server。等价于 IDE 里打开一个文件标签页。
// 必须先 didOpen 才能 didChange，否则 server 会报 UnknownDocument。
// languageId（'typescript'/'python'…）是从配置的后缀映射里查出来的，查不到就用 'plaintext'。
  async function openFile(filePath: string, content: string): Promise<void> {
    const server = await ensureServerStarted(filePath)
    if (!server) return

// 用 path.resolve 转成绝对路径再转 file:// URI。
// 必须绝对路径：相对路径转出来的 URI 在不同 cwd 下会指向不同文件，server 会找不到文档。
    const fileUri = pathToFileURL(path.resolve(filePath)).href

    // Skip if already opened on this server
// 幂等保护：同一个文件在同一个 server 上重复 didOpen，规范上是错误的（会报 document already opened）。
    if (openedFiles.get(fileUri) === server.name) {
      logForDebugging(
        `LSP: File already open, skipping didOpen for ${filePath}`,
      )
      return
    }

    // Get language ID from server's extensionToLanguage mapping
    const ext = path.extname(filePath).toLowerCase()
    const languageId = server.config.extensionToLanguage[ext] || 'plaintext'

    try {
      await server.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId,
// version 是文档版本号，LSP 用它判断「你这份内容是不是最新的」。
// 这里固定写 1，因为 Claude Code 每次都全量推送内容，不做增量 diff。
          version: 1,
          text: content,
        },
      })
      // Track that this file is now open on this server
      openedFiles.set(fileUri, server.name)
      logForDebugging(
        `LSP: Sent didOpen for ${filePath} (languageId: ${languageId})`,
      )
    } catch (error) {
      const err = new Error(
        `Failed to sync file open ${filePath}: ${errorMessage(error)}`,
      )
      logError(err)
      // Re-throw to propagate error to caller
      throw err
    }
  }

// 为什么这里要先判 running：如果 server 还没起来，我们手上这份内容就是「最新全量内容」，
// 直接降级走 openFile（一次性全量同步）比「先启动再发增量」更简单可靠。
// 同理，文件从没在这个 server 上打开过，也降级走 openFile——因为 LSP 要求先 didOpen。
  async function changeFile(filePath: string, content: string): Promise<void> {
    const server = getServerForFile(filePath)
    if (!server || server.state !== 'running') {
      return openFile(filePath, content)
    }

    const fileUri = pathToFileURL(path.resolve(filePath)).href

    // If file hasn't been opened on this server yet, open it first
    // LSP servers require didOpen before didChange
    if (openedFiles.get(fileUri) !== server.name) {
      return openFile(filePath, content)
    }

    try {
// didChange：增量更新。contentChanges: [{ text: content }] 这种「只给全文本、不给 range」的写法，
// 在 LSP 里表示「整个文档被替换成这份内容」（full sync），比增量 range 同步简单且不易出错。
      await server.sendNotification('textDocument/didChange', {
        textDocument: {
          uri: fileUri,
          version: 1,
        },
        contentChanges: [{ text: content }],
      })
      logForDebugging(`LSP: Sent didChange for ${filePath}`)
    } catch (error) {
      const err = new Error(
        `Failed to sync file change ${filePath}: ${errorMessage(error)}`,
      )
      logError(err)
      // Re-throw to propagate error to caller
      throw err
    }
  }

// didSave：告诉 server「文件已落盘」。为什么要发？因为很多 server 只在保存后才做
// 重量级检查（比如类型全量检查、linter）。Claude Code 写完文件后发一条，就能立刻拿到完整诊断。
  /**
   * Save a file in LSP servers (sends didSave notification)
   * Called after file is written to disk to trigger diagnostics
   */
  async function saveFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath)
    if (!server || server.state !== 'running') return

    try {
      await server.sendNotification('textDocument/didSave', {
        textDocument: {
          uri: pathToFileURL(path.resolve(filePath)).href,
        },
      })
      logForDebugging(`LSP: Sent didSave for ${filePath}`)
    } catch (error) {
      const err = new Error(
        `Failed to sync file save ${filePath}: ${errorMessage(error)}`,
      )
      logError(err)
      // Re-throw to propagate error to caller
      throw err
    }
  }

// didClose：告诉 server「这个文件我不用了」，可以释放它的语法树/索引缓存。
// 目前还没接到 compact 流程上（见下方英文 TODO：文件被移出上下文时应该 close 掉）。
  /**
   * Close a file in LSP servers (sends didClose notification)
   *
   * NOTE: Currently available but not yet integrated with compact flow.
   * TODO: Integrate with compact - call closeFile() when compact removes files from context
   * This will notify LSP servers that files are no longer in active use.
   */
  async function closeFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath)
    if (!server || server.state !== 'running') return

    const fileUri = pathToFileURL(path.resolve(filePath)).href

    try {
      await server.sendNotification('textDocument/didClose', {
        textDocument: {
          uri: fileUri,
        },
      })
      // Remove from tracking so file can be reopened later
      openedFiles.delete(fileUri)
      logForDebugging(`LSP: Sent didClose for ${filePath}`)
    } catch (error) {
      const err = new Error(
        `Failed to sync file close ${filePath}: ${errorMessage(error)}`,
      )
      logError(err)
      // Re-throw to propagate error to caller
      throw err
    }
  }

// 判断某个文件当前是否在某个 server 上打开着（按 URI 查表）。
  function isFileOpen(filePath: string): boolean {
    const fileUri = pathToFileURL(path.resolve(filePath)).href
    return openedFiles.has(fileUri)
  }

// 返回公开接口。注意这里返回的是函数引用，不是对象快照，所以闭包里的表变化对外是可见的。
  return {
    initialize,
    shutdown,
    getServerForFile,
    ensureServerStarted,
    sendRequest,
    getAllServers,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    isFileOpen,
  }
}
