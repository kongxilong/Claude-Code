/**
 * ============================================================================
 *  【文件总览】src/tools/WebFetchTool/WebFetchTool.ts —— WebFetch 的「工具壳」
 * ============================================================================
 *
 *  【一句话定位】
 *  把 utils.ts 里那堆抓取/转换函数，包装成 Claude Code 认识的一个**工具对象**：
 *  声明它叫什么、接受什么参数、要不要问用户、结果怎么渲染、怎么回给模型。
 *  本文件几乎不含业务逻辑，是典型的「声明式配置 + 薄薄一层胶水」。
 *
 *  【在架构中的位置】
 *      工具注册表（src/tools/index.ts 之类）
 *        └─> 注册 WebFetchTool                        ← ★ 本文件导出的对象
 *              │
 *      主循环 src/query.ts 拿到模型的 tool_use 请求
 *        ├─> WebFetchTool.checkPermissions()   要不要弹窗问用户  ← ★ 本文件
 *        ├─> WebFetchTool.validateInput()       参数合法性       ← ★ 本文件
 *        ├─> WebFetchTool.call()                真正执行         ← ★ 本文件
 *        │     └─> getURLMarkdownContent() / applyPromptToMarkdown() ← utils.ts
 *        ├─> renderToolUseMessage() 等          终端 UI 渲染      ← UI.tsx
 *        └─> mapToolResultToToolResultBlockParam() 结果回灌模型   ← ★ 本文件
 *
 *  【本文件包含什么】
 *   1. inputSchema / outputSchema    用 zod 声明的入参与出参结构（同时是给模型的文档）
 *   2. webFetchToolInputToPermissionRuleContent()  把入参折算成权限规则的 key
 *   3. WebFetchTool                  buildTool({...}) 产出的工具对象（文件主体）
 *   4. buildSuggestions()            权限弹窗上"总是允许这个域名"按钮要写的规则
 *
 *  【必须理解的两条主线】
 *  (A) **权限模型（本文件最值得看的部分）**
 *      WebFetch 的默认策略是「用户没给过的域名一律要问」。checkPermissions 里
 *      的判定顺序是：白名单 → deny 规则 → ask 规则 → allow 规则 → 兜底 ask。
 *      注意规则是**按域名**粒度存的（key 形如 `domain:docs.python.org`），
 *      而不是按整个工具——因为"允许抓 MDN"和"允许抓任意网站"风险完全不同。
 *  (B) **结果回灌模型的形态**
 *      call() 返回的 result 只是一段字符串（小模型的回答），
 *      mapToolResultToToolResultBlockParam 再把它包成 tool_result 块。
 *      也就是说：**主模型从头到尾只看到小模型的摘要，看不到网页原文**。
 *
 *  【TS 语法速查】（本文件实际出现的）
 *   - `buildTool({...})` + `satisfies ToolDef<...>`
 *                                 工厂函数造对象；`satisfies` 是 TS 4.9+ 的关键字：
 *                                 "请检查这个字面量符合 ToolDef 类型，但**不要**把
 *                                 它的具体类型擦掉"。比 `as` 更安全（as 会放弃检查）。
 *                                 ≈ Java 里没有；近似"匿名子类 + 编译期契约校验"
 *   - `get inputSchema(): InputSchema { ... }`
 *                                 **getter**：属性访问语法背后是函数调用。
 *                                 ≈ Java 的 getter，但调用方写 `obj.inputSchema`
 *                                 不用写括号。这里用它做惰性求值（见 lazySchema）
 *   - `lazySchema(() => z.object({...}))`  延迟构造 schema，避免模块加载时
 *                                 就把整个 zod 对象树建好（启动性能考虑）
 *   - `z.string().url()` zod 校验链  ≈ Java 的 Bean Validation 注解链；
 *                                 .describe() 的文案**会进入给模型的 JSON Schema**
 *   - `z.infer<typeof schema>`      从 schema **反推出** TS 静态类型。
 *                                 ≈ Java 里没有（要靠注解处理器生成）
 *   - `type InputSchema = ReturnType<typeof inputSchema>`
 *                                 取函数返回值类型。≈ Java 没有；理解为类型别名
 *   - `async call({ url, prompt }, { abortController, options: { isNonInteractiveSession } })`
 *                                 **两层解构**：第二个参数把嵌套的 options 也拆开。
 *                                 ≈ Java 21 记录模式匹配支持嵌套，但远没这么常用
 *   - `input as { url: string }`    类型断言 ≈ 强制转换（这里因为 input 尚未校验）
 *   - `'type' in response`          判别联合类型用的属性存在性检查（见 utils.ts）
 *   - `??` 空值合并                 `a ?? b`，注意与 `||` 区别：`0`/`''` 不被替换
 *   - `{ ...obj, extra }` 展开      复制并追加字段；`...(cond && { x })` 是
 *                                 **条件展开**惯用法：条件为 false 时展开空对象
 *   - `async` 方法 / `Promise<T>`   ≈ Java 的 CompletableFuture<T>
 * ============================================================================
 */
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { formatFileSize } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import { isPreapprovedHost } from './preapproved.js'
import { DESCRIPTION, WEB_FETCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import {
  applyPromptToMarkdown,
  type FetchedContent,
  getURLMarkdownContent,
  isPreapprovedUrl,
  MAX_MARKDOWN_LENGTH,
} from './utils.js'

// 中文补充：inputSchema 用 zod 声明，有两个作用——
//   ① 运行时校验模型传来的参数（zod 会拒绝不合法的并给出错误信息）；
//   ② **自动生成给模型看的 JSON Schema**：每个 .describe() 的文案都会出现在
//      模型的工具定义里，等于"写给模型看的文档"。所以这里的措辞也算提示词工程。
// z.strictObject 的 strict = 多了字段就报错（防止模型塞奇怪的额外参数）。
const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('The URL to fetch content from'),
    prompt: z.string().describe('The prompt to run on the fetched content'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    bytes: z.number().describe('Size of the fetched content in bytes'),
    code: z.number().describe('HTTP response code'),
    codeText: z.string().describe('HTTP response code text'),
    result: z
      .string()
      .describe('Processed result from applying the prompt to the content'),
    durationMs: z
      .number()
      .describe('Time taken to fetch and process the content'),
    url: z.string().describe('The URL that was fetched'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * 把一次工具入参折算成「权限规则的 key」。
 *
 * 【做什么】取入参里的 url，解析出主机名，返回形如 `domain:docs.python.org`
 *          的字符串；解析不出就退化成 `input:<整个入参>`。
 * 【为什么需要】权限规则是**按域名**存的（而不是按工具整体）。
 *              用户在弹窗里点"总是允许"时，写进本地设置的规则内容就是这个 key。
 *              这样"允许抓 MDN"不会顺带把"允许抓任意网站"也放开了。
 * 【入参】input  模型的原始入参（类型故意放宽成 `{[k: string]: unknown}`，
 *                因为这时还没校验过，不能假设字段一定存在/类型正确）
 * 【返回】规则 key 字符串
 * 【关键步骤】
 *   ① 用 safeParse 校验（注意是 safeParse 不是 parse：后者失败会抛异常，
 *      前者返回 { success: false }，适合这种"试探一下"的场合）
 *   ② 解析 URL 取 hostname
 *   ③ 任何一步出问题都退化成 `input:...`，**绝不抛异常**——
 *      权限判断这段代码绝不能因为它自己出错而阻塞整个工具
 * 【语法】`{ [k: string]: unknown }` 是索引签名 ≈ Java 的 Map<String,Object>
 */
function webFetchToolInputToPermissionRuleContent(input: {
  [k: string]: unknown
}): string {
  try {
    const parsedInput = WebFetchTool.inputSchema.safeParse(input)
    if (!parsedInput.success) {
      return `input:${input.toString()}`
    }
    const { url } = parsedInput.data
    const hostname = new URL(url).hostname
    return `domain:${hostname}`
  } catch {
    return `input:${input.toString()}`
  }
}

export const WebFetchTool = buildTool({
  name: WEB_FETCH_TOOL_NAME,
  searchHint: 'fetch and extract content from a URL',
  // 100K chars - tool result persistence threshold
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    const { url } = input as { url: string }
    try {
      const hostname = new URL(url).hostname
      return `Claude wants to fetch content from ${hostname}`
    } catch {
      return `Claude wants to fetch content from this URL`
    }
  },
  userFacingName() {
    return 'Fetch'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Fetching ${summary}` : 'Fetching web page'
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
    return input.prompt ? `${input.url}: ${input.prompt}` : input.url
  },
  /**
   * 权限判定——本文件最核心的方法，决定"这次抓取要不要弹窗问用户"。
   *
   * 【做什么】按固定优先级走一遍，返回 allow / deny / ask 之一。
   * 【为什么需要】WebFetch 是模型能**自主发起的出网请求**，
   *              安全边界就在这里。默认策略是「未知即询问」，
   *              只有明确命中白名单或用户已存的 allow 规则才直接放行。
   * 【判定顺序（顺序即优先级，不能随意调换）】
   *   ① 白名单域名 → 直接 allow（preapproved.ts，理由见那个文件的注释）
   *   ② deny 规则命中 → deny（用户/管理员显式禁止，优先级最高）
   *   ③ ask 规则命中 → ask（显式要求每次都问，即使有 allow 也要问）
   *   ④ allow 规则命中 → allow（用户之前点过"总是允许"）
   *   ⑤ 兜底 → ask（默认拒绝静默放行）
   * 【关于 ① 的 try/catch】URL 解析失败时**故意什么都不做**，
   *   让它继续走常规权限流程——而不是崩溃，也不是默认允许。
   * 【入参】input 模型入参；context 提供 getAppState() 拿到当前权限上下文
   * 【返回】PermissionDecision（allow / deny / ask 三态之一 + 附加信息）
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    // 中文补充：命中白名单 → 直接放行。
    // 这是"用户没授权也能抓"的唯一通道，清单内容见 preapproved.ts。
    // 注意传的是 hostname + pathname 两个参数，因为少量条目是"主机+路径"级的
    // （如 github.com/anthropics），只比对主机名会误判。
    // Check if the hostname is in the preapproved list
    try {
      const { url } = input as { url: string }
      const parsedUrl = new URL(url)
      if (isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'other', reason: 'Preapproved host' },
        }
      }
    } catch {
      // If URL parsing fails, continue with normal permission checks
    }

    // Check for a rule specific to the tool input (matching hostname)
    const ruleContent = webFetchToolInputToPermissionRuleContent(input)

    const denyRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'deny',
    ).get(ruleContent)
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `${WebFetchTool.name} denied access to ${ruleContent}.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }

    const askRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'ask',
    ).get(ruleContent)
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to use ${WebFetchTool.name}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        suggestions: buildSuggestions(ruleContent),
      }
    }

    const allowRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'allow',
    ).get(ruleContent)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: allowRule,
        },
      }
    }

    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${WebFetchTool.name}, but you haven't granted it yet.`,
      suggestions: buildSuggestions(ruleContent),
    }
  },
  /**
   * 生成这个工具在系统提示词里的描述（模型靠它决定要不要调用、怎么调用）。
   *
   * 【做什么】返回一段固定前缀 + prompt.ts 里的 DESCRIPTION。
   * 【为什么需要那段前缀】上面英文注释解释了：那段"WebFetch 对需要鉴权的
   *  URL 一定会失败，请改用 MCP 工具"的警告**无条件拼接**。
   *  曾经有人想改成"只在 ToolSearch 可用时才加"，结果工具描述会在两次
   *  API 调用之间来回变化（因为 ToolSearch 是否启用取决于 MCP 工具数量阈值），
   *  每次变化都会让 Anthropic API 的 **prompt cache 失效**，
   *  一次抖动就是两次 cache miss——成本直接翻倍。
   *  这是"提示词必须稳定，否则缓存全废"的典型教训。
   * 【入参】_options 未使用（下划线前缀是 TS 里表示"我知道它没用"的惯例）
   * 【返回】给模型的工具描述字符串
   */
  async prompt(_options) {
    // Always include the auth warning regardless of whether ToolSearch is
    // currently in the tools list. Conditionally toggling this prefix based
    // on ToolSearch availability caused the tool description to flicker
    // between SDK query() calls (when ToolSearch enablement varies due to
    // MCP tool count thresholds), invalidating the Anthropic API prompt
    // cache on each toggle — two consecutive cache misses per flicker event.
    return `IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.
${DESCRIPTION}`
  },
  /**
   * 入参校验：在真正发请求之前，先确认模型给的 URL 是个能解析的 URL。
   *
   * 【做什么】new URL(url) 能过就返回 { result: true }，否则返回带错误信息的 false。
   * 【为什么需要——注意这里和 utils.validateURL 的分工不同】
   *   validateInput 只做**最基础的语法校验**，目的是在权限弹窗之前就把
   *   "模型胡编了一个 URL"这种情况挡掉，并给出**模型能看懂、能自我纠正**的
   *   错误消息（消息里包含原 URL，模型下次可以改）。
   *   而域名黑名单、长度限制那些**安全相关**的校验在 utils.ts 里，属于执行阶段。
   * 【关键】返回的是**错误对象而不是抛异常**——
   *   因为校验失败是模型的错，应该把错误消息回给模型让它重试，
   *   而不是崩溃掉整个 turn。
   * 【返回】{ result: true } 或 { result: false, message, meta, errorCode }
   *        errorCode: 1 是给调用方区分错误类型用的（≈ Java 的错误码枚举）
   */
  async validateInput(input) {
    const { url } = input
    try {
      new URL(url)
    } catch {
      return {
        result: false,
        message: `Error: Invalid URL "${url}". The URL provided could not be parsed.`,
        meta: { reason: 'invalid_url' },
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  /**
   * ★ 工具执行主体：拿 URL + 问题，返回一段答案文本。
   *
   * 【做什么】
   *   ① 调 getURLMarkdownContent 抓网页并转成 markdown
   *   ② 若返回的是"需要跨站重定向"，就拼一段提示让模型换个 URL 再来一次
   *   ③ 否则（大多数情况）让小模型读一遍 markdown，只把答案返回
   *   ④ 如果内容另存过磁盘（PDF 等二进制），在答案末尾追加一行文件位置
   *
   * 【为什么需要 ② 这种"回一句话让模型重试"的设计】
   *   跨站重定向不去跟随是**安全决策**（见 utils.ts 的 isPermittedRedirect）。
   *   但不能就这么失败——模型可能只是不知道要换地址。
   *   所以返回一个**精心写好的、带完整新参数**的提示，
   *   模型读到后会再发一次 WebFetch(url=新地址)，而这次新地址会**重新走一遍
   *   用户授权**。既守住了安全边界，又不中断任务。
   *
   * 【③ 里那个 if 的用意：什么时候能省掉小模型调用？】
   *   三个条件同时满足才直接返回原文：
   *     · 域名在白名单（版权风险低）
   *     · 响应本来就是 text/markdown（已经是模型友好的格式了）
   *     · 长度没超 10 万字符
   *   这常见于文档站直接返回 markdown 的情况——**省一次 API 调用、
   *   少一层信息损失**。其余情况一律走 Haiku 萃取。
   *
   * 【入参】解构出 url、prompt；第二个参数解构出 abortController
   *        （Ctrl+C 取消）和 isNonInteractiveSession
   * 【返回】{ data: Output }，Output 见上方 outputSchema
   * 【关键步骤】
   *   ① start 记时，最后算 durationMs（这个值会显示给用户："花了多久"）
   *   ② 抓 → 判定重定向 → 萃取 → 追加落盘提示 → 组装 Output
   */
  async call(
    { url, prompt },
    { abortController, options: { isNonInteractiveSession } },
  ) {
    const start = Date.now()

    const response = await getURLMarkdownContent(url, abortController)

    // 中文补充：跨站重定向分支。不跟随，而是把"下一步该怎么调"写成一段
    // 结构化的提示回给模型（含可直接复制的 url 和 prompt 参数），
    // 这样模型只需照着再发一次 WebFetch —— 而新 URL 会重新走用户授权。
    // Check if we got a redirect to a different host
    if ('type' in response && response.type === 'redirect') {
      const statusText =
        response.statusCode === 301
          ? 'Moved Permanently'
          : response.statusCode === 308
            ? 'Permanent Redirect'
            : response.statusCode === 307
              ? 'Temporary Redirect'
              : 'Found'

      const message = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`

      const output: Output = {
        bytes: Buffer.byteLength(message),
        code: response.statusCode,
        codeText: statusText,
        result: message,
        durationMs: Date.now() - start,
        url,
      }

      return {
        data: output,
      }
    }

    // 中文补充：`response as FetchedContent` 是**类型断言**（≈ 强制转换）。
    // 需要它，是因为上面那个联合类型经过 if 判断后 TS 还没能自动排除
    // RedirectInfo（'type' in response 的形式不足以让编译器收窄），
    // 所以这里手动声明"到这一步它肯定是 FetchedContent 了"。
    const {
      content,
      bytes,
      code,
      codeText,
      contentType,
      persistedPath,
      persistedSize,
    } = response as FetchedContent

    const isPreapproved = isPreapprovedUrl(url)

    let result: string
    // 中文补充：三个条件都满足才跳过 Haiku、直接返回原文——
    // 白名单域名（版权风险低）+ 响应本身就是 markdown（无需再转换）+
    // 长度没超限（不会撑爆上下文）。命中这条路能省一次小模型 API 调用。
    if (
      isPreapproved &&
      contentType.includes('text/markdown') &&
      content.length < MAX_MARKDOWN_LENGTH
    ) {
      result = content
    } else {
      result = await applyPromptToMarkdown(
        prompt,
        content,
        abortController.signal,
        isNonInteractiveSession,
        isPreapproved,
      )
    }

    // Binary content (PDFs, etc.) was additionally saved to disk with a
    // mime-derived extension. Note it so Claude can inspect the raw file
    // if the Haiku summary above isn't enough.
    if (persistedPath) {
      result += `\n\n[Binary content (${contentType}, ${formatFileSize(persistedSize ?? bytes)}) also saved to ${persistedPath}]`
    }

    const output: Output = {
      bytes,
      code,
      codeText,
      result,
      durationMs: Date.now() - start,
      url,
    }

    return {
      data: output,
    }
  },
  /**
   * 把工具结果包成「回灌给模型的 tool_result 消息块」。
   *
   * 【做什么】取 Output 里的 result 字符串，包成 Anthropic API 要求的格式。
   * 【为什么需要】这是**主模型唯一能看到的东西**。
   *              WebFetch 全流程的终点就是把这一小段文本塞回对话：
   *                网页(几万字符) → 小模型 → 本函数的 content(几百字符) → 主模型
   *              所以这里传什么，就决定了主模型"看到了什么网页"。
   * 【入参】解构出 result；toolUseID 是模型发起调用时给的 ID，
   *        必须原样回传，否则 API 无法把结果对应到那次调用（会报错）
   * 【返回】tool_result 块：{ tool_use_id, type: 'tool_result', content }
   */
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * 构造权限弹窗上的「建议操作」——即"总是允许这个域名"按钮背后的规则。
 *
 * 【做什么】返回一个 PermissionUpdate 数组，表示"往本地设置里加一条 allow 规则"。
 * 【为什么需要】用户在弹窗上点"总是允许"时，需要明确知道**要写什么规则**。
 *              这里生成规则内容，配合 webFetchToolInputToPermissionRuleContent
 *              产出的 `domain:xxx` key，实现"按域名授权"而不是"按工具授权"。
 * 【入参】ruleContent  形如 `domain:docs.python.org` 的规则内容
 * 【返回】PermissionUpdate[]（弹窗渲染出可点击的建议项）
 */
function buildSuggestions(ruleContent: string): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      destination: 'localSettings',
      rules: [{ toolName: WEB_FETCH_TOOL_NAME, ruleContent }],
      behavior: 'allow',
    },
  ]
}
