/**
 * 【一句话定位】把一条 bash 命令的执行结果渲染成终端 UI：区分 stdout / stderr / 图片 /
 *   后台任务 / 无输出，并把两类「噪音」从 stderr 里剥离出来单独展示。
 *
 * 【在架构中的位置】
 *   上游：UI.tsx 的 renderToolResultMessage（转接进来）
 *   下游：components/shell/OutputLine（单行输出）、ShellTimeDisplay（耗时）、
 *        components/MessageResponse、src/utils/sandbox/sandbox-ui-utils.js（去沙箱违规标签）
 *   调用链：UI.renderToolResultMessage -> BashToolResultMessage -> OutputLine / MessageResponse
 *
 * 【本文件包含什么】
 *   - Props：组件入参类型（content + verbose + timeoutMs）
 *   - SHELL_CWD_RESET_PATTERN：匹配「Shell cwd was reset to ...」提示的正则
 *   - extractSandboxViolations()：把 <sandbox_violations> 段落从 stderr 里摘出来
 *   - extractCwdResetWarning()：把「工作目录已复位」提示从 stderr 里摘出来
 *   - BashToolResultMessage：默认导出的组件本体
 *
 * 【为什么要做「剥离」这件事】
 *   Claude Code 自己会往 stderr 里追加两类附加信息：沙箱违规记录、cwd 复位提示。
 *   它们不是命令真正的报错，如果混在 stderr 里一起标红展示，用户会误以为命令失败了。
 *   所以要先摘出来、用不同样式（灰字）单独显示，剩下的才是命令真正的 stderr
 *
 * 【特别说明：组件本体是 React Compiler 编译后的产物】
 *   `const $ = _c(34)` 与 `if ($[i] !== x)` 这套写法是编译器生成的记忆化缓存，等价于手写 useMemo：
 *   「依赖没变就直接复用上次算好的值」。t0~t11、bb0 标签都是编译器产物，没有业务含义
 *
 * 【TS/JSX 语法速查】（本文件实际出现的）
 *   - `Omit<T, 'k'>`：工具类型，从 T 里**去掉**某个字段（≈ 继承后删成员）
 *   - `type Props = { ... }` ≈ 结构化类型（record/DTO），按字段匹配而非按类名匹配
 *   - `string | null`：联合类型；这里用 null 表示「没找到」
 *   - `?? null`：空值合并，match[1] 为 undefined 时给 null
 *   - 解构时改名 `({ cleanedStderr: stderr, cwdResetWarning } = ...)`：取字段并赋给指定变量
 *   - JSX `<T0 flexDirection={t4}>`：变量名大写即可当组件用（React 的约定）
 *   - 类型标注在变量名**后面**，Java 在前面
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { removeSandboxViolationTags } from 'src/utils/sandbox/sandbox-ui-utils.js';
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { OutputLine } from '../../components/shell/OutputLine.js';
import { ShellTimeDisplay } from '../../components/shell/ShellTimeDisplay.js';
import { Box, Text } from '../../ink.js';
import type { Out as BashOut } from './BashTool.js';
// Omit 的用意：BashOut 里有个 interrupted 字段（命令被中断），结果展示阶段用不到，直接排除掉
type Props = {
  content: Omit<BashOut, 'interrupted'>;
  verbose: boolean;
  timeoutMs?: number;
};

// Pattern to match "Shell cwd was reset to <path>" message
// Use (?:^|\n) to match either start of string or after a newline
// (?:^|\n) 是「非捕获分组」：匹配行首或换行符，但不把它算进捕获组，
//   这样 match[1] 就是干净的一整行提示文案
// 为什么不用 /^/m 多行模式：这里还要靠它把整段（含前面的换行）一起 replace 掉，锚点写法更可控
const SHELL_CWD_RESET_PATTERN = /(?:^|\n)(Shell cwd was reset to .+)$/;

/**
 * Extracts sandbox violations from stderr if present
 * Returns both the cleaned stderr and the violations content
 */
/**
 * 【做什么】把 <sandbox_violations>...</sandbox_violations> 段落从 stderr 中剔除
 * 【为什么需要】沙箱违规是 Claude Code 自己加的诊断信息，不是命令的报错；
 *   混在一起标红展示会让用户误判命令失败
 * 【入参】stderr：原始 stderr
 * 【返回】{ cleanedStderr 剔除后的 stderr }
 * 【关键步骤】
 *   ① 用非贪婪匹配 ([\s\S]*?) 取出标签之间的内容（[\s\S] 是为了跨行匹配，因为 . 不匹配换行）
 *   ② 没匹配到 → 原样返回（大多数命令都没有违规信息，快路径）
 *   ③ 匹配到 → 交给 removeSandboxViolationTags 做真正的剔除，再 trim 掉多余空行
 */
function extractSandboxViolations(stderr: string): {
  cleanedStderr: string;
} {
  const violationsMatch = stderr.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/);
  if (!violationsMatch) {
    return {
      cleanedStderr: stderr
    };
  }

  // Remove the sandbox violations section from stderr
  const cleanedStderr = removeSandboxViolationTags(stderr).trim();
  return {
    cleanedStderr
  };
}

/**
 * Extracts the "Shell cwd was reset" warning message from stderr
 * Returns the cleaned stderr and the warning message separately
 */
/**
 * 【做什么】把「Shell cwd was reset to <路径>」这句提示从 stderr 中摘出来
 * 【为什么需要】cwd 复位是 Claude Code 的安全兜底行为（见 utils.ts 的 resetCwdIfOutsideProject），
 *   需要告诉用户「我帮你把目录切回去了」，但它同样不是命令的报错
 * 【入参】stderr：已经剔过沙箱违规的 stderr
 * 【返回】{ cleanedStderr 剔除提示后的 stderr, cwdResetWarning 提示文案或 null }
 * 【关键步骤】
 *   ① 正则匹配；没命中就原样返回 + null
 *   ② match[1] 是要展示的提示（?? null 兜底）
 *   ③ 用 replace 把整段（含前导换行）删掉，再 trim
 */
function extractCwdResetWarning(stderr: string): {
  cleanedStderr: string;
  cwdResetWarning: string | null;
} {
  const match = stderr.match(SHELL_CWD_RESET_PATTERN);
  if (!match) {
    return {
      cleanedStderr: stderr,
      cwdResetWarning: null
    };
  }

  // Extract the warning message from capture group 1
  const cwdResetWarning = match[1] ?? null;
  // Remove the warning from stderr (replace the full match)
  const cleanedStderr = stderr.replace(SHELL_CWD_RESET_PATTERN, '').trim();
  return {
    cleanedStderr,
    cwdResetWarning
  };
}
/**
 * 【做什么】渲染 bash 命令的结果区
 * 【为什么需要】结果有多种形态（图片、纯文本、空输出、后台任务、超时），需要分别呈现
 * 【入参】t0：props = { content（含 stdout/stderr/isImage/returnCodeInterpretation/...）, verbose, timeoutMs }
 * 【返回】React 节点
 * 【关键步骤】
 *   ① stdout / stderr 缺失时按空串处理（t2 === undefined ? '' : t2），避免后面到处判空
 *   ② 先剔沙箱违规，再剔 cwd 复位提示——顺序不能反，否则复位提示可能被违规段落吞掉
 *   ③ 是图片输出 → 直接显示一行灰色说明（图片内容已发给模型，没必要在终端里刷 base64）
 *   ④ 否则渲染：stdout 行 + stderr 行（标红）+ cwd 复位提示（灰字）
 *   ⑤ 全空时：后台任务显示 Running in the background，否则显示 Done 或 (No output)
 *   ⑥ 有 timeoutMs 时补一行耗时展示
 */
export default function BashToolResultMessage(t0) {
  const $ = _c(34);
  const {
    content: t1,
    verbose,
    timeoutMs
  } = t0;
  const {
    stdout: t2,
    stderr: t3,
    isImage,
    returnCodeInterpretation,
    noOutputExpected,
    backgroundTaskId
  } = t1;
  // 早归一化：把 undefined 统一成空串，后面所有判断只需写 stdout === ''，减少分支
  const stdout = t2 === undefined ? "" : t2;
  const stdErrWithViolations = t3 === undefined ? "" : t3;
  let T0;
  let cwdResetWarning;
  let stderr;
  let t4;
  let t5;
  let t6;
  let t7;
  if ($[0] !== isImage || $[1] !== stdErrWithViolations || $[2] !== stdout || $[3] !== verbose) {
    t7 = Symbol.for("react.early_return_sentinel");
    bb0: {
      const {
        cleanedStderr: stderrWithoutViolations
      // 第一次剥离：沙箱违规段落
      } = extractSandboxViolations(stdErrWithViolations);
      ({
        cleanedStderr: stderr,
        cwdResetWarning
      // 第二次剥离：cwd 复位提示（注意输入是上一层的输出，两级清理串成一条流水线）
      } = extractCwdResetWarning(stderrWithoutViolations));
      if (isImage) {
        let t8;
        if ($[11] === Symbol.for("react.memo_cache_sentinel")) {
          t8 = <MessageResponse height={1}><Text dimColor={true}>[Image data detected and sent to Claude]</Text></MessageResponse>;
          $[11] = t8;
        } else {
          t8 = $[11];
        }
        t7 = t8;
        break bb0;
      }
      T0 = Box;
      t4 = "column";
      if ($[12] !== stdout || $[13] !== verbose) {
        t5 = stdout !== "" ? <OutputLine content={stdout} verbose={verbose} /> : null;
        $[12] = stdout;
        $[13] = verbose;
        $[14] = t5;
      } else {
        t5 = $[14];
      }
      // isError={true}：剩下的才是命令**真正的** stderr，用错误样式（通常是红色）展示
      // trim() 判断而非 === ''：stderr 常带首尾换行，直接判空会渲染出一个空行块
      t6 = stderr.trim() !== "" ? <OutputLine content={stderr} verbose={verbose} isError={true} /> : null;
    }
    $[0] = isImage;
    $[1] = stdErrWithViolations;
    $[2] = stdout;
    $[3] = verbose;
    $[4] = T0;
    $[5] = cwdResetWarning;
    $[6] = stderr;
    $[7] = t4;
    $[8] = t5;
    $[9] = t6;
    $[10] = t7;
  } else {
    T0 = $[4];
    cwdResetWarning = $[5];
    stderr = $[6];
    t4 = $[7];
    t5 = $[8];
    t6 = $[9];
    t7 = $[10];
  }
  if (t7 !== Symbol.for("react.early_return_sentinel")) {
    return t7;
  }
  let t8;
  if ($[15] !== cwdResetWarning) {
    t8 = cwdResetWarning ? <MessageResponse><Text dimColor={true}>{cwdResetWarning}</Text></MessageResponse> : null;
    $[15] = cwdResetWarning;
    $[16] = t8;
  } else {
    t8 = $[16];
  }
  let t9;
  if ($[17] !== backgroundTaskId || $[18] !== cwdResetWarning || $[19] !== noOutputExpected || $[20] !== returnCodeInterpretation || $[21] !== stderr || $[22] !== stdout) {
    t9 = stdout === "" && stderr.trim() === "" && !cwdResetWarning ? <MessageResponse height={1}><Text dimColor={true}>{backgroundTaskId ? <>Running in the background{" "}<KeyboardShortcutHint shortcut={"\u2193"} action="manage" parens={true} /></> : returnCodeInterpretation || (noOutputExpected ? "Done" : "(No output)")}</Text></MessageResponse> : null;
    $[17] = backgroundTaskId;
    $[18] = cwdResetWarning;
    $[19] = noOutputExpected;
    $[20] = returnCodeInterpretation;
    $[21] = stderr;
    $[22] = stdout;
    $[23] = t9;
  } else {
    t9 = $[23];
  }
  let t10;
  if ($[24] !== timeoutMs) {
    t10 = timeoutMs && <MessageResponse><ShellTimeDisplay timeoutMs={timeoutMs} /></MessageResponse>;
    $[24] = timeoutMs;
    $[25] = t10;
  } else {
    t10 = $[25];
  }
  let t11;
  if ($[26] !== T0 || $[27] !== t10 || $[28] !== t4 || $[29] !== t5 || $[30] !== t6 || $[31] !== t8 || $[32] !== t9) {
    t11 = <T0 flexDirection={t4}>{t5}{t6}{t8}{t9}{t10}</T0>;
    $[26] = T0;
    $[27] = t10;
    $[28] = t4;
    $[29] = t5;
    $[30] = t6;
    $[31] = t8;
    $[32] = t9;
    $[33] = t11;
  } else {
    t11 = $[33];
  }
  return t11;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInJlbW92ZVNhbmRib3hWaW9sYXRpb25UYWdzIiwiS2V5Ym9hcmRTaG9ydGN1dEhpbnQiLCJNZXNzYWdlUmVzcG9uc2UiLCJPdXRwdXRMaW5lIiwiU2hlbGxUaW1lRGlzcGxheSIsIkJveCIsIlRleHQiLCJPdXQiLCJCYXNoT3V0IiwiUHJvcHMiLCJjb250ZW50IiwiT21pdCIsInZlcmJvc2UiLCJ0aW1lb3V0TXMiLCJTSEVMTF9DV0RfUkVTRVRfUEFUVEVSTiIsImV4dHJhY3RTYW5kYm94VmlvbGF0aW9ucyIsInN0ZGVyciIsImNsZWFuZWRTdGRlcnIiLCJ2aW9sYXRpb25zTWF0Y2giLCJtYXRjaCIsInRyaW0iLCJleHRyYWN0Q3dkUmVzZXRXYXJuaW5nIiwiY3dkUmVzZXRXYXJuaW5nIiwicmVwbGFjZSIsIkJhc2hUb29sUmVzdWx0TWVzc2FnZSIsInQwIiwiJCIsIl9jIiwidDEiLCJzdGRvdXQiLCJ0MiIsInQzIiwiaXNJbWFnZSIsInJldHVybkNvZGVJbnRlcnByZXRhdGlvbiIsIm5vT3V0cHV0RXhwZWN0ZWQiLCJiYWNrZ3JvdW5kVGFza0lkIiwidW5kZWZpbmVkIiwic3RkRXJyV2l0aFZpb2xhdGlvbnMiLCJUMCIsInQ0IiwidDUiLCJ0NiIsInQ3IiwiU3ltYm9sIiwiZm9yIiwiYmIwIiwic3RkZXJyV2l0aG91dFZpb2xhdGlvbnMiLCJ0OCIsInQ5IiwidDEwIiwidDExIl0sInNvdXJjZXMiOlsiQmFzaFRvb2xSZXN1bHRNZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyByZW1vdmVTYW5kYm94VmlvbGF0aW9uVGFncyB9IGZyb20gJ3NyYy91dGlscy9zYW5kYm94L3NhbmRib3gtdWktdXRpbHMuanMnXG5pbXBvcnQgeyBLZXlib2FyZFNob3J0Y3V0SGludCB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvZGVzaWduLXN5c3RlbS9LZXlib2FyZFNob3J0Y3V0SGludC5qcydcbmltcG9ydCB7IE1lc3NhZ2VSZXNwb25zZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvTWVzc2FnZVJlc3BvbnNlLmpzJ1xuaW1wb3J0IHsgT3V0cHV0TGluZSB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvc2hlbGwvT3V0cHV0TGluZS5qcydcbmltcG9ydCB7IFNoZWxsVGltZURpc3BsYXkgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL3NoZWxsL1NoZWxsVGltZURpc3BsYXkuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgdHlwZSB7IE91dCBhcyBCYXNoT3V0IH0gZnJvbSAnLi9CYXNoVG9vbC5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgY29udGVudDogT21pdDxCYXNoT3V0LCAnaW50ZXJydXB0ZWQnPlxuICB2ZXJib3NlOiBib29sZWFuXG4gIHRpbWVvdXRNcz86IG51bWJlclxufVxuXG4vLyBQYXR0ZXJuIHRvIG1hdGNoIFwiU2hlbGwgY3dkIHdhcyByZXNldCB0byA8cGF0aD5cIiBtZXNzYWdlXG4vLyBVc2UgKD86XnxcXG4pIHRvIG1hdGNoIGVpdGhlciBzdGFydCBvZiBzdHJpbmcgb3IgYWZ0ZXIgYSBuZXdsaW5lXG5jb25zdCBTSEVMTF9DV0RfUkVTRVRfUEFUVEVSTiA9IC8oPzpefFxcbikoU2hlbGwgY3dkIHdhcyByZXNldCB0byAuKykkL1xuXG4vKipcbiAqIEV4dHJhY3RzIHNhbmRib3ggdmlvbGF0aW9ucyBmcm9tIHN0ZGVyciBpZiBwcmVzZW50XG4gKiBSZXR1cm5zIGJvdGggdGhlIGNsZWFuZWQgc3RkZXJyIGFuZCB0aGUgdmlvbGF0aW9ucyBjb250ZW50XG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RTYW5kYm94VmlvbGF0aW9ucyhzdGRlcnI6IHN0cmluZyk6IHtcbiAgY2xlYW5lZFN0ZGVycjogc3RyaW5nXG59IHtcbiAgY29uc3QgdmlvbGF0aW9uc01hdGNoID0gc3RkZXJyLm1hdGNoKFxuICAgIC88c2FuZGJveF92aW9sYXRpb25zPihbXFxzXFxTXSo/KTxcXC9zYW5kYm94X3Zpb2xhdGlvbnM+LyxcbiAgKVxuXG4gIGlmICghdmlvbGF0aW9uc01hdGNoKSB7XG4gICAgcmV0dXJuIHsgY2xlYW5lZFN0ZGVycjogc3RkZXJyIH1cbiAgfVxuXG4gIC8vIFJlbW92ZSB0aGUgc2FuZGJveCB2aW9sYXRpb25zIHNlY3Rpb24gZnJvbSBzdGRlcnJcbiAgY29uc3QgY2xlYW5lZFN0ZGVyciA9IHJlbW92ZVNhbmRib3hWaW9sYXRpb25UYWdzKHN0ZGVycikudHJpbSgpXG5cbiAgcmV0dXJuIHtcbiAgICBjbGVhbmVkU3RkZXJyLFxuICB9XG59XG5cbi8qKlxuICogRXh0cmFjdHMgdGhlIFwiU2hlbGwgY3dkIHdhcyByZXNldFwiIHdhcm5pbmcgbWVzc2FnZSBmcm9tIHN0ZGVyclxuICogUmV0dXJucyB0aGUgY2xlYW5lZCBzdGRlcnIgYW5kIHRoZSB3YXJuaW5nIG1lc3NhZ2Ugc2VwYXJhdGVseVxuICovXG5mdW5jdGlvbiBleHRyYWN0Q3dkUmVzZXRXYXJuaW5nKHN0ZGVycjogc3RyaW5nKToge1xuICBjbGVhbmVkU3RkZXJyOiBzdHJpbmdcbiAgY3dkUmVzZXRXYXJuaW5nOiBzdHJpbmcgfCBudWxsXG59IHtcbiAgY29uc3QgbWF0Y2ggPSBzdGRlcnIubWF0Y2goU0hFTExfQ1dEX1JFU0VUX1BBVFRFUk4pXG4gIGlmICghbWF0Y2gpIHtcbiAgICByZXR1cm4geyBjbGVhbmVkU3RkZXJyOiBzdGRlcnIsIGN3ZFJlc2V0V2FybmluZzogbnVsbCB9XG4gIH1cblxuICAvLyBFeHRyYWN0IHRoZSB3YXJuaW5nIG1lc3NhZ2UgZnJvbSBjYXB0dXJlIGdyb3VwIDFcbiAgY29uc3QgY3dkUmVzZXRXYXJuaW5nID0gbWF0Y2hbMV0gPz8gbnVsbFxuICAvLyBSZW1vdmUgdGhlIHdhcm5pbmcgZnJvbSBzdGRlcnIgKHJlcGxhY2UgdGhlIGZ1bGwgbWF0Y2gpXG4gIGNvbnN0IGNsZWFuZWRTdGRlcnIgPSBzdGRlcnIucmVwbGFjZShTSEVMTF9DV0RfUkVTRVRfUEFUVEVSTiwgJycpLnRyaW0oKVxuXG4gIHJldHVybiB7IGNsZWFuZWRTdGRlcnIsIGN3ZFJlc2V0V2FybmluZyB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIEJhc2hUb29sUmVzdWx0TWVzc2FnZSh7XG4gIGNvbnRlbnQ6IHtcbiAgICBzdGRvdXQgPSAnJyxcbiAgICBzdGRlcnI6IHN0ZEVycldpdGhWaW9sYXRpb25zID0gJycsXG4gICAgaXNJbWFnZSxcbiAgICByZXR1cm5Db2RlSW50ZXJwcmV0YXRpb24sXG4gICAgbm9PdXRwdXRFeHBlY3RlZCxcbiAgICBiYWNrZ3JvdW5kVGFza0lkLFxuICB9LFxuICB2ZXJib3NlLFxuICB0aW1lb3V0TXMsXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIC8vIEV4dHJhY3Qgc2FuZGJveCB2aW9sYXRpb25zIGZyb20gc3RkZXJyIGFzIGl0IGZlZWxzIGNsZWFuZXIgb24gdGhlIFVJXG4gIC8vIFdlIHdhbnQgdGhlIG1vZGVsIHRvIHNlZSB0aGUgdmlvbGF0aW9ucywgc28gaXQgY2FuIGV4cGxhaW4gd2hhdCB3ZW50IHdyb25nLCBhbmQgdGhlXG4gIC8vIHVzZXIgY2FuIGFjY2VzcyB0aGVtIGluIHRoZSB2aW9sYXRpb24gbG9nc1xuICBjb25zdCB7IGNsZWFuZWRTdGRlcnI6IHN0ZGVycldpdGhvdXRWaW9sYXRpb25zIH0gPVxuICAgIGV4dHJhY3RTYW5kYm94VmlvbGF0aW9ucyhzdGRFcnJXaXRoVmlvbGF0aW9ucylcblxuICAvLyBFeHRyYWN0IFwiU2hlbGwgY3dkIHdhcyByZXNldFwiIHdhcm5pbmcgdG8gcmVuZGVyIGl0IHdpdGggd2FybmluZyBjb2xvciBpbnN0ZWFkIG9mIGVycm9yXG4gIGNvbnN0IHsgY2xlYW5lZFN0ZGVycjogc3RkZXJyLCBjd2RSZXNldFdhcm5pbmcgfSA9IGV4dHJhY3RDd2RSZXNldFdhcm5pbmcoXG4gICAgc3RkZXJyV2l0aG91dFZpb2xhdGlvbnMsXG4gIClcblxuICAvLyBJZiB0aGlzIGlzIGFuIGltYWdlLCB3ZSBkb24ndCB3YW50IHRvIHRydW5jYXRlIGl0IGluIHRoZSBVSVxuICBpZiAoaXNJbWFnZSkge1xuICAgIHJldHVybiAoXG4gICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPltJbWFnZSBkYXRhIGRldGVjdGVkIGFuZCBzZW50IHRvIENsYXVkZV08L1RleHQ+XG4gICAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgICApXG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAge3N0ZG91dCAhPT0gJycgPyA8T3V0cHV0TGluZSBjb250ZW50PXtzdGRvdXR9IHZlcmJvc2U9e3ZlcmJvc2V9IC8+IDogbnVsbH1cbiAgICAgIHtzdGRlcnIudHJpbSgpICE9PSAnJyA/IChcbiAgICAgICAgPE91dHB1dExpbmUgY29udGVudD17c3RkZXJyfSB2ZXJib3NlPXt2ZXJib3NlfSBpc0Vycm9yIC8+XG4gICAgICApIDogbnVsbH1cbiAgICAgIHtjd2RSZXNldFdhcm5pbmcgPyAoXG4gICAgICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+e2N3ZFJlc2V0V2FybmluZ308L1RleHQ+XG4gICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgKSA6IG51bGx9XG4gICAgICB7c3Rkb3V0ID09PSAnJyAmJiBzdGRlcnIudHJpbSgpID09PSAnJyAmJiAhY3dkUmVzZXRXYXJuaW5nID8gKFxuICAgICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgICB7YmFja2dyb3VuZFRhc2tJZCA/IChcbiAgICAgICAgICAgICAgPD5cbiAgICAgICAgICAgICAgICBSdW5uaW5nIGluIHRoZSBiYWNrZ3JvdW5keycgJ31cbiAgICAgICAgICAgICAgICA8S2V5Ym9hcmRTaG9ydGN1dEhpbnQgc2hvcnRjdXQ9XCLihpNcIiBhY3Rpb249XCJtYW5hZ2VcIiBwYXJlbnMgLz5cbiAgICAgICAgICAgICAgPC8+XG4gICAgICAgICAgICApIDogKFxuICAgICAgICAgICAgICByZXR1cm5Db2RlSW50ZXJwcmV0YXRpb24gfHxcbiAgICAgICAgICAgICAgKG5vT3V0cHV0RXhwZWN0ZWQgPyAnRG9uZScgOiAnKE5vIG91dHB1dCknKVxuICAgICAgICAgICAgKX1cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgICAgKSA6IG51bGx9XG4gICAgICB7dGltZW91dE1zICYmIChcbiAgICAgICAgPE1lc3NhZ2VSZXNwb25zZT5cbiAgICAgICAgICA8U2hlbGxUaW1lRGlzcGxheSB0aW1lb3V0TXM9e3RpbWVvdXRNc30gLz5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICApfVxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQywwQkFBMEIsUUFBUSx1Q0FBdUM7QUFDbEYsU0FBU0Msb0JBQW9CLFFBQVEsd0RBQXdEO0FBQzdGLFNBQVNDLGVBQWUsUUFBUSxxQ0FBcUM7QUFDckUsU0FBU0MsVUFBVSxRQUFRLHNDQUFzQztBQUNqRSxTQUFTQyxnQkFBZ0IsUUFBUSw0Q0FBNEM7QUFDN0UsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxjQUFjQyxHQUFHLElBQUlDLE9BQU8sUUFBUSxlQUFlO0FBRW5ELEtBQUtDLEtBQUssR0FBRztFQUNYQyxPQUFPLEVBQUVDLElBQUksQ0FBQ0gsT0FBTyxFQUFFLGFBQWEsQ0FBQztFQUNyQ0ksT0FBTyxFQUFFLE9BQU87RUFDaEJDLFNBQVMsQ0FBQyxFQUFFLE1BQU07QUFDcEIsQ0FBQzs7QUFFRDtBQUNBO0FBQ0EsTUFBTUMsdUJBQXVCLEdBQUcsc0NBQXNDOztBQUV0RTtBQUNBO0FBQ0E7QUFDQTtBQUNB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N0MsQ0FDRixFQVZDLElBQUksQ0FXUCxFQVpDLGVBQWUsQ0FhVixHQWRQLElBY087SUFBQVIsQ0FBQSxPQUFBUyxnQkFBQTtJQUFBVCxDQUFBLE9BQUFKLGVBQUE7SUFBQUksQ0FBQSxPQUFBUSxnQkFBQTtJQUFBUixDQUFBLE9BQUFPLHdCQUFBO0lBQUFQLENBQUEsT0FBQVYsTUFBQTtJQUFBVSxDQUFBLE9BQUFHLE1BQUE7SUFBQUgsQ0FBQSxPQUFBc0IsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQXRCLENBQUE7RUFBQTtFQUFBLElBQUF1QixHQUFBO0VBQUEsSUFBQXZCLENBQUEsU0FBQWIsU0FBQTtJQUNQb0MsR0FBQSxHQUFBcEMsU0FJQSxJQUhDLENBQUMsZUFBZSxDQUNkLENBQUMsZ0JBQWdCLENBQVlBLFNBQVMsQ0FBVEEsVUFBUSxDQUFDLEdBQ3hDLEVBRkMsZUFBZSxDQUdqQjtJQUFBYSxDQUFBLE9BQUFiLFNBQUE7SUFBQWEsQ0FBQSxPQUFBdUIsR0FBQTtFQUFBO0lBQUFBLEdBQUEsR0FBQXZCLENBQUE7RUFBQTtFQUFBLElBQUF3QixHQUFBO0VBQUEsSUFBQXhCLENBQUEsU0FBQVksRUFBQSxJQUFBWixDQUFBLFNBQUF1QixHQUFBLElBQUF2QixDQUFBLFNBQUFhLEVBQUEsSUFBQWIsQ0FBQSxTQUFBYyxFQUFBLElBQUFkLENBQUEsU0FBQWUsRUFBQSxJQUFBZixDQUFBLFNBQUFxQixFQUFBLElBQUFyQixDQUFBLFNBQUFzQixFQUFBO0lBN0JIRSxHQUFBLElBQUMsRUFBRyxDQUFlLGFBQVEsQ0FBUixDQUFBWCxFQUFPLENBQUMsQ0FDeEIsQ0FBQUMsRUFBdUUsQ0FDdkUsQ0FBQUMsRUFFTSxDQUNOLENBQUFNLEVBSU0sQ0FDTixDQUFBQyxFQWNNLENBQ04sQ0FBQUMsR0FJRCxDQUNGLEVBOUJDLEVBQUcsQ0E4QkU7SUFBQXZCLENBQUEsT0FBQVksRUFBQTtJQUFBWixDQUFBLE9BQUF1QixHQUFBO0lBQUF2QixDQUFBLE9BQUFhLEVBQUE7SUFBQWIsQ0FBQSxPQUFBYyxFQUFBO0lBQUFkLENBQUEsT0FBQWUsRUFBQTtJQUFBZixDQUFBLE9BQUFxQixFQUFBO0lBQUFyQixDQUFBLE9BQUFzQixFQUFBO0lBQUF0QixDQUFBLE9BQUF3QixHQUFBO0VBQUE7SUFBQUEsR0FBQSxHQUFBeEIsQ0FBQTtFQUFBO0VBQUEsT0E5Qk53QixHQThCTTtBQUFBIiwiaWdub3JlTGlzdCI6W119