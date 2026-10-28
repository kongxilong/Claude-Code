/**
 * 【一句话定位】MCP 的通用工具箱：按 server 过滤/剔除 tool、command、resource，以及作用域、配置哈希等杂项。
 *
 * 【在架构中的位置】
 * - 上游：useManageMCPConnections.ts（连接状态变化时增删 tool/command/resource）、
 *   config.ts（解析 scope / transport / headers）、/mcp 命令与 UI、权限校验。
 * - 下游：mcpStringUtils.ts、normalization.ts、types.ts、config.ts。
 *
 * 【本文件包含什么】
 * - 过滤类：filterToolsByServer / filterCommandsByServer / filterMcpPromptsByServer / filterResourcesByServer。
 * - 剔除类：excludeToolsByServer / excludeCommandsByServer / excludeResourcesByServer。
 * - commandBelongsToServer：判断一个 command 是否属于某 server（兼容 prompt 与 skill 两种命名）。
 * - hashMcpConfig：给配置算稳定哈希，用于「配置变了没」。
 * - excludeStalePluginClients：插件重载时清掉过期的 client 及其产物。
 * - 判定类：isToolFromMcpServer / isMcpTool / isMcpCommand。
 * - 作用域相关：describeMcpConfigFilePath / getScopeLabel / ensureConfigScope / ensureTransport。
 * - parseHeaders：把 'K: V' 字符串数组解析成 header 对象。
 * - getProjectMcpServerStatus：项目级 MCP server 的「批准 / 拒绝 / 待定」状态。
 * - getMcpServerScopeFromToolName：从 tool 名反查该 server 的作用域。
 * - extractAgentMcpServers：从 agent 定义的 frontmatter 里抽出 MCP server。
 * - getLoggingSafeMcpBaseUrl：把 URL 去掉 query 后用于埋点（防 token 泄露）。
 *
 * 【TS 语法速查】
 * - `config is McpStdioServerConfig`：「类型谓词」，告诉编译器这个布尔函数为真时参数类型收窄了，
 *   ≈ Java 的 `instanceof` 模式匹配（Java 做不到「自定义函数也能收窄」）。
 * - `const { scope: _scope, ...rest } = config`：解构时重命名 + 剩余属性，
 *   这是「剔除一个字段」的惯用写法（下划线前缀表示这个变量故意不用）。
 * - `tool.name?.startsWith(x)`：可选链——name 可能为 undefined，整条表达式直接得到 undefined。
 * - `switch (scope) { case 'user': ... }`：与 Java 的 switch 基本一致，但 case 可以是字符串。
 * - `entries[0]!`：后缀 `!` 是「非空断言」≈ 强制告诉编译器“我确定它不是 null”，
 *   Java 里对应「不加判空直接强转」，用错会在运行时炸。
 * - `Record<string, ServerResource[]>` ≈ Map<String, List<ServerResource>>。
 * - `{ ...resources }` 再 `delete`：先浅拷贝再删，避免改到原对象（不可变更新）。
 */
import { createHash } from 'crypto'
import { join } from 'path'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import type { AgentMcpServerInfo } from '../../components/mcp/types.js'
import type { Tool } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import {
  getSettings_DEPRECATED,
  hasSkipDangerousModePermissionPrompt,
} from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getEnterpriseMcpFilePath, getMcpConfigByName } from './config.js'
import { mcpInfoFromString } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import {
  type ConfigScope,
  ConfigScopeSchema,
  type MCPServerConnection,
  type McpHTTPServerConfig,
  type McpServerConfig,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type McpWebSocketServerConfig,
  type ScopedMcpServerConfig,
  type ServerResource,
} from './types.js'

/**
 * Filters tools by MCP server name
 *
 * @param tools Array of tools to filter
 * @param serverName Name of the MCP server
 * @returns Tools belonging to the specified server
 */
  /**
   * 中文：挑出属于某个 MCP server 的所有 tool。
   * 原理：tool 名形如 mcp__<server>__<tool>，用前缀匹配即可；server 名要先规范化才能拼出正确前缀。
   */
export function filterToolsByServer(tools: Tool[], serverName: string): Tool[] {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return tools.filter(tool => tool.name?.startsWith(prefix))
}

/**
 * True when a command belongs to the given MCP server.
 *
 * MCP **prompts** are named `mcp__<server>__<prompt>` (wire-format constraint);
 * MCP **skills** are named `<server>:<skill>` (matching plugin/nested-dir skill
 * naming). Both live in `mcp.commands`, so cleanup and filtering must match
 * either shape.
 */
  /**
   * 中文：判断某个 command 是否属于指定 server。
   * 为什么要兼容两种前缀（英文注释有说明）：MCP 的 prompt 命名成 mcp__<server>__<prompt>（协议约束），
   * 而 MCP 的 skill 命名成 <server>:<skill>（跟插件/嵌套目录的 skill 命名保持一致）。
   * 两者都放在 mcp.commands 里，所以过滤时必须两种形态都认。
   */
export function commandBelongsToServer(
  command: Command,
  serverName: string,
): boolean {
  const normalized = normalizeNameForMCP(serverName)
  const name = command.name
  if (!name) return false
  return (
    name.startsWith(`mcp__${normalized}__`) || name.startsWith(`${normalized}:`)
  )
}

/**
 * Filters commands by MCP server name
 * @param commands Array of commands to filter
 * @param serverName Name of the MCP server
 * @returns Commands belonging to the specified server
 */
  /**
   * 中文：挑出属于某个 server 的所有 command（prompt + skill 都会命中）。
   */
export function filterCommandsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(c => commandBelongsToServer(c, serverName))
}

/**
 * Filters MCP **prompts** (not skills) by server. Used by the `/mcp` menu
 * capabilities display — skills are a separate feature shown in `/skills`,
 * so they mustn't inflate the "prompts" capability badge.
 *
 * The distinguisher is `loadedFrom === 'mcp'`: MCP skills set it, MCP
 * prompts don't (they use `isMcp: true` instead).
 */
  /**
   * 中文：只挑 MCP **prompt**（排除 skill）。用于 /mcp 菜单里的能力展示——
   * skill 是另一套功能、单独在 /skills 里显示，不能混进 prompts 的计数里。
   * 区分依据：MCP skill 会设置 loadedFrom==='mcp'，而 MCP prompt 不会（它们用 isMcp:true 标记）。
   */
export function filterMcpPromptsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(
    c =>
      commandBelongsToServer(c, serverName) &&
      !(c.type === 'prompt' && c.loadedFrom === 'mcp'),
  )
}

/**
 * Filters resources by MCP server name
 * @param resources Array of resources to filter
 * @param serverName Name of the MCP server
 * @returns Resources belonging to the specified server
 */
  /**
   * 中文：挑出属于某个 server 的所有 resource（resource 上自带 server 字段，直接比即可）。
   */
export function filterResourcesByServer(
  resources: ServerResource[],
  serverName: string,
): ServerResource[] {
  return resources.filter(resource => resource.server === serverName)
}

/**
 * Removes tools belonging to a specific MCP server
 * @param tools Array of tools
 * @param serverName Name of the MCP server to exclude
 * @returns Tools not belonging to the specified server
 */
  /**
   * 中文：剔除某个 server 的 tool——server 断开或被禁用时用它清理工具列表。
   */
export function excludeToolsByServer(
  tools: Tool[],
  serverName: string,
): Tool[] {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return tools.filter(tool => !tool.name?.startsWith(prefix))
}

/**
 * Removes commands belonging to a specific MCP server
 * @param commands Array of commands
 * @param serverName Name of the MCP server to exclude
 * @returns Commands not belonging to the specified server
 */
  /**
   * 中文：剔除某个 server 的 command（prompt + skill）。
   */
export function excludeCommandsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(c => !commandBelongsToServer(c, serverName))
}

/**
 * Removes resources belonging to a specific MCP server
 * @param resources Map of server resources
 * @param serverName Name of the MCP server to exclude
 * @returns Resources map without the specified server
 */
  /**
   * 中文：从「server 名 → resource 列表」的映射里删掉某个 server。
   * 为什么先拷贝再 delete：直接 delete 会改动调用方传入的对象（共享可变状态是 bug 温床）。
   */
export function excludeResourcesByServer(
  resources: Record<string, ServerResource[]>,
  serverName: string,
): Record<string, ServerResource[]> {
  const result = { ...resources }
  delete result[serverName]
  return result
}

/**
 * Stable hash of an MCP server config for change detection on /reload-plugins.
 * Excludes `scope` (provenance, not content — moving a server from .mcp.json
 * to settings.json shouldn't reconnect it). Keys sorted so `{a:1,b:2}` and
 * `{b:2,a:1}` hash the same.
 */
  /**
   * 中文：给配置算一个稳定哈希，用来判断「配置是否变了」（/reload-plugins 时用）。
   * 两个关键设计：① 排除 scope 字段——scope 只表示配置来自哪里，不代表内容，
   *   把 server 从 .mcp.json 挪到 settings.json 不应该触发重连；
   * ② 序列化前把对象 key 排序——保证 {a:1,b:2} 和 {b:2,a:1} 得到同一个哈希。
   * 返回：取 sha256 的前 16 位（够用且短）。
   */
export function hashMcpConfig(config: ScopedMcpServerConfig): string {
  const { scope: _scope, ...rest } = config
  // 中文：解构时把 scope 单独摘出来改名为 _scope（下划线表示「故意不用」），剩下的 rest 才是要哈希的内容
  const stable = jsonStringify(rest, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
      return sorted
    }
    return v
  })
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
  // 中文：只取前 16 个十六进制字符：完整 64 位太长，这里只做相等性比较，截断足够
}

/**
 * Remove stale MCP clients and their tools/commands/resources. A client is
 * stale if:
 *   - scope 'dynamic' and name no longer in configs (plugin disabled), or
 *   - config hash changed (args/url/env edited in .mcp.json) — any scope
 *
 * The removal case is scoped to 'dynamic' so /reload-plugins can't
 * accidentally disconnect a user-configured server that's just temporarily
 * absent from the in-memory config (e.g. during a partial reload). The
 * config-changed case applies to all scopes — if the config actually changed
 * on disk, reconnecting is what you want.
 *
 * Returns the stale clients so the caller can disconnect them (clearServerCache).
 */
  /**
   * 中文：插件重载时清掉「过期」的 MCP client 及其 tool/command/resource。
   * 什么叫过期（英文注释解释了两种判定）：
   *   ① 配置没了，且这个 client 的 scope 是 'dynamic'（插件被禁用）；
   *   ② 配置哈希变了（.mcp.json 里的 args/url/env 被改了），任何 scope 都算。
   * 为什么「配置没了」只针对 dynamic：防止 /reload-plugins 误伤用户自己配的 server——
   * 它可能只是这次部分重载时暂时不在内存配置里。而「配置真的变了」就该重连，这符合直觉。
   * 返回：新的 mcp 状态 + stale 列表，让调用方去真正断开它们（clearServerCache）。
   */
export function excludeStalePluginClients(
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
  },
  configs: Record<string, ScopedMcpServerConfig>,
): {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
  stale: MCPServerConnection[]
} {
  const stale = mcp.clients.filter(c => {
    const fresh = configs[c.name]
    if (!fresh) return c.config.scope === 'dynamic'
    // 中文：配置里找不到同名 server —— 只有 dynamic（插件提供）的才认为是被卸载了，其它 scope 保守保留
    return hashMcpConfig(c.config) !== hashMcpConfig(fresh)
    // 中文：配置还在但内容变了 → 必须重连（无论什么 scope），否则改了配置不生效
  })
  if (stale.length === 0) {
    return { ...mcp, stale: [] }
  }

  let { tools, commands, resources } = mcp
  for (const s of stale) {
    tools = excludeToolsByServer(tools, s.name)
    commands = excludeCommandsByServer(commands, s.name)
    resources = excludeResourcesByServer(resources, s.name)
  }
  const staleNames = new Set(stale.map(c => c.name))

  return {
    clients: mcp.clients.filter(c => !staleNames.has(c.name)),
    tools,
    commands,
    resources,
    stale,
  }
}

/**
 * Checks if a tool name belongs to a specific MCP server
 * @param toolName The tool name to check
 * @param serverName The server name to match against
 * @returns True if the tool belongs to the specified server
 */
export function isToolFromMcpServer(
  toolName: string,
  serverName: string,
): boolean {
  const info = mcpInfoFromString(toolName)
  return info?.serverName === serverName
}
  /**
   * 中文：判断某个 tool 名是否来自指定 server（先反解出 server 段再比）。
   */

/**
 * Checks if a tool belongs to any MCP server
 * @param tool The tool to check
 * @returns True if the tool is from an MCP server
 */
  /**
   * 中文：判断这个 tool 是不是 MCP 提供的。两个判据取或：名字以 mcp__ 开头，或 isMcp 标记为 true。
   * 为什么要留 isMcp 这个标记：有些 tool 的名字不叫 mcp__ 开头（例如被重命名过的），只能靠标记识别。
   */
export function isMcpTool(tool: Tool): boolean {
  return tool.name?.startsWith('mcp__') || tool.isMcp === true
}

/**
 * Checks if a command belongs to any MCP server
 * @param command The command to check
 * @returns True if the command is from an MCP server
 */
  /**
   * 中文：判断这个 command 是不是 MCP 提供的（判据同 isMcpTool）。
   */
export function isMcpCommand(command: Command): boolean {
  return command.name?.startsWith('mcp__') || command.isMcp === true
}

/**
 * Describe the file path for a given MCP config scope.
 * @param scope The config scope ('user', 'project', 'local', or 'dynamic')
 * @returns A description of where the config is stored
 */
  /**
   * 中文：把 scope 翻译成「配置存在哪个文件里」的人话描述，供 /mcp 界面展示。
   * default 分支返回 scope 本身——新加的 scope 没在这里列出来时也不会崩。
   */
export function describeMcpConfigFilePath(scope: ConfigScope): string {
  switch (scope) {
    case 'user':
      return getGlobalClaudeFile()
    case 'project':
      return join(getCwd(), '.mcp.json')
    case 'local':
      return `${getGlobalClaudeFile()} [project: ${getCwd()}]`
    case 'dynamic':
      return 'Dynamically configured'
    case 'enterprise':
      return getEnterpriseMcpFilePath()
    case 'claudeai':
      return 'claude.ai'
    default:
      return scope
  }
}

  /**
   * 中文：scope 的展示标签（比上面更偏向「这个配置的影响范围」）。
   * 例如 project = 通过 .mcp.json 共享给团队；local = 只在这个项目里、且只属于你自己。
   */
export function getScopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case 'local':
      return 'Local config (private to you in this project)'
    case 'project':
      return 'Project config (shared via .mcp.json)'
    case 'user':
      return 'User config (available in all your projects)'
    case 'dynamic':
      return 'Dynamic config (from command line)'
    case 'enterprise':
      return 'Enterprise config (managed by your organization)'
    case 'claudeai':
      return 'claude.ai config'
    default:
      return scope
  }
}

  /**
   * 中文：把用户输入的 scope 字符串校验成合法枚举，空值默认 'local'。
   * 为什么不直接 as（英文注释的精神）：用户输入必须校验，非法值要给出带可选值列表的清晰报错。
   */
export function ensureConfigScope(scope?: string): ConfigScope {
  if (!scope) return 'local'

  if (!ConfigScopeSchema().options.includes(scope as ConfigScope)) {
  // 中文：ConfigScopeSchema().options 就是 zod enum 的合法值数组——一份定义同时用于运行时校验和报错文案
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${ConfigScopeSchema().options.join(', ')}`,
    )
  }

  return scope as ConfigScope
}

  /**
   * 中文：把 transport 字符串收敛成 'stdio' | 'sse' | 'http'，空值默认 'stdio'。
   * 这三种是用户能在配置里手写的传输方式；ws / sdk / sse-ide 等是内部专用，不在用户可选范围内。
   */
export function ensureTransport(type?: string): 'stdio' | 'sse' | 'http' {
  if (!type) return 'stdio'

  if (type !== 'stdio' && type !== 'sse' && type !== 'http') {
    throw new Error(
      `Invalid transport type: ${type}. Must be one of: stdio, sse, http`,
    )
  }

  return type as 'stdio' | 'sse' | 'http'
}

  /**
   * 中文：把命令行传来的 ['K: V', ...] 解析成 header 对象。
   * 为什么要自己解析而不是用现成库：只需要「按第一个冒号切开」这么简单，且要对空 header 名报错。
   */
export function parseHeaders(headerArray: string[]): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const header of headerArray) {
    const colonIndex = header.indexOf(':')
    // 中文：按「第一个」冒号切——value 里允许再出现冒号（例如 Authorization: Bearer a:b）
    if (colonIndex === -1) {
      throw new Error(
        `Invalid header format: "${header}". Expected format: "Header-Name: value"`,
      )
    }

    const key = header.substring(0, colonIndex).trim()
    const value = header.substring(colonIndex + 1).trim()

    if (!key) {
      throw new Error(
        `Invalid header: "${header}". Header name cannot be empty.`,
      )
    }

    headers[key] = value
  }

  return headers
}

  /**
   * 中文：项目级 MCP server（.mcp.json 里配的）的审批状态：approved / rejected / pending。
   * 为什么项目级需要审批：.mcp.json 是随仓库分发的，clone 一个陌生仓库就会带入一批 server，
   * 所以必须先让用户确认「我信任这些 server」才能连。
   * 判定顺序：先看是否被显式拒绝 → 再看是否被显式批准或全批准 → 再是两种特殊模式的自动批准 → 否则待定。
   */
export function getProjectMcpServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const settings = getSettings_DEPRECATED()
  const normalizedName = normalizeNameForMCP(serverName)

  // TODO: This fails an e2e test if the ?. is not present. This is likely a bug in the e2e test.
  // Will fix this in a follow-up PR.
  // 中文：注意这里的 ?.（英文 TODO 说明了）：settings 可能还没初始化，去掉 ?. 会让 e2e 测试失败
  if (
    settings?.disabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    )
  ) {
    return 'rejected'
  }

  if (
    settings?.enabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    ) ||
    settings?.enableAllProjectMcpServers
  ) {
    return 'approved'
  }

  // In bypass permissions mode (--dangerously-skip-permissions), there's no way
  // to show an approval popup. Auto-approve if projectSettings is enabled since
  // the user has explicitly chosen to bypass all permission checks.
  // SECURITY: We intentionally only check skipDangerousModePermissionPrompt via
  // hasSkipDangerousModePermissionPrompt(), which reads from userSettings/localSettings/
  // flagSettings/policySettings but NOT projectSettings (repo-level .claude/settings.json).
  // This is intentional: a repo should not be able to accept the bypass dialog on behalf of
  // users. We also do NOT check getSessionBypassPermissionsMode() here because
  // sessionBypassPermissionsMode can be set from project settings before the dialog is shown,
  // which would allow RCE attacks via malicious project settings.
  // 中文：★ 安全要点（英文注释是 SECURITY 级别的说明）：这里只能用 hasSkipDangerousModePermissionPrompt()，
  //       它只读取 userSettings / localSettings / flagSettings / policySettings，**不读** projectSettings。
  //       原因：仓库级的 .claude/settings.json 不该有资格替用户按下「绕过所有权限检查」这个按钮。
  //       同理也不看 getSessionBypassPermissionsMode()——它可能被项目设置在弹框之前就改掉，
  //       那样恶意仓库就能直接获得 RCE 能力。
  if (
    hasSkipDangerousModePermissionPrompt() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  // In non-interactive mode (SDK, claude -p, piped input), there's no way to
  // show an approval popup. Auto-approve if projectSettings is enabled since:
  // 1. The user/developer explicitly chose to run in this mode
  // 2. For SDK, projectSettings is off by default - they must explicitly enable it
  // 3. For -p mode, the help text warns to only use in trusted directories
  // 中文：非交互模式（SDK、claude -p、管道输入）没法弹框，只能自动批准；
  //       但这要求 projectSettings 是开启的，而 SDK 默认关闭——等于「用户必须显式开两次」
  if (
    getIsNonInteractiveSession() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  return 'pending'
}

/**
 * Get the scope/settings source for an MCP server from a tool name
 * @param toolName MCP tool name (format: mcp__serverName__toolName)
 * @returns ConfigScope or null if not an MCP tool or server not found
 */
  /**
   * 中文：从 tool 名反查这个 server 属于哪个作用域（用于权限判断：项目级 server 要更谨慎）。
   * 返回 null：不是 MCP tool，或找不到对应的 server 配置。
   */
export function getMcpServerScopeFromToolName(
  toolName: string,
): ConfigScope | null {
  if (!isMcpTool({ name: toolName } as Tool)) {
  // 中文：`{ name: toolName } as Tool` 是「假造一个最小对象」来复用 isMcpTool——
  //       TS 的结构化类型允许这么做，但绕过了类型检查，属于有意为之的便捷写法
    return null
  }

  // Extract server name from tool name (format: mcp__serverName__toolName)
  const mcpInfo = mcpInfoFromString(toolName)
  if (!mcpInfo) {
    return null
  }

  // Look up server config
  const serverConfig = getMcpConfigByName(mcpInfo.serverName)

  // Fallback: claude.ai servers have normalized names starting with "claude_ai_"
  // but aren't in getMcpConfigByName (they're fetched async separately)
  // 中文：兜底逻辑——claude.ai 的 server 是异步拉取的，不在 getMcpConfigByName 里；
  //       它们的规范化名都以 claude_ai_ 开头，据此直接判定为 'claudeai' 作用域
  if (!serverConfig && mcpInfo.serverName.startsWith('claude_ai_')) {
    return 'claudeai'
  }

  return serverConfig?.scope ?? null
}

// Type guards for MCP server config types
  // 中文：下面四个是「类型谓词」函数——返回布尔，但返回值类型写成 `config is X`，
  //       这样调用方 if 之后编译器就知道 config 已经收窄成具体类型了（≈ Java 的 instanceof 模式匹配）
function isStdioConfig(
  config: McpServerConfig,
): config is McpStdioServerConfig {
  return config.type === 'stdio' || config.type === undefined
  // 中文：type 为 undefined 也算 stdio——历史配置里 stdio 是默认类型、可以省略不写，必须向后兼容
}

function isSSEConfig(config: McpServerConfig): config is McpSSEServerConfig {
  return config.type === 'sse'
}

function isHTTPConfig(config: McpServerConfig): config is McpHTTPServerConfig {
  return config.type === 'http'
}

function isWebSocketConfig(
  config: McpServerConfig,
): config is McpWebSocketServerConfig {
  return config.type === 'ws'
}

/**
 * Extracts MCP server definitions from agent frontmatter and groups them by server name.
 * This is used to show agent-specific MCP servers in the /mcp command.
 *
 * @param agents Array of agent definitions
 * @returns Array of AgentMcpServerInfo, grouped by server name with list of source agents
 */
  /**
   * 中文：从 agent 定义（markdown frontmatter）里抽出它们声明的 MCP server，按 server 名聚合。
   * 入参 agents：所有 agent 定义。
   * 返回：AgentMcpServerInfo[]，每项含 server 名、配置、以及「哪些 agent 引用了它」。
   * 用途：/mcp 命令里展示「某个 agent 专属的 MCP server」。
   */
export function extractAgentMcpServers(
  agents: AgentDefinition[],
): AgentMcpServerInfo[] {
  // Map: server name -> { config, sourceAgents }
  const serverMap = new Map<
    string,
    {
      config: McpServerConfig & { name: string }
      sourceAgents: string[]
    }
  >()

  for (const agent of agents) {
    if (!agent.mcpServers?.length) continue

    for (const spec of agent.mcpServers) {
      // Skip string references - these refer to servers already in global config
      if (typeof spec === 'string') continue
      // 中文：字符串形式的引用（只写个名字）指向全局配置里已有的 server，这里不重复解析

      // Inline definition as { [name]: config }
      const entries = Object.entries(spec)
      if (entries.length !== 1) continue
      // 中文：内联定义必须是 { 名字: 配置 } 这种「恰好一个键值对」的形式，否则视为脏数据跳过

      const [serverName, serverConfig] = entries[0]!
      // 中文：`entries[0]!` 的 ! 是非空断言——上面已确认长度为 1，但 TS 看不出来，只能手动断言
      const existing = serverMap.get(serverName)

      if (existing) {
        // Add this agent as another source
        if (!existing.sourceAgents.includes(agent.agentType)) {
          existing.sourceAgents.push(agent.agentType)
        }
      } else {
        // New server
        serverMap.set(serverName, {
          config: { ...serverConfig, name: serverName } as McpServerConfig & {
            name: string
          },
          sourceAgents: [agent.agentType],
        })
      }
    }
  }

  // Convert map to array of AgentMcpServerInfo
  // Only include transport types supported by AgentMcpServerInfo
  const result: AgentMcpServerInfo[] = []
  for (const [name, { config, sourceAgents }] of serverMap) {
    // Use type guards to properly narrow the discriminated union type
    // Only include transport types that are supported by AgentMcpServerInfo
    if (isStdioConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'stdio',
        command: config.command,
        needsAuth: false,
      })
    } else if (isSSEConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'sse',
        url: config.url,
        needsAuth: true,
      })
    } else if (isHTTPConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'http',
        url: config.url,
        needsAuth: true,
      })
    } else if (isWebSocketConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'ws',
        url: config.url,
        needsAuth: false,
      })
    }
    // Skip unsupported transport types (sdk, claudeai-proxy, sse-ide, ws-ide)
    // These are internal types not meant for agent MCP server display
  }

  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Extracts the MCP server base URL (without query string) for analytics logging.
 * Query strings are stripped because they can contain access tokens.
 * Trailing slashes are also removed for normalization.
 * Returns undefined for stdio/sdk servers or if URL parsing fails.
 */
  /**
   * 中文：把 MCP server 的 URL 脱敏后用于埋点/日志。
   * 为什么必须去掉 query：query 里经常带着 access token，直接打日志等于泄露凭据。
   * 返回 undefined 的情况：stdio / sdk 这类没有 url 的 server，或 URL 解析失败。
   */
export function getLoggingSafeMcpBaseUrl(
  config: McpServerConfig,
): string | undefined {
  if (!('url' in config) || typeof config.url !== 'string') {
  // 中文：`'url' in config` 既做运行时判断，也让 TS 把 config 收窄成「有 url 字段」的那些分支
    return undefined
  }

  try {
    const url = new URL(config.url)
    url.search = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}
