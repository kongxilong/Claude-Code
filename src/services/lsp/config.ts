/**
 * 【一句话定位】
 * LSP 的「配置来源」：从已启用的插件里收集所有 language server 的配置（启动命令、参数、后缀映射等），
 * 汇总成一张「server 名 → 配置」的表。
 *
 * 【在架构中的位置】
 * 调用链：
 *   LSPServerManager.initialize()
 *     → 本文件 getAllLspServers()
 *       → utils/plugins/pluginLoader.js 的 loadAllPluginsCacheOnly()（拿已启用插件列表）
 *       → utils/plugins/lspPluginIntegration.js 的 getPluginLspServers()（从单个插件解析 LSP 配置）
 * 重要约束：LSP server 只能通过「插件」提供，不支持用户或项目级配置直接写。
 * 这样保证了启动命令这类可执行内容是经过插件分发渠道的，而不是随便一个 .claude 配置就能指定。
 *
 * 【本文件包含什么】
 * - getAllLspServers()：唯一导出函数，返回 `{ servers: Record<string, ScopedLspServerConfig> }`。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `export async function f(): Promise<{ servers: Record<string, X> }>`：
 *   async 函数的返回类型必须写成 Promise<T>（不能只写 T）。≈ Java 的 `CompletableFuture<T>`。
 *   返回类型里直接内联一个对象类型 `{ servers: ... }`，不用先起名。
 * - `Record<string, ScopedLspServerConfig>`：内置工具类型，等价于「键为 string、值为 X 的普通对象」。
 *   ≈ Java 的 `Map<String, X>`，但它是 JS 对象字面量，所以后面才能用 Object.assign/Object.keys。
 * - `const { enabled: plugins } = await loadAllPluginsCacheOnly()`：
 *   解构 + 重命名。取返回对象的 enabled 字段，并改名叫 plugins。
 *   ≈ Java 没有对应语法，相当于 `var plugins = result.getEnabled()`。
 * - `plugins.map(async plugin => { ... })`：数组 map 里传 async 箭头函数 → 得到 `Promise<T>[]`。
 *   ≈ Java 的 `plugins.stream().map(p -> CompletableFuture.supplyAsync(...))`。
 * - `await Promise.all([...])`：并发等待全部完成。≈ Java 的 `CompletableFuture.allOf(...).join()`，
 *   但 allOf 不返回结果值，TS 的 Promise.all 直接返回结果数组（顺序与输入一致）。
 * - `return { plugin, scopedServers, errors }`：对象字面量简写属性——
 *   当变量名和属性名相同时只写一次。≈ Java 的 record 但更省字（Java 要写 `new R(plugin, ...)`）。
 * - `scopedServers: undefined`：显式返回 undefined，表示「这个插件没能加载出配置」。
 * - `for (const { plugin, scopedServers, errors } of results)`：遍历时对每个元素做对象解构，
 *   直接拿到三个字段。≈ Java 的 `for (Result r : results) { r.getPlugin(); ... }`。
 * - `Object.assign(allServers, scopedServers)`：把后者的属性「覆盖式」合并进前者（原地修改，不是生成新对象）。
 *   ≈ Java 的 `all.putAll(scoped)`。注意：同名 key 会被后面的覆盖（所以英文注释强调要保持原顺序）。
 * - `Object.keys(allServers).length`：取键数量（对象没有 .size 属性，Map 才有）。
 * - 为什么整个函数不抛异常：最外层 catch 吞掉并只记日志。因为 LSP 是可选增强功能，
 *   配置加载失败不该让 Claude Code 起不来（返回空表，功能静默降级）。
 */
import type { PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage, toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getPluginLspServers } from '../../utils/plugins/lspPluginIntegration.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import type { ScopedLspServerConfig } from './types.js'

/**
 * Get all configured LSP servers from plugins.
 * LSP servers are only supported via plugins, not user/project settings.
 *
 * @returns Object containing servers configuration keyed by scoped server name
 */
// 中文补充：这是 LSPServerManager 启动时的「配置入口」。
// 返回值为什么用 `{ servers }` 包一层而不是直接返回 Record？为了以后能扩展额外字段（比如诊断信息）
// 而不破坏调用方的解构写法。
// 关键行为：本函数「永不抛异常」。LSP 是可选能力，加载失败就返回空表让功能静默降级，
// 绝不能因为它把整个 CLI 拖挂。
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>
}> {
  const allServers: Record<string, ScopedLspServerConfig> = {}

  try {
    // Get all enabled plugins
// loadAllPluginsCacheOnly：只读缓存的插件列表，不做网络/磁盘的重加载——
// 因为这里是启动路径上的调用，要快。
    const { enabled: plugins } = await loadAllPluginsCacheOnly()

    // Load LSP servers from each plugin in parallel.
    // Each plugin is independent — results are merged in original order so
    // Object.assign collision precedence (later plugins win) is preserved.
// 并发加载每个插件的 LSP 配置（Promise.all）。
// 为什么特意「先并发收集、再按原顺序合并」而不是边并发边合并：
// 因为 Object.assign 是「后写覆盖先写」，如果边并发边合并，合并顺序就变成了「谁先返回谁先写」，
// 结果不稳定。先 Promise.all（保持输入顺序）再顺序合并，才能保证「后面的插件覆盖前面的」这条规则。
    const results = await Promise.all(
      plugins.map(async plugin => {
        const errors: PluginError[] = []
        try {
          const scopedServers = await getPluginLspServers(plugin, errors)
          return { plugin, scopedServers, errors }
// 单个插件抛异常不能连累其他插件：吞掉、记日志、返回空结果继续。
        } catch (e) {
          // Defensive: if one plugin throws, don't lose results from the
          // others. The previous serial loop implicitly tolerated this.
          logForDebugging(
            `Failed to load LSP servers for plugin ${plugin.name}: ${e}`,
            { level: 'error' },
          )
          return { plugin, scopedServers: undefined, errors }
        }
      }),
    )

// 按原顺序合并，保证覆盖优先级确定。
    for (const { plugin, scopedServers, errors } of results) {
      const serverCount = scopedServers ? Object.keys(scopedServers).length : 0
      if (serverCount > 0) {
        // Merge into all servers (already scoped by getPluginLspServers)
// scopedServers 的 key 已经被 getPluginLspServers 加过插件前缀（scoped），
// 所以不同插件的同名 server 不会互相踩。
        Object.assign(allServers, scopedServers)

        logForDebugging(
          `Loaded ${serverCount} LSP server(s) from plugin: ${plugin.name}`,
        )
      }

      // Log any errors encountered
// 插件自己的错误（配置写错等）单独记录，不中断流程。
      if (errors.length > 0) {
        logForDebugging(
          `${errors.length} error(s) loading LSP servers from plugin: ${plugin.name}`,
        )
      }
    }

    logForDebugging(
      `Total LSP servers loaded: ${Object.keys(allServers).length}`,
    )
// 最外层兜底：LSP 是可选功能，加载失败只记录不上抛，保证主流程可用。
  } catch (error) {
    // Log error for monitoring production issues.
    // LSP is optional, so we don't throw - but we need visibility
    // into why plugin loading fails to improve the feature.
    logError(toError(error))

    logForDebugging(`Error loading LSP servers: ${errorMessage(error)}`)
  }

  return {
    servers: allServers,
  }
}
