/**
 * 【一句话定位】展开 MCP server 配置里的环境变量占位符 ${VAR} / ${VAR:-默认值}。
 *
 * 【在架构中的位置】
 * - 上游：config.ts（读完 .mcp.json / settings 之后）、client.ts（启动 stdio server 前拼 env 与 args）
 *   —— 配置里写 "Authorization: Bearer ${GITHUB_TOKEN}" 时，由这里换成真实值。
 * - 下游：无（纯函数，只读 process.env）。
 *
 * 【本文件包含什么】
 * - expandEnvVarsInString(value)：唯一导出函数，返回 { expanded, missingVars }。
 *
 * 【TS 语法速查】
 * - 返回类型写成 `{ expanded: string; missingVars: string[] }`：匿名对象类型 ≈ Java 的 record / DTO，
 *   但它是「结构化鸭子类型」——只要字段对得上就算兼容，不需要 implements 某个接口。
 * - `(match, varContent) => {...}`：箭头函数 ≈ Java lambda；作为 replace 的第 2 个参数表示“每命中一次就调一次”。
 * - `const [varName, defaultValue] = varContent.split(':-', 2)`：数组解构，按位置拆成两个局部变量，
 *   Java 没有对应语法，只能写成 String[] parts = ... 再取 [0]/[1]。
 * - `value !== undefined`：TS 有 undefined 和 null 两种“空”。这里只判 undefined，因为空字符串 ''
 *   是合法的 env 值（变量存在但为空），若写成 `||` 会把 '' 也当成“没有”而误用默认值。
 * - `process.env[varName]`：属性名是变量时要用中括号取属性 ≈ Java 的 Map.get(varName)。
 */
/**
 * Shared utilities for expanding environment variables in MCP server configurations
 */

/**
 * Expand environment variables in a string value
 * Handles ${VAR} and ${VAR:-default} syntax
 * @returns Object with expanded string and list of missing variables
 */
  /**
   * 中文补充说明：
   * 入参 value：含 ${...} 占位符的原始字符串。
   * 返回 expanded：替换后的字符串；missingVars：既不在 env 里、又没写默认值的变量名列表。
   * 为什么返回 missingVars 而不是直接抛错：调用方要一次性把「缺哪几个变量」集中告诉用户，
   * 而不是遇到第一个就中断（“你缺 3 个变量” 远比 修好A→报错B→修好B→报错C 友好）。
   */
export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []

  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent) => {
    // Split on :- to support default values (limit to 2 parts to preserve :- in defaults)
    // 中文：split 的第 2 个参数 2 = 最多切 2 段，这样默认值里本身含有 ':-' 也不会被再切开
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = process.env[varName]

    if (envValue !== undefined) {
    // 中文：env 变量存在就直接用（哪怕是空字符串，优先级也高于默认值）
      return envValue
    }
    if (defaultValue !== undefined) {
    // 中文：env 里没有、但写了 :-默认值，则退回默认值
      return defaultValue
    }

    // Track missing variable for error reporting
    // 中文：既无 env 又无默认值 → 记一笔缺失，交给上层统一报错
    missingVars.push(varName)
    // Return original if not found (allows debugging but will be reported as error)
    // 中文：原地返回 ${VAR} 原文。好处是用户在日志里能一眼看出“这里有个没被替换的变量”，
    //        而不是看到空字符串后一头雾水
    return match
  })

  return {
    expanded,
    missingVars,
  }
}
