// OAuth client for handling authentication flows with Claude services
/**
 * 【一句话定位】
 * OAuth 2.0 授权码 + PKCE 流程的「协议客户端」：拼授权 URL、用授权码换 token、用 refresh token 续期、
 * 拉用户资料/角色/API Key，并把账号信息落盘到全局配置。
 *
 * 【在架构中的位置】
 * 调用链：
 *   登录命令 / 需要鉴权的请求
 *     → 同目录 index.ts（编排整个登录流程：起本地监听 → 打开浏览器 → 收回调）
 *       → 本文件 buildAuthUrl() / exchangeCodeForTokens()（协议细节）
 *       → auth-code-listener.ts（本地端口监听，接收浏览器回调带回来的 code）
 *       → crypto.ts（生成 PKCE 的 code_verifier / code_challenge）
 *   日常使用：
 *     utils/auth.ts 的 checkAndRefreshOAuthTokenIfNeeded() → 本文件 refreshOAuthToken()
 *     → getOauthProfile.ts（用 access token 拉 profile）
 * 下游依赖：axios（HTTP 客户端，≈ Java 的 OkHttp/RestTemplate）、constants/oauth.js（端点配置）。
 *
 * 【CLI 场景下 OAuth + PKCE 是怎么跑通的（重点）】
 * 传统 Web 应用做 OAuth：有服务端、有固定回调地址、有 client_secret，三样齐全。
 * CLI（命令行工具）三样都没有，所以：
 * 1. 没有 client_secret → 用 PKCE（Proof Key for Code Exchange）代替。
 *    做法：本地随机生成一个 code_verifier（高熵随机串），再算 code_challenge = BASE64URL(SHA256(verifier))。
 *    ① 授权请求时只发 challenge（hash 值，泄露也没用）
 *    ② 换 token 时才把原始的 verifier 发出去，服务端重新算一次 hash 比对
 *    这样即使授权码被中间人截获，他没有 verifier 也换不到 token。
 *    Java 类比：相当于把 client_secret 换成「每次登录临时生成的一次性密钥对」。
 * 2. 没有固定回调服务器 → 临时在本机起一个 HTTP 服务监听随机端口，回调地址写成
 *    http://localhost:<随机端口>/callback。浏览器跳回来时从 query 里取 code，然后立刻关掉这个服务。
 *    （见本目录 auth-code-listener.ts）
 * 3. 无浏览器环境（SSH、容器）→ 退化成「手动模式」：把授权 URL 打印出来让用户自己打开，
 *    登录成功后把页面上的 code 粘回终端。这就是 MANUAL_REDIRECT_URL 的用途。
 * 4. state 参数：防 CSRF。随机生成并比对，防止攻击者诱导用户用攻击者的授权码登录。
 *
 * 【本文件包含什么】
 * - shouldUseClaudeAIAuth() / parseScopes()：scope（权限范围）的判断与解析小工具。
 * - buildAuthUrl()：拼出完整的授权页 URL（含 PKCE challenge、state、回调地址）。
 * - exchangeCodeForTokens()：用授权码 + verifier 换 access/refresh token（PKCE 校验在这里生效）。
 * - refreshOAuthToken()：用 refresh token 续期，顺带更新订阅信息到配置。
 * - fetchAndStoreUserRoles()：拉组织/工作区角色并存配置。
 * - createAndStoreApiKey()：用 access token 换一个长期 API Key 存起来。
 * - isOAuthTokenExpired()：判断是否（快）过期。
 * - fetchProfileInfo()：拉 profile 并翻译成内部订阅类型（max/pro/enterprise/team）。
 * - getOrganizationUUID()：三级降级拿组织 UUID（配置 → 本地 token 缓存 → 网络请求）。
 * - populateOAuthAccountInfoIfNeeded() / storeOAuthAccountInfo()：账号信息落盘（带内容比对去重）。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `function f({ a, b }: { a: string; b?: number })`：参数解构 + 内联类型。
 *   调用方写 `f({ a: 'x' })`，等价于 Java 里传一个只有 getter 的 DTO，但不用先定义类。
 *   `b?: number` 的 `?` = 可选 ≈ Java 的重载或 Builder 里可省略的字段。
 * - `useManualRedirect: boolean = false`：默认参数值，和 Java 没有（Java 要写重载）。
 * - `Record<string, string | number>`：键为 string、值为 string 或 number 的对象。
 *   ≈ Java 的 `Map<String, Object>`（但 TS 能精确约束只能是这两种类型）。
 * - `Boolean(scopes?.includes(X))`：`?.` 可选链——scopes 为 undefined 时整条表达式短路成 undefined，
 *   再被 Boolean() 转成 false。≈ Java 的 `scopes != null && scopes.contains(X)`。
 * - `scopeString?.split(' ').filter(Boolean) ?? []`：
 *   `??` 空值合并（左边是 null/undefined 才取右边）+ `.filter(Boolean)` 是「过滤掉空串」的惯用法
 *   （把 Boolean 当函数传给 filter，空串会被判为假值而剔除）。
 * - 解构时重命名：`const { access_token: accessToken, refresh_token: newRefreshToken = refreshToken } = data`：
 *   把蛇形命名的字段转成驼峰，并给缺失值一个默认（refresh_token 没返回就沿用旧的）。
 *   ≈ Java 的 `var accessToken = data.getAccessToken(); var nr = data.getRefreshToken() != null ? ... : old;`
 * - `const updates: Partial<AccountInfo> = {}`：`Partial<T>` 是内置工具类型，
 *   把 T 的所有属性都变成可选。≈ Java 里「只填了部分字段的 Builder」。
 * - `saveGlobalConfig(current => ({ ...current, oauthAccount: {...} }))`：
 *   `...` 对象展开 = 浅拷贝后覆盖同名字段，是「不可变更新」的标准写法。
 *   ≈ Java `new Config(current, updatedAccount)`（不修改原对象，返回新对象）。
 *   入参是一个函数（updater），由 saveGlobalConfig 负责读旧值→调用→写回，类似 Java 的 UnaryOperator。
 * - `profileInfo?.subscriptionType ?? existing?.subscriptionType ?? null`：
 *   `??` 可以链式串联，表示「一级一级兜底，全都没有就是 null」。
 *   注意不能用 `||`：因为 0 和 '' 也会被替换掉（这里 subscriptionType 是字符串， safer 用 ??）。
 * - `axios.isAxiosError(error) && error.response?.data`：
 *   axios.isAxiosError 是「类型守卫（type guard）」，判断后 TS 自动把 error 收窄成 AxiosError，
 *   于是才能访问 .response。≈ Java 的 `if (e instanceof AxiosError ax) { ... }` 模式匹配。
 * - `...(responseBody && { responseBody: ... })`：条件展开。
 *   条件为假时展开「空」，于是这个字段就不出现在对象里——实现「有值才带这个字段」。
 *   这是往对象里「条件性加字段」的常用技巧，比 Java 的 `if (x) map.put(...)` 更紧凑。
 * - `as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`：
 *   这是一个「品牌类型（branded type）」，用来标记「这个值已经人工确认过不是代码/路径，可以安全上报」。
 *   编译期约束手段，运行期就是普通字符串。名字很长是刻意的——逼你每次都意识到自己在绕过隐私检查。
 * - `error instanceof Error ? error.message : String(error)`：
 *   instanceof 和 Java 一样；String(x) ≈ String.valueOf(x)。
 * - `let subscriptionType: SubscriptionType | null = null` 配合 switch：
 *   TS 的 switch 每个 case 要写 break（和 Java 一样会穿透）。
 * - `data.account ? { uuid: data.account.uuid, ... } : undefined`：
 *   三元表达式返回对象或 undefined，实现「有就构造、没有就留空」。
 * - `await axios.post(url, body, { headers: {...}, timeout: 15000 })`：
 *   第三个参数是配置对象（命名可选参数）。Java 没有命名参数，只能靠 Builder。
 * - `response.data`：axios 把响应体解析成 JS 对象放在 .data。≈ RestTemplate 的 getBody()。
 */
import axios from 'axios'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  ALL_OAUTH_SCOPES,
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  getOauthConfig,
} from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
  saveApiKey,
} from '../../utils/auth.js'
import type { AccountInfo } from '../../utils/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOauthProfileFromOauthToken } from './getOauthProfile.js'
import type {
  BillingType,
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
  UserRolesResponse,
} from './types.js'

/**
 * Check if the user has Claude.ai authentication scope
 * @private Only call this if you're OAuth / auth related code!
 */
// 中文补充：判断用户是否有「claude.ai 推理」权限范围。
// scope（权限范围）是 OAuth 的核心概念：token 上带着一串 scope，服务端据此决定这个 token 能干什么。
export function shouldUseClaudeAIAuth(scopes: string[] | undefined): boolean {
  return Boolean(scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE))
}

// 把服务端返回的 'a b c' 这种空格分隔字符串解析成数组。
// `.filter(Boolean)` 过滤掉连续空格产生的空串；`?? []` 保证入参为空时返回空数组而不是 undefined。
export function parseScopes(scopeString?: string): string[] {
  return scopeString?.split(' ').filter(Boolean) ?? []
}

// 拼授权页 URL——整个 PKCE 流程的「第一步」。
// @param codeChallenge  由 code_verifier 算出的 SHA256+BASE64URL 摘要（见 crypto.ts），只发摘要不发原文
// @param state          随机串，防 CSRF；回调时原样带回，必须比对一致
// @param port           本地临时监听端口，回调地址就是 http://localhost:<port>/callback
// @param isManual       手动模式（无浏览器环境）：改用固定的 MANUAL_REDIRECT_URL，用户自己粘 code
// @param inferenceOnly  只要推理权限（换取更长有效期、权限更窄的 token，最小权限原则）
// @returns 完整的授权页 URL，交给浏览器打开（或打印给用户）
// 关键步骤：① 选端点 ② 逐个 append 查询参数 ③ 按需追加 orgUUID/login_hint/login_method
export function buildAuthUrl({
  codeChallenge,
  state,
  port,
  isManual,
  loginWithClaudeAi,
  inferenceOnly,
  orgUUID,
  loginHint,
  loginMethod,
}: {
  codeChallenge: string
  state: string
  port: number
  isManual: boolean
  loginWithClaudeAi?: boolean
  inferenceOnly?: boolean
  orgUUID?: string
  loginHint?: string
  loginMethod?: string
}): string {
  const authUrlBase = loginWithClaudeAi
    ? getOauthConfig().CLAUDE_AI_AUTHORIZE_URL
    : getOauthConfig().CONSOLE_AUTHORIZE_URL

  const authUrl = new URL(authUrlBase)
// code=true 是 Claude 自己的私有参数：告诉登录页展示 Max 套餐的升级引导。
  authUrl.searchParams.append('code', 'true') // this tells the login page to show Claude Max upsell
  authUrl.searchParams.append('client_id', getOauthConfig().CLIENT_ID)
// response_type=code：明确走「授权码模式」（而不是已废弃的 implicit 隐式模式）。
  authUrl.searchParams.append('response_type', 'code')
// 回调地址必须与换取 token 时传的 redirect_uri【完全一致】——OAuth 规范强制校验，
// 差一个字符都会被拒。所以这里和 exchangeCodeForTokens 用同一套计算逻辑。
  authUrl.searchParams.append(
    'redirect_uri',
    isManual
      ? getOauthConfig().MANUAL_REDIRECT_URL
      : `http://localhost:${port}/callback`,
  )
// 最小权限原则：只要能调推理就只申请那一个 scope，别一次性要全部权限。
  const scopesToUse = inferenceOnly
    ? [CLAUDE_AI_INFERENCE_SCOPE] // Long-lived inference-only tokens
    : ALL_OAUTH_SCOPES
  authUrl.searchParams.append('scope', scopesToUse.join(' '))
// code_challenge + code_challenge_method=S256 —— 这就是 PKCE 的核心两行。
// S256 表示 challenge 是用 SHA-256 算的（不能写 plain，那样等于没保护）。
  authUrl.searchParams.append('code_challenge', codeChallenge)
  authUrl.searchParams.append('code_challenge_method', 'S256')
  authUrl.searchParams.append('state', state)

  // Add orgUUID as URL param if provided
  if (orgUUID) {
    authUrl.searchParams.append('orgUUID', orgUUID)
  }

  // Pre-populate email on the login form (standard OIDC parameter)
  if (loginHint) {
// login_hint 是标准 OIDC 参数：预填邮箱，省得用户再输一遍。
    authUrl.searchParams.append('login_hint', loginHint)
  }

  // Request a specific login method (e.g. 'sso', 'magic_link', 'google')
  if (loginMethod) {
    authUrl.searchParams.append('login_method', loginMethod)
  }

  return authUrl.toString()
}

// PKCE 流程的「第二步」：用授权码换 token。这里是整个流程里唯一需要「证明你是发起者」的地方。
// @param authorizationCode 浏览器回调带回来的授权码（一次性、有效期极短）
// @param state             原样回传的防 CSRF 随机串
// @param codeVerifier      PKCE 的原始随机串（第一步只发了它的 hash，现在才亮出来）
// @param port              必须和第一步用的端口一致，否则 redirect_uri 对不上会被拒
// @returns access_token / refresh_token / expires_in / scope 等
// 服务端校验逻辑（帮助理解为什么需要 verifier）：
//   BASE64URL(SHA256(code_verifier)) === 第一步收到的 code_challenge ? 通过 : 拒绝
// 所以截获了 code 的攻击者，因为拿不到 verifier，换不到 token。
export async function exchangeCodeForTokens(
  authorizationCode: string,
  state: string,
  codeVerifier: string,
  port: number,
  useManualRedirect: boolean = false,
  expiresIn?: number,
): Promise<OAuthTokenExchangeResponse> {
  const requestBody: Record<string, string | number> = {
    grant_type: 'authorization_code',
    code: authorizationCode,
// redirect_uri 必须和授权请求时一字不差，这是 OAuth 的硬性校验（防授权码被换到别的地址）
    redirect_uri: useManualRedirect
      ? getOauthConfig().MANUAL_REDIRECT_URL
      : `http://localhost:${port}/callback`,
    client_id: getOauthConfig().CLIENT_ID,
    code_verifier: codeVerifier,
    state,
  }

  if (expiresIn !== undefined) {
    requestBody.expires_in = expiresIn
  }

// 15 秒超时：CLI 不能因为网络卡死就永久挂着，宁可报错让用户重试。
  const response = await axios.post(getOauthConfig().TOKEN_URL, requestBody, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  })

  if (response.status !== 200) {
    throw new Error(
// 401 单独提示：这是最常见的情况（授权码已用过/已过期），给一句人能看懂的话比抛状态码有用。
      response.status === 401
        ? 'Authentication failed: Invalid authorization code'
        : `Token exchange failed (${response.status}): ${response.statusText}`,
    )
  }
  logEvent('tengu_oauth_token_exchange_success', {})
  return response.data
}

// 用 refresh token 续期（access token 通常只有几小时，refresh token 可以活很久）。
// @param refreshToken    长期凭证
// @param requestedScopes 可选，指定这次想申请的权限范围
// @returns 新的完整凭证包（含订阅类型、限流档位等，供上层判断用户等级）
// 关键步骤：
// ① 用 grant_type=refresh_token 换新 token
// ② 判断本地是否已有完整资料，有就跳过一次 profile 网络请求（省 700 万次/天的请求量）
// ③ 有变更才写回全局配置
// ④ 组装返回：优先用新拉的 profile，没有就沿用旧值（绝不把已有信息抹成 null）
export async function refreshOAuthToken(
  refreshToken: string,
  { scopes: requestedScopes }: { scopes?: string[] } = {},
): Promise<OAuthTokens> {
  const requestBody = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: getOauthConfig().CLIENT_ID,
    // Request specific scopes, defaulting to the full Claude AI set. The
    // backend's refresh-token grant allows scope expansion beyond what the
    // initial authorize granted (see ALLOWED_SCOPE_EXPANSIONS), so this is
    // safe even for tokens issued before scopes were added to the app's
    // registered oauth_scope.
// 后端允许 refresh 时「扩权」（ALLOWED_SCOPE_EXPANSIONS），所以默认申请全套 scope 是安全的，
// 老 token 也能借刷新拿到新权限。
    scope: (requestedScopes?.length
      ? requestedScopes
      : CLAUDE_AI_OAUTH_SCOPES
    ).join(' '),
  }

  try {
    const response = await axios.post(getOauthConfig().TOKEN_URL, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    })

    if (response.status !== 200) {
      throw new Error(`Token refresh failed: ${response.statusText}`)
    }

    const data = response.data as OAuthTokenExchangeResponse
// 解构的同时做「蛇形 → 驼峰」重命名；refresh_token 没返回就沿用旧的（服务端经常不返回新的）。
    const {
      access_token: accessToken,
      refresh_token: newRefreshToken = refreshToken,
      expires_in: expiresIn,
    } = data

// expires_in 是「多少秒后过期」（相对值），换算成绝对时间戳存起来，判断时直接比大小。
    const expiresAt = Date.now() + expiresIn * 1000
    const scopes = parseScopes(data.scope)

    logEvent('tengu_oauth_token_refresh_success', {})

    // Skip the extra /api/oauth/profile round-trip when we already have both
    // the global-config profile fields AND the secure-storage subscription data.
    // Routine refreshes satisfy both, so we cut ~7M req/day fleet-wide.
    //
    // Checking secure storage (not just config) matters for the
    // CLAUDE_CODE_OAUTH_REFRESH_TOKEN re-login path: installOAuthTokens runs
    // performLogout() AFTER we return, wiping secure storage. If we returned
    // null for subscriptionType here, saveOAuthTokensIfNeeded would persist
    // null ?? (wiped) ?? null = null, and every future refresh would see the
    // config guard fields satisfied and skip again, permanently losing the
    // subscription type for paying users. By passing through existing values,
    // the re-login path writes cached ?? wiped ?? null = cached; and if secure
    // storage was already empty we fall through to the fetch.
// 性能优化：绝大多数 refresh 只是「续期」，用户资料并没有变，没必要每次都再拉一次 profile。
// 必须同时检查「全局配置」和「安全存储里的订阅数据」两个来源——只查一个会在重装/重登录路径上
// 把付费用户的订阅类型永久抹成 null（详见上方英文注释里那段很长的踩坑说明）。
    const config = getGlobalConfig()
    const existing = getClaudeAIOAuthTokens()
    const haveProfileAlready =
      config.oauthAccount?.billingType !== undefined &&
      config.oauthAccount?.accountCreatedAt !== undefined &&
      config.oauthAccount?.subscriptionCreatedAt !== undefined &&
      existing?.subscriptionType != null &&
      existing?.rateLimitTier != null

// 已有完整资料 → profileInfo 为 null，下面就不更新、也不覆盖（保留原值）。
    const profileInfo = haveProfileAlready
      ? null
      : await fetchProfileInfo(accessToken)

    // Update the stored properties if they have changed
    if (profileInfo && config.oauthAccount) {
// Partial<AccountInfo>：只装「真正变化了的字段」，避免把 undefined 写进去覆盖掉已有值。
      const updates: Partial<AccountInfo> = {}
      if (profileInfo.displayName !== undefined) {
        updates.displayName = profileInfo.displayName
      }
      if (typeof profileInfo.hasExtraUsageEnabled === 'boolean') {
        updates.hasExtraUsageEnabled = profileInfo.hasExtraUsageEnabled
      }
// 注意这里是 `!== null` 而不是 `!== undefined`：billingType 为 null 表示「明确查到没有」，
// undefined 表示「这次没查到」——后者不该覆盖旧值。
      if (profileInfo.billingType !== null) {
        updates.billingType = profileInfo.billingType
      }
      if (profileInfo.accountCreatedAt !== undefined) {
        updates.accountCreatedAt = profileInfo.accountCreatedAt
      }
      if (profileInfo.subscriptionCreatedAt !== undefined) {
        updates.subscriptionCreatedAt = profileInfo.subscriptionCreatedAt
      }
      if (Object.keys(updates).length > 0) {
        saveGlobalConfig(current => ({
          ...current,
          oauthAccount: current.oauthAccount
            ? { ...current.oauthAccount, ...updates }
            : current.oauthAccount,
        }))
      }
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
      scopes,
// 三级兜底：新拉的 profile → 本地已有值 → null。
// 顺序不能反：宁可沿用旧值，也不能因为这次没拉到就把用户信息清空。
      subscriptionType:
        profileInfo?.subscriptionType ?? existing?.subscriptionType ?? null,
      rateLimitTier:
        profileInfo?.rateLimitTier ?? existing?.rateLimitTier ?? null,
      profile: profileInfo?.rawProfile,
      tokenAccount: data.account
        ? {
            uuid: data.account.uuid,
            emailAddress: data.account.email_address,
            organizationUuid: data.organization?.uuid,
          }
        : undefined,
    }
  } catch (error) {
// 失败上报：把响应体也带上（里面有 error 描述），方便定位是 token 过期还是被吊销。
// 只上报错误信息，绝不上报 token 本身——埋点的隐私红线。
    const responseBody =
      axios.isAxiosError(error) && error.response?.data
        ? JSON.stringify(error.response.data)
        : undefined
    logEvent('tengu_oauth_token_refresh_failure', {
      error: (error as Error)
        .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(responseBody && {
        responseBody:
          responseBody as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
    throw error
  }
}

// 拉用户的组织/工作区角色并存进配置（用于权限判断，比如谁能管 billing）。
// 注意：这需要先有 user:profile 权限，没有的话上层要提前拦住。
export async function fetchAndStoreUserRoles(
  accessToken: string,
): Promise<void> {
  const response = await axios.get(getOauthConfig().ROLES_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.status !== 200) {
    throw new Error(`Failed to fetch user roles: ${response.statusText}`)
  }
  const data = response.data as UserRolesResponse
  const config = getGlobalConfig()

  if (!config.oauthAccount) {
    throw new Error('OAuth account information not found in config')
  }

// 不可变更新：展开旧配置、只替换 oauthAccount 这一个字段。
// `current.oauthAccount ? {...} : current.oauthAccount`：没有账号信息就原样保留，不凭空造一个。
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: current.oauthAccount
      ? {
          ...current.oauthAccount,
          organizationRole: data.organization_role,
          workspaceRole: data.workspace_role,
          organizationName: data.organization_name,
        }
      : current.oauthAccount,
  }))

  logEvent('tengu_oauth_roles_stored', {
    org_role:
      data.organization_role as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

// 用短期 access token 换一个长期 API Key 存起来（方便 SDK/自动化场景使用）。
// 返回 null 表示服务端没给 key（不是错误）。
export async function createAndStoreApiKey(
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await axios.post(getOauthConfig().API_KEY_URL, null, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    const apiKey = response.data?.raw_key
    if (apiKey) {
      await saveApiKey(apiKey)
      logEvent('tengu_oauth_api_key', {
        status:
          'success' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        statusCode: response.status,
      })
      return apiKey
    }
    return null
  } catch (error) {
    logEvent('tengu_oauth_api_key', {
      status:
        'failure' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error: (error instanceof Error
        ? error.message
        : String(
            error,
          )) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    throw error
  }
}

// 判断是否过期，但预留 5 分钟缓冲。
// 为什么：从「判断没过期」到「请求真的到达服务端」之间可能有网络延迟、重试，
// 不留缓冲的话会出现「刚判断没过期，请求到服务端时正好过期」的边界抖动。
// expiresAt 为 null 表示「永不过期」，直接返回 false。
export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) {
    return false
  }

  const bufferTime = 5 * 60 * 1000
  const now = Date.now()
  const expiresWithBuffer = now + bufferTime
  return expiresWithBuffer >= expiresAt
}

// 拉 profile 并翻译成内部枚举（'max'/'pro'/'enterprise'/'team'）。
// 为什么要翻译：服务端返回的是 organization_type 这种原始字段，
// 内部各处（限流、功能开关）需要一个稳定的枚举值来分支。
export async function fetchProfileInfo(accessToken: string): Promise<{
  subscriptionType: SubscriptionType | null
  displayName?: string
  rateLimitTier: RateLimitTier | null
  hasExtraUsageEnabled: boolean | null
  billingType: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  rawProfile?: OAuthProfileResponse
}> {
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const orgType = profile?.organization?.organization_type

  // Reuse the logic from fetchSubscriptionType
  let subscriptionType: SubscriptionType | null = null
// 未知的组织类型一律返回 null（而不是抛错）：新套餐上线时老版本 CLI 不该崩，只是「不认识」而已。
  switch (orgType) {
    case 'claude_max':
      subscriptionType = 'max'
      break
    case 'claude_pro':
      subscriptionType = 'pro'
      break
    case 'claude_enterprise':
      subscriptionType = 'enterprise'
      break
    case 'claude_team':
      subscriptionType = 'team'
      break
    default:
      // Return null for unknown organization types
      subscriptionType = null
      break
  }

  const result: {
    subscriptionType: SubscriptionType | null
    displayName?: string
    rateLimitTier: RateLimitTier | null
    hasExtraUsageEnabled: boolean | null
    billingType: BillingType | null
    accountCreatedAt?: string
    subscriptionCreatedAt?: string
  } = {
    subscriptionType,
// `?? null`：字段缺失时统一归成 null。注意这里不能用 ||，否则 false（has_extra_usage_enabled）
// 会被误当成缺失——布尔 false 是合法值，必须保留。
    rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
    hasExtraUsageEnabled:
      profile?.organization?.has_extra_usage_enabled ?? null,
    billingType: profile?.organization?.billing_type ?? null,
  }

// 可选字段只在「真的有值」时才挂上去（用 if 而不是直接赋值 undefined），
// 这样下游用 `!== undefined` 判断时语义才准确。
  if (profile?.account?.display_name) {
    result.displayName = profile.account.display_name
  }

  if (profile?.account?.created_at) {
    result.accountCreatedAt = profile.account.created_at
  }

  if (profile?.organization?.subscription_created_at) {
    result.subscriptionCreatedAt = profile.organization.subscription_created_at
  }

  logEvent('tengu_oauth_profile_fetch_success', {})

  return { ...result, rawProfile: profile }
}

/**
 * Gets the organization UUID from the OAuth access token
 * @returns The organization UUID or null if not authenticated
 */
// 三级降级拿组织 UUID：全局配置（最快）→ 本地 token 缓存（无需网络）→ 发请求拉 profile（最准但最慢）。
// 这种「从快到慢、从本地到远程」的降级链是这类工具函数的典型写法。
export async function getOrganizationUUID(): Promise<string | null> {
  // Check global config first to avoid unnecessary API call
  const globalConfig = getGlobalConfig()
  const orgUUID = globalConfig.oauthAccount?.organizationUuid
  if (orgUUID) {
    return orgUUID
  }

  // Restored/dev builds may have token metadata populated without the full
  // config write path. Prefer local token-derived values before making a
  // profile request or giving up.
  const cachedTokens = getClaudeAIOAuthTokens()
  const tokenOrgUUID =
    cachedTokens?.tokenAccount?.organizationUuid ??
    cachedTokens?.profile?.organization?.uuid
  if (tokenOrgUUID) {
    return tokenOrgUUID
  }

  // Fall back to fetching from profile (requires user:profile scope)
  const accessToken = cachedTokens?.accessToken
// 没有 user:profile 权限就不浪费一次网络请求——请求了也会被 403。
  if (accessToken === undefined || !hasProfileScope()) {
    return null
  }
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const profileOrgUUID = profile?.organization?.uuid
  if (!profileOrgUUID) {
    return null
  }
  return profileOrgUUID
}

/**
 * Populate the OAuth account info if it has not already been cached in config.
 * @returns Whether or not the oauth account info was populated.
 */
// 补齐账号信息（供埋点、权限判断使用）。返回是否真的写入了。
// 关键步骤：
// ① 先看环境变量（SDK 调用方可直接注入，完全免网络，还能消除早期埋点缺账号信息的竞态）
// ② 等一下可能在飞的 token 刷新（它本身就会拉并写入 profile，避免重复请求）
// ③ 配置里三个关键字段都齐了 / 不是订阅用户 / 没权限 → 直接返回 false
// ④ 否则拉 profile 并落盘
export async function populateOAuthAccountInfoIfNeeded(): Promise<boolean> {
  // Check env vars first (synchronous, no network call needed).
  // SDK callers like Cowork can provide account info directly, which also
  // eliminates the race condition where early telemetry events lack account info.
  // NB: If/when adding additional SDK-relevant functionality requiring _other_ OAuth account properties,
  // please reach out to #proj-cowork so the team can add additional env var fallbacks.
  const envAccountUuid = process.env.CLAUDE_CODE_ACCOUNT_UUID
  const envUserEmail = process.env.CLAUDE_CODE_USER_EMAIL
  const envOrganizationUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID
  const hasEnvVars = Boolean(
    envAccountUuid && envUserEmail && envOrganizationUuid,
  )
  if (envAccountUuid && envUserEmail && envOrganizationUuid) {
    if (!getGlobalConfig().oauthAccount) {
      storeOAuthAccountInfo({
        accountUuid: envAccountUuid,
        emailAddress: envUserEmail,
        organizationUuid: envOrganizationUuid,
      })
    }
  }

  // Wait for any in-flight token refresh to complete first, since
  // refreshOAuthToken already fetches and stores profile info
// refreshOAuthToken 内部已经会拉 profile 并写入，先等它结束可以避免重复请求 + 写入竞争。
  await checkAndRefreshOAuthTokenIfNeeded()

  const config = getGlobalConfig()
// 三个字段都齐说明资料已完整，不必再拉；不是订阅用户或没权限，拉了也没用。
  if (
    (config.oauthAccount &&
      config.oauthAccount.billingType !== undefined &&
      config.oauthAccount.accountCreatedAt !== undefined &&
      config.oauthAccount.subscriptionCreatedAt !== undefined) ||
    !isClaudeAISubscriber() ||
    !hasProfileScope()
  ) {
    return false
  }

  const tokens = getClaudeAIOAuthTokens()
  if (tokens?.accessToken) {
    const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
    if (profile) {
// profile 拉到了就以服务端为准，覆盖环境变量提供的信息（环境变量只是兜底）。
      if (hasEnvVars) {
        logForDebugging(
          'OAuth profile fetch succeeded, overriding env var account info',
          { level: 'info' },
        )
      }
      storeOAuthAccountInfo({
        accountUuid: profile.account.uuid,
        emailAddress: profile.account.email,
        organizationUuid: profile.organization.uuid,
        displayName: profile.account.display_name || undefined,
        hasExtraUsageEnabled:
          profile.organization.has_extra_usage_enabled ?? false,
        billingType: profile.organization.billing_type ?? undefined,
        accountCreatedAt: profile.account.created_at,
        subscriptionCreatedAt:
          profile.organization.subscription_created_at ?? undefined,
      })
      return true
    }
  }
  return false
}

// 写入账号信息，但【先内容比对再决定写不写】。
// 为什么要比对：oauthAccount 是个对象，引用比较永远不等（每次都是新对象），
// 不比对的话每次都会触发一次磁盘写入 + 唤醒文件监听，纯属浪费。
export function storeOAuthAccountInfo({
  accountUuid,
  emailAddress,
  organizationUuid,
  displayName,
  hasExtraUsageEnabled,
  billingType,
  accountCreatedAt,
  subscriptionCreatedAt,
}: {
  accountUuid: string
  emailAddress: string
  organizationUuid: string | undefined
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}): void {
  const accountInfo: AccountInfo = {
    accountUuid,
    emailAddress,
    organizationUuid,
    hasExtraUsageEnabled,
    billingType,
    accountCreatedAt,
    subscriptionCreatedAt,
  }
  if (displayName) {
    accountInfo.displayName = displayName
  }
// saveGlobalConfig 接一个 updater 函数（老值 → 新值），由它负责读改写回。
// ≈ Java 的 config.compute(current -> newConfig)。
// 内容完全一致就返回 current（同一个引用），上层据此判断「没变化、不落盘」。
  saveGlobalConfig(current => {
    // For oauthAccount we need to compare content since it's an object
    if (
      current.oauthAccount?.accountUuid === accountInfo.accountUuid &&
      current.oauthAccount?.emailAddress === accountInfo.emailAddress &&
      current.oauthAccount?.organizationUuid === accountInfo.organizationUuid &&
      current.oauthAccount?.displayName === accountInfo.displayName &&
      current.oauthAccount?.hasExtraUsageEnabled ===
        accountInfo.hasExtraUsageEnabled &&
      current.oauthAccount?.billingType === accountInfo.billingType &&
      current.oauthAccount?.accountCreatedAt === accountInfo.accountCreatedAt &&
      current.oauthAccount?.subscriptionCreatedAt ===
        accountInfo.subscriptionCreatedAt
    ) {
      return current
    }
    return { ...current, oauthAccount: accountInfo }
  })
}
