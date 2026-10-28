/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 中文导读（英文原注释很长，这里给一份自成一体的中文说明，原注释完整保留）：
 *
 * 【一句话定位】让「权限确认弹框」能通过 channel（Telegram / iMessage / Discord）远程审批。
 *
 * 【整体流程】
 * ① Claude Code 遇到权限弹框时，除了本地 UI，还会把提示通过已启用的 channel 发出去；
 * ② 提示里带一个 5 位小写的短 ID（如 tbxkq），用户在手机上回复 “yes tbxkq”；
 * ③ channel server 负责解析这条回复，然后向 CC 发一个「结构化事件」
 *    notifications/claude/channel/permission，内容是 { request_id, behavior }；
 * ④ CC 只按 request_id 在挂起的 Map 里找对应的 resolver，第一个到的（本地UI/bridge/hook/channel）获胜。
 *
 * 【安全边界在哪里】
 * 审批人是「通过 channel 的人类」，不是 Claude 自己。真正的信任边界不是终端，而是白名单
 * （tengu_harbor_ledger，见 channelAllowlist.ts）：一个被攻陷的 channel server 理论上可以伪造
 * 「yes xxx」而用户根本没看到提示——这是已知并接受的风险，因为被攻陷的 channel 本来就能无限次
 * 注入对话内容（慢慢社工、等 acceptEdits 等），「注入+自批」只是更快，并没有更强。
 * 弹框能拖慢一个被攻陷的 channel，但拦不住它。
 *
 * 【本文件包含什么】
 * - isChannelPermissionRelayEnabled()：GrowthBook 上的独立开关。
 * - PERMISSION_REPLY_RE：回复格式规范（导出给插件直接用，避免各写一份正则）。
 * - shortRequestId(toolUseID)：把长 toolUseID 哈希成 5 位小写字母短 ID，并避开脏词。
 * - truncateForPreview(input)：把 tool 入参截成 200 字符的手机友好预览。
 * - filterPermissionRelayClients()：筛出「能转发权限请求」的 channel 客户端（三个条件全满足）。
 * - createChannelPermissionCallbacks()：维护 requestId → resolver 的挂起表。
 * ─────────────────────────────────────────────────────────────────────────────
/**
 * Permission prompts over channels (Telegram, iMessage, Discord).
 *
 * Mirrors `BridgePermissionCallbacks` — when CC hits a permission dialog,
 * it ALSO sends the prompt via active channels and races the reply against
 * local UI / bridge / hooks / classifier. First resolver wins via claim().
 *
 * Inbound is a structured event: the server parses the user's "yes tbxkq"
 * reply and emits notifications/claude/channel/permission with
 * {request_id, behavior}. CC never sees the reply as text — approval
 * requires the server to deliberately emit that specific event, not just
 * relay content. Servers opt in by declaring
 * capabilities.experimental['claude/channel/permission'].
 *
 * Kenneth's "would this let Claude self-approve?": the approving party is
 * the human via the channel, not Claude. But the trust boundary isn't the
 * terminal — it's the allowlist (tengu_harbor_ledger). A compromised
 * channel server CAN fabricate "yes <id>" without the human seeing the
 * prompt. Accepted risk: a compromised channel already has unlimited
 * conversation-injection turns (social-engineer over time, wait for
 * acceptEdits, etc.); inject-then-self-approve is faster, not more
 * capable. The dialog slows a compromised channel; it doesn't stop one.
 * See PR discussion 2956440848.
 */

import { jsonStringify } from '../../utils/slowOperations.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/**
 * GrowthBook runtime gate — separate from the channels gate (tengu_harbor)
 * so channels can ship without permission-relay riding along (Kenneth: "no
 * bake time if it goes out tomorrow"). Default false; flip without a release.
 * Checked once at useManageMCPConnections mount — mid-session flag changes
 * don't apply until restart.
 */
  /**
   * 中文：是否允许通过 channel 转发权限请求（GrowthBook 上的 tengu_harbor_permissions）。
   * 为什么要跟 channel 总开关（tengu_harbor）分开：这样 channel 功能可以先发布，
   * 而「远程审批权限」这个更敏感的能力可以之后再单独灰度，不必等烘焙期。
   * 注意：这个值只在 useManageMCPConnections 挂载时读一次，会话中途改 flag 要重启才生效。
   */
export function isChannelPermissionRelayEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_harbor_permissions', false)
}

  // 中文：一次审批的结果——behavior 是放行/拒绝，fromServer 记录是哪个 channel 回的（便于日志溯源）
export type ChannelPermissionResponse = {
  behavior: 'allow' | 'deny'
  /** Which channel server the reply came from (e.g., "plugin:telegram:tg"). */
  fromServer: string
}

  // 中文：回调接口。onResponse 注册「这个 requestId 的处理器」并返回取消注册函数；
  //       resolve 由专门的 notification 处理器调用（CC 自己不再对文本做正则匹配）
export type ChannelPermissionCallbacks = {
  /** Register a resolver for a request ID. Returns unsubscribe. */
  onResponse(
    requestId: string,
    handler: (response: ChannelPermissionResponse) => void,
  ): () => void
  /** Resolve a pending request from a structured channel event
   *  (notifications/claude/channel/permission). Returns true if the ID
   *  was pending — the server parsed the user's reply and emitted
   *  {request_id, behavior}; we just match against the map. */
  resolve(
    requestId: string,
    behavior: 'allow' | 'deny',
    fromServer: string,
  ): boolean
}

/**
 * Reply format spec for channel servers to implement:
 *   /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
 *
 * 5 lowercase letters, no 'l' (looks like 1/I). Case-insensitive (phone
 * autocorrect). No bare yes/no (conversational). No prefix/suffix chatter.
 *
 * CC generates the ID and sends the prompt. The SERVER parses the user's
 * reply and emits notifications/claude/channel/permission with {request_id,
 * behavior} — CC doesn't regex-match text anymore. Exported so plugins can
 * import the exact regex rather than hand-copying it.
 */
  /**
   * 中文：回复格式规范，导出给 channel 插件直接复用（避免各家手写正则导致行为不一致）。
   * 形态：可选的空白 + (y|yes|n|no) + 空白 + 5 位小写字母 + 可选空白，忽略大小写。
   * 设计取舍：5 位字母且不含 'l'（像 1 和 I）；大小写不敏感（手机自动纠错会把首字母大写）；
   * 不允许裸 yes/no（防止把日常聊天误判成审批）；不允许前缀后缀闲聊。
   */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// 25-letter alphabet: a-z minus 'l' (looks like 1/I). 25^5 ≈ 9.8M space.
  // 中文：字母表去掉了 'l'——在很多字体里 l 和 1、I 长得一样，用户照着抄容易抄错
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

// Substring blocklist — 5 random letters can spell things (Kenneth, in the
// launch thread: "this is why i bias to numbers, hard to have anything worse
// than 80085"). Non-exhaustive, covers the send-to-your-boss-by-accident
// tier. If a generated ID contains any of these, re-hash with a salt.
// prettier-ignore
const ID_AVOID_SUBSTRINGS = [
  'fuck',
  'shit',
  'cunt',
  'cock',
  'dick',
  'twat',
  'piss',
  'crap',
  'bitch',
  'whore',
  'ass',
  'tit',
  'cum',
  'fag',
  'dyke',
  'nig',
  'kike',
  'rape',
  'nazi',
  'damn',
  'poo',
  'pee',
  'wank',
  'anus',
]

  /**
   * 中文：把任意字符串哈希成 5 位字母短 ID（内部函数）。
   * 算法：FNV-1a 哈希成 uint32，再按 25 进制编码取 5 位。
   * 为什么不是加密级随机（英文注释说明了）：这只是一个「稳定、短、纯字母」的 ID，
   * 不需要抗碰撞攻击；32 位哈希约有 6.9 个字母的熵，取 5 位绰绰有余。
   */
function hashToId(input: string): string {
  // FNV-1a → uint32, then base-25 encode. Not crypto, just a stable
  // short letters-only ID. 32 bits / log2(25) ≈ 6.9 letters of entropy;
  // taking 5 wastes a little, plenty for this.
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
    // 中文：务必用 Math.imul 做乘法（32 位整数乘法），直接用 * 会因为超出 2^31 而丢失精度
  h = h >>> 0
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += ID_ALPHABET[h % 25]
    h = Math.floor(h / 25)
  }
  return s
}

/**
 * Short ID from a toolUseID. 5 letters from a 25-char alphabet (a-z minus
 * 'l' — looks like 1/I in many fonts). 25^5 ≈ 9.8M space, birthday
 * collision at 50% needs ~3K simultaneous pending prompts, absurd for a
 * single interactive session. Letters-only so phone users don't switch
 * keyboard modes (hex alternates a-f/0-9 → mode toggles). Re-hashes with
 * a salt suffix if the result contains a blocklisted substring — 5 random
 * letters can spell things you don't want in a text message to your phone.
 * toolUseIDs are `toolu_` + base64-ish; we hash rather than slice.
 */
  /**
   * 中文：由 toolUseID 生成用户在手机上输入用的短 ID。
   * 为什么纯字母（英文注释有说明）：手机用户不用切换键盘模式；若用十六进制会在 a-f 和 0-9 之间来回切。
   * 为什么是 5 位：25^5 ≈ 980 万种组合，单个会话要同时挂起约 3000 个弹框才有 50% 撞号概率，不可能发生。
   * 脏词处理：随机 5 个字母可能拼出不雅单词，命中就加盐重哈希（最多 10 次）。
   * 入参 toolUseID：形如 'toolu_xxx' 的 ID；这里哈希而不是截取，因为截取会丢失区分度。
   */
export function shortRequestId(toolUseID: string): string {
  // 7 length-3 × 3 positions × 25² + 15 length-4 × 2 × 25 + 2 length-5
  // ≈ 13,877 blocked IDs out of 9.8M — roughly 1 in 700 hits the blocklist.
  // Cap at 10 retries; (1/700)^10 is negligible.
  let candidate = hashToId(toolUseID)
  for (let salt = 0; salt < 10; salt++) {
    // 中文：命中脏词就换盐重哈希；命中概率约 1/700，重试 10 次后仍命中也算可接受（概率可忽略）
    if (!ID_AVOID_SUBSTRINGS.some(bad => candidate.includes(bad))) {
      return candidate
    }
    candidate = hashToId(`${toolUseID}:${salt}`)
  }
  return candidate
}

/**
 * Truncate tool input to a phone-sized JSON preview. 200 chars is
 * roughly 3 lines on a narrow phone screen. Full input is in the local
 * terminal dialog; the channel gets a summary so Write(5KB-file) doesn't
 * flood your texts. Server decides whether/how to show it.
 */
  /**
   * 中文：把 tool 的入参截成适合手机屏幕的短预览（200 字符，约 3 行）。
   * 为什么要截断：完整入参在本地终端弹框里已经能看到；全部发到手机会把短信刷爆
   * （例如 Write 一个 5KB 文件）。是否展示、怎么展示由 channel server 自己决定。
   * 序列化失败时返回 '(unserializable)'（例如入参里有循环引用）。
   */
export function truncateForPreview(input: unknown): string {
  try {
    const s = jsonStringify(input)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  } catch {
    return '(unserializable)'
  }
}

/**
 * Filter MCP clients down to those that can relay permission prompts.
 * Three conditions, ALL required: connected + in the session's --channels
 * allowlist + declares BOTH capabilities. The second capability is the
 * server's explicit opt-in — a relay-only channel never becomes a
 * permission surface by accident (Kenneth's "users may be unpleasantly
 * surprised"). Centralized here so a future fourth condition lands once.
 */
  /**
   * 中文：筛出「可以转发权限请求」的 channel 客户端。三个条件必须全满足：
   *   ① 连接状态是 connected；② 在本会话的 --channels 白名单里；③ 同时声明了两个 capability
   *      （'claude/channel' 和 'claude/channel/permission'）。
   * 第二个 capability 就是 server 的显式「我愿意接收权限请求」声明——只做消息转发的 channel
   * 不会因为升级就莫名其妙变成审批入口。
   * 泛型 `<T extends {...}>`：≈ Java 的 `<T extends SomeInterface>`，约束入参必须有哪些字段。
   * 入参 isInAllowlist：由调用方传入的白名单判断函数（把「会话状态」从本纯函数里解耦出去）。
   */
export function filterPermissionRelayClients<
  T extends {
    type: string
    name: string
    capabilities?: { experimental?: Record<string, unknown> }
  },
>(
  clients: readonly T[],
  isInAllowlist: (name: string) => boolean,
): (T & { type: 'connected' })[] {
  return clients.filter(
    (c): c is T & { type: 'connected' } =>
    // 中文：`c is T & {type:'connected'}` 是「类型谓词」，告诉编译器 filter 之后元素类型收窄了，
    //       ≈ Java 里 instanceof 模式匹配；`T & {...}` 是交叉类型（两个类型都要满足）
      c.type === 'connected' &&
      isInAllowlist(c.name) &&
      c.capabilities?.experimental?.['claude/channel'] !== undefined &&
      c.capabilities?.experimental?.['claude/channel/permission'] !== undefined,
  )
}

/**
 * Factory for the callbacks object. The pending Map is closed over — NOT
 * module-level (per src/CLAUDE.md), NOT in AppState (functions-in-state
 * causes issues with equality/serialization). Same lifetime pattern as
 * `replBridgePermissionCallbacks`: constructed once per session inside
 * a React hook, stable reference stored in AppState.
 *
 * resolve() is called from the dedicated notification handler
 * (notifications/claude/channel/permission) with the structured payload.
 * The server already parsed "yes tbxkq" → {request_id, behavior}; we just
 * match against the pending map. No regex on CC's side — text in the
 * general channel can't accidentally approve anything.
 */
  /**
   * 中文：造出回调对象。pending 这个 Map 被闭包捕获（英文注释强调：不放模块级、也不放 AppState，
   * 因为函数放进 state 会引发相等性/序列化问题），生命周期与 React hook 一致。
   * 返回 { onResponse, resolve }：前者注册等待者并返回「取消注册」函数；后者由 notification 处理器调用。
   */
export function createChannelPermissionCallbacks(): ChannelPermissionCallbacks {
  const pending = new Map<
    string,
    (response: ChannelPermissionResponse) => void
  >()

  return {
    // 中文：对象字面量里直接写方法名（对象方法简写），等价于 onResponse: function(requestId, handler) {...}
    onResponse(requestId, handler) {
      // Lowercase here too — resolve() already does; asymmetry means a
      // future caller passing a mixed-case ID would silently never match.
      // shortRequestId always emits lowercase so this is a noop today,
      // but the symmetry makes the contract explicit.
      const key = requestId.toLowerCase()
      pending.set(key, handler)
      return () => {
        pending.delete(key)
      }
    },

    resolve(requestId, behavior, fromServer) {
      const key = requestId.toLowerCase()
      const resolver = pending.get(key)
      if (!resolver) return false
      // Delete BEFORE calling — if resolver throws or re-enters, the
      // entry is already gone. Also handles duplicate events (second
      // emission falls through — server bug or network dup, ignore).
      // 中文：先删再调——万一 resolver 抛异常或重入，这条记录也已经清掉了；
      //        重复事件（server bug 或网络重发）第二次进来会因为查不到而直接返回 false
      pending.delete(key)
      resolver({ behavior, fromServer })
      return true
    },
  }
}
