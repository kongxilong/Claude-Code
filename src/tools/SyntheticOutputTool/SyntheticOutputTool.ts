/**
 * ============================================================================
 *  【文件总览】src/tools/SyntheticOutputTool/SyntheticOutputTool.ts
 *              —— 让 Claude「必须按 JSON Schema 交作业」的那个工具
 * ============================================================================
 *
 *  一句话定位：
 *  这是一个**近乎透明**的管道型工具：模型调用它时把结果塞进去，
 *  工具用你给定的 JSON Schema 校验一遍，通过就原样返回，不通过就报错逼模型重填。
 *  最终效果 = 「让 Claude 输出严格符合某个 schema 的结构化数据」。
 *
 *  它本身几乎不干什么实事（基础的 call() 只有一行 return），
 *  真正的价值在于：**给整个 Agent 循环加了一个"格式出口闸门"**。
 *
 *  为什么要有它？
 *      用户在 SDK 脚本里写 `agent({ schema: BUGS_SCHEMA })` 想要拿到 `JSON 对象`，
 *      而不是一段用自然语言描述的文本（"我找到了 3 个 bug，分别是…"）。
 *      有了这个工具：主循环会一直转，直到模型的数据**通过 schema 校验**才收工，
 *      于是调用方拿到的必然是能直接反序列化的东西。
 *      换句话说，这是给 Agent 加的**编译期类型检查的运行时版本**。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】调用链
 * ---------------------------------------------------------------------------
 *
 *      SDK 调用方：agent({ schema: MY_SCHEMA })
 *        └─> isSyntheticOutputToolEnabled(opts)          ← ★ 本文件（决定是否造这个工具）
 *              └─> createSyntheticOutputTool(MY_SCHEMA)  ← ★ 本文件（带缓存地造一个专用实例）
 *                    └─> buildSyntheticOutputTool(jsonSchema)  ← ★ 本文件（真正的构造 + Ajv 编译）
 *                          └─> Ajv.compile(jsonSchema)   ← 把 schema 编译成 JS 校验函数
 *
 *      工具进入工具表之后，就走普通工具的生命周期：
 *      query() 主循环 → runTools() → tool.checkPermissions()（恒放行）
 *                                  → tool.call(input)（★ 此处做 schema 校验）
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】从上往下一共 5 个导出/成员
 * ---------------------------------------------------------------------------
 *   1. SyntheticOutputTool            —— 基础模板（一个不带具体 schema 的实例）
 *   2. SYNTHETIC_OUTPUT_TOOL_NAME     —— 工具名常量 'StructuredOutput'
 *   3. isSyntheticOutputToolEnabled() —— 是否启用（只看是否非交互会话）
 *   4. createSyntheticOutputTool()    —— ★ 对外主入口：带 WeakMap 缓存的构造器
 *   5. buildSyntheticOutputTool()     —— 内部实现：真正用 Ajv 编译并包一层 call()
 *      （另有类型 CreateResult 和缓存容器 toolCache）
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（本文件实际出现的写法，Java 工程师对照看）
 * ---------------------------------------------------------------------------
 *  - `type CreateResult = { tool: Tool<InputSchema> } | { error: string }`
 *      **可辨识联合**（discriminated union）。返回值要么带 tool 字段、要么带 error 字段。
 *      调用方用 `if ('tool' in result)` 就能把类型收窄到对应分支。
 *      ≈ Java 的 sealed interface + record 实现（Java 17+），或近似 Either<L,R>，
 *        但 TS 里就是个普通联合类型，编译期检查，零运行时开销。
 *      为什么不用 throw？因为这是给用户「写错 schema」这种**预期内的错误**，
 *      用返回值表达更符合"错误是数据"的思路，也不会打断调用方的正常流程。
 *
 *  - `new WeakMap<object, CreateResult>()`
 *      弱引用 Map：key 是对象，且**不阻止它被 GC**。
 *      ≈ Java 的 WeakHashMap<Object, Result>。
 *      这里拿 jsonSchema 对象本身当 key，正合适：
 *      用户手里的 schema 对象被回收时，缓存项自动消失，不会内存泄漏。
 *      副作用：key 必须是对象（不能是原始值），且 WeakMap **不可遍历**。
 *
 *  - `{ ...SyntheticOutputTool, inputJSONSchema: ..., async call(input) {...} }`
 *      对象展开（spread）+ 局部覆盖。
 *      ≈ Java 没有；想象成「复制一份基础模板的所有字段，再把某几个替换掉」。
 *      这是**不可变更新**的核心手法：原对象完全不受影响。
 *      这里复用了基础工具的全部钩子（name/prompt/isReadOnly/渲染函数…），
 *      只替换 inputJSONSchema（换成用户给的 schema）和 call（换成带校验的版本）。
 *
 *  - `as ToolInputJSONSchema`
 *      `as` 类型断言 ≈ Java 的强制类型转换 `(Foo) obj`。
 *      运行时什么都不做，纯粹让编译器闭嘴。这里因为 jsonSchema 是
 *      Record<string, unknown>（宽松）而目标类型更严格，必须断言一下。
 *
 *  - `async call(input) { ... }`  —— 注意参数**没写类型标注**
 *      不是漏写：TS 能从上下文（对象字面量所在的 ToolDef 类型）推断出来。
 *      这叫「上下文类型推断」≈ Java 的菱形推断 <>，但能力更强。
 *
 *  - `e instanceof Error ? e.message : String(e)`
 *      instanceof ≈ Java 的 instanceof，用法完全一样。
 *      这是 catch 块里的标准写法：catch 到的未知异常类型默认是 unknown，
 *      必须先收窄才能安全取 message。
 *
 *  - `?.` 可选链 + `||` 的连用：`e.instancePath || 'root'`
 *      instancePath 是空字符串时用 'root'——注意这里是 `||` 而不是 `??`，
 *      因为空串 '' 确实该被替换掉（此时确实是在描述根对象的错误）。
 *      对比 `??`：只在 null/undefined 时兜底。两者差别正是初学者最容易踩坑的地方。
 *
 *  - `'tool_result' as const`
 *      as const 把类型从 string 收窄成**字面量类型** 'tool_result'。
 *      因为 API 要求这个字段严格等于这个字符串，写成 string 类型会报错。
 *      ≈ Java 里用 enum 成员代替裸 String。
 *
 *  - `z.object({}).passthrough()`
 *      zod 的 passthrough = 「额外字段照收，别丢」。
 *      这里刻意留空对象再 passthrough，意思是「我事先不知道字段，来什么收什么」——
 *      因为字段要等运行时由外部传入的 jsonSchema 决定。
 *
 *  - 1_000 / 100_000 这类下划线是数字分隔符，纯可读性，等价于 100000。
 *
 * ============================================================================
 */
import { Ajv } from 'ajv'
import { z } from 'zod/v4'
import type { Tool, ToolInputJSONSchema } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// Allow any input object since the schema is provided dynamically
// （上面英文注释的中文重述：允许任意入参对象，因为真正的 schema 是运行时才给的，
//   编译期无法知道有哪些字段。这就是"动态 schema"必须付出的代价——失去静态类型安全。）
//   z.object({})     —— 声明一个空对象形状
//   .passthrough()   —— 关键：额外字段**原样保留**，不要像 zod 默认那样悄悄丢掉
const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

// 出参就是一个字符串。
// 为什么是字符串而不是结构化对象？因为这个工具的产出只是给调用链路看的
// 一句「校验通过」的确认语；真正的结构化数据在 call() 的 structured_output 字段里。
const outputSchema = lazySchema(() =>
  z.string().describe('Structured output tool result'),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// 工具名。注意它与文件名 SyntheticOutputTool 并**不一致**——
// 模型看到的名字是 'StructuredOutput'（文件名是内部代码组织用的历史遗留命名）。
export const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'

/**
 * 这个工具要不要被创建出来？
 *
 * 判定条件只有一个：**是否是非交互式会话**。
 *    · 交互式（用户在终端里聊天）：不需要。人自己就能读自然语言，没必要强套 schema。
 *    · 非交互式（SDK / CI 脚本 / -p 一次性执行）：需要。调用方要的是可解析的 JSON。
 *
 * 为什么写成接收 opts 对象而不是直接读全局状态？
 *      便于单测——测试里可以随便传 true/false，不用真的去改进程状态。
 *      这是 TS 里常见的依赖注入风格。
 *
 * 入参 opts.isNonInteractiveSession：true 表示非交互会话
 * 返回值：boolean —— true 则上层会去 createSyntheticOutputTool()
 */
export function isSyntheticOutputToolEnabled(opts: {
  isNonInteractiveSession: boolean
}): boolean {
  return opts.isNonInteractiveSession
}

/**
 * SyntheticOutputTool —— 一个**不带具体 schema 的基础模板**。
 *
 * 它不会被直接使用；真正被使用的是 createSyntheticOutputTool() 基于它改造出的副本。
 * 之所以保留这一个实例，是为了把「每个 Claude Code 工具都要实现的那一堆钩子方法」
 * （name / prompt / isReadOnly / 各种渲染函数 / checkPermissions …）写一次就够了，
 * 构造具体实例时 `{ ...SyntheticOutputTool, ... }` 展开复用即可（见文件末 buildSyntheticOutputTool）。
 *
 * ≈ Java 里「抽象基类的默认实现」，但用对象展开而不是继承。
 *
 * 下面逐个看这些钩子：
 */
export const SyntheticOutputTool = buildTool({
  isMcp: false,
  /**
   * 恒返回 true。
   * 为什么？因为「要不要用这个工具」这件事在**创建阶段**（isSyntheticOutputToolEnabled）
   * 就已经决定了——上层决定不创建的话，它压根不会进工具表。
   * 既然已经出现在工具表里，那就一定是启用的。这是两道闸门的职责分离。
   */
  isEnabled() {
    // This tool is only created when conditions are met (see main.tsx where
    // isSyntheticOutputToolEnabled() gates tool creation). Once created, always enabled.
    // （中文：本工具只在满足条件时才被创建；一旦创建出来，就永远保持启用。）
    return true
  },
  isConcurrencySafe() {
    return true
  },
  // 只读：它不写文件、不发网络请求、不改任何外部状态，纯纯的数据搬运。
  // 标记只读的好处：权限系统可以直接放行，不用弹窗问用户。
  isReadOnly() {
    return true
  },
  // isOpenWorld = 是否会引入「工具清单之外的新能力」。
  // 显然不会——它没有任何副作用，所以返回 false。
  isOpenWorld() {
    return false
  },
  name: SYNTHETIC_OUTPUT_TOOL_NAME,
  searchHint: 'return the final response as structured JSON',
  maxResultSizeChars: 100_000,
  async description(): Promise<string> {
    return 'Return structured output in the requested format'
  },
  /**
   * 给模型的使用手册。措辞非常强硬是有原因的：
   * "You MUST call this tool exactly once at the end of your response"
   * ——「必须调用、只能一次、放在最后」三个约束缺一不可：
   *    · 必须调用：否则调用方拿不到结构化数据，只有自然语言；
   *    · 只能一次：调两次会产生两份冲突的结果，调用方不知道听谁的；
   *    · 放在最后：确保此时模型已经想清楚了全部内容。
   */
  async prompt(): Promise<string> {
    return `Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 基础版本的 call()：**什么都不校验**，原样返回。
   *
   * 为什么基础版不做校验？因为基础版本的 inputSchema 是不限字段的 passthrough，
   * 根本没有可依据的规则。真正的校验由 buildSyntheticOutputTool() 覆盖上去的
   * 那个 call() 来做——那里才拿到用户提供的 jsonSchema。
   *
   * 返回结构里的两个字段各有用处：
   *   data              —— 工具结果正文（这里只是一句成功提示）
   *   structured_output —— ★ 真正的结构化数据，由上层从工具结果里取出交给 SDK 调用方
   */
  async call(input) {
    // The tool just validates and returns the input as the structured output
    // （中文：这个工具无非就是把入参校验后作为结构化输出返回。）
    return {
      data: 'Structured output provided successfully',
      structured_output: input,
    }
  },
  /**
   * 权限检查：恒放行（behavior: 'allow'）。
   *
   * 为什么无条件放行？
   *   因为这个工具唯一的副作用就是「把模型已经生成好的数据回传」，
   *   不读文件、不写文件、不联网。问用户「要不要允许」纯属打扰。
   *
   * 入参 input：模型的入参
   * 返回值 PermissionResult：{ behavior: 'allow', updatedInput: input }
   *   —— updatedInput 表示「我没有修改用户的入参，原样执行」。
   *      钩子有能力在这里改输入（比如补默认值），这里选择不动。
   */
  async checkPermissions(input): Promise<PermissionResult> {
    // Always allow this tool - it's just returning data
    // （中文：永远放行——它只是回传数据而已。）
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  },
  // Minimal UI implementations - this tool is for non-interactive SDK/CLI use
  // （中文：下面是极简的 UI 实现——本工具面向非交互的 SDK / CLI 场景，
  //   没人盯着屏幕看，所以渲染函数能省就省，大多返回 null。）
  /**
   * 渲染「工具被调用」那一行，例如 "bugs: 3, severity: high"。
   *
   * 分三档是为了在「信息量」和「屏幕空间」之间取舍：
   *   ① 0 个字段      → null（什么都不显示，避免刷出一行空的）
   *   ② ≤3 个字段     → 全部列出（短，一行放得下）
   *   ③ >3 个字段     → 只给数量 + 前 3 个字段名 + 省略号
   */
  renderToolUseMessage(input: Record<string, unknown>) {
    const keys = Object.keys(input)
    if (keys.length === 0) return null
    if (keys.length <= 3) {
      return keys.map(k => `${k}: ${jsonStringify(input[k])}`).join(', ')
    }
    return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}…`
  },
  // 被拒绝 / 出错 / 进行中 三种状态的文案，非交互场景下都很朴素。
  // 返回 null 的含义是「这个状态下不用显示任何东西」。
  renderToolUseRejectedMessage() {
    return 'Structured output rejected'
  },
  renderToolUseErrorMessage() {
    return 'Structured output error'
  },
  // 进度消息返回 null：本工具执行是瞬间完成的，没有中间进度可报。
  renderToolUseProgressMessage() {
    return null
  },
  renderToolResultMessage(output: string) {
    return output
  },
  /**
   * 把工具结果翻译成 Anthropic API 要求的 tool_result 消息块。
   * tool_use_id 必须与发起调用时的 id 一致，否则 API 会报「孤儿 result」错。
   * 'tool_result' as const：见文件头语法速查——用 as const 收窄成字面量类型。
   */
  mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// 构造结果的两种形态：成功 -> { tool }；失败 -> { error }。
// 详见文件头【TS 语法速查】里对「可辨识联合」的说明。
type CreateResult = { tool: Tool<InputSchema> } | { error: string }

// Workflow scripts call agent({schema: BUGS_SCHEMA}) 30-80 times per run with
// the same schema object reference. Without caching, each call does
// new Ajv() + validateSchema() + compile() (~1.4ms of JIT codegen). Identity
// cache brings 80-call workflows from ~110ms to ~4ms Ajv overhead.
//
// 【上面那段英文注释的中文重述】为什么必须缓存？
//   workflow 脚本一次运行里会拿**同一个 schema 对象**（同一个引用）反复调用
//   agent({schema: BUGS_SCHEMA}) 30~80 次。每次都重走一遍
//       new Ajv() → validateSchema() → compile()
//   其中 compile() 是 JIT 生成校验函数，约 1.4ms；80 次就是 ~110ms 纯浪费。
//   按对象身份缓存之后，同样 80 次调用的 Ajv 开销降到 ~4ms。
//
// 为什么用 WeakMap 而不是普通 Map？
//   普通 Map 会**强引用** key，用户手里的 schema 对象就永远无法被回收，
//   长时间运行的进程会慢慢堆出内存泄漏。WeakMap 的 key 是弱引用，不阻止 GC。
//   ≈ Java 的 WeakHashMap<Object, Result>，正是为这种「对象 → 附属信息」的缓存而生的。
const toolCache = new WeakMap<object, CreateResult>()

/**
 * Create a SyntheticOutputTool configured with the given JSON schema.
 * Returns {tool} on success or {error} with Ajv's diagnostic message
 * (e.g. "data/properties/bugs should be object") on invalid schema.
 *
 * 【★ 本文件对外的主入口】
 *
 * 做什么：
 *   根据用户给的 JSON Schema，产出一个「只能输出该 schema 形状数据」的工具实例。
 *   同一个 schema 对象重复调用会命中缓存，连错误信息也一并复用。
 *
 * 为什么需要：
 *   构造一个专用工具是有成本的（Ajv 编译约 1.4ms 的 JIT），必须缓存；
 *   而失败结果同样要缓存——否则每次都重编译一个坏 schema，白白烧 CPU。
 *
 * 入参 jsonSchema：用户提供的 JSON Schema（Record<string, unknown>，即任意 JSON 对象）
 * 返回值 CreateResult：
 *     { tool: Tool<InputSchema> }  —— 成功，可直接注册进工具表
 *     { error: string }            —— 失败，schema 本身非法时的诊断信息
 * 关键步骤：
 *   ① 按对象引用查缓存，命中就直接返回（注意成功/失败都缓存）
 *   ② 未命中则调用 buildSyntheticOutputTool() 真正构造
 *   ③ 写回缓存后返回
 */
export function createSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  const cached = toolCache.get(jsonSchema)
  if (cached) return cached

  const result = buildSyntheticOutputTool(jsonSchema)
  toolCache.set(jsonSchema, result)
  return result
}

/**
 * 真正干活的内部构造器：把一个 JSON Schema 编译成带校验能力的工具实例。
 *
 * 做什么：
 *   ① 先用 Ajv 判断「这个 schema 本身合不合法」（注意：校验的是 schema 自身，不是数据）；
 *   ② 合法就 compile() 成一个高速校验函数（JIT 生成）；
 *   ③ 生成一个工具副本：保留基础模板的全部钩子，只替换 inputJSONSchema 和 call()。
 *
 * 为什么要有第 ① 步预检？
 *   如果用户的 schema 写错了（比如 type 写成 "objekt"），Ajv 的 compile() 会直接抛异常。
 *   与其让异常炸到调用方脸上，不如在这里捕获、转成友好的 { error } 返回值。
 *   ≈ Java 里的参数前置校验，把「必然失败」提前到入口处暴露。
 *
 * 入参 jsonSchema：待编译的 JSON Schema
 * 返回值 CreateResult：成功 { tool } / 失败 { error }
 */
function buildSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  try {
    // allErrors: true —— 不要一遇到错就停，而是把**全部**错误都收集起来。
    // 对使用者来说，一次看到 5 个字段的问题，远好过改一个再跑一次、来回 5 趟。
    const ajv = new Ajv({ allErrors: true })
    // 第一次校验：schema 自身的合法性（JSON Schema 规范层面的元校验）
    const isValidSchema = ajv.validateSchema(jsonSchema)
    if (!isValidSchema) {
      // errorsText() 把 Ajv 内部的错误对象数组拼成一行人类可读文本，
      // 形如 "data/properties/bugs should be object"。
      return { error: ajv.errorsText(ajv.errors) }
    }
    // 第二次：compile 出一个可复用的校验函数。
    // 这一步才贵（JIT 代码生成约 1.4ms），所以必须放在缓存后面只做一次。
    const validateSchema = ajv.compile(jsonSchema)

    return {
      tool: {
        // ★ 对象展开：把基础模板 SyntheticOutputTool 的所有字段复制过来
        //   （name / prompt / isReadOnly / 各种渲染函数 / checkPermissions …），
        //   下面两项会覆盖同名字段。原模板对象完全不受影响（不可变更新）。
        ...SyntheticOutputTool,
        // 把这个**具体** schema 挂上去，之后模型看到的 input schema 就是它。
        // as 断言见文件头语法速查：jsonSchema 是宽松的 Record<string, unknown>，
        // 这里告诉编译器「它就是合法的 ToolInputJSONSchema」。
        inputJSONSchema: jsonSchema as ToolInputJSONSchema,
        /**
         * 覆盖掉基础模板那个「什么都不做」的 call()，换成带校验的版本。
         *
         * 做什么：
         *   ① 用编译好的 validateSchema() 校验模型填进来的数据；
         *   ② 通过 → 原样返回（含 structured_output）；
         *   ③ 不通过 → throw 一个特殊错误，主循环会把这个错误信息喂回模型，
         *      让模型知道哪里错了并重试——这就是「格式闸门」真正起作用的地方。
         *
         * 为什么是 throw 而不是返回错误对象？
         *   因为工具协议里「调用失败」就是靠异常表达的，
         *   上层会自动把它转成 tool_result 的 is_error 消息回给模型。
         *
         * 为什么要分成「给模型的消息」和「给日志的消息」两个参数？
         *   第一个参数详细（含全部字段路径），是给**模型**看的修复指南；
         *   第二个参数截断到 150 字符，是给**日志/遥测**看的摘要。
         *   那个超长的类名 TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
         *   是在用命名强行提醒调用者：第二个参数绝不能含用户代码或文件路径（隐私合规）。
         */
        async call(input) {
          const isValid = validateSchema(input)
          if (!isValid) {
            // 把 Ajv 的错误数组拼成一串："/bugs/0/severity: must be string, ..."
            // instancePath 为空表示错误出在根对象，此时显示 'root' 更直观。
            // 注意这里用的是 || 而不是 ??：空字符串 '' 确实该被替换成 'root'。
            const errors = validateSchema.errors
              ?.map(e => `${e.instancePath || 'root'}: ${e.message}`)
              .join(', ')
            throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `Output does not match required schema: ${errors}`,
              // 日志侧：截断到 150 字符，避免超长 schema 报错把日志/遥测打爆
              `StructuredOutput schema mismatch: ${(errors ?? '').slice(0, 150)}`,
            )
          }
          return {
            data: 'Structured output provided successfully',
            structured_output: input,
          }
        },
      },
    }
  } catch (e) {
    // catch 到的 e 默认是 unknown 类型，必须先收窄（instanceof）才能安全取 message。
    // 兜底 String(e) 是为了处理 `throw '字符串'` 这种非 Error 的野路子抛出。
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
