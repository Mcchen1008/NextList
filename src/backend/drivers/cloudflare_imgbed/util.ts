// CloudflareImgBed HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudflare_imgbed
// (util.go doRequest + upload.go standardUpload/chunkedUpload/hfDirectUpload)
import { sha256 } from "../../pkg/crypto"
import {
  CloudflareImgBedAddition,
  HfCommitResp,
  HfGetUrlResp,
  ImgBedApiError,
  ImgBedFileItem,
  ImgBedInitChunkedResp,
  ImgBedListedFile,
  ImgBedListResponse,
  ImgBedUploadResult,
} from "./types"

// OpenList drivers/base client.go UserAgent (set by base.NewRestyClient)
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

const LIST_API = "/api/manage/list"
const DELETE_API = "/api/manage/delete"
const UPLOAD_API = "/upload"
const HF_GET_URL_API = "/upload/huggingface/getUploadUrl"
const HF_COMMIT_API = "/upload/huggingface/commitUpload"
/** Go: files >= 20MB go through the large channel */
export const HF_DIRECT_THRESHOLD = 20 * 1024 * 1024
/** Go: HF getUploadUrl needs a sample of the first 512 bytes (base64) */
const FILE_SAMPLE_SIZE = 512
const LIST_PAGE_SIZE = 1000
/** Go chunkedUpload's chunkSizeMap is empty → chunk size always falls back to 5MB */
const CHUNK_UPLOAD_SIZE = 5 * 1024 * 1024
/** Go hfDirectUpload: default HF part size when header chunk_size is invalid */
const HF_DEFAULT_CHUNK_SIZE = 20 * 1024 * 1024
const API_TIMEOUT = 30_000 // Go base.DefaultTimeout
const UPLOAD_TIMEOUT = 600_000

export { USER_AGENT }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Go pkg/utils.EncodePath: escape only % ? # per path segment */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) =>
      seg.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23"),
    )
    .join("/")
}

/** Go types.go getInt64: safely extract an integer from the metadata map */
function getInt(m: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    if (k in m) {
      const v = m[k]
      if (typeof v === "string") {
        const n = parseInt(v, 10)
        return Number.isFinite(n) ? n : 0
      }
      if (typeof v === "number") return Math.trunc(v)
    }
  }
  return 0
}

/** Go types.go parseFile */
function parseFileItem(item: ImgBedFileItem): ImgBedListedFile {
  const path = "/" + (item.name || "").replace(/\/+$/, "")
  const segs = path.split("/").filter(Boolean)
  const name = segs.length ? segs[segs.length - 1] : path
  let size = 0
  let modifiedMs = 0
  if (item.metadata) {
    size = getInt(item.metadata, ["FileSizeBytes", "File-Size"])
    modifiedMs = getInt(item.metadata, ["TimeStamp"])
  }
  return { path, name, size, modifiedMs }
}

/** base64 of raw bytes (Workers/Node compatible, no Buffer) */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/** Minimal extension→mime map (Go uses the upload stream's mimetype) */
const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  m4v: "video/x-m4v",
  flv: "video/x-flv",
  wmv: "video/x-ms-wmv",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  aac: "audio/aac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/opus",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  pdf: "application/pdf",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
}

export function guessMimeType(fileName: string): string {
  const ext = (fileName.split(".").pop() || "").toLowerCase()
  return MIME_MAP[ext] || "application/octet-stream"
}

export interface ImgBedCommitResult {
  src: string
  publicUrl?: string
}

export interface ImgBedUploadParams {
  fileName: string
  mimeType: string
  content: Uint8Array<ArrayBuffer>
  size: number
  /** Go: dstDir.GetPath() — physical path of the destination folder */
  uploadFolder: string
}

export class CloudflareImgBedClient {
  private address: string
  private token: string
  private smallChannelName: string
  private largeChannelName: string
  private largeChannelType: string
  private uploadThread: number
  /** Go d.publicUrlPrefix — learned from upload responses (scheme://host) */
  publicUrlPrefix = ""

  constructor(addition: CloudflareImgBedAddition) {
    // Go Init(): strings.TrimRight(d.Address, "/")
    this.address = (addition.address || "").replace(/\/+$/, "")
    this.token = addition.token || ""
    this.smallChannelName = addition.smallChannelName || ""
    this.largeChannelName = addition.largeChannelName || ""
    this.largeChannelType = addition.largeChannelType || ""
    // Go Init(): UploadThread = min(max(1, UploadThread), 32), default 3
    let t = Number(addition.uploadThread)
    if (!Number.isFinite(t) || t < 1) t = 3
    this.uploadThread = Math.min(32, Math.floor(t))
  }

  getAddress(): string {
    return this.address
  }

  getLargeChannelType(): string {
    return this.largeChannelType
  }

  /**
   * Go util.go doRequest: 3 attempts, network errors retry with linear
   * backoff, 429 retries with 2x linear backoff, {error|message} body →
   * "API error", non-2xx → "HTTP <code>".
   */
  async doRequest<T>(
    method: "GET" | "POST",
    urlPath: string,
    opts?: {
      query?: Record<string, string>
      /** form fields → application/x-www-form-urlencoded (resty SetFormData) */
      form?: Record<string, string>
      /** JSON body (resty SetBody with map) */
      json?: unknown
    },
  ): Promise<T> {
    const maxRetries = 3
    for (let i = 0; i < maxRetries; i++) {
      const url = new URL(this.address + urlPath)
      if (opts?.query) {
        for (const [k, v] of Object.entries(opts.query)) {
          url.searchParams.set(k, v)
        }
      }

      const headers: Record<string, string> = {
        Authorization: "Bearer " + this.token,
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain, */*",
      }
      let body: string | undefined
      if (opts?.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        body = new URLSearchParams(opts.form).toString()
      } else if (opts?.json !== undefined) {
        headers["Content-Type"] = "application/json"
        body = JSON.stringify(opts.json)
      }

      let res: Response
      try {
        res = await fetch(url.toString(), {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(API_TIMEOUT),
        })
        if (res.status === 429) {
          // rate limited — retry before interpreting the body (Go semantics)
          await sleep((i + 1) * 2 * 1000)
          continue
        }
      } catch (e) {
        if (i < maxRetries - 1) {
          await sleep((i + 1) * 1000)
          continue
        }
        throw new Error(
          `[CloudflareImgBed] request ${method} ${urlPath} failed: ${(e as Error).message}`,
        )
      }

      const text = await res.text()
      let parsed: unknown = null
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          /* non-JSON body */
        }
      }
      const apiErr = parsed as ImgBedApiError | null
      if (
        apiErr &&
        typeof apiErr === "object" &&
        (apiErr.error || apiErr.message)
      ) {
        throw new Error(
          `[CloudflareImgBed] API error: ${apiErr.error || apiErr.message}`,
        )
      }
      if (!res.ok) {
        throw new Error(`[CloudflareImgBed] HTTP ${res.status}`)
      }
      return parsed as T
    }
    throw new Error(`[CloudflareImgBed] max retries exceeded for ${urlPath}`)
  }

  /** Go Init() connectivity probe: single-item root listing */
  async verifyConnection(): Promise<void> {
    await this.doRequest("GET", LIST_API, {
      query: { start: "0", count: "1", dir: "/" },
    })
  }

  /**
   * Go List(): paginated /api/manage/list with per-page dedup of
   * directories and files (page size 1000).
   */
  async listDir(dir: string): Promise<{
    dirs: string[]
    files: ImgBedListedFile[]
  }> {
    const dirSeen = new Set<string>()
    const fileSeen = new Set<string>()
    const dirs: string[] = []
    const files: ImgBedListedFile[] = []
    let start = 0
    for (;;) {
      const resp = await this.doRequest<ImgBedListResponse>("GET", LIST_API, {
        query: {
          dir,
          start: String(start),
          count: String(LIST_PAGE_SIZE),
        },
      })
      const respFiles = resp?.files || []
      const respDirs = resp?.directories || []
      if (respFiles.length === 0 && respDirs.length === 0) break

      for (const rawDir of respDirs) {
        // Go: "/" + strings.TrimRight(rawDir, "/")
        const normalized = "/" + (rawDir || "").replace(/\/+$/, "")
        if (!dirSeen.has(normalized)) {
          dirSeen.add(normalized)
          dirs.push(normalized)
        }
      }
      for (const item of respFiles) {
        if (!fileSeen.has(item.name)) {
          fileSeen.add(item.name)
          files.push(parseFileItem(item))
        }
      }

      // fewer items than the page size → done
      if (respFiles.length + respDirs.length < LIST_PAGE_SIZE) break
      start += LIST_PAGE_SIZE
    }
    return { dirs, files }
  }

  /** Go Remove(): POST /api/manage/delete/<path>?folder=<bool> */
  async deletePath(path: string, isFolder: boolean): Promise<void> {
    await this.doRequest("POST", DELETE_API + encodePath(path), {
      query: { folder: String(isFolder) },
    })
  }

  /** Go standardUpload(): single multipart form POST /upload */
  async standardUpload(p: ImgBedUploadParams): Promise<ImgBedUploadResult> {
    let channelName = this.smallChannelName
    if (p.size >= HF_DIRECT_THRESHOLD) {
      channelName = this.largeChannelName
      console.warn(
        `[CloudflareImgBed] large file (${p.size} bytes) falls back to standard upload, consider configuring largeChannelType`,
      )
    }
    if (!channelName) {
      throw new Error("[CloudflareImgBed] channel name not configured")
    }

    const url = new URL(this.address + UPLOAD_API)
    url.searchParams.set("returnFormat", "default")
    url.searchParams.set("channelName", channelName)
    url.searchParams.set("uploadFolder", p.uploadFolder)
    url.searchParams.set("autoRetry", "true")

    const form = new FormData()
    form.append("file", new Blob([p.content]), p.fileName)

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: "Bearer " + this.token },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `[CloudflareImgBed] upload failed ${res.status}: ${text.slice(0, 300)}`,
      )
    }
    let resp: ImgBedUploadResult[]
    try {
      resp = JSON.parse(text)
    } catch {
      throw new Error(
        `[CloudflareImgBed] invalid upload response: ${text.slice(0, 200)}`,
      )
    }
    if (!Array.isArray(resp) || resp.length === 0 || !resp[0].src) {
      throw new Error("[CloudflareImgBed] no src returned")
    }
    this.updatePublicUrlPrefix(resp[0].publicUrl)
    return resp[0]
  }

  /**
   * Go chunkedUpload(): telegram/cfr2/s3/discord multipart upload channel.
   * initChunked → per-chunk multipart POSTs → merge.
   */
  async chunkedUpload(
    p: ImgBedUploadParams,
    channelType: string,
    channelName: string,
  ): Promise<ImgBedUploadResult> {
    if (!channelName) {
      throw new Error(
        "[CloudflareImgBed] channel name not configured for chunked upload",
      )
    }

    const fileSize = p.size
    const totalChunks = Math.floor(
      (fileSize + CHUNK_UPLOAD_SIZE - 1) / CHUNK_UPLOAD_SIZE,
    )

    // step 1: initChunked
    const initResp = await this.doRequest<ImgBedInitChunkedResp>(
      "POST",
      UPLOAD_API,
      {
        query: {
          initChunked: "true",
          uploadChannel: channelType,
          channelName,
        },
        form: {
          originalFileName: p.fileName,
          originalFileType: p.mimeType,
          totalChunks: String(totalChunks),
        },
      },
    )
    if (!initResp?.success || !initResp.uploadId) {
      throw new Error("[CloudflareImgBed] initChunked returned no uploadId")
    }
    const uploadId = initResp.uploadId

    // step 2: upload chunks (Go: ordered errgroup with min(thread, chunks)
    // workers and 3 retry attempts with backoff)
    const uploadOne = async (chunkIndex: number): Promise<void> => {
      const offset = chunkIndex * CHUNK_UPLOAD_SIZE
      const end = Math.min(offset + CHUNK_UPLOAD_SIZE, fileSize)
      const chunk = p.content.subarray(offset, end)

      const url = new URL(this.address + UPLOAD_API)
      url.searchParams.set("chunked", "true")
      url.searchParams.set("uploadChannel", channelType)
      url.searchParams.set("channelName", channelName)

      await this.withRetry(async () => {
        const form = new FormData()
        form.append("uploadId", uploadId)
        form.append("chunkIndex", String(chunkIndex))
        form.append("totalChunks", String(totalChunks))
        form.append("originalFileName", p.fileName)
        form.append("originalFileType", p.mimeType)
        form.append("file", new Blob([chunk]), p.fileName)

        const res = await fetch(url.toString(), {
          method: "POST",
          headers: { Authorization: "Bearer " + this.token },
          body: form,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
        })
        if (!res.ok) {
          throw new Error(
            `[CloudflareImgBed] chunk ${chunkIndex} upload failed: ${res.status}`,
          )
        }
      })
    }
    await this.runPool(totalChunks, this.uploadThread, uploadOne)

    // step 3: merge
    const mergeResp = await this.doRequest<ImgBedUploadResult[]>(
      "POST",
      UPLOAD_API,
      {
        query: {
          chunked: "true",
          merge: "true",
          uploadChannel: channelType,
          channelName,
          returnFormat: "default",
          uploadFolder: p.uploadFolder,
        },
        form: {
          uploadId,
          totalChunks: String(totalChunks),
          originalFileName: p.fileName,
          originalFileType: p.mimeType,
        },
      },
    )
    if (
      !Array.isArray(mergeResp) ||
      mergeResp.length === 0 ||
      !mergeResp[0]?.src
    ) {
      throw new Error("[CloudflareImgBed] merge returned no src")
    }
    this.updatePublicUrlPrefix(mergeResp[0].publicUrl)
    return mergeResp[0]
  }

  /**
   * Go hfDirectUpload(): HuggingFace LFS direct upload.
   * getUploadUrl (with sha256 + 512-byte sample) → optional physical upload
   * (single PUT or S3-style multipart PUTs + LFS merge POST) → commitUpload.
   */
  async hfDirectUpload(p: ImgBedUploadParams): Promise<ImgBedCommitResult> {
    const channelName = this.largeChannelName
    if (!channelName) {
      throw new Error("[CloudflareImgBed] largeChannelName not configured")
    }

    const sha256Hex = await sha256(p.content)
    const sample = p.content.subarray(0, Math.min(p.size, FILE_SAMPLE_SIZE))
    const fileSample = bytesToBase64(sample)

    const getUrlResp = await this.doRequest<HfGetUrlResp>(
      "POST",
      HF_GET_URL_API,
      {
        json: {
          fileName: p.fileName,
          fileType: p.mimeType,
          fileSize: p.size,
          sha256: sha256Hex,
          fileSample,
          channelName,
          uploadFolder: p.uploadFolder,
        },
      },
    )

    // instant upload / no LFS object needed
    if (getUrlResp?.alreadyExists || !getUrlResp?.needsLfs) {
      return this.hfCommit(getUrlResp, p.fileName, p.size, p.mimeType)
    }
    if (!getUrlResp?.uploadAction) {
      throw new Error("[CloudflareImgBed] HF upload action is nil")
    }

    const headers = getUrlResp.uploadAction.header || {}
    const href = getUrlResp.uploadAction.href

    if (Object.prototype.hasOwnProperty.call(headers, "chunk_size")) {
      // multipart direct upload (AWS S3 multipart style)
      let chunkSize = parseInt(headers["chunk_size"], 10)
      if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
        chunkSize = HF_DEFAULT_CHUNK_SIZE
      }
      const partUrls = new Map<number, string>()
      for (const [k, v] of Object.entries(headers)) {
        if (k === "chunk_size") continue
        if (/^-?\d+$/.test(k)) partUrls.set(parseInt(k, 10), v)
      }
      const partNumbers = [...partUrls.keys()]
      const totalParts = partNumbers.length
      const parts: Array<{ partNumber: number; etag: string } | undefined> = []

      const uploadOnePart = async (i: number): Promise<void> => {
        const partNumber = partNumbers[i]
        const partUrl = partUrls.get(partNumber)!
        const offset = (partNumber - 1) * chunkSize
        const end = Math.min(offset + chunkSize, p.size)
        const chunk = p.content.subarray(offset, end)

        const etag = await this.withRetry(async () => {
          const res = await fetch(partUrl, {
            method: "PUT",
            body: new Blob([chunk]),
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
          })
          if (!res.ok) {
            throw new Error(
              `[CloudflareImgBed] chunk ${partNumber} failed: ${res.status}`,
            )
          }
          return res.headers.get("etag") || ""
        })
        parts[partNumber - 1] = { partNumber, etag }
      }
      await this.runPool(totalParts, this.uploadThread, uploadOnePart)

      // merge parts via the Git LFS batch API
      const mergeBody = JSON.stringify({
        oid: getUrlResp.oid,
        parts: parts.filter(Boolean),
      })
      const mergeRes = await fetch(href, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.git-lfs+json",
          ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
        },
        body: mergeBody,
        signal: AbortSignal.timeout(API_TIMEOUT),
      })
      const mergeText = await mergeRes.text()
      if (!mergeRes.ok) {
        throw new Error(
          `[CloudflareImgBed] merge chunks failed: ${mergeText.slice(0, 300)}`,
        )
      }
    } else {
      // single direct PUT
      const res = await fetch(href, {
        method: "PUT",
        headers,
        body: new Blob([p.content]),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
      })
      if (!res.ok) {
        throw new Error("[CloudflareImgBed] direct upload failed")
      }
    }

    return this.hfCommit(getUrlResp, p.fileName, p.size, p.mimeType)
  }

  /** Go hfCommit(): register the uploaded file in the image bed */
  async hfCommit(
    getUrlResp: HfGetUrlResp,
    fileName: string,
    fileSize: number,
    fileMime: string,
  ): Promise<ImgBedCommitResult> {
    const commitResp = await this.doRequest<HfCommitResp>(
      "POST",
      HF_COMMIT_API,
      {
        json: {
          fullId: getUrlResp.fullId,
          filePath: getUrlResp.filePath,
          sha256: getUrlResp.oid,
          fileSize,
          fileName,
          fileType: fileMime,
          channelName: getUrlResp.channelName,
        },
      },
    )
    if (!commitResp?.success) {
      throw new Error("[CloudflareImgBed] HF commit failed: success=false")
    }
    this.updatePublicUrlPrefix(commitResp.publicUrl)
    return {
      src: commitResp.src || "",
      publicUrl: commitResp.publicUrl,
    }
  }

  /** Go: publicUrlPrefix = u.Scheme + "://" + u.Host */
  updatePublicUrlPrefix(publicUrl?: string): void {
    if (!publicUrl) return
    try {
      const u = new URL(publicUrl)
      this.publicUrlPrefix = u.protocol + "//" + u.host
    } catch {
      /* invalid URL — ignore */
    }
  }

  /** retry.Attempts(3) + Delay(1s) + BackOffDelay (1s, 2s) */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown = null
    for (let i = 0; i < 3; i++) {
      try {
        return await fn()
      } catch (e) {
        lastErr = e
        if (i < 2) await sleep(1000 * (i + 1))
      }
    }
    throw lastErr
  }

  /**
   * Simple bounded concurrency pool standing in for Go's
   * errgroup.NewOrderedGroupWithContext(min(thread, total), ...).
   */
  private async runPool(
    total: number,
    threads: number,
    worker: (index: number) => Promise<void>,
  ): Promise<void> {
    if (total <= 0) return
    let next = 0
    const runners = Array.from(
      { length: Math.max(1, Math.min(threads, total)) },
      async () => {
        for (;;) {
          const i = next++
          if (i >= total) return
          await worker(i)
        }
      },
    )
    await Promise.all(runners)
  }
}
