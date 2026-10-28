/**
 * 【一句话定位】teammate（团队成员）的**派生器**：在 tmux 分屏 / iTerm2 分屏 / 独立 tmux 窗口 /
 * 同进程（in-process）这几种形态下，起一个新的 Claude Code 实例作为团队成员。
 *
 * 【在架构中的位置】
 *   上游：
 *     tools/AgentTool/AgentTool.tsx 的 call()（带 name + team_name 时走这里）
 *     TeammateTool（团队工具的 spawn 操作）
 *   下游：
 *     utils/swarm/ 下的后端抽象模块（tmux / iTerm2 / in-process 三种 backend）
 *     utils/swarm/teamHelpers.js —— 读写团队名单文件（TeamFile）
 *     utils/teammateMailbox.js —— 给 tmux 形态的 teammate 送初始指令（它靠轮询收件箱起步）
 *     utils/swarm/inProcessRunner.js —— 同进程形态下真正跑 agent 循环
 *
 * 【teammate 与 subagent 的区别】(容易混淆，重点)
 *   ┌────────────┬────────────────────────┬──────────────────────────────┐
 *   │            │ subagent                │ teammate                     │
 *   ├────────────┼────────────────────────┼──────────────────────────────┤
 *   │ 进程       │ 同一个 Node 进程        │ **独立进程**（tmux pane）      │
 *   │            │ （或 in-process 同进程）│ 或同进程但独立 agent 上下文    │
 *   ├────────────┼────────────────────────┼──────────────────────────────┤
 *   │ 生命周期   │ 跟父级 turn 走          │ 独立于父级，长期存活          │
 *   ├────────────┼────────────────────────┼──────────────────────────────┤
 *   │ 沟通方式   │ 返回值 / 通知           │ mailbox（收件箱）+ SendMessage │
 *   ├────────────┼────────────────────────┼──────────────────────────────┤
 *   │ 标识       │ agentId（随机）         │ agentId = `name@teamName`     │
 *   │            │                         │ （**确定性**，由名字推出）     │
 *   └────────────┴────────────────────────┴──────────────────────────────┘
 *   关键：teammate 的 agentId 是 `name@teamName` 这种确定性格式，
 *   所以任何人只要知道名字就能给它发消息（这就是 sanitizeAgentName 要禁掉 @ 的原因）。
 *
 * 【三种派生形态】
 *   ① in-process（默认优先）：同一个 Node 进程里用 AsyncLocalStorage 隔离出一个 teammate，
 *      好处是能共享终端、能被 Ctrl-C 一起中断，开销小。
 *   ② split-pane：在 tmux/iTerm2 里开一个分屏，leader 在左、teammates 在右。
 *   ③ separate-window（legacy）：在独立的 claude-swarm tmux session 里开一个独立窗口。
 *   选哪个由 utils/swarm/backends/registry.js 的后端探测决定，
 *   探测失败（比如 iTerm2 没装 it2 CLI、也没装 tmux）时自动回退到 in-process。
 *
 * 【本文件包含什么】
 *   - getDefaultTeammateModel() / resolveTeammateModel()：决定 teammate 用什么模型（含 'inherit' 处理）。
 *   - SpawnOutput / SpawnTeammateConfig / SpawnInput：入参出参类型。
 *   - hasSession() / ensureSession()：tmux session 的存在性检查和创建。
 *   - getTeammateCommand()：拿到要执行的 Claude Code 可执行文件路径。
 *   - buildInheritedCliFlags()：把父 session 的 CLI 参数（权限模式、模型、settings、插件、chrome）传给 teammate。
 *   - generateUniqueTeammateName()：同名时自动加 -2 / -3 后缀。
 *   - handleSpawnSplitPane() / handleSpawnSeparateWindow() / handleSpawnInProcess()：三种形态的实现。
 *   - registerOutOfProcessTeammateTask()：把外部进程的 teammate 登记进任务表（出现在任务胶囊里）。
 *   - handleSpawn() / spawnTeammate()：分发入口和对外主入口。
 *
 * 【TS 语法速查】(针对本文件实际出现的语法)
 *   - 类型标注在变量名**后面**：`const flags: string[] = []`。
 *   - `type X = { a: string; b?: number }` ≈ Java record + 可选字段；
 *     `b?: number` 等价于 `b: number | undefined` 但可以整个省略。
 *   - `A | undefined` 联合：必须显式写出来（TS 默认不认为引用类型可空）。
 *   - `??` 空值合并（只在 null/undefined 时取右边，0 和 '' 不替换）；
 *     `||` 会把 0/''/false 也替换掉 —— 本文件 `leaderModel ?? getDefault...` 用的是 ??，
 *     因为空字符串表示「未设置」，而 ?? 只在 null/undefined 时才兜底。
 *   - `!` 后缀非空断言：`process.argv[1]!`、`prev.teamContext!.leadAgentId`。
 *   - `?.` 可选链；`?.()` 可选调用；`??=` 逻辑赋值。
 *   - `async / await` ≈ CompletableFuture，但写法像同步代码。
 *   - `new Promise<T>(resolve => {...})`：手动构造 Promise，
 *     这里用来「等用户在 UI 上点按钮」——把 resolve 传给 React 组件的 onDone 回调。
 *     ≈ Java 的 CompletableFuture + 在某个回调里 complete()。
 *   - `React.createElement(X, props)` ≈ JSX 的 `<X {...props} />`，
 *     在 .ts 文件里不能用 JSX 语法（只有 .tsx 可以），所以要写成函数调用。
 *   - `arr.filter(Boolean)`：去掉数组里的假值（''、null、undefined、false）。
 *     本文件用它清理「条件不满足时压入的空字符串」。
 *   - `arr.filter((flag, i, arr) => ...)`：filter 回调可以拿到 (元素, 下标, 原数组)，
 *     这里用 `arr[i-1]` 看前一个元素（用来删掉 `--model xxx` 里的 xxx）。
 *   - `setAppState(prev => ({...prev, k: v}))`：React 风格的函数式状态更新，
 *     返回**新对象**而不是改旧对象（不可变更新）。
 *   - 计算属性名 `{ [teammateId]: {...} }`：键是一个变量，≈ map.put(teammateId, ...)。
 *   - `switch` / `try-catch` / 模板字符串：与 Java 用法相同。
 *   - `void fn()`：fire-and-forget（故意不 await）。
 *   - `signal.addEventListener('abort', fn, { once: true })`：
 *     一次性事件监听，执行一次后自动移除 ≈ Java 里的 disposable listener。
 *   - `import type {...}` 只导入类型；`import React from 'react'` 是默认导入。
 */
/**
 * Shared spawn module for teammate creation.
 * Extracted from TeammateTool to allow reuse by AgentTool.
 */

import React from 'react'
import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
  getSessionId,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { formatAgentId } from '../../utils/agentId.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { isTmuxAvailable } from '../../utils/swarm/backends/detection.js'
import {
  detectAndGetBackend,
  getBackendByType,
  isInProcessEnabled,
  markInProcessFallback,
  resetBackendDetection,
} from '../../utils/swarm/backends/registry.js'
import { getTeammateModeFromSnapshot } from '../../utils/swarm/backends/teammateModeSnapshot.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { isPaneBackend } from '../../utils/swarm/backends/types.js'
import {
  SWARM_SESSION_NAME,
  TEAM_LEAD_NAME,
  TEAMMATE_COMMAND_ENV_VAR,
  TMUX_COMMAND,
} from '../../utils/swarm/constants.js'
import { It2SetupPrompt } from '../../utils/swarm/It2SetupPrompt.js'
import { startInProcessTeammate } from '../../utils/swarm/inProcessRunner.js'
import {
  type InProcessSpawnConfig,
  spawnInProcessTeammate,
} from '../../utils/swarm/spawnInProcess.js'
import { buildInheritedEnvVars } from '../../utils/swarm/spawnUtils.js'
import {
  readTeamFileAsync,
  sanitizeAgentName,
  sanitizeName,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'
import {
  assignTeammateColor,
  createTeammatePaneInSwarmView,
  enablePaneBorderStatus,
  isInsideTmux,
  sendCommandToPane,
} from '../../utils/swarm/teammateLayoutManager.js'
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js'
import { registerTask } from '../../utils/task/framework.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import type { CustomAgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { isCustomAgent } from '../AgentTool/loadAgentsDir.js'

/**
 * 决定 teammate 的默认模型。三种来源优先级：
 *   ① 用户在 /config 里选了「Default」→ 跟随 leader 的模型
 *   ② 用户在 /config 里显式选了某个模型 → 用它
 *   ③ 都没配 → 用硬编码的兜底模型
 */
function getDefaultTeammateModel(leaderModel: string | null): string {
  const configured = getGlobalConfig().teammateDefaultModel
  if (configured === null) {
    // User picked "Default" in the /config picker — follow the leader.
    return leaderModel ?? getHardcodedTeammateModelFallback()
  }
  if (configured !== undefined) {
    return parseUserSpecifiedModel(configured)
  }
  return getHardcodedTeammateModelFallback()
}

/**
 * 解析 teammate 的模型。核心是处理 'inherit' 这个别名（agent frontmatter 里可以写）：
 * 它必须替换成 leader 的实际模型名，不能原样传给 --model，
 * 否则 CLI 会报「该模型不存在或你没有权限」（gh-31069）。
 * leader 模型还没定（null）时退回默认值。
 */
/**
 * Resolve a teammate model value. Handles the 'inherit' alias (from agent
 * frontmatter) by substituting the leader's model. gh-31069: 'inherit' was
 * passed literally to --model, producing "It may not exist or you may not
 * have access". If leader model is null (not yet set), falls through to the
 * default.
 *
 * Exported for testing.
 */
export function resolveTeammateModel(
  inputModel: string | undefined,
  leaderModel: string | null,
): string {
  if (inputModel === 'inherit') {
    return leaderModel ?? getDefaultTeammateModel(leaderModel)
  }
  return inputModel ?? getDefaultTeammateModel(leaderModel)
}

// ============================================================================
// Types
// ============================================================================

export type SpawnOutput = {
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}

export type SpawnTeammateConfig = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  /** request_id of the API call whose response contained the tool_use that
   *  spawned this teammate. Threaded through to TeammateAgentContext for
   *  lineage tracing on tengu_api_* events. */
  invokingRequestId?: string
}

// Internal input type matching TeammateTool's spawn parameters
type SpawnInput = {
  name: string
  prompt: string
  team_name?: string
  cwd?: string
  use_splitpane?: boolean
  plan_mode_required?: boolean
  model?: string
  agent_type?: string
  description?: string
  invokingRequestId?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Checks if a tmux session exists
 */
/**
 * 检查一个 tmux session 是否存在（用 `tmux has-session`，退出码 0 表示存在）。
 */
async function hasSession(sessionName: string): Promise<boolean> {
  const result = await execFileNoThrow(TMUX_COMMAND, [
    'has-session',
    '-t',
    sessionName,
  ])
  return result.code === 0
}

/**
 * Creates a new tmux session if it doesn't exist
 */
/**
 * 确保 tmux session 存在，不存在就创建一个 detached 的（-d）。
 */
async function ensureSession(sessionName: string): Promise<void> {
  const exists = await hasSession(sessionName)
  if (!exists) {
    const result = await execFileNoThrow(TMUX_COMMAND, [
      'new-session',
      '-d',
      '-s',
      sessionName,
    ])
    if (result.code !== 0) {
      throw new Error(
        `Failed to create tmux session '${sessionName}': ${result.stderr || 'Unknown error'}`,
      )
    }
  }
}

/**
 * Gets the command to spawn a teammate.
 * For native builds (compiled binaries), use process.execPath.
 * For non-native (node/bun running a script), use process.argv[1].
 */
/**
 * 拿到要执行的 Claude Code 可执行文件路径。
 * 优先级：环境变量 TEAMMATE_COMMAND_ENV_VAR（测试/特殊场景覆盖）>
 * 打包成二进制时是 process.execPath（自己的可执行文件）> 脚本模式下是 process.argv[1]。
 */
function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * 把父 session 的 CLI 参数传给 teammate，让它继承重要的启动设置。
 * 为什么要传：teammate 是**全新进程**，它不知道父级是用什么权限模式、模型、settings 启动的。
 * 安全细节：plan 模式优先于 bypassPermissions —— 要求 plan 模式时**不**继承跳过权限的开关，
 * 否则「要求先出计划」这道安全门就被绕过去了。
 */
/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
// 要求 plan 模式时不继承 --dangerously-skip-permissions（plan 优先，安全门不能被绕过）
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
// auto 模式也传下去：让 teammate 的分类器也能自动放行它的工具调用。
// 它自己的启动流程（permissionSetup.ts）会独立检查 GrowthBook 开关并 setAutoModeActive(true)
  } else if (permissionMode === 'auto') {
    // Teammates inherit auto mode so the classifier auto-approves their tool
    // calls too. The teammate's own startup (permissionSetup.ts) handles
    // GrowthBook gate checks and setAutoModeActive(true) independently.
    flags.push('--permission-mode auto')
  }

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Generates a unique teammate name by checking existing team members.
 * If the name already exists, appends a numeric suffix (e.g., tester-2, tester-3).
 * @internal Exported for testing
 */
/**
 * 生成不重复的 teammate 名字：已存在就依次尝试 name-2、name-3…
 * 比较是**忽略大小写**的（Tester 和 tester 视为同名）。
 */
export async function generateUniqueTeammateName(
  baseName: string,
  teamName: string | undefined,
): Promise<string> {
  if (!teamName) {
    return baseName
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    return baseName
  }

  const existingNames = new Set(teamFile.members.map(m => m.name.toLowerCase()))

  // If the base name doesn't exist, use it as-is
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName
  }

  // Find the next available suffix
  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix++
  }

  return `${baseName}-${suffix}`
}

// ============================================================================
// Spawn Handlers
// ============================================================================

/**
 * Handle spawn operation using split-pane view (default).
 * When inside tmux: Creates teammates in a shared window with leader on left, teammates on right.
 * When outside tmux: Creates a claude-swarm session with all teammates in a tiled layout.
 */
/**
 * 分屏形态的派生（默认）。三种子情形：
 *   - 已在 tmux 里：切当前窗口，leader 在左、teammate 在右
 *   - 在 iTerm2 且装了 it2：用 iTerm2 原生分屏
 *   - 两者都不在：创建一个 claude-swarm session，所有 teammate 平铺
 *
 * 关键步骤：
 *   ① 解析模型、校验 name/prompt、确定 teamName、生成唯一名字
 *   ② 探测后端；如果是 iTerm2 但没装 it2，弹 UI 让用户选「装 it2 / 改用 tmux / 取消」
 *   ③ 分配颜色、创建分屏、必要时开启 pane 边框状态
 *   ④ 拼出启动命令（cd + env + 可执行文件路径 + 身份参数 + 继承的 flags）
 *   ⑤ 把命令发到新 pane 执行
 *   ⑥ 登记 AppState.teamContext、注册后台任务、写进团队名单文件
 *   ⑦ **通过 mailbox 送初始指令**（启动命令里刻意不带 prompt）
 */
async function handleSpawnSplitPane(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

// 'inherit' → leader 的模型；undefined → 默认模型（见 resolveTeammateModel）
  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

// 名字里不能有 @ —— agentId 格式是 name@teamName，名字带 @ 会破坏解析
  // Sanitize the name to prevent @ in agent IDs (would break agentName@teamName format)
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
// 确定性 agentId：`name@teamName`。所以只要知道名字就能给它发消息
  const teammateId = formatAgentId(sanitizedName, teamName)
  const workingDir = cwd || getCwd()

  // Detect the appropriate backend and check if setup is needed
  let detectionResult = await detectAndGetBackend()

  // If in iTerm2 but it2 isn't set up, prompt the user
// 在 iTerm2 里但没装 it2 CLI：弹一个设置提示让用户三选一
  if (detectionResult.needsIt2Setup && context.setToolJSX) {
    const tmuxAvailable = await isTmuxAvailable()

    // Show the setup prompt and wait for user decision
// 用 Promise 把「用户点按钮」这个异步 UI 事件转成可 await 的结果：
// React 组件的 onDone 回调直接就是 resolve
    const setupResult = await new Promise<
      'installed' | 'use-tmux' | 'cancelled'
    >(resolve => {
      context.setToolJSX!({
        jsx: React.createElement(It2SetupPrompt, {
          onDone: resolve,
          tmuxAvailable,
        }),
        shouldHidePromptInput: true,
      })
    })

    // Clear the JSX
    context.setToolJSX(null)

    if (setupResult === 'cancelled') {
      throw new Error('Teammate spawn cancelled - iTerm2 setup required')
    }

    // If they installed it2 or chose tmux, clear cached detection and re-fetch
    // so the local detectionResult matches the backend that will actually
    // spawn the pane.
    // - 'installed': re-detect to pick up the ITermBackend (it2 is now available)
    // - 'use-tmux': re-detect so needsIt2Setup is false (preferTmux is now saved)
    //   and subsequent spawns skip this prompt
// 用户装了 it2 或改用 tmux → 清掉后端探测缓存重新探测，
// 让本地的 detectionResult 和真正会创建 pane 的后端一致
    if (setupResult === 'installed' || setupResult === 'use-tmux') {
      resetBackendDetection()
      detectionResult = await detectAndGetBackend()
    }
  }

  // Check if we're inside tmux to determine session naming
  const insideTmux = await isInsideTmux()

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Create a pane in the swarm view
  // - Inside tmux: splits current window (leader on left, teammates on right)
  // - In iTerm2 with it2: uses native iTerm2 split panes
  // - Outside both: creates claude-swarm session with tiled teammates
  const { paneId, isFirstTeammate } = await createTeammatePaneInSwarmView(
    sanitizedName,
    teammateColor,
  )

  // Enable pane border status on first teammate when inside tmux
  // (outside tmux, this is handled in createTeammatePaneInSwarmView)
// 第一个 teammate 且在 tmux 里时才开边框状态；tmux 之外由 createTeammatePaneInSwarmView 内部处理
  if (isFirstTeammate && insideTmux) {
    await enablePaneBorderStatus()
  }

  // Build the command to spawn Claude Code with teammate identity
// 注意：启动命令里**不带 prompt**。初始指令走 mailbox，
// 这样 teammate 启动完成后由它的收件箱轮询器取走，作为第一个 turn 提交
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces CLAUDE_CODE_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
// 传 plan_mode_required 进去，是为了阻止继承 bypass permissions
  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
  })

  // If teammate has a custom model, add --model flag (or replace inherited one)
// teammate 自带模型时，先删掉继承来的 --model（连同它的值），再加自己的
  if (model) {
    // Remove any inherited --model flag first
    inheritedFlags = inheritedFlags
      .split(' ')
      .filter((flag, i, arr) => flag !== '--model' && arr[i - 1] !== '--model')
      .join(' ')
    // Add the teammate's model
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes CLAUDECODE, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
// 补一批环境变量：tmux split-window 起的新 shell 不一定继承这些
// （CLAUDECODE、agent teams 开关、API provider 相关变量等）
  const envStr = buildInheritedEnvVars()
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // Send the command to the new pane
  // Use swarm socket when running outside tmux (external swarm session)
  await sendCommandToPane(paneId, spawnCommand, !insideTmux)

  // Determine session/window names for output
// 在 tmux 里就用当前 session/window；不在 tmux 里则是独立的 swarm session
  const sessionName = insideTmux ? 'current' : SWARM_SESSION_NAME
  const windowName = insideTmux ? 'current' : 'swarm-view'

  // Track the teammate in AppState's teamContext with color
  // If spawning without spawnTeam, set up the leader as team lead
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: sessionName,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so teammates appear in the tasks pill/dialog
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType: detectionResult.backend.type,
    toolUseId: context.toolUseId,
  })

// 团队名单文件必须已存在（要先调 spawnTeam 建团队）
  // Register agent in the team file
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: detectionResult.backend.type,
  })
  await writeTeamFileAsync(teamName, teamFile)

// 初始指令走 mailbox：teammate 的收件箱轮询器会取走它，作为第一个 turn
  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: sessionName,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: true,
      plan_mode_required,
    },
  }
}

/**
 * Handle spawn operation using separate windows (legacy behavior).
 * Creates each teammate in its own tmux window.
 */
/**
 * 独立窗口形态的派生（legacy）：在 claude-swarm 这个 tmux session 里给每个 teammate
 * 开一个独立的 tmux 窗口。流程和分屏形态几乎一样，区别只在创建的是 window 而不是 pane。
 */
async function handleSpawnSeparateWindow(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, cwd, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs (would break agentName@teamName format)
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)
  const windowName = `teammate-${sanitizeName(sanitizedName)}`
  const workingDir = cwd || getCwd()

  // Ensure the swarm session exists
  await ensureSession(SWARM_SESSION_NAME)

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

  // Create a new window for this teammate
  const createWindowResult = await execFileNoThrow(TMUX_COMMAND, [
    'new-window',
    '-t',
    SWARM_SESSION_NAME,
    '-n',
    windowName,
    '-P',
    '-F',
    '#{pane_id}',
  ])

  if (createWindowResult.code !== 0) {
    throw new Error(
      `Failed to create tmux window: ${createWindowResult.stderr}`,
    )
  }

  const paneId = createWindowResult.stdout.trim()

  // Build the command to spawn Claude Code with teammate identity
  // Note: We spawn without a prompt - initial instructions are sent via mailbox
  const binaryPath = getTeammateCommand()

  // Build teammate identity CLI args (replaces CLAUDE_CODE_* env vars)
  const teammateArgs = [
    `--agent-id ${quote([teammateId])}`,
    `--agent-name ${quote([sanitizedName])}`,
    `--team-name ${quote([teamName])}`,
    `--agent-color ${quote([teammateColor])}`,
    `--parent-session-id ${quote([getSessionId()])}`,
    plan_mode_required ? '--plan-mode-required' : '',
    agent_type ? `--agent-type ${quote([agent_type])}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // Build CLI flags to propagate to teammate
  // Pass plan_mode_required to prevent inheriting bypass permissions
  let inheritedFlags = buildInheritedCliFlags({
    planModeRequired: plan_mode_required,
    permissionMode: appState.toolPermissionContext.mode,
  })

  // If teammate has a custom model, add --model flag (or replace inherited one)
  if (model) {
    // Remove any inherited --model flag first
    inheritedFlags = inheritedFlags
      .split(' ')
      .filter((flag, i, arr) => flag !== '--model' && arr[i - 1] !== '--model')
      .join(' ')
    // Add the teammate's model
    inheritedFlags = inheritedFlags
      ? `${inheritedFlags} --model ${quote([model])}`
      : `--model ${quote([model])}`
  }

  const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
  // Propagate env vars that teammates need but may not inherit from tmux split-window shells.
  // Includes CLAUDECODE, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, and API provider vars.
  const envStr = buildInheritedEnvVars()
  const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

  // Send the command to the new window
  const sendKeysResult = await execFileNoThrow(TMUX_COMMAND, [
    'send-keys',
    '-t',
    `${SWARM_SESSION_NAME}:${windowName}`,
    spawnCommand,
    'Enter',
  ])

  if (sendKeysResult.code !== 0) {
    throw new Error(
      `Failed to send command to tmux window: ${sendKeysResult.stderr}`,
    )
  }

  // Track the teammate in AppState's teamContext
  setAppState(prev => ({
    ...prev,
    teamContext: {
      ...prev.teamContext,
      teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
      teamFilePath: prev.teamContext?.teamFilePath ?? '',
      leadAgentId: prev.teamContext?.leadAgentId ?? '',
      teammates: {
        ...(prev.teamContext?.teammates || {}),
        [teammateId]: {
          name: sanitizedName,
          agentType: agent_type,
          color: teammateColor,
          tmuxSessionName: SWARM_SESSION_NAME,
          tmuxPaneId: paneId,
          cwd: workingDir,
          spawnedAt: Date.now(),
        },
      },
    },
  }))

  // Register background task so tmux teammates appear in the tasks pill/dialog
  // Separate window spawns are always outside tmux (external swarm session)
  registerOutOfProcessTeammateTask(setAppState, {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux: false,
    backendType: 'tmux',
    toolUseId: context.toolUseId,
  })

  // Register agent in the team file
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: paneId,
    cwd: workingDir,
    subscriptions: [],
    backendType: 'tmux', // This handler always uses tmux directly
  })
  await writeTeamFileAsync(teamName, teamFile)

  // Send initial instructions to teammate via mailbox
  // The teammate's inbox poller will pick this up and submit it as their first turn
  await writeToMailbox(
    sanitizedName,
    {
      from: TEAM_LEAD_NAME,
      text: prompt,
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: SWARM_SESSION_NAME,
      tmux_window_name: windowName,
      tmux_pane_id: paneId,
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * 把**外部进程**形态的 teammate（tmux/iTerm2）登记成一个后台任务，
 * 让它也出现在任务胶囊和任务对话框里（和 in-process teammate 表现一致）。
 * 同时给 abortController 挂一个一次性监听：收到 abort 就用**当初创建它的那个后端**去关掉 pane
 * （tmux pane 用 tmux kill-pane，iTerm2 原生 pane 用 it2 关 session）。
 */
/**
 * Register a background task entry for an out-of-process (tmux/iTerm2) teammate.
 * This makes tmux teammates visible in the background tasks pill and dialog,
 * matching how in-process teammates are tracked.
 */
function registerOutOfProcessTeammateTask(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  {
    teammateId,
    sanitizedName,
    teamName,
    teammateColor,
    prompt,
    plan_mode_required,
    paneId,
    insideTmux,
    backendType,
    toolUseId,
  }: {
    teammateId: string
    sanitizedName: string
    teamName: string
    teammateColor: string
    prompt: string
    plan_mode_required?: boolean
    paneId: string
    insideTmux: boolean
    backendType: BackendType
    toolUseId?: string
  },
): void {
// 类型虽然是 'in_process_teammate'，但外部进程的 teammate 也复用这个任务类型来展示
  const taskId = generateTaskId('in_process_teammate')
  const description = `${sanitizedName}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

  const abortController = new AbortController()

  const taskState: InProcessTeammateTaskState = {
    ...createTaskStateBase(
      taskId,
      'in_process_teammate',
      description,
      toolUseId,
    ),
    type: 'in_process_teammate',
    status: 'running',
    identity: {
      agentId: teammateId,
      agentName: sanitizedName,
      teamName,
      color: teammateColor,
      planModeRequired: plan_mode_required ?? false,
      parentSessionId: getSessionId(),
    },
    prompt,
    abortController,
    awaitingPlanApproval: false,
    permissionMode: plan_mode_required ? 'plan' : 'default',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingUserMessages: [],
  }

  registerTask(taskState, setAppState)

  // When abort is signaled, kill the pane using the backend that created it
  // (tmux kill-pane for tmux panes, it2 session close for iTerm2 native panes).
  // SDK task_notification bookend is emitted by killInProcessTeammate (the
  // sole abort trigger for this controller).
// abort 时用当初创建 pane 的那个后端去关（不能想当然用 tmux）
  abortController.signal.addEventListener(
    'abort',
    () => {
      if (isPaneBackend(backendType)) {
        void getBackendByType(backendType).killPane(paneId, !insideTmux)
      }
    },
    { once: true },
  )
}

/**
 * Handle spawn operation for in-process teammates.
 * In-process teammates run in the same Node.js process using AsyncLocalStorage.
 */
/**
 * 同进程形态的派生：在同一个 Node 进程里，用 AsyncLocalStorage 隔离出一个 teammate。
 * 和另外两种形态最大的区别：
 *   - 不需要 tmux/iTerm2，任何环境都能跑
 *   - 共享终端，能被一起中断，开销小
 *   - 初始指令**直接**传给 startInProcessTeammate，**不走 mailbox**
 *     （走 mailbox 会和直接传参重复，导致两条欢迎消息）
 */
async function handleSpawnInProcess(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  const { setAppState, getAppState } = context
  const { name, prompt, agent_type, plan_mode_required } = input

  // Resolve model: 'inherit' → leader's model; undefined → default Opus
  const model = resolveTeammateModel(input.model, getAppState().mainLoopModel)

  if (!name || !prompt) {
    throw new Error('name and prompt are required for spawn operation')
  }

  // Get team name from input or inherit from leader's team context
  const appState = getAppState()
  const teamName = input.team_name || appState.teamContext?.teamName

  if (!teamName) {
    throw new Error(
      'team_name is required for spawn operation. Either provide team_name in input or call spawnTeam first to establish team context.',
    )
  }

  // Generate unique name if duplicate exists in team
  const uniqueName = await generateUniqueTeammateName(name, teamName)

  // Sanitize the name to prevent @ in agent IDs
  const sanitizedName = sanitizeAgentName(uniqueName)

  // Generate deterministic agent ID from name and team
  const teammateId = formatAgentId(sanitizedName, teamName)

  // Assign a unique color to this teammate
  const teammateColor = assignTeammateColor(teammateId)

// agent_type 指向一个自定义 agent 定义时才带上定义（内置 agent 不需要）
  // Look up custom agent definition if agent_type is provided
  let agentDefinition: CustomAgentDefinition | undefined
  if (agent_type) {
    const allAgents = context.options.agentDefinitions.activeAgents
    const foundAgent = allAgents.find(a => a.agentType === agent_type)
    if (foundAgent && isCustomAgent(foundAgent)) {
      agentDefinition = foundAgent
    }
    logForDebugging(
      `[handleSpawnInProcess] agent_type=${agent_type}, found=${!!agentDefinition}`,
    )
  }

  // Spawn in-process teammate
  const config: InProcessSpawnConfig = {
    name: sanitizedName,
    teamName,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required ?? false,
    model,
  }

  const result = await spawnInProcessTeammate(config, context)

  if (!result.success) {
    throw new Error(result.error ?? 'Failed to spawn in-process teammate')
  }

  // Debug: log what spawn returned
  logForDebugging(
    `[handleSpawnInProcess] spawn result: taskId=${result.taskId}, hasContext=${!!result.teammateContext}, hasAbort=${!!result.abortController}`,
  )

  // Start the agent execution loop (fire-and-forget)
  if (result.taskId && result.teammateContext && result.abortController) {
    startInProcessTeammate({
      identity: {
        agentId: teammateId,
        agentName: sanitizedName,
        teamName,
        color: teammateColor,
        planModeRequired: plan_mode_required ?? false,
        parentSessionId: result.teammateContext.parentSessionId,
      },
      taskId: result.taskId,
      prompt,
      description: input.description,
      model,
      agentDefinition,
      teammateContext: result.teammateContext,
// 关键：把 messages 清空。teammate 根本不读 toolUseContext.messages
// （它靠 inProcessRunner 里的 allMessages 自己攒历史）。
// 把父级完整对话传进去会让它在整个生命周期里一直被引用，
// /clear 和 auto-compact 都释放不掉（内存泄漏 + 上下文污染）。
      // Strip messages: the teammate never reads toolUseContext.messages
      // (it builds its own history via allMessages in inProcessRunner).
      // Passing the parent's full conversation here would pin it for the
      // teammate's lifetime, surviving /clear and auto-compact.
      toolUseContext: { ...context, messages: [] },
      abortController: result.abortController,
      invokingRequestId: input.invokingRequestId,
    })
    logForDebugging(
      `[handleSpawnInProcess] Started agent execution for ${teammateId}`,
    )
  }

  // Track the teammate in AppState's teamContext
  // Auto-register leader if spawning without prior spawnTeam call
// 没有 leadAgentId 说明是首次派生（没先调 spawnTeam），这里顺手把 leader 也登记进名单，
// 否则 leader 没有收件箱条目，收不到 teammate 的回信
  setAppState(prev => {
    const needsLeaderSetup = !prev.teamContext?.leadAgentId
    const leadAgentId = needsLeaderSetup
      ? formatAgentId(TEAM_LEAD_NAME, teamName)
      : prev.teamContext!.leadAgentId

    // Build teammates map, including leader if needed for inbox polling
    const existingTeammates = prev.teamContext?.teammates || {}
    const leadEntry = needsLeaderSetup
      ? {
          [leadAgentId]: {
            name: TEAM_LEAD_NAME,
            agentType: TEAM_LEAD_NAME,
            color: assignTeammateColor(leadAgentId),
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'leader',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        }
      : {}

    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teamName: teamName ?? prev.teamContext?.teamName ?? 'default',
        teamFilePath: prev.teamContext?.teamFilePath ?? '',
        leadAgentId,
        teammates: {
          ...existingTeammates,
          ...leadEntry,
          [teammateId]: {
            name: sanitizedName,
            agentType: agent_type,
            color: teammateColor,
            tmuxSessionName: 'in-process',
            tmuxPaneId: 'in-process',
            cwd: getCwd(),
            spawnedAt: Date.now(),
          },
        },
      },
    }
  })

  // Register agent in the team file
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(
      `Team "${teamName}" does not exist. Call spawnTeam first to create the team.`,
    )
  }
  teamFile.members.push({
    agentId: teammateId,
    name: sanitizedName,
    agentType: agent_type,
    model,
    prompt,
    color: teammateColor,
    planModeRequired: plan_mode_required,
    joinedAt: Date.now(),
    tmuxPaneId: 'in-process',
    cwd: getCwd(),
    subscriptions: [],
    backendType: 'in-process',
  })
  await writeTeamFileAsync(teamName, teamFile)

// 注意这里**不**写 mailbox：in-process teammate 已经通过 startInProcessTeammate 直接拿到 prompt 了。
// 再写一次会导致两条重复的欢迎消息（mailbox 只服务于靠轮询起步的 tmux 形态）
  // Note: Do NOT send the prompt via mailbox for in-process teammates.
  // In-process teammates receive the prompt directly via startInProcessTeammate().
  // The mailbox is only needed for tmux-based teammates which poll for their initial message.
  // Sending via both paths would cause duplicate welcome messages.

  return {
    data: {
      teammate_id: teammateId,
      agent_id: teammateId,
      agent_type,
      model,
      name: sanitizedName,
      color: teammateColor,
      tmux_session_name: 'in-process',
      tmux_window_name: 'in-process',
      tmux_pane_id: 'in-process',
      team_name: teamName,
      is_splitpane: false,
      plan_mode_required,
    },
  }
}

/**
 * 派生分发：决定走哪种形态。
 *   - in-process 开关打开 → 直接同进程
 *   - 否则先探测 pane 后端；探测失败时，**只有 auto 模式**静默回退到同进程
 *     （用户显式配了 teammateMode: 'tmux' 就让错误抛出去，好让他们看到安装指引）
 *   - 探测成功 → 分屏（默认）或独立窗口（use_splitpane === false）
 */
/**
 * Handle spawn operation - creates a new Claude Code instance.
 * Uses in-process mode when enabled, otherwise uses tmux/iTerm2 split-pane view.
 * Falls back to in-process if pane backend detection fails (e.g., iTerm2 without
 * it2 CLI or tmux installed).
 */
async function handleSpawn(
  input: SpawnInput,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  // Check if in-process mode is enabled via feature flag
  if (isInProcessEnabled()) {
    return handleSpawnInProcess(input, context)
  }

// 预检：先确认真有可用的 pane 后端。这覆盖了一种情况——
// isInProcessEnabled() 返回 false，但机器上既没装 it2 也没装 tmux，探测会失败
  // Pre-flight: ensure a pane backend is available before attempting pane-based spawn.
  // This handles auto-mode cases like iTerm2 without it2 or tmux installed, where
  // isInProcessEnabled() returns false but detectAndGetBackend() has no viable backend.
  // Narrowly scoped so user cancellation and other spawn errors propagate normally.
  try {
    await detectAndGetBackend()
  } catch (error) {
    // Only fall back silently in auto mode. If the user explicitly configured
    // teammateMode: 'tmux', let the error propagate so they see the actionable
    // install instructions from getTmuxInstallInstructions().
// 只在 auto 模式静默回退；用户显式指定了 tmux 就让错误抛出去（带安装指引）
    if (getTeammateModeFromSnapshot() !== 'auto') {
      throw error
    }
    logForDebugging(
      `[handleSpawn] No pane backend available, falling back to in-process: ${errorMessage(error)}`,
    )
    // Record the fallback so isInProcessEnabled() reflects the actual mode
    // (fixes banner and other UI that would otherwise show tmux attach commands).
// 记录回退这件事，让 isInProcessEnabled() 之后反映的是**实际**形态
// （否则 banner 等 UI 还会显示 tmux attach 命令）
    markInProcessFallback()
    return handleSpawnInProcess(input, context)
  }

  // Backend is available (and now cached) - proceed with pane spawning.
  // Any errors here (user cancellation, validation, etc.) propagate to the caller.
// use_splitpane 没显式写成 false 就走分屏（默认分屏）
  const useSplitPane = input.use_splitpane !== false
  if (useSplitPane) {
    return handleSpawnSplitPane(input, context)
  }
  return handleSpawnSeparateWindow(input, context)
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * 对外主入口：起一个 teammate。TeammateTool 和 AgentTool 都调它。
 *
 * @param config name / prompt / team_name / model / agent_type / plan_mode_required 等
 * @param context 当前工具上下文（要用到 setAppState、options.agentDefinitions 等）
 * @returns { data: SpawnOutput } —— 含 teammate_id、pane 信息、颜色等，
 *          交给 AgentTool 包装成 tool_result 回给主 Agent
 */
/**
 * Spawns a new teammate with the given configuration.
 * This is the main entry point for teammate spawning, used by both TeammateTool and AgentTool.
 */
export async function spawnTeammate(
  config: SpawnTeammateConfig,
  context: ToolUseContext,
): Promise<{ data: SpawnOutput }> {
  return handleSpawn(config, context)
}
