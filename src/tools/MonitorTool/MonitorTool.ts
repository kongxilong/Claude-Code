/**
 * ============================================================================
 *  【文件总览】src/tools/MonitorTool/MonitorTool.ts
 *              —— 一个被刻意"掏空"的工具占位文件（stub）
 * ============================================================================
 *
 *  一句话定位：
 *  本文件整个只有一行 `export const MonitorTool = null`。
 *  MonitorTool 这个工具在**公开发布的这个开源版本里不存在**——
 *  它的真实实现属于闭源部分，开源时被整体摘掉了。这里留下的
 *  是一个「名字还在、值为 null」的占位导出。
 *
 *  为什么要留一个 null，而不是干脆删掉这个文件和它的引用？
 *      因为 src/tools.ts 里有这样一段（编译期开关 + 惰性 require）：
 *
 *          const MonitorTool = feature('MONITOR_TOOL')
 *              ? require('./tools/MonitorTool/MonitorTool.js').MonitorTool
 *              : null
 *          ...
 *          ...(MonitorTool ? [MonitorTool] : []),
 *
 *      `feature('MONITOR_TOOL')` 是**编译期常量**（≈ C 的 #ifdef，
 *      打包时被替换成 true/false，再被 tree-shaking 把走不到的分支整段删掉）。
 *      当它是 true 时，打包器会去找这个 require 路径；
 *      如果这个文件压根不存在，打包阶段就会直接报错。
 *      所以必须保留这个模块，好让那个 require 至少有个安全的落点。
 *
 *  换句话说，这是一种「让**同一份源码**既能编出完整版（内部 Monaco 版），
 *  又能编出精简开源版」的通用手法：把不能开源的东西换成同样接口的空壳。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】
 * ---------------------------------------------------------------------------
 *
 *      src/tools.ts（工具注册表）
 *        ├─ feature('MONITOR_TOOL') === true  → require 到本文件，拿到 null
 *        │                                    → 三元前面真、**值为 null** → 不进工具表
 *        └─ feature('MONITOR_TOOL') === false → 整个分支被 tree-shaking 删掉
 *
 *      两条路最终结果一样：模型都看不到 MonitorTool。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（本文件就一行代码，但牵扯的语法点不少）
 * ---------------------------------------------------------------------------
 *  - `export const MonitorTool = null`
 *      导出一个值为 null 的常量。因为没有写类型标注，
 *      TS 会把它推断成 `null` 这个**字面量类型**（比 string 窄得多）。
 *      ≈ Java 的 `public static final Object MonitorTool = null;`，
 *        但 TS 的推断粒度细到能记住「它就是 null」。
 *
 *  - 为什么写 `folder = null` 而不是别的值？
 *      因为调用方用的是 `MonitorTool ? [MonitorTool] : []` 这种**真值判断**，
 *      null 在 JS 里是假值（falsy），天然走空数组分支 —— 一个字符都不用改。
 *      ⚠️ Java 工程师注意：JS 的 falsy 除了 false 还包括
 *         0、''、null、undefined、NaN —— 比 Java 的布尔严格性宽得多。
 *
 *  - `??? 三元 + 数组展开 …`：
 *      调用方写的是 `...(MonitorTool ? [MonitorTool] : [])`，
 *      意思是「条件成立就往数组里摊一项，否则摊零项」。
 *      ≈ Java 里先 new 一个 ArrayList 再 if(add)，TS 一行写完。
 *
 *  - 同类文件：本仓库还有一批长得一模一样的占位文件，
 *      比如 ReviewArtifactTool.ts、WorkflowTool.ts、OverflowTestTool.ts、
 *      createWorkflowCommand.ts 等，都是 `export const X = null` 的一行文件。
 *      看到这种形态就知道：这是**被摘掉的闭源能力的接缝处**。
 *
 * ============================================================================
 */
export const MonitorTool = null
