/**
 * 【一句话定位】PowerShell 工具的**终端渲染层**：把一次工具调用的四种状态
 * （发起中 / 进行中 / 排队中 / 已出结果 / 出错）渲染成 Ink（终端版 React）组件树。
 * 一句话：只负责「怎么画」，不负责「怎么执行」。
 *
 * 【在架构中的位置】
 *   Tool 框架（src/Tool.ts 定义的 Tool 接口）
 *        ──回调──> renderToolUseMessage / renderToolUseProgressMessage /
 *                  renderToolUseQueuedMessage / renderToolResultMessage /
 *                  renderToolUseErrorMessage   ←── 本文件全部导出
 *   本文件 ──> PowerShellTool.tsx（仅 import 类型 Out / PowerShellToolInput）
 *             ──> 通用组件：OutputLine / ShellProgressMessage / ShellTimeDisplay /
 *                 MessageResponse / FallbackToolUseErrorMessage / KeyboardShortcutHint
 *   数据流反向说：PowerShellTool.tsx 产出 Out 数据 → 这里的 renderToolResultMessage 消费。
 *
 *   对照 BashTool：src/tools/BashTool/UI.tsx 是同构的 Unix 版，导出的五个函数
 *   名字、签名、甚至常量（MAX_COMMAND_DISPLAY_LINES/CHARS）都一致。
 *   学会一个就能看懂另一个 —— 差异只在 TypedTool 的具体类型名。
 *
 * 【本文件包含什么】（五个 render 函数，对应工具生命周期的五个画面）
 *   renderToolUseMessage           ：工具刚被调用时，显示被执行的命令（可能截断）。
 *   renderToolUseProgressMessage   ：执行中，显示实时输出/耗时/字节数。
 *   renderToolUseQueuedMessage     ：并发限流时排队中，显示 Waiting…。
 *   renderToolResultMessage        ：执行完，显示 stdout/stderr/中断说明/耗时。
 *   renderToolUseErrorMessage      ：工具调用本身出错时的兜底展示。
 *
 * 【TS 语法速查】（本文件是 .tsx，JSX 是重点）
 *   .tsx 后缀 = 允许在源码里直接写 XML 风格的标签 <Text>...</Text>。
 *     它不是字符串拼接，编译后是 React.createElement('Text', props, children)，
 *     ≈ Java 里手工 new Element("Text").attr(...).child(...) 的语法糖。
 *   { expr ? <A/> : null }
 *     JSX 里用 {} 包住任意 JS 表达式；条件渲染靠三元。**没有** JSX 版的 if，
 *     要写多行判断就抽成函数或用 && （{cond && <A/>}）。
 *   <>...</> 是 Fragment（空标签），≈ 不产生实体的包装节点
 *     ≈ Flutter 的 children 数组 / Java Swing 里往容器塞多个组件。
 *   progressMessagesForMessage: ProgressMessage<PowerShellProgress>[]
 *     泛型写法 <T> 跟 Java 一样，但**数组类型写 T[]**（Java 写 List<T>）。
 *   ({ verbose, theme: _theme }: { verbose: boolean; theme: ThemeName })
 *     ① 形参就地解构（≈ 从 Map 里一次性取值）
 *     ② theme: _theme 表示把属性 theme 改名绑定到局部变量 _theme
 *     ③ 冒号后面那个对象字面量是**形参的类型注解**（放在参数后面，Java 放前面）
 *   progressMessagesForMessage.at(-1)
 *     .at(-1) 取最后一个元素，-1 表示倒数第一。≈ Java list.get(list.size()-1)，
 *     但空数组返回 undefined 而不是抛 IndexOutOfBounds。
 *   lastProgress?.data?.timeoutMs
 *     ?. 可选链 ≈ 一串 null 检查的糖：lastProgress && lastProgress.data && ...
 *     任一环为 null/undefined 就整体短路成 undefined（**不会**抛 NPE）。
 *   TypeScript 的 `import type`
 *     只导入类型，编译后被完全擦除，不会影响运行时依赖图。
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { OutputLine } from '../../components/shell/OutputLine.js';
import { ShellProgressMessage } from '../../components/shell/ShellProgressMessage.js';
import { ShellTimeDisplay } from '../../components/shell/ShellTimeDisplay.js';
import { Box, Text } from '../../ink.js';
import type { Tool } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import type { PowerShellProgress } from '../../types/tools.js';
import type { ThemeName } from '../../utils/theme.js';
import type { Out, PowerShellToolInput } from './PowerShellTool.js';

// 命令显示的截断阈值：非 verbose 模式下命令最多占 2 行 / 160 字符。
// 为什么截断：终端一行宽度有限，模型常生成超长管道命令，
// 不截断会把整个会话记录顶飞，用户看不到自己在干嘛。
// Constants for command display
const MAX_COMMAND_DISPLAY_LINES = 2;
const MAX_COMMAND_DISPLAY_CHARS = 160;
/**
 * 【中文】渲染「工具被调用」这一行：显示即将执行的命令。
 *
 * @param input 工具入参（Partial<> 表示校验完成前字段可能不全，见下方 TS 注）
 * @param opts.verbose true = 完整显示；false = 超长则截断并加省略号 …
 * @param opts.theme 主题名 —— 本函数未使用（改名成 _theme 明确表示「故意不用」）
 * @returns React 节点；没有任何命令文本时返回 null（不渲染任何东西）
 *
 * 步骤：① 取 command 字段，没有就不渲染
 *      ② verbose 直接原样返回
 *      ③ 否则先按行数截断到 2 行，再按字符截断到 160
 *      ④ 末尾拼一个 … 告诉用户「被截断了，看详情请开 verbose」
 */
export function renderToolUseMessage(input: Partial<PowerShellToolInput>, {
  verbose,
  theme: _theme
}: {
// 注意这个对象类型直接写在**形参后面**（冒号 + 字面量类型），这是 TS 的
// 匿名结构类型；Java 必须为此单独建一个 record/class。
  verbose: boolean;
  theme: ThemeName;
}): React.ReactNode {
// `const { command } = input`：对象解构 ≈ Java 的 var command = input.getCommand()。
// Partial<PowerShellToolInput>：把每个字段都变成可选的工具类型，
// ≈ Java 里「所有字段都可能为 null」的半成品 DTO（流式到达的工具参数确实是半成品）。
  const {
    command
  } = input;
  if (!command) {
    return null;
  }
  const displayCommand = command;
// 只有非 verbose 才截断 —— verbose 是用户主动要求看全量，不能偷偷砍内容。
  if (!verbose) {
// 两个维度分别判断是否需要截断：行数和总字符数都要管，
// 因为一条超长单行不换行的话照样会撑爆终端布局。
    const lines = displayCommand.split('\n');
    const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES;
    const needsCharTruncation = displayCommand.length > MAX_COMMAND_DISPLAY_CHARS;
    if (needsLineTruncation || needsCharTruncation) {
      let truncated = displayCommand;
      if (needsLineTruncation) {
        truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n');
      }
// 行截断后再判字符数：顺序不能反，否则先按字符切会破坏原来的行结构。
      if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
        truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS);
      }
      return <Text>{truncated.trim()}…</Text>;
    }
  }
  return displayCommand;
}
/**
 * 【中文】渲染「执行中」的实时画面：交给通用的 ShellProgressMessage 组件。
 *
 * @param progressMessagesForMessage 本次工具调用累积的进度消息列表
 *   （PowerShell 执行过程中会持续推送已经产出的输出、耗时、字节数等）
 * @returns 有进度数据就交给 ShellProgressMessage；还没有任何数据时显示 Running…
 *
 * 为什么只看最后一条：进度消息是**累积快照**（每条都带全量当前状态），
 * 最新的那条就是当前全貌，不需要自己去合并历史。
 */
export function renderToolUseProgressMessage(progressMessagesForMessage: ProgressMessage<PowerShellProgress>[], {
  verbose,
  tools: _tools,
  terminalSize: _terminalSize,
  inProgressToolCallCount: _inProgressToolCallCount
}: {
  tools: Tool[];
  verbose: boolean;
  terminalSize?: {
    columns: number;
    rows: number;
  };
  inProgressToolCallCount?: number;
}): React.ReactNode {
// `.at(-1)`：取最后一个元素，-1 = 倒数第一。空数组返回 undefined（不抛异常）。
// 这里同时用 `!lastProgress || !lastProgress.data` 判空 —— TS 里显式判空后，
// 编译器会自动把 lastProgress 收窄成非空类型（控制流分析），后面才能安全访问。
  const lastProgress = progressMessagesForMessage.at(-1);
  if (!lastProgress || !lastProgress.data) {
    return <MessageResponse height={1}>
        <Text dimColor>Running…</Text>
      </MessageResponse>;
  }
  const data = lastProgress.data;
  return <ShellProgressMessage fullOutput={data.fullOutput} output={data.output} elapsedTimeSeconds={data.elapsedTimeSeconds} totalLines={data.totalLines} totalBytes={data.totalBytes} timeoutMs={data.timeoutMs} taskId={data.taskId} verbose={verbose} />;
}
/**
 * 【中文】渲染「排队中」：并发工具数达到上限时，本次调用还在队列里等待。
 * 没有动态信息可展示，所以是个无参数函数，写死一句 Waiting…。
 */
export function renderToolUseQueuedMessage(): React.ReactNode {
  return <MessageResponse height={1}>
      <Text dimColor>Waiting…</Text>
    </MessageResponse>;
}
/**
 * 【中文】渲染「执行结果」：本文件最核心的一个函数。
 *
 * @param content 工具的实际输出 Out（stdout/stderr/interrupted/returnCodeInterpretation…）
 * @param progressMessagesForMessage 用于取 timeoutMs（超时阈值），决定是否展示耗时
 * @returns 组合好的结果画面
 *
 * 步骤：① 图片结果走特殊分支（二进制数据不往终端打，只提示已送给模型）
 *      ② 有 stdout 就渲染 stdout；有非空 stderr 就用错误样式渲染
 *      ③ 两者都空时才显示兜底文案，优先级：
 *         后台运行中 > 被中断 > 退出码解释文案 > (No output)
 *      ④ 若这次调用有超时阈值，额外显示耗时
 */
export function renderToolResultMessage(content: Out, progressMessagesForMessage: ProgressMessage<PowerShellProgress>[], {
  verbose,
  theme: _theme,
  tools: _tools,
  style: _style
}: {
  verbose: boolean;
  theme: ThemeName;
  tools: Tool[];
  style?: 'condensed';
}): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1);
// `lastProgress?.data?.timeoutMs`：可选链一次串三层。
// ≈ Java 的 lastProgress != null && lastProgress.getData() != null ? getData().getTimeoutMs() : null
// 少了任意一层都不会抛 NPE，整条表达式直接短路成 undefined。
  const timeoutMs = lastProgress?.data?.timeoutMs;
  const {
    stdout,
    stderr,
    interrupted,
    returnCodeInterpretation,
    isImage,
    backgroundTaskId
  } = content;
// 图片是二进制，渲染到终端只会是一坨乱码 —— 只提示「已送给模型」。
// 这也是为什么 Out 里要专门有一个 isImage 标记位。
  if (isImage) {
    return <MessageResponse height={1}>
        <Text dimColor>[Image data detected and sent to Claude]</Text>
      </MessageResponse>;
  }
  return <Box flexDirection="column">
// JSX 条件渲染惯用法：`{条件 ? <组件/> : null}`。
// 注意 string 比较用 === （严格相等，不隐式转换）；TS/JS 里 == 会做类型转换，
// 本项目一律用 ===。≈ Java 的 Objects.equals()，但基本类型语义不同。
      {stdout !== '' ? <OutputLine content={stdout} verbose={verbose} /> : null}
      {stderr.trim() !== '' ? <OutputLine content={stderr} verbose={verbose} isError /> : null}
// stderr 的判断刻意用 trim() !== ''（空白的 stderr 不算错误输出），
// 而 stdout 用 !== ''：因为 PowerShell 命令常常以换行结尾，
// 换行是真实输出的一部分，不能 trim 掉。这个不对称是有意为之。
      {stdout === '' && stderr.trim() === '' ? <MessageResponse height={1}>
          <Text dimColor>
            {backgroundTaskId ? <>
                Running in the background{' '}
                <KeyboardShortcutHint shortcut="↓" action="manage" parens />
// 兜底文案的优先级链：后台运行 > 中断 > 退出码解释 > (No output)。
// returnCodeInterpretation 正来自 commandSemantics.ts（如 robocopy 的复制成功）。
              </> : interrupted ? 'Interrupted' : returnCodeInterpretation || '(No output)'}
          </Text>
        </MessageResponse> : null}
      {timeoutMs ? <MessageResponse>
          <ShellTimeDisplay timeoutMs={timeoutMs} />
        </MessageResponse> : null}
    </Box>;
}
/**
 * 【中文】渲染「工具调用本身失败」（区别于命令返回非 0 —— 那种走上面的 Result 分支）。
 * 典型场景：参数校验不通过、进程起不来。统一交给通用组件兜底展示。
 */
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  verbose,
  progressMessagesForMessage: _progressMessagesForMessage,
  tools: _tools
}: {
  verbose: boolean;
  progressMessagesForMessage: ProgressMessage<PowerShellProgress>[];
  tools: Tool[];
}): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}
// 最后这行是**构建产物注入**的 source map（把编译后的代码位置映射回 UI.tsx 源码），
// 不影响运行逻辑，不要手改。本仓库这份 PowerShellTool 源码是已编译产物的形态，
// 所以你才会看到 gzip/base64 的一大坨。
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUb29sUmVzdWx0QmxvY2tQYXJhbSIsIlJlYWN0IiwiS2V5Ym9hcmRTaG9ydGN1dEhpbnQiLCJGYWxsYmFja1Rvb2xVc2VFcnJvck1lc3NhZ2UiLCJNZXNzYWdlUmVzcG9uc2UiLCJPdXRwdXRMaW5lIiwiU2hlbGxQcm9ncmVzc01lc3NhZ2UiLCJTaGVsbFRpbWVEaXNwbGF5IiwiQm94IiwiVGV4dCIsIlRvb2wiLCJQcm9ncmVzc01lc3NhZ2UiLCJQb3dlclNoZWxsUHJvZ3Jlc3MiLCJUaGVtZU5hbWUiLCJPdXQiLCJQb3dlclNoZWxsVG9vbElucHV0IiwiTUFYX0NPTU1BTkRfRElTUExBWV9MSU5FUyIsIk1BWF9DT01NQU5EX0RJU1BMQVlfQ0hBUlMiLCJyZW5kZXJUb29sVXNlTWVzc2FnZSIsImlucHV0IiwiUGFydGlhbCIsInZlcmJvc2UiLCJ0aGVtZSIsIl90aGVtZSIsIlJlYWN0Tm9kZSIsImNvbW1hbmQiLCJkaXNwbGF5Q29tbWFuZCIsImxpbmVzIiwic3BsaXQiLCJuZWVkc0xpbmVUcnVuY2F0aW9uIiwibGVuZ3RoIiwibmVlZHNDaGFyVHJ1bmNhdGlvbiIsInRydW5jYXRlZCIsInNsaWNlIiwiam9pbiIsInRyaW0iLCJyZW5kZXJUb29sVXNlUHJvZ3Jlc3NNZXNzYWdlIiwicHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJ0b29scyIsIl90b29scyIsInRlcm1pbmFsU2l6ZSIsIl90ZXJtaW5hbFNpemUiLCJpblByb2dyZXNzVG9vbENhbGxDb3VudCIsIl9pblByb2dyZXNzVG9vbENhbGxDb3VudCIsImNvbHVtbnMiLCJyb3dzIiwibGFzdFByb2dyZXNzIiwiYXQiLCJkYXRhIiwiZnVsbE91dHB1dCIsIm91dHB1dCIsImVsYXBzZWRUaW1lU2Vjb25kcyIsInRvdGFsTGluZXMiLCJ0b3RhbEJ5dGVzIiwidGltZW91dE1zIiwidGFza0lkIiwicmVuZGVyVG9vbFVzZVF1ZXVlZE1lc3NhZ2UiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsImNvbnRlbnQiLCJzdHlsZSIsIl9zdHlsZSIsInN0ZG91dCIsInN0ZGVyciIsImludGVycnVwdGVkIiwicmV0dXJuQ29kZUludGVycHJldGF0aW9uIiwiaXNJbWFnZSIsImJhY2tncm91bmRUYXNrSWQiLCJyZW5kZXJUb29sVXNlRXJyb3JNZXNzYWdlIiwicmVzdWx0IiwiX3Byb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlIl0sInNvdXJjZXMiOlsiVUkudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVG9vbFJlc3VsdEJsb2NrUGFyYW0gfSBmcm9tICdAYW50aHJvcGljLWFpL3Nkay9yZXNvdXJjZXMvaW5kZXgubWpzJ1xuaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBLZXlib2FyZFNob3J0Y3V0SGludCB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvZGVzaWduLXN5c3RlbS9LZXlib2FyZFNob3J0Y3V0SGludC5qcydcbmltcG9ydCB7IEZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvRmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyBPdXRwdXRMaW5lIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9zaGVsbC9PdXRwdXRMaW5lLmpzJ1xuaW1wb3J0IHsgU2hlbGxQcm9ncmVzc01lc3NhZ2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL3NoZWxsL1NoZWxsUHJvZ3Jlc3NNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgU2hlbGxUaW1lRGlzcGxheSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvc2hlbGwvU2hlbGxUaW1lRGlzcGxheS5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB0eXBlIHsgVG9vbCB9IGZyb20gJy4uLy4uL1Rvb2wuanMnXG5pbXBvcnQgdHlwZSB7IFByb2dyZXNzTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgdHlwZSB7IFBvd2VyU2hlbGxQcm9ncmVzcyB9IGZyb20gJy4uLy4uL3R5cGVzL3Rvb2xzLmpzJ1xuaW1wb3J0IHR5cGUgeyBUaGVtZU5hbWUgfSBmcm9tICcuLi8uLi91dGlscy90aGVtZS5qcydcbmltcG9ydCB0eXBlIHsgT3V0LCBQb3dlclNoZWxsVG9vbElucHV0IH0gZnJvbSAnLi9Qb3dlclNoZWxsVG9vbC5qcydcblxuLy8gQ29uc3RhbnRzIGZvciBjb21tYW5kIGRpc3BsYXlcbmNvbnN0IE1BWF9DT01NQU5EX0RJU1BMQVlfTElORVMgPSAyXG5jb25zdCBNQVhfQ09NTUFORF9ESVNQTEFZX0NIQVJTID0gMTYwXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlTWVzc2FnZShcbiAgaW5wdXQ6IFBhcnRpYWw8UG93ZXJTaGVsbFRvb2xJbnB1dD4sXG4gIHsgdmVyYm9zZSwgdGhlbWU6IF90aGVtZSB9OiB7IHZlcmJvc2U6IGJvb2xlYW47IHRoZW1lOiBUaGVtZU5hbWUgfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgY29tbWFuZCB9ID0gaW5wdXRcbiAgaWYgKCFjb21tYW5kKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIGNvbnN0IGRpc3BsYXlDb21tYW5kID0gY29tbWFuZFxuXG4gIGlmICghdmVyYm9zZSkge1xuICAgIGNvbnN0IGxpbmVzID0gZGlzcGxheUNvbW1hbmQuc3BsaXQoJ1xcbicpXG4gICAgY29uc3QgbmVlZHNMaW5lVHJ1bmNhdGlvbiA9IGxpbmVzLmxlbmd0aCA+IE1BWF9DT01NQU5EX0RJU1BMQVlfTElORVNcbiAgICBjb25zdCBuZWVkc0NoYXJUcnVuY2F0aW9uID1cbiAgICAgIGRpc3BsYXlDb21tYW5kLmxlbmd0aCA+IE1BWF9DT01NQU5EX0RJU1BMQVlfQ0hBUlNcblxuICAgIGlmIChuZWVkc0xpbmVUcnVuY2F0aW9uIHx8IG5lZWRzQ2hhclRydW5jYXRpb24pIHtcbiAgICAgIGxldCB0cnVuY2F0ZWQgPSBkaXNwbGF5Q29tbWFuZFxuXG4gICAgICBpZiAobmVlZHNMaW5lVHJ1bmNhdGlvbikge1xuICAgICAgICB0cnVuY2F0ZWQgPSBsaW5lcy5zbGljZSgwLCBNQVhfQ09NTUFORF9ESVNQTEFZX0xJTkVTKS5qb2luKCdcXG4nKVxuICAgICAgfVxuXG4gICAgICBpZiAodHJ1bmNhdGVkLmxlbmd0aCA+IE1BWF9DT01NQU5EX0RJU1BMQVlfQ0hBUlMpIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1bmNhdGVkLnNsaWNlKDAsIE1BWF9DT01NQU5EX0RJU1BMQVlfQ0hBUlMpXG4gICAgICB9XG5cbiAgICAgIHJldHVybiA8VGV4dD57dHJ1bmNhdGVkLnRyaW0oKX3igKY8L1RleHQ+XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGRpc3BsYXlDb21tYW5kXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlUHJvZ3Jlc3NNZXNzYWdlKFxuICBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZTogUHJvZ3Jlc3NNZXNzYWdlPFBvd2VyU2hlbGxQcm9ncmVzcz5bXSxcbiAge1xuICAgIHZlcmJvc2UsXG4gICAgdG9vbHM6IF90b29scyxcbiAgICB0ZXJtaW5hbFNpemU6IF90ZXJtaW5hbFNpemUsXG4gICAgaW5Qcm9ncmVzc1Rvb2xDYWxsQ291bnQ6IF9pblByb2dyZXNzVG9vbENhbGxDb3VudCxcbiAgfToge1xuICAgIHRvb2xzOiBUb29sW11cbiAgICB2ZXJib3NlOiBib29sZWFuXG4gICAgdGVybWluYWxTaXplPzogeyBjb2x1bW5zOiBudW1iZXI7IHJvd3M6IG51bWJlciB9XG4gICAgaW5Qcm9ncmVzc1Rvb2xDYWxsQ291bnQ/OiBudW1iZXJcbiAgfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IGxhc3RQcm9ncmVzcyA9IHByb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlLmF0KC0xKVxuXG4gIGlmICghbGFzdFByb2dyZXNzIHx8ICFsYXN0UHJvZ3Jlc3MuZGF0YSkge1xuICAgIHJldHVybiAoXG4gICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPlJ1bm5pbmfigKY8L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cblxuICBjb25zdCBkYXRhID0gbGFzdFByb2dyZXNzLmRhdGFcblxuICByZXR1cm4gKFxuICAgIDxTaGVsbFByb2dyZXNzTWVzc2FnZVxuICAgICAgZnVsbE91dHB1dD17ZGF0YS5mdWxsT3V0cHV0fVxuICAgICAgb3V0cHV0PXtkYXRhLm91dHB1dH1cbiAgICAgIGVsYXBzZWRUaW1lU2Vjb25kcz17ZGF0YS5lbGFwc2VkVGltZVNlY29uZHN9XG4gICAgICB0b3RhbExpbmVzPXtkYXRhLnRvdGFsTGluZXN9XG4gICAgICB0b3RhbEJ5dGVzPXtkYXRhLnRvdGFsQnl0ZXN9XG4gICAgICB0aW1lb3V0TXM9e2RhdGEudGltZW91dE1zfVxuICAgICAgdGFza0lkPXtkYXRhLnRhc2tJZH1cbiAgICAgIHZlcmJvc2U9e3ZlcmJvc2V9XG4gICAgLz5cbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZVF1ZXVlZE1lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICA8VGV4dCBkaW1Db2xvcj5XYWl0aW5n4oCmPC9UZXh0PlxuICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShcbiAgY29udGVudDogT3V0LFxuICBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZTogUHJvZ3Jlc3NNZXNzYWdlPFBvd2VyU2hlbGxQcm9ncmVzcz5bXSxcbiAge1xuICAgIHZlcmJvc2UsXG4gICAgdGhlbWU6IF90aGVtZSxcbiAgICB0b29sczogX3Rvb2xzLFxuICAgIHN0eWxlOiBfc3R5bGUsXG4gIH06IHtcbiAgICB2ZXJib3NlOiBib29sZWFuXG4gICAgdGhlbWU6IFRoZW1lTmFtZVxuICAgIHRvb2xzOiBUb29sW11cbiAgICBzdHlsZT86ICdjb25kZW5zZWQnXG4gIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBsYXN0UHJvZ3Jlc3MgPSBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZS5hdCgtMSlcbiAgY29uc3QgdGltZW91dE1zID0gbGFzdFByb2dyZXNzPy5kYXRhPy50aW1lb3V0TXNcbiAgY29uc3Qge1xuICAgIHN0ZG91dCxcbiAgICBzdGRlcnIsXG4gICAgaW50ZXJydXB0ZWQsXG4gICAgcmV0dXJuQ29kZUludGVycHJldGF0aW9uLFxuICAgIGlzSW1hZ2UsXG4gICAgYmFja2dyb3VuZFRhc2tJZCxcbiAgfSA9IGNvbnRlbnRcblxuICBpZiAoaXNJbWFnZSkge1xuICAgIHJldHVybiAoXG4gICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPltJbWFnZSBkYXRhIGRldGVjdGVkIGFuZCBzZW50IHRvIENsYXVkZV08L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAge3N0ZG91dCAhPT0gJycgPyA8T3V0cHV0TGluZSBjb250ZW50PXtzdGRvdXR9IHZlcmJvc2U9e3ZlcmJvc2V9IC8+IDogbnVsbH1cbiAgICAgIHtzdGRlcnIudHJpbSgpICE9PSAnJyA/IChcbiAgICAgICAgPE91dHB1dExpbmUgY29udGVudD17c3RkZXJyfSB2ZXJib3NlPXt2ZXJib3NlfSBpc0Vycm9yIC8+XG4gICAgICApIDogbnVsbH1cbiAgICAgIHtzdGRvdXQgPT09ICcnICYmIHN0ZGVyci50cmltKCkgPT09ICcnID8gKFxuICAgICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgICB7YmFja2dyb3VuZFRhc2tJZCA/IChcbiAgICAgICAgICAgICAgPD5cbiAgICAgICAgICAgICAgICBSdW5uaW5nIGluIHRoZSBiYWNrZ3JvdW5keycgJ31cbiAgICAgICAgICAgICAgICA8S2V5Ym9hcmRTaG9ydGN1dEhpbnQgc2hvcnRjdXQ9XCLihpNcIiBhY3Rpb249XCJtYW5hZ2VcIiBwYXJlbnMgLz5cbiAgICAgICAgICAgICAgPC8+XG4gICAgICAgICAgICApIDogaW50ZXJydXB0ZWQgPyAoXG4gICAgICAgICAgICAgICdJbnRlcnJ1cHRlZCdcbiAgICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICAgIHJldHVybkNvZGVJbnRlcnByZXRhdGlvbiB8fCAnKE5vIG91dHB1dCknXG4gICAgICAgICAgICApfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApIDogbnVsbH1cbiAgICAgIHt0aW1lb3V0TXMgPyAoXG4gICAgICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgICAgPFNoZWxsVGltZURpc3BsYXkgdGltZW91dE1zPXt0aW1lb3V0TXN9IC8+XG4gICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgKSA6IG51bGx9XG4gICAgPC9Cb3g+XG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VFcnJvck1lc3NhZ2UoXG4gIHJlc3VsdDogVG9vbFJlc3VsdEJsb2NrUGFyYW1bJ2NvbnRlbnQnXSxcbiAge1xuICAgIHZlcmJvc2UsXG4gICAgcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2U6IF9wcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZSxcbiAgICB0b29sczogX3Rvb2xzLFxuICB9OiB7XG4gICAgdmVyYm9zZTogYm9vbGVhblxuICAgIHByb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlOiBQcm9ncmVzc01lc3NhZ2U8UG93ZXJTaGVsbFByb2dyZXNzPltdXG4gICAgdG9vbHM6IFRvb2xbXVxuICB9LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIDxGYWxsYmFja1Rvb2xVc2VFcnJvck1lc3NhZ2UgcmVzdWx0PXtyZXN1bHR9IHZlcmJvc2U9e3ZlcmJvc2V9IC8+XG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLGNBQWNBLG9CQUFvQixRQUFRLHVDQUF1QztBQUNqRixPQUFPLEtBQUtDLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLG9CQUFvQixRQUFRLHdEQUF3RDtBQUM3RixTQUFTQywyQkFBMkIsUUFBUSxpREFBaUQ7QUFDN0YsU0FBU0MsZUFBZSxRQUFRLHFDQUFxQztBQUNyRSxTQUFTQyxVQUFVLFFBQVEsc0NBQXNDO0FBQ2pFLFNBQVNDLG9CQUFvQixRQUFRLGdEQUFnRDtBQUNyRixTQUFTQyxnQkFBZ0IsUUFBUSw0Q0FBNEM7QUFDN0UsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxjQUFjQyxJQUFJLFFBQVEsZUFBZTtBQUN6QyxjQUFjQyxlQUFlLFFBQVEsd0JBQXdCO0FBQzdELGNBQWNDLGtCQUFrQixRQUFRLHNCQUFzQjtBQUM5RCxjQUFjQyxTQUFTLFFBQVEsc0JBQXNCO0FBQ3JELGNBQWNDLEdBQUcsRUFBRUMsbUJBQW1CLFFBQVEscUJBQXFCOztBQUVuRTtBQUNBLE1BQU1DLHlCQUF5QixHQUFHLENBQUM7QUFDbkMsTUFBTUMseUJBQXlCLEdBQUcsR0FBRztBQUVyQyxPQUFPLFNBQVNDLG9CQUFvQkEsQ0FDbENDLEtBQUssRUFBRUMsT0FBTyxDQUFDTCxtQkFBbUIsQ0FBQyxFQUNuQztFQUFFTSxPQUFPO0VBQUVDLEtBQUssRUFBRUM7QUFBK0MsQ0FBdkMsRUFBRTtFQUFFRixPQUFPLEVBQUUsT0FBTztFQUFFQyxLQUFLLEVBQUVULFNBQVM7QUFBQyxDQUFDLENBQ25FLEVBQUVaLEtBQUssQ0FBQ3VCLFNBQVMsQ0FBQztFQUNqQixN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