/**
 * ============================================================================
 *  【文件总览】src/tools/LSPTool/LSPTool.ts —— 把 LSP 能力包装成一个「工具」
 * ============================================================================
 *
 *  ★★ 一句话定位（也是整个 LSPTool 目录最需要说清的一点）★★
 *
 *  本文件是**薄封装**：它的全部职责是「把一个已存在的能力，按 Claude Code 的
 *  Tool 接口规范暴露出去」，让模型能像调 Read/Grep 一样去调它。
 *
 *  **真正的 LSP 客户端不在这里**，在 src/services/lsp/：
 *
 *      src/tools/LSPTool/LSPTool.ts   ← ★ 本文件（薄封装层，约 860 行）
 *          │   职责：参数校验、权限检查、打开文件、挑出该调哪个 LSP method、
 *          │        过滤 gitignore、格式化结果、渲染 UI
 *          │   不职责：不管进程怎么起、不管 JSON-RPC 怎么编解码、不管端口怎么连
 *          │
 *          └─ getLspServerManager() ──┐
 *                                     ▼
 *      src/services/lsp/manager.ts          ← 全局单例入口，本文件只用它的 5 个函数
 *      src/services/lsp/LSPServerManager.ts ← 真正的重头戏：
 *                                              按后缀选 server、拉起子进程、
 *                                              维护「哪些文件已 didOpen」、
 *                                              崩溃自动重启、并发请求排队
 *      src/services/lsp/LSPClient.ts        ← JSON-RPC 编解码、超时、重试
 *      src/services/lsp/LSPServerInstance.ts ← 单个 server 进程的生命周期
 *      src/services/lsp/config.ts           ← 后缀 → 命令 的映射表（.ts 用哪台 server）
 *      src/services/lsp/LSPDiagnosticRegistry.ts ← 收集 diagnostic（报错/警告）
 *
 *  类比 Java 项目：
 *      本文件       ≈ Controller / Facade（接收请求、校验、编排、返回 DTO）
 *      services/lsp ≈ Service + 连接池 + 协议客户端（真正干活的）
 *
 *  所以如果你要找「为什么 .py 文件没有跳转」，答案是 src/services/lsp/config.ts
 *  没配 python 的 server；而不是本文件的问题。
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置】调用链
 * ---------------------------------------------------------------------------
 *      src/tools.ts
 *        └─ 工具表里注册 LSPTool（且仅当环境变量 ENABLE_LSP_TOOL 为真时才注册）
 *              └─ src/query.ts 主循环把它的 description + inputSchema 发给模型
 *                    └─ 模型返回 tool_use(name='LSP', input={operation, filePath, line, character})
 *                          └─ src/services/tools/toolOrchestration.ts 执行
 *                                ├─ validateInput()      ← ★ 本文件（先校验）
 *                                ├─ checkPermissions()   ← ★ 本文件（读权限）
 *                                ├─ call()               ← ★ 本文件（真正执行）
 *                                │     └─ getLspServerManager().sendRequest(method, params)
 *                                │           └─ src/services/lsp/*（真正发给 language server）
 *                                └─ renderToolResultMessage() ← src/tools/LSPTool/UI.tsx
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   对外的工具对象：
 *     LSPTool            buildTool({...}) 的产物，本文件唯一导出（另有 Input/Output 类型）
 *
 *   LSPTool 上的关键方法（按执行顺序）：
 *     isEnabled()        没有连上任何 language server 时，这个工具根本不出现在工具表里
 *     inputSchema/outputSchema  惰性 getter，给模型/校验用
 *     validateInput()    ① schema 严格校验 ② 文件存在性 ③ 必须是普通文件（不能是目录）
 *     checkPermissions() 复用通用的「读文件权限」检查
 *     call()             ★ 主流程：等初始化 → 取 manager → didOpen 文件 → 发请求
 *                        → 调用层级要发两次 → 过滤 gitignore → 格式化
 *     mapToolResultToToolResultBlockParam()  把 Output 变成 API 要求的 tool_result 块
 *
 *   文件内的私有辅助函数：
 *     getMethodAndParams()          operation → LSP method 名 + 参数（并做 1-based→0-based 换算）
 *     countSymbols()                递归数符号总数（含嵌套 children）
 *     countUniqueFiles()            按 uri 去重数文件数
 *     uriToFilePath()               file:// URI → 本地路径（含 Windows 盘符特判）
 *     filterGitIgnoredLocations()   批量调 `git check-ignore` 把被忽略的文件剔除
 *     isLocationLink()              类型守卫：区分 Location 与 LocationLink
 *     toLocation()                  LocationLink → Location（统一形态）
 *     formatResult()                ★ 按 operation 分派到 formatters.ts，并统计 resultCount/fileCount
 *     countUniqueFilesFromCallItems / ...IncomingCalls / ...OutgoingCalls  三种调用层级结构各自数文件
 *
 * ---------------------------------------------------------------------------
 *  【本文件最容易看不懂的三件事】
 * ---------------------------------------------------------------------------
 *   ① **为什么要先 didOpen？**
 *      绝大多数 language server 要求客户端先发 `textDocument/didOpen` 把文件内容
 *      送过去，之后才能回答 definition/hover 之类的问题（因为它们是基于内存里的
 *      文档快照工作的，不会自己去读磁盘）。所以 call() 里看到文件没开就先读内容
 *      再 manager.openFile()。这里的 `isFileOpen` 判断是为了**避免重复读大文件**。
 *
 *   ② **为什么 incomingCalls / outgoingCalls 要发两次请求？**
 *      这是 LSP 协议规定的两步流程，不是本文件自作主张：
 *        第 1 次 textDocument/prepareCallHierarchy → 拿「锚点」CallHierarchyItem
 *        第 2 次 callHierarchy/incomingCalls（把锚点原样塞进 item 字段）
 *      所以 getMethodAndParams() 里这两个 operation 返回的 method 其实**都是**
 *      prepareCallHierarchy，真正的第二步在 call() 里手工补发。
 *
 *   ③ **为什么要过滤 gitignore？**
 *      findReferences 可能返回几百条结果，其中大量落在 node_modules、build 产物
 *      这些被 gitignore 的目录里 —— 那些不是人写的代码，对模型是纯噪声。
 *      过滤方式是批量调 `git check-ignore`（每批 50 个路径），
 *      而不是对每个文件单独启一个 git 进程（那样几百次 fork 会很慢）。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查（Java 工程师视角，按本文件实际出现的）】
 * ---------------------------------------------------------------------------
 *   - `import type { X } from '...'`  只导入**类型**（编译后会被完全擦除）。
 *                            ≈ Java 没有对应物（Java 的 import 不区分类型/值）。
 *                            好处：避免为了拿一个类型而把整个模块打进产物。
 *
 *   - `buildTool({...})`     工厂函数：传一个大对象字面量，返回一个 Tool 对象。
 *                            ≈ Java 的 Builder 模式 / 匿名内部类一次性实现一堆回调。
 *                            对象字面量里的 `async call(input, context) {...}` 是
 *                            **方法简写**，等价于 `call: async function (input, context) {...}`。
 *
 *   - `satisfies ToolDef<InputSchema, Output>`
 *                            `satisfies` 运算符（TS 4.9+）：「这个对象**满足**某类型，
 *                            但请保留我写出的**更精确**的推断类型」。
 *                            ≈ `as ToolDef<...>` 的升级版：as 会把类型**抹平**成
 *                            ToolDef（之后访问具体字段可能报错），satisfies 不会。
 *                            可以理解为「编译期断言 + 不丢失精度」。
 *
 *   - `get inputSchema(): InputSchema { return inputSchema() }`
 *                            **getter**：访问 `LSPTool.inputSchema` 时才执行函数体。
 *                            ≈ Java 的 getter 方法，但调用方不用写括号。
 *                            为什么要懒？因为 schema 构造有开销，且工具表启动时会
 *                            被全部加载 —— 延迟到真正用到再构造，省冷启动时间。
 *
 *   - `async call(input: Input, _context)`  下划线前缀参数 = 「我知道有这个参数但不用」。
 *                            ≈ Java 里没用就删掉，但 JS 因为要**保持位置**不能删。
 *
 *   - `10_000_000` / `100_000` / `5_000`  数字分隔符，纯可读性糖，值不变。
 *                            ≈ Java 也支持 `1_000_000`（Java 7+）。
 *
 *   - `Promise<ValidationResult>`  ≈ Java 的 `CompletableFuture<ValidationResult>`。
 *                            `await` ≈ `.join()`，但**不阻塞线程**（事件循环继续跑）。
 *
 *   - `try { ... } finally { await handle.close() }`
 *                            ≈ Java 的 try-finally。这里没有 catch，
 *                            异常会继续往上抛，但**文件句柄一定会被关掉**。
 *                            （更现代的写法是 `using`，见 src/query.ts 的说明。）
 *
 *   - `let result = await manager.sendRequest(...)` 然后 `result = await ...sendRequest(...)`
 *                            注意 `let` 而不是 `const`：因为调用层级那一步要**覆盖**它。
 *                            `const` 是引用不可变（≈ Java 的 final），`let` 可变。
 *
 *   - `input.operation === 'incomingCalls' || input.operation === 'outgoingCalls'`
 *                            因为 operation 是**字面量联合类型**，TS 能做**穷尽性检查**：
 *                            下面的 switch 如果漏掉某个 case，编译器会报「返回值可能 undefined」。
 *                            ≈ Java 17+ 的 sealed interface + switch 模式匹配的穷尽性。
 *
 *   - `switch (input.operation) { case 'goToDefinition': return {...} ... }`
 *                            注意每个 case 都 **return**，所以最后**没有 default**。
 *                            这是「穷尽 switch」的惯用法：靠类型系统保证没漏。
 *
 *   - `const { method, params } = getMethodAndParams(...)`
 *                            解构赋值。≈ Java 21+ 的记录模式匹配，但 TS 里天天用。
 *
 *   - `result as CallHierarchyItem[]`  类型断言（≈ Java 的强制转换 `(T) x`）。
 *                            运行时**不做任何检查**，纯粹告诉编译器「相信我」。
 *                            这里不得不用，因为 LSP 的 sendRequest 返回 unknown/any。
 *
 *   - `result === undefined`  ★ 本文件的特殊约定：manager.sendRequest 返回
 *                            `undefined` 表示「这台 server 处理不了这个 method」，
 *                            **不是**「结果是空」。所以要和 null / [] 区分开处理。
 *
 *   - `new Set(arr).size`    用 Set 去重后取大小，本文件数「唯一文件数」的惯用写法。
 *                            ≈ Java 的 `new HashSet<>(list).size()`。
 *
 *   - `async function filterGitIgnoredLocations<T extends Location>(...)`
 *                            泛型函数 + 约束。`async` 前缀 ⇒ 返回 Promise<T[]>。
 *
 *   - `locations.filter(loc => loc && loc.uri)`  箭头函数 ≈ lambda。
 *                            `loc && loc.uri` 利用了 JS 的 truthy/falsy：
 *                            loc 是 null/undefined 时短路返回它本身（falsy），被 filter 剔除。
 *
 *   - `const output: Output = {...}`  显式标注变量类型（不写也能推断，写上是为了
 *                            一旦字段拼错立刻报错）。
 *
 *   - `path.extname(absolutePath)`  取扩展名（'.ts'）。≈ Java 手写 substring(lastIndexOf('.'))。
 *   - `pathToFileURL(p).href`       本地路径 → file:// URI（LSP 协议只认 URI）。
 *                            ≈ Java 的 `Paths.get(p).toUri().toString()`。
 *
 *   - `expandPath(filePath)` 把 `~`、相对路径展开成绝对路径（项目内的工具函数）。
 *
 *   - `logError(new Error(...))` / `logForDebugging(...)`
 *                            项目内的日志。注意日志用的是**英文**（给用户看的报错也是英文），
 *                            LSP server 是第三方进程，出错信息要原样上报便于排查。
 */

import { open } from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
} from 'vscode-languageserver-types'
import { z } from 'zod/v4'
import {
  getInitializationStatus,
  getLspServerManager,
  isLspConnected,
  waitForInitialization,
} from '../../services/lsp/manager.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { uniq } from '../../utils/array.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isENOENT, toError } from '../../utils/errors.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  formatDocumentSymbolResult,
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatPrepareCallHierarchyResult,
  formatWorkspaceSymbolResult,
} from './formatters.js'
import { DESCRIPTION, LSP_TOOL_NAME } from './prompt.js'
import { lspToolInputSchema } from './schemas.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

// 【中文补充】10MB 上限：超过这个大小就不送给 language server。
// 为什么有上限？因为文件要先读进内存、再经由 JSON-RPC 整段发给 server，
// 一个 500MB 的日志/生成文件会把两边都拖垮，而且 LSP 对这种文件也分析不出东西。
// 这是个「宁可拒绝服务、也不把进程搞挂」的保护性阈值。
const MAX_LSP_FILE_SIZE_BYTES = 10_000_000

/**
 * 【中文补充】这是**给模型看**的入参 schema（生成 JSON Schema 发给模型）。
 *
 * 为什么这里不用 schemas.ts 那套 discriminatedUnion？
 *   因为 discriminatedUnion 生成的 JSON Schema 是一堆嵌套的 anyOf 分支，
 *   模型看了容易填错（它会纠结到底该走哪个分支）。
 *   而实际上 9 种 operation 的参数**结构完全一样**，所以给模型看一个
 *   「operation 是 9 选 1 的枚举 + 三个必填字段」的扁平 schema 就足够了，
 *   更好懂、更省 token。
 *
 * 于是形成「两套 schema」的分工：
 *   这里（宽松扁平版）→ 给模型看、生成工具签名
 *   schemas.ts（严格判别联合版）→ 在 validateInput 里做真正校验，报错更精确
 *
 * 另外 `z.strictObject` 表示**多一个字段就报错**：防止模型自作主张塞多余参数。
 *
 * Tool-compatible input schema (regular ZodObject instead of discriminated union)
 * We validate against the discriminated union in validateInput for better error messages
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum([
        'goToDefinition',
        'findReferences',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'goToImplementation',
        'prepareCallHierarchy',
        'incomingCalls',
        'outgoingCalls',
      ])
      .describe('The LSP operation to perform'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 【中文补充】输出 schema：声明这个工具**返回**什么。
 *
 * 为什么要声明输出 schema（Java 里没有这道工序）？
 *   因为结果最终要作为 tool_result 回传给模型，声明 schema 可以：
 *     ① 在严格的验证模式（strict tool use）下让 API 侧校验输出结构；
 *     ② 给「结果太大需要截断」等后续处理提供结构信息。
 *
 * 注意 `resultCount` / `fileCount` 是 `.optional()`：
 *   出错时（比如 manager 没初始化、文件太大）只填 result 文案，没有计数。
 *   UI.tsx 里正是靠 `resultCount !== undefined` 来区分「正常结果」和「错误兜底」。
 */
const outputSchema = lazySchema(() =>
  z.object({
    operation: z
      .enum([
        'goToDefinition',
        'findReferences',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'goToImplementation',
        'prepareCallHierarchy',
        'incomingCalls',
        'outgoingCalls',
      ])
      .describe('The LSP operation that was performed'),
    result: z.string().describe('The formatted result of the LSP operation'),
    filePath: z
      .string()
      .describe('The file path the operation was performed on'),
    resultCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of results (definitions, references, symbols)'),
    fileCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of files containing results'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type Input = z.infer<InputSchema>

/**
 * 【中文补充】LSPTool —— 本文件唯一的主角：一个「工具对象」。
 *
 * 它是怎么被造出来的？`buildTool({...})` 接收一个**大对象字面量**（一堆字段和回调），
 * 补齐默认值后返回一个符合 Tool 接口的对象。
 *   ≈ Java：Builder 模式，或者「new 一个匿名内部类，一口气实现十几个抽象方法」。
 *
 * 下面这些字段大体分四类：
 *   ① 元信息（给模型和调度器看）：name / description / prompt / inputSchema / outputSchema
 *   ② 开关（决定这个工具什么时候可用）：isEnabled / isReadOnly / isConcurrencySafe / shouldDefer
 *   ③ 生命周期回调（执行前后被主循环调用）：validateInput / checkPermissions / call
 *   ④ 渲染（把结果画到终端上）：renderToolUseMessage / renderToolResultMessage / userFacingName
 *
 * 末尾的 `satisfies ToolDef<InputSchema, Output>` 是编译期契约检查：
 * 字段拼错、类型对不上都会报错，但**不会**把 LSPTool 的推断类型抹平
 * （这是它优于 `as` 的地方）。
 *
 * 各个字段的具体解释见下面每一处的中文补充。
 */
export const LSPTool = buildTool({
  name: LSP_TOOL_NAME,
  searchHint: 'code intelligence (definitions, references, symbols, hover)',
  maxResultSizeChars: 100_000,
  isLsp: true,
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  // 【中文补充】shouldDefer = true：这个工具的**完整描述**平时不发给模型，
  // 只在模型表现出需要代码智能（比如正在读代码、找定义）时才「延迟」注入。
  // 目的：省 token。工具表里有几十个工具，全量塞进 system prompt 会非常长。
  shouldDefer: true,
  // 【中文补充】没有连上任何 language server 时，整个工具从工具表里**消失**。
  // 为什么？与其让模型调了之后返回「没有 server」，不如一开始就不给它这个选项
  // —— 模型看不到就不会调，省一次无效往返，也避免它反复重试。
  isEnabled() {
    return isLspConnected()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 【中文补充】只读、无副作用 ⇒ 允许和其它工具并发执行。
  // 主循环据此决定能不能把多个 tool_use 打包并行跑（省时间）。
  isConcurrencySafe() {
    return true
  },
  // 【中文补充】「只读」标记 ⇒ 权限弹窗更宽松，用户可一键允许。
  isReadOnly() {
    return true
  },
  // 【中文补充】告诉通用权限系统「这个工具操作的是哪个文件」，
  // 这样 `Edit(src/**)` 之类的路径规则才能对它生效。
  // 注意这里 expandPath 把相对路径/波浪号补全成绝对路径再匹配，
  // 否则用户写的规则和实际路径一个相对一个绝对，永远匹配不上。
  getPath({ filePath }): string {
    return expandPath(filePath)
  },
  /**
   * 【中文补充】入参校验：在真正执行**之前**拦掉明显不该往下走的情况。
   *
   * 为什么要在 call() 之外单独有这一步？
   *   因为校验失败时主循环会把 message **回传给模型**让它改正后重试
   *   （而不是当成一个「工具执行失败」）。这是 Claude Code 的通用机制：
   *   validateInput 返回的错误文案会被模型看到，所以写得很具体。
   *
   * 三道检查，按顺序：
   *   ① schema 严格校验（用 schemas.ts 的判别联合，报错能精确到字段）
   *   ② 文件是否存在（ENOENT）
   *   ③ 是不是普通文件（防止传进来一个目录 —— 目录没有「第 N 行第 M 列」）
   *
   * 返回值约定：`{ result: false, message, errorCode }` —— errorCode 是给
   * 上层分类统计用的（1=不存在、2=不是文件、3=schema 错、4=访问失败）。
   *
   * @param input 模型填的入参
   * @returns { result: true } 放行；否则 result:false 且带 message
   */
  async validateInput(input: Input): Promise<ValidationResult> {
    // First validate against the discriminated union for better type safety
    const parseResult = lspToolInputSchema().safeParse(input)
    if (!parseResult.success) {
      return {
        result: false,
        message: `Invalid input: ${parseResult.error.message}`,
        errorCode: 3,
      }
    }

    // Validate file exists and is a regular file
    const fs = getFsImplementation()
    const absolutePath = expandPath(input.filePath)

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // 【中文补充】UNC 路径（Windows 的网络共享路径，形如 `\\server\share` 或 `//server/share`）
    // 一旦被访问，Windows 会自动发起 NTLM 认证并把**用户的凭据哈希**发给那台服务器
    // —— 这是一个著名的凭据泄露攻击面（攻击者只要在日志/代码里放一个 UNC 路径，
    //    谁打开谁就中招）。所以这里遇到 UNC 路径直接**跳过**所有文件系统操作。
    // 注意是「跳过」而不是「拒绝」：因为「文件不存在」这个事实本身也可能泄露信息，
    // 索性什么都不做，交给下游自己去兜。
    if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
      return { result: true }
    }

    let stats
    try {
      stats = await fs.stat(absolutePath)
    } catch (error) {
      if (isENOENT(error)) {
        return {
          result: false,
          message: `File does not exist: ${input.filePath}`,
          errorCode: 1,
        }
      }
      const err = toError(error)
      // Log filesystem access errors for tracking
      logError(
        new Error(
          `Failed to access file stats for LSP operation on ${input.filePath}: ${err.message}`,
        ),
      )
      return {
        result: false,
        message: `Cannot access file: ${input.filePath}. ${err.message}`,
        errorCode: 4,
      }
    }

    if (!stats.isFile()) {
      return {
        result: false,
        message: `Path is not a file: ${input.filePath}`,
        errorCode: 2,
      }
    }

    return { result: true }
  },
  /**
   * 【中文补充】权限检查：复用**通用**的「读文件权限」逻辑，不自己造轮子。
   *
   * 为什么能复用通用的？因为 LSP 操作本质上就是「读某个文件」（外加向
   * language server 提问），没有写操作，所以和 Read 工具共用同一套规则即可：
   * 用户在 settings 里配置的 allow/deny 路径规则、`/permissions` 里加的白名单，
   * 全都自动生效，不用为 LSP 单独维护一份。
   *
   * @param input   模型填的入参（里面有 filePath）
   * @param context 工具执行上下文，能拿到全局 appState
   * @returns 权限决策（allow / deny / ask）
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      LSPTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  /**
   * 【中文补充】★ 主流程：真正执行一次 LSP 操作。
   *
   * 完整链路：
   *   ① 等 LSP 子系统初始化完成（否则会误报「没有 server」）
   *   ② 取全局的 LSPServerManager（拿不到就直接返回错误文案）
   *   ③ 把 operation 翻译成 LSP 的 method + params（含 1-based→0-based 换算）
   *   ④ 若文件还没在 server 里打开 → 读内容并 didOpen（超 10MB 直接拒绝）
   *   ⑤ 发请求；返回 undefined 说明「这台 server 不支持这个 method」
   *   ⑥ 调用层级（incoming/outgoing）需要**再发一次**请求拿真正的调用列表
   *   ⑦ 按 operation 过滤掉被 gitignore 的位置（node_modules 等噪声）
   *   ⑧ 调 formatters.ts 格式化，并统计 resultCount / fileCount
   *   ⑨ 全程 try/catch：任何异常都转成一句人话错误文案返回，绝不抛出去
   *
   * 第 ⑨ 点是个重要取舍：工具**不要**因为 LSP 出问题就让整个 turn 崩掉。
   * 把错误变成文本返回给模型，模型还能自己换个办法（比如改用 Grep）继续干活。
   *
   * @param input    模型填的入参
   * @param _context 执行上下文（本工具没用到，下划线前缀表示故意忽略）
   * @returns `{ data: Output }`，Output 里 result 永远是字符串（成功或失败文案）
   */
  async call(input: Input, _context) {
    const absolutePath = expandPath(input.filePath)
    const cwd = getCwd()

    // Wait for initialization if it's still pending
    // This prevents returning "no server available" before init completes
    // 【中文补充】language server 是**外部子进程**，启动要几秒。
    // 如果不等待就发请求，会得到「没有可用 server」的假阴性结果 ——
    // 用户会以为 LSP 没配好，其实只是还没起来。所以状态是 pending 就 await 一下。
    const status = getInitializationStatus()
    if (status.status === 'pending') {
      await waitForInitialization()
    }

    // Get the LSP server manager
    // 【中文补充】这一句是本文件**唯一**触达 src/services/lsp/ 的入口。
    // 拿到的 manager 负责：挑 server、拉进程、发 JSON-RPC、崩溃重启。
    // 本文件一概不关心这些细节 —— 这就是「薄封装」的含义。
    const manager = getLspServerManager()
    if (!manager) {
      // Log this system-level failure for tracking
      logError(
        new Error('LSP server manager not initialized when tool was called'),
      )

      const output: Output = {
        operation: input.operation,
        result:
          'LSP server manager not initialized. This may indicate a startup issue.',
        filePath: input.filePath,
      }
      return {
        data: output,
      }
    }

    // Map operation to LSP method and prepare params
    const { method, params } = getMethodAndParams(input, absolutePath)

    try {
      // Ensure file is open in LSP server before making requests
      // Most LSP servers require textDocument/didOpen before operations
      // Only read the file if it's not already open to avoid unnecessary I/O
      // 【中文补充】为什么要判断 isFileOpen？因为同一个文件在一次会话里可能被
      // 反复查询（先 hover 再 findReferences），每次都重读一遍大文件很浪费。
      // server 那边维护着「已打开的文档」集合，开过的就不用再发 didOpen。
      if (!manager.isFileOpen(absolutePath)) {
        const handle = await open(absolutePath, 'r')
        try {
          const stats = await handle.stat()
          // 【中文补充】先看大小再读内容：如果先 readFile 再判断，
          // 一个 1GB 的文件已经被整个读进内存了，判断就失去了意义。
          if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
            const output: Output = {
              operation: input.operation,
              result: `File too large for LSP analysis (${Math.ceil(stats.size / 1_000_000)}MB exceeds 10MB limit)`,
              filePath: input.filePath,
            }
            return { data: output }
          }
          const fileContent = await handle.readFile({ encoding: 'utf-8' })
          await manager.openFile(absolutePath, fileContent)
        } finally {
          await handle.close()
        }
      }

      // Send request to LSP server
      let result = await manager.sendRequest(absolutePath, method, params)

      // 【中文补充】★ 关键约定：`undefined` 是 manager 返回的**特殊信号**，
      // 意思是「当前没有能处理这个 method 的 server」（比如 .md 文件没人接管），
      // 而**不是**「查到了但结果为空」（那是 null 或 []）。
      // 这两种情况要给模型完全不同的提示，所以必须分开判断。
      if (result === undefined) {
        // Log for diagnostic purposes - helps track usage patterns and potential bugs
        logForDebugging(
          `No LSP server available for file type ${path.extname(absolutePath)} for operation ${input.operation} on file ${input.filePath}`,
        )

        const output: Output = {
          operation: input.operation,
          result: `No LSP server available for file type: ${path.extname(absolutePath)}`,
          filePath: input.filePath,
        }
        return {
          data: output,
        }
      }

      // For incomingCalls and outgoingCalls, we need a two-step process:
      // 1. First get CallHierarchyItem(s) from prepareCallHierarchy
      // 2. Then request the actual calls using that item
      if (
        input.operation === 'incomingCalls' ||
        input.operation === 'outgoingCalls'
      ) {
        const callItems = result as CallHierarchyItem[]
        if (!callItems || callItems.length === 0) {
          const output: Output = {
            operation: input.operation,
            result: 'No call hierarchy item found at this position',
            filePath: input.filePath,
            resultCount: 0,
            fileCount: 0,
          }
          return { data: output }
        }

        // Use the first call hierarchy item to request calls
        // 【中文补充】为什么只取 callItems[0]？因为一次查询只能绕一个锚点展开，
        // 而光标位置通常只对应一个函数。prepare 返回多个时（重载场景），
        // 取第一个是务实的选择 —— 模型想查另一个可以换个位置再调一次。
        const callMethod =
          input.operation === 'incomingCalls'
            ? 'callHierarchy/incomingCalls'
            : 'callHierarchy/outgoingCalls'

        result = await manager.sendRequest(absolutePath, callMethod, {
          item: callItems[0],
        })

        if (result === undefined) {
          logForDebugging(
            `LSP server returned undefined for ${callMethod} on ${input.filePath}`,
          )
          // Continue to formatter which will handle empty/null gracefully
        }
      }

      // Filter out gitignored files from location-based results
      // 【中文补充】为什么要过滤 gitignore？
      //   findReferences / workspaceSymbol 这类操作可能返回上百条结果，
      //   其中大量落在 node_modules/、dist/、build/ 这些**被 gitignore** 的目录里。
      //   那些不是人写的源码，对模型是纯噪声（还特别费 token）。
      //
      // 为什么只对这 4 种 operation 过滤？
      //   因为只有它们返回的是「跨文件的位置列表」。
      //   hover / documentSymbol 只针对当前这**一个**文件，而这个文件是用户明确指定的，
      //   就算它在 gitignore 里，用户既然点名要查，就不该被过滤掉。
      if (
        result &&
        Array.isArray(result) &&
        (input.operation === 'findReferences' ||
          input.operation === 'goToDefinition' ||
          input.operation === 'goToImplementation' ||
          input.operation === 'workspaceSymbol')
      ) {
        if (input.operation === 'workspaceSymbol') {
          // SymbolInformation has location.uri — filter by extracting locations
          const symbols = result as SymbolInformation[]
          const locations = symbols
            .filter(s => s?.location?.uri)
            .map(s => s.location)
          const filteredLocations = await filterGitIgnoredLocations(
            locations,
            cwd,
          )
          const filteredUris = new Set(filteredLocations.map(l => l.uri))
          result = symbols.filter(
            s => !s?.location?.uri || filteredUris.has(s.location.uri),
          )
        } else {
          // Location[] or (Location | LocationLink)[]
          const locations = (result as (Location | LocationLink)[]).map(
            toLocation,
          )
          const filteredLocations = await filterGitIgnoredLocations(
            locations,
            cwd,
          )
          const filteredUris = new Set(filteredLocations.map(l => l.uri))
          result = (result as (Location | LocationLink)[]).filter(item => {
            const loc = toLocation(item)
            return !loc.uri || filteredUris.has(loc.uri)
          })
        }
      }

      // Format the result based on operation type
      const { formatted, resultCount, fileCount } = formatResult(
        input.operation,
        result,
        cwd,
      )

      const output: Output = {
        operation: input.operation,
        result: formatted,
        filePath: input.filePath,
        resultCount,
        fileCount,
      }

      return {
        data: output,
      }
    } catch (error) {
      const err = toError(error)
      const errorMessage = err.message

      // Log error for tracking
      logError(
        new Error(
          `LSP tool request failed for ${input.operation} on ${input.filePath}: ${errorMessage}`,
        ),
      )

      const output: Output = {
        operation: input.operation,
        result: `Error performing ${input.operation}: ${errorMessage}`,
        filePath: input.filePath,
      }
      return {
        data: output,
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * 【中文补充】把「工具层面的 operation」翻译成「LSP 协议层面的 method + params」。
 *
 * 这是一张**翻译表**，也是本文件最能体现「薄封装」本质的地方：
 * 工具对外只暴露 9 个人类友好的名字（goToDefinition / hover / ...），
 * 对内则是一串 LSP 规定的 RPC 方法名（textDocument/definition / textDocument/hover / ...）。
 *
 * 注意一个易错点：incomingCalls 和 outgoingCalls **在这一步返回的 method 都是**
 * `textDocument/prepareCallHierarchy`。因为这两个操作要先 prepare 拿锚点，
 * 真正的第二步（callHierarchy/incomingCalls）在 call() 里单独补发。
 *
 * @param input        模型填的入参
 * @param absolutePath 已展开成绝对路径的文件路径
 * @returns { method, params } —— method 是 LSP 的 RPC 方法名，params 是它的参数对象
 *
 * Maps LSPTool operation to LSP method and params
 */
function getMethodAndParams(
  input: Input,
  absolutePath: string,
): { method: string; params: unknown } {
  // 【中文补充】LSP 协议里文件一律用 URI 标识（file:///abs/path），不是普通路径。
  // pathToFileURL 会顺带处理特殊字符的百分号编码和 Windows 盘符。
  const uri = pathToFileURL(absolutePath).href
  // Convert from 1-based (user-friendly) to 0-based (LSP protocol)
  // 【中文补充】★ 全文最重要的一处换算：
  //   模型/用户看到的 line、character 是 **1-based**（编辑器状态栏那样）；
  //   LSP 协议规定 Position 是 **0-based**。
  //   所以这里统一 -1。反方向（0→1）在 formatters.ts 里做（那里是给**人**看的）。
  //   一处减、一处加，成对出现，改的时候别忘了两边都要改。
  const position = {
    line: input.line - 1,
    character: input.character - 1,
  }

  switch (input.operation) {
    case 'goToDefinition':
      return {
        method: 'textDocument/definition',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'findReferences':
      // 【中文补充】`includeDeclaration: true` 是**故意**的：
      // 默认（false）只返回「使用处」，但用户点「查找引用」时通常也想看到
      // 声明本身在这一行的位置。带上它结果更符合直觉，代价只是多一条。
      return {
        method: 'textDocument/references',
        params: {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },
        },
      }
    case 'hover':
      return {
        method: 'textDocument/hover',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'documentSymbol':
      return {
        method: 'textDocument/documentSymbol',
        params: {
          textDocument: { uri },
        },
      }
    case 'workspaceSymbol':
      // 【中文补充】注意：这个 operation **不接受 filePath/line/character**，
      // 它是全工作区搜索。但工具的 schema 又强制要求三个字段都填（为了统一），
      // 所以这里把它们丢掉、只发一个空 query（空串 = 返回所有符号）。
      // 结果就造成了「填了 filePath 但被忽略」的行为，读代码时容易困惑，特此说明。
      return {
        method: 'workspace/symbol',
        params: {
          query: '', // Empty query returns all symbols
        },
      }
    case 'goToImplementation':
      return {
        method: 'textDocument/implementation',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'prepareCallHierarchy':
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'incomingCalls':
      // For incoming/outgoing calls, we first need to prepare the call hierarchy
      // The LSP server will return CallHierarchyItem(s) that we pass to the calls request
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'outgoingCalls':
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
  }
}

/**
 * 【中文补充】递归数符号总数（**包含所有层级的 children**）。
 *
 * 为什么要递归？DocumentSymbol 是树：一个类下面有方法，方法下面还能有内部类。
 * 只数顶层会得到「3 个符号」，而人看到的大纲其实是 20 行 —— 差距很大，
 * 这个数字会直接显示给模型（"Found N symbols"），必须准确。
 *
 * @param symbols 顶层符号数组
 * @returns 符号总数（含全部后代）
 *
 * Counts the total number of symbols including nested children
 */
function countSymbols(symbols: DocumentSymbol[]): number {
  let count = symbols.length
  for (const symbol of symbols) {
    if (symbol.children && symbol.children.length > 0) {
      count += countSymbols(symbol.children)
    }
  }
  return count
}

/**
 * 【中文补充】数「结果分布在几个不同的文件里」。
 *
 * 为什么需要这个数？UI 上要显示 `Found 42 references across 7 files`，
 * 这两个数字帮模型快速判断「这个符号用得多不多、散得广不广」，
 * 比让它自己数 42 行文本高效得多。
 *
 * 实现：把所有 uri 塞进 Set 去重，取 size。
 * ≈ Java 的 `new HashSet<>(uris).size()`。
 *
 * Counts unique files from an array of locations
 */
function countUniqueFiles(locations: Location[]): number {
  return new Set(locations.map(loc => loc.uri)).size
}

/**
 * 【中文补充】`file:///Users/kxl/a.ts` → `/Users/kxl/a.ts`。
 *
 * 为什么要自己写而不用标准库？因为要额外处理两个坑：
 *   ① Windows：`file:///C:/x` 去掉前缀后变成 `/C:/x`，多一个前导斜杠，
 *      必须削掉才能拼出合法的本地路径 `C:/x`。
 *   ② 编码：`%20`（空格）、`%E4%B8%AD`（中文）要 decodeURIComponent 还原。
 *      而 decode 可能因为畸形输入**抛异常**，所以要 try/catch，
 *      失败就用未解码的版本（总比整个崩掉强）。
 *
 * @param uri file:// 形式的 URI
 * @returns 本地文件路径字符串
 *
 * Extracts a file path from a file:// URI, decoding percent-encoded characters.
 */
function uriToFilePath(uri: string): string {
  let filePath = uri.replace(/^file:\/\//, '')
  // On Windows, file:///C:/path becomes /C:/path — strip the leading slash
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    // Use un-decoded path if malformed
  }
  return filePath
}

/**
 * 【中文补充】把「落在被 gitignore 的文件里」的结果剔除掉。
 *
 * 为什么用 `git check-ignore` 这个外部命令，而不是自己解析 .gitignore？
 *   因为 .gitignore 的语法非常复杂（通配符、否定 `!`、目录限定、嵌套 .gitignore、
 *   global gitignore、.git/info/exclude…），自己实现必然有偏差。
 *   直接问 git 自己是**唯一可靠**的做法 —— 「不要重复实现别人的规则引擎」。
 *
 * 为什么要**批量**（每批 50 个）？
 *   因为每调一次就是 fork 一个 git 进程（约几十毫秒）。
 *   findReferences 可能返回 300 个位置分布在上百个文件里，
 *   逐个查就是上百次 fork、好几秒；批量后只剩几次。
 *   50 这个数字是「命令行参数长度上限」和「进程数」之间的折中。
 *
 * 退出码的含义（写在这里是因为很容易记反）：
 *   0   = 这批里**至少有一个**被忽略（stdout 列出被忽略的那些）
 *   1   = 一个都没被忽略（stdout 为空）
 *   128 = 当前目录根本不是 git 仓库 → 什么都不忽略，全部保留
 *
 * @param locations 待过滤的位置数组（泛型 T 只要带 uri 字段即可）
 * @param cwd       当前工作目录（git 命令在哪个仓库上下文里跑）
 * @returns 过滤后的新数组（**不修改**原数组）
 *
 * Filters out locations whose file paths are gitignored.
 * Uses `git check-ignore` with batched path arguments for efficiency.
 */
async function filterGitIgnoredLocations<T extends Location>(
  locations: T[],
  cwd: string,
): Promise<T[]> {
  if (locations.length === 0) {
    return locations
  }

  // Collect unique file paths from URIs
  // 【中文补充】先用 Map 做「uri → 本地路径」的**去重**映射：
  // 300 个位置可能只落在 20 个文件上，去重后只需向 git 问 20 次，而不是 300 次。
  const uriToPath = new Map<string, string>()
  for (const loc of locations) {
    if (loc.uri && !uriToPath.has(loc.uri)) {
      uriToPath.set(loc.uri, uriToFilePath(loc.uri))
    }
  }

  const uniquePaths = uniq(uriToPath.values())
  if (uniquePaths.length === 0) {
    return locations
  }

  // Batch check paths with git check-ignore
  // Exit code 0 = at least one path is ignored, 1 = none ignored, 128 = not a git repo
  const ignoredPaths = new Set<string>()
  const BATCH_SIZE = 50
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE)
    const result = await execFileNoThrowWithCwd(
      'git',
      ['check-ignore', ...batch],
      {
        cwd,
        preserveOutputOnError: false,
        timeout: 5_000,
      },
    )

    if (result.code === 0 && result.stdout) {
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) {
          ignoredPaths.add(trimmed)
        }
      }
    }
  }

  if (ignoredPaths.size === 0) {
    return locations
  }

  return locations.filter(loc => {
    const filePath = uriToPath.get(loc.uri)
    return !filePath || !ignoredPaths.has(filePath)
  })
}

/**
 * 【中文补充】区分 LSP 的两种位置表示：
 *   Location     → { uri, range }                                  （简单）
 *   LocationLink → { targetUri, targetRange, targetSelectionRange } （额外带「选中范围」）
 *
 * 怎么区分？看有没有 `targetUri` 这个 key。这叫**运行时类型嗅探**
 * （对接外部协议时的常见手段，因为数据不是我们自己构造的）。
 *
 * 返回值写成 `item is LocationLink` 而不是 boolean ⇒ **类型谓词**：
 * 调用方 `if (isLocationLink(x))` 进去之后，编译器自动把 x 收窄成 LocationLink，
 * 可以直接访问 targetUri 而不会报「Property does not exist」。
 * ≈ Java 的 `if (x instanceof LocationLink l) { l.targetUri... }`
 *
 * Checks if item is LocationLink (has targetUri) vs Location (has uri)
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

/**
 * 【中文补充】把 LocationLink 归一成 Location，让下游只需要处理一种形态。
 *
 * 为什么取 `targetSelectionRange || targetRange`？
 *   - targetSelectionRange：跳转到目标后**高亮**的那一段（通常是标识符本身）
 *   - targetRange：目标的**完整**范围（比如整个函数体）
 *   优先用前者，因为高亮标识符更符合「跳转到定义」的直觉；
 *   但它是可选字段，老 server 可能不给，所以退化到后者。
 *   `||` 在这里是「没有就用备选」的意思（两者都非空时不会误伤）。
 *
 * Converts LocationLink to Location format for uniform handling
 */
function toLocation(item: Location | LocationLink): Location {
  if (isLocationLink(item)) {
    return {
      uri: item.targetUri,
      range: item.targetSelectionRange || item.targetRange,
    }
  }
  return item
}

/**
 * 【中文补充】★ 格式化总入口：按 operation 分派到 formatters.ts 的 8 个函数，
 * 同时**顺便**统计出 resultCount / fileCount 这两个摘要数字。
 *
 * 为什么把「格式化」和「计数」放在同一个函数里？
 *   因为两者都需要「先理解这种 operation 的数据结构」（比如要先把 LocationLink
 *   转成 Location 才能数）。分开写会重复一遍类型判断，合并更不容易出错。
 *
 * 每个 case 的基本套路（以 goToDefinition 为例，其余类似）：
 *   ① 把 result 归一成数组（LSP 可能返回单个对象或数组）
 *   ② 过滤掉 uri 缺失的坏数据，并 logError 上报（这是「上游漏了」的信号）
 *   ③ 调 formatters.ts 的对应函数生成文本
 *   ④ 用过滤后的**有效**数据算 count（用原始数据算会把坏条目也算进去）
 *
 * 注意 `switch` 里每个 case 都 return、**没有 default**：
 *   因为 operation 是字面量联合类型，TS 能做穷尽性检查 ——
 *   将来新增一种 operation 却忘了在这里加 case，编译器会立刻报错。
 *   ≈ Java 17+ 的 sealed interface + 穷尽 switch。
 *
 * @param operation 9 种 operation 之一
 * @param result    LSP 返回的原始数据（unknown，各 operation 结构不同）
 * @param cwd       当前目录（用于路径相对化）
 * @returns { formatted, resultCount, fileCount } —— 文本 + 两个摘要计数
 *
 * Formats LSP result based on operation type and extracts summary counts
 */
function formatResult(
  operation: Input['operation'],
  result: unknown,
  cwd: string,
): { formatted: string; resultCount: number; fileCount: number } {
  switch (operation) {
    case 'goToDefinition': {
      // Handle both Location and LocationLink formats
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as Location | LocationLink]
          : []

      // Convert LocationLinks to Locations for uniform handling
      const locations = rawResults.map(toLocation)

      // Log and filter out locations with undefined uris
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server returned ${invalidLocations.length} location(s) with undefined URI for goToDefinition on ${cwd}. ` +
              `This indicates malformed data from the LSP server.`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        formatted: formatGoToDefinitionResult(
          result as
            | Location
            | Location[]
            | LocationLink
            | LocationLink[]
            | null,
          cwd,
        ),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'findReferences': {
      const locations = (result as Location[]) || []

      // Log and filter out locations with undefined uris
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server returned ${invalidLocations.length} location(s) with undefined URI for findReferences on ${cwd}. ` +
              `This indicates malformed data from the LSP server.`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        formatted: formatFindReferencesResult(result as Location[] | null, cwd),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'hover': {
      return {
        formatted: formatHoverResult(result as Hover | null, cwd),
        resultCount: result ? 1 : 0,
        fileCount: result ? 1 : 0,
      }
    }
    case 'documentSymbol': {
      // LSP allows documentSymbol to return either DocumentSymbol[] or SymbolInformation[]
      const symbols = (result as (DocumentSymbol | SymbolInformation)[]) || []
      // Detect format: DocumentSymbol has 'range', SymbolInformation has 'location'
      const isDocumentSymbol =
        symbols.length > 0 && symbols[0] && 'range' in symbols[0]
      // Count symbols - DocumentSymbol can have nested children, SymbolInformation is flat
      const count = isDocumentSymbol
        ? countSymbols(symbols as DocumentSymbol[])
        : symbols.length
      return {
        formatted: formatDocumentSymbolResult(
          result as (DocumentSymbol[] | SymbolInformation[]) | null,
          cwd,
        ),
        resultCount: count,
        fileCount: symbols.length > 0 ? 1 : 0,
      }
    }
    case 'workspaceSymbol': {
      const symbols = (result as SymbolInformation[]) || []

      // Log and filter out symbols with undefined location.uri
      const invalidSymbols = symbols.filter(
        sym => !sym || !sym.location || !sym.location.uri,
      )
      if (invalidSymbols.length > 0) {
        logError(
          new Error(
            `LSP server returned ${invalidSymbols.length} symbol(s) with undefined location URI for workspaceSymbol on ${cwd}. ` +
              `This indicates malformed data from the LSP server.`,
          ),
        )
      }

      const validSymbols = symbols.filter(
        sym => sym && sym.location && sym.location.uri,
      )
      const locations = validSymbols.map(s => s.location)
      return {
        formatted: formatWorkspaceSymbolResult(
          result as SymbolInformation[] | null,
          cwd,
        ),
        resultCount: validSymbols.length,
        fileCount: countUniqueFiles(locations),
      }
    }
    case 'goToImplementation': {
      // Handle both Location and LocationLink formats (same as goToDefinition)
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as Location | LocationLink]
          : []

      // Convert LocationLinks to Locations for uniform handling
      const locations = rawResults.map(toLocation)

      // Log and filter out locations with undefined uris
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server returned ${invalidLocations.length} location(s) with undefined URI for goToImplementation on ${cwd}. ` +
              `This indicates malformed data from the LSP server.`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        // Reuse goToDefinition formatter since the result format is identical
        formatted: formatGoToDefinitionResult(
          result as
            | Location
            | Location[]
            | LocationLink
            | LocationLink[]
            | null,
          cwd,
        ),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'prepareCallHierarchy': {
      const items = (result as CallHierarchyItem[]) || []
      return {
        formatted: formatPrepareCallHierarchyResult(
          result as CallHierarchyItem[] | null,
          cwd,
        ),
        resultCount: items.length,
        fileCount: items.length > 0 ? countUniqueFilesFromCallItems(items) : 0,
      }
    }
    case 'incomingCalls': {
      const calls = (result as CallHierarchyIncomingCall[]) || []
      return {
        formatted: formatIncomingCallsResult(
          result as CallHierarchyIncomingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount:
          calls.length > 0 ? countUniqueFilesFromIncomingCalls(calls) : 0,
      }
    }
    case 'outgoingCalls': {
      const calls = (result as CallHierarchyOutgoingCall[]) || []
      return {
        formatted: formatOutgoingCallsResult(
          result as CallHierarchyOutgoingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount:
          calls.length > 0 ? countUniqueFilesFromOutgoingCalls(calls) : 0,
      }
    }
  }
}

/**
 * 【中文补充】下面三个函数做同一件事（数调用层级结果分布在几个文件里），
 * 只是三种数据结构的「uri 藏在哪一层」不一样：
 *   CallHierarchyItem        → item.uri          （锚点本身）
 *   CallHierarchyIncomingCall → call.from?.uri   （调用方）
 *   CallHierarchyOutgoingCall → call.to?.uri     （被调方）
 *
 * 为什么 `.from?.` 要加问号？因为劣质/旧版 server 可能不给 from 字段。
 * 可选链 `?.` 在这里等价于「没有就得到 undefined，之后被 filter 剔除」，
 * 比 `call.from.uri` 安全（后者会抛 Cannot read property of undefined）。
 *
 * Counts unique files from CallHierarchyItem array
 * Filters out items with undefined URIs
 */
function countUniqueFilesFromCallItems(items: CallHierarchyItem[]): number {
  const validUris = items.map(item => item.uri).filter(uri => uri)
  return new Set(validUris).size
}

/**
 * Counts unique files from CallHierarchyIncomingCall array
 * Filters out calls with undefined URIs
 */
function countUniqueFilesFromIncomingCalls(
  calls: CallHierarchyIncomingCall[],
): number {
  const validUris = calls.map(call => call.from?.uri).filter(uri => uri)
  return new Set(validUris).size
}

/**
 * Counts unique files from CallHierarchyOutgoingCall array
 * Filters out calls with undefined URIs
 */
function countUniqueFilesFromOutgoingCalls(
  calls: CallHierarchyOutgoingCall[],
): number {
  const validUris = calls.map(call => call.to?.uri).filter(uri => uri)
  return new Set(validUris).size
}
