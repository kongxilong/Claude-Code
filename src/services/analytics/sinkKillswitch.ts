/**
 * 【一句话定位】
 * 单个上报后端的「紧急熔断开关」：从 GrowthBook 动态配置里读一张 `{ datadog: true, firstParty: true }`
 * 表，值为 true 的后端会被彻底停掉（一个事件都不发）。
 *
 * 【在架构中的位置】
 * 调用链：
 *   sink.ts shouldTrackDatadog()（发 Datadog 之前）
 *     → 本文件 isSinkKilled('datadog')
 *       → growthbook.ts getDynamicConfig_CACHED_MAY_BE_STALE()（读远程动态配置）
 * 用途：线上某个后端出问题（打爆配额、拖慢请求）时，运维可以在服务端改一个配置立刻止血，
 * 不需要发版、不需要用户升级。这是所有大规模客户端的标准做法（Java 里叫「动态降级开关」）。
 *
 * 【本文件包含什么】
 * - SINK_KILLSWITCH_CONFIG_NAME：熔断配置的名字（'tengu_frond_boric'，故意混淆过）。
 * - type SinkName：两个后端的名字联合类型 'datadog' | 'firstParty'。
 * - isSinkKilled()：唯一的导出函数，判断某个后端是否被熔断。
 *
 * 【TS 语法速查】（针对本文件实际出现的写法）
 * - `export type SinkName = 'datadog' | 'firstParty'`：
 *   字符串字面量联合类型 ≈ Java 的 enum。好处：传错字符串编译期就报错，
 *   而且下面 `Partial<Record<SinkName, boolean>>` 能自动约束键名。
 * - `Partial<Record<SinkName, boolean>>`：两个内置工具类型套用。
 *   `Record<SinkName, boolean>` = 必须有 datadog 和 firstParty 两个 boolean 键；
 *   `Partial<...>` = 把每个键都变成可选。合起来就是 `{ datadog?: boolean, firstParty?: boolean }`。
 *   ≈ Java 的 `Map<SinkName, Boolean>` 但允许缺键（Java 的 Map 天然允许，所以没有对应语法）。
 * - `getDynamicConfig_CACHED_MAY_BE_STALE<Type>(name, default)`：
 *   显式传泛型参数（尖括号写在函数名后面）。≈ Java 的 `getConfig(name, Type.class, default)`，
 *   但 TS 的泛型是编译期的，运行期拿不到这个类型信息。
 * - `config?.[sink] === true`：
 *   `?.` 可选链——config 可能为 undefined（配置读不到），此时整条表达式短路成 undefined；
 *   `[sink]` 是「用变量做下标」取属性（≈ Java 的 map.get(sink)）。
 *   最后 `=== true` 而不是「真值判断」：只有明确写了 true 才熔断，
 *   undefined / false / 字符串 'true' 都不算——这是「fail-open」（配置异常时保持原状）的关键。
 * - 为什么配置名要「混淆」（tengu_frond_boric）：
 *   见英文注释的 "Mangled name"。目的是避免用户从配置项名字猜出它的作用、进而通过
 *   本地配置把它打开/关掉。运维开关的名字对终端用户应当是「不可解读」的。
 * - 英文注释强调的递归陷阱：
 *   growthbook.ts 的 isGrowthBookEnabled() 内部会调 is1PEventLoggingEnabled()，
 *   而如果 is1PEventLoggingEnabled() 又反过来调本文件，就成死循环了。
 *   所以本函数【只能在上报点调用】，不能埋进开关的判断链里。
 * - Fail-open 设计：配置缺失或格式错误时，后端保持开启（而不是全关）。
 *   取舍是「宁可多收一点数据，也不要因为配置故障导致整个埋点静默失效」。
 */
import { getDynamicConfig_CACHED_MAY_BE_STALE } from './growthbook.js'

// Mangled name: per-sink analytics killswitch
// 中文补充：配置名是刻意混淆过的（frond_boric 这类的无意义词组），
// 防止用户从名字猜出用途后自己改本地配置绕过熔断。
const SINK_KILLSWITCH_CONFIG_NAME = 'tengu_frond_boric'

// 中文补充：目前两个可熔断的后端。用字面量联合类型而不是 string，
// 这样调用方写错名字（比如 'datadog ' 多了个空格）编译期就会报错。
export type SinkName = 'datadog' | 'firstParty'

/**
 * GrowthBook JSON config that disables individual analytics sinks.
 * Shape: { datadog?: boolean, firstParty?: boolean }
 * A value of true for a key stops all dispatch to that sink.
 * Default {} (nothing killed). Fail-open: missing/malformed config = sink stays on.
 *
 * NOTE: Must NOT be called from inside is1PEventLoggingEnabled() -
 * growthbook.ts:isGrowthBookEnabled() calls that, so a lookup here would recurse.
 * Call at per-event dispatch sites instead.
 */
// 判断某个后端是否被熔断。
// @param sink 'datadog' 或 'firstParty'
// @returns true = 已熔断，别再往这个后端发任何事件
// 设计要点（fail-open）：只有配置里【明确写了 true】才熔断。
// 配置缺失、值为 null、格式错误 → 一律返回 false（后端照常工作）。
// 这样即使配置系统出问题，也只是「熔断功能失效」，不会变成「埋点全挂」。
export function isSinkKilled(sink: SinkName): boolean {
  const config = getDynamicConfig_CACHED_MAY_BE_STALE<
    Partial<Record<SinkName, boolean>>
  >(SINK_KILLSWITCH_CONFIG_NAME, {})
  // getFeatureValue_CACHED_MAY_BE_STALE guards on `!== undefined`, so a
  // cached JSON null leaks through instead of falling back to {}.
// `?.` 在这里是必需的：getDynamicConfig 緩存里可能是 JSON null，而上层的守卫只挡 undefined，
// 所以 null 会「漏」到这里。用可选链兜住，避免对 null 取属性而崩溃。
// `=== true` 严格比较：避免 'true'（字符串）或 1 被误判为熔断信号。
  return config?.[sink] === true
}
