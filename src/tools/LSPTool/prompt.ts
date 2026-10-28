/**
 * ============================================================================
 *  【文件总览】src/tools/LSPTool/prompt.ts —— LSP 工具的「说明书」常量
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件只做一件事：定义两个字符串常量，告诉「模型」有 LSP 这个工具、
 *  它能干什么、参数怎么填。它没有任何逻辑，是纯粹的文案。
 *
 *  【在架构中的位置】
 *      src/tools/LSPTool/LSPTool.ts
 *        ├─ import { LSP_TOOL_NAME }     ← ★ 本文件
 *        └─ import { DESCRIPTION }       ← ★ 本文件
 *              └─ 被 buildTool({ name, description(), prompt() }) 消费
 *                    └─ src/tools.ts 把 LSPTool 注册进全局工具表
 *                          └─ src/query.ts 主循环把 description 拼进 system prompt 发给模型
 *
 *  一句话说清 LSPTool 的分层（这点很重要，别搞反）：
 *
 *      ┌─────────────────────────────┐
 *      │ src/tools/LSPTool/          │  ← 薄封装层：只负责「把一个能力包装成 Tool」
 *      │   prompt.ts / schemas.ts    │     告诉模型怎么调、校验参数、渲染 UI
 *      │   LSPTool.ts / UI.tsx       │
 *      └────────────┬────────────────┘
 *                   │ 调用
 *      ┌────────────▼────────────────┐
 *      │ src/services/lsp/           │  ← 真正的 LSP 客户端（重头戏在这里）
 *      │   manager.ts                │     getLspServerManager() 拿管理器
 *      │   LSPServerManager.ts       │     启停进程、路由请求、断线重连
 *      │   LSPClient.ts              │     JSON-RPC 编解码
 *      │   config.ts                 │     哪种后缀用哪个 language server
 *      └─────────────────────────────┘
 *
 *  所以：想看「LSP 协议怎么走、进程怎么拉起来」，去 src/services/lsp/；
 *        想看「模型看到的工具长什么样」，看本目录。
 *
 *  【本文件包含什么】（就 2 个常量 + 1 段多行文案）
 *   1. LSP_TOOL_NAME  工具名常量，值为 'LSP'
 *   2. DESCRIPTION    给模型看的工具描述（也是这个工具唯一的「文档」）
 *
 *  【TS 语法速查（Java 工程师视角）】
 *   - `as const`          常量断言。把字面量类型收窄成**精确值类型**：
 *                         `export const N = 'LSP' as const` 之后 N 的类型是 `'LSP'`
 *                         （不加 as const 的话类型是 widened 的 string）。
 *                         ≈ Java 里 `static final String N = "LSP"` 之后编译器
 *                         还能在 switch/switch-pattern 里把它当常量用。
 *                         好处：别处拼错字、传错值会在编译期报错。
 *
 *   - `` `...` `` 反引号      模板字符串（Java 15+ 的 text block 也是三引号，
 *                         但 JS 这个是单反引号且天然支持 ${} 插值）。
 *                         本文件的 DESCRIPTION 就是一个**跨多行的模板字符串**，
 *                         里面的换行会被原样保留，最终发给模型的 prompt 里就是
 *                         带换行的多行文本。
 *
 *   - `export const X`    ≈ Java 的 `public static final`。ES Module 的导出，
 *                         一个文件就是一个模块，没有 class 包裹。
 *
 *   - 术语保留英文：LSP = Language Server Protocol（语言服务器协议）；
 *     diagnostic = 编译器/静态分析给出的报错与警告；symbol = 符号（函数/类/变量）。
 */

export const LSP_TOOL_NAME = 'LSP' as const

// 【中文补充】下面这段 DESCRIPTION 是发给大模型的「工具说明书」，不是给人看的注释。
// 它写得像 Markdown 列表，是因为模型对结构化列表的理解最稳定。
// 注意：line / character 这里明确写了 1-based（和编辑器状态栏显示的一致），
//       但 LSP 协议内部其实是 0-based —— 换算在 LSPTool.ts 的 getMethodAndParams() 里做。
//       这里故意按「用户看到的样子」写，避免模型自己去做 +/-1 的偏移算错。

export const DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`
