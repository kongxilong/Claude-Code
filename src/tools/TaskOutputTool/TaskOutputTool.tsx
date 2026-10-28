/**
 * ============================================================================
 *  【文件总览】src/tools/TaskOutputTool/TaskOutputTool.tsx
 *              —— 取回后台任务的输出（后台任务的"取件窗口"）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 TaskOutput 工具：给一个**后台任务**的 id，把它的输出取回来。
 *
 *  【★ 先分清两拨"任务"，这是本仓库最容易混淆的地方】
 *
 *    ┌────────────────┬───────────────────────────┬─────────────────────────────┐
 *    │                │ TaskCreate/List/Get/Update │ TaskOutput / TaskStop       │
 *    ├────────────────┼───────────────────────────┼─────────────────────────────┤
 *    │ 是什么         │ 待办清单（TODO item）      │ 真正在后台跑的东西          │
 *    │ 存在哪         │ 磁盘 JSON 文件             │ AppState.tasks（内存）      │
 *    │ 跨进程共享吗   │ 是（团队共享同一批文件）   │ 否（进程没了就没了）        │
 *    │ 典型例子       │ "修复登录 bug"             │ 后台 bash、异步子 agent     │
 *    └────────────────┴───────────────────────────┴─────────────────────────────┘
 *
 *  本文件取的是后者的输出。后台任务有三种类型（TaskType）：
 *    local_bash     后台跑的 shell 命令（BashTool 加 run_in_background）
 *    local_agent    本进程内的异步子 agent（AgentTool 加 run_in_background）
 *    remote_agent   远程会话里的 agent
 *
 *  【输出是怎么取回来的？——两条路径】
 *  ① **内存路径**（优先）：子 agent 的最终答案直接存在 AppState 里（agentTask.result），
 *     取出来就是干净的答案文本。
 *  ② **磁盘路径**（兜底）：任务运行期间会持续把输出**写到磁盘文件**，
 *     这里按 task.id 去读那个文件（getTaskOutput）。
 *     用哪个取决于任务类型 —— 见 getTaskOutputData() 里 local_bash 的两个分支。
 *
 *  【★ block / timeout：这个工具最核心的两个参数】
 *    block=true（默认）   **阻塞等待**任务结束，最多等 timeout 毫秒（默认 30 秒）
 *                         ≈ Java 的 future.get(timeout, MILLISECONDS)
 *    block=false          **不等待**，立刻返回当前状态（可能只拿到部分输出）
 *                         ≈ Java 的"先 peek 一下"
 *  对应三种返回状态 retrieval_status：
 *    success     取到了（任务已完成）
 *    not_ready   block=false 且任务还在跑
 *    timeout     等了 timeout 之后任务还没结束（任务本身可能还在跑）
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "TaskOutput"，或旧名 AgentOutputTool / BashOutputTool）
 *        └─> 本文件 TaskOutputTool.call()                          ← ★ 你在这里
 *              ├─> waitForTaskCompletion()  本文件内部函数         → 轮询等任务结束
 *              ├─> getTaskOutputData()      本文件内部函数         → 按任务类型取输出
 *              ├─> getTaskOutput()          src/utils/task/diskOutput.ts → 读磁盘上的输出文件
 *              ├─> updateTaskState()        src/utils/task/framework.ts  → 标记"已通知过"
 *              └─> formatTaskOutput()       src/utils/task/outputFormatting.ts → 输出裁剪/编号
 *
 *  【本文件包含什么】
 *   1. inputSchema                 三个入参：task_id / block / timeout
 *   2. getTaskOutputData()         按任务类型取出输出（本文件最核心的取数逻辑）
 *   3. waitForTaskCompletion()     轮询等待任务结束（带 abort 和超时）
 *   4. TaskOutputTool              工具本体（call + validateInput + 各种渲染钩子）
 *   5. TaskOutputResultDisplay     结果渲染组件（React）
 *
 *  【⚠️ 注意：本文件后半段是 React Compiler 编译后的产物】
 *  353 行之后你能看到大量 `$[0] !== x ? ... : $[n]` 和 `t0/t1/t2` 这样的代码，
 *  那是 **React Compiler（react/compiler-runtime）自动插入的缓存逻辑**，
 *  手工源码里没有这些东西。读的时候抓大放小：
 *      `$[n]`  = useMemoCache 的缓存槽（≈ 编译后的 memo 记录）
 *      `t0/t1` = 编译器生成的临时变量
 *  不要去"优化"它们 —— 它们是编译产物，改了下次编译会重新生成。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（Java 工程师视角，只列本文件真正出现的）
 * ---------------------------------------------------------------------------
 *  - `.tsx` 后缀 = 允许直接写 **JSX**（长得像 HTML 的标签）。它不是 HTML，
 *    而是 React 元素：`<Text dimColor>{x}</Text>` ≈ 构造一个组件节点。
 *    属性名用驼峰（`flexDirection`、`marginTop`），不是 HTML 的横杠写法。
 *  - `c as _c` from 'react/compiler-runtime'：React Compiler 的运行时钩子，
 *    就是上面说的缓存机制，源码里看不到。
 *  - `type X = { a: string; b?: number }`：结构化类型 ≈ Java record，
 *    但按**结构**匹配（鸭子类型），不需要 implements。
 *  - `'success' | 'timeout' | 'not_ready'`：字面量联合类型，
 *    ≈ Java 的 enum，但只是字符串常量的集合，编译期就能挡住拼错。
 *  - `A | null` ≈ Java 的 @Nullable A / Optional<A>（写法轻得多）。
 *  - `?.` 可选链 ≈ 一串 null 检查后取属性，不会 NPE。
 *    `?.[id]` 是它的下标形式：`tasks?.[id]` ≈ `tasks == null ? null : tasks.get(id)`。
 *  - `??` 空值合并：`a ?? b` 只在 a 是 null/undefined 时取 b。
 *    ⚠️ 与 `||` 区别：`0`、`''`、`false` 不会被 `??` 换掉，但会被 `||` 换掉。
 *    本文件 `bashTask.result?.code ?? null` 必须用 `??`：
 *    退出码 0（成功）是合法值，用 `||` 会被误当成"没有值"而替换掉。
 *  - `as TaskState` / `as X`：`as` 是类型断言 ≈ Java 强转，**运行时不校验**。
 *  - `await` / `async` ≈ Java 的 CompletableFuture，但写起来像同步代码。
 *  - `z.number().min(0).max(600000).default(30000)`：zod 的链式校验，
 *    ≈ Java 的 Bean Validation 注解（@Min @Max）+ 默认值，但是链式调用。
 *  - `for await` / 生成器：本文件没用到，但同目录的 SendMessageTool 里有。
 *  - `.at(-1)`：取最后一个元素；本文件等价写法是 `arr[arr.length - 1]`。
 *  - `export default X` + `export const X`：两种导出方式。
 *    default 导出≈"这个模块的主角"，一个文件只能有一个。
 *  - `Symbol.for("react.memo_cache_sentinel")`：React 编译器用来标记
 *    "这个缓存槽还是空的"的哨兵值，属于编译产物的一部分。
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { z } from 'zod/v4';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Box, Text } from '../../ink.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { TaskType } from '../../Task.js';
import type { Tool } from '../../Tool.js';
import { buildTool, type ToolDef } from '../../Tool.js';
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js';
import type { RemoteAgentTaskState } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js';
import type { TaskState } from '../../tasks/types.js';
import { AbortError } from '../../utils/errors.js';
import { lazySchema } from '../../utils/lazySchema.js';
import { extractTextContent } from '../../utils/messages.js';
import { semanticBoolean } from '../../utils/semanticBoolean.js';
import { sleep } from '../../utils/sleep.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { countCharInString } from '../../utils/stringUtils.js';
import { getTaskOutput } from '../../utils/task/diskOutput.js';
import { updateTaskState } from '../../utils/task/framework.js';
import { formatTaskOutput } from '../../utils/task/outputFormatting.js';
import type { ThemeName } from '../../utils/theme.js';
import { AgentPromptDisplay, AgentResponseDisplay } from '../AgentTool/UI.js';
import BashToolResultMessage from '../BashTool/BashToolResultMessage.js';
import { TASK_OUTPUT_TOOL_NAME } from './constants.js';
// ── 入参 schema（三个参数，两个有默认值）──────────────────────────────
const inputSchema = lazySchema(() => z.strictObject({
  // task_id：要取输出的后台任务 id。
  task_id: z.string().describe('The task ID to get output from'),
  // block：是否阻塞等待任务结束。**默认 true**（大多数时候你想要的是最终结果）。
  // semanticBoolean() 包一层是为了容错：模型偶尔会传字符串 "true"/"false"，
  // 这个包装能把它们正确解析成布尔值，而不是当成非法输入直接报错。
  block: semanticBoolean(z.boolean().default(true)).describe('Whether to wait for completion'),
  // timeout：最多等多久（毫秒），默认 30 秒，上限 10 分钟。
  // 为什么要有上限：后台任务可能永远不结束，没有上限的话这个调用就永久挂住了。
  timeout: z.number().min(0).max(600000).default(30000).describe('Max wait time in ms')
}));
type InputSchema = ReturnType<typeof inputSchema>;
type TaskOutputToolInput = z.infer<InputSchema>;

// Unified output type covering all task types
// 统一的输出形状：**不管哪种任务类型，都归一成这一种结构**。
// 这样做的好处是调用方（模型、UI）不用关心任务类型，减少分支。
// 类型特有的字段（exitCode / prompt / result）都是可选的。
type TaskOutput = {
  task_id: string;
  task_type: TaskType;
  status: string;
  description: string;
  output: string;
  exitCode?: number | null;
  error?: string;
  // For agents
  prompt?: string;
  result?: string;
};
// 出参：retrieval_status 表示"这次取得顺不顺利"，task 是具体数据（失败时为 null）。
// 把"状态"和"数据"分开是刻意的设计 —— 模型要先看状态才知道怎么解读 task。
type TaskOutputToolOutput = {
  retrieval_status: 'success' | 'timeout' | 'not_ready';
  task: TaskOutput | null;
};

// Re-export Progress from centralized types to break import cycles
// 把 Progress 类型从集中定义处**再导出**一次。
// 为什么要绕这一下：直接 import 会形成循环依赖（A→B→A），
// 从第三方 types 模块转一道手可以打断这个环。
export type { TaskOutputProgress as Progress } from '../../types/tools.js';

// Get output for any task type
/**
 * 【核心取数函数】按任务类型取出它的输出，归一成统一的 TaskOutput 形状。
 *
 * 为什么需要：三种后台任务（bash / 本地 agent / 远程 agent）的输出
 * 存放位置完全不同，必须分别处理后再统一格式。
 *
 * @param task 后台任务的状态对象（来自 AppState.tasks）。
 * @returns 归一化后的 TaskOutput。
 *
 * 关键步骤：
 *   ① 取原始 output：
 *        local_bash → 优先从内存里的 stdout/stderr 对象读；没有就读磁盘输出文件
 *        其它类型  → 直接读磁盘输出文件
 *   ② 组装基础字段（id / 类型 / 状态 / 描述 / 输出）
 *   ③ 按类型补充特有字段：bash 补 exitCode、agent 补 prompt/result/error
 */
async function getTaskOutputData(task: TaskState): Promise<TaskOutput> {
  let output: string;
  // 后台 shell 命令：优先读内存里的 stdout/stderr（更实时、更全），
  // 拿不到再退回读磁盘输出文件。
  if (task.type === 'local_bash') {
    const bashTask = task as LocalShellTaskState;
    // `?.` 一路问下去：shellCommand 或 taskOutput 不存在都安全。
    // 为什么可能不存在：任务刚创建还没跑起来，或者进程重启后内存状态丢了。
    const taskOutputObj = bashTask.shellCommand?.taskOutput;
    if (taskOutputObj) {
      const stdout = await taskOutputObj.getStdout();
      const stderr = taskOutputObj.getStderr();
      // `.filter(Boolean)` 是"去掉空串/空值"的惯用写法（把 falsy 值滤掉），
      // 然后 stdout 和 stderr 用换行拼在一起。
      // 注意：这里把 stderr 也并进 output，模型才会看到报错信息。
      output = [stdout, stderr].filter(Boolean).join('\n');
    } else {
      // 兜底：读磁盘上那个输出文件（任务运行期间会持续往里写）。
      output = await getTaskOutput(task.id);
    }
  } else {
    output = await getTaskOutput(task.id);
  }
  // 先组装所有类型共有的基础字段，下面再按类型往上加特有字段。
  const baseOutput: TaskOutput = {
    task_id: task.id,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output
  };

  // Add type-specific fields
  // bash 类任务补充退出码。
  if (task.type === 'local_bash') {
    const bashTask = task as LocalShellTaskState;
    return {
      ...baseOutput,
      // `?? null` 而非 `|| null`：退出码 **0 是合法的成功值**，
      // 用 `||` 会把 0 当成 falsy 换成 null，成功会被误判成"没有退出码"。
      // 这是 `??` 和 `||` 最经典的区别场景。
      exitCode: bashTask.result?.code ?? null
    };
  }
  // 本地子 agent（AgentTool 派生的那种）。
  if (task.type === 'local_agent') {
    const agentTask = task as LocalAgentTaskState;
    // 【中文补充】优先用**内存里的最终结果**，而不是磁盘上的原始 transcript。
    // 为什么：磁盘那个文件是整个会话的 JSONL 全量记录（每条消息、每次工具调用都在里头），
    // 直接给模型会把上下文撑爆；而内存里的 result 只保留了子 agent 的最终回答文本。
    // 这是"取回后台任务输出"最容易踩的坑 —— 取错了对象，输出量差几十倍。
    // Prefer the clean final answer from the in-memory result over the raw
    // JSONL transcript on disk. The disk output is a symlink to the full
    // session transcript (every message, tool use, etc.), not just the
    // subagent's answer. The in-memory result contains only the final
    // assistant text content blocks.
    // extractTextContent：从消息内容块里只抽出**纯文本**部分（丢掉工具调用块等）。
    const cleanResult = agentTask.result ? extractTextContent(agentTask.result.content, '\n') : undefined;
    // 注意 result 和 output 两个字段都填了 cleanResult || output：
    // result 是"干净答案"，output 是"完整输出"，给不同的消费方用。
    return {
      ...baseOutput,
      prompt: agentTask.prompt,
      result: cleanResult || output,
      output: cleanResult || output,
      error: agentTask.error
    };
  }
  // 远程 agent：只补一个 prompt（它的输出走的是另一条链路）。
  if (task.type === 'remote_agent') {
    const remoteTask = task as RemoteAgentTaskState;
    return {
      ...baseOutput,
      prompt: remoteTask.command
    };
  }
  // 未知/其它类型：只返回基础字段。留这个兜底比抛错安全 ——
  // 将来新增任务类型时，至少还能拿到输出，不会整个工具崩掉。
  return baseOutput;
}

// Wait for task to complete
/**
 * 【轮询等待】一直等到任务结束，或者超时。
 *
 * 为什么是"轮询"而不是"事件通知"：后台任务的状态存在 AppState（一个普通对象）里，
 * 没有提供回调/监听器接口，最省事可靠的办法就是定时去看一眼。
 * ≈ Java 里没有 CompletableFuture 可用时，用 while + Thread.sleep 轮询 FutureTask 的状态。
 *
 * @param taskId          要等的任务 id。
 * @param getAppState     取最新状态的函数（每次轮询都**重新取**，保证拿到最新值）。
 * @param timeoutMs       最多等多久。
 * @param abortController 用于响应取消（用户按 Ctrl+C 时抛 AbortError）。
 * @returns 结束后的任务状态；任务不存在返回 null；
 *          超时则返回**当前**状态（可能还是 running，由调用方判断）。
 *
 * 关键步骤：
 *   ① 每次循环先检查 abort 信号 → 用户取消了就抛 AbortError
 *   ② 重新取 AppState 拿到任务最新状态
 *   ③ 任务没了 → 返回 null（可能已被清理）
 *   ④ 状态不是 running/pending → 说明结束了，返回
 *   ⑤ 还在跑 → sleep 100ms 后继续（100ms 是"反应够快又不空转烧 CPU"的折中值）
 */
async function waitForTaskCompletion(taskId: string, getAppState: () => {
  tasks?: Record<string, TaskState>;
}, timeoutMs: number, abortController?: AbortController): Promise<TaskState | null> {
  // 记录开始时间，用"已过去多久"判断超时（比倒计时更直观也更抗时钟跳变）。
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    // Check abort signal
    // 用户取消（Ctrl+C）优先于一切：抛出 AbortError 让整个工具调用链中断。
    if (abortController?.signal.aborted) {
      throw new AbortError();
    }
    // 每次都**重新**调用 getAppState：状态是可变的，缓存下来就永远等不到结束了。
    const state = getAppState();
    const task = state.tasks?.[taskId] as TaskState | undefined;
    // 任务不见了 → 返回 null（调用方会当成 timeout 处理）。
    if (!task) {
      return null;
    }
    // 只要不是 running/pending，就认为"结束了"（包括 completed / failed / stopped）。
    // 为什么用"排除法"而不是列举终态：将来新增终态时不用改这里。
    if (task.status !== 'running' && task.status !== 'pending') {
      return task;
    }

    // 【中文补充】sleep 100ms 再轮询。
    // Wait before polling again
    await sleep(100);
  }

  // 【中文补充】超时了：不抛错，返回当前状态。
  // Timeout - return current state
  // 为什么要返回"当前状态"而不是 null：调用方可以据此把**已经产出的部分输出**
  // 也回给模型（哪怕任务还没跑完），比干巴巴一句"超时了"有用得多。
  const finalState = getAppState();
  return finalState.tasks?.[taskId] as TaskState ?? null;
}
/**
 * TaskOutputTool 本体。
 *
 * 注意几个特别的配置：
 *   aliases: ['AgentOutputTool', 'BashOutputTool']  旧名别名，保证历史 transcript 能回放
 *   isReadOnly() → true                             只读，不弹权限框
 *   description() 里明确写了 DEPRECATED             已不推荐直接用，建议改用 Read 读输出文件
 *
 * 【为什么这个工具被标记为"已废弃"却还留着？】
 * 因为后台任务完成时本来就会把**输出文件路径**返回给模型，还会发一条
 * <task-notification> 通知。模型直接 Read 那个文件更简单，还不用阻塞等待。
 * 保留本工具是为了兼容已有行为和老版本 SDK 用户。
 */
export const TaskOutputTool: Tool<InputSchema, TaskOutputToolOutput> = buildTool({
  name: TASK_OUTPUT_TOOL_NAME,
  // 给 ToolSearch 用的一句话。
  searchHint: 'read output/logs from a background task',
  maxResultSizeChars: 100_000,
  // 延迟加载，省上下文。
  shouldDefer: true,
  // 【中文补充】为改名后的工具保留向后兼容的别名。
  // Backwards-compatible aliases for renamed tools
  // 模型写 AgentOutputTool / BashOutputTool 也能命中本工具。
  aliases: ['AgentOutputTool', 'BashOutputTool'],
  // 给用户看的名字（带空格，比工具名更口语）。
  userFacingName() {
    return 'Task Output';
  },
  // 懒加载 schema。
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  // 明确标注"已废弃"：提示模型优先用 Read 去读输出文件。
  async description() {
    return '[Deprecated] — prefer Read on the task output file path';
  },
  /**
   * 能不能和别的工具并行跑？直接复用 isReadOnly 的判断。
   *
   * `this.isReadOnly?.(_input) ?? false` 三个点：
   *   ① `this` —— 工具对象上的方法之间可以互相调用（≈ Java 的 this.xxx()）
   *   ② `?.()` —— 可选调用：isReadOnly 可能没实现，没实现就得到 undefined
   *   ③ `?? false` —— 兜底成 false（fail-closed：不确定就当"不能并行"）
   */
  isConcurrencySafe(_input) {
    return this.isReadOnly?.(_input) ?? false;
  },
  // 内部版本（'ant'）不启用这个工具。这个比较恒为 true，是构建期替换留下的痕迹。
  isEnabled() {
    return "external" !== 'ant';
  },
  // 只读：只读输出，不改动任何东西 → 免权限弹框，直接放行。
  isReadOnly(_input) {
    return true;
  },
  /**
   * 给安全分类器的一句话摘要：回 task_id 就够了 —— 取输出本身无害，
   * 但让分类器知道在取哪个任务的输出。
   */
  toAutoClassifierInput(input) {
    return input.task_id;
  },
  /**
   * 给模型看的说明。第一句就是 DEPRECATED —— 引导模型改用 Read 读输出文件。
   * 这和上面 description() 的措辞是一致的，两处都要提醒。
   */
  async prompt() {
    return `DEPRECATED: Prefer using the Read tool on the task's output file path instead. Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes — Read that file directly.

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`;
  },
  /**
   * 执行前校验：id 有没有传、任务存不存在。
   *
   * 为什么放在 validateInput 而不是 call：这里返回的结构化错误会被喂回给模型，
   * 模型能自己纠正（比如先去 /tasks 查一下正确的 id）。
   * 而 call() 里抛异常会被当成"工具坏了"，体验差一档。
   *
   * @returns `{result:false, message, errorCode}`（1=参数缺失，2=找不到任务）
   *          或 `{result:true}`。
   */
  async validateInput({
    task_id
  }, {
    getAppState
  }) {
    // 没传 task_id → errorCode 1（参数缺失）。
    if (!task_id) {
      return {
        result: false,
        message: 'Task ID is required',
        errorCode: 1
      };
    }
    // 后台任务都在 AppState.tasks 里（内存）。
    const appState = getAppState();
    const task = appState.tasks?.[task_id] as TaskState | undefined;
    // 找不到 → errorCode 2（找不到资源）。和上面的"参数缺失"区分开，
    // 便于上层对不同错误做不同处理（比如是否值得让模型重试）。
    if (!task) {
      return {
        result: false,
        message: `No task found with ID: ${task_id}`,
        errorCode: 2
      };
    }
    // 校验通过，放行执行。
    return {
      result: true
    };
  },
  /**
   * 主体：取回一个后台任务的输出。
   *
   * @param input            入参 { task_id, block, timeout }。
   * @param toolUseContext   上下文（getAppState / setAppState / abortController）。
   * @param _canUseTool      权限回调，本工具不需要（只读）。
   * @param _parentMessage   触发这次调用的消息，未使用。
   * @param onProgress       进度回调：阻塞等待时通知 UI"正在等"。
   * @returns `{ data: { retrieval_status, task } }`。
   *
   * 关键步骤（分 block=false / block=true 两条路）：
   *   【block=false，不等待】
   *     ① 任务已结束   → success，并把任务标记为"已通知"（notified）
   *     ② 任务还在跑   → not_ready（依然把当前已有的输出带上）
   *   【block=true，等待】
   *     ③ 先通过 onProgress 通知 UI 进入等待态（界面显示"Waiting for task…"）
   *     ④ waitForTaskCompletion() 轮询等待，受 timeout 和 abort 双重约束
   *     ⑤ 没等到（任务消失）→ timeout + task:null
   *     ⑥ 等到但仍未结束（超时）→ timeout + 当前已有的输出
   *     ⑦ 等到且已结束 → success + 标记 notified
   *
   * 【"标记 notified"是什么意思？】
   * 后台任务结束时本来会主动推一条通知给模型。如果模型已经通过本工具
   * 主动取过输出了，就把它标成已通知，避免**同一件事通知两遍**。
   */
  async call(input: TaskOutputToolInput, toolUseContext, _canUseTool, _parentMessage, onProgress) {
    // 解构出三个入参（block 和 timeout 都有默认值，所以一定拿得到）。
    const {
      task_id,
      block,
      timeout
    } = input;
    // 每次都重新取 AppState —— 任务状态是可变的，不能缓存。
    const appState = toolUseContext.getAppState();
    // `?.` + 下标：`tasks` 可能为 undefined，直接写 tasks[id] 会崩。
    const task = appState.tasks?.[task_id] as TaskState | undefined;
    // 正常流程下 validateInput 已经挡过一次了，这里是**双保险**：
    // call() 是公开入口，可能有别的调用路径不经过 validateInput。
    // 这里用 throw 而不是返回结构化错误：能走到这一步说明校验被绕过，属于程序 bug。
    if (!task) {
      throw new Error(`No task found with ID: ${task_id}`);
    }
    // ── 路径 A：block=false，不等待 ──────────────────────────────────
    if (!block) {
      // Non-blocking: return current state
      // 任务已经结束（不是 running 也不是 pending）→ 直接给结果。
      if (task.status !== 'running' && task.status !== 'pending') {
      // 【中文补充】标记成"已通知"，避免任务结束时再推一条重复通知。
        // Mark as notified
      // updateTaskState 的第三个参数是一个更新函数（≈ Java 的 UnaryOperator<T>）：
      // 传入旧状态、返回新状态。里面用 `{...t, notified: true}` 复制一份再改 ——
      // **不可变更新**，不直接修改原对象（React 状态管理的基本要求）。
        updateTaskState(task_id, toolUseContext.setAppState, t => ({
          ...t,
          notified: true
        }));
        return {
          data: {
            retrieval_status: 'success' as const,
            task: await getTaskOutputData(task)
          }
        };
      }
      // 任务还在跑：返回 not_ready（**不是错误**，就是"还没好"），
      // 同时把目前已有的输出带上，模型可以先看看进展。
      return {
        data: {
          retrieval_status: 'not_ready' as const,
          task: await getTaskOutputData(task)
        }
      };
    }

    // ── 路径 B：block=true，阻塞等待 ─────────────────────────────────
    // Blocking: wait for completion
    // 先告诉 UI"我要开始等了"，否则用户会以为卡住了。
    if (onProgress) {
      onProgress({
        // 进度事件的 id 里带上时间戳：保证每次等待都是**不同的 id**，
        // 否则 UI 可能把新进度当成重复事件丢掉。
        toolUseID: `task-output-waiting-${Date.now()}`,
        data: {
          type: 'waiting_for_task',
          taskDescription: task.description,
          taskType: task.type
        }
      });
    }
    // 真正的等待。注意把 abortController 传进去 ——
    // 用户按 Ctrl+C 时它能让等待立刻中断，而不是傻等到 timeout。
    const completedTask = await waitForTaskCompletion(task_id, toolUseContext.getAppState, timeout, toolUseContext.abortController);
    // 任务在等待期间消失了（被清理）→ timeout，且没有数据。
    if (!completedTask) {
      return {
        data: {
          retrieval_status: 'timeout' as const,
          task: null
        }
      };
    }
    // 超时但任务还在跑 → 返回 timeout + **已有的部分输出**。
    // 这比"什么都不给"有用：模型能据此判断要不要继续等、或者先干别的。
    if (completedTask.status === 'running' || completedTask.status === 'pending') {
      return {
        data: {
          retrieval_status: 'timeout' as const,
          task: await getTaskOutputData(completedTask)
        }
      };
    }

    // 【中文补充】同样标记"已通知"，防止重复通知。
    // Mark as notified
    updateTaskState(task_id, toolUseContext.setAppState, t => ({
      ...t,
      notified: true
    }));
    // 成功路径：任务已结束，返回完整输出。
    return {
      data: {
        retrieval_status: 'success' as const,
        task: await getTaskOutputData(completedTask)
      }
    };
  },
  /**
   * 把结果转成给模型看的文本。
   *
   * 为什么用 `<retrieval_status>` 这类 XML 标签而不是 JSON：
   * 模型对 XML 标签的解析更稳，而且**可以直接内嵌大段输出文本**（JSON 里要转义）。
   *
   * @param data       call() 的返回值。
   * @param toolUseID  对应的 tool_use id，原样回传。
   *
   * 关键步骤：
   *   ① 先写 retrieval_status（模型要先看这个才知道怎么解读后面）
   *   ② 有 task 才写详细字段；exitCode / output / error 都**只在有值时**才写
   *      —— 空字段也写出来纯属浪费 token
   *   ③ output 先过 formatTaskOutput() 做裁剪/加行号（防止超长输出撑爆上下文）
   */
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    // 用数组收集各个片段，最后 join。比反复字符串拼接更清晰也更好维护。
    const parts: string[] = [];
    // 状态放最前面：模型读到第一行就知道这次取得顺不顺利。
    parts.push(`<retrieval_status>${data.retrieval_status}</retrieval_status>`);
    if (data.task) {
      parts.push(`<task_id>${data.task.task_id}</task_id>`);
      parts.push(`<task_type>${data.task.task_type}</task_type>`);
      parts.push(`<status>${data.task.status}</status>`);
      // 两个判断都要：`!== undefined` 排除"没这个字段"，`!== null` 排除"明确没有退出码"。
      // 退出码 0 是合法值，所以不能用简单的 if (exitCode)。
      if (data.task.exitCode !== undefined && data.task.exitCode !== null) {
        parts.push(`<exit_code>${data.task.exitCode}</exit_code>`);
      }
      // `?.trim()`：output 可能为 undefined；trim 后再判断非空 ——
      // 避免把"只有空白字符"的输出也塞进结果里。
      if (data.task.output?.trim()) {
        const {
          content
        // formatTaskOutput 负责裁剪超长输出、给行加编号等（防止撑爆上下文）。
        } = formatTaskOutput(data.task.output, data.task.task_id);
        parts.push(`<output>\n${content.trimEnd()}\n</output>`);
      }
      // 错误信息单独一个标签，让模型容易区分"正常输出"和"报错"。
      if (data.task.error) {
        parts.push(`<error>${data.task.error}</error>`);
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
    // 用两个换行分隔各段：模型视觉上更容易分段。
      content: parts.join('\n\n')
    };
  },
  /**
   * 工具调用**发起时**显示什么。
   * block=false 显示 "non-blocking"（提醒用户这次不等结果），
   * block=true 显示空串（默认样式就够了）。
   */
  renderToolUseMessage(input) {
    const {
      block = true
    } = input;
    if (!block) {
      return 'non-blocking';
    }
    return '';
  },
  /**
   * 在工具调用旁边显示一个小标签：这里显示任务 id，方便用户知道在看哪个任务。
   * 没有 task_id 就返回 null（不显示）。
   */
  renderToolUseTag(input) {
    if (!input.task_id) {
      return null;
    }
    return <Text dimColor> {input.task_id}</Text>;
  },
  /**
   * **等待期间**显示什么：任务的描述 + "Waiting for task（esc 可补充指令）"。
   *
   * @param progressMessages 进度消息数组；这里只关心**最后一条**（最新状态）。
   */
  renderToolUseProgressMessage(progressMessages) {
    // `arr[arr.length - 1]` 取最后一个元素（本仓库也常用更简洁的 `.at(-1)`）。
    const lastProgress = progressMessages[progressMessages.length - 1];
    // `as ... | undefined`：进度数据是弱类型的，断言成我们期望的形状才能安全访问字段。
    const progressData = lastProgress?.data as {
      taskDescription?: string;
      taskType?: string;
    } | undefined;
    // JSX：<Box flexDirection="column"> ≈ 一个纵向布局容器（≈ Java Swing 的 BoxLayout）。
    // &nbsp; 是不换行空格，用来做缩进（终端组件里没有 CSS 的 margin-left 时常用这招）。
    return <Box flexDirection="column">
          {progressData?.taskDescription && <Text>&nbsp;&nbsp;{progressData.taskDescription}</Text>}
          <Text>
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Waiting for task{' '}
            <Text dimColor>(esc to give additional instructions)</Text>
          </Text>
        </Box>;
  },
  /**
   * 结果渲染：委托给下面的 TaskOutputResultDisplay 组件。
   * 拆成组件的原因：它内部有 hook（useShortcutDisplay），必须是组件才能用。
   */
  renderToolResultMessage(content, _, {
    verbose,
    theme
  }) {
    return <TaskOutputResultDisplay content={content} verbose={verbose} theme={theme} />;
  },
  // 权限被拒绝时显示什么（用框架提供的兜底组件）。
  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />;
  },
  // 出错时显示什么（同样用兜底组件）。
  renderToolUseErrorMessage(result, {
    verbose
  }) {
    return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
  }
} satisfies ToolDef<InputSchema, TaskOutputToolOutput>);
/**
 * 结果渲染组件：按**任务类型**和**是否 verbose**决定显示什么。
 *
 * ⚠️ 本函数的函数体是 **React Compiler 编译后的产物**：
 *    - `const $ = _c(54)` 申请 54 个缓存槽（useMemoCache）
 *    - `t0 / t1 / t2…` 是编译器生成的临时变量
 *    - `if ($[0] !== x) { ... $[0] = x; $[1] = t2 }` = "依赖没变就复用上次的缓存"
 *    ≈ 手写代码里的 useMemo，但由编译器自动插入。
 *    读的时候**按 if 分支的语义读**，把 $[n] 那些赋值当透明的就行。
 *
 * @param props.content 工具结果（可能是对象，也可能是 JSON 字符串 ——
 *                      结果落盘再读回时会变成字符串，所以两种都要能处理）
 * @param props.verbose 是否详细模式：true 显示完整内容，false 只显示一行提示 + 快捷键
 * @param props.theme   主题（影响代码高亮等配色）
 *
 * 分支结构：
 *   ① 没有 task            → "No task output available"
 *   ② local_bash           → 复用 BashToolResultMessage 组件渲染
 *   ③ local_agent          → 成功时显示 prompt + 结果；运行中显示"还在跑"；verbose 才展开
 *   ④ remote_agent         → 描述 + 状态 [status]，verbose 才展开输出
 *   ⑤ 其它类型（兜底）      → 描述 + 状态，输出最多显示 500 字符
 */
function TaskOutputResultDisplay(t0) {
  // _c(54)：向 React Compiler 运行时申请 54 个缓存槽。
  // 数字是编译器静态分析出来的（本函数里有多少个可缓存值），不要手改。
  const $ = _c(54);
  const {
    content,
    verbose: t1,
    theme
  } = t0;
  // verbose 没传时默认 false。`=== undefined` 而不是 `||`：
  // 这样显式传入 false 不会被误改成默认值（虽然这里效果相同，但语义更准确）。
  const verbose = t1 === undefined ? false : t1;
  // 读取"展开/收起"的快捷键（如 ctrl+o），用于在非详细模式下提示用户怎么展开。
  const expandShortcut = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");
  let t2;
  if ($[0] !== content) {
    // 和前面几个工具一样：结果可能被持久化成 JSON 字符串，读回来要先解析。
    // 外面套的 if/else 是 React Compiler 的缓存判断（依赖没变就复用上次结果）。
    t2 = typeof content === "string" ? jsonParse(content) : content;
    $[0] = content;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const result = t2;
  // 没有任务数据 → 一句提示了事。
  if (!result.task) {
    let t3;
    if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
      t3 = <MessageResponse><Text dimColor={true}>No task output available</Text></MessageResponse>;
      $[2] = t3;
    } else {
      t3 = $[2];
    }
    return t3;
  }
  const {
    task
  } = result;
  // ── 分支②：后台 shell 命令 ────────────────────────────────────────
  // 复用 BashToolResultMessage 组件：它本来就负责渲染 stdout/stderr/退出码，
  // 这里只要把数据结构拼成它认识的形状即可（注意 isImage/dangerouslyDisableSandbox 是固定值）。
  if (task.task_type === "local_bash") {
    let t3;
    if ($[3] !== task.error || $[4] !== task.output) {
      t3 = {
        stdout: task.output,
        stderr: "",
        isImage: false,
        dangerouslyDisableSandbox: true,
        returnCodeInterpretation: task.error
      };
      $[3] = task.error;
      $[4] = task.output;
      $[5] = t3;
    } else {
      t3 = $[5];
    }
    const bashOut = t3;
    let t4;
    if ($[6] !== bashOut || $[7] !== verbose) {
      t4 = <BashToolResultMessage content={bashOut} verbose={verbose} />;
      $[6] = bashOut;
      $[7] = verbose;
      $[8] = t4;
    } else {
      t4 = $[8];
    }
    return t4;
  }
  // ── 分支③：本地子 agent ──────────────────────────────────────────
  if (task.task_type === "local_agent") {
    // 数一下答案有多少行，用于显示 "描述 (N lines)"。
    // countCharInString(s, "\n") + 1 是数行数的常规做法（最后一行末尾没有换行符）。
    const lineCount = task.result ? countCharInString(task.result, "\n") + 1 : 0;
    // 只有成功取到结果才详细渲染；超时/未就绪走下面更简单的分支。
    if (result.retrieval_status === "success") {
      // verbose（详细模式）：把"提示词 + 答案 + 错误"全部展开显示。
      if (verbose) {
        let t3;
        if ($[9] !== lineCount || $[10] !== task.description) {
          t3 = <Text>{task.description} ({lineCount} lines)</Text>;
          $[9] = lineCount;
          $[10] = task.description;
          $[11] = t3;
        } else {
          t3 = $[11];
        }
        let t4;
        if ($[12] !== task.prompt || $[13] !== theme) {
          t4 = task.prompt && <AgentPromptDisplay prompt={task.prompt} theme={theme} dim={true} />;
          $[12] = task.prompt;
          $[13] = theme;
          $[14] = t4;
        } else {
          t4 = $[14];
        }
        let t5;
        if ($[15] !== task.result || $[16] !== theme) {
          t5 = task.result && <Box marginTop={1}><AgentResponseDisplay content={[{
              type: "text",
              text: task.result
            }]} theme={theme} /></Box>;
          $[15] = task.result;
          $[16] = theme;
          $[17] = t5;
        } else {
          t5 = $[17];
        }
        let t6;
        if ($[18] !== task.error) {
          t6 = task.error && <Box flexDirection="column" marginTop={1}><Text color="error" bold={true}>Error:</Text><Box paddingLeft={2}><Text color="error">{task.error}</Text></Box></Box>;
          $[18] = task.error;
          $[19] = t6;
        } else {
          t6 = $[19];
        }
        let t7;
        if ($[20] !== t4 || $[21] !== t5 || $[22] !== t6) {
          t7 = <Box flexDirection="column" paddingLeft={2} marginTop={1}>{t4}{t5}{t6}</Box>;
          $[20] = t4;
          $[21] = t5;
          $[22] = t6;
          $[23] = t7;
        } else {
          t7 = $[23];
        }
        let t8;
        if ($[24] !== t3 || $[25] !== t7) {
          t8 = <Box flexDirection="column">{t3}{t7}</Box>;
          $[24] = t3;
          $[25] = t7;
          $[26] = t8;
        } else {
          t8 = $[26];
        }
        return t8;
      }
      // 非详细模式：只显示一行 "Read output (ctrl+o to expand)"。
      // 为什么要折叠：子 agent 的答案可能很长，默认全展开会把屏幕刷满。
      let t3;
      if ($[27] !== expandShortcut) {
        t3 = <MessageResponse><Text dimColor={true}>Read output ({expandShortcut} to expand)</Text></MessageResponse>;
        $[27] = expandShortcut;
        $[28] = t3;
      } else {
        t3 = $[28];
      }
      return t3;
    }
    // 超时、或任务仍在运行 → "Task is still running…"。
    if (result.retrieval_status === "timeout" || task.status === "running") {
      let t3;
      if ($[29] === Symbol.for("react.memo_cache_sentinel")) {
        t3 = <MessageResponse><Text dimColor={true}>Task is still running…</Text></MessageResponse>;
        $[29] = t3;
      } else {
        t3 = $[29];
      }
      return t3;
    }
    // block=false 且任务还没结束 → 同样提示"还在跑"。
    if (result.retrieval_status === "not_ready") {
      let t3;
      if ($[30] === Symbol.for("react.memo_cache_sentinel")) {
        t3 = <MessageResponse><Text dimColor={true}>Task is still running…</Text></MessageResponse>;
        $[30] = t3;
      } else {
        t3 = $[30];
      }
      return t3;
    }
    let t3;
    if ($[31] === Symbol.for("react.memo_cache_sentinel")) {
    // 其它情况（既没成功也没在跑）→ "Task not ready"。
      t3 = <MessageResponse><Text dimColor={true}>Task not ready</Text></MessageResponse>;
      $[31] = t3;
    } else {
      t3 = $[31];
    }
    return t3;
  }
  // ── 分支④：远程 agent ────────────────────────────────────────────
  // 显示 描述 [状态]，verbose 时才把输出展开。
  if (task.task_type === "remote_agent") {
    let t3;
    if ($[32] !== task.description || $[33] !== task.status) {
      t3 = <Text>  {task.description} [{task.status}]</Text>;
      $[32] = task.description;
      $[33] = task.status;
      $[34] = t3;
    } else {
      t3 = $[34];
    }
    let t4;
    if ($[35] !== task.output || $[36] !== verbose) {
      t4 = task.output && verbose && <Box paddingLeft={4} marginTop={1}><Text>{task.output}</Text></Box>;
      $[35] = task.output;
      $[36] = verbose;
      $[37] = t4;
    } else {
      t4 = $[37];
    }
    let t5;
    if ($[38] !== expandShortcut || $[39] !== task.output || $[40] !== verbose) {
      t5 = !verbose && task.output && <Text dimColor={true}>{"     "}({expandShortcut} to expand)</Text>;
      $[38] = expandShortcut;
      $[39] = task.output;
      $[40] = verbose;
      $[41] = t5;
    } else {
      t5 = $[41];
    }
    let t6;
    if ($[42] !== t3 || $[43] !== t4 || $[44] !== t5) {
      t6 = <Box flexDirection="column">{t3}{t4}{t5}</Box>;
      $[42] = t3;
      $[43] = t4;
      $[44] = t5;
      $[45] = t6;
    } else {
      t6 = $[45];
    }
    return t6;
  }
  // ── 分支⑤：兜底（其它/新增的任务类型）──────────────────────────
  // 显示描述 + 状态，输出**最多 500 字符**（slice(0,500)）——
  // 未知类型可能输出量很大，截断是保护性措施。
  let t3;
  if ($[46] !== task.description || $[47] !== task.status) {
    t3 = <Text>  {task.description} [{task.status}]</Text>;
    $[46] = task.description;
    $[47] = task.status;
    $[48] = t3;
  } else {
    t3 = $[48];
  }
  let t4;
  if ($[49] !== task.output) {
    // slice(0, 500)：只取前 500 个字符。对未知类型的输出做长度保护。
    t4 = task.output && <Box paddingLeft={4}><Text>{task.output.slice(0, 500)}</Text></Box>;
    $[49] = task.output;
    $[50] = t4;
  } else {
    t4 = $[50];
  }
  let t5;
  if ($[51] !== t3 || $[52] !== t4) {
    t5 = <Box flexDirection="column">{t3}{t4}</Box>;
    $[51] = t3;
    $[52] = t4;
    $[53] = t5;
  } else {
    t5 = $[53];
  }
  return t5;
}
// 默认导出：别的模块 `import TaskOutputTool from './TaskOutputTool.js'` 拿到的就是这个。
export default TaskOutputTool;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInoiLCJGYWxsYmFja1Rvb2xVc2VFcnJvck1lc3NhZ2UiLCJGYWxsYmFja1Rvb2xVc2VSZWplY3RlZE1lc3NhZ2UiLCJNZXNzYWdlUmVzcG9uc2UiLCJCb3giLCJUZXh0IiwidXNlU2hvcnRjdXREaXNwbGF5IiwiVGFza1R5cGUiLCJUb29sIiwiYnVpbGRUb29sIiwiVG9vbERlZiIsIkxvY2FsQWdlbnRUYXNrU3RhdGUiLCJMb2NhbFNoZWxsVGFza1N0YXRlIiwiUmVtb3RlQWdlbnRUYXNrU3RhdGUiLCJUYXNrU3RhdGUiLCJBYm9ydEVycm9yIiwibGF6eVNjaGVtYSIsImV4dHJhY3RUZXh0Q29udGVudCIsInNlbWFudGljQm9vbGVhbiIsInNsZWVwIiwianNvblBhcnNlIiwiY291bnRDaGFySW5TdHJpbmciLCJnZXRUYXNrT3V0cHV0IiwidXBkYXRlVGFza1N0YXRlIiwiZm9ybWF0VGFza091dHB1dCIsIlRoZW1lTmFtZSIsIkFnZW50UHJvbXB0RGlzcGxheSIsIkFnZW50UmVzcG9uc2VEaXNwbGF5IiwiQmFzaFRvb2xSZXN1bHRNZXNzYWdlIiwiVEFTS19PVVRQVVRfVE9PTF9OQU1FIiwiaW5wdXRTY2hlbWEiLCJzdHJpY3RPYmplY3QiLCJ0YXNrX2lkIiwic3RyaW5nIiwiZGVzY3JpYmUiLCJibG9jayIsImJvb2xlYW4iLCJkZWZhdWx0IiwidGltZW91dCIsIm51bWJlciIsIm1pbiIsIm1heCIsIklucHV0U2NoZW1hIiwiUmV0dXJuVHlwZSIsIlRhc2tPdXRwdXRUb29sSW5wdXQiLCJpbmZlciIsIlRhc2tPdXRwdXQiLCJ0YXNrX3R5cGUiLCJzdGF0dXMiLCJkZXNjcmlwdGlvbiIsIm91dHB1dCIsImV4aXRDb2RlIiwiZXJyb3IiLCJwcm9tcHQiLCJyZXN1bHQiLCJUYXNrT3V0cHV0VG9vbE91dHB1dCIsInJldHJpZXZhbF9zdGF0dXMiLCJ0YXNrIiwiVGFza091dHB1dFByb2dyZXNzIiwiUHJvZ3Jlc3MiLCJnZXRUYXNrT3V0cHV0RGF0YSIsIlByb21pc2UiLCJ0eXBlIiwiYmFzaFRhc2siLCJ0YXNrT3V0cHV0T2JqIiwic2hlbGxDb21tYW5kIiwidGFza091dHB1dCIsInN0ZG91dCIsImdldFN0ZG91dCIsInN0ZGVyciIsImdldFN0ZGVyciIsImZpbHRlciIsIkJvb2xlYW4iLCJqb2luIiwiaWQiLCJiYXNlT3V0cHV0IiwiY29kZSIsImFnZW50VGFzayIsImNsZWFuUmVzdWx0IiwiY29udGVudCIsInVuZGVmaW5lZCIsInJlbW90ZVRhc2siLCJjb21tYW5kIiwid2FpdEZvclRhc2tDb21wbGV0aW9uIiwidGFza0lkIiwiZ2V0QXBwU3RhdGUiLCJ0YXNrcyIsIlJlY29yZCIsInRpbWVvdXRNcyIsImFib3J0Q29udHJvbGxlciIsIkFib3J0Q29udHJvbGxlciIsInN0YXJ0VGltZSIsIkRhdGUiLCJub3ciLCJzaWduYWwiLCJhYm9ydGVkIiwic3RhdGUiLCJmaW5hbFN0YXRlIiwiVGFza091dHB1dFRvb2wiLCJuYW1lIiwic2VhcmNoSGludCIsIm1heFJlc3VsdFNpemVDaGFycyIsInNob3VsZERlZmVyIiwiYWxpYXNlcyIsInVzZXJGYWNpbmdOYW1lIiwiaXNDb25jdXJyZW5jeVNhZmUiLCJfaW5wdXQiLCJpc1JlYWRPbmx5IiwiaXNFbmFibGVkIiwidG9BdXRvQ2xhc3NpZmllcklucHV0IiwiaW5wdXQiLCJ2YWxpZGF0ZUlucHV0IiwibWVzc2FnZSIsImVycm9yQ29kZSIsImFwcFN0YXRlIiwiY2FsbCIsInRvb2xVc2VDb250ZXh0IiwiX2NhblVzZVRvb2wiLCJfcGFyZW50TWVzc2FnZSIsIm9uUHJvZ3Jlc3MiLCJFcnJvciIsInNldEFwcFN0YXRlIiwidCIsIm5vdGlmaWVkIiwiZGF0YSIsImNvbnN0IiwidG9vbFVzZUlEIiwidGFza0Rlc2NyaXB0aW9uIiwidGFza1R5cGUiLCJjb21wbGV0ZWRUYXNrIiwibWFwVG9vbFJlc3VsdFRvVG9vbFJlc3VsdEJsb2NrUGFyYW0iLCJwYXJ0cyIsInB1c2giLCJ0cmltIiwidHJpbUVuZCIsInRvb2xfdXNlX2lkIiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJyZW5kZXJUb29sVXNlVGFnIiwicmVuZGVyVG9vbFVzZVByb2dyZXNzTWVzc2FnZSIsInByb2dyZXNzTWVzc2FnZXMiLCJsYXN0UHJvZ3Jlc3MiLCJsZW5ndGgiLCJwcm9ncmVzc0RhdGEiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsIl8iLCJ2ZXJib3NlIiwidGhlbWUiLCJyZW5kZXJUb29sVXNlUmVqZWN0ZWRNZXNzYWdlIiwicmVuZGVyVG9vbFVzZUVycm9yTWVzc2FnZSIsIlRhc2tPdXRwdXRSZXN1bHREaXNwbGF5IiwidDAiLCIkIiwiX2MiLCJ0MSIsImV4cGFuZFNob3J0Y3V0IiwidDIiLCJ0MyIsIlN5bWJvbCIsImZvciIsImlzSW1hZ2UiLCJkYW5nZXJvdXNseURpc2FibGVTYW5kYm94IiwicmV0dXJuQ29kZUludGVycHJldGF0aW9uIiwiYmFzaE91dCIsInQ0IiwibGluZUNvdW50IiwidDUiLCJ0ZXh0IiwidDYiLCJ0NyIsInQ4Iiwic2xpY2UiXSwic291cmNlcyI6WyJUYXNrT3V0cHV0VG9vbC50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZC92NCdcbmltcG9ydCB7IEZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvRmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgRmFsbGJhY2tUb29sVXNlUmVqZWN0ZWRNZXNzYWdlIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9GYWxsYmFja1Rvb2xVc2VSZWplY3RlZE1lc3NhZ2UuanMnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL01lc3NhZ2VSZXNwb25zZS5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZVNob3J0Y3V0RGlzcGxheSB9IGZyb20gJy4uLy4uL2tleWJpbmRpbmdzL3VzZVNob3J0Y3V0RGlzcGxheS5qcydcbmltcG9ydCB0eXBlIHsgVGFza1R5cGUgfSBmcm9tICcuLi8uLi9UYXNrLmpzJ1xuaW1wb3J0IHR5cGUgeyBUb29sIH0gZnJvbSAnLi4vLi4vVG9vbC5qcydcbmltcG9ydCB7IGJ1aWxkVG9vbCwgdHlwZSBUb29sRGVmIH0gZnJvbSAnLi4vLi4vVG9vbC5qcydcbmltcG9ydCB0eXBlIHsgTG9jYWxBZ2VudFRhc2tTdGF0ZSB9IGZyb20gJy4uLy4uL3Rhc2tzL0xvY2FsQWdlbnRUYXNrL0xvY2FsQWdlbnRUYXNrLmpzJ1xuaW1wb3J0IHR5cGUgeyBMb2NhbFNoZWxsVGFza1N0YXRlIH0gZnJvbSAnLi4vLi4vdGFza3MvTG9jYWxTaGVsbFRhc2svZ3VhcmRzLmpzJ1xuaW1wb3J0IHR5cGUgeyBSZW1vdGVBZ2VudFRhc2tTdGF0ZSB9IGZyb20gJy4uLy4uL3Rhc2tzL1JlbW90ZUFnZW50VGFzay9SZW1vdGVBZ2VudFRhc2suanMnXG5pbXBvcnQgdHlwZSB7IFRhc2tTdGF0ZSB9IGZyb20gJy4uLy4uL3Rhc2tzL3R5cGVzLmpzJ1xuaW1wb3J0IHsgQWJvcnRFcnJvciB9IGZyb20gJy4uLy4uL3V0aWxzL2Vycm9ycy5qcydcbmltcG9ydCB7IGxhenlTY2hlbWEgfSBmcm9tICcuLi8uLi91dGlscy9sYXp5U2NoZW1hLmpzJ1xuaW1wb3J0IHsgZXh0cmFjdFRleHRDb250ZW50IH0gZnJvbSAnLi4vLi4vdXRpbHMvbWVzc2FnZXMuanMnXG5pbXBvcnQgeyBzZW1hbnRpY0Jvb2xlYW4gfSBmcm9tICcuLi8uLi91dGlscy9zZW1hbnRpY0Jvb2xlYW4uanMnXG5pbXBvcnQgeyBzbGVlcCB9IGZyb20gJy4uLy4uL3V0aWxzL3NsZWVwLmpzJ1xuaW1wb3J0IHsganNvblBhcnNlIH0gZnJvbSAnLi4vLi4vdXRpbHMvc2xvd09wZXJhdGlvbnMuanMnXG5pbXBvcnQgeyBjb3VudENoYXJJblN0cmluZyB9IGZyb20gJy4uLy4uL3V0aWxzL3N0cmluZ1V0aWxzLmpzJ1xuaW1wb3J0IHsgZ2V0VGFza091dHB1dCB9IGZyb20gJy4uLy4uL3V0aWxzL3Rhc2svZGlza091dHB1dC5qcydcbmltcG9ydCB7IHVwZGF0ZVRhc2tTdGF0ZSB9IGZyb20gJy4uLy4uL3V0aWxzL3Rhc2svZnJhbWV3b3JrLmpzJ1xuaW1wb3J0IHsgZm9ybWF0VGFza091dHB1dCB9IGZyb20gJy4uLy4uL3V0aWxzL3Rhc2svb3V0cHV0Rm9ybWF0dGluZy5qcydcbmltcG9ydCB0eXBlIHsgVGhlbWVOYW1lIH0gZnJvbSAnLi4vLi4vdXRpbHMvdGhlbWUuanMnXG5pbXBvcnQgeyBBZ2VudFByb21wdERpc3BsYXksIEFnZW50UmVzcG9uc2VEaXNwbGF5IH0gZnJvbSAnLi4vQWdlbnRUb29sL1VJLmpzJ1xuaW1wb3J0IEJhc2hUb29sUmVzdWx0TWVzc2FnZSBmcm9tICcuLi9CYXNoVG9vbC9CYXNoVG9vbFJlc3VsdE1lc3NhZ2UuanMnXG5pbXBvcnQgeyBUQVNLX09VVFBVVF9UT09MX05BTUUgfSBmcm9tICcuL2NvbnN0YW50cy5qcydcblxuY29uc3QgaW5wdXRTY2hlbWEgPSBsYXp5U2NoZW1hKCgpID0+XG4gIHouc3RyaWN0T2JqZWN0KHtcbiAgICB0YXNrX2lkOiB6LnN0cmluZygpLmRlc2NyaWJlKCdUaGUgdGFzayBJRCB0byBnZXQgb3V0cHV0IGZyb20nKSxcbiAgICBibG9jazogc2VtYW50aWNCb29sZWFuKHouYm9vbGVhbigpLmRlZmF1bHQodHJ1ZSkpLmRlc2NyaWJlKFxuICAgICAgJ1doZXRoZXIgdG8gd2FpdCBmb3IgY29tcGxldGlvbicsXG4gICAgKSxcbiAgICB0aW1lb3V0OiB6XG4gICAgICAubnVtYmVyKClcbiAgICAgIC5taW4oMClcbiAgICAgIC5tYXgoNjAwMDAwKVxuICAgICAgLmRlZmF1bHQoMzAwMDApXG4gICAgICAuZGVzY3JpYmUoJ01heCB3YWl0IHRpbWUgaW4gbXMnKSxcbiAgfSksXG4pXG50eXBlIElucHV0U2NoZW1hID0gUmV0dXJuVHlwZTx0eXBlb2YgaW5wdXRTY2hlbWE+XG5cbnR5cGUgVGFza091dHB1dFRvb2xJbnB1dCA9IHouaW5mZXI8SW5wdXRTY2hlbWE+XG5cbi8vIFVuaWZpZWQgb3V0cHV0IHR5cGUgY292ZXJpbmcgYWxsIHRhc2sgdHlwZXNcbnR5cGUgVGFza091dHB1dCA9IHtcbiAgdGFza19pZDogc3RyaW5nXG4gIHRhc2tfdHlwZTogVGFza1R5cGVcbiAgc3RhdHVzOiBzdHJpbmdcbiAgZGVzY3JpcHRpb246IHN0cmluZ1xuICBvdXRwdXQ6IHN0cmluZ1xuICBleGl0Q29kZT86IG51bWJlciB8IG51bGxcbiAgZXJyb3I/OiBzdHJpbmdcbiAgLy8gRm9yIGFnZW50c1xuICBwcm9tcHQ/OiBzdHJpbmdcbiAgcmVzdWx0Pzogc3RyaW5nXG59XG5cbnR5cGUgVGFza091dHB1dFRvb2xPdXRwdXQgPSB7XG4gIHJldHJpZXZhbF9zdGF0dXM6ICdzdWNjZXNzJyB8ICd0aW1lb3V0JyB8ICdub3RfcmVhZHknXG4gIHRhc2s6IFRhc2tPdXRwdXQgfCBudWxsXG59XG5cbi8vIFJlLWV4cG9ydCBQcm9ncmVzcyBmcm9tIGNlbnRyYWxpemVkIHR5cGVzIHRvIGJyZWFrIGltcG9ydCBjeWNsZXNcbmV4cG9ydCB0eXBlIHsgVGFza091dHB1dFByb2dyZXNzIGFzIFByb2dyZXNzIH0gZnJvbSAnLi4vLi4vdHlwZXMvdG9vbHMuanMnXG5cbi8vIEdldCBvdXRwdXQgZm9yIGFueSB0YXNrIHR5cGVcbmFzeW5jIGZ1bmN0aW9uIGdldFRhc2tPdXRwdXREYXRhKHRhc2s6IFRhc2tTdGF0ZSk6IFByb21pc2U8VGFza091dHB1dD4ge1xuICBsZXQgb3V0cHV0OiBzdHJpbmdcbiAgaWYgKHRhc2sudHlwZSA9PT0gJ2xvY2FsX2Jhc2gnKSB7XG4gICAgY29uc3QgYmFzaFRhc2sgPSB0YXNrIGFzIExvY2FsU2hlbGxUYXNrU3RhdGVcbiAgICBjb25zdCB0YXNrT3V0cHV0T2JqID0gYmFzaFRhc2suc2hlbGxDb21tYW5kPy50YXNrT3V0cHV0XG4gICAgaWYgKHRhc2tPdXRwdXRPYmopIHtcbiAgICAgIGNvbnN0IHN0ZG91dCA9IGF3YWl0IHRhc2tPdXRwdXRPYmouZ2V0U3Rkb3V0KClcbiAgICAgIGNvbnN0IHN0ZGVyciA9IHRhc2tPdXRwdXRPYmouZ2V0U3RkZXJyKClcbiAgICAgIG91dHB1dCA9IFtzdGRvdXQsIHN0ZGVycl0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJ1xcbicpXG4gICAgfSBlbHNlIHtcbiAgICAgIG91dHB1dCA9IGF3YWl0IGdldFRhc2tPdXRwdXQodGFzay5pZClcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgb3V0cHV0ID0gYXdhaXQgZ2V0VGFza091dHB1dCh0YXNrLmlkKVxuICB9XG5cbiAgY29uc3QgYmFzZU91dHB1dDogVGFza091dHB1dCA9IHtcbiAgICB0YXNrX2lkOiB0YXNrLmlkLFxuICAgIHRhc2tfdHlwZTogdGFzay50eXBlLFxuICAgIHN0YXR1czogdGFzay5zdGF0dXMsXG4gICAgZGVzY3JpcHRpb246IHRhc2suZGVzY3JpcHRpb24sXG4gICAgb3V0cHV0LFxuICB9XG5cbiAgLy8gQWRkIHR5cGUtc3BlY2lmaWMgZmllbGRzXG4gIGlmICh0YXNrLnR5cGUgPT09ICdsb2NhbF9iYXNoJykge1xuICAgIGNvbnN0IGJhc2hUYXNrID0gdGFzayBhcyBMb2NhbFNoZWxsVGFza1N0YXRlXG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2VPdXRwdXQsXG4gICAgICBleGl0Q29kZTogYmFzaFRhc2sucmVzdWx0Py5jb2RlID8/IG51bGwsXG4gICAgfVxuICB9XG5cbiAgaWYgKHRhc2sudHlwZSA9PT0gJ2xvY2FsX2FnZW50Jykge1xuICAgIGNvbnN0IGFnZW50VGFzayA9IHRhc2sgYXMgTG9jYWxBZ2VudFRhc2tTdGF0ZVxuICAgIC8vIFByZWZlciB0aGUgY2xlYW4gZmluYWwgYW5zd2VyIGZyb20gdGhlIGluLW1lbW9yeSByZXN1bHQgb3ZlciB0aGUgcmF3XG4gICAgLy8gSlNPTkwgdHJhbnNjcmlwdCBvbiBkaXNrLiBUaGUgZGlzayBvdXRwdXQgaXMgYSBzeW1saW5rIHRvIHRoZSBmdWxsXG4gICAgLy8gc2Vzc2lvbiB0cmFuc2NyaXB0IChldmVyeSBtZXNzYWdlLCB0b29sIHVzZSwgZXRjLiksIG5vdCBqdXN0IHRoZVxuICAgIC8vIHN1YmFnZW50J3MgYW5zd2VyLiBUaGUgaW4tbWVtb3J5IHJlc3VsdCBjb250YWlucyBvbmx5IHRoZSBmaW5hbFxuICAgIC8vIGFzc2lzdGFudCB0ZXh0IGNvbnRlbnQgYmxvY2tzLlxuICAgIGNvbnN0IGNsZWFuUmVzdWx0ID0gYWdlbnRUYXNrLnJlc3VsdFxuICAgICAgPyBleHRyYWN0VGV4dENvbnRlbnQoYWdlbnRUYXNrLnJlc3VsdC5jb250ZW50LCAnXFxuJylcbiAgICAgIDogdW5kZWZpbmVkXG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2VPdXRwdXQsXG4gICAgICBwcm9tcHQ6IGFnZW50VGFzay5wcm9tcHQsXG4gICAgICByZXN1bHQ6IGNsZWFuUmVzdWx0IHx8IG91dHB1dCxcbiAgICAgIG91dHB1dDogY2xlYW5SZXN1bHQgfHwgb3V0cHV0LFxuICAgICAgZXJyb3I6IGFnZW50VGFzay5lcnJvcixcbiAgICB9XG4gIH1cblxuICBpZiAodGFzay50eXBlID09PSAncmVtb3RlX2FnZW50Jykge1xuICAgIGNvbnN0IHJlbW90ZVRhc2sgPSB0YXNrIGFzIFJlbW90ZUFnZW50VGFza1N0YXRlXG4gICAgcmV0dXJuIHtcbiAgICAgIC4uLmJhc2VPdXRwdXQsXG4gICAgICBwcm9tcHQ6IHJlbW90ZVRhc2suY29tbWFuZCxcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYmFzZU91dHB1dFxufVxuXG4vLyBXYWl0IGZvciB0YXNrIHRvIGNvbXBsZXRlXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yVGFza0NvbXBsZXRpb24oXG4gIHRhc2tJZDogc3RyaW5nLFxuICBnZXRBcHBTdGF0ZTogKCkgPT4geyB0YXNrcz86IFJlY29yZDxzdHJpbmcsIFRhc2tTdGF0ZT4gfSxcbiAgdGltZW91dE1zOiBudW1iZXIsXG4gIGFib3J0Q29udHJvbGxlcj86IEFib3J0Q29udHJvbGxlcixcbik6IFByb21pc2U8VGFza1N0YXRlIHwgbnVsbD4ge1xuICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpXG5cbiAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydFRpbWUgPCB0aW1lb3V0TXMpIHtcbiAgICAvLyBDaGVjayBhYm9ydCBzaWduYWxcbiAgICBpZiAoYWJvcnRDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xuICAgICAgdGhyb3cgbmV3IEFib3J0RXJyb3IoKVxuICAgIH1cblxuICAgIGNvbnN0IHN0YXRlID0gZ2V0QXBwU3RhdGUoKVxuICAgIGNvbnN0IHRhc2sgPSBzdGF0ZS50YXNrcz8uW3Rhc2tJZF0gYXMgVGFza1N0YXRlIHwgdW5kZWZpbmVkXG5cbiAgICBpZiAoIXRhc2spIHtcbiAgICAgIHJldHVybiBudWxsXG4gICAgfVxuXG4gICAgaWYgKHRhc2suc3RhdHVzICE9PSAncnVubmluZycgJiYgdGFzay5zdGF0dXMgIT09ICdwZW5kaW5nJykge1xuICAgICAgcmV0dXJuIHRhc2tcbiAgICB9XG5cbiAgICAvLyBXYWl0IGJlZm9yZSBwb2xsaW5nIGFnYWluXG4gICAgYXdhaXQgc2xlZXAoMTAwKVxuICB9XG5cbiAgLy8gVGltZW91dCAtIHJldHVybiBjdXJyZW50IHN0YXRlXG4gIGNvbnN0IGZpbmFsU3RhdGUgPSBnZXRBcHBTdGF0ZSgpXG4gIHJldHVybiAoZmluYWxTdGF0ZS50YXNrcz8uW3Rhc2tJZF0gYXMgVGFza1N0YXRlKSA/PyBudWxsXG59XG5cbmV4cG9ydCBjb25zdCBUYXNrT3V0cHV0VG9vbDogVG9vbDxJbnB1dFNjaGVtYSwgVGFza091dHB1dFRvb2xPdXRwdXQ+ID1cbiAgYnVpbGRUb29sKHtcbiAgICBuYW1lOiBUQVNLX09VVFBVVF9UT09MX05BTUUsXG4gICAgc2VhcmNoSGludDogJ3JlYWQgb3V0cHV0L2xvZ3MgZnJvbSBhIGJhY2tncm91bmQgdGFzaycsXG4gICAgbWF4UmVzdWx0U2l6ZUNoYXJzOiAxMDBfMDAwLFxuICAgIHNob3VsZERlZmVyOiB0cnVlLFxuICAgIC8vIEJhY2t3YXJkcy1jb21wYXRpYmxlIGFsaWFzZXMgZm9yIHJlbmFtZWQgdG9vbHNcbiAgICBhbGlhc2VzOiBbJ0FnZW50T3V0cHV0VG9vbCcsICdCYXNoT3V0cHV0VG9vbCddLFxuXG4gICAgdXNlckZhY2luZ05hbWUoKSB7XG4gICAgICByZXR1cm4gJ1Rhc2sgT3V0cHV0J1xuICAgIH0sXG5cbiAgICBnZXQgaW5wdXRTY2hlbWEoKTogSW5wdXRTY2hlbWEge1xuICAgICAgcmV0dXJuIGlucHV0U2NoZW1hKClcbiAgICB9LFxuXG4gICAgYXN5bmMgZGVzY3JpcHRpb24oKSB7XG4gICAgICByZXR1cm4gJ1tEZXByZWNhdGVkXSDigJQgcHJlZmVyIFJlYWQgb24gdGhlIHRhc2sgb3V0cHV0IGZpbGUgcGF0aCdcbiAgICB9LFxuXG4gICAgaXNDb25jdXJyZW5jeVNhZmUoX2lucHV0KSB7XG4gICAgICByZXR1cm4gdGhpcy5pc1JlYWRPbmx5Py4oX2lucHV0KSA/PyBmYWxzZVxuICAgIH0sXG5cbiAgICBpc0VuYWJsZWQoKSB7XG4gICAgICByZXR1cm4gXCJleHRlcm5hbFwiICE9PSAnYW50J1xuICAgIH0sXG5cbiAgICBpc1JlYWRPbmx5KF9pbnB1dCkge1xuICAgICAgcmV0dXJuIHRydWVcbiAgICB9LFxuICAgIHRvQXV0b0NsYXNzaWZpZXJJbnB1dChpbnB1dCkge1xuICAgICAgcmV0dXJuIGlucHV0LnRhc2tfaWRcbiAgICB9LFxuXG4gICAgYXN5bmMgcHJvbXB0KCkge1xuICAgICAgcmV0dXJuIGBERVBSRUNBVEVEOiBQcmVmZXIgdXNpbmcgdGhlIFJlYWQgdG9vbCBvbiB0aGUgdGFzaydzIG91dHB1dCBmaWxlIHBhdGggaW5zdGVhZC4gQmFja2dyb3VuZCB0YXNrcyByZXR1cm4gdGhlaXIgb3V0cHV0IGZpbGUgcGF0aCBpbiB0aGUgdG9vbCByZXN1bHQsIGFuZCB5b3UgcmVjZWl2ZSBhIDx0YXNrLW5vdGlmaWNhdGlvbj4gd2l0aCB0aGUgc2FtZSBwYXRoIHdoZW4gdGhlIHRhc2sgY29tcGxldGVzIOKAlCBSZWFkIHRoYXQgZmlsZSBkaXJlY3RseS5cblxuLSBSZXRyaWV2ZXMgb3V0cHV0IGZyb20gYSBydW5uaW5nIG9yIGNvbXBsZXRlZCB0YXNrIChiYWNrZ3JvdW5kIHNoZWxsLCBhZ2VudCwgb3IgcmVtb3RlIHNlc3Npb24pXG4tIFRha2VzIGEgdGFza19pZCBwYXJhbWV0ZXIgaWRlbnRpZnlpbmcgdGhlIHRhc2tcbi0gUmV0dXJucyB0aGUgdGFzayBvdXRwdXQgYWxvbmcgd2l0aCBzdGF0dXMgaW5mb3JtYXRpb25cbi0gVXNlIGJsb2NrPXRydWUgKGRlZmF1bHQpIHRvIHdhaXQgZm9yIHRhc2sgY29tcGxldGlvblxuLSBVc2UgYmxvY2s9ZmFsc2UgZm9yIG5vbi1ibG9ja2luZyBjaGVjayBvZiBjdXJyZW50IHN0YXR1c1xuLSBUYXNrIElEcyBjYW4gYmUgZm91bmQgdXNpbmcgdGhlIC90YXNrcyBjb21tYW5kXG4tIFdvcmtzIHdpdGggYWxsIHRhc2sgdHlwZXM6IGJhY2tncm91bmQgc2hlbGxzLCBhc3luYyBhZ2VudHMsIGFuZCByZW1vdGUgc2Vzc2lvbnNgXG4gICAgfSxcblxuICAgIGFzeW5jIHZhbGlkYXRlSW5wdXQoeyB0YXNrX2lkIH0sIHsgZ2V0QXBwU3RhdGUgfSkge1xuICAgICAgaWYgKCF0YXNrX2lkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgcmVzdWx0OiBmYWxzZSxcbiAgICAgICAgICBtZXNzYWdlOiAnVGFzayBJRCBpcyByZXF1aXJlZCcsXG4gICAgICAgICAgZXJyb3JDb2RlOiAxLFxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGFwcFN0YXRlID0gZ2V0QXBwU3RhdGUoKVxuICAgICAgY29uc3QgdGFzayA9IGFwcFN0YXRlLnRhc2tzPy5bdGFza19pZF0gYXMgVGFza1N0YXRlIHwgdW5kZWZpbmVkXG5cbiAgICAgIGlmICghdGFzaykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHJlc3VsdDogZmFsc2UsXG4gICAgICAgICAgbWVzc2FnZTogYE5vIHRhc2sgZm91bmQgd2l0aCBJRDogJHt0YXNrX2lkfWAsXG4gICAgICAgICAgZXJyb3JDb2RlOiAyLFxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7IHJlc3VsdDogdHJ1ZSB9XG4gICAgfSxcblxuICAgIGFzeW5jIGNhbGwoXG4gICAgICBpbnB1dDogVGFza091dHB1dFRvb2xJbnB1dCxcbiAgICAgIHRvb2xVc2VDb250ZXh0LFxuICAgICAgX2NhblVzZVRvb2wsXG4gICAgICBfcGFyZW50TWVzc2FnZSxcbiAgICAgIG9uUHJvZ3Jlc3MsXG4gICAgKSB7XG4gICAgICBjb25zdCB7IHRhc2tfaWQsIGJsb2NrLCB0aW1lb3V0IH0gPSBpbnB1dFxuXG4gICAgICBjb25zdCBhcHBTdGF0ZSA9IHRvb2xVc2VDb250ZXh0LmdldEFwcFN0YXRlKClcbiAgICAgIGNvbnN0IHRhc2sgPSBhcHBTdGF0ZS50YXNrcz8uW3Rhc2tfaWRdIGFzIFRhc2tTdGF0ZSB8IHVuZGVmaW5lZFxuXG4gICAgICBpZiAoIXRhc2spIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBObyB0YXNrIGZvdW5kIHdpdGggSUQ6ICR7dGFza19pZH1gKVxuICAgICAgfVxuXG4gICAgICBpZiAoIWJsb2NrKSB7XG4gICAgICAgIC8vIE5vbi1ibG9ja2luZzogcmV0dXJuIGN1cnJlbnQgc3RhdGVcbiAgICAgICAgaWYgKHRhc2suc3RhdHVzICE9PSAncnVubmluZycgJiYgdGFzay5zdGF0dXMgIT09ICdwZW5kaW5nJykge1xuICAgICAgICAgIC8vIE1hcmsgYXMgbm90aWZpZWRcbiAgICAgICAgICB1cGRhdGVUYXNrU3RhdGUodGFza19pZCwgdG9vbFVzZUNvbnRleHQuc2V0QXBwU3RhdGUsIHQgPT4gKHtcbiAgICAgICAgICAgIC4uLnQsXG4gICAgICAgICAgICBub3RpZmllZDogdHJ1ZSxcbiAgICAgICAgICB9KSlcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgZGF0YToge1xuICAgICAgICAgICAgICByZXRyaWV2YWxfc3RhdHVzOiAnc3VjY2VzcycgYXMgY29uc3QsXG4gICAgICAgICAgICAgIHRhc2s6IGF3YWl0IGdldFRhc2tPdXRwdXREYXRhKHRhc2spLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICByZXRyaWV2YWxfc3RhdHVzOiAnbm90X3JlYWR5JyBhcyBjb25zdCxcbiAgICAgICAgICAgIHRhc2s6IGF3YWl0IGdldFRhc2tPdXRwdXREYXRhKHRhc2spLFxuICAgICAgICAgIH0sXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gQmxvY2tpbmc6IHdhaXQgZm9yIGNvbXBsZXRpb25cbiAgICAgIGlmIChvblByb2dyZXNzKSB7XG4gICAgICAgIG9uUHJvZ3Jlc3Moe1xuICAgICAgICAgIHRvb2xVc2VJRDogYHRhc2stb3V0cHV0LXdhaXRpbmctJHtEYXRlLm5vdygpfWAsXG4gICAgICAgICAgZGF0YToge1xuICAgICAgICAgICAgdHlwZTogJ3dhaXRpbmdfZm9yX3Rhc2snLFxuICAgICAgICAgICAgdGFza0Rlc2NyaXB0aW9uOiB0YXNrLmRlc2NyaXB0aW9uLFxuICAgICAgICAgICAgdGFza1R5cGU6IHRhc2sudHlwZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9KVxuICAgICAgfVxuXG4gICAgICBjb25zdCBjb21wbGV0ZWRUYXNrID0gYXdhaXQgd2FpdEZvclRhc2tDb21wbGV0aW9uKFxuICAgICAgICB0YXNrX2lkLFxuICAgICAgICB0b29sVXNlQ29udGV4dC5nZXRBcHBTdGF0ZSxcbiAgICAgICAgdGltZW91dCxcbiAgICAgICAgdG9vbFVzZUNvbnRleHQuYWJvcnRDb250cm9sbGVyLFxuICAgICAgKVxuXG4gICAgICBpZiAoIWNvbXBsZXRlZFRhc2spIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICByZXRyaWV2YWxfc3RhdHVzOiAndGltZW91dCcgYXMgY29uc3QsXG4gICAgICAgICAgICB0YXNrOiBudWxsLFxuICAgICAgICAgIH0sXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKFxuICAgICAgICBjb21wbGV0ZWRUYXNrLnN0YXR1cyA9PT0gJ3J1bm5pbmcnIHx8XG4gICAgICAgIGNvbXBsZXRlZFRhc2suc3RhdHVzID09PSAncGVuZGluZydcbiAgICAgICkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGRhdGE6IHtcbiAgICAgICAgICAgIHJldHJpZXZhbF9zdGF0dXM6ICd0aW1lb3V0JyBhcyBjb25zdCxcbiAgICAgICAgICAgIHRhc2s6IGF3YWl0IGdldFRhc2tPdXRwdXREYXRhKGNvbXBsZXRlZFRhc2spLFxuICAgICAgICAgIH0sXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gTWFyayBhcyBub3RpZmllZFxuICAgICAgdXBkYXRlVGFza1N0YXRlKHRhc2tfaWQsIHRvb2xVc2VDb250ZXh0LnNldEFwcFN0YXRlLCB0ID0+ICh7XG4gICAgICAgIC4uLnQsXG4gICAgICAgIG5vdGlmaWVkOiB0cnVlLFxuICAgICAgfSkpXG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGRhdGE6IHtcbiAgICAgICAgICByZXRyaWV2YWxfc3RhdHVzOiAnc3VjY2VzcycgYXMgY29uc3QsXG4gICAgICAgICAgdGFzazogYXdhaXQgZ2V0VGFza091dHB1dERhdGEoY29tcGxldGVkVGFzayksXG4gICAgICAgIH0sXG4gICAgICB9XG4gICAgfSxcblxuICAgIG1hcFRvb2xSZXN1bHRUb1Rvb2xSZXN1bHRCbG9ja1BhcmFtKGRhdGEsIHRvb2xVc2VJRCkge1xuICAgICAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW11cblxuICAgICAgcGFydHMucHVzaChcbiAgICAgICAgYDxyZXRyaWV2YWxfc3RhdHVzPiR7ZGF0YS5yZXRyaWV2YWxfc3RhdHVzfTwvcmV0cmlldmFsX3N0YXR1cz5gLFxuICAgICAgKVxuXG4gICAgICBpZiAoZGF0YS50YXNrKSB7XG4gICAgICAgIHBhcnRzLnB1c2goYDx0YXNrX2lkPiR7ZGF0YS50YXNrLnRhc2tfaWR9PC90YXNrX2lkPmApXG4gICAgICAgIHBhcnRzLnB1c2goYDx0YXNrX3R5cGU+JHtkYXRhLnRhc2sudGFza190eXBlfTwvdGFza190eXBlPmApXG4gICAgICAgIHBhcnRzLnB1c2goYDxzdGF0dXM+JHtkYXRhLnRhc2suc3RhdHVzfTwvc3RhdHVzPmApXG5cbiAgICAgICAgaWYgKGRhdGEudGFzay5leGl0Q29kZSAhPT0gdW5kZWZpbmVkICYmIGRhdGEudGFzay5leGl0Q29kZSAhPT0gbnVsbCkge1xuICAgICAgICAgIHBhcnRzLnB1c2goYDxleGl0X2NvZGU+JHtkYXRhLnRhc2suZXhpdENvZGV9PC9leGl0X2NvZGU+YClcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChkYXRhLnRhc2sub3V0cHV0Py50cmltKCkpIHtcbiAgICAgICAgICBjb25zdCB7IGNvbnRlbnQgfSA9IGZvcm1hdFRhc2tPdXRwdXQoXG4gICAgICAgICAgICBkYXRhLnRhc2sub3V0cHV0LFxuICAgICAgICAgICAgZGF0YS50YXNrLnRhc2tfaWQsXG4gICAgICAgICAgKVxuICAgICAgICAgIHBhcnRzLnB1c2goYDxvdXRwdXQ+XFxuJHtjb250ZW50LnRyaW1FbmQoKX1cXG48L291dHB1dD5gKVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGRhdGEudGFzay5lcnJvcikge1xuICAgICAgICAgIHBhcnRzLnB1c2goYDxlcnJvcj4ke2RhdGEudGFzay5lcnJvcn08L2Vycm9yPmApXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdG9vbF91c2VfaWQ6IHRvb2xVc2VJRCxcbiAgICAgICAgdHlwZTogJ3Rvb2xfcmVzdWx0JyBhcyBjb25zdCxcbiAgICAgICAgY29udGVudDogcGFydHMuam9pbignXFxuXFxuJyksXG4gICAgICB9XG4gICAgfSxcblxuICAgIHJlbmRlclRvb2xVc2VNZXNzYWdlKGlucHV0KSB7XG4gICAgICBjb25zdCB7IGJsb2NrID0gdHJ1ZSB9ID0gaW5wdXRcbiAgICAgIGlmICghYmxvY2spIHtcbiAgICAgICAgcmV0dXJuICdub24tYmxvY2tpbmcnXG4gICAgICB9XG4gICAgICByZXR1cm4gJydcbiAgICB9LFxuXG4gICAgcmVuZGVyVG9vbFVzZVRhZyhpbnB1dCkge1xuICAgICAgaWYgKCFpbnB1dC50YXNrX2lkKSB7XG4gICAgICAgIHJldHVybiBudWxsXG4gICAgICB9XG4gICAgICByZXR1cm4gPFRleHQgZGltQ29sb3I+IHtpbnB1dC50YXNrX2lkfTwvVGV4dD5cbiAgICB9LFxuXG4gICAgcmVuZGVyVG9vbFVzZVByb2dyZXNzTWVzc2FnZShwcm9ncmVzc01lc3NhZ2VzKSB7XG4gICAgICBjb25zdCBsYXN0UHJvZ3Jlc3MgPSBwcm9ncmVzc01lc3NhZ2VzW3Byb2dyZXNzTWVzc2FnZXMubGVuZ3RoIC0gMV1cbiAgICAgIGNvbnN0IHByb2dyZXNzRGF0YSA9IGxhc3RQcm9ncmVzcz8uZGF0YSBhc1xuICAgICAgICB8IHsgdGFza0Rlc2NyaXB0aW9uPzogc3RyaW5nOyB0YXNrVHlwZT86IHN0cmluZyB9XG4gICAgICAgIHwgdW5kZWZpbmVkXG5cbiAgICAgIHJldHVybiAoXG4gICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICAgIHtwcm9ncmVzc0RhdGE/LnRhc2tEZXNjcmlwdGlvbiAmJiAoXG4gICAgICAgICAgICA8VGV4dD4mbmJzcDsmbmJzcDt7cHJvZ3Jlc3NEYXRhLnRhc2tEZXNjcmlwdGlvbn08L1RleHQ+XG4gICAgICAgICAgKX1cbiAgICAgICAgICA8VGV4dD5cbiAgICAgICAgICAgICZuYnNwOyZuYnNwOyZuYnNwOyZuYnNwOyZuYnNwO1dhaXRpbmcgZm9yIHRhc2t7JyAnfVxuICAgICAgICAgICAgPFRleHQgZGltQ29sb3I+KGVzYyB0byBnaXZlIGFkZGl0aW9uYWwgaW5zdHJ1Y3Rpb25zKTwvVGV4dD5cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgKVxuICAgIH0sXG5cbiAgICByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShjb250ZW50LCBfLCB7IHZlcmJvc2UsIHRoZW1lIH0pIHtcbiAgICAgIHJldHVybiAoXG4gICAgICAgIDxUYXNrT3V0cHV0UmVzdWx0RGlzcGxheVxuICAgICAgICAgIGNvbnRlbnQ9e2NvbnRlbnR9XG4gICAgICAgICAgdmVyYm9zZT17dmVyYm9zZX1cbiAgICAgICAgICB0aGVtZT17dGhlbWV9XG4gICAgICAgIC8+XG4gICAgICApXG4gICAgfSxcblxuICAgIHJlbmRlclRvb2xVc2VSZWplY3RlZE1lc3NhZ2UoKSB7XG4gICAgICByZXR1cm4gPEZhbGxiYWNrVG9vbFVzZVJlamVjdGVkTWVzc2FnZSAvPlxuICAgIH0sXG5cbiAgICByZW5kZXJUb29sVXNlRXJyb3JNZXNzYWdlKHJlc3VsdCwgeyB2ZXJib3NlIH0pIHtcbiAgICAgIHJldHVybiA8RmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlIHJlc3VsdD17cmVzdWx0fSB2ZXJib3NlPXt2ZXJib3NlfSAvPlxuICAgIH0sXG4gIH0gc2F0aXNmaWVzIFRvb2xEZWY8SW5wdXRTY2hlbWEsIFRhc2tPdXRwdXRUb29sT3V0cHV0PilcblxuZnVuY3Rpb24gVGFza091dHB1dFJlc3VsdERpc3BsYXkoe1xuICBjb250ZW50LFxuICB2ZXJib3NlID0gZmFsc2UsXG4gIHRoZW1lLFxufToge1xuICBjb250ZW50OiBzdHJpbmcgfCBUYXNrT3V0cHV0VG9vbE91dHB1dFxuICB2ZXJib3NlPzogYm9vbGVhblxuICB0aGVtZTogVGhlbWVOYW1lXG59KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgZXhwYW5kU2hvcnRjdXQgPSB1c2VTaG9ydGN1dERpc3BsYXkoXG4gICAgJ2FwcDp0b2dnbGVUcmFuc2NyaXB0JyxcbiAgICAnR2xvYmFsJyxcbiAgICAnY3RybCtvJyxcbiAgKVxuICBjb25zdCByZXN1bHQ6IFRhc2tPdXRwdXRUb29sT3V0cHV0ID1cbiAgICB0eXBlb2YgY29udGVudCA9PT0gJ3N0cmluZycgPyBqc29uUGFyc2UoY29udGVudCkgOiBjb250ZW50XG5cbiAgaWYgKCFyZXN1bHQudGFzaykge1xuICAgIHJldHVybiAoXG4gICAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj5ObyB0YXNrIG91dHB1dCBhdmFpbGFibGU8L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cblxuICBjb25zdCB7IHRhc2sgfSA9IHJlc3VsdFxuXG4gIC8vIEZvciBzaGVsbCB0YXNrcywgcmVuZGVyIGxpa2UgQmFzaFRvb2xSZXN1bHRNZXNzYWdlXG4gIGlmICh0YXNrLnRhc2tfdHlwZSA9PT0gJ2xvY2FsX2Jhc2gnKSB7XG4gICAgY29uc3QgYmFzaE91dCA9IHtcbiAgICAgIHN0ZG91dDogdGFzay5vdXRwdXQsXG4gICAgICBzdGRlcnI6ICcnLFxuICAgICAgaXNJbWFnZTogZmFsc2UsXG4gICAgICBkYW5nZXJvdXNseURpc2FibGVTYW5kYm94OiB0cnVlLFxuICAgICAgcmV0dXJuQ29kZUludGVycHJldGF0aW9uOiB0YXNrLmVycm9yLFxuICAgIH1cbiAgICByZXR1cm4gPEJhc2hUb29sUmVzdWx0TWVzc2FnZSBjb250ZW50PXtiYXNoT3V0fSB2ZXJib3NlPXt2ZXJib3NlfSAvPlxuICB9XG5cbiAgLy8gRm9yIGFnZW50IHRhc2tzLCByZW5kZXIgd2l0aCBwcm9tcHQvcmVzcG9uc2UgZGlzcGxheVxuICBpZiAodGFzay50YXNrX3R5cGUgPT09ICdsb2NhbF9hZ2VudCcpIHtcbiAgICBjb25zdCBsaW5lQ291bnQgPSB0YXNrLnJlc3VsdCA/IGNvdW50Q2hhckluU3RyaW5nKHRhc2sucmVzdWx0LCAnXFxuJykgKyAxIDogMFxuXG4gICAgaWYgKHJlc3VsdC5yZXRyaWV2YWxfc3RhdHVzID09PSAnc3VjY2VzcycpIHtcbiAgICAgIGlmICh2ZXJib3NlKSB7XG4gICAgICAgIHJldHVybiAoXG4gICAgICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgICAgICA8VGV4dD5cbiAgICAgICAgICAgICAge3Rhc2suZGVzY3JpcHRpb259ICh7bGluZUNvdW50fSBsaW5lcylcbiAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIHBhZGRpbmdMZWZ0PXsyfSBtYXJnaW5Ub3A9ezF9PlxuICAgICAgICAgICAgICB7dGFzay5wcm9tcHQgJiYgKFxuICAgICAgICAgICAgICAgIDxBZ2VudFByb21wdERpc3BsYXkgcHJvbXB0PXt0YXNrLnByb21wdH0gdGhlbWU9e3RoZW1lfSBkaW0gLz5cbiAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAge3Rhc2sucmVzdWx0ICYmIChcbiAgICAgICAgICAgICAgICA8Qm94IG1hcmdpblRvcD17MX0+XG4gICAgICAgICAgICAgICAgICA8QWdlbnRSZXNwb25zZURpc3BsYXlcbiAgICAgICAgICAgICAgICAgICAgY29udGVudD17W3sgdHlwZTogJ3RleHQnLCB0ZXh0OiB0YXNrLnJlc3VsdCB9XX1cbiAgICAgICAgICAgICAgICAgICAgdGhlbWU9e3RoZW1lfVxuICAgICAgICAgICAgICAgICAgLz5cbiAgICAgICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAge3Rhc2suZXJyb3IgJiYgKFxuICAgICAgICAgICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIG1hcmdpblRvcD17MX0+XG4gICAgICAgICAgICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCIgYm9sZD5cbiAgICAgICAgICAgICAgICAgICAgRXJyb3I6XG4gICAgICAgICAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICAgICAgICAgICA8Qm94IHBhZGRpbmdMZWZ0PXsyfT5cbiAgICAgICAgICAgICAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPnt0YXNrLmVycm9yfTwvVGV4dD5cbiAgICAgICAgICAgICAgICAgIDwvQm94PlxuICAgICAgICAgICAgICAgIDwvQm94PlxuICAgICAgICAgICAgICApfVxuICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgPC9Cb3g+XG4gICAgICAgIClcbiAgICAgIH1cbiAgICAgIHJldHVybiAoXG4gICAgICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+UmVhZCBvdXRwdXQgKHtleHBhbmRTaG9ydGN1dH0gdG8gZXhwYW5kKTwvVGV4dD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApXG4gICAgfVxuXG4gICAgaWYgKHJlc3VsdC5yZXRyaWV2YWxfc3RhdHVzID09PSAndGltZW91dCcgfHwgdGFzay5zdGF0dXMgPT09ICdydW5uaW5nJykge1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5UYXNrIGlzIHN0aWxsIHJ1bm5pbmfigKY8L1RleHQ+XG4gICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgKVxuICAgIH1cblxuICAgIGlmIChyZXN1bHQucmV0cmlldmFsX3N0YXR1cyA9PT0gJ25vdF9yZWFkeScpIHtcbiAgICAgIHJldHVybiAoXG4gICAgICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+VGFzayBpcyBzdGlsbCBydW5uaW5n4oCmPC9UZXh0PlxuICAgICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICAgIClcbiAgICB9XG5cbiAgICByZXR1cm4gKFxuICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+VGFzayBub3QgcmVhZHk8L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cblxuICAvLyBGb3IgcmVtb3RlIGFnZW50IHRhc2tzXG4gIGlmICh0YXNrLnRhc2tfdHlwZSA9PT0gJ3JlbW90ZV9hZ2VudCcpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgIDxUZXh0PlxuICAgICAgICAgICZuYnNwOyZuYnNwO3t0YXNrLmRlc2NyaXB0aW9ufSBbe3Rhc2suc3RhdHVzfV1cbiAgICAgICAgPC9UZXh0PlxuICAgICAgICB7dGFzay5vdXRwdXQgJiYgdmVyYm9zZSAmJiAoXG4gICAgICAgICAgPEJveCBwYWRkaW5nTGVmdD17NH0gbWFyZ2luVG9wPXsxfT5cbiAgICAgICAgICAgIDxUZXh0Pnt0YXNrLm91dHB1dH08L1RleHQ+XG4gICAgICAgICAgPC9Cb3g+XG4gICAgICAgICl9XG4gICAgICAgIHshdmVyYm9zZSAmJiB0YXNrLm91dHB1dCAmJiAoXG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgICB7JyAgICAgJ30oe2V4cGFuZFNob3J0Y3V0fSB0byBleHBhbmQpXG4gICAgICAgICAgPC9UZXh0PlxuICAgICAgICApfVxuICAgICAgPC9Cb3g+XG4gICAgKVxuICB9XG5cbiAgLy8gRGVmYXVsdCByZW5kZXJpbmdcbiAgcmV0dXJuIChcbiAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgIDxUZXh0PlxuICAgICAgICAmbmJzcDsmbmJzcDt7dGFzay5kZXNjcmlwdGlvbn0gW3t0YXNrLnN0YXR1c31dXG4gICAgICA8L1RleHQ+XG4gICAgICB7dGFzay5vdXRwdXQgJiYgKFxuICAgICAgICA8Qm94IHBhZGRpbmdMZWZ0PXs0fT5cbiAgICAgICAgICA8VGV4dD57dGFzay5vdXRwdXQuc2xpY2UoMCwgNTAwKX08L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgKX1cbiAgICA8L0Jv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