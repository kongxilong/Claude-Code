/**
 * ============================================================================
 *  【文件总览】src/tools/TaskOutputTool/constants.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  只导出一个常量：TaskOutput 工具的名字 'TaskOutput'。
 *
 *  【为什么单开一个文件】
 *  工具名会出现在工具注册、权限规则、UI、日志、测试等多处。
 *  抽成常量后：改名只改一行；拼错会**编译期报错**，而不是等到运行时才发现。
 *  ≈ Java 里把魔法字符串抽成 `public static final String`。
 *
 *  【TS 语法速查】
 *  - `export const X = '...'` ≈ `public static final String X = "..."`；
 *    不写 `: string` 是因为 TS 能自动推导出字面量类型。
 */
export const TASK_OUTPUT_TOOL_NAME = 'TaskOutput'
