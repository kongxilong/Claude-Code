/**
 * 【一句话定位】★ 错误的「翻译与分类中心」：把 SDK / 网络 / 各云厂商抛出的原始错误，
 *           翻译成①用户能看懂、知道该怎么办的提示消息；②供分析系统用的错误类别标签。
 *
 * 【在架构中的位置】
 *   调用链：src/services/api/claude.ts（请求失败时）
 *           → 本文件 getAssistantMessageFromError()（★ 生成给用户看的错误消息）
 *           → 本文件 classifyAPIError()（★ 生成给分析系统看的类别标签）
 *           → 本文件 categorizeRetryableAPIError()（给 SDK 用的粗分类）
 *           → 本文件 isValidAPIMessage() / extractUnknownErrorFormat()（响应结构校验与兜底解析）
 *   被调用方还有：
 *     - src/query.ts（PROMPT_TOO_LONG_ERROR_MESSAGE / isPromptTooLongMessage）
 *     - src/services/compact/*（getPromptTooLongTokenGap / isMediaSizeErrorMessage）
 *     - src/services/api/logging.ts（classifyAPIError 结果随错误事件上报）
 *     - src/services/api/withRetry.ts（REPEATED_529_ERROR_MESSAGE、shouldRetry 的补充）
 *   依赖的下游模块：
 *     - ../claudeAiLimits.js（限流文案生成）
 *     - ./errorUtils.js（formatAPIError / extractConnectionErrorDetails）
 *     - src/utils/messages.js（createAssistantAPIErrorMessage 构造错误消息对象）
 *
 * 【★ 错误分类体系：哪些可重试、哪些不可重试】
 *   ⚠️ 注意分工：本文件**不决定**要不要重试（那是 withRetry.ts 的 shouldRetry），
 *      本文件负责给错误贴标签、给人类可操作的文案。两者要对照着看。
 *   按性质大致分几类：
 *   ①**瞬时/容量类（通常可重试）**：
 *       · api_timeout（连接超时）
 *       · rate_limit（429 限流）
 *       · server_overload（529 过载）/ repeated_529（连续过载）
 *       · server_error（其它 5xx）
 *       · connection_error / ssl_cert_error（网络层）
 *   ②**鉴权类（先刷新凭证再重试，重试不成就要用户重新登录）**：
 *       · authentication_failed / auth_error（401、403）
 *       · invalid_api_key、token_revoked、oauth_org_not_allowed
 *   ③**请求本身有问题（重试没用，必须改输入）**：
 *       · prompt_too_long（提示词太长 → 触发压缩）
 *       · pdf_too_large / pdf_password_protected / image_too_large（媒体超限）
 *       · tool_use_mismatch / unexpected_tool_result / duplicate_tool_use_id
 *         （工具调用配对被破坏 → 需要 /rewind 回滚）
 *       · invalid_model / bedrock_model_access
 *       · client_error（其它 4xx）
 *   ④**账号/商务类（用户必须去处理）**：
 *       · credit_balance_low（余额不足）、billing_error
 *       · capacity_off_switch（Opus 限流的人工开关）
 *   ⑤**模型拒绝**：refusal（内容违反使用政策，见 getErrorMessageIfRefusal）。
 *
 * 【本文件包含什么】
 *   - 一堆错误消息常量（API_ERROR_MESSAGE_PREFIX、PROMPT_TOO_LONG_ERROR_MESSAGE、
 *     INVALID_API_KEY_ERROR_MESSAGE、REPEATED_529_ERROR_MESSAGE 等）。
 *   - startsWithApiErrorPrefix() / isPromptTooLongMessage() / isMediaSizeError(Message)()：判定函数。
 *   - parsePromptTooLongTokenCounts() / getPromptTooLongTokenGap()：从错误文案里解析 token 数。
 *   - getPdfTooLarge / getImageTooLarge / getRequestTooLarge 等一系列文案生成函数：
 *     按「交互 / 非交互」给出不同的后续指引。
 *   - isCCRMode() / logToolUseToolResultMismatch()：远程模式判定与排障日志。
 *   - isValidAPIMessage() / extractUnknownErrorFormat()：响应结构校验。
 *   - getAssistantMessageFromError()：★ 主入口（错误 → 用户可见消息）。
 *   - get3PModelFallbackSuggestion()：三方渠道下推荐备用模型。
 *   - classifyAPIError()：★ 错误 → 类别标签（供分析）。
 *   - categorizeRetryableAPIError()：错误 → SDK 用的粗分类。
 *   - getErrorMessageIfRefusal()：stop_reason 为 refusal 时的提示。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `export function isValidAPIMessage(value: unknown): value is BetaMessage`：
 *      ★ **类型谓词（type predicate）**。返回值写成 `x is T` 表示：
 *      「返回 true 就说明 value 是 T」。调用方写 `if (isValidAPIMessage(v))` 之后，
 *      TS 会自动把 v 当成 BetaMessage 用，不需要 as 强转。
 *      ≈ Java 的 `v instanceof T` + 自动向下转型（Java 16+ 的 pattern matching）。
 *      ★ 这是 TS 相比 Java 的一个明显优势：可以自定义「类型守卫函数」。
 *   2. `error instanceof APIConnectionTimeoutError`：跟 Java instanceof 完全一致。
 *      本文件大量使用——因为要针对**不同的错误子类**给不同文案。
 *   3. `error.message.toLowerCase().includes('prompt is too long')`：
 *      ★ 靠**匹配错误文案**来识别错误类型。原注释里也承认这很脆弱（API 改措辞就失效），
 *      但现实中各家 provider（尤其 Vertex/Bedrock）返回的错误形状千差万别，
 *      只能这么兜。注意用 toLowerCase() 做大小写无关匹配（不同 provider 大小写不同）。
 *   4. `return` 不带值：`function f(): X | undefined { if (...) return }` 等价于返回 undefined。
 *      Java 里必须显式 `return null;`。
 *   5. `match[1]!`：`!` 是★**非空断言**，告诉编译器「我确定它不是 null/undefined」。
 *      ≈ Java 的强制解引用（运行时真的为空照样 NPE）。
 *      因为 TS 严格模式下 match[1] 的类型是 string | undefined，而 parseInt 要 string。
 *   6. `const match = /regex/.test(x)` / `x.match(/regex/)`：正则。
 *      `/.../i` 的 i 是忽略大小写标志（Java：Pattern.CASE_INSENSITIVE）。
 *      `[^0-9]*` 表示「任意多个非数字字符」—— 用来容忍文案里的各种前缀。
 *   7. `error.headers?.get?.('...')`：
 *      ★ 双重可选：headers 可能不存在，get 也可能不是函数（反序列化出来的对象）。
 *      这在错误处理代码里很常见，因为错误对象的形状完全不可信。
 *   8. `as 'five_hour' | 'seven_day' | ... | null`：把 string 断言成一个字面量联合，
 *      这样后面赋值给 limits.rateLimitType 时类型才匹配。
 *   9. `switch (msg.type) { case 'user': case 'assistant': {...} break; ... }`：
 *      switch + case 穿透 + break，跟 Java 一模一样。
 *      本文件用它对消息类型做穷举处理（配合 TS 的联合类型可以做穷尽性检查）。
 *  10. `catch (_) { }`：用下划线命名一个不使用的 catch 参数（约定俗成）。
 *  11. `const { source } = getAnthropicApiKeyWithSource()`：解构。
 *  12. `template \`...${x}...\``：模板字符串，本文件几乎所有文案都靠它拼。
 *      Java：String.format 或字符串拼接。
 *  13. `MACRO.FEEDBACK_CHANNEL`：编译期宏（打包时替换成实际字符串）。
 *  14. `export const X = '...'`：导出常量。TS 的字符串常量如果用 `as const` 或直接用字面量，
 *      类型会被推断成字面量类型（这里是 string，因为没有 as const）。
 *  15. `options?: { messages?: Message[] }`：可选对象参数，内部字段也可选。
 *      调用时用 `options?.messages` 访问。
 *  16. `Array.isArray(x)`：判断是不是数组（比 instanceof Array 更可靠，跨 realm 也行）。
 *      Java：x instanceof List。
 *  17. `content.some(block => block.type === 'text' && ...)`：some ≈ anyMatch。
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { AFK_MODE_BETA_HEADER } from 'src/constants/betas.js'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from 'src/types/message.js'
import {
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  getOauthAccountInfo,
  isClaudeAISubscriber,
} from 'src/utils/auth.js'
import {
  createAssistantAPIErrorMessage,
  NO_RESPONSE_REQUESTED,
} from 'src/utils/messages.js'
import {
  getDefaultMainLoopModelSetting,
  isNonCustomOpusModel,
} from 'src/utils/model/model.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  API_PDF_MAX_PAGES,
  PDF_TARGET_RAW_SIZE,
} from '../../constants/apiLimits.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatFileSize } from '../../utils/format.js'
import { ImageResizeError } from '../../utils/imageResizer.js'
import { ImageSizeError } from '../../utils/imageValidation.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type ClaudeAILimits,
  getRateLimitErrorMessage,
  type OverageDisabledReason,
} from '../claudeAiLimits.js'
import { shouldProcessRateLimits } from '../rateLimitMocking.js' // Used for /mock-limits command
import { extractConnectionErrorDetails, formatAPIError } from './errorUtils.js'

// 所有面向用户的 API 错误文案统一以 'API Error' 开头，
// 好处：①用户一眼认出这是 API 问题；②代码里可以用 startsWith 快速识别（见下）。
export const API_ERROR_MESSAGE_PREFIX = 'API Error'

// 判断一段文字是不是「API 错误」文案。第二种前缀是登录态失效时的提示格式。
export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    text.startsWith(`Please run /login · ${API_ERROR_MESSAGE_PREFIX}`)
  )
}
// ★ 提示词过长。这是**常量字符串**而不是动态生成的，
// 因为 UI（以及 compact 逻辑）要靠**精确匹配**这个串来识别，一改就全断了。
// 教训：被程序逻辑依赖的用户可见文案，改动要非常谨慎。
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'

// 判断一条 assistant 消息是不是「提示词过长」的错误消息。
export function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  if (!msg.isApiErrorMessage) {
    return false
  }
  const content = msg.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block =>
      block.type === 'text' &&
      block.text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
}

/**
 * Parse actual/limit token counts from a raw prompt-too-long API error
 * message like "prompt is too long: 137500 tokens > 135000 maximum".
 * The raw string may be wrapped in SDK prefixes or JSON envelopes, or
 * have different casing (Vertex), so this is intentionally lenient.
 */
// ★ 从原始错误文案里解析出「实际多少 token / 上限多少 token」。
// 例子：prompt is too long: 137500 tokens > 135000 maximum
// 正则里的 [^0-9]* 是刻意的宽容设计——SDK 可能加了前缀、可能套了 JSON，
// Vertex 的大小写还不一样，所以只要能把两个数字抠出来就行。
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  )
  return {
// parseInt(match[1]!, 10)：`!` 非空断言（match 匹配成功时 [1] 必然存在）。
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  }
}

/**
 * Returns how many tokens over the limit a prompt-too-long error reports,
 * or undefined if the message isn't PTL or its errorDetails are unparseable.
 * Reactive compact uses this gap to jump past multiple groups in one retry
 * instead of peeling one-at-a-time.
 */
// 算出「超了多少 token」。用途（注释里说了）：reactive compact 拿到这个差值，
// 就能一次跳过足够多的历史分组，而不是一组一组慢慢剥——大幅减少重试轮次。
export function getPromptTooLongTokenGap(
  msg: AssistantMessage,
): number | undefined {
  if (!isPromptTooLongMessage(msg) || !msg.errorDetails) {
    return undefined
  }
  const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(
    msg.errorDetails,
  )
  if (actualTokens === undefined || limitTokens === undefined) {
    return undefined
  }
  const gap = actualTokens - limitTokens
  return gap > 0 ? gap : undefined
}

/**
 * Is this raw API error text a media-size rejection that stripImagesFromMessages
 * can fix? Reactive compact's summarize retry uses this to decide whether to
 * strip and retry (media error) or bail (anything else).
 *
 * Patterns MUST stay in sync with the getAssistantMessageFromError branches
 * that populate errorDetails (~L523 PDF, ~L560 image, ~L573 many-image) and
 * the classifyAPIError branches (~L929-946). The closed loop: errorDetails is
 * only set after those branches already matched these same substrings, so
 * isMediaSizeError(errorDetails) is tautologically true for that path. API
 * wording drift causes graceful degradation (errorDetails stays undefined,
 * caller short-circuits), not a false negative.
 */
// ★ 判断是不是「媒体体积超限」类错误（图片太大 / PDF 页数太多）。
// 用途：reactive compact 决定「能不能靠剥离图片来修复，要不要重试」。
// 原注释特别提醒：这里的匹配模式必须与下面 getAssistantMessageFromError 里
// 填充 errorDetails 的那几个分支**保持一致**，否则会出现「识别不出来」的漏网情况。
export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes('image exceeds') && raw.includes('maximum')) ||
    (raw.includes('image dimensions exceed') && raw.includes('many-image')) ||
    /maximum of \d+ PDF pages/.test(raw)
  )
}

/**
 * Message-level predicate: is this assistant message a media-size rejection?
 * Parallel to isPromptTooLongMessage. Checks errorDetails (the raw API error
 * string populated by the getAssistantMessageFromError branches at ~L523/560/573)
 * rather than content text, since media errors have per-variant content strings.
 */
export function isMediaSizeErrorMessage(msg: AssistantMessage): boolean {
  return (
    msg.isApiErrorMessage === true &&
    msg.errorDetails !== undefined &&
    isMediaSizeError(msg.errorDetails)
  )
}
// ===== 以下是一批错误文案常量 ===== 
// 之所以抽成常量，是因为多处（UI、日志、测试）都要引用，避免文案不一致。
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE = 'Not logged in · Please run /login'
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL =
  'Invalid API key · Fix external API key'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH =
  'Your ANTHROPIC_API_KEY belongs to a disabled organization · Unset the environment variable to use your subscription instead'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY =
  'Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable'
export const TOKEN_REVOKED_ERROR_MESSAGE =
  'OAuth token revoked · Please run /login'
export const CCR_AUTH_ERROR_MESSAGE =
  'Authentication error · This may be a temporary network issue, please try again'
// 连续 529 的文案（withRetry.ts 会用它构造 CannotRetryError）。
export const REPEATED_529_ERROR_MESSAGE = 'Repeated 529 Overloaded errors'
// Opus 过载时的人工降级开关文案：直接建议用户切到 Sonnet。
export const CUSTOM_OFF_SWITCH_MESSAGE =
  'Opus is experiencing high load, please use /model to switch to Sonnet'
export const API_TIMEOUT_ERROR_MESSAGE = 'Request timed out'
// ★ 注意这一系列 get*ErrorMessage() 都做同一件事：
// 根据「是不是非交互会话（`claude -p`）」给出不同的指引。
//   交互模式：告诉用户「双击 esc 回去改一下」（有 UI 可操作）；
//   非交互模式：告诉用户「用别的办法，比如先用 pdftotext 转成文本」。
// 这是 CLI 工具很典型的文案适配——同样的错误，给人和给脚本的建议不同。
export function getPdfTooLargeErrorMessage(): string {
  const limits = `max ${API_PDF_MAX_PAGES} pages, ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `PDF too large (${limits}). Try reading the file a different way (e.g., extract text with pdftotext).`
    : `PDF too large (${limits}). Double press esc to go back and try again, or use pdftotext to convert to text first.`
}
export function getPdfPasswordProtectedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'PDF is password protected. Try using a CLI tool to extract or convert the PDF.'
    : 'PDF is password protected. Please double press esc to edit your message and try again.'
}
export function getPdfInvalidErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'The PDF file was not valid. Try converting it to text first (e.g., pdftotext).'
    : 'The PDF file was not valid. Double press esc to go back and try again with a different file.'
}
export function getImageTooLargeErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Image was too large. Try resizing the image or using a different approach.'
    : 'Image was too large. Double press esc to go back and try again with a smaller image.'
}
export function getRequestTooLargeErrorMessage(): string {
  const limits = `max ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `Request too large (${limits}). Try with a smaller file.`
    : `Request too large (${limits}). Double press esc to go back and try with a smaller file.`
}
export const OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE =
  'Your account does not have access to Claude Code. Please run /login.'

export function getTokenRevokedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Your account does not have access to Claude. Please login again or contact your administrator.'
    : TOKEN_REVOKED_ERROR_MESSAGE
}

export function getOauthOrgNotAllowedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Your organization does not have access to Claude. Please login again or contact your administrator.'
    : OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE
}

/**
 * Check if we're in CCR (Claude Code Remote) mode.
 * In CCR mode, auth is handled via JWTs provided by the infrastructure,
 * not via /login. Transient auth errors should suggest retrying, not logging in.
 */
// CCR（Claude Code Remote）模式：鉴权由基础设施下发 JWT，不是用户 /login 来的。
// 所以那里的鉴权错误多半是**瞬时故障**（网络抖动、鉴权服务抖动），
// 应该提示「再试一次」而不是「去登录」。
function isCCRMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
}

// Temp helper to log tool_use/tool_result mismatch errors
// 排障用的临时函数：把 tool_use / tool_result 配对错乱前后的消息序列打成字符串上报，
// 便于在线上复现「到底是哪一步把配对搞坏了」。整体 try/catch 吞异常——排障代码不能影响主流程。
function logToolUseToolResultMismatch(
  toolUseId: string,
  messages: Message[],
  messagesForAPI: (UserMessage | AssistantMessage)[],
): void {
  try {
    // Find tool_use in normalized messages
    let normalizedIndex = -1
    for (let i = 0; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            'id' in block &&
            block.id === toolUseId
          ) {
            normalizedIndex = i
            break
          }
        }
      }
      if (normalizedIndex !== -1) break
    }

    // Find tool_use in original messages
    let originalIndex = -1
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue
      if (msg.type === 'assistant' && 'message' in msg) {
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_use' &&
              'id' in block &&
              block.id === toolUseId
            ) {
              originalIndex = i
              break
            }
          }
        }
      }
      if (originalIndex !== -1) break
    }

    // Build normalized sequence
    const normalizedSeq: string[] = []
    for (let i = normalizedIndex + 1; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const role = msg.message.role
          if (block.type === 'tool_use' && 'id' in block) {
            normalizedSeq.push(`${role}:tool_use:${block.id}`)
          } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
            normalizedSeq.push(`${role}:tool_result:${block.tool_use_id}`)
          } else if (block.type === 'text') {
            normalizedSeq.push(`${role}:text`)
          } else if (block.type === 'thinking') {
            normalizedSeq.push(`${role}:thinking`)
          } else if (block.type === 'image') {
            normalizedSeq.push(`${role}:image`)
          } else {
            normalizedSeq.push(`${role}:${block.type}`)
          }
        }
      } else if (typeof content === 'string') {
        normalizedSeq.push(`${msg.message.role}:string_content`)
      }
    }

    // Build pre-normalized sequence
    const preNormalizedSeq: string[] = []
    for (let i = originalIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue

// switch 对消息类型做分类。TS 的联合类型 + switch 可以实现「穷尽性检查」：
// 如果将来 Message 加了新类型而这里没处理，编译器（配合配置）能提醒。
      switch (msg.type) {
        case 'user':
        case 'assistant': {
          if ('message' in msg) {
            const content = msg.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                const role = msg.message.role
                if (block.type === 'tool_use' && 'id' in block) {
                  preNormalizedSeq.push(`${role}:tool_use:${block.id}`)
                } else if (
                  block.type === 'tool_result' &&
                  'tool_use_id' in block
                ) {
                  preNormalizedSeq.push(
                    `${role}:tool_result:${block.tool_use_id}`,
                  )
                } else if (block.type === 'text') {
                  preNormalizedSeq.push(`${role}:text`)
                } else if (block.type === 'thinking') {
                  preNormalizedSeq.push(`${role}:thinking`)
                } else if (block.type === 'image') {
                  preNormalizedSeq.push(`${role}:image`)
                } else {
                  preNormalizedSeq.push(`${role}:${block.type}`)
                }
              }
            } else if (typeof content === 'string') {
              preNormalizedSeq.push(`${msg.message.role}:string_content`)
            }
          }
          break
        }
        case 'attachment':
          if ('attachment' in msg) {
            preNormalizedSeq.push(`attachment:${msg.attachment.type}`)
          }
          break
        case 'system':
          if ('subtype' in msg) {
            preNormalizedSeq.push(`system:${msg.subtype}`)
          }
          break
        case 'progress':
          if (
            'progress' in msg &&
            msg.progress &&
            typeof msg.progress === 'object' &&
            'type' in msg.progress
          ) {
            preNormalizedSeq.push(`progress:${msg.progress.type ?? 'unknown'}`)
          } else {
            preNormalizedSeq.push('progress:unknown')
          }
          break
      }
    }

    // Log to Statsig
    logEvent('tengu_tool_use_tool_result_mismatch_error', {
      toolUseId:
        toolUseId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedSequence: normalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      preNormalizedSequence: preNormalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedMessageCount: messagesForAPI.length,
      originalMessageCount: messages.length,
      normalizedToolUseIndex: normalizedIndex,
      originalToolUseIndex: originalIndex,
    })
  } catch (_) {
    // Ignore errors in debug logging
  }
}

/**
 * Type guard to check if a value is a valid Message response from the API
 */
// ★ 类型谓词函数：判断一个未知值是不是合法的 API 消息响应。
// 为什么需要？因为响应可能是任何东西（HTML 错误页、null、结构不对的 JSON）。
// 用了 `value is BetaMessage` 之后，调用方 if 里就能直接当 BetaMessage 用。
export function isValidAPIMessage(value: unknown): value is BetaMessage {
  return (
// `typeof value === 'object' && value !== null`：
// ★ 必须同时判 null —— 因为 JS 里 typeof null === 'object'（历史 bug），
// 只判 typeof 会把 null 也放进来。Java 的 instanceof 对 null 天然返回 false。
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'model' in value &&
    'usage' in value &&
    Array.isArray((value as BetaMessage).content) &&
    typeof (value as BetaMessage).model === 'string' &&
    typeof (value as BetaMessage).usage === 'object'
  )
}

// AWS 返回的错误结构（嵌套很深且形态特殊），单独定义一个类型来描述。
/** Lower-level error that AWS can return. */
type AmazonError = {
  Output?: {
    __type?: string
  }
  Version?: string
}

/**
 * Given a response that doesn't look quite right, see if it contains any known error types we can extract.
 */
// 兜底解析：响应「长得不对」时，试着从里面挖出已知的错误类型标识。
export function extractUnknownErrorFormat(value: unknown): string | undefined {
  // Check if value is a valid object first
  if (!value || typeof value !== 'object') {
    return undefined
  }

  // Amazon Bedrock routing errors
  if ((value as AmazonError).Output?.__type) {
    return (value as AmazonError).Output!.__type
  }

  return undefined
}

// ★★【主入口】把任意错误翻译成一条「给用户看的」assistant 错误消息。
// 判断顺序是**从特殊到一般**：超时 → 图片/媒体 → 限流 → prompt 过长 → PDF → 
// 工具配对 → 模型名 → 账单 → 鉴权 → 404 → 连接错误 → 兜底。
// 每个分支都是 `error instanceof X && status === N && message.includes(...)` 三件套。
// 返回值是 AssistantMessage：它会被插入会话历史，这样 Claude 自己也能看到刚才出了什么事。
export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  options?: {
    messages?: Message[]
    messagesForAPI?: (UserMessage | AssistantMessage)[]
  },
): AssistantMessage {
  // Check for SDK timeout errors
// ①超时：区分 SDK 的超时类型，以及「连接错误但消息里含 timeout」的情况。
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return createAssistantAPIErrorMessage({
      content: API_TIMEOUT_ERROR_MESSAGE,
      error: 'unknown',
    })
  }

  // Check for image size/resize errors (thrown before API call during validation)
  // Use getImageTooLargeErrorMessage() to show "esc esc" hint for CLI users
  // but a generic message for SDK users (non-interactive mode)
// ②图片体积/缩放错误：这是在**发请求之前**的校验阶段就抛的（不是服务端返回的）。
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
    })
  }

// ③Opus 的人工限流开关：归类成 rate_limit。
  // Check for emergency capacity off switch for Opus PAYG users
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return createAssistantAPIErrorMessage({
      content: CUSTOM_OFF_SWITCH_MESSAGE,
      error: 'rate_limit',
    })
  }

// ④429 限流 —— 本文件最复杂的一段。
// 先读服务端新版的「统一限流」响应头，判断是哪种限流（5 小时窗 / 7 天窗 / Opus 7 天窗）、
// 超额用量（overage）是否可用、什么时候重置，然后交给 getRateLimitErrorMessage 生成精准文案。
  if (
    error instanceof APIError &&
    error.status === 429 &&
    shouldProcessRateLimits(isClaudeAISubscriber())
  ) {
    // Check if this is the new API with multiple rate limit headers
// `error.headers?.get?.(...)`：双重可选（headers 可能没有、get 可能不是函数）。
    const rateLimitType = error.headers?.get?.(
      'anthropic-ratelimit-unified-representative-claim',
    ) as 'five_hour' | 'seven_day' | 'seven_day_opus' | null

    const overageStatus = error.headers?.get?.(
      'anthropic-ratelimit-unified-overage-status',
    ) as 'allowed' | 'allowed_warning' | 'rejected' | null

    // If we have the new headers, use the new message generation
    if (rateLimitType || overageStatus) {
      // Build limits object from error headers to determine the appropriate message
      const limits: ClaudeAILimits = {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }

      // Extract rate limit information from headers
      const resetHeader = error.headers?.get?.(
        'anthropic-ratelimit-unified-reset',
      )
      if (resetHeader) {
        limits.resetsAt = Number(resetHeader)
      }

      if (rateLimitType) {
        limits.rateLimitType = rateLimitType
      }

      if (overageStatus) {
        limits.overageStatus = overageStatus
      }

      const overageResetHeader = error.headers?.get?.(
        'anthropic-ratelimit-unified-overage-reset',
      )
      if (overageResetHeader) {
        limits.overageResetsAt = Number(overageResetHeader)
      }

      const overageDisabledReason = error.headers?.get?.(
        'anthropic-ratelimit-unified-overage-disabled-reason',
      ) as OverageDisabledReason | null
      if (overageDisabledReason) {
        limits.overageDisabledReason = overageDisabledReason
      }

      // Use the new message format for all new API rate limits
      const specificErrorMessage = getRateLimitErrorMessage(limits, model)
      if (specificErrorMessage) {
        return createAssistantAPIErrorMessage({
          content: specificErrorMessage,
          error: 'rate_limit',
        })
      }

// ★ 值得注意的返回值：NO_RESPONSE_REQUESTED。
// 含义：这次限流**不展示**任何错误给用户，因为后台会自动降级（比如 Opus → Sonnet）；
// 但仍然要把这条消息记进会话历史，让 Claude 知道发生过什么。
      // If getRateLimitErrorMessage returned null, it means the fallback mechanism
      // will handle this silently (e.g., Opus -> Sonnet fallback for eligible users).
      // Return NO_RESPONSE_REQUESTED so no error is shown to the user, but the
      // message is still recorded in conversation history for Claude to see.
      return createAssistantAPIErrorMessage({
        content: NO_RESPONSE_REQUESTED,
        error: 'rate_limit',
      })
    }

// 没有限流头 → 说明**不是**配额问题，而是别的 429（比如权益校验失败、基础设施容量）。
// 这时不能笼统说「触发限流」，而要把服务端真正的说法展示出来。
    // No quota headers — this is NOT a quota limit. Surface what the API actually
    // said instead of a generic "Rate limit reached". Entitlement rejections
    // (e.g. 1M context without Extra Usage) and infra capacity 429s land here.
    if (error.message.includes('Extra usage is required for long context')) {
      const hint = getIsNonInteractiveSession()
        ? 'enable extra usage at claude.ai/settings/usage, or use --model to switch to standard context'
        : 'run /extra-usage to enable, or /model to switch to standard context'
      return createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: Extra usage is required for 1M context · ${hint}`,
        error: 'rate_limit',
      })
    }
// SDK 在没有顶层 message 时会把整个 body JSON 化并加上 '429 ' 前缀，
// 所以这里要把前缀剥掉、再从 JSON 里抠出内层 message。
    // SDK's APIError.makeMessage prepends "429 " and JSON-stringifies the body
    // when there's no top-level .message — extract the inner error.message.
    const stripped = error.message.replace(/^429\s+/, '')
    const innerMessage = stripped.match(/"message"\s*:\s*"([^"]*)"/)?.[1]
    const detail = innerMessage || stripped
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: Request rejected (429) · ${detail || 'this may be a temporary capacity issue — check status.anthropic.com'}`,
      error: 'rate_limit',
    })
  }

// ⑤prompt 过长。注意 Vertex 返回 413、直连 API 返回 400，所以这里只看文案不看状态码；
// 而且大小写不同（用 toLowerCase 抹平）。
// ★ content 保持通用文案（UI 靠精确匹配识别），真实的 token 数放进 errorDetails，
//   供 reactive compact 解析「超了多少」。这是一个很好的「展示与数据分离」设计。
  // Handle prompt too long errors (Vertex returns 413, direct API returns 400)
  // Use case-insensitive check since Vertex returns "Prompt is too long" (capitalized)
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('prompt is too long')
  ) {
    // Content stays generic (UI matches on exact string). The raw error with
    // token counts goes into errorDetails — reactive compact's retry loop
    // parses the gap from there via getPromptTooLongTokenGap.
    return createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // Check for PDF page limit errors
// ⑥PDF 页数超限（用正则匹配「maximum of N PDF pages」，因为 N 是变量）。
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfTooLargeErrorMessage(),
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // Check for password-protected PDF errors
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfPasswordProtectedErrorMessage(),
      error: 'invalid_request',
    })
  }

// ⑦无效 PDF（比如把 HTML 改名成 .pdf）。
// ★ 注释点出了这个分支的价值：如果不处理，这个坏 PDF 块会**一直留在上下文里**，
// 导致之后**每一次** API 调用都 400 —— 一个坏输入把整个会话废掉。
  // Check for invalid PDF errors (e.g., HTML file renamed to .pdf)
  // Without this handler, invalid PDF document blocks persist in conversation
  // context and cause every subsequent API call to fail with 400.
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified was not valid')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfInvalidErrorMessage(),
      error: 'invalid_request',
    })
  }

  // Check for image size errors (e.g., "image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes")
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  ) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
      errorDetails: error.message,
    })
  }

// ⑧多图请求时尺寸限制更严（2000px），单独给一条更明确的指引（建议 /compact 清掉旧图）。
  // Check for many-image dimension errors (API enforces stricter 2000px limit for many-image requests)
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  ) {
    return createAssistantAPIErrorMessage({
      content: getIsNonInteractiveSession()
        ? 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.'
        : 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.',
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

// ⑨auto mode 的 beta 头被拒（套餐不含该功能）。
// ★ AFK_MODE_BETA_HEADER 在外部构建里是空字符串，靠 `AFK_MODE_BETA_HEADER &&` 这个真值判断
// 让整段在非目标构建中失效（相当于编译期裁剪的运行时兜底）。
  // Server rejected the afk-mode beta header (plan does not include auto
  // mode). AFK_MODE_BETA_HEADER is '' in non-TRANSCRIPT_CLASSIFIER builds,
  // so the truthy guard keeps this inert there.
  if (
    AFK_MODE_BETA_HEADER &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(AFK_MODE_BETA_HEADER) &&
    error.message.includes('anthropic-beta')
  ) {
    return createAssistantAPIErrorMessage({
      content: 'Auto mode is unavailable for your plan',
      error: 'invalid_request',
    })
  }

// ⑩413 请求体太大（典型：大 PDF + 长会话超过 32MB 上限）。
  // Check for request too large errors (413 status)
  // This typically happens when a large PDF + conversation context exceeds the 32MB API limit
  if (error instanceof APIError && error.status === 413) {
    return createAssistantAPIErrorMessage({
      content: getRequestTooLargeErrorMessage(),
      error: 'invalid_request',
    })
  }

// ⑪tool_use 后面没有紧跟 tool_result —— 会话历史被破坏了。
// 处理：先上报排障日志，再给用户一条「用 /rewind 回滚」的恢复指引（避免死锁）。
  // Check for tool_use/tool_result concurrency error
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    // Log to Statsig if we have the message context
    if (options?.messages && options?.messagesForAPI) {
      const toolUseIdMatch = error.message.match(/toolu_[a-zA-Z0-9]+/)
      const toolUseId = toolUseIdMatch ? toolUseIdMatch[0] : null
      if (toolUseId) {
        logToolUseToolResultMismatch(
          toolUseId,
          options.messages,
          options.messagesForAPI,
        )
      }
    }

// 内部用户能看到更详细的信息（含去反馈频道的指引），外部用户只看到概括提示。
    if (process.env.USER_TYPE === 'ant') {
      const baseMessage = `API Error: 400 ${error.message}\n\nRun /share and post the JSON file to ${MACRO.FEEDBACK_CHANNEL}.`
      const rewindInstruction = getIsNonInteractiveSession()
        ? ''
        : ' Then, use /rewind to recover the conversation.'
      return createAssistantAPIErrorMessage({
        content: baseMessage + rewindInstruction,
        error: 'invalid_request',
      })
    } else {
      const baseMessage = 'API Error: 400 due to tool use concurrency issues.'
      const rewindInstruction = getIsNonInteractiveSession()
        ? ''
        : ' Run /rewind to recover the conversation.'
      return createAssistantAPIErrorMessage({
        content: baseMessage + rewindInstruction,
        error: 'invalid_request',
      })
    }
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    logEvent('tengu_unexpected_tool_result', {})
  }

// ⑫重复的 tool_use id。注释说明：发送前已有逻辑会剥离这类问题，
// 所以能走到这里说明出了**新的**损坏路径 —— 必须上报以便定位根因。
  // Duplicate tool_use IDs (CC-1212). ensureToolResultPairing strips these
  // before send, so hitting this means a new corruption path slipped through.
  // Log for root-causing, and give users a recovery path instead of deadlock.
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    logEvent('tengu_duplicate_tool_use_id', {})
    const rewindInstruction = getIsNonInteractiveSession()
      ? ''
      : ' Run /rewind to recover the conversation.'
    return createAssistantAPIErrorMessage({
      content: `API Error: 400 duplicate tool_use ID in conversation history.${rewindInstruction}`,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

// ⑬订阅用户用了 Opus 但套餐不支持（Pro 计划没有 Opus）。
// 提示里特意提到「刚升级过订阅就先 /logout 再 /login」，因为订阅信息是登录时缓存的。
  // Check for invalid model name error for subscription users trying to use Opus
  if (
    isClaudeAISubscriber() &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid model name') &&
    (isNonCustomOpusModel(model) || model === 'opus')
  ) {
    return createAssistantAPIErrorMessage({
      content:
        'Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.',
      error: 'invalid_request',
    })
  }

// 内部用户（ant）的专属分支：可能是组织没被加进模型白名单，
// 提示里直接给出 orgId，方便去反馈频道求助。
  // Check for invalid model name error for Ant users. Claude Code may be
  // defaulting to a custom internal-only model for Ants, and there might be
  // Ants using new or unknown org IDs that haven't been gated in.
  if (
    process.env.USER_TYPE === 'ant' &&
    !process.env.ANTHROPIC_MODEL &&
    error instanceof Error &&
    error.message.toLowerCase().includes('invalid model name')
  ) {
    // Get organization ID from config - only use OAuth account data when actively using OAuth
    const orgId = getOauthAccountInfo()?.organizationUuid
    const baseMsg = `[ANT-ONLY] Your org isn't gated into the \`${model}\` model. Either run \`claude\` with \`ANTHROPIC_MODEL=${getDefaultMainLoopModelSetting()}\``
    const msg = orgId
      ? `${baseMsg} or share your orgId (${orgId}) in ${MACRO.FEEDBACK_CHANNEL} for help getting access.`
      : `${baseMsg} or reach out in ${MACRO.FEEDBACK_CHANNEL} for help getting access.`

    return createAssistantAPIErrorMessage({
      content: msg,
      error: 'invalid_request',
    })
  }

  if (
    error instanceof Error &&
    error.message.includes('Your credit balance is too low')
  ) {
    return createAssistantAPIErrorMessage({
      content: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
      error: 'billing_error',
    })
  }
// ⑭「组织已被禁用」。最常见的原因（注释里说了）：环境变量里还留着**上一家**的
// ANTHROPIC_API_KEY，把订阅鉴权给盖掉了。
// 只处理「确实是环境变量来源」的情况——其它来源说明当前组织真的被禁了，没法靠改配置救。
  // "Organization has been disabled" — commonly a stale ANTHROPIC_API_KEY
  // from a previous employer/project overriding subscription auth. Only handle
  // the env-var case; apiKeyHelper and /login-managed keys mean the active
  // auth's org is genuinely disabled with no dormant fallback to point at.
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('organization has been disabled')
  ) {
    const { source } = getAnthropicApiKeyWithSource()
    // getAnthropicApiKeyWithSource conflates the env var with FD-passed keys
    // under the same source value, and in CCR mode OAuth stays active despite
    // the env var. The three guards ensure we only blame the env var when it's
    // actually set and actually on the wire.
// 三重校验确保「确实是该环境变量在起作用」（源码注释解释了原因：
// getAnthropicApiKeyWithSource 会把环境变量和 FD 传来的 key 归为同一来源，
// 而 CCR 模式下即使有环境变量 OAuth 也仍然生效）。
    if (
      source === 'ANTHROPIC_API_KEY' &&
      process.env.ANTHROPIC_API_KEY &&
      !isClaudeAISubscriber()
    ) {
      const hasStoredOAuth = getClaudeAIOAuthTokens()?.accessToken != null
// ★ 分类特意**不用** authentication_failed：因为那会触发 VS Code 弹出登录，
// 而登录根本解决不了这个问题（环境变量会继续覆盖 OAuth）。
// 正确解法是「改配置（unset 环境变量）」，所以归为 invalid_request。
// 教训：错误分类不只是标签，它会**驱动**具体行为，选错会让用户走进死路。
      // Not 'authentication_failed' — that triggers VS Code's showLogin(), but
      // login can't fix this (approved env var keeps overriding OAuth). The fix
      // is configuration-based (unset the var), so invalid_request is correct.
      return createAssistantAPIErrorMessage({
        error: 'invalid_request',
        content: hasStoredOAuth
          ? ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH
          : ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
      })
    }
  }

// ⑮API key 无效。CCR 模式下当成瞬时网络问题；否则按来源区分是「外部 key」还是「登录态」。
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    // In CCR mode, auth is via JWTs - this is likely a transient network issue
    if (isCCRMode()) {
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }

    // Check if the API key is from an external source
    const { source } = getAnthropicApiKeyWithSource()
    const isExternalSource =
      source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper'

    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: isExternalSource
        ? INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL
        : INVALID_API_KEY_ERROR_MESSAGE,
    })
  }

// ⑯OAuth token 被吊销（别的进程刷新过，本地这份作废）。
  // Check for OAuth token revocation error
  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getTokenRevokedErrorMessage(),
    })
  }

// ⑰组织不允许 OAuth 登录。
  // Check for OAuth organization not allowed error
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      'OAuth authentication is currently not allowed for this organization',
    )
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getOauthOrgNotAllowedErrorMessage(),
    })
  }

// 其它 401/403 的兜底：CCR 模式提示重试，否则提示 /login。
  // Generic handler for other 401/403 authentication errors
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    // In CCR mode, auth is via JWTs - this is likely a transient network issue
    if (isCCRMode()) {
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }

    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getIsNonInteractiveSession()
        ? `Failed to authenticate. ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`
        : `Please run /login · ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    })
  }

// Bedrock 的「没有该模型的访问权限」——错误信息里不含具体模型 ID，
// 所以这里自己把模型名拼进去，并建议一个可用的备选模型。
  // Bedrock errors like "403 You don't have access to the model with the specified model ID."
  // don't contain the actual model ID
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  ) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}. Try ${switchCmd} to switch to ${fallbackSuggestion}.`
        : `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}. Run ${switchCmd} to pick a different model.`,
      error: 'invalid_request',
    })
  }

// 404：模型不存在 / 没开通。引导用户用 /model 换一个。
  // 404 Not Found — usually means the selected model doesn't exist or isn't
  // available. Guide the user to /model so they can pick a valid one.
  // For 3P users, suggest a specific fallback model they can try.
  if (error instanceof APIError && error.status === 404) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `The model ${model} is not available on your ${getAPIProvider()} deployment. Try ${switchCmd} to switch to ${fallbackSuggestion}, or ask your admin to enable this model.`
        : `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run ${switchCmd} to pick a different model.`,
      error: 'invalid_request',
    })
  }

  // Connection errors (non-timeout) — use formatAPIError for detailed messages
// 连接错误（非超时）：交给 errorUtils 的 formatAPIError 生成详细文案
// （那里会把 SSL / 代理之类的问题翻译成可操作的建议）。
  if (error instanceof APIConnectionError) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${formatAPIError(error)}`,
      error: 'unknown',
    })
  }

// 最后两层兜底：普通 Error → 带上 message；非 Error（比如字符串）→ 只给通用前缀。
  if (error instanceof Error) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
      error: 'unknown',
    })
  }
  return createAssistantAPIErrorMessage({
    content: API_ERROR_MESSAGE_PREFIX,
    error: 'unknown',
  })
}

/**
 * For 3P users, suggest a fallback model when the selected model is unavailable.
 * Returns a model name suggestion, or undefined if no suggestion is applicable.
 */
// 给三方渠道（Bedrock/Vertex）用户推荐一个「大概率可用」的备选模型：
// Opus 4.6 → 4.1，Sonnet 4.6 → 4.5，Sonnet 4.5 → 4.0（逐级降级）。
// 第一方用户直接返回 undefined（不需要这个建议）。
function get3PModelFallbackSuggestion(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  // @[MODEL LAUNCH]: Add a fallback suggestion chain for the new model → previous version for 3P
  const m = model.toLowerCase()
  // If the failing model looks like an Opus 4.6 variant, suggest the default Opus (4.1 for 3P)
  if (m.includes('opus-4-6') || m.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  // If the failing model looks like a Sonnet 4.6 variant, suggest Sonnet 4.5
  if (m.includes('sonnet-4-6') || m.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  // If the failing model looks like a Sonnet 4.5 variant, suggest Sonnet 4
  if (m.includes('sonnet-4-5') || m.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}

// ★★【第二个主入口】把错误归类成一个字符串标签，供分析系统（Datadog / BigQuery）统计。
// 判断顺序同样是「从特殊到一般」，最后按状态码兜底。
// 注意它与 getAssistantMessageFromError 的判定条件要保持一致——
// 两边对同一个错误的认定必须吻合，否则统计口径会跟用户看到的对不上。
/**
 * Classifies an API error into a specific error type for analytics tracking.
 * Returns a standardized error type string suitable for Datadog tagging.
 */
export function classifyAPIError(error: unknown): string {
// 用户主动取消：不算错误，单独一类（避免污染错误率统计）。
  // Aborted requests
  if (error instanceof Error && error.message === 'Request was aborted.') {
    return 'aborted'
  }

  // Timeout errors
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return 'api_timeout'
  }

  // Check for repeated 529 errors
  if (
    error instanceof Error &&
    error.message.includes(REPEATED_529_ERROR_MESSAGE)
  ) {
    return 'repeated_529'
  }

  // Check for emergency capacity off switch
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return 'capacity_off_switch'
  }

  // Rate limiting
  if (error instanceof APIError && error.status === 429) {
    return 'rate_limit'
  }

  // Server overload (529)
  if (
    error instanceof APIError &&
    (error.status === 529 ||
      error.message?.includes('"type":"overloaded_error"'))
  ) {
    return 'server_overload'
  }

  // Prompt/content size errors
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(PROMPT_TOO_LONG_ERROR_MESSAGE.toLowerCase())
  ) {
    return 'prompt_too_long'
  }

  // PDF errors
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return 'pdf_too_large'
  }

  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  ) {
    return 'pdf_password_protected'
  }

  // Image size errors
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  ) {
    return 'image_too_large'
  }

  // Many-image dimension errors
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  ) {
    return 'image_too_large'
  }

  // Tool use errors (400)
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    return 'tool_use_mismatch'
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    return 'unexpected_tool_result'
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    return 'duplicate_tool_use_id'
  }

  // Invalid model errors (400)
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid model name')
  ) {
    return 'invalid_model'
  }

  // Credit/billing errors
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE.toLowerCase())
  ) {
    return 'credit_balance_low'
  }

  // Authentication errors
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    return 'invalid_api_key'
  }

  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  ) {
    return 'token_revoked'
  }

  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      'OAuth authentication is currently not allowed for this organization',
    )
  ) {
    return 'oauth_org_not_allowed'
  }

  // Generic auth errors
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    return 'auth_error'
  }

  // Bedrock-specific errors
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  ) {
    return 'bedrock_model_access'
  }

// 按状态码兜底：5xx → server_error，4xx → client_error。
  // Status code based fallbacks
  if (error instanceof APIError) {
    const status = error.status
    if (status >= 500) return 'server_error'
    if (status >= 400) return 'client_error'
  }

// 连接错误还要再细分：如果是 SSL/TLS 证书问题，单独标成 ssl_cert_error，
// 因为这类问题在企业网络里非常普遍，值得单独统计与告警。
  // Connection errors - check for SSL/TLS issues first
  if (error instanceof APIConnectionError) {
    const connectionDetails = extractConnectionErrorDetails(error)
    if (connectionDetails?.isSSLError) {
      return 'ssl_cert_error'
    }
    return 'connection_error'
  }

  return 'unknown'
}

// 给 SDK 对外暴露的粗分类（字段更少），用于 SDK 调用方判断大致的失败原因。
export function categorizeRetryableAPIError(
  error: APIError,
): SDKAssistantMessageError {
  if (
    error.status === 529 ||
    error.message?.includes('"type":"overloaded_error"')
  ) {
    return 'rate_limit'
  }
  if (error.status === 429) {
    return 'rate_limit'
  }
  if (error.status === 401 || error.status === 403) {
    return 'authentication_failed'
  }
  if (error.status !== undefined && error.status >= 408) {
    return 'server_error'
  }
  return 'unknown'
}

// ★ stop_reason === 'refusal'：模型**拒绝**回答（认为请求违反使用政策）。
// 这不是 HTTP 错误，而是模型正常返回但拒绝作答，所以要单独处理。
// 顺带上报一条 tengu_refusal_api_response 事件用于监控拒绝率。
export function getErrorMessageIfRefusal(
  stopReason: BetaStopReason | null,
  model: string,
): AssistantMessage | undefined {
  if (stopReason !== 'refusal') {
    return
  }

  logEvent('tengu_refusal_api_response', {})

// 同样按「交互 / 非交互」给出不同的后续指引（双击 esc 编辑上一条消息 vs 换个思路重来）。
  const baseMessage = getIsNonInteractiveSession()
    ? `${API_ERROR_MESSAGE_PREFIX}: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different approach.`
    : `${API_ERROR_MESSAGE_PREFIX}: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.`

  const modelSuggestion =
    model !== 'claude-sonnet-4-20250514'
      ? ' If you are seeing this refusal repeatedly, try running /model claude-sonnet-4-20250514 to switch models.'
      : ''

  return createAssistantAPIErrorMessage({
    content: baseMessage + modelSuggestion,
    error: 'invalid_request',
  })
}
