/**
 * 【一句话定位】Team/Enterprise 场景下的「向管理员申请」通道：申请提额（limit_increase）
 *           或升级席位（seat_upgrade）。
 *
 * 【在架构中的位置】
 *   调用链：UI 层（额度用尽提示、席位不足提示，通常是一个 React 组件）
 *           → 本文件 createAdminRequest() / getMyAdminRequests() / checkAdminRequestEligibility()
 *           → utils/teleport/api.ts 的 prepareApiRequest()（拿 accessToken + orgUUID）
 *           → constants/oauth.ts 的 getOauthConfig()（拿 BASE_API_URL）
 *           → axios → `${BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests*`
 *   语义：普通成员没有计费/管理员权限，不能直接改额度，只能「发一个申请」，
 *   由真正的 org admin 在后台审批。本文件就是这个「申请单据」的增删查
 *   （没有 delete/update，只有 create/list/eligibility）。
 *
 * 【本文件包含什么】
 *   - AdminRequestType：申请类型枚举（limit_increase | seat_upgrade）。
 *   - AdminRequestStatus：申请状态枚举（pending | approved | dismissed）。
 *   - AdminRequestSeatUpgradeDetails：席位升级申请携带的附加信息。
 *   - AdminRequestCreateParams：创建参数（按类型区分的联合类型）。
 *   - AdminRequest：服务端返回的申请单对象。
 *   - createAdminRequest()：创建申请；同类型已有 pending 单则返回旧的。
 *   - getMyAdminRequests()：查自己名下的申请。
 *   - checkAdminRequestEligibility()：该组织是否允许发这类申请。
 *
 * 【TS 语法速查（本文件实际出现的）】——本文件是 TS 类型系统的浓缩样本
 *   1. `export type AdminRequestType = 'limit_increase' | 'seat_upgrade'`：
 *      「字面量类型联合」。Java 类比 enum，但它其实只是字符串的集合约束——
 *      编译后就是普通 string，运行时没有枚举对象。好处：跟 JSON 里来的字符串天然兼容；
 *      坏处：写错字符串编译器立刻报错（这正是我们要的）。
 *      TS 里 `string` 不能赋值给它，`'seat_upgrade'` 才可以——这就是类型收窄。
 *   2. `message?: string | null`：`?` 可选 + `| null`，三种状态合一（不存在/存在但空/有值）。
 *   3. AdminRequestCreateParams 这种写法叫**可辨识联合（Discriminated Union）**：
 *      两个分支都有一个同名字面量字段 request_type 作为「标签」，
 *      用 switch/if 判断 request_type 之后，TS 会自动把类型收窄到对应分支，
 *      从而知道 details 到底是 null 还是 AdminRequestSeatUpgradeDetails。
 *      ≈ Java 17 的 sealed interface + pattern matching（switch 里 instanceof 后自动转型）。
 *   4. `type X = { a: string } & ( A | B )`：`&` 是「交叉类型」（交集，取并集字段），
 *      `|` 是「联合类型」（并集，二选一）。两者混用可以组合出很精确的形状。
 *      Java 没有对应的类型运算，最接近的是 interface 多继承 + sealed 组合。
 *   5. `Promise<AdminRequest>`：异步返回值，≈ CompletableFuture<AdminRequest>。
 *   6. 三个函数体几乎一样：`prepareApiRequest()` → 拼 headers → 拼 url → axios。
 *      这是本项目 REST 调用的**标准三段式**模板，看一遍就能类推其他文件。
 */
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

// ===== 类型区（编译期就消失，运行时留不下任何东西）=====

// 申请类型。用字符串联合而非 enum enum：服务端 JSON 里就是这两个字符串，
// 直接复用可以省掉一层 enum ↔ string 的转换代码。
// Java 读法：把它当成 `enum AdminRequestType { LIMIT_INCREASE, SEAT_UPGRADE }`。
export type AdminRequestType = 'limit_increase' | 'seat_upgrade'

// 申请状态：pending 等审批、approved 已批准、dismissed 已被管理员忽略/驳回。
export type AdminRequestStatus = 'pending' | 'approved' | 'dismissed'

// 席位升级申请附带的上下文：用户自己写的一句话说明 + 当前席位档位，
// 供管理员决策时参考。
export type AdminRequestSeatUpgradeDetails = {
  message?: string | null
  current_seat_tier?: string | null
}

// ★ 这里是最值得 Java 工程师注意的一段：可辨识联合（Discriminated Union）。
// 两个分支靠 request_type 这个字面量字段区分：
//   - request_type === 'limit_increase' 时，details 必须是 null；
//   - request_type === 'seat_upgrade'    时，details 必须是详情对象。
// 于是「提额申请带详情」这种非法组合在**编译期**就写不出来。
// Java 对应写法：sealed interface + record 实现 + switch 模式匹配。
export type AdminRequestCreateParams =
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }

// 服务端返回的完整申请单。写法是 `{ 公共字段 } & ( 按类型区分的分支 )`：
// `&` 交叉类型 = 把两部分的字段合并成一个对象（Java：组合两个 interface）。
// uuid / status / created_at 是所有申请都有的；后半部分是各类型专属的。
export type AdminRequest = {
  uuid: string
  status: AdminRequestStatus
  requester_uuid?: string | null
  created_at: string
} & (
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }
)

/**
 * Create an admin request (limit increase or seat upgrade).
 *
 * For Team/Enterprise users who don't have billing/admin permissions,
 * this creates a request that their admin can act on.
 *
 * If a pending request of the same type already exists for this user,
 * returns the existing request instead of creating a new one.
 */
// 三个 API 的标准起手式：先 await prepareApiRequest() 拿到调用所需的登录态。
// 它返回的是一个解构出来的对象——下面这行的写法叫「解构赋值」。
export async function createAdminRequest(
  params: AdminRequestCreateParams,
): Promise<AdminRequest> {
// ★ 解构赋值：`const { accessToken, orgUUID } = await prepareApiRequest()`
// Java 完全没有对应语法。等价于：
//   var r = await prepareApiRequest(); var accessToken = r.accessToken; var orgUUID = r.orgUUID;
// TS 里 model.dto.Getter 这种样板代码一行搞定，全项目到处都是。
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
// 展开 getOAuthHeaders(accessToken) 得到 Authorization 等标准头，
// 再补一个组织 ID 头。顺序决定了同名 key 谁覆盖谁。
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

// 模板字符串拼 URL。orgUUID 嵌在路径里，是 REST 的多租户路由方式。
  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests`

// `axios.post<AdminRequest>` 的泛型参数标注了响应体类型，
// 于是 `response.data` 直接就是 AdminRequest，IDE 有属性补全、编译期有检查。
// Java 类比：restTemplate.exchange(url, ..., AdminRequest.class) 的第三个参数，
// 只不过 TS 是编译期擦除的，运行时不做任何校验（响应结构不对也不会报错！）。
// ⚠️ 这是 TS 与 Java 的重要差异：泛型不提供运行时反序列化校验，
//    真要保证安全得配 zod 之类的 schema 校验库。
  const response = await axios.post<AdminRequest>(url, params, { headers })

  return response.data
}

/**
 * Get pending admin request of a specific type for the current user.
 *
 * Returns the pending request if one exists, otherwise null.
 */
// statuses 是数组参数，REST 里通过重复 query param 表达（?statuses=a&statuses=b）。
// Java 里一般是 List<String>，由 HTTP 客户端自动编码。
export async function getMyAdminRequests(
  requestType: AdminRequestType,
  statuses: AdminRequestStatus[],
): Promise<AdminRequest[] | null> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  let url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests/me?request_type=${requestType}`
// 用字符串累加拼 query string。这里不用 URLSearchParams 是因为
// axios 会替处理，且 status 取值是内部可控枚举，不存在注入风险。
  for (const status of statuses) {
    url += `&statuses=${status}`
  }

// 注意返回类型是 `... | null`：查不到东西时服务端返回 null。
  const response = await axios.get<AdminRequest[] | null>(url, {
    headers,
  })

  return response.data
}

// 这个类型只在文件内用（没 export），属于文件私有类型。
// Java 类比：包级私有 class。
type AdminRequestEligibilityResponse = {
  request_type: AdminRequestType
  is_allowed: boolean
}

/**
 * Check if a specific admin request type is allowed for this org.
 */
// 为什么要先查「资格」：不同套餐/合同下，某类申请可能压根不允许发起。
// UI 拿到 is_allowed=false 就不该显示那个按钮——避免用户提了单石沉大海。
export async function checkAdminRequestEligibility(
  requestType: AdminRequestType,
): Promise<AdminRequestEligibilityResponse | null> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests/eligibility?request_type=${requestType}`

  const response = await axios.get<AdminRequestEligibilityResponse>(url, {
    headers,
  })

  return response.data
}
