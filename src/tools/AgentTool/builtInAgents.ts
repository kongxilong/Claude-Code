/**
 * 【一句话定位】决定**内置 agent 名单**：哪些内置 agent 会出现在可用列表里。
 *
 * 【在架构中的位置】
 *   上游：loadAgentsDir.ts 的 getAgentDefinitionsWithOverrides()（汇总 agent 时调用）。
 *   下游：built-in/ 目录下的六个 agent 定义文件（generalPurpose / statuslineSetup /
 *        explore / plan / claudeCodeGuide / verification）。
 *
 * 【本文件包含什么】
 *   - areExplorePlanAgentsEnabled()：Explore / Plan 两个 agent 的开关。
 *   - getBuiltInAgents()：返回内置 agent 数组（受环境变量和 GrowthBook 开关影响）。
 *
 * 【内置 agent 名单怎么定的】
 *   - general-purpose、statusline-setup：永远有
 *   - Explore、Plan：要看 BUILTIN_EXPLORE_PLAN_AGENTS 编译开关 + tengu_amber_stoat 运行时开关
 *   - claude-code-guide：非 SDK 入口才有（sdk-ts / sdk-py / sdk-cli 入口下不加）
 *   - verification：VERIFICATION_AGENT 编译开关 + tengu_hive_evidence 运行时开关
 *   - coordinator 模式下整个名单由 coordinator/workerAgent.ts 接管（这里直接转交）
 *   - SDK 用户可以用 CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS 清空名单（想要一张白纸）
 *
 * 【TS 语法速查】(针对本文件实际出现的语法)
 *   - `feature('X')` 是**编译期**宏（≈ C 的 #ifdef），构建时 false 的分支会被整段删掉，
 *     不是运行时 if。所以 `feature('COORDINATOR_MODE')` 为 false 的构建里，
 *     下面的 require('../../coordinator/workerAgent.js') 根本不会进产物。
 *   - 函数体内的 `require(...)`（CommonJS 动态加载）而不是顶层 import：
 *     这是**故意**的，为了避开模块初始化期的循环依赖
 *     （coordinatorMode → tools → AgentTool → 本文件）。顶层 import 会在加载时就解析依赖，
 *     形成环就炸；放在函数体内则是「用到时才加载」，那时环已经解开了。
 *   - `require(...) as typeof import('...')`：断言动态加载的模块类型和静态导入的一致，
 *     这样后面拿到的对象也有完整类型（否则是 any）。
 *   - `process.env.X` 读环境变量；`isEnvTruthy()` 专门处理「环境变量是字符串，'false' 也是真」这个坑。
 *   - `getFeatureValue_CACHED_MAY_BE_STALE('gate名', 默认值)`：读 GrowthBook 实验开关，
 *     名字里的 CACHED_MAY_BE_STALE 表示「可能读到稍旧的缓存值」（避免每次都同步等网络）。
 *   - `agents.push(A, B)`：push 可以一次加多个元素（Java 的 add 只能加一个）。
 *   - eslint-disable 这类注释是给 lint 工具的指令，不是给编译器看的。
 */
import { feature } from 'bun:bundle'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { CLAUDE_CODE_GUIDE_AGENT } from './built-in/claudeCodeGuideAgent.js'
import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { STATUSLINE_SETUP_AGENT } from './built-in/statuslineSetup.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * Explore / Plan 两个 agent 是否启用。
 * 编译期开关 BUILTIN_EXPLORE_PLAN_AGENTS 为 false 时整段被删（默认关闭）；
 * 为 true 时再看运行时开关 tengu_amber_stoat，默认 true ——
 * 即三方（Bedrock/Vertex）默认保持开启（和外部构建的历史行为一致），
 * A/B 实验的处理组把它设成 false 来测量「去掉这两个 agent」的影响。
 */
export function areExplorePlanAgentsEnabled(): boolean {
  if (feature('BUILTIN_EXPLORE_PLAN_AGENTS')) {
    // 3P default: true — Bedrock/Vertex keep agents enabled (matches pre-experiment
    // external behavior). A/B test treatment sets false to measure impact of removal.
    return getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_stoat', true)
  }
  return false
}

/**
 * 返回当前应该生效的内置 agent 数组。
 * 顺序很重要：数组顺序就是列表展示顺序。
 */
export function getBuiltInAgents(): AgentDefinition[] {
  // Allow disabling all built-in agents via env var (useful for SDK users who want a blank slate)
  // Only applies in noninteractive mode (SDK/API usage)
// SDK 用户想从一张白纸开始：非交互模式（SDK/API）下可以用环境变量清空所有内置 agent
  if (
    isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }

// 用函数体内的 require 而不是顶层 import，是为了避开循环依赖：
// coordinatorMode → tools → AgentTool → builtInAgents，顶层 import 会在模块加载时就形成环
  // Use lazy require inside the function body to avoid circular dependency
  // issues at module init time. The coordinatorMode module depends on tools
  // which depend on AgentTool which imports this file.
  if (feature('COORDINATOR_MODE')) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getCoordinatorAgents } =
        require('../../coordinator/workerAgent.js') as typeof import('../../coordinator/workerAgent.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      return getCoordinatorAgents()
    }
  }

// 永远存在的两个：通用 agent 和状态栏配置 agent
  const agents: AgentDefinition[] = [
    GENERAL_PURPOSE_AGENT,
    STATUSLINE_SETUP_AGENT,
  ]

// Explore / Plan 看开关，见 areExplorePlanAgentsEnabled()
  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)
  }

// claude-code-guide 是给终端用户答疑的，SDK 场景下没有意义，所以三个 SDK 入口都不加载它
  // Include Code Guide agent for non-SDK entrypoints
  const isNonSdkEntrypoint =
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-ts' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-py' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-cli'

  if (isNonSdkEntrypoint) {
    agents.push(CLAUDE_CODE_GUIDE_AGENT)
  }

// verification agent 双开关：编译期 VERIFICATION_AGENT + 运行时 tengu_hive_evidence
  if (
    feature('VERIFICATION_AGENT') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false)
  ) {
    agents.push(VERIFICATION_AGENT)
  }

  return agents
}
