/**
 * ============================================================================
 *  【文件总览】src/tools/ConfigTool/UI.tsx —— Config 工具的终端渲染层
 * ============================================================================
 *
 *  【一句话定位】
 *  只负责把 Config 工具"画到终端上"，不含任何业务逻辑。
 *  导出 3 个 render* 函数，被 ConfigTool.ts 以配置项的形式挂上去。
 *
 *  【在架构中的位置】
 *
 *      ConfigTool.call() 返回结果
 *        └─> renderToolResultMessage(content)   ← ★ 本文件
 *      ConfigTool 被调用时（还没执行）
 *        └─> renderToolUseMessage(input)        ← ★ 本文件
 *      用户拒绝授权
 *        └─> renderToolUseRejectedMessage()     ← ★ 本文件
 *
 *  为什么拆出来：关注点分离 —— ConfigTool.ts 管"怎么读写设置"，
 *  本文件管"长什么样"。将来做 JSON 输出模式等别的呈现方式时不用动逻辑。
 *
 *  【本文件包含什么】
 *   1. renderToolUseMessage()        调用时：显示 `Getting theme` / `Setting theme to "dark"`
 *   2. renderToolResultMessage()     结果：显示 `theme = "dark"` 或 `Failed: ...`
 *   3. renderToolUseRejectedMessage() 被拒绝：`Config change rejected`
 *
 * ---------------------------------------------------------------------------
 *  【TS / TSX 语法速查】
 * ---------------------------------------------------------------------------
 *   - 扩展名 `.tsx` 而非 `.ts`：因为里面有 **JSX**
 *     （可以直接写 `<Text>...</Text>`）≈ 在代码里写 XML 字面量，
 *     编译后变成 `React.createElement(...)` 调用。
 *
 *   - `React.ReactNode`  返回值类型 = "任何 React 能渲染的东西"
 *     （元素 / 字符串 / null / 数组）。返回 null 表示"什么都不画"，是合法的。
 *
 *   - `Partial<Input>`  **工具类型**：把 Input 的所有字段变成可选。
 *     ≈ Java 里再造一个所有字段都可空的 DTO。
 *     为什么用 Partial？工具调用刚发起时参数是**流式解析**的，
 *     字段可能还没齐，不能假设 setting 一定存在 —— 所以下面第一行
 *     就是 `if (!input.setting) return null`。
 *
 *   - `{input.setting}`  JSX 里的**花括号插值**：里面是 JS 表达式。
 *     ≈ JSP/Thymeleaf 的 ${}，但这里是编译期转成 JS 代码。
 *
 *   - `<Text dimColor>` / `<Text color="error">` / `<Text bold>`
 *     自定义组件的 props。注意 `dimColor` 没写值 —— 在 JSX 里
 *     `dimColor` 等价于 `dimColor={true}`（布尔属性简写）。
 *
 *   - `jsonStringify(x)`  把值转成 JSON 字符串显示。
 *     为什么不用 String(x)？因为要区分 `"dark"`（字符串，带引号）
 *     和 `true`（布尔）—— 对配置项来说这个区分很重要。
 *
 *   - `content.operation === 'get'`  字面量比较做**类型收窄**：
 *     operation 是可选字段，比较后 TS 才确信当前是 'get' 分支。
 *
 *   - `import React from 'react'`  默认导入（与 `import type` 相对）。
 *     本文件只是用 `React.ReactNode` 这个**类型**，所以其实
 *     `import type React from 'react'` 就够，但写成值导入也能工作。
 *
 *   - 文件末尾 `//# sourceMappingURL=data:...` 是**内联 sourcemap**，
 *     把编译后的代码映射回原始 .tsx 源码，方便调试。不是业务代码。
 * ============================================================================
 */
import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Text } from '../../ink.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import type { Input, Output } from './ConfigTool.js';
/**
 * 渲染 Config 工具**被调用时**的那一行。
 *
 * 为什么要区分"读"和"写"两种显示？
 *   因为**写操作会改变用户的配置**，比读操作重要得多，
 *   用户必须一眼看出"模型正在改我的设置、改成了什么"。
 *   这也是为什么写操作在 checkPermissions 里要弹窗确认。
 *
 * 判定方式与业务逻辑完全一致：**有没有传 value**。
 *   没有 value → 读（Getting xxx）
 *   有 value   → 写（Setting xxx to yyy）
 *
 * @param input 工具入参（Partial：流式解析时字段可能还没齐）
 * @returns React 节点；setting 名为空时返回 null（什么都不画）
 */
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  // 中文补充：setting 还没解析出来就先不画。返回 null 在 React 里表示
  // "不渲染任何东西"，比返回空字符串更明确。
  if (!input.setting) return null;
  // 中文补充：value === undefined 就是"读"。
  // 注意用 `=== undefined` 而不是 falsy 判断 ——
  // 因为 false / 0 / '' 都是**合法的配置值**，不能被当成"没传"。
  // 这是一个很容易踩的坑：写 `if (!input.value)` 会把
  // "把某开关设为 false" 误判成"读取该开关"。
  if (input.value === undefined) {
    return <Text dimColor>Getting {input.setting}</Text>;
  }
  return <Text dimColor>
      Setting {input.setting} to {jsonStringify(input.value)}
    </Text>;
}
/**
 * 渲染 Config 工具**执行完**的结果。三种情形：
 *   ① 失败 → 红字 `Failed: 原因`
 *   ② 读   → `theme = "dark"`（设置名加粗，值用 JSON 形式显示）
 *   ③ 写   → `Set theme to "dark"`
 *
 * 为什么失败也要好好显示？因为错误信息是**给模型的反馈**之一
 * （同名文本也会通过 tool_result 回给模型），写清楚它才能自我纠正。
 *
 * @param content ConfigTool.call() 的返回数据
 * @returns React 节点
 */
export function renderToolResultMessage(content: Output): React.ReactNode {
  if (!content.success) {
    return <MessageResponse>
        <Text color="error">Failed: {content.error}</Text>
      </MessageResponse>;
  }
  if (content.operation === 'get') {
    return <MessageResponse>
        <Text>
          <Text bold>{content.setting}</Text> = {jsonStringify(content.value)}
        </Text>
      </MessageResponse>;
  }
  return <MessageResponse>
      <Text>
        Set <Text bold>{content.setting}</Text> to{' '}
        <Text bold>{jsonStringify(content.newValue)}</Text>
      </Text>
    </MessageResponse>;
}
/**
 * 渲染用户**拒绝**这次配置修改时的画面。
 *
 * 为什么需要单独一句：改配置是会持久化的动作，被拒绝时必须明确告知，
 * 否则用户不确定"到底改没改成"。用 warning 色（黄）区别于 error（红）
 * —— 拒绝是用户主动的、正常的结果，不是出错。
 *
 * @returns React 节点（不需要任何入参，固定文案）
 */
export function renderToolUseRejectedMessage(): React.ReactNode {
  return <Text color="warning">Config change rejected</Text>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsIlRleHQiLCJqc29uU3RyaW5naWZ5IiwiSW5wdXQiLCJPdXRwdXQiLCJyZW5kZXJUb29sVXNlTWVzc2FnZSIsImlucHV0IiwiUGFydGlhbCIsIlJlYWN0Tm9kZSIsInNldHRpbmciLCJ2YWx1ZSIsInVuZGVmaW5lZCIsInJlbmRlclRvb2xSZXN1bHRNZXNzYWdlIiwiY29udGVudCIsInN1Y2Nlc3MiLCJlcnJvciIsIm9wZXJhdGlvbiIsIm5ld1ZhbHVlIiwicmVuZGVyVG9vbFVzZVJlamVjdGVkTWVzc2FnZSJdLCJzb3VyY2VzIjpbIlVJLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL01lc3NhZ2VSZXNwb25zZS5qcydcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyBqc29uU3RyaW5naWZ5IH0gZnJvbSAnLi4vLi4vdXRpbHMvc2xvd09wZXJhdGlvbnMuanMnXG5pbXBvcnQgdHlwZSB7IElucHV0LCBPdXRwdXQgfSBmcm9tICcuL0NvbmZpZ1Rvb2wuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlTWVzc2FnZShpbnB1dDogUGFydGlhbDxJbnB1dD4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAoIWlucHV0LnNldHRpbmcpIHJldHVybiBudWxsXG4gIGlmIChpbnB1dC52YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIDxUZXh0IGRpbUNvbG9yPkdldHRpbmcge2lucHV0LnNldHRpbmd9PC9UZXh0PlxuICB9XG4gIHJldHVybiAoXG4gICAgPFRleHQgZGltQ29sb3I+XG4gICAgICBTZXR0aW5nIHtpbnB1dC5zZXR0aW5nfSB0byB7anNvblN0cmluZ2lmeShpbnB1dC52YWx1ZSl9XG4gICAgPC9UZXh0PlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShjb250ZW50OiBPdXRwdXQpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAoIWNvbnRlbnQuc3VjY2Vzcykge1xuICAgIHJldHVybiAoXG4gICAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+RmFpbGVkOiB7Y29udGVudC5lcnJvcn08L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cbiAgaWYgKGNvbnRlbnQub3BlcmF0aW9uID09PSAnZ2V0Jykge1xuICAgIHJldHVybiAoXG4gICAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgICA8VGV4dD5cbiAgICAgICAgICA8VGV4dCBib2xkPntjb250ZW50LnNldHRpbmd9PC9UZXh0PiA9IHtqc29uU3RyaW5naWZ5KGNvbnRlbnQudmFsdWUpfVxuICAgICAgICA8L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cbiAgcmV0dXJuIChcbiAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgPFRleHQ+XG4gICAgICAgIFNldCA8VGV4dCBib2xkPntjb250ZW50LnNldHRpbmd9PC9UZXh0PiB0b3snICd9XG4gICAgICAgIDxUZXh0IGJvbGQ+e2pzb25TdHJpbmdpZnkoY29udGVudC5uZXdWYWx1ZSl9PC9UZXh0PlxuICAgICAgPC9UZXh0PlxuICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlUmVqZWN0ZWRNZXNzYWdlKCk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiA8VGV4dCBjb2xvcj1cIndhcm5pbmdcIj5Db25maWcgY2hhbmdlIHJlamVjdGVkPC9UZXh0PlxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPQSxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxlQUFlLFFBQVEscUNBQXFDO0FBQ3JFLFNBQVNDLElBQUksUUFBUSxjQUFjO0FBQ25DLFNBQVNDLGFBQWEsUUFBUSwrQkFBK0I7QUFDN0QsY0FBY0MsS0FBSyxFQUFFQyxNQUFNLFFBQVEsaUJBQWlCO0FBRXBELE9BQU8sU0FBU0Msb0JBQW9CQSxDQUFDQyxLQUFLLEVBQUVDLE9BQU8sQ0FBQ0osS0FBSyxDQUFDLENBQUMsRUFBRUosS0FBSyxDQUFDUyxTQUFTLENBQUM7RUFDM0UsSUFBSSxDQUFDRixLQUFLLENBQUNHLE9BQU8sRUFBRSxPQUFPLElBQUk7RUFDL0IsSUFBSUgsS0FBSyxDQUFDSSxLQUFLLEtBQUtDLFNBQVMsRUFBRTtJQUM3QixPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUNMLEtBQUssQ0FBQ0csT0FBTyxDQUFDLEVBQUUsSUFBSSxDQUFDO0VBQ3REO0VBQ0EsT0FDRSxDQUFDLElBQUksQ0FBQyxRQUFRO0FBQ2xCLGNBQWMsQ0FBQ0gsS0FBSyxDQUFDRyxPQUFPLENBQUMsSUFBSSxDQUFDUCxhQUFhLENBQUNJLEtBQUssQ0FBQ0ksS0FBSyxDQUFDO0FBQzVELElBQUksRUFBRSxJQUFJLENBQUM7QUFFWDtBQUVBLE9BQU8sU0FBU0UsdUJBQXVCQSxDQUFDQyxPQUFPLEVBQUVULE1BQU0sQ0FBQyxFQUFFTCxLQUFLLENBQUNTLFNBQVMsQ0FBQztFQUN4RSxJQUFJLENBQUNLLE9BQU8sQ0FBQ0MsT0FBTyxFQUFFO0lBQ3BCLE9BQ0UsQ0FBQyxlQUFlO0FBQ3RCLFFBQVEsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUNELE9BQU8sQ0FBQ0UsS0FBSyxDQUFDLEVBQUUsSUFBSTtBQUN6RCxNQUFNLEVBQUUsZUFBZSxDQUFDO0VBRXRCO0VBQ0EsSUFBSUYsT0FBTyxDQUFDRyxTQUFTLEtBQUssS0FBSyxFQUFFO0lBQy9CLE9BQ0UsQ0FBQyxlQUFlO0FBQ3RCLFFBQVEsQ0FBQyxJQUFJO0FBQ2IsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQ0gsT0FBTyxDQUFDSixPQUFPLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDUCxhQUFhLENBQUNXLE9BQU8sQ0FBQ0gsS0FBSyxDQUFDO0FBQzdFLFFBQVEsRUFBRSxJQUFJO0FBQ2QsTUFBTSxFQUFFLGVBQWUsQ0FBQztFQUV0QjtFQUNBLE9BQ0UsQ0FBQyxlQUFlO0FBQ3BCLE1BQU0sQ0FBQyxJQUFJO0FBQ1gsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQ0csT0FBTyxDQUFDSixPQUFPLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUc7QUFDdEQsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQ1AsYUFBYSxDQUFDVyxPQUFPLENBQUNJLFFBQVEsQ0FBQyxDQUFDLEVBQUUsSUFBSTtBQUMxRCxNQUFNLEVBQUUsSUFBSTtBQUNaLElBQUksRUFBRSxlQUFlLENBQUM7QUFFdEI7QUFFQSxPQUFPLFNBQVNDLDRCQUE0QkEsQ0FBQSxDQUFFLEVBQUVuQixLQUFLLENBQUNTLFNBQVMsQ0FBQztFQUM5RCxPQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsc0JBQXNCLEVBQUUsSUFBSSxDQUFDO0FBQzVEIiwiaWdub3JlTGlzdCI6W119