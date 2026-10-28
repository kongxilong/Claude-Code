/**
 * 判断是否需要剪枝，需要就把最老的若干轮剪掉。
 *
 * 为什么需要：这是四级压缩里最轻的一级。当上下文接近上限但还没到必须整段重写的程度时，
 * 直接丢掉最早的几轮是最省事的做法——不需要调模型、不需要算 token、一行过滤就完事。
 * 代价是信息永久丢失，所以只在「这些老消息已经不太可能被再用到」的前提下才动。
 *
 * @param messages 当前会话的完整历史消息数组。
 * @param _options 预留的剪枝参数（本构建未使用；官方内部用来传保留轮数等策略）。
 * @returns { messages, changed }：messages 是（可能已剪枝的）消息数组；
 *         changed=false 表示本轮什么都没剪。返回 changed 标志是为了让调用方可以无脑调用。
 * 关键步骤：① 判断历史长度是否超过阈值 ② 定位安全切分点（不能把 tool_use 和它的 tool_result 拆开）
 *          ③ 在切分点插入 snip 边界消息，标记「此前的历史已被剪掉」 ④ 返回 changed=true
 */
/**
 * 【一句话定位】四级压缩里的**第一级 snip（剪枝）**：把历史最老的若干轮直接剪掉，是最轻也最粗暴的一级。
 *
 * 【在架构中的位置】
 * - 上游：src/query.ts 的主循环。query.ts 在模块顶层用
 *   `const snipModule = feature('HISTORY_SNIP') ? require('./services/compact/snipCompact.js') : null`
 *   按需加载本模块（见 query.ts:115-117），然后在合适的时机调用 snipCompactIfNeeded()。
 * - 下游：本构建为空实现，不调用任何下游模块。
 * - 调用链：src/query.ts（主循环）→ [feature('HISTORY_SNIP') 编译期开关] → src/services/compact/snipCompact.ts →（空）
 *
 * 【四级压缩的轻重顺序】（务必理解这个梯度）
 * 模型上下文窗口有限（如 200k token），长会话会撑爆。于是按「代价从小到大」逐级升级：
 *   ① snip（本文件）        —— 剪最老的几轮。零成本、不调模型，但信息丢失最彻底，剪掉就永久没了
 *   ② microcompact         —— 把体积大的**工具结果**换成占位符。对话骨架保留，只丢细节
 *   ③ collapse             —— 多轮连续工具往返折叠成一段摘要。要调模型，但只针对局部 span
 *   ④ autocompact（最重）  —— 整段历史压成一份完整摘要。要调模型，丢细节最多，作为兜底
 * 设计原则：能在轻层解决就绝不动用重层，因为越重丢的上下文越多，模型越容易「失忆」。
 *
 * 【本文件包含什么】（**本构建中全部为空实现**）
 * - snipCompactIfNeeded()：判断是否需要剪枝，需要就剪（本构建恒原样返回）。
 * - isSnipBoundaryMessage()：判断某条消息是不是 snip 边界消息。
 *
 * 【关于「边界消息」（boundary message）】
 * 压缩 / 剪枝之后，历史里会插入一条特殊的「边界消息」做标记（例如 microcompact 边界、snip 边界）。
 * 之后所有「只处理边界之后的历史」的逻辑（例如 getMessagesAfterCompactBoundary）都靠它定位——
 * 因为边界之前的原始消息可能已经被删掉或替换成摘要了，再引用它们就会拿到不存在的 tool_use_id。
 *
 * 【TS 语法速查】
 * - `<T>(messages: T, ...): { messages: T; changed: boolean }`：泛型函数，入参和返回值用同一个 T，
 *   ≈ Java 的 `<T> Result<T> f(T messages, ...)`；好处是调用方传什么类型就拿回什么类型，不用强转。
 * - `_options?: unknown`：两个点——
 *   `?` 表示**可选参数**（可以不传，≈ Java 的重载或 @Nullable）；
 *   下划线前缀 `_` 是社区约定的「这个参数故意不用」，用来绕过「未使用变量」的 lint 报错。
 * - `unknown` ≈ Java 的 Object，但更严格：拿到 unknown 之后**必须先做类型判断**才能使用，
 *   比 any 安全（any 相当于关掉类型检查）。
 */
export function snipCompactIfNeeded<T>(messages: T, _options?: unknown): {
  messages: T
  changed: boolean
} {
  // 空实现：原样透传。changed=false 明确告诉调用方「没有剪掉任何东西，不用重新持久化」。
  return { messages, changed: false }
}

/**
 * 判断给定消息是否是 snip 边界消息。
 *
 * 为什么需要：剪枝会在历史里插一条特殊标记消息。后续所有遍历历史的逻辑都要能认出它——
 * 一是要跳过它（它不是真正的对话内容），二是要以它为界只处理它之后的消息。
 * 这与 isMicrocompactBoundaryMessage / isCompactBoundaryMessage 是同一类「历史分界标记」。
 *
 * @returns true 表示这是 snip 边界标记消息。本构建恒 false（因为根本没有剪枝发生）。
 */
export function isSnipBoundaryMessage(): boolean {
  return false
}
