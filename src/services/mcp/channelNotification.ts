/**
 * 【一句话定位】channel（Discord / Slack / Telegram / SMS …）的入站通知：让 MCP server 能把用户消息推进会话。
 *
 * 【MCP 背景：channel 是什么】
 * 所谓 channel 其实就是一种特殊的 MCP server：
 *   - 出站（Claude → 用户）：它暴露普通 MCP tool（比如 send_message），这部分走标准 tool 调用；
 *   - 入站（用户 → Claude）：它主动发 notifications/claude/channel 通知，这部分就是本文件处理的。
 * 收到通知后，内容会被包进 <channel source=...> 标签塞进消息队列；SleepTool 轮询到有消息就会在 1 秒内唤醒，
 * 模型看到消息来源后自己决定用哪个 tool 回复。
 *
 * 【在架构中的位置】
 * - 上游：useManageMCPConnections.ts（连接建立后调用 gateChannelServer 决定是否注册通知处理器）。
 * - 下游：channelAllowlist.ts（白名单）、bootstrap/state.js（--channels 解析结果）、AppState/消息队列。
 *
 * 【本文件包含什么】
 * - ChannelMessageNotificationSchema：入站消息通知的 zod schema。
 * - ChannelPermissionNotificationSchema / CHANNEL_PERMISSION_METHOD：结构化的「权限审批回复」事件。
 * - ChannelPermissionRequestParams：出站「请求审批」的参数类型（CC 发出去的，所以只有类型没有校验器）。
 * - wrapChannelMessage()：把消息包成 <channel> XML。
 * - getEffectiveChannelAllowlist()：组织级白名单优先，否则用 GrowthBook 白名单。
 * - findChannelEntry()：把运行时的 server 名匹配到用户 --channels 里写的条目。
 * - gateChannelServer()：★ 准入闸门，决定要不要给这个 server 注册通知处理器。
 *
 * 【准入闸门 gateChannelServer 的六道关（顺序很讲究）】
 * capability（声明能力吗）→ runtime gate（总开关）→ auth（必须 OAuth 登录）→
 * policy（团队/企业是否开启）→ session（本次 --channels 是否列出）→ allowlist（白名单）。
 *
 * 【TS 语法速查】
 * - `feature('KAIROS')`：编译期特性开关 ≈ C 的 #ifdef，不是运行时 if——
 *   关掉时整段代码会被打包器删掉（见英文头注）。
 * - `z.literal('xxx')`：要求字段严格等于该字符串；`z.enum([...])`：枚举校验。
 * - 联合类型 + 判别字段（`{action:'register'} | {action:'skip', kind:...}`）：
 *   ≈ Java 的 sealed interface + pattern matching，switch 之后每个分支字段各不相同。
 * - `readonly ChannelEntry[]`：只读数组，编译期禁止 push/sort 等修改。
 * - `ReturnType<typeof getSubscriptionType>`：取函数返回类型，避免重复写类型名。
 * - `?? 'an unknown source'`：空值合并，null/undefined 时才取右边。
 */
/**
 * Channel notifications — lets an MCP server push user messages into the
 * conversation. A "channel" (Discord, Slack, SMS, etc.) is just an MCP server
 * that:
 *   - exposes tools for outbound messages (e.g. `send_message`) — standard MCP
 *   - sends `notifications/claude/channel` notifications for inbound — this file
 *
 * The notification handler wraps the content in a <channel> tag and
 * enqueues it. SleepTool polls hasCommandsInQueue() and wakes within 1s.
 * The model sees where the message came from and decides which tool to reply
 * with (the channel's MCP tool, SendUserMessage, or both).
 *
 * feature('KAIROS') || feature('KAIROS_CHANNELS'). Runtime gate tengu_harbor.
 * Requires claude.ai OAuth auth — API key users are blocked until
 * console gets a channelsEnabled admin surface. Teams/Enterprise orgs
 * must explicitly opt in via channelsEnabled: true in managed settings.
 */

import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { type ChannelEntry, getAllowedChannels } from '../../bootstrap/state.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import {
  getClaudeAIOAuthTokens,
  getSubscriptionType,
} from '../../utils/auth.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { escapeXmlAttr } from '../../utils/xml.js'
import {
  type ChannelAllowlistEntry,
  getChannelAllowlist,
  isChannelsEnabled,
} from './channelAllowlist.js'

  // 中文：入站消息通知的结构。meta 是「透传」字段——server 想让模型看到的额外信息
  //       （thread_id、user 等），最终会渲染成 <channel> 标签上的 XML 属性
export const ChannelMessageNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('notifications/claude/channel'),
    params: z.object({
      content: z.string(),
      // Opaque passthrough — thread_id, user, whatever the channel wants the
      // model to see. Rendered as attributes on the <channel> tag.
      meta: z.record(z.string(), z.string()).optional(),
    }),
  }),
)

/**
 * Structured permission reply from a channel server. Servers that support
 * this declare `capabilities.experimental['claude/channel/permission']` and
 * emit this event INSTEAD of relaying "yes tbxkq" as text via
 * notifications/claude/channel. Explicit opt-in per server — a channel that
 * just wants to relay text never becomes a permission surface by accident.
 *
 * The server parses the user's reply (spec: /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i)
 * and emits {request_id, behavior}. CC matches request_id against its
 * pending map. Unlike the regex-intercept approach, text in the general
 * channel can never accidentally match — approval requires the server
 * to deliberately emit this specific event.
 */
export const CHANNEL_PERMISSION_METHOD =
  'notifications/claude/channel/permission'
  // 中文：结构化的「权限审批回复」事件（server 解析完用户回复后主动发出，而不是把文本转发过来）
export const ChannelPermissionNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal(CHANNEL_PERMISSION_METHOD),
    params: z.object({
      request_id: z.string(),
      behavior: z.enum(['allow', 'deny']),
    }),
  }),
)

/**
 * Outbound: CC → server. Fired from interactiveHandler.ts when a
 * permission dialog opens and the server has declared the permission
 * capability. Server formats the message for its platform (Telegram
 * markdown, iMessage rich text, Discord embed) and sends it to the
 * human. When the human replies "yes tbxkq", the server parses that
 * against PERMISSION_REPLY_RE and emits the inbound schema above.
 *
 * Not a zod schema — CC SENDS this, doesn't validate it. A type here
 * keeps both halves of the protocol documented side by side.
 */
  // 中文：出站方向（CC → server）的请求审批参数。这里刻意不写 zod schema：
  //       因为这是 CC 自己发出去的报文，不需要校验入站；留个类型是为了让协议两半的文档挨在一起
export const CHANNEL_PERMISSION_REQUEST_METHOD =
  'notifications/claude/channel/permission_request'
  // 中文：input_preview 是截断到 200 字符的入参预览——手机屏上只放得下这么多，完整内容在终端弹框里
export type ChannelPermissionRequestParams = {
  request_id: string
  tool_name: string
  description: string
  /** JSON-stringified tool input, truncated to 200 chars with …. Full
   *  input is in the local terminal dialog; this is a phone-sized
   *  preview. Server decides whether/how to show it. */
  input_preview: string
}

/**
 * Meta keys become XML attribute NAMES — a crafted key like
 * `x="" injected="y` would break out of the attribute structure. Only
 * accept keys that look like plain identifiers. This is stricter than
 * the XML spec (which allows `:`, `.`, `-`) but channel servers only
 * send `chat_id`, `user`, `thread_ts`, `message_id` in practice.
 */
  // 中文：meta 的 key 会被当成 XML 属性名，必须限制成纯标识符，否则能被构造出属性注入
const SAFE_META_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/

  /**
   * 中文：把 channel 消息包成 <channel source="...">XML</channel>。
   * 为什么要包 XML 标签：模型要能看出「这段话来自某个外部 channel」而不是用户本人在终端里敲的。
   * 两处转义：server 名和 meta 的 value 都要 escapeXmlAttr；meta 的 key 还要先过 SAFE_META_KEY 白名单。
   */
export function wrapChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, string>,
): string {
  const attrs = Object.entries(meta ?? {})
    .filter(([k]) => SAFE_META_KEY.test(k))
    .map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`)
    .join('')
  // 中文：三连链式调用——filter 过滤非法 key，map 拼成 ` k="v"`，join 合成一段属性字符串
  return `<${CHANNEL_TAG} source="${escapeXmlAttr(serverName)}"${attrs}>\n${content}\n</${CHANNEL_TAG}>`
}

/**
 * Effective allowlist for the current session. Team/enterprise orgs can set
 * allowedChannelPlugins in managed settings — when set, it REPLACES the
 * GrowthBook ledger (admin owns the trust decision). Undefined falls back
 * to the ledger. Unmanaged users always get the ledger.
 *
 * Callers already read sub/policy for the policy gate — pass them in to
 * avoid double-reading getSettingsForSource (uncached).
 */
  /**
   * 中文：算出本会话实际生效的 channel 白名单。
   * 规则：团队/企业组织可以在管理设置里配 allowedChannelPlugins，一旦配了就**完全取代**
   * GrowthBook 上的白名单（信任决策归管理员）；没配才回落到 GrowthBook。个人用户永远用 GrowthBook。
   * 入参 sub / orgList 由调用方传入（英文注释说明：读设置是未缓存的，别重复读）。
   */
export function getEffectiveChannelAllowlist(
  sub: ReturnType<typeof getSubscriptionType>,
  orgList: ChannelAllowlistEntry[] | undefined,
): {
  entries: ChannelAllowlistEntry[]
  source: 'org' | 'ledger'
} {
  if ((sub === 'team' || sub === 'enterprise') && orgList) {
    // 中文：仅当订阅是 team/enterprise **且** 组织确实配了名单时才走组织通道
    return { entries: orgList, source: 'org' }
  }
  return { entries: getChannelAllowlist(), source: 'ledger' }
}

  /**
   * 中文：闸门的结果类型。要么注册（register），要么跳过并说明是哪一关卡住的（kind）以及原因（reason）。
   * kind 的七种取值对应下面 gateChannelServer 里的每一道关。
   */
export type ChannelGateResult =
  | { action: 'register' }
  | {
      action: 'skip'
      kind:
        | 'capability'
        | 'disabled'
        | 'auth'
        | 'policy'
        | 'session'
        | 'marketplace'
        | 'allowlist'
      reason: string
    }

/**
 * Match a connected MCP server against the user's parsed --channels entries.
 * server-kind is exact match on bare name; plugin-kind matches on the second
 * segment of plugin:X:Y. Returns the matching entry so callers can read its
 * kind — that's the user's trust declaration, not inferred from runtime shape.
 */
  /**
   * 中文：把运行时看到的 server 名匹配到用户在 --channels 里写的条目。
   * 两种写法：server 类型按名字精确匹配；plugin 类型按 'plugin:X:Y' 的第二段匹配。
   * 返回匹配到的条目——因为条目里带有 kind（用户明确的信任声明），不能靠运行时形态去猜。
   */
export function findChannelEntry(
  serverName: string,
  channels: readonly ChannelEntry[],
): ChannelEntry | undefined {
  // split unconditionally — for a bare name like 'slack', parts is ['slack']
  // and the plugin-kind branch correctly never matches (parts[0] !== 'plugin').
  const parts = serverName.split(':')
    // 中文：对裸名（如 'slack'）split 出来是 ['slack']，plugin 分支天然不会误匹配
  return channels.find(c =>
    c.kind === 'server'
      ? serverName === c.name
      : parts[0] === 'plugin' && parts[1] === c.name,
  )
}

/**
 * Gate an MCP server's channel-notification path. Caller checks
 * feature('KAIROS') || feature('KAIROS_CHANNELS') first (build-time
 * elimination). Gate order: capability → runtime gate (tengu_harbor) →
 * auth (OAuth only) → org policy → session --channels → allowlist.
 * API key users are blocked at the auth layer — channels requires
 * claude.ai auth; console orgs have no admin opt-in surface yet.
 *
 *   skip      Not a channel server, or managed org hasn't opted in, or
 *             not in session --channels. Connection stays up; handler
 *             not registered.
 *   register  Subscribe to notifications/claude/channel.
 *
 * Which servers can connect at all is governed by allowedMcpServers —
 * this gate only decides whether the notification handler registers.
 */
  /**
   * 中文：★ 决定要不要给这个 server 注册 channel 通知处理器。
   * 入参 serverName / capabilities（server 声明的能力）/ pluginSource（插件来源，如 'slack@anthropic'）。
   * 返回 { action:'register' } 或 { action:'skip', kind, reason }（reason 是要展示给用户的人话）。
   * 注意：这个闸门只决定「要不要收它的入站通知」；server 能不能连上由 allowedMcpServers 管。
   */
export function gateChannelServer(
  serverName: string,
  capabilities: ServerCapabilities | undefined,
  pluginSource: string | undefined,
): ChannelGateResult {
  // Channel servers declare `experimental['claude/channel']: {}` (MCP's
  // presence-signal idiom — same as `tools: {}`). Truthy covers `{}` and
  // `true`; absent/undefined/explicit-`false` all fail. Key matches the
  // notification method namespace (notifications/claude/channel).
    // 中文：第 1 关——必须自己声明 claude/channel 能力（MCP 里用 `key: {}` 表示「我支持这个」）
  if (!capabilities?.experimental?.['claude/channel']) {
    return {
      action: 'skip',
      kind: 'capability',
      reason: 'server did not declare claude/channel capability',
    }
  }

  // Overall runtime gate. After capability so normal MCP servers never hit
  // this path. Before auth/policy so the killswitch works regardless of
  // session state.
    // 中文：第 2 关——总开关。放在能力之后（普通 server 根本走不到这里）、鉴权之前（保证一键关停一定有效）
  if (!isChannelsEnabled()) {
    return {
      action: 'skip',
      kind: 'disabled',
      reason: 'channels feature is not currently available',
    }
  }

  // OAuth-only. API key users (console) are blocked — there's no
  // channelsEnabled admin surface in console yet, so the policy opt-in
  // flow doesn't exist for them. Drop this when console parity lands.
    // 中文：第 3 关——只认 claude.ai 的 OAuth 登录；API key 用户被拦（console 还没有管理员开关界面）
  if (!getClaudeAIOAuthTokens()?.accessToken) {
    return {
      action: 'skip',
      kind: 'auth',
      reason: 'channels requires claude.ai authentication (run /login)',
    }
  }

  // Teams/Enterprise opt-in. Managed orgs must explicitly enable channels.
  // Default OFF — absent or false blocks. Keyed off subscription tier, not
  // "policy settings exist" — a team org with zero configured policy keys
  // (remote endpoint returns 404) is still a managed org and must not fall
  // through to the unmanaged path.
    // 中文：第 4 关——团队/企业必须由管理员显式开启。注意「是不是受管组织」按订阅档位判断，
    //       不能按「是否存在策略配置」判断：一个零配置的团队组织仍然是受管组织，不能走非受管的宽松路径
  const sub = getSubscriptionType()
  const managed = sub === 'team' || sub === 'enterprise'
  const policy = managed ? getSettingsForSource('policySettings') : undefined
    // 中文：`!== true` 而不是 `!policy?.channelsEnabled`：缺席和 false 都要拦，只有显式 true 才放行
  if (managed && policy?.channelsEnabled !== true) {
    return {
      action: 'skip',
      kind: 'policy',
      reason:
        'channels not enabled by org policy (set channelsEnabled: true in managed settings)',
    }
  }

  // User-level session opt-in. A server must be explicitly listed in
  // --channels to push inbound this session — protects against a trusted
  // server surprise-adding the capability.
    // 中文：第 5 关——本次会话的 --channels 必须明确列出它，防止「受信任的 server 偷偷给自己加能力」
  const entry = findChannelEntry(serverName, getAllowedChannels())
  if (!entry) {
    return {
      action: 'skip',
      kind: 'session',
      reason: `server ${serverName} not in --channels list for this session`,
    }
  }

    // 中文：plugin 类型要多查两道：marketplace 是否对得上、插件是否在白名单里
  if (entry.kind === 'plugin') {
    // Marketplace verification: the tag is intent (plugin:slack@anthropic),
    // the runtime name is just plugin:slack:X — could be slack@anthropic or
    // slack@evil depending on what's installed. Verify they match before
    // trusting the tag for the allowlist check below. Source is stashed on
    // the config at addPluginScopeToServers — undefined (non-plugin server,
    // shouldn't happen for plugin-kind entry) or @-less (builtin/inline)
    // both fail the comparison.
    const actual = pluginSource
      ? parsePluginIdentifier(pluginSource).marketplace
      : undefined
    // 中文：用户写的是 `plugin:slack@anthropic`（意图），运行时名字只是 `plugin:slack:X`（现实）——
    //       装的到底是官方 slack 还是同名恶意插件，必须比对 marketplace 才知道
    if (actual !== entry.marketplace) {
      return {
        action: 'skip',
        kind: 'marketplace',
        reason: `you asked for plugin:${entry.name}@${entry.marketplace} but the installed ${entry.name} plugin is from ${actual ?? 'an unknown source'}`,
      }
    }

    // Approved-plugin allowlist. Marketplace gate already verified
    // tag == reality, so this is a pure entry check. entry.dev (per-entry,
    // not the session-wide bit) bypasses — so accepting the dev dialog for
    // one entry doesn't leak allowlist-bypass to --channels entries.
    // 中文：entry.dev 是「单条目」的开发豁免——只放行这一条，不会把豁免扩散到其它 --channels 条目
    if (!entry.dev) {
      const { entries, source } = getEffectiveChannelAllowlist(
        sub,
        policy?.allowedChannelPlugins,
      )
      if (
        !entries.some(
          e => e.plugin === entry.name && e.marketplace === entry.marketplace,
        )
      ) {
        return {
          action: 'skip',
          kind: 'allowlist',
          reason:
            source === 'org'
              ? `plugin ${entry.name}@${entry.marketplace} is not on your org's approved channels list (set allowedChannelPlugins in managed settings)`
              : `plugin ${entry.name}@${entry.marketplace} is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`,
        }
      }
    }
    // 中文：server 类型直接拦：白名单的键是 {marketplace, plugin}，server 条目永远不可能命中
  } else {
    // server-kind: allowlist schema is {marketplace, plugin} — a server entry
    // can never match. Without this, --channels server:plugin:foo:bar would
    // match a plugin's runtime name and register with no allowlist check.
    // 中文：若不加这个分支，`--channels server:plugin:foo:bar` 就能借某个插件的运行时名字绕过白名单
    if (!entry.dev) {
      return {
        action: 'skip',
        kind: 'allowlist',
        reason: `server ${entry.name} is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`,
      }
    }
  }

  return { action: 'register' }
}
