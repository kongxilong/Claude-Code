/**
 * 【一句话定位】识别「看起来无害、实则指向 git 内部文件」的路径参数，
 * 堵住一条 **sandbox 逃逸**攻击链：命令只要能创建/篡改 HEAD、objects、refs、hooks，
 * 再跑一次 git，就会执行攻击者自己刚写进去的恶意 hook。
 *
 * 【在架构中的位置】
 *   readOnlyValidation.ts / pathValidation.ts（判断某条命令是否触碰危险路径时）
 *        ──调用──> isGitInternalPathPS(arg) / isDotGitPathPS(arg)   ←── 本文件
 *   本文件 ──> path 模块（basename/posix/resolve/sep）、getCwd()、
 *             powershell/parser.js（PS_TOKENIZER_DASH_CHARS：PS 里各种长得像减号的字符）
 *
 *   对照 BashTool：src/tools/BashTool 目录下**没有**这个文件的对应物。
 *   因为这条攻击链依赖 Windows/NTFS 特有的两个"后门"：
 *     ① NTFS 8.3 短名：.git 可以写成 GIT~1（源码里必须额外匹配 git~N）
 *     ② 路径尾部的空格和点会被 CreateFileW 静默吞掉：'hooks .' 实际就是 'hooks'
 *   Unix 上没这两招，所以只需要本目录这一份 Windows 专用防护。
 *
 * 【要挡的两种攻击】（对应文件开头的英文注释）
 *   ① bare-repo（裸仓库）攻击：当前目录里凑齐 HEAD + objects/ + refs/ 但没有合法的
 *      .git/HEAD 时，git 会把当前目录当成裸仓库，并**直接执行当前目录下的 hooks**。
 *      于是 hooks/ 这种看似普通的项目目录名，瞬间变成代码执行入口。
 *   ② 组合命令：一条命令先造出 HEAD/objects/refs/hooks，紧接着跑 git ——
 *      于是 git 执行的就是刚被写进去的恶意 hook。
 *
 * 【本文件包含什么】
 *   GIT_INTERNAL_PREFIXES      ：git 内部条目名常量（head/objects/refs/hooks）。
 *   resolveCwdReentry()        ：把 `../<当前目录名>/hooks` 这种"绕回自己"的写法还原成 hooks。
 *   normalizeGitPathArg()      ：把 PowerShell 参数原文归一化成可比较的规范路径。
 *   resolveEscapingPathToCwdRelative()：把逃出 cwd 的路径用真实 cwd 解析，看是否又落回 cwd 内。
 *   matchesGitInternalPrefix() / matchesDotGitPrefix()：前缀判定（含 8.3 短名）。
 *   isGitInternalPathPS()      ：对外主判定（宽松，含裸仓库式的 hooks/ refs/）。
 *   isDotGitPathPS()           ：对外次判定（严格，只认 .git/ 内部）。
 *
 * 【贯穿全文件的核心难点】
 *   "**检查时看到的字符串**"必须和"**PowerShell 运行时真正解析出的路径**"一致，
 *   否则攻击方只要换个写法就能绕过（这叫 check/use divergence，校验与使用不一致）。
 *   所以本文件大量工作都在做归一化：引号、反引号转义、FileSystem:: 前缀、
 *   盘符相对路径、反斜杠、尾部空格与点、大小写，全部抹平之后再比较。
 *
 * 【TS 语法速查】
 *   import { basename, posix, resolve, sep } from 'path'
 *     具名导入 ≈ Java 的 import static；posix 是 path 模块导出的一个对象，
 *     专门提供**按 Unix 规则**（正斜杠）处理路径的函数，跨平台统一用它能避免
 *     在 Windows 上被反斜杠坑（Java 里对应 Paths.get + normalize）。
 *   s[0]!  ——  `!` 是**非空断言**：告诉编译器"我保证这里不是 null/undefined"。
 *     ≈ Java 的强制类型转换 (T) obj：骗过编译器，运行时**不做任何检查**，
 *     断言错了照样是 undefined（然后可能崩在后面）。本文件用它是因为
 *     前面已经判过 s.length > 0，但编译器推不出 s[0] 一定存在。
 *   as const（见下方 GIT_INTERNAL_PREFIXES）
 *     把数组定型成**只读元组 + 字面量类型**，元素类型收窄成 'head'|'objects'|...
 *     而不是宽泛的 string[]。≈ Java 里用 enum 代替 String 常量。
 *   do { ... } while (c !== prev)
 *     先做一次再判条件的循环 ≈ Java 的 do-while，语义完全一样。
 *     这里用来反复削尾部空格/点直到不再变化（不动点迭代）。
 */
/**
 * Git can be weaponized for sandbox escape via two vectors:
 * 1. Bare-repo attack: if cwd contains HEAD + objects/ + refs/ but no valid
 *    .git/HEAD, Git treats cwd as a bare repository and runs hooks from cwd.
 * 2. Git-internal write + git: a compound command creates HEAD/objects/refs/
 *    hooks/ then runs git — the git subcommand executes the freshly-created
 *    malicious hooks.
 */

// sep 是**当前平台**的路径分隔符（Windows 是 \，Unix 是 /）。
// posix 提供一套」强制按 Unix 规则「处理的函数 —— 本文件刻意统一用它，
// 因为 PowerShell 路径里 \ 和 / 都能用，混着处理最容易出漏洞。
import { basename, posix, resolve, sep } from 'path'
import { getCwd } from '../../utils/cwd.js'
import { PS_TOKENIZER_DASH_CHARS } from '../../utils/powershell/parser.js'

/**
 * 【中文】把 `../<当前目录名>/...` 这种」绕一圈又回到自己「的路径还原成相对路径。
 *
 * 为什么需要（对应上方英文注释）：posix.normalize 没有 cwd 上下文，
 * 所以它**会原样保留开头的 ..**。于是攻击者写 ../project/hooks 时，
 * 校验器看到的是 ../project/hooks（不匹配 hooks/ 前缀 → 放行），
 * 而 PowerShell 运行时会拿 cwd=/x/project 去解析，
 * 实际落到 /x/project/hooks —— 正好是我们要拦的地方。
 * 这就是典型的」校验与使用不一致「（check/use divergence）。
 *
 * @param normalized 已经归一化、小写化、带正斜杠的路径
 * @returns 还原后的相对路径；完全等于当前目录时返回 '.'
 *
 * 步骤：① 不以 ../ 开头则原样返回（快速路径）
 *      ② 取当前目录的 basename 并小写（Windows 大小写不敏感）
 *      ③ 循环剥掉 `../<目录名>/` 前缀（处理 ../../p/p/hooks 这种套娃）
 *      ④ 恰好等于 `../<目录名>`（无尾斜杠）时返回 '.'（就是当前目录本身）
 */
/**
 * If a normalized path starts with `../<cwd-basename>/`, it re-enters cwd
 * via the parent — resolve it to the cwd-relative form. posix.normalize
 * preserves leading `..` (no cwd context), so `../project/hooks` with
 * cwd=/x/project stays `../project/hooks` and misses the `hooks/` prefix
 * match even though it resolves to the same directory at runtime.
 * Check/use divergence: validator sees `../project/hooks`, PowerShell
 * resolves against cwd to `hooks`.
 */
function resolveCwdReentry(normalized: string): string {
  if (!normalized.startsWith('../')) return normalized
// getCwd() ≈ Java 的 System.getProperty(\」user.dir\「)；basename 取最后一段目录名。
  const cwdBase = basename(getCwd()).toLowerCase()
  if (!cwdBase) return normalized
  // Iteratively strip `../<cwd-basename>/` pairs (handles `../../p/p/hooks`
  // when cwd has repeated basename segments is unlikely, but one-level is
  // the common attack).
// 用 while 而不是 if：攻击者可以写 ../../p/p/hooks 一层层绕，
// 必须剥到不能再剥为止，否则第二层就绕过去了。
  const prefix = '../' + cwdBase + '/'
  let s = normalized
  while (s.startsWith(prefix)) {
    s = s.slice(prefix.length)
  }
  // Also handle exact `../<cwd-basename>` (no trailing slash)
// `../<目录名>` 没有尾斜杠 = 正好指回当前目录本身，记成 '.'。
  if (s === '../' + cwdBase) return '.'
  return s
}

/**
 * 【中文】把 PowerShell 的**原始参数文本**归一化成可比较的规范路径。
 *
 * 这是全文件最关键的函数 —— 它决定了」检查时看到的「能否等价于
 * PowerShell 真正会写入的位置。顺序不能随意调整（见上方英文注释）：
 *
 * 步骤：① 结构性剥离：参数前缀（-Path:xxx / /Path:xxx）、首尾引号、反引号转义、
 *        FileSystem:: provider 前缀、盘符相对前缀（C:foo，但 C:\foo 不算）
 *      ② 反斜杠统一成正斜杠
 *      ③ **逐段**去掉尾部空格与点（模仿 Win32 CreateFileW 的行为），
 *         并保证 . 和 .. 不被误削
 *      ④ posix.normalize 解析 .. 与 .，再去掉开头的 ./
 *      ⑤ 最后统一小写（Windows 大小写不敏感）
 *
 * @param arg PowerShell 里的原始参数文本（可能带引号、转义、provider 前缀）
 * @returns 规范化的小写相对路径；绝对路径会以 '/' 或 'c:/' 开头
 */
/**
 * Normalize PS arg text → canonical path for git-internal matching.
 * Order matters: structural strips first (colon-bound param, quotes,
 * backtick escapes, provider prefix, drive-relative prefix), then NTFS
 * per-component trailing-strip (spaces always; dots only if not `./..`
 * after space-strip), then posix.normalize (resolves `..`, `.`, `//`),
 * then case-fold.
 */
function normalizeGitPathArg(arg: string): string {
  let s = arg
// 坑点：PowerShell 里」减号「不止 ASCII 的 -，还有各种 Unicode 破折号
// （– — ― 等），PS 都当参数前缀处理。PS_TOKENIZER_DASH_CHARS 就是那张表。
// 另注：PS 5.1 里 / 也能当参数前缀（Unix 风格），所以这里一并判断。
  // Normalize parameter prefixes: dash chars (–, —, ―) and forward-slash
  // (PS 5.1). /Path:hooks/pre-commit → extract colon-bound value. (bug #28)
// `s[0]!` 的 ! 是**非空断言** ≈ Java 的强制转型：骗编译器」我保证非空「，
// 运行时不会真的检查。这里安全是因为上一行刚判了 s.length > 0。
// 另注：`-Path:hooks/pre-commit` 这种冒号绑定写法要取冒号**后面**的值。
  if (s.length > 0 && (PS_TOKENIZER_DASH_CHARS.has(s[0]!) || s[0] === '/')) {
    const c = s.indexOf(':', 1)
    if (c > 0) s = s.slice(c + 1)
  }
// 去掉首尾引号：'hooks/pre-commit' 与 hooks/pre-commit 指的是同一个地方。
  s = s.replace(/^['"]|['"]$/g, '')
// 反引号 ` 是 PowerShell 的转义字符（不是反斜杠！），先抹掉避免干扰后续匹配。
  s = s.replace(/`/g, '')
// FileSystem:: 是 PowerShell 的 provider 限定前缀，等价于」这就是个普通文件路径「。
// 抹掉它，否则前缀匹配会被这串前缀挡住而漏判。
  // PS provider-qualified path: FileSystem::hooks/pre-commit → hooks/pre-commit
  // Also handles fully-qualified form: Microsoft.PowerShell.Core\FileSystem::path
  s = s.replace(/^(?:[A-Za-z0-9_.]+\\){0,3}FileSystem::/i, '')
  // Drive-relative C:foo (no separator after colon) is cwd-relative on that
  // drive. C:\foo (WITH separator) is absolute and must NOT match — the
  // negative lookahead preserves it.
// 盘符相对路径陷阱：`C:foo` 表示」当前 C 盘目录下的 foo「（相对），
// 而 `C:\foo` 是绝对的（真的在 C 盘根下），必须**区分**对待。
// 正则里的 (?![\/\\]) 负向前瞻就是为了只匹配前者 —— ≈ Java 的否定 lookahead。
  s = s.replace(/^[A-Za-z]:(?![/\\])/, '')
// 统一成正斜杠：PowerShell 两种斜杠都吃，不统一会让同一路径有 N 种字符串表示。
  s = s.replace(/\\/g, '/')
  // Win32 CreateFileW per-component: iteratively strip trailing spaces,
  // then trailing dots, stopping if the result is `.` or `..` (special).
  // `.. ` → `..`, `.. .` → `..`, `...` → '' → `.`, `hooks .` → `hooks`.
  // Originally-'' (leading slash split) stays '' (absolute-path marker).
// ===== 模仿 Win32 CreateFileW 的」尾部清理「规则（关键且极易漏）=====
// Windows 打开文件时，每个路径分段尾部的**空格和点会被静默丢弃**：
//   'hooks '  → hooks      'hooks .' → hooks      '...' → ''   '.. ' → '..'
// 攻击者只要写 hooks/pre-commit.（结尾多一个点）就能绕过朴素的 startsWith 匹配，
// 而系统实际打开的正是 hooks/pre-commit。所以校验前必须做同样的清理。
// 注意 . 和 .. 是特殊值，一旦削成它们就**立即返回**，不能再继续削。
  s = s
    .split('/')
    .map(c => {
      if (c === '') return c
// do-while：反复」削空格 → 削点「直到字符串不再变化（不动点迭代）。
// 因为 'hooks. .' 这种需要削好几轮才干净，一轮不够。
      let prev
      do {
        prev = c
        c = c.replace(/ +$/, '')
        if (c === '.' || c === '..') return c
        c = c.replace(/\.+$/, '')
      } while (c !== prev)
// 某段被削成空串时退化成 '.'（当前目录），保持路径结构不塌。
      return c || '.'
    })
    .join('/')
// posix.normalize 负责解析 .. 与 .（'a/../b' → 'b'），
// 但它**保留开头的 ..** —— 那正是上面 resolveCwdReentry 要补的缺口。
  s = posix.normalize(s)
// normalize 之后可能多出 './' 前缀，去掉，否则 'hooks' 与 './hooks' 又不一致了。
  if (s.startsWith('./')) s = s.slice(2)
// 小写化收尾：Windows 大小写不敏感，统一小写后所有比较都能直接用字符串相等。
  return s.toLowerCase()
}

// `as const` ≈ 把数组冻结成**只读元组**，元素类型收窄成字面量联合
// 'head' | 'objects' | 'refs' | 'hooks'。
// ≈ Java 用 enum 代替 public static final String 常量；
// 好处是下面 for 循环里拼错字面量会在编译期报错。
// 注意：裸仓库场景下这些名字会直接出现在**项目根目录**，而不在 .git/ 下面 ——
// 这正是它们危险的原因。
const GIT_INTERNAL_PREFIXES = ['head', 'objects', 'refs', 'hooks'] as const

/**
 * 【中文】把一条」逃出 cwd「的路径（以 ../ 开头，或是绝对路径）
 * 用**真实的 cwd** 解析，看它最终是否又落回 cwd 内部；
 * 若是，就把 cwd 那段剥掉，返回剩余的相对部分供前缀匹配。
 *
 * 为什么必须有这个函数（对应上方 SECURITY 英文注释）：
 *   pathValidation 那一层的 DANGEROUS_FILES **刻意不收录**裸的 HEAD
 *   （因为很多正常项目就叫 HEAD，收了会误伤），而 DANGEROUS_DIRECTORIES
 *   只按段匹配 .git —— 于是 `<cwd>/HEAD` 会穿过那一层。
 *   也就是说：**这里是拦裸仓库 HEAD 攻击的唯一一道关**，删掉就等于开门。
 *
 * @param n 已归一化小写的路径（可能是 ../xxx、/abs/xxx 或 c:/xxx）
 * @returns 落回 cwd 内则返回相对路径（'head'、'hooks/x' 等）；
 *          确实指向 cwd 之外则返回 null（那属于 pathValidation 该管的事）
 *
 * 步骤：① 用 path.resolve(cwd, n) 得到绝对路径（resolve 认识正斜杠）
 *      ② 一律转小写后判断是否以 cwd 开头（Windows 大小写不敏感）
 *      ③ 正好等于 cwd → '.'；不在 cwd 下 → null；否则剥掉 cwd 前缀返回余下部分
 */
/**
 * SECURITY: Resolve a normalized path that escapes cwd (leading `../` or
 * absolute) against the actual cwd, then check if it lands back INSIDE cwd.
 * If so, strip cwd and return the cwd-relative remainder for prefix matching.
 * If it lands outside cwd, return null (genuinely external — path-validation's
 * concern). Covers `..\<cwd-basename>\HEAD` and `C:\<full-cwd>\HEAD` which
 * posix.normalize alone cannot resolve (it leaves leading `..` as-is).
 *
 * This is the SOLE guard for the bare-repo HEAD attack. path-validation's
 * DANGEROUS_FILES deliberately excludes bare `HEAD` (false-positive risk
 * on legitimate non-git files named HEAD) and DANGEROUS_DIRECTORIES
 * matches per-segment `.git` only — so `<cwd>/HEAD` passes that layer.
 * The cwd-resolution here is load-bearing; do not remove without adding
 * an alternative guard.
 */
function resolveEscapingPathToCwdRelative(n: string): string | null {
  const cwd = getCwd()
  // Reconstruct a platform-resolvable path from the posix-normalized form.
  // `n` has forward slashes (normalizeGitPathArg converted \\ → /); resolve()
  // handles forward slashes on Windows.
// resolve(cwd, n) ≈ Java 的 Paths.get(cwd).resolve(n).normalize()：
// 补上 cwd 上下文后 ../ 就无处可藏了。
  const abs = resolve(cwd, n)
// cwdWithSep 带上尾部分隔符：否则 /x/project 会误判成 /x/project-tools 的父目录。
  const cwdWithSep = cwd.endsWith(sep) ? cwd : cwd + sep
  // Case-insensitive comparison: normalizeGitPathArg lowercased `n`, so
  // resolve() output has lowercase components from `n` but cwd may be
  // mixed-case (e.g. C:\Users\...). Windows paths are case-insensitive.
// 大小写陷阱：n 已经被小写化，但 cwd 本身可能是 C:\Users\... 这种混合大小写。
// Windows 比较路径必须全部转小写后再比，否则会漏。
  const absLower = abs.toLowerCase()
  const cwdLower = cwd.toLowerCase()
  const cwdWithSepLower = cwdWithSep.toLowerCase()
  if (absLower === cwdLower) return '.'
  if (!absLower.startsWith(cwdWithSepLower)) return null
// slice(cwdWithSep.length) 剥掉 cwd 前缀（长度按**原始 cwd**算，不是小写后的，
// 实际上两者等长，因为 toLowerCase 对 ASCII 不改变长度）。
// 最后再把反斜杠换成正斜杠并小写，保证与 matchesXxxPrefix 的输入格式一致。
  return abs.slice(cwdWithSep.length).replace(/\\/g, '/').toLowerCase()
}

/**
 * 【中文】判断归一化后的路径是否指向 git 内部条目。
 *
 * 覆盖范围刻意**分两档**（这是本文件两个导出函数的差别来源）：
 *   这里（宽松档）：裸仓库式的 head/objects/refs/hooks + 标准仓库的 .git/*
 *   下面的 matchesDotGitPrefix（严格档）：只要 .git/*
 *
 * @param n 归一化后的小写路径
 * @returns true 表示这是 git 内部路径，命令不该写它
 */
function matchesGitInternalPrefix(n: string): boolean {
  if (n === 'head' || n === '.git') return true
// `git~N` 是 NTFS **8.3 短名**：.git 会有一个别名 GIT~1（若还有 gitignore 之类
// 以 git 开头的条目，则可能是 GIT~2、GIT~3…）。攻击者用它就能绕过 .git 的匹配，
// 而 Windows 实际打开的还是 .git —— 所以必须一并匹配。
// （本文件里这个判断出现两次，两处都别漏。）
  if (n.startsWith('.git/') || /^git~\d+($|\/)/.test(n)) return true
// 'head' 在 GIT_INTERNAL_PREFIXES 里但要跳过：它已在开头单独判过，
// 且裸 HEAD 只在**根目录**才有意义（子目录里的 head 只是普通文件，不该拦）。
  for (const p of GIT_INTERNAL_PREFIXES) {
    if (p === 'head') continue
    if (n === p || n.startsWith(p + '/')) return true
  }
  return false
}

/**
 * 【中文】对外主判定：这个 PowerShell 参数是否指向 cwd 里的 git 内部路径？
 *
 * @param arg PowerShell 里的原始参数文本
 * @returns true = 危险（调用方应升级为 ask / deny）
 *
 * 步骤：① 归一化 + 处理」绕回 cwd「写法
 *      ② 直接前缀匹配（覆盖 .git/hooks、hooks/ 等常见写法）
 *      ③ **兜底**：归一化后仍是 ../ 开头、/ 开头或带盘符的路径，
 *         说明它可能逃出 cwd，必须用真实 cwd 再解析一次确认落点。
 *         少做第 ③ 步，`..\<当前目录名>\HEAD` 就直接穿过去了。
 */
/**
 * True if arg (raw PS arg text) resolves to a git-internal path in cwd.
 * Covers both bare-repo paths (hooks/, refs/) and standard-repo paths
 * (.git/hooks/, .git/config).
 */
export function isGitInternalPathPS(arg: string): boolean {
  const n = resolveCwdReentry(normalizeGitPathArg(arg))
  if (matchesGitInternalPrefix(n)) return true
  // SECURITY: leading `../` or absolute paths that resolveCwdReentry and
  // posix.normalize couldn't fully resolve. Resolve against actual cwd — if
  // the result lands back in cwd at a git-internal location, the guard must
  // still fire.
// 三个条件合起来 = 」这条路径不在 cwd 之内的相对写法「。
// 注意 /^[a-z]:/ 只判小写，是因为入参在此前已被 toLowerCase 处理过。
  if (n.startsWith('../') || n.startsWith('/') || /^[a-z]:/.test(n)) {
    const rel = resolveEscapingPathToCwdRelative(n)
    if (rel !== null && matchesGitInternalPrefix(rel)) return true
  }
  return false
}

/**
 * 【中文】对外次判定（**严格版**）：这个参数是否指向 .git/ **内部**？
 *
 * 与 isGitInternalPathPS 的区别（对应上方英文注释）：
 *   它**不匹配**根目录级的 hooks/、refs/、objects/ —— 因为很多正常项目
 *   就叫这些名字（比如前端项目的 hooks 目录），一律拦会造成大量误伤。
 * 于是本文件把两者分开：宽松版用于」绝不能写「的场景，严格版用于」.git 专属「场景。
 *
 * @param arg PowerShell 里的原始参数文本
 * @returns true = 指向 .git 内部（含 8.3 短名 GIT~N）
 */
/**
 * True if arg resolves to a path inside .git/ (standard-repo metadata dir).
 * Unlike isGitInternalPathPS, does NOT match bare-repo-style root-level
 * `hooks/`, `refs/` etc. — those are common project directory names.
 */
export function isDotGitPathPS(arg: string): boolean {
  const n = resolveCwdReentry(normalizeGitPathArg(arg))
  if (matchesDotGitPrefix(n)) return true
  // SECURITY: same cwd-resolution as isGitInternalPathPS — catch
  // `..\<cwd-basename>\.git\hooks\pre-commit` that lands back in cwd.
// 与 isGitInternalPathPS 里那段完全同构：逃出 cwd 的路径必须再解析一次。
// 这里针对的是 `..\<当前目录名>\.git\hooks\pre-commit` 这类写法。
  if (n.startsWith('../') || n.startsWith('/') || /^[a-z]:/.test(n)) {
    const rel = resolveEscapingPathToCwdRelative(n)
    if (rel !== null && matchesDotGitPrefix(rel)) return true
  }
  return false
}

/**
 * 【中文】严格档的前缀判定：只认 .git 及其内部（含 NTFS 8.3 短名 GIT~N）。
 *
 * @param n 归一化后的小写路径
 * @returns true = 位于 .git 内
 */
function matchesDotGitPrefix(n: string): boolean {
  if (n === '.git' || n.startsWith('.git/')) return true
  // NTFS 8.3 short names: .git becomes GIT~1 (or GIT~2, etc. if multiple
  // dotfiles start with "git"). normalizeGitPathArg lowercases, so check
  // for git~N as the first component.
// 再次匹配 8.3 短名：.git → GIT~1 / GIT~2 …（Windows 独有的绕过手法，
// 在 Unix 版的 BashTool 里不存在这个问题）。
  return /^git~\d+($|\/)/.test(n)
}
