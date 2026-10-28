/**
 * 【一句话定位】一个**全局开关**：记录「距自动压缩还剩多少 context」的警告当前是否应该被**抑制（不显示）**。
 * 文件很小（只有一个 boolean），但因为被 React 与压缩逻辑共用，所以单独成文件。
 *
 * 【在架构中的位置】
 * - 上游：src/services/compact/microCompact.ts（压缩成功后调用 suppressCompactWarning()）、
 *   autoCompact.ts 相关流程（新一轮压缩尝试开始前调用 clearCompactWarningSuppression()）；
 *   而这条压缩链路是被 src/query.ts 的主循环驱动的。
 * - 下游：../../state/store.js（一个极简的外部状态容器），以及本目录下的 compactWarningHook.ts。
 * - 调用链：src/query.ts（主循环）→ compact/microCompact.ts → 本文件（写） → compactWarningHook.ts（读）→ React UI
 *
 * 【为什么要这个开关】
 * 刚压缩完的那一瞬间，token 计数是**不准的**——准确数字要等下一次 API 响应回来才知道。
 * 如果用压缩前的旧计数去渲染「还剩 xx% context」的警告，用户会看到一条自相矛盾的提示：
 * 「刚刚才压缩完，怎么又说快满了？」所以压缩成功后先把警告压住，等拿到新计数再恢复。
 *
 * 【为什么要跟 React 分开】（本文件不含任何 react import）
 * microCompact.ts 只需要读写这个 boolean；如果把 React 引进来，print 模式（无 UI 的命令行启动路径）
 * 的启动过程也会被拖进 React 依赖。所以：本文件 = 纯状态；compactWarningHook.ts = React 绑定。
 *
 * 【本文件包含什么】
 * - compactWarningStore：存放 boolean 的全局 store（false = 正常显示警告，true = 抑制警告）。
 * - suppressCompactWarning()：置为 true，压缩成功后调用。
 * - clearCompactWarningSuppression()：置为 false，新一轮压缩尝试前调用。
 *
 * 【TS 语法速查】
 * - `export const x = createStore<boolean>(false)`：显式给泛型参数传 `<boolean>`，
 *   ≈ Java 的 `Store<Boolean> x = Store.create(false)`，只是类型参数写在**函数名后面**。
 * - `setState(() => true)`：参数是一个**更新函数**而不是值，≈ Java 的 `Function<S,S>`；
 *   用函数的形式可以保证每次都基于最新状态计算，避免并发写入时读到旧值。
 * - `(): void` ≈ Java 的 void 方法。
 */
import { createStore } from '../../state/store.js'

/**
 * Tracks whether the "context left until autocompact" warning should be suppressed.
 * We suppress immediately after successful compaction since we don't have accurate
 * token counts until the next API response.
 */
/**
 * 全局唯一的警告抑制开关（false = 显示警告，true = 抑制警告）。
 * 用 store 而不是普通变量，是为了让 React 能订阅到变化（见 compactWarningHook.ts）。
 */
export const compactWarningStore = createStore<boolean>(false)

/** Suppress the compact warning. Call after successful compaction. */
/**
 * 抑制「距自动压缩还剩多少 context」的警告。压缩成功之后立刻调用。
 *
 * 为什么需要：压缩刚完成时 token 计数还是旧的/不准确的（准确值要等下一次 API 响应），
 * 此时渲染警告会给出误导性的提示，所以先压住。
 */
export function suppressCompactWarning(): void {
  // 传的是「更新函数」() => true 而不是直接传 true：
  // 箭头函数 ≈ Java lambda；这样 store 每次都基于最新状态计算，不会因为闭包捕获到旧值而出错。
  compactWarningStore.setState(() => true)
}

/** Clear the compact warning suppression. Called at start of new compact attempt. */
/**
 * 取消警告抑制，让「距自动压缩还剩多少 context」的警告恢复显示。
 * 在开始新一轮压缩尝试之前调用——此时我们马上要去拿新的 token 计数了。
 */
export function clearCompactWarningSuppression(): void {
  // 与上面成对出现：一轮压缩「开始前清、成功后抑」，构成完整的生命周期。
  compactWarningStore.setState(() => false)
}
