/**
 * ============================================================================
 *  【文件总览】src/services/skillSearch/remoteSkillLoader.ts —— 远程 Skill 加载器（桩）
 * ============================================================================
 *
 *  一句话定位：
 *  按需从**远程服务端**拉取一个 Skill 的完整内容（提示词正文、参数定义等）。
 *  开源版为空实现，恒定返回 null。
 *
 *  在架构中的位置：
 *      src/tools/SkillTool/SkillTool.ts（用户真正调用某个 Skill 时）
 *        └─> require('../../services/skillSearch/remoteSkillLoader.js')
 *              └─> loadRemoteSkill()                     ← ★ 本文件
 *
 *  本文件包含什么：
 *   - loadRemoteSkill()：异步函数，返回 null。
 *
 *  【为什么是空的 / 为什么返回 null 而不是抛异常】
 *  远程 Skill 是托管在服务端的能力，开源版没有后端可连。
 *  这里返回 null 是「优雅降级」：调用方拿到 null 就知道「这个 Skill 本地没有」，
 *  于是回退到本地 Skill 或给用户一个友好提示，而不是让整个程序崩掉。
 *  ≈ Java 里用 `Optional.empty()` 表示「没找到」，而不是抛 NoSuchElementException。
 *
 *  TS 语法速查：
 *   - 返回 `null`：TS 里 null 和 undefined 是两个不同值（Java 只有 null），
 *     所以调用方常写 `if (x == null)` 来同时覆盖两者
 *   - 不写返回类型时，TS 会推断为 `Promise<null>`
 * ============================================================================
 */

/**
 * 从远程加载一个 Skill 的完整内容。
 *
 * 为什么需要：本地只存 Skill 的「索引/目录」，正文体积大且会更新，
 * 所以真正执行时才按需从服务端拉取（懒加载）。
 *
 * @returns Skill 内容；找不到或功能未开启时返回 null（开源版恒为 null）。
 */
export async function loadRemoteSkill() {
  return null
}
