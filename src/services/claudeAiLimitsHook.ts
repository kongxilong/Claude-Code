/**
 * ============================================================================
 *  【文件总览】src/services/claudeAiLimitsHook.ts —— 额度信息的 React Hook
 * ============================================================================
 *
 *  一句话定位：
 *  一个 React Hook（自定义 Hook），让任意 UI 组件都能随时读到**当前订阅额度**，
 *  并且额度一变就自动触发组件重渲染。是「后台数据」到「界面」的桥。
 *
 *  在架构中的位置：
 *      React 组件（如状态栏、额度提示条）
 *        └─> const limits = useClaudeAiLimits()
 *                                                          ← ★ 本文件
 *              └─> statusListeners.add(listener)   ← ./claudeAiLimits.js
 *                    （订阅额度变化；额度是该模块在后台轮询/推送更新的）
 *
 *  与 claudeAiLimits.ts 的分工（务必分清）：
 *      claudeAiLimits.ts      →  **数据侧**：负责去服务端取额度、缓存、维护监听器集合
 *      本文件（...Hook.ts）    →  **UI 侧**：只负责「订阅 + 触发重渲染」，不含任何业务逻辑
 *  这是 React 里非常标准的「把命令式数据订阅包装成声明式 Hook」的做法。
 *
 *  本文件包含什么：
 *   1. useClaudeAiLimits()  唯一导出：返回当前额度对象
 *
 * ---------------------------------------------------------------------------
 *  【核心机制：三件事缺一不可】
 * ---------------------------------------------------------------------------
 *  ① `{ ...currentLimits }`  —— 用展开运算符**复制**一份对象作为初始 state。
 *     为什么不能直接 `useState(currentLimits)`：
 *     那样 state 会和模块里的全局对象**共享同一个引用**。
 *     一旦后台代码原地修改那个对象，React 会发现「引用没变」从而**不重渲染**，
 *     界面就会一直显示旧数据——这是 React 里最经典的坑之一。
 *     复制一份新对象，配合下面 ② 的「每次都造新对象」，才能保证 React 感知到变化。
 *
 *  ② `setLimits({ ...newLimits })` —— 收到新额度时也复制一份再 set。
 *     原因同上：React 靠「引用是否变化」判断要不要重渲染（浅比较），
 *     传同一个对象进去等于什么都没发生。
 *
 *  ③ `useEffect` 的返回函数里 `statusListeners.delete(listener)` —— **清理副作用**。
 *     组件卸载时必须退订，否则监听器会越堆越多（内存泄漏），
 *     而且会去 setState 一个已经不存在的组件。
 *     ≈ Java 里在 finally 或 @PreDestroy 里注销监听器，是同样的纪律。
 *
 *  【为什么 useEffect 的依赖数组是空的 `[]`】
 *  空数组 = 「只在组件挂载时执行一次，卸载时清理一次」。
 *  ≈ React 版的「初始化 / 销毁」钩子。如果漏了这个 `[]`，
 *  每次渲染都会重新订阅一遍，监听器数量爆炸式增长。
 *
 * ---------------------------------------------------------------------------
 *  【TS / React 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `useState<ClaudeAILimits>(初值)`  泛型 Hook。
 *      ≈ Java 的 `AtomicReference<ClaudeAILimits>`，但自带「变更即通知重渲染」的能力。
 *      返回值是**数组解构** `[limits, setLimits]`：第 0 项是当前值，第 1 项是 setter。
 *
 *  - `useEffect(() => { ...setup...; return () => {...cleanup...} }, [])`
 *      副作用钩子。setup 在挂载后跑，返回的 cleanup 在卸载前跑。
 *      ≈ Java 的 `@PostConstruct` + `@PreDestroy` 写在一个 lambda 里。
 *
 *  - `(newLimits: ClaudeAILimits) => { setLimits(...) }`  箭头函数 ≈ lambda
 *
 *  - `statusListeners` 是一个 `Set`（集合）。`.add()` 订阅、`.delete()` 退订。
 *      ≈ Java 的 `Set<Consumer<ClaudeAILimits>>`，天然去重。
 *
 *  - 自定义 Hook 的命名约定：必须以 `use` 开头，
 *      React 靠这个约定来启用 Hook 的静态检查规则。
 *
 *  - `export function useXxx(): ClaudeAILimits`  返回类型写在括号后面（TS 通例）
 * ============================================================================
 */
import { useEffect, useState } from 'react'
import {
  type ClaudeAILimits,
  currentLimits,
  statusListeners,
} from './claudeAiLimits.js'

/**
 * 订阅并在额度变化时返回最新的订阅额度对象。
 *
 * 为什么需要：额度是后台异步更新的（服务端推送/轮询），
 * UI 不能每次要用都去现查一次，而应该「订阅一次，自动跟随」。
 *
 * 关键步骤：
 *   ① 以 currentLimits 的**副本**作为初始 state（避免共享引用导致不重渲染）
 *   ② 挂载时把 listener 加进 statusListeners，额度一变就被回调
 *   ③ 回调里用副本 setLimits，触发 React 重渲染
 *   ④ 卸载时 delete 掉 listener，防止内存泄漏
 *
 * @returns 当前的额度快照（ClaudeAILimits）
 */
export function useClaudeAiLimits(): ClaudeAILimits {
  const [limits, setLimits] = useState<ClaudeAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: ClaudeAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
