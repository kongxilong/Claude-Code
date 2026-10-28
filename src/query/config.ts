/**
 * 【一句话定位】把一次 query()（一轮主循环）开始时【需要快照下来的不可变配置】集中到一处：
 * sessionId + 若干运行时开关（gates）。
 *
 * 【在架构中的位置】
 *   上游：src/query.ts —— 在 query() 入口处调用 buildQueryConfig() 生成一份 config，整个主循环共用
 *   下游：bootstrap/state.js（getSessionId）、services/analytics/growthbook.js（Statsig 开关）、
 *         utils/envUtils.js（isEnvTruthy 读环境变量）
 *   调用链：query() 入口 → buildQueryConfig() → 得到 QueryConfig → 传给主循环各步骤（未来会传给纯函数 step(state, event, config)）
 *
 * 【本文件包含什么】
 *   QueryConfig —— 一次查询的配置快照：sessionId + gates（4 个运行时开关）
 *   buildQueryConfig() —— 读取当前环境生成这份快照
 *
 * 【TS 语法速查】
 *   1. 嵌套类型字面量：`gates: { streamingToolExecution: boolean; ... }` ≈ Java 里嵌套的静态内部类 / record，
 *      但只是结构声明，不需要额外的类。
 *   2. `export type X = {...}` 只导出类型，编译后完全消失。
 *   3. `function f(): QueryConfig` —— 返回类型标注在【参数表后面】（Java 在方法名前面），这是最容易看串的地方。
 *   4. `process.env.X` ≈ Java System.getenv()；`isEnvTruthy()` 把字符串转成布尔（'1'/'true' 等为真）。
 */
import { getSessionId } from '../bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import type { SessionId } from '../types/ids.js'
import { isEnvTruthy } from '../utils/envUtils.js'

// -- config

// Immutable values snapshotted once at query() entry. Separating these from
// the per-iteration State struct and the mutable ToolUseContext makes future
// step() extraction tractable — a pure reducer can take (state, event, config)
// where config is plain data.
//
// Intentionally excludes feature() gates — those are tree-shaking boundaries
// and must stay inline at the guarded blocks for dead-code elimination.
// QueryConfig 的设计意图（见上方英文注释，这里用中文讲透）：
// ① 这些值在 query() 入口处【快照一次】，之后整个主循环都只读不改——这样就把它从「每次迭代都在变的 State」
//    和「可变的 ToolUseContext」里剥离出来了，将来要把主循环重构成一个【纯 reducer】
//    step(state, event, config) 时，config 就是一份干净的纯数据，重构才好下手。
// ② 刻意【不包含】feature() 开关：feature() 是打包期死代码消除的边界，必须原地写在被保护的代码块旁边，
//    一旦抽到这里的配置对象里，打包器就看不出该删哪段了（会把整段代码都保留下来）。
// ③ 只包含【运行时】开关（环境变量 / Statsig），它们本来就是每次调用都可能不同的值，适合快照。
export type QueryConfig = {
  sessionId: SessionId

  // Runtime gates (env/statsig). NOT feature() gates — see above.
  gates: {
    // Statsig — CACHED_MAY_BE_STALE already admits staleness, so snapshotting
    // once per query() call stays within the existing contract.
    streamingToolExecution: boolean
    emitToolUseSummaries: boolean
    isAnt: boolean
    fastModeEnabled: boolean
// 四个运行时开关：
//   streamingToolExecution —— 是否启用「流式工具执行」（模型还没说完就开始跑工具，见 StreamingToolExecutor.ts）
//   emitToolUseSummaries   —— 是否生成工具调用摘要消息
//   isAnt                  —— 是否内部构建（USER_TYPE=ant）
//   fastModeEnabled        —— 是否启用 fast mode（默认开，可用环境变量关掉）
  }
}

/** 生成一次查询的配置快照。
 *  返回 QueryConfig：含 sessionId 与四个运行时开关。
 *  步骤：① 取当前 sessionId ② 依次读取 Statsig 开关、环境变量、USER_TYPE ③ 组装返回
 *  为什么要在入口处一次性快照：主循环里会反复判断这些开关，如果每次都重新读，
 *  同一轮内出现开关「前半段 false、后半段 true」会引发难以复现的行为不一致。
 *  Statsig 那个开关用的 CACHED_MAY_BE_STALE 版本本身就承认「可能是陈旧值」，
 *  所以每轮 query() 取一次依然在它承诺的契约之内。
 */
export function buildQueryConfig(): QueryConfig {
  return {
    sessionId: getSessionId(),
    gates: {
      streamingToolExecution: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_streaming_tool_execution2',
      ),
      emitToolUseSummaries: isEnvTruthy(
        process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES,
      ),
      isAnt: process.env.USER_TYPE === 'ant',
      // Inlined from fastMode.ts to avoid pulling its heavy module graph
      // (axios, settings, auth, model, oauth, config) into test shards that
      // didn't previously load it — changes init order and breaks unrelated tests.
      fastModeEnabled: !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FAST_MODE),
// fastModeEnabled 的判断是【内联】写的，而不是去 import fastMode.ts：
// 那个模块会牵出一整条重型依赖图（axios、settings、auth、model、oauth、config），
// 把它拉进来会改变模块初始化顺序，导致原本不加载它的测试分片挂掉。
// 这是一处典型的「为了模块图干净而复制一行逻辑」的取舍。
    },
  }
}
