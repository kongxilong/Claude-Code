/** 读取缓存的 microcompact 配置。本构建为空实现，恒返回 null（表示无缓存配置）。 */
/**
 * 【一句话定位】microcompact（第二级压缩）的**缓存配置读取器**：把「服务端下发的 microcompact 配置」
 * 缓存在本地，供 microCompact.ts 反复读取而不用每次都走网络。
 *
 * 【在架构中的位置】
 * - 上游：src/services/compact/microCompact.ts（真正执行 microcompact 的地方），
 *   而 microCompact.ts 是被 src/query.ts 的主循环在每次发请求前调用的。
 * - 下游：无。本构建为空实现，恒返回 null（恒无配置）。
 * - 调用链：src/query.ts（主循环）→ compact/microCompact.ts → 本文件（读缓存配置）
 *
 * 【MC 是什么】MC = MicroCompact，即四级压缩里的第二级：
 * 不动对话骨架，只把体积大的**工具结果（tool result）**换成一句占位符，
 * 例如「[工具结果已清理，共 12000 token]」。这是性价比最高的一级。
 *
 * 【本文件包含什么】
 * - getCachedMCConfig()：读取缓存的 microcompact 配置（本构建恒返回 null）。
 *
 * 【TS 语法速查】
 * - 函数没有写返回类型：TS 会根据 return 语句**自动推断**，这里推断为 `null`。
 *   ≈ Java 10+ 的 `var`，但 Java 不允许省略方法返回类型，这是 TS 特有的。
 * - 返回 `null` 表示「没有配置」，调用方通常用 `?? 默认值` 或 `?.` 兜底。
 *   对比 src/services/compact/timeBasedMCConfig.ts 的 getTimeBasedMCConfig()：
 *   那个函数返回完整配置对象 + 内置默认值，本函数则把「有没有配置」的判断交给调用方。
 */
export function getCachedMCConfig() {
  return null
}
