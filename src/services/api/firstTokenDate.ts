/**
 * 【一句话定位】拉取并缓存「用户第一次使用 Claude Code 的日期」（first token date）。
 *
 * 【在架构中的位置】
 *   调用链：登录成功后的流程（src/utils/auth.ts 相关登录回调）
 *           → 本文件 fetchAndStoreClaudeCodeFirstTokenDate()
 *           → utils/http.ts 的 getAuthHeaders()（拼 Authorization 头）
 *           → axios.get → `${BASE_API_URL}/api/organization/claude_code_first_token_date`
 *           → utils/config.ts 的 getGlobalConfig() / saveGlobalConfig()（落盘 ~/.claude.json）
 *
 * 【设计意图】这个日期常被用来判断「是不是老用户」，从而决定要不要弹
 *   新手引导、某些灰度开关等。它几乎不变，所以**只拉一次**就永久写进配置文件，
 *   之后每次启动直接读本地配置，不再发请求（第 16 行的早退就是这个作用）。
 *
 * 【本文件包含什么】
 *   - fetchAndStoreClaudeCodeFirstTokenDate()：唯一导出函数，拉+校验+落盘，全程 try/catch。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `config.claudeCodeFirstTokenDate !== undefined`：
 *      TS 里 `undefined`（未定义）和 `null`（空值）是**两个不同的值**，Java 只有 null。
 *      这里是「已经有值了就不再请求」的判断（缓存命中）。
 *   2. `response.data?.first_token_date ?? null`：
 *      - `?.` 可选链：data 为 null/undefined 时整个表达式直接返回 undefined，不抛 NPE。
 *        Java 等价：`data == null ? null : data.first_token_date`。
 *      - `??` 空值合并：左边是 null/undefined 才取右边。注意跟 `||` 的区别：
 *        `||` 会把 0、''、false 这些「假值」也替换掉，`??` 不会。这里用 `??` 更安全。
 *   3. `authHeaders.error` 返回「错误对象或 undefined」而不是抛异常——
 *      这是 TS/JS 里常见的 Result 风格（避免 try/catch 控制流），
 *      ≈ Java 的 Either/Result 返回类型，比异常更轻。
 *   4. `saveGlobalConfig(current => ({ ...current, field: v }))`：
 *      - `current => ({...})` 是箭头函数≈Java lambda `current -> {...}`。
 *      - `{...current, x: v}` 展开=不可变更新：先复制旧对象所有字段，再覆盖 x。
 *        Java 类比：new DTO(oldDTO) 然后 setter，或者直接上 record 的 wither。
 *   5. `catch (error) { logError(error) }`：TS 的 catch 参数默认是 unknown 类型，
 *      直接当 Error 用可能报错；logError 内部做了兼容处理。
 */
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

/**
 * Fetch the user's first Claude Code token date and store in config.
 * This is called after successful login to cache when they started using Claude Code.
 */
// 幂等 + 只读一次：如果本地配置里已经有这个日期（哪怕是 null），就永久跳过网络请求。
// 注意判断用的是 `!== undefined` 而不是 falsy 判断——null 也算「已拉过」，
// 表示「服务端确认过：这个用户没有 first_token_date」，不该再反复问。
export async function fetchAndStoreClaudeCodeFirstTokenDate(): Promise<void> {
  try {
    const config = getGlobalConfig()

    if (config.claudeCodeFirstTokenDate !== undefined) {
      return
    }

// getAuthHeaders() 走的是 Result 风格：不抛异常，而是返回 { headers } 或 { error }。
    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      logError(new Error(`Failed to get auth headers: ${authHeaders.error}`))
      return
    }

    const oauthConfig = getOauthConfig()
    const url = `${oauthConfig.BASE_API_URL}/api/organization/claude_code_first_token_date`

    const response = await axios.get(url, {
      headers: {
        ...authHeaders.headers,
        'User-Agent': getClaudeCodeUserAgent(),
      },
      timeout: 10000,
    })

// `?.` + `??` 组合防御：接口可能返回 200 但 body 结构不对，这里一律兜为 null。
    const firstTokenDate = response.data?.first_token_date ?? null

    // Validate the date if it's not null
// 日期是字符串传来传去的，必须校验能否解析。JS 的 new Date('xxx') 解析失败
// 不会抛异常，而是返回一个 Invalid Date（getTime() 得到 NaN），
// 所以要显式 isNaN 检查。这是 JS 的经典坑：日期解析失败不报错。
    if (firstTokenDate !== null) {
      const dateTime = new Date(firstTokenDate).getTime()
      if (isNaN(dateTime)) {
        logError(
          new Error(
            `Received invalid first_token_date from API: ${firstTokenDate}`,
          ),
        )
// 宁可不存，也不要把非法日期写进配置文件——一旦写脏，
// 下次因为「已经有值」的判断会永久跳过修复，脏数据会一直生效。
        // Don't save invalid dates
        return
      }
    }

    saveGlobalConfig(current => ({
      ...current,
      claudeCodeFirstTokenDate: firstTokenDate,
    }))
// 整个函数对异常一律吞掉：这是启动阶段的旁路拉取，失败不影响主流程。
  } catch (error) {
    logError(error)
  }
}
