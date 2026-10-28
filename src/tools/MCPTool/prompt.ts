/**
 * ============================================================================
 *  【文件总览】src/tools/MCPTool/prompt.ts —— 两个**空**的占位常量
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件导出两个空字符串：PROMPT 和 DESCRIPTION。
 *  它们**故意**是空的，因为 MCP 工具的真实描述来自 MCP server 自己
 *  （每个 server 在 list_tools 时会带上自己 tool 的 description），
 *  在 src/services/mcp/client.ts 里被覆盖填充。
 *
 *  对比一下 LSPTool/prompt.ts —— 那里写满了 9 种 operation 的说明，
 *  因为 LSP 是我们自己内置的、描述得写死；
 *  而 MCP 是外部生态，描述只能**运行时**从 server 拿。这就是两者必须不同的根本原因。
 *
 *  【在架构中的位置】
 *      src/tools/MCPTool/MCPTool.ts
 *        ├─ description() { return DESCRIPTION }   ← ★ 本文件（空串占位）
 *        └─ prompt()      { return PROMPT }        ← ★ 本文件（空串占位）
 *              ↑ 两个方法在 src/services/mcp/client.ts 被**覆盖**，
 *                返回该 MCP server 自带的那段描述（还会按长度上限截断）。
 *
 *      src/services/mcp/client.ts  ← 真身：连接、列工具、生成实例、执行调用
 *      src/services/mcp/*          ← 其余 MCP 服务能力（auth / config / 连接管理）
 *
 *  【为什么还要保留这个「空文件」？】
 *  两个原因：
 *   ① 保持目录结构的**一致性**：每个工具目录都有 prompt.ts，读者不用记例外。
 *   ② 提供一个**类型与命名的单一来源**：所有引用 DESCRIPTION / PROMPT 的地方
 *      都从这里 import；将来若要在模板层加默认文案，只改这一处。
 *
 *  【TS 语法速查】
 *   - `export const X = ''`  ≈ `public static final String X = ""`，
 *     但因为是 const，赋别的值会在编译期报错（Java 的 final 同理）。
 *   - 空串 '' 在 JS 里是 **falsy**：`if (DESCRIPTION)` 会走 else 分支。
 *     也就是说下游如果忘了覆盖，会得到「假」而不是崩溃 —— 这是一把双刃剑：
 *     不会崩，但会静默地不给模型任何描述，导致模型乱用工具。
 */

// Actual prompt and description are overridden in mcpClient.ts
// 【中文补充】「真正的 prompt 和 description 在 mcpClient.ts 里被覆盖」——
// 注意这里说的是 mcpClient.ts，实际文件位于 src/services/mcp/client.ts。
// 覆盖的方式是对象展开：`{ ...MCPTool, description: async () => serverProvidedText }`，
// 后面的字段覆盖前面的，所以模板里的空串只在「没人覆盖」时才生效。
export const PROMPT = ''
export const DESCRIPTION = ''
