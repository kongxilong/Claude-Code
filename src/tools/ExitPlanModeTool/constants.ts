/**
 * ============================================================================
 *  【文件总览】src/tools/ExitPlanModeTool/constants.ts
 * ============================================================================
 *
 *  一句话定位：
 *  把「退出 plan mode」这个工具的名字抽成常量，供别处引用。
 *
 *  在架构中的位置：
 *      ExitPlanModeV2Tool.ts  ──引用──>  本常量（注册为工具的 name）
 *      以及权限判定 / UI 等按工具名匹配的模块
 *
 *  本文件包含什么：
 *   1. EXIT_PLAN_MODE_TOOL_NAME     第一版（V1）用的名字
 *   2. EXIT_PLAN_MODE_V2_TOOL_NAME  第二版（V2）用的名字 —— 本目录实际用的这个
 *
 *  ★ 为什么两个常量的值**一模一样**，都是 'ExitPlanMode'？
 *    这不是写重复了，是**故意**的：
 *      · V1 的老实现让模型把方案当参数传进来；
 *      · V2 改成从磁盘上的计划文件读方案（好处见 ExitPlanModeV2Tool.ts 的注释）。
 *    但对外暴露的**工具名保持不变**——因为工具名是模型和外部集成（SDK / hook /
 *    用户的权限配置）看到的唯一标识。改名会破坏一大片：
 *    用户 settings.json 里写的 "ExitPlanMode" 权限规则会全部失效，
 *    hook 里的匹配条件也会失效。
 *    所以"内部换了实现，对外名字不动"，是兼容性设计的基本原则。
 *    这也解释了为什么源码文件名带 V2（ExitPlanModeV2Tool.ts），
 *    而模型看到的名字不带版本。
 *
 *  TS 语法速查（Java 工程师视角）：
 *   - `export`  ≈ Java 的 `public`；不写就只在当前文件可见（≈ 包级私有）
 *   - `const`   ≈ Java 的 `final`：不可**重新赋值**的引用。
 *                和 Java final 一样，只保证"指向谁"不变，
 *                如果指向对象，对象内部字段仍可改。
 *   - 没写 `: string` 类型标注：TS 能从右侧字面量自动推断（类型推断，≈ var）。
 *   - 一个文件里可以 export 多个常量，≈ Java 常量类里的多个 public static final。
 */
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'
export const EXIT_PLAN_MODE_V2_TOOL_NAME = 'ExitPlanMode'
