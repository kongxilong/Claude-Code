/**
 * CLI command wrappers for plugin operations
 *
 * This module provides thin wrappers around the core plugin operations
 * that handle CLI-specific concerns like console output and process exit.
 *
 * For the core operations (without CLI side effects), see pluginOperations.ts
 */

/**
 * ============================================================================
 *  【文件总览】pluginCliCommands.ts —— 插件命令的「命令行外壳层」
 * ============================================================================
 *
 *  一句话定位：
 *  把 pluginOperations.ts 里的**纯业务操作**包一层，加上命令行该有的东西：
 *  打印 ✓/✗、打点上报、以及成功/失败后退出进程（process.exit / gracefulShutdown）。
 *
 *  【为什么要单独拆这一层？——典型的分层思想】
 *
 *      ┌─────────────────────────────────────────────────────────┐
 *      │  pluginOperations.ts   （内核层）                        │
 *      │    · 只做业务：装/卸/启用/禁用/更新                      │
 *      │    · 不打印、不 exit、可以安全地被单元测试调用           │
 *      │    · 也能被交互式 UI（/plugin 面板）复用                 │
 *      ├─────────────────────────────────────────────────────────┤
 *      │  pluginCliCommands.ts  （外壳层）← ★ 本文件              │
 *      │    · 非交互模式专用：`claude plugin install xxx`         │
 *      │    · 加 console 输出 + 遥测 + 进程退出码                 │
 *      └─────────────────────────────────────────────────────────┘
 *
 *  类比 Java：内核层 ≈ Service 层（返回 Result 对象），
 *            外壳层 ≈ main()/Controller（把 Result 翻译成退出码和 stdout）。
 *  拆分的好处是：交互式 UI 和 CLI 能共用同一套业务逻辑，不会两份实现走偏。
 *
 *  【在架构中的位置】
 *
 *      CLI 入口 (src/entrypoints/cli.ts 解析 `plugin <subcommand>`)
 *        └─> installPlugin / uninstallPlugin / enablePlugin / ...   ← ★ 本文件
 *              └─> installPluginOp / uninstallPluginOp / ...        ← pluginOperations.ts
 *
 *  【本文件包含什么】（6 个导出命令 + 1 个内部错误处理器）
 *   1. handlePluginCommandError()  统一的失败收尾：打日志、打点、exit(1)
 *   2. installPlugin()             `plugin install <name> [--scope]`
 *   3. uninstallPlugin()           `plugin uninstall <name> [--keep-data]`
 *   4. enablePlugin()              `plugin enable <name>`
 *   5. disablePlugin()             `plugin disable <name>`
 *   6. disableAllPlugins()         `plugin disable-all`
 *   7. updatePluginCli()           `plugin update <name> --scope`
 *
 *  【贯穿本文件的两条"奇怪"约定 —— 不懂会看得一头雾水】
 *
 *   ① 每个成功分支最后都 `process.exit(0)`，而不是自然 return。
 *      为什么？因为装插件过程中可能启动了后台任务/定时器/MCP 连接，
 *      不显式退出的话 Node 进程会因为事件循环里还有句柄而**挂住不退出**。
 *      对用户来说就是"命令跑完了但终端卡住" —— 所以必须显式 exit。
 *      （update 分支用的是 gracefulShutdown(0)，它会先优雅收尾再退出，更温和。）
 *
 *   ② 遥测字段里一长串 `as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`。
 *      这是什么？一个**编译期审计机制**：这个类型别名名字长得离谱，是故意的。
 *      它逼着写代码的人在每次上报前显式写下"我已人工确认这不是 PII/不是代码"，
 *      万一有人想偷懒不上报审核，代码评审时这个超长名字会非常扎眼。
 *      ≈ Java 里没有；近似"用 @SuppressWarnings 时必须写理由"的强制版。
 *      `as X` 是类型断言 ≈ Java 的强制类型转换 (X) obj，运行时不做任何检查，
 *      纯粹是"我向编译器保证这个值是 X 类型"。
 *
 *  【TS 语法速查】（针对本文件实际出现的语法）
 *
 *   - `type PluginCliCommand = 'install' | 'uninstall' | ...`
 *       字符串字面量联合类型 ≈ Java 的 enum。好处：写错拼写在编译期就报错，
 *       且编译器能帮你检查 switch 是否漏了分支。
 *
 *   - `function f(...): never`
 *       返回类型 never = "这个函数**永远不返回**"（要么抛异常，要么 exit 进程）。
 *       ≈ Java 没有直接对应；可理解为"方法保证不会正常 return"。
 *       有了它，编译器就知道调用点之后的代码不可达。
 *
 *   - `error: unknown`
 *       TS 的 unknown ≈ Java 的 Object，但**更严格**：用之前必须先做类型检查。
 *       比 `any` 安全得多。这是 catch 子句参数的标准写法（因为 JS 里能 throw 任何东西）。
 *
 *   - 默认参数 `scope: InstallableScope = 'user'`
 *       ≈ Java 的方法重载；TS 直接在参数后面写默认值，一行搞定。
 *
 *   - `...(marketplace && { _PROTO_marketplace_name: ... })`
 *       **条件展开**技巧：marketplace 有值时展开成 `{字段: 值}`，
 *       没值时 `false && {...}` 结果是 false，展开 false 等于什么都不加。
 *       效果：字段名只在该字段有值时才出现在对象里（而不是传一个 null）。
 *       ≈ Java 里要写 if 判断再 put，或构造 Map 时过滤。
 *
 *   - `(() => { ... })()`  立即执行函数表达式（IIFE）。
 *       ≈ Java 里没有；等价于把一段逻辑抽成一个局部方法然后立刻调用。
 *       这里用在三元表达式的分支里，因为分支位置只能放**表达式**不能放语句块。
 *
 *   - `...buildPluginTelemetryFields(...)` 把一个函数返回的对象**摊平**进外层对象，
 *       等价于把它的所有字段合并进来。≈ Java 的 map.putAll(...)。
 *
 *   - 模板字符串 `` `Installing plugin "${plugin}"...` ``
 *       ≈ Java 的字符串拼接 "Installing plugin \"" + plugin + "\"..."，
 *       但可以直接换行、可以嵌表达式，可读性高很多。
 *
 *   - `export { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES }`
 *       转手再导出（re-export）：本文件不定义它们，只是让 CLI 层能顺手从这里 import。
 *       ≈ Java 没有；可理解为"把别人的 public 常量再声明成自己的 public"。
 *
 *   - `// biome-ignore lint/...` 和 `// eslint-disable-next-line ...`
 *       给静态检查工具的行内豁免指令，只对**下一行**生效。
 *       这里是因为 CLI 工具**必须**用 console 输出，但 lint 规则默认禁止 console。
 *       ≈ Java 的 @SuppressWarnings("...")，但只作用于一行。
 */

import figures from 'figures'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { logError } from '../../utils/log.js'
import { getManagedPluginNames } from '../../utils/plugins/managedPlugins.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import type { PluginScope } from '../../utils/plugins/schemas.js'
import { writeToStdout } from '../../utils/process.js'
import {
  buildPluginTelemetryFields,
  classifyPluginCommandError,
} from '../../utils/telemetry/pluginTelemetry.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../analytics/index.js'
import {
  disableAllPluginsOp,
  disablePluginOp,
  enablePluginOp,
  type InstallableScope,
  installPluginOp,
  uninstallPluginOp,
  updatePluginOp,
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from './pluginOperations.js'

export { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES }

type PluginCliCommand =
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'disable-all'
  | 'update'

/**
 * Generic error handler for plugin CLI commands. Emits
 * tengu_plugin_command_failed before exit so dashboards can compute a
 * success rate against the corresponding success events.
 *
 * 【中文补充】所有插件 CLI 命令的统一失败收尾。
 *
 * 为什么需要它：7 个命令的失败处理逻辑完全一样（记日志 → 打印 ✗ → 打点 → exit 1），
 * 抽出来避免七处复制粘贴。更重要的是它保证**失败也一定会打点** ——
 * 否则监控系统只能看到成功数，永远算不出失败率（失败时没人上报 = 数据黑洞）。
 *
 * @param error   捕获到的异常，类型是 unknown（JS 里能 throw 任何东西，不能假设是 Error）
 * @param command 哪个子命令失败了，用于归类
 * @param plugin  插件标识符；disable-all 这类没有单个插件的命令就不传
 * @returns never —— 本函数**永不返回**，一定以 process.exit(1) 结束进程
 *
 * 关键步骤：
 *   ① logError 写日志（给开发者排查）
 *   ② 拼一句人话 operation 描述，打印到 stderr（给用户看）
 *   ③ 若能定位到具体插件，解析出 name/marketplace 并打点；否则只上报命令名
 *   ④ 上报 tengu_plugin_command_failed（含 error_category 分类）
 *   ⑤ process.exit(1) —— 非零退出码，让 shell 脚本/CI 能感知失败
 */
function handlePluginCommandError(
  error: unknown,
  command: PluginCliCommand,
  plugin?: string,
): never {
  logError(error)
  // 【中文】三元嵌套只为拼一句通顺的英文提示，没有业务含义：
  // 有 plugin → "install plugin "xxx""；disable-all → "disable all plugins"；其余 → "install plugins"
  const operation = plugin
    ? `${command} plugin "${plugin}"`
    : command === 'disable-all'
      ? 'disable all plugins'
      : `${command} plugins`
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(
    `${figures.cross} Failed to ${operation}: ${errorMessage(error)}`,
  )
  // 【中文】plugin 为空时（如 disable-all）遥测字段就是空对象 {}，
  // 靠后面的 `...telemetryFields` 摊平实现"有就加、没有就不加"。
  const telemetryFields = plugin
    // 【中文】这里用 IIFE（立刻执行的箭头函数）是因为三元分支里只能放表达式，
    // 不能写一串语句。Java 工程师可以理解为：临时定义个局部方法并马上调用它。
    ? (() => {
        const { name, marketplace } = parsePluginIdentifier(plugin)
        return {
          _PROTO_plugin_name:
            name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          ...(marketplace && {
            _PROTO_marketplace_name:
              marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          }),
          ...buildPluginTelemetryFields(
            name,
            marketplace,
            getManagedPluginNames(),
          ),
        }
      })()
    : {}
  logEvent('tengu_plugin_command_failed', {
    command:
      command as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_category: classifyPluginCommandError(
      error,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...telemetryFields,
  })
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

/**
 * CLI command: Install a plugin non-interactively
 * @param plugin Plugin identifier (name or plugin@marketplace)
 * @param scope Installation scope: user, project, or local (defaults to 'user')
 *
 * 【中文补充】`claude plugin install <plugin>` 的实现。
 *
 * 为什么需要它：非交互场景（CI 脚本、初始化脚本）没法用交互式面板，
 * 必须有一条命令能"一句话装好插件并给出明确退出码"。
 *
 * 关于 scope（作用域）——这是插件系统里最容易混淆的概念：
 *   user    ：装在**用户级**目录（~/.claude），你这台机器所有项目都能用
 *   project ：装在**项目级**（当前仓库内，配置会提交进 git），团队共享
 *   local   ：装在**项目本地**但不进 git（通常是 gitignore 的），只有你自己在这项目里能用
 * 类比 Java：user ≈ 全局 ~/.m2 仓库；project ≈ 项目里 pom.xml 声明的依赖；local ≈ 本地覆盖。
 * 默认 user 是"最不容易出错"的选择：不污染团队仓库，也不会被 .gitignore 意外吞掉。
 *
 * @param plugin 形如 "my-plugin" 或 "my-plugin@marketplace-name"
 * @param scope  装到哪个作用域，默认 user
 * @returns Promise<void>；成功时直接 exit(0)，失败时 exit(1)，**不会正常返回**
 *
 * 关键步骤：
 *   ① 打印"正在安装…"给用户一个即时反馈（网络操作前必须有反馈，否则像卡死）
 *   ② 调用内核层 installPluginOp 真正安装
 *   ③ 内核返回 {success:false} 而不是抛异常时，手动 throw ——
 *      统一成"失败即异常"，这样只有 catch 一处需要处理失败（见下方 ⑥）
 *   ④ 打印 ✓ 成功信息
 *   ⑤ 上报遥测（插件名/市场名/作用域/安装来源）
 *   ⑥ 任何异常交给 handlePluginCommandError 统一收尾
 */
export async function installPlugin(
  plugin: string,
  scope: InstallableScope = 'user',
): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`Installing plugin "${plugin}"...`)

    // 【中文】委托给内核层：本文件不关心"怎么装"，只关心"装完怎么告诉用户"
    const result = await installPluginOp(plugin, scope)

    // 【中文】内核层用返回值表示失败（不抛异常），这里转成 throw，
    // 目的：让失败路径只有 catch 一个出口，避免 success/error 两条路径各写一遍收尾。
    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${figures.tick} ${result.message}`)

    // _PROTO_* routes to PII-tagged plugin_name/marketplace_name BQ columns.
    // Unredacted plugin_id was previously logged to general-access
    // additional_metadata for all users — dropped in favor of the privileged
    // column route.
    //
    // 【中文】这段讲的是一次**隐私修复**：以前把完整的 plugin_id 明文写进
    // 任何人都能查的通用字段里，而 plugin_id 可能含私有仓库名（≈ 泄露内部信息）。
    // 现在改为写进 _PROTO_ 前缀的字段 —— 这个前缀会被日志管道路由到
    // 权限受限的 PII 专用列，普通权限的人查不到。
    // 【为什么优先用 result.pluginId 而不是入参 plugin】
    //   用户可能输入简写（不带 @marketplace），安装成功后内核会回一个
    //   完整规范化的 id，用它上报数据更准确。|| 是"前者没值就用后者"的兜底。
    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_installed_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope: (result.scope ||
        scope) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      install_source:
        'cli-explicit' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'install', plugin)
  }
}

/**
 * CLI command: Uninstall a plugin non-interactively
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Uninstall from scope: user, project, or local (defaults to 'user')
 *
 * 【中文补充】`claude plugin uninstall <plugin>` 的实现。
 *
 * @param plugin   插件标识符（"name" 或 "name@marketplace"）
 * @param scope    从哪个作用域卸载，默认 user
 * @param keepData 是否**保留**该插件的数据目录，默认 false（即默认删除）
 * @returns Promise<void>；成功 exit(0)，失败 exit(1)，不会正常返回
 *
 * 关键步骤：
 *   ① 调用内核层卸载。注意第三个参数传的是 `!keepData` —— 一次**取反**，因为
 *      对外暴露的 CLI 语义是 keepData（保留，默认否，符合"卸载就该干净"），
 *      而内核层的参数名是 removeData（删除），两者极性相反，所以取反。
 *      这种"外层用正向语义、内层用动作语义"的取反很容易看漏，阅读时要留意。
 *   ② 失败转 throw，统一由 catch 收尾
 *   ③ 打印 ✓、上报遥测
 *   ④ exit(0)
 *
 * 【为什么默认删数据？】插件数据目录里可能装着缓存、凭证、状态。
 * 默认保留会留下"卸载了但磁盘还在"的脏状态；但真有人想保留（比如重装后想恢复配置），
 * 所以留了 --keep-data 开关。默认安全、可选保留，是常见取舍。
 */
export async function uninstallPlugin(
  plugin: string,
  scope: InstallableScope = 'user',
  keepData = false,
): Promise<void> {
  try {
    // 【中文】⚠️ 极性反转：CLI 的 keepData=true 对应内核的 removeData=false
    const result = await uninstallPluginOp(plugin, scope, !keepData)

    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${figures.tick} ${result.message}`)

    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_uninstalled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope: (result.scope ||
        scope) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'uninstall', plugin)
  }
}

/**
 * CLI command: Enable a plugin non-interactively
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Optional scope. If not provided, finds the most specific scope for the current project.
 *
 * 【中文补充】`claude plugin enable <plugin>` 的实现。
 *
 * 【enable 与 install 的区别 —— 必须分清】
 *   install = 把插件的代码**拿下来**（下载/拷贝），装完默认是启用状态
 *   enable  = 插件**已经在磁盘上了**，只是把它从"禁用"切回"启用"
 * 类比 Java：install ≈ 往 ~/.m2 里下载 jar；enable ≈ 把 classpath 里注释掉的那行打开。
 * 所以"卸载又重装"和"禁用再启用"效果不同：前者会丢数据，后者不会。
 *
 * @param plugin 插件标识符
 * @param scope  可选。不传时内核会**自动挑最具体的那个作用域**
 *               （local > project > user，越具体优先级越高），
 *               这样在同时装了多个作用域副本时能命中正确的那个。
 * @returns Promise<void>；成功 exit(0)，失败 exit(1)
 *
 * 关键步骤：
 *   ① 调用内核层 enablePluginOp
 *   ② 失败转 throw 统一收尾
 *   ③ 打印 ✓、上报遥测（scope 直接用 result.scope，即内核最终决定的那个）
 *   ④ exit(0)
 */
export async function enablePlugin(
  plugin: string,
  scope?: InstallableScope,
): Promise<void> {
  try {
    // 【中文】scope 是 undefined 而非默认值 —— 这是刻意区分：
    // 不传 = "让内核自己找"，传 'user' = "明确指定 user"。若给默认值就丢失了这个区别。
    const result = await enablePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${figures.tick} ${result.message}`)

    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_enabled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope:
        result.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'enable', plugin)
  }
}

/**
 * CLI command: Disable a plugin non-interactively
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Optional scope. If not provided, finds the most specific scope for the current project.
 *
 * 【中文补充】`claude plugin disable <plugin>` 的实现（enable 的逆向操作）。
 *
 * 为什么需要它：插件出问题时（比如它注入的提示词让模型行为异常），
 * 用户第一需求是"先让它别生效"，而不是删掉它 —— 禁用是可逆的、零成本的止血手段。
 * 这是排障路径上的关键一步：disable → 确认问题消失 → 再决定是 update 还是 uninstall。
 *
 * @param plugin 插件标识符
 * @param scope  可选；不传则交给内核挑最具体的作用域（同 enablePlugin）
 * @returns Promise<void>；成功 exit(0)，失败 exit(1)
 *
 * 关键步骤：
 *   ① 调内核层 disablePluginOp（只是改一个"禁用标记"，不删任何文件）
 *   ② 失败转 throw 统一收尾
 *   ③ 打印 ✓、上报遥测
 *   ④ exit(0)
 */
export async function disablePlugin(
  plugin: string,
  scope?: InstallableScope,
): Promise<void> {
  try {
    // 【中文】禁用 ≠ 卸载：文件、配置、数据全都还在，只是不加载它
    const result = await disablePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${figures.tick} ${result.message}`)

    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_disabled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope:
        result.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'disable', plugin)
  }
}

/**
 * CLI command: Disable all enabled plugins non-interactively
 *
 * 【中文补充】`claude plugin disable-all` 的实现 —— 一键禁用全部插件。
 *
 * 为什么需要它（这是个"救命"命令）：
 *   当某个插件把 Claude Code 搞坏了（注入了坏提示词、注册了疯狂的工具、
 *   甚至启动就崩），用户需要一个**不需要知道是哪个插件坏了**的复位手段。
 *   一键全禁用 → 确认系统恢复正常 → 再逐个启用排查。
 *   类比 Java：≈ JVM 启动时加 `-DskipAllAutoConfiguration` 排除所有自动配置，
 *   是排查 Spring Boot 自动配置冲突的标准第一步。
 *
 * @returns Promise<void>；成功 exit(0)，失败 exit(1)
 *
 * 关键步骤：
 *   ① 调内核层 disableAllPluginsOp（不涉及具体插件，所以不需要解析标识符）
 *   ② 失败转 throw 统一收尾
 *   ③ 打印 ✓
 *   ④ 上报遥测 —— 注意传的是**空对象 {}**：
 *      因为这条命令没有单个插件可上报，上报插件名毫无意义（甚至是隐私风险）
 *   ⑤ exit(0)
 */
export async function disableAllPlugins(): Promise<void> {
  try {
    const result = await disableAllPluginsOp()

    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${figures.tick} ${result.message}`)

    // 【中文】空对象：这条命令确实没有任何有价值的附加维度可上报，
    // 事件本身（发生了 disable-all）才是唯一信息量。
    logEvent('tengu_plugin_disabled_all_cli', {})

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'disable-all')
  }
}

/**
 * CLI command: Update a plugin non-interactively
 * @param plugin Plugin name or plugin@marketplace identifier
 * @param scope Scope to update
 *
 * 【中文补充】`claude plugin update <plugin> --scope` 的实现。
 *
 * 为什么需要它：marketplace 上游会发布新版本（修 bug、加命令），
 * 用户需要一条命令把本地副本拉到最新。本质上是"对某个插件再做一次安装动作"。
 *
 * 【本函数与 install 的三点不同】
 *   ① 用 writeToStdout 而不是 console.log
 *      为什么？console.log 可能走异步缓冲/被上层格式化，而 stdout 写入更可控，
 *      能保证输出顺序与内容精确（尤其"…"省略号和 \n 都要原样呈现）。
 *      另外本命令最后用 gracefulShutdown，**不**用 process.exit(0)，
 *      两者配合才能保证输出被 flush 干净、不被截断。
 *   ② 只在**真的更新了**时才上报遥测（见 result.alreadyUpToDate 判断）。
 *      为什么？"检查发现已是最新"是绝大多数情况，全量上报会把 "updated" 这个
 *      指标稀释成"检查次数"，监控系统就失去意义了。
 *   ③ scope 是**必填**（类型 PluginScope 没有默认值），
 *      因为更新必须明确"更新哪个副本"，猜错作用域会更新到用户没预期的那份。
 *
 * @param plugin 插件标识符
 * @param scope  必填，要更新哪个作用域下的副本
 * @returns Promise<void>；成功后 gracefulShutdown(0)，失败 exit(1)
 *
 * 关键步骤：
 *   ① 先打印"正在检查更新…"（网络操作前的反馈）
 *   ② 调内核层 updatePluginOp
 *   ③ 失败转 throw 统一收尾
 *   ④ 打印 ✓ 结果（无论是否真更新都打印，让用户知道结论）
 *   ⑤ 若确实更新了，上报 old_version / new_version（版本号对排查兼容性问题极重要）
 *   ⑥ gracefulShutdown(0)：优雅退出，先让未完成的写盘/网络收尾再结束进程
 */
export async function updatePluginCli(
  plugin: string,
  scope: PluginScope,
): Promise<void> {
  try {
    // 【中文】注意这个 "…" 是省略号字符不是三个点，配合下面的 \n 手工控制换行
    writeToStdout(
      `Checking for updates for plugin "${plugin}" at ${scope} scope…\n`,
    )

    const result = await updatePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    writeToStdout(`${figures.tick} ${result.message}\n`)

    // 【中文】已经是最新就不上报：避免把 "更新次数" 指标污染成 "检查次数"
    if (!result.alreadyUpToDate) {
      const { name, marketplace } = parsePluginIdentifier(
        result.pluginId || plugin,
      )
      logEvent('tengu_plugin_updated_cli', {
        _PROTO_plugin_name:
          name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        ...(marketplace && {
          _PROTO_marketplace_name:
            marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        }),
        old_version: (result.oldVersion ||
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        new_version: (result.newVersion ||
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...buildPluginTelemetryFields(
          name,
          marketplace,
          getManagedPluginNames(),
        ),
      })
    }

    // 【中文】用 gracefulShutdown 而不是 process.exit(0)：
    // 更新可能涉及写配置文件、关 MCP 连接，硬 exit 可能丢数据/留半成品。
    // gracefulShutdown 会先把这类收尾动作做完再退出，代价是稍慢一点。
    await gracefulShutdown(0)
  } catch (error) {
    handlePluginCommandError(error, 'update', plugin)
  }
}
