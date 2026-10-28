/**
 * ============================================================================
 *  【文件总览】src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts
 *            —— 「列出所有 MCP server 提供的 resource」
 * ============================================================================
 *
 *  【一句话定位】
 *  把**所有已连接的 MCP server** 各自暴露的 resource 汇总成一个列表返回给模型。
 *  相当于 MCP 世界里的 `ls`：只列目录，不读内容
 *  （读内容由 ../ReadMcpResourceTool/ 负责）。
 *
 *  【在架构中的位置】
 *      src/tools.ts   ← 注册进全局工具表（第 335 行）
 *        └─ src/query.ts 主循环 → 模型看到工具 → 返回 tool_use
 *              └─ 执行本工具的 call()  ← ★ 本文件
 *                    ├─ ensureConnectedClient()      ← src/services/mcp/client.js
 *                    └─ fetchResourcesForClient()    ← src/services/mcp/client.js
 *                          └─ 真正发 `resources/list` 请求给 MCP server
 *                                └─ 结果经 renderToolResultMessage() 画到终端
 *                                      ← src/tools/ListMcpResourcesTool/UI.tsx
 *
 *  与 src/services/mcp/ 的关系（MCP 家族通用，务必看清）：
 *      ┌──────────────────────────────┐
 *      │ 本目录（薄封装层）            │  ① 定义工具长什么样（名字/描述/参数/渲染）
 *      └───────────┬──────────────────┘  ② 调用 services/mcp 提供的能力
 *                  │                     ③ 处理「某个 server 挂了怎么办」这类编排问题
 *      ┌───────────▼──────────────────┐
 *      │ src/services/mcp/（真身）     │  连接管理、鉴权、缓存、协议收发、重连
 *      │   client.ts（本文件只用到它） │
 *      └──────────────────────────────┘
 *
 *  【本文件包含什么】
 *   inputSchema   可选参数 server（不填就查所有 server）
 *   outputSchema  resource 数组：{ uri, name, mimeType?, description?, server }
 *   ListMcpResourcesTool  工具对象，核心是 call() 和 mapToolResultToToolResultBlockParam()
 *
 *  【★ 两个值得学习的设计点 ★】
 *
 *   ① **一个 server 挂掉不能拖垮整体**
 *      call() 里对每个 client 都包了自己的 try/catch，失败只 logMCPError 然后返回 []。
 *      为什么？因为「列出所有 resource」是个**聚合**操作，
 *      用户装了 5 个 server，其中 1 个连接失败，正确行为是「返回另外 4 个的」，
 *      而不是整个工具报错让用户什么都看不到。
 *      这是聚合类接口的标准容错策略（partial success）。
 *
 *   ② **results.flat()**
 *      每个 client 返回一个 resource 数组，5 个 client 就是 5 个数组
 *      （`[[a,b],[c],[],[d,e]]`）。flat() 把它压平成一维 `[a,b,c,d,e]`。
 *      ≈ Java 的 stream().flatMap(Collection::stream).collect(toList())。
 *
 *  【TS 语法速查（Java 工程师视角）】
 *   - `async call(input, { options: { mcpClients } })`
 *                          第二个参数是 context，这里用**嵌套解构**直接取出
 *                          context.options.mcpClients。
 *                          ≈ Java 里 `ctx.getOptions().getMcpClients()`，TS 一步到位。
 *
 *   - `z.string().optional()`  可选字段。
 *                          在 TS 类型里表现为 `server?: string`（即 string | undefined）。
 *                          ≈ Java 里字段可为 null，但 TS 会**强制你处理** undefined。
 *
 *   - `input.server ?? ''`    `??` 空值合并：server 没填（undefined）就用空串。
 *                          ⚠️ 与 `||` 的区别：`??` 只在 null/undefined 时取右边，
 *                          `||` 还会把空字符串 '' 也当成「没有」。
 *                          这里 toAutoClassifierInput 需要一个字符串，
 *                          用 ?? 是准确的（用户填了空串就按空串处理）。
 *
 *   - `mcpClients.filter(c => c.name === targetServer)`
 *                          ≈ stream().filter(...)。箭头函数 ≈ lambda。
 *
 *   - `Promise.all(arr.map(async c => {...}))`
 *                          **并发**等待所有异步操作完成。
 *                          ≈ Java 的 CompletableFuture.allOf(...).join()，
 *                          但原生支持、写法自然得多。
 *                          为什么这里要并发？因为每个 server 的网络请求互相独立，
 *                          串行会让 5 个 server 的耗时叠加（可能好几秒）。
 *
 *   - `client.type !== 'connected'`  判别联合（tagged union）的 tag 检查。
 *                          client 可能是 connected / failed / pending 等状态，
 *                          先用 tag 收窄类型才能安全地访问它的字段。
 *                          ≈ Java 的 sealed interface + instanceof 模式匹配。
 *
 *   - `results.flat()`      数组压平（见上面设计点 ②）。
 *
 *   - `satisfies ToolDef<InputSchema, Output>`
 *                          编译期契约检查但不抹平推断类型（优于 `as`）。
 *
 *   - `throw new Error(...)`  在工具里抛异常是**合法**的：主循环会捕获它，
 *                          把错误消息作为工具结果回传给模型，让模型自己纠正
 *                          （比如提示它「可用的 server 有这些」）。
 *                          这是「把错误变成给模型的反馈」的设计。
 *
 *   - `jsonStringify(content)`  注意与 JSON.stringify 的区别：项目里的这个版本
 *                          提供更稳定的键顺序 / 大对象处理（避免每次序列化结果不同）。
 */

import { z } from 'zod/v4'
import {
  ensureConnectedClient,
  fetchResourcesForClient,
} from '../../services/mcp/client.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, LIST_MCP_RESOURCES_TOOL_NAME, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.object({
    server: z
      .string()
      .optional()
      .describe('Optional server name to filter resources by'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.array(
    z.object({
      uri: z.string().describe('Resource URI'),
      name: z.string().describe('Resource name'),
      mimeType: z.string().optional().describe('MIME type of the resource'),
      description: z.string().optional().describe('Resource description'),
      server: z.string().describe('Server that provides this resource'),
    }),
  ),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * 【中文补充】ListMcpResourcesTool —— 工具对象本体。
 *
 * 由 buildTool({...}) 造出来，字段分三类：
 *   ① 元信息：name / description / prompt / inputSchema / outputSchema
 *   ② 行为标记：isConcurrencySafe（可并发）/ isReadOnly（只读）/ shouldDefer（延迟加载描述）
 *   ③ 生命周期：call（真正执行）/ mapToolResultToToolResultBlockParam（包装结果）
 *
 * 下面只对最关键的两个方法做详细说明（call 和 mapToolResultToToolResultBlockParam）。
 */
export const ListMcpResourcesTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  /**
   * 【中文补充】给「权限自动分类器」提供一段可分析的文本。
   *
   * 什么是 auto classifier？Claude Code 会在用户第一次遇到某个工具时，
   * 自动判断它的风险等级（只读？写操作？）来决定要不要弹权限确认。
   * 这个函数提供的就是判断依据（这里只有 server 名，因为列出 resource 是只读的）。
   *
   * `input.server ?? ''`：server 是可选参数，没填时返回空串而不是 undefined
   * —— 因为下游要的是字符串类型。
   */
  toAutoClassifierInput(input) {
    return input.server ?? ''
  },
  shouldDefer: true,
  name: LIST_MCP_RESOURCES_TOOL_NAME,
  searchHint: 'list resources from connected MCP servers',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 【中文补充】★ 主流程：汇总所有（或指定）MCP server 的 resource 列表。
   *
   * 步骤：
   *   ① 解构出可选的 server 过滤条件
   *   ② 按名字过滤 client；指定了却找不到 → 抛错，**并把可用的 server 名列出来**
   *      （这句提示对模型极其有用：它下次就能填对）
   *   ③ 对每个 client **并发**地：先确保连接健康，再拉 resource 列表
   *   ④ 把「数组的数组」压平成一维数组返回
   *
   * 关于第 ③ 步的两个服务层函数（都在 src/services/mcp/client.js）：
   *   - fetchResourcesForClient 按 server 名做了 **LRU 缓存**，且启动时已预热，
   *     所以多数情况下是内存命中，很快。缓存在连接关闭（onclose）和
   *     server 主动推送 `resources/list_changed` 通知时失效 —— 保证不会拿到过期数据。
   *   - ensureConnectedClient 在连接健康时是**空操作**（memoize 命中）；
   *     只有在连接断过之后才会重建连接，让接下来的重新拉取能成功。
   *
   * @param input   { server? } —— 不填就查所有 server
   * @param context 执行上下文，这里只取 options.mcpClients（当前所有 MCP 连接）
   * @returns { data: resource[] }，每条 resource 都带 server 字段标明来源
   */
  async call(input, { options: { mcpClients } }) {
    const { server: targetServer } = input

    const clientsToProcess = targetServer
      ? mcpClients.filter(client => client.name === targetServer)
      : mcpClients

    // 【中文补充】指定了 server 却一个都没匹配上 → 直接抛错。
    // 为什么抛错而不是返回空数组？因为「server 不存在」和「server 存在但没有 resource」
    // 是**完全不同的两件事**，返回空数组会让模型误以为「这个 server 没有资源」，
    // 从而做出错误决策。抛错 + 列出可用 server，模型就能自己改正。
    if (targetServer && clientsToProcess.length === 0) {
      throw new Error(
        `Server "${targetServer}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    // fetchResourcesForClient is LRU-cached (by server name) and already
    // warm from startup prefetch. Cache is invalidated on onclose and on
    // resources/list_changed notifications, so results are never stale.
    // ensureConnectedClient is a no-op when healthy (memoize hit), but after
    // onclose it returns a fresh connection so the re-fetch succeeds.
    const results = await Promise.all(
      clientsToProcess.map(async client => {
        if (client.type !== 'connected') return []
        try {
          const fresh = await ensureConnectedClient(client)
          return await fetchResourcesForClient(fresh)
        } catch (error) {
          // One server's reconnect failure shouldn't sink the whole result.
          logMCPError(client.name, errorMessage(error))
          return []
        }
      }),
    )

    // 【中文补充】flat() 把 [[a,b],[],[c]] 压成 [a,b,c]。
    // 为什么不在上面对每个 client 的结果直接 concat？因为 Promise.all 的返回值
    // 天然是「每个任务的结果组成的数组」，压平是最自然的收敛方式。
    return {
      data: results.flat(),
    }
  },
  renderToolUseMessage,
  userFacingName: () => 'listMcpResources',
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  /**
   * 【中文补充】把结果包装成 API 要求的 tool_result 块，**并处理空结果**。
   *
   * 为什么空结果不返回空字符串、而要专门给一句话？
   *   因为「什么都没有」对模型是**歧义**的：是「没有 resource」？
   *   还是「出错了」？还是「工具没跑」？
   *   返回一句明确的英文说明，模型才能正确理解并继续（比如改用 tools 而不是 resources）。
   *   后半句 "MCP servers may still provide tools even if they have no resources."
   *   尤其重要 —— 它直接告诉模型「别放弃这个 server，去试它的 tools」。
   *   这是「把领域知识写进返回值」的好例子。
   *
   * @param content   resource 数组（可能为空）
   * @param toolUseID 对应的 tool_use 块 id
   * @returns tool_result 块
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (!content || content.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          'No resources found. MCP servers may still provide tools even if they have no resources.',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
