/**
 * ============================================================================
 *  【文件总览】src/tools/SendMessageTool/prompt.ts
 *              —— SendMessage 工具的「自我说明书」（喂给模型看的那段文字）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件只做一件事：拼出一段 Markdown 文本，告诉模型「SendMessage 怎么用」。
 *  它不含任何业务逻辑，纯粹是**提示词（prompt）内容**。
 *
 *  【在架构中的位置】
 *      SendMessageTool.prompt()           ← src/tools/SendMessageTool/SendMessageTool.ts
 *        └─> getPrompt()                  ← ★ 本文件
 *      DESCRIPTION 常量同理，被 SendMessageTool.description() 取用。
 *
 *      为什么要把 prompt 单独拆一个文件？两个原因：
 *        1. 这段文本很长（几十行），混在逻辑代码里会淹没真正的逻辑；
 *        2. prompt 需要经常改（调模型行为属于"调参"），隔离后改动风险低。
 *
 *  【本文件包含什么】
 *   1. DESCRIPTION        一句话描述，给 UI / 工具列表用
 *   2. getPrompt()        完整使用说明（含一张 to 的取值表 + 旧协议说明）
 *
 *  【注意：这里的英文是给模型看的，不是给人看的】
 *  你会看到大量英文，且**不能翻译**——翻译了模型就不认识了。
 *  本文件的中文注释是给你（Java 工程师读者）解释「这句话为什么要写」的。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - 模板字符串 `` `...${x}...` ``：≈ Java 的文本块（Java 15+ 的 """）或 String.format，
 *    可以换行、可以内嵌 ${} 表达式。本文件整段 prompt 就是一个大模板字符串。
 *  - `feature('UDS_INBOX') ? A : ''` 三元表达式：编译期开关。
 *    开关关掉时这段内容被替换成空串，打包时整段消失（DCE）。
 *    ≈ C 的 `#ifdef` / `#endif`。
 *  - `.trim()`：去掉首尾空白（和 Java 的 String.trim() 一样）。
 *    本文件末尾调用一次，是为了让 prompt 以 # 开头、不留多余空行。
 */
import { feature } from 'bun:bundle'

// 一句话工具描述：给 UI 的工具列表 / 权限弹框显示用（简短）。
export const DESCRIPTION = 'Send a message to another agent'

/**
 * 生成 SendMessage 工具的完整使用说明（给模型看的 prompt）。
 *
 * 为什么需要：模型并不知道 SendMessage 的存在与用法，全靠这段文字教它。
 * 里面特意写清了几条容易被模型搞错的规则：
 *   - 你的普通输出对别的 agent **不可见**，想沟通必须调这个工具
 *   - 引用队友要用名字，**不要**用 UUID（UUID 模型容易记错）
 *   - 转述时不要原文照抄（原文已经渲染给用户看过了，重复会浪费上下文）
 *   - 广播很贵（消息数与团队规模成正比），别滥用
 *
 * @returns 一段 Markdown 文本，会被塞进系统提示词里。
 *
 * 关键步骤：
 *   ① 按 feature('UDS_INBOX') 决定要不要追加"跨会话地址"那两行表格
 *   ② 按同一个开关决定要不要追加"Cross-session"整节
 *   ③ 拼进主模板并 trim 后返回
 */
export function getPrompt(): string {
  // 编译期开关：只在开启 UDS_INBOX（跨会话收件箱）时才把这两种地址写进表格。
  // 关掉时这里是空串，表格里就不会出现模型用不了的地址 —— 避免模型瞎试。
  const udsRow = feature('UDS_INBOX')
    ? `\n| \`"uds:/path/to.sock"\` | Local Claude session's socket (same machine; use \`ListPeers\`) |
| \`"bridge:session_..."\` | Remote Control peer session (cross-machine; use \`ListPeers\`) |`
    : ''
  // 跨会话使用的完整说明。核心一句："要回复就把它消息里的 from 抄到你的 to"。
  // 这是在教模型怎么回信 —— 跨会话场景下没有"当前会话"的概念，只能靠 from 寻址。
  const udsSection = feature('UDS_INBOX')
    ? `\n\n## Cross-session

Use \`ListPeers\` to discover targets, then:

\`\`\`json
{"to": "uds:/tmp/cc-socks/1234.sock", "message": "check if tests pass over there"}
{"to": "bridge:session_01AbCd...", "message": "what branch are you on?"}
\`\`\`

A listed peer is alive and will process your message — no "busy" state; messages enqueue and drain at the receiver's next tool round. Your message arrives wrapped as \`<cross-session-message from="...">\`. **To reply to an incoming message, copy its \`from\` attribute as your \`to\`.**`
    : ''
  // 返回整段 prompt。最后 .trim() 去掉首尾空行，保证输出的第一个字符就是 '#'。
  return `
# SendMessage

Send a message to another agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"*"\` | Broadcast to all teammates — expensive (linear in team size), use only when everyone genuinely needs it |${udsRow}

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from teammates are delivered automatically; you don't check an inbox. Refer to teammates by name, never by UUID. When relaying, don't quote the original — it's already rendered to the user.${udsSection}

## Protocol responses (legacy)

If you receive a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, respond with the matching \`_response\` type — echo the \`request_id\`, set \`approve\` true/false:

\`\`\`json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
\`\`\`

Approving shutdown terminates your process. Rejecting plan sends the teammate back to revise. Don't originate \`shutdown_request\` unless asked. Don't send structured JSON status messages — use TaskUpdate.
`.trim()
}
