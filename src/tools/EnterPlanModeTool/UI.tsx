import * as React from 'react';
import { BLACK_CIRCLE } from 'src/constants/figures.js';
import { getModeColor } from 'src/utils/permissions/PermissionMode.js';
import { Box, Text } from '../../ink.js';
import type { ToolProgressData } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import type { ThemeName } from '../../utils/theme.js';
import type { Output } from './EnterPlanModeTool.js';
/**
 * ============================================================================
 *  【文件总览】src/tools/EnterPlanModeTool/UI.tsx
 * ============================================================================
 *
 *  一句话定位：
 *  「进入 plan mode」这个工具在**终端里长什么样**的渲染代码。
 *  纯展示层，不含任何业务逻辑。
 *
 *  ⚠️ 打开这个文件你会发现它长得不像手写代码（缩进怪、末尾还挂着一长串
 *  base64 的 sourceMappingURL）——因为它是由 UI.tsx 源文件**编译产物的内联形式**
 *  直接落到仓库里的。读它的目的是搞清楚这个工具在终端显示什么，
 *  而不是学习代码风格。
 *
 *  ---------------------------------------------------------------------------
 *  【在架构中的位置】
 *  ---------------------------------------------------------------------------
 *      EnterPlanModeTool.ts
 *        ├─ renderToolUseMessage        ← ★ 本文件：模型刚发起调用时显示什么
 *        ├─ renderToolResultMessage     ← ★ 本文件：工具成功后显示什么
 *        └─ renderToolUseRejectedMessage ← ★ 本文件：用户点了"拒绝"后显示什么
 *              ↓ 返回 React 元素树
 *      Ink 渲染器（../../ink.js）把元素树画到终端上
 *
 *  三个函数正好对应工具生命周期的三个时刻：
 *    · UseMessage     = "我要调用这个工具了"（往往还没执行）
 *    · ResultMessage  = "工具执行完了，结果是这样"
 *    · RejectedMessage= "用户在权限弹窗里点了 No"
 *
 *  ---------------------------------------------------------------------------
 *  【本文件包含什么】
 *  ---------------------------------------------------------------------------
 *   1. renderToolUseMessage()          返回 null（故意什么都不显示）
 *   2. renderToolResultMessage()       显示"● Entered plan mode"+ 一行灰色说明
 *   3. renderToolUseRejectedMessage()  显示"● User declined to enter plan mode"
 *
 *  ---------------------------------------------------------------------------
 *  【TS / JSX 语法速查】Java 工程师视角（本文件几乎全是新语法，重点看）
 *  ---------------------------------------------------------------------------
 *  - 扩展名 `.tsx` 而不是 `.ts`：表示这个文件里允许写 **JSX**。
 *    JSX 就是「在 JS 代码里直接写标签」，看起来像 HTML：
 *        <Box flexDirection="column">...</Box>
 *    ≈ Java 里没有对应物；最接近的想象是「用 Java 语法直接写 Swing/Spring 的
 *      组件树」，只不过 TS 把它做成了语言的一部分。
 *    ⚠️ 但这里的 <Box>/<Text> **不是 HTML 标签**，而是 Ink 库提供的自定义组件
 *       （../../ink.js）。Ink = "命令行版的 React"，它把组件树渲染成终端字符，
 *       而不是浏览器 DOM。所以：
 *         <Box>   ≈ 一个 div，支持 flex 布局（flexDirection/paddingLeft 等）
 *         <Text>  ≈ 一个 span，支持 color / dimColor / bold 等文字样式
 *
 *  - `<Box flexDirection="column">` 里的属性名用**驼峰**而不是 CSS 的连字符，
 *    值用 `="字符串"` 或 `{JS表达式}` 两种形式：
 *      `marginTop={1}`     花括号里是 **JS 表达式**，所以传的是数字 1
 *      `marginTop="1"`     不加花括号传的是字符串 "1"
 *      这就是 JSX 里花括号的唯一含义——"切回 JS 世界"。
 *
 *  - `<Text>{BLACK_CIRCLE}</Text>` 花括号里放变量，≈ JSP/Thymeleaf 的 ${}。
 *    BLACK_CIRCLE 是个 ● 字符常量。
 *
 *  - `<Text> Entered plan mode</Text>`
 *    ⚠️ 注意 "Entered" 前面那个空格是**有意保留的**：
 *    终端里 ● 和文字之间需要一个空格分隔，而 JSX 会把换行和缩进空白吃掉，
 *    所以必须显式写一个空格字符。这是 Ink/React 的经典坑。
 *
 *  - `React.ReactNode`  返回值类型。
 *    ≈ "一棵可以被渲染的节点树"，可以是元素、字符串、数字、null 的数组。
 *      Java 里最接近的是 `javax.swing.JComponent`（一个能挂到界面上的东西）。
 *    `return null` 是合法值，语义是"这里什么都不渲染"。
 *
 *  - `Output`  从 EnterPlanModeTool.js 导入的**类型**（`import type`）。
 *    它描述了 tool 的输出结构（{ message: string }），
 *    是逻辑层和渲染层之间的契约：call() 产出什么，这里就能拿到什么。
 *
 *  - `_output`、`_options`、`_theme` 下划线前缀
 *    = 团队约定"这个参数我不用，但签名必须对上"。
 *    TS 的 noUnusedParameters 检查会放过下划线开头的参数。
 *    ≈ Java 里对未使用参数只能加 @SuppressWarnings 或硬着头皮写个空引用。
 *
 *  - `getModeColor('plan')`  按当前的权限模式取一个颜色。
 *    plan 模式用专门的颜色，让用户在终端里一眼看出"我现在处于只读模式"。
 *    注意被拒的那条用的是 getModeColor('default')（普通颜色），
 *    因为拒绝之后并没有真的进入 plan mode，不该用 plan 的配色误导用户。
 */
/**
 * 模型刚发起调用时显示什么。
 *
 * 这里返回 null —— **故意什么都不显示**。
 * 为什么？因为"进入 plan mode"这件事在终端上没有任何中间态值得展示：
 * 它要么成功（显示 renderToolResultMessage 的内容），
 * 要么被用户拒绝（显示 renderToolUseRejectedMessage 的内容）。
 * 打个转瞬即逝的"正在进入…"只会让界面闪烁，所以直接省掉。
 */
export function renderToolUseMessage(): React.ReactNode {
  return null;
}
/**
 * 工具执行成功后，在终端上显示的内容。
 *
 * 长相（终端里实际看到的两行）：
 *     ● Entered plan mode
 *         Claude is now exploring and designing an implementation approach.
 *
 * 设计意图（解释"为什么这么写"）：
 *   · 用 ●（BLACK_CIRCLE）作为这一条的标记，颜色取自 plan 模式的专用色
 *     —— 这是全仓库统一的"模式提示"视觉语言，ExitPlanMode 也用同一个 ●，
 *        用户扫一眼颜色就知道这条消息和 plan mode 有关。
 *   · 第二段用 dimColor（暗色）+ paddingLeft={2}（缩进 2 格）渲染，
 *     视觉上降级成"补充说明"，不抢主信息的注意力。
 *   · 三个入参全部用下划线开头（_output / _progressMessagesForMessage / _options）：
 *     因为这条消息的文案是**固定**的，不需要读工具的实际输出。
 *     但函数签名必须和框架约定的一致，所以参数得留着、只是不用。
 *     ≈ Java 里实现接口时某个方法用不到入参，只能硬着头皮声明。
 *
 * 入参：
 *   _output                    工具的输出（{ message: string }），本函数不用
 *   _progressMessagesForMessage 工具执行过程中产生的进度消息流，本函数不用
 *   _options                   渲染选项（含主题名），本函数不用
 *
 * 返回值：一棵 Ink 组件树（React.ReactNode），交给 Ink 渲染到终端。
 */
export function renderToolResultMessage(_output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], _options: {
  theme: ThemeName;
}): React.ReactNode {
  return <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={getModeColor('plan')}>{BLACK_CIRCLE}</Text>
        <Text> Entered plan mode</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor>
          Claude is now exploring and designing an implementation approach.
        </Text>
      </Box>
    </Box>;
}
/**
 * 用户在权限弹窗里点了"拒绝"之后显示的内容。
 *
 * 为什么这一条值得单独写一个函数？
 *   因为"用户拒绝"是一个**非常重要**的信号，必须明确回显在对话记录里。
 *   否则用户会困惑："我刚才点的是拒绝，怎么界面上什么都没发生？"
 *   而且这段话还会进入对话历史——模型下一轮就能看到
 *   "用户不想进 plan mode"，从而改走直接实现的路线，
 *   不会傻乎乎地再调一次 EnterPlanMode。
 *
 * ⚠️ 细节：这里用的是 getModeColor('default') 而不是 'plan'。
 *   因为用户拒绝之后，会话**并没有**进入 plan mode，
 *   如果还用 plan 的配色，会误导用户以为已经进去了。
 *   颜色在这里承担的是"当前真实状态"的语义，不是"这条消息关于什么"的语义。
 */
export function renderToolUseRejectedMessage(): React.ReactNode {
  return <Box flexDirection="row" marginTop={1}>
      <Text color={getModeColor('default')}>{BLACK_CIRCLE}</Text>
      <Text> User declined to enter plan mode</Text>
    </Box>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJMQUNLX0NJUkNMRSIsImdldE1vZGVDb2xvciIsIkJveCIsIlRleHQiLCJUb29sUHJvZ3Jlc3NEYXRhIiwiUHJvZ3Jlc3NNZXNzYWdlIiwiVGhlbWVOYW1lIiwiT3V0cHV0IiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJSZWFjdE5vZGUiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsIl9vdXRwdXQiLCJfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJfb3B0aW9ucyIsInRoZW1lIiwicmVuZGVyVG9vbFVzZVJlamVjdGVkTWVzc2FnZSJdLCJzb3VyY2VzIjpbIlVJLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJMQUNLX0NJUkNMRSB9IGZyb20gJ3NyYy9jb25zdGFudHMvZmlndXJlcy5qcydcbmltcG9ydCB7IGdldE1vZGVDb2xvciB9IGZyb20gJ3NyYy91dGlscy9wZXJtaXNzaW9ucy9QZXJtaXNzaW9uTW9kZS5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB0eXBlIHsgVG9vbFByb2dyZXNzRGF0YSB9IGZyb20gJy4uLy4uL1Rvb2wuanMnXG5pbXBvcnQgdHlwZSB7IFByb2dyZXNzTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgdHlwZSB7IFRoZW1lTmFtZSB9IGZyb20gJy4uLy4uL3V0aWxzL3RoZW1lLmpzJ1xuaW1wb3J0IHR5cGUgeyBPdXRwdXQgfSBmcm9tICcuL0VudGVyUGxhbk1vZGVUb29sLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZU1lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIG51bGxcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xSZXN1bHRNZXNzYWdlKFxuICBfb3V0cHV0OiBPdXRwdXQsXG4gIF9wcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZTogUHJvZ3Jlc3NNZXNzYWdlPFRvb2xQcm9ncmVzc0RhdGE+W10sXG4gIF9vcHRpb25zOiB7IHRoZW1lOiBUaGVtZU5hbWUgfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgbWFyZ2luVG9wPXsxfT5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiPlxuICAgICAgICA8VGV4dCBjb2xvcj17Z2V0TW9kZUNvbG9yKCdwbGFuJyl9PntCTEFDS19DSVJDTEV9PC9UZXh0PlxuICAgICAgICA8VGV4dD4gRW50ZXJlZCBwbGFuIG1vZGU8L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICAgIDxCb3ggcGFkZGluZ0xlZnQ9ezJ9PlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgICBDbGF1ZGUgaXMgbm93IGV4cGxvcmluZyBhbmQgZGVzaWduaW5nIGFuIGltcGxlbWVudGF0aW9uIGFwcHJvYWNoLlxuICAgICAgICA8L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICA8L0JveD5cbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZVJlamVjdGVkTWVzc2FnZSgpOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiIG1hcmdpblRvcD17MX0+XG4gICAgICA8VGV4dCBjb2xvcj17Z2V0TW9kZUNvbG9yKCdkZWZhdWx0Jyl9PntCTEFDS19DSVJDTEV9PC9UZXh0PlxuICAgICAgPFRleHQ+IFVzZXIgZGVjbGluZWQgdG8gZW50ZXIgcGxhbiBtb2RlPC9UZXh0PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsWUFBWSxRQUFRLDBCQUEwQjtBQUN2RCxTQUFTQyxZQUFZLFFBQVEseUNBQXlDO0FBQ3RFLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsY0FBY0MsZ0JBQWdCLFFBQVEsZUFBZTtBQUNyRCxjQUFjQyxlQUFlLFFBQVEsd0JBQXdCO0FBQzdELGNBQWNDLFNBQVMsUUFBUSxzQkFBc0I7QUFDckQsY0FBY0MsTUFBTSxRQUFRLHdCQUF3QjtBQUVwRCxPQUFPLFNBQVNDLG9CQUFvQkEsQ0FBQSxDQUFFLEVBQUVULEtBQUssQ0FBQ1UsU0FBUyxDQUFDO0VBQ3RELE9BQU8sSUFBSTtBQUNiO0FBRUEsT0FBTyxTQUFTQyx1QkFBdUJBLENBQ3JDQyxPQUFPLEVBQUVKLE1BQU0sRUFDZkssMkJBQTJCLEVBQUVQLGVBQWUsQ0FBQ0QsZ0JBQWdCLENBQUMsRUFBRSxFQUNoRVMsUUFBUSxFQUFFO0VBQUVDLEtBQUssRUFBRVIsU0FBUztBQUFDLENBQUMsQ0FDL0IsRUFBRVAsS0FBSyxDQUFDVSxTQUFTLENBQUM7RUFDakIsT0FDRSxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM3QyxNQUFNLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxLQUFLO0FBQzlCLFFBQVEsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUNSLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUNELFlBQVksQ0FBQyxFQUFFLElBQUk7QUFDL0QsUUFBUSxDQUFDLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxJQUFJO0FBQ3RDLE1BQU0sRUFBRSxHQUFHO0FBQ1gsTUFBTSxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUIsUUFBUSxDQUFDLElBQUksQ0FBQyxRQUFRO0FBQ3RCO0FBQ0EsUUFBUSxFQUFFLElBQUk7QUFDZCxNQUFNLEVBQUUsR0FBRztBQUNYLElBQUksRUFBRSxHQUFHLENBQUM7QUFFVjtBQUVBLE9BQU8sU0FBU2UsNEJBQTRCQSxDQUFBLENBQUUsRUFBRWhCLEtBQUssQ0FBQ1UsU0FBUyxDQUFDO0VBQzlELE9BQ0UsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUMsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQ1IsWUFBWSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQ0QsWUFBWSxDQUFDLEVBQUUsSUFBSTtBQUNoRSxNQUFNLENBQUMsSUFBSSxDQUFDLGlDQUFpQyxFQUFFLElBQUk7QUFDbkQsSUFBSSxFQUFFLEdBQUcsQ0FBQztBQUVWIiwiaWdub3JlTGlzdCI6W119