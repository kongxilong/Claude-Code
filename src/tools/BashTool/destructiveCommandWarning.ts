/**
 * 【一句话定位】用一张正则规则表识别「可能具有破坏性」的 bash 命令，返回一句人类可读的警示文案。
 *   纯展示用途——**不参与任何权限决策**，不会让命令被允许或被拒绝。
 *
 * 【在架构中的位置】
 *   上游：权限弹窗 / UI（拿到文案显示在确认框上，提醒用户看清风险）
 *   下游：无（不 import 任何模块，纯函数 + 常量表）
 *   调用链：权限弹窗 -> getDestructiveCommandWarning(command) -> 显示 Note: ... 提示行
 *
 * 【本文件包含什么】
 *   - DestructivePattern：单条规则的形状（正则 + 警示文案）
 *   - DESTRUCTIVE_PATTERNS：规则表，按 5 大类组织（见文件中分类说明）
 *   - getDestructiveCommandWarning()：唯一导出函数，命中即返回第一条警示
 *
 * 【规则分类逻辑】（理解本目录的关键之一）
 *   ① git 数据丢失类：reset --hard、push --force、clean -f、checkout .、restore .、stash drop/clear、branch -D
 *   ② git 绕过安全检查类：--no-verify（跳过 hook）、--amend（改写已提交历史）
 *   ③ 文件删除类：rm -rf / rm -fr / rm -r / rm -f——真正的危险路径由 checkDangerousRemovalPaths 单独拦截
 *   ④ 数据库类：DROP/TRUNCATE TABLE|DATABASE|SCHEMA、不带条件的 DELETE FROM
 *   ⑤ 基础设施类：kubectl delete、terraform destroy
 *
 * 【TS 语法速查】（本文件实际出现的）
 *   - `type X = { ... }`：结构化类型（鸭子类型）≈ Java record，但按**字段结构**匹配，不要求同一个类
 *   - 正则字面量 `/.../i`：i 是 flag，表示忽略大小写（等价于 Java Pattern.CASE_INSENSITIVE）
 *   - `for (const { pattern, warning } of arr)`：对象解构 + for-of ≈ Java 的 for-each 里顺手取字段
 *   - `string | null`：联合类型，用 null 表示「没命中」（本项目习惯：值缺失用 undefined，显式空用 null）
 *   - 类型标注在变量名**后面**，Java 在前面
 */
/**
 * Detects potentially destructive bash commands and returns a warning string
 * for display in the permission dialog. This is purely informational — it
 * doesn't affect permission logic or auto-approval.
 */

// TS 速查：这种写法叫「类型别名 + 对象类型字面量」，≈ Java 的 record / 一个小 DTO，
// 但 TS 是结构化类型：任何带 pattern 与 warning 两个字段的对象都能当 DestructivePattern 用
type DestructivePattern = {
  pattern: RegExp
  warning: string
}

// 规则表 ≈ Java 的 static final List<Pattern>。设计要点：
//   ① 顺序有意义：命中第一条就返回，所以更具体/更危险的规则排在前面
//   ② 这里**只影响展示**，绝不能反过来影响 allow/deny——否则一条正则写错就会误放行或误拒绝
//   ③ 正则里大量出现 [^;&|\n]*，意思是「只在当前这条子命令内匹配」，
//      防止 `ls; git push --force` 这类组合被误判或漏判（跨分隔符不连读）
const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  // Git — data loss / hard to reverse
  // 中文对照：git 类 —— 会丢失数据、或操作很难撤销
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    warning: 'Note: may discard uncommitted changes',
  },
  {
    // 为什么要先 \bgit\s+push\b 再用 [^;&|\n]* 限定范围：
    //   防止 `echo git push; rm -rf x` 之类把后面的 -f 也算到 git push 头上
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,
    warning: 'Note: may overwrite remote history',
  },
  {
    pattern:
      // (?!...) 是否定前瞻（negative lookahead）：同一条命令里若出现 -n 或 --dry-run（演练模式），
      //   就不算危险——git clean -n 只会打印将要删除的文件，不会真删
      /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    warning: 'Note: may permanently delete untracked files',
  },
  {
    pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: 'Note: may discard all working tree changes',
  },
  {
    pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: 'Note: may discard all working tree changes',
  },
  {
    pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/,
    warning: 'Note: may permanently remove stashed changes',
  },
  {
    pattern:
      /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,
    warning: 'Note: may force-delete a branch',
  },

  // Git — safety bypass
  // 中文对照：git 类 —— 绕过既有安全检查（跳过 hook、改写已提交历史）
  {
    pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,
    warning: 'Note: may skip safety hooks',
  },
  {
    pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/,
    warning: 'Note: may rewrite the last commit',
  },

  // File deletion (dangerous paths already handled by checkDangerousRemovalPaths)
  // 中文对照：文件删除类。注意职责划分——真正危险的路径（如 /、~、$HOME）
  //   由 checkDangerousRemovalPaths 负责拦截；这里只是「提示可能有风险」，不做判决
  {
    pattern:
      // 两个分支分别覆盖 -rf 与 -fr（以及 -Rf、-fR 等大小写变体）：
      //   -[a-zA-Z]*[rR][a-zA-Z]*f 表示「- 后若干字母里含 r，最后以 f 收尾」
      // 用两条分支而不是一条，是因为正则不方便表达「含 r 且含 f、顺序任意」
      /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    warning: 'Note: may recursively force-remove files',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,
    warning: 'Note: may recursively remove files',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/,
    warning: 'Note: may force-remove files',
  },

  // Database
  // 中文对照：数据库类 —— 删表、清库、无 WHERE 的全表删除
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: 'Note: may drop or truncate database objects',
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,
    warning: 'Note: may delete all rows from a database table',
  },

  // Infrastructure
  // 中文对照：基础设施类 —— K8s 资源删除、Terraform 销毁（影响面通常是整个环境）
  {
    pattern: /\bkubectl\s+delete\b/,
    warning: 'Note: may delete Kubernetes resources',
  },
  {
    pattern: /\bterraform\s+destroy\b/,
    warning: 'Note: may destroy Terraform infrastructure',
  },
]

/**
 * Checks if a bash command matches known destructive patterns.
 * Returns a human-readable warning string, or null if no destructive pattern is detected.
 */
/**
 * 【做什么】依次用规则表里的正则去匹配命令，命中就返回对应警示文案
 * 【为什么需要】让用户在确认框里一眼看到「这条命令可能会怎样」，降低误批准概率
 * 【入参】command：待执行的 bash 命令原文
 * 【返回】警示文案字符串；一条都没命中返回 null（调用方判断 `if (warning)` 即可）
 * 【关键步骤】
 *   ① for-of 顺序遍历规则表（≈ stream().filter().findFirst()，命中即止，不继续匹配）
 *   ② pattern.test(command) 做一次匹配（≈ Java Matcher.find 的简化版）
 *   ③ 全部未命中返回 null
 */
export function getDestructiveCommandWarning(command: string): string | null {
  for (const { pattern, warning } of DESTRUCTIVE_PATTERNS) {
    // 命中即返回：规则表按危险程度/常见程度排序，同一次只给用户看最关键的一条，避免刷屏
    if (pattern.test(command)) {
      return warning
    }
  }
  return null
}
