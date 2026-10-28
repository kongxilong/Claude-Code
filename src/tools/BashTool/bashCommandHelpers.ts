/**
 * 【一句话定位】处理「复合命令」的权限判定：把带管道 / 子 shell / 命令组的命令切成段，
 *   逐段送进完整权限系统，并专门拦截 `cd` + `git` 的组合攻击。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx 的 hasPermission（简单命令走规则表，复杂命令先过这里）
 *   下游：bashSecurity.ts（bashCommandIsSafeAsync_DEPRECATED）、
 *        utils/bash/ParsedCommand.js（AST 封装）、utils/bash/parser.js（tree-sitter 解析）、
 *        utils/bash/commands.js（splitCommand_DEPRECATED）、utils/permissions/permissions.js
 *   调用链：BashTool.hasPermission -> checkCommandOperatorPermissions
 *            -> bashToolCheckCommandOperatorPermissions -> segmentedCommandPermissionResult
 *            -> 每段再回调 bashToolHasPermissionFn（回到 BashTool 的完整权限流程，形成递归下钻）
 *
 * 【本文件包含什么】
 *   - CommandIdentityCheckers：两个判定函数组成的「回调包」类型（是不是 cd / 是不是 git）
 *   - segmentedCommandPermissionResult()：对已切好的若干段做汇总判定（核心）
 *   - buildSegmentWithoutRedirections()：去掉输出重定向，避免文件名被当成命令
 *   - checkCommandOperatorPermissions()：对外主入口（唯一导出函数）
 *   - bashToolCheckCommandOperatorPermissions()：真正的判定流程（子 shell → 管道 → 逐段）
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `async / await` ≈ Java 的 CompletableFuture，但写法像同步代码；async 函数返回值一律是 Promise
 *   - `Promise<T>` ≈ CompletableFuture<T>；`Promise.all(arr)` ≈ 并发等待全部完成再拿到数组
 *   - `Map<K, V>` ≈ Java HashMap；`Array.from(map.entries())` 把 Map 转成 [k, v] 数组再遍历
 *   - `?.` 可选链 ≈ null 检查链：obj?.a?.b，遇到 null/undefined 直接短路返回 undefined，不抛 NPE
 *   - `??` 空值合并：只在左侧是 null/undefined 时取右侧（注意与 || 区别：0 和 '' 不会被替换）
 *   - `{ ...input, command: x }` 对象展开 ≈ 复制一份再覆盖字段，实现「不可变更新」
 *   - `'suggestions' in result` 是 JS 的 in 运算符：判断对象上有没有这个键（比 !== undefined 更准确）
 *   - `as const` 用在对象字面量上，把 'other' 收窄成字面量类型而不是 string
 *   - 函数类型参数 `(input: X) => Promise<Y>` ≈ Java 的函数式接口 / Callback，本文件的递归靠它实现
 *   - `Array.prototype.filter/find/every` ≈ stream().filter/findFirst/allMatch
 *   - 类型标注在变量名**后面**，Java 在前面，最容易看串
 */
import type { z } from 'zod/v4'
import {
  isUnsafeCompoundCommand_DEPRECATED,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import {
  buildParsedCommandFromRoot,
  type IParsedCommand,
  ParsedCommand,
} from '../../utils/bash/ParsedCommand.js'
import { type Node, PARSE_ABORTED } from '../../utils/bash/parser.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { createPermissionRequestMessage } from '../../utils/permissions/permissions.js'
import { BashTool } from './BashTool.js'
import { bashCommandIsSafeAsync_DEPRECATED } from './bashSecurity.js'

// 为什么要「传函数进来」而不是直接 import：这两个判定函数定义在 bashPermissions.ts，
// 而本文件若直接 import 它就会形成循环依赖。用回调注入（≈ Java 的函数式接口/依赖注入）绕开
// TS 速查：这种写法≈一个只有方法的接口，字段类型是函数签名 `(s: string) => boolean`
export type CommandIdentityCheckers = {
  isNormalizedCdCommand: (command: string) => boolean
  isNormalizedGitCommand: (command: string) => boolean
}

/**
 * 【做什么】对已经切好的若干命令段做「汇总式」权限判定
 * 【为什么需要】管道命令 `a | b | c` 里每一段都可能有不同风险，必须逐段判、再合并结论；
 *   而且有些攻击（跨段的 cd + git）单看任何一段都发现不了，必须放在这里做全局检查
 * 【入参】input：原始工具入参；segments：切好的命令段数组；
 *       bashToolHasPermissionFn：回调，用来对单段跑一遍完整权限流程（递归下钻）；
 *       checkers：cd / git 判定函数包
 * 【返回】deny（任一段被拒）/ allow（全部放行）/ ask（其余，附带建议规则）
 * 【关键步骤】
 *   ① 先查「多个 cd」：一条命令里出现两次以上 cd，路径意图不清晰，一律询问
 *   ② 再查「跨段 cd + git」：这是 bare repo fsmonitor 绕过攻击的拦截点（见下方详细说明）
 *   ③ 逐段回调 bashToolHasPermissionFn，结果存进 Map（段 → 结论）
 *   ④ 先看有没有 deny（先把所有段都跑完再判断，保证 decisionReason 里信息完整）
 *   ⑤ 再看是不是全 allow；否则落 ask，并把各段给出的建议规则收集起来一起上报
 */
async function segmentedCommandPermissionResult(
  input: z.infer<typeof BashTool.inputSchema>,
  segments: string[],
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
): Promise<PermissionResult> {
  // Check for multiple cd commands across all segments
  // 为什么要限制 cd 的数量：一条命令里连着 cd 两次，人类都容易看错最终工作目录在哪，
  //   模型和用户更看不清，所以宁可多问一次（这是「可读性优先」而非「能力优先」的取舍）
  const cdCommands = segments.filter(segment => {
    const trimmed = segment.trim()
    return checkers.isNormalizedCdCommand(trimmed)
  })
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason:
        'Multiple directory changes in one command require approval for clarity',
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // SECURITY: Check for cd+git across pipe segments to prevent bare repo fsmonitor bypass.
  // 中文详解（安全重点）：
  //   攻击场景——当前目录里有个「裸仓库」（bare repo，只有 .git 内容没有工作区）。
  //   模型先 cd 进那个目录，再跑 git status；此时 git 会按当前目录的 .git 走，
  //   而权限规则里「针对本仓库的 git 命令放行」的判断是基于**项目根目录**的，于是被绕过。
  //   更麻烦的是 cd 与 git 可能落在**不同管道段**里（如 `cd sub && echo | git status`），
  //   每段单独检查都是干净的，所以必须在这一层做「跨段」组合检测
  // When cd and git are in different pipe segments (e.g., "cd sub && echo | git status"),
  // each segment is checked independently and neither triggers the cd+git check in
  // bashPermissions.ts. We must detect this cross-segment pattern here.
  // Each pipe segment can itself be a compound command (e.g., "cd sub && echo"),
  // so we split each segment into subcommands before checking.
  {
    let hasCd = false
    let hasGit = false
    for (const segment of segments) {
      // 注意是两层拆分：管道段内部本身还可能是复合命令（如 `cd sub && echo`），
      //   所以要先按管道切段、每段再按 && / ; 切子命令，才能准确找到 cd 和 git
      const subcommands = splitCommand_DEPRECATED(segment)
      for (const sub of subcommands) {
        const trimmed = sub.trim()
        if (checkers.isNormalizedCdCommand(trimmed)) {
          hasCd = true
        }
        if (checkers.isNormalizedGitCommand(trimmed)) {
          hasGit = true
        }
      }
    }
    if (hasCd && hasGit) {
      const decisionReason = {
        type: 'other' as const,
        reason:
          'Compound commands with cd and git require approval to prevent bare repository attacks',
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  // 用 Map 而不是数组：段可能重复，且后面要按段名回溯结论、放进 decisionReason 给 UI 展示
  const segmentResults = new Map<string, PermissionResult>()

  // Check each segment through the full permission system
  for (const segment of segments) {
    const trimmedSegment = segment.trim()
    if (!trimmedSegment) continue // Skip empty segments

    // { ...input, command: trimmedSegment }：复制原入参、只替换 command，
    //   保证其它字段（如 run_in_background）在递归判定里不丢失（不可变更新的典型写法）
    const segmentResult = await bashToolHasPermissionFn({
      ...input,
      command: trimmedSegment,
    })
    segmentResults.set(trimmedSegment, segmentResult)
  }

  // Check if any segment is denied (after evaluating all)
  // 先跑完所有段再找 deny：这样即使第 1 段就被拒，也能在 UI 上展示每一段各自的原因
  // 解构写法 ([, result])：只取二元组的第 2 项（下划线位置留空表示忽略第 1 项）
  const deniedSegment = Array.from(segmentResults.entries()).find(
    ([, result]) => result.behavior === 'deny',
  )

  if (deniedSegment) {
    const [segmentCommand, segmentResult] = deniedSegment
    return {
      behavior: 'deny',
      message:
        segmentResult.behavior === 'deny'
          ? segmentResult.message
          : `Permission denied for: ${segmentCommand}`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: segmentResults,
      },
    }
  }

  // every ≈ stream().allMatch：必须每一段都是 allow，整条才算 allow
  // 注意：空数组时 every 返回 true（逻辑上的「全称量词」），这里段数至少为 2 才走到本函数，故安全
  const allAllowed = Array.from(segmentResults.values()).every(
    result => result.behavior === 'allow',
  )

  if (allAllowed) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: segmentResults,
      },
    }
  }

  // Collect suggestions from segments that need approval
  // 收集各段给出的「建议规则」：例如用户批准 `git status` 后可以顺手记一条 Bash(git:status) 规则
  const suggestions: PermissionUpdate[] = []
  for (const [, result] of segmentResults) {
    if (
      result.behavior !== 'allow' &&
      // `in` 运算符判断对象上是否存在该键。为什么不用 result.suggestions !== undefined：
      //   有些结论对象会显式把 suggestions 写成 undefined，用 in 才能区分「有键但值为空」和「压根没这个键」
      'suggestions' in result &&
      result.suggestions
    ) {
      suggestions.push(...result.suggestions)
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: segmentResults,
  }

  return {
    behavior: 'ask',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  }
}

/**
 * Builds a command segment, stripping output redirections to avoid
 * treating filenames as commands in permission checking.
 * Uses ParsedCommand to preserve original quoting.
 */
/**
 * 【做什么】把一段命令里的输出重定向（> / >> 等）去掉
 * 【为什么需要】`echo hi > rm -rf /` 里重定向后面的只是文件名；
 *   若不去重定向，权限检查会把文件名误当成命令来分析，可能误判
 * 【入参】segmentCommand：单个管道段的文本
 * 【返回】去掉重定向后的命令；解析失败时原样返回（宁可不处理，也不能返回空串导致漏检）
 * 【关键步骤】
 *   ① 快路径：不含 '>' 就直接返回，省掉一次昂贵的 AST 解析（性能考虑）
 *   ② 走 ParsedCommand.parse 做真正的语法解析（按 AST 去掉重定向，能正确处理引号）
 *   ③ `?? segmentCommand`：解析返回 null/undefined 时回退到原文（?? 只兜 null/undefined，不兜空串）
 */
async function buildSegmentWithoutRedirections(
  segmentCommand: string,
): Promise<string> {
  // Fast path: skip parsing if no redirection operators present
  if (!segmentCommand.includes('>')) {
    return segmentCommand
  }

  // Use ParsedCommand to strip redirections while preserving quotes
  const parsed = await ParsedCommand.parse(segmentCommand)
  return parsed?.withoutOutputRedirections() ?? segmentCommand
}

/**
 * Wrapper that resolves an IParsedCommand (from a pre-parsed AST root if
 * available, else via ParsedCommand.parse) and delegates to
 * bashToolCheckCommandOperatorPermissions.
 */
/**
 * 【做什么】复合命令权限判定的对外主入口
 * 【为什么需要】上游手里可能已经有解析好的 AST（避免重复解析），也可能什么都没有；
 *   本函数负责把这两种情况统一成一个 IParsedCommand，再交给下面的判定流程
 * 【入参】input：工具入参；bashToolHasPermissionFn：单段权限回调；checkers：cd/git 判定包；
 *       astRoot：上游已解析好的 AST 根节点，或是 PARSE_ABORTED（表示上游放弃解析），或是 null
 * 【返回】同 segmentedCommandPermissionResult；解析失败时返回 passthrough（交给主流程兜底）
 * 【关键步骤】
 *   ① 有 AST 就用 buildParsedCommandFromRoot 复用；没有才自己 ParsedCommand.parse
 *   ② `astRoot !== PARSE_ABORTED`：PARSE_ABORTED 是一个哨兵值，表示「解析被主动放弃」，不能当真 AST 用
 *   ③ 解析不出结果 → passthrough，不猜、不放行
 */
export async function checkCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  astRoot: Node | null | typeof PARSE_ABORTED,
): Promise<PermissionResult> {
  const parsed =
    // astRoot && ... 同时排除 null 与 PARSE_ABORTED（PARSE_ABORTED 本身是个真值对象，必须显式排除）
    astRoot && astRoot !== PARSE_ABORTED
      ? buildParsedCommandFromRoot(input.command, astRoot)
      : await ParsedCommand.parse(input.command)
  if (!parsed) {
    return { behavior: 'passthrough', message: 'Failed to parse command' }
  }
  return bashToolCheckCommandOperatorPermissions(
    input,
    bashToolHasPermissionFn,
    checkers,
    parsed,
  )
}

/**
 * Checks if the command has special operators that require behavior beyond
 * simple subcommand checking.
 */
/**
 * 【做什么】复合命令的判定主干：先查子 shell / 命令组，再查管道，最后逐段判定
 * 【为什么需要】子 shell（`( ... )`）和命令组（`{ ...; }`）里的命令无法被简单拆分，
 *   属于「看不清就没法保证安全」的情形，必须整条升级为询问
 * 【入参】同上，parsed 是已经解析好的命令对象（IParsedCommand）
 * 【返回】ask（含子 shell/命令组）/ passthrough（无管道，交给普通流程）/ 段的汇总结论
 * 【关键步骤】
 *   ① 取 tree-sitter 分析结果判断有无子 shell / 命令组；拿不到分析结果就退回旧的正则判断
 *   ② 有 → 调 bashCommandIsSafeAsync_DEPRECATED 要一条更具体的拒绝理由，然后 ask
 *   ③ 取管道段；段数 ≤ 1 说明没有管道，passthrough 让普通流程处理
 *   ④ 每段去掉重定向，再交给 segmentedCommandPermissionResult 汇总
 */
async function bashToolCheckCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  parsed: IParsedCommand,
): Promise<PermissionResult> {
  // 1. Check for unsafe compound commands (subshells, command groups).
  // tree-sitter 是真正的 bash 语法解析器（比正则可靠得多）；
  //   拿不到分析结果时回退到旧的正则实现 DEPRECATED 版——属于「新老实现并存」的过渡设计
  const tsAnalysis = parsed.getTreeSitterAnalysis()
  const isUnsafeCompound = tsAnalysis
    ? tsAnalysis.compoundStructure.hasSubshell ||
      tsAnalysis.compoundStructure.hasCommandGroup
    : isUnsafeCompoundCommand_DEPRECATED(input.command)
  if (isUnsafeCompound) {
    // This command contains an operator like `>` that we don't support as a subcommand separator
    // Check if bashCommandIsSafe_DEPRECATED has a more specific message
    // 只为拿一句更贴切的解释文案（如「不支持子 shell」），结论本身已经确定为 ask
    const safetyResult = await bashCommandIsSafeAsync_DEPRECATED(input.command)

    const decisionReason = {
      type: 'other' as const,
      reason:
        safetyResult.behavior === 'ask' && safetyResult.message
          ? safetyResult.message
          : 'This command uses shell operators that require approval for safety',
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
      // This is an unsafe compound command, so we don't want to suggest rules since we wont be able to allow it
      // 中文补充：这里刻意**不返回 suggestions**——子 shell 类命令即使加了规则也无法放行，
      // 给出建议只会误导用户「批准一次就能记住」，属于体验上的坑
    }
  }

  // 2. Check for piped commands using ParsedCommand (preserves quotes)
  // 按管道符切段（基于 AST，因此引号里出现的 | 不会被误当管道符，这正是比正则强的地方）
  const pipeSegments = parsed.getPipeSegments()

  // If no pipes (single segment), let normal flow handle it
  // 段数为 1 = 没有管道：普通流程（规则表）已经能处理，这里不重复判，直接放行给下游
  if (pipeSegments.length <= 1) {
    return {
      behavior: 'passthrough',
      message: 'No pipes found in command',
    }
  }

  // Strip output redirections from each segment while preserving quotes
  // Promise.all ≈ Java 的 CompletableFuture.allOf：并发处理所有段，全部完成后再继续（节省串行等待时间）
  const segments = await Promise.all(
    pipeSegments.map(segment => buildSegmentWithoutRedirections(segment)),
  )

  // Handle as segmented command
  return segmentedCommandPermissionResult(
    input,
    segments,
    bashToolHasPermissionFn,
    checkers,
  )
}
