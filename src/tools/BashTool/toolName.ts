/**
 * 【一句话定位】本文件只做一件事：导出 Bash 工具的名字常量 'Bash'。
 *
 * 【在架构中的位置】
 *   上游：BashTool/prompt.ts（提示词里要写工具名）、BashTool.tsx（工具定义）、权限与 UI 模块（报错/弹窗要显示工具名）
 *   下游：无（本文件不 import 任何东西，是依赖图的叶子节点）
 *   调用链：prompt.ts -> toolName.ts（单向，不允许反向）
 *
 * 【本文件包含什么】
 *   - BASH_TOOL_NAME：常量 'Bash'，是 Bash 工具在「模型 / 权限规则 / UI」三处的唯一标识
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `export const X = ...`：export ≈ Java 的 public，const ≈ final（引用不可改；若是对象，对象内部仍可改）
 *   - 类型标注写在变量名**后面**（`const X: string`），Java 写在前面（`String x`），这是最容易看串的地方
 *   - 为什么要拆成单独一个文件：切断循环依赖（见下方对第一行的中文说明）
 */
// Here to break circular dependency from prompt.ts
// 中文补充：这一行是本文件存在的唯一理由，不是废话。
// prompt.ts 需要用到 BASH_TOOL_NAME，而 BashTool.tsx 又要 import prompt.ts；
// 若把常量定义在 BashTool.tsx 里，就形成 A→B→A 的循环依赖（Java 里同样要避免的 import 环），
// 运行时可能出现「模块还没初始化完就取值」拿到 undefined。拆出这个叶子文件即可断环。
// 中文补充：这一行是本文件存在的唯一理由，不是废话。
// prompt.ts 需要用到 BASH_TOOL_NAME，而 BashTool.tsx 又要 import prompt.ts；
// 若把常量定义在 BashTool.tsx 里，就形成 A→B→A 的循环依赖（Java 里同样要避免的 import 环），
// 运行时可能出现「模块还没初始化完就取值」拿到 undefined。拆出这个叶子文件即可断环。
// 同一个字符串同时扮演三种角色：给模型看的工具名、权限规则里的匹配键、UI 上显示的名字，三处必须完全一致
// 同一个字符串同时扮演三种角色：给模型看的工具名、权限规则里的匹配键、UI 上显示的名字，三处必须完全一致
export const BASH_TOOL_NAME = 'Bash'
