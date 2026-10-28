/**
 * ============================================================================
 *  【文件总览】src/tools/RemoteTriggerTool/prompt.ts
 *              —— RemoteTrigger 工具的「对外文案与命名」集中地
 * ============================================================================
 *
 *  一句话定位：
 *  本文件只导出三个常量字符串，是与模型 / 用户打交道的**全部文案**：
 *  工具叫什么名字、在工具列表里怎么自我介绍、给模型的详细使用说明写什么。
 *  一个字的可执行逻辑都没有。
 *
 *  为什么要单独拆一个 prompt.ts？
 *      · 文案改动频繁，和逻辑混在一起会污染 git diff；
 *      · 别的模块只想引用「工具名 / 工具描述」时，不必被迫加载整个工具实现
 *        （src/tools.ts、常量表、IME 补全等地方经常只想要名字）；
 *      · 避免循环依赖：工具实现 import 文案，文案不 import 任何东西。
 *  这也是 src/tools/ 下每个工具的惯用结构。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】谁在用这三个常量
 * ---------------------------------------------------------------------------
 *
 *      prompt.ts（★ 本文件，最底层，无依赖）
 *        ├─> RemoteTriggerTool.ts   用 REMOTE_TRIGGER_TOOL_NAME / DESCRIPTION / PROMPT
 *        └─> UI.tsx                 间接通过工具的 Input/Output 类型渲染
 *
 *      而 RemoteTriggerTool 又被 src/tools.ts 注册进全局工具表，
 *      最终出现在发给模型的 system prompt 的工具列表里。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】就三个导出常量
 * ---------------------------------------------------------------------------
 *   1. REMOTE_TRIGGER_TOOL_NAME —— 工具名 'RemoteTrigger'，模型发起调用时用的标识
 *   2. DESCRIPTION              —— 给用户看的简短说明（工具列表、权限弹窗）
 *   3. PROMPT                   —— 给模型看的完整使用手册（会拼进 system prompt）
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `export const X = '...'`：导出一个常量。const 只保证「引用不可再赋值」，
 *    对字符串来说即内容固定。≈ Java 的 `public static final String X = "..."`。
 *  - `as const` 没写在这里，但值得知道：如果写 `export const X = 'a' as const`，
 *    类型会收窄成字面量 'a' 而不是 string。本文件的常量没加 as const，
 *    所以类型就是普通的 string。
 *  - 反引号 `` ` `` 包起来的叫**模板字符串**：可以跨多行书写，
 *    这里 PROMPT 用它写了一整段多行说明，省掉一堆 \n 拼接。
 *    ≈ Java 15+ 的文本块（Text Block，三个双引号那种），写法几乎一样。
 *  - Windows vs Unix 换行：模板字符串里的换行会原样保留（取决于文件本身的换行符），
 *    所以这段多行文案最终就是模型看到的样子。
 *
 * ---------------------------------------------------------------------------
 *  【文案本身的门道】（为什么 PROMPT 要这么写）
 * ---------------------------------------------------------------------------
 *  注意 PROMPT 第一句就强调 "Use this instead of curl —— the OAuth token is
 *  added automatically in-process and never exposed"：
 *  这是在**主动干预模型的行为倾向**。模型受训时见过海量 curl 调 API 的例子，
 *  默认很容易窜去写 Bash(curl ...)。这里明确给它一个更好的路径，
 *  既省事又避免 token 泄露到 shell 历史里。
 *  后半段罗列的 5 个 action 与 HTTP 路径一一对应，
 *  等于是一份「人话版的接口文档」，让模型能自己决定用哪个 action。
 *
 * ============================================================================
 */
export const REMOTE_TRIGGER_TOOL_NAME = 'RemoteTrigger'

// 给用户/工具列表看的短描述。特意点明 "Auth is handled in-process ——
// the token never reaches the shell"，让用户知道这个工具比自己 curl 更安全。
export const DESCRIPTION =
  'Manage scheduled remote Claude Code agents (triggers) via the claude.ai CCR API. Auth is handled in-process — the token never reaches the shell.'

// 给模型看的详细使用手册（会被 src/Tool.ts 的渲染逻辑拼进 system prompt）。
// 内容刻意写成一份「接口清单」的形态：
// 每个 action 一行、配上对应 HTTP 方法与路径，模型就能照着它对号入座。
export const PROMPT = `Call the claude.ai remote-trigger API. Use this instead of curl — the OAuth token is added automatically in-process and never exposed.

Actions:
- list: GET /v1/code/triggers
- get: GET /v1/code/triggers/{trigger_id}
- create: POST /v1/code/triggers (requires body)
- update: POST /v1/code/triggers/{trigger_id} (requires body, partial update)
- run: POST /v1/code/triggers/{trigger_id}/run

The response is the raw JSON from the API.`
