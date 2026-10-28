/**
 * 【一句话定位】从 claude.ai 拉取「组织级 MCP server 配置」，把它们变成 Claude Code 能连的 server 配置。
 *
 * 【在架构中的位置】
 * - 上游：config.ts 组装最终 MCP server 列表时，把这里返回的 claudeai-proxy 配置并入；
 *   /mcp 命令、登录流程（登录成功后要清缓存）。
 * - 下游：axios（发 HTTP）、getClaudeAIOAuthTokens（读 OAuth token）、client.ts 的 clearMcpAuthCache()。
 *
 * 【本文件包含什么】
 * - fetchClaudeAIMcpConfigsIfEligible：用 lodash memoize 包住的主函数，一次会话只拉一次。
 * - clearClaudeAIMcpConfigsCache()：登录/登出后清缓存（同时清 MCP 鉴权缓存）。
 * - markClaudeAiMcpConnected(name) / hasClaudeAiMcpEverConnected(name)：记录「这个 connector 曾经连上过」。
 *
 * 【为什么需要“曾经连上过”这个记录】
 * 启动时要不要提示「N 个 connector 不可用/需要授权」？如果一个 connector 昨天还好好的、今天挂了，
 * 那是状态变化，值得提示；如果它从被配置出来那天起就一直没授权，说明用户早就知道并忽略了，不该反复打扰。
 *
 * 【TS 语法速查】
 * - `memoize(async () => {...})`：lodash 的备忘录，把 async 函数的结果按「无参」缓存住，
 *   ≈ Java 里手写的懒加载单例；`xxx.cache.clear?.()` 用来清缓存。
 * - `tokens.scopes?.includes('user:mcp_servers')`：可选链 + 数组包含判断 ≈ tokens.getScopes().contains(...)。
 * - `catch { ... }`：不接异常变量的 catch（这里刻意吞掉所有失败，网络问题不应影响本地启动）。
 * - `{ ...current, field: value }`：展开 + 覆盖，不可变更新的标准写法（不修改原对象）。
 * - `as AnalyticsMetadata_...`：`as` 是编译期类型断言（强制转换），运行时什么都不做。
 */
import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import { getOauthConfig } from 'src/constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getClaudeAIOAuthTokens } from 'src/utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvDefinedFalsy } from 'src/utils/envUtils.js'
import { clearMcpAuthCache } from './client.js'
import { normalizeNameForMCP } from './normalization.js'
import type { ScopedMcpServerConfig } from './types.js'

  // 中文：下面两个 type 只是给 axios 的响应体「贴类型」，编译后完全不存在（≈ Java 的 DTO，但零运行时开销）
type ClaudeAIMcpServer = {
  type: 'mcp_server'
  id: string
  display_name: string
  url: string
  created_at: string
}

type ClaudeAIMcpServersResponse = {
  data: ClaudeAIMcpServer[]
  has_more: boolean
  next_page: string | null
}

  // 中文：5 秒超时——拉取组织配置是启动路径上的额外网络请求，不能让用户干等
const FETCH_TIMEOUT_MS = 5000
const MCP_SERVERS_BETA_HEADER = 'mcp-servers-2025-12-04'

/**
 * Fetches MCP server configurations from Claude.ai org configs.
 * These servers are managed by the organization via Claude.ai.
 *
 * Results are memoized for the session lifetime (fetch once per CLI session).
 */
  /**
   * 中文：拉组织级 MCP server 配置（带资格判断，不合格就返回空对象而不是报错）。
   * 返回：{ server名 → ScopedMcpServerConfig }；任何一步不合格/失败都返回 {}。
   * 步骤：① 环境变量开关检查 → ② 有没有 OAuth token → ③ 有没有 user:mcp_servers scope
   *      → ④ 打 API 拉列表 → ⑤ 逐个转成 claudeai-proxy 配置并处理重名。
   * 为什么用 memoize 包住：这个函数会被多处调用（启动、/mcp、重连），但一次会话拉一次就够；
   * 且不缓存的话每次都会发一次网络请求。
   */
export const fetchClaudeAIMcpConfigsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    try {
    // 中文：任何异常都吞掉返回 {} —— 拉不到组织配置只影响「额外的 server」，绝不能拖垮本地启动
      if (isEnvDefinedFalsy(process.env.ENABLE_CLAUDEAI_MCP_SERVERS)) {
        logForDebugging('[claudeai-mcp] Disabled via env var')
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'disabled_env_var' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

    // 中文：没有 OAuth token 说明用户压根没登录 claude.ai，直接判定不合格
      const tokens = getClaudeAIOAuthTokens()
      if (!tokens?.accessToken) {
        logForDebugging('[claudeai-mcp] No access token')
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'no_oauth_token' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      // Check for user:mcp_servers scope directly instead of isClaudeAISubscriber().
      // In non-interactive mode, isClaudeAISubscriber() returns false when ANTHROPIC_API_KEY
      // is set (even with valid OAuth tokens) because preferThirdPartyAuthentication() causes
      // isAnthropicAuthEnabled() to return false. Checking the scope directly allows users
      // with both API keys and OAuth tokens to access claude.ai MCPs in print mode.
    // 中文：这里是踩过坑的地方（英文注释有详细说明）：不能用 isClaudeAISubscriber() 判断资格，
    //       因为在非交互模式下只要设了 ANTHROPIC_API_KEY，它就会返回 false（哪怕 OAuth token 有效）。
    //       直接检查 scope 才能让「既有 API key 又有 OAuth token」的用户也用上组织级 MCP。
      if (!tokens.scopes?.includes('user:mcp_servers')) {
        logForDebugging(
          `[claudeai-mcp] Missing user:mcp_servers scope (scopes=${tokens.scopes?.join(',') || 'none'})`,
        )
        logEvent('tengu_claudeai_mcp_eligibility', {
          state:
            'missing_scope' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {}
      }

      const baseUrl = getOauthConfig().BASE_API_URL
      const url = `${baseUrl}/v1/mcp_servers?limit=1000`

      logForDebugging(`[claudeai-mcp] Fetching from ${url}`)

      const response = await axios.get<ClaudeAIMcpServersResponse>(url, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': 'application/json',
          'anthropic-beta': MCP_SERVERS_BETA_HEADER,
          'anthropic-version': '2023-06-01',
        },
        timeout: FETCH_TIMEOUT_MS,
      })

      const configs: Record<string, ScopedMcpServerConfig> = {}
      // Track used normalized names to detect collisions and assign (2), (3), etc. suffixes.
      // We check the final normalized name (including suffix) to handle edge cases where
      // a suffixed name collides with another server's base name (e.g., "Example Server 2"
      // colliding with "Example Server! (2)" which both normalize to claude_ai_Example_Server_2).
      // 中文：重名兜底——规范化后撞车的名字自动加 (2)、(3) 后缀，否则后一个会覆盖前一个配置
      const usedNormalizedNames = new Set<string>()

      // 中文：server 名统一加 'claude.ai ' 前缀，让用户在 /mcp 列表里一眼看出这是组织下发的
      for (const server of response.data.data) {
        const baseName = `claude.ai ${server.display_name}`

        // Try without suffix first, then increment until we find an unused normalized name
        let finalName = baseName
        let finalNormalized = normalizeNameForMCP(finalName)
        let count = 1
        // 中文：从「不带后缀」开始试，撞了就 +1，直到找到一个没被占用的规范化名
        while (usedNormalizedNames.has(finalNormalized)) {
          count++
          finalName = `${baseName} (${count})`
          finalNormalized = normalizeNameForMCP(finalName)
        }
        usedNormalizedNames.add(finalNormalized)

        // 中文：type 用 'claudeai-proxy'：这些 server 不是直连，而是经 claude.ai 代理（token 也走那套 OAuth）
        configs[finalName] = {
          type: 'claudeai-proxy',
          url: server.url,
          id: server.id,
          scope: 'claudeai',
        }
      }

      logForDebugging(
        `[claudeai-mcp] Fetched ${Object.keys(configs).length} servers`,
      )
      logEvent('tengu_claudeai_mcp_eligibility', {
        state:
          'eligible' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return configs
    } catch {
      logForDebugging(`[claudeai-mcp] Fetch failed`)
      return {}
    }
  },
)

/**
 * Clears the memoized cache for fetchClaudeAIMcpConfigsIfEligible.
 * Call this after login so the next fetch will use the new auth tokens.
 */
  /**
   * 中文：清掉 memoize 缓存。登录成功后必须调，否则下一轮还在用旧 token 拉（拉不到或拉到旧的）。
   */
export function clearClaudeAIMcpConfigsCache(): void {
  fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
  // 中文：lodash memoize 把缓存挂在函数的 .cache 上；?.() 是因为它可能已被替换成没有 clear 的实现
  // Also clear the auth cache so freshly-authorized servers get re-connected
  clearMcpAuthCache()
  // 中文：顺带清掉 MCP 的鉴权缓存，让刚拿到授权的 server 能立刻重连，而不是等到下次启动
}

/**
 * Record that a claude.ai connector successfully connected. Idempotent.
 *
 * Gates the "N connectors unavailable/need auth" startup notifications: a
 * connector that was working yesterday and is now failed is a state change
 * worth surfacing; an org-configured connector that's been needs-auth since
 * it showed up is one the user has demonstrably ignored.
 */
  /**
   * 中文：记下「这个 connector 成功连过」。幂等（重复调用不会重复写入）。
   * 用途：启动时判断要不要弹「connector 不可用」提示——只有曾经连上过的才值得提示。
   */
export function markClaudeAiMcpConnected(name: string): void {
  saveGlobalConfig(current => {
  // 中文：saveGlobalConfig 接收一个「旧配置 → 新配置」的函数；返回 current 表示「没有任何改动」就不会写盘
    const seen = current.claudeAiMcpEverConnected ?? []
    if (seen.includes(name)) return current
    return { ...current, claudeAiMcpEverConnected: [...seen, name] }
  })
}

  // 中文：读全局配置判断是否连过；?? [] 处理字段还没被创建过的情况
export function hasClaudeAiMcpEverConnected(name: string): boolean {
  return (getGlobalConfig().claudeAiMcpEverConnected ?? []).includes(name)
}
