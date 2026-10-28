/**
 * 【一句话定位】查询 ultrareview（深度代码评审）功能的剩余配额（quota）。
 *
 * 【在架构中的位置】
 *   调用链：UI 组件 / 命令层想要显示「还剩几次评审」
 *           → 本文件 fetchUltrareviewQuota()
 *             → utils/teleport/api.ts 的 prepareApiRequest()（拿 accessToken + orgUUID）
 *             → axios.get → `${BASE_API_URL}/v1/ultrareview/quota`
 *   下游还有一个服务端的落地点：真正的「扣减配额」不在前端做，
 *   而是在**创建 session 时由服务端扣**。前端这一层只是 peek（只读查看）。
 *
 * 【本文件包含什么】
 *   - UltrareviewQuotaResponse：配额响应类型（已用/上限/剩余/是否超额）。
 *   - fetchUltrareviewQuota()：唯一导出函数，查配额；失败返回 null。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `export type Foo = { a: number, b: string }`：定义「结构化类型」。
 *      ≈ Java record，但不需要 implements——任何长得一样的对象都算这个类型（鸭子类型）。
 *   2. `Promise<UltrareviewQuotaResponse | null>`：
 *      - `Promise<T>` ≈ Java 的 CompletableFuture<T>，配合 `await` 使用（≈ future.join()）。
 *      - `A | null` 是「联合类型」≈ Java 的 @Nullable A；TS 在严格模式下必须显式处理 null，
 *        否则编译报错（比 Java 的 Optional 更轻量，编译期检查、运行时就是普通值）。
 *   3. `async function`：`async` 关键字让函数返回 Promise；其内部可用 `await`。
 *      Java 没有对应语法，只能手写 CompletableFuture 链或用虚拟线程。
 *   4. `if (!isClaudeAISubscriber()) return null` 这种「前置条件不满足就直接返回」
 *      叫 guard clause（卫语句），跟 Java 里 `if (...) return;` 完全一样。
 *   5. `catch (error)` 捕获的 error 类型是 `unknown`（TS 特有），
 *      ≈ Java 的 catch (Throwable t)，但 TS 要求你先确认类型才能访问其属性。
 */
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

/**
 * 配额响应结构。字段名用 snake_case（下划线）而不是 camelCase，
 * 因为这是服务端 JSON 直接反序列化过来的——JS 侧沿用后端的命名，
 * 避免写一层字段映射。Java 里通常会加 @JsonProperty 做转换，这里省了。
 *
 * reviews_used / reviews_limit / reviews_remaining：已用 / 上限 / 剩余次数。
 * is_overage：当前是否处于「超额付费」状态（超了配额但允许继续用，按量计费）。
 */
export type UltrareviewQuotaResponse = {
  reviews_used: number
  reviews_limit: number
  reviews_remaining: number
  is_overage: boolean
}

/**
 * Peek the ultrareview quota for display and nudge decisions. Consume
 * happens server-side at session creation. Null when not a subscriber or
 * the endpoint errors.
 */
// 注意返回值是 `... | null`：非订阅者、或网络报错，都统一返回 null。
// 这是刻意的「窄化错误」设计——调用方只关心「有没有配额」，
// 不需要知道是网络挂了还是没订阅。Java 类比：catch 掉异常返回 Optional.empty()。
export async function fetchUltrareviewQuota(): Promise<UltrareviewQuotaResponse | null> {
  if (!isClaudeAISubscriber()) return null
  try {
// await 一个异步操作拿到登录态。prepareApiRequest() 内部可能触发 OAuth token 刷新，
// 所以必须 await（Java：相当于 future.get() 阻塞直到拿到结果）。
    const { accessToken, orgUUID } = await prepareApiRequest()
    const response = await axios.get<UltrareviewQuotaResponse>(
      `${getOauthConfig().BASE_API_URL}/v1/ultrareview/quota`,
      {
        headers: {
// `...getOAuthHeaders(accessToken)` 是对象展开运算符≈Java 的 putAll。
// 这里展开在前、'x-organization-uuid' 写在后，意味着后者同名时会覆盖前者。
// 展开顺序即优先级顺序，这是常见的「默认头 + 覆盖」写法。
          ...getOAuthHeaders(accessToken),
          'x-organization-uuid': orgUUID,
        },
// 5 秒超时：这只是在 UI 上「显示还剩几次」的辅助请求，
// 绝不能因为它慢而卡住主流程，所以宁可快速失败。
        timeout: 5000,
      },
    )
    return response.data
// 吞掉异常只记日志：配额展示是「锦上添花」，失败不应该让整条命令崩掉。
// 这是本项目的一贯套路——非关键路径的错误记录后降级。
  } catch (error) {
    logForDebugging(`fetchUltrareviewQuota failed: ${error}`)
    return null
  }
}
