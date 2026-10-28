/**
 * ============================================================================
 *  【文件总览】src/tools/ToolSearchTool/ToolSearchTool.ts —— 「按需检索工具」的工具
 * ============================================================================
 *
 *  【一句话定位】
 *  实现名为 `ToolSearch` 的工具：模型给它一个查询词，它返回**匹配的工具名**，
 *  客户端随后把这些工具的完整 schema 注入上下文，模型就能调用它们了。
 *
 * ---------------------------------------------------------------------------
 *  ★★ ToolSearch 解决什么问题？★★
 * ---------------------------------------------------------------------------
 *  问题：工具太多，塞不进上下文。
 *
 *  Claude Code 除了自带工具（Read/Edit/Bash/Grep…），还会接入大量 MCP 工具
 *  （github、slack、jira、数据库…）。每个工具都要把它的 **JSON Schema**
 *  写进系统提示，一个中等复杂度的工具光 schema 就几百 token。
 *  接五六个 MCP server 后，光工具定义就能占掉几万 token ——
 *  上下文被挤占、首轮请求更贵、而且模型在几百个工具里更容易挑错。
 *
 *  解法：**按需加载（deferred loading）+ 检索**。
 *
 *      平时：系统提示里只列出工具【名字】（一行一个，极便宜）
 *      模型想用：先调 ToolSearch 查一下
 *      命中后：客户端把完整 schema 注入上下文（tool_reference 机制）
 *      之后：模型就能正常调用它了
 *
 *  ≈ Java 的 ClassLoader 懒加载 / Spring 的 @Lazy：用到谁才初始化谁。
 *
 *  谁被"延迟"由 ./prompt.ts 的 isDeferredTool() 决定（MCP 工具默认全部延迟）。
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置】
 * ---------------------------------------------------------------------------
 *
 *      系统提示生成（src/Tool.ts / src/utils/toolSearch.ts）
 *        └─> tools.filter(isDeferredTool)     ← ./prompt.ts
 *              └─> 延迟工具只留名字，写进 <available-deferred-tools>
 *
 *      模型：我要用 github 的工具 → tool_use { name:'ToolSearch',
 *                                            input:{ query:'github issue' } }
 *        └─> ToolSearchTool.call()            ← ★ 本文件
 *              ├─> query 以 'select:' 开头 → 按名字直接选（支持逗号多选）
 *              └─> 否则 → searchToolsWithKeywords() 打分排序
 *                    └─> 返回 { matches: ['mcp__github__create_issue', ...] }
 *        └─> mapToolResultToToolResultBlockParam()  ← ★ 本文件
 *              └─> 转成 [ { type:'tool_reference', tool_name } ... ]
 *                    └─> 客户端把完整 schema 展开进上下文
 *                          └─> 模型现在可以正常调用该工具了
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】（主要函数清单）
 * ---------------------------------------------------------------------------
 *   1. inputSchema / outputSchema      入参出参的 zod 定义
 *   2. getDeferredToolsCacheKey()      把"当前有哪些延迟工具"编码成缓存 key
 *   3. getToolDescriptionMemoized()    按工具名缓存工具描述（打分要用）
 *   4. maybeInvalidateCache()          延迟工具集合变了就清缓存
 *   5. clearToolSearchDescriptionCache()  对外暴露的清缓存入口
 *   6. buildSearchResult()             组装返回结构
 *   7. parseToolName()                 把工具名切成可搜索的词（含 MCP 命名）
 *   8. compileTermPatterns()           预编译正则（性能）
 *   9. searchToolsWithKeywords()       ★核心：关键词打分检索
 *  10. ToolSearchTool（buildTool 产物）主体，含 isEnabled/call/render 等回调
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *   - `memoize(fn, (toolName) => toolName)`  lodash 的缓存包装。
 *     第二个参数是 **resolver**：定义缓存 key 怎么算。
 *     ≈ Java 的 Caffeine.newBuilder().build(key -> loader.load(key))。
 *     这里明确"只用第一个参数当 key"（第二个参数 tools 不参与），
 *     否则默认的 key 生成会拿整个数组去序列化，非常慢。
 *
 *   - `async (x): Promise<string> => {...}`  **async 箭头函数**
 *     ≈ Java 的 `AsyncFunction<X, CompletableFuture<String>>`。
 *
 *   - `await Promise.all(list.map(async t => ...))`
 *     **并发**等待一组异步任务 ≈ Java 的
 *     `CompletableFuture.allOf(...)` 或 `list.parallelStream()`。
 *     注意：这里是**真并发**（IO 不阻塞），Java 的 stream().map().collect()
 *     默认是串行的，要 parallelStream 才并发。
 *
 *   - `.filter((t): t is Tool => t !== null)`  **类型谓词**。
 *     过滤掉 null 的同时告诉 TS"剩下的元素类型是 Tool"，
 *     ≈ Java `filter(Objects::nonNull)` 之后再强转，但由编译器保证安全。
 *
 *   - `?? ` 空值合并：`a ?? b` 只在 a 为 null/undefined 时取 b。
 *     ⚠️ 与 `||` 不同：`0` 和 `''` 在 `||` 里会被替换，`??` 不会。
 *     本文件 `deferredTools.find(...) ?? tools.find(...)` 就是
 *     "先在延迟集合里找，找不到再去全量集合找"的惯用写法。
 *
 *   - `!` 非空断言：`selectMatch[1]!`、`termPatterns.get(term)!`
 *     = "我保证这里有值"。≈ Java 的强转，运行时不检查。
 *     用在"理论上必然存在"的地方（正则已经匹配成功 / key 刚放进去过）。
 *
 *   - `?.` 可选链：`tool.searchHint?.toLowerCase()` ≈
 *     Java `tool.getSearchHint() != null ? ...toLowerCase() : null`。
 *     后面再跟 `?? ''` 把 undefined 兜成空串，这是很常见的组合拳。
 *
 *   - `...(cond ? { k: v } : {})`  **条件展开**。
 *     三元返回 `{k:v}` 或 `{}`，展开后等价于"按条件加一个字段"。
 *     为什么要这么绕？因为对象字面量里没法写 if。
 *
 *   - `new Map<string, RegExp>()`  泛型 Map，key/value 都有类型
 *     ≈ Java 的 `Map<String, Pattern>`（RegExp ≈ java.util.regex.Pattern）。
 *
 *   - `\b${escapeRegExp(term)}\b`  **词边界正则**。
 *     escapeRegExp 先把 term 里的正则元字符转义掉（比如 `.`、`(`），
 *     否则用户输入 "." 会被当成"任意字符"，造成误匹配（安全 + 正确性）。
 *
 *   - `z.number().optional().default(5)`  zod 的链式构造：
 *     可选 + 默认值。读出来是 number（不是 undefined）。
 *
 *   - `const { query, max_results = 5 } = input`  **解构 + 默认值**。
 *     ≈ Java 没有；等于 `max_results != null ? max_results : 5`。
 *
 *   - `satisfies ToolDef<...>`  既检查类型又**保留**精确类型
 *     （不像 `as` 会把类型放宽丢失信息）。
 *
 *   - `as unknown as X`  **双重断言**：先转成 unknown 再转成目标类型。
 *     用在"类型系统不同意但实际就是对的"这种硬来场景（这里有意为之，
 *     因为 API 类型定义还没跟上 tool_reference 这个新块类型）。
 *
 *   - `isEnabled() / isReadOnly() / isConcurrencySafe()`
 *     框架回调：声明工具的元特性（是否启用 / 只读 / 可并发）。
 *     声明式配置 ≈ Java 里覆写接口方法，但这里只是返回常量。
 * ============================================================================
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import memoize from 'lodash-es/memoize.js'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  buildTool,
  findToolByName,
  type Tool,
  type ToolDef,
  type Tools,
} from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { escapeRegExp } from '../../utils/stringUtils.js'
import { isToolSearchEnabledOptimistic } from '../../utils/toolSearch.js'
import { getPrompt, isDeferredTool, TOOL_SEARCH_TOOL_NAME } from './prompt.js'

/**
 * 入参 schema。两个字段：
 *   query       查询词。支持两种写法：
 *                  `select:Read,Edit`  按名字直接选（可逗号分隔多选）
 *                  `github issue`      关键词搜索
 *                  `+slack send`       带 + 前缀的词是**必须命中**的条件
 *   max_results 最多返回几个（默认 5）
 *
 * .describe() 里的文字会被生成进 JSON Schema 给模型看，
 * 所以这些英文描述实际上是**提示词的一部分**。
 */
export const inputSchema = lazySchema(() =>
  z.object({
    query: z
      .string()
      .describe(
        'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
      ),
    max_results: z
      .number()
      .optional()
      .default(5)
      .describe('Maximum number of results to return (default: 5)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    matches: z.array(z.string()),
    query: z.string(),
    total_deferred_tools: z.number(),
    pending_mcp_servers: z.array(z.string()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

// 中文补充：`z.infer<S>` 从 schema 反推 TS 类型（这里是**输出侧**，
// 带默认值的字段已经被填好了）。schema 改了类型自动跟着变，不用两处维护。
// ≈ Java 靠注解处理器生成 DTO，但 TS 是纯类型运算、运行时零成本。
export type Output = z.infer<OutputSchema>

// Track deferred tool names to detect when cache should be cleared
// 中文补充：这是一个**模块级可变变量**（≈ Java 的 private static 字段）。
// 它记住"上次缓存时，延迟工具集合是什么样的"，用来判断缓存是否已过期。
// 注意 string | null：null 表示"还没缓存过"。
let cachedDeferredToolNames: string | null = null

/**
 * Get a cache key representing the current set of deferred tools.
 * 中文补充：把"当前有哪些延迟工具"编码成一个字符串，用作缓存的指纹。
 *
 * 为什么需要先 sort 再 join？因为数组顺序可能变（MCP server 连接完成
 * 的先后不同），但**集合内容**没变。不排序会产生一个假的新 key，
 * 导致缓存被无谓地清掉，白白重新生成几十份工具描述（很贵）。
 *
 * @param deferredTools 当前的延迟工具列表
 * @returns 形如 "a,b,c" 的指纹字符串
 */
function getDeferredToolsCacheKey(deferredTools: Tools): string {
  return deferredTools
    .map(t => t.name)
    .sort()
    .join(',')
}

/**
 * Get tool description, memoized by tool name.
 * Used for keyword search scoring.
 * 中文补充：取某个工具的完整描述文本（prompt），**按工具名缓存**。
 *
 * 为什么必须缓存？给几十上百个工具打分时，每个都要读一遍描述，
 * 而 tool.prompt() 可能是个昂贵的异步操作（要拼权限上下文、读配置）。
 * 不缓存的话，一次搜索就会触发上百次，慢到不可用。
 *
 * 为什么 memoize 要传第二个参数 `(toolName) => toolName`？
 * 因为 lodash 默认会把**所有参数**序列化后当 key，而第二个参数 tools
 * 是个大数组，序列化它极慢。这里显式指定"只用第一个参数当 key"。
 * ≈ Java 里自己写一个 keyExtractor 给缓存用。
 *
 * @param toolName 工具名
 * @param tools 全量工具列表（用来查工具对象）
 * @returns 工具描述文本；找不到工具时返回空串
 */
const getToolDescriptionMemoized = memoize(
  async (toolName: string, tools: Tools): Promise<string> => {
    const tool = findToolByName(tools, toolName)
    if (!tool) {
      return ''
    }
    // 中文补充：这里构造了一个**假的权限上下文**传进去。
    // 因为我们只是想拿到工具的描述文本用于搜索打分，
    // 并不真的要按用户的权限配置来渲染，所以给个最小可用的默认值。
    return tool.prompt({
      getToolPermissionContext: async () => ({
        mode: 'default' as const,
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      }),
      tools,
      agents: [],
    })
  },
  (toolName: string) => toolName,
)

/**
 * Invalidate the description cache if deferred tools have changed.
 * 中文补充：**惰性失效**策略 —— 每次搜索前先比对指纹，变了才清缓存。
 *
 * 为什么需要它？MCP server 是**异步连接**的：开局时可能只有 3 个工具，
 * 过几秒连上了就变成 50 个。如果缓存不失效，模型会搜到一堆"过期的"
 * 或者搜不到新出现的工具。
 *
 * 为什么不在 MCP 连接完成的回调里主动清？因为那样要在多处埋点，
 * 容易漏。用指纹比对则只需一处，且任何来源的变化都能捕获。
 *
 * @param deferredTools 当前的延迟工具列表
 */
function maybeInvalidateCache(deferredTools: Tools): void {
  const currentKey = getDeferredToolsCacheKey(deferredTools)
  if (cachedDeferredToolNames !== currentKey) {
    logForDebugging(
      `ToolSearchTool: cache invalidated - deferred tools changed`,
    )
    // 中文补充：`cache.clear?.()` 的 ?. 是可选调用 —— lodash 的 memoize
    // 在类型上不保证有 cache.clear，所以"有就调，没有就算了"。
    getToolDescriptionMemoized.cache.clear?.()
    cachedDeferredToolNames = currentKey
  }
}

/**
 * 对外暴露的清缓存入口（供测试、或配置热重载时调用）。
 * 为什么需要：除了自动失效，有些场景需要**强制**清（比如单元测试之间、
 * 或者工具集合被显式重建）。清完要把指纹也重置成 null，
 * 否则下次 maybeInvalidateCache 会认为"没变化"而跳过重建。
 */
export function clearToolSearchDescriptionCache(): void {
  getToolDescriptionMemoized.cache.clear?.()
  cachedDeferredToolNames = null
}

/**
 * Build the search result output structure.
 * 中文补充：组装返回结构。这里唯一"有讲究"的是 pending_mcp_servers 字段：
 * **只在非空时才加进去**（见条件展开）。
 *
 * 为什么？因为"没有正在连接的 server"是常态，
 * 每次都带一个空数组会浪费 token，而且容易让模型误以为要等。
 *
 * @param matches 命中的工具名
 * @param query 原始查询词（原样回给模型，方便它对照）
 * @param totalDeferredTools 延迟工具总数（让模型知道还有多少没找到）
 * @param pendingMcpServers 还在连接中的 MCP server 名，可选
 * @returns 包装成 { data: Output } 的工具结果
 */
function buildSearchResult(
  matches: string[],
  query: string,
  totalDeferredTools: number,
  pendingMcpServers?: string[],
): { data: Output } {
  return {
    data: {
      matches,
      query,
      total_deferred_tools: totalDeferredTools,
      ...(pendingMcpServers && pendingMcpServers.length > 0
        ? { pending_mcp_servers: pendingMcpServers }
        : {}),
    },
  }
}

/**
 * Parse tool name into searchable parts.
 * Handles both MCP tools (mcp__server__action) and regular tools (CamelCase).
 * 中文补充：把工具名**切成一个个可搜索的词**。
 *
 * 为什么要切？因为用户/模型搜的是 "github"、"send" 这类词，
 * 而工具名是 `mcp__github__create_issue` 或 `NotebookEdit` 这种连写形式。
 * 不切分就没法做"词级"匹配，只能做整串包含匹配（效果差很多）。
 *
 * 两种命名规范要分别处理：
 *   - MCP 工具：`mcp__server__action_name`，双下划线是分隔符
 *   - 普通工具：`NotebookEdit` 驼峰，或 `some_tool` 下划线
 *
 * @param name 工具名
 * @returns { parts: 词数组, full: 拼接后的整串, isMcp: 是否 MCP 工具 }
 */
function parseToolName(name: string): {
  parts: string[]
  full: string
  isMcp: boolean
} {
  // Check if it's an MCP tool
  // 中文补充：MCP 工具名的结构是 mcp__<server>__<action>，
  // 用双下划线分隔。这里先把前缀去掉，再按分隔符切开。
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  // Regular tool - split by CamelCase and underscores
  // 中文补充：三步走 —— 驼峰处插空格 → 下划线换空格 → 按空白切开。
  // `NotebookEdit` → `Notebook Edit` → ['notebook','edit']
  // `.filter(Boolean)` 是去掉切分产生的空串的惯用写法
  // （Boolean 作为回调函数，会自动过滤掉所有 falsy 值）。
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2') // CamelCase to spaces
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return {
    parts,
    full: parts.join(' '),
    isMcp: false,
  }
}

/**
 * Pre-compile word-boundary regexes for all search terms.
 * Called once per search instead of tools×terms×2 times.
 * 中文补充：**预编译正则**，纯性能优化。
 *
 * 问题：如果有 100 个工具 × 3 个查询词 × 2 处匹配（描述 + hint），
 * 每次都 `new RegExp(...)` 就是 600 次正则编译，很慢。
 * 现在只编译 3 次，之后复用。
 *
 * 两个正确性要点：
 *   ① `escapeRegExp(term)` —— 必须转义！否则查询词里带 `.`、`(`、`[`
 *      这类正则元字符时会被当成正则语法，轻则误匹配、重则抛异常。
 *   ② `\\b...\\b` **词边界** —— 搜 "read" 不该匹配到 "already"。
 *      这是防止"假阳性"的关键（比如搜 shell 不该命中 "shellexec" 之外的
 *      一堆含 shell 子串的长单词）。
 *
 * @param terms 查询词数组
 * @returns 词 → 正则 的映射
 */
function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>()
  for (const term of terms) {
    // 中文补充：去重 —— 查询词重复时不重复编译
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
    }
  }
  return patterns
}

/**
 * Keyword-based search over tool names and descriptions.
 * Handles both MCP tools (mcp__server__action) and regular tools (CamelCase).
 *
 * The model typically queries with:
 * - Server names when it knows the integration (e.g., "slack", "github")
 * - Action words when looking for functionality (e.g., "read", "list", "create")
 * - Tool-specific terms (e.g., "notebook", "shell", "kill")
 *
 * 中文补充：★ 本文件的核心：一个**打分排序**的关键词检索。
 *
 * 为什么不用 BM25/TF-IDF 这类成熟算法？
 *   因为候选集很小（几十到几百个工具），而且**名字匹配的信号远强于描述匹配**。
 *   一套手写的、可读性好的加权规则更容易调，也更好解释。
 *
 * 执行顺序（从快到慢，能早返回就早返回）：
 *   ① 精确匹配工具名 → 直接返回（快路径）
 *   ② 以 mcp__ 开头的查询 → 按前缀过滤返回
 *   ③ 拆分出"必选词(+前缀)"和"可选词"
 *   ④ 用必选词**预筛**（大幅缩小候选集，省掉后面的打分开销）
 *   ⑤ 对候选逐个打分 → 过滤掉 0 分 → 按分降序 → 截断到 maxResults
 *
 * 打分权重（数字本身是调出来的经验值，不是理论推导）：
 *     名字里**完整命中某个词**     MCP 12 / 普通 10   ← 最强信号
 *     名字里**部分包含**查询词     MCP  6 / 普通  5
 *     整串名字包含（兜底，仅当目前 0 分） 3
 *     searchHint 命中               4               ← 人工写的短语，质量高
 *     描述正文命中                  2               ← 最弱，容易误命中
 *   为什么名字权重远高于描述？描述里"read"这种词到处都是，
 *   而名字里出现通常意味着这个工具就是干这个的。
 *
 * @param query 查询词
 * @param deferredTools 延迟工具列表（**只在这里面搜**）
 * @param tools 全量工具列表（只是为了取工具描述）
 * @param maxResults 最多返回几个
 * @returns 按分数降序的工具名数组
 */
async function searchToolsWithKeywords(
  query: string,
  deferredTools: Tools,
  tools: Tools,
  maxResults: number,
): Promise<string[]> {
  const queryLower = query.toLowerCase().trim()

  // Fast path: if query matches a tool name exactly, return it directly.
  // Handles models using a bare tool name instead of select: prefix (seen
  // from subagents/post-compaction). Checks deferred first, then falls back
  // to the full tool set — selecting an already-loaded tool is a harmless
  // no-op that lets the model proceed without retry churn.
  // 中文补充：模型有时会**直接把工具名当查询词**（不带 select: 前缀），
  // 尤其在子 agent 里或上下文压缩之后（提示被压缩，它忘了格式约定）。
  // 这里宽容地兼容，避免模型白跑一轮。
  // `??` 表示：先在延迟集合找，找不到再去全量集合找。
  // 命中一个**已经加载好的**工具也照样返回——那是无害的空操作，
  // 总比让模型报错重试好。
  const exactMatch =
    deferredTools.find(t => t.name.toLowerCase() === queryLower) ??
    tools.find(t => t.name.toLowerCase() === queryLower)
  if (exactMatch) {
    return [exactMatch.name]
  }

  // If query looks like an MCP tool prefix (mcp__server), find matching tools.
  // Handles models searching by server name with mcp__ prefix.
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter(t => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map(t => t.name)
    if (prefixMatches.length > 0) {
      return prefixMatches
    }
  }

  const queryTerms = queryLower.split(/\s+/).filter(term => term.length > 0)

  // Partition into required (+prefixed) and optional terms
  // 中文补充：`+slack send` 这种写法里，`+slack` 是**必须命中**的硬条件，
  // `send` 只是参与打分（可有可无）。这给了模型一种精确控制检索的手段
  // —— 相当于简易版的布尔查询语法。
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const term of queryTerms) {
    if (term.startsWith('+') && term.length > 1) {
      // 中文补充：slice(1) 去掉那个 '+' 号再存
      requiredTerms.push(term.slice(1))
    } else {
      optionalTerms.push(term)
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms
  const termPatterns = compileTermPatterns(allScoringTerms)

  // Pre-filter to tools matching ALL required terms in name or description
  // 中文补充：**先用必选词预筛**，把候选集从"全部延迟工具"缩小到"命中的少数几个"，
  // 后面昂贵的打分就只对这几个跑。这是典型的"先粗筛再精排"（召回 → 排序）两段式。
  // ⚠️ 注意：没有必选词时**不做**预筛（candidateTools 就是全量），
  // 因为预筛本身也要读一遍所有工具描述，白跑一趟不划算。
  let candidateTools = deferredTools
  if (requiredTerms.length > 0) {
    // 中文补充：`Promise.all(list.map(async ...))` = **并发**执行所有异步任务。
    // ≈ Java 的 CompletableFuture.allOf(...)。这里是真并发，不是顺序 await。
    const matches = await Promise.all(
      deferredTools.map(async tool => {
        const parsed = parseToolName(tool.name)
        const description = await getToolDescriptionMemoized(tool.name, tools)
        const descNormalized = description.toLowerCase()
        const hintNormalized = tool.searchHint?.toLowerCase() ?? ''
        // 中文补充：`every()` = 所有必选词都要命中（AND 语义）
        // ≈ Java 的 stream().allMatch(...)
        const matchesAll = requiredTerms.every(term => {
          // 中文补充：`!` 非空断言 —— 这个词刚刚放进 termPatterns，
          // 必然取得到，用 ! 让编译器闭嘴。
          const pattern = termPatterns.get(term)!
          return (
            parsed.parts.includes(term) ||
            parsed.parts.some(part => part.includes(term)) ||
            pattern.test(descNormalized) ||
            (hintNormalized && pattern.test(hintNormalized))
          )
        })
        // 中文补充：没全命中的返回 null，下一行统一过滤掉
        return matchesAll ? tool : null
      }),
    )
    // 中文补充：`(t): t is Tool => t !== null` 是**类型谓词** ——
    // 过滤 null 的同时把元素类型从 `Tool | null` 收窄成 `Tool`，
    // 后面才能安全访问 tool.name。
    candidateTools = matches.filter((t): t is Tool => t !== null)
  }

  const scored = await Promise.all(
    candidateTools.map(async tool => {
      const parsed = parseToolName(tool.name)
      const description = await getToolDescriptionMemoized(tool.name, tools)
      const descNormalized = description.toLowerCase()
      const hintNormalized = tool.searchHint?.toLowerCase() ?? ''

      let score = 0
      for (const term of allScoringTerms) {
        const pattern = termPatterns.get(term)!

        // Exact part match (high weight for MCP server names, tool name parts)
        // 中文补充：名字里**完整命中一个词**是最强信号（10~12 分）。
        // MCP 工具给更高分，因为 MCP 名字里的 server 段（github、slack）
        // 几乎就是模型要搜的东西。
        if (parsed.parts.includes(term)) {
          score += parsed.isMcp ? 12 : 10
        } else if (parsed.parts.some(part => part.includes(term))) {
          // 中文补充：只是"部分包含"（搜 "read" 命中 "pread"）信号弱一些
          score += parsed.isMcp ? 6 : 5
        }

        // Full name fallback (for edge cases)
        // 中文补充：兜底分支。`&& score === 0` 是关键——
        // 只有当这个词**一点都没命中**时才给 3 分保底，
        // 否则会和上面两条重复计分，把权重体系搞乱。
        if (parsed.full.includes(term) && score === 0) {
          score += 3
        }

        // searchHint match — curated capability phrase, higher signal than prompt
        // 中文补充：searchHint 是开发者手写的一句话能力描述（比如
        // SkillTool 的 'invoke a slash-command skill'），信息密度远高于
        // 自动生成的 prompt 全文，所以给 4 分（比描述正文的 2 分高）。
        if (hintNormalized && pattern.test(hintNormalized)) {
          score += 4
        }

        // Description match - use word boundary to avoid false positives
        // 中文补充：描述正文命中只给 2 分——描述里常用词太多，
        // 容易"沾边就中"，是最弱的信号。配合前面的 \b 词边界正则兜底。
        if (pattern.test(descNormalized)) {
          score += 2
        }
      }

      return { name: tool.name, score }
    }),
  )

  // 中文补充：最后三步是标准的"过滤 → 排序 → 截断"：
  //   filter(score > 0)  0 分的一律不要（宁缺毋滥，返回一堆不相关的更糟）
  //   sort((a,b) => b-a) 降序（注意 JS 的 sort 比较器返回**数字**，
  //                      ≈ Java 的 Comparator.comparingInt(x -> -x.score)）
  //   slice(0, max)      取前 N 个 ≈ Java 的 .limit(n)
  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.name)
}

/**
 * ★ 主体：ToolSearch 工具对象（由 buildTool 工厂产出）。
 *
 * 几个元特性声明的含义：
 *   isEnabled()          由实验开关决定是否启用（没启用就不出现在工具列表里）
 *   isConcurrencySafe()  返回 true = **可以和其他工具并发执行**。
 *                        它只是查一下名字，没有任何副作用，所以安全。
 *   isReadOnly()         返回 true = 不修改任何东西。
 *                        这两个声明让调度层敢把它放进并发批次里执行。
 *
 * description() 和 prompt() 都返回同一份文本（getPrompt()）：
 *   description 是工具列表里的简短说明，prompt 是展开的详细说明书。
 *   在 API 支持 prompt 字段时，只有 prompt 会被发送，两者合一最省事。
 */
export const ToolSearchTool = buildTool({
  isEnabled() {
    return isToolSearchEnabledOptimistic()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  name: TOOL_SEARCH_TOOL_NAME,
  maxResultSizeChars: 100_000,
  async description() {
    return getPrompt()
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 检索入口。两条路径：
   *   ① query 以 `select:` 开头 → 按名字精确选择（支持逗号分隔多选）
   *   ② 否则 → 关键词打分检索
   *
   * @param input 含 query 和 max_results
   * @param ctx 工具上下文；这里只用了 tools（全量工具）和 getAppState
   * @returns 含 matches 的结果
   */
  async call(input, { options: { tools }, getAppState }) {
    // 中文补充：**解构 + 默认值**。`max_results` 没传时取 5
    // （zod 里也写了 default(5)，这里是双保险）。
    const { query, max_results = 5 } = input

    // 中文补充：只在**延迟工具**里搜。已经常驻的工具不需要检索
    // （它们的 schema 本来就在上下文里）。
    const deferredTools = tools.filter(isDeferredTool)
    // 中文补充：MCP server 是异步连接的，工具集合会变 —— 先看缓存要不要失效。
    maybeInvalidateCache(deferredTools)

    // Check for MCP servers still connecting
    // 中文补充：**函数内定义的函数**（≈ Java 的局部类/lambda 捕获外部变量）。
    // 返回"还在连接中的 MCP server 名字"。搜不到东西时告诉模型
    // "别急，这几个 server 还没连上，稍后再试"，避免它以为工具不存在。
    // 返回类型是 `string[] | undefined`：没有时返回 undefined（而不是空数组），
    // 这样下游可以用简单的真值判断决定是否展示。
    function getPendingServerNames(): string[] | undefined {
      const appState = getAppState()
      const pending = appState.mcp.clients.filter(c => c.type === 'pending')
      return pending.length > 0 ? pending.map(s => s.name) : undefined
    }

    // Helper to log search outcome
    // 中文补充：埋点。检索是这套机制的**关键路径**——命中率、零命中率
    // 直接决定"按需加载"这个设计是否成立，所以每次都记。
    // queryType 的类型 `'select' | 'keyword'` 是**字面量联合类型**
    // ≈ Java 的 enum，传别的值编译期就报错。
    function logSearchOutcome(
      matches: string[],
      queryType: 'select' | 'keyword',
    ): void {
      logEvent('tengu_tool_search_outcome', {
        query:
          query as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        queryType:
          queryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        matchCount: matches.length,
        totalDeferredTools: deferredTools.length,
        maxResults: max_results,
        hasMatches: matches.length > 0,
      })
    }

    // Check for select: prefix — direct tool selection.
    // Supports comma-separated multi-select: `select:A,B,C`.
    // If a name isn't in the deferred set but IS in the full tool set,
    // we still return it — the tool is already loaded, so "selecting" it
    // is a harmless no-op that lets the model proceed without retry churn.
    // 中文补充：`select:` 是**精确点名**模式（不走打分）。
    // 为什么需要它？模型在第一轮往往已经从 <available-deferred-tools>
    // 里看到了确切的工具名，直接点名比模糊搜索准确得多，也省一轮。
    // 正则末尾的 `i` 是忽略大小写标志（≈ Java 的 Pattern.CASE_INSENSITIVE）。
    const selectMatch = query.match(/^select:(.+)$/i)
    if (selectMatch) {
      const requested = selectMatch[1]!
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

      // 中文补充：分成"找到的"和"没找到的"两组 —— 支持**部分成功**。
      // 这点很重要：模型一次点名 3 个工具，其中 1 个不存在时，
      // 应该把另外 2 个给它，而不是整体报错（否则它得重试两次）。
      const found: string[] = []
      const missing: string[] = []
      for (const toolName of requested) {
        // 中文补充：`??` 链式查找：延迟集合 → 全量集合
        const tool =
          findToolByName(deferredTools, toolName) ??
          findToolByName(tools, toolName)
        if (tool) {
          // 中文补充：去重 —— 模型可能重复写同一个名字
          if (!found.includes(tool.name)) found.push(tool.name)
        } else {
          missing.push(toolName)
        }
      }

      // 中文补充：一个都没找到时，额外带上"还在连接的 server"信息，
      // 因为**零命中最常见的原因就是 MCP server 还没连上**。
      if (found.length === 0) {
        logForDebugging(
          `ToolSearchTool: select failed — none found: ${missing.join(', ')}`,
        )
        logSearchOutcome([], 'select')
        const pendingServers = getPendingServerNames()
        return buildSearchResult(
          [],
          query,
          deferredTools.length,
          pendingServers,
        )
      }

      if (missing.length > 0) {
        logForDebugging(
          `ToolSearchTool: partial select — found: ${found.join(', ')}, missing: ${missing.join(', ')}`,
        )
      } else {
        logForDebugging(`ToolSearchTool: selected ${found.join(', ')}`)
      }
      logSearchOutcome(found, 'select')
      return buildSearchResult(found, query, deferredTools.length)
    }

    // Keyword search
    // 中文补充：没有 select: 前缀，走打分检索。
    const matches = await searchToolsWithKeywords(
      query,
      deferredTools,
      tools,
      max_results,
    )

    logForDebugging(
      `ToolSearchTool: keyword search for "${query}", found ${matches.length} matches`,
    )

    logSearchOutcome(matches, 'keyword')

    // Include pending server info when search finds no matches
    // 中文补充：零命中时附上"哪些 server 还在连接"，让模型知道
    // 这是**暂时**没有而不是根本不存在，它会稍后重试而不是放弃。
    if (matches.length === 0) {
      const pendingServers = getPendingServerNames()
      return buildSearchResult(
        matches,
        query,
        deferredTools.length,
        pendingServers,
      )
    }

    return buildSearchResult(matches, query, deferredTools.length)
  },
  // 中文补充：工具调用时**不显示任何东西**（返回 null）。
  // 为什么？检索是内部动作，一闪而过，画出来只会刷屏。
  renderToolUseMessage() {
    return null
  },
  // 中文补充：展示给用户的名字为空串 —— 进一步确认这个工具"不露面"。
  userFacingName: () => '',
  /**
   * Returns a tool_result with tool_reference blocks.
   * This format works on 1P/Foundry. Bedrock/Vertex may not support
   * client-side tool_reference expansion yet.
   *
   * 中文补充：★ 整套机制的**临门一脚** —— 把检索结果翻译成 API 认识的
   * `tool_reference` 块。客户端收到这类块后，会把对应工具的完整
   * JSON Schema 注入上下文，模型从此就能正常调用它们了。
   *
   * 这就是为什么返回的是"工具名"而不是"schema 文本"：
   * 让客户端去展开，比我们在这里拼一大段 JSON 更省 token，
   * 也避免了两边 schema 格式不一致的问题。
   *
   * @param content 检索结果（含 matches）
   * @param toolUseID 这次 tool_use 的 id
   * @returns API 需要的 ToolResultBlockParam
   */
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    // 中文补充：零命中时返回**纯文本**而不是空数组 ——
    // 给模型一句人话（"没找到"+ 可能的原因），它才知道下一步该怎么办。
    if (content.matches.length === 0) {
      let text = 'No matching deferred tools found'
      if (
        content.pending_mcp_servers &&
        content.pending_mcp_servers.length > 0
      ) {
        text += `. Some MCP servers are still connecting: ${content.pending_mcp_servers.join(', ')}. Their tools will become available shortly — try searching again.`
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content: text,
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      // 中文补充：把每个命中的工具名变成一个 tool_reference 块。
      // `as const` 让 'tool_reference' 保持字面量类型（而不是 string）。
      content: content.matches.map(name => ({
        type: 'tool_reference' as const,
        tool_name: name,
      })),
      // 中文补充：`as unknown as X` 是**双重断言**（先转 unknown 再转目标）。
      // 用在"SDK 的类型定义还没支持 tool_reference 这种新块"的场合 ——
      // 属于刻意为之的硬来，注释里也注明了 Bedrock/Vertex 可能还不支持。
    } as unknown as ToolResultBlockParam
  },
} satisfies ToolDef<InputSchema, Output>)
