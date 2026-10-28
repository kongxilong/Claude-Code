/**
 * 【一句话定位】MCP 连接的「总调度」React Hook：建连、状态同步到 AppState、掉线自动重连、手动重连/启停。
 *
 * 【在架构中的位置】
 * - 上游：MCPConnectionManager.tsx（唯一的调用者，把本 hook 产出的两个函数广播给整棵组件树）。
 * - 下游：client.ts（真正建连、拉 tools/commands/resources）、config.ts（读配置、读写启用状态）、
 *   channelNotification.ts（channel 准入与入站消息）、elicitationHandler.ts（注册询问处理器）、
 *   utils.ts（剔除过期 client）。
 *
 * 【本文件包含什么】
 * - getErrorKey / addErrorsToAppState：插件错误的去重与上报。
 * - useManageMCPConnections：主 hook，返回 { reconnectMcpServer, toggleMcpServer }。
 * - 内部：flushPendingUpdates / updateServer（批量状态更新）、onConnectionAttempt（连接结果分派）、
 *   两个 useEffect（初始化为 pending、两阶段加载并建连）、卸载清理 effect。
 * - getTransportDisplayName：把 transport 类型翻成人话（日志用）。
 *
 * 【三个 useEffect 分别干什么】
 * ① initializeServersAsPending：把配置里的 server 先置为 pending（UI 立刻能看到），并清掉过期 client。
 * ② loadAndConnectMcpConfigs：两阶段加载——先快（本地/插件配置）后慢（claude.ai 组织配置），边加载边连。
 * ③ 卸载清理：清掉所有重连定时器、冲刷未落库的状态更新。
 *
 * 【为什么要「批量更新」AppState】
 * 几十个 server 的回调会在很短时间内陆续到达，每个都 setAppState 一次会导致大量重渲染；
 * 这里用一个 16ms 的时间窗口把更新攒起来，一次提交。
 *
 * 【TS / React 语法速查】
 * - `useRef<T>(init)`：跨渲染保持不变的可变容器，≈ 一个不会触发重渲染的成员变量；
 *   `.current` 读写。这里用它存定时器 Map、去重 Set、回调对象。
 * - `useCallback(fn, deps)`：缓存函数引用，deps 不变就不重建 ≈ 避免无谓的重新订阅。
 * - `useEffect(fn, deps)`：deps 变化时执行；返回的函数是「清理函数」（组件卸载或 deps 变化时调用）。
 * - `feature('XXX')`：`bun:bundle` 的编译期特性开关 ≈ C 的 #ifdef，关掉时代码被整段删掉。
 * - `void someAsyncCall()`：明确丢弃 Promise（fire-and-forget），配合 .catch 防止未处理拒绝。
 * - `setAppState(prev => newState)`：函数式更新，必须用「旧状态 → 新状态」的纯函数。
 * - `Object.fromEntries(Object.entries(x).filter(...))`：对象的「filter」惯用写法
 *   （≈ Java stream.collect(Collectors.toMap)）。
 * - `A & B` 交叉类型：`MCPServerConnection & { tools?: Tool[] }` 表示「连接状态 + 可选的产物」。
 * - `for await` / `async function*`：本文件没用，但 client.ts 里有（≈ Java 的 Flux 流式）。
 */
import { feature } from 'bun:bundle'
import { basename } from 'path'
import { useCallback, useEffect, useRef } from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import {
  clearServerCache,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getMcpToolsCommandsAndResources,
  reconnectMcpServerImpl,
} from './client.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? (
      require('../../skills/mcpSkills.js') as typeof import('../../skills/mcpSkills.js')
    ).fetchMcpSkillsForClient
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (
      require('../skillSearch/localSearch.js') as typeof import('../skillSearch/localSearch.js')
    ).clearSkillIndexCache
  : null

import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  dedupClaudeAiMcpServers,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getClaudeCodeMcpConfigs,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from 'src/services/mcp/config.js'
import type { AppState } from 'src/state/AppState.js'
import type { PluginError } from 'src/types/plugin.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getAllowedChannels } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../../state/AppState.js'
import { errorMessage } from '../../utils/errors.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import {
  CHANNEL_PERMISSION_METHOD,
  ChannelMessageNotificationSchema,
  ChannelPermissionNotificationSchema,
  findChannelEntry,
  gateChannelServer,
  wrapChannelMessage,
} from './channelNotification.js'
import {
  type ChannelPermissionCallbacks,
  createChannelPermissionCallbacks,
  isChannelPermissionRelayEnabled,
} from './channelPermissions.js'
import {
  clearClaudeAIMcpConfigsCache,
  fetchClaudeAIMcpConfigsIfEligible,
} from './claudeai.js'
import { registerElicitationHandler } from './elicitationHandler.js'
import { getMcpPrefix } from './mcpStringUtils.js'
import { commandBelongsToServer, excludeStalePluginClients } from './utils.js'

// Constants for reconnection with exponential backoff
const MAX_RECONNECT_ATTEMPTS = 5
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
  // 中文：指数退避三件套：最多重试 5 次、起始 1 秒、上限 30 秒（1→2→4→8→16→30）

/**
 * Create a unique key for a plugin error to enable deduplication
 */
  /**
   * 中文：给插件错误算一个去重键（type + source + plugin）。
   * 为什么需要去重：同一个错误会在多次渲染/重连里反复上报，UI 上会出现一堆一样的红字。
   */
function getErrorKey(error: PluginError): string {
  const plugin = 'plugin' in error ? error.plugin : 'no-plugin'
  return `${error.type}:${error.source}:${plugin}`
}

/**
 * Add errors to AppState, deduplicating to avoid showing the same error multiple times
 */
  /**
   * 中文：把新错误加进 AppState，自动跳过已经存在的（按 getErrorKey 判重）。
   * 一个都没有要加时返回 prevState 本身（同一个引用 → React 跳过重渲染）。
   */
function addErrorsToAppState(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  newErrors: PluginError[],
): void {
  if (newErrors.length === 0) return

  setAppState(prevState => {
    // Build set of existing error keys
    const existingKeys = new Set(
      prevState.plugins.errors.map(e => getErrorKey(e)),
    )

    // Only add errors that don't already exist
    // 中文：先把已有错误做成 Set，再过滤新错误——O(n+m) 而不是 O(n*m)
    const uniqueNewErrors = newErrors.filter(
      error => !existingKeys.has(getErrorKey(error)),
    )

    if (uniqueNewErrors.length === 0) {
      return prevState
    }

    return {
      ...prevState,
      plugins: {
        ...prevState.plugins,
        errors: [...prevState.plugins.errors, ...uniqueNewErrors],
      },
    }
  })
}

/**
 * Hook to manage MCP (Model Context Protocol) server connections and updates
 *
 * This hook:
 * 1. Initializes MCP client connections based on config
 * 2. Sets up handlers for connection lifecycle events and sync with app state
 * 3. Manages automatic reconnection for SSE connections
 * 4. Returns a reconnect function
 */
  /**
   * 中文：★ 主 hook。管理所有 MCP server 的连接生命周期。
   * 入参 dynamicMcpConfig：运行时动态下发的配置（如 --mcp-config、插件提供的）；
   *     isStrictMcpConfig：true 表示「只准用 dynamicMcpConfig」，忽略本地/用户/项目配置。
   * 返回 { reconnectMcpServer, toggleMcpServer }：手动重连某个 server、切换启用状态。
   * 职责（对应英文注释的 4 条）：
   *   ① 按配置初始化连接；② 处理连接生命周期事件并同步到 AppState；
   *   ③ 远程 transport 掉线后自动重连（指数退避）；④ 对外暴露手动重连能力。
   */
export function useManageMCPConnections(
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined,
  isStrictMcpConfig = false,
) {
  // 中文：拿到 store 本身（不是快照）——下面重连/启停时要读「当前最新」的 clients，
  //       用 useAppState 拿到的是快照，可能是过期的
  const store = useAppStateStore()
  // 中文：★ 下面两行读到的值本身都没用到（变量名带下划线前缀就是「故意不用」的标记），
  //       目的只是让本 hook 在 authVersion / pluginReconnectKey 变化时重新执行（登录、/reload-plugins）
  const _authVersion = useAppState(s => s.authVersion)
  // Incremented by /reload-plugins (refreshActivePlugins) to pick up newly
  // enabled plugin MCP servers. getClaudeCodeMcpConfigs() reads loadAllPlugins()
  // which has been cleared by refreshActivePlugins, so the effects below see
  // fresh plugin data on re-run.
  const _pluginReconnectKey = useAppState(s => s.mcp.pluginReconnectKey)
    // 中文：/reload-plugins 会递增这个值；因为 getClaudeCodeMcpConfigs 内部读的插件缓存已被清掉，
    //       重跑 effect 就能看到新启用的插件 server
  const setAppState = useSetAppState()

  // Track active reconnection attempts to allow cancellation
  const reconnectTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
    // 中文：server 名 → 重连定时器，用于「取消上一个还没触发的重连」

  // Dedup the --channels blocked warning per skip kind so that a user who
  // sees "run /login" (auth skip), logs in, then hits the policy gate
  // gets a second toast.
  const channelWarnedKindsRef = useRef<
    Set<'disabled' | 'auth' | 'policy' | 'marketplace' | 'allowlist'>
  >(new Set())
    // 中文：记录已经提示过哪一类 channel 拦截原因，同一类只提示一次（否则每次重连都弹）
  // Channel permission callbacks — constructed once, stable ref. Stored in
  // AppState so interactiveHandler can subscribe. The pending Map lives inside
  // the closure (not module-level, not AppState — functions-in-state is brittle).
  const channelPermCallbacksRef = useRef<ChannelPermissionCallbacks | null>(
    null,
  )
  // 中文：feature() 是编译期开关（≈ #ifdef），关闭时整段代码不会进产物；
  //       这里只在通道功能开启时才构造权限回调对象，且只构造一次（ref 保证引用稳定）
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    channelPermCallbacksRef.current === null
  ) {
    channelPermCallbacksRef.current = createChannelPermissionCallbacks()
  }
  // Store callbacks in AppState so interactiveHandler.ts can reach them via
  // ctx.toolUseContext.getAppState(). One-time set — the ref is stable.
  // 中文：把回调对象放进 AppState，interactiveHandler.ts 才能拿到它并注册等待者
  useEffect(() => {
    if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
      const callbacks = channelPermCallbacksRef.current
      if (!callbacks) return
      // GrowthBook runtime gate — separate from channels so channels can
      // ship without this. Checked at mount; mid-session flips need restart.
      // If off, callbacks never go into AppState → interactiveHandler sees
      // undefined → never sends → intercept has nothing pending → "yes tbxkq"
      // flows to Claude as normal chat. One gate, full disable.
      if (!isChannelPermissionRelayEnabled()) return
      setAppState(prev => {
        if (prev.channelPermissionCallbacks === callbacks) return prev
        return { ...prev, channelPermissionCallbacks: callbacks }
      })
      return () => {
        setAppState(prev => {
          if (prev.channelPermissionCallbacks === undefined) return prev
          return { ...prev, channelPermissionCallbacks: undefined }
        })
      }
    }
  }, [setAppState])
  const { addNotification } = useNotifications()

  // Batched MCP state updates: queue individual server updates and flush them
  // in a single setAppState call via setTimeout. Using a time-based window
  // (instead of queueMicrotask) ensures updates are batched even when
  // connection callbacks arrive at different times due to network I/O.
  const MCP_BATCH_FLUSH_MS = 16
  // 中文：16ms ≈ 一帧。用时间窗口而不是 queueMicrotask，是因为连接回调会因网络 I/O 在不同时刻到达，
  //       微任务合并不到它们；时间窗口能把「陆续到达」的更新攒成一批
  // 中文：PendingUpdate = 一个 client 的状态 + 它带来的 tools/commands/resources（都可缺省）
  type PendingUpdate = MCPServerConnection & {
    tools?: Tool[]
    commands?: Command[]
    resources?: ServerResource[]
  }
  const pendingUpdatesRef = useRef<PendingUpdate[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 中文：把攒下来的更新一次性提交；下面 updateServer 只是「入队 + 起定时器」
  const flushPendingUpdates = useCallback(() => {
    flushTimerRef.current = null
    const updates = pendingUpdatesRef.current
    if (updates.length === 0) return
    pendingUpdatesRef.current = []

    setAppState(prevState => {
      let mcp = prevState.mcp

  // 中文：逐个更新合并进同一个 mcp 对象，循环里始终用局部变量 mcp 累加，最后一次性返回
      for (const update of updates) {
        const {
          tools: rawTools,
          commands: rawCmds,
          resources: rawRes,
          ...client
        } = update
  // 中文：disabled / failed 时即使调用方没传 tools，也要清空（避免残留旧工具被模型继续调用）
        const tools =
          client.type === 'disabled' || client.type === 'failed'
            ? (rawTools ?? [])
            : rawTools
        const commands =
          client.type === 'disabled' || client.type === 'failed'
            ? (rawCmds ?? [])
            : rawCmds
        const resources =
          client.type === 'disabled' || client.type === 'failed'
            ? (rawRes ?? [])
            : rawRes

        const prefix = getMcpPrefix(client.name)
  // 中文：用 server 前缀定位「属于这个 server 的旧 tool」，先剔除再追加新的
        const existingClientIndex = mcp.clients.findIndex(
          c => c.name === client.name,
        )

        const updatedClients =
          existingClientIndex === -1
            ? [...mcp.clients, client]
            : mcp.clients.map(c => (c.name === client.name ? client : c))

  // 中文：tools 为 undefined 表示「这次没拉工具」→ 保留原样；有值才整体替换
        const updatedTools =
          tools === undefined
            ? mcp.tools
            : [...reject(mcp.tools, t => t.name?.startsWith(prefix)), ...tools]

        const updatedCommands =
          commands === undefined
            ? mcp.commands
            : [
                ...reject(mcp.commands, c =>
                  commandBelongsToServer(c, client.name),
                ),
                ...commands,
              ]

  // 中文：commands 同理；非空则覆盖该 server 的槽位，为空则把这个 server 的槽位删掉
        const updatedResources =
          resources === undefined
            ? mcp.resources
            : {
                ...mcp.resources,
                ...(resources.length > 0
                  ? { [client.name]: resources }
                  : omit(mcp.resources, client.name)),
              }

        mcp = {
          ...mcp,
          clients: updatedClients,
          tools: updatedTools,
          commands: updatedCommands,
          resources: updatedResources,
        }
      }

      return { ...prevState, mcp }
    })
  }, [setAppState])

  // Update server state, tools, commands, and resources.
  // When tools, commands, or resources are undefined, the existing values are preserved.
  // When type is 'disabled' or 'failed', tools/commands/resources are automatically cleared.
  // Updates are batched via setTimeout to coalesce updates arriving within MCP_BATCH_FLUSH_MS.
  /**
   * 中文：提交一个 server 的状态更新（不立即生效，进批量队列）。
   * 入参 update：{ ...client 状态, tools?, commands?, resources? }。
   * 语义：三个产物字段为 undefined = 保留旧值；type 为 disabled/failed = 自动清空产物。
   */
  const updateServer = useCallback(
    (update: PendingUpdate) => {
      pendingUpdatesRef.current.push(update)
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(
          flushPendingUpdates,
          MCP_BATCH_FLUSH_MS,
        )
      }
    },
    [flushPendingUpdates],
  )

  /**
   * 中文：★ 一次连接尝试的结果回调。client.ts 每连上一个（或连失败一个）server 就调它一次。
   * 职责：① 把状态推给 AppState；② 按最终状态做不同的后续动作。
   * connected 时要做的四件事：注册 elicitation 处理器、装 onclose 自动重连、
   * 按 channel 闸门注册通知处理器、注册 list_changed 通知处理器（tool/prompt/resource 变更）。
   */
  const onConnectionAttempt = useCallback(
    ({
      client,
      tools,
      commands,
      resources,
    }: {
      client: MCPServerConnection
      tools: Tool[]
      commands: Command[]
      resources?: ServerResource[]
    }) => {
      updateServer({ ...client, tools, commands, resources })

      // Handle side effects based on client state
      switch (client.type) {
        case 'connected': {
          // Overwrite the default elicitation handler registered in connectToServer
          // with the real one (queues elicitation in AppState for UI). Registering
          // here (once per connect) instead of in a [mcpClients] effect avoids
          // re-running for every already-connected server on each state change.
          registerElicitationHandler(client.client, client.name, setAppState)
          // 中文：连上之后才注册真正的 elicitation 处理器（把询问推进 AppState 队列让 UI 弹窗）

          // 中文：装 onclose —— 远程 transport 掉线时靠它触发自动重连
          client.client.onclose = () => {
            const configType = client.config.type ?? 'stdio'

            clearServerCache(client.name, client.config).catch(() => {
              logForDebugging(
                `Failed to invalidate the server cache: ${client.name}`,
              )
            })

            // TODO: This really isn't great: ideally we'd check appstate as the source of truth
            // as to whether it was disconnected due to a disable, but appstate is stale at this
            // point. Getting a live reference to appstate feels a little hacky, so we'll just
            // check the disk state. We may want to refactor some of this.
          // 中文：先查磁盘上的禁用状态（英文 TODO 吐槽了这里：AppState 此时是旧的，只能查磁盘）
            if (isMcpServerDisabled(client.name)) {
              logMCPDebug(
                client.name,
                `Server is disabled, skipping automatic reconnection`,
              )
              return
            }

            // Handle automatic reconnection for remote transports
            // Skip stdio (local process) and sdk (internal) - they don't support reconnection
          // 中文：只有远程 transport（sse/http/ws）才会自动重连；stdio 是子进程、sdk 是进程内，
          //       掉了就是掉了，重连没有意义
            if (configType !== 'stdio' && configType !== 'sdk') {
              const transportType = getTransportDisplayName(configType)
              logMCPDebug(
                client.name,
                `${transportType} transport closed/disconnected, attempting automatic reconnection`,
              )

              // Cancel any existing reconnection attempt for this server
              const existingTimer = reconnectTimersRef.current.get(client.name)
              if (existingTimer) {
                clearTimeout(existingTimer)
                reconnectTimersRef.current.delete(client.name)
              }

              // Attempt reconnection with exponential backoff
          // 中文：指数退避重连：第 n 次失败后等 min(1s * 2^(n-1), 30s) 再试
              const reconnectWithBackoff = async () => {
                for (
                  let attempt = 1;
                  attempt <= MAX_RECONNECT_ATTEMPTS;
                  attempt++
                ) {
                  // Check if server was disabled while we were waiting
                  if (isMcpServerDisabled(client.name)) {
                    logMCPDebug(
                      client.name,
                      `Server disabled during reconnection, stopping retry`,
                    )
                    reconnectTimersRef.current.delete(client.name)
                    return
                  }

          // 中文：每次重试前先把状态改成 pending 并带上重试次数，UI 才能显示「第 2/5 次重连中」
                  updateServer({
                    ...client,
                    type: 'pending',
                    reconnectAttempt: attempt,
                    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
                  })

                  const reconnectStartTime = Date.now()
                  try {
                    const result = await reconnectMcpServerImpl(
                      client.name,
                      client.config,
                    )
                    const elapsed = Date.now() - reconnectStartTime

                    if (result.client.type === 'connected') {
                      logMCPDebug(
                        client.name,
                        `${transportType} reconnection successful after ${elapsed}ms (attempt ${attempt})`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      onConnectionAttempt(result)
                      return
                    }

                    logMCPDebug(
                      client.name,
                      `${transportType} reconnection attempt ${attempt} completed with status: ${result.client.type}`,
                    )

                    // On final attempt, update state with the result
                    if (attempt === MAX_RECONNECT_ATTEMPTS) {
                      logMCPDebug(
                        client.name,
                        `Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      onConnectionAttempt(result)
                      return
                    }
                  } catch (error) {
                    const elapsed = Date.now() - reconnectStartTime
                    logMCPError(
                      client.name,
                      `${transportType} reconnection attempt ${attempt} failed after ${elapsed}ms: ${error}`,
                    )

                    // On final attempt, mark as failed
                    if (attempt === MAX_RECONNECT_ATTEMPTS) {
                      logMCPDebug(
                        client.name,
                        `Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      updateServer({ ...client, type: 'failed' })
                      return
                    }
                  }

                  // Schedule next retry with exponential backoff
                  // 中文：指数退避公式；Math.min 保证不会无限增长（上限 30 秒）
                  const backoffMs = Math.min(
                    INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1),
                    MAX_BACKOFF_MS,
                  )
                  logMCPDebug(
                    client.name,
                    `Scheduling reconnection attempt ${attempt + 1} in ${backoffMs}ms`,
                  )

                  await new Promise<void>(resolve => {
                    // eslint-disable-next-line no-restricted-syntax -- timer stored in ref for cancellation; sleep() doesn't expose the handle
                    const timer = setTimeout(resolve, backoffMs)
                    reconnectTimersRef.current.set(client.name, timer)
                  })
                }
              }

              // 中文：故意不 await —— 重连在后台跑，不能卡住这次连接回调
              void reconnectWithBackoff()
            } else {
              updateServer({ ...client, type: 'failed' })
              // 中文：stdio/sdk 掉线直接标记 failed，不做重连
            }
          }

          // Channel push: notifications/claude/channel → enqueue().
          // Gate decides whether to register the handler; connection stays
          // up either way (allowedMcpServers controls that).
          // 中文：channel 入站能力：先过六道闸门，决定注不注册通知处理器（连接本身不受影响）
          if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
            const gate = gateChannelServer(
              client.name,
              client.capabilities,
              client.config.pluginSource,
            )
            const entry = findChannelEntry(client.name, getAllowedChannels())
            // Plugin identifier for telemetry — log name@marketplace for any
            // plugin-kind entry (same tier as tengu_plugin_installed, which
            // logs arbitrary plugin_id+marketplace_name ungated). server-kind
            // names are MCP-server-name tier; those are opt-in-only elsewhere
            // (see isAnalyticsToolDetailsLoggingEnabled in metadata.ts) and
            // stay unlogged here. is_dev/entry_kind segment the rest.
            const pluginId =
              entry?.kind === 'plugin'
                ? (`${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
                : undefined
            // Skip capability-miss — every non-channel MCP server trips it.
            // 中文：capability 未命中是绝大多数普通 server 的常态，不值得埋点刷量
            if (gate.action === 'register' || gate.kind !== 'capability') {
              logEvent('tengu_mcp_channel_gate', {
                registered: gate.action === 'register',
                skip_kind:
                  gate.action === 'skip'
                    ? (gate.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
                    : undefined,
                entry_kind:
                  entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                is_dev: entry?.dev ?? false,
                plugin: pluginId,
              })
            }
            // 中文：按闸门结果二选一：注册处理器，或拆掉处理器并提示用户
            switch (gate.action) {
              case 'register':
              // 中文：注册入站消息处理器：收到通知 → 包成 <channel> XML → 塞进消息队列（模型随后会被唤醒）
                logMCPDebug(client.name, 'Channel notifications registered')
                client.client.setNotificationHandler(
                  ChannelMessageNotificationSchema(),
                  async notification => {
                    const { content, meta } = notification.params
                    logMCPDebug(
                      client.name,
                      `notifications/claude/channel: ${content.slice(0, 80)}`,
                    )
                    logEvent('tengu_mcp_channel_message', {
                      content_length: content.length,
                      meta_key_count: Object.keys(meta ?? {}).length,
                      entry_kind:
                        entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      is_dev: entry?.dev ?? false,
                      plugin: pluginId,
                    })
              // 中文：priority:'next' + isMeta:true —— 让它插到下一次输入的前面，且不污染用户历史
                    enqueue({
                      mode: 'prompt',
                      value: wrapChannelMessage(client.name, content, meta),
                      priority: 'next',
                      isMeta: true,
                      origin: { kind: 'channel', server: client.name },
                      skipSlashCommands: true,
                    })
                  },
                )
                // Permission-reply handler — separate event, separate
                // capability. Only registers if the server declares
                // claude/channel/permission (same opt-in check as the send
                // path in interactiveHandler.ts). Server parses the user's
                // reply and emits {request_id, behavior}; no regex on our
                // side, text in the general channel can't accidentally match.
                // 中文：权限回复处理器要「server 显式声明了 claude/channel/permission」才注册
                if (
                  client.capabilities?.experimental?.[
                    'claude/channel/permission'
                  ] !== undefined
                ) {
                  client.client.setNotificationHandler(
                    ChannelPermissionNotificationSchema(),
                    async notification => {
                      const { request_id, behavior } = notification.params
                      const resolved =
                        channelPermCallbacksRef.current?.resolve(
                          request_id,
                          behavior,
                          client.name,
                        ) ?? false
                      logMCPDebug(
                        client.name,
                        `notifications/claude/channel/permission: ${request_id} → ${behavior} (${resolved ? 'matched pending' : 'no pending entry — stale or unknown ID'})`,
                      )
                    },
                  )
                }
                break
              case 'skip':
                // 中文：skip 分支也要做「幂等拆除」——否则 register→skip 的转变（如 /logout 后）
                //       会让旧处理器继续往队列里塞消息
                // Idempotent teardown so a register→skip re-gate (e.g.
                // effect re-runs after /logout) actually removes the live
                // handler. Without this, mid-session demotion is one-way:
                // the gate says skip but the earlier handler keeps enqueuing.
                // Map.delete — safe when never registered.
                // 中文：removeNotificationHandler 对「从未注册过」是安全的（内部就是 Map.delete）
                client.client.removeNotificationHandler(
                  'notifications/claude/channel',
                )
                client.client.removeNotificationHandler(
                  CHANNEL_PERMISSION_METHOD,
                )
                logMCPDebug(
                  client.name,
                  `Channel notifications skipped: ${gate.reason}`,
                )
                // Surface a once-per-kind toast when a channel server is
                // blocked. This is the only
                // user-visible signal (logMCPDebug above requires --debug).
                // Capability/session skips are expected noise and stay
                // debug-only. marketplace/allowlist run after session — if
                // we're here with those kinds, the user asked for it.
                // 中文：只对「用户真的想要」的情况弹提示（entry 存在 = 用户把它写进了 --channels），
                //       capability/session 两类属于正常噪声，只进 debug 日志
                if (
                  gate.kind !== 'capability' &&
                  gate.kind !== 'session' &&
                  !channelWarnedKindsRef.current.has(gate.kind) &&
                  (gate.kind === 'marketplace' ||
                    gate.kind === 'allowlist' ||
                    entry !== undefined)
                ) {
                  channelWarnedKindsRef.current.add(gate.kind)
                  // disabled/auth/policy get custom toast copy (shorter, actionable);
                  // marketplace/allowlist reuse the gate's reason verbatim
                  // since it already names the mismatch.
                  const text =
                    gate.kind === 'disabled'
                      ? 'Channels are not currently available'
                      : gate.kind === 'auth'
                        ? 'Channels require claude.ai authentication · run /login'
                        : gate.kind === 'policy'
                          ? 'Channels are not enabled for your org · have an administrator set channelsEnabled: true in managed settings'
                          : gate.reason
                  addNotification({
                    key: `channels-blocked-${gate.kind}`,
                    priority: 'high',
                    text,
                    color: 'warning',
                    timeoutMs: 12000,
                  })
                }
                break
            }
          }

          // Register notification handlers for list_changed notifications
          // These allow the server to notify us when tools, prompts, or resources change
          // 中文：list_changed 是 MCP 的「我的工具/提示/资源列表变了」通知，收到就重新拉一次
          if (client.capabilities?.tools?.listChanged) {
            client.client.setNotificationHandler(
              ToolListChangedNotificationSchema,
              async () => {
                logMCPDebug(
                  client.name,
                  `Received tools/list_changed notification, refreshing tools`,
                )
                try {
                  // Grab cached promise before invalidating to log previous count
                  // 中文：先把旧的缓存 Promise 取出来（用于对比前后的工具数量），再删缓存重新拉
                  const previousToolsPromise = fetchToolsForClient.cache.get(
                    client.name,
                  )
                  fetchToolsForClient.cache.delete(client.name)
                  const newTools = await fetchToolsForClient(client)
                  const newCount = newTools.length
                  if (previousToolsPromise) {
                    previousToolsPromise.then(
                      (previousTools: Tool[]) => {
                        logEvent('tengu_mcp_list_changed', {
                          type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                          previousCount: previousTools.length,
                          newCount,
                        })
                      },
                      () => {
                        logEvent('tengu_mcp_list_changed', {
                          type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                          newCount,
                        })
                      },
                    )
                  } else {
                    logEvent('tengu_mcp_list_changed', {
                      type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      newCount,
                    })
                  }
                  updateServer({ ...client, tools: newTools })
                } catch (error) {
                  logMCPError(
                    client.name,
                    `Failed to refresh tools after list_changed notification: ${errorMessage(error)}`,
                  )
                }
              },
            )
          }

          // 中文：prompts 变更 → 重拉 prompt；注意 skill 来自 resource，这里有意识地不去动它的缓存
          if (client.capabilities?.prompts?.listChanged) {
            client.client.setNotificationHandler(
              PromptListChangedNotificationSchema,
              async () => {
                logMCPDebug(
                  client.name,
                  `Received prompts/list_changed notification, refreshing prompts`,
                )
                logEvent('tengu_mcp_list_changed', {
                  type: 'prompts' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                try {
                  // Skills come from resources, not prompts — don't invalidate their
                  // cache here. fetchMcpSkillsForClient returns the cached result.
                  // 中文：只删 prompts 的缓存——skill 走 resource 通道，在这里刷新会读到过期结果
                  fetchCommandsForClient.cache.delete(client.name)
                  const [mcpPrompts, mcpSkills] = await Promise.all([
                    fetchCommandsForClient(client),
                    feature('MCP_SKILLS')
                      ? fetchMcpSkillsForClient!(client)
                      : Promise.resolve([]),
                  ])
                  updateServer({
                    ...client,
                    commands: [...mcpPrompts, ...mcpSkills],
                  })
                  // MCP skills changed — invalidate skill-search index so
                  // next discovery rebuilds with the new set.
                  clearSkillIndexCache?.()
                } catch (error) {
                  logMCPError(
                    client.name,
                    `Failed to refresh prompts after list_changed notification: ${errorMessage(error)}`,
                  )
                }
              },
            )
          }

          // 中文：resources 变更 → 要连带刷新 skill（因为 MCP skill 就是从 resource 里发现的）
          if (client.capabilities?.resources?.listChanged) {
            client.client.setNotificationHandler(
              ResourceListChangedNotificationSchema,
              async () => {
                logMCPDebug(
                  client.name,
                  `Received resources/list_changed notification, refreshing resources`,
                )
                logEvent('tengu_mcp_list_changed', {
                  type: 'resources' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                try {
                  // 中文：这里连 prompts 缓存一起删：因为下面要写 commands，
                  //       否则并发的 prompts/list_changed 可能被我们用旧的缓存结果覆盖掉
                  fetchResourcesForClient.cache.delete(client.name)
                  if (feature('MCP_SKILLS')) {
                    // Skills are discovered from resources, so refresh them too.
                    // Invalidate prompts cache as well: we write commands here,
                    // and a concurrent prompts/list_changed could otherwise have
                    // us stomp its fresh result with our cached stale one.
                    fetchMcpSkillsForClient!.cache.delete(client.name)
                    fetchCommandsForClient.cache.delete(client.name)
                    const [newResources, mcpPrompts, mcpSkills] =
                      await Promise.all([
                        fetchResourcesForClient(client),
                        fetchCommandsForClient(client),
                        fetchMcpSkillsForClient!(client),
                      ])
                    updateServer({
                      ...client,
                      resources: newResources,
                      commands: [...mcpPrompts, ...mcpSkills],
                    })
                    // MCP skills changed — invalidate skill-search index so
                    // next discovery rebuilds with the new set.
                    clearSkillIndexCache?.()
                  } else {
                    const newResources = await fetchResourcesForClient(client)
                    updateServer({ ...client, resources: newResources })
                  }
                } catch (error) {
                  logMCPError(
                    client.name,
                    `Failed to refresh resources after list_changed notification: ${errorMessage(error)}`,
                  )
                }
              },
            )
          }
          break
        }

        case 'needs-auth':
        case 'failed':
        case 'pending':
        case 'disabled':
          break
      }
    },
    [updateServer],
  )

  // Initialize all servers to pending state if they don't exist in appState.
  // Re-runs on session change (/clear) and on /reload-plugins (pluginReconnectKey).
  // On plugin reload, also disconnects stale plugin MCP servers (scope 'dynamic')
  // that no longer appear in configs — prevents ghost tools from disabled plugins.
  // Skip claude.ai dedup here to avoid blocking on the network fetch; the connect
  // useEffect below runs immediately after and dedups before connecting.
  // 中文：第一个 effect：把配置里的 server 先全部置为 pending，让 /mcp 界面立刻能看到列表；
  //       同时清掉「配置已消失 / 配置已变更」的过期 client（防止已禁用插件留下幽灵工具）
  const sessionId = getSessionId()
  useEffect(() => {
    async function initializeServersAsPending() {
      const { servers: existingConfigs, errors: mcpErrors } = isStrictMcpConfig
        ? { servers: {}, errors: [] }
        : await getClaudeCodeMcpConfigs(dynamicMcpConfig)
      const configs = { ...existingConfigs, ...dynamicMcpConfig }

      // Add MCP errors to plugin errors for UI visibility (deduplicated)
      addErrorsToAppState(setAppState, mcpErrors)

      setAppState(prevState => {
        // Disconnect MCP servers that are stale: plugin servers removed from
        // config, or any server whose config hash changed (edited .mcp.json).
        // Stale servers get re-added as 'pending' below since their name is
        // now absent from mcpWithoutStale.clients.
        // 中文：先算出过期列表（见 utils.ts 的 excludeStalePluginClients）
        const { stale, ...mcpWithoutStale } = excludeStalePluginClients(
          prevState.mcp,
          configs,
        )
        // Clean up stale connections. Fire-and-forget — state updaters must
        // be synchronous. Three hazards to defuse before calling cleanup:
        //   1. Pending reconnect timer would fire with the OLD config.
        //   2. onclose (set at L254) starts reconnectWithBackoff with the
        //      OLD config from its closure — it checks isMcpServerDisabled
        //      but config-changed servers aren't disabled, so it'd race the
        //      fresh connection and last updateServer wins.
        //   3. clearServerCache internally calls connectToServer (memoized).
        //      For never-connected servers (disabled/pending/failed) the
        //      cache is empty → real connect attempt → spawn/OAuth just to
        //      immediately kill it. Only connected servers need cleanup.
        // 中文：★ 拆连接前必须排掉三个坑（英文注释列得很细）：
        //       ① 待触发的重连定时器会用「旧配置」重连 → 先清掉；
        //       ② onclose 闭包里也是旧配置 → 先把 onclose 置空；
        //       ③ clearServerCache 内部会触发 memoized 的 connectToServer —— 对从没连上的 server
        //          这会白白 spawn 一次子进程/走一遍 OAuth 再立刻杀掉，所以只对 connected 的做清理
        for (const s of stale) {
          const timer = reconnectTimersRef.current.get(s.name)
          if (timer) {
            clearTimeout(timer)
            reconnectTimersRef.current.delete(s.name)
          }
          if (s.type === 'connected') {
            s.client.onclose = undefined
            void clearServerCache(s.name, s.config).catch(() => {})
          }
        }

        // 中文：只给「还不存在的 server」建 pending 条目，避免覆盖已有连接的状态
        const existingServerNames = new Set(
          mcpWithoutStale.clients.map(c => c.name),
        )
        const newClients = Object.entries(configs)
          .filter(([name]) => !existingServerNames.has(name))
          .map(([name, config]) => ({
            name,
            type: isMcpServerDisabled(name)
              ? ('disabled' as const)
              : ('pending' as const),
            config,
          }))

        if (newClients.length === 0 && stale.length === 0) {
          return prevState
        }

        return {
          ...prevState,
          mcp: {
            ...prevState.mcp,
            ...mcpWithoutStale,
            clients: [...mcpWithoutStale.clients, ...newClients],
          },
        }
      })
    }

    void initializeServersAsPending().catch(error => {
      logMCPError(
        'useManageMCPConnections',
        `Failed to initialize servers as pending: ${errorMessage(error)}`,
      )
    })
  }, [
    isStrictMcpConfig,
    dynamicMcpConfig,
    setAppState,
    sessionId,
    _pluginReconnectKey,
  ])

  // Load MCP configs and connect to servers
  // Two-phase loading: Claude Code configs first (fast), then claude.ai configs (may be slow)
  // 中文：第二个 effect：真正加载配置并建连。两阶段是性能考虑——claude.ai 的配置要发网络请求，
  //       不能让本地配置等它
  useEffect(() => {
    let cancelled = false

    async function loadAndConnectMcpConfigs() {
      // Clear claude.ai MCP cache so we fetch fresh configs with current auth
      // state. This is important when authVersion changes (e.g., after login/
      // logout). Kick off the fetch now so it overlaps with loadAllPlugins()
      // inside getClaudeCodeMcpConfigs; it's awaited only at the dedup step.
      // Phase 2 below awaits the same promise — no second network call.
      // 中文：先起一个 Promise 但不 await —— 让它和 getClaudeCodeMcpConfigs 内部的插件加载并行
      let claudeaiPromise: Promise<Record<string, ScopedMcpServerConfig>>
      if (isStrictMcpConfig || doesEnterpriseMcpConfigExist()) {
        claudeaiPromise = Promise.resolve({})
      } else {
        clearClaudeAIMcpConfigsCache()
        claudeaiPromise = fetchClaudeAIMcpConfigsIfEligible()
      }

      // Phase 1: Load Claude Code configs. Plugin MCP servers that duplicate a
      // --mcp-config entry or a claude.ai connector are suppressed here so they
      // don't connect alongside the connector in Phase 2.
      // 中文：阶段一：本地/项目/用户/插件配置（快）。插件里若重复了某个 claude.ai connector，在这里就被压掉
      const { servers: claudeCodeConfigs, errors: mcpErrors } =
        isStrictMcpConfig
          ? { servers: {}, errors: [] }
          : await getClaudeCodeMcpConfigs(dynamicMcpConfig, claudeaiPromise)
      if (cancelled) return

      // Add MCP errors to plugin errors for UI visibility (deduplicated)
      addErrorsToAppState(setAppState, mcpErrors)

      const configs = { ...claudeCodeConfigs, ...dynamicMcpConfig }

      // Start connecting to Claude Code servers (don't wait - runs concurrently with Phase 2)
      // Filter out disabled servers to avoid unnecessary connection attempts
      const enabledConfigs = Object.fromEntries(
        Object.entries(configs).filter(([name]) => !isMcpServerDisabled(name)),
      )
      // 中文：过滤掉被禁用的 server，没必要为它们发起连接
      getMcpToolsCommandsAndResources(
        onConnectionAttempt,
        enabledConfigs,
      ).catch(error => {
        logMCPError(
          'useManageMcpConnections',
          `Failed to get MCP resources: ${errorMessage(error)}`,
        )
      })

      // Phase 2: Await claude.ai configs (started above; memoized — no second fetch)
      let claudeaiConfigs: Record<string, ScopedMcpServerConfig> = {}
      // 中文：阶段二：await claude.ai 配置（同一个 Promise，不会发第二次请求）
      if (!isStrictMcpConfig) {
        claudeaiConfigs = filterMcpServersByPolicy(
          await claudeaiPromise,
        ).allowed
        if (cancelled) return

        // Suppress claude.ai connectors that duplicate an enabled manual server.
        // Keys never collide (`slack` vs `claude.ai Slack`) so the merge below
        // won't catch this — need content-based dedup by URL signature.
        // 中文：键名不会撞（'slack' vs 'claude.ai Slack'），所以只能按 URL 内容做去重
        if (Object.keys(claudeaiConfigs).length > 0) {
          const { servers: dedupedClaudeAi } = dedupClaudeAiMcpServers(
            claudeaiConfigs,
            configs,
          )
          claudeaiConfigs = dedupedClaudeAi
        }

        if (Object.keys(claudeaiConfigs).length > 0) {
          // Add claude.ai servers as pending immediately so they show up in UI
          setAppState(prevState => {
            const existingServerNames = new Set(
              prevState.mcp.clients.map(c => c.name),
            )
            const newClients = Object.entries(claudeaiConfigs)
              .filter(([name]) => !existingServerNames.has(name))
              .map(([name, config]) => ({
                name,
                type: isMcpServerDisabled(name)
                  ? ('disabled' as const)
                  : ('pending' as const),
                config,
              }))
            if (newClients.length === 0) return prevState
            return {
              ...prevState,
              mcp: {
                ...prevState.mcp,
                clients: [...prevState.mcp.clients, ...newClients],
              },
            }
          })

          // Now start connecting (only enabled servers)
          const enabledClaudeaiConfigs = Object.fromEntries(
            Object.entries(claudeaiConfigs).filter(
              ([name]) => !isMcpServerDisabled(name),
            ),
          )
          getMcpToolsCommandsAndResources(
            onConnectionAttempt,
            enabledClaudeaiConfigs,
          ).catch(error => {
            logMCPError(
              'useManageMcpConnections',
              `Failed to get claude.ai MCP resources: ${errorMessage(error)}`,
            )
          })
        }
      }

      // Log server counts after both phases complete
      // 中文：两阶段都完成后统一埋点，统计各作用域的 server 数量
      const allConfigs = { ...configs, ...claudeaiConfigs }
      const counts = {
        enterprise: 0,
        global: 0,
        project: 0,
        user: 0,
        plugin: 0,
        claudeai: 0,
      }
      // Ant-only: collect stdio command basenames to correlate with RSS/FPS
      // metrics. Stdio servers like rust-analyzer can be heavy and we want to
      // know which ones correlate with poor session performance.
      const stdioCommands: string[] = []
      // 中文：内部环境额外收集 stdio 命令名，用来和内存/性能指标做关联分析
      for (const [name, serverConfig] of Object.entries(allConfigs)) {
        if (serverConfig.scope === 'enterprise') counts.enterprise++
        else if (serverConfig.scope === 'user') counts.global++
        else if (serverConfig.scope === 'project') counts.project++
        else if (serverConfig.scope === 'local') counts.user++
        else if (serverConfig.scope === 'dynamic') counts.plugin++
        else if (serverConfig.scope === 'claudeai') counts.claudeai++

        if (
          process.env.USER_TYPE === 'ant' &&
          !isMcpServerDisabled(name) &&
          (serverConfig.type === undefined || serverConfig.type === 'stdio') &&
          'command' in serverConfig
        ) {
          stdioCommands.push(basename(serverConfig.command))
        }
      }
      logEvent('tengu_mcp_servers', {
        ...counts,
        ...(process.env.USER_TYPE === 'ant' && stdioCommands.length > 0
          ? {
              stdio_commands: stdioCommands
                .sort()
                .join(
                  ',',
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            }
          : {}),
      })
    }

    // 中文：不 await（后台跑）；cancelled 标志用于 effect 重跑时让旧的那次自动作废
    void loadAndConnectMcpConfigs()

    // 中文：清理函数：把 cancelled 置 true，正在跑的那轮会在几个检查点自行退出
    return () => {
      cancelled = true
    }
  }, [
    isStrictMcpConfig,
    dynamicMcpConfig,
    onConnectionAttempt,
    setAppState,
    _authVersion,
    sessionId,
    _pluginReconnectKey,
  ])

  // Cleanup all timers on unmount
  // 中文：卸载时清掉所有重连定时器，并把攒着的状态更新冲刷掉（避免丢失最后一次更新）
  useEffect(() => {
    const timers = reconnectTimersRef.current
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
      // Flush any pending batched MCP updates before unmount
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
        flushPendingUpdates()
      }
    }
  }, [flushPendingUpdates])

  // Expose reconnectMcpServer function for components to use.
  // Reads mcp.clients via store.getState() so this callback stays stable
  // across client state transitions (no need to re-create on every connect).
  // 中文：用 store.getState() 而不是 useAppState 快照：这样这个函数不用依赖 clients，引用能保持稳定
  const reconnectMcpServer = useCallback(
    async (serverName: string) => {
      const client = store
        .getState()
        .mcp.clients.find(c => c.name === serverName)
      if (!client) {
        throw new Error(`MCP server ${serverName} not found`)
      }

      // Cancel any pending automatic reconnection attempt
      const existingTimer = reconnectTimersRef.current.get(serverName)
      if (existingTimer) {
        clearTimeout(existingTimer)
        reconnectTimersRef.current.delete(serverName)
      }

      const result = await reconnectMcpServerImpl(serverName, client.config)

      onConnectionAttempt(result)

      // Don't throw, just let UI handle the client type in case the reconnect failed
      // (Detailed logs are within the reconnectMcpServerImpl via --debug)
      return result
    },
    [store, onConnectionAttempt],
  )

  // Expose function to toggle server enabled/disabled state
  // 中文：手动切换某个 server 的启用/禁用
  const toggleMcpServer = useCallback(
    async (serverName: string): Promise<void> => {
      const client = store
        .getState()
        .mcp.clients.find(c => c.name === serverName)
      if (!client) {
        throw new Error(`MCP server ${serverName} not found`)
      }

      const isCurrentlyDisabled = client.type === 'disabled'

      if (!isCurrentlyDisabled) {
        // Cancel any pending automatic reconnection attempt
        const existingTimer = reconnectTimersRef.current.get(serverName)
        if (existingTimer) {
          clearTimeout(existingTimer)
          reconnectTimersRef.current.delete(serverName)
        }

        // Persist disabled state to disk FIRST before clearing cache
        // This is important because the onclose handler checks disk state
        // 中文：★ 顺序很重要：先把「已禁用」写进磁盘，再断开——因为 onclose 里会去查磁盘状态，
        //       顺序反了它就会以为「不是我主动禁的」而开始自动重连
        setMcpServerEnabled(serverName, false)

        // Disabling: disconnect and clean up if currently connected
        if (client.type === 'connected') {
          await clearServerCache(serverName, client.config)
        }

        // Update to disabled state (tools/commands/resources auto-cleared)
        updateServer({
          name: serverName,
          type: 'disabled',
          config: client.config,
        })
      } else {
        // Enabling: persist enabled state to disk first
        // 中文：启用同理：先落盘再重连
        setMcpServerEnabled(serverName, true)

        // Mark as pending and reconnect
        updateServer({
          name: serverName,
          type: 'pending',
          config: client.config,
        })

        // Reconnect the server
        const result = await reconnectMcpServerImpl(serverName, client.config)

        onConnectionAttempt(result)
      }
    },
    [store, updateServer, onConnectionAttempt],
  )

  return { reconnectMcpServer, toggleMcpServer }
}

  /**
   * 中文：把 transport 类型翻成日志里给人看的名字（http/ws 各自有名字，其余统一叫 SSE）。
   */
function getTransportDisplayName(type: string): string {
  switch (type) {
    case 'http':
      return 'HTTP'
    case 'ws':
    case 'ws-ide':
      return 'WebSocket'
    default:
      return 'SSE'
  }
}
