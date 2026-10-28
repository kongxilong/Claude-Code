/**
 * 【一句话定位】命令执行**之前**，扫一遍命令行，如果像是要做破坏性操作
 * （rm -Recurse -Force、git reset --hard、Clear-Disk、DROP TABLE…），
 * 就返回一句「温馨提示」文案，显示在权限确认框里给用户看。
 *
 * 【在架构中的位置】
 *   PowerShellTool.tsx / powershellPermissions.ts（生成权限确认 UI 时）
 *        ──调用──> getDestructiveCommandWarning(command)  ←── 本文件
 *   本文件 ──> 无依赖，纯正则匹配
 *
 *   对照 BashTool：src/tools/BashTool/destructiveCommandWarning.ts 是**逐行同名移植**，
 *   连 git 那几条正则都一模一样（因为 git 命令跨平台相同）。
 *   差异只在文件系统相关的 cmdlet：Unix 是 rm -rf，这里是 Remove-Item -Recurse。
 *
 * 【关键设计：纯提示，不参与安全决策】（对应原文注释）
 *   这个函数**只影响 UI 文案**，不改变 allow/deny/ask 的判定结果。
 *   也就是说它宁可漏报少报也不能让人误以为「没提示=安全」。
 *   真正拦住危险命令的是 powershellPermissions.ts + readOnlyValidation.ts（那些是 fail-closed）。
 *   把「提示层」和「拦截层」分开，是为了让提示文案可以写得激进一点而不用担心误伤。
 *
 * 【本文件包含什么】
 *   DestructivePattern   ：单条规则的类型（正则 + 命中后的文案）。
 *   DESTRUCTIVE_PATTERNS ：规则数组，**按顺序**匹配，命中即返回。
 *   getDestructiveCommandWarning()：对外入口，返回文案或 null。
 *
 * 【TS 语法速查】
 *   type DestructivePattern = { pattern: RegExp; warning: string }
 *     ≈ Java 的 record / 简单 POJO，但 TS 是**结构化鸭子类型**：
 *       只要字段对得上就算这个类型，不需要 implements 或同一个类。
 *   RegExp 字面量 /pattern/i
 *     ≈ Java 的 Pattern.compile(pattern, CASE_INSENSITIVE)，i 就是忽略大小写
 *     （PowerShell 的 cmdlet 名和参数名大小写都不敏感，所以几乎每条都带 i）。
 *   DestructivePattern[]
 *     数组类型写 T[]，等价于 Array<T>；≈ Java 的 List<T> / T[]。
 *   string | null
 *     联合类型 ≈ Java 的 sealed interface 思路：这里的值要么是 string 要么是 null，
 *     编译器强制调用方处理 null 分支（除非显式断言）。这是 TS 消灭 NPE 的核心手段。
 */
/**
 * Detects potentially destructive PowerShell commands and returns a warning
 * string for display in the permission dialog. This is purely informational
 * -- it doesn't affect permission logic or auto-approval.
 */

// 规则类型：一个正则 + 一句话文案。字段极少，用 type 别名就够，
// 不需要 interface/class（TS 里 type 和 interface 多数场景可互换）。
type DestructivePattern = {
  pattern: RegExp
  warning: string
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
// ===== Remove-Item / rm / del / rd 系列（PowerShell 世界的 rm -rf）=====
// 中文注解上方英文注释的要点：
//   ① 不能图省事用 \b 做单词边界 —— `git rm --force` 里的 rm 也会命中，误报。
//      所以改成「锚定到语句开头」：(?:^|[|;&\n({]) 表示前面必须是行首、
//      管道符、分号、& 、换行、{ 或 (，才算一条新命令的开始。
//   ② 中间的 [^|;&\n}]* 表示「同一条语句内」（不许跨过管道/分号/换行），
//      保证 -Recurse 和 -Force 确实属于同一个 Remove-Item。
//   ③ 这里刻意**不把 ) 当语句终止符**：Remove-Item (Join-Path ...) -Recurse -Force
//      里 ) 只是路径分组的闭合，后面的 flag 仍然属于本命令，必须照样告警。
//      而 } 是脚本块结束，} 之后的 flag 属于别的语句，所以要挡住。
//   ④ 写成 4 条规则而不是 1 条万能正则，是为了给不同强度配不同文案：
//      -Recurse + -Force 最狠，-Recurse 次之，-Force 又次之。
  // Remove-Item with -Recurse and/or -Force (and common aliases)
  // Anchored to statement start (^, |, ;, &, newline, {, () so `git rm --force`
  // doesn't match — \b would match `rm` after any word boundary. The `{(`
  // chars catch scriptblock/group bodies: `{ rm -Force ./x }`. The stopper
  // adds only `}` (NOT `)`) — `}` ends a block so flags after it belong to a
  // different statement (`if {rm} else {... -Force}`), but `)` closes a path
  // grouping and flags after it are still this command's flags:
  // `Remove-Item (Join-Path $r "tmp") -Recurse -Force` must still warn.
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Recurse\b[^|;&\n}]*-Force\b/i,
// 顺序很重要：数组是按顺序遍历的，**最具体的规则放最前面**。
// 如果把单独 -Recurse 的规则放第一，`rm -Recurse -Force` 就只会显示弱文案。
    warning: 'Note: may recursively force-remove files',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Force\b[^|;&\n}]*-Recurse\b/i,
    warning: 'Note: may recursively force-remove files',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Recurse\b/i,
    warning: 'Note: may recursively remove files',
  },
  {
    pattern:
      /(?:^|[|;&\n({])\s*(Remove-Item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-Force\b/i,
    warning: 'Note: may force-remove files',
  },

  // Clear-Content on broad paths
// Clear-Content 带上通配符 * 才会批量清文件，所以正则要求出现 *。
  {
    pattern: /\bClear-Content\b[^|;&\n]*\*/i,
    warning: 'Note: may clear content of multiple files',
  },

  // Format-Volume and Clear-Disk
// 磁盘级操作：格式化卷 / 清盘 —— 数据不可恢复，必须提示。
  {
    pattern: /\bFormat-Volume\b/i,
    warning: 'Note: may format a disk volume',
  },
  {
    pattern: /\bClear-Disk\b/i,
    warning: 'Note: may clear a disk',
  },

// ===== git 系列 ===== 这几条与 BashTool/destructiveCommandWarning.ts **完全相同**，
// 因为 git 命令行跨平台一致；看懂 BashTool 那边就等于看懂这里。
  // Git destructive operations (same as BashTool)
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    warning: 'Note: may discard uncommitted changes',
  },
  {
    pattern: /\bgit\s+push\b[^|;&\n]*\s+(--force|--force-with-lease|-f)\b/i,
    warning: 'Note: may overwrite remote history',
  },
  {
    pattern:
// 注意这条 git clean：用 (?![^|;&\n]*(?:-n|--dry-run)) **负向前瞻**排除了演练模式 ——
// `git clean -fd --dry-run` 不会真删，所以不该告警。
// TS/正则里的 (?!) ≈ Java Pattern 的负向 lookahead，语义完全一样。
      /\bgit\s+clean\b(?![^|;&\n]*(?:-[a-zA-Z]*n|--dry-run))[^|;&\n]*-[a-zA-Z]*f/i,
    warning: 'Note: may permanently delete untracked files',
  },
  {
    pattern: /\bgit\s+stash\s+(drop|clear)\b/i,
    warning: 'Note: may permanently remove stashed changes',
  },

// ===== 数据库 DDL ===== 这里匹配的是命令里的 SQL 文本（比如通过 sqlcmd 传的串），
// 属于「尽力而为」的启发式，命中就提示，命中不了也不代表安全。
  // Database operations
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: 'Note: may drop or truncate database objects',
  },

// ===== 整机级操作 ===== 关机 / 重启 / 清空回收站。
  // System operations
  {
    pattern: /\bStop-Computer\b/i,
    warning: 'Note: will shut down the computer',
  },
  {
    pattern: /\bRestart-Computer\b/i,
    warning: 'Note: will restart the computer',
  },
  {
    pattern: /\bClear-RecycleBin\b/i,
    warning: 'Note: permanently deletes recycled files',
  },
]

/**
 * 【中文】对外入口：这条命令像不像破坏性操作？
 *
 * @param command 用户/模型给出的完整命令行
 * @returns 命中则返回一句人类可读的告警文案；没命中返回 null（UI 那边会不显示）
 *
 * 实现取舍：命中第一条就 return（短路），而不是把所有命中文案拼起来 ——
 * 权限框空间有限，一条最相关的提示比一堆提示更有用。
 */
/**
 * Checks if a PowerShell command matches known destructive patterns.
 * Returns a human-readable warning string, or null if no destructive pattern is detected.
 */
export function getDestructiveCommandWarning(command: string): string | null {
// `for (const { pattern, warning } of ...)`：解构赋值 ≈ Java 里手写
// Pattern p = item.pattern; String w = item.warning; 但 TS 一行搞定。
// for...of ≈ Java 的 for-each（增强 for）。
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return warning
    }
  }
  return null
}
