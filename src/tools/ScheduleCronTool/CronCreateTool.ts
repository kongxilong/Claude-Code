/**
 * ============================================================================
 *  【文件总览】src/tools/ScheduleCronTool/CronCreateTool.ts
 *              —— 新建一个定时任务（cron job）：到点就把一条 prompt 塞进队列
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 CronCreate 工具：按 **cron 表达式** 定时把一段 prompt
 *  塞进 Claude 的消息队列，让它在指定时间自动"想一件事"。
 *
 *  【★ 什么是 cron？—— Java 工程师应该很熟】
 *  cron 是 Unix 的定时任务表达式，5 个字段，空格分隔：
 *
 *      ┌───────── 分钟 (0-59)
 *      │ ┌─────── 小时 (0-23)
 *      │ │ ┌───── 日 (1-31)
 *      │ │ │ ┌─── 月 (1-12)
 *      │ │ │ │ ┌─ 星期 (0-7，0 和 7 都是周日)
 *      │ │ │ │ │
 *      * * * * *
 *
 *  例："*/5 * * * *" = 每 5 分钟；"0 9 * * 1-5" = 工作日早上 9 点。
 *  ≈ Java 的 `@Scheduled(cron = "0 9 * * 1-5")` 或 Quartz 的 CronTrigger，
 *  但这里**不是**"定时执行一段代码"，而是"定时把一句话塞给 AI 去想"。
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "CronCreate"）
 *        └─> 本文件 CronCreateTool.call()                        ← ★ 你在这里
 *              ├─> addCronTask()          src/utils/cronTasks.ts → 登记这个 job（写内存/写磁盘）
 *              ├─> setScheduledTasksEnabled(true) src/bootstrap/state.ts → 打开调度器的开关
 *              └─> cronToHuman()          src/utils/cron.ts      → 把 "*/5 * * * *" 翻成"每 5 分钟"
 *      （同一目录的 CronDeleteTool / CronListTool 分别是取消和列表）
 *
 *  【★ 两种任务的生存期 —— 本文件最需要理解的概念】
 *      recurring = true （默认）  按 cron 反复触发，直到被删除或**自动过期**
 *      recurring = false         只在下一次匹配时触发一次，然后自动删除（"提醒我"场景）
 *
 *      durable = false（默认）    只存在**内存**里，Claude 一退出就没了
 *      durable = true            写到 .claude/scheduled_tasks.json，**重启后还在**
 *
 *  为什么默认 durable=false：绝大多数定时需求是"5 分钟后提醒我"这种，
 *  写盘会留下垃圾，而且用户没要求"永久"时悄悄写盘是越界的。
 *
 *  【本文件包含什么】
 *   1. inputSchema / outputSchema   cron / prompt / recurring / durable 四个入参
 *   2. validateInput()             四道校验（见下面的 JSDoc）
 *   3. call()                      登记 job 并打开调度器
 *   4. mapToolResultToToolResultBlockParam()  把结果说清楚（尤其要说清"存在哪"）
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（Java 工程师视角，只列本文件真正出现的）
 * ---------------------------------------------------------------------------
 *  - `async call({ cron, prompt, recurring = true, durable = false })`：
 *    解构 + **默认值**，一行搞定"传了就用传的，没传用默认"。
 *    ≈ Java 里写四个 if (x == null) x = 默认。这是 TS 最舒服的语法之一。
 *  - `Promise<ValidationResult>`：显式声明返回类型。类型标注在**后面**
 *    （Java 在前面），初期最容易看串。
 *  - `?:` 在类型里表示可选：`durable?: boolean` ≈ `boolean | undefined`。
 *  - `?.` 可选链：`getTeammateContext()?.agentId` ≈ null 检查后取属性，不会 NPE。
 *  - `??` 空值合并：`a ?? b` 只在 a 是 null/undefined 时取 b。
 *    本文件 `${input.cron ?? ''}` 用它是为了把 undefined 变成空串再拼字符串。
 *  - `X ? A : B` 三元表达式 ≈ Java 三目运算符；本文件里嵌套着用。
 *  - `z.number().min(0).max(600000).default(30000)` 这类 zod 链式调用
 *    ≈ Java 的 Bean Validation 注解 + Builder，但是链式写法。
 *  - `semanticBoolean(...)`：容错包装，模型传字符串 "true"/"false" 也能正确解析。
 *  - `feature('X')`：**编译期**开关（本文件没直接用，但同目录 prompt.ts 用了）。
 *    ≈ C 的 `#ifdef`，打包时替换成 true/false 并把代码 tree-shaking 掉。
 *  - `satisfies ToolDef<...>`（文件末尾）：「按 ToolDef 检查我，但别拓宽我的类型」。
 */
import { z } from 'zod/v4'
import { setScheduledTasksEnabled } from '../../bootstrap/state.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman, parseCronExpression } from '../../utils/cron.js'
import {
  addCronTask,
  getCronFilePath,
  listAllCronTasks,
  nextCronRunMs,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'

// 单个会话最多能挂多少个定时任务。
// 为什么要有上限：每个 job 都要被轮询检查，无上限会让调度循环越来越慢，
// 而且用户很可能忘了取消旧任务 —— 这是防失控的兜底。
const MAX_JOBS = 50

// ── 入参 schema ──────────────────────────────────────────────────────
const inputSchema = lazySchema(() =>
  z.strictObject({
    // cron 表达式。**本地时区**（不是 UTC）—— 这点很重要：
    // 用户说"早上 9 点"就是指他手表上的 9 点，模型不需要做任何时区换算。
    cron: z
      .string()
      .describe(
        'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
      ),
    // 到点时要塞进队列的那句话。注意是"prompt"不是"命令"：
    // 触发时 Claude 会像收到用户输入一样处理它。
    prompt: z.string().describe('The prompt to enqueue at each fire time.'),
    // recurring：true = 反复触发（默认）；false = 只触发一次然后自动删除。
    // 用 semanticBoolean 包一层：模型偶尔会传字符串 "false"，直接当布尔校验会失败。
    recurring: semanticBoolean(z.boolean().optional()).describe(
      `true (default) = fire on every cron match until deleted or auto-expired after ${DEFAULT_MAX_AGE_DAYS} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`,
    ),
    // durable：true = 写进 .claude/scheduled_tasks.json，重启后还在；
    // false（默认）= 只在内存里，Claude 退出就没了。
    // 默认 false 是刻意的：没被明确要求"永久"时，不该悄悄往用户磁盘上写东西。
    durable: semanticBoolean(z.boolean().optional()).describe(
      'true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this Claude session ends. Use true only when the user asks the task to survive across sessions.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// ── 出参 schema ──────────────────────────────────────────────────────
// 回给模型的四件事：job id（以后要用它取消）、人能读懂的时间描述、
// 是否循环、以及是否存在磁盘上。
const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    durable: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>

/**
 * CronCreateTool 本体。
 *
 * 几个关键点：
 *   isEnabled() → isKairosCronEnabled()   总开关（编译期 feature + 运行时灰度）
 *   getPath()   → 定时任务文件的路径      给权限系统做"文件变更追踪"用
 *   shouldDefer → 延迟加载，省上下文
 */
export const CronCreateTool = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  // 给 ToolSearch 用的一句话。
  searchHint: 'schedule a recurring or one-shot prompt',
  maxResultSizeChars: 100_000,
  // 延迟加载：模型要先 ToolSearch 才能用到这个工具。
  shouldDefer: true,
  // 懒加载 schema。
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  // 出参 schema（让模型知道会拿回什么）。
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 总开关没开就完全不注册这个工具。
  isEnabled() {
    return isKairosCronEnabled()
  },
  /**
   * 给安全分类器的一句话摘要：`cron表达式: prompt内容`。
   * 两个都要给 —— 光看 cron 不知道要干什么，光看 prompt 不知道频率。
   */
  toAutoClassifierInput(input) {
    return `${input.cron}: ${input.prompt}`
  },
  // 描述文案随"是否支持 durable"变化（见 prompt.ts）。
  async description() {
    return buildCronCreateDescription(isDurableCronEnabled())
  },
  // 说明文案随"是否支持 durable"变化（见 prompt.ts）。
  async prompt() {
    return buildCronCreatePrompt(isDurableCronEnabled())
  },
  /**
   * 返回这个工具会改动的文件路径。
   *
   * 为什么要实现 getPath：框架靠它做两件事 ——
   *   ① 权限规则匹配（用户可以针对这个文件配允许/拒绝规则）
   *   ② 文件变化追踪（改了就通知相关组件刷新）
   * 即使 durable=false 时不写盘，也返回这个路径，保证规则匹配行为一致。
   */
  getPath() {
    return getCronFilePath()
  },
  /**
   * 执行**前**的四道校验。放在 validateInput 而不是 call 里，
   * 是因为这里返回的结构化错误会被喂回给模型，模型能自己纠正
   * （比如换一个合法表达式）—— 比抛异常友好得多。
   *
   * @param input 入参 { cron, prompt, recurring, durable }。
   * @returns 校验结果；errorCode 区分四类问题。
   *
   * 关键步骤（四道关卡，顺序有讲究）：
   *   ① 语法关：parseCronExpression() 解析不了 → errorCode 1
   *   ② 语义关：能解析但**未来一年内没有任何一次匹配** → errorCode 2
   *      （典型的坑："2 月 30 日"这种不存在的日期，语法合法但永不触发）
   *   ③ 容量关：job 数量已达上限 50 → errorCode 3
   *   ④ 归属关：teammate 不能建 durable 任务 → errorCode 4（见下）
   */
  async validateInput(input): Promise<ValidationResult> {
    // ① 语法校验：5 个字段是否都合法。
    if (!parseCronExpression(input.cron)) {
      return {
        result: false,
        message: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
        errorCode: 1,
      }
    }
    // ② 语义校验：算出下一次触发时间；算不出来（null）说明这个表达式
    //     在未来一年内根本不会命中（例如 "0 0 30 2 *" 二月三十日）。
    //     这一关很重要：语法合法但永不触发的任务会让用户以为设好了，其实永远等不到。
    if (nextCronRunMs(input.cron, Date.now()) === null) {
      return {
        result: false,
        message: `Cron expression '${input.cron}' does not match any calendar date in the next year.`,
        errorCode: 2,
      }
    }
    // ③ 容量校验。注意先 await 拿全量列表 —— 因为要同时统计内存和磁盘上的任务。
    const tasks = await listAllCronTasks()
    if (tasks.length >= MAX_JOBS) {
      return {
        result: false,
        message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
        errorCode: 3,
      }
    }
    // 【中文补充】teammate 不能建 durable 任务。
    // Teammates don't persist across sessions, so a durable teammate cron
    // would orphan on restart (agentId would point to a nonexistent teammate).
      // 【中文补充】为什么：teammate 是临时的，重启后就没了；
      // 而 durable 任务会留在磁盘上、且记录着创建它的 agentId。
      // 重启后那个 agentId 指向一个不存在的 teammate，任务就成了"孤儿" ——
      // 永远没人来消费它，还占着调度器的资源。所以直接禁止这种组合。
    if (input.durable && getTeammateContext()) {
      return {
        result: false,
        message:
          'durable crons are not supported for teammates (teammates do not persist across sessions)',
        errorCode: 4,
      }
    }
    // 四关全过，放行。
    return { result: true }
  },
  /**
   * 登记一个定时任务，并打开调度器。
   *
   * @param input 已解构的入参（recurring 默认 true，durable 默认 false）。
   * @returns `{ data: { id, humanSchedule, recurring, durable } }`。
   *
   * 关键步骤：
   *   ① 计算 effectiveDurable：即使模型要求 durable=true，
   *      只要总开关（isDurableCronEnabled）关着，也强制降级成 false
   *   ② addCronTask() 登记任务；顺便记下创建者的 agentId（用于权限隔离）
   *   ③ setScheduledTasksEnabled(true) **打开调度器开关** ——
   *      没有这一步，任务登记了也不会被触发
   *   ④ 返回 job id（模型之后要用它调 CronDelete）
   */
  async call({ cron, prompt, recurring = true, durable = false }) {
    // 【中文补充】"kill switch（总开关）会强制降级成会话内任务"。
    // Kill switch forces session-only; schema stays stable so the model sees
    // no validation errors when the gate flips mid-session.
    // 【中文补充】为什么在**这里**降级而不是在 schema 里禁掉 durable 字段：
    // 灰度开关可能在会话中途翻转。如果 schema 跟着变，
    // 模型会突然收到"字段不存在"的校验错误，表现得莫名其妙。
    // 保持 schema 稳定、在运行时悄悄降级，对模型是**无感**的。
    const effectiveDurable = durable && isDurableCronEnabled()
    // addCronTask 会把任务加进内存会话；durable=true 时还会写进
    // .claude/scheduled_tasks.json（这一步由它内部决定，本文件不关心细节）。
    const id = await addCronTask(
      cron,
      prompt,
      recurring,
      effectiveDurable,
    // 记下创建者的 agentId：多 agent 场景下，每个 agent 只能看到/删除自己的任务。
    // 主线程（非 teammate）时 getTeammateContext() 返回 null，即"公共任务"。
      getTeammateContext()?.agentId,
    )
    // 【中文补充】打开调度器开关，让任务在本会话内真正开始触发。
    // Enable the scheduler so the task fires in this session. The
    // useScheduledTasks hook polls this flag and will start watching
    // on the next tick. For durable: false tasks the file never changes
    // — check() reads the session store directly — but the enable flag
    // is still what starts the tick loop.
    // 【中文补充】为什么必须显式打开：调度器的 tick 循环是靠一个 flag 驱动的，
    //   （useScheduledTasks 这个 hook 会轮询它，看到 true 才开始 watch）。
    //   即使是"只存在内存里、不写文件"的任务，这个开关也是启动循环的唯一入口。
    setScheduledTasksEnabled(true)
    // humanSchedule 是给人看的时间描述（"每 5 分钟"），
    // 模型回给用户时用得上，比直接念 "*/5 * * * *" 友好得多。
    return {
      data: {
        id,
        humanSchedule: cronToHuman(cron),
        recurring,
        durable: effectiveDurable,
      },
    }
  },
  /**
   * 把结果说清楚，重点交代**这个任务存在哪、什么时候过期**。
   *
   * 为什么要啰嗦这一句：定时任务最容易踩的坑就是"用户以为它永久有效，
   * 其实 Claude 一关就没了"。所以在结果里显式说明：
   *   durable   → "已写入 .claude/scheduled_tasks.json"
   *   非 durable → "仅本次会话有效，Claude 退出就没了"
   * 并且提醒 recurring 任务有自动过期天数。
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    // 先决定"存在哪"这句描述，下面两个分支复用它。
    const where = output.durable
      ? 'Persisted to .claude/scheduled_tasks.json'
      : 'Session-only (not written to disk, dies when Claude exits)'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
    // 循环任务和一次性任务的文案不同（自动过期 vs 触发一次就删）。
      content: output.recurring
        ? `Scheduled recurring job ${output.id} (${output.humanSchedule}). ${where}. Auto-expires after ${DEFAULT_MAX_AGE_DAYS} days. Use CronDelete to cancel sooner.`
        : `Scheduled one-shot task ${output.id} (${output.humanSchedule}). ${where}. It will fire once then auto-delete.`,
    }
  },
  // 渲染函数都在 UI.tsx（本文件只做引用）。
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
