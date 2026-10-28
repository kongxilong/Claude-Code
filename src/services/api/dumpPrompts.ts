/**
 * 【一句话定位】调试工具：把发给 Claude 模型的**完整请求体**和**响应**转存到磁盘
 *           （~/.claude/dump-prompts/<sessionId>.jsonl），供 `/issue` 命令上报问题时附带。
 *
 * 【在架构中的位置】
 *   调用链：src/query.ts（构造 API client 时）
 *           → 本文件 createDumpPromptsFetch(agentIdOrSessionId)
 *             → 返回一个**自定义的 fetch 函数**，被塞进 Anthropic SDK 的 ClientOptions['fetch']
 *           → 之后 SDK 每一次 HTTP 请求都会经过这个包装过的 fetch
 *             → dumpRequest()（解析并落盘请求体）
 *             → globalThis.fetch（真正的网络请求）
 *             → 响应回来后异步克隆并落盘（SSE 流也会被拼回去）
 *   落盘路径由 getDumpPromptsPath() 决定，格式是 JSONL（每行一个 JSON 对象）。
 *
 * 【为什么这样实现】
 *   它是靠**替换 SDK 的 fetch** 来拦截的，而不是在业务代码里到处插桩。
 *   这是典型的装饰器/代理模式：给 SDK 传一个「长得像 fetch 但会顺手记日志」的函数，
 *   SDK 完全无感知。Java 类比：给 HttpClient 装一个 Interceptor / Filter。
 *   另外，它还缓存最近 5 次请求到内存（getLastApiRequests），供 /issue 直接取用。
 *
 * 【本文件包含什么】
 *   - hashString()：SHA-256，用于判断请求头（system/tools）是否变化。
 *   - cachedApiRequests + MAX_CACHED_REQUESTS：内存里最近 5 次请求。
 *   - DumpState / dumpState：每个 session 的落盘状态（是否已初始化、见过几条消息等）。
 *   - getLastApiRequests() / clearApiRequestCache() / clearDumpState() / clearAllDumpState()：缓存与状态管理。
 *   - addApiRequestToCache()：往内存缓存里加一条。
 *   - getDumpPromptsPath()：落盘文件路径。
 *   - appendToFile()：异步追加写文件（失败静默）。
 *   - initFingerprint()：请求体的「廉价指纹」，用于跳过昂贵的序列化。
 *   - dumpRequest()：解析请求体并生成要写盘的 JSONL 行。
 *   - createDumpPromptsFetch()：★ 核心，产出包装后的 fetch。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `ClientOptions['fetch']`：**索引访问类型**——取 ClientOptions 类型里 fetch 属性的类型。
 *      ≈ Java 的反射取字段类型，只不过在编译期、用类型系统完成。
 *      好处：SDK 改了 fetch 签名，这里自动跟着变，不会写死。
 *   2. `Array<{ timestamp: string; request: unknown }>`：数组里放匿名对象类型。
 *      ≈ Java 的 List<匿名 record>。
 *   3. `unknown` 类型：比 any 安全的「我不知道是什么」。
 *      any 允许你随便用（跳过所有检查），unknown **必须先做类型判断才能用**。
 *      ≈ Java 的 Object，要 instanceof + 强转之后才能调方法。
 *   4. `new Map<string, DumpState>()`：跟 Java 的 HashMap 一样。
 *   5. `req.tools as Array<{name?: string}> | undefined`：`as` ≈ 强制类型转换（编译期，无运行时检查）。
 *   6. `const { messages: _, ...initData } = req`：★ 剩余解构 + **改名**。
 *      `messages: _` 表示把 messages 取出来存到变量 `_`（下划线 = 约定「不用」），
 *      其余字段打包进 initData。效果：从对象里「删掉」一个字段的不可变写法。
 *   7. `setImmediate(fn, arg1, arg2, ...)`：Node 的「下一个事件循环立刻执行」，
 *      ≈ Java 的 executor.submit，但更即时。这里用来把重活挪出关键路径。
 *   8. `response.clone()`：HTTP Response 的 body 是**一次性流**，读过就没了。
 *      clone() 复制出一份独立流，让调试代码读副本、业务代码读原件。
 *      Java 里没有这个概念（InputStream 也要自己 buffer 才能读两次）。
 *   9. `cloned.body.getReader()` + `await reader.read()`：
 *      ★ 这是 ReadableStream 的手工读法。`{ done, value }` 是标准的 Reader 结果。
 *      Java 类比：InputStream.read(byte[]) 循环到 -1。value 是 Uint8Array（字节块）。
 *      （claude.ts 里用的是 async generator 的自动版，这里是手工版，可以对照看。）
 *  10. `decoder.decode(value, { stream: true })`：把字节块解成字符串。
 *      stream:true 表示「后面还有更多块」，让多字节字符（比如中文）不会在块边界被截断。
 *      Java 类比：用 CharsetDecoder 而不是每次 new String(bytes)。
 *  11. `finally { reader.releaseLock() }`：finally 保证一定释放，≈ try-with-resources。
 *  12. `void (async () => {...})()`：IIFE + void，表示「启动一个后台异步任务，不等它」。
 *  13. `catch { }`（不带参数）：optional catch binding，忽略错误对象。
 *  14. `fs.mkdir(...).then(...).catch(() => {})`：Promise 链，末尾 catch 空实现 = 静默失败。
 *      Java 类比：CompletableFuture 链 + exceptionally(e -> null)。
 */
import type { ClientOptions } from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

// SHA-256 摘要。用途不是安全，而是「内容有没有变」的廉价比较：
// 比较两个 64 字符的哈希，比比较两个几 MB 的字符串快得多。
function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex')
}

// 内存里只保留最近 5 条：这是给 /issue 命令用的（用户报 bug 时把最近的请求贴上去）。
// 保留 5 条而不是 1 条，是因为出问题时往往要看「前几轮」才能定位。
// Cache last few API requests for ant users (e.g., for /issue command)
const MAX_CACHED_REQUESTS = 5
const cachedApiRequests: Array<{ timestamp: string; request: unknown }> = []

// 每个 session 一份状态，存在模块级 Map 里（JS 模块是单例，≈ Java static 字段）。
type DumpState = {
  initialized: boolean
// messageCountSeen：已经写过多少条 message 了。
// 下次只写「新增的那部分」——避免每轮对话就把全部历史重写一遍（文件会爆炸）。
  messageCountSeen: number
  lastInitDataHash: string
// ★ lastInitFingerprint 是性能优化的关键：
// 每轮请求都带 system prompt + 全部工具 schema，加起来几 MB，
// 把它 JSON.stringify 再算哈希要几百毫秒。而实际上这些「头部数据」几乎每轮都一样。
// 所以先算一个超便宜的指纹（模型名 + 工具名 + system 长度），
// 指纹没变就跳过昂贵的 stringify —— 这就是注释里说的「省掉 300ms」。
  // Cheap proxy for change detection — skips the expensive stringify+hash
  // when model/tools/system are structurally identical to the last call.
  lastInitFingerprint: string
}

// Track state per session to avoid duplicating data
const dumpState = new Map<string, DumpState>()

// `[...cachedApiRequests]`：数组展开 = 浅拷贝。
// 返回副本而不是原数组，是为了防止调用方误改内部状态（防御式拷贝）。
// Java：return new ArrayList<>(list);
export function getLastApiRequests(): Array<{
  timestamp: string
  request: unknown
}> {
  return [...cachedApiRequests]
}

// `arr.length = 0`：清空数组的最快写法（比 arr = [] 好，因为它保留了原引用）。
// Java 没有对应写法（list.clear() 倒是一样）。
export function clearApiRequestCache(): void {
  cachedApiRequests.length = 0
}

export function clearDumpState(agentIdOrSessionId: string): void {
  dumpState.delete(agentIdOrSessionId)
}

export function clearAllDumpState(): void {
  dumpState.clear()
}

// 只有 ant（内部用户）才收集：这是给内部排障用的开关，不对外开启。
export function addApiRequestToCache(requestData: unknown): void {
  if (process.env.USER_TYPE !== 'ant') return
  cachedApiRequests.push({
    timestamp: new Date().toISOString(),
    request: requestData,
  })
// 超过上限就丢最老的一条。shift() 移除数组第一个元素（Java：list.remove(0)），
// 配合 push 构成一个定长环形缓冲的简化版。
  if (cachedApiRequests.length > MAX_CACHED_REQUESTS) {
    cachedApiRequests.shift()
  }
}

// 落盘路径：~/.claude/dump-prompts/<sessionId>.jsonl。
// 用 .jsonl（JSON Lines）而不是 .json：流式追加写，每行独立一个 JSON，
// 即使进程被 kill 掉，已经写的行依然是合法可解析的。
// `agentIdOrSessionId ?? getSessionId()`：没传就用当前 session（?? 只在 null/undefined 时兜底）。
export function getDumpPromptsPath(agentIdOrSessionId?: string): string {
  return join(
    getClaudeConfigHomeDir(),
    'dump-prompts',
    `${agentIdOrSessionId ?? getSessionId()}.jsonl`,
  )
}

// 异步追加写：mkdir -p 然后 appendFile，全程不 await，失败静默。
// 这是调试工具应有的姿态——绝不能因为记日志把主流程搞挂。
function appendToFile(filePath: string, entries: string[]): void {
  if (entries.length === 0) return
  fs.mkdir(dirname(filePath), { recursive: true })
    .then(() => fs.appendFile(filePath, entries.join('\n') + '\n'))
    .catch(() => {})
}

// 廉价指纹 = 模型名 | 工具名列表 | system 内容总长度。
// 三者都变了才算「真的变了」；长度相同但内容不同属于极小概率，
// 而下一层还有哈希兜底（指纹变了才去算哈希），所以不会漏。
function initFingerprint(req: Record<string, unknown>): string {
  const tools = req.tools as Array<{ name?: string }> | undefined
  const system = req.system as unknown[] | string | undefined
// system 可能是字符串，也可能是分块数组（[{type:'text',text:'...'}, ...]），
// 所以两种形状都要处理。这就是 TS 里 `unknown[] | string | undefined` 联合类型的典型场景。
  const sysLen =
    typeof system === 'string'
      ? system.length
      : Array.isArray(system)
        ? system.reduce(
// reduce 累加各块的文本长度。Java：stream.mapToInt(...).sum()。
// `(b as {text?: string}).text?.length ?? 0` 是三层防御：先断言类型、再可选链、再兜 0。
            (n: number, b) => n + ((b as { text?: string }).text?.length ?? 0),
            0,
          )
        : 0
  const toolNames = tools?.map(t => t.name ?? '').join(',') ?? ''
  return `${req.model}|${toolNames}|${sysLen}`
}

// 解析请求体并产出要写盘的 JSONL 行。注意它跑在 setImmediate 里（后台）。
function dumpRequest(
  body: string,
  ts: string,
  state: DumpState,
  filePath: string,
): void {
  try {
    const req = jsonParse(body) as Record<string, unknown>
    addApiRequestToCache(req)

// 第二个门禁：只有内部用户才写盘（内存缓存则是所有用户都加，因为成本极低）。
    if (process.env.USER_TYPE !== 'ant') return
    const entries: string[] = []
    const messages = (req.messages ?? []) as Array<{ role?: string }>

    // Write init data (system, tools, metadata) on first request,
    // and a system_update entry whenever it changes.
    // Cheap fingerprint first: system+tools don't change between turns,
    // so skip the 300ms stringify when the shape is unchanged.
// ★ 先算廉价指纹，只有指纹变了才做昂贵的 stringify + hash。
// 这是本文件最重要的性能优化：把「每轮几百毫秒」降到「几乎为零」。
    const fingerprint = initFingerprint(req)
    if (!state.initialized || fingerprint !== state.lastInitFingerprint) {
// ★ `const { messages: _, ...initData } = req`：
// 取走 messages（存进名为 _ 的变量，约定表示不用），剩下的打包成 initData。
// 这是「不可变地删除一个字段」的惯用写法。
// 为什么要删？因为 messages 单独处理（下面增量写），头部数据才整块写。
      const { messages: _, ...initData } = req
      const initDataStr = jsonStringify(initData)
      const initDataHash = hashString(initDataStr)
      state.lastInitFingerprint = fingerprint
// 第一次：写一条 type=init，包含 system/tools/metadata 等全部头部数据。
      if (!state.initialized) {
        state.initialized = true
        state.lastInitDataHash = initDataHash
// 直接拼接 JSON 字符串（`"data":${initDataStr}`）而不是再包一层对象重新序列化，
// 省掉一次几 MB 的 stringify。前提是 timestamp 来自 toISOString()，不含需要转义的字符，
// 所以手工拼是安全的。
        // Reuse initDataStr rather than re-serializing initData inside a wrapper.
        // timestamp from toISOString() contains no chars needing JSON escaping.
        entries.push(
          `{"type":"init","timestamp":"${ts}","data":${initDataStr}}`,
        )
// 指纹变了、但哈希没变 → 说明只是长度/顺序之类的抖动，不写；
// 哈希也变了 → 写一条 type=system_update（比如中途换了工具集或 system prompt）。
      } else if (initDataHash !== state.lastInitDataHash) {
        state.lastInitDataHash = initDataHash
        entries.push(
          `{"type":"system_update","timestamp":"${ts}","data":${initDataStr}}`,
        )
      }
    }

// 增量写：只写 `slice(messageCountSeen)` 之后的**新**消息。
// assistant 消息不在这里写——它们在响应里捕获（见下面的 response 落盘）。
    // Write only new user messages (assistant messages captured in response)
    for (const msg of messages.slice(state.messageCountSeen)) {
      if (msg.role === 'user') {
        entries.push(
          jsonStringify({ type: 'message', timestamp: ts, data: msg }),
        )
      }
    }
// 更新游标，下一轮从这里继续。
    state.messageCountSeen = messages.length

    appendToFile(filePath, entries)
// 空 catch（不带参数）：解析失败就整轮跳过，调试工具不该影响主流程。
  } catch {
    // Ignore parsing errors
  }
}

// ★ 核心工厂函数：产出一个「长得像 fetch 但会顺手落盘」的函数。
// 返回的这个函数会被塞进 Anthropic SDK 的 ClientOptions.fetch，
// 于是 SDK 发的每一次请求都自动被记录，业务代码零侵入。
// Java 类比：OkHttp 的 Interceptor / Servlet 的 Filter，或者动态代理。
export function createDumpPromptsFetch(
  agentIdOrSessionId: string,
): ClientOptions['fetch'] {
  const filePath = getDumpPromptsPath(agentIdOrSessionId)

// 返回的是一个 async 箭头函数，签名跟标准 fetch 一致（input + init）。
// `init?: RequestInit` 的 `?` 表示可选参数。
  return async (input: RequestInfo | URL, init?: RequestInit) => {
// 每个 session 一份状态，首次调用时初始化一个默认状态并放进 Map。
// `?? {...}` 表示「取不到就用这个默认值」。
    const state = dumpState.get(agentIdOrSessionId) ?? {
      initialized: false,
      messageCountSeen: 0,
      lastInitDataHash: '',
      lastInitFingerprint: '',
    }
    dumpState.set(agentIdOrSessionId, state)

    let timestamp: string | undefined

// 只处理 POST（真的在发请求的那次）；GET 之类直接放行。
    if (init?.method === 'POST' && init.body) {
// 时间戳在这里就取好（请求发出前），保证请求行和响应行能对上。
      timestamp = new Date().toISOString()
      // Parsing + stringifying the request (system prompt + tool schemas = MBs)
      // takes hundreds of ms. Defer so it doesn't block the actual API call —
      // this is debug tooling for /issue, not on the critical path.
// ★ setImmediate：把重活（解析 + 序列化几 MB 的请求体）推到下一个事件循环，
// 让真正的网络请求**立刻**发出去。这是关键路径优化的常见手法：
// 调试代码绝不能拖慢真实请求。Java 类比：丢给另一个线程池去慢慢做。
      setImmediate(dumpRequest, init.body as string, timestamp, state, filePath)
    }

    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
// 真正的网络请求。注意：前面所有的落盘准备工作都没有 await，所以到这里是零延迟。
    const response = await globalThis.fetch(input, init)

    // Save response async
// 响应也存一份（同样只对内部用户）。注意判断 response.ok——错误响应不存。
    if (timestamp && response.ok && process.env.USER_TYPE === 'ant') {
// ★ response.clone()：Response 的 body 是一次性流，读一次就废了。
// 必须克隆一份给调试代码读，原件留给业务代码继续正常消费。
      const cloned = response.clone()
      void (async () => {
        try {
// SSE 的标识是 content-type: text/event-stream。
// 流式响应和非流式响应要分开处理（下面两个分支）。
          const isStreaming = cloned.headers
            .get('content-type')
            ?.includes('text/event-stream')

          let data: unknown
          if (isStreaming && cloned.body) {
            // Parse SSE stream into chunks
// ★ 手工读 ReadableStream：getReader() 拿到 reader，循环 read() 直到 done。
// Java 类比：while ((n = in.read(buf)) != -1)，value 相当于读到的那段字节。
            const reader = cloned.body.getReader()
// TextDecoder 把字节解成字符串。{ stream: true } 表示「还有后续块」，
// 这样跨块边界的多字节字符（中文/emoji）不会被拆坏。
            const decoder = new TextDecoder()
            let buffer = ''
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
              }
// releaseLock 放在 finally 里，保证无论如何都释放（≈ try-with-resources）。
            } finally {
              reader.releaseLock()
            }
            const chunks: unknown[] = []
// SSE 格式：`event: xxx\ndata: {...}\n\n`，事件之间用**空行**分隔。
// 所以先 split('\n\n') 切成事件，再在每个事件里逐行找 data: 开头的行。
            for (const event of buffer.split('\n\n')) {
              for (const line of event.split('\n')) {
// data: [DONE] 是 SSE 的结束信号，不是数据，要跳过。
// `line.slice(6)` 去掉 'data: ' 这 6 个字符再 JSON 解析。
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    chunks.push(jsonParse(line.slice(6)))
                  } catch {
                    // Ignore parse errors
                  }
                }
              }
            }
// 存成一个 { stream: true, chunks: [...] } 结构，保留事件顺序。
            data = { stream: true, chunks }
          } else {
// 非流式：直接当成 JSON 解析。注意这里是 await（在后台任务里，不阻塞主流程）。
            data = await cloned.json()
          }

          await fs.appendFile(
            filePath,
            jsonStringify({ type: 'response', timestamp, data }) + '\n',
          )
// best effort：任何一步失败都放弃这一轮的响应记录，不影响业务。
        } catch {
          // Best effort
        }
      })()
    }

// 必须原样返回原始 response（不是 clone），否则业务代码读不到流式数据。
    return response
  }
}
