/**
 * 【一句话定位】压缩**之后**的收尾清理：把那些「被压缩动作弄失效」的缓存与跟踪状态全部清掉。
 * 只做清理，不参与压缩算法本身。
 *
 * 【在架构中的位置】
 * - 上游：所有压缩路径的收尾处——autoCompact（src/services/compact/autoCompact.ts 判定后）
 *   与手动 /compact 命令，都会在完成压缩后调用本文件的 runPostCompactCleanup()；
 *   而自动压缩是被 src/query.ts 的主循环驱动的。
 * - 下游：一大批「缓存清理」函数（系统提示段落、权限审批缓存、bash 权限推测缓存、
 *   CLAUDE.md 记忆缓存、beta 追踪状态、会话消息缓存等），以及
 *   ../contextCollapse/index.js 的 resetContextCollapse() 和 ./microCompact.js 的 resetMicrocompactState()。
 * - 调用链：src/query.ts（主循环）→ compact/autoCompact.ts / /compact 命令 → 本文件 → 各缓存模块
 *
 * 【为什么压缩之后必须清理】
 * 压缩会把历史消息**重写**成一份摘要，原来的消息对象（连同它们的 uuid、tool_use_id）都不复存在。
 * 于是任何「记住了旧消息」的缓存都会变成悬空引用：要么指向已删除的内容，要么算出错误的 token 数。
 * 与其在每个缓存里各自处理，不如在压缩收尾时统一清一次——反正缓存本来就是为了加速而存在，
 * 清掉最多慢一点，不会出错。
 *
 * 【本文件包含什么】
 * - runPostCompactCleanup()：唯一的导出函数，按顺序清掉各类缓存与状态。
 *
 * 【TS 语法速查】
 * - `import { feature } from 'bun:bundle'`：从**打包器内置模块**导入。`feature('X')` 是
 *   **编译期**常量（打包时就被替换成 true/false），不是运行时的 if；
 *   为 false 的分支连同它的 import 会被整体摇掉（tree-shaking）。≈ C 的 `#ifdef`。
 * - `querySource?: QuerySource`：**可选参数**，调用时可以不传，函数体内它是
 *   `QuerySource | undefined`。≈ Java 的 @Nullable 参数（但 TS 强制你处理 undefined）。
 * - `void import('...').then(...)`：**动态 import**，返回 Promise；
 *   前面的 `void` 表示「我知道这是异步的，故意不等它」——触发后让它自己在后台跑完，
 *   避免阻塞压缩收尾流程。≈ Java 里提交个任务到线程池但不 get() 结果。
 * - `a || b || c` 与 Java 的 `||` 一样是短路求值。
 * - `.startsWith('repl_main_thread')`：字符串前缀判断，与 Java 的 String.startsWith 同名同义。
 * - `?.` 可选链：`x?.y` ≈ `x == null ? null : x.y`（≈ Java 的一长串 null 检查）。
 */
import { feature } from 'bun:bundle'
import type { QuerySource } from '../../constants/querySource.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { getUserContext } from '../../context.js'
import { clearSpeculativeChecks } from '../../tools/BashTool/bashPermissions.js'
import { clearClassifierApprovals } from '../../utils/classifierApprovals.js'
import { resetGetMemoryFilesCache } from '../../utils/claudemd.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage.js'
import { clearBetaTracingState } from '../../utils/telemetry/betaSessionTracing.js'
import { resetMicrocompactState } from './microCompact.js'

/**
 * Run cleanup of caches and tracking state after compaction.
 * Call this after both auto-compact and manual /compact to free memory
 * held by tracking structures that are invalidated by compaction.
 *
 * Note: We intentionally do NOT clear invoked skill content here.
 * Skill content must survive across multiple compactions so that
 * createSkillAttachmentIfNeeded() can include the full skill text
 * in subsequent compaction attachments.
 *
 * querySource: pass the compacting query's source so we can skip
 * resets that would clobber main-thread module-level state. Subagents
 * (agent:*) run in the same process and share module-level state
 * (context-collapse store, getMemoryFiles one-shot hook flag,
 * getUserContext cache); resetting those when a SUBAGENT compacts
 * would corrupt the MAIN thread's state. All compaction callers should
 * pass querySource — undefined is only safe for callers that are
 * genuinely main-thread-only (/compact, /clear).
 */
/**
 * 压缩成功后统一清理各类缓存与跟踪状态。
 *
 * 为什么需要：压缩重写了历史，所有「记住旧消息」的缓存都变成了悬空引用，
 * 必须在收尾时一次性清干净，否则会出现算错 token、引用已删除 tool_use_id 之类的问题。
 *
 * @param querySource 触发这次压缩的查询来源。用来判断这次压缩发生在**主线程还是子代理**——
 *   子代理（agent:*）和主线程跑在**同一个进程**里、共享模块级状态，
 *   如果子代理压缩时去重置那些全局状态，会把主线程的缓存一起清掉（互相踩）。
 *   传 undefined 只在「确定只有主线程会走这条路」的调用方（/compact、/clear）才是安全的。
 *
 * 关键步骤：
 *   ① 先判断是不是主线程压缩（下面那行 startsWith 判断）
 *   ② 无论如何都重置 microcompact 状态（这是每个会话独立的，不存在跨线程踩踏问题）
 *   ③ 主线程才重置 context-collapse 状态与记忆文件缓存
 *   ④ 清掉与会话内容强相关的系统提示段落、审批缓存、bash 权限推测缓存
 *   ⑤ 异步（不等结果）清理 attribution 的文件内容缓存
 *   ⑥ 最后清掉会话消息缓存
 *
 * 注意：这里**故意不清理** invoked skill 的内容（见原英文注释）——
 * skill 正文必须能跨多次压缩存活下来，否则 createSkillAttachmentIfNeeded()
 * 在后续压缩时就拼不出完整的 skill 文本了。
 */
export function runPostCompactCleanup(querySource?: QuerySource): void {
  // Subagents (agent:*) run in the same process and share module-level
  // state with the main thread. Only reset main-thread module-level state
  // (context-collapse, memory file cache) for main-thread compacts.
  // Same startsWith pattern as isMainThread (index.ts:188).
  // 中文补充：子代理（querySource 形如 agent:xxx）与主线程**共用进程、共用模块级变量**。
  // 所以凡是「模块级全局状态」（context-collapse store、getMemoryFiles 一次性钩子标记、
  // getUserContext 缓存），都只能在主线程压缩时重置，否则子代理会踩坏主线程。
  const isMainThreadCompact =
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'

  // ① microcompact 状态总是重置：它记录的是「本会话哪些工具结果已经被清过」，
  //    压缩后历史被重写，这份记录必须作废，否则会误判「这个结果已经处理过了」。
  resetMicrocompactState()
  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      // ② 用 require 动态加载而不是顶层 import：只有 feature 打开时才需要这个模块，
      //    顶层 import 会把它无条件拉进依赖图（连带它的一堆依赖）。
      //    `as typeof import(...)` 是给 require 的返回值补上类型（require 返回 any）。
      ;(
        require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
      ).resetContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  if (isMainThreadCompact) {
    // getUserContext is a memoized outer layer wrapping getClaudeMds() →
    // getMemoryFiles(). If only the inner getMemoryFiles cache is cleared,
    // the next turn hits the getUserContext cache and never reaches
    // getMemoryFiles(), so the armed InstructionsLoaded hook never fires.
    // Manual /compact already clears this explicitly at its call sites;
    // auto-compact and reactive-compact did not — this centralizes the
    // clear so all compaction paths behave consistently.
    // `?.()` 是「可选调用」：如果 clear 这个方法不存在，整句安静地什么都不做，不会抛异常。
    // 这比 Java 里写 if (x != null) x.clear() 简洁得多。
    getUserContext.cache.clear?.()
    resetGetMemoryFilesCache('compact')
  }
  // ④ 以下几项的共同点：它们缓存的内容都**来源于会话历史**，压缩后来源变了，缓存随之失效。
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // Intentionally NOT calling resetSentSkillNames(): re-injecting the full
  // skill_listing (~4K tokens) post-compact is pure cache_creation. The
  // model still has SkillTool in schema, invoked_skills preserves used
  // skills, and dynamic additions are handled by skillChangeDetector /
  // cacheUtils resets. See compactConversation() for full rationale.
  // 原英文注释说明：这里**故意不**调用 resetSentSkillNames()——重新注入完整的 skill_listing
  // （约 4K token）在压缩后纯粹是 cache_creation 开销；模型 schema 里仍有 SkillTool，
  // 用过的 skill 由 invoked_skills 保留，动态变更由 skillChangeDetector / cacheUtils 处理。
  clearBetaTracingState()
  if (feature('COMMIT_ATTRIBUTION')) {
    // ⑤ `void 表达式` 表示「故意丢弃返回值」；这里是 fire-and-forget：
    //    清理文件内容缓存不紧急，没必要让压缩收尾等它。
    void import('../../utils/attributionHooks.js').then(m =>
      m.sweepFileContentCache(),
    )
  }
  clearSessionMessagesCache()
}
