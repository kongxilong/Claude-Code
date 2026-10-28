/**
 * 【一句话定位】PowerShell Constrained Language Mode（约束语言模式，简称 CLM）
 * 的"类型白名单"清单 + 类型名归一化/判定工具。一句话：判断脚本里出现的
 * .NET 类型字面量（如 [int]、[System.Net.WebClient]）是否安全。
 *
 * 【在架构中的位置】（自下往上）
 *   powershellSecurity.ts（AST 遍历遇到 TypeName 节点时）
 *        ──调用──> isClmAllowedType(typeName)  ←── 本文件
 *                       └──> normalizeTypeName() 归一化后再查 CLM_ALLOWED_TYPES
 *   powershellSecurity.ts ──> powershellPermissions.ts ──> PowerShellTool.tsx
 *   （PowerShellTool.tsx 是执行入口，决定是否弹权限确认框）
 *
 *   对照 BashTool：这个文件**没有** Bash 对应物。
 *   bash 世界里没有"类型forced转换加载任意 .NET 程序集"这种攻击面，
 *   所以 BashTool 只有 bashSecurity.ts / bashPermissions.ts 两层；
 *   PowerShell 多出来的一层风险就是本文件要挡的东西。
 *
 * 【核心思路：把微软的白名单反过来用】
 *   微软 CLM 的本意是给"受信任域内的 Windows 管理员"兜底，
 *   所以它放行了一批类型（adsi/adsisearcher/wmi/cimsession 等）。
 *   这些类型一旦做强制类型转换就会发起**网络连接**（LDAP 绑定、远程 WMI 查询），
 *   对 Claude Code 这种"跑模型生成的不受信任脚本"的场景是危险的。
 *   所以我们不是照抄微软清单，而是在它的基础上做减法（见下方 SECURITY 注释），
 *   并且把逻辑反转：不在白名单里 → 一律 ask（弹框问用户），
 *   而不是去穷举"哪些类型危险"（黑名单永远列不全）。
 *
 * 【本文件包含什么】
 *   CLM_ALLOWED_TYPES：ReadonlySet<string>，全部小写存放的类型白名单。
 *   normalizeTypeName()：把 AST 里的类型名统一成可比较形式（去数组/泛型后缀、转小写）。
 *   isClmAllowedType()：查表判定入口，不安全就返回 false。
 *
 * 【TS 语法速查】
 *   ReadonlySet<string>
 *     ≈ Java: Set<String>，但编译期禁止 add/delete（类似 Collections.unmodifiableSet
 *     的类型化版本）。运行时仍是普通 Set，是编译期约束不是运行时不可变。
 *   new Set([...].map(t => t.toLowerCase()))
 *     ≈ Java: new HashSet<>(list.stream().map(String::toLowerCase).toList())
 *     Array.prototype.map ≈ stream().map()；箭头函数 ≈ lambda。
 *   export function f(name: string): string { ... }
 *     注意 TS 的类型标注写在变量名/参数名**后面**（冒号 + 类型），返回值在参数
 *     列表后面。Java 是写在前面（String name）。这是最容易看串的一点。
 *   链式 .toLowerCase().replace(...).replace(...).trim()
 *     ≈ Java String 的链式调用，语义完全一致；字符串不可变，每次返回新串。
 */
/**
 * PowerShell Constrained Language Mode allowed types.
 *
 * Microsoft's CLM restricts .NET type usage to this allowlist when PS runs
 * under AppLocker/WDAC system lockdown. Any type NOT in this set is considered
 * unsafe for untrusted code execution.
 *
 * We invert this: type literals not in this set → ask. One canonical check
 * replaces enumerating individual dangerous types (named pipes, reflection,
 * process spawning, P/Invoke marshaling, etc.). Microsoft maintains the list.
 *
 * Source: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes
 *
 * Normalization: entries stored lowercase, short AND full names where both
 * exist (PS resolves type accelerators like [int] → System.Int32 at runtime;
 * we match against what the AST emits, which is the literal text).
 */
export const CLM_ALLOWED_TYPES: ReadonlySet<string> = new Set(
// TS：`.map(t => t.toLowerCase())` ≈ Java stream().map(String::toLowerCase())；
// 之所以统一存小写，是因为 PowerShell 类型名大小写不敏感，
// 查表时也会把输入转小写 —— 一张小写表就能覆盖 [int]/[INT]/[Int] 所有写法。
  [
    // Type accelerators (short names as they appear in AST TypeName.Name)
    // SECURITY: 'adsi' and 'adsisearcher' REMOVED. Both are Active Directory
    // Service Interface types that perform NETWORK BINDS when cast:
    //   [adsi]'LDAP://evil.com/...' → connects to LDAP server
    //   [adsisearcher]'(objectClass=user)' → binds to AD and queries
    // Microsoft's CLM allows these because it's for Windows admins in trusted
    // domains; we block them since the target isn't validated.
// ===== 类型加速器区（PS 内置短名，如 [int] 实际是 System.Int32 的别名，
//       叫 type accelerator）=====
// 下面的「标量类型 + 校验 attribute」基本无害，直接放行。
    'alias',
    'allowemptycollection',
    'allowemptystring',
    'allownull',
    'argumentcompleter',
    'argumentcompletions',
    'array',
    'bigint',
    'bool',
    'byte',
    'char',
    'cimclass',
    'cimconverter',
    'ciminstance',
    // 'cimsession' REMOVED — see wmi/adsi comment below
    'cimtype',
    'cmdletbinding',
    'cultureinfo',
    'datetime',
    'decimal',
    'double',
    'dsclocalconfigurationmanager',
    'dscproperty',
    'dscresource',
    'experimentaction',
    'experimental',
    'experimentalfeature',
    'float',
    'guid',
    'hashtable',
    'int',
    'int16',
    'int32',
    'int64',
    'ipaddress',
    'ipendpoint',
    'long',
    'mailaddress',
    'norunspaceaffinity',
    'nullstring',
    'objectsecurity',
    'ordered',
    'outputtype',
    'parameter',
    'physicaladdress',
    'pscredential',
    'pscustomobject',
    'psdefaultvalue',
    'pslistmodifier',
    'psobject',
    'psprimitivedictionary',
    'pstypenameattribute',
    'ref',
    'regex',
    'sbyte',
    'securestring',
    'semver',
    'short',
    'single',
    'string',
    'supportswildcards',
    'switch',
    'timespan',
    'uint',
    'uint16',
    'uint32',
    'uint64',
    'ulong',
    'uri',
    'ushort',
    'validatecount',
    'validatedrive',
    'validatelength',
    'validatenotnull',
    'validatenotnullorempty',
    'validatenotnullorwhitespace',
    'validatepattern',
    'validaterange',
    'validatescript',
    'validateset',
    'validatetrusteddata',
    'validateuserdrive',
    'version',
    'void',
    'wildcardpattern',
    // SECURITY: 'wmi', 'wmiclass', 'wmisearcher', 'cimsession' REMOVED.
// ===== 被我们主动剔除的类型（微软原版放行，我们不放行）=====
// 中文补充：上面这段英文注释讲的就是 —— wmi/wmiclass/wmisearcher/cimsession
// 这四类一做强制类型转换就会发起**远程网络连接**（可被指向攻击者的主机），
// 且能访问 Win32_Process 这类危险 WMI 类。因此从微软清单里删掉。
    // WMI type casts perform WMI queries which can target remote computers
    // (network request) and access dangerous classes like Win32_Process.
    // cimsession creates a CIM session (network connection to remote host).
    //   [wmi]'\\evil-host\root\cimv2:Win32_Process.Handle="1"' → remote WMI
    //   [wmisearcher]'SELECT * FROM Win32_Process' → runs WQL query
    // Same rationale as adsi/adsisearcher removal above.
    'x500distinguishedname',
    'x509certificate',
    'xml',
    // Full names for accelerators that resolve to System.* (AST may emit either)
    'system.array',
    'system.boolean',
    'system.byte',
    'system.char',
    'system.datetime',
    'system.decimal',
    'system.double',
    'system.guid',
    'system.int16',
    'system.int32',
    'system.int64',
    'system.numerics.biginteger',
    'system.sbyte',
    'system.single',
    'system.string',
    'system.timespan',
    'system.uint16',
    'system.uint32',
    'system.uint64',
    'system.uri',
    'system.version',
    'system.void',
    'system.collections.hashtable',
    'system.text.regularexpressions.regex',
    'system.globalization.cultureinfo',
    'system.net.ipaddress',
    'system.net.ipendpoint',
    'system.net.mail.mailaddress',
    'system.net.networkinformation.physicaladdress',
    'system.security.securestring',
    'system.security.cryptography.x509certificates.x509certificate',
    'system.security.cryptography.x509certificates.x500distinguishedname',
    'system.xml.xmldocument',
// ===== 全称（Fully Qualified）区 =====
// 坑点：PS 的类型加速器在运行时会解析成 System.* 全称，
// 但不同 AST 解析器有时吐短名、有时吐全称，所以两种写法都要收进表里，
// 否则会出现「同一段脚本换个 PS 版本判断结果不同」的漏判。
    // System.Management.Automation.* — FQ equivalents of PS-specific accelerators
    'system.management.automation.pscredential',
    'system.management.automation.pscustomobject',
    'system.management.automation.pslistmodifier',
    'system.management.automation.psobject',
    'system.management.automation.psprimitivedictionary',
    'system.management.automation.psreference',
    'system.management.automation.semanticversion',
    'system.management.automation.switchparameter',
    'system.management.automation.wildcardpattern',
    'system.management.automation.language.nullstring',
    // Microsoft.Management.Infrastructure.* — FQ equivalents of CIM accelerators
    // SECURITY: cimsession FQ REMOVED — same network-bind hazard as short name
    // (creates a CIM session to a remote host).
    'microsoft.management.infrastructure.cimclass',
    'microsoft.management.infrastructure.cimconverter',
    'microsoft.management.infrastructure.ciminstance',
    'microsoft.management.infrastructure.cimtype',
    // FQ equivalents of remaining short-name accelerators
    // SECURITY: DirectoryEntry/DirectorySearcher/ManagementObject/
    // ManagementClass/ManagementObjectSearcher FQ REMOVED — same network-bind
    // hazard as short names adsi/adsisearcher/wmi/wmiclass/wmisearcher
    // (LDAP bind, remote WMI). See short-name removal comments above.
    'system.collections.specialized.ordereddictionary',
    'system.security.accesscontrol.objectsecurity',
    // Arrays of allowed types are allowed (e.g. [string[]])
// 'object' 也要放行：[object[]] 这类数组声明很常见，挡了会误伤正常脚本。
    // normalizeTypeName strips [] before lookup, so store the base name
    'object',
    'system.object',
    // ModuleSpecification — full qualified name
    'microsoft.powershell.commands.modulespecification',
  ].map(t => t.toLowerCase()),
)

/**
/**
 * 【中文】把 AST 里拿到的类型名（TypeName.FullName 或 TypeName.Name）
 * 归一化成可以直接跟白名单比较的形式。
 *
 * 为什么需要这一步：PowerShell 里同一个类型有 N 种写法 ——
 *   System.String / string / String[] / List[int] / ' string '
 * 如果直接拿原文去 Set 里查，白名单就得穷举所有变体，必然漏。
 *
 * @param name AST 节点上的原始文本，可能带数组后缀或泛型参数
 * @returns 小写、无后缀、无首尾空白的基名
 *
 * 步骤：① 转小写（PS 大小写不敏感）
 *      ② 去掉结尾的 []（数组标记，如 String[] → string）
 *      ③ 去掉泛型参数（List[int] → list，保守起见只查外层类型）
 *      ④ trim 去空格
 */
 * Normalize a type name from AST TypeName.FullName or TypeName.Name.
 * Handles array suffix ([]) and generic brackets.
 */
export function normalizeTypeName(name: string): string {
  // Strip array suffix: "String[]" → "string" (arrays of allowed types are allowed)
  // Strip generic args: "List[int]" → "list" (conservative — the generic wrapper
// 注意两个 replace 的顺序不能反（对应上面英文注释）：
// 先削 []（纯数组），再削 [xxx]（泛型），否则泛型的正则会先吃掉前者。
  // might be unsafe even if the type arg is safe, so we check the outer type)
  return name
    .toLowerCase()
    .replace(/\[\]$/, '')
    .replace(/\[.*\]$/, '')
    .trim()
}

/**
/**
 * 【中文】安全判定入口：这个类型是否允许出现在不受信任的脚本里？
 *
 * 判据是**白名单**（不在表里就是不安全的 fail-closed），
// 而不是黑名单 —— 因为「危险类型」永远列不全，而 CLM 原本就有一份
 * 微软维护的权威清单可以直接复用。
 *
 * @param typeName AST TypeName 节点的名字（原始大小写均可）
 * @returns true = 放行；false = 调用方应把它升级为 ask（弹权限框）
 */
 * True if typeName (from AST) is in Microsoft's CLM allowlist.
 * Types NOT in this set trigger ask — they access system APIs CLM blocks.
 */
export function isClmAllowedType(typeName: string): boolean {
  return CLM_ALLOWED_TYPES.has(normalizeTypeName(typeName))
}
