/**
 * 【一句话定位】整个「上下文压缩」子系统的**核心实现**：这儿就是真正把长历史压成一份摘要的地方。
 * 四级压缩里最重的第四级（autocompact）由它完成；手动 /compact 与「部分压缩」也走这里。
 *
 * 【在架构中的位置】
 * - 上游：
 *   · src/query.ts 的主循环 —— 它从这里 import 了 buildPostCompactMessages（见 query.ts:13），
 *     用来把压缩结果拼回新一轮的消息数组；
 *   · src/services/compact/autoCompact.ts —— 判定该压缩后调用 compactConversation()；
 *   · /compact 命令与 UI 的消息选择器 —— 调用 compactConversation() / partialCompactConversation()。
 * - 下游：
 *   · ../api/claude.js 的 queryModelWithStreaming() —— **真正发请求给模型生成摘要**
 *   · ../../utils/forkedAgent.js 的 runForkedAgent() —— 另一种更快的实现（复用主线程 prompt 缓存）
 *   · ../../utils/messages.js —— 创建边界消息、找到边界之后的消息等
 *   · ./prompt.js —— 取压缩提示词、把摘要包装成用户消息
 *   · ./grouping.js —— 按 API 往返分组（PTL 重试时用来丢掉最老的几组）
 *   · ../../utils/hooks.js —— PreCompact / PostCompact 钩子
 * - 调用链：src/query.ts（主循环）→ autoCompact.ts（判定阈值）
 *             → 本文件 compactConversation()
 *             → streamCompactSummary()
 *             → 【再一次模型调用】queryModelWithStreaming / runForkedAgent
 *             → 拿到摘要文本 → 拼出「边界消息 + 摘要消息 + 附件」返回给主循环
 *
 * 【最关键的一点：压缩本身就是一次模型调用】
 * 本文件不是「截断历史」，而是**再问一次模型**，让它把历史读一遍并写出结构化摘要：
 *   ① 用 getCompactPrompt()（在 ./prompt.ts）拿到「请你总结一下这段对话」的提示词
 *   ② 把它作为一条 user 消息追加到历史末尾，形成 summaryRequest
 *   ③ 调 streamCompactSummary() 发出请求（见下面它的注释，有「fork 复用缓存」和「直接流式」两条路径）
 *   ④ 拿到模型的纯文本输出作为 summary
 *   ⑤ 丢弃全部原始历史，换成：边界消息 + 摘要消息 + 一批「压缩后要恢复的上下文附件」
 * 所以压缩**很贵**：一次额外的完整请求，输入是整段历史。这就是为什么要分四级、
 * 为什么要优先用 snip / microcompact / session-memory 这些更便宜的手段。
 *
 * 【压缩之后为什么要塞那么多「附件」】
 * 摘要只能记录「发生了什么」，但模型继续干活还需要一些**不会写进摘要**的东西：
 *   · 最近读过的文件内容（否则要重新读一遍）
 *   · 计划文件内容、plan mode 指令
 *   · 用过的 skill 正文
 *   · 后台还在跑的异步代理状态
 *   · 工具清单 / 子代理清单 / MCP 指令的增量公告
 *   · SessionStart 钩子产出的上下文
 * 这些都以 attachment（附件消息）的形式挂在压缩结果上，并且**全部受 token 预算限制**
 * （POST_COMPACT_TOKEN_BUDGET 等几个常量），否则就变成「压缩一次反而更占地方」。
 *
 * 【压缩边界消息（boundary）为什么重要】
 * createCompactBoundaryMessage() 会在历史里插一条特殊标记。之后所有遍历历史的逻辑
 * 都以它为界只处理它**之后**的内容（getMessagesAfterCompactBoundary()）。
 * 因为边界之前的原始消息已经被丢弃，它们的 uuid / tool_use_id 全成了悬空引用 ——
 * 一旦有代码越界往回引用，就会拿到不存在的 ID，API 直接报错。
 * 有了这条边界，「有效历史从哪开始」才有唯一答案。
 *
 * 【本文件包含什么】
 * - POST_COMPACT_* 系列常量：压缩后各类附件的数量与 token 预算。
 * - stripImagesFromMessages() / stripReinjectedAttachments()：发请求前的两道瘦身。
 * - truncateHeadForPTLRetry()：压缩请求自己撞上 prompt_too_long 时的应急截断。
 * - interface CompactionResult / type RecompactionInfo：压缩结果与诊断上下文。
 * - buildPostCompactMessages()：按固定顺序拼出压缩后的消息数组。
 * - annotateBoundaryWithPreservedSegment()：给边界消息打上「保留段落」的重链元数据。
 * - mergeHookInstructions()：合并用户指令与钩子指令。
 * - compactConversation()：【整段压缩】第四级 autocompact 的主体。
 * - partialCompactConversation()：【部分压缩】只压历史的一截。
 * - streamCompactSummary()：【真正发起那次模型调用】两条路径。
 * - createPostCompactFileAttachments() / createPlanAttachmentIfNeeded() /
 *   createSkillAttachmentIfNeeded() / createPlanModeAttachmentIfNeeded() /
 *   createAsyncAgentAttachmentsIfNeeded()：各类「压缩后要恢复的上下文」。
 * - createCompactCanUseTool()：压缩用的禁用工具策略（永远 deny）。
 * - collectReadToolFilePaths() / truncateToTokens() / shouldExcludeFromPostCompactRestore()：辅助函数。
 *
 * 【TS 语法速查】（本文件用到的 TS 特性比较多，逐条对照 Java）
 * - `export interface CompactionResult { ... }`：**几乎等同于** Java 的 interface / record。
 *   TS 里 `interface` 和 `type` 大部分场景可以互换，`type` 更灵活（能表达联合类型）。
 * - 字段后面加 `?`：`messagesToKeep?: Message[]` 表示**可选属性**，≈ Java 的 @Nullable 字段。
 * - `ReturnType<typeof getTokenUsage>`：**工具类型**，取「某个函数的返回值类型」。
 *   ≈ Java 反射拿方法返回类型，但这是编译期、零成本的。
 * - `'from' as const` / `{ type: 'text' as const, ... }`：`as const` 把值**收窄成字面量类型**，
 *   否则 TS 会把它推成更宽的 string。≈ 告诉编译器「这个值就是字面意思，别放宽」。
 * - `as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`：类型断言 ≈ Java 强制类型转换，
 *   这里是给打点字段做「我确认它不是用户隐私数据」的标记。
 * - `flatMap(fn)`：map 之后再拍平一层，≈ Java Stream 的 flatMap。
 *   `.map(block => [block])` + flatMap 的经典用法：可以在遍历中「一条变多条」或「一条变零条」。
 * - `Array/Object.entries(obj).map(([k, v]) => ...)`：**解构数组**，
 *   `Object.entries` 返回 [键, 值] 对的数组，直接用 `[k, v]` 拆开，≈ Java 的 Map.Entry。
 * - `for (;;)`：无限循环，靠内部的 break / throw 退出。Java 里同类写法是 `while(true)`。
 * - `Symbol.asyncIterator` + `await iter.next()` + `while (!next.done)`：
 *   **异步迭代器**的手写遍历 ≈ Java 的 Iterator 拉模型；
 *   `async function*` + `yield` + `for await (const x of gen)` 是同一套语法的糖，
 *   ≈ Java 的 Flux / Reactor 流式处理。这里的生成器 essences上就是 queryModelWithStreaming()。
 * - `(x): x is T => ...`：**类型谓词**，≈ Java 的 instanceof 模式匹配；
 *   用在 `.filter()` 里可以让过滤后的数组元素类型自动收窄（见 1453 行）。
 * - `readonly Message[] | undefined`：`readonly` 修饰表示**不希望通过它修改数组**，
 *   ≈ Java 的不可变集合视图（编译期约束，运行时不生效）。
 * - `Pick<ToolUseContext, 'addNotification'>`：**工具类型**，从类型里挑出部分字段组成新类型。
 *   Java 没有对应物，只能新写一个接口。
 * - `await Promise.all([p1, p2])`：**并发等待**两个 Promise，≈ Java 的 CompletableFuture.allOf + join，
 *   但会自动解包成结果数组，写起来像同步代码。
 * - IIFE `(() => { ... })()` 与 `...(() => {...})()`：定义后**立即执行**并把返回值展开进对象字面量；
 *   这里用来把「可能抛异常的统计逻辑」包一层 try/catch 再铺进打点对象。
 * - `try / catch / finally`：与 Java 完全一致；注意 `finally` 里的 `clearInterval`
 *   无论正常返回还是抛异常都会执行（同 Java）。
 * - `throw error`：catch 里原样重抛（保持调用栈），Java 同理。
 * - `void somePromise`：显式丢弃 Promise 结果，表示「故意不等它」（fire-and-forget）。
 * - `?.` 可选链、`??` 空值合并、`?.()` 可选调用：本文件大量使用，
 *   ≈ Java 里一堆嵌套的 null 检查，这里一行搞定。
 * - `Array.from(set.values())` / `[...set]`：Set / Map → 数组的两种写法。
 * - `setInterval(fn, ms, arg)`：第三个及以后的参数会传给回调 ——这里的 context.setSDKStatus 就是这么传进去的。
 */
import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const sessionTranscriptModule = feature('KAIROS')
  ? (require('../sessionTranscript/sessionTranscript.js') as typeof import('../sessionTranscript/sessionTranscript.js'))
  : null

import { APIUserAbortError } from '@anthropic-ai/sdk'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getInvokedSkillsForAgent } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import {
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
} from '../../tools/FileReadTool/prompt.js'
import { ToolSearchTool } from '../../tools/ToolSearchTool/ToolSearchTool.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  HookResultMessage,
  Message,
  PartialCompactDirection,
  SystemCompactBoundaryMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import {
  createAttachmentMessage,
  generateFileAttachment,
  getAgentListingDeltaAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from '../../utils/attachments.js'
import { getMemoryPath } from '../../utils/config.js'
import { COMPACT_MAX_OUTPUT_TOKENS } from '../../utils/context.js'
import {
  analyzeContext,
  tokenStatsToStatsigMetrics,
} from '../../utils/contextAnalysis.js'
import { logForDebugging } from '../../utils/debug.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { cacheToObject } from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import {
  executePostCompactHooks,
  executePreCompactHooks,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { MEMORY_TYPE_VALUES } from '../../utils/memory/types.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  getAssistantMessageText,
  getLastAssistantMessage,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'
import { expandPath } from '../../utils/path.js'
import { getPlan, getPlanFilePath } from '../../utils/plans.js'
import {
  isSessionActivityTrackingActive,
  sendSessionActivitySignal,
} from '../../utils/sessionActivity.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  getTranscriptPath,
  reAppendSessionMetadata,
} from '../../utils/sessionStorage.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import {
  getTokenUsage,
  tokenCountFromLastAPIResponse,
  tokenCountWithEstimation,
} from '../../utils/tokens.js'
import {
  extractDiscoveredToolNames,
  isToolSearchEnabled,
} from '../../utils/toolSearch.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  getMaxOutputTokensForModel,
  queryModelWithStreaming,
} from '../api/claude.js'
import {
  getPromptTooLongTokenGap,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  startsWithApiErrorPrefix,
} from '../api/errors.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { getRetryDelay } from '../api/withRetry.js'
import { logPermissionContextForAnts } from '../internalLogging.js'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForMessages,
} from '../tokenEstimation.js'
import { groupMessagesByApiRound } from './grouping.js'
import {
  getCompactPrompt,
  getCompactUserSummaryMessage,
  getPartialCompactPrompt,
} from './prompt.js'

// 压缩后「上下文重建」的预算。之所以要限制，是因为这些上下文虽然重要，
// 但全塞回去就等于没压缩 —— 每一类都有条数上限 + token 上限双重约束：
//   MAX_FILES_TO_RESTORE     最多恢复 5 个最近读过的文件
//   TOKEN_BUDGET            文件类附件总量不超过 50k token
//   MAX_TOKENS_PER_FILE     单个文件最多 5k token
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
export const POST_COMPACT_TOKEN_BUDGET = 50_000
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000
// Skills can be large (verify=18.7KB, claude-api=20.1KB). Previously re-injected
// unbounded on every compact → 5-10K tok/compact. Per-skill truncation beats
// dropping — instructions at the top of a skill file are usually the critical
// part. Budget sized to hold ~5 skills at the per-skill cap.
// 中文补充上面那段英文：skill 文件可能很大（verify=18.7KB、claude-api=20.1KB）。
// 早期实现是压缩后**无限制**重新注入，等于每次压缩白送 5-10k token。
// 现在的策略是「每个 skill 单独截断、而不是整个丢掉」——
// 因为 skill 文件开头的安装/用法说明通常才是关键部分，丢整篇损失太大。
// 25k 的总预算按 5k/个算，大致能装下 5 个 skill。
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000
const MAX_COMPACT_STREAMING_RETRIES = 2

/**
 * Strip image blocks from user messages before sending for compaction.
 * Images are not needed for generating a conversation summary and can
 * cause the compaction API call itself to hit the prompt-too-long limit,
 * especially in CCD sessions where users frequently attach images.
 * Replaces image blocks with a text marker so the summary still notes
 * that an image was shared.
 *
 * Note: Only user messages contain images (either directly attached or within
 * tool_result content from tools). Assistant messages contain text, tool_use,
 * and thinking blocks but not images.
 */
/**
 * 在把历史送去生成摘要之前，把里面的**图片 / 文档块**换成一句占位文本。
 *
 * 为什么需要（这段英文注释信息量很大）：
 *   ① 生成摘要不需要看图 —— 图片内容对「对话发生了什么」几乎没有贡献
 *   ② 图片很占 token，留着反而会让**压缩请求自己**撞上 prompt-too-long
 *      （尤其在 CCD 会话里用户经常贴图）
 *   ③ 换成 [image] 标记而不是直接删除 —— 这样摘要里还能看出「用户发过一张图」这个事实
 * 只有 user 消息里可能有图片（直接贴的，或 tool_result 里带回来的）；
 * assistant 消息只有 text / tool_use / thinking，不会有图片。
 *
 * @param messages 原始历史消息。
 * @returns 已替换掉媒体块的新数组（原数组不动）。
 *
 * 为什么要处理「嵌在 tool_result 内部的图片」：结构化工具结果本身也可以再嵌一层内容数组，
 * 只处理顶层是不够的。
 */
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.type !== 'user') {
      return message
    }

    const content = message.message.content
    if (!Array.isArray(content)) {
      return message
    }

    let hasMediaBlock = false
    // flatMap 的妙用：每个分支返回一个**数组**，最后自动拍平。
    //   返回 [v]      = 保留这一条（1 进 1 出）
    //   返回 []       = 删掉这一条
    // ≈ Java Stream 的 flatMap。
    const newContent = content.flatMap(block => {
      if (block.type === 'image') {
        hasMediaBlock = true
        // `as const` 不能省：不加的话 TS 会把 type 推成宽泛的 string，
        // 而这个块的联合类型要求它是**字面量** 'text'。
        return [{ type: 'text' as const, text: '[image]' }]
      }
      if (block.type === 'document') {
        hasMediaBlock = true
        return [{ type: 'text' as const, text: '[document]' }]
      }
      // Also strip images/documents nested inside tool_result content arrays
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        let toolHasMedia = false
        const newToolContent = block.content.map(item => {
          if (item.type === 'image') {
            toolHasMedia = true
            return { type: 'text' as const, text: '[image]' }
          }
          if (item.type === 'document') {
            toolHasMedia = true
            return { type: 'text' as const, text: '[document]' }
          }
          return item
        })
        if (toolHasMedia) {
          hasMediaBlock = true
          return [{ ...block, content: newToolContent }]
        }
      }
      return [block]
    })

    if (!hasMediaBlock) {
      return message
    }

    return {
      ...message,
      message: {
        ...message.message,
        content: newContent,
      },
    } as typeof message
  })
}

/**
 * Strip attachment types that are re-injected post-compaction anyway.
 * skill_discovery/skill_listing are re-surfaced by resetSentSkillNames()
 * + the next turn's discovery signal, so feeding them to the summarizer
 * wastes tokens and pollutes the summary with stale skill suggestions.
 *
 * No-op when EXPERIMENTAL_SKILL_SEARCH is off (the attachment types
 * don't exist on external builds).
 */
/**
 * 丢掉那些「压缩后反正会被重新注入」的附件类型（skill_discovery / skill_listing）。
 *
 * 为什么需要（原文讲得很清楚）：这两类附件在压缩后会由 resetSentSkillNames() 与
 * 下一轮的 discovery signal 重新生成。把它们喂给正在写摘要的模型是纯浪费——
 * 费 token 不说，还会让摘要里混进过时的 skill 建议。
 *
 * 为什么包在 feature('EXPERIMENTAL_SKILL_SEARCH') 里：外部构建根本没有这两种附件类型，
 * 不加这层判断的话类型系统里连这两个字面量都不存在。
 *
 * @param messages 历史消息。
 * @returns 过滤后的消息数组（feature 关闭时原样返回）。
 */
export function stripReinjectedAttachments(messages: Message[]): Message[] {
  if (feature('EXPERIMENTAL_SKILL_SEARCH')) {
    return messages.filter(
      m =>
        !(
          m.type === 'attachment' &&
          (m.attachment.type === 'skill_discovery' ||
            m.attachment.type === 'skill_listing')
        ),
    )
  }
  return messages
}

// 下面三个是「对用户可见」的压缩失败提示，都是**导出常量** —— 调用方要用它们做错误判定，
// 例如 autoCompact.ts 里 hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT) 判断是否用户中止。
export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES =
  'Not enough messages to compact.'
const MAX_PTL_RETRIES = 3
// 我们自己造的一条**占位 user 消息**。为什么需要它：见下面 284 行的注释 ——
// API 要求历史必须以 user 开头，截断之后如果第一条变成 assistant 就得补一条。
const PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'

/**
 * Drops the oldest API-round groups from messages until tokenGap is covered.
 * Falls back to dropping 20% of groups when the gap is unparseable (some
 * Vertex/Bedrock error formats). Returns null when nothing can be dropped
 * without leaving an empty summarize set.
 *
 * This is the last-resort escape hatch for CC-1180 — when the compact request
 * itself hits prompt-too-long, the user is otherwise stuck. Dropping the
 * oldest context is lossy but unblocks them. The reactive-compact path
 * (compactMessages.ts) has the proper retry loop that peels from the tail;
 * this helper is the dumb-but-safe fallback for the proactive/manual path
 * that wasn't migrated in bfdb472f's unification.
 */
/**
 * 当**压缩请求自己**撞上 prompt-too-long 时的应急手段：丢掉最老的若干「API 往返组」，再试一次。
 *
 * 为什么需要（这是一个很典型的死锁场景，务必理解）：
 * 压缩本来是解决「上下文太长」的办法，但如果历史已经长到**连压缩请求本身都发不出去**，
 * 用户就彻底卡住了 —— 不压缩发不出请求，想压缩也发不出请求。
 * 唯一的出路是牺牲一部分最老的历史，把请求压到能发出去为止。丢内容是痛的，但比卡死好。
 *
 * @param messages 上一次尝试用的消息集合。
 * @param ptlResponse prompt-too-long 的那次响应（里面可能带着「超了多少 token」的信息）。
 * @returns 截断后的新消息集合；**返回 null 表示没法再截了**（调用方应放弃重试）。
 *
 * 关键步骤：
 *   ① 先剥掉上一轮重试留下的合成标记消息（否则它会自己独占一组，导致后续 20% 兜底
 *      每次只丢它一个、毫无进展 —— 这是注释里点出的一个真实 bug）
 *   ② 按 API 往返分组（groupMessagesByApiRound）
 *   ③ 优先用错误里带的 tokenGap 精确计算该丢几组；拿不到（某些 Vertex/Bedrock 错误格式
 *      没这个字段）就退化为丢弃 20% 的组数
 *   ④ 至少要留一组（否则没有东西可总结了）
 *   ⑤ 切完之后如果第一条是 assistant，**必须补一条 user 标记消息** —— API 要求首条是 user
 *
 * 为什么按「组」而不是按「条」丢：一条一条丢很可能落在一个 tool_use 和它的 tool_result 中间，
 * 而按 API 往返组丢天然保证切点安全（见 grouping.ts 的说明）。
 */
export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null {
  // Strip our own synthetic marker from a previous retry before grouping.
  // Otherwise it becomes its own group 0 and the 20% fallback stalls
  // (drops only the marker, re-adds it, zero progress on retry 2+).
  const input =
    messages[0]?.type === 'user' &&
    messages[0].isMeta &&
    messages[0].message.content === PTL_RETRY_MARKER
      ? messages.slice(1)
      : messages

  // 按 API 往返分组后再整组丢弃：保证切点不会落在一个 tool_use 与它的 tool_result 之间。
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  const tokenGap = getPromptTooLongTokenGap(ptlResponse)
  let dropCount: number
  if (tokenGap !== undefined) {
    let acc = 0
    dropCount = 0
    for (const g of groups) {
      acc += roughTokenCountEstimationForMessages(g)
      dropCount++
      if (acc >= tokenGap) break
    }
  } else {
    // 拿不到 tokenGap 时的兜底：丢掉 20% 的组。
    // Math.max(1, ...) 保证至少丢 1 组 —— 否则重试毫无进展，会陷入死循环。
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }

  // Keep at least one group so there's something to summarize.
  // 至少留一组：全丢光了就没东西可总结，压缩失去意义。
  dropCount = Math.min(dropCount, groups.length - 1)
  if (dropCount < 1) return null

  const sliced = groups.slice(dropCount).flat()
  // groupMessagesByApiRound puts the preamble in group 0 and starts every
  // subsequent group with an assistant message. Dropping group 0 leaves an
  // assistant-first sequence which the API rejects (first message must be
  // role=user). Prepend a synthetic user marker — ensureToolResultPairing
  // already handles any orphaned tool_results this creates.
    // 这个判断看着奇怪，其实很关键（原英文注释讲得很清楚）：
    // groupMessagesByApiRound 会把「开场白」放在组 0，之后每组都以 assistant 开头。
    // 一旦组 0 被丢掉，剩下的序列就会变成「以 assistant 开头」，而 API 硬性要求
    // **第一条消息必须是 user** —— 直接发过去会被拒绝。
    // 所以补一条合成的 user 标记消息。它可能造成的孤儿 tool_result，
    // 由 ensureToolResultPairing 在真正发请求前统一修补。
  if (sliced[0]?.type === 'assistant') {
    return [
      createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }),
      ...sliced,
    ]
  }
  return sliced
}

export const ERROR_MESSAGE_PROMPT_TOO_LONG =
  'Conversation too long. Press esc twice to go up a few messages and try again.'
export const ERROR_MESSAGE_USER_ABORT = 'API Error: Request was aborted.'
export const ERROR_MESSAGE_INCOMPLETE_RESPONSE =
  'Compaction interrupted · This may be due to network issues — please try again.'

/**
 * 压缩的**统一结果结构**。所有压缩路径（整段、部分、会话记忆）都必须产出它，
 * 这样主循环才能用同一套代码把历史替换掉。
 * 顺序由 buildPostCompactMessages() 统一保证：边界 → 摘要 → 保留的消息 → 附件 → 钩子消息。
 */
export interface CompactionResult {
  /** 【最重要的一项】压缩边界消息。它的位置就是「旧历史」与「新历史」的分界线。 */
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  /** 原样保留、不参与摘要的消息（部分压缩 / 会话记忆压缩才会有）。 */
  messagesToKeep?: Message[]
  userDisplayMessage?: string
  /** 压缩前的 token 数。用于打点与判断「这次压缩到底省了多少」。 */
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  /**
   * 压缩**之后**真实上下文的大小（只算消息本身，不含系统提示与工具定义）。
   * 为什么要单独叫 true：早期字段名 postCompactTokenCount 实际指的是压缩那次请求的用量，
   * 语义混淆过一段时间，所以新字段加了 true 前缀做区分（见 626 行的注释）。
   */
  truePostCompactTokenCount?: number
  compactionUsage?: ReturnType<typeof getTokenUsage>
}

/**
 * Diagnosis context passed from autoCompactIfNeeded into compactConversation.
 * Lets the tengu_compact event disambiguate same-chain loops (H2) from
 * cross-agent (H1/H5) and manual-vs-auto (H3) compactions without joins.
 */
/**
 * 由 autoCompact.ts 传进来的「诊断上下文」。
 *
 * 为什么需要：光看压缩事件本身，很难区分「同一个会话反复压缩形成了环」还是
 * 「不同线程各自压缩了一次」。带上这些字段，分析系统不用做表关联就能分辨，
 * 从而定位「刚压完立刻又要压」这类病态循环。
 */
export type RecompactionInfo = {
  isRecompactionInChain: boolean
  turnsSincePreviousCompact: number
  previousCompactTurnId?: string
  autoCompactThreshold: number
  querySource?: QuerySource
}

/**
 * Build the base post-compact messages array from a CompactionResult.
 * This ensures consistent ordering across all compaction paths.
 * Order: boundaryMarker, summaryMessages, messagesToKeep, attachments, hookResults
 */
/**
 * 把一个 CompactionResult 拼成**压缩后的消息数组**，顺序固定：
 *   边界消息 → 摘要消息 → 保留的消息 → 附件 → 钩子消息
 *
 * 为什么需要：顺序必须是唯一且稳定的。磁盘上的历史是一条链（靠 parentUuid 串起来），
 * 各路径各拼一套顺序的话，恢复会话时就会串错。
 * 抽出这个函数保证**所有压缩路径**共用同一份顺序定义。
 *
 * @param result 压缩结果。
 * @returns 压缩后的完整消息数组（src/query.ts 主循环会用它替换掉旧历史）。
 *
 * `...(result.messagesToKeep ?? [])`：可选数组用展开运算符铺开，
 * 不存在时展开空数组 —— 比写 if 判断简洁得多。
 */
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}

/**
 * Annotate a compact boundary with relink metadata for messagesToKeep.
 * Preserved messages keep their original parentUuids on disk (dedup-skipped);
 * the loader uses this to patch head→anchor and anchor's-other-children→tail.
 *
 * `anchorUuid` = what sits immediately before keep[0] in the desired chain:
 *   - suffix-preserving (reactive/session-memory): last summary message
 *   - prefix-preserving (partial compact): the boundary itself
 */
/**
 * 给边界消息加上「保留段落」的重链（relink）元数据。
 *
 * 为什么需要（牵涉到磁盘上的存储结构，有点绕）：
 * 被保留下来的消息在磁盘上**保持着原来的 parentUuid**（写入时做了去重跳过），
 * 于是它们会和「摘要消息」形成两条链。加载器需要知道怎么把这两条链接回去，
 * 这段元数据就是给它的说明：headUuid 是保留段落的第一条、tailUuid 是最后一条，
 * 而 anchorUuid 是「应该挂在谁后面」。
 *
 * anchorUuid 取哪个值取决于压缩方式（注释里说得很清楚）：
 *   · 后缀保留（reactive / 会话记忆压缩）→ 上一条摘要消息
 *   · 前缀保留（部分压缩 'from'）→ 边界消息本身
 *
 * @param boundary 待增强的边界消息。
 * @param anchorUuid 保留段落应该挂在哪条消息之后。
 * @param messagesToKeep 被保留的消息（可以为空）。
 * @returns 增强后的边界消息（没有保留消息时原样返回）。
 *
 * `keep.at(-1)!`：`.at(-1)` 取最后一个元素（支持负数下标），`!` 是非空断言 ——
 * 因为前面已经确认过 keep.length > 0，编译器还没这么聪明，得手动告诉它。
 */
export function annotateBoundaryWithPreservedSegment(
  boundary: SystemCompactBoundaryMessage,
  anchorUuid: UUID,
  messagesToKeep: readonly Message[] | undefined,
): SystemCompactBoundaryMessage {
  const keep = messagesToKeep ?? []
  if (keep.length === 0) return boundary
  return {
    ...boundary,
    compactMetadata: {
      ...boundary.compactMetadata,
      preservedSegment: {
        headUuid: keep[0]!.uuid,
        anchorUuid,
        tailUuid: keep.at(-1)!.uuid,
      },
    },
  }
}

/**
 * Merges user-supplied custom instructions with hook-provided instructions.
 * User instructions come first; hook instructions are appended.
 * Empty strings normalize to undefined.
 */
/**
 * 把「用户写的压缩指令」与「PreCompact 钩子返回的指令」合并成一份。
 *
 * 为什么需要：两条来源的指令都要生效，而且有优先级 —— 用户的指令排前面（更重要），
 * 钩子指令追加在后面做补充。
 *
 * @param userInstructions 用户在 /compact 时填的自定义指令。
 * @param hookInstructions PreCompact 钩子产出的指令。
 * @returns 合并后的指令；两边都没有时返回 undefined（而不是空字符串）。
 *
 * 为什么偏偏返回 undefined 而不是 ''：下游（getCompactPrompt）用 truthy 判断是否要追加
 * 「Additional Instructions」段落，空字符串会让它多输出一个空标题。
 * 把「没有」统一归一化成 undefined 可以避免这类边界 bug。
 */
export function mergeHookInstructions(
  userInstructions: string | undefined,
  hookInstructions: string | undefined,
): string | undefined {
  if (!hookInstructions) return userInstructions || undefined
  if (!userInstructions) return hookInstructions
  return `${userInstructions}\n\n${hookInstructions}`
}

/**
 * Creates a compact version of a conversation by summarizing older messages
 * and preserving recent conversation history.
 */
/**
 * 【整段压缩】四级压缩里最重的第四级：把**整个**历史交给模型压成一份摘要。
 * 既服务自动压缩（autocompact），也服务用户手动 /compact。
 *
 * 为什么需要：当轻的三级（snip / microcompact / collapse）都撑不住、
 * 或者用户主动要求时，这是最后也是最彻底的一招 —— 代价是细节丢得最多。
 *
 * @param messages 当前完整历史。
 * @param context 工具使用上下文（内含 abort 信号、UI 回调、AppState 等，压缩要靠它跟 UI 交互）。
 * @param cacheSafeParams 与 prompt 缓存兼容的请求参数（压缩请求也要尽量命中缓存）。
 * @param suppressFollowUpQuestions 是否在摘要消息里加上「别反问用户，直接接着干」的指令。
 *        自动压缩传 true（系统自己发起的，用户没让你问）；手动 /compact 传 false。
 * @param customInstructions 用户的自定义压缩指令（可已被 PreCompact 钩子改写）。
 * @param isAutoCompact 是否自动压缩。影响打点、钩子 trigger、以及失败时是否弹通知。
 * @param recompactionInfo 来自 autoCompact.ts 的诊断上下文（可选）。
 * @returns Promise<CompactionResult>：调用方用它重建历史。
 * @throws 多种情况：历史为空、拿不到摘要、API 报错、请求过长且重试无效、被用户中止等。
 *
 * 关键步骤：
 *   ① 记录压缩前 token 数 → 跑 PreCompact 钩子（钩子可以改写 customInstructions）
 *   ② 切 UI 到「正在压缩」状态
 *   ③ 取提示词 getCompactPrompt()，包装成一条 user 消息 summaryRequest
 *   ④ **循环调用** streamCompactSummary() 直到拿到摘要：
 *      如果返回的是 prompt-too-long，就 truncateHeadForPTLRetry() 丢掉最老的几组再试（最多 3 次）
 *   ⑤ 校验摘要有效（非空、不是 API 错误）
 *   ⑥ 保存并清空「已读文件缓存」等被压缩动作弄失效的状态
 *   ⑦ **并行**生成各类压缩后附件（文件 / 异步代理），再依次追加 plan、plan mode、skill、
 *      工具清单、代理清单、MCP 指令
 *   ⑧ 跑 SessionStart 钩子（重新注入 CLAUDE.md 等上下文）
 *   ⑨ 创建**边界消息** + **摘要消息**，计算三个口径的 token 计数
 *   ⑩ 打点 → 重置缓存命中基线 → 重挂会话元数据 → 跑 PostCompact 钩子 → 返回结果
 *
 * 注意 try/catch/finally 的整体结构：catch 里只在**手动压缩**时弹错误通知
 * （自动压缩失败下一轮会重试，弹通知反而困扰用户），然后原样重抛；
 * finally 里无条件把 UI 状态恢复回去 —— 无论成功失败都不能卡在「正在压缩」。
 */
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult> {
  try {
    if (messages.length === 0) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    }

    // tokenCountWithEstimation：优先用上一次 API 响应里的**准确**用量，
    // 拿不到才退回本地粗估。压缩前先记一笔，之后才好算「这次省了多少」。
    const preCompactTokenCount = tokenCountWithEstimation(messages)

    const appState = context.getAppState()
    void logPermissionContextForAnts(appState.toolPermissionContext, 'summary')

    // `?.()` 是可选调用：这些 UI 回调不一定存在（例如 SDK 无 UI 场景），
    // 没有就安静跳过。避免到处写 if (cb) cb(...)。
    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'pre_compact',
    })

    // Execute PreCompact hooks
    // 让外部（SDK / UI / 远端会话）知道现在进入压缩状态了。
    context.setSDKStatus?.('compacting')
    const hookResult = await executePreCompactHooks(
      {
        trigger: isAutoCompact ? 'auto' : 'manual',
        customInstructions: customInstructions ?? null,
      },
      context.abortController.signal,
    )
    customInstructions = mergeHookInstructions(
      customInstructions,
      hookResult.newCustomInstructions,
    )
    const userDisplayMessage = hookResult.userDisplayMessage

    // Show requesting mode with up arrow and custom message
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

    // 3P default: true — forked-agent path reuses main conversation's prompt cache.
    // Experiment (Jan 2026) confirmed: false path is 98% cache miss, costs ~0.76% of
    // fleet cache_creation (~38B tok/day), concentrated in ephemeral envs (CCR/GHA/SDK)
    // with cold GB cache and 3P providers where GB is disabled. GB gate kept as kill-switch.
    // 是否启用「压缩请求复用主线程 prompt 缓存」。默认 true。
    // 原英文注释里有一组很有说服力的数据：关闭时缓存命中率只有 2%，
    // 每天多产生约 380 亿 token 的 cache_creation，而且集中在 CCR/GHA/SDK 这类
    // 短命环境（冷 GrowthBook 缓存 + 三方 provider）。保留 GB 开关只为了随时能关。
    const promptCacheSharingEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_compact_cache_prefix',
      true,
    )

    // 提示词本体在 ./prompt.ts。注意它是**追加到历史末尾**的一条 user 消息，
    // 而不是 system prompt —— 这样整个请求的前缀与普通请求高度一致，有利于命中缓存。
    const compactPrompt = getCompactPrompt(customInstructions)
    const summaryRequest = createUserMessage({
      content: compactPrompt,
    })

    let messagesToSummarize = messages
    let retryCacheSafeParams = cacheSafeParams
    let summaryResponse: AssistantMessage
    let summary: string | null
    let ptlAttempts = 0
    // 无限循环 + 内部 break：这是 TS 里表达「重试直到成功」的常见写法，
    // 退出条件分散在下面各处（成功 break / 无法重试就 throw）。
    for (;;) {
      // 【这里就是「让模型生成摘要」的地方】——压缩的全部魔法都在这一次调用里。
      // 它内部会**再发一次完整的模型请求**，输入是整段历史 + 一句「请总结」。
      summaryResponse = await streamCompactSummary({
        messages: messagesToSummarize,
        summaryRequest,
        appState,
        context,
        preCompactTokenCount,
        cacheSafeParams: retryCacheSafeParams,
      })
      // 从 assistant 消息里抽出纯文本。模型被要求输出 <analysis> + <summary> 两段，
      // 后面 formatCompactSummary()（在 prompt.ts）会把草稿剥掉。
      summary = getAssistantMessageText(summaryResponse)
      // 拿到正常摘要 → 跳出重试循环。
      // 如果返回的是 prompt-too-long（说明**压缩请求本身**太长），就继续往下走重试逻辑。
      if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break

      // CC-1180: compact request itself hit prompt-too-long. Truncate the
      // oldest API-round groups and retry rather than leaving the user stuck.
      ptlAttempts++
      const truncated =
        ptlAttempts <= MAX_PTL_RETRIES
          ? truncateHeadForPTLRetry(messagesToSummarize, summaryResponse)
          : null
      if (!truncated) {
        logEvent('tengu_compact_failed', {
          reason:
            'prompt_too_long' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          preCompactTokenCount,
          promptCacheSharingEnabled,
          ptlAttempts,
        })
        throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
      }
      logEvent('tengu_compact_ptl_retry', {
        attempt: ptlAttempts,
        droppedMessages: messagesToSummarize.length - truncated.length,
        remainingMessages: truncated.length,
      })
      // 丢掉最老的几组后重试。注意这里同时更新了 cacheSafeParams.forkContextMessages ——
      // 因为 fork 那条路径读的是它对沟 messages 参数，两边都要同步，否则会各说各话。
      messagesToSummarize = truncated
      // The forked-agent path reads from cacheSafeParams.forkContextMessages,
      // not the messages param — thread the truncated set through both paths.
      retryCacheSafeParams = {
        ...retryCacheSafeParams,
        forkContextMessages: truncated,
      }
    }

    if (!summary) {
      logForDebugging(
        `Compact failed: no summary text in response. Response: ${jsonStringify(summaryResponse)}`,
        { level: 'error' },
      )
      logEvent('tengu_compact_failed', {
        reason:
          'no_summary' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        preCompactTokenCount,
        promptCacheSharingEnabled,
      })
      throw new Error(
        `Failed to generate conversation summary - response did not contain valid text content`,
      )
    } else if (startsWithApiErrorPrefix(summary)) {
      logEvent('tengu_compact_failed', {
        reason:
          'api_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        preCompactTokenCount,
        promptCacheSharingEnabled,
      })
      throw new Error(summary)
    }

    // Store the current file state before clearing
    // 清空「已读文件」缓存之前先拍个快照：待会儿要靠它把最近读过的文件内容重新挂回来，
    // 省得模型压缩完之后又得重读一遍。
    const preCompactReadFileState = cacheToObject(context.readFileState)

    // Clear the cache
    context.readFileState.clear()
    context.loadedNestedMemoryPaths?.clear()

    // 中文补充上面那段英文：**故意不**重置 sentSkillNames。
    // 重新注入整份 skill_listing 约 4k token，全是 cache_creation 开销，收益极低；
    // 模型 schema 里仍有 SkillTool，用过的 skill 由下面的 invoked_skills 附件保留。
    // Intentionally NOT resetting sentSkillNames: re-injecting the full
    // skill_listing (~4K tokens) post-compact is pure cache_creation with
    // marginal benefit. The model still has SkillTool in its schema and
    // invoked_skills attachment (below) preserves used-skill content. Ants
    // with EXPERIMENTAL_SKILL_SEARCH already skip re-injection via the
    // early-return in getSkillListingAttachments.

    // Run async attachment generation in parallel
    // Promise.all = **并发**等待两个异步任务（≈ Java 的 CompletableFuture.allOf + join，
    // 但结果自动解包成数组）。这两件事互不依赖，串行做白白多花一倍时间。
    const [fileAttachments, asyncAgentAttachments] = await Promise.all([
      createPostCompactFileAttachments(
        preCompactReadFileState,
        context,
        POST_COMPACT_MAX_FILES_TO_RESTORE,
      ),
      createAsyncAgentAttachmentsIfNeeded(context),
    ])

    const postCompactFileAttachments: AttachmentMessage[] = [
      ...fileAttachments,
      ...asyncAgentAttachments,
    ]
    const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
    if (planAttachment) {
      postCompactFileAttachments.push(planAttachment)
    }

    // Add plan mode instructions if currently in plan mode, so the model
    // continues operating in plan mode after compaction
    // 为什么 plan mode 要单独处理：那些「你现在处于 plan mode」的指令平时是靠
    // getAttachmentMessages 在有工具调用的轮次里注入的，压缩后如果不补一条，
    // 模型就会忘了自己在 plan mode 里、开始直接改代码。
    const planModeAttachment = await createPlanModeAttachmentIfNeeded(context)
    if (planModeAttachment) {
      postCompactFileAttachments.push(planModeAttachment)
    }

    // Add skill attachment if skills were invoked in this session
    const skillAttachment = createSkillAttachmentIfNeeded(context.agentId)
    if (skillAttachment) {
      postCompactFileAttachments.push(skillAttachment)
    }

    // Compaction ate prior delta attachments. Re-announce from the current
    // state so the model has tool/instruction context on the first
    // post-compact turn. Empty message history → diff against nothing →
    // announces the full set.
    // 三个 xxxDeltaAttachment 的共同思路：告诉模型「现在有哪些工具/子代理/MCP 指令」。
    // 传空数组作为基准 → 相当于重新公告**全集**（因为压缩后历史里已经一条不剩了）。
    for (const att of getDeferredToolsDeltaAttachment(
      context.options.tools,
      context.options.mainLoopModel,
      [],
      { callSite: 'compact_full' },
    )) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }
    for (const att of getAgentListingDeltaAttachment(context, [])) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }
    for (const att of getMcpInstructionsDeltaAttachment(
      context.options.mcpClients,
      context.options.tools,
      context.options.mainLoopModel,
      [],
    )) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'session_start',
    })
    // Execute SessionStart hooks after successful compaction
    // 跑 SessionStart 钩子：压缩后历史被重写，相当于开了个新会话，
    // 那些「每次会话开始都要注入」的上下文（CLAUDE.md、环境变量等）必须补回来。
    const hookMessages = await processSessionStartHooks('compact', {
      model: context.options.mainLoopModel,
    })

    // Create the compact boundary marker and summary messages before the
    // event so we can compute the true resulting-context size.
    // 【整段压缩的核心产物之一】压缩边界消息。它之后的所有历史才是「有效历史」。
    // 之所以要在打点事件**之前**创建它，是为了能用它参与计算压缩后的真实上下文大小。
    const boundaryMarker = createCompactBoundaryMessage(
      isAutoCompact ? 'auto' : 'manual',
      preCompactTokenCount ?? 0,
      messages.at(-1)?.uuid,
    )
    // Carry loaded-tool state — the summary doesn't preserve tool_reference
    // blocks, so the post-compact schema filter needs this to keep sending
    // already-loaded deferred tool schemas to the API.
    // 摘要会丢掉 tool_reference 块，因此需要把「已经加载了哪些延迟工具」记在边界元数据里，
    // 压缩后才能真正干活时继续把它们的 schema 发给 API。
    const preCompactDiscovered = extractDiscoveredToolNames(messages)
    if (preCompactDiscovered.size > 0) {
      boundaryMarker.compactMetadata.preCompactDiscoveredTools = [
        ...preCompactDiscovered,
      ].sort()
    }

    const transcriptPath = getTranscriptPath()
    const summaryMessages: UserMessage[] = [
      createUserMessage({
        content: getCompactUserSummaryMessage(
          summary,
          suppressFollowUpQuestions,
          transcriptPath,
        ),
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]

    // Previously "postCompactTokenCount" — renamed because this is the
    // compact API call's total usage (input_tokens ≈ preCompactTokenCount),
    // NOT the size of the resulting context. Kept for event-field continuity.
    // 注意这个变量的语义：**压缩那次请求**的用量，不是压缩后上下文的大小。
    // 早期字段名就叫 postCompactTokenCount，语义混淆过，所以新字段改用 true 前缀区分。
    const compactionCallTotalTokens = tokenCountFromLastAPIResponse([
      summaryResponse,
    ])

    // Message-payload estimate of the resulting context. The next iteration's
    // shouldAutoCompact will see this PLUS ~20-40K for system prompt + tools +
    // userContext (via API usage.input_tokens). So `willRetriggerNextTurn: true`
    // is a strong signal; `false` may still retrigger when this is close to threshold.
    // 真正「压缩之后的上下文」大小 = 边界 + 摘要 + 附件 + 钩子消息。
    // 注意它还**不含**系统提示、工具定义、userContext（那些约 20-40k，要等下次 API 响应才知道）。
    // 所以打点里的 willRetriggerNextTurn=true 是强信号，false 时仍有可能触发下一轮压缩。
    const truePostCompactTokenCount = roughTokenCountEstimationForMessages([
      boundaryMarker,
      ...summaryMessages,
      ...postCompactFileAttachments,
      ...hookMessages,
    ])

    // Extract compaction API usage metrics
    const compactionUsage = getTokenUsage(summaryResponse)

    const querySourceForEvent =
      recompactionInfo?.querySource ?? context.options.querySource ?? 'unknown'

    logEvent('tengu_compact', {
      preCompactTokenCount,
      // Kept for continuity — semantically the compact API call's total usage
      postCompactTokenCount: compactionCallTotalTokens,
      truePostCompactTokenCount,
      autoCompactThreshold: recompactionInfo?.autoCompactThreshold ?? -1,
      willRetriggerNextTurn:
        recompactionInfo !== undefined &&
        truePostCompactTokenCount >= recompactionInfo.autoCompactThreshold,
      isAutoCompact,
      querySource:
        querySourceForEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryChainId: (context.queryTracking?.chainId ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      queryDepth: context.queryTracking?.depth ?? -1,
      isRecompactionInChain: recompactionInfo?.isRecompactionInChain ?? false,
      turnsSincePreviousCompact:
        recompactionInfo?.turnsSincePreviousCompact ?? -1,
      previousCompactTurnId: (recompactionInfo?.previousCompactTurnId ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      compactionInputTokens: compactionUsage?.input_tokens,
      compactionOutputTokens: compactionUsage?.output_tokens,
      compactionCacheReadTokens: compactionUsage?.cache_read_input_tokens ?? 0,
      compactionCacheCreationTokens:
        compactionUsage?.cache_creation_input_tokens ?? 0,
      compactionTotalTokens: compactionUsage
        ? compactionUsage.input_tokens +
          (compactionUsage.cache_creation_input_tokens ?? 0) +
          (compactionUsage.cache_read_input_tokens ?? 0) +
          compactionUsage.output_tokens
        : 0,
      promptCacheSharingEnabled,
      // analyzeContext walks every content block (~11ms on a 4.5K-message
      // session) purely for this telemetry breakdown. Computed here, past
      // the compaction-API await, so the sync walk doesn't starve the
      // render loop before compaction even starts. Same deferral pattern
      // as reactiveCompact.ts.
      // 立即执行函数（IIFE）：把统计逻辑包一层 try/catch，再把返回值**展开**进打点对象。
      // 为什么放在这里、用 try/catch 包住：analyzeContext 要遍历所有内容块，
      // 在 4.5k 条消息的会话上约 11ms —— 这是同步的，放在 await 之后可以避免
      // 在压缩真正开始前就卡住渲染循环。而且它只是遥测，失败也不能影响主流程。
      ...(() => {
        try {
          return tokenStatsToStatsigMetrics(analyzeContext(messages))
        } catch (error) {
          logError(error as Error)
          return {}
        }
      })(),
    })

    // Reset cache read baseline so the post-compact drop isn't flagged as a break
    // 重置「缓存命中基线」：压缩后 cache read 必然下降，但那是**我们自己**造成的，
    // 不重置的话监控系统会把它误判成「缓存被打断了」。
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(
        context.options.querySource ?? 'compact',
        context.agentId,
      )
    }
    markPostCompaction()

    // Re-append session metadata (custom title, tag) so it stays within
    // the 16KB tail window that readLiteMetadata reads for --resume display.
    // Without this, enough post-compaction messages push the metadata entry
    // out of the window, causing --resume to show the auto-generated title
    // instead of the user-set session name.
    // 把会话元数据（自定义标题、标签）重新追加到日志尾部。
    // 原因很实际：readLiteMetadata 只读最后 16KB，压缩后再写一堆消息就会把它挤出这个窗口，
    // 于是 --resume 列表里显示的就变成自动生成的标题，而不是用户自己起的名字。
    reAppendSessionMetadata()

    // Write a reduced transcript segment for the pre-compaction messages
    // (assistant mode only). Fire-and-forget — errors are logged internally.
    if (feature('KAIROS')) {
      void sessionTranscriptModule?.writeSessionTranscriptSegment(messages)
    }

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'post_compact',
    })
    const postCompactHookResult = await executePostCompactHooks(
      {
        trigger: isAutoCompact ? 'auto' : 'manual',
        compactSummary: summary,
      },
      context.abortController.signal,
    )

    const combinedUserDisplayMessage = [
      userDisplayMessage,
      postCompactHookResult.userDisplayMessage,
    ]
      .filter(Boolean)
      .join('\n')

    // 返回统一结构 CompactionResult。主循环会用 buildPostCompactMessages() 把它拼成新历史。
    return {
      boundaryMarker,
      summaryMessages,
      attachments: postCompactFileAttachments,
      hookResults: hookMessages,
      userDisplayMessage: combinedUserDisplayMessage || undefined,
      preCompactTokenCount,
      postCompactTokenCount: compactionCallTotalTokens,
      truePostCompactTokenCount,
      compactionUsage,
    }
    // 失败处理的原则：错误一律**原样重抛**（保留调用栈，让上游决定怎么办），
    // 本层只负责 UI 通知。
  } catch (error) {
    // Only show the error notification for manual /compact.
    // Auto-compact failures are retried on the next turn and the
    // notification is confusing when compaction eventually succeeds.
      // 只在手动 /compact 时弹错误通知。
      // 自动压缩失败下一轮会自动重试，而且常常下一次就成功了 —— 这时弹通知纯属打扰。
    if (!isAutoCompact) {
      addErrorNotificationIfNeeded(error, context)
    }
    throw error
    // finally 保证 UI 状态一定会被还原，不会因为抛异常就永远卡在「正在压缩」。
    // ≈ Java 的 finally，语义完全一致。
  } finally {
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_end' })
    context.setSDKStatus?.(null)
  }
}

/**
 * Performs a partial compaction around the selected message index.
 * Direction 'from': summarizes messages after the index, keeps earlier ones.
 *   Prompt cache for kept (earlier) messages is preserved.
 * Direction 'up_to': summarizes messages before the index, keeps later ones.
 *   Prompt cache is invalidated since the summary precedes the kept messages.
 */
/**
 * 【部分压缩】只把历史的**一截**压成摘要，另一截原样保留。用户在界面上选一条消息作为分界时走这里。
 *
 * 为什么需要：整段压缩（compactConversation）丢细节太多。很多时候用户只想
 * 「把中间那堆啰嗦的调试过程压掉」，前后都还想留着。
 *
 * @param allMessages 完整历史。
 * @param pivotIndex 分界点在数组中的下标。
 * @param context 工具使用上下文。
 * @param cacheSafeParams 缓存兼容参数。
 * @param userFeedback 用户额外补充的上下文（会被塞进 prompt 的 User context 段）。
 * @param direction 压缩方向，决定哪一截被摘要：
 *        'from'  = 摘要 **pivotIndex 之后**的消息，之前的保留（默认）
 *        'up_to' = 摘要 **pivotIndex 之前**的消息，之后的保留
 * @returns Promise<CompactionResult>。
 *
 * 两个方向有个重要区别（原英文注释的核心）：
 *   'from'  —— 保留的是**前缀**，摘要在后。发送请求时可以直接喂才是要被摘要的那一截，
 *              而且保留的前缀还能命中缓存。
 *   'up_to' —— 保留的是**后缀**，摘要在前。缓存必然失效；而且必须先把旧的边界消息和
 *              旧摘要从保留部分里**剔除**，否则它们会在「找最后一个边界」的反向扫描中胜出，
 *              把刚生成的新摘要顶掉。
 *
 * 关键步骤（与 compactConversation 大体相同，差异在 ⑤⑥）：
 *   ① 按 direction 切出 messagesToSummarize 与 messagesToKeep
 *   ② 跑 PreCompact 钩子，把钩子指令与用户反馈合并
 *   ③ 取 **部分压缩专用**的提示词 getPartialCompactPrompt()
 *   ④ 同样循环调用 streamCompactSummary()（含 PTL 重试）
 *   ⑤ 生成附件时把 messagesToKeep 传进去 —— 已经在那里的 Read 结果就不用重复注入了
 *   ⑥ 创建边界消息时带上 userFeedback 与被摘要的条数，并按 direction 选好 anchorUuid
 *   ⑦ 跑 PostCompact 钩子、重置缓存基线、返回
 */
export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from',
): Promise<CompactionResult> {
  try {
    // 方向的唯一区别体现在这两个 slice 上：
    //   'up_to' → 要摘要的是 [0, pivotIndex)，要保留的是 [pivotIndex, end)
    //   'from'  → 要摘要的是 [pivotIndex, end)，要保留的是 [0, pivotIndex)
    const messagesToSummarize =
      direction === 'up_to'
        ? allMessages.slice(0, pivotIndex)
        : allMessages.slice(pivotIndex)
    // 'up_to' must strip old compact boundaries/summaries: for 'up_to',
    // summary_B sits BEFORE kept, so a stale boundary_A in kept wins
    // findLastCompactBoundaryIndex's backward scan and drops summary_B.
    // 'from' keeps them: summary_B sits AFTER kept (backward scan still
    // works), and removing an old summary would lose its covered history.
    // 为什么 'up_to' 要额外过滤掉三类消息（原英文注释讲得很清楚）：
    // 旧的边界消息(prev)、旧摘要(user+isCompactSummary)、以及 progress 消息。
    // 因为它们会使「从后往前找最后一个边界」的扫描找到**旧的**那个，
    // 从而把本次新生成的摘要 summary_B 丢掉。
    // 'from' 方向不用剔除 —— 旧摘要在保留区之后，反向扫描先碰到新的那个，不会出错；
    // 而且删掉旧摘要意味着它覆盖的历史信息也一起丢了。
    const messagesToKeep =
      direction === 'up_to'
        ? allMessages
            .slice(pivotIndex)
            .filter(
              m =>
                m.type !== 'progress' &&
                !isCompactBoundaryMessage(m) &&
                !(m.type === 'user' && m.isCompactSummary),
            )
        : allMessages.slice(0, pivotIndex).filter(m => m.type !== 'progress')

    if (messagesToSummarize.length === 0) {
      throw new Error(
        direction === 'up_to'
          ? 'Nothing to summarize before the selected message.'
          : 'Nothing to summarize after the selected message.',
      )
    }

    const preCompactTokenCount = tokenCountWithEstimation(allMessages)

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'pre_compact',
    })

    context.setSDKStatus?.('compacting')
    const hookResult = await executePreCompactHooks(
      {
        trigger: 'manual',
        customInstructions: null,
      },
      context.abortController.signal,
    )

    // Merge hook instructions with user feedback
    let customInstructions: string | undefined
    if (hookResult.newCustomInstructions && userFeedback) {
      customInstructions = `${hookResult.newCustomInstructions}\n\nUser context: ${userFeedback}`
    } else if (hookResult.newCustomInstructions) {
      customInstructions = hookResult.newCustomInstructions
    } else if (userFeedback) {
      customInstructions = `User context: ${userFeedback}`
    }

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

    // 与整段压缩不同，这里用的是**部分压缩**的提示词模板，
    // 它会明确告诉模型「你只需要总结这一截」以及这一截的位置关系。
    const compactPrompt = getPartialCompactPrompt(customInstructions, direction)
    const summaryRequest = createUserMessage({
      content: compactPrompt,
    })

    const failureMetadata = {
      preCompactTokenCount,
      direction:
        direction as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      messagesSummarized: messagesToSummarize.length,
    }

    // 'up_to' prefix hits cache directly; 'from' sends all (tail wouldn't cache).
    // PTL retry breaks the cache prefix but unblocks the user (CC-1180).
    // 为什么两个方向喂给模型的东西不一样（一处很容易看漏的优化）：
    //   'up_to' → 直接喂**前缀**，它能命中缓存
    //   'from'  → 必须喂**全部**历史（要摘要的在尾部，只发尾部本来就缓存不了）
    let apiMessages = direction === 'up_to' ? messagesToSummarize : allMessages
    let retryCacheSafeParams =
      direction === 'up_to'
        ? { ...cacheSafeParams, forkContextMessages: messagesToSummarize }
        : cacheSafeParams
    let summaryResponse: AssistantMessage
    let summary: string | null
    let ptlAttempts = 0
    for (;;) {
      summaryResponse = await streamCompactSummary({
        messages: apiMessages,
        summaryRequest,
        appState: context.getAppState(),
        context,
        preCompactTokenCount,
        cacheSafeParams: retryCacheSafeParams,
      })
      summary = getAssistantMessageText(summaryResponse)
      if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break

      ptlAttempts++
      const truncated =
        ptlAttempts <= MAX_PTL_RETRIES
          ? truncateHeadForPTLRetry(apiMessages, summaryResponse)
          : null
      if (!truncated) {
        logEvent('tengu_partial_compact_failed', {
          reason:
            'prompt_too_long' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...failureMetadata,
          ptlAttempts,
        })
        throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
      }
      logEvent('tengu_compact_ptl_retry', {
        attempt: ptlAttempts,
        droppedMessages: apiMessages.length - truncated.length,
        remainingMessages: truncated.length,
        path: 'partial' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      apiMessages = truncated
      retryCacheSafeParams = {
        ...retryCacheSafeParams,
        forkContextMessages: truncated,
      }
    }
    if (!summary) {
      logEvent('tengu_partial_compact_failed', {
        reason:
          'no_summary' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...failureMetadata,
      })
      throw new Error(
        'Failed to generate conversation summary - response did not contain valid text content',
      )
    } else if (startsWithApiErrorPrefix(summary)) {
      logEvent('tengu_partial_compact_failed', {
        reason:
          'api_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...failureMetadata,
      })
      throw new Error(summary)
    }

    // Store the current file state before clearing
    const preCompactReadFileState = cacheToObject(context.readFileState)
    context.readFileState.clear()
    context.loadedNestedMemoryPaths?.clear()
    // Intentionally NOT resetting sentSkillNames — see compactConversation()
    // for rationale (~4K tokens saved per compact event).

    const [fileAttachments, asyncAgentAttachments] = await Promise.all([
      createPostCompactFileAttachments(
        preCompactReadFileState,
        context,
        POST_COMPACT_MAX_FILES_TO_RESTORE,
        messagesToKeep,
      ),
      createAsyncAgentAttachmentsIfNeeded(context),
    ])

    const postCompactFileAttachments: AttachmentMessage[] = [
      ...fileAttachments,
      ...asyncAgentAttachments,
    ]
    const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
    if (planAttachment) {
      postCompactFileAttachments.push(planAttachment)
    }

    // Add plan mode instructions if currently in plan mode
    const planModeAttachment = await createPlanModeAttachmentIfNeeded(context)
    if (planModeAttachment) {
      postCompactFileAttachments.push(planModeAttachment)
    }

    const skillAttachment = createSkillAttachmentIfNeeded(context.agentId)
    if (skillAttachment) {
      postCompactFileAttachments.push(skillAttachment)
    }

    // Re-announce only what was in the summarized portion — messagesToKeep
    // is scanned, so anything already announced there is skipped.
    for (const att of getDeferredToolsDeltaAttachment(
      context.options.tools,
      context.options.mainLoopModel,
      messagesToKeep,
      { callSite: 'compact_partial' },
    )) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }
    for (const att of getAgentListingDeltaAttachment(context, messagesToKeep)) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }
    for (const att of getMcpInstructionsDeltaAttachment(
      context.options.mcpClients,
      context.options.tools,
      context.options.mainLoopModel,
      messagesToKeep,
    )) {
      postCompactFileAttachments.push(createAttachmentMessage(att))
    }

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'session_start',
    })
    const hookMessages = await processSessionStartHooks('compact', {
      model: context.options.mainLoopModel,
    })

    const postCompactTokenCount = tokenCountFromLastAPIResponse([
      summaryResponse,
    ])
    const compactionUsage = getTokenUsage(summaryResponse)

    logEvent('tengu_partial_compact', {
      preCompactTokenCount,
      postCompactTokenCount,
      messagesKept: messagesToKeep.length,
      messagesSummarized: messagesToSummarize.length,
      direction:
        direction as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasUserFeedback: !!userFeedback,
      trigger:
        'message_selector' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      compactionInputTokens: compactionUsage?.input_tokens,
      compactionOutputTokens: compactionUsage?.output_tokens,
      compactionCacheReadTokens: compactionUsage?.cache_read_input_tokens ?? 0,
      compactionCacheCreationTokens:
        compactionUsage?.cache_creation_input_tokens ?? 0,
    })

    // Progress messages aren't loggable, so forkSessionImpl would null out
    // a logicalParentUuid pointing at one. Both directions skip them.
    const lastPreCompactUuid =
      direction === 'up_to'
        ? allMessages.slice(0, pivotIndex).findLast(m => m.type !== 'progress')
            ?.uuid
        : messagesToKeep.at(-1)?.uuid
    // 这里比整段压缩多传了两个参数：userFeedback（用户补充的上下文）与被摘要的消息条数。
    // 另外 lastPreCompactUuid 要跳过 progress 消息 —— 那种消息不可作为父节点，
    // 否则 forkSessionImpl 会把 logicalParentUuid 置空。
    const boundaryMarker = createCompactBoundaryMessage(
      'manual',
      preCompactTokenCount ?? 0,
      lastPreCompactUuid,
      userFeedback,
      messagesToSummarize.length,
    )
    // allMessages not just messagesToSummarize — set union is idempotent,
    // simpler than tracking which half each tool lived in.
    const preCompactDiscovered = extractDiscoveredToolNames(allMessages)
    if (preCompactDiscovered.size > 0) {
      boundaryMarker.compactMetadata.preCompactDiscoveredTools = [
        ...preCompactDiscovered,
      ].sort()
    }

    const transcriptPath = getTranscriptPath()
    const summaryMessages: UserMessage[] = [
      createUserMessage({
        content: getCompactUserSummaryMessage(summary, false, transcriptPath),
        isCompactSummary: true,
        ...(messagesToKeep.length > 0
          ? {
              summarizeMetadata: {
                messagesSummarized: messagesToSummarize.length,
                userContext: userFeedback,
                direction,
              },
            }
          : { isVisibleInTranscriptOnly: true as const }),
      }),
    ]

    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(
        context.options.querySource ?? 'compact',
        context.agentId,
      )
    }
    markPostCompaction()

    // Re-append session metadata (custom title, tag) so it stays within
    // the 16KB tail window that readLiteMetadata reads for --resume display.
    reAppendSessionMetadata()

    if (feature('KAIROS')) {
      void sessionTranscriptModule?.writeSessionTranscriptSegment(
        messagesToSummarize,
      )
    }

    context.onCompactProgress?.({
      type: 'hooks_start',
      hookType: 'post_compact',
    })
    const postCompactHookResult = await executePostCompactHooks(
      {
        trigger: 'manual',
        compactSummary: summary,
      },
      context.abortController.signal,
    )

    // 'from': prefix-preserving → boundary; 'up_to': suffix → last summary
    // 「保留段落该挂在哪条消息后面」取决于压缩方式：
    //   'up_to' → 摘要在新的前面，所以挂在**最后一条摘要消息**后面
    //   'from'  → 摘要在保留区之后，直接挂在**边界消息**后面即可
    const anchorUuid =
      direction === 'up_to'
        ? (summaryMessages.at(-1)?.uuid ?? boundaryMarker.uuid)
        : boundaryMarker.uuid
    return {
      boundaryMarker: annotateBoundaryWithPreservedSegment(
        boundaryMarker,
        anchorUuid,
        messagesToKeep,
      ),
      summaryMessages,
      messagesToKeep,
      attachments: postCompactFileAttachments,
      hookResults: hookMessages,
      userDisplayMessage: postCompactHookResult.userDisplayMessage,
      preCompactTokenCount,
      postCompactTokenCount,
      compactionUsage,
    }
  } catch (error) {
    addErrorNotificationIfNeeded(error, context)
    throw error
  } finally {
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_end' })
    context.setSDKStatus?.(null)
  }
}

/**
 * 压缩失败时在 UI 上弹一条错误通知（**跳过**两类不需要打扰用户的情况）。
 *
 * 为什么要有例外：用户按 Esc 主动中止、以及「历史太少没得压」，
 * 这两种都不是故障，弹红色报错纯属虚惊一场。
 *
 * @param error 抛出的错误。
 * @param context 只需要其中的 addNotification 方法（用 Pick 精确取所需字段，
 *        这样测试时可以只传一个假对象，不必构造完整的 ToolUseContext）。
 */
function addErrorNotificationIfNeeded(
  error: unknown,
  context: Pick<ToolUseContext, 'addNotification'>,
) {
  if (
    !hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT) &&
    !hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
  ) {
    context.addNotification?.({
      key: 'error-compacting-conversation',
      text: 'Error compacting conversation',
      priority: 'immediate',
      color: 'error',
    })
  }
}

/**
 * 生成一个「任何工具都不允许使用」的权限决策函数，供压缩用的代理使用。
 *
 * 为什么需要：压缩代理的任务是**输出一段文本摘要**，不是干活。
 * 它会调工具一是浪费轮次，二是可能产生副作用（改文件、跑命令）。
 * 所以这里返回一个恒返回 deny 的策略 —— 比在 schema 里干脆**不声明**任何工具更保险，
 * 因为某些模型就算没有工具也会试图调用（参见 prompt.ts 里那段 watermelon 的强硬禁令）。
 *
 * @returns 一个 CanUseToolFn（返回 Promise，因为权限判定本身可能是异步的）。
 */
export function createCompactCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny' as const,
    message: 'Tool use is not allowed during compaction',
    decisionReason: {
      type: 'other' as const,
      reason: 'compaction agent should only produce text summary',
    },
  })
}

/**
 * 【真正发起「生成摘要」那次模型调用】—— 本文件的发动机。
 *
 * 为什么分成两条路径：
 *   ① **fork 路径（默认）**：runForkedAgent() 派生一个代理去跑这次请求。
 *      好处：它可以发送与主线程**完全相同的 cache-key 参数**（系统提示、工具、模型、
 *      历史前缀、thinking 配置），从而复用主线程刚刚建立的那份 prompt 缓存 —— 
 *      否则整段历史要重新成分地 cache_creation，成本极高。
 *   ② **流式路径（兜底）**：直接 queryModelWithStreaming() 发请求，
 *      不共享缓存，但可以逐字流式地把进度显示给用户（也在 fork 失败时使用）。
 * 先试 ①，失败或没有产出就降级到 ②。
 *
 * @returns Promise<AssistantMessage>：包含摘要文本的那条 assistant 消息。
 *
 * 关键步骤：
 *   ① 读「是否启用缓存共享」的远程开关
 *   ② 起一个每 30 秒发一次心跳的定时器（防止远端会话 WebSocket 因空闲被断开）
 *   ③ 缓存共享开启 → 调 runForkedAgent()，成功拿到文本就返回
 *   ④ 否则（或失败）→ 进入流式路径，按配置的次数重试
 *   ⑤ finally 里**必须**清掉心跳定时器（否则会泄漏）
 */
async function streamCompactSummary({
  messages,
  summaryRequest,
  appState,
  context,
  preCompactTokenCount,
  cacheSafeParams,
}: {
  messages: Message[]
  summaryRequest: UserMessage
  appState: Awaited<ReturnType<ToolUseContext['getAppState']>>
  context: ToolUseContext
  preCompactTokenCount: number
  cacheSafeParams: CacheSafeParams
}): Promise<AssistantMessage> {
  // When prompt cache sharing is enabled, use forked agent to reuse the
  // main conversation's cached prefix (system prompt, tools, context messages).
  // Falls back to regular streaming path on failure.
  // 3P default: true — see comment at the other tengu_compact_cache_prefix read above.
  const promptCacheSharingEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_compact_cache_prefix',
    true,
  )
  // Send keep-alive signals during compaction to prevent remote session
  // WebSocket idle timeouts from dropping bridge connections. Compaction
  // API calls can take 5-10+ seconds, during which no other messages
  // flow through the transport — without keep-alives, the server may
  // close the WebSocket for inactivity.
  // Two signals: (1) PUT /worker heartbeat via sessionActivity, and
  // (2) re-emit 'compacting' status so the SDK event stream stays active
  // and the server doesn't consider the session stale.
  // 中文补充上面那段英文：压缩请求可能要跑 5~10 秒以上，这段时间传输层上一条消息都没有。
  // 远端会话的 WebSocket 会因为「空闲超时」被服务端关掉，于是长连接就断了。
  // 解决办法是双保险：① 走 sessionActivity 发 PUT /worker 心跳 ② 重发 'compacting' 状态，
  // 让 SDK 事件流保持活跃，服务端就不会认为这个会话已经僵死。
  // setInterval 的**第三个参数**会被传给回调（这里传的是 context.setSDKStatus），
  // 回调里用 statusSetter?.('compacting') 调用它。
  const activityInterval = isSessionActivityTrackingActive()
    ? setInterval(
        (statusSetter?: (status: 'compacting' | null) => void) => {
          sendSessionActivitySignal()
          statusSetter?.('compacting')
        },
        30_000,
        context.setSDKStatus,
      )
    : undefined

  try {
    if (promptCacheSharingEnabled) {
      try {
        // DO NOT set maxOutputTokens here. The fork piggybacks on the main thread's
        // prompt cache by sending identical cache-key params (system, tools, model,
        // messages prefix, thinking config). Setting maxOutputTokens would clamp
        // budget_tokens via Math.min(budget, maxOutputTokens-1) in claude.ts,
        // creating a thinking config mismatch that invalidates the cache.
        // The streaming fallback path (below) can safely set maxOutputTokensOverride
        // since it doesn't share cache with the main thread.
        // 这里**绝对不要**设 maxOutputTokens（原英文注释讲得很具体）：
        // fork 靠「发送与主线程完全相同的 cache-key 参数」来复用缓存，
        // 而设置 maxOutputTokens 会通过 Math.min(budget, maxOutputTokens-1) 改变
        // thinking 配置，从而让缓存 key 对不上 —— 缓存复用就白做了。
        // 下面的流式兜底路径没有这个约束，所以可以安全地设 maxOutputTokensOverride。
        const result = await runForkedAgent({
          promptMessages: [summaryRequest],
          cacheSafeParams,
          canUseTool: createCompactCanUseTool(),
          querySource: 'compact',
          forkLabel: 'compact',
          maxTurns: 1,
          skipCacheWrite: true,
          // Pass the compact context's abortController so user Esc aborts the
          // fork — same signal the streaming fallback uses at
          // `signal: context.abortController.signal` below.
          overrides: { abortController: context.abortController },
        })
        const assistantMsg = getLastAssistantMessage(result.messages)
        const assistantText = assistantMsg
          ? getAssistantMessageText(assistantMsg)
          : null
        // Guard isApiErrorMessage: query() catches API errors (including
        // APIUserAbortError on ESC) and yields them as synthetic assistant
        // messages. Without this check, an aborted compact "succeeds" with
        // "Request was aborted." as the summary — the text doesn't start with
        // "API Error" so the caller's startsWithApiErrorPrefix guard misses it.
        // 为什么要多判一个 isApiErrorMessage（这是被真实 bug 教出来的）：
        // query() 会把 API 错误（包括用户按 Esc 产生的 APIUserAbortError）
        // **包装成一条合成的 assistant 消息**返回。如果只判「有没有文本」，
        // 一条内容是「Request was aborted.」的错误就会被当成摘要；
        // 而它不以 'API Error' 开头，上层那个 startsWithApiErrorPrefix 防线也拦不住它。
        if (assistantMsg && assistantText && !assistantMsg.isApiErrorMessage) {
          // Skip success logging for PTL error text — it's returned so the
          // caller's retry loop catches it, but it's not a successful summary.
          if (!assistantText.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) {
            logEvent('tengu_compact_cache_sharing_success', {
              preCompactTokenCount,
              outputTokens: result.totalUsage.output_tokens,
              cacheReadInputTokens: result.totalUsage.cache_read_input_tokens,
              cacheCreationInputTokens:
                result.totalUsage.cache_creation_input_tokens,
              cacheHitRate:
                result.totalUsage.cache_read_input_tokens > 0
                  ? result.totalUsage.cache_read_input_tokens /
                    (result.totalUsage.cache_read_input_tokens +
                      result.totalUsage.cache_creation_input_tokens +
                      result.totalUsage.input_tokens)
                  : 0,
            })
          }
          return assistantMsg
        }
        logForDebugging(
          `Compact cache sharing: no text in response, falling back. Response: ${jsonStringify(assistantMsg)}`,
          { level: 'warn' },
        )
        logEvent('tengu_compact_cache_sharing_fallback', {
          reason:
            'no_text_response' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          preCompactTokenCount,
        })
      } catch (error) {
        logError(error)
        logEvent('tengu_compact_cache_sharing_fallback', {
          reason:
            'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          preCompactTokenCount,
        })
      }
    }

    // Regular streaming path (fallback when cache sharing fails or is disabled)
    const retryEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_compact_streaming_retry',
      false,
    )
    const maxAttempts = retryEnabled ? MAX_COMPACT_STREAMING_RETRIES : 1

    // 流式兜底路径：默认只试 1 次（maxAttempts=1），开了远程开关才会重试到 2 次。
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Reset state for retry
      let hasStartedStreaming = false
      let response: AssistantMessage | undefined
      context.setResponseLength?.(() => 0)

      // Check if tool search is enabled using the main loop's tools list.
      // context.options.tools includes MCP tools merged via useMergedTools.
      const useToolSearch = await isToolSearchEnabled(
        context.options.mainLoopModel,
        context.options.tools,
        async () => appState.toolPermissionContext,
        context.options.agentDefinitions.activeAgents,
        'compact',
      )

      // When tool search is enabled, include ToolSearchTool and MCP tools. They get
      // defer_loading: true and don't count against context - the API filters them out
      // of system_prompt_tools before token counting (see api/token_count_api/counting.py:188
      // and api/public_api/messages/handler.py:324).
      // Filter MCP tools from context.options.tools (not appState.mcp.tools) so we
      // get the permission-filtered set from useMergedTools — same source used for
      // isToolSearchEnabled above and normalizeMessagesForAPI below.
      // Deduplicate by name to avoid API errors when MCP tools share names with built-in tools.
      // 工具搜索开启时给压缩代理多配两个工具（ToolSearchTool + MCP 工具），
      // 它们带 defer_loading: true，不占 context；并且要用 uniqBy 按名字去重，
      // 否则 MCP 工具与内置工具同名时 API 会直接报错。
      const tools: Tool[] = useToolSearch
        ? uniqBy(
            [
              FileReadTool,
              ToolSearchTool,
              ...context.options.tools.filter(t => t.isMcp),
            ],
            'name',
          )
        : [FileReadTool]

      // 【真正的请求在这里发出】注意 messages 的三层处理：
      //   getMessagesAfterCompactBoundary()  只取边界之后的（旧历史早就作废了）
      //   stripReinjectedAttachments()        去掉会被重新注入的附件
      //   stripImagesFromMessages()           去掉图片/文档
      //   normalizeMessagesForAPI()           规范化成 API 要求的形态
      // 这套组合散步的顺序不能随便调换。
      const streamingGen = queryModelWithStreaming({
        messages: normalizeMessagesForAPI(
          stripImagesFromMessages(
            stripReinjectedAttachments([
              ...getMessagesAfterCompactBoundary(messages),
              summaryRequest,
            ]),
          ),
          context.options.tools,
        ),
        systemPrompt: asSystemPrompt([
          'You are a helpful AI assistant tasked with summarizing conversations.',
        ]),
        thinkingConfig: { type: 'disabled' as const },
        tools,
        signal: context.abortController.signal,
        options: {
          async getToolPermissionContext() {
            const appState = context.getAppState()
            return appState.toolPermissionContext
          },
          model: context.options.mainLoopModel,
          toolChoice: undefined,
          isNonInteractiveSession: context.options.isNonInteractiveSession,
          hasAppendSystemPrompt: !!context.options.appendSystemPrompt,
          maxOutputTokensOverride: Math.min(
            COMPACT_MAX_OUTPUT_TOKENS,
            getMaxOutputTokensForModel(context.options.mainLoopModel),
          ),
          querySource: 'compact',
          agents: context.options.agentDefinitions.activeAgents,
          mcpTools: [],
          effortValue: appState.effortValue,
        },
      })
      // 手动拿异步迭代器：因为要在循环里做「流开始→切 UI」「每来一段文本→更新字数」这种捏细粒度的处理，
      // `for await (const e of gen)` 糖虽然写法更短，但这里需要手工控制 next() 的时机。
      const streamIter = streamingGen[Symbol.asyncIterator]()
      let next = await streamIter.next()

      // 异步迭代器的标准遍历姿势：next() 返回 { value, done }，
      // 每次 await 一个事件，done 为 true 时结束。≈ Java 的 Iterator.hasNext/next，但是异步的。
      while (!next.done) {
        const event = next.value

        // 第一次收到「文本内容块开始」时把 UI 切成「正在回答」——
        // 让用户知道模型真的开始输出了（压缩请求本身有网络往返延迟，这段时间 UI 是「请求中」）。
        if (
          !hasStartedStreaming &&
          event.type === 'stream_event' &&
          event.event.type === 'content_block_start' &&
          event.event.content_block.type === 'text'
        ) {
          hasStartedStreaming = true
          context.setStreamMode?.('responding')
        }

        // 每来一小段增量文本就把字数加进 UI 计数器。
        if (
          event.type === 'stream_event' &&
          event.event.type === 'content_block_delta' &&
          event.event.delta.type === 'text_delta'
        ) {
          const charactersStreamed = event.event.delta.text.length
          context.setResponseLength?.(length => length + charactersStreamed)
        }

        // 'assistant' 类型的事件才是**最终完整**的那条消息；
        // 中间的 stream_event 只是过程碎片，所以这里才是要保存的 response。
        if (event.type === 'assistant') {
          response = event
        }

        next = await streamIter.next()
      }

      // 拿到完整 assistant 消息 → 直接返回（本次压缩成功）。
      // 没拿到（response 仍是 undefined）说明流没走完，进入下面的重试 / 抛错逻辑。
      if (response) {
        return response
      }

      // 还有重试机会：sleep 一段退避时间（getRetryDelay 通常是带抖动的指数退避）后再试。
      // 如果这期间用户按了 Esc，sleep 会抛出 APIUserAbortError，直接中止重试。
      if (attempt < maxAttempts) {
        logEvent('tengu_compact_streaming_retry', {
          attempt,
          preCompactTokenCount,
          hasStartedStreaming,
        })
        await sleep(getRetryDelay(attempt), context.abortController.signal, {
          abortError: () => new APIUserAbortError(),
        })
        continue
      }

      logForDebugging(
        `Compact streaming failed after ${attempt} attempts. hasStartedStreaming=${hasStartedStreaming}`,
        { level: 'error' },
      )
      logEvent('tengu_compact_failed', {
        reason:
          'no_streaming_response' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        preCompactTokenCount,
        hasStartedStreaming,
        retryEnabled,
        attempts: attempt,
        promptCacheSharingEnabled,
      })
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    }

    // This should never be reached due to the throw above, but TypeScript needs it
    // 这行理论上到不了（上面的 for 循环一定会在最后 throw 掉），
    // 但 TS 不知道这一点 —— 它要求函数所有路径都有返回值，所以补一行兜底。
    throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    // 无论成功还是抛异常，心跳定时器都必须清掉 —— 漏了就是永久性的资源泄漏。
  } finally {
    clearInterval(activityInterval)
  }
}

/**
 * Creates attachment messages for recently accessed files to restore them after compaction.
 * This prevents the model from having to re-read files that were recently accessed.
 * Re-reads files using FileReadTool to get fresh content with proper validation.
 * Files are selected based on recency, but constrained by both file count and token budget limits.
 *
 * Files already present as Read tool results in preservedMessages are skipped —
 * re-injecting identical content the model can already see in the preserved tail
 * is pure waste (up to 25K tok/compact). Mirrors the diff-against-preserved
 * pattern that getDeferredToolsDeltaAttachment uses at the same call sites.
 *
 * @param readFileState The current file state tracking recently read files
 * @param toolUseContext The tool use context for calling FileReadTool
 * @param maxFiles Maximum number of files to restore (default: 5)
 * @param preservedMessages Messages kept post-compact; Read results here are skipped
 * @returns Array of attachment messages for the most recently accessed files that fit within token budget
 */
/**
 * 把「最近读过的文件」重新挂回压缩后的上下文，避免模型为了继续干活被迫重读一遍。
 *
 * 为什么需要：文件内容是最贵的上下文之一。压缩把它们丢了，
 * 模型就只能重新 Read —— 既慢又费 token。适度恢复几个最近的最划算。
 *
 * @param readFileState 记录「读过什么文件、什么时候读的」的台账。
 * @param toolUseContext 工具上下文（内部会用 FileReadTool 重新读一遍以拿到最新内容）。
 * @param maxFiles 最多恢复几个文件。
 * @param preservedMessages 压缩后**原样保留**的消息。已经出现在里面的 Read 结果会被跳过 ——
 *        重复注入相同内容纯粹浪费（实测最多能省 25k token/次压缩）。
 * @returns Promise<AttachmentMessage[]>：受**条数与 token 双重预算**约束后的附件列表。
 *
 * 关键步骤：
 *   ① 收集保留消息里已经出现过的 Read 文件路径（用于去重）
 *   ② 把台账摊平成数组 → 过滤掉应排除的文件（plan 文件、各类 CLAUDE.md）→ 按时间倒序
 *   ③ 取最近 maxFiles 个
 *   ④ **并发**重新读取这些文件生成附件
 *   ⑤ 逐个累加 token，超出预算的直接丢弃（注意不是截断，是整条丢掉）
 *
 * 为什么「避开 plan 文件和 CLAUDE.md」：这两类文件压缩后有专门的附件/机制重新注入，
 * 再塞一份纯属重复。
 */
export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages: Message[] = [],
): Promise<AttachmentMessage[]> {
  const preservedReadPaths = collectReadToolFilePaths(preservedMessages)
  // Object.entries 把对象摊成 [[键, 值], ...]；Object → Array 的常规套路 ≈ Java 的 map.entrySet()。
  // 后面 .map().filter().sort().slice() 一气呵成 ≈ Java Stream，区别是每步都产生新数组。
  const recentFiles = Object.entries(readFileState)
    .map(([filename, state]) => ({ filename, ...state }))
    .filter(
      file =>
        !shouldExcludeFromPostCompactRestore(
          file.filename,
          toolUseContext.agentId,
        ) && !preservedReadPaths.has(expandPath(file.filename)),
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxFiles)

  // 并发读多个文件（这些 IO 之间没有依赖）。Promise.all 会等最慢的那个，
  // 但总耗时远低于逐个串行。
  const results = await Promise.all(
    recentFiles.map(async file => {
      const attachment = await generateFileAttachment(
        file.filename,
        {
          ...toolUseContext,
          fileReadingLimits: {
            maxTokens: POST_COMPACT_MAX_TOKENS_PER_FILE,
          },
        },
        'tengu_post_compact_file_restore_success',
        'tengu_post_compact_file_restore_error',
        'compact',
      )
      return attachment ? createAttachmentMessage(attachment) : null
    }),
  )

  // 逐个累加 token 做预算控制。超出预算就**整条丢弃**（而非截断）——
  // 截一半的文件内容反而更容易误导模型。
  let usedTokens = 0
  return results.filter((result): result is AttachmentMessage => {
    if (result === null) {
      return false
    }
    const attachmentTokens = roughTokenCountEstimation(jsonStringify(result))
    if (usedTokens + attachmentTokens <= POST_COMPACT_TOKEN_BUDGET) {
      usedTokens += attachmentTokens
      return true
    }
    return false
  })
}

/**
 * Creates a plan file attachment if a plan file exists for the current session.
 * This ensures the plan is preserved after compaction.
 */
/**
 * 如果当前会话存在计划文件，就生成一条附件把它的内容带上。
 *
 * 为什么需要：计划文件不在对话历史里（它在磁盘上），压缩不会碰它，
 * 但模型压缩后会「忘记」自己之前写好的计划。所以每次压缩都要重新挂一次。
 *
 * @param agentId 当前代理 ID（子代理的计划文件与主会话是分开的）。
 * @returns 附件消息；没有计划文件时返回 null。
 */
export function createPlanAttachmentIfNeeded(
  agentId?: AgentId,
): AttachmentMessage | null {
  const planContent = getPlan(agentId)

  if (!planContent) {
    return null
  }

  const planFilePath = getPlanFilePath(agentId)

  return createAttachmentMessage({
    type: 'plan_file_reference',
    planFilePath,
    planContent,
  })
}

/**
 * Creates an attachment for invoked skills to preserve their content across compaction.
 * Only includes skills scoped to the given agent (or main session when agentId is null/undefined).
 * This ensures skill guidelines remain available after the conversation is summarized
 * without leaking skills from other agent contexts.
 */
/**
 * 把本次会话**调用过**的 skill 正文做成附件，让它们能跨压缩存活。
 *
 * 为什么需要：skill 的指导内容（怎么用这个 skill）通常不在对话历史里，
 * 压缩后会丢失，模型就会「忘了规矩」。
 * 只收录属于当前 agent 的 skill —— 防止把别的子代理的 skill 泄漏进来。
 *
 * @param agentId 当前代理 ID。
 * @returns 附件消息；没有调用过任何 skill、或全部被预算挤掉时返回 null。
 *
 * 关键步骤：
 *   ① 取出已调用的 skill 集合
 *   ② 按调用时间**倒序**（最近的排前面）—— 这样预算紧张时丢掉的是最不相关的
 *   ③ 每个 skill 单独截断到 POST_COMPACT_MAX_TOKENS_PER_SKILL
 *   ④ 逐个累加 token，超出总预算的直接过滤掉
 */
export function createSkillAttachmentIfNeeded(
  agentId?: string,
): AttachmentMessage | null {
  const invokedSkills = getInvokedSkillsForAgent(agentId)

  if (invokedSkills.size === 0) {
    return null
  }

  // Sorted most-recent-first so budget pressure drops the least-relevant skills.
  // Per-skill truncation keeps the head of each file (where setup/usage
  // instructions typically live) rather than dropping whole skills.
  let usedTokens = 0
  // Map/Set → 数组：`Array.from(set)` 或 `[...set]` 两种写法等价，
  // ≈ Java 的 new ArrayList<>(map.values())。
  const skills = Array.from(invokedSkills.values())
    .sort((a, b) => b.invokedAt - a.invokedAt)
    .map(skill => ({
      name: skill.skillName,
      path: skill.skillPath,
      content: truncateToTokens(
        skill.content,
        POST_COMPACT_MAX_TOKENS_PER_SKILL,
      ),
    }))
    .filter(skill => {
      const tokens = roughTokenCountEstimation(skill.content)
      if (usedTokens + tokens > POST_COMPACT_SKILLS_TOKEN_BUDGET) {
        return false
      }
      usedTokens += tokens
      return true
    })

  if (skills.length === 0) {
    return null
  }

  return createAttachmentMessage({
    type: 'invoked_skills',
    skills,
  })
}

/**
 * Creates a plan_mode attachment if the user is currently in plan mode.
 * This ensures the model continues to operate in plan mode after compaction
 * (otherwise it would lose the plan mode instructions since those are
 * normally only injected on tool-use turns via getAttachmentMessages).
 */
/**
 * 如果当前正处于 plan mode，就生成一条附件重申 plan mode 的约束。
 *
 * 为什么需要（不这么做会出事）：plan mode 的指令平时是靠 getAttachmentMessages()
 * 在**有工具调用的轮次**里注入的。压缩之后历史被重写，
 * 如果不主动补一条，模型就会以为自己不在 plan mode 里、开始直接改代码。
 *
 * @param context 工具上下文（从中读取权限模式与 agentId）。
 * @returns 附件消息；不在 plan mode 时返回 null。
 */
export async function createPlanModeAttachmentIfNeeded(
  context: ToolUseContext,
): Promise<AttachmentMessage | null> {
  const appState = context.getAppState()
  if (appState.toolPermissionContext.mode !== 'plan') {
    return null
  }

  const planFilePath = getPlanFilePath(context.agentId)
  const planExists = getPlan(context.agentId) !== null

  return createAttachmentMessage({
    type: 'plan_mode',
    reminderType: 'full',
    isSubAgent: !!context.agentId,
    planFilePath,
    planExists,
  })
}

/**
 * Creates attachments for async agents so the model knows about them after
 * compaction. Covers both agents still running in the background (so the model
 * doesn't spawn a duplicate) and agents that have finished but whose results
 * haven't been retrieved yet.
 */
/**
 * 把所有「异步代理 task」的当前状态做成附件，让压缩后的模型知道它们的存在。
 *
 * 为什么需要（两种场景，注释里都点到了）：
 *   ① 还在后台跑的代理 —— 模型不知道它在跑，就会**重复启动**一个一模一样的任务
 *   ② 已经跑完但结果还没取回的代理 —— 模型会以为它失败了或者根本没启动过
 *
 * @param context 工具上下文（从 AppState 里读任务表）。
 * @returns 附件消息数组。
 *
 * 为什么用 flatMap 而不是 filter+map：这里「一条任务」可能产出「零条或一条」附件，
 * flatMap 正好表达这种「可变数量」的映射。
 */
export async function createAsyncAgentAttachmentsIfNeeded(
  context: ToolUseContext,
): Promise<AttachmentMessage[]> {
  const appState = context.getAppState()
  // `(task): task is LocalAgentTaskState => ...` 是**类型谓词**（≈ Java 的 instanceof 模式匹配）：
  // 它不只是返回 boolean，还告诉编译器「通过过滤的元素一定是 LocalAgentTaskState」。
  // 于是后面就能直接访问 task.progress / task.error 这些子类型独有的字段。
  const asyncAgents = Object.values(appState.tasks).filter(
    (task): task is LocalAgentTaskState => task.type === 'local_agent',
  )

  return asyncAgents.flatMap(agent => {
    if (
      agent.retrieved ||
      agent.status === 'pending' ||
      agent.agentId === context.agentId
    ) {
      return []
    }
    return [
      createAttachmentMessage({
        type: 'task_status',
        taskId: agent.agentId,
        taskType: 'local_agent',
        description: agent.description,
        status: agent.status,
        deltaSummary:
          agent.status === 'running'
            ? (agent.progress?.summary ?? null)
            : (agent.error ?? null),
        outputFilePath: getTaskOutputPath(agent.agentId),
      }),
    ]
  })
}

/**
 * Scan messages for Read tool_use blocks and collect their file_path inputs
 * (normalized via expandPath). Used to dedup post-compact file restoration
 * against what's already visible in the preserved tail.
 *
 * Skips Reads whose tool_result is a dedup stub — the stub points at an
 * earlier full Read that may have been compacted away, so we want
 * createPostCompactFileAttachments to re-inject the real content.
 */
/**
 * 扫描消息，收集所有被 Read 工具读过的文件路径（路径会先 normalize）。
 *
 * 为什么需要：给 createPostCompactFileAttachments() 去重用 ——
 * 已经出现在「保留区间」里的 Read 结果就不用再注入一次了。
 *
 * @param messages 要扫描的消息。
 * @returns 规范化后的文件路径集合。
 *
 * 为什么要**跳过** tool_result 是 FILE_UNCHANGED_STUB 的那些 Read（一个很细的点）：
 * 那个 stub 只是指向「更早的一次完整 Read」，而那次完整 Read 可能已经被压缩掉了。
 * 所以这种 Read **不算**「模型已经看过了」，必须让文件附件的逻辑重新注入真实内容。
 *
 * 关键步骤：
 *   ① 第一遍：收集所有结果是去重 stub 的 tool_use id
 *   ② 第二遍：收集所有 Read 类 tool_use 的 file_path（排除 ① 里的 id）
 *   ③ 路径统一经 expandPath 规范化（把 ~、相对路径都展开成绝对路径），保证能被正确比较
 */
function collectReadToolFilePaths(messages: Message[]): Set<string> {
  const stubIds = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (
        block.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.startsWith(FILE_UNCHANGED_STUB)
      ) {
        stubIds.add(block.tool_use_id)
      }
    }
  }

  const paths = new Set<string>()
  for (const message of messages) {
    if (
      message.type !== 'assistant' ||
      !Array.isArray(message.message.content)
    ) {
      continue
    }
    for (const block of message.message.content) {
      if (
        block.type !== 'tool_use' ||
        block.name !== FILE_READ_TOOL_NAME ||
        stubIds.has(block.id)
      ) {
        continue
      }
      const input = block.input
      if (
        input &&
        typeof input === 'object' &&
        'file_path' in input &&
        typeof input.file_path === 'string'
      ) {
        paths.add(expandPath(input.file_path))
      }
    }
  }
  return paths
}

const SKILL_TRUNCATION_MARKER =
  '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]'

/**
 * Truncate content to roughly maxTokens, keeping the head. roughTokenCountEstimation
 * uses ~4 chars/token (its default bytesPerToken), so char budget = maxTokens * 4
 * minus the marker so the result stays within budget. Marker tells the model it
 * can Read the full file if needed.
 */
/**
 * 把内容截断到大致 maxTokens 个 token，**保留开头部分**。
 *
 * 为什么保留开头而不是结尾：对 skill 这类文件来说，开头的「怎么用」说明才是最关键的，
 * 结尾往往是示例或细节。丢尾巴比丢脑袋好。
 *
 * @param content 原始内容。
 * @param maxTokens token 上限。
 * @returns 截断后的内容（超限时末尾会带一句提示，告诉模型可以去 Read 原文件）。
 *
 * 为什么用 `maxTokens * 4` 换算字符数：roughTokenCountEstimation 默认按约 4 字符/token 估算，
 * 这里直接沿用同一个口径；再减掉提示标记的长度，保证结果总量不超预算。
 */
function truncateToTokens(content: string, maxTokens: number): string {
  if (roughTokenCountEstimation(content) <= maxTokens) {
    return content
  }
  const charBudget = maxTokens * 4 - SKILL_TRUNCATION_MARKER.length
  return content.slice(0, charBudget) + SKILL_TRUNCATION_MARKER
}

/**
 * 判断某个文件是否应该被排除在「压缩后自动恢复」之外。
 *
 * 为什么需要：有两类文件压缩后**另有渠道**重新进入上下文，
 * 再作为普通文件内容塞一次就是纯浪费：
 *   ① plan 文件（有专门的 plan 附件）
 *   ② 各类 CLAUDE.md / 记忆文件（有专门的记忆机制）
 *
 * @param filename 待判断的文件名。
 * @param agentId 当前代理 ID（不同代理的 plan 文件路径不同）。
 * @returns true 表示应当排除。
 *
 * 为什么两处都要包 try/catch：getPlanFilePath / getMemoryPath 在某些环境下会抛异常
 * （例如 HOME 未设置）。这类环境异常不应该让整个压缩流程失败 —— 宁可少过滤一个文件。
 */
function shouldExcludeFromPostCompactRestore(
  filename: string,
  agentId?: AgentId,
): boolean {
  const normalizedFilename = expandPath(filename)
  // Exclude plan files
  try {
    const planFilePath = expandPath(getPlanFilePath(agentId))
    if (normalizedFilename === planFilePath) {
      return true
    }
  } catch {
    // If we can't get plan file path, continue with other checks
  }

  // Exclude all types of claude.md files
  // TODO: Refactor to use isMemoryFilePath() from claudemd.ts for consistency
  // and to also match child directory memory files (.claude/rules/*.md, etc.)
  try {
    const normalizedMemoryPaths = new Set(
      MEMORY_TYPE_VALUES.map(type => expandPath(getMemoryPath(type))),
    )

    if (normalizedMemoryPaths.has(normalizedFilename)) {
      return true
    }
  } catch {
    // If we can't get memory paths, continue
  }

  return false
}
