/**
 * Prevents macOS from sleeping while Claude is working.
 *
 * Uses the built-in `caffeinate` command to create a power assertion that
 * prevents idle sleep. This keeps the Mac awake during API requests and
 * tool execution so long-running operations don't get interrupted.
 *
 * The caffeinate process is spawned with a timeout and periodically restarted.
 * This provides self-healing behavior: if the Node process is killed with
 * SIGKILL (which doesn't run cleanup handlers), the orphaned caffeinate will
 * automatically exit after the timeout expires.
 *
 * Only runs on macOS - no-op on other platforms.
 */
/**
 * ============================================================================
 *  【文件总览】src/services/preventSleep.ts —— 干活时阻止 macOS 休眠
 * ============================================================================
 *
 *  一句话定位：
 *  Claude Code 跑长任务（调 API、执行工具）期间，阻止 Mac 进入休眠，
 *  免得任务跑到一半机器睡过去、网络断开。只在 macOS 生效，其它平台是空操作。
 *
 *  在架构中的位置：
 *      长任务开始处（如发 API 请求前）
 *        └─> startPreventSleep()                          ← ★ 本文件
 *              ├─> spawnCaffeinate()      启动系统自带的 `caffeinate -i -t 300`
 *              └─> startRestartInterval() 起一个 4 分钟的定时器，到期前重启它
 *      任务结束处
 *        └─> stopPreventSleep()          引用计数减一，归零才真正收工
 *      进程退出时（src/utils/cleanupRegistry.js）
 *        └─> forceStopPreventSleep()     无视引用计数，强制清理
 *
 *  本文件包含什么：
 *   1. startPreventSleep()       申请「别睡」，内部用引用计数
 *   2. stopPreventSleep()        释放一次「别睡」
 *   3. forceStopPreventSleep()   强制停止（退出清理用）
 *   4. startRestartInterval()    周期性重启 caffeinate 的定时器
 *   5. spawnCaffeinate()         真正起子进程
 *   6. killCaffeinate()          杀掉子进程
 *
 * ---------------------------------------------------------------------------
 *  【核心机制 1：引用计数（refCount）——为什么不是布尔开关】
 * ---------------------------------------------------------------------------
 *  同一时刻可能有多个任务在跑（主请求 + 后台压缩 + 子 agent…）。
 *  如果只用布尔量，第一个任务结束就会把「防休眠」关掉，
 *  而第二个任务还在跑——典型的「过早释放」bug。
 *  所以这里用 refCount：start 加一、stop 减一，**只有归零才真正停止**。
 *  ≈ Java 里 AQS/信号量的 acquire/release，或数据库连接池的引用计数。
 *  注意 `if (refCount === 1)` 判断的是「从 0 变成 1」的那一刻才去起进程，
 *  后续再 start 只是加数字，不会重复 spawn。
 *
 * ---------------------------------------------------------------------------
 *  【核心机制 2：为什么 caffeinate 要带超时并周期性重启】
 * ---------------------------------------------------------------------------
 *  caffeinate 起了 `-t 300`（5 分钟自动退出），同时我们又每 4 分钟重启它一次。
 *  这看似多余，实为**自愈设计（self-healing）**，解决的是一个很隐蔽的坑：
 *
 *    如果 Node 进程被 `kill -9`（SIGKILL）干掉，操作系统**不会**执行任何清理钩子，
 *    那么我们 spawn 出来的 caffeinate 子进程就变成孤儿进程，
 *    会永远阻止 Mac 休眠——用户合上盖子以为睡了，其实电池一直在耗。
 *
 *  给 caffeinate 加 5 分钟超时后，即使 Node 被 SIGKILL，
 *  那个孤儿也会在 5 分钟内自己退出，把电脑「还给」用户。
 *  而正常情况下，我们每 4 分钟（留 1 分钟余量）重启一次，保证不会真的断档。
 *
 *  为什么是 4 分钟而不是 4 分 59 秒：留足 buffer，防止定时器被事件循环阻塞而迟到。
 *
 * ---------------------------------------------------------------------------
 *  【核心机制 3：unref() —— 为什么必须调它】
 * ---------------------------------------------------------------------------
 *  `caffeinateProcess.unref()` 和 `restartInterval.unref()` 都在做同一件事：
 *  告诉 Node「这个子进程/定时器**不算**你还活着的理由」。
 *  Node 的事件循环只要还有一个 ref 的句柄在，进程就不会退出；
 *  如果不 unref，即使用户工作做完了，Claude Code 也会因为这两个句柄而永远不退出。
 *  ≈ Java 里把线程设为 daemon（守护线程）：JVM 不会因为它未结束而拒绝退出。
 *
 * ---------------------------------------------------------------------------
 *  【踩过的坑：为什么要 `const thisProc = caffeinateProcess` 存一份快照】
 * ---------------------------------------------------------------------------
 *  在 'exit' / 'error' 回调里判断 `caffeinateProcess === thisProc` 才置 null，
 *  是为了处理**重启竞态**：
 *    old 进程正在退出 → 回调触发 → 此时新的进程可能已经 spawn 好了
 *  如果回调里无条件写 `caffeinateProcess = null`，就会把**新进程**的引用抹掉，
 *  导致后续 killCaffeinate() 找不到进程、再也关不掉防休眠。
 *  存一份快照比对，确保「只清理我自己」，是并发编程里很典型的做法。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `import { type ChildProcess, spawn } from 'child_process'`
 *      `type` 前缀表示**只导入类型**（编译后会被完全擦除，不产生运行时代码）。
 *      ≈ Java 的 import 只用于编译期；这里 TS 用 `type` 关键字显式区分，
 *      好处是打包器能确定它不影响运行时依赖图。
 *
 *  - `let x: ChildProcess | null = null`  联合类型 + 显式初始化。
 *      `| null` 表示可能为 null，编译器会强制你判空后才能用。
 *      ≈ Java 的 `@Nullable ChildProcess x = null`。
 *
 *  - `ReturnType<typeof setInterval>`
 *      条件/工具类型：取出 setInterval 的返回类型。
 *      ≈ Java 里没有直接对应；想象成 `var` 的编译期版本——
 *      「我懒得写这个定时器的具体类型，让编译器从函数签名里推导出来」。
 *      为什么需要：Node 环境里 setInterval 返回 Timeout 对象，浏览器里返回 number，
 *      写 ReturnType 可以两边通用。
 *
 *  - `process.platform !== 'darwin'`  'darwin' 是 Node 对 macOS 的代号。
 *      ≈ Java 的 `System.getProperty("os.name")`，但这是编译期常量式判断。
 *
 *  - `spawn('caffeinate', [...], { stdio: 'ignore' })`
 *      起子进程。stdio: 'ignore' = 丢弃标准输入输出，
 *      免得子进程的输出把 UI 搞乱，也避免管道无人读而写满阻塞。
 *
 *  - `err => {...}`  箭头函数 ≈ Java 的 lambda `err -> {...}`
 *
 *  - `catch { }`  省略异常变量的 catch（详见 internalLogging.ts 说明）
 *
 *  - 模块级的 `let caffeinateProcess` / `let refCount`：
 *      这是**模块单例状态**。TS/JS 的模块在进程内只会被求值一次，
 *      所以这些变量等价于 Java 里 `static` 字段的单例。
 * ============================================================================
 */
import { type ChildProcess, spawn } from 'child_process'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'

// 中文补注：CAFFEINATE_TIMEOUT_SECONDS 是 caffeinate 的**自毁倒计时**（秒）。
// 带上 -t 参数后，进程到期会自己退出。这不是为了省事，而是自愈机制的关键：
// 万一 Node 被 SIGKILL 强杀（不会执行任何清理），孤儿 caffeinate 也会在 5 分钟内
// 自动结束，不会永久霸占着「禁止休眠」。
// Caffeinate timeout in seconds. Process auto-exits after this duration.
// We restart it before expiry to maintain continuous sleep prevention.
const CAFFEINATE_TIMEOUT_SECONDS = 300 // 5 minutes

// 中文补注：重启间隔 4 分钟 < 超时 5 分钟，刻意留 1 分钟余量，
// 防止事件循环繁忙时定时器迟到导致防休眠出现断档。
// Restart interval - restart caffeinate before it expires.
// Use 4 minutes to give plenty of buffer before the 5 minute timeout.
const RESTART_INTERVAL_MS = 4 * 60 * 1000

let caffeinateProcess: ChildProcess | null = null
let restartInterval: ReturnType<typeof setInterval> | null = null
let refCount = 0
let cleanupRegistered = false

/**
 * Increment the reference count and start preventing sleep if needed.
 * Call this when starting work that should keep the Mac awake.
 */
/**
 * 申请「干活期间别让 Mac 睡」。
 *
 * 为什么需要引用计数：可能同时有多个任务在跑，
 * 任何单个任务结束都不该立刻解除防休眠，只有全部结束才行。
 *
 * 关键步骤：
 *   ① refCount++（记录又多了一个需要防休眠的任务）
 *   ② 若这是第一个任务（计数从 0 变 1），才真正 spawn caffeinate
 *   ③ 同时启动周期性重启的定时器
 */
export function startPreventSleep(): void {
  refCount++

  if (refCount === 1) {
    spawnCaffeinate()
    startRestartInterval()
  }
}

/**
 * Decrement the reference count and allow sleep if no more work is pending.
 * Call this when work completes.
 */
/**
 * 释放一次「别让 Mac 睡」的申请。
 *
 * 与 startPreventSleep() 严格配对调用。
 * 计数减到 0 才真正停定时器、杀 caffeinate——在此之前任何释放都不影响防休眠。
 *
 * 注意 `if (refCount > 0)` 的守护：防止调用方多调了一次 stop 导致计数变成负数，
 * 那样之后再 start 就永远到不了 1，防休眠就彻底失效了。
 */
export function stopPreventSleep(): void {
  if (refCount > 0) {
    refCount--
  }

  if (refCount === 0) {
    stopRestartInterval()
    killCaffeinate()
  }
}

/**
 * Force stop preventing sleep, regardless of reference count.
 * Use this for cleanup on exit.
 */
/**
 * 强制停止防休眠（无视引用计数），用于进程退出前的清理。
 *
 * 为什么需要单独一个函数：进程要退出了，此时就算还有任务「挂着」也没意义，
 * 必须无条件把子进程和定时器清干净，否则会留下孤儿进程。
 * 它通过 registerCleanup() 挂到退出钩子上（见 spawnCaffeinate 第 ① 步）。
 */
export function forceStopPreventSleep(): void {
  refCount = 0
  stopRestartInterval()
  killCaffeinate()
}

/**
 * 启动「每 4 分钟重启一次 caffeinate」的定时器。
 *
 * 为什么要重启：caffeinate 带 -t 300 会在 5 分钟后自己退出，
 * 必须在到期前重新拉起，否则防休眠就断了。
 *
 * 为什么定时器里还要再判一次 `refCount > 0`：
 * 定时器的执行时机与 stopPreventSleep() 是异步交错的，
 * 可能出现「刚停掉又立刻被定时器重启」的竞态。
 * 每次触发时重新确认「现在确实还需要防休眠」，是最省心的兜底。
 */
function startRestartInterval(): void {
  // Only run on macOS
  if (process.platform !== 'darwin') {
    return
  }

  // Already running
  if (restartInterval !== null) {
    return
  }

  restartInterval = setInterval(() => {
    // Only restart if we still need sleep prevention
    if (refCount > 0) {
      logForDebugging('Restarting caffeinate to maintain sleep prevention')
      killCaffeinate()
      spawnCaffeinate()
    }
  }, RESTART_INTERVAL_MS)

  // Don't let the interval keep the Node process alive
  restartInterval.unref()
}

function stopRestartInterval(): void {
  if (restartInterval !== null) {
    clearInterval(restartInterval)
    restartInterval = null
  }
}

/**
 * 真正启动 `caffeinate` 子进程。
 *
 * 参数含义（见下方原英文注释）：
 *   `-i`  只阻止「空闲休眠」，是**最温和**的一档——屏幕照常可以熄灭，
 *         不会强行点亮显示器打扰用户（相比 -d 阻止显示器休眠要克制得多）
 *   `-t`  超时秒数，到点自动退出，是自愈机制的基础
 *
 * 关键步骤：
 *   ① 首次调用时注册退出清理钩子，保证进程正常退出时会 forceStop
 *   ② spawn 子进程，并立刻 unref()（不让它拖住 Node 不退出）
 *   ③ 监听 error / exit，用进程快照比对来安全地把引用置空
 */
function spawnCaffeinate(): void {
  // Only run on macOS
  if (process.platform !== 'darwin') {
    return
  }

  // Already running
  if (caffeinateProcess !== null) {
    return
  }

  // Register cleanup on first use to ensure caffeinate is killed on exit
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      forceStopPreventSleep()
    })
  }

  try {
    // -i: Create an assertion to prevent idle sleep
    //     This is the least aggressive option - display can still sleep
    // -t: Timeout in seconds - caffeinate exits automatically after this
    //     This provides self-healing if Node is killed with SIGKILL
    caffeinateProcess = spawn(
      'caffeinate',
      ['-i', '-t', String(CAFFEINATE_TIMEOUT_SECONDS)],
      {
        stdio: 'ignore',
      },
    )

    // Don't let caffeinate keep the Node process alive
    caffeinateProcess.unref()

    // 存一份「本进程」的快照：回调触发时，全局变量可能已经指向新 spawn 的进程了。
    // 比对身份后再置 null，避免把新进程的引用误抹掉（重启竞态的经典防护）。
    const thisProc = caffeinateProcess
    caffeinateProcess.on('error', err => {
      logForDebugging(`caffeinate spawn error: ${err.message}`)
      if (caffeinateProcess === thisProc) caffeinateProcess = null
    })

    caffeinateProcess.on('exit', () => {
      if (caffeinateProcess === thisProc) caffeinateProcess = null
    })

    logForDebugging('Started caffeinate to prevent sleep')
  } catch {
    // Silently fail - caffeinate not available or spawn failed
    caffeinateProcess = null
  }
}

/**
 * 杀掉 caffeinate 子进程，把「允许休眠」还给系统。
 *
 * 为什么用 SIGKILL 而不是 SIGTERM（见原英文注释）：
 * SIGTERM 是「礼貌请求退出」，进程可以捕获它并拖延/忽略；
 * SIGKILL 由操作系统直接终结进程，立即生效。
 * 这里我们要的是「马上别再阻止休眠」，所以选最干脆的方式。
 */
function killCaffeinate(): void {
  if (caffeinateProcess !== null) {
    // 先取出局部引用再置空：即便下面 kill 抛异常，全局状态也已经清干净了，
    // 不会留下一个「关不掉」的僵尸引用。
    const proc = caffeinateProcess
    caffeinateProcess = null
    try {
      // SIGKILL for immediate termination - SIGTERM could be delayed
      proc.kill('SIGKILL')
      logForDebugging('Stopped caffeinate, allowing sleep')
    } catch {
      // Process may have already exited
    }
  }
}
