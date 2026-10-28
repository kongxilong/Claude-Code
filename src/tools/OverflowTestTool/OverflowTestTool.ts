/**
 * ============================================================================
 *  【文件总览】src/tools/OverflowTestTool/OverflowTestTool.ts
 *              —— 「上下文溢出测试」工具的占位文件
 * ============================================================================
 *
 *  一句话定位：
 *  整个文件只有一行 `export const OverflowTestTool = null`。
 *  闭源版本中这里是一个专门用来**人为制造超长输出**、以测试终端 UI 在
 *  内容溢出时如何裁剪/滚动/折叠的工具；开源时被摘掉，只留下空壳。
 *
 *  与其它占位文件相比，本文件有一个地方更明确——src/tools.ts 里的引用长这样：
 *
 *      const OverflowTestTool = feature('OVERFLOW_TEST_TOOL')
 *        ? require('./tools/OverflowTestTool/OverflowTestTool.js').OverflowTestTool
 *        : null
 *      ...
 *      ...(OverflowTestTool ? [OverflowTestTool] : []),
 *
 *  两个机制决定了为什么非留这个文件不可：
 *      ① feature('OVERFLOW_TEST_TOOL') 是**编译期常量**（≈ C 的 #ifdef）：
 *         打包时替换成 true/false，然后整段死代码被 tree-shaking 删除。
 *         为 true 时打包器必须能解析到这个 require 路径，否则打包直接失败。
 *      ② 上层用真值判断 `X ? [X] : []`，而 null 在 JS 里是假值（falsy），
 *         于是「开关开着但只拿到 null」这种情况也能安全退化成「不注册」。
 *
 *  也就是说，「编译期开关」与「运行期空值」形成了双保险：
 *  无论 feature 开关在打包时被定成什么值，最终行为都一致且安全。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】
 * ---------------------------------------------------------------------------
 *
 *      src/tools.ts（工具注册表，第 167、311 行附近）
 *        └─> require('./tools/OverflowTestTool/OverflowTestTool.js')
 *              └─> 拿到本文件的 null → 不进工具表 → 模型看不到这个工具
 *
 *      说明：它属于**开发/测试专用**工具（名字里的 Test 就是这个意思），
 *      只应该在调试构建里出现，绝不能混进面向用户的正式产物。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `export const OverflowTestTool = null`
 *      ≈ Java 的 `public static final Object X = null;`。
 *      没写类型标注时，TS 推断出的类型是字面量类型 `null`（非常窄的类型）。
 *  - null vs undefined：TS 里是两种不同的类型。
 *      null = 「明确地设成无」；undefined = 「压根没这个值」（参数没传、属性缺失）。
 *      Java 里这俩都统一塌缩成 NPE 的同一个来源，TS 则区分得很清楚。
 *  - JS 的 falsy 集合：false / 0 / '' / null / undefined / NaN 全算假。
 *      比 Java「条件里必须是 boolean」宽得多，是 Java 工程师最常踩的坑。
 *  - 数组展开 `...(cond ? [x] : [])`：条件成立摊一项，否则摊零项。
 *      ≈ Java 里「先 new 一个 List，再 if (cond) list.add(x)」合成一行。
 *
 * ============================================================================
 */
export const OverflowTestTool = null
