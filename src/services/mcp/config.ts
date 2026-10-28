/**
 * 【一句话定位】MCP server 配置的「读取 / 写入 / 合并 / 策略过滤」总入口——决定最终有哪些 server 可连。
 *
 * 【在架构中的位置】
 * - 上游：useManageMCPConnections.ts（启动时拉配置）、`claude mcp add/remove` 命令、
 *   权限与策略检查、/mcp 界面。
 * - 下游：文件系统（.mcp.json、~/.claude.json、项目本地配置、企业托管配置）、
 *   settings（策略白/黑名单）、插件系统（插件提供的 server）、claudeai.ts（组织下发的 server）。
 *
 * 【★ 三种（实际七种）作用域 —— 理解本目录的关键】
 * 用户最常用的是三种：
 *   ① local（默认）：写在「当前项目的本地配置」里（~/.claude.json 里按项目记录），
 *      只对你自己、只在这个项目生效——`claude mcp add` 不加参数时的默认落点。
 *   ② project：写在项目根目录的 .mcp.json 里，会随仓库提交、整个团队共享；
 *      因为是别人写的，所以第一次使用需要用户「批准」（见 utils.ts 的 getProjectMcpServerStatus）。
 *   ③ user：写在全局配置里（~/.claude.json 的 mcpServers），对你所有的项目生效。
 * 另外四种是运行时/托管来源：
 *   ④ dynamic：命令行 --mcp-config 或插件动态注入；⑤ enterprise：企业托管配置（一旦存在就独占）；
 *   ⑥ claudeai：claude.ai 组织下发的 connector；⑦ managed：其它受管来源。
 *
 * 【合并优先级（同名 server 谁赢）】
 * plugin（插件）< user < project < local，另外 enterprise 存在时独占一切。
 * 注意：不同来源的键名通常是刻意加了命名空间的（plugin:x:y、claude.ai Xxx），所以真正
 * 「撞车」的情况要靠内容签名去重（见 dedupPluginMcpServers / dedupClaudeAiMcpServers）。
 *
 * 【本文件包含什么】
 * - 路径与写入：getEnterpriseMcpFilePath / writeMcpjsonFile（原子写）。
 * - 去重：getMcpServerSignature / dedupPluginMcpServers / dedupClaudeAiMcpServers / unwrapCcrProxyUrl。
 * - 企业策略：getMcpAllowlistSettings / getMcpDenylistSettings / isMcpServerDenied /
 *   isMcpServerAllowedByPolicy / filterMcpServersByPolicy。
 * - 增删改查：addMcpConfig / removeMcpConfig / getMcpConfigsByScope / getMcpConfigByName /
 *   getProjectMcpConfigsFromCwd。
 * - 汇总：getClaudeCodeMcpConfigs（快，纯本地）/ getAllMcpConfigs（慢，含网络）。
 * - 解析：parseMcpConfig / parseMcpConfigFromFilePath / expandEnvVars。
 * - 启停：isMcpServerDisabled / setMcpServerEnabled / toggleMembership。
 *
 * 【TS 语法速查】
 * - `Record<string, T>` ≈ Map<String,T>；`Object.entries/values/fromEntries` 是它的迭代器写法。
 * - `Object.assign({}, a, b, c)`：后面的覆盖前面的（浅合并），≈ Java 的 putAll 链。
 * - `const { scope: _, ...rest } = obj`：解构时剔除字段（_ 表示丢弃）。
 * - `const { [name]: _, ...rest } = obj`：按「变量 key」解构剔除，是删除对象属性的惯用写法。
 * - `memoize(fn)`：lodash 缓存，本文件用它缓存「企业配置是否存在」这种只读一次的结果。
 * - `switch` 覆盖联合类型全部分支后不需要 default——编译器能确认已穷尽。
 * - `mapValues(obj, fn)`：lodash，把对象每个值过一遍函数（≈ Map 的 replaceAll）。
 * - `Array.isArray / [...new Set(x)]`：后者是数组去重的惯用写法。
 */
import { feature } from 'bun:bundle'
import { chmod, open, rename, stat, unlink } from 'fs/promises'
import mapValues from 'lodash-es/mapValues.js'
import memoize from 'lodash-es/memoize.js'
import { dirname, join, parse } from 'path'
import { getPlatform } from 'src/utils/platform.js'
import type { PluginError } from '../../types/plugin.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { isClaudeInChromeMCPServer } from '../../utils/claudeInChrome/common.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { getPluginMcpServers } from '../../utils/plugins/mcpPluginIntegration.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'
import { isRestrictedToPluginOnly } from '../../utils/settings/pluginOnlyPolicy.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../../utils/settings/settings.js'
import {
  isMcpServerCommandEntry,
  isMcpServerNameEntry,
  isMcpServerUrlEntry,
  type SettingsJson,
} from '../../utils/settings/types.js'
import type { ValidationError } from '../../utils/settings/validation.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { fetchClaudeAIMcpConfigsIfEligible } from './claudeai.js'
import { expandEnvVarsInString } from './envExpansion.js'
import {
  type ConfigScope,
  type McpHTTPServerConfig,
  type McpJsonConfig,
  McpJsonConfigSchema,
  type McpServerConfig,
  McpServerConfigSchema,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type McpWebSocketServerConfig,
  type ScopedMcpServerConfig,
} from './types.js'
import { getProjectMcpServerStatus } from './utils.js'

/**
 * Get the path to the managed MCP configuration file
 */
  /**
   * 中文：企业托管 MCP 配置文件的路径（<managed>/managed-mcp.json）。
   * 这个文件一旦存在就「独占」所有 MCP server（企业客户通常不希望员工自己加 server）。
   */
export function getEnterpriseMcpFilePath(): string {
  return join(getManagedFilePath(), 'managed-mcp.json')
}

/**
 * Internal utility: Add scope to server configs
 */
  /**
   * 中文：给一批 server 配置统一打上 scope 标记。
   * 为什么要打标记：后续所有逻辑（UI 展示、安全策略、去重）都要知道「这条配置来自哪里」。
   */
function addScopeToServers(
  servers: Record<string, McpServerConfig> | undefined,
  scope: ConfigScope,
): Record<string, ScopedMcpServerConfig> {
  if (!servers) {
    return {}
  }
  const scopedServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    scopedServers[name] = { ...config, scope }
  }
  return scopedServers
}

/**
 * Internal utility: Write MCP config to .mcp.json file.
 * Preserves file permissions and flushes to disk before rename.
 * Uses the original path for rename (does not follow symlinks).
 */
  /**
   * 中文：把配置写回 .mcp.json。
   * ★ 三个讲究：① 保留原文件权限（chmod 回来，避免把文件变成可执行或过宽）；
   * ② 先写临时文件再 datasync 落盘（fsync），保证断电也不会留下半截文件；
   * ③ 最后 rename —— rename 在同一文件系统上是原子的，读者要么看到旧文件要么看到新文件。
   * 为什么不直接 writeFile 覆盖：写到一半崩溃会留下损坏的 JSON，整个 MCP 配置就废了。
   */
async function writeMcpjsonFile(config: McpJsonConfig): Promise<void> {
  const mcpJsonPath = join(getCwd(), '.mcp.json')

  // Read existing file permissions to preserve them
  let existingMode: number | undefined
  try {
    const stats = await stat(mcpJsonPath)
    existingMode = stats.mode
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
    // File doesn't exist yet -- no permissions to preserve
  }

  // Write to temp file, flush to disk, then atomic rename
    // 中文：临时文件名带上 pid 和时间戳，避免并发写互相踩
  const tempPath = `${mcpJsonPath}.tmp.${process.pid}.${Date.now()}`
  const handle = await open(tempPath, 'w', existingMode ?? 0o644)
  try {
    await handle.writeFile(jsonStringify(config, null, 2), {
      encoding: 'utf8',
    })
    await handle.datasync()
    // 中文：datasync = fsync，强制刷到磁盘；不刷的话 rename 后数据可能还在页缓存里
  } finally {
    await handle.close()
  }

  try {
    // Restore original file permissions on the temp file before rename
    if (existingMode !== undefined) {
    // 中文：rename 之前把权限改回原值——open 时可能用了默认 0644
      await chmod(tempPath, existingMode)
    }
    await rename(tempPath, mcpJsonPath)
  } catch (e: unknown) {
    // Clean up temp file on failure
    try {
      await unlink(tempPath)
    } catch {
      // Best-effort cleanup
    }
    throw e
  }
}

/**
 * Extract command array from server config (stdio servers only)
 * Returns null for non-stdio servers
 */
  /**
   * 中文：取出 stdio server 的完整命令行（命令 + 参数），非 stdio 返回 null。
   * 用途：企业策略里可以「按命令行」放行/拒绝某个 server。
   */
function getServerCommandArray(config: McpServerConfig): string[] | null {
  // Non-stdio servers don't have commands
  if (config.type !== undefined && config.type !== 'stdio') {
    return null
  }
  const stdioConfig = config as McpStdioServerConfig
  return [stdioConfig.command, ...(stdioConfig.args ?? [])]
}

/**
 * Check if two command arrays match exactly
 */
  /**
   * 中文：两个命令行是否完全一致（长度相同且逐项相等）——策略匹配要求精确，不做模糊匹配。
   */
function commandArraysMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((val, idx) => val === b[idx])
}

/**
 * Extract URL from server config (remote servers only)
 * Returns null for stdio/sdk servers
 */
  /**
   * 中文：取出远程 server 的 URL，stdio/sdk 没有 url 就返回 null。
   */
function getServerUrl(config: McpServerConfig): string | null {
  return 'url' in config ? config.url : null
}

/**
 * CCR proxy URL path markers. In remote sessions, claude.ai connectors arrive
 * via --mcp-config with URLs rewritten to route through the CCR/session-ingress
 * SHTTP proxy. The original vendor URL is preserved in the mcp_url query param
 * so the proxy knows where to forward. See api-go/ccr/internal/ccrshared/
 * mcp_url_rewriter.go and api-go/ccr/internal/mcpproxy/proxy.go.
 */
  // 中文：远程会话里，claude.ai 的 connector URL 会被改写成走 CCR 代理的形式，
  //       真实厂商 URL 被保留在 mcp_url 这个 query 参数里
const CCR_PROXY_PATH_MARKERS = [
  '/v2/session_ingress/shttp/mcp/',
  '/v2/ccr-sessions/',
]

/**
 * If the URL is a CCR proxy URL, extract the original vendor URL from the
 * mcp_url query parameter. Otherwise return the URL unchanged. This lets
 * signature-based dedup match a plugin's raw vendor URL against a connector's
 * rewritten proxy URL when both point at the same MCP server.
 */
  /**
   * 中文：如果 URL 是 CCR 代理地址，就把里面 mcp_url 参数带的「原始厂商 URL」解出来。
   * 为什么要解：去重是按 URL 内容比对的，插件用的是原始 URL、connector 用的是改写后的代理 URL，
   * 不解出来就会误判成两个不同的 server（结果同一个 server 连两次）。
   */
export function unwrapCcrProxyUrl(url: string): string {
  if (!CCR_PROXY_PATH_MARKERS.some(m => url.includes(m))) {
    return url
  }
  try {
    const parsed = new URL(url)
    const original = parsed.searchParams.get('mcp_url')
    return original || url
  } catch {
    return url
  }
}

/**
 * Compute a dedup signature for an MCP server config.
 * Two configs with the same signature are considered "the same server" for
 * plugin deduplication. Ignores env (plugins always inject CLAUDE_PLUGIN_ROOT)
 * and headers (same URL = same server regardless of auth).
 * Returns null only for configs with neither command nor url (sdk type).
 */
  /**
   * 中文：算出一个 server 的「去重签名」：stdio 用完整命令行，远程用 URL。
   * 为什么忽略 env 与 headers（英文注释说明了）：插件总会注入 CLAUDE_PLUGIN_ROOT，env 必然不同；
   * 而同一个 URL 就是同一个 server，认证方式（headers）不同不改变这一点。
   * 返回 null：既没有 command 也没有 url（sdk 类型）。
   */
export function getMcpServerSignature(config: McpServerConfig): string | null {
  const cmd = getServerCommandArray(config)
  if (cmd) {
    return `stdio:${jsonStringify(cmd)}`
  }
  const url = getServerUrl(config)
  if (url) {
    return `url:${unwrapCcrProxyUrl(url)}`
  }
  return null
}

/**
 * Filter plugin MCP servers, dropping any whose signature matches a
 * manually-configured server or an earlier-loaded plugin server.
 * Manual wins over plugin; between plugins, first-loaded wins.
 *
 * Plugin servers are namespaced `plugin:name:server` so they never key-collide
 * with manual servers in the merge — this content-based check catches the case
 * where both actually launch the same underlying process/connection.
 */
  /**
   * 中文：过滤插件提供的 server——签名与「手工配置的 server」或「更早加载的插件 server」相同的都丢掉。
   * 优先级：手工配置 > 插件；插件之间则是先加载者胜。
   * 为什么键名不会撞还要做内容去重（英文注释说明了）：插件 server 的键是 plugin:name:server，
   * 手工的是裸名，合并时永远撞不上；但两者可能启动的是同一个进程/连接，那才是要消除的重复。
   * 返回 { servers, suppressed }：suppressed 记录「谁被谁压掉了」，用于在 /plugin 界面提示用户。
   */
export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  // Map signature -> server name so we can report which server a dup matches
  const manualSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    const sig = getMcpServerSignature(config)
    if (sig && !manualSigs.has(sig)) manualSigs.set(sig, name)
    // 中文：签名 → server 名，这样后面能报出「它跟谁重复了」而不是只说「有重复」
  }

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  const seenPluginSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(pluginServers)) {
    const sig = getMcpServerSignature(config)
    if (sig === null) {
      servers[name] = config
      continue
    }
    const manualDup = manualSigs.get(sig)
    if (manualDup !== undefined) {
      logForDebugging(
        `Suppressing plugin MCP server "${name}": duplicates manually-configured "${manualDup}"`,
      )
      suppressed.push({ name, duplicateOf: manualDup })
      continue
    }
    const pluginDup = seenPluginSigs.get(sig)
    if (pluginDup !== undefined) {
      logForDebugging(
        `Suppressing plugin MCP server "${name}": duplicates earlier plugin server "${pluginDup}"`,
      )
      suppressed.push({ name, duplicateOf: pluginDup })
      continue
    }
    seenPluginSigs.set(sig, name)
    servers[name] = config
  }
  return { servers, suppressed }
}

/**
 * Filter claude.ai connectors, dropping any whose signature matches an enabled
 * manually-configured server. Manual wins: a user who wrote .mcp.json or ran
 * `claude mcp add` expressed higher intent than a connector toggled in the web UI.
 *
 * Connector keys are `claude.ai <DisplayName>` so they never key-collide with
 * manual servers in the merge — this content-based check catches the case where
 * both point at the same underlying URL (e.g. `mcp__slack__*` and
 * `mcp__claude_ai_Slack__*` both hitting mcp.slack.com, ~600 chars/turn wasted).
 *
 * Only enabled manual servers count as dedup targets — a disabled manual server
 * mustn't suppress its connector twin, or neither runs.
 */
  /**
   * 中文：过滤 claude.ai 的 connector——签名与「已启用的手工配置 server」相同的丢掉（手工优先）。
   * 为什么手工优先（英文注释说明了）：用户写了 .mcp.json 或跑了 claude mcp add，
   * 表达的是比「在网页上开个开关」更强的意图。
   * ★ 只把「已启用」的手工 server 当作去重目标——否则一个被禁用的手工 server 会把它的
   * connector 孪生兄弟也压掉，结果两个都跑不起来。
   */
export function dedupClaudeAiMcpServers(
  claudeAiServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  const manualSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    if (isMcpServerDisabled(name)) continue
    // 中文：★ 跳过禁用的手工 server——它压不住 connector，否则两边都跑不了
    const sig = getMcpServerSignature(config)
    if (sig && !manualSigs.has(sig)) manualSigs.set(sig, name)
  }

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  for (const [name, config] of Object.entries(claudeAiServers)) {
    const sig = getMcpServerSignature(config)
    const manualDup = sig !== null ? manualSigs.get(sig) : undefined
    if (manualDup !== undefined) {
      logForDebugging(
        `Suppressing claude.ai connector "${name}": duplicates manually-configured "${manualDup}"`,
      )
      suppressed.push({ name, duplicateOf: manualDup })
      continue
    }
    servers[name] = config
  }
  return { servers, suppressed }
}

/**
 * Convert a URL pattern with wildcards to a RegExp
 * Supports * as wildcard matching any characters
 * Examples:
 *   "https://example.com/*" matches "https://example.com/api/v1"
 *   "https://*.example.com/*" matches "https://api.example.com/path"
 *   "https://example.com:*\/*" matches any port
 */
  /**
   * 中文：把带 * 通配符的 URL 规则转成正则（* → .*，其余正则元字符转义）。
   * 为什么要转义：URL 里的 . + ? 等字符在正则里有特殊含义，不转义就会误匹配。
   */
function urlPatternToRegex(pattern: string): RegExp {
  // Escape regex special characters except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  // Replace * with regex equivalent (match any characters)
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`)
}

/**
 * Check if a URL matches a pattern with wildcard support
 */
  /**
   * 中文：判断 URL 是否匹配某条通配规则。
   */
function urlMatchesPattern(url: string, pattern: string): boolean {
  const regex = urlPatternToRegex(pattern)
  return regex.test(url)
}

/**
 * Get the settings to use for MCP server allowlist policy.
 * When allowManagedMcpServersOnly is set in policySettings, only managed settings
 * control which servers are allowed. Otherwise, returns merged settings.
 */
  /**
   * 中文：取「白名单」用哪套设置。
   * 规则：策略里开了 allowManagedMcpServersOnly 时只看托管设置（管理员说了算）；否则用合并后的设置。
   */
function getMcpAllowlistSettings(): SettingsJson {
  if (shouldAllowManagedMcpServersOnly()) {
    return getSettingsForSource('policySettings') ?? {}
  }
  return getInitialSettings()
}

/**
 * Get the settings to use for MCP server denylist policy.
 * Denylists always merge from all sources — users can always deny servers
 * for themselves, even when allowManagedMcpServersOnly is set.
 */
  /**
   * 中文：取「黑名单」用哪套设置。
   * 与白名单不同：黑名单永远合并所有来源——用户永远可以为自己拒绝某个 server，
   * 即使管理员锁定了白名单（这是「可以更严格，不能更宽松」的安全原则）。
   */
function getMcpDenylistSettings(): SettingsJson {
  return getInitialSettings()
}

/**
 * Check if an MCP server is denied by enterprise policy
 * Checks name-based, command-based, and URL-based restrictions
 * @param serverName The name of the server to check
 * @param config Optional server config for command/URL-based matching
 * @returns true if denied, false if not on denylist
 */
  /**
   * 中文：判断某个 server 是否被企业策略拒绝（三个维度：名字 / 命令行 / URL）。
   * 返回 true = 被拒绝。
   */
function isMcpServerDenied(
  serverName: string,
  config?: McpServerConfig,
): boolean {
  const settings = getMcpDenylistSettings()
  if (!settings.deniedMcpServers) {
    return false // No restrictions
  }

  // Check name-based denial
  for (const entry of settings.deniedMcpServers) {
    if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
      return true
    }
  }

  // Check command-based denial (stdio servers only) and URL-based denial (remote servers only)
  if (config) {
    const serverCommand = getServerCommandArray(config)
    if (serverCommand) {
      for (const entry of settings.deniedMcpServers) {
        if (
          isMcpServerCommandEntry(entry) &&
          commandArraysMatch(entry.serverCommand, serverCommand)
        ) {
          return true
        }
      }
    }

    const serverUrl = getServerUrl(config)
    if (serverUrl) {
      for (const entry of settings.deniedMcpServers) {
        if (
          isMcpServerUrlEntry(entry) &&
          urlMatchesPattern(serverUrl, entry.serverUrl)
        ) {
          return true
        }
      }
    }
  }

  return false
}

/**
 * Check if an MCP server is allowed by enterprise policy
 * Checks name-based, command-based, and URL-based restrictions
 * @param serverName The name of the server to check
 * @param config Optional server config for command/URL-based matching
 * @returns true if allowed, false if blocked by policy
 */
  /**
   * 中文：判断某个 server 是否被企业策略允许。
   * 规则要点：① 黑名单绝对优先；② 没有白名单 = 全部允许；③ 空白名单 = 全部禁止；
   * ④ 有 command 类条目时 stdio server 必须命中其一；有 URL 类条目时远程 server 必须命中其一；
   * ⑤ 没有对应类型的条目就退化为按名字匹配。
   */
function isMcpServerAllowedByPolicy(
  serverName: string,
  config?: McpServerConfig,
): boolean {
  // Denylist takes absolute precedence
    // 中文：黑名单优先于一切——两者冲突时以「拒绝」为准
  if (isMcpServerDenied(serverName, config)) {
    return false
  }

  const settings = getMcpAllowlistSettings()
  if (!settings.allowedMcpServers) {
    return true // No allowlist restrictions (undefined)
  }

  // Empty allowlist means block all servers
    // 中文：空数组 !== 未设置。没配 = 不限制；配了空数组 = 一个都不许，语义必须区分开
  if (settings.allowedMcpServers.length === 0) {
    return false
  }

  // Check if allowlist contains any command-based or URL-based entries
  const hasCommandEntries = settings.allowedMcpServers.some(
    isMcpServerCommandEntry,
  )
  const hasUrlEntries = settings.allowedMcpServers.some(isMcpServerUrlEntry)

  if (config) {
    const serverCommand = getServerCommandArray(config)
    const serverUrl = getServerUrl(config)

    if (serverCommand) {
      // This is a stdio server
      if (hasCommandEntries) {
        // If ANY serverCommand entries exist, stdio servers MUST match one of them
        for (const entry of settings.allowedMcpServers) {
          if (
            isMcpServerCommandEntry(entry) &&
            commandArraysMatch(entry.serverCommand, serverCommand)
          ) {
            return true
          }
        }
        return false // Stdio server doesn't match any command entry
      } else {
        // No command entries, check name-based allowance
        for (const entry of settings.allowedMcpServers) {
          if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
            return true
          }
        }
        return false
      }
    } else if (serverUrl) {
      // This is a remote server (sse, http, ws, etc.)
      if (hasUrlEntries) {
        // If ANY serverUrl entries exist, remote servers MUST match one of them
        for (const entry of settings.allowedMcpServers) {
          if (
            isMcpServerUrlEntry(entry) &&
            urlMatchesPattern(serverUrl, entry.serverUrl)
          ) {
            return true
          }
        }
        return false // Remote server doesn't match any URL entry
      } else {
        // No URL entries, check name-based allowance
        for (const entry of settings.allowedMcpServers) {
          if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
            return true
          }
        }
        return false
      }
    } else {
      // Unknown server type - check name-based allowance only
      for (const entry of settings.allowedMcpServers) {
        if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
          return true
        }
      }
      return false
    }
  }

  // No config provided - check name-based allowance only
  for (const entry of settings.allowedMcpServers) {
    if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
      return true
    }
  }
  return false
}

/**
 * Filter a record of MCP server configs by managed policy (allowedMcpServers /
 * deniedMcpServers). Servers blocked by policy are dropped and their names
 * returned so callers can warn the user.
 *
 * Intended for user-controlled config entry points that bypass the policy filter
 * in getClaudeCodeMcpConfigs(): --mcp-config (main.tsx) and the mcp_set_servers
 * control message (print.ts, SDK V2 Query.setMcpServers()).
 *
 * SDK-type servers are exempt — they are SDK-managed transport placeholders,
 * not CLI-managed connections. The CLI never spawns a process or opens a
 * network connection for them; tool calls route back to the SDK via
 * mcp_tool_call. URL/command-based allowlist entries are meaningless for them
 * (no url, no command), and gating by name would silently drop them during
 * installPluginsAndApplyMcpInBackground's sdkMcpConfigs carry-forward.
 *
 * The generic has no type constraint because the two callsites use different
 * config type families: main.tsx uses ScopedMcpServerConfig (service type,
 * args: string[] required), print.ts uses McpServerConfigForProcessTransport
 * (SDK wire type, args?: string[] optional). Both are structurally compatible
 * with what isMcpServerAllowedByPolicy actually reads (type/url/command/args)
 * — the policy check only reads, never requires any field to be present.
 * The `as McpServerConfig` widening is safe for that reason; the downstream
 * checks tolerate missing/undefined fields: `config` is optional, and
 * `getServerCommandArray` defaults `args` to `[]` via `?? []`.
 */
  /**
   * 中文：按企业策略过滤一批 server 配置，返回 { allowed, blocked }。
   * 用在哪：会绕过 getClaudeCodeMcpConfigs 内部策略过滤的两个入口——--mcp-config 和 SDK 的
   * mcp_set_servers。
   * ★ sdk 类型豁免（英文注释给了很长的理由）：sdk server 只是 SDK 内部的传输占位符，
   * CLI 不会为它起进程或开网络连接，tool 调用会路由回 SDK；按名字/URL/命令行管它没有意义，
   * 而且会在插件安装过程中被静默丢掉。
   * 泛型 <T> 不加约束的原因：两个调用点用的配置类型族不同（一个是服务端的 ScopedMcpServerConfig，
   * 一个是 SDK 的 wire 类型），而策略检查只读字段、不要求字段一定存在，所以统一 as 一下是安全的。
   */
export function filterMcpServersByPolicy<T>(configs: Record<string, T>): {
  allowed: Record<string, T>
  blocked: string[]
} {
  const allowed: Record<string, T> = {}
  const blocked: string[] = []
  for (const [name, config] of Object.entries(configs)) {
    const c = config as McpServerConfig
    if (c.type === 'sdk' || isMcpServerAllowedByPolicy(name, c)) {
    // 中文：sdk 类型直接放行（见上面的 JSDoc 说明）
      allowed[name] = config
    } else {
      blocked.push(name)
    }
  }
  return { allowed, blocked }
}

/**
 * Internal utility: Expands environment variables in an MCP server config
 */
  /**
   * 中文：把配置里的 ${VAR} / ${VAR:-默认} 展开成真实值（见 envExpansion.ts）。
   * 返回 { expanded, missingVars }：missingVars 用于给用户「你缺这几个环境变量」的提示。
   * 按 type 分三类处理：stdio 展开 command/args/env；远程展开 url/headers；
   * 其余（ide/sdk/claudeai-proxy）没有需要展开的字段，原样返回。
   */
function expandEnvVars(config: McpServerConfig): {
  expanded: McpServerConfig
  missingVars: string[]
} {
  const missingVars: string[] = []

  function expandString(str: string): string {
    const { expanded, missingVars: vars } = expandEnvVarsInString(str)
    missingVars.push(...vars)
    return expanded
  }

  let expanded: McpServerConfig

  switch (config.type) {
    case undefined:
    case 'stdio': {
      const stdioConfig = config as McpStdioServerConfig
      expanded = {
        ...stdioConfig,
        command: expandString(stdioConfig.command),
        args: stdioConfig.args.map(expandString),
        env: stdioConfig.env
          ? mapValues(stdioConfig.env, expandString)
          : undefined,
      }
      break
    }
    case 'sse':
    case 'http':
    case 'ws': {
      const remoteConfig = config as
        | McpSSEServerConfig
        | McpHTTPServerConfig
        | McpWebSocketServerConfig
      expanded = {
        ...remoteConfig,
        url: expandString(remoteConfig.url),
        headers: remoteConfig.headers
          ? mapValues(remoteConfig.headers, expandString)
          : undefined,
      }
      break
    }
    case 'sse-ide':
    case 'ws-ide':
      expanded = config
      break
    case 'sdk':
      expanded = config
      break
    case 'claudeai-proxy':
      expanded = config
      break
  }
  // 中文：switch 覆盖了 McpServerConfig 的所有 type 分支，编译器能确认已穷尽，所以不需要 default

  return {
    expanded,
    missingVars: [...new Set(missingVars)],
    // 中文：用 Set 去重——同一个变量可能在 command/args/env 里出现多次
  }
}

/**
 * Add a new MCP server configuration
 * @param name The name of the server
 * @param config The server configuration
 * @param scope The configuration scope
 * @throws Error if name is invalid or server already exists, or if the config is invalid
 */
  /**
   * 中文：新增一个 MCP server 配置。
   * 入参 name / config（尚未校验的 unknown）/ scope。
   * 步骤：① 校验名字字符集 → ② 挡掉保留名（claude-in-chrome、computer-use）
   *      → ③ 企业配置存在时拒绝新增 → ④ 用 zod 校验配置 → ⑤ 过黑名单 / 白名单
   *      → ⑥ 检查同作用域是否已存在 → ⑦ 按作用域写盘。
   */
export async function addMcpConfig(
  name: string,
  config: unknown,
  scope: ConfigScope,
): Promise<void> {
  // 中文：名字必须先校验——它会被拼进 tool 名（mcp__<name>__<tool>），非法字符会污染整个工具命名空间
  if (name.match(/[^a-zA-Z0-9_-]/)) {
    throw new Error(
      `Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.`,
    )
  }

  // Block reserved server name "claude-in-chrome"
  // 中文：claude-in-chrome 是浏览器扩展占用的内置名字，用户不能占用
  if (isClaudeInChromeMCPServer(name)) {
    throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
  }

  if (feature('CHICAGO_MCP')) {
    const { isComputerUseMCPServer } = await import(
      '../../utils/computerUse/common.js'
    )
    if (isComputerUseMCPServer(name)) {
      throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
    }
  }

  // Block adding servers when enterprise MCP config exists (it has exclusive control)
  // 中文：企业配置存在时独占一切，不允许用户再加自己的 server
  if (doesEnterpriseMcpConfigExist()) {
    throw new Error(
      `Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers`,
    )
  }

  // Validate config first (needed for command-based policy checks)
  // 中文：必须先校验再查策略——策略里的「按命令行匹配」需要解析后的 command/args
  const result = McpServerConfigSchema().safeParse(config)
  if (!result.success) {
    const formattedErrors = result.error.issues
      .map(err => `${err.path.join('.')}: ${err.message}`)
      .join(', ')
    throw new Error(`Invalid configuration: ${formattedErrors}`)
  }
  const validatedConfig = result.data

  // Check denylist (with config for command-based checks)
  if (isMcpServerDenied(name, validatedConfig)) {
    throw new Error(
      `Cannot add MCP server "${name}": server is explicitly blocked by enterprise policy`,
    )
  }

  // Check allowlist (with config for command-based checks)
  if (!isMcpServerAllowedByPolicy(name, validatedConfig)) {
    throw new Error(
      `Cannot add MCP server "${name}": not allowed by enterprise policy`,
    )
  }

  // Check if server already exists in the target scope
  // 中文：先查重，避免覆盖同名配置（dynamic / enterprise / claudeai 这三种作用域不接受手动新增）
  switch (scope) {
    case 'project': {
      const { servers } = getProjectMcpConfigsFromCwd()
      if (servers[name]) {
        throw new Error(`MCP server ${name} already exists in .mcp.json`)
      }
      break
    }
    case 'user': {
      const globalConfig = getGlobalConfig()
      if (globalConfig.mcpServers?.[name]) {
        throw new Error(`MCP server ${name} already exists in user config`)
      }
      break
    }
    case 'local': {
      const projectConfig = getCurrentProjectConfig()
      if (projectConfig.mcpServers?.[name]) {
        throw new Error(`MCP server ${name} already exists in local config`)
      }
      break
    }
    case 'dynamic':
      throw new Error('Cannot add MCP server to scope: dynamic')
    case 'enterprise':
      throw new Error('Cannot add MCP server to scope: enterprise')
    case 'claudeai':
      throw new Error('Cannot add MCP server to scope: claudeai')
  }

  // Add based on scope
  // 中文：真正写盘。project 写 .mcp.json，user 写全局配置，local 写当前项目的本地配置
  switch (scope) {
    case 'project': {
      const { servers: existingServers } = getProjectMcpConfigsFromCwd()

      const mcpServers: Record<string, McpServerConfig> = {}
      for (const [serverName, serverConfig] of Object.entries(
        existingServers,
      )) {
        const { scope: _, ...configWithoutScope } = serverConfig
    // 中文：写回 .mcp.json 前要把 scope 字段剔掉——那是运行时的东西，不属于文件内容
        mcpServers[serverName] = configWithoutScope
      }
      mcpServers[name] = validatedConfig
      const mcpConfig = { mcpServers }

      // Write back to .mcp.json
      try {
        await writeMcpjsonFile(mcpConfig)
      } catch (error) {
        throw new Error(`Failed to write to .mcp.json: ${error}`)
      }
      break
    }

    case 'user': {
      saveGlobalConfig(current => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [name]: validatedConfig,
        },
      }))
      break
    }

    case 'local': {
      saveCurrentProjectConfig(current => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [name]: validatedConfig,
        },
      }))
      break
    }

    default:
      throw new Error(`Cannot add MCP server to scope: ${scope}`)
  }
}

/**
 * Remove an MCP server configuration
 * @param name The name of the server to remove
 * @param scope The configuration scope
 * @throws Error if server not found in specified scope
 */
  /**
   * 中文：删除一个 MCP server 配置（同样按作用域分别处理）。
   */
export async function removeMcpConfig(
  name: string,
  scope: ConfigScope,
): Promise<void> {
  switch (scope) {
    case 'project': {
      const { servers: existingServers } = getProjectMcpConfigsFromCwd()

      if (!existingServers[name]) {
        throw new Error(`No MCP server found with name: ${name} in .mcp.json`)
      }

      // Strip scope information when writing back to .mcp.json
      const mcpServers: Record<string, McpServerConfig> = {}
      for (const [serverName, serverConfig] of Object.entries(
        existingServers,
      )) {
        if (serverName !== name) {
          const { scope: _, ...configWithoutScope } = serverConfig
          mcpServers[serverName] = configWithoutScope
        }
      }
      const mcpConfig = { mcpServers }
      try {
        await writeMcpjsonFile(mcpConfig)
      } catch (error) {
        throw new Error(`Failed to remove from .mcp.json: ${error}`)
      }
      break
    }

    case 'user': {
      const config = getGlobalConfig()
      if (!config.mcpServers?.[name]) {
        throw new Error(`No user-scoped MCP server found with name: ${name}`)
      }
      saveGlobalConfig(current => {
        const { [name]: _, ...restMcpServers } = current.mcpServers ?? {}
    // 中文：`const { [name]: _, ...rest }` 是「按键删除属性」的函数式写法（不修改原对象）
        return {
          ...current,
          mcpServers: restMcpServers,
        }
      })
      break
    }

    case 'local': {
      // Check if server exists before updating
      const config = getCurrentProjectConfig()
      if (!config.mcpServers?.[name]) {
        throw new Error(`No project-local MCP server found with name: ${name}`)
      }
      saveCurrentProjectConfig(current => {
        const { [name]: _, ...restMcpServers } = current.mcpServers ?? {}
        return {
          ...current,
          mcpServers: restMcpServers,
        }
      })
      break
    }

    default:
      throw new Error(`Cannot remove MCP server from scope: ${scope}`)
  }
}

/**
 * Get MCP configs from current directory only (no parent traversal).
 * Used by addMcpConfig and removeMcpConfig to modify the local .mcp.json file.
 * Exported for testing purposes.
 *
 * @returns Servers with scope information and any validation errors from current directory's .mcp.json
 */
  /**
   * 中文：只读「当前目录」的 .mcp.json（不向上遍历父目录）。
   * 为什么单独一份（英文注释说明了）：add/remove 要改的就是当前目录这个文件，
   * 不能把父目录的配置也一起读进来再写回去。
   */
export function getProjectMcpConfigsFromCwd(): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  // Check if project source is enabled
    // 中文：项目配置来源可以在策略里被整体关闭（例如企业禁止仓库自带 MCP）
  if (!isSettingSourceEnabled('projectSettings')) {
    return { servers: {}, errors: [] }
  }

  const mcpJsonPath = join(getCwd(), '.mcp.json')

  const { config, errors } = parseMcpConfigFromFilePath({
    filePath: mcpJsonPath,
    expandVars: true,
    scope: 'project',
  })

  // Missing .mcp.json is expected, but malformed files should report errors
    // 中文：文件不存在是正常的（大多数项目没有 .mcp.json），只有「文件坏了」才需要报错
  if (!config) {
    const nonMissingErrors = errors.filter(
      e => !e.message.startsWith('MCP config file not found'),
    )
    if (nonMissingErrors.length > 0) {
      logForDebugging(
        `MCP config errors for ${mcpJsonPath}: ${jsonStringify(nonMissingErrors.map(e => e.message))}`,
        { level: 'error' },
      )
      return { servers: {}, errors: nonMissingErrors }
    }
    return { servers: {}, errors: [] }
  }

  return {
    servers: config.mcpServers
      ? addScopeToServers(config.mcpServers, 'project')
      : {},
    errors: errors || [],
  }
}

/**
 * Get all MCP configurations from a specific scope
 * @param scope The configuration scope
 * @returns Servers with scope information and any validation errors
 */
  /**
   * 中文：★ 按作用域读取 MCP 配置。
   * project 作用域有个特殊行为：会从当前目录一路向上遍历到文件系统根，逐层读 .mcp.json，
   * 且**离当前目录越近的优先级越高**（所以是从根往下 reverse 后合并）。
   * 返回 { servers, errors }：errors 收集解析错误（配置坏掉时要暴露给用户，不能静默）。
   */
export function getMcpConfigsByScope(
  scope: 'project' | 'user' | 'local' | 'enterprise',
): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  // Check if this source is enabled
  const sourceMap: Record<
    string,
    'projectSettings' | 'userSettings' | 'localSettings'
  > = {
    project: 'projectSettings',
    user: 'userSettings',
    local: 'localSettings',
  }

  // 中文：先检查这个配置来源是否被策略关闭了（sourceMap 里没有 enterprise，它不受此限制）
  if (scope in sourceMap && !isSettingSourceEnabled(sourceMap[scope]!)) {
    return { servers: {}, errors: [] }
  }

  switch (scope) {
    case 'project': {
      const allServers: Record<string, ScopedMcpServerConfig> = {}
      const allErrors: ValidationError[] = []

      // 中文：收集从当前目录到根目录的全部路径，准备逐层查找 .mcp.json
      // Build list of directories to check
      const dirs: string[] = []
      let currentDir = getCwd()

      while (currentDir !== parse(currentDir).root) {
        dirs.push(currentDir)
        currentDir = dirname(currentDir)
      }

    // 中文：reverse 后 = 从根往当前目录走，这样近处的配置后写、覆盖远处的
      // Process from root downward to CWD (so closer files have higher priority)
      for (const dir of dirs.reverse()) {
        const mcpJsonPath = join(dir, '.mcp.json')

        const { config, errors } = parseMcpConfigFromFilePath({
          filePath: mcpJsonPath,
          expandVars: true,
          scope: 'project',
        })

        // Missing .mcp.json in parent directories is expected, but malformed files should report errors
        if (!config) {
          const nonMissingErrors = errors.filter(
            e => !e.message.startsWith('MCP config file not found'),
          )
          if (nonMissingErrors.length > 0) {
            logForDebugging(
              `MCP config errors for ${mcpJsonPath}: ${jsonStringify(nonMissingErrors.map(e => e.message))}`,
              { level: 'error' },
            )
            allErrors.push(...nonMissingErrors)
          }
          continue
        }

        if (config.mcpServers) {
          // Merge servers, with files closer to CWD overriding parent configs
      // 中文：Object.assign 做浅合并——同名 server 被近处的覆盖
          Object.assign(allServers, addScopeToServers(config.mcpServers, scope))
        }

        if (errors.length > 0) {
          allErrors.push(...errors)
        }
      }

      return {
        servers: allServers,
        errors: allErrors,
      }
    }
    case 'user': {
      const mcpServers = getGlobalConfig().mcpServers
      if (!mcpServers) {
        return { servers: {}, errors: [] }
      }

      const { config, errors } = parseMcpConfig({
        configObject: { mcpServers },
        expandVars: true,
        scope: 'user',
      })

      return {
        servers: addScopeToServers(config?.mcpServers, scope),
        errors,
      }
    }
    case 'local': {
      const mcpServers = getCurrentProjectConfig().mcpServers
      if (!mcpServers) {
        return { servers: {}, errors: [] }
      }

      const { config, errors } = parseMcpConfig({
        configObject: { mcpServers },
        expandVars: true,
        scope: 'local',
      })

      return {
        servers: addScopeToServers(config?.mcpServers, scope),
        errors,
      }
    }
    case 'enterprise': {
      const enterpriseMcpPath = getEnterpriseMcpFilePath()

      const { config, errors } = parseMcpConfigFromFilePath({
        filePath: enterpriseMcpPath,
        expandVars: true,
        scope: 'enterprise',
      })

      // Missing enterprise config file is expected, but malformed files should report errors
      if (!config) {
        const nonMissingErrors = errors.filter(
          e => !e.message.startsWith('MCP config file not found'),
        )
        if (nonMissingErrors.length > 0) {
          logForDebugging(
            `Enterprise MCP config errors for ${enterpriseMcpPath}: ${jsonStringify(nonMissingErrors.map(e => e.message))}`,
            { level: 'error' },
          )
          return { servers: {}, errors: nonMissingErrors }
        }
        return { servers: {}, errors: [] }
      }

      return {
        servers: addScopeToServers(config.mcpServers, scope),
        errors,
      }
    }
  }
}

/**
 * Get an MCP server configuration by name
 * @param name The name of the server
 * @returns The server configuration with scope, or undefined if not found
 */
  /**
   * 中文：按名字查一个 server 的配置，返回它带 scope 的配置；找不到返回 null。
   * 查找顺序体现了优先级：enterprise > local > project > user。
   */
export function getMcpConfigByName(name: string): ScopedMcpServerConfig | null {
  const { servers: enterpriseServers } = getMcpConfigsByScope('enterprise')

  // When MCP is locked to plugin-only, only enterprise servers are reachable
  // by name. User/project/local servers are blocked — same as getClaudeCodeMcpConfigs().
    // 中文：策略若把 MCP 锁成「只允许插件」，那按名字只能找到企业托管的 server
  if (isRestrictedToPluginOnly('mcp')) {
    return enterpriseServers[name] ?? null
  }

  const { servers: userServers } = getMcpConfigsByScope('user')
  const { servers: projectServers } = getMcpConfigsByScope('project')
  const { servers: localServers } = getMcpConfigsByScope('local')

    // 中文：优先级 enterprise > local > project > user（local 比 project 高，因为它是你自己的设置）
  if (enterpriseServers[name]) {
    return enterpriseServers[name]
  }
  if (localServers[name]) {
    return localServers[name]
  }
  if (projectServers[name]) {
    return projectServers[name]
  }
  if (userServers[name]) {
    return userServers[name]
  }

  return null
}

/**
 * Get Claude Code MCP configurations (excludes claude.ai servers from the
 * returned set — they're fetched separately and merged by callers).
 * This is fast: only local file reads; no awaited network calls on the
 * critical path. The optional extraDedupTargets promise (e.g. the in-flight
 * claude.ai connector fetch) is awaited only after loadAllPluginsCacheOnly() completes,
 * so the two overlap rather than serialize.
 * @returns Claude Code server configurations with appropriate scopes
 */
  /**
   * 中文：★ 汇总所有「Claude Code 本地来源」的 MCP server（不含 claude.ai）。
   * 为什么单独拆一个快的版本（英文注释说明了）：启动路径上不能等网络，所以这个函数
   * 只做本地文件读取；可选的 extraDedupTargets（在飞的 claude.ai 请求）会被「延迟 await」，
   * 让它和插件加载并行而不是串行。
   * 步骤：① 企业配置存在则独占 → ② 读 user/project/local → ③ 加载插件 server
   *      → ④ 项目级 server 只保留已批准的 → ⑤ 插件 server 按签名去重 → ⑥ 按优先级合并
   *      → ⑦ 最后统一过一遍企业策略。
   */
export async function getClaudeCodeMcpConfigs(
  dynamicServers: Record<string, ScopedMcpServerConfig> = {},
  extraDedupTargets: Promise<
    Record<string, ScopedMcpServerConfig>
  > = Promise.resolve({}),
): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  const { servers: enterpriseServers } = getMcpConfigsByScope('enterprise')

  // If an enterprise mcp config exists, do not use any others; this has exclusive control over all MCP servers
  // (enterprise customers often do not want their users to be able to add their own MCP servers).
    // 中文：企业配置一旦存在就独占——企业客户通常不希望员工自行添加 MCP server
  if (doesEnterpriseMcpConfigExist()) {
    // Apply policy filtering to enterprise servers
    const filtered: Record<string, ScopedMcpServerConfig> = {}

    for (const [name, serverConfig] of Object.entries(enterpriseServers)) {
      if (!isMcpServerAllowedByPolicy(name, serverConfig)) {
        continue
      }
      filtered[name] = serverConfig
    }

    return { servers: filtered, errors: [] }
  }

  // Load other scopes — unless the managed policy locks MCP to plugin-only.
  // Unlike the enterprise-exclusive block above, this keeps plugin servers.
    // 中文：另一种锁定方式：策略把 MCP 限制为「只允许插件提供」（比企业独占温和，插件仍可用）
  const mcpLocked = isRestrictedToPluginOnly('mcp')
  const noServers: { servers: Record<string, ScopedMcpServerConfig> } = {
    servers: {},
  }
  const { servers: userServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('user')
  const { servers: projectServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('project')
  const { servers: localServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('local')

  // Load plugin MCP servers
  const pluginMcpServers: Record<string, ScopedMcpServerConfig> = {}

    // 中文：只读缓存的插件列表，不发网络、不解压缩包——保证这个函数足够快
  const pluginResult = await loadAllPluginsCacheOnly()

  // Collect MCP-specific errors during server loading
  const mcpErrors: PluginError[] = []

  // Log any plugin loading errors - NEVER silently fail in production
    // 中文：只有真正 MCP 相关的错误才升级成 logError；插件不存在之类只记 debug（很常见）
  if (pluginResult.errors.length > 0) {
    for (const error of pluginResult.errors) {
      // Only log as MCP error if it's actually MCP-related
      // Otherwise just log as debug since the plugin might not have MCP servers
      if (
        error.type === 'mcp-config-invalid' ||
        error.type === 'mcpb-download-failed' ||
        error.type === 'mcpb-extract-failed' ||
        error.type === 'mcpb-invalid-manifest'
      ) {
        const errorMessage = `Plugin MCP loading error - ${error.type}: ${getPluginErrorMessage(error)}`
        logError(new Error(errorMessage))
      } else {
        // Plugin doesn't exist or isn't available - this is common and not necessarily an error
        // The plugin system will handle installing it if possible
        const errorType = error.type
        logForDebugging(
          `Plugin not available for MCP: ${error.source} - error type: ${errorType}`,
        )
      }
    }
  }

  // Process enabled plugins for MCP servers in parallel
    // 中文：并行加载所有启用插件的 MCP server
  const pluginServerResults = await Promise.all(
    pluginResult.enabled.map(plugin => getPluginMcpServers(plugin, mcpErrors)),
  )
  for (const servers of pluginServerResults) {
    if (servers) {
      Object.assign(pluginMcpServers, servers)
    }
  }

  // Add any MCP-specific errors from server loading to plugin errors
  if (mcpErrors.length > 0) {
    for (const error of mcpErrors) {
      const errorMessage = `Plugin MCP server error - ${error.type}: ${getPluginErrorMessage(error)}`
      logError(new Error(errorMessage))
    }
  }

  // Filter project servers to only include approved ones
  const approvedProjectServers: Record<string, ScopedMcpServerConfig> = {}
    // 中文：★ 项目级（.mcp.json）server 必须先经过用户批准才会被纳入——这是仓库自带配置的安全闸门
  for (const [name, config] of Object.entries(projectServers)) {
    if (getProjectMcpServerStatus(name) === 'approved') {
      approvedProjectServers[name] = config
    }
  }

  // Dedup plugin servers against manually-configured ones (and each other).
  // Plugin server keys are namespaced `plugin:x:y` so they never collide with
  // manual keys in the merge below — this content-based filter catches the case
  // where both would launch the same underlying process/connection.
  // Only servers that will actually connect are valid dedup targets — a
  // disabled manual server mustn't suppress a plugin server, or neither runs
  // (manual is skipped by name at connection time; plugin was removed here).
    // 中文：只有「真的会连上」的 server 才算去重目标；被禁用/被策略拦的不算，否则两边都不跑
  const extraTargets = await extraDedupTargets
  const enabledManualServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries({
    ...userServers,
    ...approvedProjectServers,
    ...localServers,
    ...dynamicServers,
    ...extraTargets,
  })) {
    if (
      !isMcpServerDisabled(name) &&
      isMcpServerAllowedByPolicy(name, config)
    ) {
      enabledManualServers[name] = config
    }
  }
  // Split off disabled/policy-blocked plugin servers so they don't win the
  // first-plugin-wins race against an enabled duplicate — same invariant as
  // above. They're merged back after dedup so they still appear in /mcp
  // (policy filtering at the end of this function drops blocked ones).
    // 中文：把禁用/被拦的插件 server 先摘出来，避免它们在「先到先得」的竞争中挤掉可用的重复项；
    //       去重之后再合回去，这样 /mcp 里仍然看得到它们（只是连不上）
  const enabledPluginServers: Record<string, ScopedMcpServerConfig> = {}
  const disabledPluginServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(pluginMcpServers)) {
    if (
      isMcpServerDisabled(name) ||
      !isMcpServerAllowedByPolicy(name, config)
    ) {
      disabledPluginServers[name] = config
    } else {
      enabledPluginServers[name] = config
    }
  }
  const { servers: dedupedPluginServers, suppressed } = dedupPluginMcpServers(
    enabledPluginServers,
    enabledManualServers,
  )
  Object.assign(dedupedPluginServers, disabledPluginServers)
  // Surface suppressions in /plugin UI. Pushed AFTER the logError loop above
  // so these don't go to the error log — they're informational, not errors.
  for (const { name, duplicateOf } of suppressed) {
    // name is "plugin:${pluginName}:${serverName}" from addPluginScopeToServers
    const parts = name.split(':')
    if (parts[0] !== 'plugin' || parts.length < 3) continue
    mcpErrors.push({
      type: 'mcp-server-suppressed-duplicate',
      source: name,
      plugin: parts[1]!,
      serverName: parts.slice(2).join(':'),
      duplicateOf,
    })
  }

  // Merge in order of precedence: plugin < user < project < local
    // 中文：★ 合并优先级：plugin < user < project < local（后面的覆盖前面的）
  const configs = Object.assign(
    {},
    dedupedPluginServers,
    userServers,
    approvedProjectServers,
    localServers,
  )

  // Apply policy filtering to merged configs
  const filtered: Record<string, ScopedMcpServerConfig> = {}

  for (const [name, serverConfig] of Object.entries(configs)) {
    if (!isMcpServerAllowedByPolicy(name, serverConfig as McpServerConfig)) {
      continue
    }
    filtered[name] = serverConfig as ScopedMcpServerConfig
  }

  return { servers: filtered, errors: mcpErrors }
}

/**
 * Get all MCP configurations across all scopes, including claude.ai servers.
 * This may be slow due to network calls - use getClaudeCodeMcpConfigs() for fast startup.
 * @returns All server configurations with appropriate scopes
 */
  /**
   * 中文：汇总**所有**来源（含 claude.ai），因为要发网络请求所以慢——启动路径请用
   * getClaudeCodeMcpConfigs()。
   */
export async function getAllMcpConfigs(): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  // In enterprise mode, don't load claude.ai servers (enterprise has exclusive control)
  if (doesEnterpriseMcpConfigExist()) {
    return getClaudeCodeMcpConfigs()
  }

  // Kick off the claude.ai fetch before getClaudeCodeMcpConfigs so it overlaps
  // with loadAllPluginsCacheOnly() inside. Memoized — the awaited call below is a cache hit.
    // 中文：先起请求不 await，让它和 getClaudeCodeMcpConfigs 内部的插件加载重叠执行
  const claudeaiPromise = fetchClaudeAIMcpConfigsIfEligible()
  const { servers: claudeCodeServers, errors } = await getClaudeCodeMcpConfigs(
    {},
    claudeaiPromise,
  )
  const { allowed: claudeaiMcpServers } = filterMcpServersByPolicy(
    await claudeaiPromise,
  )

  // Suppress claude.ai connectors that duplicate an enabled manual server.
  // Keys never collide (`slack` vs `claude.ai Slack`) so the merge below
  // won't catch this — need content-based dedup by URL signature.
  const { servers: dedupedClaudeAi } = dedupClaudeAiMcpServers(
    claudeaiMcpServers,
    claudeCodeServers,
  )

  // Merge with claude.ai having lowest precedence
    // 中文：claude.ai 优先级最低——被放在 Object.assign 的第一个参数，会被后面的覆盖
  const servers = Object.assign({}, dedupedClaudeAi, claudeCodeServers)

  return { servers, errors }
}

/**
 * Parse and validate an MCP configuration object
 * @param params Parsing parameters
 * @returns Validated configuration with any errors
 */
  /**
   * 中文：校验并解析一个 MCP 配置对象。
   * 步骤：① 整体过一遍 McpJsonConfigSchema → ② 逐个 server 展开环境变量
   *      → ③ Windows 上若直接用 npx 会给出「要包 cmd /c」的提示（经典坑）
   *      → ④ 返回校验后的配置 + 收集到的所有 warning 级错误。
   * 设计取向：坏配置不抛异常，而是收集成 errors 返回——一个坏 server 不该让整个 MCP 起不来。
   */
export function parseMcpConfig(params: {
  configObject: unknown
  expandVars: boolean
  scope: ConfigScope
  filePath?: string
}): {
  config: McpJsonConfig | null
  errors: ValidationError[]
} {
  const { configObject, expandVars, scope, filePath } = params
  const schemaResult = McpJsonConfigSchema().safeParse(configObject)
  if (!schemaResult.success) {
    return {
      config: null,
      errors: schemaResult.error.issues.map(issue => ({
        ...(filePath && { file: filePath }),
        path: issue.path.join('.'),
        message: 'Does not adhere to MCP server configuration schema',
        mcpErrorMetadata: {
          scope,
          severity: 'fatal',
        },
      })),
    }
  }

  // Validate each server and expand variables if requested
  const errors: ValidationError[] = []
  const validatedServers: Record<string, McpServerConfig> = {}

  for (const [name, config] of Object.entries(schemaResult.data.mcpServers)) {
    let configToCheck = config

    if (expandVars) {
      const { expanded, missingVars } = expandEnvVars(config)

      // 中文：环境变量缺失是 warning 而不是 fatal——配置仍然返回，只是把缺失项告诉用户
      if (missingVars.length > 0) {
        errors.push({
          ...(filePath && { file: filePath }),
          path: `mcpServers.${name}`,
          message: `Missing environment variables: ${missingVars.join(', ')}`,
          suggestion: `Set the following environment variables: ${missingVars.join(', ')}`,
          mcpErrorMetadata: {
            scope,
            serverName: name,
            severity: 'warning',
          },
        })
      }

      configToCheck = expanded
    }

    // Check for Windows-specific npx usage without cmd wrapper
      // 中文：Windows 上 npx 是 .cmd 批处理，Node 无法直接 spawn，必须 cmd /c 包一层（经典坑）
    if (
      getPlatform() === 'windows' &&
      (!configToCheck.type || configToCheck.type === 'stdio') &&
      (configToCheck.command === 'npx' ||
        configToCheck.command.endsWith('\\npx') ||
        configToCheck.command.endsWith('/npx'))
    ) {
      errors.push({
        ...(filePath && { file: filePath }),
        path: `mcpServers.${name}`,
        message: `Windows requires 'cmd /c' wrapper to execute npx`,
        suggestion: `Change command to "cmd" with args ["/c", "npx", ...]. See: https://code.claude.com/docs/en/mcp#configure-mcp-servers`,
        mcpErrorMetadata: {
          scope,
          serverName: name,
          severity: 'warning',
        },
      })
    }

    validatedServers[name] = configToCheck
  }
  return {
    config: { mcpServers: validatedServers },
    errors,
  }
}

/**
 * Parse and validate an MCP configuration from a file path
 * @param params Parsing parameters
 * @returns Validated configuration with any errors
 */
  /**
   * 中文：从文件路径读取并解析 MCP 配置（先读文件、判 JSON 合法性，再交给 parseMcpConfig）。
   * 文件不存在（ENOENT）返回空配置而不是错误；读取失败/JSON 坏了则返回 fatal 级错误。
   */
export function parseMcpConfigFromFilePath(params: {
  filePath: string
  expandVars: boolean
  scope: ConfigScope
}): {
  config: McpJsonConfig | null
  errors: ValidationError[]
} {
  const { filePath, expandVars, scope } = params
  const fs = getFsImplementation()

  let configContent: string
  try {
    configContent = fs.readFileSync(filePath, { encoding: 'utf8' })
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    // 中文：ENOENT 是「根本没有这个文件」，属于正常情况（比如没有企业配置）
    if (code === 'ENOENT') {
      return {
        config: null,
        errors: [
          {
            file: filePath,
            path: '',
            message: `MCP config file not found: ${filePath}`,
            suggestion: 'Check that the file path is correct',
            mcpErrorMetadata: {
              scope,
              severity: 'fatal',
            },
          },
        ],
      }
    }
    logForDebugging(
      `MCP config read error for ${filePath} (scope=${scope}): ${error}`,
      { level: 'error' },
    )
    return {
      config: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: `Failed to read file: ${error}`,
          suggestion: 'Check file permissions and ensure the file exists',
          mcpErrorMetadata: {
            scope,
            severity: 'fatal',
          },
        },
      ],
    }
  }

  const parsedJson = safeParseJSON(configContent)

  if (!parsedJson) {
    logForDebugging(
      `MCP config is not valid JSON: ${filePath} (scope=${scope}, length=${configContent.length}, first100=${jsonStringify(configContent.slice(0, 100))})`,
      { level: 'error' },
    )
    return {
      config: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: `MCP config is not a valid JSON`,
          suggestion: 'Fix the JSON syntax errors in the file',
          mcpErrorMetadata: {
            scope,
            severity: 'fatal',
          },
        },
      ],
    }
  }

  return parseMcpConfig({
    configObject: parsedJson,
    expandVars,
    scope,
    filePath,
  })
}

  /**
   * 中文：企业 MCP 配置文件是否存在。用 memoize 缓存——这个值一会话内不会变，且要读文件。
   */
export const doesEnterpriseMcpConfigExist = memoize((): boolean => {
  const { config } = parseMcpConfigFromFilePath({
    filePath: getEnterpriseMcpFilePath(),
    expandVars: true,
    scope: 'enterprise',
  })
  return config !== null
})

/**
 * Check if MCP allowlist policy should only come from managed settings.
 * This is true when policySettings has allowManagedMcpServersOnly: true.
 * When enabled, allowedMcpServers is read exclusively from managed settings.
 * Users can still add their own MCP servers and deny servers via deniedMcpServers.
 */
  /**
   * 中文：是否只允许来自托管设置的白名单（policySettings.allowManagedMcpServersOnly）。
   * 开启后白名单只看管理员配的；但用户仍然可以自己加 server、也仍然可以自己拒绝 server。
   */
export function shouldAllowManagedMcpServersOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.allowManagedMcpServersOnly === true
  )
}

/**
 * Check if all MCP servers in a config are allowed with enterprise MCP config.
 */
  /**
   * 中文：这批配置是否能在「企业配置存在」的前提下被放行。
   * 目前的实现非常保守（英文注释也承认这是临时方案）：只允许 sdk 类型且名字是 claude-vscode，
   * 目的是先让 VSCode 扩展在某些企业客户那里能正常工作。
   */
export function areMcpConfigsAllowedWithEnterpriseMcpConfig(
  configs: Record<string, ScopedMcpServerConfig>,
): boolean {
  // NOTE: While all SDK MCP servers should be safe from a security perspective, we are still discussing
  // what the best way to do this is. In the meantime, we are limiting this to claude-vscode for now to
  // unbreak the VSCode extension for certain enterprise customers who have enterprise MCP config enabled.
  // https://anthropic.slack.com/archives/C093UA0KLD7/p1764975463670109
  return Object.values(configs).every(
    c => c.type === 'sdk' && c.name === 'claude-vscode',
  )
}

/**
 * Built-in MCP server that defaults to disabled. Unlike user-configured servers
 * (opt-out via disabledMcpServers), this requires explicit opt-in via
 * enabledMcpServers. Shows up in /mcp as disabled until the user enables it.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
  // 中文：唯一一个「默认禁用」的内置 server：computer-use（需要用户显式开启）
const DEFAULT_DISABLED_BUILTIN = feature('CHICAGO_MCP')
  ? (
      require('../../utils/computerUse/common.js') as typeof import('../../utils/computerUse/common.js')
    ).COMPUTER_USE_MCP_SERVER_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

  /**
   * 中文：判断某个名字是不是「默认禁用的内置 server」。
   */
function isDefaultDisabledBuiltin(name: string): boolean {
  return DEFAULT_DISABLED_BUILTIN !== null && name === DEFAULT_DISABLED_BUILTIN
}

/**
 * Check if an MCP server is disabled
 * @param name The name of the server
 * @returns true if the server is disabled
 */
  /**
   * 中文：判断某个 server 是否被禁用。
   * 两种机制（英文注释说明了）：普通 server 是「默认启用、进 disabledMcpServers 才禁用」；
   * 而内置的特殊 server（computer-use）反过来——必须出现在 enabledMcpServers 里才启用。
   */
export function isMcpServerDisabled(name: string): boolean {
  const projectConfig = getCurrentProjectConfig()
  // 中文：内置特殊 server 走「白名单」逻辑（要看 enabledMcpServers），普通 server 走「黑名单」
  if (isDefaultDisabledBuiltin(name)) {
    const enabledServers = projectConfig.enabledMcpServers || []
    return !enabledServers.includes(name)
  }
  const disabledServers = projectConfig.disabledMcpServers || []
  return disabledServers.includes(name)
}

  /**
   * 中文：往数组里加/删一个名字，若已经是目标状态就返回原数组（保持引用不变，避免无谓写盘）。
   */
function toggleMembership(
  list: string[],
  name: string,
  shouldContain: boolean,
): string[] {
  const contains = list.includes(name)
  if (contains === shouldContain) return list
  return shouldContain ? [...list, name] : list.filter(s => s !== name)
}

/**
 * Enable or disable an MCP server
 * @param name The name of the server
 * @param enabled Whether the server should be enabled
 */
  /**
   * 中文：启用 / 禁用某个 server，并把结果持久化到「当前项目的本地配置」。
   * 为什么写在这里而不是别处：启停状态是按项目记的（同一个 server 在 A 项目禁用、B 项目启用）。
   */
export function setMcpServerEnabled(name: string, enabled: boolean): void {
  const isBuiltinStateChange =
    isDefaultDisabledBuiltin(name) && isMcpServerDisabled(name) === enabled

  // 中文：saveCurrentProjectConfig 接收「旧配置 → 新配置」的函数；返回原对象表示无需写盘
  saveCurrentProjectConfig(current => {
    if (isDefaultDisabledBuiltin(name)) {
      const prev = current.enabledMcpServers || []
      const next = toggleMembership(prev, name, enabled)
      if (next === prev) return current
    // 中文：next === prev 时直接返回 current，避免一次没有意义的磁盘写入
      return { ...current, enabledMcpServers: next }
    }

    const prev = current.disabledMcpServers || []
    const next = toggleMembership(prev, name, !enabled)
    if (next === prev) return current
    return { ...current, disabledMcpServers: next }
  })

  if (isBuiltinStateChange) {
    logEvent('tengu_builtin_mcp_toggle', {
      serverName:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      enabled,
    })
  }
}
