/**
 * ============================================================================
 *  【文件总览】src/tools/REPLTool/primitiveTools.ts
 *              —— REPL 模式下「被藏起来但并没被删掉」的那批基础工具清单
 * ============================================================================
 *
 *  一句话定位：
 *  REPL 模式开启后，Read / Write / Edit / Bash 这些常规工具会从「给模型的工具列表」里
 *  消失，逼着模型改用 REPL（在一个持久化的 JS 沙箱里批量干活）。
 *  但这些工具对象本身**还得存在**——因为
 *      (a) REPL 的沙箱内部（VM context）仍然要调用它们；
 *      (b) 历史消息里已经有它们的调用记录了，UI 还得照样渲染。
 *  本文件就是这份「藏起来了但必须保留」的名单，以及一个惰性 getter。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】谁在用它，为什么必须要它
 * ---------------------------------------------------------------------------
 *
 *      isReplModeEnabled()                    ← 同目录 constants.ts（判断 REPL 模式开关）
 *        └─> getAllTools()                    ← src/tools.ts
 *              └─> 用 REPL_ONLY_TOOLS 过滤掉这批工具的「对外可见性」
 *
 *      但下面这些地方又要反向拿到它们：
 *      src/utils/collapseReadSearch.ts   折叠历史消息时要识别这些工具的调用
 *      REPL 沙箱内部执行 context         把工具方法注入进去供 JS 代码调用
 *      各种 renderer                      渲染这些工具产生的虚拟消息
 *                 └─> getReplPrimitiveTools()  ← ★ 本文件唯一导出的函数
 *
 *      所以本文件处在一条**双向依赖链**上，这也直接导致了下面那个「惰性」设计。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】只有一个函数
 * ---------------------------------------------------------------------------
 *   1. getReplPrimitiveTools()  —— 返回那 8 个工具对象的只读数组（带缓存）
 *      模块级私有变量 _primitiveTools —— 缓存槽
 *
 * ---------------------------------------------------------------------------
 *  【★ 本文件最关键的一件事：为什么非得写成惰性 getter？】
 * ---------------------------------------------------------------------------
 *  上面已经有一大段英文注释讲了这件事，这里用中文再说一遍，因为它是全文件唯一的难点：
 *
 *  存在一条**循环 import 链**：
 *      collapseReadSearch.ts → primitiveTools.ts → FileReadTool.tsx → … → 工具注册表 → collapseReadSearch.ts
 *
 *  如果写成顶层常量：
 *      export const PRIMITIVE_TOOLS = [FileReadTool, FileWriteTool, ...]
 *  那么在模块初始化阶段就要去读 FileReadTool 的值，而它所在的模块可能正在初始化中、
 *  还没走到赋值的那一步。JS 对此的保护是抛 ReferenceError：
 *      "Cannot access 'FileReadTool' before initialization"（即所谓的 TDZ / 暂时性死区）
 *
 *  解决办法：**把求值推迟到函数被调用时**。等到真正有人调用 getReplPrimitiveTools()，
 *  那时所有模块早就初始化完了，自然就不存在半初始化状态。
 *  ≈ Java 里没有完全对应的东西，但思想上类似 Spring 的 `@Lazy`
 *    或「 Supplier + memoize」的组合：要用时才 get，且只算一次。
 *
 *  另一个细节：为什么不用现成的 getAllBaseTools()？
 *      英文注释也说了：那个函数会在 hasEmbeddedSearchTools() 为真时把 Glob/Grep 排除掉，
 *      而这里要的是**稳定不变的 8 个**，不能被运行时的环境差异影响。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（本文件实际出现的写法，Java 工程师对照看）
 * ---------------------------------------------------------------------------
 *  - `import type { Tool } from '../../Tool.js'`
 *      带 `type` 的 import：只导入**类型**，不产生任何运行时代码。
 *      ≈ Java 的 import 只有编译期意义；而且打包时会被整行擦掉。
 *      好处：避免为了拿一个类型而把整个模块的运行时代码拖进来（也减少循环依赖的危害）。
 *
 *  - `let _primitiveTools: readonly Tool[] | undefined`
 *      `readonly Tool[]`：只读数组。编译期禁止 push/splice 等写操作；
 *                         运行时其实还是普通数组，只是编译器不让你改。
 *                         ≈ Java 的 List<T> 只暴露读方法，或用 Collections.unmodifiableList 包一层。
 *      `| undefined`：联合类型，表示「要么有值，要么是 undefined」。
 *                         ≈ Java 的 Optional<T> 的轻量版（但直接就是值本身）。
 *      注意类型标注写在变量**后面**（Java 写在前面，这是最容易看串的地方）。
 *
 *  - `_primitiveTools ??= [...]`
 *      `??=` 逻辑赋值运算符。展开就是：
 *          if (_primitiveTools === undefined) _primitiveTools = [...]
 *      即「惰性初始化 + 一旦算出就永久缓存（memoize）」。
 *      ⚠️ 注意它被用作**表达式**：整句的值是赋值后 _primitiveTools 的值，
 *         所以可以直接 `return (_primitiveTools ??= [...])`，一行搞定。
 *      ≈ Java 里没有这个运算符，得手写三行。
 *
 *  - 前置下划线 `_primitiveTools`
 *      纯命名约定，表示「模块私有，别从外面碰」。TS 里没有 private 作用域修饰符
 *      能作用于模块级变量（也没导出），所以靠下划线 + 不 export 来表达。
 *
 *  - 数组字面量 `[FileReadTool, FileWriteTool, ...]`
 *      直接把 8 个工具对象列出来。它们各自来自自己的目录，
 *      注意这里 import 的是**值**（不是 import type），因为运行时真的要用这些对象。
 *
 * ============================================================================
 */
import type { Tool } from '../../Tool.js'
import { AgentTool } from '../AgentTool/AgentTool.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { NotebookEditTool } from '../NotebookEditTool/NotebookEditTool.js'

// 模块级缓存槽。
//   · 初始值是 undefined，代表「还没算过」；
//   · 一旦被 ??= 赋过值就成了长度固定的数组，之后每次调用都能直接命中缓存。
// 相当于 Java 里的 private static volatile Holder（不过 JS 单线程，无需 volatile）。
let _primitiveTools: readonly Tool[] | undefined

/**
 * Primitive tools hidden from direct model use when REPL mode is on
 * (REPL_ONLY_TOOLS) but still accessible inside the REPL VM context.
 * Exported so display-side code (collapseReadSearch, renderers) can
 * classify/render virtual messages for these tools even when they're
 * absent from the filtered execution tools list.
 *
 * Lazy getter — the import chain collapseReadSearch.ts → primitiveTools.ts
 * → FileReadTool.tsx → ... loops back through the tool registry, so a
 * top-level const hits "Cannot access before initialization". Deferring
 * to call time avoids the TDZ.
 *
 * Referenced directly rather than via getAllBaseTools() because that
 * excludes Glob/Grep when hasEmbeddedSearchTools() is true.
 */
 * 【上面那段英文注释的中文重述】（保留原文不动，这里只是给英文不便的读者补一份）
 *
 *   做什么：
 *     返回 REPL 模式下「对模型隐藏、但系统内部仍然要用」的那批基础工具，共 8 个：
 *       FileRead / FileWrite / FileEdit / Glob / Grep / Bash / NotebookEdit / Agent
 *
 *   为什么需要：
 *     REPL 模式把这些工具从模型的工具列表里摘掉了（见 constants.ts 的 REPL_ONLY_TOOLS），
 *     但 REPL 沙箱内部还要执行它们，历史消息的渲染/折叠逻辑也还要认得它们。
 *     这个函数就是那份「虽然藏着但不能丢」的名单的唯一来源。
 *
 *   为什么写成「惰性 + 缓存」而不是顶层常量：
 *     因为存在 collapseReadSearch.ts → primitiveTools.ts → FileReadTool.tsx → 工具注册表
 *     → collapseReadSearch.ts 这条环。顶层 const 会在模块半初始化状态去读 FileReadTool，
 *     触发 ReferenceError: Cannot access before initialization（TDZ）。
 *     推迟到函数调用时再取值，届时所有模块都已就绪，环自然解开。
 *     文件头【为什么非得写成惰性 getter】一节有更详细的说明。
 *
 *   为什么不用现成的 getAllBaseTools()：
 *     那个函数在 hasEmbeddedSearchTools() 为真时会剔除 Glob/Grep，
 *     结果随环境变化；这里要的是恒定的 8 个。
 *
 *   入参：无
 *   返回值：readonly Tool[] —— 长度固定为 8 的只读数组；多次调用返回**同一个**数组实例（有缓存）
 *   关键步骤：就一步 —— `??=`：空则构造，非空则复用。
 */
export function getReplPrimitiveTools(): readonly Tool[] {
  return (_primitiveTools ??= [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    BashTool,
    NotebookEditTool,
    AgentTool,
  ])
}
