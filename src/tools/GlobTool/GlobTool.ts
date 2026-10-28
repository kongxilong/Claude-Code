/**
 * 【一句话定位】
 *   Glob 工具的“工具定义”本体：声明入参/出参 schema、做权限与入参校验、真正执行按文件名通配符（glob pattern）的搜索，
 *   并把结果包装成回传给模型的 tool_result。
 *
 * 【在架构中的位置】
 *   上游调用链：
 *     模型返回 tool_use（name = "Glob"）
 *       → src/query.ts 主循环 / src/services/tools/*（工具编排层，如 runTools、StreamingToolExecutor）
 *       → src/Tool.ts 里 buildTool() 造出的工具对象（本文件就是造它的地方）
 *       → 本文件的 validateInput() → checkPermissions() → call()
 *   下游依赖：
 *     - ../../utils/glob.js 的 glob()：真正遍历目录并做通配符匹配的实现（底层借 ripgrep 的文件枚举能力，
 *       因此能自动跳过 .gitignore 里的文件、速度远快于自己递归 readdir）
 *     - ../../utils/permissions/filesystem.js 的 checkReadPermissionForTool()：统一的读权限判定
 *     - ../../utils/path.js 的 expandPath()/toRelativePath()：~ 展开、绝对路径 ↔ 相对 cwd 路径
 *     - ./UI.js：终端里给人看的渲染函数（userFacingName / renderToolUseMessage / ...）
 *     - ./prompt.js：喂给模型的工具名与工具描述（GLOB_TOOL_NAME / DESCRIPTION）
 *   同层兄弟：GrepTool（按内容搜）、FileReadTool（读内容）。本文件直接复用了 GrepTool 的结果渲染。
 *
 * 【本文件包含什么】
 *   - inputSchema / outputSchema：用 zod 声明的入参、出参结构（同时充当运行时校验器）
 *   - type InputSchema / OutputSchema / Output：从上面的 schema 反推出来的 TS 类型
 *   - GlobTool：buildTool({...}) 产出的工具对象，是一堆钩子的集合（描述、校验、权限、执行、渲染）
 *   - validateInput()：校验 path 存在且确实是目录
 *   - call()：真正跑 glob() 并组装 { filenames, durationMs, numFiles, truncated }
 *   - mapToolResultToToolResultBlockParam()：把出参序列化成模型能读的 tool_result 文本
 *
 * 【TS 语法速查】（只列本文件真实出现的写法）
 *   - `import type { X } from '...'`：只导入“类型”，编译成 JS 后这一行会被删掉。
 *     对照 Java：只 import 一个接口、不产生运行时依赖。带 `type` 与不带的区别仅在于编译产物。
 *   - `z.strictObject({...})`：zod 校验器。strict = 出现 schema 里没声明的字段就报错。
 *     对照 Java：Bean Validation 的 @NotNull/@Pattern，但 zod 是运行时真校验，且能顺带产出类型。
 *   - `lazySchema(() => ...)`：把 schema 的构造包进箭头函数、用到时才建。
 *     目的：省启动开销、也绕开模块循环依赖。对照 Java：Supplier 懒加载。
 *   - `type X = ReturnType<typeof someFn>`：`typeof someFn` 取“函数本身的类型”，`ReturnType<>` 再取它的返回值类型。
 *     即“从值反推出类型”。Java 没有对应语法（Java 的 Class<?> 是运行期对象，不是类型）。
 *   - `z.infer<typeof schema>`：从 zod schema 反推出 TS 类型。≈ 注解处理器根据注解生成 DTO 类型。
 *   - `satisfies ToolDef<InputSchema, Output>`：按接口检查，但**保留**字面量的精确类型（不像 `as` 会把类型擦掉）。
 *     对照 Java：类似“implements 之后仍保留实现类的具体类型”，比强转安全。
 *   - `async call(input, { abortController, getAppState, globLimits })`：第二个参数直接“解构”上下文对象，
 *     等价于 const { abortController } = ctx。对照 Java：ctx.getAbortController() 的语法糖版。
 *   - `globLimits?.maxResults ?? 100`：`?.` 是 null 安全取属性（globLimits 为 null 时整体得到 undefined 而不报错）；
 *     `??` 是空值合并，**只有 null/undefined 才走默认值**，注意与 `||` 的区别：0 和 '' 不会被替换掉。
 *   - `[...arr, ...(cond ? [x] : [])]`：数组展开。条件成立才追加一个元素。≈ Java Stream.concat(Arrays.asList(x))。
 *   - `100_000`：数字下划线分隔符，值就是 100000，纯粹为了好读（Java 也支持）。
 *   - `async fn(): Promise<ValidationResult>`：async 函数的返回值会被自动包成 Promise。
 *     对照 Java：CompletableFuture<T>，await ≈ .join()。
 *   - `get inputSchema(): InputSchema { return inputSchema() }`：getter。
 *     调用方写 `tool.inputSchema` 就能触发方法体（**不带括号**）≈ Java 的 getter，但调用处看不出来是方法。
 *   - `function*`/`yield` 本文件没有，但在同目录 UI 与兄弟工具里常见：≈ Java 的 Flux 流式 / Iterable 惰性产出。
 */
import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { glob } from '../../utils/glob.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath, toRelativePath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { DESCRIPTION, GLOB_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

// 入参 schema：模型调用本工具时必须给出的字段。
// 注意用 strictObject：模型多传一个字段就算非法，这样能在早期把“模型乱传参数”暴露出来，
// 而不是静默忽略后到 call() 里才炸。
const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe(
        'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 出参 schema：call() 的返回值形状。它同时用于两件事——
//   ① 运行时校验自己没写错；② 通过 z.infer 生成 Output 类型给下游用。
const outputSchema = lazySchema(() =>
  z.object({
    durationMs: z
      .number()
      .describe('Time taken to execute the search in milliseconds'),
    numFiles: z.number().describe('Total number of files found'),
    filenames: z
      .array(z.string())
      .describe('Array of file paths that match the pattern'),
    truncated: z
      .boolean()
      .describe('Whether results were truncated (limited to 100 files)'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

// 对外暴露的出参类型。UI 层、结果裁剪逻辑都 import 这个类型，
// 好处是“类型跟着 schema 走”，改 schema 时类型自动跟着变，不会两处不同步。
export type Output = z.infer<OutputSchema>

// buildTool() 是工具工厂：把这一大坨钩子函数打包成一个统一的工具对象，交给 src/Tool.ts 注册。
// 为什么是“对象字面量 + 一堆钩子”而不是 class：工具之间差异极大，用对象拼装比继承体系更灵活，
// 也方便只实现自己关心的钩子（没实现的用默认行为）。
export const GlobTool = buildTool({
// 工具名必须与模型看到的 tool name 完全一致，否则模型调用时匹配不上。
// 单独放在 prompt.ts 里是为了让 UI / 权限规则 / 提示词共用同一个常量，避免字符串写散。
  name: GLOB_TOOL_NAME,
// searchHint：给“工具检索/自动补全”用的短提示，帮助上层判断该选哪个工具。
  searchHint: 'find files by name pattern or wildcard',
// 结果体积上限（字符数）。超过会被上层截断，防止一次搜索把整个上下文窗口撑爆。
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  getToolUseSummary,
// 把入参压缩成一句人类可读的活动描述，用于终端里显示“正在做什么”。
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Finding ${summary}` : 'Finding files'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
// 声明本工具并发安全（纯读操作、无副作用），上层因此可以并行调度多个 Glob，显著提速。
  isConcurrencySafe() {
    return true
  },
// 声明只读：不修改文件系统。权限系统据此可以走更宽松的审批路径（读通常免确认）。
  isReadOnly() {
    return true
  },
// 给“自动分类器”用的输入特征：这里只取 pattern（通配符本身最能代表这次搜索的意图）。
  toAutoClassifierInput(input) {
    return input.pattern
  },
// 告诉上层这是“搜索类”而非“读取类”命令，用于统计与展示分组。
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
// 解析出搜索根目录：没传 path 就用当前工作目录（cwd）。
// expandPath 负责把 ~、环境变量等展开成绝对路径，后面所有 fs 操作都基于它。
  getPath({ path }): string {
    return path ? expandPath(path) : getCwd()
  },
// 权限匹配器：返回一个函数，用来判断某条权限规则（如 `Glob(src/**)`）是否命中本次调用。
// 用闭包返回函数，好处是 pattern 只解析一次，后面多次复用。
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
// 入参校验（在读盘之前跑）。目的是把“路径不存在 / 不是目录”变成对模型友好的报错，
// 让模型能自己纠错（比如换个目录），而不是抛一段栈。
  async validateInput({ path }): Promise<ValidationResult> {
    // If path is provided, validate that it exists and is a directory
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
// 中文补充：UNC 路径形如 \\server\share（Windows 网络共享）。
// 对它做 stat 会触发 SMB/NTLM 握手，可能把本机凭据泄漏给远端服务器，所以直接跳过校验放行。
// 这是安全兜底，不是功能逻辑。
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

// 用 let 声明（不用 const）：stats 需要在 try 里赋值、try 外使用。
// 对照 Java：局部变量必须初始化才能用，这里 TS 靠控制流分析判断“走到这里必然已赋值”。
      let stats
      try {
        stats = await fs.stat(absolutePath)
      } catch (e: unknown) {
// 只有 ENOENT（文件/目录不存在）才转成友好报错；其它异常（权限不足、IO 错误）原样往上抛，
// 因为那些不是“模型传错参数”，掩盖掉反而难排查。
        if (isENOENT(e)) {
// 猜测用户是不是想搜 cwd 下的同名目录（常见错误：传了相对路径/拼错前缀），
// 在报错里附带“你是不是想找 xxx”，能显著提高模型自我纠错的成功率。
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Directory does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
          if (cwdSuggestion) {
            message += ` Did you mean ${cwdSuggestion}?`
          }
          return {
            result: false,
            message,
// errorCode 是给上层/埋点用的分类码：1=路径不存在，2=路径不是目录。
            errorCode: 1,
          }
        }
        throw e
      }

// stat 成功但目标不是目录 → 也报错。glob 的语义是“在目录下按模式找文件”，传文件进来毫无意义。
      if (!stats.isDirectory()) {
        return {
          result: false,
          message: `Path is not a directory: ${path}`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
// 权限判定：复用统一的读权限检查（读权限规则、会话授权、忽略规则都在这套逻辑里）。
// 为什么不在这里自己判：权限策略很复杂（项目级/用户级/会话级），统一入口才能保证所有读工具行为一致。
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GlobTool,
      input,
      appState.toolPermissionContext,
    )
  },
// prompt() 返回喂给模型的工具描述。做成函数而不是常量，是为了支持按开关（feature flag）动态改描述。
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // Reuses Grep's render (UI.tsx:65) — shows filenames.join. durationMs/
  // numFiles are "Found 3 files in 12ms" chrome (under-count, fine).
// 抽出纯文本供上层做“搜索结果去重/合并/二次检索”。
// 用 \n 拼接是为了和终端展示形态保持一致。
  extractSearchText({ filenames }) {
    return filenames.join('\n')
  },
// ★ 工具真正的执行入口。只有走到这里才真的扫盘。
  async call(input, { abortController, getAppState, globLimits }) {
// 计时起点：出参里的 durationMs 用于 UI 展示“Found 3 files in 12ms”，也用于性能埋点。
    const start = Date.now()
    const appState = getAppState()
// 结果条数上限（默认 100）。为什么要限：glob 可能匹配出上万个文件，
// 全量回给模型会把上下文窗口占满、也会拖慢渲染，所以硬性截断并标记 truncated。
    const limit = globLimits?.maxResults ?? 100
// 调用底层 glob()。传入 abortController.signal 是为了让用户 Ctrl-C / 超时时能中断扫盘；
// 传入权限上下文是为了让遍历过程就跳过无权限目录，而不是先扫出来再过滤。
    const { files, truncated } = await glob(
      input.pattern,
      GlobTool.getPath(input),
      { limit, offset: 0 },
      abortController.signal,
      appState.toolPermissionContext,
    )
    // Relativize paths under cwd to save tokens (same as GrepTool)
// 把绝对路径转成相对 cwd 的路径。两个目的：① 省 token（路径短很多）；② 输出更贴近用户直觉。
// 这是所有搜索类工具的统一做法（GrepTool 也一样）。
    const filenames = files.map(toRelativePath)
// 显式标注 Output 类型：这样出参 schema 一旦改动，这里会在编译期就报错，不会出现“字段漏了但能跑”。
    const output: Output = {
      filenames,
      durationMs: Date.now() - start,
      numFiles: filenames.length,
      truncated,
    }
    return {
      data: output,
    }
  },
// 把出参转成 Anthropic API 要求的 tool_result 块：必须带 tool_use_id 回关联到那次工具调用，
// 内容统一压成字符串（模型侧只认文本/图片块）。
  mapToolResultToToolResultBlockParam(output, toolUseID) {
// 空结果也要回一条明确文本 “No files found”。
// 为什么不回空字符串：模型看到空内容无法判断是“没找到”还是“工具出错”，容易陷入重试循环。
    if (output.filenames.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
// 用数组 + join('\n') 拼最终结果，而不是字符串累加：
// 这样“追加截断提示”只是一个可选数组元素，逻辑清晰且不留多余空行。
        ...output.filenames,
        ...(output.truncated
          ? [
// 截断时明确告诉模型“考虑用更具体的 path 或 pattern”——这是给模型的下一步行动建议，
// 能直接引导它收敛搜索范围，而不是盲目重试。
              '(Results are truncated. Consider using a more specific path or pattern.)',
            ]
          : []),
      ].join('\n'),
    }
  },
// satisfies（而非 as / 直接赋值）：既按 ToolDef 校验，又保留对象字面量的精确类型，
// 让上层能推导出 inputSchema/outputSchema 的具体类型。见文件头【TS 语法速查】。
} satisfies ToolDef<InputSchema, Output>)
