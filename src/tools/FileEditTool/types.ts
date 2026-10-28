/**
 * 【一句话定位】
 *   FileEditTool 的“类型/结构定义”：用 zod 声明 Edit 工具的入参、出参形状，并导出一批 TS 类型给全项目复用。
 *   本文件没有任何运行时逻辑，纯粹是“数据契约”。
 *
 * 【在架构中的位置】
 *   上游调用链：被 FileEditTool.ts、utils.ts、UI.tsx 以及更上层的「多编辑 / diff 展示 / 自动确认」逻辑 import。
 *   下游依赖：zod/v4（校验库）、../../utils/lazySchema.js（懒加载包装）、../../utils/semanticBoolean.js（宽松布尔）。
 *   为什么单独拆文件：这些类型被工具本体、工具集（多个编辑合并）、UI、服务层同时引用，
 *   放在 types.ts 可以避免它们互相 import 时产生循环依赖。
 *
 * 【本文件包含什么】
 *   - inputSchema / FileEditInput：模型传进来的入参（file_path + old_string + new_string + replace_all）
 *   - EditInput：单条编辑（去掉 file_path）
 *   - FileEdit：运行期内部用的编辑结构（replace_all 一定是 boolean，不是可选）
 *   - hunkSchema / gitDiffSchema：diff hunk、以及 GitHub diff 信息
 *   - outputSchema / FileEditOutput：call() 的返回结构
 *
 * 【TS 语法速查】（只列本文件真实出现的写法）
 *   - `z.strictObject({...})`：zod 校验器，**strict** 表示出现未声明字段就报错。
 *     对照 Java：Bean Validation 注解，但 zod 在运行时真校验，且能反向推出 TS 类型。
 *   - `.describe('...')`：把说明写进 schema；这份描述会被拼进给模型看的 prompt，属于“一处定义两处用”。
 *   - `.optional()`：字段可省略 ⇒ 生成的 TS 类型是 `xxx?: T`。注意它与 `nullable()` 的区别：
 *     optional = 键可以没有；nullable = 键可以有但值是 null。
 *   - `.default(false).optional()`：没传时填默认值 false。
 *   - `z.infer<typeof S>`：从 schema **反推**输出类型。≈ 注解处理器根据注解生成 DTO。
 *   - `z.output<typeof S>` vs `z.input<typeof S>`：两者可能不同！
 *     比如布尔字段经过语义 relax 处理后，入参侧是 unknown（什么都能进），出参侧才是 boolean。
 *     本文件第 24 行特别注明了要用 output —— 因为 call() 拿到的是“处理之后”的值。
 *   - `Omit<FileEditInput, 'file_path'>`：从已有类型里删掉某个字段。
 *     对照 Java：没有对应语法，只能另写一个类（或用 Lombok 的 @Ignore）。TS 的类型是“结构化加工”出来的。
 *   - `type X = { a: string; b: boolean }`：对象类型。**结构化（鸭子类型）**——
 *     只要字段对得上就算兼容，不要求声明实现同一个接口。对照 Java：record 是名义类型（必须同类）。
 *   - `z.enum(['modified', 'added'])`：取值只能是这两个字符串之一，生成的类型是联合类型 'modified' | 'added'。
 *     对照 Java：enum，但底层是字符串常量且带字面量类型。
 *   - `z.array(hunkSchema())`：数组类型 ⇒ TS 里的 hunk[]。
 *   - `export { inputSchema, outputSchema }`：具名再导出；注意这导出的是**值**（schema 本身），不是类型。
 */
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'

// 中文补充（对应上面英文）：这是带 replace_all 的那份入参 schema。
// strictObject 的选择很关键：模型多传字段（常见的把 Read 的参数混进来）会直接失败，
// 而不是被悄悄忽略后走到深层才炸。
// The input schema with optional replace_all
const inputSchema = lazySchema(() =>
  z.strictObject({
// old_string / new_string 是 Edit 的核心：
//   old_string = 要在文件里找到并替换掉的原文，new_string = 替换后的新内容。
//   设计上强制「按原文精确替换」而不是「按行号」，是为了避免模型记错行号改错地方。
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z
      .string()
      .describe(
        'The text to replace it with (must be different from old_string)',
      ),
// semanticBoolean：对模型的布尔值做宽松解析（模型可能传 "true" 字符串、1 等），
// 目的是提高容错率、减少无意义的重试。
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
// replace_all 的语义开关：
//   false（默认）= 只替换第一处（且上层要求 old_string 必须唯一，否则报错）；
//   true = 该文件里所有出现都替换（典型场景：变量批量重命名）。
    ).describe('Replace all occurrences of old_string (default false)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 中文补充（对应上面英文）：这里刻意用 z.output 而不是 z.input。
// 因为 semanticBoolean 是「预处理型」校验器，它的**输入侧**类型实际上是 unknown（什么都接收），
// 而 call() 拿到的是处理之后的值，类型应以「输出侧」为准。
// Parsed output — what call() receives. z.output not z.input: with
// semanticBoolean the input side is unknown (preprocess accepts anything).
export type FileEditInput = z.output<InputSchema>

// 中文补充（对应上面英文）：单条编辑、不含文件路径。
// 场景：一次请求里对同一个文件做多处编辑时，「文件路径」只需一份，编辑列表里就只放 EditInput[]。
// Individual edit without file_path
export type EditInput = Omit<FileEditInput, 'file_path'>

// 中文补充（对应上面英文）：运行期内部使用的编辑结构。
// 与 FileEditInput 的唯一区别是 replace_all **不再是可选的**（一定是 boolean），
// 这样下游（如 utils.ts 的 applyEditToFile）就不用到处判 "undefined 当 false"。
// 对照 Java：相当于把 Optional<Boolean> 提前归一化成了 boolean，消灭了一类空指针。
// Runtime version where replace_all is always defined
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

// hunkSchema：一个 diff hunk 的形状（起点行号、行数、以及带 +/- 前缀的行数组）。
// 来自 diff 库的输出结构，这里只是把它的形状用 zod 描述出来做校验。
export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

// gitDiffSchema：GitHub 上的 diff 信息（文件名、变更状态、增删行数、patch 全文、仓库归属）。
// 用途：把本次编辑与 GitHub 上已有的 diff 关联起来展示。
export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),
// status 用 enum 限定为 'modified' | 'added'：编辑工具只会产生这两种变更（不会出现删除整个文件）。
    status: z.enum(['modified', 'added']),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string(),
// repository 可空且可选：只在能识别出 owner/repo 时才带上（本地仓库未必有远端）。
    repository: z
      .string()
      .nullable()
      .optional()
      .describe('GitHub owner/repo when available'),
  }),
)

// 中文补充（对应上面英文）：call() 的返回结构。
// 注意它把 oldString/newString/originalFile/structuredPatch 都带回来了：
// 目的是 UI 层可以直接渲染 diff、上层可以做撤销/去重，不必再自己重算一遍。
// Output schema for FileEditTool
const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('The file path that was edited'),
    oldString: z.string().describe('The original string that was replaced'),
    newString: z.string().describe('The new string that replaced it'),
    originalFile: z
      .string()
      .describe('The original file contents before editing'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
// userModified：记录用户是否在 diff 视图里手工改过内容 —— 后续决定是否还走“自动接受”逻辑。
    userModified: z
      .boolean()
      .describe('Whether the user modified the proposed changes'),
    replaceAll: z.boolean().describe('Whether all occurrences were replaced'),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

// z.infer：这里输入输出两侧一致（没有预处理型校验器），用 infer 即可。
export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, outputSchema }
