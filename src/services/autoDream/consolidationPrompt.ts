// Extracted from dream.ts so auto-dream ships independently of KAIROS
/**
 * ============================================================================
 *  【文件总览】src/services/autoDream/consolidationPrompt.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 consolidationPrompt.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  本文件属于「服务层」，被工具层或主循环（src/query.ts / src/QueryEngine.ts）在需要时调用，提供某一类底层能力（记忆/同步/限流/语音/钩子等）。
 *
 *  【本文件包含什么】
 *  主要导出/定义：buildConsolidationPrompt
 *
 *  【TS 语法速查】（针对本文件实际用到的，逐条 Java 对照）
 *    · `?.` 可选链 ≈ Java 里 `obj != null ? obj.x : null`
 *    · `??` 空值合并 ≈ `a != null ? a : b`（注意与 `||` 区别：`??` 只在 null/undefined 时兜底，0 和 '' 不会被动替换）
 *    · `!` 非空断言（如 `x!`）≈ 强制类型转换，骗过编译器；运行时并不做检查，乱用会抛错
 *    · `as X` ≈ Java 的 `(X)obj` 强制转换
 *    · `type X = {...}` ≈ record，但 TS 是结构化（鸭子）类型：形状对得上就算同一类型，不要求显式 implements
 *    · `A | B` 联合类型 ≈ 受限的 sealed interface / 代数数据类型
 *    · `{...obj, k: v}` 展开 ≈ 生成新对象（不可变更新），原对象不变
 *    · `x is T` 类型谓词 ≈ Java 的 `instanceof` 模式守卫，用于收窄类型
 *    · `async function*` + `yield` + `for await` ≈ Java 的 Flux / 响应式流（一边产出一边消费）
 *    · `feature('X')` 是编译期开关（类似 #ifdef），不是运行时 if
 *    · `arr.at(-1)` 取最后一个元素（Java 没有，要 `arr.get(arr.size()-1)`）
 *    · 类型标注写在变量名**后面**（`x: string`），Java 写在前面（`String x`）——这是最容易看串行的地方
 *    · 箭头函数 `x => x.y` ≈ Java 的 lambda
 */

// feature flags (dream.ts is behind a feature()-gated require).

import {
  DIR_EXISTS_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from '../../memdir/memdir.js'

export function buildConsolidationPrompt(
  memoryRoot: string,
  transcriptDir: string,
  extra: string,
): string {
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${memoryRoot}\`
${DIR_EXISTS_GUIDANCE}

Session transcripts: \`${transcriptDir}\` (large JSONL files — grep narrowly, don't read whole files)

---

## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- Read \`${ENTRYPOINT_NAME}\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates
- If \`logs/\` or \`sessions/\` subdirectories exist (assistant-mode layout), review recent entries there

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Daily logs** (\`logs/YYYY/MM/YYYY-MM-DD.md\`) if present — these are the append-only stream
2. **Existing memories that drifted** — facts that contradict something you see in the codebase now
3. **Transcript search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
   \`grep -rn "<narrow term>" ${transcriptDir}/ --include="*.jsonl" | tail -50\`

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update \`${ENTRYPOINT_NAME}\` so it stays under ${MAX_ENTRYPOINT_LINES} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.${extra ? `\n\n## Additional context\n\n${extra}` : ''}`
}
