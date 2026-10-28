/**
 * 【一句话定位】为远程 MCP server（SSE / HTTP / WebSocket）准备请求头：静态 headers + 动态 headersHelper 脚本。
 *
 * 【在架构中的位置】
 * - 上游：client.ts 建立 SSE/HTTP/WS 连接前，调 getMcpServerHeaders(serverName, config) 拿到最终请求头。
 * - 下游：execFileNoThrowWithCwd（执行用户的 helper 脚本）、checkHasTrustDialogAccepted（工作区信任检查）。
 *
 * 【本文件包含什么】
 * - isMcpServerFromProjectOrLocalSettings(config)：判断配置是不是来自项目/本地 settings（用于安全校验）。
 * - getMcpHeadersFromHelper(name, config)：执行 headersHelper 脚本拿动态请求头，失败返回 null。
 * - getMcpServerHeaders(name, config)：合并静态 + 动态请求头（动态覆盖静态）。
 *
 * 【为什么需要 headersHelper】
 * 很多企业的 token 是短时效的、或存放在钥匙串里，静态写在配置里既不安全也会过期。
 * headersHelper 让用户提供一个脚本（类似 git credential-helper），每次建连前跑一次拿新鲜 header。
 *
 * 【安全设计（重点）】
 * 执行用户脚本＝执行任意代码。项目级配置（.mcp.json 随仓库分发）尤其危险：clone 一个陌生仓库就会被执行。
 * 所以来自 project/local 作用域的 headersHelper 必须先通过「工作区信任」对话框；
 * 非交互模式（CI）无法弹框，只能跳过检查（英文注释里有说明）。
 *
 * 【TS 语法速查】
 * - `'scope' in config`：in 运算符做「类型收窄」，运行时判断对象有没有这个字段，
 *   编译期还能把类型缩窄成有该字段的分支（Java 没有这种写法）。
 * - `config as ScopedMcpServerConfig`：`as` 是编译期强制类型转换 ≈ Java 的 (ScopedMcpServerConfig) 强转。
 * - `Record<string, string>` ≈ Map<String,String>；`{...a, ...b}` 展开运算符 = 浅拷贝并合并，
 *   后面的覆盖前面的，是不可变更新的惯用写法（≈ Java 里 new HashMap + putAll）。
 * - `Promise<Record<string, string> | null>`：返回值可能是 null，调用方必须处理。
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { logAntError } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { logError, logMCPDebug, logMCPError } from '../../utils/log.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { logEvent } from '../analytics/index.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpWebSocketServerConfig,
  ScopedMcpServerConfig,
} from './types.js'

/**
 * Check if the MCP server config comes from project settings (projectSettings or localSettings)
 * This is important for security checks
 */
  /**
   * 中文：判断这条 MCP 配置是否来自「项目级 / 本地级」settings。
   * 为什么要区分：user 级配置是用户自己写的，可信；project 级（.mcp.json）是随仓库分发的，
   * 可能是别人写的，执行它的脚本前必须先经过信任确认。
   */
function isMcpServerFromProjectOrLocalSettings(
  config: ScopedMcpServerConfig,
): boolean {
  return config.scope === 'project' || config.scope === 'local'
}

/**
 * Get dynamic headers for an MCP server using the headersHelper script
 * @param serverName The name of the MCP server
 * @param config The MCP server configuration
 * @returns Headers object or null if not configured or failed
 */
  /**
   * 中文：跑一次 headersHelper 脚本，取动态请求头。
   * 入参 serverName / config：server 名与它的（SSE/HTTP/WS）配置。
   * 返回：headers 对象；没配 headersHelper、或任何一步失败都返回 null。
   * 为什么失败返回 null 而不是抛错：请求头拿不到最多是这个 server 连不上，
   * 不该把整个 Claude Code 的启动流程打断（英文注释：avoid blocking the connection）。
   * 步骤：① 没配 helper 直接返回 null；② 项目级配置要先过信任检查；
   *      ③ 执行脚本（10s 超时）；④ 校验 stdout 是 JSON 对象且值都是字符串。
   */
export async function getMcpHeadersFromHelper(
  serverName: string,
  config: McpSSEServerConfig | McpHTTPServerConfig | McpWebSocketServerConfig,
): Promise<Record<string, string> | null> {
  // 中文：没配 headersHelper 是绝大多数情况，走最快路径直接返回
  if (!config.headersHelper) {
    return null
  }

  // Security check for project/local settings
  // Skip trust check in non-interactive mode (e.g., CI/CD, automation)
  // 中文：安全闸门——只有 project/local 作用域、且当前是交互模式才检查信任；
  //       非交互（CI）下没法弹信任对话框，只能跳过（这是明确的权衡，不是疏漏）
  if (
    'scope' in config &&
    // 中文：'scope' in config 既判断字段存在，又让 TS 把 config 收窄成 ScopedMcpServerConfig
    isMcpServerFromProjectOrLocalSettings(config as ScopedMcpServerConfig) &&
    !getIsNonInteractiveSession()
  ) {
    // Check if trust has been established for this project
    // 中文：用户没确认信任这个工作区 → 拒绝执行脚本，并埋点记录（便于发现真实用户被误伤）
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      const error = new Error(
        `Security: headersHelper for MCP server '${serverName}' executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('MCP headersHelper invoked before trust check', error)
      logEvent('tengu_mcp_headersHelper_missing_trust', {})
      return null
    }
  }

  try {
    logMCPDebug(serverName, 'Executing headersHelper to get dynamic headers')
    // 中文：shell:true 让用户能写 'op read ...' 这类带管道的命令；10s 超时防止脚本挂死拖住启动
    const execResult = await execFileNoThrowWithCwd(config.headersHelper, [], {
      shell: true,
      timeout: 10000,
      // Pass server context so one helper script can serve multiple MCP servers
      // (git credential-helper style). See deshaw/anthropic-issues#28.
      env: {
        ...process.env,
        CLAUDE_CODE_MCP_SERVER_NAME: serverName,
        CLAUDE_CODE_MCP_SERVER_URL: config.url,
      },
    })
    // 中文：退出码非 0 或 stdout 为空都视为失败——脚本可能把 header 打到 stderr，这里刻意不读 stderr
    if (execResult.code !== 0 || !execResult.stdout) {
      throw new Error(
        `headersHelper for MCP server '${serverName}' did not return a valid value`,
      )
    }
    const result = execResult.stdout.trim()

    // 中文：必须校验成「字符串键值对的对象」：数组/null/数字都会让下游 header 拼接出问题
    const headers = jsonParse(result)
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new Error(
        `headersHelper for MCP server '${serverName}' must return a JSON object with string key-value pairs`,
      )
    }

    // Validate all values are strings
    // 中文：header 值只允许字符串；若允许数字/对象，最终 setHeader 时会拿到 '[object Object]' 这种脏值
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new Error(
          `headersHelper for MCP server '${serverName}' returned non-string value for key "${key}": ${typeof value}`,
        )
      }
    }

    logMCPDebug(
      serverName,
      `Successfully retrieved ${Object.keys(headers).length} headers from headersHelper`,
    )
    return headers as Record<string, string>
  } catch (error) {
    logMCPError(
      serverName,
      `Error getting headers from headersHelper: ${errorMessage(error)}`,
    )
    logError(
      new Error(
        `Error getting MCP headers from headersHelper for server '${serverName}': ${errorMessage(error)}`,
      ),
    )
    // Return null instead of throwing to avoid blocking the connection
    // 中文：吞掉异常返回 null——连接失败会以「server 连不上」的形式暴露，比整个启动崩掉友好
    return null
  }
}

/**
 * Get combined headers for an MCP server (static + dynamic)
 * @param serverName The name of the MCP server
 * @param config The MCP server configuration
 * @returns Combined headers object
 */
  /**
   * 中文：合并静态与动态请求头，这是外部真正调用的入口。
   * 返回：永远返回对象（拿不到动态头时就是纯静态头），调用方不需要判 null。
   */
export async function getMcpServerHeaders(
  serverName: string,
  config: McpSSEServerConfig | McpHTTPServerConfig | McpWebSocketServerConfig,
): Promise<Record<string, string>> {
  const staticHeaders = config.headers || {}
  const dynamicHeaders =
    (await getMcpHeadersFromHelper(serverName, config)) || {}

  // Dynamic headers override static headers if both are present
  // 中文：展开顺序决定优先级——dynamic 写在后面，所以同名的动态头会覆盖静态头
  return {
    ...staticHeaders,
    ...dynamicHeaders,
  }
}
