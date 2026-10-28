// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 【一句话定位】
 * 埋点的「元数据工厂 + 隐私清洗车间」：负责给每条事件补上统一的上下文（环境、版本、平台、进程指标…），
 * 并把各种可能含敏感信息的东西（工具名、文件路径、bash 命令、工具入参）脱敏后再上报。
 *
 * 【在架构中的位置】
 * 调用链：
 *   datadog.ts trackDatadogEvent() → 本文件 getEventMetadata()
 *   firstPartyEventLogger.ts logEventTo1PAsync() → 本文件 getEventMetadata()
 *   firstPartyEventLoggingExporter.ts → 本文件 to1PEventFormat()（转成后端要求的 snake_case）
 * 上游依赖大量工具模块：utils/env.js、utils/platform.js、utils/auth.js、utils/git.js、
 * utils/teammate.js、bootstrap/state.js 等。
 * 定位：这个模块是「所有 analytics 系统共用的唯一数据源」（英文注释的 single source of truth），
 * 避免 Datadog 和一方两套后端各自采一遍、口径不一致。
 *
 * 【为什么这个文件又长又啰嗦】
 * 埋点最大的风险不是「漏了字段」，而是「多报了不该报的东西」。所以本文件一半代码在做脱敏：
 *   - MCP 工具名（含用户自建服务器名）→ 归成 'mcp_tool'
 *   - 文件路径 → 只保留扩展名，且过长的扩展名归成 'other'
 *   - bash 命令 → 只从白名单命令里抽扩展名
 *   - 工具入参 → 递归截断字符串/数组/对象深度
 * 再加上顶层那个 `never` 标记类型（见下），构成「类型系统 + 运行时」双保险。
 *
 * 【本文件包含什么】
 * - type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS：隐私确认标记类型（= never）。
 * - sanitizeToolNameForAnalytics() / isToolDetailsLoggingEnabled() / isAnalyticsToolDetailsLoggingEnabled()：
 *   工具名脱敏与「是否允许记录详情」的判断。
 * - BUILTIN_MCP_SERVER_NAMES / mcpToolDetailsForAnalytics() / extractMcpToolDetails()：MCP 名称处理。
 * - extractSkillName()：从 Skill 工具入参里取技能名。
 * - truncateToolInputValue() / extractToolInputForTelemetry()：工具入参的截断与序列化。
 * - getFileExtensionForAnalytics() / getFileExtensionsFromBashCommand()：文件扩展名的安全提取。
 * - type EnvContext / ProcessMetrics / EventMetadata / EnrichMetadataOptions：元数据结构定义。
 * - getAgentIdentification()：多智能体（swarm/teammate/subagent）身份识别。
 * - getVersionBase() / buildEnvContext() / buildProcessMetrics()：三项元数据的采集。
 * - getEventMetadata()：主入口，组装完整元数据。
 * - type FirstPartyEventLoggingCoreMetadata / FirstPartyEventLoggingMetadata / to1PEventFormat()：
 *   一方后端要求的 snake_case 格式转换。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `// biome-ignore-all ...`：文件级 linter 抑制指令，必须留在第一行。
 *   ≈ Java 的 `@SuppressWarnings`，但写在文件顶部对整个文件生效。
 * - `export type X = never` + `return s as X`：
 *   never 表示「不可能有值」。所以直接 return 一个字符串会编译报错，必须显式 as。
 *   这就是刻意的：逼每个上报字符串的人都在代码里留下「我确认过这不含代码/路径」的证据。
 *   （Java 里最接近的是「只能通过一个叫 verifiedSafe(...) 的工厂方法构造」的类型。）
 * - `feature('CHICAGO_MCP') ? [...] : []`：
 *   注意！这是【编译期】开关（bun:bundle 提供），不是运行期 if。
 *   打包时会把整个三元折叠成常量，未启用的分支连同 require 一起被摇掉（tree-shaking）。
 *   ≈ C 的 `#ifdef`。它和运行期的 GrowthBook 开关完全不是一回事（见 growthbook.ts 的对比表）。
 * - `require('...') as typeof import('...')`：运行时动态 require + 类型标注。
 *   `typeof import('...')` 取的是【模块的类型】，这样动态 require 也有完整类型检查。
 *   ≈ Java 的 Class.forName + 强转，但类型安全由 TS 保证。
 * - `ReadonlySet<string>`：只读集合（没有 add/delete 方法）。≈ Java 的 Collections.unmodifiableSet。
 * - `memoize(async (): Promise<EnvContext> => {...})`：
 *   异步 + 只算一次。注意 memoize 缓存的是【Promise 对象】，所以并发调用拿到的是同一个 Promise，
 *   只会真正执行一次（Java 里要自己用 ConcurrentHashMap 的 computeIfAbsent 实现）。
 * - `const [a, b, c, d] = await Promise.all([f1(), f2(), f3(), f4()])`：
 *   并发执行四个异步任务并按顺序解构结果。≈ Java 的 CompletableFuture.allOf + 逐个 join。
 * - rest 解构剔除字段：`const { envContext, processMetrics, rh, ...coreFields } = metadata`：
 *   把四个字段单独取出，其余全部收进 coreFields。
 *   ≈ Java 要手写 `var coreFields = new HashMap<>(metadata); coreFields.remove(...)` × 4。
 * - `...(cond && { field: value })`：条件展开，本文件大量使用。
 *   条件为假 → 展开空 → 这个字段完全不出现（而不是出现一个 undefined）。
 *   好处：上报的 JSON 里没有一堆 null，后端 schema 更干净。
 * - `feature('X') ? { a } : {} }) ... : {}`：嵌套三元 + 展开，用于「特性开关 + 环境变量」两级条件。
 * - `'skill' in input && typeof (input as { skill: unknown }).skill === 'string'`：
 *   先用 `in` 判断键存在，再用 typeof 判断值类型——处理 unknown 输入的标准两步走。
 * - `true as const`：`as const` 把类型收窄成字面量 true（而不是 boolean）。
 *   ≈ Java 里用一个只能取 true 的枚举/常量。
 * - `('teammate' as const)`：同理，把字符串收窄成字面量类型，才能赋给联合类型字段。
 * - `Array.isArray(value)`：判断数组。注意 TS 里 `typeof []` 是 'object'，必须用这个 API。
 *   ≈ Java 的 `value instanceof List`。
 * - `Object.entries(obj)` + `.filter(([k]) => ...)` + `Object.fromEntries(...)`：
 *   对象 → 键值对数组 → 过滤 → 回转成对象。≈ Java Stream 里对 Map 做 filter + collect。
 *   `([k]) => ...` 是对「[键, 值] 这个二元组」做解构，只取键。
 * - `value.slice(0, N)` + 模板字符串 `` `…[${value.length} chars]` ``：截断并标注原长度，
 *   方便后端知道「这里被砍过」。
 * - `arg.charCodeAt(0) === 45 /* - */`：判断首字符是不是 '-'（45 是 '-' 的 ASCII 码）。
 *   用 charCodeAt 比 `arg[0] === '-'` 稍快，且注释说明了 45 是什么——避免魔法数字。
 * - `Buffer.from(s).toString('base64')`：字符串转 Base64。
 *   ≈ Java 的 Base64.getEncoder().encodeToString(s.getBytes(UTF_8))。
 * - `MACRO.VERSION` / `MACRO.BUILD_TIME`：构建期宏，打包时替换成实际值。
 *   ≈ Maven/Gradle 的资源过滤占位符。
 * - `catch { return undefined }`：可选 catch 绑定，采集元数据失败就降级不采集，绝不影响上报主流程。
 * - `process.memoryUsage()` / `process.cpuUsage()`：Node 的进程指标 API。
 *   ≈ Java 的 ManagementFactory / OperatingSystemMXBean。
 * - `ReturnType<typeof getAgentIdentification>`：引用「自己这个函数的返回类型」，
 *   避免重复写一长串内联类型。Java 没有对应语法。
 */
/**
 * Shared event metadata enrichment for analytics systems
 *
 * This module provides a single source of truth for collecting and formatting
 * event metadata across all analytics systems (Datadog, 1P).
 */

import { extname } from 'path'
import memoize from 'lodash-es/memoize.js'
import { env, getHostPlatformForAnalytics } from '../../utils/env.js'
import { envDynamic } from '../../utils/envDynamic.js'
import { getModelBetas } from '../../utils/betas.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import {
  getSessionId,
  getIsInteractive,
  getKairosActive,
  getClientType,
  getParentSessionId as getParentSessionIdFromState,
} from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isOfficialMcpUrl } from '../mcp/officialRegistry.js'
import { isClaudeAISubscriber, getSubscriptionType } from '../../utils/auth.js'
import { getRepoRemoteHash } from '../../utils/git.js'
import {
  getWslVersion,
  getLinuxDistroInfo,
  detectVcs,
} from '../../utils/platform.js'
import type { CoreUserData } from 'src/utils/user.js'
import { getAgentContext } from '../../utils/agentContext.js'
import type { EnvironmentMetadata } from '../../types/generated/events_mono/claude_code/v1/claude_code_internal_event.js'
import type { PublicApiAuth } from '../../types/generated/events_mono/common/v1/auth.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentId,
  getParentSessionId as getTeammateParentSessionId,
  getTeamName,
  isTeammate,
} from '../../utils/teammate.js'
import { feature } from 'bun:bundle'

/**
 * Marker type for verifying analytics metadata doesn't contain sensitive data
 *
 * This type forces explicit verification that string values being logged
 * don't contain code snippets, file paths, or other sensitive information.
 *
 * The metadata is expected to be JSON-serializable.
 *
 * Usage: `myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 *
 * The type is `never` which means it can never actually hold a value - this is
 * intentional as it's only used for type-casting to document developer intent.
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * Sanitizes tool names for analytics logging to avoid PII exposure.
 *
 * MCP tool names follow the format `mcp__<server>__<tool>` and can reveal
 * user-specific server configurations, which is considered PII-medium.
 * This function redacts MCP tool names while preserving built-in tool names
 * (Bash, Read, Write, etc.) which are safe to log.
 *
 * @param toolName - The tool name to sanitize
 * @returns The original name for built-in tools, or 'mcp_tool' for MCP tools
 */
// 中文补充：MCP 工具名形如 mcp__slack__read_channel，里面的服务器名是【用户自己配的】，
// 属于中危 PII（能反推出用户用了哪些内部系统）。所以默认是脱敏成 'mcp_tool'，
// 内置工具名（Bash/Read/Write）是固定的，没有隐私风险，原样上报。
export function sanitizeToolNameForAnalytics(
  toolName: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if detailed tool name logging is enabled for OTLP events.
 * When enabled, MCP server/tool names and Skill names are logged.
 * Disabled by default to protect PII (user-specific server configurations).
 *
 * Enable with OTEL_LOG_TOOL_DETAILS=1
 */
// OTLP（客户自己的遥测）是否记录工具详情，由用户自己通过环境变量决定（默认关）。
export function isToolDetailsLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_TOOL_DETAILS)
}

/**
 * Check if detailed tool name logging (MCP server/tool names) is enabled
 * for analytics events.
 *
 * Per go/taxonomy, MCP names are medium PII. We log them for:
 * - Cowork (entrypoint=local-agent) — no ZDR concept, log all MCPs
 * - claude.ai-proxied connectors — always official (from claude.ai's list)
 * - Servers whose URL matches the official MCP registry — directory
 *   connectors added via `claude mcp add`, not customer-specific config
 *
 * Custom/user-configured MCPs stay sanitized (toolName='mcp_tool').
 */
// analytics（发给 Anthropic 的埋点）是否记录工具详情，判定更严格：
// 只有「确定不是用户私有配置」的 MCP 才允许上报名字——
// ① Cowork（本地 agent 模式）② claude.ai 官方代理连接器 ③ 官方 MCP 注册表里的地址。
// 用户自己配的 MCP 一律继续脱敏。这是「按来源分级授权」的思路。
export function isAnalyticsToolDetailsLoggingEnabled(
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): boolean {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') {
    return true
  }
  if (mcpServerType === 'claudeai-proxy') {
    return true
  }
  if (mcpServerBaseUrl && isOfficialMcpUrl(mcpServerBaseUrl)) {
    return true
  }
  return false
}

/**
 * Built-in first-party MCP servers whose names are fixed reserved strings,
 * not user-configured — so logging them is not PII. Checked in addition to
 * isAnalyticsToolDetailsLoggingEnabled's transport/URL gates, which a stdio
 * built-in would otherwise fail.
 *
 * Feature-gated so the set is empty when the feature is off: the name
 * reservation (main.tsx, config.ts addMcpServer) is itself feature-gated, so
 * a user-configured 'computer-use' is possible in builds without the feature.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
// 内置 MCP 服务器的名字是固定保留字（不是用户配的），可以安全上报。
// 用 feature('CHICAGO_MCP') 包起来是必须的：这个功能没编译时，
// 用户完全可以自己配一个叫 'computer-use' 的服务器，那它就变成用户数据了。
const BUILTIN_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(
  feature('CHICAGO_MCP')
    ? [
        (
          require('../../utils/computerUse/common.js') as typeof import('../../utils/computerUse/common.js')
        ).COMPUTER_USE_MCP_SERVER_NAME,
      ]
    : [],
)
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Spreadable helper for logEvent payloads — returns {mcpServerName, mcpToolName}
 * if the gate passes, empty object otherwise. Consolidates the identical IIFE
 * pattern at each tengu_tool_use_* call site.
 */
// 便捷封装：把「解析 MCP 名 + 判断是否允许上报」两步合一，
// 返回可以直接展开进 logEvent 载荷的对象（不允许就返回空对象）。
// 这样每个调用点不用重复写那段判断逻辑。
export function mcpToolDetailsForAnalytics(
  toolName: string,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): {
  mcpServerName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  mcpToolName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
} {
  const details = extractMcpToolDetails(toolName)
  if (!details) {
    return {}
  }
  if (
    !BUILTIN_MCP_SERVER_NAMES.has(details.serverName) &&
    !isAnalyticsToolDetailsLoggingEnabled(mcpServerType, mcpServerBaseUrl)
  ) {
    return {}
  }
  return {
    mcpServerName: details.serverName,
    mcpToolName: details.mcpToolName,
  }
}

/**
 * Extract MCP server and tool names from a full MCP tool name.
 * MCP tool names follow the format: mcp__<server>__<tool>
 *
 * @param toolName - The full tool name (e.g., 'mcp__slack__read_channel')
 * @returns Object with serverName and toolName, or undefined if not an MCP tool
 */
// 解析 mcp__<server>__<tool> 格式。注意工具名本身可能也含 __，
// 所以从第 3 段开始要把剩下的重新 join 起来（不能只取 parts[2]）。
export function extractMcpToolDetails(toolName: string):
  | {
      serverName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      mcpToolName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
  | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  // Format: mcp__<server>__<tool>
  const parts = toolName.split('__')
  if (parts.length < 3) {
    return undefined
  }

  const serverName = parts[1]
  // Tool name may contain __ so rejoin remaining parts
  const mcpToolName = parts.slice(2).join('__')

  if (!serverName || !mcpToolName) {
    return undefined
  }

  return {
    serverName:
      serverName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    mcpToolName:
      mcpToolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  }
}

/**
 * Extract skill name from Skill tool input.
 *
 * @param toolName - The tool name (should be 'Skill')
 * @param input - The tool input containing the skill name
 * @returns The skill name if this is a Skill tool call, undefined otherwise
 */
// 从 Skill 工具的入参里取技能名。返回类型是「never | undefined」——
// 实际上就是 string | undefined，但要用 as 强制标注（隐私确认）。
export function extractSkillName(
  toolName: string,
  input: unknown,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  if (toolName !== 'Skill') {
    return undefined
  }

// 处理 unknown 输入的标准姿势：先 typeof 排除非对象、再排除 null、再 `in` 判键存在、再 typeof 判值类型。
  if (
    typeof input === 'object' &&
    input !== null &&
    'skill' in input &&
    typeof (input as { skill: unknown }).skill === 'string'
  ) {
    return (input as { skill: string })
      .skill as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return undefined
}

const TOOL_INPUT_STRING_TRUNCATE_AT = 512
const TOOL_INPUT_STRING_TRUNCATE_TO = 128
const TOOL_INPUT_MAX_JSON_CHARS = 4 * 1024
const TOOL_INPUT_MAX_COLLECTION_ITEMS = 20
const TOOL_INPUT_MAX_DEPTH = 2

// 递归截断工具入参：控制上报体积，同时避免把超长内容（比如整个文件）发出去。
// 四道限制：字符串长度、数组元素数、对象键数、嵌套深度。
// 注意入参是 unknown，所以要一路 typeof / Array.isArray 判断类型后再处理。
function truncateToolInputValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_INPUT_STRING_TRUNCATE_AT) {
// 截断后仍保留「原长度」信息（`…[1234 chars]`），方便后端知道数据被裁剪过。
      return `${value.slice(0, TOOL_INPUT_STRING_TRUNCATE_TO)}…[${value.length} chars]`
    }
    return value
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value
  }
// 超过最大深度直接返回 '<nested>'：深层嵌套既没分析价值又是体积炸弹。
  if (depth >= TOOL_INPUT_MAX_DEPTH) {
    return '<nested>'
  }
  if (Array.isArray(value)) {
    const mapped = value
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(v => truncateToolInputValue(v, depth + 1))
    if (value.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(`…[${value.length} items]`)
    }
    return mapped
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Skip internal marker keys (e.g. _simulatedSedEdit re-introduced by
      // SedEditPermissionRequest) so they don't leak into telemetry.
// 过滤掉下划线开头的键：那些是内部标记字段（如 _simulatedSedEdit），不该进遥测。
      .filter(([k]) => !k.startsWith('_'))
    const mapped = entries
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(([k, v]) => [k, truncateToolInputValue(v, depth + 1)])
    if (entries.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(['…', `${entries.length} keys`])
    }
    return Object.fromEntries(mapped)
  }
  return String(value)
}

/**
 * Serialize a tool's input arguments for the OTel tool_result event.
 * Truncates long strings and deep nesting to keep the output bounded while
 * preserving forensically useful fields like file paths, URLs, and MCP args.
 * Returns undefined when OTEL_LOG_TOOL_DETAILS is not enabled.
 */
// 序列化工具入参（仅供 OTLP 用，且必须显式开启 OTEL_LOG_TOOL_DETAILS）。
// 没开就返回 undefined——宁可不采集，也不默认采集可能有敏感内容的入参。
export function extractToolInputForTelemetry(
  input: unknown,
): string | undefined {
  if (!isToolDetailsLoggingEnabled()) {
    return undefined
  }
  const truncated = truncateToolInputValue(input)
  let json = jsonStringify(truncated)
  if (json.length > TOOL_INPUT_MAX_JSON_CHARS) {
    json = json.slice(0, TOOL_INPUT_MAX_JSON_CHARS) + '…[truncated]'
  }
  return json
}

/**
 * Maximum length for file extensions to be logged.
 * Extensions longer than this are considered potentially sensitive
 * (e.g., hash-based filenames like "key-hash-abcd-123-456") and
 * will be replaced with 'other'.
 */
// 扩展名超过 10 字符就归成 'other'：这类通常是哈希文件名（如 key-hash-abcd-123），
// 上报它等于上报了半截密钥/内部标识，属于敏感数据。
const MAX_FILE_EXTENSION_LENGTH = 10

/**
 * Extracts and sanitizes a file extension for analytics logging.
 *
 * Uses Node's path.extname for reliable cross-platform extension extraction.
 * Returns 'other' for extensions exceeding MAX_FILE_EXTENSION_LENGTH to avoid
 * logging potentially sensitive data (like hash-based filenames).
 *
 * @param filePath - The file path to extract the extension from
 * @returns The sanitized extension, 'other' for long extensions, or undefined if no extension
 */
// 只取扩展名、不取路径本身：路径里可能含用户名、项目名（比如 /Users/zhangsan/secret-project/）。
// 用 Node 的 path.extname 而不是自己按点分割——跨平台且能正确处理 .tar.gz 这类情况。
export function getFileExtensionForAnalytics(
  filePath: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  const ext = extname(filePath).toLowerCase()
  if (!ext || ext === '.') {
    return undefined
  }

  const extension = ext.slice(1) // remove leading dot
  if (extension.length > MAX_FILE_EXTENSION_LENGTH) {
    return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return extension as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/** Allow list of commands we extract file extensions from. */
// 白名单命令：只从这些「明显在操作文件」的命令里抽扩展名。
// 不搞完整的 shell 解析——英文注释说明了理由：grep 的正则、sed 的脚本很少长得像文件扩展名，
// 简单切分就够用，还能避免引入一个 shell 解析器的复杂度和风险。
const FILE_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'cat',
  'head',
  'tail',
  'sort',
  'stat',
  'diff',
  'wc',
  'grep',
  'rg',
  'sed',
])

/** Regex to split bash commands on compound operators (&&, ||, ;, |). */
// 按复合操作符（&&、||、;、|）切分命令，再按空白切词。注意正则里的 | 要转义成 \|。
const COMPOUND_OPERATOR_REGEX = /\s*(?:&&|\|\||[;|])\s*/

/** Regex to split on whitespace. */
const WHITESPACE_REGEX = /\s+/

/**
 * Extracts file extensions from a bash command for analytics.
 * Best-effort: splits on operators and whitespace, extracts extensions
 * from non-flag args of allowed commands. No heavy shell parsing needed
 * because grep patterns and sed scripts rarely resemble file extensions.
 */
// 从 bash 命令里抽扩展名（尽力而为）。
// 关键步骤：
// ① 命令里连个 '.' 都没有 → 直接返回（快速跳过绝大多数命令）
// ② 按 &&/||/;/| 切成多条子命令
// ③ 取每段第一个词作为命令名（去掉路径前缀，如 /usr/bin/grep → grep）
// ④ 不在白名单里就跳过整段
// ⑤ 遍历参数，跳过 - 开头的选项，抽扩展名并去重拼接
export function getFileExtensionsFromBashCommand(
  command: string,
  simulatedSedEditFilePath?: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
// 快速失败：没有点号几乎肯定没有扩展名，省掉后面的切分开销。
  if (!command.includes('.') && !simulatedSedEditFilePath) return undefined

  let result: string | undefined
  const seen = new Set<string>()

  if (simulatedSedEditFilePath) {
    const ext = getFileExtensionForAnalytics(simulatedSedEditFilePath)
    if (ext) {
      seen.add(ext)
      result = ext
    }
  }

  for (const subcmd of command.split(COMPOUND_OPERATOR_REGEX)) {
    if (!subcmd) continue
    const tokens = subcmd.split(WHITESPACE_REGEX)
    if (tokens.length < 2) continue

// `tokens[0]!` 非空断言：上面已确认长度 >= 2，第一个元素必然存在。
    const firstToken = tokens[0]!
// 去掉路径前缀取命令名：/usr/bin/grep 要识别成 grep。
    const slashIdx = firstToken.lastIndexOf('/')
    const baseCmd = slashIdx >= 0 ? firstToken.slice(slashIdx + 1) : firstToken
    if (!FILE_COMMANDS.has(baseCmd)) continue

    for (let i = 1; i < tokens.length; i++) {
      const arg = tokens[i]!
// charCodeAt(0) === 45 就是判断首字符是不是 '-'（选项），注释里标了 45 是什么避免魔法数字。
      if (arg.charCodeAt(0) === 45 /* - */) continue
      const ext = getFileExtensionForAnalytics(arg)
      if (ext && !seen.has(ext)) {
        seen.add(ext)
        result = result ? result + ',' + ext : ext
      }
    }
  }

  if (!result) return undefined
  return result as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Environment context metadata
 */
// 环境上下文：平台、架构、运行时、CI/容器/GitHub Action 判定、版本等。
// 这些字段几乎每个事件都要带，所以是元数据里最大的一块。
export type EnvContext = {
  platform: string
  platformRaw: string
  arch: string
  nodeVersion: string
  terminal: string | null
  packageManagers: string
  runtimes: string
  isRunningWithBun: boolean
  isCi: boolean
  isClaubbit: boolean
  isClaudeCodeRemote: boolean
  isLocalAgentMode: boolean
  isConductor: boolean
  remoteEnvironmentType?: string
  coworkerType?: string
  claudeCodeContainerId?: string
  claudeCodeRemoteSessionId?: string
  tags?: string
  isGithubAction: boolean
  isClaudeCodeAction: boolean
  isClaudeAiAuth: boolean
  version: string
  versionBase?: string
  buildTime: string
  deploymentEnvironment: string
  githubEventName?: string
  githubActionsRunnerEnvironment?: string
  githubActionsRunnerOs?: string
  githubActionRef?: string
  wslVersion?: string
  linuxDistroId?: string
  linuxDistroVersion?: string
  linuxKernel?: string
  vcs?: string
}

/**
 * Process metrics included with all analytics events.
 */
// 进程指标：内存、CPU、运行时长。用于分析「是不是某些环境下特别吃内存」。
export type ProcessMetrics = {
  uptime: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  constrainedMemory: number | undefined
  cpuUsage: NodeJS.CpuUsage
  cpuPercent: number | undefined
}

/**
 * Core event metadata shared across all analytics systems
 */
// 核心元数据结构。注意里面有些字段是「内部专用」（sweBench* 用于基准测试、
// kairosActive/skillMode/observerMode 仅供内部员工分析）。
export type EventMetadata = {
  model: string
  sessionId: string
  userType: string
  betas?: string
  envContext: EnvContext
  entrypoint?: string
  agentSdkVersion?: string
  isInteractive: string
  clientType: string
  processMetrics?: ProcessMetrics
  sweBenchRunId: string
  sweBenchInstanceId: string
  sweBenchTaskId: string
  // Swarm/team agent identification for analytics attribution
  agentId?: string // CLAUDE_CODE_AGENT_ID (format: agentName@teamName) or subagent UUID
  parentSessionId?: string // CLAUDE_CODE_PARENT_SESSION_ID (team lead's session)
  agentType?: 'teammate' | 'subagent' | 'standalone' // Distinguishes swarm teammates, Agent tool subagents, and standalone agents
  teamName?: string // Team name for swarm agents (from env var or AsyncLocalStorage)
  subscriptionType?: string // OAuth subscription tier (max, pro, enterprise, team)
  rh?: string // Hashed repo remote URL (first 16 chars of SHA256), for joining with server-side data
  kairosActive?: true // KAIROS assistant mode active (ant-only; set in main.tsx after gate check)
  skillMode?: 'discovery' | 'coach' | 'discovery_and_coach' // Which skill surfacing mechanism(s) are gated on (ant-only; for BQ session segmentation)
  observerMode?: 'backseat' | 'skillcoach' | 'both' // Which observer classifiers are gated on (ant-only; for BQ cohort splits on tengu_backseat_* events)
}

/**
 * Options for enriching event metadata
 */
export type EnrichMetadataOptions = {
  // Model to use, falls back to getMainLoopModel() if not provided
  model?: unknown
  // Explicit betas string (already joined)
  betas?: unknown
  // Additional metadata to include (optional)
  additionalMetadata?: Record<string, unknown>
}

/**
 * Get agent identification for analytics.
 * Priority: AsyncLocalStorage context (subagents) > env vars (swarm teammates)
 */
// 多智能体身份识别，优先级：
// ① AsyncLocalStorage 里的上下文（同一进程内的子 agent）
// ② 环境变量（独立进程启动的 swarm/teammate）
// ③ bootstrap state 里的父会话 ID（如 plan mode → 实施阶段）
// 这样能把「一次用户请求产生的所有子任务」串成一棵树来分析。
function getAgentIdentification(): {
  agentId?: string
  parentSessionId?: string
  agentType?: 'teammate' | 'subagent' | 'standalone'
  teamName?: string
} {
  // Check AsyncLocalStorage first (for subagents running in same process)
  const agentContext = getAgentContext()
  if (agentContext) {
    const result: ReturnType<typeof getAgentIdentification> = {
      agentId: agentContext.agentId,
      parentSessionId: agentContext.parentSessionId,
      agentType: agentContext.agentType,
    }
    if (agentContext.agentType === 'teammate') {
      result.teamName = agentContext.teamName
    }
    return result
  }

  // Fall back to swarm helpers (for swarm agents)
  const agentId = getAgentId()
  const parentSessionId = getTeammateParentSessionId()
  const teamName = getTeamName()
  const isSwarmAgent = isTeammate()
  // For standalone agents (have agent ID but not a teammate), set agentType to 'standalone'
// 区分三种 agent 类型：swarm 团队成员、Agent 工具的子 agent、独立 agent。
// `'teammate' as const` 的 as const 是把字符串收窄成字面量类型，才能赋给联合类型字段。
  const agentType = isSwarmAgent
    ? ('teammate' as const)
    : agentId
      ? ('standalone' as const)
      : undefined
// 又是条件展开：只把有值的字段放进去，避免上报一堆空字段。
  if (agentId || agentType || parentSessionId || teamName) {
    return {
      ...(agentId ? { agentId } : {}),
      ...(agentType ? { agentType } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(teamName ? { teamName } : {}),
    }
  }

  // Check bootstrap state for parent session ID (e.g., plan mode -> implementation)
  const stateParentSessionId = getParentSessionIdFromState()
  if (stateParentSessionId) {
    return { parentSessionId: stateParentSessionId }
  }

  return {}
}

/**
 * Extract base version from full version string. "2.0.36-dev.20251107.t174150.sha2709699" → "2.0.36-dev"
 */
// 从完整版本号里提取基础版本：
// '2.0.36-dev.20251107.t174150.sha2709699' → '2.0.36-dev'
// memoize：版本号在一个进程里不会变，算一次就够。
const getVersionBase = memoize((): string | undefined => {
  const match = MACRO.VERSION.match(/^\d+\.\d+\.\d+(?:-[a-z]+)?/)
  return match ? match[0] : undefined
})

/**
 * Builds the environment context object
 */
// 采集环境上下文。四个耗时项（包管理器、运行时、发行版、VCS）用 Promise.all 并发跑，
// 然后 memoize 保证整个进程只采集一次。
// 为什么必须 memoize：这个信息变化极慢，而埋点是高频操作。
const buildEnvContext = memoize(async (): Promise<EnvContext> => {
  const [packageManagers, runtimes, linuxDistroInfo, vcs] = await Promise.all([
    env.getPackageManagers(),
    env.getRuntimes(),
    getLinuxDistroInfo(),
    detectVcs(),
  ])

  return {
    platform: getHostPlatformForAnalytics(),
    // Raw process.platform so freebsd/openbsd/aix/sunos are visible in BQ.
    // getHostPlatformForAnalytics() buckets those into 'linux'; here we want
    // the truth. CLAUDE_CODE_HOST_PLATFORM still overrides for container/remote.
// platform 是「归并后的平台」（freebsd 等会被归成 linux，便于聚合），
// platformRaw 保留原始值（供内部分析）。两个都要，用途不同。
    platformRaw: process.env.CLAUDE_CODE_HOST_PLATFORM || process.platform,
    arch: env.arch,
    nodeVersion: env.nodeVersion,
    terminal: envDynamic.terminal,
    packageManagers: packageManagers.join(','),
    runtimes: runtimes.join(','),
    isRunningWithBun: env.isRunningWithBun(),
    isCi: isEnvTruthy(process.env.CI),
    isClaubbit: isEnvTruthy(process.env.CLAUBBIT),
    isClaudeCodeRemote: isEnvTruthy(process.env.CLAUDE_CODE_REMOTE),
    isLocalAgentMode: process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent',
    isConductor: env.isConductor(),
    ...(process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE && {
      remoteEnvironmentType: process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE,
    }),
    // Gated by feature flag to prevent leaking "coworkerType" string in external builds
// 用编译期 feature 门控：未启用这个功能时，coworkerType 这个字段根本不会出现在代码里，
// 绝不会外泄（比运行期判断更彻底——运行期判断还可能因为 bug 漏掉）。
    ...(feature('COWORKER_TYPE_TELEMETRY')
      ? process.env.CLAUDE_CODE_COWORKER_TYPE
        ? { coworkerType: process.env.CLAUDE_CODE_COWORKER_TYPE }
        : {}
      : {}),
    ...(process.env.CLAUDE_CODE_CONTAINER_ID && {
      claudeCodeContainerId: process.env.CLAUDE_CODE_CONTAINER_ID,
    }),
    ...(process.env.CLAUDE_CODE_REMOTE_SESSION_ID && {
      claudeCodeRemoteSessionId: process.env.CLAUDE_CODE_REMOTE_SESSION_ID,
    }),
    ...(process.env.CLAUDE_CODE_TAGS && {
      tags: process.env.CLAUDE_CODE_TAGS,
    }),
    isGithubAction: isEnvTruthy(process.env.GITHUB_ACTIONS),
    isClaudeCodeAction: isEnvTruthy(process.env.CLAUDE_CODE_ACTION),
    isClaudeAiAuth: isClaudeAISubscriber(),
    version: MACRO.VERSION,
    versionBase: getVersionBase(),
    buildTime: MACRO.BUILD_TIME,
    deploymentEnvironment: env.detectDeploymentEnvironment(),
    ...(isEnvTruthy(process.env.GITHUB_ACTIONS) && {
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubActionsRunnerEnvironment: process.env.RUNNER_ENVIRONMENT,
      githubActionsRunnerOs: process.env.RUNNER_OS,
      githubActionRef: process.env.GITHUB_ACTION_PATH?.includes(
        'claude-code-action/',
      )
        ? process.env.GITHUB_ACTION_PATH.split('claude-code-action/')[1]
        : undefined,
    }),
    ...(getWslVersion() && { wslVersion: getWslVersion() }),
    ...(linuxDistroInfo ?? {}),
    ...(vcs.length > 0 ? { vcs: vcs.join(',') } : {}),
  }
})

// --
// CPU% delta tracking — inherently process-global, same pattern as logBatch/flushTimer in datadog.ts
// CPU 使用率要用「两次采样的差值」才能算出来，所以需要跨调用保存上一次的值。
// 这两个模块级变量就是为此存在的（英文注释说明这是进程级全局状态，和 datadog.ts 里的
// logBatch/flushTimer 是同一种模式）。
let prevCpuUsage: NodeJS.CpuUsage | null = null
let prevWallTimeMs: number | null = null

/**
 * Builds process metrics object for all users.
 */
// 采集进程指标。CPU 百分比 = (本次CPU时间 - 上次CPU时间) / (本次墙钟时间 - 上次) × 100。
// 整个函数包在 try/catch 里：某些沙箱环境拿不到这些指标，返回 undefined 就行，不能崩。
function buildProcessMetrics(): ProcessMetrics | undefined {
  try {
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    const now = Date.now()

    let cpuPercent: number | undefined
    if (prevCpuUsage && prevWallTimeMs) {
      const wallDeltaMs = now - prevWallTimeMs
      if (wallDeltaMs > 0) {
        const userDeltaUs = cpu.user - prevCpuUsage.user
        const systemDeltaUs = cpu.system - prevCpuUsage.system
        cpuPercent =
          ((userDeltaUs + systemDeltaUs) / (wallDeltaMs * 1000)) * 100
      }
    }
    prevCpuUsage = cpu
    prevWallTimeMs = now

    return {
      uptime: process.uptime(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      constrainedMemory: process.constrainedMemory(),
      cpuUsage: cpu,
      cpuPercent,
    }
  } catch {
    return undefined
  }
}

/**
 * Get core event metadata shared across all analytics systems.
 *
 * This function collects environment, runtime, and context information
 * that should be included with all analytics events.
 *
 * @param options - Configuration options
 * @returns Promise resolving to enriched metadata object
 */
// 【主入口】组装一条事件的完整元数据。
// @param options.model  模型名（不传就用当前主循环模型）
// @param options.betas  已拼接好的 betas 字符串（不传就按模型查）
// @returns 完整的 EventMetadata
// 关键步骤：
// ① 确定模型与 betas
// ② 并发取环境上下文和仓库远程哈希
// ③ 采集进程指标
// ④ 用条件展开组装（有值才带字段）
// ⑤ 补上多智能体身份、订阅等级、仓库哈希等
export async function getEventMetadata(
  options: EnrichMetadataOptions = {},
): Promise<EventMetadata> {
  const model = options.model ? String(options.model) : getMainLoopModel()
  const betas =
    typeof options.betas === 'string'
      ? options.betas
      : getModelBetas(model).join(',')
// 并发：环境上下文和 git 远程地址哈希都是 IO 操作，并行能省一半时间。
  const [envContext, repoRemoteHash] = await Promise.all([
    buildEnvContext(),
    getRepoRemoteHash(),
  ])
  const processMetrics = buildProcessMetrics()

  const metadata: EventMetadata = {
    model,
    sessionId: getSessionId(),
    userType: process.env.USER_TYPE || '',
    ...(betas.length > 0 ? { betas: betas } : {}),
    envContext,
    ...(process.env.CLAUDE_CODE_ENTRYPOINT && {
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    }),
    ...(process.env.CLAUDE_AGENT_SDK_VERSION && {
      agentSdkVersion: process.env.CLAUDE_AGENT_SDK_VERSION,
    }),
    isInteractive: String(getIsInteractive()),
    clientType: getClientType(),
    ...(processMetrics && { processMetrics }),
    sweBenchRunId: process.env.SWE_BENCH_RUN_ID || '',
    sweBenchInstanceId: process.env.SWE_BENCH_INSTANCE_ID || '',
    sweBenchTaskId: process.env.SWE_BENCH_TASK_ID || '',
    // Swarm/team agent identification
    // Priority: AsyncLocalStorage context (subagents) > env vars (swarm teammates)
    ...getAgentIdentification(),
    // Subscription tier for DAU-by-tier analytics
    ...(getSubscriptionType() && {
      subscriptionType: getSubscriptionType()!,
    }),
    // Assistant mode tag — lives outside memoized buildEnvContext() because
    // setKairosActive() runs at main.tsx:~1648, after the first event may
    // have already fired and memoized the env. Read fresh per-event instead.
// kairosActive 刻意【不放进】memoize 的 buildEnvContext：因为它在 main.tsx 较晚才被设置，
// 而第一条事件可能在那之前就发出去了（那时会被永久缓存成 false）。
// 所以这个字段每条事件都实时读一次。这是一个很典型的「memoize 失效」陷阱。
    ...(feature('KAIROS') && getKairosActive()
      ? { kairosActive: true as const }
      : {}),
    // Repo remote hash for joining with server-side repo bundle data
    ...(repoRemoteHash && { rh: repoRemoteHash }),
  }

  return metadata
}


/**
 * Core event metadata for 1P event logging (snake_case format).
 */
// 一方后端要求的 snake_case 核心元数据字段。
export type FirstPartyEventLoggingCoreMetadata = {
  session_id: string
  model: string
  user_type: string
  betas?: string
  entrypoint?: string
  agent_sdk_version?: string
  is_interactive: boolean
  client_type: string
  swe_bench_run_id?: string
  swe_bench_instance_id?: string
  swe_bench_task_id?: string
  // Swarm/team agent identification
  agent_id?: string
  parent_session_id?: string
  agent_type?: 'teammate' | 'subagent' | 'standalone'
  team_name?: string
}

/**
 * Complete event logging metadata format for 1P events.
 */
// 一方后端的完整载荷结构：env（环境）/ process（进程指标，base64）/ auth（鉴权标识）/
// core（核心字段，各自进独立列）/ additional（其余，打包成一个 blob）。
export type FirstPartyEventLoggingMetadata = {
  env: EnvironmentMetadata
  process?: string
  // auth is a top-level field on ClaudeCodeInternalEvent (proto PublicApiAuth).
  // account_id is intentionally omitted — only UUID fields are populated client-side.
  auth?: PublicApiAuth
  // core fields correspond to the top level of ClaudeCodeInternalEvent.
  // They get directly exported to their individual columns in the BigQuery tables
  core: FirstPartyEventLoggingCoreMetadata
  // additional fields are populated in the additional_metadata field of the
  // ClaudeCodeInternalEvent proto. Includes but is not limited to information
  // that differs by event type.
  additional: Record<string, unknown>
}

/**
 * Convert metadata to 1P event logging format (snake_case fields).
 *
 * The /api/event_logging/batch endpoint expects snake_case field names
 * for environment and core metadata.
 *
 * @param metadata - Core event metadata
 * @param additionalMetadata - Additional metadata to include
 * @returns Metadata formatted for 1P event logging
 */
// 把内部驼峰结构转成一方的 snake_case 结构。
// @param metadata          内部元数据
// @param userMetadata      用户元数据（账号/组织 UUID、GitHub Action 信息）
// @param additionalMetadata 事件自带的附加字段
// @returns 一方格式的对象，交给 firstPartyEventLoggingExporter 编码
// 关键步骤：
// ① rest 解构，把 envContext / processMetrics / rh 等单独取出
// ② env：驼峰 → 蛇命（且类型强绑定 proto 生成的 EnvironmentMetadata）
// ③ core：驼峰 → 蛇命
// ④ 映射 GitHub Action 元数据、构造 auth
// ⑤ additional：把 rh / kairos / skillMode 等和调用方传入的字段合并
export function to1PEventFormat(
  metadata: EventMetadata,
  userMetadata: CoreUserData,
  additionalMetadata: Record<string, unknown> = {},
): FirstPartyEventLoggingMetadata {
  const {
    envContext,
    processMetrics,
    rh,
    kairosActive,
    skillMode,
    observerMode,
    ...coreFields
  } = metadata

  // Convert envContext to snake_case.
// 重要：env 的类型直接用【proto 生成的 EnvironmentMetadata】，而不是手写一个。
// 原因（英文注释讲得很沉痛）：proto 的 toJSON() 会【静默丢弃】未定义的键，
// 以前手写类型时有好几个字段就这么白白丢了，永远没进 BigQuery。
// 用生成类型后，「加了 proto 里没有的字段」会直接编译报错。这是一个很好的工程实践。
  // IMPORTANT: env is typed as the proto-generated EnvironmentMetadata so that
  // adding a field here that the proto doesn't define is a compile error. The
  // generated toJSON() serializer silently drops unknown keys — a hand-written
  // parallel type previously let #11318, #13924, #19448, and coworker_type all
  // ship fields that never reached BQ.
  // Adding a field? Update the monorepo proto first (go/cc-logging):
  //   event_schemas/.../claude_code/v1/claude_code_internal_event.proto
  // then run `bun run generate:proto` here.
  const env: EnvironmentMetadata = {
    platform: envContext.platform,
    platform_raw: envContext.platformRaw,
    arch: envContext.arch,
    node_version: envContext.nodeVersion,
    terminal: envContext.terminal || 'unknown',
    package_managers: envContext.packageManagers,
    runtimes: envContext.runtimes,
    is_running_with_bun: envContext.isRunningWithBun,
    is_ci: envContext.isCi,
    is_claubbit: envContext.isClaubbit,
    is_claude_code_remote: envContext.isClaudeCodeRemote,
    is_local_agent_mode: envContext.isLocalAgentMode,
    is_conductor: envContext.isConductor,
    is_github_action: envContext.isGithubAction,
    is_claude_code_action: envContext.isClaudeCodeAction,
    is_claude_ai_auth: envContext.isClaudeAiAuth,
    version: envContext.version,
    build_time: envContext.buildTime,
    deployment_environment: envContext.deploymentEnvironment,
  }

  // Add optional env fields
  if (envContext.remoteEnvironmentType) {
    env.remote_environment_type = envContext.remoteEnvironmentType
  }
  if (feature('COWORKER_TYPE_TELEMETRY') && envContext.coworkerType) {
    env.coworker_type = envContext.coworkerType
  }
  if (envContext.claudeCodeContainerId) {
    env.claude_code_container_id = envContext.claudeCodeContainerId
  }
  if (envContext.claudeCodeRemoteSessionId) {
    env.claude_code_remote_session_id = envContext.claudeCodeRemoteSessionId
  }
  if (envContext.tags) {
    env.tags = envContext.tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
  }
  if (envContext.githubEventName) {
    env.github_event_name = envContext.githubEventName
  }
  if (envContext.githubActionsRunnerEnvironment) {
    env.github_actions_runner_environment =
      envContext.githubActionsRunnerEnvironment
  }
  if (envContext.githubActionsRunnerOs) {
    env.github_actions_runner_os = envContext.githubActionsRunnerOs
  }
  if (envContext.githubActionRef) {
    env.github_action_ref = envContext.githubActionRef
  }
  if (envContext.wslVersion) {
    env.wsl_version = envContext.wslVersion
  }
  if (envContext.linuxDistroId) {
    env.linux_distro_id = envContext.linuxDistroId
  }
  if (envContext.linuxDistroVersion) {
    env.linux_distro_version = envContext.linuxDistroVersion
  }
  if (envContext.linuxKernel) {
    env.linux_kernel = envContext.linuxKernel
  }
  if (envContext.vcs) {
    env.vcs = envContext.vcs
  }
  if (envContext.versionBase) {
    env.version_base = envContext.versionBase
  }

  // Convert core fields to snake_case
  const core: FirstPartyEventLoggingCoreMetadata = {
    session_id: coreFields.sessionId,
// is_interactive 从字符串转回布尔：内部用字符串是为了兼容 logEvent 的
// 「值只能是 boolean/number/undefined」限制，这里再转回来。
    model: coreFields.model,
    user_type: coreFields.userType,
    is_interactive: coreFields.isInteractive === 'true',
    client_type: coreFields.clientType,
  }

  // Add other core fields
  if (coreFields.betas) {
    core.betas = coreFields.betas
  }
  if (coreFields.entrypoint) {
    core.entrypoint = coreFields.entrypoint
  }
  if (coreFields.agentSdkVersion) {
    core.agent_sdk_version = coreFields.agentSdkVersion
  }
  if (coreFields.sweBenchRunId) {
    core.swe_bench_run_id = coreFields.sweBenchRunId
  }
  if (coreFields.sweBenchInstanceId) {
    core.swe_bench_instance_id = coreFields.sweBenchInstanceId
  }
  if (coreFields.sweBenchTaskId) {
    core.swe_bench_task_id = coreFields.sweBenchTaskId
  }
  // Swarm/team agent identification
  if (coreFields.agentId) {
    core.agent_id = coreFields.agentId
  }
  if (coreFields.parentSessionId) {
    core.parent_session_id = coreFields.parentSessionId
  }
  if (coreFields.agentType) {
    core.agent_type = coreFields.agentType
  }
  if (coreFields.teamName) {
    core.team_name = coreFields.teamName
  }

  // Map userMetadata to output fields.
  // Based on src/utils/user.ts getUser(), but with fields present in other
  // parts of ClaudeCodeInternalEvent deduplicated.
  // Convert camelCase GitHubActionsMetadata to snake_case for 1P API
  // Note: github_actions_metadata is placed inside env (EnvironmentMetadata)
  // rather than at the top level of ClaudeCodeInternalEvent
  if (userMetadata.githubActionsMetadata) {
    const ghMeta = userMetadata.githubActionsMetadata
    env.github_actions_metadata = {
      actor_id: ghMeta.actorId,
      repository_id: ghMeta.repositoryId,
      repository_owner_id: ghMeta.repositoryOwnerId,
    }
  }

// auth 只放 UUID，刻意【不放 account_id】——那是内部数字 ID，客户端拿不到也不该上报。
  let auth: PublicApiAuth | undefined
  if (userMetadata.accountUuid || userMetadata.organizationUuid) {
    auth = {
      account_uuid: userMetadata.accountUuid,
      organization_uuid: userMetadata.organizationUuid,
    }
  }

  return {
    env,
    ...(processMetrics && {
// 进程指标整体 base64 编码成一个字段：因为它是嵌套结构且schema 可能变，
// 打包成 blob 可以避免每次加字段都要改后端表结构。
      process: Buffer.from(jsonStringify(processMetrics)).toString('base64'),
    }),
    ...(auth && { auth }),
    core,
    additional: {
      ...(rh && { rh }),
      ...(kairosActive && { is_assistant_mode: true }),
      ...(skillMode && { skill_mode: skillMode }),
      ...(observerMode && { observer_mode: observerMode }),
      ...additionalMetadata,
    },
  }
}
