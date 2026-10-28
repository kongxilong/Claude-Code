/**
 * 【一句话定位】agent 定义的**加载与解析层**：从 .claude/agents/ 下的 .md 文件（frontmatter + 正文）、
 * 插件、以及 JSON 设置（flag/policy）里读出所有 agent 定义，解析成统一的 AgentDefinition 结构。
 *
 * 【在架构中的位置】
 *   上游：bootstrap（启动时）/ tools.ts（组装工具表时）/ /agents 命令 / reload-plugins 时。
 *   下游：
 *     utils/markdownConfigLoader.js —— 真正扫描磁盘上的 .md 文件并拆出 frontmatter
 *     utils/plugins/loadPluginAgents.js —— 插件提供的 agent
 *     builtInAgents.ts —— 内置 agent（general-purpose / Explore / Plan / ...）
 *     agentMemory.ts / agentMemorySnapshot.ts —— agent 的持久化记忆与快照
 *   产出物 AgentDefinitionsResult 会被塞进 ToolUseContext.options.agentDefinitions，
 *   然后由 AgentTool.tsx 的 prompt() 渲染成给模型看的可用 agent 列表。
 *
 * 【本文件包含什么】
 *   - AgentMcpServerSpec / AgentMcpServerSpecSchema：agent 专属 MCP server 的两种写法（引用 / 内联）。
 *   - AgentJsonSchema / AgentsJsonSchema：JSON 形式 agent 定义的 zod 校验。
 *   - BaseAgentDefinition / BuiltInAgentDefinition / CustomAgentDefinition / PluginAgentDefinition：
 *     四类 agent 定义类型，以及 isBuiltInAgent/isCustomAgent/isPluginAgent 三个类型守卫。
 *   - getActiveAgentsFromList()：按来源优先级去重，算出「最终生效」的 agent 列表。
 *   - hasRequiredMcpServers() / filterAgentsByMcpRequirements()：按 MCP 依赖过滤 agent。
 *   - getAgentDefinitionsWithOverrides()：**主入口**，扫描并汇总所有 agent（带 memoize 缓存）。
 *   - parseAgentFromJson() / parseAgentsFromJson() / parseAgentFromMarkdown()：三种来源的解析器。
 *   - initializeAgentMemorySnapshots()：给开了记忆的 agent 做本地记忆初始化。
 *
 * 【agent 来源与优先级】(getActiveAgentsFromList 里的顺序即优先级，后面的覆盖前面的)
 *   builtIn（内置）→ plugin（插件）→ userSettings → projectSettings → flagSettings → policySettings
 *   同名 agent 只保留优先级最高的那个。注意顺序里 flag 在 managed 之前，
 *   但 policySettings（管理员下发）排最后，所以最终是它赢。
 *
 * 【TS 语法速查】(针对本文件实际出现的语法)
 *   - `type X = A | B` 联合类型 ≈ Java sealed interface：
 *     AgentDefinition = 内置 | 自定义 | 插件，只能用 isBuiltInAgent() 之类的守卫来区分。
 *   - `A & B` 交叉类型 ≈ 同时 implements 两个接口：
 *     `type CustomAgentDefinition = BaseAgentDefinition & { source: ... }` = 基础字段 + 自己的字段。
 *   - `x is T` 类型谓词 ≈ instanceof 模式匹配：调用后 TS 自动收窄类型。
 *   - `{ [name: string]: McpServerConfig }` 索引签名 ≈ Map<String, McpServerConfig>，
 *     表示「键名任意、值类型固定」的字典对象。
 *   - 类型标注在变量名**后面**（Java 在前面）：`const x: string[] = []`。
 *   - `z.union([A, B])` / `z.record(k, v)` / `z.enum([...])`：zod 的联合 / 字典 / 枚举校验器。
 *     `z.enum(['a','b'])` 会把类型推导成字面量联合 `'a' | 'b'`，≈ Java enum。
 *   - `.transform(fn)`：zod 的「校验通过后转换」，这里把 'inherit' 统一成小写。
 *   - `lazySchema(() => ...)`：延迟构造，用来打断模块加载期的循环依赖
 *     （注释里写了 AppState → loadAgentsDir → settings/types 这条环）。
 *   - `memoize(async (cwd) => {...})`：lodash 的 memoize，按参数缓存 async 结果。
 *     `.cache.clear?.()` 的 `?.` 是可选调用——方法不存在就不调（memoize 的 WeakMap 可能没有 clear）。
 *   - `Object.entries(o)` ≈ map.entrySet()；`Object.keys(o).length` ≈ map.size()。
 *   - `arr.map(fn).filter(x => x !== null)`：map 完再过滤，
 *     但 TS 不知道 null 已被滤掉，所以要写类型谓词版 filter：
 *     `.filter((a): a is CustomAgentDefinition => a !== null)`。
 *   - `{ ...(cond ? { k: v } : {}) }` 条件展开：条件不满足时展开一个空对象，等于不加这个字段。
 *     本文件到处都是这个写法，目的是「字段不存在时不要塞 undefined 进去」（影响 zod 校验和 JSON）。
 *   - `!` 后缀非空断言（`entries[0]!`）；`??` 空值合并；`?.` 可选链。
 *   - `switch` 穷尽联合类型：TS 能保证每个 case 都覆盖（少写一个会报错），≈ Java 17 的 switch 模式匹配。
 *   - `switch` 里没有 default 但函数仍返回值，是因为联合类型已被穷尽，TS 认为不可能走到最后。
 *   - `error instanceof Error ? error.message : String(error)`：
 *     JS 的 throw 可以抛任意值（不一定是 Error 实例），这个三元是标准的取错误信息惯用法。
 */
import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { z } from 'zod/v4'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  type McpServerConfig,
  McpServerConfigSchema,
} from '../../services/mcp/types.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  EFFORT_LEVELS,
  type EffortValue,
  parseEffortValue,
} from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { parsePositiveIntFromFrontmatter } from '../../utils/frontmatterParser.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  loadMarkdownFilesForSubdir,
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
} from '../../utils/markdownConfigLoader.js'
import {
  PERMISSION_MODES,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import {
  clearPluginAgentCache,
  loadPluginAgents,
} from '../../utils/plugins/loadPluginAgents.js'
import { HooksSchema, type HooksSettings } from '../../utils/settings/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import {
  AGENT_COLORS,
  type AgentColorName,
  setAgentColor,
} from './agentColorManager.js'
import { type AgentMemoryScope, loadAgentMemoryPrompt } from './agentMemory.js'
import {
  checkAgentMemorySnapshot,
  initializeFromSnapshot,
} from './agentMemorySnapshot.js'
import { getBuiltInAgents } from './builtInAgents.js'

// agent 专属 MCP server 的两种写法：
//   ① 字符串 —— 引用一个已在设置里配好的 server（如 'slack'），走共享连接
//   ② 对象   —— { 名字: 配置 } 的内联定义，只属于这个 agent，结束时清理
// Type for MCP server specification in agent definitions
// Can be either a reference to an existing server by name, or an inline definition as { [name]: config }
export type AgentMcpServerSpec =
  | string // Reference to existing server by name (e.g., "slack")
  | { [name: string]: McpServerConfig } // Inline definition as { name: config }

// Zod schema for agent MCP server specs
const AgentMcpServerSpecSchema = lazySchema(() =>
  z.union([
    z.string(), // Reference by name
    z.record(z.string(), McpServerConfigSchema()), // Inline as { name: config }
  ]),
)

// JSON 形式 agent 定义的校验器。用 lazySchema 是有原因的：
// HooksSchema 本身也是 lazy 的，这样能打断 AppState → loadAgentsDir → settings/types 的循环依赖
// Zod schemas for JSON agent validation
// Note: HooksSchema is lazy so the circular chain AppState -> loadAgentsDir -> settings/types
// is broken at module load time
const AgentJsonSchema = lazySchema(() =>
  z.object({
    description: z.string().min(1, 'Description cannot be empty'),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    prompt: z.string().min(1, 'Prompt cannot be empty'),
    model: z
      .string()
      .trim()
      .min(1, 'Model cannot be empty')
      .transform(m => (m.toLowerCase() === 'inherit' ? 'inherit' : m))
      .optional(),
    effort: z.union([z.enum(EFFORT_LEVELS), z.number().int()]).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    mcpServers: z.array(AgentMcpServerSpecSchema()).optional(),
    hooks: HooksSchema().optional(),
    maxTurns: z.number().int().positive().optional(),
    skills: z.array(z.string()).optional(),
    initialPrompt: z.string().optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    background: z.boolean().optional(),
    isolation: (process.env.USER_TYPE === 'ant'
      ? z.enum(['worktree', 'remote'])
      : z.enum(['worktree'])
    ).optional(),
  }),
)

const AgentsJsonSchema = lazySchema(() =>
  z.record(z.string(), AgentJsonSchema()),
)

// 四类 agent 共通的字段。agent 的能力（工具/模型/权限/记忆/隔离）全在这里声明。
// Base type with common fields for all agents
export type BaseAgentDefinition = {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[] // Skill names to preload (parsed from comma-separated frontmatter)
// skills：frontmatter 里用逗号分隔声明的 skill 名，agent 启动时预加载
  mcpServers?: AgentMcpServerSpec[] // MCP servers specific to this agent
// hooks：agent 生命周期内生效的 session 级钩子（agent 结束时清掉）
  hooks?: HooksSettings // Session-scoped hooks registered when agent starts
  color?: AgentColorName
  model?: string
  effort?: EffortValue
  permissionMode?: PermissionMode
  maxTurns?: number // Maximum number of agentic turns before stopping
  filename?: string // Original filename without .md extension (for user/project/managed agents)
  baseDir?: string
// criticalSystemReminder_EXPERIMENTAL：每一轮 user turn 都会重新注入的一句提醒
// （比如 verification agent 用它反复强调「你只能验证不能改文件」）
  criticalSystemReminder_EXPERIMENTAL?: string // Short message re-injected at every user turn
  requiredMcpServers?: string[] // MCP server name patterns that must be configured for agent to be available
  background?: boolean // Always run as background task when spawned
// background: true 表示这个 agent 被派生时一定以后台任务方式跑
  initialPrompt?: string // Prepended to the first user turn (slash commands work)
  memory?: AgentMemoryScope // Persistent memory scope
// isolation：'worktree' 开独立 git worktree；'remote' 搬到远端 CCR（仅 ant 内部）
  isolation?: 'worktree' | 'remote' // Run in an isolated git worktree, or remotely in CCR (ant-only)
  pendingSnapshotUpdate?: { snapshotTimestamp: string }
  /** Omit CLAUDE.md hierarchy from the agent's userContext. Read-only agents
   * (Explore, Plan) don't need commit/PR/lint guidelines — the main agent has
   * full CLAUDE.md and interprets their output. Saves ~5-15 Gtok/week across
   * 34M+ Explore spawns. Kill-switch: tengu_slim_subagent_claudemd. */
  omitClaudeMd?: boolean
}

// 内置 agent：没有静态 systemPrompt 字段，只有一个 getSystemPrompt 函数
// （因为内置 prompt 里要按运行时环境动态拼工具名、是否内嵌搜索工具等）
// Built-in agents - dynamic prompts only, no static systemPrompt field
export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: 'built-in'
  callback?: () => void
  getSystemPrompt: (params: {
    toolUseContext: Pick<ToolUseContext, 'options'>
  }) => string
}

// 自定义 agent（用户/项目/策略来源）：prompt 通过闭包捕获（解析时就把正文存进闭包了）
// Custom agents from user/project/policy settings - prompt stored via closure
export type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: SettingSource
  filename?: string
  baseDir?: string
}

// 插件 agent：和自定义类似，但多一个 plugin 字段标记它属于哪个插件
// Plugin agents - similar to custom but with plugin metadata, prompt stored via closure
export type PluginAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'plugin'
  filename?: string
  plugin: string
}

// Union type for all agent types
export type AgentDefinition =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | PluginAgentDefinition

// 类型守卫（type guard）：运行时判断 agent 属于哪一类别，
// 返回类型是 `agent is X`，调用后 TS 自动把变量收窄成 X（≈ instanceof 模式匹配）
// Type guards for runtime type checking
export function isBuiltInAgent(
  agent: AgentDefinition,
): agent is BuiltInAgentDefinition {
  return agent.source === 'built-in'
}

export function isCustomAgent(
  agent: AgentDefinition,
): agent is CustomAgentDefinition {
  return agent.source !== 'built-in' && agent.source !== 'plugin'
}

export function isPluginAgent(
  agent: AgentDefinition,
): agent is PluginAgentDefinition {
  return agent.source === 'plugin'
}

// 加载结果：activeAgents 是去重后真正生效的，allAgents 是全部（含被覆盖的，给 /agents 列表用）
export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[]
  allAgents: AgentDefinition[]
  failedFiles?: Array<{ path: string; error: string }>
  allowedAgentTypes?: string[]
}

/**
 * 按来源优先级把「全部 agent」收敛成「生效 agent」列表。
 * 做法：按优先级从低到高依次把 agent 塞进 Map（同名覆盖），
 * 所以越靠后的分组优先级越高。最后取 Map 的 values。
 */
export function getActiveAgentsFromList(
  allAgents: AgentDefinition[],
): AgentDefinition[] {
  const builtInAgents = allAgents.filter(a => a.source === 'built-in')
  const pluginAgents = allAgents.filter(a => a.source === 'plugin')
  const userAgents = allAgents.filter(a => a.source === 'userSettings')
  const projectAgents = allAgents.filter(a => a.source === 'projectSettings')
  const managedAgents = allAgents.filter(a => a.source === 'policySettings')
  const flagAgents = allAgents.filter(a => a.source === 'flagSettings')

  const agentGroups = [
    builtInAgents,
    pluginAgents,
    userAgents,
    projectAgents,
    flagAgents,
    managedAgents,
  ]

  const agentMap = new Map<string, AgentDefinition>()

  for (const agents of agentGroups) {
    for (const agent of agents) {
      agentMap.set(agent.agentType, agent)
    }
  }

  return Array.from(agentMap.values())
}

/**
 * 判断一个 agent 声明的 requiredMcpServers 是否都已在可用 server 列表里。
 * 匹配是**忽略大小写的子串匹配**（不是全等），方便写 'slack' 匹配到 'slack-workspace'。
 */
/**
 * Checks if an agent's required MCP servers are available.
 * Returns true if no requirements or all requirements are met.
 * @param agent The agent to check
 * @param availableServers List of available MCP server names (e.g., from mcp.clients)
 */
export function hasRequiredMcpServers(
  agent: AgentDefinition,
  availableServers: string[],
): boolean {
  if (!agent.requiredMcpServers || agent.requiredMcpServers.length === 0) {
    return true
  }
  // Each required pattern must match at least one available server (case-insensitive)
  return agent.requiredMcpServers.every(pattern =>
    availableServers.some(server =>
      server.toLowerCase().includes(pattern.toLowerCase()),
    ),
  )
}

/**
 * 过滤掉依赖的 MCP server 没配好的 agent——那些 agent 不该出现在给模型看的列表里，
 * 否则模型选了它，跑起来才发现工具全缺。
 */
/**
 * Filters agents based on MCP server requirements.
 * Only returns agents whose required MCP servers are available.
 * @param agents List of agents to filter
 * @param availableServers List of available MCP server names
 */
export function filterAgentsByMcpRequirements(
  agents: AgentDefinition[],
  availableServers: string[],
): AgentDefinition[] {
  return agents.filter(agent => hasRequiredMcpServers(agent, availableServers))
}

/**
 * 给开了 `memory: 'user'` 的 agent 做本地记忆初始化。
 * 两种动作：本地完全没有记忆 → 从项目快照拷一份（initialize）；
 * 本地有但快照更新 → 只记一个 pendingSnapshotUpdate 标记（prompt-update），不直接覆盖用户的记忆。
 */
/**
 * Check for and initialize agent memory from project snapshots.
 * For agents with memory enabled, copies snapshot to local if no local memory exists.
 * For agents with newer snapshots, logs a debug message (user prompt TODO).
 */
async function initializeAgentMemorySnapshots(
  agents: CustomAgentDefinition[],
): Promise<void> {
  await Promise.all(
    agents.map(async agent => {
      if (agent.memory !== 'user') return
      const result = await checkAgentMemorySnapshot(
        agent.agentType,
        agent.memory,
      )
// switch 覆盖联合类型的全部取值；TS 会检查穷尽性，漏一个 case 编译报错
      switch (result.action) {
        case 'initialize':
          logForDebugging(
            `Initializing ${agent.agentType} memory from project snapshot`,
          )
          await initializeFromSnapshot(
            agent.agentType,
            agent.memory,
            result.snapshotTimestamp!,
          )
          break
        case 'prompt-update':
          agent.pendingSnapshotUpdate = {
            snapshotTimestamp: result.snapshotTimestamp!,
          }
          logForDebugging(
            `Newer snapshot available for ${agent.agentType} memory (snapshot: ${result.snapshotTimestamp})`,
          )
          break
      }
    }),
  )
}

/**
 * 加载所有 agent 定义的**主入口**（按 cwd 记忆化，避免重复扫盘）。
 *
 * 关键步骤：
 *   ① CLAUDE_CODE_SIMPLE 环境变量 → 只返回内置 agent（简单模式，不加载用户/项目 agent）
 *   ② loadMarkdownFilesForSubdir('agents', cwd) 扫描 .claude/agents/ 下的 .md
 *   ③ 逐个 parseAgentFromMarkdown 解析；解析失败的记进 failedFiles
 *   ④ 并发加载插件 agent 和记忆快照初始化（两者互不依赖）
 *   ⑤ 汇总 内置 + 插件 + 自定义 → getActiveAgentsFromList 去重 → 注册颜色
 *   ⑥ 出错时也不返回空：至少把内置 agent 交出去（不能因为一个 .md 写错就全盘瘫痪）
 */
export const getAgentDefinitionsWithOverrides = memoize(
  async (cwd: string): Promise<AgentDefinitionsResult> => {
    // Simple mode: skip custom agents, only return built-ins
// 简单模式：只给内置 agent，跳过用户/项目/插件 agent（给想要干净起点的场景用）
    if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const builtInAgents = getBuiltInAgents()
      return {
        activeAgents: builtInAgents,
        allAgents: builtInAgents,
      }
    }

    try {
      const markdownFiles = await loadMarkdownFilesForSubdir('agents', cwd)

      const failedFiles: Array<{ path: string; error: string }> = []
      const customAgents = markdownFiles
        .map(({ filePath, baseDir, frontmatter, content, source }) => {
          const agent = parseAgentFromMarkdown(
            filePath,
            baseDir,
            frontmatter,
            content,
            source,
          )
// 没有 name 字段的 .md 静默跳过 —— 它很可能只是和 agent 定义放在同一个目录里的参考文档，
// 不是写坏的 agent。只有「看起来像 agent（有 name 字段）但解析失败」的才报错。
          if (!agent) {
            // Skip non-agent markdown files silently (e.g., reference docs
            // co-located with agent definitions). Only report errors for files
            // that look like agent attempts (have a 'name' field in frontmatter).
            if (!frontmatter['name']) {
              return null
            }
            const errorMsg = getParseError(frontmatter)
            failedFiles.push({ path: filePath, error: errorMsg })
            logForDebugging(
              `Failed to parse agent from ${filePath}: ${errorMsg}`,
            )
            logEvent('tengu_agent_parse_error', {
              error:
                errorMsg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              location:
                source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return null
          }
          return agent
        })
        .filter(agent => agent !== null)

      // Kick off plugin agent loading concurrently with memory snapshot init —
      // loadPluginAgents is memoized and takes no args, so it's independent.
      // Join both so neither becomes a floating promise if the other throws.
// 插件 agent 加载和记忆快照初始化互不依赖，并发跑；
// 用 Promise.all 一起等，避免其中一个抛错时另一个变成 floating promise
      let pluginAgentsPromise = loadPluginAgents()
      if (feature('AGENT_MEMORY_SNAPSHOT') && isAutoMemoryEnabled()) {
        const [pluginAgents_] = await Promise.all([
          pluginAgentsPromise,
          initializeAgentMemorySnapshots(customAgents),
        ])
        pluginAgentsPromise = Promise.resolve(pluginAgents_)
      }
      const pluginAgents = await pluginAgentsPromise

      const builtInAgents = getBuiltInAgents()

      const allAgentsList: AgentDefinition[] = [
        ...builtInAgents,
        ...pluginAgents,
        ...customAgents,
      ]

      const activeAgents = getActiveAgentsFromList(allAgentsList)

      // Initialize colors for all active agents
// 给每个有颜色的 agent 注册到全局颜色表（UI 里同类 agent 显示同一颜色）
      for (const agent of activeAgents) {
        if (agent.color) {
          setAgentColor(agent.agentType, agent.color)
        }
      }

      return {
        activeAgents,
        allAgents: allAgentsList,
        failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
      }
// 兜底：即使整体加载失败，也要把内置 agent 返回出去，保证工具还能用
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`Error loading agent definitions: ${errorMessage}`)
      logError(error)
      // Even on error, return the built-in agents
      const builtInAgents = getBuiltInAgents()
      return {
        activeAgents: builtInAgents,
        allAgents: builtInAgents,
        failedFiles: [{ path: 'unknown', error: errorMessage }],
      }
    }
  },
)

/**
 * 清掉 agent 定义的缓存（/reload-plugins、设置变更后要重新扫盘）。
 * `cache.clear?.()` 的 `?.` 是可选调用：memoize 的 cache 可能没有 clear 方法，那就跳过。
 */
export function clearAgentDefinitionsCache(): void {
  getAgentDefinitionsWithOverrides.cache.clear?.()
  clearPluginAgentCache()
}

/**
 * 生成人类可读的解析失败原因（缺 name / 缺 description / 其它）。
 */
/**
 * Helper to determine the specific parsing error for an agent file
 */
function getParseError(frontmatter: Record<string, unknown>): string {
  const agentType = frontmatter['name']
  const description = frontmatter['description']

  if (!agentType || typeof agentType !== 'string') {
    return 'Missing required "name" field in frontmatter'
  }

  if (!description || typeof description !== 'string') {
    return 'Missing required "description" field in frontmatter'
  }

  return 'Unknown parsing error'
}

/**
 * 用 HooksSchema 校验并解析 frontmatter 里的 hooks。
 * safeParse 不会抛异常，而是返回 {success, data|error} —— 校验失败时记日志并返回 undefined，
 * 让 agent 的其余部分照常加载。
 */
/**
 * Parse hooks from frontmatter using the HooksSchema
 * @param frontmatter The frontmatter object containing potential hooks
 * @param agentType The agent type for logging purposes
 * @returns Parsed hooks settings or undefined if invalid/missing
 */
function parseHooksFromFrontmatter(
  frontmatter: Record<string, unknown>,
  agentType: string,
): HooksSettings | undefined {
  if (!frontmatter.hooks) {
    return undefined
  }

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(
      `Invalid hooks in agent '${agentType}': ${result.error.message}`,
    )
    return undefined
  }
  return result.data
}

/**
 * 从 JSON 数据解析一个 agent 定义（flagSettings / policySettings 来源）。
 * 注意：开了 memory 且 tools 是显式白名单时，会自动往里补 Write/Edit/Read，
 * 否则 agent 想写自己的记忆文件却没工具，等于记忆功能残废。
 */
/**
 * Parses agent definition from JSON data
 */
export function parseAgentFromJson(
  name: string,
  definition: unknown,
  source: SettingSource = 'flagSettings',
): CustomAgentDefinition | null {
  try {
    const parsed = AgentJsonSchema().parse(definition)

    let tools = parseAgentToolsFromFrontmatter(parsed.tools)

    // If memory is enabled, inject Write/Edit/Read tools for memory access
    if (isAutoMemoryEnabled() && parsed.memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    const disallowedTools =
      parsed.disallowedTools !== undefined
        ? parseAgentToolsFromFrontmatter(parsed.disallowedTools)
        : undefined

    const systemPrompt = parsed.prompt

    const agent: CustomAgentDefinition = {
      agentType: name,
      whenToUse: parsed.description,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
// 用闭包把 systemPrompt 捕获下来：getSystemPrompt() 每次调用时
// 再决定要不要拼上记忆提示（记忆内容会变，不能解析时就固定死）
      getSystemPrompt: () => {
        if (isAutoMemoryEnabled() && parsed.memory) {
          return (
            systemPrompt + '\n\n' + loadAgentMemoryPrompt(name, parsed.memory)
          )
        }
        return systemPrompt
      },
      source,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
      ...(parsed.permissionMode
        ? { permissionMode: parsed.permissionMode }
        : {}),
      ...(parsed.mcpServers && parsed.mcpServers.length > 0
        ? { mcpServers: parsed.mcpServers }
        : {}),
      ...(parsed.hooks ? { hooks: parsed.hooks } : {}),
      ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
      ...(parsed.skills && parsed.skills.length > 0
        ? { skills: parsed.skills }
        : {}),
      ...(parsed.initialPrompt ? { initialPrompt: parsed.initialPrompt } : {}),
      ...(parsed.background ? { background: parsed.background } : {}),
      ...(parsed.memory ? { memory: parsed.memory } : {}),
      ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
    }

    return agent
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agent '${name}' from JSON: ${errorMessage}`)
    logError(error)
    return null
  }
}

/**
 * 批量解析 JSON 形式的多个 agent（键名即 agentType）。
 */
/**
 * Parses multiple agents from a JSON object
 */
export function parseAgentsFromJson(
  agentsJson: unknown,
  source: SettingSource = 'flagSettings',
): AgentDefinition[] {
  try {
    const parsed = AgentsJsonSchema().parse(agentsJson)
    return Object.entries(parsed)
      .map(([name, def]) => parseAgentFromJson(name, def, source))
      .filter((agent): agent is CustomAgentDefinition => agent !== null)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agents from JSON: ${errorMessage}`)
    logError(error)
    return []
  }
}

/**
 * 从 .md 文件解析 agent 定义：frontmatter 是配置，正文是 system prompt。
 * 容错原则：单个字段写错只记 warn 日志并忽略该字段，而不是整个文件报废；
 * 只有缺 name / description 这种硬伤才返回 null。
 */
/**
 * Parses agent definition from markdown file data
 */
export function parseAgentFromMarkdown(
  filePath: string,
  baseDir: string,
  frontmatter: Record<string, unknown>,
  content: string,
  source: SettingSource,
): CustomAgentDefinition | null {
  try {
    const agentType = frontmatter['name']
    let whenToUse = frontmatter['description'] as string

    // Validate required fields — silently skip files without any agent
    // frontmatter (they're likely co-located reference documentation)
// 没有 name 字段 → 静默跳过（大概率是同目录的参考文档，不是 agent）
    if (!agentType || typeof agentType !== 'string') {
      return null
    }
    if (!whenToUse || typeof whenToUse !== 'string') {
      logForDebugging(
        `Agent file ${filePath} is missing required 'description' in frontmatter`,
      )
      return null
    }

    // Unescape newlines in whenToUse that were escaped for YAML parsing
// frontmatter 里的换行在 YAML 解析时被转义成了字面 \n，这里还原成真正的换行
    whenToUse = whenToUse.replace(/\\n/g, '\n')

    const color = frontmatter['color'] as AgentColorName | undefined
    const modelRaw = frontmatter['model']
    let model: string | undefined
    if (typeof modelRaw === 'string' && modelRaw.trim().length > 0) {
      const trimmed = modelRaw.trim()
      model = trimmed.toLowerCase() === 'inherit' ? 'inherit' : trimmed
    }

    // Parse background flag
// background 只接受 true/false（字符串或布尔都行），其它值记 warn 并当没写
    const backgroundRaw = frontmatter['background']

    if (
      backgroundRaw !== undefined &&
      backgroundRaw !== 'true' &&
      backgroundRaw !== 'false' &&
      backgroundRaw !== true &&
      backgroundRaw !== false
    ) {
      logForDebugging(
        `Agent file ${filePath} has invalid background value '${backgroundRaw}'. Must be 'true', 'false', or omitted.`,
      )
    }

    const background =
      backgroundRaw === 'true' || backgroundRaw === true ? true : undefined

    // Parse memory scope
// memory 作用域三选一：user（跨项目）/ project（团队共享，进版本库）/ local（本机，不进版本库）
    const VALID_MEMORY_SCOPES: AgentMemoryScope[] = ['user', 'project', 'local']
    const memoryRaw = frontmatter['memory'] as string | undefined
    let memory: AgentMemoryScope | undefined
    if (memoryRaw !== undefined) {
      if (VALID_MEMORY_SCOPES.includes(memoryRaw as AgentMemoryScope)) {
        memory = memoryRaw as AgentMemoryScope
      } else {
        logForDebugging(
          `Agent file ${filePath} has invalid memory value '${memoryRaw}'. Valid options: ${VALID_MEMORY_SCOPES.join(', ')}`,
        )
      }
    }

// isolation: 'remote' 只对 ant 内部开放，外部构建在解析阶段就拒掉
    // Parse isolation mode. 'remote' is ant-only; external builds reject it at parse time.
    type IsolationMode = 'worktree' | 'remote'
    const VALID_ISOLATION_MODES: readonly IsolationMode[] =
      process.env.USER_TYPE === 'ant' ? ['worktree', 'remote'] : ['worktree']
    const isolationRaw = frontmatter['isolation'] as string | undefined
    let isolation: IsolationMode | undefined
    if (isolationRaw !== undefined) {
      if (VALID_ISOLATION_MODES.includes(isolationRaw as IsolationMode)) {
        isolation = isolationRaw as IsolationMode
      } else {
        logForDebugging(
          `Agent file ${filePath} has invalid isolation value '${isolationRaw}'. Valid options: ${VALID_ISOLATION_MODES.join(', ')}`,
        )
      }
    }

// effort 支持两种写法：字符串档位（low/medium/high）或整数
    // Parse effort from frontmatter (supports string levels and integers)
    const effortRaw = frontmatter['effort']
    const parsedEffort =
      effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined

    if (effortRaw !== undefined && parsedEffort === undefined) {
      logForDebugging(
        `Agent file ${filePath} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
      )
    }

    // Parse permissionMode from frontmatter
    const permissionModeRaw = frontmatter['permissionMode'] as
      | string
      | undefined
    const isValidPermissionMode =
      permissionModeRaw &&
      (PERMISSION_MODES as readonly string[]).includes(permissionModeRaw)

    if (permissionModeRaw && !isValidPermissionMode) {
      const errorMsg = `Agent file ${filePath} has invalid permissionMode '${permissionModeRaw}'. Valid options: ${PERMISSION_MODES.join(', ')}`
      logForDebugging(errorMsg)
    }

    // Parse maxTurns from frontmatter
    const maxTurnsRaw = frontmatter['maxTurns']
    const maxTurns = parsePositiveIntFromFrontmatter(maxTurnsRaw)
    if (maxTurnsRaw !== undefined && maxTurns === undefined) {
      logForDebugging(
        `Agent file ${filePath} has invalid maxTurns '${maxTurnsRaw}'. Must be a positive integer.`,
      )
    }

    // Extract filename without extension
    const filename = basename(filePath, '.md')

    // Parse tools from frontmatter
// 解析工具白名单；开了记忆的话自动补上 Write/Edit/Read（理由同 parseAgentFromJson）
    let tools = parseAgentToolsFromFrontmatter(frontmatter['tools'])

    // If memory is enabled, inject Write/Edit/Read tools for memory access
    if (isAutoMemoryEnabled() && memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    // Parse disallowedTools from frontmatter
    const disallowedToolsRaw = frontmatter['disallowedTools']
    const disallowedTools =
      disallowedToolsRaw !== undefined
        ? parseAgentToolsFromFrontmatter(disallowedToolsRaw)
        : undefined

    // Parse skills from frontmatter
    const skills = parseSlashCommandToolsFromFrontmatter(frontmatter['skills'])

    const initialPromptRaw = frontmatter['initialPrompt']
    const initialPrompt =
      typeof initialPromptRaw === 'string' && initialPromptRaw.trim()
        ? initialPromptRaw
        : undefined

    // Parse mcpServers from frontmatter using same Zod validation as JSON agents
// mcpServers 用和 JSON agent 完全相同的 zod 校验，保证两种来源行为一致
    const mcpServersRaw = frontmatter['mcpServers']
    let mcpServers: AgentMcpServerSpec[] | undefined
    if (Array.isArray(mcpServersRaw)) {
      mcpServers = mcpServersRaw
        .map(item => {
          const result = AgentMcpServerSpecSchema().safeParse(item)
          if (result.success) {
            return result.data
          }
          logForDebugging(
            `Agent file ${filePath} has invalid mcpServers item: ${jsonStringify(item)}. Error: ${result.error.message}`,
          )
          return null
        })
        .filter((item): item is AgentMcpServerSpec => item !== null)
    }

    // Parse hooks from frontmatter
    const hooks = parseHooksFromFrontmatter(frontmatter, agentType)

// 正文中 .md 的 content（去掉首尾空白）就是 system prompt
    const systemPrompt = content.trim()
    const agentDef: CustomAgentDefinition = {
      baseDir,
      agentType: agentType,
      whenToUse: whenToUse,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(initialPrompt !== undefined ? { initialPrompt } : {}),
      ...(mcpServers !== undefined && mcpServers.length > 0
        ? { mcpServers }
        : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      getSystemPrompt: () => {
        if (isAutoMemoryEnabled() && memory) {
          const memoryPrompt = loadAgentMemoryPrompt(agentType, memory)
          return systemPrompt + '\n\n' + memoryPrompt
        }
        return systemPrompt
      },
      source,
      filename,
      ...(color && typeof color === 'string' && AGENT_COLORS.includes(color)
        ? { color }
        : {}),
      ...(model !== undefined ? { model } : {}),
      ...(parsedEffort !== undefined ? { effort: parsedEffort } : {}),
      ...(isValidPermissionMode
        ? { permissionMode: permissionModeRaw as PermissionMode }
        : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(background ? { background } : {}),
      ...(memory ? { memory } : {}),
      ...(isolation ? { isolation } : {}),
    }
    return agentDef
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agent from ${filePath}: ${errorMessage}`)
    logError(error)
    return null
  }
}
