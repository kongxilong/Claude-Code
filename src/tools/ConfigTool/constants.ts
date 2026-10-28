/**
 * ============================================================================
 *  【文件总览】src/tools/ConfigTool/constants.ts —— Config 工具的常量
 * ============================================================================
 *
 *  【一句话定位】
 *  只导出一个常量：`CONFIG_TOOL_NAME = 'Config'`，
 *  也就是模型在对话里调用「读写设置」工具时使用的工具名。
 *
 *  【在架构中的位置】
 *
 *      用户："帮我把主题换成暗色"
 *        └─> 模型 → tool_use { name:'Config', input:{ setting:'theme',
 *                                                    value:'dark' } }
 *              └─> ConfigTool.checkPermissions()  ← 写操作要弹窗确认
 *                    └─> ConfigTool.call()        ← src/tools/ConfigTool/ConfigTool.ts
 *                          ├─> isSupported() / getConfig()  ← ./supportedSettings.ts
 *                          └─> saveGlobalConfig() 或 updateSettingsForSource()
 *
 *  本文件处在最底层：所有"需要引用 Config 工具名"的地方都从这里取，
 *  避免硬编码字符串散落各处、改名时漏改。
 *
 *  【本文件包含什么】
 *   1. CONFIG_TOOL_NAME —— 字符串常量 'Config'。
 *
 *  【TS 语法速查】
 *   - `export const X = 'v'` ≈ Java `public static final String X = "v";`
 *   - 没写 `: string`，TS 推断成**字面量类型** `'Config'` —— 比 string 精确，
 *     拼错会在编译期被抓到（≈ Java 用 enum 代替 String 常量的好处）。
 * ============================================================================
 */

// 工具名常量。集中定义的好处：① 将来改名只改一处；② 字面量类型能防拼写错误。
export const CONFIG_TOOL_NAME = 'Config'
