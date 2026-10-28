/**
 * ============================================================================
 *  【文件总览】src/tools/ToolSearchTool/prompt.ts —— 工具检索的「说明书 + 判定规则」
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件干两件事：
 *   ① 生成 ToolSearch 工具给模型看的说明书（getPrompt）；
 *   ② 定义**哪些工具该被"延迟加载"**（isDeferredTool）——这其实是整套
 *      ToolSearch 机制的开关所在，是最重要的一个函数。
 *
 * ---------------------------------------------------------------------------
 *  ★★ ToolSearch 到底解决什么问题？★★
 * ---------------------------------------------------------------------------
 *  背景：Claude Code 会接入大量工具。除了自带的 Read/Edit/Bash，
 *  每个 MCP server 还能挂上来几十个工具（github、slack、jira…）。
 *  而**每个工具的 JSON Schema 都要写进系统提示**，一个中等复杂度的
 *  MCP 工具光 schema 就好几百 token。于是出现一个死结：
 *
 *      工具越多 → 系统提示越长 → 上下文被挤占、首轮更贵、模型更容易挑错工具
 *
 *  ToolSearch 的解法：**按需加载（deferred loading）**。
 *      - 平时系统提示里只列出工具**名字**（一行一个，极便宜）；
 *      - 模型觉得要用某个工具时，先调 ToolSearch 检索；
 *      - 检索命中后，客户端才把该工具的**完整 schema** 注入上下文；
 *      - 之后模型就能正常调用它了。
 *
 *  类比 Java 世界：这就像 **ClassLoader 的懒加载 / Spring 的 lazy-init**
 *  ——不在启动时把所有 Bean 都实例化，而是用到谁再初始化谁。
 *
 *  由此引出本文件最关键的函数 isDeferredTool()：
 *  它决定"哪些工具平时藏起来"。规则如下（按顺序判断）：
 *      ① alwaysLoad === true   → **永不延迟**（开发者显式要求常驻）
 *      ② isMcp === true        → **总是延迟**（MCP 工具天然是按场景用的）
 *      ③ 是 ToolSearch 自己    → 永不延迟（否则模型没法加载别的工具，死锁）
 *      ④ Agent / Brief / SendUserFile 等特殊工具 → 永不延迟（有专门理由）
 *      ⑤ shouldDefer === true  → 延迟
 *
 *  【在架构中的位置】
 *
 *      src/Tool.ts（工具注册表）
 *        └─> tools.filter(isDeferredTool)      ← ★ 本文件
 *              ├─> 延迟的：只把名字放进 <available-deferred-tools>
 *              └─> 不延迟的：完整 schema 写进系统提示
 *
 *      src/tools/ToolSearchTool/ToolSearchTool.ts
 *        └─> description / prompt: getPrompt()  ← ★ 本文件
 *
 *  【本文件包含什么】
 *   1. BRIEF_TOOL_NAME / SEND_USER_FILE_TOOL_NAME  条件 require 拿到的工具名
 *   2. getToolLocationHint()   告诉模型"延迟工具的名字在哪能看到"
 *   3. isDeferredTool()        ★核心：判断某工具是否延迟加载
 *   4. formatDeferredToolLine() 把延迟工具渲染成一行文本
 *   5. getPrompt()             拼出完整的工具说明书
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *   - `feature('KAIROS') || feature('KAIROS_BRIEF')`  **编译期**常量。
 *     来自 `bun:bundle`，打包时被替换成 true/false 后再 tree-shaking，
 *     整段代码会从产物里彻底消失 ≈ C 的 `#ifdef`，**不是**运行时 if。
 *     ⚠️ 硬约束：只能用在 if/三元/|| 的**条件位置**，不能先赋给变量再判断，
 *     否则打包器认不出来、代码删不掉。
 *
 *   - `require('...') as typeof import('...')`
 *     **动态 require** + 类型断言。`typeof import('...')` 是"取那个模块的
 *     类型"，让动态加载的模块**仍然有完整类型**——很实用的技巧。
 *     ≈ Java 的 Class.forName() + 强转，但 TS 里类型不丢。
 *     为什么不用静态 import？见下面代码里的说明：避免循环依赖 &&
 *     避免把不该进产物的模块拖进来。
 *
 *   - `const X: string | null = ... : null`  **联合类型**
 *     ≈ Java 的 sealed interface 的两个实现（有值 / 空），但轻量得多。
 *     取值前必须判断是不是 null，否则 TS 报错（这就是"空安全"）。
 *
 *   - `export { TOOL_SEARCH_TOOL_NAME } from './constants.js'`
 *     **转发导出**（re-export）：自己不定义，只是把别处的导出透出去。
 *     好处：调用方只 import 本文件就够了。
 *
 *   - `` const X = `...` ``  **模板字符串**（反引号）：可换行、可 ${} 插值
 *     ≈ Java 15+ 的文本块 `"""..."""`。
 *
 *   - `function f(): string { ... }`  返回类型写在**括号后面**
 *     （Java 写在前面 `String f()`，正好相反）。
 *
 *   - `tool.alwaysLoad === true`  用 `===` 与字面量比较来**收窄类型**：
 *     alwaysLoad 可能是 `boolean | undefined`，判断后 TS 才确信它是 true。
 *
 *   - `getFeatureValue_CACHED_MAY_BE_STALE('key', false)`
 *     读 A/B 实验开关（growthbook）。名字里那串大写强调"**可能是过期的缓存值**"
 *     —— 用命名来警告调用者，这是很地道的做法。
 * ============================================================================
 */
import { feature } from 'bun:bundle'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { Tool } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'

// Dead code elimination: Brief tool name only needed when KAIROS or KAIROS_BRIEF is on
// 中文补充：这两个常量用 require 而不是 import，原因写在文件头：
// 静态 import 会把 BriefTool/SendUserFileTool 整个模块拖进产物，
// 而它们只在 KAIROS 实验开关打开时才需要。用 require + feature 守卫，
// 不开开关时这两个模块连代码都不会被打进去（DCE，死代码消除）。
/* eslint-disable @typescript-eslint/no-require-imports */
// 中文补充：`: string | null` 是联合类型 —— 开关没打开时它就是 null。
// 后面用到它的地方都必须先判断非空，编译器会强制你处理这种情况。
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../BriefTool/prompt.js') as typeof import('../BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('../SendUserFileTool/prompt.js') as typeof import('../SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

// 中文补充：把 constants.ts 里的工具名**转发导出**出去。
// 这样别的模块只要 import 本文件就能同时拿到工具名，
// 少一层依赖。注意 `export { X } from '...'` 编译后不留运行时代码。
export { TOOL_SEARCH_TOOL_NAME } from './constants.js'

import { TOOL_SEARCH_TOOL_NAME } from './constants.js'

// 中文补充：下面三段拼在一起就是完整的工具说明书：
//   PROMPT_HEAD（一句话定位）+ getToolLocationHint()（名字在哪看）+ PROMPT_TAIL（用法）
// 拆成变量是为了中间那段能按实验开关动态变化。
const PROMPT_HEAD = `Fetches full schema definitions for deferred tools so they can be called.

`

// Matches isDeferredToolsDeltaEnabled in toolSearch.ts (not imported —
// toolSearch.ts imports from this file). When enabled: tools announced
// via system-reminder attachments. When disabled: prepended
// <available-deferred-tools> block (pre-gate behavior).
// 中文补充：告诉模型"延迟工具的名字出现在哪里"。
// 注意注释里说的"不能 import" —— toolSearch.ts 反过来 import 了本文件，
// 再 import 它就成**循环依赖**了。所以这里只能把判断逻辑**抄一份**，
// 靠注释提醒两边要同步（这是权衡，不是疏忽）。
function getToolLocationHint(): string {
  const deltaEnabled =
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  return deltaEnabled
    ? 'Deferred tools appear by name in <system-reminder> messages.'
    : 'Deferred tools appear by name in <available-deferred-tools> messages.'
}

const PROMPT_TAIL = ` Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 * A tool is deferred if:
 * - It's an MCP tool (always deferred - workflow-specific)
 * - It has shouldDefer: true
 *
 * A tool is NEVER deferred if it has alwaysLoad: true (MCP tools set this via
 * _meta['anthropic/alwaysLoad']). This check runs first, before any other rule.
 *
 * 中文补充：★ 整套 ToolSearch 机制的核心判定函数 ★
 *
 * 「延迟加载（deferred）」是什么意思？
 *   被判为 deferred 的工具，平时**只把名字**写进系统提示，
 *   不写 JSON Schema。模型必须先调 ToolSearch 检索到它，
 *   客户端才会把完整 schema 注入上下文，之后才能调用。
 *
 * 为什么 MCP 工具一律延迟？
 *   MCP 工具天然是"按场景用"的：接了 github 才会用 github 的工具，
 *   接了 slack 才会用 slack 的。而且一个 MCP server 动辄几十个工具，
 *   全部常驻会把上下文吃光。默认延迟是收益最大的选择。
 *
 * 为什么要有 alwaysLoad 这个"反向逃生门"？
 *   有些 MCP 工具虽然来自 MCP，但用户希望它**永远可用**（比如团队里
 *   最高频的那一个）。MCP server 可以在工具的 _meta 里声明
 *   'anthropic/alwaysLoad' 来强制常驻。
 *
 * 判定顺序（**顺序本身就是设计**，别随意调整）：
 *   ① alwaysLoad === true  → 不延迟（优先级最高，让 MCP 工具能推翻"一律延迟"）
 *   ② isMcp === true       → 延迟
 *   ③ ToolSearch 自己      → 不延迟（否则模型没法加载任何工具，死锁）
 *   ④ Agent / Brief / SendUserFile → 特殊理由不延迟（见各分支注释）
 *   ⑤ shouldDefer === true → 延迟
 *
 * @param tool 要判定的工具
 * @returns true = 需要延迟加载（必须先 ToolSearch 才能用）
 */
export function isDeferredTool(tool: Tool): boolean {
  // Explicit opt-out via _meta['anthropic/alwaysLoad'] — tool appears in the
  // initial prompt with full schema. Checked first so MCP tools can opt out.
  // 中文补充：这一条必须放在**最前面**——否则下面的"MCP 一律延迟"会
  // 把它盖掉，MCP 工具的 opt-out 就失效了。顺序即语义。
  if (tool.alwaysLoad === true) return false

  // MCP tools are always deferred (workflow-specific)
  if (tool.isMcp === true) return true

  // Never defer ToolSearch itself — the model needs it to load everything else
  // 中文补充：这是**防死锁**的关键一行。ToolSearch 自己要是也被延迟了，
  // 模型就没有任何手段把它加载进来 —— 整个按需加载体系直接瘫痪。
  // 类似"引导类加载器不能是被自己加载的"。
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // Fork-first experiment: Agent must be available turn 1, not behind ToolSearch.
  // Lazy require: static import of forkSubagent → coordinatorMode creates a cycle
  // through constants/tools.ts at module init.
  // 中文补充：Agent 工具（起子 agent）要求"第一轮就能用"。
  // 原因：如果模型想派子任务，还得先检索再使用，会多一轮往返，
  // 在 fork-first 实验里这个延迟不可接受。
  // 这里用 require 而非 import，是因为静态 import 会造成**模块初始化期
  // 的循环依赖**（forkSubagent → coordinatorMode → constants/tools.ts → 回到本文件）。
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    // 中文补充：`typeof import('...')` 取的是模块的**类型**。
    // 这样即使运行时用 require 动态加载，编译期依然有完整的类型检查。
    type ForkMod = typeof import('../AgentTool/forkSubagent.js')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('../AgentTool/forkSubagent.js') as ForkMod
    if (m.isForkSubagentEnabled()) return false
  }

  // Brief is the primary communication channel whenever the tool is present.
  // Its prompt contains the text-visibility contract, which the model must
  // see without a ToolSearch round-trip. No runtime gate needed here: this
  // tool's isEnabled() IS isBriefEnabled(), so being asked about its deferral
  // status implies the gate already passed.
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    BRIEF_TOOL_NAME &&
    tool.name === BRIEF_TOOL_NAME
  ) {
    return false
  }

  // SendUserFile is a file-delivery communication channel (sibling of Brief).
  // Must be immediately available without a ToolSearch round-trip.
  if (
    feature('KAIROS') &&
    SEND_USER_FILE_TOOL_NAME &&
    tool.name === SEND_USER_FILE_TOOL_NAME &&
    isReplBridgeActive()
  ) {
    return false
  }

  // 中文补充：兜底规则 —— 工具自己在定义里声明 shouldDefer: true 才延迟。
  // 也就是说：**默认不延迟**，延迟是必须显式声明的（安全默认值）。
  return tool.shouldDefer === true
}

/**
 * Format one deferred-tool line for the <available-deferred-tools> user
 * message. Search hints (tool.searchHint) are not rendered — the
 * hints A/B (exp_xenhnnmn0smrx4, stopped Mar 21) showed no benefit.
 * 中文补充：把延迟工具渲染成系统提示里的一行。现在只输出**名字**，
 * 曾经试过连 searchHint（一句话能力说明）一起输出，
 * 但 A/B 实验（编号 exp_xenhnnmn0smrx4，3 月 21 日停止）证明没收益，
 * 于是又退回了只输出名字——省钱省 token。
 *
 * @param tool 一个延迟加载的工具
 * @returns 一行文本（目前就是工具名）
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

/**
 * 拼出 ToolSearch 工具给模型看的**完整说明书**。
 *
 * 为什么需要写得这么细：模型必须理解"有些工具我现在只知道名字、
 * 得先检索才能用"这件事，否则它会拿着名字直接调用然后报错。
 * 说明书里明确写了三种查询写法（select: / 关键词 / +前缀），
 * 并解释了返回结果里 <functions> 块的含义。
 *
 * @returns 完整的工具描述文本
 */
export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}
