/**
 * ============================================================================
 *  【文件总览】src/tools/TaskCreateTool/constants.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  只导出一个常量：TaskCreate 工具的名字 'TaskCreate'。
 *
 *  【为什么要单独一个文件？】
 *  工具名会散落在工具注册、权限规则、UI、日志、测试等多处。
 *  抽成常量后：改名只改一行；且**拼错会在编译期报错**（引用不存在的导出直接编译失败），
 *  而写错字符串字面量只能等运行时出 bug 才发现。
 *  ≈ Java 里把魔法字符串抽成 `public static final String`。
 *
 *  【TS 语法速查】
 *  - `export const X = '...'` ≈ `public static final String X = "..."`。
 *  - 没写 `: string` 是因为 TS 能从右边字面量自动推导（≈ Java 10 的 var，但更常用）。
 */
export const TASK_CREATE_TOOL_NAME = 'TaskCreate'
