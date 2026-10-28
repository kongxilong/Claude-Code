/**
 * 【一句话定位】agent 记忆的**快照同步**：把项目里提交的一份 agent 记忆快照，
 * 初始化/更新到本机的 user 级记忆目录里（让团队共享的经验能分发到每个人）。
 *
 * 【在架构中的位置】
 *   上游：loadAgentsDir.ts 的 initializeAgentMemorySnapshots()（加载 agent 时调用 check）。
 *   下游：agentMemory.ts（算记忆目录路径）。
 *   快照位置：<cwd>/.claude/agent-memory-snapshots/<agentType>/（进版本库，团队共享）
 *   同步标记：记忆目录里的 .snapshot-synced.json，记录「我上次同步的是哪个版本的快照」。
 *
 * 【本文件包含什么】
 *   - getSnapshotDirForAgent()：快照目录路径。
 *   - checkAgentMemorySnapshot()：判断要做什么动作（none / initialize / prompt-update）。
 *   - initializeFromSnapshot()：首次初始化（本地没记忆时直接拷贝）。
 *   - replaceFromSnapshot()：用快照覆盖本地记忆（先删掉旧的 .md，避免留下孤儿文件）。
 *   - markSnapshotSynced()：只更新同步标记，不动本地记忆（用户选择「保留我的」时用）。
 *
 * 【为什么要区分 initialize 和 prompt-update】
 *   本地**完全没有**记忆 → 直接拷贝（initialize），用户没有可失去的东西；
 *   本地**已经有**记忆 → 不能直接覆盖（会毁掉用户自己攒的经验），只返回一个 prompt-update
 *   信号，由上层去问用户要不要更新。这就是 check 返回三种动作的原因。
 *
 * 【TS 语法速查】
 *   - 泛型函数 `async function f<T>(path: string, schema: z.ZodType<T>): Promise<T | null>`：
 *     `<T>` 是类型参数，≈ Java 的 `<T>` 泛型方法；调用时 T 由传入的 schema 推导出来。
 *   - `z.ZodType<T>`：zod 的 schema 类型，T 是它校验后产出的数据类型。
 *   - `z.infer<ReturnType<typeof schema>>`：从 zod schema **反推**出它的 TypeScript 类型，
 *     ≈ 「让 schema 成为唯一事实来源，类型由它生成」（避免类型和校验逻辑两处维护）。
 *   - `lazySchema(() => ...)`：延迟构造 schema，打断模块加载期的循环依赖。
 *   - `try { ... } catch { ... }`：注意 catch **没有**绑定变量（可选 catch 绑定，ES2019+），
 *     表示「我不关心错误内容，失败就走兜底」。
 *   - `readdir(p, { withFileTypes: true })`：返回 Dirent 对象（带 isFile()/isDirectory()），
 *     比只返回文件名字符串方便，省掉一次 stat 调用。
 *   - `fs/promises` 的 mkdir/readFile/writeFile/unlink ≈ Files.createDirectories 等的异步版。
 *   - `new Date(str) > new Date(str2)`：Date 可以直接用比较运算符（会转成时间戳）。
 *   - `arr.some(fn)` ≈ Stream.anyMatch；`str.endsWith(x)` ≈ String.endsWith。
 *   - `await Promise` 在 async 函数里 ≈ CompletableFuture.join()，但语法上像同步代码。
 */
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { type AgentMemoryScope, getAgentMemoryDir } from './agentMemory.js'

// 快照存放的根目录名（在 .claude 下）、快照元数据文件名、同步标记文件名
const SNAPSHOT_BASE = 'agent-memory-snapshots'
const SNAPSHOT_JSON = 'snapshot.json'
const SYNCED_JSON = '.snapshot-synced.json'

const snapshotMetaSchema = lazySchema(() =>
  z.object({
    updatedAt: z.string().min(1),
  }),
)

const syncedMetaSchema = lazySchema(() =>
  z.object({
    syncedFrom: z.string().min(1),
  }),
)
type SyncedMeta = z.infer<ReturnType<typeof syncedMetaSchema>>

/**
 * Returns the path to the snapshot directory for an agent in the current project.
 * e.g., <cwd>/.claude/agent-memory-snapshots/<agentType>/
 */
/**
 * 快照目录路径：<cwd>/.claude/agent-memory-snapshots/<agentType>/
 */
export function getSnapshotDirForAgent(agentType: string): string {
  return join(getCwd(), '.claude', SNAPSHOT_BASE, agentType)
}

function getSnapshotJsonPath(agentType: string): string {
  return join(getSnapshotDirForAgent(agentType), SNAPSHOT_JSON)
}

function getSyncedJsonPath(agentType: string, scope: AgentMemoryScope): string {
  return join(getAgentMemoryDir(agentType, scope), SYNCED_JSON)
}

/**
 * 读一个 JSON 文件并用 zod schema 校验。
 * 任何一步失败（读不到、不是合法 JSON、校验不过）都返回 null —— 快照损坏不该让启动崩掉。
 */
async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const content = await readFile(path, { encoding: 'utf-8' })
    const result = schema.safeParse(jsonParse(content))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * 把快照目录里的文件拷到本地记忆目录（跳过 snapshot.json 这个元数据文件，它不属于记忆内容）。
 */
async function copySnapshotToLocal(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<void> {
  const snapshotMemDir = getSnapshotDirForAgent(agentType)
  const localMemDir = getAgentMemoryDir(agentType, scope)

  await mkdir(localMemDir, { recursive: true })

  try {
    const files = await readdir(snapshotMemDir, { withFileTypes: true })
    for (const dirent of files) {
      if (!dirent.isFile() || dirent.name === SNAPSHOT_JSON) continue
      const content = await readFile(join(snapshotMemDir, dirent.name), {
        encoding: 'utf-8',
      })
      await writeFile(join(localMemDir, dirent.name), content)
    }
  } catch (e) {
    logForDebugging(`Failed to copy snapshot to local agent memory: ${e}`)
  }
}

/**
 * 写入同步标记，记录「我同步的是哪个时间戳的快照」。
 * 下次 check 时用它和快照自己的 updatedAt 比较，判断快照有没有更新。
 */
async function saveSyncedMeta(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  const syncedPath = getSyncedJsonPath(agentType, scope)
  const localMemDir = getAgentMemoryDir(agentType, scope)
  await mkdir(localMemDir, { recursive: true })
  const meta: SyncedMeta = { syncedFrom: snapshotTimestamp }
  try {
    await writeFile(syncedPath, jsonStringify(meta))
  } catch (e) {
    logForDebugging(`Failed to save snapshot sync metadata: ${e}`)
  }
}

/**
 * 判断需要做什么动作。三种结果：
 *   - none        没有快照，或本地已同步到最新
 *   - initialize  本地完全没有记忆（没有任何 .md）→ 可以直接拷贝
 *   - prompt-update 本地有记忆且快照更新 → 只能提示用户，不能直接覆盖
 */
/**
 * Check if a snapshot exists and whether it's newer than what we last synced.
 */
export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}> {
  const snapshotMeta = await readJsonFile(
    getSnapshotJsonPath(agentType),
    snapshotMetaSchema(),
  )

  if (!snapshotMeta) {
    return { action: 'none' }
  }

  const localMemDir = getAgentMemoryDir(agentType, scope)

// 判断「本地有没有记忆」：看目录里有没有 .md 文件。目录不存在时 catch 里静默跳过
  let hasLocalMemory = false
  try {
    const dirents = await readdir(localMemDir, { withFileTypes: true })
    hasLocalMemory = dirents.some(d => d.isFile() && d.name.endsWith('.md'))
  } catch {
    // Directory doesn't exist
  }

// 本地一点记忆都没有 → 直接初始化（用户没有可失去的东西）
  if (!hasLocalMemory) {
    return { action: 'initialize', snapshotTimestamp: snapshotMeta.updatedAt }
  }

  const syncedMeta = await readJsonFile(
    getSyncedJsonPath(agentType, scope),
    syncedMetaSchema(),
  )

// 本地有记忆：只有快照比上次同步的更新时才提示更新。
// 没有同步标记（从没同步过）也当作需要更新。
  if (
    !syncedMeta ||
    new Date(snapshotMeta.updatedAt) > new Date(syncedMeta.syncedFrom)
  ) {
    return {
      action: 'prompt-update',
      snapshotTimestamp: snapshotMeta.updatedAt,
    }
  }

  return { action: 'none' }
}

/**
 * 首次初始化：拷贝快照 + 写同步标记。
 */
/**
 * Initialize local agent memory from a snapshot (first-time setup).
 */
export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  logForDebugging(
    `Initializing agent memory for ${agentType} from project snapshot`,
  )
  await copySnapshotToLocal(agentType, scope)
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}

/**
 * 用快照**覆盖**本地记忆（用户确认要更新时走这条）。
 * 先删掉本地所有 .md：否则快照里已经删掉的文件会在本地变成孤儿，永远留着。
 */
/**
 * Replace local agent memory with the snapshot.
 */
export async function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  logForDebugging(
    `Replacing agent memory for ${agentType} with project snapshot`,
  )
  // Remove existing .md files before copying to avoid orphans
  const localMemDir = getAgentMemoryDir(agentType, scope)
  try {
    const existing = await readdir(localMemDir, { withFileTypes: true })
    for (const dirent of existing) {
      if (dirent.isFile() && dirent.name.endsWith('.md')) {
        await unlink(join(localMemDir, dirent.name))
      }
    }
  } catch {
    // Directory may not exist yet
  }
  await copySnapshotToLocal(agentType, scope)
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}

/**
 * 只更新同步标记、不动本地记忆（用户选择「保留我自己的记忆」时用），
 * 这样下次 check 就不会再提示了。
 */
/**
 * Mark the current snapshot as synced without changing local memory.
 */
export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  snapshotTimestamp: string,
): Promise<void> {
  await saveSyncedMeta(agentType, scope, snapshotTimestamp)
}
