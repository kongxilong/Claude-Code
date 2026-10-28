/**
 * 【一句话定位】
 *   Glob 工具的“展示层”：把工具入参/出参渲染成终端里人类可读的一行文本或 React 节点（不参与任何业务逻辑）。
 *
 * 【在架构中的位置】
 *   上游调用链：
 *     src/tools/GlobTool/GlobTool.ts（工具本体）
 *       → 工具渲染调度（src/Tool.ts 约定的 userFacingName / renderToolUseMessage / renderToolUseErrorMessage /
 *         renderToolResultMessage / getToolUseSummary 五个钩子）
 *       → 本文件导出的这几个函数
 *   下游依赖：
 *     - src/components/MessageResponse.js：把可能带 Markdown 的文本渲染成富文本
 *     - src/ink.js 的 <Text>：终端 UI 组件（Ink = React 渲染到命令行）
 *     - ../GrepTool/GrepTool.js：直接复用它的 renderToolResultMessage（见本文件第 53 行）
 *   设计约定：工具目录里 UI.tsx 与 Tool.ts 分离，是为了让“计算”与“显示”解耦——
 *   无头（headless）模式、测试、SDK 场景可以不加载任何 React 代码。
 *
 * 【本文件包含什么】
 *   - userFacingName()：给终端用户看的工具名
 *   - renderToolUseMessage()：工具被调用时显示的那一行动作描述
 *   - renderToolUseErrorMessage()：工具报错时的友好展示
 *   - renderToolResultMessage：直接复用 GrepTool 的实现（两个搜索工具展示形态一致）
 *   - getToolUseSummary()：给历史/摘要用的极短字符串
 *
 * 【TS 语法速查】（只列本文件真实出现的写法）
 *   - `.tsx` 后缀：TypeScript + JSX。JSX 就是在 JS 里直接写标签，如 <Text color="error">x</Text>，
 *     编译后等价于 React.createElement(Text, {color:'error'}, 'x')。对照 Java：没有对应物，
 *     可以类比 Android 的 XML 布局，但它是表达式、能嵌在代码里、受类型检查。
 *   - `React.ReactNode`：可渲染节点的联合类型（字符串/数字/元素/数组/null...）。
 *     对照 Java：类似 Object，但被限定成“组件树节点”，传错类型编译期报错。
 *   - `Partial<{ pattern: string; path: string }>`：把所有字段变成可选（等价于 {pattern?: string; path?: string}）。
 *     对照 Java：DTO 里所有字段都可为 null。为什么用 Partial：工具入参来自模型，
 *     渲染时必须假设任何字段都可能缺失。
 *   - 解构 + 类型标注写在**后面**：`function f({ pattern, path }: Partial<{...}>, { verbose }: { verbose: boolean })`。
 *     注意 TS 的类型标注在变量名**后面**，和 Java 相反，最容易看串。
 *   - `input?.pattern`：`?.` 可选链，input 为 null/undefined 时整体短路为 undefined，不抛 NPE。
 *     对照 Java：input != null && input.getPattern()。
 *   - `string | null`：联合类型。≈ Java 的 sealed interface 的简化版，表示“要么是 string 要么是 null”，
 *     用它当返回值能强迫调用方处理 null 分支。
 *   - `typeof result === 'string'`：TS 的**类型收窄**（narrowing）。在 if 里判断后，
 *     result 在该分支内就被当成 string 用。≈ Java 的 `if (x instanceof String s)` 模式匹配（Java 17+）。
 *   - `export const x = GrepTool.renderToolResultMessage`：把别处的值原样再导出一次（re-export），
 *     两个工具共用同一份渲染逻辑，改一处即可。
 *   - 模板字符串 `` `pattern: "${pattern}"` ``：反引号字符串，里面 ${} 直接插值。≈ Java 的 String.format 简写。
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React from 'react';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { extractTag } from 'src/utils/messages.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js';
import { Text } from '../../ink.js';
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from '../../utils/file.js';
import { truncate } from '../../utils/format.js';
import { GrepTool } from '../GrepTool/GrepTool.js';
// userFacingName：终端里显示的工具名。这里统一叫 "Search"，
// 因为对终端用户来说 Glob（按名字找）和 Grep（按内容找）都是“搜索”，不必暴露内部工具名差异。
export function userFacingName(): string {
  return 'Search';
}
// 渲染“工具被调用”这一行。入参用 Partial 包住：模型给的参数可能缺字段，渲染必须容错。
export function renderToolUseMessage({
  pattern,
  path
}: Partial<{
  pattern: string;
  path: string;
}>, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
// pattern 都没有就没啥可展示的，返回 null（表示“不渲染这一行”），而不是渲染一个空串。
  if (!pattern) {
    return null;
  }
// 没传 path 就只展示 pattern，避免显示成 "path: undefined" 这种噪音。
  if (!path) {
    return `pattern: "${pattern}"`;
  }
// verbose=false 时用 getDisplayPath() 把长路径缩短（如 ~/proj/...），
// 目的是终端一行放得下；verbose 模式下才展示完整路径供排查。
  return `pattern: "${pattern}", path: "${verbose ? path : getDisplayPath(path)}"`;
}
// 渲染“工具报错”。返回 React 节点而不是字符串，是为了能用 <Text color="error"> 上色、并支持 Markdown。
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
// verbose 模式下直接把原始错误文本抛给用户看（排障用）；非 verbose 才走下面的“人类友好”文案。
// 先判断 typeof === 'string'：错误内容可能是文本块数组，只有字符串才能 extractTag。
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    const errorMessage = extractTag(result, 'tool_use_error');
// 专门识别“文件/目录不存在”这类错误（FILE_NOT_FOUND_CWD_NOTE 是它的标记串），
// 换成一句人话 "File not found"。其它错误统一显示 "Error searching files"。
// 为什么不全量显示原始错误：原始文本里往往夹着绝对路径与提示词，对终端用户是噪音。
    if (errorMessage?.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return <MessageResponse>
          <Text color="error">File not found</Text>
        </MessageResponse>;
    }
    return <MessageResponse>
        <Text color="error">Error searching files</Text>
      </MessageResponse>;
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

// 英文原注释说的是：Glob 复用 Grep 的结果渲染。
// 中文补充：两者的结果都是“一列文件路径”，展示形态天然一致，
// 直接复用可避免两份几乎相同的 UI 代码各自漂移。
// Note: GlobTool reuses GrepTool's renderToolResultMessage
export const renderToolResultMessage = GrepTool.renderToolResultMessage;
// getToolUseSummary：给历史记录/会话摘要用的极短描述（只保留 pattern 并截断）。
// 为什么必须截断：摘要会累积进上下文，太长会挤占有效内容。
export function getToolUseSummary(input: Partial<{
  pattern: string;
  path: string;
}> | undefined): string | null {
// `input?.pattern` 双保险：input 可能整个是 undefined，pattern 也可能是空串。
// 返回 null 表示“没有可摘要的内容”，调用方据此决定不展示。
  if (!input?.pattern) {
    return null;
  }
  return truncate(input.pattern, TOOL_SUMMARY_MAX_LENGTH);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUb29sUmVzdWx0QmxvY2tQYXJhbSIsIlJlYWN0IiwiTWVzc2FnZVJlc3BvbnNlIiwiZXh0cmFjdFRhZyIsIkZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSIsIlRPT0xfU1VNTUFSWV9NQVhfTEVOR1RIIiwiVGV4dCIsIkZJTEVfTk9UX0ZPVU5EX0NXRF9OT1RFIiwiZ2V0RGlzcGxheVBhdGgiLCJ0cnVuY2F0ZSIsIkdyZXBUb29sIiwidXNlckZhY2luZ05hbWUiLCJyZW5kZXJUb29sVXNlTWVzc2FnZSIsInBhdHRlcm4iLCJwYXRoIiwiUGFydGlhbCIsInZlcmJvc2UiLCJSZWFjdE5vZGUiLCJyZW5kZXJUb29sVXNlRXJyb3JNZXNzYWdlIiwicmVzdWx0IiwiZXJyb3JNZXNzYWdlIiwiaW5jbHVkZXMiLCJyZW5kZXJUb29sUmVzdWx0TWVzc2FnZSIsImdldFRvb2xVc2VTdW1tYXJ5IiwiaW5wdXQiXSwic291cmNlcyI6WyJVSS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBUb29sUmVzdWx0QmxvY2tQYXJhbSB9IGZyb20gJ0BhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9pbmRleC5tanMnXG5pbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICdzcmMvY29tcG9uZW50cy9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyBleHRyYWN0VGFnIH0gZnJvbSAnc3JjL3V0aWxzL21lc3NhZ2VzLmpzJ1xuaW1wb3J0IHsgRmFsbGJhY2tUb29sVXNlRXJyb3JNZXNzYWdlIH0gZnJvbSAnLi4vLi4vY29tcG9uZW50cy9GYWxsYmFja1Rvb2xVc2VFcnJvck1lc3NhZ2UuanMnXG5pbXBvcnQgeyBUT09MX1NVTU1BUllfTUFYX0xFTkdUSCB9IGZyb20gJy4uLy4uL2NvbnN0YW50cy90b29sTGltaXRzLmpzJ1xuaW1wb3J0IHsgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IEZJTEVfTk9UX0ZPVU5EX0NXRF9OT1RFLCBnZXREaXNwbGF5UGF0aCB9IGZyb20gJy4uLy4uL3V0aWxzL2ZpbGUuanMnXG5pbXBvcnQgeyB0cnVuY2F0ZSB9IGZyb20gJy4uLy4uL3V0aWxzL2Zvcm1hdC5qcydcbmltcG9ydCB7IEdyZXBUb29sIH0gZnJvbSAnLi4vR3JlcFRvb2wvR3JlcFRvb2wuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiB1c2VyRmFjaW5nTmFtZSgpOiBzdHJpbmcge1xuICByZXR1cm4gJ1NlYXJjaCdcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VNZXNzYWdlKFxuICB7IHBhdHRlcm4sIHBhdGggfTogUGFydGlhbDx7IHBhdHRlcm46IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+LFxuICB7IHZlcmJvc2UgfTogeyB2ZXJib3NlOiBib29sZWFuIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAoIXBhdHRlcm4pIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIGlmICghcGF0aCkge1xuICAgIHJldHVybiBgcGF0dGVybjogXCIke3BhdHRlcm59XCJgXG4gIH1cbiAgcmV0dXJuIGBwYXR0ZXJuOiBcIiR7cGF0dGVybn1cIiwgcGF0aDogXCIke3ZlcmJvc2UgPyBwYXRoIDogZ2V0RGlzcGxheVBhdGgocGF0aCl9XCJgXG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sVXNlRXJyb3JNZXNzYWdlKFxuICByZXN1bHQ6IFRvb2xSZXN1bHRCbG9ja1BhcmFtWydjb250ZW50J10sXG4gIHsgdmVyYm9zZSB9OiB7IHZlcmJvc2U6IGJvb2xlYW4gfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGlmIChcbiAgICAhdmVyYm9zZSAmJlxuICAgIHR5cGVvZiByZXN1bHQgPT09ICdzdHJpbmcnICYmXG4gICAgZXh0cmFjdFRhZyhyZXN1bHQsICd0b29sX3VzZV9lcnJvcicpXG4gICkge1xuICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGV4dHJhY3RUYWcocmVzdWx0LCAndG9vbF91c2VfZXJyb3InKVxuICAgIGlmIChlcnJvck1lc3NhZ2U/LmluY2x1ZGVzKEZJTEVfTk9UX0ZPVU5EX0NXRF9OT1RFKSkge1xuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+RmlsZSBub3QgZm91bmQ8L1RleHQ+XG4gICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgKVxuICAgIH1cbiAgICByZXR1cm4gKFxuICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPkVycm9yIHNlYXJjaGluZyBmaWxlczwvVGV4dD5cbiAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgIClcbiAgfVxuICByZXR1cm4gPEZhbGxiYWNrVG9vbFVzZUVycm9yTWVzc2FnZSByZXN1bHQ9e3Jlc3VsdH0gdmVyYm9zZT17dmVyYm9zZX0gLz5cbn1cblxuLy8gTm90ZTogR2xvYlRvb2wgcmV1c2VzIEdyZXBUb29sJ3MgcmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2VcbmV4cG9ydCBjb25zdCByZW5kZXJUb29sUmVzdWx0TWVzc2FnZSA9IEdyZXBUb29sLnJlbmRlclRvb2xSZXN1bHRNZXNzYWdlXG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRUb29sVXNlU3VtbWFyeShcbiAgaW5wdXQ6IFBhcnRpYWw8eyBwYXR0ZXJuOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB8IHVuZGVmaW5lZCxcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWlucHV0Py5wYXR0ZXJuKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuICByZXR1cm4gdHJ1bmNhdGUoaW5wdXQucGF0dGVybiwgVE9PTF9TVU1NQVJZX01BWF9MRU5HVEgpXG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLGNBQWNBLG9CQUFvQixRQUFRLHVDQUF1QztBQUNqRixPQUFPQyxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxlQUFl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