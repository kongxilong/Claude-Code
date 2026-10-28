// 英文注释说明：单独放在一个文件里是为了避免循环依赖。
// 中文补充：所谓循环依赖就是 A import B、B 又 import A；在这里若权限模块要用工具名、
// 而工具本体又要引用权限模块，两者相互引用就会成环，抽成第三个文件即可破环。
/**
 * 【一句话定位】
 *   FileEditTool 的常量集中地：工具名、两条权限通配linic规则、以及一句“文件被意外改过”的错误提示。
 *
 * 【在架构中的位置】
 *   上游调用链：被 FileEditTool.ts（工具注册、权限自授权、报错）与权限系统 import。
 *   下游依赖：无（最底层，不 import 任何东西）。
 *   为什么单独拆文件（对应第 1 行英文注释）：这些常量同时被工具本体、权限模块、UI 引用，
 *   如果放在工具本体里，权限模块反向依赖工具本体就会形成**循环依赖**，所以抽出来切断环。
 *
 * 【本文件包含什么】
 *   - FILE_EDIT_TOOL_NAME：工具名 'Edit'
 *   - CLAUDE_FOLDER_PERMISSION_PATTERN / GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN：.claude/ 目录的权限通配规则
 *   - FILE_UNEXPECTEDLY_MODIFIED_ERROR：文件内容在读后被外部改动时的报错文案
 *
 * 【TS 语法速查】
 *   - `export const X = '...'`：导出常量。≈ Java 的 public static final String。
 *     但 TS 会把它推断成**字面量类型** 'Edit'（而不是宽泛的 string），用它能让联合类型判断更精确。
 *   - 本文件没有任何函数/类，全部是模块级常量：ES Module 里一个文件就是一个单例模块命名空间。
 */
// In its own file to avoid circular dependencies
// 工具名常量 'Edit'。模型在 tool_use 里写的 name 必须与它完全一致。
// 所有地方都引用这个常量，保证“改一处、处处生效”。
export const FILE_EDIT_TOOL_NAME = 'Edit'

// 中文补充（对应上面英文）：这条通配规则用于给用户授予「项目级 .claude/ 目录」的会话级访问权限。
// 为什么需要它：.claude/ 里放的是配置、记忆、命令等，编辑工具经常要改这里的文件，
// 若每次都弹确认会非常烦，所以预置一条授权规则。
// Permission pattern for granting session-level access to the project's .claude/ folder
// 形如 '/.claude/**' 的路径通配规则：** 匹配任意深度的子路径。
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'

// 中文补充（对应上面英文）：同上，但作用于**全局**配置目录 ~/.claude/（用户主目录下，跨项目共享）。
// Permission pattern for granting session-level access to the global ~/.claude/ folder
// '~/.claude/**'：~ 代表用户主目录，与 bash 的习惯一致。
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claude/**'

// “文件在读过之后被意外改过”的统一报错文案。
// 为什么必须有：工具是先 Read 再 Edit 的，如果读之后用户/其它进程又改了文件，
// 此时 old_string 的定位可能已经失效，直接改可能改错内容。
// 所以报错并要求模型重新 Read —— 这正是 Edit 工具要求「改之前必须先读」的原因（见 prompt.ts）。
// 这是一致性保护，相当于 Java 里的乐观锁版本号校验。
export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
