/**
 * 【一句话定位】内置 agent「Explore」的定义：快速的**只读**代码搜索专家。
 *
 * 【在架构中的位置】
 *   上游：builtInAgents.ts（受 BUILTIN_EXPLORE_PLAN_AGENTS + tengu_amber_stoat 双开关控制）。
 *   下游：loadAgentsDir.ts 的 BuiltInAgentDefinition 类型。
 *   工具裁剪：disallowedTools 里禁掉了 Agent / ExitPlanMode / Edit / Write / NotebookEdit，
 *   加上全局禁表，它实际只有读和只读 Bash 可用 —— 这是「只读」的**双重保险**：
 *   既在提示词里明令禁止，又让工具根本不存在（模型想改也改不了）。
 *
 * 【本文件包含什么】
 *   - getExploreSystemPrompt()：只读约束 + 搜索策略的 system prompt。
 *   - EXPLORE_AGENT_MIN_QUERIES：最少查询次数常量（给调用方做质量门槛）。
 *   - EXPLORE_WHEN_TO_USE：给模型看的「什么时候用我」。
 *   - EXPLORE_AGENT：agent 定义对象。
 *
 * 【TS 语法速查】
 *   - `hasEmbeddedSearchTools()`：判断当前构建是不是「内嵌搜索工具」版本
 *     （ant 内部构建把 find/grep 换成内置的 bfs/ugrep，并移除了 Glob/Grep 工具）。
 *     所以提示词里要动态选择「用 Glob 工具」还是「用 Bash 里的 find」。
 *   - 三元表达式嵌在模板字符串里：`${embedded ? `find` : `${GLOB_TOOL_NAME}`}`。
 *   - `process.env.USER_TYPE === 'ant'` 是编译期常量折叠的常见写法：
 *     'ant' 是字面量，构建时若为外部版则整段被替换成 false 再被删掉。
 *   - `disallowedTools: [...]`：黑名单。它和 tools 白名单可以同时存在，
 *     运行时先按白名单取，再减掉黑名单（见 agentToolUtils.resolveAgentTools）。
 *   - `omitClaudeMd: true`：丢掉 CLAUDE.md（只读搜索 agent 不需要提交/PR/lint 规范）。
 *   - `model: 'haiku'`（外部）/ `'inherit'`（ant 内部）：外部用小模型求快，ant 内部跟随主模型。
 *   - `readonly` / `as const` 等语法见其它文件头部说明。
 */
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

/**
 * 生成 Explore agent 的 system prompt。
 * 设计要点：不只是说「你是搜索专家」，而是用大量**禁止项**把它的行为框死 ——
 * 连 `>` `>>` `|` 这类重定向和 /tmp 下建临时文件都明确禁止，
 * 因为 LLM 很容易为了「方便」偷偷写文件。
 */
function getExploreSystemPrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep via Bash instead.
// ant 内部构建把 find/grep 换成内嵌的 bfs/ugrep 并移除了 Glob/Grep 工具，
// 所以提示词要指向 Bash 里的 find / grep
  const embedded = hasEmbeddedSearchTools()
  const globGuidance = embedded
    ? `- Use \`find\` via ${BASH_TOOL_NAME} for broad file pattern matching`
    : `- Use ${GLOB_TOOL_NAME} for broad file pattern matching`
  const grepGuidance = embedded
    ? `- Use \`grep\` via ${BASH_TOOL_NAME} for searching file contents with regex`
    : `- Use ${GREP_TOOL_NAME} for searching file contents with regex`

  return `You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
${globGuidance}
${grepGuidance}
- Use ${FILE_READ_TOOL_NAME} when you know the specific file path you need to read
- Use ${BASH_TOOL_NAME} ONLY for read-only operations (ls, git status, git log, git diff, find${embedded ? ', grep' : ''}, cat, head, tail)
- NEVER use ${BASH_TOOL_NAME} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`
}

// 最少查询次数：调用方可以用它做质量门槛（搜索得太少说明没认真找）
export const EXPLORE_AGENT_MIN_QUERIES = 3

const EXPLORE_WHEN_TO_USE =
  'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'

// agent 定义。注意 tools 字段**没有**填 —— 不填等于默认全允许，
// 只读约束完全靠 disallowedTools 黑名单 + 全局禁表实现
export const EXPLORE_AGENT: BuiltInAgentDefinition = {
  agentType: 'Explore',
  whenToUse: EXPLORE_WHEN_TO_USE,
// 禁掉这五个：不能再生子 Agent、不能交计划、不能改文件、不能改 notebook
// （和提示词里的禁止项一一对应，双保险）
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // Ants get inherit to use the main agent's model; external users get haiku for speed
  // Note: For ants, getAgentModel() checks tengu_explore_agent GrowthBook flag at runtime
// 外部用户用 haiku 求快（Explore 定位就是快速搜索）；ant 内部继承主模型，
// 实际还会看 tengu_explore_agent 这个 GrowthBook flag 再决定
  model: process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku',
  // Explore is a fast read-only search agent — it doesn't need commit/PR/lint
  // rules from CLAUDE.md. The main agent has full context and interprets results.
// 只读搜索 agent 不需要 CLAUDE.md 里的提交规范/PR 规范，省 token
  omitClaudeMd: true,
  getSystemPrompt: () => getExploreSystemPrompt(),
}
