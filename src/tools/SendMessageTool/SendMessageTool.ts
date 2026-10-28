/**
 * ============================================================================
 *  【文件总览】src/tools/SendMessageTool/SendMessageTool.ts
 *              —— 多 Agent 协作中的「发消息」工具（swarm 通信基础设施）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件定义了 SendMessage 工具：让一个 agent 给另一个 agent 发消息。
 *  它是 Claude Code「多 Agent 协作（swarm / team）」能力里最基础的通信管道。
 *
 *  【为什么需要它？——先理解 agent 之间是怎么"说话"的】
 *  每个 agent（主会话、被派生的子 agent、teammate）彼此**完全隔离**：
 *  不共享内存，也看不到对方的对话历史。唯一的沟通渠道就是"消息"。
 *  而消息的物理载体是**磁盘上的信箱文件（mailbox）**：
 *
 *      发送方调用本工具 → writeToMailbox() → 往收件人的 inbox 文件里追加一条记录
 *      接收方在「下一轮工具回合」开始前 → 读自己的 inbox → 把消息注入自己的上下文
 *
 *  这就是异步消息：发送方不等回复，对方什么时候取走是对方的事。
 *  ≈ Java 里往 BlockingQueue / MessageQueue 里 offer 一条，消费端自己 poll。
 *  推论：消息**不是**即时生效的，接收方要跑到下一轮才会看到（这点常被误解）。
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "SendMessage"）
 *        └─> 工具编排层 src/services/tools/toolOrchestration.ts
 *              └─> 本文件的 SendMessageTool.call()            ← ★ 你在这里
 *                    ├─> postInterClaudeMessage()  src/bridge/peerSessions.js     → 跨机器（Remote Control bridge）
 *                    ├─> sendToUdsSocket()         src/utils/udsClient.js         → 同机跨进程（Unix Domain Socket）
 *                    ├─> queuePendingMessage()     src/tasks/LocalAgentTask/...   → 本进程内的子 agent（直接投递）
 *                    ├─> resumeAgentBackground()   src/tools/AgentTool/...        → 子 agent 已停止，先唤醒再投递
 *                    └─> writeToMailbox()          src/utils/teammateMailbox.ts   → 落到磁盘信箱（teammate 场景）
 *      两个渲染函数（renderToolUseMessage / renderToolResultMessage）在 ./UI.tsx
 *      工具的自我说明（DESCRIPTION / getPrompt）在 ./prompt.ts
 *      工具名常量 SEND_MESSAGE_TOOL_NAME 在 ./constants.ts
 *
 *  【本文件包含什么】（8 个 handler + 工具本体）
 *   1. StructuredMessage / inputSchema   zod 校验规则：to / summary / message
 *   2. handleMessage()              单发：给一个具名 teammate 发纯文本
 *   3. handleBroadcast()            群发：to = "*"，给除自己外所有队友各写一份
 *   4. handleShutdownRequest()      协议消息①：team-lead 请求某个 teammate 退出
 *   5. handleShutdownApproval()     协议消息②：teammate 同意退出（真的会 abort 自己）
 *   6. handleShutdownRejection()    协议消息③：teammate 拒绝退出，继续干活
 *   7. handlePlanApproval()         协议消息④：team-lead 批准某人的计划
 *   8. handlePlanRejection()        协议消息⑤：team-lead 打回某人的计划并附反馈
 *   9. SendMessageTool              工具对象本体（buildTool 的产物）
 *
 *  【核心心智模型：call() 里的 if / switch 就是一张"路由表"】
 *  call() 看着长，其实只做一件事：**按 to 和 message 的类型把请求分发到上面 8 个 handler**。
 *  前面的分支命中就 return，不会走到后面，顺序即优先级：
 *      ① 跨会话地址（bridge: / uds:）—— 仅 feature('UDS_INBOX') 编译时存在
 *      ② 本进程内的子 agent（按名字或 agentId 查 appState.tasks）
 *      ③ 纯文本 + to === '*'  → 群发 handleBroadcast
 *      ④ 纯文本 + 具名        → 单发 handleMessage
 *      ⑤ 结构化 JSON          → shutdown_request / shutdown_response / plan_approval_response
 *
 *  【"协议消息"是什么？】
 *  除了普通聊天文本，message 还允许传一个 JSON 对象（StructuredMessage）。
 *  这些是 agent 之间约定好的**控制协议**，用来做「优雅停机」和「计划审批」：
 *      shutdown_request       lead → teammate：请你退出（teammate 可以拒绝）
 *      shutdown_response      teammate → lead：同意 / 拒绝（拒绝必须给 reason）
 *      plan_approval_response lead → teammate：approve=true 放行 / false 打回并附 feedback
 *  注意 prompt.ts 里把它标为 legacy，但代码仍在，属于"还活着的老协议"。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（Java 工程师视角，只列本文件真正出现的）
 * ---------------------------------------------------------------------------
 *  - `feature('UDS_INBOX')`：**编译期**开关，不是运行时 if！来自 `bun:bundle`。
 *    打包时替换成 true/false，再把整段代码 tree-shaking 掉（DCE，死代码消除）。
 *    ≈ C 的 `#ifdef`。所以 `if (feature('X') && ...)` 这种嵌套不是写得丑，
 *    是 DCE 的硬性约束：feature() 只能出现在 if / 三元的条件位置，不能先赋给变量。
 *
 *  - `type X = { ... }` 结构化类型 ≈ Java 的 record，但按**结构**匹配（鸭子类型），
 *    不需要 implements。`b?: number` 表示可选，等价于 `number | undefined`。
 *  - `A | B` 联合类型 ≈ Java 的 sealed interface 的多个实现，但轻量得多。
 *    本文件末尾 `SendMessageToolOutput = MessageOutput | BroadcastOutput | ...` 就是。
 *
 *  - `'routing' in result`  —— `in` 运算符：判断对象**有没有这个属性**。
 *    这是 TS 收窄联合类型的常用手法（≈ Java 的 map.containsKey，作用是分辨类型）。
 *    if 进去之后，编译器就知道 result 具体是联合类型里的哪一个分支了。
 *
 *  - `?.` 可选链：`a?.b?.c` ≈ `a != null && a.b != null ? a.b.c : null`，一路串下去不会 NPE。
 *  - `??` 空值合并：`a ?? b` 只在 a 是 null / undefined 时才取 b。
 *    ⚠️ 与 `||` 的区别：`0`、`''`、`false` 不会被 `??` 换掉，但会被 `||` 换掉。
 *  - `!` 非空断言：`x!.foo` = "我保证 x 不是 null，编译器别管了"。
 *    ≈ Java 的 `(Foo) x` 强转，运行时不做检查，纯粹是骗编译器。
 *    本文件 `input.message.reason!` 就是（前面 validateInput 已保证它非空）。
 *  - `as X` 类型断言 ≈ 强制类型转换，同样运行时不校验。
 *    `as const` 是「把值锁成字面量类型」，让 TS 推导成 'tool_result' 而不是 string。
 *
 *  - 类型标注在**变量名后面**：`let n: string`、`function f(a: string): void`。
 *    （Java 是 `String n`、`void f(String a)`，正好反着，初期最容易看串）
 *  - `{ ...obj, a: 1 }` 展开：复制一份并覆盖字段（不可变更新），Java 没有对应物。
 *  - `x => x + 1` 箭头函数 ≈ Java 的 lambda。
 *  - `async / await` ≈ Java 的 CompletableFuture，但写起来像同步代码。
 *  - `switch (x.type)` 作用在联合类型上 → **穷尽性检查**：
 *    漏了某个 case 编译器会报错（≈ Java 17 switch 模式匹配 + sealed interface）。
 *
 *  - `satisfies ToolDef<...>`（本文件最末尾）：「请按 ToolDef 检查我写得对不对，
 *    但**不要**把我的类型拓宽成 ToolDef」。既拿到检查，又保留各字段的精确类型。
 *    Java 没有对应物，是 TS 4.9 的新关键字。
 *
 *  - `zod`（`z.object()` / `z.string()` / `z.union()`）：**运行时** schema 校验库，
 *    同时兼做「生成 JSON Schema 给模型看」和「推导 TS 类型」两件事。
 *    ≈ Java 的 Bean Validation + 由注解生成类型，但 TS 里一个库搞定。
 *    `z.infer<typeof X>` = 从 schema **反推**出 TS 类型（避免手写两遍）。
 *    `z.discriminatedUnion('type', [...])` ≈ Java sealed interface，按 type 字段判别子类。
 *
 *  - `100_000`：数字里的下划线只是千位分隔符，等价于 100000（Java 也有这语法）。
 *  - `require(...)` + `as typeof import(...)`：动态导入，为了配合 DCE 刻意不用静态 import
 *    （静态 import 会把那个模块无条件打进产物里）。
 */
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getReplBridgeHandle } from '../../bridge/replBridgeHandle.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { findTeammateTaskByAgentId } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { toAgentId } from '../../types/ids.js'
import { generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseAddress } from '../../utils/peerAddress.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeamLead,
  isTeammate,
} from '../../utils/teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { resumeAgentBackground } from '../AgentTool/resumeAgent.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

// ── message 字段的「结构化消息」分支：agent 之间的控制协议 ────────────────
// message 既可以是纯字符串（普通聊天），也可以是下面三种 JSON 之一：
//   shutdown_request       team-lead → teammate：请你退出（对方可以拒绝）
//   shutdown_response      teammate → team-lead：同意 / 拒绝退出
//   plan_approval_response team-lead → teammate：批准 / 打回计划（附 feedback）
// 为什么用 lazySchema 包一层：schema 的构造成本不低，而很多会话根本用不到本工具，
// 延迟到第一次真正用到时才构造（≈ Java 的懒加载单例），省启动开销。
const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      feedback: z.string().optional(),
    }),
  ]),
)

// ── 工具的入参 schema（同时也是发给模型的 JSON Schema）─────────────────
// to      ：收件人。可以是队友名、"*"（群发）、"uds:<路径>"（同机跨进程）、
//           "bridge:<session-id>"（跨机器）。后两种地址仅 feature('UDS_INBOX') 时可用。
// summary ：5~10 词的摘要，只在 UI 上当预览显示（message 是字符串时必填）。
// message ：正文，字符串 或 上面的 StructuredMessage。
// 注意 .describe() 里的文字是**给模型看的**，所以是英文——改它等于改 prompt。
const inputSchema = lazySchema(() =>
  z.object({
    to: z
      .string()
      .describe(
        feature('UDS_INBOX')
          ? 'Recipient: teammate name, "*" for broadcast, "uds:<socket-path>" for a local peer, or "bridge:<session-id>" for a Remote Control peer (use ListPeers to discover)'
          : 'Recipient: teammate name, or "*" for broadcast to all teammates',
      ),
    summary: z
      .string()
      .optional()
      .describe(
        'A 5-10 word summary shown as a preview in the UI (required when message is a string)',
      ),
    message: z.union([
      z.string().describe('Plain text message content'),
      StructuredMessage(),
    ]),
  }),
)
// `ReturnType<typeof f>`：取函数 f 的返回值类型。因为 inputSchema 是懒加载工厂，
// 真正的 schema 类型是「调用它之后」的结果，所以要这么绕一层。
type InputSchema = ReturnType<typeof inputSchema>

// `z.infer<X>`：从 zod schema 反推出 TS 类型（≈ 由注解生成 DTO 类）。
// 好处：schema 改了类型自动跟着改，不用手写两遍、也不会两边不一致。
export type Input = z.infer<InputSchema>

// 路由信息：消息发出去之后"谁发给谁"的可视化元数据，只给 UI 渲染用，
// 不参与业务逻辑。字段全可选（?），因为跨会话发送时不一定都有。
export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

// ── 下面是 4 种可能的返回形状，最后用联合类型拼成 SendMessageToolOutput ──
// 单发成功时的返回：success + 一句人话 message + routing（给 UI 画箭头用）。
export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
}

// 群发成功时的返回：比 MessageOutput 多了 recipients（实际收到的人的名单）。
export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  routing?: MessageRouting
}

// 发起"停机请求"时的返回：带 request_id，对方回复时要原样回传这个 id 才能对上号。
// ≈ Java 里的 correlationId：请求-响应配对用的关联 ID。
export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

// 响应类消息的返回（批准/拒绝停机、批准/打回计划共用这一个形状）。
export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

// 联合类型 ≈ Java 的 sealed interface 有多个实现。
// 消费方要先用 `in` 或字段判断（如 'request_id' in result）分辨出具体是哪一种，
// 之后 TS 才会允许你访问对应分支独有的字段。
export type SendMessageToolOutput =
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput

/**
 * 按队友名字查出他的展示颜色（用于在终端里区分不同 agent 的消息气泡）。
 *
 * 为什么要单独写这个函数：teamContext.teammates 是一个 **map**（键是 agentId），
 * 而我们手上只有"名字"，只能遍历 value 去比对 'name' 字段。
 *
 * @param appState 全局应用状态；这里只用到 teamContext.teammates 这一小块，
 *                 所以参数类型写成了一个**结构化的最小形状**（鸭子类型：
 *                 只要传进来的对象长这样就行，不要求真的是 AppState 类型）。
 * @param name     要查的队友名字。
 * @returns 颜色字符串；找不到就返回 undefined（调用方用可选字段接住即可）。
 *
 * 关键步骤：
 *   ① 先 `?.` 取出 teammates，没有就直接返回 undefined（防御：不在团队里时为空）
 *   ② 遍历所有队友，用 `'name' in teammate` 判断这个 value 上确实有 name 字段
 *   ③ 命中就返回它的 color
 */
function findTeammateColor(
  appState: {
    teamContext?: { teammates: { [id: string]: { color?: string } } }
  },
  name: string,
): string | undefined {
  const teammates = appState.teamContext?.teammates
  if (!teammates) return undefined
  for (const teammate of Object.values(teammates)) {
    if ('name' in teammate && (teammate as { name: string }).name === name) {
      return teammate.color
    }
  }
  return undefined
}

/**
 * 【单发】给一个具名 teammate 发一条纯文本消息。
 *
 * 为什么需要：这是最常用的一条路径——模型想让某个队友干活 / 汇报，就走这里。
 * 实现上就是把消息**落到对方的信箱文件**里（fire-and-forget），不等待对方处理。
 *
 * @param recipientName 收件人名字（裸名字，不带 @，不带 uds:/bridge: 前缀）。
 * @param content       消息正文。
 * @param summary       UI 预览用的一句话摘要，可以没有。
 * @param context       工具运行时上下文，这里主要用来拿 AppState。
 * @returns `{ data: MessageOutput }`。约定：工具统一用 `{ data }` 包一层，
 *          data 里才是真正给模型看的内容（框架会再转成 tool_result 块）。
 *
 * 关键步骤：
 *   ① 取团队名 + 发送者名字（拿不到就退化成 'teammate' / 'team-lead'）
 *   ② writeToMailbox：把消息追加写入收件人的 inbox（真正产生副作用的一步）
 *   ③ 查收件人颜色，组装 routing 元数据返回（纯粹为了 UI 好看）
 */
async function handleMessage(
  recipientName: string,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: MessageOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  const senderColor = getTeammateColor()

  // 真正"发消息"的动作：往磁盘上的信箱追加一条。异步但不等对方读。
  await writeToMailbox(
    recipientName,
    {
      from: senderName,
      text: content,
      summary,
      timestamp: new Date().toISOString(),
      color: senderColor,
    },
    teamName,
  )

  const recipientColor = findTeammateColor(appState, recipientName)

  return {
    data: {
      success: true,
      message: `Message sent to ${recipientName}'s inbox`,
      routing: {
        sender: senderName,
        senderColor,
        target: `@${recipientName}`,
        targetColor: recipientColor,
        summary,
        content,
      },
    },
  }
}

/**
 * 【群发】to = "*" 时给团队里**除自己以外**的所有队友各发一份。
 *
 * 为什么需要：广播在协作里很自然（"所有人都停下手上的活"），但代价是
 * 消息数随团队规模**线性增长**，所以 prompt.ts 里明确写了"expensive，慎用"。
 *
 * @param content  消息正文（所有人收到的是同一份内容）。
 * @param summary  UI 预览摘要。
 * @param context  工具上下文（取 AppState → teamContext → teamName）。
 * @returns `{ data: BroadcastOutput }`，带实际 recipients 名单。
 *
 * 关键步骤：
 *   ① 必须有 teamName，否则直接抛错：不在团队里谈何群发
 *   ② 读团队文件（磁盘上的成员名单），确认团队真存在
 *   ③ 逐个 writeToMailbox —— 注意是**循环里 await**，即串行发送，不是并发
 *   ④ 把自己从名单里剔除（否则会给自己发一份，形成无意义的自我消息）
 */
async function handleBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: BroadcastOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)

  // 不在团队上下文里就无从群发。用抛异常而不是返回 {success:false}：
  // 这是"用法错误"（模型写错了参数），而不是"业务失败"，让它往上冒泡更符合语义。
  if (!teamName) {
    throw new Error(
      'Not in a team context. Create a team with Teammate spawnTeam first, or set CLAUDE_CODE_TEAM_NAME.',
    )
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(`Team "${teamName}" does not exist`)
  }

  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  if (!senderName) {
    throw new Error(
      'Cannot broadcast: sender name is required. Set CLAUDE_CODE_AGENT_NAME.',
    )
  }

  const senderColor = getTeammateColor()

  const recipients: string[] = []
  // 逐个比对名字（大小写不敏感）跳过自己 —— 避免给自己也发一份。
  for (const member of teamFile.members) {
    if (member.name.toLowerCase() === senderName.toLowerCase()) {
      continue
    }
    recipients.push(member.name)
  }

  // 团队里只有自己一个人：不算错误，返回成功 + 空名单。
  // 为什么要特判：否则下面的模板字符串会渲染成 "broadcast to 0 teammate(s)"，
  // 模型看到会以为失败了从而重试，其实什么也没做错。
  if (recipients.length === 0) {
    return {
      data: {
        success: true,
        message: 'No teammates to broadcast to (you are the only team member)',
        recipients: [],
      },
    }
  }

  for (const recipientName of recipients) {
    await writeToMailbox(
      recipientName,
      {
        from: senderName,
        text: content,
        summary,
        timestamp: new Date().toISOString(),
        color: senderColor,
      },
      teamName,
    )
  }

  return {
    data: {
      success: true,
      message: `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`,
      recipients,
      routing: {
        sender: senderName,
        senderColor,
        target: '@team',
        summary,
        content,
      },
    },
  }
}

/**
 * 【协议消息①】team-lead 请求某个 teammate 优雅退出。
 *
 * 为什么需要：直接 kill 掉一个 agent 会让它手上的活儿半途而废。
 * 这里采用的是「协商式停机」：先发请求（带 request_id），对方可以选择拒绝。
 *
 * @param targetName 要停掉的 teammate 名字。
 * @param reason     停机理由（可选，写进消息体让对方知道为什么）。
 * @param context    工具上下文（取 teamName）。
 * @returns `{ data: RequestOutput }`，含 request_id —— 对方回复时要**原样回传**，
 *          这样 lead 才能把响应和请求对上（≈ Java 的消息 correlationId）。
 *
 * 关键步骤：
 *   ① generateRequestId() 生成一个唯一 request_id（含目标名，便于调试时肉眼定位）
 *   ② createShutdownRequestMessage() 组装协议消息对象
 *   ③ jsonStringify 成字符串再塞进信箱 —— 信箱里存的**永远是字符串**，
 *      结构化内容靠 JSON 编码传递，接收方再解析回来
 */
async function handleShutdownRequest(
  targetName: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName = getAgentName() || TEAM_LEAD_NAME
  // request_id 是请求-响应的配对凭证：响应方必须回传同一个 id，
  // 否则发起方无法知道这条响应对应哪一次请求。
  const requestId = generateRequestId('shutdown', targetName)

  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown request sent to ${targetName}. Request ID: ${requestId}`,
      request_id: requestId,
      target: targetName,
    },
  }
}

/**
 * 【协议消息②】teammate 同意停机 —— 这是全流程里**副作用最重**的一个函数。
 *
 * 为什么需要：teammate 收到 shutdown_request 后如果同意，不能只是"回一句 OK"，
 * 必须真的把自己停掉，否则 lead 会一直等。所以这里会 abort 自己的 AbortController，
 * 或者调用 gracefulShutdown() 让整个进程体面退出。
 *
 * @param requestId 要响应的那次请求的 id（从收到的消息里原样取出）。
 * @param context   工具上下文（取 AppState → tasks，用来找到自己的 abortController）。
 * @returns `{ data: ResponseOutput }`。
 *
 * 关键步骤：
 *   ① 先把"同意"这条响应写回给 team-lead（先回话，再自杀，顺序不能反）
 *   ② 从团队文件里查出自己的 paneId / backendType，一起回传（lead 要用它做清理）
 *   ③ 按 backendType 分两条路：
 *        in-process（子 agent 跑在同一进程里）→ 直接 abort 自己的 AbortController
 *        其它（独立进程 / tmux pane）        → setImmediate 里调 gracefulShutdown 退出进程
 *   ④ 为什么要 setImmediate：不能在当前调用栈里直接退出进程，
 *      否则本工具的返回值还没来得及交给框架，调用方会收不到响应。
 *      推到下一个事件循环再退出 ≈ Java 里放到另一个线程执行，先让当前方法返回。
 */
async function handleShutdownApproval(
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName() || 'teammate'

  logForDebugging(
    `[SendMessageTool] handleShutdownApproval: teamName=${teamName}, agentId=${agentId}, agentName=${agentName}`,
  )

  let ownPaneId: string | undefined
  let ownBackendType: BackendType | undefined
  if (teamName) {
    const teamFile = await readTeamFileAsync(teamName)
    if (teamFile && agentId) {
      const selfMember = teamFile.members.find(m => m.agentId === agentId)
      if (selfMember) {
        ownPaneId = selfMember.tmuxPaneId
        ownBackendType = selfMember.backendType
      }
    }
  }

  const approvedMessage = createShutdownApprovedMessage({
    requestId,
    from: agentName,
    paneId: ownPaneId,
    backendType: ownBackendType,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(approvedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  // in-process 的子 agent：它只是宿主进程里的一个对象，没有自己的 OS 进程，
  // 所以"停机"= 触发它的 AbortController（≈ Java 的 Future.cancel(true)），
  // 让它正在跑的那一轮循环被中断，而不是杀进程。
  if (ownBackendType === 'in-process') {
    logForDebugging(
      `[SendMessageTool] In-process teammate ${agentName} approving shutdown - signaling abort`,
    )

    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        task.abortController.abort()
        logForDebugging(
          `[SendMessageTool] Aborted controller for in-process teammate ${agentName}`,
        )
      } else {
        logForDebugging(
          `[SendMessageTool] Warning: Could not find task/abortController for ${agentName}`,
        )
      }
    }
  } else {
    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        logForDebugging(
          `[SendMessageTool] Fallback: Found in-process task for ${agentName} via AppState, aborting`,
        )
        task.abortController.abort()

        return {
          data: {
            success: true,
            message: `Shutdown approved (fallback path). Agent ${agentName} is now exiting.`,
            request_id: requestId,
          },
        }
      }
    }

    // setImmediate ≈ 把任务排到下一个事件循环（近似 Java 的 executor.submit 立刻返回）。
    // 目的：让本函数能先把返回值交出去，进程退出发生在之后，避免响应丢失。
    setImmediate(async () => {
      await gracefulShutdown(0, 'other')
    })
  }

  return {
    data: {
      success: true,
      message: `Shutdown approved. Sent confirmation to team-lead. Agent ${agentName} is now exiting.`,
      request_id: requestId,
    },
  }
}

/**
 * 【协议消息③】teammate 拒绝停机。
 *
 * 为什么需要：协商式停机的另一半——如果 agent 手上有没干完的活，
 * 它有权说"不"，并给出理由（reason 是必填的，validateInput 里强制校验）。
 *
 * @param requestId 被拒绝的那次请求 id。
 * @param reason    拒绝理由（会原样转给 team-lead，让他知道为什么还没停）。
 * @returns `{ data: ResponseOutput }`。注意：**不会**停掉自己，只回一条消息。
 *
 * 关键步骤：
 *   ① 组装 shutdown_rejected 消息
 *   ② 写给 TEAM_LEAD_NAME（固定收件人：响应类消息只能发给 lead）
 *   ③ 返回成功，本机继续工作
 */
async function handleShutdownRejection(
  requestId: string,
  reason: string,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentName = getAgentName() || 'teammate'

  const rejectedMessage = createShutdownRejectedMessage({
    requestId,
    from: agentName,
    reason,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(rejectedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown rejected. Reason: "${reason}". Continuing to work.`,
      request_id: requestId,
    },
  }
}

/**
 * 【协议消息④】team-lead 批准某个 teammate 提交的计划。
 *
 * 为什么需要：在 plan mode 下，子 agent 写完计划不能自己开工，要 lead 点头。
 * 这就是那条"点头"消息，同时会把 lead 当前的权限模式一并传给对方（modeToInherit）。
 *
 * @param recipientName 被批准的那个 agent 的名字。
 * @param requestId     对方发起计划审批时的 request_id。
 * @param context       工具上下文（取 teamContext、权限模式）。
 * @returns `{ data: ResponseOutput }`。
 *
 * 关键步骤：
 *   ① 权限校验：只有 isTeamLead() 才能批准，否则抛错（防越权）
 *   ② 决定要"遗传"给对方的权限模式：如果 lead 自己就在 plan 模式，
 *      则给对方 'default'（否则对方批了也还是不能写文件，等于白批准）
 *   ③ 把 approval 消息写进对方信箱
 */
async function handlePlanApproval(
  recipientName: string,
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  // 越权防护：teammate 不能批准自己或别人的计划，这个动作只有 team-lead 能做。
  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can approve plans. Teammates cannot approve their own or other plans.',
    )
  }

  const leaderMode = appState.toolPermissionContext.mode
  // 权限模式的"遗传"规则：lead 在 plan 模式时不能把 plan 模式传给对方，
  // 否则对方拿到批准后依然只能只读 —— 那就成了永远走不出去的死循环。
  // 所以降级成 'default'，让对方真能动手改代码。
  const modeToInherit = leaderMode === 'plan' ? 'default' : leaderMode

  const approvalResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: true,
    timestamp: new Date().toISOString(),
    permissionMode: modeToInherit,
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(approvalResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan approved for ${recipientName}. They will receive the approval and can proceed with implementation.`,
      request_id: requestId,
    },
  }
}

/**
 * 【协议消息⑤】team-lead 打回某个 teammate 的计划，并附修改意见。
 *
 * 为什么需要：和批准成对出现。打回不是"拒绝就完了"，必须带上 feedback，
 * 否则对方不知道怎么改，只会原样再提交一次。
 *
 * @param recipientName 被打回的 agent 名字。
 * @param requestId     对应的 request_id。
 * @param feedback      具体的修改意见（会原样送到对方信箱）。
 * @param context       工具上下文（取 teamContext）。
 * @returns `{ data: ResponseOutput }`。
 *
 * 关键步骤：
 *   ① 同样是 team-lead 专属动作，先做越权校验
 *   ② 组装 approved:false 的响应，带上 feedback
 *   ③ 写入对方信箱；对方下一轮会读到并据此改计划
 */
async function handlePlanRejection(
  recipientName: string,
  requestId: string,
  feedback: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can reject plans. Teammates cannot reject their own or other plans.',
    )
  }

  const rejectionResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: false,
    feedback,
    timestamp: new Date().toISOString(),
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(rejectionResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan rejected for ${recipientName} with feedback: "${feedback}"`,
      request_id: requestId,
    },
  }
}

/**
 * SendMessageTool 本体：用 buildTool() 把上面的 handler 组装成一个「工具对象」。
 *
 * buildTool 做了什么（见 src/Tool.ts）：把我们这里写的部分实现，
 * 和一堆缺省实现（isEnabled → true、checkPermissions → allow 等）合并，
 * 补齐成一个完整的 Tool。≈ Java 的 Builder + 一堆默认方法。
 *
 * 下面这些字段按「谁在什么时候调用」理解会清楚很多：
 *   name / searchHint / shouldDefer / inputSchema   → 决定模型怎么发现、怎么用这个工具
 *   isEnabled / isReadOnly                          → 决定能不能用、要不要走权限
 *   validateInput                                   → 执行前的参数校验（返回结构化错误给模型重试）
 *   checkPermissions                                → 要不要弹框问用户
 *   call                                            → 真正干活
 *   mapToolResultToToolResultBlockParam              → 把返回值包成 API 要的 tool_result
 *   renderToolUseMessage / renderToolResultMessage    → 终端 UI 渲染（在 UI.tsx）
 */
export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    // 工具名：模型在 tool_use 块里写的就是它。放在 constants.ts 是为了让
    // 其它模块（权限规则、UI、测试）引用同一个常量，避免字符串散落各处。
    name: SEND_MESSAGE_TOOL_NAME,
    // searchHint：一句话能力描述。因为下面 shouldDefer = true（延迟加载），
    // 模型一开始看不到完整 schema，只能靠这句话在 ToolSearch 里"搜"到本工具。
    searchHint: 'send messages to agent teammates (swarm protocol)',
    // 结果超过 10 万字符就落盘（只回一个文件路径 + 预览），防止一次大输出撑爆上下文。
    maxResultSizeChars: 100_000,

    // 给用户看的名字（可以和 name 不同）；这里是同一个词但带了驼峰，纯展示用。
    userFacingName() {
      return 'SendMessage'
    },

    // getter 写法：`get inputSchema()` —— 每次访问时才调用 inputSchema()。
    // 配合 lazySchema 实现真正的懒加载：不用这个工具就永远不构造 schema。
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    // 延迟加载：prompt 里只放一个占位，模型想用必须先 ToolSearch 一轮。
    // 目的：工具越来越多（尤其挂了大量 MCP 服务器后），全量 schema 会吃掉大量
    // 上下文 token。本工具只在开启 swarm 时才可能用到，非常适合 defer。
    shouldDefer: true,

    // 只有开启了 agent swarms（多 agent 协作）才注册这个工具。
    // 单 agent 场景下它纯属噪声，还会诱导模型"幻想出队友"。
    isEnabled() {
      return isAgentSwarmsEnabled()
    },

    // isReadOnly = 这条调用会不会产生副作用。发纯文本消息只是往信箱追加一条，
    // 不改动用户的代码/文件，所以算只读（可以免权限弹框直接放行）。
    // 而结构化消息（尤其是停机）会真的终止一个 agent，那就不是只读了。
    isReadOnly(input) {
      return typeof input.message === 'string'
    },

    /**
     * 给「别人看的入参副本」补字段：把嵌套的 message 拍平成 UI / hook / SDK 好读的形式。
     *
     * 为什么需要：原始入参是 `{to, message: {type, request_id, approve}}` 这种嵌套结构，
     * 直接给终端渲染或 hook 看很不友好。这里补出 type / recipient / request_id 等顶层字段。
     *
     * ⚠️ 两个硬约束（写在 src/Tool.ts 的契约里）：
     *   1. 只能改**副本**，绝不能改原始入参 —— 原始入参是要发给 API 的字节，
     *      改了就会破坏 prompt cache（缓存要求字节级一致）。
     *   2. 必须**幂等**（所以开头就 `if ('type' in input) return`，避免重复施加）。
     *
     * @param input 入参对象（已经是副本），就地修改，无返回值。
     */
    backfillObservableInput(input) {
      if ('type' in input) return
      if (typeof input.to !== 'string') return

      if (input.to === '*') {
        input.type = 'broadcast'
        if (typeof input.message === 'string') input.content = input.message
      } else if (typeof input.message === 'string') {
        input.type = 'message'
        input.recipient = input.to
        input.content = input.message
      } else if (typeof input.message === 'object' && input.message !== null) {
        const msg = input.message as {
          type?: string
          request_id?: string
          approve?: boolean
          reason?: string
          feedback?: string
        }
        input.type = msg.type
        input.recipient = input.to
        if (msg.request_id !== undefined) input.request_id = msg.request_id
        if (msg.approve !== undefined) input.approve = msg.approve
        // `??` 在这里是"两者取其一"：停机拒绝填的是 reason，计划打回填的是 feedback，
        // 不同协议消息用的字段名不同，统一收进 content 供 UI 展示。
        // 注意用 `??` 而不是 `||`：reason 是空字符串 '' 时也应该被保留（不会被换成 feedback）。
        const content = msg.reason ?? msg.feedback
        if (content !== undefined) input.content = content
      }
    },

    /**
     * 给 auto 模式的「安全分类器」看的一句话摘要。
     *
     * 为什么需要：auto 模式下 Claude Code 会用一个小模型判断"这次工具调用危险吗"。
     * 这里把入参压成一句人话（如 `shutdown_request to researcher`），
     * 让分类器能一眼看懂这次发消息是要干什么 —— 尤其是停机这种高危动作。
     */
    toAutoClassifierInput(input) {
      if (typeof input.message === 'string') {
        return `to ${input.to}: ${input.message}`
      }
      switch (input.message.type) {
        case 'shutdown_request':
          return `shutdown_request to ${input.to}`
        case 'shutdown_response':
          return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
        case 'plan_approval_response':
          return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${input.to}`
      }
    },

    /**
     * 权限检查：这次调用要不要先问用户。
     *
     * 绝大多数情况直接 allow —— 发消息本身不危险。
     * 唯独一种例外：**跨机器的 bridge 消息**（发给另一台机器上的 Claude）。
     * 那条消息会经过 Anthropic 的服务器，以「用户 prompt」的形式出现在对端，
     * 本质上是一次跨机器的 prompt injection 通道，所以必须显式征得用户同意。
     *
     * @returns `{behavior:'ask'}` 弹框询问 / `{behavior:'allow'}` 直接放行。
     *
     * 注意 decisionReason 里写的是 'safetyCheck' 而不是 'mode'：
     * 权限系统里 safetyCheck 级别**无法被 bypassPermissions 或 auto 白名单绕过**，
     * 即"免疫绕过"，是刻意设计的安全兜底。
     */
    async checkPermissions(input, _context) {
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        return {
          behavior: 'ask' as const,
          message: `Send a message to Remote Control session ${input.to}? It arrives as a user prompt on the receiving Claude (possibly another machine) via Anthropic's servers.`,
          // safetyCheck (not mode) — permissions.ts guards this before both
          // bypassPermissions (step 1g) and auto-mode's allowlist/classifier.
          // Cross-machine prompt injection must stay bypass-immune.
          decisionReason: {
            type: 'safetyCheck',
            reason:
              'Cross-machine bridge message requires explicit user consent',
            classifierApprovable: false,
          },
        }
      }
      // 其它所有情况：直接放行（发消息给本团队的 teammate 属于常规协作动作）。
      return { behavior: 'allow' as const, updatedInput: input }
    },

    /**
     * 执行前的参数校验。返回 `{result:false, message, errorCode}` 时，
     * message 会原样喂回给模型 —— 所以这里的文案就是"给模型的报错提示"，
     * 写得越具体，模型下一次越可能自己改对（≈ Java 里抛带明确信息的 IllegalArgumentException）。
     *
     * 各个校验的顺序是有讲究的：**永久性的约束排在临时性的前面**。
     * 例如 bridge 场景先判"结构化消息不能跨会话"（永久不行），
     * 再判"Remote Control 没连上"（临时状态）。否则用户会先去重连，
     * 重连完又撞上一个永远过不去的错误，白白浪费一轮。
     *
     * @param input    模型给出的入参（已过 zod）。
     * @param _context 未使用；下划线前缀是 TS 里"我故意不用这个参数"的惯例，
     *                 用来绕过 lint 的 unused 告警（Java 里只能靠 @SuppressWarnings）。
     */
    async validateInput(input, _context) {
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to must not be empty',
          errorCode: 9,
        }
      }
      const addr = parseAddress(input.to)
      if (
        (addr.scheme === 'bridge' || addr.scheme === 'uds') &&
        addr.target.trim().length === 0
      ) {
        return {
          result: false,
          message: 'address target must not be empty',
          errorCode: 9,
        }
      }
      // 禁止 "name@team" 这种写法：一个会话只会有一个团队，带 @ 纯属多余且易歧义。
      if (input.to.includes('@')) {
        return {
          result: false,
          message:
            'to must be a bare teammate name or "*" — there is only one team per session',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        // Structured-message rejection first — it's the permanent constraint.
        // Showing "not connected" first would make the user reconnect only to
        // hit this error on retry.
        if (typeof input.message !== 'string') {
          return {
            result: false,
            message:
              'structured messages cannot be sent cross-session — only plain text',
            errorCode: 9,
          }
        }
        // postInterClaudeMessage derives from= via getReplBridgeHandle() —
        // check handle directly for the init-timing window. Also check
        // isReplBridgeActive() to reject outbound-only (CCR mirror) mode
        // where the bridge is write-only and peer messaging is unsupported.
        if (!getReplBridgeHandle() || !isReplBridgeActive()) {
          return {
            result: false,
            message:
              'Remote Control is not connected — cannot send to a bridge: target. Reconnect with /remote-control first.',
            errorCode: 9,
          }
        }
        return { result: true }
      }
      if (
        feature('UDS_INBOX') &&
        parseAddress(input.to).scheme === 'uds' &&
        typeof input.message === 'string'
      ) {
        // UDS cross-session send: summary isn't rendered (UI.tsx returns null
        // for string messages), so don't require it. Structured messages fall
        // through to the rejection below.
        return { result: true }
      }
      if (typeof input.message === 'string') {
        if (!input.summary || input.summary.trim().length === 0) {
          return {
            result: false,
            message: 'summary is required when message is a string',
            errorCode: 9,
          }
        }
        return { result: true }
      }

      if (input.to === '*') {
        return {
          result: false,
          message: 'structured messages cannot be broadcast (to: "*")',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme !== 'other') {
        return {
          result: false,
          message:
            'structured messages cannot be sent cross-session — only plain text',
          errorCode: 9,
        }
      }

      // 拒绝停机必须给理由，否则 team-lead 不知道对方为什么还活着，
      // 只能反复重试发停机请求（这个校验就是为了避免这种空转）。
      if (
        input.message.type === 'shutdown_response' &&
        input.to !== TEAM_LEAD_NAME
      ) {
        return {
          result: false,
          message: `shutdown_response must be sent to "${TEAM_LEAD_NAME}"`,
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        !input.message.approve &&
        (!input.message.reason || input.message.reason.trim().length === 0)
      ) {
        return {
          result: false,
          message: 'reason is required when rejecting a shutdown request',
          errorCode: 9,
        }
      }

      return { result: true }
    },

    // 给 UI / 文档看的一句话描述（常量在 prompt.ts）。
    async description() {
      return DESCRIPTION
    },

    // 给**模型**看的完整使用说明（常量在 prompt.ts）。注意它是 async：
    // 生成 prompt 可能需要读文件 / 拼装，所以框架允许异步。
    async prompt() {
      return getPrompt()
    },

    /**
     * 把返回值转成 API 协议要求的 tool_result 块。
     *
     * 为什么需要：我们的 data 是任意 JS 对象，而 Claude API 要求严格的
     * `{ tool_use_id, type: 'tool_result', content: [{type:'text', text}] }` 形状。
     * 这里是"内部表示 → 协议表示"的最后一公里。
     *
     * @param data       call() 返回的 data。
     * @param toolUseID  模型那次 tool_use 的 id，必须原样回传才能对上号。
     */
    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(data),
          },
        ],
      }
    },

    /**
     * 工具的主体：路由分发（详见本文件头的「路由表」）。
     *
     * @param input     已通过 zod + validateInput 的入参。
     * @param context   运行时上下文（AppState、权限、取消信号等都挂在上面）。
     * @param canUseTool 权限回调：唤醒子 agent 后还要继续跑工具时，用它再问一次权限。
     * @param assistantMessage 触发这次调用的模型消息（主要用来取 requestId 做链路追踪）。
     * @returns 各 handler 返回的 `{ data: ... }`。
     *
     * 读法建议：不要从上往下顺序读，先记住 5 条路由（见文件头），
     * 再跳到对应 handler 看细节。call() 本身只是一张分发表。
     */
    async call(input, context, canUseTool, assistantMessage) {
      // ── 路由①：跨会话发送（bridge: 跨机器 / uds: 同机跨进程）──────────────
      // 这一整块被 feature('UDS_INBOX') 包着：编译期开关关掉时，打包阶段
      // 会被整段删掉，运行时连这个模块都不会被加载。
      if (feature('UDS_INBOX') && typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (addr.scheme === 'bridge') {
          // Re-check handle — checkPermissions blocks on user approval (can be
          // minutes). validateInput's check is stale if the bridge dropped
          // during the prompt wait; without this, from="unknown" ships.
          // Also re-check isReplBridgeActive for outbound-only mode.
          if (!getReplBridgeHandle() || !isReplBridgeActive()) {
            return {
              data: {
                success: false,
                message: `Remote Control disconnected before send — cannot deliver to ${input.to}`,
              },
            }
          }
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { postInterClaudeMessage } =
            require('../../bridge/peerSessions.js') as typeof import('../../bridge/peerSessions.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          const result = await postInterClaudeMessage(
            addr.target,
            input.message,
          )
          const preview = input.summary || truncate(input.message, 50)
          return {
            data: {
              success: result.ok,
              message: result.ok
                ? `“${preview}” → ${input.to}`
                : `Failed to send to ${input.to}: ${result.error ?? 'unknown'}`,
            },
          }
        }
        // Unix Domain Socket：同机另一个 Claude 进程监听的 socket 文件，直连发送。
        if (addr.scheme === 'uds') {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { sendToUdsSocket } =
            require('../../utils/udsClient.js') as typeof import('../../utils/udsClient.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          try {
            await sendToUdsSocket(addr.target, input.message)
            const preview = input.summary || truncate(input.message, 50)
            return {
              data: {
                success: true,
                message: `“${preview}” → ${input.to}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Failed to send to ${input.to}: ${errorMessage(e)}`,
              },
            }
          }
        }
      }

      // ── 路由②：本进程内的子 agent（AgentTool 派生出来的那种）──────────────
      // 这种情况不需要写磁盘信箱 —— 发送方和接收方在同一个进程里，
      // 直接把消息塞进对方任务的"待收队列"即可，零 IO、立刻生效。
      // Route to in-process subagent by name or raw agentId before falling
      // through to ambient-team resolution. Stopped agents are auto-resumed.
      if (typeof input.message === 'string' && input.to !== '*') {
        const appState = context.getAppState()
        const registered = appState.agentNameRegistry.get(input.to)
        const agentId = registered ?? toAgentId(input.to)
        if (agentId) {
          const task = appState.tasks[agentId]
          if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
            // 目标正在跑：塞进 pending 队列，它跑到下一轮工具回合时会读到。
            // （这就是"异步消息"的字面实现：投递成功 ≠ 已被处理）
            if (task.status === 'running') {
              queuePendingMessage(
                agentId,
                input.message,
                context.setAppStateForTasks ?? context.setAppState,
              )
              return {
                data: {
                  success: true,
                  message: `Message queued for delivery to ${input.to} at its next tool round.`,
                },
              }
            }
            // 目标任务存在但已经停了（completed / stopped）。
            // task exists but stopped — auto-resume
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId,
              })
              return {
                data: {
                  success: true,
                  message: `Agent "${input.to}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: `Agent "${input.to}" is stopped (${task.status}) and could not be resumed: ${errorMessage(e)}`,
                },
              }
            }
          // 任务已经从 AppState 里被回收了（比如内存压力下被清理），
          // 但磁盘上还留着 transcript —— 尝试从 transcript 恢复再投递。
          // 这是"尽力而为"的兜底：恢复不了就如实告诉模型，让它换个办法。
          } else {
            // task evicted from state — try resume from disk transcript.
            // agentId is either a registered name or a format-matching raw ID
            // (toAgentId validates the createAgentId format, so teammate names
            // never reach this block).
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId,
              })
              return {
                data: {
                  success: true,
                  message: `Agent "${input.to}" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: `Agent "${input.to}" is registered but has no transcript to resume. It may have been cleaned up. (${errorMessage(e)})`,
                },
              }
            }
          }
        }
      }

      // ── 路由③④：纯文本消息（群发 / 单发）──────────────────────────────
      if (typeof input.message === 'string') {
        if (input.to === '*') {
          return handleBroadcast(input.message, input.summary, context)
        }
        return handleMessage(input.to, input.message, input.summary, context)
      }

      // 结构化（协议）消息不允许群发：协议消息都是"一对一协商"，
      // 广播给所有人没有语义（谁的停机请求？谁的计划？）。
      if (input.to === '*') {
        throw new Error('structured messages cannot be broadcast')
      }

      // ── 路由⑤：结构化协议消息 ─────────────────────────────────────────
      // switch 作用在联合类型上，编译器会做穷尽性检查：
      // 少写一个 case 会直接编译报错（≈ Java sealed interface 的 switch 穷尽匹配）。
      switch (input.message.type) {
        case 'shutdown_request':
          return handleShutdownRequest(input.to, input.message.reason, context)
        case 'shutdown_response':
          if (input.message.approve) {
            return handleShutdownApproval(input.message.request_id, context)
          }
          return handleShutdownRejection(
            input.message.request_id,
            // `!` 非空断言：validateInput 已经保证"拒绝时必须带 reason"，
            // 但编译器看不出来（它不知道运行时校验过了），所以这里显式担保一次。
            // ≈ Java 的强制类型转换，运行时不做检查，纯属骗编译器。
            input.message.reason!,
          )
        case 'plan_approval_response':
          if (input.message.approve) {
            return handlePlanApproval(
              input.to,
              input.message.request_id,
              context,
            )
          }
          return handlePlanRejection(
            input.to,
            input.message.request_id,
            input.message.feedback ?? 'Plan needs revision',
            context,
          )
      }
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
