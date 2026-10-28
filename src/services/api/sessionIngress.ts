/**
 * 【一句话定位】把会话日志（transcript）逐条**追加**到远端服务端的客户端：
 *           带乐观并发控制（Last-Uuid）、指数退避重试、按 session 串行化。
 *
 * 【在架构中的位置】
 *   调用链：会话持久化层（把本地 ~/.claude/projects/*.jsonl 同步到云端，供 Web/移动端续接）
 *           → 本文件 appendSessionLog()（写一条）
 *             → utils/sessionIngressAuth.ts（getSessionIngressAuthToken 拿 JWT）
 *             → getOrCreateSequentialAppend()（按 session 串行化）
 *               → appendSessionLogImpl()（★ 核心：带重试的 PUT）
 *                 → axios.put(url, entry, {headers: {Last-Uuid}})
 *                 → 409 冲突时 → fetchSessionLogsFromUrl() 重新拉全量找链尾
 *           → 本文件 getSessionLogs()（读全量，用同一个 JWT）
 *           → 本文件 getSessionLogsViaOAuth()（读全量，改用 OAuth 头，用于 teleport）
 *           → 本文件 getTeleportEvents()（★ 新版分页 API，替代上面那个）
 *
 * 【两个核心难点】
 *   ①**乐观并发控制**：服务端把每个 session 的日志当成一条链，客户端每次追加时
 *     要在 Last-Uuid 头里带上「我认为链尾是哪条」。对不上就返回 409，
 *     客户端再想办法「认领」服务端真正的链尾然后重试。
 *     为什么需要？因为**多个进程可能同时往同一个 session 写**
 *     （比如主进程 + subagent，或者上一个进程被 kill、它的请求还在飞）。
 *   ②**按 session 串行化**：同一个 session 的多次追加必须排队，
 *     否则并发请求会互相把对方的 Last-Uuid 顶掉，产生大量无谓的 409。
 *
 * 【本文件包含什么】
 *   - SessionIngressError：错误响应体类型。
 *   - lastUuidMap：模块级「sessionId → 最后一条 uuid」缓存（乐观锁的版本号）。
 *   - MAX_RETRIES / BASE_DELAY_MS：重试次数与退避基数。
 *   - sequentialAppendBySession：每个 session 一个串行化包装器。
 *   - getOrCreateSequentialAppend()：取（或建）串行化包装器。
 *   - appendSessionLogImpl()：★ 核心重试循环。
 *   - appendSessionLog()：对外写入口。
 *   - getSessionLogs() / getSessionLogsViaOAuth()：两个读接口。
 *   - TeleportEventsResponse / getTeleportEvents()：新版分页读取。
 *   - fetchSessionLogsFromUrl()：读的共享实现。
 *   - findLastUuid()：从日志里找最后一个带 uuid 的条目。
 *   - clearSession() / clearAllSessions()：清缓存。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `interface X { a?: string }`：interface 和 `type X = {...}` 基本等价，
 *      习惯上 interface 用于「对象形状」、type 用于「联合/交叉/工具类型」。
 *      `?` 表示可选字段。Java 类比：interface 就是 interface（但 TS 里可以有可选字段）。
 *   2. `import type { UUID } from 'crypto'`：只导入类型。UUID 是 Node 的类型别名（其实就是 string）。
 *      这种「给 string 起个语义别名」的写法叫 branded/alias type，编译后无开销。
 *   3. `new Map<string, UUID>()`：跟 Java HashMap 一样。
 *      `.get()` 返回 `V | undefined`（Java 的 get 返回 null），所以必须判空。
 *   4. `const sequentialAppendBySession: Map<string, (a, b, c) => Promise<boolean>> = new Map()`：
 *      ★ Map 的 value 类型是**一个函数类型**（这里是三个参数、返回 Promise<boolean> 的函数）。
 *      Java 类比：Map<String, TriFunction<...>>，但 Java 里函数不是一等公民，会写成接口。
 *      这就是 JS 的优势：函数能直接存进 Map、当参数传、当返回值。
 *   5. `validateStatus: status => status < 500`：
 *      ★ axios 的这个选项决定「哪些状态码算错误」。默认是 2xx 才算成功，
 *      这里改成「<500 都不抛异常」。为什么？因为 409/429 这些 4xx 是**业务流程的一部分**，
 *      我们要自己看状态码处理，不希望它直接 throw 进 catch。
 *      Java 类比：自己实现 ResponseErrorHandler。
 *   6. `for (let attempt = 1; attempt <= MAX_RETRIES; attempt++)`：
 *      手写重试循环（而不是用 withRetry 之类的通用封装），
 *      因为这里的重试逻辑很特殊：409 要先「认领服务端 uuid」再重试。
 *   7. `await sleep(delayMs)`：休眠。Java：Thread.sleep（但这里不阻塞线程，见下）。
 *      ★ JS 的 sleep 是基于 Promise 的，只挂起当前 async 函数，**不占用线程**。
 *      Java 里要用虚拟线程（Project Loom）才能做到同等开销。
 *   8. `error as AxiosError<SessionIngressError>`：断言成 axios 错误类型并带上响应体泛型，
 *      这样才能访问 .status / .message。≈ Java 的 (AxiosError) e 强转。
 *   9. `logs.at(-1)`：★ 取最后一个元素（负索引）。Java 的 list.get(size-1)。
 *      TS/JS 里 `.at(-1)` 比 `arr[arr.length-1]` 简洁，且不需要先判长度。
 *  10. `logs.findLast(e => 'uuid' in e && e.uuid)`：★ 从后往前找第一个满足条件的元素。
 *      Java 里要手写倒序循环（Guava 的 Lists.reverse 也只是倒序遍历）。
 *      `'uuid' in e` 是属性存在性检查（类型守卫）。
 *  11. `const { data, next_cursor } = response.data`：解构。
 *      `next_cursor` 是下划线命名（服务端 proto 字段），JS 侧沿用。
 *  12. `next_cursor == null`：★ 宽松相等，一次性覆盖 null 和 undefined 两种「没有」。
 *      注释里解释了为什么不能用 `=== undefined`：某些序列化器在流结束时会给出 null，
 *      严格判断会导致死循环。这是本文件很实在的一个踩坑记录。
 *  13. `let response` 然后在 try 里赋值：因为要在 try 外面继续用这个变量，
 *      所以先声明（不初始化）再赋值。TS 会自动推断类型为 `AxiosResponse | undefined`。
 *  14. `throw new Error('Your session has expired...')`：401 时抛给用户看的友好提示，
 *      调用方会把它显示出来引导用户重新登录。
 *  15. `while (pages < maxPages)`：分页循环 + 上限保护（防止服务端不推进 cursor 导致死循环）。
 *  16. `params: Record<string, string | number>`：值可以是 string 或 number 的字典。
 *      ≈ Map<String, Object>，但这里用联合类型精确到了两种可能。
 */
import axios, { type AxiosError } from 'axios'
import type { UUID } from 'crypto'
import { getOauthConfig } from '../../constants/oauth.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { sequential } from '../../utils/sequential.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getOAuthHeaders } from '../../utils/teleport/api.js'

// 服务端错误响应体：{ error: { message, type } }。
// 所有字段都可选，因为服务端不一定每次都给全。
interface SessionIngressError {
  error?: {
    message?: string
    type?: string
  }
}

// ★ 乐观锁的「版本号」缓存：sessionId → 我们最后一次成功写入的 entry uuid。
// 每次 PUT 时把它放进 Last-Uuid 头，服务端比对不一致就返回 409。
// 这是典型的乐观并发控制（OCC，Optimistic Concurrency Control），
// 跟数据库里 `UPDATE ... WHERE version = ?` 是同一个思路。
// Module-level state
const lastUuidMap: Map<string, UUID> = new Map()

// 最多重试 10 次。配合下面的指数退避，最长能撑几分钟。
const MAX_RETRIES = 10
// 退避基数 500ms，配合 2^(n-1) 增长，上限 8000ms。
const BASE_DELAY_MS = 500

// ★ 每个 session 一个串行化执行器。
// 为什么要串行？因为同一个 session 并发 PUT 时，两个请求会带**同一个** Last-Uuid，
// 服务端接受第一个之后，第二个必然 409。串行化从源头消除了这种无谓冲突。
// Per-session sequential wrappers to prevent concurrent log writes
const sequentialAppendBySession: Map<
  string,
  (
    entry: TranscriptMessage,
    url: string,
    headers: Record<string, string>,
  ) => Promise<boolean>
> = new Map()

/**
 * Gets or creates a sequential wrapper for a session
 * This ensures that log appends for a session are processed one at a time
 */
// 取（或首次创建）某个 session 的串行化包装器。
// `sequential()` 是一个工具函数：把任意 async 函数包成「串行执行」版本，
// 内部维护一个队列，前一个没完成就排队等着。Java 类比：单线程的 ExecutorService。
function getOrCreateSequentialAppend(sessionId: string) {
  let sequentialAppend = sequentialAppendBySession.get(sessionId)
  if (!sequentialAppend) {
    sequentialAppend = sequential(
      async (
        entry: TranscriptMessage,
        url: string,
        headers: Record<string, string>,
      ) => await appendSessionLogImpl(sessionId, entry, url, headers),
    )
    sequentialAppendBySession.set(sessionId, sequentialAppend)
  }
  return sequentialAppend
}

/**
 * Internal implementation of appendSessionLog with retry logic
 * Retries on transient errors (network, 5xx, 429). On 409, adopts the server's
 * last UUID and retries (handles stale state from killed process's in-flight
 * requests). Fails immediately on 401.
 */
// ★ 核心：带重试的日志追加。整体结构是一个 for 循环 + try/catch：
//   ①成功（200/201）→ 更新 lastUuid，返回 true；
//   ②409 冲突 → 想办法认领服务端真正的链尾，然后 continue 重试；
//   ③401 → 直接放弃（不可重试）；
//   ④其它 4xx / 网络错误 / 5xx → 退避后重试；
//   ⑤重试次数耗尽 → 返回 false。
async function appendSessionLogImpl(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
// 取出「我认为的链尾 uuid」，放进 Last-Uuid 头。
      const lastUuid = lastUuidMap.get(sessionId)
// `{ ...headers }`：复制一份再改，避免污染调用方传进来的 headers 对象（不可变习惯）。
      const requestHeaders = { ...headers }
      if (lastUuid) {
        requestHeaders['Last-Uuid'] = lastUuid
      }

      const response = await axios.put(url, entry, {
        headers: requestHeaders,
// ★ 关键配置：只有 5xx 才让 axios 抛异常。
// 4xx（409/429 等）要当成正常响应来处理，因为它们是业务流程的一部分。
        validateStatus: status => status < 500,
      })

      if (response.status === 200 || response.status === 201) {
// 写成功：把这次的 uuid 记为新的链尾，供下一次 PUT 使用。
        lastUuidMap.set(sessionId, entry.uuid)
        logForDebugging(
          `Successfully persisted session log entry for session ${sessionId}`,
        )
        return true
      }

// ===== 409 冲突处理（本文件最精妙的一段）=====
// 409 有三种可能，处理方式完全不同：
//   (a) 我这条其实**已经存成功**了，只是上次响应丢了 → 直接当成功；
//   (b) 别人（另一个进程/被 kill 的进程遗留的请求）推进了链 → 认领它的 uuid 再重试；
//   (c) 完全搞不清服务端状态 → 放弃。
      if (response.status === 409) {
        // Check if our entry was actually stored (server returned 409 but entry exists)
        // This handles the scenario where entry was stored but client received an error
        // response, causing lastUuidMap to be stale
// 服务端在 409 响应里会回一个 x-last-uuid 头，告诉我们它那边的链尾是谁。
        const serverLastUuid = response.headers['x-last-uuid']
// 情形 (a)：服务端链尾**就是**我刚发的这条 —— 说明我已经写进去了，
// 只是之前的响应没收到，导致本地 lastUuidMap 是脏的。这里做一次「恢复」。
        if (serverLastUuid === entry.uuid) {
          // Our entry IS the last entry on server - it was stored successfully previously
          lastUuidMap.set(sessionId, entry.uuid)
          logForDebugging(
            `Session entry ${entry.uuid} already present on server, recovering from stale state`,
          )
          logForDiagnosticsNoPII('info', 'session_persist_recovered_from_409')
          return true
        }

        // Another writer (e.g. in-flight request from a killed process)
        // advanced the server's chain. Try to adopt the server's last UUID
        // from the response header, or re-fetch the session to discover it.
// 情形 (b) 之一：服务端给了 x-last-uuid，直接认领它，下一轮带着新 uuid 重试。
        if (serverLastUuid) {
// `serverLastUuid as UUID`：响应头的值类型是 string，这里断言成 UUID 别名类型
// （运行时无差别，只是编译期语义标注）。
          lastUuidMap.set(sessionId, serverLastUuid as UUID)
          logForDebugging(
            `Session 409: adopting server lastUuid=${serverLastUuid} from header, retrying entry ${entry.uuid}`,
          )
// 情形 (b) 之二：服务端没给 x-last-uuid（比如老版本 v1 端点），
// 只能把整个 session 的日志拉回来，自己找出链尾。
        } else {
          // Server didn't return x-last-uuid (e.g. v1 endpoint). Re-fetch
          // the session to discover the current head of the append chain.
          const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)
          const adoptedUuid = findLastUuid(logs)
          if (adoptedUuid) {
            lastUuidMap.set(sessionId, adoptedUuid)
            logForDebugging(
// `logs!.length` 的 `!` 是★**非空断言**：告诉编译器「我确定 logs 不是 null」。
// ≈ Java 的强制解引用（如果真是 null，运行时照样炸；as 和 ! 都不做运行时检查）。
// 刚 await 完 fetchSessionLogsFromUrl 并且走到了 adoptedUuid 非空分支，所以这里安全。
              `Session 409: re-fetched ${logs!.length} entries, adopting lastUuid=${adoptedUuid}, retrying entry ${entry.uuid}`,
            )
          } else {
// 情形 (c)：实在判断不出服务端状态，记错误日志后放弃（返回 false）。
// 宁可丢这一条日志，也不要陷入无限重试。
            // Can't determine server state — give up
            const errorData = response.data as SessionIngressError
            const errorMessage =
// `|| ` 取兜底文案。注意这里用 `||` 而不是 `??`：
// 因为空字符串 '' 也应该被兜底掉（?? 只兜 null/undefined）。
              errorData.error?.message || 'Concurrent modification detected'
            logError(
              new Error(
                `Session persistence conflict: UUID mismatch for session ${sessionId}, entry ${entry.uuid}. ${errorMessage}`,
              ),
            )
            logForDiagnosticsNoPII(
              'error',
              'session_persist_fail_concurrent_modification',
            )
            return false
          }
        }
        logForDiagnosticsNoPII('info', 'session_persist_409_adopt_server_uuid')
// continue：回到循环开头，带着刚刚认领到的新 lastUuid 重试。
        continue // retry with updated lastUuid
      }

// 401：token 失效，**不可重试**（重试也没用，得让用户重新登录）。
      if (response.status === 401) {
        logForDebugging('Session token expired or invalid')
        logForDiagnosticsNoPII('error', 'session_persist_fail_bad_token')
        return false // Non-retryable
      }

// 其它 4xx（典型是 429 限流）：可重试，走下面的退避逻辑。
      // Other 4xx (429, etc.) - retryable
      logForDebugging(
        `Failed to persist session log: ${response.status} ${response.statusText}`,
      )
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: response.status,
        attempt,
      })
// 网络层错误、5xx：可重试。
    } catch (error) {
      // Network errors, 5xx - retryable
// `as AxiosError<SessionIngressError>`：断言后就能访问 .status / .message，
// 泛型参数让 response.data 也有类型。
      const axiosError = error as AxiosError<SessionIngressError>
      logError(new Error(`Error persisting session log: ${axiosError.message}`))
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: axiosError.status,
        attempt,
      })
    }

// 重试次数耗尽：记录一条诊断事件（供线上统计失败率），返回 false。
    if (attempt === MAX_RETRIES) {
      logForDebugging(`Remote persistence failed after ${MAX_RETRIES} attempts`)
      logForDiagnosticsNoPII(
        'error',
        'session_persist_error_retries_exhausted',
        { attempt },
      )
      return false
    }

// ★ 指数退避：500ms → 1s → 2s → 4s → 8s（封顶）→ 8s ...
// Math.pow(2, attempt-1) 是指数因子，Math.min 封顶在 8000ms。
// 为什么不一直指数增长？因为再长也没意义，反而会让日志延迟过大。
// Java 里通常写成 (long) Math.min(8000, 500L << (attempt-1))，注意移位要用 long。
    const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 8000)
    logForDebugging(
      `Remote persistence attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms…`,
    )
// await sleep()：只挂起当前 async 函数，不占线程（Java 的 Thread.sleep 会占线程）。
    await sleep(delayMs)
  }

  return false
}

/**
 * Append a log entry to the session using JWT token
 * Uses optimistic concurrency control with Last-Uuid header
 * Ensures sequential execution per session to prevent race conditions
 */
// 【对外写入口】拿 JWT → 拼头 → 交给串行化包装器执行。
export async function appendSessionLog(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
): Promise<boolean> {
// 拿不到 JWT 就直接返回 false：这类失败是「环境不具备条件」，不该记成错误。
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for session persistence')
    logForDiagnosticsNoPII('error', 'session_persist_fail_jwt_no_token')
    return false
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`,
    'Content-Type': 'application/json',
  }

  const sequentialAppend = getOrCreateSequentialAppend(sessionId)
  return sequentialAppend(entry, url, headers)
}

/**
 * Get all session logs for hydration
 */
// 读全量日志（用于 Web/移动端恢复会话）。
export async function getSessionLogs(
  sessionId: string,
  url: string,
): Promise<Entry[] | null> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for fetching session logs')
    logForDiagnosticsNoPII('error', 'session_get_fail_no_token')
    return null
  }

  const headers = { Authorization: `Bearer ${sessionToken}` }
  const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)

  if (logs && logs.length > 0) {
    // Update our lastUuid to the last entry's UUID
// ★ `.at(-1)` 取最后一个元素（负索引从末尾数）。等价于 logs[logs.length - 1]，
// 但不用先判断长度，为空时返回 undefined。
    const lastEntry = logs.at(-1)
// `'uuid' in lastEntry`：因为 Entry 是联合类型，不是每种 entry 都有 uuid
// （比如 SummaryMessage / TagMessage 没有），所以要先判断属性存在，
// 才能让 TS 允许访问 .uuid。这就是类型守卫。
    if (lastEntry && 'uuid' in lastEntry && lastEntry.uuid) {
      lastUuidMap.set(sessionId, lastEntry.uuid)
    }
  }

  return logs
}

/**
 * Get all session logs for hydration via OAuth
 * Used for teleporting sessions from the Sessions API
 */
// 用 OAuth（而不是 JWT）读取：这是给「teleport」（把会话从 Sessions API 迁移过来）用的。
export async function getSessionLogsViaOAuth(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const url = `${getOauthConfig().BASE_API_URL}/v1/session_ingress/session/${sessionId}`
  logForDebugging(`[session-ingress] Fetching session logs from: ${url}`)
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }
  const result = await fetchSessionLogsFromUrl(sessionId, url, headers)
  return result
}

/**
// ★ 新版分页 API 的响应结构。要点：
// - payload 就是完整的 Entry（服务端对 CLI 写的内容是不透明的，原样存原样返）；
// - next_cursor 为空就是「没有下一页了」，没有单独的 has_more 字段。
 * Response shape from GET /v1/code/sessions/{id}/teleport-events.
 * WorkerEvent.payload IS the Entry (TranscriptMessage struct) — the CLI
 * writes it via AddWorkerEvent, the server stores it opaque, we read it
 * back here.
 */
type TeleportEventsResponse = {
  data: Array<{
    event_id: string
    event_type: string
    is_compaction: boolean
    payload: Entry | null
    created_at: string
  }>
  // Unset when there are no more pages — this IS the end-of-stream
  // signal (no separate has_more field).
  next_cursor?: string
}

/**
 * Get worker events (transcript) via the CCR v2 Sessions API. Replaces
 * getSessionLogsViaOAuth once session-ingress is retired.
 *
 * The server dispatches per-session: Spanner for v2-native sessions,
 * threadstore for pre-backfill session_* IDs. The cursor is opaque to us —
 * echo it back until next_cursor is unset.
 *
 * Paginated (500/page default, server max 1000). session-ingress's one-shot
 * 50k is gone; we loop.
 */
// 【新版读取入口】替代 getSessionLogsViaOAuth，未来会完全取代 session-ingress。
// 相比老接口的两个变化：
//   ①**分页**（每页最多 1000），而老接口是一次性返回（上限 5 万条）；
//   ②cursor 对客户端是**不透明的**——我们只管原样回传，不解析它。
export async function getTeleportEvents(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const baseUrl = `${getOauthConfig().BASE_API_URL}/v1/code/sessions/${sessionId}/teleport-events`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

// 先声明再在 try 里赋值：因为 try 结束后还要用 response，
// 写在 try 内部的话作用域不够。TS 会推断成 `AxiosResponse | undefined`。
  logForDebugging(`[teleport] Fetching events from: ${baseUrl}`)

  const all: Entry[] = []
  let cursor: string | undefined
  let pages = 0

// ★ 无限循环保护：1000 条/页 × 100 页 = 10 万条。
// 注释里说明了动机：老接口一次性给 5 万条，这里给到 10 万的上限；
// 真撑到上限说明服务端没有推进 cursor，与其挂死不如带着已有数据退出。
  // Infinite-loop guard: 1000/page × 100 pages = 100k events. Larger than
  // session-ingress's 50k one-shot. If we hit this, something's wrong
  // (server not advancing cursor) — bail rather than hang.
  const maxPages = 100

  while (pages < maxPages) {
    const params: Record<string, string | number> = { limit: 1000 }
    if (cursor !== undefined) {
      params.cursor = cursor
    }

    let response
    try {
      response = await axios.get<TeleportEventsResponse>(baseUrl, {
        headers,
        params,
        timeout: 20000,
        validateStatus: status => status < 500,
      })
    } catch (e) {
      const err = e as AxiosError
      logError(new Error(`Teleport events fetch failed: ${err.message}`))
      logForDiagnosticsNoPII('error', 'teleport_events_fetch_fail')
      return null
    }

// ★ 404 的处理很讲究，注释里讲了一个迁移期的两难：
// 在迁移窗口内，404 有两种完全不同的含义：
//   (a) session 真的不存在；
//   (b) 端点还没部署 / 该 session 还没回填到新存储；
// 单看响应区分不出来。解决办法是返回 null，让调用方**回退到老的 session-ingress**，
// 由老接口去分辨——它对 (a) 返回空、对 (b) 返回数据。
// 而如果是在**翻页中途**（pages > 0）遇到 404，那说明 session 被删了，
// 此时返回已经拿到的部分即可。
    if (response.status === 404) {
      // 404 on page 0 is ambiguous during the migration window:
      //   (a) Session genuinely not found (not in Spanner AND not in
      //       threadstore) — nothing to fetch.
      //   (b) Route-level 404: endpoint not deployed yet, or session is
      //       a threadstore session not yet backfilled into Spanner.
      // We can't tell them apart from the response alone. Returning null
      // lets the caller fall back to session-ingress, which will correctly
      // return empty for case (a) and data for case (b). Once the backfill
      // is complete and session-ingress is gone, the fallback also returns
      // null → same "Failed to fetch session logs" error as today.
      //
      // 404 mid-pagination (pages > 0) means session was deleted between
      // pages — return what we have.
      logForDebugging(
        `[teleport] Session ${sessionId} not found (page ${pages})`,
      )
      logForDiagnosticsNoPII('warn', 'teleport_events_not_found')
// 三元运算符：第 0 页返回 null（触发回退），中途返回已累积的结果。
      return pages === 0 ? null : all
    }

// 401 直接抛异常（而不是返回 null）：token 失效是必须让用户知道并重新登录的，
// 静默失败会让人莫名其妙。
    if (response.status === 401) {
      logForDiagnosticsNoPII('error', 'teleport_events_bad_token')
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }

    if (response.status !== 200) {
      logError(
        new Error(
          `Teleport events returned ${response.status}: ${jsonStringify(response.data)}`,
        ),
      )
      logForDiagnosticsNoPII('error', 'teleport_events_bad_status')
      return null
    }

    const { data, next_cursor } = response.data
// 防御性校验：即使 HTTP 200，响应体也可能不是预期的数组。
// 运行时校验在这里是必要的——TS 的泛型不做任何运行时检查。
    if (!Array.isArray(data)) {
      logError(
        new Error(
          `Teleport events invalid response shape: ${jsonStringify(response.data)}`,
        ),
      )
      logForDiagnosticsNoPII('error', 'teleport_events_invalid_shape')
      return null
    }

    // payload IS the Entry. null payload happens for threadstore non-generic
    // events (server skips them) or encryption failures — skip here too.
// payload 为 null 要跳过：threadstore 的非 generic 事件、或解密失败时服务端会给 null。
    for (const ev of data) {
      if (ev.payload !== null) {
        all.push(ev.payload)
      }
    }

    pages++
// ★ 这里用 `== null` 而不是 `=== undefined`，注释解释得很清楚：
// proto 在流结束时会**省略**该字段（undefined），但某些序列化器会给成 null。
// 如果只判 undefined，遇到 null 就会把 cursor 设成 null，
// 拼进 query string 变成 "null" 字符串，服务端要么拒绝要么原样回显 —— 死循环。
// 这是很实在的一个线上踩坑记录。
    // == null covers both `null` and `undefined` — the proto omits the
    // field at end-of-stream, but some serializers emit `null`. Strict
    // `=== undefined` would loop forever on `null` (cursor=null in query
    // params stringifies to "null", which the server rejects or echoes).
    if (next_cursor == null) {
      break
    }
    cursor = next_cursor
  }

// 触达页上限：不失败，返回已有的（截断的 transcript 也比完全没有强）。
  if (pages >= maxPages) {
    // Don't fail — return what we have. Better to teleport with a
    // truncated transcript than not at all.
    logError(
      new Error(`Teleport events hit page cap (${maxPages}) for ${sessionId}`),
    )
    logForDiagnosticsNoPII('warn', 'teleport_events_page_cap')
  }

  logForDebugging(
    `[teleport] Fetched ${all.length} events over ${pages} page(s) for ${sessionId}`,
  )
  return all
}

/**
 * Shared implementation for fetching session logs from a URL
 */
// 两个读接口（JWT 版和 OAuth 版）共享的底层实现。
async function fetchSessionLogsFromUrl(
  sessionId: string,
  url: string,
  headers: Record<string, string>,
): Promise<Entry[] | null> {
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 20000,
      validateStatus: status => status < 500,
// 用环境变量决定是否只在「最后一次压缩之后」拉日志（省流量）。
      params: isEnvTruthy(process.env.CLAUDE_AFTER_LAST_COMPACT)
        ? { after_last_compact: true }
        : undefined,
    })

    if (response.status === 200) {
      const data = response.data

      // Validate the response structure
// 运行时结构校验：必须是个对象，且 loglines 是数组。
      if (!data || typeof data !== 'object' || !Array.isArray(data.loglines)) {
        logError(
          new Error(
            `Invalid session logs response format: ${jsonStringify(data)}`,
          ),
        )
        logForDiagnosticsNoPII('error', 'session_get_fail_invalid_response')
        return null
      }

// `data.loglines as Entry[]`：断言（运行时不检查），配合上面的 Array.isArray 使用。
      const logs = data.loglines as Entry[]
      logForDebugging(
        `Fetched ${logs.length} session logs for session ${sessionId}`,
      )
      return logs
    }

// 404 在**读取**场景是正常的：新 session 本来就没有日志，返回空数组而不是 null。
    if (response.status === 404) {
      logForDebugging(`No existing logs for session ${sessionId}`)
      logForDiagnosticsNoPII('warn', 'session_get_no_logs_for_session')
      return []
    }

    if (response.status === 401) {
      logForDebugging('Auth token expired or invalid')
      logForDiagnosticsNoPII('error', 'session_get_fail_bad_token')
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }

    logForDebugging(
      `Failed to fetch session logs: ${response.status} ${response.statusText}`,
    )
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: response.status,
    })
    return null
  } catch (error) {
    const axiosError = error as AxiosError<SessionIngressError>
    logError(new Error(`Error fetching session logs: ${axiosError.message}`))
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: axiosError.status,
    })
    return null
  }
}

/**
 * Walk backward through entries to find the last one with a uuid.
 * Some entry types (SummaryMessage, TagMessage) don't have one.
 */
// 从后往前找最后一个带 uuid 的条目。
// findLast 是 ES2023 的数组方法，Java 里要手写倒序循环。
function findLastUuid(logs: Entry[] | null): UUID | undefined {
  if (!logs) {
    return undefined
  }
  const entry = logs.findLast(e => 'uuid' in e && e.uuid)
// entry && 'uuid' in entry ? (entry.uuid as UUID) : undefined —— 三元 + 类型守卫 + 断言组合。
  return entry && 'uuid' in entry ? (entry.uuid as UUID) : undefined
}

/**
 * Clear cached state for a session
 */
// 清掉单个 session 的缓存（uuid 版本号 + 串行化器）。
export function clearSession(sessionId: string): void {
  lastUuidMap.delete(sessionId)
  sequentialAppendBySession.delete(sessionId)
}

/**
 * Clear all cached session state (all sessions).
 * Use this on /clear to free sub-agent session entries.
 */
// 清空全部（/clear 命令时调用，顺便释放 subagent 的条目）。
export function clearAllSessions(): void {
  lastUuidMap.clear()
  sequentialAppendBySession.clear()
}
