// Cloudreve HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudreve
//
// Auth: session cookie ("cloudreve-session"). Every request sends
// `Cookie: cloudreve-session=<cookie>` and captures a rotated session cookie
// from the response Set-Cookie headers (Cloudreve rotates the session id on
// each request). On code 401 the client re-logins with username/password and
// retries the request once (Go does the same, unbounded; bounded here).
import {
  CloudreveAddition,
  CloudreveDirectoryProp,
  CloudreveDirectoryResp,
  CloudreveResp,
  CloudreveSiteConfig,
  CloudreveUploadInfo,
} from "./types"

const LOGIN_PATH = "/user/session"

// drivers/base/client.go UserAgent
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

// Go reads the OCR endpoint from the global `ocr_api` setting
// (internal/bootstrap/data/setting.go default). NextList has no such setting,
// so the OpenList default is inlined here.
const OCR_API = "https://openlistteam-ocr-api-server.hf.space/ocr/file/json"

/** src body of object operations (Go util.go convertSrc) */
export interface CloudreveSrcBody {
  dirs: string[]
  items: string[]
}

/** API error carrying the raw server msg (Go checks msg == "CAPTCHA not match.") */
export class CloudreveApiError extends Error {
  code: number
  serverMsg: string
  constructor(serverMsg: string, code: number) {
    super(`[Cloudreve] ${serverMsg}`)
    this.code = code
    this.serverMsg = serverMsg
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof withGetSetCookie.getSetCookie === "function") {
    const values = withGetSetCookie.getSetCookie()
    if (values.length > 0) return values
  }
  const combined = headers.get("set-cookie")
  return combined ? [combined] : []
}

/** Extract the (possibly rotated) cloudreve-session cookie; null when absent */
function getSessionCookie(headers: Headers): string | null {
  for (const sc of getSetCookieHeaders(headers)) {
    const m = /^\s*cloudreve-session=([^;]*)/.exec(sc)
    if (m) return m[1]
  }
  return null
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s/g, "")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Post the captcha image to the OCR service (Go setting conf.OcrApi) */
async function ocrCaptcha(image: Uint8Array): Promise<string> {
  const form = new FormData()
  form.append(
    "image",
    new Blob([image as BlobPart], { type: "image/png" }),
    "validateCode.png",
  )
  const res = await fetch(OCR_API, { method: "POST", body: form })
  const text = await res.text()
  let v: any = {}
  try {
    v = JSON.parse(text)
  } catch {
    /* non-JSON */
  }
  if (v.status !== 200) {
    throw new Error(`[Cloudreve] ocr error:${v.msg ?? text.slice(0, 200)}`)
  }
  return String(v.result ?? "")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry helper standing in for resty retry conditions (upLocal) and
 * retry-go Attempts(3) + BackOffDelay(1s) (remote/onedrive/s3 chunks).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i < attempts - 1) await sleep(baseDelayMs * (i + 1))
    }
  }
  throw lastErr
}

export interface CloudreveRequestOptions {
  /** JSON body (serialized with Content-Type: application/json) */
  body?: any
  /** Raw body for binary chunk uploads (overrides `body`) */
  rawBody?: Uint8Array<ArrayBuffer> | string
  headers?: Record<string, string>
}

export class CloudreveClient {
  private addition: CloudreveAddition
  private address: string
  private cookie: string
  private onCookieUpdate?: (cookie: string) => void | Promise<void>

  constructor(
    addition: CloudreveAddition,
    onCookieUpdate?: (cookie: string) => void | Promise<void>,
  ) {
    this.addition = addition
    // Go Init(): removing trailing slash (also applied here so calls before
    // init() still target the right host)
    this.address = String(addition.address || "").replace(/\/+$/, "")
    this.cookie = addition.cookie || ""
    this.onCookieUpdate = onCookieUpdate
  }

  getAddress(): string {
    return this.address
  }

  getCookie(): string {
    return this.cookie
  }

  getUA(): string {
    return this.addition.custom_ua || DEFAULT_UA
  }

  /** Go Init(): keep existing cookie, otherwise login with credentials */
  async init(): Promise<void> {
    if (this.cookie) return
    if (!this.addition.username || !this.addition.password) {
      throw new Error(
        "[Cloudreve] cookie is empty and username/password are not set",
      )
    }
    await this.login()
  }

  async login(): Promise<void> {
    const siteConfig = await this.request<CloudreveSiteConfig>(
      "GET",
      "/site/config",
    )
    let err: unknown = null
    for (let i = 0; i < 5; i++) {
      try {
        await this.doLogin(!!siteConfig.loginCaptcha)
        err = null
        break
      } catch (e) {
        err = e
        if (
          !(e instanceof CloudreveApiError) ||
          e.serverMsg !== "CAPTCHA not match."
        ) {
          break
        }
      }
    }
    if (err) throw err
  }

  private async doLogin(needCaptcha: boolean): Promise<void> {
    let captchaCode = ""
    if (needCaptcha) {
      const captcha = await this.request<string>("GET", "/site/captcha")
      if (!captcha || captcha.length === 0) {
        throw new Error("[Cloudreve] can not get captcha")
      }
      // data URL "data:image/png;base64,...." — strip everything before ","
      const i = captcha.indexOf(",")
      captchaCode = await ocrCaptcha(base64ToBytes(captcha.slice(i + 1)))
    }
    // Go sends "Password" (capital P); Cloudreve's Go JSON binding is
    // case-insensitive so this matches — kept byte-for-byte faithful.
    await this.request("POST", LOGIN_PATH, {
      body: {
        username: this.addition.username,
        Password: this.addition.password,
        captchaCode,
      },
    })
  }

  private async request<T = any>(
    method: string,
    path: string,
    options: CloudreveRequestOptions = {},
    allowRelogin = true,
  ): Promise<T> {
    const url = this.address + "/api/v3" + path
    const headers: Record<string, string> = {
      Cookie: "cloudreve-session=" + this.cookie,
      Accept: "application/json, text/plain, */*",
      "User-Agent": this.getUA(),
      ...options.headers,
    }
    let body: Uint8Array<ArrayBuffer> | string | undefined
    if (options.rawBody !== undefined) {
      body = options.rawBody
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(options.body)
    }
    const res = await fetch(url, { method, headers, body })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`[Cloudreve] HTTP ${res.status}: ${text.slice(0, 300)}`)
    }

    let r: CloudreveResp | null = null
    try {
      r = text ? (JSON.parse(text) as CloudreveResp) : null
    } catch {
      /* non-JSON */
    }
    const resp: CloudreveResp = r || {
      code: -1,
      msg: "empty or non-JSON response",
    }

    if (resp.code !== 0) {
      // refresh cookie (Go: r.Code == http.StatusUnauthorized && path != loginPath)
      if (
        resp.code === 401 &&
        path !== LOGIN_PATH &&
        allowRelogin &&
        this.addition.username &&
        this.addition.password
      ) {
        await this.login()
        return this.request<T>(method, path, options, false)
      }
      throw new CloudreveApiError(
        resp.msg || `request failed: ${resp.code}`,
        resp.code,
      )
    }

    // session rotation: persist the fresh cloudreve-session cookie
    const sess = getSessionCookie(res.headers)
    if (sess !== null && sess !== this.cookie) {
      this.cookie = sess
      if (this.onCookieUpdate) {
        try {
          await this.onCookieUpdate(sess)
        } catch {
          /* persistence failure is non-fatal */
        }
      }
    }

    return (resp.data !== undefined ? resp.data : undefined) as T
  }

  // ── Read operations ────────────────────────────────────────────────────────

  async getDirectory(dirPath: string): Promise<CloudreveDirectoryResp> {
    // data may be null (Go unmarshals into a zero DirectoryResp then)
    const resp = await this.request<CloudreveDirectoryResp>(
      "GET",
      "/directory" + encodePathSegments(dirPath),
    )
    return resp || {}
  }

  async getDirectoryProp(objId: string): Promise<CloudreveDirectoryProp> {
    return this.request<CloudreveDirectoryProp>(
      "GET",
      "/object/property/" + encodeURIComponent(objId) + "?is_folder=true",
    )
  }

  /** Go GetThumb(): no-redirect probe returning the Location header */
  async getThumb(fileId: string): Promise<string> {
    if (!this.addition.enable_thumb_and_folder_size) return ""
    const res = await fetch(
      this.address + "/api/v3/file/thumb/" + encodeURIComponent(fileId),
      {
        method: "GET",
        redirect: "manual",
        headers: {
          Cookie: "cloudreve-session=" + this.cookie,
          Accept: "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "User-Agent": this.getUA(),
        },
      },
    )
    return res.headers.get("location") || ""
  }

  /** Go Link(): PUT /file/download/{id} */
  async getDownloadUrl(fileId: string): Promise<{
    url: string
    headers: Record<string, string>
  }> {
    let dUrl = await this.request<string>(
      "PUT",
      "/file/download/" + encodeURIComponent(fileId),
    )
    if (typeof dUrl !== "string") dUrl = String(dUrl ?? "")
    if (dUrl.startsWith("/api")) dUrl = this.address + dUrl
    return {
      url: dUrl,
      headers: {
        Referer: this.address,
        "User-Agent": this.getUA(),
      },
    }
  }

  // ── Write operations ───────────────────────────────────────────────────────

  async makeDir(path: string): Promise<void> {
    await this.request("PUT", "/directory", { body: { path } })
  }

  async move(
    srcDirPath: string,
    dstDirPath: string,
    src: CloudreveSrcBody,
  ): Promise<void> {
    await this.request("PATCH", "/object", {
      body: {
        action: "move",
        src_dir: srcDirPath,
        dst: dstDirPath,
        src,
      },
    })
  }

  async rename(src: CloudreveSrcBody, newName: string): Promise<void> {
    await this.request("PATCH", "/object/rename", {
      body: {
        action: "rename",
        new_name: newName,
        src,
      },
    })
  }

  async copy(
    srcDirPath: string,
    dstDirPath: string,
    src: CloudreveSrcBody,
  ): Promise<void> {
    await this.request("POST", "/object/copy", {
      body: {
        src_dir: srcDirPath,
        dst: dstDirPath,
        src,
      },
    })
  }

  async remove(src: CloudreveSrcBody): Promise<void> {
    await this.request("DELETE", "/object", { body: src })
  }

  /** Create an empty file (Go create() file branch) */
  async createFile(path: string): Promise<void> {
    await this.request("POST", "/file/create", { body: { path } })
  }

  // ── Upload pipeline (Go Put + upLocal/upRemote/upOneDrive/upS3) ────────────

  /**
   * Full upload port. The Go driver creates an upload session via
   * PUT /file/upload and then streams chunks according to the directory's
   * storage policy. Since NextList hands us the whole content in memory,
   * all four policy pipelines are portable.
   */
  async upload(
    dstDirPath: string,
    name: string,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    if (content.length === 0) {
      // Go: empty stream (http.NoBody) → create the file instead of uploading
      await this.createFile(joinPath(dstDirPath, name))
      return
    }

    // fetch the directory to learn its storage policy
    const dirResp = await this.getDirectory(dstDirPath)
    const policy = dirResp.policy
    if (!policy) {
      throw new Error(
        `[Cloudreve] no storage policy returned for ${dstDirPath}`,
      )
    }

    const u = await this.request<CloudreveUploadInfo>("PUT", "/file/upload", {
      body: {
        path: dstDirPath,
        size: content.length,
        name,
        policy_id: policy.id,
        // Go uses stream.ModTime().UnixMilli(); not available in put()
        last_modified: Date.now(),
      },
    })
    if (!u || !u.sessionID) {
      throw new Error("[Cloudreve] no upload session returned")
    }

    try {
      switch (policy.type) {
        case "onedrive":
          await this.upOneDrive(u, content)
          break
        case "s3":
          await this.upS3(u, content)
          break
        case "remote": // 从机存储
          await this.upRemote(u, content)
          break
        case "local": // 本机存储
          await this.upLocal(u, content)
          break
        default:
          throw new Error(
            `[Cloudreve] upload policy '${policy.type}' not supported`,
          )
      }
    } catch (e) {
      // delete the failed session (Go Put error path)
      await this.request(
        "DELETE",
        "/file/upload/" + encodeURIComponent(u.sessionID),
      ).catch(() => {})
      throw e
    }
  }

  /** 本机存储: chunked POST /file/upload/{sessionID}/{chunk} */
  private async upLocal(
    u: CloudreveUploadInfo,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const total = content.length
    // zero guard (Go would loop forever; v4 driver uses size fallback for relay)
    const chunkSize = u.chunkSize > 0 ? u.chunkSize : total
    let finish = 0
    let chunk = 0
    while (finish < total) {
      const byteSize = Math.min(total - finish, chunkSize)
      const byteData = content.slice(finish, finish + byteSize)
      const path =
        "/file/upload/" + encodeURIComponent(u.sessionID) + "/" + chunk
      // resty SetRetryCount(3) + AddRetryCondition → up to 4 attempts
      await withRetry(
        async () => {
          await this.request("POST", path, {
            rawBody: byteData,
            headers: { "Content-Type": "application/octet-stream" },
          })
        },
        4,
        250,
      )
      finish += byteSize
      chunk++
    }
  }

  /** 从机存储: chunked POST {uploadURL}?chunk=N with credential */
  private async upRemote(
    u: CloudreveUploadInfo,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const total = content.length
    const chunkSize = u.chunkSize > 0 ? u.chunkSize : total
    const uploadUrl = (u.uploadURLs || [])[0]
    if (!uploadUrl) throw new Error("[Cloudreve] no upload url returned")
    const credential = String(u.credential ?? "")
    let finish = 0
    let chunk = 0
    while (finish < total) {
      const byteSize = Math.min(total - finish, chunkSize)
      const byteData = content.slice(finish, finish + byteSize)
      const url = uploadUrl + "?chunk=" + chunk
      await withRetry(async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: credential,
            "User-Agent": this.getUA(),
          },
          body: byteData,
        })
        if (res.status !== 200) {
          throw new Error(`[Cloudreve] server error: ${res.status}`)
        }
        const text = await res.text()
        let up: any
        try {
          up = JSON.parse(text)
        } catch {
          throw new Error("[Cloudreve] invalid upload response")
        }
        if (up.code !== 0) {
          throw new Error(up.msg || `[Cloudreve] upload failed: ${up.code}`)
        }
      })
      finish += byteSize
      chunk++
    }
  }

  /** OneDrive: PUT {uploadURL} with Content-Range, then callback */
  private async upOneDrive(
    u: CloudreveUploadInfo,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const total = content.length
    const chunkSize = u.chunkSize > 0 ? u.chunkSize : total
    const uploadUrl = (u.uploadURLs || [])[0]
    if (!uploadUrl) throw new Error("[Cloudreve] no upload url returned")
    let finish = 0
    while (finish < total) {
      const byteSize = Math.min(total - finish, chunkSize)
      const byteData = content.slice(finish, finish + byteSize)
      const range = `bytes ${finish}-${finish + byteSize - 1}/${total}`
      await withRetry(async () => {
        const res = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Range": range,
            "User-Agent": this.getUA(),
          },
          body: byteData,
        })
        if (res.status >= 500 && res.status <= 504) {
          throw new Error(`[Cloudreve] server error: ${res.status}`)
        }
        if (res.status !== 201 && res.status !== 202 && res.status !== 200) {
          const data = await res.text()
          throw new Error(`[Cloudreve] ${data}`)
        }
      })
      finish += byteSize
    }
    // upload finished → callback
    await this.request(
      "POST",
      "/callback/onedrive/finish/" + encodeURIComponent(u.sessionID),
      { body: {} },
    )
  }

  /** S3: PUT presigned chunk URLs, complete multipart, then callback */
  private async upS3(
    u: CloudreveUploadInfo,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const total = content.length
    const chunkSize = u.chunkSize > 0 ? u.chunkSize : total
    const uploadUrls = u.uploadURLs || []
    let finish = 0
    let chunk = 0
    const etags: string[] = []
    while (finish < total) {
      const byteSize = Math.min(total - finish, chunkSize)
      const byteData = content.slice(finish, finish + byteSize)
      const url = uploadUrls[chunk]
      if (!url) {
        throw new Error(`[Cloudreve] missing upload url for chunk ${chunk}`)
      }
      await withRetry(async () => {
        const res = await fetch(url, {
          method: "PUT",
          headers: { "User-Agent": this.getUA() },
          body: byteData,
        })
        const etag = res.headers.get("etag") || ""
        if (res.status !== 200) {
          throw new Error(`[Cloudreve] server error: ${res.status}`)
        }
        if (!etag) {
          throw new Error("[Cloudreve] failed to get ETag from header")
        }
        etags.push(etag)
      })
      finish += byteSize
      chunk++
    }

    // s3LikeFinishUpload (mirrors the Cloudreve frontend uploader)
    let xml = "<CompleteMultipartUpload>"
    etags.forEach((etag, i) => {
      // PartNumber starts at 1
      xml += `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`
    })
    xml += "</CompleteMultipartUpload>"
    if (!u.completeURL) {
      throw new Error("[Cloudreve] missing completeURL for s3 upload")
    }
    const res = await fetch(u.completeURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        "User-Agent": this.getUA(),
      },
      body: xml,
    })
    if (res.status !== 200) {
      const body = await res.text()
      throw new Error(`[Cloudreve] up status: ${res.status}, error: ${body}`)
    }

    // upload finished → callback
    await this.request("GET", "/callback/s3/" + encodeURIComponent(u.sessionID))
  }
}

/** Percent-encode each path segment, keeping slashes (Go's http client
 * percent-encodes non-ASCII path bytes; resty passes the URL through raw). */
export function encodePathSegments(p: string): string {
  return String(p || "")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/")
}

/** Clean join of two path fragments (Go path.Join semantics) */
export function joinPath(dir: string, name: string): string {
  const parts = (dir + "/" + name).split("/").filter(Boolean)
  return "/" + parts.join("/")
}
