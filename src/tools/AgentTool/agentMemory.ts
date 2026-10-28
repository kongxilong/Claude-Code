/**
 * 【一句话定位】agent 的**持久化记忆**：每个 agent 类型可以有一块跨会话存活的记忆目录
 * （一个 MEMORY.md + 若干笔记文件），本文件负责算目录路径、判断路径归属、生成记忆提示词。
 *
 * 【在架构中的位置】
 *   上游：loadAgentsDir.ts（解析 agent 定义时调用 loadAgentMemoryPrompt 拼进 system prompt）。
 *   下游：memdir/memdir.js（真正读写记忆内容）、memdir/paths.js（记忆根目录）。
 *   记忆范围三选一，写在 agent 的 frontmatter 里：
 *     user    → ~/.claude/agent-memory/<agentType>/  跨项目通用
 *     project → <cwd>/.claude/agent-memory/<agentType>/  团队共享，进版本库
 *     local   → <cwd>/.claude/agent-memory-local/<agentType>/  本机专用，不进版本库
 *
 * 【本文件包含什么】
 *   - AgentMemoryScope：三种记忆范围的字面量联合类型。
 *   - sanitizeAgentTypeForPath()：把 agent 类型名里的冒号换成短横线（Windows 文件名不合法）。
 *   - getLocalAgentMemoryDir() / getAgentMemoryDir()：算各范围下的记忆目录。
 *   - isAgentMemoryPath()：判断一个绝对路径是否在记忆目录里（写权限校验用）。
 *   - getAgentMemoryEntrypoint()：记忆入口文件 MEMORY.md 的路径。
 *   - getMemoryScopeDisplay()：给 UI 显示的范围说明。
 *   - loadAgentMemoryPrompt()：生成注入 system prompt 的记忆提示词。
 *
 * 【TS 语法速查】
 *   - `type X = 'a' | 'b' | 'c'` 字面量联合 ≈ Java enum。
 *   - `switch` 穷尽联合类型：本文件两处 switch 都覆盖了全部取值，
 *     所以函数末尾不需要 return（TS 知道不可能走到最后）。
 *   - `switch` 里给变量赋值而不 break 到底：注意 TS 的 switch **会** fall-through，
 *     靠的是每个 case 之后赋值给外部变量再由 return 结束。
 *   - `path.join(a, b, c)` ≈ Paths.get(a).resolve(b).resolve(c)，自动处理分隔符。
 *   - 末尾拼 `+ sep`：刻意让目录路径以分隔符结尾，这样 `startsWith` 判断不会把
 *     `agent-memory-foo` 误判成在 `agent-memory` 里（前缀匹配的经典坑）。
 *   - `normalize(p)` ≈ Paths.normalize()，把 `..` 折叠掉。
 *     注释里标了 SECURITY：这是防路径穿越（`../`）绕过的前置处理。
 *   - `str.replace(/:/g, '-')`：正则全局替换，`/:/g` 是正则字面量（g = global）。
 *   - `str.startsWith(x)` / `str.includes(x)` ≈ String.startsWith / contains。
 *   - `void asyncFn()`：fire-and-forget 调用异步函数（故意不 await）。
 *     注释解释了为什么可以这么做： mkdir 一定会在 agent 真正需要写文件之前完成。
 *   - `process.env.X` 读环境变量；模板字符串插值。
 */
import { join, normalize, sep } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  buildMemoryPrompt,
  ensureMemoryDirExists,
} from '../../memdir/memdir.js'
import { getMemoryBaseDir } from '../../memdir/paths.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath } from '../../utils/path.js'

// 三种记忆范围。区别在「谁能看到、进不进版本库」：
//   user    —— 跨项目通用，只有你自己
//   project —— 团队共享（.claude/agent-memory 会被提交）
//   local   —— 本机专用，明确不进版本库
// Persistent agent memory scope: 'user' (~/.claude/agent-memory/), 'project' (.claude/agent-memory/), or 'local' (.claude/agent-memory-local/)
export type AgentMemoryScope = 'user' | 'project' | 'local'

/**
 * Sanitize an agent type name for use as a directory name.
 * Replaces colons (invalid on Windows, used in plugin-namespaced agent
 * types like "my-plugin:my-agent") with dashes.
 */
/**
 * 把 agent 类型名清理成合法的目录名。
 * 为什么需要：插件提供的 agent 类型名形如 `my-plugin:my-agent`，
 * 冒号在 Windows 文件名里是非法的，一律换成短横线。
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

/**
 * Returns the local agent memory directory, which is project-specific and not checked into VCS.
 * When CLAUDE_CODE_REMOTE_MEMORY_DIR is set, persists to the mount with project namespacing.
 * Otherwise, uses <cwd>/.claude/agent-memory-local/<agentType>/.
 */
/**
 * 算 local 范围的记忆目录。
 * 设了 CLAUDE_CODE_REMOTE_MEMORY_DIR（远端挂载场景）时，还要按项目做一层命名空间隔离，
 * 用 git 仓库根路径的 sanitize 结果当目录名，避免不同项目互相看到对方的记忆。
 */
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(
          findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot(),
        ),
        'agent-memory-local',
        dirName,
      ) + sep
    )
  }
  return join(getCwd(), '.claude', 'agent-memory-local', dirName) + sep
}

/**
 * Returns the agent memory directory for a given agent type and scope.
 * - 'user' scope: <memoryBase>/agent-memory/<agentType>/
 * - 'project' scope: <cwd>/.claude/agent-memory/<agentType>/
 * - 'local' scope: see getLocalAgentMemoryDir()
 */
/**
 * 按范围算记忆目录。三条分支见文件头说明。
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      return join(getCwd(), '.claude', 'agent-memory', dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName)
    case 'user':
      return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
  }
}

// Check if file is within an agent memory directory (any scope).
/**
 * 判断一个绝对路径是否落在**任意一种**记忆目录里（写权限校验用）。
 * 安全要点：先 normalize 折叠掉 `..`，否则 `a/../b` 这种路径能绕过前缀判断。
 * 每个判断都在末尾拼了 sep，避免 `agent-memory-foo` 被误判成在 `agent-memory` 里。
 */
export function isAgentMemoryPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  const memoryBase = getMemoryBaseDir()

  // User scope: check memory base (may be custom dir or config home)
  if (normalizedPath.startsWith(join(memoryBase, 'agent-memory') + sep)) {
    return true
  }

  // Project scope: always cwd-based (not redirected)
  if (
    normalizedPath.startsWith(join(getCwd(), '.claude', 'agent-memory') + sep)
  ) {
    return true
  }

  // Local scope: persisted to mount when CLAUDE_CODE_REMOTE_MEMORY_DIR is set, otherwise cwd-based
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    if (
      normalizedPath.includes(sep + 'agent-memory-local' + sep) &&
      normalizedPath.startsWith(
        join(process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    normalizedPath.startsWith(
      join(getCwd(), '.claude', 'agent-memory-local') + sep,
    )
  ) {
    return true
  }

  return false
}

/**
 * Returns the agent memory file path for a given agent type and scope.
 */
/**
 * 记忆入口文件 MEMORY.md 的路径——agent 记忆的「目录页」。
 */
export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return join(getAgentMemoryDir(agentType, scope), 'MEMORY.md')
}

/**
 * 给 UI 显示的范围说明（比如 `User (~/.claude/agent-memory/)`）。
 */
export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      return `User (${join(getMemoryBaseDir(), 'agent-memory')}/)`
    case 'project':
      return 'Project (.claude/agent-memory/)'
    case 'local':
      return `Local (${getLocalAgentMemoryDir('...')})`
    default:
      return 'None'
  }
}

/**
 * 生成要注入 agent system prompt 的记忆提示词。
 * 每段范围配一句不同的指引（user 要写得通用、project 要贴合本项目、local 贴合本机），
 * 这是防止 agent 把「只在这个项目成立」的经验写进跨项目的 user 记忆里。
 *
 * 注意 ensureMemoryDirExists 是 fire-and-forget（void）：
 * 这个函数是在 React 渲染期间被同步调用的（getSystemPrompt 不能是 async），
 * 而 agent 至少要经过一次完整的 API 往返才可能写文件，那时 mkdir 早做完了；
 * 即便没做完，FileWriteTool 自己也会 mkdir 父目录。
 */
/**
 * Load persistent memory for an agent with memory enabled.
 * Creates the memory directory if needed and returns a prompt with memory contents.
 *
 * @param agentType The agent's type name (used as directory name)
 * @param scope 'user' for ~/.claude/agent-memory/ or 'project' for .claude/agent-memory/
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  let scopeNote: string
  switch (scope) {
    case 'user':
      scopeNote =
        '- Since this memory is user-scope, keep learnings general since they apply across all projects'
      break
    case 'project':
      scopeNote =
        '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project'
      break
    case 'local':
      scopeNote =
        '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine'
      break
  }

  const memoryDir = getAgentMemoryDir(agentType, scope)

  // Fire-and-forget: this runs at agent-spawn time inside a sync
  // getSystemPrompt() callback (called from React render in AgentDetail.tsx,
  // so it cannot be async). The spawned agent won't try to Write until after
  // a full API round-trip, by which time mkdir will have completed. Even if
  // it hasn't, FileWriteTool does its own mkdir of the parent directory.
  void ensureMemoryDirExists(memoryDir)

  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  return buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines]
        : [scopeNote],
  })
}
