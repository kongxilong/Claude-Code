/**
 * ============================================================================
 *  【文件总览】src/tools/MCPTool/MCPTool.ts —— MCP 工具的「模板」
 * ============================================================================
 *
 *  ★★ 一句话定位（整个 MCPTool 目录最关键的一点）★★
 *
 *  本文件里的 MCPTool **不是一个能直接用的工具**，它是一个**模板 / 基类**：
 *  里面几乎每个字段都是空壳（name 就叫 'mcp'、description 返回空串、call 返回空字符串）。
 *
 *  真正的 MCP 工具是在 **src/services/mcp/client.ts** 里，用
 *
 *      return { ...MCPTool, name: 'mcp__slack__post_message', call: async (...) => {...}, ... }
 *
 *  这样的**展开 + 覆盖**手法，为每一个 MCP server 的每一个 tool 各生成一个实例。
 *  代码里的 `// Overridden in mcpClient.ts` 注释就是在提醒你这件事。
 *
 * ---------------------------------------------------------------------------
 *  ★ MCPTool 与 src/services/mcp/ 的关系（务必看清，否则会找错地方）★
 * ---------------------------------------------------------------------------
 *
 *      src/tools/MCPTool/          ← 薄封装层（对外「长得像一个 Tool」）
 *        ├─ MCPTool.ts     ★ 本文件：模板 + 通用行为（渲染、截断、map 成 tool_result）
 *        ├─ UI.tsx                 ：终端里怎么画（进度条、大响应警告、Slack 特例）
 *        ├─ classifyForCollapse.ts ：判断某个 MCP 工具能不能被「折叠」显示
 *        └─ prompt.ts              ：空字符串占位（真正的描述在 client.ts 里填）
 *
 *      真正在 src/services/mcp/：
 *        ├─ client.ts          ← 核心：连接 MCP server、列出它的 tools、
 *        │                        把每个 tool 「套用」本文件的模板生成具体工具实例、
 *        │                        执行 tools/call、处理 401 → OAuth、超时、重连
 *        ├─ MCPConnectionManager.tsx / useManageMCPConnections.ts
 *        │                     ← 连接的增删改查与状态管理
 *        ├─ auth.ts            ← OAuth 2.0 流程（本目录的 McpAuthTool 会用到）
 *        ├─ types.ts / config.ts / normalization.ts ← 配置模型与归一化
 *        └─ mcpStringUtils.ts  ← 工具名拼接规则（mcp__<server>__<tool>）
 *
 *  类比 Java：
 *      本文件       ≈ 抽象基类 / 默认实现（提供通用行为与默认值）
 *      client.ts    ≈ 工厂 + 代理：为每个远程服务动态生成子类实例并注入真实实现
 *
 * ---------------------------------------------------------------------------
 *  【调用链】
 *  ---------------------------------------------------------------------------
 *      src/services/mcp/client.ts
 *        └─ { ...MCPTool, name, description, call, ... }     ← 用到 ★ 本文件
 *              └─ 生成的实例进入 appState.mcp.tools
 *                    └─ src/tools.ts 把它们和用户配置的工具合并成最终工具表
 *                          └─ src/query.ts 主循环：模型看到 → 返回 tool_use → 执行
 *                                └─ call()（在 client.ts 里被覆盖）→ 真正的 tools/call
 *                                      └─ 结果回来后：
 *                                            renderToolResultMessage() ← src/tools/MCPTool/UI.tsx
 *                                            isResultTruncated()       ← ★ 本文件
 *                                            mapToolResultToToolResultBlockParam() ← ★ 本文件
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 *  ---------------------------------------------------------------------------
 *   inputSchema    `z.object({}).passthrough()` —— 允许**任意**字段
 *   outputSchema   `z.string()` —— MCP 工具的输出一律是字符串
 *   MCPTool        模板对象本身（本文件唯一的主角）
 *   MCPProgress    类型再导出（从 src/types/tools.js 转出来，为了打破循环依赖）
 *
 * ---------------------------------------------------------------------------
 *  【三个「为什么这么写」】
 *  ---------------------------------------------------------------------------
 *   ① **为什么 inputSchema 是 `z.object({}).passthrough()`？**
 *      因为 MCP 是**开放生态**：每个 server 自带 JSON Schema，有几千种可能的工具，
 *      字段名五花八门。模板不可能预先知道。
 *      所以这里用 passthrough 表示「任何字段都放行」——
 *      真正的校验交给**各 server 自己提供的 schema**（在 client.ts 里作为
 *      inputJSONSchema 覆盖进来）。
 *      ≈ Java 里把 Map<String, Object> 原样透传，由下游各自反序列化。
 *
 *   ② **为什么 outputSchema 就是 `z.string()`？**
 *      因为 MCP 工具返回什么都有可能（JSON、纯文本、图片 base64），
 *      统一先转成字符串，交给 UI.tsx 去猜格式再渲染。
 *      这是「宽进宽出」的设计，牺牲类型精度换取对接任意 server 的能力。
 *
 *   ③ **为什么 `checkPermissions` 返回 'passthrough'？**
 *      'passthrough' 表示「本模板不做决定」—— 具体每个 MCP 工具的权限策略
 *      由 client.ts 生成的实例各自覆盖。模板只提供一个安全的默认值
 *      （不擅自放行）。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查（Java 工程师视角）】
 *  ---------------------------------------------------------------------------
 *   - `z.object({}).passthrough()`
 *                          zod 的「放行未知字段」模式。
 *                          对比：z.strictObject 多字段报错、z.object 静默丢弃未知字段、
 *                          passthrough 保留未知字段。这里必须保留，否则参数会被吃掉。
 *
 *   - `export type { MCPProgress } from '../../types/tools.js'`
 *                          **纯类型再导出**（编译后完全消失）。
 *                          为什么需要它？注释里写了 "to break import cycles"（打破循环依赖）：
 *                          A 引 B、B 又引 A 时，运行时 import 会出问题，
 *                          而**类型** import 编译后被擦除，可以安全地中转一层。
 *                          ≈ Java 里没有这个问题（Java 的 import 不产生运行时依赖）。
 *
 *   - `satisfies ToolDef<InputSchema, Output>`
 *                          「满足这个契约，但保留我写出的精确类型」。
 *                          比 `as` 更安全（as 会抹平类型精度）。详见 LSPTool.ts 的说明。
 *
 *   - `isMcp: true`        标记位：告诉主循环「这是个外部 MCP 工具」，
 *                          要走 MCP 的调用与权限路径。≈ 一个 boolean 字段的 tag。
 *
 *   - `isResultTruncated(output: Output): boolean`
 *                          「结果被截断了吗」—— 用于决定要不要提示用户
 *                          「内容太长，只显示了一部分」。
 *
 *   - `maxResultSizeChars: 100_000`
 *                          数字分隔符，≈ Java 的 `100_000`（Java 7+ 支持）。
 *                          结果超过 10 万字符就截断，防止单个 MCP 响应把上下文撑爆。
 *
 *   - `get inputSchema(): InputSchema { return inputSchema() }`
 *                          getter + 惰性构造。字段名叫 inputSchema、
 *                          外面又有一个同名函数 inputSchema()，靠 `inputSchema()`
 *                          的括号区分「调用函数」与「取字段」—— 读的时候注意看括号。
 *
 *   - `async call() { return { data: '' } }`
 *                          空实现，等 client.ts 覆盖。
 *                          ≈ Java 抽象类的默认实现 / 模板方法模式里的 hook。
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

// Allow any input object since MCP tools define their own schemas
// 【中文补充】`{}` 是我们**已知**的字段（一个都没有），`.passthrough()` 表示
// 「未知的字段也一律保留、别丢」。
// 为什么必须保留？因为这些参数最终要原封不动发给 MCP server 的 tools/call。
// 如果用默认的 z.object({})，zod 会把所有未知字段**静默丢弃**，
// 结果就是「模型明明传了 channel_id，server 却说缺少参数」—— 一个极难排查的坑。
export const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

// 【中文补充】输出统一按字符串处理。
// 为什么？MCP 的 tool result 可以是 text / image / resource 等多种 block，
// 模板层不可能预知。统一成 string，由 UI.tsx 去嗅探格式（是不是 JSON、
// 有没有图片）再决定怎么画。这是「宽出」换取兼容性。
export const outputSchema = lazySchema(() =>
  z.string().describe('MCP tool execution result'),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Re-export MCPProgress from centralized types to break import cycles
// 【中文补充】这是个「纯类型」的再导出，编译后一行运行时代码都不会留下。
// 为什么要绕这一圈？因为存在循环依赖：
//     本文件 ← 被 src/services/mcp/client.ts 引用
//     而 UI.tsx（本目录）又要用到 client.ts 那边的类型
// 直接互相 import 会在运行时形成环（可能拿到未初始化的 undefined）。
// 把类型放到中立的 src/types/tools.ts，再从这里转出一次，环就断了。
// Java 里没这个烦恼：Java 的 import 不产生运行时依赖，也不存在模块初始化顺序问题。
export type { MCPProgress } from '../../types/tools.js'

/**
 * 【中文补充】MCPTool —— 模板对象。
 *
 * 记住：它**不会被直接使用**。src/services/mcp/client.ts 会为每个 MCP server
 * 的每个 tool 做一次 `{ ...MCPTool, name: ..., call: ..., description: ... }`，
 * 覆盖掉下面标了 `// Overridden in mcpClient.ts` 的字段。
 *
 * 没被覆盖、因此**真正通用**的只有这几项：
 *   - inputSchema / outputSchema（所有 MCP 工具都「任意输入、字符串输出」）
 *   - maxResultSizeChars（10 万字符上限，防止单个响应撑爆上下文）
 *   - isResultTruncated()（判断是否被截断，用的是和 Bash 工具一致的规则）
 *   - mapToolResultToToolResultBlockParam()（包装成 API 要求的 tool_result 结构）
 *   - renderToolUseMessage / renderToolUseProgressMessage / renderToolResultMessage
 *
 * 被覆盖的是这些（本文件里的值只是占位）：
 *   - name（'mcp'）、description、prompt、call、isOpenWorld、userFacingName
 *
 * ≈ Java：抽象基类提供通用实现，子类/工厂覆盖抽象的钩子方法（模板方法模式）。
 */
export const MCPTool = buildTool({
  isMcp: true,
  // Overridden in mcpClient.ts with the real MCP tool name + args
  isOpenWorld() {
    return false
  },
  // Overridden in mcpClient.ts
  name: 'mcp',
  maxResultSizeChars: 100_000,
  // Overridden in mcpClient.ts
  async description() {
    return DESCRIPTION
  },
  // Overridden in mcpClient.ts
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // Overridden in mcpClient.ts
  // 【中文补充】空实现占位：真正的执行逻辑（发 tools/call、处理 401 触发 OAuth、
  // 超时重试、elicitation 引导…）全在 src/services/mcp/client.ts 里。
  // 想看「MCP 工具到底怎么被调起来的」，请直接去看 client.ts，别在这里找。
  async call() {
    return {
      data: '',
    }
  },
  /**
   * 【中文补充】权限检查的默认实现：返回 'passthrough' = 「本模板不表态」。
   *
   * 为什么不直接 allow 或 deny？因为 MCP 工具的风险差别极大：
   *   有的是只读查询（list_channels），有的是发帖/删库（post_message、delete_record）。
   * 一刀切都不合适，所以模板选择「不决定」，由 client.ts 里每个具体实例
   * 根据 MCP server 提供的 annotations（readOnlyHint / destructiveHint）自行覆盖。
   * 这是「把决策权下放给真正了解上下文的一方」的典型做法。
   */
  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
    }
  },
  renderToolUseMessage,
  // Overridden in mcpClient.ts
  userFacingName: () => 'mcp',
  renderToolUseProgressMessage,
  renderToolResultMessage,
  /**
   * 【中文补充】判断结果是否被截断了。
   *
   * 为什么要关心「有没有被截断」？因为截断意味着**模型看到的内容是不完整的**，
   * 它可能会基于半截 JSON 做出错误判断。UI 需要据此给用户一个提示
   * （比如 "…（内容已截断）"），让用户知道要去别处看完整结果。
   *
   * 这里复用了终端工具的通用实现 isOutputLineTruncated —— 无论是 shell 输出
   * 还是 MCP 输出，「按行截断了没有」的判断逻辑是一样的，不必重写。
   *
   * @param output MCP 工具的输出字符串
   * @returns true 表示内容被截断过
   */
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(output)
  },
  /**
   * 【中文补充】把工具的输出包装成 Anthropic API 要求的 `tool_result` 块。
   *
   * 为什么要这一步？因为工具内部返回的是自己的 Output 类型（这里是 string），
   * 而 API 要求的是这种结构：
   *      { tool_use_id: <对应那条 tool_use 的 id>, type: 'tool_result', content: ... }
   * `tool_use_id` 是关联用的：一次对话里可能有多个工具并发调用，
   * 靠这个 id 把「请求」和「结果」对上号。缺了它 API 会直接报错。
   *
   * @param content   工具输出
   * @param toolUseID 对应的 tool_use 块 id
   * @returns 可直接放进 messages 数组的 tool_result 块
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
