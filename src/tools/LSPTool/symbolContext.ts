/**
 * ============================================================================
 *  【文件总览】src/tools/LSPTool/symbolContext.ts —— 「光标底下那个词是什么」
 * ============================================================================
 *
 *  【一句话定位】
 *  给定「文件 + 行 + 列」，从文件内容里抠出那个位置上的**标识符**（symbol），
 *  纯粹是为了让终端上显示的这一行更好看：
 *
 *      显示成： operation: "goToDefinition", symbol: "handleClick", in: "src/a.ts"
 *      而不是： operation: "goToDefinition", position: 42:13
 *
 *  也就是说：**这个文件跟 LSP 一点关系都没有**，它只是个纯文本的取词工具，
 *  不联网、不启进程、不调 language server。名字里有 LSP 只是因为它被放在 LSPTool 目录下。
 *
 *  【在架构中的位置】
 *      src/tools/LSPTool/UI.tsx
 *        └─ renderToolUseMessage()          ← 渲染「工具被即将调用」那一行
 *              └─ getSymbolAtPosition()     ← ★ 本文件唯一的函数
 *
 *  LSP 目录的分层（再次强调，别找错地方）：
 *      src/tools/LSPTool/*      ← 薄封装：把能力包装成 Tool（含本文件的 UI 取词）
 *      src/services/lsp/*       ← 真身：LSP 客户端、进程管理、协议编解码
 *
 *  【本文件包含什么】（就 1 个导出函数）
 *   getSymbolAtPosition(filePath, line, character)
 *       → 成功返回 symbol 字符串；任何异常/越界都返回 null（调用方会退化成显示坐标）
 *
 *  【三个关键的「为什么这么写」】
 *   ① 为什么用**同步**文件读（readSync）？
 *      因为调用方 renderToolUseMessage 是 React 的同步渲染函数，
 *      不能 await。这是「函数签名被上游逼成同步」的典型例子。
 *      代价：会阻塞事件循环一小会儿 —— 所以才有下面 ② 的 64KB 上限。
 *
 *   ② 为什么只读前 64KB？
 *      因为 LSP 的 hover/跳转目标通常在文件前段，64KB ≈ 1000 行足够覆盖；
 *      更重要的是防止有人拿它去读一个 500MB 的日志文件把 UI 卡死。
 *      读不满（bytesRead === MAX_READ_BYTES）说明文件还有后续内容，
 *      最后一行可能被截断在半个词中间 → 直接返回 null，宁可不显示也不显示错的。
 *
 *   ③ 为什么全程 try/catch 并返回 null？
 *      因为这只是**锦上添花的显示增强**。文件不存在（ENOENT）、没权限、
 *      编码异常…… 任何一种失败都不该让「调用工具」这个主流程挂掉。
 *      这是「降级而非报错」的设计取舍，在 UI 辅助代码里很常见。
 *
 *  【TS 语法速查（Java 工程师视角）】
 *   - `string | null`        联合类型：要么是 string，要么是 null。
 *                            ≈ Java 的 Optional<String>，但更轻量、没有包装对象。
 *                            注意与 `string | undefined` 的区别：null 是显式空，
 *                            undefined 是「没值」。本函数统一用 null 表示失败。
 *
 *   - `let match: RegExpExecArray | null`
 *                            类型标注在**变量名后面**（Java 在前面：`Pattern x`）。
 *                            这是 TS 最反直觉的地方之一，看代码时要习惯往右看。
 *
 *   - `while ((match = re.exec(s)) !== null)`
 *                            赋值表达式作为条件。JS 里赋值本身有返回值，
 *                            所以能「一边赋值一边判空」。
 *                            ≈ Java 的 `while ((m = re.find()) != null)`，写法其实一样。
 *                            关键是 `g` 标志的正则有**状态**：每次 exec 会从上次的
 *                            lastIndex 继续，所以用循环推进游标。
 *
 *   - `/[\w$'!]+|[+\-*/%&|^~<>=]+/g`
 *                            正则字面量（/.../g，不是字符串）。
 *                            `g` = global，配合 exec 循环可以逐个取出匹配。
 *                            这个 pattern 特意**很宽松**：除了普通标识符，
 *                            还要能吃下 Rust 的生命周期 'a、宏名后的 !、以及纯运算符。
 *
 *   - `match[0]`             正则匹配到的完整文本（Java 里是 m.group(0)）。
 *   - `match.index`          匹配起始下标（Java 里是 m.start()）。
 *
 *   - `catch { ... }`        可选绑定（optional catch binding，ES2019）。
 *                            不需要用这个异常对象时，可以省掉 `(error)`。
 *
 *   - `error instanceof Error`
 *                            ≈ Java 的 `error instanceof Error`。
 *                            但注意：JS 里 throw 的可以是任意值（字符串、数字都行），
 *                            所以先 instanceof 判断再取 .message 是防御性写法。
 *
 *   - `buffer.toString('utf-8', 0, bytesRead)`
 *                            Buffer → string，只取前 bytesRead 个字节。
 *                            为什么要传 bytesRead？因为 buffer 是按 64KB **预分配**的，
 *                            实际可能只读到 300 字节，后面全是未初始化的残留内容。
 *                            ≈ Java 的 new String(b, 0, n, UTF_8)。
 *
 *   - `fs.readSync(...)`     同步文件读。一般业务代码应避免（阻塞线程），
 *                            这里是「同步渲染函数」约束下的例外，代码里也专门加了
 *                            eslint-disable 注释说明原因。
 */

import { logForDebugging } from '../../utils/debug.js'
import { truncate } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { expandPath } from '../../utils/path.js'

const MAX_READ_BYTES = 64 * 1024

/**
 * Extracts the symbol/word at a specific position in a file.
 * Used to show context in tool use messages.
 *
 * @param filePath - The file path (absolute or relative)
 * @param line - 0-indexed line number
 * @param character - 0-indexed character position on the line
 *
 * Note: This uses synchronous file I/O because it is called from
 * renderToolUseMessage (a synchronous React render function). The read is
 * wrapped in try/catch so ENOENT and other errors fall back gracefully.
 * @returns The symbol at that position, or null if extraction fails
 */
/**
 * 【中文补充】取出「文件里第 line 行第 character 列」位置上那个标识符。
 *
 * 为什么需要它：终端里那一行「LSP(operation: "hover", position: 42:13)」对人来说毫无信息量，
 * 而换成 symbol: "handleClick" 用户一眼就知道模型在看什么。这是纯 UI 增强。
 *
 * @param filePath   文件绝对路径或相对路径（相对路径会先 expandPath 展开）
 * @param line       **0-based** 行号（注意！与 LSPTool 入参的 1-based 不同，
 *                   调用方 UI.tsx 已经做过 -1 换算）
 * @param character  **0-based** 列号（同上）
 * @returns 该位置上的 symbol（已截断到最多 30 字符）；
 *          文件读不到 / 越界 / 该位置落在空白上 / 任何异常 → 一律返回 null
 *
 * 关键步骤：
 *   ① expandPath 把相对路径补全成绝对路径（否则 readSync 会按进程 cwd 找，容易找错）
 *   ② 只读前 64KB → 拆成行数组 → 越界直接 null
 *   ③ 用正则逐个扫这一行的「词」，看 character 落在哪个词的 [start, end) 区间里
 *   ④ 命中就 truncate 到 30 字符返回；扫完没命中返回 null
 */
export function getSymbolAtPosition(
  filePath: string,
  line: number,
  character: number,
): string | null {
  try {
    const fs = getFsImplementation()
    const absolutePath = expandPath(filePath)

    // Read only the first 64KB instead of the whole file. Most LSP hover/goto
    // targets are near recent edits; 64KB covers ~1000 lines of typical code.
    // If the target line is past this window we fall back to null (the UI
    // already handles that by showing `position: line:char`).
    // eslint-disable-next-line custom-rules/no-sync-fs -- called from sync React render (renderToolUseMessage)
    const { buffer, bytesRead } = fs.readSync(absolutePath, {
      length: MAX_READ_BYTES,
    })
    const content = buffer.toString('utf-8', 0, bytesRead)
    const lines = content.split('\n')

    // 【中文补充】越界保护：行号负数、或超出已读到的行数 → 直接放弃。
    // 注意这里比较的是 lines.length（64KB 窗口内的行数），不是文件真实总行数。
    if (line < 0 || line >= lines.length) {
      return null
    }
    // If we filled the full buffer the file continues past our window,
    // so the last split element may be truncated mid-line.
    if (bytesRead === MAX_READ_BYTES && line === lines.length - 1) {
      return null
    }

    // 【中文补充】`!lineContent` 这一句同时挡住了两种情况：
    //   - 这一行是空行（split 出来是 ''，JS 里空串是 falsy）
    //   - 数组越界拿到 undefined（TS 里 lines[line] 的类型其实不保证有值）
    // 列号越界同理：可能用户给的位置在这一行的末尾之后（比如点到了行尾空白处）。
    const lineContent = lines[line]
    if (!lineContent || character < 0 || character >= lineContent.length) {
      return null
    }

    // Extract the word/symbol at the character position
    // Pattern matches:
    // - Standard identifiers: alphanumeric + underscore + dollar
    // - Rust lifetimes: 'a, 'static
    // - Rust macros: macro_name!
    // - Operators and special symbols: +, -, *, etc.
    // This is more inclusive to handle various programming languages
    const symbolPattern = /[\w$'!]+|[+\-*/%&|^~<>=]+/g
    let match: RegExpExecArray | null

    while ((match = symbolPattern.exec(lineContent)) !== null) {
      const start = match.index
      const end = start + match[0].length

      // Check if the character position falls within this match
      // 【中文补充】判断列号是否落在这个 token 的 [start, end) 半开区间内。
      // 用半开区间是标准做法：左闭右开保证相邻 token 不会重复命中也不会漏。
      // 命中即返回 —— 一个位置上只可能有一个 token，所以不用继续扫。
      if (character >= start && character < end) {
        const symbol = match[0]
        // Limit length to 30 characters to avoid overly long symbols
        // 【中文补充】截断到 30 字符：防止某些语言（比如 minified JS 或超长泛型签名）
        // 生成一个 500 字符的「标识符」把终端那一行撑爆。
        return truncate(symbol, 30)
      }
    }

    return null
  } catch (error) {
    // Log unexpected errors for debugging (permission issues, encoding problems, etc.)
    // Use logForDebugging since this is a display enhancement, not a critical error
    if (error instanceof Error) {
      logForDebugging(
        `Symbol extraction failed for ${filePath}:${line}:${character}: ${error.message}`,
        { level: 'warn' },
      )
    }
    // Still return null for graceful fallback to position display
    return null
  }
}
