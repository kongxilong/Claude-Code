/**
 * ============================================================================
 *  【文件总览】src/tools/LSPTool/schemas.ts —— LSP 工具入参的「校验规则」
 * ============================================================================
 *
 *  【一句话定位】
 *  用 zod 定义 LSP 工具接收哪些参数、每个参数是什么类型，并在运行时校验。
 *  ≈ Java 里 Bean Validation（@NotNull @Positive）+ Jackson 反序列化的合体，
 *    只不过 JS 没有编译期类型保障，所以**运行时必须再校验一遍**——
 *    因为参数是模型（LLM）填的，它随时可能填错。
 *
 *  【在架构中的位置】
 *      src/tools/LSPTool/LSPTool.ts
 *        ├─ validateInput() 里 lspToolInputSchema().safeParse(input)  ← ★ 本文件
 *        ├─ inputSchema（对外给模型看的宽松版）在本文件同目录的 LSPTool.ts 里另有一份
 *        └─ type Input / Output 由 z.infer 从 schema **反推**出来
 *
 *  为什么要「两份 schema」？（这是本文件最反直觉的地方，值得单独讲）
 *
 *      lspToolInputSchema（本文件，discriminatedUnion）
 *          └─ 严格、能给出精确错误 → 只在 validateInput 里用来**报错**
 *
 *      inputSchema（在 LSPTool.ts 里，z.strictObject + z.enum）
 *          └─ 结构扁平 → 用来生成给模型看的 JSON Schema（工具签名）
 *
 *  原因：z.discriminatedUnion 生成的 JSON Schema 对模型不友好（嵌套 anyOf 分支），
 *        而模型只需要知道「operation 是这 9 个之一、另外三个字段是必填」。
 *        所以「对模型展示用扁平版，对运行时校验用严格版」，两者并存。
 *
 *  【本文件包含什么】
 *   1. lspToolInputSchema      9 种 operation 各自的 schema 组成的判别联合
 *   2. LSPToolInput            由 z.infer 反推出来的 TypeScript 类型
 *   3. isValidLSPOperation()   类型守卫：判断字符串是否是合法 operation
 *
 *  【TS 语法速查（Java 工程师视角）】
 *   - `z.strictObject({...})`  zod 的「严格对象」：字段多了直接报错。
 *                              ≈ Jackson 的 @JsonIgnoreProperties(ignoreUnknown=false)。
 *                              （相对的是 z.object，多余字段会被静默忽略。）
 *
 *   - `z.literal('hover')`     字面量类型校验：值必须**恰好**等于 'hover'。
 *                              ≈ Java 里 `if (!"hover".equals(x)) throw ...`
 *                              但在类型系统里它是 `'hover'` 这个精确类型，是判别联合的基础。
 *
 *   - `z.discriminatedUnion('operation', [...])`
 *                              判别联合（tagged union / discriminated union）。
 *                              ≈ Java 的 sealed interface + 多个 record 实现，
 *                                且每个实现都有一个常量 tag 字段（这里是 operation）。
 *                              zod 会先看 operation 的值，再决定用哪个分支校验，
 *                              因此报错信息能精确到「哪个 operation 的哪个字段错了」。
 *
 *   - `z.infer<typeof S>`      **从 schema 反推 TS 类型**（不是手写两遍！）。
 *                              ≈ Java 没有对应物；近似「注解处理器根据校验注解生成 DTO」，
 *                                但这里是纯类型层面的、零运行时开销。
 *
 *   - `ReturnType<typeof f>`   取函数 f 的返回类型。因为 lspToolInputSchema 是
 *                              lazySchema(() => ...) 包了一层，所以要先 ReturnType
 *                              拿到 zod schema 本身，再 z.infer。
 *
 *   - `operation is LSPToolInput['operation']`
 *                              **类型谓词（type predicate）**。返回 boolean 的函数，
 *                              但签名里写了 `x is T`，调用方一旦 if 进去，
 *                              编译器就把 x 收窄成 T —— ≈ Java 的
 *                              `if (o instanceof Foo f) { ... }`（Java 16+ 模式匹配），
 *                              区别是这里是**运行期手写判断 + 编译期自动收窄**的组合。
 *
 *   - `import { z } from 'zod/v4'`
 *                              注意 'zod/v4' 这个子路径：v4 是 zod 的新版 API 入口。
 *                              ≈ Java 里同一个 artifact 的不同包名版本共存。
 *
 *   - `lazySchema(() => ...)`  延迟构造（工厂 + 缓存）。为什么要延迟？
 *                              因为 zod schema 构造有开销，而工具表在启动时就会
 *                              被全部 import；延迟到真正用到（校验时）才构造，
 *                              能显著降低冷启动耗时。≈ Java 的懒加载单例。
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * 【中文补充】下面这个 lazySchema 是 LSP 工具入参的「严格校验规则」。
 *
 * 为什么存在：模型填出来的参数是**不可信**的（它可能编造 operation、把 line 填成 0 或 -1、
 * 把 filePath 填成对象）。所以必须在真正发给 language server 之前拦一道。
 *
 * 返回值：一个 discriminatedUnion，tag 字段是 operation。
 * 9 个分支的结构其实**完全一样**（都是 filePath + line + character），
 * 之所以要写 9 遍而不是「一个通用 schema + operation 用 enum」，
 * 是为了让每一种 operation 未来可以单独加字段（比如 hover 将来加 `includeDocs`），
 * 而 discriminatedUnion 天然支持这种「按分支差异化」的演进。
 *
 * Discriminated union of all LSP operations
 * Uses 'operation' as the discriminator field
 */
export const lspToolInputSchema = lazySchema(() => {
  /**
   * 【中文补充】下面 9 个 schema 的字段结构完全一样，只是 `operation` 的字面量不同。
   * 看懂第一个（goToDefinition）就等于看懂了全部 9 个，后面 8 个是同一份的复制。
   *
   * 三个字段的含义与坑点：
   *  - operation  z.literal('goToDefinition')：
   *               值必须**恰好**是这个字符串。它同时充当判别联合的 tag。
   *  - filePath   允许相对路径也允许绝对路径。
   *               为什么允许相对？因为模型常常只看到相对路径（比如 grep 结果里的），
   *               强行要求绝对路径会让模型反复猜错。真正的绝对化在
   *               LSPTool.ts 里用 expandPath() 统一做一次，而不是在这里。
   *  - line / character  都是 `.int().positive()`，即「正整数，>= 1」。
   *               注意是 **1-based**（编辑器里人眼看到的行号）。
   *               而 LSP 协议规定是 0-based，所以 LSPTool.ts 里发请求前要 -1。
   *               这里按 1-based 收，是为了让模型直接用它在 Read 工具里看到的行号，
   *               不让模型自己做偏移换算（模型做算术最容易错）。
   *
   * `.describe(...)` 的作用：这段文字会进入生成的 JSON Schema，最终**发给模型**，
   * 是告诉模型「这个字段该填什么」的唯一途径，所以写得像人话很重要。
   *
   * Go to Definition operation
   * Finds the definition location of a symbol at the given position
   */
  const goToDefinitionSchema = z.strictObject({
    operation: z.literal('goToDefinition'),
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
  })

  /**
   * Find References operation
   * Finds all references to a symbol at the given position
   */
  const findReferencesSchema = z.strictObject({
    operation: z.literal('findReferences'),
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
  })

  /**
   * Hover operation
   * Gets hover information (documentation, type info) for a symbol at the given position
   */
  const hoverSchema = z.strictObject({
    operation: z.literal('hover'),
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
  })

  /**
   * Document Symbol operation
   * Gets all symbols (functions, classes, variables) in a document
   */
  const documentSymbolSchema = z.strictObject({
    operation: z.literal('documentSymbol'),
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
  })

  /**
   * Workspace Symbol operation
   * Searches for symbols across the entire workspace
   */
  const workspaceSymbolSchema = z.strictObject({
    operation: z.literal('workspaceSymbol'),
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
  })

  /**
   * Go to Implementation operation
   * Finds the implementation locations of an interface or abstract method
   */
  const goToImplementationSchema = z.strictObject({
    operation: z.literal('goToImplementation'),
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
  })

  /**
   * Prepare Call Hierarchy operation
   * Prepares a call hierarchy item at the given position (first step for call hierarchy)
   */
  const prepareCallHierarchySchema = z.strictObject({
    operation: z.literal('prepareCallHierarchy'),
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
  })

  /**
   * Incoming Calls operation
   * Finds all functions/methods that call the function at the given position
   */
  const incomingCallsSchema = z.strictObject({
    operation: z.literal('incomingCalls'),
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
  })

  /**
   * Outgoing Calls operation
   * Finds all functions/methods called by the function at the given position
   */
  const outgoingCallsSchema = z.strictObject({
    operation: z.literal('outgoingCalls'),
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
  })

  // 【中文补充】这里把 9 个分支组装成判别联合：zod 会先读 operation 的值，
  // 再跳到对应分支去校验剩下三个字段。好处是报错能精确到
  // 「你在 goToDefinition 下填的 character 不是正整数」，而不是笼统的「不匹配任何分支」。
  // Java 对照：≈ switch (operation) { case "goToDefinition" -> validate(...); ... }
  //           但这里是声明式的、由 zod 框架执行。
  return z.discriminatedUnion('operation', [
    goToDefinitionSchema,
    findReferencesSchema,
    hoverSchema,
    documentSymbolSchema,
    workspaceSymbolSchema,
    goToImplementationSchema,
    prepareCallHierarchySchema,
    incomingCallsSchema,
    outgoingCallsSchema,
  ])
})

/**
 * 【中文补充】LSPToolInput 是「从 schema 反推出来的 TS 类型」，而不是手写的。
 *
 * 为什么要反推而不是手写？因为手写会出现「类型说有这个字段、运行时 schema 没校验」的
 * 漂移（drift）。z.infer 保证二者永远一致——改 schema，类型自动跟着变。
 *
 * `ReturnType<typeof lspToolInputSchema>`：因为 lspToolInputSchema 是
 * lazySchema(工厂函数)，typeof 拿到的是那个**函数**的类型，得先 ReturnType
 * 取出「工厂返回的东西」（即 zod schema 本体），再 z.infer 转成 TS 类型。
 * 两层嵌套是 lazySchema 带来的，不是 zod 本身的复杂度。
 *
 * TypeScript type for LSPTool input
 */
export type LSPToolInput = z.infer<ReturnType<typeof lspToolInputSchema>>

/**
 * 【中文补充】类型守卫（type guard）：判断一个任意字符串是不是 9 种合法 operation 之一。
 *
 * 它存在的意义不在运行时（运行时就是一次 includes 而已），而在**编译期**：
 * 返回值类型写的是 `operation is LSPToolInput['operation']`，于是调用方写
 *
 *     if (isValidLSPOperation(s)) { ... 这里 s 的类型已经收窄成那 9 个字面量的联合了 ... }
 *
 * 编译器会自动把 s 从 string 收窄成 'goToDefinition' | 'hover' | ... 的联合类型，
 * 之后就能安全地把它传给需要 LSPToolInput['operation'] 的地方。
 *
 * Java 对照：≈ `if (o instanceof Foo f) { ... }`（Java 16+ 模式匹配），
 *            后者是 JVM 帮你在字节码里插入 checkcast 并绑定变量；
 *            这里是 **你自己写运行时判断 + 编译器信任你的声明** 的组合。
 *            风险：如果 includes 的列表和类型不一致，编译器不会报错 —— 所以
 *            修这个文件时，改了 operation 记得两处都要改。
 *
 * @param operation 待判断的字符串（通常来自模型输出或配置文件）
 * @returns true 表示是 9 种合法 operation 之一；同时触发编译期类型收窄
 *
 * Type guard to check if an operation is a valid LSP operation
 */
export function isValidLSPOperation(
  operation: string,
): operation is LSPToolInput['operation'] {
  return [
    'goToDefinition',
    'findReferences',
    'hover',
    'documentSymbol',
    'workspaceSymbol',
    'goToImplementation',
    'prepareCallHierarchy',
    'incomingCalls',
    'outgoingCalls',
  ].includes(operation)
}
