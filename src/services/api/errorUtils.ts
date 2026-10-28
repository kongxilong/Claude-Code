/**
 * 【一句话定位】把底层网络/SDK 抛出的错误，翻译成**用户看得懂、知道怎么办**的中文/英文提示文案。
 *
 * 【在架构中的位置】
 *   调用链：UI 层 / 错误展示组件（以及 OAuth 登录、连通性预检等非主链路）
 *           → 本文件 formatAPIError()（主入口：给 API 错误生成提示文案）
 *           → 本文件 getSSLErrorHint()（给 OAuth 等旁路场景用的 SSL 提示）
 *           → 本文件 extractConnectionErrorDetails()（从 cause 链里挖出根因错误码）
 *           → 本文件 sanitizeAPIError() / sanitizeMessageHTML()（剥掉 HTML 错误页）
 *   注意：本文件**只负责文案**，不负责分类「能不能重试」——
 *   那是同目录下 errors.ts 的职责（两个文件要对照着看）。
 *
 * 【为什么要这么复杂】
 *   ①错误被层层包装：SDK 会把底层错误塞进 `cause` 属性，真正的错误码要顺着链挖；
 *   ②企业用户常站在 TLS 拦截代理（Zscaler 之类）后面，遇到的其实是证书错误，
 *     而原始报错只有一个看不懂的 OpenSSL 错误码，必须翻译成「去配 NODE_EXTRA_CA_CERTS」；
 *   ③错误体可能是 CloudFlare 之类的 HTML 错误页，直接显示给用户是一堆标签，
 *     要抽出 <title> 再展示；
 *   ④从 JSONL 会话文件反序列化出来的错误对象会**丢掉** .message 属性，
 *     得去嵌套结构里捞。
 *
 * 【本文件包含什么】
 *   - SSL_ERROR_CODES：OpenSSL 错误码集合（用来判断是不是证书问题）。
 *   - ConnectionErrorDetails：挖出来的根因信息（错误码 / 消息 / 是否 SSL 错误）。
 *   - extractConnectionErrorDetails()：顺着 cause 链往上挖根因。
 *   - getSSLErrorHint()：SSL 错误的可操作提示。
 *   - sanitizeMessageHTML() / sanitizeAPIError()：HTML 错误页清洗。
 *   - NestedAPIError / hasNestedError() / extractNestedErrorMessage()：嵌套错误结构处理。
 *   - formatAPIError()：★ 主入口，统一出口。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `new Set(['A','B',...])`：跟 Java 的 Set 一样，查重 O(1)。
 *      写成 `new Set([...])` 后 TS 能推断出元素是 string 类型。
 *   2. `error: unknown` 参数：TS 4.4+ 的 catch 变量默认就是 unknown，
 *      逼着你先做类型判断再用。这里函数签名也用 unknown，表示「什么都可能进来」。
 *      Java 类比：参数是 Object，要 instanceof 之后才能强转。
 *   3. `typeof error !== 'object'`：`typeof` 是运行时类型判断，返回字符串。
 *      ≈ Java 的 x instanceof X，但 typeof 只能区分出 string/number/object 等**大类**。
 *   4. `'code' in current`：★ `in` 运算符用于**类型收窄**——检查对象上有没有这个属性。
 *      TS 看到 `'code' in current` 之后，就允许你访问 current.code。
 *      ≈ Java 的反射 field 查找，但这里是编译期生效的类型守卫（type guard）。
 *   5. `current instanceof Error`：跟 Java 完全一样。
 *      配合 `'code' in current` 使用，是因为 Error 基类上没有 code 属性
 *      （Node 的 ErrnoException 才有），所以要先用 in 确认存在。
 *   6. `function hasNestedError(value: unknown): value is NestedAPIError`：
 *      ★ **类型谓词**（type predicate）。返回值写成 `x is T` 表示：
 *      「如果返回 true，那 value 就是 T 类型」。之后 if 分支里 TS 会自动收窄类型，
 *      不用写 as 强转。≈ Java 的 `x instanceof T` + 自动向下转型（Java 16+ 的 pattern matching）。
 *   7. `value.error !== null` 这种「判 null」在本文件里大量出现，是因为
 *      `typeof null === 'object'` 是 JS 的历史 bug，光靠 typeof 排除不掉 null。
 *      Java 里 instanceof 对 null 天然返回 false，不需要额外判。
 *   8. `const { code, isSSLError } = connectionDetails`：解构赋值（Java 无对应语法）。
 *   9. `switch (code) { case 'A': case 'B': return ... }`：
 *      case 穿透（多个 case 共用一段逻辑），跟 Java 的 switch 完全一致。
 *  10. `expr ?? fallback`：空值合并——左边是 null/undefined 才用右边。
 *  11. `error.status ?? 'unknown'`：模板字符串里插值，status 缺失时兜底成字符串。
 *  12. `message.match(/<title>([^<]+)<\/title>/)`：正则。注意 `[^<]+` 是「一个或多个非 < 字符」，
 *      这样即使 title 里有特殊字符也不会越界匹配。match 返回数组或 null，
 *      `[1]` 是第一个捕获组。Java 类比：Pattern + Matcher.group(1)。
 */
import type { APIError } from '@anthropic-ai/sdk'

// 这一串错误码来自 OpenSSL。Node 和 Bun 底层都用 OpenSSL，所以两边通用。
// 判断「是不是证书问题」无法靠 HTTP 状态码（根本没连上），只能靠这些底层错误码。
// SSL/TLS error codes from OpenSSL (used by both Node.js and Bun)
// See: https://www.openssl.org/docs/man3.1/man3/X509_STORE_CTX_get_error.html
// 用 Set 而不是数组：O(1) 查找。这类白名单集合在本项目里很常见。
const SSL_ERROR_CODES = new Set([
  // Certificate verification errors
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  // Self-signed certificate errors
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  // Chain errors
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  // Hostname/altname errors
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  // TLS handshake errors
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
])

// 挖出来的根因信息。isSSLError 是预先算好的判断结果，避免调用方自己再去查 Set。
export type ConnectionErrorDetails = {
  code: string
  message: string
  isSSLError: boolean
}

/**
 * Extracts connection error details from the error cause chain.
 * The Anthropic SDK wraps underlying errors in the `cause` property.
 * This function walks the cause chain to find the root error code/message.
 */
// ★ 顺着 cause 链往上挖。为什么需要这个？
// SDK / axios 会把底层错误包装一层又一层（APIError → cause: FetchError → cause: Error(code)），
// 用户真正需要的那个 `code`（比如 CERT_HAS_EXPIRED）在最内层。
// Java 类比：异常链 e.getCause() 一路 get 下去找根因（Guava 的 Throwables.getRootCause）。
export function extractConnectionErrorDetails(
  error: unknown,
): ConnectionErrorDetails | null {
// unknown 类型不能直接当对象用，必须先 typeof 确认。
  if (!error || typeof error !== 'object') {
    return null
  }

  // Walk the cause chain to find the root error with a code
  let current: unknown = error
// 深度上限 5：防御环形引用（a.cause = a 会导致死循环）。
// 同时也避免异常链过长时无谓地遍历。
  const maxDepth = 5 // Prevent infinite loops
  let depth = 0

  while (current && depth < maxDepth) {
    if (
// 三个条件缺一不可：
// ①真的是 Error 实例（而不是随便一个字符串被 throw 出来）；
// ②有 code 属性（Error 基类没有 code，是 Node 扩展的）；
// ③code 是字符串（防止有人塞个数字进来）。
      current instanceof Error &&
      'code' in current &&
      typeof current.code === 'string'
    ) {
      const code = current.code
      const isSSLError = SSL_ERROR_CODES.has(code)
      return {
        code,
        message: current.message,
        isSSLError,
      }
    }

    // Move to the next cause in the chain
    if (
      current instanceof Error &&
// `current.cause !== current`：显式排除自引用，配合 maxDepth 双保险防止死循环。
      'cause' in current &&
      current.cause !== current
    ) {
      current = current.cause
      depth++
    } else {
      break
    }
  }

// 一路挖到底都没找到带 code 的 Error → 返回 null，交给上层用通用兜底文案。
  return null
}

/**
 * Returns an actionable hint for SSL/TLS errors, intended for contexts outside
 * the main API client (OAuth token exchange, preflight connectivity checks)
 * where `formatAPIError` doesn't apply.
 *
 * Motivation: enterprise users behind TLS-intercepting proxies (Zscaler et al.)
 * see OAuth complete in-browser but the CLI's token exchange silently fails
 * with a raw SSL code. Surfacing the likely fix saves a support round-trip.
 */
// 为什么单独有这个函数？注释里说得很清楚：
// formatAPIError 只适用于「主 API 客户端」那条链路，而 OAuth 换 token、
// 连通性预检这些旁路场景需要一份独立的文案。
// 背景：企业用户在 TLS 拦截代理后面，浏览器里 OAuth 登录成功了，
// 但 CLI 的 token 交换被代理的假证书挡住，只吐一个原始 SSL 错误码，
// 用户完全不知道该怎么办。给一句「设 NODE_EXTRA_CA_CERTS」能省掉一轮技术支持。
export function getSSLErrorHint(error: unknown): string | null {
  const details = extractConnectionErrorDetails(error)
// `details?.isSSLError`：可选链——details 为 null 时整条短路为 undefined，
// 于是 !undefined === true，走进 return null 分支。
  if (!details?.isSSLError) {
    return null
  }
  return `SSL certificate error (${details.code}). If you are behind a corporate proxy or TLS-intercepting firewall, set NODE_EXTRA_CA_CERTS to your CA bundle path, or ask IT to allowlist *.anthropic.com. Run /doctor for details.`
}

/**
 * Strips HTML content (e.g., CloudFlare error pages) from a message string,
 * returning a user-friendly title or empty string if HTML is detected.
 * Returns the original message unchanged if no HTML is found.
 */
// 输入可能是一整个 HTML 页面（CloudFlare / 网关拦截页），直接展示是一堆标签。
function sanitizeMessageHTML(message: string): string {
// 两个特征判断是不是 HTML 文档（DOCTYPE 或 <html 标签）。
// 用 includes 而不是正则，是因为这里只需要「有没有」，性能也更好。
  if (message.includes('<!DOCTYPE html') || message.includes('<html')) {
// 抽 <title> 里的内容当文案：错误页的 title 通常就是「502 Bad Gateway」这种人话。
// `[^<]+` 保证匹配到下一个 < 就停，不会把后面的标签内容也吞进来。
    const titleMatch = message.match(/<title>([^<]+)<\/title>/)
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim()
    }
// 有 HTML 但没有 title → 返回空串（宁可什么都不显示，也不显示一堆标签）。
// 注意：返回 '' 而不是原串，是为了让调用方能靠 length === 0 判断「清洗失败」。
    return ''
  }
  return message
}

/**
 * Detects if an error message contains HTML content (e.g., CloudFlare error pages)
 * and returns a user-friendly message instead
 */
// 对外的 HTML 清洗入口，只处理 APIError 这一种入参类型。
export function sanitizeAPIError(apiError: APIError): string {
  const message = apiError.message
// message 可能压根不存在（见下面 248 行附近的注释：JSONL 反序列化会丢 message）。
// 这里返回空串兜底，绝不返回 undefined —— 调用方会访问 .length，undefined 会直接崩。
  if (!message) {
    // Sometimes message is undefined
    // TODO: figure out why
    return ''
  }
  return sanitizeMessageHTML(message)
}

// ★ 这一段注释解释了本文件最难理解的一个坑：
// 把错误对象 JSON 序列化再反序列化（--resume 读会话 JSONL 就会这样）之后，
// Error 实例变成普通对象，.message 属性丢失了。
// 而不同 provider 的错误嵌套层级还不一样：
//   - Bedrock / 代理：{ error: { message } }
//   - 标准 Anthropic API：{ error: { error: { message } } }
//     （外层 .error 是 HTTP 响应体，内层 .error 才是 API 错误体）
/**
 * Shapes of deserialized API errors from session JSONL.
 *
 * After JSON round-tripping, the SDK's APIError loses its `.message` property.
 * The actual message lives at different nesting levels depending on the provider:
 *
 * - Bedrock/proxy: `{ error: { message: "..." } }`
 * - Standard Anthropic API: `{ error: { error: { message: "..." } } }`
 *   (the outer `.error` is the response body, the inner `.error` is the API error)
 *
 * See also: `getErrorMessage` in `logging.ts` which handles the same shapes.
 */
// 用「可选属性嵌套」描述上面那两种形状：每一层都可能不存在。
type NestedAPIError = {
  error?: {
    message?: string
    error?: { message?: string }
  }
}

// ★ 类型谓词：`value is NestedAPIError`。
// 一旦这个函数返回 true，TS 就在 if 分支里把 value 当成 NestedAPIError 用，
// 不需要 as 强转。Java 类比：instanceof + 自动向下转型。
function hasNestedError(value: unknown): value is NestedAPIError {
// 注意 `value !== null` 是必须的：JS 里 typeof null === 'object'（历史 bug），
// 光靠 typeof 判断会把 null 也放进来。
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null
  )
}

/**
 * Extract a human-readable message from a deserialized API error that lacks
 * a top-level `.message`.
 *
 * Checks two nesting levels (deeper first for specificity):
 * 1. `error.error.error.message` — standard Anthropic API shape
 * 2. `error.error.message` — Bedrock shape
 */
// 从嵌套结构里捞 message。顺序：**深的先试**（先试 error.error.message），
// 因为更深的层级语义更明确。
function extractNestedErrorMessage(error: APIError): string | null {
  if (!hasNestedError(error)) {
    return null
  }

  // Access `.error` via the narrowed type so TypeScript sees the nested shape
  // instead of the SDK's `Object | undefined`.
// 为什么要绕一次 narrowed 变量？因为 hasNestedError 的收窄作用只在 if 块内有效，
// 而这里需要在后面继续访问；同时 SDK 的 APIError 类型上 .error 声明成 Object | undefined，
// 直接访问拿不到嵌套结构，所以要借一个显式标注了 NestedAPIError 的变量。
  const narrowed: NestedAPIError = error
  const nested = narrowed.error

  // Standard Anthropic API shape: { error: { error: { message } } }
// 标准 Anthropic API 形状。?. 链一路可选，任何一层缺失都是 undefined。
  const deepMsg = nested?.error?.message
  if (typeof deepMsg === 'string' && deepMsg.length > 0) {
    const sanitized = sanitizeMessageHTML(deepMsg)
// 清洗后可能变成空串（HTML 但没 title），这时要继续试下一个形状，
// 所以判断的是 sanitized.length > 0 而不是 != null。
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  // Bedrock shape: { error: { message } }
  const msg = nested?.message
  if (typeof msg === 'string' && msg.length > 0) {
    const sanitized = sanitizeMessageHTML(msg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  return null
}

// ★ 主入口。优先级从上到下：连接类错误 → SSL 错误 → 通用连接失败 → 嵌套 message → 原 message。
export function formatAPIError(error: APIError): string {
// 先试着挖根因：连都连不上的错误（SSL/超时）跟 HTTP 业务错误是完全不同的两类，
// 必须分开处理。前者没有 HTTP 状态码可言。
  // Extract connection error details from the cause chain
  const connectionDetails = extractConnectionErrorDetails(error)

  if (connectionDetails) {
    const { code, isSSLError } = connectionDetails

    // Handle timeout errors
// ETIMEDOUT：连接超时。提示里引导用户查网络和代理设置。
    if (code === 'ETIMEDOUT') {
      return 'Request timed out. Check your internet connection and proxy settings'
    }

    // Handle SSL/TLS errors with specific messages
    if (isSSLError) {
// 用 switch 而不是 if-else：错误码是离散枚举值，switch 可读性更好，
// 而且多个码映射到同一句文案时用 case 穿透很自然。
      switch (code) {
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
          return 'Unable to connect to API: SSL certificate verification failed. Check your proxy or corporate SSL certificates'
        case 'CERT_HAS_EXPIRED':
          return 'Unable to connect to API: SSL certificate has expired'
        case 'CERT_REVOKED':
          return 'Unable to connect to API: SSL certificate has been revoked'
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          return 'Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates'
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
        case 'HOSTNAME_MISMATCH':
          return 'Unable to connect to API: SSL certificate hostname mismatch'
        case 'CERT_NOT_YET_VALID':
          return 'Unable to connect to API: SSL certificate is not yet valid'
// default 分支保留原始 code：即使是不认识的错误码，
// 用户把这段文字贴给技术支持时也有线索可查。
        default:
          return `Unable to connect to API: SSL error (${code})`
      }
    }
  }

// 'Connection error.' 是 SDK 给出的笼统文案，本身没有任何信息量，
// 所以这里要替换成更有用的说法。
  if (error.message === 'Connection error.') {
    // If we have a code but it's not SSL, include it for debugging
// 能拿到 code 就带上（比如 ECONNREFUSED），方便排查；拿不到就给通用文案。
    if (connectionDetails?.code) {
      return `Unable to connect to API (${connectionDetails.code})`
    }
    return 'Unable to connect to API. Check your internet connection'
  }

  // Guard: when deserialized from JSONL (e.g. --resume), the error object may
  // be a plain object without a `.message` property.  Return a safe fallback
  // instead of undefined, which would crash callers that access `.length`.
// ★ 关键防御：message 不存在时绝不能返回 undefined。
// 注释里明说原因——调用方会访问 `.length`，undefined.length 直接抛 TypeError，
// 本来只是「显示不出错误」，会变成「程序崩溃」。
// 优先级：先试嵌套结构，都没有就用「API error (status xxx)」兜底。
  if (!error.message) {
    return (
      extractNestedErrorMessage(error) ??
      `API error (status ${error.status ?? 'unknown'})`
    )
  }

  const sanitizedMessage = sanitizeAPIError(error)
// 只有「清洗后确实变了 且 清洗结果非空」才用清洗结果，
// 否则用原 message（避免把正常文案洗成空串）。
  // Use sanitized message if it's different from the original (i.e., HTML was sanitized)
  return sanitizedMessage !== error.message && sanitizedMessage.length > 0
    ? sanitizedMessage
    : error.message
}
