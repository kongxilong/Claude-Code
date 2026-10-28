/**
 * 【一句话定位】**服务端版 microcompact**：第二级压缩的另一条实现路径——
 * 不自己在客户端删消息，而是把「清理策略」随请求一起发给 API，由**服务端**按策略清理上下文。
 *
 * 【在架构中的位置】
 * - 上游：发请求的地方（src/services/api/ 下组装请求参数的代码），把本文件返回的配置塞进请求体；
 *   请求是在 src/query.ts 的主循环里发出的。
 * - 下游：Anthropic API 的 context management 能力（服务端执行）。
 * - 调用链：src/query.ts（主循环）→ 请求参数组装 → 本文件的 getAPIContextManagement() → API 服务端执行清理
 *
 * 【客户端 microcompact vs 服务端 context management】
 * 两者目标相同：丢掉体积大但已经不太重要的 tool result / tool use，给上下文减重。区别在于执行位置：
 * - 客户端（见 ./microCompact.ts）：我们自己改写 messages 数组，把内容换成占位符再发出去。
 *   优点是完全可控、不依赖服务端能力；缺点是我们送出去的 prompt 已经变了，
 *   而服务端收到的文本一变，**prompt 缓存就再也命中不了**（等于每次重发整段）。
 * - 服务端（本文件）：请求照原样发出，附带一份「清理策略」，由服务端在**缓存之后再**执行清理。
 *   好处是缓存命中不受影响（ prefix 仍然一致），这是它存在的最大价值。
 *
 * 【两个关键阈值怎么理解】
 *   trigger.value（= DEFAULT_MAX_INPUT_TOKENS = 180_000）  输入 token 超过它就触发清理
 *   clear_at_least.value（= trigger - keepTarget = 140_000）触发后**至少要清掉这么多** token
 * 「至少要清掉」是个硬性保险：保证一次清理能留出足够空间，
 * 否则每请求触发一次、每次只清一点点，就会陷入反复清理的抖动。
 *
 * 【为什么区分「可清 Result 的工具」和「可清 Use 的工具」】
 * - TOOLS_CLEARABLE_RESULTS（读类工具：Bash/Glob/Grep/Read/WebFetch/WebSearch）：
 *   它们的**输出**往往很大（一次 Read 可能几万 token），但引用到它的历史一旦过去就没什么用了。
 *   所以对这类工具传 `clear_tool_inputs`（清的是它们留下的结果内容）。
 * - TOOLS_CLEARABLE_USES（写类工具：Edit/Write/NotebookEdit）：
 *   反过来，它们的**输出**通常很短（「写完了」），有价值的是「改了什么」这个**动作本身**，
 *   所以对这类工具传 `exclude_tools`（排除在清理范围外，即保护它们的 use 记录）。
 *
 * 【本文件包含什么】
 * - DEFAULT_MAX_INPUT_TOKENS / DEFAULT_TARGET_INPUT_TOKENS：默认阈值常量。
 * - TOOLS_CLEARABLE_RESULTS / TOOLS_CLEARABLE_USES：两类工具名单。
 * - type ContextEditStrategy：单条清理策略的结构（两种变体：清 tool / 清 thinking）。
 * - type ContextManagementConfig：策略列表的包装 `{ edits: [...] }`。
 * - getAPIContextManagement()：按当前情况组装出要发给 API 的配置。
 *
 * 【TS 语法速查】
 * - `A | B` 联合类型：这里是**对象字面量类型的联合**（可辨识联合 / discriminated union），
 *   靠 `type` 字段区分（'clear_tool_uses_20250919' vs 'clear_thinking_20251015'）。
 *   ≈ Java 的 sealed interface + 两个 record 实现，但 TS 里写成一个类型就够。
 * - `type: 'clear_tool_uses_20250919'`：用**字符串字面量**当类型 ≈ Java 用 enum 限定取值；
 *   写法上只是个常量，但类型系统只允许这个值。
 * - `'all' | { type: 'thinking_turns'; value: number }`：字面量 `'all'` 与对象类型的联合，
 *   表示「要么写死字符串 all，要么给一个对象」。
 * - 属性后面带 `?`：`trigger?: {...}` 表示**可选属性**（可以不写），≈ Java 的 @Nullable 字段。
 * - `boolean | string[]`：表示「既可以是布尔，也可以是字符串数组」（按不同粒度控制）。
 * - `[...SHELL_TOOL_NAMES, GLOB_TOOL_NAME]`：**展开运算符** `...` 把数组元素平铺进新数组，
 *   ≈ Java 的 Stream.concat + collect，只是写在字面量里。
 * - `options?: { hasThinking?: boolean, ... }`：入参是一个「全字段可选」的对象，
 *   这是 TS 里替代「多个可选参数」的常规写法（命名参数的效果）。
 * - `options ?? {}`：`??` 是**空值合并**，只在左边为 null/undefined 时用右边；
 *   注意它与 `||` 的区别——`||` 会把 0、'' 也当成「假」替换掉，`??` 不会。
 * - 解构赋默认值 `const { hasThinking = false } = ...`：属性不存在时用 false，
 *   ≈ Java 里手动 `x == null ? false : x`。
 * - 返回值类型 `ContextManagementConfig | undefined`：明确表示「可能没有配置」，
 *   调用方必须处理 undefined（这就是反感写法 Optional<ContextManagementConfig> 的等价物）。
 * - `process.env.XXX`：读环境变量（Node/Bun 运行时提供），TS 里它的类型是 `string | undefined`。
 */
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { SHELL_TOOL_NAMES } from 'src/utils/shell/shellToolUtils.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

// docs: https://docs.google.com/document/d/1oCT4evvWTh3P6z-kcfNQwWTCxAhkoFndSaNS9Gm40uw/edit?tab=t.0

// Default values for context management strategies
// Match client-side microcompact token values
// 两条英文注释的中文补充：这两个默认值刻意与**客户端 microcompact** 的阈值保持一致，
// 这样无论走客户端还是服务端路径，触发时机和保留量都差不多，便于对比 AB 实验效果。
const DEFAULT_MAX_INPUT_TOKENS = 180_000 // Typical warning threshold
const DEFAULT_TARGET_INPUT_TOKENS = 40_000 // Keep last 40k tokens like client-side

// 「读类」工具名单：它们的**输出**通常很大且时效性短，适合被清理。
const TOOLS_CLEARABLE_RESULTS = [
  ...SHELL_TOOL_NAMES,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
]

// 「写类」工具名单：它们的输出很短，真正有价值的是「改过什么」这个动作，
// 所以要把它们**排除**在清理范围之外（见下面 exclude_tools 的用法）。
const TOOLS_CLEARABLE_USES = [
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]

// Context management strategy types matching API documentation
// 单条清理策略。两种「形状」用 `|` 拼成一个可辨识联合，靠 type 字段区分是哪一种：
//   ① clear_tool_uses_20250919 —— 按 token 阈值清理工具调用相关内容
//   ② clear_thinking_20251015  —— 清理 thinking 块（模型的思考过程）
export type ContextEditStrategy =
  | {
      type: 'clear_tool_uses_20250919'
      trigger?: {
        type: 'input_tokens'
        value: number
      }
      keep?: {
        type: 'tool_uses'
        value: number
      }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
      clear_at_least?: {
        type: 'input_tokens'
        value: number
      }
    }
  | {
      type: 'clear_thinking_20251015'
      keep: { type: 'thinking_turns'; value: number } | 'all'
    }

// Context management configuration wrapper
// 最终发给 API 的形态：一组策略的有序列表。
export type ContextManagementConfig = {
  edits: ContextEditStrategy[]
}

// API-based microcompact implementation that uses native context management
/**
 * 组装要发给 API 的「上下文管理策略」配置。
 *
 * 为什么需要：与其客户端自己删消息（会破坏 prompt 缓存），不如把策略交给服务端，
 * 让服务端在缓存之后再清理。这样既省了 token，又不影响缓存命中率。
 *
 * @param options.hasThinking            当前是否已产生 thinking 块（没有就不需要清 thinking 的策略）。
 * @param options.isRedactThinkingActive 是否开启了 thinking 脱敏。脱敏后的块模型已经看不到内容，
 *                                       再针对它生成策略没有意义，所以要跳过。
 * @param options.clearAllThinking       是否激进清理 thinking（闲置超过 1 小时、缓存必然 miss 时）。
 * @returns ContextManagementConfig | undefined：undefined 表示「没有任何策略要下发」，
 *          调用方此时不应把这个字段放进请求体。
 *
 * 关键步骤：
 *   ① 先用 `options ?? {}` 兜底 — 调用方可以不传任何东西
 *   ② 解构时给三个字段都写上默认值 false
 *   ③ 需要保护 thinking 时，push 一条 clear_thinking 策略（脱敏时跳过）
 *   ④ 服务端清工具的能力目前**只对 ant 内部用户开放**，非 ant 直接返回
 *   ⑤ ant 用户再按环境变量决定是否清理 tool result / tool use，分别 push 一条策略
 *   ⑥ 一条策略都没有时返回 undefined，而不是返回空 edits 数组 —— 避免给请求体塞无用字段
 */
export function getAPIContextManagement(options?: {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
}): ContextManagementConfig | undefined {
  const {
    // 解构 + 默认值：没传的字段自动取 false。
    // `options ?? {}` 用的是空值合并：只有 options 为 null/undefined 时才用 {}，
    // 如果写成 `options || {}`，当 options 是 0/'' 这类「假值」时也会被替换掉（这里是对象，无所谓，但习惯要养好）。
    hasThinking = false,
    isRedactThinkingActive = false,
    clearAllThinking = false,
  } = options ?? {}

  const strategies: ContextEditStrategy[] = []

  // Preserve thinking blocks in previous assistant turns. Skip when
  // redact-thinking is active — redacted blocks have no model-visible content.
  // When clearAllThinking is set (>1h idle = cache miss), keep only the last
  // thinking turn — the API schema requires value >= 1, and omitting the edit
  // falls back to the model-policy default (often "all"), which wouldn't clear.
  if (hasThinking && !isRedactThinkingActive) {
    strategies.push({
      type: 'clear_thinking_20251015',
      // 三元表达式 ≈ Java 的 `cond ? a : b`。
      // 为什么不是「干脆省略这条策略」：API 有默认值兜底（通常是保留 all），
      // 省略 = 走默认 = 什么都不会被清理；而这里我们要的是「明确清掉」，所以必须显式写 value: 1。
      // value 最小是 1（API schema 要求 >= 1），表示「只保留最近一轮 thinking」。
      keep: clearAllThinking ? { type: 'thinking_turns', value: 1 } : 'all',
    })
  }

  // Tool clearing strategies are ant-only
  // 英文注释「Tool clearing strategies are ant-only」的中文说明：
  // 服务端的工具清理能力目前只给内部（ant）用户开放。
  // 注意这里**提前 return**，而不是把下面的逻辑包在 else 里 —— 提前返回的写法让主流程少一层缩进。
  if (process.env.USER_TYPE !== 'ant') {
    // 一条策略都没有就返回 undefined（而不是 { edits: [] }），
    // 这样调用方可以简单地判断 `if (config)`，也避免给请求体塞一个没有意义的空字段。
    return strategies.length > 0 ? { edits: strategies } : undefined
  }

  const useClearToolResults = isEnvTruthy(
    process.env.USE_API_CLEAR_TOOL_RESULTS,
  )
  const useClearToolUses = isEnvTruthy(process.env.USE_API_CLEAR_TOOL_USES)

  // If no tool clearing strategy is enabled, return early
  if (!useClearToolResults && !useClearToolUses) {
    return strategies.length > 0 ? { edits: strategies } : undefined
  }

  // 分支 A：清理「读类工具留下的结果」。
  // 用 `clear_tool_inputs: TOOLS_CLEARABLE_RESULTS`（白名单 = 只清这几个工具的输入/结果内容）。
  if (useClearToolResults) {
    const triggerThreshold = process.env.API_MAX_INPUT_TOKENS
      ? parseInt(process.env.API_MAX_INPUT_TOKENS)
      : DEFAULT_MAX_INPUT_TOKENS
    const keepTarget = process.env.API_TARGET_INPUT_TOKENS
      ? parseInt(process.env.API_TARGET_INPUT_TOKENS)
      : DEFAULT_TARGET_INPUT_TOKENS

    // 策略常量的中文对照：
    //   trigger        —— 输入 token 数超过这个值时开始清理
    //   clear_at_least —— 一旦触发，至少要清掉这么多 token（防止「每次只清一点点」的抖动）
    const strategy: ContextEditStrategy = {
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: triggerThreshold,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: triggerThreshold - keepTarget,
      },
      clear_tool_inputs: TOOLS_CLEARABLE_RESULTS,
    }

    strategies.push(strategy)
  }

  // 分支 B：清理「工具调用」本身（比分支 A 更激进 —— 连 tool_use 块都清掉）。
  // 用 `exclude_tools: TOOLS_CLEARABLE_USES`（黑名单 = 写类工具不动，保护「改过什么」的记录）。
  // 注意 A、B 用的是同一个策略 type，靠传 `clear_tool_inputs` 还是 `exclude_tools` 区分语义。
  if (useClearToolUses) {
    const triggerThreshold = process.env.API_MAX_INPUT_TOKENS
      ? parseInt(process.env.API_MAX_INPUT_TOKENS)
      : DEFAULT_MAX_INPUT_TOKENS
    const keepTarget = process.env.API_TARGET_INPUT_TOKENS
      ? parseInt(process.env.API_TARGET_INPUT_TOKENS)
      : DEFAULT_TARGET_INPUT_TOKENS

    const strategy: ContextEditStrategy = {
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: triggerThreshold,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: triggerThreshold - keepTarget,
      },
      exclude_tools: TOOLS_CLEARABLE_USES,
    }

    strategies.push(strategy)
  }

  // 收尾：与中间那两处提前 return 同样的判断 —— 有策略才返回配置，没有就返回 undefined。
  return strategies.length > 0 ? { edits: strategies } : undefined
}
