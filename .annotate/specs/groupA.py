# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from insert import apply  # noqa: E402

SPECS = [
    # ─────────────────────────────────────────────────────────────
    {
        "file": "src/tools/BashTool/toolName.ts",
        "header": [
            "/**",
            " * 【一句话定位】本文件只做一件事：导出 Bash 工具的名字常量 'Bash'。",
            " *",
            " * 【在架构中的位置】",
            " *   上游：BashTool/prompt.ts（提示词里要写工具名）、BashTool.tsx（工具定义）、权限与 UI 模块（报错/弹窗要显示工具名）",
            " *   下游：无（本文件不 import 任何东西，是依赖图的叶子节点）",
            " *   调用链：prompt.ts -> toolName.ts（单向，不允许反向）",
            " *",
            " * 【本文件包含什么】",
            " *   - BASH_TOOL_NAME：常量 'Bash'，是 Bash 工具在「模型 / 权限规则 / UI」三处的唯一标识",
            " *",
            " * 【TS 语法速查】（本文件实际出现的）",
            " *   - `export const X = ...`：export ≈ Java 的 public，const ≈ final（引用不可改；若是对象，对象内部仍可改）",
            " *   - 类型标注写在变量名**后面**（`const X: string`），Java 写在前面（`String x`），这是最容易看串的地方",
            " *   - 为什么要拆成单独一个文件：切断循环依赖（见下方对第一行的中文说明）",
            " */",
        ],
        "inserts": [
            {
                "anchor": "// Here to break circular dependency from prompt.ts",
                "after": True,
                "lines": [
                    "// 中文补充：这一行是本文件存在的唯一理由，不是废话。",
                    "// prompt.ts 需要用到 BASH_TOOL_NAME，而 BashTool.tsx 又要 import prompt.ts；",
                    "// 若把常量定义在 BashTool.tsx 里，就形成 A→B→A 的循环依赖（Java 里同样要避免的 import 环），",
                    "// 运行时可能出现「模块还没初始化完就取值」拿到 undefined。拆出这个叶子文件即可断环。",
                ],
            },
            {
                "anchor": "export const BASH_TOOL_NAME = 'Bash'",
                "lines": [
                    "// 同一个字符串同时扮演三种角色：给模型看的工具名、权限规则里的匹配键、UI 上显示的名字，三处必须完全一致",
                ],
            },
        ],
    },
    # ─────────────────────────────────────────────────────────────
    {
        "file": "src/tools/BashTool/commentLabel.ts",
        "header": [
            "/**",
            " * 【一句话定位】从 bash 命令的**首行**提取 # 注释文本，作为这条命令的「人类可读短标签」。",
            " *",
            " * 【在架构中的位置】",
            " *   上游：BashTool/UI.tsx、BashToolResultMessage.tsx、以及消息渲染层（要给用户显示这条命令在干嘛）",
            " *   下游：无",
            " *   调用链：UI 渲染 -> extractBashCommentLabel(command) -> 显示在折叠标题 / ⎿ 提示行",
            " *",
            " * 【本文件包含什么】",
            " *   - extractBashCommentLabel(command)：唯一导出函数，取首行注释文本，取不到返回 undefined",
            " *",
            " * 【TS 语法速查】（本文件实际出现的）",
            " *   - `string | undefined`：联合类型 ≈ Java 的 sealed interface / Optional 的底层形态，",
            " *     表示「要么是字符串，要么是 undefined」，编译期强制调用方处理 undefined（除非用 ! 或 ?? 绕过）",
            " *   - `|| undefined`：把假值（这里是空串 ''）归一成 undefined，是 TS 常见收尾写法",
            " *   - 正则字面量 `/^#+\\s*/` ≈ Java 的 Pattern.compile(...)，\\s 表示空白字符",
            " *   - 类型标注在变量名**后面**（`command: string`），Java 在前面",
            " */",
        ],
        "inserts": [
            {
                "anchor": "export function extractBashCommentLabel(command: string): string | undefined {",
                "lines": [
                    "/**",
                    " * 【做什么】取 bash 命令第一行的 # 注释正文（去掉 # 及其后的空白），当作这条命令的短标签",
                    " * 【为什么需要】模型写 bash 时习惯在首行写 # 说明意图；UI 拿它当折叠标题/提示行，",
                    " *   比把整条命令原样丢给用户友好得多。这是「约定优于配置」：不新增字段，注释本身就是标签",
                    " * 【入参】command：完整 bash 命令原文（可能多行）",
                    " * 【返回】注释文本；首行不是注释（或是 #! shebang）则返回 undefined",
                    " * 【关键步骤】",
                    " *   ① indexOf('\\n') 找第一个换行；-1 表示整条命令只有一行，那就整体 trim",
                    " *   ② trim() 去掉首尾空白，避免缩进导致 startsWith('#') 误判",
                    " *   ③ 两道门槛：必须以 # 开头，且不能以 #! 开头（#! 是 shebang 解释器声明，不是给人看的注释）",
                    " *   ④ 正则去掉开头的若干个 # 与随后的空白",
                    " *   ⑤ 去 # 后若成空串（命令就是一个孤零零的 #），用 || 归一成 undefined",
                    " */",
                ],
            },
            {
                "anchor": r"  const nl = command.indexOf('\n')",
                "lines": [
                    "// indexOf 找不到返回 -1（和 Java 一样）；-1 表示单行命令，直接整体作为 firstLine",
                ],
            },
            {
                "anchor": r"  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined",
                "lines": [
                    "// 两个排斥条件用 || 串起来：不是 # 开头 → 不是注释；是 #! 开头 → 是 shebang，也不能当标签",
                    "// 提前 return 的写法 ≈ Java 的卫语句（guard clause），避免嵌套 if",
                ],
            },
            {
                "anchor": r"  return firstLine.replace(/^#+\s*/, '') || undefined",
                "lines": [
                    "// /^#+\\s*/ 逐段读：^ 锚定行首、#+ 一个或多个 #、\\s* 零个或多个空白，整体替换成空串",
                    "// 末尾 `|| undefined`：把空串也归一成 undefined，让调用方只写 if (label) 就够，",
                    "//   不必再单独处理 ''（这正是 || 与 ?? 的区别所在——这里就是要让 '' 被换掉）",
                ],
            },
        ],
    },
    # ─────────────────────────────────────────────────────────────
    {
        "file": "src/tools/BashTool/modeValidation.ts",
        "header": [
            "/**",
            " * 【一句话定位】按「当前权限模式（mode）」决定一批命令能否免询问直接放行；",
            " *   目前只实现了 acceptEdits（接受编辑）模式下的文件系统命令白名单。",
            " *",
            " * 【在架构中的位置】",
            " *   上游：BashTool.tsx 的 hasPermission 权限链（先问模式，再问规则表）",
            " *   下游：utils/bash/commands.js 的 splitCommand_DEPRECATED（拆分子命令）、",
            " *        utils/permissions/PermissionResult.js（统一的权限结论类型）",
            " *   调用链：BashTool.hasPermission -> checkPermissionMode -> validateCommandForMode -> 返回 allow/passthrough",
            " *",
            " * 【本文件包含什么】",
            " *   - ACCEPT_EDITS_ALLOWED_COMMANDS：acceptEdits 模式下自动放行的命令白名单（常量表）",
            " *   - FilesystemCommand：由上面常量表反推出来的字面量联合类型",
            " *   - isFilesystemCommand()：类型谓词，判断某个字符串是否属于白名单类型",
            " *   - validateCommandForMode()：对单条子命令做模式判定（内部函数）",
            " *   - checkPermissionMode()：对外主入口，把整条命令拆成子命令后逐条过一遍",
            " *   - getAutoAllowedCommands()：给 UI/提示词用，返回当前模式下会被自动放行的命令清单",
            " *",
            " * 【TS 语法速查】（本文件实际出现的）",
            " *   - `as const`：把数组/对象字面量「焊死」为只读元组 + 字面量类型，",
            " *     ≈ Java 的 final + 枚举化；没有它 ['mkdir',...] 只会被推断成 string[]",
            " *   - `(typeof X)[number]`：索引访问类型 ≈ 从数组类型反推出元素类型，",
            " *     配合 as const 得到 'mkdir' | 'touch' | ... 这样的联合类型",
            " *   - `A | B` 联合类型 ≈ Java 的 sealed interface / 多态，取值只能是列出的几种",
            " *   - `command is FilesystemCommand` 类型谓词 ≈ Java 的 instanceof 模式匹配：",
            " *     if 之后编译器自动把变量收窄成更具体的类型",
            " *   - `const [baseCmd] = arr.split(...)` 数组解构 ≈ 取第 0 个元素，比 arr[0] 更直观",
            " *   - `readonly string[]` ≈ Java 的不可变 List（编译期禁止 push/splice）",
            " *   - `z.infer<typeof X>`：从 zod schema 反推出输入类型（typeof 在这里取的是「值的类型」）",
            " *   - 类型标注在变量名**后面**，Java 在前面，最容易看串",
            " */",
        ],
        "inserts": [
            {
                "anchor": "const ACCEPT_EDITS_ALLOWED_COMMANDS = [",
                "lines": [
                    "// 白名单设计意图：acceptEdits 模式的语义是「用户已同意让模型改我的文件」，",
                    "// 那么 mkdir/touch/mv/cp/sed 这类「编辑动作的自然延伸」就不该再弹一次确认框，否则体验极差。",
                    "// 反过来：这份名单刻意**不含** git、curl、npm、sudo 等——它们不属于「编辑文件」，越权风险高",
                ],
            },
            {
                "anchor": "] as const",
                "after": True,
                "lines": [
                    "// `as const` 的两层效果：① 数组变只读元组；② 元素类型由 string 收窄成各自的字面量 ('mkdir' 等)",
                    "// 少了它，下面 (typeof ...)[number] 就只能得到 string，类型保护也就失效了",
                ],
            },
            {
                "anchor": "type FilesystemCommand = (typeof ACCEPT_EDITS_ALLOWED_COMMANDS)[number]",
                "lines": [
                    "// 从常量表反推类型：以后往数组里加一个命令，这个联合类型自动跟着变，不用两处维护（单一数据源）",
                    "// TS 速查：`typeof 变量` 取「变量的类型」；`[number]` 取「用数字下标访问得到的类型」= 元素类型",
                ],
            },
            {
                "anchor": "function isFilesystemCommand(command: string): command is FilesystemCommand {",
                "lines": [
                    "/**",
                    " * 【做什么】判断命令名是否在白名单里",
                    " * 【为什么需要】把「运行时判断」和「编译期类型收窄」绑在一起：",
                    " *   调用处 if (isFilesystemCommand(x)) 之后，x 的类型就从 string 变成 FilesystemCommand",
                    " * 【入参】command：命令名（如 'mkdir'）",
                    " * 【返回】boolean，但返回值类型是 `command is FilesystemCommand`（类型谓词，不是普通 boolean）",
                    " * 【关键步骤】",
                    " *   ① includes() 对只读数组做包含判断（≈ Java List.contains）",
                    " *   ② `command as FilesystemCommand` 先强制转换，让 includes 的参数类型对得上——",
                    " *      这是纯编译期的「骗过类型检查」，运行时不做任何校验，安全性靠上一行的 includes 兜住",
                    " */",
                ],
            },
            {
                "anchor": "function validateCommandForMode(",
                "lines": [
                    "/**",
                    " * 【做什么】对**单条**子命令做「模式维度」的判定",
                    " * 【为什么需要】模式判断必须发生在拆分之后：一条命令 `ls && rm x` 里 ls 该放行、rm 要看模式，",
                    " *   整条一起判就会把二者混为一谈",
                    " * 【入参】cmd：单条子命令；toolPermissionContext：含当前 mode 的上下文",
                    " * 【返回】PermissionResult：allow=模式直接放行 / passthrough=本模块管不了，交给后续规则链",
                    " * 【关键步骤】",
                    " *   ① trim + split(/\\s+/) 取第一个词作为命令名（baseCmd）",
                    " *   ② baseCmd 为空 → passthrough（解析不出命令就别硬判，交给下游）",
                    " *   ③ 仅当 mode 是 acceptEdits 且 baseCmd 在白名单里 → allow，并带上 decisionReason 说明放行依据",
                    " *   ④ 其余一律 passthrough：宁可交给后面的规则表，也不在这里误放行",
                    " */",
                ],
            },
            {
                "anchor": "  const [baseCmd] = trimmedCmd.split(/\\s+/)",
                "lines": [
                    "// 数组解构取第 0 个元素；split(/\\s+/) 按任意长度空白切分（比按单个空格切更稳，能处理多空格/tab）",
                ],
            },
            {
                "anchor": "  if (!baseCmd) {",
                "lines": [
                    "// 空串是假值：!baseCmd 同时覆盖 undefined 与 ''（TS 里 '', 0, false, null, undefined 都是假值）",
                ],
            },
            {
                "anchor": "  // In Accept Edits mode, auto-allow filesystem operations",
                "after": True,
                "lines": [
                    "// 中文补充：只有「当前是 acceptEdits 模式」且「命令在白名单里」两个条件同时满足才放行",
                    "// decisionReason 会被 UI 拿去解释「为什么这次没问你」，所以必须如实写 mode 来源",
                ],
            },
            {
                "anchor": "/**",
                "nth": 1,
                "lines": [
                    "/**",
                    " * 【做什么】模式维度权限判定的对外主入口",
                    " * 【为什么需要】权限系统是「多层级管道」：模式层 → 规则表层 → 安全检查层。",
                    " *   本函数处在最前面，能放行的先放行，管不了的返回 passthrough 让后面的层继续处理",
                    " * 【入参】input：Bash 工具的入参（含 command）；toolPermissionContext：含当前 mode",
                    " * 【返回】allow（模式放行）/ passthrough（无模式级结论，交给主流程）",
                    " * 【关键步骤】",
                    " *   ① bypassPermissions / dontAsk 两种模式直接 passthrough —— 它们在主权限流程里另有专门处理，",
                    " *      这里重复处理会和主流程冲突（这是踩过的坑：一处放行、另一处又弹窗，行为不一致）",
                    " *   ② splitCommand_DEPRECATED 把整条命令拆成子命令（&&、;、| 等分隔）",
                    " *   ③ 逐条过 validateCommandForMode，任一条得出非 passthrough 的结论就立即返回（短路）",
                    " *   ④ 全部 passthrough → 整体 passthrough",
                    " */",
                ],
            },
            {
                "anchor": "  const commands = splitCommand_DEPRECATED(input.command)",
                "lines": [
                    "// 拆分是这一步的核心：一条命令里只要有一个子命令需要询问，整条命令就不该被静默放行",
                ],
            },
            {
                "anchor": "export function getAutoAllowedCommands(",
                "lines": [
                    "/**",
                    " * 【做什么】返回当前模式下「会被自动放行」的命令清单",
                    " * 【为什么需要】提示词和权限弹窗要如实告诉用户「哪些命令不会再问你」，避免黑盒感",
                    " * 【入参】mode：当前权限模式",
                    " * 【返回】命令名数组；非 acceptEdits 模式返回空数组（一个都不自动放行）",
                    " */",
                ],
            },
        ],
    },
    # ─────────────────────────────────────────────────────────────
    {
        "file": "src/tools/BashTool/destructiveCommandWarning.ts",
        "header": [
            "/**",
            " * 【一句话定位】用一张正则规则表识别「可能具有破坏性」的 bash 命令，返回一句人类可读的警示文案。",
            " *   纯展示用途——**不参与任何权限决策**，不会让命令被允许或被拒绝。",
            " *",
            " * 【在架构中的位置】",
            " *   上游：权限弹窗 / UI（拿到文案显示在确认框上，提醒用户看清风险）",
            " *   下游：无（不 import 任何模块，纯函数 + 常量表）",
            " *   调用链：权限弹窗 -> getDestructiveCommandWarning(command) -> 显示 Note: ... 提示行",
            " *",
            " * 【本文件包含什么】",
            " *   - DestructivePattern：单条规则的形状（正则 + 警示文案）",
            " *   - DESTRUCTIVE_PATTERNS：规则表，按 5 大类组织（见文件中分类说明）",
            " *   - getDestructiveCommandWarning()：唯一导出函数，命中即返回第一条警示",
            " *",
            " * 【规则分类逻辑】（理解本目录的关键之一）",
            " *   ① git 数据丢失类：reset --hard、push --force、clean -f、checkout .、restore .、stash drop/clear、branch -D",
            " *   ② git 绕过安全检查类：--no-verify（跳过 hook）、--amend（改写已提交历史）",
            " *   ③ 文件删除类：rm -rf / rm -fr / rm -r / rm -f——真正的危险路径由 checkDangerousRemovalPaths 单独拦截",
            " *   ④ 数据库类：DROP/TRUNCATE TABLE|DATABASE|SCHEMA、不带条件的 DELETE FROM",
            " *   ⑤ 基础设施类：kubectl delete、terraform destroy",
            " *",
            " * 【TS 语法速查】（本文件实际出现的）",
            " *   - `type X = { ... }`：结构化类型（鸭子类型）≈ Java record，但按**字段结构**匹配，不要求同一个类",
            " *   - 正则字面量 `/.../i`：i 是 flag，表示忽略大小写（等价于 Java Pattern.CASE_INSENSITIVE）",
            " *   - `for (const { pattern, warning } of arr)`：对象解构 + for-of ≈ Java 的 for-each 里顺手取字段",
            " *   - `string | null`：联合类型，用 null 表示「没命中」（本项目习惯：值缺失用 undefined，显式空用 null）",
            " *   - 类型标注在变量名**后面**，Java 在前面",
            " */",
        ],
        "inserts": [
            {
                "anchor": "type DestructivePattern = {",
                "lines": [
                    "// TS 速查：这种写法叫「类型别名 + 对象类型字面量」，≈ Java 的 record / 一个小 DTO，",
                    "// 但 TS 是结构化类型：任何带 pattern 与 warning 两个字段的对象都能当 DestructivePattern 用",
                ],
            },
            {
                "anchor": "const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [",
                "lines": [
                    "// 规则表 ≈ Java 的 static final List<Pattern>。设计要点：",
                    "//   ① 顺序有意义：命中第一条就返回，所以更具体/更危险的规则排在前面",
                    "//   ② 这里**只影响展示**，绝不能反过来影响 allow/deny——否则一条正则写错就会误放行或误拒绝",
                    "//   ③ 正则里大量出现 [^;&|\\n]*，意思是「只在当前这条子命令内匹配」，",
                    "//      防止 `ls; git push --force` 这类组合被误判或漏判（跨分隔符不连读）",
                ],
            },
            {
                "anchor": "  // Git — data loss / hard to reverse",
                "after": True,
                "lines": ["// 中文对照：git 类 —— 会丢失数据、或操作很难撤销"],
            },
            {
                "anchor": r"    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,",
                "lines": [
                    "// 为什么要先 \\bgit\\s+push\\b 再用 [^;&|\\n]* 限定范围：",
                    "//   防止 `echo git push; rm -rf x` 之类把后面的 -f 也算到 git push 头上",
                ],
            },
            {
                "anchor": "      /\\bgit\\s+clean\\b(?![^;&|\\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\\n]*-[a-zA-Z]*f/,",
                "lines": [
                    "// (?!...) 是否定前瞻（negative lookahead）：同一条命令里若出现 -n 或 --dry-run（演练模式），",
                    "//   就不算危险——git clean -n 只会打印将要删除的文件，不会真删",
                ],
            },
            {
                "anchor": "  // Git — safety bypass",
                "after": True,
                "lines": ["// 中文对照：git 类 —— 绕过既有安全检查（跳过 hook、改写已提交历史）"],
            },
            {
                "anchor": "  // File deletion (dangerous paths already handled by checkDangerousRemovalPaths)",
                "after": True,
                "lines": [
                    "// 中文对照：文件删除类。注意职责划分——真正危险的路径（如 /、~、$HOME）",
                    "//   由 checkDangerousRemovalPaths 负责拦截；这里只是「提示可能有风险」，不做判决",
                ],
            },
            {
                "anchor": "      /(^|[;&|\\n]\\s*)rm\\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\\n]\\s*)rm\\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,",
                "lines": [
                    "// 两个分支分别覆盖 -rf 与 -fr（以及 -Rf、-fR 等大小写变体）：",
                    "//   -[a-zA-Z]*[rR][a-zA-Z]*f 表示「- 后若干字母里含 r，最后以 f 收尾」",
                    "// 用两条分支而不是一条，是因为正则不方便表达「含 r 且含 f、顺序任意」",
                ],
            },
            {
                "anchor": "  // Database",
                "after": True,
                "lines": ["// 中文对照：数据库类 —— 删表、清库、无 WHERE 的全表删除"],
            },
            {
                "anchor": "  // Infrastructure",
                "after": True,
                "lines": ["// 中文对照：基础设施类 —— K8s 资源删除、Terraform 销毁（影响面通常是整个环境）"],
            },
            {
                "anchor": "export function getDestructiveCommandWarning(command: string): string | null {",
                "lines": [
                    "/**",
                    " * 【做什么】依次用规则表里的正则去匹配命令，命中就返回对应警示文案",
                    " * 【为什么需要】让用户在确认框里一眼看到「这条命令可能会怎样」，降低误批准概率",
                    " * 【入参】command：待执行的 bash 命令原文",
                    " * 【返回】警示文案字符串；一条都没命中返回 null（调用方判断 `if (warning)` 即可）",
                    " * 【关键步骤】",
                    " *   ① for-of 顺序遍历规则表（≈ stream().filter().findFirst()，命中即止，不继续匹配）",
                    " *   ② pattern.test(command) 做一次匹配（≈ Java Matcher.find 的简化版）",
                    " *   ③ 全部未命中返回 null",
                    " */",
                ],
            },
            {
                "anchor": "    if (pattern.test(command)) {",
                "lines": [
                    "// 命中即返回：规则表按危险程度/常见程度排序，同一次只给用户看最关键的一条，避免刷屏",
                ],
            },
        ],
    },
    # ─────────────────────────────────────────────────────────────
    {
        "file": "src/tools/BashTool/bashCommandHelpers.ts",
        "header": [
            "/**",
            " * 【一句话定位】处理「复合命令」的权限判定：把带管道 / 子 shell / 命令组的命令切成段，",
            " *   逐段送进完整权限系统，并专门拦截 `cd` + `git` 的组合攻击。",
            " *",
            " * 【在架构中的位置】",
            " *   上游：BashTool.tsx 的 hasPermission（简单命令走规则表，复杂命令先过这里）",
            " *   下游：bashSecurity.ts（bashCommandIsSafeAsync_DEPRECATED）、",
            " *        utils/bash/ParsedCommand.js（AST 封装）、utils/bash/parser.js（tree-sitter 解析）、",
            " *        utils/bash/commands.js（splitCommand_DEPRECATED）、utils/permissions/permissions.js",
            " *   调用链：BashTool.hasPermission -> checkCommandOperatorPermissions",
            " *            -> bashToolCheckCommandOperatorPermissions -> segmentedCommandPermissionResult",
            " *            -> 每段再回调 bashToolHasPermissionFn（回到 BashTool 的完整权限流程，形成递归下钻）",
            " *",
            " * 【本文件包含什么】",
            " *   - CommandIdentityCheckers：两个判定函数组成的「回调包」类型（是不是 cd / 是不是 git）",
            " *   - segmentedCommandPermissionResult()：对已切好的若干段做汇总判定（核心）",
            " *   - buildSegmentWithoutRedirections()：去掉输出重定向，避免文件名被当成命令",
            " *   - checkCommandOperatorPermissions()：对外主入口（唯一导出函数）",
            " *   - bashToolCheckCommandOperatorPermissions()：真正的判定流程（子 shell → 管道 → 逐段）",
            " *",
            " * 【TS 语法速查】（本文件实际出现的）",
            " *   - `async / await` ≈ Java 的 CompletableFuture，但写法像同步代码；async 函数返回值一律是 Promise",
            " *   - `Promise<T>` ≈ CompletableFuture<T>；`Promise.all(arr)` ≈ 并发等待全部完成再拿到数组",
            " *   - `Map<K, V>` ≈ Java HashMap；`Array.from(map.entries())` 把 Map 转成 [k, v] 数组再遍历",
            " *   - `?.` 可选链 ≈ null 检查链：obj?.a?.b，遇到 null/undefined 直接短路返回 undefined，不抛 NPE",
            " *   - `??` 空值合并：只在左侧是 null/undefined 时取右侧（注意与 || 区别：0 和 '' 不会被替换）",
            " *   - `{ ...input, command: x }` 对象展开 ≈ 复制一份再覆盖字段，实现「不可变更新」",
            " *   - `'suggestions' in result` 是 JS 的 in 运算符：判断对象上有没有这个键（比 !== undefined 更准确）",
            " *   - `as const` 用在对象字面量上，把 'other' 收窄成字面量类型而不是 string",
            " *   - 函数类型参数 `(input: X) => Promise<Y>` ≈ Java 的函数式接口 / Callback，本文件的递归靠它实现",
            " *   - `Array.prototype.filter/find/every` ≈ stream().filter/findFirst/allMatch",
            " *   - 类型标注在变量名**后面**，Java 在前面，最容易看串",
            " */",
        ],
        "inserts": [
            {
                "anchor": "export type CommandIdentityCheckers = {",
                "lines": [
                    "// 为什么要「传函数进来」而不是直接 import：这两个判定函数定义在 bashPermissions.ts，",
                    "// 而本文件若直接 import 它就会形成循环依赖。用回调注入（≈ Java 的函数式接口/依赖注入）绕开",
                    "// TS 速查：这种写法≈一个只有方法的接口，字段类型是函数签名 `(s: string) => boolean`",
                ],
            },
            {
                "anchor": "async function segmentedCommandPermissionResult(",
                "lines": [
                    "/**",
                    " * 【做什么】对已经切好的若干命令段做「汇总式」权限判定",
                    " * 【为什么需要】管道命令 `a | b | c` 里每一段都可能有不同风险，必须逐段判、再合并结论；",
                    " *   而且有些攻击（跨段的 cd + git）单看任何一段都发现不了，必须放在这里做全局检查",
                    " * 【入参】input：原始工具入参；segments：切好的命令段数组；",
                    " *       bashToolHasPermissionFn：回调，用来对单段跑一遍完整权限流程（递归下钻）；",
                    " *       checkers：cd / git 判定函数包",
                    " * 【返回】deny（任一段被拒）/ allow（全部放行）/ ask（其余，附带建议规则）",
                    " * 【关键步骤】",
                    " *   ① 先查「多个 cd」：一条命令里出现两次以上 cd，路径意图不清晰，一律询问",
                    " *   ② 再查「跨段 cd + git」：这是 bare repo fsmonitor 绕过攻击的拦截点（见下方详细说明）",
                    " *   ③ 逐段回调 bashToolHasPermissionFn，结果存进 Map（段 → 结论）",
                    " *   ④ 先看有没有 deny（先把所有段都跑完再判断，保证 decisionReason 里信息完整）",
                    " *   ⑤ 再看是不是全 allow；否则落 ask，并把各段给出的建议规则收集起来一起上报",
                    " */",
                ],
            },
            {
                "anchor": "  const cdCommands = segments.filter(segment => {",
                "lines": [
                    "// 为什么要限制 cd 的数量：一条命令里连着 cd 两次，人类都容易看错最终工作目录在哪，",
                    "//   模型和用户更看不清，所以宁可多问一次（这是「可读性优先」而非「能力优先」的取舍）",
                ],
            },
            {
                "anchor": "  // SECURITY: Check for cd+git across pipe segments to prevent bare repo fsmonitor bypass.",
                "after": True,
                "lines": [
                    "// 中文详解（安全重点）：",
                    "//   攻击场景——当前目录里有个「裸仓库」（bare repo，只有 .git 内容没有工作区）。",
                    "//   模型先 cd 进那个目录，再跑 git status；此时 git 会按当前目录的 .git 走，",
                    "//   而权限规则里「针对本仓库的 git 命令放行」的判断是基于**项目根目录**的，于是被绕过。",
                    "//   更麻烦的是 cd 与 git 可能落在**不同管道段**里（如 `cd sub && echo | git status`），",
                    "//   每段单独检查都是干净的，所以必须在这一层做「跨段」组合检测",
                ],
            },
            {
                "anchor": "      const subcommands = splitCommand_DEPRECATED(segment)",
                "lines": [
                    "// 注意是两层拆分：管道段内部本身还可能是复合命令（如 `cd sub && echo`），",
                    "//   所以要先按管道切段、每段再按 && / ; 切子命令，才能准确找到 cd 和 git",
                ],
            },
            {
                "anchor": "  const segmentResults = new Map<string, PermissionResult>()",
                "lines": [
                    "// 用 Map 而不是数组：段可能重复，且后面要按段名回溯结论、放进 decisionReason 给 UI 展示",
                ],
            },
            {
                "anchor": "    const segmentResult = await bashToolHasPermissionFn({",
                "lines": [
                    "// { ...input, command: trimmedSegment }：复制原入参、只替换 command，",
                    "//   保证其它字段（如 run_in_background）在递归判定里不丢失（不可变更新的典型写法）",
                ],
            },
            {
                "anchor": "  const deniedSegment = Array.from(segmentResults.entries()).find(",
                "lines": [
                    "// 先跑完所有段再找 deny：这样即使第 1 段就被拒，也能在 UI 上展示每一段各自的原因",
                    "// 解构写法 ([, result])：只取二元组的第 2 项（下划线位置留空表示忽略第 1 项）",
                ],
            },
            {
                "anchor": "  const allAllowed = Array.from(segmentResults.values()).every(",
                "lines": [
                    "// every ≈ stream().allMatch：必须每一段都是 allow，整条才算 allow",
                    "// 注意：空数组时 every 返回 true（逻辑上的「全称量词」），这里段数至少为 2 才走到本函数，故安全",
                ],
            },
            {
                "anchor": "  const suggestions: PermissionUpdate[] = []",
                "lines": [
                    "// 收集各段给出的「建议规则」：例如用户批准 `git status` 后可以顺手记一条 Bash(git:status) 规则",
                ],
            },
            {
                "anchor": "      'suggestions' in result &&",
                "lines": [
                    "// `in` 运算符判断对象上是否存在该键。为什么不用 result.suggestions !== undefined：",
                    "//   有些结论对象会显式把 suggestions 写成 undefined，用 in 才能区分「有键但值为空」和「压根没这个键」",
                ],
            },
            {
                "anchor": "async function buildSegmentWithoutRedirections(",
                "lines": [
                    "/**",
                    " * 【做什么】把一段命令里的输出重定向（> / >> 等）去掉",
                    " * 【为什么需要】`echo hi > rm -rf /` 里重定向后面的只是文件名；",
                    " *   若不去重定向，权限检查会把文件名误当成命令来分析，可能误判",
                    " * 【入参】segmentCommand：单个管道段的文本",
                    " * 【返回】去掉重定向后的命令；解析失败时原样返回（宁可不处理，也不能返回空串导致漏检）",
                    " * 【关键步骤】",
                    " *   ① 快路径：不含 '>' 就直接返回，省掉一次昂贵的 AST 解析（性能考虑）",
                    " *   ② 走 ParsedCommand.parse 做真正的语法解析（按 AST 去掉重定向，能正确处理引号）",
                    " *   ③ `?? segmentCommand`：解析返回 null/undefined 时回退到原文（?? 只兜 null/undefined，不兜空串）",
                    " */",
                ],
            },
            {
                "anchor": "export async function checkCommandOperatorPermissions(",
                "lines": [
                    "/**",
                    " * 【做什么】复合命令权限判定的对外主入口",
                    " * 【为什么需要】上游手里可能已经有解析好的 AST（避免重复解析），也可能什么都没有；",
                    " *   本函数负责把这两种情况统一成一个 IParsedCommand，再交给下面的判定流程",
                    " * 【入参】input：工具入参；bashToolHasPermissionFn：单段权限回调；checkers：cd/git 判定包；",
                    " *       astRoot：上游已解析好的 AST 根节点，或是 PARSE_ABORTED（表示上游放弃解析），或是 null",
                    " * 【返回】同 segmentedCommandPermissionResult；解析失败时返回 passthrough（交给主流程兜底）",
                    " * 【关键步骤】",
                    " *   ① 有 AST 就用 buildParsedCommandFromRoot 复用；没有才自己 ParsedCommand.parse",
                    " *   ② `astRoot !== PARSE_ABORTED`：PARSE_ABORTED 是一个哨兵值，表示「解析被主动放弃」，不能当真 AST 用",
                    " *   ③ 解析不出结果 → passthrough，不猜、不放行",
                    " */",
                ],
            },
            {
                "anchor": "    astRoot && astRoot !== PARSE_ABORTED",
                "lines": [
                    "// astRoot && ... 同时排除 null 与 PARSE_ABORTED（PARSE_ABORTED 本身是个真值对象，必须显式排除）",
                ],
            },
            {
                "anchor": "async function bashToolCheckCommandOperatorPermissions(",
                "lines": [
                    "/**",
                    " * 【做什么】复合命令的判定主干：先查子 shell / 命令组，再查管道，最后逐段判定",
                    " * 【为什么需要】子 shell（`( ... )`）和命令组（`{ ...; }`）里的命令无法被简单拆分，",
                    " *   属于「看不清就没法保证安全」的情形，必须整条升级为询问",
                    " * 【入参】同上，parsed 是已经解析好的命令对象（IParsedCommand）",
                    " * 【返回】ask（含子 shell/命令组）/ passthrough（无管道，交给普通流程）/ 段的汇总结论",
                    " * 【关键步骤】",
                    " *   ① 取 tree-sitter 分析结果判断有无子 shell / 命令组；拿不到分析结果就退回旧的正则判断",
                    " *   ② 有 → 调 bashCommandIsSafeAsync_DEPRECATED 要一条更具体的拒绝理由，然后 ask",
                    " *   ③ 取管道段；段数 ≤ 1 说明没有管道，passthrough 让普通流程处理",
                    " *   ④ 每段去掉重定向，再交给 segmentedCommandPermissionResult 汇总",
                    " */",
                ],
            },
            {
                "anchor": "  const tsAnalysis = parsed.getTreeSitterAnalysis()",
                "lines": [
                    "// tree-sitter 是真正的 bash 语法解析器（比正则可靠得多）；",
                    "//   拿不到分析结果时回退到旧的正则实现 DEPRECATED 版——属于「新老实现并存」的过渡设计",
                ],
            },
            {
                "anchor": "    const safetyResult = await bashCommandIsSafeAsync_DEPRECATED(input.command)",
                "lines": [
                    "// 只为拿一句更贴切的解释文案（如「不支持子 shell」），结论本身已经确定为 ask",
                ],
            },
            {
                "anchor": "      // This is an unsafe compound command, so we don't want to suggest rules since we wont be able to allow it",
                "after": True,
                "lines": [
                    "// 中文补充：这里刻意**不返回 suggestions**——子 shell 类命令即使加了规则也无法放行，",
                    "// 给出建议只会误导用户「批准一次就能记住」，属于体验上的坑",
                ],
            },
            {
                "anchor": "  const pipeSegments = parsed.getPipeSegments()",
                "lines": [
                    "// 按管道符切段（基于 AST，因此引号里出现的 | 不会被误当管道符，这正是比正则强的地方）",
                ],
            },
            {
                "anchor": "  if (pipeSegments.length <= 1) {",
                "lines": [
                    "// 段数为 1 = 没有管道：普通流程（规则表）已经能处理，这里不重复判，直接放行给下游",
                ],
            },
            {
                "anchor": "  const segments = await Promise.all(",
                "lines": [
                    "// Promise.all ≈ Java 的 CompletableFuture.allOf：并发处理所有段，全部完成后再继续（节省串行等待时间）",
                ],
            },
        ],
    },
]

rc = 0
for s in SPECS:
    rc |= apply(s)
sys.exit(rc)
