// Voice keyterms for improving STT accuracy in the voice_stream endpoint.
//
// Provides domain-specific vocabulary hints (Deepgram "keywords") so the STT
// engine correctly recognises coding terminology, project names, and branch
// names that would otherwise be misheard.

/**
 * ============================================================================
 *  【文件总览】src/services/voiceKeyterms.ts —— 语音识别（STT）的「关键词提示表」
 * ============================================================================
 *
 *  一句话定位：
 *  给语音转写引擎（Deepgram）提供一份「本项目专用词汇表」，
 *  让它把「MCP」「symlink」「OAuth」这类程序员黑话听对，
 *  而不是听成发音相近的普通英文单词。**全程不调用任何模型**，纯本地拼装。
 *
 *  在架构中的位置：
 *      src/services/voiceStreamSTT.ts（建立实时语音流之前）
 *        └─> getVoiceKeyterms(recentFiles)                 ← ★ 本文件
 *              ├─> splitIdentifier()      把 camelCase/kebab-case 切成一个个单词
 *              ├─> getProjectRoot()       ← ../bootstrap/state.js（当前项目根目录）
 *              └─> getBranch()            ← ../utils/git.js（当前 git 分支名）
 *
 *  本文件包含什么：
 *   1. GLOBAL_KEYTERMS      写死的通用编程术语表
 *   2. splitIdentifier()    标识符切词工具（导出，便于单测）
 *   3. fileNameWords()      从文件路径里抽出词
 *   4. getVoiceKeyterms()   对外唯一入口：组装最终关键词表
 *
 *  【为什么需要这个东西？——STT 的固有弱点】
 *  语音识别引擎底层是声学模型 + 语言模型，它天然倾向于输出「常见英文单词」。
 *  于是 "grep" 会被听成 "grip"、"OAuth" 会被听成 "oh auth"、
 *  项目名 "Claude-Code" 可能被听成 "cloud code"。
 *  解决办法是给引擎一份关键词表（Deepgram 叫 keywords / keyterm boosting）：
 *  引擎会对表里的词**提高识别权重**，从而大幅降低误识别率。
 *  ≈ Java 里给拼写检查器喂一本自定义词典（custom dictionary）。
 *
 *  【设计要点 1：为什么是「全局术语 + 会话上下文」两层】
 *    - GLOBAL_KEYTERMS：所有程序员都会说的词（grep / regex / TypeScript…），写死即可
 *    - 上下文词：项目名、git 分支名、最近打开的文件名——这些因人而异，
 *      必须运行时动态收集，恰恰也是最容易被听错的（自己的项目名引擎从没见过）
 *
 *  【设计要点 2：为什么要限制在 50 个（MAX_KEYTERMS）】
 *  关键词表不是越长越好：表越长，「提权」的稀释效应越强，效果反而下降，
 *  而且会增加请求体积。所以设上限，并且**在收集文件名时提前 break**，
 *  不浪费时间扫描用不上的文件（见 getVoiceKeyterms 里的 `if (terms.size >= MAX) break`）。
 *
 *  【设计要点 3：为什么到处都是 try/catch 且吞掉异常】
 *  关键词表只是「锦上添花」的**优化项**，不是功能必需。
 *  拿不到项目根目录、不在 git 仓库里……任何一种情况都不该让语音功能起不来。
 *  所以每个上下文采集点都独立 try/catch，失败就跳过这一项，其余照常。
 *  ≈ Java 里对每个可选增强步骤单独 try/catch，避免一颗老鼠屎坏一锅汤。
 *
 *  【踩过的坑（原英文注释里明确写了）】
 *    - "Claude"/"Anthropic" **不用**加：服务端已经作为基础关键词内置了
 *    - 别加那些「没人会照着拼写念出来」的词，比如 stdout（大家会念 "standard out"），
 *      加了反而误导引擎
 *    - 项目名要**整串**加入，不切词：用户是把 "claude CLI internal" 当成一个短语说的，
 *      整串匹配才能让短语级别的提权生效
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `const GLOBAL_KEYTERMS: readonly string[] = [...]`
 *      `readonly T[]` = 只读数组，编译器禁止 push/pop 修改它。
 *      ≈ Java 的 `List.of(...)` 不可变列表，或 final 引用 + 不可变容器。
 *
 *  - `.replace(/([a-z])([A-Z])/g, '$1 $2')`  正则替换。
 *      `$1`/`$2` 是**反向引用**第 1、2 个捕获组，和 Java 的 `matcher.replaceAll("$1 $2")` 一样。
 *      作用：把 `getUserName` 变成 `get User Name`。
 *      `/g` 标志 = 全局替换（Java 里靠 while(matcher.find()) 循环实现）。
 *
 *  - `.split(/[-_./\s]+/)`  按正则切分。`\s` 是空白字符，字符类里的 `.` 和 `/` 是字面量。
 *      ≈ Java 的 `String.split(...)`，但直接吃正则对象。
 *
 *  - `.map(w => w.trim()).filter(w => ...)`  链式调用
 *      ≈ Java 的 `stream().map(...).filter(...)`，lambda 写法几乎一致。
 *
 *  - `new Set<string>(GLOBAL_KEYTERMS)`  用数组初始化集合，**自动去重**。
 *      这是本文件选择 Set 的核心原因：项目名、分支词、文件名词会大量重复。
 *      ≈ Java 的 `new HashSet<>(Arrays.asList(...))`。
 *
 *  - `recentFiles?: ReadonlySet<string>`  可选参数 + 只读集合。
 *      `?` 表示调用方可以不传；`ReadonlySet` 编译时禁止 add/delete。
 *      ≈ Java 的 `@Nullable Set<String>`（只读是编译期约定，不是运行时保证）。
 *
 *  - `[...terms]`  展开运算符把 Set 转成数组。≈ Java 的 `new ArrayList<>(set)`。
 *
 *  - `.slice(0, MAX_KEYTERMS)`  截取前 N 个。≈ Java 的 `list.subList(0, n)`。
 *
 *  - `catch { }`  省略异常变量的 catch（详见 internalLogging.ts 的说明）
 *
 *  - `export async function ...: Promise<string[]>`  异步函数，返回字符串数组的 Promise
 * ============================================================================
 */
import { basename } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { getBranch } from '../utils/git.js'

// ─── Global keyterms ────────────────────────────────────────────────

const GLOBAL_KEYTERMS: readonly string[] = [
  // 中文补注：下面这份清单全是 Deepgram（语音识别引擎）**不给提示就必错**的词。
  // 甄选标准很严格：只收「程序员会照着拼写念出来」的词。
  // Terms Deepgram consistently mangles without keyword hints.
  // Note: "Claude" and "Anthropic" are already server-side base keyterms.
  // Avoid terms nobody speaks aloud as-spelled (stdout → "standard out").
  'MCP',
  'symlink',
  'grep',
  'regex',
  'localhost',
  'codebase',
  'TypeScript',
  'JSON',
  'OAuth',
  'webhook',
  'gRPC',
  'dotfiles',
  'subagent',
  'worktree',
]

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Split an identifier (camelCase, PascalCase, kebab-case, snake_case, or
 * path segments) into individual words.  Fragments of 2 chars or fewer are
 * discarded to avoid noise.
 */
/**
 * 把一个标识符切成独立的单词。
 *
 * 为什么需要：git 分支名、文件名几乎都是 `feat/voice-keyterms`、`getUserName`
 * 这种连写形式，直接整串丢给 STT 引擎没有意义——
 * 引擎需要的是「你会念出来的那些词」。
 *
 * 切词规则（三步）：
 *   ① 驼峰边界插空格：`getUserName` → `get User Name`
 *   ② 按分隔符切：`-` `_` `.` `/` 空白 都算分隔符
 *   ③ 过滤：长度 ≤ 2 的碎片丢弃（"js"、"ux"、"id" 这类太短，
 *      提权它们只会引入噪声）；长度 > 20 的也丢弃（多半不是正常单词）
 *
 * @param name 待切分的标识符，如 'feat/voice-keyterms'、'getUserName'
 * @returns 切出的单词数组；可能为空
 */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_./\s]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && w.length <= 20)
}

/**
 * 从文件路径里抽出「有识别价值的词」。
 *
 * 为什么要先去掉扩展名：`UserService.test.ts` 里的 `test`、`ts`
 * 对语音识别毫无帮助（用户不会念文件全名），留着只会白白占用关键词名额。
 * 所以先用 basename 取文件名、再正则剥掉最后一个扩展名，剩下的才去切词。
 *
 * @param filePath 文件绝对路径或相对路径
 * @returns 从文件名主干切出的单词数组
 */
function fileNameWords(filePath: string): string[] {
  const stem = basename(filePath).replace(/\.[^.]+$/, '')
  return splitIdentifier(stem)
}

// ─── Public API ─────────────────────────────────────────────────────

const MAX_KEYTERMS = 50

/**
 * Build a list of keyterms for the voice_stream STT endpoint.
 *
 * Combines hardcoded global coding terms with session context (project name,
 * git branch, recent files) without any model calls.
 */
/**
 * 组装最终交给 STT 引擎的关键词表。
 *
 * 为什么需要：语音输入的准确率高度依赖「引擎认不认识你接下来要说的词」。
 * 把项目专属词汇提前喂给它，能把专有名词的误识别率压到可接受范围。
 *
 * 关键步骤：
 *   ① 以全局编程术语表为基底（用 Set 初始化，天然去重）
 *   ② 加入项目根目录名——注意是**整串**加入，因为用户把它当短语说
 *   ③ 加入当前 git 分支名切出的词（feat/voice-keyterms → feat, voice, keyterms）
 *   ④ 加入最近文件名切出的词，但一旦凑够 50 个就立刻停止扫描（省时间）
 *   ⑤ 截断到 50 个返回
 *
 * 容错策略：② ③ 各自独立 try/catch，任何一项失败都不影响其余项，
 * 最差情况下也能返回那份全局术语表。
 *
 * @param recentFiles 最近访问过的文件路径集合，可选；用于补充项目专属词汇
 * @returns 关键词列表，最多 MAX_KEYTERMS(50) 个
 */
export async function getVoiceKeyterms(
  recentFiles?: ReadonlySet<string>,
): Promise<string[]> {
  const terms = new Set<string>(GLOBAL_KEYTERMS)

  // Project root basename as a single term — users say "claude CLI internal"
  // as a phrase, not isolated words. Keeping the whole basename lets the
  // STT's keyterm boosting match the phrase regardless of separator.
  try {
    const projectRoot = getProjectRoot()
    if (projectRoot) {
      const name = basename(projectRoot)
      if (name.length > 2 && name.length <= 50) {
        terms.add(name)
      }
    }
  } catch {
    // getProjectRoot() may throw if not initialised yet — ignore
  }

  // Git branch words (e.g. "feat/voice-keyterms" → "feat", "voice", "keyterms")
  try {
    const branch = await getBranch()
    if (branch) {
      for (const word of splitIdentifier(branch)) {
        terms.add(word)
      }
    }
  } catch {
    // getBranch() may fail if not in a git repo — ignore
  }

  // Recent file names — only scan enough to fill remaining slots
  if (recentFiles) {
    for (const filePath of recentFiles) {
      if (terms.size >= MAX_KEYTERMS) break
      for (const word of fileNameWords(filePath)) {
        terms.add(word)
      }
    }
  }

  return [...terms].slice(0, MAX_KEYTERMS)
}
