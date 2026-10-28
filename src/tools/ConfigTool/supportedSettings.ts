/**
 * ============================================================================
 *  【文件总览】src/tools/ConfigTool/supportedSettings.ts —— 「可改设置」注册表
 * ============================================================================
 *
 *  【一句话定位】
 *  这是一张**注册表（白名单）**：列出模型被允许读写的全部设置项，
 *  以及每一项的元信息（存在哪、什么类型、可选值、要不要校验…）。
 *  不在表里的设置，ConfigTool 一律拒绝 —— 这是安全边界。
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置】
 * ---------------------------------------------------------------------------
 *
 *      ConfigTool.call({ setting:'theme', value:'dark' })
 *        └─> isSupported('theme')        ← ★ 本文件（查白名单）
 *        └─> getConfig('theme')          ← ★ 本文件（拿到该设置的元信息）
 *        └─> getPath('theme')            ← ★ 本文件（知道该往哪写）
 *        └─> getOptionsForSetting('theme') ← ★ 本文件（校验取值合法）
 *              └─> 真正落盘：saveGlobalConfig() / updateSettingsForSource()
 *
 *      ConfigTool 的 prompt（给模型看的说明书）也是**扫这张表生成的**
 *        └─> generatePrompt()            ← ./prompt.ts
 *              └─> Object.entries(SUPPORTED_SETTINGS)
 *
 *  也就是说：这张表是**单一事实来源（single source of truth）**——
 *  加一个可配置项只需要在表里加一条，提示词、校验、读写路径全都自动跟上。
 *
 * ---------------------------------------------------------------------------
 *  【两个必须搞清的概念：source（存在哪）】
 * ---------------------------------------------------------------------------
 *  设置并不存在一个文件里，而是分散在两处，本表用 `source` 字段区分：
 *
 *      'global'   → 全局配置，存 ~/.claude.json（跟机器走，跨项目生效）
 *                   例：theme、editorMode、verbose、autoCompactEnabled
 *
 *      'settings' → settings.json（用户级 / 项目级 / 本地级 / 托管级）
 *                   例：model、permissions.defaultMode、autoMemoryEnabled
 *
 *  为什么要分？因为有些设置是"我的机器我说了算"（主题、编辑器键位），
 *  有些是"这个项目该怎么跑"（用哪个模型、权限默认模式）。
 *  混在一起会导致团队协作时把个人偏好推给别人。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   1. SyncableAppStateKey   需要立刻同步到内存状态（AppState）的字段名
 *   2. SettingConfig         每一条设置的元信息结构（类型定义）
 *   3. SUPPORTED_SETTINGS    ★核心：全部可改设置的注册表
 *   4. isSupported()         某个设置是否在白名单里
 *   5. getConfig()           取某条设置的元信息
 *   6. getAllKeys()          全部设置名
 *   7. getOptionsForSetting() 取合法取值列表（静态 options 或动态 getOptions）
 *   8. getPath()             取写入路径（默认按 '.' 拆成数组）
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *   - `type SettingConfig = { ... }`  **类型别名**，定义一个对象结构。
 *     ≈ Java 的 record / class，但 TS 是**结构化鸭子类型**：
 *     只要字段对得上就算这个类型，不需要 implements。
 *
 *   - `source: 'global' | 'settings'`  **字面量联合类型**
 *     ≈ Java 的 enum，但更轻。写别的字符串编译期就报错。
 *
 *   - `path?: string[]` / `options?: readonly string[]`
 *     字段名后的 `?` = **可选字段**，等价于 `string[] | undefined`。
 *     `readonly` ≈ Java 的 final  List，不允许 push/修改。
 *
 *   - `getOptions?: () => string[]`  字段是一个**函数类型**。
 *     ≈ Java 的 `Supplier<List<String>>` 字段。
 *     为什么有的设置用 options（静态数组）、有的用 getOptions（函数）？
 *     因为 model 列表要**运行时**才知道（取决于账号权限），写死不行。
 *
 *   - `validateOnWrite?: (v: unknown) => Promise<{valid:boolean; error?:string}>`
 *     可选的异步校验钩子。返回 Promise ≈ Java 的 CompletableFuture。
 *     为什么需要异步？校验一个模型名是否可用要发网络请求，不能同步返回。
 *
 *   - `Record<string, SettingConfig>`
 *     **工具类型 Record** ≈ Java 的 `Map<String, SettingConfig>`，
 *     但 TS 里它描述的是普通对象的形状（key 都是 string，值都是 SettingConfig）。
 *
 *   - `feature('VOICE_MODE') ? {...} : {}`  **编译期**条件（不是运行时 if）。
 *     来自 bun:bundle，打包时被替换成 true/false 再 tree-shaking，
 *     ≈ C 的 #ifdef。所以带实验开关的设置项在关闭时**连定义都不会存在**。
 *
 *   - `...(cond ? { a: 1 } : {})`  **条件展开**：三元返回对象或空对象，
 *     展开后等价于"按条件往对象里加一个字段"。对象字面量里没法写 if，
 *     这是标准绕法。
 *
 *   - `'settings' as const`  在条件展开的分支里必须加 as const，
 *     否则 TS 会把字面量放宽成 string，对不上 SettingConfig 要求的联合类型。
 *
 *   - `export function isSupported(key: string): boolean`
 *     类型标注在**后面**（Java 在前面），初期最容易看串。
 *
 *   - `key in SUPPORTED_SETTINGS`  **in 运算符**：判断 key 是否是对象的属性。
 *     ≈ Java 的 map.containsKey(key)。
 *
 *   - `config?.path ?? key.split('.')`  `?.` + `??` 组合拳：
 *     有显式 path 就用它，没有就按点号拆分 key（'permissions.defaultMode'
 *     → ['permissions','defaultMode']）。
 *
 *   - `[...config.options]`  展开成新数组：为什么要复制一份？
 *     因为 options 可能是 readonly 的，而且直接返回内部数组会被调用方
 *     意外修改。≈ Java 的 new ArrayList<>(list) 防御性拷贝。
 * ============================================================================
 */
import { feature } from 'bun:bundle'
import { getRemoteControlAtStartup } from '../../utils/config.js'
import {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  TEAMMATE_MODES,
} from '../../utils/configConstants.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { THEME_NAMES, THEME_SETTINGS } from '../../utils/theme.js'

/** AppState keys that can be synced for immediate UI effect */
// 中文补充：AppState 是**进程内的内存状态**（UI 直接读它渲染）。
// 某些设置改完后必须立刻同步到内存，否则用户要重启才看到效果
// （比如改成 verbose 后，当前这一轮就该输出调试信息）。
// 这里用字面量联合类型把可同步的字段**限定死**，防止同步到不存在的字段。
type SyncableAppStateKey = 'verbose' | 'mainLoopModel' | 'thinkingEnabled'

/**
 * 单条设置的元信息。每个字段的含义：
 *   source          存在哪：'global'(~/.claude.json) 还是 'settings'(settings.json)
 *   type            值类型：boolean 还是 string（用于做类型强制转换与校验）
 *   description     一句话说明（会**直接生成进给模型看的提示词**）
 *   path            写入路径（数组）。不填就按 key 的点号拆
 *   options         静态的合法取值列表
 *   getOptions      动态的合法取值函数（用于运行时才知道的选项，如 model）
 *   appStateKey     改完后还要同步到 AppState 的哪个字段（立刻生效）
 *   validateOnWrite 写之前的**异步**校验（比如检查模型名是否真的可用）
 *   formatOnRead    读出来之后做展示格式化（比如 null 显示成 'default'）
 */
type SettingConfig = {
  source: 'global' | 'settings'
  type: 'boolean' | 'string'
  description: string
  path?: string[]
  options?: readonly string[]
  getOptions?: () => string[]
  appStateKey?: SyncableAppStateKey
  /** Async validation called when writing/setting a value */
  validateOnWrite?: (v: unknown) => Promise<{ valid: boolean; error?: string }>
  /** Format value when reading/getting for display */
  formatOnRead?: (v: unknown) => unknown
}

/**
 * ★ 本文件的核心：全部可改设置的**注册表（白名单）**。
 *
 * 为什么要有一张白名单，而不是让模型随便改 settings.json？
 *   ① **安全边界**：settings.json 里还有大量危险字段（权限规则、
 *      hook 命令、环境变量…），绝不能让模型自由读写；
 *   ② **防幻觉**：模型可能编造一个不存在的设置名，白名单让它
 *      立刻得到"Unknown setting"的反馈从而自我纠正；
 *   ③ **可发现性**：这张表会被 ./prompt.ts 扫一遍生成说明书，
 *      模型才知道有哪些能改。
 *
 * 下面每一条的组织顺序大致是：常用/全局 → 功能开关 → 模型 → 权限，
 * 末尾几组用条件展开挂上"仅在某些实验开关打开时才存在"的设置。
 */
export const SUPPORTED_SETTINGS: Record<string, SettingConfig> = {
  theme: {
    source: 'global',
    type: 'string',
    description: 'Color theme for the UI',
    options: feature('AUTO_THEME') ? THEME_SETTINGS : THEME_NAMES,
  },
  editorMode: {
    source: 'global',
    type: 'string',
    description: 'Key binding mode',
    options: EDITOR_MODES,
  },
  verbose: {
    source: 'global',
    type: 'boolean',
    description: 'Show detailed debug output',
    appStateKey: 'verbose',
  },
  preferredNotifChannel: {
    source: 'global',
    type: 'string',
    description: 'Preferred notification channel',
    options: NOTIFICATION_CHANNELS,
  },
  autoCompactEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Auto-compact when context is full',
  },
  autoMemoryEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable auto-memory',
  },
  autoDreamEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable background memory consolidation',
  },
  fileCheckpointingEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Enable file checkpointing for code rewind',
  },
  showTurnDuration: {
    source: 'global',
    type: 'boolean',
    description:
      'Show turn duration message after responses (e.g., "Cooked for 1m 6s")',
  },
  terminalProgressBarEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Show OSC 9;4 progress indicator in supported terminals',
  },
  todoFeatureEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Enable todo/task tracking',
  },
  // 中文补充：model 是这张表里**最复杂**的一条，值得单独看：
  //   - 用 getOptions（函数）而不是 options（数组），
  //     因为可用模型取决于账号权限，运行时才知道；
  //   - validateOnWrite 会真的去校验模型名（可能发请求），
  //     防止写进去一个不存在的模型导致后续每轮都失败；
  //   - formatOnRead 把 null 显示成 'default'，比显示 null 友好；
  //   - appStateKey 让换模型**立刻生效**，不用重启。
  model: {
    source: 'settings',
    type: 'string',
    description: 'Override the default model',
    appStateKey: 'mainLoopModel',
    getOptions: () => {
      try {
        return getModelOptions()
          .filter(o => o.value !== null)
          // 中文补充：`o.value as string` —— 上面已过滤掉 null，
          // 但 TS 不知道，需要断言一下（≈ Java 强转）。
          .map(o => o.value as string)
      } catch {
        // 中文补充：拿不到模型列表（比如离线）时给一个保守的兜底，
        // 宁可让模型看到三个通用名字，也别让整个工具挂掉。
        return ['sonnet', 'opus', 'haiku']
      }
    },
    validateOnWrite: v => validateModel(String(v)),
    formatOnRead: v => (v === null ? 'default' : v),
  },
  alwaysThinkingEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable extended thinking (false to disable)',
    appStateKey: 'thinkingEnabled',
  },
  'permissions.defaultMode': {
    source: 'settings',
    type: 'string',
    description: 'Default permission mode for tool usage',
    options: feature('TRANSCRIPT_CLASSIFIER')
      ? ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto']
      : ['default', 'plan', 'acceptEdits', 'dontAsk'],
  },
  language: {
    source: 'settings',
    type: 'string',
    description:
      'Preferred language for Claude responses and voice dictation (e.g., "japanese", "spanish")',
  },
  teammateMode: {
    source: 'global',
    type: 'string',
    description:
      'How to spawn teammates: "tmux" for traditional tmux, "in-process" for same process, "auto" to choose automatically',
    options: TEAMMATE_MODES,
  },
  ...(process.env.USER_TYPE === 'ant'
    ? {
        classifierPermissionsEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description:
            'Enable AI-based classification for Bash(prompt:...) permission rules',
        },
      }
    : {}),
  ...(feature('VOICE_MODE')
    ? {
        voiceEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description: 'Enable voice dictation (hold-to-talk)',
        },
      }
    : {}),
  ...(feature('BRIDGE_MODE')
    ? {
        remoteControlAtStartup: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Enable Remote Control for all sessions (true | false | default)',
          formatOnRead: () => getRemoteControlAtStartup(),
        },
      }
    : {}),
  ...(feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? {
        taskCompleteNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Push to your mobile device when idle after Claude finishes (requires Remote Control)',
        },
        inputNeededNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Push to your mobile device when a permission prompt or question is waiting (requires Remote Control)',
        },
        agentPushNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Allow Claude to push to your mobile device when it deems it appropriate (requires Remote Control)',
        },
      }
    : {}),
}

/**
 * 判断某个设置名是否在白名单里。
 *
 * 为什么需要：这是 ConfigTool 的**第一道闸门**。模型可能幻觉出
 * 一个不存在的设置名，或者试图改一个很危险但没开放的字段，
 * 都在这里被挡下并收到 "Unknown setting" 的明确反馈。
 *
 * @param key 设置名
 * @returns true = 允许读写
 */
export function isSupported(key: string): boolean {
  // 中文补充：`key in obj` 判断 key 是不是对象的属性
  // ≈ Java 的 map.containsKey(key)
  return key in SUPPORTED_SETTINGS
}

/**
 * 取某条设置的元信息（source / type / options / 校验钩子…）。
 *
 * @param key 设置名
 * @returns 元信息；不在白名单里时返回 undefined
 *          （返回类型是 `SettingConfig | undefined`，TS 会**强制**调用方
 *           处理 undefined 的情况，这就是空安全的好处）
 */
export function getConfig(key: string): SettingConfig | undefined {
  return SUPPORTED_SETTINGS[key]
}

/**
 * 列出全部可改设置的**名字**（用于生成提示词、做诊断展示）。
 */
export function getAllKeys(): string[] {
  return Object.keys(SUPPORTED_SETTINGS)
}

/**
 * 取某条设置的合法取值列表，用于**写入前校验**。
 *
 * 为什么需要：Theme 只允许 dark/light/…、editorMode 只允许 emacs/vim/…，
 * 写进一个不合法的值会让 UI 直接崩或者静默失效。
 * 提前校验还能把"可选值是哪些"原话告诉模型，省掉一轮试错。
 *
 * 两种来源的优先级：静态 options 优先，其次动态 getOptions。
 *
 * @param key 设置名
 * @returns 合法取值数组；没有取值限制时返回 undefined
 */
export function getOptionsForSetting(key: string): string[] | undefined {
  const config = SUPPORTED_SETTINGS[key]
  if (!config) return undefined
  // 中文补充：`[...config.options]` 复制一份再返回 —— **防御性拷贝**。
  // 因为 options 声明为 readonly，且不该让调用方改到注册表里的原数组。
  // ≈ Java 的 new ArrayList<>(list)
  if (config.options) return [...config.options]
  if (config.getOptions) return config.getOptions()
  return undefined
}

/**
 * 取某条设置的**写入路径**（数组形式）。
 *
 * 为什么要路径？因为设置是嵌套的：`permissions.defaultMode`
 * 实际对应 settings.json 里的 `{ permissions: { defaultMode: ... } }`。
 * 用数组 ['permissions','defaultMode'] 表达，读写时逐层下钻。
 *
 * @param key 设置名
 * @returns 路径数组；无显式 path 时按点号拆分 key
 */
export function getPath(key: string): string[] {
  const config = SUPPORTED_SETTINGS[key]
  // 中文补充：`?.` 可选链 + `??` 空值合并的组合拳：
  //   没这个设置 → undefined → 用 key.split('.') 兜底
  return config?.path ?? key.split('.')
}
