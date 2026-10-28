/**
 * 【一句话定位】Anthropic Files API 客户端：下载会话附件、上传文件（BYOC 模式）、列出云端文件。
 *
 * 【在架构中的位置】
 *   调用链：CLI 启动 / 会话初始化（把用户上传的附件拉到本地工作区）
 *           → 本文件 parseFileSpecs()：解析 `--file=<file_id>:<相对路径>` 形式的参数
 *           → 本文件 downloadSessionFiles()：并发下载全部附件
 *             → parallelWithLimit()：限流并发（默认 5）
 *               → downloadAndSaveFile()
 *                 → buildDownloadPath()：算落盘路径（含路径穿越防护）
 *                 → downloadFile()：GET /v1/files/{id}/content
 *                   → retryWithBackoff()：指数退避重试
 *           → 本文件 uploadSessionFiles() / uploadFile()：反向，把本地文件上传上去
 *           → 本文件 listFilesCreatedAfter()：列出某个时间点之后创建的云端文件（分页）
 *     所有网络调用：axios + Bearer OAuth + anthropic-beta / anthropic-version 头
 *     失败上报：../analytics/index.js 的 logEvent（tengu_file_upload_failed 等）
 *
 * 【本文件包含什么】
 *   - FILES_API_BETA_HEADER / ANTHROPIC_VERSION：版本头常量。
 *   - getDefaultApiBaseUrl()：base URL（环境变量优先）。
 *   - logDebug / logDebugError：带 [files-api] 前缀的日志。
 *   - File / FilesApiConfig / DownloadResult / UploadResult / FileMetadata：各类数据结构。
 *   - MAX_RETRIES / BASE_DELAY_MS / MAX_FILE_SIZE_BYTES：重试与体积上限常量。
 *   - RetryResult<T> + retryWithBackoff()：★ 通用重试封装。
 *   - downloadFile() / buildDownloadPath() / downloadAndSaveFile()：下载三件套。
 *   - parallelWithLimit()：★ 手写并发限流。
 *   - downloadSessionFiles()：批量下载入口。
 *   - uploadFile() / UploadNonRetriableError / uploadSessionFiles()：上传三件套。
 *   - listFilesCreatedAfter()：列表 + 分页。
 *   - parseFileSpecs()：CLI 参数解析。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `async function retryWithBackoff<T>(...)`：★ **泛型函数**——`<T>` 是类型参数，
 *      调用时 T 会被替换成实际类型。≈ Java 的 `<T> CompletableFuture<T> f(...)`。
 *      TS 的泛型同样是编译期擦除的（运行时不知道 T 是谁）。
 *   2. `type RetryResult<T> = { done: true; value: T } | { done: false; error?: string }`：
 *      ★ 可辨识联合。判断 `if (result.done)` 之后 TS 就知道有 .value。
 *      这是「不用异常表达失败」的 Result 模式，适合「失败是常态、要重试」的场景。
 *   3. `attemptFn: (attempt: number) => Promise<RetryResult<T>>`：
 *      ★ 参数是一个**函数类型**（高阶函数）。Java 类比：Function<Integer, CompletableFuture<Result<T>>>。
 *      这是 TS 里实现「重试」「事务」「限流」这类通用逻辑的标准做法：
 *      把「要做什么」当参数传进来。
 *   4. `async function worker(): Promise<void>` 定义在函数**内部**：
 *      ★ 嵌套函数 + 闭包。worker 能直接读写外层的 results / currentIndex 变量。
 *      Java 的局部类/lambda 也能捕获局部变量，但要求 effectively final；
 *      JS 里这些变量是**可以修改的**（currentIndex++ 就是证据）。
 *   5. `const index = currentIndex++`：后置自增，先取值再加一。跟 Java 完全一样。
 *      ★ 但要注意：JS 是单线程 + 事件循环，所以这种「无锁的自增」在 await 之前是安全的；
 *      一旦中间有 await，就要小心了（这里 ++ 和后面的 await 之间没有其它 await，安全）。
 *   6. `success: true as const`：★ `as const` 把字面量类型**收紧**为 true（而不是 boolean）。
 *      这样联合类型才能靠 `success: true` 这个标签区分出成功分支。
 *      Java 没有对应语法（要靠类型系统专家自己设计）。
 *   7. `class UploadNonRetriableError extends Error { constructor(m) { super(m); this.name = ... } }`：
 *      ★ 自定义异常类，跟 Java 几乎一样（extends / super / this）。
 *      为什么要单独一个类？因为重试逻辑需要区分「不可重试的错误」——
 *      遇到它就**立刻抛出**，不要再退避重试。
 *      Java 里同样的写法是自定义一个 RuntimeException 子类。
 *   8. `error instanceof UploadNonRetriableError`：跟 Java instanceof 一致，
 *      TS 会据此自动收窄类型（智能转型）。
 *   9. `axios.isAxiosError(error)` / `axios.isCancel(error)`：
 *      ★ 类型谓词函数（返回类型写成 `x is AxiosError`）。调用后 if 分支里类型自动收窄，
 *      可以直接访问 error.message / error.response。
 *      ≈ Java 的 instanceof + 自动向下转型。
 *  10. `Buffer` / `Buffer.concat(bodyParts)`：Node 的字节缓冲区。
 *      ≈ Java 的 byte[] / ByteBuffer。concat ≈ 把多个 byte[] 拼成一个。
 *      `Buffer.from(str)` ≈ str.getBytes(StandardCharsets.UTF_8)。
 *  11. `responseType: 'arraybuffer'`：让 axios 把响应当成二进制而不是字符串，
 *      Java 类比：用 byte[] 接收而不是 String（否则文件内容会被编码破坏）。
 *  12. `signal: opts?.signal`：AbortSignal，用于取消请求。
 *      ≈ Java 11+ HttpClient 的中断，或 CompletableFuture.cancel。
 *      axios.isCancel 就是专门识别这种取消导致的错误。
 *  13. `opts?: { signal?: AbortSignal }`：可选对象参数，对象里的字段也可选。
 *      双层可选，访问时要用 `opts?.signal`（可选链）。
 *  14. `validateStatus: status => status < 500`：让 4xx 不被当成异常抛出，
 *      这样才能在业务代码里自己区分 404/401/403/413 分别怎么处理。
 *  15. `path.normalize() / path.join() / path.dirname() / path.basename() / path.sep`：
 *      Node 的 path 模块 ≈ Java 的 java.nio.file.Path / Paths.get。
 *  16. `concurrency: number = DEFAULT_CONCURRENCY`：参数默认值（Java 要用重载实现）。
 *  17. `new Array(items.length)`：创建定长数组（Java：new Object[n]）。
 *      这里先占位、后面按 index 填，保证**结果顺序与输入顺序一致**。
 *  18. `${MAX_FILE_SIZE_BYTES}` / `500 * 1024 * 1024 // 500MB`：用乘法表达体积比写死数字清楚。
 *  19. `\r\n` 和 `--boundary`：手工拼 multipart/form-data 请求体。
 *      Java 里通常由 HTTP 客户端库代劳，这里手动拼是为了控制得精确。
 */
/**
 * Files API client for managing files
 *
 * This module provides functionality to download and upload files to Anthropic Public Files API.
 * Used by the Claude Code agent to download file attachments at session startup.
 *
 * API Reference: https://docs.anthropic.com/en/api/files-content
 */

import axios from 'axios'
import { randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { count } from '../../utils/array.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

// ★ 这个 beta 头里有两个值，注释解释了第二个的来历：
// Files API 本身还在 beta；而 oauth-2025-04-20 是让**公开 API 路由**也接受 Bearer OAuth。
// 不加的话，服务端会走旧鉴权分支直接返回 404（注释里还标了源码位置 auth.py）。
// 教训：beta 头不只是「功能开关」，还可能是「鉴权方式开关」，漏了会得到莫名其妙的 404。
// Files API is currently in beta. oauth-2025-04-20 enables Bearer OAuth
// on public-api routes (auth.py: "oauth_auth" not in beta_versions → 404).
const FILES_API_BETA_HEADER = 'files-api-2025-04-14,oauth-2025-04-20'
const ANTHROPIC_VERSION = '2023-06-01'

// API base URL - uses ANTHROPIC_BASE_URL set by env-manager for the appropriate environment
// Falls back to public API for standalone usage
// base URL 优先级：ANTHROPIC_BASE_URL（环境变量管理器按环境注入的）
// > CLAUDE_CODE_API_BASE_URL > 公网默认地址。
function getDefaultApiBaseUrl(): string {
// `||` 链取第一个「真值」：环境变量没配（undefined）时就往后退。
  return (
    process.env.ANTHROPIC_BASE_URL ||
    process.env.CLAUDE_CODE_API_BASE_URL ||
    'https://api.anthropic.com'
  )
}

function logDebugError(message: string): void {
  logForDebugging(`[files-api] ${message}`, { level: 'error' })
}

function logDebug(message: string): void {
  logForDebugging(`[files-api] ${message}`)
}

// File 类型：一个附件 = 服务端文件 ID + 在会话里的相对路径。
/**
 * File specification parsed from CLI args
 * Format: --file=<file_id>:<relative_path>
 */
export type File = {
  fileId: string
  relativePath: string
}

/**
 * Configuration for the files API client
 */
// FilesApiConfig：调用本文件所有函数都要带的配置。
// oauthToken 来自会话 JWT（而不是 API key），因为 Files API 走的是用户身份。
export type FilesApiConfig = {
  /** OAuth token for authentication (from session JWT) */
  oauthToken: string
  /** Base URL for the API (default: https://api.anthropic.com) */
  baseUrl?: string
  /** Session ID for creating session-specific directories */
  sessionId: string
}

/**
 * Result of a file download operation
 */
export type DownloadResult = {
  fileId: string
  path: string
  success: boolean
  error?: string
  bytesWritten?: number
}

// 最多重试 3 次（不是 sessionIngress 的 10 次）：文件操作相对重，
// 但也不希望用户等太久。
const MAX_RETRIES = 3
const BASE_DELAY_MS = 500
// 500MB 体积上限。乘以 1024 而不是 1000，用的是二进制单位（MiB）。
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 500MB

/**
 * Result type for retry operations - signals whether to continue retrying
 */
// ★ Result 模式：done=true 表示成功（带 value），done=false 表示这次失败（可重试）。
// 为什么不抛异常？因为「失败要重试」是这里的**正常流程**，
// 用返回值表达比用异常更轻量、更直白。
type RetryResult<T> = { done: true; value: T } | { done: false; error?: string }

/**
 * Executes an operation with exponential backoff retry logic
 *
 * @param operation - Operation name for logging
 * @param attemptFn - Function to execute on each attempt, returns RetryResult
 * @returns The successful result value
 * @throws Error if all retries exhausted
 */
// ★ 通用重试封装（本文件的核心工具）。注意它的巧妙之处：
// 它不知道要重试什么，只负责「循环 + 退避 + 记日志」，
// 具体做什么由 attemptFn 这个**函数参数**决定。
// 而「要不要继续重试」由 attemptFn 返回的 RetryResult.done 决定；
// 如果 attemptFn 直接 throw，则会穿透出去、不再重试（这是给「不可重试错误」留的口子）。
// Java 类比：模板方法模式 / 把 Callable 传进一个 RetryTemplate。
async function retryWithBackoff<T>(
  operation: string,
  attemptFn: (attempt: number) => Promise<RetryResult<T>>,
): Promise<T> {
  let lastError = ''

// 手写重试循环（for + await），不是递归——递归写重试容易爆栈。
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await attemptFn(attempt)

    if (result.done) {
      return result.value
    }

// `result.error || 兜底文案` 用 || 而不是 ??：空字符串也应被兜底掉。
    lastError = result.error || `${operation} failed`
    logDebug(
      `${operation} attempt ${attempt}/${MAX_RETRIES} failed: ${lastError}`,
    )

    if (attempt < MAX_RETRIES) {
// 指数退避：500ms → 1s → 2s。这里没有封顶（次数少，总共也就几秒）。
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      logDebug(`Retrying ${operation} in ${delayMs}ms...`)
      await sleep(delayMs)
    }
  }

// 次数耗尽才真正抛异常——把「多次尝试都失败」升级成一个 Error 交给上层。
  throw new Error(`${lastError} after ${MAX_RETRIES} attempts`)
}

/**
 * Downloads a single file from the Anthropic Public Files API
 *
 * @param fileId - The file ID (e.g., "file_011CNha8iCJcU1wXNR6q4V8w")
 * @param config - Files API configuration
 * @returns The file content as a Buffer
 */
// 下载单个文件，返回 Buffer（二进制内容，不落盘）。
export async function downloadFile(
  fileId: string,
  config: FilesApiConfig,
): Promise<Buffer> {
// `config.baseUrl || getDefaultApiBaseUrl()`：调用方没指定就用默认（|| 兜底）。
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const url = `${baseUrl}/v1/files/${fileId}/content`

  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`Downloading file ${fileId} from ${url}`)

  return retryWithBackoff(`Download file ${fileId}`, async () => {
    try {
      const response = await axios.get(url, {
        headers,
// ★ responseType: 'arraybuffer' 是必须的：文件内容是二进制，
// 让 axios 当字符串处理的话编码会被破坏（图片/压缩包直接损坏）。
        responseType: 'arraybuffer',
// 60 秒超时：大文件下载需要更长时间（比一般接口的 5 秒长得多）。
        timeout: 60000, // 60 second timeout for large files
// 让 4xx 走正常分支（我们要自己区分处理），只有 5xx 才抛异常。
        validateStatus: status => status < 500,
      })

      if (response.status === 200) {
        logDebug(`Downloaded file ${fileId} (${response.data.length} bytes)`)
// Buffer.from(response.data)：把 arraybuffer 转成 Node 的 Buffer。
// Java 类比：ByteBuffer.wrap(byte[])。
        return { done: true, value: Buffer.from(response.data) }
      }

// ★ 不可重试的错误：直接 throw（而不是返回 done:false）。
// throw 会穿透 retryWithBackoff 的循环，立刻结束——这是本文件约定好的「紧急出口」。
// 401/403/404 重试多少次结果都一样，纯属浪费时间和打服务端。
      // Non-retriable errors - throw immediately
      if (response.status === 404) {
        throw new Error(`File not found: ${fileId}`)
      }
      if (response.status === 401) {
        throw new Error('Authentication failed: invalid or missing API key')
      }
      if (response.status === 403) {
        throw new Error(`Access denied to file: ${fileId}`)
      }

// 其它状态码（比如 429）：返回 done:false，让外层退避重试。
      return { done: false, error: `status ${response.status}` }
    } catch (error) {
// 非 axios 错误（比如上面 throw 出来的）原样抛出，不能被当成可重试错误吞掉。
      if (!axios.isAxiosError(error)) {
        throw error
      }
      return { done: false, error: error.message }
    }
  })
}

/**
 * Normalizes a relative path, strips redundant prefixes, and builds the full
 * download path under {basePath}/{session_id}/uploads/.
 * Returns null if the path is invalid (e.g., path traversal).
 */
// ★ 路径组装 + 安全防护。这个函数有两个职责：
//   ①把相对路径拼到 {basePath}/{sessionId}/uploads/ 下面；
//   ②挡住**路径穿越**攻击（relativePath 里带 ../../ 想写到工作区外面去）。
// 返回 null 表示路径非法（调用方据此返回失败结果）。
// 安全提示：这是服务端给出的路径，属于不可信输入，必须校验。
export function buildDownloadPath(
  basePath: string,
  sessionId: string,
  relativePath: string,
): string | null {
// path.normalize 会把 a/b/../c 化简成 a/c，把 ../../x 保留成 ../../x。
  const normalized = path.normalize(relativePath)
// ★ 穿越防护：化简后如果以 .. 开头，说明想逃出工作区，直接拒绝。
// Java 里对应做法是 normalize 后 startsWith("..") 判断，或更严谨的 toRealPath 前缀校验。
  if (normalized.startsWith('..')) {
    logDebugError(
      `Invalid file path: ${relativePath}. Path must not traverse above workspace`,
    )
    return null
  }

  const uploadsBase = path.join(basePath, sessionId, 'uploads')
// 有些调用方会传来已经带完整前缀的路径，这里剥掉前缀避免拼成
// uploads/uploads/xxx 这种双重目录。
  const redundantPrefixes = [
    path.join(basePath, sessionId, 'uploads') + path.sep,
    path.sep + 'uploads' + path.sep,
  ]
// find 找第一个匹配的前缀（数组 find ≈ Java Stream.filter().findFirst()）。
  const matchedPrefix = redundantPrefixes.find(p => normalized.startsWith(p))
  const cleanPath = matchedPrefix
    ? normalized.slice(matchedPrefix.length)
    : normalized
  return path.join(uploadsBase, cleanPath)
}

/**
 * Downloads a file and saves it to the session-specific workspace directory
 *
 * @param attachment - The file attachment to download
 * @param config - Files API configuration
 * @returns Download result with success/failure status
 */
// 下载 + 落盘。跟 downloadFile 的区别：这个会写文件、返回结构化结果（不抛异常）。
export async function downloadAndSaveFile(
  attachment: File,
  config: FilesApiConfig,
): Promise<DownloadResult> {
  const { fileId, relativePath } = attachment
  const fullPath = buildDownloadPath(getCwd(), config.sessionId, relativePath)

  if (!fullPath) {
    return {
      fileId,
      path: '',
      success: false,
      error: `Invalid file path: ${relativePath}`,
    }
  }

  try {
    // Download the file content
    const content = await downloadFile(fileId, config)

    // Ensure the parent directory exists
    const parentDir = path.dirname(fullPath)
// recursive: true ≈ mkdir -p，自动创建多级父目录。
    await fs.mkdir(parentDir, { recursive: true })

    // Write the file
    await fs.writeFile(fullPath, content)

    logDebug(`Saved file ${fileId} to ${fullPath} (${content.length} bytes)`)

    return {
      fileId,
      path: fullPath,
      success: true,
      bytesWritten: content.length,
    }
// 对外一律不抛异常，把错误转成 DownloadResult.error 返回——
// 批量下载时一个文件失败不该影响其它文件。
  } catch (error) {
    logDebugError(`Failed to download file ${fileId}: ${errorMessage(error)}`)
    if (error instanceof Error) {
      logError(error)
    }

    return {
      fileId,
      path: fullPath,
      success: false,
      error: errorMessage(error),
    }
  }
}

// 默认并发 5。为什么不是无限并发？
// ①会打爆服务端/触发限流；②本地磁盘 IO 和内存也扛不住。
// Default concurrency limit for parallel downloads
const DEFAULT_CONCURRENCY = 5

/**
 * Execute promises with limited concurrency
 *
 * @param items - Items to process
 * @param fn - Async function to apply to each item
 * @param concurrency - Maximum concurrent operations
 * @returns Results in the same order as input items
 */
// ★ 手写并发限流（本文件最有意思的一段）。思路：
//   ①预分配一个和输入等长的结果数组（保证输出顺序 = 输入顺序）；
//   ②起 N 个 worker，每个 worker 循环「领一个下标 → 干活 → 再领下一个」；
//   ③共享的 currentIndex 是「发号器」，谁先干完谁领下一个（动态负载均衡）；
//   ④Promise.all 等所有 worker 结束。
// Java 类比：ExecutorService 固定线程池 + 共享 AtomicInteger 下标，
// 但 JS 因为单线程，连 AtomicInteger 都不需要。
async function parallelWithLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
// 预分配定长数组，后面按下标填——这样即使完成顺序乱了，结果顺序也不会乱。
  const results: R[] = new Array(items.length)
  let currentIndex = 0

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
// ★ currentIndex++：取号 + 自增。因为 JS 单线程且这两步之间没有 await，
// 所以不会有两个 worker 拿到同一个下标（Java 里这里必须用 AtomicInteger）。
      const index = currentIndex++
      const item = items[index]
      if (item !== undefined) {
        results[index] = await fn(item, index)
      }
    }
  }

  // Start workers up to the concurrency limit
  const workers: Promise<void>[] = []
// worker 数量取 min(并发上限, 任务数)：任务比并发少时没必要起多余的空 worker。
  const workerCount = Math.min(concurrency, items.length)
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker())
  }

// 等所有 worker 跑完。注意这里不需要 join 线程——await Promise.all 就够了。
  await Promise.all(workers)
  return results
}

/**
 * Downloads all file attachments for a session in parallel
 *
 * @param attachments - List of file attachments to download
 * @param config - Files API configuration
 * @param concurrency - Maximum concurrent downloads (default: 5)
 * @returns Array of download results in the same order as input
 */
// 批量下载入口。concurrency 有默认值，调用方可省略。
export async function downloadSessionFiles(
  files: File[],
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<DownloadResult[]> {
  if (files.length === 0) {
    return []
  }

  logDebug(
    `Downloading ${files.length} file(s) for session ${config.sessionId}`,
  )
  const startTime = Date.now()

  // Download files in parallel with concurrency limit
  const results = await parallelWithLimit(
    files,
    file => downloadAndSaveFile(file, config),
    concurrency,
  )

  const elapsedMs = Date.now() - startTime
// count(results, r => r.success)：项目自带的计数工具，
// ≈ Java 的 results.stream().filter(DownloadResult::isSuccess).count()。
  const successCount = count(results, r => r.success)
  logDebug(
    `Downloaded ${successCount}/${files.length} file(s) in ${elapsedMs}ms`,
  )

  return results
}

// ===== 以下为上传部分（BYOC = bring your own cloud 模式）=====
// ============================================================================
// Upload Functions (BYOC mode)
// ============================================================================

/**
 * Result of a file upload operation
 */
// ★ 又一个可辨识联合：成功分支有 fileId/size，失败分支只有 error。
// 靠 success: true / false 这个字面量标签区分。
export type UploadResult =
  | {
      path: string
      fileId: string
      size: number
      success: true
    }
  | {
      path: string
      error: string
      success: false
    }

/**
 * Upload a single file to the Files API (BYOC mode)
 *
// ★ 注意注释里的 TOCTOU（time-of-check to time-of-use）说明：
// 为什么不先 stat 一下文件大小再上传？因为在「检查」和「上传」之间，
// 文件可能已经被别的东西改了（大小变了）。所以改成**先读进内存再检查大小**，
// 检查的就是真正要上传的那份内容，消除了竞态窗口。
// 这是并发安全的经典考量。
 * Size validation is performed after reading the file to avoid TOCTOU race
 * conditions where the file size could change between initial check and upload.
 *
 * @param filePath - Absolute path to the file to upload
 * @param relativePath - Relative path for the file (used as filename in API)
 * @param config - Files API configuration
 * @returns Upload result with success/failure status
 */
// 上传单个文件。
export async function uploadFile(
  filePath: string,
  relativePath: string,
  config: FilesApiConfig,
  opts?: { signal?: AbortSignal },
): Promise<UploadResult> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const url = `${baseUrl}/v1/files`

  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`Uploading file ${filePath} as ${relativePath}`)

// 读文件放在重试循环**外面**：读盘失败不是网络问题，重试没意义。
  // Read file content first (outside retry loop since it's not a network operation)
  let content: Buffer
  try {
    content = await fs.readFile(filePath)
  } catch (error) {
    logEvent('tengu_file_upload_failed', {
      error_type:
        'file_read' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: errorMessage(error),
      success: false,
    }
  }

  const fileSize = content.length

// 体积校验（在读完之后做，理由见上面的 TOCTOU 说明）。
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    logEvent('tengu_file_upload_failed', {
      error_type:
        'file_too_large' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes (actual: ${fileSize})`,
      success: false,
    }
  }

// ★ multipart 的分界线（boundary）用 UUID 而不是时间戳：
// 注释里说明了——同一毫秒内启动多个上传时，时间戳会撞车，
// 撞车会导致服务端解析错乱。UUID  collisions 概率可忽略。
  // Use crypto.randomUUID for boundary to avoid collisions when uploads start same millisecond
  const boundary = `----FormBoundary${randomUUID()}`
  const filename = path.basename(relativePath)

  // Build the multipart body
// ★ 手工拼 multipart/form-data 请求体：先收集若干 Buffer，最后 concat 成一块。
// 为什么要手工拼？因为要精确控制 boundary 和 Content-Length。
// Java 里通常由 Spring 的 MultipartFile / OkHttp 的 MultipartBody 代劳。
  const bodyParts: Buffer[] = []

  // File part
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  )
  bodyParts.push(content)
// 注意每个 part 之间要有 \r\n，最后一个 part 后面要有 --boundary-- 结尾标记。
  bodyParts.push(Buffer.from('\r\n'))

  // Purpose part
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
        `user_data\r\n`,
    ),
  )

  // End boundary
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`))

// Buffer.concat ≈ 把多个 byte[] 顺序拼成一个大 byte[]（避免字符串拼接的编码问题）。
  const body = Buffer.concat(bodyParts)

  try {
    return await retryWithBackoff(`Upload file ${relativePath}`, async () => {
      try {
        const response = await axios.post(url, body, {
          headers: {
            ...headers,
// Content-Type 里必须带上 boundary，否则服务端不知道怎么切分各个 part。
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
// Content-Length 显式给：大文件上传时能让服务端正确接收。
            'Content-Length': body.length.toString(),
          },
// 上传超时 2 分钟（比下载的 60 秒更长，因为上传通常更慢）。
          timeout: 120000, // 2 minute timeout for uploads
// signal：支持外部取消（比如用户 Ctrl-C）。
          signal: opts?.signal,
          validateStatus: status => status < 500,
        })

        if (response.status === 200 || response.status === 201) {
// `response.data?.id`：可选链防空。拿到 fileId 才算真的成功。
          const fileId = response.data?.id
          if (!fileId) {
            return {
              done: false,
              error: 'Upload succeeded but no file ID returned',
            }
          }
          logDebug(`Uploaded file ${filePath} -> ${fileId} (${fileSize} bytes)`)
          return {
            done: true,
            value: {
              path: relativePath,
              fileId,
              size: fileSize,
// ★ `success: true as const`：as const 把类型从 boolean 收紧成字面量 true，
// 这样联合类型才能靠它区分成功/失败分支。少了 as const 的话 TS 会推断成 boolean，
// 判别就失效了 —— 这是实战中很容易漏的一个细节。
              success: true as const,
            },
          }
        }

// 不可重试的错误：抛 UploadNonRetriableError，直接跳出重试循环。
        // Non-retriable errors - throw to exit retry loop
        if (response.status === 401) {
          logEvent('tengu_file_upload_failed', {
            error_type:
              'auth' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError(
            'Authentication failed: invalid or missing API key',
          )
        }

        if (response.status === 403) {
          logEvent('tengu_file_upload_failed', {
            error_type:
              'forbidden' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError('Access denied for upload')
        }

// 413 = Payload Too Large，重试也没用（文件就那么大）。
        if (response.status === 413) {
          logEvent('tengu_file_upload_failed', {
            error_type:
              'size' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError('File too large for upload')
        }

        return { done: false, error: `status ${response.status}` }
      } catch (error) {
        // Non-retriable errors propagate up
// ★ 关键：把「不可重试错误」从可重试错误里分拣出来。
// UploadNonRetriableError 原样抛出（终止重试）；axios 错误返回 done:false（继续重试）。
        if (error instanceof UploadNonRetriableError) {
          throw error
        }
// 用户主动取消也不该重试。
        if (axios.isCancel(error)) {
          throw new UploadNonRetriableError('Upload canceled')
        }
        // Network errors are retriable
        if (axios.isAxiosError(error)) {
          return { done: false, error: error.message }
        }
        throw error
      }
    })
  } catch (error) {
// 不可重试错误 → 转成失败结果返回（不抛给调用方）；
// 其它（重试耗尽）→ 上报一条 network 类型的分析事件再返回失败。
    if (error instanceof UploadNonRetriableError) {
      return {
        path: relativePath,
        error: error.message,
        success: false,
      }
    }
    logEvent('tengu_file_upload_failed', {
      error_type:
        'network' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: errorMessage(error),
      success: false,
    }
  }
}

// ★ 自定义错误类。为什么要单独建一个类？
// 因为要在 catch 里靠 instanceof **区分**「不可重试」和「可重试」，
// 光靠 message 字符串判断太脆弱。Java 里是完全一样的做法。
/** Error class for non-retriable upload failures */
class UploadNonRetriableError extends Error {
  constructor(message: string) {
    super(message)
// this.name 要手动设置：JS 的 Error 子类默认 name 是 'Error'，
// 不设的话日志里看不出具体类型（Java 里 getClass().getName() 是自动的）。
    this.name = 'UploadNonRetriableError'
  }
}

/**
 * Upload multiple files in parallel with concurrency limit (BYOC mode)
 *
 * @param files - Array of files to upload (path and relativePath)
 * @param config - Files API configuration
 * @param concurrency - Maximum concurrent uploads (default: 5)
 * @returns Array of upload results in the same order as input
 */
// 批量上传入口，同样是并发限流 + 结果保序。
export async function uploadSessionFiles(
  files: Array<{ path: string; relativePath: string }>,
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<UploadResult[]> {
  if (files.length === 0) {
    return []
  }

  logDebug(`Uploading ${files.length} file(s) for session ${config.sessionId}`)
  const startTime = Date.now()

  const results = await parallelWithLimit(
    files,
    file => uploadFile(file.path, file.relativePath, config),
    concurrency,
  )

  const elapsedMs = Date.now() - startTime
  const successCount = count(results, r => r.success)
  logDebug(`Uploaded ${successCount}/${files.length} file(s) in ${elapsedMs}ms`)

  return results
}

// ===== 列表部分（1P / Cloud 模式）=====
// ============================================================================
// List Files Functions (1P/Cloud mode)
// ============================================================================

/**
 * File metadata returned from listFilesCreatedAfter
 */
export type FileMetadata = {
  filename: string
  fileId: string
  size: number
}

/**
 * List files created after a given timestamp (1P/Cloud mode).
 * Uses the public GET /v1/files endpoint with after_created_at query param.
 * Handles pagination via after_id cursor when has_more is true.
 *
 * @param afterCreatedAt - ISO 8601 timestamp to filter files created after
 * @param config - Files API configuration
 * @returns Array of file metadata for files created after the timestamp
 */
// 列出某个时间点之后创建的文件（用于增量同步 / 云端模式发现新附件）。
export async function listFilesCreatedAfter(
  afterCreatedAt: string,
  config: FilesApiConfig,
): Promise<FileMetadata[]> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`Listing files created after ${afterCreatedAt}`)

  const allFiles: FileMetadata[] = []
// 游标分页：after_id 表示「从哪个文件之后继续」，由服务端在 has_more 时告诉我们。
  let afterId: string | undefined

  // Paginate through results
// while (true) 分页循环。退出条件有两个：has_more 为 false，或拿不到下一页的游标。
  while (true) {
    const params: Record<string, string> = {
      after_created_at: afterCreatedAt,
    }
    if (afterId) {
      params.after_id = afterId
    }

    const page = await retryWithBackoff(
      `List files after ${afterCreatedAt}`,
      async () => {
        try {
          const response = await axios.get(`${baseUrl}/v1/files`, {
            headers,
            params,
            timeout: 60000,
            validateStatus: status => status < 500,
          })

          if (response.status === 200) {
            return { done: true, value: response.data }
          }

          if (response.status === 401) {
            logEvent('tengu_file_list_failed', {
              error_type:
                'auth' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            throw new Error('Authentication failed: invalid or missing API key')
          }
          if (response.status === 403) {
            logEvent('tengu_file_list_failed', {
              error_type:
                'forbidden' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            throw new Error('Access denied to list files')
          }

          return { done: false, error: `status ${response.status}` }
        } catch (error) {
          if (!axios.isAxiosError(error)) {
            throw error
          }
          logEvent('tengu_file_list_failed', {
            error_type:
              'network' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return { done: false, error: error.message }
        }
      },
    )

// `page.data || []` 兜底：响应里没有 data 字段时当成空数组（|| 连空数组都不放过？
// 注意：|| 遇到 [] 时 [] 是**真值**，所以只有 undefined/null 才会被兜底，符合预期。
    const files = page.data || []
    for (const f of files) {
      allFiles.push({
        filename: f.filename,
        fileId: f.id,
        size: f.size_bytes,
      })
    }

    if (!page.has_more) {
      break
    }

    // Use the last file's ID as cursor for next page
// `.at(-1)` 取本页最后一个文件，用它的 id 作为下一页的游标（见 .at(-1) 说明）。
    const lastFile = files.at(-1)
// `!lastFile?.id`：可选链 + 非。拿不到 id 就退出，避免死循环。
    if (!lastFile?.id) {
      break
    }
    afterId = lastFile.id
  }

  logDebug(`Listed ${allFiles.length} files created after ${afterCreatedAt}`)
  return allFiles
}

// ============================================================================
// Parse Functions
// ============================================================================

/**
 * Parse file attachment specs from CLI arguments
 * Format: <file_id>:<relative_path>
 *
 * @param fileSpecs - Array of file spec strings
 * @returns Parsed file attachments
 */
// 解析 CLI 参数。格式：<file_id>:<相对路径>
export function parseFileSpecs(fileSpecs: string[]): File[] {
  const files: File[] = []

  // Sandbox-gateway may pass multiple specs as a single space-separated string
// ★ flatMap：先 map 再「拍平」一层。这里因为上游（sandbox-gateway）可能把
// 多个 spec 塞在同一个用空格分隔的字符串里，所以要再切开、再拍平。
// Java：stream.flatMap(s -> Arrays.stream(s.split(" ")))。
// `.filter(Boolean)` 是去掉空字符串的惯用写法（Boolean 当函数用，过滤掉所有假值）。
  const expandedSpecs = fileSpecs.flatMap(s => s.split(' ').filter(Boolean))

  for (const spec of expandedSpecs) {
// 用 indexOf 找第一个冒号。为什么不用 split(':')？
// 因为 Windows 路径里可能有盘符冒号（C:\...），按第一个冒号切更可控；
// 而且 split 会产生多余数组。这里 file_id 里不会有冒号，所以第一个冒号就是分隔符。
    const colonIndex = spec.indexOf(':')
    if (colonIndex === -1) {
      continue
    }

    const fileId = spec.substring(0, colonIndex)
    const relativePath = spec.substring(colonIndex + 1)

// 两个字段都必须非空，否则跳过这一条并记日志（而不是整体失败）。
    if (!fileId || !relativePath) {
      logDebugError(
        `Invalid file spec: ${spec}. Both file_id and path are required`,
      )
      continue
    }

    files.push({ fileId, relativePath })
  }

  return files
}
