/**
 * ============================================================================
 *  【文件总览】src/tools/ListMcpResourcesTool/UI.tsx —— 结果怎么画到终端
 * ============================================================================
 *
 *  【一句话定位】
 *  只有两个渲染函数：一个画「即将调用」那一行，一个画「返回结果」。
 *  本文件极简，是全仓库里最容易读的 UI 之一，适合作为**第一个**读的 .tsx 文件。
 *
 *  【读前须知：本文件是 React Compiler 的编译产物】
 *  证据：末尾那行 `//# sourceMappingURL=data:application/json;base64,...`
 *  （sourcemap 直接内联在文件末尾）。真正的源码是同名的 UI.tsx。
 *  本文件比 MCPTool/UI.tsx 简单得多，因为没有 `_c(...)` 缓存槽位
 *  —— 编译器判断这两个函数太简单，不值得做记忆化（memoization）。
 *
 *  【在架构中的位置】
 *      src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts
 *        ├─ renderToolUseMessage()     ← ★ 本文件
 *        └─ renderToolResultMessage()  ← ★ 本文件
 *              └─ OutputLine           ← src/components/shell/OutputLine.js
 *                                        （通用的「带截断 + 可展开」的文本渲染组件）
 *
 *  与 src/services/mcp/ 的关系：本文件**完全不碰** MCP，
 *  它只消费 ListMcpResourcesTool.ts 已经拿到的 Output 数据。
 *
 *  【本文件包含什么】
 *   renderToolUseMessage(input)
 *       有 server → `List MCP resources from server "myserver"`
 *       无 server → `List all MCP resources`
 *   renderToolResultMessage(output, _progressMessages, { verbose })
 *       空 → 灰字 `(No resources found)`
 *       非空 → 把整个数组 pretty-print 成缩进 2 格的 JSON，交给 OutputLine
 *
 *  【TS / TSX 语法速查（Java 工程师视角）】
 *   - `.tsx` 后缀        允许写 JSX（长得像 HTML 的标签语法）。
 *   - JSX `<Text dimColor>...</Text>`
 *                        `dimColor` 是无参布尔属性，写 `<Text dimColor>` 等价于
 *                        `<Text dimColor={true}>`。
 *                        ≈ 传一个构造参数为 true。
 *   - `<MessageResponse height={1}>`
 *                        height={1} 表示「只占终端的一行」，超出就截断。
 *                        为什么要限制高度？终端屏幕宝贵，工具结果默认不能刷屏。
 *                        ≈ Java 里给组件设置一个最大行数属性。
 *
 *   - `React.ReactNode`  返回类型：「可以被 React 渲染的任何东西」
 *                        （元素 / 字符串 / null / 数组）。≈ Java 里返回 Object，
 *                        但语义上是「一段 UI」。
 *
 *   - `Partial<{ server?: string }>`
 *                        `Partial<T>` 把 T 的所有字段变成可选。
 *                        这里 T 本来 server 就已经是可选了，再套一层 Partial 是
 *                        「双保险」：即使将来 T 变成必填，这里也不会因为缺字段而报错。
 *                        ≈ Java 里写一个所有字段都可空的 DTO。
 *
 *   - `input.server ? A : B`  三元运算符。
 *                        注意这里用的是**真值判断**而不是 `!== undefined`：
 *                        空字符串 '' 也会被当成「没填 server」，
 *                        从而显示 "List all MCP resources" —— 这正是期望的行为。
 *
 *   - `` `List MCP resources from server "${input.server}"` ``
 *                        模板字符串插值。≈ String.format("... \"%s\"", server)。
 *
 *   - `jsonStringify(output, null, 2)`
 *                        第三个参数 2 = 缩进 2 个空格（pretty-print）。
 *                        ≈ Java 里 new GsonBuilder().setPrettyPrinting().create()。
 *                        为什么结果要 pretty-print？因为这是给**人**看的终端输出，
 *                        而 mapToolResultToToolResultBlockParam（在 ListMcpResourcesTool.ts）
 *                        里给**模型**的那份是紧凑的 jsonStringify(content) —— 省 token。
 *                        同一份数据、两种序列化，各取所需。
 *
 *   - `// eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result`
 *                        ESLint 的**行内禁用**指令，`--` 后面是**必须写的原因**。
 *                        为什么这里要禁用？因为项目规定「不允许直接 JSON.stringify」
 *                        （统一用 utils 里的 jsonStringify 以获得稳定的键顺序），
 *                        但这条规则针对的是**给模型的 tool_result**，
 *                        而这里是给人看的 UI，需要 pretty-print，所以开个例外。
 *                        ≈ Java 的 @SuppressWarnings("...")，但强制要求写明理由。
 *
 *   - `_progressMessagesForMessage`  下划线前缀 = 故意不用的参数
 *                        （列出 resource 是个瞬时操作，没有中间进度可显示）。
 */

import * as React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { OutputLine } from '../../components/shell/OutputLine.js';
import { Text } from '../../ink.js';
import type { ToolProgressData } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import type { Output } from './ListMcpResourcesTool.js';
/**
 * 【中文补充】渲染「工具即将被调用」那一行。
 *
 * 为什么要分两种措辞？因为它直接反映了 call() 里的两种行为：
 *   - 填了 server → 只查那一个 server，所以显示它的名字让用户确认
 *   - 没填      → 查所有 server，显示 "List all MCP resources"
 * 用户扫一眼就知道这次调用的范围有多大（是查 1 个还是查 5 个 server）。
 *
 * @param input 入参（server 可选；用 Partial 是因为流式解析时字段可能还没到齐）
 * @returns 一行文本
 */
export function renderToolUseMessage(input: Partial<{
  server?: string;
}>): React.ReactNode {
  return input.server ? `List MCP resources from server "${input.server}"` : `List all MCP resources`;
}
/**
 * 【中文补充】渲染「工具返回后的结果」。
 *
 * 两条分支：
 *   ① 空结果 → 灰字 `(No resources found)`，只占一行。
 *      为什么不显示空 JSON `[]`？因为 `[]` 对人不友好，
 *      而一句明确的话能让用户立刻明白「这个 server 没有 resource」。
 *   ② 有结果 → pretty-print 成缩进 2 格的 JSON，交给 OutputLine。
 *      OutputLine 会负责：按终端宽度换行、超长时截断、（非 verbose 时）折叠。
 *
 * @param output                      resource 数组
 * @param _progressMessagesForMessage 进度消息（本工具没有进度，故意忽略）
 * @param verbose                     true 时完整展开，false 时由 OutputLine 折叠
 * @returns React 元素
 */
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!output || output.length === 0) {
    return <MessageResponse height={1}>
        <Text dimColor>(No resources found)</Text>
      </MessageResponse>;
  }

  // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
  const formattedOutput = jsonStringify(output, null, 2);
  return <OutputLine content={formattedOutput} verbose={verbose} />;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsIk91dHB1dExpbmUiLCJUZXh0IiwiVG9vbFByb2dyZXNzRGF0YSIsIlByb2dyZXNzTWVzc2FnZSIsImpzb25TdHJpbmdpZnkiLCJPdXRwdXQiLCJyZW5kZXJUb29sVXNlTWVzc2FnZSIsImlucHV0IiwiUGFydGlhbCIsInNlcnZlciIsIlJlYWN0Tm9kZSIsInJlbmRlclRvb2xSZXN1bHRNZXNzYWdlIiwib3V0cHV0IiwiX3Byb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlIiwidmVyYm9zZSIsImxlbmd0aCIsImZvcm1hdHRlZE91dHB1dCJdLCJzb3VyY2VzIjpbIlVJLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvTWVzc2FnZVJlc3BvbnNlLmpzJ1xuaW1wb3J0IHsgT3V0cHV0TGluZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvc2hlbGwvT3V0cHV0TGluZS5qcydcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgdHlwZSB7IFRvb2xQcm9ncmVzc0RhdGEgfSBmcm9tICcuLi8uLi9Ub29sLmpzJ1xuaW1wb3J0IHR5cGUgeyBQcm9ncmVzc01lc3NhZ2UgfSBmcm9tICcuLi8uLi90eXBlcy9tZXNzYWdlLmpzJ1xuaW1wb3J0IHsganNvblN0cmluZ2lmeSB9IGZyb20gJy4uLy4uL3V0aWxzL3Nsb3dPcGVyYXRpb25zLmpzJ1xuaW1wb3J0IHR5cGUgeyBPdXRwdXQgfSBmcm9tICcuL0xpc3RNY3BSZXNvdXJjZXNUb29sLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZU1lc3NhZ2UoXG4gIGlucHV0OiBQYXJ0aWFsPHsgc2VydmVyPzogc3RyaW5nIH0+LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIGlucHV0LnNlcnZlclxuICAgID8gYExpc3QgTUNQIHJlc291cmNlcyBmcm9tIHNlcnZlciBcIiR7aW5wdXQuc2VydmVyfVwiYFxuICAgIDogYExpc3QgYWxsIE1DUCByZXNvdXJjZXNgXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShcbiAgb3V0cHV0OiBPdXRwdXQsXG4gIF9wcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZTogUHJvZ3Jlc3NNZXNzYWdlPFRvb2xQcm9ncmVzc0RhdGE+W10sXG4gIHsgdmVyYm9zZSB9OiB7IHZlcmJvc2U6IGJvb2xlYW4gfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGlmICghb3V0cHV0IHx8IG91dHB1dC5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gKFxuICAgICAgPE1lc3NhZ2VSZXNwb25zZSBoZWlnaHQ9ezF9PlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj4oTm8gcmVzb3VyY2VzIGZvdW5kKTwvVGV4dD5cbiAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgIClcbiAgfVxuXG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1yZXN0cmljdGVkLXN5bnRheCAtLSBodW1hbi1mYWNpbmcgVUksIG5vdCB0b29sX3Jlc3VsdFxuICBjb25zdCBmb3JtYXR0ZWRPdXRwdXQgPSBqc29uU3RyaW5naWZ5KG91dHB1dCwgbnVsbCwgMilcblxuICByZXR1cm4gPE91dHB1dExpbmUgY29udGVudD17Zm9ybWF0dGVkT3V0cHV0fSB2ZXJib3NlPXt2ZXJib3NlfSAvPlxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLGVBQWUsUUFBUSxxQ0FBcUM7QUFDckUsU0FBU0MsVUFBVSxRQUFRLHNDQUFzQztBQUNqRSxTQUFTQyxJQUFJLFFBQVEsY0FBYztBQUNuQyxjQUFjQyxnQkFBZ0IsUUFBUSxlQUFlO0FBQ3JELGNBQWNDLGVBQWUsUUFBUSx3QkFBd0I7QUFDN0QsU0FBU0MsYUFBYSxRQUFRLCtCQUErQjtBQUM3RCxjQUFjQyxNQUFNLFFBQVEsMkJBQTJCO0FBRXZELE9BQU8sU0FBU0Msb0JBQW9CQSxDQUNsQ0MsS0FBSyxFQUFFQyxPQUFPLENBQUM7RUFBRUMsTUFBTSxDQUFDLEVBQUUsTUFBTTtBQUFDLENBQUMsQ0FBQyxDQUNwQyxFQUFFWCxLQUFLLENBQUNZLFNBQVMsQ0FBQztFQUNqQixPQUFPSCxLQUFLLENBQUNFLE1BQU0sR0FDZixtQ0FBbUNGLEtBQUssQ0FBQ0UsTUFBTSxHQUFHLEdBQ2xELHdCQUF3QjtBQUM5QjtBQUVBLE9BQU8sU0FBU0UsdUJBQXVCQSxDQUNyQ0MsTUFBTSxFQUFFUCxNQUFNLEVBQ2RRLDJCQUEyQixFQUFFVixlQUFlLENBQUNELGdCQUFnQixDQUFDLEVBQUUsRUFDaEU7RUFBRVk7QUFBOEIsQ0FBckIsRUFBRTtFQUFFQSxPQUFPLEVBQUUsT0FBTztBQUFDLENBQUMsQ0FDbEMsRUFBRWhCLEtBQUssQ0FBQ1ksU0FBUyxDQUFDO0VBQ2pCLElBQUksQ0FBQ0UsTUFBTSxJQUFJQSxNQUFNLENBQUNHLE1BQU0sS0FBSyxDQUFDLEVBQUU7SUFDbEMsT0FDRSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakMsUUFBUSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsb0JBQW9CLEVBQUUsSUFBSTtBQUNqRCxNQUFNLEVBQUUsZUFBZSxDQUFDO0VBRXRCOztFQUVBO0VBQ0EsTUFBTUMsZUFBZSxHQUFHWixhQUFhLENBQUNRLE1BQU0sRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0VBRXRELE9BQU8sQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLENBQUNJLGVBQWUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDRixPQUFPLENBQUMsR0FBRztBQUNuRSIsImlnbm9yZUxpc3QiOltdfQ==