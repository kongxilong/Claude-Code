/**
 * ============================================================================
 *  【文件总览】src/services/internalLogging.ts —— 内部（员工）环境的诊断埋点
 * ============================================================================
 *
 *  一句话定位：
 *  只在 Anthropic **内部员工**环境（USER_TYPE === 'ant'）下生效的一组诊断信息采集：
 *  读出当前运行的 K8s 命名空间、容器 ID，连同工具权限上下文一起上报，
 *  用来排查「为什么某个用户的权限系统表现异常」这类问题。
 *
 *  在架构中的位置：
 *      src/Tool.ts / 权限初始化流程
 *        └─> logPermissionContextForAnts(ctx, 'initialization' | 'summary')
 *                                                          ← ★ 本文件
 *              ├─> getKubernetesNamespace()   读 /var/run/secrets/kubernetes.io/.../namespace
 *              ├─> getContainerId()           读 /proc/self/mountinfo 做正则匹配
 *              └─> logEvent('tengu_internal_record_permission_context', {...})
 *                                                          ← src/services/analytics/index.js
 *
 *  本文件包含什么：
 *   1. getKubernetesNamespace()    读 K8s 命名空间的内部函数（未导出）
 *   2. getContainerId()            从 mountinfo 里解析容器 ID（导出）
 *   3. logPermissionContextForAnts()  对外唯一入口：上报「权限上下文 + 环境信息」
 *
 *  【设计意图：为什么满文件都是 `if (USER_TYPE !== 'ant') return`】
 *  这是**成本与隐私的双重闸门**。三个函数开头都先判一次：
 *    - 普通用户的机器上，USER_TYPE 不是 'ant'，函数立刻返回 null/void，
 *      不读磁盘、不序列化、不上报——零开销，也绝不外发任何数据；
 *    - 只有内部环境才真正执行。
 *  好处：把「该不该采集」的判断收敛在**一处**，调用方可以无条件调用而不用自己判环境。
 *  ≈ Java 里在方法第一行写 `if (!isInternal()) return;` 的卫语句（guard clause）。
 *
 *  【踩过的坑：为什么「找不到」时返回一个可读字符串而不是 null】
 *  注意 getKubernetesNamespace() 失败时返回字符串 `'namespace not found'`，
 *  而不是 null 或 undefined。这是刻意的：上报字段要是 null，
 *  在日志系统里往往直接被丢弃、看不出「到底是没跑在 K8s 里，还是读文件失败了」。
 *  返回一个人类可读的标记串，排查时能一眼区分「环境不符」与「读取异常」。
 *  ≈ Java 日志里用 `Optional.ofNullable(x).orElse("NOT_FOUND")`，但这里连 Optional 都省了。
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `memoize(async (): Promise<string | null> => {...})`
 *      lodash 的 memoize：**缓存函数结果**，同一入参第二次调用直接返回缓存。
 *      ≈ Java 的 `Map<Key, Result>` 手搓缓存，或 Guava `Suppliers.memoize`。
 *      为什么要用：这两个函数都要读 /proc、/var/run 下的文件，
 *      属于「进程生命周期内不会变」的信息，没必要每次上报都读一遍磁盘。
 *
 *  - `string | null`  联合类型。≈ Java 的 sealed interface 两实现，
 *      或简单理解成 `@Nullable String`。编译器会**强制**你先判空才能用。
 *
 *  - `catch { ... }`  可选 catch 绑定（ES2019+）。
 *      ≈ Java 的 `catch (Exception e) {}` 但**省略了变量名**——
 *      因为这里压根不关心异常内容，只关心「失败了」这一事实。
 *      Java 从 JDK 21 起没有等价写法，只能写 `catch (Exception ignored) {}`。
 *
 *  - `const match = line.match(pattern)` 返回 `RegExpMatchArray | null`
 *      `match[1]` 取第 1 个**捕获组**（`match[0]` 是整条匹配）。
 *      ≈ Java 的 `matcher.group(1)`。注意必须写成 `match && match[1]` 才算判了空。
 *
 *  - `x as SomeType`  类型断言 ≈ Java 的强制类型转换 `(SomeType) x`，
 *      运行时不做任何检查，纯粹骗编译器。
 *      本文件里那些长得离谱的 `as AnalyticsMetadata_I_VERIFIED_...` 是
 *      **内部埋点字段的合规标记**：字段名本身就在提醒写代码的人
 *      「我确认这不是代码、也不是文件路径」，防止误把用户源码/路径上传。
 *
 *  - `moment: 'summary' | 'initialization'`  字符串字面量联合类型。
 *      ≈ Java 的 enum，但只是编译期约束的字符串，运行时就是普通字符串。
 *
 *  - `void logEvent(...)`  前面加 void = 「我知道它返回 Promise，但故意不 await」。
 *      ≈ Java 的 executor.submit() 但不 get()，发射后不管（fire-and-forget）。
 *      为什么：埋点不该拖慢主流程，更不该因为埋点失败而让权限初始化卡住。
 * ============================================================================
 */
import { readFile } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import type { ToolPermissionContext } from '../Tool.js'
import { jsonStringify } from '../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from './analytics/index.js'

/**
 * Get the current Kubernetes namespace:
 * Returns null on laptops/local development,
 * "default" for devboxes in default namespace,
 * "ts" for devboxes in ts namespace,
 * ...
 */
// 中文说明：下面这段英文注释的意思是——取当前 K8s 命名空间；
// 笔记本/本地开发返回 null，devbox 里返回 "default"/"ts" 等具体命名空间名。
// 无论成功失败，结果都会被 memoize 缓存，整个进程只读一次磁盘。
const getKubernetesNamespace = memoize(async (): Promise<string | null> => {
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  const namespacePath =
    '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
  const namespaceNotFound = 'namespace not found'
  try {
    const content = await readFile(namespacePath, { encoding: 'utf8' })
    return content.trim()
  } catch {
    return namespaceNotFound
  }
})

/**
 * Get the OCI container ID from within a running container
 */
/**
 * 从运行中的容器里取出自己的容器 ID。
 *
 * 为什么需要：内部环境里同一份代码会跑在成千上万个容器里，
 * 排查问题时必须定位到「到底是哪个容器」，所以要把容器 ID 一起上报。
 *
 * 怎么拿到的：Linux 的 /proc/self/mountinfo 记录了当前进程的所有挂载点，
 * 容器运行时（Docker / containerd / CRI-O）会在里面留下带容器 ID 的路径。
 * 这是容器内**无需额外权限**、只靠读 /proc 就能自证身份的标准做法。
 *
 * @returns 64 位十六进制的容器 ID；非内部环境或读不到时返回 null。
 */
export const getContainerId = memoize(async (): Promise<string | null> => {
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  const containerIdPath = '/proc/self/mountinfo'
  const containerIdNotFound = 'container ID not found'
  const containerIdNotFoundInMountinfo = 'container ID not found in mountinfo'
  try {
    const mountinfo = (
      await readFile(containerIdPath, { encoding: 'utf8' })
    ).trim()

    // 中文补注：这条正则要同时兼容两种容器运行时——
    //   Docker     的路径形如 /docker/containers/<64位十六进制ID>
    //   containerd 的路径形如 /sandboxes/<64位十六进制ID>
    // `(?:...)` 是「非捕获组」：只用来分组，不占用 match[1] 的位置，
    // 这样第 1 个捕获组就稳定地是容器 ID 本身。
    // Pattern to match both Docker and containerd/CRI-O container IDs
    // Docker: /docker/containers/[64-char-hex]
    // Containerd: /sandboxes/[64-char-hex]
    const containerIdPattern =
      /(?:\/docker\/containers\/|\/sandboxes\/)([0-9a-f]{64})/

    const lines = mountinfo.split('\n')

    for (const line of lines) {
      const match = line.match(containerIdPattern)
      if (match && match[1]) {
        return match[1]
      }
    }

    return containerIdNotFoundInMountinfo
  } catch {
    return containerIdNotFound
  }
})

/**
 * Logs an event with the current namespace and tool permission context
 */
/**
 * 上报「工具权限上下文 + 运行环境信息」，仅对内部员工生效。
 *
 * 为什么需要：权限系统（哪些工具能用、要不要问用户）是 Claude Code 里
 * 最容易出疑难杂症的地方——同样的配置在不同人机器上表现不同。
 * 把**完整权限上下文**连同环境标识一起打点，才能在事后还原现场。
 *
 * 关键步骤：
 *   ① 环境闸门：非内部用户直接 return，零开销、零外发（隐私考虑）
 *   ② 采集命名空间 / 容器 ID（两者都有缓存，不会重复读磁盘）
 *   ③ 把权限上下文序列化成 JSON 字符串
 *   ④ 通过 logEvent 异步上报；用 void 明确「不 await」，绝不阻塞调用方
 *
 * @param toolPermissionContext 当前生效的工具权限配置；尚未初始化时为 null
 * @param moment 上报时机：'initialization' = 刚初始化完；'summary' = 会话结束时的汇总
 */
export async function logPermissionContextForAnts(
  toolPermissionContext: ToolPermissionContext | null,
  moment: 'summary' | 'initialization',
): Promise<void> {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  void logEvent('tengu_internal_record_permission_context', {
    moment:
      moment as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    namespace:
      (await getKubernetesNamespace()) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    toolPermissionContext: jsonStringify(
      toolPermissionContext,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    containerId:
      (await getContainerId()) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}
