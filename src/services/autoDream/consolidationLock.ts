// Lock file whose mtime IS lastConsolidatedAt. Body is the holder's PID.
/**
 * ============================================================================
 *  【文件总览】src/services/autoDream/consolidationLock.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 consolidationLock.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：readLastConsolidatedAt、tryAcquireConsolidationLock、rollbackConsolidationLock、listSessionsTouchedSince、recordConsolidation
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

//
// Lives inside the memory dir (getAutoMemPath) so it keys on git-root
// like memory does, and so it's writable even when the memory path comes
// from an env/settings override whose parent may not be.

import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { logForDebugging } from '../../utils/debug.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { listCandidates } from '../../utils/listSessionsImpl.js'
import { getProjectDir } from '../../utils/sessionStorage.js'

const LOCK_FILE = '.consolidate-lock'

// Stale past this even if the PID is live (PID reuse guard).
const HOLDER_STALE_MS = 60 * 60 * 1000

function lockPath(): string {
  return join(getAutoMemPath(), LOCK_FILE)
}

/**
 * mtime of the lock file = lastConsolidatedAt. 0 if absent.
 * Per-turn cost: one stat.
 */
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const s = await stat(lockPath())
    return s.mtimeMs
  } catch {
    return 0
  }
}

/**
 * Acquire: write PID → mtime = now. Returns the pre-acquire mtime
 * (for rollback), or null if blocked / lost a race.
 *
 *   Success → do nothing. mtime stays at now.
 *   Failure → rollbackConsolidationLock(priorMtime) rewinds mtime.
 *   Crash   → mtime stuck, dead PID → next process reclaims.
 */
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  const path = lockPath()

  let mtimeMs: number | undefined
  let holderPid: number | undefined
  try {
    const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    mtimeMs = s.mtimeMs
    const parsed = parseInt(raw.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : undefined
  } catch {
    // ENOENT — no prior lock.
  }

  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      logForDebugging(
        `[autoDream] lock held by live PID ${holderPid} (mtime ${Math.round((Date.now() - mtimeMs) / 1000)}s ago)`,
      )
      return null
    }
    // Dead PID or unparseable body — reclaim.
  }

  // Memory dir may not exist yet.
  await mkdir(getAutoMemPath(), { recursive: true })
  await writeFile(path, String(process.pid))

  // Two reclaimers both write → last wins the PID. Loser bails on re-read.
  let verify: string
  try {
    verify = await readFile(path, 'utf8')
  } catch {
    return null
  }
  if (parseInt(verify.trim(), 10) !== process.pid) return null

  return mtimeMs ?? 0
}

/**
 * Rewind mtime to pre-acquire after a failed fork. Clears the PID body —
 * otherwise our still-running process would look like it's holding.
 * priorMtime 0 → unlink (restore no-file).
 */
export async function rollbackConsolidationLock(
  priorMtime: number,
): Promise<void> {
  const path = lockPath()
  try {
    if (priorMtime === 0) {
      await unlink(path)
      return
    }
    await writeFile(path, '')
    const t = priorMtime / 1000 // utimes wants seconds
    await utimes(path, t, t)
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] rollback failed: ${(e as Error).message} — next trigger delayed to minHours`,
    )
  }
}

/**
 * Session IDs with mtime after sinceMs. listCandidates handles UUID
 * validation (excludes agent-*.jsonl) and parallel stat.
 *
 * Uses mtime (sessions TOUCHED since), not birthtime (0 on ext4).
 * Caller excludes the current session. Scans per-cwd transcripts — it's
 * a skip-gate, so undercounting worktree sessions is safe.
 */
export async function listSessionsTouchedSince(
  sinceMs: number,
): Promise<string[]> {
  const dir = getProjectDir(getOriginalCwd())
  const candidates = await listCandidates(dir, true)
  return candidates.filter(c => c.mtime > sinceMs).map(c => c.sessionId)
}

/**
 * Stamp from manual /dream. Optimistic — fires at prompt-build time,
 * no post-skill completion hook. Best-effort.
 */
export async function recordConsolidation(): Promise<void> {
  try {
    // Memory dir may not exist yet (manual /dream before any auto-trigger).
    await mkdir(getAutoMemPath(), { recursive: true })
    await writeFile(lockPath(), String(process.pid))
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] recordConsolidation write failed: ${(e as Error).message}`,
    )
  }
}
