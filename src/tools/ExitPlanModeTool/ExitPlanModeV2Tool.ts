/**
 * ============================================================================
 *  【文件总览】src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts
 * ============================================================================
 *
 *  一句话定位：
 *  「退出 plan mode（计划模式）」工具的实现主体。模型在 plan mode 里调研完、
 *  把方案写进计划文件之后，调用它来把方案**提交给用户审批**。
 *  用户点同意 → 退出只读模式 → 恢复成普通模式 → 模型可以开始改代码了。
 *
 *  ---------------------------------------------------------------------------
 *  【plan mode 的"出口"：这一半才是真正的关键闸门】
 *  ---------------------------------------------------------------------------
 *  兄弟文件 EnterPlanModeTool 只是把开关拨到 'plan'（进只读模式）；
 *  真正体现 plan mode 价值的，是本文件这**一道人工审批闸门**：
 *
 *      ① 模型在 plan mode 里调研（只读，改不了任何文件）
 *      ② 模型把方案写进计划文件 ~/.claude/plans/xxx.md
 *          —— 这是它在 plan mode 里唯一被允许写的文件
 *      ③ 模型调用 ExitPlanMode
 *      ④ ★ checkPermissions() 返回 behavior: 'ask'  → 终端弹出确认框
 *      ⑤ 用户在弹窗里审阅方案全文（新版还可以直接**编辑**方案内容）
 *      ⑥ 用户点同意 → call() 执行 → 把 mode 从 'plan' 恢复成原来的模式
 *      ⑦ mapToolResult...() 把"已批准的方案"原文回灌给模型，模型开工
 *
 *  所以「Enter 只是拨开关，Exit 才是闸门」。
 *  这也是为什么 ExitPlanModeTool 比 EnterPlanModeTool 长了整整 4 倍：
 *  进门只要改一个字段，出门要考虑的东西太多了——
 *  原模式是什么、危险权限要不要还回去、用户有没有改方案、
 *  是不是子 Agent（要不要改成发给团队负责人审批）、
 *  自动模式开关是不是被熔断了……
 *
 *  ---------------------------------------------------------------------------
 *  【和 EnterPlanModeTool 的状态契约：prePlanMode 字段】
 *  ---------------------------------------------------------------------------
 *  进 plan mode 时，旧模式被存进 toolPermissionContext.prePlanMode；
 *  退出时，从这里把旧模式读回来：
 *
 *      Enter:  prePlanMode = 当前模式（比如 'default' / 'acceptEdits' / 'auto'）
 *              mode        = 'plan'
 *              + 剥掉一批危险权限
 *
 *      Exit :  mode        = prePlanMode（读回来）
 *              prePlanMode = undefined（清空，避免下次误用）
 *              + 把危险权限还回去（除非要恢复的是 auto 模式）
 *
 *  这个"存了再读"的往返过程，是理解本文件所有分支的钥匙。
 *
 *  ---------------------------------------------------------------------------
 *  【在架构中的位置】调用链
 *  ---------------------------------------------------------------------------
 *      模型输出 tool_use: { name: 'ExitPlanMode', input: { allowedPrompts } }
 *        └─> 工具调度层
 *              ├─> validateInput()     ← 本文件：不在 plan mode 就直接拒绝
 *              ├─> checkPermissions()  ← 本文件：'ask'（弹窗）或 'allow'（子Agent直通）
 *              │        └─> 用户点同意（或被 PermissionRequest hook 自动批准）
 *              ├─> call()              ← ★ 本文件核心：恢复模式 + 落盘方案
 *              │        ├─> writeFile()                计划文件同步用户编辑
 *              │        ├─> writeToMailbox()           子Agent：发给 team-lead
 *              │        └─> context.setAppState()      恢复 mode / 权限
 *              └─> mapToolResultToToolResultBlockParam()  ← 本文件：把方案回灌给模型
 *
 *  ---------------------------------------------------------------------------
 *  【本文件包含什么】
 *  ---------------------------------------------------------------------------
 *   1. autoModeStateModule / permissionSetupModule   条件 require 的两个模块
 *   2. allowedPromptSchema + inputSchema + _sdkInputSchema + outputSchema
 *   3. ExitPlanModeV2Tool（工具本体）
 *      ├─ isEnabled()             渠道模式下禁用（和 Enter 成对）
 *      ├─ isReadOnly()            false —— 它会写计划文件
 *      ├─ requiresUserInteraction()  子Agent 为 false，普通会话为 true
 *      ├─ validateInput()         不在 plan mode 就挡回去（避免白弹窗）
 *      ├─ checkPermissions()      'ask' 弹窗 / 'allow' 直通
 *      ├─ call()                 ★核心：三条分支（子Agent / 熔断兜底 / 正常恢复）
 *      └─ mapToolResultToToolResultBlockParam()  ★核心：把批准后的方案回灌给模型
 *
 *  ---------------------------------------------------------------------------
 *  【TS 语法速查】Java 工程师视角
 *  ---------------------------------------------------------------------------
 *  - `feature('XXX')`  ★**编译期**常量，不是运行时 if！来自 `bun:bundle`。
 *    打包时被替换成 true/false，再 tree-shaking 把整段从产物里删掉。
 *    ≈ Java 没有；近似 C 的 `#ifdef XXX`。
 *    副作用：只能用在 if/三元的条件位置，不能赋给变量再判断。
 *
 *  - `require('...') as typeof import('...')`  ★本文件第 52~57 行
 *    `require()` 是 CommonJS 的同步加载（≈ Java 的 Class.forName），
 *    `typeof import('...')` 是"取那个模块的类型"（纯类型，编译后消失）。
 *    `as` 是类型断言 ≈ Java 的强制转换。
 *    为什么要用 require 而不是文件顶部的 import？
 *    因为 **import 是静态的**，打包器一定会把它打进产物；
 *    而 require 写在 if (feature(...)) 里，feature 为 false 时整段被 DCE 删掉，
 *    那个模块就完全不会进包。这是"按构建变体裁剪依赖"的标准手法。
 *
 *  - `z` = zod 库。≈ Java 的 Bean Validation + JSON Schema，
 *    但额外能力是**从 schema 推导 TS 类型**（见 z.infer）。
 *
 *  - `.strictObject()` 严格模式：多传字段就报错。
 *    `.passthrough()` 允许透传未声明字段。
 *    ⚠️ 本文件第 79~88 行两者**同时出现**：先 strictObject 再 .passthrough()，
 *       最终效果等价于"允许额外字段"。看起来矛盾，其实是历史演进留下的
 *       写法（曾经严格，后来为了兼容某些调用方改成透传），别以为是写错了。
 *
 *  - `.optional()` 字段可选，等价于 `T | undefined`。
 *    `.nullable()` 字段可以为 null。两者在 TS 里是两回事：
 *    undefined = "没写这个字段"，null = "显式给了个空值"。
 *    Java 只有 null 一种，这是需要适应的地方。
 *
 *  - `.describe('...')` 给字段写说明，这段说明会**原样进发给模型的 JSON Schema**，
 *    所以它是"写给模型看的文档"，措辞很关键。
 *
 *  - `export type Output = z.infer<OutputSchema>` 从 schema 自动推导 TS 类型。
 *    ≈ Java 手写 record，但自动生成，schema 改了类型自动跟着改。
 *
 *  - `'plan' in input`  `in` 运算符判断对象里有没有这个键。
 *    ≈ Java 的 `map.containsKey("plan")`。
 *    本文件第 252 行用它做**类型收窄**（见下条）。
 *
 *  - 类型收窄（narrowing）★TS 的招牌特性，Java 没有等价物：
 *        if ('plan' in input && typeof input.plan === 'string') { ... }
 *    进到 if 里面之后，编译器就"知道" input.plan 是 string 了，
 *    不需要强转。≈ Java 16+ 的 `if (o instanceof Foo f) { ... }`
 *    （模式匹配会自动绑定变量），但 TS 的收窄能用在更多场景。
 *
 *  - `??` 空值合并：只有左侧是 null/undefined 时才取右侧。
 *    ⚠️ 和 Java 的 `||` 不同：`0` 和 `''` 不会被 `??` 替换掉。
 *       本文件里 `inputPlan ?? getPlan(...)` 就是"传入优先，没传就读磁盘"。
 *
 *  - `?.` 可选链：`a?.b` ≈ `a != null ? a.b : null`。
 *    `context.addNotification?.(...)` 这种 `?.()` 写法是"方法可能存在，
 *    存在才调用"——比 Java 的 `if (x != null) x.f()` 简洁。
 *
 *  - `b ?? false` / `m?.isAutoModeActive() ?? false` 
 *    本文件大量这种写法，含义是"模块可能没加载（undefined），
 *    那就当成 false"。因为那两个模块是 feature() 条件加载的。
 *
 *  - `{ ...prev, toolPermissionContext: {...baseContext, mode: x} }`
 *    对象展开 = 浅拷贝 + 覆盖。≈ Java 没有，想象成 new 一个副本再改字段。
 *    这是本仓库的**核心手法——不可变更新**：不改原对象，造新的。
 *    好处：别处持有的旧快照不会被偷偷改掉；React 能靠引用变化判断要不要重渲染。
 *
 *  - `context.setAppState(prev => { ... })`
 *    传的是**更新函数**而不是新值。≈ Java 的 `map.compute(k, (k,v) -> newV)`。
 *    这么设计是为了避免"我读到的 prev 已经过期"的并发问题。
 *    ⚠️ 注意这个回调是**同步**的，里面不能 await。
 *
 *  - `as const`  第 228/235 行的 `behavior: 'allow' as const`：
 *    把 'allow' 的类型从宽泛的 string 收窄成字面量类型 'allow'，
 *    这样才能匹配联合类型 `'allow' | 'ask' | 'deny'`。
 *    ≈ Java 里 enum 常量和普通 String 的区别。
 *
 *  - `Promise<ChangeSummary | null>` 联合类型作泛型参数。
 *    `A | B` 联合类型 ≈ Java 的 sealed interface 的两个实现，但轻量得多。
 *
 *  - `void someAsyncFn()`  = "我知道它返回 Promise，但我故意不等"。
 *    「发射后不管」≈ Java 的 executor.submit(...) 但不 get()。
 *
 *  - `await writeFile(...).catch(e => logError(e))`
 *    给 Promise 挂 catch ≈ Java 的 try-catch，链式写法。
 *
 *  - `const { a, b } = obj` 解构赋值 ≈ Java 21+ 的记录模式匹配，日常随处可见。
 *    第 419~429 行在函数**参数位置**解构，更是密集使用。
 *
 *  - `_input`、`_theme` 下划线前缀 = "这参数我不用"，
 *    TS 的 noUnusedParameters 会放过下划线开头的参数。
 *
 *  - `let x: string | null = null`  声明后可重新赋值（const 不行）。
 *    ≈ Java 的非 final 局部变量。
 */
import { feature } from 'bun:bundle'
import { writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import {
  buildTool,
  type Tool,
  type ToolDef,
  toolMatchesName,
} from '../../Tool.js'
import { formatAgentId, generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  setAwaitingPlanApproval,
} from '../../utils/inProcessTeammateHelpers.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from '../../utils/plans.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentName,
  getTeamName,
  isPlanModeRequired,
  isTeammate,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from './constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * ★ 两个「按需加载」的模块。这是本文件最需要解释的一段。
 *
 * 为什么不写在文件顶部用 import？
 *   因为 **import 是静态的**——打包器看到 import 就一定会把那个模块打进产物，
 *   无论你后面用不用。而这两个模块只在 TRANSCRIPT_CLASSIFIER 这个构建变体下才需要。
 *   改用 require() + 三元表达式，feature('TRANSCRIPT_CLASSIFIER') 为 false 时
 *   整个三元表达式会被常量折叠成 `null`，那两个模块就完全不会进包（DCE）。
 *   ≈ Java 里用 Class.forName("...") 反射加载，而不是 import 具体类，
 *     目的同样是"让这个依赖变成可选的"。
 *
 * 为什么外面要包 eslint-disable？
 *   因为项目规范默认禁止 require（统一用 ESM 的 import），
 *   这里是**有意破例**，所以局部关掉规则并加注释说明。
 *   注意 `eslint-enable` 在下面几行把规则恢复回去——
 *   只在这一小段里豁免，不污染整个文件。
 *
 * 为什么这两个模块后面用的时候要写 `?.` 和 `?? false`？
 *   因为在此构建变体下它们的值是 **null**，直接 `.isAutoModeActive()` 会空指针。
 *   所以本文件后面全都是 `autoModeStateModule?.isAutoModeActive() ?? false`
 *   这种"模块可能不存在，不存在就当 false"的防御写法。
 *
 * 两个模块分别管什么：
 *   · autoModeStateModule    —— 自动模式（auto mode）的**运行时状态**：
 *                               "当前是不是开着自动批准"。
 *   · permissionSetupModule  —— 权限装配逻辑：
 *                               判断自动模式的开关有没有被熔断、
 *                               剥掉/恢复危险权限等。
 */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null
const permissionSetupModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/permissionSetup.js') as typeof import('../../utils/permissions/permissionSetup.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Schema for prompt-based permission requests.
 * Used by Claude to request semantic permissions when exiting plan mode.
 *
 * 【中文补注】上面英文说的是：这是"基于描述的权限申请"的结构定义，
 * 模型在退出 plan mode 时可以顺带申请一批语义化的权限。
 *
 * 什么叫做「基于描述的权限」（prompt-based permission）？这是本工具最有意思的设计：
 *   传统权限是**匹配命令字符串**：允许 `npm test`，允许 `git status`……
 *     问题：同一个意图有无数种写法（npm test / pnpm test / yarn test），穷举不完。
 *   这里的做法是**描述意图**：模型说"我需要能跑测试"，
 *     权限系统之后遇到任何"看起来是在跑测试"的命令就自动放行。
 *
 * 为什么这件事要放在"退出 plan mode"这个时机做？
 *   因为方案刚被批准，用户脑子里正好装着"接下来要干这些事"的上下文。
 *   此时顺着方案的语境批量授权（"跑测试"、"装依赖"），
 *   用户的判断成本最低。等实现到一半再一条条弹窗问，体验就差了。
 *   这是产品层面的巧思：把授权动作**批量前置**到用户注意力最集中的那一刻。
 *
 * 字段：
 *   tool   目前只支持 'Bash'（z.enum(['Bash']) ≈ Java 的 enum，只允许这几个值）
 *   prompt 语义化描述，例如 "run tests"
 */
const allowedPromptSchema = lazySchema(() =>
  z.object({
    tool: z.enum(['Bash']).describe('The tool this prompt applies to'),
    prompt: z
      .string()
      .describe(
        'Semantic description of the action, e.g. "run tests", "install dependencies"',
      ),
  }),
)

/**
 * 由上面的 schema 推导出的 TS 类型（≈ { tool: 'Bash'; prompt: string }）。
 *
 * 注意这里的写法 `z.infer<ReturnType<typeof allowedPromptSchema>>`：
 *   从内往外读 ——
 *     typeof allowedPromptSchema       取这个**函数值**的类型
 *     ReturnType<...>                  取它的返回值类型（即那个 zod schema）
 *     z.infer<...>                     从 schema 推导出数据结构类型
 *   ≈ Java 里没有对应物（Java 没有"取方法返回类型"这种类型运算）。
 *   这么绕是为了不手写第二遍类型定义。
 */
export type AllowedPrompt = z.infer<ReturnType<typeof allowedPromptSchema>>

/**
 * 本工具的入参 schema。
 *
 * ⚠️ 注意一个反直觉的点：**plan（方案正文）并不在入参里**！
 *   方案内容是从磁盘上的计划文件读出来的（见 call() 里的 getPlan()）。
 *   为什么不直接让模型把方案当参数传过来？三个原因：
 *     ① 方案可能很长（几千字），塞在 tool_use 的参数里会挤占上下文，
 *        而且同一份内容要在"模型输出"和"工具结果"里各占一份；
 *     ② 用户需要能**编辑**方案——存在文件里，用户在 UI 里改完，
 *        工具读到的就是改后的版本；
 *     ③ 存成文件后，VerifyPlanExecution / Read 等其它工具都能看到同一份内容。
 *   所以本工具的入参只有"顺带申请的那些权限"。
 *
 * 另一个反直觉的点：`.strictObject({...}).passthrough()` 连用。
 *   strictObject 说"多传字段就报错"，passthrough 说"没声明的字段原样放行"。
 *   两个连起来，最终效果其实**等价于** passthrough（宽松）。
 *   这不是写错了，是历史演进：早期严格要求，后来为了兼容某些调用方
 *   （比如会塞 plan / planFilePath 进来的路径）改成了透传。
 *   之所以没删掉 strictObject，是因为直接删会改动更多代码。
 */
const inputSchema = lazySchema(() =>
  z
    .strictObject({
      // Prompt-based permissions requested by the plan
      // 【中文补注】方案需要哪些"基于描述的权限"，可选。
      allowedPrompts: z
        // z.array(...) = 数组类型，≈ Java 的 List<AllowedPrompt>
        .array(allowedPromptSchema())
        // .optional() = 这个字段可以不传，类型自动变成 `... | undefined`
        .optional()
        // .describe() 的说明会原样进发给模型的 JSON Schema，是给模型看的文档
        .describe(
          'Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.',
        ),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * SDK-facing input schema - includes fields injected by normalizeToolInput.
 * The internal inputSchema doesn't have these fields because plan is read from disk,
 * but the SDK/hooks see the normalized version with plan and file path included.
 *
 * 【中文补注】这里存在**两套入参 schema**，是理解本文件的关键之一：
 *
 *   · inputSchema（上面那个，内部用）
 *       只有 allowedPrompts。因为方案是 call() 自己从磁盘读的，不需要传。
 *
 *   · _sdkInputSchema（本文件这个，对外的"门面"）
 *       额外多出 plan 和 planFilePath 两个字段，
 *       它们不是模型传的，而是框架里的 normalizeToolInput() **塞进去**的。
 *
 *   为什么要搞两套？
 *     · 对**模型**：只暴露 allowedPrompts，简单、省 token。
 *     · 对 **SDK 用户 / hook**：他们拿不到磁盘上的文件，但很想看到
 *       "这次批准的方案到底是什么"，所以要把 plan 展开给他们看。
 *   这就像 Java 里「内部 DTO」和「对外 API 响应对象」的区别——
 *   同一份数据，两种视图，各取所需。
 *
 *   语法点：`inputSchema().extend({...})`
 *   zod 的 extend ≈ Java 的"继承并加字段"：基于已有 schema 派生一个新的，
 *   原 schema 的所有字段都保留，再追加这里声明的字段。
 */
export const _sdkInputSchema = lazySchema(() =>
  inputSchema().extend({
    plan: z
      .string()
      .optional()
      .describe('The plan content (injected by normalizeToolInput from disk)'),
    planFilePath: z
      .string()
      .optional()
      .describe('The plan file path (injected by normalizeToolInput)'),
  }),
)

/**
 * 出参 schema：描述了"这次退出 plan mode 的结果"长什么样。
 *
 * 字段虽多，但可以按三条执行路径来理解，一次只会走其中一条：
 *   ① 子 Agent → 走 awaitingLeaderApproval: true（方案发给 team-lead 等批示）
 *   ② 普通会话 → 走 plan + filePath + planWasEdited（用户已批准）
 *   ③ 空方案   → plan 为 null 或空串（用户批准了，但模型压根没写方案）
 *
 * ⚠️ TS 语法重点：`.optional()` 和 `.nullable()` 是**两回事**，
 *    Java 只有 null 一种，初次接触容易混：
 *      .optional()  → 字段可以**不写**（值可能是 undefined）
 *      .nullable()  → 字段**写了**，但值可以是 null
 *    本文件里 plan 用的是 .nullable()——它一定存在，只是可能是 null
 *    （模型没写方案文件的情况）。
 */
export const outputSchema = lazySchema(() =>
  z.object({
    // 提交给用户审批的方案正文。可能为 null（模型压根没往计划文件里写东西）
    plan: z
      .string()
      .nullable()
      .describe('The plan that was presented to the user'),
    // 这次调用是不是由「子 Agent」发起的（子 Agent 走的是完全不同的分支，见 call()）
    isAgent: z.boolean(),
    // 计划文件在磁盘上的路径，回灌给模型后可以 Read 回来对照执行
    filePath: z
      .string()
      .optional()
      .describe('The file path where the plan was saved'),
    // 当前上下文里有没有 Agent 工具。有才会在结果里建议"要不要开个团队并行干"
    hasTaskTool: z
      .boolean()
      .optional()
      .describe('Whether the Agent tool is available in the current context'),
    // 用户有没有**编辑过**方案（网页 UI 或 Ctrl+G 都能编辑）。
    // 这个标记很重要：编辑过就必须在结果里把方案**原文回灌**给模型，
    // 否则模型执行的还是它自己写的那一版，用户改的内容就丢了。
    planWasEdited: z
      .boolean()
      .optional()
      .describe(
        'True when the user edited the plan (CCR web UI or Ctrl+G); determines whether the plan is echoed back in tool_result',
      ),
    // 子 Agent 专用：方案已发给团队负责人，正在等批示
    awaitingLeaderApproval: z
      .boolean()
      .optional()
      .describe(
        'When true, the teammate has sent a plan approval request to the team leader',
      ),
    // 这次审批请求的唯一 ID。子 Agent 之后靠它对上负责人的"同意/驳回"回复
    requestId: z
      .string()
      .optional()
      .describe('Unique identifier for the plan approval request'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

/**
 * 对外导出的出参类型，由 schema 自动推导。
 * UI.tsx 会 import 它来决定怎么渲染，所以它是逻辑层和渲染层之间的契约。
 */
export type Output = z.infer<OutputSchema>

/**
 * ★ 工具本体。和 EnterPlanModeTool 一样，是个用 buildTool() 装配的**配置对象**，
 * 不是 class。≈ Java 里你会写 `class ExitPlanMode extends AbstractTool`，
 * 而这边是把一堆钩子函数塞进普通对象里交给工厂装配。
 *
 * 文件名里的 "V2" 是什么意思？
 *   表示这是第二版实现。第一版（ExitPlanModeTool）让模型把方案**当参数传进来**，
 *   V2 改成了"从磁盘的计划文件读"。好处见上面 inputSchema 的注释
 *   （省上下文、用户可编辑、其它工具能共享）。
 *   ⚠️ 注意 constants.ts 里两个版本的工具名**都叫 'ExitPlanMode'**——
 *      对外名字没变，变的是内部实现。这样模型侧的提示词不用跟着改。
 */
export const ExitPlanModeV2Tool: Tool<InputSchema, Output> = buildTool({
  // 工具的唯一标识，模型靠这个名字找到本工具
  name: EXIT_PLAN_MODE_V2_TOOL_NAME,
  // 给工具检索用的简介。末尾的 "(plan mode only)" 很重要——
  // 它提醒模型"这工具只在 plan mode 里有用"，减少误调用
  searchHint: 'present plan for approval and start coding (plan mode only)',
  // 结果最多 10 万字符。方案可能很长，但超过就得截断，
  // 否则一个超长方案能把整个上下文撑爆
  maxResultSizeChars: 100_000,
  async description() {
    return 'Prompts the user to exit plan mode and start coding'
  },
  async prompt() {
    return EXIT_PLAN_MODE_V2_TOOL_PROMPT
  },
  // 两个 getter：调用方写 `tool.inputSchema` 就能拿到（不用加括号），
  // 但每次访问都会重新执行函数体，靠 lazySchema 内部缓存兜底。
  // ≈ Java 的 getInputSchema()，只是调用时不写括号。
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 返回空串 = "不需要单独一行标题"，结果直接融进对话流
  userFacingName() {
    return ''
  },
  // 延迟加载（详见 EnterPlanModeTool.ts 同名注释）：
  // 只在系统提示词里放名字+一句话，模型真要用时再拉完整定义。省上下文。
  shouldDefer: true,
  /**
   * 这个工具在当前环境可不可用（不可用的话模型根本看不到它）。
   *
   * 必须和 EnterPlanModeTool.isEnabled() **成对开关**：
   * 如果只禁 Exit 不禁 Enter，模型进了 plan mode 就出不来了；
   * 如果只禁 Enter 不禁 Exit，Exit 会永远因为"不在 plan mode"被 validateInput 拒绝。
   */
  isEnabled() {
    // When --channels is active the user is likely on Telegram/Discord, not
    // watching the TUI. The plan-approval dialog would hang. Paired with the
    // same gate on EnterPlanMode so plan mode isn't a trap.
    // 【中文补注】渠道模式（接了 Telegram/Discord）下用户在聊天窗口里，
    // 根本没人去点终端里的批准弹窗，流程会永久挂住。所以这里禁用，
    // 并且和 EnterPlanMode 保持成对——避免"进得去出不来"的死局。
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  /**
   * true = 可以和别的工具并发跑。
   * 本工具只是读取状态、改内存里的模式，确实没有需要排队的副作用。
   */
  isConcurrencySafe() {
    return true
  },
  /**
   * ⚠️ 这里返回 **false**，和 EnterPlanModeTool 的 true 正好相反！
   * 为什么？因为本工具会把用户编辑后的方案**写回磁盘**（见 call() 里的 writeFile）。
   * isReadOnly 的语义是"这个工具会不会动文件系统"，
   * 而"退出只读模式"这个结果本身不算写文件——真正写文件的是同步用户编辑那一步。
   * 所以注释里那句 "// Now writes to disk" 是在解释这个反直觉的 false。
   */
  isReadOnly() {
    return false // Now writes to disk
  },
  /**
   * 这个工具需不需要**本地用户**参与交互（弹窗）。
   *
   * 这里是本文件第一个"子 Agent 分流点"，理解多 Agent 机制的关键：
   *
   *   · 普通会话（非 teammate）→ true
   *       必须由真人用户在终端里点"同意"。
   *
   *   · 子 Agent（teammate）→ false
   *       子 Agent 跑在后台，没有自己的终端，弹不了窗也没人看。
   *       它要走另一条路（见下面 checkPermissions 和 call）：
   *         - 如果这个子 Agent 是"强制 plan mode"类型的 →
   *           把方案投递到 team-lead 的邮箱（mailbox）等负责人审批
   *         - 否则是"自愿 plan mode"→ 直接本地退出，不需要任何人批准
   *
   * isTeammate() 是一个全局判定（../../utils/teammate.js）：
   * 通过环境变量判断"我是不是一个被派生出来的子 Agent"。
   */
  requiresUserInteraction() {
    // For ALL teammates, no local user interaction needed:
    // - If isPlanModeRequired(): team lead approves via mailbox
    // - Otherwise: exits locally without approval (voluntary plan mode)
    // 【中文补注】见上面 JSDoc：子 Agent 一律不需要本地交互。
    if (isTeammate()) {
      return false
    }
    // For non-teammates, require user confirmation to exit plan mode
    return true
  },
  /**
   * 入参/前置条件校验。在**弹窗之前**执行的一道工序。
   *
   * 做什么：挡掉"根本不在 plan mode 却调 ExitPlanMode"的情况。
   *
   * 为什么这道检查必须放在 validateInput 而不是 call 里？
   *   因为 checkPermissions() 会**弹窗**。如果等到弹窗之后才发现"你压根不在
   *   plan mode"，用户就会看到一个莫名其妙的"退出 plan mode？"对话框，
   *   点了同意之后才被告知"其实你不在 plan mode"——体验极差。
   *   所以必须在弹窗之前就拦下来（代码注释里那句
   *   "Reject before checkPermissions to avoid showing the approval dialog"）。
   *
   * 为什么"不在 plan mode 还会被调用"这么常见，值得专门防？
   *   因为本工具是 shouldDefer（延迟加载）的：
   *   延迟工具清单是**不管当前什么模式**都全量发给模型的。
   *   模型看到清单里有 ExitPlanMode，就可能在方案已经被批准之后
   *   （它自己以为还在 plan mode）再调一次。
   *   另外上下文压缩（compact）/清空（clear）之后会重新注入工具清单，
   *   也会让模型产生"我还在 plan mode"的错觉。
   *
   * 入参：
   *   _input      本工具没有有意义的入参，用不到
   *   { getAppState, options }
   *               ★注意这里是**参数解构**：第二个参数是个大 context 对象，
   *                 只抽出其中两个字段用。≈ Java 21+ 的记录模式匹配。
   * 返回值：
   *   { result: true }                        通过
   *   { result: false, message, errorCode }   拒绝，message 会回给模型看
   */
  async validateInput(_input, { getAppState, options }) {
    // Teammate AppState may show leader's mode (runAgent.ts skips override in
    // acceptEdits/bypassPermissions/auto); isPlanModeRequired() is the real source
    // 【中文补注】子 Agent 的 AppState 里显示的可能是**负责人**的模式
    // （派生子 Agent 时，某些模式下会跳过模式覆盖），所以不能用 AppState 判断。
    // 真正的依据是 isPlanModeRequired()——"我这个 Agent 是不是被配置成
    // 强制走 plan mode"。所以子 Agent 直接放行，交给 call() 里那条分支处理。
    if (isTeammate()) {
      return { result: true }
    }
    // The deferred-tool list announces this tool regardless of mode, so the
    // model can call it after plan approval (fresh delta on compact/clear).
    // Reject before checkPermissions to avoid showing the approval dialog.
    // 【中文补注】见上面 JSDoc：延迟工具清单不分模式全量下发，
    // 所以模型误调用很常见；必须在弹窗之前拦掉。
    const mode = getAppState().toolPermissionContext.mode
    if (mode !== 'plan') {
      // 埋点：记录"在非 plan mode 下调了 ExitPlanMode"。
      // 这个指标用来衡量上面那种误调用有多频繁，
      // 如果居高不下说明提示词/工具清单的设计还需要调整。
      logEvent('tengu_exit_plan_mode_called_outside_plan', {
      logEvent('tengu_exit_plan_mode_called_outside_plan', {
        // ★ `as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
        //   这个长得离谱的类型名是一个**隐私标记类型**（brand type）。
        //   埋点系统规定：凡是往日志里塞字符串，都必须显式断言
        //   "我已核实过，这个值不是代码、不是文件路径"。
        //   把类型名写得这么长这么吓人，是为了让写的人在代码评审时
        //   一眼被 reviewer 揪出来："你确定这玩意儿不是用户隐私？"
        //   ≈ Java 里没有直接对应物；近似做法是给参数加个自定义注解
        //     @NoPii，再靠静态检查工具兜底。
        //   运行时它什么也不做（类型断言编译后就被擦掉了）。
        model:
          options.mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        // 记录"本次会话是否已经退出过 plan mode"——用来区分
        // "从未进过"和"进来又出去了之后又调了一次"这两种误调用
        hasExitedPlanModeInSession: hasExitedPlanModeInSession(),
      })
      // 拒绝。message 会原样回给模型看，所以措辞要能**纠正模型的行为**：
      // 不仅说"你不在 plan mode"，还补一句
      // "如果方案已经批准了，直接继续实现即可"——
      // 否则模型很可能原地打转，反复重试这个工具。
      return {
        result: false,
        message:
          'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.',
        // errorCode 是给调用方（SDK/hook）看的机器可读错误码，
        // 不同的数字代表不同的失败原因（本文件里 1 = 不在 plan mode）
        errorCode: 1,
      }
    }
    return { result: true }
  },
  /**
   * 权限判定：决定"要不要弹窗问用户"。
   *
   * 这是 plan mode 那道**闸门**的本体。返回值有三种行为：
   *   'allow'  直接放行，不打扰用户
   *   'ask'    弹窗询问用户（本工具的核心）
   *   'deny'   直接拒绝
   *
   * 本文件在这里做了第二次子 Agent 分流（第一次在 requiresUserInteraction）：
   *
   *   · 子 Agent → 'allow'
   *        为什么要"直接允许"？因为子 Agent 没有终端可以弹窗，
   *        弹了也是永久挂起。真正的审批改在 call() 里进行：
   *        把方案投递给 team-lead 等负责人批示。
   *        换句话说：**闸门从"本地弹窗"换成了"邮箱投递"**，
   *        审批人从用户换成了团队负责人，但"必须有人批准"这个约束没变。
   *
   *   · 普通会话 → 'ask'
   *        弹出"Exit plan mode?"对话框，用户可以看到方案全文并决定。
   *
   * updatedInput: input
   *   把（可能被修改过的）入参传下去。这里是原样透传，
   *   但如果用户在弹窗里编辑了方案（网页 UI / Ctrl+G），
   *   框架会把编辑后的内容塞进 updatedInput 的 plan 字段——
   *   这正是 call() 里那段 "CCR web UI may send an edited plan" 的来源。
   */
  async checkPermissions(input, context) {
    // For ALL teammates, bypass the permission UI to avoid sending permission_request
    // The call() method handles the appropriate behavior:
    // - If isPlanModeRequired(): sends plan_approval_request to leader
    // - Otherwise: exits plan mode locally (voluntary plan mode)
    // 【中文补注】见上面 JSDoc：子 Agent 跳过弹窗，改走邮箱审批。
    if (isTeammate()) {
      return {
        // `as const` 把 'allow' 从宽泛的 string 收窄成字面量类型 'allow'，
        // 这样才能匹配联合类型 'allow' | 'ask' | 'deny'。
        // ≈ Java 里 enum 常量和普通 String 的区别。
        behavior: 'allow' as const,
        updatedInput: input,
      }
    }

    // For non-teammates, require user confirmation to exit plan mode
    return {
      behavior: 'ask' as const,
      // 弹窗上显示的问句。用户看到方案全文 + 这句话，点同意/拒绝
      message: 'Exit plan mode?',
      updatedInput: input,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  /**
   * ★★★ 本文件的核心：真正执行"退出 plan mode"。
   *
   * 做什么：
   *   ① 拿到方案内容（优先用用户在弹窗里编辑过的版本，否则读磁盘）
   *   ② 如果方案被编辑过，把它同步回磁盘文件
   *   ③ 分三条路径处理：
   *        · 子 Agent 且强制 plan mode → 把方案投递给 team-lead 等批示（提前返回）
   *        · 普通会话 → 恢复模式 + 恢复权限
   *   ④ 组装输出
   *
   * 为什么需要（不复述代码的部分）：
   *   "退出 plan mode"听起来只是把 mode 改回去，但真正的难点是
   *   **要恢复进 plan mode 之前的所有状态**，而这些状态在进来时被改动过：
   *     · 原来的模式是什么？（存在 prePlanMode 里）
   *     · 危险权限被剥掉了，要还回去吗？（取决于恢复成什么模式）
   *     · 自动模式（auto）在 plan 期间被用过吗？现在该不该重新激活？
   *     · 自动模式的开关会不会已经熔断了？（熔断了就不能恢复成 auto）
   *   这些分支就是让这个文件从 130 行膨胀到 490 行的原因。
   *
   * 入参：
   *   input    模型传的入参（主要是 allowedPrompts），
   *            也可能被框架塞进 plan（用户在弹窗里编辑过的方案）
   *   context  工具执行上下文 ≈ Java 注入的 ExecutionContext
   * 返回值：
   *   { data: Output }  必须符合前面 outputSchema 声明的形状
   */
  async call(input, context) {
    // `!!context.agentId` 是 JS 里把任意值**转成布尔值**的惯用写法：
    //   第一个 ! 取非（转成布尔再取反），第二个 ! 再取反回来。
    //   ≈ Java 的 `context.getAgentId() != null && !context.getAgentId().isEmpty()`
    //   agentId 有值 → isAgent = true，说明这次调用来自子 Agent。
    const isAgent = !!context.agentId

    // 计划文件的路径。注意传了 agentId——子 Agent 有**自己独立**的计划文件，
    // 不会和主会话的方案互相覆盖（多个子 Agent 并行时尤其重要）。
    const filePath = getPlanFilePath(context.agentId)
    // CCR web UI may send an edited plan via permissionResult.updatedInput.
    // queryHelpers.ts full-replaces finalInput, so when CCR sends {} (no edit)
    // input.plan is undefined -> disk fallback. The internal inputSchema omits
    // `plan` (normally injected by normalizeToolInput), hence the narrowing.
    //
    // 【中文补注】这一段在解决一个很实际的坑：用户可能在审批弹窗里**改了方案**。
    //    · 改过 → 编辑后的内容会经 updatedInput 传到这里，要优先采用；
    //    · 没改 → 传过来的是空对象 {}，input.plan 是 undefined，要回退读磁盘。
    //   所以下面这行的语义是"传入优先，没传就读磁盘"。
    //
    // ★ TS 语法重点（Java 没有对应物，务必看懂）：
    //   `'plan' in input`          —— in 运算符，≈ Java 的 map.containsKey("plan")
    //   `typeof input.plan === 'string'` —— 运行时类型检查
    //   两者合起来不只是判断，更重要的作用是**类型收窄（narrowing）**：
    //   编译器看到这个 if 之后，就"知道" input.plan 一定是 string 了，
    //   所以在 ? 后面可以直接写 `input.plan` 而不用强转。
    //   ≈ Java 16+ 的 `if (o instanceof String s) { ... s ... }`，
    //     模式匹配后自动绑定一个类型正确的变量。
    //   为什么要这么绕？因为内部用的 inputSchema 里**压根没声明 plan 字段**
    //   （plan 是磁盘读的，只有 _sdkInputSchema 才有），
    //   所以直接写 input.plan 编译器会报错"这个属性不存在"，
    //   必须先用 in + typeof 证明它存在。这就是注释里 "hence the narrowing" 的意思。
    const inputPlan =
      'plan' in input && typeof input.plan === 'string' ? input.plan : undefined
    // `??` 空值合并：只有左侧是 null/undefined 时才用右侧。
    // ⚠️ 和 Java 的 `||` 不同：`??` 不会把空串 '' 也替换掉
    //    （这里其实希望空串也被当成"没传"，但 getPlan 读磁盘兜底更安全）。
    const plan = inputPlan ?? getPlan(context.agentId)

    // Sync disk so VerifyPlanExecution / Read see the edit. Re-snapshot
    // after: the only other persistFileSnapshotIfRemote call (api.ts) runs
    // in normalizeToolInput, pre-permission — it captured the old plan.
    // 【中文补注】为什么用户改了方案要**写回磁盘**？
    //   因为后面模型执行方案时，VerifyPlanExecution / Read 这类工具
    //   是从磁盘上的计划文件读内容的。如果只把编辑后的方案放在内存里，
    //   那些工具读到的还是模型自己写的旧版本——用户改的内容就白改了。
    //   另外那句 "it captured the old plan" 指出：唯一的另一处快照是在
    //   normalizeToolInput 里做的，那时候还没经过用户审批，存的是旧方案，
    //   所以这边改完磁盘必须**重新打一次快照**。
    if (inputPlan !== undefined && filePath) {
      // writeFile 返回 Promise，.catch(...) 挂一个错误处理。
      // ≈ Java 的 CompletableFuture.exceptionally(...)，链式写法。
      // 这里写文件失败不抛异常、不中断流程——落盘是锦上添花，
      // 失败了也不能让"退出 plan mode"这件主要的事失败。
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      // `void f()` = "我知道这是异步的，但我故意不等它"。
      // 「发射后不管」≈ Java 的 executor.submit(...) 但从不 get()。
      void persistFileSnapshotIfRemote()
    }
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      void persistFileSnapshotIfRemote()
    }

    /**
     * ★ 分支一：子 Agent（teammate）且被配置成"强制走 plan mode"。
     *
     * 这是多 Agent 团队机制里非常关键的一段，要讲清楚它在干什么：
     *
     * 背景：一个主 Agent 可以派生多个子 Agent（teammate）并行干活。
     *   有些子 Agent 被配置成 plan_mode_required——
     *   意思是"你不准自己决定怎么干，必须先出方案，由团队负责人批准"。
     *   这是防止子 Agent 在没人监管的情况下把代码库改乱。
     *
     * 问题：子 Agent 跑在后台，没有终端，弹不了审批窗。谁来批？
     *
     * 解法：把审批**从弹窗换成邮箱**。
     *   子 Agent 把方案打包成一条 plan_approval_request 消息，
     *   投递到 team-lead（团队负责人）的邮箱（mailbox）里，
     *   然后自己**停在这里等回信**（见 mapToolResult 里那段
     *   "Do NOT proceed until you receive approval"）。
     *   负责人看到后回复同意/驳回，子 Agent 才继续。
     *
     * 所以整个约束本质没变——"必须有人批准"——
     *   变的只是审批人（用户 → 团队负责人）和通道（弹窗 → 邮箱）。
     *   这是把人机交互协议**复用到** Agent 与 Agent 之间的漂亮例子。
     *
     * ⚠️ 注意：这个分支会 **return 提前返回**，
     *    不会执行后面的"恢复模式"逻辑——因为方案还没被批准，
     *    子 Agent 必须继续留在 plan mode（只读）里等批示。
     */
    // Check if this is a teammate that requires leader approval
    if (isTeammate() && isPlanModeRequired()) {
      // Plan is required for plan_mode_required teammates
      // 【中文补注】强制 plan mode 的子 Agent 必须真的写了方案才能申请审批。
      // 抛异常而不是返回错误对象——因为这是"模型用法错了"，
      // 需要立刻中断并把这段话回灌给模型，让它去补写方案文件。
      // 错误信息里带上 filePath，模型就知道该往哪儿写。
      if (!plan) {
        throw new Error(
          `No plan file found at ${filePath}. Please write your plan to this file before calling ExitPlanMode.`,
        )
      }
      // `getAgentName() || 'unknown'` 用的是 `||` 而不是 `??`：
      // 这里**故意**让空串 '' 也走兜底——空名字和没名字一样没用。
      // 正好复习一下：?? 只在 null/undefined 时兜底，|| 连 '' 和 0 都兜底。
      const agentName = getAgentName() || 'unknown'
      const teamName = getTeamName()
      // 生成这次审批请求的唯一 ID。
      // 为什么需要？因为负责人是**异步**回复的，中间可能同时有多个子 Agent
      // 在等批示。子 Agent 收到回信时要靠 requestId 对上"这条回复是批哪份方案的"。
      // ≈ Java 里的 correlationId / 请求-响应关联 ID。
      // formatAgentId(名字, 团队名) 造出形如 "researcher@my-team" 的标识。
      const requestId = generateRequestId(
        'plan_approval',
        formatAgentId(agentName, teamName || 'default'),
      )

      // 消息体。注意 `requestId` 和 `timestamp` 用的是**简写属性**：
      // 当变量名和字段名同名时，`{ requestId }` 等价于 `{ requestId: requestId }`。
      // 这个对象之后会被 JSON 序列化后塞进邮箱，
      // 所以它的形状就是 Agent 之间的**通信协议**（收发双方必须一致）。
      const approvalRequest = {
        type: 'plan_approval_request',
        from: agentName,
        timestamp: new Date().toISOString(),
        planFilePath: filePath,
        planContent: plan,
        requestId,
      }

      // ★ 投递到 team-lead 的邮箱。这里 **await** 了——
      //   必须确保消息真的落盘，才能告诉子 Agent"已提交"。
      //   否则可能出现"子 Agent 以为发出去了，负责人却从没收到"的悬案。
      //   邮箱（mailbox）是 Agent 之间异步通信的落地实现，
      //   ≈ Java 里的一个持久化的 BlockingQueue / 消息中间件。
      await writeToMailbox(
        // 收件人固定是 'team-lead'——团队负责人。
        // 子 Agent 不能指定别人来批，这是"谁能批"的权限边界。
        'team-lead',
        {
          from: agentName,
          // 消息正文是序列化后的 JSON 字符串，而不是对象。
          // 因为邮箱是跨进程的，落盘格式必须是文本。
          text: jsonStringify(approvalRequest),
          timestamp: new Date().toISOString(),
        },
        // 第三个参数 teamName：邮箱按团队隔离，
        // 不同团队里同名的 agent 不会互相串消息
        teamName,
      )

      // Update task state to show awaiting approval (for in-process teammates)
      // 【中文补注】把任务状态标记成"等待批准"，
      // 这样负责人的界面上能看到"某某正在等你批方案"，而不是以为它还在干活。
      // 只对**进程内**的子 Agent 生效（跨进程的子 Agent 没有对应的 task id）。
      const appState = context.getAppState()
      const agentTaskId = findInProcessTeammateTaskId(agentName, appState)
      if (agentTaskId) {
        setAwaitingPlanApproval(agentTaskId, context.setAppState, true)
      }

      return {
        data: {
          plan,
          isAgent: true,
          filePath,
          awaitingLeaderApproval: true,
          requestId,
        },
      }
    }

    // Note: Background verification hook is registered in REPL.tsx AFTER context clear
    // via registerPlanVerificationHook(). Registering here would be cleared during context clear.
    // 【中文补注】这是个"为什么这里什么都不做"的说明性注释，很有价值：
    //   你可能会想——方案都批了，是不是该在这儿注册一个后台校验钩子？
    //   不行。因为上下文清空（context clear）会把这里注册的钩子一起清掉。
    //   所以真正的注册时机在 REPL.tsx 里，而且要放在 context clear **之后**
    //   调用 registerPlanVerificationHook()。
    //   这类注释的作用是防止后人"好心"地把代码挪到错的地方。

    // Ensure mode is changed when exiting plan mode.
    // This handles cases where permission flow didn't set the mode
    // (e.g., when PermissionRequest hook auto-approves without providing updatedPermissions).
    // 【中文补注】为什么这里还要**再确认一次**模式已经切了？
    //   正常情况下，用户在弹窗里点同意时，权限流程会顺手把模式改掉。
    //   但有一条旁路：PermissionRequest hook 可以"自动批准"，
    //   而它不一定会带回 updatedPermissions——这时模式根本没被改。
    //   所以本工具必须自己兜底再改一次，不能假设别人改过了。
    //   这是防御式编程：不信任上游，自己保证最终状态正确。
    const appState = context.getAppState()
    // Compute gate-off fallback before setAppState so we can notify the user.
    // Circuit breaker defense: if prePlanMode was an auto-like mode but the
    // gate is now off (circuit breaker or settings disable), restore to
    // 'default' instead. Without this, ExitPlanMode would bypass the circuit
    // breaker by calling setAutoModeActive(true) directly.
    //
    // 【中文补注】★ 这是本文件最"绕"的一段，值得慢慢读。
    //
    //   背景：auto 模式 = 自动批准一切操作，不用人点。它很方便但很危险，
    //   所以外面套了一个**熔断器（circuit breaker）**：
    //   一旦检测到异常（比如短时间内大量危险操作），或者用户在设置里关掉，
    //   这个"自动模式的开关"就会被强制关掉。
    //
    //   现在设想这个场景：
    //     ① 用户以 auto 模式启动 → prePlanMode = 'auto'
    //     ② 模型进 plan mode（Enter 把 'auto' 存进 prePlanMode）
    //     ③ 在 plan 期间，auto 模式的熔断器因为某种原因**跳闸了**
    //     ④ 模型调 ExitPlanMode，准备恢复成 prePlanMode = 'auto'
    //
    //   如果不做防护，第 ④ 步就直接把模式恢复成 auto 了——
    //   **熔断器白跳了**！模型绕过了安全机制重新拿到自动批准权限。
    //   这是个真实的安全漏洞，所以必须挡：
    //   发现"要恢复成 auto，但 auto 的开关现在是关的"，
    //   就降级恢复成 'default'（普通模式，需要人工确认），
    //   并且**马上通知用户**"我给你降级了，原因是 xxx"。
    //
    //   为什么通知必须在 setAppState **之前**算好？
    //   因为 setAppState 之后状态就变了，那时再读就是新状态了。
    //   必须先算出要说什么，再改状态，最后发通知。顺序不能乱。
    //
    //   `let x: string | null = null`  声明一个"要么是字符串要么是 null"的变量。
    //   `A | B` 联合类型 ≈ Java 的 sealed interface 的两个实现，但轻量得多。
    //   用 let 而不是 const，是因为下面条件成立时要重新赋值。
    let gateFallbackNotification: string | null = null
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      // 取出"进 plan mode 之前"的模式。没存过（undefined）就当 'default'。
      // `??` 空值合并：只在 null/undefined 时用右侧，不会把 '' 也换掉。
      const prePlanRaw = appState.toolPermissionContext.prePlanMode ?? 'default'
      // 触发条件：想恢复成 auto，但 auto 的开关现在是**关的**。
      if (
        prePlanRaw === 'auto' &&
        // 这三连 `?.` 和 `??` 是本文件的典型画风，逐个拆开看：
        //   permissionSetupModule?.       模块可能没加载（本构建变体下是 null）
        //   .isAutoModeGateEnabled()      方法存在时才调用
        //   ?? false                      拿不到结果就当成"开关是关的"——
        //                                 这是**安全侧默认**：宁可降级也不能放行
        // `!(...)` 取反：开关没开
        !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
      ) {
        const reason =
          permissionSetupModule?.getAutoModeUnavailableReason() ??
          'circuit-breaker'
        gateFallbackNotification =
          permissionSetupModule?.getAutoModeUnavailableNotification(reason) ??
          'auto mode unavailable'
        logForDebugging(
          `[auto-mode gate @ ExitPlanModeV2Tool] prePlanMode=${prePlanRaw} ` +
            `but gate is off (reason=${reason}) — falling back to default on plan exit`,
          { level: 'warn' },
        )
      }
    }
    // 真的降级了 → 必须让用户知道。
    // 为什么不能悄悄降级？因为用户以为自己还在 auto 模式，
    // 结果发现每个操作都要点确认，会一头雾水。
    // 静默改变安全等级是安全产品的大忌——**降级必须可见**。
    if (gateFallbackNotification) {
      // `context.addNotification?.(...)` 里的 `?.()` 是"方法可能存在才调用"，
      // ≈ Java 的 `if (context.getAddNotification() != null) {...}`，但简洁得多。
      context.addNotification?.({
        // key 是这条通知的身份证：同样的 key 不会重复弹，避免刷屏
        key: 'auto-mode-gate-plan-exit-fallback',
        // 模板字符串插值，`plan exit → default · 熔断原因`
        text: `plan exit → default · ${gateFallbackNotification}`,
        // immediate = 立刻显示，不要排到队列后面
        priority: 'immediate',
        // warning 配色（黄），视觉上和普通提示区分开
        color: 'warning',
        // 10 秒后自动消失，不长期占着屏幕
        timeoutMs: 10000,
      })
    }

    /**
     * ★ 分支二/三：恢复模式。整个 plan mode 的"出门"动作都在这一个回调里。
     *
     * `context.setAppState(prev => {...})` 传的是**更新函数**不是新值。
     * ≈ Java 的 `map.compute(key, (k, oldValue) -> newValue)`：
     * 框架把"当前最新状态"喂进来，你返回新状态。
     * 为什么要这么绕？因为直接传新值的话，你读到的可能是**已经过期**的旧状态
     * （并发场景下别处刚改过）。传函数能保证拿到的是最新值。
     * ⚠️ 注意：这个回调是**同步**的，里面不能 await！
     *    所以上面那些需要异步的操作（写文件、发邮箱）都已经提前做完了。
     */
    context.setAppState(prev => {
      // 幂等保护：如果已经不在 plan mode 了（比如权限流程已经改过了），
      // 原样返回 prev，什么都不做。
      // ⚠️ 注意返回 prev 而不是新对象——这是 React 的约定：
      //    返回同一个引用 = "没有变化"，框架就不会触发重渲染。
      if (prev.toolPermissionContext.mode !== 'plan') return prev

      // 两个"副作用标记"（记在模块级全局状态里，不属于 AppState）：
      setHasExitedPlanMode(true)
      // 本次会话已经退出过 plan mode 了
      //   → 影响 validateInput 里的埋点判断
      //   → 以及"是不是该重新注入一遍提示词"之类的逻辑
      setNeedsPlanModeExitAttachment(true)
      // 需要往系统提示词里补一段"plan mode 已结束"的附件
      //   → 让模型知道自己现在可以改文件了

      // 从 prePlanMode 里把"进 plan mode 之前的模式"读回来，完成往返。
      // 这就是和 EnterPlanModeTool 之间的**状态契约**：
      // Enter 存进去，这里取出来。取不到（undefined）就当 'default'。
      let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        if (
          restoreMode === 'auto' &&
          !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
        ) {
          restoreMode = 'default'
        }
        // 本次恢复的目标是不是 auto 模式。
        // ⚠️ 注意：上面那个 if 可能已经把 restoreMode 从 'auto' 改成 'default' 了，
        //    所以这一行读的是**降级之后**的最终值，不是原始值。顺序很重要。
        const finalRestoringAuto = restoreMode === 'auto'
        // Capture pre-restore state — isAutoModeActive() is the authoritative
        // signal (prePlanMode/strippedDangerousRules are stale after
        // transitionPlanAutoMode deactivates mid-plan).
        // 【中文补注】英文注释在说：判断"plan 期间有没有用过 auto"，
        // 不能用 prePlanMode / strippedDangerousRules 这两个字段，
        // 因为它们在 plan 中途被自动停用过，已经**过期失真**了。
        // 唯一可信的是 isAutoModeActive() 这个运行时状态。
        // 这是个典型的"缓存字段会失效，要读权威源"的教训。
        //
        // ⚠️ 顺序陷阱：必须在 setAutoModeActive() **之前**读取旧值，
        //    否则读到的就是刚写进去的新值了。
        const autoWasUsedDuringPlan =
          autoModeStateModule?.isAutoModeActive() ?? false
        // 把 auto 的实际开关设成"是否要恢复成 auto"
        autoModeStateModule?.setAutoModeActive(finalRestoringAuto)
        // 如果 plan 期间用过 auto，但这次不恢复成 auto 了，
        // 就要额外补一段提示词告诉模型"auto 模式结束了，
        // 接下来每个操作都要用户确认了"。
        // 否则模型会以为还跟刚才一样畅通无阻。
        if (autoWasUsedDuringPlan && !finalRestoringAuto) {
          setNeedsAutoModeExitAttachment(true)
        }
      }
      // If restoring to a non-auto mode and permissions were stripped (either
      // from entering plan from auto, or from shouldPlanUseAutoMode),
      // restore them. If restoring to auto, keep them stripped.
      // 【中文补注】★ 危险权限的"还 / 不还"，取决于恢复成什么模式：
      //
      //   恢复成 auto（自动批准一切）→ **继续剥着**，不还
      //     为什么？auto 模式本身就是"机器替你批准一切"，
      //     如果还把危险权限（比如删库、强推）还回去，风险就叠加了。
      //     所以 auto 模式有自己的一套更严格的权限集合。
      //
      //   恢复成其它模式（default/acceptEdits 等）→ **还回去**
      //     要恢复到"进 plan mode 之前"那个用户自己调好的权限状态，
      //     否则用户会发现"我明明授权过 rm，怎么现在不让用了"。
      //     `strippedDangerousRules` 这个字段记录了"当初剥了哪些"，
      //     它不为空才说明确实需要恢复——这也是 Enter/Exit 契约的一部分。
      const restoringToAuto = restoreMode === 'auto'
      // 用 let 是因为下面两个分支都可能重新赋值（const 不允许）
      let baseContext = prev.toolPermissionContext
      if (restoringToAuto) {
        baseContext =
          permissionSetupModule?.stripDangerousPermissionsForAutoMode(
            baseContext,
          ) ?? baseContext
      } else if (prev.toolPermissionContext.strippedDangerousRules) {
        baseContext =
          permissionSetupModule?.restoreDangerousPermissions(baseContext) ??
          baseContext
      }
      // 不可变更新：浅拷贝 prev，只替换 toolPermissionContext。
      // ≈ Java 里 new 一个副本再改一个字段——原对象保持不动，
      //    别处持有的旧快照不会被偷偷改掉，React 也能靠引用变化判断要不要重渲染。
      return {
        ...prev,
        toolPermissionContext: {
          // 基于"权限已处理好"的 baseContext 再覆盖两个字段
          ...baseContext,
          // ① 模式恢复成进 plan 之前的那个（可能被降级成 'default'）
          mode: restoreMode,
          // ② ★ 清空 prePlanMode。为什么必须清？
          //    因为它是**一次性**的：这次退出已经用掉了。
          //    留着的话，下次再进 plan mode 时如果忘了覆盖，
          //    就会错误地恢复到很久以前的某个模式。
          //    用完即清，避免"脏数据被下次误用"。
          prePlanMode: undefined,
        },
      }
    })

    // 当前上下文里有没有 Agent 工具（能不能派生子 Agent）。
    // 有的话，最后给模型的回话里会多一句
    // "这个方案能拆成多个独立任务吗？要不要开个团队并行干"。
    // 两个条件的分工：
    //   isAgentSwarmsEnabled()  —— 多 Agent 团队这个特性的**总开关**（灰度中）
    //   tools.some(...)         —— 当前这个会话的工具清单里**确实注册了** Agent 工具
    const hasTaskTool =
      isAgentSwarmsEnabled() &&
      // `.some(t => ...)` ≈ Java 的 stream().anyMatch(...)
      // 箭头函数 `t => toolMatchesName(t, AGENT_TOOL_NAME)` ≈ lambda `t -> ...`
      context.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))

    return {
      data: {
        plan,
        isAgent,
        filePath,
        // `hasTaskTool || undefined` 是个"压缩"技巧：
        // false → undefined。为什么？因为 outputSchema 里这个字段是 .optional()，
        // 传 undefined 比传 false 更省（JSON 序列化时直接不出现这个键），
        // 而且下游判断 `if (hasTaskTool)` 对两者行为一致。
        hasTaskTool: hasTaskTool || undefined,
        // 同理。这里记录"用户有没有改过方案"——
        // inputPlan !== undefined 就说明方案是从弹窗（而非磁盘）来的，即被编辑过。
        planWasEdited: inputPlan !== undefined || undefined,
      },
    }
  },
  /**
   * ★★★ 本文件第二个核心：把"审批结果"翻译成**回灌给模型**的那段话。
   *
   * 做什么：
   *   根据三条不同的路径，生成三种截然不同的 tool_result 文本：
   *     ① 子 Agent 等负责人批示   → "已提交，别动，等回信"
   *     ② 子 Agent 已获批准      → "批准了，回个 ok 就行"
   *     ③ 普通会话（有方案）      → "批准了，方案原文如下，开工"
   *     ④ 普通会话（空方案）      → "批准了，继续吧"（没有方案可回灌）
   *
   * 为什么需要（这是理解本工具价值的关键）：
   *   模型批准之后要**照着方案执行**，但它手里的那份方案是它自己写的旧版本。
   *   如果用户在弹窗里改过方案，模型并不知道改了什么——
   *   所以必须把**批准后的最终版方案**原样回灌给它。
   *   少了这一步，用户辛辛苦苦在弹窗里改的内容就等于白改了。
   *   这就是注释里那句 "Always include the plan" 的由来。
   *
   * 入参：
   *   第一个参数：call() 的输出对象，这里直接在**参数位置解构**
   *     —— 一次性抽出 7 个字段当局部变量用。
   *     ≈ Java 21+ 的记录模式匹配，但 TS 里是日常操作。
   *   toolUseID：模型发起调用时给的 ID，回传结果必须原样带上，
   *     否则模型对不上是哪次调用的结果（API 会报格式错）。
   *
   * 返回值：一个 tool_result 块（Anthropic API 约定的格式）。
   */
  mapToolResultToToolResultBlockParam(
    {
      isAgent,
      plan,
      filePath,
      hasTaskTool,
      planWasEdited,
      awaitingLeaderApproval,
      requestId,
    },
    toolUseID,
  ) {
    // Handle teammate awaiting leader approval
    // 【中文补注】路径 ①：方案已投递给 team-lead，正在等批示。
    // 这段话的措辞非常关键——必须让子 Agent **停下来等**，
    // 而不是自己继续干活。所以用了加粗的
    // "**Important:** Do NOT proceed until you receive approval"。
    // 而且告诉他去收件箱（inbox）看回复，给出明确的下一步动作，
    // 否则子 Agent 不知道该干啥，会开始空转或者瞎猜。
    if (awaitingLeaderApproval) {
      return {
        type: 'tool_result',
        content: `Your plan has been submitted to the team lead for approval.

Plan file: ${filePath}

**What happens next:**
1. Wait for the team lead to review your plan
2. You will receive a message in your inbox with approval/rejection
3. If approved, you can proceed with implementation
4. If rejected, refine your plan based on the feedback

**Important:** Do NOT proceed until you receive approval. Check your inbox for response.

Request ID: ${requestId}`,
        tool_use_id: toolUseID,
      }
    }

    // 路径 ②：子 Agent 的方案**已经被批准了**（负责人批了，或者它是"自愿 plan mode"）
    // ⚠️ 为什么这里只让它回一个 "ok"，而不是让它开始干活？
    //    因为子 Agent 的"真正任务"是由负责人通过消息另行分派的，
    //    不是它自己在 plan mode 里想出来的那个方案。
    //    如果对它说"开工吧"，它可能会自作主张开始实现，和负责人的安排撞车。
    //    所以明确要求"你什么都不用做了，回个 ok 就行"——
    //    让这一轮尽快结束，把控制权交回给负责人。
    if (isAgent) {
      return {
        type: 'tool_result',
        content:
          'User has approved the plan. There is nothing else needed from you now. Please respond with "ok"',
        tool_use_id: toolUseID,
      }
    }

    // Handle empty plan
    // 【中文补注】路径 ④：用户批准了，但模型压根没写方案文件（plan 为 null 或全是空白）。
    // 这种情况不罕见——比如用户随口说"行，你看着办吧"，模型还没写方案就调了 ExitPlanMode。
    // 这时不能硬塞一段空方案给模型（会让它困惑），
    // 所以给一句中性的"已批准，继续吧"就够了。
    if (!plan || plan.trim() === '') {
      return {
        type: 'tool_result',
        content: 'User has approved exiting plan mode. You can now proceed.',
        tool_use_id: toolUseID,
      }
    }

    // 如果手边有 Agent 工具，就顺推销一句"要不要开个团队并行干"。
    // 为什么放在这里？因为方案刚被批准，正是"这几件事能不能并行"的最佳讨论时机。
    // 注意措辞是 "If this plan can be broken down into multiple **independent** tasks"
    // ——强调"独立"：有依赖关系的任务并行只会互相打架。
    const teamHint = hasTaskTool
      ? `\n\nIf this plan can be broken down into multiple independent tasks, consider using the ${TEAM_CREATE_TOOL_NAME} tool to create a team and parallelize the work.`
      : ''

    // Always include the plan — extractApprovedPlan() in the Ultraplan CCR
    // flow parses the tool_result to retrieve the plan text for the local CLI.
    // Label edited plans so the model knows the user changed something.
    // 【中文补注】★ 两句话都值得展开：
    //
    //   "Always include the plan"（方案必须原样带上）
    //     因为有个叫 Ultraplan CCR 的流程会**解析这段 tool_result**，
    //     把方案文本抠出来给本地 CLI 用。也就是说这段话不只是给模型看的，
    //     还是别的模块的数据来源——所以格式不能随便改。
    //
    //   "Label edited plans"（给编辑过的方案加标签）
    //     如果用户改过方案，标题写成 'Approved Plan (edited by user)'。
    //     这样模型一眼就知道"我原来写的那份被人动过了"，
    //     会更仔细地读内容，而不是凭记忆执行旧版本。
    const planLabel = planWasEdited
      ? 'Approved Plan (edited by user)'
      : 'Approved Plan'

    // 路径 ③：最常见的情况——普通会话，方案已批准，把方案原文回灌给模型。
    return {
      type: 'tool_result',
      content: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${filePath}
You can refer back to it if needed during implementation.${teamHint}

## ${planLabel}:
${plan}`,
      tool_use_id: toolUseID,
    }
  },
  // `satisfies ToolDef<InputSchema, Output>` 是编译期的契约检查：
  // "请验证上面这个对象确实实现了工具接口，但**不要**把它的类型擦成 ToolDef"。
  // 好处：漏写 call() 之类的方法会立刻报错，
  //      同时每个字段的精确类型都保留着（比如 input 依然能推导出具体形状）。
  // ≈ Java 的 implements，但不丢泛型细节。
  //   如果写成 `const X: ToolDef<...> = buildTool({...})` 就会丢细节。
} satisfies ToolDef<InputSchema, Output>)
