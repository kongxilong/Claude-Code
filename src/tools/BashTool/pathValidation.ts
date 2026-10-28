/**
 * 【一句话定位】路径安全校验：把命令里涉及的**文件路径**一个个抠出来，
 *   逐个确认它们落在「本次会话允许的工作目录」之内，越界就要求用户确认或直接拒绝。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx 的权限链（checkPathConstraints 是其中一环，在模式判断、规则表之后执行）
 *   下游：utils/permissions/pathValidation.js（真正的路径判定：validatePath / isDangerousRemovalPath /
 *        expandTilde / formatDirectoryList）、utils/permissions/filesystem.js（允许的工作目录集合）、
 *        utils/permissions/PermissionUpdate.js（生成「要不要把目录加进白名单」的建议）、
 *        utils/bash/commands.js、utils/bash/shellQuote.js、bashPermissions.js（stripSafeWrappers）、
 *        sedValidation.js（判断 sed 是否只读）
 *   调用链：BashTool.hasPermission -> checkPathConstraints -> validateSinglePathCommand
 *            -> createPathChecker -> validateCommandPaths -> validatePath（外部模块）
 *
 * 【本文件包含什么】
 *   - PathCommand：需要做路径校验的命令名字面量联合类型（cd/ls/find/rm/mv/cp/grep/git/sed/jq...）
 *   - checkDangerousRemovalPaths()：专门拦 rm -rf / 这类「删掉系统关键目录」的极端情况
 *   - filterOutFlags()：从参数里挑出「路径参数」（正确处理 POSIX 的 -- 结束符）
 *   - parsePatternCommand()：grep/rg 这类「模式 + 路径」命令的参数解析
 *   - PATH_EXTRACTORS：按命令名登记的路径提取器表（本文件的核心数据结构）
 *   - ACTION_VERBS / COMMAND_OPERATION_TYPE：每个命令的动作描述与操作类型（read/write/create）
 *   - COMMAND_VALIDATOR：命令级额外校验（如 mv/cp 一律禁止带任何 flag）
 *   - validateCommandPaths()：对单条命令做路径校验的主逻辑
 *   - createPathChecker()：工厂函数，产出「带建议规则」的路径检查器
 *   - parseCommandArguments()：shell 分词（含 glob 处理）
 *   - validateSinglePathCommand() / validateSinglePathCommandArgv()：两条入口（字符串 / AST）
 *   - validateOutputRedirections()：校验 > / >> 的输出目标路径
 *   - checkPathConstraints()：对外主入口
 *   - astRedirectsToOutputRedirections()：把 AST 里的重定向转成内部格式
 *   - stripWrappersFromArgv() 及三个 skip*Flags()：剥掉 timeout/nice/stdbuf/env/time/nohup 等包装命令
 *
 * 【路径校验到底在防什么】（理解本目录的关键）
 *   核心威胁是「路径解析错位」，也就是：权限系统以为命令作用在 A 目录，
 *   实际上 shell 执行时作用在 B 目录或 B 文件。常见四种绕过手法：
 *   ① cd 之后再操作：路径是相对**原** cwd 解析的，但 cd 之后实际落在别处 → 复合命令里有 cd 且非只读就问
 *   ② `--` 结束符：rm -- -/../.claude/x 里的 -/.. 以 - 开头，naive 过滤会把它当 flag 丢掉 → 必须正确解析 --
 *   ③ 包装命令：timeout 10 rm -rf / 若只看第一个词会看到 timeout → 必须先剥包装再取命令名
 *   ④ 重定向 / 进程替换：echo x > file、echo x > >(tee file) 都是写文件，但不在 argv 里 → 必须单独校验重定向目标
 *   此外还有「极端危险路径」（/、~、$HOME、/etc 等）由 isDangerousRemovalPath 单独拦，
 *   且这部分**不允许**被任何白名单规则自动放行
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `export type X = 'a' | 'b' | ...`：字面量联合类型 ≈ Java enum，但编译后就是字符串
 *   - `Record<K, V>`：工具类型 ≈ Java 的 Map<K,V> / 字典，键集合由 K 决定（这里 K 是 PathCommand）
 *   - `Partial<Record<...>>`：把每个值都变成可选 ≈ 「这张表不必填满所有命令」
 *   - `readonly string[]`：只读数组，编译期禁止修改（≈ Java 的不可变 List）
 *   - `args[i]!` 非空断言 ≈ 强制转换，骗编译器，运行时不检查
 *   - `for (;;)`：无限循环（等价于 Java 的 while(true)），靠内部的 return / break 退出
 *   - 工厂函数：createPathChecker 返回另一个函数 ≈ Java 里返回 lambda（Function）
 *   - `const [baseCmd, ...args] = arr` 剩余解构 ≈ 取第一个元素 + 剩下的组成新数组
 *   - `??` 空值合并：只兜 null/undefined（和 || 不同，0 / '' 不会被替换）
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import type { Redirect, SimpleCommand } from '../../utils/bash/ast.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getDirectoryForPath } from '../../utils/path.js'
import { allWorkingDirectories } from '../../utils/permissions/filesystem.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  expandTilde,
  type FileOperationType,
  formatDirectoryList,
  isDangerousRemovalPath,
  validatePath,
} from '../../utils/permissions/pathValidation.js'
import type { BashTool } from './BashTool.js'
import { stripSafeWrappers } from './bashPermissions.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

// 需要做路径校验的命令全集。用字面量联合类型而非 string[]，好处是：
//   下面的 PATH_EXTRACTORS 若漏了某个命令，编译器会直接报错（Record<PathCommand, ...> 要求全覆盖）
export type PathCommand =
  | 'cd'
  | 'ls'
  | 'find'
  | 'mkdir'
  | 'touch'
  | 'rm'
  | 'rmdir'
  | 'mv'
  | 'cp'
  | 'cat'
  | 'head'
  | 'tail'
  | 'sort'
  | 'uniq'
  | 'wc'
  | 'cut'
  | 'paste'
  | 'column'
  | 'tr'
  | 'file'
  | 'stat'
  | 'diff'
  | 'awk'
  | 'strings'
  | 'hexdump'
  | 'od'
  | 'base64'
  | 'nl'
  | 'grep'
  | 'rg'
  | 'sed'
  | 'git'
  | 'jq'
  | 'sha256sum'
  | 'sha1sum'
  | 'md5sum'

/**
 * Checks if an rm/rmdir command targets dangerous paths that should always
 * require explicit user approval, even if allowlist rules exist.
 * This prevents catastrophic data loss from commands like `rm -rf /`.
 */
/**
 * 【做什么】检查 rm / rmdir 的目标里有没有「绝对不能碰」的系统关键路径
 * 【为什么需要】即便用户配了 `rm:*` 这种放行规则，`rm -rf /` 也绝不能被自动放行——
 *   这是最后一道人为兜底，专门防止「规则写太宽 + 命令写太狠」造成的灾难性数据丢失
 * 【入参】command：'rm' 或 'rmdir'；args：参数；cwd：当前工作目录
 * 【返回】ask（命中危险路径，且**不给任何建议规则**）/ passthrough
 * 【关键步骤】
 *   ① 用 PATH_EXTRACTORS 取出路径
 *   ② 去掉首尾引号 → 展开 ~ → 相对路径按 cwd 解析成绝对路径
 *   ③ 逐个交给 isDangerousRemovalPath 判定
 *   ④ 命中就 ask，并显式返回空 suggestions（不鼓励用户把这种命令存成规则）
 */
function checkDangerousRemovalPaths(
  command: 'rm' | 'rmdir',
  args: string[],
  cwd: string,
): PermissionResult {
  // Extract paths using the existing path extractor
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)

  for (const path of paths) {
    // Expand tilde and resolve to absolute path
    // NOTE: We check the path WITHOUT resolving symlinks, because dangerous paths
    // 中文补充：刻意**不**解析符号链接。原因很实际——macOS 上 /tmp 是 /private/tmp 的软链接，
    //   如果先解析成真实路径，/tmp 就变成了 /private/tmp，反而匹配不上「危险路径」清单里的 /tmp
    // like /tmp should be caught even though /tmp is a symlink to /private/tmp on macOS
    const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath)

    // Check if this is a dangerous path (using the non-symlink-resolved path)
    if (isDangerousRemovalPath(absolutePath)) {
      return {
        behavior: 'ask',
        message: `Dangerous ${command} operation detected: '${absolutePath}'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
        decisionReason: {
          type: 'other',
          reason: `Dangerous ${command} operation on critical path: ${absolutePath}`,
        },
        // Don't provide suggestions - we don't want to encourage saving dangerous commands
        suggestions: [],
      }
    }
  }

  // No dangerous paths found
  return {
    behavior: 'passthrough',
    message: `No dangerous removals detected for ${command} command`,
  }
}

/**
 * SECURITY: Extract positional (non-flag) arguments, correctly handling the
 * POSIX `--` end-of-options delimiter.
 *
 * Most commands (rm, cat, touch, etc.) stop parsing options at `--` and treat
 * ALL subsequent arguments as positional, even if they start with `-`. Naive
 * `!arg.startsWith('-')` filtering drops these, causing path validation to be
 * silently skipped for attack payloads like:
 *
 *   rm -- -/../.claude/settings.local.json
 *
 * Here `-/../.claude/settings.local.json` starts with `-` so the naive filter
 * drops it, validation sees zero paths, returns passthrough, and the file is
 * deleted without a prompt. With `--` handling, the path IS extracted and
 * validated (blocked by isClaudeConfigFilePath / pathInAllowedWorkingPath).
 */
/**
 * 【做什么】从参数里挑出「位置参数」（即路径），丢掉 flag
 * 【为什么需要】这是路径提取的基础操作，但**不能**简单写成 !arg.startsWith('-')：
 *   POSIX 规定 `--` 之后的所有参数都算位置参数，哪怕它们以 - 开头。
 *   攻击例子：`rm -- -/../.claude/settings.local.json`，naive 过滤会把这个路径丢掉，
 *   于是「没有路径要校验」→ passthrough → 文件被静默删除
 * 【返回】路径参数数组
 */
function filterOutFlags(args: string[]): string[] {
  const result: string[] = []
  let afterDoubleDash = false
  for (const arg of args) {
    if (afterDoubleDash) {
      result.push(arg)
    // 遇到 -- 就翻转开关，之后的所有参数一律当路径（包括以 - 开头的）
    } else if (arg === '--') {
      afterDoubleDash = true
    } else if (!arg?.startsWith('-')) {
      result.push(arg)
    }
  }
  return result
}

// Helper: Parse grep/rg style commands (pattern then paths)
/**
 * 【做什么】解析 grep / rg 这类「模式 + 若干路径」的命令
 * 【为什么需要】它们第一个非 flag 参数是**搜索模式**而不是路径，必须跳过，否则会把模式当路径校验
 * 【入参】args：参数；flagsWithArgs：需要吃掉下一个参数的 flag 集合；defaults：一个路径都没有时的默认值
 * 【返回】路径数组（一个都没有时返回 defaults）
 * 【关键步骤】
 *   ① 同样要处理 --
 *   ② 遇到需要带值的 flag（如 -m 5、-A 3）要连它的值一起跳过（注意 -m=5 这种等号写法不要多跳）
 *   ③ 第一个非 flag 参数当作模式跳过，其余都是路径
 */
function parsePatternCommand(
  args: string[],
  flagsWithArgs: Set<string>,
  defaults: string[] = [],
): string[] {
  const paths: string[] = []
  let patternFound = false
  // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
  // positional regardless of leading `-`. See filterOutFlags() doc comment.
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined || arg === null) continue

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith('-')) {
      const flag = arg.split('=')[0]
      // Pattern flags mark that we've found the pattern
      // 这些 flag 的值是「模式」本身，所以看到它们就等于已经遇到了模式，后面出现的都是路径
      if (flag && ['-e', '--regexp', '-f', '--file'].includes(flag)) {
        patternFound = true
      }
      // Skip next arg if flag needs it
      if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
        i++
      }
      continue
    }

    // First non-flag is pattern, rest are paths
    if (!patternFound) {
      patternFound = true
      continue
    }
    paths.push(arg)
  }

  return paths.length > 0 ? paths : defaults
}

/**
 * Extracts paths from command arguments for different path commands.
 * Each command has specific logic for how it handles paths and flags.
 */
// 本文件的核心表：命令名 → 路径提取函数。
//   Record<PathCommand, ...> 保证每个 PathCommand 都必须有对应实现，漏一个就编译不过
export const PATH_EXTRACTORS: Record<
  PathCommand,
  (args: string[]) => string[]
> = {
  // cd: special case - all args form one path
  // cd 特殊：路径里可能含空格，所以要把所有参数**拼成一个**路径；不带参数时表示回 home 目录
  cd: args => (args.length === 0 ? [homedir()] : [args.join(' ')]),

  // ls: filter flags, default to current dir
  ls: args => {
    const paths = filterOutFlags(args)
    return paths.length > 0 ? paths : ['.']
  },

  // find: collect paths until hitting a real flag, also check path-taking flags
  // 中文补充：find 的参数结构是「若干起始路径 + 一堆判定条件」，
  //   所以收集路径时要一直收到遇到第一个真正的判定 flag 为止
  // SECURITY: `find -- -path` makes `-path` a starting point (not a predicate).
  // GNU find supports `--` to allow search roots starting with `-`. After `--`,
  // we conservatively collect all remaining args as paths to validate. This
  // over-includes predicates like `-name foo`, but find is a read-only op and
  // predicates resolve to paths within cwd (allowed), so no false blocks for
  // legitimate use. The over-inclusion ensures attack paths like
  // `find -- -/../../etc` are caught.
  /**
   * find 的路径提取：收集起始目录，同时把 -newer 这类「带路径值」的 flag 的值也收进来
   * 【安全点】遇到 `--` 之后一律当成路径收集（宁可多收，也不能漏掉 `find -- -/../../etc` 这种攻击路径）。
   *   find 是只读操作，多收几个判定参数只会多校验一次（都在 cwd 内，不会误伤正常用法）
   */
  find: args => {
    const paths: string[] = []
    const pathFlags = new Set([
      '-newer',
      '-anewer',
      '-cnewer',
      '-mnewer',
      '-samefile',
      '-path',
      '-wholename',
      '-ilname',
      '-lname',
      '-ipath',
      '-iwholename',
    ])
    const newerPattern = /^-newer[acmBt][acmtB]$/
    let foundNonGlobalFlag = false
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue

      if (afterDoubleDash) {
        paths.push(arg)
        continue
      }

      if (arg === '--') {
        afterDoubleDash = true
        continue
      }

      // Handle flags
      if (arg.startsWith('-')) {
        // Global options don't stop collection
        // -H/-L/-P 是全局选项（控制符号链接行为），不影响路径收集，直接跳过
        if (['-H', '-L', '-P'].includes(arg)) continue

        // Mark that we've seen a non-global flag
        foundNonGlobalFlag = true

        // Check if this flag takes a path argument
        if (pathFlags.has(arg) || newerPattern.test(arg)) {
          const nextArg = args[i + 1]
          if (nextArg) {
            paths.push(nextArg)
            i++ // Skip the path we just processed
          }
        }
        continue
      }

      // Only collect non-flag arguments before first non-global flag
      if (!foundNonGlobalFlag) {
        paths.push(arg)
      }
    }
    return paths.length > 0 ? paths : ['.']
  },

  // All simple commands: just filter out flags
  mkdir: filterOutFlags,
  touch: filterOutFlags,
  rm: filterOutFlags,
  rmdir: filterOutFlags,
  mv: filterOutFlags,
  cp: filterOutFlags,
  cat: filterOutFlags,
  head: filterOutFlags,
  tail: filterOutFlags,
  sort: filterOutFlags,
  uniq: filterOutFlags,
  wc: filterOutFlags,
  cut: filterOutFlags,
  paste: filterOutFlags,
  column: filterOutFlags,
  file: filterOutFlags,
  stat: filterOutFlags,
  diff: filterOutFlags,
  awk: filterOutFlags,
  strings: filterOutFlags,
  hexdump: filterOutFlags,
  od: filterOutFlags,
  base64: filterOutFlags,
  nl: filterOutFlags,
  sha256sum: filterOutFlags,
  sha1sum: filterOutFlags,
  md5sum: filterOutFlags,

  // tr: special case - skip character sets
  // tr 特殊：`tr SET1 SET2` 的前两个参数是字符集**不是路径**，必须跳过去再取路径
  tr: args => {
    const hasDelete = args.some(
      a =>
        a === '-d' ||
        a === '--delete' ||
        (a.startsWith('-') && a.includes('d')),
    )
    const nonFlags = filterOutFlags(args)
    return nonFlags.slice(hasDelete ? 1 : 2) // Skip SET1 or SET1+SET2
  },

  // grep: pattern then paths, defaults to stdin
  // grep：模式 + 路径。特殊情形：带 -r/-R 且没给路径时，默认搜索当前目录（所以要补 '.'）
  grep: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '--exclude',
      '--include',
      '--exclude-dir',
      '--include-dir',
      '-m',
      '--max-count',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    const paths = parsePatternCommand(args, flags)
    // Special: if -r/-R flag present and no paths, use current dir
    if (
      paths.length === 0 &&
      args.some(a => ['-r', '-R', '--recursive'].includes(a))
    ) {
      return ['.']
    }
    return paths
  },

  // rg: pattern then paths, defaults to current dir
  // rg 与 grep 类似，但没有给路径时默认就是当前目录，所以默认值是 ['.']
  rg: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '-t',
      '--type',
      '-T',
      '--type-not',
      '-g',
      '--glob',
      '-m',
      '--max-count',
      '--max-depth',
      '-r',
      '--replace',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    return parsePatternCommand(args, flags, ['.'])
  },

  // sed: processes files in-place or reads from stdin
  /**
   * sed 的路径提取：第一个非 flag 参数是「脚本」，其后才是文件
   * 【安全点】-f 后面的参数是**脚本文件**，它也会被读取，所以同样要作为路径参与校验
   * 【安全点】同样处理 `--`，防止 `--` 后以 - 开头的路径被漏掉
   */
  sed: args => {
    const paths: string[] = []
    let skipNext = false
    let scriptFound = false
    // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
    // positional regardless of leading `-`. See filterOutFlags() doc comment.
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      if (skipNext) {
        skipNext = false
        continue
      }

      const arg = args[i]
      if (!arg) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      // Handle flags (only before `--`)
      if (!afterDoubleDash && arg.startsWith('-')) {
        // -f flag: next arg is a script file that needs validation
        // -f 表示「从文件读脚本」：这个文件会被 sed 读取，所以要纳入路径校验
        if (['-f', '--file'].includes(arg)) {
          const scriptFile = args[i + 1]
          if (scriptFile) {
            paths.push(scriptFile) // Add script file to paths for validation
            skipNext = true
          }
          scriptFound = true
        }
        // -e flag: next arg is expression, not a file
        else if (['-e', '--expression'].includes(arg)) {
          skipNext = true
          scriptFound = true
        }
        // Combined flags like -ie or -nf
        else if (arg.includes('e') || arg.includes('f')) {
          scriptFound = true
        }
        continue
      }

      // First non-flag is the script (if not already found via -e/-f)
      if (!scriptFound) {
        scriptFound = true
        continue
      }

      // Rest are file paths
      paths.push(arg)
    }

    return paths
  },

  // jq: filter then file paths (similar to grep)
  // The jq command structure is: jq [flags] filter [files...]
  // If no files are provided, jq reads from stdin
  // jq 结构：jq [flags] filter [files...]——第一个非 flag 参数是过滤器，之后才是文件
  jq: args => {
    const paths: string[] = []
    const flagsWithArgs = new Set([
      '-e',
      '--expression',
      '-f',
      '--from-file',
      '--arg',
      '--argjson',
      '--slurpfile',
      '--rawfile',
      '--args',
      '--jsonargs',
      '-L',
      '--library-path',
      '--indent',
      '--tab',
    ])
    let filterFound = false
    // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
    // positional regardless of leading `-`. See filterOutFlags() doc comment.
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === undefined || arg === null) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      if (!afterDoubleDash && arg.startsWith('-')) {
        const flag = arg.split('=')[0]
        // Pattern flags mark that we've found the filter
        if (flag && ['-e', '--expression'].includes(flag)) {
          filterFound = true
        }
        // Skip next arg if flag needs it
        if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
          i++
        }
        continue
      }

      // First non-flag is filter, rest are file paths
      if (!filterFound) {
        filterFound = true
        continue
      }
      paths.push(arg)
    }

    // If no file paths, jq reads from stdin (no paths to validate)
    return paths
  },

  // git: handle subcommands that access arbitrary files outside the repository
  /**
   * git 的路径提取：绝大多数 git 子命令只在仓库内活动，git 自身已有安全模型，不需要额外校验
   * 【唯一例外】git diff --no-index：它专门用来比较**仓库之外**的任意两个文件，
   *   所以必须把那两个路径取出来校验（且要用支持 -- 的 filterOutFlags，不能用 naive 过滤）
   */
  git: args => {
    // git diff --no-index is special - it explicitly compares files outside git's control
    // This flag allows git diff to compare any two files on the filesystem, not just
    // files within the repository, which is why it needs path validation
    if (args.length >= 1 && args[0] === 'diff') {
      if (args.includes('--no-index')) {
        // SECURITY: git diff --no-index accepts `--` before file paths.
        // Use filterOutFlags which handles `--` correctly instead of naive
        // startsWith('-') filtering, to catch paths like `-/../etc/passwd`.
        const filePaths = filterOutFlags(args.slice(1))
        return filePaths.slice(0, 2) // git diff --no-index expects exactly 2 paths
      }
    }
    // Other git commands (add, rm, mv, show, etc.) operate within the repository context
    // and are already constrained by git's own security model, so they don't need
    // additional path validation
    return []
  },
}

// 从表反推命令列表（单一数据源，加命令只需改表）。
//   `as PathCommand[]` 是强制转换：Object.keys 只能得到 string[]，这里需要更窄的类型
const SUPPORTED_PATH_COMMANDS = Object.keys(PATH_EXTRACTORS) as PathCommand[]

// 每个命令的「人话动作描述」，用于拼拒绝文案（如 remove files from / search files in）
const ACTION_VERBS: Record<PathCommand, string> = {
  cd: 'change directories to',
  ls: 'list files in',
  find: 'search files in',
  mkdir: 'create directories in',
  touch: 'create or modify files in',
  rm: 'remove files from',
  rmdir: 'remove directories from',
  mv: 'move files to/from',
  cp: 'copy files to/from',
  cat: 'concatenate files from',
  head: 'read the beginning of files from',
  tail: 'read the end of files from',
  sort: 'sort contents of files from',
  uniq: 'filter duplicate lines from files in',
  wc: 'count lines/words/bytes in files from',
  cut: 'extract columns from files in',
  paste: 'merge files from',
  column: 'format files from',
  tr: 'transform text from files in',
  file: 'examine file types in',
  stat: 'read file stats from',
  diff: 'compare files from',
  awk: 'process text from files in',
  strings: 'extract strings from files in',
  hexdump: 'display hex dump of files from',
  od: 'display octal dump of files from',
  base64: 'encode/decode files from',
  nl: 'number lines in files from',
  grep: 'search for patterns in files from',
  rg: 'search for patterns in files from',
  sed: 'edit files in',
  git: 'access files with git from',
  jq: 'process JSON from files in',
  sha256sum: 'compute SHA-256 checksums for files in',
  sha1sum: 'compute SHA-1 checksums for files in',
  md5sum: 'compute MD5 checksums for files in',
}

// 操作类型表：read（只读）/ write（写）/ create（新建）。
//   这张表决定了路径校验的**严格程度**：写操作要求更高，还会额外建议开启 acceptEdits 模式
export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
  cd: 'read',
  ls: 'read',
  find: 'read',
  mkdir: 'create',
  touch: 'create',
  rm: 'write',
  rmdir: 'write',
  mv: 'write',
  cp: 'write',
  cat: 'read',
  head: 'read',
  tail: 'read',
  sort: 'read',
  uniq: 'read',
  wc: 'read',
  cut: 'read',
  paste: 'read',
  column: 'read',
  tr: 'read',
  file: 'read',
  stat: 'read',
  diff: 'read',
  awk: 'read',
  strings: 'read',
  hexdump: 'read',
  od: 'read',
  base64: 'read',
  nl: 'read',
  grep: 'read',
  rg: 'read',
  sed: 'write',
  git: 'read',
  jq: 'read',
  sha256sum: 'read',
  sha1sum: 'read',
  md5sum: 'read',
}

/**
 * Command-specific validators that run before path validation.
 * Returns true if the command is valid, false if it should be rejected.
 * Used to block commands with flags that could bypass path validation.
 */
// 命令级额外校验（在路径校验**之前**执行）。Partial 表示不必为每个命令都提供
const COMMAND_VALIDATOR: Partial<
  Record<PathCommand, (args: string[]) => boolean>
> = {
  // mv/cp 一律禁止带任何 flag。原因：`--target-directory=PATH` 这类 flag 可以把写入目标藏起来，
  //   路径提取器根本看不到它。与其逐个 flag 去猜，不如「带 flag 就让人来审」
  mv: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
  cp: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
}

/**
 * 【做什么】对单条命令做完整的路径校验
 * 【为什么需要】这是「命令 → 路径 → 是否允许」这条链路的核心实现
 * 【入参】command：命令名；args：参数；cwd；toolPermissionContext；
 *       compoundCommandHasCd：整条复合命令里有没有 cd；operationTypeOverride：覆盖默认操作类型
 * 【返回】deny（命中 deny 规则）/ ask（越界，需确认）/ passthrough（全部通过）
 * 【关键步骤】
 *   ① 取该命令的路径提取器 → 得到路径列表
 *   ② 操作类型：优先用覆盖值，否则查表
 *   ③ 命令级校验（mv/cp 带 flag 直接 ask）
 *   ④ 复合命令里含 cd 且是写操作 → ask（路径解析可能错位，见下面注释）
 *   ⑤ 逐个路径调 validatePath；不允许就组装拒绝文案
 *   ⑥ deny 规则 → deny；其余 → ask（并带上被拦的路径，供上层生成建议）
 */
function validateCommandPaths(
  command: PathCommand,
  args: string[],
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  operationTypeOverride?: FileOperationType,
): PermissionResult {
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)
  const operationType = operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]

  // SECURITY: Check command-specific validators (e.g., to block flags that could bypass path validation)
  // Some commands like mv/cp have flags (--target-directory=PATH) that can bypass path extraction,
  // so we block ALL flags for these commands to ensure security.
  const validator = COMMAND_VALIDATOR[command]
  if (validator && !validator(args)) {
    return {
      behavior: 'ask',
      message: `${command} with flags requires manual approval to ensure path safety. For security, Claude Code cannot automatically validate ${command} commands that use flags, as some flags like --target-directory=PATH can bypass path validation.`,
      decisionReason: {
        type: 'other',
        reason: `${command} command with flags requires manual approval`,
      },
    }
  }

  // SECURITY: Block write operations in compound commands containing 'cd'
  // 中文详解（本目录最典型的绕过场景）：
  //   攻击示例 `cd .claude/ && mv test.txt settings.json`
  //   校验时路径按**原始 cwd** 解析，看起来是 ./test.txt → 没问题；
  //   但 shell 执行时已经 cd 进了 .claude/，实际改的是 .claude/settings.json（Claude Code 的配置文件）。
  //   更彻底的做法是「跟踪每条 cd 之后的 effective cwd」，但要处理 cd ~、cd -、cd ../x、多级 cd、
  //   以及 cd 失败等各种情况，复杂度高、易出错；所以当前选择保守方案：凡复合命令含 cd 且要做写操作，一律询问
  // This prevents bypassing path safety checks via directory changes before operations.
  // Example attack: cd .claude/ && mv test.txt settings.json
  // This would bypass the check for .claude/settings.json because paths are resolved
  // relative to the original CWD, not accounting for the cd's effect.
  //
  // ALTERNATIVE APPROACH: Instead of blocking all writes with cd, we could track the
  // effective CWD through the command chain (e.g., after "cd .claude/", subsequent
  // commands would be validated with CWD=".claude/"). This would be more permissive
  // but requires careful handling of:
  // - Relative paths (cd ../foo)
  // - Special cd targets (cd ~, cd -, cd with no args)
  // - Multiple cd commands in sequence
  // - Error cases where cd target cannot be determined
  // For now, we take the conservative approach of requiring manual approval.
  if (compoundCommandHasCd && operationType !== 'read') {
    return {
      behavior: 'ask',
      message: `Commands that change directories and perform write operations require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with write operation - manual approval required to prevent path resolution bypass',
      },
    }
  }

  for (const path of paths) {
    const { allowed, resolvedPath, decisionReason } = validatePath(
      path,
      cwd,
      toolPermissionContext,
      operationType,
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      // 拒绝文案里要列出「本次会话允许哪些目录」——让用户知道边界在哪，而不是只说「不行」
      const dirListStr = formatDirectoryList(workingDirs)

      // Use security check's custom reason if available (type: 'other' or 'safetyCheck')
      // Otherwise use the standard "was blocked" message
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : `${command} in '${resolvedPath}' was blocked. For security, Claude Code may only ${ACTION_VERBS[command]} the allowed working directories for this session: ${dirListStr}.`

      // 只有命中用户显式配置的 deny 规则才返回 deny（强拒绝，不给商量余地）；
      //   其余情况（比如仅仅是不在允许目录里）返回 ask，让用户有机会追加目录
      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
      }
    }
  }

  // All paths are valid - return passthrough
  return {
    behavior: 'passthrough',
    message: `Path validation passed for ${command} command`,
  }
}

/**
 * 【做什么】工厂函数：为指定命令产出一个「路径检查器」
 * 【为什么需要】命令名与操作类型是固定的，把它们先绑定好，后面只传变化的部分（参数/cwd/上下文）
 *   ≈ Java 里返回一个 Function / BiFunction，属于典型的闭包用法
 * 【返回】检查器函数：(args, cwd, context, compoundCommandHasCd?) => PermissionResult
 * 【关键步骤】
 *   ① 先做常规路径校验
 *   ② 是 deny 就直接返回（**不覆盖**——显式拒绝优先级最高）
 *   ③ 再查危险删除路径（要在 ask 之前查，这样危险路径能给出专门文案，而不是通用的「glob 被拒」文案）
 *   ④ passthrough 直接返回
 *   ⑤ ask 时补建议：读操作建议加 Read 规则；写/新建建议加目录、并建议开启 acceptEdits
 */
export function createPathChecker(
  command: PathCommand,
  operationTypeOverride?: FileOperationType,
) {
  return (
    args: string[],
    cwd: string,
    context: ToolPermissionContext,
    compoundCommandHasCd?: boolean,
  ): PermissionResult => {
    // First check normal path validation (which includes explicit deny rules)
    const result = validateCommandPaths(
      command,
      args,
      cwd,
      context,
      compoundCommandHasCd,
      operationTypeOverride,
    )

    // If explicitly denied, respect that (don't override with dangerous path message)
    // 显式 deny 优先级最高：即便目标是危险路径，也要保持用户自己写的 deny 规则的语义
    if (result.behavior === 'deny') {
      return result
    }

    // Check for dangerous removal paths AFTER explicit deny rules but BEFORE other results
    // This ensures the check runs even if the user has allowlist rules or if glob patterns
    // were rejected, but respects explicit deny rules. Dangerous patterns get a specific
    // error message that overrides generic glob pattern rejection messages.
    if (command === 'rm' || command === 'rmdir') {
      const dangerousPathResult = checkDangerousRemovalPaths(command, args, cwd)
      if (dangerousPathResult.behavior !== 'passthrough') {
        return dangerousPathResult
      }
    }

    // If it's a passthrough, return it directly
    if (result.behavior === 'passthrough') {
      return result
    }

    // If it's an ask decision, add suggestions based on the operation type
    if (result.behavior === 'ask') {
      const operationType =
        operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]
      const suggestions: PermissionUpdate[] = []

      // Only suggest adding directory/rules if we have a blocked path
      // 只有在知道「具体被拦的是哪个路径」时才能给出精准建议（比如建议把它的父目录加进白名单）
      if (result.blockedPath) {
        if (operationType === 'read') {
          // For read operations, suggest a Read rule for the directory (only if it exists)
          const dirPath = getDirectoryForPath(result.blockedPath)
          const suggestion = createReadRuleSuggestion(dirPath, 'session')
          if (suggestion) {
            suggestions.push(suggestion)
          }
        } else {
          // For write/create operations, suggest adding the directory
          suggestions.push({
            type: 'addDirectories',
            directories: [getDirectoryForPath(result.blockedPath)],
            destination: 'session',
          })
        }
      }

      // For write operations, also suggest enabling accept-edits mode
      if (operationType === 'write' || operationType === 'create') {
        suggestions.push({
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        })
      }

      result.suggestions = suggestions
    }

    // Return the decision directly
    return result
  }
}

/**
 * Parses command arguments using shell-quote, converting glob objects to strings.
 * This is necessary because shell-quote parses patterns like *.txt as glob objects,
 * but we need them as strings for path validation.
 */
/**
 * 【做什么】用 shell-quote 把命令切成参数数组
 * 【为什么需要】自己按空格切是错的（引号、转义、glob 都处理不了）
 * 【返回】参数数组；**解析失败返回空数组**（上层会因此 passthrough，宁可不查也不误判为「没路径」）
 * 【关键步骤】
 *   ① tryParseShellCommand 分词，环境变量用 $VAR 形式保留
 *   ② 字符串 token 直接收（含空串，因为 grep '' file 里的空串是合法参数）
 *   ③ glob 对象（如 *.txt）转成字符串再收——否则路径校验会漏掉它们
 */
function parseCommandArguments(cmd: string): string[] {
  const parseResult = tryParseShellCommand(cmd, env => `$${env}`)
  if (!parseResult.success) {
    // Malformed shell syntax, return empty array
    return []
  }
  const parsed = parseResult.tokens
  const extractedArgs: string[] = []

  for (const arg of parsed) {
    if (typeof arg === 'string') {
      // Include empty strings - they're valid arguments (e.g., grep "" /tmp/t)
      extractedArgs.push(arg)
    } else if (
      typeof arg === 'object' &&
      arg !== null &&
      'op' in arg &&
      arg.op === 'glob' &&
      'pattern' in arg
    ) {
      // shell-quote parses glob patterns as objects, but we need them as strings for validation
      extractedArgs.push(String(arg.pattern))
    }
  }

  return extractedArgs
}

/**
 * Validates a single command for path constraints and shell safety.
 *
 * This function:
 * 1. Parses the command arguments
 * 2. Checks if it's a path command (cd, ls, find)
 * 3. Validates for shell injection patterns
 * 4. Validates all paths are within allowed directories
 *
 * @param cmd - The command string to validate
 * @param cwd - Current working directory
 * @param toolPermissionContext - Context containing allowed directories
 * @param compoundCommandHasCd - Whether the full compound command contains a cd
 * @returns PermissionResult - 'passthrough' if not a path command, otherwise validation result
 */
/**
 * 【做什么】校验单条命令的路径约束（从**命令字符串**出发的版本）
 * 【为什么需要】把「剥包装 → 分词 → 是否受管命令 → 路径校验」串成一条完整流程
 * 【返回】不是受管命令 → passthrough；否则返回路径校验结果
 * 【关键步骤】
 *   ① **先剥包装命令**（timeout/nice/nohup/time）：否则 `timeout 10 rm -rf /` 会被当成 timeout 命令而漏检
 *   ② 分词；拿不到参数就 passthrough
 *   ③ 首词不在受管命令表里 → passthrough（别的命令由别的机制负责）
 *   ④ sed 特殊：若能确定它只是只读（sed -n '1,10p'），把操作类型降级成 read
 *   ⑤ 交给路径检查器
 */
function validateSinglePathCommand(
  cmd: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // SECURITY: Strip wrapper commands (timeout, nice, nohup, time) before extracting
  // the base command. Without this, dangerous commands wrapped with these utilities
  // would bypass path validation since the wrapper command (e.g., 'timeout') would
  // be checked instead of the actual command (e.g., 'rm').
  // Example: 'timeout 10 rm -rf /' would otherwise see 'timeout' as the base command.
  // 剥包装是**必须先做**的一步：包装命令（timeout/nice/nohup/time）本身不做任何文件操作，
  //   真正危险的是被它包住的那个命令。不剥就等于给危险命令发了通行证
  const strippedCmd = stripSafeWrappers(cmd)

  // Parse command into arguments, handling quotes and globs
  const extractedArgs = parseCommandArguments(strippedCmd)
  if (extractedArgs.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'Empty command - no paths to validate',
    }
  }

  // Check if this is a path command we need to validate
  const [baseCmd, ...args] = extractedArgs
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `Command '${baseCmd}' is not a path-restricted command`,
    }
  }

  // For read-only sed commands (e.g., sed -n '1,10p' file.txt),
  // validate file paths as read operations instead of write operations.
  // sed is normally classified as 'write' for path validation, but when the
  // command is purely reading (line printing with -n), file args are read-only.
  // sed 默认是 write（因为 -i 会改文件），但 `sed -n '1,10p' file` 其实只读。
  //   这里按实际情况**降级**成 read，避免对纯读取的正常用法过度拦截
  const operationTypeOverride =
    baseCmd === 'sed' && sedCommandIsAllowedByAllowlist(strippedCmd)
      ? ('read' as FileOperationType)
      : undefined

  // Validate all paths are within allowed directories
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

/**
 * Like validateSinglePathCommand but operates on AST-derived argv directly
 * instead of re-parsing the command string with shell-quote. Avoids the
 * shell-quote single-quote backslash bug that causes parseCommandArguments
 * to silently return [] and skip path validation.
 */
/**
 * 【做什么】同上，但直接吃 AST 解析好的 argv，不再重新分词
 * 【为什么需要】shell-quote 有个「单引号内的反斜杠」bug，会让 parseCommandArguments
 *   悄悄返回空数组（**不是**解析失败，所以「失败即保守」的兜底在这里帮不上忙），
 *   结果是路径校验被整段跳过。用 AST 的 argv 可以从根上避开这个坑
 */
function validateSinglePathCommandArgv(
  cmd: SimpleCommand,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  const argv = stripWrappersFromArgv(cmd.argv)
  if (argv.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'Empty command - no paths to validate',
    }
  }
  const [baseCmd, ...args] = argv
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `Command '${baseCmd}' is not a path-restricted command`,
    }
  }
  // sed read-only override: use .text for the allowlist check since
  // sedCommandIsAllowedByAllowlist takes a string. argv is already
  // wrapper-stripped but .text is raw tree-sitter span (includes
  // `timeout 5 ` prefix), so strip here too.
  const operationTypeOverride =
    baseCmd === 'sed' &&
    sedCommandIsAllowedByAllowlist(stripSafeWrappers(cmd.text))
      ? ('read' as FileOperationType)
      : undefined
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

/**
 * 【做什么】校验输出重定向（> / >>）的目标路径
 * 【为什么需要】`echo x > /etc/passwd` 这类命令的参数里**没有**文件路径，
 *   只靠 argv 校验会完全漏掉——写文件这件事藏在重定向符后面
 * 【返回】ask（含 cd 的复合命令 / 目标越界）/ passthrough
 * 【关键步骤】
 *   ① 复合命令含 cd 且存在重定向 → 直接 ask（路径解析可能错位，和上面同一类问题）
 *   ② /dev/null 直接放行（它只是丢弃输出，不写真实文件）
 *   ③ 其余目标按 'create' 操作类型做路径校验
 *   ④ 被拦时：deny 规则 → deny；否则 ask 并建议「把该目录加入白名单」
 */
function validateOutputRedirections(
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // SECURITY: Block output redirections in compound commands containing 'cd'
  // This prevents bypassing path safety checks via directory changes before redirections.
  // Example attack: cd .claude/ && echo "malicious" > settings.json
  // The redirection target would be validated relative to the original CWD, but the
  // actual write happens in the changed directory after 'cd' executes.
  if (compoundCommandHasCd && redirections.length > 0) {
    return {
      behavior: 'ask',
      message: `Commands that change directories and write via output redirection require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass',
      },
    }
  }
  for (const { target } of redirections) {
    // /dev/null is always safe - it discards output
    // /dev/null 是丢弃输出的黑洞，不涉及真实文件写入，没必要拦（否则 `cmd 2>/dev/null` 全都要问）
    if (target === '/dev/null') {
      continue
    }
    const { allowed, resolvedPath, decisionReason } = validatePath(
      target,
      cwd,
      toolPermissionContext,
      'create', // Treat > and >> as create operations
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // Use security check's custom reason if available (type: 'other' or 'safetyCheck')
      // Otherwise use the standard message for deny rules or working directory restrictions
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : decisionReason?.type === 'rule'
            ? `Output redirection to '${resolvedPath}' was blocked by a deny rule.`
            : `Output redirection to '${resolvedPath}' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ${dirListStr}.`

      // If denied by a deny rule, return 'deny' behavior
      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
        suggestions: [
          {
            type: 'addDirectories',
            directories: [getDirectoryForPath(resolvedPath)],
            destination: 'session',
          },
        ],
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No unsafe redirections found',
  }
}

/**
 * Checks path constraints for commands that access the filesystem (cd, ls, find).
 * Also validates output redirections to ensure they're within allowed directories.
 *
 * @returns
 * - 'ask' if any path command or redirection tries to access outside allowed directories
 * - 'passthrough' if no path commands were found or if all are within allowed directories
 */
/**
 * 【做什么】路径约束检查的对外主入口（整条命令级别）
 * 【为什么需要】把「进程替换、重定向、各子命令的路径」三类风险一次性查完
 * 【入参】input：工具入参；cwd；toolPermissionContext；compoundCommandHasCd；
 *       astRedirects / astCommands：可选的 AST 结果（有就优先用，更可靠）
 * 【返回】ask（发现风险）/ passthrough（全部通过，交给权限链的后续环节）
 * 【关键步骤】
 *   ① 进程替换 >(...) / <(...) 可任意执行命令并写文件，一律 ask
 *   ② 取重定向：优先用 AST 结果（避开 shell-quote 的 bug）
 *   ③ 重定向目标含 $VAR 等 shell 展开语法 → 无法静态判定，ask
 *   ④ 校验重定向目标
 *   ⑤ 逐条子命令做路径校验（有 AST 用 argv 版，否则用字符串版）
 */
export function checkPathConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astRedirects?: Redirect[],
  astCommands?: SimpleCommand[],
): PermissionResult {
  // SECURITY: Process substitution >(cmd) can execute commands that write to files
  // without those files appearing as redirect targets. For example:
  //   echo secret > >(tee .git/config)
  // The tee command writes to .git/config but it's not detected as a redirect.
  // Require explicit approval for any command containing process substitution.
  // Skip on AST path — process_substitution is in DANGEROUS_TYPES and
  // already returned too-complex before reaching here.
  // 进程替换的典型攻击：`echo secret > >(tee .git/config)` ——
  //   tee 写的是 .git/config，但它不在重定向目标里，静态分析抓不到，只能整条要求人工确认
  if (!astCommands && />>\s*>\s*\(|>\s*>\s*\(|<\s*\(/.test(input.command)) {
    return {
      behavior: 'ask',
      message:
        'Process substitution (>(...) or <(...)) can execute arbitrary commands and requires manual approval',
      decisionReason: {
        type: 'other',
        reason: 'Process substitution requires manual approval',
      },
    }
  }

  // SECURITY: When AST-derived redirects are available, use them directly
  // instead of re-parsing with shell-quote. shell-quote has a known
  // single-quote backslash bug that silently merges redirect operators into
  // garbled tokens on a successful parse (not a parse failure, so the
  // fail-closed guard doesn't help). The AST already resolved targets
  // correctly and checkSemantics validated them.
  // 有 AST 就用 AST（更准），没有才退回 shell-quote（有已知的引号/反斜杠处理缺陷）
  const { redirections, hasDangerousRedirection } = astRedirects
    ? astRedirectsToOutputRedirections(astRedirects)
    : extractOutputRedirections(input.command)

  // SECURITY: If we found a redirection operator with a target containing shell expansion
  // syntax ($VAR or %VAR%), require manual approval since the target can't be safely validated.
  if (hasDangerousRedirection) {
    return {
      behavior: 'ask',
      message: 'Shell expansion syntax in paths requires manual approval',
      decisionReason: {
        type: 'other',
        reason: 'Shell expansion syntax in paths requires manual approval',
      },
    }
  }
  const redirectionResult = validateOutputRedirections(
    redirections,
    cwd,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  if (redirectionResult.behavior !== 'passthrough') {
    return redirectionResult
  }

  // SECURITY: When AST-derived commands are available, iterate them with
  // pre-parsed argv instead of re-parsing via splitCommand_DEPRECATED + shell-quote.
  // shell-quote has a single-quote backslash bug that causes
  // parseCommandArguments to silently return [] and skip path validation
  // (isDangerousRemovalPath etc). The AST already resolved argv correctly.
  if (astCommands) {
    for (const cmd of astCommands) {
      const result = validateSinglePathCommandArgv(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  } else {
    const commands = splitCommand_DEPRECATED(input.command)
    for (const cmd of commands) {
      const result = validateSinglePathCommand(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  }

  // Always return passthrough to let other permission checks handle the command
  return {
    behavior: 'passthrough',
    message: 'All path commands validated successfully',
  }
}

/**
 * Convert AST-derived Redirect[] to the format expected by
 * validateOutputRedirections. Filters to output-only redirects (excluding
 * fd duplications like 2>&1) and maps operators to '>' | '>>'.
 */
// 把 AST 里的重定向结构翻译成内部格式，同时过滤掉输入重定向和 fd 复制（如 2>&1）
function astRedirectsToOutputRedirections(redirects: Redirect[]): {
  redirections: Array<{ target: string; operator: '>' | '>>' }>
  hasDangerousRedirection: boolean
} {
  const redirections: Array<{ target: string; operator: '>' | '>>' }> = []
  for (const r of redirects) {
    switch (r.op) {
      case '>':
      case '>|':
      case '&>':
        redirections.push({ target: r.target, operator: '>' })
        break
      case '>>':
      case '&>>':
        redirections.push({ target: r.target, operator: '>>' })
        break
      // >& 有两种含义：>&1 是「复制到 1 号 fd」（纯数字，不是文件）；>&file 是「重定向到文件」。
      //   所以只在目标不是纯数字时才当成文件写入来处理
      case '>&':
        // >&N (digits only) is fd duplication (e.g. 2>&1, >&10), not a file
        // write. >&file is the deprecated form of &>file (redirect to file).
        if (!/^\d+$/.test(r.target)) {
          redirections.push({ target: r.target, operator: '>' })
        }
        break
      case '<':
      case '<<':
      case '<&':
      case '<<<':
        // input redirects — skip
        break
    }
  }
  // AST targets are fully resolved (no shell expansion) — checkSemantics
  // already validated them. No dangerous redirections are possible.
  return { redirections, hasDangerousRedirection: false }
}

// 中文导读：下面这一大段解决的是「包装命令」问题。
//   场景：`timeout 10 rm -rf /outside`、`env FOO=1 cp a /outside`、`nice rm /outside`
//   如果只看 argv[0]，看到的分别是 timeout / env / nice，都不是受管命令 → passthrough → 路径完全没校验。
//   所以要把这些「安全包装命令」一层层剥掉，露出真正干活的 rm / cp。
//   注意：剥离逻辑必须与 bashPermissions.ts 里的 stripSafeWrappers 以及 AST 层 checkSemantics 保持一致，
//   否则会出现「语义层认为剥了、路径层认为没剥」的不对称漏洞（文件里的英文注释有详细事故记录）
// ───────────────────────────────────────────────────────────────────────────
// Argv-level safe-wrapper stripping (timeout, nice, stdbuf, env, time, nohup)
//
// This is the CANONICAL stripWrappersFromArgv. bashPermissions.ts still
// exports an older narrower copy (timeout/nice-n-N only) that is DEAD CODE
// — no prod consumer — but CANNOT be removed: bashPermissions.ts is right
// at Bun's feature() DCE complexity threshold, and deleting ~80 lines from
// that module silently breaks feature('BASH_CLASSIFIER') evaluation (drops
// every pendingClassifierCheck spread). Verified in PR #21503 round 3:
// baseline classifier tests 30/30 pass, after deletion 22/30 fail. See
// team memory: bun-feature-dce-cliff.md. Hit 3× in PR #21075 + twice in
// #21503. The expanded version lives here (the only prod consumer) instead.
//
// KEEP IN SYNC with:
//   - SAFE_WRAPPER_PATTERNS in bashPermissions.ts (text-based stripSafeWrappers)
//   - the wrapper-stripping loop in checkSemantics (src/utils/bash/ast.ts ~1860)
// If you add a wrapper in either, add it here too. Asymmetry means
// checkSemantics exposes the wrapped command to semantic checks but path
// validation sees the wrapper name → passthrough → wrapped paths never
// validated (PR #21503 review comment 2907319120).
// ───────────────────────────────────────────────────────────────────────────

// SECURITY: allowlist for timeout flag VALUES (signals are TERM/KILL/9,
// durations are 5/5s/10.5). Rejects $ ( ) ` | ; & and newlines that
// previously matched via [^ \t]+ — `timeout -k$(id) 10 ls` must NOT strip.
// 白名单式的值校验：只认字母数字点加减。
//   目的是挡掉 `timeout -k$(id) 10 ls` 这种把命令替换塞进 flag 值的写法——
//   若用宽松的 [^ \t]+ 去匹配，就会把它当成普通 flag 值放行，进而剥错参数
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * Parse timeout's GNU flags (long + short, fused + space-separated) and
 * return the argv index of the DURATION token, or -1 if flags are unparseable.
 */
/**
 * 【做什么】解析 timeout 的各种 flag 写法，返回「时长参数」所在的下标
 * 【为什么需要】timeout 的 flag 形态极多（长/短、连写/分写、=赋值），要准确定位到时长之后才是真正的命令
 * 【返回】时长参数的下标；遇到不认识的 flag 返回 -1（**失败即保守**：不剥，交给人工确认）
 */
function skipTimeoutFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (
      arg === '--foreground' ||
      arg === '--preserve-status' ||
      arg === '--verbose'
    )
      i++
    else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (arg === '--') {
      i++
      break
    } // end-of-options marker
    // 不认识的长 flag → 返回 -1 表示放弃剥离（宁可不剥，也不能剥错位置）
    else if (arg.startsWith('--')) return -1
    else if (arg === '-v') i++
    else if (
      (arg === '-k' || arg === '-s') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (arg.startsWith('-')) return -1
    else break
  }
  return i
}

/**
 * Parse stdbuf's flags (-i/-o/-e in fused/space-separated/long-= forms).
 * Returns argv index of wrapped COMMAND, or -1 if unparseable or no flags
 * consumed (stdbuf without flags is inert). Mirrors checkSemantics (ast.ts).
 */
// stdbuf 的 flag 解析：-i/-o/-e 三种（连写、分写、--xxx= 形式）都要支持；
//   遇到未知 flag 返回 -1；一个 flag 都没吃到也返回 -1（stdbuf 不带 flag 时没有剥离意义）
function skipStdbufFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (/^-[ioe]$/.test(arg) && a[i + 1]) i += 2
    else if (/^-[ioe]./.test(arg)) i++
    else if (/^--(input|output|error)=/.test(arg)) i++
    else if (arg.startsWith('-'))
      return -1 // unknown flag: fail closed
    else break
  }
  return i > 1 && i < a.length ? i : -1
}

/**
 * Parse env's VAR=val and safe flags (-i/-0/-v/-u NAME). Returns argv index
 * of wrapped COMMAND, or -1 if unparseable/no wrapped cmd. Rejects -S (argv
 * splitter), -C/-P (altwd/altpath). Mirrors checkSemantics (ast.ts).
 */
// env 的解析：VAR=val 形式的赋值要跳过；只支持 -i/-0/-v/-u NAME 这几个安全 flag。
//   **刻意拒绝** -S（会重新切分 argv）、-C/-P（会切换工作目录/路径）——它们会改变后续语义
function skipEnvFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (arg.includes('=') && !arg.startsWith('-')) i++
    else if (arg === '-i' || arg === '-0' || arg === '-v') i++
    else if (arg === '-u' && a[i + 1]) i += 2
    else if (arg.startsWith('-'))
      return -1 // -S/-C/-P/unknown: fail closed
    else break
  }
  return i < a.length ? i : -1
}

/**
 * Argv-level counterpart to stripSafeWrappers (bashPermissions.ts). Strips
 * wrapper commands from AST-derived argv. Env vars are already separated
 * into SimpleCommand.envVars so no env-var stripping here.
 */
/**
 * 【做什么】一层层剥掉包装命令，返回真正干活的命令 argv
 * 【为什么需要】见上方「包装命令」导读：不剥就等于给危险命令开后门
 * 【入参】argv：AST 解析出的参数数组（环境变量已被单独剥离，这里不用管）
 * 【返回】剥掉包装后的 argv；**任何一步拿不准就原样返回**（不剥 → 上层会 passthrough → 走人工确认，安全）
 * 【关键步骤】
 *   ① for(;;) 循环剥离，因为可能是 `time timeout 10 rm` 这种多层包装
 *   ② time / nohup：直接去掉首词（可选地处理 --）
 *   ③ timeout：先跳过 flag 定位时长，再校验时长格式合法（.5 / +5 / inf 这类一律不剥）
 *   ④ nice：支持 -n N、旧式 -N、以及不带参数的 `nice cmd`
 *   ⑤ stdbuf / env：用各自的 flag 解析器定位被包装的命令
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      // SECURITY (PR #21503 round 3): unrecognized duration (`.5`, `+5`,
      // `inf` — strtod formats GNU timeout accepts) → return a unchanged.
      // Safe because checkSemantics (ast.ts) fails CLOSED on the same input
      // and runs first in bashToolHasPermission, so we never reach here.
      // 时长必须是「数字 + 可选单位」这种严格格式；不认识就**不剥**。
      //   这里不剥是安全的：AST 层的 checkSemantics 对同样的输入是「失败即关闭」，会先行拦下
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (a[0] === 'nice') {
      // SECURITY (PR #21503 round 3): mirror checkSemantics — handle bare
      // `nice cmd` and legacy `nice -N cmd`, not just `nice -n N cmd`.
      // Previously only `-n N` was stripped: `nice rm /outside` →
      // baseCmd='nice' → passthrough → /outside never path-validated.
      if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2]))
        a = a.slice(a[3] === '--' ? 4 : 3)
      else if (a[1] && /^-\d+$/.test(a[1])) a = a.slice(a[2] === '--' ? 3 : 2)
      else a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'stdbuf') {
      // SECURITY (PR #21503 round 3): PR-WIDENED. Pre-PR, `stdbuf -o0 -eL rm`
      // was rejected by fragment check (old checkSemantics slice(2) left
      // name='-eL'). Post-PR, checkSemantics strips both flags → name='rm'
      // → passes. But stripWrappersFromArgv returned unchanged →
      // baseCmd='stdbuf' → not in SUPPORTED_PATH_COMMANDS → passthrough.
      const i = skipStdbufFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else if (a[0] === 'env') {
      // Same asymmetry: checkSemantics strips env, we didn't.
      const i = skipEnvFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else {
      return a
    }
  }
}
