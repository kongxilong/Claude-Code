/**
 * 【一句话定位】
 * LSP 子系统的「全局单例门面（Facade）」：整个进程只有一份 LSPServerManager，本文件负责它的
 * 创建、状态机、幂等初始化、重新初始化与关停，并对外暴露只读的查询入口。
 *
 * 【在架构中的位置】
 * 调用链：
 *   应用启动 / 插件刷新（refreshActivePlugins）
 *     → 本文件 initializeLspServerManager() / reinitializeLspServerManager()
 *       → LSPServerManager.createLSPServerManager().initialize()（读配置、登记 server）
 *       → passiveFeedback.registerLSPNotificationHandlers()（挂诊断监听）
 *   各类 LSP 工具 → 本文件 getLspServerManager() / isLspConnected() → LSPServerManager
 *   应用退出 → 本文件 shutdownLspServerManager() → 停掉所有子进程
 * 一句话：上层任何地方想用 LSP，都从本文件拿管理器，不自己 new。
 *
 * 【为什么初始化是「异步但非阻塞」的】
 * 读插件配置、解析 server 列表可能耗时。如果启动时同步 await，CLI 首屏会被拖慢。
 * 所以这里是「同步创建实例 + 后台异步初始化」：实例立刻可用（但里面还没 server），
 * 配置加载完再填充。上层用 waitForInitialization() 等它就绪即可。
 * 代价：getLspServerManager() 可能返回一个「还没装好」的实例，所以注释反复强调要判空。
 *
 * 【本文件包含什么】
 * - type InitializationState：四态枚举 'not-started' | 'pending' | 'success' | 'failed'。
 * - lspManagerInstance / initializationState / initializationError / initializationGeneration /
 *   initializationPromise：五个模块级单例状态变量。
 * - _resetLspManagerForTesting()：仅测试用的同步重置。
 * - getLspServerManager() / getInitializationStatus() / isLspConnected()：三个只读查询。
 * - waitForInitialization()：等待异步初始化完成。
 * - initializeLspServerManager()：幂等初始化入口。
 * - reinitializeLspServerManager()：插件刷新后强制重建（修 issue #15521）。
 * - shutdownLspServerManager()：关停并清状态。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - 模块顶层的 `let x: T | undefined`：这就是「单例」。
 *   ≈ Java 的 `private static X instance;`（类加载一次，全局共享）。
 * - `type InitializationState = 'not-started' | 'pending' | ...`：
 *   字符串字面量联合类型 ≈ Java 的 enum，但本质是「只能是这几个字符串之一」。
 *   好处：写错字符串编译器直接报错，且能用于 switch 的穷尽性检查。
 * - 返回类型写成多行联合：
 *     `| { status: 'not-started' }`
 *     `| { status: 'failed'; error: Error }`
 *   这是「可辨别联合（discriminated union）」——调用方拿到结果后先判断 status，
 *   判断完之后 TS 会自动把类型收窄到对应分支（所以 'failed' 分支下才能访问 error）。
 *   ≈ Java 的 sealed interface + record 配合 `switch (x) { case Failed f -> f.error() }` 模式匹配。
 * - `let lspManagerInstance: LSPServerManager | undefined`：
 *   Java 工程师注意：类型标注在变量名「后面」，而且 `| undefined` 必须显式写出来，
 *   TS 才会强制你判空（开了 strictNullChecks 的前提下）。
 * - `++initializationGeneration`：前置自增，和 Java 一样（先加 1 再取值）。
 * - `const currentGeneration = ++initializationGeneration`：把「当前代次」捕获进闭包。
 *   这是一个经典的「乐观并发控制」技巧：异步回调回来时比对代次，
 *   如果期间又发生了新的初始化/重置，就丢弃这次的过期结果。
 *   Java 类比：用 AtomicInteger 版本号 + compareAndSet 防止过期写入。
 * - `initializationPromise = lspManagerInstance.initialize().then(...).catch(...)`：
 *   Promise 链式调用 ≈ Java 的 CompletableFuture.thenAccept().exceptionally()。
 *   注意这里「没有 await」，所以函数立刻返回（后台跑）。
 * - `void somePromise.catch(...)`：前缀 `void` 表示「我故意不 await 这个 Promise」。
 *   用来告诉 linter 和读者：这是有意的 fire-and-forget，不是忘了 await。
 * - `error as Error`：catch 变量是 unknown，断言成 Error 才能读 message。≈ Java 的 (Error) e。
 * - `try { ... } catch { ... } finally { ... }`：和 Java 完全一样，finally 一定执行。
 * - `for (const server of servers.values())`：遍历 Map 的值。≈ Java 的 `map.values()`。
 * - `export function`（无 default）：具名导出，调用方写 `import { f } from './manager.js'`。
 *   ≈ Java 的 public 静态方法，但一个模块可以导出很多个。
 */
import { logForDebugging } from '../../utils/debug.js'
import { isBareMode } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  createLSPServerManager,
  type LSPServerManager,
} from './LSPServerManager.js'
import { registerLSPNotificationHandlers } from './passiveFeedback.js'

/**
 * Initialization state of the LSP server manager
 */
// 中文补充：四态状态机。注意 'failed' 是终态之一，但允许重试（见 initializeLspServerManager）。
// 用字符串联合而不是 enum，好处是日志里直接打印出来就是可读文本。
type InitializationState = 'not-started' | 'pending' | 'success' | 'failed'

/**
 * Global singleton instance of the LSP server manager.
 * Initialized during Claude Code startup.
 */
// 全局唯一的管理器实例 ≈ Java 的 private static 单例字段。
let lspManagerInstance: LSPServerManager | undefined

/**
 * Current initialization state
 */
let initializationState: InitializationState = 'not-started'

/**
 * Error from last initialization attempt, if any
 */
let initializationError: Error | undefined

/**
 * Generation counter to prevent stale initialization promises from updating state
 */
// 「代次计数器」——本文件最精妙的一处设计。
// 场景：初始化是异步的。如果在它返回之前用户又触发了一次重置/重新初始化，
// 那么旧的异步回调回来时，会把状态改回 success/failed，把新状态覆盖掉（脏写）。
// 解法：每次启动初始化就把 generation +1，回调里比对——不是当前代次就直接丢弃。
// Java 类比：AtomicInteger 版本号 + CAS，或者 Future.cancel() 后再校验 isCancelled()。
let initializationGeneration = 0

/**
 * Promise that resolves when initialization completes (success or failure)
 */
let initializationPromise: Promise<void> | undefined

/**
 * Test-only sync reset. shutdownLspServerManager() is async and tears down
 * real connections; this only clears the module-scope singleton state so
 * reinitializeLspServerManager() early-returns on 'not-started' in downstream
 * tests on the same shard.
 */
// 只给测试用：同步清空单例状态（不去真正关停子进程，那太慢且会断连接）。
// 为什么还要 generation++：让「可能还在飞的旧初始化 Promise」失效，
// 否则下一个测试的断言会被上一个测试的异步回调污染。
export function _resetLspManagerForTesting(): void {
  initializationState = 'not-started'
  initializationError = undefined
  initializationPromise = undefined
  initializationGeneration++
}

/**
 * Get the singleton LSP server manager instance.
 * Returns undefined if not yet initialized, initialization failed, or still pending.
 *
 * Callers should check for undefined and handle gracefully, as initialization happens
 * asynchronously during Claude Code startup. Use getInitializationStatus() to
 * distinguish between pending, failed, and not-started states.
 */
// 唯一的取实例入口。
// 返回 `LSPServerManager | undefined`：undefined 有三种可能——没开始、还在初始化中、初始化失败。
// 想区分这三种情况请用 getInitializationStatus()；只想等它就绪请用 waitForInitialization()。
// Java 类比：Optional<Manager>，但 TS 用「联合类型 + 编译器判空提示」代替 Optional 容器。
export function getLspServerManager(): LSPServerManager | undefined {
  // Don't return a broken instance if initialization failed
// 失败过就当作没有——避免上层拿到一个半初始化的实例去发请求，报出莫名其妙的底层错误。
  if (initializationState === 'failed') {
    return undefined
  }
  return lspManagerInstance
}

/**
 * Get the current initialization status of the LSP server manager.
 *
 * @returns Status object with current state and error (if failed)
 */
// 返回「可辨别联合」：调用方 switch/if 判断 status 之后，TS 会自动收窄类型。
// 例如 status === 'failed' 分支里才能安全访问 .error（其他分支根本没有这个字段）。
// ≈ Java 17+ 的 sealed interface + 模式匹配 switch。
export function getInitializationStatus():
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error } {
  if (initializationState === 'failed') {
    return {
      status: 'failed',
      error: initializationError || new Error('Initialization failed'),
    }
  }
  if (initializationState === 'not-started') {
    return { status: 'not-started' }
  }
  if (initializationState === 'pending') {
    return { status: 'pending' }
  }
  return { status: 'success' }
}

/**
 * Check whether at least one language server is connected and healthy.
 * Backs LSPTool.isEnabled().
 */
// LSP 工具是否可用（LSPTool.isEnabled() 的底层判断）。
// 判定标准很宽松：只要有任意一个 server 不是 error 状态就算「连上了」。
// 为什么这么宽松：server 是懒启动的，此刻都还是 stopped（没起进程），
// 但只要配置里有，就说明「用户需要这个功能」，工具该显示出来。
export function isLspConnected(): boolean {
  if (initializationState === 'failed') return false
  const manager = getLspServerManager()
  if (!manager) return false
  const servers = manager.getAllServers()
  if (servers.size === 0) return false
// 注意用的是 `!== 'error'` 而不是 `=== 'running'`：stopped/starting 都算「有望可用」。
  for (const server of servers.values()) {
    if (server.state !== 'error') return true
  }
  return false
}

/**
 * Wait for LSP server manager initialization to complete.
 *
 * Returns immediately if initialization has already completed (success or failure).
 * If initialization is pending, waits for it to complete.
 * If initialization hasn't started, returns immediately.
 *
 * @returns Promise that resolves when initialization is complete
 */
// 供「真正需要 LSP 结果」的调用方等待初始化完成。
// 已经成功/失败 → 立刻返回；还在 pending → await 那个 Promise；压根没开始 → 也立刻返回（没什么可等的）。
export async function waitForInitialization(): Promise<void> {
  // If already initialized or failed, return immediately
  if (initializationState === 'success' || initializationState === 'failed') {
    return
  }

  // If pending and we have a promise, wait for it
  if (initializationState === 'pending' && initializationPromise) {
    await initializationPromise
  }

  // If not started, return immediately (nothing to wait for)
}

/**
 * Initialize the LSP server manager singleton.
 *
 * This function is called during Claude Code startup. It synchronously creates
 * the manager instance, then starts async initialization (loading LSP configs)
 * in the background without blocking the startup process.
 *
 * Safe to call multiple times - will only initialize once (idempotent).
 * However, if initialization previously failed, calling again will retry.
 */
// 幂等初始化入口（应用启动时调用）。
// 设计要点：同步返回 void，异步初始化在后台跑——不阻塞 CLI 启动。
// 关键步骤：
// ① bare 模式直接跳过（脚本化 -p 调用不需要编辑器能力）
// ② 已初始化/正在初始化则直接返回（幂等）
// ③ 之前失败过则清状态，允许重试
// ④ 创建实例、置 pending、generation+1
// ⑤ 后台 initialize()，成功则注册诊断监听，失败则记状态并把实例置空
export function initializeLspServerManager(): void {
  // --bare / SIMPLE: no LSP. LSP is for editor integration (diagnostics,
  // hover, go-to-def in the REPL). Scripted -p calls have no use for it.
// bare 模式（--bare / SIMPLE）：纯脚本执行，不需要诊断/跳转这类 IDE 能力，起 language server 纯属浪费内存。
  if (isBareMode()) {
    return
  }
  logForDebugging('[LSP MANAGER] initializeLspServerManager() called')

  // Skip if already initialized or currently initializing
// 幂等保护：重复调用不会起第二份管理器（否则会 spawn 出两套子进程）。
  if (lspManagerInstance !== undefined && initializationState !== 'failed') {
    logForDebugging(
      '[LSP MANAGER] Already initialized or initializing, skipping',
    )
    return
  }

  // Reset state for retry if previous initialization failed
  if (initializationState === 'failed') {
    lspManagerInstance = undefined
    initializationError = undefined
  }

  // Create the manager instance and mark as pending
  lspManagerInstance = createLSPServerManager()
  initializationState = 'pending'
  logForDebugging('[LSP MANAGER] Created manager instance, state=pending')

  // Increment generation to invalidate any pending initializations
// 捕获当前代次进闭包，回调里据此判断「我是不是已经过期了」。
  const currentGeneration = ++initializationGeneration
  logForDebugging(
    `[LSP MANAGER] Starting async initialization (generation ${currentGeneration})`,
  )

  // Start initialization asynchronously without blocking
  // Store the promise so callers can await it via waitForInitialization()
  initializationPromise = lspManagerInstance
    .initialize()
    .then(() => {
      // Only update state if this is still the current initialization
// 代次校验：只有「我还是最新一次初始化」时才写状态，防止过期的异步结果把新状态覆盖掉。
      if (currentGeneration === initializationGeneration) {
        initializationState = 'success'
        logForDebugging('LSP server manager initialized successfully')

        // Register passive notification handlers for diagnostics
        if (lspManagerInstance) {
// 初始化成功后才挂诊断监听——这样每一个 server 的 publishDiagnostics 才会流进 LSPDiagnosticRegistry。
          registerLSPNotificationHandlers(lspManagerInstance)
        }
      }
    })
    .catch((error: unknown) => {
      // Only update state if this is still the current initialization
      if (currentGeneration === initializationGeneration) {
        initializationState = 'failed'
        initializationError = error as Error
        // Clear the instance since it's not usable
// 失败就把实例置空，保证 getLspServerManager() 不会返回一个坏的 manager。
        lspManagerInstance = undefined

        logError(error as Error)
        logForDebugging(
          `Failed to initialize LSP server manager: ${errorMessage(error)}`,
        )
      }
    })
}

/**
 * Force re-initialization of the LSP server manager, even after a prior
 * successful init. Called from refreshActivePlugins() after plugin caches
 * are cleared, so newly-loaded plugin LSP servers are picked up.
 *
 * Fixes https://github.com/anthropics/claude-code/issues/15521:
 * loadAllPlugins() is memoized and can be called very early in startup
 * (via getCommands prefetch in setup.ts) before marketplaces are reconciled,
 * caching an empty plugin list. initializeLspServerManager() then reads that
 * stale memoized result and initializes with 0 servers. Unlike commands/agents/
 * hooks/MCP, LSP was never re-initialized on plugin refresh.
 *
 * Safe to call when no LSP plugins changed: initialize() is just config
 * parsing (servers are lazy-started on first use). Also safe during pending
 * init: the generation counter invalidates the in-flight promise.
 */
// 强制重建（插件刷新后调用）。存在的理由见上方英文注释里的 issue #15521：
// 插件列表被过早 memoize 了（启动时为了预取命令调过一次 loadAllPlugins，那时市场还没同步完），
// 导致 LSP 初始化时读到的是「空插件列表」，一个 server 都没装载。
// 而 commands/agents/hooks/MCP 都有刷新逻辑，唯独 LSP 漏了——本函数就是补上这块。
// 代价可控：initialize() 只是解析配置，server 都是懒启动的，重建不会真的开销很大。
export function reinitializeLspServerManager(): void {
// 从没初始化过就别自作主张启动——比如 headless 子命令压根不需要 LSP。
  if (initializationState === 'not-started') {
    // initializeLspServerManager() was never called (e.g. headless subcommand
    // path). Don't start it now.
    return
  }

  logForDebugging('[LSP MANAGER] reinitializeLspServerManager() called')

  // Best-effort shutdown of any running servers on the old instance so
  // /reload-plugins doesn't leak child processes. Fire-and-forget: the
  // primary use case (issue #15521) has 0 servers so this is usually a no-op.
  if (lspManagerInstance) {
// fire-and-forget：`void` 前缀明确告诉 linter「我故意不等它」。
// 目的只是尽量回收旧实例的子进程，防止 /reload-plugins 泄漏进程；失败也无所谓，只记日志。
    void lspManagerInstance.shutdown().catch(err => {
      logForDebugging(
        `[LSP MANAGER] old instance shutdown during reinit failed: ${errorMessage(err)}`,
      )
    })
  }

  // Force the idempotence check in initializeLspServerManager() to fall
  // through. Generation counter handles invalidating any in-flight init.
// 把状态打回原点，好让 initializeLspServerManager() 里的幂等判断放行；
// generation 计数器则负责让「可能还在飞的旧初始化」失效。
  lspManagerInstance = undefined
  initializationState = 'not-started'
  initializationError = undefined

  initializeLspServerManager()
}

/**
 * Shutdown the LSP server manager and clean up resources.
 *
 * This should be called during Claude Code shutdown. Stops all running LSP servers
 * and clears internal state. Safe to call when not initialized (no-op).
 *
 * NOTE: Errors during shutdown are logged for monitoring but NOT propagated to the caller.
 * State is always cleared even if shutdown fails, to prevent resource accumulation.
 * This is acceptable during application exit when recovery is not possible.
 *
 * @returns Promise that resolves when shutdown completes (errors are swallowed)
 */
// 关停入口（应用退出时调用），幂等且吞异常。
// 为什么吞异常：退出阶段已经没有恢复的可能了，抛出去只会让退出码变难看；
// 但状态必须在 finally 里清干净，否则残留的子进程/连接会阻止进程退出。
export async function shutdownLspServerManager(): Promise<void> {
  if (lspManagerInstance === undefined) {
    return
  }

  try {
    await lspManagerInstance.shutdown()
    logForDebugging('LSP server manager shut down successfully')
  } catch (error: unknown) {
    logError(error as Error)
    logForDebugging(
      `Failed to shutdown LSP server manager: ${errorMessage(error)}`,
    )
// finally：无论 shutdown 成功与否都重置状态，防止重复关停或状态残留。
  } finally {
    // Always clear state even if shutdown failed
    lspManagerInstance = undefined
    initializationState = 'not-started'
    initializationError = undefined
    initializationPromise = undefined
    // Increment generation to invalidate any pending initializations
    initializationGeneration++
  }
}
