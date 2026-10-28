/**
 * 【一句话定位】查询「超额赠金（overage credit grant）」的资格与金额，带按组织隔离的磁盘缓存。
 *
 * 【在架构中的位置】
 *   调用链：UI 层的促销/升级引导组件（upsell surface）
 *           → 本文件 getCachedOverageCreditGrant()（先读缓存，null 就什么都不显示）
 *           → 本文件 refreshOverageCreditGrantCache()（后台懒加载，填充缓存）
 *             → fetchOverageCreditGrant()
 *               → utils/teleport/api.ts（prepareApiRequest / getOAuthHeaders）
 *               → axios.get → `${BASE_API_URL}/api/oauth/organizations/${orgUUID}/overage_credit_grant`
 *           → 本文件 invalidateOverageCreditGrantCache()（用户真的领了之后主动失效）
 *           → 本文件 formatGrantAmount()（把分单位金额格式化成 $x.xx）
 *           → utils/config.ts（getGlobalConfig / saveGlobalConfig 落盘缓存）
 *
 * 【设计意图】金额和资格由**后端**按套餐档位/角色权限算好下发，
 *   客户端不做任何业务判断（注释里明说：不在 CLI 里复制那套逻辑）。
 *   好处是促销规则改了不用发版。
 *
 * 【本文件包含什么】
 *   - OverageCreditGrantInfo：赠金信息（是否可用/有资格/已领取/金额/币种）。
 *   - CachedGrantEntry：缓存条目（信息 + 时间戳）。
 *   - fetchOverageCreditGrant()：纯网络查询。
 *   - getCachedOverageCreditGrant()：读缓存（过期返回 null）。
 *   - invalidateOverageCreditGrantCache()：只删当前组织的缓存条目。
 *   - refreshOverageCreditGrantCache()：拉取并落盘。
 *   - formatGrantAmount()：金额格式化。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `getGlobalConfig().overageCreditGrantCache?.[orgId]`：
 *      - `?.` 可选链：cache 为 undefined 时整条表达式短路为 undefined，不抛 NPE；
 *      - `?.[orgId]` 是「可选链 + 索引访问」，Java 里要先判 map != null 再 get。
 *      两个合起来：null 安全的 Map 取值。
 *   2. `saveGlobalConfig(prev => {...})`：这个 API 的特点（注释里讲了）是
 *      **在文件锁内重新读一次磁盘配置**，所以回调里拿到的 prev 才是最新的。
 *      Java 类比：数据库的 SELECT ... FOR UPDATE，在事务里读到的才是当前值。
 *      因此所有判断都必须基于 prev，不能基于外面提前 getGlobalConfig() 的快照。
 *   3. `{ ...prev.overageCreditGrantCache, [orgId]: entry }`：
 *      - 展开旧 map 的所有条目；
 *      - `[orgId]: entry` 是**计算属性名**——key 用变量而不是字面量。
 *      Java 没有对应语法（要 new HashMap<>(old); put(key, val)）。
 *      整体 = 不可变地往 Map 里塞一个 key。
 *   4. `const next = {...prev.overageCreditGrantCache}; delete next[orgId]`：
 *      delete 运算符删对象属性，≈ map.remove(key)。
 *   5. `info.amount_minor_units == null`：`== null` 是**同时**判 null 和 undefined 的惯用写法
 *      （`=== null` 只判 null）。这里刻意用宽松相等，是有意的例外。
 *      金额用「最小货币单位（分）」存整数，避免浮点误差——跟 Java 用 BigDecimal 或 long 存分的思路一致。
 *   6. `existing && existing.available === info.available && ...`：
 *      一长串 `&&` 短路求值，最终得到 `T | undefined | false` 这种混合类型。
 *      Java 里这种链只能得到 boolean，TS 里 && 返回的是**最后那个真值本身**。
 *   7. `export type { CachedGrantEntry as OverageCreditGrantCacheEntry }`：
 *      只导出类型并**改名**。≈ Java 里把这个类 public 出来，但换个对外名字。
 */
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

// available：当前档位有没有这个赠金活动；eligible：这个用户够不够格领；
// granted：是否已经领过了。三个是独立的维度，UI 靠它们决定显示什么文案。
// amount_minor_units：以「分」为单位的整数（100 = $1.00）。
//   为什么不用小数？浮点数表示金额会在累加/比较时出精度问题，
//   金融系统的通用做法是整数存最小单位。Java 里对应 long cents 或 BigDecimal。
export type OverageCreditGrantInfo = {
  available: boolean
  eligible: boolean
  granted: boolean
  amount_minor_units: number | null
  currency: string | null
}

// 缓存条目 = 数据 + 写入时间戳，用于 TTL 过期判断。
// 跟 metricsOptOut.ts 里的写法一致，是本项目磁盘缓存的标准形状。
type CachedGrantEntry = {
  info: OverageCreditGrantInfo
  timestamp: number
}

// 1 小时 TTL：赠金状态变化不频繁，但用户领完之后要能在合理时间内看到更新。
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Fetch the current user's overage credit grant eligibility from the backend.
 * The backend resolves tier-specific amounts and role-based claim permission,
 * so the CLI just reads the response without replicating that logic.
 */
// 纯网络查询，不带缓存。失败只记日志并返回 null（促销信息不是关键路径）。
async function fetchOverageCreditGrant(): Promise<OverageCreditGrantInfo | null> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/overage_credit_grant`
    const response = await axios.get<OverageCreditGrantInfo>(url, {
      headers: getOAuthHeaders(accessToken),
    })
    return response.data
  } catch (err) {
    logError(err)
    return null
  }
}

/**
 * Get cached grant info. Returns null if no cache or cache is stale.
 * Callers should render nothing (not block) when this returns null —
 * refreshOverageCreditGrantCache fires lazily to populate it.
 */
// 只读缓存。刻意设计成「没有缓存就返回 null 而不是去拉网络」——
// 因为调用它的是渲染路径（同步组件渲染），绝不能在那里阻塞等网络。
// 正确用法：先调用它，拿不到就由调用方触发 refreshOverageCreditGrantCache()。
export function getCachedOverageCreditGrant(): OverageCreditGrantInfo | null {
// 缓存按 organizationUuid 分桶：一台机器可能先后登录多个组织，
// 不能让 A 组织的缓存被 B 组织读到。
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const cached = getGlobalConfig().overageCreditGrantCache?.[orgId]
  if (!cached) return null
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null
  return cached.info
}

/**
 * Drop the current org's cached entry so the next read refetches.
 * Leaves other orgs' entries intact.
 */
// 主动失效：用户刚领了赠金之后调用，让下一次读取重新走网络，
// 否则 UI 会一直显示「可领取」。
export function invalidateOverageCreditGrantCache(): void {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
// `!(orgId in cache)`：in 运算符判断属性是否存在（注意它也会查原型链），
// 这里 cache 是普通对象字面量，安全。Java 等价：map.containsKey(orgId)。
  const cache = getGlobalConfig().overageCreditGrantCache
  if (!cache || !(orgId in cache)) return
  saveGlobalConfig(prev => {
    const next = { ...prev.overageCreditGrantCache }
    delete next[orgId]
    return { ...prev, overageCreditGrantCache: next }
  })
}

/**
 * Fetch and cache grant info. Fire-and-forget; call when an upsell surface
 * is about to render and the cache is empty.
 */
// fire-and-forget 型刷新：调用方不 await，渲染不阻塞。
export async function refreshOverageCreditGrantCache(): Promise<void> {
  if (isEssentialTrafficOnly()) return
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
  const info = await fetchOverageCreditGrant()
  if (!info) return
// ★ 这里是本文件最讲究的地方：即使数据没变化，也仍然要刷新时间戳。
// 为什么？因为 getCachedOverageCreditGrant 是靠时间戳判过期的。
// 如果只写「数据变了才写」，那么数据不变时时间戳永远不更新，
// 1 小时后缓存过期，于是每次组件挂载都会再打一次 API —— 写放大（inc-4552）。
  // Skip rewriting info if grant data is unchanged — avoids config write
  // amplification (inc-4552 pattern). Still refresh the timestamp so the
  // TTL-based staleness check in getCachedOverageCreditGrant doesn't keep
  // re-triggering API calls on every component mount.
  saveGlobalConfig(prev => {
// 必须基于 prev 做判断（而不是外面提前 getGlobalConfig() 的快照）：
// saveGlobalConfig 会在拿到文件锁之后重新读一次磁盘，
// 在这之前可能已经有另一个 CLI 进程写过了。用快照会覆盖掉别人的新值。
    // Derive from prev (lock-fresh) rather than a pre-lock getGlobalConfig()
    // read — saveConfigWithLock re-reads config from disk under the file lock,
    // so another CLI instance may have written between any outer read and lock
    // acquire.
    const prevCached = prev.overageCreditGrantCache?.[orgId]
    const existing = prevCached?.info
// 逐字段比较（而不是整体 isEqual）：这里只关心这 5 个字段，
// 避免因为时间戳之类无关字段导致误判「变了」。
    const dataUnchanged =
      existing &&
      existing.available === info.available &&
      existing.eligible === info.eligible &&
      existing.granted === info.granted &&
      existing.amount_minor_units === info.amount_minor_units &&
      existing.currency === info.currency
// 数据没变 **且** 时间还新鲜 → 直接返回 prev（不写盘，省一次文件锁+落盘）。
    // When data is unchanged and timestamp is still fresh, skip the write entirely
    if (
      dataUnchanged &&
      prevCached &&
      Date.now() - prevCached.timestamp <= CACHE_TTL_MS
    ) {
      return prev
    }
    const entry: CachedGrantEntry = {
// dataUnchanged 时复用 existing 而不是 info：语义上等价，
// 但能保持对象引用稳定，方便下游做引用相等比较。
      info: dataUnchanged ? existing : info,
      timestamp: Date.now(),
    }
    return {
      ...prev,
      overageCreditGrantCache: {
        ...prev.overageCreditGrantCache,
        [orgId]: entry,
      },
    }
  })
}

/**
 * Format the grant amount for display. Returns null if amount isn't available
 * (not eligible, or currency we don't know how to format).
 */
// 格式化金额。返回 null 表示「没法展示」（没金额 / 不认识的币种），
// 调用方应当什么都不渲染，而不是显示 $0。
export function formatGrantAmount(info: OverageCreditGrantInfo): string | null {
// `== null` 宽松相等：一次性排除 null 和 undefined 两种情况。
// 这是本项目里少数刻意使用 `==` 的地方（其余一律 `===`）。
  if (info.amount_minor_units == null || !info.currency) return null
  // For now only USD; backend may expand later
// 目前只支持 USD；别的币种返回 null 让 UI 不显示，
// 比硬套 $ 符号显示错误金额要好。
  if (info.currency.toUpperCase() === 'USD') {
// 分 → 元。整数金额不带小数（$5），非整数保留两位（$5.25）。
// 注意这里用了除法会有浮点，但只用于显示，不参与计算，可以接受。
    const dollars = info.amount_minor_units / 100
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  }
  return null
}

export type { CachedGrantEntry as OverageCreditGrantCacheEntry }
