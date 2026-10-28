/**
 * ============================================================================
 *  【文件总览】src/services/skillSearch/featureCheck.ts —— Skill 搜索功能的开关
 * ============================================================================
 *
 *  一句话定位：
 *  判断「Skill（技能）远程搜索」这个功能当前是否开启。这里恒定返回 false。
 *
 *  在架构中的位置：
 *      src/constants/prompts.ts                        ← 决定是否往系统提示词里塞 Skill 索引
 *        └─> require('./services/skillSearch/featureCheck.js')
 *      src/utils/attachments.ts                       ← 决定是否附带 Skill 发现附件
 *      src/tools/SkillTool/SkillTool.ts               ← Skill 工具里也读这个开关
 *            └─> isSkillSearchEnabled()               ← ★ 本文件
 *
 *  本文件包含什么：
 *   - isSkillSearchEnabled()：返回 boolean，恒定 false。
 *
 *  【为什么是空的？——Java 工程师最容易困惑的点】
 *  这是开源版里的「桩（stub）文件」。内部版这里会去读 feature flag / 配置中心；
 *  开源版把实现抽走了，只留一个永远返回 false 的占位，好让所有调用方能正常编译、跑通，
 *  只是功能不生效。≈ Java 里的 `return false; // TODO 待实现` 的空实现。
 *
 *  另外注意调用方的写法是 `require(...)` 而不是顶部 `import`：
 *  这是为了配合 `feature('XXX')` 编译期开关做 tree-shaking（死代码消除），
 *  让整个模块在打包产物里被彻底删掉。见 query.ts 文件头对 feature() 的说明。
 *
 *  TS 语法速查：
 *   - `export function f(): boolean`  导出一个函数，返回类型写在**括号后面**（Java 在前面）
 *   - `typeof import('./x.js')`       把另一个模块的整体类型取出来，
 *                                     ≈ Java 里没有；想象成「反射拿到那个类的 Class 对象」的类型版
 * ============================================================================
 */

/**
 * 判断 Skill 远程搜索功能是否开启。
 *
 * 为什么需要：Skill 搜索是付费/内测侧的远程能力，开源版没有后端，
 * 所以这里直接关掉，避免调用方走到不存在的远程接口而报错。
 *
 * @returns 是否启用。开源版恒定 false（功能关闭）。
 */
export function isSkillSearchEnabled(): boolean {
  return false
}
