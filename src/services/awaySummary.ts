/**
 * ============================================================================
 *  【文件总览】src/services/awaySummary.ts —— 「你不在的时候」小结卡片
 * ============================================================================
 *
 *  一句话定位：
 *  用户离开一阵子再回来时，Claude Code 会在界面上显示一张「While you were away」卡片，
 *  用 1~3 句话告诉他「刚才在做啥、下一步该干啥」。本文件负责生成这段话。
 *
 *  在架构中的位置：
 *      UI 层（检测用户从「离开」状态回到前台）
 *        └─> generateAwaySummary(messages, signal)          ← ★ 本文件
 *              ├─> getSessionMemoryContent()      ← src/services/SessionMemory/
 *              │     （会话记忆，提供比近期消息更宏观的背景）
 *              ├─> buildAwaySummaryPrompt()       ← 本文件：拼提示词
 *              └─> queryModelWithoutStreaming()   ← src/services/api/claude.js
 *                    用「小快模型」做一次性非流式调用
 *
 *  本文件包含什么：
 *   1. RECENT_MESSAGE_WINDOW          只取最近 30 条消息的常量
 *   2. buildAwaySummaryPrompt()       构造发给小模型的提示词
 *   3. generateAwaySummary()          对外入口，生成小结文本
 *
 *  【设计意图 1：为什么只取最近 30 条消息】
 *  长会话可能有几百上千条消息，全塞进去必然触发 "prompt too long"。
 *  而「小结」这个场景本来就只需要最近的上下文——
 *  30 条 ≈ 15 个来回，足够回答「刚才做到哪了」。
 *  ⚠️ 注意代码里的一个细节：`recent = messages.slice(-30)` 得到的是**新数组**，
 *  但紧接着 `recent.push(...)` 会修改它——这里绝不能写成 `messages.push`，
 *  否则就把调用方的原始消息列表污染了（这也是为什么 slice 是必要的复制）。
 *
 *  【设计意图 2：为什么用「小快模型」且关掉 thinking】
 *  这只是个一句话小结，不值得动用主力模型，也不值得让它深度思考：
 *    - model: getSmallFastModel()      便宜、延迟低
 *    - thinkingConfig: { disabled }    省掉思考过程，进一步降延迟
 *    - skipCacheWrite: true            不写缓存，避免污染正式会话的缓存
 *    - tools: []                       不给任何工具，它只需要「说」，不需要「做」
 *  用户刚回到界面，这张卡片要是 5 秒后才出来就失去意义了，所以延迟是第一优先级。
 *
 *  【设计意图 3：为什么几乎所有失败路径都返回 null】
 *  小结卡片是纯装饰性功能。API 报错、用户中断、会话为空……
 *  任何一种情况下，UI 只要「不显示这张卡片」即可，绝不该弹错误、更不该崩。
 *  所以这里把所有异常都收敛成 null，≈ Java 里返回 Optional.empty() 而不是抛异常。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `readonly Message[]`  **只读数组**类型。
 *      编译器禁止对它调用 push/pop/splice 等修改方法，
 *      从类型层面保证「调用方传进来的消息列表不会被本函数改坏」。
 *      ≈ Java 的 `List<Message>` 包一层 Collections.unmodifiableList()，
 *      但 TS 是**编译期**约束，运行时仍是普通数组（所以才需要 slice 复制）。
 *
 *  - `messages.slice(-RECENT_MESSAGE_WINDOW)`  负数索引 = 从末尾往前数。
 *      ≈ Java 的 `list.subList(max(0, size-30), size)`，但一行搞定且会复制出新数组。
 *
 *  - `AbortSignal`  取消信号。≈ Java 里没有内建对应物，
 *      最接近的是「把 CancellationException 的触发开关传进方法」：
 *      调用方可以随时 signal.abort()，正在进行的 fetch 就会被中断。
 *      本文件里既用它传给 HTTP 请求，也在 catch 里检查 signal.aborted 做二次确认。
 *
 *  - `err instanceof APIUserAbortError`  和 Java 的 instanceof 完全一样。
 *      为什么还要 `|| signal.aborted`：中断可能以两种形态出现——
 *      要么是 SDK 抛了专门的异常，要么是信号已置位但异常还没抛出来。两个都要覆盖。
 *
 *  - `` `文本 ${变量}` ``  模板字符串（反引号）。≈ Java 的 String.format 或文本块，
 *      但可以直接换行、直接内插表达式，比 Java 方便得多。
 *
 *  - `memory ? \`...\` : ''`  三元表达式，和 Java 一样。
 *
 *  - `response.isApiErrorMessage`  联合类型上的**判别属性**。
 *      返回的 response 可能是「正常回复」也可能是「错误消息」，
 *      靠这个布尔字段区分——这是 TS 里实现「类似 Java 的多态分支」的常用手法。
 *
 *  - `toolChoice: undefined`  显式传 undefined，表示「不使用工具」。
 *      注意与「不传这个字段」不同：显式 undefined 会覆盖默认值。
 *
 *  - `Promise<string | null>`  异步返回「字符串或 null」，
 *      ≈ Java 的 `CompletableFuture<Optional<String>>` 的简化版。
 * ============================================================================
 */
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { getEmptyToolPermissionContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import {
  createUserMessage,
  getAssistantMessageText,
} from '../utils/messages.js'
import { getSmallFastModel } from '../utils/model/model.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { queryModelWithoutStreaming } from './api/claude.js'
import { getSessionMemoryContent } from './SessionMemory/sessionMemoryUtils.js'

// 中文补注：只回看最近 30 条（约 15 个来回）消息。
// 长会话可能有上千条，全塞给模型会触发 "prompt too long"；
// 而「刚才做到哪了」这个问题本来也只需要近期上下文就够了。
// Recap only needs recent context — truncate to avoid "prompt too long" on
// large sessions. 30 messages ≈ ~15 exchanges, plenty for "where we left off."
const RECENT_MESSAGE_WINDOW = 30

/**
 * 构造「请帮我总结一下刚才在做什么」的提示词。
 *
 * 为什么需要单独一个函数：把提示词从主流程里抽出来，
 * 改文案时不用碰调用逻辑（提示词是最常被反复调优的部分）。
 *
 * 提示词里那几条要求（先说高层目标、再说下一步、跳过程式化的状态汇报）
 * 都是踩过坑后的总结：不加约束的话，模型特别爱写
 * 「我已完成了 X、提交了 Y」这种流水账，对用户毫无信息量。
 *
 * @param memory 会话记忆的正文；没有记忆时传 null，此时省略记忆段落
 * @returns 完整的提示词文本
 */
function buildAwaySummaryPrompt(memory: string | null): string {
  const memoryBlock = memory
    ? `Session memory (broader context):\n${memory}\n\n`
    : ''
  return `${memoryBlock}The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.`
}

/**
 * Generates a short session recap for the "while you were away" card.
 * Returns null on abort, empty transcript, or error.
 */
/**
 * 生成「你不在的时候」小结卡片上的那段文字。
 *
 * 为什么需要：用户去开了个会回来，面对满屏历史记录会一脸茫然。
 * 一句「正在给 X 模块加缓存，下一步是补测试」比让他自己翻记录高效得多。
 *
 * 关键步骤：
 *   ① 空会话直接返回 null（没内容可总结）
 *   ② 读出会话记忆，提供近期消息之外的宏观背景
 *   ③ 只取最近 30 条消息，把总结提示词作为一条「用户消息」追加在末尾
 *   ④ 用小快模型做一次非流式调用（关掉思考、不给工具、不写缓存，追求低延迟）
 *   ⑤ 出错/被中断一律返回 null，让 UI 安静地不显示这张卡片
 *
 * @param messages 当前会话的完整消息列表（本函数不会修改它）
 * @param signal   取消信号，用户切走或关闭时可中断这次调用
 * @returns 1~3 句的小结文本；任何失败情况返回 null
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<string | null> {
  if (messages.length === 0) {
    return null
  }

  try {
    const memory = await getSessionMemoryContent()
    const recent = messages.slice(-RECENT_MESSAGE_WINDOW)
    recent.push(createUserMessage({ content: buildAwaySummaryPrompt(memory) }))
    const response = await queryModelWithoutStreaming({
      messages: recent,
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: getSmallFastModel(),
        toolChoice: undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'away_summary',
        mcpTools: [],
        skipCacheWrite: true,
      },
    })

    if (response.isApiErrorMessage) {
      logForDebugging(
        `[awaySummary] API error: ${getAssistantMessageText(response)}`,
      )
      return null
    }
    return getAssistantMessageText(response)
  } catch (err) {
    if (err instanceof APIUserAbortError || signal.aborted) {
      return null
    }
    logForDebugging(`[awaySummary] generation failed: ${err}`)
    return null
  }
}
