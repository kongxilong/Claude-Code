/**
 * 【一句话定位】一个**分组工具函数**：把扁平的消息历史，按「API 往返（API round）」切成一段一段。
 * 它是压缩 / 折叠时挑选「安全切分点」的基础设施——切在哪里，决定了压缩能省多少、又会不会切断上下文。
 *
 * 【在架构中的位置】
 * - 上游：src/services/compact/ 下的压缩逻辑（compact.ts、reactiveCompact.ts 等）在决定
 *   「把哪几轮压成摘要」时需要先按往返分组；这些压缩动作由 src/query.ts 的主循环驱动。
 * - 下游：无（纯函数，只依赖 Message 类型）。
 * - 调用链：src/query.ts（主循环）→ src/services/compact/*.ts → 本文件的 groupMessagesByApiRound()
 *
 * 【为什么是按「API 往返」而不是按「人类轮次」分组】（本文件最重要的设计点）
 * 早期版本按「真实用户输入」分组：只有用户真的敲了一条消息才算一个新组。
 * 这在交互式 REPL 里没问题，但遇到 SDK / CCR / eval 这类调用方就废了——
 * 它们往往**整个会话只有一条人类消息**（一条 prompt 让 Agent 自己跑完所有事），
 * 按人分组的结果就是「永远只有一个组」，压缩无从下手。
 * 改成按 API 往返分组后，即便只有一个人类轮次，也能切出「一次工具调用 → 一次结果 → 下一次调用」
 * 这样粒度合适的区间，压缩才可能只压老的、保留新的。
 *
 * 【什么叫「API 安全切分点」】
 * API 有个硬性契约：一条 assistant 消息里如果有 tool_use，那么**必须**先补上对应的 tool_result，
 * 才能发下一条 assistant 消息。所以在「新一轮 assistant 响应开始」的地方切分，天然满足这个契约——
 * 切点前面是一个完整的往返，后面是另一个完整的往返。
 * 唯一的例外是残缺输入（resume / 截断导致有 tool_use 没有 result），
 * 那种情况由 fork 的 ensureToolResultPairing() 在真正发请求前修补。
 *
 * 【为什么单独拆一个文件】（原英文注释提到的 CC-1180）
 * 为了打破 compact.ts ↔ compactMessages.ts 的**循环依赖**。循环 import 会改变模块初始化顺序，
 * 曾经因此触发了一个潜藏的 ws（WebSocket）CJS/ESM 解析竞态，在 CI shard-2 上偶发失败。
 * 把这段无依赖的纯函数抽出来单独成文件，两边都改为依赖它，环就断了。
 *
 * 【本文件包含什么】
 * - groupMessagesByApiRound()：把 Message[] 切成 Message[][]，一次 API 往返一组。
 *
 * 【TS 语法速查】
 * - `import type { Message } from '...'`：**只导入类型**。编译成 JS 后这一行会被完全删掉，
 *   不会产生任何运行时依赖。Java 没有对应概念（Java 的 import 不区分类型与值，且不会因此加载类）。
 * - `Message[][]`：数组的数组，≈ Java 的 `List<List<Message>>`。
 * - `let` vs `const`：`let` 声明的变量可以**重新赋值**，`const` 声明的**引用不可变**。
 *   注意 const 只锁引用，不锁对象内容（const 数组照样能 push）。本文件里 groups 用 const、
 *   current 用 let，正是因为它们一个不重新赋值、一个会。
 * - `string | undefined`：联合类型（≈ sealed interface，只能是其中一种）。
 *   `| undefined` 表示「可能还没赋值」，≈ Java 的 @Nullable / Optional，但 TS 会强制你先判空。
 * - `for (const msg of messages)`：for-of 遍历，≈ Java 的增强 for / forEach。
 * - `.length` 是**属性**不是方法（Java 里数组是 arr.length、List 是 list.size()，这里统一是属性）。
 */
import type { Message } from '../../types/message.js'

/**
 * Groups messages at API-round boundaries: one group per API round-trip.
 * A boundary fires when a NEW assistant response begins (different
 * message.id from the prior assistant). For well-formed conversations
 * this is an API-safe split point — the API contract requires every
 * tool_use to be resolved before the next assistant turn, so pairing
 * validity falls out of the assistant-id boundary. For malformed inputs
 * (dangling tool_use after resume/truncation) the fork's
 * ensureToolResultPairing repairs the split at API time.
 *
 * Replaces the prior human-turn grouping (boundaries only at real user
 * prompts) with finer-grained API-round grouping, allowing reactive
 * compact to operate on single-prompt agentic sessions (SDK/CCR/eval
 * callers) where the entire workload is one human turn.
 *
 * Extracted to its own file to break the compact.ts ↔ compactMessages.ts
 * cycle (CC-1180) — the cycle shifted module-init order enough to surface
 * a latent ws CJS/ESM resolution race in CI shard-2.
 */
/**
 * 把扁平的消息历史按「API 往返」切分成若干组：一次 API 请求-响应 = 一组。
 *
 * 为什么需要：压缩必须先回答「在哪切」。随便在数组中间切一刀是危险的——
 * 很可能把一条 assistant 的 tool_use 和它后面的 tool_result 分到两边，
 * 发请求时 API 会直接报错（tool_use 没有对应 result）。
 * 按往返分组后，切分点永远落在「新一轮 assistant 响应开始」处，天然安全。
 *
 * @param messages 按时间顺序排列的完整历史消息数组。
 * @returns Message[][]：分组结果，每个元素是一个往返内的消息子数组（顺序与输入一致）。
 * 关键步骤：
 *   ① 用一个 `lastAssistantId` 记录「上一轮 assistant 的 message.id」作为唯一的切分闸门
 *   ② 遍历消息：一旦遇到一条 assistant 且它的 id 与上一个不同，就说明新一轮响应开始了
 *      → 把攒下的 current 推入 groups，并用这条消息开一个新组
 *   ③ 否则把消息追加进当前组（包括插在 assistant 之间的 tool_result）
 *   ④ 遍历结束后把最后一组也推入（否则尾巴会丢）
 *
 * 踩过的坑（原英文注释重点强调）：
 * - 流式输出时，同一个 API 响应的多个 chunk **共享同一个 message.id**，
 *   而 normalizeMessages 会把每个 content block 拆成一条 AssistantMessage，
 *   同时 StreamingToolExecutor 还会把 tool_result 实时插到 chunk 之间。
 *   所以像 [tu_A(id=X), result_A, tu_B(id=X)] 这种顺序，靠 id 判断仍能正确归为同一组——
 *   但如果改成「检查是否还有未解决的 tool_use」就会误判。
 * - 反过来，也不要去追踪「未解决的 tool_use id」：那只在输入本身就残缺时才有意义，
 *   而一旦残缺它就会把闸门永久卡死，导致后面所有往返都被并成一组，压缩彻底失效。
 */
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  // ↓↓↓ 中文解释上面这段英文 ↓↓↓
  // lastAssistantId = 最近一次看到的 assistant 消息的 message.id，它是**唯一**的切分闸门。
  // message.id of the most recently seen assistant. This is the sole
  // boundary gate: streaming chunks from the same API response share an
  // id, so boundaries only fire at the start of a genuinely new round.
  // normalizeMessages yields one AssistantMessage per content block, and
  // StreamingToolExecutor interleaves tool_results between chunks live
  // (yield order, not concat order — see query.ts:613). The id check
  // correctly keeps `[tu_A(id=X), result_A, tu_B(id=X)]` in one group.
  // 上面英文那段的核心（中文重述）：
  // 正常对话里，API 契约保证「每一条 tool_use 都会在下一轮 assistant 之前拿到 result」，
  // 所以只靠 lastAssistantId 就足够判断切分点了。
  // 有人会想再加一层保险：额外记录「尚未拿到 result 的 tool_use id」，只有它们都解决了才允许切分。
  // 不要这么做——它只在**输入本身就是残缺的**（resume 恢复了一半的批次、max_tokens 截断）
  // 时才有意义，而一旦残缺，那些 tool_use 永远等不到 result，闸门被永久卡死，
  // 结果就是后续所有往返全被合并进同一组，压缩彻底失效。
  // 正确做法：让切分照常发生，残缺的 tool_use 交给 summarizer fork 的
  // ensureToolResultPairing()（claude.ts:1136）在真正发请求前修补。
  let lastAssistantId: string | undefined

  // In a well-formed conversation the API contract guarantees every
  // tool_use is resolved before the next assistant turn, so lastAssistantId
  // alone is a sufficient boundary gate. Tracking unresolved tool_use IDs
  // would only do work when the conversation is malformed (dangling tool_use
  // after resume-from-partial-batch or max_tokens truncation) — and in that
  // case it pins the gate shut forever, merging all subsequent rounds into
  // one group. We let those boundaries fire; the summarizer fork's own
  // ensureToolResultPairing at claude.ts:1136 repairs the dangling tu at
  // API time.
  for (const msg of messages) {
    if (
    // 三个条件必须同时成立才算「新一轮开始」：
    //   ① 是 assistant 消息（user / tool_result 都不算新一轮）
    //   ② message.id 与上一轮不同 —— 流式 chunk 共享同一个 id，靠这一步把同一轮的多块合并
    //   ③ current 非空 —— 防止第一条消息就触发一次「推入空组」
      msg.type === 'assistant' &&
      msg.message.id !== lastAssistantId &&
      current.length > 0
    ) {
      // 把攒好的这一组收进结果，然后用当前这条消息开启新的一组（注意是**新数组**，不是清空）
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    // 更新闸门。放在 if/else 之后，保证无论走哪个分支都会被正确更新。
    if (msg.type === 'assistant') {
      lastAssistantId = msg.message.id
    }
  }

  // 收尾：循环里只在「遇到新一轮」时才推入上一组，所以最后一组需要在这里补推，否则尾巴会丢。
  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}
