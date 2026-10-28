/**
 * 【一句话定位】决定一条 bash 命令是否要放进沙箱（sandbox）里执行，
 *   并支持「用户配置的排除名单」让某些命令跳出沙箱。
 *
 * 【在架构中的位置】
 *   上游：BashTool.tsx（执行前决定要不要套沙箱）
 *   下游：utils/sandbox/sandbox-adapter.js（SandboxManager，真正的沙箱开关）、
 *        utils/settings/settings.js（读用户配置）、
 *        bashPermissions.js（复用规则解析与匹配：bashPermissionRule / matchWildcardPattern /
 *        stripAllLeadingEnvVars / stripSafeWrappers / BINARY_HIJACK_VARS）、
 *        utils/bash/commands.js（拆分复合命令）
 *   调用链：BashTool.call -> shouldUseSandbox(input) -> containsExcludedCommand(command) -> 规则匹配
 *
 * 【本文件包含什么】
 *   - SandboxInput：入参形状（command + dangerouslyDisableSandbox 开关）
 *   - containsExcludedCommand()：判断命令是否命中「排除名单」（内部函数）
 *   - shouldUseSandbox()：对外主入口
 *
 * 【规则分类逻辑】
 *   ① 沙箱总开关没开 → 不用沙箱
 *   ② 调用方显式要求关沙箱 **且** 策略允许无沙箱命令 → 不用沙箱（两个条件缺一不可，防止绕过策略）
 *   ③ 命令为空 → 不用沙箱
 *   ④ 命令命中排除名单 → 不用沙箱（这是为了方便，不是安全边界，见文件内注释）
 *   ⑤ 其余 → 用沙箱
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `Partial<T>`：工具类型，把 T 的所有字段变成可选 ≈ 「这个对象可以只填一部分字段」
 *   - `?? []`：空值合并，左侧为 null/undefined 时给默认值（与 || 区别：空数组 [] 是假值但不会被 ?? 替换）
 *   - `try { } catch { }`：省略 catch 参数的写法（ES2019+），≈ Java 的 catch (Exception e) 但不使用 e
 *   - `cmd!` 非空断言 ≈ 强制类型转换，骗编译器「我保证不是 undefined」，运行时不检查
 *   - `Set<T>` ≈ Java HashSet，这里用于去重防止死循环
 *   - `switch (rule.type)` + 每个 case 里自动收窄到具体分支类型（可辨识联合，≈ sealed interface + 模式匹配）
 *   - 泛型函数调用 `getFeatureValue_CACHED_MAY_BE_STALE<{...}>(...)` ≈ Java 的 `obj.<T>method()`
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'

// 为什么字段都带 ?：本函数会被多处调用，有的调用点只关心命令、有的只关心开关，
//   用可选字段（≈ Java 里允许 null 的字段）比强制传值更好用
type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

// NOTE: excludedCommands is a user-facing convenience feature, not a security boundary.
// 中文补充（很重要，容易误解）：excludedCommands **不是安全边界**。
//   用户能绕过它不算 bug——真正的安全控制是「沙箱权限系统会弹窗询问用户」。
//   排除名单只是「少弹几次窗、让常用命令跑得顺」的便利性配置
// It is not a security bug to be able to bypass excludedCommands — the sandbox permission
// system (which prompts users) is the actual security control.
/**
 * 【做什么】判断命令是否命中「排除名单」（命中则不放进沙箱）
 * 【为什么需要】某些命令（如 docker、bazel）在沙箱里跑不起来，用户希望能把它们排除掉
 * 【入参】command：待执行的命令
 * 【返回】true = 命中排除名单（不用沙箱）
 * 【关键步骤】
 *   ① 内部动态配置（仅 ant 环境）：先查「禁用子串」再查「禁用命令名」，命中即 true
 *   ② 读用户配置里的 sandbox.excludedCommands；为空直接 false（快路径）
 *   ③ 把复合命令拆成子命令，**逐个**检查——否则 `docker ps && curl evil.com`
 *      会因为首段命中排除名单而整条跳出沙箱（这是踩过的坑）
 *   ④ 每个子命令再生成若干「候选写法」（剥环境变量前缀 / 剥安全包装命令），逐个匹配规则
 *   ⑤ 按规则类型（prefix / exact / wildcard）分别匹配
 */
function containsExcludedCommand(command: string): boolean {
  // Check dynamic config for disabled commands and substrings (only for ants)
  // 只对内部（ant）环境生效的动态开关：线上可以紧急禁掉某些命令的沙箱外执行
  if (process.env.USER_TYPE === 'ant') {
    const disabledCommands = getFeatureValue_CACHED_MAY_BE_STALE<{
      commands: string[]
      substrings: string[]
    }>('tengu_sandbox_disabled_commands', { commands: [], substrings: [] })

    // Check if command contains any disabled substrings
    for (const substring of disabledCommands.substrings) {
      if (command.includes(substring)) {
        return true
      }
    }

    // Check if command starts with any disabled commands
    try {
      const commandParts = splitCommand_DEPRECATED(command)
      for (const part of commandParts) {
        const baseCommand = part.trim().split(' ')[0]
        if (baseCommand && disabledCommands.commands.includes(baseCommand)) {
          return true
        }
      }
    } catch {
      // If we can't parse the command (e.g., malformed bash syntax),
      // treat it as not excluded to allow other validation checks to handle it
      // This prevents crashes when rendering tool use messages
    }
  }

  // Check user-configured excluded commands from settings
  const settings = getSettings_DEPRECATED()
  // `settings.sandbox?.` 的可选链不能省：老配置里可能压根没有 sandbox 字段；
  //   `?? []` 再兜一层空数组，后面就能放心 .length
  const userExcludedCommands = settings.sandbox?.excludedCommands ?? []

  if (userExcludedCommands.length === 0) {
    return false
  }

  // Split compound commands (e.g. "docker ps && curl evil.com") into individual
  // subcommands and check each one against excluded patterns. This prevents a
  // compound command from escaping the sandbox just because its first subcommand
  // matches an excluded pattern.
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    subcommands = [command]
  }

  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    // Also try matching with env var prefixes and wrapper commands stripped, so
    // that `FOO=bar bazel ...` and `timeout 30 bazel ...` match `bazel:*`. Not a
    // security boundary (see NOTE at top); the &&-split above already lets
    // `export FOO=bar && bazel ...` match. BINARY_HIJACK_VARS kept as a heuristic.
    //
    // We iteratively apply both stripping operations until no new candidates are
    // produced (fixed-point), matching the approach in filterRulesByContentsMatchingInput.
    // This handles interleaved patterns like `timeout 300 FOO=bar bazel run`
    // where single-pass composition would fail.
    // 为什么要生成多个候选：`FOO=bar bazel ...` 和 `timeout 30 bazel ...` 实际执行的都是 bazel，
    //   若只拿原文去匹配 `bazel:*` 规则就会漏掉。候选 = 原文 + 剥掉环境变量前缀 + 剥掉安全包装命令
    const candidates = [trimmed]
    const seen = new Set(candidates)
    // 不动点（fixed-point）迭代：反复剥离直到不再产生新候选。
    //   为什么不能用「剥一次」：遇到 `timeout 300 FOO=bar bazel run` 这种交错写法，
    //   单趟组合剥不干净，必须循环到收敛（同时用 Set 去重防止无限循环）
    let startIdx = 0
    while (startIdx < candidates.length) {
      const endIdx = candidates.length
      for (let i = startIdx; i < endIdx; i++) {
        // `!` 非空断言：告诉编译器「这个下标一定存在」。运行时不检查，靠上面的循环边界保证安全
        const cmd = candidates[i]!
        const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
        if (!seen.has(envStripped)) {
          candidates.push(envStripped)
          seen.add(envStripped)
        }
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          candidates.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }

    // pattern 是用户写的规则字符串（如 'bazel:*'），先解析成结构化规则再匹配
    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      // 同一个子命令的多种写法，任一命中就算命中（放宽匹配，因为这里不是安全边界）
      for (const cand of candidates) {
        switch (rule.type) {
          case 'prefix':
            if (cand === rule.prefix || cand.startsWith(rule.prefix + ' ')) {
              return true
            }
            break
          case 'exact':
            if (cand === rule.command) {
              return true
            }
            break
          case 'wildcard':
            if (matchWildcardPattern(rule.pattern, cand)) {
              return true
            }
            break
        }
      }
    }
  }

  return false
}

/**
 * 【做什么】最终决定这条命令要不要进沙箱
 * 【为什么需要】沙箱有性能与兼容性代价，不能无脑全开；同时又不能随便关，必须受策略约束
 * 【入参】input：{ command?, dangerouslyDisableSandbox? }
 * 【返回】true = 进沙箱执行
 * 【关键步骤】
 *   ① 沙箱能力不可用 → false（没得选）
 *   ② 显式关闭 **且** 策略允许无沙箱命令 → false（两个条件都要满足，防止单方面绕过策略）
 *   ③ 无命令 → false
 *   ④ 命中排除名单 → false
 *   ⑤ 其余 true —— 默认进沙箱，这是「默认安全」的取向
 */
export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  // 总开关：环境不支持/未启用沙箱时，直接返回 false，后面的判断都不用走
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  // Don't sandbox if explicitly overridden AND unsandboxed commands are allowed by policy
  if (
    // 注意是「与」关系：调用方想关还不够，必须策略层面也允许 unsandboxed 命令
    //   ——这是刻意设计的双保险，避免某个调用点单独就把沙箱关掉
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  if (!input.command) {
    return false
  }

  // Don't sandbox if the command contains user-configured excluded commands
  // 到这里 input.command 一定非空（上面已经 return 过），所以可以直接用
  if (containsExcludedCommand(input.command)) {
    return false
  }

  return true
}
