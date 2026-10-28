/**
 * 【一句话定位】内置 agent「general-purpose」的定义：什么都能干的通用子 Agent，
 * 也是省略 subagent_type 时的默认选择（fork 开关没开时）。
 *
 * 【在架构中的位置】
 *   上游：builtInAgents.ts 的 getBuiltInAgents()（永远在名单里）、
 *        AgentTool.tsx（默认 agent）、resumeAgent.ts（找不到原定义时的兜底）。
 *   下游：loadAgentsDir.ts 的 BuiltInAgentDefinition 类型。
 *
 * 【本文件包含什么】
 *   - SHARED_PREFIX / SHARED_GUIDELINES：通用子 Agent 的提示词片段（其它 agent 也复用）。
 *   - getGeneralPurposeSystemPrompt()：拼出完整 system prompt。
 *   - GENERAL_PURPOSE_AGENT：agent 定义对象。
 *
 * 【TS 语法速查】
 *   - `import type { X } from '...'`：只导入类型，编译后整行消失（不产生运行时依赖）。
 *   - 模板字符串 `` `a${b}c` `` ≈ Java 文本块 + 插值。
 *   - `export const X: T = {...}`：导出一个带显式类型标注的常量对象。
 *   - 类型标注写在变量名**后面**（Java 在前面）：`const AGENT: BuiltInAgentDefinition = {...}`。
 *   - `tools: ['*']` 里的 '*' 是通配符：表示「不限制工具」（运行时仍会被全局禁表过滤）。
 *   - 注释里写了 model 字段**故意不填**：留空则会走 getDefaultSubagentModel() 的默认值，
 *     比在这里硬编码一个模型名更灵活（默认值会随产品策略调整）。
 */
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

// 通用前缀：所有子 Agent 共用的身份说明。
// 注意「don't gold-plate, but don't leave it half-done」—— 提醒别过度设计也别半途而废
const SHARED_PREFIX = `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.`

// 通用行为准则：搜索要广、分析要先广后窄、不要随便建文件、不要主动写文档
const SHARED_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`

// 绝对路径 + emoji 相关的指引由 enhanceSystemPromptWithEnvDetails 统一追加（不在这里写死），
// 因为这类环境相关的提示词要随运行环境和模型变化
// Note: absolute-path + emoji guidance is appended by enhanceSystemPromptWithEnvDetails.
function getGeneralPurposeSystemPrompt(): string {
  return `${SHARED_PREFIX} When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

${SHARED_GUIDELINES}`
}

// agent 定义对象。tools: ['*'] = 不额外限制（全局禁表仍会生效，比如不能再生子 Agent）
export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  whenToUse:
    'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
// 故意不写 model：留空走 getDefaultSubagentModel()，默认值由产品侧统一控制
  // model is intentionally omitted - uses getDefaultSubagentModel().
  getSystemPrompt: getGeneralPurposeSystemPrompt,
}
