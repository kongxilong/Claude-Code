/**
 * ============================================================================
 *  【文件总览】src/tools/SkillTool/prompt.ts —— Skill 工具的「技能清单」生成器
 * ============================================================================
 *
 *  【一句话定位】
 *  负责两件事：
 *   ① 生成写给模型看的 Skill 工具**使用说明**（getPrompt，纯静态文本）；
 *   ② 生成「当前有哪些 skill 可用」的**列表**（formatCommandsWithinBudget），
 *      并且这个列表必须在**字符预算**之内，超了就截断描述。
 *
 *  先讲清楚 Skill（技能）到底是什么 —— 这是理解整个目录的前提：
 *
 *      Skill = 一个 markdown 文件（SKILL.md），里面写着
 *              「遇到某类任务时，你应该按这些步骤做」的提示词，
 *              外加可选的脚本、参考文档、schema 等附属文件。
 *
 *  它本质上是**可复用的提示词包**：平时不占上下文（只在系统提示里露一行
 *  「名字: 描述」），模型觉得用得上时才通过 Skill 工具把完整内容加载进来。
 *  这就是所谓「渐进式披露（progressive disclosure）」——用多少拿多少。
 *
 *  【在架构中的位置】
 *
 *      src/tools/SkillTool/SkillTool.ts
 *        └─> prompt: async () => getPrompt(getProjectRoot())   ← ★ 本文件
 *
 *      src/utils/commands / src/commands.ts
 *        └─> getSkillToolCommands()  扫描磁盘上的 SKILL.md
 *              └─> 结果传给 formatCommandsWithinBudget()  ← ★ 本文件
 *                    └─> 拼进系统提示（system-reminder）里
 *
 *      src/tools/SkillTool/SkillTool.ts 的 call()
 *        └─> 模型点名要某个 skill 后，才去加载完整 SKILL.md 正文
 *            （加载逻辑不在这里，在 utils/processUserInput/processSlashCommand.ts）
 *
 *  为什么要分「清单」和「正文」两步？因为 skill 可能有几十上百个，
 *  每个正文几千 token，全塞进系统提示会直接把上下文撑爆。
 *  所以本文件做的事就是：**用最小的字符数，让模型知道有哪些 skill 可选**。
 *
 *  【本文件包含什么】（主要函数清单）
 *   1. getCharBudget()              算这次能用多少字符（上下文窗口的 1%）
 *   2. getCommandDescription()      单个 skill 的描述文本 + 硬截断
 *   3. formatCommandDescription()   拼成一行 `- 名字: 描述`
 *   4. formatCommandsWithinBudget() ★核心：在预算内输出完整清单，超预算就降级
 *   5. getPrompt()                  给模型看的 Skill 工具说明书（memoize 缓存）
 *   6. getSkillToolInfo() / getSkillInfo()  给 /context 之类的诊断命令统计数量
 *   7. getLimitedSkillToolCommands() / clearPromptCache()  列表来源与缓存清理
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的语法）
 * ---------------------------------------------------------------------------
 *   - `export function f(a: X): Y`  导出函数。≈ Java `public static Y f(X a)`。
 *     注意：**类型标注在变量名后面**，Java 在前面，初期最容易看串。
 *
 *   - `contextWindowTokens?: number`  参数名后面的 `?` = 可选参数
 *     ≈ Java 的重载，或者传 null；类型实际是 `number | undefined`。
 *
 *   - `commands[i]!`  **非空断言**。TS 数组下标默认可能返回 undefined
 *     （开了 noUncheckedIndexedAccess），`!` 是"我保证这里有值，别报错"
 *     ≈ Java 的 `(Command) list.get(i)` 强转，运行时不检查，纯骗编译器。
 *
 *   - `cmd.type === 'prompt' && cmd.source === 'bundled'`
 *     **字面量类型收窄**：Command 是个联合类型（≈ Java sealed interface），
 *     用 `===` 比较字面量后，TS 就知道进到这个分支里 cmd 一定是
 *     PromptCommand，于是能安全地访问 `cmd.source`。
 *     ≈ Java `if (c instanceof PromptCommand p) { p.getSource() ... }`。
 *
 *   - `(m: UserMessage) => ...` **箭头函数** ≈ Java lambda `m -> ...`。
 *     本文件大量出现在 `.map()` / `.reduce()` / `.filter()` 里
 *     ≈ Java 的 stream().map/filter/reduce。
 *
 *   - `commands.map(cmd => ({ cmd, full: ... }))`
 *     箭头函数直接返回对象时**必须**用小括号包住 `( {...} )`，
 *     否则 `{` 会被当成函数体的大括号。这是新手最常踩的语法坑。
 *
 *   - `reduce((sum, e) => sum + stringWidth(e.full), 0)`
 *     ≈ Java `stream().reduce(0, (sum, e) -> sum + ...)`；第二个参数是初始值。
 *
 *   - `Promise<{ totalCommands: number; includedCommands: number }>`
 *     返回值类型直接写了个匿名对象结构 ≈ Java 里现造一个 record。
 *     TS 不需要先声明类名，随写随用（结构化鸭子类型）。
 *
 *   - `memoize(async (_cwd: string) => ...)`
 *     lodash 的缓存包装器 ≈ Java 的 Guava Cache / Caffeine 的 get(key, loader)。
 *     下划线前缀 `_cwd` 是社区约定：这个参数**故意不用**
 *     （只为让不同调用点共享同一个缓存 key 的形态），
 *     避免 linter 报"未使用的变量"。
 *
 *   - `getPrompt.cache?.clear?.()`  `?.` 可选链 + 可选调用。
 *     ≈ Java `if (getPrompt.cache != null && getPrompt.cache.clear != null) ...`
 *     用在 memoize 产生的 `.cache` 属性上（类型上可能不存在，所以要兜底）。
 *
 *   - `Number(process.env.X)`  环境变量读出来永远是 string | undefined，
 *     要当数字用必须显式转换；`Number(undefined)` 得到 NaN，
 *     而 NaN 是 falsy，所以可以直接放进 if 判断。
 *
 *   - `8_000`  数字里的下划线只是**可读性分隔符**，等价于 8000
 *     （Java 7+ 也有这个语法，很好认）。
 * ============================================================================
 */

import { memoize } from 'lodash-es'
import type { Command } from 'src/commands.js'
import {
  getCommandName,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from 'src/commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { logError } from '../../utils/log.js'

// Skill listing gets 1% of the context window (in characters)
// 中文补充：下面三个常量是在给「技能清单」算预算。
// 设计意图 —— 清单只是"目录"，真正的 skill 正文要等模型点名后才加载，
// 所以清单绝不能占太多上下文。这里定为「上下文窗口的 1%」：
// 200k token 的窗口 × 4 字符/token × 1% = 8000 字符，即 DEFAULT_CHAR_BUDGET。
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
// 1 个 token 大致折算 4 个英文字符（粗估，够用即可）
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // Fallback: 1% of 200k × 4

// Per-entry hard cap. The listing is for discovery only — the Skill tool loads
// full content on invoke, so verbose whenToUse strings waste turn-1 cache_creation
// tokens without improving match rate. Applies to all entries, including bundled,
// since the cap is generous enough to preserve the core use case.
// 中文补充：单条描述最多 250 字符。为什么要卡？
//   - 清单的唯一目的是"让模型知道有这个 skill"，不是"教会模型怎么用"；
//   - 更关键的是：系统提示在每一轮都会作为 cache_creation 计费，
//     首轮（turn-1）尤其贵，写长了只是白花钱，命中率并不会提高。
export const MAX_LISTING_DESC_CHARS = 250

/**
 * 计算本次「技能清单」能用多少字符。
 *
 * 为什么需要：上下文窗口大小因模型而异（200k / 500k / 1m），
 * 清单预算必须按比例缩放，否则小窗口模型会被清单挤爆，
 * 大窗口模型又浪费了本可以多写几句描述的空间。
 *
 * 优先级（越靠前越优先）：
 *   ① 环境变量 SLASH_COMMAND_TOOL_CHAR_BUDGET —— 调试/压测用的强制覆盖；
 *   ② 按传入的 contextWindowTokens 按比例算：tokens × 4 字符 × 1%；
 *   ③ 兜底 DEFAULT_CHAR_BUDGET = 8000。
 *
 * @param contextWindowTokens 当前主模型的上下文窗口大小（token 数），可选
 * @returns 清单可用的字符预算
 */
export function getCharBudget(contextWindowTokens?: number): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}

/**
 * 取单个 skill 的描述文本，并做**硬截断**。
 *
 * 为什么需要：清单里每行只写「名字 + 一句话」，而 skill 的作者可能
 * 在 whenToUse 里写了长长一段。不截断的话，几个啰嗦的 skill 就能
 * 把整个预算吃光，导致后面的 skill 根本显示不出来。
 *
 * 拼接规则：有 whenToUse 时用「描述 - 什么时候用」，否则只写描述。
 * 超过 MAX_LISTING_DESC_CHARS 就切掉尾部并补一个省略号 '…'。
 *
 * @param cmd 一个 skill/command
 * @returns 不超过 250 字符的单行描述
 */
function getCommandDescription(cmd: Command): string {
  // 中文补充：whenToUse 是 SKILL.md frontmatter 里可选的一栏，
  // 专门写"什么场景下该用我"，比 description 更能帮模型做匹配判断。
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : desc
}

/**
 * 把一个 skill 格式化成清单里的一行：`- 名字: 描述`。
 *
 * 为什么需要：模型在清单里看到的是纯文本行，格式必须稳定、可预测，
 * 所以这里统一成 `- ` + 名字 + `: ` + 描述，方便模型解析。
 *
 * 注意一个容易踩的坑：这里用的是 **cmd.name（内部名）** 而不是展示名
 * (userFacingName)。因为模型随后要拿这个名字去调 Skill 工具，
 * 传展示名会找不到。下面那段日志正是在排查「展示名 ≠ 内部名」的情况。
 *
 * @param cmd 一个 skill/command
 * @returns 形如 `- pdf: 处理 PDF 文件...` 的单行文本
 */
function formatCommandDescription(cmd: Command): string {
  // Debug: log if userFacingName differs from cmd.name for plugin skills
  // 中文补充：插件提供的 skill 可能有「展示名」和「内部名」两个名字
  // （例如内部叫 ms-office-suite:pdf，界面上只显示 pdf）。
  // 这里只在 debug 模式下记一行日志，方便定位"界面看到的和模型调用的不是一个东西"。
  const displayName = getCommandName(cmd)
  if (
    cmd.name !== displayName &&
    cmd.type === 'prompt' &&
    cmd.source === 'plugin'
  ) {
    logForDebugging(
      `Skill prompt: showing "${cmd.name}" (userFacingName="${displayName}")`,
    )
  }

  return `- ${cmd.name}: ${getCommandDescription(cmd)}`
}

// 描述长度的下限。低于这个值就没信息量了（连"一句话"都算不上），
// 此时宁可只显示名字也不显示半截描述。
const MIN_DESC_LENGTH = 20

/**
 * ★ 本文件的核心函数：在字符预算内，输出可用的 skill 清单。
 *
 * 为什么需要：系统提示里要列出所有 skill 供模型挑选，但预算是有限的
 * （默认 8000 字符）。skill 多了必然装不下，所以要有**降级策略**，
 * 而不是简单地从中间砍掉一批（那样会随机丢失 skill，非常糟糕）。
 *
 * 降级分三档，逐级变激进：
 *   ① 全都写得下 → 原样输出（正常情况）；
 *   ② 写不下 → 官方内置(bundled) skill 保留完整描述，其余按剩余预算
 *      均摊一个 maxDescLen，逐个 truncate；
 *   ③ 连 maxDescLen 都 < 20 → 只剩名字（`- pdf`），bundled 仍保留描述。
 *
 * 为什么要优待 bundled？内置 skill 是产品承诺的一部分（比如 /help、
 * /review-pr），用户对它们的可用性有预期，不能被第三方 skill 挤掉。
 *
 * 关键步骤：
 *   ① 先算预算，试算"全量描述"的总长度，够用就直接返回（快路径）；
 *   ② 不够用就把命令分成 bundled / 其余两组；
 *   ③ 先扣掉 bundled 占的字数，剩下的按条目数均摊给其余 skill；
 *   ④ 均摊结果太短就降级成"只显示名字"；
 *   ⑤ 两种降级都会打埋点（tengu_skill_descriptions_truncated），
 *      因为截断会直接影响模型的 skill 命中率，是产品上要盯的指标。
 *
 * @param commands 全部候选 skill
 * @param contextWindowTokens 上下文窗口大小，用于算预算
 * @returns 多行文本，每行一个 skill；无 skill 时返回空串
 */
export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
): string {
  if (commands.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens)

  // Try full descriptions first
  // 中文补充：先乐观地按"全量不截断"算一遍总长度，够用就直接返回。
  // 这是绝大多数场景的快路径，避免了后面那堆降级计算。
  const fullEntries = commands.map(cmd => ({
    cmd,
    full: formatCommandDescription(cmd),
  }))
  // join('\n') produces N-1 newlines for N entries
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) +
    (fullEntries.length - 1)

  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n')
  }

  // Partition into bundled (never truncated) and rest
  // 中文补充：用 Set 存"下标"而不是存命令对象，是因为最后输出时要
  // 按**原始顺序**还原整份清单（顺序对模型是稳定的信号，不能打乱）。
  // `Set<number>` ≈ Java 的 Set<Integer>，泛型写在尖括号里，写法一致。
  const bundledIndices = new Set<number>()
  const restCommands: Command[] = []
  for (let i = 0; i < commands.length; i++) {
    // 中文补充：commands[i]! 的 `!` 是"非空断言"。
    // TS 认为数组越界可能拿到 undefined，这里 i 由循环边界保证合法，
    // 就用 ! 让编译器闭嘴 ≈ Java 的 (Command) 强转，运行时不检查。
    const cmd = commands[i]!
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      bundledIndices.add(i)
    } else {
      restCommands.push(cmd)
    }
  }

  // Compute space used by bundled skills (full descriptions, always preserved)
  const bundledChars = fullEntries.reduce(
    (sum, e, i) =>
      bundledIndices.has(i) ? sum + stringWidth(e.full) + 1 : sum,
    0,
  )
  const remainingBudget = budget - bundledChars

  // Calculate max description length for non-bundled commands
  if (restCommands.length === 0) {
    return fullEntries.map(e => e.full).join('\n')
  }

  // 中文补充：每行的固定开销 = 名字宽度 + 4（"- " 两个字符 + ": " 两个字符）。
  // 只有扣掉这部分才是真正留给"描述"的空间。
  const restNameOverhead =
    restCommands.reduce((sum, cmd) => sum + stringWidth(cmd.name) + 4, 0) +
    (restCommands.length - 1)
  // 中文补充：均摊——不按各自长度分配，而是每条一样长。
  // 这样能保证**每个 skill 都还有一口汤喝**，不会出现前几个吃掉全部预算、
  // 后面的 skill 只剩名字的极端不公。
  const availableForDescs = remainingBudget - restNameOverhead
  const maxDescLen = Math.floor(availableForDescs / restCommands.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // Extreme case: non-bundled go names-only, bundled keep descriptions
    // 中文补充：最激进的一档降级——第三方 skill 只留名字，描述全省。
    // 用户的 skill 实在太多了（几百个）才会走到这里。
    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_skill_descriptions_truncated', {
        skill_count: commands.length,
        budget,
        full_total: fullTotal,
        truncation_mode:
          'names_only' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        max_desc_length: maxDescLen,
        bundled_count: bundledIndices.size,
        bundled_chars: bundledChars,
      })
    }
    return commands
      .map((cmd, i) =>
        bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`,
      )
      .join('\n')
  }

  // Truncate non-bundled descriptions to fit within budget
  const truncatedCount = count(
    restCommands,
    cmd => stringWidth(getCommandDescription(cmd)) > maxDescLen,
  )
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_skill_descriptions_truncated', {
      skill_count: commands.length,
      budget,
      full_total: fullTotal,
      truncation_mode:
        'description_trimmed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      max_desc_length: maxDescLen,
      truncated_count: truncatedCount,
      // Count of bundled skills included in this prompt (excludes skills with disableModelInvocation)
      bundled_count: bundledIndices.size,
      bundled_chars: bundledChars,
    })
  }
  return commands
    .map((cmd, i) => {
      // Bundled skills always get full descriptions
      // 中文补充：只截断"其余"，bundled 一字不动地用回 fullEntries 里算好的原文。
      if (bundledIndices.has(i)) return fullEntries[i]!.full
      const description = getCommandDescription(cmd)
      return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
    })
    .join('\n')
}

/**
 * 生成写给模型看的 Skill 工具**使用说明**（也就是工具描述/prompt）。
 *
 * 为什么需要：模型需要知道「什么时候该用 Skill 工具、怎么传参」。
 * 这段文本会作为 Skill 工具的 description 出现在工具列表里，
 * 是模型决定"要不要调用"的唯一依据，所以措辞非常直白、带强指令
 * （比如 "this is a BLOCKING REQUIREMENT"）。
 *
 * 为什么用 memoize 包起来：这段文本是**静态的**，跟 cwd 无关，
 * 每次调用都重新拼一遍纯属浪费；而且工具 prompt 在每轮都可能被取用。
 * memoize ≈ Java 的 Guava Cache.get(key, loader)，同样的 key 只算一次。
 *
 * @param _cwd 当前工作目录；下划线前缀表示**故意不使用**这个参数
 *             （保留它只是为了将来按目录定制 prompt 时不用改调用方）
 * @returns 给模型看的说明文本
 */
export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  // 中文补充：这里是 **模板字符串**（反引号 ` 包裹），可以直接换行、
  // 可以用 ${} 插值 —— ≈ Java 15+ 的文本块（""" ... """）。
  // 里面的 \`skill: "pdf"\` 用了反斜杠转义，否则会提前结束模板字符串。
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`
})

/**
 * 统计「Skill 工具可用命令」的数量，供 /context 之类的诊断命令展示。
 *
 * 为什么需要：用户会问"我到底加载了几个 skill"，以及上下文分析要估算
 * skill 部分占了多 少 token。这里给出的 total 和 included 目前是相等的
 * ——因为预算不够时我们是**截断描述**而不是**丢弃条目**，
 * 所以所有 skill 都算"已包含"。
 *
 * @param cwd 当前工作目录（skill 是按目录扫描的）
 * @returns { totalCommands, includedCommands } 总数与实际展示数
 */
export async function getSkillToolInfo(cwd: string): Promise<{
  totalCommands: number
  includedCommands: number
}> {
  const agentCommands = await getSkillToolCommands(cwd)

  return {
    totalCommands: agentCommands.length,
    includedCommands: agentCommands.length,
  }
}

// Returns the commands included in the SkillTool prompt.
// All commands are always included (descriptions may be truncated to fit budget).
// Used by analyzeContext to count skill tokens.
// 中文补充：保留这个函数的意义是"留一个稳定的入口"。
// 历史上这里真的会按预算砍掉一部分命令，后来改成只截断描述、不再砍条目，
// 于是实现退化成直接转发。对外接口保持不变，调用方（analyzeContext）不用改。
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

/**
 * 清空 getPrompt 的 memoize 缓存。
 *
 * 为什么需要：某些场景下（比如插件被安装/卸载、skill 目录变化后），
 * 需要让下一轮重新生成工具 prompt。memoize 会一直返回旧值，必须手动清。
 *
 * 注意 `?.` 连用了两次：lodash 的 memoize 在类型上不一定有 `.cache`，
 * 而 `.cache` 上的 `.clear` 也可能不存在（比如换成了别的缓存实现）。
 * 所以这里「有就清，没有就算了」，绝不能因为清缓存失败而抛异常。
 */
export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}

/**
 * 统计 skill 的数量（与 getSkillToolInfo 类似，但只统计 slash-command 类 skill）。
 *
 * 为什么需要：给上层展示"共 N 个 skill"。这里特意用 try/catch 兜底：
 * 扫描磁盘目录可能因为权限、损坏的 YAML 等原因抛错，
 * 而统计数字只是**展示用的辅助信息**，不该让整个 /context 命令崩掉。
 * 所以出错时返回 0，把"怎么处理"的决定权交给调用方。
 *
 * @param cwd 当前工作目录
 * @returns { totalSkills, includedSkills }；出错时两个都是 0
 */
export async function getSkillInfo(cwd: string): Promise<{
  totalSkills: number
  includedSkills: number
}> {
  try {
    const skills = await getSlashCommandToolSkills(cwd)

    return {
      totalSkills: skills.length,
      includedSkills: skills.length,
    }
  } catch (error) {
    // 中文补充：toError(error) 把"任何被 throw 的东西"（TS 里可以 throw 任意值，
    // 不一定是 Error 实例）统一转成 Error ≈ Java 没有对应物，Java 只能 throw Throwable。
    logError(toError(error))

    // Return zeros rather than throwing - let caller decide how to handle
    // 中文补充：吞掉异常、返回 0。这是"降级而非失败"的设计取向：
    // 少显示一个统计数字，比让整个命令挂掉要好得多。
    return {
      totalSkills: 0,
      includedSkills: 0,
    }
  }
}
