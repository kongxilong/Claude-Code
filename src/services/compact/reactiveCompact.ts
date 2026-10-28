/**
 * 应急压缩入口：请求已超长时，把历史消息压到能发出去的大小。
 *
 * 为什么需要：阈值判断（autoCompact.ts）只是「大概率不超」，但边界情况——
 * 一次超大的工具输出、用户直接贴了一个巨大文件——仍可能让请求瞬间超长。
 * 这时必须有兜底手段把上下文压回去，而不是让整个会话失败。
 *
 * @param messages 当前历史消息数组。
 * @returns Promise<T>：压缩后的消息数组，类型与入参一致。
 *         本构建为空实现，直接原样返回（相当于「不压缩」，此时上层会看到请求依然超长）。
 */
/**
 * 【一句话定位】**响应式压缩（reactive compact）**：当请求已经撞上「prompt too long」时的**被动应急压缩**，
 * 与 autoCompact.ts 那种「提前预判、主动压缩」形成互补。
 *
 * 【在架构中的位置】
 * - 上游：src/query.ts 的主循环。query.ts 在模块顶层用
 *   `const reactiveCompact = feature('REACTIVE_COMPACT') ? require('./services/compact/reactiveCompact.js') : null`
 *   按需加载本模块（见 query.ts:15-17）；当某次 API 调用返回 prompt too long 时，
 *   主循环先调用这里的压缩，再重试一次请求。
 * - 下游：无。本构建为空实现，直接原样返回入参。
 * - 调用链：src/query.ts（主循环，捕获到 prompt too long）→ [feature('REACTIVE_COMPACT')] → 本文件 → 重试请求
 *
 * 【proactive vs reactive：为什么两套都要】
 * - proactive（autoCompact.ts）：每轮都算一遍「还剩多少 context」，快到阈值就提前压缩。
 *   好处是压缩发生在安全的位置（可以挑一个边界切分点），坏处是可能「压早了」浪费信息。
 * - reactive（本文件）：不管阈值，等真的报 prompt too long 了再动手。
 *   好处是绝不浪费（不超就不压），坏处是此时已经处于「请求发不出去」的紧急状态，切分点选择受限。
 * 两者覆盖不同的失败场景，缺一不可。
 *
 * 【本文件包含什么】
 * - runReactiveCompact()：应急压缩入口，返回压缩后的消息数组（本构建为空实现）。
 *
 * 【TS 语法速查】
 * - `async function f<T>(messages: T): Promise<T>`：`Promise<T>` ≈ Java 的 `CompletableFuture<T>`；
 *   `async` 让函数体内可以用 `await` 等待异步结果，写起来像同步代码。
 *   即便函数体里没有 await，标了 async 的返回值也会被自动包成 Promise——所以返回类型是 Promise<T> 而不是 T。
 * - 泛型 `<T>` 在函数名之后、参数表之前，与 Java 的位置一致。
 */
export async function runReactiveCompact<T>(messages: T): Promise<T> {
  return messages
}
