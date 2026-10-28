/**
 * 【一句话定位】VSCode 扩展专用的 MCP 桥接模块：把 Claude Code 与 VSCode 扩展之间的双向通知接起来。
 *
 * 【在架构中的位置】
 * - 上游：client.ts 建完所有 MCP 连接后，把 sdkClients 交给 setupVscodeSdkMcp()；
 *   文件编辑/写入的调用方通过 notifyVscodeFileUpdated() 反向通知 VSCode。
 * - 下游：只依赖 analytics 埋点 + 一个名叫 'claude-vscode' 的内置 MCP server。
 *
 * 【本文件包含什么】
 * - LogEventNotificationSchema：用 zod 声明的 'log_event' 通知结构（既是运行时校验器又是类型来源）。
 * - readAutoModeEnabledState()：读 auto mode 的三态配置（内部函数）。
 * - notifyVscodeFileUpdated()：告诉 VSCode「某个文件被改了」，带上改前/改后内容。
 * - setupVscodeSdkMcp()：找到 'claude-vscode' 这个内部 server，注册通知处理器并下发实验开关。
 *
 * 【为什么用 MCP 通知而不是别的 IPC】
 * VSCode 扩展本来就以 MCP server 的身份接入了 Claude Code，复用同一条连接就不用再开一套 IPC 通道：
 * CLI → VSCode 用 notification（单向、不等响应），VSCode → CLI 用 setNotificationHandler 注册回调。
 *
 * 【TS 语法速查】
 * - `type X = 'a' | 'b' | 'c'`：字符串字面量联合类型 ≈ Java 的 enum，但编译后就是普通字符串。
 * - `lazySchema(() => z.object({...}))`：工厂包一层是为了延迟构造（zod schema 构造较贵且可能循环依赖），
 *   调用时要写 LogEventNotificationSchema() 加括号。
 * - `void somePromise`：显式丢弃返回值，告诉读者和 linter「我故意不等它」，≈ Java 里不接收返回值。
 * - `?.` 可选链、`??` 空值合并、`as X` 强制类型转换（编译期）。
 * - `Record<string, boolean | string>` ≈ Java 的 Map<String, Object>（值只许 boolean 或 string）。
 */
import { logForDebugging } from 'src/utils/debug.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../analytics/growthbook.js'
import { logEvent } from '../analytics/index.js'
import type { ConnectedMCPServer, MCPServerConnection } from './types.js'

// Mirror of AutoModeEnabledState in permissionSetup.ts — inlined because that
// file pulls in too many deps for this thin IPC module.
type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'
  /**
   * 中文：读 auto mode（自动接受编辑）的三态配置。
   * 为什么要在这里内联一份类型定义（英文注释解释了）：permissionSetup.ts 里的同名类型所在的模块
   * 依赖太重，而这个 IPC 薄模块不想被拖进来，所以复制一份字符串联合类型即可。
   * 返回 undefined 表示配置缺失或值不合法，调用方据此决定不下发（让 VSCode 侧按最保守值处理）。
   */
function readAutoModeEnabledState(): AutoModeEnabledState | undefined {
  const v = getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: string }>(
    'tengu_auto_mode_config',
    {},
  )?.enabled
  return v === 'enabled' || v === 'disabled' || v === 'opt-in' ? v : undefined
}

  // 中文：zod schema 同时承担两件事：① 运行时校验收到的通知结构；② 用 z.infer 推导出 TS 类型。
  //       这就是 TS 生态里「一份定义，两处使用」的常用手法，≈ Java 的 Bean Validation + DTO 二合一。
export const LogEventNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('log_event'),
    params: z.object({
      eventName: z.string(),
      eventData: z.object({}).passthrough(),
    }),
  }),
)

// Store the VSCode MCP client reference for sending notifications
let vscodeMcpClient: ConnectedMCPServer | null = null

/**
 * Sends a file_updated notification to the VSCode MCP server. This is used to
 * notify VSCode when files are edited or written by Claude.
 */
  /**
   * 中文：通知 VSCode「文件被改了」。
   * 入参 filePath：绝对路径；oldContent/newContent：改动前后的内容，新建文件时 old 为 null，
   * 删除文件时 new 为 null。
   * 为什么 VSCode 需要这个：扩展要在编辑器里做 diff / 高亮 / 撤销栈同步，光靠重新读盘拿不到「改了什么」。
   */
export function notifyVscodeFileUpdated(
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
): void {
  // 中文：双保险——不是蚂蚁内部环境（USER_TYPE!=='ant'）、或 VSCode 的 client 还没建好，直接静默返回
  if (process.env.USER_TYPE !== 'ant' || !vscodeMcpClient) {
    return
  }

  // 中文：notification() 是「发了就不管」的单向消息（JSON-RPC 里叫 notification，不等 response）；
  //       前面的 void 表示故意不 await，避免文件写入路径被 VSCode 的响应速度拖慢
  void vscodeMcpClient.client
    .notification({
      method: 'file_updated',
      params: { filePath, oldContent, newContent },
    })
    .catch((error: Error) => {
      // Do not throw if the notification failed
      logForDebugging(
        `[VSCode] Failed to send file_updated notification: ${error.message}`,
      )
    })
}

/**
 * Sets up the speicial internal VSCode MCP for bidirectional communication using notifications.
 */
  /**
   * 中文：给 VSCode 这个内部 MCP server 装好双向通道。
   * 入参 sdkClients：本轮建立起来的所有 MCP 连接（含成功/失败/待授权等各状态）。
   * 步骤：① 按名字 'claude-vscode' 找到那个内置 server；② 只有状态是 connected 才继续；
   *      ③ 注册 log_event 通知处理器（VSCode → CLI 的埋点上报）；
   *      ④ 立刻把一批实验开关推给 VSCode（CLI → VSCode）。
   */
export function setupVscodeSdkMcp(sdkClients: MCPServerConnection[]): void {
  const client = sdkClients.find(client => client.name === 'claude-vscode')
    // 中文：按约定名查找——没找到说明当前不是跑在 VSCode 里，整个函数什么也不做

  if (client && client.type === 'connected') {
    // Store the client reference for later use
    vscodeMcpClient = client

    client.client.setNotificationHandler(
      LogEventNotificationSchema(),
      async notification => {
        const { eventName, eventData } = notification.params
        logEvent(
          `tengu_vscode_${eventName}`,
          eventData as { [key: string]: boolean | number | undefined },
        )
      },
    )

    // Send necessary experiment gates to VSCode immediately.
    // 中文：建连后第一时间把开关推过去，省得 VSCode 侧再来问一次（也避免开关生效有延迟窗口）
    const gates: Record<string, boolean | string> = {
      tengu_vscode_review_upsell: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_vscode_review_upsell',
      ),
      tengu_vscode_onboarding: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_vscode_onboarding',
      ),
      // Browser support.
      tengu_quiet_fern: getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_quiet_fern',
        false,
      ),
      // In-band OAuth via claude_authenticate (vs. extension-native PKCE).
      tengu_vscode_cc_auth: getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_vscode_cc_auth',
        false,
      ),
    }
    // Tri-state: 'enabled' | 'disabled' | 'opt-in'. Omit if unknown so VSCode
    // fails closed (treats absent as 'disabled').
    // 中文：三态值未知时干脆不写这个字段，让 VSCode 按「缺失 = disabled」处理（fail-closed）
    const autoModeState = readAutoModeEnabledState()
    if (autoModeState !== undefined) {
      gates.tengu_auto_mode_state = autoModeState
    }
    void client.client.notification({
      method: 'experiment_gates',
      params: { gates },
    })
  }
}
