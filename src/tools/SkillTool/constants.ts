/**
 * ============================================================================
 *  【文件总览】src/tools/SkillTool/constants.ts —— Skill 工具的唯一常量文件
 * ============================================================================
 *
 *  【一句话定位】
 *  这个文件只有一个常量：`SKILL_TOOL_NAME = 'Skill'`。
 *  它定义了模型在对话里调用 Skill 工具时使用的**工具名字符串**。
 *
 *  【在架构中的位置】
 *  调用链（模型想执行一个 skill 时）：
 *
 *      模型输出 tool_use{ name: "Skill", input: { skill: "pdf" } }
 *        └─> 工具注册表按 name 找到 SkillTool      ← src/Tool.ts / src/tools/index.ts
 *              └─> SkillTool                       ← src/tools/SkillTool/SkillTool.ts
 *                    ├─> validateInput()  校验 skill 名是否存在
 *                    ├─> checkPermissions() 走权限规则（allow/deny/ask）
 *                    └─> call()  真正把 skill 的提示词塞进对话
 *
 *  本文件处在最底层：谁要"引用 Skill 工具的名字"（注册、权限规则、埋点、
 *  从父消息里反查 tool_use_id），都从这里 import，避免各处硬编码 'Skill'
 *  导致改名时漏改。
 *
 *  【本文件包含什么】
 *   1. SKILL_TOOL_NAME —— 字符串常量 'Skill'，全局唯一来源。
 *
 *  【TS 语法速查】
 *   - `export const X = 'v'`  ≈ Java `public static final String X = "v";`
 *     TS 里没有类的概念也能导出常量，模块本身就是命名空间。
 *   - 注意这里**没有写** `: string`，TS 会自动推断字面量类型 `'Skill'`
 *     （字面量类型 ≈ 一个只能取这一个值的枚举，比 string 更精确）。
 * ============================================================================
 */

// 对外暴露 Skill 工具的名字。用常量而不是散落在各处的字符串字面量，
// 是为了将来改名时只改一处；同时 TS 的字面量类型能让拼错的名字在编译期报错。
export const SKILL_TOOL_NAME = 'Skill'
