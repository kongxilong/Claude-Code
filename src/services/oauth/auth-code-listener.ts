/**
 * 【一句话定位】
 * OAuth 登录时临时启动的本机 HTTP 服务，专门用来「接住」浏览器回调带回来的授权码（authorization code）。
 * 它不是 OAuth 服务器，只是一个一次性的重定向捕获器。
 *
 * 【在架构中的位置】
 * 调用链：
 *   services/oauth/index.ts（登录编排）
 *     → 本文件 AuthCodeListener.start()（起服务、拿到随机端口）
 *     → client.ts buildAuthUrl({ port })（把回调地址写成 http://localhost:<port>/callback）
 *     → 用户浏览器完成授权 → 重定向回 http://localhost:<port>/callback?code=xxx&state=yyy
 *     → 本文件 handleRedirect() 捕获 code → waitForAuthorization() 的 Promise 被 resolve
 *     → client.ts exchangeCodeForTokens(code, verifier) 换 token
 * 下游：Node 内置 http 模块（≈ Java 的 com.sun.net.httpserver / Servlet 容器）。
 *
 * 【CLI 为什么需要它（重点）】
 * OAuth 授权码模式要求「授权服务器把 code 送到某个 redirect_uri」。
 * Web 应用有固定域名，CLI 没有。解决方案就是：登录时临时在本机起一个 HTTP 服务，
 * 监听一个随机端口，把这个端口写进 redirect_uri。浏览器跳回来时我们从中取出 code，然后立刻关掉服务。
 * 这就是现在所有 CLI 工具（gcloud、gh、azure-cli）的标准做法。
 * 两点安全设计：
 * - 端口用 0 让操作系统随机分配（避免固定端口被别的进程占用，也避免攻击者预先监听）；
 * - 只 bind localhost（不监听 0.0.0.0），外部机器连不进来。
 *
 * 【本文件包含什么】
 * - class AuthCodeListener：唯一的类，封装临时 HTTP 服务与一个「等待授权码」的 Promise。
 * - start()：监听端口，返回实际端口号。
 * - getPort() / hasPendingResponse()：两个只读查询。
 * - waitForAuthorization()：返回 Promise，授权码到达时才 resolve。
 * - handleSuccessRedirect() / handleErrorRedirect()：给浏览器回 302，跳到成功/错误页。
 * - startLocalListener() / handleRedirect() / validateAndRespond() / handleError() / resolve() / reject()：内部实现。
 * - close()：收尾（先补一个重定向响应，再关服务）。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `export class X { ... }`：TS 的类和 Java 很像（构造函数、private、方法），
 *   但注意 TS 没有「字段必须先在类里声明」的强制要求，字段声明就写在类体里。
 * - `private localServer: Server`：private ≈ Java 的 private，但是【编译期】约束，
 *   运行期 JS 里其实能访问（Java 靠反射也能，但语义不同）。TS 有真私有写法 `#field`。
 * - `private port: number = 0`：字段声明时直接给初始值，≈ Java 的 `private int port = 0;`。
 * - `private promiseResolver: ((authorizationCode: string) => void) | null = null`：
 *   这是一个「函数类型 + 可能为 null」的字段。
 *   ≈ Java 的 `private Consumer<String> promiseResolver = null;`
 * - 构造函数 `constructor(callbackPath: string = '/callback')`：
 *   带默认值的参数，Java 没有这个语法（要写重载或 Builder）。
 * - `this.xxx`：和 Java 一样，但在 JS 里 this 的绑定更「活」，所以常需要 .bind(this)（见下）。
 * - `this.localServer.on('request', this.handleRedirect.bind(this))`：
 *   `.bind(this)` 是 JS 特有的坑：把方法当回调传出去时，方法里的 this 会丢失，
 *   必须 bind 固定住。Java 的 `this::handleRedirect` 方法引用天然就没这问题。
 * - `async start(port?: number): Promise<number>`：
 *   `port?` 可选参数 ≈ 可以不传。返回 Promise<number> ≈ CompletableFuture<Integer>。
 * - `new Promise((resolve, reject) => {...})`：手动构造 Promise，
 *   ≈ Java 的 `new CompletableFuture<>()` 之后手动 complete/completeExceptionally。
 *   这里把「事件驱动的 HTTP 回调」桥接成「可 await 的 Promise」，是本文件的核心技巧。
 * - `this.localServer.listen(port ?? 0, 'localhost', () => {...})`：
 *   `??` 空值合并（port 没传就用 0 = 让 OS 分配端口）。注意这里不能用 `||`，
 *   因为 port=0 是合法且有意义的「请 OS 分配」指令，`||` 会把它替换掉。
 * - `this.localServer.address() as AddressInfo`：
 *   address() 的返回类型是 `string | AddressInfo | null`，用 `as` 断言成我们需要的那个。
 *   ≈ Java 的 `(AddressInfo) server.getAddress()` 强制转换。
 * - `void onReady()`：前缀 void 表示「我知道这是个 Promise，但故意不等它」。
 *   避免 linter 报「忘记 await」。
 * - `parsedUrl.searchParams.get('code') ?? undefined`：
 *   URLSearchParams 的 get 取不到时返回 null，用 `??` 转成 undefined，统一「空」的表示。
 * - `res.writeHead(302, { Location: successUrl })`：302 是重定向状态码，Location 头指定目标地址。
 *   ≈ Java Servlet 的 `response.sendRedirect(url)`。
 * - `customHandler?: (res: ServerResponse, scopes: string[]) => void`：
 *   可选的函数类型参数 ≈ Java 的 `@Nullable BiConsumer<Response, List<String>>`。
 * - `private` 方法：和 Java 一样只在类内部可调用（编译期约束）。
 * - 类字段末尾的 `// State parameter for CSRF protection` 这类行尾注释：TS/JS 里很常见，
 *   和 Java 的 `// 注释` 完全一样。
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { logEvent } from 'src/services/analytics/index.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { logError } from '../../utils/log.js'
import { shouldUseClaudeAIAuth } from './client.js'

/**
 * Temporary localhost HTTP server that listens for OAuth authorization code redirects.
 *
 * When the user authorizes in their browser, the OAuth provider redirects to:
 * http://localhost:[port]/callback?code=AUTH_CODE&state=STATE
 *
 * This server captures that redirect and extracts the auth code.
 * Note: This is NOT an OAuth server - it's just a redirect capture mechanism.
 */
// 中文补充：这是本文件唯一的类，也是整个 CLI 版 OAuth 的关键一环。
// 生命周期很短：start() → 等一个回调 → close()。用完即弃，绝不长驻。
export class AuthCodeListener {
// 私有字段声明。Java 工程师注意：TS 的字段声明写在类体里、带类型标注、可给默认值，
// 和 Java 的 `private Server localServer;` 是一个意思，只是 TS 允许就地初始化。
  private localServer: Server
  private port: number = 0
// 把 Promise 的 resolve/reject 两个函数「存」成字段：
// 这样 HTTP 回调（异步、在别处触发）就能在完成时手动结束这个 Promise。
// ≈ Java 里把 CompletableFuture 对象存成字段，回调里调 complete()。
  private promiseResolver: ((authorizationCode: string) => void) | null = null
  private promiseRejecter: ((error: Error) => void) | null = null
// expectedState：授权请求时发出的随机串。回调带回来的 state 必须和它一致，否则拒绝——防 CSRF。
  private expectedState: string | null = null // State parameter for CSRF protection
// 把这次 HTTP 请求的 response 对象先存下来：因为「跳成功页」的时机在换完 token 之后，
// 那时才能回这个 302。不存的话这次响应早就超时了。
  private pendingResponse: ServerResponse | null = null // Response object for final redirect
  private callbackPath: string // Configurable callback path

// createServer() 只是创建服务对象，此刻还没监听端口（监听在 start() 里）。
  constructor(callbackPath: string = '/callback') {
    this.localServer = createServer()
    this.callbackPath = callbackPath
  }

  /**
   * Starts listening on an OS-assigned port and returns the port number.
   * This avoids race conditions by keeping the server open until it's used.
   * @param port Optional specific port to use. If not provided, uses OS-assigned port.
   */
// 监听端口并返回实际端口号。
// @param port 不传（或传 0）表示「让操作系统随便分配一个空闲端口」
// @returns 实际监听到的端口号（必须回给调用方，因为拼授权 URL 时要写进去）
// 为什么用 Promise 包一层：listen 是回调式 API，包成 Promise 才能 await。
  async start(port?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.localServer.once('error', err => {
        reject(
          new Error(`Failed to start OAuth callback server: ${err.message}`),
        )
      })

      // Listen on specified port or 0 to let the OS assign an available port
// 端口 0 = 请 OS 分配空闲端口；'localhost' = 只监听回环地址，外部机器访问不到（安全要求）。
// `port ?? 0` 必须用 ?? 不能用 ||：port=0 是有意义的合法值（OS 分配），|| 会把它替换掉。
      this.localServer.listen(port ?? 0, 'localhost', () => {
// address() 返回类型很宽（string | AddressInfo | null），as 断言成我们需要的结构以便读 .port。
        const address = this.localServer.address() as AddressInfo
        this.port = address.port
        resolve(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  hasPendingResponse(): boolean {
    return this.pendingResponse !== null
  }

// 核心方法：返回一个 Promise，直到浏览器把 code 送回来才 resolve。
// @param state    期望的 state 值（防 CSRF 比对用）
// @param onReady  服务已就绪的回调（通常在这里打开浏览器）
// @returns 授权码字符串
// 注意这里把 resolve/reject 存进字段——因为触发它们的时机在别的函数（handleRedirect）里。
  async waitForAuthorization(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.promiseResolver = resolve
      this.promiseRejecter = reject
      this.expectedState = state
      this.startLocalListener(onReady)
    })
  }

  /**
   * Completes the OAuth flow by redirecting the user's browser to a success page.
   * Different success pages are shown based on the granted scopes.
   * @param scopes The OAuth scopes that were granted
   * @param customHandler Optional custom handler to serve response instead of redirecting
   */
// 换完 token 之后调用：给浏览器回一个 302，跳到成功页（用户看到「登录成功」）。
// 为什么要等换完 token 才跳：万一换 token 失败（比如 PKCE 校验不过），
// 应该走 handleErrorRedirect 而不是告诉用户成功了。
  handleSuccessRedirect(
    scopes: string[],
    customHandler?: (res: ServerResponse, scopes: string[]) => void,
  ): void {
// 没有待处理的响应（比如手动模式，压根没走过浏览器回调）就什么都不做。
    if (!this.pendingResponse) return

    // If custom handler provided, use it instead of default redirect
// customHandler 允许调用方自己决定怎么响应（比如桌面端要渲染自己的页面），是扩展点。
    if (customHandler) {
      customHandler(this.pendingResponse, scopes)
      this.pendingResponse = null
      logEvent('tengu_oauth_automatic_redirect', { custom_handler: true })
      return
    }

    // Default behavior: Choose success page based on granted permissions
// 根据拿到的 scope 决定跳哪个成功页（claude.ai 用户 vs console 用户看到的页面不同）。
    const successUrl = shouldUseClaudeAIAuth(scopes)
      ? getOauthConfig().CLAUDEAI_SUCCESS_URL
      : getOauthConfig().CONSOLE_SUCCESS_URL

    // Send browser to success page
// 302 = 临时重定向。回完就把 pendingResponse 置空，防止被重复结束（写两次会抛错）。
    this.pendingResponse.writeHead(302, { Location: successUrl })
    this.pendingResponse.end()
    this.pendingResponse = null

    logEvent('tengu_oauth_automatic_redirect', {})
  }

  /**
   * Handles error case by sending a redirect to the appropriate success page with an error indicator,
   * ensuring the browser flow is completed properly.
   */
// 出错时也跳一个页面（目前复用成功页），目的是「把浏览器流程走完」，
// 否则用户会停在回调地址上看到一个空白页，体验很差。
  handleErrorRedirect(): void {
    if (!this.pendingResponse) return

    // TODO: swap to a different url once we have an error page
    const errorUrl = getOauthConfig().CLAUDEAI_SUCCESS_URL

    // Send browser to error page
    this.pendingResponse.writeHead(302, { Location: errorUrl })
    this.pendingResponse.end()
    this.pendingResponse = null

    logEvent('tengu_oauth_automatic_redirect_error', {})
  }

// 挂上请求处理器。.bind(this) 是必须的：不绑的话 handleRedirect 里的 this 是 undefined。
  private startLocalListener(onReady: () => Promise<void>): void {
    // Server is already created and listening, just set up handlers
    this.localServer.on('request', this.handleRedirect.bind(this))
    this.localServer.on('error', this.handleError.bind(this))

    // Server is already listening, so we can call onReady immediately
// `void` 前缀：明确表示「故意不 await」。onReady（打开浏览器）不该阻塞等待授权的流程。
    void onReady()
  }

// 每来一个 HTTP 请求都会走这里。
// 用 `new URL(req.url, base)` 解析：req.url 只是路径+查询串，必须补个 base 才能用 URL 类解析。
  private handleRedirect(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(
      req.url || '',
      `http://${req.headers.host || 'localhost'}`,
    )

// 只认 /callback 这一个路径，其他一律 404（避免本机其他请求误打进来被当成授权回调）。
    if (parsedUrl.pathname !== this.callbackPath) {
      res.writeHead(404)
      res.end()
      return
    }

// searchParams.get 取不到时返回 null，用 `??` 统一转成 undefined，后面判断更省事。
    const authCode = parsedUrl.searchParams.get('code') ?? undefined
    const state = parsedUrl.searchParams.get('state') ?? undefined

    this.validateAndRespond(authCode, state, res)
  }

// 校验两步：① code 必须存在 ② state 必须和发出去的一致。任一不满足都拒绝并 reject Promise。
  private validateAndRespond(
    authCode: string | undefined,
    state: string | undefined,
    res: ServerResponse,
  ): void {
    if (!authCode) {
      res.writeHead(400)
      res.end('Authorization code not found')
      this.reject(new Error('No authorization code received'))
      return
    }

// state 比对是防 CSRF 的关键一步：攻击者即使诱导用户点了恶意链接，
// 带回来的 state 也对不上我们本地生成的那个，登录会被拦下。
    if (state !== this.expectedState) {
      res.writeHead(400)
      res.end('Invalid state parameter')
      this.reject(new Error('Invalid state parameter'))
      return
    }

    // Store the response for later redirect
// 先把 response 存起来：此刻还不能回 302，得等 token 换完才知道跳成功还是失败页。
// 但 Promise 可以先 resolve，让调用方（登录编排）继续往下走。
    this.pendingResponse = res

    this.resolve(authCode)
  }

  private handleError(err: Error): void {
    logError(err)
    this.close()
    this.reject(err)
  }

// 手动完成 Promise。置空 resolver/rejecter 防止被重复调用（Promise 只能结束一次）。
  private resolve(authorizationCode: string): void {
    if (this.promiseResolver) {
      this.promiseResolver(authorizationCode)
      this.promiseResolver = null
      this.promiseRejecter = null
    }
  }

  private reject(error: Error): void {
    if (this.promiseRejecter) {
      this.promiseRejecter(error)
      this.promiseResolver = null
      this.promiseRejecter = null
    }
  }

// 收尾：先补一个重定向（让浏览器有个去处），再摘掉所有监听器并关服务。
// removeAllListeners 防内存泄漏；close() 让 Node 能正常退出（否则事件循环一直有句柄）。
  close(): void {
    // If we have a pending response, send a redirect before closing
    if (this.pendingResponse) {
      this.handleErrorRedirect()
    }

    if (this.localServer) {
      // Remove all listeners to prevent memory leaks
      this.localServer.removeAllListeners()
      this.localServer.close()
    }
  }
}
