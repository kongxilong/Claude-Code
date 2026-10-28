/**
 * ============================================================================
 *  【文件总览】src/services/remoteManagedSettings/syncCacheState.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 syncCacheState.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：setSessionCache、resetSyncCache、setEligibility、getSettingsPath、getRemoteManagedSettingsSyncFromCache
 *
 *  【TS 语法速查】（针对本文件实际用到的，逐条 Java 对照）
 *    · `?.` 可选链 ≈ Java 里 `obj != null ? obj.x : null`
 *    · `??` 空值合并 ≈ `a != null ? a : b`（注意与 `||` 区别：`??` 只在 null/undefined 时兜底，0 和 '' 不会被动替换）
 *    · `!` 非空断言（如 `x!`）≈ 强制类型转换，骗过编译器；运行时并不做检查，乱用会抛错
 *    · `as X` ≈ Java 的 `(X)obj` 强制转换
 *    · `type X = {...}` ≈ record，但 TS 是结构化（鸭子）类型：形状对得上就算同一类型，不要求显式 implements
 *    · `A | B` 联合类型 ≈ 受限的 sealed interface / 代数数据类型
 *    · `{...obj, k: v}` 展开 ≈ 生成新对象（不可变更新），原对象不变
 *    · `x is T` 类型谓词 ≈ Java 的 `instanceof` 模式守卫，用于收窄类型
 *    · `async function*` + `yield` + `for await` ≈ Java 的 Flux / 响应式流（一边产出一边消费）
 *    · `feature('X')` 是编译期开关（类似 #ifdef），不是运行时 if
 *    · `arr.at(-1)` 取最后一个元素（Java 没有，要 `arr.get(arr.size()-1)`）
 *    · 类型标注写在变量名**后面**（`x: string`），Java 写在前面（`String x`）——这是最容易看串行的地方
 *    · 箭头函数 `x => x.y` ≈ Java 的 lambda
 */

/**
 * Leaf state module for the remote-managed-settings sync cache.
 *
 * Split from syncCache.ts to break the settings.ts → syncCache.ts → auth.ts →
 * settings.ts cycle. auth.ts sits inside the large settings SCC; importing it
 * from settings.ts's own dependency chain pulls hundreds of modules into the
 * eagerly-evaluated SCC at startup.
 *
 * This module imports only leaves (path, envUtils, file, json, types,
 * settings/settingsCache — also a leaf, only type-imports validation). settings.ts
 * reads the cache from here. syncCache.ts keeps isRemoteManagedSettingsEligible
 * (the auth-touching part) and re-exports everything from here for callers that
 * don't care about the cycle.
 *
 * Eligibility is a tri-state here: undefined (not yet determined — return
 * null), false (ineligible — return null), true (proceed). managedEnv.ts
 * calls isRemoteManagedSettingsEligible() just before the policySettings
 * read — after userSettings/flagSettings env vars are applied, so the check
 * sees config-provided CLAUDE_CODE_USE_BEDROCK/ANTHROPIC_BASE_URL. That call
 * computes once and mirrors the result here via setEligibility(). Every
 * subsequent read hits the cached bool instead of re-running the auth chain.
 */

import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { readFileSync } from '../../utils/fileRead.js'
import { stripBOM } from '../../utils/jsonRead.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { jsonParse } from '../../utils/slowOperations.js'

const SETTINGS_FILENAME = 'remote-settings.json'

let sessionCache: SettingsJson | null = null
let eligible: boolean | undefined

export function setSessionCache(value: SettingsJson | null): void {
  sessionCache = value
}

export function resetSyncCache(): void {
  sessionCache = null
  eligible = undefined
}

export function setEligibility(v: boolean): boolean {
  eligible = v
  return v
}

export function getSettingsPath(): string {
  return join(getClaudeConfigHomeDir(), SETTINGS_FILENAME)
}

// sync IO — settings pipeline is sync. fileRead and jsonRead are leaves;
// file.ts and json.ts both sit in the settings SCC.
function loadSettings(): SettingsJson | null {
  try {
    const content = readFileSync(getSettingsPath())
    const data: unknown = jsonParse(stripBOM(content))
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return null
    }
    return data as SettingsJson
  } catch {
    return null
  }
}

export function getRemoteManagedSettingsSyncFromCache(): SettingsJson | null {
  if (eligible !== true) return null
  if (sessionCache) return sessionCache
  const cachedSettings = loadSettings()
  if (cachedSettings) {
    sessionCache = cachedSettings
    // Remote settings just became available for the first time. Any merged
    // getSettings_DEPRECATED() result cached before this moment is missing
    // the policySettings layer (the `eligible !== true` guard above returned
    // null). Flush so the next merged read re-merges with this layer visible.
    //
    // Fires at most once: subsequent calls hit `if (sessionCache)` above.
    // When called from loadSettingsFromDisk() (settings.ts:546), the merged
    // cache is still null (setSessionSettingsCache runs at :732 after
    // loadSettingsFromDisk returns) — no-op. The async-fetch arm (index.ts
    // setSessionCache + notifyChange) already handles its own reset.
    //
    // gh-23085: isBridgeEnabled() at main.tsx Commander-definition time
    // (before preAction → init() → isRemoteManagedSettingsEligible()) reached
    // getSettings_DEPRECATED() at auth.ts:115. The try/catch in bridgeEnabled
    // swallowed the later getGlobalConfig() throw, but the merged settings
    // cache was already poisoned. See managedSettingsHeadless.int.test.ts.
    resetSettingsCache()
    return cachedSettings
  }
  return null
}
