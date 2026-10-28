/**
 * ============================================================================
 *  【文件总览】src/tools/ReviewArtifactTool/ReviewArtifactTool.ts
 *              —— 「审阅产物」工具的占位文件（开源版里为空）
 * ============================================================================
 *
 *  一句话定位：
 *  整个文件只有一行 `export const ReviewArtifactTool = null`。
 *  它是一条**接缝**：闭源版本这里是完整的 ReviewArtifactTool 实现，
 *  开源时被整体摘掉，只留下一个「名字还在、值为 null」的空壳。
 *
 *  为什么留 null 而不是删文件？
 *      因为 src/tools.ts（工具注册表）里是这么引用的：
 *            const X = feature('XXX') ? require('...').X : null
 *            ...(X ? [X] : [])
 *      这里有两个关键机制：
 *      ① feature(...) 是**编译期常量**（打包时替换成 true/false，再 tree-shaking
 *         把走不到的分支整段删掉）。为 true 时打包器必须能找到这个 require 路径，
 *         文件缺失会让打包直接失败——所以这个模块必须存在。
 *      ② 上层用 `X ? ... : ...` 做真值判断，null 在 JS 里是假值，
 *         自然走到「不注册进工具表」的分支，一个字符都不用改。
 *
 *  结论：这种「同一份源码既能编出完整版又能编出精简版」的手法，
 *        在本仓库里反复出现（MonitorTool / WorkflowTool / OverflowTestTool 等都是同款）。
 *        看到 `export const X = null` 的一行文件，就明白它的位置与作用。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】
 * ---------------------------------------------------------------------------
 *
 *      src/tools.ts（工具注册表）
 *        └─> require('./tools/ReviewArtifactTool/ReviewArtifactTool.js')
 *              └─> 拿到本文件的 null
 *                    └─> X ? [X] : [] —— null 为假值，不进工具表，模型看不到它
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（只有一行代码，但牵扯的点值得记一下）
 * ---------------------------------------------------------------------------
 *  - `export const ReviewArtifactTool = null`
 *      ≈ Java 的 `public static final Object X = null;`
 *      但 TS 没写类型标注时，会把它推断成 `null` 这个**字面量类型**（非常窄）。
 *  - null vs undefined：TS 里两者是不同类型。
 *      null = 「明确设为无」；undefined = 「压根没值」（如没传的参数、缺的属性）。
 *      ≈ Java 里两者都是 nullPointerException 的同一个来源，TS 分得比较清。
 *  - falsy 集合：JS 里 false / 0 / '' / null / undefined / NaN 都是假值。
 *      比 Java「必须是 boolean」严格性宽得多，是 Java 工程师最常踩的坑之一。
 *  - 数组展开 `...(cond ? [x] : [])`：条件成立摊一项，否则摊零项。
 *      ≈ Java 里先 new ArrayList 再 if(add) 的两步合成一行。
 *
 * ============================================================================
 */
export const ReviewArtifactTool = null
