/**
 * ============================================================================
 *  【文件总览】src/tools/ToolSearchTool/constants.ts —— ToolSearch 工具的常量
 * ============================================================================
 *
 *  【一句话定位】
 *  只导出一个常量：`TOOL_SEARCH_TOOL_NAME = 'ToolSearch'`，
 *  也就是模型在对话里调用「工具检索」时使用的工具名。
 *
 *  【在架构中的位置】
 *
 *      系统提示里只列出工具名（不含 schema），例如：
 *          <available-deferred-tools> mcp__github__create_issue ... </…>
 *        └─> 模型想用某个工具 → 调 ToolSearch
 *              └─> ToolSearchTool.call()    ← src/tools/ToolSearchTool/ToolSearchTool.ts
 *                    └─> 返回 tool_reference 块
 *                          └─> 客户端把完整 schema 展开进上下文
 *                                └─> 模型这才能调用该工具
 *
 *  本文件处在最底层，所有"需要引用 ToolSearch 工具名"的地方都从这里取，
 *  避免硬编码字符串散落各处。
 *
 *  【本文件包含什么】
 *   1. TOOL_SEARCH_TOOL_NAME —— 字符串常量 'ToolSearch'。
 *
 *  【TS 语法速查】
 *   - `export const X = 'v'` ≈ Java `public static final String X = "v";`
 *     这里**没写** `: string`，TS 会推断成字面量类型 `'ToolSearch'`
 *     —— 比 string 更精确，拼错会在编译期报错。
 *   - 在 prompt.ts 里你会看到 `export { TOOL_SEARCH_TOOL_NAME } from './constants.js'`
 *     这种"转发导出"，是为了让调用方少 import 一个模块。
 * ============================================================================
 */

// 工具名常量。用常量而非散落的字符串字面量：
// ① 将来改名只改一处；② 字面量类型能让拼错的名字在编译期被发现。
export const TOOL_SEARCH_TOOL_NAME = 'ToolSearch'
