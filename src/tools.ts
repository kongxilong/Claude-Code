// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 【一句话定位】工具的「注册表 / 装配车间」：把散落在各目录下的 50+ 个具体工具收集起来，
 * 按环境变量、feature 开关、权限规则、REPL 模式等条件过滤后，产出一份最终的工具列表（Tools）给主循环。
 *
 * 【在架构中的位置】
 *   上游（谁调用本文件）：
 *     src/query.ts / QueryEngine.ts  —— 主循环启动时调用 getTools / assembleToolPool 拿到工具列表
 *     REPL.tsx（useMergedTools）     —— 交互式会话里组装「内置工具 + MCP 工具」的完整工具池
 *     runAgent.ts                    —— coordinator 模式下给 worker 分配工具
 *     src/services/tools/toolExecution.ts —— 执行期用 findToolByName 在工具池里查工具
 *     src/utils/toolSearch.ts 等     —— 估算工具数量、决定是否启用 ToolSearch（defer 加载）
 *   下游（本文件依赖谁）：
 *     ./tools/*                      —— 每一个具体工具的实现（BashTool、FileReadTool、AgentTool ...）
 *     ./Tool.js（Tool / Tools / toolMatchesName）—— 工具的接口定义
 *     ./utils/permissions/permissions.js（getDenyRuleForTool）—— 权限侧的 deny 规则匹配
 *     ./constants/tools.js           —— 各 agent 类型的工具白名单 / 黑名单常量
 *   调用链：
 *     启动 → assembleToolPool(permissionContext, mcpTools)
 *       → getTools(permissionContext) → getAllBaseTools()（全量清单，按 env/feature 过滤）
 *       → filterToolsByDenyRules()（按 deny 规则剔除）
 *       → REPL 模式下再剔除被 REPL 包起来的原始工具 → 最后按 isEnabled() 过滤
 *       → MCP 工具同样过一遍 deny 过滤 → 排序 → uniqBy 去重合并
 *     → 得到 Tools → 交给主循环，由 toolExecution.ts 在模型点名时执行
 *
 * 【本文件包含什么】
 *   TOOL_PRESETS / ToolPreset / parseToolPreset —— --tools 参数用的工具预设（目前只有 'default' 一档）
 *   getToolsForDefaultPreset() —— 列出默认预设下所有【当前可用】工具的名字（给 CLI 展示用）
 *   getAllBaseTools()          —— 全量内置工具清单（本文件的核心大数组，按环境变量与 feature 开关条件装配）
 *   filterToolsByDenyRules()   —— 把被 deny 规则整体屏蔽的工具剔除（用与运行时相同的匹配器）
 *   getTools()                 —— 主入口：按权限上下文产出最终的内置工具列表（含 simple 模式、REPL 模式特殊分支）
 *   assembleToolPool()         —— 内置工具 + MCP 工具合并去重，是「完整工具池」的唯一真相来源
 *   getMergedTools()           —— 更轻量的合并版本（不去重、不排序），用于工具数量估算与 token 计算
 *   顶部一堆条件 require        —— 按 feature('XXX') / process.env 决定是否加载某些工具（配合打包期死代码消除）
 *
 * 【TS 语法速查】（针对本文件实际出现的写法，Java 工程师对照看）
 *   1. `feature('XXX') ? require(...) : null` —— 重点：这不是运行时 if，而是【编译期 #ifdef】。
 *      Bun 打包时会把它求值成常量并把 false 分支整段删掉（dead code elimination），
 *      所以那些内部专用工具不会出现在开源构建里。Java 没有对应物，最接近的是 Maven profile + 编译期常量折叠。
 *   2. `...(cond ? [A, B] : [])` —— 【条件展开】：三元表达式返回数组，再用 ... 摊平进字面量。
 *      cond 为 false 时摊平一个空数组，等价于「什么都不加」。这是本文件出现频率最高的套路。
 *   3. `...arr` 展开运算符 ≈ Java 的变长参数 / 数组拷贝合并，但在对象字面量里是「浅拷贝并覆盖」。
 *   4. `as const` —— 把数组/对象断言成【字面量类型】：`['default'] as const` 的类型不是 string[]
 *      而是只读元组 ('default')，编译器因此知道它只有这一个元素。
 *   5. `(typeof TOOL_PRESETS)[number]` —— 【索引访问类型】：先 typeof 取值类型，再用 [number] 取出
 *      数组元素类型的联合。效果：ToolPreset 会自动跟着 TOOL_PRESETS 的内容变化，不用手写两遍。
 *   6. `as ToolPreset` ≈ Java 强制类型转换：这里是因为 includes() 不能让编译器自动收窄类型，只能手动断言。
 *   7. 箭头函数 `const getTools = (ctx: T): Tools => { ... }` ≈ Java 的 Function<T, Tools> lambda 实现。
 *   8. 泛型约束 `<T extends { name: string; ... }>` ≈ Java `<T extends SomeInterface>`，
 *      但这里用的是匿名结构类型（鸭子类型），T 不必真的 implements 某个接口。
 *   9. `readonly T[]` ≈ 只读 List：函数内部不能 push/sort 原数组，所以常见写法是先 [...arr] 拷贝一份再排序。
 *  10. `!x` / `x ? y : z` 与 Java 一致，但注意 TS 里空串、0、null、undefined 都是 falsy。
 *  11. `import type { X }` 只导入类型，编译后被完全擦除——用来打破循环依赖（见文件里 getTeamCreateTool 的注释）。
 *  12. `export { A, B } from './xxx.js'` 是【再导出】（re-export）：本文件只是转发，方便调用方一处引入。
 */
import { toolMatchesName, type Tool, type Tools } from './Tool.js'
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { BriefTool } from './tools/BriefTool/BriefTool.js'
// ── 以下一大段是「条件加载」区：按 process.env / feature() 决定是否 require 某些工具模块 ──
// 目的有两个：① 内部专用工具不进开源构建；② 打包器能把 false 分支整段删掉，减小体积（见文件头 TS 速查第 1 条）。
// Dead code elimination: conditional import for ant-only tools
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const REPLTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/REPLTool/REPLTool.js').REPLTool
    : null
const SuggestBackgroundPRTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js')
        .SuggestBackgroundPRTool
    : null
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null
const cronTools = feature('AGENT_TRIGGERS')
  ? [
      require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
      require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
      require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
    ]
  : []
const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE')
  ? require('./tools/RemoteTriggerTool/RemoteTriggerTool.js').RemoteTriggerTool
  : null
const MonitorTool = feature('MONITOR_TOOL')
  ? require('./tools/MonitorTool/MonitorTool.js').MonitorTool
  : null
const SendUserFileTool = feature('KAIROS')
  ? require('./tools/SendUserFileTool/SendUserFileTool.js').SendUserFileTool
  : null
const PushNotificationTool =
  feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? require('./tools/PushNotificationTool/PushNotificationTool.js')
        .PushNotificationTool
    : null
const SubscribePRTool = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./tools/SubscribePRTool/SubscribePRTool.js').SubscribePRTool
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js'
import { ExitPlanModeV2Tool } from './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { TungstenTool } from './tools/TungstenTool/TungstenTool.js'
// Lazy require to break circular dependency: tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
// 注意这三个工具用的是【惰性 require】而不是顶层 import：
// TeamCreateTool / TeamDeleteTool / SendMessageTool 的模块链最终会反向依赖 tools.ts，
// 顶层 import 会形成循环依赖（模块还没初始化完就被访问，拿到 undefined）。
// 包成 () => require(...) 延迟到真正调用时才加载，就绕开了这个环。
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
const getTeamDeleteTool = () =>
  require('./tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('./tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool
const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('./tools/SendMessageTool/SendMessageTool.js').SendMessageTool
/* eslint-enable @typescript-eslint/no-require-imports */
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { LSPTool } from './tools/LSPTool/LSPTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { ToolSearchTool } from './tools/ToolSearchTool/ToolSearchTool.js'
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { ConfigTool } from './tools/ConfigTool/ConfigTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { isToolSearchEnabledOptimistic } from './utils/toolSearch.js'
import { isTodoV2Enabled } from './utils/tasks.js'
// Dead code elimination: conditional import for CLAUDE_CODE_VERIFY_PLAN
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const VerifyPlanExecutionTool =
  process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
    ? require('./tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js')
        .VerifyPlanExecutionTool
    : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'
import { feature } from 'bun:bundle'
// Dead code elimination: conditional import for OVERFLOW_TEST_TOOL
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const OverflowTestTool = feature('OVERFLOW_TEST_TOOL')
  ? require('./tools/OverflowTestTool/OverflowTestTool.js').OverflowTestTool
  : null
const CtxInspectTool = feature('CONTEXT_COLLAPSE')
  ? require('./tools/CtxInspectTool/CtxInspectTool.js').CtxInspectTool
  : null
const TerminalCaptureTool = feature('TERMINAL_PANEL')
  ? require('./tools/TerminalCaptureTool/TerminalCaptureTool.js')
      .TerminalCaptureTool
  : null
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null
const SnipTool = feature('HISTORY_SNIP')
  ? require('./tools/SnipTool/SnipTool.js').SnipTool
  : null
const ListPeersTool = feature('UDS_INBOX')
  ? require('./tools/ListPeersTool/ListPeersTool.js').ListPeersTool
  : null
const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? (() => {
      require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
      return require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool
    })()
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import type { ToolPermissionContext } from './Tool.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { hasEmbeddedSearchTools } from './utils/embeddedTools.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
import {
  REPL_TOOL_NAME,
  REPL_ONLY_TOOLS,
  isReplModeEnabled,
} from './tools/REPLTool/constants.js'
export { REPL_ONLY_TOOLS }
/* eslint-disable @typescript-eslint/no-require-imports */
const getPowerShellTool = () => {
  if (!isPowerShellToolEnabled()) return null
  return (
    require('./tools/PowerShellTool/PowerShellTool.js') as typeof import('./tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Predefined tool presets that can be used with --tools flag
 */
// 工具预设（配合 --tools 命令行参数）。as const 让它的类型收窄成只读字面量元组，
// 后面的 ToolPreset 类型就能直接从它派生，不用手工再维护一份字符串列表。
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]
// `(typeof TOOL_PRESETS)[number]` ≈ 取数组元素类型的联合。
// 好处：往 TOOL_PRESETS 里加一个值，ToolPreset 自动跟着变，不会出现两处定义不同步的经典 bug。

/** 把用户输入的预设字符串解析成 ToolPreset；不是合法预设就返回 null（由调用方决定怎么报错）。
 *  入参 preset：命令行传来的原始字符串（大小写不敏感）
 *  返回：合法的 ToolPreset，或 null 表示无法识别
 *  步骤：① 统一转小写 ② 用 includes 检查是否属于已知预设 ③ 断言成 ToolPreset 返回
 *  为什么要 as：TS 的 Array.includes 不会自动把 string 收窄成联合类型，只能显式断言。
 */
export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
// as ToolPreset：编译器无法从 includes() 的布尔结果推导出类型收窄，这里由开发者担保「确实是合法预设」。
}

/**
 * Get the list of tool names for a given preset
 * Filters out tools that are disabled via isEnabled() check
 * @param preset The preset name
 * @returns Array of tool names
 */
/** 列出默认预设下所有【当前可用】工具的名字（只给名字，不给工具对象）。
 *  用途：CLI 展示、诊断信息、以及需要「工具名清单」而不是工具对象的场合。
 *  步骤：① 取全量内置工具 ② 逐个调用 isEnabled() 得到可用性数组 ③ 按下标过滤后映射成名字
 *  为什么先 map 出布尔数组再按下标 filter：保证 isEnabled() 每个工具只调用一次，
 *  且不会因为 filter 里重复调用造成结果不一致（isEnabled 可能与外部状态相关）。
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  const isEnabled = tools.map(tool => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map(tool => tool.name)
// 经典「先算标志位、再按下标过滤」写法（也叫 decorate-filter-undecorate）：
// 避免在 filter 回调里重复调用 isEnabled()，同时保持下标一一对应。
}

/**
 * Get the complete exhaustive list of all tools that could be available
 * in the current environment (respecting process.env flags).
 * This is the source of truth for ALL tools.
 */
/**
 * NOTE: This MUST stay in sync with https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_code_global_system_caching, in order to cache the system prompt across users.
 */
/** 【全量清单】返回当前环境下所有可能被用到的内置工具。这是「有哪些工具」的唯一真相来源。
 *  装配规则：基础工具直接列出，条件工具用 `...(条件 ? [工具] : [])` 展开（见文件头 TS 速查第 2 条）。
 *  条件来源有三类：① feature('XXX') 编译期开关 ② process.env 环境变量 ③ isXxxEnabled() 运行时探测函数
 *  注意顺序：数组顺序会影响发给模型的 tools[] 顺序，进而影响 prompt cache 命中，所以不要随意重排。
 *  另：上面英文注释提醒它与 Statsig 上的系统提示词缓存配置必须保持同步——工具列表变了却没同步配置，
 *  会导致跨用户的 system prompt 缓存大面积失效。
 *  返回 Tools（readonly Tool[]）
 */
export function getAllBaseTools(): Tools {
// 下面每行 `...(cond ? [Tool] : [])` 都是一个「条件加入」：条件成立就摊平进一个元素，不成立就摊平进空数组。
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // Ant-native builds have bfs/ugrep embedded in the bun binary (same ARGV0
    // trick as ripgrep). When available, find/grep in Claude's shell are aliased
    // to these fast tools, so the dedicated Glob/Grep tools are unnecessary.
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
// 内部构建把 bfs/ugrep 编进了 bun 二进制（和 ripgrep 同样的 ARGV0 技巧），shell 里的 find/grep 已经很快，
// 这时就不再需要独立的 Glob / Grep 工具——少两个工具能省下一大截 prompt token。
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
    ...(process.env.USER_TYPE === 'ant' ? [TungstenTool] : []),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled()
      ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
      : []),
    ...(OverflowTestTool ? [OverflowTestTool] : []),
    ...(CtxInspectTool ? [CtxInspectTool] : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),
    ...(ListPeersTool ? [ListPeersTool] : []),
    ...(isAgentSwarmsEnabled()
      ? [getTeamCreateTool(), getTeamDeleteTool()]
      : []),
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(process.env.USER_TYPE === 'ant' && REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools,
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    BriefTool,
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(SnipTool ? [SnipTool] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    // Include ToolSearchTool when tool search might be enabled (optimistic check)
    // The actual decision to defer tools happens at request time in claude.ts
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
// ToolSearch 用「乐观检查」：这里只判断它【可能】被启用就先加进来，真正的 defer 决策留到发请求时（claude.ts）再定。
// 原因：工具列表要在发请求前就冻结下来，而是否 defer 取决于最终工具数量等更晚才知道的信息。
  ]
}

/**
 * Filters out tools that are blanket-denied by the permission context.
 * A tool is filtered out if there's a deny rule matching its name with no
 * ruleContent (i.e., a blanket deny for that tool).
 *
 * Uses the same matcher as the runtime permission check (step 1a), so MCP
 * server-prefix rules like `mcp__server` strip all tools from that server
 * before the model sees them — not just at call time.
 */
/** 把被 deny 规则【整体屏蔽】的工具从列表里剔除（不是「调用时拦住」，而是压根不让模型看见）。
 *  入参 tools：待过滤的工具数组（泛型 T 只要带 name 和可选 mcpInfo 即可，不要求是完整 Tool）
 *  入参 permissionContext：权限上下文，提供 deny 规则集
 *  返回：过滤后的新数组（不修改原数组）
 *  为什么要在列表阶段就剔除：
 *    ① 省 token——被禁的工具没必要把 schema 塞进 prompt；
 *    ② 避免模型反复尝试一个注定被拒的工具（它会一直重试，浪费轮次）。
 *  关键点：它复用了与运行时权限检查完全相同的匹配器，所以 `mcp__server` 这种「按服务器整体禁」的规则
 *  能在这里一次性摘掉该服务器的所有工具，而不是等到调用时才逐个拒绝。
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
// getDenyRuleForTool 返回「匹配的 deny 规则」或 null；取反即「没有被整体禁掉就保留」。
// 注意只有【无 ruleContent 的通配 deny】才算整体屏蔽——带内容的规则（如 Bash(git *)）仍要运行时逐次判断。
}

/** 【主入口】根据权限上下文产出最终可用的内置工具列表。
 *  入参 permissionContext：权限上下文（提供 mode 与 allow/deny/ask 规则）
 *  返回 Tools：最终工具列表
 *  整体流程：
 *    ① simple 模式（CLAUDE_CODE_SIMPLE）走极简分支：只保留 Bash / Read / Edit（或 REPL），
 *       若同时处于 coordinator 模式则补上 Agent / TaskStop / SendMessage
 *    ② 普通模式：取全量清单 → 剔除 specialTools（MCP 资源类与合成输出工具，它们由别处按需注入）
 *    ③ 按 deny 规则过滤
 *    ④ REPL 模式下剔除被 REPL 包起来的原始工具（它们只能在 REPL 虚拟机内部用，不能从外面直接调）
 *    ⑤ 最后再过一遍 isEnabled()，去掉当前环境不支持的
 *  每一步都是「过滤」而不是「修改」，全程返回新数组（不可变风格）。
 */
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // Simple mode: only Bash, Read, and Edit tools
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
// simple 模式：给只需要 Bash/Read/Edit 的极简场景（比如 CI 里跑一条命令）用，
// 好处是 prompt 极短、行为可预测、没有花哨工具干扰模型。
    // --bare + REPL mode: REPL wraps Bash/Read/Edit/etc inside the VM, so
    // return REPL instead of the raw primitives. Matches the non-bare path
    // below which also hides REPL_ONLY_TOOLS when REPL is enabled.
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      if (
        feature('COORDINATOR_MODE') &&
        coordinatorModeModule?.isCoordinatorMode()
      ) {
        replSimple.push(TaskStopTool, getSendMessageTool())
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    // When coordinator mode is also active, include AgentTool and TaskStopTool
    // so the coordinator gets Task+TaskStop (via useMergedTools filtering) and
    // workers get Bash/Read/Edit (via filterToolsForAgent filtering).
    if (
      feature('COORDINATOR_MODE') &&
      coordinatorModeModule?.isCoordinatorMode()
    ) {
      simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // Get all base tools and filter out special tools that get added conditionally
// specialTools 是「由别处按需注入」的工具：MCP 资源类工具要等 MCP 连上才有意义，
// 合成输出工具是内部占位用的，都不该出现在这份静态清单里。
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
// 用 Set 做名字集合再 has 判断 ≈ Java Set.contains(O(1))；写成数组 includes 会是 O(n)。

  // Filter out tools that are denied by the deny rules
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)
// deny 过滤后的结果用 let（后面 REPL 分支还要再赋一次），所以不能是 const。

  // When REPL mode is enabled, hide primitive tools from direct use.
  // They're still accessible inside REPL via the VM context.
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool =>
      toolMatchesName(tool, REPL_TOOL_NAME),
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name),
      )
    }
  }

// 收尾再按 isEnabled() 过滤：这是「环境可用性」检查（有没有），和前面的 deny（允不允许）是两回事。
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}

/**
 * Assemble the full tool pool for a given permission context and MCP tools.
 *
 * This is the single source of truth for combining built-in tools with MCP tools.
 * Both REPL.tsx (via useMergedTools hook) and runAgent.ts (for coordinator workers)
 * use this function to ensure consistent tool pool assembly.
 *
 * The function:
 * 1. Gets built-in tools via getTools() (respects mode filtering)
 * 2. Filters MCP tools by deny rules
 * 3. Deduplicates by tool name (built-in tools take precedence)
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined, deduplicated array of built-in and MCP tools
 */
/** 【完整工具池的唯一真相来源】把内置工具与 MCP 工具合并成一个列表。
 *  入参 permissionContext：权限上下文（用于过滤内置工具）
 *  入参 mcpTools：来自 appState.mcp.tools 的 MCP 工具（外部 MCP 服务器提供的工具）
 *  返回：合并、去重、排序后的完整工具列表
 *  步骤：① getTools() 拿内置工具 ② MCP 工具同样过 deny 过滤 ③ 各自按名字排序 ④ 拼接后用 uniqBy 按 name 去重
 *  为什么要排序（这段是踩过坑的地方）：
 *    服务端在「最后一个前缀匹配的内置工具」之后放了一个全局缓存断点；
 *    如果把 MCP 工具和内置工具混在一起整体排序，某个 MCP 工具可能插进内置工具中间，
 *    导致它后面所有内置工具的缓存 key 全部失效 → prompt cache 命中率暴跌。
 *    所以做法是【两分区各自排序、内置工具保持连续前缀】，而不是一锅烩。
 *  去重的优先级：uniqBy 保留首次出现的元素，所以内置工具排前面 = 同名冲突时内置工具胜出（MCP 无法顶替内置工具）。
 *  另外注释里提醒别用 Array.prototype.toSorted：那是 Node 20+ 才有的，本项目还要支持 Node 18。
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
// MCP 工具同样要过 deny 规则：外部服务器提供的工具和内置工具一样受权限约束，不能被 deny 规则漏掉。

  // Sort each partition for prompt-cache stability, keeping built-ins as a
  // contiguous prefix. The server's claude_code_system_cache_policy places a
  // global cache breakpoint after the last prefix-matched built-in tool; a flat
  // sort would interleave MCP tools into built-ins and invalidate all downstream
  // cache keys whenever an MCP tool sorts between existing built-ins. uniqBy
  // preserves insertion order, so built-ins win on name conflict.
  // Avoid Array.toSorted (Node 20+) — we support Node 18. builtInTools is
  // readonly so copy-then-sort; allowedMcpTools is a fresh .filter() result.
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
// [...builtInTools] 先浅拷贝再 sort：builtInTools 是 readonly，直接 sort 会原地修改只读数组（类型也不允许）。
// concat 保证内置工具整体在前、MCP 在后；uniqBy(..., 'name') 按名字去重且保留先出现的那个。
    'name',
  )
}

/**
 * Get all tools including both built-in tools and MCP tools.
 *
 * This is the preferred function when you need the complete tools list for:
 * - Tool search threshold calculations (isToolSearchEnabled)
 * - Token counting that includes MCP tools
 * - Any context where MCP tools should be considered
 *
 * Use getTools() only when you specifically need just built-in tools.
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined array of built-in and MCP tools
 */
/** 轻量版合并：内置工具 + MCP 工具直接拼接，不排序、不去重。
 *  入参同 assembleToolPool。
 *  什么时候用它：只需要【估算规模】的场合——判断是否该启用 ToolSearch（工具太多就该 defer）、
 *  或者统计 token 占用。这类场景关心的是数量与顺序稳定性，不需要最终那份精修过的工具池。
 *  真正要用工具干活时请改用 assembleToolPool()。
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
// 展开成新数组返回（不可变风格）：调用方拿到的是副本，改动它不会影响这里的两份源数据。
}
