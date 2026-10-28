/**
 * 【一句话定位】BashTool 的「展示层」：决定一条命令在终端里怎么显示（折叠标题、进度、结果、错误）。
 *   不含任何权限与安全判断，只负责渲染。
 *
 * 【在架构中的位置】
 *   上游：工具的渲染调度层（按 Tool 接口调用这里的 render* 函数）
 *   下游：BashToolResultMessage.tsx（结果展示）、commentLabel.js（取首行 # 注释当标题）、
 *        sedEditParser.js（把 sed 就地编辑识别成「改文件」来显示）、
 *        components/shell/ShellProgressMessage、components/MessageResponse、ink 的 Box/Text
 *   调用链：渲染层 -> renderToolUseMessage / renderToolUseProgressMessage / renderToolResultMessage /
 *            renderToolUseQueuedMessage / renderToolUseErrorMessage -> React 组件树
 *
 * 【本文件包含什么】
 *   - MAX_COMMAND_DISPLAY_LINES / MAX_COMMAND_DISPLAY_CHARS：命令显示的截断阈值
 *   - BackgroundHint：显示「ctrl+b 放到后台」的提示组件，并处理该快捷键
 *   - renderToolUseMessage()：命令「发起时」显示什么（是整条命令、还是文件路径、还是 # 注释）
 *   - renderToolUseProgressMessage()：命令「执行中」显示什么（实时输出）
 *   - renderToolUseQueuedMessage()：命令「排队中」显示 Waiting…
 *   - renderToolResultMessage()：命令「完成后」显示什么
 *   - renderToolUseErrorMessage()：命令「报错时」显示什么
 *
 * 【特别说明：本文件是 React Compiler 编译后的产物】
 *   注意 `_c(9)`、`$` 数组、`Symbol.for('react.memo_cache_sentinel')` 这些奇怪写法——
 *   它们是 React 编译器自动生成的「记忆化缓存」，等价于手写 useMemo。
 *   读代码时把 `if ($[i] !== x) { ... $[i] = x }` 整体理解为「x 变了才重算，否则复用上次结果」，
 *   t0/t1/t2… 是编译器起的临时变量名，本身没有业务含义
 *
 * 【TS/JSX 语法速查】（本文件实际出现的）
 *   - `.tsx` 后缀 = 允许在 TS 里写 JSX；JSX `<Text dimColor>...` ≈ 在 Java 里内嵌 XML/HTML 模板
 *   - JSX 里 `dimColor` 不写值等价于 `dimColor={true}`（布尔属性的简写）
 *   - `<>...</>` 是 Fragment（片段）≈ 不产生实际节点的包装，用于返回多个并列元素
 *   - `React.ReactNode` ≈ 「任何可渲染的东西」（节点 / 字符串 / null），类似 Java 的 Object 但用于渲染
 *   - `.at(-1)` 取数组最后一个元素（负数索引从末尾算），比 arr[arr.length-1] 简洁
 *   - `lastProgress?.data?.timeoutMs`：可选链，任一层为 null/undefined 就整体返回 undefined
 *   - `Partial<T>`：把 T 的所有字段变成可选
 *   - 参数解构 `function f({ verbose, theme: _theme }: {...})`：直接从对象入参里取字段；
 *     `theme: _theme` 表示「取 theme 字段但改名成 _theme」，下划线前缀表示不使用
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import { c as _c } from "react/compiler-runtime";
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { ShellProgressMessage } from '../../components/shell/ShellProgressMessage.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { useAppStateStore, useSetAppState } from '../../state/AppState.js';
import type { Tool } from '../../Tool.js';
import { backgroundAll } from '../../tasks/LocalShellTask/LocalShellTask.js';
import type { ProgressMessage } from '../../types/message.js';
import { env } from '../../utils/env.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { getDisplayPath } from '../../utils/file.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import type { ThemeName } from '../../utils/theme.js';
import type { BashProgress, BashToolInput, Out } from './BashTool.js';
import BashToolResultMessage from './BashToolResultMessage.js';
import { extractBashCommentLabel } from './commentLabel.js';
import { parseSedEditCommand } from './sedEditParser.js';

// Constants for command display
// 显示阈值：命令太长会刷屏。这两个常量控制「发起时」命令最多显示几行、多少字符
// 显示阈值：命令太长会刷屏。这两个常量控制「发起时」命令最多显示几行、多少字符
const MAX_COMMAND_DISPLAY_LINES = 2;
const MAX_COMMAND_DISPLAY_CHARS = 160;

// Simple component to show background hint and handle ctrl+b
// 中文补充：这个组件做两件事——① 显示快捷键提示；② 注册 ctrl+b 的处理逻辑。
//   注意快捷键按下时是把**所有**正在前台跑的命令一起放到后台，而不只是当前这一条
// When ctrl+b is pressed, backgrounds ALL running foreground commands
/**
 * 【做什么】渲染「ctrl+b 可放入后台」的提示，并绑定该快捷键
 * 【为什么需要】命令跑太久时用户希望能把它挂到后台继续干别的，需要有可见的入口提示
 * 【入参】t0：props，这里只用到 onBackground 回调（编译后 props 被合并成单个参数 t0）
 * 【返回】React 节点；若环境变量禁用了后台任务功能，返回 null（不渲染任何东西）
 * 【关键步骤】
 *   ① 取 store 与 setAppState（全局状态）
 *   ② 定义回调：backgroundAll 把所有前台命令转入后台，再调 onBackground
 *   ③ 用 useKeybinding 绑定 task:background 快捷键
 *   ④ tmux 下 ctrl+b 是 tmux 的前缀键，所以要提示连按两次（这是环境适配的坑）
 *   ⑤ 功能被禁用时直接 return null（早于渲染，避免无谓渲染）
 */
/**
 * 【做什么】渲染「ctrl+b 可放入后台」的提示，并绑定该快捷键
 * 【为什么需要】命令跑太久时用户希望能把它挂到后台继续干别的，需要有可见的入口提示
 * 【入参】t0：props，这里只用到 onBackground 回调（编译后 props 被合并成单个参数 t0）
 * 【返回】React 节点；若环境变量禁用了后台任务功能，返回 null（不渲染任何东西）
 * 【关键步骤】
 *   ① 取 store 与 setAppState（全局状态）
 *   ② 定义回调：backgroundAll 把所有前台命令转入后台，再调 onBackground
 *   ③ 用 useKeybinding 绑定 task:background 快捷键
 *   ④ tmux 下 ctrl+b 是 tmux 的前缀键，所以要提示连按两次（这是环境适配的坑）
 *   ⑤ 功能被禁用时直接 return null（早于渲染，避免无谓渲染）
 */
export function BackgroundHint(t0) {
  const $ = _c(9);
  let t1;
  if ($[0] !== t0) {
    t1 = t0 === undefined ? {} : t0;
    $[0] = t0;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const {
    onBackground
  } = t1;
  const store = useAppStateStore();
  const setAppState = useSetAppState();
  let t2;
  if ($[2] !== onBackground || $[3] !== setAppState || $[4] !== store) {
    t2 = () => {
      // backgroundAll 是「批量」而非单条：用户按一次键期望的是「把这些都挂后台」，
      //   逐条处理反而要按很多次，体验更差
      // backgroundAll 是「批量」而非单条：用户按一次键期望的是「把这些都挂后台」，
      //   逐条处理反而要按很多次，体验更差
      backgroundAll(() => store.getState(), setAppState);
      onBackground?.();
    };
    $[2] = onBackground;
    $[3] = setAppState;
    $[4] = store;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const handleBackground = t2;
  let t3;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = {
      context: "Task"
    };
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  useKeybinding("task:background", handleBackground, t3);
  const baseShortcut = useShortcutDisplay("task:background", "Task", "ctrl+b");
  // tmux 会先吃掉第一次 ctrl+b（它自己的前缀键），所以提示用户连按两次才能真正触发
  // tmux 会先吃掉第一次 ctrl+b（它自己的前缀键），所以提示用户连按两次才能真正触发
  const shortcut = env.terminal === "tmux" && baseShortcut === "ctrl+b" ? "ctrl+b ctrl+b (twice)" : baseShortcut;
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null;
  }
  let t4;
  if ($[7] !== shortcut) {
    t4 = <Box paddingLeft={5}><Text dimColor={true}><KeyboardShortcutHint shortcut={shortcut} action="run in background" parens={true} /></Text></Box>;
    $[7] = shortcut;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  return t4;
}
/**
 * 【做什么】决定命令「发起时」在终端上显示成什么样
 * 【为什么需要】把整条长命令原样刷给用户既占屏又难读；要按命令性质挑一个最有信息量的短表示
 * 【入参】input：工具入参（主要用 command）；{ verbose, theme }：verbose=true 表示展开模式
 * 【返回】React 节点；无命令时返回 null
 * 【关键步骤】
 *   ① sed 就地编辑（sed -i）特殊处理：它本质是「改文件」，所以直接显示文件路径（和 Edit 工具一致）
 *   ② 非 verbose 时尝试显示首行 # 注释当标签（全屏模式下才启用，因为那是折叠视图）
 *   ③ 仍然太长 → 先按行截断、再按字符截断，末尾加省略号 …
 *   ④ 都不需要处理 → 原样显示整条命令
 */
/**
 * 【做什么】决定命令「发起时」在终端上显示成什么样
 * 【为什么需要】把整条长命令原样刷给用户既占屏又难读；要按命令性质挑一个最有信息量的短表示
 * 【入参】input：工具入参（主要用 command）；{ verbose, theme }：verbose=true 表示展开模式
 * 【返回】React 节点；无命令时返回 null
 * 【关键步骤】
 *   ① sed 就地编辑（sed -i）特殊处理：它本质是「改文件」，所以直接显示文件路径（和 Edit 工具一致）
 *   ② 非 verbose 时尝试显示首行 # 注释当标签（全屏模式下才启用，因为那是折叠视图）
 *   ③ 仍然太长 → 先按行截断、再按字符截断，末尾加省略号 …
 *   ④ 都不需要处理 → 原样显示整条命令
 */
export function renderToolUseMessage(input: Partial<BashToolInput>, {
  verbose,
  theme: _theme
}: {
  verbose: boolean;
  theme: ThemeName;
}): React.ReactNode {
  const {
    command
  } = input;
  if (!command) {
    return null;
  }

  // Render sed in-place edits like file edits (show file path only)
  // 为什么 sed 要特殊对待：`sed -i 's/a/b/' file` 用户关心的是「改了哪个文件」，
  //   而不是那串 sed 脚本。复用文件编辑的展示方式，认知负担最小
  // 为什么 sed 要特殊对待：`sed -i 's/a/b/' file` 用户关心的是「改了哪个文件」，
  //   而不是那串 sed 脚本。复用文件编辑的展示方式，认知负担最小
  const sedInfo = parseSedEditCommand(command);
  if (sedInfo) {
    return verbose ? sedInfo.filePath : getDisplayPath(sedInfo.filePath);
  }
  if (!verbose) {
    const lines = command.split('\n');
    if (isFullscreenEnvEnabled()) {
      // 只在全屏（折叠）模式下用 # 注释当标题：折叠视图空间极小，注释比命令本身更有信息量
      // 只在全屏（折叠）模式下用 # 注释当标题：折叠视图空间极小，注释比命令本身更有信息量
      const label = extractBashCommentLabel(command);
      if (label) {
        return label.length > MAX_COMMAND_DISPLAY_CHARS ? label.slice(0, MAX_COMMAND_DISPLAY_CHARS) + '…' : label;
      }
    }
    const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES;
    const needsCharTruncation = command.length > MAX_COMMAND_DISPLAY_CHARS;
    if (needsLineTruncation || needsCharTruncation) {
      let truncated = command;

      // First truncate by lines if needed
      if (needsLineTruncation) {
        truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n');
      }

      // Then truncate by chars if still too long
      if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
        truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS);
      }
      return <Text>{truncated.trim()}…</Text>;
    }
  }
  return command;
}
/**
 * 【做什么】渲染命令「执行中」的实时输出
 * 【为什么需要】长命令需要让用户看到进度，否则像卡死
 * 【入参】progressMessagesForMessage：进度消息流（取最后一条即可，因为它包含最新快照）
 * 【返回】React 节点
 * 【关键步骤】
 *   ① `.at(-1)` 取最后一条进度（负数索引 = 从末尾数）
 *   ② 还没有任何进度数据 → 显示 Running…（占位，避免空白闪烁）
 *   ③ 有数据 → 交给 ShellProgressMessage 渲染完整输出、行数、字节数、耗时等
 */
/**
 * 【做什么】渲染命令「执行中」的实时输出
 * 【为什么需要】长命令需要让用户看到进度，否则像卡死
 * 【入参】progressMessagesForMessage：进度消息流（取最后一条即可，因为它包含最新快照）
 * 【返回】React 节点
 * 【关键步骤】
 *   ① `.at(-1)` 取最后一条进度（负数索引 = 从末尾数）
 *   ② 还没有任何进度数据 → 显示 Running…（占位，避免空白闪烁）
 *   ③ 有数据 → 交给 ShellProgressMessage 渲染完整输出、行数、字节数、耗时等
 */
export function renderToolUseProgressMessage(progressMessagesForMessage: ProgressMessage<BashProgress>[], {
  verbose,
  tools: _tools,
  terminalSize: _terminalSize,
  inProgressToolCallCount: _inProgressToolCallCount
}: {
  tools: Tool[];
  verbose: boolean;
  terminalSize?: {
    columns: number;
    rows: number;
  };
  inProgressToolCallCount?: number;
}): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1);
  if (!lastProgress || !lastProgress.data) {
    return <MessageResponse height={1}>
        <Text dimColor>Running…</Text>
      </MessageResponse>;
  }
  const data = lastProgress.data;
  return <ShellProgressMessage fullOutput={data.fullOutput} output={data.output} elapsedTimeSeconds={data.elapsedTimeSeconds} totalLines={data.totalLines} totalBytes={data.totalBytes} timeoutMs={data.timeoutMs} taskId={data.taskId} verbose={verbose} />;
}
// 排队中（前面还有命令在跑）：显示 Waiting…，让用户知道这条已经在队列里了
// 排队中（前面还有命令在跑）：显示 Waiting…，让用户知道这条已经在队列里了
export function renderToolUseQueuedMessage(): React.ReactNode {
  return <MessageResponse height={1}>
      <Text dimColor>Waiting…</Text>
    </MessageResponse>;
}
/**
 * 【做什么】渲染命令「完成后」的结果
 * 【为什么需要】结果要区分图片 / 文本 / 无输出 / 后台任务等不同情形
 * 【返回】React 节点（委托给 BashToolResultMessage 组件）
 * 【关键步骤】
 *   ① 从进度消息里取 timeoutMs（用于显示耗时提示）
 *   ② 其余工作全部交给 BashToolResultMessage（本文件只做参数转接，保持渲染层薄）
 */
/**
 * 【做什么】渲染命令「完成后」的结果
 * 【为什么需要】结果要区分图片 / 文本 / 无输出 / 后台任务等不同情形
 * 【返回】React 节点（委托给 BashToolResultMessage 组件）
 * 【关键步骤】
 *   ① 从进度消息里取 timeoutMs（用于显示耗时提示）
 *   ② 其余工作全部交给 BashToolResultMessage（本文件只做参数转接，保持渲染层薄）
 */
export function renderToolResultMessage(content: Out, progressMessagesForMessage: ProgressMessage<BashProgress>[], {
  verbose,
  theme: _theme,
  tools: _tools,
  style: _style
}: {
  verbose: boolean;
  theme: ThemeName;
  tools: Tool[];
  style?: 'condensed';
}): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1);
  // 两层可选链：进度消息可能不存在，存在也可能没有 data；任一缺失就得到 undefined（不会抛异常）
  // 两层可选链：进度消息可能不存在，存在也可能没有 data；任一缺失就得到 undefined（不会抛异常）
  const timeoutMs = lastProgress?.data?.timeoutMs;
  return <BashToolResultMessage content={content} verbose={verbose} timeoutMs={timeoutMs} />;
}
// 报错展示：统一交给 FallbackToolUseErrorMessage 处理（各工具共用一套错误渲染）
// TS 速查：`ToolResultBlockParam['content']` 是索引访问类型 ≈ 取该类型的 content 字段的类型
// 报错展示：统一交给 FallbackToolUseErrorMessage 处理（各工具共用一套错误渲染）
// TS 速查：`ToolResultBlockParam['content']` 是索引访问类型 ≈ 取该类型的 content 字段的类型
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  verbose,
  progressMessagesForMessage: _progressMessagesForMessage,
  tools: _tools
}: {
  verbose: boolean;
  progressMessagesForMessage: ProgressMessage<BashProgress>[];
  tools: Tool[];
}): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUb29sUmVzdWx0QmxvY2tQYXJhbSIsIlJlYWN0IiwiS2V5Ym9hcmRTaG9ydGN1dEhpbnQiLCJGYWxsYmFja1Rvb2xVc2VFcnJvck1lc3NhZ2UiLCJNZXNzYWdlUmVzcG9uc2UiLCJTaGVsbFByb2dyZXNzTWVzc2FnZSIsIkJveCIsIlRleHQiLCJ1c2VLZXliaW5kaW5nIiwidXNlU2hvcnRjdXREaXNwbGF5IiwidXNlQXBwU3RhdGVTdG9yZSIsInVzZVNldEFwcFN0YXRlIiwiVG9vbCIsImJhY2tncm91bmRBbGwiLCJQcm9ncmVzc01lc3NhZ2UiLCJlbnYiLCJpc0VudlRydXRoeSIsImdldERpc3BsYXlQYXRoIiwiaXNGdWxsc2NyZWVuRW52RW5hYmxlZCIsIlRoZW1lTmFtZSIsIkJhc2hQcm9ncmVzcyIsIkJhc2hUb29sSW5wdXQiLCJPdXQiLCJCYXNoVG9vbFJlc3VsdE1lc3NhZ2UiLCJleHRyYWN0QmFzaENvbW1lbnRMYWJlbCIsInBhcnNlU2VkRWRpdENvbW1hbmQiLCJNQVhfQ09NTUFORF9ESVNQTEFZX0xJTkVTIiwiTUFYX0NPTU1BTkRfRElTUExBWV9DSEFSUyIsIkJhY2tncm91bmRIaW50IiwidDAiLCIkIiwiX2MiLCJ0MSIsInVuZGVmaW5lZCIsIm9uQmFja2dyb3VuZCIsInN0b3JlIiwic2V0QXBwU3RhdGUiLCJ0MiIsImdldFN0YXRlIiwiaGFuZGxlQmFja2dyb3VuZCIsInQzIiwiU3ltYm9sIiwiZm9yIiwiY29udGV4dCIsImJhc2VTaG9ydGN1dCIsInNob3J0Y3V0IiwidGVybWluYWwiLCJwcm9jZXNzIiwiQ0xBVURFX0NPREVfRElTQUJMRV9CQUNLR1JPVU5EX1RBU0tTIiwidDQiLCJyZW5kZXJUb29sVXNlTWVzc2FnZSIsImlucHV0IiwiUGFydGlhbCIsInZlcmJvc2UiLCJ0aGVtZSIsIl90aGVtZSIsIlJlYWN0Tm9kZSIsImNvbW1hbmQiLCJzZWRJbmZvIiwiZmlsZVBhdGgiLCJsaW5lcyIsInNwbGl0IiwibGFiZWwiLCJsZW5ndGgiLCJzbGljZSIsIm5lZWRzTGluZVRydW5jYXRpb24iLCJuZWVkc0NoYXJUcnVuY2F0aW9uIiwidHJ1bmNhdGVkIiwiam9pbiIsInRyaW0iLCJyZW5kZXJUb29sVXNlUHJvZ3Jlc3NNZXNzYWdlIiwicHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJ0b29scyIsIl90b29scyIsInRlcm1pbmFsU2l6ZSIsIl90ZXJtaW5hbFNpemUiLCJpblByb2dyZXNzVG9vbENhbGxDb3VudCIsIl9pblByb2dyZXNzVG9vbENhbGxDb3VudCIsImNvbHVtbnMiLCJyb3dzIiwibGFzdFByb2dyZXNzIiwiYXQiLCJkYXRhIiwiZnVsbE91dHB1dCIsIm91dHB1dCIsImVsYXBzZWRUaW1lU2Vjb25kcyIsInRvdGFsTGluZXMiLCJ0b3RhbEJ5dGVzIiwidGltZW91dE1zIiwidGFza0lkIiwicmVuZGVyVG9vbFVzZVF1ZXVlZE1lc3NhZ2UiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsImNvbnRlbnQiLCJzdHlsZSIsIl9zdHlsZSIsInJlbmRlclRvb2xVc2VFcnJvck1lc3NhZ2UiLCJyZXN1bHQiLCJfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiXSwic291cmNlcyI6WyJVSS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBUb29sUmVzdWx0QmxvY2tQYXJhbSB9IGZyb20gJ0BhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9pbmRleC5tanMnXG5pbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEtleWJvYXJkU2hvcnRjdXRIaW50IH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9kZXNpZ24tc3lzdGVtL0tleWJvYXJkU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgRmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9GYWxsYmFja1Rvb2xVc2VFcnJvck1lc3NhZ2UuanMnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL01lc3NhZ2VSZXNwb25zZS5qcydcbmltcG9ydCB7IFNoZWxsUHJvZ3Jlc3NNZXNzYWdlIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9zaGVsbC9TaGVsbFByb2dyZXNzTWVzc2FnZS5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZUtleWJpbmRpbmcgfSBmcm9tICcuLi8uLi9rZXliaW5kaW5ncy91c2VLZXliaW5kaW5nLmpzJ1xuaW1wb3J0IHsgdXNlU2hvcnRjdXREaXNwbGF5IH0gZnJvbSAnLi4vLi4va2V5YmluZGluZ3MvdXNlU2hvcnRjdXREaXNwbGF5LmpzJ1xuaW1wb3J0IHsgdXNlQXBwU3RhdGVTdG9yZSwgdXNlU2V0QXBwU3RhdGUgfSBmcm9tICcuLi8uLi9zdGF0ZS9BcHBTdGF0ZS5qcydcbmltcG9ydCB0eXBlIHsgVG9vbCB9IGZyb20gJy4uLy4uL1Rvb2wuanMnXG5pbXBvcnQgeyBiYWNrZ3JvdW5kQWxsIH0gZnJvbSAnLi4vLi4vdGFza3MvTG9jYWxTaGVsbFRhc2svTG9jYWxTaGVsbFRhc2suanMnXG5pbXBvcnQgdHlwZSB7IFByb2dyZXNzTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQgeyBlbnYgfSBmcm9tICcuLi8uLi91dGlscy9lbnYuanMnXG5pbXBvcnQgeyBpc0VudlRydXRoeSB9IGZyb20gJy4uLy4uL3V0aWxzL2VudlV0aWxzLmpzJ1xuaW1wb3J0IHsgZ2V0RGlzcGxheVBhdGggfSBmcm9tICcuLi8uLi91dGlscy9maWxlLmpzJ1xuaW1wb3J0IHsgaXNGdWxsc2NyZWVuRW52RW5hYmxlZCB9IGZyb20gJy4uLy4uL3V0aWxzL2Z1bGxzY3JlZW4uanMnXG5pbXBvcnQgdHlwZSB7IFRoZW1lTmFtZSB9IGZyb20gJy4uLy4uL3V0aWxzL3RoZW1lLmpzJ1xuaW1wb3J0IHR5cGUgeyBCYXNoUHJvZ3Jlc3MsIEJhc2hUb29sSW5wdXQsIE91dCB9IGZyb20gJy4vQmFzaFRvb2wuanMnXG5pbXBvcnQgQmFzaFRvb2xSZXN1bHRNZXNzYWdlIGZyb20gJy4vQmFzaFRvb2xSZXN1bHRNZXNzYWdlLmpzJ1xuaW1wb3J0IHsgZXh0cmFjdEJhc2hDb21tZW50TGFiZWwgfSBmcm9tICcuL2NvbW1lbnRMYWJlbC5qcydcbmltcG9ydCB7IHBhcnNlU2VkRWRpdENvbW1hbmQgfSBmcm9tICcuL3NlZEVkaXRQYXJzZXIuanMnXG5cbi8vIENvbnN0YW50cyBmb3IgY29tbWFuZCBkaXNwbGF5XG5jb25zdCBNQVhfQ09NTUFORF9ESVNQTEFZX0xJTkVTID0gMlxuY29uc3QgTUFYX0NPTU1BTkRfRElTUExBWV9DSEFSUyA9IDE2MFxuXG4vLyBTaW1wbGUgY29tcG9uZW50IHRvIHNob3cgYmFja2dyb3VuZCBoaW50IGFuZCBoYW5kbGUgY3RybCtiXG4vLyBXaGVuIGN0cmwrYiBpcyBwcmVzc2VkLCBiYWNrZ3JvdW5kcyBBTEwgcnVubmluZyBmb3JlZ3JvdW5kIGNvbW1hbmRzXG5leHBvcnQgZnVuY3Rpb24gQmFja2dyb3VuZEhpbnQoe1xuICBvbkJhY2tncm91bmQsXG59OiB7XG4gIG9uQmFja2dyb3VuZD86ICgpID0+IHZvaWRcbn0gPSB7fSk6IFJlYWN0LlJlYWN0RWxlbWVudCB8IG51bGwge1xuICBjb25zdCBzdG9yZSA9IHVzZUFwcFN0YXRlU3RvcmUoKVxuICBjb25zdCBzZXRBcHBTdGF0ZSA9IHVzZVNldEFwcFN0YXRlKClcblxuICAvLyBIYW5kbGVyIGZvciB0YXNrOmJhY2tncm91bmQgLSBiYWNrZ3JvdW5kIGFsbCBmb3JlZ3JvdW5kIHRhc2tzXG4gIGNvbnN0IGhhbmRsZUJhY2tncm91bmQgPSBSZWFjdC51c2VDYWxsYmFjaygoKSA9PiB7XG4gICAgLy8gQmFja2dyb3VuZCBBTEwgZm9yZWdyb3VuZCBiYXNoIHRhc2tzXG4gICAgYmFja2dyb3VuZEFsbCgoKSA9PiBzdG9yZS5nZXRTdGF0ZSgpLCBzZXRBcHBTdGF0ZSlcbiAgICAvLyBBbHNvIGNhbGwgdGhlIG9wdGlvbmFsIGNhbGxiYWNrICh1c2VkIGZvciBub24tYmFzaCB0YXNrcyBsaWtlIGFnZW50cylcbiAgICBvbkJhY2tncm91bmQ/LigpXG4gIH0sIFtzdG9yZSwgc2V0QXBwU3RhdGUsIG9uQmFja2dyb3VuZF0pXG5cbiAgdXNlS2V5YmluZGluZygndGFzazpiYWNrZ3JvdW5kJywgaGFuZGxlQmFja2dyb3VuZCwge1xuICAgIGNvbnRleHQ6ICdUYXNrJyxcbiAgfSlcblxuICAvLyBHZXQgdGhlIGNvbmZpZ3VyZWQgc2hvcnRjdXQgZm9yIHRhc2s6YmFja2dyb3VuZFxuICBjb25zdCBiYXNlU2hvcnRjdXQgPSB1c2VTaG9ydGN1dERpc3BsYXkoJ3Rhc2s6YmFja2dyb3VuZCcsICdUYXNrJywgJ2N0cmwrYicpXG4gIC8vIEluIHRtdXgsIGN0cmwrYiBpcyB0aGUgcHJlZml4IGtleSwgc28gdXNlcnMgbmVlZCB0byBwcmVzcyBpdCB0d2ljZSB0byBzZW5kIGN0cmwrYlxuICBjb25zdCBzaG9ydGN1dCA9XG4gICAgZW52LnRlcm1pbmFsID09PSAndG11eCcgJiYgYmFzZVNob3J0Y3V0ID09PSAnY3RybCtiJ1xuICAgICAgPyAnY3RybCtiIGN0cmwrYiAodHdpY2UpJ1xuICAgICAgOiBiYXNlU2hvcnRjdXRcblxuICAvLyBEb24ndCBzaG93IGJhY2tncm91bmQgaGludCBpZiBiYWNrZ3JvdW5kIHRhc2tzIGFyZSBkaXNhYmxlZFxuICBpZiAoaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRElTQUJMRV9CQUNLR1JPVU5EX1RBU0tTKSkge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxCb3ggcGFkZGluZ0xlZnQ9ezV9PlxuICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludFxuICAgICAgICAgIHNob3J0Y3V0PXtzaG9ydGN1dH1cbiAgICAgICAgICBhY3Rpb249XCJydW4gaW4gYmFja2dyb3VuZFwiXG4gICAgICAgICAgcGFyZW5zXG4gICAgICAgIC8+XG4gICAgICA8L1RleHQ+XG4gICAgPC9Cb3g+XG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VNZXNzYWdlKFxuICBpbnB1dDogUGFydGlhbDxCYXNoVG9vbElucHV0PixcbiAgeyB2ZXJib3NlLCB0aGVtZTogX3RoZW1lIH06IHsgdmVyYm9zZTogYm9vbGVhbjsgdGhlbWU6IFRoZW1lTmFtZSB9LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgeyBjb21tYW5kIH0gPSBpbnB1dFxuICBpZiAoIWNvbW1hbmQpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgLy8gUmVuZGVyIHNlZCBpbi1wbGFjZSBlZGl0cyBsaWtlIGZpbGUgZWRpdHMgKHNob3cgZmlsZSBwYXRoIG9ubHkpXG4gIGNvbnN0IHNlZEluZm8gPSBwYXJzZVNlZEVkaXRDb21tYW5kKGNvbW1hbmQpXG4gIGlmIChzZWRJbmZvKSB7XG4gICAgcmV0dXJuIHZlcmJvc2UgPyBzZWRJbmZvLmZpbGVQYXRoIDogZ2V0RGlzcGxheVBhdGgoc2VkSW5mby5maWxlUGF0aClcbiAgfVxuXG4gIGlmICghdmVyYm9zZSkge1xuICAgIGNvbnN0IGxpbmVzID0gY29tbWFuZC5zcGxpdCgnXFxuJylcblxuICAgIGlmIChpc0Z1bGxzY3JlZW5FbnZFbmFibGVkKCkpIHtcbiAgICAgIGNvbnN0IGxhYmVsID0gZXh0cmFjdEJhc2hDb21tZW50TGFiZWwoY29tbWFuZClcbiAgICAgIGlmIChsYWJlbCkge1xuICAgICAgICByZXR1cm4gbGFiZWwubGVuZ3RoID4gTUFYX0NPTU1BTkRfRElTUExBWV9DSEFSU1xuICAgICAgICAgID8gbGFiZWwuc2xpY2UoMCwgTUFYX0NPTU1BTkRfRElTUExBWV9DSEFSUykgKyAn4oCmJ1xuICAgICAgICAgIDogbGFiZWxcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBuZWVkc0xpbmVUcnVuY2F0aW9uID0gbGluZXMubGVuZ3RoID4gTUFYX0NPTU1BTkRfRElTUExBWV9MSU5FU1xuICAgIGNvbnN0IG5lZWRzQ2hhclRydW5jYXRpb24gPSBjb21tYW5kLmxlbmd0aCA+IE1BWF9DT01NQU5EX0RJU1BMQVlfQ0hBUlNcblxuICAgIGlmIChuZWVkc0xpbmVUcnVuY2F0aW9uIHx8IG5lZWRzQ2hhclRydW5jYXRpb24pIHtcbiAgICAgIGxldCB0cnVuY2F0ZWQgPSBjb21tYW5kXG5cbiAgICAgIC8vIEZpcnN0IHRydW5jYXRlIGJ5IGxpbmVzIGlmIG5lZWRlZFxuICAgICAgaWYgKG5lZWRzTGluZVRydW5jYXRpb24pIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gbGluZXMuc2xpY2UoMCwgTUFYX0NPTU1BTkRfRElTUExBWV9MSU5FUykuam9pbignXFxuJylcbiAgICAgIH1cblxuICAgICAgLy8gVGhlbiB0cnVuY2F0ZSBieSBjaGFycyBpZiBzdGlsbCB0b28gbG9uZ1xuICAgICAgaWYgKHRydW5jYXRlZC5sZW5ndGggPiBNQVhfQ09NTUFORF9ESVNQTEFZX0NIQVJTKSB7XG4gICAgICAgIHRydW5jYXRlZCA9IHRydW5jYXRlZC5zbGljZSgwLCBNQVhfQ09NTUFORF9ESVNQTEFZX0NIQVJTKVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gPFRleHQ+e3RydW5jYXRlZC50cmltKCl94oCmPC9UZXh0PlxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBjb21tYW5kXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlUHJvZ3Jlc3NNZXNzYWdlKFxuICBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZTogUHJvZ3Jlc3NNZXNzYWdlPEJhc2hQcm9ncmVzcz5bXSxcbiAge1xuICAgIHZlcmJvc2UsXG4gICAgdG9vbHM6IF90b29scyxcbiAgICB0ZXJtaW5hbFNpemU6IF90ZXJtaW5hbFNpemUsXG4gICAgaW5Qcm9ncmVzc1Rvb2xDYWxsQ291bnQ6IF9pblByb2dyZXNzVG9vbENhbGxDb3VudCxcbiAgfToge1xuICAgIHRvb2xzOiBUb29sW11cbiAgICB2ZXJib3NlOiBib29sZWFuXG4gICAgdGVybWluYWxTaXplPzogeyBjb2x1bW5zOiBudW1iZXI7IHJvd3M6IG51bWJlciB9XG4gICAgaW5Qcm9ncmVzc1Rvb2xDYWxsQ291bnQ/OiBudW1iZXJcbiAgfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IGxhc3RQcm9ncmVzcyA9IHByb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlLmF0KC0xKVxuXG4gIGlmICghbGFzdFByb2dyZXNzIHx8ICFsYXN0UHJvZ3Jlc3MuZGF0YSkge1xuICAgIHJldHVybiAoXG4gICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPlJ1bm5pbmfigKY8L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cblxuICBjb25zdCBkYXRhID0gbGFzdFByb2dyZXNzLmRhdGFcblxuICByZXR1cm4gKFxuICAgIDxTaGVsbFByb2dyZXNzTWVzc2FnZVxuICAgICAgZnVsbE91dHB1dD17ZGF0YS5mdWxsT3V0cHV0fVxuICAgICAgb3V0cHV0PXtkYXRhLm91dHB1dH1cbiAgICAgIGVsYXBzZWRUaW1lU2Vjb25kcz17ZGF0YS5lbGFwc2VkVGltZVNlY29uZHN9XG4gICAgICB0b3RhbExpbmVzPXtkYXRhLnRvdGFsTGluZXN9XG4gICAgICB0b3RhbEJ5dGVzPXtkYXRhLnRvdGFsQnl0ZXN9XG4gICAgICB0aW1lb3V0TXM9e2RhdGEudGltZW91dE1zfVxuICAgICAgdGFza0lkPXtkYXRhLnRhc2tJZH1cbiAgICAgIHZlcmJvc2U9e3ZlcmJvc2V9XG4gICAgLz5cbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFVzZVF1ZXVlZE1lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICA8VGV4dCBkaW1Db2xvcj5XYWl0aW5n4oCmPC9UZXh0PlxuICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShcbiAgY29udGVudDogT3V0LFxuICBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZTogUHJvZ3Jlc3NNZXNzYWdlPEJhc2hQcm9ncmVzcz5bXSxcbiAge1xuICAgIHZlcmJvc2UsXG4gICAgdGhlbWU6IF90aGVtZSxcbiAgICB0b29sczogX3Rvb2xzLFxuICAgIHN0eWxlOiBfc3R5bGUsXG4gIH06IHtcbiAgICB2ZXJib3NlOiBib29sZWFuXG4gICAgdGhlbWU6IFRoZW1lTmFtZVxuICAgIHRvb2xzOiBUb29sW11cbiAgICBzdHlsZT86ICdjb25kZW5zZWQnXG4gIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBsYXN0UHJvZ3Jlc3MgPSBwcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZS5hdCgtMSlcbiAgY29uc3QgdGltZW91dE1zID0gbGFzdFByb2dyZXNzPy5kYXRhPy50aW1lb3V0TXNcbiAgcmV0dXJuIChcbiAgICA8QmFzaFRvb2xSZXN1bHRNZXNzYWdlXG4gICAgICBjb250ZW50PXtjb250ZW50fVxuICAgICAgdmVyYm9zZT17dmVyYm9zZX1cbiAgICAgIHRpbWVvdXRNcz17dGltZW91dE1zfVxuICAgIC8+XG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VFcnJvck1lc3NhZ2UoXG4gIHJlc3VsdDogVG9vbFJlc3VsdEJsb2NrUGFyYW1bJ2NvbnRlbnQnXSxcbiAge1xuICAgIHZlcmJvc2UsXG4gICAgcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2U6IF9wcm9ncmVzc01lc3NhZ2VzRm9yTWVzc2FnZSxcbiAgICB0b29sczogX3Rvb2xzLFxuICB9OiB7XG4gICAgdmVyYm9zZTogYm9vbGVhblxuICAgIHByb2dyZXNzTWVzc2FnZXNGb3JNZXNzYWdlOiBQcm9ncmVzc01lc3NhZ2U8QmFzaFByb2dyZXNzPltdXG4gICAgdG9vbHM6IFRvb2xbXVxuICB9LFxuKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIDxGYWxsYmFja1Rvb2xVc2VFcnJvck1lc3NhZ2UgcmVzdWx0PXtyZXN1bHR9IHZlcmJvc2U9e3ZlcmJvc2V9IC8+XG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxjQUFjQSxvQkFBb0IsUUFBUSx1Q0FBdUM7QUFDakYsT0FBTyxLQUFLQyxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxvQkFBb0IsUUFBUSx3REFBd0Q7QUFDN0YsU0FBU0MsMkJBQTJCLFFBQVEsaURBQWlEO0FBQzdGLFNBQVNDLGVBQWUsUUFBUSxxQ0FBcUM7QUFDckUsU0FBU0Msb0JBQW9CLFFBQVEsZ0RBQWdEO0FBQ3JGLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0MsYUFBYSxRQUFRLG9DQUFvQztBQUNsRSxTQUFTQyxrQkFBa0IsUUFBUSx5Q0FBeUM7QUFDNUUsU0FBU0MsZ0JBQWdCLEVBQUVDLGNBQWMsUUFBUSx5QkFBeUI7QUFDMUUsY0FBY0MsSUFBSSxRQUFRLGVBQWU7QUFDekMsU0FBU0MsYUFBYSxRQUFRLDhDQUE4QztBQUM1RSxjQUFjQyxlQUFlLFFBQVEsd0JBQXdCO0FBQzdELFNBQVNDLEdBQUcsUUFBUSxvQkFBb0I7QUFDeEMsU0FBU0MsV0FBVyxRQUFRLHlCQUF5QjtBQUNyRCxTQUFTQyxjQUFjLFFBQVEscUJBQXFCO0FBQ3BELFNBQVNDLHNCQUFzQixRQUFRLDJCQUEyQjtBQUNsRSxjQUFjQyxTQUFTLFFBQVEsc0JBQXNCO0FBQ3JELGNBQWNDLFlBQVksRUFBRUMsYUFBYSxFQUFFQyxHQUFHLFFBQVEsZUFBZTtBQUNyRSxPQUFPQyxxQkFBcUIsTUFBTSw0QkFBNEI7QUFDOUQsU0FBU0MsdUJBQXVCLFFBQVEsbUJBQW1CO0FBQzNELFNBQVNDLG1CQUFtQixRQUFRLG9CQUFvQjs7QUFFeEQ7QUFDQSxNQUFNQyx5QkFBeUIsR0FBRyxDQUFDO0FBQ25DLE1BQU1DLHlCQUF5QixHQUFHLEdBQUc7O0FBRXJDO0FBQ0E7QUFDQSxPQUFPLFNB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