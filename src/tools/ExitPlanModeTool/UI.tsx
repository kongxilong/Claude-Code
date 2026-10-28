import * as React from 'react';
import { Markdown } from 'src/components/Markdown.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { RejectedPlanMessage } from 'src/components/messages/UserToolResultMessage/RejectedPlanMessage.js';
import { BLACK_CIRCLE } from 'src/constants/figures.js';
import { getModeColor } from 'src/utils/permissions/PermissionMode.js';
import { Box, Text } from '../../ink.js';
import type { ToolProgressData } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import { getDisplayPath } from '../../utils/file.js';
import { getPlan } from '../../utils/plans.js';
import type { ThemeName } from '../../utils/theme.js';
import type { Output } from './ExitPlanModeV2Tool.js';
/**
 * ============================================================================
 *  【文件总览】src/tools/ExitPlanModeTool/UI.tsx
 * ============================================================================
 *
 *  一句话定位：
 *  「退出 plan mode」这个工具在**终端里长什么样**的渲染代码。
 *  纯展示层，不含业务逻辑。
 *
 *  ⚠️ 同 EnterPlanModeTool/UI.tsx：这个文件是编译产物的内联形式
 *  （末尾挂着一长串 base64 的 sourceMappingURL），缩进和换行都不是手写风格。
 *  读它是为了搞清楚终端上显示什么，不是学代码风格。
 *
 *  ---------------------------------------------------------------------------
 *  【在架构中的位置】
 *  ---------------------------------------------------------------------------
 *      ExitPlanModeV2Tool.ts
 *        ├─ renderToolUseMessage          ← ★ 本文件：刚发起调用时（什么都不显示）
 *        ├─ renderToolResultMessage       ← ★ 本文件：审批完成后（三种样子）
 *        └─ renderToolUseRejectedMessage  ← ★ 本文件：用户点了"拒绝"
 *              ↓ 返回 React 元素树
 *      Ink 渲染器把元素树画到终端上
 *
 *  ---------------------------------------------------------------------------
 *  【本文件包含什么】
 *  ---------------------------------------------------------------------------
 *   1. renderToolUseMessage()          返回 null
 *   2. renderToolResultMessage()       ★ 三种分支：
 *                                        空方案 → "● Exited plan mode"
 *                                        等负责人批 → "● Plan submitted for team lead approval"
 *                                        正常     → "● User approved Claude's plan" + 渲染方案全文
 *   3. renderToolUseRejectedMessage()  方案被拒时，把方案原文兜底显示出来
 *
 *  ---------------------------------------------------------------------------
 *  【TS / JSX 语法速查】Java 工程师视角
 *  ---------------------------------------------------------------------------
 *  - 扩展名 `.tsx`：允许写 **JSX**（在 JS 里直接写标签）。
 *    ≈ Java 没有对应物；最接近的想象是"用 Java 语法直接写组件树"。
 *    ⚠️ 这里的 <Box>/<Text> **不是 HTML 标签**，而是 Ink 库（../../ink.js）的组件。
 *       Ink = "命令行版的 React"，把组件树渲染成终端字符而不是浏览器 DOM：
 *         <Box>  ≈ div，支持 flex 布局（flexDirection / paddingLeft 等）
 *         <Text> ≈ span，支持 color / dimColor / bold 等文字样式
 *
 *  - `const { plan, filePath } = output;`
 *    解构赋值：从对象里一次性抽出几个字段当局部变量。
 *    ≈ Java 21+ 的记录模式匹配，但 TS 里是日常操作。
 *
 *  - `<Text>{plan}</Text>` 花括号 = "切回 JS 世界"，里面是表达式。
 *    ≈ JSP/Thymeleaf 的 ${}。
 *    `marginTop={1}` 花括号里是数字 1；若写 `marginTop="1"` 就是字符串。
 *
 *  - `{filePath && <Text dimColor>Plan saved to: ...</Text>}`
 *    ★ 这是 JS 里非常常见但 Java 同学容易看懵的写法，务必看懂：
 *      `a && b` 的求值规则是——a 为假就直接返回 a，a 为真才返回 b。
 *      所以 `filePath && <Text/>` 的效果是：
 *        filePath 有值（非空串）→ 渲染这个 <Text>
 *        filePath 为空        → 什么都不渲染
 *      ≈ Java 的三元 `filePath != null ? renderText() : null`，只是简写。
 *      ⚠️ 和 Java 的 `&&` 只能返回 boolean 不同，JS 的 && 返回的是**操作数本身**。
 *
 *  - `{output.worktreeBranch ? <> ... </> : null}`（同类写法）
 *    `<>...</>` 是 **Fragment（片段）**：几个并列元素要包在一起但不想多套一层 Box。
 *    ≈ Java 里没有，想象成一个"透明的容器"。
 *
 *  - `??` 空值合并：`plan ?? getPlan() ?? 'No plan found'`
 *    可以**串联**：从左往右，遇到第一个不是 null/undefined 的就停下。
 *    ≈ Java 的 `Optional.ofNullable(plan).orElse(...)`，但写法轻得多。
 *    ⚠️ 和 `||` 的区别：`??` 不会把空串 '' 和 0 跳过。
 *
 *  - `!plan || plan.trim() === ''`
 *    这里用 `||` 是**故意的**：既要把 null/undefined 算作"空"，
 *    也要把纯空白字符串算作"空"。用 `??` 就漏掉后者了。
 *
 *  - 函数**参数位置的解构**：
 *        renderToolResultMessage(output, _progressMessages, { theme: _theme }: { theme: ThemeName })
 *    第二个参数直接把 `{ theme }` 抽出来，并且就地声明它的类型。
 *    ≈ Java 21+ 的记录模式匹配用在方法签名上。
 *
 *  - `plan?: string`  可选属性（等价于 `string | undefined`）。
 *    ⚠️ 与 `.nullable()` 的 null 不是一回事：
 *       undefined = 这个键没写；null = 写了但值是空。Java 只有 null 一种。
 *
 *  - `'`  这是 XML/HTML **实体**（entity），表示撇号 '。
 *    本文件下面那句 `<Text> User approved Claude's plan</Text>` 就是它。
 *    为什么不直接写 Claude's？因为 JSX 里单引号容易和属性引号/解析规则冲突，
 *    用实体最保险。≈ Java 字符串里写 \' 做转义。
 *    （同类的还有 & < > "）
 *
 *  - `_theme`、`_progressMessagesForMessage` 下划线前缀
 *    = "这参数我不用，但签名必须对上"。TS 的 noUnusedParameters 会放过它们。
 */
/**
 * 模型刚发起调用时显示什么。
 *
 * 返回 null —— **故意什么都不显示**，和 EnterPlanModeTool 同样的理由：
 * "退出 plan mode"没有中间态值得展示，结果要么成功（走 renderToolResultMessage）
 * 要么被拒（走 renderToolUseRejectedMessage）。
 * 打个转瞬即逝的"正在退出…"只会让界面闪烁。
 */
export function renderToolUseMessage(): React.ReactNode {
  return null;
}
/**
 * ★ 审批完成后在终端上显示什么。本文件的核心函数。
 *
 * 三种分支（和 ExitPlanModeV2Tool.call() 的三条执行路径一一对应）：
 *
 *   ① 空方案（plan 为 null / 纯空白）
 *        显示：● Exited plan mode
 *        就一行，干净利落。因为压根没有方案可展示。
 *
 *   ② 子 Agent 在等负责人批示（awaitingLeaderApproval）
 *        显示：● Plan submitted for team lead approval
 *              Plan file: xxx
 *              Waiting for team lead to review and approve...
 *        ⚠️ 注意这里**没有**用 "approved" 这个词——因为还没批。
 *           措辞的准确度在这种地方很重要，写错了会误导用户。
 *
 *   ③ 普通会话，方案已批准（最常见）
 *        显示：● User approved Claude's plan
 *              Plan saved to: xxx · /plan to edit
 *              <渲染方案全文的 Markdown>
 *
 * 设计意图（解释"为什么这么写"）：
 *   · 用 ●（BLACK_CIRCLE）+ plan 模式专用色，和 EnterPlanModeTool 保持
 *     同一套视觉语言——用户扫一眼颜色就知道这跟 plan mode 有关。
 *   · 方案全文用 <Markdown> 组件渲染，而不是纯文本。
 *     因为方案里通常有标题、列表、代码块，渲染成 Markdown 才好看。
 *   · 路径提示里带一句 "· /plan to edit"（输入 /plan 可编辑），
 *     是在**主动告诉用户还有这个能力**——否则用户以为方案定了就不能改。
 *
 * 入参：
 *   output  ExitPlanModeV2Tool.call() 的输出（Output 类型），本函数的唯一数据源
 * 返回值：一棵 Ink 组件树
 */
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], {
  theme: _theme
}: {
  theme: ThemeName;
}): React.ReactNode {
  const {
    plan,
    filePath
  } = output;
  const isEmpty = !plan || plan.trim() === '';
  const displayPath = filePath ? getDisplayPath(filePath) : '';
  const awaitingLeaderApproval = output.awaitingLeaderApproval;

  // Simplified message for empty plans
  // 【中文补注】分支 ①：模型压根没写方案，只显示一行，不放 <Markdown>
  if (isEmpty) {
    return <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
          <Text> Exited plan mode</Text>
        </Box>
      </Box>;
  }

  // When awaiting leader approval, show a different message
  // 【中文补注】分支 ②：子 Agent 的方案已投递给 team-lead，正在等批示。
  // ⚠️ 这里刻意不写 "approved"——因为还没批，写错了会误导用户。
  if (awaitingLeaderApproval) {
    return <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
          <Text> Plan submitted for team lead approval</Text>
        </Box>
        <MessageResponse>
          <Box flexDirection="column">
            {filePath && <Text dimColor>Plan file: {displayPath}</Text>}
            <Text dimColor>Waiting for team lead to review and approve...</Text>
          </Box>
        </MessageResponse>
      </Box>;
  }
  return <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
        <Text> User approved Claude&apos;s plan</Text>
      </Box>
      <MessageResponse>
        <Box flexDirection="column">
          {filePath && <Text dimColor>Plan saved to: {displayPath} · /plan to edit</Text>}
          <Markdown>{plan}</Markdown>
        </Box>
      </MessageResponse>
    </Box>;
}
/**
 * 用户在审批弹窗里点了"拒绝"之后显示什么。
 *
 * 这里调用了一个专门的组件 <RejectedPlanMessage>，把方案原文传进去。
 *
 * 为什么被拒了还要显示方案全文？
 *   因为用户点拒绝往往是"方案大体对，但某几点要改"。
 *   把方案显示出来（通常还带上用户填写的修改意见），
 *   用户和模型才能在同一份文本上讨论"到底哪里要改"。
 *   如果只显示一句"已拒绝"，模型下一轮就不知道自己被否在哪儿。
 *
 * 入参：
 *   { plan }  解构出的方案文本。类型是 `plan?: string`——可能压根没传。
 * 返回值：一棵 Ink 组件树
 */
export function renderToolUseRejectedMessage({
  plan
}: {
  plan?: string;
}, {
  theme: _theme
}: {
  theme: ThemeName;
}): React.ReactNode {
  // ★ `??` 的**串联**用法：从左往右，取第一个不是 null/undefined 的值。
  //   ① 优先用传进来的 plan（用户在弹窗里编辑过的版本）
  //   ② 没传 → 去磁盘读计划文件（getPlan()）
  //   ③ 磁盘也没有 → 兜底成 'No plan found'
  //   ≈ Java 的 Optional.ofNullable(a).or(...).orElse(...)，但写法轻得多。
  //   ⚠️ 注意这里用 `??` 而不是 `||`：如果 plan 是空串 ''，
  //      `??` 会**保留**它（然后 RejectedPlanMessage 拿到空串），
  //      而 `||` 会跳过它去读磁盘。这里的选择是"传入优先，哪怕是空的"。
  const planContent = plan ?? getPlan() ?? 'No plan found';
  return <Box flexDirection="column">
      <RejectedPlanMessage plan={planContent} />
    </Box>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1hcmtkb3duIiwiTWVzc2FnZVJlc3BvbnNlIiwiUmVqZWN0ZWRQbGFuTWVzc2FnZSIsIkJMQUNLX0NJUkNMRSIsImdldE1vZGVDb2xvciIsIkJveCIsIlRleHQiLCJUb29sUHJvZ3Jlc3NEYXRhIiwiUHJvZ3Jlc3NNZXNzYWdlIiwiZ2V0RGlzcGxheVBhdGgiLCJnZXRQbGFuIiwiVGhlbWVOYW1lIiwiT3V0cHV0IiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJSZWFjdE5vZGUiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsIm91dHB1dCIsIl9wcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZSIsInRoZW1lIiwiX3RoZW1lIiwicGxhbiIsImZpbGVQYXRoIiwiaXNFbXB0eSIsInRyaW0iLCJkaXNwbGF5UGF0aCIsImF3YWl0aW5nTGVhZGVyQXBwcm92YWwiLCJyZW5kZXJUb29sVXNlUmVqZWN0ZWRNZXNzYWdlIiwicGxhbkNvbnRlbnQiXSwic291cmNlcyI6WyJVSS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBNYXJrZG93biB9IGZyb20gJ3NyYy9jb21wb25lbnRzL01hcmtkb3duLmpzJ1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnc3JjL2NvbXBvbmVudHMvTWVzc2FnZVJlc3BvbnNlLmpzJ1xuaW1wb3J0IHsgUmVqZWN0ZWRQbGFuTWVzc2FnZSB9IGZyb20gJ3NyYy9jb21wb25lbnRzL21lc3NhZ2VzL1VzZXJUb29sUmVzdWx0TWVzc2FnZS9SZWplY3RlZFBsYW5NZXNzYWdlLmpzJ1xuaW1wb3J0IHsgQkxBQ0tfQ0lSQ0xFIH0gZnJvbSAnc3JjL2NvbnN0YW50cy9maWd1cmVzLmpzJ1xuaW1wb3J0IHsgZ2V0TW9kZUNvbG9yIH0gZnJvbSAnc3JjL3V0aWxzL3Blcm1pc3Npb25zL1Blcm1pc3Npb25Nb2RlLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHR5cGUgeyBUb29sUHJvZ3Jlc3NEYXRhIH0gZnJvbSAnLi4vLi4vVG9vbC5qcydcbmltcG9ydCB0eXBlIHsgUHJvZ3Jlc3NNZXNzYWdlIH0gZnJvbSAnLi4vLi4vdHlwZXMvbWVzc2FnZS5qcydcbmltcG9ydCB7IGdldERpc3BsYXlQYXRoIH0gZnJvbSAnLi4vLi4vdXRpbHMvZmlsZS5qcydcbmltcG9ydCB7IGdldFBsYW4gfSBmcm9tICcuLi8uLi91dGlscy9wbGFucy5qcydcbmltcG9ydCB0eXBlIHsgVGhlbWVOYW1lIH0gZnJvbSAnLi4vLi4vdXRpbHMvdGhlbWUuanMnXG5pbXBvcnQgdHlwZSB7IE91dHB1dCB9IGZyb20gJy4vRXhpdFBsYW5Nb2RlVjJUb29sLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZU1lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIG51bGxcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xSZXN1bHRNZXNzYWdlKFxuICBvdXRwdXQ6IE91dHB1dCxcbiAgX3Byb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlOiBQcm9ncmVzc01lc3NhZ2U8VG9vbFByb2dyZXNzRGF0YT5bXSxcbiAgeyB0aGVtZTogX3RoZW1lIH06IHsgdGhlbWU6IFRoZW1lTmFtZSB9LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgeyBwbGFuLCBmaWxlUGF0aCB9ID0gb3V0cHV0XG4gIGNvbnN0IGlzRW1wdHkgPSAhcGxhbiB8fCBwbGFuLnRyaW0oKSA9PT0gJydcbiAgY29uc3QgZGlzcGxheVBhdGggPSBmaWxlUGF0aCA/IGdldERpc3BsYXlQYXRoKGZpbGVQYXRoKSA6ICcnXG4gIGNvbnN0IGF3YWl0aW5nTGVhZGVyQXBwcm92YWwgPSBvdXRwdXQuYXdhaXRpbmdMZWFkZXJBcHByb3ZhbFxuXG4gIC8vIFNpbXBsaWZpZWQgbWVzc2FnZSBmb3IgZW1wdHkgcGxhbnNcbiAgaWYgKGlzRW1wdHkpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgbWFyZ2luVG9wPXsxfT5cbiAgICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwicm93XCI+XG4gICAgICAgICAgPFRleHQgY29sb3I9e2dldE1vZGVDb2xvcigncGxhbicpfT57QkxBQ0tfQ0lSQ0xFfTwvVGV4dD5cbiAgICAgICAgICA8VGV4dD4gRXhpdGVkIHBsYW4gbW9kZTwvVGV4dD5cbiAgICAgICAgPC9Cb3g+XG4gICAgICA8L0JveD5cbiAgICApXG4gIH1cblxuICAvLyBXaGVuIGF3YWl0aW5nIGxlYWRlciBhcHByb3ZhbCwgc2hvdyBhIGRpZmZlcmVudCBtZXNzYWdlXG4gIGlmIChhd2FpdGluZ0xlYWRlckFwcHJvdmFsKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIG1hcmdpblRvcD17MX0+XG4gICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiPlxuICAgICAgICAgIDxUZXh0IGNvbG9yPXtnZXRNb2RlQ29sb3IoJ3BsYW4nKX0+e0JMQUNLX0NJUkNMRX08L1RleHQ+XG4gICAgICAgICAgPFRleHQ+IFBsYW4gc3VibWl0dGVkIGZvciB0ZWFtIGxlYWQgYXBwcm92YWw8L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICAgICAge2ZpbGVQYXRoICYmIDxUZXh0IGRpbUNvbG9yPlBsYW4gZmlsZToge2Rpc3BsYXlQYXRofTwvVGV4dD59XG4gICAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5XYWl0aW5nIGZvciB0ZWFtIGxlYWQgdG8gcmV2aWV3IGFuZCBhcHByb3ZlLi4uPC9UZXh0PlxuICAgICAgICAgIDwvQm94PlxuICAgICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgbWFyZ2luVG9wPXsxfT5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiPlxuICAgICAgICA8VGV4dCBjb2xvcj17Z2V0TW9kZUNvbG9yKCdwbGFuJyl9PntCTEFDS19DSVJDTEV9PC9UZXh0PlxuICAgICAgICA8VGV4dD4gVXNlciBhcHByb3ZlZCBDbGF1ZGUmYXBvcztzIHBsYW48L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICAgIHtmaWxlUGF0aCAmJiAoXG4gICAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5QbGFuIHNhdmVkIHRvOiB7ZGlzcGxheVBhdGh9IMK3IC9wbGFuIHRvIGVkaXQ8L1RleHQ+XG4gICAgICAgICAgKX1cbiAgICAgICAgICA8TWFya2Rvd24+e3BsYW59PC9NYXJrZG93bj5cbiAgICAgICAgPC9Cb3g+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICA8L0JveD5cbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZVJlamVjdGVkTWVzc2FnZShcbiAgeyBwbGFuIH06IHsgcGxhbj86IHN0cmluZyB9LFxuICB7IHRoZW1lOiBfdGhlbWUgfTogeyB0aGVtZTogVGhlbWVOYW1lIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBwbGFuQ29udGVudCA9IHBsYW4gPz8gZ2V0UGxhbigpID8/ICdObyBwbGFuIGZvdW5kJ1xuXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICA8UmVqZWN0ZWRQbGFuTWVzc2FnZSBwbGFuPXtwbGFuQ29udGVudH0gLz5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlC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