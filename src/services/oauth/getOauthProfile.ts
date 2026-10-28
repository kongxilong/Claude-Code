/**
 * 【一句话定位】
 * 用两种不同凭证去拉用户资料（profile）：要么用 API Key，要么用 OAuth access token。
 * 拿到的是订阅等级、限流档位、组织信息等，供上层判断「这个用户能用哪些能力」。
 *
 * 【在架构中的位置】
 * 调用链：
 *   oauth/client.ts 的 fetchProfileInfo() / getOrganizationUUID() / populateOAuthAccountInfoIfNeeded()
 *     → 本文件 getOauthProfileFromOauthToken()（用 OAuth token 拉，主路径）
 *   utils/auth.ts 等（API Key 用户）
 *     → 本文件 getOauthProfileFromApiKey()（用 API Key 拉，兼容路径）
 * 下游：axios（HTTP 客户端）+ constants/oauth.js（端点与 beta 头配置）。
 *
 * 【两种凭证的区别】
 * - OAuth access token：交互式登录后拿到的短期凭证，用 Authorization: Bearer 头（标准 OAuth 用法）。
 * - API Key：控制台生成的长期密钥，用 x-api-key 头（Anthropic 私有约定）。
 * 两者打的是不同的接口路径，所以拆成两个函数。
 *
 * 【本文件包含什么】
 * - getOauthProfileFromApiKey()：用 API Key + accountUuid 拉资料。
 * - getOauthProfileFromOauthToken()：用 access token 拉资料（主路径）。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `export async function f(): Promise<OAuthProfileResponse | undefined> {`：
 *   async 函数返回 Promise<T>；`T | undefined` 表示「可能拿不到」。
 *   ≈ Java 的 `CompletableFuture<Optional<X>>`，只是 TS 用联合类型 + 编译期判空代替 Optional。
 * - `axios.get<OAuthProfileResponse>(endpoint, {...})`：
 *   尖括号里的是【泛型参数】——指定响应体的类型。调用后 response.data 就自动是这个类型。
 *   ≈ Java 的 `restTemplate.exchange(url, OAuthProfileResponse.class)` 里的那个 class 参数。
 * - `const endpoint = \`${getOauthConfig().BASE_API_URL}/api/oauth/profile\``：
 *   反引号是模板字符串，`${}` 里可以写表达式。≈ Java 15+ 的文本块或 String.format，但更灵活。
 * - `headers: { Authorization: \`Bearer ${accessToken}\` }`：
 *   对象字面量里键可以不加引号（除非有连字符，如 'x-api-key' 就必须加引号）。
 *   这就是为什么下面 `x-api-key` 带引号而 `Authorization` 不带——连字符不是合法标识符。
 * - `params: { account_uuid: accountUuid }`：axios 的 params 会被拼成 URL 查询串（?account_uuid=xxx）。
 *   ≈ Java 里用 UriComponentsBuilder 手动拼 query 参数。
 * - `timeout: 10000`：10 秒超时，防止网络挂起把 CLI 卡死。
 * - `catch (error) { logError(error as Error) }`：吞掉异常只记日志，然后【隐式返回 undefined】。
 *   这是本文件的关键设计：拉资料失败不该让整个登录/启动流程崩掉，返回 undefined 让上层自己决定。
 *   Java 里必须写 `return null;`，TS 里函数没有 return 就等于返回 undefined。
 * - `import ... from 'src/constants/oauth.js'`：以 `src/` 开头的绝对路径导入，
 *   依赖构建配置里的路径别名。≈ Java 里配了 source root 之后直接写包全路径。
 */
import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from 'src/constants/oauth.js'
import type { OAuthProfileResponse } from 'src/services/oauth/types.js'
import { getAnthropicApiKey } from 'src/utils/auth.js'
import { getGlobalConfig } from 'src/utils/config.js'
import { logError } from 'src/utils/log.js'
// 中文补充：给「用 API Key 登录」的用户拉资料。
// 前提：必须同时有 accountUuid（本地配置里有）和 apiKey，缺一不可，直接返回 undefined。
export async function getOauthProfileFromApiKey(): Promise<
  OAuthProfileResponse | undefined
> {
  // Assumes interactive session
  const config = getGlobalConfig()
  const accountUuid = config.oauthAccount?.accountUuid
  const apiKey = getAnthropicApiKey()

  // Need both account UUID and API key to check
// 两个凭证缺一个就没法查，直接返回 undefined（不是抛错）——上层会优雅降级。
  if (!accountUuid || !apiKey) {
    return
  }
// 注意：用 API Key 走的是另一个端点（claude_cli_profile），和 OAuth 的不是同一个。
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli_profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        'x-api-key': apiKey,
// anthropic-beta 头：用于开启尚未正式发布的能力，Anthropic 的惯例做法。
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      params: {
        account_uuid: accountUuid,
      },
      timeout: 10000,
    })
    return response.data
// 失败只记日志、返回 undefined：拉资料是「锦上添花」，不该因为它失败就让用户登不进去。
  } catch (error) {
    logError(error as Error)
  }
}

// 主路径：用 OAuth access token 拉资料（标准 Bearer 用法）。
// @param accessToken OAuth 短期凭证
// @returns 资料对象；失败返回 undefined（已记日志）
// 调用前提：token 必须带 user:profile 这个 scope，否则会被 403（上层用 hasProfileScope() 判断）。
export async function getOauthProfileFromOauthToken(
  accessToken: string,
): Promise<OAuthProfileResponse | undefined> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/oauth/profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })
    return response.data
// 同样是「吞异常」策略：网络抖一下不该让 CLI 崩，让调用方按 undefined 处理。
  } catch (error) {
    logError(error as Error)
  }
}
