/**
 * 【一句话定位】channel（Telegram / iMessage / Discord 等）插件的「白名单 + 总开关」，决定 --channels 能不能注册。
 *
 * 【在架构中的位置】
 * - 上游：channelNotification.ts（注册 channel 处理器前先过闸）、useManageMCPConnections.ts（UI 预筛选用）。
 * - 下游：GrowthBook（配置中心，白名单存在线上，可随时更新而无需发版）。
 *
 * 【本文件包含什么】
 * - getChannelAllowlist()：从 GrowthBook 读白名单数组并用 zod 校验。
 * - isChannelsEnabled()：channels 功能的总开关（关了则 --channels 完全无效）。
 * - isChannelAllowlisted(pluginSource)：纯函数，判断某个插件是否在白名单里（仅供 UI 预筛选，不是安全边界）。
 *
 * 【为什么按「插件」粒度而不是按「server」粒度放行】
 * 英文头注解释得很清楚：如果一个插件已经在白名单里，那它的所有 channel server 都放行。
 * 按 server 粒度做是过度设计——一个已经「叛变」的插件再开个恶意 server，本身就是已沦陷的状态；
 * 而且按 server 记录会在插件做无害重构时莫名其妙失效。
 *
 * 【TS 语法速查】
 * - `z.array(z.object({...}))`：zod 声明式校验器，既是运行时校验也是类型来源。
 * - `.safeParse(raw)`：不抛异常的解析，返回 `{ success: true, data } | { success: false, error }`，
 *   ≈ Java 里返回 Result 而不是抛受检异常。
 * - `lazySchema(() => ...)`：延迟构造 schema（见 vscodeSdkMcp.ts 的说明），使用时要加 ()。
 * - `e => e.plugin === name && ...`：箭头函数 ≈ Java lambda；`.some(...)` ≈ stream().anyMatch(...)。
 * - 对象解构 `const { name, marketplace } = parsePluginIdentifier(x)` ≈ 一次取出多个字段。
 */
/**
 * Approved channel plugins allowlist. --channels plugin:name@marketplace
 * entries only register if {marketplace, plugin} is on this list. server:
 * entries always fail (schema is plugin-only). The
 * --dangerously-load-development-channels flag bypasses for both kinds.
 * Lives in GrowthBook so it can be updated without a release.
 *
 * Plugin-level granularity: if a plugin is approved, all its channel
 * servers are. Per-server gating was overengineering — a plugin that
 * sprouts a malicious second server is already compromised, and per-server
 * entries would break on harmless plugin refactors.
 *
 * The allowlist check is a pure {marketplace, plugin} comparison against
 * the user's typed tag. The gate's separate 'marketplace' step verifies
 * the tag matches what's actually installed before this check runs.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

  // 中文：白名单条目的形状——{ marketplace, plugin } 二元组，例如 { marketplace:'anthropic', plugin:'slack' }
export type ChannelAllowlistEntry = {
  marketplace: string
  plugin: string
}

  // 中文：用 zod 而不是裸 JSON.parse：线上配置是字符串，结构可能变，校验失败就降级成空数组（fail-closed）
const ChannelAllowlistSchema = lazySchema(() =>
  z.array(
    z.object({
      marketplace: z.string(),
      plugin: z.string(),
    }),
  ),
)

  /**
   * 中文：读出当前白名单。解析失败时返回 []（等价于「谁都不放行」）。
   * 为什么失败要降级成空数组而不是抛错：这是安全边界，宁可功能不可用，也不能放行未审核的插件。
   */
export function getChannelAllowlist(): ChannelAllowlistEntry[] {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_harbor_ledger',
    [],
  )
  const parsed = ChannelAllowlistSchema().safeParse(raw)
  // 中文：safeParse 不会抛异常，成功拿 data、失败降级为 []，保证调用方永远拿到数组
  return parsed.success ? parsed.data : []
}

/**
 * Overall channels on/off. Checked before any per-server gating —
 * when false, --channels is a no-op and no handlers register.
 * Default false; GrowthBook 5-min refresh.
 */
  /**
   * 中文：channels 功能的总开关（GrowthBook 上的 tengu_harbor）。
   * 为什么和「权限转发开关」分开（英文注释有说明）：这样 channels 可以先上线，
   * 而「通过 channel 审批权限」这个更敏感的能力可以之后再单独开。
   */
export function isChannelsEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_harbor', false)
}

/**
 * Pure allowlist check keyed off the connection's pluginSource — for UI
 * pre-filtering so the IDE only shows "Enable channel?" for servers that will
 * actually pass the gate. Not a security boundary: channel_enable still runs
 * the full gate. Matches the allowlist comparison inside gateChannelServer()
 * but standalone (no session/marketplace coupling — those are tautologies
 * when the entry is derived from pluginSource).
 *
 * Returns false for undefined pluginSource (non-plugin server — can never
 * match the {marketplace, plugin}-keyed ledger) and for @-less sources
 * (builtin/inline — same reason).
 */
  /**
   * 中文：判断某个插件是否在白名单里——只用于 UI 预筛选（决定要不要显示「启用 channel？」提示）。
   * 入参 pluginSource：形如 'slack@anthropic' 的插件来源标识。
   * 返回 false 的两种情况：pluginSource 为空（非插件 server，永远不可能命中以 {marketplace,plugin} 为键的白名单）；
   * 或不含 @（内置/inline 插件，同理）。
   * 注意：这不是安全边界！真正的拦截在 channel_enable 时的完整 gate（英文注释强调过）。
   */
export function isChannelAllowlisted(
  pluginSource: string | undefined,
): boolean {
  // 中文：没有来源信息 = 不是插件提供的 server，直接判否
  if (!pluginSource) return false
  const { name, marketplace } = parsePluginIdentifier(pluginSource)
  // 中文：'slack@anthropic' 会被拆成 name='slack'、marketplace='anthropic'
  if (!marketplace) return false
  // 中文：没有 marketplace（内置 / inline 插件）也不可能命中白名单，提前返回
  return getChannelAllowlist().some(
    e => e.plugin === name && e.marketplace === marketplace,
  )
}
