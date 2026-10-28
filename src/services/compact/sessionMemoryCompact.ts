/**
 * 【一句话定位】**会话记忆压缩（Session Memory Compaction）**：一条特殊的压缩路径——
 * 它**不需要临时调用模型去生成摘要**，直接复用「会话过程中已经在后台持续写好的会话记忆文件」当摘要。
 * 比第四级 autocompact 便宜得多，是 autoCompact.ts 里的**首选方案**（失败了才降级到 compact.ts）。
 *
 * 【在架构中的位置】
 * - 上游：src/services/compact/autoCompact.ts 的 autoCompactIfNeeded()。
 *   它在决定要压缩时会**先**调用本文件的 trySessionMemoryCompaction()，
 *   拿不到结果（返回 null）才降级到 ./compact.ts 的 compactConversation()。
 *   而 autoCompact.ts 是被 src/query.ts 的主循环驱动的。
 * - 下游：
 *   · ../SessionMemory/*（会话记忆的读取、截断、 effectiveness 判断、lastSummarizedMessageId 台账）
 *   · ../../utils/messages.js（创建**压缩边界消息** createCompactBoundaryMessage）
 *   · ./compact.js 的 buildPostCompactMessages() / annotateBoundaryWithPreservedSegment() /
 *     createPlanAttachmentIfNeeded()
 *   · ./microCompact.js 的 estimateMessageTokens()（本地粗估 token）
 *   · ./prompt.js 的 getCompactUserSummaryMessage()（把记忆包装成一条用户消息）
 * - 调用链：src/query.ts（主循环）→ autoCompact.ts → 本文件（优先）→ 失败则降级 → compact.ts（调模型现生成摘要）
 *
 * 【为什么需要这一条路径 / 它比 autocompact 好在哪】
 * 第四级 autocompact 的代价是：**临时发起一次模型调用**，让模型把整段历史读一遍再写出摘要。
 * 慢、贵，而且是一次性的。
 * 而 Claude Code 在会话过程中其实一直在后台维护一份「会话记忆」（session memory，
 * 一个结构化文件，记录本次会话的关键决策、用户偏好、踩过的坑等），并且会记住
 * 「这份记忆已经摘要到哪一条消息为止」（getLastSummarizedMessageId）。
 * 于是压缩时可以直接：
 *   摘要内容  = 现成的会话记忆文件（不用调模型）
 *   保留原文  = 记忆还没覆盖到的那部分（最后若干条消息，原样保留）
 *  丢掉的    = 已经被写进记忆的那些旧消息的**细节**（记住：细节并不会真的丢，原文还在 transcript 里）
 * 本质上就是把「已经在做的事」的副产品拿来复用：代价几乎为零，速度也快得多。
 *
 * 【本文件必须解决的核心难题：切在哪里】
 * 「保留最后若干条」看着简单，实际上有几个硬约束（本文件大部分代码都在处理它们）：
 *   ① 不能切断 tool_use 与它的 tool_result —— API 会直接报错
 *   ② 不能丢掉与保留消息**共享同一 message.id** 的 thinking 块 —— 否则 thinking 丢失
 *   ③ 不能越过最后一个**压缩边界**往回取 —— 磁盘上那里有断层（见 370 行注释）
 *   ④ 至少要保留 minTokens / minTextBlockMessages，否则模型拿不到足够的工作上下文
 *   ⑤ 但也不能保留太多（maxTokens 硬上限），否则压缩没意义
 * 负责①②的是 adjustIndexToPreserveAPIInvariants()，负责③④⑤的是 calculateMessagesToKeepIndex()。
 *
 * 【本文件包含什么】
 * - type SessionMemoryCompactConfig / DEFAULT_SM_COMPACT_CONFIG：三个阈值配置（可远程下发）。
 * - setSessionMemoryCompactConfig() / getSessionMemoryCompactConfig() / resetSessionMemoryCompactConfig()：配置的读写与重置。
 * - initSessionMemoryCompactConfig()：从 GrowthBook 拉远程配置（每会话只拉一次）。
 * - hasTextBlocks() / getToolResultIds() / hasToolUseWithIds()：三个小的消息探查辅助函数。
 * - adjustIndexToPreserveAPIInvariants()：修正切分点，保证不破坏 API 契约。
 * - calculateMessagesToKeepIndex()：算出「保留区间」的起始下标。
 * - shouldUseSessionMemoryCompaction()：功能开关（环境变量 + 两个远程 flag）。
 * - createCompactionResultFromSessionMemory()：把各部分组装成统一的 CompactionResult。
 * - trySessionMemoryCompaction()：【主入口】由 autoCompact.ts 调用。
 *
 * 【TS 语法速查】
 * - `Partial<T>`：**工具类型（utility type）**，把 T 的所有字段变成可选。
 *   ≈ Java 里手写一堆 @Nullable，但 TS 一个 Partial 就够，且能跟原类型保持同步。
 * - `{ ...DEFAULT_SM_COMPACT_CONFIG }`：展开运算符做**浅拷贝**，避免多个地方共享同一个可变对象。
 * - `let` + 模块作用域 = 模块级可变单例（≈ Java 的 static 字段）。
 * - `messages[i]!`：`!` 是**非空断言**，告诉编译器「我确定它不是 undefined」，
 *   ≈ Java 的强制类型转换 / Objects.requireNonNull 的编译期版本。
 *   本文件用得很多，因为 TS 开启 noUncheckedIndexedAccess 之后，数组下标访问的结果是 `T | undefined`。
 * - `content.some(fn)`：判断「是否存在满足条件的元素」，≈ Java 的 stream().anyMatch()。
 * - `Array.isArray(content)`：除了判类型，更重要的是**类型收窄** —— 判断之后 TS 就知道 content 是数组了。
 * - `messages.findIndex(fn)` / `findLastIndex(fn)`：正序 / 倒序查找下标，找不到返回 **-1**（不是 Optional）。
 * - 传统 `for (let i = x; i >= 0; i--)` 倒序循环：这里用它是因为要「从切分点往回逐个检查」，
 *   Javaer 看着最亲切的一种写法。
 * - `messages.slice(startIndex)`：截取子数组（**返回新数组，不改原数组**），≈ Java 的 subList，
 *   但返回的是新数组而不是视图。
 * - `new Set<string>(arr)` / `[...set].sort()`：Set ⇄ 数组的互相转换，展开运算符是关键。
 * - `??` 空值合并：`preCompactTokenCount ?? 0` 只在 null/undefined 时取 0。
 * - `async` + `await` + `try/catch`：`await` 之后的异常可以用普通 try/catch 捕获，
 *   ≈ Java 里 CompletableFuture.join() 抛 CompletionException 被 catch 住，但写法上跟同步代码一样。
 * - `Promise<CompactionResult | null>`：返回 null 表示「这条路走不通，请调用方降级」——
 *   这是 TS 里表达「无结果」的常规手法（比抛异常更适合这种『预期的失败』）。
 */
/**
 * EXPERIMENT: Session memory compaction
 */

import type { AgentId } from '../../types/ids.js'
import type { HookResultMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  isCompactBoundaryMessage,
} from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { extractDiscoveredToolNames } from '../../utils/toolSearch.js'
import {
  getDynamicConfig_BLOCKS_ON_INIT,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../analytics/growthbook.js'
import { logEvent } from '../analytics/index.js'
import {
  isSessionMemoryEmpty,
  truncateSessionMemoryForCompact,
} from '../SessionMemory/prompts.js'
import {
  getLastSummarizedMessageId,
  getSessionMemoryContent,
  waitForSessionMemoryExtraction,
} from '../SessionMemory/sessionMemoryUtils.js'
import {
  annotateBoundaryWithPreservedSegment,
  buildPostCompactMessages,
  type CompactionResult,
  createPlanAttachmentIfNeeded,
} from './compact.js'
import { estimateMessageTokens } from './microCompact.js'
import { getCompactUserSummaryMessage } from './prompt.js'

/**
 * Configuration for session memory compaction thresholds
 */
/**
 * 会话记忆压缩的三个阈值。它们的共同目标：**保留区间不能太少也不能太多**——
 * 太少模型会失去工作上下文，太多则等于没压缩。配置可从 GrowthBook 远程下发（见 initSessionMemoryCompactConfig）。
 */
export type SessionMemoryCompactConfig = {
  /** Minimum tokens to preserve after compaction */
  /** 中文：保留区间**至少**要有这么多 token。不够就往回扩。 */
  minTokens: number
  /** Minimum number of messages with text blocks to keep */
  /** 中文：保留区间**至少**要有这么多条含文本的消息。
   *  为什么要单独数「条数」：光看 token 数会漏掉「全是工具结果、没有人在说话」的情况，
   *  那种历史对模型理解用户意图毫无帮助。 */
  minTextBlockMessages: number
  /** Maximum tokens to preserve after compaction (hard cap) */
  /** 中文：保留区间的**硬上限**。到了就停止往回扩 —— 保证压缩真的省下了 token。 */
  maxTokens: number
}

// Default configuration values (exported for use in tests)
// 默认值：至少 10k token / 至少 5 条含文本的消息，最多保留 40k token。
// 全部是「保守但可用」的量级，且导出给测试用（测试里可以直接断言这组默认值）。
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
}

// Current configuration (starts with defaults)
// 运行时配置：模块级可变单例。初始值是默认值的一份**拷贝**（防止有人顺手改了默认值常量）。
let smCompactConfig: SessionMemoryCompactConfig = {
  ...DEFAULT_SM_COMPACT_CONFIG,
}

// Track whether config has been initialized from remote
// 远程配置只需要拉一次（拿一次后短期内不会再变），用这个标记避免每轮压缩都去请求远程。
let configInitialized = false

/**
 * Set the session memory compact configuration
 */
/**
 * 覆写配置的**部分**字段（其余保持不变）。
 *
 * 为什么入参是 Partial<T> 而不是完整对象：调用方通常只想改一两个字段，
 * 强迫它们把三个字段都填满既麻烦又容易出错（比如把某个值误写成 0）。
 *
 * @param config 要修改的字段（可多可少）。
 */
export function setSessionMemoryCompactConfig(
  config: Partial<SessionMemoryCompactConfig>,
): void {
  // 展开合并（不可变更新的标准写法）：先铺开旧值，再用新值覆盖同名字段；
  // 没传的字段自然保持原样。等价于 Object.assign({}, 旧, 新)，但语法更简洁。
  smCompactConfig = {
    ...smCompactConfig,
    ...config,
  }
}

/**
 * Get the current session memory compact configuration
 */
/**
 * 读取当前生效的配置。
 *
 * @returns 配置的一份**拷贝**（不是内部对象本身）。
 *         为什么要拷贝：防止调用方拿着返回值去改，无意间篡改了全局状态。
 *         这是防御性编程里很常见的一招（≈ Java 返回防御性拷贝 / 不可变 DTO）。
 */
export function getSessionMemoryCompactConfig(): SessionMemoryCompactConfig {
  return { ...smCompactConfig }
}

/**
 * Reset config state (useful for testing)
 */
/**
 * 把配置恢复到默认值，并清掉「已初始化」标记。
 *
 * 为什么需要：主要是给**测试**用 —— 测试用例之间互相隔离，
 * 否则上一个用例改的配置会污染下一个用例。
 * 注意它同时清零 configInitialized，这样下一次会重新拉一次远程配置。
 */
export function resetSessionMemoryCompactConfig(): void {
  smCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG }
  configInitialized = false
}

/**
 * Initialize configuration from remote config (GrowthBook).
 * Only fetches once per session - subsequent calls return immediately.
 */
/**
 * 从远程配置平台（GrowthBook）拉取会话记忆压缩的阈值配置。
 *
 * 为什么需要：阈值这种参数必须能远程调整、做 A/B 实验，不能写死在代码里。
 * 而且**每会话只拉一次** —— 拉远程是有延迟的，每轮压缩都拉一次会明显拖慢流程。
 *
 * 关键步骤：
 *   ① 已初始化过就直接返回（幂等）
 *   ② **先**把 configInitialized 置 true 再去 await（防止并发调用重复拉取）
 *   ③ 拉远程配置
 *   ④ 逐个字段判断：只有当远程值是「有效的正数」时才采用，否则用默认值
 *   ⑤ 写回配置
 */
async function initSessionMemoryCompactConfig(): Promise<void> {
  if (configInitialized) {
    return
  }
  // 注意：置 true 放在 await **之前**。
  // 如果放在 await 之后，两个并发的调用会同时通过上面的检查、都去拉一次远程。
  configInitialized = true

  // Load config from GrowthBook, merging with defaults
  const remoteConfig = await getDynamicConfig_BLOCKS_ON_INIT<
    Partial<SessionMemoryCompactConfig>
  >('tengu_sm_compact_config', {})

  // Only use remote values if they are explicitly set (positive numbers)
  // This ensures sensible defaults aren't overridden by zero values
  // 为什么要逐个校验 `> 0`（原英文注释强调）：远程配置可能下发了 0、负数或者干脆没有这个字段。
  // 如果用 `?? 默认值` 兜底，0 会被当成有效值放行；写成 minTokens=0 意味着「保留区间可以为 0 条」，
  // 那压缩后模型就完全没有工作上下文了。所以这里用「必须是正数」作为准入门槛，更严格。
  const config: SessionMemoryCompactConfig = {
    minTokens:
      remoteConfig.minTokens && remoteConfig.minTokens > 0
        ? remoteConfig.minTokens
        : DEFAULT_SM_COMPACT_CONFIG.minTokens,
    minTextBlockMessages:
      remoteConfig.minTextBlockMessages && remoteConfig.minTextBlockMessages > 0
        ? remoteConfig.minTextBlockMessages
        : DEFAULT_SM_COMPACT_CONFIG.minTextBlockMessages,
    maxTokens:
      remoteConfig.maxTokens && remoteConfig.maxTokens > 0
        ? remoteConfig.maxTokens
        : DEFAULT_SM_COMPACT_CONFIG.maxTokens,
  }
  setSessionMemoryCompactConfig(config)
}

/**
 * Check if a message contains text blocks (text content for user/assistant interaction)
 */
/**
 * 判断一条消息里是否**含有文本块**（真正的「人话」，而不是工具结果）。
 *
 * 为什么需要：统计 minTextBlockMessages 时要数这个。只数 token 是不够的——
 * 一段全是工具结果的历史 token 很多，但对理解用户意图毫无帮助。
 *
 * @param message 任意消息。
 * @returns true 表示含有文本内容。
 *
 * 为什么分 assistant / user 两种处理：两者的 content 结构不同——
 * assistant 的 content 一定是块数组；而 user 的 content **既可能是字符串也可能是数组**（API 允许），
 * 所以 user 这边要先判 typeof 与 Array.isArray —— 这两步同时也是在做**类型收窄**。
 */
export function hasTextBlocks(message: Message): boolean {
  if (message.type === 'assistant') {
    const content = message.message.content
    return content.some(block => block.type === 'text')
  }
  if (message.type === 'user') {
    const content = message.message.content
    if (typeof content === 'string') {
      return content.length > 0
    }
    if (Array.isArray(content)) {
      return content.some(block => block.type === 'text')
    }
  }
  return false
}

/**
 * Check if a message contains tool_result blocks and return their tool_use_ids
 */
/**
 * 取出一条 user 消息里所有 tool_result 块对应的 tool_use ID。
 *
 * 为什么需要：判断切分点安不安全的第一步就是「我保留的这部分里有哪些 tool_result」，
 * 然后才能回头去找它们对应的 tool_use 是不是也保留下来了。
 *
 * @param message 一条消息（非 user 消息直接返回空数组）。
 * @returns tool_use ID 列表。
 */
function getToolResultIds(message: Message): string[] {
  if (message.type !== 'user') {
    return []
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return []
  }
  const ids: string[] = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Check if a message contains tool_use blocks with any of the given ids
 */
/**
 * 判断一条 assistant 消息里是否含有指定 ID 的 tool_use 块。
 *
 * @param message 一条消息。
 * @param toolUseIds 我们正在寻找的 tool_use ID 集合。
 * @returns true 表示命中。
 *
 * `.some(fn)` ≈ Java 的 `stream().anyMatch(fn)`；把 toolUseIds 设计成 Set 是为了让 has() 是 O(1)。
 */
function hasToolUseWithIds(message: Message, toolUseIds: Set<string>): boolean {
  if (message.type !== 'assistant') {
    return false
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block => block.type === 'tool_use' && toolUseIds.has(block.id),
  )
}

/**
 * Adjust the start index to ensure we don't split tool_use/tool_result pairs
 * or thinking blocks that share the same message.id with kept assistant messages.
 *
 * If ANY message we're keeping contains tool_result blocks, we need to
 * include the preceding assistant message(s) that contain the matching tool_use blocks.
 *
 * Additionally, if ANY assistant message in the kept range has the same message.id
 * as a preceding assistant message (which may contain thinking blocks), we need to
 * include those messages so they can be properly merged by normalizeMessagesForAPI.
 *
 * This handles the case where streaming yields separate messages per content block
 * (thinking, tool_use, etc.) with the same message.id but different uuids. If the
 * startIndex lands on one of these streaming messages, we need to look at ALL kept
 * messages for tool_results, not just the first one.
 *
 * Example bug scenarios this fixes:
 *
 * Tool pair scenario:
 *   Session storage (before compaction):
 *     Index N:   assistant, message.id: X, content: [thinking]
 *     Index N+1: assistant, message.id: X, content: [tool_use: ORPHAN_ID]
 *     Index N+2: assistant, message.id: X, content: [tool_use: VALID_ID]
 *     Index N+3: user, content: [tool_result: ORPHAN_ID, tool_result: VALID_ID]
 *
 *   If startIndex = N+2:
 *     - Old code: checked only message N+2 for tool_results, found none, returned N+2
 *     - After slicing and normalizeMessagesForAPI merging by message.id:
 *       msg[1]: assistant with [tool_use: VALID_ID]  (ORPHAN tool_use was excluded!)
 *       msg[2]: user with [tool_result: ORPHAN_ID, tool_result: VALID_ID]
 *     - API error: orphan tool_result references non-existent tool_use
 *
 * Thinking block scenario:
 *   Session storage (before compaction):
 *     Index N:   assistant, message.id: X, content: [thinking]
 *     Index N+1: assistant, message.id: X, content: [tool_use: ID]
 *     Index N+2: user, content: [tool_result: ID]
 *
 *   If startIndex = N+1:
 *     - Without this fix: thinking block at N is excluded
 *     - After normalizeMessagesForAPI: thinking block is lost (no message to merge with)
 *
 *   Fixed code: detects that message N+1 has same message.id as N, adjusts to N.
 */
/**
 * 【切分点的安全修正】把「打算从这里切开」的下标往前挪，直到不破坏 API 契约为止。
 *
 * 为什么需要（这是本文件最微妙的一段，务必看上面那段长英文注释）：
 * 「从数组中间切开」这件事看着简单，实际有两个致命陷阱：
 *
 * 陷阱一：**孤儿 tool_result**。
 *   API 要求「有 tool_use 就必须有配对的 tool_result，反之亦然」。
 *   如果切分点落在某个 tool_use 和它的 tool_result 中间，切完之后
 *   保留部分就会有一个找不到 tool_use 的孤儿 tool_result，API 直接报错。
 *   更隐蔽的是：流式输出会产生**多条共享同一个 message.id 但 uuid 不同**的 assistant 消息
 *   （先吐一个 thinking 块、再吐一个 tool_use 块……），而 normalizeMessagesForAPI 会按 message.id 合并。
 *   于是「只看切分点那一条消息有没有 tool_result」是不够的，必须看**整个保留区间**。
 *
 * 陷阱二：**丢失 thinking 块**。
 *   如果 assistant 的 thinking 块在切分点之前、而它的 tool_use 在切分点之后，
 *   切开后 thinking 就没有宿主消息了，合并时会凭空消失。
 *   这会破坏 extended-thinking 相关的模型行为一致性。
 *
 * @param messages 完整历史消息。
 * @param startIndex 打算保留区间的起始下标（0-based，含）。
 * @returns 修正后的起始下标（只会**往前挪**，即 <= 入参）。
 *
 * 关键步骤：
 *   ① 越界（<=0 或已到末尾）直接原样返回 —— 无事可做
 *   ② 【第 1 步】收集**整个保留区间内**所有 tool_result 的 ID
 *   ③ 再看其中哪些 ID 在保留区间里**找不到对应的 tool_use**（这些就是缺口）
 *   ④ 从切分点往回扫描，把含有缺失 tool_use 的那些 assistant 消息也纳入保留区间，直到缺口补齐
 *   ⑤ 【第 2 步】收集保留区间内所有 assistant 消息的 message.id
 *   ⑥ 同样往回扫描，只要是「message.id 相同」的 assistant 消息就一并纳入
 *      —— 这样 thinking 块就能被 normalizeMessagesForAPI 正确合并回去
 */
export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
): number {
  // 起点已经是 0（全保留）或已经越过末尾（全保留=0 条），没有可调整的空间。
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex
  }

  let adjustedIndex = startIndex

  // Step 1: Handle tool_use/tool_result pairs
  // Collect tool_result IDs from ALL messages in the kept range
  const allToolResultIds: string[] = []
    // `messages[i]!` 的 `!` 是**非空断言**：TS 在 noUncheckedIndexedAccess 模式下会把
    // 数组下标访问的结果视为 `T | undefined`，这里明确告诉编译器「下标一定存在」。
    // ≈ Java 的强制类型转换：躲过了编译检查，但写错的话运行时照样炸。
  for (let i = startIndex; i < messages.length; i++) {
    allToolResultIds.push(...getToolResultIds(messages[i]!))
  }

  if (allToolResultIds.length > 0) {
    // Collect tool_use IDs already in the kept range
    const toolUseIdsInKeptRange = new Set<string>()
    for (let i = adjustedIndex; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolUseIdsInKeptRange.add(block.id)
          }
        }
      }
    }

    // Only look for tool_uses that are NOT already in the kept range
    const neededToolUseIds = new Set(
      allToolResultIds.filter(id => !toolUseIdsInKeptRange.has(id)),
    )

    // Find the assistant message(s) with matching tool_use blocks
    for (let i = adjustedIndex - 1; i >= 0 && neededToolUseIds.size > 0; i--) {
      const message = messages[i]!
      if (hasToolUseWithIds(message, neededToolUseIds)) {
        adjustedIndex = i
        // Remove found tool_use_ids from the set
        if (
          message.type === 'assistant' &&
          Array.isArray(message.message.content)
        ) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && neededToolUseIds.has(block.id)) {
              neededToolUseIds.delete(block.id)
            }
          }
        }
      }
    }
  }

  // Step 2: Handle thinking blocks that share message.id with kept assistant messages
  // Collect all message.ids from assistant messages in the kept range
  // 【第 2 步】处理 thinking 块：收集保留区间内所有 assistant 消息的 message.id。
  const messageIdsInKeptRange = new Set<string>()
  for (let i = adjustedIndex; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.message.id) {
      messageIdsInKeptRange.add(msg.message.id)
    }
  }

  // Look backwards for assistant messages with the same message.id that are not in the kept range
  // These may contain thinking blocks that need to be merged by normalizeMessagesForAPI
  for (let i = adjustedIndex - 1; i >= 0; i--) {
    const message = messages[i]!
    if (
      message.type === 'assistant' &&
      message.message.id &&
      messageIdsInKeptRange.has(message.message.id)
    ) {
      // This message has the same message.id as one in the kept range
      // Include it so thinking blocks can be properly merged
      adjustedIndex = i
    }
  }

  return adjustedIndex
}

/**
 * Calculate the starting index for messages to keep after compaction.
 * Starts from lastSummarizedMessageId, then expands backwards to meet minimums:
 * - At least config.minTokens tokens
 * - At least config.minTextBlockMessages messages with text blocks
 * Stops expanding if config.maxTokens is reached.
 * Also ensures tool_use/tool_result pairs are not split.
 */
/**
 * 算出「保留区间」的起始下标：保留 messages[startIndex .. 末尾]，之前的都被会话记忆覆盖掉了。
 *
 * 为什么需要：压缩的核心是决定「丢多少」。这里的策略是三条：
 *   · 起点：lastSummarizedIndex + 1（记忆已经摘要到哪，就从那之后开始保留）
 *   · 下限：至少 minTokens token、至少 minTextBlockMessages 条含文本的消息
 *   · 上限：最多 maxTokens token
 * 并且结束后一定要调 adjustIndexToPreserveAPIInvariants() 做安全修正。
 *
 * @param messages 完整历史消息。
 * @param lastSummarizedIndex 会话记忆已经摘要到的最后一条消息的下标；
 *        **-1 表示没找到**（此时等价于「一条都不保留」，靠下面的下限逻辑往回兜）。
 * @returns 保留区间的起始下标。
 *
 * 关键步骤：
 *   ① 空数组直接返回 0
 *   ② 起点 = lastSummarizedIndex + 1；若 lastSummarizedIndex 是 -1（未找到），
 *      就起点设为 messages.length（先假设一条都不保留，后面靠往回扩来兜底）
 *   ③ 累计起点之后的 token 数与含文本消息数
 *   ④ 已经超过硬上限 maxTokens → 直接返回（不需要再往回扩）
 *   ⑤ 已经同时满足两个下限 → 直接返回
 *   ⑥ 否则从起点往回逐条纳入，直到满足下限或撞上硬上限
 *      **往回的下限（floor）是最后一个压缩边界**，见下面 370 行的注释
 *   ⑦ 最后统一交给 adjustIndexToPreserveAPIInvariants() 做安全修正后返回
 */
export function calculateMessagesToKeepIndex(
  messages: Message[],
  lastSummarizedIndex: number,
): number {
  if (messages.length === 0) {
    return 0
  }

  const config = getSessionMemoryCompactConfig()

  // Start from the message after lastSummarizedIndex
  // If lastSummarizedIndex is -1 (not found) or messages.length (no summarized id),
  // we start with no messages kept
  // lastSummarizedIndex 为 -1 时把起点设成 messages.length：
  // 意思是「先假设一条都不保留」。这不是真的不保留 —— 下面两个下限（minTokens /
  // minTextBlockMessages）会把区间往回撑开到一个合理的大小。
  let startIndex =
    lastSummarizedIndex >= 0 ? lastSummarizedIndex + 1 : messages.length

  // Calculate current tokens and text-block message count from startIndex to end
  let totalTokens = 0
  let textBlockMessageCount = 0
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!
    totalTokens += estimateMessageTokens([msg])
    if (hasTextBlocks(msg)) {
      textBlockMessageCount++
    }
  }

  // Check if we already hit the max cap
  // 已经超过硬上限：说明该保留的已经够多了，再往回扩只会让压缩失去意义，直接收工。
  if (totalTokens >= config.maxTokens) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // Check if we already meet both minimums
  if (
    totalTokens >= config.minTokens &&
    textBlockMessageCount >= config.minTextBlockMessages
  ) {
    return adjustIndexToPreserveAPIInvariants(messages, startIndex)
  }

  // Expand backwards until we meet both minimums or hit max cap.
  // Floor at the last boundary: the preserved-segment chain has a disk
  // discontinuity there (att[0]→summary shortcut from dedup-skip), which
  // would let the loader's tail→head walk bypass inner preserved messages
  // and then prune them. Reactive compact already slices at the boundary
  // via getMessagesAfterCompactBoundary; this is the same invariant.
  // 中文讲解上面那段英文（这是「边界消息」为什么重要的绝佳例子）：
  // 往回扩张必须有个**地板**，这个地板就是最后一条压缩边界消息。
  // 原因：跨过边界往回取，会拿到「上一次压缩之前的旧消息」。而那些旧消息在磁盘上的存储
  // 是不连续的（上次的 att[0]→summary 有个去重跳过的捷径），加载器从尾部往头部走时会绕过
  // 中间的 preserved 消息，然后顺手把它们修剪掉 —— 结果就是一部分历史凭空消失。
  // 所以「不能跨边界回捞」是一条**不变量**：reactive compact 也遵循同样的规则
  // （它用 getMessagesAfterCompactBoundary() 在边界处切）。
  // 没有边界时（idx === -1）地板就是 0，即允许一路回到数组开头。
  //
  // findLastIndex 是**倒序**查找，找不到返回 -1（注意不是 undefined，也不是 -0）。
  const idx = messages.findLastIndex(m => isCompactBoundaryMessage(m))
  const floor = idx === -1 ? 0 : idx + 1
  for (let i = startIndex - 1; i >= floor; i--) {
    const msg = messages[i]!
    const msgTokens = estimateMessageTokens([msg])
    totalTokens += msgTokens
    if (hasTextBlocks(msg)) {
      textBlockMessageCount++
    }
    startIndex = i

    // Stop if we hit the max cap
    if (totalTokens >= config.maxTokens) {
      break
    }

    // Stop if we meet both minimums
    if (
      totalTokens >= config.minTokens &&
      textBlockMessageCount >= config.minTextBlockMessages
    ) {
      break
    }
  }

  // Adjust for tool pairs
  return adjustIndexToPreserveAPIInvariants(messages, startIndex)
}

/**
 * Check if we should use session memory for compaction
 * Uses cached gate values to avoid blocking on Statsig initialization
 */
/**
 * 判断当前是否应该使用「会话记忆压缩」这条路。
 *
 * 为什么需要：这是一个实验性功能（文件名就叫 EXPERIMENT），必须能被随时关掉。
 * 而且它依赖两个前提：① 会话记忆功能本身开着 ② 用会话记忆做压缩这个实验也开着。
 *
 * @returns true 表示可以使用这条路。
 *
 * 四层开关（从强到弱）：
 *   ① ENABLE_CLAUDE_CODE_SM_COMPACT  → 强制**开启**（评测 / 测试用，优先级最高）
 *   ② DISABLE_CLAUDE_CODE_SM_COMPACT → 强制**关闭**
 *   ③ 远程 flag tengu_session_memory  → 会话记忆功能本身是否启用
 *   ④ 远程 flag tengu_sm_compact      → 会话记忆压缩实验是否启用
 * ③④ 需要**同时**为真（这里用 && 而不是 ||，因为缺任何一个这条路径都跑不起来）。
 *
 * 为什么用 getFeatureValue_CACHED_MAY_BE_STALE（函数名直译就是「可能是旧值」）：
 * 读远程配置有网络延迟，这里刻意接受**可能稍旧**的缓存值，避免压缩流程被阻塞。
 */
export function shouldUseSessionMemoryCompaction(): boolean {
  // Allow env var override for eval runs and testing
  if (isEnvTruthy(process.env.ENABLE_CLAUDE_CODE_SM_COMPACT)) {
    return true
  }
  if (isEnvTruthy(process.env.DISABLE_CLAUDE_CODE_SM_COMPACT)) {
    return false
  }

  const sessionMemoryFlag = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_session_memory',
    false,
  )
  const smCompactFlag = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_sm_compact',
    false,
  )
  const shouldUse = sessionMemoryFlag && smCompactFlag

  // Log flag states for debugging (ant-only to avoid noise in external logs)
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_sm_compact_flag_check', {
      tengu_session_memory: sessionMemoryFlag,
      tengu_sm_compact: smCompactFlag,
      should_use: shouldUse,
    })
  }

  return shouldUse
}

/**
 * Create a CompactionResult from session memory
 */
/**
 * 把「会话记忆 + 保留的消息 + 钩子节点 + transcript 路径」组装成一个统一的 CompactionResult。
 *
 * 为什么需要：无论走哪条压缩路径，上层（autoCompact.ts / query.ts）拿到的都必须是同一种结构，
 * 这样主循环才能用同一套代码替换历史。这个函数负责把会话记忆这条路径的产物
 * 「伪装」成和第四级压缩一样的形状。
 *
 * @param messages 压缩前的完整历史（用于统计压缩前 token 数）。
 * @param sessionMemory 会话记忆文件的完整内容 —— **它就是这次压缩的摘要**，不需要调模型生成。
 * @param messagesToKeep 原样保留的消息。
 * @param hookResults 跑 SessionStart 钩子得到的结果（重新注入 CLAUDE.md 等上下文）。
 * @param transcriptPath 完整 transcript 的落盘路径（告诉模型：要细节可以去读这个文件）。
 * @param agentId 当前代理 ID（用于拼 plan 附件）。
 * @returns CompactionResult，含 boundaryMarker / summaryMessages / attachments / hookResults /
 *          messagesToKeep 以及压缩前后的 token 计数。
 *
 * 关键步骤：
 *   ① 记录压缩前 token 数
 *   ② 创建**压缩边界消息**（这是整个压缩体系的关键标记，见下面 447 行注释）
 *   ③ 记录压缩前已发现的工具名（写进边界消息的元数据里，压缩后才不会「忘记」有哪些工具）
 *   ④ 截断过长的会话记忆章节 —— 防止记忆本身吃掉整个压缩后的预算
 *   ⑤ 用 getCompactUserSummaryMessage() 把记忆包装成一条用户消息
 *   ⑥ 按需拼上 plan 附件
 *   ⑦ 返回一个被 annotateBoundaryWithPreservedSegment() 增强过的边界标记 + 其余产物
 */
function createCompactionResultFromSessionMemory(
  messages: Message[],
  sessionMemory: string,
  messagesToKeep: Message[],
  hookResults: HookResultMessage[],
  transcriptPath: string,
  agentId?: AgentId,
): CompactionResult {
  const preCompactTokenCount = tokenCountFromLastAPIResponse(messages)

  // 【压缩边界消息】整个压缩子系统的核心机制，务必理解：
  // 它在历史里插入一条**特殊标记**，从此分隔「压缩前」和「压缩后」。之后所有需要遍历历史的逻辑
  // （典型的是 getMessagesAfterCompactBoundary()）都以它为界，只处理它之后的消息。
  //
  // 为什么要这么做：边界之前的原始消息已经被**丢弃或替换成摘要**了，
  // 它们的 uuid、tool_use_id 都不复存在。如果哪段逻辑不小心越界往回引用，
  // 就会拿到悬空的 ID（比如一个指向已删除 tool_use 的 tool_result），API 会直接报错。
  // 有了边界消息，「哪里是有效历史的起点」就有了一个唯一、明确的答案。
  //
  // 参数 'auto' 表示这是一次自动压缩（区别于用户手动 /compact）。
  const boundaryMarker = createCompactBoundaryMessage(
    'auto',
    preCompactTokenCount ?? 0,
    messages[messages.length - 1]?.uuid,
  )
  const preCompactDiscovered = extractDiscoveredToolNames(messages)
  if (preCompactDiscovered.size > 0) {
    boundaryMarker.compactMetadata.preCompactDiscoveredTools = [
      ...preCompactDiscovered,
    ].sort()
  }

  // Truncate oversized sections to prevent session memory from consuming
  // the entire post-compact token budget
  // 为什么要截断（原英文注释）：会话记忆是**持续累积**的，章节多了体积会很大。
  // 如果直接整段塞进摘要消息，好不容易省下来的 token 又被记忆吃回去了 —— 等于压缩了个寂寞。
  // 所以按预算截断，并告知模型「全文在这里」+ 给出文件路径。
  const { truncatedContent, wasTruncated } =
    truncateSessionMemoryForCompact(sessionMemory)

  let summaryContent = getCompactUserSummaryMessage(
    truncatedContent,
    true,
    transcriptPath,
    true,
  )

  if (wasTruncated) {
    const memoryPath = getSessionMemoryPath()
    summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${memoryPath}`
  }

  const summaryMessages = [
    createUserMessage({
      content: summaryContent,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
  ]

  const planAttachment = createPlanAttachmentIfNeeded(agentId)
  const attachments = planAttachment ? [planAttachment] : []

  return {
    boundaryMarker: annotateBoundaryWithPreservedSegment(
      boundaryMarker,
      summaryMessages[summaryMessages.length - 1]!.uuid,
      messagesToKeep,
    ),
    summaryMessages,
    attachments,
    hookResults,
    messagesToKeep,
    preCompactTokenCount,
    // 中文补充：这里是 session-memory 路径与第四级 autocompact 的**关键区别**——
    // 后者真的发了一次模型请求去生成摘要，所以「压缩后 token 数」有两个口径
    // （估算值 vs API 返回的真实值）；而这条路没有那次请求，两个口径自然合二为一。
    // SM-compact has no compact-API-call, so postCompactTokenCount (kept for
    // event continuity) and truePostCompactTokenCount converge to the same value.
    postCompactTokenCount: estimateMessageTokens(summaryMessages),
    truePostCompactTokenCount: estimateMessageTokens(summaryMessages),
  }
}

/**
 * Try to use session memory for compaction instead of traditional compaction.
 * Returns null if session memory compaction cannot be used.
 *
 * Handles two scenarios:
 * 1. Normal case: lastSummarizedMessageId is set, keep only messages after that ID
 * 2. Resumed session: lastSummarizedMessageId is not set but session memory has content,
 *    keep all messages but use session memory as the summary
 */
/**
 * 【主入口】尝试用会话记忆来做压缩。由 autoCompact.ts 优先调用。
 *
 * 为什么需要：这是**比第四级 autocompact 轻得多**的一条路。会话记忆在会话过程中就已经写好，
 * 压缩时直接拿来当摘要用，省掉了「临时调一次模型去通读历史」的开销与延迟。
 *
 * @param messages 完整历史消息。
 * @param agentId 当前代理 ID。
 * @param autoCompactThreshold 自动压缩阈值。只有**自动压缩**场景才会传这个参数：
 *        压完之后要验一遍「压完还是超过阈值」的话，说明这条路没解决问题，
 *        返回 null 让调用方降级去走第四级。手动 /compact 不传，因为它总是要求真的压缩一次。
 * @returns Promise<CompactionResult | null>：
 *         null 表示「这条路走不通」（功能没开 / 没有记忆文件 / 记忆还是空模板 / 边界找不到 /
 *         压完还超阈值 / 出异常），调用方应当降级到第四级 compactConversation()。
 *         注意：这里的失败都属于**预期内的**，所以走 logEvent 而不是 logError。
 *
 * 处理的两种场景（对应原英文注释）：
 *   ① 正常情况：知道 lastSummarizedMessageId → 精确保留它之后的消息
 *   ② 会话恢复（resumed）：不知道 lastSummarizedMessageId，但记忆文件有内容
 *      → 保守地把lastSummarizedIndex 设成最后一条（等价于「先一条都不保留」），
 *        再由下限逻辑往回撑开到一个合理区间
 *
 * 关键步骤：
 *   ① 功能开关检查
 *   ② 初始化远程配置（每会话一次）+ 等待正在进行的记忆抽取完成
 *   ③ 读取 lastSummarizedMessageId 与会话记忆内容；两者缺失都有对应的降级
 *   ④ 定位 lastSummarizedIndex（含「找不到就降级」的保护）
 *   ⑤ 计算保留区间的起始下标（含各种安全修正）
 *   ⑥ 切片得到 messagesToKeep，**并过滤掉旧的边界消息**
 *   ⑦ 跑 SessionStart 钩子（重新注入 CLAUDE.md 等上下文）
 *   ⑧ 组装 CompactionResult → 拼出压缩后的完整消息数组 → 估算 token
 *   ⑨ 若仍然超过自动压缩阈值，返回 null 让调用方降级
 *   ⑩ 成功则返回结果
 */
export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: AgentId,
  autoCompactThreshold?: number,
): Promise<CompactionResult | null> {
  // 实验没开就直接降级。返回 null 而不是抛异常——「这条路不可用」是**预期内**的结果。
  if (!shouldUseSessionMemoryCompaction()) {
    return null
  }

  // Initialize config from remote (only fetches once)
  await initSessionMemoryCompactConfig()

  // Wait for any in-progress session memory extraction to complete (with timeout)
  // 记忆是后台异步抽取的。如果此刻正抽到一半，拿到的记忆是不完整的，
  // 用它当摘要会丢信息。所以这里等它写完（带超时，不能无限等）。
  await waitForSessionMemoryExtraction()

  const lastSummarizedMessageId = getLastSummarizedMessageId()
  const sessionMemory = await getSessionMemoryContent()

  // No session memory file exists at all
  if (!sessionMemory) {
    logEvent('tengu_sm_compact_no_session_memory', {})
    return null
  }

  // Session memory exists but matches the template (no actual content extracted)
  // Fall back to legacy compact behavior
  // 记忆文件存在，但内容还停留在**初始模板**（一条实质内容都没抽出来过）。
  // 这种情况等于没有摘要可用，必须降级。
  if (await isSessionMemoryEmpty(sessionMemory)) {
    logEvent('tengu_sm_compact_empty_template', {})
    return null
  }

  try {
    let lastSummarizedIndex: number

    if (lastSummarizedMessageId) {
      // Normal case: we know exactly which messages have been summarized
      lastSummarizedIndex = messages.findIndex(
        msg => msg.uuid === lastSummarizedMessageId,
      )

      // 记忆里记的「已摘要到最后一条」这个 ID，在当前消息数组里找不到了。
      // 通常意味着消息被改动过（比如之前已经压缩/剪枝过）。
      // 这时无法判断「哪些被摘要过、哪些没有」，继续下去会丢数据 —— 保守降级。
      if (lastSummarizedIndex === -1) {
        // The summarized message ID doesn't exist in current messages
        // This can happen if messages were modified - fall back to legacy compact
        // since we can't determine the boundary between summarized and unsummarized messages
        logEvent('tengu_sm_compact_summarized_id_not_found', {})
        return null
      }
    } else {
      // Resumed session case: session memory has content but we don't know the boundary
      // Set lastSummarizedIndex to last message so startIndex becomes messages.length (no messages kept initially)
      // 会话恢复场景：既然不知道边界在哪，就从最保守的假设出发（一条都不保留），
      // 然后交给 calculateMessagesToKeepIndex() 按 minTokens / minTextBlockMessages 往回撑开。
      lastSummarizedIndex = messages.length - 1
      logEvent('tengu_sm_compact_resumed_session', {})
    }

    // Calculate the starting index for messages to keep
    // This starts from lastSummarizedIndex, expands to meet minimums,
    // and adjusts to not split tool_use/tool_result pairs
    const startIndex = calculateMessagesToKeepIndex(
      messages,
      lastSummarizedIndex,
    )
    // Filter out old compact boundary messages from messagesToKeep.
    // After REPL pruning, old boundaries re-yielded from messagesToKeep would
    // trigger an unwanted second prune (isCompactBoundaryMessage returns true),
    // discarding the new boundary and summary.
    // 为什么要**过滤掉旧的压缩边界消息**（原英文注释讲的是一个很隐蔽的 bug）：
    // 这些边界消息会被原样带进新的历史里。等 REPL 再做一次修剪（prune）时，
    // 它们会被 isCompactBoundaryMessage() 认出来，于是触发一次**不该发生的二次修剪** ——
    // 把刚刚才生成的新边界和新摘要一起删掉。保留新边界就够了，旧边界是历史包袱。
    const messagesToKeep = messages
      .slice(startIndex)
      .filter(m => !isCompactBoundaryMessage(m))

    // Run session start hooks to restore CLAUDE.md and other context
    // 为什么要跑 SessionStart 钩子：压缩之后历史被重写了，诸如 CLAUDE.md、环境变量等
    // 「每次会话开始都要注入」的上下文也一起没了。这里补一次，等价于开一次新会话。
    const hookResults = await processSessionStartHooks('compact', {
      model: getMainLoopModel(),
    })

    // Get transcript path for the summary message
    const transcriptPath = getTranscriptPath()

    const compactionResult = createCompactionResultFromSessionMemory(
      messages,
      sessionMemory,
      messagesToKeep,
      hookResults,
      transcriptPath,
      agentId,
    )

    const postCompactMessages = buildPostCompactMessages(compactionResult)

    const postCompactTokenCount = estimateMessageTokens(postCompactMessages)

    // Only check threshold if one was provided (for autocompact)
    // 兜底校验：如果压完之后还是超过自动压缩阈值，说明这条路没能解决问题，
    // 返回 null 让调用方降级到第四级（整段压缩）。
    // `autoCompactThreshold !== undefined` 这个判断让手动 /compact 可以跳过这道检查 ——
    // 用户主动要求压缩时，就算压完还是很大，也应该照做。
    if (
      autoCompactThreshold !== undefined &&
      postCompactTokenCount >= autoCompactThreshold
    ) {
      logEvent('tengu_sm_compact_threshold_exceeded', {
        postCompactTokenCount,
        autoCompactThreshold,
      })
      return null
    }

    return {
      ...compactionResult,
      postCompactTokenCount,
      truePostCompactTokenCount: postCompactTokenCount,
    }
    // 为什么这里用 logEvent 而不是 logError（原英文注释强调）：
    // 这类错误（文件不存在、路径问题、权限）是**预期内**的降级路径，
    // 记进错误日志会让真正的异常被淹没。所以打成事件；详细堆栈只对内部可见。
  } catch (error) {
    // Use logEvent instead of logError since errors here are expected
    // (e.g., file not found, path issues) and shouldn't go to error logs
    logEvent('tengu_sm_compact_error', {})
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(`Session memory compaction error: ${errorMessage(error)}`)
    }
    return null
  }
}
