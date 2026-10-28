/**
 * ============================================================================
 *  【文件总览】src/tools/WebFetchTool/UI.tsx —— WebFetch 的「终端界面渲染层」
 * ============================================================================
 *
 *  【一句话定位】
 *  四个纯函数，负责把 WebFetch 的"调用中 / 已完成"两种状态画成终端上的几行字。
 *  它不抓网页、不做判断，只做**展示**。
 *
 *  【在架构中的位置】
 *      主循环执行 WebFetchTool
 *        ├─ 工具被调用、还没结果时 → renderToolUseMessage()      ← ★ 本文件
 *        ├─ 正在抓取中（流式进度） → renderToolUseProgressMessage() ← ★ 本文件
 *        ├─ 抓取完成               → renderToolResultMessage()     ← ★ 本文件
 *        └─ 侧边栏/摘要里要显示一行 → getToolUseSummary()          ← ★ 本文件
 *      这些函数由 WebFetchTool.ts 通过 `renderToolUseMessage` 等字段注册，
 *      由 UI 框架（ink）在合适的时机回调。
 *
 *  【本文件包含什么】
 *   1. renderToolUseMessage()           "url: xxx"（verbose 时还带 prompt）
 *   2. renderToolUseProgressMessage()   抓取中的 "Fetching…"
 *   3. renderToolResultMessage()        "Received 12.3 KB (200 OK)"（verbose 时附带正文）
 *   4. getToolUseSummary()              给其他地方用的单行摘要（截断过的 URL）
 *
 *  【必须理解的 TS/React 概念（Java 工程师最容易懵的地方）】
 *   - `.tsx` 后缀 = 这个文件里可以写 **JSX**。
 *     JSX 就是"在 JS 代码里直接写标签"，如 `<Text>Hello</Text>`。
 *     ≈ Java 里没有；最接近的是 Android 的 XML 布局，但 JSX 是**编译成函数调用**
 *       的表达式，可以出现在任意表达式位置（if 里、return 里、变量赋值里）。
 *   - `React.ReactNode`  返回类型：可以是 JSX 元素、字符串、数字、null……
 *     ≈ Java 的 Object，但专指"可渲染的东西"。返回 null = 什么都不画。
 *   - `<Box flexDirection="column">` `<Text dimColor>` 是 **ink** 的组件：
 *     用 React 的方式画**终端 UI**（类似 Java 的 lanterna / 字符界面库）。
 *     Box ≈ 带 flex 布局的容器（div），Text ≈ 文本节点（span）。
 *   - 为什么这里用 React 画终端？因为可以复用 React 的组件模型和状态管理，
 *     用 flexbox 思维排版字符界面，比手工拼字符串好维护得多。
 *
 *  【TS 语法速查】（本文件实际出现的）
 *   - `Partial<{ url: string; prompt: string }>`
 *                                 把类型所有字段变成可选。
 *                                 ≈ Java 里没有；理解为"这个对象的字段可能没填"
 *                                 （因为模型流式输出时参数可能才吐了一半）
 *   - `verbose: boolean` 类型的第二个参数：控制"要不要显示详细信息"
 *   - `X | undefined | null` 联合类型；`!url` 一次性排除 null/undefined/''/0
 *                                 （JS 的 falsy 判断，Java 没有这套隐式转换）
 *   - `input?.url` 可选链     ≈ `input != null ? input.url : null`
 *   - `` `url: "${url}"` ``   模板字符串，可直接嵌变量
 *   - `cond ? a : b` 三元     和 Java 一样
 *   - `height={1}` / `dimColor`  JSX 属性。注意 `height={1}` 的 `{}` 里是
 *                                 **JS 表达式**（数字 1），而 `dimColor` 不带值
 *                                 等价于 `dimColor={true}`（布尔属性简写）
 *   - 文件末尾那行 `//# sourceMappingURL=...` 是构建产物留下的源映射，别动它
 * ============================================================================
 */
import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js';
import { Box, Text } from '../../ink.js';
import type { ToolProgressData } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import { formatFileSize, truncate } from '../../utils/format.js';
import type { Output } from './WebFetchTool.js';
/**
 * 渲染「工具被调用」这一刻的一行字。
 *
 * 【做什么】非 verbose 时只显示 URL；verbose 时显示 `url: "xxx", prompt: "yyy"`。
 * 【为什么需要】模型发起调用、结果还没回来时，用户需要知道"它要去抓哪个网址"。
 *              这是**授权感知**的一部分——用户看到陌生域名会警觉。
 * 【入参】第一个参数解构出 url / prompt，类型是 Partial（字段可能还没填完，
 *        因为模型是流式吐参数的）；第二个参数是 { verbose } 显示详细程度开关
 * 【返回】React.ReactNode：字符串，或 null（表示"没什么可画"）
 * 【关键步骤】
 *   ① url 还没有 → 返回 null（不画任何东西，等参数吐完）
 *   ② verbose → 拼出带 prompt 的完整信息
 *   ③ 否则只返回 url 本身（终端空间宝贵，默认只给最关键的信息）
 */
export function renderToolUseMessage({
  url,
  prompt
}: Partial<{
  url: string;
  prompt: string;
}>, {
  verbose
}: {
  theme?: string;
  verbose: boolean;
}): React.ReactNode {
  if (!url) {
    return null;
  }
  if (verbose) {
    return `url: "${url}"${verbose && prompt ? `, prompt: "${prompt}"` : ''}`;
  }
  return url;
}
/**
 * 渲染「正在抓取中」的进度提示。
 *
 * 【做什么】返回一行灰色的 "Fetching…"。
 * 【为什么需要】抓一个网页可能要好几秒（还有域名预检、可能的重定向），
 *              没有进度提示的话用户会以为程序卡死了。
 *              这是所有耗时工具都需要的"正在进行中"反馈。
 * 【入参】无（这个阶段还没有任何数据可展示）
 * 【返回】JSX：一个高度为 1 行的灰色文本
 * 【语法】`<Text dimColor>` 的 dimColor 是布尔属性简写 = `dimColor={true}`；
 *        `height={1}` 的大括号里是 JS 表达式（数字 1，不是字符串 "1"）
 */
export function renderToolUseProgressMessage(): React.ReactNode {
  return <MessageResponse height={1}>
      <Text dimColor>Fetching…</Text>
    </MessageResponse>;
}
/**
 * 渲染「抓取完成」的结果行。
 *
 * 【做什么】显示 `Received 12.3 KB (200 OK)`；
 *          verbose 模式下再额外把正文（result）整段打印出来。
 * 【为什么需要——注意这里的**信息分层**设计】
 *   默认只显示大小和状态码，**不显示正文**。
 *   因为 result 是已经交给主模型的内容，再在终端刷一遍会占用大量屏幕，
 *   喧宾夺主。verbose（Ctrl+R 之类的详细模式）才展开给用户核对。
 *   这个"默认给摘要、详细模式给全文"的分层在本仓库所有工具里是一致的。
 * 【入参】第一个参数是 Output（bytes / code / codeText / result）；
 *        第二个参数 _progressMessagesForMessage 未使用
 *        （下划线前缀 = "我知道它没用到"，避免编译器报未使用变量警告）
 * 【返回】JSX：一行摘要，或"摘要 + 正文"的纵向排列
 * 【语法】`<Box flexDirection="column">` 是纵向 flex 容器，
 *        里面两个子元素会上下排列（≈ CSS 的 flex-direction: column）
 */
export function renderToolResultMessage({
  bytes,
  code,
  codeText,
  result
}: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  const formattedSize = formatFileSize(bytes);
  if (verbose) {
    return <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            Received <Text bold>{formattedSize}</Text> ({code} {codeText})
          </Text>
        </MessageResponse>
        <Box flexDirection="column">
          <Text>{result}</Text>
        </Box>
      </Box>;
  }
  return <MessageResponse height={1}>
      <Text>
        Received <Text bold>{formattedSize}</Text> ({code} {codeText})
      </Text>
    </MessageResponse>;
}
/**
 * 生成一行简短摘要（给侧边栏、活动状态等"只放得下一行"的地方用）。
 *
 * 【做什么】把 URL 截断到 TOOL_SUMMARY_MAX_LENGTH 后返回；没 URL 就返回 null。
 * 【为什么需要】和 renderToolUseMessage 的区别：这个是**纯字符串**，
 *              不是 React 节点——因为调用方（如 getActivityDescription）
 *              可能要把这段文字拼进日志、状态栏、遥测里，不需要渲染能力。
 * 【入参】input 可能整个是 undefined（所以类型写成 `... | undefined`，
 *        并且用 `input?.url` 可选链去取）
 * 【返回】string | null
 * 【语法】`input?.url` 可选链：input 为 null/undefined 时整个表达式直接得
 *        undefined，不会抛 NPE。≈ Java 的 `input != null ? input.url : null`
 */
export function getToolUseSummary(input: Partial<{
  url: string;
  prompt: string;
}> | undefined): string | null {
  if (!input?.url) {
    return null;
  }
  return truncate(input.url, TOOL_SUMMARY_MAX_LENGTH);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsIlRPT0xfU1VNTUFSWV9NQVhfTEVOR1RIIiwiQm94IiwiVGV4dCIsIlRvb2xQcm9ncmVzc0RhdGEiLCJQcm9ncmVzc01lc3NhZ2UiLCJmb3JtYXRGaWxlU2l6ZSIsInRydW5jYXRlIiwiT3V0cHV0IiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJ1cmwiLCJwcm9tcHQiLCJQYXJ0aWFsIiwidmVyYm9zZSIsInRoZW1lIiwiUmVhY3ROb2RlIiwicmVuZGVyVG9vbFVzZVByb2dyZXNzTWVzc2FnZSIsInJlbmRlclRvb2xSZXN1bHRNZXNzYWdlIiwiYnl0ZXMiLCJjb2RlIiwiY29kZVRleHQiLCJyZXN1bHQiLCJfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJmb3JtYXR0ZWRTaXplIiwiZ2V0VG9vbFVzZVN1bW1hcnkiLCJpbnB1dCJdLCJzb3VyY2VzIjpbIlVJLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL01lc3NhZ2VSZXNwb25zZS5qcydcbmltcG9ydCB7IFRPT0xfU1VNTUFSWV9NQVhfTEVOR1RIIH0gZnJvbSAnLi4vLi4vY29uc3RhbnRzL3Rvb2xMaW1pdHMuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgdHlwZSB7IFRvb2xQcm9ncmVzc0RhdGEgfSBmcm9tICcuLi8uLi9Ub29sLmpzJ1xuaW1wb3J0IHR5cGUgeyBQcm9ncmVzc01lc3NhZ2UgfSBmcm9tICcuLi8uLi90eXBlcy9tZXNzYWdlLmpzJ1xuaW1wb3J0IHsgZm9ybWF0RmlsZVNpemUsIHRydW5jYXRlIH0gZnJvbSAnLi4vLi4vdXRpbHMvZm9ybWF0LmpzJ1xuaW1wb3J0IHR5cGUgeyBPdXRwdXQgfSBmcm9tICcuL1dlYkZldGNoVG9vbC5qcydcblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VNZXNzYWdlKFxuICB7IHVybCwgcHJvbXB0IH06IFBhcnRpYWw8eyB1cmw6IHN0cmluZzsgcHJvbXB0OiBzdHJpbmcgfT4sXG4gIHsgdmVyYm9zZSB9OiB7IHRoZW1lPzogc3RyaW5nOyB2ZXJib3NlOiBib29sZWFuIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAoIXVybCkge1xuICAgIHJldHVybiBudWxsXG4gIH1cbiAgaWYgKHZlcmJvc2UpIHtcbiAgICByZXR1cm4gYHVybDogXCIke3VybH1cIiR7dmVyYm9zZSAmJiBwcm9tcHQgPyBgLCBwcm9tcHQ6IFwiJHtwcm9tcHR9XCJgIDogJyd9YFxuICB9XG4gIHJldHVybiB1cmxcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VQcm9ncmVzc01lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICA8VGV4dCBkaW1Db2xvcj5GZXRjaGluZ+KApjwvVGV4dD5cbiAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2UoXG4gIHsgYnl0ZXMsIGNvZGUsIGNvZGVUZXh0LCByZXN1bHQgfTogT3V0cHV0LFxuICBfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2U6IFByb2dyZXNzTWVzc2FnZTxUb29sUHJvZ3Jlc3NEYXRhPltdLFxuICB7IHZlcmJvc2UgfTogeyB2ZXJib3NlOiBib29sZWFuIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBmb3JtYXR0ZWRTaXplID0gZm9ybWF0RmlsZVNpemUoYnl0ZXMpXG4gIGlmICh2ZXJib3NlKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgICAgPFRleHQ+XG4gICAgICAgICAgICBSZWNlaXZlZCA8VGV4dCBib2xkPntmb3JtYXR0ZWRTaXplfTwvVGV4dD4gKHtjb2RlfSB7Y29kZVRleHR9KVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICAgIDxUZXh0PntyZXN1bHR9PC9UZXh0PlxuICAgICAgICA8L0JveD5cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2UgaGVpZ2h0PXsxfT5cbiAgICAgIDxUZXh0PlxuICAgICAgICBSZWNlaXZlZCA8VGV4dCBib2xkPntmb3JtYXR0ZWRTaXplfTwvVGV4dD4gKHtjb2RlfSB7Y29kZVRleHR9KVxuICAgICAgPC9UZXh0PlxuICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRUb29sVXNlU3VtbWFyeShcbiAgaW5wdXQ6IFBhcnRpYWw8eyB1cmw6IHN0cmluZzsgcHJvbXB0OiBzdHJpbmcgfT4gfCB1bmRlZmluZWQsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFpbnB1dD8udXJsKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuICByZXR1cm4gdHJ1bmNhdGUoaW5wdXQudXJsLCBUT09MX1NVTU1BUllfTUFYX0xFTkdUSClcbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsZUFBZSxRQUFRLHFDQUFxQztBQUNyRSxTQUFTQyx1QkFBdUIsUUFBUSwrQkFBK0I7QUFDdkUsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxjQUFjQyxnQkFBZ0IsUUFBUSxlQUFlO0FBQ3JELGNBQWNDLGVBQWUsUUFBUSx3QkFBd0I7QUFDN0QsU0FBU0MsY0FBYyxFQUFFQyxRQUFRLFFBQVEsdUJBQXVCO0FBQ2hFLGNBQWND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