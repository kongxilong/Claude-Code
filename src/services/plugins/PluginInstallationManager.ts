/**
 * Background plugin and marketplace installation manager
 *
 * This module handles automatic installation of plugins and marketplaces
 * from trusted sources (repository and user settings) without blocking startup.
 */

/**
 * ============================================================================
 *  【文件总览】PluginInstallationManager.ts —— 启动时的后台插件/市场安装器
 * ============================================================================
 *
 *  一句话定位：
 *  本文件负责「应用启动阶段，在后台偷偷把该装的 marketplace 装好」，
 *  全程**不阻塞启动**（用户不用干等 git clone）。
 *
 *  【plugin（插件）与 marketplace（市场）是什么？——读本目录前必须先懂】
 *
 *    marketplace（插件市场）：
 *        一个**存放插件清单的仓库**（通常是 git 仓库或本地目录）。
 *        它本身不提供功能，只是个"目录/黄页"，告诉 Claude Code：
 *        "我这有这些插件，它们的源码在某某路径/某某 git 地址"。
 *        类比 Java：marketplace ≈ Maven 的 repository（仓库），
 *        里面是一堆 artifact 的索引。
 *
 *    plugin（插件）：
 *        一个**真正的功能包**，可以往 Claude Code 里"贡献"三样东西：
 *          1) 自定义斜杠命令（/mycmd）—— 见本目录 pluginOperations.ts 的命令注册
 *          2) MCP server / 工具（tools）—— 让模型能调用新的工具
 *          3) Agent（子代理定义）—— 预置的专家人格
 *        类比 Java：plugin ≈ 一个被打好的 jar 包，自己能提供服务。
 *
 *    两者关系：先装 marketplace（拿到目录），再从目录里挑 plugin 装（拿到功能）。
 *    所以"装 marketplace"这一步本质上常常是一次 **git clone**，很慢，
 *    必须放后台做 —— 这正是本文件存在的唯一理由。
 *
 *  【在架构中的位置】
 *
 *      应用启动 (src/entrypoints / REPL 初始化)
 *        └─> performBackgroundPluginInstallations(setAppState)   ← ★ 本文件唯一导出
 *              ├─> getDeclaredMarketplaces()          ← 读"声明了哪些市场"（来自 .claude/settings 等配置）
 *              ├─> loadKnownMarketplacesConfig()      ← 读"本地实际已装了哪些市场"
 *              ├─> diffMarketplaces(declared, 已装)   ← 求出差集：缺哪些、哪些源变了
 *              ├─> reconcileMarketplaces({onProgress})← 真正执行 clone/更新（慢）
 *              │        └─ 每步回调 onProgress → 本文件把它翻译成 UI 状态
 *              └─> refreshActivePlugins(setAppState)  ← 装完后刷新插件缓存 + 重连 MCP
 *
 *    注意本文件**不自己干活**：它只是个"编排 + 状态搬运工"，
 *    真正的 git 操作在 ../../utils/plugins/reconciler.ts 里。
 *
 *  【本文件包含什么】（只有 2 个函数）
 *   1. updateMarketplaceStatus()              把某个市场的状态写进 AppState（供 UI 渲染进度）
 *   2. performBackgroundPluginInstallations() 唯一对外入口：diff → 安装 → 刷新/提示
 *
 *  【TS 语法速查】（针对本文件实际出现的语法）
 *   - `type SetAppState = (f: (prev: AppState) => AppState) => void`
 *       类型别名，这里是「函数类型」。≈ Java 的 functional interface：
 *       `interface SetAppState { void apply(Function<AppState,AppState> f); }`
 *       注意它接收的不是新状态，而是**一个更新函数**（React setState 风格），
 *       这样能基于"最新"的旧状态计算新值，避免并发写覆盖。
 *
 *   - `'pending' | 'installing' | 'installed' | 'failed'`
 *       字符串字面量联合类型 ≈ Java 的 enum，但编译后就是普通字符串，
 *       写错一个字母编译器立刻报错（比 enum 更轻）。
 *
 *   - `status: 'pending' as const`
 *       `as const` 把字面量类型"钉死"成 'pending' 而不是宽泛的 string。
 *       ≈ Java 里没有；可理解为"告诉编译器别把类型放大"。
 *
 *   - `...prevState` 展开运算符做**不可变更新**：
 *       不修改原对象，而是 `{...旧对象, 被改字段: 新值}` 复制一份。
 *       ≈ Java 没有；想象成 new 一个副本再 set。
 *       本文件嵌套了 3 层展开（AppState → plugins → installationStatus），
 *       因为状态是树形结构，改深层字段必须逐层复制，否则会破坏不可变性。
 *
 *   - `.map(m => (m.name === name ? { ...m, status, error } : m))`
 *       ≈ Java stream().map(...)；箭头函数 ≈ lambda。
 *       这里用三元运算符实现"只改匹配的那一个，其余原样返回"。
 *
 *   - `error?: string`  可选参数，等价于 `error: string | undefined`。
 *       ≈ Java 里没有，只能靠 @Nullable 或重载模拟。
 *
 *   - `await loadKnownMarketplacesConfig().catch(() => ({}))`
 *       Promise 的 catch ≈ try-catch 的异步版；这里失败就退化成空对象，
 *       表示"当作一个都没装过"。≈ Java CompletableFuture.exceptionally(...)
 *
 *   - `prev => { if (cond) return prev; return {...} }`
 *       返回**原对象本身**是 React 系框架的"无需更新"信号：
 *       引用没变 → 框架跳过重渲染。这是性能优化，不是笔误。
 */

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { logError } from '../../utils/log.js'
import {
  clearMarketplacesCache,
  getDeclaredMarketplaces,
  loadKnownMarketplacesConfig,
} from '../../utils/plugins/marketplaceManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import {
  diffMarketplaces,
  reconcileMarketplaces,
} from '../../utils/plugins/reconciler.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { logEvent } from '../analytics/index.js'

type SetAppState = (f: (prevState: AppState) => AppState) => void

/**
 * Update marketplace installation status in app state
 *
 * 【中文补充】把某个 marketplace 的安装状态写进全局 AppState，供 REPL UI 画进度条。
 *
 * 为什么需要它：安装是后台异步跑的，UI 必须有个地方能看到"现在装到哪了"，
 * 否则用户只看到黑屏。这里把后台任务的进度事件翻译成 UI 能读的状态树。
 *
 * @param setAppState 状态更新函数（接收"旧状态 → 新状态"的纯函数，不是直接传新值）
 * @param name        要更新哪个 marketplace 的名字（唯一键）
 * @param status      四态机：pending(排队) → installing(正在 clone) → installed/failed(终态)
 * @param error       失败原因；成功时省略（可选参数）
 * @returns 无返回值，副作用就是改 AppState
 *
 * 关键步骤：
 *   ① 用 setAppState(prevState => ...) 拿到当前最新状态（避免读取到过期快照）
 *   ② 逐层展开（AppState → plugins → installationStatus）保持不可变更新语义
 *   ③ 在 marketplaces 数组里按 name 找到目标项，替换它；其余项原样返回（不影响它们）
 *
 * 【注意】这里用的是"先 diff 出 pendingNames 再 map"的两段式：
 * 状态数组在初始化时就建好了，之后只做**更新**不做新增，所以找不到就等于没变化。
 */
function updateMarketplaceStatus(
  setAppState: SetAppState,
  name: string,
  status: 'pending' | 'installing' | 'installed' | 'failed',
  error?: string,
): void {
  setAppState(prevState => ({
    ...prevState,
    plugins: {
      ...prevState.plugins,
      installationStatus: {
        ...prevState.plugins.installationStatus,
        // 只替换 name 命中的那一项；其余项返回原引用（省一次对象分配，也保持引用稳定）
        marketplaces: prevState.plugins.installationStatus.marketplaces.map(
          m => (m.name === name ? { ...m, status, error } : m),
        ),
      },
    },
  }))
}

/**
 * Perform background plugin startup checks and installations.
 *
 * This is a thin wrapper around reconcileMarketplaces() that maps onProgress
 * events to AppState updates for the REPL UI. After marketplaces are
 * reconciled:
 * - New installs → auto-refresh plugins (fixes "plugin-not-found" errors
 *   from the initial cache-only load on fresh homespace/cleared cache)
 * - Updates only → set needsRefresh, show notification for /reload-plugins
 *
 * 【中文补充】启动时后台安装 marketplace 的总入口。
 *
 * 为什么需要它（不复述代码，讲动机）：
 *   声明式配置的代价是"声明 ≠ 已装好"。用户在 settings 里写"我要用 A 市场"，
 *   但本机磁盘上可能根本没有 A 的代码。若不自动补装，用户一进来就会遇到
 *   "Plugin not found" —— 而这个错误对用户来说是莫名其妙的（他明明配置了）。
 *   所以必须在启动时把"声明"和"现实"对齐，这就是这里的 reconcile（对账）。
 *
 *   又为什么必须放后台：marketplace 的安装往往是 git clone，可能几秒到几十秒。
 *   如果放在启动主流程里同步 await，用户就得干等着进不去 REPL。
 *   所以本函数是 async 但不被阻塞式等待，UI 通过 AppState 观察进度。
 *
 * @param setAppState 用于把进度写进全局状态（UI 从中读）
 * @returns Promise<void>：不返回结果，结果全靠 AppState 和日志表达
 *
 * 关键步骤：
 *   ① 先算 diff（哪些缺、哪些源变了），据此给 UI 铺一排 pending 转圈
 *   ② 若没有待装项，直接 return（快路径，绝大多数启动走这条）
 *   ③ 调 reconcileMarketplaces 真正安装，并用 onProgress 回调把事件翻成 UI 状态
 *   ④ 打点上报统计（装了几个/更新了几个/失败几个）
 *   ⑤ 装过新的 → 自动 refreshActivePlugins（让用户立刻能用）
 *      只是更新 → 仅置 needsRefresh，让用户自己决定何时 /reload-plugins
 *
 * 【为什么"装新的"和"只更新"处理不同？】
 *   新装：用户**明确期待**马上能用，不自动刷新就会报 plugin-not-found，属于 bug 级体验问题。
 *   更新：用户的插件本来就能用，只是版本旧了。立刻换掉可能打断他正在做的事，
 *         所以只提示"有新版本，需要时执行 /reload-plugins"，把控制权留给人。
 *
 * 【异常处理策略】整个函数体被 try/catch 包住，catch 里只 logError 不 rethrow。
 *   这是刻意的：后台任务失败绝不能让应用起不来 —— 插件是增强项，不是生存依赖。
 */
export async function performBackgroundPluginInstallations(
  setAppState: SetAppState,
): Promise<void> {
  logForDebugging('performBackgroundPluginInstallations called')

  try {
    // Compute diff upfront for initial UI status (pending spinners)
    // 【中文】先把"该有什么"和"实际有什么"做差集，纯粹为了 UI 能提前显示转圈：
    // 用户看到 pending 比看到一片空白更安心，这是感知性能的考量。
    const declared = getDeclaredMarketplaces()
    // 【中文】读本地已装配置；读失败（文件损坏/首次运行）就当"一个都没装"，
    // 结果是所有声明项都进入 missing，从而被重装 —— 失败即自愈。
    const materialized = await loadKnownMarketplacesConfig().catch(() => ({}))
    const diff = diffMarketplaces(declared, materialized)

    // 【中文】两类需要处理的：① 完全缺失的 ② 存在但"来源变了"的（比如 git 地址改了）
    // 第②类必须重装：源都换了，本地那份是旧的、不可信的。
    const pendingNames = [
      ...diff.missing,
      ...diff.sourceChanged.map(c => c.name),
    ]

    // Initialize AppState with pending status. No per-plugin pending status —
    // plugin load is fast (cache hit or local copy); marketplace clone is the
    // slow part worth showing progress for.
    // 【中文】这里刻意**不**给单个 plugin 铺 pending 状态：
    // plugin 的加载走缓存或本地副本，是毫秒级，展示进度反而会闪一下很难看；
    // marketplace 的 git clone 才是秒级以上的慢操作，值得做进度展示。
    // 这是"只对真正慢的东西显示进度"的取舍。
    setAppState(prev => ({
      ...prev,
      plugins: {
        ...prev.plugins,
        installationStatus: {
          marketplaces: pendingNames.map(name => ({
            name,
            status: 'pending' as const,
          })),
          plugins: [],
        },
      },
    }))

    // 【中文】快路径：一切齐备（绝大多数正常启动走这里），什么都不做直接返回。
    // 放在铺完 pending 状态**之后**返回，是为了保证 AppState 至少被初始化成"空列表"，
    // 否则 UI 可能读到上一次残留的旧状态。
    if (pendingNames.length === 0) {
      return
    }

    logForDebugging(
      `Installing ${pendingNames.length} marketplace(s) in background`,
    )

    // 【中文】真正的安装动作委托给 reconciler（git clone / 更新都发生在那里）。
    // 本文件通过 onProgress 回调"订阅"进度 —— 这是典型的**观察者/回调**解耦：
    // 底层不需要知道 UI 长什么样，只需要吐事件。≈ Java 的 Consumer<Event> 监听器。
    const result = await reconcileMarketplaces({
      onProgress: event => {
        switch (event.type) {
          case 'installing':
            updateMarketplaceStatus(setAppState, event.name, 'installing')
            break
          case 'installed':
            updateMarketplaceStatus(setAppState, event.name, 'installed')
            break
          case 'failed':
            updateMarketplaceStatus(
              setAppState,
              event.name,
              'failed',
              event.error,
            )
            break
        }
      },
    })

    // 【中文】只上报**数量**不报名字：日志系统禁止记 PII（个人可识别信息），
    // 而 marketplace 名字可能含用户名/私有仓库名。用 count 既满足统计又不泄密。
    const metrics = {
      installed_count: result.installed.length,
      updated_count: result.updated.length,
      failed_count: result.failed.length,
      up_to_date_count: result.upToDate.length,
    }
    logEvent('tengu_marketplace_background_install', metrics)
    logForDiagnosticsNoPII(
      'info',
      'tengu_marketplace_background_install',
      metrics,
    )

    if (result.installed.length > 0) {
      // New marketplaces were installed — auto-refresh plugins. This fixes
      // "Plugin not found in marketplace" errors from the initial cache-only
      // load (e.g., fresh homespace where marketplace cache was empty).
      // refreshActivePlugins clears all caches, reloads plugins, and bumps
      // pluginReconnectKey so MCP connections are re-established.
      //
      // 【中文】为什么新装完必须 refresh：启动时插件是**只读缓存**加载的（快），
      // 那时市场还没 clone 下来，缓存里自然是空的 → 报 "plugin not found"。
      // 现在装好了，必须清缓存重新扫一遍磁盘。
      // 另外 pluginReconnectKey 自增是为了让 MCP 连接重建 ——
      // MCP server 是有状态的连接，光重新加载插件定义不会自动重连，
      // 需要靠这个 key 变化去"戳"一下连接层（类似 React 用 key 强制重挂载组件）。
      clearMarketplacesCache()
      logForDebugging(
        `Auto-refreshing plugins after ${result.installed.length} new marketplace(s) installed`,
      )
      try {
        await refreshActivePlugins(setAppState)
      } catch (refreshError) {
        // If auto-refresh fails, fall back to needsRefresh notification so
        // the user can manually run /reload-plugins to recover.
        //
        // 【中文】降级策略：自动刷新失败时不能就这么算了，否则用户会卡在
        // "装好了但还是找不到插件"的诡异状态。退而求其次：置 needsRefresh，
        // 让 UI 提示用户手动 /reload-plugins。这体现了"自动失败 → 给人工出口"的设计。
        logError(refreshError)
        logForDebugging(
          `Auto-refresh failed, falling back to needsRefresh: ${refreshError}`,
          { level: 'warn' },
        )
        clearPluginCache(
          'performBackgroundPluginInstallations: auto-refresh failed',
        )
        setAppState(prev => {
          if (prev.plugins.needsRefresh) return prev
          return {
            ...prev,
            plugins: { ...prev.plugins, needsRefresh: true },
          }
        })
      }
    } else if (result.updated.length > 0) {
      // Existing marketplaces updated — notify user to run /reload-plugins.
      // Updates are less urgent and the user should choose when to apply them.
      //
      // 【中文】只有更新（没有新装）时**不**自动刷新：
      // 插件此刻是能用的，贸然换版本可能打断用户手上的活儿。
      // 所以只打个标记让 UI 提示"有新版本"，由用户挑时机执行 /reload-plugins。
      clearMarketplacesCache()
      clearPluginCache(
        'performBackgroundPluginInstallations: marketplaces reconciled',
      )
      setAppState(prev => {
        if (prev.plugins.needsRefresh) return prev
        return {
          ...prev,
          plugins: { ...prev.plugins, needsRefresh: true },
        }
      })
    }
  } catch (error) {
    // 【中文】最外层的兜底：后台安装属于"增强功能"，任何异常都只记日志、绝不往外抛。
    // 理由：如果这里 throw，调用方若没接住就会导致应用启动失败 ——
    // 为了一个插件装不上而让用户整个 Claude Code 打不开，是完全不可接受的。
    logError(error)
  }
}
