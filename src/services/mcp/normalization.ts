/**
 * 【一句话定位】MCP 名称规范化：把 server / tool 名字洗成 Anthropic API 允许的字符集合。
 *
 * 【在架构中的位置】
 * - 上游：mcpStringUtils.ts（拼 mcp__server__tool 限定名）、client.ts、config.ts、claudeai.ts，
 *   凡是要生成或反解 MCP 限定名的地方，都要先过一遍本文件的 normalizeNameForMCP()。
 * - 下游：无。本文件刻意零依赖（英文原注释写了“no dependencies to avoid circular imports”），
 *   是整个 mcp 目录依赖图最底层的叶子，谁都能 import 它而不会形成循环依赖。
 *
 * 【本文件包含什么】
 * - CLAUDEAI_SERVER_PREFIX：claude.ai 托管 server 的名字前缀常量（'claude.ai '，末尾带一个空格）。
 * - normalizeNameForMCP(name)：唯一导出函数，非法字符→下划线；claude.ai server 额外折叠连续下划线。
 *
 * 【为什么需要它】
 * - Anthropic API 对 tool 名有硬性正则 ^[a-zA-Z0-9_-]{1,64}$，而 MCP server 名来自用户配置，
 *   可能带空格、点号、中文等非法字符，直接塞给 API 会被拒。
 * - MCP tool 名用双下划线 __ 作为「server 段 / tool 段」的分隔符，所以名字里残留的下划线会干扰反解
 *   （见 mcpStringUtils.ts 的 mcpInfoFromString），下面的 claude.ai 分支就是为此做的补救。
 *
 * 【TS 语法速查】
 * - `const X = '...'`：模块级常量 ≈ Java 的 `static final String`。
 * - `export function f(name: string): string`：类型标注在参数**后面**、返回值在函数签名**后面**，
 *   与 Java（`String f(String name)`）前后相反，是 Java 工程师最容易看串的地方。
 * - `/[^a-zA-Z0-9_-]/g`：正则字面量用 /.../ 包裹（Java 里是字符串），末尾 g = 全局 ≈ replaceAll。
 * - `let` ≈ 可重新赋值的局部变量，`const` ≈ final。
 */
/**
 * Pure utility functions for MCP name normalization.
 * This file has no dependencies to avoid circular imports.
 */

// Claude.ai server names are prefixed with this string
  // 中文：claude.ai 托管的 server，名字统一以 “claude.ai ” 开头（注意末尾有一个空格）
const CLAUDEAI_SERVER_PREFIX = 'claude.ai '

/**
 * Normalize server names to be compatible with the API pattern ^[a-zA-Z0-9_-]{1,64}$
 * Replaces any invalid characters (including dots and spaces) with underscores.
 *
 * For claude.ai servers (names starting with "claude.ai "), also collapses
 * consecutive underscores and strips leading/trailing underscores to prevent
 * interference with the __ delimiter used in MCP tool names.
 */
  /**
   * 中文补充说明（英文注释保留，两者并存）：
   * 作用：把任意 server/tool 名 → 只含 [A-Za-z0-9_-] 的合法名。
   * 入参 name：原始的、可能带空格或点号的名字。
   * 返回：规范化后的名字（本函数不负责长度截断，超 64 字符需调用方自行处理）。
   * 步骤：① 全量替换非法字符为下划线 → ② 仅当是 claude.ai server 时折叠连续下划线并去首尾下划线。
   */
export function normalizeNameForMCP(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    // 中文：g 标志表示「替换所有匹配」≈ Java 的 replaceAll；不带 g 只替换第一个
  if (name.startsWith(CLAUDEAI_SERVER_PREFIX)) {
    // 中文：判断用的是原始 name（含空格），被替换的结果存在 normalized 里，两者不能混用
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '')
    // 中文：_+/g 折叠连续下划线；^_|_$ 去掉首尾下划线——因为 __ 是 MCP tool 名的分段分隔符，
    //        残留的下划线会让 mcpStringUtils.ts 的 mcpInfoFromString() 反解出错误的 server 段
  }
  return normalized
}
