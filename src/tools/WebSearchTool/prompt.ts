/**
 * ============================================================================
 *  【文件总览】src/tools/WebSearchTool/prompt.ts —— WebSearch 的「工具说明书」
 * ============================================================================
 *
 *  【一句话定位】
 *  一个函数，生成 WebSearch 工具在系统提示词里的那段英文说明。
 *  内容随**当前年月**动态变化——这是本文件唯一的"逻辑"。
 *
 *  【在架构中的位置】
 *      系统提示词组装
 *        └─> WebSearchTool.prompt()      ← WebSearchTool.ts
 *              └─> getWebSearchPrompt()  ← ★ 本文件
 *                    └─> getLocalMonthYear() ← src/constants/common.js（取本地年月）
 *
 *  【本文件包含什么】
 *   1. WEB_SEARCH_TOOL_NAME  工具名常量 'WebSearch'
 *   2. getWebSearchPrompt()  生成完整的工具描述文本
 *
 *  【为什么要关心"当前年月"？——这是本文件存在的最大理由】
 *  模型有个**知识截止日期（knowledge cutoff）**，它对截止之后发生的事一无所知，
 *  而且它在生成搜索词时容易凭"训练时的印象"写出过时的年份。
 *  实测常见问题：用户问"最新的 React 文档"，模型去搜 "React documentation 2023"
 *  （它印象里的年份），而不是今年。
 *  所以这里**每次调用都取一次本地年月**，硬塞进提示词，反复强调
 *  "现在是 X 年，你必须用这个年份去搜"。这是一个很朴素的抗幻觉手法，
 *  但很有效——比让模型自己猜可靠得多。
 *
 *  【为什么还要强制写 Sources 区块？】
 *  搜索结果的价值一半在于"可溯源"。如果不强制，模型常常把搜到的内容
 *  揉进回答却**不给链接**，用户无法核实，也无法进一步阅读。
 *  所以提示词里用全大写 CRITICAL REQUIREMENT / MANDATORY 这种强措辞，
 *  并要求用 markdown 超链接 `[标题](URL)` 的形式列出。
 *  （WebSearchTool.ts 的 mapToolResultToToolResultBlockParam 末尾还会
 *   再补一句 REMINDER，双保险。）
 *
 *  【TS 语法速查】
 *   - `export const X = '...'`    导出常量 ≈ Java 的 public static final String
 *   - `export function f(): string` 导出函数；返回值类型在**后面**（Java 在前面）
 *   - 反引号模板字符串 `` `...${x}...` ``：可换行 + 直接嵌变量
 *     ≈ Java 的 String.format / Java 21+ 的 STR 模板处理器
 *   - 注意：这里是 `import { x } from 'src/constants/...'` 用**绝对路径**
 *     （其它文件多用 '../../' 相对路径）——本仓库两种写法都存在
 * ============================================================================
 */
import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

/**
 * 生成 WebSearch 工具给模型看的完整说明。
 *
 * 【做什么】把"能力描述 + 强制来源要求 + 使用注意 + 当前年月"拼成一段文本。
 * 【为什么需要它每次都重新计算（而不是写死一个常量）】
 *   因为里面的 `${currentMonthYear}` 是**运行时**才确定的。
 *   写死就会过期——等你明年再跑，提示词还在说去年。
 * 【为什么需要这段说明】模型靠它决定：
 *   ① 什么时候该用 WebSearch（超出知识截止、需要实时信息时）；
 *   ② 用完之后必须怎么输出（回答末尾要有 Sources 区块、要用 markdown 链接）；
 *   ③ 搜索词里必须写对年份（见文件头说明）。
 * 【入参】无
 * 【返回】string —— 直接进入系统提示词的工具描述
 * 【关键步骤】
 *   ① getLocalMonthYear() 取本地当前年月（如 "October 2026"）
 *   ② 用模板字符串把年月嵌进 "IMPORTANT - Use the correct year" 那一段
 *   ③ 返回整段文本
 */
export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US

IMPORTANT - Use the correct year in search queries:
  - The current month is ${currentMonthYear}. You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
`
}
