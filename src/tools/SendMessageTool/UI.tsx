/**
 * ============================================================================
 *  【文件总览】src/tools/SendMessageTool/UI.tsx
 *              —— SendMessage 工具在终端里长什么样（React 渲染层）
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件决定 SendMessage 工具在终端界面上显示什么文字。它**不做**任何通信逻辑，
 *  只负责把一次工具调用/结果翻译成一行给人看的字。
 *
 *  【在架构中的位置】
 *      工具框架 src/Tool.ts 的 renderToolUseMessage / renderToolResultMessage 钩子
 *        └─> 本文件的两个导出函数                     ← ★ 你在这
 *              └─> <MessageResponse> / <Text>          ← src/components/...（Ink 终端组件）
 *      这两个函数被 SendMessageTool.ts 末尾直接引用（renderToolUseMessage, renderToolResultMessage）。
 *
 *  【本文件包含什么】
 *   1. renderToolUseMessage(input)     模型「刚发起调用」时显示什么
 *   2. renderToolResultMessage(...)    调用「有结果了」之后显示什么
 *
 *  【返回 null 是什么意思？】
 *  两个函数都可以返回 null，含义是「这一条不用在终端上显示」。
 *  本工具里大量返回 null —— 因为消息内容本身会在别处（收件人的会话里）被渲染出来，
 *  在这里再打一遍就是重复刷屏。这是**刻意的设计**，不是"忘了实现"。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（.tsx 特有，Java 工程师最需要补的一块）
 * ---------------------------------------------------------------------------
 *  - `.tsx` 后缀 = 允许在代码里直接写 **JSX**（长得像 HTML 的标签）。
 *    它不是 HTML，而是 React 元素：`return <Text dimColor>{x}</Text>`
 *    ≈ Java 里手写 Component 树，或用 JetBrains UI Designer 生成的那种组件树。
 *    属性名是驼峰（`dimColor`），不是 HTML 的横杠写法。
 *  - `{expr}` 花括号是"JSX 里的表达式插值"，≈ JSP 的 ${} 或 Thymeleaf 的 th:text。
 *  - `React.ReactNode` 返回类型：可以是 JSX 元素、字符串、null 的**联合类型**。
 *    返回 null 表示"什么都不渲染"（≈ 返回一个空的 Optional）。
 *  - `Partial<Input>`：把 Input 的所有字段都变成可选。
 *    ≈ 生成一个所有字段可空的 Builder 半成品。为什么这里要用它？
 *    因为渲染发生在模型**流式输出**期间，参数可能才打了一半，字段还没齐。
 *  - 解构参数 `{ verbose }: { verbose: boolean }`：
 *    ≈ 直接把入参对象的字段拆出来用（Java 21 的记录模式匹配，但 TS 里是日常操作）。
 *    前缀下划线 `_progressMessages` 表示"这个参数我故意不用"（绕过 lint 告警）。
 *  - `typeof x === 'string' ? A : B` 三元：TS 里**收窄类型**的常用手段，
 *    进去之后编译器就知道 x 是 string 了（≈ Java 的 instanceof 模式匹配）。
 *  - `'routing' in result`  `in` 运算符：判断对象上有没有这个属性，
 *    用来在联合类型里分辨具体是哪一个分支。
 *  - 文件末尾那行 `//# sourceMappingURL=...` 是 sourcemap 数据，**不要动它**。
 */
import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Text } from '../../ink.js';
import { jsonParse } from '../../utils/slowOperations.js';
import type { Input, SendMessageToolOutput } from './SendMessageTool.js';
/**
 * 模型「刚发起 SendMessage 调用」时，终端上显示什么。
 *
 * 为什么需要：工具调用要在界面上有即时反馈，否则用户不知道模型在干什么。
 *
 * @param input 工具入参（Partial：流式输出期间字段可能还没齐，所以全都当可选处理）。
 * @returns React 节点；返回 **null** 表示"这一条不需要显示"。
 *
 * 关键步骤：
 *   ① 只处理结构化消息（message 是对象）—— 普通文本消息不在这里显示
 *   ② 只处理 plan_approval_response —— 批准/打回计划这种"决策动作"值得给用户看
 *   ③ 其余一律返回 null（普通发消息由收件方会话自己渲染，这里不重复刷屏）
 */
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  // `typeof x !== 'object'` 是 TS 里区分"基本类型 / 对象"的标准写法。
  // 注意 typeof null 也是 'object'，所以必须再补一个 `=== null` 的判断，
  // 这是 JS 的历史坑（Java 里没有这个坑，因为类型系统更严）。
  if (typeof input.message !== 'object' || input.message === null) {
    return null;
  }
  if (input.message.type === 'plan_approval_response') {
    return input.message.approve ? `approve plan from: ${input.to}` : `reject plan from: ${input.to}`;
  }
  return null;
}
/**
 * 调用「出结果之后」，终端上显示什么。
 *
 * 为什么需要：把工具返回的成功/失败信息反馈给用户，形成闭环。
 *
 * @param content           工具的返回值。**可能是对象，也可能是字符串**——
 *                          结果被持久化到磁盘再读回来时会变成 JSON 字符串，
 *                          所以两种形态都要能处理（这就是下面 jsonParse 的原因）。
 * @param _progressMessages 进度消息，本工具不用（下划线前缀 = 故意忽略）。
 * @param verbose           是否详细模式（本工具未使用，但签名要对齐框架契约）。
 * @returns React 节点；返回 null 表示不显示。
 *
 * 关键步骤：
 *   ① 如果是字符串就先 JSON 反序列化回对象（兼容"落盘再读回"的场景）
 *   ② 带 routing 的结果（单发/群发）返回 null —— 消息内容会在收件人那边显示
 *   ③ 带 request_id + target 的结果（停机请求）也返回 null —— 同上，避免重复
 *   ④ 其它情况（错误、无法投递等）才真的渲染一行灰字
 */
export function renderToolResultMessage(content: SendMessageToolOutput | string, _progressMessages: unknown, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  // 为什么要兼容字符串：工具结果超过阈值时会被写到磁盘，读回来就成了 JSON 文本。
  // 这种"同一个字段可能是对象也可能是字符串"的写法在 TS 里叫 union，
  // 要先靠 typeof 收窄才能安全使用（≈ Java 的 instanceof 判断后强转）。
  const result: SendMessageToolOutput = typeof content === 'string' ? jsonParse(content) : content;
  // 单发/群发的成功结果里带 routing（发件人、收件人等元数据）。
  // 这类结果故意不渲染：消息正文已经渲染到收件人那边了，这儿再打一遍就是重复。
  if ('routing' in result && result.routing) {
    return null;
  }
  // 停机请求的结果（同时有 request_id 和 target）：同样不在这里显示。
  // 判断为什么用两个字段同时存在？因为 ResponseOutput 只有 request_id、没有 target，
  // 用两个字段组合才能精确区分"发起请求"和"响应请求"这两种返回形状。
  if ('request_id' in result && 'target' in result) {
    return null;
  }
  // JSX：≈ React 组件树。<MessageResponse> 是统一的消息容器，
  // <Text dimColor> 里的 dimColor 表示"暗色/次要文字"（终端里的灰色）。
  return <MessageResponse>
      <Text dimColor>{result.message}</Text>
    </MessageResponse>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsIlRleHQiLCJqc29uUGFyc2UiLCJJbnB1dCIsIlNlbmRNZXNzYWdlVG9vbE91dHB1dCIsInJlbmRlclRvb2xVc2VNZXNzYWdlIiwiaW5wdXQiLCJQYXJ0aWFsIiwiUmVhY3ROb2RlIiwibWVzc2FnZSIsInR5cGUiLCJhcHByb3ZlIiwidG8iLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsImNvbnRlbnQiLCJfcHJvZ3Jlc3NNZXNzYWdlcyIsInZlcmJvc2UiLCJyZXN1bHQiLCJyb3V0aW5nIl0sInNvdXJjZXMiOlsiVUkudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvTWVzc2FnZVJlc3BvbnNlLmpzJ1xuaW1wb3J0IHsgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IGpzb25QYXJzZSB9IGZyb20gJy4uLy4uL3V0aWxzL3Nsb3dPcGVyYXRpb25zLmpzJ1xuaW1wb3J0IHR5cGUgeyBJbnB1dCwgU2VuZE1lc3NhZ2VUb29sT3V0cHV0IH0gZnJvbSAnLi9TZW5kTWVzc2FnZVRvb2wuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlTWVzc2FnZShpbnB1dDogUGFydGlhbDxJbnB1dD4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAodHlwZW9mIGlucHV0Lm1lc3NhZ2UgIT09ICdvYmplY3QnIHx8IGlucHV0Lm1lc3NhZ2UgPT09IG51bGwpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIGlmIChpbnB1dC5tZXNzYWdlLnR5cGUgPT09ICdwbGFuX2FwcHJvdmFsX3Jlc3BvbnNlJykge1xuICAgIHJldHVybiBpbnB1dC5tZXNzYWdlLmFwcHJvdmVcbiAgICAgID8gYGFwcHJvdmUgcGxhbiBmcm9tOiAke2lucHV0LnRvfWBcbiAgICAgIDogYHJlamVjdCBwbGFuIGZyb206ICR7aW5wdXQudG99YFxuICB9XG4gIHJldHVybiBudWxsXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShcbiAgY29udGVudDogU2VuZE1lc3NhZ2VUb29sT3V0cHV0IHwgc3RyaW5nLFxuICBfcHJvZ3Jlc3NNZXNzYWdlczogdW5rbm93bixcbiAgeyB2ZXJib3NlIH06IHsgdmVyYm9zZTogYm9vbGVhbiB9LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgcmVzdWx0OiBTZW5kTWVzc2FnZVRvb2xPdXRwdXQgPVxuICAgIHR5cGVvZiBjb250ZW50ID09PSAnc3RyaW5nJyA/IGpzb25QYXJzZShjb250ZW50KSA6IGNvbnRlbnRcblxuICBpZiAoJ3JvdXRpbmcnIGluIHJlc3VsdCAmJiByZXN1bHQucm91dGluZykge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICBpZiAoJ3JlcXVlc3RfaWQnIGluIHJlc3VsdCAmJiAndGFyZ2V0JyBpbiByZXN1bHQpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgPFRleHQgZGltQ29sb3I+e3Jlc3VsdC5tZXNzYWdlfTwvVGV4dD5cbiAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPQSxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxlQUFlLFFBQVEscUNBQXFDO0FBQ3JFLFNBQVNDLElBQUksUUFBUSxjQUFjO0FBQ25DLFNBQVNDLFNBQVMsUUFBUSwrQkFBK0I7QUFDekQsY0FBY0MsS0FBSyxFQUFFQyxxQkFBcUIsUUFBUSxzQkFBc0I7QUFFeEUsT0FBTyxTQUFTQyxvQkFBb0JBLENBQUNDLEtBQUssRUFBRUMsT0FBTyxDQUFDSixLQUFLLENBQUMsQ0FBQyxFQUFFSixLQUFLLENBQUNTLFNBQVMsQ0FBQztFQUMzRSxJQUFJLE9BQU9GLEtBQUssQ0FBQ0csT0FBTyxLQUFLLFFBQVEsSUFBSUgsS0FBSyxDQUFDRyxPQUFPLEtBQUssSUFBSSxFQUFFO0lBQy9ELE9BQU8sSUFBSTtFQUNiO0VBQ0EsSUFBSUgsS0FBSyxDQUFDRyxPQUFPLENBQUNDLElBQUksS0FBSyx3QkFBd0IsRUFBRTtJQUNuRCxPQUFPSixLQUFLLENBQUNHLE9BQU8sQ0FBQ0UsT0FBTyxHQUN4QixzQkFBc0JMLEtBQUssQ0FBQ00sRUFBRSxFQUFFLEdBQ2hDLHFCQUFxQk4sS0FBSyxDQUFDTSxFQUFFLEVBQUU7RUFDckM7RUFDQSxPQUFPLElBQUk7QUFDYjtBQUVBLE9BQU8sU0FBU0MsdUJBQXVCQSxDQUNyQ0MsT0FBTyxFQUFFVixxQkFBcUIsR0FBRyxNQUFNLEVBQ3ZDVyxpQkFBaUIsRUFBRSxPQUFPLEVBQzFCO0VBQUVDO0FBQThCLENBQXJCLEVBQUU7RUFBRUEsT0FBTyxFQUFFLE9BQU87QUFBQyxDQUFDLENBQ2xDLEVBQUVqQixLQUFLLENBQUNTLFNBQVMsQ0FBQztFQUNqQixNQUFNUyxNQUFNLEVBQUViLHFCQUFxQixHQUNqQyxPQUFPVSxPQUFPLEtBQUssUUFBUSxHQUFHWixTQUFTLENBQUNZLE9BQU8sQ0FBQyxHQUFHQSxPQUFPO0VBRTVELElBQUksU0FBUyxJQUFJRyxNQUFNLElBQUlBLE1BQU0sQ0FBQ0MsT0FBTyxFQUFFO0lBQ3pDLE9BQU8sSUFBSTtFQUNiO0VBRUEsSUFBSSxZQUFZLElBQUlELE1BQU0sSUFBSSxRQUFRLElBQUlBLE1BQU0sRUFBRTtJQUNoRCxPQUFPLElBQUk7RUFDYjtFQUVBLE9BQ0UsQ0FBQyxlQUFlO0FBQ3BCLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUNBLE1BQU0sQ0FBQ1IsT0FBTyxDQUFDLEVBQUUsSUFBSTtBQUMzQyxJQUFJLEVBQUUsZUFBZSxDQUFDO0FBRXRCIiwiaWdub3JlTGlzdCI6W119