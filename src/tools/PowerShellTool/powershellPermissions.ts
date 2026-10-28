/**
 * 【一句话定位】PowerShell 工具的**权限判定主流程**：把一条命令过一遍完整的
 * 决策链（规则匹配 → 安全扫描 → 路径约束 → 模式放行 → 逐子命令审批），
 * 最终给出 allow / deny / ask / passthrough 四种结论之一。
 *
 * 【在架构中的位置】（本目录的"总调度"）
 *   PowerShellTool.tsx 的 checkPermissions()
 *        ──调用──> powershellToolHasPermission(input, context)  ←── 本文件主入口
 *   本文件按步骤**依次调用**同目录下的各个兄弟模块：
 *     ① 规则匹配（本文件自己实现的 filterRulesByContentsMatchingInput）
 *     ② powershellSecurity.ts      powershellCommandIsSafe()  危险特征扫描
 *     ③ pathValidation.ts          checkPathConstraints()      路径约束
 *     ④ readOnlyValidation.ts      isReadOnlyCommand()         只读白名单
 *     ⑤ modeValidation.ts          checkPermissionMode()       acceptEdits 模式放行
 *     ⑥ gitSafety.ts               isGitInternalPathPS()        git 内部路径
 *   本文件 ──> utils/powershell/parser.js（parsePowerShellCommand 解析 AST、
 *                 classifyCommandName、stripModulePrefix、getFileRedirections…）
 *             ──> utils/permissions/*（规则存储、通配符匹配、建议生成）
 *
 *   对照 BashTool：src/tools/BashTool/bashPermissions.ts 是**逐步骤同构**的 Unix 版。
 *   本文件几乎每段注释都写着 "was step N (:NNN-NNN)" 或 "BashTool parity"，
 *   那就是与 Bash 版的对照点，读 bashPermissions.ts 可以直接平移理解。
 *   差异集中在两点：
 *     ① PowerShell 大小写不敏感 + 有别名 + 有模块限定名，
 *        所以规则匹配要做规范化（canonicalCommand）后才比较；
 *     ② 本文件把多步骤改成了 **collect-then-reduce** 结构（见 876 行），
 *        比 Bash 版"谁先返回谁说了算"的写法更安全（见那里的详细注释）。
 *
 * 【最关键的设计：collect-then-reduce（先收集再归约）】
 *   早期写法是"每一步检查完立即 return"。问题是：
 *   第 3 步返回 ask 就直接结束了，第 4 步里那条 deny 规则**永远没机会执行** ——
 *   于是用户能看到一个弹框，点一下就把"包含禁止路径"的命令批准了。
 *   现在改成：所有检查把结论 push 进 decisions[] 数组，
 *   最后由一个 reduce 按 **deny > ask > allow > passthrough** 的优先级挑一个。
 *   这样"前面的 ask 遮住后面的 deny"这类 bug 在结构上就不可能再写出来了。
 *
 * 【四种结论的含义】
 *   deny        = 被规则或系统硬规则拒绝（用户**不能**批准）
 *   ask         = 弹框让用户批准
 *   allow       = 直接放行
 *   passthrough = 本层没意见，交回上层（多数情况等价于弹框）
 *
 * 【本文件包含什么】
 *   GIT_SAFETY_WRITE_CMDLETS / GIT_SAFETY_ARCHIVE_EXTRACTORS：git 相关危险命令表
 *   extractCommandName()               ：从命令文本里取第一个命令名
 *   powershellPermissionRule()         ：把规则字符串解析成结构化规则
 *   suggestionForExactCommand()        ：生成"一键放行这条命令"的建议
 *   filterRulesByContentsMatchingInput()：**规则匹配核心**（大小写不敏感 + 别名规范化）
 *   matchingRulesForInput()            ：分别取 deny/ask/allow 三类命中规则
 *   powershellToolCheckExactMatchPermission()：精确匹配判定
 *   powershellToolCheckPermission()    ：精确 + 前缀匹配判定
 *   getSubCommandsForPermissionCheck()：把复合命令拆成需要逐个审批的子命令
 *   powershellToolHasPermission()      ：**对外主入口**
 *
 * 【TS 语法速查】
 *   matchMode: 'exact' | 'prefix'
 *     字面量联合类型 ≈ Java enum；好处是传错字符串编译期就报错。
 *   Map<string, PermissionRule> / new Map() / .entries() / Array.from(...)
 *     ≈ Java 的 HashMap<String, PermissionRule> + entrySet()：
 *       Array.from(map.entries()) ≈ new ArrayList<>(map.entrySet())
 *   .filter(fn).map(fn) 链式调用
 *     ≈ Java: list.stream().filter(...).map(...).collect(toList())
 *     some ≈ anyMatch，every ≈ allMatch，find ≈ filter().findFirst()
 *   providerScan: for (...) { ... break providerScan }
 *     **带标签的 break**（这个 TS 和 Java 都有，写法几乎一样）：
 *     从内层循环里直接跳出到外层循环。用来表达"找到第一个就停"。
 *   const { a, b } = obj  /  const { matchingDenyRules: subDenyRules } = ...
 *     解构赋值，冒号表示**改名**（取 matchingDenyRules 属性存进 subDenyRules）。
 *   `decisions.find(d => d.behavior === 'deny')`
 *     find ≈ Java 的 stream().filter().findFirst().orElse(null)，
 *     找不到返回 undefined（Java 返回 Optional.empty()）。
 *   `type: 'other' as const`
 *     as const 把类型锁成字面量 'other'，而不是宽泛的 string ——
 *     否则后面按 decisionReason.type 做收窄判断时推不出具体形态。
 *   let m: RegExpMatchArray | null ; while ((m = x.match(re))) { ... }
 *     赋值表达式本身有返回值（≈ Java 的 (m = x.match(re)) != null），
 *     这是 C/Java 里也有的写法，只是 TS 里 null 与 undefined 要分开注意。
 */
/**
 * PowerShell-specific permission checking, adapted from bashPermissions.ts
 * for case-insensitive cmdlet matching.
 */

import { resolve } from 'path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from '../../types/permissions.js'
import { getCwd } from '../../utils/cwd.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import type { PermissionRule } from '../../utils/permissions/PermissionRule.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForToolName,
} from '../../utils/permissions/permissions.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
  type ShellPermissionRule,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
} from '../../utils/permissions/shellRuleMatching.js'
import {
  classifyCommandName,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  type ParsedCommandElement,
  type ParsedPowerShellCommand,
  PS_TOKENIZER_DASH_CHARS,
  parsePowerShellCommand,
  stripModulePrefix,
} from '../../utils/powershell/parser.js'
import { containsVulnerableUncPath } from '../../utils/shell/readOnlyCommandValidation.js'
import { isDotGitPathPS, isGitInternalPathPS } from './gitSafety.js'
import {
  checkPermissionMode,
  isSymlinkCreatingCommand,
} from './modeValidation.js'
import {
  checkPathConstraints,
  dangerousRemovalDeny,
  isDangerousRemovalRawPath,
} from './pathValidation.js'
import { powershellCommandIsSafe } from './powershellSecurity.js'
import {
  argLeaksValue,
  isAllowlistedCommand,
  isCwdChangingCmdlet,
  isProvablySafeStatement,
  isReadOnlyCommand,
  isSafeOutputCommand,
  resolveToCanonical,
} from './readOnlyValidation.js'
import { POWERSHELL_TOOL_NAME } from './toolName.js'

// 匹配 `$var = ` 这类赋值前缀。用在「解析失败」的兜底路径里，
// 把嵌套赋值一层层剥掉（$x = $y = iex → iex）才能正确匹配规则。
// Matches `$var = `, `$var += `, `$env:X = `, `$x ??= ` etc. Used to strip
// nested assignment prefixes in the parse-failed fallback path.
const PS_ASSIGN_PREFIX_RE = /^\$[\w:]+\s*(?:[+\-*/%]|\?\?)?\s*=\s*/

/**
 * 【中文】能把文件放到「调用者指定路径」上的 cmdlet 名单。
 * git 内部路径防护要检查它们的参数里有没有 hooks/、refs/、objects/、HEAD。
 * 纯删除类（remove-item、clear-content）**刻意不在**名单里 ——
 * 它们没法「植入」新的 hook 文件。
 */
/**
 * Cmdlets that can place a file at a caller-specified path. The
 * git-internal-paths guard checks whether any arg is a git-internal path
 * (hooks/, refs/, objects/, HEAD). Non-creating writers (remove-item,
 * clear-content) are intentionally absent — they can't plant new hooks.
 */
const GIT_SAFETY_WRITE_CMDLETS = new Set([
  'new-item',
  'set-content',
  'add-content',
  'out-file',
  'copy-item',
  'move-item',
  'rename-item',
  'expand-archive',
  'invoke-webrequest',
  'invoke-restmethod',
  'tee-object',
  'export-csv',
  'export-clixml',
])

/**
 * 【中文】会按「压缩包内容决定路径」解压文件的外部程序名单（tar/unzip/7z…）。
 *
 * 为什么一律要 ask（对应上方英文注释）：
 *   `tar -xf payload.tar; git status` 是一个**TOCTOU** 攻击：
 *   裸仓库检查在权限判定时跑，而 tar 在检查之后、git 运行之前才把
 *   HEAD / hooks / refs 解压出来 —— 于是 git 就把当前目录当裸仓库，
 *   执行攻击者刚放进去的 hook。
 *   与上面的写类 cmdlet 不同：压缩包**内容是不透明的**，我们看不到里面有哪些路径，
 *   所以只能「只要解压 + git 同时出现就 ask」。
 */
/**
 * External archive-extraction applications that write files to cwd with
 * archive-controlled paths. `tar -xf payload.tar; git status` defeats
 * isCurrentDirectoryBareGitRepo (TOCTOU): the check runs at
 * permission-eval time, tar extracts HEAD/hooks/refs/ AFTER the check and
 * BEFORE git runs. Unlike GIT_SAFETY_WRITE_CMDLETS (where we can inspect
 * args for git-internal paths), archive contents are opaque — any
 * extraction preceding git must ask. Matched by name only (lowercase,
 * with and without .exe).
 */
const GIT_SAFETY_ARCHIVE_EXTRACTORS = new Set([
  'tar',
  'tar.exe',
  'bsdtar',
  'bsdtar.exe',
  'unzip',
  'unzip.exe',
  '7z',
  '7z.exe',
  '7za',
  '7za.exe',
  'gzip',
  'gzip.exe',
  'gunzip',
  'gunzip.exe',
  'expand-archive',
])

/**
 * 【中文】从命令文本里取出**第一个**命令名（走解析器而不是简单 split）。
 * @returns 命令名；空命令或解析不出就返回空串
 */
/**
 * Extract the command name from a PowerShell command string.
 * Uses the parser to get the first command name from the AST.
 */
async function extractCommandName(command: string): Promise<string> {
  const trimmed = command.trim()
  if (!trimmed) {
    return ''
  }
  const parsed = await parsePowerShellCommand(trimmed)
  const names = getAllCommandNames(parsed)
  return names[0] ?? ''
}

/**
 * 【中文】把一条权限规则字符串（如 'Remove-Item:*'）解析成结构化规则对象。
 * 真正的解析逻辑复用共享模块（BashTool 用的是同一份）。
 */
/**
 * Parse a permission rule string into a structured rule object.
 * Delegates to shared parsePermissionRule.
 */
export function powershellPermissionRule(
  permissionRule: string,
): ShellPermissionRule {
  return parsePermissionRule(permissionRule)
}

/**
 * 【中文】生成「以后都放行这条命令」的一键建议。
 *
 * 两种命令**不给**这个建议（对应上方英文注释）：
 *   ① 多行命令：换行在归一化后会丢失，生成的规则永远匹配不上；
 *   ② 含字面 * 的命令：存成 `Remove-Item * -Force` 会被重新解析成通配符规则
 *      （等价于 `Remove-Item .* -Force`，过于宽泛）；转义成 \* 又会变成死规则。
 *      通配符本身就不适合做精确放行 —— 前缀建议仍然会给。
 */
/**
 * Generate permission update suggestion for exact command match.
 *
 * Skip exact-command suggestion for commands that can't round-trip cleanly:
 * - Multi-line: newlines don't survive normalization, rule would never match
 * - Literal *: storing `Remove-Item * -Force` verbatim re-parses as a wildcard
 *   rule via hasWildcards() (matches `^Remove-Item .* -Force$`). Escaping to
 *   `\*` creates a dead rule — parsePermissionRule's exact branch returns the
 *   raw string with backslash intact, so `Remove-Item \* -Force` never matches
 *   the incoming `Remove-Item * -Force`. Globs are unsafe to exact-auto-allow
 *   anyway; prefix suggestion still offered. (finding #12)
 */
function suggestionForExactCommand(command: string): PermissionUpdate[] {
  if (command.includes('\n') || command.includes('*')) {
    return []
  }
  return sharedSuggestionForExactCommand(POWERSHELL_TOOL_NAME, command)
}

// 本模块内部使用的输入类型（只关心 command，timeout 可选）。
// 用**结构类型**而不是直接依赖工具的 zod schema，可以让本模块独立测试。
/**
 * PowerShell input schema type - simplified for initial implementation
 */
type PowerShellInput = {
  command: string
  timeout?: number
}

/**
 * 【中文】**规则匹配核心**：筛出与这条命令匹配的规则。
 *
 * 与 Bash 版的差别：PowerShell 大小写不敏感，而且有**别名**，
 * 所以要做三重匹配：
 *   ① 拿原始命令匹配（'rm foo' vs 规则 'rm foo'）
 *   ② 拿「规范化后的命令」匹配（'remove-item foo' vs 规则 'Remove-Item:*'）
 *      —— 这样「禁止 Remove-Item」也能挡住 rm / del / ri
 *   ③ 再把**规则**那边的命令名也规范化后比较
 *      —— 这样「禁止 rm」也能挡住 Remove-Item
 *
 * @param matchMode 'exact' = 精确匹配；'prefix' = 前缀/通配符匹配
 * @param behavior 当前筛的是 deny / ask / allow 哪一类规则
 *        （**会**影响匹配策略，见 stripModulePrefixForRule）
 */
/**
 * Filter rules by contents matching an input command.
 * PowerShell-specific: uses case-insensitive matching throughout.
 * Follows the same structure as BashTool's local filterRulesByContentsMatchingInput.
 */
function filterRulesByContentsMatchingInput(
  input: PowerShellInput,
  rules: Map<string, PermissionRule>,
  matchMode: 'exact' | 'prefix',
  behavior: 'deny' | 'ask' | 'allow',
): PermissionRule[] {
  const command = input.command.trim()

// 两个大小写不敏感的比较工具函数（PowerShell 的 cmdlet 名大小写不敏感）。
  function strEquals(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase()
  }
  function strStartsWith(str: string, prefix: string): boolean {
    return str.toLowerCase().startsWith(prefix.toLowerCase())
  }
// ===== 安全要点：allow 规则绝不能「多匹配」，deny/ask 可以多匹配 =====（对应上方英文注释）
//   deny 规则写成 `Module\Remove-Item:*` 能顺带挡住 rm —— 这是**好**的（过度匹配 = 更安全）
//   allow 规则写成 `ModuleA\Get-Thing:*` 若也匹配 ModuleB\Get-Thing —— 这是**危险**的
// 所以对 allow 规则**不做**模块前缀剥离，对 deny/ask 才做。
  // SECURITY: stripModulePrefix on RULE names widens the
  // secondary-canonical match — a deny rule `Module\Remove-Item:*` blocking
  // `rm` is the intent (fail-safe over-match), but an allow rule
  // `ModuleA\Get-Thing:*` also matching `ModuleB\Get-Thing` is fail-OPEN.
  // Deny/ask over-match is fine; allow must never over-match.
  function stripModulePrefixForRule(name: string): string {
    if (behavior === 'allow') {
      return name
    }
    return stripModulePrefix(name)
  }

// 同时保留「原始命令名」和「剥掉模块前缀的命令名」：
//   原始名用来从原命令里切出剩余部分（保证切片长度正确）；
//   剥前缀后的名字才能解析成规范名（Microsoft.PowerShell.Utility\Invoke-Expression → invoke-expression）。
  // Extract the first word (command name) from the input for canonical matching.
  // Keep both raw (for slicing the original `command` string) and stripped
  // (for canonical resolution) versions. For module-qualified inputs like
  // `Microsoft.PowerShell.Utility\Invoke-Expression foo`, rawCmdName holds the
  // full token so `command.slice(rawCmdName.length)` yields the correct rest.
  const rawCmdName = command.split(/\s+/)[0] ?? ''
  const inputCmdName = stripModulePrefix(rawCmdName)
  const inputCanonical = resolveToCanonical(inputCmdName)

// 把命令名换成规范名后重新拼一条「规范命令」，
// 例：'rm foo.txt' → 'remove-item foo.txt'，于是针对 Remove-Item 的 deny 规则也能命中 rm。
  // Build a version of the command with the canonical name substituted
  // e.g., 'rm foo.txt' -> 'remove-item foo.txt' so deny rules on Remove-Item also block rm.
// 关键细节：命令名与参数之间的空白要**统一成一个空格**。
// PowerShell 接受任意空白（比如制表符）做分隔符，但前缀规则用的是 `prefix + ' '`（字面空格）。
// 不归一化的话 `rm\t./x` 会变成 `remove-item\t./x`，匹配不上 `Remove-Item:*` 这条 deny 规则，
// 而 acceptEdits 的自动放行（用 AST 里的 cmd.name）却能匹配上 —— 这就是一个 deny 绕过。
  // SECURITY: Normalize the whitespace separator between name and args to a
  // single space. PowerShell accepts any whitespace (tab, etc.) as separator,
  // but prefix rule matching uses `prefix + ' '` (literal space). Without this,
  // `rm\t./x` canonicalizes to `remove-item\t./x` and misses the deny rule
  // `Remove-Item:*`, while acceptEdits auto-allow (using AST cmd.name) still
  // matches — a deny-rule bypass. Build unconditionally (not just when the
  // canonical differs) so non-space-separated raw commands are also normalized.
  const rest = command.slice(rawCmdName.length).replace(/^\s+/, ' ')
  const canonicalCommand = inputCanonical + rest

  return Array.from(rules.entries())
    .filter(([ruleContent]) => {
      const rule = powershellPermissionRule(ruleContent)

      // Also resolve the rule's command name to canonical for cross-matching
      // e.g., a deny rule for 'rm' should also block 'Remove-Item'
// 三种规则形态各自的匹配逻辑：exact（全等）/ prefix（前缀 + 空格边界）/ wildcard（通配符）。
      function matchesCommand(cmd: string): boolean {
        switch (rule.type) {
          case 'exact':
            return strEquals(rule.command, cmd)
          case 'prefix':
            switch (matchMode) {
              case 'exact':
                return strEquals(rule.prefix, cmd)
              case 'prefix': {
                if (strEquals(cmd, rule.prefix)) {
                  return true
                }
                return strStartsWith(cmd, rule.prefix + ' ')
              }
            }
            break
// 通配符规则在 exact 模式下直接不匹配（精确匹配不该被通配符规则命中）。
          case 'wildcard':
            if (matchMode === 'exact') {
              return false
            }
            return matchWildcardPattern(rule.pattern, cmd, true)
        }
      }

// 先用原始命令匹配一次。
      // Check against the original command
      if (matchesCommand(command)) {
        return true
      }

// 再用**规范命令**匹配（让 「禁止 Remove-Item」 也能挡住 rm / del / ri）。
      // Also check against the canonical form of the command
      // This ensures 'deny Remove-Item' also blocks 'rm', 'del', 'ri', etc.
      if (matchesCommand(canonicalCommand)) {
        return true
      }

// 最后把**规则**那边的命令名也规范化后比较（让 「禁止 rm」 也能挡住 Remove-Item）。
      // Also resolve the rule's command name to canonical and compare
      // This ensures 'deny rm' also blocks 'Remove-Item'
// 注意：stripModulePrefix 要同时作用在**规则**的命令名上，
// 否则 `Microsoft.PowerShell.Management\Remove-Item:*` 这条 deny 规则
// 会被 rm / del / 甚至裸的 Remove-Item 绕过（规范名解析认不出模块限定形式）。
      // SECURITY: stripModulePrefix applied to DENY/ASK rule command
      // names too, not just input. Otherwise a deny rule written as
      // `Microsoft.PowerShell.Management\Remove-Item:*` is bypassed by `rm`,
      // `del`, or plain `Remove-Item` — resolveToCanonical won't match the
      // module-qualified form against COMMON_ALIASES.
// exact 规则：比较「规则剩余部分」与「输入剩余部分」。
// 两边都要做同样的空白归一化（见上面 207 行的说明）。
      if (rule.type === 'exact') {
        const rawRuleCmdName = rule.command.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical) {
          // Rule and input resolve to same canonical cmdlet
          // SECURITY: use normalized `rest` not a raw re-slice
          // from `command`. The raw slice preserves tab separators so
          // `Remove-Item\t./secret.txt` vs deny rule `rm ./secret.txt` misses.
          // Normalize both sides identically.
          const ruleRest = rule.command
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const inputRest = rest
          if (strEquals(ruleRest, inputRest)) {
            return true
          }
        }
// prefix 规则：把规则的命令名换成规范名后重建前缀，再按前缀规则比较。
      } else if (rule.type === 'prefix') {
        const rawRuleCmdName = rule.prefix.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical) {
          const ruleRest = rule.prefix
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const canonicalPrefix = inputCanonical + ruleRest
          if (matchMode === 'exact') {
            if (strEquals(canonicalPrefix, canonicalCommand)) {
              return true
            }
          } else {
            if (
              strEquals(canonicalCommand, canonicalPrefix) ||
              strStartsWith(canonicalCommand, canonicalPrefix + ' ')
            ) {
              return true
            }
          }
        }
// wildcard 规则：同样替换成规范名后重新匹配。
      } else if (rule.type === 'wildcard') {
        // Resolve the wildcard pattern's command name to canonical and re-match
        // This ensures 'deny rm *' also blocks 'Remove-Item secret.txt'
        const rawRuleCmdName = rule.pattern.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical && matchMode !== 'exact') {
          // Rebuild the pattern with the canonical cmdlet name
          // Normalize separator same as exact and prefix branches.
          // Without this, a wildcard rule `rm\t*` produces canonicalPattern
          // with a literal tab that never matches the space-normalized
          // canonicalCommand.
          const ruleRest = rule.pattern
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const canonicalPattern = inputCanonical + ruleRest
          if (matchWildcardPattern(canonicalPattern, canonicalCommand, true)) {
            return true
          }
        }
      }

      return false
    })
    .map(([, rule]) => rule)
}

/**
 * 【中文】一次性取出 deny / ask / allow 三类规则里各自命中的部分。
 */
/**
 * Get matching rules for input across all rule types (deny, ask, allow)
 */
function matchingRulesForInput(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
  matchMode: 'exact' | 'prefix',
) {
  const denyRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'deny',
  )
  const matchingDenyRules = filterRulesByContentsMatchingInput(
    input,
    denyRuleByContents,
    matchMode,
    'deny',
  )

  const askRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'ask',
  )
  const matchingAskRules = filterRulesByContentsMatchingInput(
    input,
    askRuleByContents,
    matchMode,
    'ask',
  )

  const allowRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'allow',
  )
  const matchingAllowRules = filterRulesByContentsMatchingInput(
    input,
    allowRuleByContents,
    matchMode,
    'allow',
  )

  return { matchingDenyRules, matchingAskRules, matchingAllowRules }
}

/**
 * 【中文】**精确匹配**判定：命令与某条规则逐字相同（经大小写与别名规范化后）。
 *
 * @returns deny / ask / allow / passthrough（没有命中任何精确规则则 passthrough）
 */
/**
 * Check if the command is an exact match for a permission rule.
 */
export function powershellToolCheckExactMatchPermission(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const trimmedCommand = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')

// 三类规则的优先级：deny > ask > allow。命中 deny 立即返回。
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${POWERSHELL_TOOL_NAME} with command ${trimmedCommand} has been denied.`,
      decisionReason: { type: 'rule', rule: matchingDenyRules[0] },
    }
  }

  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: { type: 'rule', rule: matchingAskRules[0] },
    }
  }

  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: matchingAllowRules[0] },
    }
  }

// `type: 'other' as const`：as const 把类型锁成字面量 'other'，
// 否则会被推成 string，下游按 type 做收窄判断时就推不出具体形态。
  const decisionReason: PermissionDecisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: suggestionForExactCommand(trimmedCommand),
  }
}

/**
 * 【中文】**精确 + 前缀**匹配判定（供「单个子命令」的权限检查使用）。
 *
 * 步骤：① 先精确匹配；命中 deny/ask 立即返回
 *      ② 再做前缀/通配符匹配；命中 deny/ask 立即返回
 *      ③ 精确 allow 优先于前缀 allow
 *      ④ 前缀 allow
 *      ⑤ 都没有 → passthrough（通常会弹框）
 */
/**
 * Check permission for a PowerShell command including prefix matches.
 */
export function powershellToolCheckPermission(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()

// 精确匹配优先：用户写的精确规则意图最明确，应该先照顾它。
  // 1. Check exact match first
  const exactMatchResult = powershellToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 1a. Deny/ask if exact command has a rule
  if (
    exactMatchResult.behavior === 'deny' ||
    exactMatchResult.behavior === 'ask'
  ) {
    return exactMatchResult
  }

  // 2. Find all matching rules (prefix or exact)
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'prefix')

  // 2a. Deny if command has a deny rule
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${POWERSHELL_TOOL_NAME} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. Ask if command has an ask rule
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

// 精确 allow 排在前缀 allow 之前：越具体的规则越可信。
  // 3. Allow if command had an exact match allow
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 4. Allow if command has an allow rule
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 5. Passthrough since no rules match, will trigger permission prompt
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: suggestionForExactCommand(command),
  }
}

// 一个子命令的信息：文本（用于规则匹配与建议）、AST 元素（用于精确判定）、
// 所属语句（用于「整条语句是否可验证」的判断）、是否是纯输出命令。
/**
 * Information about a sub-command for permission checking.
 */
type SubCommandInfo = {
  text: string
  element: ParsedCommandElement
  statement: ParsedPowerShellCommand['statements'][number] | null
  isSafeOutput: boolean
}

/**
 * 【中文】把一条（可能是复合的）命令拆成需要**逐个独立审批**的子命令列表。
 *
 * 为什么要拆：否则一条 `PowerShell(Get-Process:*)` 前缀规则会连带放行
 * `Get-Process | Stop-Process -Force`（管道后面的危险命令被一起放过了）。
 *
 * 注意纯输出命令（Format-Table 等）只是**打标记**，并不从这里过滤掉 ——
 * 因为第 4.4 步仍要用它们去查 deny 规则（deny 永远优先）。
 *
 * 控制流语句（if / for / foreach）里的嵌套命令也会被收集进来，
 * 否则藏在花括号里的命令就逃过了检查。
 */
/**
 * Extract sub-commands that need independent permission checking from a parsed command.
 * Safe output cmdlets (Format-Table, Select-Object, etc.) are flagged but NOT
 * filtered out — step 4.4 still checks deny rules against them (deny always
 * wins), step 5 skips them for approval collection (they inherit the permission
 * of the preceding command).
 *
 * Also includes nested commands from control flow statements (if, for, foreach, etc.)
 * to ensure commands hidden inside control flow are checked.
 *
 * Returns sub-command info including both text and the parsed element for accurate
 * suggestion generation.
 */
async function getSubCommandsForPermissionCheck(
  parsed: ParsedPowerShellCommand,
  originalCommand: string,
): Promise<SubCommandInfo[]> {
// 解析失败时（pwsh 不可用、命令超长等）给一个「兜底元素」，
// 保证后面的流程仍能对整条命令做规则匹配（不至于直接放行）。
  if (!parsed.valid) {
    // Return a fallback element for unparsed commands
    return [
      {
        text: originalCommand,
        element: {
          name: await extractCommandName(originalCommand),
          nameType: 'unknown',
          elementType: 'CommandAst',
          args: [],
          text: originalCommand,
        },
        statement: null,
        isSafeOutput: false,
      },
    ]
  }

  const subCommands: SubCommandInfo[] = []

  // Check direct commands in pipelines
  for (const statement of parsed.statements) {
    for (const cmd of statement.commands) {
      // Only check actual commands (CommandAst), not expressions
      if (cmd.elementType !== 'CommandAst') {
        continue
      }
// 只收集真正的命令（CommandAst）；表达式元素（字符串字面量、变量）不在这里收集，
// 但它们会造成「管道来源不可判定」，由 pathValidation 那边处理。
      subCommands.push({
        text: cmd.text,
        element: cmd,
        statement,
// isSafeOutput 的三个条件缺一不可（对应上方英文注释）：
//   ① nameType 不能是 application（否则 scripts\Out-Null 会被当成内置 Out-Null）
//   ② 名字要在纯输出白名单里
//   ③ **必须零参数**（Out-Null -InputObject:(1 > /etc/x) 里的括号会真的写文件）
// isSafeOutput=true 会让第 5 步把它从审批列表里剔除 —— 那等于放行，所以条件必须极严。
        // SECURITY: nameType gate — scripts\\Out-Null strips to Out-Null and
        // would match SAFE_OUTPUT_CMDLETS, but PowerShell runs the .ps1 file.
        // isSafeOutput: true causes step 5 to filter this command out of the
        // approval list, so it would silently execute. See isAllowlistedCommand.
        // SECURITY: args.length === 0 gate — Out-Null -InputObject:(1 > /etc/x)
        // was filtered as safe-output (name-only) → step-5 subCommands empty →
        // auto-allow → redirection inside paren writes file. Only zero-arg
        // Out-String/Out-Null/Out-Host invocations are provably safe.
        isSafeOutput:
          cmd.nameType !== 'application' &&
          isSafeOutputCommand(cmd.name) &&
          cmd.args.length === 0,
      })
    }

// 控制流体内（if/foreach 的花括号里）的命令同样收集，标准与顶层一致。
    // Also check nested commands from control flow statements
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        subCommands.push({
          text: cmd.text,
          element: cmd,
          statement,
          isSafeOutput:
            cmd.nameType !== 'application' &&
            isSafeOutputCommand(cmd.name) &&
            cmd.args.length === 0,
        })
      }
    }
  }

  if (subCommands.length > 0) {
    return subCommands
  }

  // Fallback for commands with no sub-commands
  return [
    {
      text: originalCommand,
      element: {
        name: await extractCommandName(originalCommand),
        nameType: 'unknown',
        elementType: 'CommandAst',
        args: [],
        text: originalCommand,
      },
      statement: null,
      isSafeOutput: false,
    },
  ]
}

/**
 * 【中文】**对外主入口**：这条 PowerShell 命令到底能不能执行？
 *
 * @param input 工具入参（command / timeout）
 * @param context 工具上下文（内含权限上下文、会话状态等）
 * @returns PermissionResult（deny / ask / allow / passthrough）
 *
 * 完整决策链（**顺序即策略**）：
 *   step 0  空命令 → allow（什么都不做，天然安全）
 *   step 1  解析 AST（失败也要继续，不能因此放行）
 *   step 2  规则匹配：精确 deny → 前缀 deny → （前缀 ask / UNC **延后**）
 *           —— 放在解析检查**之前**，这样即使 pwsh 不可用，用户配的 deny 仍然生效
 *   step 3  解析失败：走兜底扫描（按分隔符切片后逐片查 deny 规则）→ 否则 ask
 *   step 4  **collect**：把下面这些检查的结论全部 push 进 decisions[]
 *            4.1  延后的 pre-parse ask
 *            4.2  powershellCommandIsSafe（危险特征）
 *            4.3  using 语句 / #Requires（会加载外部代码）
 *            4.35 provider 路径 / UNC 扫描
 *            4.4  逐子命令的 deny/ask 规则
 *            4.42 cd + git 复合防护、裸仓库防护、git 内部路径防护
 *            4.44 checkPathConstraints（路径约束，含 cd 失同步）
 *            4.45 精确 allow（有 nameType 与 argLeaksValue 闸门）
 *            4.5  只读白名单放行
 *            4.6  文件重定向 → ask
 *            4.7  acceptEdits 模式放行
 *   step 4R **reduce**：deny > ask > allow（这一段是本文件最重要的结构性设计）
 *   step 5  逐子命令收集需要审批的项（含 fail-closed 兜底）
 *   step 6  组装建议，返回 passthrough（弹框）
 */
/**
 * Main permission check function for PowerShell tool.
 *
 * This function implements the full permission flow:
 * 1. Check exact match against deny/ask/allow rules
 * 2. Check prefix match against rules
 * 3. Run security check via powershellCommandIsSafe()
 * 4. Return appropriate PermissionResult
 *
 * @param input - The PowerShell tool input
 * @param context - The tool use context (for abort signal and session info)
 * @returns Promise resolving to PermissionResult
 */
export async function powershellToolHasPermission(
  input: PowerShellInput,
  context: ToolUseContext,
): Promise<PermissionResult> {
// 权限上下文（含当前模式、已配置的规则等）从应用状态里取。
  const toolPermissionContext = context.getAppState().toolPermissionContext
  const command = input.command.trim()

  // Empty command check
// 空命令直接放行：不做任何事，没有风险。
  if (!command) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Empty command is safe',
      },
    }
  }

// 整条命令**只解析一次** AST，之后所有子步骤共用（解析要真的启动 pwsh 进程，很贵）。
  // Parse the command once and thread through all sub-functions
  const parsed = await parsePowerShellCommand(command)

// 顺序要点（对应上方英文注释）：deny/ask 规则匹配要放在「解析是否成功」检查**之前**，
// 因为规则匹配只需要原始字符串。否则一旦 pwsh 不可用，用户配的 deny 规则就全失效了。
  // SECURITY: Check deny/ask rules BEFORE parse validity check.
  // Deny rules operate on the raw command string and don't need the parsed AST.
  // This ensures explicit deny rules still block commands even when parsing fails.
  // 1. Check exact match first
  const exactMatchResult = powershellToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // Exact command was denied
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // 2. Check prefix/wildcard rules
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  )

  // 2a. Deny if command has a deny rule
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${POWERSHELL_TOOL_NAME} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

// ===== 重要修复：前缀 ask 改为「延后」而不是「立即返回」 =====
// 中文复述上方英文注释：以前这里直接 return ask，于是
// `Get-Process; Invoke-Expression evil` 配上 ask(Get-Process:*) + deny(Invoke-Expression:*)
// 时，用户看到的只是 ask 弹框，deny 规则**永远不会执行** —— 点一下就把 iex 放行了。
// 现在先存进 preParseAskDecision，等 AST 解析成功后压进 decisions[]，
// 由最后的 reduce 保证 deny 优先。
  // 2b. Ask if command has an ask rule — DEFERRED into decisions[].
  // Previously this early-returned before sub-command deny checks ran, so
  // `Get-Process; Invoke-Expression evil` with ask(Get-Process:*) +
  // deny(Invoke-Expression:*) would show the ask dialog and the deny never
  // fired. Now: store the ask, push into decisions[] after parse succeeds.
  // If parse fails, returned before the parse-error ask (preserves the
  // rule-attributed decisionReason when pwsh is unavailable).
  let preParseAskDecision: PermissionResult | null = null
  if (matchingAskRules[0] !== undefined) {
    preParseAskDecision = {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

// UNC 路径（\\server\share）会触发网络请求并可能泄漏 NTLM/Kerberos 凭据 → ask。
// 同样延后处理（原因同上：不能抢在子命令 deny 之前返回）。
  // Block UNC paths — reading from UNC paths can trigger network requests
  // and leak NTLM/Kerberos credentials. DEFERRED into decisions[].
  // The raw-string UNC check must not early-return before sub-command deny
  // (step 4+). Same fix as 2b above.
  if (preParseAskDecision === null && containsVulnerableUncPath(command)) {
    preParseAskDecision = {
      behavior: 'ask',
      message:
        'Command contains a UNC path that could trigger network requests',
    }
  }

// 精确 allow 的「提前短路」只在三种条件同时成立时生效：
//   解析失败（pwsh 不可用）+ 没有待处理的 ask + 命令名不是「应用程序/脚本」形态。
// 第三条的 nameType 闸门很关键：scripts\build.exe 会被剥成 build.exe 从而匹配上
// `build.exe` 的精确 allow —— 但 PowerShell 实际跑的是那个**本地脚本**。
// 代价：正常的 build.exe 在 pwsh 不可用时也会降级成 ask（fail-safe，可接受）。
  // 2c. Exact allow rules short-circuit here ONLY when parsing failed AND
  // no pre-parse ask (2b prefix or UNC) is pending. Converting 2b/UNC from
  // early-return to deferred-assign meant 2c
  // fired before L648 consumed preParseAskDecision — silently overriding the
  // ask with allow. Parse-succeeded path enforces ask > allow via the reduce
  // (L917); without this guard, parse-failed was inconsistent.
  // This ensures user-configured exact allow rules work even when pwsh is
  // unavailable. When parsing succeeds, the exact allow check is deferred to
  // after step 4.4 (sub-command deny/ask) — matching BashTool's ordering where
  // the main-flow exact allow at bashPermissions.ts:1520 runs after sub-command
  // deny checks (1442-1458). Without this, an exact allow on a compound command
  // would bypass deny rules on sub-commands.
  //
  // SECURITY (parse-failed branch): the nameType guard in step 5 lives
  // inside the sub-command loop, which only runs when parsed.valid.
  // This is the !parsed.valid escape hatch. Input-side stripModulePrefix
  // is unconditional — `scripts\build.exe --flag` strips to `build.exe`,
  // canonicalCommand matches exact allow, and without this guard we'd
  // return allow here and execute the local script. classifyCommandName
  // is a pure string function (no AST needed). `scripts\build.exe` →
  // 'application' (has `\`). Same tradeoff as step 5: `build.exe` alone
  // also classifies 'application' (has `.`) so legitimate executable
  // exact-allows downgrade to ask when pwsh is degraded — fail-safe.
  // Module-qualified cmdlets (Module\Cmdlet) also classify 'application'
  // (same `\`); same fail-safe over-fire.
  if (
    exactMatchResult.behavior === 'allow' &&
    !parsed.valid &&
    preParseAskDecision === null &&
    classifyCommandName(command.split(/\s+/)[0] ?? '') !== 'application'
  ) {
    return exactMatchResult
  }

// 解析失败 → ask，但**不给**「保存到设置」的建议：
// 语法都不对，不该建议用户把它存成长期规则。与 BashTool 的处理一致。
  // 0. Check if command can be parsed - if not, require approval but don't suggest persisting
  // This matches Bash behavior: invalid syntax triggers a permission prompt but we don't
  // recommend saving invalid commands to settings
  // NOTE: This check is intentionally AFTER deny/ask rules so explicit rules still work
  // even when the parser fails (e.g., pwsh unavailable).
// ===== 解析失败时的兜底 deny 扫描（很重要）=====
// 中文复述上方那段很长的英文注释：
//   正常情况下子命令 deny 检查靠 AST；解析失败（命令太长、pwsh 不可用、超时…）
//   就没 AST 可用了。攻击手法：
//     `Get-ChildItem # <两千字符填充>; Invoke-Expression evil`
//   填充让解析失败 → 只剩一个笼统的 ask 弹框 → deny(iex:*) 永远不触发。
//   对策：按 PowerShell 的分隔符手工切片，每一片都过一遍**同样的**规则匹配器。
//   保守性说明：字符串字面量/注释里的碎片可能误判成 deny —— 这在
//   「解析失败」的降级状态下是可以接受的（宁可多拒绝）。
  if (!parsed.valid) {
    // SECURITY: Fallback sub-command deny scan for parse-failed path.
    // The sub-command deny loop at L851+ needs the AST; when parsing fails
    // (command exceeds MAX_COMMAND_LENGTH, pwsh unavailable, timeout, bad
    // JSON), we'd return 'ask' without ever checking sub-command deny rules.
    // Attack: `Get-ChildItem # <~2000 chars padding> ; Invoke-Expression evil`
    // → padding forces valid=false → generic ask prompt, deny(iex:*) never
    // fires. This fallback splits on PowerShell separators/grouping and runs
    // each fragment through the SAME rule matcher as step 2a (prefix deny).
    // Conservative: fragments inside string literals/comments may false-positive
    // deny — safe here (parse-failed is already a degraded state, and this is
    // a deny-DOWNGRADE fix). Match against full fragment (not just first token)
    // so multi-word rules like `Remove-Item foo:*` still fire; the matcher's
    // canonical resolution handles aliases (`iex` → `Invoke-Expression`).
    //
// 反引号是 PowerShell 的转义/续行符，**不是**分隔符。
// 按它切会把 `Invoke-Ex`pression` 切成无法匹配的碎片 —— 所以要先
// 「消掉反引号+换行（续行）→ 去掉剩余反引号（转义）」，再按真正的分隔符切。
    // SECURITY: backtick is PS escape/line-continuation, NOT a separator.
    // Splitting on it would fragment `Invoke-Ex`pression` into non-matching
    // pieces. Instead: collapse backtick-newline (line continuation) so
    // `Invoke-Ex`<nl>pression` rejoins, strip remaining backticks (escape
    // chars — ``x → x), then split on actual statement/grouping separators.
    const backtickStripped = command
      .replace(/`[\r\n]+\s*/g, '')
      .replace(/`/g, '')
    for (const fragment of backtickStripped.split(/[;|\n\r{}()&]+/)) {
      const trimmedFrag = fragment.trim()
      if (!trimmedFrag) continue // skip empty fragments
      // Skip the full command ONLY if it starts with a cmdlet name (no
      // assignment prefix). The full command was already checked at 2a, but
      // 2a uses the raw text — $x %= iex as first token `$x` misses the
      // deny(iex:*) rule. If normalization would change the fragment
      // (assignment prefix, dot-source), don't skip — let it be re-checked
      // after normalization. (bug #10/#24)
// 整条命令本身在 2a 已经查过了，这里跳过 —— **除非**它带赋值前缀或以调用运算符开头
// （那种情况下第 2a 步拿到的是原始文本，第一个 token 是 $x 或 &，会漏匹配）。
      if (
        trimmedFrag === command &&
        !/^\$[\w:]/.test(trimmedFrag) &&
        !/^[&.]\s/.test(trimmedFrag)
      ) {
        continue
      }
// 归一化三类前缀后再匹配（对应上方英文注释）：
//   `$x = Invoke-Expression 'p'` → 第一个 token 是 $x，deny(iex:*) 匹配不上；
//   `. Invoke-Expression 'p'`    → 第一个 token 是 `.`；
//   `& 'Invoke-Expression' 'p'`  → 带着引号。
// while 循环剥掉**嵌套**赋值（$x = $y = iex → iex）。
      // SECURITY: Normalize invocation-operator and assignment prefixes before
      // rule matching (findings #5/#22). The splitter gives us the raw fragment
      // text; matchingRulesForInput extracts the first token as the cmdlet name.
      // Without normalization:
      //   `$x = Invoke-Expression 'p'` → first token `$x` → deny(iex:*) misses
      //   `. Invoke-Expression 'p'`    → first token `.`  → deny(iex:*) misses
      //   `& 'Invoke-Expression' 'p'`  → first token `&` removed by split but
      //                                  `'Invoke-Expression'` retains quotes
      //                                  → deny(iex:*) misses
      // The parse-succeeded path handles these via AST (parser.ts:839 strips
      // quotes from rawNameUnstripped; invocation operators are separate AST
      // nodes). This fallback mirrors that normalization.
      // Loop strips nested assignments: $x = $y = iex → $y = iex → iex
      let normalized = trimmedFrag
      let m: RegExpMatchArray | null
      while ((m = normalized.match(PS_ASSIGN_PREFIX_RE))) {
        normalized = normalized.slice(m[0].length)
      }
      normalized = normalized.replace(/^[&.]\s+/, '') // & cmd, . cmd (dot-source)
      const rawFirst = normalized.split(/\s+/)[0] ?? ''
      const firstTok = rawFirst.replace(/^['"]|['"]$/g, '')
      const normalizedFrag = firstTok + normalized.slice(rawFirst.length)
// 解析失败时也要保住「删除系统路径」的硬拒绝：
// 否则 pwsh 不可用时 `Remove-Item /` 就从「硬拒绝」降级成了普通 ask（用户能批准）。
// 这里只看位置参数（跳过 -Param 形式的 token），在降级状态下过度拒绝是安全的。
      // SECURITY: parse-independent dangerous-removal hard-deny. The
      // isDangerousRemovalPath check in checkPathConstraintsForStatement
      // requires a valid AST; when pwsh times out or is unavailable,
      // `Remove-Item /` degrades from hard-deny to generic ask. Check
      // raw positional args here so root/home/system deletion is denied
      // regardless of parser availability. Conservative: only positional
      // args (skip -Param tokens); over-deny in degraded state is safe
      // (same deny-downgrade rationale as the sub-command scan above).
      if (resolveToCanonical(firstTok) === 'remove-item') {
        for (const arg of normalized.split(/\s+/).slice(1)) {
          if (PS_TOKENIZER_DASH_CHARS.has(arg[0] ?? '')) continue
          if (isDangerousRemovalRawPath(arg)) {
            return dangerousRemovalDeny(arg)
          }
        }
      }
      const { matchingDenyRules: fragDenyRules } = matchingRulesForInput(
        { command: normalizedFrag },
        toolPermissionContext,
        'prefix',
      )
      if (fragDenyRules[0] !== undefined) {
        return {
          behavior: 'deny',
          message: `Permission to use ${POWERSHELL_TOOL_NAME} with command ${command} has been denied.`,
          decisionReason: { type: 'rule', rule: fragDenyRules[0] },
        }
      }
    }
    // Preserve pre-parse ask messaging when parse fails. The deferred ask
    // (2b prefix rule or UNC) carries a better decisionReason than the
    // generic parse-error ask. Sub-command deny can't run the AST loop
    // without a parse, so the fallback scan above is best-effort.
    if (preParseAskDecision !== null) {
      return preParseAskDecision
    }
    const decisionReason = {
      type: 'other' as const,
      reason: `Command contains malformed syntax that cannot be parsed: ${parsed.errors[0]?.message ?? 'unknown error'}`,
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      // No suggestions - don't recommend persisting invalid syntax
    }
  }

// ====================================================================
// ===== collect-then-reduce：先收集所有结论，最后按优先级归约 =========
// ====================================================================
// 中文精讲（对应上方那段很长的英文注释）：
//   老写法是每步检查完就 `return`，于是**先出现的 ask 会遮住后出现的 deny**。
//   现在所有检查把结论 push 进 decisions[]，最后统一按
//   **deny > ask > allow > passthrough** 挑一个。
//   好处是这类「ask 抢在 deny 前面返回」的 bug 在**结构上**就写不出来了 ——
//   下一个写代码的人哪怕又写了个 `return ask`，也只是往数组里加一项。
//   「同类行为取第一个」（数组顺序 = 步骤顺序），所以单条检查的提示文案与以前一致。
//   解析**之前**的 deny 检查仍保持顺序执行（它们要在 pwsh 不可用时也生效）。
  // ========================================================================
  // COLLECT-THEN-REDUCE: post-parse decisions (deny > ask > allow > passthrough)
  // ========================================================================
  // Ported from bashPermissions.ts:1446-1472. Every post-parse check pushes
  // its decision into a single array; a single reduce applies precedence.
  // This structurally closes the ask-before-deny bug class: an 'ask' from an
  // earlier check (security flags, provider paths, cd+git) can no longer mask
  // a 'deny' from a later check (sub-command deny, checkPathConstraints).
  //
  // Supersedes the firstSubCommandAskRule stash from commit 8f5ae6c56b — that
  // fix only patched step 4; steps 3, 3.5, 4.42 had the same flaw. The stash
  // pattern is also fragile: the next author who writes `return ask` is back
  // where we started. Collect-then-reduce makes the bypass impossible to write.
  //
  // First-of-each-behavior wins (array order = step order), so single-check
  // ask messages are unchanged vs. sequential-early-return.
  //
  // Pre-parse deny checks above (exact/prefix deny) stay sequential: they
  // fire even when pwsh is unavailable. Pre-parse asks (prefix ask, raw UNC)
  // are now deferred here so sub-command deny (step 4) beats them.

  // Gather sub-commands once (used by decisions 3, 4, and fallthrough step 5).
// 子命令列表只算一次，后面第 4.4 步和第 5 步共用。
  const allSubCommands = await getSubCommandsForPermissionCheck(parsed, command)

  const decisions: PermissionResult[] = []

// 延后的 pre-parse ask **第一个**入列：它的文案比后面的 ask 更好，
// 而 reduce 仍会保证任何 deny 都能压过它。
  // Decision: deferred pre-parse ask (2b prefix ask or UNC path).
  // Pushed first so its message wins over later asks (first-of-behavior wins),
  // but the reduce ensures any deny in decisions[] still beats it.
  if (preParseAskDecision !== null) {
    decisions.push(preParseAskDecision)
  }

// 安全检查：命中危险特征（子表达式、脚本块、编码命令、下载执行链…）→ ask。
  // Decision: security check — was step 3 (:630-650).
  // powershellCommandIsSafe returns 'ask' for subexpressions, script blocks,
  // encoded commands, download cradles, etc. Only 'ask' | 'passthrough'.
  const safetyResult = powershellCommandIsSafe(command, parsed)
  if (safetyResult.behavior !== 'passthrough') {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason:
        safetyResult.behavior === 'ask' && safetyResult.message
          ? safetyResult.message
          : 'This command contains patterns that could pose security risks and requires approval',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }

// using 语句 / #Requires 指令：它们会加载**外部代码**（模块或程序集），
// 而它们在 AST 里是 ScriptBlockAst 的**兄弟节点**而不是子节点 ——
// 所有基于「遍历命令节点」的检查都看不见它们。
// 危害：用一个无害的 Get-Process 当诱饵填满子命令列表，
// 于是「空语句兜底」不触发，只读白名单直接放行。
  // Decision: using statements / script requirements — invisible to AST block walk.
  // `using module ./evil.psm1` loads and executes a module's top-level script body;
  // `using assembly ./evil.dll` loads a .NET assembly (module initializers run).
  // `#Requires -Modules <name>` triggers module loading from PSModulePath.
  // These are siblings of the named blocks on ScriptBlockAst, not children, so
  // Process-BlockStatements and all downstream command walkers never see them.
  // Without this check, a decoy cmdlet like Get-Process fills subCommands,
  // bypassing the empty-statement fallback, and isReadOnlyCommand auto-allows.
  if (parsed.hasUsingStatements) {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason:
        'Command contains a `using` statement that may load external code (module or assembly)',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }
  if (parsed.hasScriptRequirements) {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason:
        'Command contains a `#Requires` directive that may trigger module loading',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }

// provider 路径（env: / HKLM: / function: / registry:）与 UNC 路径扫描。
// 这里看的是**解析后的**参数值，所以能抓到上面原始字符串检查漏掉的反引号转义形式。
  // Decision: resolved-arg provider/UNC scan — was step 3.5 (:652-709).
  // Provider paths (env:, HKLM:, function:) access non-filesystem resources.
  // UNC paths can leak NTLM/Kerberos credentials on Windows. The raw-string
  // UNC check above (pre-parse) misses backtick-escaped forms; cmd.args has
  // backtick escapes resolved by the parser. Labeled loop breaks on FIRST
  // match (same as the previous early-return).
  // Provider prefix matches both the short form (`env:`, `HKLM:`) and the
  // fully-qualified form (`Microsoft.PowerShell.Core\Registry::HKLM\...`).
  // The optional `(?:[\w.]+\\)?` handles the module-qualified prefix; `::?`
  // matches either single-colon drive syntax or double-colon provider syntax.
// 正则说明：`(?:[\w.]+\\)?` 匹配可选的模块限定前缀；`::?` 同时匹配
// 单冒号（盘符/PSDrive 写法）和双冒号（provider 写法）。
  const NON_FS_PROVIDER_PATTERN =
    /^(?:[\w.]+\\)?(env|hklm|hkcu|function|alias|variable|cert|wsman|registry)::?/i
// 先剥掉 `-Path:` 这类冒号绑定前缀（还要认 Unicode 破折号），再去掉反引号，
// 否则 ^ 锚定的 provider 正则匹配不上。
  function extractProviderPathFromArg(arg: string): string {
    // Handle colon parameter syntax: -Path:env:HOME → extract 'env:HOME'.
    // SECURITY: PowerShell's tokenizer accepts en-dash/em-dash/horizontal-bar
    // (U+2013/2014/2015) as parameter prefixes. `–Path:env:HOME` (en-dash)
    // must also strip the `–Path:` prefix or NON_FS_PROVIDER_PATTERN won't
    // match (pattern is `^(env|...):` which fails on `–Path:env:...`).
    let s = arg
    if (s.length > 0 && PS_TOKENIZER_DASH_CHARS.has(s[0]!)) {
      const colonIdx = s.indexOf(':', 1) // skip the leading dash
      if (colonIdx > 0) {
        s = s.substring(colonIdx + 1)
      }
    }
    // Strip backtick escapes before matching: `Registry`::HKLM\...` has a
    // backtick before `::` that the PS tokenizer removes at runtime but that
    // would otherwise prevent the ^-anchored pattern from matching.
    return s.replace(/`/g, '')
  }
  function providerOrUncDecisionForArg(arg: string): PermissionResult | null {
    const value = extractProviderPathFromArg(arg)
    if (NON_FS_PROVIDER_PATTERN.test(value)) {
      return {
        behavior: 'ask',
        message: `Command argument '${arg}' uses a non-filesystem provider path and requires approval`,
      }
    }
    if (containsVulnerableUncPath(value)) {
      return {
        behavior: 'ask',
        message: `Command argument '${arg}' contains a UNC path that could trigger network requests`,
      }
    }
    return null
  }
// 带标签的循环（TS 与 Java 写法几乎一样）：命中第一个就 `break providerScan` 跳出外层。
  providerScan: for (const statement of parsed.statements) {
    for (const cmd of statement.commands) {
      if (cmd.elementType !== 'CommandAst') continue
      for (const arg of cmd.args) {
        const decision = providerOrUncDecisionForArg(arg)
        if (decision !== null) {
          decisions.push(decision)
          break providerScan
        }
      }
    }
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        for (const arg of cmd.args) {
          const decision = providerOrUncDecisionForArg(arg)
          if (decision !== null) {
            decisions.push(decision)
            break providerScan
          }
        }
      }
    }
  }

// 逐子命令查 deny/ask 规则。每个子命令最多产生一条结论；
// **后面**子命令的 deny 依然能压过**前面**子命令的 ask —— 靠的就是最后的 reduce。
  // Decision: per-sub-command deny/ask rules — was step 4 (:711-803).
  // Each sub-command produces at most one decision (deny or ask). Deny rules
  // on LATER sub-commands still beat ask rules on EARLIER ones via the reduce.
  // No stash needed — the reduce structurally enforces deny > ask.
  //
// 除了拿子命令原文匹配，还要用**AST 拼出来的规范命令**再匹配一次（见上方英文注释）：
//   `& 'Remove-Item' ./x`  —— 原文第一个 token 是调用运算符 &，不是命令名；
//   `rm\t./x`             —— 原文用的是制表符，前缀规则用的是字面空格；
//   `Module\Remove-Item`  —— AST 里的 name 已经剥掉了模块前缀。
// 两边都用同一种规范化形式，才能消除这种「一边匹配一边不匹配」的绕过。
  // SECURITY: Always build a canonical command string from AST-derived data
  // (element.name + space-joined args) and check rules against it too. Deny
  // and allow must use the same normalized form to close asymmetries:
  //   - Invocation operators (`& 'Remove-Item' ./x`): raw text starts with `&`,
  //     splitting on whitespace yields the operator, not the cmdlet name.
  //   - Non-space whitespace (`rm\t./x`): raw prefix match uses `prefix + ' '`
  //     (literal space), but PowerShell accepts any whitespace separator.
  //     checkPermissionMode auto-allow (using AST cmd.name) WOULD match while
  //     deny-rule match on raw text would miss — a deny-rule bypass.
  //   - Module prefixes (`Microsoft.PowerShell.Management\Remove-Item`):
  //     element.name has the module prefix stripped.
  for (const { text: subCmd, element } of allSubCommands) {
    // element.name is quote-stripped at the parser (transformCommandAst) so
    // `& 'Invoke-Expression' 'x'` yields name='Invoke-Expression', not
    // "'Invoke-Expression'". canonicalSubCmd is built from the same stripped
    // name, so deny-rule prefix matching on `Invoke-Expression:*` hits.
    const canonicalSubCmd =
      element.name !== '' ? [element.name, ...element.args].join(' ') : null

    const subInput = { command: subCmd }
    const { matchingDenyRules: subDenyRules, matchingAskRules: subAskRules } =
      matchingRulesForInput(subInput, toolPermissionContext, 'prefix')
    let matchedDenyRule = subDenyRules[0]
    let matchedAskRule = subAskRules[0]

    if (matchedDenyRule === undefined && canonicalSubCmd !== null) {
      const {
        matchingDenyRules: canonicalDenyRules,
        matchingAskRules: canonicalAskRules,
      } = matchingRulesForInput(
        { command: canonicalSubCmd },
        toolPermissionContext,
        'prefix',
      )
      matchedDenyRule = canonicalDenyRules[0]
      if (matchedAskRule === undefined) {
        matchedAskRule = canonicalAskRules[0]
      }
    }

    if (matchedDenyRule !== undefined) {
      decisions.push({
        behavior: 'deny',
        message: `Permission to use ${POWERSHELL_TOOL_NAME} with command ${command} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: matchedDenyRule,
        },
      })
    } else if (matchedAskRule !== undefined) {
      decisions.push({
        behavior: 'ask',
        message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
        decisionReason: {
          type: 'rule',
          rule: matchedAskRule,
        },
      })
    }
  }

// cd + git 复合防护：cd 到恶意目录后再跑 git 是危险的（假 hook、裸仓库攻击）。
  // Decision: cd+git compound guard — was step 4.42 (:805-833).
  // When cd/Set-Location is paired with git, don't allow without prompting —
  // cd to a malicious directory makes git dangerous (fake hooks, bare repo
  // attacks). Collect-then-reduce keeps the improvement over BashTool: in
  // bash, cd+git (B9, line 1416) runs BEFORE sub-command deny (B11), so cd+git
  // ask masks deny. Here, both are in the same decision array; deny wins.
  //
// 注意**没有** 「cd 到当前目录不算」 的豁免（对应上方英文注释）：
// 判断 cd 目标用的是「取第一个非参数 token」的启发式，
// 而 `Set-Location -Path:/etc .` 的真实目标是 /etc，启发式却看到 `.` ——
// 一旦有豁免就会被绕过。收益（少弹一次框）不值得这个风险。
  // SECURITY: NO cd-to-CWD no-op exclusion. A previous iteration excluded
  // `Set-Location .` as a no-op, but the "first non-dash arg" heuristic used
  // to extract the target is fooled by colon-bound params:
  // `Set-Location -Path:/etc .` — real target is /etc, heuristic sees `.`,
  // exclusion fires, bypass. The UX case (model emitting `Set-Location .; foo`)
  // is rare; the attack surface isn't worth the special-case. Any cd-family
  // cmdlet in the compound sets this flag, period.
// 只有**复合命令**（多于一个子命令）里有 cd 才标记。
// 单独的 `Set-Location ./subdir` 没有 TOCTOU 风险（后面没有语句会用相对路径），
// 标记它会白白压制逐子命令的自动放行路径。
  // Only flag compound cd when there are multiple sub-commands. A standalone
  // `Set-Location ./subdir` is not a TOCTOU risk (no later statement resolves
  // relative paths against stale cwd). Without this, standalone cd forces the
  // compound guard, suppressing the per-subcommand auto-allow path. (bug #25)
  const hasCdSubCommand =
    allSubCommands.length > 1 &&
    allSubCommands.some(({ element }) => isCwdChangingCmdlet(element.name))
// 创建链接的复合命令同样要拦：链接一旦建好，后面通过它的写入就跑出校验视野了
// （与 cd 失同步是同一类 TOCTOU 形状）。
  // Symlink-create compound guard (finding #18 / bug 001+004): when the
  // compound creates a filesystem link, subsequent writes through that link
  // land outside the validator's view. Same TOCTOU shape as cwd desync.
  const hasSymlinkCreate =
    allSubCommands.length > 1 &&
    allSubCommands.some(({ element }) => isSymlinkCreatingCommand(element))
  const hasGitSubCommand = allSubCommands.some(
    ({ element }) => resolveToCanonical(element.name) === 'git',
  )
  if (hasCdSubCommand && hasGitSubCommand) {
    decisions.push({
      behavior: 'ask',
      message:
        'Compound commands with cd/Set-Location and git require approval to prevent bare repository attacks',
    })
  }

// cd + 写 的复合防护已经被 checkPathConstraints(compoundCommandHasCd) **吸收**了：
// 那边覆盖了「任何路径操作（读和写都算）」，比这里更广。
// 这里保留的几处 !hasCdSubCommand 闸门是纵深防御（覆盖没走到路径校验的场景）。
  // cd+write compound guard — SUBSUMED by checkPathConstraints(compoundCommandHasCd).
  // Previously this block pushed 'ask' when hasCdSubCommand && hasAcceptEditsWrite,
  // but checkPathConstraints now receives hasCdSubCommand and pushes 'ask' for ANY
  // path operation (read or write) in a cd-compound — broader coverage at the path
  // layer (BashTool parity). The step-5 !hasCdSubCommand gates and modeValidation's
  // compound-cd guard remain as defense-in-depth for paths that don't reach
  // checkPathConstraints (e.g., cmdlets not in CMDLET_PATH_CONFIG).

// 裸仓库防护：当前目录里有 HEAD + objects/ + refs/ 却没有合法的 .git/HEAD 时，
// git 会把当前目录当成**裸仓库**并直接执行其中的 hook —— 攻击者放个 hooks/pre-commit，
// 再删掉 .git/HEAD，之后任何 git 子命令都会执行它。
  // Decision: bare-git-repo guard — bash parity.
  // If cwd has HEAD/objects/refs/ without a valid .git/HEAD, Git treats
  // cwd as a bare repository and runs hooks from cwd. Attacker creates
  // hooks/pre-commit, deletes .git/HEAD, then any git subcommand runs it.
  // Port of BashTool readOnlyValidation.ts isCurrentDirectoryBareGitRepo.
  if (hasGitSubCommand && isCurrentDirectoryBareGitRepo()) {
    decisions.push({
      behavior: 'ask',
      message:
        'Git command in a directory with bare-repository indicators (HEAD, objects/, refs/ in cwd without .git/HEAD). Git may execute hooks from cwd.',
    })
  }

// git 内部路径防护（BashTool 同款）：复合命令先造出 HEAD/objects/refs/hooks，
// 再跑 git —— 于是 git 执行的就是刚被植入的恶意 hook。
// 检查范围：写类 cmdlet 的参数、重定向目标、以及管道传进来的字符串。
  // Decision: git-internal-paths write guard — bash parity.
  // Compound command creates HEAD/objects/refs/hooks/ then runs git → the
  // git subcommand executes freshly-created malicious hooks. Check all
  // extracted write paths + redirection targets against git-internal patterns.
  // Port of BashTool commandWritesToGitInternalPaths, adapted for AST.
  if (hasGitSubCommand) {
    const writesToGitInternal = allSubCommands.some(
      ({ element, statement }) => {
        // Redirection targets on this sub-command (raw Extent.Text — quotes
        // and ./ intact; normalizer handles both)
        for (const r of element.redirections ?? []) {
          if (isGitInternalPathPS(r.target)) return true
        }
        // Write cmdlet args (new-item HEAD; mkdir hooks; set-content hooks/pre-commit)
        const canonical = resolveToCanonical(element.name)
        if (!GIT_SAFETY_WRITE_CMDLETS.has(canonical)) return false
        // Raw arg text — normalizer strips colon-bound params, quotes, ./, case.
// PowerShell 的数组字面量（New-Item a,hooks/pre-commit）在 AST 里是**一个**逗号连接的参数，
// 所以要先按逗号拆开再逐个检查 —— 否则只看到第一段而漏掉后面的。
        // PS ArrayLiteralAst (`New-Item a,hooks/pre-commit`) surfaces as a single
        // comma-joined arg — split before checking.
        if (
          element.args
            .flatMap(a => a.split(','))
            .some(a => isGitInternalPathPS(a))
        ) {
          return true
        }
        // Pipeline input: `"hooks/pre-commit" | New-Item -ItemType File` binds the
        // string to -Path at runtime. The path is in a non-CommandAst pipeline
        // element, not in element.args. The hasExpressionSource guard at step 5
        // already forces approval here; this check just adds the git-internal
        // warning text.
        if (statement !== null) {
          for (const c of statement.commands) {
            if (c.elementType === 'CommandAst') continue
            if (isGitInternalPathPS(c.text)) return true
          }
        }
        return false
      },
    )
    // Also check top-level file redirections (> hooks/pre-commit)
    const redirWritesToGitInternal = getFileRedirections(parsed).some(r =>
      isGitInternalPathPS(r.target),
    )
    if (writesToGitInternal || redirWritesToGitInternal) {
      decisions.push({
        behavior: 'ask',
        message:
          'Command writes to a git-internal path (HEAD, objects/, refs/, hooks/, .git/) and runs git. This could plant a malicious hook that git then executes.',
      })
    }
// 解压 + git 的 TOCTOU（见 GIT_SAFETY_ARCHIVE_EXTRACTORS 的注释）：
// 压缩包内容不透明，只要「解压」和「git」同时出现在复合命令里就 ask。
    // SECURITY: Archive-extraction TOCTOU. isCurrentDirectoryBareGitRepo
    // checks at permission-eval time; `tar -xf x.tar; git status` extracts
    // bare-repo indicators AFTER the check, BEFORE git runs. Unlike write
    // cmdlets (where we inspect args for git-internal paths), archive
    // contents are opaque — any extraction in a compound with git must ask.
    const hasArchiveExtractor = allSubCommands.some(({ element }) =>
      GIT_SAFETY_ARCHIVE_EXTRACTORS.has(element.name.toLowerCase()),
    )
    if (hasArchiveExtractor) {
      decisions.push({
        behavior: 'ask',
        message:
          'Compound command extracts an archive and runs git. Archive contents may plant bare-repository indicators (HEAD, hooks/, refs/) that git then treats as the repository root.',
      })
    }
  }

// 写 .git/ **即使没有 git 子命令**也危险：种进去的 .git/hooks/pre-commit
// 会在用户下次 commit 时执行。与上面不同，这里不需要 hasGitSubCommand 前提 ——
// 因为 .git/ 这个目录名没有歧义（不像 hooks/ 可能是普通项目目录）。
  // .git/ writes are dangerous even WITHOUT a git subcommand — a planted
  // .git/hooks/pre-commit fires on the user's next commit. Unlike the
  // bare-repo check above (which gates on hasGitSubCommand because `hooks/`
  // is a common project dirname), `.git/` is unambiguous.
  {
    const found =
      allSubCommands.some(({ element }) => {
        for (const r of element.redirections ?? []) {
          if (isDotGitPathPS(r.target)) return true
        }
        const canonical = resolveToCanonical(element.name)
        if (!GIT_SAFETY_WRITE_CMDLETS.has(canonical)) return false
        return element.args.flatMap(a => a.split(',')).some(isDotGitPathPS)
      }) || getFileRedirections(parsed).some(r => isDotGitPathPS(r.target))
    if (found) {
      decisions.push({
        behavior: 'ask',
        message:
          'Command writes to .git/ — hooks or config planted there execute on the next git operation.',
      })
    }
  }

// 路径约束检查（pathValidation.ts）。它能返回 deny（命中 Edit(...) 规则）
// 或 ask（路径在工作目录之外）。hasCdSubCommand 会传进去，让那边对
// 复合命令里的相对路径一律 ask —— 这是 cwd 失同步问题的**架构级**修复。
  // Decision: path constraints — was step 4.44 (:835-845).
  // The deny-capable check that was being masked by earlier asks. Returns
  // 'deny' when an Edit(...) deny rule matches an extracted path (pathValidation
  // lines ~994, 1088, 1160, 1210), 'ask' for paths outside working dirs, or
  // 'passthrough'.
  //
  // Thread hasCdSubCommand (BashTool compoundCommandHasCd parity): when the
  // compound contains a cwd-changing cmdlet, checkPathConstraints forces 'ask'
  // for any statement with path operations — relative paths resolve against the
  // stale validator cwd, not PowerShell's runtime cwd. This is the architectural
  // fix for the CWD-desync cluster (findings #3/#21/#27/#28), replacing the
  // per-auto-allow-site guards with a single gate at the path-resolution layer.
  const pathResult = checkPathConstraints(
    input,
    parsed,
    toolPermissionContext,
    hasCdSubCommand,
  )
  if (pathResult.behavior !== 'passthrough') {
    decisions.push(pathResult)
  }

// 精确 allow（解析成功的情况）。位置刻意排在子命令 deny 与路径约束**之后**，
// 与 BashTool 的顺序一致：否则一条精确 allow 会绕过子命令上的 deny 规则。
  // Decision: exact allow (parse-succeeded case) — was step 4.45 (:861-867).
  // Matches BashTool ordering: sub-command deny → path constraints → exact
  // allow. Reduce enforces deny > ask > allow, so the exact allow only
  // surfaces when no deny or ask fired — same as sequential.
  //
// nameType 闸门 + argLeaksValue 闸门（对应上方英文注释）：
//   scripts\Get-Content 会被剥成 Get-Content 从而匹配上精确 allow → 必须靠 nameType 挡；
//   `PowerShell(Write-Output:*)` 会匹配 `Write-Output $env:KEY` → 必须靠 argLeaksValue 挡；
//   而且 nameType 要检查**所有**子命令（不能只看第一个），
//   因为 `code\n.\build.ps1` 这种换行写法会被折叠成一条「看起来没问题」的精确匹配。
  // SECURITY: nameType gate — mirrors the parse-failed guard at L696-700.
  // Input-side stripModulePrefix is unconditional: `scripts\Get-Content`
  // strips to `Get-Content`, canonicalCommand matches exact allow. Without
  // this gate, allow enters decisions[] and reduce returns it before step 5
  // can inspect nameType — PowerShell runs the local .ps1 file. The AST's
  // nameType for the first command element is authoritative when parse
  // succeeded; 'application' means a script/executable path, not a cmdlet.
  // SECURITY: Same argLeaksValue gate as the per-subcommand loop below
  // (finding #32). Without it, `PowerShell(Write-Output:*)` exact-matches
  // `Write-Output $env:ANTHROPIC_API_KEY`, pushes allow to decisions[], and
  // reduce returns it before the per-subcommand gate ever runs. The
  // allSubCommands.every check ensures NO command in the statement leaks
  // (a single-command exact-allow has one element; a pipeline has several).
  //
  // SECURITY: nameType gate must check ALL subcommands, not just [0]
  // (finding #10). canonicalCommand at L171 collapses `\n` → space, so
  // `code\n.\build.ps1` (two statements) matches exact rule
  // `PowerShell(code .\build.ps1)`. Checking only allSubCommands[0] lets the
  // second statement (nameType=application, a script path) through. Require
  // EVERY subcommand to have nameType !== 'application'.
  if (
    exactMatchResult.behavior === 'allow' &&
    allSubCommands[0] !== undefined &&
    allSubCommands.every(
      sc =>
        sc.element.nameType !== 'application' &&
        !argLeaksValue(sc.text, sc.element),
    )
  ) {
    decisions.push(exactMatchResult)
  }

// 只读白名单放行：对应 Bash 那边对 ls / cat / git status 的自动放行。
// 这里对应 Get-Process / Get-ChildItem / Get-Content / git log 等。
  // Decision: read-only allowlist — was step 4.5 (:869-885).
  // Mirrors Bash auto-allow for ls, cat, git status, etc. PowerShell
  // equivalents: Get-Process, Get-ChildItem, Get-Content, git log, etc.
  // Reduce places this below sub-command ask rules (ask > allow).
  if (isReadOnlyCommand(command, parsed)) {
    decisions.push({
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Command is read-only and safe to execute',
      },
    })
  }

// 文件重定向（> file.txt）会写到任意路径，一律 ask。
// （只读判定内部已经拒绝重定向，所以不会与上面的只读放行冲突。）
  // Decision: file redirections — was :887-900.
  // Redirections (>, >>, 2>) write to arbitrary paths. isReadOnlyCommand
  // already rejects redirections internally so this can't conflict with the
  // read-only allow above. Reduce places it above checkPermissionMode allow.
  const fileRedirections = getFileRedirections(parsed)
  if (fileRedirections.length > 0) {
    decisions.push({
      behavior: 'ask',
      message:
        'Command contains file redirections that could write to arbitrary paths',
      suggestions: suggestionForExactCommand(command),
    })
  }

// acceptEdits 模式下的放行（委托给 modeValidation.ts，那是唯一的判定来源）。
  // Decision: mode-specific handling (acceptEdits) — was step 4.7 (:902-906).
  // checkPermissionMode only returns 'allow' | 'passthrough'.
  const modeResult = checkPermissionMode(input, parsed, toolPermissionContext)
  if (modeResult.behavior !== 'passthrough') {
    decisions.push(modeResult)
  }

// ===== REDUCE：本文件最重要的三行 ======
// 按 deny > ask > allow 的优先级挑出最终结论；每个优先级取**第一个**（保持步骤顺序的文案）。
// 三个都没命中就落到第 5 步（逐子命令收集需要审批的项）。
  // REDUCE: deny > ask > allow > passthrough. First of each behavior type
  // wins (preserves step-order messaging for single-check cases). If nothing
  // decided, fall through to step 5 per-sub-command approval collection.
  const deniedDecision = decisions.find(d => d.behavior === 'deny')
  if (deniedDecision !== undefined) {
    return deniedDecision
  }
  const askDecision = decisions.find(d => d.behavior === 'ask')
  if (askDecision !== undefined) {
    return askDecision
  }
  const allowDecision = decisions.find(d => d.behavior === 'allow')
  if (allowDecision !== undefined) {
    return allowDecision
  }

// ===== 第 5 步：逐子命令收集需要审批的项 =====
// 为什么还要再拆一遍：一条 `Get-Process:*` 前缀规则不该连带放行
// `Get-Process | Stop-Process -Force` 里管道后面的危险命令。
  // 5. Pipeline/statement splitting: check each sub-command independently.
  // This prevents a prefix rule like "Get-Process:*" from silently allowing
  // piped commands like "Get-Process | Stop-Process -Force".
  // Note: deny rules are already checked above (4.4), so this loop handles
  // ask rules, explicit allow rules, and read-only allowlist fallback.

  // Filter out safe output cmdlets (Format-Table, etc.) — they were checked
  // for deny rules in step 4.4 but shouldn't need independent approval here.
  // Also filter out cd/Set-Location to CWD (model habit, Bash parity).
// 过滤掉两类不需要单独审批的：纯输出命令（Format-Table 等）和「cd 到当前目录」。
  const subCommands = allSubCommands.filter(({ element, isSafeOutput }) => {
    if (isSafeOutput) {
      return false
    }
// 注意：nameType='application' 的**不能**过滤掉 —— 从审批列表里剔除等于放行，
// 而 scripts\Set-Location.ps1 正是靠这个伪装。要让它们走到 isAllowlistedCommand 被拒。
    // SECURITY: nameType gate — sixth location. Filtering out of the approval
    // list is a form of auto-allow. scripts\\Set-Location . would match below
    // (stripped name 'Set-Location', arg '.' → CWD) and be silently dropped,
    // then scripts\\Set-Location.ps1 executes with no prompt. Keep 'application'
    // commands in the list so they reach isAllowlistedCommand (which rejects them).
    if (element.nameType === 'application') {
      return true
    }
    const canonical = resolveToCanonical(element.name)
// 「cd 到当前目录」是模型的常见习惯（BashTool 里同样豁免）。
// 判断目标时必须用 PS_TOKENIZER_DASH_CHARS 而不是 ASCII 的 startsWith('-') ——
// 否则 Unicode 破折号参数（`–Path`）会被误当成 cd 的目标。
    if (canonical === 'set-location' && element.args.length > 0) {
      // SECURITY: use PS_TOKENIZER_DASH_CHARS, not ASCII-only startsWith('-').
      // `Set-Location –Path .` (en-dash) would otherwise treat `–Path` as the
      // target, resolve it against cwd (mismatch), and keep the command in the
      // approval list — correct. But `Set-Location –LiteralPath evil` with
      // en-dash would find `–LiteralPath` as "target", mismatch cwd, stay in
      // list — also correct. The risk is the inverse: a Unicode-dash parameter
      // being treated as the positional target. Use the tokenizer dash set.
      const target = element.args.find(
        a => a.length === 0 || !PS_TOKENIZER_DASH_CHARS.has(a[0]!),
      )
      if (target && resolve(getCwd(), target) === getCwd()) {
        return false
      }
    }
    return true
  })

  // Note: cd+git compound guard already ran at step 4.42. If we reach here,
  // either there's no cd or no git in the compound.

  const subCommandsNeedingApproval: string[] = []
// statementsSeenInLoop 记录「哪些语句已经在循环里被推入待审批列表」，
// 用来避免同一个语句既出现子命令又出现整句、导致重复建议。
  // Statements whose sub-commands were PUSHED to subCommandsNeedingApproval
  // in the step-5 loop below. The fail-closed gate (after the loop) only
  // pushes statements NOT tracked here — prevents duplicate suggestions where
  // both "Get-Process" (sub-command) AND "$x = Get-Process" (full statement)
  // appear.
  //
// 关键安全细节（对应上方英文注释）：只在 **push 时**标记，不能在循环进入时标记。
// 否则：用户放行了 Get-Process，那么 `if ($true) { Get-Process; $env:SECRET }`
// 里 Get-Process 走 continue（没 push），$env:SECRET 又不是子命令，
// 语句被标记成「已处理」 → 兜底闸门跳过 → **自动放行** → 密钥泄漏。
// 只在 push 时标记：语句仍算「未见过」 → 兜底闸门触发 → ask。
  // SECURITY: track on PUSH only, not on loop entry.
  // If a statement's only sub-commands `continue` via user allow rules
  // (L1113), marking it seen at loop-entry would make the fail-closed gate
  // skip it — auto-allowing invisible non-CommandAst content like bare
  // `$env:SECRET` inside control flow. Example attack: user approves
  // Get-Process, then `if ($true) { Get-Process; $env:SECRET }` — Get-Process
  // is allow-ruled (continue, no push), $env:SECRET is VariableExpressionAst
  // (not a sub-command), statement marked seen → gate skips → auto-allow →
  // secret leaks. Tracking on push only: statement stays unseen → gate fires
  // → ask.
  const statementsSeenInLoop = new Set<
    ParsedPowerShellCommand['statements'][number]
  >()

  for (const { text: subCmd, element, statement } of subCommands) {
// 每个子命令：先查用户规则（用户规则优先于内置白名单）。
    // Check deny rules FIRST - user explicit rules take precedence over allowlist
    const subInput = { command: subCmd }
    const subResult = powershellToolCheckPermission(
      subInput,
      toolPermissionContext,
    )

    if (subResult.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: `Permission to use ${POWERSHELL_TOOL_NAME} with command ${command} has been denied.`,
        decisionReason: subResult.decisionReason,
      }
    }

    if (subResult.behavior === 'ask') {
      if (statement !== null) {
        statementsSeenInLoop.add(statement)
      }
      subCommandsNeedingApproval.push(subCmd)
      continue
    }

// 用户规则放行 —— 但**脚本/可执行程序除外**（对应上方英文注释）：
// scripts\Get-Content 会被剥成 Get-Content 从而命中 `Get-Content:*` 的 allow 规则，
// 实际跑的是本地脚本。所以必须加 nameType 闸门。
    // Explicitly allowed by a user rule — BUT NOT for applications/scripts.
    // SECURITY: INPUT-side stripModulePrefix is unconditional, so
    // `scripts\Get-Content /etc/shadow` strips to 'Get-Content' and matches
    // an allow rule `Get-Content:*`. Without the nameType guard, continue
    // skips all checks and the local script runs. nameType is classified from
    // the RAW name pre-strip — `scripts\Get-Content` → 'application' (has `\`).
    // Module-qualified cmdlets also classify 'application' — fail-safe over-fire.
    // An application should NEVER be auto-allowed by a cmdlet allow rule.
    if (
      subResult.behavior === 'allow' &&
      element.nameType !== 'application' &&
      !hasSymlinkCreate
    ) {
// 用户放行的是**这个 cmdlet**，不等于放行了「通过它展开任意变量」。
// 放行 `PowerShell(Write-Output:*)` 的人显然不想自动放行 `Write-Output $env:API_KEY`。
// 所以这里要再跑一遍 argLeaksValue —— 与内置白名单路径用同一把尺子。
      // SECURITY: User allow rule asserts the cmdlet is safe, NOT that
      // arbitrary variable expansion through it is safe. A user who allows
      // PowerShell(Write-Output:*) did not intend to auto-allow
      // `Write-Output $env:ANTHROPIC_API_KEY`. Apply the same argLeaksValue
      // gate that protects the built-in allowlist path below — rejects
      // Variable/Other/ScriptBlock/SubExpression elementTypes and colon-bound
      // expression children. (security finding #32)
      //
      // SECURITY: Also skip when the compound contains a symlink-creating
      // command (finding — symlink+read gap). New-Item -ItemType SymbolicLink
      // can redirect subsequent reads to arbitrary paths. The built-in
      // allowlist path (below) and acceptEdits path both gate on
      // !hasSymlinkCreate; the user-rule path must too.
      if (argLeaksValue(subCmd, element)) {
        if (statement !== null) {
          statementsSeenInLoop.add(statement)
        }
        subCommandsNeedingApproval.push(subCmd)
        continue
      }
      continue
    }
    if (subResult.behavior === 'allow') {
      // nameType === 'application' with a matching allow rule: the rule was
      // written for a cmdlet, but this is a script/executable masquerading.
      // Don't continue; fall through to approval (NOT deny — the user may
      // actually want to run `scripts\Get-Content` and will see a prompt).
      if (statement !== null) {
        statementsSeenInLoop.add(statement)
      }
      subCommandsNeedingApproval.push(subCmd)
      continue
    }

// fail-closed 闸门：只有「整条语句是 PipelineAst 且每个元素都是 CommandAst」
// 才敢走白名单快捷放行。它会挡住：
//   `'env:SECRET' | Get-Content`（表达式源）、`$x = Get-Process`（赋值）、
//   `Get-Process && Get-Service`（&& 链）、以及任何将来的新 AST 类型。
// 另外还有 cwd 失同步（hasCdSubCommand）与链接（hasSymlinkCreate）两个闸门。
    // SECURITY: fail-closed gate. Do NOT take the allowlist shortcut unless
    // the parent statement is a PipelineAst where every element is a
    // CommandAst. This subsumes the previous hasExpressionSource check
    // (expression sources are one way a statement fails the gate) and also
    // rejects assignments, chain operators, control flow, and any future
    // AST type by construction. Examples this blocks:
    //   'env:SECRET_API_KEY' | Get-Content  — CommandExpressionAst element
    //   $x = Get-Process                   — AssignmentStatementAst
    //   Get-Process && Get-Service         — PipelineChainAst
    // Explicit user allow rules (above) run before this gate but apply their
    // own argLeaksValue check; both paths now gate argument elementTypes.
    //
    // SECURITY: Also skip when the compound contains a cwd-changing cmdlet
    // (finding #27 — cd+read gap). isAllowlistedCommand validates Get-Content
    // in isolation, but `Set-Location ~; Get-Content ./.ssh/id_rsa` runs
    // Get-Content from ~, not from the validator's cwd. Path validation saw
    // /project/.ssh/id_rsa; runtime reads ~/.ssh/id_rsa. Same gate as the
    // checkPermissionMode call below and the checkPathConstraints threading.
    if (
      statement !== null &&
      !hasCdSubCommand &&
      !hasSymlinkCreate &&
      isProvablySafeStatement(statement) &&
      isAllowlistedCommand(element, subCmd)
    ) {
      continue
    }

// 再给 acceptEdits 模式一次机会：把**单条语句**包成一个合成 AST 交给
// checkPermissionMode 判定，这样它的所有守卫（表达式源、安全标记、
// ACCEPT_EDITS_ALLOWED_CMDLETS 白名单）都会生效 —— 判定逻辑只有一份。
// splatting 用整条命令的变量（parsed.variables）传入：搞不清影响哪一句，就当影响全部。
// 同样要排除 hasCdSubCommand（合成 AST 丢掉了复合上下文，看不见别的语句里的 cd）。
    // Check per-sub-command acceptEdits mode (BashTool parity).
    // Delegate to checkPermissionMode on a single-statement AST so that ALL
    // of its guards apply: expression pipeline sources (non-CommandAst elements),
    // security flags (subexpressions, script blocks, assignments, splatting, etc.),
    // and the ACCEPT_EDITS_ALLOWED_CMDLETS allowlist. This keeps one source of
    // truth for what makes a statement safe in acceptEdits mode — any future
    // hardening of checkPermissionMode automatically applies here.
    //
    // Pass parsed.variables (not []) so splatting from any statement in the
    // compound command is visible. Conservative: if we can't tell which statement
    // a splatted variable affects, assume it affects all of them.
    //
    // SECURITY: Skip this auto-allow path when the compound contains a
    // cwd-changing command (Set-Location/Push-Location/Pop-Location). The
    // synthetic single-statement AST strips compound context, so
    // checkPermissionMode cannot see the cd in other statements. Without this
    // gate, `Set-Location ./.claude; Set-Content ./settings.json '...'` would
    // pass: Set-Content is checked in isolation, matches ACCEPT_EDITS_ALLOWED_CMDLETS,
    // and auto-allows — but PowerShell runs it from the changed cwd, writing to
    // .claude/settings.json (a Claude config file the path validator didn't check).
    // This matches BashTool's compoundCommandHasCd guard.
    if (statement !== null && !hasCdSubCommand && !hasSymlinkCreate) {
      const subModeResult = checkPermissionMode(
        { command: subCmd },
        {
          valid: true,
          errors: [],
          variables: parsed.variables,
          hasStopParsing: parsed.hasStopParsing,
          originalCommand: subCmd,
          statements: [statement],
        },
        toolPermissionContext,
      )
      if (subModeResult.behavior === 'allow') {
        continue
      }
    }

    // Not allowlisted, no mode auto-allow, and no explicit rule — needs approval
    if (statement !== null) {
      statementsSeenInLoop.add(statement)
    }
    subCommandsNeedingApproval.push(subCmd)
  }

// fail-closed 闸门的**后半段**：上面循环只处理「被收集到且没被过滤掉」的子命令。
// 那些「一个 CommandAst 都没产生」的语句（比如裸的 $env:SECRET）或
// 「唯一子命令被当成纯输出过滤掉」的语句（$env:X | Out-String）根本进不了循环 ——
// 不补这一步它们就会在「待审批列表为空」时被静默放行。
// 只补**未被标记**的语句：已被推入待审批的就不要再推一遍（否则会出现重复建议）。
  // SECURITY: fail-closed gate (second half). The step-5 loop above only
  // iterates sub-commands that getSubCommandsForPermissionCheck surfaced
  // AND survived the safe-output filter. Statements that produce zero
  // CommandAst sub-commands (bare $env:SECRET) or whose only sub-commands
  // were filtered as safe-output ($env:X | Out-String) never enter the loop.
  // Without this, they silently auto-allow on empty subCommandsNeedingApproval.
  //
  // Only push statements NOT tracked above: if the loop PUSHED any
  // sub-command from a statement, the user will see a prompt. Pushing the
  // statement text too creates a duplicate suggestion where accepting the
  // sub-command rule does not prevent re-prompting.
  // If all sub-commands `continue`d (allow-ruled / allowlisted / mode-allowed)
  // the statement is NOT tracked and the gate re-checks it below — this is
  // the fail-closed property.
  for (const stmt of parsed.statements) {
    if (!isProvablySafeStatement(stmt) && !statementsSeenInLoop.has(stmt)) {
      subCommandsNeedingApproval.push(stmt.text)
    }
  }

// 待审批列表为空 → 放行。但还有一个例外（对应上方英文注释）：
// 如果管道里有**脚本块**，而所有纯输出 cmdlet 都已被过滤掉，
// 那脚本块的**内容**其实从未被校验（非命令节点对遍历器不可见）。
// 例：`Where-Object {$true} | Sort-Object {$env:PATH='evil'}` 就会被误放行。
// 所以这种情况下要 ask 而不是 allow。
  if (subCommandsNeedingApproval.length === 0) {
    // SECURITY: empty-list auto-allow is only safe when there's nothing
    // unverifiable. If the pipeline has script blocks, every safe-output
    // cmdlet was filtered at :1032, but the block content wasn't verified —
    // non-command AST nodes (AssignmentStatementAst etc.) are invisible to
    // getAllCommands. `Where-Object {$true} | Sort-Object {$env:PATH='evil'}`
    // would auto-allow here. hasAssignments is top-level-only (parser.ts:1385)
    // so it doesn't catch nested assignments either. Prompt instead.
    if (deriveSecurityFlags(parsed).hasScriptBlocks) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
        decisionReason: {
          type: 'other',
          reason:
            'Pipeline consists of output-formatting cmdlets with script blocks — block content cannot be verified',
        },
      }
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'All pipeline commands are individually allowed',
      },
    }
  }

// 还有子命令需要审批 → 返回 passthrough（框架据此弹框），
// 并把「一键放行」的建议一并带上。
  // 6. Some sub-commands need approval — build suggestions
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }

  const pendingSuggestions: PermissionUpdate[] = []
  for (const subCmd of subCommandsNeedingApproval) {
    pendingSuggestions.push(...suggestionForExactCommand(subCmd))
  }

  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: pendingSuggestions,
  }
}
