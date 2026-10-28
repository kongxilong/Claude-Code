/**
 * ============================================================================
 *  【文件总览】src/tools/ListMcpResourcesTool/prompt.ts —— 常量与文案
 * ============================================================================
 *
 *  【一句话定位】
 *  定义工具名常量 + 两段给**模型**看的说明文字（DESCRIPTION 给工具签名用、
 *  PROMPT 给详细用法用）。没有任何逻辑。
 *
 *  【在架构中的位置】
 *      src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts
 *        ├─ name: LIST_MCP_RESOURCES_TOOL_NAME  ← ★ 本文件
 *        ├─ description() → DESCRIPTION         ← ★ 本文件
 *        └─ prompt()      → PROMPT              ← ★ 本文件
 *              └─ 三者随工具一起注册进 src/tools.ts 的工具表
 *                    └─ src/query.ts 主循环把描述发给模型
 *
 *  与 src/services/mcp/ 的关系（MCP 家族通用）：
 *      本目录        = 薄封装（把 MCP 的 resource 能力包装成一个 Tool）
 *      services/mcp/ = 真身（client.ts 里 ensureConnectedClient / fetchResourcesForClient
 *                      等函数才是真正跟 MCP server 通信的地方）
 *
 *  【本文件包含什么】
 *   1. LIST_MCP_RESOURCES_TOOL_NAME  工具名字符串 'ListMcpResourcesTool'
 *   2. DESCRIPTION  简短说明（会进工具的 JSON Schema 描述）
 *   3. PROMPT       详细用法说明（含参数解释与使用示例）
 *
 *  【为什么要拆成 DESCRIPTION 和 PROMPT 两份？】
 *      DESCRIPTION：短，用在「工具列表」这种需要紧凑展示的场合；
 *      PROMPT：长，带参数和示例，用在需要模型准确填参数的场合。
 *      两者内容有重叠但**详略不同**，是 Claude Code 的通用约定。
 *
 *  【resource 是什么？（MCP 的核心概念之一）】
 *      MCP server 除了暴露 **tools**（能被模型调用的函数），
 *      还能暴露 **resources**（可被读取的数据，类似文件）。
 *      比如一个数据库 MCP server 可以把每张表暴露成一个 resource。
 *      本工具就是「列出所有可用的 resource」，
 *      真正的读取由 ReadMcpResourceTool 完成 —— 两者是「列目录」和「读文件」的关系。
 *
 *  【TS 语法速查】
 *   - `` `...` `` 模板字符串：这里用它写**多行**文案，换行会被原样保留。
 *                          （Java 15+ 的 text block 三引号是类似的东西。）
 *   - `` \`listMcpResources\` ``  反斜杠转义反引号：因为整段文字本身就在
 *                          反引号里，想在文本中出现字面量的反引号必须转义。
 *                          （Java 的 text block 里要写 `"""` 也得转义，同理。）
 *   - `export const`  ≈ `public static final`（常量，不可重新赋值）。
 */

export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'

// 【中文补充】DESCRIPTION 是「工具签名里那句简介」，模型在工具列表里看到的就是它。
// 里面特意强调「每条结果都带 server 字段」—— 因为返回值是**跨 server 汇总**的，
// 模型必须知道每条 resource 来自哪个 server，否则下一步调 ReadMcpResourceTool
// 时不知道该填哪个 server 名。这是把「下游需要的字段」在描述里提前交代清楚。
export const DESCRIPTION = `
Lists available resources from configured MCP servers.
Each resource object includes a 'server' field indicating which server it's from.

Usage examples:
- List all resources from all servers: \`listMcpResources\`
- List resources from a specific server: \`listMcpResources({ server: "myserver" })\`
`

export const PROMPT = `
List available resources from configured MCP servers.
Each returned resource will include all standard MCP resource fields plus a 'server' field 
indicating which server the resource belongs to.

Parameters:
- server (optional): The name of a specific MCP server to get resources from. If not provided,
  resources from all servers will be returned.
`
