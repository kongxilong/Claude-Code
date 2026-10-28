/**
 * 【一句话定位】
 * 远程「功能开关 / 特性旗标（feature flag）」服务 GrowthBook 的客户端封装：负责拉开关、缓存、
 * 刷新、A/B 实验分组曝光上报，以及提供一整套不同「新鲜度 vs 阻塞」取舍的读取函数。
 *
 * 【在架构中的位置】
 * 依赖方向（谁用它）：全项目几乎所有需要「线上可调节行为」的地方——
 *   sink.ts（Datadog 开关）、sinkKillswitch.ts（后端熔断）、firstPartyEventLogger.ts（批参数与采样）、
 *   datadog.ts、metadata.ts、以及各种 /config、模型选择、命令缓存等。
 * 它依赖：firstPartyEventLogger.ts（实验曝光上报）、utils/user.js（用户属性）、
 *         utils/config.js（磁盘缓存读写）、第三方 @growthbook/growthbook SDK。
 *
 * 【GrowthBook 是什么（与编译期 feature() 务必区分！）】
 * ┌──────────────┬─────────────────────────┬──────────────────────────────┐
 * │              │ feature('XXX')          │ 本文件 GrowthBook            │
 * ├──────────────┼─────────────────────────┼──────────────────────────────┤
 * │ 生效时机     │ 编译/打包期（#ifdef）    │ 运行期（每次启动拉远端）      │
 * │ 谁能改       │ 只能发新版               │ 服务端改配置，客户端自动生效  │
 * │ 用途         │ 裁剪掉整块代码（减体积） │ A/B 实验、灰度、紧急降级      │
 * │ 值从哪来     │ 构建配置写死             │ 服务端按用户属性下发          │
 * └──────────────┴─────────────────────────┴──────────────────────────────┘
 * 所以：看到 `feature('X') ? require(...) : null` 那是编译期裁剪；
 * 看到 `getFeatureValue_CACHED_MAY_BE_STALE('tengu_xxx', false)` 那是运行期开关。两者完全不同。
 * Java 类比：feature() ≈ Maven profile + 条件编译；GrowthBook ≈ LaunchDarkly / FF4J / Apollo 配置中心。
 *
 * 【为什么读取函数有那么多个（核心设计）】
 * 客户端读开关有个根本矛盾：启动时就要用（不能等网络），但值又要新（不能太旧）。
 * 于是这里提供了一组「新鲜度 vs 阻塞」不同取舍的函数：
 *   - _CACHED_MAY_BE_STALE：同步、立刻返回、可能过期（【首选】，启动关键路径用）
 *   - _BLOCKS_ON_INIT / _DEPRECATED：await 等初始化完，最新但慢（启动路径别用）
 *   - checkGate_CACHED_OR_BLOCKING：缓存说 true 就信，说 false 才去查（权限类开关用）
 *   - checkSecurityRestrictionGate：等重新初始化完成（安全类开关用，宁可慢也要准）
 * 缓存三层：内存（remoteEvalFeatureValues）> 磁盘（~/.claude.json）> 默认值。
 *
 * 【本文件包含什么】
 * - type GrowthBookUserAttributes：发给服务端的用户属性（用于定向投放）。
 * - client / currentBeforeExitHandler / currentExitHandler / clientCreatedWithAuth：客户端与生命周期状态。
 * - experimentDataByFeature / remoteEvalFeatureValues / pendingExposures / loggedExposures：四张缓存表。
 * - refreshed（信号）+ onGrowthBookRefresh()：配置刷新时的订阅通知机制。
 * - getEnvOverrides() / hasGrowthBookEnvOverride() / getConfigOverrides()：本地覆盖（测试/内部用）。
 * - getAllGrowthBookFeatures() / getGrowthBookConfigOverrides() / setGrowthBookConfigOverride()：/config 面板用。
 * - logExposureForFeature()：实验曝光上报（每会话去重）。
 * - processRemoteEvalPayload() / syncRemoteEvalToDisk()：解析服务端响应并落盘。
 * - getApiBaseUrlHost() / getUserAttributes()：构造用户属性。
 * - getGrowthBookClient() / initializeGrowthBook()：创建与初始化客户端。
 * - getFeatureValueInternal() 及其四个公开包装。
 * - checkStatsigFeatureGate_* / checkSecurityRestrictionGate() / checkGate_CACHED_OR_BLOCKING()。
 * - refreshGrowthBookAfterAuthChange() / refreshGrowthBookFeatures() / resetGrowthBook()。
 * - setupPeriodicGrowthBookRefresh() / stopPeriodicGrowthBookRefresh()：定时刷新。
 * - getDynamicConfig_*：语义化包装（本质就是 feature，兼容旧 Statsig API 命名）。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `memoize((...) => {...})`：lodash 的「只算一次」包装器。
 *   ≈ Java 的懒加载单例。注意 `getGrowthBookClient.cache?.clear?.()` 是清掉 memoize 的缓存，
 *   两处 `?.` 分别防止「没有 cache 属性」和「clear 不是函数」。
 * - `export const initializeGrowthBook = memoize(async (): Promise<GrowthBook|null> => {...})`：
 *   导出一个「被 memoize 包装过的 async 函数」——调用方写 `await initializeGrowthBook()`。
 * - `platform: 'win32' | 'darwin' | 'linux'`：字面量联合类型 ≈ Java enum，写错编译报错。
 * - `type MalformedFeatureDefinition = { value?: unknown; defaultValue?: unknown; [key: string]: unknown }`：
 *   两个已知可选字段 + 索引签名兜底（服务端还可能返回别的字段）。
 * - `const { [feature]: _, ...rest } = current`：【动态键名 + rest 解构】剔除某个键。
 *   方括号里放变量表示「要删的键名由变量决定」；`_` 是「这个变量不用」的惯例命名。
 *   Java 里要写 `Map<String,Object> rest = new HashMap<>(current); rest.remove(feature);`。
 * - `{ ...c, growthBookOverrides: { ...current, [feature]: value } }`：
 *   `[feature]` 是计算属性名（键名由变量决定）。≈ Java 的 `map.put(feature, value)`。
 * - `isEqual(a, b)`：lodash 深比较。≈ Java 的 Objects.deepEquals 或 EqualsBuilder。
 * - `Object.fromEntries(map)`：Map → 普通对象。≈ Java 里手工 `map.forEach(newMap::put)`。
 * - `for (const [key, feature] of Object.entries(payload.features))`：遍历对象键值对并解构。
 * - `'value' in f && !('defaultValue' in f)`：`in` 判断属性【是否存在】（包括值为 undefined 的情况）。
 *   和 `f.value !== undefined` 不同：后者无法区分「没有这个键」和「有键但值是 undefined」。
 * - `createSignal()`：项目自己的「发布-订阅」信号工具。≈ Java 的 List<Listener> + 手动触发，
 *   也类似 Guava EventBus，但只有一种事件。
 * - `void Promise.resolve(listener()).catch(...)`：
 *   Promise.resolve 把「同步返回值」和「Promise」统一成 Promise，这样同步抛错和异步 reject 都能被捕获。
 *   不加 .catch 的话异步失败会变成 unhandled rejection。这是 JS 异步容错的标准写法。
 * - `queueMicrotask(() => {...})`：放进微任务队列，当前同步代码跑完立刻执行。
 * - `process.on('beforeExit', h)` / `process.off('beforeExit', h)`：注册/注销进程退出钩子。
 *   命名成变量存起来是为了能精确 off 掉——匿名函数无法解绑，会不断累积（内存泄漏）。
 * - `refreshInterval.unref?.()`：`.unref()` 让定时器不阻止进程退出；`?.` 防浏览器环境没有这个方法。
 * - `process.env.USER_TYPE === 'ant'`：内部员工判定，全文件大量出现——只有内部员工才打详细日志/能用覆盖配置。
 * - `catch { return undefined }`：可选 catch 绑定，吞掉异常并降级。
 * - `async function f<T>(...): Promise<T>`：泛型异步函数，泛型写在函数名后。
 * - `overrides[feature] as T`：索引访问 + 类型断言。因为 Record<string, unknown> 的值是 unknown，
 *   必须 as 成调用方期望的 T。≈ Java 的 `(T) map.get(k)`。
 * - `export type`（类型导出）与 `export function`（值导出）混用：
 *   一个模块可以同时导出类型和函数，import 时用 `import { X }` 或 `import type { X }`。
 * - `@deprecated` JSDoc 标签：和 Java 的 @Deprecated 注解作用相同（IDE 会划掉）。
 */
import { GrowthBook } from '@growthbook/growthbook'
import { isEqual, memoize } from 'lodash-es'
import {
  getIsNonInteractiveSession,
  getSessionTrustAccepted,
} from '../../bootstrap/state.js'
import { getGrowthBookClientKey } from '../../constants/keys.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { createSignal } from '../../utils/signal.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type GitHubActionsMetadata,
  getUserForGrowthBook,
} from '../../utils/user.js'
import {
  is1PEventLoggingEnabled,
  logGrowthBookExperimentTo1P,
} from './firstPartyEventLogger.js'

/**
 * User attributes sent to GrowthBook for targeting.
 * Uses UUID suffix (not Uuid) to align with GrowthBook conventions.
 */
// 中文补充：这些属性会发给 GrowthBook 服务端，用于「定向投放」——
// 比如「只对 Pro 订阅用户开放」「只在 macOS 上灰度 10%」。
// 所以这里能放什么字段，直接决定了以后能做多精细的实验。
export type GrowthBookUserAttributes = {
  id: string
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  organizationUUID?: string
  accountUUID?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}

/**
 * Malformed feature response from API that uses "value" instead of "defaultValue".
 * This is a workaround until the API is fixed.
 */
// 兼容服务端的不规范响应：它返回 { value: ... } 而 SDK 期待 { defaultValue: ... }。
// 索引签名 [key: string]: unknown 表示「除此之外还可能有别的字段，我们不关心」。
type MalformedFeatureDefinition = {
  value?: unknown
  defaultValue?: unknown
  [key: string]: unknown
}

// 全局唯一的 GrowthBook 客户端实例（模块级单例）。
let client: GrowthBook | null = null

// Named handler refs so resetGrowthBook can remove them to prevent accumulation
// 把退出钩子存成具名变量：匿名函数无法用 process.off 解绑，反复创建客户端会不断累积监听器。
let currentBeforeExitHandler: (() => void) | null = null
let currentExitHandler: (() => void) | null = null

// Track whether auth was available when the client was created
// This allows us to detect when we need to recreate with fresh auth headers
// 记住「建客户端时有没有凭证」：登录后凭证才可用，那时需要销毁重建客户端（因为鉴权头建好就不能改）。
let clientCreatedWithAuth = false

// Store experiment data from payload for logging exposures later
type StoredExperimentData = {
  experimentId: string
  variationId: number
  inExperiment?: boolean
  hashAttribute?: string
  hashValue?: string
}
// feature 名 → 实验信息。用于后续上报「这个用户被分到了哪个实验组」。
const experimentDataByFeature = new Map<string, StoredExperimentData>()

// Cache for remote eval feature values - workaround for SDK not respecting remoteEval response
// The SDK's setForcedFeatures also doesn't work reliably with remoteEval
// 远程求值结果的内存缓存（服务端 remoteEval 已经算好每个用户的值，本地直接用）。
const remoteEvalFeatureValues = new Map<string, unknown>()

// Track features accessed before init that need exposure logging
// 初始化完成之前就被读取的 feature：先记下来，等初始化好了再补报曝光。
const pendingExposures = new Set<string>()

// Track features that have already had their exposure logged this session (dedup)
// This prevents firing duplicate exposure events when getFeatureValue_CACHED_MAY_BE_STALE
// is called repeatedly in hot paths (e.g., isAutoMemoryEnabled in render loops)
// 曝光去重：同一个会话里每个 feature 只上报一次曝光。
// 为什么必须去重：_CACHED_MAY_BE_STALE 会被放在渲染循环之类的热路径上高频调用，
// 不去重的话一个会话能刷出几万条曝光事件。
const loggedExposures = new Set<string>()

// Track re-initialization promise for security gate checks
// When GrowthBook is re-initializing (e.g., after auth change), security gate checks
// should wait for init to complete to avoid returning stale values
// 重新初始化（比如登录后）进行中的 Promise。安全类开关会等它完成，避免读到旧账号的值。
let reinitializingPromise: Promise<unknown> | null = null

// Listeners notified when GrowthBook feature values refresh (initial init or
// periodic refresh). Use for systems that bake feature values into long-lived
// objects at construction time (e.g. firstPartyEventLogger reads
// tengu_1p_event_batch_config once and builds a LoggerProvider with it) and
// need to rebuild when config changes. Per-call readers like
// getEventSamplingConfig / isSinkKilled don't need this — they're already
// reactive.
//
// NOT cleared by resetGrowthBook — subscribers register once (typically in
// init.ts) and must survive auth-change resets.
// 刷新通知机制。为什么需要：有些模块在【构造时】就把开关值固化进长生命周期对象了
//（比如 firstPartyEventLogger 建 LoggerProvider 时读一次批参数），光靠每次调用时重读没用，
// 必须主动通知它们「配置变了，重建一下」。
// 注意：resetGrowthBook 【不】清它——订阅者通常只注册一次，要能跨越「登录导致的重置」继续有效。
type GrowthBookRefreshListener = () => void | Promise<void>
const refreshed = createSignal()

/** Call a listener with sync-throw and async-rejection both routed to logError. */
// 统一捕获「同步抛错」和「异步 reject」两种失败，避免异步监听器变成 unhandled rejection。
function callSafe(listener: GrowthBookRefreshListener): void {
  try {
    // Promise.resolve() normalizes sync returns and Promises so both
    // sync throws (caught by outer try) and async rejections (caught
    // by .catch) hit logError. Without the .catch, an async listener
    // that rejects becomes an unhandled rejection — the try/catch
    // only sees the Promise, not its eventual rejection.
// Promise.resolve(x) 把任意返回值归一成 Promise，再 .catch 兜住异步失败；
// 外层 try/catch 兜住同步抛错。两者缺一不可。
    void Promise.resolve(listener()).catch(e => {
      logError(e)
    })
  } catch (e) {
    logError(e)
  }
}

/**
 * Register a callback to fire when GrowthBook feature values refresh.
 * Returns an unsubscribe function.
 *
 * If init has already completed with features by the time this is called
 * (remoteEvalFeatureValues is populated), the listener fires once on the
 * next microtask. This catch-up handles the race where GB's network response
 * lands before the REPL's useEffect commits — on external builds with fast
 * networks and MCP-heavy configs, init can finish in ~100ms while REPL mount
 * takes ~600ms (see #20951 external-build trace at 30.540 vs 31.046).
 *
 * Change detection is on the subscriber: the callback fires on every refresh;
 * use isEqual against your last-seen config to decide whether to act.
 */
// 注册「配置刷新」监听器，返回取消订阅函数。
// 为什么要「补发一次」（下面的 queueMicrotask）：存在竞态——
// 网络快的时候 GrowthBook 可能在 UI 挂载之前就初始化完了，
// 那时监听器还没注册，就永远收不到这次通知。补发一次把这个洞堵上。
// 注意补发前要重新检查（微任务执行期间可能已经取消订阅或已被 reset）。
export function onGrowthBookRefresh(
  listener: GrowthBookRefreshListener,
): () => void {
  let subscribed = true
  const unsubscribe = refreshed.subscribe(() => callSafe(listener))
  if (remoteEvalFeatureValues.size > 0) {
    queueMicrotask(() => {
      // Re-check: listener may have been removed, or resetGrowthBook may have
      // cleared the Map, between registration and this microtask running.
      if (subscribed && remoteEvalFeatureValues.size > 0) {
        callSafe(listener)
      }
    })
  }
  return () => {
    subscribed = false
    unsubscribe()
  }
}

/**
 * Parse env var overrides for GrowthBook features.
 * Set CLAUDE_INTERNAL_FC_OVERRIDES to a JSON object mapping feature keys to values
 * to bypass remote eval and disk cache. Useful for eval harnesses that need to
 * test specific feature flag configurations. Only active when USER_TYPE is 'ant'.
 *
 * Example: CLAUDE_INTERNAL_FC_OVERRIDES='{"my_feature": true, "my_config": {"key": "val"}}'
 */
let envOverrides: Record<string, unknown> | null = null
let envOverridesParsed = false

// 读环境变量覆盖（仅内部员工）：让评测/测试能强制指定某些开关的值，不依赖服务端。
function getEnvOverrides(): Record<string, unknown> | null {
  if (!envOverridesParsed) {
    envOverridesParsed = true
// 只有 ant（内部员工）能用覆盖——普通用户不该有能力改自己的开关值。
    if (process.env.USER_TYPE === 'ant') {
      const raw = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
      if (raw) {
        try {
          envOverrides = JSON.parse(raw) as Record<string, unknown>
          logForDebugging(
            `GrowthBook: Using env var overrides for ${Object.keys(envOverrides!).length} features: ${Object.keys(envOverrides!).join(', ')}`,
          )
        } catch {
          logError(
            new Error(
              `GrowthBook: Failed to parse CLAUDE_INTERNAL_FC_OVERRIDES: ${raw}`,
            ),
          )
        }
      }
    }
  }
  return envOverrides
}

/**
 * Check if a feature has an env-var override (CLAUDE_INTERNAL_FC_OVERRIDES).
 * When true, _CACHED_MAY_BE_STALE will return the override without touching
 * disk or network — callers can skip awaiting init for that feature.
 */
// 判断某个 feature 是否有本地覆盖。调用方据此可以跳过 await 初始化（直接读覆盖值）。
export function hasGrowthBookEnvOverride(feature: string): boolean {
  const overrides = getEnvOverrides()
  return overrides !== null && feature in overrides
}

/**
 * Local config overrides set via /config Gates tab (ant-only). Checked after
 * env-var overrides — env wins so eval harnesses remain deterministic. Unlike
 * getEnvOverrides this is not memoized: the user can change overrides at
 * runtime, and getGlobalConfig() is already memory-cached (pointer-chase)
 * until the next saveGlobalConfig() invalidates it.
 */
// 从全局配置读覆盖（/config 面板里设置的）。刻意【不做 memoize】：
// 用户可能随时改，而 getGlobalConfig() 本身已经有内存缓存了。
function getConfigOverrides(): Record<string, unknown> | undefined {
  if (process.env.USER_TYPE !== 'ant') return undefined
  try {
    return getGlobalConfig().growthBookOverrides
  } catch {
    // getGlobalConfig() throws before configReadingAllowed is set (early
    // main.tsx startup path). Same degrade as the disk-cache fallback below.
    return undefined
  }
}

/**
 * Enumerate all known GrowthBook features and their current resolved values
 * (not including overrides). In-memory payload first, disk cache fallback —
 * same priority as the getters. Used by the /config Gates tab.
 */
// 列出所有开关及其当前值（/config 面板用）。优先级：内存 > 磁盘缓存。
export function getAllGrowthBookFeatures(): Record<string, unknown> {
  if (remoteEvalFeatureValues.size > 0) {
    return Object.fromEntries(remoteEvalFeatureValues)
  }
  return getGlobalConfig().cachedGrowthBookFeatures ?? {}
}

export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return getConfigOverrides() ?? {}
}

/**
 * Set or clear a single config override. Pass undefined to clear.
 * Fires onGrowthBookRefresh listeners so systems that bake gate values into
 * long-lived objects (useMainLoopModel, useSkillsChange, etc.) rebuild —
 * otherwise overriding e.g. tengu_ant_model_override wouldn't actually
 * change the model until the next periodic refresh.
 */
// 设置/清除单个覆盖值（value 传 undefined 表示清除）。
// 写完要 refreshed.emit()：否则那些「构造时固化了值」的模块不会重建，改了也不生效。
export function setGrowthBookConfigOverride(
  feature: string,
  value: unknown,
): void {
  if (process.env.USER_TYPE !== 'ant') return
  try {
    saveGlobalConfig(c => {
      const current = c.growthBookOverrides ?? {}
      if (value === undefined) {
        if (!(feature in current)) return c
// 动态键名 + rest 解构删除某个键：`const { [feature]: _, ...rest } = current`。
// 如果删完为空，连 growthBookOverrides 这个字段本身也一起删掉（保持配置干净）。
        const { [feature]: _, ...rest } = current
        if (Object.keys(rest).length === 0) {
          const { growthBookOverrides: __, ...configWithout } = c
          return configWithout
        }
        return { ...c, growthBookOverrides: rest }
      }
// 值没变就返回原对象（同一引用），saveGlobalConfig 据此判断「无需落盘」。
      if (isEqual(current[feature], value)) return c
      return { ...c, growthBookOverrides: { ...current, [feature]: value } }
    })
    // Subscribers do their own change detection (see onGrowthBookRefresh docs),
    // so firing on a no-op write is fine.
    refreshed.emit()
  } catch (e) {
    logError(e)
  }
}

export function clearGrowthBookConfigOverrides(): void {
  if (process.env.USER_TYPE !== 'ant') return
  try {
    saveGlobalConfig(c => {
      if (
        !c.growthBookOverrides ||
        Object.keys(c.growthBookOverrides).length === 0
      ) {
        return c
      }
      const { growthBookOverrides: _, ...rest } = c
      return rest
    })
    refreshed.emit()
  } catch (e) {
    logError(e)
  }
}

/**
 * Log experiment exposure for a feature if it has experiment data.
 * Deduplicates within a session - each feature is logged at most once.
 */
// 上报一次 A/B 实验曝光，每个 feature 每会话只报一次（去重）。
function logExposureForFeature(feature: string): void {
  // Skip if already logged this session (dedup)
  if (loggedExposures.has(feature)) {
    return
  }

  const expData = experimentDataByFeature.get(feature)
  if (expData) {
    loggedExposures.add(feature)
    logGrowthBookExperimentTo1P({
      experimentId: expData.experimentId,
      variationId: expData.variationId,
      userAttributes: getUserAttributes(),
      experimentMetadata: {
        feature_id: feature,
      },
    })
  }
}

/**
 * Process a remote eval payload from the GrowthBook server and populate
 * local caches. Called after both initial client.init() and after
 * client.refreshFeatures() so that _BLOCKS_ON_INIT callers see fresh values
 * across the process lifetime, not just init-time snapshots.
 *
 * Without this running on refresh, remoteEvalFeatureValues freezes at its
 * init-time snapshot and getDynamicConfig_BLOCKS_ON_INIT returns stale values
 * for the entire process lifetime — which broke the tengu_max_version_config
 * kill switch for long-running sessions.
 */
// 解析服务端 remoteEval 响应，填充本地缓存。init 和 refreshFeatures 之后都要调，
// 否则内存缓存会永远停在「初始化那一刻」的快照上（英文注释说这曾导致长会话里的
// 降级开关失效）。
// 关键步骤：
// ① 空响应直接返回 false（防止把空 {} 写进磁盘造成全量开关失效）
// ② 清空实验表（避免已下线的实验留下幽灵条目）
// ③ 修正 value → defaultValue 的格式差异
// ④ 抽出实验信息存起来（供曝光上报）
// ⑤ 重建 remoteEvalFeatureValues 内存缓存
async function processRemoteEvalPayload(
  gbClient: GrowthBook,
): Promise<boolean> {
  // WORKAROUND: Transform remote eval response format
  // The API returns { "value": ... } but SDK expects { "defaultValue": ... }
  // TODO: Remove this once the API is fixed to return correct format
  const payload = gbClient.getPayload()
  // Empty object is truthy — without the length check, `{features: {}}`
  // (transient server bug, truncated response) would pass, clear the maps
  // below, return true, and syncRemoteEvalToDisk would wholesale-write `{}`
  // to disk: total flag blackout for every process sharing ~/.claude.json.
// 这个检查极其重要：空对象 {} 是「真值」，如果只写 `if (!payload?.features)`，
// 服务端返回 `{features: {}}`（截断的坏响应）会一路放行，最终把空表写进磁盘——
// 所有进程的所有开关全部失效（灾难级故障）。所以必须额外检查键的数量。
  if (!payload?.features || Object.keys(payload.features).length === 0) {
    return false
  }

  // Clear before rebuild so features removed between refreshes don't
  // leave stale ghost entries that short-circuit getFeatureValueInternal.
  experimentDataByFeature.clear()

  const transformedFeatures: Record<string, MalformedFeatureDefinition> = {}
  for (const [key, feature] of Object.entries(payload.features)) {
    const f = feature as MalformedFeatureDefinition
// 用 `in` 而不是 `!== undefined`：要区分「没有这个键」和「有键但值是 undefined」。
    if ('value' in f && !('defaultValue' in f)) {
      transformedFeatures[key] = {
        ...f,
        defaultValue: f.value,
      }
    } else {
      transformedFeatures[key] = f
    }

    // Store experiment data for later logging when feature is accessed
    if (f.source === 'experiment' && f.experimentResult) {
      const expResult = f.experimentResult as {
        variationId?: number
      }
      const exp = f.experiment as { key?: string } | undefined
      if (exp?.key && expResult.variationId !== undefined) {
        experimentDataByFeature.set(key, {
          experimentId: exp.key,
          variationId: expResult.variationId,
        })
      }
    }
  }
  // Re-set the payload with transformed features
  await gbClient.setPayload({
    ...payload,
    features: transformedFeatures,
  })

  // WORKAROUND: Cache the evaluated values directly from remote eval response.
  // The SDK's evalFeature() tries to re-evaluate rules locally, ignoring the
  // pre-evaluated 'value' from remoteEval. setForcedFeatures also doesn't work
  // reliably. So we cache values ourselves and use them in getFeatureValueInternal.
  remoteEvalFeatureValues.clear()
  for (const [key, feature] of Object.entries(transformedFeatures)) {
    // Under remoteEval:true the server pre-evaluates. Whether the answer
    // lands in `value` (current API) or `defaultValue` (post-TODO API shape),
    // it's the authoritative value for this user. Guarding on both keeps
    // syncRemoteEvalToDisk correct across a partial or full API migration.
// 同时认 value 和 defaultValue：服务端正在迁移字段格式，两种都要兼容。
    const v = 'value' in feature ? feature.value : feature.defaultValue
    if (v !== undefined) {
      remoteEvalFeatureValues.set(key, v)
    }
  }
  return true
}

/**
 * Write the complete remoteEvalFeatureValues map to disk. Called exactly
 * once per successful processRemoteEvalPayload — never from a failure path,
 * so init-timeout poisoning is structurally impossible (the .catch() at init
 * never reaches here).
 *
 * Wholesale replace (not merge): features deleted server-side are dropped
 * from disk on the next successful payload. Ant builds ⊇ external, so
 * switching builds is safe — the write is always a complete answer for this
 * process's SDK key.
 */
// 把内存缓存【整体覆盖】写进磁盘（不是合并），这样服务端删掉的开关也会从磁盘消失。
// 只在「成功解析到响应」时调用，绝不从失败路径调——避免把坏数据写进磁盘。
function syncRemoteEvalToDisk(): void {
  const fresh = Object.fromEntries(remoteEvalFeatureValues)
  const config = getGlobalConfig()
// 内容相同就不写（省一次磁盘 IO + 不惊动文件监听）。
  if (isEqual(config.cachedGrowthBookFeatures, fresh)) {
    return
  }
  saveGlobalConfig(current => ({
    ...current,
    cachedGrowthBookFeatures: fresh,
  }))
}

/**
 * Check if GrowthBook operations should be enabled
 */
// 开关服务是否启用：直接复用一方埋点的总闸（两者命运绑定——
// 因为实验曝光要靠一方埋点上报，埋点关了实验也就没意义了）。
function isGrowthBookEnabled(): boolean {
  // GrowthBook depends on 1P event logging.
  return is1PEventLoggingEnabled()
}

/**
 * Hostname of ANTHROPIC_BASE_URL when it points at a non-Anthropic proxy.
 *
 * Enterprise-proxy deployments (Epic, Marble, etc.) typically use
 * apiKeyHelper auth, which means isAnthropicAuthEnabled() returns false and
 * organizationUUID/accountUUID/email are all absent from GrowthBook
 * attributes. Without this, there's no stable attribute to target them on
 * — only per-device IDs. See src/utils/auth.ts isAnthropicAuthEnabled().
 *
 * Returns undefined for unset/default (api.anthropic.com) so the attribute
 * is absent for direct-API users. Hostname only — no path/query/creds.
 */
// 取 ANTHROPIC_BASE_URL 的主机名（仅当它指向非官方代理时）。
// 为什么需要：企业代理部署没有账号/组织信息，只有这个主机名能作为稳定定向依据。
// 只取主机名（不带路径/查询串/凭证）——避免把密钥写进埋点属性。
export function getApiBaseUrlHost(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).host
    if (host === 'api.anthropic.com') return undefined
    return host
  } catch {
    return undefined
  }
}

/**
 * Get user attributes for GrowthBook from CoreUserData
 */
// 组装用户属性。大量使用 `...(x && { k: x })` 条件展开：
// 值为空时这个字段【完全不出现】，而不是出现一个 undefined——服务端定向规则更好写。
function getUserAttributes(): GrowthBookUserAttributes {
  const user = getUserForGrowthBook()

  // For ants, always try to include email from OAuth config even if ANTHROPIC_API_KEY is set.
  // This ensures GrowthBook targeting by email works regardless of auth method.
  let email = user.email
  if (!email && process.env.USER_TYPE === 'ant') {
    email = getGlobalConfig().oauthAccount?.emailAddress
  }

  const apiBaseUrlHost = getApiBaseUrlHost()

  const attributes = {
    id: user.deviceId,
    sessionId: user.sessionId,
    deviceID: user.deviceId,
    platform: user.platform,
    ...(apiBaseUrlHost && { apiBaseUrlHost }),
    ...(user.organizationUuid && { organizationUUID: user.organizationUuid }),
    ...(user.accountUuid && { accountUUID: user.accountUuid }),
    ...(user.userType && { userType: user.userType }),
    ...(user.subscriptionType && { subscriptionType: user.subscriptionType }),
    ...(user.rateLimitTier && { rateLimitTier: user.rateLimitTier }),
    ...(user.firstTokenTime && { firstTokenTime: user.firstTokenTime }),
    ...(email && { email }),
    ...(user.appVersion && { appVersion: user.appVersion }),
    ...(user.githubActionsMetadata && {
      githubActionsMetadata: user.githubActionsMetadata,
    }),
  }
  return attributes
}

/**
 * Get or create the GrowthBook client instance
 */
// 创建客户端（memoize 保证只建一次）。
// 返回 null 表示「本环境不启用开关服务」，调用方按默认值处理。
const getGrowthBookClient = memoize(
  (): { client: GrowthBook; initialized: Promise<void> } | null => {
    if (!isGrowthBookEnabled()) {
      return null
    }

    const attributes = getUserAttributes()
    const clientKey = getGrowthBookClientKey()
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `GrowthBook: Creating client with clientKey=${clientKey}, attributes: ${jsonStringify(attributes)}`,
      )
    }
    const baseUrl =
      process.env.USER_TYPE === 'ant'
        ? process.env.CLAUDE_CODE_GB_BASE_URL || 'https://api.anthropic.com/'
        : 'https://api.anthropic.com/'

// 未建立信任就不取凭证：取凭证可能要执行用户配置的 apiKeyHelper 外部命令，
// 在未信任的目录里执行是安全问题。非交互会话视为已信任（没有交互式对话框）。
    // Skip auth if trust hasn't been established yet
    // This prevents executing apiKeyHelper commands before the trust dialog
    // Non-interactive sessions implicitly have workspace trust
    // getSessionTrustAccepted() covers the case where the TrustDialog auto-resolved
    // without persisting trust for the specific CWD (e.g., home directory) —
    // showSetupScreens() sets this after the trust dialog flow completes.
    const hasTrust =
      checkHasTrustDialogAccepted() ||
      getSessionTrustAccepted() ||
      getIsNonInteractiveSession()
    const authHeaders = hasTrust
      ? getAuthHeaders()
      : { headers: {}, error: 'trust not established' }
    const hasAuth = !authHeaders.error
    clientCreatedWithAuth = hasAuth

// 把新客户端存进局部变量 thisClient：异步回调里用它来比对「我还是不是当前客户端」，
// 防止旧的异步初始化结果覆盖新客户端的状态（竞态防护，下面会反复看到这个模式）。
    // Capture in local variable so the init callback operates on THIS client,
    // not a later client if reinitialization happens before init completes
    const thisClient = new GrowthBook({
      apiHost: baseUrl,
      clientKey,
      attributes,
// remoteEval: true = 让服务端直接算好每个用户的值（客户端只拿结果）。
// 好处：不用把用户分桶规则下发到客户端，规则保密性更好、客户端逻辑更简单。
      remoteEval: true,
      // Re-fetch when user ID or org changes (org change = login to different org)
// 缓存键：用户 ID 或组织变了就重新拉（换账号登录的情况）。
      cacheKeyAttributes: ['id', 'organizationUUID'],
      // Add auth headers if available
      ...(authHeaders.error
        ? {}
        : { apiHostRequestHeaders: authHeaders.headers }),
      // Debug logging for Ants
      ...(process.env.USER_TYPE === 'ant'
        ? {
            log: (msg: string, ctx: Record<string, unknown>) => {
              logForDebugging(`GrowthBook: ${msg} ${jsonStringify(ctx)}`)
            },
          }
        : {}),
    })
    client = thisClient

// 没有凭证时跳过网络初始化，先用磁盘缓存顶着；等登录后会有一次重置重建。
    if (!hasAuth) {
      // No auth available yet — skip HTTP init, rely on disk-cached values.
      // initializeGrowthBook() will reset and re-create with auth when available.
      return { client: thisClient, initialized: Promise.resolve() }
    }

// init 加 5 秒超时：绝不能让远端服务拖住 CLI 启动。
    const initialized = thisClient
      .init({ timeout: 5000 })
      .then(async result => {
        // Guard: if this client was replaced by a newer one, skip processing
// 竞态防护第一处：如果这个客户端已经被新的取代了，直接跳过后续处理。
        if (client !== thisClient) {
          if (process.env.USER_TYPE === 'ant') {
            logForDebugging(
              'GrowthBook: Skipping init callback for replaced client',
            )
          }
          return
        }

        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            `GrowthBook initialized successfully, source: ${result.source}, success: ${result.success}`,
          )
        }

// 竞态防护第二处：processRemoteEvalPayload 内部有 await，期间客户端可能已被替换，
// 所以 await 之后必须【再查一次】。这是 async 代码的经典陷阱。
        const hadFeatures = await processRemoteEvalPayload(thisClient)
        // Re-check: processRemoteEvalPayload yields at `await setPayload`.
        // Microtask-only today (no encryption, no sticky-bucket service), but
        // the guard at the top of this callback runs before that await;
        // this runs after.
        if (client !== thisClient) return

        if (hadFeatures) {
// 补报「初始化完成前就被读取过」的那些 feature 的曝光。
          for (const feature of pendingExposures) {
            logExposureForFeature(feature)
          }
          pendingExposures.clear()
// 落盘 + 通知订阅者（顺序：先落盘再通知，保证订阅者读到的磁盘是新值）。
          syncRemoteEvalToDisk()
          // Notify subscribers: remoteEvalFeatureValues is populated and
          // disk is freshly synced. _CACHED_MAY_BE_STALE reads memory first
          // (#22295), so subscribers see fresh values immediately.
          refreshed.emit()
        }

        // Log what features were loaded
        if (process.env.USER_TYPE === 'ant') {
          const features = thisClient.getFeatures()
          if (features) {
            const featureKeys = Object.keys(features)
            logForDebugging(
              `GrowthBook loaded ${featureKeys.length} features: ${featureKeys.slice(0, 10).join(', ')}${featureKeys.length > 10 ? '...' : ''}`,
            )
          }
        }
      })
      .catch(error => {
        if (process.env.USER_TYPE === 'ant') {
          logError(toError(error))
        }
      })

// 注册退出钩子，进程结束时销毁客户端（释放定时器和连接池）。
    // Register cleanup handlers for graceful shutdown (named refs so resetGrowthBook can remove them)
    currentBeforeExitHandler = () => client?.destroy()
    currentExitHandler = () => client?.destroy()
    process.on('beforeExit', currentBeforeExitHandler)
    process.on('exit', currentExitHandler)

    return { client: thisClient, initialized }
  },
)

/**
 * Initialize GrowthBook client (blocks until ready)
 */
// 初始化入口（阻塞直到就绪）。
// 额外职责：如果「建客户端时没凭证、现在有凭证了」，就重置重建——
// 因为 GrowthBook 的鉴权头建好之后无法修改。
export const initializeGrowthBook = memoize(
  async (): Promise<GrowthBook | null> => {
    let clientWrapper = getGrowthBookClient()
    if (!clientWrapper) {
      return null
    }

    // Check if auth has become available since the client was created
    // If so, we need to recreate the client with fresh auth headers
    // Only check if trust is established to avoid triggering apiKeyHelper before trust dialog
// 建客户端时没凭证 → 检查现在是不是有了（用户刚登录完）。
    if (!clientCreatedWithAuth) {
      const hasTrust =
        checkHasTrustDialogAccepted() ||
        getSessionTrustAccepted() ||
        getIsNonInteractiveSession()
      if (hasTrust) {
        const currentAuth = getAuthHeaders()
        if (!currentAuth.error) {
          if (process.env.USER_TYPE === 'ant') {
            logForDebugging(
              'GrowthBook: Auth became available after client creation, reinitializing',
            )
          }
          // Use resetGrowthBook to properly destroy old client and stop periodic refresh
          // This prevents double-init where old client's init promise continues running
// 用 resetGrowthBook 而不是直接重建：它会销毁旧客户端、停掉定时刷新，
// 否则会出现「新旧两个客户端同时初始化」的双跑问题。
          resetGrowthBook()
          clientWrapper = getGrowthBookClient()
          if (!clientWrapper) {
            return null
          }
        }
      }
    }

    await clientWrapper.initialized

    // Set up periodic refresh after successful initialization
    // This is called here (not separately) so it's always re-established after any reinit
    setupPeriodicGrowthBookRefresh()

    return clientWrapper.client
  },
)

/**
 * Get a feature value with a default fallback - blocks until initialized.
 * @internal Used by both deprecated and cached functions.
 */
// 读取开关的通用实现（阻塞版）。优先级：
// 环境变量覆盖 > 配置覆盖 > （未启用则默认值）> 内存缓存 > 本地实时求值
// @param logExposure 是否上报实验曝光（A/B 实验需要，普通开关不需要）
async function getFeatureValueInternal<T>(
  feature: string,
  defaultValue: T,
  logExposure: boolean,
): Promise<T> {
  // Check env var overrides first (for eval harnesses)
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) {
    return overrides[feature] as T
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  if (!isGrowthBookEnabled()) {
    return defaultValue
  }

  const growthBookClient = await initializeGrowthBook()
  if (!growthBookClient) {
    return defaultValue
  }

  // Use cached remote eval values if available (workaround for SDK bug)
  let result: T
// 优先用服务端 remoteEval 算好的值（本地 SDK 的 evalFeature 在 remoteEval 模式下不可靠，见英文注释）。
  if (remoteEvalFeatureValues.has(feature)) {
    result = remoteEvalFeatureValues.get(feature) as T
  } else {
    result = growthBookClient.getFeatureValue(feature, defaultValue) as T
  }

  // Log experiment exposure using stored experiment data
  if (logExposure) {
    logExposureForFeature(feature)
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `GrowthBook: getFeatureValue("${feature}") = ${jsonStringify(result)}`,
    )
  }
  return result
}

/**
 * @deprecated Use getFeatureValue_CACHED_MAY_BE_STALE instead, which is non-blocking.
 * This function blocks on GrowthBook initialization which can slow down startup.
 */
// 已废弃：它会 await 初始化，拖慢启动。新代码请用 _CACHED_MAY_BE_STALE。
export async function getFeatureValue_DEPRECATED<T>(
  feature: string,
  defaultValue: T,
): Promise<T> {
  return getFeatureValueInternal(feature, defaultValue, true)
}

/**
 * Get a feature value from disk cache immediately. Pure read — disk is
 * populated by syncRemoteEvalToDisk on every successful payload (init +
 * periodic refresh), not by this function.
 *
 * This is the preferred method for startup-critical paths and sync contexts.
 * The value may be stale if the cache was written by a previous process.
 */
// 【首选的读取方式】同步、不阻塞、可能略旧。
// 为什么这是首选：开关读取经常在启动关键路径上，等网络是不可接受的；
// 而磁盘缓存由「每次成功拉到配置后」写入，通常就是上一次运行的值，够用。
// 返回类型 T（不是 Promise<T>）——它是纯同步函数，可以直接在渲染逻辑里用。
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  // Check env var overrides first (for eval harnesses)
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) {
    return overrides[feature] as T
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  if (!isGrowthBookEnabled()) {
    return defaultValue
  }

  // Log experiment exposure if data is available, otherwise defer until after init
// 有实验数据就立刻报曝光；还没有就记进 pendingExposures，等初始化完成后补报。
  if (experimentDataByFeature.has(feature)) {
    logExposureForFeature(feature)
  } else {
    pendingExposures.add(feature)
  }

  // In-memory payload is authoritative once processRemoteEvalPayload has run.
  // Disk is also fresh by then (syncRemoteEvalToDisk runs synchronously inside
  // init), so this is correctness-equivalent to the disk read below — but it
  // skips the config JSON parse and is what onGrowthBookRefresh subscribers
  // depend on to read fresh values the instant they're notified.
// 优先读内存：内存一旦填充就是最新值（而且省掉一次 JSON 解析）。
  if (remoteEvalFeatureValues.has(feature)) {
    return remoteEvalFeatureValues.get(feature) as T
  }

  // Fall back to disk cache (survives across process restarts)
// 退回磁盘缓存（跨进程存活）。读不到就用默认值。
  try {
    const cached = getGlobalConfig().cachedGrowthBookFeatures?.[feature]
    return cached !== undefined ? (cached as T) : defaultValue
  } catch {
    return defaultValue
  }
}

/**
 * @deprecated Disk cache is now synced on every successful payload load
 * (init + 20min/6h periodic refresh). The per-feature TTL never fetched
 * fresh data from the server — it only re-wrote in-memory state to disk,
 * which is now redundant. Use getFeatureValue_CACHED_MAY_BE_STALE directly.
 */
// 已废弃：磁盘缓存现在每次成功拉取都会整体同步，这里的 TTL 逻辑已无意义。
export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(feature, defaultValue)
}

/**
 * Check a Statsig feature gate value via GrowthBook, with fallback to Statsig cache.
 *
 * **MIGRATION ONLY**: This function is for migrating existing Statsig gates to GrowthBook.
 * For new features, use `getFeatureValue_CACHED_MAY_BE_STALE()` instead.
 *
 * - Checks GrowthBook disk cache first
 * - Falls back to Statsig's cachedStatsigGates during migration
 * - The value may be stale if the cache hasn't been updated recently
 *
 * @deprecated Use getFeatureValue_CACHED_MAY_BE_STALE() for new code. This function
 * exists only to support migration of existing Statsig gates.
 */
// 迁移专用：从旧 Statsig 系统迁移到 GrowthBook 期间的兼容函数。
// 先看 GrowthBook 缓存，没有再看 Statsig 缓存。新代码别用它。
export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  gate: string,
): boolean {
  // Check env var overrides first (for eval harnesses)
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // Log experiment exposure if data is available, otherwise defer until after init
  if (experimentDataByFeature.has(gate)) {
    logExposureForFeature(gate)
  } else {
    pendingExposures.add(gate)
  }

  // Return cached value immediately from disk
  // First check GrowthBook cache, then fall back to Statsig cache for migration
  const config = getGlobalConfig()
  const gbCached = config.cachedGrowthBookFeatures?.[gate]
  if (gbCached !== undefined) {
    return Boolean(gbCached)
  }
  // Fallback to Statsig cache for migration period
// `?? false`：两个缓存都没有就返回 false（关）。注意这里不能用 ||，
// 否则 false 会被替换成 false（结果一样），但语义上 ?? 才是「没有就用默认」。
  return config.cachedStatsigGates?.[gate] ?? false
}

/**
 * Check a security restriction gate, waiting for re-init if in progress.
 *
 * Use this for security-critical gates where we need fresh values after auth changes.
 *
 * Behavior:
 * - If GrowthBook is re-initializing (e.g., after login), waits for it to complete
 * - Otherwise, returns cached value immediately (Statsig cache first, then GrowthBook)
 *
 * Statsig cache is checked first as a safety measure for security-related checks:
 * if the Statsig cache indicates the gate is enabled, we honor it.
 */
// 安全类开关专用：宁可慢也要准。
// 特点：① 会等重新初始化完成 ② 优先看 Statsig 缓存（历史上登录时写下的值更可信）
// 返回值用于「是否禁止某操作」，所以默认 false = 「没查到就按禁止处理」（fail-closed）。
export async function checkSecurityRestrictionGate(
  gate: string,
): Promise<boolean> {
  // Check env var overrides first (for eval harnesses)
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // If re-initialization is in progress, wait for it to complete
  // This ensures we get fresh values after auth changes
// 如果正在重新初始化（刚登录/登出），先等它完成——否则会读到旧账号的限制策略。
  if (reinitializingPromise) {
    await reinitializingPromise
  }

  // Check Statsig cache first - it may have correct value from previous logged-in session
  const config = getGlobalConfig()
  const statsigCached = config.cachedStatsigGates?.[gate]
  if (statsigCached !== undefined) {
    return Boolean(statsigCached)
  }

  // Then check GrowthBook cache
  const gbCached = config.cachedGrowthBookFeatures?.[gate]
  if (gbCached !== undefined) {
    return Boolean(gbCached)
  }

// 查不到就返回 false（禁止），且【不阻塞等初始化】：安全场景宁可保守也不能卡住。
  // No cache - return false (don't block on init for uncached gates)
  return false
}

/**
 * Check a boolean entitlement gate with fallback-to-blocking semantics.
 *
 * Fast path: if the disk cache already says `true`, return it immediately.
 * Slow path: if disk says `false`/missing, await GrowthBook init and fetch the
 * fresh server value (max ~5s). Disk is populated by syncRemoteEvalToDisk
 * inside init, so by the time the slow path returns, disk already has the
 * fresh value — no write needed here.
 *
 * Use for user-invoked features (e.g. /remote-control) that are gated on
 * subscription/org, where a stale `false` would unfairly block access but a
 * stale `true` is acceptable (the server is the real gatekeeper).
 */
// 权限/订阅类开关专用：「缓存说 true 就信，说 false 才去查服务端」。
// 为什么这样不对称：
//   - 缓存说 true 但你其实是 false → 服务端才是真正的守门人，反正也会拦住，无所谓
//   - 缓存说 false 但你其实是 true → 用户被冤枉挡在门外，体验很差，必须再查一次
// 这是典型的「按错误代价不对称设计」思路。
export async function checkGate_CACHED_OR_BLOCKING(
  gate: string,
): Promise<boolean> {
  // Check env var overrides first (for eval harnesses)
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // Fast path: disk cache already says true — trust it
  const cached = getGlobalConfig().cachedGrowthBookFeatures?.[gate]
  if (cached === true) {
    // Log experiment exposure if data is available, otherwise defer
    if (experimentDataByFeature.has(gate)) {
      logExposureForFeature(gate)
    } else {
      pendingExposures.add(gate)
    }
    return true
  }

  // Slow path: disk says false/missing — may be stale, fetch fresh
  return getFeatureValueInternal(gate, false, true)
}

/**
 * Refresh GrowthBook after auth changes (login/logout).
 *
 * NOTE: This must destroy and recreate the client because GrowthBook's
 * apiHostRequestHeaders cannot be updated after client creation.
 */
// 登录/登出后刷新开关。
// 为什么必须销毁重建：GrowthBook 的 apiHostRequestHeaders（鉴权头）建好之后无法修改，
// 只能换个新客户端。
export function refreshGrowthBookAfterAuthChange(): void {
  if (!isGrowthBookEnabled()) {
    return
  }

  try {
    // Reset the client completely to get fresh auth headers
    // This is necessary because apiHostRequestHeaders can't be updated after creation
    resetGrowthBook()

    // resetGrowthBook cleared remoteEvalFeatureValues. If re-init below
    // times out (hadFeatures=false) or short-circuits on !hasAuth (logout),
    // the init-callback notify never fires — subscribers stay synced to the
    // previous account's memoized state. Notify here so they re-read now
    // (falls to disk cache). If re-init succeeds, they'll notify again with
    // fresh values; if not, at least they're synced to the post-reset state.
// 重置后【立刻】通知订阅者：万一下面的重新初始化超时或失败（比如登出），
// 订阅者至少能同步到「重置后的状态」，而不是一直停留在旧账号的缓存上。
    refreshed.emit()

    // Reinitialize with fresh auth headers and attributes
    // Track this promise so security gate checks can wait for it.
    // .catch before .finally: initializeGrowthBook can reject if its sync
    // helpers throw (getGrowthBookClient, getAuthHeaders, resetGrowthBook —
    // clientWrapper.initialized itself has its own .catch so never rejects),
    // and .finally re-settles with the original rejection — the sync
    // try/catch below cannot catch async rejections.
// .catch 必须写在 .finally 之前：否则 .finally 会把 rejection 原样传递下去，
// 外层的同步 try/catch 又抓不到异步 rejection，就会变成 unhandled rejection。
    reinitializingPromise = initializeGrowthBook()
      .catch(error => {
        logError(toError(error))
        return null
      })
      .finally(() => {
        reinitializingPromise = null
      })
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
    logError(toError(error))
  }
}

/**
 * Reset GrowthBook client state (primarily for testing)
 */
// 彻底重置（测试 / 登出用）。
// 注意【不清 refreshed 订阅者】：它们通常只注册一次，要能跨越重置继续工作。
export function resetGrowthBook(): void {
  stopPeriodicGrowthBookRefresh()
  // Remove process handlers before destroying client to prevent accumulation
  if (currentBeforeExitHandler) {
    process.off('beforeExit', currentBeforeExitHandler)
    currentBeforeExitHandler = null
  }
  if (currentExitHandler) {
    process.off('exit', currentExitHandler)
    currentExitHandler = null
  }
  client?.destroy()
  client = null
  clientCreatedWithAuth = false
  reinitializingPromise = null
  experimentDataByFeature.clear()
  pendingExposures.clear()
  loggedExposures.clear()
  remoteEvalFeatureValues.clear()
// 清掉 memoize 的缓存。`?.` 链式：`fn.cache` 可能不存在、`clear` 可能不是函数，都要防。
  getGrowthBookClient.cache?.clear?.()
  initializeGrowthBook.cache?.clear?.()
  envOverrides = null
  envOverridesParsed = false
}

// Periodic refresh interval (matches Statsig's 6-hour interval)
// 定时刷新间隔：普通用户 6 小时，内部员工 20 分钟（内部要更快看到配置变化）。
const GROWTHBOOK_REFRESH_INTERVAL_MS =
  process.env.USER_TYPE !== 'ant'
    ? 6 * 60 * 60 * 1000 // 6 hours
    : 20 * 60 * 1000 // 20 min (for ants)
let refreshInterval: ReturnType<typeof setInterval> | null = null
let beforeExitListener: (() => void) | null = null

/**
 * Light refresh - re-fetch features from server without recreating client.
 * Use this for periodic refresh when auth headers haven't changed.
 *
 * Unlike refreshGrowthBookAfterAuthChange() which destroys and recreates the client,
 * this preserves client state and just fetches fresh feature values.
 */
// 「轻刷新」：不重建客户端，只重新拉取开关值（鉴权头没变时用这个）。
// 和 refreshGrowthBookAfterAuthChange 的区别：后者销毁重建（因为鉴权头变了）。
export async function refreshGrowthBookFeatures(): Promise<void> {
  if (!isGrowthBookEnabled()) {
    return
  }

  try {
    const growthBookClient = await initializeGrowthBook()
    if (!growthBookClient) {
      return
    }

    await growthBookClient.refreshFeatures()

    // Guard: if this client was replaced during the in-flight refresh
    // (e.g. refreshGrowthBookAfterAuthChange ran), skip processing the
    // stale payload. Mirrors the init-callback guard above.
// 同样的竞态防护：refreshFeatures 是 await 的，期间客户端可能已被替换（比如用户刚登录），
// 那就不能把这次的「旧账号结果」写进缓存。
    if (growthBookClient !== client) {
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          'GrowthBook: Skipping refresh processing for replaced client',
        )
      }
      return
    }

    // Rebuild remoteEvalFeatureValues from the refreshed payload so that
    // _BLOCKS_ON_INIT callers (e.g. getMaxVersion for the auto-update kill
    // switch) see fresh values, not the stale init-time snapshot.
// 必须重建内存缓存：否则那些 _BLOCKS_ON_INIT 的调用方会一直读到初始化时的旧值。
    const hadFeatures = await processRemoteEvalPayload(growthBookClient)
    // Same re-check as init path: covers the setPayload yield inside
    // processRemoteEvalPayload (the guard above only covers refreshFeatures).
    if (growthBookClient !== client) return

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('GrowthBook: Light refresh completed')
    }

    // Gate on hadFeatures: if the payload was empty/malformed,
    // remoteEvalFeatureValues wasn't rebuilt — skip both the no-op disk
    // write and the spurious subscriber churn (clearCommandMemoizationCaches
    // + getCommands + 4× model re-renders).
// 只有真的拿到有效响应才落盘 + 通知：空响应会导致无谓的缓存失效和 UI 重渲染。
    if (hadFeatures) {
      syncRemoteEvalToDisk()
      refreshed.emit()
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
    logError(toError(error))
  }
}

/**
 * Set up periodic refresh of GrowthBook features.
 * Uses light refresh (refreshGrowthBookFeatures) to re-fetch without recreating client.
 *
 * Call this after initialization for long-running sessions to ensure
 * feature values stay fresh. Matches Statsig's 6-hour refresh interval.
 */
// 建立定时刷新（长会话用）。
// 注意 unref()：定时器不能阻止 Node 进程退出，否则 CLI 会卡住不退出。
export function setupPeriodicGrowthBookRefresh(): void {
  if (!isGrowthBookEnabled()) {
    return
  }

  // Clear any existing interval to avoid duplicates
// 先清掉已有的：防止重复调用产生多个定时器（刷新频率翻倍）。
  if (refreshInterval) {
    clearInterval(refreshInterval)
  }

  refreshInterval = setInterval(() => {
    void refreshGrowthBookFeatures()
  }, GROWTHBOOK_REFRESH_INTERVAL_MS)
  // Allow process to exit naturally - this timer shouldn't keep the process alive
  refreshInterval.unref?.()

  // Register cleanup listener only once
  if (!beforeExitListener) {
    beforeExitListener = () => {
      stopPeriodicGrowthBookRefresh()
    }
    process.once('beforeExit', beforeExitListener)
  }
}

/**
 * Stop periodic refresh (for testing or cleanup)
 */
export function stopPeriodicGrowthBookRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
  if (beforeExitListener) {
    process.removeListener('beforeExit', beforeExitListener)
    beforeExitListener = null
  }
}

// ============================================================================
// Dynamic Config Functions
// These are semantic wrappers around feature functions for Statsig API parity.
// In GrowthBook, dynamic configs are just features with object values.
// ============================================================================

/**
 * Get a dynamic config value - blocks until GrowthBook is initialized.
 * Prefer getFeatureValue_CACHED_MAY_BE_STALE for startup-critical paths.
 */
// 动态配置的阻塞版（本质是 feature，只是值是个对象）。
export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  configName: string,
  defaultValue: T,
): Promise<T> {
  return getFeatureValue_DEPRECATED(configName, defaultValue)
}

/**
 * Get a dynamic config value from disk cache immediately. Pure read — see
 * getFeatureValue_CACHED_MAY_BE_STALE.
 * This is the preferred method for startup-critical paths and sync contexts.
 *
 * In GrowthBook, dynamic configs are just features with object values.
 */
// 动态配置的缓存版。GrowthBook 里「动态配置」就是「值为对象的 feature」，
// 保留这套命名是为了和旧 Statsig API 对齐，减少迁移成本。
export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  configName: string,
  defaultValue: T,
): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(configName, defaultValue)
}
