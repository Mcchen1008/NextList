// GuangYaPan (光速盘) HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/guangyapan
//
// Auth (Go driver.go Init):
// - accountBaseURL https://account.guangyapan.com — token / SMS / captcha endpoints,
//   requests carry a fixed set of X-Device-* / X-Client-* headers.
// - apiBaseURL https://api.guangyapan.com — data endpoints, Bearer access_token,
//   headers `Did` (device id) + `Dt: 4`.
// - Login priority: access_token → refresh_token (grant refresh_token) →
//   two-stage SMS login (send_code=true then verify_code).
//
// offline.go (offline download tasks) is NOT ported.
import {
  GuangYaPanAddition,
  GuangYaPanFile,
  GuangYaPanTokenResp,
  GuangYaPanVerificationResp,
  GuangYaPanCaptchaInitResp,
  GuangYaPanVerifyResp,
  GuangYaPanUserMeResp,
  GuangYaPanListResp,
  GuangYaPanDownloadResp,
  GuangYaPanCreateDirResp,
  GuangYaPanTaskResp,
  GuangYaPanTaskStatusResp,
} from "./types"

const ACCOUNT_BASE_URL = "https://account.guangyapan.com"
const API_BASE_URL = "https://api.guangyapan.com"

/** Go: apiRateInterval — minimum gap between two requests to the same endpoint */
const API_RATE_INTERVAL_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Go: isSuccessMsg — msg is "" or "success" (case-insensitive) */
export function isSuccessMsg(msg: string): boolean {
  const m = (msg || "").trim()
  return m === "" || m.toLowerCase() === "success"
}

/** Go: unixOrZero → ISO string ("" for zero timestamps) */
export function unixToIso(v: number): string {
  if (!v || v <= 0) return ""
  return new Date(v * 1000).toISOString()
}

/** Go: normalizeDeviceID — 32 lowercase hex chars or "" */
export function normalizeDeviceID(v: string): string {
  let s = (v || "").trim().toLowerCase().replace(/-/g, "")
  if (!/^[0-9a-f]{32}$/.test(s)) return ""
  return s
}

/** Go: randomDeviceID — 16 random bytes hex-encoded */
export function randomDeviceID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** Go: normalizeCaptchaUsername — digits only, strip leading 86 */
export function normalizeCaptchaUsername(phone: string): string {
  let p = (phone || "").trim().replace(/ /g, "").replace(/^\+/, "")
  const digits = p.replace(/\D/g, "")
  if (digits.startsWith("86") && digits.length > 11) return digits.slice(2)
  return digits
}

/** Go: normalizePhoneE164 — "+86 1xxxxxxxxxx" style */
export function normalizePhoneE164(phone: string): string {
  const p = (phone || "").trim()
  if (!p) return ""
  const compact = p.replace(/ /g, "")
  if (compact.startsWith("+")) {
    if (compact.startsWith("+86") && compact.length > 3) {
      return "+86 " + compact.slice(3)
    }
    return compact
  }
  const digits = normalizeCaptchaUsername(p)
  if (digits.length === 11) return "+86 " + digits
  return p
}

/** Optional persistence hook — mirrors Go op.MustSaveDriverStorage(d) */
export type GuangYaPanTokenPersist = (tokens: {
  access_token: string
  refresh_token: string
}) => void

export class GuangYaPanClient {
  private addition: GuangYaPanAddition
  private accessToken = ""
  /** Go: Addition.RefreshToken (field; method refreshToken() below) */
  private refreshTokenVal = ""
  /** resolved root folder id for Addition.RootPath ("" = drive root) */
  private rootFolderId = ""
  private rootFolderResolved = false
  /** per-endpoint throttle (Go: apiRateLimit sync.Map + rate.Limiter) */
  private lastRequestAt = new Map<string, number>()
  private onTokenRefresh?: GuangYaPanTokenPersist

  constructor(
    addition: GuangYaPanAddition,
    onTokenRefresh?: GuangYaPanTokenPersist,
  ) {
    this.addition = addition
    this.accessToken = (addition.access_token || "").trim()
    this.refreshTokenVal = (addition.refresh_token || "").trim()
    this.onTokenRefresh = onTokenRefresh
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  public getRootFolderId(): string {
    return this.rootFolderId
  }

  public getPageSize(): number {
    return this.addition.page_size > 0 ? this.addition.page_size : 100
  }

  // ── Init / auth (Go Init) ─────────────────────────────────────────────────

  public async init(): Promise<void> {
    this.addition.client_id = (this.addition.client_id || "").trim()
    if (!this.addition.client_id) {
      throw new Error(
        "[GuangYaPan] client_id is required, please provide a valid client_id",
      )
    }
    if (!normalizeDeviceID(this.addition.device_id)) {
      this.addition.device_id = randomDeviceID()
    }
    if (!(this.addition.order_by >= 0)) this.addition.order_by = 3
    if (this.addition.sort_type !== 0 && this.addition.sort_type !== 1) {
      this.addition.sort_type = 1
    }
    this.rootFolderId = ""
    this.rootFolderResolved = false

    // Priority: access_token -> refresh_token -> sms login.
    if (this.accessToken) {
      try {
        await this.validateToken()
        await this.prepareRootFolder()
        return
      } catch {
        this.accessToken = ""
        this.addition.access_token = ""
      }
    }
    if (this.refreshTokenVal) {
      try {
        await this.refreshToken()
        await this.validateToken()
        await this.prepareRootFolder()
        return
      } catch {
        /* fall through to SMS */
      }
    }
    // Two-stage SMS flow:
    // 1) phone only + send_code=true: send code and cache verification_id
    //    (init still succeeds so the storage is not marked broken).
    // 2) phone + verify_code: complete login and save tokens.
    if (this.addition.phone_number) {
      if (this.addition.verify_code) {
        await this.loginBySMSCode()
        await this.validateToken()
        await this.prepareRootFolder()
        return
      }
      if (this.addition.send_code) {
        try {
          await this.prepareSMSCode()
          console.info(
            "[GuangYaPan] SMS sent successfully. Please fill verify_code and save to complete login.",
          )
        } catch (e: any) {
          console.warn(
            `[GuangYaPan] SMS send failed: ${e.message}. Please check captcha/meta and set send_code=true to retry.`,
          )
        }
      }
      return
    }
    throw new Error(
      "[GuangYaPan] login failed: provide a valid access_token, or refresh_token, or phone_number + verify_code + captcha_token",
    )
  }

  public async ensureAccessToken(): Promise<void> {
    if (this.accessToken) return
    if (!this.refreshTokenVal) {
      throw new Error("[GuangYaPan] not logged in, please re-init storage")
    }
    await this.refreshToken()
  }

  /** Go: validateToken — GET /v1/user/me with Bearer token */
  public async validateToken(): Promise<void> {
    const res = await this.accountRequest<GuangYaPanUserMeResp>(
      "/v1/user/me",
      "GET",
      undefined,
      { Authorization: "Bearer " + this.accessToken },
    )
    if (!(res.sub || "").trim()) {
      throw new Error("[GuangYaPan] validate token failed: empty user sub")
    }
  }

  /** Go: refreshToken — POST /v1/auth/token (grant_type=refresh_token) */
  public async refreshToken(): Promise<void> {
    if (!this.refreshTokenVal) {
      throw new Error("[GuangYaPan] refresh_token is empty")
    }
    if (this.accessToken) {
      try {
        await this.validateToken()
        return
      } catch {
        /* token invalid, continue with refresh */
      }
    }
    const out = await this.accountRequest<GuangYaPanTokenResp>(
      "/v1/auth/token",
      "POST",
      {
        client_id: this.addition.client_id,
        grant_type: "refresh_token",
        refresh_token: this.refreshTokenVal,
      },
    )
    if (out.error || !(out.access_token || "").trim()) {
      const msg =
        (out.error_description || "").trim() ||
        (out.error || "").trim() ||
        "unknown error"
      throw new Error(`[GuangYaPan] refresh token failed: ${msg}`)
    }
    this.accessToken = out.access_token.trim()
    if ((out.refresh_token || "").trim()) {
      this.refreshTokenVal = out.refresh_token.trim()
    }
    // Go: op.MustSaveDriverStorage(d) — write back + optional callback
    this.addition.access_token = this.accessToken
    this.addition.refresh_token = this.refreshTokenVal
    this.onTokenRefresh?.({
      access_token: this.accessToken,
      refresh_token: this.refreshTokenVal,
    })
  }

  // ── SMS login (Go loginBySMSCode / prepareSMSCode) ────────────────────────

  /** Send SMS code (stage 1): captcha init + /v1/auth/verification */
  public async prepareSMSCode(): Promise<void> {
    // Explicit send action should always refresh verification_id.
    this.addition.verification_id = ""
    await this.ensureCaptchaToken(false)
    const verificationId = await this.requestVerificationID()
    this.addition.verification_id = verificationId
    this.addition.send_code = false
  }

  /** Complete SMS login (stage 2): verify code + signin */
  public async loginBySMSCode(): Promise<void> {
    let verificationId = (this.addition.verification_id || "").trim()
    if (!verificationId) {
      verificationId = await this.requestVerificationID()
    }

    const step2 = await this.accountRequest<GuangYaPanVerifyResp>(
      "/v1/auth/verification/verify",
      "POST",
      {
        verification_id: verificationId,
        verification_code: this.addition.verify_code,
        client_id: this.addition.client_id,
      },
    )
    if (step2.error || !(step2.verification_token || "").trim()) {
      const msg =
        (step2.error_description || "").trim() ||
        (step2.error || "").trim() ||
        "unknown error"
      throw new Error(`[GuangYaPan] verify code failed: ${msg}`)
    }

    const out = await this.accountRequest<GuangYaPanTokenResp>(
      "/v1/auth/signin",
      "POST",
      {
        verification_code: this.addition.verify_code,
        verification_token: step2.verification_token,
        username: normalizePhoneE164(this.addition.phone_number),
        client_id: this.addition.client_id,
      },
    )
    if (out.error || !(out.access_token || "").trim()) {
      const msg =
        (out.error_description || "").trim() ||
        (out.error || "").trim() ||
        "unknown error"
      throw new Error(`[GuangYaPan] signin failed: ${msg}`)
    }

    this.accessToken = (out.access_token || "").trim()
    this.refreshTokenVal = (out.refresh_token || "").trim()
    this.addition.verification_id = ""
    // One-time SMS code should not be reused after successful login.
    this.addition.verify_code = ""
    this.addition.access_token = this.accessToken
    this.addition.refresh_token = this.refreshTokenVal
    this.onTokenRefresh?.({
      access_token: this.accessToken,
      refresh_token: this.refreshTokenVal,
    })
  }

  /** Go: requestVerificationID — POST /v1/auth/verification */
  private async requestVerificationID(): Promise<string> {
    const extra: Record<string, string> = {}
    if (this.addition.captcha_token) {
      extra["X-Captcha-Token"] = this.addition.captcha_token
    }
    const step1 = await this.accountRequest<GuangYaPanVerificationResp>(
      "/v1/auth/verification",
      "POST",
      {
        phone_number: normalizePhoneE164(this.addition.phone_number),
        target: "ANY",
        client_id: this.addition.client_id,
      },
      extra,
    )
    if (step1.error || !(step1.verification_id || "").trim()) {
      // If captcha token is expired/invalid, refresh it once and retry.
      const errText = `${step1.error || ""} ${step1.error_description || ""}`
      if (
        errText.includes("captcha_invalid") ||
        errText.includes("captcha_token expired")
      ) {
        try {
          await this.ensureCaptchaToken(true)
          return await this.requestVerificationID()
        } catch {
          /* fall through */
        }
      }
      const msg =
        (step1.error_description || "").trim() ||
        (step1.error || "").trim() ||
        "unknown error"
      throw new Error(`[GuangYaPan] request verification failed: ${msg}`)
    }
    return step1.verification_id.trim()
  }

  /** Go: ensureCaptchaToken — POST /v1/shield/captcha/init */
  private async ensureCaptchaToken(force: boolean): Promise<void> {
    if (!force && this.addition.captcha_token) return
    const extra: Record<string, string> = {}
    if (this.addition.captcha_token) {
      extra["X-Captcha-Token"] = this.addition.captcha_token
    }
    const phone = normalizePhoneE164(this.addition.phone_number)
    const out = await this.accountRequest<GuangYaPanCaptchaInitResp>(
      "/v1/shield/captcha/init",
      "POST",
      {
        client_id: this.addition.client_id,
        action: "POST:/v1/auth/verification",
        device_id: this.addition.device_id,
        meta: {
          username: phone,
          phone_number: phone,
          VERIFICATION_PHONE: phone,
        },
      },
      extra,
    )
    if (out.error || !(out.captcha_token || "").trim()) {
      const msg =
        (out.error_description || "").trim() ||
        (out.error || "").trim() ||
        "unknown error"
      throw new Error(`[GuangYaPan] init captcha token failed: ${msg}`)
    }
    this.addition.captcha_token = out.captcha_token.trim()
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  /** account.guangyapan.com request with the device/client header set */
  private async accountRequest<T>(
    path: string,
    method: "GET" | "POST",
    body?: any,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Device-Model": "chrome%2F147.0.0.0",
      "X-Device-Name": "PC-Chrome",
      "X-Device-Sign": this.deviceSign(),
      "X-Net-Work-Type": "NONE",
      "X-OS-Version": "MacIntel",
      "X-Platform-Version": "1",
      "X-Protocol-Version": "301",
      "X-Provider-Name": "NONE",
      "X-SDK-Version": "9.0.2",
      "X-Client-Id": this.addition.client_id,
      "X-Client-Version": "0.0.1",
      "X-Device-Id": this.addition.device_id,
      ...extraHeaders,
    }
    const res = await fetch(ACCOUNT_BASE_URL + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `[GuangYaPan] request failed: status=${res.status} body=${text.slice(0, 200)}`,
      )
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(
        `[GuangYaPan] invalid JSON response: ${text.slice(0, 200)}`,
      )
    }
  }

  private deviceSign(): string {
    const sign = (this.addition.device_sign || "").trim()
    if (sign) return sign
    return "wdi10." + this.addition.device_id
  }

  /** Go: apiRateLimitWait — throttle per endpoint */
  private async rateLimitWait(path: string): Promise<void> {
    const last = this.lastRequestAt.get(path) || 0
    const wait = last + API_RATE_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastRequestAt.set(path, Date.now())
  }

  /**
   * Go: postAPI — POST api.guangyapan.com with Bearer token;
   * on 401/403 refresh the token once and retry.
   */
  public async postAPI<T>(path: string, body: any, retry = true): Promise<T> {
    await this.ensureAccessToken()
    await this.rateLimitWait(path)
    const doFetch = (): Promise<Response> =>
      fetch(API_BASE_URL + path, {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.accessToken,
          Did: this.addition.device_id,
          Dt: "4",
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(30_000),
      })

    let res = await doFetch()
    if ((res.status === 401 || res.status === 403) && retry) {
      if (!this.refreshTokenVal) {
        const text = await res.text()
        throw new Error(
          `[GuangYaPan] request failed: status=${res.status} body=${text.slice(0, 200)}`,
        )
      }
      await this.refreshToken()
      res = await doFetch()
    }
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `[GuangYaPan] request failed: status=${res.status} body=${text.slice(0, 200)}`,
      )
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(
        `[GuangYaPan] invalid JSON response: ${text.slice(0, 200)}`,
      )
    }
  }

  // ── Data API (Go driver.go) ───────────────────────────────────────────────

  /** Go: List — paginated POST /userres/v1/file/get_file_list */
  public async getFiles(parentId: string): Promise<GuangYaPanFile[]> {
    const pageSize = this.getPageSize()
    const result: GuangYaPanFile[] = []
    const maxPage = 10000
    for (let page = 0; page < maxPage; page++) {
      const resp = await this.postAPI<GuangYaPanListResp>(
        "/userres/v1/file/get_file_list",
        {
          parentId,
          page,
          pageSize,
          orderBy: this.addition.order_by,
          sortType: this.addition.sort_type,
        },
      )
      const list = resp.data?.list || []
      result.push(...list)
      if (list.length < pageSize) break
      if (resp.data?.total > 0 && result.length >= resp.data.total) break
    }
    return result
  }

  /** Go: Link — POST /nd.bizuserres.s/v1/get_res_download_url */
  public async getDownloadUrl(fileId: string): Promise<string> {
    const resp = await this.postAPI<GuangYaPanDownloadResp>(
      "/nd.bizuserres.s/v1/get_res_download_url",
      { fileId },
    )
    const url = (resp.data?.signedURL || "").trim()
    if (url) return url
    const url2 = (resp.data?.downloadUrl || "").trim()
    if (url2) return url2
    throw new Error("[GuangYaPan] empty download url")
  }

  /** Go: MakeDir — POST /nd.bizuserres.s/v1/file/create_dir */
  public async makeDir(parentId: string, dirName: string): Promise<void> {
    const name = (dirName || "").trim()
    if (!name) throw new Error("[GuangYaPan] dir name is empty")
    const out = await this.postAPI<GuangYaPanCreateDirResp>(
      "/nd.bizuserres.s/v1/file/create_dir",
      { parentId, dirName: name },
    )
    if (!isSuccessMsg(out.msg)) {
      throw new Error(`[GuangYaPan] make dir failed: ${out.msg}`)
    }
  }

  /** Go: Rename — POST /nd.bizuserres.s/v1/file/rename */
  public async rename(fileId: string, newName: string): Promise<void> {
    const id = (fileId || "").trim()
    if (!id) throw new Error("[GuangYaPan] file id is empty")
    const name = (newName || "").trim()
    if (!name) throw new Error("[GuangYaPan] new name is empty")
    const out = await this.postAPI<{ code: number; msg: string }>(
      "/nd.bizuserres.s/v1/file/rename",
      { fileId: id, newName: name },
    )
    if (!isSuccessMsg(out.msg)) {
      throw new Error(`[GuangYaPan] rename failed: ${out.msg}`)
    }
  }

  /** Go: Remove — POST /nd.bizuserres.s/v1/file/delete_file (+ task wait) */
  public async remove(fileId: string): Promise<void> {
    const id = (fileId || "").trim()
    if (!id) throw new Error("[GuangYaPan] file id is empty")
    const del = await this.postAPI<GuangYaPanTaskResp>(
      "/nd.bizuserres.s/v1/file/delete_file",
      { fileIds: [id] },
    )
    if (!isSuccessMsg(del.msg)) {
      throw new Error(`[GuangYaPan] delete failed: ${del.msg}`)
    }
    const taskId = (del.data?.taskId || "").trim()
    if (!taskId) return // deletion applied synchronously
    await this.waitTaskDone(taskId)
  }

  /** Go: Move — POST /nd.bizuserres.s/v1/file/move_file */
  public async move(fileId: string, parentId: string): Promise<void> {
    const id = (fileId || "").trim()
    if (!id) throw new Error("[GuangYaPan] file id is empty")
    const out = await this.postAPI<GuangYaPanTaskResp>(
      "/nd.bizuserres.s/v1/file/move_file",
      { fileIds: [id], parentId },
    )
    if (!isSuccessMsg(out.msg)) {
      throw new Error(`[GuangYaPan] move failed: ${out.msg}`)
    }
    const taskId = (out.data?.taskId || "").trim()
    if (!taskId) return
    await this.waitTaskDone(taskId)
  }

  /** Go: Copy — POST /nd.bizuserres.s/v1/file/copy_file */
  public async copy(fileId: string, parentId: string): Promise<void> {
    const id = (fileId || "").trim()
    if (!id) throw new Error("[GuangYaPan] file id is empty")
    const out = await this.postAPI<GuangYaPanTaskResp>(
      "/nd.bizuserres.s/v1/file/copy_file",
      { fileIds: [id], parentId },
    )
    if (!isSuccessMsg(out.msg)) {
      throw new Error(`[GuangYaPan] copy failed: ${out.msg}`)
    }
    const taskId = (out.data?.taskId || "").trim()
    if (!taskId) return
    await this.waitTaskDone(taskId)
  }

  /** Go: waitTaskDone — poll /nd.bizuserres.s/v1/get_task_status */
  public async waitTaskDone(taskId: string): Promise<void> {
    const maxTry = 30
    const interval = 300
    for (let i = 0; i < maxTry; i++) {
      const out = await this.postAPI<GuangYaPanTaskStatusResp>(
        "/nd.bizuserres.s/v1/get_task_status",
        { taskId },
      )
      if (!isSuccessMsg(out.msg)) {
        throw new Error(`[GuangYaPan] get task status failed: ${out.msg}`)
      }
      const status = out.data?.status
      if (status === 2) return
      if (status === -1 || status === 3) {
        throw new Error(
          `[GuangYaPan] task ${taskId} failed with status=${status}`,
        )
      }
      if (i < maxTry - 1) await sleep(interval)
    }
    throw new Error(`[GuangYaPan] task ${taskId} timeout`)
  }

  // ── Root folder resolution (Go prepareRootFolder / resolveFolderPath) ─────

  public async prepareRootFolder(): Promise<void> {
    if (this.rootFolderResolved) return
    await this.ensureAccessToken()
    this.rootFolderId = await this.resolveFolderPath(
      this.addition.root_path || "",
    )
    this.rootFolderResolved = true
  }

  /** Walk a name path from the drive root, matching folders by name */
  public async resolveFolderPath(rootPath: string): Promise<string> {
    const cleanPath = (rootPath || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
    if (!cleanPath) return ""
    let parentId = ""
    for (const name of cleanPath.split("/")) {
      if (!name) continue
      const childId = await this.findChildFolderID(parentId, name)
      parentId = childId
    }
    return parentId
  }

  /** Go: findChildFolderID — paged folder lookup by name */
  private async findChildFolderID(
    parentId: string,
    name: string,
  ): Promise<string> {
    const pageSize = this.getPageSize()
    const maxPage = 10000
    let seen = 0
    for (let page = 0; page < maxPage; page++) {
      const resp = await this.postAPI<GuangYaPanListResp>(
        "/nd.bizuserres.s/v1/file/get_file_list",
        {
          parentId,
          page,
          pageSize,
          orderBy: this.addition.order_by,
          sortType: this.addition.sort_type,
        },
      )
      const list = resp.data?.list || []
      for (const item of list) {
        seen++
        if (item.resType === 2 && item.fileName === name) return item.fileId
      }
      if (list.length < pageSize) break
      if (resp.data?.total > 0 && seen >= resp.data.total) break
    }
    if (parentId === "") {
      throw new Error(
        `[GuangYaPan] resolve root folder path failed: folder "${name}" not found under /`,
      )
    }
    throw new Error(
      `[GuangYaPan] resolve root folder path failed: folder "${name}" not found under parent ${parentId}`,
    )
  }
}
