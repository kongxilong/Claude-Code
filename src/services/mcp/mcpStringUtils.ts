/**
 * 【一句话定位】MCP 名字字符串的纯工具库：在「mcp__server__tool 限定名」与「server 段 / tool 段」之间来回转换。
 *
 * 【MCP 命名规则速查（理解本目录的前提）】
 * MCP server 暴露的 tool 名（如 create_issue）在 Claude Code 内部会被改写成带前缀的限定名：
 *     mcp__<serverName>__<toolName>
 * 之所以要加前缀：一是避免不同 server 的同名 tool 撞车；二是让权限规则能按 server 粒度放行/拒绝；
 * 三是模型看到 mcp__ 前缀就知道这是外部工具。反解时按 '__' 切三段。
 *
 * 【在架构中的位置】
 * - 上游：Tool.ts（构造内部 Tool 对象）、权限校验 permissionValidation、client.ts、config.ts、
 *   useManageMCPConnections.ts（把 MCP tool 转成 Tool / Command 时都要用这里的函数）。
 * - 下游：只依赖 normalization.ts（零依赖叶子，所以权限校验这种模块也敢 import 它）。
 *
 * 【本文件包含什么】
 * - mcpInfoFromString(toolString)：限定名 → { serverName, toolName }，不是 MCP 名则返回 null。
 * - getMcpPrefix(serverName)：得到 'mcp__server__' 前缀。
 * - buildMcpToolName(serverName, toolName)：拼完整限定名（上两者的组合）。
 * - getToolNameForPermissionCheck(tool)：权限匹配该用哪个名字（MCP tool 用限定名，内置 tool 用原名）。
 * - getMcpDisplayName(fullName, serverName)：去掉前缀，得到展示用的短名。
 * - extractMcpToolDisplayName(userFacingName)：从 'github - Add comment (MCP)' 里抠出 'Add comment'。
 *
 * 【TS 语法速查】
 * - 返回类型 `{ serverName: string; toolName: string | undefined } | null`：
 *   `A | B` 是联合类型 ≈ Java 的 sealed interface；`| null` ≈ 可能为 null 的返回值。
 * - `const [a, b, ...rest] = parts`：数组解构 + 剩余元素（rest），Java 没有对应语法。
 * - `tool.mcpInfo ? A : B`：三元；`mcpInfo?: {...}` 里的 `?` 表示字段可选（可以不传）。
 * - 模板字符串 `` `mcp__${x}__` `` ≈ Java 的 "mcp__" + x + "__"。
 */
/**
 * Pure string utility functions for MCP tool/server name parsing.
 * This file has no heavy dependencies to keep it lightweight for
 * consumers that only need string parsing (e.g., permissionValidation).
 */

import { normalizeNameForMCP } from './normalization.js'

/*
 * Extracts MCP server information from a tool name string
 * @param toolString The string to parse. Expected format: "mcp__serverName__toolName"
 * @returns An object containing server name and optional tool name, or null if not a valid MCP rule
 *
 * Known limitation: If a server name contains "__", parsing will be incorrect.
 * For example, "mcp__my__server__tool" would parse as server="my" and tool="server__tool"
 * instead of server="my__server" and tool="tool". This is rare in practice since server
 * names typically don't contain double underscores.
 */
  /**
   * 中文补充说明：把 'mcp__github__create_issue' 拆成 { serverName:'github', toolName:'create_issue' }。
   * 入参 toolString：待解析的字符串（通常来自 tool 名或权限规则）。
   * 返回：解析成功返回 { serverName, toolName }；不是 mcp__ 开头、或缺 server 段时返回 null。
   * 已知坑（英文注释也提了）：server 名里若本身含 '__' 会解析错位，例如 'mcp__my__server__tool'
   *   会被拆成 server='my'、tool='server__tool'。实际很少见，因为 server 名一般不含双下划线。
   */
export function mcpInfoFromString(toolString: string): {
  serverName: string
  toolName: string | undefined
} | null {
  const parts = toolString.split('__')
  const [mcpPart, serverName, ...toolNameParts] = parts
    // 中文：...toolNameParts 是「剩余参数」语法，把除前两个之外的所有段收进一个数组
  if (mcpPart !== 'mcp' || !serverName) {
    return null
  }
  // Join all parts after server name to preserve double underscores in tool names
    // 中文：用 '__' 原样 join 回去，这样 tool 名里自带的双下划线不会被吃掉（与上面 split 对称）
  const toolName =
    toolNameParts.length > 0 ? toolNameParts.join('__') : undefined
  return { serverName, toolName }
}

/**
 * Generates the MCP tool/command name prefix for a given server
 * @param serverName Name of the MCP server
 * @returns The prefix string
 */
  /**
   * 中文：算出某个 server 的 tool 名前缀，形如 'mcp__github__'。
   * 注意先过 normalizeNameForMCP：server 名里的空格/点号必须先换成下划线，否则前缀不合法。
   */
export function getMcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}

/**
 * Builds a fully qualified MCP tool name from server and tool names.
 * Inverse of mcpInfoFromString().
 * @param serverName Name of the MCP server (unnormalized)
 * @param toolName Name of the tool (unnormalized)
 * @returns The fully qualified name, e.g., "mcp__server__tool"
 */
  /**
   * 中文：拼出完整的 MCP 限定名，是 mcpInfoFromString 的逆运算。
   * 两个入参都允许是未规范化的原始名，函数内部各自做 normalizeNameForMCP。
   */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}

/**
 * Returns the name to use for permission rule matching.
 * For MCP tools, uses the fully qualified mcp__server__tool name so that
 * deny rules targeting builtins (e.g., "Write") don't match unprefixed MCP
 * replacements that share the same display name. Falls back to `tool.name`.
 */
  /**
   * 中文：权限规则匹配时应该用哪个名字？
   * 为什么 MCP tool 必须用限定名：假设用户 deny 了内置工具 'Write'，而某 MCP server 也提供同名的
   * 'Write'——若权限匹配用短名，那条 deny 规则会「误伤」MCP 的 Write；用 mcp__xxx__Write 就不会串。
   * 入参 tool：只要有 mcpInfo 字段就按 MCP 处理（结构化鸭子类型，不要求真的实现某个接口）。
   */
export function getToolNameForPermissionCheck(tool: {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}): string {
  return tool.mcpInfo
    ? buildMcpToolName(tool.mcpInfo.serverName, tool.mcpInfo.toolName)
    : tool.name
}

/*
 * Extracts the display name from an MCP tool/command name
 * @param fullName The full MCP tool/command name (e.g., "mcp__server_name__tool_name")
 * @param serverName The server name to remove from the prefix
 * @returns The display name without the MCP prefix
 */
  /**
   * 中文：去掉 'mcp__server__' 前缀，得到给用户看的短名（如 'create_issue'）。
   * 入参 serverName 必须传原始未规范化的名字，因为内部要重新算一遍前缀（规范化后才匹配得上）。
   */
export function getMcpDisplayName(
  fullName: string,
  serverName: string,
): string {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return fullName.replace(prefix, '')
}

/**
 * Extracts just the tool/command display name from a userFacingName
 * @param userFacingName The full user-facing name (e.g., "github - Add comment to issue (MCP)")
 * @returns The display name without server prefix and (MCP) suffix
 */
export function extractMcpToolDisplayName(userFacingName: string): string {
  /**
   * 中文：从用户可见名里抠出纯 tool 名，例如 'github - Add comment to issue (MCP)' → 'Add comment to issue'。
   * 为什么只能靠字符串硬抠（英文注释里那句 “This is really ugly” 就是在吐槽这点）：
   * 当前的 Tool 类型没有为「不同用途的展示名」留字段，只能从拼好的字符串里反推。
   */
  // This is really ugly but our current Tool type doesn't make it easy to have different display names for different purposes.

  // First, remove the (MCP) suffix if present
  let withoutSuffix = userFacingName.replace(/\s*\(MCP\)\s*$/, '')

  // Trim the result
  withoutSuffix = withoutSuffix.trim()

  // Then, remove the server prefix (everything before " - ")
  const dashIndex = withoutSuffix.indexOf(' - ')
    // 中文：先去掉结尾的 (MCP) 后缀，再按 ' - ' 切掉 server 前缀——顺序不能反，
    //        否则 'X (MCP) - Y' 这类名字会被切错
  if (dashIndex !== -1) {
    const displayName = withoutSuffix.substring(dashIndex + 3).trim()
    return displayName
  }

  // If no dash found, return the string without (MCP)
  return withoutSuffix
}
