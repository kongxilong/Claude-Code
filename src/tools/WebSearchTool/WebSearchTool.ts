/**
 * ============================================================================
 *  【文件总览】src/tools/WebSearchTool/WebSearchTool.ts —— 联网搜索工具
 * ============================================================================
 *
 *  【一句话定位】
 *  Claude Code 的联网搜索能力。注意它的实现方式很特别：
 *  **搜索不是我们发的 HTTP 请求，而是让模型 API 在服务端顺带完成的**
 *  （Anthropic 的 server-side web_search 工具）。本文件负责"发起一次带搜索工具
 *  的模型调用"，再把模型回传的一堆内容块**结构化**成简洁的结果数组。
 *
 *  【在架构中的位置】
 *      模型请求调用 WebSearch
 *        └─> WebSearchTool.call()                    ← ★ 本文件
 *              ├─> makeToolSchema()                  ← ★ 本文件（声明服务端搜索工具）
 *              ├─> queryModelWithStreaming()         ← src/services/api/claude.ts
 *              │     └─> Anthropic API（**服务端**自己去找 Google 搜网页）
 *              ├─> （流式回调里）onProgress(...)      实时显示"正在搜 xxx"
 *              └─> makeOutputFromSearchResponse()    ← ★ 本文件（结构化结果）
 *                    │
 *      结果回灌模型
 *        └─> mapToolResultToToolResultBlockParam()   ← ★ 本文件（拼成纯文本）
 *
 *  【本文件包含什么】
 *   1. inputSchema / outputSchema / searchResultSchema   入参出参的 zod 声明
 *   2. makeToolSchema()              把入参翻译成服务端 web_search 工具的配置
 *   3. makeOutputFromSearchResponse() ★核心：把模型返回的区块流整理成 results[]
 *   4. WebSearchTool                 buildTool({...}) 产出的工具对象（文件主体）
 *
 *  【★ 必须理解的核心难点：结果是怎么"结构化"后交给模型的】
 *
 *  模型 API 开启服务端搜索后，返回的不是"一段答案"，而是一串**交错的内容块**：
 *
 *      [text] 模型说的话
 *      [server_tool_use]      ← "我要开始搜了"
 *      [web_search_tool_result] ← 这一轮搜到的 N 条链接（title + url）
 *      [text] 模型接着说的话
 *      [server_tool_use]      ← "我再搜一次"
 *      [web_search_tool_result]
 *      [text] 最终回答
 *      … （可能重复若干轮，max_uses: 8 限制最多 8 次搜索）
 *
 *  makeOutputFromSearchResponse 做的事就是把这串流**归并**成：
 *      results: [ "模型的一段话", { tool_use_id, content: [{title,url},...] }, … ]
 *  也就是「文字段」和「链接组」交替出现的数组，中间那段话被合并成一整条字符串。
 *  最后 mapToolResultToToolResultBlockParam 再把它压成纯文本：
 *      `Links: [{"title":…,"url":…}, …]`（用 JSON，模型好解析）
 *  并在末尾追加 "REMINDER: 你必须把这些来源用 markdown 链接写进回答"。
 *
 *  为什么结果只保留 title + url、**不保留正文**？
 *   因为正文（snippet）体积大且质量参差；把链接交给主模型，
 *   它可以根据需要用 WebFetch 深入抓取某一个。这是"先给目录、按需取全文"的思路。
 *
 *  【另一个难点：搜索进度是怎么实时显示的】
 *  模型是**流式**返回 input_json_delta 的，也就是搜索词是一个字符一个字符
 *  吐出来的。所以本文件在流式回调里用**正则去啃半个 JSON**，
 *  一旦从残缺的 JSON 里抠出完整的 `"query": "..."` 就立刻 onProgress 报进度。
 *  这就是那段看着有点脏的正则的来源——不是写得不优雅，是流式场景逼出来的。
 *
 *  【TS 语法速查】（本文件实际出现的）
 *   - `async function*` + `for await (const x of stream)`
 *                                 **异步生成器** + 异步迭代。
 *                                 ≈ Reactor 的 Flux：边跑边吐，调用方边收边处理。
 *                                 参考 src/query.ts 文件头的详细讲解
 *   - `Promise<T>` / await        ≈ Java 的 CompletableFuture<T>
 *   - `A | B` 联合类型            ≈ sealed interface 的两个实现
 *   - `z.union([a, b])`           zod 的联合类型校验
 *   - `!(block.content instanceof Array)` / `!Array.isArray(...)`
 *                                 判断是不是数组。注意 JS 里推荐 Array.isArray
 *                                 （跨执行上下文时 instanceof 会失效）
 *   - `??` 空值合并 / `?.` 可选链 见其它文件的说明
 *   - `as const`                  字面量类型断言：`{ type: 'disabled' as const }`
 *                                 让 TS 把它当字面量 'disabled' 而不是 string
 *   - `!!x`                       双重取反 = 强制转成 boolean
 *                                 ≈ Java 的 Boolean.valueOf(x != null)
 *   - `Map<K,V>` + `new Map()`    ≈ Java 的 HashMap
 *   - `event.event?.type`         可选链，event 可能没这个字段
 *   - `switch (x) { case …: }`    和 Java 一样，注意 break
 *   - `performance.now()`         ≈ Java 的 System.nanoTime()，高精度计时
 *   - `results ?? []`             防御：results 可能是 null（JSON 往返后）
 *   - `typeof result === 'string'` 运行时类型判断 ≈ Java 的 instanceof String
 * ============================================================================
 */
import type {
  BetaContentBlock,
  BetaWebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getAPIProvider } from 'src/utils/model/providers.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { queryModelWithStreaming } from '../../services/api/claude.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getMainLoopModel, getSmallFastModel } from '../../utils/model/model.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getWebSearchPrompt, WEB_SEARCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().min(2).describe('The search query to use'),
    allowed_domains: z
      .array(z.string())
      .optional()
      .describe('Only include search results from these domains'),
    blocked_domains: z
      .array(z.string())
      .optional()
      .describe('Never include search results from these domains'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Input = z.infer<InputSchema>

// 中文补充：单条搜索结果的结构。注意**只有 title 和 url，没有正文摘要**——
// 这是有意的设计：先给"目录"，需要详情时主模型再用 WebFetch 去抓具体页面。
// SearchResult = { tool_use_id, content: [{title, url}, ...] }
//   tool_use_id 用来把「这组链接」和「那次搜索动作」对应起来
const searchResultSchema = lazySchema(() => {
  const searchHitSchema = z.object({
    title: z.string().describe('The title of the search result'),
    url: z.string().describe('The URL of the search result'),
  })

  return z.object({
    tool_use_id: z.string().describe('ID of the tool use'),
    content: z.array(searchHitSchema).describe('Array of search hits'),
  })
})

export type SearchResult = z.infer<ReturnType<typeof searchResultSchema>>

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe('The search query that was executed'),
    results: z
      .array(z.union([searchResultSchema(), z.string()]))
      .describe('Search results and/or text commentary from the model'),
    durationSeconds: z
      .number()
      .describe('Time taken to complete the search operation'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Re-export WebSearchProgress from centralized types to break import cycles
export type { WebSearchProgress } from '../../types/tools.js'

import type { WebSearchProgress } from '../../types/tools.js'

/**
 * 把入参翻译成「服务端 web_search 工具」的配置。
 *
 * 【做什么】返回一个 BetaWebSearchTool20250305 对象（Anthropic API 认识的形态）。
 * 【为什么需要】本工具的搜索**不在本地执行**：我们把这个"工具声明"随请求发给
 *              API，由**服务端**代替我们完成真正的联网检索。
 *              所以这里本质上是在配置"服务端该怎么搜"。
 * 【配置要点】
 *   - allowed_domains / blocked_domains：域名过滤（二选一，不能同时给）
 *   - max_uses: 8 —— 硬编码的上限，**一次调用最多搜 8 次**。
 *     为什么要有这个数？模型可能会来回搜十几轮，既慢又费钱；
 *     8 次足够回答绝大多数问题，同时把最坏成本封住。
 *     （这是"给模型的自主权设预算"的典型做法）
 * 【入参】input 已校验过的入参（query / allowed_domains / blocked_domains）
 * 【返回】服务端搜索工具的声明对象
 */
function makeToolSchema(input: Input): BetaWebSearchTool20250305 {
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: input.allowed_domains,
    blocked_domains: input.blocked_domains,
    max_uses: 8, // Hardcoded to 8 searches maximum
  }
}

/**
 * ★ 本文件最核心的函数：把模型返回的「交错内容块流」整理成结构化的 results[]。
 *
 * 【做什么】
 *   输入是一串 BetaContentBlock（text / server_tool_use / web_search_tool_result
 *   三种交错出现，可能重复多轮）；
 *   输出是 `results: (SearchResult | string)[]`——「文字段」和「链接组」交替的数组。
 *
 * 【为什么需要】模型 API 开启服务端搜索后，返回的是**过程**而不是**结果**：
 *   它把"我说了什么话、什么时候开始搜、搜到了哪些链接"全都混在一起吐回来。
 *   如果直接把这堆原始块塞回上下文，既冗长又难读。
 *   所以要做一次**归并（reduce）**：
 *      连续的话 → 合并成一条字符串
 *      搜到的链接 → 变成一条结构化的 { tool_use_id, content: [{title,url}] }
 *   这样主模型看到的是一份干净的「叙述 + 链接清单」。
 *
 * 【算法：一个两状态机】
 *   inText = true  表示当前处于"模型在说话"的段落，正在往 textAcc 里攒文字
 *   遇到 server_tool_use（开始搜）→ 把攒的话打包 push 进 results，切到非文本态
 *   遇到 web_search_tool_result → push 一组链接
 *   之后又遇到 text → 重新进入文本态，开始攒新一轮的话
 *   为什么需要这个状态？因为一段话可能被多个 text 块切开（流式分片），
 *   必须攒起来才能构成完整语义；而"搜索动作"是天然的分段点。
 *
 * 【入参】result 模型返回的完整内容块数组 / query 原始搜索词 / durationSeconds 耗时
 * 【返回】Output = { query, results, durationSeconds }
 * 【关键步骤】
 *   ① 遍历所有块，用 inText 状态机归并文本
 *   ② web_search_tool_result 可能是**错误对象**而不是数组 → 记日志并 push 错误文字
 *      （用 !Array.isArray 判断，而不是 instanceof —— 后者跨上下文会失效）
 *   ③ 成功时只抽取 title + url 两个字段（丢弃正文，理由见文件头）
 *   ④ 循环结束后把最后一段没来得及打包的话也 push 进去
 */
function makeOutputFromSearchResponse(
  result: BetaContentBlock[],
  query: string,
  durationSeconds: number,
): Output {
  // The result is a sequence of these blocks:
  // - text to start -- always?
  // [
  //    - server_tool_use
  //    - web_search_tool_result
  //    - text and citation blocks intermingled
  //  ]+  (this block repeated for each search)

  const results: (SearchResult | string)[] = []
  let textAcc = ''
  let inText = true

  for (const block of result) {
    if (block.type === 'server_tool_use') {
      // 中文补充：textAcc.trim().length > 0 这个判断很关键——
      // 流式输出里经常有空字符串或纯空白的 text 块（比如两个工具调用之间的
      // 分隔块），不 trim 判空的话会在 results 里塞进一堆空的字符串条目。
      if (inText) {
        inText = false
        if (textAcc.trim().length > 0) {
          results.push(textAcc.trim())
        }
        textAcc = ''
      }
      continue
    }

    if (block.type === 'web_search_tool_result') {
      // 中文补充：这个块**有两种形态**——成功时 content 是数组（一堆链接），
      // 失败时 content 是一个带 error_code 的对象（比如搜索服务超时）。
      // 所以必须先判断是不是数组；失败时要记日志并把它变成一条可读的错误文字
      // 放进 results，让主模型知道"这次搜索没成功"，而不是静默丢掉。
      // Handle error case - content is a WebSearchToolResultError
      if (!Array.isArray(block.content)) {
        const errorMessage = `Web search error: ${block.content.error_code}`
        logError(new Error(errorMessage))
        results.push(errorMessage)
        continue
      }
      // 中文补充：这里用 map 做了一次**投影（只留 title 和 url）**。
      // 服务端其实还返回了 page_age、snippet 等字段，这里故意丢弃——
      // 保持结果精简，正文按需用 WebFetch 再抓（详见文件头说明）。
      // Success case - add results to our collection
      const hits = block.content.map(r => ({ title: r.title, url: r.url }))
      results.push({
        tool_use_id: block.tool_use_id,
        content: hits,
      })
    }

    if (block.type === 'text') {
      if (inText) {
        textAcc += block.text
      } else {
        inText = true
        textAcc = block.text
      }
    }
  }

  if (textAcc.length) {
    results.push(textAcc.trim())
  }

  return {
    query,
    results,
    durationSeconds,
  }
}

export const WebSearchTool = buildTool({
  name: WEB_SEARCH_TOOL_NAME,
  searchHint: 'search the web for current information',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    return `Claude wants to search the web for: ${input.query}`
  },
  userFacingName() {
    return 'Web Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching the web'
  },
  /**
   * 这个工具在当前环境下是否可用。
   *
   * 【做什么】按 API 供应商（provider）判断要不要把 WebSearch 放进工具列表。
   * 【为什么需要】服务端搜索是**各家平台能力不一致**的功能：
   *   · firstParty（直连 Anthropic API）→ 支持
   *   · vertex（Google Cloud Vertex AI）→ 只有 Claude 4.0+ 系列支持，
   *     所以要检查模型名里有没有 claude-opus-4 / sonnet-4 / haiku-4
   *   · foundry → 它上架的模型本身就都支持，直接返回 true
   *   · 其它（比如某些第三方代理）→ 不支持，工具直接不出现
   * 【为什么用"不出现"而不是"调用了报错"】
   *   模型看到工具列表里有 WebSearch 就会想去用；给一个用不了的工具只会
   *   浪费一轮对话。所以宁可**从源头隐藏**。
   * 【返回】boolean
   */
  isEnabled() {
    const provider = getAPIProvider()
    const model = getMainLoopModel()

    // Enable for firstParty
    if (provider === 'firstParty') {
      return true
    }

    // Enable for Vertex AI with supported models (Claude 4.0+)
    if (provider === 'vertex') {
      const supportsWebSearch =
        model.includes('claude-opus-4') ||
        model.includes('claude-sonnet-4') ||
        model.includes('claude-haiku-4')

      return supportsWebSearch
    }

    // Foundry only ships models that already support Web Search
    if (provider === 'foundry') {
      return true
    }

    return false
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.query
  },
  /**
   * 权限判定。注意这里返回的是 **passthrough**（放行），不要误读成"不检查"。
   *
   * 【做什么】固定返回 { behavior: 'passthrough', ... } 加一条"加入允许规则"的建议。
   * 【为什么是 passthrough 而不是 ask】
   *   搜索是**只读、且由服务端执行**的动作：不碰本地文件、不执行代码、
   *   也不向目标站点暴露本机信息（请求是 Anthropic 服务端发出的）。
   *   风险远低于 Bash / Edit / WebFetch，所以没必要每次都弹窗打断用户。
   *   但依然带上 suggestions，让用户（或企业管理员）可以主动加规则、
   *   比如在权限收紧模式下把它禁掉。
   * 【passthrough 的含义】交给更上层/更通用的权限流程去决定，本工具不额外拦一道。
   * 【入参】_input 未使用（搜索词本身不构成权限决策依据）
   * 【返回】PermissionResult
   */
  async checkPermissions(_input): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'WebSearchTool requires permission.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: WEB_SEARCH_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    }
  },
  async prompt() {
    return getWebSearchPrompt()
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  /**
   * 提供给"结果全文搜索"功能的文本（本工具故意返回空字符串）。
   *
   * 【做什么】返回 ''。
   * 【为什么返回空——看上面英文注释就明白了】
   *   终端上 renderToolResultMessage 只画 "Did N searches in Xs" 这一行，
   *   results[] 里的实际内容**从来没显示在屏幕上**。
   *   如果这里把 results 里的文字交出去，用户在界面里搜某个关键词会"命中"
   *   一条根本看不见的记录——也就是英文注释说的 **phantom match（幽灵匹配）**，
   *   体验很差。所以干脆返回空：没显示过的东西就不要参与搜索。
   * 【返回】''（空字符串）
   */
  extractSearchText() {
    // renderToolResultMessage shows only "Did N searches in Xs" chrome —
    // the results[] content never appears on screen. Heuristic would index
    // string entries in results[] (phantom match). Nothing to search.
    return ''
  },
  /**
   * 入参校验：搜索词非空 + 域名过滤二选一。
   *
   * 【做什么】两条规定，违反就返回带错误信息的 { result: false }。
   * 【为什么需要】
   *   ① query 不能为空——zod 的 min(2) 已经拦了长度，这里再兜一层是因为
   *      入参可能来自非 zod 校验的路径（如 SDK 直接调用）。
   *   ② allowed_domains 和 blocked_domains **不能同时给**。
   *      这在语义上是矛盾的（"只允许 A" 与 "禁止 B" 同时成立时，
   *      A∩B 的站点到底算允许还是禁止？），与其让服务端去猜，不如明确报错。
   * 【为什么要返回错误对象而不是抛异常】
   *   和 WebFetchTool.validateInput 同理：校验失败是**模型的错**，
   *   要把错误消息回给模型让它自己改参数重试，而不是崩掉这一轮。
   * 【返回】{ result: true } 或 { result: false, message, errorCode }
   *        errorCode 1 = 缺 query，2 = 域名过滤冲突
   */
  async validateInput(input) {
    const { query, allowed_domains, blocked_domains } = input
    if (!query.length) {
      return {
        result: false,
        message: 'Error: Missing query',
        errorCode: 1,
      }
    }
    if (allowed_domains?.length && blocked_domains?.length) {
      return {
        result: false,
        message:
          'Error: Cannot specify both allowed_domains and blocked_domains in the same request',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  /**
   * ★ 工具执行主体：发起一次「带服务端搜索工具」的模型调用，并把结果结构化。
   *
   * 【做什么】
   *   ① 造一条用户消息 "Perform a web search for the query: xxx"
   *   ② 把 web_search 工具声明塞进请求（makeToolSchema）
   *   ③ 流式消费返回的事件流：收集内容块 + 实时上报搜索进度
   *   ④ 结束时用 makeOutputFromSearchResponse 把内容块整理成 results[]
   *
   * 【为什么搜索要"绕一圈调模型"而不是自己发 HTTP 给搜索引擎】
   *   因为用的是 Anthropic 的 **server-side web_search**：检索发生在 API 服务端，
   *   我们只拿到结果。好处是不用自己接搜索引擎、不用管反爬、不用暴露本机 IP；
   *   代价是我们必须**通过一次模型调用**来触发它，也就必须处理模型返回的那堆
   *   交错内容块（这正是 makeOutputFromSearchResponse 存在的理由）。
   *
   * 【★ 最值得看的部分：流式进度是怎么抠出来的】
   *   模型要搜什么词，是通过 input_json_delta 事件**一个字符一个字符**吐的：
   *       {"q → {"que → {"quer → … → {"query":"react docs 2026"}
   *   所以这里维护一个 currentToolUseJson 字符串不断累加，
   *   每次都用**正则从残缺的 JSON 里抠** `"query": "..."`。
   *   抠到就立刻 onProgress，UI 上就能实时显示"正在搜 xxx"。
   *   为什么不用 JSON.parse？因为这时候 JSON 还没拼完，parse 必然抛错——
   *   所以才用正则 + try/catch 这种"看起来脏"的写法，是流式场景逼出来的。
   *
   * 【useHaiku 这个开关】
   *   通过特性开关（feature flag）决定：用便宜的小模型 + 强制 tool_choice
   *   （逼它只能调 web_search），还是用主模型。这是常见的成本控制/灰度手段。
   *
   * 【入参】input（query 等）；context（abortController、options）；
   *        _canUseTool / _parentMessage 未使用；onProgress 进度回调
   * 【返回】{ data: Output }
   * 【关键步骤】
   *   ① 计时 → ② 组装请求 → ③ for await 消费流（进度上报）→ ④ 结构化 → ⑤ 返回
   */
  async call(input, context, _canUseTool, _parentMessage, onProgress) {
    const startTime = performance.now()
    const { query } = input
    const userMessage = createUserMessage({
      content: 'Perform a web search for the query: ' + query,
    })
    const toolSchema = makeToolSchema(input)

    const useHaiku = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_plum_vx3',
      false,
    )

    const appState = context.getAppState()
    const queryStream = queryModelWithStreaming({
      messages: [userMessage],
      systemPrompt: asSystemPrompt([
        'You are an assistant for performing a web search tool use',
      ]),
      thinkingConfig: useHaiku
        ? { type: 'disabled' as const }
        : context.options.thinkingConfig,
      tools: [],
      signal: context.abortController.signal,
      options: {
        getToolPermissionContext: async () => appState.toolPermissionContext,
        model: useHaiku ? getSmallFastModel() : context.options.mainLoopModel,
        toolChoice: useHaiku ? { type: 'tool', name: 'web_search' } : undefined,
        isNonInteractiveSession: context.options.isNonInteractiveSession,
        hasAppendSystemPrompt: !!context.options.appendSystemPrompt,
        extraToolSchemas: [toolSchema],
        querySource: 'web_search_tool',
        agents: context.options.agentDefinitions.activeAgents,
        mcpTools: [],
        agentId: context.agentId,
        effortValue: appState.effortValue,
      },
    })

    const allContentBlocks: BetaContentBlock[] = []
    let currentToolUseId = null
    let currentToolUseJson = ''
    let progressCounter = 0
    const toolUseQueries = new Map() // Map of tool_use_id to query

    for await (const event of queryStream) {
      if (event.type === 'assistant') {
        allContentBlocks.push(...event.message.content)
        continue
      }

      // Track tool use ID when server_tool_use starts
      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_start'
      ) {
        const contentBlock = event.event.content_block
        if (contentBlock && contentBlock.type === 'server_tool_use') {
          currentToolUseId = contentBlock.id
          currentToolUseJson = ''
          // Note: The ServerToolUseBlock doesn't contain input.query
          // The actual query comes through input_json_delta events
          continue
        }
      }

      // Accumulate JSON for current tool use
      if (
        currentToolUseId &&
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_delta'
      ) {
        const delta = event.event.delta
        if (delta?.type === 'input_json_delta' && delta.partial_json) {
          currentToolUseJson += delta.partial_json

          // Try to extract query from partial JSON for progress updates
          try {
            // Look for a complete query field
            const queryMatch = currentToolUseJson.match(
              /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/,
            )
            if (queryMatch && queryMatch[1]) {
              // The regex properly handles escaped characters
              const query = jsonParse('"' + queryMatch[1] + '"')

              if (
                !toolUseQueries.has(currentToolUseId) ||
                toolUseQueries.get(currentToolUseId) !== query
              ) {
                toolUseQueries.set(currentToolUseId, query)
                progressCounter++
                if (onProgress) {
                  onProgress({
                    toolUseID: `search-progress-${progressCounter}`,
                    data: {
                      type: 'query_update',
                      query,
                    },
                  })
                }
              }
            }
          } catch {
            // Ignore parsing errors for partial JSON
          }
        }
      }

      // Yield progress when search results come in
      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_start'
      ) {
        // 中文补充：搜到结果时的进度上报。
        // 注意 actualQuery 的取值：优先用**这次搜索动作真正用的词**
        // （从 toolUseQueries 里按 tool_use_id 查），查不到才退回原始 query。
        // 为什么？因为模型可能会改写搜索词（"react docs" → "react documentation 2026"），
        // 显示改写后的词才能让用户知道到底搜了什么。
        // `toolUseQueries.get(toolUseId) || query` 用的是 `||` 而不是 `??`：
        // 这样空字符串也会退回原词（这里空字符串确实等于"没查到"）。
        const contentBlock = event.event.content_block
        if (contentBlock && contentBlock.type === 'web_search_tool_result') {
          // Get the actual query that was used for this search
          const toolUseId = contentBlock.tool_use_id
          const actualQuery = toolUseQueries.get(toolUseId) || query
          const content = contentBlock.content

          progressCounter++
          if (onProgress) {
            onProgress({
              toolUseID: toolUseId || `search-progress-${progressCounter}`,
              data: {
                type: 'search_results_received',
                resultCount: Array.isArray(content) ? content.length : 0,
                query: actualQuery,
              },
            })
          }
        }
      }
    }

    // Process the final result
    const endTime = performance.now()
    const durationSeconds = (endTime - startTime) / 1000

    const data = makeOutputFromSearchResponse(
      allContentBlocks,
      query,
      durationSeconds,
    )
    return { data }
  },
  /**
   * 把结构化结果压成纯文本，回灌给主模型。
   *
   * 【做什么】把 results[] 渲染成一段文本：
   *      字符串条目   → 原样追加（模型说的话）
   *      链接组条目   → `Links: [{"title":…,"url":…}, …]`（JSON 形式）
   *   最后追加一句 REMINDER，要求模型必须用 markdown 链接列出来源。
   *
   * 【为什么链接要用 JSON 而不是自己拼排版】
   *   JSON 是模型最不容易解析错的结构化格式；而且 jsonStringify 是仓库里
   *   统一的慢操作封装（src/utils/slowOperations.js），能保证一致性与截断策略。
   *
   * 【为什么末尾还要再补一句 REMINDER】
   *   prompt.ts 里已经强调过一次"必须列 Sources"。这里是**第二次**提醒，
   *   而且是在最接近输出的时刻——实测单次提醒模型仍会漏，双保险。
   *   这是提示词工程里常见的"关键时刻重复约束"手法。
   *
   * 【为什么要有 `results ?? []` 和 `result == null` 的判空】
   *   英文注释说了：结果可能经过 JSON 往返（压缩上下文、反序列化 transcript），
   *   过程中数组里可能混进 null/undefined。不判空就会崩。
   *   `??` 只把 null/undefined 换成 []，不会误伤空数组。
   *
   * 【入参】output 解构出 query / results；toolUseID 必须原样回传
   * 【返回】tool_result 块
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const { query, results } = output

    let formattedOutput = `Web search results for query: "${query}"\n\n`

    // Process the results array - it can contain both string summaries and search result objects.
    // Guard against null/undefined entries that can appear after JSON round-tripping
    // (e.g., from compaction or transcript deserialization).
    ;(results ?? []).forEach(result => {
      if (result == null) {
        return
      }
      if (typeof result === 'string') {
        // Text summary
        formattedOutput += result + '\n\n'
      } else {
        // Search result with links
        if (result.content?.length > 0) {
          formattedOutput += `Links: ${jsonStringify(result.content)}\n\n`
        } else {
          formattedOutput += 'No links found.\n\n'
        }
      }
    })

    formattedOutput +=
      '\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formattedOutput.trim(),
    }
  },
} satisfies ToolDef<InputSchema, Output, WebSearchProgress>)
