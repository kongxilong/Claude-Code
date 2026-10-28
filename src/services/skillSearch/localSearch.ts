/**
 * ============================================================================
 *  【文件总览】src/services/skillSearch/localSearch.ts —— 本地 Skill 搜索（桩）
 * ============================================================================
 *
 *  一句话定位：
 *  在本地已安装的 Skill 列表里做检索/索引。开源版为空实现，恒定返回空数组。
 *
 *  在架构中的位置：
 *      src/commands.ts（/skill 之类的命令处理）
 *        └─> require('./services/skillSearch/localSearch.js')
 *      src/services/mcp/useManageMCPConnections.ts（MCP 连接管理里也会查一次）
 *        └─> localSkillSearch()                          ← ★ 本文件
 *
 *  本文件包含什么：
 *   - localSkillSearch()：异步函数，返回一个空数组 `[]`。
 *
 *  【为什么是空的】
 *  同 featureCheck.ts：开源版抽走了真正的检索实现，只保留签名。
 *  内部版这里会从本地缓存的 Skill 索引里做匹配并返回命中列表。
 *  返回空数组而不是 null，是刻意的选择——调用方可以直接 `.map()/.filter()`
 *  而不用先判空（这叫「空对象模式」，≈ Java 的 `Collections.emptyList()`）。
 *
 *  TS 语法速查：
 *   - `async function f()`    ≈ Java 的 `CompletableFuture<...> f()`，调用方要 await
 *   - 返回 `[]` 且不写返回类型时，TS 会自动推断成 `never[]`，
 *     ≈ Java 的泛型推断 `List<Object>`；这里是「什么都能装的空列表」
 * ============================================================================
 */

/**
 * 在本地 Skill 索引中检索。
 *
 * 为什么需要：让调用方拿到「本机已装了哪些 Skill」以供命令补全或提示词注入。
 * 开源版没有索引数据，所以返回空列表，调用方的遍历逻辑天然变成空循环。
 *
 * @returns 命中的 Skill 列表（开源版恒为空数组）。
 */
export async function localSkillSearch() {
  return []
}
