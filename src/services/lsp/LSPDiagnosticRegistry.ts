/**
 * 【一句话定位】
 * LSP 诊断信息（diagnostic）的「全局收件箱 + 去重 + 限流 + 投递」模块。
 * language server 异步推送过来的类型错误/警告，先存在这里，再在合适时机作为 attachment 喂给模型。
 *
 * 【在架构中的位置】
 * 回流链路（这是 Claude Code「能看见编译器报错」的完整通路，务必串起来看）：
 *   ① LSPServerManager.openFile()/changeFile()/saveFile() 把文件内容同步给 language server
 *   ② language server 分析后，主动推送 textDocument/publishDiagnostics 通知（server → 客户端方向）
 *   ③ LSPClient 的 onNotification 回调收到，转交给 passiveFeedback.ts 或直接调本文件的
 *      registerPendingLSPDiagnostic()
 *   ④ 本文件把诊断暂存进 pendingDiagnostics（按 UUID 存，去重、限流）
 *   ⑤ 对话层调 checkForLSPDiagnostics() 取出、去重、按严重度排序、截断
 *   ⑥ 转成 Attachment 注入下一条用户消息 → 模型就「看到」了这些类型错误
 * 也就是说：本文件是「编译器 → 模型」之间的缓冲区。
 *
 * 【为什么要去重 / 限流】
 * language server 非常啰嗦：你每敲一下键盘它可能就把同一批错误重发一遍。
 * 如果不过滤直接喂给模型，上下文会被同一个错误刷爆。所以这里做了三层控制：
 * - 批内去重（同一次取件里重复的）
 * - 跨轮次去重（上一轮已经告诉过模型的，用 LRU 记住，不再重复说）
 * - 体积限流（每文件最多 10 条、总共最多 30 条，按严重度 Error 优先）
 *
 * 【本文件包含什么】
 * - type PendingLSPDiagnostic：一条待投递的诊断记录（来自哪个 server、哪些文件、时间、是否已投递）。
 * - MAX_DIAGNOSTICS_PER_FILE / MAX_TOTAL_DIAGNOSTICS / MAX_DELIVERED_FILES：限流与 LRU 容量常量。
 * - pendingDiagnostics：待投递表（模块级全局 Map）。
 * - deliveredDiagnostics：已投递表（LRUCache，跨轮次去重用）。
 * - registerPendingLSPDiagnostic()：入口，登记一条新到的诊断。
 * - severityToNumber() / createDiagnosticKey()：排序与去重的两个工具函数。
 * - deduplicateDiagnosticFiles()：去重主逻辑。
 * - checkForLSPDiagnostics()：取件（含去重、限流、标记已投）。
 * - clearAllLSPDiagnostics() / resetAllLSPDiagnosticState() / clearDeliveredDiagnosticsForFile()：清理。
 * - getPendingLSPDiagnosticCount()：监控用。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - 模块级 `const xxx = new Map(...)`：这就是「单例全局状态」。
 *   ≈ Java 的 `public static final Map<...> XXX`（类静态字段）。TS 里一个模块被 import 多次也只执行一次。
 * - `new LRUCache<string, Set<string>>({ max: N })`：LRU 缓存，容量满时自动淘汰最久未用的键。
 *   ≈ Java 的 LinkedHashMap(accessOrder=true) 手写 LRU，或 Guava/Caffeine 的 maximumSize。
 * - `Set<string>`：≈ Java 的 HashSet。has/add/size，语义一致。
 * - `export function f({ a, b }: { a: string; b: number })`：
 *   参数解构 + 内联类型。调用时写 `f({ a: 'x', b: 1 })`。
 *   ≈ Java 里传一个 record，但 TS 不要求先定义类，直接把形状写在参数位置上。
 * - `severity?: string`：可选属性，`?` 等价于 `string | undefined`。
 * - `function f(severity: string | undefined)`：联合类型入参，调用方可以传 undefined。
 * - `switch (severity) { case 'Error': ... default: ... }`：和 Java 的 switch 一样（但不需要 break 也不会穿透，
 *   TS 默认每个 case 结束后跳出；要穿透得写 fallthrough 注释）。
 * - `fileMap.get(file.uri)!`：后缀 `!` 是非空断言。因为上一行刚 set 过，我们比编译器更清楚它一定存在，
 *   用 `!` 关掉「可能为 undefined」的报错。≈ Java 的强制转换，写错就是运行期 NPE。
 * - `.find(f => f.uri === file.uri)!`：数组查找 ≈ Java 的 stream().filter().findFirst().get()。
 * - `allFiles.push(...diagnostic.files)`：`...` 展开成多个实参。≈ Java 的 `addAll(...)`，
 *   但这里是「把数组元素逐个作为实参传进去」。
 * - `catch (error: unknown)`：catch 变量可以显式标注类型，unknown 是最严格的（必须校验后才能用）。
 * - `toError(error)`：把 unknown 收敛成 Error 的工具函数 ≈ `(Error) e` 但带兜底。
 * - `diag.message?.substring(0, 100) || '<no message>'`：
 *   `?.` 可选链（message 为空则整条表达式短路为 undefined）+ `||` 兜底（undefined 时给默认值）。
 *   这是「安全取值 + 默认值」的标准连招。注意 `||` 会把空字符串 '' 也替换成兜底值。
 * - `allFiles.reduce((sum, f) => sum + f.diagnostics.length, 0)`：
 *   reduce ≈ Java Stream 的 reduce/collect(summingInt)。第二个参数 0 是初始值。
 * - `Array.from(serverNames).join(', ')`：把 Set 转成数组再拼成字符串。
 *   ≈ Java 的 `String.join(", ", set)`（TS 的 Set 没有 join，所以要先 Array.from）。
 * - `file.diagnostics.sort((a, b) => x - y)`：原地排序（会修改原数组，不是返回新数组）。
 *   ≈ Java 的 `list.sort(comparator)`；比较函数返回负数/0/正数，和 Comparator 一致。
 * - `file.diagnostics.slice(0, N)`：截取前 N 个，返回新数组。≈ Java 的 `subList(0, N)`。
 * - `for (const [id, diagnostic] of pendingDiagnostics)`：直接遍历 Map 得到 [键, 值] 并解构。
 *   ≈ Java 的 `for (Map.Entry<K,V> e : map.entrySet())`。
 * - 返回类型写成 `Array<{ serverName: string; files: DiagnosticFile[] }>`：
 *   匿名对象类型的数组，≈ Java 里 List<某个 record>，但不用先给 record 起名字。
 */
import { randomUUID } from 'crypto'
import { LRUCache } from 'lru-cache'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { DiagnosticFile } from '../diagnosticTracking.js'

/**
 * Pending LSP diagnostic notification
 */
// 中文补充：一条「待投递」的诊断记录。
// attachmentSent 是投递开关——取件后被置为 true，避免同一条诊断被重复喂给模型两次。
export type PendingLSPDiagnostic = {
  /** Server that sent the diagnostic */
  serverName: string
  /** Diagnostic files */
  files: DiagnosticFile[]
  /** When diagnostic was received */
  timestamp: number
  /** Whether attachment was already sent to conversation */
  attachmentSent: boolean
}

/**
// 中文补充（整体设计，配合上面的英文 Pattern 一起看）：
// 这是一个「生产者-消费者」缓冲区。生产者是 language server（异步、不可控、可能狂轰滥炸），
// 消费者是主对话循环（按轮次取件）。中间必须有缓冲 + 去重 + 限流，否则上下文瞬间被冲垮。
// 类比 Java：BlockingQueue + 一层 Set 去重 + Guava RateLimiter，只是这里都是同步 Map 操作。
 * LSP Diagnostic Registry
 *
 * Stores LSP diagnostics received asynchronously from LSP servers via
 * textDocument/publishDiagnostics notifications. Follows the same pattern
 * as AsyncHookRegistry for consistent async attachment delivery.
 *
 * Pattern:
 * 1. LSP server sends publishDiagnostics notification
 * 2. registerPendingLSPDiagnostic() stores diagnostic
 * 3. checkForLSPDiagnostics() retrieves pending diagnostics
 * 4. getLSPDiagnosticAttachments() converts to Attachment[]
 * 5. getAttachments() delivers to conversation automatically
 *
 * Similar to AsyncHookRegistry but simpler since diagnostics arrive
 * synchronously (no need to accumulate output over time).
 */

// Volume limiting constants
// 限流阈值（经验值）：单文件最多报 10 条——再多模型也看不过来，反而稀释注意力；
// 总量 30 条——控制注入上下文的体积，避免挤占用户的有效信息。
const MAX_DIAGNOSTICS_PER_FILE = 10
const MAX_TOTAL_DIAGNOSTICS = 30

// Max files to track for deduplication - prevents unbounded memory growth
// 只记最近 500 个文件的去重指纹，用 LRU 自动淘汰。
// 为什么必须有上限：长会话里打开过的文件会越来越多，不限量的话 Set 会无限增长——典型的内存泄漏。
const MAX_DELIVERED_FILES = 500

// Global registry state
// 模块级全局状态 ≈ Java 的 public static final Map。整个进程只有这一份。
const pendingDiagnostics = new Map<string, PendingLSPDiagnostic>()

// Cross-turn deduplication: tracks diagnostics that have been delivered
// Maps file URI to a set of diagnostic keys (hash of message+severity+range)
// Using LRUCache to prevent unbounded growth in long sessions
// 跨轮次去重的指纹库：文件 URI → 该文件的诊断指纹集合。
// 为什么要「跨轮次」：同一个错误，第 1 轮已经告诉模型了，第 2 轮再说一遍纯属浪费 token，
// 还容易让模型以为「你又改错了」。只有文件被真正编辑过（见 clearDeliveredDiagnosticsForFile）才重置。
const deliveredDiagnostics = new LRUCache<string, Set<string>>({
  max: MAX_DELIVERED_FILES,
})

/**
 * Register LSP diagnostics received from a server.
 * These will be delivered as attachments in the next query.
 *
 * @param serverName - Name of LSP server that sent diagnostics
 * @param files - Diagnostic files to deliver
 */
// 登记一条新到的诊断（生产者侧入口）。
// @param serverName 来源 server 名，仅用于日志/展示时区分。
// @param files      诊断文件列表（每个文件带 uri + diagnostics 数组）。
// 设计意图：这里只做「存」，不做任何去重/限流——因为通知到达的频率很高，
// 把重活放到消费侧（checkForLSPDiagnostics）做，可以合并掉中间批次，效率高得多。
export function registerPendingLSPDiagnostic({
  serverName,
  files,
}: {
  serverName: string
  files: DiagnosticFile[]
}): void {
  // Use UUID for guaranteed uniqueness (handles rapid registrations)
// 为什么用 UUID 而不是自增数字做 key：诊断可能在极短时间内连续到达（比如保存一个文件触发
// 多个 server 同时推送），自增 id 在并发/重入下容易撞；UUID 保证唯一，省得加锁。
  const diagnosticId = randomUUID()

  logForDebugging(
    `LSP Diagnostics: Registering ${files.length} diagnostic file(s) from ${serverName} (ID: ${diagnosticId})`,
  )

  pendingDiagnostics.set(diagnosticId, {
    serverName,
    files,
    timestamp: Date.now(),
    attachmentSent: false,
  })
}

/**
 * Maps severity string to numeric value for sorting.
 * Error=1, Warning=2, Info=3, Hint=4
 */
// 把严重度字符串映射成数字，用于排序：数字越小越严重（Error=1 最靠前）。
// default 返回 4（最不严重）：未知严重度一律当 Hint 处理，宁可排在后面也不要丢掉。
function severityToNumber(severity: string | undefined): number {
  switch (severity) {
    case 'Error':
      return 1
    case 'Warning':
      return 2
    case 'Info':
      return 3
    case 'Hint':
      return 4
    default:
      return 4
  }
}

/**
 * Creates a unique key for a diagnostic based on its content.
 * Used for both within-batch and cross-turn deduplication.
 */
// 生成「诊断指纹」：把 message + severity + range + source + code 序列化成字符串当唯一键。
// 为什么要包含 range：同一条「变量未定义」错误在不同行出现，是两个不同的错误，不能互相覆盖。
// 为什么用 jsonStringify 而不是手工拼接：JSON.stringify 能稳定处理嵌套对象（range 是对象），
// 而且键顺序固定，同样的内容一定得到同样的字符串（指纹必须稳定，否则去重失效）。
// source/code 用 `|| null`：把 undefined 和空串都归一成 null，避免「有 source」和「没 source」
// 因为 undefined 被 JSON 忽略而产生两个不同指纹。
function createDiagnosticKey(diag: {
  message: string
  severity?: string
  range?: unknown
  source?: string
  code?: unknown
}): string {
  return jsonStringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source || null,
    code: diag.code || null,
  })
}

/**
 * Deduplicates diagnostics by file URI and diagnostic content.
 * Also filters out diagnostics that were already delivered in previous turns.
 * Two diagnostics are considered duplicates if they have the same:
 * - File URI
 * - Range (start/end line and character)
 * - Message
 * - Severity
 * - Source and code (if present)
 */
// 去重主逻辑：同时做「批内去重」和「跨轮次去重」。
// @param allFiles 本次取到的所有诊断文件（可能有重复）
// @returns 去重后的文件列表；全被去重掉的空文件会被剔除。
// 关键容错：单条诊断处理失败（比如 JSON 序列化炸了）也要 push 进去而不是丢弃——
// 漏报一个真错误的代价，远大于多报一条重复的。
function deduplicateDiagnosticFiles(
  allFiles: DiagnosticFile[],
): DiagnosticFile[] {
  // Group diagnostics by file URI
  const fileMap = new Map<string, Set<string>>()
  const dedupedFiles: DiagnosticFile[] = []

  for (const file of allFiles) {
    if (!fileMap.has(file.uri)) {
      fileMap.set(file.uri, new Set())
      dedupedFiles.push({ uri: file.uri, diagnostics: [] })
    }

// `!` 非空断言：上一行刚 set 过，编译器不知道，我们手动担保。写成 `fileMap.get(uri)!` 取值不为 undefined。
    const seenDiagnostics = fileMap.get(file.uri)!
    const dedupedFile = dedupedFiles.find(f => f.uri === file.uri)!

    // Get previously delivered diagnostics for this file (for cross-turn dedup)
// `|| new Set()`：这个文件从没投递过就用一个空集合。注意不要直接把 new Set() 存回去，
// 否则会污染 LRU（把不存在的文件也写进缓存）。
    const previouslyDelivered = deliveredDiagnostics.get(file.uri) || new Set()

    for (const diag of file.diagnostics) {
      try {
        const key = createDiagnosticKey(diag)

        // Skip if already seen in this batch OR already delivered in previous turns
// 两个条件任一命中就跳过：本批次内已出现过（seenDiagnostics），或以前轮次已投递过（previouslyDelivered）。
        if (seenDiagnostics.has(key) || previouslyDelivered.has(key)) {
          continue
        }

        seenDiagnostics.add(key)
        dedupedFile.diagnostics.push(diag)
      } catch (error: unknown) {
        const err = toError(error)
        const truncatedMessage =
// 截断到 100 字符再打日志：诊断消息可能超长（比如类型不匹配的完整类型签名），
// 全量打印会把 debug 日志撑爆。
          diag.message?.substring(0, 100) || '<no message>'
        logError(
          new Error(
            `Failed to deduplicate diagnostic in ${file.uri}: ${err.message}. ` +
              `Diagnostic message: ${truncatedMessage}`,
          ),
        )
// 宁可重复，不可漏报——这是本文件反复出现的设计原则。
        // Include the diagnostic anyway to avoid losing information
        dedupedFile.diagnostics.push(diag)
      }
    }
  }

  // Filter out files with no diagnostics after deduplication
  return dedupedFiles.filter(f => f.diagnostics.length > 0)
}

/**
 * Get all pending LSP diagnostics that haven't been delivered yet.
 * Deduplicates diagnostics to prevent sending the same diagnostic multiple times.
 * Marks diagnostics as sent to prevent duplicate delivery.
 *
 * @returns Array of pending diagnostics ready for delivery (deduplicated)
 */
// 消费侧取件入口。完整步骤：
// ① 收集所有未投递的诊断 ② 去重（失败则降级用未去重的全量）③ 标记已投递并清空待投递表
// ④ 按严重度排序 + 每文件截断 + 总量截断 ⑤ 记录本轮指纹到 LRU ⑥ 返回单条汇总结果
// 注意返回的是「数组包一个对象」（而不是直接返回对象），是为了和 hook 产出物的形状保持一致。
export function checkForLSPDiagnostics(): Array<{
  serverName: string
  files: DiagnosticFile[]
}> {
  logForDebugging(
    `LSP Diagnostics: Checking registry - ${pendingDiagnostics.size} pending`,
  )

  // Collect all diagnostic files from all pending notifications
  const allFiles: DiagnosticFile[] = []
  const serverNames = new Set<string>()
  const diagnosticsToMark: PendingLSPDiagnostic[] = []

// 只处理 attachmentSent === false 的（还没喂给模型的）。
  for (const diagnostic of pendingDiagnostics.values()) {
    if (!diagnostic.attachmentSent) {
      allFiles.push(...diagnostic.files)
      serverNames.add(diagnostic.serverName)
      diagnosticsToMark.push(diagnostic)
    }
  }

  if (allFiles.length === 0) {
    return []
  }

  // Deduplicate diagnostics across all files
  let dedupedFiles: DiagnosticFile[]
// 去重失败不能中断整个流程：降级成「不去重」，宁可重复也不能丢诊断。
  try {
    dedupedFiles = deduplicateDiagnosticFiles(allFiles)
  } catch (error: unknown) {
    const err = toError(error)
    logError(new Error(`Failed to deduplicate LSP diagnostics: ${err.message}`))
    // Fall back to undedup'd files to avoid losing diagnostics
    dedupedFiles = allFiles
  }

// 顺序很重要：必须「先去重成功，再标记已投递」。反过来（先标记再去重）的话，
// 一旦去重抛异常，这批诊断就永远消失了（已标记但没投递）。
  // Only mark as sent AFTER successful deduplication, then delete from map.
  // Entries are tracked in deliveredDiagnostics LRU for dedup, so we don't
  // need to keep them in pendingDiagnostics after delivery.
  for (const diagnostic of diagnosticsToMark) {
    diagnostic.attachmentSent = true
  }
  for (const [id, diagnostic] of pendingDiagnostics) {
    if (diagnostic.attachmentSent) {
      pendingDiagnostics.delete(id)
    }
  }

// 统计去重前后条数，只为打日志用——方便排查「为什么模型没看到某条错误」。
  const originalCount = allFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  )
  const dedupedCount = dedupedFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  )

  if (originalCount > dedupedCount) {
    logForDebugging(
      `LSP Diagnostics: Deduplication removed ${originalCount - dedupedCount} duplicate diagnostic(s)`,
    )
  }

  // Apply volume limiting: cap per file and total
  let totalDiagnostics = 0
  let truncatedCount = 0
// 限流三步走：先按严重度排序（保证截断时留下的是 Error 而不是 Hint），再单文件截断，再总量截断。
  for (const file of dedupedFiles) {
    // Sort by severity (Error=1 < Warning=2 < Info=3 < Hint=4) to prioritize errors
    file.diagnostics.sort(
      (a, b) => severityToNumber(a.severity) - severityToNumber(b.severity),
    )

    // Cap per file
// slice(0, N) 返回新数组并重新赋值——这里刻意「原地替换」file.diagnostics，
// 因为 file 是我们要返回给上层的对象，需要真的把多的丢掉。
    if (file.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
      truncatedCount += file.diagnostics.length - MAX_DIAGNOSTICS_PER_FILE
      file.diagnostics = file.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)
    }

    // Cap total
// 全局配额是「跨文件累计」的：前面文件用掉的额度，后面文件就没了。
// remainingCapacity 可能为 0 甚至负数，但 slice(0, 负数) 只会保留末尾元素，
// 所以实际不会出现——因为进入这个分支的前提是 length > remainingCapacity。
    const remainingCapacity = MAX_TOTAL_DIAGNOSTICS - totalDiagnostics
    if (file.diagnostics.length > remainingCapacity) {
      truncatedCount += file.diagnostics.length - remainingCapacity
      file.diagnostics = file.diagnostics.slice(0, remainingCapacity)
    }

    totalDiagnostics += file.diagnostics.length
  }

  // Filter out files that ended up with no diagnostics after limiting
  dedupedFiles = dedupedFiles.filter(f => f.diagnostics.length > 0)

  if (truncatedCount > 0) {
    logForDebugging(
      `LSP Diagnostics: Volume limiting removed ${truncatedCount} diagnostic(s) (max ${MAX_DIAGNOSTICS_PER_FILE}/file, ${MAX_TOTAL_DIAGNOSTICS} total)`,
    )
  }

  // Track delivered diagnostics for cross-turn deduplication
// 把本轮真正投递出去的诊断指纹写进 LRU，供后续轮次去重使用。
  for (const file of dedupedFiles) {
    if (!deliveredDiagnostics.has(file.uri)) {
      deliveredDiagnostics.set(file.uri, new Set())
    }
    const delivered = deliveredDiagnostics.get(file.uri)!
    for (const diag of file.diagnostics) {
      try {
        delivered.add(createDiagnosticKey(diag))
      } catch (error: unknown) {
        // Log but continue - failure to track shouldn't prevent delivery
        const err = toError(error)
        const truncatedMessage =
          diag.message?.substring(0, 100) || '<no message>'
        logError(
          new Error(
            `Failed to track delivered diagnostic in ${file.uri}: ${err.message}. ` +
              `Diagnostic message: ${truncatedMessage}`,
          ),
        )
      }
    }
  }

  const finalCount = dedupedFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  )

  // Return empty if no diagnostics to deliver (all filtered by deduplication)
// 全部被去重掉了：说明模型已经知道这些错误，返回空数组，不打扰它。
  if (finalCount === 0) {
    logForDebugging(
      `LSP Diagnostics: No new diagnostics to deliver (all filtered by deduplication)`,
    )
    return []
  }

  logForDebugging(
    `LSP Diagnostics: Delivering ${dedupedFiles.length} file(s) with ${finalCount} diagnostic(s) from ${serverNames.size} server(s)`,
  )

  // Return single result with all deduplicated diagnostics
// 多个 server 的结果合并成一条返回（serverName 用逗号拼接），
// 这样上层只需要处理一个 attachment，不用循环。
  return [
    {
      serverName: Array.from(serverNames).join(', '),
      files: dedupedFiles,
    },
  ]
}

/**
 * Clear all pending diagnostics.
 * Used during cleanup/shutdown or for testing.
 * Note: Does NOT clear deliveredDiagnostics - that's for cross-turn deduplication
 * and should only be cleared when files are edited or on session reset.
 */
// 只清「待投递」，不动「已投递」指纹库——因为跨轮次去重在会话期间要一直有效。
export function clearAllLSPDiagnostics(): void {
  logForDebugging(
    `LSP Diagnostics: Clearing ${pendingDiagnostics.size} pending diagnostic(s)`,
  )
  pendingDiagnostics.clear()
}

/**
 * Reset all diagnostic state including cross-turn tracking.
 * Used on session reset or for testing.
 */
// 彻底重置（两个表都清）：用于会话级重置或测试。注意生产环境别乱调，
// 会让所有错误重新报一遍给模型。
export function resetAllLSPDiagnosticState(): void {
  logForDebugging(
    `LSP Diagnostics: Resetting all state (${pendingDiagnostics.size} pending, ${deliveredDiagnostics.size} files tracked)`,
  )
  pendingDiagnostics.clear()
  deliveredDiagnostics.clear()
}

/**
 * Clear delivered diagnostics for a specific file.
 * Should be called when a file is edited so that new diagnostics for that file
 * will be shown even if they match previously delivered ones.
 *
 * @param fileUri - URI of the file that was edited
 */
// 文件被编辑后必须调它：否则「同一个位置的同一个错误」会因为跨轮次去重被永久屏蔽，
// 用户改完代码却再也不能收到提示——这是本模块最容易踩的坑。
// 典型触发点：Write/Edit 工具写文件成功后。
export function clearDeliveredDiagnosticsForFile(fileUri: string): void {
  if (deliveredDiagnostics.has(fileUri)) {
    logForDebugging(
      `LSP Diagnostics: Clearing delivered diagnostics for ${fileUri}`,
    )
    deliveredDiagnostics.delete(fileUri)
  }
}

/**
 * Get count of pending diagnostics (for monitoring)
 */
// 监控用：当前堆积了多少条未投递的诊断（可用于判断 language server 是否在疯狂刷屏）。
export function getPendingLSPDiagnosticCount(): number {
  return pendingDiagnostics.size
}
