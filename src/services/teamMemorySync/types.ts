/**
 * Team Memory Sync Types
 *
 * Zod schemas and types for the repo-scoped team memory sync API.
 * Based on the backend API contract from anthropic/anthropic#250711.
 */

/**
 * ============================================================================
 *  【文件总览】teamMemorySync/types.ts —— 团队记忆同步的「数据契约」
 * ============================================================================
 *
 *  一句话定位：
 *  本文件只定义**数据形状**（用 Zod schema 描述）和类型别名，**不含任何逻辑**。
 *  它是客户端与后端 /api/claude_code/team_memory 接口之间的合同。
 *
 *  【团队记忆（team memory）是什么？】
 *   一个**仓库级别、团队共享**的 Markdown 笔记集合。
 *   比如 "这个项目用 Gradle 不用 Maven"、"发布流程要点"、"常见坑"，
 *   写一次，团队所有人下次打开 Claude Code 都能读到 —— 不用每个人都重新摸索。
 *   类比 Java：≈ 团队 wiki 的一页，或者 .editorconfig / checkstyle 配置这种
 *   "写一次全队受益"的共享知识文件。
 *   与普通 settings 的区别：memory 存的是**给 AI 看的背景知识**（自然语言），
 *   settings 存的是**给程序看的配置**（结构化键值）。
 *
 *  【在架构中的位置】
 *
 *      index.ts     同步主逻辑（拉/推/冲突处理）  ← 依赖本文件的类型
 *        ├─> watcher.ts      监听本地文件变化，自动触发同步
 *        ├─> secretScanner.ts 推送前扫描密钥      ← 用本文件的 SkippedSecretFile
 *        └─> types.ts       ★ 本文件：所有数据形状的唯一定义处
 *
 *    把类型单独放一个文件，是为了让 index.ts 专注逻辑、这里专注契约，
 *    两边都不会因为对方改动而频繁冲突。
 *
 *  【本文件包含什么】
 *   Schema（Zod，运行时可校验）：
 *     1. TeamMemoryContentSchema        记忆内容本体：entries（路径 → 内容）+ 校验和
 *     2. TeamMemoryDataSchema           接口完整响应（组织、仓库、版本、ETag…）
 *     3. TeamMemoryTooManyEntriesSchema 服务端 413 "条目太多"错误的结构化响应体
 *   类型别名（编译期）：
 *     4. TeamMemoryData / SkippedSecretFile
 *     5. TeamMemorySyncFetchResult      拉取结果（含 404/304 等状态标志）
 *     6. TeamMemoryHashesResult         轻量"只要校验和"的探测结果
 *     7. TeamMemorySyncPushResult       推送结果（含 412 冲突、跳过的密钥文件）
 *     8. TeamMemorySyncUploadResult     上传结果（含服务端 413 错误详情）
 *
 *  【贯穿本文件的两个关键机制】
 *
 *   ① Zod：一个"运行时也能校验的 schema 库"。
 *      为什么需要它？因为 TS 的类型在**编译后就消失了**，
 *      而从网络收到的 JSON 是运行时数据，编译器管不了它长什么样。
 *      Zod 让你写一份 schema，同时得到：
 *        · 运行时校验（不合格式就报错，而不是让脏数据流进系统）
 *        · 编译期类型（z.infer 自动从 schema 推导 TS 类型，不用手写两遍）
 *      ≈ Java 里没有直接对应；可以想成 "Bean Validation 注解 + 自动生成的 DTO 类" 合体，
 *        但 Zod 是普通 JS 对象，不需要注解处理器、不需要代码生成。
 *
 *   ② ETag / checksum：冲突检测的核心。
 *      每次服务端返回内容时带一个 checksum（形如 `sha256:xxxx`）。
 *      客户端下次推送时必须带上"我基于哪个版本改的"，
 *      服务端比对：一致 → 接受；不一致（说明别人先改了）→ 返回 412 冲突。
 *      这就是**乐观锁（optimistic locking）**。
 *      ≈ Java 里给表加一个 @Version 字段，更新时带 version，不匹配就抛
 *        OptimisticLockException —— 完全同一个思路。
 *
 *  【TS 语法速查】（针对本文件实际出现的语法）
 *
 *   - `lazySchema(() => z.object({...}))`
 *       惰性 schema：把定义包在箭头函数里，**用到时才执行**。
 *       为什么？因为多个 schema 可能互相引用（本文件的 Content 被 Data 引用），
 *       如果都在模块加载时立刻求值，可能出现"引用了还没初始化的变量"。
 *       ≈ Java 的懒加载 / Supplier<T>：需要时才 get()。
 *
 *   - `z.record(z.string(), z.string())`
 *       描述"键是 string、值也是 string 的对象"≈ `Map<String, String>`。
 *       本文件里 entries 就是"文件路径 → 文件内容"的映射。
 *
 *   - `z.infer<ReturnType<typeof TeamMemoryDataSchema>>`
 *       从 schema **反推**出 TS 类型。拆开看：
 *         typeof X          取 X 的类型（它是一个函数）
 *         ReturnType<...>   取这个函数返回值的类型
 *         z.infer<...>      从 Zod schema 推导出对应的 TS 类型
 *       效果：schema 改了，类型自动跟着改，永远同步。
 *       ≈ Java 做不到（要么手写 DTO，要么用代码生成）。
 *
 *   - `errorType?: 'auth' | 'timeout' | 'network' | 'parse' | 'unknown'`
 *       可选字段 + 字符串字面量联合类型。
 *       ≈ Java：`private ErrorType errorType;` 其中 ErrorType 是 enum，
 *       但 TS 里它编译后就是普通字符串，更轻。
 *       注意不同 Result 类型的 errorType 成员**不完全一样**
 *       （Push 多了 'conflict'/'no_oauth'/'no_repo'）——
 *       这是刻意的：让类型精确表达"这种情况只可能在这种操作里发生"。
 *
 *   - `?:` 可选属性，等价于 `xxx: T | undefined`。≈ Java 的 @Nullable 字段。
 *
 *   - `z.literal('team_memory_too_many_entries')`
 *       字面量校验：值必须**恰好等于**这个字符串，否则校验失败。
 *       用途：精确识别服务端返回的是哪一种错误码。
 *
 *   - `z.number().int().positive()`
 *       链式校验器，读作"是数字 且 是整数 且 为正"。
 *       ≈ Java 的 `@NotNull @Min(1)` 但作用在值上，且能在运行时真正校验。
 *
 *   - `Record<string, string>`  TS 内置工具类型 ≈ `Map<String, String>`
 *       （实际是普通对象，但按键索引）
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Content portion of team memory data - flat key-value storage.
 * Keys are file paths relative to the team memory directory (e.g. "MEMORY.md", "patterns.md").
 * Values are UTF-8 string content (typically Markdown).
 */
/**
 * Content portion of team memory data - flat key-value storage.
 * Keys are file paths relative to the team memory directory (e.g. "MEMORY.md", "patterns.md").
 * Values are UTF-8 string content (typically Markdown).
 *
 * 【中文补充】团队记忆的**内容部分**：一个扁平的 路径 → 内容 映射。
 *
 * 为什么用"扁平映射"而不是嵌套目录树？
 *   因为 HTTP 接口里传一棵树很麻烦（要递归、要处理空目录），
 *   而扁平的 { "MEMORY.md": "...", "guides/patterns.md": "..." } 一个 JSON 对象就搞定，
 *   路径信息直接编码在 key 里。落盘时再按 key 里的斜杠还原成目录结构。
 *
 * entries        : 文件路径（相对团队记忆目录） → 文件文本内容（一般是 Markdown）
 * entryChecksums : 每个文件内容的 SHA-256（形如 "sha256:abc..."）
 *                  为什么需要它？有了**逐文件**校验和，同步时就能只比较
 *                  "哪个文件变了"，而不必每次都整包比对 —— 这对减少冲突至关重要。
 *                  它为什么是 optional？为了兼容**旧版服务端**（还没这个字段），
 *                  属于向前兼容设计（forward-compat）。
 */
export const TeamMemoryContentSchema = lazySchema(() =>
  z.object({
    entries: z.record(z.string(), z.string()),
    // Per-key SHA-256 of entry content (`sha256:<hex>`). Added in
    // anthropic/anthropic#283027. Optional for forward-compat with older
    // server deployments; empty map when entries is empty.
    entryChecksums: z.record(z.string(), z.string()).optional(),
  }),
)

/**
 * Full response from GET /api/claude_code/team_memory
 *
 * 【中文补充】拉取团队记忆时，服务端返回的**完整响应体**。
 *
 * organizationId / repo : 这份记忆属于哪个组织、哪个仓库
 *                         （团队记忆是**仓库级**的，不是全局的 ——
 *                           不同项目的背景知识本来就不一样）
 * version               : 单调递增的版本号，用来判断谁的新
 * lastModified          : 最后修改时间（ISO 8601 字符串）
 * checksum              : 整份内容的 SHA-256，**当 ETag 用**（乐观锁的版本戳）
 * content               : 真正的记忆内容（见 TeamMemoryContentSchema）
 */
export const TeamMemoryDataSchema = lazySchema(() =>
  z.object({
    organizationId: z.string(),
    repo: z.string(),
    version: z.number(),
    lastModified: z.string(), // ISO 8601 timestamp
    checksum: z.string(), // SHA256 with 'sha256:' prefix
    content: TeamMemoryContentSchema(),
  }),
)

/**
 * Structured 413 error body from the server (anthropic/anthropic#293258).
 * The server's RequestTooLargeException serializes error_code and the
 * extra_details dict flattened into error.details. We only model the
 * too-many-entries case; entry-too-large is handled via MAX_FILE_SIZE_BYTES
 * pre-check on the client side and would need a separate schema.
 *
 * 【中文补充】服务端返回 413（内容太大）时的**结构化错误体**。
 *
 * 为什么需要它：413 有好几种原因（文件太多、单个文件太大、总量超限），
 * 如果只当成一句 "request too large"，用户根本不知道该删文件还是该拆分文件。
 * 解析出具体 error_code 和 max_entries/received_entries，
 * 才能给出"你传了 120 条，上限是 100 条"这种**可行动**的提示。
 *
 * 【"单个文件太大"为什么这里不建模？】
 *   英文注释说明了：那种情况客户端在**推送前**就用 MAX_FILE_SIZE_BYTES 提前拦住了，
 *   根本走不到服务端。所以只有"条目太多"（这个数量只有服务端知道、
 *   而且可能是按组织定制的上限）才需要解析服务端响应。
 */
export const TeamMemoryTooManyEntriesSchema = lazySchema(() =>
  z.object({
    error: z.object({
      details: z.object({
        error_code: z.literal('team_memory_too_many_entries'),
        max_entries: z.number().int().positive(),
        received_entries: z.number().int().positive(),
      }),
    }),
  }),
)

// 【中文】从 schema 自动**推导**出 TS 类型（不用手写一遍），
// 保证"运行时校验规则"和"编译期类型"永远一致。
export type TeamMemoryData = z.infer<ReturnType<typeof TeamMemoryDataSchema>>

/**
 * A file skipped during push because it contains a detected secret.
 * The path is relative to the team memory directory. Only the matched
 * gitleaks rule ID is recorded — never the secret value itself.
 *
 * 【中文补充】因**检测到密钥**而在推送时被跳过的文件。
 *
 * 为什么只记 ruleId 不记密钥内容（这是安全设计的关键）：
 *   这条记录会被写进日志、遥测、UI 提示。如果把匹配到的密钥原文也记下来，
 *   就等于把密钥**复制**到了日志系统里 —— 那密钥扫描就白做了。
 *   所以只记"命中了哪条规则"（如 github-pat、aws-access-token），
 *   既够用户排查（"我的 AWS token 被拦了"），又不泄露任何敏感内容。
 *   类比 Java：日志里打 `password=***` 而不是明文，同一个原则。
 */
export type SkippedSecretFile = {
  path: string
  /** Gitleaks rule ID (e.g., "github-pat", "aws-access-token") */
  ruleId: string
  /** Human-readable label derived from rule ID */
  label: string
}

/**
 * Result from fetching team memory
 *
 * 【中文补充】拉取团队记忆的结果。用**标志位**表达各种"非典型成功"，值得细看：
 *
 *   success=false → 真出错，看 error / errorType / httpStatus
 *   success=true 且 isEmpty=true      → 服务端 404：这份记忆还不存在（**正常情况**，
 *                                        团队第一次用而已，不是错误）
 *   success=true 且 notModified=true  → 服务端 304：带上次的 ETag 问过了，
 *                                        内容没变 → 省掉一次传输（带宽优化）
 *   checksum                          → 响应头里的 ETag，客户端要**存起来**，
 *                                        下次请求带上它才能触发 304 / 做冲突检测
 *   skipRetry                         → 告诉上层"这种错就别重试了"
 *                                        （比如 401 认证失败，重试一百次也没用）
 */
export type TeamMemorySyncFetchResult = {
  success: boolean
  data?: TeamMemoryData
  isEmpty?: boolean // true if 404 (no data exists)
  notModified?: boolean // true if 304 (ETag matched, no changes)
  checksum?: string // ETag from response header
  error?: string
  skipRetry?: boolean
  errorType?: 'auth' | 'timeout' | 'network' | 'parse' | 'unknown'
  httpStatus?: number
}

/**
 * Lightweight metadata-only probe result (GET ?view=hashes).
 * Contains per-key checksums without entry bodies. Used to refresh
 * serverChecksums cheaply during 412 conflict resolution.
 *
 * 【中文补充】**只要元数据**的轻量探测结果（请求 ?view=hashes 时返回）。
 *
 * 为什么需要它（这是本文件最"工程"的一个设计）：
 *   推送遇到 412 冲突时，客户端需要知道"服务端现在到底是什么内容"才能做合并。
 *   但完整拉一次会把所有文件内容都传过来（可能几百 KB），
 *   而合并其实只需要知道**每个文件的校验和**就够了。
 *   所以有了这个"只要哈希"的接口：传输量极小，专门用于解决冲突。
 *
 *   类比：≈ git 里 `git ls-remote` 只要 commit SHA，
 *         而不是把整个仓库 clone 下来。
 */
export type TeamMemoryHashesResult = {
  success: boolean
  version?: number
  checksum?: string
  entryChecksums?: Record<string, string>
  error?: string
  errorType?: 'auth' | 'timeout' | 'network' | 'parse' | 'unknown'
  httpStatus?: number
}

/**
 * Result from uploading team memory with conflict info
 *
 * 【中文补充】推送（push）团队记忆的结果 —— 比上传结果多了两个字段：
 *
 *   filesUploaded   实际推上去几个文件（用于给用户"同步了 N 个文件"的反馈）
 *   skippedSecrets  因含密钥而被**跳过**的文件列表（只含路径和规则名，不含密钥本身）
 *
 * 注意 errorType 比 UploadResult **多了三种**：
 *   'conflict'  412：别人先改了，你的推送基于过期版本（乐观锁冲突）
 *   'no_oauth'  没登录/没授权 → 该引导用户去登录，而不是重试
 *   'no_repo'   当前目录不是一个能识别的 git 仓库 → 团队记忆是仓库级的，
 *               没有仓库就无从归属，这是明确的前置条件缺失
 * 这种"按操作细分错误类型"的做法，让调用方能针对每种情况给出**不同的处理**，
 * 而不是笼统弹一句"同步失败"。
 */
export type TeamMemorySyncPushResult = {
  success: boolean
  filesUploaded: number
  checksum?: string
  conflict?: boolean // true if 412 Precondition Failed
  error?: string
  /** Files skipped because they contain detected secrets (PSR M22174). */
  skippedSecrets?: SkippedSecretFile[]
  errorType?:
    | 'auth'
    | 'timeout'
    | 'network'
    | 'conflict'
    | 'unknown'
    | 'no_oauth'
    | 'no_repo'
  httpStatus?: number
}

/**
 * Result from uploading team memory
 *
 * 【中文补充】单次 HTTP 上传（upload）的结果 —— 是 push 的**底层一步**。
 *
 * 与 PushResult 的区别（两个结果类型并存的原因）：
 *   UploadResult = 一次网络请求的结果（偏"传输层"）
 *   PushResult   = 一次完整推送流程的结果（偏"业务层"，含扫描、跳过文件等）
 * push 内部会调 upload，再把结果加工成 PushResult 往上返回。
 *
 * 下面三个 serverXxx 字段是**服务端 413 错误的详情**（见 TeamMemoryTooManyEntriesSchema）：
 *   serverErrorCode       具体错误码，作为可筛选维度直接进遥测事件
 *   serverMaxEntries      服务端实际的上限（可能是按组织定制的）
 *   serverReceivedEntries 本次合并后会产生多少条（超了才会被拒）
 * 为什么要带回来？因为上限是**服务端定的、且可能每家组织不同**，
 * 客户端缓存住这个值后，下次推送前就能自己先卡一道，避免白跑一趟。
 */
export type TeamMemorySyncUploadResult = {
  success: boolean
  checksum?: string
  lastModified?: string
  conflict?: boolean // true if 412 Precondition Failed
  error?: string
  errorType?: 'auth' | 'timeout' | 'network' | 'unknown'
  httpStatus?: number
  /**
   * Structured error_code from a parsed 413 body (anthropic/anthropic#293258).
   * Currently only 'team_memory_too_many_entries' is modelled; if the server
   * adds more (entry_too_large, total_bytes_exceeded) they'd extend this
   * union.  Passed straight through to the tengu_team_mem_sync_push event
   * as a Datadog-filterable facet.
   */
  serverErrorCode?: 'team_memory_too_many_entries'
  /**
   * Server-enforced max_entries, populated when serverErrorCode is
   * team_memory_too_many_entries. Lets the caller cache the effective
   * (possibly per-org) limit for subsequent pushes.
   */
  serverMaxEntries?: number
  /**
   * How many entries the rejected push would have produced after merge.
   * Populated alongside serverMaxEntries.
   */
  serverReceivedEntries?: number
}
