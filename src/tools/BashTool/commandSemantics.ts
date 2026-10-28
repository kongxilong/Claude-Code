/**
 * 【一句话定位】解释「命令退出码（exit code）」的真正含义——
 *   因为很多命令用非 0 退出码表示「正常但没结果」，而不是「出错」。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx（命令执行完拿到 exit code 后，判断要不要把结果标红为错误）
 *   下游：utils/bash/commands.js 的 splitCommand_DEPRECATED（拆子命令）
 *   调用链：BashTool.call -> interpretCommandResult(command, exitCode, stdout, stderr) -> { isError, message }
 *
 * 【本文件包含什么】
 *   - CommandSemantic：语义函数的类型（输入退出码与输出，输出是否算错误 + 说明文案）
 *   - DEFAULT_SEMANTIC：默认语义，只有 0 算成功
 *   - COMMAND_SEMANTICS：按命令名登记的语义表（grep / rg / find / diff / test / [ ）
 *   - getCommandSemantic() / extractBaseCommand() / heuristicallyExtractBaseCommand()：取命令名
 *   - interpretCommandResult()：对外主入口
 *
 * 【规则分类逻辑】
 *   对绝大多数命令：exitCode === 0 才成功。但下面这些命令「1」是正常语义：
 *   - grep / rg：0=找到匹配，1=没找到（不是错误！），≥2 才是真出错
 *   - find：0=成功，1=部分目录无权访问，≥2 出错
 *   - diff：0=无差异，1=有差异，≥2 出错
 *   - test / [ ：0=条件为真，1=条件为假，≥2 出错
 *   所以统一规则是：≥2 才算错误；1 要给一句人话解释（如 'No matches found'）
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `type X = (a: A, b: B) => R`：**函数类型别名** ≈ Java 的函数式接口（如 Function/BiFunction）
 *   - `_stdout` 下划线前缀：约定俗成的「这个参数不用」（避免 TS 报未使用变量），Java 里没有对应写法
 *   - `Map<K, V>` ≈ Java HashMap；`map.get(k)` 取不到返回 undefined（不是 null！）
 *   - `A | undefined` 联合类型；`semantic !== undefined ? semantic : DEFAULT_SEMANTIC` 是显式兜底
 *   - 箭头函数 `(a, b) => ({ ... })`：外层括号表示「返回的是一个对象字面量」，不是代码块
 *   - 类型标注在变量名**后面**，Java 在前面
 */
/**
 * Command semantics configuration for interpreting exit codes in different contexts.
 *
 * Many commands use exit codes to convey information other than just success/failure.
 * For example, grep returns 1 when no matches are found, which is not an error condition.
 */

import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'

// 函数类型别名 ≈ Java 的函数式接口：把「一个判定策略」当成值传来传去（策略模式的轻量版）
// 函数类型别名 ≈ Java 的函数式接口：把「一个判定策略」当成值传来传去（策略模式的轻量版）
export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * Default semantic: treat only 0 as success, everything else as error
 */
// 默认语义：只有 0 算成功。_stdout / _stderr 加下划线表示「签名需要但我不用」
// 默认语义：只有 0 算成功。_stdout / _stderr 加下划线表示「签名需要但我不用」
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/**
 * Command-specific semantics
 */
// 语义表 ≈ Java 的 Map<String, BiFunction>。这里用 Map 而不是对象字面量，
//   是因为命令名可能是特殊字符（如 '['），用 Map 键更安全
// 登记顺序不影响结果（Map 是按 key 查的），分组注释只是为了方便阅读
// 语义表 ≈ Java 的 Map<String, BiFunction>。这里用 Map 而不是对象字面量，
//   是因为命令名可能是特殊字符（如 '['），用 Map 键更安全
// 登记顺序不影响结果（Map 是按 key 查的），分组注释只是为了方便阅读
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep: 0=matches found, 1=no matches, 2+=error
  // 中文对照：grep 的三档退出码——0 找到匹配、1 没找到（**不是错误**）、2 及以上才是真出错
  // 这正是本文件存在的意义：不加这层解释，模型会以为「grep 没匹配 = 命令失败」，进而误判任务失败
  [
    'grep',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // ripgrep has same semantics as grep
  [
    'rg',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // find: 0=success, 1=partial success (some dirs inaccessible), 2+=error
  // 中文对照：find 的 1 表示「部分目录没权限访问」，属于降级成功，不算错误
  [
    'find',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message:
        exitCode === 1 ? 'Some directories were inaccessible' : undefined,
    }),
  ],

  // diff: 0=no differences, 1=differences found, 2+=error
  // 中文对照：diff 的 1 恰恰是它最有价值的输出（文件有差异），绝不能当错误处理
  [
    'diff',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Files differ' : undefined,
    }),
  ],

  // test/[: 0=condition true, 1=condition false, 2+=error
  // 中文对照：test 与其别名 [ ——0 条件为真、1 条件为假，都是正常结果
  [
    'test',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // [ is an alias for test
  [
    '[',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // wc, head, tail, cat, etc.: these typically only fail on real errors
  // so we use default semantics
])

/**
 * Get the semantic interpretation for a command
 */
/**
 * 【做什么】按命令名取出对应的语义函数，取不到就用默认语义
 * 【为什么需要】让「特殊命令」和「普通命令」对调用方表现一致（都返回一个语义函数）
 * 【入参】command：整条命令原文（可能含管道）
 * 【返回】CommandSemantic 函数
 * 【关键步骤】
 *   ① 先用启发式方法取「决定退出码的那条命令」
 *   ② Map.get 查表
 *   ③ `!== undefined` 判断是否命中（Map.get 未命中返回 undefined，不能用 || 判断，因为函数永远是真值）
 */
/**
 * 【做什么】按命令名取出对应的语义函数，取不到就用默认语义
 * 【为什么需要】让「特殊命令」和「普通命令」对调用方表现一致（都返回一个语义函数）
 * 【入参】command：整条命令原文（可能含管道）
 * 【返回】CommandSemantic 函数
 * 【关键步骤】
 *   ① 先用启发式方法取「决定退出码的那条命令」
 *   ② Map.get 查表
 *   ③ `!== undefined` 判断是否命中（Map.get 未命中返回 undefined，不能用 || 判断，因为函数永远是真值）
 */
function getCommandSemantic(command: string): CommandSemantic {
  // Extract the base command (first word, handling pipes)
  const baseCommand = heuristicallyExtractBaseCommand(command)
  const semantic = COMMAND_SEMANTICS.get(baseCommand)
  return semantic !== undefined ? semantic : DEFAULT_SEMANTIC
}

/**
 * Extract just the command name (first word) from a single command string.
 */
// 取第一个词作为命令名；`|| ''` 兜底空串（split 至少返回一个元素，理论上不会为空，属防御性写法）
// 取第一个词作为命令名；`|| ''` 兜底空串（split 至少返回一个元素，理论上不会为空，属防御性写法）
function extractBaseCommand(command: string): string {
  return command.trim().split(/\s+/)[0] || ''
}

/**
 * Extract the primary command from a complex command line;
 * May get it super wrong - don't depend on this for security
 */
/**
 * 【做什么】从一条复杂命令里猜出「真正决定退出码的那条命令」
 * 【为什么需要】`a | b | c` 的退出码默认来自最后一段 c（这也是 bash 管道的默认行为），
 *   所以只看第一段会判错
 * 【重要提醒】函数名里的 heuristically（启发式）就是警告：结果可能错得离谱，
 *   **绝不能拿它做安全判断**——它只是为了让「grep 没匹配」这类提示更准
 * 【关键步骤】
 *   ① 拆分命令
 *   ② 取最后一段（因为它决定退出码）
 *   ③ 再从这一段里取命令名
 */
/**
 * 【做什么】从一条复杂命令里猜出「真正决定退出码的那条命令」
 * 【为什么需要】`a | b | c` 的退出码默认来自最后一段 c（这也是 bash 管道的默认行为），
 *   所以只看第一段会判错
 * 【重要提醒】函数名里的 heuristically（启发式）就是警告：结果可能错得离谱，
 *   **绝不能拿它做安全判断**——它只是为了让「grep 没匹配」这类提示更准
 * 【关键步骤】
 *   ① 拆分命令
 *   ② 取最后一段（因为它决定退出码）
 *   ③ 再从这一段里取命令名
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = splitCommand_DEPRECATED(command)

  // Take the last command as that's what determines the exit code
  // 取最后一段；拆分失败（segments 为空）时退回整条命令原文
  // 取最后一段；拆分失败（segments 为空）时退回整条命令原文
  const lastCommand = segments[segments.length - 1] || command

  return extractBaseCommand(lastCommand)
}

/**
 * Interpret command result based on semantic rules
 */
/**
 * 【做什么】把 (命令, 退出码, 输出) 翻译成「是否算错误 + 给人看的说明」
 * 【为什么需要】工具结果要决定：是正常展示、还是标红报错、还是附带一句解释（如 No matches found）
 * 【入参】command / exitCode / stdout / stderr
 * 【返回】{ isError 是否算错误, message 可选说明 }
 * 【关键步骤】
 *   ① 取语义函数
 *   ② 调用它得到结论
 *   ③ 只挑 isError 与 message 两个字段返回（不把内部对象直接透出去，避免耦合）
 */
/**
 * 【做什么】把 (命令, 退出码, 输出) 翻译成「是否算错误 + 给人看的说明」
 * 【为什么需要】工具结果要决定：是正常展示、还是标红报错、还是附带一句解释（如 No matches found）
 * 【入参】command / exitCode / stdout / stderr
 * 【返回】{ isError 是否算错误, message 可选说明 }
 * 【关键步骤】
 *   ① 取语义函数
 *   ② 调用它得到结论
 *   ③ 只挑 isError 与 message 两个字段返回（不把内部对象直接透出去，避免耦合）
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
  const semantic = getCommandSemantic(command)
  const result = semantic(exitCode, stdout, stderr)

  return {
    isError: result.isError,
    message: result.message,
  }
}
