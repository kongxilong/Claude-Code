/**
 * 【一句话定位】agent 信息的**展示辅助**：给 CLI 的 `claude agents` 和交互式的 `/agents` 命令
 * 共用的一套排序、分组、覆盖标注逻辑。
 *
 * 【在架构中的位置】
 *   上游：CLI 的 agents 命令处理器、交互式 /agents 命令。
 *   下游：loadAgentsDir.ts 的 AgentDefinition 类型、utils/settings/constants.js 的来源显示名。
 *   注意：本文件和 Agent 工具的**执行**无关，纯粹是 `/agents` 列表 UI 的辅助。
 *
 * 【本文件包含什么】
 *   - AGENT_SOURCE_GROUPS：agent 来源的展示顺序（用户 / 项目 / 本地 / 托管 / 插件 / CLI / 内置）。
 *   - resolveAgentOverrides()：标出哪些 agent 被更高优先级的同名 agent 覆盖了。
 *   - resolveAgentModelDisplay()：展示用的模型名。
 *   - getOverrideSourceLabel()：覆盖来源的可读名字。
 *   - compareAgentsByName()：按名字排序（忽略大小写）。
 *
 * 【TS 语法速查】
 *   - `type A = B & { c?: D }`：交叉类型 ≈ 继承 + 加字段（这里给 AgentDefinition 加一个
 *     overriddenBy 可选字段，得到 ResolvedAgent）。
 *   - `SettingSource | 'built-in' | 'plugin'`：联合类型，把已有的来源类型和两个额外的字面量合并。
 *   - `new Map<string, AgentDefinition>()` / `new Set<string>()`：与 Java 的 Map/Set 用法一致。
 *   - `seen.has(key)` / `seen.add(key)`：Set 的包含判断和添加。
 *   - 模板字符串 `` `${a}:${b}` `` 拼复合 key（把 agentType 和 source 拼成一个唯一键）。
 *   - `{ ...agent, overriddenBy }` 展开 = 复制 agent 的所有字段再加一个字段（不可变更新）。
 *   - `a ?? b` 空值合并：`agent.model || getDefaultSubagentModel()` 这里用的是 `||`，
 *     因为空字符串 '' 也要被替换成默认值（用 ?? 的话 '' 会被保留）。
 *   - `localeCompare(b, undefined, { sensitivity: 'base' })`：按本地化规则比较字符串，
 *     sensitivity:'base' 表示忽略大小写和重音（≈ String.CASE_INSENSITIVE_ORDER 但更通用）。
 *   - 返回 `number` 的比较函数 ≈ Java 的 Comparator<T>.compare。
 *   - `switch` 语句穷尽联合类型（和 Java 17 的 switch 模式匹配思路一样）。
 */
/**
 * Shared utilities for displaying agent information.
 * Used by both the CLI `claude agents` handler and the interactive `/agents` command.
 */

import { getDefaultSubagentModel } from '../../utils/model/agent.js'
import {
  getSourceDisplayName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type AgentSource = SettingSource | 'built-in' | 'plugin'

export type AgentSourceGroup = {
  label: string
  source: AgentSource
}

/**
 * Ordered list of agent source groups for display.
 * Both the CLI and interactive UI should use this to ensure consistent ordering.
 */
// 展示顺序。CLI 和交互式 UI 都用它，保证两边顺序一致
export const AGENT_SOURCE_GROUPS: AgentSourceGroup[] = [
  { label: 'User agents', source: 'userSettings' },
  { label: 'Project agents', source: 'projectSettings' },
  { label: 'Local agents', source: 'localSettings' },
  { label: 'Managed agents', source: 'policySettings' },
  { label: 'Plugin agents', source: 'plugin' },
  { label: 'CLI arg agents', source: 'flagSettings' },
  { label: 'Built-in agents', source: 'built-in' },
]

export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource
}

/**
 * 给每个 agent 标上「被谁覆盖了」，并按 (agentType, source) 去重。
 * 为什么要去重：git worktree 场景下同一个 agent 文件会被加载两次
 * （一次从 worktree 目录，一次从主仓库目录），内容一样但会显示两条。
 * 覆盖判定：存在一个同名 agent，且它的 source 和我不同（说明优先级更高的那个赢了）。
 */
/**
 * Annotate agents with override information by comparing against the active
 * (winning) agent list. An agent is "overridden" when another agent with the
 * same type from a higher-priority source takes precedence.
 *
 * Also deduplicates by (agentType, source) to handle git worktree duplicates
 * where the same agent file is loaded from both the worktree and main repo.
 */
export function resolveAgentOverrides(
  allAgents: AgentDefinition[],
  activeAgents: AgentDefinition[],
): ResolvedAgent[] {
  const activeMap = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeMap.set(agent.agentType, agent)
  }

  const seen = new Set<string>()
  const resolved: ResolvedAgent[] = []

  // Iterate allAgents, annotating each with override info from activeAgents.
  // Deduplicate by (agentType, source) to handle git worktree duplicates.
  for (const agent of allAgents) {
// 复合 key：`agentType:source`，用来识别 worktree 重复项
    const key = `${agent.agentType}:${agent.source}`
    if (seen.has(key)) continue
    seen.add(key)

    const active = activeMap.get(agent.agentType)
    const overriddenBy =
      active && active.source !== agent.source ? active.source : undefined
    resolved.push({ ...agent, overriddenBy })
  }

  return resolved
}

/**
 * Resolve the display model string for an agent.
 * Returns the model alias or 'inherit' for display purposes.
 */
/**
 * 展示用的模型名。没配就显示默认的子 Agent 模型；'inherit' 原样显示（表示跟随父级）。
 */
export function resolveAgentModelDisplay(
  agent: AgentDefinition,
): string | undefined {
  const model = agent.model || getDefaultSubagentModel()
  if (!model) return undefined
  return model === 'inherit' ? 'inherit' : model
}

/**
 * Get a human-readable label for the source that overrides an agent.
 * Returns lowercase, e.g. "user", "project", "managed".
 */
/**
 * 覆盖来源的可读标签（小写，如 user / project / managed）。
 */
export function getOverrideSourceLabel(source: AgentSource): string {
  return getSourceDisplayName(source).toLowerCase()
}

/**
 * Compare agents alphabetically by name (case-insensitive).
 */
/**
 * 按 agent 名字字母序排序（忽略大小写和重音），≈ Java 的 Comparator。
 */
export function compareAgentsByName(
  a: AgentDefinition,
  b: AgentDefinition,
): number {
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
