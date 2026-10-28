import { feature } from 'bun:bundle'

/**
 * ============================================================================
 *  【文件总览】teamMemSecretGuard.ts —— 团队记忆的「写前密钥闸门」
 * ============================================================================
 *
 *  一句话定位：
 *  在模型（AI）往团队记忆文件里**写内容的那一刻**拦住它，
 *  防止它把 API key、token 之类的密钥写进去 —— 因为团队记忆会同步给仓库的所有协作者。
 *
 *  【为什么必须有这道闸门？（本目录最重要的安全理由）】
 *
 *      模型写代码时，有时会"顺手"把某个 key 贴进 Markdown 笔记里，
 *      比如："调试时用的 key：sk-ant-xxxxxxx，记得用完删掉"。
 *
 *      如果这是**本地**记忆，顶多是你自己看到；
 *      但这是**团队记忆** —— 它会自动同步给仓库的**每一个协作者**。
 *
 *      结果：一次无心的写入 = 一次**全员可见的密钥泄露**，
 *      而且密钥还会被写进服务端的记忆历史里，删本地文件都删不干净。
 *
 *      所以必须在**写入前**（而不是同步时）就拦住。这就是本文件的唯一职责。
 *
 *  【三道防线：本文件只是其中第一道】
 *
 *      ① 写前闸门  ← ★ 本文件：FileWriteTool / FileEditTool 在实际落盘前调用
 *                      好处：拦得最早，模型能立刻知道"这样写不行"并改正
 *      ② 推送前扫描 ← secretScanner.ts（见该文件的注释）
 *                      好处：兜底。万一有文件绕过了 ①（比如用户手工创建的文件）也能拦住
 *      ③ 服务端校验 ← 后端自己做
 *                      好处：最后一道，防止被篡改的客户端绕过前两道
 *      这是典型的**纵深防御（defense in depth）**：不指望任何单点万无一失。
 *
 *  【在架构中的位置】
 *
 *      FileWriteTool / FileEditTool 的 validateInput()
 *        └─> checkTeamMemSecrets(filePath, content)   ← ★ 本文件唯一导出
 *              ├─> isTeamMemPath()    判断这个路径是不是团队记忆目录
 *              └─> scanForSecrets()   真正扫描内容（secretScanner.ts）
 *
 *  【本文件包含什么】
 *   只有一个函数 checkTeamMemSecrets()：命中密钥返回错误文案，安全则返回 null。
 *
 *  【TS 语法速查】（针对本文件实际出现的语法）
 *
 *   - `feature('TEAMMEM')`  —— **编译期**开关，不是运行时 if！
 *       打包时会被替换成字面量 true/false，再被 tree-shaking 掉，
 *       于是整段代码从产物里彻底消失。
 *       ≈ Java 没有；近似 C 的 `#ifdef TEAMMEM`。
 *       用途：某些发行版不带团队记忆功能，那就连扫描代码都不该打进去（省体积）。
 *
 *   - `require('...')`  运行时同步加载模块（CommonJS 风格）。
 *       为什么这里不用文件顶部的 import，而要写在 if 里面用 require？
 *       两个原因：
 *         ① 这两个模块只在 feature 开启时才需要，写在顶部 import 会让打包器
 *            无论如何都把它们打进来，破坏 tree-shaking；
 *         ② require 是**延迟到执行时才加载**，配合 feature 判断正好。
 *       ≈ Java 的 Class.forName("...") 反射加载，而不是编译期 import。
 *
 *   - `as typeof import('...')`  类型断言。
 *       因为 require() 返回 any（没有类型），用 as 把它"掰回"正确的类型，
 *       这样后面的 .label 等属性才有类型提示。
 *       ≈ Java 的强制类型转换 `(TeamMemPaths) obj`，运行时不检查。
 *
 *   - `string | null`  返回"错误信息 或 null"。
 *       这是本仓库表达"可能失败"的常用约定：null 表示通过。
 *       ≈ Java 里返回 Optional<String> 或直接返回 null（但 TS 编译器会强制你处理 null）。
 *
 *   - `matches.map(m => m.label).join(', ')`  链式处理：
 *       map 取出每项的 label（≈ stream().map()），join 拼成逗号分隔字符串
 *       （≈ Java 的 String.join(", ", list)）。
 */

/**
 * Check if a file write/edit to a team memory path contains secrets.
 * Returns an error message if secrets are detected, or null if safe.
 *
 * This is called from FileWriteTool and FileEditTool validateInput to
 * prevent the model from writing secrets into team memory files, which
 * would be synced to all repository collaborators.
 *
 * Callers can import and call this unconditionally — the internal
 * feature('TEAMMEM') guard keeps it inert when the build flag is off.
 * secretScanner assembles sensitive prefixes at runtime (ANT_KEY_PFX).
 *
 * 【中文补充】检查"即将写入团队记忆的内容"是否含密钥。
 *
 * @param filePath 要写入的文件路径（先判断是否属于团队记忆目录）
 * @param content  即将写入的完整内容（对 FileEdit 来说是编辑后的最终内容）
 * @returns 含密钥 → 返回一段**给模型看**的错误文案（模型会据此改写）；
 *          安全 → 返回 null 放行
 *
 * 关键步骤：
 *   ① feature('TEAMMEM') 编译期开关：功能没编译进来就直接放行（return null）
 *   ② 用 require 动态加载两个依赖模块（为了不破坏 tree-shaking）
 *   ③ isTeamMemPath 判断路径：不是团队记忆目录 → 直接放行
 *      （普通文件不该被这道闸门管，否则会误伤用户正常写代码）
 *   ④ scanForSecrets 扫描内容：没命中 → 放行
 *   ⑤ 命中 → 拼一句**有解释**的错误文案返回
 *
 * 【为什么返回的是"文案"而不是"布尔值"？】
 *   因为调用方是**模型的工具入参校验**。返回文案，模型就能读到
 *   "含疑似密钥（github-pat），团队记忆会共享给所有协作者，请去掉敏感内容后重试"，
 *   从而**理解原因并自我修正**（比如改成 `token: <从环境变量读取>`）；
 *   如果只返回 false，模型只会一头雾水地重试同样的内容。
 *   给 AI 的反馈必须自带解释，这是 Agent 开发的重要经验。
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
): string | null {
  if (feature('TEAMMEM')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    // 【中文】动态 require：只有 feature 开启的构建里才会走到这，
    // 这样未开启时这两个模块能被 tree-shaking 完全删掉。
    const { isTeamMemPath } =
      require('../../memdir/teamMemPaths.js') as typeof import('../../memdir/teamMemPaths.js')
    const { scanForSecrets } =
      require('./secretScanner.js') as typeof import('./secretScanner.js')
    /* eslint-enable @typescript-eslint/no-require-imports */

    // 【中文】只管团队记忆目录。其他路径一律放行，避免误伤正常的文件写入。
    if (!isTeamMemPath(filePath)) {
      return null
    }

    const matches = scanForSecrets(content)
    if (matches.length === 0) {
      return null
    }

    // 【中文】只把"命中了哪类规则"（label）放进提示，**绝不包含密钥原文** ——
    // 否则这段提示本身就会成为新的泄露源（它会被写进对话历史）。
    const labels = matches.map(m => m.label).join(', ')
    return (
      `Content contains potential secrets (${labels}) and cannot be written to team memory. ` +
      'Team memory is shared with all repository collaborators. ' +
      'Remove the sensitive content and try again.'
    )
  }
  // 【中文】功能未编译进来 → 恒放行（等于这道闸门不存在）
  return null
}
