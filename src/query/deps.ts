/**
 * 【一句话定位】把 query() 主循环【对外部世界的 I/O 依赖】抽成一组可替换的函数（依赖注入），
 * 这样测试里可以直接塞假实现，而不必对每个模块做 spyOn。
 *
 * 【在架构中的位置】
 *   上游：src/query.ts —— query() 接收可选的 deps 覆盖；不传就用这里的 productionDeps()
 *         测试代码 —— 传入自己的 QueryDeps（假 callModel、假 autocompact 等）
 *   下游：services/api/claude.js（真正调模型）、services/compact/*（上下文压缩）、node:crypto
 *   调用链：query(params) → deps = params.deps ?? productionDeps() → 主循环里一律通过 deps.xxx() 调用外部能力
 *
 * 【本文件包含什么】
 *   QueryDeps —— 4 个可注入依赖：callModel（调模型）、microcompact / autocompact（压缩上下文）、uuid（生成 ID）
 *   productionDeps() —— 生产环境用的真实实现
 *
 * 【TS 语法速查】
 *   1. `typeof queryModelWithStreaming` —— 【类型查询】：把某个【值/函数】的类型取出来当类型用。
 *      好处：真实函数的签名一改，这里自动跟着变，不用手工同步两遍（Java 没有对应物，
 *      最接近的是「按接口生成实现」那种编译期绑定）。
 *   2. `uuid: () => string` —— 函数类型声明 ≈ Java 的 Supplier<String> / functional interface。
 *   3. 依赖注入在 TS 里通常就是「传一个装着函数的普通对象」，不需要框架、不需要反射。
 *   4. `import { randomUUID } from 'crypto'` 是 Node 内置模块，等价 Java 的 UUID.randomUUID()。
 */
import { randomUUID } from 'crypto'
import { queryModelWithStreaming } from '../services/api/claude.js'
import { autoCompactIfNeeded } from '../services/compact/autoCompact.js'
import { microcompactMessages } from '../services/compact/microCompact.js'

// -- deps

// I/O dependencies for query(). Passing a `deps` override into QueryParams
// lets tests inject fakes directly instead of spyOn-per-module — the most
// common mocks (callModel, autocompact) are each spied in 6-8 test files
// today with module-import-and-spy boilerplate.
//
// Using `typeof fn` keeps signatures in sync with the real implementations
// automatically. This file imports the real functions for both typing and
// the production factory — tests that import this file for typing are
// already importing query.ts (which imports everything), so there's no
// new module-graph cost.
//
// Scope is intentionally narrow (4 deps) to prove the pattern. Followup
// PRs can add runTools, handleStopHooks, logEvent, queue ops, etc.
// 为什么要做这一层依赖注入（对应上方英文注释）：
// 最常见的两个 mock（callModel 与 autocompact）目前在 6-8 个测试文件里各自 spyOn 一遍，
// 全是「import 模块 + 打桩」的样板代码。抽成 deps 之后，测试直接传一个假对象进来即可。
// 用 typeof fn 而不是手写签名：真实函数改签名时这里自动同步，不会出现「假实现签名过时」的隐患。
// 范围刻意只放了 4 个依赖（英文注释说是为了先验证这个模式可行），后续 PR 会陆续加入
// runTools、handleStopHooks、logEvent、队列操作等。
export type QueryDeps = {
  // -- model
  callModel: typeof queryModelWithStreaming
// callModel：真正向模型发请求并接收流式响应的函数。测试里换成假实现就能完全离线跑主循环。

  // -- compaction
  microcompact: typeof microcompactMessages
// 两个压缩能力：microcompact 是「轻量压缩」（截断超大工具结果），autocompact 是「整段上下文压缩」。
  autocompact: typeof autoCompactIfNeeded

  // -- platform
  uuid: () => string
// uuid：抽出来是为了让测试能生成确定的 ID（否则断言里没法比对）。
}

/** 生产环境依赖：把 4 个真实实现打包成 QueryDeps。
 *  返回 QueryDeps 对象。
 *  为什么做成【函数】而不是常量对象：每次调用都造一份新对象，避免调用方意外修改共享实例；
 *  同时也让「依赖的构造时机」延后到真正需要时（模块初始化阶段不宜过早触碰外部资源）。
 */
export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
