/**
 * 【一句话定位】后台任务（task）的公共类型与 ID 生成工具：定义任务有哪些种类、有哪些状态、
 * 一份任务状态长什么样，以及如何生成不可猜测的任务 ID。
 *
 * 【在架构中的位置】
 *   上游（谁依赖本文件）：
 *     src/state/AppState.ts        —— AppState 里保存着所有任务的 TaskStateBase（按任务 ID 索引）
 *     TaskOutputTool / TaskStopTool —— 读取任务输出、杀掉任务时要用这里的类型与状态判断
 *     BashTool 的后台执行（run_in_background）—— 生成一个 local_bash 任务
 *     AgentTool 的异步子 agent     —— 生成一个 local_agent / remote_agent 任务
 *     src/Tool.ts 的 ToolUseContext.setAppStateForTasks —— 任务状态通过它写入
 *   下游（本文件依赖谁）：
 *     node:crypto（randomBytes）—— 生成随机 ID
 *     ./utils/task/diskOutput.js（getTaskOutputPath）—— 任务输出落盘的路径
 *   调用链：
 *     用户/工具发起后台任务 → generateTaskId(type) 生成 ID
 *       → createTaskStateBase(...) 造出初始状态（status='pending'）
 *       → 写进 AppState.tasks → 任务真正跑起来后把 status 改成 running / completed / failed / killed
 *       → 需要停止时走 Task.kill(taskId, setAppState)
 *       → 收尾时用 isTerminalTaskStatus(status) 判断是否还能往里注入消息 / 是否可以被回收
 *
 * 【本文件包含什么】
 *   TaskType      —— 任务种类：本地 shell、本地/远程 agent、进程内 teammate、本地 workflow、MCP 监控、dream
 *   TaskStatus    —— 任务状态机：pending → running → (completed | failed | killed)
 *   isTerminalTaskStatus() —— 判断状态是否已经是终态（不会再变化）
 *   TaskStateBase —— 所有任务状态共有的字段（id、type、status、输出文件、偏移量等）
 *   Task          —— 任务「类型分发」用的最小接口：名字 + 类型 + kill 方法
 *   TaskContext / SetAppState / TaskHandle —— 任务运行时上下文与句柄
 *   TASK_ID_PREFIXES / getTaskIdPrefix() —— 不同任务类型用不同 ID 前缀（看 ID 就知道是什么任务）
 *   generateTaskId() —— 生成「前缀 + 8 位随机字符」的任务 ID
 *   createTaskStateBase() —— 造一份初始任务状态
 *   LocalShellSpawnInput —— 启动本地 shell 任务所需的入参
 *
 * 【TS 语法速查】（针对本文件实际出现的写法，Java 工程师对照看）
 *   1. `type X = 'a' | 'b' | 'c'` 是【字符串字面量联合类型】≈ Java enum，但它编译后就是普通字符串，
 *      没有枚举对象、没有 ordinal，好处是序列化/反序列化零成本；坏处是拼错字符串编译器会立刻报错（这正是想要的）。
 *   2. 类型标注在【后面】：`function f(type: TaskType): string` ≈ Java `String f(TaskType type)`。
 *   3. `Record<string, string>` ≈ Java Map<String, String>（键是任意字符串、值是字符串的类型化字典）。
 *   4. `foo?: T` 可选字段 ≈ 可能为 null 的字段，但语义是「可以不存在这个键」，用的时候编译器会强制你先判空。
 *   5. `bytes[i]!` 中的 `!` 是【非空断言】≈ Java 的强制类型转换：告诉编译器「我知道它不是 null/undefined，别报错」。
 *      它不做任何运行时检查——用错了照样是运行时 undefined 错误，所以要慎用。
 *   6. `?? 'x'` 空值合并：左边是 null/undefined 才取右边。与 `||` 的区别是 0 和 '' 不会被替换。
 *   7. `const` ≈ final（不可重新赋值），`let` ≈ 普通局部变量（可以重新赋值）。
 *   8. `export type { ... }` 只导出类型，编译后完全消失（Java 里没有对应概念，相当于只在编译期存在的声明）。
 *   9. `cleanup?: () => void` 是【可选的函数字段】≈ Java 里一个可能为 null 的 Runnable 字段。
 *  10. `(f: (prev: AppState) => AppState) => void` 是「接收一个更新函数」的 setter 签名，
 *      ≈ Java 的 Consumer<UnaryOperator<AppState>>，React 状态更新的常见套路。
 */
import { randomBytes } from 'crypto'
import type { AppState } from './state/AppState.js'
import type { AgentId } from './types/ids.js'
import { getTaskOutputPath } from './utils/task/diskOutput.js'

// 任务种类。用字面量联合而不是 enum：值直接就是字符串，日志和 JSON 里看到的就是它，不需要转换。
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

// 任务状态机：pending（已创建未开始）→ running → 终态（completed 成功 / failed 失败 / killed 被杀）。
// 注意 killed 与 failed 分开：被用户主动杀掉不算失败，UI 与统计上要区别对待。
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

/**
 * True when a task is in a terminal state and will not transition further.
 * Used to guard against injecting messages into dead teammates, evicting
 * finished tasks from AppState, and orphan-cleanup paths.
 */
/** 判断某个状态是否已是【终态】（不会再发生状态迁移）。
 *  入参 status：任务状态
 *  返回 true 表示任务已经结束（成功 / 失败 / 被杀）
 *  为什么需要它：三处关键判断都要靠它——
 *    ① 不再往已经死掉的 teammate 里注入消息（否则消息石沉大海）
 *    ② 把已结束的任务从 AppState 里清出去，避免状态无限膨胀
 *    ③ 孤儿任务清理逻辑
 *  注意 pending 和 running 都不是终态：pending 的任务可能还没开始跑，不能当死任务回收。
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

// 启动任务后拿到的「句柄」：taskId 用来后续查询/杀掉任务，cleanup 是可选的清理回调（释放子进程、文件句柄等）。
export type TaskHandle = {
  taskId: string
  cleanup?: () => void
}

export type SetAppState = (f: (prev: AppState) => AppState) => void
// SetAppState 是「传一个更新函数」的 setter 类型 ≈ Consumer<UnaryOperator<AppState>>：
// 调用方写 setAppState(prev => ({...prev, tasks: ...}))，由框架保证并发更新按序应用。

// 任务运行时的最小上下文：abortController（取消信号）+ 读写 AppState 的两个函数。
export type TaskContext = {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

// Base fields shared by all task states
// 所有任务状态共有的基础字段。各具体任务类型（bash / agent / workflow ...）再在它基础上加自己的字段。
// 关键字段说明：
//   outputFile   —— 任务输出写到磁盘上的哪个文件（任务可能跑很久、输出很大，不留在内存里）
//   outputOffset —— 已读取到哪个字节：TaskOutputTool 靠它做「增量读取」，每次只返回新增的输出
//   notified     —— 是否已经通知过用户（避免同一个任务反复弹通知）
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

// 启动一个本地 shell 任务所需的入参。kind 字段决定 UI 怎么展示：
// 'bash' 用描述当标签，'monitor' 则是弹窗标题 / 状态栏小胶囊（用于长时间监控类命令）。
export type LocalShellSpawnInput = {
  command: string
  description: string
  timeout?: number
  toolUseId?: string
  agentId?: AgentId
  /** UI display variant: description-as-label, dialog title, status bar pill. */
  kind?: 'bash' | 'monitor'
}

// What getTaskByType dispatches for: kill. spawn/render were never
// called polymorphically (removed in #22546). All six kill implementations
// use only setAppState — getAppState/abortController were dead weight.
// Task 是【分发用的最小接口】：上面英文注释解释了为什么要砍到只剩 kill ——
// spawn / render 从来没有被多态调用过（在 #22546 里删掉了），六种任务的 kill 实现又都只用 setAppState，
// 所以 getAppState / abortController 是没用的负担。这体现了「接口只留真正被多态使用的部分」。
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}

// Task ID prefixes
// 不同任务类型用不同 ID 前缀：看到 ID 首字母就知道这是什么任务（b=bash, a=agent, r=remote, t=teammate ...）。
// local_bash 保持 'b' 而不能改成更有意义的前缀：历史会话和磁盘上已有大量 b 开头的 ID，改了就不兼容了。
const TASK_ID_PREFIXES: Record<string, string> = {
  local_bash: 'b', // Keep as 'b' for backward compatibility
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

// Get task ID prefix
/** 取某个任务类型对应的 ID 前缀；遇到未知类型回落到 'x'（而不是抛异常）。
 *  为什么用 ?? 兜底而不是让 Record 索引直接返回 undefined：
 *  Record<string,string> 的索引在技术上是 string（TS 不做穷尽检查），兜底保证 ID 永远格式正确。
 */
function getTaskIdPrefix(type: TaskType): string {
  return TASK_ID_PREFIXES[type] ?? 'x'
// ?? 'x'：万一以后新增了 TaskType 却忘了在这里加前缀，也不会生成出 undefined 开头的畸形 ID。
}

// Case-insensitive-safe alphabet (digits + lowercase) for task IDs.
// 36^8 ≈ 2.8 trillion combinations, sufficient to resist brute-force symlink attacks.
// ID 字符表刻意只用了数字 + 小写字母（36 个）：大小写不敏感的文件系统上也安全，不会出现两个 ID 指向同一文件。
// 8 位 → 36^8 ≈ 2.8 万亿种组合，足够抵抗「猜测任务 ID 去读别人输出文件」的暴力尝试与符号链接攻击。
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 生成一个任务 ID：类型前缀 + 8 位随机字符（如 b7f3a2c1）。
 *  入参 type：任务类型（决定前缀）
 *  返回：形如 'a1b2c3d4' 的任务 ID 字符串
 *  步骤：① 取类型前缀 ② 用 randomBytes(8) 拿 8 个密码学安全的随机字节 ③ 每个字节取模映射到字符表
 *  为什么不用自增序号或时间戳：任务 ID 会出现在文件路径里，可猜测的 ID 会让别的会话有机会读到本会话的输出文件，
 *  所以必须用密码学随机数（randomBytes 而不是 Math.random）。
 */
export function generateTaskId(type: TaskType): string {
  const prefix = getTaskIdPrefix(type)
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length]
// `bytes[i]!` 的 ! 是【非空断言】≈ Java 强制转换：TS 严格模式下索引访问可能返回 undefined，这里由开发者担保不会。
// 用 % length 把 0-255 的字节值映射到 36 个字符（会有极轻微的取模偏差，对 ID 安全性无实质影响）。
  }
  return id
}

/** 造一份任务的初始状态（status 固定为 'pending'，还没开始跑）。
 *  入参 id：任务 ID（由 generateTaskId 生成）
 *  入参 type：任务类型
 *  入参 description：给用户看的一句话描述（UI 里显示「正在做什么」）
 *  入参 toolUseId：可选，触发这个任务的 tool_use 的 ID（用于把任务与某次工具调用关联起来）
 *  返回 TaskStateBase：初始状态对象
 *  几个初值都很有讲究：outputOffset=0（还没读过任何输出）、notified=false（还没通知过用户）、
 *  startTime=Date.now()（用于统计耗时与超时判断）、outputFile=getTaskOutputPath(id)（输出按 ID 落盘）。
 */
export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase {
  return {
    id,
    type,
    status: 'pending',
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
  }
}
