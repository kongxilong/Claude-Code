/**
 * 【一句话定位】
 * LSP 模块共用的两个类型别名：单个 language server 的配置、以及实例的运行状态。
 * 本文件只有类型，没有任何运行时代码（编译后是空文件）。
 *
 * 【在架构中的位置】
 * 被同目录几乎所有文件引用：
 *   config.ts（配置来源）→ LSPServerManager.ts（按配置建实例）→ LSPServerInstance.ts（按配置启动）
 * LspServerState 则在 LSPServerInstance 的状态机、LSPServerManager 的关停判断、
 * manager.ts 的 isLspConnected() 中被使用。
 *
 * 【本文件包含什么】
 * - ScopedLspServerConfig：一个 language server 的完整配置（命令、参数、环境变量、后缀映射…）。
 * - LspServerState：实例的运行状态字符串。
 *
 * 【TS 语法速查】
 * - `export type X = ...`：类型别名，只存在于编译期，编译后完全消失。
 *   ≈ Java 的 interface/typedef（Java 没有类型别名，最接近的是 record 或接口）。
 * - `Record<string, unknown>`：内置工具类型，表示「键是 string、值类型未知的对象」。
 *   ≈ Java 的 `Map<String, Object>`。为什么这里用 unknown 而不是 any：
 *   unknown 强制使用者先做类型检查才能取字段，any 则完全放行——前者安全得多。
 * - `export type LspServerState = string`：
 *   这里刻意退化成 string（而不是 'stopped' | 'running' 这样的字面量联合）。
 *   含义：状态值来自外部数据（配置/日志），无法在编译期穷举，所以放宽成 string。
 *   实际用到的取值只有 LSPServerInstance.ts 里那几个：
 *   'stopped' | 'starting' | 'running' | 'stopping' | 'error'。
 * - `Scoped` 前缀的含义：配置的 key 已被加上插件名前缀（由 getPluginLspServers 处理），
 *   所以不同插件提供的同名 server 不会互相覆盖。
 */
export type ScopedLspServerConfig = Record<string, unknown>
// 中文补充：本文件是「类型契约」层。Java 里对应一个只有 interface 定义的包，编译后不产生行为，
// 但决定了各模块之间的数据形状。改这里会牵动整个 lsp 目录，属于高影响面文件。
export type LspServerState = string
