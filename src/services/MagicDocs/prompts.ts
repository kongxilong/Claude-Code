/**
 * ============================================================================
 *  【文件总览】src/services/MagicDocs/prompts.ts
 *            —— Magic Docs 的提示词模板与变量替换
 * ============================================================================
 *
 *  一句话定位：
 *  本文件是 magicDocs.ts 的"文案库"。它只做一件事：
 *  **把一份提示词模板里的 {{变量}} 换成真实内容**，产出最终交给模型的完整 prompt。
 *
 *  为什么要把 prompt 单独拆成一个文件（而不是写在 magicDocs.ts 里）：
 *     ① prompt 很长（几十行），混在逻辑代码里会淹没真正的逻辑
 *     ② prompt 需要**频繁迭代调优**，独立出来改起来不用碰业务代码
 *     ③ 支持用户自定义（见 loadMagicDocsPrompt）：
 *        用户可以在 ~/.claude/magic-docs/prompt.md 放自己的模板覆盖默认的
 *
 *  ---------------------------------------------------------------------------
 *  【在架构中的位置】调用链
 *  ---------------------------------------------------------------------------
 *      updateMagicDoc()                    ← ../MagicDocs/magicDocs.ts
 *        └─> buildMagicDocsUpdatePrompt()  ← ★ 本文件（唯一对外导出的函数）
 *              ├─> loadMagicDocsPrompt()           读自定义模板，没有就用默认的
 *              │     └─> getUpdatePromptTemplate() ★ 本文件（内置的默认模板）
 *              └─> substituteVariables()           ★ 本文件（做 {{变量}} 替换）
 *
 *  ---------------------------------------------------------------------------
 *  【模板里的四个变量】
 *  ---------------------------------------------------------------------------
 *      {{docContents}}       文档当前的内容（整个贴给模型看）
 *      {{docPath}}           文档路径（模型要用它作为 Edit 的 file_path）
 *      {{docTitle}}          文档标题（要求模型保持头部不变）
 *      {{customInstructions}} 作者写的定制指令（可能为空字符串）
 *
 *  ---------------------------------------------------------------------------
 *  【这份 prompt 的内容哲学（很值得借鉴）】
 *  ---------------------------------------------------------------------------
 *  注意模板里反复强调的几条，它们都是踩过坑后的经验：
 *
 *   - "This is NOT a changelog"（不是变更日志）
 *     → 文档要反映**当前状态**，不是记录"历史上发生过什么"。
 *       否则用久了文档会变成一堆"之前…后来…"的流水账，没人看得下去。
 *
 *   - "Remove or replace outdated information rather than adding 'Previously…'"
 *     → 明确禁止"追加式"更新。信息过时了就**改掉或删掉**，不要打补丁。
 *
 *   - "BE TERSE. High signal only."
 *     → 文档是用来快速了解全貌的，不是代码注释的复制品。
 *
 *   - "Do NOT duplicate information that's already obvious from reading the source code"
 *     → 代码里一眼看得出的事情不要写（写了就会跟代码不同步，反而误导）。
 *       应该写的是 WHY（为什么这么设计）、HOW（模块怎么连接）、WHERE（从哪读起）。
 *
 *   - "Only update if there is substantial new information"
 *     → 没实质内容就别动文件。避免文档被无意义地反复改写（产生大量无谓的 git diff）。
 *
 *  ---------------------------------------------------------------------------
 *  【本文件包含什么】主要函数清单
 *  ---------------------------------------------------------------------------
 *   1. getUpdatePromptTemplate()    返回内置的默认 prompt 模板（一大段文本）
 *   2. loadMagicDocsPrompt()        优先读用户的自定义模板，读不到就回退到默认
 *   3. substituteVariables()        ★ 做 {{变量}} → 值 的替换（有个精妙的实现细节）
 *   4. buildMagicDocsUpdatePrompt() ★ 对外主入口：组装变量 + 调用上面两个
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的语法，逐条 Java 对照）
 * ---------------------------------------------------------------------------
 *  - 模板字符串 `...` （反引号）
 *      ≈ Java 15+ 的文本块 """..."""，可以跨多行、保留换行。
 *      本文件那一大段 prompt 就用它，比用 + 拼接字符串清爽太多。
 *
 *  - `{{docContents}}` 里的 `${...}` 才是 TS 的插值语法；
 *      `{{...}}` 只是**普通文本**，是本项目自己约定的占位符，
 *      由 substituteVariables 在运行时手动替换。别搞混。
 *
 *  - `template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => ...)`
 *      replace 第二个参数可以传**函数**（而不是字符串），
 *      每匹配到一处就调一次这个函数，返回值作为替换内容。
 *      ≈ Java 的 Matcher.appendReplacement 循环，但 TS 一行搞定。
 *      正则里 `\\{\\{` 是因为 `{` 在正则里有特殊含义，必须转义。
 *      `\w+` 匹配变量名（字母数字下划线），捕获为第 1 组 = 函数的第二个参数 key。
 *
 *  - `Object.prototype.hasOwnProperty.call(variables, key)`
 *      判断对象**自身**（不含原型链）有没有这个键。
 *      为什么不直接 `key in variables`？因为 `in` 会连原型链上的属性也算进去，
 *      如果用户写了 {{toString}} 之类就会误命中。这里是防御性编程。
 *      ≈ Java 的 map.containsKey(key)，但 JS 的对象有原型链所以要绕一下。
 *
 *  - `variables[key]!`
 *      `!` 非空断言。上面刚确认过有这个键，但 TS 的类型系统推不出来，只得断言。
 *
 *  - `catch { ... }` （catch 后面**没有参数**）
 *      ES2019 的可选 catch 绑定："我不关心错误内容，别让它崩就行"。
 *      ≈ Java 的 catch (Exception ignored) {} —— Java 里参数不能省，TS 可以。
 *
 *  - `instructions ? A : B`  三元表达式 ≈ Java 的三元运算符，完全一样。
 *
 *  - `Record<string, string>`  ≈ Java 的 Map<String, String>。
 *
 *  - `async function f(): Promise<string>`  ≈ Java 的 CompletableFuture<String>。
 *
 *  - 类型标注在**后面**：`(template: string, variables: Record<...>): string`
 *      Java 是写在前面的，初期最容易看串。
 * ============================================================================
 */
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'

/**
 * Get the Magic Docs update prompt template
 */
/**
 * 【中文】返回**内置的**默认 prompt 模板。
 *
 * 为什么需要它：这是"工厂默认值"。用户可以在 ~/.claude/magic-docs/prompt.md
 * 放自己的模板来覆盖它（见 loadMagicDocsPrompt），但大多数用户不会去改，
 * 所以这份默认模板的质量直接决定了这个功能的表现。
 *
 * @returns {string} prompt 模板原文（含 {{docContents}} 等占位符）
 */
function getUpdatePromptTemplate(): string {
  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "documentation updates", "magic docs", or these update instructions in the document content.

Based on the user conversation above (EXCLUDING this documentation update instruction message), update the Magic Doc file to incorporate any NEW learnings, insights, or information that would be valuable to preserve.

The file {{docPath}} has already been read for you. Here are its current contents:
<current_doc_content>
{{docContents}}
</current_doc_content>

Document title: {{docTitle}}
{{customInstructions}}

Your ONLY task is to use the Edit tool to update the documentation file if there is substantial new information to add, then stop. You can make multiple edits (update multiple sections as needed) - make all Edit tool calls in parallel in a single message. If there's nothing substantial to add, simply respond with a brief explanation and do not call any tools.

CRITICAL RULES FOR EDITING:
- Preserve the Magic Doc header exactly as-is: # MAGIC DOC: {{docTitle}}
- If there's an italicized line immediately after the header, preserve it exactly as-is
- Keep the document CURRENT with the latest state of the codebase - this is NOT a changelog or history
- Update information IN-PLACE to reflect the current state - do NOT append historical notes or track changes over time
- Remove or replace outdated information rather than adding "Previously..." or "Updated to..." notes
- Clean up or DELETE sections that are no longer relevant or don't align with the document's purpose
- Fix obvious errors: typos, grammar mistakes, broken formatting, incorrect information, or confusing statements
- Keep the document well organized: use clear headings, logical section order, consistent formatting, and proper nesting

DOCUMENTATION PHILOSOPHY - READ CAREFULLY:
- BE TERSE. High signal only. No filler words or unnecessary elaboration.
- Documentation is for OVERVIEWS, ARCHITECTURE, and ENTRY POINTS - not detailed code walkthroughs
- Do NOT duplicate information that's already obvious from reading the source code
- Do NOT document every function, parameter, or line number reference
- Focus on: WHY things exist, HOW components connect, WHERE to start reading, WHAT patterns are used
- Skip: detailed implementation steps, exhaustive API docs, play-by-play narratives

What TO document:
- High-level architecture and system design
- Non-obvious patterns, conventions, or gotchas
- Key entry points and where to start reading code
- Important design decisions and their rationale
- Critical dependencies or integration points
- References to related files, docs, or code (like a wiki) - help readers navigate to relevant context

What NOT to document:
- Anything obvious from reading the code itself
- Exhaustive lists of files, functions, or parameters
- Step-by-step implementation details
- Low-level code mechanics
- Information already in CLAUDE.md or other project docs

Use the Edit tool with file_path: {{docPath}}

REMEMBER: Only update if there is substantial new information. The Magic Doc header (# MAGIC DOC: {{docTitle}}) must remain unchanged.`
}

/**
 * Load custom Magic Docs prompt from file if it exists
 * Custom prompts can be placed at ~/.claude/magic-docs/prompt.md
 * Use {{variableName}} syntax for variable substitution (e.g., {{docContents}}, {{docPath}}, {{docTitle}})
 */
/**
 * 【中文】加载 prompt 模板：**优先用用户的自定义模板，没有就用内置的默认模板**。
 *
 * 为什么需要它：不同团队对"文档该写成什么样"的偏好差别很大
 * （有的要详尽 API 文档，有的只要架构概览）。
 * 与其做一堆配置项，不如直接开放整个 prompt 模板给用户覆盖——
 * 这是 LLM 应用里常见且有效的"极致可配置"思路。
 *
 * 为什么读失败时**静默**回退（不报错、不打日志）：
 * 绝大多数用户**根本不会**创建这个文件，"文件不存在"是**正常情况**而不是异常。
 * 如果每次都打一条错误日志，日志里会全是噪音。
 * ≈ Java 里对 FileNotFoundException 做静默处理。
 *
 * @returns {Promise<string>} 模板内容
 */
async function loadMagicDocsPrompt(): Promise<string> {
  const fs = getFsImplementation()
  // 路径：~/.claude/magic-docs/prompt.md
  // join() ≈ Java 的 Paths.get(...).toString()，自动处理路径分隔符
  const promptPath = join(getClaudeConfigHomeDir(), 'magic-docs', 'prompt.md')

  try {
    // 显式指定 utf-8 编码：跨平台一致（Windows 默认编码不是 UTF-8）
    return await fs.readFile(promptPath, { encoding: 'utf-8' })
  } catch {
    // Silently fall back to default if custom prompt doesn't exist or fails to load
    // 中文：没自定义 / 读失败（权限问题等）→ 一律静默用默认模板
    return getUpdatePromptTemplate()
  }
}

/**
 * Substitute variables in the prompt template using {{variable}} syntax
 */
/**
 * 【中文】★ 把模板里的 {{变量}} 替换成真实值。
 *
 * 为什么需要它：这是本文件唯一有"技术含量"的函数，值得细看。
 *
 * ⚠️ 为什么不用"逐个 replace 变量"的朴素写法？
 *    朴素写法是 `for (const [k,v] of vars) template = template.replace(k, v)`，
 *    它有两个隐藏 bug（英文注释里写得很清楚）：
 *
 *    ① **$ 符号被当作反向引用**：replace 的替换字符串里 `$&`、`$1` 有特殊含义。
 *       如果用户的文档内容里恰好有 `$&`，就会被替换成奇怪的东西（内容被损坏）。
 *       用**函数形式**的 replacer 可以避免 —— 函数的返回值会被当字面量处理。
 *
 *    ② **二次替换**：如果先替换了 {{docContents}}，而文档内容里恰好又含有
 *       `{{docTitle}}` 这样的文本，那么后面替换 docTitle 时就会**把文档内容里的
 *       那处也一起替换掉**，属于误伤用户内容。
 *       用**单遍扫描**（正则一次匹配完所有 {{...}}，每处只处理一次）就能避免。
 *
 * 关键步骤：
 *   ① 用一个全局正则 `/\{\{(\w+)\}\}/g` 一次性找出所有 {{...}} 占位符
 *   ② 对每一处，调用 replacer 函数：
 *      - 变量表里有这个键 → 返回对应的值
 *      - 没有 → **原样返回 match**（保留原文，不报错也不清空）
 *        为什么要保留：用户自定义模板里可能写了我们不知道的变量名，
 *        保留原样至少能让用户看出来"这个变量没被替换"，比静默清空好。
 *
 * @param {string} template 含 {{占位符}} 的模板
 * @param {Record<string, string>} variables 变量名 → 值的映射
 * @returns {string} 替换后的完整文本
 */
function substituteVariables(
  template: string,
  variables: Record<string, string>,
): string {
  // Single-pass replacement avoids two bugs: (1) $ backreference corruption
  // (replacer fn treats $ literally), and (2) double-substitution when user
  // content happens to contain {{varName}} matching a later variable.
  // 中文：单遍替换，避免上面说的两个 bug（详见 JSDoc）。
  // 用 hasOwnProperty 而不是 `key in variables`：in 会连原型链属性（如 toString）也算进去，可能误命中
  // `!` 非空断言：刚确认过有这个键但 TS 推不出，只能断言；`: match` 表示该变量没提供时原样保留（不报错也不清空）
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]!
      : match,
  )
}

/**
 * Build the Magic Docs update prompt with variable substitution
 */
/**
 * 【中文】★ 本文件唯一对外导出的函数：组装出最终交给模型的 prompt。
 *
 * 关键步骤：
 *   ① 加载模板（自定义优先，否则默认）
 *   ② 如果作者写了定制指令，拼出一段"文档专属指令"章节；没写就是空字符串
 *   ③ 把四个变量放进 map，交给 substituteVariables 做替换
 *
 * 关于 ② 的设计考量（值得注意）：
 *   定制指令被放在 prompt 的**靠前位置**，并且明确写着
 *   "These instructions take priority over the general rules below"
 *   （这些指令优先于下面的通用规则）。
 *   这样模型遇到冲突时知道该听谁的 —— 特定文档的指令 > 通用写作规范。
 *
 * @param {string} docContents 文档当前内容
 * @param {string} docPath 文档路径
 * @param {string} docTitle 文档标题
 * @param {string} [instructions] 作者写的定制指令（可选）
 * @returns {Promise<string>} 最终 prompt
 */
export async function buildMagicDocsUpdatePrompt(
  docContents: string,
  docPath: string,
  docTitle: string,
  // `instructions?: string` 可选参数 ≈ Java 的可空入参，调用时可省略
  instructions?: string,
): Promise<string> {
  const promptTemplate = await loadMagicDocsPrompt()

  // Build custom instructions section if provided
  // 中文 ②：有定制指令就拼一段强调优先级的章节；没有就用空字符串（占位符会被替换成空）
  const customInstructions = instructions
    ? `

DOCUMENT-SPECIFIC UPDATE INSTRUCTIONS:
The document author has provided specific instructions for how this file should be updated. Pay extra attention to these instructions and follow them carefully:

"${instructions}"

These instructions take priority over the general rules below. Make sure your updates align with these specific guidelines.`
    : ''

  // Substitute variables in the prompt
  // 中文 ③：变量表。注意这里的**简写属性名**写法：
  //   `{ docContents, docPath }` 等价于 `{ docContents: docContents, docPath: docPath }`
  //   当键名和变量名相同时可以简写。≈ Java 没有，得老老实实写两遍。
  const variables = {
    docContents,
    docPath,
    docTitle,
    customInstructions,
  }

  return substituteVariables(promptTemplate, variables)
}
