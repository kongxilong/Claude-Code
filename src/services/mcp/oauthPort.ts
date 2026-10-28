/**
 * 【一句话定位】OAuth 回调端口工具：挑选可用的 localhost 重定向端口，并拼出 redirect URI。
 *
 * 【在架构中的位置】
 * - 为什么单独拆一个文件：英文头注说得很清楚——为了打断 auth.ts ↔ xaaIdpLogin.ts 的循环依赖。
 *   两边都要用端口逻辑，就抽到这个谁都不依赖的叶子模块。
 * - 上游：auth.ts（MCP server 的 OAuth 授权码流程）、xaaIdpLogin.ts（XAA / IdP 登录）。
 * - 下游：只依赖 Node 的 http 模块和平台判断。
 *
 * 【本文件包含什么】
 * - REDIRECT_PORT_RANGE / REDIRECT_PORT_FALLBACK：端口范围常量。
 * - buildRedirectUri(port)：拼 http://localhost:<port>/callback。
 * - getMcpOAuthCallbackPort()：读环境变量 MCP_OAUTH_CALLBACK_PORT（模块内部函数，不导出）。
 * - findAvailablePort()：随机挑端口并试监听，失败则退到固定端口。
 *
 * 【为什么用随机端口】
 * 固定端口可能被本机其它（恶意）进程预先占用，从而截获授权码；随机端口 + loopback 是 RFC 8252 的推荐做法。
 *
 * 【TS 语法速查】
 * - `const RANGE = cond ? A : B`：三元表达式 ≈ Java 的 `? :`，可用于初始化模块级常量。
 * - `function f(port: number = FALLBACK)`：参数默认值，Java 只能靠重载模拟。
 * - `` `http://localhost:${port}/callback` ``：反引号是模板字符串 ≈ Java 文本块 + String.format 合体。
 * - `new Promise<void>((resolve, reject) => {...})`：把回调式 API 包成 Promise，
 *   ≈ Java 里手写 CompletableFuture 并在回调里 complete / completeExceptionally。
 * - `parseInt(x, 10)` 的第二个参数必须写 10，否则 '0x10' 会被当成十六进制解析（经典坑）。
 */
/**
 * OAuth redirect port helpers — extracted from auth.ts to break the
 * auth.ts ↔ xaaIdpLogin.ts circular dependency.
 */
import { createServer } from 'http'
import { getPlatform } from '../../utils/platform.js'

// Windows dynamic port range 49152-65535 is reserved
const REDIRECT_PORT_RANGE =
  getPlatform() === 'windows'
    ? { min: 39152, max: 49151 }
    : { min: 49152, max: 65535 }
const REDIRECT_PORT_FALLBACK = 3118

/**
 * Builds a redirect URI on localhost with the given port and a fixed `/callback` path.
 *
 * RFC 8252 Section 7.3 (OAuth for Native Apps): loopback redirect URIs match any
 * port as long as the path matches.
 */
  /**
   * 中文：拼出 OAuth 的 redirect_uri。固定用 /callback 作为 path。
   * 入参 port：回调监听端口，不给就用固定兜底端口 3118。
   * 返回：形如 http://localhost:3118/callback 的字符串。
   * 为什么端口可以随便换：RFC 8252 §7.3 规定 loopback 重定向只校验 path 是否匹配，端口任意。
   */
export function buildRedirectUri(
  port: number = REDIRECT_PORT_FALLBACK,
): string {
  return `http://localhost:${port}/callback`
}

  /**
   * 中文：读环境变量 MCP_OAUTH_CALLBACK_PORT；没配或不是正数就返回 undefined（意思是“交给随机挑选”）。
   * 为什么用 `port > 0` 判断而不是判 NaN：parseInt('abc') 得 NaN，而 NaN > 0 为 false，
   * 一行就能同时挡住「没配」和「配了个非数字」两种脏输入。
   */
function getMcpOAuthCallbackPort(): number | undefined {
  const port = parseInt(process.env.MCP_OAUTH_CALLBACK_PORT || '', 10)
  return port > 0 ? port : undefined
}

/**
 * Finds an available port in the specified range for OAuth redirect
 * Uses random selection for better security
 */
  /**
   * 中文：找一个当前能监听的端口。
   * 步骤：① 配了 MCP_OAUTH_CALLBACK_PORT 就直接用（方便自动化测试固定端口）；
   *      ② 否则在端口范围内随机试，最多 100 次（不无限重试，避免启动卡死）；
   *      ③ 全失败就试固定端口 3118；④ 再失败才抛错。
   * “试监听”的做法：createServer().listen(port) 成功即说明端口空闲，随即 close 掉。
   * 注意这是 TOCTOU（检查与使用之间有时间窗），理论上仍可能被抢占，但本机场景可接受。
   */
export async function findAvailablePort(): Promise<number> {
  // First, try the configured port if specified
  const configuredPort = getMcpOAuthCallbackPort()
  if (configuredPort) {
    return configuredPort
  }

  const { min, max } = REDIRECT_PORT_RANGE
  const range = max - min + 1
  // 中文：最多试 100 次，防止端口大面积被占用时陷入长时间循环
  const maxAttempts = Math.min(range, 100) // Don't try forever

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 中文：用随机而非顺序递增——顺序可预测，等于给攻击者提供了“提前占好下一个端口”的机会
    const port = min + Math.floor(Math.random() * range)

    try {
      await new Promise<void>((resolve, reject) => {
        const testServer = createServer()
        testServer.once('error', reject)
        testServer.listen(port, () => {
          testServer.close(() => resolve())
        })
      })
      return port
    } catch {
      // Port in use, try another random port
      continue
    }
  }

  // If random selection failed, try the fallback port
  try {
    await new Promise<void>((resolve, reject) => {
      const testServer = createServer()
      testServer.once('error', reject)
      testServer.listen(REDIRECT_PORT_FALLBACK, () => {
        testServer.close(() => resolve())
      })
    })
    return REDIRECT_PORT_FALLBACK
  } catch {
    throw new Error(`No available ports for OAuth redirect`)
  }
}
