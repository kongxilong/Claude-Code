/**
 * 【一句话定位】
 * PKCE（Proof Key for Code Exchange）所需的三个密码学小工具：生成随机串、算 SHA-256 摘要、
 * 以及统一的 BASE64URL 编码。整个文件不到 25 行，但它是 CLI 版 OAuth 的安全基石。
 *
 * 【在架构中的位置】
 * 调用链：
 *   oauth/index.ts OAuthService
 *     → 本文件 generateCodeVerifier()（登录开始时生成原始随机串，只留本地）
 *     → 本文件 generateCodeChallenge(verifier)（算出摘要，发给授权服务器）
 *     → 本文件 generateState()（生成防 CSRF 的随机串）
 * 下游：Node 内置 crypto 模块（≈ Java 的 java.security.SecureRandom + MessageDigest）。
 *
 * 【为什么 CLI 必须有 PKCE（重点）】
 * 传统 Web 应用的 OAuth：服务端持有 client_secret，用它证明「我是那个正规应用」。
 * CLI 是分发到用户机器上的，任何 secret 都会被反编译出来，等于没有 secret。
 * PKCE 的思路是「把静态密钥换成每次登录临时生成的一次性密钥对」：
 *   ① verifier  = 32 字节密码学随机串（本文件 generateCodeVerifier）
 *   ② challenge = BASE64URL(SHA256(verifier))（本文件 generateCodeChallenge）
 *   ③ 授权请求只发 challenge（是摘要，泄露也无法反推 verifier）
 *   ④ 换 token 时才发 verifier，服务端重新算一遍 SHA256 比对，一致才发 token
 * 于是：即使攻击者在回调环节截获了授权码，他没有 verifier，也换不到 token。
 * Java 类比：相当于每次登录临时生成一对「公钥(challenge)/私钥(verifier)」，用完即弃。
 *
 * 【本文件包含什么】
 * - base64URLEncode()：把二进制缓冲编码成 URL 安全的 Base64（内部使用，未导出）。
 * - generateCodeVerifier()：生成 32 字节随机串作为 PKCE verifier。
 * - generateCodeChallenge()：对 verifier 做 SHA-256 并 BASE64URL 编码。
 * - generateState()：生成防 CSRF 的随机串。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `import { createHash, randomBytes } from 'crypto'`：从 Node 内置模块具名导入。
 *   ≈ Java 的 `import java.security.MessageDigest;`（这里一次导入两个）。
 * - `function base64URLEncode(buffer: Buffer): string {`：
 *   `buffer: Buffer` 是参数类型标注（注意类型在【变量名后面】，Java 在前面）；
 *   `): string {` 是返回值类型标注（在参数列表【后面】，Java 在方法名前面）。
 * - 没有 `export` 的函数是模块私有的 ≈ Java 的 private static 方法。
 * - `buffer.toString('base64')`：Buffer 是 Node 的字节数组类型。
 *   ≈ Java 的 `byte[]` + `Base64.getEncoder().encodeToString(bytes)`。
 * - `.replace(/\+/g, '-')`：正则替换，`/.../g` 是正则字面量（g = 全局替换）。
 *   ≈ Java 的 `s.replaceAll(Pattern.quote("+"), "-")`，但 TS 有原生正则语法更简洁。
 * - 链式调用 `.replace().replace().replace()`：≈ Java 的 String 链式 replaceAll。
 * - `randomBytes(32)`：密码学安全的随机数生成器。≈ Java 的 `SecureRandom`。
 *   注意不能用 Math.random()——它不是密码学安全的，会被预测。
 * - `createHash('sha256')` + `hash.update(x)` + `hash.digest()`：
 *   这就是标准哈希 API 的三段式，和 Java 完全对应：
 *   `MessageDigest.getInstance("SHA-256")` → `md.update(bytes)` → `md.digest()`。
 * - 为什么必须做 `+ → -`、`/ → _`、去掉 `=` 这三个替换：
 *   标准 Base64 用了 + 和 / 两个字符，在 URL 里是有特殊含义的（+ 会被解成空格），
 *   末尾的 = 是填充符在 query string 里也容易出问题。所以要转成 URL 安全变体（RFC 4648 §5）。
 *   Java 对应 `Base64.getUrlEncoder().withoutPadding()`。
 * - 三个导出函数都是纯函数（无副作用、同样输入同样输出，只依赖传入参数和随机源）。
 */
import { createHash, randomBytes } from 'crypto'

// BASE64URL 编码（RFC 4648 §5）：标准 Base64 的 +/ 在 URL 里有特殊含义，= 填充在 query 里也麻烦，
// 所以分别替换成 - 和 _ 并去掉填充符。Java 对应 Base64.getUrlEncoder().withoutPadding().encodeToString()。
function base64URLEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// PKCE 的 code_verifier：32 字节 = 256 位随机熵，符合 RFC 7636 建议（43~128 字符）。
// 用 randomBytes（密码学安全）而不是 Math.random()——后者可预测，会被攻击。
// 这个值全程只存在内存里，只在最后换 token 那一刻才发出去一次。
export function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32))
}

// PKCE 的 code_challenge = BASE64URL(SHA256(verifier))。
// 单向哈希：服务端（以及任何截获者）都无法从 challenge 反推 verifier，
// 但只要对方亮出 verifier，就能立刻验算比对——这就是 PKCE 的精髓。
// 授权请求里配套的 code_challenge_method 必须写 'S256'（表示用 SHA-256），
// 绝不能写 'plain'（那样 challenge 就等于 verifier，形同虚设）。
export function generateCodeChallenge(verifier: string): string {
  const hash = createHash('sha256')
  hash.update(verifier)
  return base64URLEncode(hash.digest())
}

// state：防 CSRF 的随机串。发出去时存一份，浏览器回调带回来时比对，不一致就拒绝。
// 和 code_verifier 一样用 32 字节随机，保证不可猜测。
export function generateState(): string {
  return base64URLEncode(randomBytes(32))
}
