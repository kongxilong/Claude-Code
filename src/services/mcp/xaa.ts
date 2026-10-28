/**
 * 【一句话定位】XAA / SEP-990 的令牌交换核心：把 IdP 的 id_token 换成 MCP server 的 access_token，全程无浏览器。
 *
 * 【两段式交换（本文件的核心）】
 *   ① RFC 8693 Token Exchange（在 IdP）：id_token → ID-JAG
 *      ID-JAG = Identity Assertion Authorization Grant，一张「IdP 替用户背书」的短期断言。
 *   ② RFC 7523 JWT Bearer Grant（在 AS）：ID-JAG → access_token
 *      MCP server 的授权服务器认这张断言，直接发 access_token。
 * 整个过程用户不需要再点任何同意按钮——这就是 XAA 相对普通 OAuth 的差别。
 *
 * 【在架构中的位置】
 * - 上游：auth.ts（performMCPXaaAuth、ClaudeAuthProvider.xaaRefresh、revokeServerTokens）。
 * - 下游：MCP SDK 的 discoverOAuthProtectedResourceMetadata / discoverAuthorizationServerMetadata。
 * - 兄弟模块：xaaIdpLogin.ts 负责第 0 步（拿到 id_token）。
 *
 * 【分层结构（英文头注里的 Layer-2 / Layer-3）】
 * Layer 2 是四个独立的小操作，刻意对齐 TS SDK PR #1593 的形状，方便将来换成 SDK 实现：
 *   - discoverProtectedResource（RFC 9728 PRM 发现）
 *   - discoverAuthorizationServer（RFC 8414 AS 元数据发现）
 *   - requestJwtAuthorizationGrant（令牌交换：id_token → ID-JAG）
 *   - exchangeJwtAuthGrant（JWT Bearer：ID-JAG → access_token）
 * Layer 3 只有 performCrossAppAccess 一个编排函数，把上面四个串起来。
 *
 * 【本文件包含什么】
 * - makeXaaFetch / normalizeUrl / redactTokens：三个工具函数。
 * - XaaTokenExchangeError：带 shouldClearIdToken 标记的专用异常。
 * - 上列四个 Layer-2 函数 + performCrossAppAccess。
 *
 * 【TS 语法速查】
 * - `export class X extends Error`：自定义异常，≈ Java 的 extends RuntimeException；
 *   `readonly` 字段 ≈ final 字段。
 * - `z.coerce.number()`：zod 的「先转换再校验」，容忍把 "3600" 这种字符串当数字（兼容不规范的 IdP）。
 * - `new URLSearchParams({...})`：构造表单请求体 ≈ Java 的 URLEncodedFormEntity。
 * - `AbortSignal.any([a, b])`：把多个取消信号合成一个（超时 + 用户取消），
 *   ≈ Java 里手动用 CompletableFuture.anyOf 或组合 CancellationException。
 * - `opts?.fetchFn ?? defaultFetch`：可选链 + 空值合并连写，实现「没传就用默认」。
 * - `A & B` 交叉类型：`XaaResult = XaaTokenResult & { authorizationServerUrl: string }`，
 *   表示「在 XaaTokenResult 基础上再加一个字段」。
 * - `async function` 里 `for...of` + `await`：串行地逐个尝试（不是并发），因为要「按顺序挑第一个可用」。
 */
/**
 * Cross-App Access (XAA) / Enterprise Managed Authorization (SEP-990)
 *
 * Obtains an MCP access token WITHOUT a browser consent screen by chaining:
 *   1. RFC 8693 Token Exchange at the IdP: id_token → ID-JAG
 *   2. RFC 7523 JWT Bearer Grant at the AS: ID-JAG → access_token
 *
 * Spec refs:
 *   - ID-JAG (IETF draft): https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
 *   - MCP ext-auth (SEP-990): https://github.com/modelcontextprotocol/ext-auth
 *   - RFC 8693 (Token Exchange), RFC 7523 (JWT Bearer), RFC 9728 (PRM)
 *
 * Reference impl: ~/code/mcp/conformance/examples/clients/typescript/everything-client.ts:375-522
 *
 * Structure: four Layer-2 ops (aligned with TS SDK PR #1593's Layer-2 shapes so
 * a future SDK swap is mechanical) + one Layer-3 orchestrator that composes them.
 */

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPDebug } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const XAA_REQUEST_TIMEOUT_MS = 30000

  // 中文：下面四个 URN 是 OAuth 协议里约定的固定标识符（grant type / token type），不能写错
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

/**
 * Creates a fetch wrapper that enforces the XAA request timeout and optionally
 * composes a caller-provided abort signal. Using AbortSignal.any ensures the
 * user's cancel (e.g. Esc in the auth menu) actually aborts in-flight requests
 * rather than being clobbered by the timeout signal.
 */
  /**
   * 中文：造一个带超时、且能响应用户取消的 fetch。
   * 为什么必须用 AbortSignal.any（英文注释说明了）：如果只用超时信号，用户在授权菜单里按 Esc 时，
   * 已经发出去的请求不会被真正中止（超时信号会把用户的取消信号「顶掉」）。
   */
function makeXaaFetch(abortSignal?: AbortSignal): FetchLike {
  return (url, init) => {
    const timeout = AbortSignal.timeout(XAA_REQUEST_TIMEOUT_MS)
    const signal = abortSignal
      ? // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        AbortSignal.any([timeout, abortSignal])
      // 中文：AbortSignal.any = 任意一个信号触发就整体 abort；超时 + 用户取消两不误
      : timeout
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    return fetch(url, { ...init, signal })
  }
}

const defaultFetch = makeXaaFetch()

/**
 * RFC 8414 §3.3 / RFC 9728 §3.3 identifier comparison. Roundtrip through URL
 * to apply RFC 3986 §6.2.2 syntax-based normalization (lowercases scheme+host,
 * drops default port), then strip trailing slash.
 */
  /**
   * 中文：按 RFC 3986 规范化 URL（scheme/host 转小写、去掉默认端口、去尾部斜杠）。
   * 用途：比较「配置里的 issuer」和「发现文档里的 issuer」是否真的是同一个（防 mix-up 攻击）。
   */
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href.replace(/\/$/, '')
  } catch {
    return url.replace(/\/$/, '')
  }
}

/**
 * Thrown by requestJwtAuthorizationGrant when the IdP token-exchange leg
 * fails. Carries `shouldClearIdToken` so callers can decide whether to drop
 * the cached id_token based on OAuth error semantics (not substring matching):
 *   - 4xx / invalid_grant / invalid_token → id_token is bad, clear it
 *   - 5xx → IdP is down, id_token may still be valid, keep it
 *   - 200 with structurally-invalid body → protocol violation, clear it
 */
  /**
   * 中文：令牌交换失败的专用异常，多带一个 shouldClearIdToken 标记。
   * 为什么要用标记而不是在调用方去匹配错误字符串（英文注释说明了三种语义）：
   *   4xx / invalid_grant / invalid_token → id_token 本身有问题，应该清缓存；
   *   5xx → IdP 挂了，id_token 可能还是好的，别清；
   *   200 但响应结构不对 → 协议违规，清掉。
   */
export class XaaTokenExchangeError extends Error {
  readonly shouldClearIdToken: boolean
  constructor(message: string, shouldClearIdToken: boolean) {
    super(message)
    this.name = 'XaaTokenExchangeError'
    this.shouldClearIdToken = shouldClearIdToken
  }
}

// Matches quoted values for known token-bearing keys regardless of nesting
// depth. Works on both parsed-then-stringified bodies AND raw text() error
// bodies from !res.ok paths — a misbehaving AS that echoes the request's
// subject_token/assertion/client_secret in a 4xx error envelope must not leak
// into debug logs.
  // 中文：脱敏正则——把日志/报错里出现的 token 类字段整体替换成 [REDACTED]。
  //       为什么连 raw text 也要处理：不规矩的 AS 会在 4xx 的错误体里把请求中的
  //       subject_token / assertion / client_secret 原样回显，直接打日志就是凭据泄露
const SENSITIVE_TOKEN_RE =
  /"(access_token|refresh_token|id_token|assertion|subject_token|client_secret)"\s*:\s*"[^"]*"/g

  /**
   * 中文：把任意对象/字符串里的敏感 token 字段打码，供日志与异常消息使用。
   */
function redactTokens(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : jsonStringify(raw)
  return s.replace(SENSITIVE_TOKEN_RE, (_, k) => `"${k}":"[REDACTED]"`)
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

  // 中文：令牌交换响应的 schema。access_token 其实叫 access_token，但它承载的是 ID-JAG。
const TokenExchangeResponseSchema = lazySchema(() =>
  z.object({
    access_token: z.string().optional(),
    issued_token_type: z.string().optional(),
    // z.coerce tolerates IdPs that send expires_in as a string (common in
    // PHP-backed IdPs) — technically non-conformant JSON but widespread.
    expires_in: z.coerce.number().optional(),
    // 中文：z.coerce 容忍 expires_in 是字符串的情况（PHP 系的 IdP 很常见，虽然不合规范）
    scope: z.string().optional(),
  }),
)

  // 中文：JWT Bearer 响应的 schema。
const JwtBearerResponseSchema = lazySchema(() =>
  z.object({
    access_token: z.string().min(1),
    // Many ASes omit token_type since Bearer is the only value anyone uses
    // (RFC 6750). Don't reject a valid access_token over a missing label.
    token_type: z.string().default('Bearer'),
    // 中文：token_type 给默认值 Bearer——很多 AS 懒得发这个字段，不该因此拒绝一个合法的 token
    expires_in: z.coerce.number().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().optional(),
  }),
)

// ─── Layer 2: Discovery ─────────────────────────────────────────────────────

export type ProtectedResourceMetadata = {
  resource: string
  authorization_servers: string[]
}

/**
 * RFC 9728 PRM discovery via SDK, plus RFC 9728 §3.3 resource-mismatch
 * validation (mix-up protection — TODO: upstream to SDK).
 */
  /**
   * 中文：Layer 2 之一——RFC 9728 的受保护资源元数据（PRM）发现。
   * PRM 告诉我们：这个 MCP server 对应的 resource 是谁、它信任哪些 AS。
   * 额外的 resource 一致性校验是为了防 mix-up 攻击（SDK 目前还没做，英文注释里标了 TODO）。
   */
export async function discoverProtectedResource(
  serverUrl: string,
  opts?: { fetchFn?: FetchLike },
): Promise<ProtectedResourceMetadata> {
  let prm
  try {
    prm = await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      undefined,
      opts?.fetchFn ?? defaultFetch,
    )
  } catch (e) {
    throw new Error(
      `XAA: PRM discovery failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!prm.resource || !prm.authorization_servers?.[0]) {
    throw new Error(
      'XAA: PRM discovery failed: PRM missing resource or authorization_servers',
    )
  }
    // 中文：PRM 里声明的 resource 必须与我们请求的 serverUrl 一致，否则可能是被「调包」的元数据
  if (normalizeUrl(prm.resource) !== normalizeUrl(serverUrl)) {
    throw new Error(
      `XAA: PRM discovery failed: PRM resource mismatch: expected ${serverUrl}, got ${prm.resource}`,
    )
  }
  return {
    resource: prm.resource,
    authorization_servers: prm.authorization_servers,
  }
}

export type AuthorizationServerMetadata = {
  issuer: string
  token_endpoint: string
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

/**
 * AS metadata discovery via SDK (RFC 8414 + OIDC fallback), plus RFC 8414
 * §3.3 issuer-mismatch validation (mix-up protection — TODO: upstream to SDK).
 */
  /**
   * 中文：Layer 2 之一——RFC 8414 的授权服务器（AS）元数据发现。
   * 两道额外校验：issuer 必须与请求的 AS URL 一致（防 mix-up）；token_endpoint 必须 HTTPS
   * ——后者尤其重要，否则我们等于把 id_token 和 client_secret 明文 POST 出去。
   */
export async function discoverAuthorizationServer(
  asUrl: string,
  opts?: { fetchFn?: FetchLike },
): Promise<AuthorizationServerMetadata> {
  const meta = await discoverAuthorizationServerMetadata(asUrl, {
    fetchFn: opts?.fetchFn ?? defaultFetch,
  })
  if (!meta?.issuer || !meta.token_endpoint) {
    throw new Error(
      `XAA: AS metadata discovery failed: no valid metadata at ${asUrl}`,
    )
  }
    // 中文：issuer 不一致就拒绝，防元数据被调包（mix-up）
  if (normalizeUrl(meta.issuer) !== normalizeUrl(asUrl)) {
    throw new Error(
      `XAA: AS metadata discovery failed: issuer mismatch: expected ${asUrl}, got ${meta.issuer}`,
    )
  }
  // RFC 8414 §3.3 / RFC 9728 §3 require HTTPS. A PRM-advertised http:// AS
  // that self-consistently reports an http:// issuer would pass the mismatch
  // check above, then we'd POST id_token + client_secret over plaintext.
    // 中文：★ 必须 HTTPS。注意：即使上面 issuer 校验通过也不能代替这条检查——
    //       一个自称 http:// 的 AS 可以自洽地通过 issuer 比对，然后让我们明文送凭据
  if (new URL(meta.token_endpoint).protocol !== 'https:') {
    throw new Error(
      `XAA: refusing non-HTTPS token endpoint: ${meta.token_endpoint}`,
    )
  }
  return {
    issuer: meta.issuer,
    token_endpoint: meta.token_endpoint,
    grant_types_supported: meta.grant_types_supported,
    token_endpoint_auth_methods_supported:
      meta.token_endpoint_auth_methods_supported,
  }
}

// ─── Layer 2: Exchange ──────────────────────────────────────────────────────

export type JwtAuthGrantResult = {
  /** The ID-JAG (Identity Assertion Authorization Grant) */
  jwtAuthGrant: string
  expiresIn?: number
  scope?: string
}

/**
 * RFC 8693 Token Exchange at the IdP: id_token → ID-JAG.
 * Validates `issued_token_type` is `urn:ietf:params:oauth:token-type:id-jag`.
 *
 * `clientSecret` is optional — sent via `client_secret_post` if present.
 * Some IdPs register the client as confidential even when they advertise
 * `token_endpoint_auth_method: "none"`.
 *
 * TODO(xaa-ga): consult `token_endpoint_auth_methods_supported` from IdP
 * OIDC metadata and support `client_secret_basic`, mirroring the AS-side
 * selection in `performCrossAppAccess`. All major IdPs accept POST today.
 */
  /**
   * 中文：Layer 2 之一——RFC 8693 令牌交换：拿 id_token 去 IdP 换 ID-JAG。
   * 入参里 audience 是 AS 的 issuer（说明这张断言给谁用）、resource 是 MCP server 的 resource。
   * 返回 { jwtAuthGrant, expiresIn?, scope? }。
   * clientSecret 可选：有就走 client_secret_post（有些 IdP 虽然声明 auth method 是 none，
   * 实际却把 client 注册成了 confidential）。
   * 失败时抛 XaaTokenExchangeError，并带好「要不要清 id_token 缓存」的判断。
   */
export async function requestJwtAuthorizationGrant(opts: {
  tokenEndpoint: string
  audience: string
  resource: string
  idToken: string
  clientId: string
  clientSecret?: string
  scope?: string
  fetchFn?: FetchLike
}): Promise<JwtAuthGrantResult> {
  const fetchFn = opts.fetchFn ?? defaultFetch
  const params = new URLSearchParams({
    // 中文：令牌交换的参数全是表单字段；subject_token 放的就是用户的 id_token
    grant_type: TOKEN_EXCHANGE_GRANT,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    audience: opts.audience,
    resource: opts.resource,
    subject_token: opts.idToken,
    subject_token_type: ID_TOKEN_TYPE,
    client_id: opts.clientId,
  })
    // 中文：有 secret 才加——公开客户端只靠 PKCE，不需要 secret
  if (opts.clientSecret) {
    params.set('client_secret', opts.clientSecret)
  }
  if (opts.scope) {
    params.set('scope', opts.scope)
  }

  const res = await fetchFn(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
    // 中文：非 2xx 时只读 text()（不能假设是 JSON），并且必须先脱敏再进日志
  if (!res.ok) {
    const body = redactTokens(await res.text()).slice(0, 200)
      // 中文：截断到 200 字符——错误体可能很长，日志里没必要全留
    // 4xx → id_token rejected (invalid_grant etc.), clear cache.
    // 5xx → IdP outage, id_token may still be valid, preserve it.
    const shouldClear = res.status < 500
      // 中文：<500 表示「我们这边的问题（token 不被接受）」，清缓存；>=500 是 IdP 故障，保留缓存
    throw new XaaTokenExchangeError(
      `XAA: token exchange failed: HTTP ${res.status}: ${body}`,
      shouldClear,
    )
  }
  let rawExchange: unknown
  try {
    rawExchange = await res.json()
  } catch {
    // Transient network condition (captive portal, proxy) — don't clear id_token.
    throw new XaaTokenExchangeError(
      `XAA: token exchange returned non-JSON (captive portal?) at ${opts.tokenEndpoint}`,
      false,
    )
  }
  const exchangeParsed = TokenExchangeResponseSchema().safeParse(rawExchange)
  if (!exchangeParsed.success) {
    throw new XaaTokenExchangeError(
      `XAA: token exchange response did not match expected shape: ${redactTokens(rawExchange)}`,
      true,
    )
  }
  const result = exchangeParsed.data
  if (!result.access_token) {
    throw new XaaTokenExchangeError(
      `XAA: token exchange response missing access_token: ${redactTokens(result)}`,
      true,
    )
  }
    // 中文：issued_token_type 必须是 id-jag——否则说明 IdP 给的并不是我们要的那张断言
  if (result.issued_token_type !== ID_JAG_TOKEN_TYPE) {
    throw new XaaTokenExchangeError(
      `XAA: token exchange returned unexpected issued_token_type: ${result.issued_token_type}`,
      true,
    )
  }
  return {
    jwtAuthGrant: result.access_token,
    expiresIn: result.expires_in,
    scope: result.scope,
  }
}

export type XaaTokenResult = {
  access_token: string
  token_type: string
  expires_in?: number
  scope?: string
  refresh_token?: string
}

export type XaaResult = XaaTokenResult & {
  /**
   * The AS issuer URL discovered via PRM. Callers must persist this as
   * `discoveryState.authorizationServerUrl` so that refresh (auth.ts _doRefresh)
   * and revocation (revokeServerTokens) can locate the token/revocation
   * endpoints — the MCP URL is not the AS URL in typical XAA setups.
   */
  authorizationServerUrl: string
}

/**
 * RFC 7523 JWT Bearer Grant at the AS: ID-JAG → access_token.
 *
 * `authMethod` defaults to `client_secret_basic` (Base64 header, not body
 * params) — the SEP-990 conformance test requires this. Only set
 * `client_secret_post` if the AS explicitly requires it.
 */
  /**
   * 中文：Layer 2 之一——RFC 7523 JWT Bearer：拿 ID-JAG 去 AS 换 access_token。
   * authMethod 默认 client_secret_basic（放 Base64 的 Authorization 头，不放请求体），
   * 因为 SEP-990 的一致性测试要求这么做；只有 AS 明确不支持 basic 时才退回 post。
   */
export async function exchangeJwtAuthGrant(opts: {
  tokenEndpoint: string
  assertion: string
  clientId: string
  clientSecret: string
  authMethod?: 'client_secret_basic' | 'client_secret_post'
  scope?: string
  fetchFn?: FetchLike
}): Promise<XaaTokenResult> {
  const fetchFn = opts.fetchFn ?? defaultFetch
  const authMethod = opts.authMethod ?? 'client_secret_basic'
    // 中文：?? 空值合并——没指定就用 basic（注意别写成 ||，虽然这里两者效果相同）

  const params = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT,
    assertion: opts.assertion,
  })
  if (opts.scope) {
    params.set('scope', opts.scope)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
    // 中文：basic 方式把 client_id:client_secret 做 Base64 放进 Authorization 头
  if (authMethod === 'client_secret_basic') {
    const basicAuth = Buffer.from(
      `${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`,
    ).toString('base64')
    headers.Authorization = `Basic ${basicAuth}`
  } else {
    params.set('client_id', opts.clientId)
    params.set('client_secret', opts.clientSecret)
  }

  const res = await fetchFn(opts.tokenEndpoint, {
    method: 'POST',
    headers,
    body: params,
  })
    // 中文：这里失败不需要区分要不要清 id_token——ID-JAG 是短命的，直接重来即可
  if (!res.ok) {
    const body = redactTokens(await res.text()).slice(0, 200)
    throw new Error(`XAA: jwt-bearer grant failed: HTTP ${res.status}: ${body}`)
  }
  let rawTokens: unknown
  try {
    rawTokens = await res.json()
  } catch {
    throw new Error(
      `XAA: jwt-bearer grant returned non-JSON (captive portal?) at ${opts.tokenEndpoint}`,
    )
  }
  const tokensParsed = JwtBearerResponseSchema().safeParse(rawTokens)
  if (!tokensParsed.success) {
    throw new Error(
      `XAA: jwt-bearer response did not match expected shape: ${redactTokens(rawTokens)}`,
    )
  }
  return tokensParsed.data
}

// ─── Layer 3: Orchestrator ──────────────────────────────────────────────────

/**
 * Config needed to run the full XAA orchestrator.
 * Mirrors the conformance test context shape (see ClientConformanceContextSchema).
 */
  /**
   * 中文：跑完整 XAA 所需的配置（两个系统各一套 clientId/secret，加上用户的 id_token 和 IdP 端点）。
   */
export type XaaConfig = {
  /** Client ID registered at the MCP server's authorization server */
  clientId: string
  /** Client secret for the MCP server's authorization server */
  clientSecret: string
  /** Client ID registered at the IdP (for the token-exchange request) */
  idpClientId: string
  /** Optional IdP client secret (client_secret_post) — some IdPs require it */
  idpClientSecret?: string
  /** The user's OIDC id_token from the IdP login */
  idpIdToken: string
  /** IdP token endpoint (where to send the RFC 8693 token-exchange) */
  idpTokenEndpoint: string
}

/**
 * Full XAA flow: PRM → AS metadata → token-exchange → jwt-bearer → access_token.
 * Thin composition of the four Layer-2 ops. Used by performMCPXaaAuth,
 * ClaudeAuthProvider.xaaRefresh, and the try-xaa*.ts debug scripts.
 *
 * @param serverUrl The MCP server URL (e.g. `https://mcp.example.com/mcp`)
 * @param config IdP + AS credentials
 * @param serverName Server name for debug logging
 */
  /**
   * 中文：★ Layer 3 编排函数——把四个 Layer-2 操作串成完整流程。
   * 入参 serverUrl（MCP server 的 URL）、config（见 XaaConfig）、serverName（日志用）、abortSignal。
   * 步骤：① PRM 发现 → ② 逐个尝试 PRM 声明的 AS，挑第一个支持 jwt-bearer 的 →
   *      ③ 用 id_token 换 ID-JAG → ④ 用 ID-JAG 换 access_token → ⑤ 带上 AS issuer 一起返回。
   * 为什么 AS 要「逐个试」：PRM 可能声明多个 AS，而 grant_types_supported 在 RFC 8414 里是可选字段，
   * 所以只有「明确声明了但不包含 jwt-bearer」的才跳过，没声明的交给 token endpoint 自己决定。
   */
export async function performCrossAppAccess(
  serverUrl: string,
  config: XaaConfig,
  serverName = 'xaa',
  abortSignal?: AbortSignal,
): Promise<XaaResult> {
  const fetchFn = makeXaaFetch(abortSignal)

  logMCPDebug(serverName, `XAA: discovering PRM for ${serverUrl}`)
  const prm = await discoverProtectedResource(serverUrl, { fetchFn })
  logMCPDebug(
    serverName,
    `XAA: discovered resource=${prm.resource} ASes=[${prm.authorization_servers.join(', ')}]`,
  )

  // Try each advertised AS in order. grant_types_supported is OPTIONAL per
  // RFC 8414 §2 — only skip if the AS explicitly advertises a list that omits
  // jwt-bearer. If absent, let the token endpoint decide.
  let asMeta: AuthorizationServerMetadata | undefined
  const asErrors: string[] = []
    // 中文：按 PRM 声明的顺序串行尝试；用户 abort 时立刻抛出，不再试后面的
  for (const asUrl of prm.authorization_servers) {
    let candidate: AuthorizationServerMetadata
    try {
      candidate = await discoverAuthorizationServer(asUrl, { fetchFn })
    } catch (e) {
      if (abortSignal?.aborted) throw e
      asErrors.push(`${asUrl}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    // 中文：grant_types_supported 是可选字段——只有明确不含 jwt-bearer 才跳过
    if (
      candidate.grant_types_supported &&
      !candidate.grant_types_supported.includes(JWT_BEARER_GRANT)
    ) {
      asErrors.push(
        `${asUrl}: does not advertise jwt-bearer grant (supported: ${candidate.grant_types_supported.join(', ')})`,
      )
      continue
    }
    asMeta = candidate
    break
  }
  if (!asMeta) {
    throw new Error(
      `XAA: no authorization server supports jwt-bearer. Tried: ${asErrors.join('; ')}`,
    )
  }
  // Pick auth method from what the AS advertises. We handle
  // client_secret_basic and client_secret_post; if the AS only supports post,
  // honor that, else default to basic (SEP-990 conformance expectation).
    // 中文：AS 说只支持 post 就顺从它；否则一律用 basic（一致性测试的期望）
  const authMethods = asMeta.token_endpoint_auth_methods_supported
  const authMethod: 'client_secret_basic' | 'client_secret_post' =
    authMethods &&
    !authMethods.includes('client_secret_basic') &&
    authMethods.includes('client_secret_post')
      ? 'client_secret_post'
      : 'client_secret_basic'
  logMCPDebug(
    serverName,
    `XAA: AS issuer=${asMeta.issuer} token_endpoint=${asMeta.token_endpoint} auth_method=${authMethod}`,
  )

  logMCPDebug(serverName, `XAA: exchanging id_token for ID-JAG at IdP`)
    // 中文：第 ① 段交换：id_token → ID-JAG（audience 指向刚选定的 AS）
  const jag = await requestJwtAuthorizationGrant({
    tokenEndpoint: config.idpTokenEndpoint,
    audience: asMeta.issuer,
    resource: prm.resource,
    idToken: config.idpIdToken,
    clientId: config.idpClientId,
    clientSecret: config.idpClientSecret,
    fetchFn,
  })
  logMCPDebug(serverName, `XAA: ID-JAG obtained`)

  logMCPDebug(serverName, `XAA: exchanging ID-JAG for access_token at AS`)
    // 中文：第 ② 段交换：ID-JAG → access_token，至此拿到能访问 MCP server 的令牌
  const tokens = await exchangeJwtAuthGrant({
    tokenEndpoint: asMeta.token_endpoint,
    assertion: jag.jwtAuthGrant,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authMethod,
    fetchFn,
  })
  logMCPDebug(serverName, `XAA: access_token obtained`)

  return { ...tokens, authorizationServerUrl: asMeta.issuer }
}
