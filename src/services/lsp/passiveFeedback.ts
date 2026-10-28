/**
 * 【一句话定位】
 * 「被动反馈」的接线员：给每个 language server 注册 textDocument/publishDiagnostics 监听，
 * 把 LSP 原始诊断数据翻译成 Claude 内部格式，然后交给 LSPDiagnosticRegistry 暂存。
 * 「被动」= 不是用户/模型主动去查，而是编辑器后台自动推送过来。
 *
 * 【在架构中的位置】
 * 完整回流链：
 *   language server 分析完代码
 *     → 主动推 textDocument/publishDiagnostics 通知
 *       → 本文件 registerLSPNotificationHandlers() 里注册的回调（协议转换 + 防御性校验）
 *         → formatDiagnosticsForAttachment()（LSP 格式 → DiagnosticFile 格式）
 *           → LSPDiagnosticRegistry.registerPendingLSPDiagnostic()（暂存、去重、限流）
 *             → 对话层取件 → 作为 attachment 喂给模型
 * 上游：应用启动时（或 LSP 初始化后）被调用一次，入参是 LSPServerManager。
 * 下游：LSPDiagnosticRegistry.ts。
 *
 * 【本文件包含什么】
 * - mapLSPSeverity()：LSP 的数字严重度（1/2/3/4）→ Claude 的字符串严重度（'Error'/'Warning'/'Info'/'Hint'）。
 * - formatDiagnosticsForAttachment()：把一条 publishDiagnostics 通知转成 DiagnosticFile[]。
 * - type HandlerRegistrationResult：注册结果统计（多少个 server、成功几个、失败原因、运行时失败计数）。
 * - registerLSPNotificationHandlers()：给所有 server 逐个挂上诊断监听器。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `): 'Error' | 'Warning' | 'Info' | 'Hint' {`：返回类型是「字符串字面量联合类型」。
 *   ≈ Java 的 enum，但 TS 里就是几个字符串常量的或关系；写错字面量编译器会直接报错，
 *   比 Java 用 String 常量更安全（Java 要 enum 才有这种检查）。
 * - `params.diagnostics.map((diag: {...}) => ({...}))`：
 *   map ≈ Java Stream.map。注意箭头函数体用 `({...})` 圆括号包住对象字面量——
 *   这是必须的，否则 `{` 会被当成函数体的大括号。Java 没有这个坑（lambda 体一定是 {}）。
 * - `(diag: { message: string; severity?: number; ... })`：内联对象类型作为入参类型，
 *   ≈ Java 里临时定义一个 record，但不用起名。
 * - `'uri' in params`：`in` 运算符判断对象是否含有某个属性。≈ Java 的 `map.containsKey("uri")`，
 *   但 TS 里它是「类型收窄」手段之一——判断后编译器就知道 params 上有这个字段了。
 * - `typeof params !== 'object'`：typeof 是运行期类型判断 ≈ Java 的 `x instanceof Object`，
 *   返回字符串 'object'/'string'/'number'/'function'/'undefined' 等。
 * - `params as PublishDiagnosticsParams`：类型断言 ≈ Java 强制转换。
 *   这里因为前一步已经用 in 校验过字段存在，所以断言是「有依据的」，属于 TS 里常见的安全用法。
 * - `String(diag.code)`：全局 String() 函数把任意值转成字符串 ≈ Java 的 String.valueOf(x)。
 * - `code?: string | number`：可选 + 联合类型，表示「可能没有，有的话是 string 或 number」。
 * - `for (const [serverName, serverInstance] of servers.entries())`：遍历 Map 的键值对并解构。
 *   ≈ Java 的 `for (Map.Entry<K,V> e : map.entrySet())`，只是直接把 key/value 拆成了两个变量。
 * - `continue` / `break`：和 Java 一样。
 * - `const failures = diagnosticFailures.get(serverName) || { count: 0, lastError: '' }`：
 *   「取不到就用一个新对象」的惯写法，等价于 Java 的 `map.getOrDefault(k, new Failure())`。
 * - 闭包：handler 回调里能一直访问外层的 serverName——因为 JS 闭包会捕获外层变量。
 *   Java 里 lambda 捕获的局部变量必须是 effectively final，这里没这个限制。
 * - 嵌套 try/catch：外层兜整个 handler，内层只兜 registerPendingLSPDiagnostic。
 *   目的都是「绝不把异常抛回 JSON-RPC 通知循环」，否则会打断后续所有通知。
 */
import { fileURLToPath } from 'url'
import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { DiagnosticFile } from '../diagnosticTracking.js'
import { registerPendingLSPDiagnostic } from './LSPDiagnosticRegistry.js'
import type { LSPServerManager } from './LSPServerManager.js'

/**
 * Map LSP severity to Claude diagnostic severity
 *
 * Maps LSP severity numbers to Claude diagnostic severity strings.
 * Accepts numeric severity values (1=Error, 2=Warning, 3=Information, 4=Hint)
 * or undefined, defaulting to 'Error' for invalid/missing values.
 */
// 中文补充：LSP 规范里 severity 是数字枚举（1=Error 2=Warning 3=Information 4=Hint），
// 而 Claude 内部用字符串。这里做一次映射。
// 注意 default 分支：非法值/缺失值一律当 'Error'——宁可严重一点让模型重视，
// 也不要因为「认不出严重度」就把真实错误降级成提示悄悄放过。
function mapLSPSeverity(
  lspSeverity: number | undefined,
): 'Error' | 'Warning' | 'Info' | 'Hint' {
  // LSP DiagnosticSeverity enum:
  // 1 = Error, 2 = Warning, 3 = Information, 4 = Hint
  switch (lspSeverity) {
    case 1:
      return 'Error'
    case 2:
      return 'Warning'
    case 3:
      return 'Info'
    case 4:
      return 'Hint'
    default:
      return 'Error'
  }
}

/**
 * Convert LSP diagnostics to Claude diagnostic format
 *
 * Converts LSP PublishDiagnosticsParams to DiagnosticFile[] format
 * used by Claude's attachment system.
 */
// 协议转换：LSP 的 PublishDiagnosticsParams → Claude 内部的 DiagnosticFile[]。
// @param params 一条 publishDiagnostics 通知的内容（uri + diagnostics 数组）
// @returns 固定长度 1 的数组（一条通知只针对一个文件）——包成数组是为了和上层接口对齐。
// 关键步骤：① 把 file:// URI 还原成真实文件路径 ② 逐条转换字段 ③ 包成 DiagnosticFile 返回。
export function formatDiagnosticsForAttachment(
  params: PublishDiagnosticsParams,
): DiagnosticFile[] {
  // Parse URI (may be file:// or plain path) and normalize to file system path
// 为什么用 let 再赋值而不是直接三元：URI 转换可能抛异常（畸形 URI），需要 try-catch 兜住。
  let uri: string
  try {
    // Handle both file:// URIs and plain paths
// 防御性：有些 server（或插件）发的不是标准 file:// URI，而是直接发个裸路径。两种都得兼容。
    uri = params.uri.startsWith('file://')
      ? fileURLToPath(params.uri)
      : params.uri
  } catch (error) {
    const err = toError(error)
    logError(err)
    logForDebugging(
      `Failed to convert URI to file path: ${params.uri}. Error: ${err.message}. Using original URI as fallback.`,
    )
    // Gracefully fallback to original URI - LSP servers may send malformed URIs
// 兜底策略：转换失败就用原始 URI 当作路径。虽然路径可能不标准，但至少模型能看到文件名，
// 总比整条诊断被丢掉强。这是本文件反复出现的原则：绝不因为格式问题丢失诊断。
    uri = params.uri
  }

  const diagnostics = params.diagnostics.map(
    (diag: {
      message: string
      severity?: number
      range: {
        start: { line: number; character: number }
        end: { line: number; character: number }
      }
      source?: string
      code?: string | number
    }) => ({
      message: diag.message,
      severity: mapLSPSeverity(diag.severity),
      range: {
        start: {
          line: diag.range.start.line,
          character: diag.range.start.character,
        },
        end: {
          line: diag.range.end.line,
          character: diag.range.end.character,
        },
      },
      source: diag.source,
// 显式判 undefined/null 再 String()：因为 String(undefined) 会得到字符串 "undefined"，
// 那会变成一个看似合法的 code 值混进诊断里。这里要的是「没有就没有」。
// 注意这是 `!== undefined && !== null` 而不是 `??`：因为要区分「code 是 0」这种情况——
// code=0 是合法的错误码，不能被当成空值丢掉（用 || 也会踩这个坑）。
      code:
        diag.code !== undefined && diag.code !== null
          ? String(diag.code)
          : undefined,
    }),
  )

  return [
    {
      uri,
      diagnostics,
    },
  ]
}

/**
 * Handler registration result with tracking data
 */
// 注册结果统计：调用方（和单测）据此判断「LSP 诊断到底接上没有」。
// diagnosticFailures 是「运行时」失败计数（区别于 registrationErrors 的「注册期」失败），
// 并且是共享引用——外面拿到的 Map 会被后续 handler 调用持续更新。
export type HandlerRegistrationResult = {
  /** Total number of servers */
  totalServers: number
  /** Number of successful registrations */
  successCount: number
  /** Registration errors per server */
  registrationErrors: Array<{ serverName: string; error: string }>
  /** Runtime failure tracking (shared across all handler invocations) */
  diagnosticFailures: Map<string, { count: number; lastError: string }>
}

/**
 * Register LSP notification handlers on all servers
 *
 * Sets up handlers to listen for textDocument/publishDiagnostics notifications
 * from all LSP servers and routes them to Claude's diagnostic system.
 * Uses public getAllServers() API for clean access to server instances.
 *
 * @returns Tracking data for registration status and runtime failures
 */
// 给所有已配置的 server 挂上诊断监听。
// @param manager LSPServerManager 实例（提供 getAllServers()）
// @returns 注册结果统计（含共享的 diagnosticFailures，可用于后续监控）
// 关键步骤：
// ① 取出所有 server 实例
// ② 逐个注册 textDocument/publishDiagnostics 回调（单个失败不影响其他）
// ③ 回调内部：校验参数 → 转换格式 → 空诊断跳过 → 交给 Registry 暂存
// ④ 统计成功/失败并返回
// 为什么要在「注册期」和「运行期」都做容错：注册期失败只影响一个 server；
// 运行期失败如果不拦住，异常会冒到 vscode-jsonrpc 的通知循环里，可能让整个连接失效。
export function registerLSPNotificationHandlers(
  manager: LSPServerManager,
): HandlerRegistrationResult {
  // Register handlers on all configured servers to capture diagnostics from any language
  const servers = manager.getAllServers()

  // Track partial failures - allow successful server registrations even if some fail
// 「部分成功」设计：不能因为一个 server 配错就全盘放弃，其他语言的诊断照样要能收到。
  const registrationErrors: Array<{ serverName: string; error: string }> = []
  let successCount = 0

  // Track consecutive failures per server to warn users after 3+ failures
// 连续失败计数器：同一个 server 连续失败 3 次以上才告警。
// 为什么不失败一次就报？因为偶发失败（比如某次 URI 畸形）很正常，
// 只有持续失败才说明这个 server 真的有问题，值得提示用户去查。
  const diagnosticFailures: Map<string, { count: number; lastError: string }> =
    new Map()

  for (const [serverName, serverInstance] of servers.entries()) {
    try {
      // Validate server instance has onNotification method
// 防御性校验：typeof x === 'function' 是 JS 里判断「能不能调用」的标准写法，
// ≈ Java 的 `x instanceof SomeInterface` 或反射检查方法是否存在。
      if (
        !serverInstance ||
        typeof serverInstance.onNotification !== 'function'
      ) {
        const errorMsg = !serverInstance
          ? 'Server instance is null/undefined'
          : 'Server instance has no onNotification method'

        registrationErrors.push({ serverName, error: errorMsg })

        const err = new Error(`${errorMsg} for ${serverName}`)
        logError(err)
        logForDebugging(
          `Skipping handler registration for ${serverName}: ${errorMsg}`,
        )
        continue // Skip this server but track the failure
      }

      // Errors are isolated to avoid breaking other servers
// 这里注册的回调，就是整条「编译器 → 模型」链路的起点。
// 注意方向：这是 server 主动推给我们（notification），不是我们请求来的。
      serverInstance.onNotification(
        'textDocument/publishDiagnostics',
        (params: unknown) => {
          logForDebugging(
            `[PASSIVE DIAGNOSTICS] Handler invoked for ${serverName}! Params type: ${typeof params}`,
          )
          try {
            // Validate params structure before casting
// 收到的是 unknown，必须先做结构校验再 as 断言——否则对端发个畸形包我们就可能读到 undefined 字段。
// `!params` 顺带排掉 null；`typeof params !== 'object'` 排掉字符串/数字等。
// 这是处理「外部不可信输入」的标准防御姿势，Java 里对应 Bean Validation / 手写校验。
            if (
              !params ||
              typeof params !== 'object' ||
              !('uri' in params) ||
              !('diagnostics' in params)
            ) {
              const err = new Error(
                `LSP server ${serverName} sent invalid diagnostic params (missing uri or diagnostics)`,
              )
              logError(err)
              logForDebugging(
                `Invalid diagnostic params from ${serverName}: ${jsonStringify(params)}`,
              )
              return
            }

// 校验通过后才敢断言（as）。此时 params 一定含 uri 和 diagnostics。
            const diagnosticParams = params as PublishDiagnosticsParams
            logForDebugging(
              `Received diagnostics from ${serverName}: ${diagnosticParams.diagnostics.length} diagnostic(s) for ${diagnosticParams.uri}`,
            )

            // Convert LSP diagnostics to Claude format (can throw on invalid URIs)
            const diagnosticFiles =
              formatDiagnosticsForAttachment(diagnosticParams)

            // Only send notification if there are diagnostics
// 空诊断要跳过：LSP 有个重要语义——server 发「空 diagnostics 数组」表示「这个文件的错误都修好了」。
// 这种「清空」消息不该当成新诊断喂给模型，否则模型会看到一条没内容的附件。
            const firstFile = diagnosticFiles[0]
            if (
              !firstFile ||
              diagnosticFiles.length === 0 ||
              firstFile.diagnostics.length === 0
            ) {
              logForDebugging(
                `Skipping empty diagnostics from ${serverName} for ${diagnosticParams.uri}`,
              )
              return
            }

            // Register diagnostics for async delivery via attachment system
            // Follows same pattern as AsyncHookRegistry for consistent async attachment delivery
// 到这里才真正「入库」。注意它只是暂存，真正的投递由对话层在下一轮触发。
            try {
              registerPendingLSPDiagnostic({
                serverName,
                files: diagnosticFiles,
              })

              logForDebugging(
                `LSP Diagnostics: Registered ${diagnosticFiles.length} diagnostic file(s) from ${serverName} for async delivery`,
              )

              // Success - reset failure counter for this server
// 成功一次就清零计数器：只要能正常工作，之前的偶发失败就不再追究。
              diagnosticFailures.delete(serverName)
            } catch (error) {
              const err = toError(error)
              logError(err)
              logForDebugging(
                `Error registering LSP diagnostics from ${serverName}: ` +
                  `URI: ${diagnosticParams.uri}, ` +
                  `Diagnostic count: ${firstFile.diagnostics.length}, ` +
                  `Error: ${err.message}`,
              )

              // Track consecutive failures and warn after 3+
              const failures = diagnosticFailures.get(serverName) || {
                count: 0,
                lastError: '',
              }
              failures.count++
              failures.lastError = err.message
              diagnosticFailures.set(serverName, failures)

// 连续 3 次失败才告警，避免刷屏。
              if (failures.count >= 3) {
                logForDebugging(
                  `WARNING: LSP diagnostic handler for ${serverName} has failed ${failures.count} times consecutively. ` +
                    `Last error: ${failures.lastError}. ` +
                    `This may indicate a problem with the LSP server or diagnostic processing. ` +
                    `Check logs for details.`,
                )
              }
            }
// 最外层兜底：任何漏网异常都在这里被吞掉（只记日志）。
// 为什么要吞：JSON-RPC 的通知回调里抛异常会冒到 vscode-jsonrpc 的事件循环，
// 可能导致连接被判定为错误并关闭，那样连「后续诊断」都收不到了——损失远大于丢一条诊断。
          } catch (error) {
            // Catch any unexpected errors from the entire handler to prevent breaking the notification loop
            const err = toError(error)
            logError(err)
            logForDebugging(
              `Unexpected error processing diagnostics from ${serverName}: ${err.message}`,
            )

            // Track consecutive failures and warn after 3+
            const failures = diagnosticFailures.get(serverName) || {
              count: 0,
              lastError: '',
            }
            failures.count++
            failures.lastError = err.message
            diagnosticFailures.set(serverName, failures)

            if (failures.count >= 3) {
              logForDebugging(
                `WARNING: LSP diagnostic handler for ${serverName} has failed ${failures.count} times consecutively. ` +
                  `Last error: ${failures.lastError}. ` +
                  `This may indicate a problem with the LSP server or diagnostic processing. ` +
                  `Check logs for details.`,
              )
            }

            // Don't re-throw - isolate errors to this server only
          }
        },
      )

      logForDebugging(`Registered diagnostics handler for ${serverName}`)
      successCount++
    } catch (error) {
      const err = toError(error)

      registrationErrors.push({
        serverName,
        error: err.message,
      })

      logError(err)
      logForDebugging(
        `Failed to register diagnostics handler for ${serverName}: ` +
          `Error: ${err.message}`,
      )
    }
  }

  // Report overall registration status
// 汇总日志：让运维/用户一眼看出「几个 server 里成功了几个」，
// 而不是去翻一堆单行日志。
  const totalServers = servers.size
  if (registrationErrors.length > 0) {
    const failedServers = registrationErrors
      .map(e => `${e.serverName} (${e.error})`)
      .join(', ')
    // Log aggregate failures for tracking
    logError(
      new Error(
        `Failed to register diagnostics for ${registrationErrors.length} LSP server(s): ${failedServers}`,
      ),
    )
    logForDebugging(
      `LSP notification handler registration: ${successCount}/${totalServers} succeeded. ` +
        `Failed servers: ${failedServers}. ` +
        `Diagnostics from failed servers will not be delivered.`,
    )
  } else {
    logForDebugging(
      `LSP notification handlers registered successfully for all ${totalServers} server(s)`,
    )
  }

  // Return tracking data for monitoring and testing
  return {
    totalServers,
    successCount,
    registrationErrors,
    diagnosticFailures,
  }
}
