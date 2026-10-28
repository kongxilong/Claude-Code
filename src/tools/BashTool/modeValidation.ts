/**
 * 【做什么】模式维度权限判定的对外主入口
 * 【为什么需要】权限系统是「多层级管道」：模式层 → 规则表层 → 安全检查层。
 *   本函数处在最前面，能放行的先放行，管不了的返回 passthrough 让后面的层继续处理
 * 【入参】input：Bash 工具的入参（含 command）；toolPermissionContext：含当前 mode
 * 【返回】allow（模式放行）/ passthrough（无模式级结论，交给主流程）
 * 【关键步骤】
 *   ① bypassPermissions / dontAsk 两种模式直接 passthrough —— 它们在主权限流程里另有专门处理，
 *      这里重复处理会和主流程冲突（这是踩过的坑：一处放行、另一处又弹窗，行为不一致）
 *   ② splitCommand_DEPRECATED 把整条命令拆成子命令（&&、;、| 等分隔）
 *   ③ 逐条过 validateCommandForMode，任一条得出非 passthrough 的结论就立即返回（短路）
 *   ④ 全部 passthrough → 整体 passthrough
 */
/**
 * 【一句话定位】按「当前权限模式（mode）」决定一批命令能否免询问直接放行；
 *   目前只实现了 acceptEdits（接受编辑）模式下的文件系统命令白名单。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx 的 hasPermission 权限链（先问模式，再问规则表）
 *   下游：utils/bash/commands.js 的 splitCommand_DEPRECATED（拆分子命令）、
 *        utils/permissions/PermissionResult.js（统一的权限结论类型）
 *   调用链：BashTool.hasPermission -> checkPermissionMode -> validateCommandForMode -> 返回 allow/passthrough
 *
 * 【本文件包含什么】
 *   - ACCEPT_EDITS_ALLOWED_COMMANDS：acceptEdits 模式下自动放行的命令白名单（常量表）
 *   - FilesystemCommand：由上面常量表反推出来的字面量联合类型
 *   - isFilesystemCommand()：类型谓词，判断某个字符串是否属于白名单类型
 *   - validateCommandForMode()：对单条子命令做模式判定（内部函数）
 *   - checkPermissionMode()：对外主入口，把整条命令拆成子命令后逐条过一遍
 *   - getAutoAllowedCommands()：给 UI/提示词用，返回当前模式下会被自动放行的命令清单
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `as const`：把数组/对象字面量「焊死」为只读元组 + 字面量类型，
 *     ≈ Java 的 final + 枚举化；没有它 ['mkdir',...] 只会被推断成 string[]
 *   - `(typeof X)[number]`：索引访问类型 ≈ 从数组类型反推出元素类型，
 *     配合 as const 得到 'mkdir' | 'touch' | ... 这样的联合类型
 *   - `A | B` 联合类型 ≈ Java 的 sealed interface / 多态，取值只能是列出的几种
 *   - `command is FilesystemCommand` 类型谓词 ≈ Java 的 instanceof 模式匹配：
 *     if 之后编译器自动把变量收窄成更具体的类型
 *   - `const [baseCmd] = arr.split(...)` 数组解构 ≈ 取第 0 个元素，比 arr[0] 更直观
 *   - `readonly string[]` ≈ Java 的不可变 List（编译期禁止 push/splice）
 *   - `z.infer<typeof X>`：从 zod schema 反推出输入类型（typeof 在这里取的是「值的类型」）
 *   - 类型标注在变量名**后面**，Java 在前面，最容易看串
 */
/**
 * 【做什么】模式维度权限判定的对外主入口
 * 【为什么需要】权限系统是「多层级管道」：模式层 → 规则表层 → 安全检查层。
 *   本函数处在最前面，能放行的先放行，管不了的返回 passthrough 让后面的层继续处理
 * 【入参】input：Bash 工具的入参（含 command）；toolPermissionContext：含当前 mode
 * 【返回】allow（模式放行）/ passthrough（无模式级结论，交给主流程）
 * 【关键步骤】
 *   ① bypassPermissions / dontAsk 两种模式直接 passthrough —— 它们在主权限流程里另有专门处理，
 *      这里重复处理会和主流程冲突（这是踩过的坑：一处放行、另一处又弹窗，行为不一致）
 *   ② splitCommand_DEPRECATED 把整条命令拆成子命令（&&、;、| 等分隔）
 *   ③ 逐条过 validateCommandForMode，任一条得出非 passthrough 的结论就立即返回（短路）
 *   ④ 全部 passthrough → 整体 passthrough
 */
import type { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import type { BashTool } from './BashTool.js'

// 白名单设计意图：acceptEdits 模式的语义是「用户已同意让模型改我的文件」，
// 那么 mkdir/touch/mv/cp/sed 这类「编辑动作的自然延伸」就不该再弹一次确认框，否则体验极差。
// 反过来：这份名单刻意**不含** git、curl、npm、sudo 等——它们不属于「编辑文件」，越权风险高
// 白名单设计意图：acceptEdits 模式的语义是「用户已同意让模型改我的文件」，
// 那么 mkdir/touch/mv/cp/sed 这类「编辑动作的自然延伸」就不该再弹一次确认框，否则体验极差。
// 反过来：这份名单刻意**不含** git、curl、npm、sudo 等——它们不属于「编辑文件」，越权风险高
const ACCEPT_EDITS_ALLOWED_COMMANDS = [
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
] as const
// `as const` 的两层效果：① 数组变只读元组；② 元素类型由 string 收窄成各自的字面量 ('mkdir' 等)
// 少了它，下面 (typeof ...)[number] 就只能得到 string，类型保护也就失效了
// `as const` 的两层效果：① 数组变只读元组；② 元素类型由 string 收窄成各自的字面量 ('mkdir' 等)
// 少了它，下面 (typeof ...)[number] 就只能得到 string，类型保护也就失效了

// 从常量表反推类型：以后往数组里加一个命令，这个联合类型自动跟着变，不用两处维护（单一数据源）
// TS 速查：`typeof 变量` 取「变量的类型」；`[number]` 取「用数字下标访问得到的类型」= 元素类型
// 从常量表反推类型：以后往数组里加一个命令，这个联合类型自动跟着变，不用两处维护（单一数据源）
// TS 速查：`typeof 变量` 取「变量的类型」；`[number]` 取「用数字下标访问得到的类型」= 元素类型
type FilesystemCommand = (typeof ACCEPT_EDITS_ALLOWED_COMMANDS)[number]

/**
 * 【做什么】判断命令名是否在白名单里
 * 【为什么需要】把「运行时判断」和「编译期类型收窄」绑在一起：
 *   调用处 if (isFilesystemCommand(x)) 之后，x 的类型就从 string 变成 FilesystemCommand
 * 【入参】command：命令名（如 'mkdir'）
 * 【返回】boolean，但返回值类型是 `command is FilesystemCommand`（类型谓词，不是普通 boolean）
 * 【关键步骤】
 *   ① includes() 对只读数组做包含判断（≈ Java List.contains）
 *   ② `command as FilesystemCommand` 先强制转换，让 includes 的参数类型对得上——
 *      这是纯编译期的「骗过类型检查」，运行时不做任何校验，安全性靠上一行的 includes 兜住
 */
/**
 * 【做什么】判断命令名是否在白名单里
 * 【为什么需要】把「运行时判断」和「编译期类型收窄」绑在一起：
 *   调用处 if (isFilesystemCommand(x)) 之后，x 的类型就从 string 变成 FilesystemCommand
 * 【入参】command：命令名（如 'mkdir'）
 * 【返回】boolean，但返回值类型是 `command is FilesystemCommand`（类型谓词，不是普通 boolean）
 * 【关键步骤】
 *   ① includes() 对只读数组做包含判断（≈ Java List.contains）
 *   ② `command as FilesystemCommand` 先强制转换，让 includes 的参数类型对得上——
 *      这是纯编译期的「骗过类型检查」，运行时不做任何校验，安全性靠上一行的 includes 兜住
 */
function isFilesystemCommand(command: string): command is FilesystemCommand {
  return ACCEPT_EDITS_ALLOWED_COMMANDS.includes(command as FilesystemCommand)
}

/**
 * 【做什么】对**单条**子命令做「模式维度」的判定
 * 【为什么需要】模式判断必须发生在拆分之后：一条命令 `ls && rm x` 里 ls 该放行、rm 要看模式，
 *   整条一起判就会把二者混为一谈
 * 【入参】cmd：单条子命令；toolPermissionContext：含当前 mode 的上下文
 * 【返回】PermissionResult：allow=模式直接放行 / passthrough=本模块管不了，交给后续规则链
 * 【关键步骤】
 *   ① trim + split(/\s+/) 取第一个词作为命令名（baseCmd）
 *   ② baseCmd 为空 → passthrough（解析不出命令就别硬判，交给下游）
 *   ③ 仅当 mode 是 acceptEdits 且 baseCmd 在白名单里 → allow，并带上 decisionReason 说明放行依据
 *   ④ 其余一律 passthrough：宁可交给后面的规则表，也不在这里误放行
 */
/**
 * 【做什么】对**单条**子命令做「模式维度」的判定
 * 【为什么需要】模式判断必须发生在拆分之后：一条命令 `ls && rm x` 里 ls 该放行、rm 要看模式，
 *   整条一起判就会把二者混为一谈
 * 【入参】cmd：单条子命令；toolPermissionContext：含当前 mode 的上下文
 * 【返回】PermissionResult：allow=模式直接放行 / passthrough=本模块管不了，交给后续规则链
 * 【关键步骤】
 *   ① trim + split(/\s+/) 取第一个词作为命令名（baseCmd）
 *   ② baseCmd 为空 → passthrough（解析不出命令就别硬判，交给下游）
 *   ③ 仅当 mode 是 acceptEdits 且 baseCmd 在白名单里 → allow，并带上 decisionReason 说明放行依据
 *   ④ 其余一律 passthrough：宁可交给后面的规则表，也不在这里误放行
 */
function validateCommandForMode(
  cmd: string,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const trimmedCmd = cmd.trim()
  // 数组解构取第 0 个元素；split(/\s+/) 按任意长度空白切分（比按单个空格切更稳，能处理多空格/tab）
  // 数组解构取第 0 个元素；split(/\s+/) 按任意长度空白切分（比按单个空格切更稳，能处理多空格/tab）
  const [baseCmd] = trimmedCmd.split(/\s+/)

  // 空串是假值：!baseCmd 同时覆盖 undefined 与 ''（TS 里 '', 0, false, null, undefined 都是假值）
  // 空串是假值：!baseCmd 同时覆盖 undefined 与 ''（TS 里 '', 0, false, null, undefined 都是假值）
  if (!baseCmd) {
    return {
      behavior: 'passthrough',
      message: 'Base command not found',
    }
  }

  // In Accept Edits mode, auto-allow filesystem operations
  // 中文补充：只有「当前是 acceptEdits 模式」且「命令在白名单里」两个条件同时满足才放行
  // decisionReason 会被 UI 拿去解释「为什么这次没问你」，所以必须如实写 mode 来源
  // 中文补充：只有「当前是 acceptEdits 模式」且「命令在白名单里」两个条件同时满足才放行
  // decisionReason 会被 UI 拿去解释「为什么这次没问你」，所以必须如实写 mode 来源
  if (
    toolPermissionContext.mode === 'acceptEdits' &&
    isFilesystemCommand(baseCmd)
  ) {
    return {
      behavior: 'allow',
      updatedInput: { command: cmd },
      decisionReason: {
        type: 'mode',
        mode: 'acceptEdits',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: `No mode-specific handling for '${baseCmd}' in ${toolPermissionContext.mode} mode`,
  }
}

/**
 * Checks if commands should be handled differently based on the current permission mode
 *
 * This is the main entry point for mode-based permission logic.
 * Currently handles Accept Edits mode for filesystem commands,
 * but designed to be extended for other modes.
 *
 * @param input - The bash command input
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'allow' if the current mode permits auto-approval
 * - 'ask' if the command needs approval in current mode
 * - 'passthrough' if no mode-specific handling applies
 */
export function checkPermissionMode(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  // Skip if in bypass mode (handled elsewhere)
  if (toolPermissionContext.mode === 'bypassPermissions') {
    return {
      behavior: 'passthrough',
      message: 'Bypass mode is handled in main permission flow',
    }
  }

  // Skip if in dontAsk mode (handled in main permission flow)
  if (toolPermissionContext.mode === 'dontAsk') {
    return {
      behavior: 'passthrough',
      message: 'DontAsk mode is handled in main permission flow',
    }
  }

  // 拆分是这一步的核心：一条命令里只要有一个子命令需要询问，整条命令就不该被静默放行
  // 拆分是这一步的核心：一条命令里只要有一个子命令需要询问，整条命令就不该被静默放行
  const commands = splitCommand_DEPRECATED(input.command)

  // Check each subcommand
  for (const cmd of commands) {
    const result = validateCommandForMode(cmd, toolPermissionContext)

    // If any command triggers mode-specific behavior, return that result
    if (result.behavior !== 'passthrough') {
      return result
    }
  }

  // No mode-specific handling needed
  return {
    behavior: 'passthrough',
    message: 'No mode-specific validation required',
  }
}

/**
 * 【做什么】返回当前模式下「会被自动放行」的命令清单
 * 【为什么需要】提示词和权限弹窗要如实告诉用户「哪些命令不会再问你」，避免黑盒感
 * 【入参】mode：当前权限模式
 * 【返回】命令名数组；非 acceptEdits 模式返回空数组（一个都不自动放行）
 */
/**
 * 【做什么】返回当前模式下「会被自动放行」的命令清单
 * 【为什么需要】提示词和权限弹窗要如实告诉用户「哪些命令不会再问你」，避免黑盒感
 * 【入参】mode：当前权限模式
 * 【返回】命令名数组；非 acceptEdits 模式返回空数组（一个都不自动放行）
 */
export function getAutoAllowedCommands(
  mode: ToolPermissionContext['mode'],
): readonly string[] {
  return mode === 'acceptEdits' ? ACCEPT_EDITS_ALLOWED_COMMANDS : []
}
