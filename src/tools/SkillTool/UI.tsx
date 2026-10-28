/**
 * ============================================================================
 *  【文件总览】src/tools/SkillTool/UI.tsx —— Skill 工具的「终端渲染层」
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件只管**怎么把 Skill 工具画到终端上**，不含任何业务逻辑。
 *  它导出一组 render* 函数，被 SkillTool.ts 以配置项的形式挂上去
 *  （见 SkillTool.ts 末尾的 renderToolResultMessage / renderToolUseMessage 等）。
 *
 *  【在架构中的位置】
 *
 *      模型请求调用 Skill 工具
 *        └─> SkillTool.call()                    ← src/tools/SkillTool/SkillTool.ts
 *              └─> 拿到 Output 后交给渲染层
 *                    └─> renderToolResultMessage(...)   ← ★ 本文件
 *                          └─> <MessageResponse> / <Byline>   ← src/components/**
 *                                └─> Ink 把 React 元素画成终端字符
 *
 *      fork 模式下子 agent 的每一步进度：
 *        └─> SkillTool.call() 里的 onProgress(...)
 *              └─> renderToolUseProgressMessage(...)    ← ★ 本文件
 *
 *  为什么要单独拆一个 UI 文件？这是**关注点分离**：
 *  SkillTool.ts 关心"skill 怎么执行"，UI.tsx 关心"长什么样"。
 *  这样同一份逻辑可以有不同呈现（比如 JSON 输出模式就不走这些函数）。
 *
 *  【本文件包含什么】（5 个渲染函数，一一对应工具的 5 种状态）
 *   1. renderToolResultMessage()       成功结果：`Successfully loaded skill`
 *   2. renderToolUseMessage()          工具被调用时显示的名字（/pdf 还是 pdf）
 *   3. renderToolUseProgressMessage()  执行中：展示子 agent 的进度消息
 *   4. renderToolUseRejectedMessage()  用户拒绝：进度 + 拒绝提示
 *   5. renderToolUseErrorMessage()     执行失败：进度 + 错误提示
 *
 * ---------------------------------------------------------------------------
 *  【TS / TSX 语法速查】（针对本文件实际出现的语法）
 * ---------------------------------------------------------------------------
 *   - 文件名 `.tsx` 而不是 `.ts`：**因为里面有 JSX**。
 *     JSX 就是可以在代码里直接写 `<Box><Text>hi</Text></Box>`
 *     ≈ Java 里没有；想象成在代码里写 XML/HTML 字面量，
 *     编译后会变成 `React.createElement(...)` 调用。
 *
 *   - `React.ReactNode`  返回值类型 = "任何可以被 React 渲染的东西"
 *     （元素、字符串、null、数组都行）≈ Java 的 Object，但专用于渲染。
 *     注意 renderToolUseMessage 返回 `null` 是合法的，表示"什么都不画"。
 *
 *   - `Partial<Input>`  **工具类型（utility type）**：把 Input 的所有字段
 *     变成可选。≈ Java 没有；想象成生成一个所有字段都可空的新 DTO。
 *     为什么这里用 Partial？因为工具调用刚发起时，模型给的参数可能
 *     还没解析完整（流式），字段可能缺失。
 *
 *   - `z.infer<ReturnType<typeof inputSchema>>`
 *     **类型层面的"反向推导"**：从 zod schema 反向推出 TS 类型。
 *     ≈ Java 里靠注解处理器生成 DTO；TS 里纯靠类型系统，运行时零成本。
 *     这样 schema 改了，类型自动跟着变，不用两处维护。
 *
 *   - 解构参数 + 类型标注写在一起：
 *         function f({ skill }: Partial<Input>, { commands }: { commands?: Command[] })
 *     ≈ Java 里没有"解构参数"，只能 `f(Map<String,Object> opts)` 再 get。
 *     注意第二个参数也是对象解构，所以整个函数实际只接 2 个参数。
 *
 *   - `progressMessages.slice(-3)`  **负索引**取得最后 3 个元素
 *     ≈ Java 的 `list.subList(size-3, size)`；TS/Python 都支持这种写法。
 *
 *   - `'status' in output`  **in 运算符做类型收窄**：
 *     Output 是联合类型（inline 结果 | forked 结果），
 *     用 in 判断某个字段是否存在后，TS 就知道是哪一个分支了
 *     ≈ Java `if (o instanceof ForkedOutput f)`。
 *
 *   - `<>...</>`  **Fragment（片段）**：一个不产生真实节点的包裹容器，
 *     用于一次返回多个并列元素 ≈ JavaFX 里没有，但类似"虚拟父节点"。
 *
 *   - `{hiddenCount > 0 && <Text .../>}`  JSX 里用 `&&` 做条件渲染。
 *     原理：`false && x` 得到 false，而 React 渲染 false 等于什么都没有。
 *     （⚠️ 坑：如果左边是 0，`0 && x` 得到 0，React 会把 "0" 画出来！
 *       所以严谨写法是 `hiddenCount > 0 && ...`，本文件正是这么写的。）
 *
 *   - `.map(pm => ...)` 返回 JSX 数组时，每个元素必须带 `key` 属性
 *     （React 用来做最小化重绘的标识）≈ Java 里给列表项一个稳定 id。
 *
 *   - `as const`：见 SkillTool.ts；`type X as const` 让字面量类型不被放宽。
 *
 *   - 文件末尾那串 `//# sourceMappingURL=data:...` 是**内联 sourcemap**，
 *     把编译后代码映射回原始 .tsx 源码，方便调试。不是业务代码，忽略即可。
 * ============================================================================
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { SubAgentProvider } from 'src/components/CtrlOToExpand.js';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';
import { FallbackToolUseRejectedMessage } from 'src/components/FallbackToolUseRejectedMessage.js';
import type { z } from 'zod/v4';
import type { Command } from '../../commands.js';
import { Byline } from '../../components/design-system/Byline.js';
import { Message as MessageComponent } from '../../components/Message.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Box, Text } from '../../ink.js';
import type { Tools } from '../../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import { buildSubagentLookups, EMPTY_LOOKUPS } from '../../utils/messages.js';
import { plural } from '../../utils/stringUtils.js';
import type { inputSchema, Output, Progress } from './SkillTool.js';
type Input = z.infer<ReturnType<typeof inputSchema>>;
// 非 verbose 模式下最多显示几条子 agent 的进度消息。
// 为什么要限制？终端屏幕高度有限，而且 fork 模式的 skill 可能跑几十步，
// 全部画出来会把用户的滚屏历史冲掉。
const MAX_PROGRESS_MESSAGES_TO_SHOW = 3;
// 还没有任何进度消息时显示的占位文案（子 agent 刚启动、还没吐出东西）
const INITIALIZING_TEXT = 'Initializing…';

/**
 * 渲染 Skill 工具**执行成功**后的那一行结果。
 *
 * 为什么需要：工具跑完了得给用户一个可见的交代。这里按执行模式分成两种：
 *   - forked（在子 agent 里跑的）：只显示 `Done`，因为详细过程已经在
 *     进度消息里实时展示过了，再重复一遍没意义；
 *   - inline（把提示词直接注入当前对话）：显示
 *     `Successfully loaded skill`，并附上这次允许了哪些工具、用了哪个 model。
 *
 * 入参/返回：
 * @param output SkillTool.call() 返回的数据（inline 或 forked 两种形态）
 * @returns 一个 React 节点，交给 Ink 渲染成终端字符
 */
export function renderToolResultMessage(output: Output): React.ReactNode {
  // Handle forked skill result
  // 中文补充：`'status' in output` 是在**辨别联合类型的分支**。
  // Output = inline 结果 | forked 结果，两者字段不同；
  // 判断 status 字段存在后，TS 才允许你访问 output.result。
  // ≈ Java 的 if (o instanceof ForkedOutput f) { ... }
  if ('status' in output && output.status === 'forked') {
    return <MessageResponse height={1}>
        <Text>
          <Byline>{['Done']}</Byline>
        </Text>
      </MessageResponse>;
  }
  // 中文补充：用数组收集要展示的"标签"，最后统一交给 <Byline> 排版。
  // Byline 是设计系统里的"一行小字"组件（类似命令行工具的状态栏）。
  const parts: string[] = ['Successfully loaded skill'];

  // Show tools count (only for inline skills)
  // 中文补充：skill 可以在 frontmatter 里声明 allowed-tools，
  // 加载后这些工具会被临时加进白名单。这里告诉用户"放开了哪些权限"，
  // 属于安全透明度——用户应该看得见 skill 给自己加了什么能力。
  if ('allowedTools' in output && output.allowedTools && output.allowedTools.length > 0) {
    const count = output.allowedTools.length;
    // 中文补充：plural(count, 'tool') 会按数量返回 'tool' 或 'tools'。
    // 英文有单复数变化，所以需要一个专门的辅助函数；中文就不需要。
    parts.push(`${count} ${plural(count, 'tool')} allowed`);
  }

  // Show model if non-default (only for inline skills)
  // 中文补充：skill 可以指定用别的模型跑（比如 heavy 任务指定 opus）。
  // 只在**非默认**时才显示，避免每回都刷一遍无信息量的默认名。
  if ('model' in output && output.model) {
    parts.push(output.model);
  }
  return <MessageResponse height={1}>
      <Text>
        <Byline>{parts}</Byline>
      </Text>
    </MessageResponse>;
}
/**
 * 渲染 Skill 工具**被调用时**显示的名字。
 *
 * 为什么需要：模型请求一次 Skill 调用时，终端要显示"正在执行 xxx"。
 * 这里有个历史包袱要处理：老版本 Claude Code 的自定义命令放在
 * `.claude/commands/` 目录里，用户习惯写成 `/foo`（带斜杠）；
 * 新版 skill 不带斜杠。为了不破坏老用户的肌肉记忆，
 * 来自废弃目录的命令仍然显示成 `/foo`。
 *
 * @param input 工具入参（Partial：流式解析时字段可能还没齐）
 * @param opts.commands 当前可用命令列表，用来反查这个 skill 的来源
 * @returns 要显示的字符串；skill 名为空时返回 null（什么都不显示）
 */
export function renderToolUseMessage({
  skill
}: Partial<Input>, {
  commands
}: {
  commands?: Command[];
}): React.ReactNode {
  // 中文补充：skill 还没解析出来就先不画。返回 null 在 React 里是合法的
  // "什么都不渲染"，比返回空字符串更明确。
  if (!skill) {
    return null;
  }
  // Look up the command to check if it came from the legacy /commands folder
  // 中文补充：`commands?.find(...)` 的 ?. 是可选链：commands 可能没传，
  // 不写 ?. 会在 undefined 上调 .find() 直接崩。
  // ≈ Java 的 `commands != null ? commands.stream().filter(...) : null`
  const command = commands?.find(c => c.name === skill);
  // 中文补充：loadedFrom === 'commands_DEPRECATED' 标记"来自已废弃的旧目录"。
  // 只有这批老命令才补上斜杠前缀 —— 兼容老习惯，同时不污染新 skill 的显示。
  const displayName = command?.loadedFrom === 'commands_DEPRECATED' ? `/${skill}` : skill;
  return displayName;
}
/**
 * 渲染 Skill **执行过程中**的进度（fork 模式下子 agent 的每一步）。
 *
 * 为什么需要：fork 模式的 skill 是在一个独立子 agent 里跑的，
 * 可能持续几十秒、调用几十次工具。必须实时把子 agent 的动向透出来，
 * 否则用户会以为卡死了。
 *
 * 关键步骤：
 *   ① 一条进度都没有 → 显示 `Initializing…`（子 agent 刚起步）；
 *   ② 非 verbose 模式只取**最后 3 条**（老的会被滚上去看不见，留着也没意义），
 *     并算出"还藏了几条"；verbose 模式则全量展示；
 *   ③ 用 buildSubagentLookups 算出哪些工具调用还在进行中（要显示转圈动画）；
 *   ④ 逐条渲染成"精简版"消息行（style="condensed"），最后补一行 `+N more`。
 *
 * @param progressMessages 累积到的进度消息（每条裹着子 agent 的一条消息）
 * @param opts.tools 工具注册表，渲染子消息时需要知道每个工具怎么画
 * @param opts.verbose 是否全量展开
 * @returns React 节点
 */
export function renderToolUseProgressMessage(progressMessages: ProgressMessage<Progress>[], {
  tools,
  verbose
}: {
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  // 中文补充：一个进度都还没有 —— 子 agent 刚被拉起来，还没吐出任何东西。
  // 这时给个占位文案，比空白更能安抚用户（"它在动，只是还没产出"）。
  if (!progressMessages.length) {
    return <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>;
  }

  // Take only the last few messages for display in non-verbose mode
  // 中文补充：slice(-3) 取最后 3 条 —— 负索引是 TS/Python 的便利语法，
  // Java 得写 list.subList(Math.max(0, size-3), size)。
  const displayedMessages = verbose ? progressMessages : progressMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW);
  const hiddenCount = progressMessages.length - displayedMessages.length;
  // 中文补充：buildSubagentLookups 会扫一遍全部进度消息，
  // 找出"发起了但还没返回结果"的 tool_use id 集合 —— 有了它，
  // 渲染时才知道哪一行要显示"进行中"的转圈动画。
  // 注意这里传的是**完整列表**而不是裁剪后的，否则正在跑的老调用会被误判为已完成。
  const {
    inProgressToolUseIDs
  } = buildSubagentLookups(progressMessages.map(pm => pm.data));
  return <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {displayedMessages.map(progressMessage => <Box key={progressMessage.uuid} height={1} overflow="hidden">
              <MessageComponent message={progressMessage.data.message} lookups={EMPTY_LOOKUPS} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} style="condensed" isTranscriptMode={false} isStatic={true} />
            </Box>)}
        </SubAgentProvider>
        {hiddenCount > 0 && <Text dimColor>
            +{hiddenCount} more tool {plural(hiddenCount, 'use')}
          </Text>}
      </Box>
    </MessageResponse>;
}
/**
 * 渲染 Skill **被用户拒绝**时的画面。
 *
 * 为什么需要：用户在权限弹窗里点了 No，得明确显示"这次调用没执行"。
 * 但拒绝不等于"什么都没发生"——fork 模式下子 agent 可能已经跑了几步，
 * 所以这里**先复用进度渲染**把已发生的过程展示出来，再追加一行拒绝提示。
 * 这样用户能看到"我是在第 3 步叫停的"，而不是一片空白。
 *
 * @param _input 工具入参；下划线前缀 = 这里用不到（拒绝画面不需要展示参数）
 * @param opts.progressMessagesForMessage 这条工具调用累积到的进度消息
 * @param opts.tools 工具注册表
 * @param opts.verbose 是否全量展开
 * @returns React 节点
 */
export function renderToolUseRejectedMessage(_input: Input, {
  progressMessagesForMessage,
  tools,
  verbose
}: {
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose
    })}
      <FallbackToolUseRejectedMessage />
    </>;
}
/**
 * 渲染 Skill **执行失败**时的画面。
 *
 * 为什么需要：与"被拒绝"同理——失败也可能发生在子 agent 跑了若干步之后，
 * 只显示一个错误会让用户失去上下文。所以策略完全一致：
 * 先画已发生的进度，再追加错误信息。
 *
 * @param result 错误内容（来自 API 的 tool_result content，可能是字符串或块数组）
 * @param opts.progressMessagesForMessage 这条工具调用累积到的进度消息
 * @param opts.tools 工具注册表
 * @param opts.verbose 是否全量展开
 * @returns React 节点
 */
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  progressMessagesForMessage,
  tools,
  verbose
}: {
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose
    })}
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUb29sUmVzdWx0QmxvY2tQYXJhbSIsIlJlYWN0IiwiU3ViQWdlbnRQcm92aWRlciIsIkZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSIsIkZhbGxiYWNrVG9vbFVzZVJlamVjdGVkTWVzc2FnZSIsInoiLCJDb21tYW5kIiwiQnlsaW5lIiwiTWVzc2FnZSIsIk1lc3NhZ2VDb21wb25lbnQiLCJNZXNzYWdlUmVzcG9uc2UiLCJCb3giLCJUZXh0IiwiVG9vbHMiLCJQcm9ncmVzc01lc3NhZ2UiLCJidWlsZFN1YmFnZW50TG9va3VwcyIsIkVNUFRZX0xPT0tVUFMiLCJwbHVyYWwiLCJpbnB1dFNjaGVtYSIsIk91dHB1dCIsIlByb2dyZXNzIiwiSW5wdXQiLCJpbmZlciIsIlJldHVyblR5cGUiLCJNQVhfUFJPR1JFU1NfTUVTU0FHRVNfVE9fU0hPVyIsIklOSVRJQUxJWklOR19URVhUIiwicmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2UiLCJvdXRwdXQiLCJSZWFjdE5vZGUiLCJzdGF0dXMiLCJwYXJ0cyIsImFsbG93ZWRUb29scyIsImxlbmd0aCIsImNvdW50IiwicHVzaCIsIm1vZGVsIiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJza2lsbCIsIlBhcnRpYWwiLCJjb21tYW5kcyIsImNvbW1hbmQiLCJmaW5kIiwiYyIsIm5hbWUiLCJkaXNwbGF5TmFtZSIsImxvYWRlZEZyb20iLCJyZW5kZXJUb29sVXNlUHJvZ3Jlc3NNZXNzYWdlIiwicHJvZ3Jlc3NNZXNzYWdlcyIsInRvb2xzIiwidmVyYm9zZSIsImRpc3BsYXllZE1lc3NhZ2VzIiwic2xpY2UiLCJoaWRkZW5Db3VudCIsImluUHJvZ3Jlc3NUb29sVXNlSURzIiwibWFwIiwicG0iLCJkYXRhIiwicHJvZ3Jlc3NNZXNzYWdlIiwidXVpZCIsIm1lc3NhZ2UiLCJyZW5kZXJUb29sVXNlUmVqZWN0ZWRNZXNzYWdlIiwiX2lucHV0IiwicHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJyZW5kZXJUb29sVXNlRXJyb3JNZXNzYWdlIiwicmVzdWx0Il0sInNvdXJjZXMiOlsiVUkudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVG9vbFJlc3VsdEJsb2NrUGFyYW0gfSBmcm9tICdAYW50aHJvcGljLWFpL3Nkay9yZXNvdXJjZXMvaW5kZXgubWpzJ1xuaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBTdWJBZ2VudFByb3ZpZGVyIH0gZnJvbSAnc3JjL2NvbXBvbmVudHMvQ3RybE9Ub0V4cGFuZC5qcydcbmltcG9ydCB7IEZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSB9IGZyb20gJ3NyYy9jb21wb25lbnRzL0ZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZS5qcydcbmltcG9ydCB7IEZhbGxiYWNrVG9vbFVzZVJlamVjdGVkTWVzc2FnZSB9IGZyb20gJ3NyYy9jb21wb25lbnRzL0ZhbGxiYWNrVG9vbFVzZVJlamVjdGVkTWVzc2FnZS5qcydcbmltcG9ydCB0eXBlIHsgeiB9IGZyb20gJ3pvZC92NCdcbmltcG9ydCB0eXBlIHsgQ29tbWFuZCB9IGZyb20gJy4uLy4uL2NvbW1hbmRzLmpzJ1xuaW1wb3J0IHsgQnlsaW5lIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9kZXNpZ24tc3lzdGVtL0J5bGluZS5qcydcbmltcG9ydCB7IE1lc3NhZ2UgYXMgTWVzc2FnZUNvbXBvbmVudCB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvTWVzc2FnZS5qcydcbmltcG9ydCB7IE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvTWVzc2FnZVJlc3BvbnNlLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHR5cGUgeyBUb29scyB9IGZyb20gJy4uLy4uL1Rvb2wuanMnXG5pbXBvcnQgdHlwZSB7IFByb2dyZXNzTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgeyBidWlsZFN1YmFnZW50TG9va3VwcywgRU1QVFlfTE9PS1VQUyB9IGZyb20gJy4uLy4uL3V0aWxzL21lc3NhZ2VzLmpzJ1xuaW1wb3J0IHsgcGx1cmFsIH0gZnJvbSAnLi4vLi4vdXRpbHMvc3RyaW5nVXRpbHMuanMnXG5pbXBvcnQgdHlwZSB7IGlucHV0U2NoZW1hLCBPdXRwdXQsIFByb2dyZXNzIH0gZnJvbSAnLi9Ta2lsbFRvb2wuanMnXG5cbnR5cGUgSW5wdXQgPSB6LmluZmVyPFJldHVyblR5cGU8dHlwZW9mIGlucHV0U2NoZW1hPj5cblxuY29uc3QgTUFYX1BST0dSRVNTX01FU1NBR0VTX1RPX1NIT1cgPSAzXG5jb25zdCBJTklUSUFMSVpJTkdfVEVYVCA9ICdJbml0aWFsaXppbmfigKYnXG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShvdXRwdXQ6IE91dHB1dCk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIC8vIEhhbmRsZSBmb3JrZWQgc2tpbGwgcmVzdWx0XG4gIGlmICgnc3RhdHVzJyBpbiBvdXRwdXQgJiYgb3V0cHV0LnN0YXR1cyA9PT0gJ2ZvcmtlZCcpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPE1lc3NhZ2VSZXNwb25zZSBoZWlnaHQ9ezF9PlxuICAgICAgICA8VGV4dD5cbiAgICAgICAgICA8QnlsaW5lPntbJ0RvbmUnXX08L0J5bGluZT5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgKVxuICB9XG5cbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gWydTdWNjZXNzZnVsbHkgbG9hZGVkIHNraWxsJ11cblxuICAvLyBTaG93IHRvb2xzIGNvdW50IChvbmx5IGZvciBpbmxpbmUgc2tpbGxzKVxuICBpZiAoXG4gICAgJ2FsbG93ZWRUb29scycgaW4gb3V0cHV0ICYmXG4gICAgb3V0cHV0LmFsbG93ZWRUb29scyAmJlxuICAgIG91dHB1dC5hbGxvd2VkVG9vbHMubGVuZ3RoID4gMFxuICApIHtcbiAgICBjb25zdCBjb3VudCA9IG91dHB1dC5hbGxvd2VkVG9vbHMubGVuZ3RoXG4gICAgcGFydHMucHVzaChgJHtjb3VudH0gJHtwbHVyYWwoY291bnQsICd0b29sJyl9IGFsbG93ZWRgKVxuICB9XG5cbiAgLy8gU2hvdyBtb2RlbCBpZiBub24tZGVmYXVsdCAob25seSBmb3IgaW5saW5lIHNraWxscylcbiAgaWYgKCdtb2RlbCcgaW4gb3V0cHV0ICYmIG91dHB1dC5tb2RlbCkge1xuICAgIHBhcnRzLnB1c2gob3V0cHV0Lm1vZGVsKVxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICA8VGV4dD5cbiAgICAgICAgPEJ5bGluZT57cGFydHN9PC9CeWxpbmU+XG4gICAgICA8L1RleHQ+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VNZXNzYWdlKFxuICB7IHNraWxsIH06IFBhcnRpYWw8SW5wdXQ+LFxuICB7IGNvbW1hbmRzIH06IHsgY29tbWFuZHM/OiBDb21tYW5kW10gfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGlmICghc2tpbGwpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIC8vIExvb2sgdXAgdGhlIGNvbW1hbmQgdG8gY2hlY2sgaWYgaXQgY2FtZSBmcm9tIHRoZSBsZWdhY3kgL2NvbW1hbmRzIGZvbGRlclxuICBjb25zdCBjb21tYW5kID0gY29tbWFuZHM/LmZpbmQoYyA9PiBjLm5hbWUgPT09IHNraWxsKVxuICBjb25zdCBkaXNwbGF5TmFtZSA9XG4gICAgY29tbWFuZD8ubG9hZGVkRnJvbSA9PT0gJ2NvbW1hbmRzX0RFUFJFQ0FURUQnID8gYC8ke3NraWxsfWAgOiBza2lsbFxuICByZXR1cm4gZGlzcGxheU5hbWVcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VQcm9ncmVzc01lc3NhZ2UoXG4gIHByb2dyZXNzTWVzc2FnZXM6IFByb2dyZXNzTWVzc2FnZTxQcm9ncmVzcz5bXSxcbiAge1xuICAgIHRvb2xzLFxuICAgIHZlcmJvc2UsXG4gIH06IHtcbiAgICB0b29sczogVG9vbHNcbiAgICB2ZXJib3NlOiBib29sZWFuXG4gIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAoIXByb2dyZXNzTWVzc2FnZXMubGVuZ3RoKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxNZXNzYWdlUmVzcG9uc2UgaGVpZ2h0PXsxfT5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+e0lOSVRJQUxJWklOR19URVhUfTwvVGV4dD5cbiAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgIClcbiAgfVxuXG4gIC8vIFRha2Ugb25seSB0aGUgbGFzdCBmZXcgbWVzc2FnZXMgZm9yIGRpc3BsYXkgaW4gbm9uLXZlcmJvc2UgbW9kZVxuICBjb25zdCBkaXNwbGF5ZWRNZXNzYWdlcyA9IHZlcmJvc2VcbiAgICA/IHByb2dyZXNzTWVzc2FnZXNcbiAgICA6IHByb2dyZXNzTWVzc2FnZXMuc2xpY2UoLU1BWF9QUk9HUkVTU19NRVNTQUdFU19UT19TSE9XKVxuXG4gIGNvbnN0IGhpZGRlbkNvdW50ID0gcHJvZ3Jlc3NNZXNzYWdlcy5sZW5ndGggLSBkaXNwbGF5ZWRNZXNzYWdlcy5sZW5ndGhcbiAgY29uc3QgeyBpblByb2dyZXNzVG9vbFVzZUlEcyB9ID0gYnVpbGRTdWJhZ2VudExvb2t1cHMoXG4gICAgcHJvZ3Jlc3NNZXNzYWdlcy5tYXAocG0gPT4gcG0uZGF0YSksXG4gIClcblxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgPFN1YkFnZW50UHJvdmlkZXI+XG4gICAgICAgICAge2Rpc3BsYXllZE1lc3NhZ2VzLm1hcChwcm9ncmVzc01lc3NhZ2UgPT4gKFxuICAgICAgICAgICAgPEJveCBrZXk9e3Byb2dyZXNzTWVzc2FnZS51dWlkfSBoZWlnaHQ9ezF9IG92ZXJmbG93PVwiaGlkZGVuXCI+XG4gICAgICAgICAgICAgIDxNZXNzYWdlQ29tcG9uZW50XG4gICAgICAgICAgICAgICAgbWVzc2FnZT17cHJvZ3Jlc3NNZXNzYWdlLmRhdGEubWVzc2FnZX1cbiAgICAgICAgICAgICAgICBsb29rdXBzPXtFTVBUWV9MT09LVVBTfVxuICAgICAgICAgICAgICAgIGFkZE1hcmdpbj17ZmFsc2V9XG4gICAgICAgICAgICAgICAgdG9vbHM9e3Rvb2xzfVxuICAgICAgICAgICAgICAgIGNvbW1hbmRzPXtbXX1cbiAgICAgICAgICAgICAgICB2ZXJib3NlPXt2ZXJib3NlfVxuICAgICAgICAgICAgICAgIGluUHJvZ3Jlc3NUb29sVXNlSURzPXtpblByb2dyZXNzVG9vbFVzZUlEc31cbiAgICAgICAgICAgICAgICBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZT17W119XG4gICAgICAgICAgICAgICAgc2hvdWxkQW5pbWF0ZT17ZmFsc2V9XG4gICAgICAgICAgICAgICAgc2hvdWxkU2hvd0RvdD17ZmFsc2V9XG4gICAgICAgICAgICAgICAgc3R5bGU9XCJjb25kZW5zZWRcIlxuICAgICAgICAgICAgICAgIGlzVHJhbnNjcmlwdE1vZGU9e2ZhbHNlfVxuICAgICAgICAgICAgICAgIGlzU3RhdGljPXt0cnVlfVxuICAgICAgICAgICAgICAvPlxuICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgKSl9XG4gICAgICAgIDwvU3ViQWdlbnRQcm92aWRlcj5cbiAgICAgICAge2hpZGRlbkNvdW50ID4gMCAmJiAoXG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgICAre2hpZGRlbkNvdW50fSBtb3JlIHRvb2wge3BsdXJhbChoaWRkZW5Db3VudCwgJ3VzZScpfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgKX1cbiAgICAgIDwvQm94PlxuICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlUmVqZWN0ZWRNZXNzYWdlKFxuICBfaW5wdXQ6IElucHV0LFxuICB7XG4gICAgcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UsXG4gICAgdG9vbHMsXG4gICAgdmVyYm9zZSxcbiAgfToge1xuICAgIHByb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlOiBQcm9ncmVzc01lc3NhZ2U8UHJvZ3Jlc3M+W11cbiAgICB0b29sczogVG9vbHNcbiAgICB2ZXJib3NlOiBib29sZWFuXG4gIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDw+XG4gICAgICB7cmVuZGVyVG9vbFVzZVByb2dyZXNzTWVzc2FnZShwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZSwge1xuICAgICAgICB0b29scyxcbiAgICAgICAgdmVyYm9zZSxcbiAgICAgIH0pfVxuICAgICAgPEZhbGxiYWNrVG9vbFVzZVJlamVjdGVkTWVzc2FnZSAvPlxuICAgIDwvPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlRXJyb3JNZXNzYWdlKFxuICByZXN1bHQ6IFRvb2xSZXN1bHRCbG9ja1BhcmFtWydjb250ZW50J10sXG4gIHtcbiAgICBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZSxcbiAgICB0b29scyxcbiAgICB2ZXJib3NlLFxuICB9OiB7XG4gICAgcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2U6IFByb2dyZXNzTWVzc2FnZTxQcm9ncmVzcz5bXVxuICAgIHRvb2xzOiBUb29sc1xuICAgIHZlcmJvc2U6IGJvb2xlYW5cbiAgfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiAoXG4gICAgPD5cbiAgICAgIHtyZW5kZXJUb29sVXNlUHJvZ3Jlc3NNZXNzYWdlKHByb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlLCB7XG4gICAgICAgIHRvb2xzLFxuICAgICAgICB2ZXJib3NlLFxuICAgICAgfSl9XG4gICAgICA8RmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlIHJlc3VsdD17cmVzdWx0fSB2ZXJib3NlPXt2ZXJib3NlfSAvPlxuICAgIDwvPlxu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