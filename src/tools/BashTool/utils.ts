// 中文补充：函数 stripEmptyLines —— 注意它刻意**不用** content.trim()：
// trim 会把正文行首的缩进也吃掉，而命令输出（如 tree、缩进的报错）的缩进是有意义的
/**
 * 【一句话定位】BashTool 的「杂项工具箱」：输出裁剪、空行清理、data-URI 图片解析与压缩、
 *   工作目录（cwd）越界后的复位、MCP 结果摘要。都是被主流程各处复用的纯工具函数。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx（执行完命令后处理结果）、UI.tsx / BashToolResultMessage.tsx（展示）
 *   下游：src/utils/shell/outputLimits.js（输出上限）、utils/imageResizer.js（图片压缩）、
 *        src/utils/Shell.js（setCwd）、src/utils/permissions/filesystem.js（工作目录白名单）、
 *        src/bootstrap/state.js（getOriginalCwd）、utils/stringUtils.js、analytics
 *   调用链：BashTool.call -> formatOutput / resizeShellImageOutput / resetCwdIfOutsideProject -> ...
 *
 * 【本文件包含什么】
 *   - stripEmptyLines()：只去掉首尾的纯空行，保留正文行内的缩进（和 trim() 的区别就在这）
 *   - isImageOutput() / parseDataUri()：判断并解析 data:image/...;base64,... 形式的输出
 *   - buildImageToolResult()：把 data-URI 包装成 API 要求的 image 类型 tool_result
 *   - resizeShellImageOutput()：图片过大时重读输出文件并压缩尺寸/体积
 *   - formatOutput()：按上限裁剪 stdout，并统计总行数
 *   - stdErrAppendShellResetMessage()：把「cwd 已复位」提示追加到 stderr
 *   - resetCwdIfOutsideProject()：cwd 跑到允许范围外时复位回原始目录
 *   - createContentSummary()：把一组内容块（文本/图片）压缩成一行可读摘要
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `?.` 可选链 ≈ null 检查链：a?.b 在 a 为 null/undefined 时直接返回 undefined，不抛 NPE
 *   - `??` 空值合并：仅当左侧是 null/undefined 才取右侧（与 || 区别：0 和 '' 不会被替换掉）
 *   - `as X` ≈ Java 强制类型转换，只是编译期声明，运行时不做任何检查
 *   - `Promise<T>` ≈ CompletableFuture<T>；`await` ≈ 阻塞拿结果（但不占线程）
 *   - `import { readFile, stat } from 'fs/promises'`：Node 内置模块的 Promise 版文件 API
 *   - 返回值写成 `{ a: string; b: number }` 是匿名对象类型 ≈ Java 的临时 DTO
 *   - 类型标注在变量名**后面**，Java 在前面，最容易看串
 */
import type {
  Base64ImageSource,
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { readFile, stat } from 'fs/promises'
import { getOriginalCwd } from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { pathInAllowedWorkingPath } from 'src/utils/permissions/filesystem.js'
import { setCwd } from 'src/utils/Shell.js'
import { shouldMaintainProjectWorkingDir } from '../../utils/envUtils.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { getMaxOutputLength } from '../../utils/shell/outputLimits.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'
/**
 * 【做什么】判断一段输出是不是 base64 图片Data URI
 * 【为什么需要】命令可能输出图片（如截图、matplotlib 图），必须和普通文本走不同的展示通道
 */
/**
 * 【做什么】把 data-URI 解析成 { mediaType, data } 两部分
 * 【为什么需要】后面要分别用这两部分：mediaType 决定解码格式，data 需要 base64 解码成字节
 * 【入参】s：可能带首尾空白的 data-URI 字符串
 * 【返回】解析结果对象；格式不符返回 null（注意：不是抛异常，调用方只需判空）
 * 【关键步骤】
 *   ① trim() 先去空白（输出里常带换行）
 *   ② match() 捕获两个分组
 *   ③ 两个分组都必须非空才算成功（match[1] / match[2] 可能为 undefined，故显式检查）
 */
/**
 * 【做什么】把 stdout 里的 data-URI 包成 API 规定的 tool_result（image 类型）
 * 【为什么需要】模型只能理解结构化 content block，直接塞一串 base64 文本它看不懂
 * 【返回】tool_result 块；解析失败返回 null，让调用方回退到「按普通文本处理」
 */
/**
 * 【做什么】把 shell 输出的图片压缩后重新编码成 data-URI
 * 【为什么需要】stdout 回读时会被截断，截断的 base64 解码出来是坏图；
 *   所以「输出溢出到文件」时必须改从文件里读完整内容。此外只压体积不压尺寸会漏掉
 *   小体积高分辨率的图（如 dpi=300 的 matplotlib PNG），一次多图就会把请求打爆
 * 【入参】stdout：回读到的 stdout；outputFilePath / outputFileSize：输出落盘时的文件路径与大小
 * 【返回】压缩后的 data-URI；源不是 data-URI 或超过上限返回 null（交给调用方决定是否还当图片）
 * 【关键步骤】
 *   ① 有落盘文件 → 取大小（优先用传入值，没有才 stat 一次）→ 超 20MB 直接放弃
 *   ② 从文件重读完整输出，避免用被截断的 stdout
 *   ③ 解析 data-URI → base64 解码成 Buffer（≈ Java byte[]）
 *   ④ 从 mediaType 里切出扩展名，默认 png
 *   ⑤ 压缩（体积 + 尺寸），重新拼成 data-URI
 */
/**
 * 【做什么】把一组内容块（文本 + 图片）压成一行人类可读摘要，如 `MCP Result: [2 images] [1 text block]`
 * 【为什么需要】MCP 工具返回可能很长，UI 上只需一句概览 + 文本前 200 字的预览
 * 【入参】content：内容块数组（每个块是 text 或 image）
 * 【返回】摘要字符串
 * 【关键步骤】
 *   ① 遍历分类计数；文本块额外取前 200 字做预览
 *   ② `'text' in block`：用 in 运算符收窄类型——block 是联合类型，只有确认有 text 字段才能读它
 *   ③ plural() 处理单复数，避免出现 `1 images` 这种英文错误
 */
/**
 * Strips leading and trailing lines that contain only whitespace/newlines.
 * Unlike trim(), this preserves whitespace within content lines and only removes
 * completely empty lines from the beginning and end.
 */
export function stripEmptyLines(content: string): string {
  const lines = content.split('\n')

  // Find the first non-empty line
  let startIndex = 0
  // `lines[i]?.trim()` 的可选链不能省：越界访问会得到 undefined，直接 .trim() 会抛异常
  // （TS 开了 noUncheckedIndexedAccess 时，数组下标访问的类型是 T | undefined，所以必须 ?. ）
  while (startIndex < lines.length && lines[startIndex]?.trim() === '') {
    startIndex++
  }

  // Find the last non-empty line
  let endIndex = lines.length - 1
  while (endIndex >= 0 && lines[endIndex]?.trim() === '') {
    endIndex--
  }

  // If all lines are empty, return empty string
  if (startIndex > endIndex) {
    return ''
  }

  // Return the slice with non-empty lines
  return lines.slice(startIndex, endIndex + 1).join('\n')
}

/**
 * Check if content is a base64 encoded image data URL
 */
export function isImageOutput(content: string): boolean {
  return /^data:image\/[a-z0-9.+_-]+;base64,/i.test(content)
}

// 两个捕获组：第 1 组是 mediaType（如 image/png），第 2 组是 base64 正文
// ([^;]+) 表示「分号之前的任意非空内容」，比写成具体的 image/png 更通用
const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/

/**
 * Parse a data-URI string into its media type and base64 payload.
 * Input is trimmed before matching.
 */
export function parseDataUri(
  s: string,
): { mediaType: string; data: string } | null {
  const match = s.trim().match(DATA_URI_RE)
  if (!match || !match[1] || !match[2]) return null
  return { mediaType: match[1], data: match[2] }
}

/**
 * Build an image tool_result block from shell stdout containing a data URI.
 * Returns null if parse fails so callers can fall through to text handling.
 */
export function buildImageToolResult(
  stdout: string,
  toolUseID: string,
): ToolResultBlockParam | null {
  const parsed = parseDataUri(stdout)
  if (!parsed) return null
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          // `as` 强制转换的必要性：parsed.mediaType 是运行时字符串，类型上是宽泛的 string；
          //   而 API 类型要求 media_type 必须是联合类型里的某一个值（'image/png' | ...）。
          //   这里只能「骗」编译器——真正的合法性靠 parseDataUri 的格式约束兜住
          media_type: parsed.mediaType as Base64ImageSource['media_type'],
          data: parsed.data,
        },
      },
    ],
  }
}

// Cap file reads to 20 MB — any image data URI larger than this is
// well beyond what the API accepts (5 MB base64) and would OOM if read
// into memory.
// 20MB 上限的来历：API 实际只接受 5MB base64，但输出文件可能更大；
//   设 20MB 是「再大就不值得读进内存」的止损线（防止 OOM）
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024

/**
 * Resize image output from a shell tool. stdout is capped at
 * getMaxOutputLength() when read back from the shell output file — if the
 * full output spilled to disk, re-read it from there, since truncated base64
 * would decode to a corrupt image that either throws here or gets rejected by
 * the API. Caps dimensions too: compressImageBuffer only checks byte size, so
 * a small-but-high-DPI PNG (e.g. matplotlib at dpi=300) sails through at full
 * resolution and poisons many-image requests (CC-304).
 *
 * Returns the re-encoded data URI on success, or null if the source didn't
 * parse as a data URI (caller decides whether to flip isImage).
 */
export async function resizeShellImageOutput(
  stdout: string,
  outputFilePath: string | undefined,
  outputFileSize: number | undefined,
): Promise<string | null> {
  let source = stdout
  if (outputFilePath) {
    // `??` 而不是 `||`：outputFileSize 为 0 时也要当作有效值使用，
    //   若写成 || 就会误判成「没有值」从而多一次 stat 系统调用
    const size = outputFileSize ?? (await stat(outputFilePath)).size
    if (size > MAX_IMAGE_FILE_SIZE) return null
    source = await readFile(outputFilePath, 'utf8')
  }
  const parsed = parseDataUri(source)
  if (!parsed) return null
  const buf = Buffer.from(parsed.data, 'base64')
  // 从 'image/png' 里取 '/' 后面的部分；取不到（如 mediaType 不含 /）就退回 png
  const ext = parsed.mediaType.split('/')[1] || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(
    buf,
    buf.length,
    ext,
  )
  return `data:image/${resized.mediaType};base64,${resized.buffer.toString('base64')}`
}

/**
 * 【做什么】按上限裁剪命令输出，并算出行数
 * 【为什么需要】一条 cat 大文件可能输出几十 MB，全塞进上下文会爆 token；必须截断 + 告知用户截断量
 * 【入参】content：stdout 原文
 * 【返回】{ totalLines 原始总行数, truncatedContent 裁剪后的内容, isImage 是否为图片 }
 * 【关键步骤】
 *   ① 是图片 → 原样返回（图片走另一条压缩链路，不能按字符截断，否则 base64 直接坏掉）
 *   ② 没超限 → 原样返回，只统计行数
 *   ③ 超限 → 按字符截断，并用 countCharInString(..., maxOutputLength) 只数「被截掉部分」的换行，
 *      告诉用户还剩多少行没显示
 */
export function formatOutput(content: string): {
  totalLines: number
  truncatedContent: string
  isImage?: boolean
} {
  const isImage = isImageOutput(content)
  if (isImage) {
    return {
      totalLines: 1,
      truncatedContent: content,
      isImage,
    }
  }

  const maxOutputLength = getMaxOutputLength()
  if (content.length <= maxOutputLength) {
    return {
      totalLines: countCharInString(content, '\n') + 1,
      truncatedContent: content,
      isImage,
    }
  }

  const truncatedPart = content.slice(0, maxOutputLength)
  const remainingLines = countCharInString(content, '\n', maxOutputLength) + 1
  const truncated = `${truncatedPart}\n\n... [${remainingLines} lines truncated] ...`

  return {
    totalLines: countCharInString(content, '\n') + 1,
    truncatedContent: truncated,
    isImage,
  }
}

// 箭头函数 ≈ Java lambda：stderr => ... 等价于 (stderr) => { return ... }，单表达式时可省 {} 与 return
export const stdErrAppendShellResetMessage = (stderr: string): string =>
  `${stderr.trim()}\nShell cwd was reset to ${getOriginalCwd()}`

/**
 * 【做什么】发现当前工作目录跑到「允许范围之外」时，把它复位回启动目录
 * 【为什么需要】模型常用 `cd` 换目录（甚至 cd 出项目外），若不复位，后续所有相对路径命令
 *   都会在一个用户没授权过的目录里执行——这是典型的越权路径问题（本目录 pathValidation 防的正是这个）
 * 【入参】toolPermissionContext：含允许的工作目录集合
 * 【返回】true 表示确实做了复位（调用方据此给用户提示）
 * 【关键步骤】
 *   ① 取当前 cwd 与启动时的 originalCwd
 *   ② 两种复位条件：环境变量要求「始终保持在项目目录」，或 cwd 已越出允许路径
 *   ③ 注意短路顺序：`cwd !== originalCwd && !pathInAllowedWorkingPath(...)` —— 
 *      cwd 没动过就跳过后面昂贵的路径校验（这是性能上的刻意优化，不是逻辑重复）
 *   ④ 只有「非强制保持」的场景才上报埋点并返回 true（强制场景下复位是常态，不值得打扰用户）
 */
export function resetCwdIfOutsideProject(
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const cwd = getCwd()
  const originalCwd = getOriginalCwd()
  const shouldMaintain = shouldMaintainProjectWorkingDir()
  if (
    shouldMaintain ||
    // Fast path: originalCwd is unconditionally in allWorkingDirectories
    // (filesystem.ts), so when cwd hasn't moved, pathInAllowedWorkingPath is
    // trivially true — skip its syscalls for the no-cd common case.
    (cwd !== originalCwd &&
      // 路径白名单校验的落点：真正的规则在 utils/permissions/filesystem.js，这里只负责触发
      !pathInAllowedWorkingPath(cwd, toolPermissionContext))
  ) {
    // Reset to original directory if maintaining project dir OR outside allowed working directory
    setCwd(originalCwd)
    if (!shouldMaintain) {
      logEvent('tengu_bash_tool_reset_to_original_dir', {})
      return true
    }
  }
  return false
}

/**
 * Creates a human-readable summary of structured content blocks.
 * Used to display MCP results with images and text in the UI.
 */
export function createContentSummary(content: ContentBlockParam[]): string {
  const parts: string[] = []
  let textCount = 0
  let imageCount = 0

  for (const block of content) {
    if (block.type === 'image') {
      imageCount++
    // `in` 是关键：TS 里联合类型必须先收窄才能访问特有字段，这里等价于 Java 的 instanceof 判断
    } else if (block.type === 'text' && 'text' in block) {
      textCount++
      // Include first 200 chars of text blocks for context
      const preview = block.text.slice(0, 200)
      parts.push(preview + (block.text.length > 200 ? '...' : ''))
    }
  }

  const summary: string[] = []
  if (imageCount > 0) {
    summary.push(`[${imageCount} ${plural(imageCount, 'image')}]`)
  }
  if (textCount > 0) {
    summary.push(`[${textCount} text ${plural(textCount, 'block')}]`)
  }

  return `MCP Result: ${summary.join(', ')}${parts.length > 0 ? '\n\n' + parts.join('\n\n') : ''}`
}
