/**
 * ============================================================================
 *  【文件总览】src/services/MagicDocs/magicDocs.ts
 *            —— "魔法文档"：会自己更新的 Markdown 文档
 * ============================================================================
 *
 *  一句话定位：
 *  你在项目里写一个 Markdown 文件，只要**第一行**长这样：
 *
 *      # MAGIC DOC: 支付模块架构说明
 *
 *  那么之后 Claude Code 每次读过这个文件，就会**在后台自动维护它**——
 *  把这次对话里新产生的、值得沉淀的知识写进文档，而不需要你开口要求。
 *
 *  打个比方：它像是给文档请了一个自动盯梢的实习生，
 *  每次会议（对话）结束，实习生就默默把会议纪要整理进那份文档里。
 *
 *  ---------------------------------------------------------------------------
 *  【怎么用？用户视角】
 *  ---------------------------------------------------------------------------
 *      ┌────────────────────────────────────────────────┐
 *      │ # MAGIC DOC: 订单服务说明                       │  ← 第一行：魔法标记（必须有）
 *      │                                                 │
 *      │ _只记录接口设计和已知坑，不要贴大段代码_          │  ← 第二行：可选的斜体指令（定制更新规则）
 *      │                                                 │
 *      │ ## 架构                                         │  ← 以下正文由 Claude 自动维护
 *      │ ...                                             │
 *      └────────────────────────────────────────────────┘
 *
 *  识别规则很简单（detectMagicDocHeader）：
 *      - 标题行必须匹配 `# MAGIC DOC: xxx`（不区分大小写，允许 # 后有空格）
 *      - 紧随其后的**斜体行**（`_..._` 或 `*...*`）会被识别为"文档定制指令"
 *
 *  ---------------------------------------------------------------------------
 *  【在架构中的位置】调用链
 *  ---------------------------------------------------------------------------
 *      启动时：
 *      initMagicDocs()                      ← ★ 本文件（仅对内部员工 USER_TYPE=ant 注册）
 *        ├─> registerFileReadListener()     ← 每次读文件时回调，检测是不是 magic doc
 *        │     └─> detectMagicDocHeader() + registerMagicDoc()   ← ★ 本文件（登记到内存 Map）
 *        └─> registerPostSamplingHook()     ← 每轮对话结束后回调
 *              └─> updateMagicDocs()        ← ★ 本文件（后台更新所有已登记的文档）
 *                    └─> updateMagicDoc()   ← ★ 本文件（更新单个文档）
 *                          ├─> FileReadTool.call()           重新读一遍最新内容
 *                          ├─> detectMagicDocHeader()        再确认一次标记还在
 *                          ├─> buildMagicDocsUpdatePrompt()  ← ./prompts.ts（拼装提示词）
 *                          └─> runAgent()   ← src/tools/AgentTool/runAgent.ts（派一个子 agent 去改文档）
 *
 *  ---------------------------------------------------------------------------
 *  【三个关键设计决策】
 *  ---------------------------------------------------------------------------
 *  ① **只在"对话空闲"时更新**
 *     判断依据是 hasToolCallsInLastAssistantTurn(messages)：
 *     如果 Claude 上一轮还在调工具，说明任务没干完，这时候总结文档言之过早。
 *     等到它停下来（进入"等用户说话"的状态），才是沉淀知识的好时机。
 *
 *  ② **用"分叉的子 agent"去改文档，而不是主线程自己改**
 *     runAgent 的 forkContextMessages 会把主对话历史**复制一份**给子 agent，
 *     子 agent 只被允许用 Edit 工具、且只能改**这一个文件**（canUseTool 里严格限制）。
 *     好处：
 *       - 主线程的上下文不会被文档更新的大量内容污染
 *       - 子 agent 权限被锁死，不可能误改别的文件
 *       - 即使用户正在干别的，也不干扰
 *
 *  ③ **每次都重新读文件、重新检测标记**
 *     文档可能被用户手动改过、删掉、或者把 magic 标记去掉了。
 *     所以每次更新前都重新读 + 重新检测；发现标记没了或文件没了，
 *     就把它从跟踪表里移除（trackedMagicDocs.delete）。
 *     这里有个很隐蔽的坑：FileReadTool 有"文件未变化就返回 stub"的去重优化，
 *     所以必须**先删除该文件的缓存条目**，否则读回来的不是真正的内容。
 *     详见 updateMagicDoc 里的注释。
 *
 *  ---------------------------------------------------------------------------
 *  【本文件包含什么】主要函数清单
 *  ---------------------------------------------------------------------------
 *   1. initMagicDocs()            入口：注册"读文件监听器"和"对话结束钩子"
 *   2. detectMagicDocHeader()     从文件内容里识别 magic doc 标记（返回标题 + 可选指令）
 *   3. registerMagicDoc()         把识别出来的文件登记进跟踪表
 *   4. clearTrackedMagicDocs()    清空跟踪表（测试用）
 *   5. getMagicDocsAgent()        构造那个专门改文档的子 agent 定义
 *   6. updateMagicDoc()           ★ 更新单个文档（读 → 检测 → 拼 prompt → 派 agent）
 *   7. updateMagicDocs()          ★ 对话结束钩子：遍历更新所有已登记的文档
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的语法，逐条 Java 对照）
 * ---------------------------------------------------------------------------
 *  - `new Map<string, MagicDocInfo>()`
 *      ≈ Java 的 `new HashMap<String, MagicDocInfo>()`。
 *      本文件用它做"已登记的 magic doc 跟踪表"，键是文件路径。
 *
 *  - `for (const docInfo of Array.from(trackedMagicDocs.values()))`
 *      为什么要套一层 Array.from？因为 Map.values() 返回的是**迭代器**，
 *      边遍历边在循环体里 delete（updateMagicDoc 就会这么做）可能导致问题。
 *      先转成数组快照就安全了。
 *      ≈ Java 的 `new ArrayList<>(map.values())` 再遍历（防御性复制）。
 *
 *  - `for await (const _message of runAgent({...})) { }`
 *      **异步迭代器**。`for await ... of` 逐个消费异步产生的值。
 *      ≈ Java 的 Flux/Stream 订阅，但要 await。
 *      这里循环体是空的（注释写着 "Just consume"）——
 *      目的只是**驱动**这个流跑完，因为我们不关心中间消息，只关心它跑完的副作用（改了文件）。
 *      变量名以 `_` 开头是约定俗成："我知道这个变量没用到"。
 *
 *  - `sequential(async function (context) {...})`
 *      把一个异步函数包成**串行执行**的版本：
 *      如果上一次调用还没结束，新的调用会排队而不是并发。
 *      为什么需要：多个文档要更新，同时派好几个子 agent 会把 API 打爆、也会互相干扰。
 *      ≈ Java 的 `synchronized` 或单线程池 Executors.newSingleThreadExecutor()。
 *
 *  - `content.match(/^#\s*MAGIC\s+DOC:\s*(.+)$/im)`
 *      正则匹配，返回匹配结果数组或 null。
 *      `m` flag = 多行模式（^ 和 $ 匹配每行的开头结尾，而不只是整个字符串）
 *      `i` flag = 忽略大小写。
 *      ≈ Java 的 Pattern.compile(..., MULTILINE | CASE_INSENSITIVE) + matcher。
 *      match[0] 是完整匹配，match[1] 是第一个捕获组（这里就是标题）。
 *
 *  - `match.index!`
 *      `!` 非空断言：match.index 的类型是 number | undefined，
 *      但我们知道匹配成功时它一定有值，所以断言一下。≈ 强制转换。
 *
 *  - `catch (e: unknown)`
 *      catch 的参数在 TS 里默认是 unknown（5.0 之前是 any）。
 *      **必须先做类型检查才能用**，所以下面写 `e instanceof Error`。
 *      ≈ Java 的 catch (Throwable e)，但 TS 强制你先判断类型，更安全。
 *
 *  - `const canUseTool = async (tool: Tool, input: unknown) => { ... }`
 *      把异步箭头函数赋值给常量。之后当参数传给 runAgent（**回调/策略模式**）。
 *      ≈ Java 的 BiFunction<Tool, Object, CompletableFuture<Decision>>。
 *
 *  - `'file_path' in input`
 *      `in` 运算符：运行时检查对象有没有某个属性。
 *      ≈ Java 的反射或 map.containsKey()，但这里是 JS 原生的结构探测。
 *      因为 input 是 unknown，不能直接 input.file_path，必须先 `in` 检查。
 *
 *  - `{ behavior: 'allow' as const, updatedInput: input }`
 *      `as const` 把字符串收窄成**字面量类型**（'allow' 而不是 string），
 *      这样联合类型才能正确收窄。≈ Java 的 enum 但更轻量。
 *
 *  - `const { messages, systemPrompt, ... } = context`  解构赋值
 *      ≈ Java 21 的记录模式匹配，但 TS 里是日常操作。
 *
 *  - `{ ...toolUseContext, readFileState: clonedReadFileState }`  不可变更新
 *      复制一份并覆盖某个字段 ≈ Java 的 builder 副本。
 *
 *  - `type MagicDocInfo = { path: string }`  结构化类型
 *      ≈ Java 的 record，但按**结构**匹配（鸭子类型），不需要 implements。
 *
 *  - 类型标注在**后面**：`(filePath: string, content: string) => void`
 *      ≈ Java 的 `(String filePath, String content)`，顺序正好相反。
 * ============================================================================
 */

/**
 * Magic Docs automatically maintains markdown documentation files marked with special headers.
 * When a file with "# MAGIC DOC: [title]" is read, it runs periodically in the background
 * using a forked subagent to update the document with new learnings from the conversation.
 *
 * See docs/magic-docs.md for more information.
 */

import type { Tool, ToolUseContext } from '../../Tool.js'
import type { BuiltInAgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { runAgent } from '../../tools/AgentTool/runAgent.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import {
  FileReadTool,
  type Output as FileReadToolOutput,
  registerFileReadListener,
} from '../../tools/FileReadTool/FileReadTool.js'
import { isFsInaccessible } from '../../utils/errors.js'
import { cloneFileStateCache } from '../../utils/fileStateCache.js'
import {
  type REPLHookContext,
  registerPostSamplingHook,
} from '../../utils/hooks/postSamplingHooks.js'
import {
  createUserMessage,
  hasToolCallsInLastAssistantTurn,
} from '../../utils/messages.js'
import { sequential } from '../../utils/sequential.js'
import { buildMagicDocsUpdatePrompt } from './prompts.js'

// Magic Doc header pattern: # MAGIC DOC: [title]
// Matches at the start of the file (first line)
// 中文：识别魔法标记的正则。
//   ^          行首（配合下面的 m flag = 每一行的行首）
//   #\s*       # 号后面允许有空格
//   MAGIC\s+DOC:  MAGIC 和 DOC 之间至少一个空白，冒号紧贴 DOC
//   \s*(.+)$   冒号后可选空白，然后捕获组 1 = 文档标题
//   i          忽略大小写（写成 "# magic doc:" 也认）
//   m          多行模式（^ $ 按行匹配，而不是按整个字符串）
const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im
// Pattern to match italics on the line immediately after the header
// 中文：识别"文档定制指令"的正则 —— 标题行紧后面那行的斜体文字。
//   [_*]       以 _ 或 * 开头（Markdown 的两种斜体写法）
//   (.+?)      非贪婪捕获中间的内容
//   [_*]\s*$   以 _ 或 * 结尾，后面允许空白，然后行尾
const ITALICS_PATTERN = /^[_*](.+?)[_*]\s*$/m

// Track magic docs
// 中文：已登记的 magic doc 跟踪表。键 = 文件绝对路径，值 = 文档信息。
// 这是个**模块级**的 Map，进程内共享，所以多个会话/多个组件都能看到同一份跟踪表。
type MagicDocInfo = {
  path: string
}

const trackedMagicDocs = new Map<string, MagicDocInfo>()

/**
 * 清空 magic doc 跟踪表。
 *
 * 为什么需要它：trackedMagicDocs 是模块级全局状态，
 * 单元测试之间如果不清空，上一个用例登记的文件会漏到下一个用例里（测试互相污染）。
 * 这是"为可测试性留的口子"。
 */
export function clearTrackedMagicDocs(): void {
  trackedMagicDocs.clear()
}

/**
 * Detect if a file content contains a Magic Doc header
 * Returns an object with title and optional instructions, or null if not a magic doc
 */
/**
 * 【中文】检测一段文件内容里有没有 magic doc 标记。
 *
 * 为什么需要它：整个功能的"入口识别"。两个地方会用到：
 *   ① 每次读文件时（registerFileReadListener 回调）—— 决定要不要登记进跟踪表
 *   ② 每次更新文档前 —— 重新确认标记还在不在（用户可能手动把标记删了）
 *
 * 返回结构设计成 `{ title, instructions? } | null`：
 *   null          = 不是 magic doc，不管它
 *   有 title      = 是 magic doc，标题用于拼 prompt 和保持头部不变
 *   有 instructions = 作者还写了定制指令，要优先遵守
 * `instructions?` 的可选标记（?）≈ Java 的 Optional 字段，但更轻量。
 *
 * 关键步骤：
 *   ① 用正则找标题行，找不到就返回 null
 *   ② 找到后，从标题行**结束的位置**往后切，取紧跟着的那一行
 *      （允许中间有一个空行，因为很多人写完标题会空一行）
 *   ③ 那一行如果是斜体，就当成"定制指令"提取出来
 *
 * @param {string} content 文件的完整文本内容
 * @returns {{ title: string; instructions?: string } | null} 识别结果；不是 magic doc 时为 null
 */
export function detectMagicDocHeader(
  content: string,
): { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN)
  if (!match || !match[1]) {
    return null
  }

  // ① 捕获组 1 就是标题。trim() 去掉前后空白（用户可能多打了空格）
  const title = match[1].trim()

  // Look for italics on the next line after the header (allow one optional blank line)
  // 中文 ②：从标题行结束处往后切，去找"紧接着的那一行"。
  // `match.index!` 的 `!` 是非空断言：正则匹配成功时 index 一定有值，
  // 但 TS 的类型定义里它是 `number | undefined`，不断言编译不过。
  const headerEndIndex = match.index! + match[0].length
  const afterHeader = content.slice(headerEndIndex)
  // Match: newline, optional blank line, then content line
  // 中文：正则含义 = 换行 → 可选的空行 → 真正的内容行 → 到换行或结尾为止
  const nextLineMatch = afterHeader.match(/^\s*\n(?:\s*\n)?(.+?)(?:\n|$)/)

  if (nextLineMatch && nextLineMatch[1]) {
    const nextLine = nextLineMatch[1]
    // ③ 这一行是不是斜体？是的话里面的内容就是作者的定制指令
    const italicsMatch = nextLine.match(ITALICS_PATTERN)
    if (italicsMatch && italicsMatch[1]) {
      const instructions = italicsMatch[1].trim()
      return {
        title,
        instructions,
      }
    }
  }

  // 是 magic doc，但没写定制指令 —— 只返回标题
  return { title }
}

/**
 * Register a file as a Magic Doc when it's read
 * Only registers once per file path - the hook always reads latest content
 */
/**
 * 【中文】把一个文件登记为 magic doc。
 *
 * 为什么只存 path 不存内容（MagicDocInfo 里只有 path 一个字段）：
 * 因为文档内容**随时可能被用户手动改**，存下来就是过期数据。
 * 每次要更新时都重新读一遍最新内容（见 updateMagicDoc），
 * 这样能保证永远基于最新状态去改 —— 注释里 "the hook always reads latest content" 就是这个意思。
 *
 * 为什么要判断"是否已登记"：同一个文件可能被读很多次，
 * 如果每次都重新 set，虽然结果一样但会产生无谓的状态变更。
 *
 * @param {string} filePath magic doc 的绝对路径
 */
export function registerMagicDoc(filePath: string): void {
  // Only register if not already tracked
  if (!trackedMagicDocs.has(filePath)) {
    trackedMagicDocs.set(filePath, {
      path: filePath,
    })
  }
}

/**
 * Create Magic Docs agent definition
 */
/**
 * 【中文】构造"专门负责更新文档"的那个子 agent 的定义。
 *
 * 为什么要单独定义一个 agent 类型，而不是让主线程顺手改一下：
 *   ① 权限收窄：tools 里**只有 Edit**（见下面）—— 它只能改文件，不能读、不能跑命令
 *   ② 模型降级：用 'sonnet' 而不是主力模型 —— 更新文档是简单任务，
 *      用便宜的小模型省钱又够用
 *   ③ 上下文隔离：子 agent 跑在自己的上下文里，主线程的对话不会被文档内容污染
 *
 * 注意 getSystemPrompt: () => '' 返回空字符串：
 *   因为系统提示词由调用方通过 `override.systemPrompt` 传进来（见 updateMagicDoc），
 *   这里给个空实现占个位即可。
 *
 * @returns {BuiltInAgentDefinition} 子 agent 的定义
 */
function getMagicDocsAgent(): BuiltInAgentDefinition {
  return {
    agentType: 'magic-docs',
    whenToUse: 'Update Magic Docs',
    // 只允许 Edit 工具 —— 这是安全边界：子 agent 不能干别的
    tools: [FILE_EDIT_TOOL_NAME], // Only allow Edit
    model: 'sonnet',
    source: 'built-in',
    baseDir: 'built-in',
    // 系统提示词由调用方覆盖，这里给空实现
    getSystemPrompt: () => '', // Will use override systemPrompt
  }
}

/**
 * Update a single Magic Doc
 */
/**
 * 【中文】★ 更新**一个** magic doc（本文件的核心逻辑）。
 *
 * 关键步骤：
 *   ① 克隆读文件缓存，并**删掉本文件的缓存条目**（关键！见下）
 *   ② 重新读一遍文档，拿到最新内容
 *   ③ 重新检测 magic 标记还在不在；不在就取消跟踪（用户可能把它删了）
 *   ④ 拼装更新用的 prompt（交给 ./prompts.ts）
 *   ⑤ 构造一个"只允许 Edit 且只能改这一个文件"的权限回调
 *   ⑥ 派一个子 agent（分叉主对话历史）去执行更新，等它跑完
 *
 * ⚠️ 步骤 ① 是这段代码里最微妙、也最容易踩坑的地方，务必理解：
 *   FileReadTool 有一项**去重优化**：如果它认为"这个文件我刚读过、内容没变"，
 *   就返回一个 `file_unchanged` 的**占位 stub**，而不是真正的文件内容。
 *   这对正常场景是好事（省 token），但对我们是致命的——
 *   拿不到真内容，就没法重新检测 magic 标记。
 *   所以这里先克隆一份缓存（避免影响主线程的缓存状态），
 *   再把**本文件**的条目删掉，强制 FileReadTool 真的去读一次磁盘。
 *
 * @param {MagicDocInfo} docInfo 要更新的文档信息（其实就是个路径）
 * @param {REPLHookContext} context 本轮对话结束时的钩子上下文
 */
async function updateMagicDoc(
  docInfo: MagicDocInfo,
  context: REPLHookContext,
): Promise<void> {
  // 解构出需要的字段 ≈ Java 里写一堆 getter
  const { messages, systemPrompt, userContext, systemContext, toolUseContext } =
    context

  // Clone the FileStateCache to isolate Magic Docs operations. Delete this
  // doc's entry so FileReadTool's dedup doesn't return a file_unchanged
  // stub — we need the actual content to re-detect the header.
  // 中文 ①：克隆缓存（避免污染主线程状态）+ 删掉本文件条目（强制真读一次盘）。
  // 详见上面 JSDoc 里的说明 —— 这是本函数最关键的坑。
  const clonedReadFileState = cloneFileStateCache(toolUseContext.readFileState)
  clonedReadFileState.delete(docInfo.path)
  // 不可变更新：复制 toolUseContext，只替换 readFileState 这一个字段
  const clonedToolUseContext: ToolUseContext = {
    ...toolUseContext,
    readFileState: clonedReadFileState,
  }

  // Read the document; if deleted or unreadable, remove from tracking
  // 中文 ②：重新读。注意这里的错误处理是"容忍文件消失"的。
  let currentDoc = ''
  try {
    const result = await FileReadTool.call(
      { file_path: docInfo.path },
      clonedToolUseContext,
    )
    // result.data 是个联合类型，用 `as` 断言成 FileReadToolOutput 才能访问具体字段
    const output = result.data as FileReadToolOutput
    if (output.type === 'text') {
      currentDoc = output.file.content
    }
  } catch (e: unknown) {
    // FileReadTool wraps ENOENT in a plain Error("File does not exist...") with
    // no .code, so check the message in addition to isFsInaccessible (EACCES/EPERM).
    // 中文：读失败时**不一律当作错误**。文件被删了、或者没权限读，
    // 都属于"这个文档不用管了"，把它从跟踪表里移除即可。
    //
    // 为什么要额外判断 e.message.startsWith('File does not exist')：
    // 因为 FileReadTool 把 ENOENT（文件不存在）包成了一个**普通 Error**，
    // 丢失了 Node 原生的 `.code` 属性，所以 isFsInaccessible（靠 EACCES/EPERM 判断）
    // 认不出它，只能退而求其次比对错误消息文本。
    // 这是个很典型的"第三方库吞掉了错误码"的补丁式写法。
    if (
      isFsInaccessible(e) ||
      (e instanceof Error && e.message.startsWith('File does not exist'))
    ) {
      // 文件没了 → 取消跟踪，以后不再管它
      trackedMagicDocs.delete(docInfo.path)
      return
    }
    // 其它错误（比如磁盘坏了）就真的抛出去，交给上层处理
    throw e
  }

  // Re-detect title and instructions from latest file content
  // 中文 ③：再确认一次 magic 标记还在。
  // 场景：用户手动改了这个文件，把 "# MAGIC DOC:" 那行删了 —— 那我们就不该再动它。
  const detected = detectMagicDocHeader(currentDoc)
  if (!detected) {
    // File no longer has magic doc header, remove from tracking
    trackedMagicDocs.delete(docInfo.path)
    return
  }

  // Build update prompt with latest title and instructions
  // 中文 ④：拼装 prompt。传的是**最新的**标题和指令，不是登记时存下来的旧值。
  const userPrompt = await buildMagicDocsUpdatePrompt(
    currentDoc,
    docInfo.path,
    detected.title,
    detected.instructions,
  )

  // Create a custom canUseTool that only allows Edit for magic doc files
  // 中文 ⑤：构造权限回调 —— **双重锁定**的安全边界：
  //     条件 A：工具必须是 Edit
  //     条件 B：Edit 的目标路径必须**正好是**这个文档
  // 两个条件都满足才放行，否则一律拒绝。
  // 这样即使模型"想"去改别的文件，也会被硬挡下来。
  const canUseTool = async (tool: Tool, input: unknown) => {
    if (
      tool.name === FILE_EDIT_TOOL_NAME &&
      // input 是 unknown，必须先运行时检查才能安全地访问字段
      typeof input === 'object' &&
      input !== null &&
      'file_path' in input
    ) {
      const filePath = input.file_path
      if (typeof filePath === 'string' && filePath === docInfo.path) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
    }
    // 默认拒绝（白名单思维的收尾：宁可少做，不可做错）
    return {
      behavior: 'deny' as const,
      message: `only ${FILE_EDIT_TOOL_NAME} is allowed for ${docInfo.path}`,
      decisionReason: {
        type: 'other' as const,
        reason: `only ${FILE_EDIT_TOOL_NAME} is allowed`,
      },
    }
  }

  // Run Magic Docs update using runAgent with forked context
  // 中文 ⑥：派子 agent 去改文档。
  // `for await ... of` 是异步迭代：每产生一条消息就循环一次。
  // 这里循环体是空的 —— 我们只关心"跑完"这个副作用（文件被改了），不关心中间消息。
  for await (const _message of runAgent({
    agentDefinition: getMagicDocsAgent(),
    // 把拼好的 prompt 伪装成一条用户消息
    promptMessages: [createUserMessage({ content: userPrompt })],
    toolUseContext: clonedToolUseContext,
    canUseTool,
    isAsync: true,
    // forkContextMessages：**分叉**主对话历史给子 agent 看，
    // 这样它才知道"这次对话里发生了什么"，但不影响主线程的上下文
    forkContextMessages: messages,
    querySource: 'magic_docs',
    // override 用来覆盖系统提示词等，让子 agent 的"人设"和主线程一致
    override: {
      systemPrompt,
      userContext,
      systemContext,
    },
    availableTools: clonedToolUseContext.options.tools,
  })) {
    // Just consume - let it run to completion
    // 中文：只消费不处理，目的是驱动这个流一直跑到结束
  }
}

/**
 * Magic Docs post-sampling hook that updates all tracked Magic Docs
 */
/**
 * 【中文】★ 对话结束钩子：更新**所有**已登记的 magic doc。
 *
 * 为什么用 `sequential(...)` 包起来：
 * sequential 会把这个异步函数变成**串行执行**版本 —— 上一次调用没跑完时，
 * 新的调用会排队而不是并发。
 * 这很重要：如果用户快速连开几轮对话，就会触发好几次更新，
 * 并发派好几个子 agent 去改文档，既浪费 API 又可能互相覆盖对方的修改。
 * ≈ Java 的单线程池 / synchronized。
 *
 * 三个前置检查（决定"这一轮该不该更新文档"）：
 *   ① 只处理主线程（repl_main_thread）—— 子 agent / 后台任务的回合不算
 *   ② 只在**对话空闲**时更新 —— Claude 上一轮还在调工具说明活没干完，
 *      这时候总结文档会写出半成品结论
 *   ③ 有登记的文档才干活
 *
 * @param {REPLHookContext} context 本轮对话的上下文
 */
const updateMagicDocs = sequential(async function (
  context: REPLHookContext,
): Promise<void> {
  const { messages, querySource } = context

  // ① 只看主线程
  if (querySource !== 'repl_main_thread') {
    return
  }

  // Only update when conversation is idle (no tool calls in last turn)
  // 中文 ②：上一轮还有工具调用 → 说明 Claude 正在干活，先别打扰
  const hasToolCalls = hasToolCallsInLastAssistantTurn(messages)
  if (hasToolCalls) {
    return
  }

  // ③ 一个都没登记就直接返回
  const docCount = trackedMagicDocs.size
  if (docCount === 0) {
    return
  }

  // 逐个更新。为什么要 Array.from 转数组快照？
  // 因为 updateMagicDoc 内部可能会 delete 掉跟踪表里的条目（文件被删/标记被删），
  // 边遍历 Map 边删除是不安全的。先复制成数组就稳了。
  // ≈ Java 的 new ArrayList<>(map.values()) 防御性复制。
  for (const docInfo of Array.from(trackedMagicDocs.values())) {
    await updateMagicDoc(docInfo, context)
  }
})

/**
 * 初始化 Magic Docs 功能（整个功能的总入口，启动时调一次）。
 *
 * 干两件事：
 *   ① 注册"读文件监听器"：以后每次读文件，都会检查它是不是 magic doc，是就登记起来
 *   ② 注册"对话结束钩子"：每轮对话结束后触发 updateMagicDocs 去更新
 *
 * 为什么整个功能只对内部员工（USER_TYPE=ant）开放：
 * 它会**额外消耗 token**（每轮对话都要派子 agent 去更新文档），
 * 而且"自动改用户的文件"是个需要谨慎对待的行为。
 * 先在内部跑一段时间、观察效果，再决定是否放量。
 */
export async function initMagicDocs(): Promise<void> {
  if (process.env.USER_TYPE === 'ant') {
    // Register listener to detect magic docs when files are read
    // 中文 ①：读文件时回调。注意这个监听器是"被动发现"的 ——
    // 不需要用户声明"这是我的 magic doc"，只要 Claude 读到它、发现标记，就自动接管。
    registerFileReadListener((filePath: string, content: string) => {
      const result = detectMagicDocHeader(content)
      if (result) {
        registerMagicDoc(filePath)
      }
    })

    // 中文 ②：注册对话结束钩子
    registerPostSamplingHook(updateMagicDocs)
  }
}
