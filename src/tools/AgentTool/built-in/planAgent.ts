/**
 * 【一句话定位】内置 agent「Plan」的定义：只读的**架构规划**专家，产出实现方案而不是代码。
 *
 * 【在架构中的位置】
 *   上游：builtInAgents.ts（和 Explore 共用同一个开关）。
 *   下游：loadAgentsDir.ts 的 BuiltInAgentDefinition 类型；工具集直接复用 EXPLORE_AGENT 的。
 *   和 Explore 的区别：Explore 回答「代码里现在是什么」，Plan 回答「应该怎么改」。
 *   两者都是只读，所以 disallowedTools 完全一致。
 *
 * 【本文件包含什么】
 *   - getPlanV2SystemPrompt()：规划流程（理解需求 → 探索 → 设计 → 细化）+ 输出格式要求。
 *   - PLAN_AGENT：agent 定义对象。
 *
 * 【TS 语法速查】
 *   - `tools: EXPLORE_AGENT.tools`：直接复用另一个 agent 定义的 tools 字段
 *     （这里 EXPLORE_AGENT.tools 是 undefined，等于「不限制」，配合 disallowedTools 使用）。
 *   - 模板字符串里嵌套三元：`${hasEmbeddedSearchTools() ? ', grep' : ''}` ——
 *     条件成立时插入一段文本，否则插入空串（本文件多处这样用）。
 *   - `model: 'inherit'` 跟随主模型：规划任务需要强推理能力，不能用小模型。
 *   - `omitClaudeMd: true`：和 Explore 同理，但它仍可以自己 Read CLAUDE.md 查规范
 *     （只是不塞进上下文），所以不会真的拿不到约定。
 *   - 类型标注、可选属性、箭头函数等基础语法见其它文件头部说明。
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
import { EXPLORE_AGENT } from './exploreAgent.js'

/**
 * 生成 Plan agent 的 system prompt。
 * 结构设计成四步流程（理解 → 探索 → 设计 → 细化），最后强制要求输出
 * 「### Critical Files for Implementation」清单 —— 调用方要靠它知道该改哪些文件。
 */
function getPlanV2SystemPrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep instead.
// 内嵌搜索工具版本下用 find/grep，否则用 Glob/Grep 工具
  const searchToolsHint = hasEmbeddedSearchTools()
    ? `\`find\`, \`grep\`, and ${FILE_READ_TOOL_NAME}`
    : `${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, and ${FILE_READ_TOOL_NAME}`

  return `You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using ${searchToolsHint}
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use ${BASH_TOOL_NAME} ONLY for read-only operations (ls, git status, git log, git diff, find${hasEmbeddedSearchTools() ? ', grep' : ''}, cat, head, tail)
   - NEVER use ${BASH_TOOL_NAME} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`
}

// agent 定义。工具集合直接复用 EXPLORE_AGENT 的（两者都是只读，限制相同）
export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: 'Plan',
  whenToUse:
    'Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.',
// 和 Explore 完全相同的禁用清单：不能派生、不能交计划、不能改文件/notebook
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  tools: EXPLORE_AGENT.tools,
  baseDir: 'built-in',
// 跟随主模型：规划需要强推理
  model: 'inherit',
  // Plan is read-only and can Read CLAUDE.md directly if it needs conventions.
  // Dropping it from context saves tokens without blocking access.
// 和 Explore 一样丢掉 CLAUDE.md 省 token；它真需要规范时可以自己 Read
  omitClaudeMd: true,
  getSystemPrompt: () => getPlanV2SystemPrompt(),
}
