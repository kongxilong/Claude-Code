/**
 * ============================================================================
 *  【文件总览】src/tools/ExitWorktreeTool/UI.tsx
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
import type { Output } from './ExitWorktreeTool.js';
export function renderToolUseMessage(): React.ReactNode {
  return 'Exiting worktree…';
}
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], _options: {
  theme: ThemeName;
}): React.ReactNode {
  const actionLabel = output.action === 'keep' ? 'Kept worktree' : 'Removed worktree';
  return <Box flexDirection="column">
      <Text>
        {actionLabel}
        {output.worktreeBranch ? <>
            {' '}
            (branch <Text bold>{output.worktreeBranch}</Text>)
          </> : null}
      </Text>
      <Text dimColor>Returned to {output.originalCwd}</Text>
    </Box>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJUb29sUHJvZ3Jlc3NEYXRhIiwiUHJvZ3Jlc3NNZXNzYWdlIiwiVGhlbWVOYW1lIiwiT3V0cHV0IiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJSZWFjdE5vZGUiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsIm91dHB1dCIsIl9wcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZSIsIl9vcHRpb25zIiwidGhlbWUiLCJhY3Rpb25MYWJlbCIsImFjdGlvbiIsIndvcmt0cmVlQnJhbmNoIiwib3JpZ2luYWxDd2QiXSwic291cmNlcyI6WyJVSS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgdHlwZSB7IFRvb2xQcm9ncmVzc0RhdGEgfSBmcm9tICcuLi8uLi9Ub29sLmpzJ1xuaW1wb3J0IHR5cGUgeyBQcm9ncmVzc01lc3NhZ2UgfSBmcm9tICcuLi8uLi90eXBlcy9tZXNzYWdlLmpzJ1xuaW1wb3J0IHR5cGUgeyBUaGVtZU5hbWUgfSBmcm9tICcuLi8uLi91dGlscy90aGVtZS5qcydcbmltcG9ydCB0eXBlIHsgT3V0cHV0IH0gZnJvbSAnLi9FeGl0V29ya3RyZWVUb29sLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZU1lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuICdFeGl0aW5nIHdvcmt0cmVl4oCmJ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2UoXG4gIG91dHB1dDogT3V0cHV0LFxuICBfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2U6IFByb2dyZXNzTWVzc2FnZTxUb29sUHJvZ3Jlc3NEYXRhPltdLFxuICBfb3B0aW9uczogeyB0aGVtZTogVGhlbWVOYW1lIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBhY3Rpb25MYWJlbCA9XG4gICAgb3V0cHV0LmFjdGlvbiA9PT0gJ2tlZXAnID8gJ0tlcHQgd29ya3RyZWUnIDogJ1JlbW92ZWQgd29ya3RyZWUnXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICA8VGV4dD5cbiAgICAgICAge2FjdGlvbkxhYmVsfVxuICAgICAgICB7b3V0cHV0Lndvcmt0cmVlQnJhbmNoID8gKFxuICAgICAgICAgIDw+XG4gICAgICAgICAgICB7JyAnfVxuICAgICAgICAgICAgKGJyYW5jaCA8VGV4dCBib2xkPntvdXRwdXQud29ya3RyZWVCcmFuY2h9PC9UZXh0PilcbiAgICAgICAgICA8Lz5cbiAgICAgICAgKSA6IG51bGx9XG4gICAgICA8L1RleHQ+XG4gICAgICA8VGV4dCBkaW1Db2xvcj5SZXR1cm5lZCB0byB7b3V0cHV0Lm9yaWdpbmFsQ3dkfTwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsY0FBY0MsZ0JBQWdCLFFBQVEsZUFBZTtBQUNyRCxjQUFjQyxlQUFlLFFBQVEsd0JBQXdCO0FBQzdELGNBQWNDLFNBQVMsUUFBUSxzQkFBc0I7QUFDckQsY0FBY0MsTUFBTSxRQUFRLHVCQUF1QjtBQUVuRCxPQUFPLFNBQVNDLG9CQUFvQkEsQ0FBQSxDQUFFLEVBQUVQLEtBQUssQ0FBQ1EsU0FBUyxDQUFDO0VBQ3RELE9BQU8sbUJBQW1CO0FBQzVCO0FBRUEsT0FBTyxTQUFTQyx1QkFBdUJBLENBQ3JDQyxNQUFNLEVBQUVKLE1BQU0sRUFDZEssMkJBQTJCLEVBQUVQLGVBQWUsQ0FBQ0QsZ0JBQWdCLENBQUMsRUFBRSxFQUNoRVMsUUFBUSxFQUFFO0VBQUVDLEtBQUssRUFBRVIsU0FBUztBQUFDLENBQUMsQ0FDL0IsRUFBRUwsS0FBSyxDQUFDUSxTQUFTLENBQUM7RUFDakIsTUFBTU0sV0FBVyxHQUNmSixNQUFNLENBQUNLLE1BQU0sS0FBSyxNQUFNLEdBQUcsZUFBZSxHQUFHLGtCQUFrQjtFQUNqRSxPQUNFLENBQUMsR0FBRyxDQUFDLGFBQWEsQ0FBQyxRQUFRO0FBQy9CLE1BQU0sQ0FBQyxJQUFJO0FBQ1gsUUFBUSxDQUFDRCxXQUFXO0FBQ3BCLFFBQVEsQ0FBQ0osTUFBTSxDQUFDTSxjQUFjLEdBQ3BCO0FBQ1YsWUFBWSxDQUFDLEdBQUc7QUFDaEIsb0JBQW9CLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDTixNQUFNLENBQUNNLGNBQWMsQ0FBQyxFQUFFLElBQUksQ0FBQztBQUM3RCxVQUFVLEdBQUcsR0FDRCxJQUFJO0FBQ2hCLE1BQU0sRUFBRSxJQUFJO0FBQ1osTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDTixNQUFNLENBQUNPLFdBQVcsQ0FBQyxFQUFFLElBQUk7QUFDM0QsSUFBSSxFQUFFLEdBQUcsQ0FBQztBQUVWIiwiaWdub3JlTGlzdCI6W119