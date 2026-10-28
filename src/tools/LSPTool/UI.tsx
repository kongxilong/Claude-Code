/**
 * ============================================================================
 *  【文件总览】src/tools/LSPTool/UI.tsx —— LSP 工具在终端里长什么样
 * ============================================================================
 *
 *  ★★ 读这个文件前必须先知道的一件事 ★★
 *
 *  本文件是 **React Compiler 编译后的产物**，不是人手写的代码。
 *  真正的源码在同目录的 `UI.tsx`（同名），编译后生成你现在看到的这份。
 *  证据有三处：
 *    ① 第 1 行 `import { c as _c } from "react/compiler-runtime"`（编译器注入的运行时）
 *    ② 函数体里到处是 `const $ = _c(24)` 和 `$[0]` `$[1]` 这种**缓存槽位**读写
 *    ③ 末尾有一大串 `//# sourceMappingURL=data:application/json;base64,...`
 *       （把编译后代码映射回原始源码的 sourcemap，就贴在同一行里）
 *
 *  所以：**不要手工编辑本文件**（下次编译会被覆盖），要改就改源码再重新编译。
 *  下面那些 `$[0] !== operation` 的判断，是编译器自动插入的
 *  「这个值变没变？没变就复用上次的缓存」逻辑，等价于手写的 useMemo。
 *
 * ---------------------------------------------------------------------------
 *  【一句话定位】
 *  ---------------------------------------------------------------------------
 *  把 LSP 工具的执行过程画到终端上，三种时机：
 *    renderToolUseMessage()       工具**即将**被调用时：`LSP(operation: "hover", symbol: "foo", in: "src/a.ts")`
 *    renderToolUseErrorMessage()  工具调用**失败**时：`LSP operation failed`
 *    renderToolResultMessage()    工具**返回**后：`Found 42 references across 7 files` （+ Ctrl+O 可展开）
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置】
 *  ---------------------------------------------------------------------------
 *      src/tools/LSPTool/LSPTool.ts
 *        ├─ userFacingName()              ← ★ 本文件（工具显示名 'LSP'）
 *        ├─ renderToolUseMessage()        ← ★ 本文件
 *        ├─ renderToolUseErrorMessage()   ← ★ 本文件
 *        └─ renderToolResultMessage()     ← ★ 本文件
 *              └─ LSPResultSummary（本文件内部组件）
 *                    └─ getSymbolAtPosition() ← src/tools/LSPTool/symbolContext.ts
 *                                              （把行号列号换成实际的符号名，更好读）
 *
 *  分层提醒（LSP 目录通用）：
 *      本文件           ≈ View 层（只管画）
 *      LSPTool.ts       ≈ Controller（校验 + 编排）
 *      src/services/lsp ≈ Service（真正跟 language server 对话）
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 *  ---------------------------------------------------------------------------
 *   OPERATION_LABELS     9 种 operation 各自的单/复数文案（definition/definitions…）
 *   LSPResultSummary     内部组件：结果的「折叠态 / 展开态」两种渲染
 *   userFacingName()     工具显示名常量 'LSP'
 *   renderToolUseMessage()       渲染「即将调用」
 *   renderToolUseErrorMessage()  渲染「调用失败」
 *   renderToolResultMessage()    渲染「结果」
 *
 * ---------------------------------------------------------------------------
 *  【折叠（collapse）是什么？本文件的核心概念】
 *  ---------------------------------------------------------------------------
 *  LSP 结果可能很长（几百行引用），全打出来会把终端刷爆、也浪费上下文。
 *  所以默认只显示**一行摘要**：
 *
 *      ⎿  Found 42 references across 7 files   ← 折叠态（height={1}，只占一行）
 *
 *  用户按 Ctrl+O 才展开看全文（CtrlOToExpand 组件就是那个提示）。
 *  而 `verbose` 参数为 true 时直接展开（对应 `--verbose` 之类的模式）。
 *
 * ---------------------------------------------------------------------------
 *  【TS / TSX 语法速查（Java 工程师视角）】
 *  ---------------------------------------------------------------------------
 *   - `.tsx` 后缀          表示这个文件里可以写 **JSX**（HTML 一样的标签语法）。
 *                          ≈ Java 没有；想象成在代码里直接写 XML 来描述界面。
 *
 *   - JSX：`<Text bold={true}>{n} </Text>`
 *                          ≈ Android 的 XML 布局 + 数据绑定，但它是**真代码**：
 *                          大括号 `{}` 里可以写任意 JS 表达式。
 *                          `<Box flexDirection="row">` 里那些属性就是组件的 props
 *                          （≈ 构造参数 /  setter）。
 *
 *   - `React.ReactNode`    组件函数的返回类型：可以是一个元素、字符串、null、或数组。
 *                          ≈ Java 的 `Object`（很宽泛），但语义上是「可渲染的东西」。
 *                          注意 `renderToolUseMessage` 里 `return ''` 和 `return null`
 *                          都合法 —— 表示「什么都不画」。
 *
 *   - `Partial<Input>`     把 Input 的每个字段都变成**可选**。
 *                          ≈ Java 里再写一个所有字段可空的 DTO。
 *                          为什么这里要用 Partial？因为工具刚被模型请求时，
 *                          参数可能还没解析完整（流式到达），渲染函数必须能容错。
 *
 *   - `Record<Input['operation'], {...}>`
 *                          映射类型：以 operation 的 9 个字面量为**全部** key。
 *                          ≈ `EnumMap`，且编译器保证**一个 key 都不能少**
 *                          （少写一个就报错）。这是类型系统带来的安全感。
 *
 *   - `OPERATION_LABELS[operation] || { singular: 'result', plural: 'results' }`
 *                          `||` 兜底：万一 operation 是个没预料到的值（防御外部输入）。
 *                          ⚠️ 与 `??` 的区别见 formatters.ts 的说明。
 *
 *   - `resultCount === 1 ? labelConfig.singular : labelConfig.plural`
 *                          三元运算符处理**单复数**。英语里 "1 reference" / "2 references"
 *                          必须区分，否则模型和用户都会觉得别扭。
 *
 *   - `<Text>{" "}across <Text bold={true}>{fileCount} </Text>files</Text>`
 *                          `{" "}` 是**显式空格**。为什么不能直接打空格？
 *                          因为 JSX 会把换行和多余空白吃掉，想要一个确定的空格
 *                          就得写成 `{" "}`。这是 JSX 的经典小坑。
 *
 *   - `resultCount > 0 && <CtrlOToExpand />`
 *                          `&&` 短路：条件为 false 时渲染**nothing**。
 *                          ≈ Java 里 `cond ? component : null`，这是 React 的惯用写法。
 *                          注意：如果左边是数字 0，JSX 会真的把 "0" 显示出来 ——
 *                          所以严谨写法是 `resultCount > 0 &&`（本文件正是这么做的）。
 *
 *   - `fileCount > 1 ? <Text>...</Text> : null`
 *                          只有跨多个文件才显示 "across N files"；
 *                          1 个文件时说 "across 1 files" 语法错误且冗余。
 *
 *   - `Symbol.for("react.memo_cache_sentinel")`
 *                          React Compiler 用来标记「这个缓存槽还没写过」的哨兵值。
 *                          ≈ Java 里用 `null` 表示未初始化，但这里不能用 null，
 *                          因为缓存的值**本身**可能就是 null（比如 t3 = null）。
 *                          这是编译产物特有的写法，手写代码里不会出现。
 *
 *   - `bb0: { ... break bb0 }`  带标签的块 + break（goto 的结构化版本）。
 *                          Java 也有 label（但极少用）。这里是编译器用来实现
 *                          「提前 return」的：break 出块后继续执行后面的逻辑。
 *
 *   - `.map(([key, value]) => ...)`  数组 map，回调参数用**数组解构**。
 *                          ≈ Java 的 stream().map(e -> f(e.getKey(), e.getValue()))。
 *
 *   - `parts.join(', ')`  把字符串数组用逗号连起来。
 *                          ≈ Java 的 String.join(", ", parts)。
 *
 *   - `const { verbose }: { verbose: boolean }`
 *                          **参数解构 + 类型标注**：直接从第一个参数里取出 verbose，
 *                          同时声明这个参数对象的类型。
 *                          ≈ Java 里 `void f(Options o)` 然后 `o.isVerbose()`，
 *                          但 TS 一步到位。
 *
 *   - `extractTag(result, 'tool_use_error')`
 *                          从可能带 XML 标签的错误文本里抠出指定标签的内容。
 *                          非 verbose 模式下只显示一句简短的 'LSP operation failed'，
 *                          详细堆栈要 verbose 才展开 —— 避免刷屏。
 */

import { c as _c } from "react/compiler-runtime";
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React from 'react';
import { CtrlOToExpand } from '../../components/CtrlOToExpand.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Box, Text } from '../../ink.js';
import { getDisplayPath } from '../../utils/file.js';
import { extractTag } from '../../utils/messages.js';
import type { Input, Output } from './LSPTool.js';
import { getSymbolAtPosition } from './symbolContext.js';

// Lookup map for operation-specific labels
// 【中文补充】9 种 operation 各自的「单/复数说法」，用于拼出
//   "Found 1 reference"  /  "Found 42 references"
// 英语必须区分单复数，所以用一张表预先备好两种形式。
//
// `Record<Input['operation'], {...}>` 的妙处：编译器会检查**9 个 key 一个都不能少**，
// 将来 LSPTool 新增一种 operation 却忘了在这里加文案，编译期就报错（≈ EnumMap + 穷尽检查）。
//
// hover 比较特殊：它不是「找到了 N 个东西」，而是「有没有信息」，
// 所以它额外有一个 `special: 'available'` 字段，最终渲染成
//   "Hover info available"（而不是别扭的 "Found 1 hover info"）。
const OPERATION_LABELS: Record<Input['operation'], {
  singular: string;
  plural: string;
  special?: string;
}> = {
  goToDefinition: {
    singular: 'definition',
    plural: 'definitions'
  },
  findReferences: {
    singular: 'reference',
    plural: 'references'
  },
  documentSymbol: {
    singular: 'symbol',
    plural: 'symbols'
  },
  workspaceSymbol: {
    singular: 'symbol',
    plural: 'symbols'
  },
  hover: {
    singular: 'hover info',
    plural: 'hover info',
    special: 'available'
  },
  goToImplementation: {
    singular: 'implementation',
    plural: 'implementations'
  },
  prepareCallHierarchy: {
    singular: 'call item',
    plural: 'call items'
  },
  incomingCalls: {
    singular: 'caller',
    plural: 'callers'
  },
  outgoingCalls: {
    singular: 'callee',
    plural: 'callees'
  }
};

/**
 * 【中文补充】LSP 结果的「摘要组件」，支持折叠 / 展开两种形态。
 *
 * 折叠态（verbose = false）：只占一行，末尾挂一个 Ctrl+O 提示
 *     ⎿  Found 42 references across 7 files   ← Ctrl+O 可展开
 *   为什么只占一行？因为 LSP 结果动辄上百行，全打出来会刷屏、
 *   也会把大量文本塞进上下文。默认给摘要，用户想看再展开。
 *
 * 展开态（verbose = true）：把完整内容原样输出（缩进 5 格对齐）
 *     ⎿  Found 42 references across 7 files
 *        src/a.ts:
 *          Line 12:5
 *          ...
 *
 * 参数里的 resultCount / fileCount 来自 LSPTool.ts 的 formatResult()，
 * 只有**成功**路径才会带上；出错时是 undefined，于是在
 * renderToolResultMessage 里走另一条兜底分支（见下方说明）。
 *
 * Reusable component for LSP result summaries with collapsed/expanded views
 */
function LSPResultSummary(t0) {
  const $ = _c(24);
  const {
    operation,
    resultCount,
    fileCount,
    content,
    verbose
  } = t0;
  let t1;
  if ($[0] !== operation) {
    t1 = OPERATION_LABELS[operation] || {
      singular: "result",
      plural: "results"
    };
    $[0] = operation;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const labelConfig = t1;
  const countLabel = resultCount === 1 ? labelConfig.singular : labelConfig.plural;
  let t2;
  if ($[2] !== countLabel || $[3] !== labelConfig.special || $[4] !== operation || $[5] !== resultCount) {
    t2 = operation === "hover" && resultCount > 0 && labelConfig.special ? <Text>Hover info {labelConfig.special}</Text> : <Text>Found <Text bold={true}>{resultCount} </Text>{countLabel}</Text>;
    $[2] = countLabel;
    $[3] = labelConfig.special;
    $[4] = operation;
    $[5] = resultCount;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  const primaryText = t2;
  let t3;
  if ($[7] !== fileCount) {
    t3 = fileCount > 1 ? <Text>{" "}across <Text bold={true}>{fileCount} </Text>files</Text> : null;
    $[7] = fileCount;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  const secondaryText = t3;
  if (verbose) {
    let t4;
    if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = <Text dimColor={true}>  ⎿  </Text>;
      $[9] = t4;
    } else {
      t4 = $[9];
    }
    let t5;
    if ($[10] !== primaryText || $[11] !== secondaryText) {
      t5 = <Box flexDirection="row"><Text>{t4}{primaryText}{secondaryText}</Text></Box>;
      $[10] = primaryText;
      $[11] = secondaryText;
      $[12] = t5;
    } else {
      t5 = $[12];
    }
    let t6;
    if ($[13] !== content) {
      t6 = <Box marginLeft={5}><Text>{content}</Text></Box>;
      $[13] = content;
      $[14] = t6;
    } else {
      t6 = $[14];
    }
    let t7;
    if ($[15] !== t5 || $[16] !== t6) {
      t7 = <Box flexDirection="column">{t5}{t6}</Box>;
      $[15] = t5;
      $[16] = t6;
      $[17] = t7;
    } else {
      t7 = $[17];
    }
    return t7;
  }
  let t4;
  if ($[18] !== resultCount) {
    t4 = resultCount > 0 && <CtrlOToExpand />;
    $[18] = resultCount;
    $[19] = t4;
  } else {
    t4 = $[19];
  }
  let t5;
  if ($[20] !== primaryText || $[21] !== secondaryText || $[22] !== t4) {
    t5 = <MessageResponse height={1}><Text>{primaryText}{secondaryText} {t4}</Text></MessageResponse>;
    $[20] = primaryText;
    $[21] = secondaryText;
    $[22] = t4;
    $[23] = t5;
  } else {
    t5 = $[23];
  }
  return t5;
}
/**
 * 【中文补充】工具在 UI 上显示的名字。
 *
 * 为什么要有这个（而不是直接用 name）？因为内部工具名（'LSP'）和
 * 给用户看的名字可能需要不同大小写/措辞，拆开一个函数方便单独调整。
 * 这里两者恰好相同。
 *
 * 注意它是 `() => 'LSP'` 而不是常量字符串：Tool 接口规定这是个**函数**，
 * 因为有些工具的名字要随上下文变化（比如 MCP 工具带 server 名）。
 */
export function userFacingName(): string {
  return 'LSP';
}
/**
 * 【中文补充】渲染「工具即将被调用」那一行，例如：
 *     LSP(operation: "goToDefinition", symbol: "handleClick", in: "src/a.ts")
 *
 * 为什么不直接打印 `position: 42:13`？因为人看坐标毫无感觉，
 * 而看到 symbol 名立刻知道模型在查什么。所以对于**依赖光标位置**的 4 种
 * operation，会去文件里把那个位置的标识符抠出来（getSymbolAtPosition）。
 *
 * 抠不到（返回 null，比如文件太大、越界、该位置是空白）就**降级**显示坐标，
 * 绝不因为显示问题让工具调不起来。
 *
 * 关键细节：`input.line - 1` / `input.character - 1` ——
 *   工具的入参是 1-based（编辑器那样），而读文件用的是 0-based 数组下标，
 *   这里做一次换算。与 LSPTool.ts 里发给 LSP 前的 -1 是**同一套**坐标约定。
 *
 * 另外 `Partial<Input>`：参数可能不完整（流式解析中），所以每个字段都要判空。
 *
 * documentSymbol / workspaceSymbol 不需要位置，走下面那段更简单的分支。
 *
 * @param input   模型填的入参（可能不完整）
 * @param verbose true 时显示完整绝对路径；false 时显示相对/缩写路径（getDisplayPath）
 * @returns 一行文本，或 null（连 operation 都没有时）
 */
export function renderToolUseMessage(input: Partial<Input>, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!input.operation) {
    return null;
  }
  const parts: string[] = [];

  // For position-based operations (goToDefinition, findReferences, hover, goToImplementation),
  // show the symbol at the position for better context
  if ((input.operation === 'goToDefinition' || input.operation === 'findReferences' || input.operation === 'hover' || input.operation === 'goToImplementation') && input.filePath && input.line !== undefined && input.character !== undefined) {
    // Convert from 1-based (user input) to 0-based (internal file reading)
    const symbol = getSymbolAtPosition(input.filePath, input.line - 1, input.character - 1);
    const displayPath = verbose ? input.filePath : getDisplayPath(input.filePath);
    if (symbol) {
      parts.push(`operation: "${input.operation}"`);
      parts.push(`symbol: "${symbol}"`);
      parts.push(`in: "${displayPath}"`);
    } else {
      parts.push(`operation: "${input.operation}"`);
      parts.push(`file: "${displayPath}"`);
      parts.push(`position: ${input.line}:${input.character}`);
    }
    return parts.join(', ');
  }

  // For other operations (documentSymbol, workspaceSymbol),
  // show operation and file without position details
  parts.push(`operation: "${input.operation}"`);
  if (input.filePath) {
    const displayPath = verbose ? input.filePath : getDisplayPath(input.filePath);
    parts.push(`file: "${displayPath}"`);
  }
  return parts.join(', ');
}
/**
 * 【中文补充】渲染「工具调用失败」那一行。
 *
 * 为什么要分 verbose / 非 verbose 两种？
 *   非 verbose：只显示一句 `LSP operation failed`。
 *     完整的报错（可能带 XML 标签、堆栈、多行）会刷屏，
 *     而用户此时只需要知道「失败了」；详细内容模型那边已经有了。
 *   verbose：原样交给 FallbackToolUseErrorMessage 全量展开，方便排查。
 *
 * `extractTag(result, 'tool_use_error')` 的作用：判断这段报错里到底**有没有**
 * tool_use_error 标签的内容。没有的话（比如结果是别的结构）就别显示那句
 * 干巴巴的 "failed"，直接走 fallback 全量渲染更诚实。
 *
 * @param result  失败信息（可能是字符串，也可能是结构化的 content 块）
 * @param verbose 是否展开详细信息
 * @returns React 元素
 */
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    return <MessageResponse>
        <Text color="error">LSP operation failed</Text>
      </MessageResponse>;
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}
/**
 * 【中文补充】渲染「工具返回后」的结果。
 *
 * ★ 这里有一个容易忽略但很重要的分支条件：
 *     `output.resultCount !== undefined && output.fileCount !== undefined`
 *
 *   这两个字段只有在**成功路径**下才会被填上（见 LSPTool.ts 的 formatResult）。
 *   而出错时（manager 没初始化、文件太大、请求抛异常）Output 里只有 result 文案，
 *   没有计数 —— 于是走下面那条**兜底分支**，直接把 result 原样显示出来。
 *
 *   也就是说：**「有没有计数」被当成了「成功还是失败」的判别标志**。
 *   这是个隐式约定，改动 LSPTool.ts 的 Output 时别破坏它。
 *
 * @param output            工具的 Output（LSPTool.ts 里定义的那个）
 * @param _progressMessages 进度消息（LSP 工具不发进度，故忽略；下划线前缀即此意）
 * @param verbose           是否展开完整内容
 * @returns React 元素
 */
export function renderToolResultMessage(output: Output, _progressMessages: unknown[], {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  // Use collapsed/expanded view if we have count information
  if (output.resultCount !== undefined && output.fileCount !== undefined) {
    return <LSPResultSummary operation={output.operation} resultCount={output.resultCount} fileCount={output.fileCount} content={output.result} verbose={verbose} />;
  }

  // Fallback for error cases where counts aren't available
  // (e.g., LSP server initialization failures, request errors)
  return <MessageResponse>
      <Text>{output.result}</Text>
    </MessageResponse>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUb29sUmVzdWx0QmxvY2tQYXJhbSIsIlJlYWN0IiwiQ3RybE9Ub0V4cGFuZCIsIkZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSIsIk1lc3NhZ2VSZXNwb25zZSIsIkJveCIsIlRleHQiLCJnZXREaXNwbGF5UGF0aCIsImV4dHJhY3RUYWciLCJJbnB1dCIsIk91dHB1dCIsImdldFN5bWJvbEF0UG9zaXRpb24iLCJPUEVSQVRJT05fTEFCRUxTIiwiUmVjb3JkIiwic2luZ3VsYXIiLCJwbHVyYWwiLCJzcGVjaWFsIiwiZ29Ub0RlZmluaXRpb24iLCJmaW5kUmVmZXJlbmNlcyIsImRvY3VtZW50U3ltYm9sIiwid29ya3NwYWNlU3ltYm9sIiwiaG92ZXIiLCJnb1RvSW1wbGVtZW50YXRpb24iLCJwcmVwYXJlQ2FsbEhpZXJhcmNoeSIsImluY29taW5nQ2FsbHMiLCJvdXRnb2luZ0NhbGxzIiwiTFNQUmVzdWx0U3VtbWFyeSIsInQwIiwiJCIsIl9jIiwib3BlcmF0aW9uIiwicmVzdWx0Q291bnQiLCJmaWxlQ291bnQiLCJjb250ZW50IiwidmVyYm9zZSIsInQxIiwibGFiZWxDb25maWciLCJjb3VudExhYmVsIiwidDIiLCJwcmltYXJ5VGV4dCIsInQzIiwic2Vjb25kYXJ5VGV4dCIsInQ0IiwiU3ltYm9sIiwiZm9yIiwidDUiLCJ0NiIsInQ3IiwidXNlckZhY2luZ05hbWUiLCJyZW5kZXJUb29sVXNlTWVzc2FnZSIsImlucHV0IiwiUGFydGlhbCIsIlJlYWN0Tm9kZSIsInBhcnRzIiwiZmlsZVBhdGgiLCJsaW5lIiwidW5kZWZpbmVkIiwiY2hhcmFjdGVyIiwic3ltYm9sIiwiZGlzcGxheVBhdGgiLCJwdXNoIiwiam9pbiIsInJlbmRlclRvb2xVc2VFcnJvck1lc3NhZ2UiLCJyZXN1bHQiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsIm91dHB1dCIsIl9wcm9ncmVzc01lc3NhZ2VzIl0sInNvdXJjZXMiOlsiVUkudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVG9vbFJlc3VsdEJsb2NrUGFyYW0gfSBmcm9tICdAYW50aHJvcGljLWFpL3Nkay9yZXNvdXJjZXMvaW5kZXgubWpzJ1xuaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQ3RybE9Ub0V4cGFuZCB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvQ3RybE9Ub0V4cGFuZC5qcydcbmltcG9ydCB7IEZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvRmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyBnZXREaXNwbGF5UGF0aCB9IGZyb20gJy4uLy4uL3V0aWxzL2ZpbGUuanMnXG5pbXBvcnQgeyBleHRyYWN0VGFnIH0gZnJvbSAnLi4vLi4vdXRpbHMvbWVzc2FnZXMuanMnXG5pbXBvcnQgdHlwZSB7IElucHV0LCBPdXRwdXQgfSBmcm9tICcuL0xTUFRvb2wuanMnXG5pbXBvcnQgeyBnZXRTeW1ib2xBdFBvc2l0aW9uIH0gZnJvbSAnLi9zeW1ib2xDb250ZXh0LmpzJ1xuXG4vLyBMb29rdXAgbWFwIGZvciBvcGVyYXRpb24tc3BlY2lmaWMgbGFiZWxzXG5jb25zdCBPUEVSQVRJT05fTEFCRUxTOiBSZWNvcmQ8XG4gIElucHV0WydvcGVyYXRpb24nXSxcbiAgeyBzaW5ndWxhcjogc3RyaW5nOyBwbHVyYWw6IHN0cmluZzsgc3BlY2lhbD86IHN0cmluZyB9XG4+ID0ge1xuICBnb1RvRGVmaW5pdGlvbjogeyBzaW5ndWxhcjogJ2RlZmluaXRpb24nLCBwbHVyYWw6ICdkZWZpbml0aW9ucycgfSxcbiAgZmluZFJlZmVyZW5jZXM6IHsgc2luZ3VsYXI6ICdyZWZlcmVuY2UnLCBwbHVyYWw6ICdyZWZlcmVuY2VzJyB9LFxuICBkb2N1bWVudFN5bWJvbDogeyBzaW5ndWxhcjogJ3N5bWJvbCcsIHBsdXJhbDogJ3N5bWJvbHMnIH0sXG4gIHdvcmtzcGFjZVN5bWJvbDogeyBzaW5ndWxhcjogJ3N5bWJvbCcsIHBsdXJhbDogJ3N5bWJvbHMnIH0sXG4gIGhvdmVyOiB7IHNpbmd1bGFyOiAnaG92ZXIgaW5mbycsIHBsdXJhbDogJ2hvdmVyIGluZm8nLCBzcGVjaWFsOiAnYXZhaWxhYmxlJyB9LFxuICBnb1RvSW1wbGVtZW50YXRpb246IHsgc2luZ3VsYXI6ICdpbXBsZW1lbnRhdGlvbicsIHBsdXJhbDogJ2ltcGxlbWVudGF0aW9ucycgfSxcbiAgcHJlcGFyZUNhbGxIaWVyYXJjaHk6IHsgc2luZ3VsYXI6ICdjYWxsIGl0ZW0nLCBwbHVyYWw6ICdjYWxsIGl0ZW1zJyB9LFxuICBpbmNvbWluZ0NhbGxzOiB7IHNpbmd1bGFyOiAnY2FsbGVyJywgcGx1cmFsOiAnY2FsbGVycycgfSxcbiAgb3V0Z29pbmdDYWxsczogeyBzaW5ndWxhcjogJ2NhbGxlZScsIHBsdXJhbDogJ2NhbGxlZXMnIH0sXG59XG5cbi8qKlxuICogUmV1c2FibGUgY29tcG9uZW50IGZvciBMU1AgcmVzdWx0IHN1bW1hcmllcyB3aXRoIGNvbGxhcHNlZC9leHBhbmRlZCB2aWV3c1xuICovXG5mdW5jdGlvbiBMU1BSZXN1bHRTdW1tYXJ5KHtcbiAgb3BlcmF0aW9uLFxuICByZXN1bHRDb3VudCxcbiAgZmlsZUNvdW50LFxuICBjb250ZW50LFxuICB2ZXJib3NlLFxufToge1xuICBvcGVyYXRpb246IElucHV0WydvcGVyYXRpb24nXVxuICByZXN1bHRDb3VudDogbnVtYmVyXG4gIGZpbGVDb3VudDogbnVtYmVyXG4gIGNvbnRlbnQ6IHN0cmluZ1xuICB2ZXJib3NlOiBib29sZWFuXG59KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgLy8gR2V0IGxhYmVsIGNvbmZpZ3VyYXRpb24gZm9yIHRoaXMgb3BlcmF0aW9uXG4gIGNvbnN0IGxhYmVsQ29uZmlnID0gT1BFUkFUSU9OX0xBQkVMU1tvcGVyYXRpb25dIHx8IHtcbiAgICBzaW5ndWxhcjogJ3Jlc3VsdCcsXG4gICAgcGx1cmFsOiAncmVzdWx0cycsXG4gIH1cbiAgY29uc3QgY291bnRMYWJlbCA9XG4gICAgcmVzdWx0Q291bnQgPT09IDEgPyBsYWJlbENvbmZpZy5zaW5ndWxhciA6IGxhYmVsQ29uZmlnLnBsdXJhbFxuXG4gIGNvbnN0IHByaW1hcnlUZXh0ID1cbiAgICBvcGVyYXRpb24gPT09ICdob3ZlcicgJiYgcmVzdWx0Q291bnQgPiAwICYmIGxhYmVsQ29uZmlnLnNwZWNpYWwgPyAoXG4gICAgICA8VGV4dD5Ib3ZlciBpbmZvIHtsYWJlbENvbmZpZy5zcGVjaWFsfTwvVGV4dD5cbiAgICApIDogKFxuICAgICAgPFRleHQ+XG4gICAgICAgIEZvdW5kIDxUZXh0IGJvbGQ+e3Jlc3VsdENvdW50fSA8L1RleHQ+XG4gICAgICAgIHtjb3VudExhYmVsfVxuICAgICAgPC9UZXh0PlxuICAgIClcblxuICBjb25zdCBzZWNvbmRhcnlUZXh0ID1cbiAgICBmaWxlQ291bnQgPiAxID8gKFxuICAgICAgPFRleHQ+XG4gICAgICAgIHsnICd9XG4gICAgICAgIGFjcm9zcyA8VGV4dCBib2xkPntmaWxlQ291bnR9IDwvVGV4dD5cbiAgICAgICAgZmlsZXNcbiAgICAgIDwvVGV4dD5cbiAgICApIDogbnVsbFxuXG4gIGlmICh2ZXJib3NlKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJyb3dcIj5cbiAgICAgICAgICA8VGV4dD5cbiAgICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPiZuYnNwOyZuYnNwO+KOvyAmbmJzcDs8L1RleHQ+XG4gICAgICAgICAgICB7cHJpbWFyeVRleHR9XG4gICAgICAgICAgICB7c2Vjb25kYXJ5VGV4dH1cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgICA8Qm94IG1hcmdpbkxlZnQ9ezV9PlxuICAgICAgICAgIDxUZXh0Pntjb250ZW50fTwvVGV4dD5cbiAgICAgICAgPC9Cb3g+XG4gICAgICA8L0JveD5cbiAgICApXG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2UgaGVpZ2h0PXsxfT5cbiAgICAgIDxUZXh0PlxuICAgICAgICB7cHJpbWFyeVRleHR9XG4gICAgICAgIHtzZWNvbmRhcnlUZXh0fSB7cmVzdWx0Q291bnQgPiAwICYmIDxDdHJsT1RvRXhwYW5kIC8+fVxuICAgICAgPC9UZXh0PlxuICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1c2VyRmFjaW5nTmFtZSgpOiBzdHJpbmcge1xuICByZXR1cm4gJ0xTUCdcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VNZXNzYWdlKFxuICBpbnB1dDogUGFydGlhbDxJbnB1dD4sXG4gIHsgdmVyYm9zZSB9OiB7IHZlcmJvc2U6IGJvb2xlYW4gfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGlmICghaW5wdXQub3BlcmF0aW9uKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdXG5cbiAgLy8gRm9yIHBvc2l0aW9uLWJhc2VkIG9wZXJhdGlvbnMgKGdvVG9EZWZpbml0aW9uLCBmaW5kUmVmZXJlbmNlcywgaG92ZXIsIGdvVG9JbXBsZW1lbnRhdGlvbiksXG4gIC8vIHNob3cgdGhlIHN5bWJvbCBhdCB0aGUgcG9zaXRpb24gZm9yIGJldHRlciBjb250ZXh0XG4gIGlmIChcbiAgICAoaW5wdXQub3BlcmF0aW9uID09PSAnZ29Ub0RlZmluaXRpb24nIHx8XG4gICAgICBpbnB1dC5vcGVyYXRpb24gPT09ICdmaW5kUmVmZXJlbmNlcycgfHxcbiAgICAgIGlucHV0Lm9wZXJhdGlvbiA9PT0gJ2hvdmVyJyB8fFxuICAgICAgaW5wdXQub3BlcmF0aW9uID09PSAnZ29Ub0ltcGxlbWVudGF0aW9uJykgJiZcbiAgICBpbnB1dC5maWxlUGF0aCAmJlxuICAgIGlucHV0LmxpbmUgIT09IHVuZGVmaW5lZCAmJlxuICAgIGlucHV0LmNoYXJhY3RlciAhPT0gdW5kZWZpbmVkXG4gICkge1xuICAgIC8vIENvbnZlcnQgZnJvbSAxLWJhc2VkICh1c2VyIGlucHV0KSB0byAwLWJhc2VkIChpbnRlcm5hbCBmaWxlIHJlYWRpbmcpXG4gICAgY29uc3Qgc3ltYm9sID0gZ2V0U3ltYm9sQXRQb3NpdGlvbihcbiAgICAgIGlucHV0LmZpbGVQYXRoLFxuICAgICAgaW5wdXQubGluZSAtIDEsXG4gICAgICBpbnB1dC5jaGFyYWN0ZXIgLSAxLFxuICAgIClcbiAgICBjb25zdCBkaXNwbGF5UGF0aCA9IHZlcmJvc2VcbiAgICAgID8gaW5wdXQuZmlsZVBhdGhcbiAgICAgIDogZ2V0RGlzcGxheVBhdGgoaW5wdXQuZmlsZVBhdGgpXG5cbiAgICBpZiAoc3ltYm9sKSB7XG4gICAgICBwYXJ0cy5wdXNoKGBvcGVyYXRpb246IFwiJHtpbnB1dC5vcGVyYXRpb259XCJgKVxuICAgICAgcGFydHMucHVzaChgc3ltYm9sOiBcIiR7c3ltYm9sfVwiYClcbiAgICAgIHBhcnRzLnB1c2goYGluOiBcIiR7ZGlzcGxheVBhdGh9XCJgKVxuICAgIH0gZWxzZSB7XG4gICAgICBwYXJ0cy5wdXNoKGBvcGVyYXRpb246IFwiJHtpbnB1dC5vcGVyYXRpb259XCJgKVxuICAgICAgcGFydHMucHVzaChgZmlsZTogXCIke2Rpc3BsYXlQYXRofVwiYClcbiAgICAgIHBhcnRzLnB1c2goYHBvc2l0aW9uOiAke2lucHV0LmxpbmV9OiR7aW5wdXQuY2hhcmFjdGVyfWApXG4gICAgfVxuXG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oJywgJylcbiAgfVxuXG4gIC8vIEZvciBvdGhlciBvcGVyYXRpb25zIChkb2N1bWVudFN5bWJvbCwgd29ya3NwYWNlU3ltYm9sKSxcbiAgLy8gc2hvdyBvcGVyYXRpb24gYW5kIGZpbGUgd2l0aG91dCBwb3NpdGlvbiBkZXRhaWxzXG4gIHBhcnRzLnB1c2goYG9wZXJhdGlvbjogXCIke2lucHV0Lm9wZXJhdGlvbn1cImApXG5cbiAgaWYgKGlucHV0LmZpbGVQYXRoKSB7XG4gICAgY29uc3QgZGlzcGxheVBhdGggPSB2ZXJib3NlXG4gICAgICA/IGlucHV0LmZpbGVQYXRoXG4gICAgICA6IGdldERpc3BsYXlQYXRoKGlucHV0LmZpbGVQYXRoKVxuICAgIHBhcnRzLnB1c2goYGZpbGU6IFwiJHtkaXNwbGF5UGF0aH1cImApXG4gIH1cblxuICByZXR1cm4gcGFydHMuam9pbignLCAnKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZUVycm9yTWVzc2FnZShcbiAgcmVzdWx0OiBUb29sUmVzdWx0QmxvY2tQYXJhbVsnY29udGVudCddLFxuICB7IHZlcmJvc2UgfTogeyB2ZXJib3NlOiBib29sZWFuIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAoXG4gICAgIXZlcmJvc2UgJiZcbiAgICB0eXBlb2YgcmVzdWx0ID09PSAnc3RyaW5nJyAmJlxuICAgIGV4dHJhY3RUYWcocmVzdWx0LCAndG9vbF91c2VfZXJyb3InKVxuICApIHtcbiAgICByZXR1cm4gKFxuICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPkxTUCBvcGVyYXRpb24gZmFpbGVkPC9UZXh0PlxuICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgKVxuICB9XG4gIHJldHVybiA8RmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlIHJlc3VsdD17cmVzdWx0fSB2ZXJib3NlPXt2ZXJib3NlfSAvPlxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2UoXG4gIG91dHB1dDogT3V0cHV0LFxuICBfcHJvZ3Jlc3NNZXNzYWdlczogdW5rbm93bltdLFxuICB7IHZlcmJvc2UgfTogeyB2ZXJib3NlOiBib29sZWFuIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICAvLyBVc2UgY29sbGFwc2VkL2V4cGFuZGVkIHZpZXcgaWYgd2UgaGF2ZSBjb3VudCBpbmZvcm1hdGlvblxuICBpZiAob3V0cHV0LnJlc3VsdENvdW50ICE9PSB1bmRlZmluZWQgJiYgb3V0cHV0LmZpbGVDb3VudCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxMU1BSZXN1bHRTdW1tYXJ5XG4gICAgICAgIG9wZXJhdGlvbj17b3V0cHV0Lm9wZXJhdGlvbn1cbiAgICAgICAgcmVzdWx0Q291bnQ9e291dHB1dC5yZXN1bHRDb3VudH1cbiAgICAgICAgZmlsZUNvdW50PXtvdXRwdXQuZmlsZUNvdW50fVxuICAgICAgICBjb250ZW50PXtvdXRwdXQucmVzdWx0fVxuICAgICAgICB2ZXJib3NlPXt2ZXJib3NlfVxuICAgICAgLz5cbiAgICApXG4gIH1cblxuICAvLyBGYWxsYmFjayBmb3IgZXJyb3IgY2FzZXMgd2hlcmUgY291bnRzIGFyZW4ndCBhdmFpbGFibGVcbiAgLy8gKGUuZy4sIExTUCBzZXJ2ZXIgaW5pdGlhbGl6YXRpb24gZmFpbHVyZXMsIHJlcXVlc3QgZXJyb3JzKVxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICA8VGV4dD57b3V0cHV0LnJlc3VsdH08L1RleHQ+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLGNBQWNBLG9CQUFvQixRQUFRLHVDQUF1QztBQUNqRixPQUFPQyxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxhQUFhLFFBQVEsbUNBQW1DO0FBQ2pFLFNBQVNDLDJCQUEyQixRQUFRLGlEQUFpRDtBQUM3RixTQUFTQyxlQUFlLFFBQVEscUNBQXFDO0FBQ3JFLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0MsY0FBYyxRQUFRLHFCQUFxQjtBQUNwRCxTQUFTQyxVQUFVLFFBQVEseUJBQXlCO0FBQ3BELGNBQWNDLEtBQUssRUFBRUMsTUFBTSxRQUFRLGNBQWM7QUFDakQsU0FBU0MsbUJBQW1CLFFBQVEsb0JBQW9COztBQUV4RDtBQUNBLE1BQU1DLGdCQUFnQixFQUFFQyxNQUFNLENBQzVCSixLQUFLLENBQUMsV0FBVyxDQUFDLEVBQ2xCO0VBQUVLLFFBQVEsRUFBRSxNQUFNO0VBQUVDLE1BQU0sRUFBRSxNQUFNO0VBQUVDLE9BQU8sQ0FBQyxFQUFFLE1BQU07QUFBQyxDQUFDLENBQ3ZELEdBQUc7RUFDRkMsY0FBYyxFQUFFO0lBQUVILFFBQVEsRUFBRSxZQUFZO0lBQUVDLE1BQU0sRUFBRTtFQUFjLENBQUM7RUFDakVHLGNBQWMsRUFBRTtJQUFFSixRQUFRLEVBQUUsV0FBVztJQUFFQyxNQUFNLEVBQUU7RUFBYSxDQUFDO0VBQy9ESSxjQUFjLEVBQUU7SUFBRUwsUUFBUSxFQUFFLFFBQVE7SUFBRUMsTUFBTSxFQUFFO0VBQVUsQ0FBQztFQUN6REssZUFBZSxFQUFFO0lBQUVOLFFBQVEsRUFBRSxRQUFRO0lBQUVDLE1BQU0sRUFBRTtFQUFVLENBQUM7RUFDMURNLEtBQUssRUFBRTtJQUFFUCxRQUFRLEVBQUUsWUFBWTtJQUFFQyxNQUFNLEVBQUUsWUFBWTtJQUFFQyxPQUFPLEVBQUU7RUFBWSxDQUFDO0VBQzdFTSxrQkFBa0IsRUFBRTtJQUFFUixRQUFRLEVBQUUsZ0JBQWdCO0lBQUVDLE1BQU0sRUFBRTtFQUFrQixDQUFDO0VBQzdFUSxvQkFBb0IsRUFBRTtJQUFFVCxRQUFRLEVBQUUsV0FBVztJQUFFQyxNQUFNLEVBQUU7RUFBYSxDQUFDO0VBQ3JFUyxhQUFhLEVBQUU7SUFBRVYsUUFBUSxFQUFFLFFBQVE7SUFBRUMsTUFBTSxFQUFFO0VBQVUsQ0FBQztFQUN4RFUsYUFBYSxFQUFFO0lBQUVYLFFBQVEsRUFBRSxRQUFRO0lBQUVDLE1BQU0sRUFBRTtFQUFVO0FBQ3pELENBQUM7O0FBRUQ7QUFDQTtBQUNBO0FBQ0EsU0FBQVcsaUJBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBMEI7SUFBQUMsU0FBQTtJQUFBQyxXQUFBO0lBQUFDLFNBQUE7SUFBQUMsT0FBQTtJQUFBQztFQUFBLElBQUFQLEVBWXpCO0VBQUEsSUFBQVEsRUFBQTtFQUFBLElBQUFQLENBQUEsUUFBQUUsU0FBQTtJQUVxQkssRUFBQSxHQUFBdkIsZ0JBQWdCLENBQUNrQixTQUFTLENBRzdDLElBSG1CO01BQUFoQixRQUFBLEVBQ1IsUUFBUTtNQUFBQyxNQUFBLEVBQ1Y7SUFDVixDQUFDO0lBQUFhLENBQUEsTUFBQUUsU0FBQTtJQUFBRixDQUFBLE1BQUFPLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFQLENBQUE7RUFBQTtFQUhELE1BQUFRLFdBQUEsR0FBb0JELEVBR25CO0VBQ0QsTUFBQUUsVUFBQSxHQUNFTixXQUFXLEtBQUssQ0FBNkMsR0FBekNLLFdBQVcsQ0FBQXRCLFFBQThCLEdBQWxCc0IsV0FBVyxDQUFBckIsTUFBTztFQUFBLElBQUF1QixFQUFBO0VBQUEsSUFBQVYsQ0FBQSxRQUFBUyxVQUFBLElBQUFULENBQUEsUUFBQVEsV0FBQSxDQUFBcEIsT0FBQSxJQUFBWSxDQUFBLFFBQUFFLFNBQUEsSUFBQUYsQ0FBQSxRQUFBRyxXQUFBO0lBRzdETyxFQUFBLEdBQUFSLFNBQVMsS0FBSyxPQUEwQixJQUFmQyxXQUFXLEdBQUcsQ0FBd0IsSUFBbkJLLFdBQVcsQ0FBQXBCLE9BT3RELEdBTkMsQ0FBQyxJQUFJLENBQUMsV0FBWSxDQUFBb0IsV0FBVyxDQUFBcEIsT0FBTyxDQUFFLEVBQXJDLElBQUksQ0FNTixHQUpDLENBQUMsSUFBSSxDQUFDLE1BQ0UsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFKLEtBQUcsQ0FBQyxDQUFFZSxZQUFVLENBQUUsQ0FBQyxFQUF4QixJQUFJLENBQ1ZNLFdBQVMsQ0FDWixFQUhDLElBQUksQ0FJTjtJQUFBVCxDQUFBLE1BQUFTLFVBQUE7SUFBQVQsQ0FBQSxNQUFBUSxXQUFBLENBQUFwQixPQUFBO0lBQUFZLENBQUEsTUFBQUUsU0FBQTtJQUFBRixDQUFBLE1BQUFHLFdBQUE7SUFBQUgsQ0FBQSxNQUFBVSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBVixDQUFBO0VBQUE7RUFSSCxNQUFBVyxXQUFBLEdBQ0VELEVBT0M7RUFBQSxJQUFBRSxFQUFBO0VBQUEsSUFBQVosQ0FBQSxRQUFBSSxTQUFBO0lBR0RRLEVBQUEsR0FBQVIsU0FBUyxHQUFHLENBTUosR0FMTixDQUFDLElBQUksQ0FDRixJQUFFLENBQUUsT0FDRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUosS0FBRyxDQUFDLENBQUVBLFVBQVEsQ0FBRSxDQUFDLEVBQXRCLElBQUksQ0FBeUIsS0FFdkMsRUFKQyxJQUFJLENBS0MsR0FOUixJQU1RO0lBQUFKLENBQUEsTUFBQUksU0FBQTtJQUFBSixDQUFBLE1BQUFZLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFaLENBQUE7RUFBQTtFQVBWLE1BQUFhLGFBQUEsR0FDRUQsRUFNUTtFQUVWLElBQUlOLE9BQU87SUFBQSxJQUFBUSxFQUFBO0lBQUEsSUFBQWQsQ0FBQSxRQUFBZSxNQUFBLENBQUFDLEdBQUE7TUFLREYsRUFBQSxJQUFDLElBQUksQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQUMsS0FBb0IsRUFBbEMsSUFBSSxDQUFxQztNQUFBZCxDQUFBLE1BQUFjLEVBQUE7SUFBQTtNQUFBQSxFQUFBLEdBQUFkLENBQUE7SUFBQTtJQUFBLElBQUFpQixFQUFBO0lBQUEsSUFBQWpCLENBQUEsU0FBQVcsV0FBQSxJQUFBWCxDQUFBLFNBQUFhLGFBQUE7TUFGOUNJLEVBQUEsSUFBQyxHQUFHLENBQWUsYUFBSyxDQUFMLEtBQUssQ0FDdEIsQ0FBQyxJQUFJLENBQ0gsQ0FBQUgsRUFBeUMsQ0FDeENILFlBQVUsQ0FDVkUsY0FBWSxDQUNmLEVBSkMsSUFBSSxDQUtQLEVBTkMsR0FBRyxDQU1FO01BQUFiLENBQUEsT0FBQVcsV0FBQTtNQUFBWCxDQUFBLE9BQUFhLGFBQUE7TUFBQWIsQ0FBQSxPQUFBaUIsRUFBQTtJQUFBO01BQUFBLEVBQUEsR0FBQWpCLENBQUE7SUFBQTtJQUFBLElBQUFrQixFQUFBO0lBQUEsSUFBQWxCLENBQUEsU0FBQUssT0FBQTtNQUNOYSxFQUFBLElBQUMsR0FBRyxDQUFhLFVBQUMsQ0FBRCxHQUFDLENBQ2hCLENBQUMsSUFBSSxDQUFFYixRQUFNLENBQUUsRUFBZCxJQUFJLENBQ1AsRUFGQyxHQUFHLENBRUU7TUFBQUwsQ0FBQSxPQUFBSyxPQUFBO01BQUFMLENBQUEsT0FBQWtCLEVBQUE7SUFBQTtNQUFBQSxFQUFBLEdBQUFsQixDQUFBO0lBQUE7SUFBQSxJQUFBbUIsRUFBQTtJQUFBLElBQUFuQixDQUFBLFNBQUFpQixFQUFBLElBQUFqQixDQUFBLFNBQUFrQixFQUFBO01BVlJDLEVBQUEsSUFBQyxHQUFHLENBQWUsYUFBUSxDQUFSLFFBQVEsQ0FDekIsQ0FBQUYsRUFNSyxDQUNMLENBQUFDLEVBRUssQ0FDUCxFQVhDLEdBQUcsQ0FXRTtNQUFBbEIsQ0FBQSxPQUFBaUIsRUFBQTtNQUFBakIsQ0FBQSxPQUFBa0IsRUFBQTtNQUFBbEIsQ0FBQSxPQUFBbUIsRUFBQTtJQUFBO01BQUFBLEVBQUEsR0FBQW5CLENBQUE7SUFBQTtJQUFBLE9BWE5tQixFQVdNO0VBQUE7RUFFVCxJQUFBTCxFQUFBO0VBQUEsSUFBQWQsQ0FBQSxTQUFBRyxXQUFBO0lBTXNCVyxFQUFBLEdBQUFYLFdBQVcsR0FBRyxDQUFzQixJQUFqQixDQUFDLGFBQWEsR0FBRztJQUFBSCxDQUFBLE9BQUFHLFdBQUE7SUFBQUgsQ0FBQSxPQUFBYyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBZCxDQUFBO0VBQUE7RUFBQSxJQUFBaUIsRUFBQTtFQUFBLElBQUFqQixDQUFBLFNBQUFXLFdBQUEsSUFBQVgsQ0FBQSxTQUFBYSxhQUFBLElBQUFiLENBQUEsU0FBQWMsRUFBQTtJQUh6REcsRUFBQSxJQUFDLGVBQWUsQ0FBUyxNQUFDLENBQUQsR0FBQyxDQUN4QixDQUFDLElBQUksQ0FDRk4sWUFBVSxDQUNWRSxjQUFZLENBQUUsQ0FBRSxDQUFBQyxFQUFtQyxDQUN0RCxFQUhDLElBQUksQ0FJUCxFQUxDLGVBQWUsQ0FLRTtJQUFBZCxDQUFBLE9BQUFXLFdBQUE7SUFBQVgsQ0FBQSxPQUFBYSxhQUFBO0lBQUFiLENBQUEsT0FBQWMsRUFBQTtJQUFBZCxDQUFBLE9BQUFpQixFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBakIsQ0FBQTtFQUFBO0VBQUEsT0FMbEJpQixFQUtrQjtBQUFBO0FBSXRCLE9BQU8sU0FBU0csY0FBY0EsQ0FBQSxDQUFFLEVBQUUsTUFBTSxDQUFDO0VBQ3ZDLE9BQU8sS0FBSztBQUNkO0FBRUEsT0FBTyxTQUFTQyxvQkFBb0JBLENBQ2xDQyxLQUFLLEVBQUVDLE9BQU8sQ0FBQzFDLEtBQUssQ0FBQyxFQUNyQjtFQUFFeUI7QUFBOEIsQ0FBckIsRUFBRTtFQUFFQSxPQUFPLEVBQUUsT0FBTztBQUFDLENBQUMsQ0FDbEMsRUFBRWpDLEtBQUssQ0FBQ21ELFNBQVMsQ0FBQztFQUNqQixJQUFJLENBQUNGLEtBQUssQ0FBQ3BCLFNBQVMsRUFBRTtJQUNwQixPQUFPLElBQUk7RUFDYjtFQUVBLE1BQU11QixLQUFLLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRTs7RUFFMUI7RUFDQTtFQUNBLElBQ0UsQ0FBQ0gsS0FBSyxDQUFDcEIsU0FBUyxLQUFLLGdCQUFnQixJQUNuQ29CLEtBQUssQ0FBQ3BCLFNBQVMsS0FBSyxnQkFBZ0IsSUFDcENvQixLQUFLLENBQUNwQixTQUFTLEtBQUssT0FBTyxJQUMzQm9CLEtBQUssQ0FBQ3BCLFNBQVMsS0FBSyxvQkFBb0IsS0FDMUNvQixLQUFLLENBQUNJLFFBQVEsSUFDZEosS0FBSyxDQUFDSyxJQUFJLEtBQUtDLFNBQVMsSUFDeEJOLEtBQUssQ0FBQ08sU0FBUyxLQUFLRCxTQUFTLEVBQzdCO0lBQ0E7SUFDQSxNQUFNRSxNQUFNLEdBQUcvQyxtQkFBbUIsQ0FDaEN1QyxLQUFLLENBQUNJLFFBQVEsRUFDZEosS0FBSyxDQUFDSyxJQUFJLEdBQUcsQ0FBQyxFQUNkTCxLQUFLLENBQUNPLFNBQVMsR0FBRyxDQUNwQixDQUFDO0lBQ0QsTUFBTUUsV0FBVyxHQUFHekIsT0FBTyxHQUN2QmdCLEtBQUssQ0FBQ0ksUUFBUSxHQUNkL0MsY0FBYyxDQUFDMkMsS0FBSyxDQUFDSSxRQUFRLENBQUM7SUFFbEMsSUFBSUksTUFBTSxFQUFFO01BQ1ZMLEtBQUssQ0FBQ08sSUFBSSxDQUFDLGVBQWVWLEtBQUssQ0FBQ3BCLFNBQVMsR0FBRyxDQUFDO01BQzdDdUIsS0FBSyxDQUFDTyxJQUFJLENBQUMsWUFBWUYsTUFBTSxHQUFHLENBQUM7TUFDakNMLEtBQUssQ0FBQ08sSUFBSSxDQUFDLFFBQVFELFdBQVcsR0FBRyxDQUFDO0lBQ3BDLENBQUMsTUFBTTtNQUNMTixLQUFLLENBQUNPLElBQUksQ0FBQyxlQUFlVixLQUFLLENBQUNwQixTQUFTLEdBQUcsQ0FBQztNQUM3Q3VCLEtBQUssQ0FBQ08sSUFBSSxDQUFDLFVBQVVELFdBQVcsR0FBRyxDQUFDO01BQ3BDTixLQUFLLENBQUNPLElBQUksQ0FBQyxhQUFhVixLQUFLLENBQUNLLElBQUksSUFBSUwsS0FBSyxDQUFDTyxTQUFTLEVBQUUsQ0FBQztJQUMxRDtJQUVBLE9BQU9KLEtBQUssQ0FBQ1EsSUFBSSxDQUFDLElBQUksQ0FBQztFQUN6Qjs7RUFFQTtFQUNBO0VBQ0FSLEtBQUssQ0FBQ08sSUFBSSxDQUFDLGVBQWVWLEtBQUssQ0FBQ3BCLFNBQVMsR0FBRyxDQUFDO0VBRTdDLElBQUlvQixLQUFLLENBQUNJLFFBQVEsRUFBRTtJQUNsQixNQUFNSyxXQUFXLEdBQUd6QixPQUFPLEdBQ3ZCZ0IsS0FBSyxDQUFDSSxRQUFRLEdBQ2QvQyxjQUFjLENBQUMyQyxLQUFLLENBQUNJLFFBQVEsQ0FBQztJQUNsQ0QsS0FBSyxDQUFDTyxJQUFJLENBQUMsVUFBVUQsV0FBVyxHQUFHLENBQUM7RUFDdEM7RUFFQSxPQUFPTixLQUFLLENBQUNRLElBQUksQ0FBQyxJQUFJLENBQUM7QUFDekI7QUFFQSxPQUFPLFNBQVNDLHlCQUF5QkEsQ0FDdkNDLE1BQU0sRUFBRS9ELG9CQUFvQixDQUFDLFNBQVMsQ0FBQyxFQUN2QztFQUFFa0M7QUFBOEIsQ0FBckIsRUFBRTtFQUFFQSxPQUFPLEVBQUUsT0FBTztBQUFDLENBQUMsQ0FDbEMsRUFBRWpDLEtBQUssQ0FBQ21ELFNBQVMsQ0FBQztFQUNqQixJQUNFLENBQUNsQixPQUFPLElBQ1IsT0FBTzZCLE1BQU0sS0FBSyxRQUFRLElBQzFCdkQsVUFBVSxDQUFDdUQsTUFBTSxFQUFFLGdCQUFnQixDQUFDLEVBQ3BDO0lBQ0EsT0FDRSxDQUFDLGVBQWU7QUFDdEIsUUFBUSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLG9CQUFvQixFQUFFLElBQUk7QUFDdEQsTUFBTSxFQUFFLGVBQWUsQ0FBQztFQUV0QjtFQUNBLE9BQU8sQ0FBQywyQkFBMkIsQ0FBQyxNQUFNLENBQUMsQ0FBQ0EsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUM3QixPQUFPLENBQUMsR0FBRztBQUMxRTtBQUVBLE9BQU8sU0FBUzhCLHVCQUF1QkEsQ0FDckNDLE1BQU0sRUFBRXZELE1BQU0sRUFDZHdELGlCQUFpQixFQUFFLE9BQU8sRUFBRSxFQUM1QjtFQUFFaEM7QUFBOEIsQ0FBckIsRUFBRTtFQUFFQSxPQUFPLEVBQUUsT0FBTztBQUFDLENBQUMsQ0FDbEMsRUFBRWpDLEtBQUssQ0FBQ21ELFNBQVMsQ0FBQztFQUNqQjtFQUNBLElBQUlhLE1BQU0sQ0FBQ2xDLFdBQVcsS0FBS3lCLFNBQVMsSUFBSVMsTUFBTSxDQUFDakMsU0FBUyxLQUFLd0IsU0FBUyxFQUFFO0lBQ3RFLE9BQ0UsQ0FBQyxnQkFBZ0IsQ0FDZixTQUFTLENBQUMsQ0FBQ1MsTUFBTSxDQUFDbkMsU0FBUyxDQUFDLENBQzVCLFdBQVcsQ0FBQyxDQUFDbUMsTUFBTSxDQUFDbEMsV0FBVyxDQUFDLENBQ2hDLFNBQVMsQ0FBQyxDQUFDa0MsTUFBTSxDQUFDakMsU0FBUyxDQUFDLENBQzVCLE9BQU8sQ0FBQyxDQUFDaUMsTUFBTSxDQUFDRixNQUFNLENBQUMsQ0FDdkIsT0FBTyxDQUFDLENBQUM3QixPQUFPLENBQUMsR0FDakI7RUFFTjs7RUFFQTtFQUNBO0VBQ0EsT0FDRSxDQUFDLGVBQWU7QUFDcEIsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDK0IsTUFBTSxDQUFDRixNQUFNLENBQUMsRUFBRSxJQUFJO0FBQ2pDLElBQUksRUFBRSxlQUFlLENBQUM7QUFFdEIiLCJpZ25vcmVMaXN0IjpbXX0=