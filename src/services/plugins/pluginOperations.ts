/**
 * Core plugin operations (install, uninstall, enable, disable, update)
 *
 * This module provides pure library functions that can be used by both:
 * - CLI commands (`claude plugin install/uninstall/enable/disable/update`)
 * - Interactive UI (ManagePlugins.tsx)
 *
 * Functions in this module:
 * - Do NOT call process.exit()
 * - Do NOT write to console
 * - Return result objects indicating success/failure with messages
 * - Can throw errors for unexpected failures
 */

/**
 * ============================================================================
 *  【文件总览】pluginOperations.ts —— 插件系统的「内核层 / Service 层」
 * ============================================================================
 *
 *  一句话定位：
 *  插件的**增删改查业务逻辑**都在这里：install / uninstall / enable / disable /
 *  disable-all / update。它是一组"纯库函数"——不碰终端、不 exit 进程，
 *  只返回结果对象，因此 CLI 和交互式 UI 都能复用同一份逻辑。
 *
 *  【为什么必须"纯"？——本文件最重要的设计约束】
 *
 *      pluginOperations.ts（本文件，内核）
 *          ↑ 被两方同时调用，所以绝对不能带"外壳副作用"
 *          │
 *          ├── pluginCliCommands.ts   CLI：加 console 输出 + process.exit
 *          └── ManagePlugins.tsx      交互式 UI：加 React 状态渲染
 *
 *  如果本文件里写了 console.log，那么 GUI 面板里就会莫名其妙打印东西；
 *  如果本文件里写了 process.exit，那么用户在 UI 里点一下按钮整个程序就没了。
 *  所以本文件严格遵守：不 print、不 exit、失败用返回值表达。
 *  类比 Java：这是标准的 Service 层，返回 Result DTO，由 Controller 决定怎么呈现。
 *
 *  【在架构中的位置】
 *
 *      CLI 或 交互式 UI
 *        └─> installPluginOp / uninstallPluginOp / setPluginEnabledOp / updatePluginOp  ← ★ 本文件
 *              ├─> parsePluginIdentifier()      解析 "name@marketplace" 标识符
 *              ├─> getPluginById()              从 marketplace 里查插件条目
 *              ├─> installResolvedPlugin()      真正落盘安装（settings-first）
 *              ├─> loadInstalledPluginsV2()     读 installed_plugins_v2.json（V2 安装台账）
 *              ├─> updateSettingsForSource()    写对应作用域的 settings 文件
 *              ├─> copyPluginToVersionedCache() 按版本号拷进缓存目录（更新用）
 *              └─> clearAllCaches()             让改动立刻生效（清掉内存缓存）
 *
 *  【读懂本文件必须先掌握的 4 个概念】
 *
 *  ① pluginId（插件完整标识）：格式固定为 `插件名@市场名`，例如 `code-review@acme`。
 *     为什么必须带市场名？因为两个市场可能有同名插件，不带就分不清。
 *     用户输入可以偷懒只写 `code-review`，本文件负责把它解析/补全成完整 id。
 *
 *  ② scope（作用域）——四种，决定"这份配置/安装写在哪、对谁生效"：
 *       user    → ~/.claude/settings.json          你这台机器所有项目
 *       project → 仓库里 .claude/settings.json     会进 git，团队共享
 *       local   → 项目本地但不进 git               只你自己在这项目里
 *       managed → 企业管理员下发的强制配置（见 remoteManagedSettings/）
 *     优先级（越靠下越强）：user < project < local < managed。
 *     类比 Java：≈ Spring 的 profile 配置覆盖链，或 logback 的配置层级。
 *
 *  ③ settings-first（配置先行）——本文件最重要的架构决策：
 *     安装一个插件**不是**先把文件拷过去，而是**先往 settings 里写一行声明**
 *     `enabledPlugins: { "code-review@acme": true }`。
 *     真正的下载/拷贝（materialization，物化）由后续加载流程按需完成。
 *     好处：settings 是纯文本、可进 git、可 review、可被企业策略覆盖；
 *           插件源挂了也不影响"声明"本身，换台机器照样能恢复出同样环境。
 *     类比 Java：≈ Maven 里先写 pom.xml 声明依赖，真正下载 jar 是后面的事。
 *
 *  ④ installed_plugins_v2.json（V2 安装台账）：
 *     记录"每个插件在哪些 scope 装过、装在哪个磁盘路径、什么版本"。
 *     它和 settings 是**两套独立账本**：settings 记"想要什么"，V2 记"实际装了什么"。
 *     两者可能不一致（比如市场把插件下架了 → settings 有、市场查不到），
 *     所以本文件里到处都是"先查市场，查不到再回退查 V2"的兜底逻辑。
 *
 *  【本文件包含什么】
 *   常量/类型：VALID_INSTALLABLE_SCOPES / InstallableScope / VALID_UPDATE_SCOPES
 *   作用域工具：assertInstallableScope / isInstallableScope / getProjectPathForScope
 *   状态查询：isPluginEnabledAtProjectScope / getPluginInstallationFromV2
 *   内部查找：findPluginInSettings / findPluginByIdentifier / resolveDelistedPluginId
 *   核心操作：installPluginOp / uninstallPluginOp / setPluginEnabledOp
 *             enablePluginOp / disablePluginOp / disableAllPluginsOp
 *   更新相关：updatePluginOp / performPluginUpdate
 *
 *  【TS 语法速查】（针对本文件实际出现的语法）
 *
 *   - `export const X = ['a','b'] as const`  常量断言。
 *       效果：X 的类型被钉成 `readonly ['a','b']` 而不是 string[]。
 *       ≈ Java 的 `static final List<String>` 但编译期更严格（元素值也进了类型系统）。
 *
 *   - `export type InstallableScope = (typeof VALID_INSTALLABLE_SCOPES)[number]`
 *       这行很绕，拆开看：
 *         typeof X        = 取变量 X 的类型（≈ Java 里没有，TS 特有）
 *         (...)[number]   = 用 number 索引这个数组类型 → 得到**元素类型**的联合
 *       所以 InstallableScope === 'user' | 'project' | 'local'。
 *       好处：往数组里加一个值，类型自动跟着变，不用两处维护（单一数据源）。
 *       ≈ Java 里做不到，只能手写 enum 再手写校验，两边容易不同步。
 *
 *   - `asserts scope is InstallableScope`  —— **断言签名**（不是返回值！）
 *       这是 TS 类型谓词的变体：函数返回后，编译器**相信**参数 scope 已经是该类型。
 *       典型用法：先 assertInstallableScope(x) 校验，后面 x 就能当 InstallableScope 用。
 *       ≈ Java 里没有；近似 Objects.requireNonNull 的"我帮你检查过了"语义，
 *         但 Java 的 requireNonNull 不会改变变量的静态类型，TS 会。
 *
 *   - `scope is InstallableScope`（类型谓词）
 *        ≈ Java 16+ 的 `if (o instanceof Foo f)`，进 if 后编译器自动收窄类型。
 *
 *   - `{ ... } | null`  联合类型 + null。
 *       ≈ Java 的 Optional<Record>，但 TS 用类型表达"可能没有"，
 *         且**编译器强制你必须检查**（不开 strictNullChecks 除外）。
 *
 *   - `installations[0]!.scope`   —— `!` 非空断言。
 *       ≈ Java 的强制转换 `(Install) obj`，运行时**不检查**，纯粹骗编译器。
 *       这里因为前面已经判断过 length > 0，所以断言是安全的。
 *
 *   - 对象解构 + 重命名：`const { name: pluginName } = parsePluginIdentifier(p)`
 *       把返回对象的 name 字段取出来并**改名**为 pluginName。
 *       ≈ Java 没有；类似 SQL 的 `AS` 别名。
 *
 *   - 函数参数也用解构：`function f({ a, b }: { a: string; b: number })`
 *       命名参数风格，调用时写 `f({ a: 'x', b: 1 })`。
 *       ≈ Java 只能靠 Builder 或重载模拟。见本文件的 performPluginUpdate。
 *
 *   - `switch (result.reason) { case 'xxx': ... }` 且**没有 default**
 *       因为 result 的 reason 是联合类型，编译器能证明所有分支都覆盖了，
 *       每个分支都 return ⇒ 函数末尾不需要再 return。这叫**穷尽性检查**。
 *       ≈ Java 17+ 的 sealed interface + 模式匹配 switch 才能做到。
 *
 *   - `Record<InstallableScope, number>`  映射类型。
 *       ≈ Java 的 `Map<InstallableScope, Integer>`，但这里是编译期保证键齐全的普通对象。
 *
 *   - `for (const [mktName, mktConfig] of Object.entries(marketplaces))`
 *       Object.entries 把对象变成 [键, 值] 数组，再解构。
 *       ≈ Java 的 `for (var e : map.entrySet())` + `e.getKey()/getValue()`。
 *
 *   - `try { ... } finally { ... }`  和 Java 完全一样，
 *       但注意本文件用它保证**临时目录一定被清理**（即使中途抛异常）。
 *       ≈ Java 的 try-finally，不是 try-with-resources。
 */

import { dirname, join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { isBuiltinPluginId } from '../../plugins/builtinPlugins.js'
import type { LoadedPlugin, PluginManifest } from '../../types/plugin.js'
import { isENOENT, toError } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logError } from '../../utils/log.js'
import {
  clearAllCaches,
  markPluginVersionOrphaned,
} from '../../utils/plugins/cacheUtils.js'
import {
  findReverseDependents,
  formatReverseDependentsSuffix,
} from '../../utils/plugins/dependencyResolver.js'
import {
  loadInstalledPluginsFromDisk,
  loadInstalledPluginsV2,
  removePluginInstallation,
  updateInstallationPathOnDisk,
} from '../../utils/plugins/installedPluginsManager.js'
import {
  getMarketplace,
  getPluginById,
  loadKnownMarketplacesConfig,
} from '../../utils/plugins/marketplaceManager.js'
import { deletePluginDataDir } from '../../utils/plugins/pluginDirectories.js'
import {
  parsePluginIdentifier,
  scopeToSettingSource,
} from '../../utils/plugins/pluginIdentifier.js'
import {
  formatResolutionError,
  installResolvedPlugin,
} from '../../utils/plugins/pluginInstallationHelpers.js'
import {
  cachePlugin,
  copyPluginToVersionedCache,
  getVersionedCachePath,
  getVersionedZipCachePath,
  loadAllPlugins,
  loadPluginManifest,
} from '../../utils/plugins/pluginLoader.js'
import { deletePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js'
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js'
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js'
import { calculatePluginVersion } from '../../utils/plugins/pluginVersioning.js'
import type {
  PluginMarketplaceEntry,
  PluginScope,
} from '../../utils/plugins/schemas.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { plural } from '../../utils/stringUtils.js'

/** Valid installable scopes (excludes 'managed' which can only be installed from managed-settings.json) */
// 【中文】允许"安装"的作用域只有三个。为什么排除 managed？
// 因为 managed 是企业管理员**下发**的（只能由管理员侧配置），
// 普通用户不能往这个作用域里装东西 —— 否则就能绕过企业管控了。
export const VALID_INSTALLABLE_SCOPES = ['user', 'project', 'local'] as const

/** Installation scope type derived from VALID_INSTALLABLE_SCOPES */
// 【中文】从常量数组**反推**出类型，避免"数组和类型两处维护不一致"。
export type InstallableScope = (typeof VALID_INSTALLABLE_SCOPES)[number]

/** Valid scopes for update operations (includes 'managed' since managed plugins can be updated) */
// 【中文】更新操作**允许** managed：插件已经在那了，只是拉新版本，
// 不涉及"新增安装"，所以不会绕过企业管控。注意这里的类型显式写成
// readonly PluginScope[]，是为了让数组里能放 4 个 scope（PluginScope 是全集）。
export const VALID_UPDATE_SCOPES: readonly PluginScope[] = [
  'user',
  'project',
  'local',
  'managed',
] as const

/**
 * Assert that a scope is a valid installable scope at runtime
 * @param scope The scope to validate
 * @throws Error if scope is not a valid installable scope
 *
 * 【中文补充】运行期校验作用域是否合法，不合法就抛异常。
 *
 * 为什么需要它：TS 的类型只在**编译期**有效。而 scope 很可能来自
 * 命令行参数、配置文件这种运行时输入，编译期管不住，必须在入口拦一道。
 * 这就是"类型系统 + 运行时校验"双保险的典型做法。
 * 类比 Java：≈ 方法开头写 `Preconditions.checkArgument(validScopes.contains(scope))`。
 *
 * 返回值写成 `asserts scope is InstallableScope` 是关键：
 * 调用完这一行之后，编译器就**认可** scope 已经是 InstallableScope 类型了，
 * 后面可以直接当它用而不用再写 `as` 断言。
 */
export function assertInstallableScope(
  scope: string,
): asserts scope is InstallableScope {
  // 【中文】`scope as InstallableScope` 只是为了让 includes() 的参数类型对得上，
  // 这里的 as 是"骗编译器让我先编译过"，真正的检查靠 if + throw。
  if (!VALID_INSTALLABLE_SCOPES.includes(scope as InstallableScope)) {
    throw new Error(
      `Invalid scope "${scope}". Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
    )
  }
}

/**
 * Type guard to check if a scope is an installable scope (not 'managed').
 * Use this for type narrowing in conditional blocks.
 *
 * 【中文补充】判断某个作用域是不是"可安装作用域"，用于 if 里做类型收窄。
 *
 * 与 assertInstallableScope 的区别（两个都存在的理由）：
 *   assertInstallableScope → 失败**抛异常**，用在"非法就该炸掉"的入口
 *   isInstallableScope     → 返回 boolean，用在"需要分支处理"的地方
 * 类比 Java：≈ Objects.requireNonNull 与 `x != null` 的关系，一个断言一个查询。
 *
 * 典型用途：遍历所有 scope 时，managed 需要被跳过（不能被用户装/卸），
 * 用这个判断过滤掉它，同时编译器也知道剩下的就是 InstallableScope 了。
 */
export function isInstallableScope(
  scope: PluginScope,
): scope is InstallableScope {
  return VALID_INSTALLABLE_SCOPES.includes(scope as InstallableScope)
}

/**
 * Get the project path for scopes that are project-specific.
 * Returns the original cwd for 'project' and 'local' scopes, undefined otherwise.
 *
 * 【中文补充】只有跟"某个具体项目"绑定的作用域才需要项目路径。
 *
 * 为什么需要它：同一个插件可以在 A 项目装 local 版、在 B 项目装 local 版，
 * 两份是**并存且独立**的。所以要定位"某作用域下的那份安装"，
 * 光有 scope 不够，还必须带上项目路径，否则会把别的项目的那份给改了。
 *
 * @param scope 作用域
 * @returns 'project'/'local' 返回当前工作目录；'user'/'managed' 返回 undefined
 *
 * 【为什么叫 getOriginalCwd 而不是 process.cwd()】
 *   因为程序内部可能切换过工作目录（比如插件加载时 cd 到插件目录），
 *   此时 process.cwd() 拿到的已经不是用户启动时的目录了。
 *   必须用启动时记下来的"原始 cwd"，否则会定位错项目。
 */
export function getProjectPathForScope(scope: PluginScope): string | undefined {
  return scope === 'project' || scope === 'local' ? getOriginalCwd() : undefined
}

/**
 * Is this plugin enabled (value === true) in .claude/settings.json?
 *
 * Distinct from V2 installed_plugins.json scope: that file tracks where a
 * plugin was *installed from*, but the same plugin can also be enabled at
 * project scope via settings. The uninstall UI needs to check THIS, because
 * a user-scope install with a project-scope enablement means "uninstall"
 * would succeed at removing the user install while leaving the project
 * enablement active — the plugin keeps running.
 *
 * 【中文补充】判断插件是否在**项目级** .claude/settings.json 里被显式启用。
 *
 * 为什么需要这个函数（这是本文件最容易踩的坑，务必理解）：
 *
 *   系统里有**两套账本**，它们记录的东西不同：
 *     · V2 的 installed_plugins.json → 记"这个插件是从哪装来的"（安装来源）
 *     · settings.json 的 enabledPlugins → 记"这个插件要不要启用"（开关）
 *
 *   两者可以**交叉**：一个插件可能是 user 作用域装的，却在 project 作用域被启用。
 *   如果卸载时只删 user 那份安装，project 的启用开关还开着 →
 *   插件照样会被加载 → 用户点了"卸载"却没生效，这是非常困惑的 bug。
 *
 *   所以卸载 UI 必须**先查**这个开关，提醒用户"项目级还有个开关要先关掉"。
 *
 * @param pluginId 完整的插件标识（name@marketplace）
 * @returns true 表示项目级 settings 里明确写了 `true`
 *
 * 【注意 `=== true` 而不是简单地取真值】
 *   enabledPlugins 的值可能是 true / false / string[]（后者是"只启用部分组件"），
 *   只有严格等于 true 才算"完整启用"，其它情况都不能当成已启用。
 */
export function isPluginEnabledAtProjectScope(pluginId: string): boolean {
  return (
    // 【中文】?. 可选链：settings 可能不存在、enabledPlugins 字段可能没配，
    // 任何一层缺失都返回 undefined，不会抛 NullPointerException。
    getSettingsForSource('projectSettings')?.enabledPlugins?.[pluginId] === true
  )
}

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of a plugin operation
 */
export type PluginOperationResult = {
  success: boolean
  message: string
  pluginId?: string
  pluginName?: string
  scope?: PluginScope
  /** Plugins that declare this plugin as a dependency (warning on uninstall/disable) */
  reverseDependents?: string[]
}

/**
 * Result of a plugin update operation
 */
export type PluginUpdateResult = {
  success: boolean
  message: string
  pluginId?: string
  newVersion?: string
  oldVersion?: string
  alreadyUpToDate?: boolean
  scope?: PluginScope
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Search all editable settings scopes for a plugin ID matching the given input.
 *
 * If `plugin` contains `@`, it's treated as a full pluginId and returned if
 * found in any scope. If `plugin` is a bare name, searches for any key
 * starting with `{plugin}@` in any scope.
 *
 * Returns the most specific scope where the plugin is mentioned (regardless
 * of enabled/disabled state) plus the resolved full pluginId.
 *
 * Precedence: local > project > user (most specific wins).
 *
 * 【中文补充】在所有可编辑的作用域的 settings 里，搜索匹配给定输入的插件 ID。
 *
 * 为什么需要它：用户可能用简称（"code-review"）也可能用全称（"code-review@acme"），
 * 而且同一个插件可能在多个作用域都出现过。需要一个统一的"定位"函数
 * 把"用户随口说的名字"翻译成"确定的 pluginId + 确定的 scope"。
 *
 * @param plugin 用户输入的标识符。含 '@' 视为完整 pluginId；否则视为裸名做前缀匹配
 * @returns 找到则返回 { pluginId, scope }；找不到返回 null（不是抛异常，交给调用方决定）
 *
 * 关键步骤：
 *   ① 判断用户输入带不带 '@'，决定用"精确匹配"还是"前缀匹配"
 *   ② 按 local → project → user 顺序搜（最具体的先搜，先命中先赢）
 *   ③ 逐作用域读 enabledPlugins 的**所有 key**，做匹配
 *   ④ 每个作用域内遍历 key：带 @ 比相等，不带 @ 比 `${plugin}@` 前缀
 *
 * 【为什么搜索顺序是 local > project > user？】
 *   越具体的作用域优先级越高（见下方 SCOPE_PRECEDENCE），
 *   用户在同一台机器上对同一个项目的设置，应该压过全局设置。
 *   这和 Spring 里"子容器配置覆盖父容器"是同一个道理。
 *
 * 【为什么要遍历 key 而不是直接查 enabledPlugins[plugin]？】
 *   因为用户输入可能只写了插件名没写市场名，而 key 是完整的 "name@marketplace"。
 *   只有遍历才能做 "name@" 前缀匹配，把简称补全成全称。
 */
function findPluginInSettings(plugin: string): {
  pluginId: string
  scope: InstallableScope
} | null {
  const hasMarketplace = plugin.includes('@')
  // Most specific first — first match wins
  const searchOrder: InstallableScope[] = ['local', 'project', 'user']

  for (const scope of searchOrder) {
    const enabledPlugins = getSettingsForSource(
      scopeToSettingSource(scope),
    )?.enabledPlugins
    if (!enabledPlugins) continue

    for (const key of Object.keys(enabledPlugins)) {
      if (hasMarketplace ? key === plugin : key.startsWith(`${plugin}@`)) {
        return { pluginId: key, scope }
      }
    }
  }
  return null
}

/**
 * Helper function to find a plugin from loaded plugins
 *
 * 【中文补充】从**已加载到内存的插件列表**里按标识符找一个插件。
 *
 * 与 findPluginInSettings 的区别：
 *   findPluginInSettings → 搜**配置文件**（settings.json 里的键）
 *   findPluginByIdentifier → 搜**内存里已加载的插件对象**（LoadedPlugin[]）
 * 前者拿得到 scope，后者拿得到插件的完整元信息（manifest、source 路径等）。
 * 卸载时两个都要用：先从市场/内存找到插件对象，再从 settings 找到确切的键。
 *
 * @param plugin  用户输入的标识符
 * @param plugins 已加载的插件列表（启用 + 禁用的合集）
 * @returns 找到的 LoadedPlugin；找不到返回 undefined
 *
 * 【匹配策略说明】
 *   先试"完全相等"（用户可能直接给了插件全名），
 *   再试"名字相等 且 来源包含 @市场名"（处理 name@marketplace 形式）。
 *   注意这里**优先宽松匹配**：只要名字对就返回，即使没指定市场。
 *   这是刻意的容错 —— 用户只想装一个插件时，不该被强制要求记住市场名。
 */
function findPluginByIdentifier(
  plugin: string,
  plugins: LoadedPlugin[],
): LoadedPlugin | undefined {
  const { name, marketplace } = parsePluginIdentifier(plugin)

  return plugins.find(p => {
    // Check exact name match
    if (p.name === plugin || p.name === name) return true

    // If marketplace specified, check if it matches the source
    if (marketplace && p.source) {
      return p.name === name && p.source.includes(`@${marketplace}`)
    }

    return false
  })
}

/**
 * Resolve a plugin ID from V2 installed plugins data for a plugin that may
 * have been delisted from its marketplace. Returns null if the plugin is not
 * found in V2 data.
 *
 * 【中文补充】处理"插件被市场下架了"这种特殊情况：从 V2 安装台账反查插件 ID。
 *
 * 为什么需要它（这是真实世界里一定会遇到的场景）：
 *   插件在 marketplace 里被作者删除/下架了，但用户本机还装着它。
 *   此时按常规路径（去市场里查条目）会查不到 → 卸载/更新全部失败 →
 *   用户被一个"永远卸载不掉"的僵尸插件卡住。
 *
 *   解决办法：市场查不到时，回退去查**本地台账** installed_plugins_v2.json ——
 *   那份文件里记着"装过什么、装在哪"，它不依赖市场是否还存在。
 *
 * @param plugin 用户输入的标识符
 * @returns { pluginId, pluginName } 或 null
 *
 * 关键步骤：
 *   ① 先试完整 pluginId 精确命中（用户给了全称的情况）
 *   ② 再遍历所有 key，按"插件名相同 且 安装记录非空"模糊找
 *   ③ 都找不到才返回 null（调用方据此报"未安装"）
 *
 * 【为什么要判断 `?.length` 大于 0？】
 *   因为插件可能"台账里有 key 但安装记录是空数组"（比如上次卸载没清干净）。
 *   这种残留 key 不能当成有效安装，否则会对着一个空壳操作。
 *   `?? 0` 是空值合并：undefined 时按 0 处理。
 */
function resolveDelistedPluginId(
  plugin: string,
): { pluginId: string; pluginName: string } | null {
  const { name } = parsePluginIdentifier(plugin)
  const installedData = loadInstalledPluginsV2()

  // Try exact match first, then search by name
  // 【中文】`?.length` 为真值判断：数组存在且长度 > 0。undefined?.length 会得到 undefined（假值）
  if (installedData.plugins[plugin]?.length) {
    return { pluginId: plugin, pluginName: name }
  }

  const matchingKey = Object.keys(installedData.plugins).find(key => {
    const { name: keyName } = parsePluginIdentifier(key)
    return keyName === name && (installedData.plugins[key]?.length ?? 0) > 0
  })

  if (matchingKey) {
    return { pluginId: matchingKey, pluginName: name }
  }

  return null
}

/**
 * Get the most relevant installation for a plugin from V2 data.
 * For project/local scoped plugins, prioritizes installations matching the current project.
 * Priority order: local (matching project) > project (matching project) > user > first available
 *
 * 【中文补充】从 V2 台账里挑出"当前最相关的那一份安装记录"。
 *
 * 为什么需要它：同一个插件可以装多份（user 一份、当前项目 local 一份、
 * 别的项目 project 一份）。做卸载/更新时必须先决定"操作哪一份"。
 *
 * @param pluginId 完整插件标识
 * @returns { scope, projectPath? } —— projectPath 只有项目级作用域才有
 *
 * 关键步骤：
 *   ① 查台账拿所有安装记录；一条都没有就退回 { scope: 'user' }
 *      （用一个安全的默认值，而不是抛错 —— 因为"没装过"是可接受的正常状态）
 *   ② 优先找 **local 且项目路径匹配当前目录**的那份（最具体）
 *   ③ 其次找 **project 且项目路径匹配**的那份
 *   ④ 再其次找 user 那份（全局的，不带项目路径）
 *   ⑤ 都没有就取第一条（可能是 managed 企业下发那份）
 *
 * 【为什么"匹配当前项目"这么重要】
 *   local/project 的安装在台账里是按**项目路径**区分的。
 *   如果只按 scope 找不比对路径，在 A 项目里操作会误伤 B 项目那份安装。
 *   所以 ②③ 都带了 `inst.projectPath === currentProjectPath` 这个条件。
 */
export function getPluginInstallationFromV2(pluginId: string): {
  scope: PluginScope
  projectPath?: string
} {
  const installedData = loadInstalledPluginsV2()
  const installations = installedData.plugins[pluginId]

  if (!installations || installations.length === 0) {
    // 【中文】没装过就假设是 user 作用域 —— 给出无害默认值，让调用方能继续走下去
    return { scope: 'user' }
  }

  const currentProjectPath = getOriginalCwd()

  // Find installations by priority: local > project > user > managed
  const localInstall = installations.find(
    inst => inst.scope === 'local' && inst.projectPath === currentProjectPath,
  )
  if (localInstall) {
    return { scope: localInstall.scope, projectPath: localInstall.projectPath }
  }

  const projectInstall = installations.find(
    inst => inst.scope === 'project' && inst.projectPath === currentProjectPath,
  )
  if (projectInstall) {
    return {
      scope: projectInstall.scope,
      projectPath: projectInstall.projectPath,
    }
  }

  const userInstall = installations.find(inst => inst.scope === 'user')
  if (userInstall) {
    return { scope: userInstall.scope }
  }

  // Fall back to first installation (could be managed)
  // 【中文】兜底取第一条。`!` 非空断言是安全的：上面已确认 length > 0。
  // 这里可能是 managed（企业下发）那份，因为前三个分支都没命中。
  return {
    scope: installations[0]!.scope,
    projectPath: installations[0]!.projectPath,
  }
}

// ============================================================================
// Core Operations
// ============================================================================

/**
 * Install a plugin (settings-first).
 *
 * Order of operations:
 *   1. Search materialized marketplaces for the plugin
 *   2. Write settings (THE ACTION — declares intent)
 *   3. Cache plugin + record version hint (materialization)
 *
 * Marketplace reconciliation is NOT this function's responsibility — startup
 * reconcile handles declared-but-not-materialized marketplaces. If the
 * marketplace isn't found, "not found" is the correct error.
 *
 * @param plugin Plugin identifier (name or plugin@marketplace)
 * @param scope Installation scope: user, project, or local (defaults to 'user')
 * @returns Result indicating success/failure
 *
 * 【中文补充】安装插件的核心实现——**注意它是 settings-first（配置先行）**。
 *
 * 【什么叫 settings-first，以及为什么？（本文件最核心的设计）】
 *   直觉上"安装"应该是"下载文件"。但这里不是：
 *     1. 去已物化的 marketplace 里找到这个插件条目（只是**查**，不下载）
 *     2. **写 settings**（这才是真正的动作）：`enabledPlugins["x@y"] = true`
 *     3. 把插件拷进缓存 + 记录版本（物化，materialization）
 *   也就是说：安装 = 写一行声明；真正的代码落地是后续按需完成的。
 *
 *   这么做的好处：
 *     · settings 是纯文本 → 能进 git → 团队环境可复现、可 code review
 *     · 装插件极快（只是写文件），不必等下载完
 *     · 换台机器/新克隆仓库时，靠同一份 settings 就能还原出同样的插件组合
 *     · 源站挂了也不影响声明本身
 *   类比 Java：≈ 在 pom.xml 里加一段 <dependency>，真正下 jar 是 mvn 后面的事。
 *
 * @param plugin 插件标识符（"name" 或 "name@marketplace"）
 * @param scope  装到哪个作用域，默认 user
 * @returns PluginOperationResult —— success + 给人看的消息 + pluginId/scope 等
 *
 * 关键步骤：
 *   ① 校验 scope 合法（运行时防线）
 *   ② 解析标识符拆成 name / marketplace
 *   ③ 找插件条目：给了市场名就直接查；没给就**遍历所有市场**挨个找
 *   ④ 找不到 → 返回失败（注意：不负责去 clone 市场，那是启动流程的事）
 *   ⑤ 拼出完整 pluginId = `name@marketplace`
 *   ⑥ 交给 installResolvedPlugin 落盘安装
 *   ⑦ 把它的失败原因（联合类型）翻译成人话消息
 *
 * 【为什么找不到就报错，而不自动去把 marketplace 拉下来？】
 *   职责分离：marketplace 的"声明了但还没物化"由启动时的 reconcile 处理
 *   （见 PluginInstallationManager.ts）。如果这里也负责克隆，
 *   就会出现两条互相打架的下载路径，且 CLI 命令会莫名其妙变慢。
 *   "找不到就是找不到"是清晰且正确的错误。
 */
export async function installPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
): Promise<PluginOperationResult> {
  // 【中文】运行时校验：scope 可能来自命令行，类型系统管不住，入口必须拦
  assertInstallableScope(scope)

  // 【中文】解构 + 重命名：`name` → `pluginName`，`marketplace` → `marketplaceName`
  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(plugin)

  // ── Search materialized marketplaces for the plugin ──
  let foundPlugin: PluginMarketplaceEntry | undefined
  let foundMarketplace: string | undefined
  let marketplaceInstallLocation: string | undefined

  if (marketplaceName) {
    // 【中文】快路径：用户明确指定了市场，直接按 id 查，不用遍历
    const pluginInfo = await getPluginById(plugin)
    if (pluginInfo) {
      foundPlugin = pluginInfo.entry
      foundMarketplace = marketplaceName
      marketplaceInstallLocation = pluginInfo.marketplaceInstallLocation
    }
  } else {
    // 【中文】慢路径：用户只给了插件名，得挨个市场找。
    // 注意这里 try/catch + continue：**某个市场坏了不影响继续找其它市场**，
    // 否则一个配置错误的市场会让所有安装都失败。这是必要的容错。
    const marketplaces = await loadKnownMarketplacesConfig()
    for (const [mktName, mktConfig] of Object.entries(marketplaces)) {
      try {
        const marketplace = await getMarketplace(mktName)
        const pluginEntry = marketplace.plugins.find(p => p.name === pluginName)
        if (pluginEntry) {
          foundPlugin = pluginEntry
          foundMarketplace = mktName
          marketplaceInstallLocation = mktConfig.installLocation
          break
        }
      } catch (error) {
        logError(toError(error))
        continue
      }
    }
  }

  if (!foundPlugin || !foundMarketplace) {
    const location = marketplaceName
      ? `marketplace "${marketplaceName}"`
      : 'any configured marketplace'
    return {
      success: false,
      message: `Plugin "${pluginName}" not found in ${location}`,
    }
  }

  // 【中文】到这里 foundPlugin/foundMarketplace 一定非空（上面已 return），
  // 但 TS 的控制流分析对 `let` 变量的收窄比较保守，所以这里再取一次局部常量。
  const entry = foundPlugin
  // 【中文】规范化插件 ID：统一成 `name@marketplace`，后续一切都用它做主键
  const pluginId = `${entry.name}@${foundMarketplace}`

  // 【中文】真正的落盘安装委托给 helper（本文件保持"编排"职责）
  const result = await installResolvedPlugin({
    pluginId,
    entry,
    scope,
    marketplaceInstallLocation,
  })

  // 【中文】把 helper 返回的各种失败原因（判别联合）翻译成面向用户的中文可读消息。
  // switch 没有 default：TS 能证明所有 case 都覆盖了，且每个 case 都 return。
  if (!result.ok) {
    switch (result.reason) {
      case 'local-source-no-location':
        return {
          success: false,
          message: `Cannot install local plugin "${result.pluginName}" without marketplace install location`,
        }
      case 'settings-write-failed':
        return {
          success: false,
          message: `Failed to update settings: ${result.message}`,
        }
      case 'resolution-failed':
        return {
          success: false,
          message: formatResolutionError(result.resolution),
        }
      case 'blocked-by-policy':
        // 【中文】企业策略拦截：管理员把某个插件拉黑了（见 policyLimits/ 目录）。
        // 这是**安全边界**，必须硬失败 —— 用户无论装到哪个 scope 都不该绕过。
        return {
          success: false,
          message: `Plugin "${result.pluginName}" is blocked by your organization's policy and cannot be installed`,
        }
      case 'dependency-blocked-by-policy':
        // 【中文】更隐蔽的情况：插件本身没被拉黑，但它**依赖的插件**被拉黑了。
        // 只检查第一层是不够的，必须递归检查依赖图，否则换个马甲就能绕过策略。
        return {
          success: false,
          message: `Plugin "${result.pluginName}" depends on "${result.blockedDependency}", which is blocked by your organization's policy`,
        }
    }
  }

  return {
    success: true,
    message: `Successfully installed plugin: ${pluginId} (scope: ${scope})${result.depNote}`,
    pluginId,
    pluginName: entry.name,
    scope,
  }
}

/**
 * Uninstall a plugin
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Uninstall from scope: user, project, or local (defaults to 'user')
 * @returns Result indicating success/failure
 *
 * 【中文补充】卸载插件。注意极性：第三个参数是 deleteDataDir（删数据目录），
 * 而 CLI 层传进来的是 keepData，两者相反，CLI 层做了 `!keepData` 取反。
 *
 * 为什么这个函数格外长？因为"卸载"看似简单，实则有**四个坑**要绕：
 *   坑 1：用户给的是简称，settings 里存的是全称 → 要反查确切的 key
 *   坑 2：插件可能被市场下架了 → 市场查不到，要回退查本地台账
 *   坑 3：插件可能装在了**别的**作用域 → 要给出"用 --scope xxx"的明确指引
 *   坑 4：项目级 settings 是团队共享的 → 不能悄悄改别人的配置
 *
 * @param plugin        插件标识符
 * @param scope         从哪个作用域卸载，默认 user
 * @param deleteDataDir 是否连插件数据目录一起删（默认删；只有最后一个作用域被移除时才生效）
 * @returns PluginOperationResult
 *
 * 关键步骤：
 *   ① 校验 scope
 *   ② 加载所有插件（启用 + 禁用）→ 定位插件对象
 *   ③ 从 settings 里反查确切的 pluginId 键
 *   ④ 市场查不到时回退到 V2 台账（处理下架插件）
 *   ⑤ 确认"这个作用域下**确实**装过"，没装过就给出带 --scope 提示的错误
 *   ⑥ 从 settings 里删掉这个键（用 undefined 表示删除）
 *   ⑦ 清缓存 → 从 V2 台账移除该安装记录
 *   ⑧ 如果是最后一个作用域：标记旧版本为孤儿 + 删配置 + 删数据目录
 *   ⑨ 检查有没有别的插件依赖它 → 只**警告**不阻止
 */
export async function uninstallPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
  deleteDataDir = true,
): Promise<PluginOperationResult> {
  // Validate scope at runtime for early error detection
  assertInstallableScope(scope)

  // 【中文】注意这里把"启用的"和"禁用的"合在一起搜 ——
  // 因为用户要卸载的插件可能当前是禁用状态，只搜 enabled 会找不到。
  const { enabled, disabled } = await loadAllPlugins()
  const allPlugins = [...enabled, ...disabled]

  // Find the plugin
  const foundPlugin = findPluginByIdentifier(plugin, allPlugins)

  const settingSource = scopeToSettingSource(scope)
  const settings = getSettingsForSource(settingSource)

  let pluginId: string
  let pluginName: string

  if (foundPlugin) {
    // Find the matching settings key for this plugin (may differ from `plugin`
    // if user gave short name but settings has plugin@marketplace)
    // 【中文】三重匹配 + 兜底：先试用户原样输入，再试插件全名，再试 `名字@` 前缀。
    // 因为用户可能写简称、全称、或记错市场名，三种都得认。
    // 最后 `??` 兜底：settings 里确实没这个键时（比如插件加载了但没写进 settings），
    // 用户给了全称就用全称，否则退化成插件名。
    pluginId =
      Object.keys(settings?.enabledPlugins ?? {}).find(
        k =>
          k === plugin ||
          k === foundPlugin.name ||
          k.startsWith(`${foundPlugin.name}@`),
      ) ?? (plugin.includes('@') ? plugin : foundPlugin.name)
    pluginName = foundPlugin.name
  } else {
    // Plugin not found via marketplace lookup — it may have been delisted.
    // Fall back to installed_plugins.json (V2) which tracks installations
    // independently of marketplace state.
    const resolved = resolveDelistedPluginId(plugin)
    if (!resolved) {
      return {
        success: false,
        message: `Plugin "${plugin}" not found in installed plugins`,
      }
    }
    pluginId = resolved.pluginId
    pluginName = resolved.pluginName
  }

  // Check if the plugin is installed in this scope (in V2 file)
  const projectPath = getProjectPathForScope(scope)
  const installedData = loadInstalledPluginsV2()
  const installations = installedData.plugins[pluginId]
  const scopeInstallation = installations?.find(
    i => i.scope === scope && i.projectPath === projectPath,
  )

  // 【中文】确认"要卸的这份在当前作用域下真的存在"。不存在就直接报错并指路，
  // 绝不能默默什么都不做 —— 那种"命令成功了但啥也没发生"是最糟的体验。
  if (!scopeInstallation) {
    // Try to find where the plugin is actually installed to provide a helpful error
    const { scope: actualScope } = getPluginInstallationFromV2(pluginId)
    if (actualScope !== scope && installations && installations.length > 0) {
      // Project scope is special: .claude/settings.json is shared with the team.
      // Point users at the local-override escape hatch instead of --scope project.
      //
      // 【中文】这里是个很讲究的产品决策：
      // 插件启用于 project 作用域时，其配置写在 .claude/settings.json 里，
      // 而这个文件是**提交进 git、全团队共享**的。
      // 如果提示用户"用 --scope project 卸载"，他一执行就把团队配置改了 ——
      // 而他的真实意图往往只是"我不想用这个插件"。
      // 所以这里刻意**不**推荐 --scope project，而是引导到 --scope local：
      // 在自己本地写一条覆盖，既达到目的又不影响同事。
      if (actualScope === 'project') {
        return {
          success: false,
          message: `Plugin "${plugin}" is enabled at project scope (.claude/settings.json, shared with your team). To disable just for you: claude plugin disable ${plugin} --scope local`,
        }
      }
      return {
        success: false,
        message: `Plugin "${plugin}" is installed in ${actualScope} scope, not ${scope}. Use --scope ${actualScope} to uninstall.`,
      }
    }
    return {
      success: false,
      message: `Plugin "${plugin}" is not installed in ${scope} scope. Use --scope to specify the correct scope.`,
    }
  }

  const installPath = scopeInstallation.installPath

  // Remove the plugin from the appropriate settings file (delete key entirely)
  // Use undefined to signal deletion via mergeWith in updateSettingsForSource
  //
  // 【中文】为什么用 `undefined` 表示删除，而不是直接 delete 掉键？
  //   因为 settings 的写入走的是 mergeWith 深合并逻辑，它靠"值是 undefined"
  //   来识别"这一项要删除"。如果先把键删掉再传进去，合并时根本看不到这个键，
  //   自然也就删不掉磁盘上已有的那条配置。
  //   这是"用值表达意图"而非"用结构表达意图"的典型约定。
  const newEnabledPlugins: Record<string, boolean | string[] | undefined> = {
    ...settings?.enabledPlugins,
  }
  newEnabledPlugins[pluginId] = undefined
  updateSettingsForSource(settingSource, {
    enabledPlugins: newEnabledPlugins,
  })

  // 【中文】清缓存是必须的：内存里还缓存着"插件已加载"的结果，
  // 不清的话本次进程内插件依然生效，用户会觉得"卸载没生效"。
  clearAllCaches()

  // Remove from installed_plugins_v2.json for this scope
  removePluginInstallation(pluginId, scope, projectPath)

  // 【中文】重新读一次台账（因为上面刚删过）—— 看这个插件是不是**一个作用域都不剩了**。
  // 只有彻底没人引用了，才敢做下面那些不可逆的清理动作。
  const updatedData = loadInstalledPluginsV2()
  const remainingInstallations = updatedData.plugins[pluginId]
  const isLastScope =
    !remainingInstallations || remainingInstallations.length === 0
  // 【中文】标记"孤儿版本"而不是直接删除磁盘文件：
  // 直接删可能撞上正在使用的进程/已有硬链接，交给后台清理任务异步处理更安全。
  if (isLastScope && installPath) {
    await markPluginVersionOrphaned(installPath)
  }
  // Separate from the `&& installPath` guard above — deletePluginOptions only
  // needs pluginId, not installPath. Last scope removed → wipe stored options
  // and secrets. Before this, uninstalling left orphaned entries in
  // settings.pluginConfigs (including the legacy ungated mcpServers sub-key
  // from the MCPB Configure flow) and keychain pluginSecrets forever. No
  // feature gate: deletePluginOptions no-ops when nothing is stored, and
  // pluginConfigs.mcpServers is written ungated so its cleanup must run
  // ungated too.
  // 【中文】彻底卸载（最后一个作用域也移除了）才清这两样：
  //   · deletePluginOptions：清掉插件配置，**包括存进 keychain 的密钥**
  //     （不清会留下永远删不掉的隐私残留，见上面那段英文注释讲的历史 bug）
  //   · deletePluginDataDir：清掉插件数据目录（受 deleteDataDir 开关控制）
  if (isLastScope) {
    deletePluginOptions(pluginId)
    if (deleteDataDir) {
      await deletePluginDataDir(pluginId)
    }
  }

  // Warn (don't block) if other enabled plugins depend on this one.
  // Blocking creates tombstones — can't tear down a graph with a delisted
  // plugin. Load-time verifyAndDemote catches the fallout.
  //
  // 【中文】为什么依赖检查只警告不阻止？这段英文注释信息量很大，翻译一下：
  //   如果"有插件依赖它就禁止卸载"，那么当依赖关系里出现一个**已被下架**的插件时，
  //   整个依赖图就再也拆不掉了（你永远无法满足"先卸依赖方"这个前置条件），
  //   会留下永远清不干净的"墓碑"记录。
  //   所以策略是：**允许拆，出事了再修** —— 加载时的 verifyAndDemote 会把
  //   "依赖缺失"的插件自动降级（demote），保证系统不会因为断链而崩掉。
  //   这是典型的"最终一致性"思路，比"事前强校验"更健壮。
  const reverseDependents = findReverseDependents(pluginId, allPlugins)
  const depWarn = formatReverseDependentsSuffix(reverseDependents)

  return {
    success: true,
    message: `Successfully uninstalled plugin: ${pluginName} (scope: ${scope})${depWarn}`,
    pluginId,
    pluginName,
    scope,
    reverseDependents:
      reverseDependents.length > 0 ? reverseDependents : undefined,
  }
}

/**
 * Set plugin enabled/disabled status (settings-first).
 *
 * Resolves the plugin ID and scope from settings — does NOT pre-gate on
 * installed_plugins.json. Settings declares intent; if the plugin isn't
 * cached yet, the next load will cache it.
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param enabled true to enable, false to disable
 * @param scope Optional scope. If not provided, auto-detects the most specific
 *   scope where the plugin is mentioned in settings.
 * @returns Result indicating success/failure
 *
 * 【中文补充】启用/禁用插件的**统一实现**（enablePluginOp / disablePluginOp 都转调它）。
 *
 * 为什么需要它：启用和禁用 90% 的逻辑相同（解析 id、定 scope、策略校验、
 * 幂等判断、写 settings、清缓存），只有写入的布尔值不同。
 * 合成一个函数避免两份代码各自演化出不一致的行为。
 *
 * 【"settings-first"在这里的体现】
 *   本函数**不**去查 installed_plugins.json 判断"装没装过"（英文注释里的
 *   "does NOT pre-gate"）。它只管把"我要启用它"这个**意图**写进 settings。
 *   如果插件还没被缓存/下载，那是以后的事（下次加载会去补）。
 *   这样用户即使在网络不通时也能切换开关，不会卡住。
 *
 * @param plugin  插件标识符（"name" 或 "name@marketplace"）
 * @param enabled true=启用，false=禁用
 * @param scope   可选；不传则自动挑最具体的作用域
 * @returns PluginOperationResult
 *
 * 关键步骤：
 *   ① 内置插件走**专属快路径**（它们没"安装"这回事，直接写 user settings）
 *   ② 解析出确定的 pluginId 和 resolvedScope（显式指定 / 自动探测 / 兜底 user）
 *   ③ 策略校验：企业拉黑的插件**禁止启用**（任何作用域都不行）
 *   ④ 跨作用域提示：指定的作用域里没有它，就告诉用户正确的 --scope
 *      （但"故意往高优先级作用域写以覆盖低优先级"是合法的，要放行）
 *   ⑤ 幂等判断：已经是目标状态就报错"已经启用/禁用了"，避免无意义写盘
 *   ⑥ 禁用时先抓快照，算出哪些插件依赖它（用于给警告）
 *   ⑦ 写 settings → 清缓存 → 返回结果
 */
export async function setPluginEnabledOp(
  plugin: string,
  enabled: boolean,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  // 【中文】用三元算出现在是 enable 还是 disable，纯粹为了拼消息文案
  const operation = enabled ? 'enable' : 'disable'

  // Built-in plugins: always use user-scope settings, bypass the normal
  // scope-resolution + installed_plugins lookup (they're not installed).
  //
  // 【中文】内置插件走**完全独立的快路径**。为什么？
  //   内置插件是编译进程序的（不需要下载、没有安装记录、不来自任何 marketplace）。
  //   如果让它们走下面的通用流程，会在"查 marketplace""查 installed_plugins"
  //   这两步上全部落空，最终报错说找不到插件 —— 明明它是内置的。
  //   所以这里直接短路：一律写 user 作用域 settings，然后返回。
  if (isBuiltinPluginId(plugin)) {
    const { error } = updateSettingsForSource('userSettings', {
      enabledPlugins: {
        ...getSettingsForSource('userSettings')?.enabledPlugins,
        [plugin]: enabled,
      },
    })
    if (error) {
      return {
        success: false,
        message: `Failed to ${operation} built-in plugin: ${error.message}`,
      }
    }
    clearAllCaches()
    const { name: pluginName } = parsePluginIdentifier(plugin)
    return {
      success: true,
      message: `Successfully ${operation}d built-in plugin: ${pluginName}`,
      pluginId: plugin,
      pluginName,
      scope: 'user',
    }
  }

  if (scope) {
    assertInstallableScope(scope)
  }

  // ── Resolve pluginId and scope from settings ──
  // Search across editable scopes for any mention (enabled or disabled) of
  // this plugin. Does NOT pre-gate on installed_plugins.json.
  //
  // 【中文】注意搜索的是"任何提及"（启用或禁用都算），不是只搜已启用的。
  // 因为要禁用的插件在 settings 里存的值就是 false，只搜 true 会漏掉。
  let pluginId: string
  let resolvedScope: InstallableScope

  // 【中文】先在所有作用域里找一遍，拿到"它现在到底记在哪个作用域"。
  // 这个信息后面既用来解析 id，也用来做跨作用域纠错提示。
  const found = findPluginInSettings(plugin)

  if (scope) {
    // Explicit scope: use it. Resolve pluginId from settings if possible,
    // otherwise require a full plugin@marketplace identifier.
    resolvedScope = scope
    if (found) {
      pluginId = found.pluginId
    } else if (plugin.includes('@')) {
      pluginId = plugin
    } else {
      return {
        success: false,
        message: `Plugin "${plugin}" not found in settings. Use plugin@marketplace format.`,
      }
    }
  } else if (found) {
    // Auto-detect scope: use the most specific scope where the plugin is
    // mentioned in settings.
    pluginId = found.pluginId
    resolvedScope = found.scope
  } else if (plugin.includes('@')) {
    // Not in any settings scope, but full pluginId given — default to user
    // scope (matches install default). This allows enabling a plugin that
    // was cached but never declared.
    pluginId = plugin
    resolvedScope = 'user'
  } else {
    return {
      success: false,
      message: `Plugin "${plugin}" not found in any editable settings scope. Use plugin@marketplace format.`,
    }
  }

  // ── Policy guard ──
  // Org-blocked plugins cannot be enabled at any scope. Check after pluginId
  // is resolved so we catch both full identifiers and bare-name lookups.
  //
  // 【中文】企业策略守卫。为什么放在 pluginId 解析**之后**？
  //   因为策略黑名单是按完整 pluginId 匹配的。放在解析前，用户输简称时
  //   黑名单就匹配不上 → 换个写法就能绕过企业管控（安全漏洞）。
  //   解析成规范 id 再比对，才能保证"无论怎么写都拦得住"。
  // 【为什么只在 enabled 时检查？】
  //   禁用一个被拉黑的插件永远应该是允许的 —— 那是让环境更安全，没有理由拦。
  if (enabled && isPluginBlockedByPolicy(pluginId)) {
    return {
      success: false,
      message: `Plugin "${pluginId}" is blocked by your organization's policy and cannot be enabled`,
    }
  }

  const settingSource = scopeToSettingSource(resolvedScope)
  const scopeSettingsValue =
    getSettingsForSource(settingSource)?.enabledPlugins?.[pluginId]

  // ── Cross-scope hint: explicit scope given but plugin is elsewhere ──
  // If the plugin is absent from the requested scope but present at a
  // different scope, guide the user to the right --scope — UNLESS they're
  // writing to a higher-precedence scope to override a lower one
  // (e.g. `disable --scope local` to override a project-enabled plugin
  // without touching the shared .claude/settings.json).
  // 【中文】作用域优先级数值表：数字越大越"具体/越强"。
  // 用 Record 而不是普通对象字面量，是为了让编译器保证三个 key 一个都不能少。
  const SCOPE_PRECEDENCE: Record<InstallableScope, number> = {
    user: 0,
    project: 1,
    local: 2,
  }
  // 【中文】判断这是不是一次"合法的向上覆盖"：
  // 用户显式指定的作用域，比插件当前所在的作用域**更高** → 属于覆盖，放行。
  // 典型场景：`disable --scope local` 去压掉 project 作用域的启用 ——
  // 这样既达到"我不用它"的目的，又不用改团队共享的 .claude/settings.json。
  const isOverride =
    scope && found && SCOPE_PRECEDENCE[scope] > SCOPE_PRECEDENCE[found.scope]
  if (
    scope &&
    scopeSettingsValue === undefined &&
    found &&
    found.scope !== scope &&
    !isOverride
  ) {
    return {
      success: false,
      message: `Plugin "${plugin}" is installed at ${found.scope} scope, not ${scope}. Use --scope ${found.scope} or omit --scope to auto-detect.`,
    }
  }

  // ── Check current state (for idempotency messaging) ──
  // When explicit scope given: check that scope's settings value directly
  // (merged state can be wrong if plugin is enabled elsewhere but disabled here).
  // When auto-detected: use merged effective state.
  // When overriding a lower scope: check merged state — scopeSettingsValue is
  // undefined (plugin not in this scope yet), which would read as "already
  // disabled", but the whole point of the override is to write an explicit
  // `false` that masks the lower scope's `true`.
  // 【中文】两种情况用不同的"当前状态"判定依据：
  //   · 显式指定 scope 且不是覆盖 → 直接读**那个作用域**的 settings 值。
  //     为什么不能读合并后的状态？因为插件可能在别的作用域是启用的，
  //     合并出来是 true，但用户问的是"这个作用域里是不是启用的"——必须看原始值。
  //   · 自动探测 / 覆盖场景 → 读**合并后的有效状态**（getPluginEditableScopes），
  //     因为覆盖时目标作用域里根本没有这条记录（undefined），
  //     读原始值会被误判成"已经是禁用的"，而覆盖的目的恰恰是要写入一个显式的 false。
  const isCurrentlyEnabled =
    scope && !isOverride
      ? scopeSettingsValue === true
      : getPluginEditableScopes().has(pluginId)
  if (enabled === isCurrentlyEnabled) {
    return {
      success: false,
      message: `Plugin "${plugin}" is already ${enabled ? 'enabled' : 'disabled'}${scope ? ` at ${scope} scope` : ''}`,
    }
  }

  // On disable: capture reverse dependents from the PRE-disable snapshot,
  // before we write settings and clear the memoized plugin cache.
  //
  // 【中文】为什么必须在**写 settings 之前**抓快照？
  //   因为一旦把插件禁用，它就不在已加载列表里了，依赖分析就查不到谁依赖它。
  //   顺序反了会得到空结果，警告就发不出去。这是典型的"采样时机"坑。
  let reverseDependents: string[] | undefined
  if (!enabled) {
    const { enabled: loadedEnabled, disabled } = await loadAllPlugins()
    const rdeps = findReverseDependents(pluginId, [
      ...loadedEnabled,
      ...disabled,
    ])
    if (rdeps.length > 0) reverseDependents = rdeps
  }

  // ── ACTION: write settings ──
  const { error } = updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...getSettingsForSource(settingSource)?.enabledPlugins,
      [pluginId]: enabled,
    },
  })
  if (error) {
    return {
      success: false,
      message: `Failed to ${operation} plugin: ${error.message}`,
    }
  }

  clearAllCaches()

  const { name: pluginName } = parsePluginIdentifier(pluginId)
  const depWarn = formatReverseDependentsSuffix(reverseDependents)
  return {
    success: true,
    message: `Successfully ${operation}d plugin: ${pluginName} (scope: ${resolvedScope})${depWarn}`,
    pluginId,
    pluginName,
    scope: resolvedScope,
    reverseDependents,
  }
}

/**
 * Enable a plugin
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Optional scope. If not provided, finds the most specific scope for the current project.
 * @returns Result indicating success/failure
 *
 * 【中文补充】启用插件 —— 只是 setPluginEnabledOp(..., true, ...) 的语义化包装。
 * 存在的意义：调用方写 `enablePluginOp(...)` 比写 `setPluginEnabledOp(x, true)` 可读，
 * 而且布尔位置参数很容易传反（true/false 谁是谁看不出来），包一层能杜绝这类错误。
 */
export async function enablePluginOp(
  plugin: string,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  return setPluginEnabledOp(plugin, true, scope)
}

/**
 * Disable a plugin
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Optional scope. If not provided, finds the most specific scope for the current project.
 * @returns Result indicating success/failure
 *
 * 【中文补充】禁用插件 —— setPluginEnabledOp(..., false, ...) 的语义化包装，理由同 enablePluginOp。
 */
export async function disablePluginOp(
  plugin: string,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  return setPluginEnabledOp(plugin, false, scope)
}

/**
 * Disable all enabled plugins
 *
 * @returns Result indicating success/failure with count of disabled plugins
 *
 * 【中文补充】一键禁用全部已启用插件 —— 排障用的"紧急复位"按钮。
 *
 * 为什么需要它：某个插件把环境搞坏时，用户往往**不知道是哪个**插件的问题。
 * 全禁用 → 确认恢复正常 → 再逐个启用二分排查，是最高效的定位路径。
 * 类比 Java：≈ Spring Boot 启动时排除所有自动配置来定位冲突。
 *
 * @returns PluginOperationResult；message 里带禁用数量（用 plural 做了单复数处理）
 *
 * 关键步骤：
 *   ① 拿到当前所有已启用插件
 *   ② 一个都没有 → 直接返回成功（不算错误：已经是期望状态了）
 *   ③ **逐个**调用 setPluginEnabledOp 禁用，成功进 disabled 列表，失败进 errors 列表
 *   ④ 只要有失败就整体返回失败，但把成功的数量和每条失败原因都列出来
 *
 * 【为什么是"部分成功"语义而不是遇错即停？】
 *   这是排障命令：目标是"尽可能把环境恢复干净"。
 *   如果第 3 个插件失败就中断，后面 20 个还开着，等于没帮上忙。
 *   所以采用"尽力而为 + 完整报告"策略，让用户知道哪些成了哪些没成。
 */
export async function disableAllPluginsOp(): Promise<PluginOperationResult> {
  // 【中文】getPluginEditableScopes 返回的是**合并后**的生效状态，
  // 包含所有作用域合并出来的"当前真正启用"的插件，而不只是某个文件里的。
  const enabledPlugins = getPluginEditableScopes()

  if (enabledPlugins.size === 0) {
    return { success: true, message: 'No enabled plugins to disable' }
  }

  const disabled: string[] = []
  const errors: string[] = []

  // 【中文】`for (const [pluginId] of enabledPlugins)` —— 只解构出第一个元素（键），
  // 忽略值。enabledPlugins 是一个 Map，遍历 Map 得到的是 [key, value] 数组。
  // ≈ Java 的 `for (String pluginId : enabledPlugins.keySet())`。
  for (const [pluginId] of enabledPlugins) {
    // 【中文】复用单个禁用的逻辑，保证"禁用一个"和"禁用全部"行为完全一致
    const result = await setPluginEnabledOp(pluginId, false)
    if (result.success) {
      disabled.push(pluginId)
    } else {
      errors.push(`${pluginId}: ${result.message}`)
    }
  }

  // 【中文】部分失败也返回 success:false，但**把成功的部分如实汇报** ——
  // 用户需要知道"已经关掉了 5 个，另外 2 个失败"，而不是笼统的一句"失败"。
  if (errors.length > 0) {
    return {
      success: false,
      message: `Disabled ${disabled.length} ${plural(disabled.length, 'plugin')}, ${errors.length} failed:\n${errors.join('\n')}`,
    }
  }

  return {
    success: true,
    message: `Disabled ${disabled.length} ${plural(disabled.length, 'plugin')}`,
  }
}

/**
 * Update a plugin to the latest version.
 *
 * This function performs a NON-INPLACE update:
 * 1. Gets the plugin info from the marketplace
 * 2. For remote plugins: downloads to temp dir and calculates version
 * 3. For local plugins: calculates version from marketplace source
 * 4. If version differs from currently installed, copies to new versioned cache directory
 * 5. Updates installation in V2 file (memory stays unchanged until restart)
 * 6. Cleans up old version if no longer referenced by any installation
 *
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Scope to update. Unlike install/uninstall/enable/disable, managed scope IS allowed.
 * @returns Result indicating success/failure with version info
 *
 * 【中文补充】把插件更新到最新版本。
 *
 * 【关键设计：NON-INPLACE（非原地）更新 —— 为什么要这样？】
 *   不是把旧目录里的内容覆盖掉，而是：
 *     新版本**拷贝到一个新的"带版本号"的缓存目录** → 更新台账指向新目录 → 旧目录没人引用了再清掉。
 *   好处（这是多版本共存系统的经典做法）：
 *     · 原子性好：拷贝到一半失败，旧版本完好无损，不会留下半新半旧的烂摊子
 *     · 可回滚：旧版本还在，出问题能切回去
 *     · 多 scope 共享：同一个插件的 user/project 两份安装可以指向同一个版本目录，省磁盘
 *   类比 Java：≈ 每次发布打一个新版本的 jar（如 app-1.2.3.jar），
 *              而不是往同一个 app.jar 里覆盖写。
 *
 * @param plugin 插件标识符
 * @param scope  要更新哪个作用域下的那份副本（**必填**，且允许 managed）
 * @returns PluginUpdateResult —— 带 oldVersion / newVersion / alreadyUpToDate
 *
 * 关键步骤：
 *   ① 解析并规范化出完整 pluginId
 *   ② 从 marketplace 拿到插件条目（拿不到 = 找不到，返回失败）
 *   ③ 从磁盘台账读出所有安装记录；一条都没有 = 没装过，返回失败
 *   ④ 按 scope + projectPath 精确定位要更新的那一份安装
 *   ⑤ 找不到这份安装 → 报错（带路径信息，方便用户看出是路径不匹配）
 *   ⑥ 委托 performPluginUpdate 执行真正的更新
 *
 * 【为什么 scope 必填？】
 *   更新是**破坏性**操作（会换掉正在用的版本）。如果自动猜作用域，
 *   可能更新到用户没预期的那份副本上。必须让用户明确指定。
 */
export async function updatePluginOp(
  plugin: string,
  scope: PluginScope,
): Promise<PluginUpdateResult> {
  // Parse the plugin identifier to get the full plugin ID
  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(plugin)
  // 【中文】规范化：给了市场名就拼成 `name@marketplace`，没给就沿用原样
  const pluginId = marketplaceName ? `${pluginName}@${marketplaceName}` : plugin

  // Get plugin info from marketplace
  // 【中文】这里**只查 marketplace**，不像卸载那样回退查本地台账。
  // 为什么？更新本来就要求"源还在"—— 源都没了下架了，没法拉新版本。
  const pluginInfo = await getPluginById(plugin)
  if (!pluginInfo) {
    return {
      success: false,
      message: `Plugin "${pluginName}" not found`,
      pluginId,
      scope,
    }
  }

  const { entry, marketplaceInstallLocation } = pluginInfo

  // Get installations from disk
  const diskData = loadInstalledPluginsFromDisk()
  const installations = diskData.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return {
      success: false,
      message: `Plugin "${pluginName}" is not installed`,
      pluginId,
      scope,
    }
  }

  // Determine projectPath based on scope
  const projectPath = getProjectPathForScope(scope)

  // Find the installation for this scope
  // 【中文】必须同时匹配 scope **和** projectPath：
  // 只看 scope 的话，在 A 项目里更新 local 插件可能命中 B 项目那份。
  const installation = installations.find(
    inst => inst.scope === scope && inst.projectPath === projectPath,
  )
  if (!installation) {
    const scopeDesc = projectPath ? `${scope} (${projectPath})` : scope
    return {
      success: false,
      message: `Plugin "${pluginName}" is not installed at scope ${scopeDesc}`,
      pluginId,
      scope,
    }
  }

  return performPluginUpdate({
    pluginId,
    pluginName,
    entry,
    marketplaceInstallLocation,
    installation,
    scope,
    projectPath,
  })
}

/**
 * Perform the actual plugin update: fetch source, calculate version, copy to cache, update disk.
 * This is the core update execution extracted from updatePluginOp.
 *
 * 【中文补充】更新的真正执行体（从 updatePluginOp 里抽出来的内部函数）。
 *
 * 为什么抽出来：updatePluginOp 负责"定位要更新哪一份"，本函数负责"怎么更新"。
 * 职责分开后各自都短一些，也便于单独测试。
 *
 * 【命名参数风格】注意参数是用**一个对象**传进来的，调用时写
 *   `performPluginUpdate({ pluginId, pluginName, ... })`
 * 而不是按位置传 8 个参数。这么做的好处：8 个参数按位置传极易传错顺序，
 * 而用对象+命名字段，写错顺序也不会出 bug，可读性也好得多。
 * ≈ Java 里只能用 Builder 或重载才能模拟这种效果。
 *
 * @returns PluginUpdateResult
 *
 * 关键步骤：
 *   ① 区分插件来源：
 *        · 远程（entry.source 不是字符串，是个描述对象）→ 先下载到临时目录
 *        · 本地（entry.source 是路径字符串）→ 直接用市场目录 + 相对路径拼出来
 *   ② 计算新版本号（远程下载时要把 git commit SHA 一起传进去，见下方说明）
 *   ③ 新旧版本相同 → 直接返回 alreadyUpToDate，什么都不做
 *   ④ 不同 → 拷到新版本缓存目录（可能打成 .zip）
 *   ⑤ 更新磁盘台账指向新路径
 *   ⑥ 旧版本没人引用了 → 标记为孤儿
 *   ⑦ finally 里清理远程下载产生的临时目录
 */
async function performPluginUpdate({
  pluginId,
  pluginName,
  entry,
  marketplaceInstallLocation,
  installation,
  scope,
  projectPath,
}: {
  pluginId: string
  pluginName: string
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
  installation: { version?: string; installPath: string }
  scope: PluginScope
  projectPath: string | undefined
}): Promise<PluginUpdateResult> {
  // 【中文】通过工厂拿到文件系统实现，而不是直接用 node:fs。
  // 好处：可以被 mock（测试）、可以做权限/沙箱包装。≈ Java 面向接口编程。
  const fs = getFsImplementation()
  const oldVersion = installation.version

  let sourcePath: string
  let newVersion: string
  let shouldCleanupSource = false
  let gitCommitSha: string | undefined

  // Handle remote vs local plugins
  // 【中文】`typeof entry.source !== 'string'` 用来区分来源类型：
  //   字符串 → 本地相对路径；对象（含 url/git 等字段）→ 需要下载。
  // 这是**判别联合（discriminated union）**的典型用法：
  // 用一个字段的类型不同来区分两种情况，编译器能自动收窄类型。
  if (typeof entry.source !== 'string') {
    // Remote plugin: download to temp directory first
    const cacheResult = await cachePlugin(entry.source, {
      manifest: { name: entry.name },
    })
    sourcePath = cacheResult.path
    // 【中文】远程下载的临时目录必须清理（见最后的 finally），否则会堆积垃圾
    shouldCleanupSource = true
    gitCommitSha = cacheResult.gitCommitSha

    // Calculate version from downloaded plugin. For git-subdir sources,
    // cachePlugin captured the commit SHA before discarding the ephemeral
    // clone (the extracted subdir has no .git, so the installPath-based
    // fallback in calculatePluginVersion can't recover it).
    //
    // 【中文】这段英文讲的是一个很隐蔽的坑，翻译一下：
    //   有些插件的源是"一个大 git 仓库里的某个子目录"（git-subdir）。
    //   下载时为了省空间，会 clone 仓库 → 抠出子目录 → **把 .git 目录丢掉**。
    //   结果：子目录里没有 .git，后面想从路径反查 commit 就查不到了。
    //   所以必须在 clone 还存在时就把 SHA 抓下来，一路传到版本号计算里。
    //   —— 这正是为什么 gitCommitSha 要单独存一个变量往下传。
    newVersion = await calculatePluginVersion(
      pluginId,
      entry.source,
      cacheResult.manifest,
      cacheResult.path,
      entry.version,
      cacheResult.gitCommitSha,
    )
  } else {
    // Local plugin: use path from marketplace
    // Stat directly — handle ENOENT inline rather than pre-checking existence
    //
    // 【中文】这里刻意**不**先判断存在再 stat，而是直接 stat 再 catch ENOENT。
    // 为什么？先 exists 再 stat 会有 TOCTOU 竞态（两次调用之间文件可能被删），
    // 而且多一次 IO。直接 stat + 捕获特定错误码是更地道的做法。
    // ≈ Java 里 try { Files.readAttributes } catch (NoSuchFileException)。
    let marketplaceStats
    try {
      marketplaceStats = await fs.stat(marketplaceInstallLocation)
    } catch (e: unknown) {
      // 【中文】只处理"文件不存在"，其它错误（权限不足等）原样往上抛 ——
      // 不能把所有错误都吞成"目录不存在"，那会掩盖真实问题。
      if (isENOENT(e)) {
        return {
          success: false,
          message: `Marketplace directory not found at ${marketplaceInstallLocation}`,
          pluginId,
          scope,
        }
      }
      throw e
    }
    const marketplaceDir = marketplaceStats.isDirectory()
      ? marketplaceInstallLocation
      : dirname(marketplaceInstallLocation)
    sourcePath = join(marketplaceDir, entry.source)

    // Verify sourcePath exists. This stat is required — neither downstream
    // op reliably surfaces ENOENT:
    //   1. calculatePluginVersion → findGitRoot walks UP past a missing dir
    //      to the marketplace .git, returning the same SHA as install-time →
    //      silent false-positive {success: true, alreadyUpToDate: true}.
    //   2. copyPluginToVersionedCache (when versions differ) throws a raw
    //      ENOENT with no friendly message.
    // TOCTOU is negligible for a user-managed local dir.
    //
    // 【中文】这段英文解释了一个"必须多写一次 stat"的理由，非常值得学：
    //   为什么明明前面已经 stat 过市场目录，这里还要再 stat 一次插件源路径？
    //   因为如果源路径不存在，下游两步都会**安静地给出错误结果**：
    //     ① 算版本号时 findGitRoot 会**向上**找 .git，一路找到市场仓库的 .git，
    //        于是算出一个和当初安装时一样的 SHA → 版本号相同 →
    //        返回 { success: true, alreadyUpToDate: true }。
    //        用户以为"已是最新"，其实源目录早就没了。**假阳性最可怕**。
    //     ② 万一版本不同，拷贝时抛出的也是裸 ENOENT，没有任何友好提示。
    //   所以宁可多一次 IO，也要在这里拦住并给出明确报错。
    try {
      await fs.stat(sourcePath)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        return {
          success: false,
          message: `Plugin source not found at ${sourcePath}`,
          pluginId,
          scope,
        }
      }
      throw e
    }

    // Try to load manifest from plugin directory (for version info)
    let pluginManifest: PluginManifest | undefined
    const manifestPath = join(sourcePath, '.claude-plugin', 'plugin.json')
    try {
      pluginManifest = await loadPluginManifest(
        manifestPath,
        entry.name,
        entry.source,
      )
    } catch {
      // Failed to load - will use other version sources
      // 【中文】manifest 读失败不是致命错误：版本号还能从 git SHA、
      // marketplace 条目上声明的 version 等其它来源算出来，所以静默降级。
    }

    // Calculate version from plugin source path
    newVersion = await calculatePluginVersion(
      pluginId,
      entry.source,
      pluginManifest,
      sourcePath,
      entry.version,
    )
  }

  // Use try/finally to ensure temp directory cleanup on any error
  // 【中文】finally 保证：无论中间是成功 return 还是抛异常，临时目录都会被清掉。
  // ≈ Java 的 try-finally（不是 try-with-resources，因为这里没有 AutoCloseable）。
  try {
    // Check if this version already exists in cache
    let versionedPath = getVersionedCachePath(pluginId, newVersion)

    // Check if installation is already at the new version
    // 【中文】三个条件任一成立就算"已是最新"：
    //   ① 版本号相同 ② 安装路径已经是这个版本目录 ③ 安装路径已经是这个版本的 zip
    // ② ③ 是必要的：因为缓存目录可能已被手工清过，此时版本号相同但文件没了，
    // 只比版本号会误判；同时兼容"目录版"和"zip 版"两种缓存形态。
    const zipPath = getVersionedZipCachePath(pluginId, newVersion)
    const isUpToDate =
      installation.version === newVersion ||
      installation.installPath === versionedPath ||
      installation.installPath === zipPath
    if (isUpToDate) {
      return {
        success: true,
        message: `${pluginName} is already at the latest version (${newVersion}).`,
        pluginId,
        newVersion,
        oldVersion,
        alreadyUpToDate: true,
        scope,
      }
    }

    // Copy to versioned cache (returns actual path, which may be .zip)
    versionedPath = await copyPluginToVersionedCache(
      sourcePath,
      pluginId,
      newVersion,
      entry,
    )

    // Store old version path for potential cleanup
    const oldVersionPath = installation.installPath

    // Update disk JSON file for this installation
    // (memory stays unchanged until restart)
    //
    // 【中文】只改磁盘台账，**不动内存里的状态**。
    // 所以返回的 message 里明确写了 "Restart to apply changes"（要重启才生效）——
    // 因为当前进程里插件已经加载完了，改台账不会影响已加载的实例。
    // 这是个已知的取舍：不热更新，避免"半旧半新"的内存状态难以推理。
    updateInstallationPathOnDisk(
      pluginId,
      scope,
      projectPath,
      versionedPath,
      newVersion,
      gitCommitSha,
    )

    // 【中文】旧版本目录能不能清？必须**全局扫描**一遍台账才能决定：
    // 同一个版本目录可能被多个插件/多个作用域共享（省磁盘的设计），
    // 只要还有任何一个安装记录指向它，就不能清。
    // 这里用两层 some 做"是否存在"判断：
    //   外层 some = 有没有某个插件 → 内层 some = 它的安装记录里有没有指向旧路径的
    // ≈ Java 的 anyMatch 嵌套。
    if (oldVersionPath && oldVersionPath !== versionedPath) {
      const updatedDiskData = loadInstalledPluginsFromDisk()
      const isOldVersionStillReferenced = Object.values(
        updatedDiskData.plugins,
      ).some(pluginInstallations =>
        pluginInstallations.some(inst => inst.installPath === oldVersionPath),
      )

      if (!isOldVersionStillReferenced) {
        await markPluginVersionOrphaned(oldVersionPath)
      }
    }

    const scopeDesc = projectPath ? `${scope} (${projectPath})` : scope
    const message = `Plugin "${pluginName}" updated from ${oldVersion || 'unknown'} to ${newVersion} for scope ${scopeDesc}. Restart to apply changes.`

    return {
      success: true,
      message,
      pluginId,
      newVersion,
      oldVersion,
      scope,
    }
  } finally {
    // Clean up temp source if it was a remote download
    //
    // 【中文】第二个条件是个**安全护栏**：
    // 万一 sourcePath 恰好就是正式的版本缓存目录（比如某些本地源解析后路径重合），
    // 不做这个判断就会把刚装好的插件给删了。
    // `force: true` 让它即使目录不存在也不报错（幂等删除）。
    if (
      shouldCleanupSource &&
      sourcePath !== getVersionedCachePath(pluginId, newVersion)
    ) {
      await fs.rm(sourcePath, { recursive: true, force: true })
    }
  }
}
