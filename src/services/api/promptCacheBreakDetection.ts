/**
 * 【一句话定位】★ prompt 缓存失效（cache break）探测器：当「读缓存的 token 数」突然下跌时，
 *           自动分析出**是谁把缓存弄失效的**（system prompt 变了？工具变了？模型换了？还是 TTL 到期？）。
 *
 * 【在架构中的位置】
 *   调用链：src/services/api/claude.ts（发请求前 / 收到响应后）
 *           → 本文件 recordPromptState(snapshot)   ← 阶段一：请求**前**记录快照
 *           → 本文件 checkResponseForCacheBreak(...) ← 阶段二：响应**后**判定并上报
 *             → ../analytics/index.js（logEvent 上报 tengu_prompt_cache_break 事件）
 *             → writeCacheBreakDiff() → 生成 .diff 文件落到临时目录（内部排障用）
 *   旁路调用：
 *     - notifyCacheDeletion()：cached microcompact 主动删缓存后调用（告知「这次下跌是正常的」）
 *     - notifyCompaction()：压缩上下文后调用（消息数变少，缓存读必然下降，重置基线）
 *     - cleanupAgentTracking() / resetPromptCacheBreakDetection()：清理跟踪状态
 *
 * 【★ 为什么 prompt 缓存失效会「烧钱」——这是理解本文件的关键】
 *   Anthropic 的 prompt 缓存是**前缀缓存**：服务端把请求里「从头开始的一段连续前缀」
 *   缓存下来，下次请求只要前缀完全一致，就能直接复用。计价大致是：
 *     · cache_read（命中缓存）：约常规输入单价的 1/10  ← 最便宜
 *     · input（没命中，重新算）：全额单价
 *     · cache_creation（首次写入缓存）：约常规单价的 1.25 倍 ← 最贵
 *   一个 Claude Code 的会话里，system prompt + 全部工具的 schema 加起来动辄几万 token，
 *   每轮请求都要带上去。如果缓存命中，这几万 token 按 1/10 计价；
 *   一旦缓存失效，就要**重新按全价付一遍**，而且下一轮还要再付一次 1.25 倍的写入费。
 *   在长时间会话里，一次失效的代价可能被放大几十倍 —— 这就是「烧钱」。
 *   更隐蔽的是：很多改动**看起来**无害（比如往工具 description 里塞了一句动态生成的
 *    agent 列表），但只要让前缀里任何一个字节变了，从那个位置往后的**所有**内容都会
 *   全部失效。所以才需要这个文件去自动定位「到底是谁动了一下」。
 *
 * 【两段式设计的原因】
 *   为什么不在请求前就判断「我要改变缓存了」？因为**改了不代表真的失效**——
 *   服务端可能有别的策略。真正可靠的信号只有响应里的 cache_read_input_tokens。
 *   所以：阶段一只记录「这次跟上次比，哪些东西变了」（pendingChanges），
 *   阶段二看到「cache read 真的掉下来了」才拿这些变化去解释原因并上报。
 *
 * 【本文件包含什么】
 *   - PreviousState / PendingChanges：上一次的快照 与 本次检测到的变化。
 *   - previousStateBySource：模块级 Map（按 source/agentId 隔离跟踪状态）。
 *   - MAX_TRACKED_SOURCES / TRACKED_SOURCE_PREFIXES：跟踪数量上限与白名单前缀。
 *   - MIN_CACHE_MISS_TOKENS / CACHE_TTL_5MIN_MS / CACHE_TTL_1HOUR_MS：判定阈值。
 *   - isExcludedModel() / getTrackingKey()：排除模型与跟踪键计算。
 *   - stripCacheControl() / computeHash() / sanitizeToolName() / computePerToolHashes() /
 *     getSystemCharCount() / buildDiffableContent()：各种辅助计算。
 *   - PromptStateSnapshot：对外暴露的快照入参类型。
 *   - recordPromptState()：★ 阶段一（请求前）。
 *   - checkResponseForCacheBreak()：★ 阶段二（响应后）。
 *   - notifyCacheDeletion() / notifyCompaction() / cleanupAgentTracking() /
 *     resetPromptCacheBreakDetection()：状态维护。
 *   - writeCacheBreakDiff()：生成 diff 文件。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `const { a, b = 默认值, c = [] } = snapshot`：★ 解构时**带默认值**。
 *      `b = 默认值` 表示 b 为 undefined 时用默认值（注意：null 不会触发默认值，只有 undefined 会）。
 *      Java 里要写一堆 `x == null ? default : x`，或者 Optional.ofNullable。
 *      本文件大量使用这种写法，因为快照字段全是可选的。
 *   2. `const { cache_control: _, ...rest } = item`：★ 解构时**改名** + 剩余属性。
 *      把 cache_control 取出来丢到 `_`（约定表示不使用），其余打包成 rest。
 *      效果：「不可变地删掉一个字段」。用途：算哈希时要排除掉 cache_control，
 *      因为它是「缓存控制标记」而不是「提示词内容」，不该影响内容哈希。
 *   3. `type PreviousState = { ... }` 里的 `buildDiffableContent: () => string`：
 *      ★ 类型里可以声明一个**函数字段**。Java 类比：接口里有个返回 String 的方法。
 *      这里存的是一个「懒计算」的闭包——见第 4 条。
 *   4. `const lazyDiffableContent = () => buildDiffableContent(...)`：
 *      ★ **惰性求值**。真正的 buildDiffableContent 要把整个 system prompt + 所有工具
 *      schema 序列化成字符串（300KB+，很慢）。这里只存一个「怎么算」的函数，
 *      只有真正确认发生了 cache break 时才调用它。这是本文件最重要的性能优化。
 *      Java 类比：Supplier<String>（Guava 的 Suppliers.memoize 那种思路）。
 *   5. `const computeToolHashes = () => computePerToolHashes(...)`：同样是惰性函数，
 *      注释里说明：只有在「工具集合整体变了」时才真的去算每个工具的哈希，
 *      常见情况（工具没变）就能省掉 N 次 jsonStringify。
 *   6. `2_000`：★ 数字字面量的下划线分隔符（千分位）。纯粹为了可读性，等价于 2000。
 *      Java 也支持这个语法（Java 7+）。
 *   7. `typeof Bun !== 'undefined'`：★ 运行时**特性探测**。
 *      Bun 是一个 JS 运行时（本项目的 CLI 跑在 Bun 上），但也可能被 npm 全局安装到
 *      Node 上跑。这里检查全局有没有 Bun 变量来决定用哪个哈希实现。
 *      Java 类比：Class.forName 检查某个类在不在 classpath 上。
 *   8. `typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash`：
 *      - `bigint` 是 JS 的**任意精度整数**类型（字面量后缀 n），Java 对应 BigInteger；
 *      - `& 0xffffffffn` 取低 32 位（位运算），再转成普通 number。
 *      - 为什么？Bun.hash 对大输入会返回 bigint，而这里只需要一个 number 做比较。
 *      注释里明说这是为了「安全转换」。
 *   9. `readonly string[]`：`readonly` 修饰数组表示「不允许修改」，
 *      编译期禁止 push/splice。≈ Java 的不可变 List（List.of / Collections.unmodifiableList）。
 *  10. `sortedBetas.some((b, i) => b !== prev.betas[i])`：
 *      `some` ≈ Java Stream.anyMatch。配合索引 i 做逐项比较（两个数组是否完全相同）。
 *  11. `logs.findLast(...)` / `messages.findLast(...)`：从后往前找（ES2023 方法）。
 *  12. `changes?.systemPromptChanged ?? false`：
 *      ★ `?.`（可选链）+ `??`（空值兜底）组合，是本项目最常见的「安全地取一个可能不存在的字段」写法。
 *      Java：changes == null ? false : changes.isSystemPromptChanged()。
 *  13. `parts.push(\`...${x}...\`)`：模板字符串 + 数组 push。Java 的 list.add(String.format(...))。
 *  14. `catch (e: unknown)`：显式标注 catch 变量类型为 unknown（TS 允许），
 *      逼着自己不要假设它是 Error。
 *  15. `while (previousStateBySource.size >= MAX_TRACKED_SOURCES) { ...delete(oldest) }`：
 *      ★ 简单的 FIFO 淘汰。JS 的 Map **保持插入顺序**，所以 `keys().next().value` 就是最早插入的。
 *      Java 的 LinkedHashMap 也有这个特性（HashMap 没有）。
 *  16. `as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`：
 *      一个长得夸张的类型名，作用是**人工标记**「这个值我已经确认过不是代码/文件路径」，
 *      防止把用户的文件路径误当字符串上报到分析系统（隐私合规）。
 *      它本质上只是 string 的别名，靠命名来提醒调用方。
 *  17. `const chars = 'abc...'; chars[Math.floor(Math.random() * chars.length)]`：
 *      随机取一个字符（生成随机文件名后缀）。注意字符串也能用下标访问。
 */
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createPatch } from 'diff'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AgentId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import { djb2Hash } from 'src/utils/hash.js'
import { logError } from 'src/utils/log.js'
import { getClaudeTempDir } from 'src/utils/permissions/filesystem.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { QuerySource } from '../../constants/querySource.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

// 生成一个带随机后缀的 diff 文件路径。用随机后缀是为了避免并发的 subagent
// 写同一个文件名互相覆盖。
function getCacheBreakDiffPath(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return join(getClaudeTempDir(), `cache-break-${suffix}.diff`)
}

// ★ 上一次请求的「完整快照」。每个字段都对应一个可能导致缓存失效的维度。
// 存哈希而不是存原文，是因为原文（system prompt + 工具 schema）有几百 KB，
// 全存下来内存会爆——所以只存数字指纹，原文用惰性函数（见 buildDiffableContent）按需生成。
type PreviousState = {
  systemHash: number
  toolsHash: number
// cacheControlHash：对**带** cache_control 的 system blocks 算哈希。
// 为什么要单独一份？因为 systemHash 是把 cache_control 剥掉后算的（内容哈希），
// 而 cache_control 本身（比如作用域从 global 变成 org、TTL 从 1h 变成 5m）
// 也会改变服务端的缓存键，但**文本内容完全没变**，只有这一份哈希能捕获到。
// 这是本文件里非常精细的一个设计点。
  /** Hash of system blocks WITH cache_control intact. Catches scope/TTL flips
   *  (global↔org, 1h↔5m) that stripCacheControl erases from systemHash. */
  cacheControlHash: number
  toolNames: string[]
// perToolHashes：每个工具**单独**一个哈希。
// 用途：当「工具变了」但工具数量没增减时（注释里说这占 tool 类失效的 77%），
// 光看总数看不出是哪个工具，必须逐个比对才能点名。
// 典型元凶：AgentTool / SkillTool 会把**动态生成的** agent 列表、命令列表
// 嵌进自己的 description 里 —— 列表一变，前缀就断了。
  /** Per-tool schema hash. Diffed to name which tool's description changed
   *  when toolSchemasChanged but added=removed=0 (77% of tool breaks per
   *  BQ 2026-03-22). AgentTool/SkillTool embed dynamic agent/command lists. */
  perToolHashes: Record<string, number>
  systemCharCount: number
  model: string
  fastMode: boolean
// globalCacheStrategy：全局缓存策略（tool_based / system_prompt / none）。
// 会在 MCP 工具被发现或移除时切换。
  /** 'tool_based' | 'system_prompt' | 'none' — flips when MCP tools are
   *  discovered/removed. */
  globalCacheStrategy: string
// betas：beta 请求头列表（排好序）。服务端会把 beta 头纳入缓存键，加减都会失效。
  /** Sorted beta header list. Diffed to show which headers were added/removed. */
  betas: string[]
// ★ 注意下面三个字段的注释都说「should NOT break cache anymore」——
// 意思是：这些曾经会导致缓存失效，现在通过「粘滞（sticky/latch）」修好了
// （在 claude.ts 里一旦开启就不再关闭），但仍然继续跟踪，用来**验证修复是否真的生效**。
// 这是很好的工程习惯：修完之后保留埋点持续观测。
  /** AFK_MODE_BETA_HEADER presence — should NOT break cache anymore
   *  (sticky-on latched in claude.ts). Tracked to verify the fix. */
  autoModeActive: boolean
  /** Overage state flip — should NOT break cache anymore (eligibility is
   *  latched session-stable in should1hCacheTTL). Tracked to verify the fix. */
  isUsingOverage: boolean
  /** Cache-editing beta header presence — should NOT break cache anymore
   *  (sticky-on latched in claude.ts). Tracked to verify the fix. */
  cachedMCEnabled: boolean
// effortValue：推理强度档位，会被塞进 output_config 或 anthropic_internal，
// 同样影响服务端缓存键。
  /** Resolved effort (env → options → model default). Goes into output_config
   *  or anthropic_internal.effort_override. */
  effortValue: string
// extraBodyHash：getExtraBodyParams() 的整体哈希（比如 CLAUDE_CODE_EXTRA_BODY 配的额外参数）。
  /** Hash of getExtraBodyParams() — catches CLAUDE_CODE_EXTRA_BODY and
   *  anthropic_internal changes. */
  extraBodyHash: number
  callCount: number
  pendingChanges: PendingChanges | null
  prevCacheReadTokens: number | null
  /** Set when cached microcompact sends cache_edits deletions. Cache reads
   *  will legitimately drop — this is expected, not a break. */
  cacheDeletionsPending: boolean
// ★ 惰性函数字段（不是字符串！）。存「怎么生成 diff 文本」而不是「diff 文本本身」，
// 因为生成一次要序列化几百 KB，太贵了，只在真出问题时才调用。
  buildDiffableContent: () => string
}

// 阶段一检测出来的「这次变了什么」，留给阶段二去解释原因。
type PendingChanges = {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMCChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  prevEffortValue: string
  newEffortValue: string
  buildPrevDiffableContent: () => string
}

// 模块级跟踪表。key 是 source（或 agentId），实现不同来源之间的状态隔离。
const previousStateBySource = new Map<string, PreviousState>()

// ★ 为什么要限制数量？注释说得很实在：每个条目里存着一份 300KB+ 的可序列化内容函数，
// 而 subagent 每次生成**新的 agentId**，不设上限的话内存会无限涨。
// 这是「用 Map 做缓存」时必须考虑的内存泄漏风险。
// Cap the number of tracked sources to prevent unbounded memory growth.
// Each entry stores a ~300KB+ diffableContent string (serialized system prompt
// + tool schemas). Without a cap, spawning many subagents (each with a unique
// agentId key) causes the map to grow indefinitely.
const MAX_TRACKED_SOURCES = 10

// 只有这几类来源值得跟踪。
const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]

// ★ 判定阈值：缓存读取下跌至少 2000 token 才报警。
// 为什么要有绝对值门槛？因为小额波动（几千 token 以内）属于正常抖动，
// 全都报警的话信噪比太低，没人看得过来。
// Minimum absolute token drop required to trigger a cache break warning.
// Small drops (e.g., a few thousand tokens) can happen due to normal variation
// and aren't worth alerting on.
const MIN_CACHE_MISS_TOKENS = 2_000

// 服务端的缓存 TTL 有两档：5 分钟 和 1 小时。
// 超过对应时长没有请求，缓存自然过期——这种失效**不是我们的 bug**，
// 所以要在报告里区分「我们改了东西」和「纯粹是时间到了」。
// Anthropic's server-side prompt cache TTL thresholds to test.
// Cache breaks after these durations are likely due to TTL expiration
// rather than client-side changes.
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000

// Models to exclude from cache break detection (e.g., haiku has different caching behavior)
// haiku 的缓存行为跟其它模型不同，排除掉以免产生误报。
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}

/**
 * Returns the tracking key for a querySource, or null if untracked.
 * Compact shares the same server-side cache as repl_main_thread
 * (same cacheSafeParams), so they share tracking state.
 *
 * For subagents with a tracked querySource, uses the unique agentId to
 * isolate tracking state. This prevents false positive cache break
 * notifications when multiple instances of the same agent type run
 * concurrently.
 *
 * Untracked sources (speculation, session_memory, prompt_suggestion, etc.)
 * are short-lived forked agents where cache break detection provides no
 * value — they run 1-3 turns with a fresh agentId each time, so there's
 * nothing meaningful to compare against. Their cache metrics are still
 * logged via tengu_api_success for analytics.
 */
// ★ 计算跟踪键（同时决定「这个来源值不值得跟踪」）。
// 三条规则：
//   ①compact 与 repl_main_thread 共用同一个键 —— 因为它们用相同的 cacheSafeParams，
//     服务端的缓存是同一份，分开跟踪反而会误报；
//   ②被跟踪的 subagent 用**唯一 agentId** 做键 —— 否则同一类型的多个 agent 并发跑时
//     会互相干扰，产生假阳性；
//   ③不在白名单里的来源（speculation / session_memory 等）直接返回 null 不跟踪 ——
//     它们是短命的派生 agent，每次都是新的 agentId，没有可比的历史，跟踪没意义。
function getTrackingKey(
  querySource: QuerySource,
  agentId?: AgentId,
): string | null {
  if (querySource === 'compact') return 'repl_main_thread'
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    if (querySource.startsWith(prefix)) return agentId || querySource
  }
  return null
}

// ★ 剥掉 cache_control 字段后返回新数组（不可变）。
// `const { cache_control: _, ...rest } = item` —— 解构改名 + 剩余属性，
// 是「删掉一个字段」的标准写法。`_` 是约定俗成的「我不用的变量」。
function stripCacheControl(
  items: ReadonlyArray<Record<string, unknown>>,
): unknown[] {
  return items.map(item => {
    if (!('cache_control' in item)) return item
    const { cache_control: _, ...rest } = item
    return rest
  })
}

// 算哈希。优先用 Bun 内置的高速哈希，没有 Bun（Node 环境）就退回 djb2。
function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined') {
    const hash = Bun.hash(str)
// ★ bigint 处理：Bun.hash 对大输入会返回 bigint（任意精度整数），
// 这里与 0xffffffffn 做按位与取低 32 位，再转成 number。
// 注意 0xffffffffn 的 n 后缀表示 bigint 字面量（Java：BigInteger）。
    // Bun.hash can return bigint for large inputs; convert to number safely
    return typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash
  }
  // Fallback for non-Bun runtimes (e.g. Node.js via npm global install)
  return djb2Hash(str)
}

/** MCP tool names are user-controlled (server config) and may leak filepaths.
 *  Collapse them to 'mcp'; built-in names are a fixed vocabulary. */
// ★ 脱敏：MCP 工具名是**用户在配置里自己写的**，可能包含文件路径等敏感信息。
// 上报到分析系统之前统一折叠成 'mcp'。内置工具名是固定的词表，可以安全上报。
// 这是隐私合规（不泄露用户数据）的典型做法。
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

// 逐工具算哈希，返回 { 工具名: 哈希 }。
function computePerToolHashes(
  strippedTools: ReadonlyArray<unknown>,
  names: string[],
): Record<string, number> {
  const hashes: Record<string, number> = {}
  for (let i = 0; i < strippedTools.length; i++) {
// `names[i] ?? `__idx_${i}``：工具没有 name 字段时用下标兜底当 key。
    hashes[names[i] ?? `__idx_${i}`] = computeHash(strippedTools[i])
  }
  return hashes
}

function getSystemCharCount(system: TextBlockParam[]): number {
  let total = 0
  for (const block of system) {
    total += block.text.length
  }
  return total
}

// 把 system prompt 和所有工具 schema 拼成一个**人类可读**的大字符串，
// 供 diff 用。注意工具部分先 sort 再 join —— 排序是为了让 diff 稳定，
// 不会因为工具顺序变化而产生一堆噪音差异。
function buildDiffableContent(
  system: TextBlockParam[],
  tools: BetaToolUnion[],
  model: string,
): string {
  const systemText = system.map(b => b.text).join('\n\n')
  const toolDetails = tools
    .map(t => {
      if (!('name' in t)) return 'unknown'
      const desc = 'description' in t ? t.description : ''
      const schema = 'input_schema' in t ? jsonStringify(t.input_schema) : ''
      return `${t.name}\n  description: ${desc}\n  input_schema: ${schema}`
    })
    .sort()
    .join('\n\n')
  return `Model: ${model}\n\n=== System Prompt ===\n\n${systemText}\n\n=== Tools (${tools.length}) ===\n\n${toolDetails}\n`
}

// ★ 快照入参类型。注释里说得很清楚：所有字段都是可选的，
// 是为了让调用方可以**逐步**加字段（undefined 的字段在比较时视为「没变」）。
// 这是一个很务实的兼容性设计：新增一个检测维度时，老调用点不用改。
/** Extended tracking snapshot — everything that could affect the server-side
 *  cache key that we can observe from the client. All fields are optional so
 *  the call site can add incrementally; undefined fields compare as stable. */
export type PromptStateSnapshot = {
  system: TextBlockParam[]
  toolSchemas: BetaToolUnion[]
  querySource: QuerySource
  model: string
  agentId?: AgentId
  fastMode?: boolean
  globalCacheStrategy?: string
  betas?: readonly string[]
  autoModeActive?: boolean
  isUsingOverage?: boolean
  cachedMCEnabled?: boolean
  effortValue?: string | number
  extraBodyParams?: unknown
}

/**
 * Phase 1 (pre-call): Record the current prompt/tool state and detect what changed.
 * Does NOT fire events — just stores pending changes for phase 2 to use.
 */
// ★【阶段一：请求发出之前调用】记录本次的 prompt 状态，并算出「跟上次比变了什么」。
// 注意它**不发分析事件**（原注释特别强调）——因为这时候还不知道缓存到底有没有真的失效，
// 变化只是「嫌疑」，要等阶段二看到 cache read 下跌才算坐实。
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
// ★ 一大串带默认值的解构：snapshot 里没给的字段就用默认值兜上。
// 这是「可选字段」在 TS 里的标准处理姿势。
    const {
      system,
      toolSchemas,
      querySource,
      model,
      agentId,
      fastMode,
      globalCacheStrategy = '',
      betas = [],
      autoModeActive = false,
      isUsingOverage = false,
      cachedMCEnabled = false,
      effortValue,
      extraBodyParams,
    } = snapshot
// 取跟踪键；返回 null 表示这个来源不跟踪，直接返回（省掉后面所有计算）。
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

// 剥掉 cache_control 再算哈希：得到「纯内容」的指纹。
// `as unknown as ReadonlyArray<Record<string, unknown>>` 是双重断言——
// SDK 的具体类型跟这里要的「任意对象数组」差异太大，只能先转成 unknown 再转过去。
    const strippedSystem = stripCacheControl(
      system as unknown as ReadonlyArray<Record<string, unknown>>,
    )
    const strippedTools = stripCacheControl(
      toolSchemas as unknown as ReadonlyArray<Record<string, unknown>>,
    )

    const systemHash = computeHash(strippedSystem)
    const toolsHash = computeHash(strippedTools)
    // Hash the full system array INCLUDING cache_control — this catches
    // scope flips (global↔org/none) and TTL flips (1h↔5m) that the stripped
    // hash can't see because the text content is identical.
// ★ 另一份哈希：只取每个 block 的 cache_control 字段来算。
// 这样就能捕获「内容一字未改，但缓存作用域/TTL 变了」这类隐形失效。
    const cacheControlHash = computeHash(
      system.map(b => ('cache_control' in b ? b.cache_control : null)),
    )
    const toolNames = toolSchemas.map(t => ('name' in t ? t.name : 'unknown'))
    // Only compute per-tool hashes when the aggregate changed — common case
    // (tools unchanged) skips N extra jsonStringify calls.
// ★ 惰性函数：只有当「工具集合确实变了」时才真的去算每个工具的哈希。
// 常见情况（工具没变）能省掉 N 次 jsonStringify —— 这是本文件第二处关键性能优化。
    const computeToolHashes = () =>
      computePerToolHashes(strippedTools, toolNames)
    const systemCharCount = getSystemCharCount(system)
// 同样是惰性：几百 KB 的文本只在确认失效后才生成。
    const lazyDiffableContent = () =>
      buildDiffableContent(system, toolSchemas, model)
    const isFastMode = fastMode ?? false
// [...betas].sort()：先复制再排序，避免改动调用方传进来的数组（不可变原则）。
// readonly 数组不能直接 sort（sort 是原地修改），所以要先展开复制一份。
    const sortedBetas = [...betas].sort()
    const effortStr = effortValue === undefined ? '' : String(effortValue)
    const extraBodyHash =
      extraBodyParams === undefined ? 0 : computeHash(extraBodyParams)

    const prev = previousStateBySource.get(key)

// 第一次跟踪这个来源：直接存快照，不做任何比较（没有可比的上一次）。
    if (!prev) {
      // Evict oldest entries if map is at capacity
// ★ FIFO 淘汰：JS 的 Map 保持插入顺序，keys().next().value 就是最早插入的键。
// Java 里对应的是 LinkedHashMap（普通 HashMap 不保证顺序）。
      while (previousStateBySource.size >= MAX_TRACKED_SOURCES) {
        const oldest = previousStateBySource.keys().next().value
        if (oldest !== undefined) previousStateBySource.delete(oldest)
      }

      previousStateBySource.set(key, {
        systemHash,
        toolsHash,
        cacheControlHash,
        toolNames,
        systemCharCount,
        model,
        fastMode: isFastMode,
        globalCacheStrategy,
        betas: sortedBetas,
        autoModeActive,
        isUsingOverage,
        cachedMCEnabled,
        effortValue: effortStr,
        extraBodyHash,
        callCount: 1,
        pendingChanges: null,
        prevCacheReadTokens: null,
        cacheDeletionsPending: false,
        buildDiffableContent: lazyDiffableContent,
        perToolHashes: computeToolHashes(),
      })
      return
    }

// 第 N 次调用：逐个维度跟上次比较，得到一组布尔「变化标记」。
// 一共 11 个维度——可见影响缓存键的因素有多么多。
    prev.callCount++

    const systemPromptChanged = systemHash !== prev.systemHash
    const toolSchemasChanged = toolsHash !== prev.toolsHash
    const modelChanged = model !== prev.model
    const fastModeChanged = isFastMode !== prev.fastMode
    const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
    const globalCacheStrategyChanged =
      globalCacheStrategy !== prev.globalCacheStrategy
    const betasChanged =
// betas 的比较：先比长度，再用 some 逐项比（因为数组不能直接用 !== 比较内容）。
      sortedBetas.length !== prev.betas.length ||
      sortedBetas.some((b, i) => b !== prev.betas[i])
    const autoModeChanged = autoModeActive !== prev.autoModeActive
    const overageChanged = isUsingOverage !== prev.isUsingOverage
    const cachedMCChanged = cachedMCEnabled !== prev.cachedMCEnabled
    const effortChanged = effortStr !== prev.effortValue
    const extraBodyChanged = extraBodyHash !== prev.extraBodyHash

// 只要有任何一个维度变了，就生成一份「变化明细」存到 pendingChanges。
    if (
      systemPromptChanged ||
      toolSchemasChanged ||
      modelChanged ||
      fastModeChanged ||
      cacheControlChanged ||
      globalCacheStrategyChanged ||
      betasChanged ||
      autoModeChanged ||
      overageChanged ||
      cachedMCChanged ||
      effortChanged ||
      extraBodyChanged
    ) {
// 用 Set 求差集：新增的工具 = 现在有而以前没有的；移除的反之。
// Java：new HashSet<>(newList).removeAll(oldList)。
      const prevToolSet = new Set(prev.toolNames)
      const newToolSet = new Set(toolNames)
      const prevBetaSet = new Set(prev.betas)
      const newBetaSet = new Set(sortedBetas)
      const addedTools = toolNames.filter(n => !prevToolSet.has(n))
      const removedTools = prev.toolNames.filter(n => !newToolSet.has(n))
      const changedToolSchemas: string[] = []
// 工具集合确实变了，才真的去算每个工具的哈希（惰性求值在此刻触发）。
      if (toolSchemasChanged) {
        const newHashes = computeToolHashes()
// 只比对**两次都存在的**工具（新增/移除的已经在上面统计了），
// 哈希不同就说明这个工具的 description 或 schema 被改过。
        for (const name of toolNames) {
          if (!prevToolSet.has(name)) continue
          if (newHashes[name] !== prev.perToolHashes[name]) {
            changedToolSchemas.push(name)
          }
        }
        prev.perToolHashes = newHashes
      }
      prev.pendingChanges = {
        systemPromptChanged,
        toolSchemasChanged,
        modelChanged,
        fastModeChanged,
        cacheControlChanged,
        globalCacheStrategyChanged,
        betasChanged,
        autoModeChanged,
        overageChanged,
        cachedMCChanged,
        effortChanged,
        extraBodyChanged,
        addedToolCount: addedTools.length,
        removedToolCount: removedTools.length,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: systemCharCount - prev.systemCharCount,
        previousModel: prev.model,
        newModel: model,
        prevGlobalCacheStrategy: prev.globalCacheStrategy,
        newGlobalCacheStrategy: globalCacheStrategy,
        addedBetas: sortedBetas.filter(b => !prevBetaSet.has(b)),
        removedBetas: prev.betas.filter(b => !newBetaSet.has(b)),
        prevEffortValue: prev.effortValue,
        newEffortValue: effortStr,
// ★ 把「上一次」的内容生成函数也存进来 —— 同样是惰性函数，
// 阶段二确认失效后才调用它生成 before 文本，跟当前的 after 文本做 diff。
        buildPrevDiffableContent: prev.buildDiffableContent,
      }
    } else {
// 什么都没变 → 清空 pendingChanges（阶段二也就无从解释，会归类为「服务端原因」）。
      prev.pendingChanges = null
    }

// 无论有没有变化，都要把这次的状态写回去，作为下一次的比较基线。
    prev.systemHash = systemHash
    prev.toolsHash = toolsHash
    prev.cacheControlHash = cacheControlHash
    prev.toolNames = toolNames
    prev.systemCharCount = systemCharCount
    prev.model = model
    prev.fastMode = isFastMode
    prev.globalCacheStrategy = globalCacheStrategy
    prev.betas = sortedBetas
    prev.autoModeActive = autoModeActive
    prev.isUsingOverage = isUsingOverage
    prev.cachedMCEnabled = cachedMCEnabled
    prev.effortValue = effortStr
    prev.extraBodyHash = extraBodyHash
    prev.buildDiffableContent = lazyDiffableContent
// 整个探测器是旁路功能，任何异常都只记日志，绝不能影响真正的 API 调用。
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * Phase 2 (post-call): Check the API response's cache tokens to determine
 * if a cache break actually occurred. If it did, use the pending changes
 * from phase 1 to explain why.
 */
// ★【阶段二：收到 API 响应之后调用】看 cache_read_input_tokens 是否真的掉了，
// 掉了就结合阶段一的 pendingChanges 解释原因并上报。
// 参数说明：
//   cacheReadTokens / cacheCreationTokens：本次响应里的缓存读/写 token 数；
//   messages：当前消息列表（用来算「距上一次 assistant 消息多久了」，判断 TTL 过期）；
//   requestId：服务端请求 ID，方便后端同学查日志。
export async function checkResponseForCacheBreak(
  querySource: QuerySource,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: AgentId,
  requestId?: string | null,
): Promise<void> {
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const state = previousStateBySource.get(key)
    if (!state) return

    // Skip excluded models (e.g., haiku has different caching behavior)
// haiku 等模型排除掉。
    if (isExcludedModel(state.model)) return

// 取出上次的 cache read 作为基线，然后把本次的值写回去（滚动基线）。
    const prevCacheRead = state.prevCacheReadTokens
    state.prevCacheReadTokens = cacheReadTokens

    // Calculate time since last call for TTL detection by finding the most recent
    // assistant message timestamp in the messages array (before the current response)
// ★ 用「最后一条 assistant 消息的时间」估算距上次请求多久，用于判断 TTL 过期。
// findLast 从后往前找（ES2023 方法）。
    const lastAssistantMessage = messages.findLast(m => m.type === 'assistant')
    const timeSinceLastAssistantMsg = lastAssistantMessage
      ? Date.now() - new Date(lastAssistantMessage.timestamp).getTime()
      : null

    // Skip the first call — no previous value to compare against
// 第一次调用没有基线可比（prevCacheRead 为 null），直接返回。
    if (prevCacheRead === null) return

    const changes = state.pendingChanges

    // Cache deletions via cached microcompact intentionally reduce the cached
    // prefix. The drop in cache read tokens is expected — reset the baseline
    // so we don't false-positive on the next call.
// ★ 排除一种「假失效」：cached microcompact 主动发过 cache_edits 删除，
// 缓存前缀被人为缩短，cache read 下降是**预期内**的，不是 bug。
// 处理办法是重置基线并跳过本次判定。
    if (state.cacheDeletionsPending) {
      state.cacheDeletionsPending = false
      logForDebugging(
        `[PROMPT CACHE] cache deletion applied, cache read: ${prevCacheRead} → ${cacheReadTokens} (expected drop)`,
      )
      // Don't flag as a break — the remaining state is still valid
      state.pendingChanges = null
      return
    }

// ★ 失效判据（双重条件，缺一不可）：
//   ①本次 cache read 低于上次的 95%（相对跌幅 > 5%）；
//   ②绝对跌幅超过 2000 token。
// 两个条件一起才能兼顾「大基数的小比例」和「小基数的大比例」两种场景。
    // Detect a cache break: cache read dropped >5% from previous AND
    // the absolute drop exceeds the minimum threshold.
    const tokenDrop = prevCacheRead - cacheReadTokens
    if (
      cacheReadTokens >= prevCacheRead * 0.95 ||
      tokenDrop < MIN_CACHE_MISS_TOKENS
    ) {
      state.pendingChanges = null
      return
    }

// 把「变了什么」翻译成人类可读的一句话（parts 数组后面 join 成一句）。
    // Build explanation from pending changes (if any)
    const parts: string[] = []
    if (changes) {
      if (changes.modelChanged) {
        parts.push(
          `model changed (${changes.previousModel} → ${changes.newModel})`,
        )
      }
      if (changes.systemPromptChanged) {
        const charDelta = changes.systemCharDelta
        const charInfo =
          charDelta === 0
            ? ''
            : charDelta > 0
              ? ` (+${charDelta} chars)`
              : ` (${charDelta} chars)`
        parts.push(`system prompt changed${charInfo}`)
      }
// 工具变了但数量没变 → 说明是某个工具的 description/schema 被改了，
// 这正是上面 perToolHashes 存在的意义。
      if (changes.toolSchemasChanged) {
        const toolDiff =
          changes.addedToolCount > 0 || changes.removedToolCount > 0
            ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools)`
            : ' (tool prompt/schema changed, same tool set)'
        parts.push(`tools changed${toolDiff}`)
      }
      if (changes.fastModeChanged) {
        parts.push('fast mode toggled')
      }
      if (changes.globalCacheStrategyChanged) {
        parts.push(
          `global cache strategy changed (${changes.prevGlobalCacheStrategy || 'none'} → ${changes.newGlobalCacheStrategy || 'none'})`,
        )
      }
// 只有其它解释都不成立时，才把「cache_control 变了」当成独立原因上报 —— 
// 否则它通常只是别的变化（比如策略切换）的**结果**而非根因。
      if (
        changes.cacheControlChanged &&
        !changes.globalCacheStrategyChanged &&
        !changes.systemPromptChanged
      ) {
        // Only report as standalone cause if nothing else explains it —
        // otherwise the scope/TTL flip is a consequence, not the root cause.
        parts.push('cache_control changed (scope or TTL)')
      }
      if (changes.betasChanged) {
        const added = changes.addedBetas.length
          ? `+${changes.addedBetas.join(',')}`
          : ''
        const removed = changes.removedBetas.length
          ? `-${changes.removedBetas.join(',')}`
          : ''
        const diff = [added, removed].filter(Boolean).join(' ')
        parts.push(`betas changed${diff ? ` (${diff})` : ''}`)
      }
      if (changes.autoModeChanged) {
        parts.push('auto mode toggled')
      }
      if (changes.overageChanged) {
        parts.push('overage state changed (TTL latched, no flip)')
      }
      if (changes.cachedMCChanged) {
        parts.push('cached microcompact toggled')
      }
      if (changes.effortChanged) {
        parts.push(
          `effort changed (${changes.prevEffortValue || 'default'} → ${changes.newEffortValue || 'default'})`,
        )
      }
      if (changes.extraBodyChanged) {
        parts.push('extra body params changed')
      }
    }

// 计算时间差是否超过 5 分钟 / 1 小时两档 TTL。
    // Check if time gap suggests TTL expiration
    const lastAssistantMsgOver5minAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
    const lastAssistantMsgOver1hAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

// ★ 这段注释是一个很诚实的结论：线上数据分析（BQ）显示，
// 当客户端所有标记都是 false、且时间间隔远小于 TTL 时，
// 约 90% 的失效其实是**服务端路由/驱逐**或计费口径与推理口径不一致造成的，
// 并不是 CLI 的 bug。所以原因文案要如实写「likely server-side」，
// 而不是暗示大家去 CLI 里找问题。这体现了「用数据修正直觉」的工程文化。
    // Post PR #19823 BQ analysis (bq-queries/prompt-caching/cache_break_pr19823_analysis.sql):
    // when all client-side flags are false and the gap is under TTL, ~90% of breaks
    // are server-side routing/eviction or billed/inference disagreement. Label
    // accordingly instead of implying a CC bug hunt.
    let reason: string
    if (parts.length > 0) {
      reason = parts.join(', ')
    } else if (lastAssistantMsgOver1hAgo) {
      reason = 'possible 1h TTL expiry (prompt unchanged)'
    } else if (lastAssistantMsgOver5minAgo) {
      reason = 'possible 5min TTL expiry (prompt unchanged)'
    } else if (timeSinceLastAssistantMsg !== null) {
      reason = 'likely server-side (prompt unchanged, <5min gap)'
    } else {
      reason = 'unknown cause'
    }

// 上报分析事件。字段极多，基本就是「所有可能影响缓存键的维度」全量快照，
// 供后续在 BigQuery 里做归因分析。
    logEvent('tengu_prompt_cache_break', {
      systemPromptChanged: changes?.systemPromptChanged ?? false,
      toolSchemasChanged: changes?.toolSchemasChanged ?? false,
      modelChanged: changes?.modelChanged ?? false,
      fastModeChanged: changes?.fastModeChanged ?? false,
      cacheControlChanged: changes?.cacheControlChanged ?? false,
      globalCacheStrategyChanged: changes?.globalCacheStrategyChanged ?? false,
      betasChanged: changes?.betasChanged ?? false,
      autoModeChanged: changes?.autoModeChanged ?? false,
      overageChanged: changes?.overageChanged ?? false,
      cachedMCChanged: changes?.cachedMCChanged ?? false,
      effortChanged: changes?.effortChanged ?? false,
      extraBodyChanged: changes?.extraBodyChanged ?? false,
      addedToolCount: changes?.addedToolCount ?? 0,
      removedToolCount: changes?.removedToolCount ?? 0,
      systemCharDelta: changes?.systemCharDelta ?? 0,
// 工具名上报前统一脱敏（见 sanitizeToolName 的说明）。
// 末尾那一长串 as AnalyticsMetadata_... 是人工标记「已确认非代码/文件路径」，
// 用于隐私合规审查。
      // Tool names are sanitized: built-in names are a fixed vocabulary,
      // MCP tools collapse to 'mcp' (user-configured, could leak paths).
      addedTools: (changes?.addedTools ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedTools: (changes?.removedTools ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      changedToolSchemas: (changes?.changedToolSchemas ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // Beta header names and cache strategy are fixed enum-like values,
      // not code or filepaths. requestId is an opaque server-generated ID.
      addedBetas: (changes?.addedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedBetas: (changes?.removedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      prevGlobalCacheStrategy: (changes?.prevGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      newGlobalCacheStrategy: (changes?.newGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      callNumber: state.callCount,
      prevCacheReadTokens: prevCacheRead,
      cacheReadTokens,
      cacheCreationTokens,
      timeSinceLastAssistantMsg: timeSinceLastAssistantMsg ?? -1,
      lastAssistantMsgOver5minAgo,
      lastAssistantMsgOver1hAgo,
      requestId: (requestId ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

// 给内部用户（ant）排障用：把 before/after 的完整 prompt 文本做成 diff 文件落盘，
// 路径会打在日志里，方便直接打开看「到底哪个字节变了」。
    // Write diff file for ant debugging via --debug. The path is included in
    // the summary log so ants can find it (DevBar UI removed — event data
    // flows reliably to BQ for analytics).
    let diffPath: string | undefined
// ★ 惰性函数在这里才被调用——只有确认发生了 cache break 才付出序列化几百 KB 的代价。
    if (changes?.buildPrevDiffableContent) {
      diffPath = await writeCacheBreakDiff(
        changes.buildPrevDiffableContent(),
        state.buildDiffableContent(),
      )
    }

    const diffSuffix = diffPath ? `, diff: ${diffPath}` : ''
// 汇总日志。注意 level: 'warn'，因为缓存失效是要花钱的，值得引起注意。
    const summary = `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${prevCacheRead} → ${cacheReadTokens}, creation: ${cacheCreationTokens}${diffSuffix}]`

    logForDebugging(summary, { level: 'warn' })

    state.pendingChanges = null
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * Call when cached microcompact sends cache_edits deletions.
 * The next API response will have lower cache read tokens — that's
 * expected, not a cache break.
 */
// 供 cached microcompact 调用：预告「下一次响应里 cache read 会掉，那是正常的」。
export function notifyCacheDeletion(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.cacheDeletionsPending = true
  }
}

/**
 * Call after compaction to reset the cache read baseline.
 * Compaction legitimately reduces message count, so cache read tokens
 * will naturally drop on the next call — that's not a break.
 */
// 供压缩（compact）之后调用：上下文被压缩后消息变少，cache read 必然下降，
// 重置基线避免误报。
export function notifyCompaction(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.prevCacheReadTokens = null
  }
}

// subagent 结束后清掉它的跟踪状态，防止 previousStateBySource 无限增长。
export function cleanupAgentTracking(agentId: AgentId): void {
  previousStateBySource.delete(agentId)
}

export function resetPromptCacheBreakDetection(): void {
  previousStateBySource.clear()
}

// 生成 diff 文件。createPatch 来自 diff 库，产出标准的 unified diff 格式。
async function writeCacheBreakDiff(
  prevContent: string,
  newContent: string,
): Promise<string | undefined> {
  try {
    const diffPath = getCacheBreakDiffPath()
    await mkdir(getClaudeTempDir(), { recursive: true })
    const patch = createPatch(
      'prompt-state',
      prevContent,
      newContent,
      'before',
      'after',
    )
    await writeFile(diffPath, patch)
    return diffPath
// 写文件失败无所谓（排障工具），返回 undefined 让调用方降级。
  } catch {
    return undefined
  }
}
