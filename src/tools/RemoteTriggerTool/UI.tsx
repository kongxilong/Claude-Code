/**
 * ============================================================================
 *  【文件总览】src/tools/RemoteTriggerTool/UI.tsx
 *              —— RemoteTrigger 工具的「终端渲染器」（只管画界面，不含业务逻辑）
 * ============================================================================
 *
 *  一句话定位：
 *  这个文件负责把 RemoteTriggerTool 的一次调用画成终端里的两行字：
 *      ● RemoteTrigger get my-trigger          ← renderToolUseMessage 画的
 *      ⎿  HTTP 200 (12 lines)                  ← renderToolResultMessage 画的
 *  它**不碰任何网络请求、不做任何校验**，纯粹是「模型数据 → 屏幕上的字符」的翻译层。
 *
 *  为什么要单独拆一个文件？
 *      · RemoteTriggerTool.ts 保持纯逻辑，便于单测（不依赖终端）；
 *      · 这里的渲染代码要 import React / ink 这类 UI 库，
 *        放进主文件会让「纯逻辑模块」被迫背上 UI 依赖。
 *  这是整个 src/tools/ 下通用的组织惯例：XXX.ts（逻辑）+ UI.tsx（渲染）。
 *
 * ---------------------------------------------------------------------------
 *  【在整个架构中的位置】调用链
 * ---------------------------------------------------------------------------
 *
 *      runTools() 执行完 tool.call() 拿到结果
 *        └─> 消息渲染管线 src/components/Messages.tsx
 *              ├─> tool.renderToolUseMessage(input)      ← ★ 本文件（显示"正在做什么"）
 *              └─> tool.renderToolResultMessage(output)  ← ★ 本文件（显示"做完了，结果是…"）
 *
 *  两个函数是被 RemoteTriggerTool.ts 末尾这样挂上去的：
 *      import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
 *      export const RemoteTriggerTool = buildTool({
 *          ...
 *          renderToolUseMessage,       // ← 直接把函数引用塞进去
 *          renderToolResultMessage,
 *      })
 *  ≈ Java 里把渲染器实例注入到工具对象上，属于「策略模式」的轻量写法。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】只有两个函数
 * ---------------------------------------------------------------------------
 *   1. renderToolUseMessage(input)       → 一行字符串：动作名 + trigger id
 *   2. renderToolResultMessage(output)   → 一个 React 组件：HTTP 状态码 + 响应行数
 *
 * ---------------------------------------------------------------------------
 *  【TS / TSX 语法速查】（针对本文件实际出现的写法，Java 工程师对照看）
 * ---------------------------------------------------------------------------
 *  - 文件后缀 `.tsx`：表示这个文件里可以写 **JSX**（长得像 HTML 的标记语法）。
 *    普通 `.ts` 里写 `<Text>` 会被当成「小于号 + 变量」而报错。
 *  - JSX ≈ React 的组件树。`<MessageResponse> <Text>…</Text> </MessageResponse>`
 *    本质上是函数调用的语法糖，最终产出一棵虚拟 DOM 树。
 *    ≈ Java 里用 builder 拼 UI 树，但写起来像 HTML。
 *  - `React.ReactNode` 返回值类型：表示「任何可被 React 渲染的东西」——
 *    字符串、数字、JSX 元素、null 都行。本文件两个函数恰好各用一种：
 *    第一个返回 string，第二个返回 JSX 元素。
 *  - `Partial<Input>`：把 Input 的所有字段都变成**可选**的工具类型。
 *    为什么这里要 Partial？因为工具还在流式生成中就被要求渲染标题了——
 *    此刻模型可能才吐出 `{"action": "g`，字段根本不全。用 Partial 逼自己写防御式取值。
 *    ≈ Java 里没有；近似「所有字段都是 @Nullable 的 DTO」。
 *  - `??` 空值合并：`input.action ?? ''` = action 为 null/undefined 时退化成空串。
 *    注意它**不会**把空字符串 `''` 也替换掉——那正是我们想要的（空还是空）。
 *  - `${...}` 模板字符串插值：反引号包起来的字符串里可以用 ${} 插入变量，还能直接换行。
 *    ≈ Java 的字符串拼接 "a" + x + "b"，TS 里写在串里更直观。
 *  - `input.trigger_id ? ... : ''` 三元表达式 ≈ Java 的三元运算符，用法完全一样。
 *  - `.map(k => ...)` ≈ stream().map(...)，箭头函数 ≈ Java 的 lambda。
 *  - 结尾那一长串 `//# sourceMappingURL=data:...` 是构建工具附带的
 *    **sourcemap 内联注释**（Base64 编码的原始 TSX 源码），用于调试时还原原始代码。
 *    它是机器生成的，**不要手改、也不要删**。
 *
 * ============================================================================
 */
import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Text } from '../../ink.js';
import { countCharInString } from '../../utils/stringUtils.js';
import type { Input, Output } from './RemoteTriggerTool.js';
/**
 * 渲染「工具正在被调用」时显示的那一行，例如：
 *      RemoteTrigger get abc-123
 *
 * 入参 input：模型的入参，**可能还不完整**（流式生成中途调用），所以类型是 Partial<Input>。
 * 返回值：React.ReactNode —— 这里实际返回的是一个普通字符串（字符串也是合法的 ReactNode）。
 *
 * 两个防御式写法（漏了就会打印出 "undefined" 这种字样给用户看）：
 *   ① action ?? ''       ：action 还没生成出来时退化为空串
 *   ② trigger_id ? ...   ：只有在 id 已存在时才拼上 " id"，否则整段省掉
 */
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  return `${input.action ?? ''}${input.trigger_id ? ` ${input.trigger_id}` : ''}`;
}
/**
 * 渲染「工具执行完毕」时显示的结果摘要，例如：
 *      HTTP 200 (12 lines)
 *
 * 入参 output：tool.call() 的返回值，含 status（HTTP 状态码）和 json（响应体字符串）。
 * 返回值：一段 JSX（会被终端 UI 框架 ink 渲染成带样式的文本）。
 *
 * 为什么只显示行数而不是把 JSON 全打印出来？
 *   因为 trigger 列表可能很长，全打印会把用户的屏幕刷爆。
 *   这里只给「状态码 + 行数」这个极简摘要，用户想看细节可以自己去展开。
 *
 * 关键步骤：
 *   ① countCharInString(json, '\n') + 1 —— 数换行符个数得到行数。
 *      加 1 是因为 "a\nb" 有 1 个换行符但是 2 行（末尾没有换行的最后一行也要算）。
 *      专门用这个函数而不是 `split('\n').length`，
 *      是为了避免在巨大字符串上先 split 出一个庞大的中间数组。
 *   ② 外层 MessageResponse 是统一的消息容器，负责缩进/换行/溢出裁剪等公共样式；
 *      内层 <Text> 才是真正的文本节点。
 *   ③ dimColor 让 "(12 lines)" 显示成灰色——视觉上弱化次要信息。
 */
export function renderToolResultMessage(output: Output): React.ReactNode {
  const lines = countCharInString(output.json, '\n') + 1;
  return <MessageResponse>
      <Text>
        HTTP {output.status} <Text dimColor>({lines} lines)</Text>
      </Text>
    </MessageResponse>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsIlRleHQiLCJjb3VudENoYXJJblN0cmluZyIsIklucHV0IiwiT3V0cHV0IiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJpbnB1dCIsIlBhcnRpYWwiLCJSZWFjdE5vZGUiLCJhY3Rpb24iLCJ0cmlnZ2VyX2lkIiwicmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2UiLCJvdXRwdXQiLCJsaW5lcyIsImpzb24iLCJzdGF0dXMiXSwic291cmNlcyI6WyJVSS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgY291bnRDaGFySW5TdHJpbmcgfSBmcm9tICcuLi8uLi91dGlscy9zdHJpbmdVdGlscy5qcydcbmltcG9ydCB0eXBlIHsgSW5wdXQsIE91dHB1dCB9IGZyb20gJy4vUmVtb3RlVHJpZ2dlclRvb2wuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlTWVzc2FnZShpbnB1dDogUGFydGlhbDxJbnB1dD4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gYCR7aW5wdXQuYWN0aW9uID8/ICcnfSR7aW5wdXQudHJpZ2dlcl9pZCA/IGAgJHtpbnB1dC50cmlnZ2VyX2lkfWAgOiAnJ31gXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShvdXRwdXQ6IE91dHB1dCk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IGxpbmVzID0gY291bnRDaGFySW5TdHJpbmcob3V0cHV0Lmpzb24sICdcXG4nKSArIDFcbiAgcmV0dXJuIChcbiAgICA8TWVzc2FnZVJlc3BvbnNlPlxuICAgICAgPFRleHQ+XG4gICAgICAgIEhUVFAge291dHB1dC5zdGF0dXN9IDxUZXh0IGRpbUNvbG9yPih7bGluZXN9IGxpbmVzKTwvVGV4dD5cbiAgICAgIDwvVGV4dD5cbiAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPQSxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxlQUFlLFFBQVEscUNBQXFDO0FBQ3JFLFNBQVNDLElBQUksUUFBUSxjQUFjO0FBQ25DLFNBQVNDLGlCQUFpQixRQUFRLDRCQUE0QjtBQUM5RCxjQUFjQyxLQUFLLEVBQUVDLE1BQU0sUUFBUSx3QkFBd0I7QUFFM0QsT0FBTyxTQUFTQyxvQkFBb0JBLENBQUNDLEtBQUssRUFBRUMsT0FBTyxDQUFDSixLQUFLLENBQUMsQ0FBQyxFQUFFSixLQUFLLENBQUNTLFNBQVMsQ0FBQztFQUMzRSxPQUFPLEdBQUdGLEtBQUssQ0FBQ0csTUFBTSxJQUFJLEVBQUUsR0FBR0gsS0FBSyxDQUFDSSxVQUFVLEdBQUcsSUFBSUosS0FBSyxDQUFDSSxVQUFVLEVBQUUsR0FBRyxFQUFFLEVBQUU7QUFDakY7QUFFQSxPQUFPLFNBQVNDLHVCQUF1QkEsQ0FBQ0MsTUFBTSxFQUFFUixNQUFNLENBQUMsRUFBRUwsS0FBSyxDQUFDUyxTQUFTLENBQUM7RUFDdkUsTUFBTUssS0FBSyxHQUFHWCxpQkFBaUIsQ0FBQ1UsTUFBTSxDQUFDRSxJQUFJLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQztFQUN0RCxPQUNFLENBQUMsZUFBZTtBQUNwQixNQUFNLENBQUMsSUFBSTtBQUNYLGFBQWEsQ0FBQ0YsTUFBTSxDQUFDRyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDRixLQUFLLENBQUMsT0FBTyxFQUFFLElBQUk7QUFDakUsTUFBTSxFQUFFLElBQUk7QUFDWixJQUFJLEVBQUUsZUFBZSxDQUFDO0FBRXRCIiwiaWdub3JlTGlzdCI6W119