/**
 * 【一句话定位】
 *   FileEditTool 的“纯算法工具箱”：只做字符串替换、生成 diff/snippet、以及各种“入参归一化/等价性比较”，
 *   **本文件不做任何写盘操作**（写盘在 FileEditTool.ts 里），也不碰权限、不碰 UI。
 *
 * 【在架构中的位置】
 *   上游调用链：
 *     模型返回 tool_use（name="Edit"）
 *       → src/services/tools/*（工具编排）→ src/Tool.ts 注册的工具对象
 *       → FileEditTool.ts：权限校验、读文件、UI 交互、确认后
 *       → 本文件的 normalizeFileEditInput() → getPatchForEdits() → 由 FileEditTool.ts 落盘
 *   下游依赖：
 *     - diff 包（structuredPatch）：生成结构化 diff hunk
 *     - ../../utils/diff.js：getPatchFromContents / getPatchForDisplay / DIFF_TIMEOUT_MS（带超时的 diff 封装）
 *     - ../../utils/file.js：addLineNumbers（加行号）、convertLeadingTabsToSpaces、readFileSyncCached（带缓存的读）
 *   同级文件：types.ts（类型定义）、FileEditTool.ts（编排 + 落盘）、UI.tsx（展示）、constants.ts（常量）。
 *
 * 【本文件包含什么】
 *   - 引号处理：normalizeQuotes / findActualString / preserveQuoteStyle / applyCurly*Quotes / isOpeningContext
 *   - 换行与空白：stripTrailingWhitespace
 *   - 核心替换：applyEditToFile（单次替换）、getPatchForEdit（单条）、getPatchForEdits（多条 + 生成 patch）
 *   - 片段生成：getSnippetForTwoFileDiff（附件用）、getSnippetForPatch（按 hunk 定位）、getSnippet（单次编辑定位）
 *   - 反解 tab：getEditsForPatch（把 patch 转回 FileEdit[]）
 *   - 纠错归一化：DESANITIZATIONS + desanitizeMatchString + normalizeFileEditInput
 *   - 等价性比较：areFileEditsEquivalent / areFileEditsInputsEquivalent（用于去重与幂等判断）
 *
 * 【重点：为什么 old_string 必须唯一匹配】
 *   本文件本身不强制唯一性（唯一性校验在 FileEditTool.ts 里做），但整套设计都围绕它：
 *     - applyEditToFile 在非 replace_all 时用的是 String.prototype.replace —— 它天然只替换**第一处**。
 *       如果 old_string 在文件里出现多次，就会被静默改到“某一处”（未必是模型想改的那处），这是最危险的失败模式：
 *       模型以为改了 A 处，实际改了 B 处，之后继续基于错误假设工作。
 *     - 所以上层要求 old_string 必须唯一，否则直接报错并要求模型补充上下文（或多行上下文/replace_all）。
 *       宁可报错重试，也不要“改错地方还看起来成功了”。
 *     - replace_all=true 才是显式授权“所有匹配都改”，此时走 replaceAll。
 *
 * 【TS 语法速查】（只列本文件真实出现的写法）
 *   - 类型标注在变量名**后面**：`function f(str: string): string`。Java 在前面，最容易看串。
 *   - `string | null` 联合类型：≈ Java 的 sealed interface / Optional 的轻量版；
 *     返回 null 时调用方会被编译期强制处理（配合 strict 模式）。
 *   - `s: string | null` + `prev !== undefined` 这类判断 = **类型收窄**；TS 的控制流分析会把
 *     `undefined` 从联合类型里剔除，之后就能当非空用。≈ Java 的 `if (x instanceof String s)` 模式匹配。
 *   - `!` 非空断言：`chars[i]!` 表示“我保证它不是 undefined”。
 *     ≈ Java 的强制类型转换（unchecked cast），用错就是运行期崩，尽量少用；本文件因为数组索引类型默认是 T|undefined 才用。
 *   - `as const` / `Record<string, string>`：`Record<K,V>` ≈ Java 的 Map<K,V> 的**结构化**版本（其实是对象字面量的字典类型）。
 *   - `Array<{ from: string; to: string }>`：行内对象类型。≈ Java 的匿名内部类/Lombok 小 DTO，但只在编译期存在。
 *   - `[...str]`：字符串展开成**字符数组**（不是 Java 的 char[] —— 它按 Unicode 码点切分，能正确处理 emoji）。
 *   - 解构：`const { result, appliedReplacements } = fn()` ≈ 从返回的 DTO 里取值；`({ old_string, new_string }) => ...` 是解构入参。
 *   - `Object.entries(obj)`：返回 [key, value] 数组。≈ Java 的 map.entrySet()。
 *   - 箭头函数 `(a) => expr`：≈ Java lambda。单表达式时可省略 return（自动返回）。
 *   - `replace(search, () => replace)`：**第二个参数必须是函数**才不会把 replace 里的 `$&`、`$1` 当成正则占位符——
 *     这是 JS 的经典坑（详见本文件第 214 行处的中文注释）。
 *   - `A satisfies B` 本文件没用到，但在兄弟文件里常见：既做类型检查又保留字面量类型。
 *   - `satisfies`/`as` 都是编译期概念，运行时不存在（所谓“类型擦除”，和 Java 泛型一样）。
 */
import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'
import { countCharInString } from 'src/utils/stringUtils.js'
import {
  DIFF_TIMEOUT_MS,
  getPatchForDisplay,
  getPatchFromContents,
} from '../../utils/diff.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  convertLeadingTabsToSpaces,
  readFileSyncCached,
} from '../../utils/file.js'
import type { EditInput, FileEdit } from './types.js'

// 中文补充：这里定义 4 个“弯引号”（typographic quotes）常量，是给 Claude 自己写代码时用的。
// 背景：模型的输出/终端渲染可能把直引号 ' " 变成弯引号 ‘ ’ “ ”，
// 直接拿去和文件内容比对就会匹配不上，所以下面这套逻辑会先把弯引号归一化成直引号再做匹配，
// 匹配成功后再把 new_string 的引号“还原”成文件里原本的排版风格（见 preserveQuoteStyle）。
// Claude can't output curly quotes, so we define them as constants here for Claude to use
// in the code. We do this because we normalize curly quotes to straight quotes
// when applying edits.
// 4 个常量分别是：左单引号、右单引号、左双引号、右双引号。
// 单独抽成常量而不是在代码里写字面量：这些字符肉眼分不清，写错很难发现。
export const LEFT_SINGLE_CURLY_QUOTE = '‘'
export const RIGHT_SINGLE_CURLY_QUOTE = '’'
export const LEFT_DOUBLE_CURLY_QUOTE = '“'
export const RIGHT_DOUBLE_CURLY_QUOTE = '”'

// 中文说明：把字符串里所有弯引号换成对应的直引号，用于“宽松匹配”。
// 注意 replaceAll 是全量替换（Java 的 String.replaceAll 其实也是全量，只是它默认按正则，这里 JS 版按字面量）。
/**
 * Normalizes quotes in a string by converting curly quotes to straight quotes
 * @param str The string to normalize
 * @returns The string with all curly quotes replaced by straight quotes
 */
// 入参/返回都是 string；这是纯函数（无副作用、不看全局状态），便于单测。
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

// 中文说明：去掉每一行「行尾多余空白」，但**保留换行符本身**（含 \r\n / \r 这些不同风格）。
// 为什么要做：编辑器保存、拷贝粘贴、模型输出都可能带上随机行尾空格，
// 若不做归一化，模型给的 new_string 往往会“看起来一样但匹配不上”。
/**
 * Strips trailing whitespace from each line in a string while preserving line endings
 * @param str The string to process
 * @returns The string with trailing whitespace removed from each line
 */
// 返回值是新字符串（JS 的 string 不可变，≈ Java String），原串不会被改动。
export function stripTrailingWhitespace(str: string): string {
  // Handle different line endings: CRLF, LF, CR
  // Use a regex that matches line endings and captures them
// 关键技巧：split 的正则里带了**捕获组** (\r\n|\n|\r)，JS 会把捕获到的分隔符也放进结果数组，
// 于是数组变成 [内容, 换行符, 内容, 换行符, ...]，偶数下标是内容、奇数下标是换行符。
// 这样处理完再拼回去就能原样保留文件原本的换行风格（不会把所有 CRLF 偷偷改成 LF）。
// 对照 Java：String.split 会**丢弃**分隔符，做不到这一点。
  const lines = str.split(/(\r\n|\n|\r)/)

  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]
    if (part !== undefined) {
// 偶数下标 = 真正的行内容，把它的行尾空白去掉。
      if (i % 2 === 0) {
        // Even indices are line content
        result += part.replace(/\s+$/, '')
      } else {
        // Odd indices are line endings
        result += part
      }
    }
  }

  return result
}

// 中文说明：在文件内容里「定位」模型给的 old_string 真正对应的那段原文。
// 为什么要绕这一圈：模型输出里的引号可能和文件里的排版不同（直引号 vs 弯引号），
// 直接 includes() 会失配。这里先精确找，找不到再降级到“归一化后”找，
// 找到后还要把**文件里原本那段**（带弯引号的）返回去，后续替换才能对着原文本改。
/**
 * Finds the actual string in the file content that matches the search string,
 * accounting for quote normalization
 * @param fileContent The file content to search in
 * @param searchString The string to search for
 * @returns The actual string found in the file, or null if not found
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
// ① 先试「精确匹配」：命中就直接返回，零成本、零歧义，绝大多数编辑走这条路。
  // First try exact match
  if (fileContent.includes(searchString)) {
    return searchString
  }

// ② 精确匹配失败才降级：把「搜索串」和「文件全文」都做引号归一化后再找。
//    两边都归一化，才能保证下标对齐。
  // Try with normalized quotes
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)

// indexOf 找不到时返回 -1（不是 null/undefined），这是 JS 的老约定。
// 对照 Java：String.indexOf 也是返回 -1，这点一致。
  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex !== -1) {
    // Find the actual string in the file that matches
// ★ 踩过的坑：这里用 searchString.length（归一化前的长度）去截取**原文**。
// 如果两种引号的字节/码点长度不同，截出来的原文可能多/少字符或截断异常。
// 之所以敢这么写：这些弯引号与直引号都是单字符（UTF-16 一个码元），长度一致，所以下标是安全的。
    return fileContent.substring(searchIndex, searchIndex + searchString.length)
  }

  return null
}

// 中文说明（对应上面的英文）：当 old_string 是靠“引号归一化”才匹配上时，
// 说明文件里用的是弯引号而模型给的是直引号。
// 这时必须把 new_string 也转成同样的弯引号风格，否则改完之后整个文件引号风格参差、
// 后续 diff 视图和再次编辑都会被污染。这个函数就是干这件事的。
/**
 * When old_string matched via quote normalization (curly quotes in file,
 * straight quotes from model), apply the same curly quote style to new_string
 * so the edit preserves the file's typography.
 *
 * Uses a simple open/close heuristic: a quote character preceded by whitespace,
 * start of string, or opening punctuation is treated as an opening quote;
 * otherwise it's a closing quote.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  // If they're the same, no normalization happened
// old_string 与真实原文完全一致 ⇒ 没发生过归一化 ⇒ new_string 无需加工，直接返回（快路径）。
  if (oldString === actualOldString) {
    return newString
  }

  // Detect which curly quote types were in the file
// 先判断文件里出现的是“双弯引号”还是“单弯引号”，只处理出现过的那种，避免无谓改动。
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

// 两种都没有 ⇒ 说明这条路不是靠引号归一化才匹配的（可能是别的差异），不做处理。
  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString
  }

  let result = newString

  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result)
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result)
  }

  return result
}

// 判断某个位置上的引号是不是「左引号（开引号）」：看它前一个字符是不是空白或开括号类符号。
// 这是启发式规则（heuristic），不是严格的语法分析——对自然语言文本足够用了。
function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true
  }
  const prev = chars[index - 1]
// prev 的类型是 string | undefined（下标越界时），下面必须逐一比对，不能默认它非空。
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
// 破折号（em dash / en dash）也算“开引号上下文”：英文排版里常用破折号引出一句话再接引号。
    prev === '\u2014' || // em dash
    prev === '\u2013' // en dash
  )
}

// 把字符串里所有直双引号 " 换成弯引号，按上下文决定是左 “ 还是右 ”。
function applyCurlyDoubleQuotes(str: string): string {
// [...str] 展开成字符数组：
//   ① 为了能用下标随机访问前/后一个字符；
//   ② 比 split('') 更正确——它按 Unicode 码点分割，能正确处理 emoji 等代理对字符。
//      对照 Java：char[] 是 UTF-16 码元，处理 emoji 会断成两半，这里不会有这个问题。
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
// 逐字符扫描：遇到 " 就按上下文替换，其余字符原样保留。
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i)
          ? LEFT_DOUBLE_CURLY_QUOTE
          : RIGHT_DOUBLE_CURLY_QUOTE,
      )
    } else {
// `chars[i]!` 的 `!` 是**非空断言**：告诉编译器“这里一定有值”。
// ≈ Java 的强制类型转换（unchecked cast）——编译器不再检查，写错了就是运行期 undefined。
// 为什么不得不用：TS 默认认为数组下标访问可能越界（返回 T | undefined），
// 而这里 i 一定在范围内，编译器推不出来，只能人工兜底。
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

// 单引号版本。比双引号版多一件事：要区分「缩写撇号」和「引号」。
function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
// 中文补充（对应上面英文）：像 don't / it's / Claude's 里的 ' 是缩写撇号，不是引号。
// 判断依据：前后都是字母 ⇒ 是缩写。此时统一用「右单引号 ’」（排版规范里缩写用右引号），
// 否则就会出现 “don‘t” 这种明显错误。
      // Don't convert apostrophes in contractions (e.g., "don't", "it's")
      // An apostrophe between two letters is a contraction, not a quote
// 取前一个/后一个字符，边界处取 undefined，再用 /\p{L}/u 判断是不是字母。
// /\p{L}/u 是 Unicode 属性转义：匹配任意语言的字母（含中文、俄文…），比 [a-zA-Z] 通用得多。
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        // Apostrophe in a contraction — use right single curly quote
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        result.push(
          isOpeningContext(chars, i)
            ? LEFT_SINGLE_CURLY_QUOTE
            : RIGHT_SINGLE_CURLY_QUOTE,
        )
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

// 中文说明（对应上面英文）：把 (oldString → newString) 的一次替换真正作用到文件内容上。
// 这是整个 Edit 工具最底层的一步：**这里的 replace 语义决定了“为什么 old_string 必须唯一”**。
//   - replace_all=false 时用的是 String.replace —— 只替换第一处。若 old_string 出现多次，
//     会静默改掉第一处（可能根本不是模型想改的地方），所以上层必须先用唯一性校验拦住。
//   - replace_all=true 时才用 replaceAll 全量替换。
/**
 * Transform edits to ensure replace_all always has a boolean value
 * @param edits Array of edits with optional replace_all
 * @returns Array of edits with replace_all guaranteed to be boolean
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
// replaceAll 给默认值 false：调用方不传就是“只替换第一处”（配合上层的唯一性校验使用）。
  replaceAll: boolean = false,
): string {
// 用三元表达式选出「替换函数」本身（不是选结果），之后统一按 f(...) 调用，避免两处分支重复代码。
// 对照 Java：Function3<String,String,String,String> f = replaceAll ? this::replaceAllImpl : this::replaceFirstImpl。
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
// ★★ 关键坑点：replace/replaceAll 的第二个参数传的是**箭头函数** `() => replace`，而不是直接传字符串。
// 原因：若直接传字符串，JS 会把 replace 里的 `$&`、`$1`、`$'` 等当成正则替换的占位符展开，
// 导致模型想写入包含 "$&" 的文本时内容被莫名改写（典型场景：写正则、写 shell 脚本、写 Makefile）。
// 传函数则返回什么就是什么，不做任何解释。对照 Java：Matcher.quoteReplacement() 要解决的是同一个问题。
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace)

// new_string 非空 → 走常规路径。
  if (newString !== '') {
    return f(originalContent, oldString, newString)
  }

// ★ 特殊处理“删除整行”：模型想删掉一段内容时会把 new_string 写成空串 ''。
// 若 old_string 不带行尾换行，但实际在文件里它后面跟着换行，
// 只替换内容会剩下一个空行。这里判断“old_string 后面确实跟着换行”，
// 就把那个换行也一起吃掉，得到真正干净的删除效果。
  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')

  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString)
}

// 中文说明（对应上面英文）：**单条**编辑 → 返回 diff patch + 改后的全文。
// 明确「不写盘」：本文件所有函数都是纯计算，是否落盘由编排层（FileEditTool.ts）决定，
// 好处是“先算出 diff 给用户看 / 做二次确认 / 做去重比较”都不必产生副作用。
/**
 * Applies an edit to a file and returns the patch and updated file.
 * Does not write the file to disk.
 */
// 入参用「对象 + 解构」而不是位置参数：字段多了以后 x(a,b,c,d,e) 极易传错顺序。
// 后面紧跟的那个对象字面量就是入参的**内联类型声明**（TS 允许就地写类型）。
export function getPatchForEdit({
  filePath,
  fileContents,
  oldString,
  newString,
// 默认值 false 写在解构里：`{ replaceAll = false }`。调用方不传该字段时自动生效。
  replaceAll = false,
}: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
// 返回值是一个对象类型 { patch: ...; updatedFile: string }。
// 对照 Java：相当于返回一个小 record/DTO，但这里不用先定义类，就地声明即可。
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
// 单条编辑直接复用多条编辑的实现（把单条包成数组），避免两份逻辑各自漂移。
  return getPatchForEdits({
    filePath,
    fileContents,
    edits: [
      { old_string: oldString, new_string: newString, replace_all: replaceAll },
    ],
  })
}

// 中文说明（对应上面英文）：**多条**编辑按顺序依次作用到同一份内容上，返回 patch + 改后全文。同样不写盘。
// 注意英文里那句 “it has spaces instead of tabs”：生成的 patch 仅用于**展示**，
// 内部的 tab 已被转成空格（见第 345-346 行），不能拿这个 patch 去反向重建文件原博内容。
/**
 * Applies a list of edits to a file and returns the patch and updated file.
 * Does not write the file to disk.
 *
 * NOTE: The returned patch is to be used for display purposes only - it has spaces instead of tabs
 */
export function getPatchForEdits({
  filePath,
  fileContents,
  edits,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
// updatedFile 用 let（会被反复重新赋值）；fileContents 保持只读，作为后续比对的基准。
  let updatedFile = fileContents
  const appliedNewStrings: string[] = []

// 空文件的特例：内容为空、只有一条编辑、old_string 与 new_string 都是空串。
// 这种请求等价于“什么都不做”，单独处理是为了跳过下面那套必然失败（找不到 old_string）的循环。
  // Special case for empty files.
// edits[0] 后面还要判一次非空（`edits[0] &&`）：因为 TS 认为数组下标访问可能越界，
// 即使前面已经检查了 length === 1，编译器也不一定能推出结论。≈ 防御性判空。
  if (
    !fileContents &&
    edits.length === 1 &&
    edits[0] &&
    edits[0].old_string === '' &&
    edits[0].new_string === ''
  ) {
    const patch = getPatchForDisplay({
      filePath,
      fileContents,
      edits: [
        {
          old_string: fileContents,
          new_string: updatedFile,
          replace_all: false,
        },
      ],
    })
    return { patch, updatedFile: '' }
  }

  // Apply each edit and check if it actually changes the file
// 按顺序应用每一条编辑；顺序很重要，后面的编辑是在前面结果的基础上做的。
  for (const edit of edits) {
    // Strip trailing newlines from old_string before checking
// 先把 old_string 的**行尾换行**剥掉再参与比较。
// 为什么：带着末尾换行去做子串比较会因为多/少一个 \n 而误判。
    const oldStringToCheck = edit.old_string.replace(/\n+$/, '')

    // Check if old_string is a substring of any previously applied new_string
// ★ 关键防护：禁止「本次的 old_string 是上一条 new_string 的子串」。
// 场景：第一条把 A 改成 xxAxx（new_string 里包含了 A），第二条又要改 A，
// 这时已经分不清该改哪一处了（新插入的那个 A 还是原来剩下的 A）。
// 与其猜，不如直接报错让模型重新给出无歧义的编辑。这是防误改的重要一环。
    for (const previousNewString of appliedNewStrings) {
// 空串是任何串的子串，所以必须先排除 oldStringToCheck === ''，否则任何编辑都会被这条规则拦下。
      if (
        oldStringToCheck !== '' &&
        previousNewString.includes(oldStringToCheck)
      ) {
        throw new Error(
          'Cannot edit file: old_string is a substring of a new_string from a previous edit.',
        )
      }
    }

// 记下替换前的内容，用于下面判断“这条编辑到底有没有生效”。
    const previousContent = updatedFile
    updatedFile =
// old_string 为空串 ⇒ 语义是「用 new_string 覆盖整个文件」（相当于新建/重写）。
// String.replace('', x) 的行为是“在开头插入”，达不到覆盖效果，所以这里必须分支处理。
      edit.old_string === ''
        ? edit.new_string
        : applyEditToFile(
            updatedFile,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          )

    // If this edit didn't change anything, throw an error
// ★ 校验：替换前后内容完全一样 ⇒ 说明 old_string 根本没匹配上（或替换结果与原串相同）。
// 这时必须报错而不是静默返回成功——否则模型会以为编辑成功，后续推理全部建立在错误前提上。
    if (updatedFile === previousContent) {
      throw new Error('String not found in file. Failed to apply edit.')
    }

    // Track the new string that was applied
// 记录本次写入的新串，供上面第 302 行的“子串歧义”检查使用。
    appliedNewStrings.push(edit.new_string)
  }

// 兜底：所有编辑跑完后文件与原文件一模一样 ⇒ 等价于“什么都没改”，报错。
// （例如 replace_all 把所有匹配改成相同内容。）
  if (updatedFile === fileContents) {
    throw new Error(
      'Original and edited file match exactly. Failed to apply edit.',
    )
  }

// 中文补充（对应上面英文）：这里已经拿到了「改前全文」和「改后全文」，
// 所以直接调 getPatchFromContents 做一次 diff 就够了。
// 旧做法是走 getPatchForDisplay 并把整份文件内容当成 old_string 传进去，
// 那样内容会被重复处理两次（一次当 preparedFileContents，一次当 escapedOldString），
// 还会对整份内容做一次毫无必要的 replace —— 大文件上大约多花 20% 时间。
  // We already have before/after content, so call getPatchFromContents directly.
  // Previously this went through getPatchForDisplay with edits=[{old:fileContents,new:updatedFile}],
  // which transforms fileContents twice (once as preparedFileContents, again as escapedOldString
  // inside the reduce) and runs a no-op full-content .replace(). This saves ~20% on large files.
// convertLeadingTabsToSpaces：把行首 tab 换成空格后再 diff。
// 目的：diff 展示时不同缩进宽度的 tab/空格混用会造成视觉错乱；也避免 diff 库把整行判为变更。
// 副作用是 patch 只能用于展示，不能用于还原文件。
  const patch = getPatchFromContents({
    filePath,
    oldContent: convertLeadingTabsToSpaces(fileContents),
    newContent: convertLeadingTabsToSpaces(updatedFile),
  })

  return { patch, updatedFile }
}

// 中文补充（对应上面英文）：给“已编辑文件”这种附件加长度上限。
// 背景：大文件被格式化后，以前每轮对话都会把整个文件塞进上下文（实测最高 16.1KB，一个会话约 1.4 万 token）。
// 设 8KB 能在保留有效上下文的同时把最坏情况锁死。
// Cap on edited_text_file attachment snippets. Format-on-save of a large file
// previously injected the entire file per turn (observed max 16.1KB, ~14K
// tokens/session). 8KB preserves meaningful context while bounding worst case.
// 单位是字节（bytes），不是字符数——中文等宽字符一个字占多字节，这样卡更准。
const DIFF_SNIPPET_MAX_BYTES = 8192

// 中文说明（对应上面英文）：给“文件被改动”的附件生成一段带行号的小片段（snippet），
// 让模型知道文件变成什么样了，但不必把整个文件回灌进上下文。
// TODO 里说的 Unify：这套片段逻辑在项目里还有别的实现，理想情况应统一。
/**
 * Used for attachments, to show snippets when files change.
 *
 * TODO: Unify this with the other snippet logic.
 */
export function getSnippetForTwoFileDiff(
  fileAContents: string,
  fileBContents: string,
): string {
// structuredPatch(旧文件名, 新文件名, 旧内容, 新内容, 旧标题, 新标题, 选项)：
// 两个文件名都传 'file.txt' 是因为这里只关心内容差异，文件名不参与展示。
  const patch = structuredPatch(
    'file.txt',
    'file.txt',
    fileAContents,
    fileBContents,
    undefined,
    undefined,
// context: 8 —— 每个改动块上下各保留 8 行上下文。给多了浪费 token，给少了模型看不懂改动落在什么位置。
// timeout —— 必须设：diff 算法在极端输入（大量单行差异）上可能算很久，超时可以避免卡住整个会话。
    {
      context: 8,
      timeout: DIFF_TIMEOUT_MS,
    },
  )

// diff 超时/失败时 structuredPatch 会返回空，这里降级为返回空串（宁可不展示，也不要崩）。
  if (!patch) {
    return ''
  }

// 把每个 hunk 拼成一小段「起始行号 + 带行号的文本」，再整体拼接。
  const full = patch.hunks
    .map(_ => ({
      startLine: _.oldStart,
// _ 是惯用的“不在乎名字”的变量名（项目里用它避免 no-unused 告警）。≈ Java lambda 里的 (_) -> ...
      content: _.lines
        // Filter out deleted lines AND diff metadata lines
// 过滤两类行：'-' 开头的是被删掉的行（不该出现在“现在长什么样”的片段里），
// '\\' 开头的是 "\ No newline at end of file" 这类 diff 元数据。
        .filter(_ => !_.startsWith('-') && !_.startsWith('\\'))
// slice(1) 去掉 diff 行首的 +/-/空格 标记，还原成文件真实内容。
        .map(_ => _.slice(1))
        .join('\n'),
    }))
    .map(addLineNumbers)
// 多个改动块之间用 '...' 分隔，明确告诉模型“中间被省略了”，避免它误以为两块是相邻的。
    .join('\n...\n')

// 没超上限就全量返回。
  if (full.length <= DIFF_SNIPPET_MAX_BYTES) {
    return full
  }

// 超了就从「最后一个不超过上限的换行处」切断。
// 为什么不在 DIFF_SNIPPET_MAX_BYTES 处直接切：硬切会把一行劈成两半，甚至把多字节字符切坏变成乱码。
// 英文注释提到格式与 BashTool/utils.ts 一致：是为了全局截断提示样式统一，也便于上层统一识别。
  // Truncate at the last line boundary that fits within the cap.
  // Marker format matches BashTool/utils.ts.
// lastIndexOf('\n', pos) 表示“从 pos 往左找最后一个 \n”，即从后往前定位安全切点。
  const cutoff = full.lastIndexOf('\n', DIFF_SNIPPET_MAX_BYTES)
  const kept =
    cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES)
// remaining：数一下被截掉的行数（从 kept 的末尾开始数换行符），用于给出准确的 “N lines truncated”。
  const remaining = countCharInString(full, '\n', kept.length) + 1
  return `${kept}\n\n... [${remaining} lines truncated] ...`
}

// 上下文行数：snippet 里改动位置的上下各保留 4 行，让模型看得懂改动所处的语境。
const CONTEXT_LINES = 4

// 中文说明（对应上面英文）：根据 patch（diff hunk）在**改动后的文件**里定位片段。
// 与上面的 getSnippetForTwoFileDiff 区别：
//   - 那个是“两个文件整体对比”给附件用；
//   - 这个是“改动落在第几行”给 diff 展示用，所以还必须把 startLine 一起返回。
/**
 * Gets a snippet from a file showing the context around a patch with line numbers.
 * @param originalFile The original file content before applying the patch
 * @param patch The diff hunks to use for determining snippet location
 * @param newFile The file content after applying the patch
 * @returns The snippet text with line numbers and the starting line number
 */
export function getSnippetForPatch(
  patch: StructuredPatchHunk[],
  newFile: string,
): { formattedSnippet: string; startLine: number } {
// 没有任何改动 ⇒ 返回空片段，起点行号给 1（行号从 1 开始计数，和编辑器一致）。
  if (patch.length === 0) {
    // No changes, return empty snippet
    return { formattedSnippet: '', startLine: 1 }
  }

  // Find the first and last changed lines across all hunks
// 用 Infinity / -Infinity 当初始值，第一次进循环必然被覆盖。
// 对照 Java：Integer.MAX_VALUE / MIN_VALUE 的常见写法，TS/JS 里有真正的无穷大，不需要用哨兵值。
  let minLine = Infinity
  let maxLine = -Infinity

// 遍历所有 hunk，求出「最小行号」和「最大行号」，即本次编辑影响的整体范围。
  for (const hunk of patch) {
    if (hunk.oldStart < minLine) {
      minLine = hunk.oldStart
    }
    // For the end line, we need to consider the new lines count since we're showing the new file
// 结束行用 newLines（改动后的行数）而不是 oldLines 计算：
// 因为要展示的是**改动后**的文件，行号必须对得上。若用 oldLines，新增/删除行之后就整体错位了。
    const hunkEnd = hunk.oldStart + (hunk.newLines || 0) - 1
    if (hunkEnd > maxLine) {
      maxLine = hunkEnd
    }
  }

  // Calculate the range with context
// 向外扩 CONTEXT_LINES 行，并用 Math.max(1, ...) 防止算成 0 或负数（行号最小是 1）。
  const startLine = Math.max(1, minLine - CONTEXT_LINES)
  const endLine = maxLine + CONTEXT_LINES

  // Split the new file into lines and get the snippet
// /\r?\n/ 兼容 LF 与 CRLF 两种换行风格。
  const fileLines = newFile.split(/\r?\n/)
// slice(startLine - 1, endLine)：行号从 1 开始，数组下标从 0 开始，所以 -1；
// endLine 不用 -1 是因为 slice 的结束下标本身就是“不含”。
  const snippetLines = fileLines.slice(startLine - 1, endLine)
  const snippet = snippetLines.join('\n')

  // Add line numbers
// 加上行号前缀（如 "123→"）。为什么必须加行号：模型后续要据此构造 new old_string，
// 行号是它唯一定位手段；同时也用于终端向用户展示。
  const formattedSnippet = addLineNumbers({
    content: snippet,
    startLine,
  })

  return { formattedSnippet, startLine }
}

// 中文说明（对应上面英文）：针对**单条编辑**生成片段（不需要先算 patch 的版本，走的是老算法）。
// 与 getSnippetForPatch 的区别：它直接从 oldString 在原文件里的位置推算，不走 diff hunk。
/**
 * Gets a snippet from a file showing the context around a single edit.
 * This is a convenience function that uses the original algorithm.
 * @param originalFile The original file content
 * @param oldString The text to replace
 * @param newString The text to replace it with
 * @param contextLines The number of lines to show before and after the change
 * @returns The snippet and the starting line number
 */
export function getSnippet(
  originalFile: string,
  oldString: string,
  newString: string,
  contextLines: number = 4,
): { snippet: string; startLine: number } {
// 取 oldString 之前的全部内容，数其中的换行数，就得到替换发生的行号（从 0 计）。
  // Use the original algorithm from FileEditTool.tsx
// `split(...)[0] ?? ''`：split 至少返回一项，但 TS 认为下标可能是 undefined，用 ?? 兜底。
// 注意：oldString 若在文件里出现多次，这里取的是**第一处**——再次呼应“old_string 必须唯一”的约束。
  const before = originalFile.split(oldString)[0] ?? ''
  const replacementLine = before.split(/\r?\n/).length - 1
// 先在内存里把这次编辑应用一遍，才能拿到「改动后」的正确行内容。
  const newFileLines = applyEditToFile(
    originalFile,
    oldString,
    newString,
  ).split(/\r?\n/)

  // Calculate the start and end line numbers for the snippet
// 片段起点 = 替换行 - 上下文行，最小夹到 0。
  const startLine = Math.max(0, replacementLine - contextLines)
  const endLine =
    replacementLine + contextLines + newString.split(/\r?\n/).length

  // Get snippet
// 同样注意 slice 的下标边界：这里的 startLine 是 0-based，endLine 恰好可以直接当结束下标用。
  const snippetLines = newFileLines.slice(startLine, endLine)
  const snippet = snippetLines.join('\n')

// 返回时把 startLine 转成 1-based（人类/编辑器的习惯）。
  return { snippet, startLine: startLine + 1 }
}

// 把一个 patch 反向还原成 FileEdit[]（每条 hunk → 一条编辑）。
// 用途：用户在 diff 视图里手动改了内容后，需要把“改动”再变回 edit 结构去做后续处理。
export function getEditsForPatch(patch: StructuredPatchHunk[]): FileEdit[] {
// map 返回 FileEdit[]：箭头函数 + 隐式返回对象（注意 ( ... ) 包住对象字面量，否则会被当成函数体）。
  return patch.map(hunk => {
    // Extract the changes from this hunk
    const contextLines: string[] = []
    const oldLines: string[] = []
    const newLines: string[] = []

    // Parse each line and categorize it
// diff 行首字符的含义：空格=上下文行（两边都有）、'-'=仅旧文件有、'+'=仅新文件有。
    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        // Context line - appears in both versions
        contextLines.push(line.slice(1))
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith('-')) {
        // Deleted line - only in old version
        oldLines.push(line.slice(1))
      } else if (line.startsWith('+')) {
        // Added line - only in new version
        newLines.push(line.slice(1))
      }
    }

// 把收集到的行拼回 old_string / new_string。
// 注意这里 replace_all 固定为 false：patch 已经精确指明了位置，不需要再全量替换。
    return {
      old_string: oldLines.join('\n'),
      new_string: newLines.join('\n'),
      replace_all: false,
    }
  })
}

// 中文说明（对应上面英文）：「反脱敏」映射表。
// 背景：API 侧会把 <function_results>、<name>、Human: 这类标签转义/脱敏掉，模型因此看不到原文，
// 只能输出脱敏后的版本（如 <n>、'\n\nH:'）。于是模型写进 old_string/new_string 的也是这些脱敏形式。
// 这里提前准备好“还原表”，在匹配失败时尝试还原后再匹配。
/**
 * Contains replacements to de-sanitize strings from Claude
 * Since Claude can't see any of these strings (sanitized in the API)
 * It'll output the sanitized versions in the edit response
 */
// Record<string, string>：键到值的字典类型。≈ Java 的 Map<String,String>，但底层是 JS 对象字面量。
const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
}

// 中文说明（对应上面英文）：把 matched string 里所有已知的脱敏形式还原成原文，
// 并且**记录下这次实际生效了哪些替换**，以便对 new_string 施加完全相同的一组替换（保持一致）。
/**
 * Normalizes a match string by applying specific replacements
 * This helps handle when exact matches fail due to formatting differences
 * @returns The normalized string and which replacements were applied
 */
function desanitizeMatchString(matchString: string): {
  result: string
  appliedReplacements: Array<{ from: string; to: string }>
} {
// 注意这里用 let 而不是 const：result 会被反复重新赋值（每轮 depends 上一轮结果）。
  let result = matchString
  const appliedReplacements: Array<{ from: string; to: string }> = []

// Object.entries ≈ Java 的 map.entrySet()；用数组解构 [from, to] 直接取出键值。
  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const beforeReplace = result
// replaceAll（字面量全量替换）。这里第一个参数是普通字符串，不涉及正则，所以安全。
    result = result.replaceAll(from, to)

// 通过“替换前后是否相等”来判断这条规则是否真的生效了——比先 indexOf 检查再替换更省一次扫描。
    if (beforeReplace !== result) {
      appliedReplacements.push({ from, to })
    }
  }

  return { result, appliedReplacements }
}

// 中文说明（对应上面英文）：Edit 工具的**入参归一化**入口（也叫“纠错层”）。
// 为什么需要它：模型给的 old_string/new_string 常带着各种不一致（行尾空格、被脱敏的标签），
// 如果每次都直接失败，模型就得反复重试、体验很差。这里在真正匹配前先做一次归一化，
// 让“本可以成功的编辑”直接成功。
// 重要约束：归一化**只针对 new_string 的空白**，以及 old_string 的脱敏还原；
// 不会偷偷改变要替换的语义（正是下面的 Markdown 特例要保护的东西）。
/**
 * Normalize the input for the FileEditTool
 * If the string to replace is not found in the file, try with a normalized version
 * Returns the normalized input if successful, or the original input if not
 */
export function normalizeFileEditInput({
  file_path,
  edits,
}: {
  file_path: string
  edits: EditInput[]
}): {
  file_path: string
  edits: EditInput[]
} {
// 空编辑列表直接返回原样（省掉一次无谓的读盘）。
  if (edits.length === 0) {
    return { file_path, edits }
  }

// 中文补充（对应上面英文）：Markdown 里的「行尾两个空格」表示硬换行，是有语义的。
// 如果像其它文件那样把行尾空白剥掉，就会悄悄改变渲染结果 —— 所以对 .md/.mdx 跳过这个处理。
// 这是典型的“为了通用规则的正确性，给特定格式开后门”的例子。
  // Markdown uses two trailing spaces as a hard line break — stripping would
  // silently change semantics. Skip stripTrailingWhitespace for .md/.mdx.
// /\.(md|mdx)$/i：以 .md 或 .mdx 结尾，忽略大小写。$ 锚定末尾，避免误命中 xxx.md.ts。
  const isMarkdown = /\.(md|mdx)$/i.test(file_path)

// 整个归一化包在 try 里：读文件失败（最常见是文件还没创建）不应该让编辑直接崩，
// 下面 catch 会退回原始入参，把失败交给后面的真实匹配逻辑去报更准确的错。
  try {
    const fullPath = expandPath(file_path)

// 用带缓存的同步读：同一轮对话里多次编辑同一文件时能省掉重复 I/O。
// 英文注释提到“不做 TOCTOU 预检查”：意思是**不**先 stat 判断文件是否存在再读，
// 因为读与写之间存在时间差（TOCTOU 竞态），检查了也没用；直接读、靠 catch 处理 ENOENT 更简单也更正确。
    // Use cached file read to avoid redundant I/O operations.
    // If the file doesn't exist, readFileSyncCached throws ENOENT which the
    // catch below handles by returning the original input (no TOCTOU pre-check).
    const fileContent = readFileSyncCached(fullPath)

    return {
      file_path,
// 逐条编辑做归一化。map 里解构出三个字段，返回值仍保持同样结构（不可变更新）。
      edits: edits.map(({ old_string, new_string, replace_all }) => {
// Markdown 文件：new_string 原样保留（不剥行尾空格，理由见第 595 行注释）。
        const normalizedNewString = isMarkdown
          ? new_string
          : stripTrailingWhitespace(new_string)

        // If exact string match works, keep it as is
// 先试精确包含：命中就保留模型给的 old_string 原文（不做任何加工），只有 new_string 被归一化。
// 为什么要先看 include 而不是直接替换：精确匹配零副作用，能不打扰就不打扰。
        if (fileContent.includes(old_string)) {
          return {
            old_string,
            new_string: normalizedNewString,
            replace_all,
          }
        }

// 精确匹配不上，才尝试“反脱敏”后再匹配。
        // Try de-sanitize string if exact match fails
        const { result: desanitizedOldString, appliedReplacements } =
          desanitizeMatchString(old_string)

// 还原后的 old_string 能在文件里找到 ⇒ 采用还原版本。
        if (fileContent.includes(desanitizedOldString)) {
          // Apply the same exact replacements to new_string
// 关键一致性要求：old_string 上生效了哪些替换，new_string 也必须施加**完全相同**的一组替换。
// 否则就会出现“旧的被还原了、新的没有”，替换结果错位（比如一头-policy一侧留有 <n>）。
          let desanitizedNewString = normalizedNewString
          for (const { from, to } of appliedReplacements) {
            desanitizedNewString = desanitizedNewString.replaceAll(from, to)
          }

          return {
            old_string: desanitizedOldString,
            new_string: desanitizedNewString,
            replace_all,
          }
        }

// 还原后仍匹配不上：放弃纠偏，原样返回，让上层报出准确的“未找到”错误。
        return {
          old_string,
          new_string: normalizedNewString,
          replace_all,
        }
      }),
    }
// catch：读取异常一律不往上抛（除 ENOENT 外的才记日志），退回原入参。
// 设计取向：这里是“尽力而为的纠错”，失败必须是静默的、无副作用的。
  } catch (error) {
    // If there's any error reading the file, just return original input.
    // ENOENT is expected when the file doesn't exist yet (e.g., new file).
// ENOENT 是预期情况（比如要编辑的文件尚未创建），不算错误、不记日志，避免污染错误上报。
    if (!isENOENT(error)) {
      logError(error)
    }
  }

  return { file_path, edits }
}

// 中文说明（对应上面英文）：判断两组编辑是否「等价」——不看字面是否一样，
// 而是把它们都应用到同一份原始内容上，比较结果文件是否相同。
// 用途：去重（避免模型重复提交语义相同的编辑）、幂等判断、以及某些“自动确认”场景。
/**
 * Compare two sets of edits to determine if they are equivalent
 * by applying both sets to the original content and comparing results.
 * This handles cases where edits might be different but produce the same outcome.
 */
export function areFileEditsEquivalent(
  edits1: FileEdit[],
  edits2: FileEdit[],
  originalContent: string,
): boolean {
// 快路径：字面完全相同就直接判定等价，省掉两次（可能很贵的）试图 PPT 的应用+diff 计算。
  // Fast path: check if edits are literally identical
  if (
    edits1.length === edits2.length &&
    edits1.every((edit1, index) => {
      const edit2 = edits2[index]
      return (
// edit2 !== undefined：再次是防御性判空（编译器无法从 length 相同推出下标一定有值）。
        edit2 !== undefined &&
        edit1.old_string === edit2.old_string &&
        edit1.new_string === edit2.new_string &&
        edit1.replace_all === edit2.replace_all
      )
    })
  ) {
    return true
  }

  // Try applying both sets of edits
// 两组编辑分别 try/catch：任一失败时不抛，把错误文案记下来，最后参与比较。
  let result1: { patch: StructuredPatchHunk[]; updatedFile: string } | null =
    null
  let error1: string | null = null
  let result2: { patch: StructuredPatchHunk[]; updatedFile: string } | null =
    null
  let error2: string | null = null

  try {
    result1 = getPatchForEdits({
      filePath: 'temp',
      fileContents: originalContent,
      edits: edits1,
    })
  } catch (e) {
    error1 = errorMessage(e)
  }

  try {
    result2 = getPatchForEdits({
      filePath: 'temp',
      fileContents: originalContent,
      edits: edits2,
    })
  } catch (e) {
    error2 = errorMessage(e)
  }

// 两边都失败 ⇒ 只有失败原因完全一致才算等价。
// 为什么：错误信息通常说明了失败位置/原因，相同错误意味着两组编辑坏在同一个地方。
  // If both threw errors, they're equal only if the errors are the same
  if (error1 !== null && error2 !== null) {
    // Normalize error messages for comparison
    return error1 === error2
  }

  // If one threw an error and the other didn't, they're not equal
// 一边成功一边失败 ⇒ 显然不等价。
  if (error1 !== null || error2 !== null) {
    return false
  }

  // Both succeeded - compare the results
// 两边都成功 ⇒ 比较最终文件内容。
// `result1!` 的 `!` 是非空断言：编译器不知道上面两个 if 已经排除了 null，只能手动拍板。
// 这是本文件里最典型的 `!` 用法（≈ Java 里明知非 null 却还要强转）。
  return result1!.updatedFile === result2!.updatedFile
}

// 中文说明（对应上面英文）：两组「Edit 工具入参」（含文件路径）是否等价的统一入口。
// 与上面 areFileEditsEquivalent 的分工：那个比较“编辑列表”，这个先比文件路径再委托给它。
/**
 * Unified function to check if two file edit inputs are equivalent.
 * Handles file edits (FileEditTool).
 */
export function areFileEditsInputsEquivalent(
  input1: {
    file_path: string
    edits: FileEdit[]
  },
  input2: {
    file_path: string
    edits: FileEdit[]
  },
): boolean {
  // Fast path: different files
// 文件路径都不同 ⇒ 必然不等价（零成本短路，避免读文件）。
  if (input1.file_path !== input2.file_path) {
    return false
  }

// 再试字面相等（同上：能不算就不算）。
  // Fast path: literal equality
  if (
    input1.edits.length === input2.edits.length &&
    input1.edits.every((edit1, index) => {
      const edit2 = input2.edits[index]
      return (
        edit2 !== undefined &&
        edit1.old_string === edit2.old_string &&
        edit1.new_string === edit2.new_string &&
        edit1.replace_all === edit2.replace_all
      )
    })
  ) {
    return true
  }

// 字面不等 ⇒ 这才落到语义比较，需要读出原始文件内容当基准。
// 英文注释说的 “no TOCTOU pre-check” 同样适用于这里：不预检查存在性，直接读、失败即按空内容处理。
  // Semantic comparison (requires file read). If the file doesn't exist,
  // compare against empty content (no TOCTOU pre-check).
// 文件不存在时基准取空串 ''：这样“新建文件”的编辑也能参与等价性比较。
  let fileContent = ''
  try {
    fileContent = readFileSyncCached(input1.file_path)
  } catch (error) {
// ENOENT 之外的异常（权限、IO）必须往上抛：这类异常掩盖掉会导致错误的“等价/不等价”结论。
    if (!isENOENT(error)) {
      throw error
    }
  }

  return areFileEditsEquivalent(input1.edits, input2.edits, fileContent)
}
