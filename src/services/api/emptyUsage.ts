/**
 * 【一句话定位】定义 token 用量统计的「零值」常量 EMPTY_USAGE（所有计数都是 0 的空账本）。
 *
 * 【在架构中的位置】
 *   上游（谁用它）：
 *     - src/services/api/logging.ts：usage 累加器，用它做累加起点
 *     - src/bridge/replBridge.ts：REPL 桥接层，需要一个「空用量」初值
 *     - src/entrypoints/sdk/*.ts：SDK 返回值里要带上 usage 字段
 *   下游（它调用谁）：没有。本文件只 import 了一个「类型」，运行时零依赖。
 *
 * 【为什么这么点东西要单独开一个文件】——这是刻意的「依赖隔离」
 *   EMPTY_USAGE 原本放在 logging.ts 里，但 logging.ts 会 import api/errors.ts，
 *   而 errors.ts → utils/messages.ts → BashTool.tsx → 后面一大串重型模块。
 *   结果：谁只想拿一个「全 0 的空用量」，就得把整条依赖链全部拉进进程
 *   （启动变慢、打包体积膨胀）。把它抽出来单独放，就能让 replBridge 这类
 *   轻量模块只依赖这一个 22 行的小文件。Java 类比：为了避免 import 一个
 *   巨型 jar 而把其中一个常量类单独拆成一个 mini module。
 *
 * 【本文件包含什么】
 *   - EMPTY_USAGE：唯一导出常量，Readonly<NonNullableUsage> 类型，各 token 字段全为 0。
 *
 * 【TS 语法速查（本文件实际出现的）】
 *   1. `import type { X } from '...'`：只导入「类型」不导入「值」。编译成 JS 后这一行会被
 *      完全删掉（Java：相当于只 import interface 而不 import 实现类，运行时零开销）。
 *      写成 `import type` 的好处是打包器百分之百确定它不会有副作用，可以放心删。
 *   2. `const EMPTY_USAGE: Readonly<NonNullableUsage> = {...}`：
 *      - 类型标注在变量名**后面**（`变量名: 类型`），Java 在**前面**（`类型 变量名`）。
 *        这是 Java 工程师读 TS 最容易看串的地方。
 *      - `Readonly<T>` ≈ Java 的「不可变对象」：把 T 的所有字段变成只读，
 *        编译期禁止赋值。注意：它只是编译期约束，运行时并不冻结对象
 *        （跟 Object.freeze / Guava ImmutableList 不一样，运行时仍可强行改）。
 *   3. 嵌套对象字面量 `{ a: { b: 0 } }` ≈ Java 里 new 外层 DTO 时顺手 new 内层 DTO，
 *      不需要先声明 class。TS 的类型是「结构化」的：只要字段对得上就算匹配
 *      （鸭子类型，不需要 implements 某个 interface）。
 */
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'

/**
 * Zero-initialized usage object. Extracted from logging.ts so that
 * bridge/replBridge.ts can import it without transitively pulling in
 * api/errors.ts → utils/messages.ts → BashTool.tsx → the world.
 */
/**
 * token 用量零值对象。所有字段都显式写 0，而不是靠 undefined 兜底，
 * 是为了让下游做 `usage.input_tokens + x` 时永远不会算出 NaN。
 *
 * Java 类比：一个预置好的、各字段为 0 的 UsageDTO 静态实例（类似 Collections.emptyMap 的思路）。
 */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
// input_tokens：本次请求**真正新算**的输入 token 数（即没命中 prompt 缓存的部分）。
// 这是计价最贵的一类：全额价格。
  input_tokens: 0,
// cache_creation_input_tokens：本次请求**写入**缓存的 token 数。
// 比常规 input 更贵（约 1.25 倍），因为服务端要把这段前缀存起来。
  cache_creation_input_tokens: 0,
// cache_read_input_tokens：本次请求**命中**缓存、直接从缓存里读出来的 token 数。
// 最便宜（约常规 input 的 1/10），所以这一列越大越省钱。
  cache_read_input_tokens: 0,
// output_tokens：模型生成的输出 token 数。单价最高（约 input 的 5 倍）。
  output_tokens: 0,
// server_tool_use：服务端侧工具调用次数统计（WebSearch / WebFetch），
// 跟 prompt 本身的 token 无关，单独计费。
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
// service_tier：服务档位（standard / priority 等），影响单价与延迟。
  service_tier: 'standard',
// cache_creation 明细：按缓存存活时长拆分，5 分钟档 vs 1 小时档价格不同，
// 1 小时档写入更贵、但反复命中时更划算。
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
// inference_geo：实际执行推理的地域（用于合规/数据驻留审计）。空串 = 未上报。
  inference_geo: '',
// iterations：一次 query 内部可能分多轮请求（连续对话续接），每轮 usage 记一条。
  iterations: [],
// speed：速度档位（standard / fast），与 service_tier 类似，影响单价。
  speed: 'standard',
}
