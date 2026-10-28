// 工具名常量：模型在 tool_use 里写的 name 必须与此完全一致。
// 单独抽出是因为这个字符串至少被四处使用（工具注册、提示词、权限规则、UI 展示），必须同源。
/**
 * 【一句话定位】
 *   Glob 工具的“提示词常量”：工具名 + 喂给模型的工具描述（纯字符串常量，零逻辑）。
 *
 * 【在架构中的位置】
 *   上游调用链：模型上下文组装（src/Tool.ts / 提示词构建）→ 本文件导出的 GLOB_TOOL_NAME 与 DESCRIPTION
 *   下游依赖：无（本文件不 import 任何东西，是被依赖的最底层）。
 *   谁 import 它：
 *     - GlobTool.ts：用 GLOB_TOOL_NAME 当工具名、用 DESCRIPTION 当 description()/prompt() 的返回值
 *     - 权限规则、埋点、UI：用同一个常量，避免工具名字符串散落各处后改一处漏一处
 *   为什么要单独拆一个小文件：常量会被多个方向引用（工具本体、提示词、权限、测试），
 *   集中定义可以避免循环依赖，也方便 A/B 实验时整体替换描述。
 *
 * 【本文件包含什么】
 *   - GLOB_TOOL_NAME：工具名常量 'Glob'
 *   - DESCRIPTION：给模型看的工具说明（多条目列，最后一条引导模型在开放式搜索时改用 Agent 工具）
 *
 * 【TS 语法速查】（只列本文件真实出现的写法）
 *   - `export const X = '...'`：导出常量。const 只保证“引用不可再赋值”，字符串本身不可变。
 *     对照 Java：`public static final String X = "..."`。
 *   - 模板字符串（反引号 `` `...` ``）：可跨多行、内部 ${} 插值，本文件里用来写多行描述。
 *     对照 Java：Java 15+ 的文本块（"""..."""）。
 *   - 本文件没有类型标注，但 TS 会**自动推断**出 GLOB_TOOL_NAME 的类型是字面量类型 'Glob'（而不只是 string），
 *     这样拿它去匹配联合类型时更精确。对照 Java：推断出的是 String，没有字面量类型这一说。
 */
export const GLOB_TOOL_NAME = 'Glob'

// 给模型看的工具说明。写法上有几个刻意的取舍：
//   ① 用短条目而非长段落——模型对条列式指令的遵循度更高；
//   ② 首句强调 "any codebase size"，引导模型在不知道文件名时也敢用，而不是退化成 ls；
//   ③ 最后一条明确说“开放式、需要多轮 glob+grep 的搜索请改用 Agent 工具”，
//      这是为了把昂贵的多轮搜索交给有独立上下文的子代理，避免污染主对话上下文。
export const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`
