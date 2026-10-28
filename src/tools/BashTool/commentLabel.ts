/**
 * 【一句话定位】从 bash 命令的**首行**提取 # 注释文本，作为这条命令的「人类可读短标签」。
 *
 * 【在架构中的位置】
 *   上游：BashTool/UI.tsx、BashToolResultMessage.tsx、以及消息渲染层（要给用户显示这条命令在干嘛）
 *   下游：无
 *   调用链：UI 渲染 -> extractBashCommentLabel(command) -> 显示在折叠标题 / ⎿ 提示行
 *
 * 【本文件包含什么】
 *   - extractBashCommentLabel(command)：唯一导出函数，取首行注释文本，取不到返回 undefined
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `string | undefined`：联合类型 ≈ Java 的 sealed interface / Optional 的底层形态，
 *     表示「要么是字符串，要么是 undefined」，编译期强制调用方处理 undefined（除非用 ! 或 ?? 绕过）
 *   - `|| undefined`：把假值（这里是空串 ''）归一成 undefined，是 TS 常见收尾写法
 *   - 正则字面量 `/^#+\s*/` ≈ Java 的 Pattern.compile(...)，\s 表示空白字符
 *   - 类型标注在变量名**后面**（`command: string`），Java 在前面
 */
/**
 * If the first line of a bash command is a `# comment` (not a `#!` shebang),
 * return the comment text stripped of the `#` prefix. Otherwise undefined.
 *
 * Under fullscreen mode this is the non-verbose tool-use label AND the
 * collapse-group ⎿ hint — it's what Claude wrote for the human to read.
 */
/**
 * 【做什么】取 bash 命令第一行的 # 注释正文（去掉 # 及其后的空白），当作这条命令的短标签
 * 【为什么需要】模型写 bash 时习惯在首行写 # 说明意图；UI 拿它当折叠标题/提示行，
 *   比把整条命令原样丢给用户友好得多。这是「约定优于配置」：不新增字段，注释本身就是标签
 * 【入参】command：完整 bash 命令原文（可能多行）
 * 【返回】注释文本；首行不是注释（或是 #! shebang）则返回 undefined
 * 【关键步骤】
 *   ① indexOf('\n') 找第一个换行；-1 表示整条命令只有一行，那就整体 trim
 *   ② trim() 去掉首尾空白，避免缩进导致 startsWith('#') 误判
 *   ③ 两道门槛：必须以 # 开头，且不能以 #! 开头（#! 是 shebang 解释器声明，不是给人看的注释）
 *   ④ 正则去掉开头的若干个 # 与随后的空白
 *   ⑤ 去 # 后若成空串（命令就是一个孤零零的 #），用 || 归一成 undefined
 */
/**
 * 【做什么】取 bash 命令第一行的 # 注释正文（去掉 # 及其后的空白），当作这条命令的短标签
 * 【为什么需要】模型写 bash 时习惯在首行写 # 说明意图；UI 拿它当折叠标题/提示行，
 *   比把整条命令原样丢给用户友好得多。这是「约定优于配置」：不新增字段，注释本身就是标签
 * 【入参】command：完整 bash 命令原文（可能多行）
 * 【返回】注释文本；首行不是注释（或是 #! shebang）则返回 undefined
 * 【关键步骤】
 *   ① indexOf('\n') 找第一个换行；-1 表示整条命令只有一行，那就整体 trim
 *   ② trim() 去掉首尾空白，避免缩进导致 startsWith('#') 误判
 *   ③ 两道门槛：必须以 # 开头，且不能以 #! 开头（#! 是 shebang 解释器声明，不是给人看的注释）
 *   ④ 正则去掉开头的若干个 # 与随后的空白
 *   ⑤ 去 # 后若成空串（命令就是一个孤零零的 #），用 || 归一成 undefined
 */
export function extractBashCommentLabel(command: string): string | undefined {
  // indexOf 找不到返回 -1（和 Java 一样）；-1 表示单行命令，直接整体作为 firstLine
  // indexOf 找不到返回 -1（和 Java 一样）；-1 表示单行命令，直接整体作为 firstLine
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  // 两个排斥条件用 || 串起来：不是 # 开头 → 不是注释；是 #! 开头 → 是 shebang，也不能当标签
  // 提前 return 的写法 ≈ Java 的卫语句（guard clause），避免嵌套 if
  // 两个排斥条件用 || 串起来：不是 # 开头 → 不是注释；是 #! 开头 → 是 shebang，也不能当标签
  // 提前 return 的写法 ≈ Java 的卫语句（guard clause），避免嵌套 if
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  // /^#+\s*/ 逐段读：^ 锚定行首、#+ 一个或多个 #、\s* 零个或多个空白，整体替换成空串
  // 末尾 `|| undefined`：把空串也归一成 undefined，让调用方只写 if (label) 就够，
  //   不必再单独处理 ''（这正是 || 与 ?? 的区别所在——这里就是要让 '' 被换掉）
  // /^#+\s*/ 逐段读：^ 锚定行首、#+ 一个或多个 #、\s* 零个或多个空白，整体替换成空串
  // 末尾 `|| undefined`：把空串也归一成 undefined，让调用方只写 if (label) 就够，
  //   不必再单独处理 ''（这正是 || 与 ?? 的区别所在——这里就是要让 '' 被换掉）
  return firstLine.replace(/^#+\s*/, '') || undefined
}
