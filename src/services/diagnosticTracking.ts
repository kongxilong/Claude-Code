/**
 * ============================================================================
 *  【文件总览】src/services/diagnosticTracking.ts —— IDE 诊断信息（报错/警告）追踪器
 * ============================================================================
 *
 *  一句话定位：
 *  Claude Code 改完文件后，会去问 IDE（VS Code / JetBrains）：
 *  「这个文件现在有哪些编译错误、lint 警告？」，并且**只报新增的那些**
 *  （改之前就有的错误不算 Claude 的锅）。本文件就是这个「基线对比」机制的实现。
 *
 *  在架构中的位置：
 *      src/services/tools/（Edit / Write 等会改文件的工具）
 *        ├─> diagnosticTracker.beforeFileEdited(path)   改文件**前**：抓一份基线
 *        ├─> ... 执行编辑 ...
 *        └─> diagnosticTracker.getNewDiagnostics()      改文件**后**：取新增的错误
 *                                                              ↑ ★ 本文件
 *              └─> callIdeRpc('getDiagnostics', ...)  ← src/services/mcp/client.js
 *                    （通过 MCP 协议向 IDE 插件发 RPC 请求）
 *
 *      src/query.ts 每轮对话开始时
 *        └─> handleQueryStart(clients)   自动找 IDE 客户端并初始化 / 重置
 *
 *  本文件包含什么：
 *   1. Diagnostic / DiagnosticFile          诊断信息的类型定义
 *   2. DiagnosticTrackingService            核心服务类（单例）
 *        - getInstance() / initialize() / shutdown() / reset()
 *        - beforeFileEdited()   编辑前抓基线
 *        - getNewDiagnostics()  编辑后取新增
 *        - handleQueryStart()   每轮对话开始时自动初始化
 *        - formatDiagnosticsSummary() / getSeveritySymbol()  把诊断渲染成人能读的文本
 *   3. diagnosticTracker   模块级单例，供全项目直接 import 使用
 *
 * ---------------------------------------------------------------------------
 *  【核心机制：基线对比（baseline diff）】
 * ---------------------------------------------------------------------------
 *  为什么需要：一个本来就有 20 个 TS 报错的老文件，Claude 改了一行之后仍然有 20 个，
 *  如果不做对比就报「你引入了 20 个错误」，既冤枉又噪音巨大。
 *  正确做法是：
 *      编辑**前**先拍一张快照（baseline）
 *      编辑**后**再取一次，逐一比对，只把「新出现的」报出来
 *  ≈ Java 里跑测试前先记录一次基线覆盖率/静态分析结果，跑完再 diff。
 *
 *  【为什么还要区分 file:// 和 _claude_fs_right:】
 *  这是本文件最容易看不懂的地方。IDE 里做「并排 diff」时会有两份文件：
 *      file://              磁盘上**实际**的文件（真实状态）
 *      _claude_fs_left:     编辑前的旧版本（左栏）
 *      _claude_fs_right:    编辑后的新版本（右栏，IDE 内存里的预览）
 *  语言服务（类型检查器）分析的可能还是旧内容，也可能已经是新内容。
 *  代码里的策略是：优先用 _claude_fs_right: 的那份，
 *  因为那是「Claude 刚改完的结果」，时效性最好；
 *  但只有当它**相对于上次发生了变化**时才切换过去（见 getNewDiagnostics 里的判断），
 *  避免拿到一份还没更新的旧数据。
 *
 *  【为什么到处都是 `if (!this.initialized || !this.mcpClient || type !== 'connected') return`】
 *  用户可能压根没开 IDE 插件，或者 IDE 插件不支持诊断能力。
 *  诊断追踪是**锦上添花**的增强，绝不能因为没有 IDE 就让编辑工具失败。
 *  所以每个入口都先做「能力探测」，不具备就安静地什么都不做。
 *
 *  【踩过的坑：为什么要归一化路径（normalizeFileUri）】
 *  同一个文件在不同来源下写法完全不同：
 *      file:///Users/a/b.ts、_claude_fs_right:/Users/a/b.ts、/Users/a/b.ts
 *  而且 Windows 上路径**大小写不敏感**、分隔符是反斜杠。
 *  如果直接拿字符串当 Map 的 key，同一个文件会被当成好几个文件，
 *  基线永远对不上。所以统一走 normalizePathForComparison() 做平台感知的归一化。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `export class X { private static instance: X | undefined }`
 *      **类 + 静态字段**。TS 的类语法和 Java 高度相似，但注意：
 *        `private` 只是**编译期**约束（JS 运行时其实能访问），
 *        ≈ Java 的 private 更弱一档；真正的运行时私有要用 `#field`。
 *
 *  - `static getInstance(): X`  **单例模式**的经典写法。
 *      ≈ Java 里手写的 `private static X instance; public static X getInstance()`。
 *      为什么用单例：整个进程只需要一份「所有文件的诊断基线」，
 *      分散成多份会导致改文件时读不到别人存的基线。
 *
 *  - `private baseline: Map<string, Diagnostic[]> = new Map()`
 *      字段声明 + 初始化。≈ Java 的 `private Map<String, List<Diagnostic>> baseline = new HashMap<>()`。
 *      注意 TS 里**字段初始化写在类体里**，不是构造函数里。
 *
 *  - `export interface Diagnostic { ... }`  接口。
 *      ≈ Java 的 interface，但 TS 的 interface 只描述结构、不含实现，
 *      且**任何长这样的对象都自动算实现了它**（鸭子类型，无需 implements）。
 *
 *  - `severity: 'Error' | 'Warning' | 'Info' | 'Hint'`
 *      **字符串字面量联合类型**。≈ Java 的 enum，但运行时就是普通字符串，
 *      好处是和 JSON / RPC 的数据格式天然兼容，不用做序列化转换。
 *
 *  - `range: { start: { line: number; character: number }, end: {...} }`
 *      嵌套的匿名结构类型。≈ Java 里要定义好几个 record，TS 直接内联写。
 *
 *  - `class DiagnosticsTrackingError extends ClaudeError {}`  继承，和 Java 一样。
 *      空类体的意思是「换个名字，方便在日志里区分来源」。
 *
 *  - `.filter(file => ...)` / `.some(b => ...)` / `.every(d => ...)`
 *      ≈ Java Stream 的 filter / anyMatch / allMatch。
 *
 *  - `this.baseline.get(normalizedPath) || []`
 *      `||` 兜底空数组：Map 里没这个 key 时 get 返回 undefined，
 *      用 `[]` 兜住，后面的 `.filter/.some` 就能无条件调用。
 *      （这里用 `||` 而非 `??` 是因为 undefined 是唯一的假值情况，两者等价）
 *
 *  - `catch (_error) { }`  用下划线前缀命名「故意不使用的变量」。
 *      这是 TS/JS 的惯例，告诉 linter 和读者「我知道有异常，但我就是要忽略它」。
 *
 *  - `new Map<string, DiagnosticFile>()`  泛型集合，≈ Java 的 `new HashMap<>()`。
 *
 *  - `[severity] || figures.bullet`  **对象当字典查表**再兜底：
 *      先构造一个「严重级别 → 符号」的对象，用 `[severity]` 取值，
 *      万一级别不在表里，用 `||` 兜底成圆点。
 *      ≈ Java 的 `map.getOrDefault(severity, BULLET)`。
 *
 *  - `d.code ? \` [${d.code}]\` : ''`  三元 + 模板字符串，
 *      等价于 Java 的 `d.code != null ? " [" + d.code + "]" : ""`。
 *
 *  - `static formatDiagnosticsSummary(...)`  **静态方法**，≈ Java 的 static 方法。
 * ============================================================================
 */
import figures from 'figures'
import { logError } from 'src/utils/log.js'
import { callIdeRpc } from '../services/mcp/client.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { ClaudeError } from '../utils/errors.js'
import { normalizePathForComparison, pathsEqual } from '../utils/file.js'
import { getConnectedIdeClient } from '../utils/ide.js'
import { jsonParse } from '../utils/slowOperations.js'

// 自定义错误类型：只是给 ClaudeError 换个名字，
// 这样日志里一眼就能看出「这条错误来自诊断追踪模块」，便于定位。
class DiagnosticsTrackingError extends ClaudeError {}

// 诊断摘要最多 4000 字符：诊断是要塞回给模型看的，
// 太长了会白白吃掉上下文额度，所以必须截断。
const MAX_DIAGNOSTICS_SUMMARY_CHARS = 4000

/**
 * 一条诊断信息（IDE 报出的一个错误/警告/提示）。
 * 字段与 LSP（Language Server Protocol）的 Diagnostic 定义基本一致，
 * 因为数据就是从 IDE 的语言服务那边原样透传过来的。
 */
export interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

/** 一个文件 + 它身上的所有诊断。uri 可能是 file:// 或 _claude_fs_right: 等协议开头。 */
export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

/**
 * 诊断追踪服务（单例）。
 *
 * 为什么是单例：所有编辑工具必须共享同一份「基线」，
 * 否则 A 工具存的基线 B 工具读不到，对比就失效了。
 */
export class DiagnosticTrackingService {
  private static instance: DiagnosticTrackingService | undefined
  private baseline: Map<string, Diagnostic[]> = new Map()

  private initialized = false
  private mcpClient: MCPServerConnection | undefined

  // Track when files were last processed/fetched
  private lastProcessedTimestamps: Map<string, number> = new Map()

  // Track which files have received right file diagnostics and if they've changed
  // Map<normalizedPath, lastClaudeFsRightDiagnostics>
  private rightFileDiagnosticsState: Map<string, Diagnostic[]> = new Map()

  /**
   * 获取单例实例（懒创建：第一次调用时才 new）。
   *
   * @returns 全局唯一的 DiagnosticTrackingService 实例
   */
  static getInstance(): DiagnosticTrackingService {
    if (!DiagnosticTrackingService.instance) {
      DiagnosticTrackingService.instance = new DiagnosticTrackingService()
    }
    return DiagnosticTrackingService.instance
  }

  /**
   * 绑定一个已连接的 IDE（MCP）客户端。
   *
   * 为什么需要：所有诊断数据都要通过 MCP 协议向 IDE 插件要，
   * 没有客户端就什么都做不了。所以这一步是「启用诊断追踪」的开关。
   *
   * 为什么有 `if (this.initialized) return`：重复初始化会覆盖掉已有客户端，
   * 也会让调用方误以为「重新初始化」能清状态（清状态请用 reset()）。
   *
   * @param mcpClient 已连接到 IDE 的 MCP 连接
   */
  initialize(mcpClient: MCPServerConnection) {
    if (this.initialized) {
      return
    }

    // TODO: Do not cache the connected mcpClient since it can change.
    this.mcpClient = mcpClient
    this.initialized = true
  }

  /**
   * 彻底关闭：清空所有状态并把服务标记为未初始化。
   *
   * 与 reset() 的区别：shutdown 会置 initialized = false（之后必须重新 initialize），
   * reset 只是清空数据、保持可用。用于会话结束/IDE 断开连接时。
   */
  async shutdown(): Promise<void> {
    this.initialized = false
    this.baseline.clear()
    this.rightFileDiagnosticsState.clear()
    this.lastProcessedTimestamps.clear()
  }

  /**
   * Reset tracking state while keeping the service initialized.
   * This clears all tracked files and diagnostics.
   */
  /**
   * 只清空追踪数据，保持服务处于已初始化状态。
   *
   * 为什么需要：每开始一轮新对话，上一轮的基线就作废了
   * （文件可能已被用户手动改过），必须清掉重来，
   * 但没必要重新去找一遍 IDE 客户端——所以不碰 initialized。
   */
  reset() {
    this.baseline.clear()
    this.rightFileDiagnosticsState.clear()
    this.lastProcessedTimestamps.clear()
  }

  /**
   * 把各种写法的文件 URI 归一化成统一形式，用作 Map 的 key。
   *
   * 为什么需要（本文件最容易踩的坑）：同一个文件在 IDE 里会以不同面目出现：
   *      file:///Users/a/b.ts
   *      _claude_fs_right:/Users/a/b.ts
   *      _claude_fs_left:/Users/a/b.ts
   *  如果直接拿原串当 key，同一个文件会被记成三份，基线永远对比不上。
   *
   * 两步走：
   *   ① 剥掉协议前缀（file:// / _claude_fs_right: / _claude_fs_left:）
   *   ② 交给 normalizePathForComparison() 做平台感知的归一化
   *      （Windows 上大小写不敏感、分隔符是反斜杠，都要统一）
   *
   * @param fileUri 任意写法的文件 URI
   * @returns 归一化后的路径字符串
   */
  private normalizeFileUri(fileUri: string): string {
    // Remove our protocol prefixes
    const protocolPrefixes = [
      'file://',
      '_claude_fs_right:',
      '_claude_fs_left:',
    ]

    let normalized = fileUri
    for (const prefix of protocolPrefixes) {
      if (fileUri.startsWith(prefix)) {
        normalized = fileUri.slice(prefix.length)
        break
      }
    }

    // Use shared utility for platform-aware path normalization
    // (handles Windows case-insensitivity and path separators)
    return normalizePathForComparison(normalized)
  }

  /**
   * Ensure a file is opened in the IDE before processing.
   * This is important for language services like diagnostics to work properly.
   */
  /**
   * 确保目标文件在 IDE 里是「打开」状态。
   *
   * 为什么需要：很多语言服务（类型检查、lint）**只对已打开的文件**做实时分析。
   * 如果文件没打开，IDE 会返回一个空的诊断列表，
   * 我们就误以为「改完没有错误」——其实只是没人分析它。
   * 所以取诊断之前要主动让 IDE 打开这个文件。
   *
   * 参数里那些 startText/endText/preview 都传空值或 false，
   * 是因为我们只想要「在后台加载」，不想抢焦点、不想移动光标打扰用户。
   *
   * @param fileUri 文件路径或 URI
   */
  async ensureFileOpened(fileUri: string): Promise<void> {
    if (
      !this.initialized ||
      !this.mcpClient ||
      this.mcpClient.type !== 'connected'
    ) {
      return
    }

    try {
      // Call the openFile tool to ensure the file is loaded
      await callIdeRpc(
        'openFile',
        {
          filePath: fileUri,
          preview: false,
          startText: '',
          endText: '',
          selectToEndOfLine: false,
          makeFrontmost: false,
        },
        this.mcpClient,
      )
    } catch (error) {
      logError(error as Error)
    }
  }

  /**
   * Capture baseline diagnostics for a specific file before editing.
   * This is called before editing a file to ensure we have a baseline to compare against.
   */
  /**
   * 编辑文件**之前**抓一份诊断基线。
   *
   * 为什么需要：这是「基线对比」的前半步。
   * 没有基线，改完之后就无法区分「本来就有的错误」和「Claude 新引入的错误」。
   *
   * 关键步骤：
   *   ① 能力探测：没初始化 / 没客户端 / 客户端未连接 → 安静返回
   *   ② 向 IDE 要这个文件的当前诊断
   *   ③ **校验路径一致性**：IDE 返回的可能是别的文件（比如重命名了），
   *      对不上就记一条错误并放弃，绝不把错误数据存成基线
   *   ④ 以归一化路径为 key 存进 baseline（没诊断也要存空数组，
   *      表示「我确认过，改之前它是干净的」）
   *
   * 为什么 IDE 不支持诊断时要静默失败：
   * 有些 IDE 插件没实现 getDiagnostics，这属于「能力缺失」而非「出错了」，
   * 不该往用户屏幕上刷错误。
   *
   * @param filePath 即将被编辑的文件路径
   */
  async beforeFileEdited(filePath: string): Promise<void> {
    if (
      !this.initialized ||
      !this.mcpClient ||
      this.mcpClient.type !== 'connected'
    ) {
      return
    }

    const timestamp = Date.now()

    try {
      const result = await callIdeRpc(
        'getDiagnostics',
        { uri: `file://${filePath}` },
        this.mcpClient,
      )
      const diagnosticFile = this.parseDiagnosticResult(result)[0]
      if (diagnosticFile) {
        // Compare normalized paths (handles protocol prefixes and Windows case-insensitivity)
        if (
          !pathsEqual(
            this.normalizeFileUri(filePath),
            this.normalizeFileUri(diagnosticFile.uri),
          )
        ) {
          logError(
            new DiagnosticsTrackingError(
              `Diagnostics file path mismatch: expected ${filePath}, got ${diagnosticFile.uri})`,
            ),
          )
          return
        }

        // Store with normalized path key for consistent lookups on Windows
        const normalizedPath = this.normalizeFileUri(filePath)
        this.baseline.set(normalizedPath, diagnosticFile.diagnostics)
        this.lastProcessedTimestamps.set(normalizedPath, timestamp)
      } else {
        // No diagnostic file returned, store an empty baseline
        const normalizedPath = this.normalizeFileUri(filePath)
        this.baseline.set(normalizedPath, [])
        this.lastProcessedTimestamps.set(normalizedPath, timestamp)
      }
    } catch (_error) {
      // Fail silently if IDE doesn't support diagnostics
    }
  }

  /**
   * Get new diagnostics from file://, _claude_fs_right, and _claude_fs_ URIs that aren't in the baseline.
   * Only processes diagnostics for files that have been edited.
   */
  /**
   * 编辑之后取回「新增的诊断」，也就是 Claude 这次改动引入的错误/警告。
   *
   * 为什么需要：这是本文件对外最有价值的能力——
   * 让模型在改完文件后能立刻知道「我是不是把代码写坏了」，
   * 从而自主修复，而不用等用户跑一遍编译再回来骂人。
   *
   * 关键步骤：
   *   ① 能力探测，不具备就返回空数组（绝不影响编辑流程）
   *   ② 拉全量诊断（空参数 = 要所有文件的）
   *   ③ 只保留**有基线**的文件 —— 没抓过基线的文件说明不是 Claude 改的，跳过
   *   ④ 对同时存在 _claude_fs_right: 版本的文件，判断是否该用「右栏」那份：
   *      从未见过右栏数据、或右栏数据刚发生变化 → 用右栏（时效性更好）
   *      否则沿用 file:// 那份（避免拿到还没刷新的旧数据）
   *   ⑤ 逐个与基线比对，只留下「基线里没有的」
   *   ⑥ 顺手把基线刷新成最新状态，为下一次对比做准备
   *
   * @returns 每个文件的新增诊断列表；没有新增时返回空数组
   */
  async getNewDiagnostics(): Promise<DiagnosticFile[]> {
    if (
      !this.initialized ||
      !this.mcpClient ||
      this.mcpClient.type !== 'connected'
    ) {
      return []
    }

    // Check if we have any files with diagnostic changes
    let allDiagnosticFiles: DiagnosticFile[] = []
    try {
      const result = await callIdeRpc(
        'getDiagnostics',
        {}, // Empty params fetches all diagnostics
        this.mcpClient,
      )
      allDiagnosticFiles = this.parseDiagnosticResult(result)
    } catch (_error) {
      // If fetching all diagnostics fails, return empty
      return []
    }
    const diagnosticsForFileUrisWithBaselines = allDiagnosticFiles
      .filter(file => this.baseline.has(this.normalizeFileUri(file.uri)))
      .filter(file => file.uri.startsWith('file://'))

    const diagnosticsForClaudeFsRightUrisWithBaselinesMap = new Map<
      string,
      DiagnosticFile
    >()
    allDiagnosticFiles
      .filter(file => this.baseline.has(this.normalizeFileUri(file.uri)))
      .filter(file => file.uri.startsWith('_claude_fs_right:'))
      .forEach(file => {
        diagnosticsForClaudeFsRightUrisWithBaselinesMap.set(
          this.normalizeFileUri(file.uri),
          file,
        )
      })

    const newDiagnosticFiles: DiagnosticFile[] = []

    // Process file:// protocol diagnostics
    for (const file of diagnosticsForFileUrisWithBaselines) {
      const normalizedPath = this.normalizeFileUri(file.uri)
      const baselineDiagnostics = this.baseline.get(normalizedPath) || []

      // Get the _claude_fs_right file if it exists
      const claudeFsRightFile =
        diagnosticsForClaudeFsRightUrisWithBaselinesMap.get(normalizedPath)

      // Determine which file to use based on the state of right file diagnostics
      let fileToUse = file

      if (claudeFsRightFile) {
        const previousRightDiagnostics =
          this.rightFileDiagnosticsState.get(normalizedPath)

        // Use _claude_fs_right if:
        // 1. We've never gotten right file diagnostics for this file (previousRightDiagnostics === undefined)
        // 2. OR the right file diagnostics have just changed
        if (
          !previousRightDiagnostics ||
          !this.areDiagnosticArraysEqual(
            previousRightDiagnostics,
            claudeFsRightFile.diagnostics,
          )
        ) {
          fileToUse = claudeFsRightFile
        }

        // Update our tracking of right file diagnostics
        this.rightFileDiagnosticsState.set(
          normalizedPath,
          claudeFsRightFile.diagnostics,
        )
      }

      // Find new diagnostics that aren't in the baseline
      const newDiagnostics = fileToUse.diagnostics.filter(
        d => !baselineDiagnostics.some(b => this.areDiagnosticsEqual(d, b)),
      )

      if (newDiagnostics.length > 0) {
        newDiagnosticFiles.push({
          uri: file.uri,
          diagnostics: newDiagnostics,
        })
      }

      // Update baseline with current diagnostics
      this.baseline.set(normalizedPath, fileToUse.diagnostics)
    }

    return newDiagnosticFiles
  }

  /**
   * 解析 IDE 通过 MCP 返回的诊断结果。
   *
   * 为什么需要这层解析：MCP 协议规定返回值是「内容块数组」
   * （MCP 的统一响应格式），真正的诊断数据藏在一个 type === 'text' 的块里，
   * 而且是 **JSON 字符串**。所以要：找 text 块 → 取出 text → JSON 解析。
   *
   * 为什么返回类型是 unknown：MCP 是跨进程/跨语言的协议，
   * 回来的数据形状没有编译期保证，必须运行时逐层校验再断言。
   *
   * @param result MCP 返回的原始结果
   * @returns 解析出的 DiagnosticFile 数组；解析不出时返回空数组
   */
  private parseDiagnosticResult(result: unknown): DiagnosticFile[] {
    if (Array.isArray(result)) {
      const textBlock = result.find(block => block.type === 'text')
      if (textBlock && 'text' in textBlock) {
        const parsed = jsonParse(textBlock.text)
        return parsed
      }
    }
    return []
  }

  /**
   * 判断两条诊断是否「同一条」。
   *
   * 为什么需要逐字段比而不是比对象引用：每次从 IDE 拉回来的都是**新对象**，
   * 引用必然不同，只能比内容。
   *
   * 为什么比这些字段：消息、严重级别、来源、错误码、起止行列——
   * 全都一样才算同一条（哪怕只是行号挪了一行，也是一条新的诊断）。
   * 注意**不比** uri，因为调用方已经保证是同一个文件了。
   *
   * @returns true = 视为同一条诊断
   */
  private areDiagnosticsEqual(a: Diagnostic, b: Diagnostic): boolean {
    return (
      a.message === b.message &&
      a.severity === b.severity &&
      a.source === b.source &&
      a.code === b.code &&
      a.range.start.line === b.range.start.line &&
      a.range.start.character === b.range.start.character &&
      a.range.end.line === b.range.end.line &&
      a.range.end.character === b.range.end.character
    )
  }

  /**
   * 判断两组诊断是否「内容相同」（顺序无关的双向比较）。
   *
   * 为什么不能简单按下标逐个比：IDE 返回诊断的顺序**不保证稳定**，
   * 内容一样但顺序不同是很常见的，会被误判成「变了」。
   * 所以这里做双向的 every/some：a 里每条在 b 里都能找到，且反过来也成立。
   * 先比长度可以快速排除绝大多数「变了」的情况。
   *
   * @returns true = 两组诊断内容一致
   */
  private areDiagnosticArraysEqual(a: Diagnostic[], b: Diagnostic[]): boolean {
    if (a.length !== b.length) return false

    // Check if every diagnostic in 'a' exists in 'b'
    return (
      a.every(diagA =>
        b.some(diagB => this.areDiagnosticsEqual(diagA, diagB)),
      ) &&
      b.every(diagB => a.some(diagA => this.areDiagnosticsEqual(diagA, diagB)))
    )
  }

  /**
   * Handle the start of a new query. This method:
   * - Initializes the diagnostic tracker if not already initialized
   * - Resets the tracker if already initialized (for new query loops)
   * - Automatically finds the IDE client from the provided clients list
   *
   * @param clients Array of MCP clients that may include an IDE client
   * @param shouldQuery Whether a query is actually being made (not just a command)
   */
  /**
   * 每轮对话开始时的钩子：自动找到 IDE 客户端并完成初始化或重置。
   *
   * 为什么需要：调用方（编辑工具）不该关心「IDE 连上了没有、要不要初始化」，
   * 由本服务自己从客户端列表里找出那个 IDE 就行。
   *
   * 两种分支：
   *   - 还没初始化 → 找 IDE 客户端并 initialize()
   *   - 已初始化   → reset()（新的一轮，上一轮的基线作废）
   *
   * @param clients 当前所有 MCP 连接（里面可能有、也可能没有 IDE 那个）
   */
  async handleQueryStart(clients: MCPServerConnection[]): Promise<void> {
    // Only proceed if we should query and have clients
    if (!this.initialized) {
      // Find the connected IDE client
      const connectedIdeClient = getConnectedIdeClient(clients)

      if (connectedIdeClient) {
        this.initialize(connectedIdeClient)
      }
    } else {
      // Reset diagnostic tracking for new query loops
      this.reset()
    }
  }

  /**
   * Format diagnostics into a human-readable summary string.
   * This is useful for displaying diagnostics in messages or logs.
   *
   * @param files Array of diagnostic files to format
   * @returns Formatted string representation of the diagnostics
   */
  /**
   * 把诊断列表格式化成一段「人/模型都能读」的文本摘要。
   *
   * 为什么需要：诊断最终要塞回给模型看（让它自己修），
   * 所以要渲染成 `文件名:\n  ✖ [Line 12:5] 类型不匹配 [TS2345] (ts)` 这种紧凑格式——
   * 信息密度高、token 消耗少。
   *
   * 为什么要截断到 4000 字符：诊断可能成百上千条，
   * 全塞进去会吃掉大量上下文额度，反而挤掉有用的代码信息。
   * 截断时预留出 `…[truncated]` 标记的长度，保证总长不超上限。
   *
   * 行号/列号 +1 是因为 IDE 的 LSP 用 **0-based** 行列，
   * 而人类（和编辑器界面）习惯 1-based。
   *
   * @param files 待格式化的诊断文件列表
   * @returns 格式化后的文本；超长时以 …[truncated] 结尾
   */
  static formatDiagnosticsSummary(files: DiagnosticFile[]): string {
    const truncationMarker = '…[truncated]'
    const result = files
      .map(file => {
        const filename = file.uri.split('/').pop() || file.uri
        const diagnostics = file.diagnostics
          .map(d => {
            const severitySymbol = DiagnosticTrackingService.getSeveritySymbol(
              d.severity,
            )

            return `  ${severitySymbol} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ''}${d.source ? ` (${d.source})` : ''}`
          })
          .join('\n')

        return `${filename}:\n${diagnostics}`
      })
      .join('\n\n')

    if (result.length > MAX_DIAGNOSTICS_SUMMARY_CHARS) {
      return (
        result.slice(
          0,
          MAX_DIAGNOSTICS_SUMMARY_CHARS - truncationMarker.length,
        ) + truncationMarker
      )
    }
    return result
  }

  /**
   * Get the severity symbol for a diagnostic
   */
  /**
   * 按严重级别给出对应的图形符号（✖ / ⚠ / ℹ / ★）。
   *
   * 为什么需要：终端里没法用颜色区分时，符号是最直观的严重级别提示。
   * 用 figures 库而不是硬编码 Unicode，是因为要兼容不同终端的字体支持情况。
   *
   * 最后的 `|| figures.bullet` 是兜底：
   * 万一 IDE 返回了一个我们没见过的级别，至少要显示个圆点而不是 undefined。
   *
   * @param severity 严重级别
   * @returns 对应的符号字符
   */
  static getSeveritySymbol(severity: Diagnostic['severity']): string {
    return (
      {
        Error: figures.cross,
        Warning: figures.warning,
        Info: figures.info,
        Hint: figures.star,
      }[severity] || figures.bullet
    )
  }
}

// 模块级单例：全项目直接 `import { diagnosticTracker }` 就能用，
// 保证所有调用方共享同一份基线数据。
export const diagnosticTracker = DiagnosticTrackingService.getInstance()
