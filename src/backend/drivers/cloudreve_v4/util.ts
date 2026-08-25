// Cloudreve V4 HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudreve_v4
//
// Auth: Bearer access token (+ refresh token rotation) against /api/v4.
// Token lifecycle mirrors the Go driver:
//   - request() lazily refreshes the access token when it is about to expire
//     (10-minute safety margin, AccessExpires preferred over JWT exp)
//   - a code 401 response triggers a re-login (username/password) and a
//     single retry (Go recurses unboundedly; bounded here)
//   - mounts whose root_folder_path ends with "@share" skip authentication
import {
  BasicConfigResp,
  CaptchaResp,
  CloudreveV4Addition,
  CloudreveV4File,
  CloudreveV4Resp,
  CloudreveV4Token,
  CODE_CREDENTIAL_INVALID,
  CODE_LOGIN_REQUIRED,
  CODE_OBJECT_EXISTED,
  CODE_PATH_NOT_EXIST,
  FileResp,
  FileThumbResp,
  FileUploadResp,
  FileUrlResp,
  FolderSummaryResp,
  PrepareLoginResp,
  SiteLoginConfigResp,
  TokenResponse,
} from "./types"

// drivers/base/client.go UserAgent
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

// Go reads the OCR endpoint from the global `ocr_api` setting
// (internal/bootstrap/data/setting.go default). NextList has no such setting,
// so the OpenList default is inlined here.
const OCR_API = "https://openlistteam-ocr-api-server.hf.space/ocr/file/json"

const REFRESH_PATH = "/session/token/refresh"

/** tokens handed to the persistence callback (mirrors op.MustSaveDriverStorage) */
export interface CloudreveV4Tokens {
  access_token: string
  refresh_token: string
  access_expires?: string
  refresh_expires?: string
}

/** API error carrying the raw server msg/code/data (Go checks msg values) */
export class CloudreveV4ApiError extends Error {
  code: number
  serverMsg: string
  data?: any
  constructor(serverMsg: string, code: number, data?: any, display?: string) {
    // `display` allows the Go-style "code: msg" rendering while keeping the
    // raw server msg comparable (e.g. "Lock conflict")
    super(`[CloudreveV4] ${display ?? serverMsg}`)
    this.code = code
    this.serverMsg = serverMsg
    this.data = data
  }
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
    throw new Error(`[CloudreveV4] ocr error:${v.msg ?? text.slice(0, 200)}`)
  }
  return String(v.result ?? "")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Retry helper standing in for retry-go Attempts(3) + BackOffDelay(1s) */
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

export interface CloudreveV4RequestOptions {
  /** JSON body (serialized with Content-Type: application/json) */
  body?: any
  /** Raw body for binary chunk uploads (overrides `body`) */
  rawBody?: Uint8Array<ArrayBuffer> | string
  /** Query parameters (resty SetQueryParams) */
  params?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
}

export class CloudreveV4Client {
  private addition: CloudreveV4Addition
  private address: string
  private accessToken: string
  private refreshTokenStr: string
  /** only populated after login/refresh (in-memory, like the Go struct fields) */
  private accessExpires: string
  private refreshExpires: string
  private onTokenUpdate?: (tokens: CloudreveV4Tokens) => void | Promise<void>

  constructor(
    addition: CloudreveV4Addition,
    onTokenUpdate?: (tokens: CloudreveV4Tokens) => void | Promise<void>,
  ) {
    this.addition = addition
    // Go Init(): removing trailing slash
    this.address = String(addition.address || "").replace(/\/+$/, "")
    this.accessToken = addition.access_token || ""
    this.refreshTokenStr = addition.refresh_token || ""
    this.accessExpires = ""
    this.refreshExpires = ""
    this.onTokenUpdate = onTokenUpdate
  }

  getAddress(): string {
    return this.address
  }

  getTokens(): CloudreveV4Tokens {
    return {
      access_token: this.accessToken,
      refresh_token: this.refreshTokenStr,
      access_expires: this.accessExpires,
      refresh_expires: this.refreshExpires,
    }
  }

  getUA(): string {
    return this.addition.custom_ua || DEFAULT_UA
  }

  canLogin(): boolean {
    return !!this.addition.username && !!this.addition.password
  }

  /** share mounts (root_folder_path ending with "@share") skip auth */
  isShare(): boolean {
    return (this.addition.root_folder_path || "").endsWith("@share")
  }

  // ── Init / login / refresh ─────────────────────────────────────────────────

  /** Go Init() */
  async init(): Promise<void> {
    if (this.isShare()) return
    if (this.canLogin()) {
      await this.login()
      return
    }
    if (this.refreshTokenStr) {
      await this.refreshToken()
      return
    }
    if (!this.accessToken) {
      throw new Error(
        "[CloudreveV4] no way to authenticate. At least AccessToken is required",
      )
    }
    // ensure AccessToken is valid
    await this.parseJWT(this.accessToken)
  }

  async login(): Promise<void> {
    const siteConfig = await this.rawRequest<SiteLoginConfigResp>(
      "GET",
      "/site/config/login",
    )
    const prepareLogin = await this.rawRequest<PrepareLoginResp>(
      "GET",
      "/session/prepare?email=" +
        encodeURIComponent(this.addition.username || ""),
    )
    if (!prepareLogin.password_enabled) {
      throw new Error("[CloudreveV4] password not enabled")
    }
    if (prepareLogin.webauthn_enabled) {
      throw new Error("[CloudreveV4] webauthn not support")
    }
    let err: unknown = null
    for (let i = 0; i < 5; i++) {
      try {
        await this.doLogin(!!siteConfig.login_captcha)
        err = null
        break
      } catch (e) {
        err = e
        if (
          !(e instanceof CloudreveV4ApiError) ||
          e.serverMsg !== "CAPTCHA not match."
        ) {
          break
        }
      }
    }
    if (err) throw err
  }

  private async doLogin(needCaptcha: boolean): Promise<void> {
    const loginBody: Record<string, any> = {
      email: this.addition.username,
      password: this.addition.password,
    }
    if (needCaptcha) {
      const config = await this.rawRequest<BasicConfigResp>(
        "GET",
        "/site/config/basic",
      )
      if (config.captcha_type !== "normal") {
        throw new Error(
          `[CloudreveV4] captcha type ${config.captcha_type} not support`,
        )
      }
      const captcha = await this.rawRequest<CaptchaResp>("GET", "/site/captcha")
      if (
        !captcha.image ||
        !captcha.image.startsWith("data:image/png;base64,")
      ) {
        throw new Error("[CloudreveV4] can not get captcha")
      }
      loginBody.ticket = captcha.ticket
      const i = captcha.image.indexOf(",")
      const captchaCode = await ocrCaptcha(
        base64ToBytes(captcha.image.slice(i + 1)),
      )
      if (!captchaCode) {
        throw new Error("[CloudreveV4] ocr error: empty result")
      }
      loginBody.captcha = captchaCode
    }
    const token = await this.rawRequest<TokenResponse>(
      "POST",
      "/session/token",
      { body: loginBody },
    )
    if (!token || !token.token) {
      throw new Error("[CloudreveV4] no token returned")
    }
    this.setTokens(token.token)
  }

  /** Go refreshToken() */
  async refreshToken(): Promise<void> {
    // if no refresh token, try to login if possible
    if (!this.refreshTokenStr) {
      if (this.canLogin()) {
        try {
          await this.login()
        } catch (e: any) {
          throw new Error(
            `[CloudreveV4] cannot login to get refresh token, error: ${
              e?.message ?? e
            }`,
          )
        }
      }
      return
    }

    // parse jwt to check if refresh token is valid
    try {
      this.parseJWT(this.refreshTokenStr)
    } catch (e: any) {
      // if refresh token is invalid, try to login if possible
      if (this.canLogin()) {
        await this.login()
        return
      }
      // Go sets the storage status to "Invalid RefreshToken" and disables it
      console.warn(`[CloudreveV4] Invalid RefreshToken: ${e?.message ?? e}`)
      throw new Error(`[CloudreveV4] invalid refresh token: ${e?.message ?? e}`)
    }

    // do refresh token
    let token: CloudreveV4Token
    try {
      token = await this.rawRequest<CloudreveV4Token>("POST", REFRESH_PATH, {
        body: { refresh_token: this.refreshTokenStr },
      })
    } catch (e) {
      if (
        e instanceof CloudreveV4ApiError &&
        e.serverMsg === "failed to issue token"
      ) {
        if (this.canLogin()) {
          // try to login again
          await this.login()
          return
        }
        // Go sets storage status "This session is no longer valid"
        console.warn("[CloudreveV4] This session is no longer valid")
      }
      throw e
    }
    if (!token || !token.access_token) {
      throw new Error("[CloudreveV4] no token returned from refresh")
    }
    this.setTokens(token)
  }

  /** Go parseJWT() — base64url-decode the JWT payload */
  parseJWT(token: string): Record<string, any> {
    const split = token.split(".")
    if (split.length !== 3) {
      throw new Error(
        `[CloudreveV4] invalid token length: ${split.length}, ensure the token is a valid JWT`,
      )
    }
    let bytes: Uint8Array
    try {
      bytes = base64ToBytes(split[1])
    } catch {
      throw new Error(
        "[CloudreveV4] invalid token encoding, ensure the token is a valid JWT",
      )
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new Error(
        "[CloudreveV4] invalid token content, ensure the token is a valid JWT",
      )
    }
  }

  /**
   * Go isTokenExpired() — mirrors the Cloudreve frontend session check:
   * prefer the AccessExpires timestamp (avoids timezone issues), fall back
   * to the JWT exp claim, refresh 10 minutes ahead of expiry.
   */
  isTokenExpired(): boolean {
    if (this.isShare()) return false
    if (!this.refreshTokenStr) {
      // login again if username and password is set
      if (this.canLogin()) return true
      // no refresh token, cannot refresh
      return false
    }
    if (!this.accessToken) return true
    let expiresMs: number
    if (this.accessExpires) {
      // use expires field if possible to prevent timezone issue
      // only available after login or refresh token
      // e.g. "2025-08-28T02:43:07.645109985+08:00"
      const t = new Date(this.accessExpires).getTime()
      if (isNaN(t)) return false
      expiresMs = t
    } else {
      // fallback to parse jwt
      let jwt: Record<string, any>
      try {
        jwt = this.parseJWT(this.accessToken)
      } catch (e: any) {
        // Go disables the storage with status "Invalid AccessToken"
        console.warn(`[CloudreveV4] Invalid AccessToken: ${e?.message ?? e}`)
        return false
      }
      expiresMs = (Number(jwt.exp) || 0) * 1000
    }
    // add a 10 minutes safe margin
    const ddl = Date.now() + 10 * 60 * 1000
    if (expiresMs < ddl) {
      // access token expired — check if the refresh token is expired too
      // (warning: cannot parse refresh expiry from the jwt — non-standard)
      if (this.refreshExpires) {
        const refreshExpiresMs = new Date(this.refreshExpires).getTime()
        if (isNaN(refreshExpiresMs)) return false
        if (refreshExpiresMs < Date.now()) {
          // this session is no longer valid
          if (this.canLogin()) return true
          return false
        }
      }
      return true
    }
    return false
  }

  private setTokens(token: CloudreveV4Token): void {
    this.accessToken = token.access_token || ""
    this.refreshTokenStr = token.refresh_token || ""
    this.accessExpires = token.access_expires || ""
    this.refreshExpires = token.refresh_expires || ""
    // Go: op.MustSaveDriverStorage(d) — persist through the callback
    if (this.onTokenUpdate) {
      try {
        const result = this.onTokenUpdate({
          access_token: this.accessToken,
          refresh_token: this.refreshTokenStr,
          access_expires: this.accessExpires,
          refresh_expires: this.refreshExpires,
        })
        if (result && typeof (result as any).catch === "function") {
          ;(result as Promise<void>).catch(() => {
            /* persistence failure is non-fatal */
          })
        }
      } catch {
        /* persistence failure is non-fatal */
      }
    }
  }

  // ── HTTP core ──────────────────────────────────────────────────────────────

  /** Go request(): ensures a fresh access token first */
  private async request<T = any>(
    method: string,
    path: string,
    options: CloudreveV4RequestOptions = {},
    allowRelogin = true,
  ): Promise<T> {
    // ensure token
    if (this.isTokenExpired()) {
      await this.refreshToken()
    }
    return this.rawRequest<T>(method, path, options, allowRelogin)
  }

  /** Go _request(): the raw /api/v4 call with envelope/error handling */
  private async rawRequest<T = any>(
    method: string,
    path: string,
    options: CloudreveV4RequestOptions = {},
    allowRelogin = true,
  ): Promise<T> {
    let url = this.address + "/api/v4" + path
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": this.getUA(),
      ...options.headers,
    }
    if (this.accessToken) {
      headers["Authorization"] = "Bearer " + this.accessToken
    }
    let body: Uint8Array<ArrayBuffer> | string | undefined
    if (options.rawBody !== undefined) {
      body = options.rawBody
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(options.body)
    }
    if (options.params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) qs.set(k, String(v))
      }
      url = url + "?" + qs.toString()
    }

    const res = await fetch(url, { method, headers, body })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`[CloudreveV4] HTTP ${res.status}: ${text.slice(0, 300)}`)
    }

    let r: CloudreveV4Resp | null = null
    try {
      r = text ? (JSON.parse(text) as CloudreveV4Resp) : null
    } catch {
      /* non-JSON */
    }
    const resp: CloudreveV4Resp = r || {
      code: -1,
      msg: "empty or non-JSON response",
    }

    if (resp.code !== 0) {
      if (
        resp.code === CODE_LOGIN_REQUIRED &&
        this.canLogin() &&
        path !== REFRESH_PATH &&
        allowRelogin
      ) {
        // Go recurses via d.request() after login; bounded to one retry here
        await this.login()
        return this.request<T>(method, path, options, false)
      }
      if (resp.code === CODE_CREDENTIAL_INVALID) {
        // Go ErrorIssueToken
        throw new CloudreveV4ApiError("failed to issue token", resp.code)
      }
      if (resp.code === CODE_PATH_NOT_EXIST) {
        // Go errs.ObjectNotFound
        throw new CloudreveV4ApiError("object not found", resp.code)
      }
      if (resp.code === CODE_OBJECT_EXISTED) {
        // Go errs.ObjectAlreadyExists
        throw new CloudreveV4ApiError("object already exists", resp.code)
      }
      // Go: fmt.Errorf("%d: %s", r.Code, r.Msg) — serverMsg keeps the raw msg
      throw new CloudreveV4ApiError(
        resp.msg || `request failed`,
        resp.code,
        resp.data,
        `${resp.code}: ${resp.msg ?? ""}`,
      )
    }

    return (resp.data !== undefined ? resp.data : undefined) as T
  }

  // ── Read operations ────────────────────────────────────────────────────────

  /** Go List(): paginated file listing */
  async getFiles(uri: string): Promise<CloudreveV4File[]> {
    const pageSize = 100
    const files: CloudreveV4File[] = []
    let nextToken = ""
    for (;;) {
      const params: Record<string, string | undefined> = {
        page_size: String(pageSize),
        uri,
        order_by: this.addition.order_by || "name",
        order_direction: this.addition.order_direction || "asc",
        page: "0",
      }
      if (nextToken) params.next_page_token = nextToken
      const r = await this.request<FileResp>("GET", "/file", { params })
      // data may be null (Go unmarshals into a zero FileResp then)
      const batch = r?.files || []
      files.push(...batch)
      if (!r?.pagination?.next_token || batch.length < pageSize) break
      nextToken = r.pagination.next_token
    }
    return files
  }

  /** Go Get(): single object info by uri */
  async getFileInfo(uri: string): Promise<CloudreveV4File> {
    return this.request<CloudreveV4File>("GET", "/file/info", {
      params: { uri },
    })
  }

  /** folder summary (size) used by EnableFolderSize listings */
  async getFolderSummary(uri: string): Promise<FolderSummaryResp> {
    return this.request<FolderSummaryResp>("GET", "/file/info", {
      params: { uri, folder_summary: "true" },
    })
  }

  /** thumbnail url used by EnableThumb listings */
  async getFileThumb(uri: string): Promise<FileThumbResp> {
    return this.request<FileThumbResp>("GET", "/file/thumb", {
      params: { uri },
    })
  }

  /** Go Link(): POST /file/url with download=true */
  async getFileUrl(uri: string): Promise<{
    url: string
    expires?: string
    headers: Record<string, string>
  }> {
    const url = await this.request<FileUrlResp>("POST", "/file/url", {
      body: { uris: [uri], download: true },
    })
    if (!url.urls || url.urls.length === 0) {
      throw new Error("[CloudreveV4] server returns no url")
    }
    return {
      url: url.urls[0].url,
      expires: url.expires,
      headers: {
        Referer: this.address,
        "User-Agent": this.getUA(),
      },
    }
  }

  // ── Write operations ───────────────────────────────────────────────────────

  async makeDir(uri: string): Promise<void> {
    await this.request("POST", "/file/create", {
      body: { type: "folder", uri, error_on_conflict: true },
    })
  }

  async rename(uri: string, newName: string): Promise<void> {
    await this.request("POST", "/file/rename", {
      body: { new_name: newName, uri },
    })
  }

  async move(uris: string[], dst: string, copy: boolean): Promise<void> {
    await this.request("POST", "/file/move", {
      body: { uris, dst, copy },
    })
  }

  /**
   * Go Remove(): DELETE /file, handling the 40073 "Lock conflict" response by
   * releasing the locks and retrying the delete once.
   */
  async remove(uri: string): Promise<void> {
    const body = {
      uris: [uri],
      unlink: false,
      skip_soft_delete: true,
    }
    try {
      await this.request("DELETE", "/file", { body })
    } catch (e) {
      if (
        e instanceof CloudreveV4ApiError &&
        e.code === 40073 &&
        e.serverMsg === "Lock conflict" &&
        Array.isArray(e.data) &&
        e.data.length > 0
      ) {
        const tokens = (e.data as { token?: string }[]).map(
          (item) => item.token ?? "",
        )
        await this.request("DELETE", "/file/lock", { body: { tokens } })
        await this.request("DELETE", "/file", { body })
        return
      }
      throw e
    }
  }

  // ── Upload pipeline (Go Put + upLocal/upRemote/upOneDrive/upS3) ────────────

  /**
   * Full upload port. Empty files go through POST /file/create; everything
   * else creates a session via PUT /file/upload and streams chunks according
   * to the policy returned with the session (relay policies upload through
   * the local pipeline).
   */
  async upload(
    dstDirUri: string,
    name: string,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const uri = dstDirUri + "/" + name
    if (content.length === 0) {
      // 空文件使用新建文件方法，避免上传卡锁
      await this.request("POST", "/file/create", {
        body: { type: "file", uri, error_on_conflict: true },
      })
      return
    }

    // get the storage policy of the target directory
    const r = await this.request<FileResp>("GET", "/file", {
      params: {
        page_size: "10",
        uri: dstDirUri,
        order_by: "created_at",
        order_direction: "asc",
        page: "0",
      },
    })
    const p = r.storage_policy

    const body: Record<string, any> = {
      uri,
      size: content.length,
      policy_id: p?.id,
      // Go uses file.ModTime().UnixMilli(); not available in put()
      last_modified: Date.now(),
      mime_type: "",
    }
    if (this.addition.enable_version_upload) {
      body.entity_type = "version"
    }

    const u = await this.request<FileUploadResp>("PUT", "/file/upload", {
      body,
    })
    if (!u || !u.session_id) {
      throw new Error("[CloudreveV4] no upload session returned")
    }

    try {
      if (u.storage_policy?.relay) {
        await this.upLocal(u, content)
      } else {
        switch (u.storage_policy?.type) {
          case "local":
            await this.upLocal(u, content)
            break
          case "remote":
            await this.upRemote(u, content)
            break
          case "onedrive":
            await this.upOneDrive(u, content)
            break
          case "s3":
            await this.upS3(u, content, "s3")
            break
          case "ks3":
            await this.upS3(u, content, "ks3")
            break
          default:
            throw new Error(
              `[CloudreveV4] upload policy '${u.storage_policy?.type}' not supported`,
            )
        }
      }
    } catch (e) {
      // 删除失败的会话
      await this.request("DELETE", "/file/upload", {
        body: { id: u.session_id, uri: u.uri ?? uri },
      }).catch(() => {})
      throw e
    }
  }

  /** local & relay: chunked POST /file/upload/{session_id}/{chunk} */
  private async upLocal(
    u: FileUploadResp,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const total = content.length
    let chunkSize = u.chunk_size || 0
    if (chunkSize <= 0) {
      // support relay
      chunkSize = total
    }
    let finish = 0
    let chunk = 0
    while (finish < total) {
      const byteSize = Math.min(total - finish, chunkSize)
      const byteData = content.slice(finish, finish + byteSize)
      const path =
        "/file/upload/" + encodeURIComponent(u.session_id!) + "/" + chunk
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

  /** remote (从机存储): chunked POST {upload_url}?chunk=N with credential */
  private async upRemote(
    u: FileUploadResp,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const total = content.length
    const chunkSize = (u.chunk_size || 0) > 0 ? u.chunk_size! : total
    const uploadUrl = (u.upload_urls || [])[0]
    if (!uploadUrl) throw new Error("[CloudreveV4] no upload url returned")
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
          throw new Error(`[CloudreveV4] server error: ${res.status}`)
        }
        const text = await res.text()
        let up: any
        try {
          up = JSON.parse(text)
        } catch {
          throw new Error("[CloudreveV4] invalid upload response")
        }
        if (up.code !== 0) {
          throw new Error(up.msg || `[CloudreveV4] upload failed: ${up.code}`)
        }
      })
      finish += byteSize
      chunk++
    }
  }

  /** OneDrive: PUT {upload_url} with Content-Range, then callback */
  private async upOneDrive(
    u: FileUploadResp,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const total = content.length
    const chunkSize = (u.chunk_size || 0) > 0 ? u.chunk_size! : total
    const uploadUrl = (u.upload_urls || [])[0]
    if (!uploadUrl) throw new Error("[CloudreveV4] no upload url returned")
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
          throw new Error(`[CloudreveV4] server error: ${res.status}`)
        }
        if (res.status !== 201 && res.status !== 202 && res.status !== 200) {
          const data = await res.text()
          throw new Error(`[CloudreveV4] ${data}`)
        }
      })
      finish += byteSize
    }
    // 上传成功发送回调请求
    await this.request(
      "POST",
      "/callback/onedrive/" +
        encodeURIComponent(u.session_id!) +
        "/" +
        encodeURIComponent(u.callback_secret ?? ""),
      { body: {} },
    )
  }

  /** S3-like (s3/ks3): PUT presigned chunk URLs, complete multipart, callback */
  private async upS3(
    u: FileUploadResp,
    content: Uint8Array<ArrayBuffer>,
    s3Type: string,
  ): Promise<void> {
    const total = content.length
    const chunkSize = (u.chunk_size || 0) > 0 ? u.chunk_size! : total
    const uploadUrls = u.upload_urls || []
    let finish = 0
    let chunk = 0
    const etags: string[] = []
    while (finish < total) {
      const byteSize = Math.min(total - finish, chunkSize)
      const byteData = content.slice(finish, finish + byteSize)
      const url = uploadUrls[chunk]
      if (!url) {
        throw new Error(`[CloudreveV4] missing upload url for chunk ${chunk}`)
      }
      await withRetry(async () => {
        const headers: Record<string, string> = {
          "User-Agent": this.getUA(),
        }
        if (s3Type === "ks3") {
          headers["Content-Type"] = "application/octet-stream"
        }
        const res = await fetch(url, { method: "PUT", headers, body: byteData })
        const etag = res.headers.get("etag") || ""
        if (res.status !== 200) {
          throw new Error(`[CloudreveV4] server error: ${res.status}`)
        }
        if (!etag) {
          throw new Error("[CloudreveV4] failed to get ETag from header")
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
      throw new Error("[CloudreveV4] missing completeURL for s3 upload")
    }
    const res = await fetch(u.completeURL, {
      method: "POST",
      headers: {
        "Content-Type":
          s3Type === "ks3" ? "application/octet-stream" : "application/xml",
        "User-Agent": this.getUA(),
      },
      body: xml,
    })
    if (res.status !== 200) {
      const body = await res.text()
      throw new Error(`[CloudreveV4] up status: ${res.status}, error: ${body}`)
    }

    // 上传成功发送回调请求
    await this.request(
      "GET",
      "/callback/" +
        s3Type +
        "/" +
        encodeURIComponent(u.session_id!) +
        "/" +
        encodeURIComponent(u.callback_secret ?? ""),
    )
  }
}
