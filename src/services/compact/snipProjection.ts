/**
 * 判断给定消息是否是 snip 边界标记消息。
 *
 * 为什么需要：剪枝会在历史中留下一条标记，后续遍历历史的逻辑需要认出它并跳过，
 * 否则会把它当成正常对话内容处理。
 *
 * @returns true 表示这是 snip 边界标记。本构建恒 false（从未发生过剪枝）。
 */
/**
 * 【一句话定位】snip（第一级剪枝）的**投影 / 视图辅助模块**：判断哪些消息属于「已被剪掉」的部分，
 * 并把「剪掉后」的历史投影出来给上层使用。
 *
 * 【在架构中的位置】
 * - 上游：src/services/compact/snipCompact.ts（剪枝动作）与需要读取历史的 UI / 统计逻辑；
 *   剪枝动作本身由 src/query.ts 的主循环按需加载并驱动（见 query.ts:115-117）。
 * - 下游：无。本文件只做判断与透传，不执行压缩。
 * - 调用链：src/query.ts（主循环）→ compact/snipCompact.ts → 本文件（投影 / 判定）
 *
 * 【为什么需要「投影」这一层】
 * 剪枝有两种做法：① 真的从数组里删掉（破坏性，原始内容找不回来）
 * ② 保留原始数组、只在「发送 / 展示」时投影出一个不含被剪部分的新数组（非破坏性）。
 * 本模块提供的是后者：原始历史仍然完整保留，上层按需取投影结果。
 * 好处是恢复会话（/resume）或做统计时还能看到完整历史，代价是内存里仍占着一份。
 *
 * 【本文件包含什么】（**本构建中全部为空实现**）
 * - isSnipBoundaryMessage()：判断某条消息是不是 snip 边界标记。
 * - projectSnippedMessages()：把历史投影成「剪掉之后」的样子。
 *
 * 【TS 语法速查】
 * - `<T>(messages: T): T`：入参与返回值同类型的泛型函数，≈ Java 的 `<T> T f(T x)`。
 *   这里的实现是 `return messages` 直接透传，所以泛型上没有任何约束（不需要 extends）。
 * - 同名函数 `isSnipBoundaryMessage` 在 snipCompact.ts 里也导出了一份：TS 允许不同模块导出同名函数，
 *   导入时靠路径区分（≈ Java 不同包下的同名类，用全限定名区分）。
 */
export function isSnipBoundaryMessage(): boolean {
  return false
}

/**
 * 把历史消息「投影」成剪枝之后的样子：原始数组不动，只返回一份过滤后的视图。
 *
 * 为什么需要：直接删除是破坏性的，恢复会话时原始内容就找不回来了。
 * 用投影的方式可以在「UI 展示 / 发请求」时用剪枝后的版本，而在「落盘 / 统计」时仍保留完整历史。
 *
 * @param messages 完整历史消息数组。
 * @returns 投影后的消息数组（本构建为空实现，原样返回）。
 */
export function projectSnippedMessages<T>(messages: T): T {
  return messages
}
