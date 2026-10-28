/**
 * ============================================================================
 *  【文件总览】src/services/skillSearch/remoteSkillState.ts —— 远程 Skill 的状态快照（桩）
 * ============================================================================
 *
 *  一句话定位：
 *  返回「远程 Skill 当前处于什么状态」的一份快照（是否已加载、是否可用、版本如何等）。
 *  开源版恒定返回 null，表示「没有远程状态」。
 *
 *  在架构中的位置：
 *      src/tools/SkillTool/SkillTool.ts
 *        └─> require('../../services/skillSearch/remoteSkillState.js')
 *              └─> getRemoteSkillState()                 ← ★ 本文件
 *
 *  与同目录其它文件的区别（容易混淆，特别说明）：
 *      remoteSkillLoader.ts  →  **动作**：去把 Skill 内容「拉回来」
 *      本文件                →  **状态**：描述远程 Skill「现在是什么情况」
 *  一个管「拉取」，一个管「描述」。≈ Java 里的 Service 与 DTO/State 的区别。
 *
 *  本文件包含什么：
 *   - getRemoteSkillState()：同步函数，返回 null。
 *
 *  【为什么是空的】
 *  开源版没有远程 Skill 后端，自然也没有状态可报，返回 null 让调用方走本地分支。
 *
 *  TS 语法速查：
 *   - 这里的函数是**同步**的（没有 async），说明调用方期望「立刻拿到状态」，
 *     通常意味着内部实现会读内存缓存而不是发网络请求
 * ============================================================================
 */

/**
 * 获取远程 Skill 的当前状态快照。
 *
 * 为什么需要：UI 需要知道远程 Skill 是否已就绪，才能决定显示「加载中」还是「可用」。
 *
 * @returns 状态快照；无远程能力时返回 null（开源版恒为 null）。
 */
export function getRemoteSkillState() {
  return null
}
