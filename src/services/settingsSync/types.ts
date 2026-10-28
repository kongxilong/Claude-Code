/**
 * ============================================================================
 *  【文件总览】src/services/settingsSync/types.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 types.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：UserSyncContentSchema、UserSyncDataSchema、UserSyncData、SettingsSyncFetchResult、SettingsSyncUploadResult、SYNC_KEYS
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
 * Settings Sync Types
 *
 * Zod schemas and types for the user settings sync API.
 * Based on the backend API contract from anthropic/anthropic#218817.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Content portion of user sync data - flat key-value storage.
 * Keys are opaque strings (typically file paths).
 * Values are UTF-8 string content (JSON, Markdown, etc).
 */
export const UserSyncContentSchema = lazySchema(() =>
  z.object({
    entries: z.record(z.string(), z.string()),
  }),
)

/**
 * Full response from GET /api/claude_code/user_settings
 */
export const UserSyncDataSchema = lazySchema(() =>
  z.object({
    userId: z.string(),
    version: z.number(),
    lastModified: z.string(), // ISO 8601 timestamp
    checksum: z.string(), // MD5 hash
    content: UserSyncContentSchema(),
  }),
)

export type UserSyncData = z.infer<ReturnType<typeof UserSyncDataSchema>>

/**
 * Result from fetching user settings
 */
export type SettingsSyncFetchResult = {
  success: boolean
  data?: UserSyncData
  isEmpty?: boolean // true if 404 (no data exists)
  error?: string
  skipRetry?: boolean
}

/**
 * Result from uploading user settings
 */
export type SettingsSyncUploadResult = {
  success: boolean
  checksum?: string
  lastModified?: string
  error?: string
}

/**
 * Keys used for sync entries
 */
export const SYNC_KEYS = {
  USER_SETTINGS: '~/.claude/settings.json',
  USER_MEMORY: '~/.claude/CLAUDE.md',
  projectSettings: (projectId: string) =>
    `projects/${projectId}/.claude/settings.local.json`,
  projectMemory: (projectId: string) => `projects/${projectId}/CLAUDE.local.md`,
} as const
