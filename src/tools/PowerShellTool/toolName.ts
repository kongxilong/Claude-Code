/**
 * 【一句话定位】PowerShell 工具的名字常量 'PowerShell'，全仓库唯一定源。
 *
 * 【在架构中的位置】
 *   上层（Tool 注册 / 权限 UI / 各校验模块 / prompt.ts）
 *        ──import──> 本文件(POWERSHELL_TOOL_NAME)   ← 依赖图的最底层叶子，不依赖任何人
 *   本文件 ──> 无（零 import）
 *
 *   对照 BashTool：src/tools/BashTool/toolName.ts 导出 BASH_TOOL_NAME = 'Bash'，
 *   作用一模一样。两个工具整体的结构是平行移植的：
 *     BashTool   = Unix/macOS 的 bash 版本
 *     本目录     = Windows 的 PowerShell 版本
 *   凡是 BashTool 里见过的概念（toolName / prompt / UI / pathValidation /
 *   readOnlyValidation / permissions / security / modeValidation），
 *   这里都有一个同名 sibling 文件，可以拿 BashTool 的知识直接迁移理解。
 *
 * 【为什么这么小一个常量要单开一个文件】（对应首行英文注释）
 *   prompt.ts 要用工具名去拼系统提示词，而 prompt.ts 又被工具主体 import。
 *   如果常量定义在工具主体里，就形成环：
 *        工具主体 → prompt.ts → 工具主体
 *   ≈ Java 里两个类互相 static 引用，轻则拿到未初始化的半成品值，
 *     重则初始化死锁。抽到一个"谁都不依赖"的叶子文件就能断环，
 *   这是 TS/ESM 项目里最常见的解循环依赖手法。
 *
 * 【本文件包含什么】
 *   POWERSHELL_TOOL_NAME：字符串常量 'PowerShell'。模型发起 tool_use 时
 *   name 字段就是它，也是 permission 规则里匹配工具名的键。
 *
 * 【TS 语法速查】
 *   export const X = 'PowerShell' as const
 *     ≈ Java: public static final String X = "PowerShell";
 *     as const 是重点：它把类型缩窄成**字面量类型** 'PowerShell'，
 *     而不是宽泛的 string。Java 没有直接对应物（最接近 enum 单例）。
 *     收益：别处 switch/=== 这个常量时编译器知道它只可能是 'PowerShell'，
 *     写成别的字面量在编译期就报错（编译期常量折叠 + 字面量类型推断）。
 *   'PowerShell' 外用单引号：跟双引号完全等价，本项目风格用单引号
 *     （Java 里单引号是 char，这里是 string —— 最容易看串的一点）。
 */
// Here to break circular dependency from prompt.ts
export const POWERSHELL_TOOL_NAME = 'PowerShell' as const
