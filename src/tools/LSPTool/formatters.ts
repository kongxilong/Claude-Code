/**
 * ============================================================================
 *  【文件总览】src/tools/LSPTool/formatters.ts —— 把 LSP 的返回值「翻译成人话」
 * ============================================================================
 *
 *  【一句话定位】
 *  LSP 协议返回的是一堆嵌套 JSON（Location、DocumentSymbol、CallHierarchyItem…），
 *  直接丢给模型会浪费大量 token、且模型容易读错 URI。
 *  本文件负责把它们压成紧凑的、人能一眼看懂的纯文本，例如：
 *
 *      Found 3 references across 2 files:
 *
 *      src/utils/path.ts:
 *        Line 12:5
 *        Line 88:20
 *
 *      src/utils/fs.ts:
 *        Line 7:3
 *
 *  【在架构中的位置】
 *      src/tools/LSPTool/LSPTool.ts
 *        └─ formatResult(operation, result, cwd)   ← 按 operation 分派
 *              ├─ formatGoToDefinitionResult()     ← ★ 本文件
 *              ├─ formatFindReferencesResult()     ← ★ 本文件
 *              ├─ formatHoverResult()              ← ★ 本文件
 *              ├─ formatDocumentSymbolResult()     ← ★ 本文件
 *              ├─ formatWorkspaceSymbolResult()    ← ★ 本文件
 *              ├─ formatPrepareCallHierarchyResult() ← ★ 本文件
 *              ├─ formatIncomingCallsResult()      ← ★ 本文件
 *              └─ formatOutgoingCallsResult()      ← ★ 本文件
 *                    └─ 返回的字符串最终进入 tool_result，被模型看到
 *
 *  分层（第三次强调）：本文件**完全不知道 LSP 协议怎么走**，
 *  它只是「JSON → 文本」的纯函数；发请求、管进程在 src/services/lsp/。
 *
 *  【本文件包含什么】
 *   私有工具函数：
 *     formatUri()               file:// URI → 尽量短的可读路径
 *     groupByFile()             把一堆结果按文件分组（泛型）
 *     formatLocation()          Location → "path:line:char"
 *     locationLinkToLocation()  LocationLink → Location（统一两种格式）
 *     isLocationLink()          类型守卫：区分 Location 与 LocationLink
 *     extractMarkupText()       hover 的多种内容格式 → 纯文本
 *     symbolKindToString()      SymbolKind 数字枚举 → "Function"/"Class"...
 *     formatDocumentSymbolNode() 递归打印符号树（带缩进）
 *   对外导出（8 个，对应 9 种 operation 中的 8 种；goToImplementation 复用 goToDefinition）：
 *     formatGoToDefinitionResult / formatFindReferencesResult / formatHoverResult
 *     formatDocumentSymbolResult / formatWorkspaceSymbolResult
 *     formatPrepareCallHierarchyResult / formatIncomingCallsResult / formatOutgoingCallsResult
 *
 *  【贯穿全文的三个设计约定 —— 看懂这三点，本文件就不再难】
 *   ① **0-based → 1-based 换算**：LSP 协议里所有 line/character 都从 0 开始，
 *      但人在编辑器里看到的是从 1 开始。所以本文件里凡是 `+ 1` 都是这个换算，
 *      密集出现，不要误以为是 off-by-one 的 bug 补丁。
 *
 *   ② **防御性过滤**：language server 是**第三方进程**，它可能返回
 *      undefined 的 uri、null 的元素、甚至畸形数据。本文件几乎每个函数开头都
 *      有一句 `filter(x => x && x.uri)`，并配一条 logForDebugging 记录异常。
 *      注释里反复出现的 "this should have been caught earlier" 是在说：
 *      「上游（LSPTool.ts）理论上已经过滤过一遍了，这里再兜一次底，
 *        如果这条日志真的打印了，说明上游漏了，是个 bug」。
 *      这是**双保险**，不是冗余代码。
 *
 *   ③ **宁可显示 'No xxx found' 也不要抛异常**：所有格式化函数都返回一个
 *      完整的、解释性的英文句子（比如 'No references found. This may occur if...'），
 *      而不是抛错。因为这段文本是给**模型**看的——模型需要知道「没找到」
 *      以及「可能是什么原因」，才能决定下一步（换个位置试？还是直接回答）。
 *      这是「把失败也编码成信息」的设计。
 *
 *  【TS 语法速查（Java 工程师视角）】
 *   - `function f(a: string, b?: string)`   `b?` 是可选参数。
 *                            ≈ Java 没有可选参数，只能靠重载（overload）模拟。
 *                            在函数体里 b 的类型是 `string | undefined`。
 *
 *   - `<T extends { uri: string } | { location: { uri: string } }>(items: T[])`
 *                            **泛型约束**。要求 T 至少满足两者之一。
 *                            ≈ Java 的 `<T extends UriHolder>`，但这里是
 *                            **结构化约束**（鸭子类型）：T 不需要 implements 任何接口，
 *                            只要"长得像"（有 uri 字段，或有 location.uri 字段）就行。
 *
 *   - `'uri' in item ? item.uri : item.location.uri`
 *                            `in` 运算符做**运行时字段探测**，同时触发编译期收窄。
 *                            ≈ Java 的 `item instanceof A ? ((A) item).uri : ...`
 *                            但 JS 更宽松：只要对象上有这个 key 就成立。
 *
 *   - `item is LocationLink`  类型谓词（见 schemas.ts 的说明）。
 *                            ≈ Java 的 instanceof 模式匹配。
 *
 *   - `` `Found ${n} ${plural(n, 'symbol')} in workspace:` ``
 *                            模板字符串插值，${} 里可以是任意表达式。
 *                            ≈ Java 的 String.format("Found %d %s...", n, ...)
 *                            或 Java 21+ 的 STR."Found \{n} ..."。
 *
 *   - `const [k, v] = t0`     数组解构。本文件里 `Object.entries()` 返回
 *                            [key, value] 二元组数组，解构后直接用。
 *                            ≈ Java 的 Map.Entry<K,V> 但语法上轻得多。
 *
 *   - `lines.push(...arr)`    展开运算符（spread）把数组元素逐个 push 进去。
 *                            ≈ Java 的 `list.addAll(Arrays.asList(arr))`。
 *                            本文件的递归符号树就靠它把子节点的行数组摊平拼进来。
 *
 *   - `Record<SymbolKind, string>`  键值映射类型。
 *                            ≈ `Map<SymbolKind, String>` 的**类型层**写法，
 *                            但运行时就是个普通对象字面量。
 *
 *   - `{ [1]: 'File', [2]: 'Module', ... }`
 *                            对象字面量里的**计算属性名**（方括号）。
 *                            这里 [1] 其实就是 1，写方括号是为了和
 *                            `[SymbolKind.File]: 'File'` 这类写法保持视觉一致。
 *
 *   - `new Map<string, T[]>()`  + `for (const [filePath, items] of byFile)`
 *                            Map 的迭代默认产出 [key, value] 对，配合解构使用。
 *                            ≈ Java 的 `for (var e : map.entrySet())`。
 *                            注意 JS 的 Map 保证**插入顺序**（LinkedHashMap 的行为）。
 *
 *   - `kinds[kind] || 'Unknown'`  `||` 是「falsy 就用右边」。
 *                            ⚠️ 与 `??` 的区别：`||` 会把 0 和 '' 也当成「没有」，
 *                            `??` 只把 null/undefined 当成「没有」。
 *                            这里 kinds[kind] 查不到是 undefined，两者等价；
 *                            但如果将来某个值可能是空字符串，`||` 就会误伤。
 *
 *   - `arr.map(fn).join('\n')` ≈ Java 的 stream().map().collect(joining("\n"))。
 *
 *   - `.replaceAll('\\', '/')`  全局替换（ES2021）。
 *                            ≈ Java 的 `s.replace("\\", "/")`（Java 的这个本来就是全替换，
 *                            而 JS 的 `.replace()` **只替换第一个**，必须写 replaceAll）。
 *                            本文件用它把 Windows 的反斜杠统一成正斜杠显示。
 *
 *   - `catch (error) { ... }` 带绑定的 catch。与 symbolContext.ts 里的 `catch {}` 对比看。
 */

import { relative } from 'path'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  SymbolInformation,
  SymbolKind,
} from 'vscode-languageserver-types'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { plural } from '../../utils/stringUtils.js'

/**
 * 【中文补充】把 LSP 返回的 `file:///a/b/c.ts` 变成给人看的路径。
 *
 * 为什么需要它：直接把 file:// URI 打出来有三个问题——
 *   ① 长（多 7 个字符的前缀，几十个结果就多几百字符）；
 *   ② 带百分号编码（空格变成 %20，中文变成 %E4%B8%AD...），人眼读不懂；
 *   ③ 绝对路径在终端里会换行、且暴露用户家目录。
 *
 * 三条转换规则（按顺序）：
 *   ① 去掉 `file://` 前缀；Windows 下 `file:///C:/x` 会变成 `/C:/x`，要再削掉开头的斜杠
 *   ② decodeURIComponent 解码百分号编码
 *   ③ 如果能转成**相对当前目录**的路径、且转完更短、且不以 `../../` 开头 → 用相对路径
 *
 * 第 ③ 条的两个条件都是为了「可读性」而不是「正确性」：
 *   - 更短才用：绝对路径 `/Users/kxl/p/x.ts` vs 相对 `src/x.ts`，显然后者好读
 *   - 不以 `../../` 开头：`../../../foo/bar.ts` 比绝对路径还难数，索性回退成绝对路径
 *
 * @param uri  LSP 给的 URI（可能是 undefined —— 劣质 server 会这样，见下方防御分支）
 * @param cwd  当前工作目录，用于算相对路径；不传就只做 ①② 两步
 * @returns 可读路径字符串；uri 为空时返回占位符 '<unknown location>'
 *
 * Formats a URI by converting it to a relative path if possible.
 * Handles URI decoding and gracefully falls back to un-decoded path if malformed.
 * Only uses relative paths when shorter and not starting with ../../
 */
function formatUri(uri: string | undefined, cwd?: string): string {
  // Handle undefined/null URIs - this indicates malformed LSP data
  // 【中文补充】这里不抛异常而是返回占位符：因为格式化层是整条链路的最后一环，
  // 抛异常会让「本来 99% 正确的结果」因为一个坏条目全部丢失。宁可显示
  // "<unknown location>" 也要把其余正常结果输出给模型。
  if (!uri) {
    // NOTE: This should ideally be caught earlier with proper error logging
    // This is a defensive backstop in the formatting layer
    logForDebugging(
      'formatUri called with undefined URI - indicates malformed LSP server response',
      { level: 'warn' },
    )
    return '<unknown location>'
  }

  // Remove file:// protocol if present
  // On Windows, file:///C:/path becomes /C:/path after replacing file://
  // We need to strip the leading slash for Windows drive-letter paths
  let filePath = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }

  // Decode URI encoding - handle malformed URIs gracefully
  try {
    filePath = decodeURIComponent(filePath)
  } catch (error) {
    // Log for debugging but continue with un-decoded path
    const errorMsg = errorMessage(error)
    logForDebugging(
      `Failed to decode LSP URI '${uri}': ${errorMsg}. Using un-decoded path: ${filePath}`,
      { level: 'warn' },
    )
    // filePath already contains the un-decoded path, which is still usable
  }

  // Convert to relative path if cwd is provided
  if (cwd) {
    // Normalize separators to forward slashes for consistent display output
    const relativePath = relative(cwd, filePath).replaceAll('\\', '/')
    // Only use relative path if it's shorter and doesn't start with ../..
    // 【中文补充】两个条件都是「为了好读」而非「为了正确」：
    //   ① 相对路径必须比绝对路径更短，否则白转（比如文件在 /tmp 而 cwd 在 /Users/...）
    //   ② 不能以 ../../ 开头 —— 一堆 .. 反而比绝对路径更数不清，宁可不转
    if (
      relativePath.length < filePath.length &&
      !relativePath.startsWith('../../')
    ) {
      return relativePath
    }
  }

  // Normalize separators to forward slashes for consistent display output
  return filePath.replaceAll('\\', '/')
}

/**
 * 【中文补充】把一批结果按「文件」分组，是生成 `xxx.ts:\n  Line 1\n  Line 2` 这种
 * 分层输出的前置步骤。同一个文件的多条结果聚在一起，模型和用户都不用重复读文件名。
 *
 * 为什么要写成泛型？因为本文件有两种数据结构需要分组：
 *   - Location[]             （有 `uri` 字段）—— findReferences 用
 *   - SymbolInformation[]    （有 `location.uri` 字段）—— workspaceSymbol 用
 * 写一个泛型函数吃下两种形状，比复制两份逻辑好维护。
 *
 * @param items 待分组的元素数组
 * @param cwd   传给 formatUri 用于算相对路径
 * @returns Map<可读文件路径, 该文件下的元素数组>
 *          （用 Map 而不是普通对象：键可能是任意字符串，且需要保持插入顺序）
 *
 * Java 对照：`Map<String, List<T>>`，≈ stream().collect(groupingBy(...))，
 *            但这里手写循环是因为分组的 key 要经过 formatUri 加工（不是原始字段值）。
 *
 * Groups items by their file URI.
 * Generic helper that works with both Location[] and SymbolInformation[]
 */
function groupByFile<T extends { uri: string } | { location: { uri: string } }>(
  items: T[],
  cwd?: string,
): Map<string, T[]> {
  const byFile = new Map<string, T[]>()
  for (const item of items) {
    const uri = 'uri' in item ? item.uri : item.location.uri
    const filePath = formatUri(uri, cwd)
    const existingItems = byFile.get(filePath)
    if (existingItems) {
      existingItems.push(item)
    } else {
      byFile.set(filePath, [item])
    }
  }
  return byFile
}

/**
 * 【中文补充】把单个 Location 压成 `路径:行:列` 一行文字。
 *
 * 为什么格式是 `path:line:char`？因为它和 grep/编译器报错的格式一致，
 * 模型和用户都能直接拿去定位，也方便用户复制粘贴到编辑器里跳转。
 *
 * 两处 `+ 1` 都是 **LSP(0-based) → 编辑器(1-based)** 的换算，不是 bug 修复。
 * LSP 协议规定 Position.line / Position.character 都从 0 开始计数。
 *
 * @param location LSP 的 Location（uri + range）
 * @param cwd      当前目录，用于把路径显示成相对路径
 * @returns 形如 "src/utils/path.ts:12:5" 的字符串
 *
 * Formats a Location with file path and line/character position
 */
function formatLocation(location: Location, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd)
  const line = location.range.start.line + 1 // Convert to 1-based
  const character = location.range.start.character + 1 // Convert to 1-based
  return `${filePath}:${line}:${character}`
}

/**
 * Converts LocationLink to Location format for consistent handling
 */
function locationLinkToLocation(link: LocationLink): Location {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  }
}

/**
 * Checks if an object is a LocationLink (has targetUri) vs Location (has uri)
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

/**
 * 【中文补充】格式化「跳转到定义」的结果。
 *
 * 为什么入参类型这么长（Location | Location[] | LocationLink | LocationLink[] | null）？
 * 因为 LSP 协议允许 server 任选其一返回：
 *   - 有些 server 返回单个对象，有些返回数组（可能有多处定义，比如重载）
 *   - Location（uri + range）和 LocationLink（targetUri + targetRange + ...）是
 *     两种不同的表示，前者简单，后者额外带「跳转前选中哪一段」的信息
 * 所以这里先把所有形态**归一成 Location[]** 再处理，后面就只有一种分支了。
 *
 * 三种输出：
 *   0 个 → 返回一句带解释的 'No definition found. ...'（告诉模型可能原因，便于它换策略）
 *   1 个 → `Defined in src/x.ts:12:5`
 *   多个 → `Found 3 definitions:` + 每行缩进两个空格列出来
 *
 * @param result LSP 的原始返回值（形态不定）
 * @param cwd    当前目录，用于路径相对化
 * @returns 给模型看的纯文本结果
 *
 * Formats goToDefinition result
 * Can return Location, LocationLink, or arrays of either
 */
export function formatGoToDefinitionResult(
  result: Location | Location[] | LocationLink | LocationLink[] | null,
  cwd?: string,
): string {
  if (!result) {
    return 'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.'
  }

  if (Array.isArray(result)) {
    // Convert LocationLinks to Locations for uniform handling
    const locations: Location[] = result.map(item =>
      isLocationLink(item) ? locationLinkToLocation(item) : item,
    )

    // Log and filter out any locations with undefined uris
    const invalidLocations = locations.filter(loc => !loc || !loc.uri)
    if (invalidLocations.length > 0) {
      logForDebugging(
        `formatGoToDefinitionResult: Filtering out ${invalidLocations.length} invalid location(s) - this should have been caught earlier`,
        { level: 'warn' },
      )
    }

    const validLocations = locations.filter(loc => loc && loc.uri)

    if (validLocations.length === 0) {
      return 'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.'
    }
    if (validLocations.length === 1) {
      return `Defined in ${formatLocation(validLocations[0]!, cwd)}`
    }
    const locationList = validLocations
      .map(loc => `  ${formatLocation(loc, cwd)}`)
      .join('\n')
    return `Found ${validLocations.length} definitions:\n${locationList}`
  }

  // Single result - convert LocationLink if needed
  const location = isLocationLink(result)
    ? locationLinkToLocation(result)
    : result
  return `Defined in ${formatLocation(location, cwd)}`
}

/**
 * 【中文补充】格式化「查找所有引用」的结果。
 *
 * 与 goToDefinition 最大的区别：引用通常**很多**（几十上百个），
 * 所以这里不是简单罗列，而是**按文件分组**输出：
 *
 *   Found 42 references across 7 files:
 *
 *   src/a.ts:
 *     Line 12:5
 *     Line 88:20
 *   src/b.ts:
 *     Line 3:1
 *
 * 为什么分组？因为不分组的话 42 行全都是 `src/a.ts:12:5` 这种重复的长串，
 * 既浪费 token 又难读。分组后文件名只出现一次。
 *
 * 只有一个结果时走单独的分支（`Found 1 reference:`），是为了避免
 * "Found 1 references" 这种语法错误 —— 模型会模仿这种措辞，细节也要正确。
 *
 * @param result LSP 返回的 Location[]（可能为 null 或空数组）
 * @param cwd    当前目录
 * @returns 分组后的纯文本；空结果返回解释性文案
 *
 * Formats findReferences result
 */
export function formatFindReferencesResult(
  result: Location[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.'
  }

  // Log and filter out any locations with undefined uris
  const invalidLocations = result.filter(loc => !loc || !loc.uri)
  if (invalidLocations.length > 0) {
    logForDebugging(
      `formatFindReferencesResult: Filtering out ${invalidLocations.length} invalid location(s) - this should have been caught earlier`,
      { level: 'warn' },
    )
  }

  const validLocations = result.filter(loc => loc && loc.uri)

  if (validLocations.length === 0) {
    return 'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.'
  }

  if (validLocations.length === 1) {
    return `Found 1 reference:\n  ${formatLocation(validLocations[0]!, cwd)}`
  }

  // Group references by file
  const byFile = groupByFile(validLocations, cwd)

  const lines: string[] = [
    `Found ${validLocations.length} references across ${byFile.size} files:`,
  ]

  for (const [filePath, locations] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const loc of locations) {
      const line = loc.range.start.line + 1
      const character = loc.range.start.character + 1
      lines.push(`  Line ${line}:${character}`)
    }
  }

  return lines.join('\n')
}

/**
 * 【中文补充】hover 的内容在 LSP 里有**三种**历史遗留格式，本函数把它们统一成纯文本。
 *
 * 为什么会这么乱？因为 LSP 的 hover 字段经历过协议演进：
 *   - 老格式 MarkedString：要么是一个裸字符串，要么是 `{ language: 'ts', value: '...' }`
 *   - 新格式 MarkupContent：`{ kind: 'markdown' | 'plaintext', value: '...' }`
 *   - 而且两者都可能是**数组**（多段内容要拼接）
 * 所以入参类型是三者的联合，必须逐个分支处理。这就是下面 `Array.isArray` /
 * `typeof === 'string'` / `'kind' in contents` 三段判断的由来。
 *
 * @param contents hover 返回的 contents 字段（三种格式之一）
 * @returns 拼接后的纯文本；多段之间用两个换行分隔（保留段落感）
 *
 * Extracts text content from MarkupContent or MarkedString
 */
function extractMarkupText(
  contents: MarkupContent | MarkedString | MarkedString[],
): string {
  if (Array.isArray(contents)) {
    return contents
      .map(item => {
        if (typeof item === 'string') {
          return item
        }
        return item.value
      })
      .join('\n\n')
  }

  if (typeof contents === 'string') {
    return contents
  }

  if ('kind' in contents) {
    // MarkupContent
    return contents.value
  }

  // MarkedString object
  return contents.value
}

/**
 * 【中文补充】格式化「悬浮提示」的结果 —— 通常是类型签名 + 文档注释。
 *
 * 注意第二个参数叫 `_cwd` 而不是 `cwd`：下划线前缀是社区的**约定**，
 * 表示「这个参数我知道存在、但本函数体里用不到」（hover 的 range 是相对当前文件的，
 * 不需要跨文件路径转换）。TS 的 noUnusedParameters 规则通常会对 `_` 开头网开一面。
 *
 * 为什么有结果时要在前面加 `Hover info at 12:5:`？
 * 因为 hover 的内容往往是纯类型签名（比如 `function foo(a: number): void`），
 * 不带位置信息的话模型不知道这是在说哪个位置的符号。
 * 只有当 server 返回了 range 时才加（range 是可选字段）。
 *
 * @param result LSP 的 Hover（{ contents, range? }），可能为 null
 * @param _cwd   未使用，仅为保持与其它 formatter 一致的签名
 * @returns 纯文本内容；无结果时返回解释性文案
 *
 * Formats hover result
 */
export function formatHoverResult(result: Hover | null, _cwd?: string): string {
  if (!result) {
    return 'No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.'
  }

  const content = extractMarkupText(result.contents)

  if (result.range) {
    const line = result.range.start.line + 1
    const character = result.range.start.character + 1
    return `Hover info at ${line}:${character}:\n\n${content}`
  }

  return content
}

/**
 * 【中文补充】把 LSP 的 SymbolKind **数字**（1~26）翻译成中文友好的英文单词。
 *
 * 为什么是数字？因为 LSP 协议里 SymbolKind 就是一个 int 枚举（走 JSON-RPC 传输时
 * 不会带上名字）。而模型/用户看到 `kind: 12` 完全不知道是什么，看到 `Function` 才懂。
 *
 * 为什么用 Record<SymbolKind, string> 而不是数组？
 * 因为 SymbolKind 的值**不连续**（比如某些实现里是 1..26，但也可能有自定义值），
 * 用对象做字典查找更安全；查不到时 `|| 'Unknown'` 兜底，不会崩。
 *
 * @param kind LSP SymbolKind 数字
 * @returns 如 'Function' / 'Class' / 'Variable'；未知值返回 'Unknown'
 *
 * Java 对照：≈ switch (kind) { case 1: return "File"; ... default: return "Unknown"; }
 *            只不过这里用查表代替 switch，加新 kind 只改数据不改代码。
 *
 * Maps SymbolKind enum to readable string
 */
function symbolKindToString(kind: SymbolKind): string {
  const kinds: Record<SymbolKind, string> = {
    [1]: 'File',
    [2]: 'Module',
    [3]: 'Namespace',
    [4]: 'Package',
    [5]: 'Class',
    [6]: 'Method',
    [7]: 'Property',
    [8]: 'Field',
    [9]: 'Constructor',
    [10]: 'Enum',
    [11]: 'Interface',
    [12]: 'Function',
    [13]: 'Variable',
    [14]: 'Constant',
    [15]: 'String',
    [16]: 'Number',
    [17]: 'Boolean',
    [18]: 'Array',
    [19]: 'Object',
    [20]: 'Key',
    [21]: 'Null',
    [22]: 'EnumMember',
    [23]: 'Struct',
    [24]: 'Event',
    [25]: 'Operator',
    [26]: 'TypeParameter',
  }
  return kinds[kind] || 'Unknown'
}

/**
 * 【中文补充】递归打印一个符号及其所有子符号，用两个空格的缩进表示层级。
 *
 * 为什么要递归？因为 DocumentSymbol 是**树形结构**：
 *   class Foo                    ← 父
 *     ├ method bar               ← 子
 *     └ class Inner              ← 子（还能再有子）
 * 平铺成一行一行会丢掉「谁属于谁」的信息，所以必须用缩进表达嵌套。
 *
 * 输出形如：
 *   Foo (Class) - Line 10
 *     bar (Method) void - Line 12
 *     Inner (Class) - Line 20
 *
 * @param symbol 当前符号节点
 * @param indent 当前缩进层级（0 = 顶层）。默认参数 0，
 *               ≈ Java 里手写两个重载方法（一个不带参的调用带参的）
 * @returns 字符串数组，**每个元素是一行**（调用方用 push(...arr) 摊平拼接）
 *
 * 注意 `symbol.detail`（比如函数的签名 `void`、类的基类 `: Base`）是可选的，
 * 有就追加、没有就不加 —— 所以这里必须用 if 而不是无条件拼接，否则会出现 "undefined"。
 *
 * Formats a single DocumentSymbol with indentation
 */
function formatDocumentSymbolNode(
  symbol: DocumentSymbol,
  indent: number = 0,
): string[] {
  const lines: string[] = []
  const prefix = '  '.repeat(indent)
  const kind = symbolKindToString(symbol.kind)

  let line = `${prefix}${symbol.name} (${kind})`
  if (symbol.detail) {
    line += ` ${symbol.detail}`
  }

  const symbolLine = symbol.range.start.line + 1
  line += ` - Line ${symbolLine}`

  lines.push(line)

  // Recursively format children
  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1))
    }
  }

  return lines
}

/**
 * 【中文补充】格式化「列出当前文件的所有符号」（≈ IDE 的大纲视图）。
 *
 * 本函数最棘手的一点：LSP 规范允许 server **任选两种格式之一**返回，
 * 而且两种格式结构完全不同：
 *
 *   DocumentSymbol[]      → 树形（有 children，能表达嵌套）→ 用缩进打印
 *   SymbolInformation[]   → 扁平（每项只有 location，没有父子关系）
 *
 * 怎么区分？看**第一个元素**有没有 `location` 字段：
 *   - 有 location → SymbolInformation[] → 直接委托给 formatWorkspaceSymbolResult 处理
 *   - 没有       → DocumentSymbol[]    → 走下面的递归缩进打印
 * 这种「看字段猜类型」的做法叫**运行时类型嗅探**，在对接外部协议时很常见
 * （Java 里对应：收到 JSON 后看有没有某个 key 再决定反序列化成哪个类）。
 *
 * @param result 两种格式之一
 * @param cwd    当前目录
 * @returns 缩进的符号树文本；空结果返回解释性文案
 *
 * Formats documentSymbol result (hierarchical outline)
 * Handles both DocumentSymbol[] (hierarchical, with range) and SymbolInformation[] (flat, with location.range)
 * per LSP spec which allows textDocument/documentSymbol to return either format
 */
export function formatDocumentSymbolResult(
  result: DocumentSymbol[] | SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.'
  }

  // Detect format: DocumentSymbol has 'range' directly, SymbolInformation has 'location.range'
  // Check the first valid element to determine format
  const firstSymbol = result[0]
  const isSymbolInformation = firstSymbol && 'location' in firstSymbol

  if (isSymbolInformation) {
    // Delegate to workspace symbol formatter which handles SymbolInformation[]
    return formatWorkspaceSymbolResult(result as SymbolInformation[], cwd)
  }

  // Handle DocumentSymbol[] format (hierarchical)
  const lines: string[] = ['Document symbols:']

  for (const symbol of result as DocumentSymbol[]) {
    lines.push(...formatDocumentSymbolNode(symbol))
  }

  return lines.join('\n')
}

/**
 * 【中文补充】格式化「全工作区搜索符号」的结果（扁平列表，按文件分组）。
 *
 * 与 documentSymbol 的区别：workspaceSymbol 跨文件（找整个项目里叫 X 的符号），
 * 所以**必须按文件分组**才有可读性；而且 SymbolInformation 没有 children，天然扁平。
 *
 * `containerName` 是什么？符号所属的外层容器（比如某个类的方法会带上类名）。
 * 它是可选字段，有就追加 ` in Foo` —— 因为只显示 `bar (Method)` 无法区分
 * 是哪个类的 bar，模型可能据此做出错误的判断。
 *
 * @param result SymbolInformation[]（每项含 name / kind / location / containerName?）
 * @param cwd    当前目录
 * @returns 形如 `Found 12 symbols in workspace:` + 分组明细；空则解释性文案
 *
 * Formats workspaceSymbol result (flat list of symbols)
 */
export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.'
  }

  // Log and filter out any symbols with undefined location.uri
  const invalidSymbols = result.filter(
    sym => !sym || !sym.location || !sym.location.uri,
  )
  if (invalidSymbols.length > 0) {
    logForDebugging(
      `formatWorkspaceSymbolResult: Filtering out ${invalidSymbols.length} invalid symbol(s) - this should have been caught earlier`,
      { level: 'warn' },
    )
  }

  const validSymbols = result.filter(
    sym => sym && sym.location && sym.location.uri,
  )

  if (validSymbols.length === 0) {
    return 'No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.'
  }

  const lines: string[] = [
    `Found ${validSymbols.length} ${plural(validSymbols.length, 'symbol')} in workspace:`,
  ]

  // Group by file
  const byFile = groupByFile(validSymbols, cwd)

  for (const [filePath, symbols] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const symbol of symbols) {
      const kind = symbolKindToString(symbol.kind)
      const line = symbol.location.range.start.line + 1
      let symbolLine = `  ${symbol.name} (${kind}) - Line ${line}`

      // Add container name if available
      if (symbol.containerName) {
        symbolLine += ` in ${symbol.containerName}`
      }

      lines.push(symbolLine)
    }
  }

  return lines.join('\n')
}

/**
 * 【中文补充】把一个调用层级条目（函数/方法）压成一行：`foo (Function) - src/a.ts:12 [签名]`。
 *
 * 为什么要先校验 `item.uri`？因为调用层级是**两步**请求（先 prepare 再 incoming/outgoing），
 * 中间环节多，劣质 server 更容易返回缺字段的对象。这里校验失败不抛错，
 * 而是显示 `- <unknown location>` —— 保住名字和类型这些仍然有用的信息。
 *
 * @param item  CallHierarchyItem（name / kind / uri / range / detail?）
 * @param cwd   当前目录
 * @returns 单行文本；uri 缺失时位置部分显示占位符
 *
 * Formats a CallHierarchyItem with its location
 * Validates URI before formatting to handle malformed LSP data
 */
function formatCallHierarchyItem(
  item: CallHierarchyItem,
  cwd?: string,
): string {
  // Validate URI - handle undefined/null gracefully
  if (!item.uri) {
    logForDebugging(
      'formatCallHierarchyItem: CallHierarchyItem has undefined URI',
      { level: 'warn' },
    )
    return `${item.name} (${symbolKindToString(item.kind)}) - <unknown location>`
  }

  const filePath = formatUri(item.uri, cwd)
  const line = item.range.start.line + 1
  const kind = symbolKindToString(item.kind)
  let result = `${item.name} (${kind}) - ${filePath}:${line}`
  if (item.detail) {
    result += ` [${item.detail}]`
  }
  return result
}

/**
 * 【中文补充】格式化「调用层级第一步」的结果：光标位置对应的那个函数/方法本身。
 *
 * 为什么要有这一步？因为调用层级是 LSP 里少数**两步**操作：
 *   第 1 步 prepareCallHierarchy：拿光标位置的「锚点」CallHierarchyItem
 *   第 2 步 incomingCalls/outgoingCalls：拿着这个锚点去问「谁调它 / 它调谁」
 * 第 2 步的入参必须是第 1 步返回的对象原样回传（server 靠它定位），
 * 所以本函数的输出主要供**人**确认「锚点选对了没」。
 *
 * @param result 锚点数组（通常 1 个；重载时可能多个）
 * @param cwd    当前目录
 * @returns `Call hierarchy item: xxx` 或 `Found N call hierarchy items:` + 列表
 *
 * Formats prepareCallHierarchy result
 * Returns the call hierarchy item(s) at the given position
 */
export function formatPrepareCallHierarchyResult(
  result: CallHierarchyItem[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No call hierarchy item found at this position'
  }

  if (result.length === 1) {
    return `Call hierarchy item: ${formatCallHierarchyItem(result[0]!, cwd)}`
  }

  const lines = [`Found ${result.length} call hierarchy items:`]
  for (const item of result) {
    lines.push(`  ${formatCallHierarchyItem(item, cwd)}`)
  }
  return lines.join('\n')
}

/**
 * 【中文补充】格式化「谁调用了它」（上游调用方）。
 *
 * 数据形状：CallHierarchyIncomingCall[]，每项的 `from` 是**调用方**，
 * `fromRanges` 是调用方函数体里**实际发起调用的那几行**。
 *
 * 为什么既要显示 from 又要显示 fromRanges？因为同一个调用方可能在多处调用目标，
 * 只知道「A 调了 B」不够，模型常常需要知道「在 A 的第几行调的」才能做修改。
 * 输出形如：
 *   src/a.ts:
 *     handleClick (Function) - Line 30 [calls at: 31:9, 45:12]
 *
 * 为什么这里手写分组而不用 groupByFile？因为 IncomingCall 是 `{ from: {...} }`
 * 的**两层**结构，而 groupByFile 只认 `uri` 或 `location.uri` 两种**一层/两层固定**形状，
 * 套不上，所以只能手写（下面 outgoingCalls 同理）。
 *
 * @param result CallHierarchyIncomingCall[]（可能 null / 空）
 * @param cwd    当前目录
 * @returns 按调用方所在文件分组的文本；空则 'No incoming calls found (nothing calls this function)'
 *
 * Formats incomingCalls result
 * Shows all functions/methods that call the target
 */
export function formatIncomingCallsResult(
  result: CallHierarchyIncomingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No incoming calls found (nothing calls this function)'
  }

  const lines = [
    `Found ${result.length} incoming ${plural(result.length, 'call')}:`,
  ]

  // Group by file
  const byFile = new Map<string, CallHierarchyIncomingCall[]>()
  for (const call of result) {
    if (!call.from) {
      logForDebugging(
        'formatIncomingCallsResult: CallHierarchyIncomingCall has undefined from field',
        { level: 'warn' },
      )
      continue
    }
    const filePath = formatUri(call.from.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) {
      existing.push(call)
    } else {
      byFile.set(filePath, [call])
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.from) {
        continue // Already logged above
      }
      const kind = symbolKindToString(call.from.kind)
      const line = call.from.range.start.line + 1
      let callLine = `  ${call.from.name} (${kind}) - Line ${line}`

      // Show call sites within the caller
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [calls at: ${callSites}]`
      }

      lines.push(callLine)
    }
  }

  return lines.join('\n')
}

/**
 * 【中文补充】格式化「它调用了谁」（下游被调方）—— 与 incomingCalls 完全对称。
 *
 * 对称点：`to` 对应 incoming 的 `from`（这次是**被调方**）；
 * 差异点：`fromRanges` 这回表示「**在当前函数体内**、第几行发起的调用」，
 * 所以展示文案是 `[called from: ...]` 而不是 `[calls at: ...]`。
 * 同一个字段在两个方向语义相反，读代码时容易搞混，这里特意说明。
 *
 * @param result CallHierarchyOutgoingCall[]（可能 null / 空）
 * @param cwd    当前目录
 * @returns 按被调方所在文件分组的文本；空则 'No outgoing calls found (this function calls nothing)'
 *
 * Formats outgoingCalls result
 * Shows all functions/methods called by the target
 */
export function formatOutgoingCallsResult(
  result: CallHierarchyOutgoingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No outgoing calls found (this function calls nothing)'
  }

  const lines = [
    `Found ${result.length} outgoing ${plural(result.length, 'call')}:`,
  ]

  // Group by file
  const byFile = new Map<string, CallHierarchyOutgoingCall[]>()
  for (const call of result) {
    if (!call.to) {
      logForDebugging(
        'formatOutgoingCallsResult: CallHierarchyOutgoingCall has undefined to field',
        { level: 'warn' },
      )
      continue
    }
    const filePath = formatUri(call.to.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) {
      existing.push(call)
    } else {
      byFile.set(filePath, [call])
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.to) {
        continue // Already logged above
      }
      const kind = symbolKindToString(call.to.kind)
      const line = call.to.range.start.line + 1
      let callLine = `  ${call.to.name} (${kind}) - Line ${line}`

      // Show call sites within the current function
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [called from: ${callSites}]`
      }

      lines.push(callLine)
    }
  }

  return lines.join('\n')
}
