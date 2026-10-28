/**
 * 【一句话定位】
 * OAuth 模块的类型定义文件：token 包的结构、订阅类型、以及几个「服务器返回体」的类型别名。
 * 全是类型，无任何运行时代码（编译后是空文件）。
 *
 * 【在架构中的位置】
 * 被本目录所有文件引用：client.ts（主要使用者）、index.ts、getOauthProfile.ts。
 * 它是「服务端返回的 JSON 长什么样」这一层的契约。
 *
 * 【本文件包含什么】
 * - OAuthTokens：本地保存的 token 包（accessToken/refreshToken/expiresAt + 任意扩展字段）。
 * - SubscriptionType / BillingType：订阅类型、计费类型的字符串别名。
 * - OAuthProfileResponse：profile 接口返回的原始 JSON。
 * - ReferralEligibilityResponse / ReferralRedemptionsResponse / ReferrerRewardInfo：推荐计划相关的三个响应体。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `export type X = { ... }`：类型别名。≈ Java 的 record/interface，
 *   但 TS 是「结构化类型（鸭子类型）」——只要字段对得上就兼容，不要求显式 implements。
 * - `accessToken?: string`：属性名后的 `?` 表示可选，
 *   等价于 `accessToken: string | undefined`（可以不写这个字段）。
 *   ≈ Java 的 Optional<String> 或「可以为 null 的字段」，但 TS 编译器会强制你判空。
 * - `[key: string]: unknown`：这是【索引签名】，表示「除此之外还允许任意字符串键，值类型未知」。
 *   ≈ Java 的 `Map<String, Object> extra` 字段，但 TS 把它平铺进同一个对象里。
 *   作用：让这个类型既能有明确的几个字段，又能容纳服务端以后新增的字段（向前兼容）。
 *   注意：索引签名的值类型必须兼容所有已声明属性的类型，所以这里用 unknown（最宽）。
 * - `export type SubscriptionType = string`：类型别名退化成 string。
 *   为什么不写成 `'max' | 'pro' | 'enterprise' | 'team'` 这样的字面量联合？
 *   因为这些值来自服务端，以后可能加新套餐；写成字面量联合的话，新值会导致类型不匹配。
 *   这是「外部数据放宽、内部枚举收紧」的常见取舍（内部转换逻辑在 client.ts 的 fetchProfileInfo）。
 * - `Record<string, unknown>`：内置工具类型，等价于 `{ [key: string]: unknown }`。
 *   表示「任意键、值类型未知的对象」。≈ Java 的 `Map<String, Object>`。
 *   为什么不直接用 any：unknown 强制使用者先做类型检查才能取字段，any 则完全放行。
 *   这里表示「我们还没给这些响应体定义精确形状，先用一个宽松但安全的类型占位」。
 * - 文件里没有 `export const`，说明本文件【不会产生任何 JS 输出】——
 *   这在 TS 里很常见，编译后就是空模块。Java 里对应一个只有 interface 的包。
 */
export type OAuthTokens = {
// 中文补充：这是「落盘到本机」的 token 包结构。
// 三个明确字段之外还开了索引签名 [key: string]: unknown——
// 因为实际存储时还会附带 subscriptionType、rateLimitTier、profile 等（见 client.ts 的返回），
// 用索引签名可以让这些扩展字段合法存在，而不必每次都回来改这个类型。
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  [key: string]: unknown
}

// 中文补充：刻意用 string 而不是字面量联合——服务端可能上线新套餐，
// 写死联合类型会让老版本 CLI 遇到新值时类型不匹配。取舍是「放松类型、换取兼容」。
export type SubscriptionType = string
export type BillingType = string
// 中文补充：profile 接口的原始响应体。目前用 Record 占位（没定义精确字段）。
// 代码里读取时用 `profile?.organization?.uuid` 这类可选链逐层取，
// 取不到就是 undefined——这正是 unknown/Record 要求「先检查再用」的体现。
export type OAuthProfileResponse = Record<string, unknown>
export type ReferralEligibilityResponse = Record<string, unknown>
export type ReferralRedemptionsResponse = Record<string, unknown>
export type ReferrerRewardInfo = Record<string, unknown>
