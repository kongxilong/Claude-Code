/**
 * ============================================================================
 *  【文件总览】src/services/notifier.ts —— 桌面通知发送器
 * ============================================================================
 *
 *  一句话定位：
 *  Claude Code 需要「在后台完成时提醒用户」（比如长任务跑完、等待用户确认时），
 *  本文件负责把一条通知发到**当前终端支持的那条通道**上：
 *  iTerm2、Kitty、Ghostty 图形通知，或者最朴素的「终端响铃（bell）」。
 *
 *  在架构中的位置：
 *      UI 层 / 任务完成回调
 *        └─> sendNotification(notif, terminal)             ← ★ 本文件
 *              ├─> executeNotificationHooks(notif)   ← src/utils/hooks.js
 *              │     （先跑用户配置的 Notification hook，让用户能自定义提醒方式）
 *              ├─> sendToChannel(channel, ...)       ← 按配置分发到具体终端
 *              │     └─> sendAuto(...)               ← 配置为 'auto' 时自动探测终端类型
 *              │           └─> isAppleTerminalBellDisabled()  读 macOS 终端配置
 *              └─> logEvent('tengu_notification_method_used', ...)  上报实际用了哪种方式
 *
 *  本文件包含什么：
 *   1. NotificationOptions       通知的类型定义（message / title? / notificationType）
 *   2. sendNotification()        对外唯一入口
 *   3. sendToChannel()           按用户配置的通道名做 switch 分发
 *   4. sendAuto()                'auto' 模式下根据环境变量猜终端类型
 *   5. generateKittyId()         给 Kitty 通知生成一个随机 ID
 *   6. isAppleTerminalBellDisabled()  探测 macOS 自带终端是否关掉了响铃
 *
 *  【设计意图 1：为什么每个分支都 return 一个字符串】
 *  注意 sendToChannel / sendAuto 的返回类型是 `Promise<string>`，
 *  返回的是「最终实际使用了哪种通知方式」（'iterm2' / 'terminal_bell' / 'none' ...）。
 *  这不是给调用方做流程控制用的，而是**为了埋点**：
 *  产品需要知道「配置说用 X，实际却用了 Y」这类偏差，才能发现配置失效的问题。
 *  ≈ Java 里让方法返回一个枚举来表示「执行结果」，而不是返回 void。
 *
 *  【设计意图 2：为什么整个 switch 包在 try/catch 里，出错只返回 'error'】
 *  通知是纯粹的**锦上添花**功能——它失败绝不该让主任务失败。
 *  所以这里吞掉一切异常，只在上报里记一笔 'error'。
 *  ≈ Java 里 `try { ... } catch (Exception e) { return Result.ERROR; }` 的容错风格。
 *
 *  【踩过的坑：为什么 plist 要「懒加载」】
 *  isAppleTerminalBellDisabled() 里用的是 `await import('plist')`（动态 import），
 *  而不是文件顶部的静态 import。原因写在原英文注释里：
 *  plist 依赖 xmlbuilder + @xmldom，打包后约 280KB，
 *  而真正会走到这条路径的只有「macOS 自带终端 + auto 通道」这一小撮用户。
 *  改成动态 import，就只有命中时才会去加载这 280KB，
 *  ≈ Java 里把重量级依赖放到方法内部 Class.forName() 反射加载，避免拖慢启动。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `export type NotificationOptions = { message: string; title?: string }`
 *      结构化类型定义。`title?: string` 的 `?` 表示**可选**，
 *      等价于 `title: string | undefined`。≈ Java record 里的可空字段，
 *      但 TS 是「鸭子类型」：任何长这样的对象都算这个类型，**不需要 implements**。
 *
 *  - `{ ...opts, title, id: generateKittyId() }`  对象展开。
 *      ≈ Java 没有对应语法；想象成「复制 opts 的所有字段，再覆盖/追加 title 和 id」。
 *      这是**不可变更新**手法：不修改原对象，而是造一个新对象。
 *      为什么这么写：opts 是调用方传进来的，直接改它会产生难以追踪的副作用。
 *
 *  - `opts.title || DEFAULT_TITLE`  这里的 `||` 是**故意**用的，不是 `??`。
 *      区别（Java 工程师最容易踩的坑）：
 *        `||`  对 falsy 值都生效——`''`（空串）、`0`、`false`、`null`、`undefined` 全会被替换
 *        `??`  只在 `null` / `undefined` 时才替换
 *      这里标题为空串 `''` 时也想用默认标题，所以用 `||` 才是正确的。
 *
 *  - `parsed?.['Window Settings'] as Record<string, unknown> | undefined`
 *      `?.` 可选链 ≈ `parsed != null ? parsed.get("Window Settings") : null`
 *      `as` 类型断言 ≈ Java 的强制转换 `(Map<String,Object>) x`，运行时不检查
 *      `Record<string, unknown>` ≈ `Map<String, Object>`，unknown 比 any 安全，
 *        用之前必须先收窄类型（Java 里对应 Object 必须先 instanceof 判断）
 *
 *  - `switch (channel) { case 'auto': ... }`  switch 对字符串，和 Java 一样。
 *      注意每个 case 都 `return`，所以**没有 break**——
 *      TS 里 return 了就不会穿透到下一个 case，不需要写 break。
 *
 *  - `catch { return 'error' }`  省略异常变量的 catch（见 internalLogging.ts 的说明）
 *
 *  - `await import('plist')`  动态 import，返回 Promise。
 *      ≈ Java 的 Class.forName()，运行时才加载，用于代码分割/懒加载。
 *
 *  - `const plist = await import('plist')` 之后 `plist.parse(...)`：
 *      拿到的就是模块对象本身，`.parse` 是它的导出函数。
 * ============================================================================
 */
import type { TerminalNotification } from '../ink/useTerminalNotification.js'
import { getGlobalConfig } from '../utils/config.js'
import { env } from '../utils/env.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import { executeNotificationHooks } from '../utils/hooks.js'
import { logError } from '../utils/log.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from './analytics/index.js'

/**
 * 一条待发送通知的内容。
 *
 * @property message          通知正文（必填）
 * @property title            标题，可选；不传时各通道会用 DEFAULT_TITLE 兜底
 * @property notificationType 通知种类（如「任务完成」「需要确认」），
 *                            会一并传给 Notification hook，方便用户按类型过滤
 */
export type NotificationOptions = {
  message: string
  // `?` = 可选字段，等价于 `string | undefined`
  title?: string
  notificationType: string
}

/**
 * 发送一条通知（对外唯一入口）。
 *
 * 为什么需要：Claude Code 经常在后台跑几分钟甚至更久，
 * 用户切到别的窗口去了；跑完时必须能主动把用户叫回来。
 *
 * 关键步骤：
 *   ① 读出用户在全局配置里选的通知通道（preferredNotifChannel）
 *   ② 先执行用户自己配的 Notification hook——允许用户完全接管通知方式
 *   ③ 再按通道把通知真正发出去
 *   ④ 上报「配置通道 vs 实际通道」，用于发现配置不生效的情况
 *
 * @param notif    通知内容
 * @param terminal 终端能力对象，封装了各终端各自的发通知方式（iTerm2/Kitty/Ghostty/bell）
 */
export async function sendNotification(
  notif: NotificationOptions,
  terminal: TerminalNotification,
): Promise<void> {
  const config = getGlobalConfig()
  const channel = config.preferredNotifChannel

  await executeNotificationHooks(notif)

  const methodUsed = await sendToChannel(channel, notif, terminal)

  logEvent('tengu_notification_method_used', {
    configured_channel:
      channel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    method_used:
      methodUsed as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    term: env.terminal as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

const DEFAULT_TITLE = 'Claude Code'

/**
 * 按用户配置的通道名把通知发出去。
 *
 * 为什么需要：不同终端支持的通知协议完全不同（iTerm2 用专有转义序列、
 * Kitty 用另一套、macOS 自带终端只能响铃），必须逐个适配。
 *
 * @param channel  配置里的通道名（'auto' / 'iterm2' / 'kitty' / ... / 'notifications_disabled'）
 * @param opts     通知内容
 * @param terminal 终端能力对象
 * @returns 实际使用的通道名字符串，仅用于埋点上报；出错返回 'error'
 */
async function sendToChannel(
  channel: string,
  opts: NotificationOptions,
  terminal: TerminalNotification,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE

  try {
    switch (channel) {
      case 'auto':
        return sendAuto(opts, terminal)
      case 'iterm2':
        terminal.notifyITerm2(opts)
        return 'iterm2'
      case 'iterm2_with_bell':
        terminal.notifyITerm2(opts)
        terminal.notifyBell()
        return 'iterm2_with_bell'
      case 'kitty':
        terminal.notifyKitty({ ...opts, title, id: generateKittyId() })
        return 'kitty'
      case 'ghostty':
        terminal.notifyGhostty({ ...opts, title })
        return 'ghostty'
      case 'terminal_bell':
        terminal.notifyBell()
        return 'terminal_bell'
      case 'notifications_disabled':
        return 'disabled'
      default:
        return 'none'
    }
  } catch {
    return 'error'
  }
}

/**
 * 'auto' 模式：根据环境变量 env.terminal 猜出当前终端，再挑它能支持的通知方式。
 *
 * 为什么需要：绝大多数用户不会去配置 preferredNotifChannel，
 * 默认值必须是「开箱即用」的——那就只能靠探测终端类型来选方式。
 *
 * 注意 Apple_Terminal 分支要额外检查一次响铃是否被用户关掉：
 * macOS 自带终端**只支持响铃**，如果用户在系统设置里把铃声关了，
 * 那发通知就是白费功夫，这里就返回 'no_method_available' 如实上报。
 *
 * @returns 实际使用的通道名；无法通知时返回 'no_method_available'
 */
async function sendAuto(
  opts: NotificationOptions,
  terminal: TerminalNotification,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE

  switch (env.terminal) {
    case 'Apple_Terminal': {
      const bellDisabled = await isAppleTerminalBellDisabled()
      if (bellDisabled) {
        terminal.notifyBell()
        return 'terminal_bell'
      }
      return 'no_method_available'
    }
    case 'iTerm.app':
      terminal.notifyITerm2(opts)
      return 'iterm2'
    case 'kitty':
      terminal.notifyKitty({ ...opts, title, id: generateKittyId() })
      return 'kitty'
    case 'ghostty':
      terminal.notifyGhostty({ ...opts, title })
      return 'ghostty'
    default:
      return 'no_method_available'
  }
}

/**
 * 给 Kitty 通知生成一个随机 ID。
 *
 * 为什么需要：Kitty 的桌面通知协议要求每条通知带一个 id，
 * 相同 id 会被认为是同一条通知从而被**覆盖**。
 * 这里用 0~9999 的随机数，目的只是让相邻通知不互相顶掉，
 * 不要求全局唯一，所以用 Math.random() 就够（无需 UUID 那种强度）。
 */
function generateKittyId(): number {
  return Math.floor(Math.random() * 10000)
}

/**
 * 判断 macOS 自带终端（Apple_Terminal）的响铃是否被用户关掉了。
 *
 * 为什么需要：Apple_Terminal 唯一能用的提醒就是响铃。
 * 如果用户在「终端 → 设置 → 描述文件」里把 Bell 关了，
 * 我们再发响铃也是静悄悄的——与其假装通知成功，不如如实上报没有可用方式。
 *
 * 怎么读到的（两步走，都是调 macOS 命令行）：
 *   ① `osascript` 问 Terminal「当前窗口用的是哪个描述文件（profile）」
 *   ② `defaults export com.apple.Terminal -` 导出全部配置（plist XML 格式），
 *      再从这个大字典里取出该 profile 下的 Bell 开关
 *
 * 任何一步失败都返回 false（保守策略）：
 * 宁可多发一次无害的响铃，也不要因为探测失败就彻底不通知。
 *
 * @returns true = 响铃被关闭（不该再发）；false = 未关闭，或探测失败按未关闭处理
 */
async function isAppleTerminalBellDisabled(): Promise<boolean> {
  try {
    if (env.terminal !== 'Apple_Terminal') {
      return false
    }

    const osascriptResult = await execFileNoThrow('osascript', [
      '-e',
      'tell application "Terminal" to name of current settings of front window',
    ])
    const currentProfile = osascriptResult.stdout.trim()

    if (!currentProfile) {
      return false
    }

    const defaultsOutput = await execFileNoThrow('defaults', [
      'export',
      'com.apple.Terminal',
      '-',
    ])

    if (defaultsOutput.code !== 0) {
      return false
    }

    // 中文补注：这里用 await import('plist') 动态导入而**不是**顶部静态 import，
    // 是因为 plist 库连带 xmlbuilder + @xmldom 打包后约 280KB；
    // 只有「macOS 自带终端 + auto 通道」这极少数用户才会走到这行。
    // 动态 import 让这 280KB 只在真正需要时才加载，不影响其它人的启动速度。
    // Lazy-load plist (~280KB with xmlbuilder+@xmldom) — only hit on
    // Apple_Terminal with auto-channel, which is a small fraction of users.
    const plist = await import('plist')
    const parsed: Record<string, unknown> = plist.parse(defaultsOutput.stdout)
    const windowSettings = parsed?.['Window Settings'] as
      | Record<string, unknown>
      | undefined
    const profileSettings = windowSettings?.[currentProfile] as
      | Record<string, unknown>
      | undefined

    if (!profileSettings) {
      return false
    }

    return profileSettings.Bell === false
  } catch (error) {
    logError(error)
    return false
  }
}
