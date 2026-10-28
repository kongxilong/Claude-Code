/**
 * 【一句话定位】Agent 工具的几个跨文件共享常量（工具名、一次性 agent 名单）。
 *
 * 【在架构中的位置】
 *   被 AgentTool.tsx、UI.tsx、prompt.ts、agentToolUtils.ts、built-in/ 下的 agent 定义广泛引用。
 *   单独抽一个文件是为了避免在 AgentTool.tsx ↔ UI.tsx 之间形成循环 import。
 *
 * 【本文件包含什么】
 *   - AGENT_TOOL_NAME：工具现在的名字 'Agent'。
 *   - LEGACY_AGENT_TOOL_NAME：旧名字 'Task'（权限规则、钩子配置、老会话里还在用）。
 *   - VERIFICATION_AGENT_TYPE：verification agent 的类型名。
 *   - ONE_SHOT_BUILTIN_AGENT_TYPES：一次性内置 agent 集合（结果里省掉 SendMessage 尾巴）。
 *
 * 【TS 语法速查】
 *   - `export const X = 'a'`：导出常量。因为带 `const` 且是字面量初始化，
 *     TS 会把类型推导成字面量类型 'a'（而不是 string），这样联合类型收窄才有效。
 *   - `ReadonlySet<string>`：只读 Set，编译期禁止 add/delete（≈ Collections.unmodifiableSet）。
 *   - `new Set(['a','b'])` ≈ new HashSet<>(Arrays.asList("a","b"))。
 *   - 为什么要有 LEGACY 名字：权限规则和 hooks 配置是用户写在 settings.json 里的，
 *     里面可能写着 `Task(...)`。重命名工具后必须同时认旧名，否则用户的配置全部失效。
 */
// 工具现在的名字。历史上叫 Task，改名后旧名必须继续兼容（见下一个常量）
export const AGENT_TOOL_NAME = 'Agent'
// 旧名字 'Task'。三处还在用它：① 用户 settings.json 里的权限规则 ② hooks 配置
// ③ 已落盘的老会话（resume 时重放不能改名）。所以两个名字都要认。
// Legacy wire name for backward compat (permission rules, hooks, resumed sessions)
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'

// Built-in agents that run once and return a report — the parent never
// SendMessages back to continue them. Skip the agentId/SendMessage/usage
// trailer for these to save tokens (~135 chars × 34M Explore runs/week).
// 一次性内置 agent：跑完交一份报告就结束，主 Agent 从不 SendMessage 回去续跑。
// 所以结果里那句「agentId: xxx（可用 SendMessage 继续）」和 <usage> 块对它们纯属浪费 ——
// 每周 3400 万次 Explore × 约 135 字符，全省掉。
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])
