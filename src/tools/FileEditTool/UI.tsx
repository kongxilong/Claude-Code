/**
 * ============================================================================
 *  【一句话定位】FileEditTool/UI.tsx —— 编辑类工具在终端里的「长相」（渲染层）
 * ============================================================================
 *
 *  本文件**没有任何业务逻辑**，只回答一个问题：
 *  "这次编辑，在屏幕上给用户看什么？"
 *      · 工具被调用时           → renderToolUseMessage()        渲染文件路径
 *      · 编辑成功后             → renderToolResultMessage()     渲染改动 diff
 *      · 用户拒绝了这次编辑     → renderToolUseRejectedMessage() 渲染"本该发生的 diff"
 *      · 编辑出错               → renderToolUseErrorMessage()    渲染一句人话错误
 *
 * ---------------------------------------------------------------------------
 *  【⚠️ 在读这个文件之前必须先知道的一件事：它是"编译产物"】
 * ---------------------------------------------------------------------------
 *  看第 1 行 `import { c as _c } from "react/compiler-runtime"` 和末尾那一长串
 *  `//# sourceMappingURL=data:...base64,...` —— 这不是人写的代码。
 *
 *  它是 React Compiler（Forget）把原始 JSX 源码**编译优化后**的产物：
 *      · 原始 handwritten 的组件函数变成了 `EditRejectionDiff(t0)` 这种形式，
 *        参数名被压成 t0/t1/t2，中间变量也全变成 t1..t4；
 *      · `$ = _c(16)` 申请一个长度 16 的**缓存槽数组**，
 *        `if ($[0] !== filePath) { ... $[0] = filePath; $[4] = t1 }` 是编译器自动插入的
 *        **记忆化（memoization）**：依赖没变就复用上次算好的 React 元素，跳过重渲染。
 *        ≈ Java 里手写的 memoized getter + volatile 缓存字段，只不过这里是编译器代劳。
 *      · 末尾的 sourcemap 用来把编译产物映射回原始 UI.tsx，方便调试/断点。
 *
 *  【结论】改这个文件没用（下次编译会被覆盖），要看逻辑应该看 `src/components/` 下
 *  被引用的那几个真正组件：FileEditToolUpdatedMessage、FileEditToolUseRejectedMessage 等。
 *  本文件剩下这些函数是**手写在文件顶部区域、未被编译器大幅改写**的纯展示函数。
 *
 *  为什么要专门有人写这一层？
 *      LLM 的编辑结果给用户看时必须"一眼看懂"：
 *      文件名 + diff + 是否被用户手改过。看不懂用户就不敢批准，agent 就跑不起来。
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置 / 调用链】
 * ---------------------------------------------------------------------------
 *      工具框架 src/Tool.ts
 *        └─> 按约定调用本文件导出的钩子
 *              ├─ userFacingName(input)               → 'Update' / 'Create' / 'Updated plan'
 *              ├─ getToolUseSummary(input)            → 给一行摘要用（一般是文件名）
 *              ├─ renderToolUseMessage(...)           → <FilePathLink/>
 *              ├─ renderToolResultMessage(...)        → <FileEditToolUpdatedMessage/>（src/components/）
 *              ├─ renderToolUseRejectedMessage(...)   → <EditRejectionDiff/> → loadRejectionDiff()
 *              └─ renderToolUseErrorMessage(...)      → <FallbackToolUseErrorMessage/>
 *
 *      内部私有部分（渲染"被拒绝的编辑长什么样"）：
 *          renderToolUseRejectedMessage()
 *              └─> <EditRejectionDiff/>         （React Compiler 编译过的组件）
 *                    └─> loadRejectionDiff()    ← ★本文件唯一的逻辑函数
 *                          ├─> readEditContext()      ← ../../utils/readEditContext.js（按上下文窗口分块读）
 *                          ├─> getPatchForEdit()      ← ./utils.js（与真正执行时**共用同一个** diff 实现）
 *                          └─> adjustHunkLineNumbers() ← ../../utils/diff.js（把行号平移回全文件坐标系）
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   1. userFacingName()                 UI 上显示的操作名
 *   2. getToolUseSummary()              单行摘要
 *   3. renderToolUseMessage()           调用时的路径渲染
 *   4. renderToolResultMessage()        成功后渲染 diff
 *   5. renderToolUseRejectedMessage()   被拒绝时渲染"本来会发生的 diff"
 *   6. renderToolUseErrorMessage()      错误文案渲染
 *   7. EditRejectionDiff/Body           两个编译过的内部组件（带 Suspense 异步加载 diff）
 *   8. loadRejectionDiff()              ★异步算出"如果执行了会得到什么 diff"
 *
 * ---------------------------------------------------------------------------
 *  【TS / React 语法速查 · Java 对照】
 *  --------------------------------------------------------------------------
 *   · `.tsx` 后缀 = TS + JSX。JSX 允许在代码里**直接写标签**：
 *         return <Text dimColor>File must be read first</Text>
 *     它会被编译成函数调用（React.createElement），最终构成一棵**组件树**。
 *     ≈ Java 里没有对应物；最接近的是「用 DSL 拼一棵 Swing 组件树」，
 *       但 JSX 是语言级语法，由编译器生成，比手写 builder 清爽得多。
 *
 *   · `React.ReactNode` / `React.ReactElement`：
 *     前者 = "任何可以渲染的东西"（含字符串、null、数组），后者 = 严格的一个元素。
 *     ≈ Java 的 JComponent vs Object 的区别，粒度不同。
 *
 *   · 返回值写成 `: React.ReactNode` —— 类型标注后置，Java 工程师最容易看串。
 *
 *   · `Partial<{ file_path: string; ... }>`：
 *     把对象类型里所有字段变成可选。≈ 生成一个"字段全可空"的 DTO。
 *     这里用它是因为 UI 拿到的是模型原始输出，**可能缺字段**，不能假设它完整。
 *
 *   · `input?: string` / `edits?: unknown[]`：字段名后带问号 = 可选字段（可能为 undefined）。
 *
 *   · `input.file_path?.startsWith(...)` 可选链：
 *     ≈ Java 的 `fp != null && fp.startsWith(...)`。file_path 可能压根不存在。
 *
 *   · `input.old_string ?? ''` 空值合并：
 *     只在值为 null/undefined 时用 ''。
 *     ⚠️ 与 `||` 的关键区别：`''`（空串）和 `0` 会被 `||` 替换成默认值，
 *        但不会被 `??` 替换。这里明明要保留"空串代表新建文件"的语义，所以必须用 `??`。
 *
 *   · 大括号 `{...}` 在 JSX 里表示"这里是 JS 表达式"：
 *         <FilePathLink filePath={file_path}>{verbose ? file_path : getDisplayPath(...)}</FilePathLink>
 *     里面那个 `? :` 是三元运算符（≈ Java 的三元），返回字符串走进 JSX 当子节点。
 *
 *   · `<Suspense fallback={t2}>{t3}</Suspense>` + `use(promise)`：
 *     React 的异步渲染原语。`use(promise)` 会**挂起**组件直到 promise resolve，
 *     期间显示 fallback。≈ Java 里 CompletableFuture + 占位 UI，
 *     但 React 把它做成了语言级的"挂起-恢复"机制，不需要回调地狱。
 *
 *   · `useState(t1)`：钩子。注意这里传的是**函数** t1，
 *     表示"惰性初始化"——只在首次渲染时调用一次，重渲染不会重复算。
 *
 *   · `_progressMessagesForMessage` 前缀下划线 = 该参数不用（占位满足接口形状）。
 *
 *   · `e as Error`：类型断言 ≈ Java 强制转换。catch 里 e 是 unknown，需要断言成 Error
 *     才能传给 logError。（TS 严格模式下的常见补丁写法。）
 */
import { c as _c } from "react/compiler-runtime";
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { Suspense, use, useState } from 'react';
import { FileEditToolUseRejectedMessage } from 'src/components/FileEditToolUseRejectedMessage.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { extractTag } from 'src/utils/messages.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js';
import { FilePathLink } from '../../components/FilePathLink.js';
import { Text } from '../../ink.js';
import type { Tools } from '../../Tool.js';
import type { Message, ProgressMessage } from '../../types/message.js';
import { adjustHunkLineNumbers, CONTEXT_LINES } from '../../utils/diff.js';
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js';
import { logError } from '../../utils/log.js';
import { getPlansDirectory } from '../../utils/plans.js';
import { readEditContext } from '../../utils/readEditContext.js';
import { firstLineOf } from '../../utils/stringUtils.js';
import type { ThemeName } from '../../utils/theme.js';
import type { FileEditOutput } from './types.js';
import { findActualString, getPatchForEdit, preserveQuoteStyle } from './utils.js';
/**
 * 这个操作在 UI 上叫什么名字。
 *
 * @param input 模型的原始入参（可能是畸形/缺失字段，故用 Partial 宽松接收）
 * @returns 'Update' | 'Create' | 'Updated plan'
 *
 * 【为什么要单独喝ols一个函数，而不是统一叫 "Edit"？】
 * 因为同一把工具在用户眼里其实是三种行为，UI 要区别对待才有信息量：
 *   · old_string 为空  ⇒ 'Create'      （本质是新建文件）
 *   · 路径在 plans 目录 ⇒ 'Updated plan'（用户此刻在改"计划"，语境完全不同）
 *   · 其余             ⇒ 'Update'
 *
 * 【为什么拿 Source of truth 是 old_string 而不是别的？】
 * 因为 FileEditTool 的语义里"old_string 为空 == 新建"，这是整个工具链的既定约定。
 */
export function userFacingName(input: Partial<{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
  edits: unknown[];
}> | undefined): string {
  if (!input) {
    return 'Update';
  }
  if (input.file_path?.startsWith(getPlansDirectory())) {
    return 'Updated plan';
  }
  // Hashline edits always modify an existing file (line-ref based)
  if (input.edits != null) {
    return 'Update';
  }
  if (input.old_string === '') {
    return 'Create';
  }
  return 'Update';
}
/**
 * 一行式摘要（用于折叠视图、工具调用列表）。
 *
 * @returns 相对展示路径；没有 file_path 时返回 null（调用方据此什么都不显示）
 *
 * 【为什么返回 null 而不是空字符串？】
 * 用 null 表达"没有"，比 '' 更明确，避免渲染出一个空的占位。
 * ≈ Java 里返回 Optional<String> 而不是 Optional.of("")。
 */
export function getToolUseSummary(input: Partial<{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}> | undefined): string | null {
  if (!input?.file_path) {
    return null;
  }
  return getDisplayPath(input.file_path);
}
/**
 * 【工具正在被调用时】用户第一眼看到的东西 —— 就是那个文件路径。
 *
 * 【为什么路径这里要分 verbose？】
 *   · 普通模式：显示**相对路径**（短、可读，用户关心的是仓库内的位置）
 *   · verbose  ：显示**绝对路径**（排错时有用）
 * 这是纯 UX 取舍：屏幕寸土寸金，默认给短的。
 *
 * 【为什么 plan 文件直接返回空串 ''？】
 * 因为 "Updated plan" 这个语义已经由 userFacingName() 显示过了，
 * 这里再重复一次路径是冗余。返回 '' 而不是 null：
 * '' 是合法 ReactNode（渲染成"什么都没有"），保证类型统一。
 *
 * 【TS 语法】参数写成解构 + 类型标注：
 *   `{ file_path }: { file_path?: string; }, { verbose }: { verbose: boolean }`
 *   ≈ 把两个参数各自拆包；注意第二个对象的类型直接内联写在后面。
 */
export function renderToolUseMessage({
  file_path
}: {
  file_path?: string;
}, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!file_path) {
    return null;
  }
  // For plan files, path is already in userFacingName
  if (file_path.startsWith(getPlansDirectory())) {
    return '';
  }
  return <FilePathLink filePath={file_path}>
      {verbose ? file_path : getDisplayPath(file_path)}
    </FilePathLink>;
}
/**
 * 【编辑成功后】把改动渲染给用户看。
 *
 * @param filePath/structuredPatch/originalFile  从 FileEditOutput 里解构出来的三个字段
 * @param 第二参数  ProgressMessage[]，本渲染不用（下划线占位）
 * @param options  { style, verbose } —— style='condensed' 时渲染紧凑版
 *
 * 【为什么要把 originalFile（改之前的整份内容）传下去？】
 * 因为 UI 需要知道"改动发生在文件的哪个位置"才好做上下文提示，
 * 这里取其**第一行** `originalFile.split('\n')[0] ?? null` 作为定位 hint。
 * `?? null` 是为了防偶尔出现的空文件（split 后 [0] 可能不存在 → undefined）。
 *
 * 【plan 文件为什么要额外加 '/plan to preview' 提示？】
 * 因为改的是"计划"，用户下一步最可能想做的事是预览这份计划，顺手给个提示。
 */
export function renderToolResultMessage({
  filePath,
  structuredPatch,
  originalFile
}: FileEditOutput, _progressMessagesForMessage: ProgressMessage[], {
  style,
  verbose
}: {
  style?: 'condensed';
  verbose: boolean;
}): React.ReactNode {
  // For plan files, show /plan hint above the diff
  const isPlanFile = filePath.startsWith(getPlansDirectory());
  return <FileEditToolUpdatedMessage filePath={filePath} structuredPatch={structuredPatch} firstLine={originalFile.split('\n')[0] ?? null} fileContent={originalFile} style={style} verbose={verbose} previewHint={isPlanFile ? '/plan to preview' : undefined} />;
}
/**
 * 【用户拒绝了这次编辑时】渲染"如果批准了会发生什么"的 diff。
 *
 * 【为什么拒绝了还要费劲算 diff？因为这是给用户做**决策**用的】
 * 用户点"否"之前，屏幕上必须让他看懂要改哪一行、改成什么样。
 * 不渲染 diff 的话，用户等于在盲签。
 *
 * 【两条分支】
 *   · old_string 为空 ⇒ 新建文件 ⇒ 渲染"内容预览"（operation="write"）
 *   · 否则           ⇒ 渲染 diff（走 <EditRejectionDiff/>）
 *
 * 【为什么要防御性地检查 'edits' in input？】
 * 因为存在另一种"多段编辑"形态的工具输入（input.edits 是数组），
 * 本渲染器只吃单段编辑（old_string/new_string）。万一上游传错形状，
 * 宁可退化成一句简单的拒绝提示，也别崩整个 REPL。
 * `'edits' in input` 是 JS 的 in 运算符，判断对象上有没有这个键。
 */
export function renderToolUseRejectedMessage(input: {
  file_path: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  edits?: unknown[];
}, options: {
  columns: number;
  messages: Message[];
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  theme: ThemeName;
  tools: Tools;
  verbose: boolean;
}): React.ReactElement {
  const {
    style,
    verbose
  } = options;
  const filePath = input.file_path;
  const oldString = input.old_string ?? '';
  const newString = input.new_string ?? '';
  const replaceAll = input.replace_all ?? false;

  // Defensive: if input has an unexpected shape, show a simple rejection message
  if ('edits' in input && input.edits != null) {
    return <FileEditToolUseRejectedMessage file_path={filePath} operation="update" firstLine={null} verbose={verbose} />;
  }
    // 复用 FileEditTool 的既定语义：old_string 为空 ⇒ 新建文件。
  const isNewFile = oldString === '';

  // For new file creation, show content preview instead of diff
  if (isNewFile) {
    return <FileEditToolUseRejectedMessage file_path={filePath} operation="write" content={newString} firstLine={firstLineOf(newString)} verbose={verbose} />;
  }
  return <EditRejectionDiff filePath={filePath} oldString={oldString} newString={newString} replaceAll={replaceAll} style={style} verbose={verbose} />;
}
/**
 * 【编辑出错时】把错误信息渲染成人话。
 *
 * 【为什么用 string includes 匹配错误文案这么糙的办法？】
 * 因为 result 是从 tool_result 里拿回来的一段**文本**，不是结构化错误对象。
 * 短期 pragmatic 的做法就是"看文案里有没有这句"。
 * 这里刻意把两类错误"降噪"：
 *   · 'File has not been read yet' → 'File must be read first'
 *     （原句是给模型的责备语气，给用户看会莫名可怕）
 *   · 文件不存在 → 'File not found'（红色）
 * 其余一律兜底成 'Error editing file'。
 *
 * 【为什么非 verbose 才走这条美化路径？】
 * verbose 模式下用户明确要求看**完整原始错误**，那就不能再隐藏细节。
 *
 * 【TS 语法】`ToolResultBlockParam['content']` 是**索引访问类型**：
 * 取出 ToolResultBlockParam 这个类型里 content 字段的类型。
 * ≈ Java 里没有；类似反射取字段类型的编译期版本。
 */
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], options: {
  progressMessagesForMessage: ProgressMessage[];
  tools: Tools;
  verbose: boolean;
}): React.ReactElement {
  const {
    verbose
  } = options;
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    const errorMessage = extractTag(result, 'tool_use_error');
    // Show a less scary message for intended behavior
    if (errorMessage?.includes('File has not been read yet')) {
      return <MessageResponse>
          <Text dimColor>File must be read first</Text>
        </MessageResponse>;
    }
    if (errorMessage?.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return <MessageResponse>
          <Text color="error">File not found</Text>
        </MessageResponse>;
    }
    return <MessageResponse>
        <Text color="error">Error editing file</Text>
      </MessageResponse>;
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}
/**
 * 被拒绝编辑的 diff 数据形状。
 *
 * 【为什么 fileContent 是 `string | undefined` 而 firstLine 是 `string | null`？】
 * TS 里这两种"没有"的写法都很常见，这里混用是因为**消费方不同**：
 *   · undefined 给 React props（JSX 里不传该 prop 就等价于 undefined）
 *   · null      给明确"我知道没有，显式传个空"的场景
 * 实际语义差别不大，读代码时知道两者都能表示"无"即可。
 */
type RejectionDiffData = {
  patch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent: string | undefined;
};
/**
 * 【React Compiler 编译产物，读不懂是正常的】
 *
 * 原始代码大概是：把 loadRejectionDiff() 的 promise 用 useState 惰性持有，
 * 再用 <Suspense> 包裹异步组件 EditRejectionBody。
 *
 * t0 是编译后合并的 props 对象；`$ = _c(16)` 取 16 个记忆化槽；
 * 每个 `if ($[i] !== dep) { 重算; $[i] = dep; $[j] = 结果 } else { 用缓存 }`
 * 就是编译器自动加的 **记忆化**。
 *
 * 【这么做图什么？】
 * 终端 UI（ink）重渲染很频繁，每次都重新生成 diff 元素会明显卡顿。
 * 依赖没变时直接复用上次的 React 元素，代价极小、收益明显。
 * ≈ Java 里手写 `if (cachedDep != newDep) { recompute(); }` 的缓存分支。
 */
function EditRejectionDiff(t0) {
  const $ = _c(16);
  const {
    filePath,
    oldString,
    newString,
    replaceAll,
    style,
    verbose
  } = t0;
  let t1;
  if ($[0] !== filePath || $[1] !== newString || $[2] !== oldString || $[3] !== replaceAll) {
    t1 = () => loadRejectionDiff(filePath, oldString, newString, replaceAll);
    $[0] = filePath;
    $[1] = newString;
    $[2] = oldString;
    $[3] = replaceAll;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const [dataPromise] = useState(t1);
  let t2;
  if ($[5] !== filePath || $[6] !== verbose) {
    t2 = <FileEditToolUseRejectedMessage file_path={filePath} operation="update" firstLine={null} verbose={verbose} />;
    $[5] = filePath;
    $[6] = verbose;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  let t3;
  if ($[8] !== dataPromise || $[9] !== filePath || $[10] !== style || $[11] !== verbose) {
    t3 = <EditRejectionBody promise={dataPromise} filePath={filePath} style={style} verbose={verbose} />;
    $[8] = dataPromise;
    $[9] = filePath;
    $[10] = style;
    $[11] = verbose;
    $[12] = t3;
  } else {
    t3 = $[12];
  }
  let t4;
  if ($[13] !== t2 || $[14] !== t3) {
    t4 = <Suspense fallback={t2}>{t3}</Suspense>;
    $[13] = t2;
    $[14] = t3;
    $[15] = t4;
  } else {
    t4 = $[15];
  }
  return t4;
}
/**
 * Suspense 边界内的真正渲染体：await 那个 promise 拿到 diff 数据后塞进组件。
 *
 * 【为什么要有这层壳？】
 * `use(promise)` 会让组件**挂起**，而挂起的组件不能和 Suspense 写在同一个函数里，
 * 必须拆出一个子组件承载挂起。这是 React 的硬性要求。
 * 好处是：diff 还在读文件时，终端先显示占位而不是卡死白屏。
 */
function EditRejectionBody(t0) {
  const $ = _c(7);
  const {
    promise,
    filePath,
    style,
    verbose
  } = t0;
  const {
    patch,
    firstLine,
    fileContent
  } = use(promise);
  let t1;
  if ($[0] !== fileContent || $[1] !== filePath || $[2] !== firstLine || $[3] !== patch || $[4] !== style || $[5] !== verbose) {
    t1 = <FileEditToolUseRejectedMessage file_path={filePath} operation="update" patch={patch} firstLine={firstLine} fileContent={fileContent} style={style} verbose={verbose} />;
    $[0] = fileContent;
    $[1] = filePath;
    $[2] = firstLine;
    $[3] = patch;
    $[4] = style;
    $[5] = verbose;
    $[6] = t1;
  } else {
    t1 = $[6];
  }
  return t1;
}
/**
 * 【本文件唯一的"真"业务逻辑】算出"如果批准，会得到什么样的一份 diff"。
 *
 * @param filePath    目标文件
 * @param oldString   模型要替换的原文
 * @param newString   替换后的内容
 * @param replaceAll  是否全部替换
 * @returns { patch, firstLine, fileContent }
 *
 * 【为什么能看到未来的 diff？】
 * 因为它调用的是 ./utils.js 的 **getPatchForEdit** —— 和真正执行编辑时用的是
 * **同一个函数**。这很重要：预览与执行的结果必须严格一致，
 * 否则用户看到的 diff 和实际改动可能对不上（不可原谅的事故）。
 *
 * ── 关键步骤 ──
 * ① readEditContext()：**只读目标片段附近的一小段**（CONTEXT_LINES 行）
 *      —— 为什么要这么麻烦？因为被编辑的文件可能上百万行，全读进来只为渲染预览太浪费。
 * ② 读失败/截断/文件不存在 → 退化：直接拿模型的 old_string→new_string 做 diff。
 *      —— 宁可给个"不够完整"的 diff，也不要什么都不显示。
 * ③ findActualString + preserveQuoteStyle：和真正执行时做同样的引号归一化，
 *      保证预览 diff 与实际 diff 一致。
 * ④ adjustHunkLineNumbers(patch, ctx.lineOffset - 1)：把行号**平移**回全文件坐标系。
 *      —— 因为我们只读了片段，patch 里的行号是片段内的相对行号；
 *         不平移的话用户会看到错误的文件行号。-1 是因为行号从 1 开始而偏移从 0 开始。
 * ⑤ 文件首行只在 lineOffset===1（即确实从文件头读起）时才给，避免误导。
 * ⑥ catch 兜底返回空 patch：最常见的失败原因是"用户在 diff 展示期间自己手改了文件"，
 *     这不是错误，不该弹红字——静默退化即可。
 */
async function loadRejectionDiff(filePath: string, oldString: string, newString: string, replaceAll: boolean): Promise<RejectionDiffData> {
  try {
    // Chunked read — context window around the first occurrence. replaceAll
    // still shows matches *within* the window via getPatchForEdit; we accept
    // losing the all-occurrences view to keep the read bounded.
    // 【为什么是"分块读"而不是读整份文件？】
    // 预览只需要看 old_string 附近那几行。对上 GB 的日志/数据文件，
    // 全量读会让 UI 卡好几秒。readEditContext 只围绕命中位置取上下文窗口。
    //
    // 【代价是什么？】replaceAll 时，只会显示这个窗口**内**的匹配，
    // 窗口外的替换看不见。这是明确的取舍（上面英文注释也承认了）：
    // 宁可预览不完整，也要把读盘量控制在有界范围内。
    const ctx = await readEditContext(filePath, oldString, CONTEXT_LINES);
    if (ctx === null || ctx.truncated || ctx.content === '') {
      // ENOENT / not found / truncated — diff just the tool inputs.
      const {
        patch
      } = getPatchForEdit({
        filePath,
        fileContents: oldString,
        oldString,
        newString
      });
      return {
        patch,
        firstLine: null,
        fileContent: undefined
      };
    }
    const actualOld = findActualString(ctx.content, oldString) || oldString;
    const actualNew = preserveQuoteStyle(oldString, actualOld, newString);
    const {
      patch
    } = getPatchForEdit({
      filePath,
      fileContents: ctx.content,
      oldString: actualOld,
      newString: actualNew,
      replaceAll
    });
    return {
      // 把"片段坐标"平移回"全文件坐标"。-1 是因为行号从 1 起算。
      // 不做这步的话，用户在 1000 行处看到被标成第 3 行，会直接怀疑人生。
      patch: adjustHunkLineNumbers(patch, ctx.lineOffset - 1),
      // 只有确实是从文件第一行的代码片段起读的，才敢说"这是文件的第一行"。
      // 否则<｜hy_place▁holder▁no▁813｜>返回 null —— 宁缺毋滥，别给假的上下文提示。
      firstLine: ctx.lineOffset === 1 ? firstLineOf(ctx.content) : null,
      fileContent: ctx.content
    };
  } catch (e) {
    // User may have manually applied the change while the diff was shown.
    logError(e as Error);
    return {
      patch: [],
      firstLine: null,
      fileContent: undefined
    };
  }
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUb29sUmVzdWx0QmxvY2tQYXJhbSIsIlN0cnVjdHVyZWRQYXRjaEh1bmsiLCJSZWFjdCIsIlN1c3BlbnNlIiwidXNlIiwidXNlU3RhdGUiLCJGaWxlRWRpdFRvb2xVc2VSZWplY3RlZE1lc3NhZ2UiLCJNZXNzYWdlUmVzcG9uc2UiLCJleHRyYWN0VGFnIiwiRmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlIiwiRmlsZUVkaXRUb29sVXBkYXRlZE1lc3NhZ2UiLCJGaWxlUGF0aExpbmsiLCJUZXh0IiwiVG9vbHMiLCJNZXNzYWdlIiwiUHJvZ3Jlc3NNZXNzYWdlIiwiYWRqdXN0SHVua0xpbmVOdW1iZXJzIiwiQ09OVEVYVF9MSU5FUyIsIkZJTEVfTk9UX0ZPVU5EX0NXRF9OT1RFIiwiZ2V0RGlzcGxheVBhdGgiLCJsb2dFcnJvciIsImdldFBsYW5zRGlyZWN0b3J5IiwicmVhZEVkaXRDb250ZXh0IiwiZmlyc3RMaW5lT2YiLCJUaGVtZU5hbWUiLCJGaWxlRWRpdE91dHB1dCIsImZpbmRBY3R1YWxTdHJpbmciLCJnZXRQYXRjaEZvckVkaXQiLCJwcmVzZXJ2ZVF1b3RlU3R5bGUiLCJ1c2VyRmFjaW5nTmFtZSIsImlucHV0IiwiUGFydGlhbCIsImZpbGVfcGF0aCIsIm9sZF9zdHJpbmciLCJuZXdfc3RyaW5nIiwicmVwbGFjZV9hbGwiLCJlZGl0cyIsInN0YXJ0c1dpdGgiLCJnZXRUb29sVXNlU3VtbWFyeSIsInJlbmRlclRvb2xVc2VNZXNzYWdlIiwidmVyYm9zZSIsIlJlYWN0Tm9kZSIsInJlbmRlclRvb2xSZXN1bHRNZXNzYWdlIiwiZmlsZVBhdGgiLCJzdHJ1Y3R1cmVkUGF0Y2giLCJvcmlnaW5hbEZpbGUiLCJfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJzdHlsZSIsImlzUGxhbkZpbGUiLCJzcGxpdCIsInVuZGVmaW5lZCIsInJlbmRlclRvb2xVc2VSZWplY3RlZE1lc3NhZ2UiLCJvcHRpb25zIiwiY29sdW1ucyIsIm1lc3NhZ2VzIiwicHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJ0aGVtZSIsInRvb2xzIiwiUmVhY3RFbGVtZW50Iiwib2xkU3RyaW5nIiwibmV3U3RyaW5nIiwicmVwbGFjZUFsbCIsImlzTmV3RmlsZSIsInJlbmRlclRvb2xVc2VFcnJvck1lc3NhZ2UiLCJyZXN1bHQiLCJlcnJvck1lc3NhZ2UiLCJpbmNsdWRlcyIsIlJlamVjdGlvbkRpZmZEYXRhIiwicGF0Y2giLCJmaXJzdExpbmUiLCJmaWxlQ29udGVudCIsIkVkaXRSZWplY3Rpb25EaWZmIiwidDAiLCIkIiwiX2MiLCJ0MSIsImxvYWRSZWplY3Rpb25EaWZmIiwiZGF0YVByb21pc2UiLCJ0MiIsInQzIiwidDQiLCJFZGl0UmVqZWN0aW9uQm9keSIsInByb21pc2UiLCJQcm9taXNlIiwiY3R4IiwidHJ1bmNhdGVkIiwiY29udGVudCIsImZpbGVDb250ZW50cyIsImFjdHVhbE9sZCIsImFjdHVhbE5ldyIsImxpbmVPZmZzZXQiLCJlIiwiRXJyb3IiXSwic291cmNlcyI6WyJVSS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBUb29sUmVzdWx0QmxvY2tQYXJhbSB9IGZyb20gJ0BhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9pbmRleC5tanMnXG5pbXBvcnQgdHlwZSB7IFN0cnVjdHVyZWRQYXRjaEh1bmsgfSBmcm9tICdkaWZmJ1xuaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBTdXNwZW5zZSwgdXNlLCB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgRmlsZUVkaXRUb29sVXNlUmVqZWN0ZWRNZXNzYWdlIH0gZnJvbSAnc3JjL2NvbXBvbmVudHMvRmlsZUVkaXRUb29sVXNlUmVqZWN0ZWRNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnc3JjL2NvbXBvbmVudHMvTWVzc2FnZVJlc3BvbnNlLmpzJ1xuaW1wb3J0IHsgZXh0cmFjdFRhZyB9IGZyb20gJ3NyYy91dGlscy9tZXNzYWdlcy5qcydcbmltcG9ydCB7IEZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvRmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgRmlsZUVkaXRUb29sVXBkYXRlZE1lc3NhZ2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL0ZpbGVFZGl0VG9vbFVwZGF0ZWRNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgRmlsZVBhdGhMaW5rIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9GaWxlUGF0aExpbmsuanMnXG5pbXBvcnQgeyBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHR5cGUgeyBUb29scyB9IGZyb20gJy4uLy4uL1Rvb2wuanMnXG5pbXBvcnQgdHlwZSB7IE1lc3NhZ2UsIFByb2dyZXNzTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgeyBhZGp1c3RIdW5rTGluZU51bWJlcnMsIENPTlRFWFRfTElORVMgfSBmcm9tICcuLi8uLi91dGlscy9kaWZmLmpzJ1xuaW1wb3J0IHsgRklMRV9OT1RfRk9VTkRfQ1dEX05PVEUsIGdldERpc3BsYXlQYXRoIH0gZnJvbSAnLi4vLi4vdXRpbHMvZmlsZS5qcydcbmltcG9ydCB7IGxvZ0Vycm9yIH0gZnJvbSAnLi4vLi4vdXRpbHMvbG9nLmpzJ1xuaW1wb3J0IHsgZ2V0UGxhbnNEaXJlY3RvcnkgfSBmcm9tICcuLi8uLi91dGlscy9wbGFucy5qcydcbmltcG9ydCB7IHJlYWRFZGl0Q29udGV4dCB9IGZyb20gJy4uLy4uL3V0aWxzL3JlYWRFZGl0Q29udGV4dC5qcydcbmltcG9ydCB7IGZpcnN0TGluZU9mIH0gZnJvbSAnLi4vLi4vdXRpbHMvc3RyaW5nVXRpbHMuanMnXG5pbXBvcnQgdHlwZSB7IFRoZW1lTmFtZSB9IGZyb20gJy4uLy4uL3V0aWxzL3RoZW1lLmpzJ1xuaW1wb3J0IHR5cGUgeyBGaWxlRWRpdE91dHB1dCB9IGZyb20gJy4vdHlwZXMuanMnXG5pbXBvcnQge1xuICBmaW5kQWN0dWFsU3RyaW5nLFxuICBnZXRQYXRjaEZvckVkaXQsXG4gIHByZXNlcnZlUXVvdGVTdHlsZSxcbn0gZnJvbSAnLi91dGlscy5qcydcblxuZXhwb3J0IGZ1bmN0aW9uIHVzZXJGYWNpbmdOYW1lKFxuICBpbnB1dDpcbiAgICB8IFBhcnRpYWw8e1xuICAgICAgICBmaWxlX3BhdGg6IHN0cmluZ1xuICAgICAgICBvbGRfc3RyaW5nOiBzdHJpbmdcbiAgICAgICAgbmV3X3N0cmluZzogc3RyaW5nXG4gICAgICAgIHJlcGxhY2VfYWxsOiBib29sZWFuXG4gICAgICAgIGVkaXRzOiB1bmtub3duW11cbiAgICAgIH0+XG4gICAgfCB1bmRlZmluZWQsXG4pOiBzdHJpbmcge1xuICBpZiAoIWlucHV0KSB7XG4gICAgcmV0dXJuICdVcGRhdGUnXG4gIH1cbiAgaWYgKGlucHV0LmZpbGVfcGF0aD8uc3RhcnRzV2l0aChnZXRQbGFuc0RpcmVjdG9yeSgpKSkge1xuICAgIHJldHVybiAnVXBkYXRlZCBwbGFuJ1xuICB9XG4gIC8vIEhhc2hsaW5lIGVkaXRzIGFsd2F5cyBtb2RpZnkgYW4gZXhpc3RpbmcgZmlsZSAobGluZS1yZWYgYmFzZWQpXG4gIGlmIChpbnB1dC5lZGl0cyAhPSBudWxsKSB7XG4gICAgcmV0dXJuICdVcGRhdGUnXG4gIH1cbiAgaWYgKGlucHV0Lm9sZF9zdHJpbmcgPT09ICcnKSB7XG4gICAgcmV0dXJuICdDcmVhdGUnXG4gIH1cbiAgcmV0dXJuICdVcGRhdGUnXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRUb29sVXNlU3VtbWFyeShcbiAgaW5wdXQ6XG4gICAgfCBQYXJ0aWFsPHtcbiAgICAgICAgZmlsZV9wYXRoOiBzdHJpbmdcbiAgICAgICAgb2xkX3N0cmluZzogc3RyaW5nXG4gICAgICAgIG5ld19zdHJpbmc6IHN0cmluZ1xuICAgICAgICByZXBsYWNlX2FsbDogYm9vbGVhblxuICAgICAgfT5cbiAgICB8IHVuZGVmaW5lZCxcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWlucHV0Py5maWxlX3BhdGgpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIHJldHVybiBnZXREaXNwbGF5UGF0aChpbnB1dC5maWxlX3BhdGgpXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlTWVzc2FnZShcbiAgeyBmaWxlX3BhdGggfTogeyBmaWxlX3BhdGg/OiBzdHJpbmcgfSxcbiAgeyB2ZXJib3NlIH06IHsgdmVyYm9zZTogYm9vbGVhbiB9LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgaWYgKCFmaWxlX3BhdGgpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIC8vIEZvciBwbGFuIGZpbGVzLCBwYXRoIGlzIGFscmVhZHkgaW4gdXNlckZhY2luZ05hbWVcbiAgaWYgKGZpbGVfcGF0aC5zdGFydHNXaXRoKGdldFBsYW5zRGlyZWN0b3J5KCkpKSB7XG4gICAgcmV0dXJuICcnXG4gIH1cbiAgcmV0dXJuIChcbiAgICA8RmlsZVBhdGhMaW5rIGZpbGVQYXRoPXtmaWxlX3BhdGh9PlxuICAgICAge3ZlcmJvc2UgPyBmaWxlX3BhdGggOiBnZXREaXNwbGF5UGF0aChmaWxlX3BhdGgpfVxuICAgIDwvRmlsZVBhdGhMaW5rPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShcbiAgeyBmaWxlUGF0aCwgc3RydWN0dXJlZFBhdGNoLCBvcmlnaW5hbEZpbGUgfTogRmlsZUVkaXRPdXRwdXQsXG4gIF9wcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZTogUHJvZ3Jlc3NNZXNzYWdlW10sXG4gIHsgc3R5bGUsIHZlcmJvc2UgfTogeyBzdHlsZT86ICdjb25kZW5zZWQnOyB2ZXJib3NlOiBib29sZWFuIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICAvLyBGb3IgcGxhbiBmaWxlcywgc2hvdyAvcGxhbiBoaW50IGFib3ZlIHRoZSBkaWZmXG4gIGNvbnN0IGlzUGxhbkZpbGUgPSBmaWxlUGF0aC5zdGFydHNXaXRoKGdldFBsYW5zRGlyZWN0b3J5KCkpXG5cbiAgcmV0dXJuIChcbiAgICA8RmlsZUVkaXRUb29sVXBkYXRlZE1lc3NhZ2VcbiAgICAgIGZpbGVQYXRoPXtmaWxlUGF0aH1cbiAgICAgIHN0cnVjdHVyZWRQYXRjaD17c3RydWN0dXJlZFBhdGNofVxuICAgICAgZmlyc3RMaW5lPXtvcmlnaW5hbEZpbGUuc3BsaXQoJ1xcbicpWzBdID8/IG51bGx9XG4gICAgICBmaWxlQ29udGVudD17b3JpZ2luYWxGaWxlfVxuICAgICAgc3R5bGU9e3N0eWxlfVxuICAgICAgdmVyYm9zZT17dmVyYm9zZX1cbiAgICAgIHByZXZpZXdIaW50PXtpc1BsYW5GaWxlID8gJy9wbGFuIHRvIHByZXZpZXcnIDogdW5kZWZpbmVkfVxuICAgIC8+XG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VSZWplY3RlZE1lc3NhZ2UoXG4gIGlucHV0OiB7XG4gICAgZmlsZV9wYXRoOiBzdHJpbmdcbiAgICBvbGRfc3RyaW5nPzogc3RyaW5nXG4gICAgbmV3X3N0cmluZz86IHN0cmluZ1xuICAgIHJlcGxhY2VfYWxsPzogYm9vbGVhblxuICAgIGVkaXRzPzogdW5rbm93bltdXG4gIH0sXG4gIG9wdGlvbnM6IHtcbiAgICBjb2x1bW5zOiBudW1iZXJcbiAgICBtZXNzYWdlczogTWVzc2FnZVtdXG4gICAgcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2U6IFByb2dyZXNzTWVzc2FnZVtdXG4gICAgc3R5bGU/OiAnY29uZGVuc2VkJ1xuICAgIHRoZW1lOiBUaGVtZU5hbWVcbiAgICB0b29sczogVG9vbHNcbiAgICB2ZXJib3NlOiBib29sZWFuXG4gIH0sXG4pOiBSZWFjdC5SZWFjdEVsZW1lbnQge1xuICBjb25zdCB7IHN0eWxlLCB2ZXJib3NlIH0gPSBvcHRpb25zXG4gIGNvbnN0IGZpbGVQYXRoID0gaW5wdXQuZmlsZV9wYXRoXG4gIGNvbnN0IG9sZFN0cmluZyA9IGlucHV0Lm9sZF9zdHJpbmcgPz8gJydcbiAgY29uc3QgbmV3U3RyaW5nID0gaW5wdXQubmV3X3N0cmluZyA/PyAnJ1xuICBjb25zdCByZXBsYWNlQWxsID0gaW5wdXQucmVwbGFjZV9hbGwgPz8gZmFsc2VcblxuICAvLyBEZWZlbnNpdmU6IGlmIGlucHV0IGhhcyBhbiB1bmV4cGVjdGVkIHNoYXBlLCBzaG93IGEgc2ltcGxlIHJlamVjdGlvbiBtZXNzYWdlXG4gIGlmICgnZWRpdHMnIGluIGlucHV0ICYmIGlucHV0LmVkaXRzICE9IG51bGwpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEZpbGVFZGl0VG9vbFVzZVJlamVjdGVkTWVzc2FnZVxuICAgICAgICBmaWxlX3BhdGg9e2ZpbGVQYXRofVxuICAgICAgICBvcGVyYXRpb249XCJ1cGRhdGVcIlxuICAgICAgICBmaXJzdExpbmU9e251bGx9XG4gICAgICAgIHZlcmJvc2U9e3ZlcmJvc2V9XG4gICAgICAvPlxuICAgIClcbiAgfVxuXG4gIGNvbnN0IGlzTmV3RmlsZSA9IG9sZFN0cmluZyA9PT0gJydcblxuICAvLyBGb3IgbmV3IGZpbGUgY3JlYXRpb24sIHNob3cgY29udGVudCBwcmV2aWV3IGluc3RlYWQgb2YgZGlmZlxuICBpZiAoaXNOZXdGaWxlKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxGaWxlRWRpdFRvb2xVc2VSZWplY3RlZE1lc3NhZ2VcbiAgICAgICAgZmlsZV9wYXRoPXtmaWxlUGF0aH1cbiAgICAgICAgb3BlcmF0aW9uPVwid3JpdGVcIlxuICAgICAgICBjb250ZW50PXtuZXdTdHJpbmd9XG4gICAgICAgIGZpcnN0TGluZT17Zmlyc3RMaW5lT2YobmV3U3RyaW5nKX1cbiAgICAgICAgdmVyYm9zZT17dmVyYm9zZX1cbiAgICAgIC8+XG4gICAgKVxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8RWRpdFJlamVjdGlvbkRpZmZcbiAgICAgIGZpbGVQYXRoPXtmaWxlUGF0aH1cbiAgICAgIG9sZFN0cmluZz17b2xkU3RyaW5nfVxuICAgICAgbmV3U3RyaW5nPXtuZXdTdHJpbmd9XG4gICAgICByZXBsYWNlQWxsPXtyZXBsYWNlQWxsfVxuICAgICAgc3R5bGU9e3N0eWxlfVxuICAgICAgdmVyYm9zZT17dmVyYm9zZX1cbiAgICAvPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlRXJyb3JNZXNzYWdlKFxuICByZXN1bHQ6IFRvb2xSZXN1bHRCbG9ja1BhcmFtWydjb250ZW50J10sXG4gIG9wdGlvbnM6IHtcbiAgICBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZTogUHJvZ3Jlc3NNZXNzYWdlW11cbiAgICB0b29sczogVG9vbHNcbiAgICB2ZXJib3NlOiBib29sZWFuXG4gIH0sXG4pOiBSZWFjdC5SZWFjdEVsZW1lbnQge1xuICBjb25zdCB7IHZlcmJvc2UgfSA9IG9wdGlvbnNcbiAgaWYgKFxuICAgICF2ZXJib3NlICYmXG4gICAgdHlwZW9mIHJlc3VsdCA9PT0gJ3N0cmluZycgJiZcbiAgICBleHRyYWN0VGFnKHJlc3VsdCwgJ3Rvb2xfdXNlX2Vycm9yJylcbiAgKSB7XG4gICAgY29uc3QgZXJyb3JNZXNzYWdlID0gZXh0cmFjdFRhZyhyZXN1bHQsICd0b29sX3VzZV9lcnJvcicpXG4gICAgLy8gU2hvdyBhIGxlc3Mgc2NhcnkgbWVzc2FnZSBmb3IgaW50ZW5kZWQgYmVoYXZpb3JcbiAgICBpZiAoZXJyb3JNZXNzYWdlPy5pbmNsdWRlcygnRmlsZSBoYXMgbm90IGJlZW4gcmVhZCB5ZXQnKSkge1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5GaWxlIG11c3QgYmUgcmVhZCBmaXJzdDwvVGV4dD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApXG4gICAgfVxuICAgIGlmIChlcnJvck1lc3NhZ2U/LmluY2x1ZGVzKEZJTEVfTk9UX0ZPVU5EX0NXRF9OT1RFKSkge1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+RmlsZSBub3QgZm91bmQ8L1RleHQ+XG4gICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgKVxuICAgIH1cbiAgICByZXR1cm4gKFxuICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPkVycm9yIGVkaXRpbmcgZmlsZTwvVGV4dD5cbiAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgIClcbiAgfVxuICByZXR1cm4gPEZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSByZXN1bHQ9e3Jlc3VsdH0gdmVyYm9zZT17dmVyYm9zZX0gLz5cbn1cblxudHlwZSBSZWplY3Rpb25EaWZmRGF0YSA9IHtcbiAgcGF0Y2g6IFN0cnVjdHVyZWRQYXRjaEh1bmtbXVxuICBmaXJzdExpbmU6IHN0cmluZyB8IG51bGxcbiAgZmlsZUNvbnRlbnQ6IHN0cmluZyB8IHVuZGVmaW5lZFxufVxuXG5mdW5jdGlvbiBFZGl0UmVqZWN0aW9uRGlmZih7XG4gIGZpbGVQYXRoLFxuICBvbGRTdHJpbmcsXG4gIG5ld1N0cmluZyxcbiAgcmVwbGFjZUFsbCxcbiAgc3R5bGUsXG4gIHZlcmJvc2UsXG59OiB7XG4gIGZpbGVQYXRoOiBzdHJpbmdcbiAgb2xkU3RyaW5nOiBzdHJpbmdcbiAgbmV3U3RyaW5nOiBzdHJpbmdcbiAgcmVwbGFjZUFsbDogYm9vbGVhblxuICBzdHlsZT86ICdjb25kZW5zZWQnXG4gIHZlcmJvc2U6IGJvb2xlYW5cbn0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBbZGF0YVByb21pc2VdID0gdXNlU3RhdGUoKCkgPT5cbiAgICBsb2FkUmVqZWN0aW9uRGlmZihmaWxlUGF0aCwgb2xkU3RyaW5nLCBuZXdTdHJpbmcsIHJlcGxhY2VBbGwpLFxuICApXG4gIHJldHVybiAoXG4gICAgPFN1c3BlbnNlXG4gICAgICBmYWxsYmFjaz17XG4gICAgICAgIDxGaWxlRWRpdFRvb2xVc2VSZWplY3RlZE1lc3NhZ2VcbiAgICAgICAgICBmaWxlX3BhdGg9e2ZpbGVQYXRofVxuICAgICAgICAgIG9wZXJhdGlvbj1cInVwZGF0ZVwiXG4gICAgICAgICAgZmlyc3RMaW5lPXtudWxsfVxuICAgICAgICAgIHZlcmJvc2U9e3ZlcmJvc2V9XG4gICAgICAgIC8+XG4gICAgICB9XG4gICAgPlxuICAgICAgPEVkaXRSZWplY3Rpb25Cb2R5XG4gICAgICAgIHByb21pc2U9e2RhdGFQcm9taXNlfVxuICAgICAgICBmaWxlUGF0aD17ZmlsZVBhdGh9XG4gICAgICAgIHN0eWxlPXtzdHlsZX1cbiAgICAgICAgdmVyYm9zZT17dmVyYm9zZX1cbiAgICAgIC8+XG4gICAgPC9TdXNwZW5zZT5cbiAgKVxufVxuXG5mdW5jdGlvbiBFZGl0UmVqZWN0aW9uQm9keSh7XG4gIHByb21pc2UsXG4gIGZpbGVQYXRoLFxuICBzdHlsZSxcbiAgdmVyYm9zZSxcbn06IHtcbiAgcHJvbWlzZTogUHJvbWlzZTxSZWplY3Rpb25EaWZmRGF0YT5cbiAgZmlsZVBhdGg6IHN0cmluZ1xuICBzdHlsZT86ICdjb25kZW5zZWQnXG4gIHZlcmJvc2U6IGJvb2xlYW5cbn0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCB7IHBhdGNoLCBmaXJzdExpbmUsIGZpbGVDb250ZW50IH0gPSB1c2UocHJvbWlzZSlcbiAgcmV0dXJuIChcbiAgICA8RmlsZUVkaXRUb29sVXNlUmVqZWN0ZWRNZXNzYWdlXG4gICAgICBmaWxlX3BhdGg9e2ZpbGVQYXRofVxuICAgICAgb3BlcmF0aW9uPVwidXBkYXRlXCJcbiAgICAgIHBhdGNoPXtwYXRjaH1cbiAgICAgIGZpcnN0TGluZT17Zmlyc3RMaW5lfVxuICAgICAgZmlsZUNvbnRlbnQ9e2ZpbGVDb250ZW50fVxuICAgICAgc3R5bGU9e3N0eWxlfVxuICAgICAgdmVyYm9zZT17dmVyYm9zZX1cbiAgICAvPlxuICApXG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRSZWplY3Rpb25EaWZmKFxuICBmaWxlUGF0aDogc3RyaW5nLFxuICBvbGRTdHJpbmc6IHN0cmluZyxcbiAgbmV3U3RyaW5nOiBzdHJpbmcsXG4gIHJlcGxhY2VBbGw6IGJvb2xlYW4sXG4pOiBQcm9taXNlPFJlamVjdGlvbkRpZmZEYXRhPiB7XG4gIHRyeSB7XG4gICAgLy8gQ2h1bmtlZCByZWFkIOKAlCBjb250ZXh0IHdpbmRvdyBhcm91bmQgdGhlIGZpcnN0IG9jY3VycmVuY2UuIHJlcGxhY2VBbGxcbiAgICAvLyBzdGlsbCBzaG93cyBtYXRjaGVzICp3aXRoaW4qIHRoZSB3aW5kb3cgdmlhIGdldFBhdGNoRm9yRWRpdDsgd2UgYWNjZXB0XG4gICAgLy8gbG9zaW5nIHRoZSBhbGwtb2NjdXJyZW5jZXMgdmlldyB0byBrZWVwIHRoZSByZWFkIGJvdW5kZWQuXG4gICAgY29uc3QgY3R4ID0gYXdhaXQgcmVhZEVkaXRDb250ZXh0KGZpbGVQYXRoLCBvbGRTdHJpbmcsIENPTlRFWFRfTElORVMpXG4gICAgaWYgKGN0eCA9PT0gbnVsbCB8fCBjdHgudHJ1bmNhdGVkIHx8IGN0eC5jb250ZW50ID09PSAnJykge1xuICAgICAgLy8gRU5PRU5UIC8gbm90IGZvdW5kIC8gdHJ1bmNhdGVkIOKAlCBkaWZmIGp1c3QgdGhlIHRvb2wgaW5wdXRzLlxuICAgICAgY29uc3QgeyBwYXRjaCB9ID0gZ2V0UGF0Y2hGb3JFZGl0KHtcbiAgICAgICAgZmlsZVBhdGgsXG4gICAgICAgIGZpbGVDb250ZW50czogb2xkU3RyaW5nLFxuICAgICAgICBvbGRTdHJpbmcsXG4gICAgICAgIG5ld1N0cmluZyxcbiAgICAgIH0pXG4gICAgICByZXR1cm4geyBwYXRjaCwgZmlyc3RMaW5lOiBudWxsLCBmaWxlQ29udGVudDogdW5kZWZpbmVkIH1cbiAgICB9XG4gICAgY29uc3QgYWN0dWFsT2xkID0gZmluZEFjdHVhbFN0cmluZyhjdHguY29udGVudCwgb2xkU3RyaW5nKSB8fCBvbGRTdHJpbmdcbiAgICBjb25zdCBhY3R1YWxOZXcgPSBwcmVzZXJ2ZVF1b3RlU3R5bGUob2xkU3RyaW5nLCBhY3R1YWxPbGQsIG5ld1N0cmluZylcbiAgICBjb25zdCB7IHBhdGNoIH0gPSBnZXRQYXRjaEZvckVkaXQoe1xuICAgICAgZmlsZVBhdGgsXG4gICAgICBmaWxlQ29udGVudHM6IGN0eC5jb250ZW50LFxuICAgICAgb2xkU3RyaW5nOiBhY3R1YWxPbGQsXG4gICAgICBuZXdTdHJpbmc6IGFjdHVhbE5ldyxcbiAgICAgIHJlcGxhY2VBbGwsXG4gICAgfSlcbiAgICByZXR1cm4ge1xuICAgICAgcGF0Y2g6IGFkanVzdEh1bmtMaW5lTnVtYmVycyhwYXRjaCwgY3R4LmxpbmVPZmZzZXQgLSAxKSxcbiAgICAgIGZpcnN0TGluZTogY3R4LmxpbmVPZmZzZXQgPT09IDEgPyBmaXJzdExpbmVPZihjdHguY29udGVudCkgOiBudWxsLFxuICAgICAgZmlsZUNvbnRlbnQ6IGN0eC5jb250ZW50LFxuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIFVzZXIgbWF5IGhhdmUgbWFudWFsbHkgYXBwbGllZCB0aGUgY2hhbmdlIHdoaWxlIHRoZSBkaWZmIHdhcyBzaG93bi5cbiAgICBsb2dFcnJvcihlIGFzIEVycm9yKVxuICAgIHJldHVybiB7IHBhdGNoOiBbXSwgZmlyc3RMaW5lOiBudWxsLCBmaWxlQ29udGVudDogdW5kZWZpbmVkIH1cbiAgfVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsY0FBY0Esb0JBQW9CLFFBQVEsdUNBQXVDO0FBQ2pGLGNBQWNDLG1CQUFtQixRQUFRLE1BQU07QUFDL0MsT0FBTyxLQUFLQyxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxRQUFRLEVBQUVDLEdBQUcsRUFBRUMsUUFBUSxRQUFRLE9BQU87QUFDL0MsU0FBU0MsOEJBQThCLFFBQVEsa0RBQWtEO0FBQ2pHLFNBQVNDLGVBQWUsUUFBUSxtQ0FBbUM7QUFDbkUsU0FBU0MsVUFBVSxRQUFRLHVCQUF1QjtBQUNsRCxTQUFTQywyQkFBMkIsUUFBUSxpREFBaUQ7QUFDN0YsU0FBU0MsMEJBQTBCLFFBQVEsZ0RBQWdEO0FBQzNGLFNBQVNDLFlBQVksUUFBUSxrQ0FBa0M7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QUFDLENBQUM7RUFDNUIsSUFBSTtJQUNGO0lBQ0E7SUFDQTtJQUNBLE1BQU1pQixHQUFHLEdBQUcsTUFBTTlELGVBQWUsQ0FBQ3FCLFFBQVEsRUFBRWdCLFNBQVMsRUFBRTFDLGFBQWEsQ0FBQztJQUNyRSxJQUFJbUUsR0FBRyxLQUFLLElBQUksSUFBSUEsR0FBRyxDQUFDQyxTQUFTLElBQUlELEdBQUcsQ0FBQ0UsT0FBTyxLQUFLLEVBQUUsRUFBRTtNQUN2RDtNQUNBLE1BQU07UUFBRWxCO01BQU0sQ0FBQyxHQUFHekMsZUFBZSxDQUFDO1FBQ2hDZ0IsUUFBUTtRQUNSNEMsWUFBWSxFQUFFNUIsU0FBUztRQUN2QkEsU0FBUztRQUNUQztNQUNGLENBQUMsQ0FBQztNQUNGLE9BQU87UUFBRVEsS0FBSztRQUFFQyxTQUFTLEVBQUUsSUFBSTtRQUFFQyxXQUFXLEVBQUVwQjtNQUFVLENBQUM7SUFDM0Q7SUFDQSxNQUFNc0MsU0FBUyxHQUFHOUQsZ0JBQWdCLENBQUMwRCxHQUFHLENBQUNFLE9BQU8sRUFBRTNCLFNBQVMsQ0FBQyxJQUFJQSxTQUFTO0lBQ3ZFLE1BQU04QixTQUFTLEdBQUc3RCxrQkFBa0IsQ0FBQytCLFNBQVMsRUFBRTZCLFNBQVMsRUFBRTVCLFNBQVMsQ0FBQztJQUNyRSxNQUFNO01BQUVRO0lBQU0sQ0FBQyxHQUFHekMsZUFBZSxDQUFDO01BQ2hDZ0IsUUFBUTtNQUNSNEMsWUFBWSxFQUFFSCxHQUFHLENBQUNFLE9BQU87TUFDekIzQixTQUFTLEVBQUU2QixTQUFTO01BQ3BCNUIsU0FBUyxFQUFFNkIsU0FBUztNQUNwQjVCO0lBQ0YsQ0FBQyxDQUFDO0lBQ0YsT0FBTztNQUNMTyxLQUFLLEVBQUVwRCxxQkFBcUIsQ0FBQ29ELEtBQUssRUFBRWdCLEdBQUcsQ0FBQ00sVUFBVSxHQUFHLENBQUMsQ0FBQztNQUN2RHJCLFNBQVMsRUFBRWUsR0FBRyxDQUFDTSxVQUFVLEtBQUssQ0FBQyxHQUFHbkUsV0FBVyxDQUFDNkQsR0FBRyxDQUFDRSxPQUFPLENBQUMsR0FBRyxJQUFJO01BQ2pFaEIsV0FBVyxFQUFFYyxHQUFHLENBQUNFO0lBQ25CLENBQUM7RUFDSCxDQUFDLENBQUMsT0FBT0ssQ0FBQyxFQUFFO0lBQ1Y7SUFDQXZFLFFBQVEsQ0FBQ3VFLENBQUMsSUFBSUMsS0FBSyxDQUFDO0lBQ3BCLE9BQU87TUFBRXhCLEtBQUssRUFBRSxFQUFFO01BQUVDLFNBQVMsRUFBRSxJQUFJO01BQUVDLFdBQVcsRUFBRXBCO0lBQVUsQ0FBQztFQUMvRDtBQUNGIiwiaWdub3JlTGlzdCI6W119