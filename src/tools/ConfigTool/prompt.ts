/**
 * ============================================================================
 *  【文件总览】src/tools/ConfigTool/prompt.ts —— Config 工具的说明书生成器
 * ============================================================================
 *
 *  【一句话定位】
 *  把「可改设置注册表」（./supportedSettings.ts）**自动渲染**成给模型看的
 *  工具说明书。也就是说明书不是手写的，而是扫表生成的。
 *
 *  【在架构中的位置】
 *
 *      ConfigTool.prompt()               ← src/tools/ConfigTool/ConfigTool.ts
 *        └─> generatePrompt()            ← ★ 本文件
 *              ├─> Object.entries(SUPPORTED_SETTINGS)   ← ./supportedSettings.ts
 *              ├─> getOptionsForSetting()               ← ./supportedSettings.ts
 *              └─> generateModelSection()               ← ★ 本文件（model 单独一节）
 *
 *  为什么要自动生而不是手写？
 *      因为设置会不断增加。手写说明书迟早会和代码不一致 ——
 *      模型照着过期的说明书改设置，要么报"未知设置"，要么漏掉新能力。
 *      扫表生成保证**说明书永远等于代码**。
 *      ≈ Java 里用反射扫描注解生成 API 文档，而不是手敲文档。
 *
 *  【本文件包含什么】
 *   1. DESCRIPTION              工具在工具列表里显示的一句话说明
 *   2. generatePrompt()         ★核心：扫表生成完整说明书
 *   3. generateModelSection()   model 那一节单独生成（因为选项是动态的）
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *   - `` `...` ``  **模板字符串**（反引号）：可以换行、可以用 ${} 插值。
 *     ≈ Java 15+ 的文本块 `"""..."""`。本文件靠它写大段多行提示词。
 *
 *   - `Object.entries(obj)`  把对象转成 [key, value] 数组以便遍历
 *     ≈ Java 的 `map.entrySet()`。
 *     `for (const [key, config] of Object.entries(...))` 再配合**数组解构**，
 *     一行就能同时拿到键和值。
 *
 *   - `const globalSettings: string[] = []`  类型标注在变量名**后面**
 *     （Java 是 `List<String> x = new ArrayList<>()`，顺序相反）。
 *
 *   - `line += \`: ${...}\``  字符串拼接用 `+=` 也可以，
 *     但本文件更常用模板字符串插值，可读性更好。
 *
 *   - `options.map(o => \`"${o}"\`).join(', ')`
 *     链式调用 ≈ Java 的 stream().map().collect(joining(", "))。
 *     箭头函数 `o => ...` ≈ Java 的 lambda `o -> ...`。
 *
 *   - `o.descriptionForModel ?? o.description`
 *     `??` 空值合并：有"给模型看的描述"就用它，没有就用通用描述。
 *     ⚠️ 与 `||` 的区别：`??` 只在 null/undefined 时兜底，
 *     `||` 还会把空字符串 '' 也替换掉。这里显然要 `??`。
 *
 *   - `try { ... } catch { ... }`  **catch 不带参数**（ES2019+）。
 *     ≈ Java 的 `catch (Exception ignored)`，表示"我不关心具体错误"。
 *     本文件用它做兜底：拿不到模型列表就用静态文案，不让工具崩掉。
 *
 *   - `feature('VOICE_MODE') && ...`  **编译期**常量（来自 bun:bundle），
 *     打包时被替换成 true/false 再 tree-shaking ≈ C 的 #ifdef。
 *     不是运行时 if，所以不能先赋给变量再判断。
 *
 *   - `continue`  在 for 循环里跳过本次迭代，与 Java 完全一致。
 *
 *   - `export const DESCRIPTION = '...'`  导出常量字符串
 *     ≈ Java `public static final String DESCRIPTION = "..."`。
 * ============================================================================
 */
import { feature } from 'bun:bundle'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import { isVoiceGrowthBookEnabled } from '../../voice/voiceModeEnabled.js'
import {
  getOptionsForSetting,
  SUPPORTED_SETTINGS,
} from './supportedSettings.js'

// 工具在工具列表里显示的一句话说明（比 prompt 短，用于工具列表摘要）
export const DESCRIPTION = 'Get or set Claude Code configuration settings.'

/**
 * Generate the prompt documentation from the registry
 * 中文补充：★ 扫表生成说明书。
 *
 * 为什么需要：见文件头的说明——保证"说明书 == 代码"，避免手写文档过期。
 *
 * 生成步骤：
 *   ① 遍历注册表里每一条设置；
 *   ② 跳过 model（它选项动态，单独在 generateModelSection 里处理）；
 *   ③ 跳过被运行时开关关掉的设置（比如语音功能的 kill-switch）；
 *   ④ 拼出一行说明：名字 + 可选值/true-false + 描述；
 *   ⑤ 按 source 分成「全局设置」和「项目设置」两节分别列出；
 *   ⑥ 把 model 那一节插在中间，最后附上几个示例。
 *
 * 为什么要分"全局/项目"两节？因为存储位置不同、生效范围不同，
 * 模型理解了这点才不会把"个人偏好"和"项目约定"搞混。
 *
 * @returns 完整的工具说明书文本
 */
export function generatePrompt(): string {
  const globalSettings: string[] = []
  const projectSettings: string[] = []

  // 中文补充：Object.entries() 把对象变成 [键, 值] 数组 ≈ Java 的 entrySet()，
  // 再用数组解构 `const [key, config]` 一次拿到两个值。
  for (const [key, config] of Object.entries(SUPPORTED_SETTINGS)) {
    // Skip model - it gets its own section with dynamic options
    // 中文补充：model 的可选值是运行时才知道的，而且需要额外解释
    // （比如 null/"default" 的含义），所以单独开一节，不在这里列出。
    if (key === 'model') continue
    // Voice settings are registered at build-time but gated by GrowthBook
    // at runtime. Hide from model prompt when the kill-switch is on.
    // 中文补充：**双层开关**的典型例子。
    //   - 编译期：feature('VOICE_MODE') 决定代码有没有被打包进来；
    //   - 运行时：GrowthBook 开关可以紧急"熄火"（kill-switch）。
    // 之所以要两层，是因为线上出问题时没法重新发版，
    // 只能靠运行时开关立刻关掉。关掉时要连**提示词里也隐藏**，
    // 否则模型还会去调它、然后收到"未知设置"的报错。
    if (
      feature('VOICE_MODE') &&
      key === 'voiceEnabled' &&
      !isVoiceGrowthBookEnabled()
    )
      continue

    const options = getOptionsForSetting(key)
    let line = `- ${key}`

    if (options) {
      line += `: ${options.map(o => `"${o}"`).join(', ')}`
    } else if (config.type === 'boolean') {
      line += `: true/false`
    }

    line += ` - ${config.description}`

    // 中文补充：按存储位置分桶。'global' → ~/.claude.json，
    // 'settings' → settings.json。说明书里也照此分组，
    // 让模型知道"这条改动影响范围有多大"。
    if (config.source === 'global') {
      globalSettings.push(line)
    } else {
      projectSettings.push(line)
    }
  }

  const modelSection = generateModelSection()

  return `Get or set Claude Code configuration settings.

  View or change Claude Code settings. Use when the user requests configuration changes, asks about current settings, or when adjusting a setting would benefit them.


## Usage
- **Get current value:** Omit the "value" parameter
- **Set new value:** Include the "value" parameter

## Configurable settings list
The following settings are available for you to change:

### Global Settings (stored in ~/.claude.json)
${globalSettings.join('\n')}

### Project Settings (stored in settings.json)
${projectSettings.join('\n')}

${modelSection}
## Examples
- Get theme: { "setting": "theme" }
- Set dark theme: { "setting": "theme", "value": "dark" }
- Enable vim mode: { "setting": "editorMode", "value": "vim" }
- Enable verbose: { "setting": "verbose", "value": true }
- Change model: { "setting": "model", "value": "opus" }
- Change permission mode: { "setting": "permissions.defaultMode", "value": "plan" }
`
}

/**
 * 单独生成「model」那一节的说明。
 *
 * 为什么要单独一节？
 *   ① 可选模型是**运行时**才知道的（取决于账号权限），
 *      而且是列表里最长的一段，混在通用列表里会喧宾夺主；
 *   ② 需要额外解释 "null/default" 这个特殊取值（表示"用系统默认"）。
 *
 * 为什么整段包在 try/catch 里？
 *   因为拿模型列表可能失败（离线、鉴权失败…）。
 *   这时宁可给一段简化的静态说明（sonnet/opus/haiku），
 *   也不能让工具说明书生成失败——那样整个 Config 工具就用不了了。
 *
 * @returns model 一节的说明文本
 */
function generateModelSection(): string {
  try {
    const options = getModelOptions()
    const lines = options.map(o => {
      // 中文补充：null 是 model 的合法取值，意思是"用系统默认"。
      // 但直接写 null 模型看不懂，所以展示成 'null/"default"' 两种写法都给。
      const value = o.value === null ? 'null/"default"' : `"${o.value}"`
      // 中文补充：`??` —— 优先用"专门写给模型看的描述"，没有才用通用描述。
      // 为什么要分两套描述？给模型看的和给用户看的侧重点不同
      // （用户关心价格/速度，模型关心能力差异）。
      return `  - ${value}: ${o.descriptionForModel ?? o.description}`
    })
    return `## Model
- model - Override the default model. Available options:
${lines.join('\n')}`
  } catch {
    return `## Model
- model - Override the default model (sonnet, opus, haiku, best, or full model ID)`
  }
}
