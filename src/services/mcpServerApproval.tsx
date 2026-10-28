/**
 * ============================================================================
 *  【文件总览】src/services/mcpServerApproval.tsx —— MCP 服务器的「首次使用审批」弹窗
 * ============================================================================
 *
 *  一句话定位：
 *  项目里通过 .mcp.json 声明的 MCP 服务器，第一次被用到时不会自动连上，
 *  而是先弹一个对话框问用户「要不要信任并启用它」。本文件负责把该弹的框弹出来，
 *  并**一直等到用户做出选择才返回**。
 *
 *  在架构中的位置：
 *      src/main.tsx（程序启动早期）
 *        └─> handleMcpjsonServerApprovals(root)            ← ★ 本文件
 *              ├─> getMcpConfigsByScope('project')   ← ./mcp/config.js（读出项目级 MCP 配置）
 *              ├─> getProjectMcpServerStatus(name)   ← ./mcp/utils.js（查每个服务器的状态）
 *              ├─> <MCPServerApprovalDialog>         ← 只有 1 个待审批时用「单选项」弹窗
 *              └─> <MCPServerMultiselectDialog>      ← 有多个待审批时用「多选」弹窗
 *
 *  本文件包含什么：
 *   1. handleMcpjsonServerApprovals()  唯一对外函数：弹框并等待用户确认
 *
 *  【为什么必须先审批？——安全设计】
 *  MCP（Model Context Protocol）服务器本质上是**别人写的、能在你机器上执行的代码**。
 *  项目仓库里的 .mcp.json 可能是别人提交的，如果克隆下来就自动连接执行，
 *  等于「打开陌生仓库就被投毒」。所以设计成：
 *    项目级（project scope）的服务器默认是 pending（待审批）状态，
 *    必须由用户显式批准一次，之后才记住这个决定。
 *  ≈ Java 里第一次访问未知 HTTPS 证书时弹窗让你确认并加入信任库。
 *
 *  【核心技巧：用 Promise 把「UI 交互」变成「可 await 的异步操作」】
 *  这是本文件最值得 Java 工程师学习的一招。弹窗是**事件驱动**的（用户点按钮才继续），
 *  但调用方希望写成顺序代码 `await 弹完框再继续`。
 *  做法：`new Promise<void>(resolve => { ... })` 把 resolve 存进 `done` 回调，
 *  传给弹窗组件；用户点完按钮组件调用 onDone → 触发 resolve → Promise 完成 → await 放行。
 *  ≈ Java 里用 CompletableFuture 包装一个 Swing 对话框的按钮监听：
 *      CompletableFuture<Void> f = new CompletableFuture<>();
 *      button.addActionListener(e -> f.complete(null));
 *      f.get();   // 阻塞等用户点击
 *
 *  【为什么复用外部传入的 root 而不是新建一个】
 *  Ink（终端版 React）一个进程里同时存在多个渲染实例会互相抢终端、把画面刷乱。
 *  所以这里接收 main.tsx 已经创建好的那个 root，直接在它上面 render。
 *  ≈ Java 里 Swing 只允许一个 Event Dispatch Thread，不要自己再起一个。
 *
 * ---------------------------------------------------------------------------
 *  【TS / TSX 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - 文件扩展名 `.tsx`：说明这个文件里有 **JSX**（长得像 HTML 的标记语法）。
 *      ≈ Java 里没有；可以想象成「在代码里直接写 Swing 组件树的字面量」。
 *      `<Foo bar={x} />` 就是 new 一个 Foo 组件并传入 bar 属性。
 *
 *  - `import React from 'react'`  就算代码里没直接写 `React.` 也必须导入，
 *      因为 JSX 编译后会被展开成 `React.createElement(...)`。这是历史包袱。
 *
 *  - `const { servers: projectServers } = getMcpConfigsByScope('project')`
 *      解构赋值 + **重命名**：取出返回对象里的 servers 字段，
 *      并存进名为 projectServers 的变量。≈ Java 21 的记录模式匹配，但日常得多。
 *
 *  - `Object.keys(obj)`  取对象的所有键，返回 string[]。
 *      ≈ Java 的 `map.keySet()`，但结果是数组不是 Set。
 *
 *  - `.filter(name => 条件)`  ≈ stream().filter(...)，返回新数组（不修改原数组）。
 *
 *  - `pendingServers[0] !== undefined`  为什么要这个判断：
 *      TS 开了 `noUncheckedIndexedAccess` 后，数组下标访问的类型是 `T | undefined`，
 *      因为编译器无法证明下标一定存在。这里显式排除 undefined，
 *      之后 `pendingServers[0]` 才能安全地当成 string 用。
 *      ≈ Java 里 list.get(0) 越界会抛异常，而 TS 是**编译期**逼你先检查。
 *
 *  - `const done = (): void => void resolve()`
 *      箭头函数 + 两个 void：外层 `: void` 是返回类型标注，
 *      内层 `void resolve()` 是「执行 resolve() 但丢弃它的返回值」。
 *      为什么要丢弃：resolve() 本身有返回值，而 onDone 要求返回 void。
 *
 *  - `await new Promise<void>(resolve => {...})`
 *      ≈ Java 的 `new CompletableFuture<Void>()` 然后 `.get()`。
 *      注意这里**没有** reject——弹窗不存在「失败」语义，只有「完成」。
 *
 *  - `<AppStateProvider><KeybindingSetup>...</KeybindingSetup></AppStateProvider>`
 *      React 的「Provider 嵌套」写法 ≈ Java 的依赖注入容器层层包裹，
 *      内层组件才能拿到外层提供的 context（全局状态 / 按键绑定）。
 *
 *  - `serverName={serverName}`  JSX 属性用花括号传入 JS 表达式。
 *      字符串要写 `serverName="abc"`，变量必须加 `{}`。
 * ============================================================================
 */
import React from 'react';
import { MCPServerApprovalDialog } from '../components/MCPServerApprovalDialog.js';
import { MCPServerMultiselectDialog } from '../components/MCPServerMultiselectDialog.js';
import type { Root } from '../ink.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { AppStateProvider } from '../state/AppState.js';
import { getMcpConfigsByScope } from './mcp/config.js';
import { getProjectMcpServerStatus } from './mcp/utils.js';

/**
 * Show MCP server approval dialogs for pending project servers.
 * Uses the provided Ink root to render (reusing the existing instance
 * from main.tsx instead of creating a separate one).
 */
/**
 * 中文说明：为所有「待审批」的项目级 MCP 服务器弹出确认框，并等待用户处理完。
 *
 * 为什么需要：克隆别人的仓库后，.mcp.json 里可能声明了任意 MCP 服务器。
 * 直接连上等于执行陌生代码，必须先让用户知情并同意（安全底线）。
 *
 * 关键步骤：
 *   ① 读出 project scope 下的 MCP 配置，筛出状态为 'pending' 的服务器
 *   ② 一个都没有就直接返回（绝大多数项目的常态，零开销）
 *   ③ 把弹窗渲染到外部传入的 Ink root 上（复用实例，避免多实例抢终端）
 *   ④ 用 Promise 挂起，直到用户点完按钮触发 onDone 才 resolve 并放行
 *
 * @param root 由 main.tsx 创建的 Ink 渲染根实例，复用它而不是新建
 */
export async function handleMcpjsonServerApprovals(root: Root): Promise<void> {
  const {
    servers: projectServers
  } = getMcpConfigsByScope('project');
  const pendingServers = Object.keys(projectServers).filter(serverName => getProjectMcpServerStatus(serverName) === 'pending');
  if (pendingServers.length === 0) {
    return;
  }
  await new Promise<void>(resolve => {
    const done = (): void => void resolve();
    if (pendingServers.length === 1 && pendingServers[0] !== undefined) {
      const serverName = pendingServers[0];
      root.render(<AppStateProvider>
          <KeybindingSetup>
            <MCPServerApprovalDialog serverName={serverName} onDone={done} />
          </KeybindingSetup>
        </AppStateProvider>);
    } else {
      root.render(<AppStateProvider>
          <KeybindingSetup>
            <MCPServerMultiselectDialog serverNames={pendingServers} onDone={done} />
          </KeybindingSetup>
        </AppStateProvider>);
    }
  });
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1DUFNlcnZlckFwcHJvdmFsRGlhbG9nIiwiTUNQU2VydmVyTXVsdGlzZWxlY3REaWFsb2ciLCJSb290IiwiS2V5YmluZGluZ1NldHVwIiwiQXBwU3RhdGVQcm92aWRlciIsImdldE1jcENvbmZpZ3NCeVNjb3BlIiwiZ2V0UHJvamVjdE1jcFNlcnZlclN0YXR1cyIsImhhbmRsZU1jcGpzb25TZXJ2ZXJBcHByb3ZhbHMiLCJyb290IiwiUHJvbWlzZSIsInNlcnZlcnMiLCJwcm9qZWN0U2VydmVycyIsInBlbmRpbmdTZXJ2ZXJzIiwiT2JqZWN0Iiwia2V5cyIsImZpbHRlciIsInNlcnZlck5hbWUiLCJsZW5ndGgiLCJyZXNvbHZlIiwiZG9uZSIsInVuZGVmaW5lZCIsInJlbmRlciJdLCJzb3VyY2VzIjpbIm1jcFNlcnZlckFwcHJvdmFsLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBNQ1BTZXJ2ZXJBcHByb3ZhbERpYWxvZyB9IGZyb20gJy4uL2NvbXBvbmVudHMvTUNQU2VydmVyQXBwcm92YWxEaWFsb2cuanMnXG5pbXBvcnQgeyBNQ1BTZXJ2ZXJNdWx0aXNlbGVjdERpYWxvZyB9IGZyb20gJy4uL2NvbXBvbmVudHMvTUNQU2VydmVyTXVsdGlzZWxlY3REaWFsb2cuanMnXG5pbXBvcnQgdHlwZSB7IFJvb3QgfSBmcm9tICcuLi9pbmsuanMnXG5pbXBvcnQgeyBLZXliaW5kaW5nU2V0dXAgfSBmcm9tICcuLi9rZXliaW5kaW5ncy9LZXliaW5kaW5nUHJvdmlkZXJTZXR1cC5qcydcbmltcG9ydCB7IEFwcFN0YXRlUHJvdmlkZXIgfSBmcm9tICcuLi9zdGF0ZS9BcHBTdGF0ZS5qcydcbmltcG9ydCB7IGdldE1jcENvbmZpZ3NCeVNjb3BlIH0gZnJvbSAnLi9tY3AvY29uZmlnLmpzJ1xuaW1wb3J0IHsgZ2V0UHJvamVjdE1jcFNlcnZlclN0YXR1cyB9IGZyb20gJy4vbWNwL3V0aWxzLmpzJ1xuXG4vKipcbiAqIFNob3cgTUNQIHNlcnZlciBhcHByb3ZhbCBkaWFsb2dzIGZvciBwZW5kaW5nIHByb2plY3Qgc2VydmVycy5cbiAqIFVzZXMgdGhlIHByb3ZpZGVkIEluayByb290IHRvIHJlbmRlciAocmV1c2luZyB0aGUgZXhpc3RpbmcgaW5zdGFuY2VcbiAqIGZyb20gbWFpbi50c3ggaW5zdGVhZCBvZiBjcmVhdGluZyBhIHNlcGFyYXRlIG9uZSkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVNY3Bqc29uU2VydmVyQXBwcm92YWxzKHJvb3Q6IFJvb3QpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBzZXJ2ZXJzOiBwcm9qZWN0U2VydmVycyB9ID0gZ2V0TWNwQ29uZmlnc0J5U2NvcGUoJ3Byb2plY3QnKVxuICBjb25zdCBwZW5kaW5nU2VydmVycyA9IE9iamVjdC5rZXlzKHByb2plY3RTZXJ2ZXJzKS5maWx0ZXIoXG4gICAgc2VydmVyTmFtZSA9PiBnZXRQcm9qZWN0TWNwU2VydmVyU3RhdHVzKHNlcnZlck5hbWUpID09PSAncGVuZGluZycsXG4gIClcblxuICBpZiAocGVuZGluZ1NlcnZlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuXG4gIH1cblxuICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPihyZXNvbHZlID0+IHtcbiAgICBjb25zdCBkb25lID0gKCk6IHZvaWQgPT4gdm9pZCByZXNvbHZlKClcbiAgICBpZiAocGVuZGluZ1NlcnZlcnMubGVuZ3RoID09PSAxICYmIHBlbmRpbmdTZXJ2ZXJzWzBdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHNlcnZlck5hbWUgPSBwZW5kaW5nU2VydmVyc1swXVxuICAgICAgcm9vdC5yZW5kZXIoXG4gICAgICAgIDxBcHBTdGF0ZVByb3ZpZGVyPlxuICAgICAgICAgIDxLZXliaW5kaW5nU2V0dXA+XG4gICAgICAgICAgICA8TUNQU2VydmVyQXBwcm92YWxEaWFsb2cgc2VydmVyTmFtZT17c2VydmVyTmFtZX0gb25Eb25lPXtkb25lfSAvPlxuICAgICAgICAgIDwvS2V5YmluZGluZ1NldHVwPlxuICAgICAgICA8L0FwcFN0YXRlUHJvdmlkZXI+LFxuICAgICAgKVxuICAgIH0gZWxzZSB7XG4gICAgICByb290LnJlbmRlcihcbiAgICAgICAgPEFwcFN0YXRlUHJvdmlkZXI+XG4gICAgICAgICAgPEtleWJpbmRpbmdTZXR1cD5cbiAgICAgICAgICAgIDxNQ1BTZXJ2ZXJNdWx0aXNlbGVjdERpYWxvZ1xuICAgICAgICAgICAgICBzZXJ2ZXJOYW1lcz17cGVuZGluZ1NlcnZlcnN9XG4gICAgICAgICAgICAgIG9uRG9uZT17ZG9uZX1cbiAgICAgICAgICAgIC8+XG4gICAgICAgICAgPC9LZXliaW5kaW5nU2V0dXA+XG4gICAgICAgIDwvQXBwU3RhdGVQcm92aWRlcj4sXG4gICAgICApXG4gICAgfVxuICB9KVxufVxuIl0sIm1hcHBpbmdzIjoiQUFBQSxPQUFPQSxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyx1QkFBdUIsUUFBUSwwQ0FBMEM7QUFDbEYsU0FBU0MsMEJBQTBCLFFBQVEsNkNBQTZDO0FBQ3hGLGNBQWNDLElBQUksUUFBUSxXQUFXO0FBQ3JDLFNBQVNDLGVBQWUsUUFBUSwyQ0FBMkM7QUFDM0UsU0FBU0MsZ0JBQWdCLFFBQVEsc0JBQXNCO0FBQ3ZELFNBQVNDLG9CQUFvQixRQUFRLGlCQUFpQjtBQUN0RCxTQUFTQyx5QkFBeUIsUUFBUSxnQkFBZ0I7O0FBRTFEO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxPQUFPLGVBQWVDLDRCQUE0QkEsQ0FBQ0MsSUFBSSxFQUFFTixJQUFJLENBQUMsRUFBRU8sT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO0VBQzVFLE1BQU07SUFBRUMsT0FBTyxFQUFFQztFQUFlLENBQUMsR0FBR04sb0JBQW9CLENBQUMsU0FBUyxDQUFDO0VBQ25FLE1BQU1PLGNBQWMsR0FBR0MsTUFBTSxDQUFDQyxJQUFJLENBQUNILGNBQWMsQ0FBQyxDQUFDSSxNQUFNLENBQ3ZEQyxVQUFVLElBQUlWLHlCQUF5QixDQUFDVSxVQUFVLENBQUMsS0FBSyxTQUMxRCxDQUFDO0VBRUQsSUFBSUosY0FBYyxDQUFDSyxNQUFNLEtBQUssQ0FBQyxFQUFFO0lBQy9CO0VBQ0Y7RUFFQSxNQUFNLElBQUlSLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQ1MsT0FBTyxJQUFJO0lBQ2pDLE1BQU1DLElBQUksR0FBR0EsQ0FBQSxDQUFFLEVBQUUsSUFBSSxJQUFJLEtBQUtELE9BQU8sQ0FBQyxDQUFDO0lBQ3ZDLElBQUlOLGNBQWMsQ0FBQ0ssTUFBTSxLQUFLLENBQUMsSUFBSUwsY0FBYyxDQUFDLENBQUMsQ0FBQyxLQUFLUSxTQUFTLEVBQUU7TUFDbEUsTUFBTUosVUFBVSxHQUFHSixjQUFjLENBQUMsQ0FBQyxDQUFDO01BQ3BDSixJQUFJLENBQUNhLE1BQU0sQ0FDVCxDQUFDLGdCQUFnQjtBQUN6QixVQUFVLENBQUMsZUFBZTtBQUMxQixZQUFZLENBQUMsdUJBQXVCLENBQUMsVUFBVSxDQUFDLENBQUNMLFVBQVUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDRyxJQUFJLENBQUM7QUFDMUUsVUFBVSxFQUFFLGVBQWU7QUFDM0IsUUFBUSxFQUFFLGdCQUFnQixDQUNwQixDQUFDO0lBQ0gsQ0FBQyxNQUFNO01BQ0xYLElBQUksQ0FBQ2EsTUFBTSxDQUNULENBQUMsZ0JBQWdCO0FBQ3pCLFVBQVUsQ0FBQyxlQUFlO0FBQzFCLFlBQVksQ0FBQywwQkFBMEIsQ0FDekIsV0FBVyxDQUFDLENBQUNULGNBQWMsQ0FBQyxDQUM1QixNQUFNLENBQUMsQ0FBQ08sSUFBSSxDQUFDO0FBRTNCLFVBQVUsRUFBRSxlQUFlO0FBQzNCLFFBQVEsRUFBRSxnQkFBZ0IsQ0FDcEIsQ0FBQztJQUNIO0VBQ0YsQ0FBQyxDQUFDO0FBQ0oiLCJpZ25vcmVMaXN0IjpbXX0=