/**
 * 【一句话定位】四级压缩里的**第二级 microcompact（微压缩）**：
 * 把体积大、且已经「变老」的**工具结果（tool result）**替换成一句占位符，
 * 对话骨架（谁说了什么、调用了什么工具）基本保留不动。这是性价比最高的一级压缩。
 *
 * 【在架构中的位置】
 * - 上游：src/query.ts 的主循环。它在**每次发请求之前**调用本文件的 microcompactMessages()，
 *   query.ts 还从这里 import 了 createMicrocompactBoundaryMessage 相关的边界消息工具（经 utils/messages.ts 转发）。
 * - 下游：
 *   · ./cachedMicrocompact.js（动态 import，服务端 cache editing 路径的实现，外部构建里不存在）
 *   · ./timeBasedMCConfig.js（读 GrowthBook 远程配置）
 *   · ./compactWarningState.js（压缩成功后抑制那条「context 快满了」的警告）
 *   · ../api/promptCacheBreakDetection.js（告诉监控系统：缓存命中率下降是我们干的，不是故障）
 *   · ../tokenEstimation.js（本地粗估 token，避免每次都去调 API 计数）
 * - 调用链：src/query.ts（主循环，发请求前）→ 本文件的 microcompactMessages()
 *           → ① maybeTimeBasedMicrocompact()（按时间，直接改内容）
 *           → ② cachedMicrocompactPath()（按缓存编辑，交给服务端删）
 *
 * 【为什么要这一级】
 * 一次 Read 一个大文件 = 几万 token，一次 Grep / Bash 也可能吐出巨量输出。
 * 这些内容在**当时**是必需的，但过几轮之后模型几乎不会再回头看。
 * 把它们换成一句「[Old tool result content cleared]」，能省下大量 token，
 * 而且**不需要调模型**（不像第四级 autocompact），成本几乎为零，所以它是性价比最高的一级。
 *
 * 【两条实现路径，以及为什么要有两条】
 * ┌ 路径 A：maybeTimeBasedMicrocompact() —— 按**时间**触发，直接改写消息内容
 * │   触发条件：距上一条助手消息超过阈值（默认 60 分钟）
 * │   为什么这时候才行：服务端 prompt 缓存的 TTL 通常 5 分钟 / 1 小时，
 * │   闲置超过 1 小时后缓存**几乎肯定已经过期**，这次请求无论如何都要把整段 prefix 重写一遍。
 * │   既然横竖要重写，不如先把老 tool result 清掉，让「要重写的东西」变小 —— 收益是白捡的。
 * │   注意它必须在**发请求之前**跑，这样缩小的是真正要发出去的 prompt。
 * └ 路径 B：cachedMicrocompactPath() —— 按**数量**触发，交给服务端 cache editing
 *     触发条件：可压缩工具结果的数量超过阈值（配置来自 GrowthBook），且保留最近 N 个
 *     关键差别：**不改动本地消息内容**。它只生成一份 cache_edits 块，
 *     由 API 层随请求一起发出，让**服务端**在读取缓存之后再把内容删掉。
 *     好处是 prompt 缓存**仍然能命中**（prefix 没变）；路径 A 改了内容，缓存就没了。
 *     限制：仅 ant 内部、仅主线程、且模型要支持 cache editing。
 *
 * 路径 A 优先且会**短路**：它一旦触发就跳过路径 B。
 * 理由（原英文注释）：路径 B 依赖「缓存是热的」这个前提，而路径 A 一触发就证明缓存是**冷的**，
 * 再去下发 cache_edits 没有意义。
 *
 * 【三个「cache edits」状态要分清】（很容易看混）
 * - pendingCacheEdits：本次生成的、**将要**随下一个请求发出的 edits（消费后即清空）
 * - pinnedEdits：以前发出过、为了缓存命中必须在**原位置重发**的 edits
 * - state.registeredTools：本地登记在册的工具 ID 台账
 *
 * 【本文件包含什么】
 * - TIME_BASED_MC_CLEARED_MESSAGE：清理后填入的占位符文本。
 * - IMAGE_MAX_TOKEN_SIZE：图片/文档按固定 2000 token 估算。
 * - COMPACTABLE_TOOLS：允许被清理结果的工具白名单。
 * - getCachedMCModule() / ensureCachedMCState()：惰性加载与管理 cached MC 状态。
 * - consumePendingCacheEdits() / getPinnedCacheEdits() / pinCacheEdits()：三个 edits 存取器。
 * - markToolsSentToAPIState() / resetMicrocompactState()：状态推进与重置。
 * - calculateToolResultTokens() / estimateMessageTokens()：本地粗估 token。
 * - collectCompactableToolIds()：收集可压缩工具的 ID（按出现顺序）。
 * - isMainThreadSource()：判断是否主线程来源。
 * - microcompactMessages()：【主入口】由 query.ts 主循环调用。
 * - cachedMicrocompactPath()：路径 B 的实现。
 * - evaluateTimeBasedTrigger() / maybeTimeBasedMicrocompact()：路径 A 的判定与实现。
 *
 * 【TS 语法速查】
 * - `const COMPACTABLE_TOOLS = new Set<string>([...])`：泛型写法与 Java 一致；
 *   `[...SHELL_TOOL_NAMES, GREP_TOOL_NAME]` 用**展开运算符**把数组元素平铺进新数组。
 * - `import('./cachedMicrocompact.js')`：**动态 import**，返回 Promise<模块>，
 *   ≈ Java 里 Class.forName + 反射，但类型安全。放在函数里而不是文件顶层，
 *   是为了让打包器能把这个模块整体摇掉（外部构建根本没有这个文件）。
 * - `typeof import('./x.js')`：表示「那个模块的**整体类型**」，≈ Java 的 Class<X>。
 * - `import('./x.js').CachedMCState`：直接引用另一个模块里导出的**类型**，不需要单独写 import type。
 * - `let x: T | null = null`：联合类型里的 `| null` 表示可能为 null（≈ Java 的 @Nullable）。
 * - `Array.isArray(v)`：≈ Java 的 `v instanceof List`；
 *   但更重要的副作用是**类型收窄**：判断之后 TS 就知道 v 是数组了（≈ Java 的 instanceof 模式匹配）。
 * - `arr.reduce((sum, item) => ..., 0)`：≈ Java Stream.reduce(0, BinaryOperator)。
 * - `arr.findLast(fn)`：倒序查找第一个满足条件的元素（`.at(-1)` 取最后一个元素，同理），
 *   Java 没有对应内建方法，要自己倒着遍历。
 * - `{ ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }`：**展开运算符做不可变更新**——
 *   复制原对象的所有字段，再用后面的覆盖指定字段。≈ Java record 的 wither / Builder.toBuilder()，
 *   但这是语言级的语法。JS 里**不要**直接 `block.content = x` 去改共享对象。
 * - `arr.slice(-n)`：取最后 n 个元素。**坑：slice(-0) 返回整个数组**（见下面 461 行的注释）。
 * - `Arr/Map/Set.filter → Set`：链式集合操作，≈ Java Stream.collect(Collectors.toSet())。
 * - `??` 空值合并 vs `||`：本文件 `toolUseContext?.options.mainLoopModel ?? getMainLoopModel()`
 *   必须用 `??`（只在 null/undefined 时兜底），用 `||` 会把 '' 也替换掉。
 * - `as unknown as Record<string, number | undefined>`：**双重类型断言**，
 *   先把类型推倒成 unknown 再转成目标类型。≈ Java 的 `(T)(Object) x` 强转，
 *   用来绕开编译器检查（这里是读取 SDK 尚未声明的 usage 字段）。
 * - `Number.isFinite(x)`：比全局 isNaN 更严格（NaN 和 Infinity 都会被判 false）。
 * - `messages.map(...)`：≈ Java Stream.map + collect(toList())，返回新数组，不改原数组。
 * - `60_000` / `4 / 3`：数字分隔符；注意 TS/JS 的 `/` 是**浮点除法**（Java 里两个 int 相除会取整），
 *   所以 `4 / 3` 是 1.333... 而不是 1。
 */
import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { notifyCacheDeletion } from '../api/promptCacheBreakDetection.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from './compactWarningState.js'
import {
  getTimeBasedMCConfig,
  type TimeBasedMCConfig,
} from './timeBasedMCConfig.js'

// Inline from utils/toolResultStorage.ts — importing that file pulls in
// sessionStorage → utils/messages → services/api/errors, completing a
// circular-deps loop back through this file via promptCacheBreakDetection.
// Drift is caught by a test asserting equality with the source-of-truth.
// 中文补充上面那段英文（这是很典型的循环依赖处理手法）：
// 这个常量的「真身」在 utils/toolResultStorage.ts，但**不能直接 import** ——
// 那条依赖链是 utils/toolResultStorage → sessionStorage → utils/messages → services/api/errors，
// 而 api/errors 又会经 promptCacheBreakDetection 绕回本文件，形成环。
// 所以这里内联复制一份，靠一个**单元测试断言两边相等**来防止漂移。
// 权衡：宁可承担「两边可能不同步」的风险（有测试断言兜底），也不要搞出循环依赖 ——
// 后者会在运行时炸掉模块初始化顺序，问题要严重得多。
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'

// 图片和文档的 token 估算统一按 2000 处理：它们的实际 token 取决于分辨率/页数，
// 精确计算代价太高，而估算偏大一点更安全（宁可高估也不要低估 —— 低估会导致上下文撑爆）。
const IMAGE_MAX_TOKEN_SIZE = 2000

// Only compact these tools
// 白名单：只有这些工具的**结果**允许被清理。
// 为什么是白名单而不是黑名单：清错内容的代价很高（模型会以为自己没读过那个文件），
// 所以宁可保守，只挑那些「输出大、时效短」的读类 + 写类工具。
// 用 Set 而不是数组，是因为后面要反复 has() 判断 —— Set.has 是 O(1)，数组 includes 是 O(n)。
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

// --- Cached microcompact state (ant-only, gated by feature('CACHED_MICROCOMPACT')) ---

// Lazy-initialized cached MC module and state to avoid importing in external builds.
// The imports and state live inside feature() checks for dead code elimination.
// 中文补充：这三个变量都声明为模块级可变状态，但它们的**初始化**被刻意推迟到函数内部，
// 并且包在 feature('CACHED_MICROCOMPACT') 判断里 —— 外部构建里这个 feature 是 false，
// 打包时整个代码块（连同动态 import）会被摇掉，于是 cachedMicrocompact.js 这个文件
// 根本不会出现在产物里（它在开源版本里也确实不存在）。
let cachedMCModule: typeof import('./cachedMicrocompact.js') | null = null
let cachedMCState: import('./cachedMicrocompact.js').CachedMCState | null = null
let pendingCacheEdits:
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null = null

/**
 * 惰性加载 cachedMicrocompact 模块（只加载一次，之后复用）。
 *
 * 为什么需要：这个模块在外部构建里**不存在**，所以不能用顶层 import；
 * 另一方面每次 microcompact 都重新 import 一次也很浪费，于是用模块级变量缓存起来。
 *
 * @returns Promise<模块对象>：cachedMCModule 的命名空间（含它导出的所有函数）。
 *
 * 关键步骤：① 若还没有加载过，用动态 import() 加载 ② 存到模块级变量 ③ 返回（下次直接命中缓存）
 *
 * 注意：`await import(...)` 是**动态 import**，返回的是 Promise<typeof import(...)>；
 * ≈ Java 里 Class.forName() 的类型安全版本。
 */
async function getCachedMCModule(): Promise<
  typeof import('./cachedMicrocompact.js')
> {
  if (!cachedMCModule) {
    cachedMCModule = await import('./cachedMicrocompact.js')
  }
  return cachedMCModule
}

/**
 * 确保 cached MC 的状态对象已经创建（惰性初始化），返回它。
 *
 * 为什么需要：状态对象必须由那个模块的工厂函数创建，而模块又是动态加载的，
 * 所以创建时机没法放在模块顶层，只能等到真正要用的时候。
 *
 * @returns 已初始化的 CachedMCState。
 * @throws 若模块还没加载就调用本函数，抛出明确的错误（比留着 undefined 让后面 NPE 好排查）。
 *
 * 关键步骤：① 若状态为空且模块已加载，调模块的工厂函数创建 ② 仍然为空就直接抛错
 *          ③ 返回非空断言后的状态（这里用 if 抛错代替 `!` 非空断言，运行时更安全）
 */
function ensureCachedMCState(): import('./cachedMicrocompact.js').CachedMCState {
  if (!cachedMCState && cachedMCModule) {
    cachedMCState = cachedMCModule.createCachedMCState()
  }
  if (!cachedMCState) {
    throw new Error(
      'cachedMCState not initialized — getCachedMCModule() must be called first',
    )
  }
  return cachedMCState
}

/**
 * Get new pending cache edits to be included in the next API request.
 * Returns null if there are no new pending edits.
 * Clears the pending state (caller must pin them after insertion).
 */
/**
 * 取出**待发送**的 cache_edits 块，并清空暂存位。
 *
 * 为什么需要：edits 是「一次性」的——生成后由 API 层随下一个请求发出，
 * 发完本地就不该再留着（留着会被重复发送）。所以用「读取即清空（consume）」的语义，
 * 保证每一份 edits 只会被消费一次。调用方拿到之后要负责把它 pin 住。
 *
 * @returns 待发送的 edits 块；没有新的就返回 null。
 */
export function consumePendingCacheEdits():
  | import('./cachedMicrocompact.js').CacheEditsBlock
  | null {
  const edits = pendingCacheEdits
  pendingCacheEdits = null
  return edits
}

/**
 * Get all previously-pinned cache edits that must be re-sent at their
 * original positions for cache hits.
 */
/**
 * 取出**所有已固定（pinned）**的 cache_edits 块。
 *
 * 为什么需要：prompt 缓存是按「前缀完全一致」命中的。上一轮发出去的 edits 属于 prefix 的一部分，
 * 下一轮如果不在**完全相同的位置**重发，缓存就会 miss。所以这些 edits 必须被「钉」在原位置反复重发。
 * 这是路径 B 相比路径 A 的核心优势，也是它的核心复杂度。
 *
 * @returns 已固定的 edits 数组（含它们各自对应的 user message 下标）；没有则返回空数组。
 */
export function getPinnedCacheEdits(): import('./cachedMicrocompact.js').PinnedCacheEdits[] {
  if (!cachedMCState) {
    return []
  }
  return cachedMCState.pinnedEdits
}

/**
 * Pin a new cache_edits block to a specific user message position.
 * Called after inserting new edits so they are re-sent in subsequent calls.
 */
/**
 * 把一份新生成的 cache_edits 块**固定**到某个 user 消息的位置上。
 *
 * 为什么需要：见 getPinnedCacheEdits()。块所在的位置是缓存 key 的一部分，
 * 所以必须记住「它插在第几条 user 消息那里」，下次在同样的位置原样重发。
 *
 * @param userMessageIndex edits 所插入的那条 user 消息在数组中的下标。
 * @param block 要固定的 cache_edits 块。
 */
export function pinCacheEdits(
  userMessageIndex: number,
  block: import('./cachedMicrocompact.js').CacheEditsBlock,
): void {
  if (cachedMCState) {
    cachedMCState.pinnedEdits.push({ userMessageIndex, block })
  }
}

/**
 * Marks all registered tools as sent to the API.
 * Called after a successful API response.
 */
/**
 * 在**一次成功的 API 响应之后**调用：把已登记的工具标记为「已发给 API」。
 *
 * 为什么需要：cache_edits 只有在服务端已经缓存了对应内容之后才有意义。
 * 请求成功返回，说明这些内容现在确实进了服务端缓存，
 * 从这一刻起它们才成为「可以被 cache_edit 删除」的候选。
 */
export function markToolsSentToAPIState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.markToolsSentToAPI(cachedMCState)
  }
}

/**
 * 重置 microcompact 的全部本地状态。
 *
 * 什么时候需要：① 任何一次压缩完成（autocompact / 手动 /compact）之后，
 * 历史被重写，本地登记的工具 ID 台账全部作废；
 * ② 路径 A（时间触发）清理了内容之后 —— 服务端缓存已被破坏，
 * 台账再留着会让下一轮的 cached MC 去删一些服务端已经不存在的条目。
 * 由 ./postCompactCleanup.ts 与本文件的路径 A 分别调用。
 */
export function resetMicrocompactState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.resetCachedMCState(cachedMCState)
  }
  pendingCacheEdits = null
}

// Helper to calculate tool result tokens
/**
 * 粗估一个 tool_result 块占多少 token。
 *
 * 为什么需要：是否值得清理某个结果，要看它占多大。而精确 token 数要调 API 才拿得到，
 * 在「每次请求前都要判断一遍」的场景下不能用那么重的方式，所以本地粗估。
 *
 * @param block 单个 tool_result 块。它的 content 可能是字符串，也可能是结构化的块数组。
 * @returns 估算的 token 数。
 *
 * 关键步骤：
 *   ① content 为空直接返回 0
 *   ② content 是字符串：直接估算（最常见的情况）
 *   ③ content 是数组：逐项累加 —— 文本按文本估，图片/文档统一按 2000 计
 *
 * 为什么分三种情况处理：tool_result 的 content 在 API 里本身就是**多态**的，
 * 可以是纯文本，也可以是 [{type:'text'},{type:'image'}] 这样的混合数组。
 * 这里用 typeof / item.type 做**判别联合**的分支处理（≈ Java 的 instanceof + switch 模式匹配）。
 */
function calculateToolResultTokens(block: ToolResultBlockParam): number {
  if (!block.content) {
    return 0
  }

  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content)
  }

  // Array of TextBlockParam | ImageBlockParam | DocumentBlockParam
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') {
      return sum + roughTokenCountEstimation(item.text)
    } else if (item.type === 'image' || item.type === 'document') {
      // Images/documents are approximately 2000 tokens regardless of format
      return sum + IMAGE_MAX_TOKEN_SIZE
    }
    return sum
  }, 0)
}

/**
 * Estimate token count for messages by extracting text content
 * Used for rough token estimation when we don't have accurate API counts
 * Pads estimate by 4/3 to be conservative since we're approximating
 */
/**
 * 估算一整组消息的 token 数。
 *
 * 为什么需要：在没有「上一次 API 响应带回来的准确用量」时（比如会话刚开始、
 * 或者刚做了本地修改还没发请求），需要一个和 getUsage-based 计数口径尽量一致的估算值，
 * 否则像 snip、microcompact 这类依赖 token 计数的压缩判定就会失准。
 *
 * @param messages 要估算的消息数组。
 * @returns 估算 token 数，最后**乘以 4/3 并向上取整**做保守放大（见下面的注释）。
 *
 * 关键步骤：
 *   ① 只遍历 user / assistant 两类消息（其余类型不进 API）
 *   ② 只处理 content 是数组的消息（纯字符串的 content 一律跳过）
 *   ③ 按 block 类型分别估算：text / tool_result / image / document / thinking /
 *      redacted_thinking / tool_use，其余走兜底
 *   ④ 乘以 4/3 做保守放大并返回
 *
 * 注意 thinking 与 tool_use 两处的口径是**刻意模拟** roughTokenCountEstimationForBlock 的：
 * 只数真正被模型 tokenize 的内容（thinking 的正文、tool_use 的 name + input），
 * 不数 JSON 外壳和签名 —— 签名为什么叫 metadata 而不是内容，见原英文注释。
 */
export function estimateMessageTokens(messages: Message[]): number {
  let totalTokens = 0

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }

    if (!Array.isArray(message.message.content)) {
      continue
    }

    for (const block of message.message.content) {
      if (block.type === 'text') {
        totalTokens += roughTokenCountEstimation(block.text)
      } else if (block.type === 'tool_result') {
        totalTokens += calculateToolResultTokens(block)
      } else if (block.type === 'image' || block.type === 'document') {
        totalTokens += IMAGE_MAX_TOKEN_SIZE
      } else if (block.type === 'thinking') {
        // Match roughTokenCountEstimationForBlock: count only the thinking
        // text, not the JSON wrapper or signature (signature is metadata,
        // not model-tokenized content).
        totalTokens += roughTokenCountEstimation(block.thinking)
      } else if (block.type === 'redacted_thinking') {
        totalTokens += roughTokenCountEstimation(block.data)
      } else if (block.type === 'tool_use') {
        // Match roughTokenCountEstimationForBlock: count name + input,
        // not the JSON wrapper or id field.
        totalTokens += roughTokenCountEstimation(
          block.name + jsonStringify(block.input ?? {}),
        )
      } else {
        // server_tool_use, web_search_tool_result, etc.
        totalTokens += roughTokenCountEstimation(jsonStringify(block))
      }
    }
  }

  // Pad estimate by 4/3 to be conservative since we're approximating
  // 乘 4/3（约放大 33%）再向上取整：因为这是**估算**，可能有偏差。
  // 方向必须是「宁可高估」—— 高估最多导致提前一点触发压缩；低估则可能真的撑爆上下文。
  // 注意：TS/JS 里 4 / 3 是浮点除法 = 1.333...；如果按 Java 的习惯写 4 / 3 会得到 1，完全不是一回事。
  return Math.ceil(totalTokens * (4 / 3))
}

/**
 * 待发送的 cache_edits 描述（本层自己的 view，与 API 层要用的块做区分）。
 * 用于把「这次删了哪些工具」这件事传给调用方，让它在 API 响应回来后核对效果。
 */
export type PendingCacheEdits = {
  /** 触发方式。目前只有 'auto'（自动）；留成字面量联合类型是为了以后加 'manual' 时编译器能提醒所有分支。 */
  trigger: 'auto'
  /** 本次请求要删除的 tool_use ID 列表。 */
  deletedToolIds: string[]
  // Baseline cumulative cache_deleted_input_tokens from the previous API response,
  // used to compute the per-operation delta (the API value is sticky/cumulative)
  /**
   * 上一次 API 响应里 cache_deleted_input_tokens 的累计值，用作**基线**。
   * 为什么需要：API 返回的这个数是**累计且粘滞**的（单调递增，不会归零），
   * 想知道「本次操作删掉了多少」，必须拿响应值减去这次操作前的基线，得到增量。
   */
  baselineCacheDeletedTokens: number
}

/**
 * microcompact 的统一返回类型。两条路径都返回它，调用方不用区分走了哪条。
 * - messages：结果消息数组（路径 A 会返回被改写的副本，路径 B 原样返回）
 * - compactionInfo.pendingCacheEdits：有值表示本次生成了 edits，需要 API 层处理
 */
export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
}

/**
 * Walk messages and collect tool_use IDs whose tool name is in
 * COMPACTABLE_TOOLS, in encounter order. Shared by both microcompact paths.
 */
/**
 * 遍历消息，按**出现顺序**收集「工具名在白名单里」的 tool_use ID。
 *
 * 为什么需要：两条路径都需要回答同一个问题——哪些工具结果是可清理的、以及它们的**新旧顺序**。
 * 抽成公共函数可以让两条路径的行为完全一致（不会出现 A 清了某个工具、B 却没清这种诡异差异）。
 *
 * @param messages 历史消息。
 * @returns tool_use 的 ID 数组，**顺序即时间顺序**（越靠后越新，这是后面「保留最近 N 个」的依据）。
 */
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}

// Prefix-match because promptCategory.ts sets the querySource to
// 'repl_main_thread:outputStyle:<style>' when a non-default output style
// is active. The bare 'repl_main_thread' is only used for the default style.
// query.ts:350/1451 use the same startsWith pattern; the pre-existing
// cached-MC `=== 'repl_main_thread'` check was a latent bug — users with a
// non-default output style were silently excluded from cached MC.
/**
 * 判断给定的 querySource 是否属于主线程。
 *
 * 为什么必须用 startsWith 而不是 === （原英文注释讲了一个真实的 bug）：
 * promptCategory.ts 在用户用了非默认 output style 时，会把 querySource 设成
 * 'repl_main_thread:outputStyle:<style>' 这种**带后缀**的形式；
 * 而光秃秃的 'repl_main_thread' 只在默认样式下出现。
 * 旧代码用的是 === 判等，于是这批用户被静默排除在 cached MC 之外——很难发现的隐蔽 bug。
 *
 * @param querySource 查询来源；**undefined 也当作主线程**（为了兼容 cached MC 的既有行为）。
 * @returns true 表示主线程。
 */
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}

/**
 * 【主入口】src/query.ts 的主循环在**每次发请求之前**调用本函数。
 *
 * 为什么需要：这是四级压缩里的第二级，也是最便宜的一级。因为几乎零成本
 * （不调模型、只是字符串替换），所以采取「每轮都试试」的策略，而不是等阈值。
 *
 * @param messages 当前历史消息。
 * @param toolUseContext 工具上下文（用于取当前模型）；可选，取不到就用全局主循环模型兜底。
 * @param querySource 查询来源。用于区分主线程 / fork 代理（见 isMainThreadSource）。
 * @returns Promise<MicrocompactResult>：
 *         .messages —— 处理后的消息（可能被改写，也可能原样返回）
 *         .compactionInfo —— 仅路径 B 会有，表示「本次产生了待发送的 cache_edits」
 *
 * 关键步骤：
 *   ① 清除「警告抑制」标记（新一轮 microcompact 开始，警告该恢复显示了）
 *   ② **先试路径 A**（按时间），触发就直接返回（短路，不再走路径 B）
 *   ③ 再试路径 B（缓存编辑）：需要 feature 打开 + 模型支持 + 主线程，三个条件都满足才走
 *   ④ 都不满足就原样返回 { messages } —— 不压缩也是一种合理结果，
 *      上下文压力交给更重的 autocompact（第四级）去处理
 */
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // Clear suppression flag at start of new microcompact attempt
  // 新一轮 microcompact 开始前先把「抑制警告」标记清掉：
  // 压制只是为了掩盖「刚压缩完但计数还没更新」那段时间的假警报，不能一直压着。
  clearCompactWarningSuppression()

  // Time-based trigger runs first and short-circuits. If the gap since the
  // last assistant message exceeds the threshold, the server cache has expired
  // and the full prefix will be rewritten regardless — so content-clear old
  // tool results now, before the request, to shrink what gets rewritten.
  // Cached MC (cache-editing) is skipped when this fires: editing assumes a
  // warm cache, and we just established it's cold.
  // 路径 A 优先，且**短路**：一旦按时间触发了就直接返回，不再考虑路径 B。
  // 理由：路径 B（cache editing）的前提是「服务端缓存是热的」，
  // 而路径 A 触发本身就说明缓存已经过期（闲置太久），前提不成立了。
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // Only run cached MC for the main thread to prevent forked agents
  // (session_memory, prompt_suggestion, etc.) from registering their
  // tool_results in the global cachedMCState, which would cause the main
  // thread to try deleting tools that don't exist in its own conversation.
  // 路径 B 的三重门禁：
  //   ① feature('CACHED_MICROCOMPACT') —— 编译期开关，外部构建直接跳过（连动态 import 都不会发生）
  //   ② 模型是否支持 cache editing
  //   ③ 是否主线程 —— 关键：cachedMCState 是**模块级**的，fork 出来的子代理与主线程共享；
  //      如果子代理也往里登记自己的工具 ID，主线程就会去删一些「自己会话里根本不存在」的工具。
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // Legacy microcompact path removed — tengu_cache_plum_violet is always true.
  // For contexts where cached microcompact is not available (external builds,
  // non-ant users, unsupported models, sub-agents), no compaction happens here;
  // autocompact handles context pressure instead.
  // 什么都没做。这是正常的：microcompact 是「能压就压」，压不了就交给第四级 autocompact。
  // 明确返回 { messages } 而不是 undefined，调用方可以无脑用返回值继续。
  return { messages }
}

/**
 * Cached microcompact path - uses cache editing API to remove tool results
 * without invalidating the cached prefix.
 *
 * Key differences from regular microcompact:
 * - Does NOT modify local message content (cache_reference and cache_edits are added at API layer)
 * - Uses count-based trigger/keep thresholds from GrowthBook config
 * - Takes precedence over regular microcompact (no disk persistence)
 * - Tracks tool results and queues cache edits for the API layer
 */
/**
 * 【路径 B】缓存编辑式 microcompact：不改动本地消息，只生成一份 cache_edits 交给服务端去删。
 *
 * 与普通（本地改写式）microcompact 的关键差别（对应原英文注释四点）：
 *   ① **不改本地消息内容** —— cache_reference / cache_edits 是在 API 层加的，本地数组保持原样
 *      好处：请求的 prefix 一字未变，服务端 prompt 缓存照常命中
 *   ② 触发与保留都是**按条数**（来自 GrowthBook 配置），而不是按时间
 *   ③ 优先级高于普通 microcompact，且**不做磁盘持久化**
 *   ④ 需要维护一份工具台账，并把 edits 排队交出去
 *
 * @param messages 历史消息（本函数**不会**改写它）。
 * @param querySource 查询来源。
 * @returns MicrocompactResult：messages 原样返回；若产生了 edits 则附带 compactionInfo。
 *
 * 关键步骤：
 *   ① 加载模块 / 建好状态 / 读配置
 *   ② 第一遍：收集所有可压缩工具的 ID
 *   ③ 第二遍：按 user 消息分组，把尚未登记过的 tool_result 登记进台账
 *   ④ 问模块「按当前阈值，有哪些工具该删了」
 *   ⑤ 有要删的：生成 cache_edits 块 → 暂存 → 打点 → 抑制警告 → 通知缓存监控
 *   ⑥ 记录本次的 cache_deleted_input_tokens 基线（用于事后算增量）
 *   ⑦ 返回（消息数组原封不动）
 */
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()
  const config = mod.getCachedMCConfig()

  // 先转成 Set：下面第二个循环里每条 tool_result 都要查一次「这个 ID 是否可压缩」，
  // Set.has 是 O(1)，如果留着数组用 includes 就是 O(n²)。
  const compactableToolIds = new Set(collectCompactableToolIds(messages))
  // Second pass: register tool results grouped by user message
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      const groupIds: string[] = []
      for (const block of message.message.content) {
        if (
          block.type === 'tool_result' &&
          compactableToolIds.has(block.tool_use_id) &&
          !state.registeredTools.has(block.tool_use_id)
        ) {
          mod.registerToolResult(state, block.tool_use_id)
          groupIds.push(block.tool_use_id)
        }
      }
      mod.registerToolMessage(state, groupIds)
    }
  }

  // 把「该删谁」的决策完全交给专用模块：阈值、保留最近 N 条、排序这些策略都在那边，
  // 本文件只负责调度与副作用（打点、通知、状态维护）。职责分离让策略可以单独改。
  const toolsToDelete = mod.getToolResultsToDelete(state)

  if (toolsToDelete.length > 0) {
    // Create and queue the cache_edits block for the API layer
  // 生成的 edits 不是立刻用掉：先存到 pendingCacheEdits，
  // 等 API 层组装下一个请求时再 consume（consume 会清空暂存位，保证只发一次）。
    const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
    if (cacheEdits) {
      pendingCacheEdits = cacheEdits
    }

    logForDebugging(
      `Cached MC deleting ${toolsToDelete.length} tool(s): ${toolsToDelete.join(', ')}`,
    )

    // Log the event
    logEvent('tengu_cached_microcompact', {
      toolsDeleted: toolsToDelete.length,
      deletedToolIds: toolsToDelete.join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      activeToolCount: state.toolOrder.length - state.deletedRefs.size,
      triggerType:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      threshold: config.triggerThreshold,
      keepRecent: config.keepRecent,
    })

    // Suppress warning after successful compaction
    suppressCompactWarning()

    // Notify cache break detection that cache reads will legitimately drop
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      // Pass the actual querySource — isMainThreadSource now prefix-matches
      // so output-style variants enter here, and getTrackingKey keys on the
      // full source string, not the 'repl_main_thread' prefix.
      notifyCacheDeletion(querySource ?? 'repl_main_thread')
    }

    // Return messages unchanged - cache_reference and cache_edits are added at API layer
    // Boundary message is deferred until after API response so we can use
    // actual cache_deleted_input_tokens from the API instead of client-side estimates
    // Capture the baseline cumulative cache_deleted_input_tokens from the last
    // assistant message so we can compute a per-operation delta after the API call
  // findLast = 倒序找第一个满足条件的元素（Java 没有内建对应方法，要自己倒着遍历）。
  //
  // 为什么要取「上一次响应的累计已删 token」作基线：API 返回的
  // cache_deleted_input_tokens 是**累计值**（单调递增、不会归零），
  // 拿响应值减掉这个基线，才能得到「本次操作实际删了多少」的增量。
  // (`as unknown as Record<...>` 是双重类型断言 —— SDK 的类型定义里没声明这个字段，
  //  但运行时的 usage 对象上确实有，所以先转成 unknown 再转成目标类型绕开编译检查。)
    const lastAsst = messages.findLast(m => m.type === 'assistant')
    const baseline =
      lastAsst?.type === 'assistant'
        ? ((
            lastAsst.message.usage as unknown as Record<
              string,
              number | undefined
            >
          )?.cache_deleted_input_tokens ?? 0)
        : 0

    return {
      messages,
      compactionInfo: {
        pendingCacheEdits: {
          trigger: 'auto',
          deletedToolIds: toolsToDelete,
          baselineCacheDeletedTokens: baseline,
        },
      },
    }
  }

  // No compaction needed, return messages unchanged
  return { messages }
}

/**
 * Time-based microcompact: when the gap since the last main-loop assistant
 * message exceeds the configured threshold, content-clear all but the most
 * recent N compactable tool results.
 *
 * Returns null when the trigger doesn't fire (disabled, wrong source, gap
 * under threshold, nothing to clear) — caller falls through to other paths.
 *
 * Unlike cached MC, this mutates message content directly. The cache is cold,
 * so there's no cached prefix to preserve via cache_edits.
 */
/**
 * Check whether the time-based trigger should fire for this request.
 *
 * Returns the measured gap (minutes since last assistant message) when the
 * trigger fires, or null when it doesn't (disabled, wrong source, under
 * threshold, no prior assistant, unparseable timestamp).
 *
 * Extracted so other pre-request paths (e.g. snip force-apply) can consult
 * the same predicate without coupling to the tool-result clearing action.
 */
/**
 * 判断「按时间触发」这一条件当前是否成立。
 *
 * 为什么单独抽成函数（原英文注释）：这个判定还有别的调用方——
 * snip 的 force-apply 之类的「发请求前的其他路径」也需要知道「现在是否处于长闲置之后」，
 * 但它们并不需要真的去清理工具结果。把判定与动作分开，两边就不用互相耦合。
 *
 * @param messages 历史消息（用来找最后一条助手消息的时间戳）。
 * @param querySource 查询来源。这里**要求显式传入**主线程来源，
 *        不像 isMainThreadSource() 那样把 undefined 当作主线程 ——
 *        因为 /context、/compact、analyzeContext 这些调用方会不带 source 地调用
 *        microcompactMessages()，它们只是想**看看**结果，不应该真的触发清理。
 * @returns { gapMinutes, config } 表示触发；null 表示不触发
 *         （功能未启用 / 来源不对 / 间隔没到阈值 / 没有助手消息 / 时间戳无法解析）。
 *
 * 关键步骤：
 *   ① 读远程配置；检查 enabled 与来源
 *   ② 找到最后一条助手消息，取它的时间戳
 *   ③ 算与当前时间的间隔（分钟）
 *   ④ 用 Number.isFinite 排除 NaN / Infinity（时间戳解析失败会得到 NaN），再与阈值比较
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  // Require an explicit main-thread querySource. isMainThreadSource treats
  // undefined as main-thread (for cached-MC backward-compat), but several
  // callers (/context, /compact, analyzeContext) invoke microcompactMessages
  // without a source for analysis-only purposes — they should not trigger.
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
  // 单位换算：毫秒 ÷ 60_000 = 分钟。（60_000 是 60*1000 的分隔符写法，可读性更好。）
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  // 为什么先判 Number.isFinite：new Date(坏字符串).getTime() 得到 NaN，
  // 而 NaN 参与任何比较都是 false —— 如果不拦住它，后面的 `gapMinutes < 阈值` 会
  // 意外地判定为「没到阈值」从而返回 null（碰巧也是我们要的行为），
  // 但如果以后阈值判断方向改了，NaN 就会悄悄穿透出去。显式判断更安全。
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}

/**
 * 【路径 A】按时间触发的 microcompact：闲置太久（默认 1 小时）后，
 * 把除最近 N 个之外的可压缩工具结果**内容清空**（原地替换成一句占位符）。
 *
 * 与路径 B 的本质差别：**它直接修改消息内容**。
 * 为什么这时候可以这么干：走到这里说明服务端缓存已经过期（见原英文注释），
 * 这次请求本来就要把整段 prefix 重写一遍，改了内容也不会损失什么缓存。
 *
 * @param messages 历史消息（不会被就地修改，返回的是新数组 + 新对象）。
 * @param querySource 查询来源。
 * @returns MicrocompactResult 表示已清理；null 表示未触发（调用方继续走路径 B）。
 *
 * 关键步骤：
 *   ① 询问 evaluateTimeBasedTrigger()，没触发就返回 null
 *   ② 收集所有可压缩工具 ID（按时间顺序），末尾 N 个保留、其余进入待清理集合
 *   ③ 遍历消息，用 map 生成**新的**消息数组（不可变更新），把命中的 tool_result 内容替换成占位符
 *   ④ 累加省下的 token；一点都没省到就当作没触发（返回 null）
 *   ⑤ 打点、抑制警告、重置 cached MC 台账、通知缓存监控
 *   ⑥ 返回新消息数组
 */
function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)

  // Floor at 1: slice(-0) returns the full array (paradoxically keeps
  // everything), and clearing ALL results leaves the model with zero working
  // context. Neither degenerate is sensible — always keep at least the last.
  // Math.max(1, ...) 保证至少保留 1 个。原英文注释点出了两个坑：
  //   ① `slice(-0)` 会**返回整个数组**（0 和 -0 在这被当成同一回事），等于一个都不删，行为反直觉
  //   ② 把结果全清了，模型就没有任何可参考的工作上下文了
  // 两种退化都没意义，所以强制保底留 1 个。
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return null
  }

  let tokensSaved = 0
  // 注意这里是 map 生成**新数组**，并且命中时才创建新对象，没命中的分支复用原对象。
  // 这是 TS/JS 里不可变更新的标准套路：不动共享数据，避免别处持有同一份消息时看到不一致。
  const result: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    let touched = false
    const newContent = message.message.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        tokensSaved += calculateToolResultTokens(block)
        touched = true
        // `{ ...block, content: X }` 展开更新：复制原块的所有字段，只覆盖 content。
        // ≈ Java record 的 wither / Builder.toBuilder()，但这是语言级语法。
        // 千万不要写成 `block.content = X` —— 那样会就地修改被多方共享的对象。
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
    if (!touched) return message
    return {
      ...message,
      message: { ...message.message, content: newContent },
    }
  })

  // 一点 token 都没省到（比如全是本就为空的工具结果），就当作没触发：
  // 返回 null 让调用方继续尝试路径 B，而不是带着一个「假成功」返回。
  if (tokensSaved === 0) {
    return null
  }

  logEvent('tengu_time_based_microcompact', {
    gapMinutes: Math.round(gapMinutes),
    gapThresholdMinutes: config.gapThresholdMinutes,
    toolsCleared: clearSet.size,
    toolsKept: keepSet.size,
    keepRecent: config.keepRecent,
    tokensSaved,
  })

  logForDebugging(
    `[TIME-BASED MC] gap ${Math.round(gapMinutes)}min > ${config.gapThresholdMinutes}min, cleared ${clearSet.size} tool results (~${tokensSaved} tokens), kept last ${keepSet.size}`,
  )

  // 与 compactWarningState 配套：清理刚做完，本地计数还不准，先把「context 快满了」的警告压住，
  // 等下一次 API 响应带回准确数字再恢复显示。
  suppressCompactWarning()
  // Cached-MC state (module-level) holds tool IDs registered on prior turns.
  // We just content-cleared some of those tools AND invalidated the server
  // cache by changing prompt content. If cached-MC runs next turn with the
  // stale state, it would try to cache_edit tools whose server-side entries
  // no longer exist. Reset it.
  // 中文补充上面那段英文（很关键的一致性推理）：
  // cached-MC 的台账是**模块级**的，里面记着前几轮登记过的工具 ID。
  // 而路径 A 刚刚做了两件事：① 把其中一些工具的内容清空了 ② 因为改了 prompt 内容，服务端缓存已失效。
  // 如果下一轮路径 B 拿着这份过期台账去干活，就会尝试 cache_edit 一些
  // 「服务端已经不存在的缓存条目」，白白浪费、甚至出错。所以必须重置。
  resetMicrocompactState()
  // We just changed the prompt content — the next response's cache read will
  // be low, but that's us, not a break. Tell the detector to expect a drop.
  // notifyCacheDeletion (not notifyCompaction) because it's already imported
  // here and achieves the same false-positive suppression — adding the second
  // symbol to the import was flagged by the circular-deps check.
  // Pass the actual querySource: getTrackingKey returns the full source string
  // (e.g. 'repl_main_thread:outputStyle:custom'), not just the prefix.
  // 中文补充：我们刚改了 prompt 内容，下一次响应里的 cache read 必然偏低 ——
  // 但这是**我们自己**造成的，不是缓存被打断了。所以要主动通知检测器，避免误报。
  // （这里用 notifyCacheDeletion 而不是语义更贴切的 notifyCompaction，
  //   是因为前者本文件已经 import 了，多引入一个符号会触发循环依赖检查。）
  if (feature('PROMPT_CACHE_BREAK_DETECTION') && querySource) {
    notifyCacheDeletion(querySource)
  }

  return { messages: result }
}
