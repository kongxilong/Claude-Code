/**
 * ============================================================================
 *  【文件总览】src/tools/RemoteTriggerTool/RemoteTriggerTool.ts
 *              —— 「远程定时任务的管理员」工具本体
 * ============================================================================
 *
 *  一句话定位：
 *  这个工具让 Claude 能够增删改查（CRUD）并手动触发「远端定时运行的 Agent」，
 *  也就是所谓的 trigger / scheduled remote agent——到点自动在云端跑一段 Claude Code。
 *  本质上它就是 claude.ai 后端 /v1/code/triggers 这套 REST 接口的一个**带鉴权的封装**。
 *
 *  为什么要有它，而不是让模型直接 `Bash(curl ...)`？
 *    1) 安全：OAuth access token 是在**本进程内**加到请求头里的，永远不会出现在
 *       命令行参数里，也就不会落进 shell history / 进程列表 / 日志里。
 *       这一点在 prompt.ts 的 PROMPT 文案中也反复强调。
 *    2) 可控：所有请求都统一带 anthropic-version、anthropic-beta、组织 UUID 等头，
 *       避免出现"某个 curl 忘了带 header 导致调到错误版本"的问题。
 *    3) 可中断：请求把 context.abortController.signal 交给 axios，
 *       用户按 Ctrl+C 时 HTTP 请求能被真正取消，而不是继续占着连接。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】调用链
 * ---------------------------------------------------------------------------
 *
 *      UI 层 REPL.tsx
 *        └─> query() 主循环                       ← src/query.ts
 *              └─> runTools()                     ← src/services/tools/toolOrchestration.ts
 *                    └─> tool.call(input, ctx)    ← ★ 本文件的 async call()
 *                          ├─> checkAndRefreshOAuthTokenIfNeeded()  ← src/utils/auth.ts（token 过期就先刷新）
 *                          ├─> getClaudeAIOAuthTokens()             ← 从本机凭据里取出 accessToken
 *                          ├─> getOrganizationUUID()                ← src/services/oauth/client.ts
 *                          └─> axios.request(...)                   ← 真正发 HTTP
 *
 *      本工具是怎么被"装进"系统的：
 *      src/tools.ts 里有
 *          const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE')
 *              ? require('./tools/RemoteTriggerTool/RemoteTriggerTool.js').RemoteTriggerTool
 *              : null
 *      即【编译期开关】控制它是否存在；为 false 时整个模块（含本文件）会被打包器
 *      tree-shaking 掉，不进入产物。所以你在闭源/开放版产物里可能压根找不到它。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】从上往下就这几样
 * ---------------------------------------------------------------------------
 *   1. inputSchema / Input    入参校验结构（zod）：action + 可选 trigger_id + 可选 body
 *   2. outputSchema / Output  出参结构：HTTP 状态码 + 响应体 JSON 字符串
 *   3. TRIGGERS_BETA          后端要求的 beta 版本号常量
 *   4. RemoteTriggerTool      ★ 唯一对外导出的工具对象，由 buildTool() 构造
 *   5. 对象内部的若干钩子方法：isEnabled / isReadOnly / call / mapToolResult... 等
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法，Java 工程师对照看）
 * ---------------------------------------------------------------------------
 *  - `type InputSchema = ReturnType<typeof inputSchema>`
 *      「把某个函数/变量的返回类型取出来当类型用」。
 *      ≈ Java 里做不到；类似反射拿到返回值类型再当泛型参数。
 *      这里因为 lazySchema 返回的是工厂函数，必须 ReturnType 剥一层。
 *
 *  - `export type Input = z.infer<InputSchema>`
 *      zod 的 `infer`：**从校验规则反推出 TS 类型**（解析器 → 类型）。
 *      ≈ Java 里没有；近似 JSR-380 Bean Validation 注解反推 DTO 字段。
 *      好处是「校验规则」和「类型」只有一份定义，不会写着写着就不同步。
 *
 *  - `get inputSchema(): InputSchema { return inputSchema() }`
 *      这是对象字面量里的 **getter**。外界写 `tool.inputSchema` 时看着像读属性，
 *      实际会调用这个函数。
 *      ≈ Java 的 `public X getInputSchema() { ... }`，但调用方不用写 get 前缀和括号。
 *      为什么要绕这一层？配合 lazySchema 做**延迟构造**：zod schema 的建立有成本，
 *      且模块初始化太早建立可能踩到循环依赖。见 src/utils/lazySchema.ts。
 *
 *  - `satisfies ToolDef<InputSchema, Output>`（文件最末尾）
 *      `satisfies` 是 TS 4.9 的新运算符：
 *        「请检查这个对象字面量是否符合 ToolDef 类型，但**不要把它的类型擦成** ToolDef」。
 *      对比 `as ToolDef`：as 是强制断言，写错字段可能不报错；satisfies 会真检查，
 *      同时又保留对象里每个方法各自的精确类型（这样 call() 的入参才能被推断出来）。
 *      ≈ Java 里没有；可以理解为"编译期校验但不改变静态类型"。
 *
 *  - `data: unknown`（第 103 行）
 *      `unknown` = 「我不知道它是什么类型」。比 `any` 安全：
 *      拿到 unknown 之后必须先用 `as` 或类型守卫收窄才能访问属性，
 *      而 any 会一路放行。≈ Java 的 `Object`，但因为 TS 是结构化类型，
 *      编译器会逼你先确认形态。
 *
 *  - `let method: 'GET' | 'POST'`
 *      字符串字面量联合类型。值只能是这两个字符串之一，写 'PUT' 编译报错。
 *      ≈ Java 的 enum，但不用单独声明一个枚举类，轻量得多。
 *
 *  - 反引号包起来的模板字符串 + 三元表达式（见 toAutoClassifierInput）：
 *      "RemoteTrigger ${...}" 里可以用 ${} 插值，还能直接换行，
 *      ≈ Java 的字符串拼接 + 三元运算符的合体。
 *
 *  - `?.` 可选链（第 80 行 `getClaudeAIOAuthTokens()?.accessToken`）
 *      ≈ Java：`Tokens t = getTokens(); t == null ? null : t.accessToken`
 *      整条链上任意一环是 null/undefined，整个表达式短路成 undefined，不抛 NPE。
 *
 *  - `??` 空值合并：只在左侧是 null/undefined 时才取右侧。
 *      ⚠️ 与 Java 的 `||` 不同：`0`、`''`、`false` 都会被 `||` 换掉，但 `??` 不会。
 *
 *  - `await / async`：≈ Java 的 CompletableFuture + await，但语法糖级别的支持。
 *      `async f()` 意味着函数返回 Promise；`await` 只能在 async 函数里用。
 *
 *  - `switch (action) { case 'list': ... }`
 *      和 Java 的 switch 一样，但 TS 里 case 是**穷尽检查**的：
 *      action 的类型是联合类型时，漏掉某个 case 编译器可以报错（需配合 never 兜底）。
 *      本文件每个 case 都有 break，不会 fall-through。
 *
 *  - `20_000` / `100_000`：数字分隔符，纯粹为了读数方便，等同于 20000。
 *      ≈ Java 的 int 字面量下划线语法（Java 7+ 就有）。
 *
 *  - 类型标注在变量名**后面**：`let url: string`（Java 是 `String url`，正好反过来）。
 *
 * ---------------------------------------------------------------------------
 *  【两个容易看懵的细节】
 * ---------------------------------------------------------------------------
 *  ① `validateStatus: () => true`（第 142 行）
 *     axios 默认遇到 4xx/5xx 会 throw。这里改成「任何状态码都算成功响应」，
 *     于是 HTTP 错误可以被当作**正常的工具结果**返回给模型，
 *     让模型自己看到 "HTTP 400 {"error":...}" 再决定怎么改。
 *     如果直接抛异常，模型就只能看到一个被掐断的错误栈，信息量反而更少。
 *
 *  ② `shouldDefer: true`（第 50 行）
 *     表示这个工具的执行要「延后/可被推迟」。配合 isConcurrencySafe() === true，
 *     允许同一轮里多个 RemoteTrigger 调用并行发出，互不阻塞。
 *
 * ============================================================================
 */
import axios from 'axios'
import { z } from 'zod/v4'
import { getOauthConfig } from '../../constants/oauth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getOrganizationUUID } from '../../services/oauth/client.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
} from '../../utils/auth.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DESCRIPTION, PROMPT, REMOTE_TRIGGER_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

// lazySchema(...) 返回一个「带缓存的工厂函数」：第一次调用时才真正构造 zod schema，
// 之后一直复用同一个实例。目的是把构造成本从【模块加载时】推迟到【首次使用时】。
// 详见 src/utils/lazySchema.ts（那个文件只有 8 行，核心就是 `cached ??= factory()`）。
const inputSchema = lazySchema(() =>
  // z.strictObject：对象的 key 必须完全匹配下面声明的这三个，多一个 key 就报错。
  // 对比 z.object（默认会静默丢弃多余字段）——这里用 strict 是为了防止模型手抖拼错字段名。
  z.strictObject({
    // z.enum([...])：值只能是这 5 个字符串之一，编译后 Input['action'] 就是这 5 个的联合类型。
    action: z.enum(['list', 'get', 'create', 'update', 'run']),
    trigger_id: z
      .string()
      // 只允许字母数字下划线连字符，防止各种奇形怪状的 id 混进 URL 造成注入。
      .regex(/^[\w-]+$/)
      // optional() → 类型变成 `string | undefined`。
      .optional()
      // describe() 只是给模型看的说明文字（会进 JSON schema 的 description 字段），不影响校验逻辑。
      .describe('Required for get, update, and run'),
    body: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSON body for create and update'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

// 出参结构：只回两样东西——HTTP 状态码 和 响应体的 JSON 字符串。
// 之所以用 **字符串** 而不是解析好的对象：
//   ① 后端返回什么形状我们不完全做主，用 string 可以原样透传、不会因为字段变化而报错；
//   ② 交给模型时天然是可读文本（见下面 mapToolResult... 里直接拼进 content）。
const outputSchema = lazySchema(() =>
  z.object({
    status: z.number(),
    json: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// 后端灰度功能的 beta 版本号，必须作为 anthropic-beta 请求头带上，
// 否则会被路由到不带 triggers 接口的旧版实现上。
const TRIGGERS_BETA = 'ccr-triggers-2026-01-30'

/**
 * RemoteTriggerTool —— 本文件唯一对外导出的东西，一个完整的「工具对象」。
 *
 * 它不是 class 的实例，而是一个**对象字面量**，
 * 由 src/Tool.ts 的 buildTool() 加工后返回：
 *
 *     buildTool(def) = { ...TOOL_DEFAULTS, ...def }
 *
 * 即「把一堆缺省实现铺在底下，再用本文件写的定义覆盖上去」。
 * 所以下面只写了我们关心的字段，其余（比如 renderToolUseErrorMessage 等）
 * 都由 TOOL_DEFAULTS 自动补齐，调用方不用到处写 `tool.isEnabled?.() ?? true`。
 * ≈ Java 里的「抽象基类 + 子类覆盖」，但用对象展开而不是继承实现。
 *
 * 下面逐个说明这些钩子方法分别在什么时机被调用（按生命周期顺序）：
 */
export const RemoteTriggerTool = buildTool({
  // name：工具名，模型写 <tool_use> 时用的就是这个字符串。来自 prompt.ts。
  name: REMOTE_TRIGGER_TOOL_NAME,
  // searchHint：给 ToolSearch 用的简短描述，帮助模型在几十个工具里检索到自己。
  searchHint: 'manage scheduled remote agent triggers',
  // maxResultSizeChars：结果超过这个字符数会被截断，防止一个巨长的 JSON 撑爆上下文窗口。
  maxResultSizeChars: 100_000,
  // shouldDefer：标记为「可延后执行」，调度器可以把这类调用往后排。
  shouldDefer: true,
  /**
   * inputSchema 的 getter：外界读 `tool.inputSchema` 时才真正构造 zod 对象。
   * 如果没有这层 getter 而直接写 `inputSchema: inputSchema()`，
   * 就会在模块加载瞬间构造，失去 lazySchema 的意义。
   */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 这个工具当前是否可用。返回 false 时它压根不会出现在给模型的工具列表里。
   *
   * 两个条件是「与」关系，缺一不可：
 *   ① GrowthBook 灰度开关 tengu_surreal_dali —— 服务端远程控制，不用发版就能随时开关。
 *      注意函数名后缀 "_CACHED_MAY_BE_STALE"：读的是本地缓存值，
 *      可能是几分钟前的旧快照，换来的是不用每次判定都发一次网络请求
 *      （isEnabled 会被非常频繁地调用，决不能在这里做 IO）。
   *   ② 组织策略 allow_remote_sessions —— 企业管理员可以在后台统一禁掉远端会话。
   */
  isEnabled() {
    return (
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_surreal_dali', false) &&
      isPolicyAllowed('allow_remote_sessions')
    )
  },
  /**
   * 是否可以和其它工具**并发**执行。返回 true ⇒ 调度器允许同时发多个请求。
   *
   * 为什么这里敢返回 true？因为每个 action 都是独立的 HTTP 调用，
   * 不存在「先写后读」这种顺序依赖，彼此不会互相污染。
   * 注意：buildTool 的默认值是 false（fail-closed），所以必须显式打开。
   */
  isConcurrencySafe() {
    return true
  },
  /**
   * 这个调用是否会修改外部世界。只读 ⇒ 可以跳过权限弹窗直接放行。
   * list / get 只是查询（对应 HTTP GET），所以只读；其余可能改动数据。
   */
  isReadOnly(input: Input) {
    return input.action === 'list' || input.action === 'get'
  },
  /**
   * 生成喂给「权限分类器」（另一个小模型）的文本摘要。
   * 分类器只看这一行字来决定要不要弹权限框，所以要短、要有区分度。
   */
  toAutoClassifierInput(input: Input) {
    return `RemoteTrigger ${input.action}${input.trigger_id ? ` ${input.trigger_id}` : ''}`
  },
  /**
   * 工具的简短说明，展示给用户看（比如 /tools 列表、审批弹窗的标题）。
   * 写成 async 是为了统一接口：有些工具的 description 需要读磁盘/查配置。
   */
  async description() {
    return DESCRIPTION
  },
  /**
   * 给模型看的完整说明书，会拼进 system prompt 的工具段落。
   * 相当于这个工具的「使用手册」，模型照着它决定怎么填参数。
   */
  async prompt() {
    return PROMPT
  },
  /**
   * ★ 工具的主体：真正干活的地方。
   *
   * 入参：
   *   input   —— 已经过 zod 校验的模型入参（action/trigger_id/body）
   *   context —— 工具执行上下文，这里唯一用到的是 abortController.signal，
   *              用于在用户 Ctrl+C 时取消 HTTP 请求
   * 返回：{ data: Output } —— data 会被后续环节当作工具结果继续流转
   *
   * 关键步骤：
   *   ① 取凭证：先尝试刷新 OAuth token（过期就静默续期），再取出 accessToken 和组织 UUID；
   *      两者任意一个拿不到就直接 throw —— 早失败，好过发一个注定 401 的请求。
   *   ② 组装公共请求头：Authorization / Content-Type / anthropic-version /
   *      anthropic-beta(灰度版本) / x-organization-uuid。
   *   ③ 按 action 翻译成 HTTP 三元组 (method, url, data)：
   *      list   → GET  /v1/code/triggers
   *      get    → GET  /v1/code/triggers/{id}
   *      create → POST /v1/code/triggers         + body
   *      update → POST /v1/code/triggers/{id}    + body
   *      run    → POST /v1/code/triggers/{id}/run
   *      缺参数一律 throw —— 与其让后端返回难懂的 400，不如本地给出明确错误，模型更容易自我纠正。
   *   ④ 发请求，把状态码和响应体原样打包返回（故意不抛异常，见 axios 那行的注释）。
   */
  async call(input: Input, context: ToolUseContext) {
    // ① token 可能刚好过期，这一步内部只在必要时才真正发起刷新请求。
    await checkAndRefreshOAuthTokenIfNeeded()
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      throw new Error(
        'Not authenticated with a claude.ai account. Run /login and try again.',
      )
    }
    const orgUUID = await getOrganizationUUID()
    if (!orgUUID) {
      throw new Error('Unable to resolve organization UUID.')
    }

    // ② 组装公共请求头。anthropic-version / anthropic-beta 是 API 版本协商的两个头，
    //    少了它们后端就不知道该用哪套行为；把这两个写成常量而不是散落各处，
    //    是为了保证所有请求走同一版本。
    const base = `${getOauthConfig().BASE_API_URL}/v1/code/triggers`
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': TRIGGERS_BETA,
      'x-organization-uuid': orgUUID,
    }

    // ③ 解构赋值：把 input 里的三个字段拆成同名的局部变量，后面写起来更短。
    //    ≈ Java 21 的记录模式匹配，但 TS 里是家常便饭。
    const { action, trigger_id, body } = input
    // 先声明变量、后赋值，是因为下面 switch 的每个 case 都要填这三个值。
    // TS 会做「确定性赋值分析」：只有所有分支都赋过值，后面才能放心使用，
    // 否则编译器会报 "used before being assigned"。
    let method: 'GET' | 'POST'
    let url: string
    let data: unknown
    switch (action) {
      case 'list':
        // list 不需要 id，也不需要 body
        method = 'GET'
        url = base
        break
      case 'get':
        if (!trigger_id) throw new Error('get requires trigger_id')
        method = 'GET'
        url = `${base}/${trigger_id}`
        break
      case 'create':
        if (!body) throw new Error('create requires body')
        method = 'POST'
        url = base
        data = body
        break
      case 'update':
        if (!trigger_id) throw new Error('update requires trigger_id')
        if (!body) throw new Error('update requires body')
        method = 'POST'
        url = `${base}/${trigger_id}`
        data = body
        break
      case 'run':
        // 手动触发（不等定时器到点就跑一次）。
        // data = {} 而不是 undefined：axios 在没有 data 时不会设 Content-Type，
        // 而这个 endpoint 要求是一个 JSON POST，所以显式给个空对象体。
        if (!trigger_id) throw new Error('run requires trigger_id')
        method = 'POST'
        url = `${base}/${trigger_id}/run`
        data = {}
        break
    }

    // ④ 真正发请求。
    //    signal：把中断信号交给 axios，Ctrl+C 时底层 socket 会被真正关掉。
    //            ≈ Java HttpClient 的取消机制，但这里是「传入一个信号对象」的写法。
    //    validateStatus: () => true：见文件头说明 ① —— 让 HTTP 错误变成正常的工具结果。
    //    timeout: 20_000：20 秒超时。这是「组合超时」：本工具整体不该卡住用户超过 20 秒。
    const res = await axios.request({
      method,
      url,
      headers,
      data,
      timeout: 20_000,
      signal: context.abortController.signal,
      validateStatus: () => true,
    })

    // jsonStringify：走的是 src/utils/slowOperations.ts 专门的版本，
    // 对超长/循环引用/大整数更健壮，并且不受 JSON.stringify 一些陷阱的影响。
    return {
      data: {
        status: res.status,
        json: jsonStringify(res.data),
      },
    }
  },
  /**
   * 把工具的输出翻译成「喂回给模型的 tool_result 消息块」。
   *
   * 为什么要有这一步：工具的返回值是内部表示，而 Anthropic API 要求
   * 严格的 tool_result 结构 { tool_use_id, type: 'tool_result', content }。
   * tool_use_id 必须和模型发起调用时给的 id 对上，否则 API 会报「孤儿 result」错。
   *
   * 这里把状态码和 JSON 拼成一行文本，模型读到的是：
   *     HTTP 200
   *     {"triggers":[...]}
   *
   * ≈ Java 里的 DTO → API 请求体的转换层。
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `HTTP ${output.status}\n${output.json}`,
    }
  },
  // 下面两个渲染函数放在 UI.tsx 里（本文件保持纯逻辑，不掺 UI）：
  //   renderToolUseMessage     —— 用户看到的那一行「RemoteTrigger get abc123」
  //   renderToolResultMessage  —— 结果摘要「HTTP 200 (12 lines)」
  renderToolUseMessage,
  renderToolResultMessage,
  // satisfies 的用法见文件头【TS 语法速查】。
  // <InputSchema, Output> 这两个泛型参数，让 call() 的入参和返回值能被精确推断出来。
} satisfies ToolDef<InputSchema, Output>)
