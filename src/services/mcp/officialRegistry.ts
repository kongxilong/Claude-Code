/**
 * 【一句话定位】拉取并查询 Anthropic 官方 MCP server 注册表（registry），用来判断某个 URL 是不是“官方”server。
 *
 * 【在架构中的位置】
 * - 上游：启动时调一次 prefetchOfficialMcpUrls() 做「发后不管」的预取。
 * - 下游：client.ts 等处在打日志 / 做埋点上报前，用 isOfficialMcpUrl() 判断 URL 是否官方，
 *   以便对非官方 server 脱敏——官方 URL 可以明文写进日志，第三方 URL 可能含 token，必须打码。
 *
 * 【本文件包含什么】
 * - normalizeUrl(url)：去掉 query 串和结尾斜杠，让两个 URL 能直接用字符串相等比较。
 * - prefetchOfficialMcpUrls()：GET 官方注册表，把结果灌进模块级 Set。
 * - isOfficialMcpUrl(url)：查询；注册表没拉到时返回 false（fail-closed，宁可脱敏过头）。
 * - resetOfficialMcpUrlsForTesting()：仅测试用，清空缓存。
 *
 * 【TS 语法速查】
 * - `let officialUrls: Set<string> | undefined = undefined`：模块级可变缓存
 *   ≈ Java 的 `static Set<String>`；用 undefined 表示“还没拉到”，而不是用空 Set（二者语义不同）。
 * - `entry.server.remotes ?? []`：`??` 是空值合并，只有 null/undefined 才取右边；
 *   注意与 `||` 的区别：`||` 会把 0 和 '' 也当成假值替换掉，`??` 不会。
 * - `officialUrls?.has(x) ?? false`：可选链 + 空值合并连写，
 *   ≈ Java 的 `officialUrls != null ? officialUrls.contains(x) : false`。
 * - `catch { ... }`：可选 catch 绑定（ES2019+），不需要给异常命名，Java 必须写 catch (Exception e)。
 * - `axios.get<RegistryResponse>(url, { timeout })`：给响应体指定泛型 ≈ Java 的 
 *   `ResponseEntity<RegistryResponse>`；之后写错字段名会在编译期报错。
 * - `type X = { ... }`：类型别名 ≈ Java 的 record，但只存在于编译期，运行时没有任何东西。
 */
import axios from 'axios'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'

type RegistryServer = {
  server: {
    remotes?: Array<{ url: string }>
  }
}

type RegistryResponse = {
  servers: RegistryServer[]
}

// URLs stripped of query string and trailing slash — matches the normalization
// done by getLoggingSafeMcpBaseUrl so direct Set.has() lookup works.
  // 中文：缓存里只存「规范化后」的 URL，这样查询时能用 Set.has() 做 O(1) 精确命中，
  //       不必每次都重新规范化（调用方传进来的已经是 getLoggingSafeMcpBaseUrl 处理过的）
let officialUrls: Set<string> | undefined = undefined

  /**
   * 中文：把 URL 归一化——去掉 ?query 与结尾的 /；返回 undefined 表示这个 URL 根本不合法。
   * 为什么返回 undefined 而不是抛异常：注册表里可能有脏数据，一个坏 URL 不该让整次预取失败。
   */
function normalizeUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    u.search = ''
    return u.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

/**
 * Fire-and-forget fetch of the official MCP registry.
 * Populates officialUrls for isOfficialMcpUrl lookups.
 */
  /**
   * 中文：发后不管（fire-and-forget）地拉一次官方注册表，结果写进模块级缓存。
   * 为什么是「预取 + 缓存」而不是「查询时现拉」：这个判断发生在打日志/埋点的热路径上，
   * 每次都发 HTTP 会拖慢启动；而官方注册表变化极慢，一次会话拉一次足够。
   * 失败策略：整段 try/catch 吞掉异常——“是否官方”只是日志脱敏的辅助信息，拉不到就当全部非官方
   * （最保守），绝不能因为拉取失败就阻断 MCP 连接。
   */
export async function prefetchOfficialMcpUrls(): Promise<void> {
  // 中文：尊重「禁止非必要网络流量」开关，CI / 离线环境下直接放弃预取
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    return
  }

  try {
    const response = await axios.get<RegistryResponse>(
      'https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial',
      { timeout: 5000 },
    )

    const urls = new Set<string>()
    // 中文：一个 server 可能有多个 remote 端点，逐个规范化后收入集合；脏 URL 会被 normalizeUrl 返回 undefined 跳过
    for (const entry of response.data.servers) {
      for (const remote of entry.server.remotes ?? []) {
        const normalized = normalizeUrl(remote.url)
        if (normalized) {
          urls.add(normalized)
        }
      }
    }
    officialUrls = urls
    logForDebugging(`[mcp-registry] Loaded ${urls.size} official MCP URLs`)
  } catch (error) {
    logForDebugging(`Failed to fetch MCP registry: ${errorMessage(error)}`, {
      level: 'error',
    })
  }
}

/**
 * Returns true iff the given (already-normalized via getLoggingSafeMcpBaseUrl)
 * URL is in the official MCP registry. Undefined registry → false (fail-closed).
 */
  /**
   * 中文：判断（已规范化的）URL 是否在官方注册表里。
   * 入参 normalizedUrl：必须已经过 getLoggingSafeMcpBaseUrl 规范化，否则可能查不中。
   * 返回：true = 官方；注册表未就绪时返回 false（fail-closed：宁可多脱敏，不可泄露第三方 URL）。
   */
export function isOfficialMcpUrl(normalizedUrl: string): boolean {
  return officialUrls?.has(normalizedUrl) ?? false
}

  // 中文：仅供单元测试清空缓存，生产代码不要调用
export function resetOfficialMcpUrlsForTesting(): void {
  officialUrls = undefined
}
