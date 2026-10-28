/**
 * ============================================================================
 *  【文件总览】src/tools/WebSearchTool/UI.tsx —— WebSearch 的终端界面渲染层
 * ============================================================================
 *
 *  【一句话定位】
 *  四个渲染函数，把 WebSearch 的「调用中 / 搜索中 / 已完成」三种状态画到终端上。
 *  不搜任何东西，只做展示。
 *
 *  【在架构中的位置】
 *      主循环执行 WebSearchTool
 *        ├─ 工具被调用        → renderToolUseMessage()        ← ★ 本文件
 *        ├─ 流式进度上报      → renderToolUseProgressMessage() ← ★ 本文件
 *        │     （WebSearchTool.ts 的 onProgress 回调会喂数据进来）
 *        ├─ 搜索完成          → renderToolResultMessage()     ← ★ 本文件
 *        └─ 侧边栏单行摘要    → getToolUseSummary()           ← ★ 本文件
 *
 *  【本文件包含什么】
 *   1. getSearchSummary()              数一数 results 里有几次搜索、共几条链接
 *   2. renderToolUseMessage()          "xxx"（verbose 时附带域名过滤条件）
 *   3. renderToolUseProgressMessage()  按进度类型显示"正在搜 xxx"/"找到 N 条"
 *   4. renderToolResultMessage()       "Did 2 searches in 1.2s"
 *   5. getToolUseSummary()             截断后的搜索词
 *
 *  【★ 值得注意：进度渲染是怎么工作的】
 *  WebSearchTool.ts 在流式消费时会调 onProgress 上报两类进度：
 *      { type: 'query_update',          query }         —— 模型决定要去搜这个词了
 *      { type: 'search_results_received', resultCount, query } —— 这一轮搜到 N 条
 *  这里只取**最后一条**进度来显示（progressMessages[length-1]），
 *  因为终端只有一行进度位，画历史没有意义——只画"现在在干嘛"。
 *
 *  【TS / React 语法速查】（本文件实际出现的）
 *   - `.tsx` + JSX：`<Text dimColor>xxx</Text>` 这种"在 JS 里写标签"的语法。
 *     ≈ Java 里没有；可以理解为编译成函数调用的表达式
 *   - `React.ReactNode` 返回类型：可渲染物（JSX / 字符串 / null 都行）
 *   - `(SearchResult | string | null | undefined)[]`
 *                                联合类型数组。为什么会有 null？
 *                                因为结果可能经过 JSON 往返（压缩/反序列化），
 *                                中间会掺进 null。所以必须判空
 *   - `result != null`           用 `!=`（不是 `!==`）一次性排除 null 和 undefined
 *                                （JS 特有意行为；Java 没有这套）
 *   - `typeof result !== 'string'` 运行时类型判断
 *                                ≈ Java 的 `!(result instanceof String)`
 *   - `result.content?.length ?? 0`  可选链 + 空值合并连用：
 *                                "content 可能为 undefined，取 length 也可能
 *                                 undefined，那就用 0"。⚠️ 注意这里用 `??`
 *                                 而不是 `||`，因为 length 为 0 是**合法值**，
 *                                 不能被替换掉
 *   - `switch (data.type) { ... }`  对可辨识联合做分支；TS 会自动收窄每个 case
 *                                ≈ Java 17+ 的 sealed interface 模式匹配
 *   - `&quot;`                   JSX 里写双引号要用 HTML 实体，
 *                                因为直接写 " 会和 JSX 属性引号冲突
 *   - `{searchCount !== 1 ? 'es' : ''}`  JSX 里的大括号 = JS 表达式。
 *                                这里做单复数处理（1 search / 2 searches）
 *   - `width="100%"` / `justifyContent="space-between"`  ink 的 flex 布局属性
 *   - 文件末尾 `//# sourceMappingURL=...` 是构建产物留下的源映射，别动
 * ============================================================================
 */
import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js';
import { Box, Text } from '../../ink.js';
import type { ProgressMessage } from '../../types/message.js';
import { truncate } from '../../utils/format.js';
import type { Output, SearchResult, WebSearchProgress } from './WebSearchTool.js';
/**
 * 统计 results[] 里有几次搜索、一共几条链接。
 *
 * 【做什么】遍历 results，只统计"对象类型"的条目（跳过字符串条目，
 *          因为字符串是模型说的话，不是一次搜索）。
 * 【为什么需要】结果行要显示 "Did 2 searches" —— 需要知道**搜索次数**；
 *              而一次搜索对应一个 SearchResult 对象，所以数对象就够了。
 * 【入参】results  混合数组（SearchResult 对象 | 字符串 | null | undefined）
 * 【返回】{ searchCount, totalResultCount }
 * 【关键步骤】
 *   ① `result != null` 排除 null 和 undefined（用 != 而非 !== 是 JS 惯用技巧，
 *      一个判断同时覆盖两种空值）
 *   ② `typeof result !== 'string'` 排除文字段，剩下的就是链接组
 *   ③ 累加 content 数组的长度；`?.` + `??` 保证 content 缺失时按 0 算
 */
function getSearchSummary(results: (SearchResult | string | null | undefined)[]): {
  searchCount: number;
  totalResultCount: number;
} {
  let searchCount = 0;
  let totalResultCount = 0;
  for (const result of results) {
    if (result != null && typeof result !== 'string') {
      searchCount++;
      totalResultCount += result.content?.length ?? 0;
    }
  }
  return {
    searchCount,
    totalResultCount
  };
}
/**
 * 渲染「工具被调用」这一刻的一行字。
 *
 * 【做什么】显示带引号的搜索词；verbose 模式下再补上域名过滤条件。
 * 【为什么需要】让用户看到"模型要去搜什么"——这是观察模型行为的重要窗口，
 *              也能及时发现搜索词被改写得不对（比如年份写错了）。
 * 【入参】第一个参数解构出 query / allowed_domains / blocked_domains（Partial）；
 *        第二个参数 { verbose }
 * 【返回】字符串，或 null（query 还没到就不画）
 * 【注意】开头 `if (!query) return null` 之后又 `if (query)` 再判一次，
 *        看着重复，但前者是为了让 TS 收窄类型（去掉 undefined），
 *        后者是给后续拼接用的——这类"防御性重复"在流式参数场景很常见。
 */
export function renderToolUseMessage({
  query,
  allowed_domains,
  blocked_domains
}: Partial<{
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}>, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!query) {
    return null;
  }
  let message = '';
  if (query) {
    message += `"${query}"`;
  }
  if (verbose) {
    if (allowed_domains && allowed_domains.length > 0) {
      message += `, only allowing domains: ${allowed_domains.join(', ')}`;
    }
    if (blocked_domains && blocked_domains.length > 0) {
      message += `, blocking domains: ${blocked_domains.join(', ')}`;
    }
  }
  return message;
}
/**
 * 渲染「正在搜索中」的进度行（随流式进度不断更新）。
 *
 * 【做什么】取最后一条进度消息，按它的 type 画一行：
 *      query_update           → "Searching: xxx"
 *      search_results_received → "Found N results for "xxx""
 *      其它                    → 什么都不画
 * 【为什么只取最后一条】终端只有一行进度位，画历史没有意义，
 *                      只显示"此刻在做什么"即可。
 * 【为什么有这么多判空】进度消息可能在任何时刻到达，也可能一条都没有；
 *                      data 字段也可能缺失。渲染层必须"怎么都不会崩"。
 * 【入参】progressMessages  到目前为止收到的进度消息数组
 * 【返回】JSX 或 null
 * 【语法】`&quot;` 是 HTML 实体，在 JSX 文本里写双引号要用它，
 *        否则会和 JSX 的属性引号打架
 */
export function renderToolUseProgressMessage(progressMessages: ProgressMessage<WebSearchProgress>[]): React.ReactNode {
  if (progressMessages.length === 0) {
    return null;
  }
  const lastProgress = progressMessages[progressMessages.length - 1];
  if (!lastProgress?.data) {
    return null;
  }
  const data = lastProgress.data;
  switch (data.type) {
    case 'query_update':
      return <MessageResponse>
          <Text dimColor>Searching: {data.query}</Text>
        </MessageResponse>;
    case 'search_results_received':
      return <MessageResponse>
          <Text dimColor>
            Found {data.resultCount} results for &quot;{data.query}&quot;
          </Text>
        </MessageResponse>;
    default:
      return null;
  }
}
/**
 * 渲染「搜索完成」的结果行。
 *
 * 【做什么】显示 "Did 2 searches in 1.2s"（耗时 ≥1 秒用秒，否则用毫秒）。
 * 【为什么只显示次数和耗时、不显示链接】
 *   因为链接已经全部交给**模型**了（在 tool_result 里），
 *   终端上再刷一遍会占用大量屏幕。这里只给用户一个"干完了、花了多久"的交代。
 *   （这也正是 WebSearchTool.extractSearchText() 返回空字符串的原因：
 *     没显示过的内容不该参与界面搜索，否则会出现幽灵匹配。）
 * 【入参】output（含 results 和 durationSeconds）
 * 【返回】JSX：一行两端对齐的文本
 * 【语法】`{searchCount !== 1 ? 'es' : ''}` 是 JSX 里嵌 JS 表达式做单复数。
 *        注意 JSX 中大括号 `{}` 内是**表达式**不是语句
 */
export function renderToolResultMessage(output: Output): React.ReactNode {
  const {
    searchCount
  } = getSearchSummary(output.results ?? []);
  const timeDisplay = output.durationSeconds >= 1 ? `${Math.round(output.durationSeconds)}s` : `${Math.round(output.durationSeconds * 1000)}ms`;
  return <Box justifyContent="space-between" width="100%">
      <MessageResponse height={1}>
        <Text>
          Did {searchCount} search
          {searchCount !== 1 ? 'es' : ''} in {timeDisplay}
        </Text>
      </MessageResponse>
    </Box>;
}
/**
 * 生成一行简短摘要（给侧边栏、活动状态等"只放得下一行"的地方用）。
 *
 * 【做什么】把搜索词截断后返回；没有搜索词就返回 null。
 * 【为什么需要】和 renderToolUseMessage 的区别：返回的是**纯字符串**而不是
 *              React 节点，方便调用方拼进日志、状态栏、遥测。
 * 【入参】input 可能整个是 undefined（故类型写成 `... | undefined`，
 *        并用 `input?.query` 可选链取值）
 * 【返回】string | null
 */
export function getToolUseSummary(input: Partial<{
  query: string;
}> | undefined): string | null {
  if (!input?.query) {
    return null;
  }
  return truncate(input.query, TOOL_SUMMARY_MAX_LENGTH);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsIlRPT0xfU1VNTUFSWV9NQVhfTEVOR1RIIiwiQm94IiwiVGV4dCIsIlByb2dyZXNzTWVzc2FnZSIsInRydW5jYXRlIiwiT3V0cHV0IiwiU2VhcmNoUmVzdWx0IiwiV2ViU2VhcmNoUHJvZ3Jlc3MiLCJnZXRTZWFyY2hTdW1tYXJ5IiwicmVzdWx0cyIsInNlYXJjaENvdW50IiwidG90YWxSZXN1bHRDb3VudCIsInJlc3VsdCIsImNvbnRlbnQiLCJsZW5ndGgiLCJyZW5kZXJUb29sVXNlTWVzc2FnZSIsInF1ZXJ5IiwiYWxsb3dlZF9kb21haW5zIiwiYmxvY2tlZF9kb21haW5zIiwiUGFydGlhbCIsInZlcmJvc2UiLCJSZWFjdE5vZGUiLCJtZXNzYWdlIiwiam9pbiIsInJlbmRlclRvb2xVc2VQcm9ncmVzc01lc3NhZ2UiLCJwcm9ncmVzc01lc3NhZ2VzIiwibGFzdFByb2dyZXNzIiwiZGF0YSIsInR5cGUiLCJyZXN1bHRDb3VudCIsInJlbmRlclRvb2xSZXN1bHRNZXNzYWdlIiwib3V0cHV0IiwidGltZURpc3BsYXkiLCJkdXJhdGlvblNlY29uZHMiLCJNYXRoIiwicm91bmQiLCJnZXRUb29sVXNlU3VtbWFyeSIsImlucHV0Il0sInNvdXJjZXMiOlsiVUkudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvTWVzc2FnZVJlc3BvbnNlLmpzJ1xuaW1wb3J0IHsgVE9PTF9TVU1NQVJZX01BWF9MRU5HVEggfSBmcm9tICcuLi8uLi9jb25zdGFudHMvdG9vbExpbWl0cy5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB0eXBlIHsgUHJvZ3Jlc3NNZXNzYWdlIH0gZnJvbSAnLi4vLi4vdHlwZXMvbWVzc2FnZS5qcydcbmltcG9ydCB7IHRydW5jYXRlIH0gZnJvbSAnLi4vLi4vdXRpbHMvZm9ybWF0LmpzJ1xuaW1wb3J0IHR5cGUge1xuICBPdXRwdXQsXG4gIFNlYXJjaFJlc3VsdCxcbiAgV2ViU2VhcmNoUHJvZ3Jlc3MsXG59IGZyb20gJy4vV2ViU2VhcmNoVG9vbC5qcydcblxuZnVuY3Rpb24gZ2V0U2VhcmNoU3VtbWFyeShcbiAgcmVzdWx0czogKFNlYXJjaFJlc3VsdCB8IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpW10sXG4pOiB7XG4gIHNlYXJjaENvdW50OiBudW1iZXJcbiAgdG90YWxSZXN1bHRDb3VudDogbnVtYmVyXG59IHtcbiAgbGV0IHNlYXJjaENvdW50ID0gMFxuICBsZXQgdG90YWxSZXN1bHRDb3VudCA9IDBcblxuICBmb3IgKGNvbnN0IHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgaWYgKHJlc3VsdCAhPSBudWxsICYmIHR5cGVvZiByZXN1bHQgIT09ICdzdHJpbmcnKSB7XG4gICAgICBzZWFyY2hDb3VudCsrXG4gICAgICB0b3RhbFJlc3VsdENvdW50ICs9IHJlc3VsdC5jb250ZW50Py5sZW5ndGggPz8gMFxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IHNlYXJjaENvdW50LCB0b3RhbFJlc3VsdENvdW50IH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VNZXNzYWdlKFxuICB7XG4gICAgcXVlcnksXG4gICAgYWxsb3dlZF9kb21haW5zLFxuICAgIGJsb2NrZWRfZG9tYWlucyxcbiAgfTogUGFydGlhbDx7XG4gICAgcXVlcnk6IHN0cmluZ1xuICAgIGFsbG93ZWRfZG9tYWlucz86IHN0cmluZ1tdXG4gICAgYmxvY2tlZF9kb21haW5zPzogc3RyaW5nW11cbiAgfT4sXG4gIHsgdmVyYm9zZSB9OiB7IHZlcmJvc2U6IGJvb2xlYW4gfSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGlmICghcXVlcnkpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgbGV0IG1lc3NhZ2UgPSAnJ1xuXG4gIGlmIChxdWVyeSkge1xuICAgIG1lc3NhZ2UgKz0gYFwiJHtxdWVyeX1cImBcbiAgfVxuXG4gIGlmICh2ZXJib3NlKSB7XG4gICAgaWYgKGFsbG93ZWRfZG9tYWlucyAmJiBhbGxvd2VkX2RvbWFpbnMubGVuZ3RoID4gMCkge1xuICAgICAgbWVzc2FnZSArPSBgLCBvbmx5IGFsbG93aW5nIGRvbWFpbnM6ICR7YWxsb3dlZF9kb21haW5zLmpvaW4oJywgJyl9YFxuICAgIH1cblxuICAgIGlmIChibG9ja2VkX2RvbWFpbnMgJiYgYmxvY2tlZF9kb21haW5zLmxlbmd0aCA+IDApIHtcbiAgICAgIG1lc3NhZ2UgKz0gYCwgYmxvY2tpbmcgZG9tYWluczogJHtibG9ja2VkX2RvbWFpbnMuam9pbignLCAnKX1gXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG1lc3NhZ2Vcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VQcm9ncmVzc01lc3NhZ2UoXG4gIHByb2dyZXNzTWVzc2FnZXM6IFByb2dyZXNzTWVzc2FnZTxXZWJTZWFyY2hQcm9ncmVzcz5bXSxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGlmIChwcm9ncmVzc01lc3NhZ2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICBjb25zdCBsYXN0UHJvZ3Jlc3MgPSBwcm9ncmVzc01lc3NhZ2VzW3Byb2dyZXNzTWVzc2FnZXMubGVuZ3RoIC0gMV1cbiAgaWYgKCFsYXN0UHJvZ3Jlc3M/LmRhdGEpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgY29uc3QgZGF0YSA9IGxhc3RQcm9ncmVzcy5kYXRhXG5cbiAgc3dpdGNoIChkYXRhLnR5cGUpIHtcbiAgICBjYXNlICdxdWVyeV91cGRhdGUnOlxuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5TZWFyY2hpbmc6IHtkYXRhLnF1ZXJ5fTwvVGV4dD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApXG4gICAgY2FzZSAnc2VhcmNoX3Jlc3VsdHNfcmVjZWl2ZWQnOlxuICAgICAgcmV0dXJuIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgICAgIEZvdW5kIHtkYXRhLnJlc3VsdENvdW50fSByZXN1bHRzIGZvciAmcXVvdDt7ZGF0YS5xdWVyeX0mcXVvdDtcbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgKVxuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gbnVsbFxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJUb29sUmVzdWx0TWVzc2FnZShvdXRwdXQ6IE91dHB1dCk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgc2VhcmNoQ291bnQgfSA9IGdldFNlYXJjaFN1bW1hcnkob3V0cHV0LnJlc3VsdHMgPz8gW10pXG4gIGNvbnN0IHRpbWVEaXNwbGF5ID1cbiAgICBvdXRwdXQuZHVyYXRpb25TZWNvbmRzID49IDFcbiAgICAgID8gYCR7TWF0aC5yb3VuZChvdXRwdXQuZHVyYXRpb25TZWNvbmRzKX1zYFxuICAgICAgOiBgJHtNYXRoLnJvdW5kKG91dHB1dC5kdXJhdGlvblNlY29uZHMgKiAxMDAwKX1tc2BcblxuICByZXR1cm4gKFxuICAgIDxCb3gganVzdGlmeUNvbnRlbnQ9XCJzcGFjZS1iZXR3ZWVuXCIgd2lkdGg9XCIxMDAlXCI+XG4gICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgIDxUZXh0PlxuICAgICAgICAgIERpZCB7c2VhcmNoQ291bnR9IHNlYXJjaFxuICAgICAgICAgIHtzZWFyY2hDb3VudCAhPT0gMSA/ICdlcycgOiAnJ30gaW4ge3RpbWVEaXNwbGF5fVxuICAgICAgICA8L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICA8L0JveD5cbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VG9vbFVzZVN1bW1hcnkoXG4gIGlucHV0OiBQYXJ0aWFsPHsgcXVlcnk6IHN0cmluZyB9PiB8IHVuZGVmaW5lZCxcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWlucHV0Py5xdWVyeSkge1xuICAgIHJldHVybiBudWxsXG4gIH1cbiAgcmV0dXJuIHRydW5jYXRlKGlucHV0LnF1ZXJ5LCBUT09MX1NVTU1BUllfTUFYX0xFTkdUSClcbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsZUFBZSxRQUFRLHFDQUFxQztBQUNyRSxTQUFTQyx1QkFBdUIsUUFBUSwrQkFBK0I7QUFDdkUsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxjQUFjQyxlQUFlLFFBQVEsd0JBQXdCO0FBQzdELFNBQVNDLFFBQVEsUUFBUSx1QkFBdUI7QUFDaEQsY0FDRUMsTUFBTSxFQUNOQyxZQUFZLEVBQ1pDLGlCQUFpQixRQUNaLG9CQUFvQjtBQUUzQixTQUFTQyxnQkFBZ0JBLENBQ3ZCQyxPQUFPLEVBQUUsQ0FBQ0gsWUFBWSxHQUFHLE1BQU0sR0FBRyxJQUFJLEdBQUcsU0FBUyxDQUFDLEVBQUUsQ0FDdEQsRUFBRTtFQUNESSxXQUFXLEVBQUUsTUFBTTtFQUNuQkMsZ0JBQWdCLEVBQUUsTUFBTTtBQUMxQixDQUFDLENBQUM7RUFDQSxJQUFJRCxXQUFXLEdBQUcsQ0FBQztFQUNuQixJQUFJQyxnQkFBZ0IsR0FBRyxDQUFDO0VBRXhCLEtBQUssTUFBTUMsTUFBTSxJQUFJSCxPQUFPLEVBQUU7SUFDNUIsSUFBSUcsTUFBTSxJQUFJLElBQUksSUFBSSxPQUFPQSxNQUFNLEtBQUssUUFBUSxFQUFFO01BQ2hERixXQUFXLEVBQUU7TUFDYkMsZ0JBQWdCLElBQUlDLE1BQU0sQ0FBQ0MsT0FBTyxFQUFFQyxNQUFNLElBQUksQ0FBQztJQUNqRDtFQUNGO0VBRUEsT0FBTztJQUFFSixXQUFXO0lBQUVDO0VBQWlCLENBQUM7QUFDMUM7QUFFQSxPQUFPLFNBQVNJ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