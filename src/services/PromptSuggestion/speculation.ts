/**
 * ============================================================================
 *  【文件总览】src/services/PromptSuggestion/speculation.ts
 *            —— "推测执行"（Speculative Execution）：在用户还没发请求之前，先把活干掉
 * ============================================================================
 *
 *  一句话定位：
 *  本文件实现的是 Claude Code 里最有意思的性能优化——**推测执行**。
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │ 推测执行（speculation）这个名字借自 CPU 的「推测执行 / 分支预测」：   │
 *  │                                                                      │
 *  │   CPU 看到 `if (x > 0)` 时，不等条件算完就先**猜**一个分支往下跑，    │
 *  │   猜对了 → 白赚了这段时间；猜错了 → 把结果扔掉，回滚重来。            │
 *  │                                                                      │
 *  │   这里完全同构：                                                      │
 *  │     猜对了（用户按 Tab 采纳了建议）→ 把预跑的结果直接注入会话，        │
 *  │                                      用户瞬间看到结果，省下好几秒。   │
 *  │     猜错了（用户自己打了别的）  → 结果扔掉，回滚，几乎零成本。        │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 *  ---------------------------------------------------------------------------
 *  【为什么要在用户还没发请求时预先准备？——省的是"人类打字前的空窗期"】
 *  ---------------------------------------------------------------------------
 *  一轮对话结束后，时间线是这样的：
 *
 *      Claude 回答完 ──────── 用户阅读、思考、打字（3~30 秒）──────── 提交
 *      ↑                                                              ↑
 *      │                                                              │
 *      这一段 CPU 和网络**完全空闲**                                    用户开始等结果
 *
 *  传统做法是等用户提交后才开始干活，用户要干等模型跑完（可能十几秒）。
 *  而推测执行把这段"人类思考的空窗期"利用起来：
 *      在用户阅读时，后台偷偷把"最可能的下一步"给跑完。
 *  等用户真的按 Tab 采纳的那一刻，结果**已经躺在内存里了**，直接显示，零等待。
 *
 *  这就是为什么本文件叫 speculation.ts，而同目录的 promptSuggestion.ts 只是"猜一句话"：
 *      promptSuggestion.ts = 猜出用户要说什么（便宜，只是一次文本生成）
 *      speculation.ts      = 把猜出来的那句话**真的执行掉**（贵，要跑工具、读写文件）
 *
 *  ---------------------------------------------------------------------------
 *  【最危险的问题：预执行会不会把用户的文件改坏？—— overlay（覆盖层）机制】
 *  ---------------------------------------------------------------------------
 *  这是整个设计中最需要安全感的地方：预执行是**猜**的，猜错了就必须
 *  "像从没发生过一样"。但预执行可能包含 Edit / Write 这类写文件的工具……
 *
 *  解法是 **copy-on-write 覆盖层（overlay）**，思路和 Docker 的分层文件系统一样：
 *
 *      1. 在系统临时目录下建一个本次 speculation 专属目录：
 *             <temp>/speculation/<进程PID>/<本次id>/
 *      2. 预执行要**写**某文件 src/Foo.java 时：
 *             a. 先把原始文件复制一份到 overlay/ 里的对应相对路径（首次才复制）
 *             b. 把工具的 file_path 参数**改写**成 overlay 里的路径
 *             c. 于是所有写入都落在 overlay 里，真实文件**一个字节都没动**
 *      3. 预执行要**读**某文件时：
 *             如果这个文件之前被写过 → 读 overlay 里的新版本（否则会读到旧内容）
 *             否则 → 读真实文件（不改写）
 *      4. 结局二选一：
 *             用户采纳 → copyOverlayToMain() 把 overlay 里的文件覆盖回真实位置
 *             用户没采纳 / 出错 → safeRemoveOverlay() 整个目录删掉，像没发生过
 *
 *  另外两道保险：
 *      - 只允许写 **cwd 之内**的路径（`rel.startsWith('..')` 一律拒绝），防止越界
 *      - 只有在 acceptEdits / bypassPermissions 这类"本来就允许自动改文件"的权限模式下
 *        才允许写工具；否则一遇到 Edit/Write 就**停下来**（记为 boundary，见下文）
 *
 *  ---------------------------------------------------------------------------
 *  【boundary（边界）：预执行"跑到哪就停"的停车点】
 *  ---------------------------------------------------------------------------
 *  boundary 是 CompletionBoundary 类型，表示"这次预执行停在了哪里、为什么停"。
 *  它是一个**联合类型**（≈ Java 的 sealed interface），有四种取值：
 *
 *      { type: 'complete' }     跑完了，模型说"我做完了" —— 最理想的结果
 *      { type: 'bash', command } 遇到一条**非只读**的 bash 命令（可能 rm -rf 之类），不敢跑
 *      { type: 'edit', toolName, filePath }  遇到写文件但当前权限模式不允许自动改
 *      { type: 'denied_tool', toolName, detail }  遇到不在白名单里的工具
 *
 *  为什么要有"停车"这个概念？因为预执行**不能真的为所欲为**。
 *  遇到有副作用/需授权的操作就立刻 abort 并记下 boundary。
 *  用户采纳时：
 *      - boundary = complete → 结果完整，**不需要**再发一次正式 query（queryRequired=false）
 *      - 其它 boundary     → 结果不完整，把已跑的部分注入会话后**仍需**发正式 query 续跑
 *
 *  ---------------------------------------------------------------------------
 *  【在架构中的位置】调用链
 *  ---------------------------------------------------------------------------
 *      executePromptSuggestion()            ← ./promptSuggestion.ts（拿到建议文本后）
 *        └─> startSpeculation()             ← ★ 本文件：启动后台预执行
 *              ├─> runForkedAgent()         ← src/utils/forkedAgent.ts（分叉 agent 跑工具）
 *              │     └─> canUseTool(回调)   ← ★ 本文件内的大闭包：每个工具调用都要先过它
 *              │           ├─ 写工具权限检查 → 不允许就设 boundary 并 abort
 *              │           ├─ 路径改写（overlay）
 *              │           ├─ Bash 只读性检查（checkReadOnlyConstraints）
 *              │           └─ 其它工具 → 一律拒绝 + boundary
 *              └─> generatePipelinedSuggestion()  跑完后**顺手再猜下一句**（流水线）
 *
 *      用户按 Tab 采纳：
 *      REPL.tsx
 *        └─> handleSpeculationAccept()      ← ★ 本文件：把预跑结果并入正式会话
 *              ├─> prepareMessagesForInjection()  清洗消息（去掉残缺的 tool_use 对）
 *              ├─> acceptSpeculation()            拷贝 overlay 回真实目录 + 记埋点
 *              └─> startSpeculation()（用流水线上已备好的下一句建议，继续下一轮）
 *
 *      用户自己打字（没采纳）：
 *      REPL.tsx
 *        └─> abortSpeculation()             ← ★ 本文件：abort + 删 overlay + 回滚状态
 *
 *  ---------------------------------------------------------------------------
 *  【"流水线"（pipelined）是什么？】
 *  ---------------------------------------------------------------------------
 *  一次预执行跑完后，如果结果完整（complete），说明模型还在"状态里"，
 *  于是立刻**再猜下一句**并**再预执行下一句**（isPipelined=true）。
 *  这样用户每采纳一次，下一轮的活已经在跑了 —— 像工厂流水线一样没有停顿。
 *  这是 startSpeculation 最后一个参数 isPipelined 的含义。
 *
 *  ---------------------------------------------------------------------------
 *  【本文件包含什么】主要函数清单
 *  ---------------------------------------------------------------------------
 *   1. isSpeculationEnabled()          总开关（目前只对内部员工 USER_TYPE=ant 开放）
 *   2. startSpeculation()              ★ 启动一次预执行（本文件最大的函数）
 *   3. generatePipelinedSuggestion()   预执行跑完后，再猜下一句
 *   4. acceptSpeculation()             用户采纳：拷贝 overlay 回真实目录、算省了多少时间
 *   5. abortSpeculation()              用户没采纳：中止、删 overlay、回滚状态
 *   6. handleSpeculationAccept()       ★ 采纳后的总装：清洗消息 + 注入会话 + 启动下一轮
 *   7. prepareMessagesForInjection()   清洗预跑产生的消息，使其能被安全地注入正式会话
 *   8. copyOverlayToMain() / safeRemoveOverlay() / getOverlayPath()  overlay 的落地/清理/路径
 *   9. updateActiveSpeculationState() / resetSpeculationState()      状态更新小工具
 *  10. createSpeculationFeedbackMessage()  给内部员工显示"本次省了 X 秒"的提示
 *  11. logSpeculation() / countToolsInMessages() / getBoundaryTool() / getBoundaryDetail()  埋点辅助
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的语法，逐条 Java 对照）
 * ---------------------------------------------------------------------------
 *  - `Extract<SpeculationState, { status: 'active' }>`
 *      条件类型工具：从一个联合类型里**筛出**符合条件的那一个成员。
 *      ≈ Java 的 sealed interface + instanceof  narrowing，但在**类型层面**完成。
 *      这里的效果：SpeculationState 是个联合（idle | active），
 *      Extract 出 status 为 'active' 的那支，于是后面访问 .messagesRef 不用到处判空。
 *
 *  - `m is Message & { message: { content: unknown[] } }`
 *      **类型谓词**（type predicate）。返回 boolean 的函数，但能收窄类型：
 *      `if (isUserMessageWithArrayContent(m))` 之后，编译器就知道 m.message.content 是数组了。
 *      ≈ Java 16+ 的 `if (o instanceof Foo f) { ... }` 模式匹配。
 *
 *  - `(b): b is ToolResult => ...`
 *      箭头函数形式的类型谓词。注意返回类型写在**箭头前面**的括号里。
 *      `.filter(isToolResult)` 之后数组元素类型就从 unknown 收窄成 ToolResult 了。
 *
 *  - `unknown` 类型：比 any 安全的"我不知道这是什么"。
 *      **必须先做类型检查才能使用**，编译器强制你写守卫。≈ Java 的 Object，但更严格
 *      （Object 至少能调 toString，unknown 什么都不让调）。
 *
 *  - `typeof b === 'object' && b !== null && 'type' in b`
 *      运行时的"鸭子类型"检查。`in` 运算符判断对象有没有某个属性
 *      ≈ Java 的 `map.containsKey("type")`，但这里是对任意对象做结构探测。
 *
 *  - `as typeof msg`  /  `as string | undefined`
 *      类型断言 ≈ 强制类型转换。运行时**完全不做检查**，纯粹告诉编译器"信我"。
 *      本文件里 `{ ...msg, message: {...} } as typeof msg` 是因为展开后 TS
 *      推不出和原来一样的类型，只好断言一下。
 *
 *  - `b.id!` / `b.tool_use_id!` / `suggestion!`
 *      `!` 非空断言后缀。= "我保证这个不是 undefined，别报错了"。
 *      ≈ Java 的强制转换，骗编译器，运行时不检查（真为 undefined 照样崩）。
 *
 *  - `{ ...input, [pathKey]: join(overlayPath, rel) }`
 *      **计算属性名**：方括号里是变量，表示"把这个变量的值当作键名"。
 *      ≈ Java 的 `map.put(pathKey, value)`。这是 TS 里动态改对象字段的标准写法。
 *
 *  - `input[pathKey] as string | undefined`
 *      索引访问。因为 input 类型上没有明确的 pathKey 字段，只能这样取。
 *
 *  - `{ current: [] as Message[] }`  —— **ref 模式**。
 *      用一个只有 current 字段的小盒子把值包起来。
 *      为什么？因为 messagesRef 要被存进 AppState，而 AppState 通常是**不可变**的：
 *      直接存数组的话，每次 push 都要整体替换，很别扭。
 *      存一个**引用不变的盒子**，内部数组随便变，AppState 都不用更新。
 *      ≈ Java 里存 AtomicReference<List<Message>> 而不是 List<Message>。
 *      本文件 messagesRef / writtenPathsRef / contextRef 都是这个套路。
 *
 *  - `switch (boundary.type) { case 'bash': ...; case 'edit': ... }`
 *      **可辨识联合（discriminated union）**的经典用法：
 *      每个成员都有一个同名的字面量字段 type 做"标签"。
 *      switch 之后 TS 能自动知道 case 'bash' 分支里 boundary 有 command 字段。
 *      ≈ Java 21 的 sealed interface + switch 模式匹配。
 *
 *  - `await mkdir(...)` / `await copyFile(...)`
 *      Node 的文件系统 API，fs/promises 版本返回 Promise。
 *      ≈ Java 的 Files.createDirectories / Files.copy，但要 await。
 *
 *  - `try { ... } catch { ... }`   —— 注意 **catch 后面没有参数**。
 *      ES2019 的"可选 catch 绑定"，表示"我不关心错误内容，只要别崩就行"。
 *      ≈ Java 的 `catch (Exception ignored) {}`，Java 必须写参数，TS 可以省。
 *
 *  - `void someAsyncFn(...)`  = "我知道它返回 Promise，但我故意不 await"。
 *      「发射后不管」≈ Java 的 executor.submit(...) 但不 get()。
 *      本文件到处都是，因为预执行绝不能阻塞用户界面的任何操作。
 *
 *  - `prev => ({ ...prev, speculation: {...} })`  不可变更新 + 箭头函数。
 *      ≈ Java 的 `UnaryOperator<AppState>`；`...prev` 是复制旧字段。
 *
 *  - `Object.entries(updates).some(([key, value]) => ...)`
 *      把对象转成 [键, 值] 数组再判断"是否存在满足条件的项"。
 *      ≈ Java 的 `updates.entrySet().stream().anyMatch(e -> ...)`。
 *
 *  - `.findLastIndex(...)` / `.flatMap(...)` / `.filter(...)`
 *      ≈ Java stream 的对应操作（findLastIndex 是 Java 没有的，得自己倒着遍历）。
 *
 *  - 类型标注在**后面**：`function f(a: string): void`、`let allCopied = true`。
 *      `let allCopied = true` 没写类型也能用 —— TS 会**自动推断**成 boolean，
 *      这是 TS 与 Java 最大的体感差异之一：类型常常可以省略。
 * ============================================================================
 */
import { randomUUID } from 'crypto'
import { rm } from 'fs'
import { appendFile, copyFile, mkdir } from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import { getCwdState } from '../../bootstrap/state.js'
import type { CompletionBoundary } from '../../state/AppStateStore.js'
import {
  type AppState,
  IDLE_SPECULATION_STATE,
  type SpeculationResult,
  type SpeculationState,
} from '../../state/AppStateStore.js'
import { commandHasAnyCd } from '../../tools/BashTool/bashPermissions.js'
import { checkReadOnlyConstraints } from '../../tools/BashTool/readOnlyValidation.js'
import type { SpeculationAcceptMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { count } from '../../utils/array.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type FileStateCache,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { logError } from '../../utils/log.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import {
  createSystemMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../../utils/messages.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { extractReadFilesFromMessages } from '../../utils/queryHelpers.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  generateSuggestion,
  getPromptVariant,
  getSuggestionSuppressReason,
  logSuggestionSuppressed,
  shouldFilterSuggestion,
} from './promptSuggestion.js'

// 预执行最多跑多少"轮"（turn）。一轮 = 模型调一次 + 工具跑一批。
// 为什么要有上限：预执行是在烧钱赌用户会采纳。没有上限的话，
// 万一模型陷入死循环（反复调工具不收敛），会烧掉天量的 token。
const MAX_SPECULATION_TURNS = 20
// 预执行最多累积多少条消息。同样是防止失控的兜底。
// 注意这两个是**不同维度**的限制：轮数限制"模型思考次数"，消息数限制"内存占用"。
const MAX_SPECULATION_MESSAGES = 100

// 会产生**副作用**（改文件）的工具。这些工具在预执行里必须走 overlay 重定向。
// Set<string> ≈ Java 的 HashSet<String>，`has()` 是 O(1)。
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// 明确无副作用的只读工具白名单。采用**白名单**而不是黑名单是刻意的：
// 宁可因为漏了某个工具而"跑得少一点"，也不能误放行一个有副作用的工具把用户环境搞坏。
const SAFE_READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'ToolSearch',
  'LSP',
  'TaskGet',
  'TaskList',
])

/**
 * 删除 overlay 目录（猜测没被采纳时，把预跑的痕迹彻底清理掉）。
 *
 * 为什么是"安全"删除（函数名里的 safe）：
 *   ① force: true —— 目录不存在也不报错（可能压根没创建过）
 *   ② maxRetries + retryDelay —— Windows 上文件常被占用/删不掉，自动重试 3 次
 *   ③ 第三个参数是**回调**而不是 await —— 这是 fs 的**异步回调式** API：
 *      删不掉也不阻塞、不抛异常，属于"尽力而为"的清理。
 *      清理失败最多是留点垃圾文件在临时目录，不值得让用户等待或看到报错。
 *
 * @param {string} overlayPath 本次预执行专属的临时目录
 */
function safeRemoveOverlay(overlayPath: string): void {
  rm(
    overlayPath,
    { recursive: true, force: true, maxRetries: 3, retryDelay: 100 },
    // 空的回调 = "我不关心删除结果"。没有它 Node 会抛错，所以必须给一个。
    () => {},
  )
}

/**
 * 计算本次预执行的 overlay 目录路径。
 *
 * 路径结构：<临时目录>/speculation/<进程PID>/<本次随机id>
 *   - 带 PID：多个 Claude Code 进程同时跑时互不干扰
 *   - 带随机 id：同一进程内的多次预执行互不干扰
 * 这样清理时直接删整个目录即可，不会误伤别人的文件。
 *
 * @param {string} id 本次预执行的唯一 id（startSpeculation 里生成的 8 位随机串）
 */
function getOverlayPath(id: string): string {
  return join(getClaudeTempDir(), 'speculation', String(process.pid), id)
}

/**
 * 构造一个"拒绝工具调用"的返回结构。
 *
 * 为什么单独抽出来：canUseTool 回调里要拒绝的地方有四五处，
 * 每处都要拼这个三字段对象，抽出来省得漏字段。
 *
 * 注意返回类型里 `behavior: 'deny'` 是**字面量类型**而不是 string：
 * 编译器据此能确认调用方不会误传别的值。
 *
 * @param {string} message 告诉模型"为什么被拒"（模型看得到这句话，会据此调整行为）
 * @param {string} reason 给埋点/权限系统看的原因码
 */
function denySpeculation(
  message: string,
  reason: string,
): {
  behavior: 'deny'
  message: string
  decisionReason: { type: 'other'; reason: string }
} {
  return {
    behavior: 'deny',
    message,
    decisionReason: { type: 'other', reason },
  }
}

/**
 * 用户采纳后，把 overlay 里预跑产生的文件**回拷到真实工作目录**。
 *
 * 为什么需要它：这是整个 overlay 机制的"落地"一步。
 * 预跑时所有写入都落在临时目录里，用户按 Tab 的这一刻才真正生效。
 *
 * 为什么设计成"不抛异常"：单个文件拷贝失败（比如被占用、权限不足）时，
 * 只是记一条调试日志并把返回值标成 false，**继续拷剩下的文件**。
 * 因为这里抛异常会导致整个采纳流程回滚，用户反而失去了大部分已预跑的成果——
 * 部分成功远比全部失败有用。
 *
 * @param {string} overlayPath overlay 根目录
 * @param {Set<string>} writtenPaths 本次预跑实际写过的文件（相对 cwd 的路径集合）
 * @param {string} cwd 真实工作目录
 * @returns {boolean} 全部拷贝成功才返回 true
 */
async function copyOverlayToMain(
  overlayPath: string,
  writtenPaths: Set<string>,
  cwd: string,
): Promise<boolean> {
  let allCopied = true
  for (const rel of writtenPaths) {
    const src = join(overlayPath, rel)
    const dest = join(cwd, rel)
    try {
      // recursive: true ≈ Java 的 Files.createDirectories（父目录不存在时一并创建）。
      // 预跑可能创建了全新目录里的新文件，所以这一步不能省。
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(src, dest)
    } catch {
      // 注意 `catch` 后面**没有参数** —— ES2019 的可选 catch 绑定，
      // 意思是"我不关心错误细节"。≈ Java 的 catch (Exception ignored) {}
      allCopied = false
      logForDebugging(`[Speculation] Failed to copy ${rel} to main`)
    }
  }
  return allCopied
}

// 从 SpeculationState 这个联合类型里，**筛出** status 为 'active' 的那一个成员。
// Extract<A, B> 是 TS 内置的条件类型工具。
// ≈ Java 的 sealed interface 配合 instanceof 收窄，但这是在**类型层面**完成的：
// 拿到 ActiveSpeculationState 后访问 .messagesRef / .boundary 不用再判空。
export type ActiveSpeculationState = Extract<
  SpeculationState,
  { status: 'active' }
>

/**
 * 上报一次预执行的埋点。
 *
 * 为什么需要它：推测执行本质上是一场**赌博**，唯一能判断"该不该赌"的依据
 * 就是数据——赌赢（accepted）多少次、省了多少毫秒、赌输（aborted）多少次。
 * 如果赌输的比例太高，就该收紧策略（比如少跑几轮、只跑只读工具）。
 *
 * 特别注意 `completed: boundary !== null` 这个字段：
 * boundary 不为 null 就说明预执行"有明确结局"（要么跑完了，要么停在了某个 boundary 上），
 * 为 null 则说明**还在跑**就被用户采纳或中断了。
 *
 * @param {string} id 本次预执行 id
 * @param {'accepted' | 'aborted' | 'error'} outcome 结局：被采纳 / 被放弃 / 出错
 * @param {number} startTime 开始时间戳（用于算 duration_ms）
 * @param {number} suggestionLength 触发这次预执行的建议文本长度
 * @param {Message[]} messages 预跑产生的消息（用于统计跑了多少工具）
 * @param {CompletionBoundary | null} boundary 停在哪里；null = 还在跑
 * @param {Record<string, ...>} [extras] 调用方附加的额外字段
 */
function logSpeculation(
  id: string,
  outcome: 'accepted' | 'aborted' | 'error',
  startTime: number,
  suggestionLength: number,
  messages: Message[],
  boundary: CompletionBoundary | null,
  extras?: Record<string, string | number | boolean | undefined>,
): void {
  logEvent('tengu_speculation', {
    speculation_id:
      id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    outcome:
      outcome as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    duration_ms: Date.now() - startTime,
    suggestion_length: suggestionLength,
    tools_executed: countToolsInMessages(messages),
    // 有 boundary = 已经有明确结局；null = 还在跑
    completed: boundary !== null,
    // `boundary?.type`：boundary 为 null 时整条链短路成 undefined，不会抛 NPE。
    // ≈ Java 的 boundary == null ? null : boundary.getType()
    boundary_type: boundary?.type as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
    boundary_tool: getBoundaryTool(boundary) as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
    boundary_detail: getBoundaryDetail(boundary) as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
    // 把调用方给的额外字段摊平进来
    ...extras,
  })
}

/**
 * 统计一批消息里**成功执行了多少次工具**。
 *
 * 只数 tool_result 且 `!is_error` 的块：失败的工具调用不算"干成的活"。
 * 这个数字用来衡量一次预执行到底"值多少钱"（跑得越多，省的时间越多）。
 *
 * @param {Message[]} messages 消息列表
 * @returns {number} 成功执行的工具次数
 */
function countToolsInMessages(messages: Message[]): number {
  const blocks = messages
    // 只挑"用户消息且 content 是数组"的那些 —— tool_result 块都挂在 user 消息里
    .filter(isUserMessageWithArrayContent)
    // flatMap 把"数组的数组"摊平成一维数组
    // ≈ Java 的 stream().flatMap(List::stream)
    .flatMap(m => m.message.content)
    // 这个 filter 带**类型谓词**，把 unknown 收窄成 { type, is_error? }
    .filter(
      (b): b is { type: string; is_error?: boolean } =>
        // 运行时鸭子类型检查：是对象、不是 null、且有 type 属性。
        // 因为 content 元素类型未知，必须先运行时确认才能访问字段。
        typeof b === 'object' && b !== null && 'type' in b,
    )
  return count(blocks, b => b.type === 'tool_result' && !b.is_error)
}

/**
 * 从一个 boundary 里提取"是哪个工具导致停下的"（埋点用）。
 *
 * 注意 `case 'edit':` 和 `case 'denied_tool':` 是**共享同一个分支体**的
 * （中间没有 break/return，属于有意的 fall-through），因为两者都有 toolName 字段。
 *
 * @param {CompletionBoundary | null} boundary
 * @returns {string | undefined} 工具名；boundary 为 null 或 complete 时为 undefined
 */
function getBoundaryTool(
  boundary: CompletionBoundary | null,
): string | undefined {
  if (!boundary) return undefined
  // 可辨识联合 + switch：TS 在每个 case 里自动知道 boundary 有哪些字段。
  // ≈ Java 21 的 sealed interface 配合 switch 模式匹配。
  switch (boundary.type) {
    case 'bash':
      return 'Bash'
    case 'edit':
    case 'denied_tool':
      return boundary.toolName
    case 'complete':
      return undefined
  }
}

/**
 * 从一个 boundary 里提取"补充说明"（埋点用），例如 bash 的命令行、edit 的文件路径。
 *
 * 为什么要 slice(0, 200)：命令行可能是个巨大的 heredoc，
 * 直接上报会把大段用户代码灌进日志系统（又慢又可能泄露隐私），所以截断。
 *
 * @param {CompletionBoundary | null} boundary
 * @returns {string | undefined}
 */
function getBoundaryDetail(
  boundary: CompletionBoundary | null,
): string | undefined {
  if (!boundary) return undefined
  switch (boundary.type) {
    case 'bash':
      return boundary.command.slice(0, 200)
    case 'edit':
      return boundary.filePath
    case 'denied_tool':
      return boundary.detail
    case 'complete':
      return undefined
  }
}

/**
 * 类型谓词：判断一条消息是不是"user 类型且 content 是数组"。
 *
 * 为什么需要它：tool_result 块（工具执行结果）在消息结构里是挂在 **user 消息**下的
 * （因为对模型来说，工具结果是"用户侧"提供的输入）。
 * 而 content 可能是字符串也可能是数组，必须先确认是数组才能遍历。
 *
 * 返回类型 `m is Message & { message: { content: unknown[] } }` 的含义：
 *   "如果本函数返回 true，那么 m 就不仅是 Message，还额外保证 message.content 是数组"。
 * 调用方 `if (isUserMessageWithArrayContent(m))` 之后就能安全地遍历 content 了。
 * ≈ Java 16+ 的 `if (o instanceof Foo f)` 模式匹配。
 *
 * @param {Message} m
 */
function isUserMessageWithArrayContent(
  m: Message,
): m is Message & { message: { content: unknown[] } } {
  return m.type === 'user' && 'message' in m && Array.isArray(m.message.content)
}

/**
 * ★ 清洗预跑产生的消息，使其能被安全地**注入正式会话**。
 *
 * 为什么需要它（这是"推测执行"最容易踩坑的地方）：
 * 预跑是被 abort 打断的，所以它的消息序列很可能是**残缺**的。而 Claude API 有一条
 * 严格的格式要求：**每个 tool_use 必须紧跟一个配对的 tool_result，反之亦然**。
 * 一旦注入残缺的消息，API 会直接返回 400 错误，把用户的正式请求搞挂——
 * 本来想优化体验，结果变成功能故障，这是最糟糕的情况。
 *
 * 具体要清掉三类脏数据：
 *   ① 没有成功结果的 tool_use（预跑被 abort，工具还没跑完）
 *      以及它对应的、报错/被中断的 tool_result
 *   ② thinking / redacted_thinking 块（模型的思考过程，注入后可能引发格式问题）
 *   ③ 中断消息（"[Request interrupted by user]"）——
 *      这是**我们自己**在 abort 时造出来的，不是用户真的输入，
 *      如果留着会被模型当成"用户真的说了这句话"，非常误导。
 *
 * 关键步骤：
 *   ① 先扫一遍，收集"哪些 tool_use_id 有成功的结果"
 *   ② 定义 keep 谓词，逐块判断要不要保留
 *   ③ 逐条消息过滤；整条消息空了就丢掉整条
 *   ④ 额外检查：剩下的如果全是空白文本，也丢掉
 *      （API 会以 "text content blocks must contain non-whitespace text" 为由拒绝）
 *
 * @param {Message[]} messages 预跑产生的原始消息
 * @returns {Message[]} 清洗后可以直接注入会话的消息
 */
export function prepareMessagesForInjection(messages: Message[]): Message[] {
  // Find tool_use IDs that have SUCCESSFUL results (not errors/interruptions)
  // Pending tool_use blocks (no result) and interrupted ones will be stripped
  // 中文：先找出"哪些工具调用是真正跑成功了的"。
  // 只有成功的 tool_use + tool_result 配对才能被保留，残缺的一律丢掉。
  type ToolResult = {
    type: 'tool_result'
    tool_use_id: string
    is_error?: boolean
    content?: unknown
  }
  const isToolResult = (b: unknown): b is ToolResult =>
    typeof b === 'object' &&
    b !== null &&
    (b as ToolResult).type === 'tool_result' &&
    typeof (b as ToolResult).tool_use_id === 'string'
  const isSuccessful = (b: ToolResult) =>
    !b.is_error &&
    !(
      typeof b.content === 'string' &&
      b.content.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)
    )

  // 收集所有"成功完成"的工具调用 id。后面用它来判断某个 tool_use 能不能留。
  // 这一整条链式调用 ≈ Java 的 stream 流水线：filter → flatMap → filter → filter → map → collect
  const toolIdsWithSuccessfulResults = new Set(
    messages
      .filter(isUserMessageWithArrayContent)
      .flatMap(m => m.message.content)
      .filter(isToolResult)
      .filter(isSuccessful)
      .map(b => b.tool_use_id),
  )

  // 判断一个 content 块是否保留。四条规则，全部**取反**表达"什么时候丢弃"：
  const keep = (b: {
    type: string
    id?: string
    tool_use_id?: string
    text?: string
  }) =>
    // ① 丢掉模型的思考块（thinking / redacted_thinking）
    b.type !== 'thinking' &&
    b.type !== 'redacted_thinking' &&
    // ② 丢掉"没跑成功"的 tool_use（即它的 id 不在成功集合里）
    //    `b.id!` 的 `!` 是非空断言：理论上 id 一定有，但类型上标了可选，只能断言一下
    !(b.type === 'tool_use' && !toolIdsWithSuccessfulResults.has(b.id!)) &&
    // ③ 对称地，丢掉那些失败/中断的 tool_result
    !(
      b.type === 'tool_result' &&
      !toolIdsWithSuccessfulResults.has(b.tool_use_id!)
    ) &&
    // Abort during speculation yields a standalone interrupt user message
    // (query.ts createUserInterruptionMessage). Strip it so it isn't surfaced
    // to the model as real user input.
    // 中文：④ 丢掉我们自己造出来的"用户中断"消息。
    // 这条很关键 —— 它是 abort 时生成的假用户消息，
    // 如果留着，模型会以为"用户真的说了'中断请求'"，行为会完全跑偏。
    !(
      b.type === 'text' &&
      (b.text === INTERRUPT_MESSAGE ||
        b.text === INTERRUPT_MESSAGE_FOR_TOOL_USE)
    )

  return messages
    .map(msg => {
      // 不是数组型 content 的消息（比如纯字符串的）原样返回
      if (!('message' in msg) || !Array.isArray(msg.message.content)) return msg
      const content = msg.message.content.filter(keep)
      // 一个块都没被删 → 直接复用原对象（避免不必要的复制）
      if (content.length === msg.message.content.length) return msg
      // 全被删光了 → 返回 null，后面 filter 会把整条消息丢掉
      if (content.length === 0) return null
      // Drop messages where all remaining blocks are whitespace-only text
      // (API rejects these with 400: "text content blocks must contain non-whitespace text")
      // 中文：还要防一种隐蔽情况——剩下的块全是空白文本。
      // API 会拒绝纯空白的文本块（400 错误），所以整条消息丢掉。
      const hasNonWhitespaceContent = content.some(
        (b: { type: string; text?: string }) =>
          // 非文本块算"有内容"；文本块则要求 trim 后不为空
          b.type !== 'text' || (b.text !== undefined && b.text.trim() !== ''),
      )
      if (!hasNonWhitespaceContent) return null
      // 不可变更新：复制消息，只替换 content。
      // `as typeof msg` 是因为展开后 TS 推不出和 msg 完全相同的类型，只能断言。
      return { ...msg, message: { ...msg.message, content } } as typeof msg
    })
    // map 可能产生 null，这里用类型谓词把 null 过滤掉，同时把类型收窄回 Message
    .filter((m): m is Message => m !== null)
}

/**
 * 生成一条"这次预执行帮你省了多少时间"的反馈消息（仅内部员工可见）。
 *
 * 为什么需要它：推测执行是个"隐形"优化——用户感知不到它跑过。
 * 给它一个可见的正反馈（"Speculated 3 tool uses · 1.2k tokens · +4s saved"），
 * 内部员工才能直观判断这个优化到底有没有用、值不值得继续投入。
 *
 * 为什么只对 ant（内部员工）显示：普通用户不需要看到这种工程细节，
 * 会显得界面很吵。
 *
 * @param {Message[]} messages 预跑产生的消息
 * @param {CompletionBoundary | null} boundary 停在哪里
 * @param {number} timeSavedMs 本次省下的毫秒数
 * @param {number} sessionTotalMs 整个会话累计省下的毫秒数
 * @returns {Message | null} 一条 system 消息；非内部员工或无收益时返回 null
 */
function createSpeculationFeedbackMessage(
  messages: Message[],
  boundary: CompletionBoundary | null,
  timeSavedMs: number,
  sessionTotalMs: number,
): Message | null {
  // 只对内部员工显示这个工程细节
  if (process.env.USER_TYPE !== 'ant') return null

  // 没跑出东西、或者没省下任何时间 → 不显示（省得刷屏）
  if (messages.length === 0 || timeSavedMs === 0) return null

  const toolUses = countToolsInMessages(messages)
  // 只有真正跑完（complete）才有 outputTokens 可报
  // `boundary?.type === 'complete'` 之后，TS 自动知道 boundary 有 outputTokens 字段
  const tokens = boundary?.type === 'complete' ? boundary.outputTokens : null

  const parts = []
  if (toolUses > 0) {
    // 有工具调用就报工具次数，否则报轮次数。三元表达式做单复数。
    parts.push(`Speculated ${toolUses} tool ${toolUses === 1 ? 'use' : 'uses'}`)
  } else {
    const turns = messages.length
    parts.push(`Speculated ${turns} ${turns === 1 ? 'turn' : 'turns'}`)
  }

  if (tokens !== null) {
    parts.push(`${formatNumber(tokens)} tokens`)
  }

  // 模板字符串（反引号）里嵌 ${} 表达式 ≈ Java 的字符串拼接，但可读性好得多
  const savedText = `+${formatDuration(timeSavedMs)} saved`
  // 只有"本次省的时间"和"整场会话累计"不一样时才额外显示累计值，避免重复啰嗦
  const sessionSuffix =
    sessionTotalMs !== timeSavedMs
      ? ` (${formatDuration(sessionTotalMs)} this session)`
      : ''

  return createSystemMessage(
    // 用 ' · ' 分隔各个片段，最终形如：
    // [ANT-ONLY] Speculated 3 tool uses · 1.2k tokens · +4s saved (12s this session)
    `[ANT-ONLY] ${parts.join(' · ')} · ${savedText}${sessionSuffix}`,
    'warning',
  )
}

/**
 * 更新处于 active 状态的 speculation 状态。
 *
 * 为什么需要它：预执行在后台跑，需要不断把进度（跑了多少工具、停在哪）写回 AppState
 * 让 UI 显示。但这个更新有三个坑，本函数把它们统一处理掉：
 *
 *   ① 状态可能已经不是 active 了（用户刚才中止了）→ 直接原样返回 prev，不更新
 *   ② 更新的字段值可能和原来一样 → 也返回 prev。
 *      这是 React 的关键优化：返回**同一个对象引用**，React 就知道"没变化，不用重渲染"。
 *      预执行每秒可能更新好几次状态，不做这个优化会把 UI 卡死。
 *   ③ 必须**不可变更新**（展开复制），不能就地修改 state 对象
 *
 * @param {SetAppState} setAppState 状态更新函数
 * @param updater 传入当前 active 状态，返回要更新的**部分**字段（Partial = 所有字段都可选）
 */
function updateActiveSpeculationState(
  setAppState: SetAppState,
  // Partial<T> 是 TS 内置工具类型：把 T 的所有字段都变成可选。
  // ≈ Java 里"只填了几个字段的 builder"。
  updater: (state: ActiveSpeculationState) => Partial<ActiveSpeculationState>,
): void {
  setAppState(prev => {
    // ① 已经不是 active（比如用户刚中止）→ 放弃更新
    if (prev.speculation.status !== 'active') return prev
    const current = prev.speculation as ActiveSpeculationState
    const updates = updater(current)
    // Check if any values actually changed to avoid unnecessary re-renders
    // 中文：② 逐个比较新值与旧值，全都没变就返回原对象（避免无谓的重渲染）
    // Object.entries(updates) 把对象转成 [[键, 值], ...] 数组
    // ≈ Java 的 updates.entrySet().stream().anyMatch(...)
    const hasChanges = Object.entries(updates).some(
      // 解构出 [键, 值]；`key as keyof ActiveSpeculationState` 把 string 断言成合法的键
      ([key, value]) => current[key as keyof ActiveSpeculationState] !== value,
    )
    if (!hasChanges) return prev
    // ③ 不可变更新：新 speculation = 旧字段 + 更新字段
    return {
      ...prev,
      speculation: { ...current, ...updates },
    }
  })
}

/**
 * 把 speculation 状态复位到"空闲"。
 *
 * 为什么也要先判断：如果已经是 idle 了还去更新，就会生成一个**新对象**，
 * 导致 React 白白重渲染一次。所以这里也返回原对象。
 */
function resetSpeculationState(setAppState: SetAppState): void {
  setAppState(prev => {
    if (prev.speculation.status === 'idle') return prev
    return { ...prev, speculation: IDLE_SPECULATION_STATE }
  })
}

/**
 * 判断推测执行功能是否开启。
 *
 * 目前的门槛（刻意设得很严）：
 *   ① 必须是内部员工 USER_TYPE=ant
 *   ② 全局配置里没显式关掉
 *
 * 为什么只对内部员工开放：这个功能会**额外消耗大量 token**（预跑可能要跑十几个工具），
 * 而且行为上很激进（在用户没要求时就动手改文件，虽然是写到 overlay 里）。
 * 在产品上还没验证清楚性价比之前，先只在内部跑、靠埋点观察数据。
 *
 * 注意 `?? true`：配置没设过 → 默认开启（对内部员工而言）。
 * 又是"默认开启的可选开关"的惯用写法（不能写成 `!== false` 之外的形式）。
 *
 * @returns {boolean}
 */
export function isSpeculationEnabled(): boolean {
  const enabled =
    process.env.USER_TYPE === 'ant' &&
    (getGlobalConfig().speculationEnabled ?? true)
  logForDebugging(`[Speculation] enabled=${enabled}`)
  return enabled
}

/**
 * 流水线式地**提前准备好下一句建议**。
 *
 * 为什么需要它（这是"流水线"这个名字的由来）：
 * 一次预执行跑完后，如果结果完整（complete），说明模型正在状态上。
 * 与其等用户采纳了再开始猜下一句，不如**现在就猜**——
 * 这样用户按 Tab 的瞬间，下一句的预执行已经在跑了，形成无缝衔接。
 *
 * 做法上有个巧妙之处：它把"这次的建议"和"这次预跑产生的消息"
 * **追加到原始 context 的 messages 后面**，构造出一个 augmentedContext（增强上下文），
 * 让模型以为"用户已经采纳了、活已经干完了"，从而自然地猜出**再下一步**。
 *
 * 结果先暂存在 state.pipelinedSuggestion 里（还不显示），
 * 等用户真的采纳（handleSpeculationAccept）时才"转正"显示出来。
 *
 * @param {REPLHookContext} context 原始上下文
 * @param {string} suggestionText 本次触发预执行的那句建议
 * @param {Message[]} speculatedMessages 本次预跑产生的消息
 * @param {SetAppState} setAppState 状态更新函数
 * @param {AbortController} parentAbortController 父级取消令牌（父级一取消，这里也自动取消）
 */
async function generatePipelinedSuggestion(
  context: REPLHookContext,
  suggestionText: string,
  speculatedMessages: Message[],
  setAppState: SetAppState,
  parentAbortController: AbortController,
): Promise<void> {
  try {
    const appState = context.toolUseContext.getAppState()
    const suppressReason = getSuggestionSuppressReason(appState)
    if (suppressReason) {
      // 原因前缀加 pipeline_ 是为了在埋点里区分"主流程被拦"和"流水线被拦"
      logSuggestionSuppressed(`pipeline_${suppressReason}`)
      return
    }

    // 构造"假装用户已采纳"的增强上下文：
    //   原始消息 + 用户说了那句建议 + 预跑产生的所有消息
    // 这样模型看到的对话就是"活已经干完了"，自然能猜出再下一步。
    const augmentedContext: REPLHookContext = {
      ...context,
      messages: [
        ...context.messages,
        createUserMessage({ content: suggestionText }),
        ...speculatedMessages,
      ],
    }

    // 从父令牌派生子令牌：父级（本次预执行）被 abort 时，这个子任务自动跟着取消。
    // ≈ 父子协程的联动取消。
    const pipelineAbortController = createChildAbortController(
      parentAbortController,
    )
    if (pipelineAbortController.signal.aborted) return

    const promptId = getPromptVariant()
    const { suggestion, generationRequestId } = await generateSuggestion(
      pipelineAbortController,
      promptId,
      createCacheSafeParams(augmentedContext),
    )

    // 和主流程一样：await 回来后必须再查一次 abort（这期间可能已经过了好几秒）
    if (pipelineAbortController.signal.aborted) return
    if (shouldFilterSuggestion(suggestion, promptId)) return

    logForDebugging(
      `[Speculation] Pipelined suggestion: "${suggestion!.slice(0, 50)}..."`,
    )
    // 暂存到 state 里，此刻**还不显示**给用户；
    // 等 handleSpeculationAccept 确认用户采纳后才会"转正"。
    updateActiveSpeculationState(setAppState, () => ({
      pipelinedSuggestion: {
        // `suggestion!` 的非空断言是安全的：上面 shouldFilterSuggestion 已经保证非空
        text: suggestion!,
        promptId,
        generationRequestId,
      },
    }))
  } catch (error) {
    // 用户取消是预期内的，静默返回
    if (error instanceof Error && error.name === 'AbortError') return
    // 其它错误也只记调试日志、不抛出：流水线失败完全不影响主流程，
    // 最坏结果只是"下一句没提前准备好"而已。
    logForDebugging(
      `[Speculation] Pipelined suggestion failed: ${errorMessage(error)}`,
    )
  }
}

/**
 * ★★ 本文件的核心：启动一次**推测执行**。
 *
 * 一句话：拿一句"猜出来"的建议，在后台真的把它跑一遍，但所有写入都落在临时 overlay 里。
 *
 * 为什么需要它（回顾文件头的动机）：
 * 用户阅读 + 打字的那几秒，CPU 和网络是空闲的。这里把这段空闲时间拿去"赌"一把：
 * 猜用户会采纳这句建议，先把活干完。赌赢就省下好几秒，赌输就删掉临时目录，几乎零成本。
 *
 * 关键步骤：
 *   ① 开关检查 + 先中止掉上一次还没结束的预执行（同一时刻只允许一个）
 *   ② 生成本次 id，创建 overlay 目录
 *   ③ 把状态写进 AppState（status: 'active'），UI 据此显示"预跑中"的指示
 *   ④ 调用 runForkedAgent 真正开跑，**每个工具调用都要先过 canUseTool 回调**
 *   ⑤ 跑完 → 标记 boundary = complete，并顺手启动下一句的流水线猜测
 *   ⑥ 出错 → 删 overlay、复位状态、记埋点
 *
 * ⚠️ 整个函数最核心的部分是那个巨大的 `canUseTool` 回调（下面的闭包）：
 *   它是**每一次工具调用**的安检口，负责权限检查、路径重定向、危险命令拦截。
 *   预执行所有的安全性都靠它兜着。
 *
 * @param {string} suggestionText 要预先执行的那句建议（例如 "run the tests"）
 * @param {REPLHookContext} context 主线程的钩子上下文（含消息历史、工具上下文）
 * @param setAppState 状态更新函数
 * @param {boolean} [isPipelined=false] 是否是流水线上的后续轮（用于埋点区分）
 * @param {CacheSafeParams} [cacheSafeParams] 复用主线程传下来的缓存安全参数（省一次构造）
 */
export async function startSpeculation(
  suggestionText: string,
  context: REPLHookContext,
  setAppState: (f: (prev: AppState) => AppState) => void,
  // `isPipelined = false` 是**带默认值的参数** ≈ Java 的重载/可选参数，调用时可省略
  isPipelined = false,
  // `cacheSafeParams?: CacheSafeParams` 可选参数，不传则下面自己构造
  cacheSafeParams?: CacheSafeParams,
): Promise<void> {
  if (!isSpeculationEnabled()) return

  // Abort any existing speculation before starting a new one
  // 中文：① 同一时刻只允许一次预执行。
  // 理由：两次预执行会写同一个 AppState.speculation 字段，互相覆盖；
  // 而且两次都往真实目录回拷文件的话，语义就完全乱了。
  abortSpeculation(setAppState)

  // 本次预执行的唯一 id。randomUUID() 生成 36 字符的 UUID，只取前 8 位足够区分。
  const id = randomUUID().slice(0, 8)

  // 从主线程的 abortController 派生子控制器：
  // 主线程一中断（比如用户 Ctrl+C），这次预执行自动跟着取消。
  const abortController = createChildAbortController(
    context.toolUseContext.abortController,
  )

  if (abortController.signal.aborted) return

  // 记录开始时间 —— 后面用它算"省了多少毫秒"，这是本功能最核心的 KPI
  const startTime = Date.now()
  // ── 下面两个是 "ref 盒子" 模式 ──
  // 用小对象把值包起来，好处：盒子**引用不变**，内部内容随便变，
  // 这样 AppState 不用每次都更新（AppState 是不可变的，更新代价高）。
  // ≈ Java 的 AtomicReference<List<Message>>
  const messagesRef = { current: [] as Message[] }
  // 本次预跑实际写过的文件（相对路径），用户采纳时要靠它把文件回拷到真实目录
  const writtenPathsRef = { current: new Set<string>() }
  const overlayPath = getOverlayPath(id)
  const cwd = getCwdState()

  // ② 创建 overlay 目录。建不出来就没法安全地隔离写入，直接放弃这次预执行。
  try {
    await mkdir(overlayPath, { recursive: true })
  } catch {
    logForDebugging('[Speculation] Failed to create overlay directory')
    return
  }

  // 同样用 ref 盒子存 context：流水线那一轮需要用**最新的** context 继续跑
  const contextRef = { current: context }

  // ③ 把"预执行进行中"的状态写进 AppState，UI 据此显示进度指示
  setAppState(prev => ({
    ...prev,
    speculation: {
      status: 'active',
      id,
      // 存一个闭包，让外部（比如用户中止时）能随时掐掉这次预执行
      abort: () => abortController.abort(),
      startTime,
      messagesRef,
      writtenPathsRef,
      // 还没有结局（跑完/停车时会在 updateActiveSpeculationState 里填上）
      boundary: null,
      suggestionLength: suggestionText.length,
      toolUseCount: 0,
      isPipelined,
      contextRef,
    },
  }))

  logForDebugging(`[Speculation] Starting speculation ${id}`)

  try {
    // ④ 真正开跑。runForkedAgent 会分叉出一个临时 agent 去跑工具循环。
    const result = await runForkedAgent({
      // 把建议伪装成"用户刚说的话"，追加在历史消息后面 → 能命中 prompt cache
      promptMessages: [createUserMessage({ content: suggestionText })],
      // `??` 空值合并：外面传了就用外面的，没传就现场从 context 构造
      cacheSafeParams: cacheSafeParams ?? createCacheSafeParams(context),
      skipTranscript: true,
      // ╔══════════════════════════════════════════════════════════════════╗
      // ║ ★★ 安检口：每一次工具调用都会先经过这个回调 ★★                     ║
      // ║ 预执行的全部安全性都由这个闭包负责。它要做三件事：                  ║
      // ║   A. 权限够不够（写文件需用户本来就允许自动改文件）                 ║
      // ║   B. 把文件路径重定向到 overlay（写时复制）                        ║
      // ║   C. 危险命令 / 未知工具一律拦下并"停车"（记 boundary）            ║
      // ║ 返回值里的 updatedInput 可以**改写**工具的输入参数，                ║
      // ║ 这正是实现路径重定向的机制。                                        ║
      // ╚══════════════════════════════════════════════════════════════════╝
      canUseTool: async (tool, input) => {
        const isWriteTool = WRITE_TOOLS.has(tool.name)
        const isSafeReadOnlyTool = SAFE_READ_ONLY_TOOLS.has(tool.name)

        // Check permission mode BEFORE allowing file edits
        // 中文 A：写工具必须先过权限这一关 —— **在任何路径处理之前**。
        // 顺序很重要：先看有没有资格写，再谈写到哪里。
        if (isWriteTool) {
          const appState = context.toolUseContext.getAppState()
          // 解构出权限模式和"是否可用绕过权限模式"
          const { mode, isBypassPermissionsModeAvailable } =
            appState.toolPermissionContext

          // 只有在"用户本来就允许自动改文件"的模式下，预执行才敢动文件。
          // 默认模式（每次编辑都要弹窗确认）下绝不能偷偷改 —— 那会绕过用户的知情权。
          const canAutoAcceptEdits =
            mode === 'acceptEdits' ||
            mode === 'bypassPermissions' ||
            (mode === 'plan' && isBypassPermissionsModeAvailable)

          if (!canAutoAcceptEdits) {
            logForDebugging(`[Speculation] Stopping at file edit: ${tool.name}`)
            // 从 input 里掏出文件路径。因为 input 是工具专属的结构，
            // 只能用 `'file_path' in input` 这种方式做运行时探测。
            const editPath = (
              'file_path' in input ? input.file_path : undefined
            ) as string | undefined
            // 记下"停在了编辑操作上"，然后 abort —— 这就是一个 boundary（停车点）
            updateActiveSpeculationState(setAppState, () => ({
              boundary: {
                type: 'edit',
                toolName: tool.name,
                // `?? ''` 兜底：拿不到路径也不能让字段变成 undefined
                filePath: editPath ?? '',
                completedAt: Date.now(),
              },
            }))
            abortController.abort()
            return denySpeculation(
              'Speculation paused: file edit requires permission',
              'speculation_edit_boundary',
            )
          }
        }

        // Handle file path rewriting for overlay isolation
        // 中文 B：路径重定向（overlay 隔离）。写工具和只读工具都要处理。
        if (isWriteTool || isSafeReadOnlyTool) {
          // 不同工具的路径参数名不一样：notebook 用 notebook_path，
          // 有的用 path，多数用 file_path。这里三元嵌套逐个探测。
          const pathKey =
            'notebook_path' in input
              ? 'notebook_path'
              : 'path' in input
                ? 'path'
                : 'file_path'
          const filePath = input[pathKey] as string | undefined
          if (filePath) {
            // 算出相对 cwd 的路径。relative() 在跨盘符（Windows）时会返回绝对路径
            const rel = relative(cwd, filePath)
            // 越界检查：绝对路径或 ../ 开头 = 指向 cwd 之外
            if (isAbsolute(rel) || rel.startsWith('..')) {
              if (isWriteTool) {
                // 写越界 → 直接拒绝。绝不允许预执行改到用户工作目录外面去。
                logForDebugging(
                  `[Speculation] Denied ${tool.name}: path outside cwd: ${filePath}`,
                )
                return denySpeculation(
                  'Write outside cwd not allowed during speculation',
                  'speculation_write_outside_root',
                )
              }
              // 读越界 → 放行（读外部文件没有副作用，不影响安全性）
              return {
                behavior: 'allow' as const,
                updatedInput: input,
                decisionReason: {
                  type: 'other' as const,
                  reason: 'speculation_read_outside_root',
                },
              }
            }

            if (isWriteTool) {
              // Copy-on-write: copy original to overlay if not yet there
              // 中文：**写时复制** —— overlay 机制的核心一步。
              // 首次写某个文件时，先把原始文件复制一份到 overlay 的相同相对路径下，
              // 之后工具的写入都落在那份副本上。真实文件一个字节都没动。
              if (!writtenPathsRef.current.has(rel)) {
                const overlayFile = join(overlayPath, rel)
                await mkdir(dirname(overlayFile), { recursive: true })
                try {
                  await copyFile(join(cwd, rel), overlayFile)
                } catch {
                  // Original may not exist (new file creation) - that's fine
                  // 中文：复制失败说明这是个**新文件**（原来不存在），
                  // 那 overlay 里就不需要有原始副本，完全正常，忽略即可。
                }
                // 记进集合：① 用户采纳时要靠它回拷 ② 后面读这个文件时要重定向到 overlay
                writtenPathsRef.current.add(rel)
              }
              // 改写工具的 path 参数，指向 overlay 里的副本。
              // `{ ...input, [pathKey]: 值 }` 是**计算属性名**写法：
              // 方括号里是变量，表示"用这个变量的值当键名" ≈ Java 的 map.put(pathKey, v)
              input = { ...input, [pathKey]: join(overlayPath, rel) }
            } else {
              // Read: redirect to overlay if file was previously written
              // 中文：读操作也要重定向 —— 但**只在**这个文件之前被预跑写过时。
              // 否则会读到旧内容，模型会以为自己的修改没生效（很典型的 bug）。
              if (writtenPathsRef.current.has(rel)) {
                input = { ...input, [pathKey]: join(overlayPath, rel) }
              }
              // Otherwise read from main (no rewrite)
              // 没被写过 → 直接读真实文件，不改写
            }

            logForDebugging(
              `[Speculation] ${isWriteTool ? 'Write' : 'Read'} ${filePath} -> ${input[pathKey]}`,
            )

            return {
              behavior: 'allow' as const,
              // 把改写后的 input 交回去，工具就会操作 overlay 里的路径
              updatedInput: input,
              decisionReason: {
                type: 'other' as const,
                reason: 'speculation_file_access',
              },
            }
          }
          // Read tools without explicit path (e.g. Glob/Grep defaulting to CWD) are safe
          // 中文：Glob/Grep 这类工具可能不传路径（默认搜当前目录），
          // 它们本来就没有副作用，直接放行。
          if (isSafeReadOnlyTool) {
            return {
              behavior: 'allow' as const,
              updatedInput: input,
              decisionReason: {
                type: 'other' as const,
                reason: 'speculation_read_default_cwd',
              },
            }
          }
          // Write tools with undefined path → fall through to default deny
          // 写工具却没给路径 → 不在这里处理，落到最后的"默认拒绝"
        }

        // Stop at non-read-only bash commands
        // 中文 C-1：Bash 是最危险的工具，必须单独严查。
        if (tool.name === 'Bash') {
          const command =
            'command' in input && typeof input.command === 'string'
              ? input.command
              : ''
          // 用现成的只读性校验：非只读命令（rm / mv / curl 等）一律不放行。
          // 注意还额外传了 commandHasAnyCd(command) —— 带 cd 的命令可能绕过 cwd 限制，
          // 所以要交给 checkReadOnlyConstraints 单独判断。
          if (
            !command ||
            checkReadOnlyConstraints({ command }, commandHasAnyCd(command))
              .behavior !== 'allow'
          ) {
            logForDebugging(
              `[Speculation] Stopping at bash: ${command.slice(0, 50) || 'missing command'}`,
            )
            // 停车：记下停在哪条命令上
            updateActiveSpeculationState(setAppState, () => ({
              boundary: { type: 'bash', command, completedAt: Date.now() },
            }))
            abortController.abort()
            return denySpeculation(
              'Speculation paused: bash boundary',
              'speculation_bash_boundary',
            )
          }
          // Read-only bash command — allow during speculation
          // 只读命令（ls / cat / git status / rg 等）没有副作用，放行
          return {
            behavior: 'allow' as const,
            updatedInput: input,
            decisionReason: {
              type: 'other' as const,
              reason: 'speculation_readonly_bash',
            },
          }
        }

        // Deny all other tools by default
        // 中文 C-2：**默认拒绝**（白名单思维的收尾）。
        // 不在白名单里的工具（WebFetch / Task / MCP 工具等）一律拒绝并停车。
        // 这是最安全的默认策略：宁可少跑，不可乱跑。
        logForDebugging(`[Speculation] Stopping at denied tool: ${tool.name}`)
        // 从 input 里尽量掏一个"有辨识度"的字段作为 boundary 的补充说明。
        // 注意用的是 `||` 而不是 `??`：这里**故意**把空字符串也当成"没取到"，
        // 继续尝试下一个字段 —— 这是 `||` 与 `??` 区别的反面例子。
        const detail = String(
          ('url' in input && input.url) ||
            ('file_path' in input && input.file_path) ||
            ('path' in input && input.path) ||
            ('command' in input && input.command) ||
            '',
        ).slice(0, 200)
        updateActiveSpeculationState(setAppState, () => ({
          boundary: {
            type: 'denied_tool',
            toolName: tool.name,
            detail,
            completedAt: Date.now(),
          },
        }))
        abortController.abort()
        return denySpeculation(
          `Tool ${tool.name} not allowed during speculation`,
          'speculation_unknown_tool',
        )
      },
      querySource: 'speculation',
      forkLabel: 'speculation',
      maxTurns: MAX_SPECULATION_TURNS,
      // requireCanUseTool: true —— 强制**每个**工具都走上面的回调，不允许走默认权限逻辑
      overrides: { abortController, requireCanUseTool: true },
      // 每产生一条消息就回调一次，用于实时累积进度
      onMessage: msg => {
        if (msg.type === 'assistant' || msg.type === 'user') {
          // 往 ref 盒子里的数组追加。盒子引用不变，所以 AppState 不需要更新。
          messagesRef.current.push(msg)
          // 消息数超上限 → 立即中止，防止失控
          if (messagesRef.current.length >= MAX_SPECULATION_MESSAGES) {
            abortController.abort()
          }
          if (isUserMessageWithArrayContent(msg)) {
            // 统计这条消息里新增了多少次成功的工具调用
            const newTools = count(
              msg.message.content as { type: string; is_error?: boolean }[],
              b => b.type === 'tool_result' && !b.is_error,
            )
            if (newTools > 0) {
              // 注意这里的 updater 用到了 `prev`（上一个状态），
              // 所以是"累加"而不是"覆盖" —— 与前面那些返回常量对象的 updater 不同
              updateActiveSpeculationState(setAppState, prev => ({
                toolUseCount: prev.toolUseCount + newTools,
              }))
            }
          }
        }
      },
    })

    // 跑完了。但如果中途被 abort 过（比如撞到 boundary），就直接返回，
    // 不要标记成 complete —— 否则会把不完整的结果当成完整的注入会话。
    if (abortController.signal.aborted) return

    // ⑤ 正常跑完 → 标记 boundary = complete。
    // 'complete' as const 的 as const 把类型锁成字面量 'complete' 而不是宽泛的 string。
    updateActiveSpeculationState(setAppState, () => ({
      boundary: {
        type: 'complete' as const,
        completedAt: Date.now(),
        outputTokens: result.totalUsage.output_tokens,
      },
    }))

    logForDebugging(
      `[Speculation] Complete: ${countToolsInMessages(messagesRef.current)} tools`,
    )

    // Pipeline: generate the next suggestion while we wait for the user to accept
    // 中文 ⑥：结果完整，说明模型在状态上 → 立刻开始猜**下一句**并预跑下一句。
    // `void` = 发射后不管（不能 await，否则要等它跑完才返回）
    void generatePipelinedSuggestion(
      contextRef.current,
      suggestionText,
      messagesRef.current,
      setAppState,
      abortController,
    )
  } catch (error) {
    // ⑥ 出错处理。先确保中止掉，避免后台还在跑
    abortController.abort()

    // 用户主动取消是**预期内**的流程（不是 bug），只需静默清理，不打错误日志
    if (error instanceof Error && error.name === 'AbortError') {
      safeRemoveOverlay(overlayPath)
      resetSpeculationState(setAppState)
      return
    }

    // 真出错：先把 overlay 删掉 —— 预跑的东西一律作废，绝不能残留半截状态
    safeRemoveOverlay(overlayPath)

    // eslint-disable-next-line no-restricted-syntax -- custom fallback message, not toError(e)
    logError(error instanceof Error ? error : new Error('Speculation failed'))

    logSpeculation(
      id,
      'error',
      startTime,
      suggestionText.length,
      messagesRef.current,
      null,
      {
        error_type: error instanceof Error ? error.name : 'Unknown',
        // 截断到 200 字符：错误信息可能很长（含堆栈），不宜全量上报
        error_message: errorMessage(error).slice(
          0,
          200,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        // error_phase 区分是"启动阶段"出错还是"采纳阶段"出错
        error_phase:
          'start' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_pipelined: isPipelined,
      },
    )

    resetSpeculationState(setAppState)
  }
}

/**
 * 用户采纳了建议 —— 把预跑的成果**正式落地**。
 *
 * 为什么需要它：这是"赌赢了"的兑现环节。要干三件事：
 *   ① 停掉还在跑的预执行（可能还没跑完，用户就采纳了）
 *   ② 把 overlay 里改过的文件**回拷到真实工作目录**（这才是真正生效的一步）
 *   ③ 计算"省了多少时间"，写埋点、写 transcript
 *
 * 关于"省了多少时间"的算法（值得细看）：
 *     timeSavedMs = min(用户采纳的时刻, 预执行结束的时刻) - 预执行开始的时刻
 * 为什么取 min？因为如果用户**在预执行跑完之前**就采纳了，
 * 那超出的那段时间并不是"省下来的"（预执行还在跑），只算到采纳那一刻为止。
 * 这是个很诚实的算法，避免了把没跑完的部分也算成收益、虚报 KPI。
 *
 * @param {SpeculationState} state 当前 speculation 状态
 * @param setAppState 状态更新函数
 * @param {number} cleanMessageCount 清洗后可用的消息数；为 0 说明没有有效成果，不用回拷文件
 * @returns {Promise<SpeculationResult | null>} 预跑的消息 + 结局 + 省下的毫秒数
 */
export async function acceptSpeculation(
  state: SpeculationState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  cleanMessageCount: number,
): Promise<SpeculationResult | null> {
  // 只在 active 状态下才有东西可兑现
  if (state.status !== 'active') return null

  // 一次性解构出一堆字段 ≈ Java 里写一堆 getter，但一行搞定
  const {
    id,
    messagesRef,
    writtenPathsRef,
    abort,
    startTime,
    suggestionLength,
    isPipelined,
  } = state
  const messages = messagesRef.current
  const overlayPath = getOverlayPath(id)
  const acceptedAt = Date.now()

  // ① 停止预执行（它可能还在跑）
  abort()

  // ② 有有效成果才回拷文件。cleanMessageCount === 0 说明消息全被清洗掉了，
  //    那就别把半截的文件改动覆盖到用户目录里。
  if (cleanMessageCount > 0) {
    await copyOverlayToMain(overlayPath, writtenPathsRef.current, getCwdState())
  }
  // 无论成功与否，overlay 用完即焚
  safeRemoveOverlay(overlayPath)

  // Use snapshot boundary as default (available since state.status === 'active' was checked above)
  // 中文：先用**快照里**的 boundary 兜底（上面已确认 status 是 active，所以字段都在）
  let boundary: CompletionBoundary | null = state.boundary
  // ③ 计算省下的时间：取"采纳时刻"和"预执行结束时刻"的较小值。
  //    `?? Infinity` 的用意：boundary 为 null（还在跑）时 completedAt 取无穷大，
  //    于是 min 自然选中"采纳时刻"。是个很漂亮的写法。
  let timeSavedMs =
    Math.min(acceptedAt, boundary?.completedAt ?? Infinity) - startTime

  setAppState(prev => {
    // Refine with latest React state if speculation is still active
    // 中文：再拿**最新的** React 状态修正一次。
    // 因为传进来的 state 可能是几毫秒前的旧快照，这期间预执行可能刚跑完。
    if (prev.speculation.status === 'active' && prev.speculation.boundary) {
      boundary = prev.speculation.boundary
      const endTime = Math.min(acceptedAt, boundary.completedAt ?? Infinity)
      timeSavedMs = endTime - startTime
    }
    return {
      ...prev,
      // 复位到空闲，并把本次省的时间累加到"整场会话累计节省"里
      speculation: IDLE_SPECULATION_STATE,
      speculationSessionTimeSavedMs:
        prev.speculationSessionTimeSavedMs + timeSavedMs,
    }
  })

  logForDebugging(
    boundary === null
      ? `[Speculation] Accept ${id}: still running, using ${messages.length} messages`
      : `[Speculation] Accept ${id}: already complete`,
  )

  logSpeculation(
    id,
    'accepted',
    startTime,
    suggestionLength,
    messages,
    boundary,
    {
      message_count: messages.length,
      time_saved_ms: timeSavedMs,
      is_pipelined: isPipelined,
    },
  )

  // 把"已采纳"这件事追加写到 transcript 文件里（用于事后复盘/数据集构建）
  if (timeSavedMs > 0) {
    const entry: SpeculationAcceptMessage = {
      type: 'speculation-accept',
      timestamp: new Date().toISOString(),
      timeSavedMs,
    }
    // `void ... .catch()` = 发射后不管，写失败也只记一行调试日志。
    // mode: 0o600 是文件权限（八进制写法，开头的 0o 是 TS/JS 的八进制前缀）：
    // 只有文件所有者可读写 —— transcript 可能含用户代码，必须收紧权限。
    void appendFile(getTranscriptPath(), jsonStringify(entry) + '\n', {
      mode: 0o600,
    }).catch(() => {
      logForDebugging(
        '[Speculation] Failed to write speculation-accept to transcript',
      )
    })
  }

  return { messages, boundary, timeSavedMs }
}

/**
 * 中止一次预执行 —— "赌输了"的回滚路径。
 *
 * 什么时候调用：
 *   ① 用户没采纳、自己打了别的字（最常见的赌输场景，reason 记作 'user_typed'）
 *   ② 启动新一轮预执行前，先清掉旧的
 *
 * 要做三件事：记埋点（aborted）、掐掉执行、删掉 overlay。
 * 顺序上先记埋点再删，因为埋点需要用到 state 里的数据。
 *
 * 注意整个逻辑写在 setAppState 的 updater **内部**：
 * 因为需要先读取当前的 speculation 状态（id / startTime / boundary…），
 * 在 updater 里才能拿到最新的 prev。副作用（abort、删文件）放在 updater 里
 * 虽然不太"纯"，但这里图的是能原子地读到最新状态。
 *
 * @param {SetAppState} setAppState 状态更新函数
 */
export function abortSpeculation(setAppState: SetAppState): void {
  setAppState(prev => {
    if (prev.speculation.status !== 'active') return prev

    const {
      id,
      abort,
      startTime,
      boundary,
      suggestionLength,
      messagesRef,
      isPipelined,
    } = prev.speculation

    logForDebugging(`[Speculation] Aborting ${id}`)

    logSpeculation(
      id,
      'aborted',
      startTime,
      suggestionLength,
      messagesRef.current,
      boundary,
      // 'user_typed' = 用户自己动手打字了，我们的猜测没被采纳
      { abort_reason: 'user_typed', is_pipelined: isPipelined },
    )

    // 掐掉执行
    abort()
    // 删掉 overlay —— 预跑产生的文件改动全部作废，像从没发生过
    safeRemoveOverlay(getOverlayPath(id))

    return { ...prev, speculation: IDLE_SPECULATION_STATE }
  })
}

/**
 * ★★ 用户采纳建议后的**总装流程**：把预跑的成果并入正式会话。
 *
 * 为什么需要它：acceptSpeculation() 只负责"把文件落地 + 算收益"，
 * 而把消息并进会话、更新读文件缓存、启动下一轮，是更上层的编排工作。
 * 本函数就是那个编排者。
 *
 * 关键步骤：
 *   ① 清空 promptSuggestion 状态（建议已被采纳，不应该继续显示）
 *   ② 清洗预跑消息（prepareMessagesForInjection）
 *   ③ **先把用户输入插进会话** —— 在任何异步操作之前，让用户立刻看到反馈
 *   ④ 调用 acceptSpeculation 兑现成果（回拷文件）
 *   ⑤ 如果没有跑完，砍掉末尾的 assistant 消息（API 要求对话必须以 user 消息结尾）
 *   ⑥ 把预跑消息注入会话，并合并"已读文件"缓存
 *   ⑦ 如果跑完了且流水线上备好了下一句建议 → 转正显示 + 启动下一轮预执行
 *   ⑧ 返回值告诉调用方：还需不需要再发一次正式 query
 *
 * 关于 ⑧（这个返回值是整个设计的枢纽）：
 *      queryRequired = false  预跑已经完整做完 → 不用再问模型了，用户直接看到结果
 *      queryRequired = true   预跑只是做了一部分 → 仍要发正式 query 让模型接着做
 *
 * @param {ActiveSpeculationState} speculationState 当前 active 的预执行状态
 * @param {number} speculationSessionTimeSavedMs 本场会话此前累计节省的毫秒数
 * @param {SetAppState} setAppState 状态更新函数
 * @param {string} input 用户实际采纳的那句输入
 * @param deps 依赖项：setMessages（改会话消息）、readFileState（读文件缓存）、cwd
 * @returns {Promise<{ queryRequired: boolean }>} 是否还需要发一次正式的 query
 */
export async function handleSpeculationAccept(
  speculationState: ActiveSpeculationState,
  speculationSessionTimeSavedMs: number,
  setAppState: SetAppState,
  input: string,
  // 把外部依赖打包成一个对象传进来，而不是散成多个参数
  // ≈ Java 里传一个 context/Deps 对象。好处是加依赖时不用改所有调用方。
  deps: {
    setMessages: (f: (prev: Message[]) => Message[]) => void
    readFileState: { current: FileStateCache }
    cwd: string
  },
): Promise<{ queryRequired: boolean }> {
  try {
    const { setMessages, readFileState, cwd } = deps

    // Clear prompt suggestion state. logOutcomeAtSubmission logged the accept
    // but was called with skipReset to avoid aborting speculation before we use it.
    // 中文 ①：清空建议显示。
    // 英文注释补充了两个背景：采纳的埋点已经在别处（logOutcomeAtSubmission）打过了，
    // 而且当时是**特意跳过复位**的（skipReset），就是为了别把这里要用的 speculation 提前中止掉。
    setAppState(prev => {
      // 已经是空的就别再生成新对象（避免无谓的重渲染）
      if (
        prev.promptSuggestion.text === null &&
        prev.promptSuggestion.promptId === null
      ) {
        return prev
      }
      return {
        ...prev,
        promptSuggestion: {
          text: null,
          promptId: null,
          shownAt: 0,
          acceptedAt: 0,
          generationRequestId: null,
        },
      }
    })

    // Capture speculation messages before any state updates - must be stable reference
    // 中文 ②：**必须在任何状态更新之前**先把消息抓在手里。
    // 因为一旦状态变了，预执行可能已经被中止、数组可能被清空。
    // 拿到的必须是一个"稳定引用"，后面全程用它。
    const speculationMessages = speculationState.messagesRef.current
    let cleanMessages = prepareMessagesForInjection(speculationMessages)

    // Inject user message first for instant visual feedback before any async work
    // 中文 ③：**先**把用户消息插进会话，然后才做异步的事。
    // 这是纯 UX 考量：下面 await acceptSpeculation 可能要花几百毫秒（要拷文件），
    // 如果等到那时候才显示用户消息，界面会明显"卡一下"。先显示就有即时反馈感。
    const userMessage = createUserMessage({ content: input })
    setMessages(prev => [...prev, userMessage])

    // ④ 兑现：回拷文件 + 算收益
    const result = await acceptSpeculation(
      speculationState,
      setAppState,
      cleanMessages.length,
    )

    // 只有 boundary 是 'complete' 才算"真的做完了"
    const isComplete = result?.boundary?.type === 'complete'

    // When speculation didn't complete, the follow-up query needs the
    // conversation to end with a user message. Drop trailing assistant
    // messages — models that don't support prefill
    // reject conversations ending with an assistant turn. The model will
    // regenerate this content in the follow-up query.
    // 中文 ⑤：没跑完的话，要砍掉末尾的 assistant 消息。
    // 原因（这条很容易踩坑）：后续那次正式 query 要求**对话必须以上一条 user 消息结尾**。
    // 如果末尾是 assistant 消息，不支持 prefill（预填充）的模型会直接拒绝。
    // 砍掉也没损失 —— 模型在正式 query 里会把这段内容重新生成一遍。
    if (!isComplete) {
      // findLastIndex：从后往前找第一个满足条件的下标（Java 没有原生对应，得倒着遍历）
      const lastNonAssistant = cleanMessages.findLastIndex(
        m => m.type !== 'assistant',
      )
      // slice(0, n+1) 保留到那个位置为止（含）
      cleanMessages = cleanMessages.slice(0, lastNonAssistant + 1)
    }

    const timeSavedMs = result?.timeSavedMs ?? 0
    const newSessionTotal = speculationSessionTimeSavedMs + timeSavedMs
    const feedbackMessage = createSpeculationFeedbackMessage(
      cleanMessages,
      result?.boundary ?? null,
      timeSavedMs,
      newSessionTotal,
    )

    // Inject speculated messages
    // 中文 ⑥：把清洗后的预跑消息注入会话。
    // 这一步之后，模型和用户看到的对话里就"凭空多出了"预跑的那些轮次 —— 这正是省时的来源。
    setMessages(prev => [...prev, ...cleanMessages])

    // 合并"已读文件"缓存：预跑期间模型读过哪些文件、当时的内容是什么，
    // 都要同步进主线程的缓存，否则主线程会以为这些文件没被读过（可能导致重复读或读到旧内容）。
    const extracted = extractReadFilesFromMessages(
      cleanMessages,
      cwd,
      READ_FILE_STATE_CACHE_SIZE,
    )
    readFileState.current = mergeFileStateCaches(
      readFileState.current,
      extracted,
    )

    // 给内部员工显示"省了多少时间"的提示（普通用户返回 null，不显示）
    if (feedbackMessage) {
      setMessages(prev => [...prev, feedbackMessage])
    }

    logForDebugging(
      `[Speculation] ${result?.boundary?.type ?? 'incomplete'}, injected ${cleanMessages.length} messages`,
    )

    // Promote pipelined suggestion if speculation completed fully
    // 中文 ⑦：**转正**流水线上的下一句建议。
    // 之前 generatePipelinedSuggestion 只是暂存在 state 里（不显示），
    // 现在确认用户真的采纳了这一轮，才把它显示出来，并立刻启动下一轮预执行。
    // 条件里的 isComplete 很重要：没跑完的话，下一句建议的前提就不成立了，不能转正。
    if (isComplete && speculationState.pipelinedSuggestion) {
      const { text, promptId, generationRequestId } =
        speculationState.pipelinedSuggestion
      logForDebugging(
        `[Speculation] Promoting pipelined suggestion: "${text.slice(0, 50)}..."`,
      )
      setAppState(prev => ({
        ...prev,
        promptSuggestion: {
          text,
          promptId,
          // 这里填的是真实时间戳（与 promptSuggestion.ts 里填 0 不同）——
          // 因为此刻它就是真的显示给用户了
          shownAt: Date.now(),
          acceptedAt: 0,
          generationRequestId,
        },
      }))

      // Start speculation on the pipelined suggestion
      // 用增强后的上下文（原消息 + 用户输入 + 预跑消息）启动下一轮预执行
      const augmentedContext: REPLHookContext = {
        ...speculationState.contextRef.current,
        messages: [
          ...speculationState.contextRef.current.messages,
          createUserMessage({ content: input }),
          ...cleanMessages,
        ],
      }
      // 最后一个参数 true = isPipelined（标记这是流水线上的一轮，便于埋点区分）
      void startSpeculation(text, augmentedContext, setAppState, true)
    }

    // ⑧ 跑完了就不用再问模型了；没跑完还得接着问
    return { queryRequired: !isComplete }
  } catch (error) {
    // Fail open: log error and fall back to normal query flow
    // 中文：**失败开放（fail open）** 策略 —— 这是整个 catch 块的设计原则。
    // 推测执行只是"锦上添花"的优化，它出任何问题都绝不能影响正常功能。
    // 所以这里不重新抛异常，而是返回 queryRequired: true，
    // 让调用方走**普通的** query 流程（就当这次预跑从没发生过）。
    /* eslint-disable no-restricted-syntax -- custom fallback message, not toError(e) */
    logError(
      error instanceof Error
        ? error
        : new Error('handleSpeculationAccept failed'),
    )
    /* eslint-enable no-restricted-syntax */
    logSpeculation(
      speculationState.id,
      'error',
      speculationState.startTime,
      speculationState.suggestionLength,
      speculationState.messagesRef.current,
      speculationState.boundary,
      {
        error_type: error instanceof Error ? error.name : 'Unknown',
        error_message: errorMessage(error).slice(
          0,
          200,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        // error_phase: 'accept' —— 与 startSpeculation 里的 'start' 区分开
        error_phase:
          'accept' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_pipelined: speculationState.isPipelined,
      },
    )
    // 清理现场：删 overlay + 复位状态，绝不留下半截状态
    safeRemoveOverlay(getOverlayPath(speculationState.id))
    resetSpeculationState(setAppState)
    // Query required so user's message is processed normally (without speculated work)
    // 中文：返回 true = 让用户的消息走正常的完整流程（不带任何预跑的成果）
    return { queryRequired: true }
  }
}
