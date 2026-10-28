/**
 * 【一句话定位】XAA 的 IdP 登录：用标准 OIDC 授权码 + PKCE 流程从企业 IdP 换一个 id_token，并按 issuer 缓存。
 *
 * 【XAA 是什么（先把大图说清）】
 * XAA = Cross-App Access（跨应用访问），对应 SEP-990 / Enterprise Managed Authorization。
 * 它解决的是企业场景的痛点：公司里有一大堆 MCP server，每个都要弹一次浏览器让用户点同意，太烦。
 * XAA 的做法是「一次登录，处处静默」：
 *   ① 用户先跟企业 IdP（Okta / Azure AD / Keycloak …）登录一次，拿到 id_token（本文件负责这一步）；
 *   ② 之后每个 MCP server 需要 token 时，用这个 id_token 走 RFC 8693 令牌交换换出 ID-JAG，
 *      再用 RFC 7523 JWT Bearer 换出 access_token（这一步在 xaa.ts 里）。
 * 全程不再弹浏览器。
 *
 * 【在架构中的位置】
 * - 上游：auth.ts（需要 id_token 时调 acquireIdpIdToken）、`claude mcp xaa` 系列命令。
 * - 下游：oauthPort.ts（挑端口、拼 redirect URI）、secureStorage（钥匙串）、MCP SDK 的 auth 工具。
 *
 * 【本文件包含什么】
 * - isXaaEnabled / getXaaIdpSettings：开关与配置读取。
 * - issuerKey()：把 issuer URL 规范化成缓存键。
 * - getCachedIdpIdToken / saveIdpIdToken / clearIdpIdToken：id_token 的钥匙串缓存。
 * - saveIdpIdTokenFromJwt / saveIdpClientSecret / getIdpClientSecret / clearIdpClientSecret：
 *   测试与命令用的辅助读写。
 * - discoverOidc()：OIDC 发现（读 .well-known/openid-configuration）。
 * - waitForCallback()：起一个本地 HTTP 服务，等浏览器带着授权码回调。
 * - acquireIdpIdToken()：★ 主入口，有缓存用缓存，没有就跑完整登录流程。
 *
 * 【TS 语法速查】
 * - `new Promise<string>((resolve, reject) => {...})`：手动造 Promise，把「浏览器回调」这个
 *   事件驱动的东西转成 await 能等的异步值 ≈ Java 的 CompletableFuture 手动 complete。
 * - `let server: Server | null = null` + `server?.close()`：可空变量 + 可选链，
 *   ≈ Java 里到处判 null，但语法糖更短。
 * - `Buffer.from(x, 'base64url').toString('utf-8')`：Node 的二进制/编码工具 ≈ Java 的 Base64.getUrlDecoder()。
 * - `NodeJS.Timeout`：Node 的定时器句柄类型；`timeoutId.unref()` 让定时器不阻止进程退出。
 * - `Promise<X | undefined>`：可能什么都没有的异步结果，调用方必须判空。
 * - `readonly` 字段、`extends Error`：与 Java 基本一致。
 */
/**
 * XAA IdP Login — acquires an OIDC id_token from an enterprise IdP via the
 * standard authorization_code + PKCE flow, then caches it by IdP issuer.
 *
 * This is the "one browser pop" in the XAA value prop: one IdP login → N silent
 * MCP server auths. The id_token is cached in the keychain and reused until expiry.
 */

import {
  exchangeAuthorization,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  type OAuthClientInformation,
  type OpenIdProviderDiscoveryMetadata,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import { parse } from 'url'
import xss from 'xss'
import { openBrowser } from '../../utils/browser.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { toError } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { buildRedirectUri, findAvailablePort } from './oauthPort.js'

  /**
   * 中文：XAA 功能的总开关（环境变量 CLAUDE_CODE_ENABLE_XAA）。
   * 为什么用环境变量而不是设置项：XAA 还在灰度，且只在企业环境启用，用环境变量最省事。
   */
export function isXaaEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_XAA)
}

  // 中文：IdP 的连接信息（issuer、clientId、可选固定回调端口），来自 settings.xaaIdp，
  //       一次配置、所有 XAA server 共享
export type XaaIdpSettings = {
  issuer: string
  clientId: string
  callbackPort?: number
}

/**
 * Typed accessor for settings.xaaIdp. The field is env-gated in SettingsSchema
 * so it doesn't surface in SDK types/docs — which means the inferred settings
 * type doesn't have it at compile time. This is the one cast.
 */
  /**
   * 中文：读 settings.xaaIdp。
   * 为什么要 as 强转（英文注释说明了）：这个字段在 SettingsSchema 里是环境开关控制的，
   * 所以自动推导出的设置类型里并没有它，只能在这里做唯一的一次强制转换。
   */
export function getXaaIdpSettings(): XaaIdpSettings | undefined {
  return (getInitialSettings() as { xaaIdp?: XaaIdpSettings }).xaaIdp
}

const IDP_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const IDP_REQUEST_TIMEOUT_MS = 30000
const ID_TOKEN_EXPIRY_BUFFER_S = 60
  // 中文：三个超时/缓冲常量：登录整体 5 分钟、单次请求 30 秒、token 到期前 60 秒就当作已过期

export type IdpLoginOptions = {
  idpIssuer: string
  idpClientId: string
  /**
   * Optional IdP client secret for confidential clients. Auth method
   * (client_secret_post, client_secret_basic, none) is chosen per IdP
   * metadata. Omit for public clients (PKCE only).
   */
  idpClientSecret?: string
  /**
   * Fixed callback port. If omitted, a random port is chosen.
   * Use this when the IdP client is pre-registered with a specific loopback
   * redirect URI (RFC 8252 §7.3 says IdPs SHOULD accept any port for
   * http://localhost, but many don't).
   */
  callbackPort?: number
  /** Called with the authorization URL before (or instead of) opening the browser */
  onAuthorizationUrl?: (url: string) => void
  /** If true, don't auto-open the browser — just call onAuthorizationUrl */
  skipBrowserOpen?: boolean
  abortSignal?: AbortSignal
}

/**
 * Normalize an IdP issuer URL for use as a cache key: strip trailing slashes,
 * lowercase host. Issuers from config and from OIDC discovery may differ
 * cosmetically but should hit the same cache slot. Exported so the setup
 * command can compare issuers using the same normalization as keychain ops.
 */
  /**
   * 中文：把 issuer URL 规范化成缓存键（去尾部斜杠 + host 转小写）。
   * 为什么必须规范化：配置里写的 issuer 和 OIDC 发现返回的 issuer 可能只是「长得不一样」
   * （一个带斜杠、一个大写），实际上应该命中同一个缓存槽。
   * 解析失败时退化成「只去尾部斜杠」，保证永远返回一个可用的键。
   */
export function issuerKey(issuer: string): string {
  try {
    const u = new URL(issuer)
    u.pathname = u.pathname.replace(/\/+$/, '')
    u.host = u.host.toLowerCase()
    return u.toString()
  } catch {
    return issuer.replace(/\/+$/, '')
  }
}

/**
 * Read a cached id_token for the given IdP issuer from secure storage.
 * Returns undefined if missing or within ID_TOKEN_EXPIRY_BUFFER_S of expiring.
 */
  /**
   * 中文：从钥匙串里读缓存的 id_token。
   * 返回 undefined 的两种情况：根本没缓存；或距离过期只剩不到 60 秒（留缓冲，
   * 避免「刚取出来就用、路上恰好过期」这种竞态）。
   */
export function getCachedIdpIdToken(idpIssuer: string): string | undefined {
  const storage = getSecureStorage()
  const data = storage.read()
  const entry = data?.mcpXaaIdp?.[issuerKey(idpIssuer)]
  if (!entry) return undefined
  const remainingMs = entry.expiresAt - Date.now()
    // 中文：留 60 秒缓冲——网络往返 + 后续交换都要时间，卡着过期点用必然翻车
  if (remainingMs <= ID_TOKEN_EXPIRY_BUFFER_S * 1000) return undefined
  return entry.idToken
}

  /**
   * 中文：把 id_token 写进钥匙串缓存（按 issuer 分槽）。
   * 注意用展开运算符层层合并：不能整个覆盖 mcpXaaIdp，否则会把其它 IdP 的 token 冲掉。
   */
function saveIdpIdToken(
  idpIssuer: string,
  idToken: string,
  expiresAt: number,
): void {
  const storage = getSecureStorage()
  const existing = storage.read() || {}
  storage.update({
    ...existing,
    mcpXaaIdp: {
      ...existing.mcpXaaIdp,
      [issuerKey(idpIssuer)]: { idToken, expiresAt },
    },
  })
}

/**
 * Save an externally-obtained id_token into the XAA cache — the exact slot
 * getCachedIdpIdToken/acquireIdpIdToken read from. Used by conformance testing
 * where the mock IdP hands us a pre-signed token but doesn't serve /authorize.
 *
 * Parses the JWT's exp claim for cache TTL (same as acquireIdpIdToken).
 * Returns the expiresAt it computed so the caller can report it.
 */
  /**
   * 中文：把「外部已经拿到的」id_token 直接存进缓存（一致性测试用：mock IdP 直接发签名好的 token，
   * 但不提供 /authorize 端点）。存的槽位和 getCachedIdpIdToken 读的是同一个。
   * 返回：算出的 expiresAt（毫秒时间戳），方便调用方展示。
   */
export function saveIdpIdTokenFromJwt(
  idpIssuer: string,
  idToken: string,
): number {
  const expFromJwt = jwtExp(idToken)
  const expiresAt = expFromJwt ? expFromJwt * 1000 : Date.now() + 3600 * 1000
    // 中文：JWT 里没有 exp 就兜底 1 小时——宁可早过期让用户重新登录，也不要永不过期
  saveIdpIdToken(idpIssuer, idToken, expiresAt)
  return expiresAt
}

  // 中文：清除某个 issuer 的 id_token（`claude mcp xaa clear` 用）
export function clearIdpIdToken(idpIssuer: string): void {
  const storage = getSecureStorage()
  const existing = storage.read()
  const key = issuerKey(idpIssuer)
  if (!existing?.mcpXaaIdp?.[key]) return
  delete existing.mcpXaaIdp[key]
  storage.update(existing)
}

/**
 * Save an IdP client secret to secure storage, keyed by IdP issuer.
 * Separate from MCP server AS secrets — different trust domain.
 * Returns the storage update result so callers can surface keychain
 * failures (locked keychain, `security` nonzero exit) instead of
 * silently dropping the secret and failing later with invalid_client.
 */
  /**
   * 中文：存 IdP 的 client secret（按 issuer 分槽）。
   * 为什么要和 MCP server 的 AS secret 分开存（英文注释：different trust domain）：
   * 这是两个不同系统的凭据，混在一起会互相覆盖，也违背最小权限。
   * 返回 { success, warning }：钥匙串可能被锁、或 security 命令非零退出，
   * 必须把失败暴露出来，否则用户要等到后面报 invalid_client 才知道 secret 根本没存上。
   */
export function saveIdpClientSecret(
  idpIssuer: string,
  clientSecret: string,
): { success: boolean; warning?: string } {
  const storage = getSecureStorage()
  const existing = storage.read() || {}
  return storage.update({
    ...existing,
    mcpXaaIdpConfig: {
      ...existing.mcpXaaIdpConfig,
      [issuerKey(idpIssuer)]: { clientSecret },
    },
  })
}

/**
 * Read the IdP client secret for the given issuer from secure storage.
 */
  /**
   * 中文：读某个 issuer 的 IdP client secret。三层可选链一路点到字段，任何一层缺失都是 undefined。
   */
export function getIdpClientSecret(idpIssuer: string): string | undefined {
  const storage = getSecureStorage()
  const data = storage.read()
  return data?.mcpXaaIdpConfig?.[issuerKey(idpIssuer)]?.clientSecret
}

/**
 * Remove the IdP client secret for the given issuer from secure storage.
 * Used by `claude mcp xaa clear`.
 */
  /**
   * 中文：删除某个 issuer 的 IdP client secret（`claude mcp xaa clear` 用）。
   */
export function clearIdpClientSecret(idpIssuer: string): void {
  const storage = getSecureStorage()
  const existing = storage.read()
  const key = issuerKey(idpIssuer)
  if (!existing?.mcpXaaIdpConfig?.[key]) return
  delete existing.mcpXaaIdpConfig[key]
  storage.update(existing)
}

// OIDC Discovery §4.1 says `{issuer}/.well-known/openid-configuration` — path
// APPEND, not replace. `new URL('/.well-known/...', issuer)` with a leading
// slash is a WHATWG absolute-path reference and drops the issuer's pathname,
// breaking Azure AD (`login.microsoftonline.com/{tenant}/v2.0`), Okta custom
// auth servers, and Keycloak realms. Trailing-slash base + relative path is
// the fix. Exported because auth.ts needs the same discovery.
  /**
   * 中文：OIDC 发现——去 {issuer}/.well-known/openid-configuration 拿 IdP 的元数据。
   * ★ 踩坑点（英文注释讲得非常细）：路径是「追加」不是「替换」。
   * 若写成 new URL('/.well-known/...', issuer)，带前导斜杠会被当成绝对路径引用，
   * 从而丢掉 issuer 自带的 pathname——这会直接搞坏 Azure AD（login.microsoftonline.com/{tenant}/v2.0）、
   * Okta 自定义授权服务器、Keycloak realm。正确做法是「保证 base 以 / 结尾 + 相对路径」。
   * 另外两道防线：① 响应必须是 JSON（防止 captive portal / 代理返回 200 + HTML）；
   * ② token_endpoint 必须是 https（否则等于明文送 id_token）。
   */
export async function discoverOidc(
  idpIssuer: string,
): Promise<OpenIdProviderDiscoveryMetadata> {
  const base = idpIssuer.endsWith('/') ? idpIssuer : idpIssuer + '/'
    // 中文：★ 关键一行：先补上尾部斜杠，再用「相对路径」去 new URL，才能保留 issuer 的 pathname
  const url = new URL('.well-known/openid-configuration', base)
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(IDP_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(
      `XAA IdP: OIDC discovery failed: HTTP ${res.status} at ${url}`,
    )
  }
  // Captive portals and proxy auth pages return 200 with HTML. res.json()
  // throws a raw SyntaxError before safeParse can give a useful message.
    // 中文：res.json() 在非 JSON 响应时会抛原始 SyntaxError，先自己解析一遍才能给出有用的报错
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(
      `XAA IdP: OIDC discovery returned non-JSON at ${url} (captive portal or proxy?)`,
    )
  }
  const parsed = OpenIdProviderDiscoveryMetadataSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`XAA IdP: invalid OIDC metadata: ${parsed.error.message}`)
  }
    // 中文：拒绝非 HTTPS 的 token endpoint——否则 id_token 会明文走网络
  if (new URL(parsed.data.token_endpoint).protocol !== 'https:') {
    throw new Error(
      `XAA IdP: refusing non-HTTPS token endpoint: ${parsed.data.token_endpoint}`,
    )
  }
  return parsed.data
}

/**
 * Decode the exp claim from a JWT without verifying its signature.
 * Returns undefined if parsing fails or exp is absent. Used only to
 * derive a cache TTL.
 *
 * Why no signature/iss/aud/nonce validation: per SEP-990, this id_token
 * is the RFC 8693 subject_token in a token-exchange at the IdP's own
 * token endpoint. The IdP validates its own token there. An attacker who
 * can mint a token that fools the IdP has no need to fool us first; an
 * attacker who can't, hands us garbage and gets a 401 from the IdP. The
 * --id-token injection seam is likewise safe: bad input → rejected later,
 * no privesc. Client-side verification would add code and no security.
 */
  /**
   * 中文：从 JWT 里解出 exp 声明（**不验签**），只用来算缓存 TTL。
   * 为什么不验签（英文注释给了完整理由）：按 SEP-990，这个 id_token 随后会作为 RFC 8693 的
   * subject_token 在 IdP 自己的 token endpoint 上做交换——IdP 会在那里验它自己的 token。
   * 能伪造出骗过 IdP 的 token 的攻击者，根本不需要先骗过我们；骗不过 IdP 的，只会拿到 401。
   * 所以客户端验签只是增加代码、不增加安全性。
   */
function jwtExp(jwt: string): number | undefined {
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = jsonParse(
      Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
    ) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp : undefined
  } catch {
    return undefined
  }
}

/**
 * Wait for the OAuth authorization code on a local callback server.
 * Returns the code once /callback is hit with a matching state.
 *
 * `onListening` fires after the socket is actually bound — use it to defer
 * browser-open so EADDRINUSE surfaces before a spurious tab pops open.
 */
  /**
   * 中文：起一个本地回调服务器，等浏览器把授权码带回来。
   * 入参 port / expectedState（防 CSRF 的 state 值）/ abortSignal / onListening 回调。
   * 返回：授权码 code。
   * 为什么要有 onListening：listen() 是异步的，必须先确认端口真的绑上了再开浏览器——
   * 否则会出现「浏览器标签页已经弹出来了，然后才报端口被占用」的尴尬。
   */
function waitForCallback(
  port: number,
  expectedState: string,
  abortSignal: AbortSignal | undefined,
  onListening: () => void,
): Promise<string> {
  let server: Server | null = null
  let timeoutId: NodeJS.Timeout | null = null
  let abortHandler: (() => void) | null = null
    // 中文：统一的清理函数——解绑监听、关服务器、清定时器、摘 abort 监听，
    //       任何一条路径结束（成功/失败/超时/取消）都要调它，避免资源泄漏
  const cleanup = () => {
    server?.removeAllListeners()
    // Defensive: removeAllListeners() strips the error handler, so swallow any late error during close
    server?.on('error', () => {})
    server?.close()
    server = null
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler)
      abortHandler = null
    }
  }
  return new Promise<string>((resolve, reject) => {
    let resolved = false
    // 中文：resolveOnce / rejectOnce 里的 resolved 标记：Promise 只能落定一次，
    //       但超时、abort、回调可能同时到达，必须幂等地只处理第一次
    const resolveOnce = (v: string) => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(v)
    }
    const rejectOnce = (e: Error) => {
      if (resolved) return
      resolved = true
      cleanup()
      reject(e)
    }

    // 中文：abort 支持——用户在授权菜单里按 Esc 时，这里要立刻把等待中的 Promise 打掉
    if (abortSignal) {
      abortHandler = () => rejectOnce(new Error('XAA IdP: login cancelled'))
      if (abortSignal.aborted) {
        abortHandler()
        return
      }
      abortSignal.addEventListener('abort', abortHandler, { once: true })
    }

    // 中文：只认 /callback 这一个路径，其它一律 404（减少回调面被误触的面积）
    server = createServer((req, res) => {
      const parsed = parse(req.url || '', true)
      if (parsed.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }
      const code = parsed.query.code as string | undefined
    // 中文：query 里的值类型是 unknown，这里手动 as 成 string | undefined 再判空
      const state = parsed.query.state as string | undefined
      const err = parsed.query.error as string | undefined

      if (err) {
        const desc = parsed.query.error_description as string | undefined
        const safeErr = xss(err)
    // 中文：错误回显页面必须过 xss() 转义——error/error_description 来自外部，直接拼进 HTML 就是 XSS
        const safeDesc = desc ? xss(desc) : ''
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body><h3>IdP login failed</h3><p>${safeErr}</p><p>${safeDesc}</p></body></html>`,
        )
        rejectOnce(new Error(`XAA IdP: ${err}${desc ? ` — ${desc}` : ''}`))
        return
      }

    // 中文：state 不匹配 = 可能是 CSRF，直接拒绝；这也是 OAuth 的标准防护手段
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h3>State mismatch</h3></body></html>')
        rejectOnce(new Error('XAA IdP: state mismatch (possible CSRF)'))
        return
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h3>Missing code</h3></body></html>')
        rejectOnce(new Error('XAA IdP: callback missing code'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<html><body><h3>IdP login complete — you can close this window.</h3></body></html>',
      )
      resolveOnce(code)
    })

    // 中文：端口被占用要给可执行的排查命令（Windows 用 netstat，其它用 lsof），否则用户无从下手
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
      // 中文：EADDRINUSE 是这类登录最常见的失败原因，单独给出友好提示
        const findCmd =
          getPlatform() === 'windows'
            ? `netstat -ano | findstr :${port}`
            : `lsof -ti:${port} -sTCP:LISTEN`
        rejectOnce(
          new Error(
            `XAA IdP: callback port ${port} is already in use. Run \`${findCmd}\` to find the holder.`,
          ),
        )
      } else {
        rejectOnce(new Error(`XAA IdP: callback server failed: ${err.message}`))
      }
    })

    // 中文：绑到 127.0.0.1（不是 0.0.0.0）：回调只应来自本机的浏览器
    server.listen(port, '127.0.0.1', () => {
      try {
        onListening()
      } catch (e) {
        rejectOnce(toError(e))
      }
    })
    server.unref()
    // 中文：unref() 让这个 server / 定时器不阻止 Node 进程退出（否则登录完 CLI 可能卡住不退出）
    timeoutId = setTimeout(
      rej => rej(new Error('XAA IdP: login timed out')),
      IDP_LOGIN_TIMEOUT_MS,
      rejectOnce,
    )
    timeoutId.unref()
  })
}

/**
 * Acquire an id_token from the IdP: return cached if valid, otherwise run
 * the full OIDC authorization_code + PKCE flow (one browser pop).
 */
  /**
   * 中文：★ 拿到 IdP 的 id_token——有缓存就用缓存，没有就跑完整的 OIDC 授权码 + PKCE。
   * 入参 opts：issuer、clientId、可选 clientSecret、可选固定回调端口、
   *   onAuthorizationUrl（拿到授权 URL 先回调，便于测试/非浏览器环境）、skipBrowserOpen、abortSignal。
   * 步骤：① 查缓存 → ② OIDC 发现 → ③ 挑端口、生成随机 state → ④ startAuthorization 拼授权 URL + PKCE
   *      → ⑤ 起回调服务器等 code（绑定成功后才开浏览器）→ ⑥ 用 code + codeVerifier 换 token
   *      → ⑦ 算过期时间并写缓存。
   * 这就是 XAA 宣传的「the one browser pop」：整个会话里用户只需要这一次浏览器交互。
   */
export async function acquireIdpIdToken(
  opts: IdpLoginOptions,
): Promise<string> {
  const { idpIssuer, idpClientId } = opts

  const cached = getCachedIdpIdToken(idpIssuer)
    // 中文：缓存命中直接返回——这正是 XAA 的价值：N 个 MCP server 共享同一次登录
  if (cached) {
    logMCPDebug('xaa', `Using cached id_token for ${idpIssuer}`)
    return cached
  }

  logMCPDebug('xaa', `No cached id_token for ${idpIssuer}; starting OIDC login`)

  const metadata = await discoverOidc(idpIssuer)
    // 中文：OIDC 发现拿到 IdP 的 authorization_endpoint / token_endpoint 等元数据
  const port = opts.callbackPort ?? (await findAvailablePort())
  const redirectUri = buildRedirectUri(port)
  const state = randomBytes(32).toString('base64url')
    // 中文：32 字节随机 state，用于防 CSRF；回调时必须原样带回来
  const clientInformation: OAuthClientInformation = {
    client_id: idpClientId,
    ...(opts.idpClientSecret ? { client_secret: opts.idpClientSecret } : {}),
      // 中文：条件展开——有 secret 才加这个字段（公开客户端只用 PKCE，不需要 secret）
  }

    // 中文：SDK 的 startAuthorization 负责拼授权 URL 并生成 PKCE 的 code_verifier
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    idpIssuer,
    {
      metadata,
      clientInformation,
      redirectUrl: redirectUri,
      scope: 'openid',
      state,
    },
  )

  // Open the browser only after the socket is actually bound — listen() is
  // async, and on the fixed-callbackPort path EADDRINUSE otherwise surfaces
  // after a spurious tab has already popped. Mirrors the auth.ts pattern of
  // wrapping sdkAuth inside server.listen's callback.
    // 中文：★ 把「开浏览器」放在 waitForCallback 的 onListening 里——端口真绑上了才开，
    //       避免端口冲突时先弹了个没用的标签页
  const authorizationCode = await waitForCallback(
    port,
    state,
    opts.abortSignal,
    () => {
      if (opts.onAuthorizationUrl) {
        opts.onAuthorizationUrl(authorizationUrl.toString())
      }
      if (!opts.skipBrowserOpen) {
        logMCPDebug('xaa', `Opening browser to IdP authorization endpoint`)
        void openBrowser(authorizationUrl.toString())
      }
    },
  )

    // 中文：用授权码 + PKCE verifier 去 token endpoint 换 token（这一步不需要浏览器）
  const tokens = await exchangeAuthorization(idpIssuer, {
    metadata,
    clientInformation,
    authorizationCode,
    codeVerifier,
    redirectUri,
    fetchFn: (url, init) =>
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(IDP_REQUEST_TIMEOUT_MS),
      }),
  })
    // 中文：没有 id_token 通常是 scope 少了 openid，报错里直接点出来，省得用户查半天
  if (!tokens.id_token) {
    throw new Error(
      'XAA IdP: token response missing id_token (check scope=openid)',
    )
  }

  // Prefer the id_token's own exp claim; fall back to expires_in.
  // expires_in is for the access_token and may differ from the id_token
  // lifetime. If neither is present, default to 1h.
    // 中文：优先用 id_token 自己的 exp；expires_in 描述的是 access_token 的寿命，两者可能不同
  const expFromJwt = jwtExp(tokens.id_token)
  const expiresAt = expFromJwt
    ? expFromJwt * 1000
    : Date.now() + (tokens.expires_in ?? 3600) * 1000

  saveIdpIdToken(idpIssuer, tokens.id_token, expiresAt)
  logMCPDebug(
    'xaa',
    `Cached id_token for ${idpIssuer} (expires ${new Date(expiresAt).toISOString()})`,
  )

  return tokens.id_token
}
  // 中文：把 AS 的 issuer 一并返回——后续 refresh / revoke 要靠它定位端点，
  //       因为「MCP server 的 URL」通常并不是「AS 的 URL」
