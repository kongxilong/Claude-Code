/**
 * 【一句话定位】agent 类型的**颜色注册表**：给每种 agent 类型分配一个颜色，让终端里同一个
 * agent 的所有输出显示成同一种颜色（一眼能看出这是哪个子 Agent 在说话）。
 *
 * 【在架构中的位置】
 *   上游：loadAgentsDir.ts（加载时给有 color 字段的 agent 注册）、AgentTool.tsx（派生时注册）。
 *   下游：UI.tsx 的 userFacingNameBackgroundColor() / renderGroupedAgentToolUse() 取颜色渲染。
 *   真正存颜色的地方是 bootstrap/state.js 的 getAgentColorMap()（一个全局 Map），本文件只是
 *   存取它的封装 + 颜色名到主题色键名的映射表。
 *
 * 【本文件包含什么】
 *   - AgentColorName：8 种颜色的字面量联合类型。
 *   - AGENT_COLORS：合法颜色名数组。
 *   - AGENT_COLOR_TO_THEME_COLOR：颜色名 → 主题色键名（都带 _FOR_SUBAGENTS_ONLY 后缀）。
 *   - getAgentColor() / setAgentColor()：读 / 写某个 agent 类型的颜色。
 *
 * 【TS 语法速查】
 *   - `type X = 'a' | 'b' | 'c'`：字面量联合类型 ≈ Java enum（但本质只是字符串的编译期约束）。
 *   - `as const`：把数组/对象的类型锁成「字面量 + 只读」，否则 `['red','blue']` 会被推导成 string[]，
 *     后面 `AGENT_COLORS.includes(x)` 就检查不出错误了。
 *   - `satisfies Record<AgentColorName, keyof Theme>`：
 *     `satisfies` 检查一个对象是否满足某类型，但**不改变**它自己推导出的精确类型。
 *     这里用它确保 8 个颜色一个不漏、且每个值都是 Theme 里真实存在的键名。
 *   - `Record<K, V>` 工具类型 ≈ Map<K,V> 的编译期版本：表示「键为 K、值为 V」的对象。
 *   - `keyof Theme`：取 Theme 的所有键名组成的联合类型（≈ 枚举出所有属性名）。
 *   - `arr.includes(x)` 判断包含；注意它要求参数类型和数组元素类型一致（所以要 as const）。
 *   - 返回类型 `keyof Theme | undefined`：可能是某个主题色键名，也可能是 undefined（没分配颜色）。
 *   - `| undefined` 在 TS 里**必须**显式写出来（不像 Java 引用类型默认可空），
 *     这样调用方就被迫处理「没有颜色」的情况。
 */
import { getAgentColorMap } from '../../bootstrap/state.js'
import type { Theme } from '../../utils/theme.js'

export type AgentColorName =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan'

export const AGENT_COLORS: readonly AgentColorName[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const

export const AGENT_COLOR_TO_THEME_COLOR = {
  red: 'red_FOR_SUBAGENTS_ONLY',
  blue: 'blue_FOR_SUBAGENTS_ONLY',
  green: 'green_FOR_SUBAGENTS_ONLY',
  yellow: 'yellow_FOR_SUBAGENTS_ONLY',
  purple: 'purple_FOR_SUBAGENTS_ONLY',
  orange: 'orange_FOR_SUBAGENTS_ONLY',
  pink: 'pink_FOR_SUBAGENTS_ONLY',
  cyan: 'cyan_FOR_SUBAGENTS_ONLY',
} as const satisfies Record<AgentColorName, keyof Theme>

/**
 * 取某个 agent 类型的主题色键名。
 * general-purpose 刻意返回 undefined（它是默认 agent，不上色，避免到处都是同一个颜色）。
 * 颜色来自全局 Map，没分配过就返回 undefined。
 */
export function getAgentColor(agentType: string): keyof Theme | undefined {
  if (agentType === 'general-purpose') {
    return undefined
  }

  const agentColorMap = getAgentColorMap()

  // Check if color already assigned
  const existingColor = agentColorMap.get(agentType)
  if (existingColor && AGENT_COLORS.includes(existingColor)) {
    return AGENT_COLOR_TO_THEME_COLOR[existingColor]
  }

  return undefined
}

/**
 * 给一个 agent 类型设置颜色。传 undefined 表示**删除**这个 agent 的颜色记录。
 * 只对 8 种合法颜色名生效（防止 agent 定义里写了个不存在的颜色名污染注册表）。
 */
export function setAgentColor(
  agentType: string,
  color: AgentColorName | undefined,
): void {
  const agentColorMap = getAgentColorMap()

  if (!color) {
    agentColorMap.delete(agentType)
    return
  }

  if (AGENT_COLORS.includes(color)) {
    agentColorMap.set(agentType, color)
  }
}
