/**
 * ============================================================================
 *  【文件总览】src/tools/SkillTool/SkillTool.ts —— 「执行一个 Skill」的工具
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现了名为 `Skill` 的那个工具。模型判断"当前任务该用某个 skill"
 *  之后，就通过调用这个工具，把该 skill 的完整提示词**注入到当前对话里**。
 *
 * ---------------------------------------------------------------------------
 *  ★★ 先讲清楚：Skill（技能）到底是什么 ★★
 * ---------------------------------------------------------------------------
 *  一个 skill = 一个 SKILL.md 文件（带 YAML frontmatter）+ 可选的脚本/文档。
 *
 *      .claude/skills/pdf/SKILL.md 内容示意：
 *      ---
 *      name: pdf
 *      description: 处理 PDF 文件（抽取、合并、填表…）
 *      whenToUse: 用户提到 PDF / 需要读取或生成 PDF 时
 *      allowed-tools: Bash, Read
 *      context: fork            ← 可选，见下
 *      ---
 *      # 处理 PDF 的流程
 *      1. 先用 `pdftotext` 抽出文本 …
 *      2. …
 *
 *  也就是说：**skill 就是一段"可复用的提示词 + 配套脚本"**，
 *  平时不占上下文（系统提示里只有一行 `- pdf: 处理 PDF 文件`），
 *  模型认为需要时才由本工具把正文加载进来。
 *  这就是「渐进式披露」——用多少拿多少，避免几百个 skill 把上下文撑爆。
 *
 *  对比一下三种扩展方式，方便建立直觉：
 *      slash command（/foo）  → 用户手动敲的，人来触发
 *      skill                  → 模型自主判断触发（本文件负责）
 *      MCP tool               → 外部进程提供的真实函数调用
 *  实际上 skill 和 slash command 在实现上是**同一套 Command 对象**，
 *  区别只在于谁能触发（userInvocable / disableModelInvocation 两个开关）。
 *
 * ---------------------------------------------------------------------------
 *  【本文件在架构中的位置】——「发现 → 校验 → 授权 → 加载」四步
 * ---------------------------------------------------------------------------
 *
 *      ① 发现（谁来做）
 *          src/commands.ts / src/utils/loadSkillsDir.ts
 *            扫描 .claude/skills/、插件目录、MCP 提供的 skill
 *              └─> getAllCommands()              ← ★ 本文件（汇总本地 + MCP skill）
 *
 *      ② 校验（这个 skill 能不能用）
 *          模型输出 tool_use { name:"Skill", input:{ skill:"pdf" } }
 *            └─> SkillTool.validateInput()       ← ★ 本文件
 *                  检查：名字非空 / 存在 / 没禁用模型调用 / 是 prompt 类型
 *
 *      ③ 授权（要不要问用户）
 *            └─> SkillTool.checkPermissions()    ← ★ 本文件
 *                  deny 规则 → allow 规则 → "只含安全属性"自动放行 → 否则 ask
 *
 *      ④ 加载执行（把提示词塞进对话）
 *            └─> SkillTool.call()                ← ★ 本文件
 *                  ├─ inline（默认）：processPromptSlashCommand() 展开提示词
 *                  │                  → 作为 newMessages 注入当前对话
 *                  ├─ fork：executeForkedSkill() → 起一个子 agent 隔离执行
 *                  └─ remote：executeRemoteSkill() → 从远端 GCS/S3 拉 SKILL.md
 *
 *  注意一个反直觉的点：**Skill 工具自己几乎不"做事"**。
 *  inline 模式下它只是把 skill 的提示词变成一条 user message 塞回对话，
 *  真正干活的是"读了这段提示词之后的模型"。
 *  这也是为什么 call() 的返回值叫 newMessages——它在改写对话历史。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】（主要函数清单）
 * ---------------------------------------------------------------------------
 *   1. getAllCommands()              汇总本地命令 + MCP skill（去重）
 *   2. executeForkedSkill()          fork 模式：在子 agent 里执行 skill
 *   3. inputSchema / outputSchema    zod 定义的入参/出参结构（给模型看的 JSON Schema）
 *   4. SkillTool（buildTool 的结果） ★主体，含 5 个回调：
 *        validateInput()             入参校验
 *        checkPermissions()          权限判定
 *        call()                      真正执行
 *        mapToolResultToToolResultBlockParam()  把结果转成 API 要的 tool_result
 *        render*（委托给 ./UI.tsx）   终端渲染
 *   5. SAFE_SKILL_PROPERTIES / skillHasOnlySafeProperties()
 *                                    安全属性白名单：决定某个 skill 能否免授权
 *   6. isOfficialMarketplaceSkill()  判断是不是官方市场插件提供的 skill
 *   7. extractUrlScheme()            给埋点用的 URL scheme 提取
 *   8. executeRemoteSkill()          remote 模式：拉取远端 skill 正文并注入
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的语法，按出现频率排序）
 * ---------------------------------------------------------------------------
 *   - `feature('EXPERIMENTAL_SKILL_SEARCH')`  **编译期**常量，不是运行时 if！
 *     来自 `bun:bundle`。打包时被替换成 true/false 再 tree-shaking 掉，
 *     整段代码会从产物里彻底消失 ≈ C 的 `#ifdef`。
 *     ⚠️ 硬约束：只能用在 if / 三元的**条件位置**，不能先赋值给变量再判断，
 *     否则打包器认不出来。所以你会看到代码里反复写
 *     `feature('X') && remoteSkillModules!.foo()` 这种"啰嗦"的写法——
 *     那不是写得差，是 DCE（死代码消除）的强制要求。
 *
 *   - `remoteSkillModules!`  **非空断言**。它的类型是 `{...} | null`
 *     （因为 feature 为 false 时是 null），但调用点都在 feature 守卫里，
 *     运行时必然非空。`!` = "我保证不是 null，编译器别管了"
 *     ≈ Java 的 `(Foo) x` 强转，运行时不做检查。
 *
 *   - `Command & { type: 'prompt' }`  **交叉类型**（&）。
 *     ≈ Java 的 `class X extends Command implements Prompt`，但更轻：
 *     这里是"把两个类型合并起来"，用来收窄联合类型到某一个分支。
 *
 *   - `z.object({...})` / `z.union([a, b])`  **zod 校验库**。
 *     ≈ Java 的 Bean Validation + Jackson schema，但一份定义同时产出
 *     ①运行时校验器 ②静态 TS 类型 ③给模型看的 JSON Schema。
 *     `z.input<S>` / `z.infer<S>` 就是从 schema 反推 TS 类型。
 *
 *   - `lazySchema(() => z.object(...))`  延迟构造 schema。
 *     为什么？模块顶层就构造 zod schema 会拖慢启动（且可能有循环依赖），
 *     包一层函数变成"用到时才构造" ≈ Java 的 Supplier 懒加载。
 *
 *   - `satisfies ToolDef<...>`  **satisfies 运算符**（TS 4.9+）。
 *     "请检查这个对象是否符合 ToolDef，但**不要把它的类型放宽成** ToolDef"。
 *     好处：既做了类型检查，又保留了每个字段的精确字面量类型。
 *     ≈ Java 里没有；`as ToolDef` 会丢精度，`satisfies` 不会。
 *
 *   - `get inputSchema(): InputSchema { return inputSchema() }`  **getter**。
 *     ≈ Java 的 `public InputSchema getInputSchema()`，
 *     但调用时不写括号。这里用 getter 是为了配合上面的 lazySchema。
 *
 *   - `async function*` + `for await (const m of runAgent(...))` + `yield`
 *     异步生成器 ≈ Java 的 Flux/异步流。runAgent 是"边跑边吐消息"的，
 *     调用方用 for await 一条条消费。详见 src/query.ts 的范本注释。
 *
 *   - `finally { clearInvokedSkillsForAgent(agentId) }`
 *     ≈ Java 的 try-finally。这里用来**清理内存**：子 agent 跑完后释放
 *     缓存的 skill 正文，不管成功失败都要释放（所以放 finally）。
 *
 *   - `agentMessages.length = 0`  把数组长度设为 0 来清空并释放内存。
 *     ≈ Java 的 list.clear()，但 TS 里这样写能更明确地"丢弃引用"。
 *
 *   - `context.discoveredSkillNames?.has(name) ?? false`
 *     两个语法叠在一起：`?.` 可选链（前面是 null/undefined 就短路成 undefined），
 *     `??` 空值合并（左边是 null/undefined 才取右边）。
 *     ⚠️ `??` 和 `||` 的区别：`0` 和 `''` 在 `||` 里是 falsy 会被替换掉，
 *     但在 `??` 里不会。这里要的是"没这个集合就算 false"，用 ?? 才对。
 *
 *   - `...(cond && { key: val })`  **条件展开**。
 *     若 cond 为 false，`false` 展开后不产生任何属性（展开 null/false 是安全的）。
 *     这是"按条件往对象里加字段"的惯用写法，避免先建对象再 if 赋值。
 *
 *   - `commandName as AnalyticsMetadata_I_VERIFIED_...`  **as 断言**。
 *     ≈ Java 强转。这里的类型名长得夸张是**故意的**：它是一种"标记类型"，
 *     逼你在写埋点时显式声明"我确认这个字段不是代码/不是文件路径/已做 PII 标记"，
 *     防止把用户隐私或源码内容误传进分析系统。
 *
 *   - `new Set([...a, ...b])`  用 Set 去重 ≈ Java 的 `new HashSet<>(list)`，
 *     再 `[...set]` 展开回数组。用于合并 allowedTools 时去掉重复。
 *
 *   - `(m): m is UserMessage | ... => {...}`  **类型谓词**。
 *     返回 boolean，但能让 TS 在 filter 之后**收窄**数组元素类型
 *     ≈ Java 的 `instanceof` 模式匹配。
 *
 *   - `Object.keys(command)` / `command as Record<string, unknown>`
 *     运行时反射遍历对象字段 ≈ Java 的 `getDeclaredFields()`。
 *     Record<string, unknown> ≈ `Map<String, Object>` 的形状，
 *     unknown ≈ Java 的 Object，但**必须收窄后才能使用**（比 any 安全）。
 *
 *   - `Promise<ToolResult<Output>>`  泛型。≈ Java 的 `CompletableFuture<ToolResult<Output>>`，
 *     `async/await` ≈ Java 的虚拟线程写法，读起来像同步代码。
 * ============================================================================
 */
import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import uniqBy from 'lodash-es/uniqBy.js'
import { dirname } from 'path'
import { getProjectRoot } from 'src/bootstrap/state.js'
import {
  builtInCommandNames,
  findCommand,
  getCommands,
  type PromptCommand,
} from 'src/commands.js'
import type {
  Tool,
  ToolCallProgress,
  ToolResult,
  ToolUseContext,
  ValidationResult,
} from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import type { Command } from 'src/types/command.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from 'src/utils/permissions/permissions.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from 'src/utils/plugins/pluginIdentifier.js'
import { buildPluginCommandTelemetryFields } from 'src/utils/telemetry/pluginTelemetry.js'
import { z } from 'zod/v4'
import {
  addInvokedSkill,
  clearInvokedSkillsForAgent,
  getSessionId,
} from '../../bootstrap/state.js'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { errorMessage } from '../../utils/errors.js'
import {
  extractResultText,
  prepareForkedCommandContext,
} from '../../utils/forkedAgent.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createUserMessage, normalizeMessages } from '../../utils/messages.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { resolveSkillModelOverride } from '../../utils/model/model.js'
import { recordSkillUsage } from '../../utils/suggestions/skillUsageTracking.js'
import { createAgentId } from '../../utils/uuid.js'
import { runAgent } from '../AgentTool/runAgent.js'
import {
  getToolUseIDFromParentMessage,
  tagMessagesWithToolUseID,
} from '../utils.js'
import { SKILL_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/**
 * Gets all commands including MCP skills/prompts from AppState.
 * SkillTool needs this because getCommands() only returns local/bundled skills.
 * 中文补充：【发现阶段】汇总「所有可供 Skill 工具使用的命令」。
 *
 * 为什么需要：skill 有好几个来源——
 *   ① 项目/用户目录里的本地 skill（.claude/skills/…）
 *   ② 内置打包的 skill（bundled）
 *   ③ 插件（plugin）提供的 skill
 *   ④ MCP server 暴露的 skill（走 MCP 协议的 prompt）
 * 而 src/commands.ts 的 getCommands() **只返回本地和内置的**，
 * 拿不到 MCP 那一批。所以这里要把两批合并起来，才是完整清单。
 *
 * 入参/返回：
 * @param context 工具执行上下文，里面能拿到 AppState（含 MCP 命令）
 * @returns 去重后的命令列表（按 name 去重）
 */
async function getAllCommands(context: ToolUseContext): Promise<Command[]> {
  // Only include MCP skills (loadedFrom === 'mcp'), not plain MCP prompts.
  // Before this filter, the model could invoke MCP prompts via SkillTool
  // if it guessed the mcp__server__prompt name — they weren't discoverable
  // but were technically reachable.
  // 中文补充：这里只收 `type==='prompt' && loadedFrom==='mcp'` 的条目。
  // 为什么特意排除了「普通 MCP prompt」？因为系统提示里根本没列出它们，
  // 模型看不到却又能靠猜名字（mcp__server__xxx）调起来——
  // 这属于"隐式能力"，既不安全也不可预期。加这个过滤是把它堵掉。
  const mcpSkills = context
    .getAppState()
    .mcp.commands.filter(
      cmd => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp',
    )
  // 中文补充：没有 MCP skill 时直接走快路径，连 getCommands 的 await 都省了。
  // 注意这里 return 的是一个 Promise（非 async 场景下的常见写法）——
  // async 函数里 return Promise 会自动被 await 展开，不会变成"Promise 套 Promise"。
  if (mcpSkills.length === 0) return getCommands(getProjectRoot())
  const localCommands = await getCommands(getProjectRoot())
  // 中文补充：uniqBy(..., 'name') 按 name 去重，**保留先出现的那个**。
  // 所以顺序是"本地在前、MCP 在后"——同名时本地优先，符合"用户自己的配置
  // 应该覆盖外部来源"的直觉。
  return uniqBy([...localCommands, ...mcpSkills], 'name')
}

// Re-export Progress from centralized types to break import cycles
// 中文补充：把一个类型**原样再导出**一次。目的是打破循环依赖：
// 别的模块可以只 import 本文件，而不必去 import ../../types/tools.js。
// `export type { X as Y }` 只导出**类型**，编译后不留任何运行时代码。
export type { SkillToolProgress as Progress } from '../../types/tools.js'

import type { SkillToolProgress as Progress } from '../../types/tools.js'

// Conditional require for remote skill modules — static imports here would
// pull in akiBackend.ts (via remoteSkillLoader → akiBackend), which has
// module-level memoize()/lazySchema() consts that survive tree-shaking as
// side-effecting initializers. All usages are inside
// feature('EXPERIMENTAL_SKILL_SEARCH') guards, so remoteSkillModules is
// non-null at every call site.
// 中文补充：这里是**条件 require**，不是常规的 import。为什么？
//   如果写成静态 import，会把 akiBackend.ts 拖进来；而那个模块在顶层
//   就有 memoize()/lazySchema() 这类"有副作用"的初始化代码，
//   tree-shaking 删不掉它们，于是**关掉实验开关的产品**里依然会执行这些代码。
//   所以用 require 按需加载：只有 feature 开关打开时才真正加载。
//   代价是拿到的是 `null | {...}` 联合类型，每个调用点都得写 `!` 断言
//   （因为编译器不知道那里其实被 feature 守卫保护着）。
/* eslint-disable @typescript-eslint/no-require-imports */
const remoteSkillModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      ...(require('../../services/skillSearch/remoteSkillState.js') as typeof import('../../services/skillSearch/remoteSkillState.js')),
      ...(require('../../services/skillSearch/remoteSkillLoader.js') as typeof import('../../services/skillSearch/remoteSkillLoader.js')),
      ...(require('../../services/skillSearch/telemetry.js') as typeof import('../../services/skillSearch/telemetry.js')),
      ...(require('../../services/skillSearch/featureCheck.js') as typeof import('../../services/skillSearch/featureCheck.js')),
    }
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Executes a skill in a forked sub-agent context.
 * This runs the skill prompt in an isolated agent with its own token budget.
 * 中文补充：【执行阶段·fork 模式】在一个**独立的子 agent** 里执行 skill。
 *
 * 为什么需要「fork」这种模式？
 *   默认的 inline 模式会把 skill 的提示词直接塞进当前对话，好处是快、
 *   共享上下文；坏处是**污染主对话**——一个跑 50 步的重型 skill 会把
 *   主对话的上下文撑满，还会把中间过程全留在历史里。
 *   fork 模式就是把 skill 丢进一个隔离的子 agent：
 *     - 子 agent 有自己的 token 预算，跑飞了也只影响自己；
 *     - 主对话只拿到**最终结果**这一段文本，中间过程不进主上下文。
 *   SKILL.md 里写 `context: fork` 就走这条路。
 *
 * 关键步骤：
 *   ① 造一个 agentId，并记录埋点（skill 名、来源、是否嵌套调用等）；
 *   ② prepareForkedCommandContext() 准备好子 agent 的定义和初始消息；
 *   ③ 若 skill 声明了 effort，把它合并进 agent 定义（覆盖默认的思考强度）；
 *   ④ for await 消费 runAgent 的消息流：一边收集，一边通过 onProgress
 *      把子 agent 的动向实时回报给 UI（否则用户以为卡死）；
 *   ⑤ extractResultText() 从子 agent 的全部消息里抽出最终结论；
 *   ⑥ finally 里 clearInvokedSkillsForAgent() 释放缓存的 skill 正文。
 *
 * @param command 要执行的 skill（已收窄为 prompt 类型）
 * @param commandName skill 的名字（去掉了前导斜杠）
 * @param args 用户/模型传给 skill 的参数
 * @param context 工具执行上下文
 * @param canUseTool 子 agent 内部的权限回调
 * @param parentMessage 触发这次调用的 assistant 消息（用于关联进度）
 * @param onProgress 进度回调，可选
 * @returns 含 forked 状态与子 agent 最终结果的 ToolResult
 */
async function executeForkedSkill(
  // 中文补充：`Command & { type: 'prompt' }` 是交叉类型 —— 把联合类型
  // Command 收窄到"一定是 prompt 类型"，这样后面才能访问 .source/.effort 等字段。
  // ≈ Java 的 instanceof 之后强转成子类。
  command: Command & { type: 'prompt' },
  commandName: string,
  args: string | undefined,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress<Progress>,
): Promise<ToolResult<Output>> {
  const startTime = Date.now()
  // 中文补充：给子 agent 发一个独立 id。后续埋点、进度消息、
  // "清理 skill 缓存"都以它为钥匙。
  const agentId = createAgentId()
  const isBuiltIn = builtInCommandNames().has(commandName)
  const isOfficialSkill = isOfficialMarketplaceSkill(command)
  const isBundled = command.source === 'bundled'
  // 中文补充：**隐私设计**。用户自建的 skill 名字属于个人信息，不能原样上报。
  // 所以只有"内置 / 官方打包 / 官方市场"的名字能上报原名，
  // 其余一律打成 'custom'。这样分析侧既能统计分布，又不泄露用户私有内容。
  const forkedSanitizedName =
    isBuiltIn || isBundled || isOfficialSkill ? commandName : 'custom'

  const wasDiscoveredField =
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    remoteSkillModules!.isSkillSearchEnabled()
      ? {
          was_discovered:
            context.discoveredSkillNames?.has(commandName) ?? false,
        }
      : {}
  const pluginMarketplace = command.pluginInfo
    ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
    : undefined
  const queryDepth = context.queryTracking?.depth ?? 0
  const parentAgentId = getAgentContext()?.agentId
  logEvent('tengu_skill_tool_invocation', {
    command_name:
      forkedSanitizedName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // _PROTO_skill_name routes to the privileged skill_name BQ column
    // (unredacted, all users); command_name stays in additional_metadata as
    // the redacted variant for general-access dashboards.
    _PROTO_skill_name:
      commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    execution_context:
      'fork' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: (queryDepth > 0
      ? 'nested-skill'
      : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    query_depth: queryDepth,
    ...(parentAgentId && {
      parent_agent_id:
        parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...wasDiscoveredField,
    ...(process.env.USER_TYPE === 'ant' && {
      skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      skill_source:
        command.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(command.loadedFrom && {
        skill_loaded_from:
          command.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(command.kind && {
        skill_kind:
          command.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    }),
    ...(command.pluginInfo && {
      // _PROTO_* routes to PII-tagged plugin_name/marketplace_name BQ columns
      // (unredacted, all users); plugin_name/plugin_repository stay in
      // additional_metadata as redacted variants.
      _PROTO_plugin_name: command.pluginInfo.pluginManifest
        .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(pluginMarketplace && {
        _PROTO_marketplace_name:
          pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      plugin_name: (isOfficialSkill
        ? command.pluginInfo.pluginManifest.name
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      plugin_repository: (isOfficialSkill
        ? command.pluginInfo.repository
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginCommandTelemetryFields(command.pluginInfo),
    }),
  })

  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)

  // Merge skill's effort into the agent definition so runAgent applies it
  // 中文补充：effort = "思考强度"（低/中/高）。skill 可以在 frontmatter 里
  // 指定自己需要的强度（比如复杂重构要高），这里覆盖子 agent 的默认值。
  // 写法是 `{ ...baseAgent, effort }` —— **不可变更新**：
  // 不修改 baseAgent，而是复制一份并覆盖 effort 字段。
  // ≈ Java 里 new 一个副本再 setter，好处是别处持有的旧引用不会被偷偷改掉。
  const agentDefinition =
    command.effort !== undefined
      ? { ...baseAgent, effort: command.effort }
      : baseAgent

  // Collect messages from the forked agent
  const agentMessages: Message[] = []

  logForDebugging(
    `SkillTool executing forked skill ${commandName} with agent ${agentDefinition.agentType}`,
  )

  try {
    // Run the sub-agent
    // 中文补充：`for await ... of` 消费的是**异步生成器**（async generator），
    // 子 agent 每产出一条消息就流到这里一次 ≈ Java 的 Flux.subscribe 逐条处理。
    // 为什么不用"等全部跑完再拿数组"？因为要**实时回报进度**给 UI，
    // 否则一个跑 30 秒的 skill 期间用户屏幕上什么都没有。
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState,
      },
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools,
      override: { agentId },
    })) {
      // 中文补充：先存下来，最后要靠它们抽最终结果。
      agentMessages.push(message)

      // Report progress for tool uses (like AgentTool does)
      // 中文补充：只把"含工具调用/工具结果"的消息回报上去。
      // 纯文本消息对 UI 没有展示价值（子 agent 的碎碎念），
      // 全发过去只会把终端刷爆。
      if (
        (message.type === 'assistant' || message.type === 'user') &&
        onProgress
      ) {
        const normalizedNew = normalizeMessages([message])
        for (const m of normalizedNew) {
          // 中文补充：content 是"块数组"（text / tool_use / tool_result …），
          // 用 some() 判断有没有任一元素是工具相关 ≈ Java 的 stream().anyMatch()
          const hasToolContent = m.message.content.some(
            c => c.type === 'tool_use' || c.type === 'tool_result',
          )
          if (hasToolContent) {
            onProgress({
              toolUseID: `skill_${parentMessage.message.id}`,
              data: {
                message: m,
                type: 'skill_progress',
                prompt: skillContent,
                agentId,
              },
            })
          }
        }
      }
    }

    // 中文补充：从子 agent 的全部消息里抽出"最终结论"。
    // 第二个参数是兜底文案——万一子 agent 没产出文本（比如只调了工具就结束），
    // 至少有一句人话交代，不至于给模型喂一个空字符串。
    const resultText = extractResultText(
      agentMessages,
      'Skill execution completed',
    )
    // Release message memory after extracting result
    // 中文补充：把数组长度设为 0 来清空。子 agent 的几十条消息可能很大，
    // 结果已经抽出来了就立刻放手，避免长时间占用内存。
    // ≈ Java 的 list.clear()，但这里更明确地表达"丢弃引用、可被 GC"。
    agentMessages.length = 0

    const durationMs = Date.now() - startTime
    logForDebugging(
      `SkillTool forked skill ${commandName} completed in ${durationMs}ms`,
    )

    return {
      data: {
        success: true,
        commandName,
        status: 'forked',
        agentId,
        result: resultText,
      },
    }
  } finally {
    // Release skill content from invokedSkills state
    // 中文补充：finally 保证**无论成功还是抛异常**都会清理。
    // 缓存的 skill 正文（可能几万字）如果不清，会一直挂在内存里。
    // ≈ Java 的 try-with-resources / finally 释放资源。
    clearInvokedSkillsForAgent(agentId)
  }
}

/**
 * 入参 schema —— 同时承担三重职责：
 *   ① 运行时校验模型传进来的 JSON；
 *   ② 推导静态类型（下面 InputSchema）；
 *   ③ 生成给模型看的 JSON Schema（.describe() 里的文字会被模型读到）。
 *
 * 只有两个字段：
 *   skill（必填）——要执行的 skill 名字；
 *   args （可选）——传给 skill 的参数，等价于命令行里 /foo 后面那一串。
 *
 * 为什么用 lazySchema 包一层？模块顶层就构造 zod schema 会拖慢启动，
 * 也可能撞上循环依赖。包成函数 = 用到时才构造 ≈ Java 的 Supplier 懒加载。
 */
export const inputSchema = lazySchema(() =>
  z.object({
    skill: z
      .string()
      .describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
    args: z.string().optional().describe('Optional arguments for the skill'),
  }),
)
// 中文补充：`ReturnType<typeof f>` = "取函数 f 的返回值类型"。
// 因为 schema 是函数产出的，类型必须从返回值反推，不能直接写。
// ≈ Java 没有对应语法（Java 得靠泛型参数显式传）。
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 出参 schema —— 注意它是 **union（联合类型）**，因为 skill 有两种执行模式，
 * 返回的数据结构完全不同：
 *   inline：{ success, commandName, allowedTools?, model?, status:'inline'? }
 *   forked：{ success, commandName, status:'forked', agentId, result }
 * 用 z.union 让模型（和下游代码）能区分这两种结果。
 */
export const outputSchema = lazySchema(() => {
  // Output schema for inline skills (default)
  const inlineOutputSchema = z.object({
    success: z.boolean().describe('Whether the skill is valid'),
    commandName: z.string().describe('The name of the skill'),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe('Tools allowed by this skill'),
    model: z.string().optional().describe('Model override if specified'),
    status: z.literal('inline').optional().describe('Execution status'),
  })

  // Output schema for forked skills
  const forkedOutputSchema = z.object({
    success: z.boolean().describe('Whether the skill completed successfully'),
    commandName: z.string().describe('The name of the skill'),
    status: z.literal('forked').describe('Execution status'),
    agentId: z
      .string()
      .describe('The ID of the sub-agent that executed the skill'),
    result: z.string().describe('The result from the forked skill execution'),
  })

  return z.union([inlineOutputSchema, forkedOutputSchema])
})
type OutputSchema = ReturnType<typeof outputSchema>

// 中文补充：`z.input<S>` 取的是"**输入**侧类型"（可选字段还没被 zod 填充默认值），
// 与之相对的是 `z.infer<S>`（输出侧，已经过校验/转换）。
// 这里工具返回的是自己构造的对象，所以用 input 侧类型来约束更宽松也更准确。
export type Output = z.input<OutputSchema>

/**
 * ★ 本文件的主体：Skill 工具对象。
 *
 * `buildTool({...})` 是工厂函数——把一个"配置对象"包装成统一的 Tool 接口
 * （≈ Java 的 Builder 模式，最后 .build()）。
 * 末尾的 `satisfies ToolDef<...>` 会做类型检查，但**不会**把字段类型放宽。
 *
 * 几个顶层配置的含义：
 *   name                 Skill 工具的对外名字（来自 ./constants.ts）
 *   searchHint           给 ToolSearch 用的简短提示，帮模型在"工具太多"时找到它
 *   maxResultSizeChars   结果最多 100_000 字符，超过会被截断
 *                        （防止一个巨大 skill 把上下文炸掉）
 *   inputSchema/outputSchema  用 getter 包装，配合 lazySchema 延迟构造
 *   description          动态描述：把模型传的 skill 名拼进去，
 *                        这样权限弹窗上显示的是"Execute skill: pdf"而不是干巴巴的工具名
 *   prompt               工具的详细说明书，来自 ./prompt.ts
 */
export const SkillTool: Tool<InputSchema, Output, Progress> = buildTool({
  name: SKILL_TOOL_NAME,
  searchHint: 'invoke a slash-command skill',
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  description: async ({ skill }) => `Execute skill: ${skill}`,

  // 中文补充：工具说明书由 ./prompt.ts 生成（那段"如何使用 Skill 工具"的文本）。
  // getProjectRoot() 是为了让 prompt 能按项目目录做缓存/定制。
  prompt: async () => getPrompt(getProjectRoot()),

  // Only one skill/command should run at a time, since the tool expands the
  // command into a full prompt that Claude must process before continuing.
  // Skill-coach needs the skill name to avoid false-positive "you could have
  // used skill X" suggestions when X was actually invoked. Backseat classifies
  // downstream tool calls from the expanded prompt, not this wrapper, so the
  // name alone is sufficient — it just records that the skill fired.
  // 中文补充：这个字段喂给一个叫 skill-coach 的分类器，用来判断
  // "模型这次是不是用了 skill"。为什么只传 skill 名就够了？
  // 因为后续 skill 展开出来的工具调用会被**单独**分类，
  // 这里只要记录"这个 skill 触发过"，就能避免教练误报
  // "你本来可以用 skill X 的"（其实人家已经用了）。
  toAutoClassifierInput: ({ skill }) => skill ?? '',

  /**
   * 【校验阶段】在真正执行前，先判断"这个 skill 能不能被模型调用"。
   *
   * 为什么需要单独一步：模型很可能写出不存在的 skill 名（幻觉），
   * 或者尝试调用一个明确声明"禁止模型调用"的命令。
   * 与其执行到一半报错，不如在这里快速失败并给出**人能看懂**的错误信息——
   * 这段错误文本会作为 tool_result 回给模型，模型往往能据此自我纠正。
   *
   * 检查顺序（任一失败就返回 result:false + 一个 errorCode）：
   *   ① skill 名非空白                          → errorCode 1
   *   ② （前导斜杠容错）`/pdf` 也认，并打埋点统计有多少模型爱加斜杠
   *   ③ 远端 canonical skill 的先导判断（实验功能）→ errorCode 6（未发现过）
   *   ④ 名字能在命令表里找到                     → errorCode 2
   *   ⑤ 该命令没设 disableModelInvocation        → errorCode 4
   *   ⑥ 该命令确实是 prompt 类型（而不是纯命令） → errorCode 5
   *
   * @param input.skill 模型传进来的 skill 名
   * @param context 工具上下文（用来拿命令表）
   * @returns { result: true } 或 { result: false, message, errorCode }
   */
  async validateInput({ skill }, context): Promise<ValidationResult> {
    // Skills are just skill names, no arguments
    // 中文补充：trim() 去掉首尾空白。模型偶尔会输出 " pdf " 这种，
    // 不做 trim 就会查不到，白白浪费一轮自我纠正。
    const trimmed = skill.trim()
    if (!trimmed) {
      return {
        result: false,
        message: `Invalid skill format: ${skill}`,
        errorCode: 1,
      }
    }

    // Remove leading slash if present (for compatibility)
    // 中文补充：模型经常写成 `/pdf`（受 slash command 习惯影响），
    // 这里宽容地接受并去掉斜杠。同时打一个埋点——如果这个比例很高，
    // 说明提示词写得不够清楚，值得回头改 prompt。
    const hasLeadingSlash = trimmed.startsWith('/')
    if (hasLeadingSlash) {
      logEvent('tengu_skill_tool_slash_prefix', {})
    }
    const normalizedCommandName = hasLeadingSlash
      ? trimmed.substring(1)
      : trimmed

    // Remote canonical skill handling (ant-only experimental). Intercept
    // `_canonical_<slug>` names before local command lookup since remote
    // skills are not in the local command registry.
    // 中文补充：**顺序很关键** —— 远端 skill 必须在查本地命令表**之前**拦截。
    // 因为远端 skill 根本不在本地注册表里，先查本地必然得到 "Unknown skill"，
    // 错误信息就会误导模型（它明明存在，只是没下载过）。
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(
        normalizedCommandName,
      )
      if (slug !== null) {
        const meta = remoteSkillModules!.getDiscoveredRemoteSkill(slug)
        if (!meta) {
          return {
            result: false,
            message: `Remote skill ${slug} was not discovered in this session. Use DiscoverSkills to find remote skills first.`,
            errorCode: 6,
          }
        }
        // Discovered remote skill — valid. Loading happens in call().
        return { result: true }
      }
    }

    // Get available commands (including MCP skills)
    const commands = await getAllCommands(context)

    // Check if command exists
    const foundCommand = findCommand(normalizedCommandName, commands)
    if (!foundCommand) {
      return {
        result: false,
        message: `Unknown skill: ${normalizedCommandName}`,
        errorCode: 2,
      }
    }

    // Check if command has model invocation disabled
    // 中文补充：disableModelInvocation 是 SKILL.md frontmatter 里的一个开关。
    // 设了它的命令只允许**用户手动**敲（比如 /clear 这种有副作用的），
    // 禁止模型自己触发——否则模型可能在用户没要求时就把对话清了。
    if (foundCommand.disableModelInvocation) {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} cannot be used with ${SKILL_TOOL_NAME} tool due to disable-model-invocation`,
        errorCode: 4,
      }
    }

    // Check if command is a prompt-based command
    if (foundCommand.type !== 'prompt') {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} is not a prompt-based skill`,
        errorCode: 5,
      }
    }

    return { result: true }
  },

  /**
   * 【授权阶段】判断这次 skill 调用要不要问用户。
   *
   * 为什么 skill 也需要权限？因为执行一个 skill 等价于"往对话里注入一大段
   * 指令"，而这些指令可能来自第三方插件、甚至远端下载的内容。
   * 能力上它可以声明 allowed-tools 给自己放开工具权限 —— 这显然需要把关。
   *
   * 判定顺序（**先 deny 后 allow**，这是硬性安全顺序）：
   *   ① deny 规则命中          → 直接拒绝（用户显式拉黑优先于一切）
   *   ② 远端 canonical skill    → 自动放行（内容经过审核，且放在 deny 之后
   *                                是为了让用户配的 deny 规则仍然生效）
   *   ③ allow 规则命中          → 放行
   *   ④ "只含安全属性"的 skill  → 自动放行（见 skillHasOnlySafeProperties）
   *   ⑤ 其余                    → ask：弹窗问用户，并给出两条建议规则
   *                               （精确匹配 / 前缀匹配）
   *
   * @param input.skill / input.args 模型传入的 skill 名与参数
   * @param context 工具上下文（拿权限配置）
   * @returns PermissionDecision：allow / deny / ask 三选一
   */
  async checkPermissions(
    { skill, args },
    context,
  ): Promise<PermissionDecision> {
    // Skills are just skill names, no arguments
    const trimmed = skill.trim()

    // Remove leading slash if present (for compatibility)
    const commandName = trimmed.startsWith('/') ? trimmed.substring(1) : trimmed

    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    // Look up the command object to pass as metadata
    const commands = await getAllCommands(context)
    const commandObj = findCommand(commandName, commands)

    // Helper function to check if a rule matches the skill
    // Normalizes both inputs by stripping leading slashes for consistent matching
    // 中文补充：这是一个**闭包函数**（定义在函数内部的函数），
    // 它能直接引用外层的 commandName ≈ Java 的 lambda 捕获外部变量。
    // 支持两种规则写法：
    //   `pdf`      精确匹配
    //   `review:*` 前缀匹配（用来一次放行一整族 skill）
    const ruleMatches = (ruleContent: string): boolean => {
      // Normalize rule content by stripping leading slash
      const normalizedRule = ruleContent.startsWith('/')
        ? ruleContent.substring(1)
        : ruleContent

      // Check exact match (using normalized commandName)
      if (normalizedRule === commandName) {
        return true
      }
      // Check prefix match (e.g., "review:*" matches "review-pr 123")
      if (normalizedRule.endsWith(':*')) {
        const prefix = normalizedRule.slice(0, -2) // Remove ':*'
        return commandName.startsWith(prefix)
      }
      return false
    }

    // Check for deny rules
    // 中文补充：`SkillTool as Tool` 是因为这里正在定义 SkillTool 自身，
    // 类型上还没完全成形，需要 as 断言一下（≈ Java 的强转）来打破自引用。
    // 返回的是一个 Map（规则内容 → 规则对象），for...of + entries() 遍历
    // ≈ Java 的 for (Map.Entry<K,V> e : map.entrySet())。
    const denyRules = getRuleByContentsForTool(
      permissionContext,
      SkillTool as Tool,
      'deny',
    )
    for (const [ruleContent, rule] of denyRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: 'deny',
          message: `Skill execution blocked by permission rules`,
          decisionReason: {
            type: 'rule',
            rule,
          },
        }
      }
    }

    // Remote canonical skills are ant-only experimental — auto-grant.
    // Placed AFTER the deny loop so a user-configured Skill(_canonical_:*)
    // deny rule is honored (same pattern as safe-properties auto-allow below).
    // The skill content itself is canonical/curated, not user-authored.
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(commandName)
      if (slug !== null) {
        return {
          behavior: 'allow',
          updatedInput: { skill, args },
          decisionReason: undefined,
        }
      }
    }

    // Check for allow rules
    const allowRules = getRuleByContentsForTool(
      permissionContext,
      SkillTool as Tool,
      'allow',
    )
    for (const [ruleContent, rule] of allowRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: 'allow',
          updatedInput: { skill, args },
          decisionReason: {
            type: 'rule',
            rule,
          },
        }
      }
    }

    // Auto-allow skills that only use safe properties.
    // This is an allowlist: if a skill has any property NOT in this set with a
    // meaningful value, it requires permission. This ensures new properties added
    // in the future default to requiring permission.
    // 中文补充：这是**体验与安全的折中**。
    // 如果每个 skill 都弹窗，用户很快就会无脑点 Yes，权限体系形同虚设；
    // 所以这里对"只用安全属性"的 skill 直接放行。
    // 关键设计是**白名单而不是黑名单**：将来 PromptCommand 新增字段时，
    // 只要没被显式加入白名单，就默认需要授权 —— 安全默认值（secure by default）。
    // 反过来说，如果这里写的是黑名单，新增字段就会默认免授权，非常危险。
    if (
      commandObj?.type === 'prompt' &&
      skillHasOnlySafeProperties(commandObj)
    ) {
      return {
        behavior: 'allow',
        updatedInput: { skill, args },
        decisionReason: undefined,
      }
    }

    // Prepare suggestions for exact skill and prefix
    // Use normalized commandName (without leading slash) for consistent rules
    // 中文补充：弹窗上会给出两条"一键放行"的建议，写入本地设置：
    //   `Skill(pdf)`      只放行这一个 skill
    //   `Skill(pdf:*)`    放行这个 skill 带任意参数的所有调用
    // 给用户选择权，避免每次都问。
    // `as const` 让字面量的类型保持为 'addRules' 而不是宽泛的 string。
    const suggestions = [
      // Exact skill suggestion
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: commandName,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
      // Prefix suggestion to allow any args
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: `${commandName}:*`,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
    ]

    // Default behavior: ask user for permission
    return {
      behavior: 'ask',
      message: `Execute skill: ${commandName}`,
      decisionReason: undefined,
      suggestions,
      updatedInput: { skill, args },
      metadata: commandObj ? { command: commandObj } : undefined,
    }
  },

  /**
   * 【执行阶段·总入口】真正把 skill 跑起来。
   *
   * ★ 最重要的一点：inline 模式下本函数**并不"干活"**，
   *   它只是把 skill 的提示词展开成若干条 message 塞回对话
   *   （返回值里的 newMessages），然后由模型接着往下做。
   *   换句话说：Skill 工具 = "把一份说明书插入对话"的工具。
   *
   * 三条执行路径：
   *   ① remote（实验）  `_canonical_<slug>` → executeRemoteSkill() 拉远端正文
   *   ② fork           SKILL.md 写了 context: fork → executeForkedSkill()
   *   ③ inline（默认）  processPromptSlashCommand() 展开 → newMessages 注入
   *
   * inline 路径还要做几件"副作用"的事（都在 contextModifier 或返回值里）：
   *   - allowedTools：把 skill 声明的工具临时加进白名单；
   *   - model：切换本次使用的模型（还要保留 [1m] 这类窗口后缀）；
   *   - effort：调整思考强度。
   *
   * @param input.skill / input.args  skill 名与参数
   * @param context    工具上下文
   * @param canUseTool 权限回调（fork 时传给子 agent）
   * @param parentMessage 触发这次调用的 assistant 消息
   * @param onProgress 进度回调（fork 时实时回报）
   * @returns ToolResult，inline 时带 newMessages 与 contextModifier
   */
  async call(
    { skill, args },
    context,
    canUseTool,
    parentMessage,
    onProgress?,
  ): Promise<ToolResult<Output>> {
    // At this point, validateInput has already confirmed:
    // - Skill format is valid
    // - Skill exists
    // - Skill can be loaded
    // - Skill doesn't have disableModelInvocation
    // - Skill is a prompt-based skill

    // Skills are just names, with optional arguments
    const trimmed = skill.trim()

    // Remove leading slash if present (for compatibility)
    const commandName = trimmed.startsWith('/') ? trimmed.substring(1) : trimmed

    // Remote canonical skill execution (ant-only experimental). Intercepts
    // `_canonical_<slug>` before local command lookup — loads SKILL.md from
    // AKI/GCS (with local cache), injects content directly as a user message.
    // Remote skills are declarative markdown so no slash-command expansion
    // (no !command substitution, no $ARGUMENTS interpolation) is needed.
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(commandName)
      if (slug !== null) {
        return executeRemoteSkill(slug, commandName, parentMessage, context)
      }
    }

    const commands = await getAllCommands(context)
    const command = findCommand(commandName, commands)

    // Track skill usage for ranking
    // 中文补充：记录"这个 skill 被用过"。用途是给 skill 列表排序、
    // 以及给"你可能想用 X"这类提示提供依据 —— 用得多的排前面。
    recordSkillUsage(commandName)

    // Check if skill should run as a forked sub-agent
    // 中文补充：`command?.type === 'prompt'` 连用了两个 TS 语法：
    //   ?. 可选链（findCommand 可能没找到，command 是 undefined）
    //   === 'prompt' 字面量收窄（进分支后 TS 知道它是 prompt 类型，
    //      才能访问 .context）≈ Java 的 instanceof 模式匹配。
    if (command?.type === 'prompt' && command.context === 'fork') {
      return executeForkedSkill(
        command,
        commandName,
        args,
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )
    }

    // Process the skill with optional args
    // 中文补充：**动态 import**（函数形式的 import()），而不是文件顶部的静态 import。
    // 好处：① 这个模块很重，只有真要走 inline 路径时才加载；
    //      ② 规避循环依赖（processSlashCommand 反过来也会引用本文件）。
    // ≈ Java 的 Class.forName() 反射加载，但 TS 里是标准语法且保留类型。
    const { processPromptSlashCommand } = await import(
      'src/utils/processUserInput/processSlashCommand.js'
    )
    const processedCommand = await processPromptSlashCommand(
      commandName,
      args || '', // Pass args if provided
      commands,
      context,
    )

    if (!processedCommand.shouldQuery) {
      throw new Error('Command processing failed')
    }

    // Extract metadata from the command
    // 中文补充：这三行读的就是 SKILL.md frontmatter 里的声明：
    //   allowed-tools   这个 skill 运行期间放开哪些工具
    //   model           这个 skill 要用哪个模型跑
    //   effort          思考强度
    // 它们都会在下面的 contextModifier 里被"临时应用"到当前会话。
    const allowedTools = processedCommand.allowedTools || []
    const model = processedCommand.model
    const effort = command?.type === 'prompt' ? command.effort : undefined

    const isBuiltIn = builtInCommandNames().has(commandName)
    const isBundled = command?.type === 'prompt' && command.source === 'bundled'
    const isOfficialSkill =
      command?.type === 'prompt' && isOfficialMarketplaceSkill(command)
    const sanitizedCommandName =
      isBuiltIn || isBundled || isOfficialSkill ? commandName : 'custom'

    const wasDiscoveredField =
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      remoteSkillModules!.isSkillSearchEnabled()
        ? {
            was_discovered:
              context.discoveredSkillNames?.has(commandName) ?? false,
          }
        : {}
    const pluginMarketplace =
      command?.type === 'prompt' && command.pluginInfo
        ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
        : undefined
    const queryDepth = context.queryTracking?.depth ?? 0
    const parentAgentId = getAgentContext()?.agentId
    logEvent('tengu_skill_tool_invocation', {
      command_name:
        sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // _PROTO_skill_name routes to the privileged skill_name BQ column
      // (unredacted, all users); command_name stays in additional_metadata as
      // the redacted variant for general-access dashboards.
      _PROTO_skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      execution_context:
        'inline' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      invocation_trigger: (queryDepth > 0
        ? 'nested-skill'
        : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      query_depth: queryDepth,
      ...(parentAgentId && {
        parent_agent_id:
          parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...wasDiscoveredField,
      ...(process.env.USER_TYPE === 'ant' && {
        skill_name:
          commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(command?.type === 'prompt' && {
          skill_source:
            command.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(command?.loadedFrom && {
          skill_loaded_from:
            command.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(command?.kind && {
          skill_kind:
            command.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
      }),
      ...(command?.type === 'prompt' &&
        command.pluginInfo && {
          _PROTO_plugin_name: command.pluginInfo.pluginManifest
            .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          ...(pluginMarketplace && {
            _PROTO_marketplace_name:
              pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          }),
          plugin_name: (isOfficialSkill
            ? command.pluginInfo.pluginManifest.name
            : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          plugin_repository: (isOfficialSkill
            ? command.pluginInfo.repository
            : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...buildPluginCommandTelemetryFields(command.pluginInfo),
        }),
    })

    // Get the tool use ID from the parent message for linking newMessages
    const toolUseID = getToolUseIDFromParentMessage(
      parentMessage,
      SKILL_TOOL_NAME,
    )

    // Tag user messages with sourceToolUseID so they stay transient until this tool resolves
    // 中文补充：给这些消息打上"来源 tool_use_id"的标记。
    // 作用是让它们成为**临时消息**：本工具还没结束时，它们不该被当成
    // 稳定的历史（比如被压缩、被持久化），等工具返回后才转正。
    const newMessages = tagMessagesWithToolUseID(
      processedCommand.messages.filter(
        // 中文补充：`(m): m is X | Y | Z => ...` 是**类型谓词**。
        // 它返回 boolean，但能告诉 TS：filter 之后数组元素类型被收窄成了
        // 这三种消息 ≈ Java 里 filter + instanceof 后的强转，但由编译器保证。
        (m): m is UserMessage | AttachmentMessage | SystemMessage => {
          if (m.type === 'progress') {
            return false
          }
          // Filter out command-message since SkillTool handles display
          // 中文补充：`<command-message>` 标签包裹的是"用户敲了 /foo"这回事的
          // 展示用副本。SkillTool 自己会在终端上画这一行，
          // 所以没必要再作为消息塞进对话里，否则会重复显示。
          if (m.type === 'user' && 'message' in m) {
            const content = m.message.content
            if (
              typeof content === 'string' &&
              content.includes(`<${COMMAND_MESSAGE_TAG}>`)
            ) {
              return false
            }
          }
          return true
        },
      ),
      toolUseID,
    )

    logForDebugging(
      `SkillTool returning ${newMessages.length} newMessages for skill ${commandName}`,
    )

    // Note: addInvokedSkill and registerSkillHooks are called inside
    // processPromptSlashCommand (via getMessagesForPromptSlashCommand), so
    // calling them again here would double-register hooks and rebuild
    // skillContent redundantly.

    // Return success with newMessages and contextModifier
    return {
      data: {
        success: true,
        commandName,
        allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
        model,
      },
      newMessages,
      // 中文补充：contextModifier 是"工具执行完之后，如何修改会话上下文"的钩子。
      // 它返回一个**新的** context（不可变更新），不会改原来的对象。
      // 这是 SkillTool 实现"临时放开工具权限 / 临时换模型"的手段。
      contextModifier(ctx) {
        let modifiedContext = ctx

        // Update allowed tools if specified
        if (allowedTools.length > 0) {
          // Capture the current getAppState to chain modifications properly
          // 中文补充：先把**当前**的 getAppState 存成 previousGetAppState，
          // 后面在新 getAppState 里调用它。这是个很关键的坑：
          // 如果直接调用外层 context.getAppState，叠加多次修改时会
          // 回到最初的那一份，把上一次的修改覆盖掉（丢修改）。
          // 用局部变量串起来，才能保证修改是**链式叠加**的。
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              // Use the previous getAppState, not the closure's context.getAppState,
              // to properly chain context modifications
              const appState = previousGetAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    // 中文补充：`new Set([...旧的, ...新增])` 再展开回数组 = 合并去重。
                    // 用 Set 是为了避免重复项（多次加载同一个 skill 会重复添加）
                    // ≈ Java 的 new HashSet<>(list) 再 new ArrayList<>(set)。
                    command: [
                      ...new Set([
                        ...(appState.toolPermissionContext.alwaysAllowRules
                          .command || []),
                        ...allowedTools,
                      ]),
                    ],
                  },
                },
              }
            },
          }
        }

        // Carry [1m] suffix over — otherwise a skill with `model: opus` on an
        // opus[1m] session drops the effective window to 200K and trips autocompact.
        // 中文补充：这是一个真实的踩坑记录。模型名后面可以带 [1m] 后缀表示
        // "启用 100 万 token 窗口"。如果 skill 里写 `model: opus` 就直接替换，
        // 会把 opus[1m] 降级成 opus（窗口从 1M 掉到 200K），
        // 于是上下文突然不够用了，触发自动压缩（autocompact）。
        // 所以要用 resolveSkillModelOverride() 把后缀**继承**过来。
        if (model) {
          modifiedContext = {
            ...modifiedContext,
            options: {
              ...modifiedContext.options,
              mainLoopModel: resolveSkillModelOverride(
                model,
                ctx.options.mainLoopModel,
              ),
            },
          }
        }

        // Override effort level if skill specifies one
        if (effort !== undefined) {
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              const appState = previousGetAppState()
              return {
                ...appState,
                effortValue: effort,
              }
            },
          }
        }

        return modifiedContext
      },
    }
  },

  /**
   * 把工具的返回值转换成 API 协议要求的 tool_result 块。
   *
   * 为什么需要：模型（Anthropic API）要求的格式是
   *   { type:'tool_result', tool_use_id, content }
   * 而我们内部用的是自己的 Output 结构，得在这里做最后一次翻译。
   *
   * 两种模式的差别很大：
   *   forked → 把子 agent 的最终结果全文回给模型（它没看到过过程）；
   *   inline → 只回一句 `Launching skill: xxx`，
   *            因为真正的提示词已经通过 newMessages 注入对话了，
   *            在这里重复一遍纯属浪费 token。
   *
   * @param result 工具返回的 Output
   * @param toolUseID 这次 tool_use 的 id，用来把结果对回请求
   * @returns API 需要的 ToolResultBlockParam
   */
  mapToolResultToToolResultBlockParam(
    result: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    // Handle forked skill result
    // 中文补充：`'status' in result` 辨别联合类型分支（inline vs forked）
    // ≈ Java 的 instanceof 判断。
    if ('status' in result && result.status === 'forked') {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: `Skill "${result.commandName}" completed (forked execution).\n\nResult:\n${result.result}`,
      }
    }

    // Inline skill result (default)
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: `Launching skill: ${result.commandName}`,
    }
  },

  // 中文补充：下面 5 行把渲染函数挂到工具上（实现在 ./UI.tsx）。
  // 这里只写函数名不写括号 —— 传的是**函数本身**（引用），不是调用结果，
  // 由框架在合适的时机回调。≈ Java 里传一个函数式接口实例 / 方法引用。
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  // 中文补充：`satisfies` 是 TS 4.9 的语法：既要求这个对象**符合** ToolDef，
  // 又**保留**每个字段自己的精确类型（不像 `as ToolDef` 会把类型放宽）。
  // 好处是：写错字段名会报错，同时下游拿到的还是精确类型。
} satisfies ToolDef<InputSchema, Output, Progress>)

// 中文补充：下面这个 Set 是**安全属性白名单**——判断某个 skill 能否免授权
// 直接执行（详见 skillHasOnlySafeProperties）。
// 设计要点是「白名单而非黑名单」：将来 Command 类型新增字段时，
// 只要没被显式加进来，就默认需要用户授权 —— 安全默认值。
// Allowlist of PromptCommand property keys that are safe and don't require permission.
// If a skill has any property NOT in this set with a meaningful value, it requires
// permission. This ensures new properties added to PromptCommand in the future
// default to requiring permission until explicitly reviewed and added here.
const SAFE_SKILL_PROPERTIES = new Set([
  // PromptCommand properties
  'type',
  'progressMessage',
  'contentLength',
  'argNames',
  'model',
  'effort',
  'source',
  'pluginInfo',
  'disableNonInteractive',
  'skillRoot',
  'context',
  'agent',
  'getPromptForCommand',
  'frontmatterKeys',
  // CommandBase properties
  'name',
  'description',
  'hasUserSpecifiedDescription',
  'isEnabled',
  'isHidden',
  'aliases',
  'isMcp',
  'argumentHint',
  'whenToUse',
  'paths',
  'version',
  'disableModelInvocation',
  'userInvocable',
  'loadedFrom',
  'immediate',
  'userFacingName',
])

/**
 * 判断一个 skill 是否"只使用了安全属性"，从而可以免授权直接执行。
 *
 * 为什么需要：见 checkPermissions 里的说明——这是权限弹窗的**自动放行**条件。
 *
 * 判定逻辑（白名单 + 空值宽容）：
 *   ① 遍历这个 skill 对象的所有字段；
 *   ② 字段名在 SAFE_SKILL_PROPERTIES 白名单里 → 跳过；
 *   ③ 不在白名单里，但值是"没有意义"的（undefined / null / 空数组 / 空对象）
 *      → 也跳过。为什么要宽容空值？因为反序列化常会留下值为空的字段，
 *        若一律要求授权，会让几乎所有 skill 都弹窗，白名单就白做了；
 *   ④ 其余情况（有实际值的未知字段）→ 返回 false，要求授权。
 *
 * @param command 要检查的 skill
 * @returns true = 只含安全属性，可自动放行
 */
function skillHasOnlySafeProperties(command: Command): boolean {
  // 中文补充：Object.keys() 是**运行时**遍历对象字段 ≈ Java 的反射
  // getDeclaredFields()。TS 的类型在编译后就消失了，只能这样遍历。
  for (const key of Object.keys(command)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) {
      continue
    }
    // Property not in safe allowlist - check if it has a meaningful value
    // 中文补充：`command as Record<string, unknown>` 是断言成"任意键值对象"，
    // 这样才能用 `[key]` 动态取字段（否则 TS 会报"这个字段不存在"）。
    // unknown ≈ Java 的 Object：**必须先收窄类型才能使用**，比 any 安全。
    const value = (command as Record<string, unknown>)[key]
    if (value === undefined || value === null) {
      continue
    }
    if (Array.isArray(value) && value.length === 0) {
      continue
    }
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue
    }
    return false
  }
  return true
}

/**
 * 判断这个 skill 是否来自**官方市场**（official marketplace）的插件。
 *
 * 为什么需要两档区分：官方市场里的插件经过审核，其 skill 名字可以
 * 原样上报埋点、默认享受"已审核"的信任；第三方插件一律打成
 * 'third-party'。这既是隐私考虑，也是信任分级。
 *
 * @param command 一个 prompt 类型的命令
 * @returns true = 官方市场插件提供
 */
function isOfficialMarketplaceSkill(command: PromptCommand): boolean {
  // 中文补充：两个前置条件——必须来自插件，且插件声明了仓库地址
  // （没有仓库地址就无法判断它属于哪个市场）。
  if (command.source !== 'plugin' || !command.pluginInfo?.repository) {
    return false
  }
  return isOfficialMarketplaceName(
    parsePluginIdentifier(command.pluginInfo.repository).marketplace,
  )
}

/**
 * Extract URL scheme for telemetry. Defaults to 'gs' for unrecognized schemes
 * since the AKI backend is the only production path and the loader throws on
 * unknown schemes before we reach telemetry anyway.
 * 中文补充：从 URL 里提取协议头（scheme），**仅供埋点统计**用。
 *
 * 为什么需要：远端 skill 可能托管在 GCS / S3 / HTTP 上，
 * 分析侧想知道各来源的加载延迟和缓存命中率，所以要按 scheme 分桶。
 *
 * 入参/返回：
 * @param url skill 的下载地址
 * @returns 'gs' | 'http' | 'https' | 's3'
 *
 * 注意返回类型是**联合字面量类型**（≈ Java 的 enum），
 * 不是 string —— 传别的值给下游会在编译期就报错。
 */
function extractUrlScheme(url: string): 'gs' | 'http' | 'https' | 's3' {
  if (url.startsWith('gs://')) return 'gs'
  if (url.startsWith('https://')) return 'https'
  if (url.startsWith('http://')) return 'http'
  if (url.startsWith('s3://')) return 's3'
  return 'gs'
}

/**
 * Load a remote canonical skill and inject its SKILL.md content into the
 * conversation. Unlike local skills (which go through processPromptSlashCommand
 * for !command / $ARGUMENTS expansion), remote skills are declarative markdown
 * — we wrap the content directly in a user message.
 *
 * The skill is also registered with addInvokedSkill so it survives compaction
 * (same as local skills).
 *
 * Only called from within a feature('EXPERIMENTAL_SKILL_SEARCH') guard in
 * call() — remoteSkillModules is non-null here.
 *
 * 中文补充：【执行阶段·remote 模式】从远端（GCS/S3）拉取 skill 正文并注入对话。
 *
 * 为什么需要这条路径：远端 skill 是"托管在服务端、按需下载"的官方 skill，
 * 不占本地磁盘，也不进本地命令表。模型先用 DiscoverSkills 工具检索到它们，
 * 再通过 `_canonical_<slug>` 这种特殊名字来调用。
 *
 * 与本地 skill 的关键差异 —— **不做斜杠命令展开**。
 * 本地 skill 的正文里可以写 `!ls -la`（先执行 shell 命令把结果嵌入）和
 * `$ARGUMENTS`（插入参数），这些替换由 processPromptSlashCommand 完成；
 * 而远端 skill 被定义为"纯声明式 markdown"，不允许带这类可执行内容
 * （否则等于让远端下发的文本在本地执行任意命令，安全风险极高）。
 * 所以这里直接把文本包成一条 user message 就行。
 *
 * 关键步骤：
 *   ① 重新查一次会话里的"已发现远端 skill"记录，拿到 URL；查不到就报错
 *      （提示先用 DiscoverSkills），而不是崩掉；
 *   ② loadRemoteSkill() 下载（带本地缓存），失败要打埋点再抛错；
 *   ③ 打一条加载埋点（是否命中缓存、耗时、文件数、字节数）；
 *   ④ 剥掉 YAML frontmatter（正文才是给模型看的）；
 *   ⑤ 拼上 "Base directory for this skill: …" 头，并把 ${CLAUDE_SKILL_DIR}
 *      替换成缓存目录 —— 否则正文里的相对路径（./schemas/foo.json）无法解析；
 *   ⑥ addInvokedSkill() 登记，让这段内容在上下文压缩后仍能恢复；
 *   ⑦ 包装成一条 meta user message 返回。
 *
 * 入参/返回：
 * @param slug 远端 skill 的短标识（去掉 `_canonical_` 前缀后的部分）
 * @param commandName 模型实际写的名字（含 `_canonical_` 前缀）
 * @param parentMessage 触发这次调用的 assistant 消息（用于关联 tool_use_id）
 * @param context 工具上下文
 * @returns ToolResult，带 newMessages（装着 skill 正文）
 */
async function executeRemoteSkill(
  slug: string,
  commandName: string,
  parentMessage: AssistantMessage,
  context: ToolUseContext,
): Promise<ToolResult<Output>> {
  const { getDiscoveredRemoteSkill, loadRemoteSkill, logRemoteSkillLoaded } =
    remoteSkillModules!

  // validateInput already confirmed this slug is in session state, but we
  // re-fetch here to get the URL. If it's somehow gone (e.g., state cleared
  // mid-session), fail with a clear error rather than crashing.
  const meta = getDiscoveredRemoteSkill(slug)
  if (!meta) {
    throw new Error(
      `Remote skill ${slug} was not discovered in this session. Use DiscoverSkills to find remote skills first.`,
    )
  }

  const urlScheme = extractUrlScheme(meta.url)
  // 中文补充：`let loadResult` 先声明后赋值（因为要在 try 外面用）。
  // 类型由下面的赋值自动推断，不需要手写标注。
  let loadResult
  try {
    // 中文补充：真正下载（内部有本地缓存，命中缓存就不会走网络）。
    loadResult = await loadRemoteSkill(slug, meta.url)
  } catch (e) {
    // 中文补充：失败也要打埋点（error 字段），否则线上加载失败率是多少
    // 完全看不见。打完再抛错，让上层走正常的工具失败流程。
    const msg = errorMessage(e)
    logRemoteSkillLoaded({
      slug,
      cacheHit: false,
      latencyMs: 0,
      urlScheme,
      error: msg,
    })
    throw new Error(`Failed to load remote skill ${slug}: ${msg}`)
  }

  const {
    cacheHit,
    latencyMs,
    skillPath,
    content,
    fileCount,
    totalBytes,
    fetchMethod,
  } = loadResult

  logRemoteSkillLoaded({
    slug,
    cacheHit,
    latencyMs,
    urlScheme,
    fileCount,
    totalBytes,
    fetchMethod,
  })

  // Remote skills are always model-discovered (never in static skill_listing),
  // so was_discovered is always true. is_remote lets BQ queries separate
  // remote from local invocations without joining on skill name prefixes.
  const queryDepth = context.queryTracking?.depth ?? 0
  const parentAgentId = getAgentContext()?.agentId
  logEvent('tengu_skill_tool_invocation', {
    command_name:
      'remote_skill' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // _PROTO_skill_name routes to the privileged skill_name BQ column
    // (unredacted, all users); command_name stays in additional_metadata as
    // the redacted variant.
    _PROTO_skill_name:
      commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    execution_context:
      'remote' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: (queryDepth > 0
      ? 'nested-skill'
      : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    query_depth: queryDepth,
    ...(parentAgentId && {
      parent_agent_id:
        parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    was_discovered: true,
    is_remote: true,
    remote_cache_hit: cacheHit,
    remote_load_latency_ms: latencyMs,
    ...(process.env.USER_TYPE === 'ant' && {
      skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      remote_slug:
        slug as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
  })

  recordSkillUsage(commandName)

  logForDebugging(
    `SkillTool loaded remote skill ${slug} (cacheHit=${cacheHit}, ${latencyMs}ms, ${content.length} chars)`,
  )

  // Strip YAML frontmatter (---\nname: x\n---) before prepending the header
  // (matches loadSkillsDir.ts:333). parseFrontmatter returns the original
  // content unchanged if no frontmatter is present.
  // 中文补充：parseFrontmatter 把 `---\nname: x\n---` 这段 YAML 头剥掉，
  // 返回正文。没有 frontmatter 时原样返回（不会报错）。
  // 解构时 `content: bodyContent` 是**改名解构**——把返回字段 content
  // 赋给新名字 bodyContent，避免和上面的 content 变量冲突。
  const { content: bodyContent } = parseFrontmatter(content, skillPath)

  // Inject base directory header + ${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID}
  // substitution (matches loadSkillsDir.ts) so the model can resolve relative
  // refs like ./schemas/foo.json against the cache dir.
  // 中文补充：这两个替换是**必须**的，不是锦上添花：
  //   - skill 正文里写的相对路径是相对于"skill 文件所在目录"的，
  //     而下载后文件在缓存目录里，不告诉模型这个目录它根本找不到文件；
  //   - 时间戳/会话 id 的替换同理。这里刻意与本地 skill 的处理
  //     (loadSkillsDir.ts) 保持一致，让两种来源的行为无差别。
  const skillDir = dirname(skillPath)
  // 中文补充：Windows 的路径分隔符是反斜杠，统一换成正斜杠。
  // 否则模型看到的路径是 `C:\Users\..\skills\pdf`，容易解析错。
  const normalizedDir =
    process.platform === 'win32' ? skillDir.replace(/\\/g, '/') : skillDir
  let finalContent = `Base directory for this skill: ${normalizedDir}\n\n${bodyContent}`
  finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, normalizedDir)
  finalContent = finalContent.replace(
    /\$\{CLAUDE_SESSION_ID\}/g,
    getSessionId(),
  )

  // Register with compaction-preservation state. Use the cached file path so
  // post-compact restoration knows where the content came from. Must use
  // finalContent (not raw content) so the base directory header and
  // ${CLAUDE_SKILL_DIR} substitutions survive compaction — matches how local
  // skills store their already-transformed content via processSlashCommand.
  // 中文补充：`?? null` —— getAgentContext() 可能返回 undefined（不在子 agent 里），
  // 而这里需要一个明确的 null。注意不能用 `||`：虽然这里两者效果一样，
  // 但 `??` 的语义才是"只在 null/undefined 时兜底"，不会误伤 0 和 ''。
  addInvokedSkill(
    commandName,
    skillPath,
    finalContent,
    getAgentContext()?.agentId ?? null,
  )

  // Direct injection — wrap SKILL.md content in a meta user message. Matches
  // the shape of what processPromptSlashCommand produces for simple skills.
  // 中文补充：isMeta: true 表示这条消息是"系统注入的元信息"，
  // 不是用户真的说的话。这样在压缩历史、展示给用户时可以区别对待。
  const toolUseID = getToolUseIDFromParentMessage(
    parentMessage,
    SKILL_TOOL_NAME,
  )
  return {
    data: { success: true, commandName, status: 'inline' },
    newMessages: tagMessagesWithToolUseID(
      [createUserMessage({ content: finalContent, isMeta: true })],
      toolUseID,
    ),
  }
}
