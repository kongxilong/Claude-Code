/**
 * ============================================================================
 *  【文件总览】src/tools/EnterWorktreeTool/EnterWorktreeTool.ts
 * ============================================================================
 *
 *  一句话定位：
 *  「创建并进入一个 git worktree（独立工作树）」的工具。
 *  调用之后，当前会话的工作目录会被**整个切换**到那个新的独立目录里。
 *
 *  ---------------------------------------------------------------------------
 *  【先搞懂：git worktree 是什么？为什么要用它？】
 *  ---------------------------------------------------------------------------
 *  平时我们一个 git 仓库只有一个工作目录：
 *
 *      my-repo/            ← 工作目录，同时只有一个分支的代码躺在这里
 *        .git/
 *        src/
 *
 *  想同时改两件事怎么办？传统做法是 `git checkout` 切分支——
 *  但切走之后，刚才改到一半的未提交内容要么跟着走、要么得先 stash，
 *  非常别扭。
 *
 *  `git worktree add` 解决这个问题：它可以给**同一个仓库**再开几个
 *  独立的工作目录，每个目录检出不同的分支，彼此互不干扰：
 *
 *      my-repo/                        ← 主工作目录（分支 main）
 *        .git/
 *      my-repo/.claude/worktrees/
 *        shiny-fox/                    ← 工作树 A（分支 shiny-fox）
 *        brave-owl/                    ← 工作树 B（分支 brave-owl）
 *
 *  三个目录共享**同一个 .git 数据库**（不用重新 clone，省时省空间），
 *  但各有各的分支、各有各的未提交改动。
 *
 *  ---------------------------------------------------------------------------
 *  【为什么 AI 编程场景特别需要 worktree？】
 *  ---------------------------------------------------------------------------
 *  这是理解本工具设计意图的关键。让 AI 在你的代码库里干活，风险在于：
 *
 *    · AI 一口气改 20 个文件，改到一半发现方向错了 —— 你的工作目录已经一团糟，
 *      `git checkout .` 都救不回来（因为有些改动是你自己原本就有的）。
 *    · 你正改着 feature A（未提交），想让 AI 顺手改个 bug B —— 两者混在一起，
 *      最后提交时很难拆开。
 *    · 你想让 3 个 AI 并行干 3 件事 —— 同一个目录根本没法并行。
 *
 *  worktree 就是**隔离**这个问题的：给 AI 一个干净的独立目录，
 *  它怎么折腾都不影响你原来的工作目录。干得好就合并回来，
 *  干得差就整个删掉（ExitWorktree 的 remove 动作），你的代码库毫发无损。
 *  ≈ Java 里给每个任务开一个独立的沙箱目录/临时分支，做完再合并。
 *
 *  ---------------------------------------------------------------------------
 *  【Enter / Exit 这对工具分别做了什么】
 *  ---------------------------------------------------------------------------
 *  EnterWorktree（本文件）"进"：
 *    ① 校验当前不已经在 worktree 里（防套娃）
 *    ② 把进程切回主仓库根目录（在 worktree 里没法再建 worktree）
 *    ③ 创建一个新工作树 + 新分支
 *    ④ 把会话的 cwd 切进去
 *    ⑤ 清掉所有"依赖当前目录"的缓存（非常重要！见下面第 100 行注释）
 *
 *  ExitWorktree（../ExitWorktreeTool）"出"：
 *    ① 判断是 keep（保留工作树）还是 remove（连目录带分支一起删）
 *    ② remove 时先统计有多少未提交改动/未合并 commit，有就**拒绝删除**，
 *       除非用户显式传 discard_changes: true（防误删工作成果）
 *    ③ 把 cwd 切回原目录，同样清缓存
 *
 *  ---------------------------------------------------------------------------
 *  【在架构中的位置】调用链
 *  ---------------------------------------------------------------------------
 *      模型输出 tool_use: { name: 'EnterWorktree', input: { name? } }
 *        └─> 工具调度层
 *              ├─> inputSchema 的 superRefine    ← 本文件：校验名字合法性
 *              └─> ★ call()                      ← 本文件核心
 *                    ├─> getCurrentWorktreeSession()   ../../utils/worktree.js
 *                    ├─> findCanonicalGitRoot()        ../../utils/git.js
 *                    ├─> createWorktreeForSession()    ../../utils/worktree.js
 *                    ├─> saveWorktreeState()           ../../utils/sessionStorage.js
 *                    └─> 清一堆缓存
 *
 *  ---------------------------------------------------------------------------
 *  【本文件包含什么】
 *  ---------------------------------------------------------------------------
 *   1. inputSchema / outputSchema   入参（可选的名字）、出参（路径+分支+提示语）
 *   2. EnterWorktreeTool（工具本体）
 *      ├─ toAutoClassifierInput()  给自动模式分类器看的简短摘要
 *      ├─ call()                   ★核心：建工作树并切进去
 *      └─ mapToolResultToToolResultBlockParam()  把结果回灌给模型
 *
 *  ---------------------------------------------------------------------------
 *  【TS 语法速查】Java 工程师视角
 *  ---------------------------------------------------------------------------
 *  - `z` = zod 库，≈ Java 的 Bean Validation + JSON Schema，
 *    但额外能**从 schema 推导 TS 类型**（见 z.infer）。
 *
 *  - `.superRefine((s, ctx) => {...})`  zod 的**自定义校验钩子**。
 *    ≈ Java 里给 Bean Validation 写一个自定义 @Constraint 校验器。
 *    本文件用它把"名字合不合法"这个无法用简单规则表达的校验接进来。
 *    `ctx.addIssue({...})` = 往校验结果里加一条错误，
 *    ≈ Java 校验器里调 `context.buildConstraintViolationWithTemplate(...)`。
 *
 *  - `try { ... } catch (e) { ... }`  和 Java 的 try-catch 几乎一样。
 *    区别：JS 的 catch 参数**只有一个**，没有 Java 的多 catch 分支，
 *    所以常配合 `instanceof` 或 `(e as Error)` 来判断错误类型。
 *
 *  - `(e as Error).message`  `as` 类型断言 ≈ Java 的强制转换 `(Error) e`。
 *    为什么需要？因为 JS 里 throw 出来的**可以是任何东西**
 *    （字符串、数字、对象都行），不像 Java 只有 Throwable 子类。
 *    所以 catch 到的 e 默认是 unknown，想读 .message 必须先断言成 Error。
 *
 *  - `??` 空值合并：`a ?? b` 只在 a 是 null/undefined 时用 b。
 *    ⚠️ 和 `||` 不同：`0` 和 `''` 不会被 `??` 替换掉。
 *    本文件 `input.name ?? getPlanSlug()` = "传了名字就用，没传就生成一个"。
 *
 *  - 类型标注在**变量名后面**（Java 在前面），初期最容易看串。
 *
 *  - `a ? b : c` 三元表达式，和 Java 完全一样。
 *
 *  - `getPlansDirectory.cache.clear?.()`  ★本文件最需要解释的一行
 *      `getPlansDirectory` 是个**带缓存的函数**（memoize）。
 *      `.cache` 是挂在函数对象上的缓存（JS 里函数也是对象，可以挂属性）。
 *      `.clear?.()` 是"如果缓存有 clear 方法就调用"——
 *        `?.()` 是可选调用，≈ Java 的
 *        `if (cache.getClear() != null) cache.getClear().run()`
 *      ≈ Java 里 Guava/Caffeine 的 `cache.invalidateAll()`。
 *      为什么要清？因为这个函数的结果**依赖当前目录**，
 *      切了目录之后旧结果就作废了（详见下面第 100 行附近）。
 *
 *  - `void f()`  = "我知道这是异步的，但我故意不等"。
 *    「发射后不管」≈ Java 的 executor.submit(...) 但从不 get()。
 *
 *  - `satisfies ToolDef<InputSchema, Output>`  编译期契约检查：
 *    "请验证这个对象符合工具接口，但**不要**把类型擦成 ToolDef"。
 *    ≈ Java 的 implements，但不丢泛型细节。
 *
 *  - `100_000` 数字分隔符，和 Java 7+ 一样，纯可读性。
 */
import { z } from 'zod/v4'
import { getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  validateWorktreeSlug,
} from '../../utils/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .superRefine((s, ctx) => {
        try {
          validateWorktreeSlug(s)
        } catch (e) {
          ctx.addIssue({ code: 'custom', message: (e as Error).message })
        }
      })
      .optional()
      .describe(
        'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'create an isolated git worktree and switch into it',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Creates an isolated worktree (via git or configured hooks) and switches the session into it'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Creating worktree'
  },
  shouldDefer: true,
  toAutoClassifierInput(input) {
    return input.name ?? ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    // Validate not already in a worktree created by this session
    if (getCurrentWorktreeSession()) {
      throw new Error('Already in a worktree session')
    }

    // Resolve to main repo root so worktree creation works from within a worktree
    const mainRepoRoot = findCanonicalGitRoot(getCwd())
    if (mainRepoRoot && mainRepoRoot !== getCwd()) {
      process.chdir(mainRepoRoot)
      setCwd(mainRepoRoot)
    }

    const slug = input.name ?? getPlanSlug()

    const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    saveWorktreeState(worktreeSession)
    // Clear cached system prompt sections so env_info_simple recomputes with worktree context
    clearSystemPromptSections()
    // Clear memoized caches that depend on CWD
    clearMemoryFileCaches()
    getPlansDirectory.cache.clear?.()

    logEvent('tengu_worktree_created', {
      mid_session: true,
    })

    const branchInfo = worktreeSession.worktreeBranch
      ? ` on branch ${worktreeSession.worktreeBranch}`
      : ''

    return {
      data: {
        worktreePath: worktreeSession.worktreePath,
        worktreeBranch: worktreeSession.worktreeBranch,
        message: `Created worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
