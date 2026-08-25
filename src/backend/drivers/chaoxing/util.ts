// ChaoXing (超星学习通小组网盘) HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/chaoxing
import {
  ChaoxingAddition,
  ChaoxingDownResp,
  ChaoxingFile,
  ChaoxingListResp,
  ChaoxingUploadConfigResp,
  ChaoxingUploadFileResp,
} from "./types"

// Go meta.go Conf{} — the (quirky) quark-cloud-drive UA is kept byte-for-byte
export const CHAOXING_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch"
const REFERER = "https://chaoxing.com/"
const API_BASE = "https://groupweb.chaoxing.com"
const DOWNLOAD_API = "https://noteyd.chaoxing.com"
const UPLOAD_API = "https://pan-yz.chaoxing.com/upload"
const LOGIN_API = "https://passport2.chaoxing.com/fanyalogin"
// passport2.chaoxing.com login AES key (Go util.go transferKey); IV = key[:16]
const TRANSFER_KEY = "u2oh6Vu^HWe4_AES"

// OpenList drivers/base client.go UserAgent (used by resty for API requests)
const RESTY_UA =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

// Go Init() schedules a cookie refresh every 12h (cron); the stateless port
// refreshes lazily when the in-memory cookie is older than this TTL.
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000

const REQUEST_TIMEOUT = 30_000
const UPLOAD_TIMEOUT = 300_000

/**
 * Go url.QueryEscape semantics: unreserved = alphanumerics + "-_.~" (space is
 * "+" in Go; we emit %20 which every form-style decoder also reads as space —
 * strictly safer than Go for names containing spaces).
 * Used to reproduce the exact wire format resty produces (single encoding for
 * plain values, double encoding for the pre-escaped addResource `params`).
 */
export function goQueryEscape(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/** int | numeric-string → number (Go int_str / int64_str unmarshalers) */
export function toInt(v: number | string | undefined | null): number {
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const n = Number(v)
    if (!isNaN(n) && v.trim() !== "") return n
  }
  return 0
}

/**
 * Parse the three uploadDate forms the API returns (Go int64_str.UnmarshalJSON):
 *  1. ms timestamp number        1780191356415
 *  2. ms timestamp numeric-string "1780191356415"
 *  3. date string                 "2024-11-06 07:49" / "2024-11-06 07:49:30"
 *     (Go time.Parse without zone → parsed as UTC)
 * Returns ms epoch; 0 when unparseable (Go returns 0 as well).
 */
export function parseChaoxingTime(
  v: number | string | undefined | null,
): number {
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const s = v.trim()
    if (s === "") return 0
    const n = Number(s)
    if (!isNaN(n) && s !== "") return n
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)
    if (m) {
      return Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6] || "0"),
      )
    }
  }
  return 0
}

/** Go EncryptByAES(): AES-128-CBC, IV = key[:16], PKCS#7, base64 output */
async function encryptByAES(message: string, key: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key)
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  )
  const iv = keyBytes.slice(0, 16)
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: iv as unknown as BufferSource },
    cryptoKey,
    new TextEncoder().encode(message),
  )
  let binary = ""
  const bytes = new Uint8Array(cipher)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** Go CookiesToString(): "name=value; name2=value2" */
function cookiesFromResponse(res: Response): string {
  let setCookies: string[] = []
  if (typeof (res.headers as any).getSetCookie === "function") {
    setCookies = (res.headers as any).getSetCookie()
  } else {
    const sc = res.headers.get("set-cookie")
    if (sc) setCookies = [sc]
  }
  return setCookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ")
}

/**
 * ChaoXing group-drive client (pan-yz.chaoxing.com is only the upload host).
 *
 * Auth: session cookie. Obtained (Go Login()) by AES-encrypting username and
 * password with the fixed transfer key and POSTing them as a multipart form
 * to passport2.chaoxing.com/fanyalogin; cookies of the response become the
 * session. Go refreshes the cookie every 12h via cron — the port refreshes
 * lazily in ensureCookie() and persists through the optional
 * onCookieRefresh callback (mirrors op.MustSaveDriverStorage).
 */
export class ChaoxingClient {
  private addition: ChaoxingAddition
  private onCookieRefresh?: (cookie: string) => void
  private cookie = ""
  private cookieUpdatedAt = 0

  constructor(
    addition: ChaoxingAddition,
    onCookieRefresh?: (cookie: string) => void,
  ) {
    this.addition = addition
    this.onCookieRefresh = onCookieRefresh
    this.cookie = addition.cookie || ""
  }

  public getCookie(): string {
    return this.cookie
  }

  /** Root folder id (Go Config().DefaultRoot = "-1") */
  public getRootId(): string {
    return this.addition.root_folder_id || "-1"
  }

  private canLogin(): boolean {
    return !!(this.addition.user_name && this.addition.password)
  }

  /**
   * Go Init() + 12h refreshCookie() cron combined:
   * - always (re)login when credentials are available
   * - on failure keep the existing cookie (Go sets storage status and moves on)
   * - throw only when there is no usable cookie at all, so a broken config
   *   surfaces at save time instead of as opaque API errors later
   */
  async ensureCookie(force = false): Promise<void> {
    if (!this.canLogin()) {
      if (!this.cookie) {
        throw new Error(
          "[ChaoXing] no cookie available: fill user_name/password or cookie",
        )
      }
      return
    }
    if (
      !force &&
      this.cookie &&
      Date.now() - this.cookieUpdatedAt < COOKIE_TTL_MS
    ) {
      return
    }
    try {
      await this.login()
    } catch (e: any) {
      if (this.cookie) {
        // keep stale cookie (Go refreshCookie behavior)
        console.warn(
          "[ChaoXing] cookie refresh failed, keeping old cookie:",
          e.message,
        )
        this.cookieUpdatedAt = Date.now() // avoid retrying on every request
        return
      }
      throw e
    }
  }

  /** Go Login(): AES-encrypted credentials → multipart POST → cookie string */
  async login(): Promise<void> {
    const uname = await encryptByAES(this.addition.user_name, TRANSFER_KEY)
    const password = await encryptByAES(this.addition.password, TRANSFER_KEY)
    const form = new FormData()
    form.set("uname", uname)
    form.set("password", password)
    form.set("t", "true")
    const res = await fetch(LOGIN_API, {
      method: "POST",
      body: form,
      headers: { "User-Agent": RESTY_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const cookie = cookiesFromResponse(res)
    if (!cookie) {
      const text = await res.text().catch(() => "")
      throw new Error(
        `[ChaoXing] login failed: no cookies returned (status ${res.status})${text ? ": " + text.slice(0, 200) : ""}`,
      )
    }
    this.cookie = cookie
    this.cookieUpdatedAt = Date.now()
    this.addition.cookie = cookie
    this.onCookieRefresh?.(cookie)
  }

  private baseHeaders(): Record<string, string> {
    return {
      Cookie: this.cookie,
      Accept: "application/json, text/plain, */*",
      Referer: REFERER,
      "User-Agent": RESTY_UA,
    }
  }

  /**
   * Go request(): GET groupweb.chaoxing.com{pathname}?{params}.
   * Query values are encoded with Go QueryEscape semantics; absolute URLs
   * pass through unchanged (Go's getUploadConfig special case).
   */
  async request<T = any>(
    pathname: string,
    params?: Record<string, string>,
    method: "GET" | "POST" = "GET",
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    let url = pathname.startsWith("http") ? pathname : API_BASE + pathname
    if (params && Object.keys(params).length > 0) {
      const qs = Object.entries(params)
        .map(([k, v]) => `${k}=${goQueryEscape(v)}`)
        .join("&")
      url += (url.includes("?") ? "&" : "?") + qs
    }
    const res = await fetch(url, {
      method,
      headers: { ...this.baseHeaders(), ...extraHeaders },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const text = await res.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(
        `[ChaoXing] non-JSON response from ${pathname} (status ${res.status}): ${text.slice(0, 300)}`,
      )
    }
    return data as T
  }

  /** Go requestDownload(): noteyd.chaoxing.com{pathname} */
  async requestDownload<T = any>(
    pathname: string,
    method: "GET" | "POST" = "POST",
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(DOWNLOAD_API + pathname, {
      method,
      headers: { ...this.baseHeaders(), ...extraHeaders },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const text = await res.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(
        `[ChaoXing] non-JSON response from ${pathname} (status ${res.status}): ${text.slice(0, 300)}`,
      )
    }
    return data as T
  }

  /** Go GetFiles(): folders (recType=1) + files (recType=2, fileId fallback) */
  async getFiles(parent: string): Promise<ChaoxingFile[]> {
    const files: ChaoxingFile[] = []
    const base = { bbsid: this.addition.bbsid, folderId: parent }
    const resp = await this.request<ChaoxingListResp>(
      "/pc/resource/getResourceList",
      { ...base, recType: "1" },
    )
    if (resp.result !== 1) {
      throw new Error(
        `[ChaoXing] failed to list folders: error code is:${resp.result} ${resp.msg || ""}`,
      )
    }
    files.push(...(resp.list || []))

    const resps = await this.request<ChaoxingListResp>(
      "/pc/resource/getResourceList",
      { ...base, recType: "2" },
    )
    if (resps.result !== 1) {
      throw new Error(
        `[ChaoXing] failed to list files: error code is:${resps.result} ${resps.msg || ""}`,
      )
    }
    for (const file of resps.list || []) {
      // 手机端超星上传的文件没有 fileID 字段，但 ObjectID 与 fileID 相同，可代替
      if (!file.content.fileId) {
        file.content.fileId = file.content.objectId
      }
      files.push(file)
    }
    return files
  }

  /** Go Link(): POST /screen/note_note/files/status/{fileId} (UA required) */
  async getDownloadUrl(fileId: string): Promise<string> {
    const resp = await this.requestDownload<ChaoxingDownResp>(
      "/screen/note_note/files/status/" + fileId,
      "POST",
      { "User-Agent": CHAOXING_UA },
    )
    return resp.download || resp.url || ""
  }

  /** Headers that must accompany raw_url downloads (Go Link() Header) */
  getDownloadHeaders(): Record<string, string> {
    return {
      Cookie: this.cookie,
      Referer: REFERER,
      "User-Agent": CHAOXING_UA,
    }
  }

  /** Go MakeDir(): /pc/resource/addResourceFolder */
  async makeDir(parentId: string, dirName: string): Promise<void> {
    const resp = await this.request<ChaoxingListResp>(
      "/pc/resource/addResourceFolder",
      {
        bbsid: this.addition.bbsid,
        name: dirName,
        pid: parentId,
      },
    )
    if (resp.result !== 1) {
      throw new Error(`[ChaoXing] makeDir error:${resp.msg}`)
    }
  }

  /** Go Move(): /pc/resource/moveResource (folderIds for dirs, recIds for files) */
  async move(srcId: string, isDir: boolean, targetId: string): Promise<void> {
    const query: Record<string, string> = isDir
      ? {
          bbsid: this.addition.bbsid,
          folderIds: srcId,
          targetId,
        }
      : {
          bbsid: this.addition.bbsid,
          recIds: srcId.split("$")[0],
          targetId,
        }
    const resp = await this.request<ChaoxingListResp>(
      "/pc/resource/moveResource",
      query,
    )
    if (!resp.status) {
      throw new Error(`[ChaoXing] move error:${resp.msg}`)
    }
  }

  /** Go Rename(): folders only — the API has no file rename */
  async renameFolder(folderId: string, newName: string): Promise<void> {
    const resp = await this.request<ChaoxingListResp>(
      "/pc/resource/updateResourceFolderName",
      {
        bbsid: this.addition.bbsid,
        folderId,
        name: newName,
      },
    )
    if (resp.result !== 1) {
      throw new Error(`[ChaoXing] rename error:${resp.msg}`)
    }
  }

  /** Go Remove(): deleteResourceFolder / deleteResourceFile */
  async remove(objId: string, isDir: boolean): Promise<void> {
    let pathname = "/pc/resource/deleteResourceFolder"
    let query: Record<string, string>
    if (isDir) {
      query = { bbsid: this.addition.bbsid, folderIds: objId }
    } else {
      pathname = "/pc/resource/deleteResourceFile"
      query = { bbsid: this.addition.bbsid, recIds: objId.split("$")[0] }
    }
    const resp = await this.request<ChaoxingListResp>(pathname, query)
    if (resp.result !== 1) {
      throw new Error(`[ChaoXing] remove error:${resp.msg}`)
    }
  }

  /**
   * Go Put(): the full three-step upload pipeline.
   *  1. GET https://noteyd.chaoxing.com/pc/files/getUploadConfig → puid+token
   *  2. multipart POST https://pan-yz.chaoxing.com/upload with the file part
   *     first, then `_token` and `puid` fields (same part order as Go's
   *     hand-built multipart body); no Cookie/Referer sent (Go sends none)
   *  3. GET /pc/resource/addResource?bbsid&pid&type=yunpan&params=[...] —
   *     `params` carries url.QueryEscape'd JSON, which resty encodes again,
   *     i.e. it is double-encoded on the wire; reproduced here byte-for-byte
   */
  async upload(
    dstDirId: string,
    fileName: string,
    content: Uint8Array,
  ): Promise<void> {
    const config = await this.request<ChaoxingUploadConfigResp>(
      "https://noteyd.chaoxing.com/pc/files/getUploadConfig",
    )
    if (config.result !== 1 || !config.msg) {
      throw new Error("[ChaoXing] get upload data error")
    }

    const form = new FormData()
    form.set(
      "file",
      new Blob([content as unknown as BlobPart], {
        type: "application/octet-stream",
      }),
      fileName,
    )
    form.set("_token", String(config.msg.token))
    form.set("puid", String(config.msg.puid))

    const uploadRes = await fetch(UPLOAD_API, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    })
    const uploadText = await uploadRes.text()
    let fileRsp: ChaoxingUploadFileResp
    try {
      fileRsp = JSON.parse(uploadText) as ChaoxingUploadFileResp
    } catch {
      throw new Error(
        `[ChaoXing] upload failed: non-JSON response (status ${uploadRes.status}): ${uploadText.slice(0, 300)}`,
      )
    }
    if (fileRsp.msg !== "success") {
      throw new Error(`[ChaoXing] upload failed: ${fileRsp.msg}`)
    }

    const uploadDoneParam = {
      cataid: "100000019",
      key: fileRsp.objectId,
      param: fileRsp.data,
    }
    const resp = await this.request<ChaoxingListResp>(
      "/pc/resource/addResource",
      {
        bbsid: this.addition.bbsid,
        pid: dstDirId,
        type: "yunpan",
        // Go pre-escapes with url.QueryEscape and resty escapes again → the
        // value travels double-encoded; goQueryEscape reproduces that exactly.
        params: goQueryEscape("[" + JSON.stringify(uploadDoneParam) + "]"),
      },
    )
    if (resp.result !== 1) {
      // (Go prints the upload-config msg here due to a typo; we use the
      // addResource msg, which is the response that actually failed)
      throw new Error(`[ChaoXing] addResource error:${resp.msg}`)
    }
  }
}
