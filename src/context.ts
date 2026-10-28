/**
 * 【一句话定位】组装会话的「系统上下文」与「用户上下文」——也就是每次对话开头要塞给模型的那批环境信息：
 * git 状态（当前分支、改动、最近提交）、CLAUDE.md 记忆内容、当前日期等。
 *
 * 【在架构中的位置】
 *   上游（谁调用本文件）：
 *     system prompt 组装链路（claude.ts / utils/systemPrompt*.ts）—— 把这里产出的片段拼进 system prompt
 *     src/query.ts 的 prependUserContext / appendSystemContext（见 utils/api.ts）—— 在发请求前注入
 *     yoloClassifier.ts（auto 模式安全分类器）—— 读这里缓存下来的 CLAUDE.md 内容
 *   下游（本文件依赖谁）：
 *     ./utils/git.js、./utils/gitSettings.js —— 执行 git 命令、判断是否该给 git 指引
 *     ./utils/claudemd.js —— 发现并读取 CLAUDE.md 记忆文件
 *     ./bootstrap/state.js —— 读写跨模块的缓存状态
 *     lodash 的 memoize —— 把结果缓存住（这些 git 命令和文件遍历挺贵的）
 *   调用链：
 *     会话开始 → getSystemContext()（git 状态 + 可选的 cache breaker）
 *               → getUserContext()（CLAUDE.md + 当前日期）
 *     → 两块内容合并进 system prompt → 随请求发给模型（并在整个会话期间被 memoize 缓存复用）
 *
 * 【本文件包含什么】
 *   getGitStatus()              —— 采集 git 信息：分支、主分支、status、最近 5 条提交、git 用户名（带截断保护）
 *   getSystemContext()          —— 系统上下文：git 状态 + 内部调试用的 cache breaker
 *   getUserContext()            —— 用户上下文：CLAUDE.md 内容 + 今天日期
 *   getSystemPromptInjection() / setSystemPromptInjection() —— 内部调试用：临时往 prompt 里注入一段文字来打破缓存
 *   MAX_STATUS_CHARS / truncatedStatus —— git status 超过 2000 字符就截断（防止大仓库把上下文撑爆）
 *
 * 【TS 语法速查】（针对本文件实际出现的写法，Java 工程师对照看）
 *   1. `memoize(async () => {...})` —— lodash 记忆化：把异步函数的结果按参数缓存住，
 *      ≈ Java 里用 ConcurrentHashMap 手写的「有缓存的 Supplier」，但这里连 Promise 本身也一起缓存（并发只算一次）。
 *   2. `Promise.all([a(), b(), c()])` ≈ Java CompletableFuture.allOf：并发发起多个异步操作、一起等结果。
 *   3. `const [branch, mainBranch, status] = await Promise.all([...])` 是【数组解构】≈ 把结果数组按顺序拆给三个变量。
 *   4. `` `Today's date is ${x}.` `` 是【模板字符串】≈ Java 的文本块 + String.format，用反引号 + ${} 插值。
 *   5. `async () => {...}` 返回 Promise<T> ≈ Java 方法声明 CompletableFuture<T>；await ≈ get()，但不阻塞线程。
 *   6. `...(cond && { key: value })` 是【条件展开】的变体：条件是 falsy 时展开 false（等于什么都不加），
 *      条件成立时展开那个对象。本文件用它做「有值才加这个字段」。
 *   7. `{ [k: string]: string }` 是【索引签名】≈ Map<String, String>：对象的键是任意字符串、值都是字符串。
 *   8. `x?.length ?? 0` —— `?.` 先做 null 检查（为 null 就整段变 undefined），`??` 再兜底成 0。链式判空的惯用写法。
 *   9. `cache.clear?.()` —— 可选调用：memoize 包装出来的函数才带 .cache 属性，用 ?.() 避免在没有时报错。
 *  10. `feature('BREAK_CACHE_COMMAND')` —— 编译期开关，不是运行时 if（详见 tools.ts 文件头第 1 条）：
 *      开源构建里整段会被删掉。
 *  11. `let x: string | null = null` 是【模块级可变变量】≈ Java 的 private static 字段（这里是模块私有）。
 */
import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  setCachedClaudeMdContent,
} from './bootstrap/state.js'
import { getLocalISODate } from './constants/common.js'
import {
  filterInjectedMemoryFiles,
  getClaudeMds,
  getMemoryFiles,
} from './utils/claudemd.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { execFileNoThrow } from './utils/execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { logError } from './utils/log.js'

// git status 的字符上限。为什么要有上限：单仓几千个文件变更时，status 输出能轻易吃掉几万 token，
// 而它对模型的价值边际递减——截断后提示它「自己用 BashTool 跑 git status 看更多」。
const MAX_STATUS_CHARS = 2000

// System prompt injection for cache breaking (ant-only, ephemeral debugging state)
// 内部调试用的「缓存打破器」：往 system prompt 里塞一段随机/自定义文字，让 prompt cache 必然不命中，
// 从而观察到「不靠缓存」时的真实行为。仅内部构建可见，属于临时调试状态，不参与持久化。
let systemPromptInjection: string | null = null

/** 读取当前的系统提示词注入内容（没有就返回 null）。 */
export function getSystemPromptInjection(): string | null {
  return systemPromptInjection
}
/** 设置系统提示词注入内容，并【立刻清掉两个上下文缓存】。
 *  为什么要清缓存：getSystemContext / getUserContext 都被 memoize 缓存了，
 *  如果不主动 clear，改了注入内容也不会重新计算，调试开关就「看起来没生效」。
 *  `cache.clear?.()` 的可选调用是因为 memoize 包装出来的函数才带 .cache 属性，稳妥起见先判空。
 */

export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  // Clear context caches immediately when injection changes
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
// 两个 cache 都要清：注入内容会影响 system context，而 CLAUDE.md 缓存也有可能被间接影响。
}

/** 采集当前仓库的 git 状态快照，拼成一段给模型看的文字。
 *  返回：可直读的 git 状态描述（分支、主分支、status、最近提交、git 用户名），非 git 仓库或出错则返回 null。
 *  步骤：
 *    ① 测试环境直接返回 null（避免在单测里产生不确定的副作用 / 循环）
 *    ② 先判断是不是 git 仓库（getIsGit），不是就跳过（省掉几条无意义的 git 命令）
 *    ③ 用 Promise.all 并发跑 5 条 git 命令：当前分支、默认分支、status、最近 5 条提交、git 用户名
 *    ④ status 超过 2000 字符就截断，并附一句「要更多就自己跑 git status」的提示
 *    ⑤ 任意一步抛错 → 记日志、返回 null（上下文采集失败不能让整个会话起不来，这是刻意的容错）
 *  为什么要 memoize：这些 git 命令要 fork 子进程，会话里可能被多处询问，缓存一次能省下可观的启动耗时。
 *  命令里带 --no-optional-locks 是为了避免 git 在只读操作时抢占仓库锁（会和用户的 git 命令互相阻塞）。
 *  另外文字里明确写了「这是会话开始时的快照，之后不会更新」——防止模型误以为这是实时的。
 */
export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    // Avoid cycles in tests
    return null
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'git_status_started')

  const isGitStart = Date.now()
  const isGit = await getIsGit()
  logForDiagnosticsNoPII('info', 'git_is_git_check_completed', {
    duration_ms: Date.now() - isGitStart,
    is_git: isGit,
  })

  if (!isGit) {
    logForDiagnosticsNoPII('info', 'git_status_skipped_not_git', {
      duration_ms: Date.now() - startTime,
    })
    return null
  }
// 非 git 仓库：直接返回 null。先判断再跑命令，比跑完发现失败再兜底更省事（省 5 次 fork）。

  try {
    const gitCmdsStart = Date.now()
    const [branch, mainBranch, status, log, userName] = await Promise.all([
// 5 条 git 命令并发执行（Promise.all ≈ CompletableFuture.allOf），总耗时 ≈ 最慢的那条，而不是五条之和。
// 每条都配了 preserveOutputOnError: false：出错时不保留输出，避免把半截错误文本当成有效信息塞给模型。
      getBranch(),
      getDefaultBranch(),
      execFileNoThrow(gitExe(), ['--no-optional-locks', 'status', '--short'], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(
        gitExe(),
        ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
        {
          preserveOutputOnError: false,
        },
      ).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(gitExe(), ['config', 'user.name'], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
    ])

    logForDiagnosticsNoPII('info', 'git_commands_completed', {
      duration_ms: Date.now() - gitCmdsStart,
      status_length: status.length,
    })

    // Check if status exceeds character limit
    const truncatedStatus =
      status.length > MAX_STATUS_CHARS
        ? status.substring(0, MAX_STATUS_CHARS) +
          '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using BashTool)'
        : status
// 截断时明确告诉模型「被截断了 + 怎么拿到完整信息」，比默默截断要好——否则模型会以为仓库只有这么多改动。

    logForDiagnosticsNoPII('info', 'git_status_completed', {
      duration_ms: Date.now() - startTime,
      truncated: status.length > MAX_STATUS_CHARS,
    })

    return [
      `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
      `Current branch: ${branch}`,
      `Main branch (you will usually use this for PRs): ${mainBranch}`,
      ...(userName ? [`Git user: ${userName}`] : []),
      `Status:\n${truncatedStatus || '(clean)'}`,
      `Recent commits:\n${log}`,
    ].join('\n\n')
  } catch (error) {
    logForDiagnosticsNoPII('error', 'git_status_failed', {
      duration_ms: Date.now() - startTime,
    })
    logError(error)
    return null
// 出错一律降级成 null：环境信息缺失顶多让模型少点上下文，抛异常却会让会话直接起不来。这是有意的取舍。
  }
})

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 */
/** 组装【系统上下文】：git 状态 + 内部调试用的缓存打破器。
 *  返回：键值都是字符串的对象（键是片段名，值是给模型看的一段文字），会被拼进 system prompt。
 *  步骤：
 *    ① 判断要不要采集 git 状态：远程（CCR）环境或用户关掉 git 指引时跳过——恢复会话时跑 git 纯属浪费
 *    ② 只有在 BREAK_CACHE_COMMAND 编译期开关打开时才读取注入内容（开源构建里这段代码根本不存在）
 *    ③ 用条件展开把「有值才存在」的字段拼进结果对象
 *  为什么整段用 memoize：这些内容在一次会话里基本不变，缓存后 prompt 才能稳定命中缓存。
 */
export const getSystemContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'system_context_started')

    // Skip git status in CCR (unnecessary overhead on resume) or when git instructions are disabled
    const gitStatus =
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus()
// 恢复（resume）会话时没必要重跑 git 命令：既拖慢启动，又会让 prompt 内容和上次不一致、打不中缓存。

    // Include system prompt injection if set (for cache breaking, ant-only)
    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null
// cacheBreaker 只在内部构建里有：它以 [CACHE_BREAKER: xxx] 的形式出现，保证每次 prompt 字节都不同 → 必不命中缓存。

    logForDiagnosticsNoPII('info', 'system_context_completed', {
      duration_ms: Date.now() - startTime,
      has_git_status: gitStatus !== null,
      has_injection: injection !== null,
    })

    return {
      ...(gitStatus && { gitStatus }),
// `...(gitStatus && { gitStatus })` 条件展开：gitStatus 为 null 时展开 false（不产生任何字段），
// 有值时才把 gitStatus 这个键加进去。这样返回对象里就不会出现值为 null 的垃圾字段。
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? {
            cacheBreaker: `[CACHE_BREAKER: ${injection}]`,
          }
        : {}),
    }
  },
)

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 */
/** 组装【用户上下文】：CLAUDE.md 记忆内容 + 当前日期。
 *  返回：键值都是字符串的对象（claudeMd、currentDate）。
 *  步骤：
 *    ① 判断要不要禁用 CLAUDE.md：
 *       - CLAUDE_CODE_DISABLE_CLAUDE_MDS 显式关闭 → 一律不读
 *       - --bare 模式 → 不做自动向上遍历发现，但用户显式 --add-dir 指定的目录依然要读
 *         （英文注释点明了设计意图：bare 是「跳过我没要求的东西」，不是「无视我明确要求的东西」）
 *    ② 读取并拼接 CLAUDE.md 内容（注意这里 await 了异步 I/O，顺带让事件循环在第一次 readFile 时自然让出）
 *    ③ 把内容缓存起来供 auto 模式分类器使用（避免分类器反向依赖 claudemd.ts 造成循环依赖）
 *    ④ 拼上今天的日期——模型经常需要知道「今天」来解读相对时间，而它自身是没有时间概念的
 *  同样用 memoize 缓存：目录遍历与文件读取不便宜，而且内容在一次会话里不该变。
 */
export const getUserContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'user_context_started')

    // CLAUDE_CODE_DISABLE_CLAUDE_MDS: hard off, always.
    // --bare: skip auto-discovery (cwd walk), BUT honor explicit --add-dir.
    // --bare means "skip what I didn't ask for", not "ignore what I asked for".
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)
// 三条规则的优先级：显式关闭 > bare 模式 > 正常发现。bare 下只要用户显式加了目录，就仍然尊重用户的指定。
    // Await the async I/O (readFile/readdir directory walk) so the event
    // loop yields naturally at the first fs.readFile.
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
// 这里刻意 await 了异步 I/O：让事件循环在第一次 fs.readFile 时自然让出，避免启动时长时间占住主线程。
// 同时把结果缓存给 auto 模式分类器——分类器若直接 import claudemd.ts 会经由 permissions/filesystem 形成环，
// 所以用一个「缓存变量」做单向传递（以空间换依赖图无环）。
    // Cache for the auto-mode classifier (yoloClassifier.ts reads this
    // instead of importing claudemd.ts directly, which would create a
    // cycle through permissions/filesystem → permissions → yoloClassifier).
    setCachedClaudeMdContent(claudeMd || null)

    logForDiagnosticsNoPII('info', 'user_context_completed', {
      duration_ms: Date.now() - startTime,
      claudemd_length: claudeMd?.length ?? 0,
      claudemd_disabled: Boolean(shouldDisableClaudeMd),
    })

    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
// 当前日期是每次会话必备的锚点：模型不知道「今天」是几号，没有它就无从理解「上周」「最近」这类相对时间。
    }
  },
)
