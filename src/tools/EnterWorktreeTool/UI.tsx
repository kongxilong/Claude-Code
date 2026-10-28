/**
 * ============================================================================
 *  【文件总览】src/tools/EnterWorktreeTool/UI.tsx
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 UI.tsx 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  由主循环 src/query.ts 在需要对应能力时，通过工具调度（runTools → 工具 execute）调用本文件；本文件属于「工具层」，负责把某一类能力封装成一个可被模型点名的 Tool。
 *
 *  【本文件包含什么】
 *  主要导出/定义：renderToolUseMessage、renderToolResultMessage
 *
 *  【TS 语法速查】（针对本文件实际用到的，逐条 Java 对照）
 *    · `?.` 可选链 ≈ Java 里 `obj != null ? obj.x : null`
 *    · `??` 空值合并 ≈ `a != null ? a : b`（注意与 `||` 区别：`??` 只在 null/undefined 时兜底，0 和 '' 不会被动替换）
 *    · `!` 非空断言（如 `x!`）≈ 强制类型转换，骗过编译器；运行时并不做检查，乱用会抛错
 *    · `as X` ≈ Java 的 `(X)obj` 强制转换
 *    · `type X = {...}` ≈ record，但 TS 是结构化（鸭子）类型：形状对得上就算同一类型，不要求显式 implements
 *    · `A | B` 联合类型 ≈ 受限的 sealed interface / 代数数据类型
 *    · `{...obj, k: v}` 展开 ≈ 生成新对象（不可变更新），原对象不变
 *    · `x is T` 类型谓词 ≈ Java 的 `instanceof` 模式守卫，用于收窄类型
 *    · `async function*` + `yield` + `for await` ≈ Java 的 Flux / 响应式流（一边产出一边消费）
 *    · `feature('X')` 是编译期开关（类似 #ifdef），不是运行时 if
 *    · `arr.at(-1)` 取最后一个元素（Java 没有，要 `arr.get(arr.size()-1)`）
 *    · 类型标注写在变量名**后面**（`x: string`），Java 写在前面（`String x`）——这是最容易看串行的地方
 *    · 箭头函数 `x => x.y` ≈ Java 的 lambda
 */

import * as React from 'react';
import { Box, Text } from '../../ink.js';
import type { ToolProgressData } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import type { ThemeName } from '../../utils/theme.js';
import type { Output } from './EnterWorktreeTool.js';
export function renderToolUseMessage(): React.ReactNode {
  return 'Creating worktree…';
}
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], _options: {
  theme: ThemeName;
}): React.ReactNode {
  return <Box flexDirection="column">
      <Text>
        Switched to worktree on branch <Text bold>{output.worktreeBranch}</Text>
      </Text>
      <Text dimColor>{output.worktreePath}</Text>
    </Box>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJUb29sUHJvZ3Jlc3NEYXRhIiwiUHJvZ3Jlc3NNZXNzYWdlIiwiVGhlbWVOYW1lIiwiT3V0cHV0IiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJSZWFjdE5vZGUiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsIm91dHB1dCIsIl9wcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZSIsIl9vcHRpb25zIiwidGhlbWUiLCJ3b3JrdHJlZUJyYW5jaCIsIndvcmt0cmVlUGF0aCJdLCJzb3VyY2VzIjpbIlVJLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB0eXBlIHsgVG9vbFByb2dyZXNzRGF0YSB9IGZyb20gJy4uLy4uL1Rvb2wuanMnXG5pbXBvcnQgdHlwZSB7IFByb2dyZXNzTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgdHlwZSB7IFRoZW1lTmFtZSB9IGZyb20gJy4uLy4uL3V0aWxzL3RoZW1lLmpzJ1xuaW1wb3J0IHR5cGUgeyBPdXRwdXQgfSBmcm9tICcuL0VudGVyV29ya3RyZWVUb29sLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZU1lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuICdDcmVhdGluZyB3b3JrdHJlZeKApidcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xSZXN1bHRNZXNzYWdlKFxuICBvdXRwdXQ6IE91dHB1dCxcbiAgX3Byb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlOiBQcm9ncmVzc01lc3NhZ2U8VG9vbFByb2dyZXNzRGF0YT5bXSxcbiAgX29wdGlvbnM6IHsgdGhlbWU6IFRoZW1lTmFtZSB9LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgIDxUZXh0PlxuICAgICAgICBTd2l0Y2hlZCB0byB3b3JrdHJlZSBvbiBicmFuY2ggPFRleHQgYm9sZD57b3V0cHV0Lndvcmt0cmVlQnJhbmNofTwvVGV4dD5cbiAgICAgIDwvVGV4dD5cbiAgICAgIDxUZXh0IGRpbUNvbG9yPntvdXRwdXQud29ya3RyZWVQYXRofTwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsY0FBY0MsZ0JBQWdCLFFBQVEsZUFBZTtBQUNyRCxjQUFjQyxlQUFlLFFBQVEsd0JBQXdCO0FBQzdELGNBQWNDLFNBQVMsUUFBUSxzQkFBc0I7QUFDckQsY0FBY0MsTUFBTSxRQUFRLHdCQUF3QjtBQUVwRCxPQUFPLFNBQVNDLG9CQUFvQkEsQ0FBQSxDQUFFLEVBQUVQLEtBQUssQ0FBQ1EsU0FBUyxDQUFDO0VBQ3RELE9BQU8sb0JBQW9CO0FBQzdCO0FBRUEsT0FBTyxTQUFTQyx1QkFBdUJBLENBQ3JDQyxNQUFNLEVBQUVKLE1BQU0sRUFDZEssMkJBQTJCLEVBQUVQLGVBQWUsQ0FBQ0QsZ0JBQWdCLENBQUMsRUFBRSxFQUNoRVMsUUFBUSxFQUFFO0VBQUVDLEtBQUssRUFBRVIsU0FBUztBQUFDLENBQUMsQ0FDL0IsRUFBRUwsS0FBSyxDQUFDUSxTQUFTLENBQUM7RUFDakIsT0FDRSxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsUUFBUTtBQUMvQixNQUFNLENBQUMsSUFBSTtBQUNYLHVDQUF1QyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQ0UsTUFBTSxDQUFDSSxjQUFjLENBQUMsRUFBRSxJQUFJO0FBQy9FLE1BQU0sRUFBRSxJQUFJO0FBQ1osTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQ0osTUFBTSxDQUFDSyxZQUFZLENBQUMsRUFBRSxJQUFJO0FBQ2hELElBQUksRUFBRSxHQUFHLENBQUM7QUFFViIsImlnbm9yZUxpc3QiOltdfQ==