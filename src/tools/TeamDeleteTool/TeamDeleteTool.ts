/**
 * ============================================================================
 *  【文件总览】src/tools/TeamDeleteTool/TeamDeleteTool.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 TeamDeleteTool.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  由主循环 src/query.ts 在需要对应能力时，通过工具调度（runTools → 工具 execute）调用本文件；本文件属于「工具层」，负责把某一类能力封装成一个可被模型点名的 Tool。
 *
 *  【本文件包含什么】
 *  主要导出/定义：Output、Input、TeamDeleteTool
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

import { z } from 'zod/v4'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  cleanupTeamDirectories,
  readTeamFile,
  unregisterTeamForSessionCleanup,
} from '../../utils/swarm/teamHelpers.js'
import { clearTeammateColors } from '../../utils/swarm/teammateLayoutManager.js'
import { clearLeaderTeamName } from '../../utils/tasks.js'
import { TEAM_DELETE_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

export type Output = {
  success: boolean
  message: string
  team_name?: string
}

export type Input = z.infer<InputSchema>

export const TeamDeleteTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_DELETE_TOOL_NAME,
  searchHint: 'disband a swarm team and clean up',
  maxResultSizeChars: 100_000,
  shouldDefer: true,

  userFacingName() {
    return ''
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return isAgentSwarmsEnabled()
  },

  async description() {
    return 'Clean up team and task directories when the swarm is complete'
  },

  async prompt() {
    return getPrompt()
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: jsonStringify(data),
        },
      ],
    }
  },

  async call(_input, context) {
    const { setAppState, getAppState } = context
    const appState = getAppState()
    const teamName = appState.teamContext?.teamName

    if (teamName) {
      // Read team config to check for active members
      const teamFile = readTeamFile(teamName)
      if (teamFile) {
        // Filter out the team lead - only count non-lead members
        const nonLeadMembers = teamFile.members.filter(
          m => m.name !== TEAM_LEAD_NAME,
        )

        // Separate truly active members from idle/dead ones
        // Members with isActive === false are idle (finished their turn or crashed)
        const activeMembers = nonLeadMembers.filter(m => m.isActive !== false)

        if (activeMembers.length > 0) {
          const memberNames = activeMembers.map(m => m.name).join(', ')
          return {
            data: {
              success: false,
              message: `Cannot cleanup team with ${activeMembers.length} active member(s): ${memberNames}. Use requestShutdown to gracefully terminate teammates first.`,
              team_name: teamName,
            },
          }
        }
      }

      await cleanupTeamDirectories(teamName)
      // Already cleaned — don't try again on gracefulShutdown.
      unregisterTeamForSessionCleanup(teamName)

      // Clear color assignments so new teams start fresh
      clearTeammateColors()

      // Clear leader team name so getTaskListId() falls back to session ID
      clearLeaderTeamName()

      logEvent('tengu_team_deleted', {
        team_name:
          teamName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }

    // Clear team context and inbox from app state
    setAppState(prev => ({
      ...prev,
      teamContext: undefined,
      inbox: {
        messages: [], // Clear any queued messages
      },
    }))

    return {
      data: {
        success: true,
        message: teamName
          ? `Cleaned up directories and worktrees for team "${teamName}"`
          : 'No team name found, nothing to clean up',
        team_name: teamName,
      },
    }
  },

  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
