/**
 * ============================================================================
 *  【文件总览】src/tools/BriefTool/upload.ts
 * ============================================================================
 *
 *  【一句话定位】
 *  本文件实现 upload.ts 的相关逻辑（属于 Agent 工具/服务层的一部分）。
 *
 *  【在架构中的位置】
 *  由主循环 src/query.ts 在需要对应能力时，通过工具调度（runTools → 工具 execute）调用本文件；本文件属于「工具层」，负责把某一类能力封装成一个可被模型点名的 Tool。
 *
 *  【本文件包含什么】
 *  主要导出/定义：BriefUploadContext、uploadBriefAttachment
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

/**
 * Upload BriefTool attachments to private_api so web viewers can preview them.
 *
 * When the repl bridge is active, attachment paths are meaningless to a web
 * viewer (they're on Claude's machine). We upload to /api/oauth/file_upload —
 * the same store MessageComposer/SpaceMessage render from — and stash the
 * returned file_uuid alongside the path. Web resolves file_uuid → preview;
 * desktop/local try path first.
 *
 * Best-effort: any failure (no token, bridge off, network error, 4xx) logs
 * debug and returns undefined. The attachment still carries {path, size,
 * isImage}, so local-terminal and same-machine-desktop render unaffected.
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import { z } from 'zod/v4'

import {
  getBridgeAccessToken,
  getBridgeBaseUrlOverride,
} from '../../bridge/bridgeConfig.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// Matches the private_api backend limit
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

const UPLOAD_TIMEOUT_MS = 30_000

// Backend dispatches on mime: image/* → upload_image_wrapped (writes
// PREVIEW/THUMBNAIL, no ORIGINAL), everything else → upload_generic_file
// (ORIGINAL only, no preview). Only whitelist raster formats the
// transcoder reliably handles — svg/bmp/ico risk a 400, and pdf routes
// to upload_pdf_file_wrapped which also skips ORIGINAL. Dispatch
// viewers use /preview for images and /contents for everything else,
// so images go image/* and the rest go octet-stream.
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function debug(msg: string): void {
  logForDebugging(`[brief:upload] ${msg}`)
}

/**
 * Base URL for uploads. Must match the host the token is valid for.
 *
 * Subprocess hosts (cowork) pass ANTHROPIC_BASE_URL alongside
 * CLAUDE_CODE_OAUTH_TOKEN — prefer that since getOauthConfig() only
 * returns staging when USE_STAGING_OAUTH is set, which such hosts don't
 * set. Without this a staging token hits api.anthropic.com → 401 → silent
 * skip → web viewer sees inert cards with no file_uuid.
 */
function getBridgeBaseUrl(): string {
  return (
    getBridgeBaseUrlOverride() ??
    process.env.ANTHROPIC_BASE_URL ??
    getOauthConfig().BASE_API_URL
  )
}

// /api/oauth/file_upload returns one of ChatMessage{Image,Blob,Document}FileSchema.
// All share file_uuid; that's the only field we need.
const uploadResponseSchema = lazySchema(() =>
  z.object({ file_uuid: z.string() }),
)

export type BriefUploadContext = {
  replBridgeEnabled: boolean
  signal?: AbortSignal
}

/**
 * Upload a single attachment. Returns file_uuid on success, undefined otherwise.
 * Every early-return is intentional graceful degradation.
 */
export async function uploadBriefAttachment(
  fullPath: string,
  size: number,
  ctx: BriefUploadContext,
): Promise<string | undefined> {
  // Positive pattern so bun:bundle eliminates the entire body from
  // non-BRIDGE_MODE builds (negative `if (!feature(...)) return` does not).
  if (feature('BRIDGE_MODE')) {
    if (!ctx.replBridgeEnabled) return undefined

    if (size > MAX_UPLOAD_BYTES) {
      debug(`skip ${fullPath}: ${size} bytes exceeds ${MAX_UPLOAD_BYTES} limit`)
      return undefined
    }

    const token = getBridgeAccessToken()
    if (!token) {
      debug('skip: no oauth token')
      return undefined
    }

    let content: Buffer
    try {
      content = await readFile(fullPath)
    } catch (e) {
      debug(`read failed for ${fullPath}: ${e}`)
      return undefined
    }

    const baseUrl = getBridgeBaseUrl()
    const url = `${baseUrl}/api/oauth/file_upload`
    const filename = basename(fullPath)
    const mimeType = guessMimeType(filename)
    const boundary = `----FormBoundary${randomUUID()}`

    // Manual multipart — same pattern as filesApi.ts. The oauth endpoint takes
    // a single "file" part (no "purpose" field like the public Files API).
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mimeType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])

    try {
      const response = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length.toString(),
        },
        timeout: UPLOAD_TIMEOUT_MS,
        signal: ctx.signal,
        validateStatus: () => true,
      })

      if (response.status !== 201) {
        debug(
          `upload failed for ${fullPath}: status=${response.status} body=${jsonStringify(response.data).slice(0, 200)}`,
        )
        return undefined
      }

      const parsed = uploadResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        debug(
          `unexpected response shape for ${fullPath}: ${parsed.error.message}`,
        )
        return undefined
      }

      debug(`uploaded ${fullPath} → ${parsed.data.file_uuid} (${size} bytes)`)
      return parsed.data.file_uuid
    } catch (e) {
      debug(`upload threw for ${fullPath}: ${e}`)
      return undefined
    }
  }
  return undefined
}
