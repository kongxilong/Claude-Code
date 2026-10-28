/**
 * ============================================================================
 *  【文件总览】src/services/PromptSuggestion/promptSuggestion.ts
 *            —— "猜用户下一句要输入什么" 的建议生成服务
 * ============================================================================
 *
 *  一句话定位：
 *  当 Claude 刚回答完一轮、光标停在输入框里时，本文件负责**额外跑一次小模型调用**，
 *  让模型预测"用户接下来最可能亲手敲进去的那句话"，例如：
 *
 *      Claude 刚写完代码          →  建议 "try it out"
 *      Claude 刚修完 bug          →  建议 "run the tests"
 *      Claude 问"要我继续吗"      →  建议 "yes"
 *      任务明显做完了             →  建议 "commit this"
 *
 *  然后把这句建议以"灰色提示文字"的形式显示在输入框里（就像搜索引擎的搜索建议），
 *  用户按 → 或 Tab 就能直接采纳，不用自己打字。
 *
 *  注意区分本目录的两个文件（它们是一对）：
 *    - promptSuggestion.ts  ← ★ 本文件：只负责「生成那句建议文本」（纯文本，很便宜）
 *    - speculation.ts       ← 负责「把这句建议真的提前执行掉」（很贵，要跑工具）
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置】调用链
 * ---------------------------------------------------------------------------
 *      UI 层 (src/screens/REPL.tsx)
 *        └─> 一轮对话结束，触发 post-sampling hook（采样后钩子）
 *              └─> executePromptSuggestion()        ← ★ 本文件
 *                    ├─> tryGenerateSuggestion()    ← ★ 本文件（各种前置守卫判空）
 *                    │     ├─> getSuggestionSuppressReason()   判断当前是否该闭嘴
 *                    │     ├─> generateSuggestion()            真正调模型
 *                    │     │     └─> runForkedAgent()  ← src/utils/forkedAgent.ts（分叉出一个临时 agent）
 *                    │     └─> shouldFilterSuggestion()        事后过滤掉不合格的建议
 *                    └─> startSpeculation()          ← ./speculation.ts（用建议去做预执行）
 *
 *      SDK 推送路径（非 TUI）也会复用 tryGenerateSuggestion()，
 *      所以它被刻意拆成「可独立调用的纯函数」，不依赖任何 React 组件。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】主要函数清单
 * ---------------------------------------------------------------------------
 *   1. shouldEnablePromptSuggestion()   总开关：这个功能到底要不要开（环境变量/灰度/设置）
 *   2. getPromptVariant()               当前用哪个 prompt 版本（A/B 实验用）
 *   3. abortPromptSuggestion()          取消正在生成的建议（用户已经开始打字了就作废）
 *   4. getSuggestionSuppressReason()    当前时刻"该不该闭嘴"的判断（返回 null 表示可以说）
 *   5. tryGenerateSuggestion()          ★ 主流程：守卫 → 生成 → 过滤，三段式
 *   6. executePromptSuggestion()        CLI/TUI 入口，生成完写进 AppState 并启动 speculation
 *   7. getParentCacheSuppressReason()   父请求太大就不生成（否则缓存未命中，白花钱）
 *   8. generateSuggestion()             真正发起模型调用的地方
 *   9. shouldFilterSuggestion()         一堆正则规则，把模型的"胡说八道"过滤掉
 *  10. logSuggestionOutcome() / logSuggestionSuppressed()  埋点上报（采纳率/拦截原因）
 *
 * ---------------------------------------------------------------------------
 *  【核心概念：为什么要"预测用户要输入什么"，而不是让 Claude 直接干？】
 * ---------------------------------------------------------------------------
 *  这是产品上的一个重要克制：建议必须是**用户自己会说出的话**（user's voice），
 *  不能是 Claude 的口吻。所以 SUGGESTION_PROMPT 里反复强调：
 *      - 禁止 "Let me..." / "I'll..." 这类 Claude 口吻      → claude_voice 过滤器
 *      - 禁止 "looks good" / "thanks" 这类评价性废话        → evaluative 过滤器
 *      - 禁止 "what about...?" 这类反问                     → 反问没意义，用户不会这么打字
 *      - 猜不出来就**保持沉默**（返回空），宁缺毋滥
 *
 *  判据只有一句："用户看到这句时，会不会觉得'我正想打这个'？"
 *
 * ---------------------------------------------------------------------------
 *  【核心概念：为什么生成建议要"分叉 agent"而不是直接调 API？】
 * ---------------------------------------------------------------------------
 *  generateSuggestion() 用的是 runForkedAgent（分叉 agent），不是裸 API 调用。
 *  原因在代码注释里写得很直白：**为了蹭主线程已经建好的 prompt cache**。
 *
 *  Claude API 有「prompt cache（提示词缓存）」：如果这次请求的前缀和上次一模一样，
 *  命中缓存的部分只收 10% 的钱、速度也快得多。而建议生成请求的前缀
 *  （system prompt + 工具定义 + 历史消息）正好和主线程完全一样，
 *  只是末尾多了一条 "请预测用户下一句话" 的消息。
 *
 *  所以这里的铁律是（代码里那段长长的英文注释就在讲这个）：
 *      **绝不能改动任何会影响 cache key 的 API 参数**。
 *      曾经有人在分叉请求上设了 effort:'low'（PR #18143），
 *      结果缓存命中率从 92.7% 掉到 61%，cache 写入量暴涨 45 倍。
 *  唯一允许覆盖的只有：abortController（不发到 API）、
 *  skipTranscript / skipCacheWrite / canUseTool（都是纯客户端行为）。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的语法，逐条 Java 对照）
 * ---------------------------------------------------------------------------
 *  - `type PromptVariant = 'user_intent' | 'stated_intent'`
 *      字符串字面量联合类型。≈ Java 的 enum，但底层就是 String，
 *      好处是写错字符串编译期就报错。
 *
 *  - `Record<PromptVariant, string>`
 *      ≈ Java 的 `EnumMap<PromptVariant, String>` / `Map<K,V>` 泛型。
 *      Record 是 TS 内置工具类型：Record<键类型, 值类型>。
 *
 *  - `Array<[string, () => boolean]>`
 *      元组数组。`[string, () => boolean]` 是**定长且各位置类型固定**的数组
 *      ≈ Java 没有原生对应，近似一个二元组 `record Pair(String a, Supplier<Boolean> b)`。
 *      `() => boolean` 是无参返回 boolean 的函数类型 ≈ Java 的 `Supplier<Boolean>`。
 *
 *  - `for (const [reason, check] of filters)`
 *      对上面那个元组数组做**解构遍历**，一次拿出两个元素。
 *      ≈ Java：`for (var p : filters) { var reason = p.a(); var check = p.b(); }`
 *
 *  - `a ?? b` 空值合并：只有 a 是 null/undefined 时才取 b。
 *      ⚠️ 与 `||` 不同：`0`、`''`、`false` 这些"假值"不会被 `??` 替换。
 *      本文件 `usage.input_tokens ?? 0` 就是典型：token 数是 0 时仍然要保留 0。
 *
 *  - `x !== false`  这种"三态判断"：
 *      `getInitialSettings()?.promptSuggestionEnabled !== false` 的含义是
 *      「没配过（undefined）→ 按开启算；只有显式配成 false 才关」。
 *      这是 TS/JS 里表示"默认开启的可选开关"的惯用写法，Java 里没有这么简洁的写法。
 *
 *  - `!` 非空断言：`suggestion!.slice(0, 50)` = "我保证它不是 null，编译器别管"。
 *      ≈ Java 的强制类型转换，运行时不检查，骗编译器而已。
 *
 *  - `as X` 类型断言 ≈ 强转。本文件大量
 *      `'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 *      那串巨长的类型名是一个"品牌类型（branded type）"：
 *      它本质还是 string，但必须显式断言才能传给 logEvent，
 *      目的是**逼每个埋点作者人工确认"这不是代码也不是文件路径"**（防止把用户源码泄露到日志里）。
 *
 *  - `{ ...obj, ...(cond && { k: v }) }`  条件展开。
 *      当 cond 为 false 时，`false` 被展开成**零个属性**（这是 JS 的特殊规则）。
 *      ≈ Java 没有；可以理解成"条件性地往 map 里 put 一个键"。
 *      本文件 logEvent 里反复用，用来避免往埋点里塞 null 字段。
 *
 *  - `source?: 'cli' | 'sdk'`  可选参数。≈ Java 的可空入参，调用时可省略。
 *
 *  - `async () => ({ behavior: 'deny' as const, ... })`
 *      箭头函数直接返回一个**对象字面量**，所以要加一层小括号 `({...})`
 *      （否则 `{` 会被当成函数体的大括号）。这是新手最容易踩的坑。
 *      `'deny' as const` 把类型收窄成字面量 'deny' 而不是宽泛的 string。
 *
 *  - `export function f(): Promise<{...} | null>`  返回"可能为空的异步结果"
 *      ≈ Java 的 `CompletableFuture<Optional<T>>`，但 TS 用 `| null` 表达。
 *
 *  - 类型标注在变量/参数**后面**：`source?: 'cli' | 'sdk'`、`let n: number`。
 *      Java 是写在前面，初期最容易看串。
 * ============================================================================
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { count } from '../../utils/array.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { toError } from '../../utils/errors.js'
import {
  type CacheSafeParams,
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { logError } from '../../utils/log.js'
import {
  createUserMessage,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { isTeammate } from '../../utils/teammate.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { currentLimits } from '../claudeAiLimits.js'
import { isSpeculationEnabled, startSpeculation } from './speculation.js'

// 模块级可变状态：记录"当前正在生成的那次建议"的取消令牌。
// 为什么是模块级而不是放到 AppState 里？因为 abort 可能发生在任何 UI 时机
// （用户一开始打字就要立刻取消），走一遍 React 状态更新太慢也不必要。
// AbortController ≈ Java 的 CancellationTokenSource：
//   调用 .abort() 后，所有监听 signal 的 fetch/异步操作会收到中断通知。
// 用 `| null` 表示"当前没有在生成"，这是 TS 表达"可空"的方式（≈ Optional）。
let currentAbortController: AbortController | null = null

// 建议 prompt 的版本标识。目前只有一个版本（user_intent），
// 保留这个联合类型是给 A/B 实验留的口子：将来加新版本 prompt 时，
// 可以通过灰度给不同用户下发不同 promptId，再用埋点对比采纳率。
export type PromptVariant = 'user_intent' | 'stated_intent'

/**
 * 返回当前应使用的建议 prompt 版本。
 *
 * 为什么需要它：埋点里要带上 promptId，才能把"采纳率"归因到具体哪个 prompt 版本。
 * 目前两个版本指向同一份 SUGGESTION_PROMPT（历史上做过 A/B 实验，实验结束了但结构留着），
 * 所以这个函数现在恒返回 'user_intent'。
 *
 * @returns {PromptVariant} 当前生效的 prompt 版本标识
 */
export function getPromptVariant(): PromptVariant {
  return 'user_intent'
}

/**
 * 判断"输入建议"这个功能在当前环境下是否应该开启。
 *
 * 为什么需要它：这是个**侵入性**很强的功能（每次对话结束都要多花一次模型调用），
 * 所以开关逻辑必须层层设卡：命令行环境变量 > 灰度配置 > 会话模式 > 用户设置。
 * 任何一关卡住就关闭，并且每一关都会打一条埋点说明"是被哪一关关掉的"，
 * 这样线上出问题时能直接查日志定位。
 *
 * 判断顺序（越靠前优先级越高）：
 *   ① 环境变量 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION（测试用，优先级最高，压过一切）
 *   ② GrowthBook 灰度开关 tengu_chomp_inflection
 *   ③ 非交互会话（print 模式 / 管道输入 / SDK）一律关闭 —— 没人看得到建议，纯浪费钱
 *   ④ swarm（多 agent 协作）里的"队员"关闭，只有队长显示，否则一屏弹出多份建议
 *   ⑤ 用户设置 promptSuggestionEnabled（默认开启）
 *
 * @returns {boolean} true 表示开启
 */
export function shouldEnablePromptSuggestion(): boolean {
  // Env var overrides everything (for testing)
  // 中文补充：环境变量优先级最高。注意这里区分"显式设为假"和"压根没设"——
  // isEnvDefinedFalsy 只对 "0"/"false"/"no" 之类的显式假值返回 true，
  // 没设置（undefined）时不算数，会继续往下走灰度判断。
  const envOverride = process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION
  if (isEnvDefinedFalsy(envOverride)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }
  if (isEnvTruthy(envOverride)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: true,
      source:
        'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return true
  }

  // Keep default in sync with Config.tsx (settings toggle visibility)
  // 中文补充：灰度开关（GrowthBook）。默认 false = 未灰度到就关闭。
  // 函数名里的 _CACHED_MAY_BE_STALE 是个很诚实的命名：读的是本地缓存值，
  // 可能不是最新的。对"是否显示建议"这种无关紧要的展示逻辑可以接受，
  // 但绝不能用在计费、权限这类必须实时的判断上。
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_chomp_inflection', false)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'growthbook' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // Disable in non-interactive mode (print mode, piped input, SDK)
  // 中文补充：非交互模式（claude -p、管道输入、SDK 调用）下没有人类盯着输入框，
  // 生成的建议永远不会被看到，属于纯烧钱，必须关掉。
  if (getIsNonInteractiveSession()) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'non_interactive' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // Disable for swarm teammates (only leader should show suggestions)
  // 中文补充：swarm = 多个 agent 并行协作。队员各自跑在自己的"线程"里，
  // 如果每个队员都弹建议，界面会同时冒出好几条相互矛盾的建议，非常混乱。
  // 所以约定：只有队长（leader）有资格向用户展示建议。
  if (isAgentSwarmsEnabled() && isTeammate()) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'swarm_teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // 最后落到用户设置。注意 `?.` 和 `!== false` 的配合是刻意的：
  //   getInitialSettings() 可能返回 undefined → `?.` 让整条链短路成 undefined
  //   undefined !== false  → true（没配过，按**默认开启**处理）
  //   只有用户显式配成 false 时才是 false
  // 这就是 TS 里"默认开启的可选布尔开关"的标准写法。
  // 对比一下：如果写成 `=== true`，那没配过的用户就会被关掉，是个经典 bug。
  const enabled = getInitialSettings()?.promptSuggestionEnabled !== false
  logEvent('tengu_prompt_suggestion_init', {
    enabled,
    source:
      'setting' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return enabled
}

/**
 * 取消正在进行的建议生成。
 *
 * 什么时候会调用：用户**一开始动手打字**的那一刻。
 * 人都已经在输入了，说明我们的猜测没猜中，再继续等模型返回就是白等，
 * 而且返回的文本还可能干扰用户，所以立刻 abort 掉。
 *
 * 为什么用完要置回 null：这个模块级变量是全局唯一的，
 * 不置空的话下次 executePromptSuggestion 会拿到一个已经 abort 过的旧控制器。
 */
export function abortPromptSuggestion(): void {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
}

/**
 * Returns a suppression reason if suggestions should not be generated,
 * or null if generation is allowed. Shared by main and pipelined paths.
 */
/**
 * 【中文】判断"此时此刻该不该闭嘴"。
 *
 * 为什么需要它：shouldEnablePromptSuggestion() 管的是**全局开关**（这个用户有没有这功能），
 * 而本函数管的是**瞬时时机**（这一秒适不适合弹）。两者是不同维度：
 * 功能开着，但用户正在处理权限弹窗时，你再弹一条建议就是在添乱。
 *
 * 设计上的小技巧：返回值不是 boolean 而是 `string | null`——
 * null 表示"可以生成"，否则返回的字符串既是"不可以"又是"不可以的原因"。
 * 这样一个返回值同时承担了判断和埋点两个职责，调用方不用再自己拼原因。
 *
 * 五条拦截规则：
 *   ① disabled           功能没开
 *   ② pending_permission 正弹着"允许执行吗？"的权限确认框（Worker / Sandbox 请求）
 *   ③ elicitation_active 正在向用户追问信息（elicitation = 主动向用户索取输入）
 *   ④ plan_mode          计划模式下只讨论方案不改代码，不该怂恿用户往下执行
 *   ⑤ rate_limit         外部用户撞上限流了，别再制造额外请求
 *
 * @param {AppState} appState 当前应用状态快照
 * @returns {string | null} null = 允许生成；否则为拦截原因（用于埋点）
 */
export function getSuggestionSuppressReason(appState: AppState): string | null {
  if (!appState.promptSuggestionEnabled) return 'disabled'
  // 有权限请求悬在那里时，UI 的焦点应该在权限框上，弹建议会分散注意力
  if (appState.pendingWorkerRequest || appState.pendingSandboxRequest)
    return 'pending_permission'
  // elicitation 队列非空 = 还有问题等着用户回答
  if (appState.elicitation.queue.length > 0) return 'elicitation_active'
  // plan 模式：此时 Claude 只该给方案，不该暗示用户"接着执行"
  if (appState.toolPermissionContext.mode === 'plan') return 'plan_mode'
  // 只对外部用户（USER_TYPE=external）做限流判断，内部员工不受影响
  if (
    process.env.USER_TYPE === 'external' &&
    currentLimits.status !== 'allowed'
  )
    return 'rate_limit'
  return null
}

/**
 * Shared guard + generation logic used by both CLI TUI and SDK push paths.
 * Returns the suggestion with metadata, or null if suppressed/filtered.
 */
/**
 * 【中文】★ 本文件的核心流程：生成一条建议（三段式：守卫 → 生成 → 过滤）。
 *
 * 为什么单独抽出来：CLI/TUI 路径和 SDK 推送路径都要用同一套逻辑。
 * 如果把这段代码写死在 executePromptSuggestion 里，SDK 就得复制一份，
 * 两边守卫规则迟早会不一致（一边修了 bug 另一边没修）。
 *
 * 关键步骤：
 *   ① 检查 abortController 是否已被取消（可能用户在排队期间就开始打字了）
 *   ② 对话太短就放弃 —— 少于 2 轮 assistant 消息时，模型没有足够上下文可猜，
 *      猜出来的东西基本是瞎猜，用户体验反而更差
 *   ③ 上一轮是 API 错误消息就放弃 —— 用户正焦头烂额看报错，这时候弹建议很讨嫌
 *   ④ 父请求太大就放弃（cache_cold）—— 见 getParentCacheSuppressReason
 *   ⑤ 查 getSuggestionSuppressReason 的瞬时拦截
 *   ⑥ 真正调模型 generateSuggestion()
 *   ⑦ **调完再查一次 abort** —— 模型调用耗时几百毫秒到几秒，
 *      这段时间里用户可能早就开始打字了，必须复查，否则会覆盖用户已有的输入
 *   ⑧ 空结果 / 不过滤器 → 放弃
 *
 * @param {AbortController} abortController 取消令牌，由调用方持有并可在中途 abort
 * @param {Message[]} messages 当前会话的完整消息历史
 * @param {() => AppState} getAppState 惰性取状态的函数（不是直接传快照！）
 * @param {CacheSafeParams} cacheSafeParams 从主线程继承过来的、保证缓存命中的参数
 * @param {'cli' | 'sdk'} [source] 调用来源，仅用于埋点区分
 * @returns 成功则返回 { suggestion, promptId, generationRequestId }；否则返回 null
 *
 * ⚠️ Java 工程师注意：getAppState 传的是**函数**而不是状态值。
 *    这是 React 世界的常见套路（"惰性读取"）：因为状态随时在变，
 *    传值的话可能拿到过期的快照。≈ Java 里传 Supplier<AppState> 而不是 AppState。
 */
export async function tryGenerateSuggestion(
  abortController: AbortController,
  messages: Message[],
  getAppState: () => AppState,
  cacheSafeParams: CacheSafeParams,
  source?: 'cli' | 'sdk',
): Promise<{
  suggestion: string
  promptId: PromptVariant
  generationRequestId: string | null
} | null> {
  // ① 进门前先看有没有被取消
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, undefined, source)
    return null
  }

  // ② 对话轮数太少 → 信息不足，不猜。
  //    count(messages, 谓词) ≈ Java 的 messages.stream().filter(...).count()，
  //    只是这里传的是箭头函数（lambda）。
  const assistantTurnCount = count(messages, m => m.type === 'assistant')
  if (assistantTurnCount < 2) {
    logSuggestionSuppressed('early_conversation', undefined, undefined, source)
    return null
  }

  // ③ 上一轮是 API 错误 → 用户正在看报错，别打扰
  const lastAssistantMessage = getLastAssistantMessage(messages)
  if (lastAssistantMessage?.isApiErrorMessage) {
    logSuggestionSuppressed('last_response_error', undefined, undefined, source)
    return null
  }
  // ④ 父请求太大 → 缓存是冷的，生成建议会额外烧钱
  const cacheReason = getParentCacheSuppressReason(lastAssistantMessage)
  if (cacheReason) {
    logSuggestionSuppressed(cacheReason, undefined, undefined, source)
    return null
  }

  // ⑤ 瞬时时机检查（权限弹窗 / plan 模式 / 限流等）
  const appState = getAppState()
  const suppressReason = getSuggestionSuppressReason(appState)
  if (suppressReason) {
    logSuggestionSuppressed(suppressReason, undefined, undefined, source)
    return null
  }

  // ⑥ 真正发模型调用（这一步是最慢的，几百毫秒到数秒）
  const promptId = getPromptVariant()
  // 解构赋值：一次性从返回对象里取出两个字段
  // ≈ Java：`var r = generateSuggestion(...); var suggestion = r.getSuggestion(); ...`
  const { suggestion, generationRequestId } = await generateSuggestion(
    abortController,
    promptId,
    cacheSafeParams,
  )
  // ⑦ 调完必须**再查一次** abort：这段等待时间里用户可能已经开始打字了
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, undefined, source)
    return null
  }
  // 模型返回空 = 它自己也觉得"猜不出来"，这是正常情况（prompt 里要求它保持沉默）
  if (!suggestion) {
    logSuggestionSuppressed('empty', undefined, promptId, source)
    return null
  }
  // ⑧ 事后过滤：把不符合格式要求的输出挡掉（详见 shouldFilterSuggestion）
  if (shouldFilterSuggestion(suggestion, promptId, source)) return null

  return { suggestion, promptId, generationRequestId }
}

/**
 * CLI / TUI 路径的入口：一轮对话结束后，生成建议并写进界面状态。
 *
 * 为什么需要它（与 tryGenerateSuggestion 的分工）：
 * tryGenerateSuggestion 是"纯计算"（给入参、出结果），本函数则负责副作用——
 * 把结果写进 AppState 让 UI 显示出来，并且顺手启动 speculation 预执行。
 *
 * 关键步骤：
 *   ① 只看主线程（repl_main_thread），子 agent / 后台任务的回合不生成建议
 *   ② 新建一个 AbortController 并存到模块级变量，供 abortPromptSuggestion 取消
 *   ③ 从 context 里提取"缓存安全参数"（保证分叉请求能命中 prompt cache）
 *   ④ 调用 tryGenerateSuggestion 拿到建议
 *   ⑤ 写进 AppState.promptSuggestion（UI 从这里读，渲染成灰色提示文字）
 *   ⑥ 如果 speculation 功能开着，用这句建议去启动后台预执行
 *
 * 关于 ⑤ 里的 shownAt/acceptedAt 先填 0：
 *   这两个时间戳是留给 UI 层去填的（真正显示给用户看的时刻 / 用户采纳的时刻），
 *   这里只负责产出文本，不负责计时机。
 *
 * @param {REPLHookContext} context 一轮对话结束后的钩子上下文（含消息历史、工具上下文等）
 */
export async function executePromptSuggestion(
  context: REPLHookContext,
): Promise<void> {
  // ① 只有主线程才生成建议：后台子 agent 的回合不该污染用户的输入框
  if (context.querySource !== 'repl_main_thread') return

  // ② 建新令牌。注意同时存一份到模块级变量（给 abortPromptSuggestion 用）
  //    和一份局部变量（本函数自己用），后面 finally 里要比较两者是否还是同一个。
  currentAbortController = new AbortController()
  const abortController = currentAbortController
  // ③ 从主线程 context 里"抄"出一份不会影响 cache key 的参数
  const cacheSafeParams = createCacheSafeParams(context)

  try {
    const result = await tryGenerateSuggestion(
      abortController,
      context.messages,
      // 传的是**取状态的函数**而不是状态本身，保证读到的是最新快照
      context.toolUseContext.getAppState,
      cacheSafeParams,
      'cli',
    )
    if (!result) return

    // ⑤ 不可变更新：`{ ...prev, promptSuggestion: {...} }`
    //    先展开旧的 prev 把所有字段复制过来，再覆盖 promptSuggestion 这一个字段。
    //    ≈ Java 里 new 一个副本再 set，好处是旧快照不会被偷偷改掉（React 靠引用比较判断要不要重渲染）。
    //    setAppState(函数) 这种"传 updater 函数"的形式 ≈ Java 的 UnaryOperator<AppState>。
    context.toolUseContext.setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: result.suggestion,
        promptId: result.promptId,
        // 这两个时间戳由 UI 层填：真正显示出来时填 shownAt，用户采纳时填 acceptedAt
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: result.generationRequestId,
      },
    }))

    // ⑥ 启动 speculation：拿这句建议去后台偷偷把活干掉（详见 speculation.ts）
    //    `void` 前缀 = "我知道它返回 Promise，但我故意不 await"——发射后不管，
    //    ≈ Java 的 executor.submit(...) 但不 get()。
    //    因为 speculation 可能跑好几秒，绝不能阻塞当前这条建议的显示。
    if (isSpeculationEnabled() && result.suggestion) {
      void startSpeculation(
        result.suggestion,
        context,
        context.toolUseContext.setAppState,
        // isPipelined = false：这是第一轮 speculation，不是流水线上的后续轮
        false,
        cacheSafeParams,
      )
    }
  } catch (error) {
    // 用户主动取消是**预期内**的正常流程，不算错误，静默记个埋点就返回
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'APIUserAbortError')
    ) {
      logSuggestionSuppressed('aborted', undefined, undefined, 'cli')
      return
    }
    logError(toError(error))
  } finally {
    // 只有"模块级变量仍然是我自己"时才清空——
    // 否则可能把**新一轮**刚建好的控制器给误清掉了（竞态防护的经典写法）。
    if (currentAbortController === abortController) {
      currentAbortController = null
    }
  }
}

// 父请求未缓存 token 数的上限。超过这个值就放弃生成建议。
// 为什么是这个数：见下面 getParentCacheSuppressReason 的说明。
// 写法注意：`10_000` 里的下划线是**数字分隔符**，纯粹为了好读，等价于 10000。
//            ≈ Java 也支持同样的 10_000 写法（Java 7+）。
const MAX_PARENT_UNCACHED_TOKENS = 10_000

/**
 * 判断"父请求是不是太大了，大到生成建议会亏本"。
 *
 * 为什么需要它（这是本文件最"贵"的一个优化，务必理解）：
 * 建议生成是**搭便车**走主线程的 prompt cache 的。但 cache 只覆盖"前缀相同"的部分——
 * 主线程刚产出的那一大坨 assistant 回复，是**从未被缓存过的新内容**。
 * 分叉请求要把这坨新内容原样再发一遍，这部分要按**全价**计费。
 *
 * 所以：父请求这轮的"未缓存 token 数"越大，生成一次建议的边际成本越高。
 * 超过 10_000 token 时就直接放弃——为了一句十几个字的建议去付几万 token 的钱，不划算。
 *
 * 统计口径（代码里那句英文注释的含义）：
 *   input_tokens               主线程本次新写入的、尚未缓存的输入
 *   cache_creation_input_tokens 主线程本次**创建**的缓存（也是按全价/溢价收费的）
 *   output_tokens              主线程本次的输出（分叉请求要把它当作输入重新处理，必然未缓存）
 * 三者相加 ≈ 分叉请求需要全价支付的部分。
 *
 * @param lastAssistantMessage 主线程最后一条 assistant 消息（可能为 null）
 * @returns {string | null} null = 成本可接受；'cache_cold' = 缓存太冷，放弃
 */
export function getParentCacheSuppressReason(
  // ReturnType<typeof fn> 是 TS 的"从函数反推返回类型"工具类型，
  // ≈ Java 没有对应物（Java 得手写一个具体类型）。好处是函数签名改了这里自动跟着变。
  lastAssistantMessage: ReturnType<typeof getLastAssistantMessage>,
): string | null {
  if (!lastAssistantMessage) return null

  const usage = lastAssistantMessage.message.usage
  // `?? 0` 而不是 `|| 0`：usage 字段可能整个缺失（undefined），
  // 但绝不可能是 0 之外还要被替换的假值；用 ?? 更准确地表达"缺省补 0"。
  const inputTokens = usage.input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  // The fork re-processes the parent's output (never cached) plus its own prompt.
  // 中文：分叉请求要把父请求的输出重新处理一遍，这部分永远不可能命中缓存。
  const outputTokens = usage.output_tokens ?? 0

  return inputTokens + cacheWriteTokens + outputTokens >
    MAX_PARENT_UNCACHED_TOKENS
    ? 'cache_cold'
    : null
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ 下面这一大段是**给模型看的提示词**（不是给用户看的）。                    │
// │ 反引号 `...` 包起来的是 TS 的「模板字符串」，可以跨多行、保留换行符，      │
// │ ≈ Java 15+ 的文本块（""" ... """）。                                     │
// │                                                                          │
// │ 这份 prompt 的设计要点（对应下面 shouldFilterSuggestion 里的一堆正则）： │
// │   1. "predict what THEY would type - not what you think they should do"  │
// │      → 强调要模仿**用户的口吻**，不是 Claude 的口吻。                     │
// │   2. "THE TEST: Would they think 'I was just about to type that'?"       │
// │      → 给模型一个可操作的判据，比空泛地说"要准确"有效得多。              │
// │   3. "Stay silent if the next step isn't obvious"                        │
// │      → 允许模型返回空。**宁缺毋滥**是关键产品决策：                       │
// │        一条错误的建议比没有建议更伤害信任。                               │
// │   4. "2-12 words" + "NEVER SUGGEST 清单"                                 │
// │      → 硬约束，因为 UI 上只有一行的空间，长了会撑破布局。                 │
// └─────────────────────────────────────────────────────────────────────────┘
const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`

// promptId → prompt 文本的映射表。
// Record<PromptVariant, string> ≈ Java 的 EnumMap<PromptVariant, String>：
// 键必须是 PromptVariant 的取值之一，写错键名编译期就报错；且每个键都**必须**有值。
const SUGGESTION_PROMPTS: Record<PromptVariant, string> = {
  user_intent: SUGGESTION_PROMPT,
  stated_intent: SUGGESTION_PROMPT,
}

/**
 * 真正发起模型调用、拿到建议文本的地方。
 *
 * 为什么需要它：把"调模型"这一步单独隔离出来，因为它有两个非常 tricky 的约束，
 * 必须集中在一处写清楚，避免别人改动时不小心破坏：
 *
 * 约束一：**绝不能用 `tools: []` 来禁用工具**。
 *   直觉上"建议生成不需要工具"，传个空工具列表最省事。但工具列表是 cache key 的一部分，
 *   传空数组 → 与主线程请求的前缀不一致 → 缓存 0% 命中 → 每次全价。
 *   正确做法是**保留原来的工具列表**，改用 canUseTool 回调在客户端层逐个拒绝。
 *
 * 约束二：**绝不能覆盖任何 API 参数**（effort、maxOutputTokens…）。
 *   见下面那段长英文注释：PR #18143 只是给分叉请求加了 effort:'low'，
 *   就让缓存命中率从 92.7% 暴跌到 61%，cache 写入量涨了 45 倍。
 *   唯一能安全覆盖的只有纯客户端的四个东西。
 *
 * 关键步骤：
 *   ① 按 promptId 取 prompt 文本
 *   ② 构造 canUseTool 回调，一律 deny（建议生成不需要任何工具）
 *   ③ runForkedAgent 发起分叉请求
 *   ④ **遍历全部消息**找第一段非空文本，而不是只看第一条 assistant 消息
 *      —— 因为模型可能先尝试调工具、被拒后，在**下一条**消息里才给出真正的文本
 *   ⑤ 顺手从第一条 assistant 消息里取出 requestId，用于把埋点和 RL 数据集关联起来
 *
 * @param {AbortController} abortController 取消令牌
 * @param {PromptVariant} promptId 用哪个版本的 prompt
 * @param {CacheSafeParams} cacheSafeParams 从主线程继承的、保证缓存命中的参数
 * @returns 建议文本（模型选择沉默时为 null）+ 生成请求的 requestId（可能为 null）
 */
export async function generateSuggestion(
  abortController: AbortController,
  promptId: PromptVariant,
  cacheSafeParams: CacheSafeParams,
): Promise<{ suggestion: string | null; generationRequestId: string | null }> {
  const prompt = SUGGESTION_PROMPTS[promptId]

  // Deny tools via callback, NOT by passing tools:[] - that busts cache (0% hit)
  // 中文：靠回调拒绝工具，而不是传空工具列表 —— 后者会让缓存 0% 命中。
  // 注意这里用箭头函数直接返回一个对象字面量，所以要写成 `async () => ({ ... })`，
  // 小括号不能省（否则 `{` 会被解析成函数体的大括号）——新手最常踩的坑。
  const canUseTool = async () => ({
    behavior: 'deny' as const,
    message: 'No tools needed for suggestion',
    decisionReason: { type: 'other' as const, reason: 'suggestion only' },
  })

  // DO NOT override any API parameter that differs from the parent request.
  // The fork piggybacks on the main thread's prompt cache by sending identical
  // cache-key params. The billing cache key includes more than just
  // system/tools/model/messages/thinking — empirically, setting effortValue
  // or maxOutputTokens on the fork (even via output_config or getAppState)
  // busts cache. PR #18143 tried effort:'low' and caused a 45x spike in cache
  // writes (92.7% → 61% hit rate). The only safe overrides are:
  //   - abortController (not sent to API)
  //   - skipTranscript (client-side only)
  //   - skipCacheWrite (controls cache_control markers, not the cache key)
  //   - canUseTool (client-side permission check)
  // 【中文总结上面那段英文注释】
  // 这段约束踩过真实的坑，是本文件最值钱的经验：
  //   ✗ 不要设 effort:'low'（PR #18143 试过 → 命中率 92.7%→61%，cache 写入涨 45 倍）
  //   ✗ 不要设 maxOutputTokens（哪怕是走 output_config / getAppState 也不行）
  //   ✗ 不要改 tools / thinking / model / system / messages
  //   ✓ 只有这四个是安全的（因为它们不影响发给 API 的 cache key）
  // 一句话：**分叉请求要和主线程请求"长得一模一样"才能蹭到缓存**。
  const result = await runForkedAgent({
    // 把 prompt 伪装成"用户说的最后一句话"追加在历史后面，
    // 这样分叉请求的消息前缀与主线程完全一致 → 命中缓存。
    promptMessages: [createUserMessage({ content: prompt })],
    cacheSafeParams, // Don't override tools/thinking settings - busts cache
    canUseTool,
    querySource: 'prompt_suggestion',
    forkLabel: 'prompt_suggestion',
    overrides: {
      abortController,
    },
    // 不入会话记录：建议生成是内部动作，不该污染用户的 transcript
    skipTranscript: true,
    // 不写缓存：这是临时请求，没必要为它创建缓存（省一笔 cache 写入费）
    skipCacheWrite: true,
  })

  // Check ALL messages - model may loop (try tool → denied → text in next message)
  // Also extract the requestId from the first assistant message for RL dataset joins
  // 中文：必须遍历**所有**消息找文本，不能只看第一条。
  // 因为模型可能先尝试调工具 → 被 canUseTool 拒绝 → 在**下一条**消息里才吐出文本。
  // 只看第一条就会漏掉真正的答案，误判成"模型选择沉默"。
  // 同时从第一条 assistant 消息里取 requestId：这个 id 能把埋点记录和 RL（强化学习）
  // 训练数据集里的样本 JOIN 起来，用于后续评估 prompt 好坏。
  const firstAssistantMsg = result.messages.find(m => m.type === 'assistant')
  const generationRequestId =
    firstAssistantMsg?.type === 'assistant'
      ? (firstAssistantMsg.requestId ?? null)
      : null

  for (const msg of result.messages) {
    if (msg.type !== 'assistant') continue
    // content 是一个"块"数组（text / thinking / tool_use 等），这里只找文本块。
    // `.find(...)` ≈ Java 的 stream().filter(...).findFirst()
    const textBlock = msg.message.content.find(b => b.type === 'text')
    if (textBlock?.type === 'text') {
      // 去掉首尾空白：模型经常多吐一个换行或空格
      const suggestion = textBlock.text.trim()
      if (suggestion) {
        return { suggestion, generationRequestId }
      }
    }
  }

  return { suggestion: null, generationRequestId }
}

/**
 * 事后过滤器：判断模型给出的建议是否"够格"显示给用户。
 *
 * 为什么需要它（这是本文件最长的函数，但逻辑其实很朴素）：
 * **不能信任模型的输出格式**。即使 prompt 里写了十几条要求，模型仍会时不时：
 *   - 输出 "looks good!" 这种评价性废话（用户根本不会打这句话）
 *   - 输出 "Let me check..." 这种 Claude 口吻（不是用户会说的话）
 *   - 把"我选择沉默"这件事本身当成建议输出出来（"silence" / "(no suggestion)"）
 *   - 输出一整段话，UI 一行放不下
 * 与其反复调 prompt，不如在代码层做**确定性的正则兜底**——
 * 这是"LLM 应用工程"的典型做法：prompt 负责尽力而为，代码负责严守底线。
 *
 * 为什么规则写成 `Array<[string, () => boolean]>`（名字 + 判定函数）而不是一堆 if：
 *   这样每条规则自带一个**原因标签**，命中时能直接把这个标签打进埋点。
 *   线上就能统计"哪条规则拦得最多"，进而反过来优化 prompt，形成闭环。
 *
 * 关键步骤：
 *   ① 空值直接拦掉
 *   ② 归一化：转小写 + 数字数（后面多条规则都要用）
 *   ③ 依次跑 11 条规则，命中第一条就返回 true（被过滤）并记埋点
 *   ④ 全部通过则返回 false（保留这条建议）
 *
 * @param {string | null} suggestion 模型输出的建议文本
 * @param {PromptVariant} promptId 用的哪个 prompt 版本（埋点用）
 * @param {'cli' | 'sdk'} [source] 调用来源（埋点用）
 * @returns {boolean} true = 应该被过滤掉（不显示）；false = 合格
 */
export function shouldFilterSuggestion(
  suggestion: string | null,
  promptId: PromptVariant,
  source?: 'cli' | 'sdk',
): boolean {
  // ① 空值：模型选择了沉默，这是**正常**情况，不算错误
  if (!suggestion) {
    logSuggestionSuppressed('empty', undefined, promptId, source)
    return true
  }

  // ② 归一化。小写副本用于做不区分大小写的匹配；
  //    `split(/\s+/)` 按任意空白切分再取长度 = 数单词数（正则 \s+ 匹配一个或多个空白符）
  const lower = suggestion.toLowerCase()
  const wordCount = suggestion.trim().split(/\s+/).length

  // ③ 规则表。每一项是 [规则名, 判定函数]，命中即拦。
  //    类型 Array<[string, () => boolean]> 是"元组数组"，见文件头语法速查。
  const filters: Array<[string, () => boolean]> = [
    // "done" 单独一个词没信息量，用户不会只打这个
    ['done', () => lower === 'done'],
    [
      'meta_text',
      // 模型把 prompt 里的"保持沉默"指令**当成答案说出来了**。
      // 比如输出 "silence" / "nothing to suggest" / "I should stay silent"。
      // 这是 LLM 应用的经典毛病：它很诚实，但它该做的是**不输出**而不是解释自己为什么不输出。
      () =>
        lower === 'nothing found' ||
        lower === 'nothing found.' ||
        lower.startsWith('nothing to suggest') ||
        lower.startsWith('no suggestion') ||
        // Model spells out the prompt's "stay silent" instruction
        // 中文：模型把"保持沉默"这个指令本身写出来了，如 "silence is appropriate here"
        /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
        // Model outputs bare "silence" wrapped in punctuation/whitespace
        // 中文：模型只输出一个被标点包着的 "silence"，如 "*silence*" / "(silence)"
        // 正则含义：^ 开头、\W* 零个或多个非单词字符、silence、\W* 、$ 结尾
        /^\W*silence\W*$/.test(lower),
    ],
    [
      'meta_wrapped',
      // Model wraps meta-reasoning in parens/brackets: (silence — ...), [no suggestion]
      // 中文：模型把"元推理"（它自己在想什么）包在括号里输出了，如 "(no suggestion)"。
      // 用户绝不会打一句带括号的话，一律拦掉。
      () => /^\(.*\)$|^\[.*\]$/.test(suggestion),
    ],
    [
      'error_message',
      // 模型有时会把系统错误文案原样复读出来（"API Error: ..."），
      // 这种东西绝不能当成建议显示给用户。全部是枚举出来的已知错误前缀。
      () =>
        lower.startsWith('api error:') ||
        lower.startsWith('prompt is too long') ||
        lower.startsWith('request timed out') ||
        lower.startsWith('invalid api key') ||
        lower.startsWith('image was too large'),
    ],
    // 形如 "Suggestion: xxx" 的前缀标签 —— 用户不会这么打字
    ['prefixed_label', () => /^\w+:\s/.test(suggestion)],
    [
      'too_few_words',
      // 少于 2 个词一般是废话，但有例外（见下面的白名单）
      () => {
        if (wordCount >= 2) return false
        // Allow slash commands — these are valid user commands
        // 中文：斜杠命令（如 /compact、/model）是合法输入，哪怕是"一个词"也要放行
        if (suggestion.startsWith('/')) return false
        // Allow common single-word inputs that are valid user commands
        // 中文：下面是"单个词但确实合理"的白名单。
        // 全是用户真的会只打一个词的场景：肯定答复 / 单个动作动词 / 否定。
        // 用 Set 而不是数组：`has()` 是 O(1) 查找 ≈ Java 的 HashSet.contains()
        const ALLOWED_SINGLE_WORDS = new Set([
          // Affirmatives
          'yes',
          'yeah',
          'yep',
          'yea',
          'yup',
          'sure',
          'ok',
          'okay',
          // Actions
          'push',
          'commit',
          'deploy',
          'stop',
          'continue',
          'check',
          'exit',
          'quit',
          // Negation
          'no',
        ])
        // 不在白名单里的单词 → 拦掉（返回 true 表示"该过滤"）
        return !ALLOWED_SINGLE_WORDS.has(lower)
      },
    ],
    // 超过 12 个词：UI 只给了一行的空间，而且 prompt 里也明确要求 2-12 词
    ['too_many_words', () => wordCount > 12],
    // 超过 100 个字符：同上，防止撑破输入框布局
    ['too_long', () => suggestion.length >= 100],
    // 多个句子：正则含义 = "句号/问号/叹号 + 空白 + 大写字母"，即出现了第二句的开头
    ['multiple_sentences', () => /[.!?]\s+[A-Z]/.test(suggestion)],
    // 含有换行或星号：模型可能在输出 Markdown（列表、加粗），UI 显示不了
    ['has_formatting', () => /[\n*]|\*\*/.test(suggestion)],
    [
      'evaluative',
      // 评价性废话："谢谢"、"看起来不错"、"很好"。
      // 这些话是**对 Claude 说的**，不是用户会输入的**指令**，毫无执行价值。
      () =>
        /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(
          lower,
        ),
    ],
    [
      'claude_voice',
      // Claude 口吻："Let me..."、"I'll..."、"Here's..."、"You could..."
      // 这是最容易犯也最致命的错误：建议必须是**用户视角**的话。
      // 一旦显示成 "I'll run the tests"，用户按 Tab 就等于自己说了句莫名其妙的话。
      // 正则末尾的 `i` 是 flag（忽略大小写），`^` 表示必须从开头匹配。
      () =>
        /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(
          suggestion,
        ),
    ],
  ]

  // 依次执行规则，命中第一条就记埋点 + 返回 true（过滤掉）
  for (const [reason, check] of filters) {
    if (check()) {
      logSuggestionSuppressed(reason, suggestion, promptId, source)
      return true
    }
  }

  return false
}

/**
 * Log acceptance/ignoring of a prompt suggestion. Used by the SDK push path
 * to track outcomes when the next user message arrives.
 */
/**
 * 【中文】记录一条建议的"最终结果"：用户是采纳了，还是无视了。
 *
 * 为什么需要它：这整个功能好不好，唯一的评判标准就是**采纳率**。
 * 没有这个埋点，就无从判断 prompt 改得是更好还是更差。
 *
 * 判定"采纳"的方式（注意这里很讲究）：
 *   - accepted：用户输入与建议文本**完全相同**（一字不差）
 *   - 其余情况都算 ignored，但会额外算一个 similarity（相似度）指标
 *
 * similarity 只是**长度比**（用户输入长度 ÷ 建议长度），不是真正的编辑距离。
 * 为什么这么糙？因为埋点要控制成本，长度比已经足够粗略区分
 * "用户完全另起炉灶"和"用户在建议基础上改了改"两种情况。
 *
 * @param {string} suggestion 我们给出的建议文本
 * @param {string} userInput 用户实际输入的内容
 * @param {number} emittedAt 建议展示出去的时间戳（用于算响应耗时）
 * @param {PromptVariant} promptId 用的哪个 prompt 版本
 * @param {string | null} generationRequestId 生成那次调用的 requestId，用于关联 RL 数据集
 */
export function logSuggestionOutcome(
  suggestion: string,
  userInput: string,
  emittedAt: number,
  promptId: PromptVariant,
  generationRequestId: string | null,
): void {
  // `suggestion.length || 1` 是防除零的小技巧：
  // 用 `||` 而不是 `??` —— 这里**故意**要把 0 当成"需要兜底"的假值，
  // 因为长度为 0 时会得到 NaN 或 Infinity。这是 `||` 与 `??` 区别的典型例子。
  const similarity =
    Math.round((userInput.length / (suggestion.length || 1)) * 100) / 100
  // 严格相等才算采纳。用 === 而不是 ==（== 会做隐式类型转换，JS 的著名陷阱）
  const wasAccepted = userInput === suggestion
  // Math.max(0, ...) 兜底：万一时钟回拨导致负数，也不要往埋点里写负值
  const timeMs = Math.max(0, Date.now() - emittedAt)

  logEvent('tengu_prompt_suggestion', {
    source: 'sdk' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    outcome: (wasAccepted
      ? 'accepted'
      : 'ignored') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_id:
      promptId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // ── 下面几个 `...(条件 && { 字段 })` 是"条件性加字段"的惯用写法 ──
    // 原理：展开运算符 `...` 作用于 false / null / undefined 时会展开成**零个属性**，
    // 于是这个字段就等于不存在（而不是存在但为 null）。
    // 好处：埋点数据结构干净，没有一堆 null 字段，下游分析时不用层层判空。
    ...(generationRequestId && {
      generationRequestId:
        generationRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(wasAccepted && {
      timeToAcceptMs: timeMs,
    }),
    ...(!wasAccepted && { timeToIgnoreMs: timeMs }),
    similarity,
    // 建议原文和用户原文属于**潜在的隐私/代码内容**，
    // 只对内部员工（USER_TYPE=ant）上报，外部用户一律不采集。
    ...(process.env.USER_TYPE === 'ant' && {
      suggestion:
        suggestion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      userInput:
        userInput as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
  })
}

/**
 * 记录"这次为什么没有给出建议"（拦截埋点）。
 *
 * 为什么需要它：这是整个功能的**诊断仪表盘**。
 * 所有放弃生成的地方（功能没开、对话太短、被过滤器拦了、用户取消了…）
 * 都会调用它并带上一个 reason 字符串，线上就能直接看到：
 *      "今天有 40% 的请求被 claude_voice 拦了" → 说明 prompt 的口吻约束没生效，该改 prompt
 *      "early_conversation 占了大头"           → 说明门槛设太高了
 *
 * 如果没有这些 reason，就只能看到"建议变少了"，但完全不知道为什么变少。
 *
 * @param {string} reason 拦截原因（如 'disabled' / 'empty' / 'claude_voice'）
 * @param {string} [suggestion] 被拦掉的建议文本（仅内部员工上报）
 * @param {PromptVariant} [promptId] prompt 版本；不传则自动取当前版本
 * @param {'cli' | 'sdk'} [source] 调用来源；不传则该字段不出现在埋点里
 */
export function logSuggestionSuppressed(
  reason: string,
  suggestion?: string,
  promptId?: PromptVariant,
  source?: 'cli' | 'sdk',
): void {
  // `??` 空值合并：promptId 没传时才回退到当前版本。
  // 这里**不能**用 `||`：虽然结果碰巧一样，但 ?? 的语义才准确
  // （只对 null/undefined 兜底，不会误伤空字符串之类的假值）。
  const resolvedPromptId = promptId ?? getPromptVariant()
  logEvent('tengu_prompt_suggestion', {
    ...(source && {
      source:
        source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    outcome:
      'suppressed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason:
      reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_id:
      resolvedPromptId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 同样只对内部员工上报原文
    ...(process.env.USER_TYPE === 'ant' &&
      suggestion && {
        suggestion:
          suggestion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
  })
}
