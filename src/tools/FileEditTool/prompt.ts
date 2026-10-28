/**
 * 【一句话定位】
 *   给模型看的 Edit 工具提示词：「工具该怎么用、哪些情况会失败」全部以自然语言写在这里。
 *
 * 【在架构中的位置】
 *   上游调用链：提示词构建/工具注册 → FileEditTool.ts 的 description()/prompt() → 本文件的 getEditToolDescription()。
 *   下游依赖：../FileReadTool/prompt.js（引用 FileRead 的工具名）、../../utils/file.js（行号格式是否启用紧凑模式）。
 *   设计取向：工具的“使用契约”放在 prompt 里而不是文档里——模型只能看到 prompt，
 *   写在别处等于没写。所以 prompt.ts 里的措辞需要像 API 文档一样精确。
 *
 * 【本文件包含什么】
 *   - getPreReadInstruction()：强制「编辑前必须先 Read 一次」的说明
 *   - getEditToolDescription()：对外导出的描述入口
 *   - getDefaultEditDescription()：实际的描述正文（内含 old_string 唯一性要求）
 *
 * 【重点：为什么要强调 old_string 必须唯一】
 *   见下面第 26 行附近的注释。一句话概括：不唯一就只能改第一处，
 *   而“改了不是你想改的那处”是最难发现的失败模式，所以宁可报错让模型加长上下文。
 *
 * 【TS 语法速查】
 *   - 反引号模板字符串 `` `...${x}...` ``：支持多行与插值。≈ Java 15+ 的文本块 + String.formatted()。
 *   - `${FILE_READ_TOOL_NAME}`：把别的模块的常量插进来，保证工具名永远是最新值（不写死字符串）。
 *   - 三元表达式 `cond ? a : b` 嵌进模板：按开关动态改文案（这里用于区分是否 ant 内部用户在 conciseness 上有差异）。
 *   - `process.env.USER_TYPE === 'ant'`：读环境变量做特性分支。注意它是**运行时**判断，
 *     与 toolkit 里 feature('X') 那种**编译期**开关不同（后者会在打包时把整段代码删掉）。
 *   - 函数默认不写返回类型时，TS 会**自动推断**（这里是 string）。
 */
import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

// “编辑前必须先 Read”的软约束写成一条 prompt 条目。
// 为什么强调它：① Edit 依赖用户/模型刚读过的内容做定位，读过才能保证 old_string 准确；
//                ② 防止模型凭记忆瞎猜文件内容（幻觉）导致改错。
// 工具侧也会有硬校验（没读过就报错），这里是先在提示词里说清楚。
function getPreReadInstruction(): string {
  return `\n- You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. `
}

// 对外导出的入口。为什么要多包一层 getDefaultEditDescription：
// 便于将来按 feature flag 切到另一套描述（比如“多行编辑版”），调用方不用改。
export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

// 默认（也是目前唯一的）描述正文。
function getDefaultEditDescription(): string {
// isCompactLinePrefixEnabled()：行号前缀有两种格式（紧凑的 “12→” 与传统的 “    12→”）。
// 必须把当前用的是哪种**明确告诉模型**，否则模型构造 old_string 时会误把行号前缀当成文件内容的一部分，
// 导致匹配失败。这是非常常见的失败点，所以专门动态生成这句说明。
  const prefixFormat = isCompactLinePrefixEnabled()
    ? 'line number + tab'
    : 'spaces + line number + arrow'
// 只对内部用户（ant）追加“用尽量短但唯一”的建议：内部模型/重度用户更需要省 token 的提示。
// 对外用户不展示，避免把简单的事说复杂。
  const minimalUniquenessHint =
    process.env.USER_TYPE === 'ant'
      ? `\n- Use the smallest old_string that's clearly unique — usually 2-4 adjacent lines is sufficient. Avoid including 10+ lines of context when less uniquely identifies the target.`
      : ''
// 首句 “Performs exact string replacements in files” 定调：这是**精确字符串替换**，不是模糊/正则替换。
// 明确这一点能显著减少模型尝试用通配符、正则或省略来满足匹配的坏习惯。
  return `Performs exact string replacements in files.

Usage:${getPreReadInstruction()}
// 提醒模型只能复制「行号前缀之后」的内容。
// 为什么反复强调：Read 输出里的 “123→xxx” 前缀被误当成文件内容抄进 old_string，
// 是 Replace 失败率最高的一类原因，所以拆出专门一条。
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: ${prefixFormat}. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
// 限制 emoji：避免模型自作主张往代码里塞图标（用户没要求就不该加）。
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
// ★★ old_string 唯一性要求 —— 这是 Edit 工具防误改的核心约定：
//   - old_string 必须在文件里唯一，否则直接 FAIL（不会静默改第一处）。
//   - 静默改第一处的问题：文件里有 5 处 `const x = 1`，模型想改第 3 处，
//     实际被改的是第 1 处。工具返回成功，模型后续推理全建立在错误前提上，且很难自查。
//   - 失败时给的两条出路：① 多带几行上下文使 old_string 变唯一；② 用 replace_all 显式全替换。
// 换言之：**歧义必须显式消除，不能靠“默认挑一个”**。
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.${minimalUniquenessHint}
// replace_all 的推荐场景：跨文件改同一处、或变量重命名这类“所有出现都要改”的操作。
// 它是显式的、可审计的，与“因为不唯一而被逼用”不同。
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`
}
