/**
 * ============================================================================
 *  【文件总览】src/tools/ConfigTool/ConfigTool.ts —— 「读写设置」的工具
 * ============================================================================
 *
 *  【一句话定位】
 *  实现名为 `Config` 的工具：模型可以用它**读**或**改** Claude Code 的
 *  配置项（主题、模型、权限默认模式、各种功能开关…）。
 *
 * ---------------------------------------------------------------------------
 *  ★★ 重点：改设置为什么要走工具，而不是让模型直接写文件？★★
 * ---------------------------------------------------------------------------
 *  乍看之下很绕：配置不就是 ~/.claude.json 和 settings.json 吗？
 *  让模型用 Write 工具直接改不就行了？—— 不行，有五个硬理由：
 *
 *  ① **存储位置分散且各有权重**
 *     同一项设置可能存在于多个"来源"：托管级(managed) > 命令行参数 >
 *     项目级(.claude/settings.json) > 本地级(.claude/settings.local.json) >
 *     用户级(~/.claude/settings.json) > 全局(~/.claude.json)。
 *     优先级规则复杂，模型不知道该往哪一层写；
 *     本工具通过 SettingConfig.source 明确指定，且只写 userSettings 这一层。
 *
 *  ② **必须校验**
 *     theme 只能取 dark/light/…、editorMode 只能取 emacs/vim/…、
 *     model 还要**发请求**确认这个名字真的存在。
 *     直接写文件的话，一个非法值会让程序下次启动直接崩，
 *     或者静默失效——用户根本不知道发生了什么。
 *
 *  ③ **要立刻生效（同步到内存状态）**
 *     很多设置改完必须**当场**反映到 UI 上（换成 verbose 后本轮就该输出
 *     调试信息；换 model 后下一次调用就该用新模型）。
 *     只写文件的话要重启才生效。本工具通过 appStateKey 同步 AppState。
 *
 *  ④ **要过权限（最重要）**
 *     **读**设置自动放行（无害）；**写**设置必须弹窗让用户确认。
 *     否则模型可以在用户不知情的情况下改掉权限模式
 *     （比如把 permissions.defaultMode 改成 auto = 不再询问），
 *     那是直接的安全漏洞。见 checkPermissions()。
 *
 *  ⑤ **要可审计**
 *     每次改动都打埋点（tengu_config_tool_changed），
 *     出问题能追溯"是谁在哪一轮改了什么"。
 *
 *  总结：配置不是"一堆 JSON 文件"，而是"一个由程序维护的状态"。
 *  直接改文件 ≈ 绕过 setter 直接改 private 字段，会破坏所有不变量。
 *
 * ---------------------------------------------------------------------------
 *  【在架构中的位置】
 * ---------------------------------------------------------------------------
 *
 *      用户："把主题换成暗色"
 *        └─> 模型 → tool_use { name:'Config', input:{setting:'theme',value:'dark'} }
 *              └─> ConfigTool.checkPermissions()  ← ★ 本文件
 *                    ├─ 没传 value（读）→ 自动放行
 *                    └─ 传了 value（写）→ 弹窗 ask
 *              └─> ConfigTool.call()              ← ★ 本文件
 *                    ① isSupported()  查白名单      ← ./supportedSettings.ts
 *                    ② value === undefined ? 读 : 写
 *                    ③ 写：类型强制 → 取值校验 → 异步校验 → 落盘
 *                    ④ 落盘：saveGlobalConfig() / updateSettingsForSource()
 *                    ⑤ 同步 AppState + 打埋点
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   1. inputSchema / outputSchema     入参出参的 zod 定义
 *   2. ConfigTool（buildTool 产物）★主体，含：
 *        description / prompt        说明书（由 ./prompt.ts 生成）
 *        isReadOnly()                没传 value 就是只读
 *        checkPermissions()          读放行 / 写询问
 *        call()                      ★核心：读写的完整流程
 *        mapToolResultToToolResultBlockParam()  结果转成 API 格式
 *   3. getValue()                    按路径从配置里读值
 *   4. buildNestedObject()           把 ['permissions','defaultMode'] 变成嵌套对象
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】
 * ---------------------------------------------------------------------------
 *   - `z.strictObject({...})`  zod 的**严格**对象：
 *     传入**多余字段会报错**（普通 z.object 默认忽略多余字段）。
 *     为什么这里要严格？因为 setting/value 写错了（比如写成 settings）
 *     应该立刻报错让模型纠正，而不是被静默忽略。
 *
 *   - `z.union([z.string(), z.boolean(), z.number()])`
 *     联合类型校验：value 可以是字符串/布尔/数字三种之一。
 *     ≈ Java 的 sealed interface 的三个实现。
 *
 *   - `z.enum(['get','set'])`  枚举校验 ≈ Java 的 enum。
 *     编译后同时是**运行时**校验器和**静态**类型（'get'|'set'）。
 *
 *   - `z.unknown()`  ≈ Java 的 Object：什么类型都行，
 *     但使用前必须先收窄（比 any 安全，any 会关闭所有检查）。
 *
 *   - `feature('VOICE_MODE')`  **编译期**常量（bun:bundle），
 *     打包时替换成 true/false 再 tree-shaking ≈ C 的 #ifdef。
 *     注意：**不是**运行时 if，所以不能先赋值给变量再判断。
 *
 *   - `await import('../../voice/voiceModeEnabled.js')`  **动态 import**。
 *     ≈ Java 的 Class.forName() 反射加载，但保留完整类型。
 *     好处：这个语音模块只在需要时才加载（省启动开销），
 *     且避免把语音相关代码拖进不带该功能的产物。
 *
 *   - `saveGlobalConfig(prev => {...})`  传一个**更新函数**而不是新值。
 *     ≈ Java 的 `map.compute(k, (k, v) -> ...)`。
 *     为什么？因为读-改-写必须是原子的，否则并发下会丢修改。
 *
 *   - `{ ...prev, [key]: value }`  **计算属性名 + 展开**：
 *     `[key]` 里的 key 是变量（运行时才知道名字），
 *     `...prev` 复制其余字段。合起来 = "复制一份并覆盖某字段"
 *     （不可变更新，不修改原对象）。
 *
 *   - `delete next.remoteControlAtStartup`  删除对象属性。
 *     这里是为了"恢复默认"——删掉这个键，读取时就会回落到平台默认值。
 *     （不是设成 false，false 和"没设置"是两回事！）
 *
 *   - `context.setAppState(prev => ...)`  同步内存状态，
 *     让 UI 立刻反映变化（见上面理由③）。
 *
 *   - `prev[key as keyof GlobalConfig]`  **`keyof` 运算符**：
 *     取 GlobalConfig 的所有字段名组成的联合类型。
 *     ≈ Java 没有对应物（反射里的 getDeclaredFields 是运行时的，
 *       而 keyof 是**类型层面**的，编译期就生效）。
 *
 *   - `(current as Record<string, unknown>)[key]`  断言成字典再动态取字段，
 *     因为 TS 不允许对 unknown 直接下标访问（必须先收窄类型）。
 *
 *   - `try { ... } catch (error) { logError(error) ... }`
 *     ≈ Java 的 try-catch，但 TS 的 catch 变量默认是 unknown，
 *     所以要用 errorMessage(error) 转成可读文本。
 *     为什么整个写流程包起来？落盘可能因为权限、磁盘满、
 *     并发冲突失败，必须给出人能看懂的反馈而不是崩掉。
 *
 *   - `satisfies ToolDef<...>`  既做类型检查又**保留**精确类型
 *     （不像 `as` 会放宽类型丢信息）。
 * ============================================================================
 */
import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  type GlobalConfig,
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
} from '../../utils/config.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { CONFIG_TOOL_NAME } from './constants.js'
import { DESCRIPTION, generatePrompt } from './prompt.js'
import {
  getConfig,
  getOptionsForSetting,
  getPath,
  isSupported,
} from './supportedSettings.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/**
 * 入参 schema。只有两个字段：
 *   setting  设置名（必填）
 *   value    新值（**可选**）—— 关键设计：**不传就是读，传了就是写**。
 *            用"有没有 value"来区分读写，比再引入一个 action 字段更简洁，
 *            也让"读"这个安全操作成为默认行为。
 *
 * 用 z.strictObject 而非 z.object：多传字段会**直接报错**。
 * 为什么？模型偶尔会传 { setting, value, action } 之类的多余字段，
 * 严格模式会立刻告诉它"格式错了"，而不是悄悄忽略导致行为不符预期。
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    setting: z
      .string()
      .describe(
        'The setting key (e.g., "theme", "model", "permissions.defaultMode")',
      ),
    value: z
      .union([z.string(), z.boolean(), z.number()])
      .optional()
      .describe('The new value. Omit to get current value.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    operation: z.enum(['get', 'set']).optional(),
    setting: z.string().optional(),
    value: z.unknown().optional(),
    previousValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

// 中文补充：`z.infer<S>` 从 schema 反推 TS 类型。schema 改了类型自动跟着变，
// 不用在两处维护 ≈ Java 靠注解处理器生成 DTO，但 TS 是纯类型运算。
export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

/**
 * ★ 主体：Config 工具对象（buildTool 工厂产出）。
 * 几个元特性的含义：
 *   shouldDefer: true    这是个低频工具，**延迟加载**（平时只在系统提示里
 *                        露个名字，模型要用时先 ToolSearch 检索）。
 *                        ≈ Spring 的 @Lazy：用到才初始化。
 *   isConcurrencySafe()  可以和其他工具并发执行（读写配置互不干扰）。
 */
export const ConfigTool = buildTool({
  name: CONFIG_TOOL_NAME,
  searchHint: 'get or set Claude Code settings (theme, model)',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return generatePrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Config'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  // 中文补充：**没传 value = 读 = 只读**，所以这一条直接决定了
  // 读操作完全不需要用户确认，体验上很顺滑。
  isReadOnly(input: Input) {
    return input.value === undefined
  },
  // 中文补充：喂给分类器的一行摘要。读 → 只给设置名；
  // 写 → 给 "setting = value"，方便审计"模型改了什么"。
  toAutoClassifierInput(input) {
    return input.value === undefined
      ? input.setting
      : `${input.setting} = ${input.value}`
  },
  /**
   * 【授权】读放行、写询问 —— 这是整个 Config 工具的**安全核心**。
   *
   * 为什么要这样分级？
   *   读：无害，只是看看当前配置，每次都问会让体验很烦。
   *   写：会**持久化**地改变用户环境，而且有些设置直接关系安全
   *       （比如 permissions.defaultMode = auto 会让所有工具免确认执行）。
   *       必须让用户点头。
   *
   * 弹窗文案里带上**具体的新值**（Set theme to "dark"），
   * 而不是笼统的"要修改配置吗"，这样用户能一眼判断该不该同意。
   *
   * @param input 工具入参
   * @returns allow（读）或 ask（写）
   */
  async checkPermissions(input: Input) {
    // Auto-allow reading configs
    if (input.value === undefined) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    // 中文补充：写操作一律 ask。`as const` 让 'ask' 保持字面量类型
    // （否则会被放宽成 string，对不上 PermissionDecision 要求的联合类型）。
    return {
      behavior: 'ask' as const,
      message: `Set ${input.setting} to ${jsonStringify(input.value)}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  /**
   * 【核心】读或写一个配置项。
   *
   * 完整流程（写操作）：
   *   ① 白名单检查 isSupported() —— 不在表里直接报 "Unknown setting"
   *   ② 特殊处理 'default' 值（删掉键、回落到平台默认）
   *   ③ 类型强制：boolean 类型接受 "true"/"false" 字符串并转换
   *   ④ 取值校验：必须在 options 列表里
   *   ⑤ 异步校验：validateOnWrite（比如确认模型名真的可用）
   *   ⑥ 特殊前置检查：语音模式要检查麦克风权限、录音依赖等
   *   ⑦ 落盘：global → saveGlobalConfig；settings → updateSettingsForSource
   *   ⑧ 同步 AppState（让 UI 立刻生效）+ 打埋点
   *   ⑨ 全程 try/catch，失败返回可读的错误信息而不是抛异常
   *
   * @param input.setting 设置名
   * @param input.value   新值；undefined 表示只读取
   * @param context       工具上下文（用 setAppState 同步内存状态）
   * @returns { data: Output } —— 注意**失败也返回 success:false 的对象**，
   *          而不是抛异常。因为错误信息要回给模型让它自我纠正。
   */
  async call({ setting, value }: Input, context): Promise<{ data: Output }> {
    // 1. Check if setting is supported
    // Voice settings are registered at build-time (feature('VOICE_MODE')), but
    // must also be gated at runtime. When the kill-switch is on, treat
    // voiceEnabled as an unknown setting so no voice-specific strings leak.
    // 中文补充：**双层开关**——编译期 feature 决定代码进不进产物，
    // 运行时 GrowthBook 可以紧急熄火（线上出问题没法立刻发版时用）。
    // 熄火时故意返回"未知设置"而不是"功能已关闭"，
    // 是为了**不泄露任何语音相关的字眼**（避免用户追问一个不该存在的功能）。
    if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
      // 中文补充：动态 import —— 语音模块只在真要用到时才加载，
      // 既省启动开销，也避免把它拖进不带语音功能的产物。
      const { isVoiceGrowthBookEnabled } = await import(
        '../../voice/voiceModeEnabled.js'
      )
      if (!isVoiceGrowthBookEnabled()) {
        return {
          data: { success: false, error: `Unknown setting: "${setting}"` },
        }
      }
    }
    // 中文补充：**白名单闸门**。模型幻觉出的设置名、或者试图改危险字段，
    // 都在这里被挡下。返回明确错误让模型自我纠正。
    if (!isSupported(setting)) {
      return {
        data: { success: false, error: `Unknown setting: "${setting}"` },
      }
    }

    // 中文补充：`!` 非空断言 —— 上面 isSupported 已经确认存在，
    // 但 TS 看不出这个关联，所以用 ! 让编译器闭嘴（≈ Java 强转）。
    const config = getConfig(setting)!
    const path = getPath(setting)

    // 2. GET operation
    // 中文补充：**没传 value 就是读**。读操作不需要任何校验和权限，直接返回。
    if (value === undefined) {
      const currentValue = getValue(config.source, path)
      // 中文补充：formatOnRead 是"读出来之后的展示格式化"钩子。
      // 比如 model 的 null 会被显示成 'default'，比直接给 null 友好得多。
      const displayValue = config.formatOnRead
        ? config.formatOnRead(currentValue)
        : currentValue
      return {
        data: { success: true, operation: 'get', setting, value: displayValue },
      }
    }

    // 3. SET operation

    // Handle "default" — unset the config key so it falls back to the
    // platform-aware default (determined by the bridge feature gate).
    // 中文补充："恢复默认"的实现是 **delete 掉这个键**，而不是设成某个值。
    // 这是关键区别：false 和"没设置"在语义上完全不同——
    // "没设置"会让程序按平台特性自己决定（比如有 bridge 就开、没有就不开），
    // 而写死 false 会永远关掉它。
    // ≈ Java 里 Map.remove(key) 和 map.put(key, false) 的区别。
    if (
      setting === 'remoteControlAtStartup' &&
      typeof value === 'string' &&
      value.toLowerCase().trim() === 'default'
    ) {
      // 中文补充：传**更新函数**而不是新值 ≈ Java 的 map.compute()。
      // 好处是读-改-写在配置层是原子的，避免并发下丢修改。
      saveGlobalConfig(prev => {
        // 中文补充：值没变就返回原对象（不产生新对象）——
        // 这样下游的"引用比较"能判断出"什么都没变"，避免无谓重渲染。
        if (prev.remoteControlAtStartup === undefined) return prev
        const next = { ...prev }
        delete next.remoteControlAtStartup
        return next
      })
      // 中文补充：删掉键之后重新问一次"现在解析出来的值是什么"，
      // 这个才是真正生效的值（由平台特性决定）。
      const resolved = getRemoteControlAtStartup()
      // Sync to AppState so useReplBridge reacts immediately
      // 中文补充：**同步内存状态**——只改文件的话要重启才生效。
      // 这里立刻更新 AppState，UI 上相关功能马上就能响应。
      context.setAppState(prev => {
        if (prev.replBridgeEnabled === resolved && !prev.replBridgeOutboundOnly)
          return prev
        return {
          ...prev,
          replBridgeEnabled: resolved,
          replBridgeOutboundOnly: false,
        }
      })
      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          value: resolved,
        },
      }
    }

    // 中文补充：finalValue 是"转换后的最终值"。声明成 unknown
    // （≈ Java 的 Object）——因为它是字符串/布尔/数字都可能，
    // 后面每一步都会做类型收窄。
    let finalValue: unknown = value

    // Coerce and validate boolean values
    // 中文补充：**类型强制转换**。模型经常把布尔值写成字符串 "true"
    // （因为 JSON schema 里 value 是 string|boolean|number 联合，
    // 它拿不准）。这里宽容地接受并转换，而不是报错。
    // 这是典型的"输入宽容、输出严格"原则。
    if (config.type === 'boolean') {
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim()
        if (lower === 'true') finalValue = true
        else if (lower === 'false') finalValue = false
      }
      // 中文补充：转换完还不是 boolean（比如传了 "yes" 或 123），
      // 那就明确报错，并**告诉模型正确格式**是什么。
      if (typeof finalValue !== 'boolean') {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: `${setting} requires true or false.`,
          },
        }
      }
    }

    // Check options
    const options = getOptionsForSetting(setting)
    if (options && !options.includes(String(finalValue))) {
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: `Invalid value "${value}". Options: ${options.join(', ')}`,
        },
      }
    }

    // Async validation (e.g., model API check)
    if (config.validateOnWrite) {
      const result = await config.validateOnWrite(finalValue)
      if (!result.valid) {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: result.error,
          },
        }
      }
    }

    // Pre-flight checks for voice mode
    if (
      feature('VOICE_MODE') &&
      setting === 'voiceEnabled' &&
      finalValue === true
    ) {
      const { isVoiceModeEnabled } = await import(
        '../../voice/voiceModeEnabled.js'
      )
      if (!isVoiceModeEnabled()) {
        const { isAnthropicAuthEnabled } = await import('../../utils/auth.js')
        return {
          data: {
            success: false,
            error: !isAnthropicAuthEnabled()
              ? 'Voice mode requires a Claude.ai account. Please run /login to sign in.'
              : 'Voice mode is not available.',
          },
        }
      }
      const { isVoiceStreamAvailable } = await import(
        '../../services/voiceStreamSTT.js'
      )
      const {
        checkRecordingAvailability,
        checkVoiceDependencies,
        requestMicrophonePermission,
      } = await import('../../services/voice.js')

      const recording = await checkRecordingAvailability()
      if (!recording.available) {
        return {
          data: {
            success: false,
            error:
              recording.reason ??
              'Voice mode is not available in this environment.',
          },
        }
      }
      if (!isVoiceStreamAvailable()) {
        return {
          data: {
            success: false,
            error:
              'Voice mode requires a Claude.ai account. Please run /login to sign in.',
          },
        }
      }
      const deps = await checkVoiceDependencies()
      if (!deps.available) {
        return {
          data: {
            success: false,
            error:
              'No audio recording tool found.' +
              (deps.installCommand ? ` Run: ${deps.installCommand}` : ''),
          },
        }
      }
      if (!(await requestMicrophonePermission())) {
        let guidance: string
        if (process.platform === 'win32') {
          guidance = 'Settings \u2192 Privacy \u2192 Microphone'
        } else if (process.platform === 'linux') {
          guidance = "your system's audio settings"
        } else {
          guidance =
            'System Settings \u2192 Privacy & Security \u2192 Microphone'
        }
        return {
          data: {
            success: false,
            error: `Microphone access is denied. To enable it, go to ${guidance}, then try again.`,
          },
        }
      }
    }

    const previousValue = getValue(config.source, path)

    // 4. Write to storage
    try {
      if (config.source === 'global') {
        const key = path[0]
        if (!key) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: 'Invalid setting path',
            },
          }
        }
        saveGlobalConfig(prev => {
          if (prev[key as keyof GlobalConfig] === finalValue) return prev
          return { ...prev, [key]: finalValue }
        })
      } else {
        const update = buildNestedObject(path, finalValue)
        const result = updateSettingsForSource('userSettings', update)
        if (result.error) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: result.error.message,
            },
          }
        }
      }

      // 5a. Voice needs notifyChange so applySettingsChange resyncs
      // AppState.settings (useVoiceEnabled reads settings.voiceEnabled)
      // and the settings cache resets for the next /voice read.
      if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
        const { settingsChangeDetector } = await import(
          '../../utils/settings/changeDetector.js'
        )
        settingsChangeDetector.notifyChange('userSettings')
      }

      // 5b. Sync to AppState if needed for immediate UI effect
      if (config.appStateKey) {
        const appKey = config.appStateKey
        context.setAppState(prev => {
          if (prev[appKey] === finalValue) return prev
          return { ...prev, [appKey]: finalValue }
        })
      }

      // Sync remoteControlAtStartup to AppState so the bridge reacts
      // immediately (the config key differs from the AppState field name,
      // so the generic appStateKey mechanism can't handle this).
      if (setting === 'remoteControlAtStartup') {
        const resolved = getRemoteControlAtStartup()
        context.setAppState(prev => {
          if (
            prev.replBridgeEnabled === resolved &&
            !prev.replBridgeOutboundOnly
          )
            return prev
          return {
            ...prev,
            replBridgeEnabled: resolved,
            replBridgeOutboundOnly: false,
          }
        })
      }

      logEvent('tengu_config_tool_changed', {
        setting:
          setting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: String(
          finalValue,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          previousValue,
          newValue: finalValue,
        },
      }
    } catch (error) {
      logError(error)
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: errorMessage(error),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.success) {
      if (content.operation === 'get') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `${content.setting} = ${jsonStringify(content.value)}`,
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `Set ${content.setting} to ${jsonStringify(content.newValue)}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Error: ${content.error}`,
      is_error: true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function getValue(source: 'global' | 'settings', path: string[]): unknown {
  if (source === 'global') {
    const config = getGlobalConfig()
    const key = path[0]
    if (!key) return undefined
    return config[key as keyof GlobalConfig]
  }
  const settings = getInitialSettings()
  let current: unknown = settings
  for (const key of path) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

function buildNestedObject(
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) {
    return {}
  }
  const key = path[0]!
  if (path.length === 1) {
    return { [key]: value }
  }
  return { [key]: buildNestedObject(path.slice(1), value) }
}
