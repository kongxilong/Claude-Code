/**
 * 【一句话定位】解析 `sed -i 's/old/new/g' file` 这种「就地编辑」命令，
 *   把文件路径、查找模式、替换内容拆出来，好让 UI 像展示「编辑文件」一样展示它（而不是显示一坨 sed 脚本）。
 *
 * 【在架构中的位置】
 *   上游：UI.tsx（renderToolUseMessage 用它判断命令是不是 sed 就地编辑）
 *   下游：utils/bash/shellQuote.js 的 tryParseShellCommand（按 shell 规则分词，能正确处理引号）
 *   调用链：UI.renderToolUseMessage -> parseSedEditCommand(command) -> SedEditInfo
 *
 * 【本文件包含什么】
 *   - 6 个占位符常量：BRE→ERE 正则转换时用的临时标记（用 \x00 包裹，用户输入里不可能出现）
 *   - SedEditInfo：解析结果类型（filePath / pattern / replacement / flags / extendedRegex）
 *   - isSedInPlaceEdit()：是不是就地编辑（内部就是「能否解析成功」）
 *   - parseSedEditCommand()：核心解析函数
 *   - applySedSubstitution()：把解析结果真正套用到文件内容上（含 BRE→JS 正则的转换）
 *
 * 【为什么 sed 解析这么麻烦】
 *   ① 不能按空格切：表达式里可能有空格，还有引号 —— 必须走 shell 分词（tryParseShellCommand）
 *   ② -i 在 macOS 上要求带一个备份后缀参数（可以是空串），Linux 上不用 —— 两种写法都要兼容
 *   ③ sed 的 BRE（基础正则）与 JS/ERE 的转义规则**相反**：BRE 里 \+ 表示「一个或多个」、+ 是字面量；
 *      JS 里正相反。所以必须做一层转换，直接用会出错
 *   ④ 替换串里的 & 表示「整个匹配」，而 JS 里要写成 $&；但 \& 又是字面 & —— 顺序处理错就会注入
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `export type X = { ... }` ≈ 一个公开的 DTO/record（结构化类型）
 *   - `let state: 'a' | 'b' | 'c' = 'a'`：字面量联合类型 ≈ Java enum，但只是字符串的字面量集合
 *   - `args[i]!` 非空断言 ≈ 强制类型转换，骗编译器「我保证不是 undefined」，运行时不检查
 *   - `typeof token === 'string'`：typeof 是运行时类型判断（≈ Java 的 instanceof，但作用于基本类型）
 *   - `'op' in token`：in 运算符判断对象上有没有这个键，常用来收窄联合类型
 *   - `//` 注释里的 `/** 字段说明 */` 写在字段上方，是字段级文档注释（IDE 悬停可见）
 *   - 类型标注在变量名**后面**，Java 在前面
 */
/**
 * Parser for sed edit commands (-i flag substitutions)
 * Extracts file paths and substitution patterns to enable file-edit-style rendering
 */

import { randomBytes } from 'crypto'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'

// BRE→ERE conversion placeholders (null-byte sentinels, never appear in user input)
// 占位符为什么用 \x00 包裹：\x00（空字节）不可能出现在正常的 shell 命令里，
//   用它当哨兵可以 100% 避免「用户输入恰好等于占位符」导致的替换错乱
// 占位符为什么用 \x00 包裹：\x00（空字节）不可能出现在正常的 shell 命令里，
//   用它当哨兵可以 100% 避免「用户输入恰好等于占位符」导致的替换错乱
const BACKSLASH_PLACEHOLDER = '\x00BACKSLASH\x00'
const PLUS_PLACEHOLDER = '\x00PLUS\x00'
const QUESTION_PLACEHOLDER = '\x00QUESTION\x00'
const PIPE_PLACEHOLDER = '\x00PIPE\x00'
const LPAREN_PLACEHOLDER = '\x00LPAREN\x00'
const RPAREN_PLACEHOLDER = '\x00RPAREN\x00'
const BACKSLASH_PLACEHOLDER_RE = new RegExp(BACKSLASH_PLACEHOLDER, 'g')
const PLUS_PLACEHOLDER_RE = new RegExp(PLUS_PLACEHOLDER, 'g')
const QUESTION_PLACEHOLDER_RE = new RegExp(QUESTION_PLACEHOLDER, 'g')
const PIPE_PLACEHOLDER_RE = new RegExp(PIPE_PLACEHOLDER, 'g')
const LPAREN_PLACEHOLDER_RE = new RegExp(LPAREN_PLACEHOLDER, 'g')
const RPAREN_PLACEHOLDER_RE = new RegExp(RPAREN_PLACEHOLDER, 'g')

// 解析结果。extendedRegex 很关键：它决定后面按 BRE 还是 ERE 规则解释正则
// 解析结果。extendedRegex 很关键：它决定后面按 BRE 还是 ERE 规则解释正则
export type SedEditInfo = {
  /** The file path being edited */
  filePath: string
  /** The search pattern (regex) */
  pattern: string
  /** The replacement string */
  replacement: string
  /** Substitution flags (g, i, etc.) */
  flags: string
  /** Whether to use extended regex (-E or -r flag) */
  extendedRegex: boolean
}

/**
 * Check if a command is a sed in-place edit command
 * Returns true only for simple sed -i 's/pattern/replacement/flags' file commands
 */
/**
 * 【做什么】判断一条命令是不是「sed 就地编辑」
 * 【为什么需要】UI 要决定：显示整条命令，还是像文件编辑那样只显示文件路径
 * 【返回】true = 是就地编辑（且能被本解析器完整理解）
 * 注意：判定标准就是「能否解析成功」——解析不了的一律按普通命令处理，不冒险
 */
/**
 * 【做什么】判断一条命令是不是「sed 就地编辑」
 * 【为什么需要】UI 要决定：显示整条命令，还是像文件编辑那样只显示文件路径
 * 【返回】true = 是就地编辑（且能被本解析器完整理解）
 * 注意：判定标准就是「能否解析成功」——解析不了的一律按普通命令处理，不冒险
 */
export function isSedInPlaceEdit(command: string): boolean {
  const info = parseSedEditCommand(command)
  return info !== null
}

/**
 * Parse a sed edit command and extract the edit information
 * Returns null if the command is not a valid sed in-place edit
 */
/**
 * 【做什么】把 `sed -i 's/a/b/g' file` 拆成结构化信息
 * 【为什么需要】只有拆开了，UI 才能只显示「改了哪个文件」；同时也为后面的替换计算做准备
 * 【入参】command：整条命令
 * 【返回】SedEditInfo；**任何一处不符合预期就返回 null**（保守策略：宁可当普通命令，也不误判）
 * 【关键步骤】
 *   ① 必须以 sed 开头（正则匹配 sed + 空白）
 *   ② 用 shell 分词器切出参数（正确处理引号），分词失败直接 null
 *   ③ 只接受字符串类型的 token；遇到 glob（如 *.log）直接放弃——太复杂，解析不了
 *   ④ 逐参数扫描：识别 -i / -i.bak / -E / -r / -e / --expression=，其余未知 flag 直接放弃
 *   ⑤ 第一个非 flag 参数是表达式，第二个是文件路径，出现第三个就放弃（不支持多文件）
 *   ⑥ 表达式必须是 s/ 开头，然后用一个三态状态机（pattern → replacement → flags）切分
 *   ⑦ flags 必须只含安全字符（g/p/i/I/m/M/数字），否则放弃
 */
/**
 * 【做什么】把 `sed -i 's/a/b/g' file` 拆成结构化信息
 * 【为什么需要】只有拆开了，UI 才能只显示「改了哪个文件」；同时也为后面的替换计算做准备
 * 【入参】command：整条命令
 * 【返回】SedEditInfo；**任何一处不符合预期就返回 null**（保守策略：宁可当普通命令，也不误判）
 * 【关键步骤】
 *   ① 必须以 sed 开头（正则匹配 sed + 空白）
 *   ② 用 shell 分词器切出参数（正确处理引号），分词失败直接 null
 *   ③ 只接受字符串类型的 token；遇到 glob（如 *.log）直接放弃——太复杂，解析不了
 *   ④ 逐参数扫描：识别 -i / -i.bak / -E / -r / -e / --expression=，其余未知 flag 直接放弃
 *   ⑤ 第一个非 flag 参数是表达式，第二个是文件路径，出现第三个就放弃（不支持多文件）
 *   ⑥ 表达式必须是 s/ 开头，然后用一个三态状态机（pattern → replacement → flags）切分
 *   ⑦ flags 必须只含安全字符（g/p/i/I/m/M/数字），否则放弃
 */
export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()

  // Must start with sed
  const sedMatch = trimmed.match(/^\s*sed\s+/)
  if (!sedMatch) return null

  const withoutSed = trimmed.slice(sedMatch[0].length)
  // 为什么不自己 split(' ')：sed 表达式里可能有空格，且引号内的内容是一个整体。
  //   用专门的 shell 分词器才能得到正确的参数边界
  // 为什么不自己 split(' ')：sed 表达式里可能有空格，且引号内的内容是一个整体。
  //   用专门的 shell 分词器才能得到正确的参数边界
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return null
  const tokens = parseResult.tokens

  // Extract string tokens only
  const args: string[] = []
  for (const token of tokens) {
    if (typeof token === 'string') {
      args.push(token)
    } else if (
      typeof token === 'object' &&
      token !== null &&
      'op' in token &&
      // glob（通配符，如 *.log）意味着「可能匹配多个文件」，本解析器只处理确定的单文件，直接放弃
      // glob（通配符，如 *.log）意味着「可能匹配多个文件」，本解析器只处理确定的单文件，直接放弃
      token.op === 'glob'
    ) {
      // Glob patterns are too complex for this simple parser
      return null
    }
  }

  // Parse flags and arguments
  let hasInPlaceFlag = false
  let extendedRegex = false
  let expression: string | null = null
  let filePath: string | null = null

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    // Handle -i flag (with or without backup suffix)
    // -i 的两种写法：GNU sed 的 -i 不带参数；macOS(BSD) sed 的 -i 必须带备份后缀（可以是空串）
    // -i 的两种写法：GNU sed 的 -i 不带参数；macOS(BSD) sed 的 -i 必须带备份后缀（可以是空串）
    if (arg === '-i' || arg === '--in-place') {
      hasInPlaceFlag = true
      i++
      // On macOS, -i requires a suffix argument (even if empty string)
      // Check if next arg looks like a backup suffix (empty, or starts with dot)
      // Don't consume flags (-E, -r) or sed expressions (starting with s, y, d)
      if (i < args.length) {
        const nextArg = args[i]
        // If next arg is empty string or starts with dot, it's a backup suffix
        if (
          typeof nextArg === 'string' &&
          !nextArg.startsWith('-') &&
          // 只把「空串」或「以点开头」（如 .bak）当作备份后缀吃掉；
          //   不能误吃掉 -E/-r 这类 flag，也不能吃掉 s/... 开头的表达式
          // 只把「空串」或「以点开头」（如 .bak）当作备份后缀吃掉；
          //   不能误吃掉 -E/-r 这类 flag，也不能吃掉 s/... 开头的表达式
          (nextArg === '' || nextArg.startsWith('.'))
        ) {
          i++ // Skip the backup suffix
        }
      }
      continue
    }
    if (arg.startsWith('-i')) {
      // -i.bak or similar (inline suffix)
      hasInPlaceFlag = true
      i++
      continue
    }

    // Handle extended regex flags
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true
      i++
      continue
    }

    // Handle -e flag with expression
    if (arg === '-e' || arg === '--expression') {
      if (i + 1 < args.length && typeof args[i + 1] === 'string') {
        // Only support single expression
        if (expression !== null) return null
        expression = args[i + 1]!
        i += 2
        continue
      }
      return null
    }
    if (arg.startsWith('--expression=')) {
      if (expression !== null) return null
      expression = arg.slice('--expression='.length)
      i++
      continue
    }

    // Skip other flags we don't understand
    // 遇到任何不认识的 flag 直接放弃解析——未知的 flag 可能改变语义，猜不得（保守策略）
    // 遇到任何不认识的 flag 直接放弃解析——未知的 flag 可能改变语义，猜不得（保守策略）
    if (arg.startsWith('-')) {
      // Unknown flag - not safe to parse
      return null
    }

    // Non-flag argument
    if (expression === null) {
      // First non-flag arg is the expression
      expression = arg
    } else if (filePath === null) {
      // Second non-flag arg is the file path
      filePath = arg
    } else {
      // More than one file - not supported for simple rendering
      return null
    }

    i++
  }

  // Must have -i flag, expression, and file path
  if (!hasInPlaceFlag || !expression || !filePath) {
    return null
  }

  // Parse the substitution expression: s/pattern/replacement/flags
  // Only support / as delimiter for simplicity
  const substMatch = expression.match(/^s\//)
  if (!substMatch) {
    return null
  }

  const rest = expression.slice(2) // Skip 's/'

  // Find pattern and replacement by tracking escaped characters
  let pattern = ''
  let replacement = ''
  let flags = ''
  // 三态状态机：遇到未转义的 / 就推进到下一态。字面量联合类型写在这里，编译器会检查取值合法性
  // 三态状态机：遇到未转义的 / 就推进到下一态。字面量联合类型写在这里，编译器会检查取值合法性
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let j = 0

  while (j < rest.length) {
    const char = rest[j]!

    // 转义处理：`\` 后面的字符要**原样保留**并一次前进两格，
    //   否则 `s/a\/b/c/` 里的 \/ 会被误当成分隔符，切分就全乱了
    // 转义处理：`\` 后面的字符要**原样保留**并一次前进两格，
    //   否则 `s/a\/b/c/` 里的 \/ 会被误当成分隔符，切分就全乱了
    if (char === '\\' && j + 1 < rest.length) {
      // Escaped character
      if (state === 'pattern') {
        pattern += char + rest[j + 1]
      } else if (state === 'replacement') {
        replacement += char + rest[j + 1]
      } else {
        flags += char + rest[j + 1]
      }
      j += 2
      continue
    }

    if (char === '/') {
      if (state === 'pattern') {
        state = 'replacement'
      } else if (state === 'replacement') {
        state = 'flags'
      } else {
        // Extra delimiter in flags - unexpected
        return null
      }
      j++
      continue
    }

    if (state === 'pattern') {
      pattern += char
    } else if (state === 'replacement') {
      replacement += char
    } else {
      flags += char
    }
    j++
  }

  // Must have found all three parts (pattern, replacement delimiter, and optional flags)
  // 没走到 flags 态说明分隔符不够（如 s/a/b 少了结尾的 /），判定为不完整，放弃
  // 没走到 flags 态说明分隔符不够（如 s/a/b 少了结尾的 /），判定为不完整，放弃
  if (state !== 'flags') {
    return null
  }

  // Validate flags - only allow safe substitution flags
  // flags 白名单：g(全局) p(打印) i/I(忽略大小写) m/M(多行) 1-9(第几次匹配)。
  //   **不含** w(写文件) 和 e(执行)——那两个是 sed 里真正的危险命令，见 sedValidation.ts
  // flags 白名单：g(全局) p(打印) i/I(忽略大小写) m/M(多行) 1-9(第几次匹配)。
  //   **不含** w(写文件) 和 e(执行)——那两个是 sed 里真正的危险命令，见 sedValidation.ts
  const validFlags = /^[gpimIM1-9]*$/
  if (!validFlags.test(flags)) {
    return null
  }

  return {
    filePath,
    pattern,
    replacement,
    flags,
    extendedRegex,
  }
}

/**
 * Apply a sed substitution to file content
 * Returns the new content after applying the substitution
 */
/**
 * 【做什么】把解析好的 sed 替换真正应用到文件内容上
 * 【为什么需要】预览/校验场景需要在本地算出「替换后会变成什么」
 * 【入参】content：文件原文；sedInfo：解析结果
 * 【返回】替换后的内容；正则非法时**原样返回**（不抛异常，避免打断调用方）
 * 【关键步骤】
 *   ① 把 sed 的 flags 翻译成 JS 正则 flags（g / i / m）
 *   ② 把 \/ 还原成 /
 *   ③ 非扩展模式（BRE）下做一次「反转义」转换（见下方详细说明）
 *   ④ 替换串：\& 先保护 → & 转成 $& → 再把保护位还原成字面 &
 *   ⑤ 构造正则执行替换；失败则原样返回
 */
/**
 * 【做什么】把解析好的 sed 替换真正应用到文件内容上
 * 【为什么需要】预览/校验场景需要在本地算出「替换后会变成什么」
 * 【入参】content：文件原文；sedInfo：解析结果
 * 【返回】替换后的内容；正则非法时**原样返回**（不抛异常，避免打断调用方）
 * 【关键步骤】
 *   ① 把 sed 的 flags 翻译成 JS 正则 flags（g / i / m）
 *   ② 把 \/ 还原成 /
 *   ③ 非扩展模式（BRE）下做一次「反转义」转换（见下方详细说明）
 *   ④ 替换串：\& 先保护 → & 转成 $& → 再把保护位还原成字面 &
 *   ⑤ 构造正则执行替换；失败则原样返回
 */
export function applySedSubstitution(
  content: string,
  sedInfo: SedEditInfo,
): string {
  // Convert sed pattern to JavaScript regex
  let regexFlags = ''

  // Handle global flag
  if (sedInfo.flags.includes('g')) {
    regexFlags += 'g'
  }

  // Handle case-insensitive flag (i or I in sed)
  if (sedInfo.flags.includes('i') || sedInfo.flags.includes('I')) {
    regexFlags += 'i'
  }

  // Handle multiline flag (m or M in sed)
  if (sedInfo.flags.includes('m') || sedInfo.flags.includes('M')) {
    regexFlags += 'm'
  }

  // Convert sed pattern to JavaScript regex pattern
  let jsPattern = sedInfo.pattern
    // Unescape \/ to /
    .replace(/\\\//g, '/')

  // In BRE mode (no -E flag), metacharacters have opposite escaping:
  // 中文详解（本文件最绕的一段）：
  //   BRE（默认，不带 -E）与 ERE/JS 对同一批元字符的转义含义**完全相反**：
  //     BRE:  \+ 表示「一个或多个」，单独的 + 是字面加号
  //     JS :  单独的 + 表示「一个或多个」，\+ 是字面加号
  //   所以要把 BRE 写法翻译成 JS 写法。难点在于「两步替换会互相干扰」，
  //   于是先用一个绝不会冲突的占位符把 `\+` 之类保护起来，再处理字面 +，最后把占位符换回 +
  // BRE: \+ means "one or more", + is literal
  // ERE/JS: + means "one or more", \+ is literal
  // We need to convert BRE escaping to ERE for JavaScript regex
  if (!sedInfo.extendedRegex) {
    jsPattern = jsPattern
      // Step 1: Protect literal backslashes (\\) first - in both BRE and ERE, \\ is literal backslash
      // 第 1 步必须先保护 `\\`（字面反斜杠）：它在 BRE 和 ERE 里含义一致，
      //   若不先保护，后面的替换会把它和其它转义搞混
      // 第 1 步必须先保护 `\\`（字面反斜杠）：它在 BRE 和 ERE 里含义一致，
      //   若不先保护，后面的替换会把它和其它转义搞混
      .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
      // Step 2: Replace escaped metacharacters with placeholders (these should become unescaped in JS)
      .replace(/\\\+/g, PLUS_PLACEHOLDER)
      .replace(/\\\?/g, QUESTION_PLACEHOLDER)
      .replace(/\\\|/g, PIPE_PLACEHOLDER)
      .replace(/\\\(/g, LPAREN_PLACEHOLDER)
      .replace(/\\\)/g, RPAREN_PLACEHOLDER)
      // Step 3: Escape unescaped metacharacters (these are literal in BRE)
      .replace(/\+/g, '\\+')
      .replace(/\?/g, '\\?')
      .replace(/\|/g, '\\|')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      // Step 4: Replace placeholders with their JS equivalents
      .replace(BACKSLASH_PLACEHOLDER_RE, '\\\\')
      .replace(PLUS_PLACEHOLDER_RE, '+')
      .replace(QUESTION_PLACEHOLDER_RE, '?')
      .replace(PIPE_PLACEHOLDER_RE, '|')
      .replace(LPAREN_PLACEHOLDER_RE, '(')
      .replace(RPAREN_PLACEHOLDER_RE, ')')
  }

  // Unescape sed-specific escapes in replacement
  // Convert \n to newline, & to $& (match), etc.
  // Use a unique placeholder with random salt to prevent injection attacks
  // 为什么占位符要掺随机盐：如果占位符是固定字符串，用户完全可以在替换串里**手写**这个字符串，
  //   从而操纵中间结果（一种注入）。掺入每次不同的随机盐后，用户无法预测、也就无法注入
  // 为什么占位符要掺随机盐：如果占位符是固定字符串，用户完全可以在替换串里**手写**这个字符串，
  //   从而操纵中间结果（一种注入）。掺入每次不同的随机盐后，用户无法预测、也就无法注入
  const salt = randomBytes(8).toString('hex')
  const ESCAPED_AMP_PLACEHOLDER = `___ESCAPED_AMPERSAND_${salt}___`
  const jsReplacement = sedInfo.replacement
    // Unescape \/ to /
    .replace(/\\\//g, '/')
    // First escape \& to a placeholder
    .replace(/\\&/g, ESCAPED_AMP_PLACEHOLDER)
    // Convert & to $& (full match) - use $$& to get literal $& in output
    // $$& 的写法：在 JS 的 replace 替换串里，`$$` 表示一个字面 $，所以 `$$&` 输出的是字面 `$&`，
    //   而 JS 引擎会把 `$&` 解释为「整个匹配」——这正是 sed 里 & 的语义
    // $$& 的写法：在 JS 的 replace 替换串里，`$$` 表示一个字面 $，所以 `$$&` 输出的是字面 `$&`，
    //   而 JS 引擎会把 `$&` 解释为「整个匹配」——这正是 sed 里 & 的语义
    .replace(/&/g, '$$&')
    // Convert placeholder back to literal &
    .replace(new RegExp(ESCAPED_AMP_PLACEHOLDER, 'g'), '&')

  // 转换后的正则仍可能非法（如括号不配对）。这里选择「静默返回原文」而不是抛错：
  //   本函数只用于展示与预览，抛异常会让整个渲染流程崩掉，代价太大
  // 转换后的正则仍可能非法（如括号不配对）。这里选择「静默返回原文」而不是抛错：
  //   本函数只用于展示与预览，抛异常会让整个渲染流程崩掉，代价太大
  try {
    const regex = new RegExp(jsPattern, regexFlags)
    return content.replace(regex, jsReplacement)
  } catch {
    // If regex is invalid, return original content
    return content
  }
}
