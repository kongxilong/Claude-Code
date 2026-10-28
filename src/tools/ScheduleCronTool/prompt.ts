/**
 * ============================================================================
 *  【文件总览】src/tools/ScheduleCronTool/prompt.ts
 *              —— cron 工具族的「开关 + 常量 + 说明文案」
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件是 ScheduleCronTool 目录的**公共配置中心**，放三样东西：
 *   ① 两个功能开关函数（isKairosCronEnabled / isDurableCronEnabled）
 *   ② 三个工具的名字常量
 *   ③ 三个工具的说明文案（而且文案会随开关变化）
 *
 *  【为什么文案要写成"函数"而不是常量？】
 *  因为**文案要跟着开关变**：支持 durable 时才告诉模型"可以传 durable: true"，
 *  不支持时那段说明根本不该出现 —— 说了模型会传，然后被降级，徒增困惑。
 *  所以这里是 `buildCronCreatePrompt(durableEnabled)` 这种"传开关进去、返回文案"的写法。
 *
 *  【在架构中的位置】
 *      CronCreateTool / CronDeleteTool / CronListTool
 *        ├─> isKairosCronEnabled()   → 决定工具**注不注册**
 *        ├─> isDurableCronEnabled()  → 决定 durable 参数**生不生效**
 *        └─> buildXxxPrompt()        → 生成给模型看的说明
 *      注意：本目录**没有** constants.ts，工具名常量就放在本文件里。
 *
 *  【★ 两层开关的区别（本文件最需要理解的设计）】
 *      isKairosCronEnabled()   总开关：关掉 → 整个 cron 功能**完全不存在**
 *                              = 编译期 feature('AGENT_TRIGGERS') + 运行时灰度 + 本地环境变量
 *      isDurableCronEnabled()  窄开关：只关掉"写盘持久化"这一种能力，
 *                              会话内（内存）的定时任务**照常可用**
 *  为什么要分两层：durable 涉及往用户磁盘写文件、还会跨会话复活，风险更高，
 *  出问题时希望能单独关掉它，而不至于把整个定时功能一起废掉。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（Java 工程师视角，只列本文件真正出现的）
 * ---------------------------------------------------------------------------
 *  - `feature('AGENT_TRIGGERS')`：**编译期**开关，来自 `bun:bundle`。
 *    打包时替换成 true/false，再把整段代码 tree-shaking 删掉（DCE）。
 *    ≈ C 的 `#ifdef`。⚠️ 它不是运行时 if：不能赋给变量再判断，
 *    只能出现在 if / 三元的条件位置（所以下面写成了三元表达式的形式）。
 *  - `{@link isKairosCronEnabled}`：JSDoc 的交叉引用标记，
 *    ≈ Java 的 `{@link SomeClass#method}`，IDE 里可以点着跳转。
 *  - 模板字符串 `` `...${x}...` `` ≈ Java 的文本块（"""），可换行可插值。
 *    本文件里那些大段英文说明都是模板字符串。
 *  - `` \`0 9\` `` ：模板字符串里想显示反引号，必须用反斜杠转义。
 *    这是初学者最容易看晕的地方（Java 文本块里没这问题）。
 *  - `export function f(a: boolean): string`：显式标注参数和返回值类型。
 *    类型在**后面**（Java 在前面）。
 *  - `X ? A : B` 三元表达式 ≈ Java 三目运算符，本文件里大量使用（按开关选文案）。
 */
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../services/analytics/growthbook.js'
import { DEFAULT_CRON_JITTER_CONFIG } from '../../utils/cronTasks.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

// 灰度开关的刷新间隔：5 分钟。
// 为什么不是每次都实时查：GrowthBook 的值要走网络/读磁盘缓存，每次都查太慢；
// 5 分钟既能及时响应"紧急关停"，又不至于拖慢工具调用。
const KAIROS_CRON_REFRESH_MS = 5 * 60 * 1000

// 循环任务的自动过期天数（由毫秒换算成天）。
// 为什么要自动过期：一个"每天 9 点"的任务如果用户忘了取消，
// 它会永远存在下去。给一个上限，等于给会话寿命封顶。
export const DEFAULT_MAX_AGE_DAYS =
  DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs / (24 * 60 * 60 * 1000)

/**
 * Unified gate for the cron scheduling system. Combines the build-time
 * `feature('AGENT_TRIGGERS')` flag (dead code elimination) with the runtime
 * `tengu_kairos_cron` GrowthBook gate on a 5-minute refresh window.
 *
 * AGENT_TRIGGERS is independently shippable from KAIROS — the cron module
 * graph (cronScheduler/cronTasks/cronTasksLock/cron.ts + the three tools +
 * /loop skill) has zero imports into src/assistant/ and no feature('KAIROS')
 * calls. The REPL.tsx kairosEnabled read is safe:
 * kairosEnabled is unconditionally in AppStateStore with default false, so
 * when KAIROS is off the scheduler just gets assistantMode: false.
 *
 * Called from Tool.isEnabled() (lazy, post-init) and inside useEffect /
 * imperative setup, never at module scope — so the disk cache has had a
 * chance to populate.
 *
 * The default is `true` — /loop is GA (announced in changelog). GrowthBook
 * is disabled for Bedrock/Vertex/Foundry and when DISABLE_TELEMETRY /
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC are set; a `false` default would
 * break /loop for those users (GH #31759). The GB gate now serves purely as
 * a fleet-wide kill switch — flipping it to `false` stops already-running
 * schedulers on their next isKilled poll tick, not just new ones.
 *
 * `CLAUDE_CODE_DISABLE_CRON` is a local override that wins over GB.
 */
/**
 * 【中文补充】cron 定时系统的**总开关**。
 *
 * 三层判断，全部通过才启用：
 *   ① feature('AGENT_TRIGGERS')            **编译期**：这个功能有没有编进产物
 *   ② !isEnvTruthy(CLAUDE_CODE_DISABLE_CRON) 本地环境变量，**优先级最高**（本地覆盖）
 *   ③ getFeatureValue_CACHED_WITH_REFRESH(...) 运行时灰度开关（可 fleet-wide 关停）
 *
 * 默认值为 true：/loop 已经正式发布了，如果默认 false，
 * 那些用不上 GrowthBook 的用户（Bedrock/Vertex/Foundry、或关了遥测的）
 * 会直接失去这个功能。灰度开关现在的定位是"紧急关停按钮"，而不是"发布开关"。
 *
 * @returns true 表示整个 cron 功能可用（三个工具都会注册）。
 */
export function isKairosCronEnabled(): boolean {
  return feature('AGENT_TRIGGERS')
    ? !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON) &&
        getFeatureValue_CACHED_WITH_REFRESH(
          'tengu_kairos_cron',
          true,
          KAIROS_CRON_REFRESH_MS,
        )
    : false
}

/**
 * Kill switch for disk-persistent (durable) cron tasks. Narrower than
 * {@link isKairosCronEnabled} — flipping this off forces `durable: false` at
 * the call() site, leaving session-only cron (in-memory, GA) untouched.
 *
 * Defaults to `true` so Bedrock/Vertex/Foundry and DISABLE_TELEMETRY users get
 * durable cron. Does NOT consult CLAUDE_CODE_DISABLE_CRON (that kills the whole
 * scheduler via isKairosCronEnabled).
 */
/**
 * 【中文补充】"写盘持久化（durable）"的**独立开关**。
 *
 * 它比总开关窄得多：关掉它只是**强制所有任务都变成会话内任务**，
 * 定时功能本身照常可用。这样出问题时可以只掐掉高风险的那部分。
 *
 * 注意它**不看** CLAUDE_CODE_DISABLE_CRON —— 那个环境变量是 kill 整个调度器的
 * （走 isKairosCronEnabled），两者职责不要混。
 *
 * @returns true 表示允许 durable（写进 .claude/scheduled_tasks.json）。
 */
export function isDurableCronEnabled(): boolean {
  return getFeatureValue_CACHED_WITH_REFRESH(
    'tengu_kairos_cron_durable',
    true,
    KAIROS_CRON_REFRESH_MS,
  )
}

// 三个工具的名字常量。放在本文件（本目录没有 constants.ts）——
// 集中定义的好处：改名只改一行，拼错会在编译期报错。
export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

/**
 * 生成 CronCreate 的一句话描述。
 *
 * @param durableEnabled 是否支持写盘持久化 —— **决定了描不描述 durable 这个参数**。
 *                       不支持时就不提它，免得模型传了又被悄悄降级，白白困惑。
 */
export function buildCronCreateDescription(durableEnabled: boolean): string {
  return durableEnabled
    ? 'Schedule a prompt to run at a future time — either recurring on a cron schedule, or once at a specific time. Pass durable: true to persist to .claude/scheduled_tasks.json; otherwise session-only.'
    : 'Schedule a prompt to run at a future time within this Claude session — either recurring on a cron schedule, or once at a specific time.'
}

/**
 * 生成 CronCreate 的完整说明。这段 prompt 里藏着几条**踩过坑才有的规则**：
 *
 *   ① cron 用**本地时区**，模型不需要做任何时区换算
 *      （曾经模型会自作主张把 "9am" 当成 UTC 去转，结果全错）
 *   ② 一次性任务必须把 分/时/日/月 都**钉死**成具体值
 *      （否则 "remind me at 2:30pm" 会被写成每天下午 2:30 的循环任务）
 *   ③ **避开 :00 和 :30**：所有用户说"9 点"都会变成 `0 9`、说"每小时"都会变成 `0 *`，
 *      于是全球用户的请求会在**同一瞬间**打到 API 上，形成尖峰。
 *      所以请求是大概时间时，故意挑一个"零头"分钟（如 57 分、3 分、7 分）。
 *      —— 这是分布式系统里典型的"抖动 / 去同步"思路，只是放在 prompt 里让模型执行。
 *   ④ 任务只在 REPL **空闲**时触发（不会打断正在进行的对话）；
 *      调度器还会再加一点确定性 jitter 进一步打散尖峰
 *   ⑤ 循环任务 N 天后**自动过期**（触发最后一次后删除），
 *      并且必须主动告诉用户这个上限 —— 否则用户会以为它永远有效
 *
 * @param durableEnabled 是否支持 durable。
 */
export function buildCronCreatePrompt(durableEnabled: boolean): string {
  const durabilitySection = durableEnabled
    ? `## Durability

By default (durable: false) the job lives only in this Claude session — nothing is written to disk, and the job is gone when Claude exits. Pass durable: true to write to .claude/scheduled_tasks.json so the job survives restarts. Only use durable: true when the user explicitly asks for the task to persist ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" / "check back in an hour" requests should stay session-only.`
    : `## Session-only

Jobs live only in this Claude session — nothing is written to disk, and the job is gone when Claude exits.`

  const durableRuntimeNote = durableEnabled
    ? 'Durable jobs persist to .claude/scheduled_tasks.json and survive session restarts — on next launch they resume automatically. One-shot durable tasks that were missed while the REPL was closed are surfaced for catch-up. Session-only jobs die with the process. '
    : ''

  return `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

${durabilitySection}

## Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). ${durableRuntimeNote}The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the ${DEFAULT_MAX_AGE_DAYS}-day limit when scheduling recurring jobs.

Returns a job ID you can pass to ${CRON_DELETE_TOOL_NAME}.`
}

// CronDelete 的一句话描述。
export const CRON_DELETE_DESCRIPTION = 'Cancel a scheduled cron job by ID'
/**
 * 生成 CronDelete 的说明。同样按 durableEnabled 区分：
 * 支持 durable 时说明"会从磁盘文件里移除"，不支持时只说内存。
 */
export function buildCronDeletePrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from .claude/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).`
    : `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from the in-memory session store.`
}

// CronList 的一句话描述。
export const CRON_LIST_DESCRIPTION = 'List scheduled cron jobs'
/**
 * 生成 CronList 的说明。同样按 durableEnabled 区分（是否提到磁盘上的任务）。
 */
export function buildCronListPrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME}, both durable (.claude/scheduled_tasks.json) and session-only.`
    : `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME} in this session.`
}
