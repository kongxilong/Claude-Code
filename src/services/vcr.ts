/**
 * ============================================================================
 *  【文件总览】src/services/vcr.ts —— HTTP 交互的「录制 / 回放」测试工具（VCR）
 * ============================================================================
 *
 *  一句话定位：
 *  把真实调用 Claude API 得到的响应**存成 JSON 文件（fixture，测试夹具）**，
 *  下次跑测试时直接读文件返回，不再真的发网络请求。
 *  ≈ Java 世界的 **WireMock / Spring Cloud Contract / VCR（Ruby 同名gem）**。
 *
 *  在架构中的位置：
 *      src/services/api/claude.ts（真正发 API 请求的地方）
 *        ├─> withVCR(messages, 真请求函数)          非流式调用的录制/回放
 *        ├─> withStreamingVCR(messages, 真请求函数) 流式调用的录制/回放   ← 生成器版
 *        └─> withTokenCountVCR(messages, tools, ...)  token 计数接口的录制/回放
 *                                                              ↑ 全部 ★ 本文件
 *              └─> withFixture()  通用的「读缓存 / 写缓存」骨架
 *
 *  【为什么需要 VCR？——三个现实问题】
 *   ① **测试不能真的打线上 API**：又慢（每次几百毫秒到几秒）、又花钱、
 *      还依赖网络；CI 里更不可能配真密钥。
 *   ② **测试必须稳定可复现**：模型输出有随机性，同一份输入两次调用可能结果不同，
 *      断言就会「时好时坏」（flaky test）。录下来之后每次回放完全一致。
 *   ③ **能测到真实的数据形状**：比手写 mock 数据更真实——它是真实响应抄下来的，
 *      字段结构、嵌套层级都跟线上一致，不会写出「mock 里能过、线上就崩」的测试。
 *
 *  【核心概念：fixture 文件名 = 输入的哈希】
 *  这是整个文件的设计基石：把「请求内容」序列化后取 SHA1 哈希，
 *  用哈希当文件名（如 `fixtures/ab12cd-34ef56.json`）。
 *  这样「同样的输入 → 必然找到同一个 fixture」，不需要任何注册/映射表。
 *  ≈ Java 里用 `Map<String, Response>` 做 stub，但 key 是自动算出来的内容摘要。
 *
 *  【核心概念：dehydrate（脱水）/ hydrate（复水）】
 *  录制时要把「每次都变的东西」替换成占位符，回放时再换回来。
 *  否则 fixture 永远命中不了——想想看：
 *    - 绝对路径 `/Users/zhangsan/project` 在不同人机器上不同 → 替换成 `[CWD]`
 *    - 配置目录 `~/.claude` 不同 → 替换成 `[CONFIG_HOME]`
 *    - 文件个数 `num_files="17"`、耗时 `duration_ms="823"` 每次都变 → 替换成 `[NUM]`/`[DURATION]`
 *  这套「脱水 → 存盘 → 复水」的机制，是让 fixture 能**跨机器、跨平台复用**的关键。
 *  ≈ Java 测试里常见的「断言前先把时间戳、临时目录路径 normalize 掉」。
 *
 *  【录制模式怎么开】
 *  默认只读不放（回放模式）。要重新录制必须显式设环境变量 `VCR_RECORD=1`。
 *  在 CI 上如果 fixture 缺失会**直接抛错**并提示「请带 VCR_RECORD=1 重跑并提交」，
 *  而不是偷偷去打真实 API——这是防止「CI 悄悄依赖网络」的护栏。
 *
 * ---------------------------------------------------------------------------
 *  【本文件包含什么】
 * ---------------------------------------------------------------------------
 *   1. shouldUseVCR()           总开关：当前环境要不要启用 VCR
 *   2. withFixture()            通用骨架：按哈希找 fixture，没有就跑真函数并写盘
 *   3. withVCR()                消息级 API 调用的录制/回放（非流式）
 *   4. withStreamingVCR()       流式版本（async generator）
 *   5. withTokenCountVCR()      token 计数接口的录制/回放
 *   6. addCachedCostToTotalSessionCost()  回放时把「当时花了多少钱」补记进成本统计
 *   7. mapMessages() / mapValuesDeep() / mapAssistantMessage() / mapMessage()
 *                              递归遍历消息树，对每个字符串做 dehydrate/hydrate
 *   8. dehydrateValue() / hydrateValue()  单个字符串的脱水/复水规则
 *
 * ---------------------------------------------------------------------------
 *  【TS 语法速查】（针对本文件实际出现的写法）
 * ---------------------------------------------------------------------------
 *  - `async function withFixture<T>(...): Promise<T>`  **泛型函数**。
 *      `<T>` 是类型参数，调用时自动推断。≈ Java 的 `<T> CompletableFuture<T> withFixture(...)`。
 *
 *  - `f: () => Promise<T>`  **函数类型的参数**（高阶函数）。
 *      把「真正干活的异步函数」当一个值传进来，由 withFixture 决定要不要调它。
 *      ≈ Java 的 `Supplier<CompletableFuture<T>>`，这是实现「缓存/代理」的通用套路。
 *
 *  - `export async function* withStreamingVCR(...)`  **异步生成器**。
 *      既有 async 又有 `*`，可以 `yield` 多次。
 *      ≈ Java 的 `Flux<T>`（Reactor）：边产生边消费，用于流式数据。
 *
 *  - `yield* f()`  委托给另一个生成器，把它的产出**原样透传**。
 *      ≈ 把内层 Flux flatMap 摊平进外层流。与 `yield f()` 的区别：
 *        `yield` 会把整个生成器对象当一个值吐出去，`yield*` 不会包这一层。
 *
 *  - `for await (const m of f())`  消费异步生成器。
 *      ≈ Java 里 Flux 的 `.subscribe()` 或 `for` + blockingIterable，但原生支持异步。
 *
 *  - `as T` / `as unknown as UUID`  类型断言 ≈ Java 强制转换 `(T) x`，运行时不检查。
 *      `as unknown as UUID` 是「双重转换」：当两个类型差距太大编译器不让直接转时，
 *      先转成 unknown（万物之母）再转成目标类型。这里是往字符串塞一个 UUID  branded 类型。
 *
 *  - `(UserMessage | AssistantMessage)['message']['content'][]`
 *      **索引访问类型**：先取联合类型，再用 `['message']['content']` 一路取到嵌套字段的类型。
 *      ≈ Java 里没有；想象成「反射取字段类型的编译期版本」，避免手写重复的类型。
 *
 *  - `_.map(_ => ...)`  用 `_` 作变量名（lodash 风格）。注意内层 `_.map(_ => ...)` 里
 *      外层的 `_` 被内层的 `_` **遮蔽（shadow）**了——阅读时要小心区分层级。
 *
 *  - `{ ..._, text: f(_.text) }`  展开 + 覆盖 = **不可变更新**（造新对象，不改原对象）。
 *
 *  - `uuid?: UUID`  可选参数，等价于 `UUID | undefined`。
 *
 *  - `uuid ?? ('UUID-${index}' as ...)`  空值合并：左边不是 null/undefined 就用左边。
 *      ⚠️ 与 `||` 的区别：`??` 只在 null/undefined 时兜底，
 *      `''` 和 `0` 不会被替换掉（这里恰好要保留空串语义，所以用 `??`）。
 *
 *  - `.filter(Boolean)`  把数组里的 falsy 值（undefined/null/''）全部过滤掉。
 *      因为前面的 switch 里有 `return undefined` 分支。
 *      ≈ Java 的 `.filter(Objects::nonNull)`，但更宽（连空串也过滤）。
 *
 *  - `mapValues(obj, fn)`  lodash：把对象的**值**逐个映射，键保持不变。
 *      ≈ Java 的 `map.entrySet().stream().collect(toMap(k, v->fn(v)))`。
 *
 *  - `getErrnoCode(e) !== 'ENOENT'`  ENOENT = "文件不存在"。
 *      这里的模式是「用异常类型区分『缓存未命中』与『真的出错』」：
 *      只有文件不存在才继续往下走（去录制），其它错误一律抛出。
 *
 *  - `process.env.X ?? getCwd()`  `??` 处理环境变量未设置的情况。
 * ============================================================================
 */
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { createHash, randomUUID, type UUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import isPlainObject from 'lodash-es/isPlainObject.js'
import mapValues from 'lodash-es/mapValues.js'
import { dirname, join } from 'path'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../types/message.js'
import { getCwd } from '../utils/cwd.js'
import { env } from '../utils/env.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../utils/envUtils.js'
import { getErrnoCode } from '../utils/errors.js'
import { normalizeMessagesForAPI } from '../utils/messages.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

/**
 * 判断当前环境是否启用 VCR（录制/回放）。
 *
 * 为什么需要：VCR 只在测试环境下生效，绝不能影响真实用户。
 * 两条启用路径：
 *   ① NODE_ENV === 'test'                        —— 跑单元测试时自动开
 *   ② 内部员工 + 环境变量 FORCE_VCR 为真值       —— 内部手动调试时强制开
 *
 * @returns true = 启用录制/回放；false = 直接走真实网络请求
 */
function shouldUseVCR(): boolean {
  if (process.env.NODE_ENV === 'test') {
    return true
  }

  if (process.env.USER_TYPE === 'ant' && isEnvTruthy(process.env.FORCE_VCR)) {
    return true
  }

  return false
}

/**
 * Generic fixture management helper
 * Handles caching, reading, writing fixtures for any data type
 */
/**
 * 通用的 fixture 读写骨架：有缓存就回放，没缓存就跑真函数并录下来。
 *
 * 为什么需要：本文件里有好几处（token 计数等）都要「读缓存 / 没有就录制 / 再写盘」
 * 这一模一样三步，抽成泛型函数后，各处只需提供「输入」和「真函数」即可。
 *
 * 关键步骤：
 *   ① 未启用 VCR 时直接执行真函数返回（透传，零开销）
 *   ② 把 input 序列化后取 SHA1，截前 12 位当文件名 → 相同输入必命中同一文件
 *   ③ 尝试读盘：读到就是缓存命中，直接返回
 *   ④ 读不到文件时，只有 ENOENT（文件不存在）才算「未命中」；
 *      其它错误（权限、磁盘坏）一律抛出，绝不能静默走网络掩盖问题
 *   ⑤ CI 上未命中且没开 VCR_RECORD → 抛错并提示怎么重录（护栏，防止 CI 偷连网络）
 *   ⑥ 真正执行 f()，把结果写进 fixture 文件再返回
 *
 * @param input       用于生成文件名哈希的输入（任意可序列化对象）
 * @param fixtureName fixture 名前缀，便于人肉区分不同用途的 fixture
 * @param f           缓存未命中时才执行的「真函数」
 * @returns 回放结果或真实结果
 */
async function withFixture<T>(
  input: unknown,
  fixtureName: string,
  f: () => Promise<T>,
): Promise<T> {
  if (!shouldUseVCR()) {
    return await f()
  }

  // Create hash of input for fixture filename
  const hash = createHash('sha1')
    .update(jsonStringify(input))
    .digest('hex')
    .slice(0, 12)
  const filename = join(
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT ?? getCwd(),
    `fixtures/${fixtureName}-${hash}.json`,
  )

  // Fetch cached fixture
  try {
    const cached = jsonParse(
      await readFile(filename, { encoding: 'utf8' }),
    ) as T
    return cached
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
  }

  if ((env.isCI || process.env.CI) && !isEnvTruthy(process.env.VCR_RECORD)) {
    throw new Error(
      `Fixture missing: ${filename}. Re-run tests with VCR_RECORD=1, then commit the result.`,
    )
  }

  // Create & write new fixture
  const result = await f()

  await mkdir(dirname(filename), { recursive: true })
  await writeFile(filename, jsonStringify(result, null, 2), {
    encoding: 'utf8',
  })

  return result
}

/**
 * 对「一次完整的 Claude API 调用」做录制/回放（非流式版本）。
 *
 * 为什么需要：这是 VCR 的主力入口。测试里每次调模型都走这里，
 * 命中 fixture 时零网络、零花费、结果完全确定。
 *
 * 关键步骤：
 *   ① 未启用 VCR 时透传给真函数
 *   ② 归一化消息、并**剔除 isMeta 的用户消息**（那些是本地注入的元信息，
 *      每次内容都可能不同，不该参与哈希，否则永远命中不了）
 *   ③ 对消息内容做「脱水」：把 cwd、config home、数字、耗时等易变内容换成占位符
 *   ④ 由脱水后的内容算哈希 → 拼出 fixture 文件名
 *   ⑤ 读盘命中则复水（占位符换回真实路径）、补记成本，返回
 *   ⑥ 未命中：CI 上抛错；本地则跑真请求，把「输入+输出」一起写盘留作下次用
 *
 * @param messages 发给模型的完整消息列表
 * @param f        真正发请求的函数（缓存未命中时才调用）
 * @returns 模型响应（助手消息 / 流事件 / API 错误消息）
 */
export async function withVCR(
  messages: Message[],
  f: () => Promise<(AssistantMessage | StreamEvent | SystemAPIErrorMessage)[]>,
): Promise<(AssistantMessage | StreamEvent | SystemAPIErrorMessage)[]> {
  if (!shouldUseVCR()) {
    return await f()
  }

  const messagesForAPI = normalizeMessagesForAPI(
    messages.filter(_ => {
      if (_.type !== 'user') {
        return true
      }
      if (_.isMeta) {
        return false
      }
      return true
    }),
  )

  const dehydratedInput = mapMessages(
    messagesForAPI.map(_ => _.message.content),
    dehydrateValue,
  )
  const filename = join(
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT ?? getCwd(),
    `fixtures/${dehydratedInput.map(_ => createHash('sha1').update(jsonStringify(_)).digest('hex').slice(0, 6)).join('-')}.json`,
  )

  // Fetch cached fixture
  try {
    const cached = jsonParse(
      await readFile(filename, { encoding: 'utf8' }),
    ) as { output: (AssistantMessage | StreamEvent)[] }
    cached.output.forEach(addCachedCostToTotalSessionCost)
    return cached.output.map((message, index) =>
      mapMessage(message, hydrateValue, index, randomUUID()),
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
  }

  if (env.isCI && !isEnvTruthy(process.env.VCR_RECORD)) {
    throw new Error(
      `Anthropic API fixture missing: ${filename}. Re-run tests with VCR_RECORD=1, then commit the result. Input messages:\n${jsonStringify(dehydratedInput, null, 2)}`,
    )
  }

  // Create & write new fixture
  const results = await f()
  if (env.isCI && !isEnvTruthy(process.env.VCR_RECORD)) {
    return results
  }

  await mkdir(dirname(filename), { recursive: true })
  await writeFile(
    filename,
    jsonStringify(
      {
        input: dehydratedInput,
        output: results.map((message, index) =>
          mapMessage(message, dehydrateValue, index),
        ),
      },
      null,
      2,
    ),
    { encoding: 'utf8' },
  )
  return results
}

/**
 * 回放 fixture 时，把「当年那次调用花了多少钱」补记进本次会话的成本统计。
 *
 * 为什么需要：回放不花钱，但界面上显示的 `$0.12` 之类成本数字来自真实响应里的 usage。
 * 如果不补记，跑测试时成本统计就一直是 0，那些跟成本相关的断言/显示就测不到。
 *
 * @param message 一条助手消息或流事件；流事件不携带 usage，直接跳过
 */
function addCachedCostToTotalSessionCost(
  message: AssistantMessage | StreamEvent,
): void {
  if (message.type === 'stream_event') {
    return
  }
  const model = message.message.model
  const usage = message.message.usage
  const costUSD = calculateUSDCost(model, usage)
  addToTotalSessionCost(costUSD, usage, model)
}

/**
 * 递归遍历消息内容树，对所有字符串应用 f（dehydrate 或 hydrate）。
 *
 * 为什么需要：消息内容是**深层嵌套**的结构——
 * 顶层数组 → content block（text / tool_use / tool_result / image）→
 * 其中 tool_use 的 input 又是任意嵌套的对象/数组。
 * 必须递归下去才能把所有字符串都处理到，漏一层就会留下本机专属路径，
 * 导致 fixture 换个机器就命中不了。
 *
 * 注意：image 类型**原样返回**——图片是 base64 大二进制串，
 * 既不该做占位符替换（没有意义），也会白白拖慢哈希计算。
 *
 * @param messages 各条消息的 content 数组
 * @param f        对每个叶子字符串施加的变换
 * @returns 结构相同、字符串已被替换的新结构
 */
function mapMessages(
  messages: (UserMessage | AssistantMessage)['message']['content'][],
  f: (s: unknown) => unknown,
): (UserMessage | AssistantMessage)['message']['content'][] {
  return messages.map(_ => {
    if (typeof _ === 'string') {
      return f(_)
    }
    return _.map(_ => {
      switch (_.type) {
        case 'tool_result':
          if (typeof _.content === 'string') {
            return { ..._, content: f(_.content) }
          }
          if (Array.isArray(_.content)) {
            return {
              ..._,
              content: _.content.map(_ => {
                switch (_.type) {
                  case 'text':
                    return { ..._, text: f(_.text) }
                  case 'image':
                    return _
                  default:
                    return undefined
                }
              }),
            }
          }
          return _
        case 'text':
          return { ..._, text: f(_.text) }
        case 'tool_use':
          return {
            ..._,
            input: mapValuesDeep(_.input as Record<string, unknown>, f),
          }
        case 'image':
          return _
        default:
          return undefined
      }
    })
  }) as (UserMessage | AssistantMessage)['message']['content'][]
}

/**
 * 对任意嵌套的对象/数组做深度遍历，对每个「叶子值」应用 f。
 *
 * 为什么需要：工具的 input 参数（`tool_use.input`）是**任意 JSON**，
 * 结构不固定、嵌套层数不定，无法像上面那样写死 switch 分支。
 * 只能靠递归 + 运行时判断「是数组？是普通对象？还是叶子？」。
 *
 * 为什么用 isPlainObject 而不是 typeof === 'object'：
 * Date、RegExp、类实例等也是 object，但把它们当字典展开会破坏语义。
 * isPlainObject 只认 `{}` 字面量或 Object.create(null) 造出来的真·字典。
 *
 * @param obj 待遍历的对象（键 → 任意值）
 * @param f   叶子值变换函数（额外收到 key 和所属对象，便于按上下文定制）
 * @returns 同结构、叶子值已被替换的新对象
 */
function mapValuesDeep(
  obj: {
    [x: string]: unknown
  },
  f: (val: unknown, key: string, obj: Record<string, unknown>) => unknown,
): Record<string, unknown> {
  return mapValues(obj, (val, key) => {
    if (Array.isArray(val)) {
      return val.map(_ => mapValuesDeep(_, f))
    }
    if (isPlainObject(val)) {
      return mapValuesDeep(val as Record<string, unknown>, f)
    }
    return f(val, key, obj)
  })
}

/**
 * 对单条助手消息做字符串替换（dehydrate/hydrate），并顺便规范化 UUID 与引用。
 *
 * 【为什么 UUID 处理这么讲究】（原英文注释里解释得很清楚，这里复述）：
 * sessionStorage.ts 是按 UUID 给消息**去重**的。
 * 如果回放时所有 fixture 都用固定的 `UUID-0`、`UUID-1` 这类确定性 ID，
 * 那么一次会话里先后两次 VCR 调用产生的消息 ID 会撞车，
 * 恢复会话时就会被误判成「重复消息」而丢掉。
 * 所以：
 *   - 脱水写盘时：用 `UUID-<index>` 这种确定性 ID（保证 fixture 内容稳定可 diff）
 *   - 复水读出时：传入 randomUUID() 生成**全局唯一**的真 UUID（避免跨调用撞车）
 *
 * 另外 `citations: _.citations || []` 是补默认值：
 * 老 fixture 里可能没有 citations 字段，这里统一补成空数组，
 * 免得下游代码读到 undefined 而崩溃。
 *
 * @param message 原始助手消息
 * @param f       字符串变换（dehydrateValue 或 hydrateValue）
 * @param index   该消息在本次响应中的序号，用于生成确定性 UUID
 * @param uuid    复水路径传入的随机 UUID；脱水路径不传，走确定性的 `UUID-<index>`
 */
function mapAssistantMessage(
  message: AssistantMessage,
  f: (s: unknown) => unknown,
  index: number,
  uuid?: UUID,
): AssistantMessage {
  return {
    // Use provided UUID if given (hydrate path uses randomUUID for globally unique IDs),
    // otherwise fall back to deterministic index-based UUID (dehydrate/fixture path).
    // sessionStorage.ts deduplicates messages by UUID, so without unique UUIDs across
    // VCR calls, resumed sessions would treat different responses as duplicates.
    uuid: uuid ?? (`UUID-${index}` as unknown as UUID),
    requestId: 'REQUEST_ID',
    timestamp: message.timestamp,
    message: {
      ...message.message,
      content: message.message.content
        .map(_ => {
          switch (_.type) {
            case 'text':
              return {
                ..._,
                text: f(_.text) as string,
                citations: _.citations || [],
              } // Ensure citations
            case 'tool_use':
              return {
                ..._,
                input: mapValuesDeep(_.input as Record<string, unknown>, f),
              }
            default:
              return _ // Handle other block types unchanged
          }
        })
        .filter(Boolean) as BetaContentBlock[],
    },
    type: 'assistant',
  }
}

/**
 * 按消息类型分发：只有助手消息需要深挖内容做替换，其它类型原样返回。
 *
 * 为什么需要：响应数组是个联合类型（助手消息 / 系统错误 / 流事件），
 * 而「需要 dehydrate 的嵌套内容」只有 AssistantMessage 有。
 * 用这个分发函数可以让调用方写一行 map 而不必各自写类型判断。
 *
 * @param message 待处理的消息
 * @param f       字符串变换
 * @param index   序号（用于生成确定性 UUID）
 * @param uuid    可选的随机 UUID（复水路径用）
 * @returns 处理后的消息；非助手消息原样返回
 */
function mapMessage(
  message: AssistantMessage | SystemAPIErrorMessage | StreamEvent,
  f: (s: unknown) => unknown,
  index: number,
  uuid?: UUID,
): AssistantMessage | SystemAPIErrorMessage | StreamEvent {
  if (message.type === 'assistant') {
    return mapAssistantMessage(message, f, index, uuid)
  } else {
    return message
  }
}

/**
 * 「脱水」：把字符串里**每次运行都变**的内容替换成固定占位符。
 *
 * 为什么需要：这是让 fixture 能跨机器、跨平台复用的关键一步。
 * 不脱水的话，同一份测试在你机器和他机器上算出的哈希必然不同，
 * fixture 永远命中不了，CI 上就是一片红。
 *
 * 要处理哪些东西：
 *   ① 绝对路径      —— 工作目录 → [CWD]，配置目录 → [CONFIG_HOME]
 *   ② 易变数字      —— num_files / duration_ms / cost_usd → [NUM]/[DURATION]/[COST]
 *   ③ 命令清单      —— "Available commands: ..." 一长串 → 截成 [COMMANDS]
 *   ④ Windows 路径  —— 正斜杠变体、JSON 里被转义成双反斜杠的变体都要覆盖
 *   ⑤ 文件修改清单  —— 整段替换成 [FILES]
 *
 * 【踩过的坑 1：为什么不能简单粗暴把所有 `/` 换成 path.sep】
 * 见原英文注释：那会把 XML 风格的标签 `</system-reminder>` 破坏成
 * `<\system-reminder>`，直接把提示词结构搞坏。
 * 所以只能**精确地**替换那几个已知的根路径，而不是全局替换分隔符。
 *
 * 【踩过的坑 2：为什么最后还要把 `[CWD]\foo\bar` 统一成 `[CWD]/foo/bar`】
 * Windows 用反斜杠、macOS/Linux 用正斜杠，同一条路径在两种系统上
 * 序列化出来不一样，哈希就不同。把占位符后面的分隔符统一成正斜杠，
 * fixture 才能在 Windows 和 Mac 上**共用一份**。
 *
 * @param s 任意值；非字符串原样返回（便于直接塞进 mapValuesDeep）
 * @returns 脱水后的字符串
 */
function dehydrateValue(s: unknown): unknown {
  if (typeof s !== 'string') {
    return s
  }
  const cwd = getCwd()
  const configHome = getClaudeConfigHomeDir()
  let s1 = s
    .replace(/num_files="\d+"/g, 'num_files="[NUM]"')
    .replace(/duration_ms="\d+"/g, 'duration_ms="[DURATION]"')
    .replace(/cost_usd="\d+"/g, 'cost_usd="[COST]"')
    // Note: We intentionally don't replace all forward slashes with path.sep here.
    // That would corrupt XML-like tags (e.g., </system-reminder> -> <\system-reminder>).
    // The [CONFIG_HOME] and [CWD] replacements below handle path normalization.
    .replaceAll(configHome, '[CONFIG_HOME]')
    .replaceAll(cwd, '[CWD]')
    .replace(/Available commands:.+/, 'Available commands: [COMMANDS]')
  // On Windows, paths may appear in multiple forms:
  // 1. Forward-slash variants (Git, some Node APIs)
  // 2. JSON-escaped variants (backslashes doubled in serialized JSON within messages)
  if (process.platform === 'win32') {
    const cwdFwd = cwd.replaceAll('\\', '/')
    const configHomeFwd = configHome.replaceAll('\\', '/')
    // jsonStringify escapes \ to \\ - match paths embedded in JSON strings
    const cwdJsonEscaped = jsonStringify(cwd).slice(1, -1)
    const configHomeJsonEscaped = jsonStringify(configHome).slice(1, -1)
    s1 = s1
      .replaceAll(cwdJsonEscaped, '[CWD]')
      .replaceAll(configHomeJsonEscaped, '[CONFIG_HOME]')
      .replaceAll(cwdFwd, '[CWD]')
      .replaceAll(configHomeFwd, '[CONFIG_HOME]')
  }
  // Normalize backslash path separators after placeholders so VCR fixture
  // hashes match across platforms (e.g., [CWD]\foo\bar -> [CWD]/foo/bar)
  // Handle both single backslashes and JSON-escaped double backslashes (\\)
  s1 = s1
    .replace(/\[CWD\][^\s"'<>]*/g, match =>
      match.replaceAll('\\\\', '/').replaceAll('\\', '/'),
    )
    .replace(/\[CONFIG_HOME\][^\s"'<>]*/g, match =>
      match.replaceAll('\\\\', '/').replaceAll('\\', '/'),
    )
  if (s1.includes('Files modified by user:')) {
    return 'Files modified by user: [FILES]'
  }
  return s1
}

/**
 * 「复水」：dehydrateValue 的逆操作，把占位符换回**当前这台机器**的真实值。
 *
 * 为什么需要：回放时消息里如果还留着 `[CWD]`，
 * 模型（或下游逻辑）看到的路径就是假的，测试就失去意义了。
 * 所以读出来之后必须换回本机的真实工作目录和配置目录。
 *
 * 注意占位符的还原值是**固定假值**（[NUM]→1、[DURATION]→100）：
 * 反正这些数字每次都变，测试也不该断言它们，给个稳定的假值最省事。
 *
 * @param s 任意值；非字符串原样返回
 * @returns 复水后的字符串
 */
function hydrateValue(s: unknown): unknown {
  if (typeof s !== 'string') {
    return s
  }
  return s
    .replaceAll('[NUM]', '1')
    .replaceAll('[DURATION]', '100')
    .replaceAll('[CONFIG_HOME]', getClaudeConfigHomeDir())
    .replaceAll('[CWD]', getCwd())
}

/**
 * 流式 API 调用的录制/回放（withVCR 的生成器版本）。
 *
 * 为什么需要单独一个函数：流式响应的类型是 AsyncGenerator（边收边吐），
 * 不是一次性返回的数组，没法直接套用 withVCR。
 * 做法是把流「收集成数组」交给 withVCR 处理，再把结果「重新吐成流」。
 *
 * 关键步骤：
 *   ① 未启用 VCR 时用 `yield* f()` 把真实流原样透传（注意是 yield* 不是 yield）
 *   ② 启用时，先用 for await 把整个流收进 buffer
 *   ③ 把这个「收集动作」当作真函数传给 withVCR：
 *      命中缓存 → withVCR 返回缓存数组；未命中 → 跑一遍 buffer 收集并写盘
 *   ④ 把最终数组用 yield* 逐个吐出去，对调用方而言与真实流体验完全一致
 *
 * @param messages 发给模型的消息列表
 * @param f        真正发起流式请求的函数
 * @returns 异步生成器，逐个产出流事件/助手消息/错误消息
 */
export async function* withStreamingVCR(
  messages: Message[],
  f: () => AsyncGenerator<
    StreamEvent | AssistantMessage | SystemAPIErrorMessage,
    void
  >,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  if (!shouldUseVCR()) {
    return yield* f()
  }

  // Compute and yield messages
  const buffer: (StreamEvent | AssistantMessage | SystemAPIErrorMessage)[] = []

  // Record messages (or fetch from cache)
  const cachedBuffer = await withVCR(messages, async () => {
    for await (const message of f()) {
      buffer.push(message)
    }
    return buffer
  })

  if (cachedBuffer.length > 0) {
    yield* cachedBuffer
    return
  }

  yield* buffer
}

/**
 * token 计数接口的录制/回放。
 *
 * 为什么需要：token 计数（发给 API 问「这段消息多少个 token」）也是一次真实请求，
 * 测试里同样不该真发。但它比普通调用更容易「命中不了」，所以要额外脱水。
 *
 * 【为什么这里的脱水比 withVCR 更狠】（原英文注释重点强调的坑）：
 * token 计数的入参里包含**系统提示词**，而系统提示词里嵌着：
 *   - 当前工作目录的原始形式
 *   - 工作目录被转成「连字符 slug」后的形式（如 /Users/a/b → -Users-a-b，
 *     出现在 auto-memory 的路径里）
 *   - 每条消息每次运行都新生成的 UUID
 *   - 每次都不同的时间戳
 * 这些只要有一个没处理掉，每次跑测试算出的哈希就都不同，
 * fixture 在 CI 上就永远命中不了——等于白录。
 * 所以这里除了通用脱水，还额外替换 [CWD_SLUG] / [UUID] / [TIMESTAMP]。
 *
 * @param messages 待计数的消息
 * @param tools    工具定义（也参与哈希，因为工具也占 token）
 * @param f        真正去数 token 的函数
 * @returns token 数量；接口失败时为 null
 */
export async function withTokenCountVCR(
  messages: unknown[],
  tools: unknown[],
  f: () => Promise<number | null>,
): Promise<number | null> {
  // Dehydrate before hashing so fixture keys survive cwd/config-home/tempdir
  // variation and message UUID/timestamp churn. System prompts embed the
  // working directory (both raw and as a slash→dash project slug in the
  // auto-memory path) and messages carry fresh UUIDs per run; without this,
  // every test run produces a new hash and fixtures never hit in CI.
  const cwdSlug = getCwd().replace(/[^a-zA-Z0-9]/g, '-')
  const dehydrated = (
    dehydrateValue(jsonStringify({ messages, tools })) as string
  )
    .replaceAll(cwdSlug, '[CWD_SLUG]')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '[UUID]',
    )
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '[TIMESTAMP]')
  const result = await withFixture(dehydrated, 'token-count', async () => ({
    tokenCount: await f(),
  }))
  return result.tokenCount
}
