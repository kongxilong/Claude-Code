/**
 * 【一句话定位】
 * 一方（1P）事件日志的「最后一公里」：OpenTelemetry 的 LogRecordExporter 实现，负责把攒好的一批
 * 事件真正 POST 到 /api/event_logging/batch，并处理失败落盘、退避重试、鉴权降级、分块发送。
 *
 * 【在架构中的位置】
 * 调用链：
 *   firstPartyEventLogger.ts 的 initialize1PEventLogging()
 *     → new 本文件 FirstPartyEventLoggingExporter(options)
 *       → 交给 OpenTelemetry 的 BatchLogRecordProcessor（攒批）
 *         → 攒够了就调本文件 export() → doExport() → sendEventsInBatches() → sendBatchWithRetry()
 *           → axios POST https://api.anthropic.com/api/event_logging/batch
 * 失败路径：queueFailedEvents（落盘 ~/.claude/telemetry/）→ scheduleBackoffRetry（退避重试）。
 *
 * 【它在 OTel 里的角色（Java 工程师对照）】
 * 这就是 OTel SDK 里的 SpanExporter / LogRecordExporter 接口实现。Java 版对应：
 *   `class MyExporter implements LogRecordExporter { export(...); shutdown(); forceFlush(); }`
 * 三个方法语义完全一致：export 由批处理器调用、shutdown 退出时调用、forceFlush 立刻排空。
 *
 * 【本文件最值得学的：失败重试点设计】
 * CLI 的网络环境不可靠（断网、代理、公司防火墙），所以这里做了四层韧性：
 * ① 失败事件【追加写】到本地 JSONL 文件（append 在多数文件系统上是原子的，多进程安全）
 * ② 二次退避重试：延迟 = base * attempts²（0.5s → 2s → 4.5s → 8s … 上限 30s）
 * ③ 任一批次成功 ⇒ 立刻重试积压队列（说明端点恢复了，不用等退避）
 * ④ 重试次数超上限 ⇒ 丢弃（不能无限囤积占用磁盘）
 * 另外启动时还会扫一遍上次运行遗留的失败文件，在后台补发。
 *
 * 【本文件包含什么】
 * - BATCH_UUID / FILE_PREFIX / getStorageDir()：落盘文件的命名与目录。
 * - type FirstPartyEventLoggingEvent / FirstPartyEventLoggingPayload：上报信封结构。
 * - class FirstPartyEventLoggingExporter：OTel Exporter 实现（本文件主体）。
 * - getAxiosErrorContext()：把 axios 错误整理成可读的排查信息。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `export class X implements LogRecordExporter`：
 *   `implements` ≈ Java 的 implements，编译期检查必须实现接口的所有方法。
 * - `private readonly endpoint: string`：
 *   `readonly` ≈ Java 的 final（必须在构造函数里赋值，之后不能改）。
 * - `private readonly isKilled: () => boolean`：字段类型是「无参返回布尔的函数」。
 *   ≈ Java 的 `private final BooleanSupplier isKilled;`。
 * - `constructor(options: {...} = {})`：参数带默认值 = 空对象，
 *   于是 `new FirstPartyEventLoggingExporter()` 不传参也合法。
 *   ≈ Java 要写两个构造函数（或 Builder）才能做到。
 * - `options.isKilled ?? (() => false)`：`??` 提供默认的「永远不熔断」函数。
 *   注意必须是 `??` 不是 `||`：函数对象永远是真值，两者行为一样，但语义上 ?? 更准确。
 * - `options.skipAuth ?? false`：这里必须用 `??`——如果写成 `||`，
 *   显式传进来的 false 会被替换掉（虽然结果碰巧一样，但这是坏习惯）。
 * - `readonly schedule: (fn: () => Promise<void>, delayMs: number) => () => void`：
 *   类型是一个「返回函数的函数」。≈ Java 的 `Function<Runnable, Cancellable>`，
 *   这里返回的是「取消函数」（用来取消定时器）。这是可测试性的关键：
 *   测试时注入假的 schedule 就能控制时间，不用真的等 30 秒。
 * - `void this.retryPreviousBatches()`：构造函数里 fire-and-forget 启动后台补发。
 * - `async export(logs, resultCallback)`：OTel 接口要求「通过回调返回结果」，
 *   所以这里不能只 return，必须调 resultCallback({ code: ExportResultCode.SUCCESS / FAILED })。
 *   Java 版 OTel 也是同样的回调风格。
 * - `this.pendingExports.push(promise)` + `.finally(() => splice(...))`：
 *   手工维护「进行中的导出」列表，forceFlush 时 `Promise.all` 等它们全部结束。
 *   splice(index, 1) ≈ Java 的 list.remove(index)。
 * - `logs.filter(log => log.instrumentationScope?.name === '...')`：
 *   按「埋点作用域名」过滤，确保只处理我们自己的事件（不用客户遥测的日志）。
 *   `?.` 可选链在这里防 instrumentationScope 缺失。
 * - `for (let i = 0; i < events.length; i += this.maxBatchSize) { batches.push(events.slice(i, i + n)) }`：
 *   经典的手工分块（chunking）。≈ Java 用 Guava 的 Lists.partition。
 * - `batches[i]!`：非空断言。TS 默认认为下标访问可能越界（返回 T | undefined），
 *   这里我们确定 i 在范围内，用 `!` 关掉检查。
 * - `const [seconds, nanoseconds] = hrTime`：数组解构，把 [秒, 纳秒] 拆成两个变量。
 * - rest 解构剔除字段：`const { _PROTO_skill_name, ...rest } = formatted.additional`：
 *   把三个 PII 字段单独取出（后面 hoist 到 proto 顶层字段），其余全部进 rest。
 *   ≈ Java 要手写 remove + 逐个 get。
 * - `Buffer.from(jsonStringify(x)).toString('base64')`：
 *   JSON 转 Base64（后端要求 additional_metadata 是 base64 编码的 JSON 字符串）。
 *   ≈ Java 的 `Base64.getEncoder().encodeToString(json.getBytes(UTF_8))`。
 * - `try { ... } catch { await unlink(filePath) } catch { ... }`：嵌套 catch，
 *   内层吞掉「文件不存在」的错误——删一个本来就不存在的文件不算错误。
 * - `while (!this.isShutdown) { ... }`：重试循环，退出条件写在 while 里。
 * - `axios.isAxiosError(error) && error.response?.status === 401`：
 *   isAxiosError 是类型守卫（type guard），判断后 TS 才允许访问 .response。
 *   ≈ Java 的 `e instanceof AxiosError ax && ax.getResponse().getStatus() == 401`。
 * - `parts.join(', ')`：数组拼字符串 ≈ String.join。
 */
import type { HrTime } from '@opentelemetry/api'
import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { appendFile, mkdir, readdir, unlink, writeFile } from 'fs/promises'
import * as path from 'path'
import type { CoreUserData } from 'src/utils/user.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { ClaudeCodeInternalEvent } from '../../types/generated/events_mono/claude_code/v1/claude_code_internal_event.js'
import { GrowthbookExperimentEvent } from '../../types/generated/events_mono/growthbook/v1/growthbook_experiment_event.js'
import {
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { errorMessage, isFsInaccessible, toError } from '../../utils/errors.js'
import { getAuthHeaders } from '../../utils/http.js'
import { readJSONLFile } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'
import { stripProtoFields } from './index.js'
import { type EventMetadata, to1PEventFormat } from './metadata.js'

// Unique ID for this process run - used to isolate failed event files between runs
// 每次进程启动生成一个 UUID，用于隔离「本次运行」和「历史遗留」的失败文件——
// 否则启动时的补发逻辑会把自己正在写的文件也当成遗留文件读进来。
const BATCH_UUID = randomUUID()

// File prefix for failed event storage
// 失败事件落盘的文件名前缀。
const FILE_PREFIX = '1p_failed_events.'

// Storage directory for failed events - evaluated at runtime to respect CLAUDE_CONFIG_DIR in tests
// 目录在【运行时】才计算（而不是模块加载时），这样测试里改 CLAUDE_CONFIG_DIR 才能生效。
function getStorageDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'telemetry')
}

// API envelope - event_data is the JSON output from proto toJSON()
// 上报信封：一个事件类型标签 + 实际数据（数据部分是 proto 的 toJSON() 输出）。
type FirstPartyEventLoggingEvent = {
  event_type: 'ClaudeCodeInternalEvent' | 'GrowthbookExperimentEvent'
  event_data: unknown
}

type FirstPartyEventLoggingPayload = {
  events: FirstPartyEventLoggingEvent[]
}

// 中文补充（本类的整体设计）：
// export() 的触发时机由 OTel 的 BatchLogRecordProcessor 决定（每隔 N 毫秒，或攒够 N 条）。
// 本类在这个基础上额外加了韧性：失败落盘、二次退避重试、成功即补发积压、分块、鉴权降级。
// 换句话说：OTel 只管「什么时候调我」，「发失败了怎么办」全由本类负责。
/**
 * Exporter for 1st-party event logging to /api/event_logging/batch.
 *
 * Export cycles are controlled by OpenTelemetry's BatchLogRecordProcessor, which
 * triggers export() when either:
 * - Time interval elapses (default: 5 seconds via scheduledDelayMillis)
 * - Batch size is reached (default: 200 events via maxExportBatchSize)
 *
 * This exporter adds resilience on top:
 * - Append-only log for failed events (concurrency-safe)
 * - Quadratic backoff retry for failed events, dropped after maxAttempts
 * - Immediate retry of queued events when any export succeeds (endpoint is healthy)
 * - Chunking large event sets into smaller batches
 * - Auth fallback: retries without auth on 401 errors
 */
// implements LogRecordExporter：实现 OTel 的导出器接口，必须实现 export/shutdown/forceFlush。
export class FirstPartyEventLoggingExporter implements LogRecordExporter {
  private readonly endpoint: string
  private readonly timeout: number
  private readonly maxBatchSize: number
  private readonly skipAuth: boolean
  private readonly batchDelayMs: number
  private readonly baseBackoffDelayMs: number
  private readonly maxBackoffDelayMs: number
  private readonly maxAttempts: number
// isKilled 是一个【注入进来的函数】，每次发 POST 前都调一次。
// 为什么注入而不是直接 import：会与 firstPartyEventLogger.ts 形成循环依赖（英文注释说明了）。
// 而且每次查一次能保证「熔断开关一清，重试也立刻停」。
  private readonly isKilled: () => boolean
  private pendingExports: Promise<void>[] = []
  private isShutdown = false
// schedule 也是注入的（默认用 setTimeout）。目的：让测试能替换成「手动触发」，不必真等 30 秒。
  private readonly schedule: (
    fn: () => Promise<void>,
    delayMs: number,
  ) => () => void
  private cancelBackoff: (() => void) | null = null
  private attempts = 0
  private isRetrying = false
  private lastExportErrorContext: string | undefined

// 所有配置项都有默认值，所以 `new FirstPartyEventLoggingExporter()` 什么都不传也能工作。
// Java 里要写多个构造函数或 Builder 才能做到同样效果。
  constructor(
    options: {
      timeout?: number
      maxBatchSize?: number
      skipAuth?: boolean
      batchDelayMs?: number
      baseBackoffDelayMs?: number
      maxBackoffDelayMs?: number
      maxAttempts?: number
      path?: string
      baseUrl?: string
      // Injected killswitch probe. Checked per-POST so that disabling the
      // firstParty sink also stops backoff retries (not just new emits).
      // Passed in rather than imported to avoid a cycle with firstPartyEventLogger.ts.
      isKilled?: () => boolean
      schedule?: (fn: () => Promise<void>, delayMs: number) => () => void
    } = {},
  ) {
    // Default: prod, except when ANTHROPIC_BASE_URL is explicitly staging.
    // Overridable via tengu_1p_event_batch_config.baseUrl.
// 端点选择：默认生产环境；只有显式把 ANTHROPIC_BASE_URL 设成 staging 才走 staging；
// 远程配置 baseUrl 优先级最高（出事时可以远程把流量切走）。
    const baseUrl =
      options.baseUrl ||
      (process.env.ANTHROPIC_BASE_URL === 'https://api-staging.anthropic.com'
        ? 'https://api-staging.anthropic.com'
        : 'https://api.anthropic.com')

    this.endpoint = `${baseUrl}${options.path || '/api/event_logging/batch'}`

    this.timeout = options.timeout || 10000
    this.maxBatchSize = options.maxBatchSize || 200
// `?? false` 而不是 `|| false`：显式传 false 时应当被尊重（虽然这里结果一样，但习惯要好）。
    this.skipAuth = options.skipAuth ?? false
    this.batchDelayMs = options.batchDelayMs || 100
    this.baseBackoffDelayMs = options.baseBackoffDelayMs || 500
    this.maxBackoffDelayMs = options.maxBackoffDelayMs || 30000
    this.maxAttempts = options.maxAttempts ?? 8
// 没注入就用「永远返回 false」的默认实现（即永不熔断）。
    this.isKilled = options.isKilled ?? (() => false)
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })

// 构造时顺便在后台补发【上次运行】遗留的失败事件（网络恢复后数据不至于永久丢失）。
    // Retry any failed events from previous runs of this session (in background)
    void this.retryPreviousBatches()
  }

  // Expose for testing
// 仅供测试：读回当前批次文件里积压了多少条事件。
  async getQueuedEventCount(): Promise<number> {
    return (await this.loadEventsFromCurrentBatch()).length
  }

  // --- Storage helpers ---

// 落盘文件名 = 前缀 + 会话ID + 本进程UUID。
// 带会话 ID：不同会话的失败事件互不干扰；带进程 UUID：区分「本次」和「历史」。
  private getCurrentBatchFilePath(): string {
    return path.join(
      getStorageDir(),
      `${FILE_PREFIX}${getSessionId()}.${BATCH_UUID}.json`,
    )
  }

// 读失败（文件不存在/损坏）一律当空数组——不能因为一个坏文件就让上报彻底停摆。
  private async loadEventsFromFile(
    filePath: string,
  ): Promise<FirstPartyEventLoggingEvent[]> {
    try {
      return await readJSONLFile<FirstPartyEventLoggingEvent>(filePath)
    } catch {
      return []
    }
  }

  private async loadEventsFromCurrentBatch(): Promise<
    FirstPartyEventLoggingEvent[]
  > {
    return this.loadEventsFromFile(this.getCurrentBatchFilePath())
  }

// 全量覆盖写。events 为空则删文件（保持磁盘干净）。
  private async saveEventsToFile(
    filePath: string,
    events: FirstPartyEventLoggingEvent[],
  ): Promise<void> {
    try {
      if (events.length === 0) {
        try {
          await unlink(filePath)
        } catch {
          // File doesn't exist, nothing to delete
        }
      } else {
        // Ensure storage directory exists
        await mkdir(getStorageDir(), { recursive: true })
        // Write as JSON lines (one event per line)
// JSONL 格式（一行一个 JSON）：和 JSON 数组比，最大好处是【追加】时不用读整个文件再重写，
// 在多数文件系统上单次 append 是原子操作，多进程并发写也安全。
        const content = events.map(e => jsonStringify(e)).join('\n') + '\n'
        await writeFile(filePath, content, 'utf8')
      }
    } catch (error) {
      logError(error)
    }
  }

// 追加写（queueFailedEvents 用这个）。同理：原子追加、并发安全、不覆盖已有内容。
  private async appendEventsToFile(
    filePath: string,
    events: FirstPartyEventLoggingEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    try {
      // Ensure storage directory exists
      await mkdir(getStorageDir(), { recursive: true })
      // Append as JSON lines (one event per line) - atomic on most filesystems
      const content = events.map(e => jsonStringify(e)).join('\n') + '\n'
      await appendFile(filePath, content, 'utf8')
    } catch (error) {
      logError(error)
    }
  }

  private async deleteFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath)
    } catch {
      // File doesn't exist or can't be deleted, ignore
    }
  }

  // --- Previous batch retry (startup) ---

// 启动补发：扫描 storage 目录里「同会话、但属于别的进程」的失败文件，逐个后台重试。
  private async retryPreviousBatches(): Promise<void> {
    try {
      const prefix = `${FILE_PREFIX}${getSessionId()}.`
      let files: string[]
      try {
        files = (await readdir(getStorageDir()))
          .filter((f: string) => f.startsWith(prefix) && f.endsWith('.json'))
// 排除本次进程的 UUID——那个文件是当前正在写的，不能当成遗留文件处理。
          .filter((f: string) => !f.includes(BATCH_UUID)) // Exclude current batch
      } catch (e) {
// 目录不可访问（权限问题、沙箱）就安静退出，不算错误。
        if (isFsInaccessible(e)) return
        throw e
      }

      for (const file of files) {
        const filePath = path.join(getStorageDir(), file)
        void this.retryFileInBackground(filePath)
      }
    } catch (error) {
      logError(error)
    }
  }

// 补发单个遗留文件：
// ① 重试次数已超上限 → 直接删（不能无限囤积）
// ② 读到空 → 删
// ③ 发送；全成功 → 删文件；部分失败 → 只把【失败的】写回去（不重复保留成功的）
  private async retryFileInBackground(filePath: string): Promise<void> {
    if (this.attempts >= this.maxAttempts) {
      await this.deleteFile(filePath)
      return
    }

    const events = await this.loadEventsFromFile(filePath)
    if (events.length === 0) {
      await this.deleteFile(filePath)
      return
    }

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: retrying ${events.length} events from previous batch`,
      )
    }

    const failedEvents = await this.sendEventsInBatches(events)
    if (failedEvents.length === 0) {
      await this.deleteFile(filePath)
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging('1P event logging: previous batch retry succeeded')
      }
    } else {
      // Save only the failed events back (not all original events)
      await this.saveEventsToFile(filePath, failedEvents)
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          `1P event logging: previous batch retry failed, ${failedEvents.length} events remain`,
        )
      }
    }
  }

// OTel 接口要求的导出方法。注意：结果要通过【回调】返回，不能只 return。
// 这里先做 shutdown 检查，然后把真正的导出（doExport）塞进 pendingExports 以便 forceFlush 等待。
  async export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    if (this.isShutdown) {
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          '1P event logging export failed: Exporter has been shutdown',
        )
      }
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Exporter has been shutdown'),
      })
      return
    }

// 把 Promise 记下来：forceFlush() 时 Promise.all 等它们全部完成，保证退出前数据都发出去。
    const exportPromise = this.doExport(logs, resultCallback)
    this.pendingExports.push(exportPromise)

    // Clean up completed exports
// 完成后从列表里移除，避免数组无限增长（长时间运行的进程会导出很多次）。
    void exportPromise.finally(() => {
      const index = this.pendingExports.indexOf(exportPromise)
      if (index > -1) {
        void this.pendingExports.splice(index, 1)
      }
    })
  }

// 真正的导出逻辑。步骤：
// ① 按作用域名过滤，只留我们自己的事件日志
// ② 转成上报信封格式
// ③ 重试次数超限 → 报 FAILED 并丢弃
// ④ 分块发送；有失败 → 落盘 + 安排退避重试 + 报 FAILED
// ⑤ 全成功 → 重置退避 + 立刻补发积压队列 + 报 SUCCESS
  private async doExport(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    try {
      // Filter for event logs only (by scope name)
// 按 instrumentationScope 名过滤：确保只导出 Claude Code 自己的事件，
// 不会误把客户的 OTLP 日志一起发到 Anthropic（数据隔离要求）。
      const eventLogs = logs.filter(
        log =>
          log.instrumentationScope?.name === 'com.anthropic.claude_code.events',
      )

      if (eventLogs.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      // Transform new logs (failed events are retried independently via backoff)
      const events = this.transformLogsToEvents(eventLogs).events

      if (events.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      if (this.attempts >= this.maxAttempts) {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error(
            `Dropped ${events.length} events: max attempts (${this.maxAttempts}) reached`,
          ),
        })
        return
      }

      // Send events
// 分块发送，返回「发送失败的事件」（成功的不返回）。
      const failedEvents = await this.sendEventsInBatches(events)
// 无论成功失败都递增 attempts：连续成功会被 resetBackoff 清零，所以不会影响正常使用。
      this.attempts++

// 有失败：落盘 + 安排退避重试。上报给 OTel 的结果也标 FAILED（批处理器据此决定是否再调）。
      if (failedEvents.length > 0) {
        await this.queueFailedEvents(failedEvents)
        this.scheduleBackoffRetry()
        const context = this.lastExportErrorContext
          ? ` (${this.lastExportErrorContext})`
          : ''
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error(
            `Failed to export ${failedEvents.length} events${context}`,
          ),
        })
        return
      }

// 成功即「探活成功」：说明端点恢复，立刻把积压的补发出去，不必干等退避定时器。
      // Success - reset backoff and immediately retry any queued events
      this.resetBackoff()
      if ((await this.getQueuedEventCount()) > 0 && !this.isRetrying) {
        void this.retryFailedEvents()
      }
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          `1P event logging export failed: ${errorMessage(error)}`,
        )
      }
      logError(error)
      resultCallback({
        code: ExportResultCode.FAILED,
        error: toError(error),
      })
    }
  }

// 分块发送。关键设计：一旦某批失败就【短路】——
// 把失败的这批和后面所有没发的批一起入队，不再继续 POST。
// 理由：一个批失败几乎必然意味着端点挂了，继续发只是浪费时间和加重对方负担；
// 等退避重试时用「一批」去探活即可。
  private async sendEventsInBatches(
    events: FirstPartyEventLoggingEvent[],
  ): Promise<FirstPartyEventLoggingEvent[]> {
    // Chunk events into batches
    const batches: FirstPartyEventLoggingEvent[][] = []
// 手工分块：每 maxBatchSize 条切一块。
    for (let i = 0; i < events.length; i += this.maxBatchSize) {
      batches.push(events.slice(i, i + this.maxBatchSize))
    }

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: exporting ${events.length} events in ${batches.length} batch(es)`,
      )
    }

    // Send each batch with delay between them. On first failure, assume the
    // endpoint is down and short-circuit: queue the failed batch plus all
    // remaining unsent batches without POSTing them. The backoff retry will
    // probe again with a single batch next tick.
    const failedBatchEvents: FirstPartyEventLoggingEvent[] = []
    let lastErrorContext: string | undefined
    for (let i = 0; i < batches.length; i++) {
// `batches[i]!` 非空断言：i 在循环范围内，一定存在；TS 默认认为下标可能越界。
      const batch = batches[i]!
      try {
        await this.sendBatchWithRetry({ events: batch })
      } catch (error) {
        lastErrorContext = getAxiosErrorContext(error)
// 短路：把从第 i 批到末尾的所有事件都收进失败列表。
        for (let j = i; j < batches.length; j++) {
          failedBatchEvents.push(...batches[j]!)
        }
        if (process.env.USER_TYPE === 'ant') {
          const skipped = batches.length - 1 - i
          logForDebugging(
            `1P event logging: batch ${i + 1}/${batches.length} failed (${lastErrorContext}); short-circuiting ${skipped} remaining batch(es)`,
          )
        }
        break
      }

// 批间隔 100ms：避免瞬间打出十几个并发 POST（对服务端和自己都不友好）。
      if (i < batches.length - 1 && this.batchDelayMs > 0) {
        await sleep(this.batchDelayMs)
      }
    }

    if (failedBatchEvents.length > 0 && lastErrorContext) {
      this.lastExportErrorContext = lastErrorContext
    }

    return failedBatchEvents
  }

// 失败落盘（追加模式，并发安全）。
  private async queueFailedEvents(
    events: FirstPartyEventLoggingEvent[],
  ): Promise<void> {
    const filePath = this.getCurrentBatchFilePath()

    // Append-only: just add new events to file (atomic on most filesystems)
    await this.appendEventsToFile(filePath, events)

    const context = this.lastExportErrorContext
      ? ` (${this.lastExportErrorContext})`
      : ''
    const message = `1P event logging: ${events.length} events failed to export${context}`
    logError(new Error(message))
  }

// 安排退避重试。三个前置条件：没安排过、没在重试中、没 shutdown——避免重复排队。
  private scheduleBackoffRetry(): void {
    // Don't schedule if already retrying or shutdown
    if (this.cancelBackoff || this.isRetrying || this.isShutdown) {
      return
    }

// 二次退避（quadratic backoff）：延迟 = base × attempts²，上限 30 秒。
// 实际序列：0.5s → 2s → 4.5s → 8s → 12.5s → 18s → 24.5s → 30s（封顶）。
// 和 Statsig SDK 的策略保持一致（英文注释提到）。
    // Quadratic backoff (matching Statsig SDK): base * attempts²
    const delay = Math.min(
      this.baseBackoffDelayMs * this.attempts * this.attempts,
      this.maxBackoffDelayMs,
    )

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: scheduling backoff retry in ${delay}ms (attempt ${this.attempts})`,
      )
    }

// schedule 返回的是「取消函数」，存起来以便成功时立刻取消掉待触发的重试。
    this.cancelBackoff = this.schedule(async () => {
      this.cancelBackoff = null
      await this.retryFailedEvents()
    }, delay)
  }

// 退避重试主循环：只要还有积压事件且没 shutdown 就一直发。
// 先把文件删掉（事件已读到内存）：这样重试期间新失败的事件可以干净地重新写入，不会重复。
  private async retryFailedEvents(): Promise<void> {
    const filePath = this.getCurrentBatchFilePath()

    // Keep retrying while there are events and endpoint is healthy
    while (!this.isShutdown) {
      const events = await this.loadEventsFromFile(filePath)
      if (events.length === 0) break

// 超过最大重试次数：删文件、重置退避、放弃。
// 为什么必须放弃：网络彻底不通的机器上，失败事件会无限堆积吃满磁盘。
      if (this.attempts >= this.maxAttempts) {
        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            `1P event logging: max attempts (${this.maxAttempts}) reached, dropping ${events.length} events`,
          )
        }
        await this.deleteFile(filePath)
        this.resetBackoff()
        return
      }

      this.isRetrying = true

// 先删文件再发：发送期间若又失败，会把失败的部分重新写回（不丢也不重）。
      // Clear file before retry (we have events in memory now)
      await this.deleteFile(filePath)

      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          `1P event logging: retrying ${events.length} failed events (attempt ${this.attempts + 1})`,
        )
      }

      const failedEvents = await this.sendEventsInBatches(events)
      this.attempts++

      this.isRetrying = false

      if (failedEvents.length > 0) {
        // Write failures back to disk
        await this.saveEventsToFile(filePath, failedEvents)
        this.scheduleBackoffRetry()
        return // Failed - wait for backoff
      }

// 发送成功 → 重置退避，然后继续 while 循环，把重试期间新积压的事件一并排空。
      // Success - reset backoff and continue loop to drain any newly queued events
      this.resetBackoff()
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging('1P event logging: backoff retry succeeded')
      }
    }
  }

// 重置：次数归零 + 取消待触发的定时器（既然已经成功了就不需要它了）。
  private resetBackoff(): void {
    this.attempts = 0
    if (this.cancelBackoff) {
      this.cancelBackoff()
      this.cancelBackoff = null
    }
  }

// 发一批 POST，带「鉴权降级」逻辑。步骤：
// ① 熔断检查（熔断中直接抛，触发短路和落盘，不发任何网络请求）
// ② 判断是否该带鉴权头（未建立信任 / token 过期 / 无 profile 权限 → 不带）
// ③ 带鉴权发；若返回 401 → 去掉鉴权头重试一次
// ④ 仍然失败 → 抛给上层（由 sendEventsInBatches 短路处理）
  private async sendBatchWithRetry(
    payload: FirstPartyEventLoggingPayload,
  ): Promise<void> {
// 熔断激活时【抛异常】而不是静默返回：让上层走「短路 + 落盘」路径，
// 保证熔断期间零网络流量，同时数据不丢（恢复后能补发）。
    if (this.isKilled()) {
      // Throw so the caller short-circuits remaining batches and queues
      // everything to disk. Zero network traffic while killed; the backoff
      // timer keeps ticking and will resume POSTs as soon as the GrowthBook
      // cache picks up the cleared flag.
      throw new Error('firstParty sink killswitch active')
    }

    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getClaudeCodeUserAgent(),
      'x-service-name': 'claude-code',
    }

    // Skip auth if trust hasn't been established yet
    // This prevents executing apiKeyHelper commands before the trust dialog
    // Non-interactive sessions implicitly have workspace trust
// 信任对话框还没接受就不带鉴权：因为取凭证可能要执行用户配置的 apiKeyHelper 命令，
// 在未信任的工作区里执行外部命令是安全问题。非交互会话默认视为已信任。
    const hasTrust =
      checkHasTrustDialogAccepted() || getIsNonInteractiveSession()
    if (process.env.USER_TYPE === 'ant' && !hasTrust) {
      logForDebugging('1P event logging: Trust not accepted')
    }

    // Skip auth when the OAuth token is expired or lacks user:profile
    // scope (service key sessions). Falls through to unauthenticated send.
// OAuth token 已过期或没有 user:profile 权限（服务密钥会话）也跳过鉴权：
// 与其发一个必然 401 的请求，不如直接匿名发（后端对匿名事件也有处理路径）。
    let shouldSkipAuth = this.skipAuth || !hasTrust
    if (!shouldSkipAuth && isClaudeAISubscriber()) {
      const tokens = getClaudeAIOAuthTokens()
      if (!hasProfileScope()) {
        shouldSkipAuth = true
      } else if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
        shouldSkipAuth = true
        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            '1P event logging: OAuth token expired, skipping auth to avoid 401',
          )
        }
      }
    }

    // Try with auth headers first (unless trust not established or token is known to be expired)
// 返回 `{ headers, error }` 这种「结果对象」而不是抛异常，让调用方能优雅处理「没有凭证」。
    const authResult = shouldSkipAuth
      ? { headers: {}, error: 'trust not established or Oauth token expired' }
      : getAuthHeaders()
    const useAuth = !authResult.error

    if (!useAuth && process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: auth not available, sending without auth`,
      )
    }

    const headers = useAuth
      ? { ...baseHeaders, ...authResult.headers }
      : baseHeaders

    try {
      const response = await axios.post(this.endpoint, payload, {
        timeout: this.timeout,
        headers,
      })
      this.logSuccess(payload.events.length, useAuth, response.data)
      return
    } catch (error) {
// 401 处理：可能是凭证失效或被吊销，去掉鉴权头再试一次（匿名上报仍有价值）。
// 只重试一次，还失败就抛出——避免无限重试。
      // Handle 401 by retrying without auth
      if (
        useAuth &&
        axios.isAxiosError(error) &&
        error.response?.status === 401
      ) {
        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            '1P event logging: 401 auth error, retrying without auth',
          )
        }
        const response = await axios.post(this.endpoint, payload, {
          timeout: this.timeout,
          headers: baseHeaders,
        })
        this.logSuccess(payload.events.length, false, response.data)
        return
      }

      throw error
    }
  }

  private logSuccess(
    eventCount: number,
    withAuth: boolean,
    responseData: unknown,
  ): void {
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: ${eventCount} events exported successfully${withAuth ? ' (with auth)' : ' (without auth)'}`,
      )
      logForDebugging(`API Response: ${jsonStringify(responseData, null, 2)}`)
    }
  }

// OTel 的时间是 [秒, 纳秒] 元组，转成 JS 的 Date（毫秒精度）。
  private hrTimeToDate(hrTime: HrTime): Date {
    const [seconds, nanoseconds] = hrTime
    return new Date(seconds * 1000 + nanoseconds / 1000000)
  }

// 把 OTel 日志记录转成后端要求的信封格式。
// 两类事件：GrowthbookExperimentEvent（A/B 实验分组）和 ClaudeCodeInternalEvent（普通埋点）。
  private transformLogsToEvents(
    logs: ReadableLogRecord[],
  ): FirstPartyEventLoggingPayload {
    const events: FirstPartyEventLoggingEvent[] = []

    for (const log of logs) {
      const attributes = log.attributes || {}

      // Check if this is a GrowthBook experiment event
// 实验事件走单独的 proto 结构（字段固定，后端专门用来做实验分析）。
      if (attributes.event_type === 'GrowthbookExperimentEvent') {
        const timestamp = this.hrTimeToDate(log.hrTime)
        const account_uuid = attributes.account_uuid as string | undefined
        const organization_uuid = attributes.organization_uuid as
          | string
          | undefined
        events.push({
          event_type: 'GrowthbookExperimentEvent',
          event_data: GrowthbookExperimentEvent.toJSON({
            event_id: attributes.event_id as string,
            timestamp,
            experiment_id: attributes.experiment_id as string,
            variation_id: attributes.variation_id as number,
            environment: attributes.environment as string,
            user_attributes: attributes.user_attributes as string,
            experiment_metadata: attributes.experiment_metadata as string,
            device_id: attributes.device_id as string,
            session_id: attributes.session_id as string,
            auth:
              account_uuid || organization_uuid
                ? { account_uuid, organization_uuid }
                : undefined,
          }),
        })
        continue
      }

      // Extract event name
// 事件名兜底链：属性里的 event_name → 日志 body → 'unknown'。
      const eventName =
        (attributes.event_name as string) || (log.body as string) || 'unknown'

      // Extract metadata objects directly (no JSON parsing needed)
      const coreMetadata = attributes.core_metadata as EventMetadata | undefined
      const userMetadata = attributes.user_metadata as CoreUserData
      const eventMetadata = (attributes.event_metadata || {}) as Record<
        string,
        unknown
      >

// 元数据缺失时也要发一条「残缺事件」（把错误原因写进 additional_metadata），
// 而不是静默丢弃——否则元数据链路出问题时完全看不出来。
      if (!coreMetadata) {
        // Emit partial event if core metadata is missing
        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            `1P event logging: core_metadata missing for event ${eventName}`,
          )
        }
        events.push({
          event_type: 'ClaudeCodeInternalEvent',
          event_data: ClaudeCodeInternalEvent.toJSON({
            event_id: attributes.event_id as string | undefined,
            event_name: eventName,
            client_timestamp: this.hrTimeToDate(log.hrTime),
            session_id: getSessionId(),
            additional_metadata: Buffer.from(
              jsonStringify({
                transform_error: 'core_metadata attribute is missing',
              }),
            ).toString('base64'),
          }),
        })
        continue
      }

      // Transform to 1P format
      const formatted = to1PEventFormat(
        coreMetadata,
        userMetadata,
        eventMetadata,
      )

// PII 字段处理：把已知的 _PROTO_ 字段【提升】到 proto 的顶层字段（进特权列），
// 剩下的再用 stripProtoFields 兜底剔除——防止以后新增的未知 _PROTO_x 悄悄混进通用字段。
// 这是「白名单提升 + 兜底剔除」的双保险设计。
      // _PROTO_* keys are PII-tagged values meant only for privileged BQ
      // columns. Hoist known keys to proto fields, then defensively strip any
      // remaining _PROTO_* so an unrecognized future key can't silently land
      // in the general-access additional_metadata blob. sink.ts applies the
      // same strip before Datadog; this closes the 1P side.
// rest 解构：取出三个已知 PII 字段，其余全部进 rest。
      const {
        _PROTO_skill_name,
        _PROTO_plugin_name,
        _PROTO_marketplace_name,
        ...rest
      } = formatted.additional
      const additionalMetadata = stripProtoFields(rest)

      events.push({
        event_type: 'ClaudeCodeInternalEvent',
        event_data: ClaudeCodeInternalEvent.toJSON({
          event_id: attributes.event_id as string | undefined,
          event_name: eventName,
          client_timestamp: this.hrTimeToDate(log.hrTime),
          device_id: attributes.user_id as string | undefined,
          email: userMetadata?.email,
          auth: formatted.auth,
          ...formatted.core,
          env: formatted.env,
          process: formatted.process,
          skill_name:
            typeof _PROTO_skill_name === 'string'
              ? _PROTO_skill_name
              : undefined,
          plugin_name:
            typeof _PROTO_plugin_name === 'string'
              ? _PROTO_plugin_name
              : undefined,
          marketplace_name:
            typeof _PROTO_marketplace_name === 'string'
              ? _PROTO_marketplace_name
              : undefined,
// additional_metadata 用 Base64(JSON) 编码：后端约定这个字段是二进制 blob。
// 为空就不传（省一个字段）。
          additional_metadata:
            Object.keys(additionalMetadata).length > 0
              ? Buffer.from(jsonStringify(additionalMetadata)).toString(
                  'base64',
                )
              : undefined,
        }),
      })
    }

    return { events }
  }

// OTel 接口要求的关闭：置 shutdown 标志 → 取消退避 → 等所有在飞的导出完成。
  async shutdown(): Promise<void> {
    this.isShutdown = true
    this.resetBackoff()
    await this.forceFlush()
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('1P event logging exporter shutdown complete')
    }
  }

// forceFlush：等所有 pendingExports 结束。退出前必须调，否则最后一批事件会丢。
  async forceFlush(): Promise<void> {
    await Promise.all(this.pendingExports)
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('1P event logging exporter flush complete')
    }
  }
}

// 把 axios 错误整理成「request-id / status / code / message」的排查串，
// 出线上问题时这几个信息是定位的关键（尤其 request-id 可以对着后端日志查）。
function getAxiosErrorContext(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return errorMessage(error)
  }

  const parts: string[] = []

  const requestId = error.response?.headers?.['request-id']
  if (requestId) {
    parts.push(`request-id=${requestId}`)
  }

  if (error.response?.status) {
    parts.push(`status=${error.response.status}`)
  }

  if (error.code) {
    parts.push(`code=${error.code}`)
  }

  if (error.message) {
    parts.push(error.message)
  }

  return parts.join(', ')
}
