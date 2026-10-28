/**
 * ============================================================================
 *  【文件总览】src/tools/ScheduleCronTool/CronListTool.ts
 *              —— 列出当前所有定时任务
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 CronList 工具：把当前所有定时任务（内存里的 + 磁盘上的）列出来。
 *
 *  【在架构中的位置】
 *      模型输出 tool_use（name = "CronList"）
 *        └─> 本文件 CronListTool.call()                     ← ★ 你在这里
 *              └─> listAllCronTasks()  src/utils/cronTasks.ts → 合并"内存 + 磁盘"两处任务
 *
 *  【本文件包含什么】
 *   1. call()                列出任务（**会按 agent 过滤**）
 *   2. mapToolResultToToolResultBlockParam()  渲染成每行一条的文本
 *
 *  【★ 可见性规则（和 CronDelete 的删除权限一致）】
 *      teammate      → 只看得到**自己创建的**任务
 *      team-lead/主线程 → 看得到**全部**任务
 *  这样"看得见"和"删得掉"的范围是对齐的：不会出现"看得见但删不掉"的尴尬。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *  - `z.strictObject({})`：空入参 schema。列任务不需要参数，
 *    strict 是为了拒绝模型自作主张加参数。
 *  - `.filter(...)` / `.map(...)` ≈ Java 的 stream().filter() / map()。
 *  - **条件展开**（本文件最值得学的一招）：
 *      `...(t.recurring ? { recurring: true } : {})`
 *    意思是"条件成立才把这对键值塞进对象，否则塞个空对象（等于什么都不塞）"。
 *    ≈ Java 里先 new HashMap 再 if (cond) put(...)，但一行搞定。
 *    这样做是为了**省 token**：值为默认的字段干脆不出现在 JSON 里。
 *  - `? A : B` 三元 ≈ Java 三目运算符；本文件里套了两层。
 *  - `j.durable === false ? '[session-only]' : ''`：
 *    注意用 `===` 全等而不是 `!j.durable` —— 因为 durable 可能是 undefined，
 *    而 undefined 和 false 在这里含义不同（未设置 vs 明确不持久化）。
 *  - `truncate(s, 80, true)`：截断到 80 字符（第三个参数表示加省略号）。
 */
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman } from '../../utils/cron.js'
import { listAllCronTasks } from '../../utils/cronTasks.js'
import { truncate } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronListPrompt,
  CRON_LIST_DESCRIPTION,
  CRON_LIST_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderListResultMessage, renderListToolUseMessage } from './UI.js'

// 空入参：列任务不需要任何参数。strict 挡住模型乱加字段。
const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

// 出参：job 数组。recurring / durable 都是**可选**字段（默认值时不出现）。
const outputSchema = lazySchema(() =>
  z.object({
    jobs: z.array(
      z.object({
        id: z.string(),
        cron: z.string(),
        humanSchedule: z.string(),
        prompt: z.string(),
        recurring: z.boolean().optional(),
        durable: z.boolean().optional(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListOutput = z.infer<OutputSchema>

/**
 * CronListTool 本体。
 *
 * isReadOnly() = true（只读）→ 免权限弹框；
 * isConcurrencySafe() = true → 可以和别的工具并行跑。
 */
export const CronListTool = buildTool({
  name: CRON_LIST_TOOL_NAME,
  // 给 ToolSearch 用的一句话。
  searchHint: 'list active cron jobs',
  maxResultSizeChars: 100_000,
  // 延迟加载，省上下文。
  shouldDefer: true,
  // 懒加载 schema。
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // 总开关没开就不注册。
  isEnabled() {
    return isKairosCronEnabled()
  },
  // 只读操作，可并行。
  isConcurrencySafe() {
    return true
  },
  // 只读 → 不弹权限框。
  isReadOnly() {
    return true
  },
  // 一句话描述（常量在 prompt.ts）。
  async description() {
    return CRON_LIST_DESCRIPTION
  },
  // 说明文案随"是否支持 durable"变化（见 prompt.ts）。
  async prompt() {
    return buildCronListPrompt(isDurableCronEnabled())
  },
  /**
   * 列出所有定时任务（按当前身份过滤）。
   *
   * 为什么需要：模型要先知道"现在有哪些定时任务"，才能决定
   * 要不要取消一个、或者是不是已经建过重复的了。
   *
   * @returns `{ data: { jobs } }`。
   *
   * 关键步骤：
   *   ① listAllCronTasks() 把"内存会话内"和"磁盘 durable"两处任务合并成一份
   *   ② 按身份过滤：teammate 只留自己的，主线程看全部
   *   ③ 逐条映射：cron 表达式翻成人话；**默认值的字段直接省略**（省 token）
   */
  async call() {
    // 两个来源都要：内存里的（会话内任务）+ 磁盘上的（durable 任务）。
    const allTasks = await listAllCronTasks()
    // 【中文补充】teammate 只看自己的任务；team-lead（没有 ctx）看全部。
    // Teammates only see their own crons; team lead (no ctx) sees all.
    // getTeammateContext() 返回 null 表示"当前不是 teammate"（即主线程/team-lead）。
    const ctx = getTeammateContext()
    // 有 ctx 就按 agentId 过滤 —— 保证"看得见的就能删"（和 CronDelete 的规则对齐）。
    const tasks = ctx
      ? allTasks.filter(t => t.agentId === ctx.agentId)
      : allTasks
    // 逐条压缩。注意下面两个条件展开：默认值字段干脆不输出，省 token。
    const jobs = tasks.map(t => ({
      id: t.id,
      cron: t.cron,
      humanSchedule: cronToHuman(t.cron),
      prompt: t.prompt,
      // 条件展开：recurring 为 true 时才把它写进对象。
      // 反之（false 或 undefined）则什么都不加 —— 展开一个空对象 {} 等于没加。
      ...(t.recurring ? { recurring: true } : {}),
      // 同理：只有**明确**是 false 时才输出 durable: false。
      // 用 `=== false` 而不是 `!t.durable`：undefined（老数据里没这个字段）
      // 和 false（明确不持久化）含义不同，不能混为一谈。
      ...(t.durable === false ? { durable: false } : {}),
    }))
    // 直接返回 jobs 数组（空数组也是合法结果，下面渲染时会显示 "No scheduled jobs"）。
    return { data: { jobs } }
  },
  /**
   * 把任务列表渲染成每行一条的文本。
   * 例：`job_1 — 每 5 分钟 (recurring) [session-only]: 检查部署状态`
   *
   * 为什么 prompt 要 truncate 到 80 字符：定时任务可能有很多条，
   * 每条都把完整 prompt 打出来会非常浪费上下文。
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
    // 有任务 → 逐条渲染；没有 → 一句 "No scheduled jobs."（比空字符串友好得多）。
        output.jobs.length > 0
          ? output.jobs
              .map(
                j =>
          // 一行里塞了四件事：id、人话时间、是否循环、是否仅会话内、prompt 预览。
          // 括号标记（recurring）/（one-shot）和 [session-only] 都是**可选**的，
          // 只在需要区分时才出现。
                  `${j.id} — ${j.humanSchedule}${j.recurring ? ' (recurring)' : ' (one-shot)'}${j.durable === false ? ' [session-only]' : ''}: ${truncate(j.prompt, 80, true)}`,
              )
              .join('\n')
          // 空列表时给一句明确的话，避免模型拿到空字符串后不知道是没有还是出错。
          : 'No scheduled jobs.',
    }
  },
  // 渲染函数在 UI.tsx。
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)
