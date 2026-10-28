/**
 * 【一句话定位】把 compactWarningState.ts 里那个「是否抑制警告」的 boolean **桥接到 React**：
 * 让 UI 组件能在它变化时自动重新渲染。
 *
 * 【在架构中的位置】
 * - 上游：React UI 组件（例如显示「距自动压缩还剩 xx% context」的那块 UI）。
 * - 下游：./compactWarningState.js 的 compactWarningStore（纯状态，不含 React）。
 * - 调用链：src/query.ts（主循环）→ compact/microCompact.ts → compactWarningState.ts → 本文件 → React UI
 *
 * 【为什么单独拆一个文件】（关键设计点，原英文注释也提到了）
 * 让 compactWarningState.ts 保持 **React-free**：microCompact.ts 只需要读写一个 boolean，
 * 如果把 `react` 引进那个模块，print 模式（无 UI 的命令行启动路径，最看重启动速度）
 * 的启动过程也会被拖进 React 依赖。所以拆成：
 *   compactWarningState.ts = 纯状态（谁都能 import）
 *   compactWarningHook.ts   = React 绑定（只有 UI 会 import）
 *
 * 【本文件包含什么】
 * - useCompactWarningSuppression()：React Hook，返回当前是否应该抑制警告。
 *
 * 【TS 语法速查】
 * - `import { useSyncExternalStore } from 'react'`：从 npm 包按**具名**导入，≈ Java 的 import 静态成员；
 *   路径 `'react'` 不带 `./`，表示去 node_modules 里找（Java 里没有对应概念，类似自动解析的 classpath）。
 * - Hook 命名约定：以 `use` 开头的函数就是 React Hook，只能在组件 / 其他 Hook 里调用（这是框架硬性规则）。
 * - `useSyncExternalStore(subscribe, getState)`：把外部可变状态接进 React 渲染；
 *   第二、三个参数都是**函数引用**（`compactWarningStore.subscribe` 后面没有括号），
 *   ≈ Java 的方法引用 `store::subscribe`。
 */
import { useSyncExternalStore } from 'react'
import { compactWarningStore } from './compactWarningState.js'

/**
 * React hook to subscribe to compact warning suppression state.
 *
 * Lives in its own file so that compactWarningState.ts stays React-free:
 * microCompact.ts imports the pure state functions, and pulling React into
 * that module graph would drag it into the print-mode startup path.
 */
/**
 * 【React Hook】订阅「是否抑制压缩警告」这个全局开关，返回它的当前值。
 *
 * 为什么需要：压缩警告的显示与否由压缩流程在 React 之外修改，
 * UI 组件必须订阅才能在值变化时自动重渲染（否则界面会一直停留在旧状态）。
 *
 * @returns true = 当前应该抑制警告（刚压缩完、token 计数还不准，先别提示）；
 *         false = 正常显示警告。
 * 关键步骤：① 把 store 的 subscribe / getState 两个方法交给 React
 *          ② React 负责在值变化时触发组件重渲染 ③ 组件卸载时自动取消订阅
 */
export function useCompactWarningSuppression(): boolean {
    // 传的是方法引用（没有括号），不是调用结果——≈ Java 的 store::subscribe / store::getState
  return useSyncExternalStore(
    compactWarningStore.subscribe,
    compactWarningStore.getState,
  )
}
