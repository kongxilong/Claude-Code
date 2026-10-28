/**
 * ============================================================================
 *  【文件总览】src/services/tokenEstimation.ts —— token 数量的「精确计数」与「本地估算」
 * ============================================================================
 *
 *  一句话定位：
 *  回答一个问题：「这段内容/这批消息占多少个 token？」
 *  本文件提供**两条路线**：调用 API 精确计数（准，但要发一次请求），
 *  以及本地粗略估算（不准，但零成本、零延迟）。调用方按场景二选一。
 *
 *  在架构中的位置：
 *      src/services/compact/autoCompact.ts（判断上下文是不是快超了）
 *        ├─> countTokensWithAPI(content)              精确计数（单条文本）
 *        ├─> countMessagesTokensWithAPI(messages, tools)  精确计数（整批消息）
 *        ├─> countTokensViaHaikuFallback(...)         API 不支持时改用 Haiku/Sonnet 发一次空跑
 *        ├─> roughTokenCountEstimation(...)           本地粗估（零网络）
 *        └─> roughTokenCountEstimationForMessages(...)  本地粗估（整批消息）
 *                                             ↑ 全部 ★ 本文件
 *              └─> withTokenCountVCR()   ← ./vcr.js（测试环境用录制回放代替真请求）
 *
 * ---------------------------------------------------------------------------
 *  【为什么需要「本地估算」？——本文件存在的最大理由】
 * ---------------------------------------------------------------------------
 *  先说背景：token 是模型的计费和上下文长度单位，
 *  Claude Code 必须时刻知道「现在用了多少 token」，才能决定要不要压缩上下文。
 *
 *  最准的办法当然是问 API（`POST /v1/messages/count_tokens`），但那意味着：
 *    - **多一次网络往返**：几百毫秒延迟，用户能感觉到卡
 *    - **多一次请求开销**：虽然计数接口本身便宜，但高频调用下不可忽略
 *    - **可能失败**：网络抖动、Bedrock/Vertex 某些区域压根不支持这个接口
 *
 *  而「要不要压缩上下文」这个判断，**并不需要精确到个位数**：
 *  差个百分之几完全无所谓，只要不出现数量级错误就行。
 *
 *  于是有了分级策略（这是本文件的核心思想）：
 *
 *      能用 API 精确计数 → 用精确的（准确优先）
 *              ↓ 不可用 / 失败 / 来不及
 *      退化为本地粗估      → 用 `字符数 / 每token字节数`（速度优先，宁可低估一点也要有数）
 *
 *  ≈ Java 里「先查缓存，缓存没有就用启发式公式估一个」的思路，
 *    区别是这里的两条路各有明确适用场景，不是简单的快慢之分。
 *
 * ---------------------------------------------------------------------------
 *  【估算策略细节：为什么默认 4 字节 = 1 token，JSON 却是 2】
 * ---------------------------------------------------------------------------
 *  Claude 的 tokenizer 对**英文散文**大约是 3.5~4 个字符 1 个 token，
 *  所以默认值取 4（`bytesPerToken = 4`）。
 *  但 **JSON 是密度极高的文本**：`{`、`}`、`:`、`,`、`"` 这些符号各自都是独立 token，
 *  1 个字符就占 1 个 token，于是实际比例接近 2 而不是 4。
 *  如果用 4 去估 JSON，会**严重低估**（估出来只有实际的一半），
 *  后果是「明明已经超长了，系统却以为还很宽裕」，直到 API 报错才压缩——太晚了。
 *  所以 bytesPerTokenForFileType() 对 json/jsonl/jsonc 返回 2。
 *  原英文注释也点明了：宁可高估也不要低估，低估会让过大的工具结果混进对话。
 *
 *  图片/PDF 则干脆返回常量 2000：
 *  因为图片会被缩放到最大 2000x2000，按官方公式（宽×高/750）约 5333 token，
 *  这里取 2000 是**保守值**，与 microCompact 的 IMAGE_MAX_TOKEN_SIZE 保持一致，
 *  避免两个模块算出不同的数导致行为不一致。
 *
 *  ⚠️ PDF 特别说明（原英文注释的惨痛教训）：
 *  PDF 在消息里是 base64 编码的，1MB 的 PDF 展开成 base64 有约 133 万字符，
 *  若按字符数估算会得出 32.5 万 token，而 API 实际只收约 2000。
 *  差了 160 倍！所以必须对 document 类型**直接返回常量**，绝不能走字符数兜底。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   1. countTokensWithAPI()                 单条文本的精确计数
 *   2. countMessagesTokensWithAPI()         整批消息 + 工具的精确计数（主力入口）
 *   3. countTokensWithBedrock()             Bedrock 平台专用的计数实现
 *   4. countTokensViaHaikuFallback()        count_tokens 接口不可用时的替代方案
 *   5. roughTokenCountEstimation()          最基础的本地粗估：字符数 / 每token字节数
 *   6. bytesPerTokenForFileType()           按文件类型给出更准的字节比
 *   7. roughTokenCountEstimationForFileType()  带文件类型的粗估
 *   8. roughTokenCountEstimationForMessages() / ForMessage() / ForContent() / ForBlock()
 *                                          逐级递归下探，把一条消息的每个 block 都算上
 *   9. hasThinkingBlocks()                  消息里是否含思考块（影响要不要开 thinking）
 *  10. stripToolSearchFieldsFromMessages()  剥掉只有 tool search beta 才认的字段
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `bytesPerToken: number = 4`  **带默认值的参数**。
 *      调用方可省略该参数。≈ Java 里没有默认参数，要靠方法重载（overload）模拟。
 *
 *  - `...(条件 && { 字段: 值 })`  **条件展开**（本文件出现 5 次，务必看懂）。
 *      原理：`false && {...}` 得到 false，展开 `...false` 等于什么都没展开。
 *      效果：「只有条件成立时才往对象里塞这个字段」。
 *      ≈ Java 里先 new 一个 HashMap 再 `if (cond) map.put(k, v)`，但一行写完。
 *      为什么必须这样：API 对多传一个 `betas: []` 或 `thinking: undefined`
 *      可能会报错，所以宁可不传字段，也不能传空值。
 *
 *  - `response.inputTokens ?? null`  空值合并。
 *      ⚠️ 与 `||` 的区别在这里很关键：如果 inputTokens 是 **0**，
 *      `||` 会把它当成假值换成 null（错误！0 个 token 是合法答案），
 *      `??` 只在 null/undefined 时兜底，能正确保留 0。
 *
 *  - `async function countTokensWithBedrock({ model, messages, ... }: {...})`
 *      **对象解构参数**：调用方传一个对象，函数直接解出字段。
 *      ≈ Java 里传一个 DTO 再逐个 getter，这里一行解完，且调用处字段名自解释。
 *
 *  - `await import('@aws-sdk/client-bedrock-runtime')`  动态 import。
 *      原英文注释说明了原因：AWS SDK 约 279KB，
 *      只有真正要用 Bedrock 时才加载，避免所有用户都为它付出启动代价。
 *
 *  - `'type' in block`  **in 运算符**：判断对象有没有某个属性。
 *      ≈ Java 的反射 `field != null`，但这是编译期就知道的收窄手段。
 *      这里用来安全地判断一个「可能是任意对象」的值是不是某个 block 类型。
 *
 *  - `as unknown as MessageParam[]`  双重断言（见 vcr.ts 说明），
 *      用于绕过 SDK 类型定义没覆盖到的实际运行时字段。
 *
 *  - `switch (fileExtension) { case 'json': case 'jsonl': ... }`
 *      多个 case 共用一个分支（**故意不加 break**），和 Java 的 fall-through 一样。
 *
 *  - `readonly {...}[]`  只读数组参数，保证函数不修改调用方的数据。
 *
 *  - `type: 'tool_use' as const`  **常量断言**。
 *      把字面量 `'tool_use'` 的类型锁成「就是这个值」而不是宽泛的 string，
 *      这样它才能匹配联合类型里要求的字面量类型。
 *      ≈ Java 里没有对应物；可以想成 `final String` 提升到类型层面。
 *
 *  - `// biome-ignore lint/plugin: ...`  单行关闭 linter 规则的指令注释，
 *      ≈ Java 的 `@SuppressWarnings("...")`。
 * ============================================================================
 */
import type { Anthropic } from '@anthropic-ai/sdk'
import type { BetaMessageParam as MessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
// @aws-sdk/client-bedrock-runtime is imported dynamically in countTokensWithBedrock()
// to defer ~279KB of AWS SDK code until a Bedrock call is actually made
import type { CountTokensCommandInput } from '@aws-sdk/client-bedrock-runtime'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from '../constants/betas.js'
import type { Attachment } from '../utils/attachments.js'
import { getModelBetas } from '../utils/betas.js'
import { getVertexRegionForModel, isEnvTruthy } from '../utils/envUtils.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import {
  createBedrockRuntimeClient,
  getInferenceProfileBackingModel,
  isFoundationModel,
} from '../utils/model/bedrock.js'
import {
  getDefaultSonnetModel,
  getMainLoopModel,
  getSmallFastModel,
  normalizeModelStringForAPI,
} from '../utils/model/model.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
import { getAPIMetadata, getExtraBodyParams } from './api/claude.js'
import { getAnthropicClient } from './api/client.js'
import { withTokenCountVCR } from './vcr.js'

// 中文补注：这两个常量是为了「开启 thinking 的计数请求」准备的最小值。
// API 有一条硬性约束：**max_tokens 必须大于 thinking.budget_tokens**，
// 否则会直接报参数错误。既然我们只是想数 token、根本不在乎模型输出什么，
// 就取满足约束的最小组合（1024 / 2048），把开销压到最低。
// Minimal values for token counting with thinking enabled
// API constraint: max_tokens must be greater than thinking.budget_tokens
const TOKEN_COUNT_THINKING_BUDGET = 1024
const TOKEN_COUNT_MAX_TOKENS = 2048

/**
 * Check if messages contain thinking blocks
 */
/**
 * 判断这批消息里是否含有「思考块」（thinking / redacted_thinking）。
 *
 * 为什么需要：Claude 开启扩展思考（extended thinking）后，
 * 助手消息里会多出 thinking 类型的 block。这类 block 的存在会改变 API 的参数要求：
 * 带思考块的消息再发回去时，请求里必须也带上 thinking 配置，否则 API 报错。
 * 所以计数之前必须先探测一次。
 *
 * 注意 `typeof block === 'object' && block !== null && 'type' in block` 这一串判断：
 * content 数组里既可能有字符串也可能有各种对象，必须一层层排除才能安全访问 .type。
 *
 * @param messages 待检查的消息列表
 * @returns true = 至少有一个思考块
 */
function hasThinkingBlocks(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): boolean {
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking')
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Strip tool search-specific fields from messages before sending for token counting.
 * This removes 'caller' from tool_use blocks and 'tool_reference' from tool_result content.
 * These fields are only valid with the tool search beta and will cause errors otherwise.
 *
 * Note: We use 'as unknown as' casts because the SDK types don't include tool search beta fields,
 * but at runtime these fields may exist from API responses when tool search was enabled.
 */
/**
 * 剥掉只有「tool search beta」才认得的两个字段。
 *
 * 为什么需要（原英文注释已说明，这里复述）：
 * 开启 tool search 实验特性后，API 返回的 tool_use 里会多一个 `caller` 字段、
 * tool_result 里会多出 `tool_reference` 类型的 block。
 * 这些字段**只在带 tool search beta 请求头时才合法**；
 * 计数接口不带那个头，把带这些字段的消息原样发过去会被 API 判定为非法参数。
 * 所以计数前必须先清洗一遍。
 *
 * 为什么要 `as unknown as` 双重断言：
 * SDK 的类型定义里没有这些 beta 字段（它们是实验特性），
 * 但**运行时**确实可能存在。双重断言就是告诉编译器「我知道类型里没写，但运行时有」。
 *
 * 边界情况：如果把 tool_reference 全过滤掉后 content 变成空数组，
 * 不能返回空数组（API 不接受空的 tool_result），
 * 所以补一个占位文本 `[tool references]`——既合法又不影响 token 数太多。
 *
 * @param messages 原始消息
 * @returns 清洗掉 tool search 专有字段后的新消息数组（不修改原数组）
 */
function stripToolSearchFieldsFromMessages(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): Anthropic.Beta.Messages.BetaMessageParam[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) {
      return message
    }

    const normalizedContent = message.content.map(block => {
      // Strip 'caller' from tool_use blocks (assistant messages)
      if (block.type === 'tool_use') {
        // Destructure to exclude any extra fields like 'caller'
        const toolUse =
          block as Anthropic.Beta.Messages.BetaToolUseBlockParam & {
            caller?: unknown
          }
        return {
          type: 'tool_use' as const,
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }
      }

      // Strip tool_reference blocks from tool_result content (user messages)
      if (block.type === 'tool_result') {
        const toolResult =
          block as Anthropic.Beta.Messages.BetaToolResultBlockParam
        if (Array.isArray(toolResult.content)) {
          const filteredContent = (toolResult.content as unknown[]).filter(
            c => !isToolReferenceBlock(c),
          ) as typeof toolResult.content

          if (filteredContent.length === 0) {
            return {
              ...toolResult,
              content: [{ type: 'text' as const, text: '[tool references]' }],
            }
          }
          if (filteredContent.length !== toolResult.content.length) {
            return {
              ...toolResult,
              content: filteredContent,
            }
          }
        }
      }

      return block
    })

    return {
      ...message,
      content: normalizedContent,
    }
  })
}

/**
 * 精确计数：一段纯文本占多少个 token（走 API 的 count_tokens 接口）。
 *
 * @param content 待计数的文本
 * @returns token 数；接口不可用或失败时返回 null（调用方需自行降级到本地估算）
 */
export async function countTokensWithAPI(
  content: string,
): Promise<number | null> {
  // 中文补注：空串必须**本地直接返回 0**，不能发给 API——
  // API 不接受空消息，为「什么都没有」发一次网络请求纯属浪费。
  // Special case for empty content - API doesn't accept empty messages
  if (!content) {
    return 0
  }

  const message: Anthropic.Beta.Messages.BetaMessageParam = {
    role: 'user',
    content: content,
  }

  return countMessagesTokensWithAPI([message], [])
}

/**
 * 精确计数：一批消息 + 工具定义一共占多少个 token（主力入口）。
 *
 * 为什么需要：autoCompact 判断「上下文是不是快撑爆了」时，
 * 要算的是**整个对话 + 所有工具定义**的总量，
 * 工具定义本身也很占 token（几十个工具的 schema 可能就有几千 token）。
 *
 * 关键步骤：
 *   ① 整个计算包在 withTokenCountVCR 里：测试环境直接回放 fixture，不打真实 API
 *   ② Bedrock 平台走专门的 countTokensWithBedrock（官方 SDK 不支持 countTokens）
 *   ③ 探测消息里有没有思考块，有就在请求里开启 thinking
 *   ④ Vertex 平台要过滤 betas（某些 beta 头在 Vertex 上会 400，见 issue #10789）
 *   ⑤ 消息为空但传了工具时，补一条哑消息 'foo'——
 *      否则 API 拿不到准确的工具 token 数
 *   ⑥ 任何异常都记日志并返回 null，让调用方降级到本地估算（绝不因为计数失败而中断主流程）
 *
 * @param messages 完整消息列表
 * @param tools    工具定义列表
 * @returns token 总数；失败返回 null
 */
export async function countMessagesTokensWithAPI(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  return withTokenCountVCR(messages, tools, async () => {
    try {
      const model = getMainLoopModel()
      const betas = getModelBetas(model)
      const containsThinking = hasThinkingBlocks(messages)

      if (getAPIProvider() === 'bedrock') {
        // @anthropic-sdk/bedrock-sdk doesn't support countTokens currently
        return countTokensWithBedrock({
          model: normalizeModelStringForAPI(model),
          messages,
          tools,
          betas,
          containsThinking,
        })
      }

      const anthropic = await getAnthropicClient({
        maxRetries: 1,
        model,
        source: 'count_tokens',
      })

      const filteredBetas =
        getAPIProvider() === 'vertex'
          ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
          : betas

      const response = await anthropic.beta.messages.countTokens({
        model: normalizeModelStringForAPI(model),
        messages:
          // When we pass tools and no messages, we need to pass a dummy message
          // to get an accurate tool token count.
          messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
        tools,
        ...(filteredBetas.length > 0 && { betas: filteredBetas }),
        // Enable thinking if messages contain thinking blocks
        ...(containsThinking && {
          thinking: {
            type: 'enabled',
            budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
          },
        }),
      })

      if (typeof response.input_tokens !== 'number') {
        // Vertex client throws
        // Bedrock client succeeds with { Output: { __type: 'com.amazon.coral.service#UnknownOperationException' }, Version: '1.0' }
        return null
      }

      return response.input_tokens
    } catch (error) {
      logError(error)
      return null
    }
  })
}

/**
 * 本地粗略估算：纯字符串 → token 数。
 *
 * 为什么需要：这是整个「零成本估算」体系的最后兜底。
 * 不发任何网络请求，纯算术，微秒级完成。
 *
 * 公式极其简单：`token 数 ≈ 字符数 / 每 token 字节数`。
 * 为什么可以这么粗糙：token 是子词单位，英文散文里平均 1 token ≈ 3.5~4 个字符，
 * 中文、代码、符号各有偏差，但**数量级和百分位是对的**，
 * 而「要不要压缩上下文」这个决策只需要百分位精度。
 *
 * @param content       待估算的文本
 * @param bytesPerToken 每 token 折合多少字符，默认 4（英文散文的经验值）
 * @returns 估算的 token 数
 */
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * Returns an estimated bytes-per-token ratio for a given file extension.
 * Dense JSON has many single-character tokens (`{`, `}`, `:`, `,`, `"`)
 * which makes the real ratio closer to 2 rather than the default 4.
 */
/**
 * 按文件扩展名给出更准确的「每 token 字节数」。
 *
 * 为什么需要：默认 4 是给**普通英文文本**的经验值。
 * 但 JSON 类文件是「符号密集型」文本——`{` `}` `:` `,` `"` 每个都单独占一个 token，
 * 1 个字符 1 个 token，实际比例接近 **2** 而不是 4。
 * 用 4 去估 JSON 会低估一半，后果是「系统以为还很宽裕，实际早就超了」，
 * 等 API 报超长错误才去压缩，已经晚了。
 *
 * @param fileExtension 文件扩展名（不含点），如 'json'、'ts'
 * @returns 每 token 折合的字符数：JSON 类返回 2，其它返回 4
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * Like {@link roughTokenCountEstimation} but uses a more accurate
 * bytes-per-token ratio when the file type is known.
 *
 * This matters when the API-based token count is unavailable (e.g. on
 * Bedrock) and we fall back to the rough estimate — an underestimate can
 * let an oversized tool result slip into the conversation.
 */
/**
 * 带文件类型的本地粗估（比 roughTokenCountEstimation 更准一点）。
 *
 * 为什么需要：当 API 计数不可用时（典型场景：Bedrock），
 * 我们只能依赖本地估算来拦截「过大的工具结果」。
 * 此时**低估的代价远大于高估**——低估会让一个超大结果混进对话，
 * 直接把上下文撑爆；高估顶多是早点压缩，无害。
 * 所以只要知道文件类型，就该用更贴合的比例。
 *
 * @param content       文件内容
 * @param fileExtension 文件扩展名
 * @returns 估算的 token 数
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

/**
 * Estimates token count for a Message object by extracting and analyzing its text content.
 * This provides a more reliable estimate than getTokenUsage for messages that may have been compacted.
 * Uses Haiku for token counting (Haiku 4.5 supports thinking blocks), except:
 * - Vertex global region: uses Sonnet (Haiku not available)
 * - Bedrock with thinking blocks: uses Sonnet (Haiku 3.5 doesn't support thinking)
 */
/**
 * 备用精确计数方案：当 count_tokens 接口不可用时，改为「发一次真实请求，读它的 usage」。
 *
 * 为什么需要：不是所有平台都支持专门的 count_tokens 接口。
 * 退而求其次的办法是：真的发一次 messages.create 请求，
 * 但把 max_tokens 设成 1（让模型几乎不输出），
 * 然后从响应头里的 `usage.input_tokens` 读出精确的 token 数。
 * 相当于「借一次真实调用，顺带把数数了」。
 *
 * 【为什么默认用 Haiku / 小快模型】
 * 反正只关心 input_tokens，输出多少无所谓，那就用最便宜最快的模型。
 * 但有三种情况必须换成 Sonnet（原英文注释列出了）：
 *   ① Vertex global 区域 —— 那里根本没部署 Haiku
 *   ② Bedrock + 有思考块 —— Haiku 3.5 不支持 thinking
 *   ③ Vertex   + 有思考块 —— 同上
 *
 * 【为什么要先 stripToolSearchFieldsFromMessages】
 * 这次是**真实**的 messages.create 调用，不带 tool search beta 头，
 * 那些 beta 专有字段会让 API 报 400，必须提前剥掉。
 *
 * 【为什么最后要把三种 token 相加】
 * input_tokens 只是「本次真正送进去的」，
 * 缓存写入（cache_creation）和缓存读取（cache_read）同样占用上下文额度，
 * 三者相加才是这个请求真实消耗的上下文大小。
 *
 * @param messages 消息列表
 * @param tools    工具定义
 * @returns token 总数（input + cache 写入 + cache 读取）
 */
export async function countTokensViaHaikuFallback(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  // Check if messages contain thinking blocks
  const containsThinking = hasThinkingBlocks(messages)

  // If we're on Vertex and using global region, always use Sonnet since Haiku is not available there.
  const isVertexGlobalEndpoint =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) &&
    getVertexRegionForModel(getSmallFastModel()) === 'global'
  // If we're on Bedrock with thinking blocks, use Sonnet since Haiku 3.5 doesn't support thinking
  const isBedrockWithThinking =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && containsThinking
  // If we're on Vertex with thinking blocks, use Sonnet since Haiku 3.5 doesn't support thinking
  const isVertexWithThinking =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && containsThinking
  // Otherwise always use Haiku - Haiku 4.5 supports thinking blocks.
  // WARNING: if you change this to use a non-Haiku model, this request will fail in 1P unless it uses getCLISyspromptPrefix.
  // Note: We don't need Sonnet for tool_reference blocks because we strip them via
  // stripToolSearchFieldsFromMessages() before sending.
  // Use getSmallFastModel() to respect ANTHROPIC_SMALL_FAST_MODEL env var for Bedrock users
  // with global inference profiles (see issue #10883).
  const model =
    isVertexGlobalEndpoint || isBedrockWithThinking || isVertexWithThinking
      ? getDefaultSonnetModel()
      : getSmallFastModel()
  const anthropic = await getAnthropicClient({
    maxRetries: 1,
    model,
    source: 'count_tokens',
  })

  // Strip tool search-specific fields (caller, tool_reference) before sending
  // These fields are only valid with the tool search beta header
  const normalizedMessages = stripToolSearchFieldsFromMessages(messages)

  const messagesToSend: MessageParam[] =
    normalizedMessages.length > 0
      ? (normalizedMessages as MessageParam[])
      : [{ role: 'user', content: 'count' }]

  const betas = getModelBetas(model)
  // Filter betas for Vertex - some betas (like web-search) cause 400 errors
  // on certain Vertex endpoints. See issue #10789.
  const filteredBetas =
    getAPIProvider() === 'vertex'
      ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
      : betas

  // biome-ignore lint/plugin: token counting needs specialized parameters (thinking, betas) that sideQuery doesn't support
  const response = await anthropic.beta.messages.create({
    model: normalizeModelStringForAPI(model),
    max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
    messages: messagesToSend,
    tools: tools.length > 0 ? tools : undefined,
    ...(filteredBetas.length > 0 && { betas: filteredBetas }),
    metadata: getAPIMetadata(),
    ...getExtraBodyParams(),
    // Enable thinking if messages contain thinking blocks
    ...(containsThinking && {
      thinking: {
        type: 'enabled',
        budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
      },
    }),
  })

  const usage = response.usage
  const inputTokens = usage.input_tokens
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0
  const cacheReadTokens = usage.cache_read_input_tokens || 0

  return inputTokens + cacheCreationTokens + cacheReadTokens
}

/**
 * 本地粗估：一整批消息加起来多少 token。
 *
 * 为什么需要：压缩决策要的是「整段对话的总量」，
 * 而不是单条消息的量，所以需要一个批量求和的入口。
 *
 * @param messages 消息列表（只读，本函数不会修改）
 * @returns 各条消息估算值之和
 */
export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

/**
 * 本地粗估：单条消息占多少 token。
 *
 * 为什么需要：一条「消息」在本项目里可能是多种形态——
 * 助手消息、用户消息、或附件（图片/PDF），
 * 它们的 token 计算方式完全不同，必须先按 type 分流。
 *
 * 附件的特殊处理：附件本身不是 API 消息格式，
 * 要先 normalizeAttachmentForAPI() 转成一条或多条标准 user 消息，再逐条累加。
 *
 * @param message 单条消息
 * @returns 估算的 token 数；不认识的类型返回 0（保守地不夸大）
 */
export function roughTokenCountEstimationForMessage(message: {
  type: string
  message?: { content?: unknown }
  attachment?: Attachment
}): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(
      message.message?.content as
        | string
        | Array<Anthropic.ContentBlock>
        | Array<Anthropic.ContentBlockParam>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    const userMessages = normalizeAttachmentForAPI(message.attachment)
    let total = 0
    for (const userMsg of userMessages) {
      total += roughTokenCountEstimationForContent(userMsg.message.content)
    }
    return total
  }

  return 0
}

/**
 * 本地粗估：消息的 content 字段（可能是字符串，也可能是 block 数组）。
 *
 * 为什么需要：API 的 content 有两种形态——
 * 简单场景是纯字符串，复杂场景是结构化 block 数组（文本/图片/工具调用混排）。
 * 这里做分流，字符串直接算，数组则逐个 block 下探。
 *
 * @param content 字符串或 block 数组；undefined 记为 0
 * @returns 估算的 token 数
 */
function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<Anthropic.ContentBlock>
    | Array<Anthropic.ContentBlockParam>
    | undefined,
): number {
  if (!content) {
    return 0
  }
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  let totalTokens = 0
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block)
  }
  return totalTokens
}

/**
 * 本地粗估：单个 content block 占多少 token（整个估算体系的最底层）。
 *
 * 为什么需要：block 有十几种类型，每种「该数什么」都不一样，
 * 必须逐个定制，否则会出现离谱的数量级错误。各 branch 的理由：
 *
 *   ① text / thinking / redacted_thinking —— 直接数文本字符
 *   ② image / document —— **直接返回常量 2000**，绝不按字符数算！
 *      原因（原英文注释重点警告）：PDF 在消息里是 base64，
 *      1MB 的 PDF ≈ 133 万字符，按字符数会估出 32.5 万 token，
 *      而 API 实际只收约 2000——差了 160 倍。
 *      取 2000 是与 microCompact 的 IMAGE_MAX_TOKEN_SIZE 对齐的保守值。
 *   ③ tool_result —— 递归下探它的 content（可能又是字符串或数组）
 *   ④ tool_use   —— 数「工具名 + input 序列化后的 JSON」，
 *      因为 input 可能是超长的 bash 命令或整个文件内容，体积不可预测
 *   ⑤ 其它（server_tool_use、web_search_tool_result…）——
 *      兜底：整体 JSON 序列化后按字符数估，误差在个位数百分比，可接受
 *
 * @param block 单个内容块（或裸字符串）
 * @returns 估算的 token 数
 */
function roughTokenCountEstimationForBlock(
  block: string | Anthropic.ContentBlock | Anthropic.ContentBlockParam,
): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(block)
  }
  if (block.type === 'text') {
    return roughTokenCountEstimation(block.text)
  }
  if (block.type === 'image' || block.type === 'document') {
    // https://platform.claude.com/docs/en/build-with-claude/vision#calculate-image-costs
    // tokens = (width px * height px)/750
    // Images are resized to max 2000x2000 (5333 tokens). Use a conservative
    // estimate that matches microCompact's IMAGE_MAX_TOKEN_SIZE to avoid
    // underestimating and triggering auto-compact too late.
    //
    // document: base64 PDF in source.data.  Must NOT reach the
    // jsonStringify catch-all — a 1MB PDF is ~1.33M base64 chars →
    // ~325k estimated tokens, vs the ~2000 the API actually charges.
    // Same constant as microCompact's calculateToolResultTokens.
    return 2000
  }
  if (block.type === 'tool_result') {
    return roughTokenCountEstimationForContent(block.content)
  }
  if (block.type === 'tool_use') {
    // input is the JSON the model generated — arbitrarily large (bash
    // commands, Edit diffs, file contents).  Stringify once for the
    // char count; the API re-serializes anyway so this is what it sees.
    return roughTokenCountEstimation(
      block.name + jsonStringify(block.input ?? {}),
    )
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data)
  }
  // server_tool_use, web_search_tool_result, mcp_tool_use, etc. —
  // text-like payloads (tool inputs, search results, no base64).
  // Stringify-length tracks the serialized form the API sees; the
  // key/bracket overhead is single-digit percent on real blocks.
  return roughTokenCountEstimation(jsonStringify(block))
}

/**
 * Bedrock 平台专用的 token 计数实现。
 *
 * 为什么需要单独一套：官方的 @anthropic-sdk/bedrock-sdk **不支持** countTokens，
 * 只能直接用 AWS 的 Bedrock Runtime API（CountTokensCommand）。
 *
 * 关键步骤：
 *   ① 建 Bedrock 客户端
 *   ② 解析模型 ID：CountTokens 只接受「基础模型 ID」，
 *      不接受推理配置文件（inference profile）/ARN，所以要先转换一次
 *   ③ 组装请求体：注意 Bedrock 用的是自己的字段名
 *      （anthropic_version / anthropic_beta），与 Anthropic 直连 API 不同
 *   ④ AWS SDK 用动态 import 加载（约 279KB，只有 Bedrock 用户才需要付出这个代价）
 *   ⑤ 请求体要手动 TextEncoder 编码成字节，因为 AWS SDK 收的是原始 body
 *
 * 失败一律返回 null 而不是抛出：计数失败不该中断主流程，调用方会降级到本地估算。
 *
 * @returns token 数；模型 ID 解析失败或请求出错时返回 null
 */
async function countTokensWithBedrock({
  model,
  messages,
  tools,
  betas,
  containsThinking,
}: {
  model: string
  messages: Anthropic.Beta.Messages.BetaMessageParam[]
  tools: Anthropic.Beta.Messages.BetaToolUnion[]
  betas: string[]
  containsThinking: boolean
}): Promise<number | null> {
  try {
    const client = await createBedrockRuntimeClient()
    // Bedrock CountTokens requires a model ID, not an inference profile / ARN
    const modelId = isFoundationModel(model)
      ? model
      : await getInferenceProfileBackingModel(model)
    if (!modelId) {
      return null
    }

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      // When we pass tools and no messages, we need to pass a dummy message
      // to get an accurate tool token count.
      messages:
        messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      ...(tools.length > 0 && { tools }),
      ...(betas.length > 0 && { anthropic_beta: betas }),
      ...(containsThinking && {
        thinking: {
          type: 'enabled',
          budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
        },
      }),
    }

    const { CountTokensCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    )
    const input: CountTokensCommandInput = {
      modelId,
      input: {
        invokeModel: {
          body: new TextEncoder().encode(jsonStringify(requestBody)),
        },
      },
    }
    const response = await client.send(new CountTokensCommand(input))
    const tokenCount = response.inputTokens ?? null
    return tokenCount
  } catch (error) {
    logError(error)
    return null
  }
}
