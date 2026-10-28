/**
 * 【一句话定位】
 * OAuth 登录流程的「总导演」：把「起本地监听 → 生成 PKCE 参数 → 拼授权 URL → 打开浏览器 →
 * 收授权码 → 换 token → 拉资料 → 跳成功页 → 清理」这一整串动作串起来。
 *
 * 【在架构中的位置】
 * 调用链：
 *   登录命令（/login）或 SDK 的 claude_authenticate
 *     → 本文件 OAuthService.startOAuthFlow()
 *       → auth-code-listener.ts AuthCodeListener（临时本地 HTTP 服务，接浏览器回调）
 *       → crypto.ts（生成 PKCE 的 verifier/challenge 与防 CSRF 的 state）
 *       → client.ts buildAuthUrl() / exchangeCodeForTokens() / fetchProfileInfo()
 *       → utils/browser.js openBrowser()（打开系统默认浏览器）
 *   换到的 token 最后由 utils/auth.ts 的 installOAuthTokens() 落盘（本文件不负责存储）。
 *
 * 【本文件包含什么】
 * - class OAuthService：唯一的类，一次登录流程对应一个实例。
 * - startOAuthFlow()：主流程（本目录最重要的一个方法）。
 * - waitForAuthorizationCode()：同时等「自动回调」和「手动粘贴」两条路，谁先到用谁。
 * - handleManualAuthCodeInput()：外部（UI/SDK）把用户粘贴的 code 交进来。
 * - formatTokens()：把 HTTP 响应的蛇形字段整理成内部 OAuthTokens 结构。
 * - cleanup()：清理资源。
 *
 * 【两种拿授权码的方式】
 * 1. 自动（有浏览器）：起本地监听 → 开浏览器 → 授权后跳回 localhost → 自动拿到 code。
 * 2. 手动（无浏览器，如 SSH/容器）：只打印授权 URL，用户在自己电脑上打开、登录后，
 *    把页面上显示的 code 粘回终端 → 走 handleManualAuthCodeInput()。
 * 两条路并行等待，谁先到算谁（Promise 竞速）。这是 CLI 工具的标准设计。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `import * as client from './client.js'`：命名空间式导入，
 *   之后用 `client.buildAuthUrl(...)` 调用。≈ Java 的 `import static` 反过来——
 *   更像把整个类当成静态方法集合来用（Java 里对应 `Client.xxx()`）。
 * - `export class OAuthService`：TS 的 class 和 Java 高度相似，差别主要在：
 *   ① 字段声明带类型标注且可就地初始化 ② 没有访问修饰符时必须写 public（默认就是 public）。
 * - `private port: number | null = null`：`| null` 必须显式写出来（Java 的引用类型默认可空，
 *   TS 在 strict 模式下必须声明），这样编译器才会强迫你判空。
 * - `constructor() { this.codeVerifier = crypto.generateCodeVerifier() }`：
 *   构造函数和 Java 一样。这里是「构造时就生成 PKCE verifier」，保证一次登录一个 verifier。
 * - `authURLHandler: (url: string, automaticUrl?: string) => Promise<void>`：
 *   函数类型的参数（回调）。≈ Java 的 `BiConsumer<String,String>` 但要返回 CompletableFuture<Void>。
 * - `options?: { ... }`：整个 options 对象也是可选的，里面每个字段还各自可选。
 *   ≈ Java 的 Builder + 每个 setter 都可选，但 TS 用「可选属性」表达更省字。
 * - `{ ...opts, isManual: true }`：对象展开 = 复制 opts 所有字段，再覆盖 isManual。
 *   这就是「基于模板生成两个变体」的写法（manual 版和 automatic 版只差一个字段）。
 *   ≈ Java 的 `new Opts(opts).setManual(true)`（Builder 的 toBuilder 模式）。
 * - `this.authCodeListener?.waitForAuthorization(...)`：
 *   `?.` 可选链——listener 为 null 时整条链短路，返回 undefined（不会 NPE）。
 *   ≈ Java 的 `if (l != null) l.waitForAuthorization(...)`，只是这里还能继续 .then() 链式调用。
 * - `?? false`：`hasPendingResponse() ?? false` 因为 `?.` 可能返回 undefined，
 *   用 `??` 兜底成 false。这是 `?.` + `??` 的经典组合。
 * - `this.port!`：非空断言。此时我们确定 start() 已经成功、port 一定有值，
 *   但编译器看不出来，用 `!` 手动担保。≈ Java 的强制转换，写错就是运行期空指针。
 * - `Promise` 竞速模式：`new Promise((resolve, reject) => { ... })` 里同时挂了两种来源，
 *   谁先调 resolve 谁生效（Promise 只能被结束一次，后到的自动被忽略）。
 *   ≈ Java 的 `CompletableFuture.anyOf(auto, manual).join()`。
 * - `try { ... } catch { ... } finally { ... }`：和 Java 完全一样，finally 保证清理。
 * - `async` 箭头函数作为回调：`async () => { ... }` ≈ Java 的 lambda 返回 CompletableFuture。
 * - `response.organization?.uuid`：可选链读嵌套字段，任意一层为空就返回 undefined 而不是崩。
 * - `response.account ? {...} : undefined`：三元 + 对象字面量，实现「有就构造、没有就 undefined」。
 */
import { logEvent } from 'src/services/analytics/index.js'
import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from './auth-code-listener.js'
import * as client from './client.js'
import * as crypto from './crypto.js'
import type {
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
} from './types.js'

/**
 * OAuth service that handles the OAuth 2.0 authorization code flow with PKCE.
 *
 * Supports two ways to get authorization codes:
 * 1. Automatic: Opens browser, redirects to localhost where we capture the code
 * 2. Manual: User manually copies and pastes the code (used in non-browser environments)
 */
// 中文补充：一次登录 = 一个 OAuthService 实例。
// 为什么不是静态工具类：因为流程中间要持有状态（codeVerifier、listener、port、手动输入的 resolver），
// 用实例字段比到处传参清晰得多。
export class OAuthService {
// PKCE 的 code_verifier（原始随机串），全程只存在内存里，只在最后换 token 时才发出去一次。
  private codeVerifier: string
// 本地临时 HTTP 服务（自动流程用）。手动流程下也可能为 null。
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null
// 手动流程的 resolver：用户粘贴 code 时用它把 Promise 完成掉。
  private manualAuthCodeResolver: ((authorizationCode: string) => void) | null =
    null

// 构造时就生成 verifier——保证「一次登录流程一个 verifier」，和 challenge 严格配对。
  constructor() {
    this.codeVerifier = crypto.generateCodeVerifier()
  }

// 主流程入口（本目录最重要的方法）。
// @param authURLHandler 拿到授权 URL 后怎么展示给用户的回调（打印？交给 SDK？）
// @param options.skipBrowserOpen 不自己开浏览器，把两个 URL 都交给调用方（SDK 场景）
// @param options.inferenceOnly  只申请推理权限（最小权限）
// @returns 完整的 token 包（调用方负责落盘）
// 关键步骤：
// ① 起本地监听，拿到随机端口
// ② 生成 code_challenge（verifier 的 SHA256 摘要）和防 CSRF 的 state
// ③ 拼两个授权 URL：manual 版（回调到固定地址）和 automatic 版（回调到 localhost:port）
// ④ 并行等「浏览器回调」或「用户粘贴」，谁先到用谁
// ⑤ 用 code + verifier 换 token（PKCE 校验在这一步生效）
// ⑥ 拉用户资料（订阅类型、限流档位）
// ⑦ 自动流程则回 302 跳成功页；失败则跳错误页
// ⑧ finally 里一定关掉本地服务
  async startOAuthFlow(
    authURLHandler: (url: string, automaticUrl?: string) => Promise<void>,
    options?: {
      loginWithClaudeAi?: boolean
      inferenceOnly?: boolean
      expiresIn?: number
      orgUUID?: string
      loginHint?: string
      loginMethod?: string
      /**
       * Don't call openBrowser(). Caller takes both URLs via authURLHandler
       * and decides how/where to open them. Used by the SDK control protocol
       * (claude_authenticate) where the SDK client owns the user's display,
       * not this process.
       */
      skipBrowserOpen?: boolean
    },
  ): Promise<OAuthTokens> {
    // Create OAuth callback listener and start it
// 先起监听再拼 URL：因为 redirect_uri 里要写端口号，必须先知道端口是多少。
    this.authCodeListener = new AuthCodeListener()
    this.port = await this.authCodeListener.start()

    // Generate PKCE values and state
// challenge = BASE64URL(SHA256(verifier))。只把摘要发出去，原始 verifier 留到本地。
    const codeChallenge = crypto.generateCodeChallenge(this.codeVerifier)
// state 是随机串，用于防 CSRF：回调带回来的 state 必须和这个一致才认。
    const state = crypto.generateState()

    // Build auth URLs for both automatic and manual flows
// 把公共参数抽成一个 opts 对象，后面用展开运算符生成两个变体，避免重复写一堆字段。
    const opts = {
      codeChallenge,
      state,
      port: this.port,
      loginWithClaudeAi: options?.loginWithClaudeAi,
      inferenceOnly: options?.inferenceOnly,
      orgUUID: options?.orgUUID,
      loginHint: options?.loginHint,
      loginMethod: options?.loginMethod,
    }
// `{ ...opts, isManual: true }`：复制公共参数后覆盖 isManual，只差一个字段的两个 URL。
// manual 版用固定回调地址（适合用户把 code 复制出来）；automatic 版用 localhost 随机端口。
    const manualFlowUrl = client.buildAuthUrl({ ...opts, isManual: true })
    const automaticFlowUrl = client.buildAuthUrl({ ...opts, isManual: false })

    // Wait for either automatic or manual auth code
// 两条路并行：自动（浏览器跳回来）或手动（用户粘贴），谁先完成用谁。
    const authorizationCode = await this.waitForAuthorizationCode(
      state,
      async () => {
// SDK 场景：由调用方（拥有用户显示器的那个进程）决定怎么打开，本进程不越俎代庖开浏览器。
        if (options?.skipBrowserOpen) {
          // Hand both URLs to the caller. The automatic one still works
          // if the caller opens it on the same host (localhost listener
          // is running); the manual one works from anywhere.
          await authURLHandler(manualFlowUrl, automaticFlowUrl)
        } else {
// 先给手动入口（终端里打印 URL），再尝试开浏览器——万一开浏览器失败，用户还有手动这条路。
          await authURLHandler(manualFlowUrl) // Show manual option to user
          await openBrowser(automaticFlowUrl) // Try automatic flow
        }
      },
    )

    // Check if the automatic flow is still active (has a pending response)
// 怎么判断是自动还是手动完成的：自动流程会留下一个「还没回复的 HTTP 响应」（pendingResponse）。
// 有它说明是浏览器跳回来的；没有说明是用户粘贴的。
    const isAutomaticFlow = this.authCodeListener?.hasPendingResponse() ?? false
    logEvent('tengu_oauth_auth_code_received', { automatic: isAutomaticFlow })

    try {
      // Exchange authorization code for tokens
// PKCE 校验的关键一步：把原始 code_verifier 交给服务端，服务端比对
// BASE64URL(SHA256(verifier)) 是否等于第 ② 步发出的 challenge。
      const tokenResponse = await client.exchangeCodeForTokens(
        authorizationCode,
        state,
        this.codeVerifier,
// `this.port!` 非空断言：能走到这里说明 start() 已成功，port 必然有值。
        this.port!,
// redirect_uri 必须和授权时一致：自动流程用 localhost:port，手动流程用固定地址。
        !isAutomaticFlow, // Pass isManual=true if it's NOT automatic flow
        options?.expiresIn,
      )

      // Fetch profile info (subscription type and rate limit tier) for the
      // returned OAuthTokens. Logout and account storage are handled by the
      // caller (installOAuthTokens in auth.ts).
// 拉资料是为了知道用户的订阅等级（Pro/Max/企业）和限流档位，后续决定能用什么模型、多少配额。
      const profileInfo = await client.fetchProfileInfo(
        tokenResponse.access_token,
      )

      // Handle success redirect for automatic flow
// 只有自动流程才需要给浏览器回响应（手动流程没有浏览器在等）。
      if (isAutomaticFlow) {
        const scopes = client.parseScopes(tokenResponse.scope)
        this.authCodeListener?.handleSuccessRedirect(scopes)
      }

      return this.formatTokens(
        tokenResponse,
        profileInfo.subscriptionType,
        profileInfo.rateLimitTier,
        profileInfo.rawProfile,
      )
// 失败也要把浏览器流程走完（跳错误页），否则用户会卡在空白的回调页面上。
    } catch (error) {
      // If we have a pending response, send an error redirect before closing
      if (isAutomaticFlow) {
        this.authCodeListener?.handleErrorRedirect()
      }
      throw error
// finally：无论成功失败，本地 HTTP 服务都必须关掉，否则端口一直被占、进程也退不出去。
    } finally {
      // Always cleanup
      this.authCodeListener?.close()
    }
  }

// 「自动」与「手动」两条路竞速的核心实现。
// 做法：新建一个 Promise，把它包住两条来源——
//   自动：listener.waitForAuthorization() 的 then/catch 转发到这里的 resolve/reject
//   手动：把 resolve 存进 manualAuthCodeResolver，等外部调用 handleManualAuthCodeInput() 时触发
// Promise 只能被结束一次，所以先到的赢，后到的自动被忽略。
// ≈ Java 的 CompletableFuture.anyOf(futureAuto, futureManual)。
  private async waitForAuthorizationCode(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Set up manual auth code resolver
// 把 resolver 存成字段，供手动入口稍后调用——这是「跨函数完成 Promise」的常规手法。
      this.manualAuthCodeResolver = resolve

      // Start automatic flow
      this.authCodeListener
        ?.waitForAuthorization(state, onReady)
        .then(authorizationCode => {
          this.manualAuthCodeResolver = null
          resolve(authorizationCode)
        })
        .catch(error => {
          this.manualAuthCodeResolver = null
          reject(error)
        })
    })
  }

  // Handle manual flow callback when user pastes the auth code
// 手动流程入口：UI/SDK 拿到用户粘贴的 code 后调这里。
// 注意：这里【没有校验 state】。因为手动流程下用户是从页面上自己复制 code 的，
// 不存在「攻击者诱导跳转」的场景，风险模型不同。
// 注：粘贴进来的 code 形如 `code#state`，解析在调用方完成。
  handleManualAuthCodeInput(params: {
    authorizationCode: string
    state: string
  }): void {
    if (this.manualAuthCodeResolver) {
      this.manualAuthCodeResolver(params.authorizationCode)
      this.manualAuthCodeResolver = null
// 手动拿到了 code，自动监听就没用了，立刻关掉释放端口。
      // Close the auth code listener since manual input was used
      this.authCodeListener?.close()
    }
  }

// 把 HTTP 响应的蛇形命名（access_token/expires_in）整理成内部驼峰结构（accessToken/expiresAt）。
// expires_in 是「多少秒后过期」，这里换算成绝对时间戳，后面判断过期只需比大小。
  private formatTokens(
    response: OAuthTokenExchangeResponse,
    subscriptionType: SubscriptionType | null,
    rateLimitTier: RateLimitTier | null,
    profile?: OAuthProfileResponse,
  ): OAuthTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: client.parseScopes(response.scope),
      subscriptionType,
      rateLimitTier,
      profile,
      tokenAccount: response.account
        ? {
            uuid: response.account.uuid,
            emailAddress: response.account.email_address,
            organizationUuid: response.organization?.uuid,
          }
        : undefined,
    }
  }

  // Clean up any resources (like the local server)
// 清理：关本地服务 + 清 resolver，防止残留引用导致内存泄漏。
  cleanup(): void {
    this.authCodeListener?.close()
    this.manualAuthCodeResolver = null
  }
}
