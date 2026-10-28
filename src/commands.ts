// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 【一句话定位】斜杠命令（slash command）的注册表与查询中心：把 100+ 个内置命令、
 * 用户自定义命令（~/.claude/commands/）、Skill、plugin 命令、MCP 命令汇总起来，
 * 按「来源、可用性、是否启用」过滤后，对外提供查询 / 匹配 / 缓存失效等服务。
 *
 * 【在架构中的位置】
 *   上游（谁调用本文件）：
 *     REPL.tsx（用户输入 /xxx 时）—— 解析斜杠命令并执行
 *     SkillTool / ToolSearchTool —— 把 prompt 型命令当作「技能」展示给模型调用
 *     src/utils/messageQueueManager.ts / 自动补全 —— 判断输入是否命中某个命令
 *     main.tsx（--remote 模式）—— 预过滤掉依赖本机的命令
 *     Remote Control（手机/网页端）—— 用 isBridgeSafeCommand 决定哪些命令能从桥接端执行
 *   下游（本文件依赖谁）：
 *     ./commands/* —— 每个命令自己的实现（一个目录或一个文件一个命令）
 *     ./types/command.js —— Command 类型定义（本文件只是再导出一下，方便调用方一处引入）
 *     ./skills/loadSkillsDir.js、./plugins/builtinPlugins.js、./utils/plugins/loadPluginCommands.js
 *  调用链（用户在输入框敲 /compact 回车之后）：
 *     输入 → 判定是斜杠命令 → getCommands(cwd)（加载 + 过滤）
 *       → findCommand(name, commands)（按名字/别名匹配）
 *       → 按命令类型分派：
 *         type='prompt'    → 展开成一段 prompt 交给模型（这就是 Skill 的本质）
 *         type='local'     → 本地执行一段逻辑，输出文本
 *         type='local-jsx' → 本地渲染一块 React UI（如 /model 的选择面板）
 *
 * 【本文件包含什么】
 *   COMMANDS（私有）                  —— 内置命令大列表（用 memoize 包住，延迟到首次调用才构造）
 *   INTERNAL_ONLY_COMMANDS            —— 只在内部构建里出现的命令（外部构建会被消除）
 *   builtInCommandNames               —— 所有内置命令的【名字 + 别名】集合（用于快速判定「是不是内置命令」）
 *   getCommands(cwd)                  —— 主入口：所有来源的命令汇总 + 可用性过滤 + 动态 skill 插入
 *   loadAllCommands(cwd)（私有）      —— 聚合 skills / plugin / workflow / 内置四类来源（昂贵，故 memoize）
 *   getSkills(cwd)（私有）            —— 加载 skill 目录、plugin skill、内置 skill（各类失败都降级为空数组）
 *   meetsAvailabilityRequirement(cmd) —— 判断命令是否满足账号/供应商要求（如仅限 claude.ai 订阅用户）
 *   clearCommandMemoizationCaches / clearCommandsCache —— 失效各类缓存（新增 skill 后要调用）
 *   getMcpSkillCommands / getSkillToolCommands / getSlashCommandToolSkills —— 给 SkillTool 用的三类技能视图
 *   REMOTE_SAFE_COMMANDS / BRIDGE_SAFE_COMMANDS / isBridgeSafeCommand / filterCommandsForRemoteMode
 *                                     —— 远程模式与手机桥接模式下的命令安全白名单
 *   findCommand / hasCommand / getCommand —— 按名字或别名查找命令（找不到时 getCommand 抛错）
 *   formatDescriptionWithSource(cmd)  —— 给命令描述加上来源标注（如 (plugin)、(project)），供 UI 展示
 *
 * 【TS 语法速查】（针对本文件实际出现的写法，Java 工程师对照看）
 *   1. `memoize(async (cwd: string) => {...})` —— lodash 记忆化，缓存的是 Promise 本身。
 *      ≈ Java 用 ConcurrentHashMap + computeIfAbsent 缓存 CompletableFuture，保证并发只加载一次。
 *   2. `feature('XXX') ? require(...) : null` —— 编译期 #ifdef，不是运行时 if：
 *      Bun 打包时会求值并把 false 分支整段删掉（死代码消除）。详见 tools.ts 文件头。
 *   3. `...(cond ? [x] : [])` 条件展开：条件成立摊平进一个元素，不成立摊平进空数组。本文件大量使用。
 *   4. `const [a, b] = await Promise.all([f1(), f2()])` —— 并发等待 + 数组解构赋值。
 *      Promise.all ≈ CompletableFuture.allOf。
 *   5. `.catch(err => { ...; return [] })` —— 单个来源失败时降级成空数组：
 *      一个 skill 目录写坏了不能让整个命令系统挂掉（对应 Java 里 try-catch 返回默认值）。
 *   6. `new Set(...)` + `.has()` ≈ Java HashSet：O(1) 查找，本文件用来做名字去重与白名单判断。
 *   7. `flatMap(_ => [_.name, ...(_.aliases ?? [])])` —— flatMap ≈ Java Stream.flatMap（把一组数组摊平成一个数组）。
 *   8. `(c): c is Command => c !== null` —— 【类型谓词】≈ Java instanceof 模式匹配：
 *      返回 true 时编译器把 c 收窄成 Command，于是 filter 之后的数组元素类型变干净。
 *   9. `const _exhaustive: never = a` —— 【穷尽性检查】的惯用写法：
 *      如果将来给联合类型加了新分支却忘了在 switch 里处理，把值赋给 never 类型就会编译报错。
 *      ≈ Java switch 表达式要求覆盖所有 enum 值，但这里靠类型系统而不是语法强制。
 *  10. `cmd.pluginInfo?.pluginManifest.name` —— 可选链：中间任意一环是 null/undefined，整段表达式就是 undefined，
 *      不会抛 NPE（Java 里要写一堆 if 判空，或用 Optional 链式调用）。
 *  11. `` `${a} (${b})` `` 模板字符串 ≈ Java 文本块 + String.format 的合体，用反引号与 ${} 插值。
 *  12. `readonly Command[]` ≈ 只读 List：函数不该修改入参数组，需要修改时先 [...arr] 拷贝。
 *  13. `export type { A, B } from './x.js'` 与 `export { f } from './x.js'` 是再导出（re-export），
 *      本文件只是转发，方便调用方从一处引入所有命令相关类型与函数。
 *  14. 对象字面量里的方法简写 `async getPromptForCommand(args, context) { ... }` ≈ 匿名内部类/匿名实现里覆盖方法。
 */
import addDir from './commands/add-dir/index.js'
import autofixPr from './commands/autofix-pr/index.js'
import backfillSessions from './commands/backfill-sessions/index.js'
import btw from './commands/btw/index.js'
import goodClaude from './commands/good-claude/index.js'
import issue from './commands/issue/index.js'
import feedback from './commands/feedback/index.js'
import clear from './commands/clear/index.js'
import color from './commands/color/index.js'
import commit from './commands/commit.js'
import copy from './commands/copy/index.js'
import desktop from './commands/desktop/index.js'
import commitPushPr from './commands/commit-push-pr.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import { context, contextNonInteractive } from './commands/context/index.js'
import cost from './commands/cost/index.js'
import diff from './commands/diff/index.js'
import ctx_viz from './commands/ctx_viz/index.js'
import doctor from './commands/doctor/index.js'
import memory from './commands/memory/index.js'
import help from './commands/help/index.js'
import ide from './commands/ide/index.js'
import init from './commands/init.js'
import initVerifiers from './commands/init-verifiers.js'
import keybindings from './commands/keybindings/index.js'
import login from './commands/login/index.js'
import logout from './commands/logout/index.js'
import installGitHubApp from './commands/install-github-app/index.js'
import installSlackApp from './commands/install-slack-app/index.js'
import breakCache from './commands/break-cache/index.js'
import mcp from './commands/mcp/index.js'
import mobile from './commands/mobile/index.js'
import onboarding from './commands/onboarding/index.js'
import pr_comments from './commands/pr_comments/index.js'
import releaseNotes from './commands/release-notes/index.js'
import rename from './commands/rename/index.js'
import resume from './commands/resume/index.js'
import review, { ultrareview } from './commands/review.js'
import session from './commands/session/index.js'
import share from './commands/share/index.js'
import skills from './commands/skills/index.js'
import status from './commands/status/index.js'
import tasks from './commands/tasks/index.js'
import teleport from './commands/teleport/index.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const agentsPlatform =
  process.env.USER_TYPE === 'ant'
    ? require('./commands/agents-platform/index.js').default
    : null
/* eslint-enable @typescript-eslint/no-require-imports */
import securityReview from './commands/security-review.js'
import bughunter from './commands/bughunter/index.js'
import terminalSetup from './commands/terminalSetup/index.js'
import usage from './commands/usage/index.js'
import theme from './commands/theme/index.js'
import vim from './commands/vim/index.js'
import { feature } from 'bun:bundle'
// Dead code elimination: conditional imports
// ── 条件加载区：按 feature() 编译期开关决定是否 require 某个命令模块 ──
// 这些命令（proactive、bridge、voice、workflows ...）在开源构建里根本不存在，打包时会被整段删除。
/* eslint-disable @typescript-eslint/no-require-imports */
const proactive =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./commands/proactive.js').default
    : null
const briefCommand =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? require('./commands/brief.js').default
    : null
const assistantCommand = feature('KAIROS')
  ? require('./commands/assistant/index.js').default
  : null
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default
  : null
const remoteControlServerCommand =
  feature('DAEMON') && feature('BRIDGE_MODE')
    ? require('./commands/remoteControlServer/index.js').default
    : null
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
const forceSnip = feature('HISTORY_SNIP')
  ? require('./commands/force-snip.js').default
  : null
const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./commands/workflows/index.js') as typeof import('./commands/workflows/index.js')
    ).default
  : null
const webCmd = feature('CCR_REMOTE_SETUP')
  ? (
      require('./commands/remote-setup/index.js') as typeof import('./commands/remote-setup/index.js')
    ).default
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (
      require('./services/skillSearch/localSearch.js') as typeof import('./services/skillSearch/localSearch.js')
    ).clearSkillIndexCache
  : null
const subscribePr = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./commands/subscribe-pr.js').default
  : null
const ultraplan = feature('ULTRAPLAN')
  ? require('./commands/ultraplan.js').default
  : null
const torch = feature('TORCH') ? require('./commands/torch.js').default : null
const peersCmd = feature('UDS_INBOX')
  ? (
      require('./commands/peers/index.js') as typeof import('./commands/peers/index.js')
    ).default
  : null
const forkCmd = feature('FORK_SUBAGENT')
  ? (
      require('./commands/fork/index.js') as typeof import('./commands/fork/index.js')
    ).default
  : null
const buddy = feature('BUDDY')
  ? (
      require('./commands/buddy/index.js') as typeof import('./commands/buddy/index.js')
    ).default
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import thinkback from './commands/thinkback/index.js'
import thinkbackPlay from './commands/thinkback-play/index.js'
import permissions from './commands/permissions/index.js'
import plan from './commands/plan/index.js'
import fast from './commands/fast/index.js'
import passes from './commands/passes/index.js'
import privacySettings from './commands/privacy-settings/index.js'
import hooks from './commands/hooks/index.js'
import files from './commands/files/index.js'
import branch from './commands/branch/index.js'
import agents from './commands/agents/index.js'
import plugin from './commands/plugin/index.js'
import reloadPlugins from './commands/reload-plugins/index.js'
import rewind from './commands/rewind/index.js'
import heapDump from './commands/heapdump/index.js'
import mockLimits from './commands/mock-limits/index.js'
import bridgeKick from './commands/bridge-kick.js'
import version from './commands/version.js'
import summary from './commands/summary/index.js'
import {
  resetLimits,
  resetLimitsNonInteractive,
} from './commands/reset-limits/index.js'
import antTrace from './commands/ant-trace/index.js'
import perfIssue from './commands/perf-issue/index.js'
import sandboxToggle from './commands/sandbox-toggle/index.js'
import chrome from './commands/chrome/index.js'
import stickers from './commands/stickers/index.js'
import advisor from './commands/advisor.js'
import { logError } from './utils/log.js'
import { toError } from './utils/errors.js'
import { logForDebugging } from './utils/debug.js'
import {
  getSkillDirCommands,
  clearSkillCaches,
  getDynamicSkills,
} from './skills/loadSkillsDir.js'
import { getBundledSkills } from './skills/bundledSkills.js'
import { getBuiltinPluginSkillCommands } from './plugins/builtinPlugins.js'
import {
  getPluginCommands,
  clearPluginCommandCache,
  getPluginSkills,
  clearPluginSkillsCache,
} from './utils/plugins/loadPluginCommands.js'
import memoize from 'lodash-es/memoize.js'
import { isUsing3PServices, isClaudeAISubscriber } from './utils/auth.js'
import { isFirstPartyAnthropicBaseUrl } from './utils/model/providers.js'
import env from './commands/env/index.js'
import exit from './commands/exit/index.js'
import exportCommand from './commands/export/index.js'
import model from './commands/model/index.js'
import tag from './commands/tag/index.js'
import outputStyle from './commands/output-style/index.js'
import remoteEnv from './commands/remote-env/index.js'
import upgrade from './commands/upgrade/index.js'
import {
  extraUsage,
  extraUsageNonInteractive,
} from './commands/extra-usage/index.js'
import rateLimitOptions from './commands/rate-limit-options/index.js'
import statusline from './commands/statusline.js'
import effort from './commands/effort/index.js'
import stats from './commands/stats/index.js'
// insights.ts is 113KB (3200 lines, includes diffLines/html rendering). Lazy
// shim defers the heavy module until /insights is actually invoked.
// /insights 的模块有 113KB（3200 行，内含 diffLines 与 html 渲染），太重了。
// 这里做一个「惰性壳」：先把命令登记进来（占个位），真正被调用时才动态 import 真身。
// 这是典型的懒加载优化——启动成本换首次调用时的一次异步加载。
const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: 'Generate a report analyzing your Claude Code sessions',
  contentLength: 0,
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  async getPromptForCommand(args, context) {
// 动态 import() ≈ Java 的 Class.forName 反射加载：只在真正需要时才把模块拉进内存。
// 下面那句 if (real.type !== 'prompt') throw 是给类型系统看的：
// 编译器无法知道动态加载回来的 real 是什么类型，这里用运行时检查把它收窄成 prompt 型命令（否则后面无法调 getPromptForCommand）。
    const real = (await import('./commands/insights.js')).default
    if (real.type !== 'prompt') throw new Error('unreachable')
    return real.getPromptForCommand(args, context)
  },
}
import oauthRefresh from './commands/oauth-refresh/index.js'
import debugToolCall from './commands/debug-tool-call/index.js'
import { getSettingSourceName } from './utils/settings/constants.js'
import {
  type Command,
  getCommandName,
  isCommandEnabled,
} from './types/command.js'

// Re-export types from the centralized location
export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from './types/command.js'
export { getCommandName, isCommandEnabled } from './types/command.js'

// Commands that get eliminated from the external build
// 只在内部构建里存在的命令（多为内部工具/调试用）。外部构建里这些模块本身就被消除了，
// 所以数组里会出现 null / undefined 元素——末尾的 .filter(Boolean) 就是把它们清掉。
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions,
  breakCache,
  bughunter,
  commit,
  commitPushPr,
  ctx_viz,
  goodClaude,
  issue,
  initVerifiers,
  ...(forceSnip ? [forceSnip] : []),
  mockLimits,
  bridgeKick,
  version,
  ...(ultraplan ? [ultraplan] : []),
  ...(subscribePr ? [subscribePr] : []),
  resetLimits,
  resetLimitsNonInteractive,
  onboarding,
  share,
  summary,
  teleport,
  antTrace,
  perfIssue,
  env,
  oauthRefresh,
  debugToolCall,
  agentsPlatform,
  autofixPr,
].filter(Boolean)
// `.filter(Boolean)` 是去掉数组里所有 falsy 元素（null / undefined / false / '' / 0）的惯用写法，
// 这里用来剔除条件加载失败留下的 null 占位。

// Declared as a function so that we don't run this until getCommands is called,
// since underlying functions read from config, which can't be read at module initialization time
/** 内置命令的完整清单。刻意做成【函数 + memoize】而不是顶层常量数组：
 *  因为底层命令在构造时要读配置（settings / auth 状态），而模块初始化阶段还不能读配置——
 *  提前构造会在启动时炸掉或读到空配置。包成函数后，只有真正第一次调用 getCommands() 时才构造。
 *  数组里同样用 `...(cond ? [cmd] : [])` 做条件装配：
 *    - feature 开关控制的命令（bridge / voice / workflows / fork / buddy ...）
 *    - 只在第三方服务未启用时才出现的 login/logout（注意 login 是【调用】login() 得到的命令对象）
 *    - 内部构建才有的那一整组 INTERNAL_ONLY_COMMANDS
 *  返回 Command[]（只读语义，调用方不应修改）
 */
const COMMANDS = memoize((): Command[] => [
  addDir,
  advisor,
  agents,
  branch,
  btw,
  chrome,
  clear,
  color,
  compact,
  config,
  copy,
  desktop,
  context,
  contextNonInteractive,
  cost,
  diff,
  doctor,
  effort,
  exit,
  fast,
  files,
  heapDump,
  help,
  ide,
  init,
  keybindings,
  installGitHubApp,
  installSlackApp,
  mcp,
  memory,
  mobile,
  model,
  outputStyle,
  remoteEnv,
  plugin,
  pr_comments,
  releaseNotes,
  reloadPlugins,
  rename,
  resume,
  session,
  skills,
  stats,
  status,
  statusline,
  stickers,
  tag,
  theme,
  feedback,
  review,
  ultrareview,
  rewind,
  securityReview,
  terminalSetup,
  upgrade,
  extraUsage,
  extraUsageNonInteractive,
  rateLimitOptions,
  usage,
  usageReport,
  vim,
  ...(webCmd ? [webCmd] : []),
  ...(forkCmd ? [forkCmd] : []),
  ...(buddy ? [buddy] : []),
  ...(proactive ? [proactive] : []),
  ...(briefCommand ? [briefCommand] : []),
  ...(assistantCommand ? [assistantCommand] : []),
  ...(bridge ? [bridge] : []),
  ...(remoteControlServerCommand ? [remoteControlServerCommand] : []),
  ...(voiceCommand ? [voiceCommand] : []),
  thinkback,
  thinkbackPlay,
  permissions,
  plan,
  privacySettings,
  hooks,
  exportCommand,
  sandboxToggle,
  ...(!isUsing3PServices() ? [logout, login()] : []),
  passes,
  ...(peersCmd ? [peersCmd] : []),
  tasks,
  ...(workflowsCmd ? [workflowsCmd] : []),
  ...(torch ? [torch] : []),
  ...(process.env.USER_TYPE === 'ant' && !process.env.IS_DEMO
    ? INTERNAL_ONLY_COMMANDS
    : []),
])

/** 所有内置命令的【名字 + 别名】集合，用于快速判断「某个字符串是不是内置命令」。
 *  为什么要用 Set：命令匹配在输入时高频发生，Set.has 是 O(1)，而数组 includes 是 O(n)。
 *  `_.aliases ?? []` 处理没有别名的情况（?? 只在 null/undefined 时替换，空数组会原样保留）。
 *  同样用 memoize 缓存：内容不会变，没必要每次重算。
 */
export const builtInCommandNames = memoize(
  (): Set<string> =>
    new Set(COMMANDS().flatMap(_ => [_.name, ...(_.aliases ?? [])])),
// flatMap 把「每个命令 → [主名, ...别名]」这一组小数组摊平成一个大数组，再交给 Set 去重。
)

/** 加载四个来源的 skill（技能）类命令：
 *    skillDirCommands    —— 项目/用户 .claude/skills 目录里的
 *    pluginSkills        —— 已安装 plugin 提供的
 *    bundledSkills       —— 随程序打包内置的（启动时同步注册，不必 await）
 *    builtinPluginSkills —— 内置 plugin 提供的
 *  入参 cwd：当前工作目录（skill 是按目录发现的，所以结果依赖 cwd）
 *  返回：四类命令分门别类的对象
 *  关键设计——【单点失败不影响整体】：
 *    skill 目录和 plugin skill 的加载都各自 .catch 成空数组，最外层还有一层 try/catch 兜底。
 *    理由很实际：skill 是用户自己写的文本，格式写坏是常态；不能因为一个坏 skill 让整个 CLI 起不来。
 */
async function getSkills(cwd: string): Promise<{
  skillDirCommands: Command[]
  pluginSkills: Command[]
  bundledSkills: Command[]
  builtinPluginSkills: Command[]
}> {
  try {
    const [skillDirCommands, pluginSkills] = await Promise.all([
      getSkillDirCommands(cwd).catch(err => {
        logError(toError(err))
        logForDebugging(
          'Skill directory commands failed to load, continuing without them',
        )
        return []
      }),
      getPluginSkills().catch(err => {
        logError(toError(err))
        logForDebugging('Plugin skills failed to load, continuing without them')
        return []
      }),
    ])
// 两个来源并发加载；任何一个挂了都降级成空数组（记日志但不抛出）——这是有意的容错取舍。
    // Bundled skills are registered synchronously at startup
    const bundledSkills = getBundledSkills()
    // Built-in plugin skills come from enabled built-in plugins
    const builtinPluginSkills = getBuiltinPluginSkillCommands()
    logForDebugging(
      `getSkills returning: ${skillDirCommands.length} skill dir commands, ${pluginSkills.length} plugin skills, ${bundledSkills.length} bundled skills, ${builtinPluginSkills.length} builtin plugin skills`,
    )
    return {
      skillDirCommands,
      pluginSkills,
      bundledSkills,
      builtinPluginSkills,
    }
// 最外层再兜一层：虽然 Promise 级别已经 catch 过了，仍防御性地保证绝不把异常抛给调用方。
  } catch (err) {
    // This should never happen since we catch at the Promise level, but defensive
    logError(toError(err))
    logForDebugging('Unexpected error in getSkills, returning empty')
    return {
      skillDirCommands: [],
      pluginSkills: [],
      bundledSkills: [],
      builtinPluginSkills: [],
    }
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
// workflow 命令也走「条件加载」：只有 WORKFLOW_SCRIPTS 开关打开时才 require，
// 注意这里 require 出来的是【函数】getWorkflowCommands，不是命令数组本身。
const getWorkflowCommands = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./tools/WorkflowTool/createWorkflowCommand.js') as typeof import('./tools/WorkflowTool/createWorkflowCommand.js')
    ).getWorkflowCommands
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Filters commands by their declared `availability` (auth/provider requirement).
 * Commands without `availability` are treated as universal.
 * This runs before `isEnabled()` so that provider-gated commands are hidden
 * regardless of feature-flag state.
 *
 * Not memoized — auth state can change mid-session (e.g. after /login),
 * so this must be re-evaluated on every getCommands() call.
 */
/** 判断命令是否满足它声明的 availability（账号/供应商）要求。
 *  入参 cmd：待判断的命令
 *  返回 true 表示当前用户可以用它
 *  规则：没有声明 availability 的命令视为「人人都可用」；声明了则必须命中其中一条才可用。
 *  两种取值：
 *    'claude-ai' —— 必须是 claude.ai 订阅用户
 *    'console'   —— 必须是直接使用官方 API 的客户（非第三方云服务 Bedrock/Vertex/Foundry，
 *                   也非走自定义网关的用户，后者会把 ANTHROPIC_BASE_URL 指到别处）
 *  为什么【不做 memoize】（见上方英文注释）：登录状态会在会话中途变化（比如执行 /login），
 *  缓存住就会出现「明明登录了但命令还是不出现」的怪现象，所以每次 getCommands() 都重新算。
 *  执行顺序上它早于 isEnabled()：供应商门禁与功能开关无关，先验供应商再验开关。
 */
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true
// 没声明 availability = 通用命令，直接放行。
  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        // Console API key user = direct 1P API customer (not 3P, not claude.ai).
        // Excludes 3P (Bedrock/Vertex/Foundry) who don't set ANTHROPIC_BASE_URL
        // and gateway users who proxy through a custom base URL.
        if (
          !isClaudeAISubscriber() &&
          !isUsing3PServices() &&
          isFirstPartyAnthropicBaseUrl()
        )
          return true
        break
      default: {
        const _exhaustive: never = a
// `const _exhaustive: never = a` 是 TS 里的【穷尽性检查】惯用法：
// 如果将来 availability 联合类型新增了一个取值而这里忘了处理，把该值赋给 never 会直接编译报错。
// 相当于让编译器替你守住「switch 必须覆盖所有分支」这条纪律（Java 里靠 switch 表达式的语法强制）。
// `void _exhaustive` 只是为了让「声明了却没使用」的检查闭嘴。
        void _exhaustive
        break
      }
    }
  }
  return false
}

/**
 * Loads all command sources (skills, plugins, workflows). Memoized by cwd
 * because loading is expensive (disk I/O, dynamic imports).
 */
/** 汇总【所有来源】的命令：skill / plugin / workflow / 内置。
 *  入参 cwd：当前工作目录
 *  返回：合并后的命令数组（顺序见下）
 *  为什么用 memoize：加载涉及磁盘 I/O 与动态 import，很贵；而同一 cwd 下结果稳定。
 *  注意 memoize 的键是 cwd——换目录会重新加载（不同项目有不同的 skill）。
 *  数组顺序是有讲究的：内置技能 → 内置 plugin 技能 → 目录 skill → workflow → plugin 命令 → plugin 技能 → 内置命令。
 *  越靠前的越「用户自定义」，越靠后的越「系统自带」——展示与匹配时的优先级由此体现。
 */
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])

  return [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...workflowCommands,
    ...pluginCommands,
    ...pluginSkills,
    ...COMMANDS(),
// 内置命令放在最后：前面几类都是用户/项目自定义的，匹配与展示时应当优先于系统自带命令。
  ]
})

/**
 * Returns commands available to the current user. The expensive loading is
 * memoized, but availability and isEnabled checks run fresh every call so
 * auth changes (e.g. /login) take effect immediately.
 */
/** 【主入口】拿到当前用户可用的全部命令。
 *  入参 cwd：当前工作目录
 *  返回：过滤后并按规则排好序的命令数组
 *  步骤：
 *    ① loadAllCommands(cwd) 加载所有来源（这一步被 memoize 缓存，昂贵）
 *    ② 取「运行期间动态发现的 skill」（例如读文件时发现了新的 skill 目录）
 *    ③ 先用 meetsAvailabilityRequirement（账号门禁）再用 isCommandEnabled（开关）双重过滤
 *    ④ 把动态 skill 中「尚未出现过的」追加进去（按名字去重，避免重复项）
 *    ⑤ 插入位置有讲究：动态 skill 要插在【plugin 技能之后、内置命令之前】，
 *       既保证用户自定义内容优先于内置，又不破坏前面几类的既有顺序
 *  设计要点：【加载结果缓存、但可用性判断每次重算】——
 *  这样 /login 之后命令列表能立刻变化，而不必重启会话。
 */
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)

  // Get dynamic skills discovered during file operations
  const dynamicSkills = getDynamicSkills()

  // Build base commands without dynamic skills
  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )
// 两道过滤：先过「账号/供应商门禁」，再过「功能开关」。顺序不能颠倒（门禁是硬约束）。

  if (dynamicSkills.length === 0) {
    return baseCommands
  }
// 快路径：没有动态 skill 时直接返回，省掉后面的去重与插入计算。

  // Dedupe dynamic skills - only add if not already present
  const baseCommandNames = new Set(baseCommands.map(c => c.name))
  const uniqueDynamicSkills = dynamicSkills.filter(
    s =>
      !baseCommandNames.has(s.name) &&
      meetsAvailabilityRequirement(s) &&
      isCommandEnabled(s),
  )

  if (uniqueDynamicSkills.length === 0) {
    return baseCommands
  }

  // Insert dynamic skills after plugin skills but before built-in commands
  const builtInNames = new Set(COMMANDS().map(c => c.name))
  const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))
// findIndex 找「第一个内置命令」的位置，作为动态 skill 的插入点；找不到（返回 -1）就整体追加到末尾。
// slice(0, insertIndex) + 新内容 + slice(insertIndex) 是经典的「在指定位置插入」不可变写法。

  if (insertIndex === -1) {
    return [...baseCommands, ...uniqueDynamicSkills]
  }

  return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
  ]
}

/**
 * Clears only the memoization caches for commands, WITHOUT clearing skill caches.
 * Use this when dynamic skills are added to invalidate cached command lists.
 */
/** 只清【命令列表】相关的记忆化缓存，不动 skill 自身的缓存。
 *  什么时候用：运行期新增了动态 skill，需要让命令列表重新计算，但 skill 内容本身没变（不必重新读盘）。
 *  步骤：清 loadAllCommands / getSkillToolCommands / getSlashCommandToolSkills 三处 cache，
 *  再显式清 skillSearch 的索引缓存。
 *  最后一步为什么必须显式做（踩过坑）：skillSearch 里的 getSkillIndex 是搭在 getCommands 之上的【外层】缓存，
 *  lodash memoize 命中后根本不会走到被清掉的内层函数——只清内层等于什么都没发生。
 *  `cache?.clear?.()` 的双重可选：memoize 包出来的函数才有 .cache，且它上面的 clear 也可能不存在。
 */
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  // getSkillIndex in skillSearch/localSearch.ts is a separate memoization layer
  // built ON TOP of getSkillToolCommands/getCommands. Clearing only the inner
  // caches is a no-op for the outer — lodash memoize returns the cached result
  // without ever reaching the cleared inners. Must clear it explicitly.
  clearSkillIndexCache?.()
// 外层缓存必须单独清：否则它直接返回旧结果，内层的清理完全不会被触发。
}

/** 彻底清缓存：命令列表 + plugin 命令 + plugin 技能 + skill 目录缓存，全清。
 *  比 clearCommandMemoizationCaches() 更重，用于 skill/plugin 内容本身发生变化（比如用户刚装了个 plugin）。
 */
export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearSkillCaches()
}

/**
 * Filter AppState.mcp.commands to MCP-provided skills (prompt-type,
 * model-invocable, loaded from MCP). These live outside getCommands() so
 * callers that need MCP skills in their skill index thread them through
 * separately.
 */
/** 从 AppState.mcp.commands 里筛出「MCP 提供的、模型可调用的 skill」。
 *  入参 mcpCommands：MCP 服务器上报的命令列表
 *  返回：符合条件的命令（未开启 MCP_SKILLS 开关时返回空数组）
 *  三个条件：type 必须是 prompt、来源必须是 mcp、且没有被标记 disableModelInvocation。
 *  为什么不并入 getCommands()：MCP 命令存在 AppState 里（连接状态会变），
 *  而 getCommands() 是按 cwd 缓存的；放到一起会让缓存正确性变复杂，所以由调用方单独穿针引线。
 */
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  if (feature('MCP_SKILLS')) {
    return mcpCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        cmd.loadedFrom === 'mcp' &&
        !cmd.disableModelInvocation,
    )
  }
  return []
}

// SkillTool shows ALL prompt-based commands that the model can invoke
// This includes both skills (from /skills/) and commands (from /commands/)
/** 给【SkillTool】用：列出所有「模型可以主动调用」的 prompt 型命令。
 *  入参 cwd：当前工作目录
 *  返回：过滤后的命令数组（同样 memoize 缓存）
 *  过滤条件解读：
 *    - type === 'prompt'：只有展开成 prompt 的命令才算「技能」
 *    - !disableModelInvocation：命令自己声明了不许模型调用的要排除
 *    - source !== 'builtin'：纯内置系统命令不算（它们是给人敲的，不是给模型调的）
 *    - 最后一组的「或」条件：来自 /skills/ 目录、内置技能、旧版 /commands/ 的都无条件收录
 *      （它们缺 frontmatter 时会用第一行自动推导描述）；而 plugin / MCP 命令必须显式写了
 *      description 或 whenToUse 才会出现在列表里——避免把一堆没说明文档的外部命令灌给模型。
 */
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        !cmd.disableModelInvocation &&
        cmd.source !== 'builtin' &&
        // Always include skills from /skills/ dirs, bundled skills, and legacy /commands/ entries
        // (they all get an auto-derived description from the first line if frontmatter is missing).
        // Plugin/MCP commands still require an explicit description to appear in the listing.
        (cmd.loadedFrom === 'bundled' ||
          cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.hasUserSpecifiedDescription ||
          cmd.whenToUse),
    )
  },
)

// Filters commands to include only skills. Skills are commands that provide
// specialized capabilities for the model to use. They are identified by
// loadedFrom being 'skills', 'plugin', or 'bundled', or having disableModelInvocation set.
/** 给【SlashCommand 技能索引】用：筛出「是技能」的那些命令，供模型检索技能时使用。
 *  与 getSkillToolCommands 的区别：这里额外接受 disableModelInvocation 的命令
 *  （它们虽然不许模型直接调用，但仍然属于「技能」这个分类，要出现在技能的检索索引里）。
 *  入参 cwd：当前工作目录
 *  返回：技能命令数组；加载失败时返回空数组而不是抛出
 *  失败降级为空数组是有意为之：技能属于增强能力，加载失败只该损失功能，不该让整个系统崩溃。
 */
export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    try {
      const allCommands = await getCommands(cwd)
      return allCommands.filter(
        cmd =>
          cmd.type === 'prompt' &&
          cmd.source !== 'builtin' &&
          (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
          (cmd.loadedFrom === 'skills' ||
            cmd.loadedFrom === 'plugin' ||
            cmd.loadedFrom === 'bundled' ||
            cmd.disableModelInvocation),
      )
    } catch (error) {
      logError(toError(error))
      // Return empty array rather than throwing - skills are non-critical
      // This prevents skill loading failures from breaking the entire system
      logForDebugging('Returning empty skills array due to load failure')
      return []
// 加载失败只记日志、返回空数组：技能是非关键能力，不能因为它坏了导致命令系统整体不可用。
    }
  },
)

/**
 * Commands that are safe to use in remote mode (--remote).
 * These only affect local TUI state and don't depend on local filesystem,
 * git, shell, IDE, MCP, or other local execution context.
 *
 * Used in two places:
 * 1. Pre-filtering commands in main.tsx before REPL renders (prevents race with CCR init)
 * 2. Preserving local-only commands in REPL's handleRemoteInit after CCR filters
 */
// 远程模式（--remote）下仍然安全的命令白名单：
// 判据是「只影响本地 TUI 状态，不依赖本机文件系统 / git / shell / IDE / MCP」。
// 用 Set<Command> 存的是【命令对象本身】而不是名字——同一份对象引用做身份比较，比字符串更可靠。
export const REMOTE_SAFE_COMMANDS: Set<Command> = new Set([
  session, // Shows QR code / URL for remote session
  exit, // Exit the TUI
  clear, // Clear screen
  help, // Show help
  theme, // Change terminal theme
  color, // Change agent color
  vim, // Toggle vim mode
  cost, // Show session cost (local cost tracking)
  usage, // Show usage info
  copy, // Copy last message
  btw, // Quick note
  feedback, // Send feedback
  plan, // Plan mode toggle
  keybindings, // Keybinding management
  statusline, // Status line toggle
  stickers, // Stickers
  mobile, // Mobile QR code
])

/**
 * Builtin commands of type 'local' that ARE safe to execute when received
 * over the Remote Control bridge. These produce text output that streams
 * back to the mobile/web client and have no terminal-only side effects.
 *
 * 'local-jsx' commands are blocked by type (they render Ink UI) and
 * 'prompt' commands are allowed by type (they expand to text sent to the
 * model) — this set only gates 'local' commands.
 *
 * When adding a new 'local' command that should work from mobile, add it
 * here. Default is blocked.
 */
// 手机/网页端通过 Remote Control 桥接发来的命令白名单（只针对 type='local' 的命令）：
//   local-jsx  一律禁止（它要渲染终端 Ink UI，手机上没有）
//   prompt     一律允许（展开成文字发给模型，天然安全）
//   local      必须在本白名单里才允许，默认禁止（见下面的 isBridgeSafeCommand）
export const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set(
  [
    compact, // Shrink context — useful mid-session from a phone
    clear, // Wipe transcript
    cost, // Show session cost
    summary, // Summarize conversation
    releaseNotes, // Show changelog
    files, // List tracked files
  ].filter((c): c is Command => c !== null),
// `(c): c is Command => c !== null` 是类型谓词：filter 之后数组元素类型从 Command|null 收窄成 Command。
// 与上面的 .filter(Boolean) 目的一样（剔除条件加载留下的 null），但这个写法还顺手把类型收窄了。
)

/**
 * Whether a slash command is safe to execute when its input arrived over the
 * Remote Control bridge (mobile/web client).
 *
 * PR #19134 blanket-blocked all slash commands from bridge inbound because
 * `/model` from iOS was popping the local Ink picker. This predicate relaxes
 * that with an explicit allowlist: 'prompt' commands (skills) expand to text
 * and are safe by construction; 'local' commands need an explicit opt-in via
 * BRIDGE_SAFE_COMMANDS; 'local-jsx' commands render Ink UI and stay blocked.
 */
/** 判断某个命令能否安全地在「桥接（手机/网页）」场景下执行。
 *  入参 cmd：待判断的命令
 *  返回 true 表示允许执行
 *  三条规则：local-jsx 一律否（要渲染终端 UI）；prompt 一律是（展开成文本发给模型）；
 *  local 必须在白名单 BRIDGE_SAFE_COMMANDS 里。
 *  背景（见上方英文注释）：PR #19134 曾经【一刀切】禁止所有来自桥接的斜杠命令，
 *  因为 iOS 上敲 /model 会弹出本地终端的选择面板。这里改成显式白名单，把安全的放开。
 *  默认拒绝（default deny）是这类安全判断的正确姿势：新命令默认不可用，要开通得显式登记。
 */
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return false
  if (cmd.type === 'prompt') return true
  return BRIDGE_SAFE_COMMANDS.has(cmd)
}

/**
 * Filter commands to only include those safe for remote mode.
 * Used to pre-filter commands when rendering the REPL in --remote mode,
 * preventing local-only commands from being briefly available before
 * the CCR init message arrives.
 */
/** 按远程模式白名单过滤命令列表。
 *  用途：在 --remote 模式下，趁 CCR 初始化消息到达【之前】就把依赖本机的命令摘掉，
 *  避免它们在那一小段时间里短暂可用（竞态窗口）。
 */
export function filterCommandsForRemoteMode(commands: Command[]): Command[] {
  return commands.filter(cmd => REMOTE_SAFE_COMMANDS.has(cmd))
}

/** 按名字查找命令，三种匹配任一命中即可：主名、getCommandName() 规范化后的名字、别名。
 *  入参 commandName：用户输入的命令名（不含斜杠）
 *  入参 commands：待搜索的命令列表
 *  返回：找到的命令，找不到返回 undefined（注意返回类型写了 `Command | undefined`）
 *  `_` 只是参数名的简写（本文件惯用），等价于写成 cmd。
 */
export function findCommand(
  commandName: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    _ =>
      _.name === commandName ||
      getCommandName(_) === commandName ||
      _.aliases?.includes(commandName),
  )
}

/** 判断某个命令是否存在（findCommand 的布尔版，避免调用方自己判 undefined）。 */
export function hasCommand(commandName: string, commands: Command[]): boolean {
  return findCommand(commandName, commands) !== undefined
}

/** 取命令，找不到就【抛错】，且错误信息里带上所有可用命令的名字（含别名）——方便用户发现拼写错误。
 *  入参同 findCommand；返回 Command（保证非空）。
 *  与 findCommand 的分工：findCommand 用于「可能没有」的试探场景，getCommand 用于「必须有」的强依赖场景。
 */
export function getCommand(commandName: string, commands: Command[]): Command {
  const command = findCommand(commandName, commands)
  if (!command) {
    throw ReferenceError(
// 注意这里是 `throw ReferenceError(...)` 而不是 `new ReferenceError(...)`：
// JS 的内置错误构造函数允许省略 new（内部会自行处理），两种写法效果相同，这是代码库里的一处风格遗留。
      `Command ${commandName} not found. Available commands: ${commands
        .map(_ => {
          const name = getCommandName(_)
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}`,
    )
  }

  return command
}

/**
 * Formats a command's description with its source annotation for user-facing UI.
 * Use this in typeahead, help screens, and other places where users need to see
 * where a command comes from.
 *
 * For model-facing prompts (like SkillTool), use cmd.description directly.
 */
/** 给命令描述加上「来源标注」，专供面向用户的 UI（自动补全、/help 列表）使用。
 *  入参 cmd：命令；返回：带来源后缀的描述字符串。
 *  各类来源的展示规则：workflow → (workflow)；plugin → (插件名) 前缀或 (plugin) 后缀；
 *  builtin / mcp → 不加标注（它们本身身份就明确）；bundled → (bundled)；
 *  其余（project / user 等）→ 用 getSettingSourceName 翻译成人话后加括号。
 *  为什么要区分「给用户看」和「给模型看」：来源标注对人有用（知道这条是哪来的），
 *  对模型是噪音，所以 SkillTool 那边直接用 cmd.description（见上方英文注释）。
 */
export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') {
    return cmd.description
  }

  if (cmd.kind === 'workflow') {
    return `${cmd.description} (workflow)`
  }

  if (cmd.source === 'plugin') {
    const pluginName = cmd.pluginInfo?.pluginManifest.name
// `cmd.pluginInfo?.pluginManifest.name`：可选链一路判空——pluginInfo 或 manifest 缺失时整段为 undefined，不会抛 NPE。
    if (pluginName) {
      return `(${pluginName}) ${cmd.description}`
    }
    return `${cmd.description} (plugin)`
  }

  if (cmd.source === 'builtin' || cmd.source === 'mcp') {
    return cmd.description
  }

  if (cmd.source === 'bundled') {
    return `${cmd.description} (bundled)`
  }

  return `${cmd.description} (${getSettingSourceName(cmd.source)})`
}
