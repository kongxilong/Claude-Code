# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from insert import apply  # noqa: E402

SPECS = [
    {
        "file": "src/tools/BashTool/prompt.ts",
        "header": [
            "/**",
            " * 【一句话定位】拼装 Bash 工具交给大模型的「提示词 / 使用说明」——",
            " *   告诉模型这个工具能干什么、该怎么用、有哪些禁忌（超时、后台、沙箱、git 操作规范等）。",
            " *",
            " * 【在架构中的位置】",
            " *   上游：BashTool.tsx（工具定义里引用 prompt）、以及系统提示词组装流程",
            " *   下游：constants/prompts.js（prependBullets  bullets 化）、utils/timeouts.js（超时默认值）、",
            " *        utils/sandbox/sandbox-adapter.js（沙箱配置）、utils/permissions/filesystem.js（临时目录）、",
            " *        utils/attribution.js（署名文案）、utils/undercover.js、utils/gitSettings.js、",
            " *        utils/embeddedTools.js、以及各工具的 TOOL_NAME 常量",
            " *   调用链：工具定义 -> getSimplePrompt() -> getCommitAndPRInstructions() / getSimpleSandboxSection()",
            " *",
            " * 【本文件包含什么】",
            " *   - getDefaultTimeoutMs() / getMaxTimeoutMs()：默认超时与最大超时（给提示词里写死数值用）",
            " *   - getBackgroundUsageNote()：run_in_background 参数的使用说明（功能被禁用时返回 null）",
            " *   - getCommitAndPRInstructions()：git 提交与 PR 的完整安全规范（内部版 vs 外部版两套）",
            " *   - dedup()：小工具，数组去重（用于精简提示词体积）",
            " *   - getSimpleSandboxSection()：把当前沙箱配置渲染成提示词里的一节",
            " *   - getSimplePrompt()：对外主入口，拼出完整的 Bash 工具说明",
            " *",
            " * 【提示词的组织逻辑】（读这个文件的要点）",
            " *   ① 先说「工具是什么」（执行 bash 并返回输出）",
            " *   ② 再强调「优先用专用工具」：读文件用 Read 而不是 cat、搜索用 Grep 而不是 grep……",
            " *      ——目的是让模型产出可被权限系统精确识别、可被用户直观审阅的调用",
            " *   ③ 然后是具体指令：路径加引号、保持工作目录、超时上限、多命令怎么拼、git 禁忌、别乱 sleep",
            " *   ④ 再拼沙箱章节（有沙箱才拼）",
            " *   ⑤ 最后拼 git 提交 / PR 章节",
            " *",
            " * 【TS 语法速查】（本文件实际出现的）",
            " *   - `feature('X')` 是**编译期**开关（类似 C 的 #ifdef），不是运行时 if：",
            " *     打包时未启用的分支会被整段剔除，所以别指望运行时改配置能切换",
            " *   - 模板字符串 `...${expr}...`：用反引号包住，${} 内可以写任意表达式（≈ Java 的 String.format 但更强）",
            " *   - `...(cond ? [a] : [])`：数组里的条件展开，条件不满足就展开成 0 个元素（非常常见的写法）",
            " *   - `...(cond && { k: v })`：对象里的条件展开——&& 短路后若 cond 为假则展开 undefined，等于什么都不加",
            " *   - `Array<string | string[]>`：元素是「字符串或字符串数组」，用来表达「标题 + 子项列表」的层级结构",
            " *   - 泛型函数 `function dedup<T>(arr: T[])` ≈ Java 的 `<T> List<T> dedup(List<T> arr)`",
            " *   - `[...new Set(arr)]`：Set 去重后再展开回数组（Java: new ArrayList<>(new HashSet<>(arr))）",
            " *   - 类型标注在变量名**后面**，Java 在前面",
            " */",
        ],
        "inserts": [
            {"anchor": "export function getDefaultTimeoutMs(): number {", "lines": [
                "// 包一层而不是直接用常量：提示词里要展示超时数值，这里统一收口，改默认值时不用改提示词文本",
            ]},
            {"anchor": "export function getMaxTimeoutMs(): number {", "lines": [
                "// 最大值：模型传的 timeout 参数超过它会被拒，提示词里必须写清楚上限，否则模型会瞎填",
            ]},
            {"anchor": "function getBackgroundUsageNote(): string | null {", "lines": [
                "/**",
                " * 【做什么】生成 run_in_background 参数的使用说明",
                " * 【为什么需要】后台执行是高频能力，但模型容易误用（比如同时加 & 和该参数），需要显式说明",
                " * 【返回】说明文案；功能被环境变量禁用时返回 null（调用方据此整段省略）",
                " */",
            ]},
            {"anchor": "  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {", "lines": [
                "// 环境变量总开关：某些环境（如受限沙箱/IDE 插件）不支持后台任务，就干脆不在提示词里提它",
            ]},
            {"anchor": "function getCommitAndPRInstructions(): string {", "lines": [
                "/**",
                " * 【做什么】生成 git 提交与 Pull Request 的操作规范（本文件最长的一段文案）",
                " * 【为什么需要】git 是最容易「一失手成千古恨」的场景（force push、reset --hard、amend），",
                " *   必须用提示词把安全协议写死，光靠权限系统拦不住模型主动发起的破坏性操作",
                " * 【返回】规范文案（可能为空串）",
                " * 【关键步骤】",
                " *   ① 先拼「保密（undercover）」段落——内部环境专用，且必须**无条件保留**：",
                " *      即使用户关掉了 git 指令，也要防止模型在提交信息里泄露内部代号（防御纵深）",
                " *   ② 用户关闭了 git 指令 → 直接返回（只剩保密段落）",
                " *   ③ 内部用户（ant）走「简短版」：引导去用 /commit、/commit-push-pr 这类技能",
                " *   ④ 外部用户走「完整版」：把 git 安全协议、提交步骤、PR 步骤全部内联写清楚",
                " */",
            ]},
            {"anchor": "  // Defense-in-depth: undercover instructions must survive even if the user", "after": True, "lines": [
                "// 中文补充（设计意图）：这段代码刻意放在 return 的**最前面**——",
                "//   即使用户完全关掉了 git 相关指令，这段「别暴露内部信息」的要求也必须留下。",
                "//   因为删署名、藏模型 ID 都是机械操作，而「别在提交信息里写出内部代号」只能靠提示词约束",
            ]},
            {"anchor": "  if (process.env.USER_TYPE === 'ant') {", "lines": [
                "// 两套文案的原因：内部用户有 /commit 等技能可用，提示词只需指路；",
                "//   外部用户没有这些技能，必须把每一步都写清楚，否则模型会乱来",
            ]},
            {"anchor": "  const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()", "lines": [
                "// 解构时改名：`{ 原字段名: 新变量名 }`。署名文案（如 Co-Authored-By 行）需要拼进提交信息与 PR 正文",
            ]},
            {"anchor": "function dedup<T>(arr: T[] | undefined): T[] | undefined {", "lines": [
                "/**",
                " * 【做什么】数组去重（保留原顺序由 Set 保证）",
                " * 【为什么需要】沙箱配置来自多个配置层（settings、默认值、CLI 参数）且未做去重，",
                " *   像 ~/.cache 这类路径会在 allowOnly 里出现三四次；写进提示词就是白白浪费 token",
                " * 【入参/返回】数组或 undefined（空数组/空值原样返回，不额外分配对象）",
                " * 【关键步骤】",
                " *   ① 空值或空数组直接返回（快路径）",
                " *   ② new Set(arr) 去重 → 展开回数组",
                " * 注意：这里只影响「模型看到什么」，**不影响**沙箱的实际执行策略",
                " */",
            ]},
            {"anchor": "function getSimpleSandboxSection(): string {", "lines": [
                "/**",
                " * 【做什么】把当前沙箱的读写/网络限制渲染成提示词里的一节",
                " * 【为什么需要】模型如果不知道沙箱边界，会反复尝试被拒绝的操作、或误以为命令出错；",
                " *   把限制写清楚，模型才能主动规避（比如临时文件写 $TMPDIR 而不是 /tmp）",
                " * 【返回】章节文案；沙箱未启用时返回空串（整节不出现）",
                " * 【关键步骤】",
                " *   ① 沙箱没开 → 直接返回空串",
                " *   ② 从 SandboxManager 取四类配置：文件读、文件写、网络、unix socket、以及是否允许无沙箱命令",
                " *   ③ 把带 UID 的临时目录字面量替换成 $TMPDIR——这样不同用户拿到的是同一份提示词，",
                " *      可以复用全局 prompt cache（省 token 的关键技巧，不是安全问题）",
                " *   ④ 拼限制说明行（Filesystem / Network / Ignored violations）",
                " *   ⑤ 按「是否允许跳出沙箱」生成两套不同的行为准则",
                " *   ⑥ 末尾统一加上「临时文件请用 $TMPDIR」的提醒",
                " */",
            ]},
            {"anchor": "  const normalizeAllowOnly = (paths: string[]): string[] =>", "lines": [
                "// 为什么要把真实路径换成 $TMPDIR 字面量：",
                "//   /private/tmp/claude-1001/ 这种路径因人而异，写进提示词会让每个用户的提示词都不同，",
                "//   全局 prompt cache 直接失效。换成 $TMPDIR 后提示词统一，命中率大幅提升",
            ]},
            {"anchor": "      ...(fsReadConfig.allowWithinDeny && {", "lines": [
                "// `...(条件 && { 字段 })`：条件为真才把这个字段加进对象。",
                "//   原理：&& 短路后左边为假则整个表达式为假值，展开假值等于什么都不加（这是 TS 里很常见的条件字段写法）",
            ]},
            {"anchor": "      denyOnly: dedup(fsReadConfig.denyOnly),", "lines": [
                "// 读权限的模型：denyOnly（只禁止这些）/ allowWithinDeny（禁止区里的例外）",
            ]},
            {"anchor": "      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),", "lines": [
                "// 写权限的模型：allowOnly（只允许这些）/ denyWithinAllow（允许区里的例外）——",
                "//   注意写权限是**白名单**思路，比读权限严格得多",
            ]},
            {"anchor": "  const restrictionsLines = []", "lines": [
                "// 用数组收集再 join，而不是一路拼字符串：避免末尾多余换行，也方便按条件增删行",
            ]},
            {"anchor": "  const sandboxOverrideItems: Array<string | string[]> =", "lines": [
                "// Array<string | string[]> 的含义：每一项要么是一句话（string），要么是一组要点（string[]），",
                "//   这样可以用同一套 prependBullets 渲染出「标题 + 子列表」的层级结构",
            ]},
            {"anchor": "            'The user *explicitly* asks you to bypass sandbox',", "lines": [
                "// 允许跳出沙箱的三个前提之一：用户明确要求。强调 explicit 是为了防止模型「我觉得用户可能需要」就自作主张",
            ]},
            {"anchor": "            \"Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)\",", "lines": [
                "// 「别问，直接重试」的用意：已经确认是沙箱导致的失败，再问一次只是徒增往返",
            ]},
            {"anchor": "          'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.',", "lines": [
                "// 策略层禁用了跳出沙箱时，提示词必须说死，避免模型反复尝试一个根本不存在的逃生口",
            ]},
            {"anchor": "export function getSimplePrompt(): string {", "lines": [
                "/**",
                " * 【做什么】拼出 Bash 工具的完整使用说明（对外主入口）",
                " * 【为什么需要】工具描述越精确，模型越倾向用专用工具而不是裸 bash，",
                " *   这对权限系统的可识别性、对用户审阅体验都是决定性的",
                " * 【返回】完整提示词字符串",
                " * 【关键步骤】",
                " *   ① 判断是否内嵌了搜索工具（bfs/ugrep），据此调整「该用哪个工具」的建议清单",
                " *   ② 组装「工具偏好」清单：搜索用 Glob/Grep、读用 Read、改用 Edit、写用 Write",
                " *   ③ 组装指令清单：路径加引号、保持 cwd、超时说明、后台说明、多命令怎么拼、git 禁忌、别乱 sleep",
                " *   ④ 拼接：工具定义 → 偏好清单 → 指令 → 沙箱章节 → git/PR 章节",
                " *   ⑤ 所有条目通过 prependBullets 统一渲染成列表",
                " */",
            ]},
            {"anchor": "  const embedded = hasEmbeddedSearchTools()", "lines": [
                "// 内嵌版（ant-native）把 find/grep 换成了自带的 bfs/ugrep，性能更好，",
                "//   所以这时候**不再**劝模型避开 find/grep（劝了反而变慢）",
            ]},
            {"anchor": "  const toolPreferenceItems = [", "lines": [
                "// 核心策略：能用专用工具就别用 bash。原因有二——",
                "//   ① 专用工具的调用可被权限系统精确识别（Bash(git:*) 这种规则才有意义）",
                "//   ② 用户在确认框里看到 Read(file) 比看到 cat file 更容易判断",
            ]},
            {"anchor": "    ...(embedded", "lines": [
                "// 条件展开：内嵌搜索工具时不出现 find/ls 相关提示（见上方 embedded 的说明）",
            ]},
            {"anchor": "  const multipleCommandsSubitems = [", "lines": [
                "// 多命令的组织规则：能并行就多次调用、有依赖就 &&、不在乎失败才用 ;、",
                "//   **不能**用换行分隔命令（换行只在引号内字符串里才安全）",
            ]},
            {"anchor": "  const gitSubitems = [", "lines": [
                "// git 的三条红线：优先新建 commit 而不是 amend、破坏性操作先想替代方案、绝不跳过 hook 和签名",
            ]},
            {"anchor": "  const sleepSubitems = [", "lines": [
                "// 为什么专门劝模型别 sleep：sleep 是最典型的「假装在工作」行为，",
                "//   既拖慢任务又占着上下文。正确做法是用后台任务 + 完成通知",
            ]},
            {"anchor": "    ...(feature('MONITOR_TOOL')", "nth": 1, "lines": [
                "// `feature('MONITOR_TOOL')` 是**编译期**开关（≈ C 的 #ifdef）：",
                "//   打包时若未启用该特性，整个分支会被删掉，运行时改配置也切不动",
            ]},
            {"anchor": "    ...(feature('MONITOR_TOOL')", "nth": 2, "lines": [
                "// 同一个编译期开关的第二处用法：启用 Monitor 工具时，首命令 sleep≥2s 会被直接拦掉",
            ]},
            {"anchor": "  const backgroundNote = getBackgroundUsageNote()", "lines": [
                "// 后台说明可能为 null（功能被禁用），下面用 `!== null ? [x] : []` 决定要不要插入",
            ]},
            {"anchor": "  const instructionItems: Array<string | string[]> = [", "lines": [
                "// 指令清单（同样支持「一句话」和「子项列表」两种条目）",
            ]},
            {"anchor": "    ...(backgroundNote !== null ? [backgroundNote] : []),", "lines": [
                "// 为什么用 `!== null` 而不是 `&&`：backgroundNote 是字符串，空串也会被 && 判为假，",
                "//   但这里要的是「有文案就插入」，所以必须显式和 null 比较",
            ]},
            {"anchor": "  return [", "nth": 2, "lines": [
                "// 最终拼接：工具说明 → 禁忌工具清单 → 指令 → 沙箱 → git/PR。",
                "//   用数组 join('\\n') 而不是 += 拼字符串，可读性和性能都更好",
            ]},
            {"anchor": "    getSimpleSandboxSection(),", "lines": [
                "// 沙箱章节未启用时返回空串，插进来也不会产生多余空行（外层已单独加了 '' 占位行）",
            ]},
            {"anchor": "    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),", "lines": [
                "// 注意这里调用了**两次** getCommitAndPRInstructions()：一次判空、一次取值。",
                "//   代价很小（纯字符串拼装），换来的是写法上的简洁；若要优化可先存变量",
            ]},
        ],
    },
]

rc = 0
for s in SPECS:
    rc |= apply(s)
sys.exit(rc)
