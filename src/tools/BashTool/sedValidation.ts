/**
 * 【一句话定位】判断一条 sed 命令是否安全——用「白名单模式 + 黑名单兜底」双保险，
 *   拦住 sed 里真正危险的两个能力：w/W（把内容写进文件）与 e/E（执行 shell 命令）。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx 权限链中的 checkSedConstraints（跨模式都生效的约束检查）
 *   下游：utils/bash/commands.js（拆分复合命令）、utils/bash/shellQuote.js（shell 分词）
 *   调用链：BashTool.hasPermission -> checkSedConstraints -> sedCommandIsAllowedByAllowlist
 *            -> isLinePrintingCommand / isSubstitutionCommand + containsDangerousOperations
 *
 * 【本文件包含什么】
 *   - validateFlagsAgainstAllowlist()：校验 flag 是否都在白名单内（支持 -nE 这种合并写法）
 *   - isLinePrintingCommand()：模式一——`sed -n '1p'` 这类「只打印指定行」
 *   - isPrintCommand()：更严格的单行判定，只认 p / Np / N,Mp
 *   - isSubstitutionCommand()：模式二——`sed 's/a/b/g'` 替换（只读或允许写文件两种档位）
 *   - sedCommandIsAllowedByAllowlist()：主判定入口（先白名单、再黑名单）
 *   - hasFileArgs()：命令里有没有「文件参数」（决定是不是只读）
 *   - extractSedExpressions()：把引号里的 sed 表达式提取出来
 *   - containsDangerousOperations()：黑名单——逐条拒绝可疑写法
 *   - checkSedConstraints()：对外主入口，返回 ask / passthrough
 *
 * 【为什么 sed 需要专门的安全校验】（本目录规则分类的关键）
 *   sed 表面上是「文本处理」，但它内置了三个危险能力：
 *     ① `w file` / `W file`：把匹配内容**写进任意文件**（等于变相的文件写入）
 *     ② `e` / `E`：把匹配内容当 **shell 命令执行**（等于任意命令执行）
 *     ③ 替换串里的 `e` flag（s/a/b/e）：把替换结果当命令执行
 *   所以即便命令看起来只是 `sed 's/x/y/'`，也必须把表达式拆开逐条审查
 *
 * 【规则分类逻辑】
 *   模式一（行打印）：必须带 -n，表达式只能是 p / Np / N,Mp（可用分号串多个），允许文件参数
 *  模式二（替换）：必须是 s/.../.../flags，flags 只允许 g,p,i,I,m,M 与一位 1-9；
 *     默认档位要求「纯只读」：不能有 -i、不能有文件参数；
 *     acceptEdits 模式下才放开（allowFileWrites=true）
 *   最后还有一层黑名单兜底：即便命中了白名单，只要表达式里有可疑写法就拒绝（防御纵深）
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `options?: { allowFileWrites?: boolean }`：可选参数 + 可选字段，`?` 都表示「可以不传」
 *   - `options?.allowFileWrites ?? false`：可选链 + 空值合并，两步兜底出默认值
 *   - `expr[0]!`、`match[1]!` 非空断言 ≈ 强制转换，骗编译器，运行时不检查
 *   - `catch (_error) {}`：下划线前缀表示「捕获但不使用这个错误」
 *   - `throw new Error(...)`：主动抛异常，由调用方 try/catch 兜住
 *   - 正则里的 `\1` 是**反向引用**，表示「和前面第 1 个捕获组匹配到的字符相同」
 *     （sed 允许用任意字符做分隔符，所以要捕获分隔符再引用它）
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import type { ToolPermissionContext } from '../../Tool.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

/**
 * Helper: Validate flags against an allowlist
 * Handles both single flags and combined flags (e.g., -nE)
 * @param flags Array of flags to validate
 * @param allowedFlags Array of allowed single-character and long flags
 * @returns true if all flags are valid, false otherwise
 */
/**
 * 【做什么】逐个检查 flag 是否都在允许清单内
 * 【为什么需要】sed 有大量 flag，未知 flag 可能带来我们没考虑到的行为，必须显式放行才安全
 * 【入参】flags：解析出的 flag 列表；allowedFlags：允许清单
 * 【返回】全部合法才 true
 * 【关键步骤】
 *   ① 形如 -nE 的**合并短 flag**（以 - 开头、不是 -- 、长度 > 2）要拆成 -n、-E 逐个查
 *   ② 单个 flag 或长 flag（--xxx）直接查清单
 */
function validateFlagsAgainstAllowlist(
  flags: string[],
  allowedFlags: string[],
): boolean {
  for (const flag of flags) {
    // Handle combined flags like -nE or -Er
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
      // Check each character in combined flag
      for (let i = 1; i < flag.length; i++) {
        const singleFlag = '-' + flag[i]
        if (!allowedFlags.includes(singleFlag)) {
          return false
        }
      }
    } else {
      // Single flag or long flag
      if (!allowedFlags.includes(flag)) {
        return false
      }
    }
  }
  return true
}

/**
 * Pattern 1: Check if this is a line printing command with -n flag
 * Allows: sed -n 'N' | sed -n 'N,M' with optional -E, -r, -z flags
 * Allows semicolon-separated print commands like: sed -n '1p;2p;3p'
 * File arguments are ALLOWED for this pattern
 * @internal Exported for testing
 */
/**
 * 【做什么】判定「模式一」：`sed -n '1p'` 这类只打印指定行的命令
 * 【为什么需要】这是最常见的只读 sed 用法，应当放行；但必须确认它真的只是打印
 * 【入参】command：单条 sed 命令；expressions：已提取出的表达式列表
 * 【返回】true = 是安全的行打印命令（**允许带文件参数**，因为只是读）
 * 【关键步骤】
 *   ① 必须以 sed 开头、shell 分词必须成功
 *   ② 收集所有 flag，逐一比对白名单（-n / -E / -r / -z / --posix 等）
 *   ③ **必须有 -n**（否则 sed 默认会把所有行都打出来，就谈不上「打印指定行」了）
 *   ④ 至少有一个表达式，且每个表达式按分号拆开后都必须是纯打印命令
 */
export function isLinePrintingCommand(
  command: string,
  expressions: string[],
): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // Extract all flags
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // Validate flags - only allow -n, -E, -r, -z and their long forms
  const allowedFlags = [
    '-n',
    '--quiet',
    '--silent',
    '-E',
    '--regexp-extended',
    '-r',
    '-z',
    '--zero-terminated',
    '--posix',
  ]

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // Check if -n flag is present (required for Pattern 1)
  let hasNFlag = false
  for (const flag of flags) {
    if (flag === '-n' || flag === '--quiet' || flag === '--silent') {
      hasNFlag = true
      break
    }
    // Check in combined flags
    // 中文补充：合并写法（如 -nE）里也可能含 n，所以要单独再查一遍，不能只看 flag === '-n'
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.includes('n')) {
      hasNFlag = true
      break
    }
  }

  // Must have -n flag for Pattern 1
  if (!hasNFlag) {
    return false
  }

  // Must have at least one expression
  if (expressions.length === 0) {
    return false
  }

  // All expressions must be print commands (strict allowlist)
  // Allow semicolon-separated commands
  for (const expr of expressions) {
    const commands = expr.split(';')
    for (const cmd of commands) {
      if (!isPrintCommand(cmd.trim())) {
        return false
      }
    }
  }

  return true
}

/**
 * Helper: Check if a single command is a valid print command
 * STRICT ALLOWLIST - only these exact forms are allowed:
 * - p (print all)
 * - Np (print line N, where N is digits)
 * - N,Mp (print lines N through M)
 * Anything else (including w, W, e, E commands) is rejected.
 * @internal Exported for testing
 */
/**
 * 【做什么】严格判定单个表达式是不是「打印命令」
 * 【为什么需要】这是模式一的最后一道关，必须做到「除了打印什么都不许做」
 * 【返回】只认三种形式：p（打印全部）、Np（打印第 N 行）、N,Mp（打印 N 到 M 行）
 * 注意：w、W、e、E 这些危险命令**全部被排除**，因为正则 ^(?:\d+|\d+,\d+)?p$ 要求必须以 p 结尾
 */
export function isPrintCommand(cmd: string): boolean {
  if (!cmd) return false
  // Single strict regex that only matches allowed print commands
  // ^(?:\d+|\d+,\d+)?p$ matches: p, 1p, 123p, 1,5p, 10,200p
  return /^(?:\d+|\d+,\d+)?p$/.test(cmd)
}

/**
 * Pattern 2: Check if this is a substitution command
 * Allows: sed 's/pattern/replacement/flags' where flags are only: g, p, i, I, m, M, 1-9
 * When allowFileWrites is true, allows -i flag and file arguments for in-place editing
 * When allowFileWrites is false (default), requires stdout-only (no file arguments, no -i flag)
 * @internal Exported for testing
 */
/**
 * 【做什么】判定「模式二」：s/pattern/replacement/flags 替换命令
 * 【为什么需要】替换是最常用的 sed 能力，但 s 命令的 flags 里可以藏 w（写文件）和 e（执行命令），
 *   所以既要放行常用写法，又要把 flags 卡死
 * 【入参】command、expressions、hasFileArguments、options.allowFileWrites
 * 【返回】true = 是安全的替换命令
 * 【关键步骤】
 *   ① 不允许写文件时，只要有文件参数就直接拒绝（保证「只读」）
 *   ② flag 白名单：基础是 -E/-r/--posix；允许写文件时才额外加 -i/--in-place
 *   ③ **必须恰好一个表达式**（多个表达式增加复杂度，也增加绕过风险）
 *   ④ 表达式必须以 s 开头，且只认 / 作为分隔符（其它分隔符一律拒绝，从严处理）
 *   ⑤ 数分隔符个数（跳过转义的 \/），必须正好 2 个；多一个少一个都拒绝
 *   ⑥ 末尾 flags 只允许 g、p、i、I、m、M 与至多一位 1-9
 */
function isSubstitutionCommand(
  command: string,
  expressions: string[],
  hasFileArguments: boolean,
  options?: { allowFileWrites?: boolean },
): boolean {
  // 两道兜底：options 可能整个不传（?.），传了也可能没这个字段（??）。默认「不允许写文件」最安全
  const allowFileWrites = options?.allowFileWrites ?? false

  // When not allowing file writes, must NOT have file arguments
  // 只读档位下的硬约束：有文件参数就拒绝。
  //   因为 sed 带文件参数时可能配合 w 命令写文件，无法保证只读
  if (!allowFileWrites && hasFileArguments) {
    return false
  }

  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // Extract all flags
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // Validate flags based on mode
  // Base allowed flags for both modes
  const allowedFlags = ['-E', '--regexp-extended', '-r', '--posix']

  // When allowing file writes, also permit -i and --in-place
  if (allowFileWrites) {
    allowedFlags.push('-i', '--in-place')
  }

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // Must have exactly one expression
  // 为什么卡死「恰好一个」：多表达式之间可以互相配合构造绕过，且这类命令本身也罕见，从严处理
  if (expressions.length !== 1) {
    return false
  }

  const expr = expressions[0]!.trim()

  // STRICT ALLOWLIST: Must be exactly a substitution command starting with 's'
  // This rejects standalone commands like 'e', 'w file', etc.
  // 单独出现的 e / w file 等命令会在这里被挡掉（它们不以 s 开头）
  if (!expr.startsWith('s')) {
    return false
  }

  // Parse substitution: s/pattern/replacement/flags
  // Only allow / as delimiter (strict)
  const substitutionMatch = expr.match(/^s\/(.*?)$/)
  if (!substitutionMatch) {
    return false
  }

  const rest = substitutionMatch[1]!

  // Find the positions of / delimiters
  let delimiterCount = 0
  let lastDelimiterPos = -1
  let i = 0
  while (i < rest.length) {
    if (rest[i] === '\\') {
      // Skip escaped character
      i += 2
      continue
    }
    if (rest[i] === '/') {
      delimiterCount++
      lastDelimiterPos = i
    }
    i++
  }

  // Must have found exactly 2 delimiters (pattern and replacement)
  // 分隔符必须正好两个：s<分隔>pattern<分隔>replacement<分隔>flags。
  //   少了说明命令不完整，多了说明末尾还有额外内容（可能藏着 w file）
  if (delimiterCount !== 2) {
    return false
  }

  // Extract flags (everything after the last delimiter)
  const exprFlags = rest.slice(lastDelimiterPos + 1)

  // Validate flags: only allow g, p, i, I, m, M, and optionally ONE digit 1-9
  // 关键安全点：这个白名单里**没有 w 和 e**。
  //   s/a/b/w file 会写文件、s/a/b/e 会执行替换结果——两者都必须被拒
  const allowedFlagChars = /^[gpimIM]*[1-9]?[gpimIM]*$/
  if (!allowedFlagChars.test(exprFlags)) {
    return false
  }

  return true
}

/**
 * Checks if a sed command is allowed by the allowlist.
 * The allowlist patterns themselves are strict enough to reject dangerous operations.
 * @param command The sed command to check
 * @param options.allowFileWrites When true, allows -i flag and file arguments for substitution commands
 * @returns true if the command is allowed (matches allowlist and passes denylist check), false otherwise
 */
/**
 * 【做什么】sed 命令安全判定的主入口
 * 【为什么需要】把「白名单模式匹配」与「黑名单兜底」组合成一次完整判定
 * 【入参】command：单条 sed 命令；options.allowFileWrites：是否允许就地写文件
 * 【返回】true = 允许（不额外询问）
 * 【关键步骤】
 *   ① 提取表达式；**解析失败直接返回 false**（解析不了 = 看不懂 = 不安全）
 *   ② 判断有没有文件参数
 *   ③ 允许写文件时只走模式二；只读时模式一、模式二都试，命中任一即可
 *   ④ 都没命中 → 拒绝
 *   ⑤ 模式二额外禁止分号（模式一允许分号串多个 p 命令，模式二不允许）
 *   ⑥ 最后再用黑名单扫一遍所有表达式——即便白名单放行，可疑写法依然拒绝（防御纵深）
 */
export function sedCommandIsAllowedByAllowlist(
  command: string,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // Extract sed expressions (content inside quotes where actual sed commands live)
  let expressions: string[]
  try {
    expressions = extractSedExpressions(command)
  // 解析失败一律按「不允许」处理：这是本文件反复出现的设计取向——
  //   **看不懂就等于不安全**，绝不因为「可能没问题」而放行
  } catch (_error) {
    // If parsing failed, treat as not allowed
    return false
  }

  // Check if sed command has file arguments
  const hasFileArguments = hasFileArgs(command)

  // Check if command matches allowlist patterns
  let isPattern1 = false
  let isPattern2 = false

  if (allowFileWrites) {
    // When allowing file writes, only check substitution commands (Pattern 2 variant)
    // Pattern 1 (line printing) doesn't need file writes
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments, {
      allowFileWrites: true,
    })
  } else {
    // Standard read-only mode: check both patterns
    isPattern1 = isLinePrintingCommand(command, expressions)
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments)
  }

  if (!isPattern1 && !isPattern2) {
    return false
  }

  // Pattern 2 does not allow semicolons (command separators)
  // Pattern 1 allows semicolons for separating print commands
  for (const expr of expressions) {
    if (isPattern2 && expr.includes(';')) {
      return false
    }
  }

  // Defense-in-depth: Even if allowlist matches, check denylist
  // 中文补充：白名单已经很严了，这里还要再扫一遍黑名单。
  //   原因是白名单基于「分词后的参数」，而黑名单直接审查**表达式原文**，
  //   两套视角互为补充，任何一层漏了还有另一层（这是安全代码里常见的双保险）
  for (const expr of expressions) {
    if (containsDangerousOperations(expr)) {
      return false
    }
  }

  return true
}

/**
 * Check if a sed command has file arguments (not just stdin)
 * @internal Exported for testing
 */
/**
 * 【做什么】判断 sed 命令里有没有「文件参数」
 * 【为什么需要】有文件参数 = 不只是处理 stdin = 可能读写真实文件，风险等级完全不同
 * 【返回】true = 有文件参数（**解析失败时也返回 true**，按危险处理）
 * 【关键步骤】
 *   ① 分词；失败直接返回 true（保守）
 *   ② 遇到 glob（如 *.log）直接算有文件参数
 *   ③ 跳过 -e / --expression= 及其后的表达式
 *   ④ 数非 flag 参数：用过 -e 时，所有非 flag 参数都是文件；
 *      没用 -e 时，第一个非 flag 参数是表达式，出现第二个才算文件参数
 */
export function hasFileArgs(command: string): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return true
  const parsed = parseResult.tokens

  try {
    let argCount = 0
    let hasEFlag = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // Handle both string arguments and glob patterns (like *.log)
      if (typeof arg !== 'string' && typeof arg !== 'object') continue

      // If it's a glob pattern, it counts as a file argument
      if (
        typeof arg === 'object' &&
        arg !== null &&
        'op' in arg &&
        arg.op === 'glob'
      ) {
        return true
      }

      // Skip non-string arguments that aren't glob patterns
      if (typeof arg !== 'string') continue

      // Handle -e flag followed by expression
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        hasEFlag = true
        i++ // Skip the next argument since it's the expression
        continue
      }

      // Handle --expression=value format
      if (arg.startsWith('--expression=')) {
        hasEFlag = true
        continue
      }

      // Handle -e=value format (non-standard but defense in depth)
      if (arg.startsWith('-e=')) {
        hasEFlag = true
        continue
      }

      // Skip other flags
      if (arg.startsWith('-')) continue

      argCount++

      // If we used -e flags, ALL non-flag arguments are file arguments
      if (hasEFlag) {
        return true
      }

      // If we didn't use -e flags, the first non-flag argument is the sed expression,
      // so we need more than 1 non-flag argument to have file arguments
      if (argCount > 1) {
        return true
      }
    }

    return false
  } catch (_error) {
    // 「解析失败按危险处理」——本文件的统一取向：宁可多问一次用户，也不放过可疑命令
    return true // Assume dangerous if parsing fails
  }
}

/**
 * Extract sed expressions from command, ignoring flags and filenames
 * @param command Full sed command
 * @returns Array of sed expressions to check for dangerous operations
 * @throws Error if parsing fails
 * @internal Exported for testing
 */
/**
 * 【做什么】从命令里把「sed 表达式」提取出来（就是引号里那段真正的 sed 脚本）
 * 【为什么需要】危险能力（w / e）都藏在表达式里，必须先把它单独拿出来才能审查
 * 【入参】command：单条 sed 命令
 * 【返回】表达式数组
 * 【抛出】解析失败或发现危险 flag 组合时抛 Error（由调用方捕获并判为不安全）
 * 【关键步骤】
 *   ① 去掉开头的 sed
 *   ② 直接拒绝 -ew / -we 这类「把 -e 和危险命令连写」的组合（见下方注释）
 *   ③ shell 分词；语法错误直接抛
 *   ④ 收集：-e 后面的参数、--expression= 的值、-e= 的值；
 *      没有 -e 时，第一个非 flag 参数就是表达式
 */
export function extractSedExpressions(command: string): string[] {
  const expressions: string[] = []

  // Calculate withoutSed by trimming off the first N characters (removing 'sed ')
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return expressions

  const withoutSed = command.slice(sedMatch[0].length)

  // Reject dangerous flag combinations like -ew, -eW, -ee, -we (combined -e/-w with dangerous commands)
  // -ew / -we 这类连写：-e 后面紧跟 w（写文件）或 e（执行命令）。
  //   分词器可能会把它当成普通 flag，所以在分词**之前**先用正则拦一道
  if (/-e[wWe]/.test(withoutSed) || /-w[eE]/.test(withoutSed)) {
    throw new Error('Dangerous flag combination detected')
  }

  // Use shell-quote to parse the arguments properly
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) {
    // Malformed shell syntax - throw error to be caught by caller
    throw new Error(`Malformed shell syntax: ${parseResult.error}`)
  }
  const parsed = parseResult.tokens
  try {
    let foundEFlag = false
    let foundExpression = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // Skip non-string arguments (like control operators)
      if (typeof arg !== 'string') continue

      // Handle -e flag followed by expression
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        foundEFlag = true
        const nextArg = parsed[i + 1]
        if (typeof nextArg === 'string') {
          expressions.push(nextArg)
          i++ // Skip the next argument since we consumed it
        }
        continue
      }

      // Handle --expression=value format
      if (arg.startsWith('--expression=')) {
        foundEFlag = true
        expressions.push(arg.slice('--expression='.length))
        continue
      }

      // Handle -e=value format (non-standard but defense in depth)
      if (arg.startsWith('-e=')) {
        foundEFlag = true
        expressions.push(arg.slice('-e='.length))
        continue
      }

      // Skip other flags
      if (arg.startsWith('-')) continue

      // If we haven't found any -e flags, the first non-flag argument is the sed expression
      if (!foundEFlag && !foundExpression) {
        expressions.push(arg)
        foundExpression = true
        continue
      }

      // If we've already found -e flags or a standalone expression,
      // remaining non-flag arguments are filenames
      break
    }
  } catch (error) {
    // If shell-quote parsing fails, treat the sed command as unsafe
    throw new Error(
      `Failed to parse sed command: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }

  return expressions
}

/**
 * Check if a sed expression contains dangerous operations (denylist)
 * @param expression Single sed expression (without quotes)
 * @returns true if dangerous, false if safe
 */
/**
 * 【做什么】黑名单审查：表达式里有没有可疑/危险写法
 * 【为什么需要】白名单基于「结构」，而攻击者会利用**同形字符、非常规分隔符、GNU 扩展语法**绕过结构检查；
 *   这一层直接对原文做保守扫描，宁可错杀
 * 【入参】expression：单个表达式原文
 * 【返回】true = 危险（调用方据此拒绝）
 */
function containsDangerousOperations(expression: string): boolean {
  const cmd = expression.trim()
  if (!cmd) return false

  // CONSERVATIVE REJECTIONS: Broadly reject patterns that could be dangerous
  // 中文对照：**保守拒绝**——凡是有可能危险的写法一律拒绝。
  //   设计取向是「宁可拒绝一条正常命令（用户多点一次确认），也不放过一条危险命令」
  // When in doubt, treat as unsafe

  // Reject non-ASCII characters (Unicode homoglyphs, combining chars, etc.)
  // Examples: ｗ (fullwidth), ᴡ (small capital), w̃ (combining tilde)
  // Check for characters outside ASCII range (0x01-0x7F, excluding null byte)
  // eslint-disable-next-line no-control-regex
  // 拒绝非 ASCII 字符：防止用全角 ｗ、小大写 ᴡ、组合字符 w̃ 等「同形字」绕过 w 的检测
  if (/[^\x01-\x7F]/.test(cmd)) {
    return true
  }

  // Reject curly braces (blocks) - too complex to parse
  // 拒绝花括号：{...} 是 sed 的命令块，内部可以放任意命令，本解析器不打算支持
  if (cmd.includes('{') || cmd.includes('}')) {
    return true
  }

  // Reject newlines - multi-line commands are too complex
  if (cmd.includes('\n')) {
    return true
  }

  // Reject comments (# not immediately after s command)
  // Comments look like: #comment or start with #
  // Delimiter looks like: s#pattern#replacement#
  // # 既可能是注释，也可能是 s#a#b# 的分隔符。
  //   判断方法：只有当 # 紧跟在 s 后面时才认为是分隔符，其余一律当注释拒绝
  const hashIndex = cmd.indexOf('#')
  if (hashIndex !== -1 && !(hashIndex > 0 && cmd[hashIndex - 1] === 's')) {
    return true
  }

  // Reject negation operator
  // Negation can appear: at start (!/pattern/), after address (/pattern/!, 1,10!, $!)
  // Delimiter looks like: s!pattern!replacement! (has 's' before it)
  // ! 是否定操作符，也可能是 s!a!b! 的分隔符（同样只在 s 之后才算分隔符）
  if (/^!/.test(cmd) || /[/\d$]!/.test(cmd)) {
    return true
  }

  // Reject tilde in GNU step address format (digit~digit, ,~digit, or $~digit)
  // Allow whitespace around tilde
  if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(cmd)) {
    return true
  }

  // Reject comma at start (bare comma is shorthand for 1,$ address range)
  if (/^,/.test(cmd)) {
    return true
  }

  // Reject comma followed by +/- (GNU offset addresses)
  if (/,\s*[+-]/.test(cmd)) {
    return true
  }

  // Reject backslash tricks:
  // 1. s\ (substitution with backslash delimiter)
  // 2. \X where X could be an alternate delimiter (|, #, %, etc.) - not regex escapes
  if (/s\\/.test(cmd) || /\\[|#%@]/.test(cmd)) {
    return true
  }

  // Reject escaped slashes followed by w/W (patterns like /\/path\/to\/file/w)
  if (/\\\/.*[wW]/.test(cmd)) {
    return true
  }

  // Reject malformed/suspicious patterns we don't understand
  // If there's a slash followed by non-slash chars, then whitespace, then dangerous commands
  // Examples: /pattern w file, /pattern e cmd, /foo X;w file
  if (/\/[^/]*\s+[wWeE]/.test(cmd)) {
    return true
  }

  // Reject malformed substitution commands that don't follow normal pattern
  // Examples: s/foobareoutput.txt (missing delimiters), s/foo/bar//w (extra delimiter)
  if (/^s\//.test(cmd) && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(cmd)) {
    return true
  }

  // PARANOID: Reject any command starting with 's' that ends with dangerous chars (w, W, e, E)
  // 中文对照（偏执级检查）：以 s 开头、却以 w/W/e/E 结尾的命令——
  //   很可能是用非 / 分隔符写成的畸形替换命令，且末尾挂了危险 flag。
  //   除非能证明它是「分隔符一致的正规替换」，否则一律拒绝
  // and doesn't match our known safe substitution pattern. This catches malformed s commands
  // with non-slash delimiters that might be trying to use dangerous flags.
  if (/^s./.test(cmd) && /[wWeE]$/.test(cmd)) {
    // Check if it's a properly formed substitution (any delimiter, not just /)
    const properSubst = /^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(cmd)
    if (!properSubst) {
      return true
    }
  }

  // Check for dangerous write commands
  // 中文对照：**写文件命令**——w file / W file。这是 sed 最危险的能力之一：
  //   它能把匹配到的内容写进任意路径的文件，等于绕过了文件写入的权限检查
  // Patterns: [address]w filename, [address]W filename, /pattern/w filename, /pattern/W filename
  // Simplified to avoid exponential backtracking (CodeQL issue)
  // Check for w/W in contexts where it would be a command (with optional whitespace)
  if (
    /^[wW]\s*\S+/.test(cmd) || // At start: w file
    /^\d+\s*[wW]\s*\S+/.test(cmd) || // After line number: 1w file or 1 w file
    /^\$\s*[wW]\s*\S+/.test(cmd) || // After $: $w file or $ w file
    /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) || // After pattern: /pattern/w file
    /^\d+,\d+\s*[wW]\s*\S+/.test(cmd) || // After range: 1,10w file
    /^\d+,\$\s*[wW]\s*\S+/.test(cmd) || // After range: 1,$w file
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) // After pattern range: /s/,/e/w file
  ) {
    return true
  }

  // Check for dangerous execute commands
  // 中文对照：**执行命令**——e cmd。它能把匹配到的内容交给 shell 执行，
  //   等于任意命令执行，是必须 100% 拦死的
  // Patterns: [address]e [command], /pattern/e [command], or commands starting with e
  // Simplified to avoid exponential backtracking (CodeQL issue)
  // Check for e in contexts where it would be a command (with optional whitespace)
  if (
    /^e/.test(cmd) || // At start: e cmd
    /^\d+\s*e/.test(cmd) || // After line number: 1e or 1 e
    /^\$\s*e/.test(cmd) || // After $: $e or $ e
    /^\/[^/]*\/[IMim]*\s*e/.test(cmd) || // After pattern: /pattern/e
    /^\d+,\d+\s*e/.test(cmd) || // After range: 1,10e
    /^\d+,\$\s*e/.test(cmd) || // After range: 1,$e
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(cmd) // After pattern range: /s/,/e/e
  ) {
    return true
  }

  // Check for substitution commands with dangerous flags
  // Pattern: s<delim>pattern<delim>replacement<delim>flags where flags contain w or e
  // Per POSIX, sed allows any character except backslash and newline as delimiter
  // 捕获第 1 个分隔符字符，再用 \1 反向引用它——因为 POSIX 允许用除反斜杠和换行外的任意字符做分隔符
  const substitutionMatch = cmd.match(/s([^\\\n]).*?\1.*?\1(.*?)$/)
  if (substitutionMatch) {
    const flags = substitutionMatch[2] || ''

    // Check for write flag: s/old/new/w filename or s/old/new/gw filename
    // s/a/b/w file：把替换结果写进文件 —— 拒绝
    if (flags.includes('w') || flags.includes('W')) {
      return true
    }

    // Check for execute flag: s/old/new/e or s/old/new/ge
    // s/a/b/e：把替换结果当命令执行 —— 拒绝（这是最隐蔽的一种利用方式）
    if (flags.includes('e') || flags.includes('E')) {
      return true
    }
  }

  // Check for y (transliterate) command followed by dangerous operations
  // Pattern: y<delim>source<delim>dest<delim> followed by anything
  // The y command uses same delimiter syntax as s command
  // PARANOID: Reject any y command that has w/W/e/E anywhere after the delimiters
  // y 是「字符替换」命令。正常用法很罕见，所以策略偏执：只要 y 命令里出现 w/W/e/E 就不放行
  const yCommandMatch = cmd.match(/y([^\\\n])/)
  if (yCommandMatch) {
    // If we see a y command, check if there's any w, W, e, or E in the entire command
    // This is paranoid but safe - y commands are rare and w/e after y is suspicious
    if (/[wWeE]/.test(cmd)) {
      return true
    }
  }

  return false
}

/**
 * Cross-cutting validation step for sed commands.
 *
 * This is a constraint check that blocks dangerous sed operations regardless of mode.
 * It returns 'passthrough' for non-sed commands or safe sed commands,
 * and 'ask' for dangerous sed operations (w/W/e/E commands).
 *
 * @param input - Object containing the command string
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'ask' if any sed command contains dangerous operations
 * - 'passthrough' if no sed commands or all are safe
 */
/**
 * 【做什么】跨模式的 sed 约束检查（对外主入口）
 * 【为什么需要】sed 的危险能力与「当前是什么权限模式」无关，必须无条件拦截；
 *   所以它被设计成一个独立的、先于模式判断的约束层
 * 【入参】input：{ command }；toolPermissionContext：含当前 mode
 * 【返回】ask（发现危险 sed）/ passthrough（没有 sed 或都很安全）
 * 【关键步骤】
 *   ① 把整条命令拆成子命令（sed 可能只是其中一段）
 *   ② 跳过非 sed 子命令
 *   ③ acceptEdits 模式下放开「就地写文件」（-i），但**依然**拦危险操作
 *   ④ 任一子命令不合规 → 整条 ask
 */
export function checkSedConstraints(
  input: { command: string },
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const commands = splitCommand_DEPRECATED(input.command)

  for (const cmd of commands) {
    // Skip non-sed commands
    const trimmed = cmd.trim()
    const baseCmd = trimmed.split(/\s+/)[0]
    if (baseCmd !== 'sed') {
      continue
    }

    // In acceptEdits mode, allow file writes (-i flag) but still block dangerous operations
    // 只有「用户已同意编辑文件」的 acceptEdits 模式才允许 sed -i；
    //   但注意：即便如此，w/e 这类危险操作仍然被黑名单拦着（写文件 ≠ 可执行命令）
    const allowFileWrites = toolPermissionContext.mode === 'acceptEdits'

    const isAllowed = sedCommandIsAllowedByAllowlist(trimmed, {
      allowFileWrites,
    })

    if (!isAllowed) {
      return {
        behavior: 'ask',
        message:
          'sed command requires approval (contains potentially dangerous operations)',
        decisionReason: {
          type: 'other',
          reason:
            'sed command contains operations that require explicit approval (e.g., write commands, execute commands)',
        },
      }
    }
  }

  // No dangerous sed commands found (or no sed commands at all)
  return {
    behavior: 'passthrough',
    message: 'No dangerous sed operations detected',
  }
}
