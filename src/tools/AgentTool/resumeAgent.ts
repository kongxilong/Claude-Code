/**
 * 【一句话定位】让一个**已经结束的**子 Agent 带着完整上下文继续跑——就是 SendMessage 续跑 /
 * resumeAgent 背后的实现。
 *
 * 【在架构中的位置】
 *   上游：
 *     SendMessageTool（主 Agent 对某个 agentId 发消息）
 *       → 本文件的 resumeAgentBackground()
 *     （同步续跑场景则由别的路径处理，本文件只做**后台**续跑）
 *   下游：
 *     utils/sessionStorage.js 的 getAgentTranscript() / readAgentMetadata() —— 从磁盘读回上次的对话
 *     utils/toolResultStorage.js 的 reconstructForSubagentResume() —— 还原被替换掉的大工具结果
 *     runAgent.ts —— 用「旧对话 + 新 user message」再开一个 query 循环
 *     agentToolUtils.ts 的 runAsyncAgentLifecycle() —— 和首次启动共用同一套后台生命周期
 *
 * 【resume 是怎么做到的】(本文件的核心机制)
 *   ① 持久化：runAgent.ts 每产出一条消息就调用 recordSidechainTranscript() 把它落盘到
 *      ~/.claude/projects/<project>/<session>/subagents/agent-<agentId>.jsonl（sidechain transcript），
 *      每条消息都记了 parentUuid，形成一条链。
 *   ② 元数据：writeAgentMetadata() 单独存 agentType / worktreePath / description，
 *      这样下次续跑时即使调用方没传 subagent_type，也能路由回正确的 agent 定义。
 *   ③ 读回：getAgentTranscript(agentId) 拿到完整消息链，readAgentMetadata(agentId) 拿到元数据。
 *   ④ 清洗：三个过滤器依次跑——
 *        filterUnresolvedToolUses（去掉没结果的 tool_use）、
 *        filterOrphanedThinkingOnlyMessages（去掉孤立的纯 thinking 消息）、
 *        filterWhitespaceOnlyAssistantMessages（去掉只有空白的 assistant 消息）。
 *      这些半截消息如果直接发给 API 会报错。
 *   ⑤ 续接：把新 prompt 作为一条新的 user message 追加到旧对话末尾，交给 runAgent 继续跑。
 *      agentId **保持不变**，所以 transcript 是接着写的，可以无限次续跑。
 *   ⑥ fork 续跑的特殊处理：fork 的上下文切片已经在 transcript 里了，不能再传一次
 *      forkContextMessages（会造成 tool_use id 重复），所以这里显式传 undefined。
 *
 * 【本文件包含什么】
 *   - ResumeAgentResult：返回给调用方的结果（agentId / description / outputFile）。
 *   - resumeAgentBackground()：唯一的导出函数，做「读盘 → 清洗 → 还原 → 起后台任务」四件事。
 *
 * 【TS 语法速查】(针对本文件实际出现的语法)
 *   - `Promise.all([a, b])` ≈ CompletableFuture.allOf：并发等两个异步操作，返回元组数组。
 *     配合解构 `const [transcript, meta] = await Promise.all([...])` 一次拿到两个结果。
 *   - `.then(onOk, onErr)`：Promise 的两个参数形式，第二个是失败回调，≈ try-catch 的简写。
 *   - `??` 空值合并（0 和 '' 不被替换，与 `||` 的关键区别）；`?.` 可选链；`!` 后缀非空断言。
 *   - `meta?.worktreePath ? ... : undefined` 双保险：先可选链取值，再用三元兜底。
 *   - `type X = { a: string; b?: number }` ≈ Java record + 可选字段。
 *   - 函数嵌套调用：`filterA(filterB(filterC(x)))` 从内往外执行（和 Java 一样）。
 *   - `{ ...runAgentParams, override: {...runAgentParams.override, agentId} }`：
 *     两层展开 = 复制一层再覆盖一个字段，且被覆盖的字段本身也是「复制+覆盖」得到的。
 *     这是 TS 里做不可变更新的标准写法（≈ Builder 链，但每次都产生新对象）。
 *   - `...(cond && { k: v })` 条件展开：cond 为 false 时展开 false ≡ 什么都不加。
 *   - `Parameters<typeof runAgent>[0]`：取 runAgent 第一个参数的类型（反射式取签名），
 *     好处是 runAgent 改签名时这里编译期就报错。
 *   - `void expr`：故意丢弃返回值（fire-and-forget），常见于启动一个不等待的后台任务。
 *   - `async (...) => {...}` 异步箭头函数 ≈ Java 的 lambda 返回 CompletableFuture。
 *   - `<T>(fn: () => T): T` 泛型箭头函数：`.ts` 文件里可以直接写 `<T>`（.tsx 里要写 `<T,>`）。
 *   - `import { promises as fsp } from 'fs'`：Node 的 fs/promises 模块，取别名 fsp。
 *   - `as const`：`agentType: 'subagent' as const` 把字面量锁成类型 'subagent' 而非 string。
 *   - `Promise<ResumeAgentResult>`：返回 Promise<T> ≈ Java 的 CompletableFuture<T>。
 */
import { promises as fsp } from 'fs'
import { getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { registerAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { assembleToolPool } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import { runWithAgentContext } from '../../utils/agentContext.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  getAgentTranscript,
  readAgentMetadata,
} from '../../utils/sessionStorage.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getParentSessionId } from '../../utils/teammate.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { FORK_AGENT, isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'

// 返回给调用方的结果：agentId（可用它再续跑）、description（通知里显示）、outputFile（进度文件）
export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
}
/**
 * 在后台续跑一个已存在的子 Agent。
 *
 * 关键步骤：
 *   ① 并发读盘：getAgentTranscript（完整对话）+ readAgentMetadata（agentType/worktree/description）
 *   ② 清洗历史消息：去掉未完成的 tool_use、孤立的 thinking、纯空白的 assistant
 *   ③ 还原工具结果替换状态（reconstructForSubagentResume），保持 prompt cache 稳定
 *   ④ 确认 worktree 还在（可能被外部删了），还在就 bump mtime 防止被误清理
 *   ⑤ 按元数据里的 agentType 找回 agent 定义（找不到就退化成 general-purpose）
 *   ⑥ fork 续跑要重建父级 system prompt（否则报「无法恢复」）
 *   ⑦ 组装 runAgent 参数，把新 prompt 作为 user message 追加到旧对话末尾
 *   ⑧ 注册后台任务，fire-and-forget 跑 runAsyncAgentLifecycle，立刻返回结果
 *
 * 注意 ⑤ 里**故意不**重新跑 filterDeniedAgents 权限校验：
 * 首次派生时已经过了权限检查，续跑是同一段会话的延续，不该再拦一次。
 *
 * @param agentId 要续跑的 agent 的 ID（保持不变，transcript 会接着写）
 * @param prompt 这一轮要追加给它的新指令
 * @returns agentId / description / outputFile，调用方（主 Agent）拿它做后续交互
 */
export async function resumeAgentBackground({
  agentId,
  prompt,
  toolUseContext,
  canUseTool,
  invokingRequestId,
}: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
}): Promise<ResumeAgentResult> {
  const startTime = Date.now()
  const appState = toolUseContext.getAppState()
  // In-process teammates get a no-op setAppState; setAppStateForTasks
  // reaches the root store so task registration/progress/kill stay visible.
// 通往根 AppState 的写通道（父级是异步 agent 时 toolUseContext.setAppState 会退化成 no-op）
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const permissionMode = appState.toolPermissionContext.mode

// 并发读：transcript（对话）和 meta（元数据）互不依赖，一起等省一半时间
  const [transcript, meta] = await Promise.all([
    getAgentTranscript(asAgentId(agentId)),
    readAgentMetadata(asAgentId(agentId)),
  ])
// 没有 transcript 就说明这个 agentId 从来没跑过（或文件被清了），只能报错
  if (!transcript) {
    throw new Error(`No transcript found for agent ID: ${agentId}`)
  }
// 三层清洗，从内到外：未完成的 tool_use → 孤立 thinking → 纯空白 assistant。
// 这些「半截消息」是上次会话被中断留下的，直接发给 API 会报 400。
  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )
// 还原「大工具结果被替换成占位符」的状态：续跑时要用相同的替换规则，
// 否则 prompt 前缀变了就命中不了 cache。
  const resumedReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    resumedMessages,
    transcript.contentReplacements,
  )
// worktree 可能已被外部删掉，用 stat 确认还在（是目录才算）。
// 失败了就退回父级 cwd，而不是让后面 chdir 到一个不存在的路径然后崩掉。
  // Best-effort: if the original worktree was removed externally, fall back
  // to parent cwd rather than crashing on chdir later.
  const resumedWorktreePath = meta?.worktreePath
    ? await fsp.stat(meta.worktreePath).then(
        s => (s.isDirectory() ? meta.worktreePath : undefined),
        () => {
          logForDebugging(
            `Resumed worktree ${meta.worktreePath} no longer exists; falling back to parent cwd`,
          )
          return undefined
        },
      )
    : undefined
// bump mtime：刚恢复的 worktree 不该被「陈旧 worktree 清理」逻辑删掉（#22355）
  if (resumedWorktreePath) {
    // Bump mtime so stale-worktree cleanup doesn't delete a just-resumed worktree (#22355)
    const now = new Date()
    await fsp.utimes(resumedWorktreePath, now, now)
  }

// 按元数据里的 agentType 找回定义。找不到就退化成 general-purpose（宁可通用也不要失败）。
// 这里刻意跳过 filterDeniedAgents：首次派生已经过了权限，续跑不应该再拦一次。
  // Skip filterDeniedAgents re-gating — original spawn already passed permission checks
  let selectedAgent: AgentDefinition
  let isResumedFork = false
  if (meta?.agentType === FORK_AGENT.agentType) {
    selectedAgent = FORK_AGENT
    isResumedFork = true
  } else if (meta?.agentType) {
    const found = toolUseContext.options.agentDefinitions.activeAgents.find(
      a => a.agentType === meta.agentType,
    )
    selectedAgent = found ?? GENERAL_PURPOSE_AGENT
  } else {
    selectedAgent = GENERAL_PURPOSE_AGENT
  }

  const uiDescription = meta?.description ?? '(resumed)'

// fork 续跑：必须重建父级的 system prompt 才能保持 cache 前缀一致；
// 重建不出来就只能报错（fork 对字节一致性要求严格，不能凑合）
  let forkParentSystemPrompt: SystemPrompt | undefined
  if (isResumedFork) {
    if (toolUseContext.renderedSystemPrompt) {
      forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
    } else {
      const mainThreadAgentDefinition = appState.agent
        ? appState.agentDefinitions.activeAgents.find(
            a => a.agentType === appState.agent,
          )
        : undefined
      const additionalWorkingDirectories = Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      )
      const defaultSystemPrompt = await getSystemPrompt(
        toolUseContext.options.tools,
        toolUseContext.options.mainLoopModel,
        additionalWorkingDirectories,
        toolUseContext.options.mcpClients,
      )
      forkParentSystemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt: toolUseContext.options.customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
      })
    }
    if (!forkParentSystemPrompt) {
      throw new Error(
        'Cannot resume fork agent: unable to reconstruct parent system prompt',
      )
    }
  }

// 只是给埋点/通知用的模型名（runAgent 内部会自己再解析一次）
  // Resolve model for analytics metadata (runAgent resolves its own internally)
  const resolvedAgentModel = getAgentModel(
    selectedAgent.model,
    toolUseContext.options.mainLoopModel,
    undefined,
    permissionMode,
  )

// 工具池：fork 续跑直接用父级工具数组（保持 cache 一致），普通续跑重新组装一份
  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: selectedAgent.permissionMode ?? 'acceptEdits',
  }
  const workerTools = isResumedFork
    ? toolUseContext.options.tools
    : assembleToolPool(workerPermissionContext, appState.mcp.tools)

// 组装 runAgent 参数包。注意 promptMessages 是「旧对话 + 新 user message」，
// 这就是「上下文保留」的本质——把历史消息原样带回去。
  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({ content: prompt }),
    ],
    toolUseContext,
    canUseTool,
    isAsync: true,
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    model: undefined,
    // Fork resume: pass parent's system prompt (cache-identical prefix).
    // Non-fork: undefined → runAgent recomputes under wrapWithCwd so
    // getCwd() sees resumedWorktreePath.
// fork 续跑：传父级 system prompt（cache 一致）；普通续跑传 undefined，
// 让 runAgent 在 wrapWithCwd 内部重算，这样 getCwd() 才是 worktree 路径
    override: isResumedFork
      ? { systemPrompt: forkParentSystemPrompt }
      : undefined,
    availableTools: workerTools,
    // Transcript already contains the parent context slice from the
    // original fork. Re-supplying it would cause duplicate tool_use IDs.
// 关键：fork 的上下文切片**已经在 transcript 里了**，不能再传一次，
// 否则会产生重复的 tool_use id，API 直接报错
    forkContextMessages: undefined,
    ...(isResumedFork && { useExactTools: true }),
// 重新持久化 worktreePath：runAgent 启动时会覆盖写一次 metadata，不补上就丢了
    // Re-persist so metadata survives runAgent's writeAgentMetadata overwrite
    worktreePath: resumedWorktreePath,
    description: meta?.description,
    contentReplacementState: resumedReplacementState,
  }

  // Skip name-registry write — original entry persists from the initial spawn
// 注册后台任务。name → agentId 的映射不重写：首次派生时写的那条还在，继续有效
  const agentBackgroundTask = registerAsyncAgent({
    agentId,
    description: uiDescription,
    prompt,
    selectedAgent,
    setAppState: rootSetAppState,
    toolUseId: toolUseContext.toolUseId,
  })

  const metadata = {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent: isBuiltInAgent(selectedAgent),
    startTime,
    agentType: selectedAgent.agentType,
    isAsync: true,
  }

// 埋点上下文：invocationKind 是 'resume'（区别于首次派生的 'spawn'）
  const asyncAgentContext = {
    agentId,
    parentSessionId: getParentSessionId(),
    agentType: 'subagent' as const,
    subagentName: selectedAgent.agentType,
    isBuiltIn: isBuiltInAgent(selectedAgent),
    invokingRequestId,
    invocationKind: 'resume' as const,
    invocationEmitted: false,
  }

// cwd 覆盖包装：有 worktree 就切到 worktree 目录里跑
  const wrapWithCwd = <T>(fn: () => T): T =>
    resumedWorktreePath ? runWithCwdOverride(resumedWorktreePath, fn) : fn()

// `void` = fire-and-forget：续跑在后台进行，本函数立刻返回，
// 主 Agent 拿到 agentId 后可以继续干别的，完成后会以 task-notification 形式通知它
  void runWithAgentContext(asyncAgentContext, () =>
    wrapWithCwd(() =>
      runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        makeStream: onCacheSafeParams =>
          runAgent({
            ...runAgentParams,
            override: {
              ...runAgentParams.override,
              agentId: asAgentId(agentBackgroundTask.agentId),
              abortController: agentBackgroundTask.abortController!,
            },
            onCacheSafeParams,
          }),
        metadata,
        description: uiDescription,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: agentId,
        enableSummarization:
          isCoordinatorMode() ||
          isForkSubagentEnabled() ||
          getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: async () =>
          resumedWorktreePath ? { worktreePath: resumedWorktreePath } : {},
      }),
    ),
  )

  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),
  }
}
