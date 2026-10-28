/**
 * ============================================================================
 *  【文件总览】src/tools/WebFetchTool/utils.ts —— WebFetch 的「真正干活的地方」
 * ============================================================================
 *
 *  【一句话定位】
 *  把「一个 URL」变成「一段 markdown 文本」的完整流水线：
 *      校验 URL → 查缓存 → 问域名黑名单 → 发 HTTP（手动处理重定向）
 *      → HTML 转 markdown → 存缓存 →（可选）让小模型读一遍
 *  本文件是 WebFetch 工具 90% 的实际逻辑所在；WebFetchTool.ts 只负责"包装成工具"。
 *
 *  【在架构中的位置】
 *      模型调用 WebFetch
 *        └─> WebFetchTool.call()                    ← WebFetchTool.ts（工具壳）
 *              ├─> getURLMarkdownContent()          ← ★ 本文件（抓 + 转 markdown）
 *              │     ├─> validateURL()              ← ★ 本文件（URL 合法性）
 *              │     ├─> checkDomainBlocklist()     ← ★ 本文件（问 api.anthropic.com）
 *              │     ├─> getWithPermittedRedirects()← ★ 本文件（自己管重定向）
 *              │     │     └─> isPermittedRedirect()← ★ 本文件（重定向是否安全）
 *              │     └─> getTurndownService()       ← ★ 本文件（HTML → markdown）
 *              └─> applyPromptToMarkdown()          ← ★ 本文件（让 Haiku 总结）
 *                    └─> makeSecondaryModelPrompt() ← prompt.ts
 *                    └─> queryHaiku()               ← src/services/api/claude.ts
 *
 *  【本文件包含什么】
 *   1. 三个自定义错误类：DomainBlockedError / DomainCheckFailedError / EgressBlockedError
 *   2. 两级缓存：URL_CACHE（URL 级，15 分钟）+ DOMAIN_CHECK_CACHE（域名级，5 分钟）
 *   3. getTurndownService()   HTML→markdown 转换器的懒加载单例
 *   4. validateURL()          URL 合法性（长度、凭据、可解析性）
 *   5. checkDomainBlocklist() 向 api.anthropic.com 查询该域名是否可抓
 *   6. isPermittedRedirect() / getWithPermittedRedirects()  安全的重定向处理
 *   7. getURLMarkdownContent()  主流程（上面整条流水线）
 *   8. applyPromptToMarkdown()  把 markdown 交给小模型做萃取
 *
 *  【必须理解的三条设计主线】
 *  (A) **安全**：不自动跟随跨站重定向（防 open redirect）、URL 里带用户名密码拒绝、
 *      域名要过黑名单、限制响应体大小与重定向跳数（防资源耗尽 DoS）。
 *      这些限制不是拍脑袋定的，注释里多次出现 "Per PSR:" —— 指产品安全评审
 *      （Product Security Review）提出的硬性要求。
 *  (B) **性能/成本**：两级缓存避免重复抓与重复预检；turndown 懒加载（它带 1.4MB
 *      依赖，没必要为不抓网页的会话付启动代价）；抓完立刻把 axios 持有的
 *      ArrayBuffer 置 null，好让 GC 能在构建 DOM 树前回收最多 10MB。
 *  (C) **上下文成本**：网页转 markdown 后交给便宜的小模型（Haiku）萃取，
 *      而不是把整页塞进主模型上下文——这是 WebFetch 能实用的关键。
 *
 *  【TS 语法速查】（本文件实际出现的，按出现顺序）
 *   - `class X extends Error`           自定义异常，≈ Java 的 extends RuntimeException
 *   - `constructor(public readonly domain: string)`
 *                                       **参数属性**：构造函数参数前加 public/readonly，
 *                                       TS 会自动生成同名字段并赋值。
 *                                       ≈ Java 的 record / Lombok @Value 的简写
 *   - `super(...)`                      调父类构造函数，和 Java 一样必须第一行
 *   - `type X = { a: string; b?: number }`  结构化类型。≈ Java 的 record/class，
 *                                       但**按结构匹配（鸭子类型）**，不需要 implements。
 *                                       `b?: number` = 可选，等价于 `number | undefined`
 *   - `A | B` 联合类型                  ≈ Java 的 sealed interface 的两个实现，但轻量得多
 *   - `type R = { status: 'allowed' } | { status: 'blocked' } | {...}`
 *                                       **可辨识联合（discriminated union）**：
 *                                       靠 `status` 这个字面量字段区分，配合 switch
 *                                       TS 能自动收窄类型 ≈ Java 的 switch 模式匹配
 *   - `?.` 可选链                        `a?.b?.c` ≈ `a != null && a.b != null ? a.b.c : null`
 *   - `??` 空值合并                      `a ?? b` 仅当 a 是 null/undefined 时取 b。
 *                                       ⚠️ 与 `||` 不同：`0` 和 `''` 不会被 `??` 换掉
 *                                       （本文件 `response.headers['content-type'] ?? ''` 就是这用法）
 *   - `!` 非空断言                       `contentBlock!.text` = "我保证非空，编译器别管"。
 *                                       ≈ Java 的 `(Foo) x` 强转，运行时不检查
 *   - `as X` / `as unknown as X`        类型断言 ≈ 强制转换；`as unknown as` 是
 *                                       "先转成 unknown 再转目标类型"，用于两者类型
 *                                       差别太大、编译器不让直接转的场合
 *   - `x is T` 类型谓词                 返回 boolean 但能**收窄**类型。
 *                                       ≈ Java 的 `if (o instanceof Foo f)`
 *   - `typeof import('turndown')`       **类型层面的 import**：只在编译期取类型，
 *                                       不产生任何运行时代码
 *   - `x ??= v`                         逻辑赋值：仅当 x 是 null/undefined 时才赋 v。
 *                                       ≈ Java 的 `if (x == null) x = v`（惰性单例惯用法）
 *   - `Promise<T>` / `async` / `await`  ≈ Java 的 CompletableFuture<T>
 *   - `60_000`                          数字分隔符，和 Java 的 `60_000` 一样，只是好看
 *   - `new Set([...])` `Array.includes` `String.startsWith`  与 Java 同名同义
 *   - `try { } catch { }`               捕获时省略绑定名（本文件多处）
 *                                       ≈ Java 的 catch 但要有个变量名，TS 可以不写
 *   - `e instanceof X`                  和 Java 的 instanceof 一样
 *   - `switch (x) { case 'a': ... }`    和 Java 一样，注意每个 case 里的 break
 * ============================================================================
 */
import axios, { type AxiosResponse } from 'axios'
import { LRUCache } from 'lru-cache'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { queryHaiku } from '../../services/api/claude.js'
import { AbortError } from '../../utils/errors.js'
import { getWebFetchUserAgent } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import {
  isBinaryContentType,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { isPreapprovedHost } from './preapproved.js'
import { makeSecondaryModelPrompt } from './prompt.js'

// 中文补充：下面三个自定义异常，存在的唯一目的是**区分「该给用户看的失败」和
// 「内部错误」**。在 getURLMarkdownContent 里会靠 `e instanceof DomainBlockedError`
// 判断：是这两种就原样往上抛（UI 显示成红色错误气泡），否则 logError 记内部日志。
// ≈ Java 里为不同业务语义各建一个 extends RuntimeException 的异常类。
// Custom error classes for domain blocking
class DomainBlockedError extends Error {
  constructor(domain: string) {
    super(`Claude Code is unable to fetch from ${domain}`)
    this.name = 'DomainBlockedError'
  }
}

class DomainCheckFailedError extends Error {
  constructor(domain: string) {
    super(
      `Unable to verify if domain ${domain} is safe to fetch. This may be due to network restrictions or enterprise security policies blocking claude.ai.`,
    )
    this.name = 'DomainCheckFailedError'
  }
}

class EgressBlockedError extends Error {
  constructor(public readonly domain: string) {
    // 用 JSON 字符串当 message，是为了让调用方能从文本里稳定解析出
    // error_type / domain，从而把「出口代理拦截」当成一个专门类别处理，
    // 而不是当成普通网络错误。≈ Java 里定义错误码枚举 + 结构化 payload。
    super(
      JSON.stringify({
        error_type: 'EGRESS_BLOCKED',
        domain,
        message: `Access to ${domain} is blocked by the network egress proxy.`,
      }),
    )
    this.name = 'EgressBlockedError'
  }
}

// 中文补充：缓存条目类型。注意它和 FetchedContent 几乎一样——
// 差别在于缓存里额外存了 contentType（后面判断"要不要再跑一次小模型"要用），
// 而 persistedPath/persistedSize 是可选的（只有二进制响应才有）。
// `persistedPath?: string` 里的 `?` = 可选字段，等价于 `string | undefined`。
// Cache for storing fetched URL content
type CacheEntry = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

// 中文补充：URL 级缓存。LRU = Least Recently Used（最近最少使用），
// ≈ Java 的 LinkedHashMap 手写 LRU，或 Guava/Caffeine 的 Cache。
// 这里同时给了两个上限：条目的**总字节数**上限（maxSize，50MB）和
// **存活时间**（ttl，15 分钟）。任一超限就自动淘汰，不用手动清理。
// 为什么是字节数而不是条目数？因为网页大小差异极大，按条目数限不住内存。
// Cache with 15-minute TTL and 50MB size limit
// LRUCache handles automatic expiration and eviction
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
})

// 中文补充：域名预检缓存。为什么还需要第二份？
// 因为 URL 级缓存是**按完整 URL** 存的：抓 docs.python.org/a 和 docs.python.org/b
// 会各自走一次预检 HTTP（打到 api.anthropic.com），白白多一轮往返。
// 所以单独按 hostname 缓存一份，同一域名只预检一次。
// 关键取舍：**只缓存 'allowed'，blocked / failed 一律不缓存**——
//   失败不缓存 = 下次还能重试（可能只是当时网络抖了一下）；
//   成功才缓存 = 即便黑名单事后更新，也只是 5 分钟后才生效，风险可控。
// 这也是为什么它的 ttl（5 分钟）比 URL_CACHE（15 分钟）短：安全决策要更"新鲜"。
// Separate cache for preflight domain checks. URL_CACHE is URL-keyed, so
// fetching two paths on the same domain triggers two identical preflight
// HTTP round-trips to api.anthropic.com. This hostname-keyed cache avoids
// that. Only 'allowed' is cached — blocked/failed re-check on next attempt.
const DOMAIN_CHECK_CACHE = new LRUCache<string, true>({
  max: 128,
  ttl: 5 * 60 * 1000, // 5 minutes — shorter than URL_CACHE TTL
})

/**
 * 清空 WebFetch 的全部缓存。
 *
 * 【做什么】把 URL 缓存和域名预检缓存一起清掉。
 * 【为什么需要】两类场景必须强制失效：
 *   ① 用户改了网络/代理/企业策略设置，之前缓存的"这个域名可抓"结论可能已不成立；
 *   ② 测试里要保证用例之间互不影响（否则前一个用例缓存的结果会污染后一个）。
 * 【入参】无  【返回】void（≈ Java 的 void）
 */
export function clearWebFetchCache(): void {
  URL_CACHE.clear()
  DOMAIN_CHECK_CACHE.clear()
}

// 中文补充：turndown 就是干「HTML → markdown」这件事的库（本目录最重要的转换点）。
// 之所以要**懒加载**（用到才 import）而不是顶层 import：
//   turndown 连带 @mixmark-io/domino 一起会常驻约 1.4MB 堆内存。
//   大多数会话根本不抓网页，没必要启动时就付这份代价。
// 之所以还要**缓存单例**：构造一次 Turndown 要建 15 条规则对象，
//   而 .turndown() 本身是无状态的，复用一个实例完全安全。
// `??=` 是惰性单例惯用法：第一次调用时把 Promise 存下来，之后全部复用。
//   ⚠️ 存的是 Promise 而不是实例——这样并发调用也只会触发一次 import。
// 类型上的 `(m as unknown as { default: TurndownCtor })`：因为 @types/turndown
//   只提供了 `export =`（老式 CommonJS 写法），TS 认为 import 出来的就是类本身；
//   而 Bun 会把 CJS 包成 { default }。两边认识不一致，只能强转一下。
//   ≈ Java 里绕过泛型检查的 (T) Object 强转。
// Lazy singleton — defers the turndown → @mixmark-io/domino import (~1.4MB
// retained heap) until the first HTML fetch, and reuses one instance across
// calls (construction builds 15 rule objects; .turndown() is stateless).
// @types/turndown ships only `export =` (no .d.mts), so TS types the import
// as the class itself while Bun wraps CJS in { default } — hence the cast.
type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
/**
 * 取得 turndown 单例（HTML → markdown 转换器）。
 *
 * 【做什么】返回一个 Promise<Turndown 实例>；首次调用才真正 import 并 new。
 * 【为什么需要】见上方那段长注释：省 1.4MB 启动内存 + 省掉重复的构造开销。
 * 【入参】无
 * 【返回】Promise<InstanceType<TurndownCtor>> —— 注意返回的是 Promise，调用方要 await。
 *        `InstanceType<Ctor>` 是 TS 内置工具类型：从"类的类型"推出"实例的类型"，
 *        ≈ Java 反射里 Class<T> 与 T 的关系。
 * 【关键步骤】
 *   ① `??=` 判断缓存里有没有；没有才执行右侧
 *   ② 动态 import('turndown')（运行时才加载，打包器会切成独立 chunk）
 *   ③ 从模块对象里取出 default 并 new 出来
 */
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

// 中文补充：URL 长度上限 2000。
// 这段英文注释值得读——它记录了一次**安全限制被放宽**的决策过程：
//   原本有人（PSR，产品安全评审）要求 URL 不超过 250 字符，理由是 URL 越长，
//   越容易被用来夹带数据外传（把密钥塞进 URL 发出去）。
//   但 250 太短，云服务的 JWT 签名 URL（合法性凭证本身就有几百字符）会被误伤。
//   最终决定放宽到 2000，理由是：每个域名都要用户单独授权，这已经是**第一道
//   也是最有效的安全边界**；而且 Claude Code 本来就有别的数据出口（Bash 等），
//   单卡 URL 长度收益有限。
// 这是典型的"安全与可用性权衡"案例，不是随手写的数字。
// PSR requested limiting the length of URLs to 250 to lower the potential
// for a data exfiltration. However, this is too restrictive for some customers'
// legitimate use cases, such as JWT-signed URLs (e.g., cloud service signed URLs)
// that can be much longer. We already require user approval for each domain,
// which provides a primary security boundary. In addition, Claude Code has
// other data exfil channels, and this one does not seem relatively high risk,
// so I'm removing that length restriction. -ab
const MAX_URL_LENGTH = 2000

// 中文补充：响应体上限 10MB。这条也来自 PSR——"资源消耗控制"：
// 不限量的话，一个恶意/超大的响应就能把内存吃光，等于单点 DoS。
// 配合下面的 FETCH_TIMEOUT_MS（时间上限）和 MAX_REDIRECTS（跳数上限），
// 构成对单次 fetch 的三维限制：大小 / 时间 / 跳数。
// Per PSR:
// "Implement resource consumption controls because setting limits on CPU,
// memory, and network usage for the Web Fetch tool can prevent a single
// request or user from overwhelming the system."
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024

// Timeout for the main HTTP fetch request (60 seconds).
// Prevents hanging indefinitely on slow/unresponsive servers.
const FETCH_TIMEOUT_MS = 60_000

// Timeout for the domain blocklist preflight check (10 seconds).
const DOMAIN_CHECK_TIMEOUT_MS = 10_000

// 中文补充：重定向跳数上限 10。
// 为什么必须自己数？因为**每个跳转都会重置**上面那个 60 秒超时——
// 恶意服务器只要返回 /a → /b → /a → … 的死循环，请求就永远不会超时，
// 工具会一直挂到用户手动 Ctrl+C。这是「每跳重置计时」类实现的经典陷阱。
// 10 这个数字参考了常见客户端默认值（axios 5、follow-redirects 21、Chrome 20）。
// Cap same-host redirect hops. Without this a malicious server can return
// a redirect loop (/a → /b → /a …) and the per-request FETCH_TIMEOUT_MS
// resets on every hop, hanging the tool until user interrupt. 10 matches
// common client defaults (axios=5, follow-redirects=21, Chrome=20).
const MAX_REDIRECTS = 10

// 中文补充：markdown 截断上限 10 万字符。
// 目的是控制**发给小模型的 token 数**——不截断会触发 API 的
// "Prompt is too long" 错误。这个常量会被 WebFetchTool.ts 拿去判断
// "能不能直接把原文返回、省掉一次小模型调用"。
// Truncate to not spend too many tokens
export const MAX_MARKDOWN_LENGTH = 100_000

/**
 * 判断一个 URL 是否命中「预批准域名白名单」。
 *
 * 【做什么】把 URL 字符串解析成 URL 对象，取出 hostname + pathname 交给
 *          preapproved.ts 的 isPreapprovedHost 判断。
 * 【为什么需要】白名单是**免用户授权**的唯一通道，命中与否会改变三处行为：
 *              权限、版权措辞、是否跳过小模型。所以入口处要先算出来。
 * 【入参】url  完整 URL 字符串
 * 【返回】true = 命中白名单
 * 【关键步骤】
 *   ① new URL(url) 解析；⚠️ 解析失败会**抛异常**，所以必须包在 try 里
 *   ② 取 hostname / pathname 交给白名单查询
 *   ③ catch 里返回 false —— 一个解析不了的 URL，当然也不可能是白名单域名
 *      （catch { } 不写绑定名是本文件惯用写法，因为这里不需要用到异常对象）
 */
export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)
  } catch {
    return false
  }
}

/**
 * URL 合法性校验（本文件所有 fetch 的第一道闸门）。
 *
 * 【做什么】逐个拦掉不该发的 URL，返回 true/false（不抛异常）。
 * 【为什么需要】WebFetch 是模型可以**自主发起**的出网动作，
 *              必须在发出前把明显的风险形态挡掉（见下方逐条"为什么"）。
 * 【入参】url 待校验的 URL 字符串
 * 【返回】true = 可以发起请求
 * 【校验项与各自的理由】
 *   ① 长度 > 2000 → 拒绝（防超长 URL 夹带数据，见 MAX_URL_LENGTH 的注释）
 *   ② 解析失败   → 拒绝（连 URL 都不是，没必要发）
 *   ③ 带 username/password → 拒绝。
 *      例：https://user:pass@evil.com/ 这种"凭据藏在 URL 里"的写法，
 *      常被用来做钓鱼/混淆真实域名；本工具既不支持 cookie 也不支持内网，
 *      留着它没有正当用途。
 *   ④ hostname 少于两段（没有点） → 拒绝。
 *      例：http://localhost、http://intranet 这类**内网/本机**地址。
 *      这是粗筛——要求域名能被公开解析，从而把"公司内网"、"localhost"
 *      、"metadata.google.internal" 这类内网目标挡在外面。
 *      （真正的 SSRF 防护还得靠服务端的域名黑名单，这只是第一层粗筛）
 * 【注意】这里**不检查协议**——http 会在真正发请求前被升级成 https。
 */
export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // We don't need to check protocol here, as we'll upgrade http to https when making the request

  // As long as we aren't supporting aiming to cookies or internal domains,
  // we should block URLs with usernames/passwords too, even though these
  // seem exceedingly unlikely.
  if (parsed.username || parsed.password) {
    return false
  }

  // 中文补充：hostname 至少要有两段（含一个点）。
  // 'localhost'、'intranet'、'metadata' 这种无点主机名直接拒绝——
  // 它们通常指向本机或内网，属于典型的 SSRF（服务端请求伪造）目标。
  // Initial filter that this isn't a privileged, company-internal URL
  // by checking that the hostname is publicly resolvable
  const hostname = parsed.hostname
  const parts = hostname.split('.')
  if (parts.length < 2) {
    return false
  }

  return true
}

// 中文补充：DomainCheckResult 是典型的**可辨识联合（discriminated union）**：
// 三个成员都带一个字面量类型的 status 字段，靠它区分。
// ≈ Java 17+ 的 sealed interface + record 实现，或 enum + 附加数据；
// 但 TS 里写起来只要几行，而且 switch 时编译器能自动收窄每个分支的类型。
// 注意三种状态是**有意区分**的：
//   allowed      = 明确允许，放行
//   blocked      = 明确禁止（服务端说不行），直接报错给用户
//   check_failed = 查不到（网络问题/企业策略拦截），要告诉用户"我无法确认"，
//                  而不是当成"允许"——**失败必须 fail-closed（默认拒绝）**。
type DomainCheckResult =
  | { status: 'allowed' }
  | { status: 'blocked' }
  | { status: 'check_failed'; error: Error }

/**
 * 域名预检：问 api.anthropic.com 这个域名能不能抓。
 *
 * 【做什么】发一个 GET 到 https://api.anthropic.com/api/web/domain_info?domain=xxx，
 *          根据返回的 can_fetch 字段给出 allowed / blocked / check_failed。
 * 【为什么需要】这是**服务端维护的恶意域名黑名单**。
 *              白名单（preapproved.ts）解决"哪些肯定安全"，这里解决"哪些肯定危险"；
 *              两者之间的灰色地带则交给用户授权弹窗。三层加起来才是完整策略。
 * 【入参】domain 主机名（不是完整 URL）
 * 【返回】DomainCheckResult（见上方类型说明）
 * 【关键步骤】
 *   ① 先查 DOMAIN_CHECK_CACHE，命中直接 allowed（省一次网络往返）
 *   ② 发请求，带 10 秒超时；⚠️ 用 encodeURIComponent 编码域名，
 *      否则域名里的特殊字符会破坏 query string（甚至插入额外参数）
 *   ③ status 200 且 data.can_fetch === true → allowed，并写入缓存
 *      （注意只缓存 allowed，原因见 DOMAIN_CHECK_CACHE 的注释）
 *   ④ status 200 但 can_fetch 不为 true → blocked
 *   ⑤ 非 200 → check_failed；请求抛异常 → logError 后也返回 check_failed
 *      ⚠️ 异常被**吞掉转成返回值**而不是往上抛，因为"查不到"是一种合法的
 *      业务结果，由调用方决定怎么呈现给用户
 */
export async function checkDomainBlocklist(
  domain: string,
): Promise<DomainCheckResult> {
  if (DOMAIN_CHECK_CACHE.has(domain)) {
    return { status: 'allowed' }
  }
  try {
    const response = await axios.get(
      `https://api.anthropic.com/api/web/domain_info?domain=${encodeURIComponent(domain)}`,
      { timeout: DOMAIN_CHECK_TIMEOUT_MS },
    )
    if (response.status === 200) {
      if (response.data.can_fetch === true) {
        DOMAIN_CHECK_CACHE.set(domain, true)
        return { status: 'allowed' }
      }
      return { status: 'blocked' }
    }
    // Non-200 status but didn't throw
    return {
      status: 'check_failed',
      error: new Error(`Domain check returned status ${response.status}`),
    }
  } catch (e) {
    logError(e)
    return { status: 'check_failed', error: e as Error }
  }
}

/**
 * Check if a redirect is safe to follow
 * Allows redirects that:
 * - Add or remove "www." in the hostname
 * - Keep the origin the same but change path/query params
 * - Or both of the above
 */
/**
 * 判断一次重定向是否安全、可以自动跟随。
 *
 * 【做什么】比较原始 URL 与目标 URL，只有"同一站点内部移动"才允许跟随。
 * 【为什么需要】——这是**防 open redirect（开放重定向）攻击**的关键。
 *   攻击场景：某个可信站点 trusted.com 有个 /redirect?to=xxx 的漏洞，
 *   攻击者让模型先抓 trusted.com（用户已授权），服务端 302 到 evil.com。
 *   如果客户端无脑跟随，就绕过了"用户只授权了 trusted.com"这道边界。
 *   所以这里坚持：**跨站重定向一律不跟随**，把新地址回给模型，
 *   让它再发一次 WebFetch（等于再走一遍授权）。
 * 【入参】originalUrl 原始请求 URL / redirectUrl 服务端给的跳转目标
 * 【返回】true = 安全，可跟随
 * 【允许的情况（都是"同一个站点"）】
 *   ① 加 www：example.com → www.example.com
 *   ② 去 www：www.example.com → example.com
 *   ③ 同 host，只改 path / query：example.com/a → example.com/b?x=1
 * 【拒绝的情况】
 *   ④ 协议变了（https → http，降级攻击）
 *   ⑤ 端口变了（可能是完全不同的服务）
 *   ⑥ 跳转目标里带了 username/password（和 validateURL 同样的凭据混淆顾虑）
 *   ⑦ hostname 去掉 www 后不相等（真跨站）
 * 【关键步骤】
 *   ①②③ 逐条拒绝 → ④ 用 stripWww 归一化后比较主机名
 *   ⑤ 任何一步解析失败都 return false（fail-closed）
 */
export function isPermittedRedirect(
  originalUrl: string,
  redirectUrl: string,
): boolean {
  try {
    const parsedOriginal = new URL(originalUrl)
    const parsedRedirect = new URL(redirectUrl)

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false
    }

    if (parsedRedirect.port !== parsedOriginal.port) {
      return false
    }

    if (parsedRedirect.username || parsedRedirect.password) {
      return false
    }

    // Now check hostname conditions
    // 1. Adding www. is allowed: example.com -> www.example.com
    // 2. Removing www. is allowed: www.example.com -> example.com
    // 3. Same host (with or without www.) is allowed: paths can change
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    const originalHostWithoutWww = stripWww(parsedOriginal.hostname)
    const redirectHostWithoutWww = stripWww(parsedRedirect.hostname)
    return originalHostWithoutWww === redirectHostWithoutWww
  } catch (_error) {
    return false
  }
}

/**
 * Helper function to handle fetching URLs with custom redirect handling
 * Recursively follows redirects if they pass the redirectChecker function
 *
 * Per PSR:
 * "Do not automatically follow redirects because following redirects could
 * allow for an attacker to exploit an open redirect vulnerability in a
 * trusted domain to force a user to make a request to a malicious domain
 * unknowingly"
 */
type RedirectInfo = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

// 中文补充：getWithPermittedRedirects 的主流程说明（英文那段讲的是"为什么不自动跟随"）：
//   · maxRedirects: 0 —— **关掉 axios 自带的重定向跟随**。
//     因为 axios 跟随了我们就没机会逐个跳转做安全检查，所以 3xx 会以
//     "错误"的形式抛出来，我们再手动判断要不要递归跟下一跳。
//   · responseType: 'arraybuffer' —— 要原始字节。
//     原因有两个：① 响应可能是 PDF/图片等二进制；② 转 markdown 前要先按 UTF-8
//     解码，拿到 buffer 才能自己控制解码与字节长度统计。
//   · Accept 头里首选 text/markdown —— 现在不少站点（尤其文档站）支持直接返回
//     markdown，拿到就能省掉一次 HTML→markdown 转换，也省掉一次小模型调用。
//   · 递归而不是循环：每一跳都要重新做一次 isPermittedRedirect 判断、
//     重新计时（FETCH_TIMEOUT_MS 也随每跳重置，所以才需要 MAX_REDIRECTS 兜底）。
// 返回类型是「响应 or 重定向信息」的联合类型，调用方用 isRedirectInfo 区分。
export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  // depth 是递归深度 = 已跟随的跳数。超限直接报错，防重定向死循环（见 MAX_REDIRECTS 注释）
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`)
  }
  try {
    return await axios.get(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': getWebFetchUserAgent(),
      },
    })
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = error.response.headers.location
      if (!redirectLocation) {
        throw new Error('Redirect missing Location header')
      }

      // 把 Location 头解析成绝对 URL：new URL(相对路径, 基准URL)。
      // 服务端返回相对路径（如 '/new-path'）是常见情况，必须补成完整的，
      // 否则后面无法比较 hostname。≈ Java 的 new URL(base, spec) 双参构造。
      // Resolve relative URLs against the original URL
      const redirectUrl = new URL(redirectLocation, url).toString()

      // 安全闸门：只有 isPermittedRedirect 说"同站"才递归跟随；
      // 否则把跳转信息返回给上层，由上层提示模型重新发起（重新走授权）。
      if (redirectChecker(url, redirectUrl)) {
        // Recursively follow the permitted redirect
        return getWithPermittedRedirects(
          redirectUrl,
          signal,
          redirectChecker,
          depth + 1,
        )
      } else {
        // Return redirect information to the caller
        return {
          type: 'redirect',
          originalUrl: url,
          redirectUrl,
          statusCode: error.response.status,
        }
      }
    }

    // 中文补充：识别「企业出口代理把请求拦了」这一种特殊 403。
    // 有些公司在出口代理上做了域名白名单，被拦时返回 403 且带
    // X-Proxy-Error: blocked-by-allowlist 头。这跟"目标站点拒绝"是两回事，
    // 明确区分后 UI 才能给用户正确的提示（去找管理员放行，而不是换个 URL）。
    // 注意这里用的是 `?.`（可选链）：error.response 可能不存在，
    // 等价于 Java 的 `error.getResponse() != null && ...`
    // Detect egress proxy blocks: the proxy returns 403 with
    // X-Proxy-Error: blocked-by-allowlist when egress is restricted
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.headers['x-proxy-error'] === 'blocked-by-allowlist'
    ) {
      const hostname = new URL(url).hostname
      throw new EgressBlockedError(hostname)
    }

    throw error
  }
}

/**
 * 类型谓词：判断返回值是「重定向信息」还是「真正的响应」。
 *
 * 【做什么】返回 boolean，但签名是 `response is RedirectInfo`——
 *          这叫**类型谓词**，一旦 if 进去，编译器就知道 response 是 RedirectInfo。
 *          ≈ Java 的 `if (o instanceof Foo f) { ... }`（Java 16+ 模式匹配）。
 * 【为什么需要】getWithPermittedRedirects 的返回类型是
 *              `AxiosResponse<ArrayBuffer> | RedirectInfo` 的联合类型。
 *              没有这个谓词，调用方就得靠 `as` 强转，容易出错。
 * 【实现要点】用 `'type' in response` 做**属性存在性检查**——
 *            AxiosResponse 上根本没有 type 字段，所以这是安全的判别方式。
 *            （`in` 运算符 ≈ Java 里没有，近似反射查字段是否存在）
 */
function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect'
}

// 中文补充：FetchedContent = 抓完一个 URL 之后交回给工具层的成果包。
// 与内部 CacheEntry 基本同构，区别是不含 contentType 之外的额外缓存元数据。
// 字段含义：content=转好的 markdown 原文 / bytes=**原始响应**字节数 /
//          code+codeText=HTTP 状态码与文本 / contentType=响应类型 /
//          persistedPath+persistedSize=二进制内容另存到磁盘的位置与大小（可选）
export type FetchedContent = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
  persistedPath?: string
  persistedSize?: number
}

/**
 * ★ 本文件的核心：把 URL 变成 markdown（或一条重定向提示）。
 *
 * 【做什么】走完整条流水线：
 *      校验 URL → 查缓存 → 域名预检 → 发 HTTP(自管重定向) → 按类型转 markdown
 *      → 二进制另存磁盘 → 写缓存 → 返回
 *
 * 【为什么需要】这是 WebFetch 能力的本体。模型给它一个 URL，
 *              它还一段**可以直接喂给模型**的 markdown，而不是原始 HTML。
 *              为什么非要转 markdown？因为 HTML 里充斥 <div>、<script>、
 *              内联样式、导航栏这些噪音，token 成本高且严重干扰模型理解；
 *              markdown 只保留标题/段落/链接/代码块这些语义结构，
 *              同样的信息量往往只要 1/5 的 token。
 *
 * 【入参】url             要抓的完整 URL
 *        abortController  用于 Ctrl+C 取消请求（signal 会一路传给 axios 和 Haiku）
 * 【返回】Promise<FetchedContent | RedirectInfo>
 *         —— 正常内容，或"需要跨站跳转，请重新发起"的信息（联合类型）
 *
 * 【关键步骤】
 *   ① validateURL 失败直接抛 'Invalid URL'
 *   ② 查 URL_CACHE，命中直接返回副本（省掉整条网络链路）
 *   ③ http → https 升级（明文传输有被窃听/篡改风险，能升就升）
 *   ④ 域名预检（除非用户在设置里显式关掉 skipWebFetchPreflight）
 *      · allowed → 继续；blocked → 抛 DomainBlockedError；
 *      · check_failed → 抛 DomainCheckFailedError（失败即拒绝，不静默放行）
 *   ⑤ 发请求，处理重定向
 *   ⑥ 二进制落盘 + UTF-8 解码 + HTML→markdown 转换
 *   ⑦ 写缓存（**按原始 URL 存**，不是升级后/跳转后的 URL——
 *      这样下次用同样的原始 URL 才能命中）
 */
export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL')
  }

  // Check cache (LRUCache handles TTL automatically)
  const cachedEntry = URL_CACHE.get(url)
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    }
  }

  let parsedUrl: URL
  let upgradedUrl = url

  try {
    parsedUrl = new URL(url)

    // 中文补充：把 http 强制升级为 https。
    // 理由：http 是明文，可被中间人窃听和篡改；而这里抓到的内容是要喂给
    // 模型、进而影响代码生成的，被篡改的文档等于被投毒的上下文。
    // 做法很巧：直接改 URL 对象的 protocol 属性再 toString()，
    // 避免了手写字符串替换（会误伤路径里恰好出现的 "http://"）。
    // Upgrade http to https if needed
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:'
      upgradedUrl = parsedUrl.toString()
    }

    const hostname = parsedUrl.hostname

    // 中文补充：这个开关是给**企业客户**的逃生门。
    // 有些公司网络策略禁止访问 claude.ai（也就访问不了 api.anthropic.com 的
    // 预检接口），导致上面那个预检必然 check_failed → 所有网页都抓不了。
    // 开了 skipWebFetchPreflight 就跳过预检，接受"没有服务端黑名单"的风险。
    // 注意：跳过的是**黑名单检查**，用户授权弹窗那道还在，所以不是完全裸奔。
    // Check if the user has opted to skip the blocklist check
    // This is for enterprise customers with restrictive security policies
    // that prevent outbound connections to claude.ai
    const settings = getSettings_DEPRECATED()
    if (!settings.skipWebFetchPreflight) {
      const checkResult = await checkDomainBlocklist(hostname)
      switch (checkResult.status) {
        case 'allowed':
          // 允许 → break 出 switch，继续往下发请求。
          // 这里必须用 break，否则会穿透到下面的 case（TS/JS 的 switch 和 Java 一样
          // 默认穿透，是个常见 bug 来源）。
          // Continue with the fetch
          break
        case 'blocked':
          throw new DomainBlockedError(hostname)
        case 'check_failed':
          throw new DomainCheckFailedError(hostname)
      }
    }

    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_web_fetch_host', {
        hostname:
          hostname as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch (e) {
    // 中文补充：区分"预期内的用户可见失败"和"真正的内部错误"。
    // 前者（域名被禁 / 预检失败）是正常业务分支，用户需要看到清晰提示，
    // 不该被当成程序 bug 记进错误日志、也不该污染错误监控；
    // 其它异常（比如 new URL 抛出、设置读取失败）才 logError。
    // ≈ Java 里 catch (DomainBlockedException e) { throw e; }
    //          catch (Exception e) { log.error(...); }
    // ⚠️ 这个 catch 块**只做分类，不吞异常**，两种异常都会继续往上抛。
    if (
      e instanceof DomainBlockedError ||
      e instanceof DomainCheckFailedError
    ) {
      // Expected user-facing failures - re-throw without logging as internal error
      throw e
    }
    logError(e)
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    abortController.signal,
    isPermittedRedirect,
  )

  // Check if we got a redirect response
  if (isRedirectInfo(response)) {
    return response
  }

  // 中文补充：把 axios 的 ArrayBuffer 包成 Node 的 Buffer（后面要按 utf-8 解码、
  // 要落盘存二进制，都需要 Buffer）。Buffer.from 这里是**零拷贝**地引用同一块内存。
  const rawBuffer = Buffer.from(response.data)
  // 中文补充（这段英文很关键）：主动把 response.data 置成 null。
  // 因为 rawBuffer 已经接管了这些字节，axios 持有的那份 ArrayBuffer 就是纯浪费：
  // 最多 10MB（MAX_HTTP_CONTENT_LENGTH）。而紧接着 turndown 要建 DOM 树，
  // 峰值内存可达 HTML 的 3~5 倍。早点释放能显著降低峰值内存。
  // 那行 `;` 开头的写法是为了避免被上一行的结尾误解析成属性访问，纯语法需要。
  // Release the axios-held ArrayBuffer copy; rawBuffer owns the bytes now.
  // This lets GC reclaim up to MAX_HTTP_CONTENT_LENGTH (10MB) before Turndown
  // builds its DOM tree (which can be 3-5x the HTML size).
  ;(response as { data: unknown }).data = null
  const contentType = response.headers['content-type'] ?? ''

  // 中文补充（这段英文解释了一个反直觉的取舍）：
  // PDF 这类二进制**不会因为存了盘就跳过后面的解码 + Haiku 流程**。
  // 原因是：PDF 解码成字符串后仍保留不少 ASCII 结构（/Title、文本流等），
  // Haiku 往往能据此给出一个还不错的摘要；落盘的文件是**补充**而非替代。
  // 所以顺序是：先存盘 → 再照常走解码/总结 → 最后在结果末尾追加一行
  // "原始文件也存到了 xxx"，让模型需要时可以去读原文件。
  // Binary content: save raw bytes to disk with a proper extension so Claude
  // can inspect the file later. We still fall through to the utf-8 decode +
  // Haiku path below — for PDFs in particular the decoded string has enough
  // ASCII structure (/Title, text streams) that Haiku can summarize it, and
  // the saved file is a supplement rather than a replacement.
  let persistedPath: string | undefined
  let persistedSize: number | undefined
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const result = await persistBinaryContent(rawBuffer, contentType, persistId)
    if (!('error' in result)) {
      persistedPath = result.filepath
      persistedSize = result.size
    }
  }

  const bytes = rawBuffer.length
  const htmlContent = rawBuffer.toString('utf-8')

  // 中文补充：**HTML → markdown 的分岔点**。
  //   · 是 text/html → 用 turndown 转换（本文件存在的最大理由之一）
  //   · 不是 HTML（text/markdown、text/plain、application/json…）→ 原样使用，
  //     连 Buffer.byteLength 都省了：因为 UTF-8 解码后的字节数就等于原始字节数
  //     （只有非法字节被替换成 U+FFFD 时才有微小出入，对缓存容量统计可忽略），
  //     没必要再 O(n) 扫一遍。这里体现了"能省就省"的性能取向。
  let markdownContent: string
  let contentBytes: number
  if (contentType.includes('text/html')) {
    markdownContent = (await getTurndownService()).turndown(htmlContent)
    contentBytes = Buffer.byteLength(markdownContent)
  } else {
    // It's not HTML - just use it raw. The decoded string's UTF-8 byte
    // length equals rawBuffer.length (modulo U+FFFD replacement on invalid
    // bytes — negligible for cache eviction accounting), so skip the O(n)
    // Buffer.byteLength scan.
    markdownContent = htmlContent
    contentBytes = bytes
  }

  // Store the fetched content in cache. Note that it's stored under
  // the original URL, not the upgraded or redirected URL.
  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  }
  // 中文补充：存缓存时第三个参数是"这条目占多少字节"，LRU 靠它做 50MB 上限统计。
  // 用 Math.max(1, ...) 是因为 lru-cache 要求正整数——空响应的 0 会直接报错，
  // 所以clamp到 1。这是典型的"库的约束倒逼的防御性代码"。
  // lru-cache requires positive integers; clamp to 1 for empty responses.
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) })
  return entry
}

/**
 * 让「二级小模型（Haiku）」读一遍 markdown，只把答案交回主模型。
 *
 * 【做什么】截断 → 拼提示词 → 调 queryHaiku → 取出小模型返回的第一段文本。
 * 【为什么需要】——整个 WebFetch 能实用的关键一环，务必理解：
 *   一个网页转 markdown 后动辄几万字符。如果原样塞进主循环上下文：
 *     · 上下文窗口被单页吃掉一大半（后续没法继续工作）；
 *     · token 成本极高。
 *   所以策略是「用便宜的小模型做一次信息萃取」：
 *     本函数把 10 万字符 + 模型的问题 交给 Haiku，只把 Haiku 的**一小段回答**
 *     返回给主模型。主模型始终只看到"答案"，看不到"网页"。
 *   这也是为什么 WebFetch 工具的输入除了 url 还必须带一个 prompt——
 *   那个 prompt 就是给小模型的问题。
 *
 * 【入参】prompt                要小模型回答的问题
 *        markdownContent       网页转好的 markdown 全文
 *        signal                取消信号（Ctrl+C 时用）
 *        isNonInteractiveSession 是否非交互会话（影响遥测/行为分支）
 *        isPreapprovedDomain   是否白名单域名（决定版权措辞，见 prompt.ts）
 * 【返回】小模型的回答文本；拿不到时返回 'No response from model'
 *
 * 【关键步骤】
 *   ① 超过 MAX_MARKDOWN_LENGTH(10万字符) 就截断并追加截断标记
 *      —— 不截断会触发 API 的 "Prompt is too long" 错误
 *   ② makeSecondaryModelPrompt 拼装完整提示词（prompt.ts）
 *   ③ queryHaiku 发请求；注意 options 里 agents/mcpTools 都是空数组、
 *      hasAppendSystemPrompt 为 false —— **故意给小模型一个最小环境**，
 *      它不该有工具、不该带主系统提示词，只是一个纯读文本的 summarizer
 *   ④ 若已被取消则抛 AbortError（见下方注释：必须冒泡出去）
 *   ⑤ 从返回消息的 content[0] 里取 text 字段返回
 */
export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  // Truncate content to avoid "Prompt is too long" errors from the secondary model
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) +
        '\n\n[Content truncated due to length...]'
      : markdownContent

  const modelPrompt = makeSecondaryModelPrompt(
    truncatedContent,
    prompt,
    isPreapprovedDomain,
  )
  const assistantMessage = await queryHaiku({
    systemPrompt: asSystemPrompt([]),
    userPrompt: modelPrompt,
    signal,
    options: {
      querySource: 'web_fetch_apply',
      agents: [],
      isNonInteractiveSession,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  // 中文补充：为什么**主动抛异常**而不是安静返回空字符串？
  // 因为抛出去才会让整个工具调用失败，进而在消息里生成一个 is_error 的
  // tool_result 块，UI 上就是一个显眼的红点——用户立刻知道"被取消了"。
  // 如果这里静默返回，模型会以为拿到了内容并继续往下推理，用户却毫不知情。
  // 这是"取消操作必须有可见反馈"的设计要求。
  // We need to bubble this up, so that the tool call throws, causing us to return
  // an is_error tool_use block to the server, and render a red dot in the UI.
  if (signal.aborted) {
    throw new AbortError()
  }

  // 中文补充：取小模型回答的第一段文本。
  // `const { content } = assistantMessage.message` 是解构赋值
  // （≈ Java 21 的记录模式匹配，但 TS 里是日常操作）。
  // `contentBlock!` 的 `!` 是**非空断言**——告诉编译器"我保证 content[0] 存在"，
  // ≈ Java 的强转，运行时不做检查；这里安全是因为上面已经判了 length > 0。
  // 最后的兜底 return 很重要：小模型可能返回空内容或纯工具调用块，
  // 与其返回空字符串让模型困惑，不如明确说"没拿到回答"。
  const { content } = assistantMessage.message
  if (content.length > 0) {
    const contentBlock = content[0]
    if ('text' in contentBlock!) {
      return contentBlock.text
    }
  }
  return 'No response from model'
}
