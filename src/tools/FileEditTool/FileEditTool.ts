/**
 * ============================================================================
 *  【一句话定位】FileEditTool.ts —— 就地「字符串替换」式改文件（Claude Code 的手术刀）
 * ============================================================================
 *
 *  它不做"整篇重写"，而是让模型给出一对字符串：
 *
 *      old_string  —— 我要改的那段原文（必须原样出现在文件里）
 *      new_string  —— 改完之后的样子
 *
 *  工具在文件中定位 old_string，替换成 new_string，其余字节一个都不动。
 *
 * ---------------------------------------------------------------------------
 *  【为什么要这么设计？——省 token，也缩小"出错半径"】
 * ---------------------------------------------------------------------------
 *  假设要改一个 5000 行文件里的一处变量名：
 *    · 用 FileWriteTool：模型得把 5000 行**重新输出一遍** —— 慢、贵、还容易抄错；
 *    · 用 FileEditTool：模型只输出"前后各几行上下文 + 改动本身"，几十个 token 搞定。
 *
 *  更重要的是安全：模型**没有输出**的那些段落，它就不可能改坏。
 *  这比"让模型复述整份文件"的容错率高一个数量级。
 *
 *  代价是什么？——字符串替换天然有歧义：old_string 若在多处命中，到底改哪一处？
 *  本文件的答案是 **宁可不改，也不许改错**：
 *      · 命中 0 次   → 报错 "String to replace not found"（errorCode 8）
 *      · 命中 ≥2 次 且 replace_all=false → 报错，逼模型补更多上下文（errorCode 9）
 *      · 只有恰好命中 1 次（或模型显式声明 replace_all=true）才放行
 *  这套「强制唯一匹配」是本工具防误改的核心设计，实现在 validateInput() 后半段。
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置 / 调用链】
 * ---------------------------------------------------------------------------
 *      模型返回 tool_use 块 { name: 'Edit', input: { file_path, old_string, new_string } }
 *        └─> 工具框架 src/Tool.ts 的 buildTool({...})
 *              ├─> validateInput()                 ★本文件：准入校验（能不能改）
 *              │     ├─> checkTeamMemSecrets()              ← ../../services/teamMemorySync/teamMemSecretGuard.js
 *              │     │                                        （防止把密钥写进团队共享记忆文件）
 *              │     ├─> checkWritePermissionForTool()       ← ../../utils/permissions/filesystem.js（写权限）
 *              │     ├─> matchingRuleForInput(...,'deny')    ← 同上（deny 规则优先于一切）
 *              │     ├─> findSimilarFile()/suggestPathUnderCwd() ← ../../utils/file.js（文件不存在时给"你是不是要找…"提示）
 *              │     ├─> findActualString()                  ← ./utils.js ★（做智能引号归一化后再匹配）
 *              │     └─> validateInputForSettingsFileEdit()  ← ../../utils/settings/validateEditTool.js
 *              │                                              （改 settings.json 前先把结果做一次 JSON 体检）
 *              ├─> call()                          ★本文件：真正执行（怎么改）
 *              │     ├─> discoverSkillDirsForPaths()         ← ../../skills/loadSkillsDir.js（改到 skills 目录时热加载）
 *              │     ├─> fileHistoryTrackEdit()              ← ../../utils/fileHistory.js（改前留档，支持 undo）
 *              │     ├─> readFileForEdit()                   ← ★本文件内部函数（同步读盘，保证原子性）
 *              │     ├─> getPatchForEdit()                   ← ./utils.js（生成结构化 diff，供 UI 上色）
 *              │     ├─> writeTextContent()                  ← ../../utils/file.js（真正落盘）
 *              │     └─> getLspServerManager()               ← ../../services/lsp/manager.js
 *              │                                              （通知 language server 重算诊断/跳转索引）
 *              └─> mapToolResultToToolResultBlockParam()  ★本文件：把结果翻译成模型能读的那句"已更新"
 *
 *  与兄弟工具的分工（务必记住这张表）：
 *      ┌────────────────┬──────────────────────────┬────────────────────────────┐
 *      │                │ 输入形态                 │ 适用场景                   │
 *      ├────────────────┼──────────────────────────┼────────────────────────────┤
 *      │ FileWriteTool  │ 整份文件内容             │ 新建文件 / 大范围重写      │
 *      │ FileEditTool   │ old_string + new_string  │ 已存在文件的局部精准修改   │
 *      │ NotebookEdit   │ cell_id/source           │ .ipynb 笔记本（本文件明确拒绝处理）│
 *      └────────────────┴──────────────────────────┴────────────────────────────┘
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   1. MAX_EDIT_FILE_SIZE   常量：超过 1 GiB 的文件拒绝编辑（防 OOM）
 *   2. FileEditTool         buildTool({...}) 产出的工具对象，本文件主体
 *   3. readFileForEdit()    内部小工具：同步读盘，顺带读出编码与换行符，写回时原样保留
 *
 *  FileEditTool 对象里的「槽位」都是**可选钩子**，缺哪个工具框架就用默认值：
 *      name / searchHint / maxResultSizeChars / strict   工具元信息
 *      description() / prompt()                          给模型看的说明书（正文在 ./prompt.ts）
 *      inputSchema() / outputSchema()                    参数结构定义（在 ./types.ts）
 *      validateInput()                                   ★ 准入校验
 *      checkPermissions() / preparePermissionMatcher()   权限判定
 *      call()                                            ★ 真正干活
 *      inputsEquivalent()                                两次输入是否等价（幂等去重用）
 *      mapToolResultToToolResultBlockParam()             翻译成 tool_result 文本
 *      renderToolUseMessage 等四个                       UI 渲染（都在 ./UI.tsx）
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查 · 针对本文件实际出现的写法 · Java 对照】
 *  --------------------------------------------------------------------------
 *   · `buildTool({...})` 一个大对象字面量。
 *     ≈ Java 里"匿名内部类 + 一堆 @Override"的紧凑写法，把一组函数直接塞进去。
 *     其中 `async validateInput(input, ctx) { ... }` 是**方法简写**，等价于
 *     `validateInput: async function (input, ctx) { ... }`。
 *
 *   · `} satisfies ToolDef<...>)`
 *     `satisfies`（TS 4.9+）= "请检查这个对象是否符合该类型，但别把它的具体类型擦掉"。
 *     ≈ Java 的 `implements ToolDef<...>`；区别在于若改用 `:` 标注，TS 会把字面量的
 *     精确类型上擦成接口类型，而 satisfies 保留每个字段的真实窄类型。
 *
 *   · `ReturnType<typeof inputSchema>`
 *     先把"函数 inputSchema"喂给 typeof 得到函数类型，再用 ReturnType<> 取出返回值类型。
 *     ≈ 类型层面的一次"函数调用"，Java 里没有对应物。
 *
 *   · `const { file_path, old_string, replace_all = false } = input` 解构
 *     ≈ Java 21 记录模式匹配，但 TS 里日常到每几行就来一次。
 *     `replace_all = false` 是**解构默认值**，语义是
 *     `replace_all = input.replace_all === undefined ? false : input.replace_all`。
 *     ⚠️ 用的是 `=` 而不是 `??`：只兜 undefined，**不兜 null**（也不兜 false）。
 *
 *   · validateInput 的返回值是**联合类型**：
 *       有时 `{ result: true }`，有时 `{ result: false, message, errorCode }`。
 *     TS 自动把两者并成一个 union。≈ Java 的 sealed interface + 两个 record 实现。
 *     调用方靠 `if (r.result === false)` 收窄到第二种形态。
 *
 *   · `{ ...(gitDiff && { gitDiff }) }`
 *     展开运算符的条件版：`false && {...}` 结果是 false，展开 false 等于啥也没做；
 *     为真时才把 `{ gitDiff }` 摊进对象。等价于"有值才加这个字段"，写法比较绕。
 *
 *   · 形参名 `_`：约定俗成表示"这个参数我不用"。
 *     `call(input, ctx, _, parentMessage)` 里第三个位置被刻意跳过。
 *
 *   · `catch (e)` 里 e 的类型是 `unknown`（TS 严格设定），不能直接读 e.message，
 *     必须先经 `isENOENT(e)` 这类**类型谓词**函数收窄。
 *     ≈ Java 里 catch(Throwable t) 之后必须先 instanceof 才能强转。
 *
 *   · `?.` 可选链、`??` 空值合并、`!` 非空断言、`as X` 强转，见仓库总注释；
 *     特别留意 `?? false` 与 `|| false` 的差别：`0` 和 `''` 不会被 `??` 替换。
 *
 *   · 类型标注一律在**变量/参数名后面**：`function f(a: string): void`
 *     （Java 是 `void f(String a)`，正好反过来，初期最容易看串）
 *
 * ---------------------------------------------------------------------------
 *  【一句话记住本文件】
 * ---------------------------------------------------------------------------
 *      改之前先问十个"能不能改"（validateInput）→ 用最少字节落地（call）
 *      → 把"已更新"这句人话格式化回给模型（mapToolResultToToolResultBlockParam）。
 */
import { dirname, isAbsolute, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
  writeTextContent,
} from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import {
  FILE_EDIT_TOOL_NAME,
  FILE_UNEXPECTEDLY_MODIFIED_ERROR,
} from './constants.js'
import { getEditToolDescription } from './prompt.js'
import {
  type FileEditInput,
  type FileEditOutput,
  inputSchema,
  outputSchema,
} from './types.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
import {
  areFileEditsInputsEquivalent,
  findActualString,
  getPatchForEdit,
  preserveQuoteStyle,
} from './utils.js'

 * ┌─ Java 工程师视角：为什么这里要设一个"文件上限" ────────────────────────┐
 * │ 下面这行 const 是一个**模块级常量**（≈ Java 的 private static final）。   │
 * │ 它存在的唯一理由：后面 getPatchForEdit / findActualString 都要把整个文件   │
 * │ 读成**一个字符串**再做 String.split/replaceAll。JS 的字符串长度上限约     │
 * │ 2^30（约 10 亿字符），超过就直接 OOM 或被引擎拒绝。                       │
 * │                                                                          │
 * │ 注意单位是 **stat 出来的字节数**，不是字符数：                            │
 * │   · 纯 ASCII：1 字节 ≈ 1 字符，所以 1 GiB 字节 ≈ 10 亿字符 ≈ 引擎上限；   │
 * │   · 多字节 UTF-8（中文等）：同样字符数占更多字节，所以按字节卡 1 GiB 反而  │
 * │     更保守。这是个"宁可少管一点、也别把进程搞挂"的取舍。                 │
 * └──────────────────────────────────────────────────────────────────────────┘
// V8/Bun string length limit is ~2^30 characters (~1 billion). For typical
// ASCII/Latin-1 files, 1 byte on disk = 1 character, so 1 GiB in stat bytes
// ≈ 1 billion characters ≈ the runtime string limit. Multi-byte UTF-8 files
// can be larger on disk per character, but 1 GiB is a safe byte-level guard
// that prevents OOM without being unnecessarily restrictive.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB (stat bytes)

/**
 * FileEditTool —— 用 buildTool({...}) "装配"出来的工具对象。
 *
 * 【为什么要这么绕？】
 * 直接写一个 object 字面量也行，但 buildTool 会补默认值、挂载类型、做参数合法性巡检，
 * 并保证每个工具对外暴露的形状一致。≈ Java 里的 Builder + 抽象基类模式的合体：
 * 你只填关心的回调，其余由框架兜底。
 *
 * 【生成的对象会被谁用】
 * 会被收集进工具注册表，模型在 response 里返回 `{ type:'tool_use', name:'Edit', input:{...} }`
 * 时，框架按 name 找到它，依次调用 validateInput → checkPermissions → call。
 *
 * 【注意 export】export 表示对外可见（≈ Java 的 public class），
 * 其它模块通过 `import { FileEditTool } from './FileEditTool.js'` 拿到它。
 */
export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  // 工具的"注册名"，常量来自 ./constants.ts。模型在 tool_use 里填的就是这个名字。
  // 不直接写字面量 'Edit' 是为了避免拼写漂移：改名只改一处常量即可。
  searchHint: 'modify file contents in place',
  // 给「工具检索/提示」用的短描述：当候选工具太多时帮助筛选出这一把。
  // 注意它和 prompt() 不同——prompt() 是给模型看的完整说明书，这个是给系统内部排序用的。
  maxResultSizeChars: 100_000,
  // 结果回传给模型时的字符上限（≈10 万字符）。超过会被截断。
  // `100_000` 里的下划线是**数字分隔符**，纯粹为了可读性，等价于 100000
  // （≈ Java 的 100_000，同样是 JDK7 起的写法）。
  strict: true,
  // strict=true：要求 inputSchema 声明为严格模式（不允许模型塞 schema 之外的多余字段）。
  // 目的是让模型"按合同办事"，防止它自创参数名导致静默失败。
  /**
   * 一行式简介，主要用于 UI / 调试面板展示。
   * 与 prompt() 的分工：prompt() 是给模型看的**长说明书**，这个是给**人**看的标题。
   * 标了 async 是因为其它工具的简介可能需要异步获取（比如按 feature flag 变化），
   * 这里为了接口统一也跟着 async，虽然本函数内部并不需要 await。
   */
  async description() {
    return 'A tool for editing files'
  },
  async prompt() {
    return getEditToolDescription()
  },
  // 用户在 UI 上看到的名字，实现在 ./UI.tsx。这里只做「转发」——
  // 把 UI.tsx 导出的函数原样挂到对象上（属性简写：`userFacingName,` ≡ `userFacingName: userFacingName,`）。
  userFacingName,
  getToolUseSummary,
  /**
   * 生成一句"正在做什么"的进展文案（UI 转圈时显示）。
   *
   * @param input 模型传来的原始入参（此时尚未做严格 schema 校验，故用宽松取值）
   * @returns 一句话文案，例如 'Editing src/foo.ts'
   *
   * 为什么 input 没有类型标注？因为它由 `satisfies ToolDef<ReturnType<typeof inputSchema>, ...>`
   * **反向推导**出来（上下文类型推断），写不写都一样。≈ Java 的菱形推断 <>，但更强。
   */
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing ${summary}` : 'Editing file'
  },
  // getter 形式（注意 `get` 关键字）：每次读取都**重新调用** ./types.ts 的 inputSchema()。
  // 之所以不用普通属性值，是因为 schema 里可能含取决于运行时配置/feature flag 的字段，
  // 需要"用时再算"，而不是模块加载时固化。≈ Java 里懒加载的 getter。
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  /**
   * 把入参压成一行文本，供「自动判定工具调用是否安全」的分类器使用。
   *
   * 为什么只拼 file_path + new_string？
   *   因为**危险信号都在这两项**：改哪个文件 + 写进去什么内容
   *   （比如出现 rm -rf、curl | bash、私钥串）。old_string 只是"定位用"，无风险信息。
   */
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.new_string}`
  },
  /**
   * 【给工具框架的统一钩子】"这个工具操作的是哪个文件？"
   * 有了它，框架就能做通用的事情：权限检查、统计改动文件集合、"本轮改了哪些文件"提示等，
   * 而不必为每个工具写一套。≈ Java 的模板方法模式里的那个抽象 getter。
   */
  getPath(input): string {
    return input.file_path
  },
  /**
   * 【安全相关，别小看这 5 行】在权限 hook 运行**之前**把路径规范化。
   *
   * 为什么要先把 ~ 和相对路径展开成绝对路径？
   *   因为 hook 的白名单是按路径匹配的。若留着 `~/x` 或 `../x`，
   *   攻击者可以绕过白名单：白名单写的是 /Users/a/project/*，
   *   而实际展开后可能落在完全不同的目录。
   *   所以必须"先展开、再匹配"，而不是"先匹配、后展开"。
   *
   * 为什么叫 "backfill"（回填）？
   *   因为它**原地修改** input.file_path，把规范化后的值填回去。
   *   ≈ Java 里直接改传入对象的字段（Java 工程师熟悉的副作用写法）。
   *
   * 为什么不用 `?.`：`typeof input.file_path === 'string'` 是显式类型守卫，
   *   既排除了 undefined，也排除了模型不小心传数字/对象的畸形情况。
   */
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  /**
   * 造出一个"路径匹配器"闭包，供权限规则（Edit(./src/**) 之类）判断是否命中。
   *
   * 【为什么要分两步？】直接 inline 判断也行，但拆成 prepare + match 的好处是：
   * 同一份入参要拿去和**很多条**规则比对时，昂贵的准备工作（路径展开、大小写归一）
   * 只做一次，而不是每条规则重做一遍。
   *
   * 【TS 语法】返回的是一个**箭头函数**（≈ Java lambda）：
   *     pattern => matchWildcardPattern(pattern, file_path)
   *   ≈ Java: (pattern) -> matchWildcardPattern(pattern, file_path)
   * 它捕获了外层解构出来的 file_path —— 这就是闭包。
   */
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  /**
   * 判定这次调用能不能放行。
   *
   * @returns PermissionDecision —— 一个"判决"（allow / deny / ask）。
   *   注意 'ask' 是三态里的第三态：不是简单的是/否，而是"要弹窗问用户"。
   *
   * 【为什么这里要从 context 里取权限配置，而不是读全局变量？】
   *   因为 context 代表"本次调用所依附的会话状态"，便于测试注入和多会话隔离。
   *   ≈ Java 里把配置对象从构造函数注入，而不是直接读 static 单例。
   *
   * 【TS 语法】返回类型写在参数列表**后面**：`(input, context): Promise<PermissionDecision>`
   *   Promise<T> ≈ Java 的 CompletableFuture<T>。
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  /**
   * 【本文件最重要的函数】准入校验 —— 决定"这次编辑能不能做"。
   *
   * 为什么需要它（而不是直接在 call() 里改）：
   *   ① 可以在**动磁盘之前**把绝大多数非法情况挡掉，并给出**可被模型理解**的
   *      错误文案——模型看到 message 后会自己纠正参数重试（这是 agent 能自我修复的关键）；
   *   ② 校验结果可以被 UI 拿去渲染"待确认"卡片；
   *   ③ 把"能不能改"和"怎么改"分离，便于单独测试。
   *
   * @param input           模型传来的 { file_path, old_string, new_string, replace_all }
   * @param toolUseContext  本次调用的上下文（含 AppState、readFileState 等会话状态）
   * @returns { result: true, meta? } 或 { result: false, message, behavior, errorCode, meta? }
   *
   *   · `behavior: 'ask'` —— 表示"不要直接拒绝，把 message 回给模型让它重试"，
   *     区别于真正的"拒绝执行"。这是能不能自我修复的分水岭。
   *   · `errorCode` —— 纯给日志/统计用的编号，**每种失败原因一个号**（下面逐个标注）。
   *     有了它才能做"哪类错误最常发生"的数据分析。
   *   · `meta.actualOldString` —— 关键！校验阶段**归一化后的** old_string，
   *     通过 meta 传给后面的 call()，避免第二阶段重复算一遍（也能保证两阶段用同一份结果）。
   *
   * 【整体顺序是有讲究的】从"最便宜/最该先挡"到"最贵"：
   *   ① 纯参数层（old===new）         —— 零 IO
   *   ② 权限层（deny 规则）           —— 纯内存
   *   ③ 路径层（UNC 安全特判）        —— 纯字符串
   *   ④ 文件大小（stat）              —— 一次 IO
   *   ⑤ 读文件内容（readFileBytes）   —— 一次大 IO
   *   ⑥ 业务层（notebook / 未读 / 被改过 / 找不到 / 多处命中 / settings 体检）
   * 便宜的检查放前面，能省掉大量无效 IO。
   *
   * ── 关键步骤一览 ──────────────────────────────────────────────────────
   * ① 展开路径、拒绝含密钥的写入
   * ② old_string === new_string 直接判为"无事可做"
   * ③ deny 规则命中即拒绝（errorCode 2）
   * ④ Windows UNC 路径直接放行给权限层处理，避免 SMB 认证泄漏凭据（安全红线）
   * ⑤ 超大文件拒绝，防 OOM（errorCode 10）
   * ⑥ 读文件（自己判断 UTF-16 BOM 决定编码），文件不存在时给"你是不是要找…"提示
   * ⑦ .ipynb 拒绝并引导去用 NotebookEditTool（errorCode 5）
   * ⑧ 必须先 Read 过（readFileState 里有记录且不是局部视图）才能真正改 ← 见下方详细说明
   * ⑨ 读出之后若文件被外部改动过则拒绝（errorCode 7），带 Windows 时间戳误报兜底
   * ⑩ findActualString 归一化引号后定位 old_string（errorCode 8）
   * ⑪ 【核心】统计命中次数：>1 且非 replace_all → 拒绝并要求补充上下文（errorCode 9）
   * ⑫ 改 settings 类文件时预演一遍结果做 JSON 体检
   * ⑬ 通过，并把归一化后的 actualOldString 经 meta 交给 call()
   * ─────────────────────────────────────────────────────────────────────
   */
  async validateInput(input: FileEditInput, toolUseContext: ToolUseContext) {
    const { file_path, old_string, new_string, replace_all = false } = input
    // Use expandPath for consistent path normalization (especially on Windows
    // where "/" vs "\" can cause readFileState lookup mismatches)
    const fullFilePath = expandPath(file_path)

    // Reject edits to team memory files that introduce secrets
    // 【为什么把"团队记忆文件里的密钥"当成一等公民来拦？】
    // CLAUDE.md 这类团队记忆文件会被同步给整个团队。一旦模型把 AK/SK、token 写进去，
    // 等于向全团队广播凭据。所以这不是"输入校验"，而是**数据泄漏防线**。
    const secretError = checkTeamMemSecrets(fullFilePath, new_string)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }
    // errorCode 1：old 与 new 完全相同 ⇒ 改了等于没改。
    // 与其静默成功让模型以为生效了，不如明确告诉它"无事可做"，避免它反复重试。
    if (old_string === new_string) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        errorCode: 1,
      }
    }

    // Check if path should be ignored based on permission settings
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    // errorCode 2：被 deny 规则覆盖。
    // 注意顺序——deny 检查刻意排在文件读取之前：被禁的目录连 stat 都不该去做。
    // `!== null` 而不是 `if (denyRule)`：因为返回值可能是 undefined/null/false，
    // 显式判 null 是为了只认"明确命中了几条规则"这一种语义。
    if (denyRule !== null) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 2,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    // 【为什么要 return true 放行？看起来像是"漏判"其实是刻意设计】
    // Windows 的 UNC 路径（\\server\share 或 //server/share）上调用 fs.existsSync
    // 会触发 SMB 认证握手，可能被恶意服务器**套走本机凭据（NTLM）**。
    // 所以这里不碰文件系统，直接放行交由权限层用字符串规则判断——安全优先于便利。
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()

    // Prevent OOM on multi-GB files.
    try {
    // 先 stat 拿大小而**不读内容**：只花一次便宜的系统调用就能把"几 GB 的大文件"挡掉。
    // （若先读内容再判大小，该读的早就读进内存了，白 OOM 一次。）
      const { size } = await fs.stat(fullFilePath)
      if (size > MAX_EDIT_FILE_SIZE) {
        return {
          result: false,
          behavior: 'ask',
          message: `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
          errorCode: 10,
        }
      }
    } catch (e) {
      // 只有"文件不存在"这一种错误才吞掉继续往下走（后面会走到"创建新文件"分支）；
      // 其余（权限不足 EACCES、路径是目录等）一律 throw 向上冒泡。
      // 这是 TS/JS 的常见写法：catch 里做**类型谓词收窄**再决定 swallow or rethrow。
      if (!isENOENT(e)) {
        throw e
      }
    }

    // Read the file as bytes first so we can detect encoding from the buffer
    // instead of calling detectFileEncoding (which does its own sync readSync
    // and would fail with a wasted ENOENT when the file doesn't exist).
    let fileContent: string | null
    try {
      // 【为什么先读成 Buffer 再转字符串，而不是一步 readFile(path,'utf8')？】
      // 因为要根据**文件头的 BOM** 判断它是 UTF-16LE 还是 UTF-8（见下面两行）。
      // 一步到位读成字符串的话，BOM 信息已被解码吞掉，就没法判断了。
      // 顺序必须是：拿字节 → 看头两个字节 → 决定用哪种编码 toString。
      const fileBuffer = await fs.readFileBytes(fullFilePath)
      const encoding: BufferEncoding =
        fileBuffer.length >= 2 &&
        fileBuffer[0] === 0xff &&
        fileBuffer[1] === 0xfe
          ? 'utf16le'
          : 'utf8'
      // 统一把 CRLF 归一成 LF 再做匹配。
      // 【为什么？】否则模型给的 old_string 用 \n，而 Windows 文件里是 \r\n，
      // 会永远匹配不上，报一堆莫名其妙的 "String to replace not found"。
      // 注意：这只是**内存里的临时归一**，写回时另有 lineEndings 信息负责还原给磁盘。
      fileContent = fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
    } catch (e) {
      if (isENOENT(e)) {
        fileContent = null
      } else {
        throw e
      }
    }

    // File doesn't exist
    if (fileContent === null) {
      // Empty old_string on nonexistent file means new file creation — valid
      // old_string 为空 = "我要在空白处插入内容"。
      // 文件不存在 + old_string 为空 ⇒ 这就是**新建文件**的语义，允许。
      if (old_string === '') {
        return { result: true }
      }
      // Try to find a similar file with a different extension
      // 【为什么要费劲猜相近文件名？】
      // 模型给出的路径常常是"记错的"：扩展名写了 .js 实际是 .ts，或根本不存在。
      // 给一句 "Did you mean ...?" 比干巴巴的 "File does not exist" 有用得多——
      // 模型能据此**自我纠正**再试一次，一次往返就修好。
      // cwdSuggestion 优先（路径在 cwd 下有近似），其次才猜同名不同后缀的文件。
      const similarFilename = findSimilarFile(fullFilePath)
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`

      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        behavior: 'ask',
        message,
        errorCode: 4,
      }
    }

    // File exists with empty old_string — only valid if file is empty
    // 走到这里说明：文件**存在**且 old_string 为空。
    // 语义上这是"新建文件"，但文件已经在了 —— 这时只允许一种情况继续：文件是空的。
    if (old_string === '') {
      // Only reject if the file has content (for file creation attempt)
      // errorCode 3：非空文件 + 空 old_string ⇒ 拒绝了。
      // 为什么不用写入 "{{.fullFilePath}}"? 因为模型很可能是**记错文件名**才走到这里，
      // 若允许，等于让它不明不白地在已有文件开头追加内容。宁可报错让它想清楚。
      // `.trim()` 是为了把"只有空白字符"的文件也当作空文件处理（更宽容）。
      if (fileContent.trim() !== '') {
        return {
          result: false,
          behavior: 'ask',
          message: 'Cannot create new file - file already exists.',
          errorCode: 3,
        }
      }

      // Empty file with empty old_string is valid - we're replacing empty with content
      return {
        result: true,
      }
    }

    // errorCode 5：Jupyter 笔记本**明确拒绝**用 FileEditTool 改。
    // 为什么？.ipynb 本质是 JSON，直接做字符串替换极易破坏结构：
    //   · 源码里的换行是 `"source": ["line1\n", "line2\n"]` 这种**转义过的数组**；
    //   · 还有 outputs / execution_count / metadata 要同步维护。
    // 所以必须走 NotebookEditTool（../NotebookEditTool/），它按 cell 粒度操作。
    // 注意这里给出的是**可执行建议**（用哪个工具），不是单纯报错——便于模型自我纠正。
    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        behavior: 'ask',
        message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
        errorCode: 5,
      }
    }

    // 【★ 关键的协调机制："必须先 Read 过才能改" —— errorCode 6】
    // readFileState 是一个 Map<路径, {content, timestamp, offset, limit}>，
    // 由 FileReadTool 写入。它承担两件事：
    //   ① 强制模型先读再改 —— 没读过文件就想改，等于盲改，必然出错；
    //   ② 提供"我读到的版本快照"，后面用来检测"我读完之后文件是否被别人动过"。
    // `isPartialView` 为 true 表示模型只读了片段（offset/limit 截断），
    // 这种情况下它并没有看到全文，同样禁止改写。
    // ≈ Java 里的 ReadWriteLock 读令牌思路，只是用 Map 手写实现。
    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File has not been read yet. Read it first before writing to it.',
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 6,
      }
    }

    // Check if file exists and get its last modified time
    if (readTimestamp) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      if (lastWriteTime > readTimestamp.timestamp) {
        // Timestamp indicates modification, but on Windows timestamps can change
        // without content changes (cloud sync, antivirus, etc.). For full reads,
        // compare content as a fallback to avoid false positives.
        // 【为什么要fallback 到"内容比对"？】
        // Windows 上文件的 mtime 会因为云同步、杀毒软件扫描、甚至只是打开看一眼而变，
        // 但内容其实没动。只信 mtime 会产生大量**误报**，把正常的编辑全拦下来
        // （用户体感是"一直提示我重新读文件"）。
        // 所以：只有"整篇读过"（offset/limit 都为空 = 有完整 content）时，
        // 才敢拿 content 做逐字节比对，内容一致就放行。
        // 这不是可移植性洁癖，是被 Windows 用户投诉出来的补丁。
        const isFullRead =
          readTimestamp.offset === undefined &&
          readTimestamp.limit === undefined
        if (isFullRead && fileContent === readTimestamp.content) {
          // Content unchanged, safe to proceed
        } else {
          return {
            result: false,
            behavior: 'ask',
            message:
              'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
            errorCode: 7,
          }
        }
      }
    }

    // 换个短名字纯粹为了下面几行可读性；fileContent 在后续分支里还要用到。
    const file = fileContent

    // Use findActualString to handle quote normalization
    // 【为什么不能直接用 input.old_string 去匹配？】
    // findActualString（./utils.ts）做一件很实际的事：**智能引号归一化**。
    // 模型输出经过 JSON 编解码、又常常模仿Markdown 排版，会把直引号 ' "
    // 变成弯引号 ' " （typographic quotes）。若按字面匹配必然失败。
    // 归一化后拿到的 actualOldString 才是文件里真正存在的那串。
    const actualOldString = findActualString(file, old_string)
    if (!actualOldString) {
      return {
        result: false,
        behavior: 'ask',
        message: `String to replace not found in file.\nString: ${old_string}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 8,
      }
    }

    // ★【本工具防误改的核心一行，值得单独讲】
    // 统计 old_string 出现次数的小技巧：用 split 切一刀，
    // 切出来的片段数 - 1 就是分隔符（即 old_string）的出现次数。
    //   例：'abab'.split('a') → ['', 'b', 'b']，长度 3，故 'a' 出现 2 次。
    // 为什么这么数而不用正则？因为 old_string 里可能含正则元字符（. * $ 等），
    // 用正则会**误匹配**。split 用纯字符串做分隔符，天然安全。
    const matches = file.split(actualOldString).length - 1

    // Check if we have multiple matches but replace_all is false
    // ★★★【强制唯一匹配 —— 整个 FileEditTool 最重要的安全设计】★★★
    // errorCode 9：命中多处但没声明 replace_all ⇒ **拒绝执行**。
    //
    // 为什么不"默认改第一处"？
    //   因为模型心里想的是某一处，而"第一处"未必是它想的那一处。
    //   例如 old_string = "  return null" 在全文件有 20 处，
    //   改错地方的后果是**静默引入 bug** —— 最坏的一类错误，因为没人会发现。
    // 所以宁可报错，并在 message 里**手把手教模型怎么修**：
    //   a) 确实要全改 → 设 replace_all=true
    //   b) 只改一处   → 多带几行上下文，让它变得唯一
    // 这条错误信息是人类手动调 prompt 的经验结晶：光说"多处命中"没用，
    // 必须同时给出**两条出路**，模型才知道下一步做什么。
    //
    // meta.actualOldString 一并回传，方便 UI 高亮"到底哪几处撞车了"。
    if (matches > 1 && !replace_all) {
      return {
        result: false,
        behavior: 'ask',
        message: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
          actualOldString,
        },
        errorCode: 9,
      }
    }

    // Additional validation for Claude settings files
    // 【为什么要"预演"一遍？】
    // 改 settings.json / .claude/settings.local.json 这类文件时，
    // 一个坏字符就可能让 Claude Code **下次启动直接崩**。
    // 所以传入一个**闭包（懒执行）**把改动后的完整内容算出来做 JSON 体检：
    //   () => replace_all ? file.replaceAll(...) : file.replace(...)
    // 传函数而不是字符串的优点：只有目标文件真的是 settings 时才付计算代价；
    // 不是 settings 文件则闭包一次都不调，零开销。
    // 注意这里复制了 call() 里的替换逻辑，是一处已知的一致性隐患——两边必须同步修改。
    const settingsValidationResult = validateInputForSettingsFileEdit(
      fullFilePath,
      file,
      () => {
        // Simulate the edit to get the final content using the exact same logic as the tool
        return replace_all
          ? file.replaceAll(actualOldString, new_string)
          : file.replace(actualOldString, new_string)
      },
    )

    if (settingsValidationResult !== null) {
      return settingsValidationResult
    }

    // 全部通过。把**归一化后**的 actualOldString 放在 meta 里交棒给 call()，
    // 保证"校验用的字符串"和"真正替换的字符串"严格是同一个，不会因为二次计算出现偏差。
    return { result: true, meta: { actualOldString } }
  },
  /**
   * 判断两次编辑请求是否"本质相同"。
   *
   * 【为什么需要它？】
   * 模型有时会连续发两个看起来不同、实则一样的编辑（或 UI 重放同一操作）。
   * 框架用它来做幂等去重 / 判断"是不是重复提交"，避免重复计数或重复弹权限框。
   *
   * 【为什么要把两个 input 各自包成 { file_path, edits:[...] } 再比？】
   * 因为 areFileEditsInputsEquivalent（./utils.ts）是为**多段编辑**设计的通用比较器
   * （ NotebookEditTool 等也复用同一套），本工具只是"单段编辑"这一特例，
   * 于是包装成只有一个元素的 edits 数组去复用它的逻辑 —— 典型的"复用而非重写"。
   *
   * `input1.replace_all ?? false` 把 undefined 归一成 false，
   * 使得「不写 replace_all」与「显式写 replace_all:false」判定为等价。
   */
  inputsEquivalent(input1, input2) {
    return areFileEditsInputsEquivalent(
      {
        file_path: input1.file_path,
        edits: [
          {
            old_string: input1.old_string,
            new_string: input1.new_string,
            replace_all: input1.replace_all ?? false,
          },
        ],
      },
      {
        file_path: input2.file_path,
        edits: [
          {
            old_string: input2.old_string,
            new_string: input2.new_string,
            replace_all: input2.replace_all ?? false,
          },
        ],
      },
    )
  },
  /**
   * 【真正干活的函数】按顺序完成：技能发现 → 备份 → 读 → 校验未过期 → 替换 → 落盘 → 通知各方。
   *
   * @param input  模型入参 { file_path, old_string, new_string, replace_all }
   * @param 第二参数 解构出来的 ToolUseContext 成员：
   *          readFileState          由 FileReadTool 维护的"我读过的版本"快照 Map
   *          userModified           用户在批准对话框里手工改过内容？（影响回给模型的文案）
   *          updateFileHistoryState undo 栈的写入函数
   *          dynamicSkillDirTriggers 本轮新发现的 skills 目录（UI 要展示"已加载某技能"）
   * @param 第三参数 `_`  占位不用
   * @param parentMessage 触发这次编辑的那条 assistant message，用于把备份挂到正确的 undo 节点
   * @returns { data: FileEditOutput } —— FileEditOutput 定义在 ./types.ts，
   *          里面含 originalFile/structuredPatch/...，UI 拿它渲染 diff。
   *
   * 【本函数最关键的设计：中间那段"原子区"】
   * 读内容（步骤 2）之后到写磁盘（步骤 5）之间，**绝对不能出现 await**。
   * 因为 JS 单线程事件循环里，一旦 await 让出控制权，
   * 另一个并发编辑就可能插进来，造成经典的 read-modify-write 竞态丢失更新。
   * 所以 mkdir / 备份这些必须 await 的操作都被**刻意提前**到原子区之外
   * （见下方 `await fs.mkdir(...)` 处的注释）。
   * ≈ Java 里 synchronized 块尽量短、且块内不做阻塞 IO 的同一个道理。
   *
   * ── 步骤 ──
   * ① 路径展开 + 顺带发现/激活 skills（后台异步，不阻塞）
   * ② notify LSP 准备 + 建目录 + 写 undo 备份（都在原子区**之外**）
   * ③ 【原子区开始】同步读盘 → 确认未被外部改动 → 归一化引号 → 生成 patch → 落盘
   * ④ 通知 LSP/VSCode 文件变更、更新 readFileState（防止紧接着的下次编辑被自己"过期"）
   * ⑤ 埋点上报（行数、字符串字节数、耗时）
   * ⑥ 拼 data 返回
   */
  async call(
    input: FileEditInput,
    {
      readFileState,
      userModified,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
    },
    _,
    parentMessage,
  ) {
    const { file_path, old_string, new_string, replace_all = false } = input

    // 1. Get current state
    const fs = getFsImplementation()
    const absoluteFilePath = expandPath(file_path)

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    // SIMPLE 模式下没有 skills 机制，直接跳过以省掉整棵目录扫描的开销。
    // isEnvTruthy(...) 而不是 `process.env.X === 'true'`：
    // 是因为环境变量常被写成 '1' / 'TRUE' / 'yes'，统一由工具函数判真更稳。
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths(
        [absoluteFilePath],
        cwd,
      )
    // 发现新 skills 目录时：先登记给 UI 展示（同步、便宜），
    // 真正的加载 `addSkillDirectories(...)` 用 .catch(() => {}) **发射后不管**——
    // 编辑文件这件事不应该等技能加载完。**吞掉错误**是刻意的：技能加载失败不能连累文件编辑。
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([absoluteFilePath], cwd)
    }

    // 在改动前让诊断追踪器记住"改动前的诊断状态"，
    // 这样改完后才能区分：哪些报错是本次编辑**新引入**的，哪些本来就有。
    await diagnosticTracker.beforeFileEdited(absoluteFilePath)

    // Ensure parent directory exists before the atomic read-modify-write section.
    // These awaits must stay OUTSIDE the critical section below — a yield between
    // the staleness check and writeTextContent lets concurrent edits interleave.
    // ★【为什么这行必须在下面那个"原子区"之外？】
    // mkdir 是异步的（await 会让出事件循环）。若把它放在"读内容 → 写回"之间，
    // 中间的那次让出就给了并发编辑可乘之机，会丢更新。
    // 所以所有 await 都刻意提到这里先做完。
    //
    // 顺带说一下：这里创建的其实是文件所在的**目录**（dirname），并且不会因为目录
    // 已存在而报错（语义类似 mkdir -p）。新建文件时父目录可能压根不存在。
    await fs.mkdir(dirname(absoluteFilePath))
    // 写 undo 备份。注意时机：**在读盘之前**备份（此时磁盘上还是原文）。
    // 把它放在原子区之外是安全的，因为备份接口幂等：
    // v1 版本按内容 hash 做 key，同内容重复备份不会产生多条记录；
    // 万一后面"文件被改过"校验失败直接 throw，代价只是多一份没人用的备份，不会脏。
    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state).
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        absoluteFilePath,
        parentMessage.uuid,
      )
    }

    // 2. Load current state and confirm no changes since last read
    // ┌─────────────── 从这里开始进入「原子区」──────────────────────────────┐
    // │ 到 writeTextContent() 为止，**严禁插入任何 await**。                  │
    // │ 原因：JS 单线程下 await = 让出 CPU，期间的窗口足够另一个并发编辑插进来，│
    // │ 于是这次读到的就是脏数据，写回就会**覆盖掉别人的改动**（丢更新）。     │
    // │ 所以下面刻意用 readFileForEdit() 这个**同步**读函数（而不是 await fs）。│
    // │ ≈ Java 里 synchronized(this){ ... } 包住读改写三步，且块内不做阻塞 IO。│
    // └───────────────────────────────────────────────────────────────────────┘
    // Please avoid async operations between here and writing to disk to preserve atomicity
    // 解构出四个值。注意 `lineEndings: endings` 是**重命名解构**：
    // 原字段叫 lineEndings，这里改用短名 endings（因为外层已有同名冲突）。
    // ≈ Kotlin 的 `val (a, b) = pair`，但支持就地改名。
    const {
      content: originalFileContents,
      fileExists,
      encoding,
      lineEndings: endings,
    } = readFileForEdit(absoluteFilePath)

    if (fileExists) {
      const lastWriteTime = getFileModificationTime(absoluteFilePath)
      const lastRead = readFileState.get(absoluteFilePath)
      if (!lastRead || lastWriteTime > lastRead.timestamp) {
        // Timestamp indicates modification, but on Windows timestamps can change
        // without content changes (cloud sync, antivirus, etc.). For full reads,
        // compare content as a fallback to avoid false positives.
        const isFullRead =
          lastRead &&
          lastRead.offset === undefined &&
          lastRead.limit === undefined
        const contentUnchanged =
          isFullRead && originalFileContents === lastRead.content
        if (!contentUnchanged) {
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    // 3. Use findActualString to handle quote normalization
    // `findActualString(...) || old_string`：找不到就退回原串。
    // 与 validateInput 里"找不到就报错"不同，这里是**兜底而非报错**——
    // 因为走到 call() 时按理一定找得到（validateInput 已查过），
    // 万一 findActualString 因边界情况返回空，宁可用原串让下面的 replace 自然失败，
    // 也不要传 undefined 进去把 whole file 搞坏。
    const actualOldString =
      findActualString(originalFileContents, old_string) || old_string

    // Preserve curly quotes in new_string when the file uses them
    // 【保持引号风格一致，细节但重要】
    // 若原文件用的是弯引号（“”）而模型给的是直引号（""），直接替换会把
    // 整份文件的排版风格改坏（diff 里出现一堆与逻辑无关的引号抖动）。
    // preserveQuoteStyle（./utils.ts）把 new_string 的引号按文件既有习惯转换，
    // 保证"只改该改的"。这是从真实用户 diff review 里总结出来的经验。
    const actualNewString = preserveQuoteStyle(
      old_string,
      actualOldString,
      new_string,
    )

    // 4. Generate patch
    // 一次调用同时拿到：
    //   updatedFile —— 替换后的完整内容（准备写盘）
    //   patch       —— 结构化 diff（hunks 列表），UI 靠它上色，UI.tsx 会用到
    // 为什么不自己写 file.replace()？因为需要处理 replace_all 语义 + 精确 once 语义，
    // 且要和 UI 显示的 diff 保持绝对一致——必须共用一个实现。
    const { patch, updatedFile } = getPatchForEdit({
      filePath: absoluteFilePath,
      fileContents: originalFileContents,
      oldString: actualOldString,
      newString: actualNewString,
      replaceAll: replace_all,
    })

    // 5. Write to disk
    // 【原子区最后一步】落盘。
    // 传入 encoding 和 endings 是为了**原样还原**：读进来是 UTF-16LE/CRLF，
    // 写回去还得是 UTF-16LE/CRLF。否则编辑器里会看到满屏换行符变化或乱码。
    // （内存里为了匹配方便统一过 LF，这里是"还债"的一步。）
    writeTextContent(absoluteFilePath, updatedFile, encoding, endings)

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Clear previously delivered diagnostics so new ones will be shown
      clearDeliveredDiagnosticsForFile(`file://${absoluteFilePath}`)
      // didChange: Content has been modified
      // 通知 LSP 内容变了（didChange）。用 .catch 是因为：
      // language server 没装/挂了，**绝不能**让文件编辑失败——编辑本身已成功。
      // ≈ Java 里把非关键通知提交到线程池且 swallowException。
      lspManager
        .changeFile(absoluteFilePath, updatedFile)
        .catch((err: Error) => {
          logForDebugging(
            `LSP: Failed to notify server of file change for ${absoluteFilePath}: ${err.message}`,
          )
          logError(err)
        })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${absoluteFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // Notify VSCode about the file change for diff view
    notifyVscodeFileUpdated(absoluteFilePath, originalFileContents, updatedFile)

    // 6. Update read timestamp, to invalidate stale writes
    // 【为什么刚写完就要立刻更新 readFileState？】
    // 因为紧接着的编辑会以"我读过最新版"为前提做校验
    // （见前面 errorCode 7 的 lastWriteTime > lastRead.timestamp 判断）。
    // 若不更新，刚写完的文件的 mtime 已经比旧记录新，下一次编辑会被自己判为
    // "文件被别人改过了，请重新读" —— 荒谬且阻塞。所以这里主动把快照刷新到最新。
    // offset/limit 显式设为 undefined 表示"这是全文快照"。
    readFileState.set(absoluteFilePath, {
      content: updatedFile,
      timestamp: getFileModificationTime(absoluteFilePath),
      offset: undefined,
      limit: undefined,
    })

    // 7. Log events
    // 单独埋点：编辑 CLAUDE.md（项目记忆文件）是高频且影响全局的行为，需单独统计。
    // `${sep}` 用 path.sep 常量而非硬编码 '/'，保证 Windows 上也能正确匹配 '\\CLAUDE.md'。
    // （这就是 Java 里 File.separator 那一套。）
    if (absoluteFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }
    // 累计改动行数，最终会体现在会话状态/stat 上（"本会话改了多少行"）。
    // 为什么自己数 patch 而不是 git diff？因为可能不在 git 仓库里。
    countLinesChanged(patch)

    logFileOperation({
      operation: 'edit',
      tool: 'FileEditTool',
      filePath: absoluteFilePath,
    })

    logEvent('tengu_edit_string_lengths', {
      oldStringBytes: Buffer.byteLength(old_string, 'utf8'),
      newStringBytes: Buffer.byteLength(new_string, 'utf8'),
      replaceAll: replace_all,
    })

    // `ToolUseDiff | undefined` 是联合类型（≈ Java sealed interface 的一个实现或 null）。
    // 显式写 | undefined 而不是留给编译器推，是为了让"可能没有"这件事在类型层面可见。
    let gitDiff: ToolUseDiff | undefined
    if (
      // 只有在远程环境（web/claude.ai）**且** feature 开关打开时才计算 git diff。
      // 短路求值保证本地环境下连 stat/git 子进程都不启，零开销。
      // 注意：getFeatureValue_CACHED_MAY_BE_STALE 名字里就写着"可能是陈旧缓存"，
      // 即它故意接受一次 RPC 往返的延迟——这是**非交互玩法可读性 vs 速度**的取舍。
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
    ) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(absoluteFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isEditTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    // 8. Yield result
    // 返回值不含 await 的副作用了，可以放心组装。
    // originalFile 原样带出去：UI 渲染 diff 需要"改前/改后"两份内容。
    const data = {
      filePath: file_path,
      oldString: actualOldString,
      newString: new_string,
      originalFile: originalFileContents,
      structuredPatch: patch,
      userModified: userModified ?? false,
      replaceAll: replace_all,
      ...(gitDiff && { gitDiff }),
    }
    return {
      data,
    }
  },
  /**
   * 把 call() 的结果翻译成**模型能读懂**的 tool_result 文本。
   *
   * @param data      call() 返回的 FileEditOutput
   * @param toolUseID 这一次 tool_use 的 id，必须原样回填，否则 API 会报
   *                  "tool_result 找不到对应的 tool_use"（这是硬性格式要求）
   * @returns { type: 'tool_result', tool_use_id, content } —— 工具结果块
   *
   * 【为什么值得单独一个函数？】
   * 它决定了模型看到的**叙事**：成功要说是"更新成功"还是"全部替换成功"，
   * 是否提示"用户手工改过你的方案"（userModified）—— 后者很重要，
   * 能让模型意识到磁盘上最终的样子和自己提议的不完全一样，避免它基于错误假设继续推理。
   *
   * 文案刻意保持"极简确认"风格：不回显 diff（那会浪费大量 token），
   * 只回 "The file X has been updated successfully."，模型已经在原文里看过改动了。
   */
  mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
    const { filePath, userModified, replaceAll } = data
    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''

    if (replaceAll) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.`,
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}.`,
    }
  },
// ─────────────────────────────────────────────────────────────────────────────
// satisfies 的说明见文件头【TS 语法速查】。一句话：
// 这里是"编译期契约检查"——写错字段、少写必填回调都会在 tsc 阶段报错，
// 但**不会**把各个回调的精确类型上擦成 ToolDef 里的宽类型。
// 因此别处写 FileEditTool.call(...) 时依然能得到精确的参数类型提示。
// ─────────────────────────────────────────────────────────────────────────────
} satisfies ToolDef<ReturnType<typeof inputSchema>, FileEditOutput>)

// --

/**
 * 为什么这里要**同步**读文件（readFileSync），明明整个仓库都在用 await？
 * ---------------------------------------------------------------------------
 * 因为 call() 里"读 → 校验未过期 → 替换 → 写"必须是一个**不可分割的原子区**。
 * 只要读是 await 的，就会在事件循环里让出一个 tick，
 * 这段时间窗口足够另一个并发编辑（比如后台 hook、另一个 tool 调用）插进来改文件，
 * 于是我们写回的是基于旧内容的计算结果 —— 经典的 lost update（丢更新）。
 *
 * 同步读虽然会阻塞事件循环几十毫秒，但换来的是"绝不交错"。
 * 在 CLI 这种短命令场景里，阻塞几十毫秒远比丢更新划算。
 *
 * @param absoluteFilePath 绝对路径（调用方已 expandPath 过）
 * @returns  { content, fileExists, encoding, lineEndings }
 *           · fileExists=false 时 content 为 '' —— 表示"新建文件"场景，不是错误
 *           · encoding     让写回时用同一种编码，避免把 UTF-16 文件写成 UTF-8
 *           · lineEndings  让写回时保持 CRLF/LF 原样，避免整份文件换行符被偷偷改写
 *
 * 【错误处理策略】
 * 只吞 ENOENT（文件不存在）——这是预期内的分支，降级为"内容为空且标记不存在"；
 * 其它异常（权限、目录、IO 故障）原样抛出，绝不吞掉。
 * ≈ Java 里只 catch FileNotFoundException 而让 IOException 继续上抛。
 *
 * 【TS 语法】没有 export：这是模块私有函数（≈ Java 的 private static）。
 * 返回类型写成一个对象字面量类型 `{ content: string; fileExists: boolean; ... }`
 * ——当场出弟弟类型的写法，等价于匿名 record。
 */
function readFileForEdit(absoluteFilePath: string): {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    }
  } catch (e) {
    if (isENOENT(e)) {
      return {
        // ENOENT 降级分支：返回空内容 + fileExists=false。
        // 这样上层不用 try/catch，直接 `if (fileExists)` 就能分流"编辑"与"新建"两种语义。
        // ≈ Java 里返回 Optional.empty() 而不是抛异常来表达"没有"。
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    throw e
  }
}
