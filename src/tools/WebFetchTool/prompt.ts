/**
 * ============================================================================
 *  【文件总览】src/tools/WebFetchTool/prompt.ts —— WebFetch 工具的「文案/提示词层」
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件是 WebFetch 工具的「文案仓库」：只存放两类字符串——
 *    (a) 给主模型看的「工具说明书」（决定模型什么时候该调用 WebFetch）；
 *    (b) 给二级小模型看的「提示词模板」（决定小模型怎么总结网页）。
 *  它不含任何 fetch、权限、缓存逻辑，纯粹是常量 + 一个字符串拼接函数。
 *
 *  【在架构中的位置】
 *      模型在 system prompt 里读到工具说明
 *        └─> WebFetchTool.prompt()                    ← WebFetchTool.ts
 *              └─> DESCRIPTION                        ← ★ 本文件导出
 *
 *      模型真的发起 WebFetch 调用
 *        └─> WebFetchTool.call()                      ← WebFetchTool.ts
 *              ├─> getURLMarkdownContent()            ← utils.ts（抓网页 → markdown）
 *              └─> applyPromptToMarkdown()            ← utils.ts
 *                    └─> makeSecondaryModelPrompt()   ← ★ 本文件导出
 *                          └─> queryHaiku()           ← src/services/api/claude.ts（真发请求）
 *
 *  即：本文件是「文字的源头」，被 WebFetchTool.ts（工具定义）和 utils.ts
 *  （真正干活的地方）两处引用。改这里的措辞 = 改模型的行为，属于高杠杆改动。
 *
 *  【本文件包含什么】（就 3 个导出）
 *   1. WEB_FETCH_TOOL_NAME        工具名常量 'WebFetch'（工具注册表 & 权限规则都靠它）
 *   2. DESCRIPTION                写在系统提示词里的工具说明，含一堆 Usage notes
 *   3. makeSecondaryModelPrompt() 把「网页 markdown + 用户 prompt + 版权/合规约束」
 *                                 拼成一段完整的二级模型提示词
 *
 *  【TS 语法速查】（本文件实际出现的）
 *   - `export const X = '...'`       导出常量 ≈ Java 的 public static final String X
 *   - 反引号字符串 `` `...${x}...` `` 模板字符串。
 *                                    ≈ Java 的 String.format / Java 21+ 的 STR."...\{x}..."
 *                                    关键区别：**可以直接换行**，所以这里能用它写
 *                                    几十行的多行提示词，而 Java 要靠文本块（"""）或拼接
 *   - `cond ? a : b` 三元运算符      和 Java 一样；本文件用它在一个表达式里选出
 *                                    两套完全不同的版权措辞
 *   - `function f(a: string, b: boolean): string`
 *                                   类型标注在**后面**：参数 string、返回值 string
 *                                   （Java 是 `String f(String a, boolean b)`，正好反过来）
 *
 *  【一个容易困惑的点】为什么同一个工具要有「两套版权措辞」？
 *  见 makeSecondaryModelPrompt 上方的中文说明——白名单域名 vs 普通域名，
 *  法律上允许的引用长度不一样。
 * ============================================================================
 */

export const WEB_FETCH_TOOL_NAME = 'WebFetch'

/**
 * 工具说明书：这段英文会原样进入主模型的 system prompt。
 * 中文要点（原文是英文，这里解释它为什么这么写）：
 *  - 前 6 条是「能力声明」，告诉模型：你给我 URL + 一个问题，我把网页转成
 *    markdown 后让小模型回答这个问题，只返回答案不返回全文。
 *  - Usage notes 里几条是踩坑经验，不是废话：
 *      · "MCP 提供的 web fetch 优先" —— 第三方 MCP 工具限制更少，优先用别人的。
 *      · "HTTP 会自动升级成 HTTPS" —— 在 utils.ts 的 getURLMarkdownContent 里实现。
 *      · "15 分钟缓存" —— 对应 utils.ts 的 URL_CACHE，避免同一 URL 反复抓。
 *      · "重定向到别的 host 会特殊返回" —— 这是**安全设计**：不自动跟随跨站重定向，
 *        而是把新地址回给模型，让模型（和用户）再明确授权一次，
 *        防止「open redirect」把请求悄悄引到恶意站点。
 *      · "GitHub 链接改用 gh CLI" —— gh 能带鉴权，WebFetch 抓不到私有内容。
 */
export const DESCRIPTION = `
- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
`

/**
 * 拼装「二级小模型」的完整提示词。
 *
 * 【做什么】把三段内容拼成一段纯文本：网页正文（markdown）+ 用户想问的问题
 *          + 一组回答约束（guidelines），交给 Haiku 这种小快模型去读。
 *
 * 【为什么需要它——这是本文件最关键的设计】
 *   网页动辄几万甚至十万字符。如果直接把原文塞回主循环，会瞬间撑爆上下文
 *   窗口（还贵）。所以 WebFetch 的策略是「**用便宜的小模型做一次信息萃取**」：
 *     主模型(贵) ──只发一个问题──> 小模型(便宜) ──读完整个网页──> 返回一小段答案
 *                                                                  │
 *     主模型(贵) <────────────── 只拿到这一小段 ───────────────────┘
 *   这个函数生成的就是发给小模型的那封信。
 *
 * 【isPreapprovedDomain 为什么会导致两套完全不同的措辞？——版权考量】
 *   - 白名单域名（docs.python.org、developer.mozilla.org 这类**官方文档站**）：
 *     这些站点的内容本来就是给人读、给人抄的，版权风险低。所以允许小模型
 *     「自由引用，需要多少引用多少，代码例子和文档摘录都可以贴」。
 *   - 其它域名（新闻、博客、论坛等**受版权保护的内容**）：
 *     法律上属于「第三方版权作品」。于是强制：
 *       · 单次引用上限 125 个字符（避免大段复制）；
 *       · 逐字照抄的部分必须加引号，引号外的表述不能和原文逐字相同（即要改写）；
 *       · 不评价自身行为的合法性（避免模型输出像是法律意见的东西）；
 *       · 绝不复现歌词（歌词版权诉讼高发区，是行业惯例红线）。
 *   换句话说：**域名白名单不只是安全机制，也是版权风险分级机制**。
 *
 * 【入参】
 *   markdownContent    网页转成的 markdown 正文（可能已被截断）
 *   prompt             主模型提出的那个问题，例如"这个函数怎么传参"
 *   isPreapprovedDomain 该域名是否在 preapproved.ts 的白名单里
 * 【返回】一段可以直接作为 user message 发给小模型的字符串
 * 【关键步骤】
 *   ① 根据 isPreapprovedDomain 三元选出宽松版 / 严格版 guidelines
 *   ② 用模板字符串把「网页内容 --- 分隔线 --- 问题 --- 约束」拼在一起
 *   ③ 用 `---` 把网页正文和问题隔开，减少小模型把网页当指令的「提示词注入」风险
 */
export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  // 两套 guidelines 就在这里分岔：白名单域名允许自由引用，
  // 非白名单域名走 125 字符引用上限的严格版权模式（原因见上方 JSDoc）。
  const guidelines = isPreapprovedDomain
    ? `Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`

  return `
Web page content:
---
${markdownContent}
---

${prompt}

${guidelines}
`
}
