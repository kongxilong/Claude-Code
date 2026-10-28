/**
 * 【一句话定位】启动时拉取一次「bootstrap 配置」（服务端下发的客户端数据 + 可选模型列表），
 *           并写进本地配置缓存。
 *
 * 【在架构中的位置】
 *   调用链：CLI 启动流程（src/entrypoints/*.ts 或 login 完成后）
 *           → 本文件 fetchBootstrapData()
 *             → fetchBootstrapAPI()
 *               → utils/privacyLevel.ts（isEssentialTrafficOnly 总开关）
 *               → utils/model/providers.ts（getAPIProvider 判断是否三方渠道）
 *               → utils/auth.ts（getAnthropicApiKey / getClaudeAIOAuthTokens / hasProfileScope）
 *               → utils/http.ts（withOAuth401Retry：401 时自动刷新 token 重试）
 *               → utils/lazySchema.ts + zod（响应体校验）
 *               → axios.get → `${BASE_API_URL}/api/claude_cli/bootstrap`
 *             → utils/config.ts（getGlobalConfig / saveGlobalConfig 落盘缓存）
 *
 * 【设计意图】让服务端有机会在不发版的情况下给客户端下发配置
 *   （client_data 是任意结构的 key-value，additional_model_options 是可切换的模型列表）。
 *   因为配置可能随时变，所以每次启动都打这个接口——为了不把服务端打爆，做了两层削减：
 *   ①隐私开关 / 非第一方渠道 / 无凭证 → 直接不打；
 *   ②响应跟磁盘缓存完全一致 → 不触发磁盘写。
 *
 * 【本文件包含什么】
 *   - bootstrapResponseSchema：zod schema（懒加载），描述并校验响应结构，同时做字段改名。
 *   - BootstrapResponse：由 zod schema 反推出来的 TS 类型。
 *   - fetchBootstrapAPI()：真正发请求的内部函数，含 401 重试与降级分支。
 *   - fetchBootstrapData()：唯一导出函数，拉 + 比对 + 落盘，异常一律吞掉。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `lazySchema(() => z.object({...}))`：zod 是**运行时**的 schema 校验库。
 *      这补上了纯 TS 泛型缺失的那一环——泛型只在编译期有效，运行时不校验任何东西，
 *      而 zod 能在运行时断言 JSON 结构正确。Java 类比：Jackson 反序列化 + 
 *      Bean Validation（@NotNull/@Size），或 JSON Schema 校验。
 *      lazySchema 包一层是为了延迟构造：schema 对象放在模块顶层会拖慢启动。
 *   2. `z.infer<ReturnType<typeof bootstrapResponseSchema>>`：
 *      从运行时 schema **反推**出静态类型，避免「schema 写一遍、interface 再写一遍」。
 *      - `typeof X`：取 X 的类型（这里 X 是函数，得到函数类型）。
 *      - `ReturnType<F>`：取函数返回值类型（工具类型，编译期计算）。
 *      - `z.infer<S>`：zod 提供的类型反推工具。
 *      Java 里没有对应能力，只能手写 DTO 并保证跟校验规则同步。
 *   3. `.transform(({model, name, description}) => ({value, label, description}))`：
 *      校验通过的同时改写字段名（服务端叫 model/name，UI 组件要 value/label）。
 *      ≈ Java 的 DTO → VO 转换，或 Stream.map。
 *   4. `.nullish()`：允许 null 或 undefined（等价于 `.nullable().optional()`）。
 *   5. `await withOAuth401Retry(async () => {...})`：把一个 async 箭头函数当参数传进去。
 *      ≈ Java 传一个 Supplier<CompletableFuture<T>>。这种「高阶函数 + 回调」风格
 *      在 JS 里非常普遍（Java 因为语法笨重很少这么写）。
 *   6. `axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'`：
 *      - `axios.isAxiosError(e)` 是「类型谓词」（返回类型写成 `e is AxiosError`）≈ 
 *        Java 的 `e instanceof AxiosError` + 自动向下转型，if 分支里 e 的类型自动收窄。
 *      - 三元运算符 `cond ? a : b` 在这里是表达式（有返回值），可以被模板字符串插值。
 *   7. `catch (error) { logForDebugging(...); throw error }`：记录后再原样抛，
 *      ≈ Java 的 catch (Exception e) { log.error(...); throw e; }。
 *   8. `saveGlobalConfig(current => ({...current, x: y}))`：
 *      箭头函数 + 对象展开 = 不可变更新（复制旧值再覆盖，不改原对象）。
 */
import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  hasProfileScope,
} from 'src/utils/auth.js'
import { z } from 'zod'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

// zod schema 描述「期望的服务端响应长什么样」。注意它同时承担两个职责：
// ①运行时校验；②作为 TS 类型的唯一来源（下面用 z.infer 反推）。
// lazySchema 包一层是为了延迟构造——模块顶层立即构造 schema 会拖慢 CLI 冷启动。
const bootstrapResponseSchema = lazySchema(() =>
  z.object({
// client_data：服务端下发的任意配置。z.record(z.unknown()) ≈ Map<String, Object>，
// 结构不固定，所以这里放任它是 unknown ——但仍是「已经过 zod 检查的 unknown」。
    client_data: z.record(z.unknown()).nullish(),
// additional_model_options：可选模型列表。三个字段都是 string，
// 服务端不保证一定给（所以整体 nullish）。
    additional_model_options: z
      .array(
        z
          .object({
            model: z.string(),
            name: z.string(),
            description: z.string(),
          })
// ★ 解构 + 改写字段名：这里的入参是直接对对象做解构
// `({ model, name, description }) => ({...})` ≈ Java lambda 参数里直接拆 record。
// 之所以要改名，是因为下游 UI 组件（select 之类）的 props 约定叫 value/label。
          .transform(({ model, name, description }) => ({
            value: model,
            label: name,
            description,
          })),
      )
      .nullish(),
  }),
)

// z.infer 从 schema 反推类型：schema 改了类型自动跟着改，不会出现两边不同步。
type BootstrapResponse = z.infer<ReturnType<typeof bootstrapResponseSchema>>

// 私有函数（没 export）：只被下面 fetchBootstrapData() 调用。
async function fetchBootstrapAPI(): Promise<BootstrapResponse | null> {
// 总开关：隐私模式（比如只允许必要流量）下，这种「锦上添花」的请求一律不打。
// 也是故障时的全局 kill switch ——服务端出事时可以靠它把客户端侧流量直接掐掉。
  if (isEssentialTrafficOnly()) {
    logForDebugging('[Bootstrap] Skipped: Nonessential traffic disabled')
    return null
  }

// 只给第一方 Anthropic API 发。走 bedrock / vertex 等第三方渠道时，
// 用户账号体系完全不一样，打过去没意义。
  if (getAPIProvider() !== 'firstParty') {
    logForDebugging('[Bootstrap] Skipped: 3P provider')
    return null
  }

  // OAuth preferred (requires user:profile scope — service-key OAuth tokens
  // lack it and would 403). Fall back to API key auth for console users.
// 凭证判定：OAuth 优先，但需要 user:profile scope——
// service key 类型的 OAuth token 没有这个 scope，打过去只会 403。
// 所以对这类 token 退回到用 API key 认证（控制台用户路径）。
// `?.` 可选链：没有 OAuth token 时整个表达式直接是 undefined，不抛异常。
  const apiKey = getAnthropicApiKey()
  const hasUsableOAuth =
    getClaudeAIOAuthTokens()?.accessToken && hasProfileScope()
  if (!hasUsableOAuth && !apiKey) {
    logForDebugging('[Bootstrap] Skipped: no usable OAuth or API key')
    return null
  }

// 注意 URL 里的 claude_cli ——这是给 CLI 客户端专用的 bootstrap 端点，
// 与 Web 端 / API 端的下发内容可能不同。
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli/bootstrap`

  // withOAuth401Retry handles the refresh-and-retry. API key users fail
  // through on 401 (no refresh mechanism — no OAuth token to pass).
  try {
// ★ 传入的是一个 async 箭头函数（≈ Supplier<CompletableFuture<T>>）。
// withOAuth401Retry 会在遇到 401 时先刷新 OAuth token，然后**重新调用**这个函数。
    return await withOAuth401Retry(async () => {
      // Re-read OAuth each call so the retry picks up the refreshed token.
// 关键细节：token 必须在回调**内部**重新读取，不能在外面先读好再闭包捕获。
// 否则重试时用的还是那份已经过期的旧 token ——这是这类重试封装最常见的坑。
      const token = getClaudeAIOAuthTokens()?.accessToken
      let authHeaders: Record<string, string>
      if (token && hasProfileScope()) {
        authHeaders = {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
// 降级路径：OAuth 不可用时改用 x-api-key（Anthropic Console 的 API key 用户）。
// API key 没有刷新机制，所以这条路上万一还是 401，就只能失败。
      } else if (apiKey) {
        authHeaders = { 'x-api-key': apiKey }
      } else {
        logForDebugging('[Bootstrap] No auth available on retry, aborting')
        return null
      }

      logForDebugging('[Bootstrap] Fetching')
      const response = await axios.get<unknown>(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getClaudeCodeUserAgent(),
          ...authHeaders,
        },
// 5 秒超时：bootstrap 属于锦上添花的旁路请求，宁可失败也不能拖慢命令行启动。
        timeout: 5000,
      })
// ★ safeParse 而不是 parse：前者返回 Result（{success, data} / {success:false, error}），
// 不抛异常。服务端返回结构变了（比如加字段/改类型）时，这里会走到失败分支降级，
// 而不是让 CLI 崩掉。对新版本兼容性非常重要。
      const parsed = bootstrapResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        logForDebugging(
          `[Bootstrap] Response failed validation: ${parsed.error.message}`,
        )
        return null
      }
      logForDebugging('[Bootstrap] Fetch ok')
      return parsed.data
    })
// 记录后再原样抛出：这一层不吞异常，交给上层 fetchBootstrapData 统一处理。
  } catch (error) {
    logForDebugging(
// `e is AxiosError` 类型谓词 + `?.` + `??` 三级防御：
// 既可能是 HTTP 错误（有 response.status），也可能是网络层错误（只有 code）。
      `[Bootstrap] Fetch failed: ${axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'}`,
    )
    throw error
  }
}

/**
 * Fetch bootstrap data from the API and persist to disk cache.
 */
// 【对外唯一入口】拉取并落盘。整个函数不会抛异常（最外层 try/catch 全包）。
// 这是启动阶段旁路拉取的一贯做法：失败最多损失一个特性，不能让 CLI 起不来。
export async function fetchBootstrapData(): Promise<void> {
  try {
    const response = await fetchBootstrapAPI()
    if (!response) return

// `?? null` / `?? []`：把 undefined 归一化成明确的 null / 空数组，
// 让后面比较和写盘时不用到处判空。
    const clientData = response.client_data ?? null
    const additionalModelOptions = response.additional_model_options ?? []

    // Only persist if data actually changed — avoids a config write on every startup.
    const config = getGlobalConfig()
// ★ 只有在数据真的变了才写磁盘。原因：
//   ①saveGlobalConfig 涉及文件锁 + 落盘，CLI 每次启动都写会明显变慢；
//   ②多台机器/多个进程争同一个配置文件，写放大还会增加冲突概率。
// lodash 的 isEqual 做深比较（Java：Objects.equals 只比一层，要 deepEquals）。
    if (
      isEqual(config.clientDataCache, clientData) &&
      isEqual(config.additionalModelOptionsCache, additionalModelOptions)
    ) {
      logForDebugging('[Bootstrap] Cache unchanged, skipping write')
      return
    }

    logForDebugging('[Bootstrap] Cache updated, persisting to disk')
    saveGlobalConfig(current => ({
      ...current,
      clientDataCache: clientData,
      additionalModelOptionsCache: additionalModelOptions,
    }))
// 兜底：任何异常都只记录不抛出。
  } catch (error) {
    logError(error)
  }
}
