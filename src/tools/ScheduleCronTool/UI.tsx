/**
 * ============================================================================
 *  【文件总览】src/tools/ScheduleCronTool/UI.tsx
 *              —— 三个 cron 工具在终端里的显示（React 渲染层）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件决定 CronCreate / CronDelete / CronList 三个工具在终端上显示什么。
 *  一共 6 个函数（每个工具两个：调用时 + 结果时），没有任何业务逻辑。
 *
 *  【在架构中的位置】
 *      CronCreateTool.ts → renderCreateToolUseMessage / renderCreateResultMessage
 *      CronDeleteTool.ts → renderDeleteToolUseMessage / renderDeleteResultMessage
 *      CronListTool.ts   → renderListToolUseMessage   / renderListResultMessage
 *                                                      ← ★ 你在这里
 *
 *  【为什么一个文件放三组？】
 *  这三个工具是同一套功能的三个动作，UI 都很短（几行），
 *  合成一个文件比拆成三个 UI.tsx 更好维护。文件里用注释分隔成了三个区块。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（.tsx 特有，Java 工程师最需要补的一块）
 * ---------------------------------------------------------------------------
 *  - `.tsx` 后缀 = 允许直接写 **JSX**（长得像 HTML 的标签）。它不是 HTML，
 *    而是 React 元素：`<Text bold>{output.id}</Text>` ≈ 构造一个组件节点。
 *    属性名用驼峰（`dimColor`、`flexDirection`），不是 HTML 的横杠写法。
 *  - `React.ReactNode` 返回类型：可以是 JSX 元素、字符串、null 的联合类型。
 *    返回字符串（如本文件大部分函数）也是合法的 —— React 会当纯文本渲染。
 *  - `Partial<{ cron: string; prompt: string }>`：把字段全部变成可选。
 *    ≈ 生成一个所有字段可空的 DTO。
 *    为什么这里要用：渲染发生在模型**流式输出**期间，参数可能才打了一半。
 *  - `??` 空值合并：`input.cron ?? ''` —— 字段还没流出来时兜底成空串。
 *    ⚠️ 与 `||` 区别：`''` 和 `0` 不会被 `??` 换掉，但会被 `||` 换掉。
 *    这里用 `??` 更准确：**只**在 null/undefined 时兜底。
 *  - `X ? A : B` 三元 ≈ Java 三目运算符；本文件嵌套着用。
 *  - `.map(j => <Text key={j.id}>...)`：
 *    `key` 是 React 的**必需**属性 —— 列表渲染时用它做身份标识，
 *    没有它 React 无法高效地做增量更新（≈ RecyclerView 需要稳定的 item id）。
 *  - `<Text>{' '}</Text>`：JSX 里直接写空格会被忽略，必须这样显式插入。
 *  - 文件末尾的 `//# sourceMappingURL=...` 是 sourcemap 数据，**不要动它**。
 */
import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Text } from '../../ink.js';
import { truncate } from '../../utils/format.js';
import type { CreateOutput } from './CronCreateTool.js';
import type { DeleteOutput } from './CronDeleteTool.js';
import type { ListOutput } from './CronListTool.js';

// ── CronCreate 的渲染 ───────────────────────────────────────────────
// --- CronCreate -------------------------------------------------------------

/**
 * CronCreate 调用**发起时**显示什么：`cron表达式: prompt前60字符`。
 * 例：`*/5 * * * *: 检查一下部署状态`
 *
 * 为什么要截断 prompt：这一行是给用户快速扫一眼的，完整内容在结果里看。
 */
export function renderCreateToolUseMessage(input: Partial<{
  cron: string;
  prompt: string;
}>): React.ReactNode {
  // `?? ''` 兜底：流式输出期间字段可能还没到。
  // truncate(input.prompt, 60, true)：截断到 60 字符，第三个参数 true 表示加省略号。
  return `${input.cron ?? ''}${input.prompt ? `: ${truncate(input.prompt, 60, true)}` : ''}`;
}
/**
 * CronCreate **出结果后**显示什么：`Scheduled <id> (每 5 分钟)`。
 * humanSchedule 是给人看的时间描述（由 cronToHuman 从 cron 表达式翻过来）。
 */
export function renderCreateResultMessage(output: CreateOutput): React.ReactNode {
  return <MessageResponse>
      <Text>
        Scheduled <Text bold>{output.id}</Text>{' '}
        <Text dimColor>({output.humanSchedule})</Text>
      </Text>
    </MessageResponse>;
}

// ── CronDelete 的渲染 ───────────────────────────────────────────────
// --- CronDelete -------------------------------------------------------------

/**
 * CronDelete 调用发起时显示什么：就显示要删的那个 job id。
 * 为什么不用更花哨的：删除动作的关键信息就是"删的是哪个"，直给最清楚。
 */
export function renderDeleteToolUseMessage(input: Partial<{
  id: string;
}>): React.ReactNode {
  return input.id ?? '';
}
/**
 * CronDelete 出结果后显示什么：`Cancelled <id>`。
 */
export function renderDeleteResultMessage(output: DeleteOutput): React.ReactNode {
  return <MessageResponse>
      <Text>
        Cancelled <Text bold>{output.id}</Text>
      </Text>
    </MessageResponse>;
}

// ── CronList 的渲染 ─────────────────────────────────────────────────
// --- CronList ---------------------------------------------------------------

/**
 * CronList 调用发起时显示什么：空串（用框架默认样式）。
 * 列任务没有值得一提的入参（入参本来就是空的）。
 */
export function renderListToolUseMessage(): React.ReactNode {
  return '';
}
/**
 * CronList 出结果后显示什么：每个任务一行（id + 人话时间），没有就显示 "No scheduled jobs"。
 *
 * 为什么要特判空列表：返回一片空白会让用户以为工具坏了，
 * 明确写一句"没有定时任务"体验好得多。
 */
export function renderListResultMessage(output: ListOutput): React.ReactNode {
  // 空列表特判：给一句明确的话，而不是什么都不显示。
  if (output.jobs.length === 0) {
    return <MessageResponse>
        <Text dimColor>No scheduled jobs</Text>
      </MessageResponse>;
  }
  // 非空：逐个渲染。
  return <MessageResponse>
    // `key={j.id}` 是 React 列表渲染的**必需**属性：
    // 它让 React 能认出"哪一行是哪一行"，从而做高效的增量更新。
    // 没有 key（或用数组下标当 key）在数据顺序变化时会出各种奇怪的 bug。
      {output.jobs.map(j => <Text key={j.id}>
          <Text bold>{j.id}</Text> <Text dimColor>{j.humanSchedule}</Text>
        </Text>)}
    </MessageResponse>;
}

// --- Shared -----------------------------------------------------------------
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsIlRleHQiLCJ0cnVuY2F0ZSIsIkNyZWF0ZU91dHB1dCIsIkRlbGV0ZU91dHB1dCIsIkxpc3RPdXRwdXQiLCJyZW5kZXJDcmVhdGVUb29sVXNlTWVzc2FnZSIsImlucHV0IiwiUGFydGlhbCIsImNyb24iLCJwcm9tcHQiLCJSZWFjdE5vZGUiLCJyZW5kZXJDcmVhdGVSZXN1bHRNZXNzYWdlIiwib3V0cHV0IiwiaWQiLCJodW1hblNjaGVkdWxlIiwicmVuZGVyRGVsZXRlVG9vbFVzZU1lc3NhZ2UiLCJyZW5kZXJEZWxldGVSZXN1bHRNZXNzYWdlIiwicmVuZGVyTGlzdFRvb2xVc2VNZXNzYWdlIiwicmVuZGVyTGlzdFJlc3VsdE1lc3NhZ2UiLCJqb2JzIiwibGVuZ3RoIiwibWFwIiwiaiJdLCJzb3VyY2VzIjpbIlVJLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL01lc3NhZ2VSZXNwb25zZS5qcydcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyB0cnVuY2F0ZSB9IGZyb20gJy4uLy4uL3V0aWxzL2Zvcm1hdC5qcydcbmltcG9ydCB0eXBlIHsgQ3JlYXRlT3V0cHV0IH0gZnJvbSAnLi9Dcm9uQ3JlYXRlVG9vbC5qcydcbmltcG9ydCB0eXBlIHsgRGVsZXRlT3V0cHV0IH0gZnJvbSAnLi9Dcm9uRGVsZXRlVG9vbC5qcydcbmltcG9ydCB0eXBlIHsgTGlzdE91dHB1dCB9IGZyb20gJy4vQ3Jvbkxpc3RUb29sLmpzJ1xuXG4vLyAtLS0gQ3JvbkNyZWF0ZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJDcmVhdGVUb29sVXNlTWVzc2FnZShcbiAgaW5wdXQ6IFBhcnRpYWw8eyBjcm9uOiBzdHJpbmc7IHByb21wdDogc3RyaW5nIH0+LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIGAke2lucHV0LmNyb24gPz8gJyd9JHtpbnB1dC5wcm9tcHQgPyBgOiAke3RydW5jYXRlKGlucHV0LnByb21wdCwgNjAsIHRydWUpfWAgOiAnJ31gXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJDcmVhdGVSZXN1bHRNZXNzYWdlKFxuICBvdXRwdXQ6IENyZWF0ZU91dHB1dCxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiAoXG4gICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgIDxUZXh0PlxuICAgICAgICBTY2hlZHVsZWQgPFRleHQgYm9sZD57b3V0cHV0LmlkfTwvVGV4dD57JyAnfVxuICAgICAgICA8VGV4dCBkaW1Db2xvcj4oe291dHB1dC5odW1hblNjaGVkdWxlfSk8L1RleHQ+XG4gICAgICA8L1RleHQ+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cblxuLy8gLS0tIENyb25EZWxldGUgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyRGVsZXRlVG9vbFVzZU1lc3NhZ2UoXG4gIGlucHV0OiBQYXJ0aWFsPHsgaWQ6IHN0cmluZyB9Pixcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiBpbnB1dC5pZCA/PyAnJ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyRGVsZXRlUmVzdWx0TWVzc2FnZShcbiAgb3V0cHV0OiBEZWxldGVPdXRwdXQsXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICA8VGV4dD5cbiAgICAgICAgQ2FuY2VsbGVkIDxUZXh0IGJvbGQ+e291dHB1dC5pZH08L1RleHQ+XG4gICAgICA8L1RleHQ+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cblxuLy8gLS0tIENyb25MaXN0IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyTGlzdFRvb2xVc2VNZXNzYWdlKCk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiAnJ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyTGlzdFJlc3VsdE1lc3NhZ2Uob3V0cHV0OiBMaXN0T3V0cHV0KTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgaWYgKG91dHB1dC5qb2JzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiAoXG4gICAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj5ObyBzY2hlZHVsZWQgam9iczwvVGV4dD5cbiAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgIClcbiAgfVxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICB7b3V0cHV0LmpvYnMubWFwKGogPT4gKFxuICAgICAgICA8VGV4dCBrZXk9e2ouaWR9PlxuICAgICAgICAgIDxUZXh0IGJvbGQ+e2ouaWR9PC9UZXh0PiA8VGV4dCBkaW1Db2xvcj57ai5odW1hblNjaGVkdWxlfTwvVGV4dD5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgKSl9XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cblxuLy8gLS0tIFNoYXJlZCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPQSxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxlQUFlLFFBQVEscUNBQXFDO0FBQ3JFLFNBQVNDLElBQUksUUFBUSxjQUFjO0FBQ25DLFNBQVNDLFFBQVEsUUFBUSx1QkFBdUI7QUFDaEQsY0FBY0MsWUFBWSxRQUFRLHFCQUFxQjtB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