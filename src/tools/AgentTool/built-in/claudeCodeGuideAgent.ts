/**
 * 【一句话定位】内置 agent「claude-code-guide」的定义：专门回答「Claude 能不能…/怎么用…」
 * 这类问题的答疑 agent，靠**拉取官方文档**作答，而不是靠模型自己的记忆。
 *
 * 【在架构中的位置】
 *   上游：builtInAgents.ts（非 SDK 入口才加载）。
 *   下游：WebFetch / WebSearch 工具（抓文档地图和具体页面）。
 *   注意：它是少数把 getSystemPrompt 写成**函数**而非常量的内置 agent ——
 *   因为它要把当前项目的自定义 skills / agents / MCP / 插件命令 / 用户设置拼进提示词，
 *   让回答能贴合用户实际环境（这也是 BuiltInAgentDefinition 支持 toolUseContext 参数的原因）。
 *
 * 【本文件包含什么】
 *   - CLAUDE_CODE_DOCS_MAP_URL / CDP_DOCS_MAP_URL：两个文档地图的 URL。
 *   - getClaudeCodeGuideBasePrompt()：三大领域（Claude Code / Agent SDK / Claude API）的说明。
 *   - getFeedbackGuideline()：找不到答案时该引导用户去哪反馈（3P 服务没有 /feedback 命令）。
 *   - CLAUDE_CODE_GUIDE_AGENT：agent 定义对象（含动态 getSystemPrompt）。
 *
 * 【TS 语法速查】
 *   - 对象方法简写 `getSystemPrompt({ toolUseContext }) { ... }`：
 *     这是 `{ getSystemPrompt: function({toolUseContext}) {...} }` 的简写，
 *     且参数位置直接解构（从入参对象里取出 toolUseContext 字段）。
 *   - `commands.filter(cmd => cmd.type === 'prompt')`：类型谓词式过滤，
 *     filter 返回真后 TS 会把 cmd 收窄成有 'prompt' 类型的那个联合成员。
 *   - `arr.map(fn).join('\n')`：把数组转成用换行连接的字符串 ≈ Collectors.joining。
 *   - `Object.keys(o).length` ≈ map.size()。
 *   - `MACRO.ISSUES_EXPLAINER`：构建期宏替换的常量（编译时会替换成实际文案）。
 *   - `isUsing3PServices()`：判断是否走 Bedrock/Vertex/Foundry 等三方服务
 *     （这些渠道没有 /feedback 命令，所以要换一套引导话术）。
 *   - `jsonStringify(settings, null, 2)` ≈ new GsonBuilder().setPrettyPrinting()：
 *     第三个参数 2 是缩进空格数。
 *   - 模板字符串、三元、可选链等基础语法见其它文件头部说明。
 */
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { isUsing3PServices } from 'src/utils/auth.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../loadAgentsDir.js'

// 两份文档地图的 URL。为什么要「地图」而不是直接给文档站首页：
// 地图是一个精简的 URL 索引，一次 WebFetch 就能拿到全部页面的地址，
// 比让模型自己猜 URL 或多次搜索便宜得多、也准得多。
const CLAUDE_CODE_DOCS_MAP_URL =
  'https://code.claude.com/docs/en/claude_code_docs_map.md'
const CDP_DOCS_MAP_URL = 'https://platform.claude.com/llms.txt'

export const CLAUDE_CODE_GUIDE_AGENT_TYPE = 'claude-code-guide'

/**
 * 生成基础提示词。核心是让模型先判断问题属于哪个领域（Claude Code CLI / Agent SDK /
 * Claude API），再去抓对应的文档，而不是凭记忆回答（模型记忆里的 API 细节常常过时）。
 */
function getClaudeCodeGuideBasePrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep instead.
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `You are the Claude guide agent. Your primary responsibility is helping users understand and use Claude Code, the Claude Agent SDK, and the Claude API (formerly the Anthropic API) effectively.

**Your expertise spans three domains:**

1. **Claude Code** (the CLI tool): Installation, configuration, hooks, skills, MCP servers, keyboard shortcuts, IDE integrations, settings, and workflows.

2. **Claude Agent SDK**: A framework for building custom AI agents based on Claude Code technology. Available for Node.js/TypeScript and Python.

3. **Claude API**: The Claude API (formerly known as the Anthropic API) for direct model interaction, tool use, and integrations.

**Documentation sources:**

- **Claude Code docs** (${CLAUDE_CODE_DOCS_MAP_URL}): Fetch this for questions about the Claude Code CLI tool, including:
  - Installation, setup, and getting started
  - Hooks (pre/post command execution)
  - Custom skills
  - MCP server configuration
  - IDE integrations (VS Code, JetBrains)
  - Settings files and configuration
  - Keyboard shortcuts and hotkeys
  - Subagents and plugins
  - Sandboxing and security

- **Claude Agent SDK docs** (${CDP_DOCS_MAP_URL}): Fetch this for questions about building agents with the SDK, including:
  - SDK overview and getting started (Python and TypeScript)
  - Agent configuration + custom tools
  - Session management and permissions
  - MCP integration in agents
  - Hosting and deployment
  - Cost tracking and context management
  Note: Agent SDK docs are part of the Claude API documentation at the same URL.

- **Claude API docs** (${CDP_DOCS_MAP_URL}): Fetch this for questions about the Claude API (formerly the Anthropic API), including:
  - Messages API and streaming
  - Tool use (function calling) and Anthropic-defined tools (computer use, code execution, web search, text editor, bash, programmatic tool calling, tool search tool, context editing, Files API, structured outputs)
  - Vision, PDF support, and citations
  - Extended thinking and structured outputs
  - MCP connector for remote MCP servers
  - Cloud provider integrations (Bedrock, Vertex AI, Foundry)

**Approach:**
1. Determine which domain the user's question falls into
2. Use ${WEB_FETCH_TOOL_NAME} to fetch the appropriate docs map
3. Identify the most relevant documentation URLs from the map
4. Fetch the specific documentation pages
5. Provide clear, actionable guidance based on official documentation
6. Use ${WEB_SEARCH_TOOL_NAME} if docs don't cover the topic
7. Reference local project files (CLAUDE.md, .claude/ directory) when relevant using ${localSearchHint}

**Guidelines:**
- Always prioritize official documentation over assumptions
- Keep responses concise and actionable
- Include specific examples or code snippets when helpful
- Reference exact documentation URLs in your responses
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities

Complete the user's request by providing accurate, documentation-based guidance.`
}

/**
 * 生成「找不到答案时怎么反馈」的指引。
 * 三方服务（Bedrock/Vertex/Foundry）下 /feedback 命令被禁用了，要换成问题反馈渠道的说明。
 */
function getFeedbackGuideline(): string {
  // For 3P services (Bedrock/Vertex/Foundry), /feedback command is disabled
  // Direct users to the appropriate feedback channel instead
  if (isUsing3PServices()) {
    return `- When you cannot find an answer or the feature doesn't exist, direct the user to ${MACRO.ISSUES_EXPLAINER}`
  }
  return "- When you cannot find an answer or the feature doesn't exist, direct the user to use /feedback to report a feature request or bug"
}

// agent 定义。注意 whenToUse 里明确要求：起新 agent 之前先看看有没有已存在/刚跑完的
// claude-code-guide agent 可以 SendMessage 续跑（避免重复拉文档）
export const CLAUDE_CODE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: CLAUDE_CODE_GUIDE_AGENT_TYPE,
  whenToUse: `Use this agent when the user asks questions ("Can Claude...", "Does Claude...", "How do I...") about: (1) Claude Code (the CLI tool) - features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) Claude Agent SDK - building custom agents; (3) Claude API (formerly Anthropic API) - API usage, tool use, Anthropic SDK usage. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed claude-code-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}.`,
  // Ant-native builds: Glob/Grep tools are removed; use Bash (with embedded
  // bfs/ugrep via find/grep aliases) for local file search instead.
// 工具白名单按构建形态切换：内嵌搜索版本用 Bash(find/grep)，否则用 Glob/Grep
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: 'built-in',
  baseDir: 'built-in',
// model 用 haiku：答疑场景不需要强推理，且要快
  model: 'haiku',
// permissionMode: 'dontAsk' —— 它只做只读的文档查阅，不需要任何权限提示
  permissionMode: 'dontAsk',
/**
 * 动态生成 system prompt：基础提示词 + 当前环境的实际配置。
 * 拼进去的五类上下文（自定义 skills / 自定义 agents / MCP servers / 插件命令 / 用户设置）
 * 都是为了让回答能说「你项目里已经装了 X，可以用它…」，而不是给一堆通用建议。
 *
 * @param params.toolUseContext 当前上下文，从 options.commands / agentDefinitions / mcpClients 取信息
 */
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // Build context sections
    const contextSections: string[] = []

    // 1. Custom skills
// ① 项目里的自定义 skills（斜杠命令）
    const customCommands = commands.filter(cmd => cmd.type === 'prompt')
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(
        `**Available custom skills in this project:**\n${commandList}`,
      )
    }

    // 2. Custom agents from .claude/agents/
// ② .claude/agents/ 下的自定义 agent（排除内置的）
    const customAgents =
      toolUseContext.options.agentDefinitions.activeAgents.filter(
        (a: AgentDefinition) => a.source !== 'built-in',
      )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join('\n')
      contextSections.push(
        `**Available custom agents configured:**\n${agentList}`,
      )
    }

    // 3. MCP servers
// ③ 已配置的 MCP servers
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients
        .map((client: { name: string }) => `- ${client.name}`)
        .join('\n')
      contextSections.push(`**Configured MCP servers:**\n${mcpList}`)
    }

    // 4. Plugin commands
// ④ 插件提供的 skills
    const pluginCommands = commands.filter(
      cmd => cmd.type === 'prompt' && cmd.source === 'plugin',
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(`**Available plugin skills:**\n${pluginList}`)
    }

    // 5. User settings
// ⑤ 用户的 settings.json（原样附上，方便回答配置类问题）
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(
        `**User's settings.json:**\n\`\`\`json\n${settingsJson}\n\`\`\``,
      )
    }

    // Add the feedback guideline (conditional based on whether user is using 3P services)
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getClaudeCodeGuideBasePrompt()}
${feedbackGuideline}`

    // If we have any context to add, append it to the base system prompt
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join('\n\n')}

When answering questions, consider these configured features and proactively suggest them when relevant.`
    }

    // Return the base prompt if no context to add
    return basePromptWithFeedback
  },
}
