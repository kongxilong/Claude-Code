/**
 * 【一句话定位】解释命令**退出码（exit code）**的含义：同样是返回非 0，
 * grep 的 1 表示「没匹配到」（正常），robocopy 的 1 表示「成功复制了文件」（也是正常）。
 * 本模块负责把「非 0」翻译成「到底算不算出错」。
 *
 * 【在架构中的位置】
 *   PowerShellTool.tsx（命令跑完后拿到 exitCode/stdout/stderr）
 *        ──调用──> interpretCommandResult(command, exitCode, stdout, stderr)  ←── 本文件
 *        └──> 返回 { isError, message } → 决定要不要抛错给模型、以及给用户看什么文案
 *   本文件 ──> 无外部依赖，纯函数模块（最容易读懂的一个文件，建议从这里入手）
 *
 *   对照 BashTool：src/tools/BashTool/bashCommandHelpers.ts 是同职责的 Unix 版
 *   （那里要处理 grep/ diff / robocopy 的 Unix 表亲）。
 *   两者概念完全一一对应，差异只在「哪些外部 exe 需要特殊照顾」。
 *
 * 【为什么需要它】（对应下方英文注释）
 *   PowerShell **原生 cmdlet** 不用退出码报错（用 $? / terminating error），
 *   但从 PowerShell 里调用的**外部 exe**（Git for Windows 装的 grep.exe、
 *   Windows 自带的 findstr.exe / robocopy.exe）仍用退出码，而且语义各不相同。
 *   若一律「非 0 即报错」，robocopy 明明复制成功也会被显示成失败 ——
 *   这是 Windows CI 里最经典的假失败。
 *
 * 【本文件包含什么】
 *   CommandSemantic        ：语义函数的类型（入参退出码+输出，出参是否错误+文案）。
 *   DEFAULT_SEMANTIC       ：兜底默认语义，非 0 即错。
 *   GREP_SEMANTIC          ：0=有匹配，1=无匹配，2+=真错误。
 *   COMMAND_SEMANTICS      ：命令名 → 语义函数 的查表 Map。
 *   extractBaseCommand()   ：从「一段 pipeline」里剥出裸命令名。
 *   heuristicallyExtractBaseCommand()：整条命令行取最后一段再剥。
 *   interpretCommandResult()：对外唯一入口。
 *
 * 【TS 语法速查】
 *   export type CommandSemantic = (a: number, b: string) => {...}
 *     ≈ Java 的函数式接口 / java.util.function.BiFunction 的类型别名：
 *        type CommandSemantic = ... 就是给一个函数签名起名字。
 *     Java 没有一等函数类型，得写成 interface CommandSemantic { Result apply(...); }
 *   (exitCode, _stdout, _stderr) => ({ ... })
 *     箭头函数 ≈ lambda。注意 => 后直接跟 ({ }) 是**返回对象字面量**的简写，
 *     必须套一层小括号，否则 {...} 会被当成函数体。
 *     前缀下划线 _stdout 只是「我没用到这个参数」的命名约定
 *     （避免 lint 报未使用变量），Java 里没有这种约定。
 *   Map<string, CommandSemantic>
 *     ≈ Java 的 HashMap<String, CommandSemantic>；.get(k) 查不到返回 undefined
 *     （Java 返回 null —— 这是第二个容易踩的坑）。
 *   message?: string
 *     问号表示**可选属性**，可能不存在（≈ Java 的 @Nullable，
 *     但读的时候编译器强制你先判空，"十亿美元的错误"被类型系统挡住了）。
 */
/**
 * Command semantics configuration for interpreting exit codes in PowerShell.
 *
 * PowerShell-native cmdlets do NOT need exit-code semantics:
 *   - Select-String (grep equivalent) exits 0 on no-match (returns $null)
 *   - Compare-Object (diff equivalent) exits 0 regardless
 *   - Test-Path exits 0 regardless (returns bool via pipeline)
 * Native cmdlets signal failure via terminating errors ($?), not exit codes.
 *
 * However, EXTERNAL executables invoked from PowerShell DO set $LASTEXITCODE,
 * and many use non-zero codes to convey information rather than failure:
 *   - grep.exe / rg.exe (Git for Windows, scoop, etc.): 1 = no match
 *   - findstr.exe (Windows native): 1 = no match
 *   - robocopy.exe (Windows native): 0-7 = success, 8+ = error (notorious!)
 *
 * Without this module, PowerShellTool throws ShellError on any non-zero exit,
 * so `robocopy` reporting "files copied successfully" (exit 1) shows as an error.
 */

// TS 语法：`type X = (参数) => 返回值` 是**类型别名**，给一个函数签名起名字。
// ≈ Java：@FunctionalInterface interface CommandSemantic { Result apply(int,String,String); }
// 好处是下面一堆 semantic 常量可以复用这一个签名声明。
export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * 【中文】兜底语义：查表查不到时用它。_rule of thumb_：非 0 即出错。
 *
 * 为什么存在：宁可把「看不懂的退出码」判成错误让用户看一眼，
 * 也不要悄悄吞掉一个真实失败（fail-closed 思路）。
 *
 * @param exitCode 进程退出码
 * @returns isError=是否算失败；message=给用户看的文案（成功时不给文案）
 */
/**
 * Default semantic: treat only 0 as success, everything else as error
 */
// 两个下划线参数 _stdout/_stderr：默认语义只看退出码，用不到输出，
// 加下划线前缀是社区约定，告诉读代码的人（和 linter）「故意不用」。
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/**
 * 【中文】grep / ripgrep / findstr 语义：退出码是三态而不是布尔。
 *   0 = 找到匹配（成功）
 *   1 = 没找到（**不算错误**，只是空结果 —— 这是最关键的差别）
 *   2+ = 真的出错（正则写错、文件读不了等）
 *
 * 为什么重要：模型经常用 grep 找东西，找不到是正常结果。
 * 若把 1 当错误，模型会以为命令崩了，从而瞎改命令重试。
 */
/**
 * grep / ripgrep: 0 = matches found, 1 = no matches, 2+ = error
 */
const GREP_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? 'No matches found' : undefined,
})

/**
 * 【中文】命令名 → 语义函数 的注册表（仅收录**外部可执行程序**）。
 *
 * 两条收录纪律：
 *   ① key 一律小写、不带 .exe 后缀（匹配前会归一化命令名）。
 *   ② 只收语义明确的。刻意**不收** diff/fc/find，因为 Windows 上
 *      同名命令可能解析到 PowerShell 别名（Compare-Object / Format-Custom）
 *      或 Unix 移植版（Git for Windows 的 diff.exe / find.exe），
 *      两者退出码含义相反，无法可靠解释 —— 宁可退回默认语义。
 *
 * TS：new Map([...]) ≈ Java new HashMap<>(Map.of(...))，保持插入顺序。
 */
/**
 * Command-specific semantics for external executables.
 * Keys are lowercase command names WITHOUT .exe suffix.
 *
 * Deliberately omitted:
 *   - 'diff': Ambiguous. Windows PowerShell 5.1 aliases `diff` → Compare-Object
 *     (exit 0 on differ), but PS Core / Git for Windows may resolve to diff.exe
 *     (exit 1 on differ). Cannot reliably interpret.
 *   - 'fc': Ambiguous. PowerShell aliases `fc` → Format-Custom (a native cmdlet),
 *     but `fc.exe` is the Windows file compare utility (exit 1 = files differ).
 *     Same aliasing problem as `diff`.
 *   - 'find': Ambiguous. Windows find.exe (text search) vs Unix find.exe
 *     (file search via Git for Windows) have different semantics.
 *   - 'test', '[': Not PowerShell constructs.
 *   - 'select-string', 'compare-object', 'test-path': Native cmdlets exit 0.
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
// 注意多个 key 可以指向同一个语义函数；查表只是 O(1) 的字典查找，
// 加一个别名（如 findstr 复用 GREP_SEMANTIC）几乎零成本。
  // External grep/ripgrep (Git for Windows, scoop, choco)
  ['grep', GREP_SEMANTIC],
  ['rg', GREP_SEMANTIC],

  // findstr.exe: Windows native text search
  // 0 = match found, 1 = no match, 2 = error
  ['findstr', GREP_SEMANTIC],

  // robocopy.exe: Windows native robust file copy
  // Exit codes are a BITFIELD — 0-7 are success, 8+ indicates at least one failure:
  //   0 = no files copied, no mismatch, no failures (already in sync)
  //   1 = files copied successfully
  //   2 = extra files/dirs detected (no copy)
  //   4 = mismatched files/dirs detected
  //   8 = some files/dirs could not be copied (copy errors)
  //  16 = serious error (robocopy did not copy any files)
  // This is the single most common "CI failed but nothing's wrong" Windows gotcha.
  [
    'robocopy',
// robocopy 的退出码是**位域（bitfield）**，不是枚举！所以下面要用位运算判位。
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 8,
      message:
        exitCode === 0
          ? 'No files copied (already in sync)'
          : exitCode >= 1 && exitCode < 8
// `exitCode & 1`：按位与，取最低位。≈ Java 的 (exitCode & 1)。
// 0-7 都算成功：1(复制了文件)/2(有多余文件)/4(有不一致) 可以任意组合，
// 所以不能写 === 判断，只能「>= 8 才失败」。这是 robocopy 独有的坑。
            ? exitCode & 1
              ? 'Files copied successfully'
              : 'Robocopy completed (no errors)'
            : undefined,
    }),
  ],
])

/**
 * 【中文】从**单个 pipeline 片段**里剥出裸命令名。
 *   例：& "C:\\bin\\grep.exe" -n foo  →  grep
 *
 * 为什么要这么麻烦：PowerShell 里调用命令的写法花样很多 ——
 *   & "路径含空格的命令"（调用运算符 &）、. "./script.ps1"（点源运算符）
 *   带盘符的全路径、带 .exe 后缀、大小写任意组合。
 * 不归一化就查不到 Map，从而退化到默认语义（假失败）。
 *
 * @param segment 单段命令文本（已经按 ; 或 | 切过）
 * @returns 小写、无路径、无后缀的命令名
 *
 * 步骤：① 去掉开头的 & / . 调用运算符
 *      ② 取第一个 token（后面全是参数）
 *      ③ 去掉可能的引号
 *      ④ 去掉路径，只留文件名（basename）
 *      ⑤ 转小写并去掉 .exe 后缀
 */
/**
 * Extract the command name from a single pipeline segment.
 * Strips leading `&` / `.` call operators and `.exe` suffix, lowercases.
 */
function extractBaseCommand(segment: string): string {
  // Strip PowerShell call operators: & "cmd", . "cmd"
  // (& and . at segment start followed by whitespace invoke the next token)
  const stripped = segment.trim().replace(/^[&.]\s+/, '')
// `|| ''`：split 结果为空数组时给个兜底空串。
// 这里用 || 而不是 ?? 是因为空串也走兜底效果一样；
// 但要记住 ?? 只把 null/undefined 替换掉，0 和 '' 会保留（与 || 的关键区别）。
  const firstToken = stripped.split(/\s+/)[0] || ''
  // Strip surrounding quotes if command was invoked as & "grep.exe"
  const unquoted = firstToken.replace(/^["']|["']$/g, '')
  // Strip path: C:\bin\grep.exe → grep.exe, .\rg.exe → rg.exe
  const basename = unquoted.split(/[\\/]/).pop() || unquoted
  // Strip .exe suffix (Windows is case-insensitive)
  return basename.toLowerCase().replace(/\.exe$/, '')
}

/**
 * 【中文】从**整条命令行**里取出决定退出码的那个命令。
 *
 * 为什么取**最后一段** pipeline：PowerShell 里 `$LASTEXITCODE` 由管道里
 * 最后一个外部程序决定（`a.exe | b.exe` 的退出码来自 b.exe）。
 *
 * ⚠ 安全边界：这里是按 ; 和 | 做**启发式切分**，遇到引号里有竖线、
 * 复杂脚本块都会切错。所以**绝不能**拿它做安全判定，只能做退出码解释 ——
 * 切错顶多退回默认语义（把结果判成错误，保守但无害）。
 * 这个「启发式只用于降级体验、不用于安全」的分界线是本项目反复出现的模式。
 */
/**
 * Extract the primary command from a PowerShell command line.
 * Takes the LAST pipeline segment since that determines the exit code.
 *
 * Heuristic split on `;` and `|` — may get it wrong for quoted strings or
 * complex constructs. Do NOT depend on this for security; it's only used
 * for exit-code interpretation (false negatives just fall back to default).
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = command.split(/[;|]/).filter(s => s.trim())
// segments[segments.length - 1] 取最后一段；空串兜底整条命令。
// TS 里也可以写 segments.at(-1)（-1 表示倒数第一个），可读性更好。
  const last = segments[segments.length - 1] || command
  return extractBaseCommand(last)
}

/**
 * 【中文】本模块对外的唯一入口：这条命令的结果到底算不算失败？
 *
 * @param command 原始命令行文本（用于识别是哪个 exe）
 * @param exitCode 进程退出码
 * @param stdout / stderr 标准输出/错误输出（个别语义可能据此细化判断）
 * @returns { isError, message? } —— isError 决定是否抛 ShellError；
 *          message 是给用户看的解释文案（成功场景也可能有，如 robocopy）
 *
 * 步骤：① 从命令里识别基础命令名
 *      ② 查 COMMAND_SEMANTICS 表，查不到就用 DEFAULT_SEMANTIC
 *      ③ 把退出码交给该语义函数裁决
 */
/**
 * Interpret command result based on semantic rules
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): {
  isError: boolean
  message?: string
} {
  const baseCommand = heuristicallyExtractBaseCommand(command)
// `??`（空值合并运算符）：只在左侧是 null/undefined 时才取右侧默认值。
// ≈ Java：Optional.ofNullable(x).orElse(default)；
// 千万别等价于 || —— `0 ?? x` 得到 0，而 `0 || x` 会得到 x（0 是 falsy）。
  const semantic = COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC
  return semantic(exitCode, stdout, stderr)
}
