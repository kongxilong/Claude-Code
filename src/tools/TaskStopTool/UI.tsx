/**
 * ============================================================================
 *  【文件总览】src/tools/TaskStopTool/UI.tsx
 *              —— TaskStop 工具在终端里显示什么（React 渲染层）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件决定"停掉一个任务"这件事在终端上怎么显示：显示被停掉的那条命令 + " · stopped"。
 *
 *  【本文件包含什么】
 *   1. renderToolUseMessage()      调用发起时显示什么（这里返回空串 = 什么都不显示）
 *   2. truncateCommand()           把命令截断到"最多 2 行、最多 160 个字符"
 *   3. renderToolResultMessage()   调用结束后显示什么
 *
 *  【为什么要截断命令？】
 *  终端宽度有限（通常 80~120 列）。后台任务的命令可能是一条超长的 shell 命令，
 *  不截断会把终端界面撑乱、把其它内容挤出去。所以定了两个上限：行数和字符宽度。
 *  截断后补一个省略号 '…'，让用户知道"后面还有"。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（.tsx 特有，Java 工程师最需要补的一块）
 * ---------------------------------------------------------------------------
 *  - `.tsx` 后缀 = 允许直接写 **JSX**（长得像 HTML 的标签）。
 *    它不是 HTML，而是 React 元素：`<Text>{command}</Text>` ≈ 构造一个组件节点。
 *    属性名用驼峰（`dimColor`），不是 HTML 的横杠写法。
 *  - `{expr}` 是 JSX 里的表达式插值 ≈ JSP 的 ${}。
 *  - `React.ReactNode` 返回类型：可以是 JSX 元素、字符串、null 的联合类型。
 *    返回 '' 或 null 都表示"什么都不渲染"。
 *  - `command.split('\n')`：按换行切成数组（≈ Java 的 String.split）。
 *  - `.slice(0, n)`：取前 n 个（≈ Java 的 subList(0, n)）。
 *  - `stringWidth(s)`：算字符串的**显示宽度**。
 *    ⚠️ 为什么不能直接用 s.length：中文/emoji 占两列宽，length 只数字符数。
 *    终端排版必须按显示宽度算，否则会串行 —— 这是终端 UI 的经典坑。
 *  - `const MAX_X = 2` 大写下划线命名的模块级常量 ≈ `private static final int`。
 *  - `const` vs `let`：const = 不可重新赋值（≈ final），let = 可重新赋值。
 *    注意 const 只锁"变量指向"，不锁对象内容（对象里的字段照样能改）。
 *  - 文件末尾那行 `//# sourceMappingURL=...` 是 sourcemap 数据，**不要动它**。
 */
import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Text } from '../../ink.js';
import { truncateToWidthNoEllipsis } from '../../utils/format.js';
import type { Output } from './TaskStopTool.js';
/**
 * 工具调用**发起时**显示什么。
 *
 * @returns 空串 —— 意思是"这一条不用在终端上显示"。
 *          为什么：停止任务是一个瞬时动作，发起时没什么可说的，
 *          等结果出来（下面那个函数）再一起显示就够了。
 *          返回 '' 而不是 null，是为了满足框架的 ReactNode 类型要求。
 */
export function renderToolUseMessage(): React.ReactNode {
  return '';
}
// 命令展示的两个上限：最多 2 行、最多 160 个显示宽度。
// 目的是防止一条超长 shell 命令把终端界面撑乱。
const MAX_COMMAND_DISPLAY_LINES = 2;
const MAX_COMMAND_DISPLAY_CHARS = 160;
/**
 * 把一条（可能很长的）命令截断成适合终端显示的长度。
 *
 * 为什么需要：后台任务的命令可能是几百字符的 shell 管道，不截断会把界面挤坏。
 *
 * @param command 原始命令文本。
 * @returns 截断后的文本（最多 2 行、最多 160 显示宽度，首尾无空白）。
 *
 * 关键步骤：
 *   ① 超过 2 行就只保留前 2 行（多余的整行丢掉）
 *   ② 还超过 160 个显示宽度就按宽度截断
 *      —— 注意用 stringWidth 而不是 length：中文和 emoji 占两列宽
 *   ③ trim 掉首尾空白后返回
 */
function truncateCommand(command: string): string {
  const lines = command.split('\n');
  let truncated = command;
  // 先按行数截断：只留前两行。
  if (lines.length > MAX_COMMAND_DISPLAY_LINES) {
    truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n');
  }
  // 再按**显示宽度**截断。必须 stringWidth(...) 而不是 .length：
  // 中文、emoji 在终端里占两列，按字符数算会导致实际宽度超标、界面串行。
  if (stringWidth(truncated) > MAX_COMMAND_DISPLAY_CHARS) {
    truncated = truncateToWidthNoEllipsis(truncated, MAX_COMMAND_DISPLAY_CHARS);
  }
  return truncated.trim();
}
/**
 * 工具调用**结束后**显示什么。
 *
 * @param output 工具返回值（含被停掉的 command）。
 * @param _progressMessagesForMessage 进度消息，本工具不用（下划线前缀 = 故意忽略）。
 * @param verbose 是否详细模式：**是的话显示完整命令，否则显示截断版**。
 * @returns React 节点。
 *
 * 关键步骤：
 *   ① 内部版本不显示（直接返回 null）
 *   ② 按 verbose 决定显示完整命令还是截断版
 *   ③ 如果命令被截断过，补一个 '…' 提示"后面还有"，再拼上 ' · stopped'
 */
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: unknown[], {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  // 内部版本（'ant'）不渲染这个结果 —— 不同发行渠道的展示差异。
  // 注意这个比较恒为 false（'external' === 'ant'），是构建时替换留下的痕迹。
  if ("external" === 'ant') {
    return null;
  }
  // `?? ''` 兜底：command 是可选字段，老 transcript 里可能没有（见 TaskStopTool.ts 的注释）。
  const rawCommand = output.command ?? '';
  // verbose（详细模式）下显示完整命令，否则截断 —— 把"看全不全"的选择权交给用户。
  const command = verbose ? rawCommand : truncateCommand(rawCommand);
  // 只有真的截断过才加省略号 '…'：没截断却显示省略号会误导用户以为内容被砍了。
  const suffix = command !== rawCommand ? '… · stopped' : ' · stopped';
  // JSX：把命令和后缀拼成一行文本节点。{command}{suffix} 两个插值会顺序渲染。
  return <MessageResponse>
      <Text>
        {command}
        {suffix}
      </Text>
    </MessageResponse>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsInN0cmluZ1dpZHRoIiwiVGV4dCIsInRydW5jYXRlVG9XaWR0aE5vRWxsaXBzaXMiLCJPdXRwdXQiLCJyZW5kZXJUb29sVXNlTWVzc2FnZSIsIlJlYWN0Tm9kZSIsIk1BWF9DT01NQU5EX0RJU1BMQVlfTElORVMiLCJNQVhfQ09NTUFORF9ESVNQTEFZX0NIQVJTIiwidHJ1bmNhdGVDb21tYW5kIiwiY29tbWFuZCIsImxpbmVzIiwic3BsaXQiLCJ0cnVuY2F0ZWQiLCJsZW5ndGgiLCJzbGljZSIsImpvaW4iLCJ0cmltIiwicmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2UiLCJvdXRwdXQiLCJfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJ2ZXJib3NlIiwicmF3Q29tbWFuZCIsInN1ZmZpeCJdLCJzb3VyY2VzIjpbIlVJLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL01lc3NhZ2VSZXNwb25zZS5qcydcbmltcG9ydCB7IHN0cmluZ1dpZHRoIH0gZnJvbSAnLi4vLi4vaW5rL3N0cmluZ1dpZHRoLmpzJ1xuaW1wb3J0IHsgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHRydW5jYXRlVG9XaWR0aE5vRWxsaXBzaXMgfSBmcm9tICcuLi8uLi91dGlscy9mb3JtYXQuanMnXG5pbXBvcnQgdHlwZSB7IE91dHB1dCB9IGZyb20gJy4vVGFza1N0b3BUb29sLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZU1lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuICcnXG59XG5cbmNvbnN0IE1BWF9DT01NQU5EX0RJU1BMQVlfTElORVMgPSAyXG5jb25zdCBNQVhfQ09NTUFORF9ESVNQTEFZX0NIQVJTID0gMTYwXG5cbmZ1bmN0aW9uIHRydW5jYXRlQ29tbWFuZChjb21tYW5kOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lcyA9IGNvbW1hbmQuc3BsaXQoJ1xcbicpXG4gIGxldCB0cnVuY2F0ZWQgPSBjb21tYW5kXG5cbiAgaWYgKGxpbmVzLmxlbmd0aCA+IE1BWF9DT01NQU5EX0RJU1BMQVlfTElORVMpIHtcbiAgICB0cnVuY2F0ZWQgPSBsaW5lcy5zbGljZSgwLCBNQVhfQ09NTUFORF9ESVNQTEFZX0xJTkVTKS5qb2luKCdcXG4nKVxuICB9XG5cbiAgaWYgKHN0cmluZ1dpZHRoKHRydW5jYXRlZCkgPiBNQVhfQ09NTUFORF9ESVNQTEFZX0NIQVJTKSB7XG4gICAgdHJ1bmNhdGVkID0gdHJ1bmNhdGVUb1dpZHRoTm9FbGxpcHNpcyh0cnVuY2F0ZWQsIE1BWF9DT01NQU5EX0RJU1BMQVlfQ0hBUlMpXG4gIH1cblxuICByZXR1cm4gdHJ1bmNhdGVkLnRyaW0oKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2UoXG4gIG91dHB1dDogT3V0cHV0LFxuICBfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2U6IHVua25vd25bXSxcbiAgeyB2ZXJib3NlIH06IHsgdmVyYm9zZTogYm9vbGVhbiB9LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgaWYgKFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgY29uc3QgcmF3Q29tbWFuZCA9IG91dHB1dC5jb21tYW5kID8/ICcnXG4gIGNvbnN0IGNvbW1hbmQgPSB2ZXJib3NlID8gcmF3Q29tbWFuZCA6IHRydW5jYXRlQ29tbWFuZChyYXdDb21tYW5kKVxuICBjb25zdCBzdWZmaXggPSBjb21tYW5kICE9PSByYXdDb21tYW5kID8gJ+KApiDCtyBzdG9wcGVkJyA6ICcgwrcgc3RvcHBlZCdcblxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICA8VGV4dD5cbiAgICAgICAge2NvbW1hbmR9XG4gICAgICAgIHtzdWZmaXh9XG4gICAgICA8L1RleHQ+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsZUFBZSxRQUFRLHFDQUFxQztBQUNyRSxTQUFTQyxXQUFXLFFBQVEsMEJBQTBCO0FBQ3RELFNBQVNDLElBQUksUUFBUSxjQUFjO0FBQ25DLFNBQVNDLHlCQUF5QixRQUFRLHVCQUF1QjtBQUNqRSxjQUFjQyxNQUFNLFFBQVEsbUJBQW1CO0FBRS9DLE9BQU8sU0FBU0Msb0JBQW9CQSxDQUFBLENBQUUsRUFBRU4sS0FBSyxDQUFDTyxTQUFTLENBQUM7RUFDdEQsT0FBTyxFQUFFO0FBQ1g7QUFFQSxNQUFNQyx5QkFBeUIsR0FBRyxDQUFDO0FBQ25DLE1BQU1DLHlCQUF5QixHQUFHLEdBQUc7QUFFckMsU0FBU0MsZUFBZUEsQ0FBQ0MsT0FBTyxFQUFFLE1BQU0sQ0FBQyxFQUFFLE1BQU0sQ0FBQztFQUNoRCxNQUFNQyxLQUFLLEdBQUdELE9BQU8sQ0FBQ0UsS0FBSyxDQUFDLElBQUksQ0FBQztFQUNqQyxJQUFJQyxTQUFTLEdBQUdILE9BQU87RUFFdkIsSUFBSUMsS0FBSyxDQUFDRyxNQUFNLEdBQUdQLHlCQUF5QixFQUFFO0lBQzVDTSxTQUFTLEdBQUdGLEtBQUssQ0FBQ0ksS0FBSyxDQUFDLENBQUMsRUFBRVIseUJBQXlCLENBQUMsQ0FBQ1MsSUFBSSxDQUFDLElBQUksQ0FBQztFQUNsRTtFQUVBLElBQUlmLFdBQVcsQ0FBQ1ksU0FBUyxDQUFDLEdBQUdMLHlCQUF5QixFQUFFO0lBQ3RESyxTQUFTLEdBQUdWLHlCQUF5QixDQUFDVSxTQUFTLEVBQUVMLHlCQUF5QixDQUFDO0VBQzdFO0VBRUEsT0FBT0ssU0FBUyxDQUFDSSxJQUFJLENBQUMsQ0FBQztBQUN6QjtBQUVBLE9BQU8sU0FBU0MsdUJBQXVCQSxDQUNyQ0MsTUFBTSxFQUFFZixNQUFNLEVBQ2RnQiwyQkFBMkIsRUFBRSxPQUFPLEVBQUUsRUFDdEM7RUFBRUM7QUFBOEIsQ0FBckIsRUFBRTtFQUFFQSxPQUFPLEVBQUUsT0FBTztBQUFDLENBQUMsQ0FDbEMsRUFBRXRCLEtBQUssQ0FBQ08sU0FBUyxDQUFDO0VBQ2pCLElBQUksVUFBVSxLQUFLLEtBQUssRUFBRTtJQUN4QixPQUFPLElBQUk7RUFDYjtFQUVBLE1BQU1nQixVQUFVLEdBQUdILE1BQU0sQ0FBQ1QsT0FBTyxJQUFJLEVBQUU7RUFDdkMsTUFBTUEsT0FBTyxHQUFHVyxPQUFPLEdBQUdDLFVBQVUsR0FBR2IsZUFBZSxDQUFDYSxVQUFVLENBQUM7RUFDbEUsTUFBTUMsTUFBTSxHQUFHYixPQUFPLEtBQUtZLFVBQVUsR0FBRyxhQUFhLEdBQUcsWUFBWTtFQUVwRSxPQUNFLENBQUMsZUFBZTtBQUNwQixNQUFNLENBQUMsSUFBSTtBQUNYLFFBQVEsQ0FBQ1osT0FBTztBQUNoQixRQUFRLENBQUNhLE1BQU07QUFDZixNQUFNLEVBQUUsSUFBSTtBQUNaLElBQUksRUFBRSxlQUFlLENBQUM7QUFFdEIiLCJpZ25vcmVMaXN0IjpbXX0=