// WPS HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/wps
//
// Cookie-based auth against the WPS/KDocs web APIs (kdocs.cn). Personal
// accounts talk to https://drive.wps.cn, business accounts to
// https://365.kdocs.cn (see Go util.go driveHost/drivePrefix).
// Uploads use the single-request presigned-URL pipeline from Go put.go
// (create_update → PUT/POST whole file → commit), which is fully portable
// to fetch + Web Crypto (no chunked OSS/S3 pipeline involved).
import {
  WpsAddition,
  WpsApiResult,
  WpsDownloadResp,
  WpsFileInfo,
  WpsFilesResp,
  WpsGroup,
  WpsGroupsResp,
  WpsLoginState,
  WpsNode,
  WpsPersonalGroupsResp,
  WpsUploadCreateResp,
  WpsUploadPutResp,
} from "./types"

// OpenList drivers/base client.go UserAgent (used by Go getUA fallback)
export const WPS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

/** Go util.go ENDPOINT_BUSINESS */
export const ENDPOINT_BUSINESS = "https://365.kdocs.cn"
/** Go util.go ENDPOINT_PERSONAL */
export const ENDPOINT_PERSONAL = "https://drive.wps.cn"

const API_TIMEOUT = 30_000 // Go base.DefaultTimeout via NewRestyClient
const UPLOAD_TIMEOUT = 300_000 // Go disables the client timeout for uploads
const DUPLICATED_RETRY_MAX = 20 // safety cap (Go retries forever)

/** Result of the presigned-URL upload step (etag / store key / server sha1) */
export interface WpsUploadResult {
  etag: string
  key: string
  sha1: string
}

interface RequestResult<T> {
  status: number
  data: T
  text: string
}

/** Go util.go statusOK */
function statusOK(code: number, expect?: number[]): boolean {
  if (!expect || expect.length === 0) {
    return code >= 200 && code < 300
  }
  return expect.includes(code)
}

/** Go util.go checkAPI — result != "" && != "ok" → error, then HTTP status */
function checkAPI(status: number, result: WpsApiResult): void {
  const r = (result?.result || "").trim()
  if (r && r !== "ok") {
    throw new Error(`[WPS] ${r}: ${result?.msg || "unknown error"}`)
  }
  if (status >= 400) {
    throw new Error(`[WPS] ${result?.msg || `http error: ${status}`}`)
  }
}

/** Go util.go normalizeETag: strip W/ prefix and double quotes */
function normalizeETag(v: string): string {
  let s = (v || "").trim()
  if (s.startsWith("W/")) {
    s = s.slice(2).trim()
  }
  return s.replace(/^"+/, "").replace(/"+$/, "")
}

/** Go util.go respArg: "header.X" / "body.Y" response argument extraction */
function respArg(arg: string, res: Response, body: string): string {
  arg = (arg || "").trim()
  if (!arg) return ""
  const l = arg.toLowerCase()
  if (l.startsWith("header.")) {
    const h = arg.slice("header.".length).trim()
    if (!h) return ""
    return (res.headers.get(h) || "").trim()
  }
  if (l.startsWith("body.")) {
    const k = arg.slice("body.".length).trim()
    if (!k) return ""
    try {
      const m = JSON.parse(body)
      const v = m ? (m as Record<string, unknown>)[k] : undefined
      if (typeof v === "string") return v.trim()
    } catch {
      /* non-JSON body */
    }
  }
  return ""
}

/** Go util.go extractXMLTag: case-insensitive <tag>...</tag> extraction */
function extractXMLTag(v: string, tag: string): string {
  const s = (v || "").trim()
  if (!s) return ""
  const open = `<${tag.toLowerCase()}>`
  const clos = `</${tag.toLowerCase()}>`
  const ls = s.toLowerCase()
  const i = ls.indexOf(open)
  if (i < 0) return ""
  const start = i + open.length
  const j = ls.indexOf(clos, start)
  if (j < 0) return ""
  let r = s.slice(start, j).trim()
  r = r.split("&quot;").join("")
  return r.replace(/^["']+/, "").replace(/["']+$/, "")
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class WpsClient {
  private addition: WpsAddition
  private cookie: string
  /** Go Wps.login — populated by init() via the islogin API */
  login: WpsLoginState | null = null
  /** groups cache (invalidated on writes) */
  private groupsCache: WpsGroup[] | null = null
  /** "${groupId}:${parentId}" → listing cache (invalidated on writes) */
  private filesCache = new Map<string, WpsFileInfo[]>()

  constructor(addition: WpsAddition) {
    this.addition = addition
    this.cookie = (addition.cookie || "").trim()
  }

  getCookie(): string {
    return this.cookie
  }

  /** Go meta.go Mode select — default "Personal" */
  getMode(): string {
    return (this.addition.mode || "").trim() || "Personal"
  }

  /** Go isPersonal(): prefer the islogin state, one session = one type */
  isPersonal(): boolean {
    if (this.login) return !this.login.is_company_account
    return this.getMode() === "Personal"
  }

  driveHost(): string {
    return this.isPersonal() ? ENDPOINT_PERSONAL : ENDPOINT_BUSINESS
  }

  drivePrefix(): string {
    return this.isPersonal() ? "" : "/3rd/drive"
  }

  driveURL(path: string): string {
    return this.driveHost() + this.drivePrefix() + path
  }

  /** Go getUA(): custom UA or the OpenList default */
  getUA(): string {
    return (this.addition.custom_ua || "").trim() || WPS_USER_AGENT
  }

  invalidateCaches(): void {
    this.groupsCache = null
    this.filesCache.clear()
  }

  /**
   * Core request wrapper (Go request()/jsonRequest()): Cookie + Accept +
   * User-Agent; JSON bodies additionally get Content-Type + Origin.
   * Returns { status, data, text } — callers apply checkAPI() themselves so
   * the fileTaskDuplicated retry can inspect 403 responses first.
   */
  private async request<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    opts?: { body?: unknown; timeout?: number },
  ): Promise<RequestResult<T>> {
    const headers: Record<string, string> = {
      Cookie: this.cookie,
      Accept: "application/json",
      "User-Agent": this.getUA(),
    }
    let body: string | undefined
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json"
      headers["Origin"] = this.driveHost()
      body = JSON.stringify(opts.body)
    }

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(opts?.timeout || API_TIMEOUT),
      })
    } catch (e) {
      throw new Error(
        `[WPS] request ${method} ${url} failed: ${(e as Error).message}`,
      )
    }

    const text = await res.text()
    let parsed: any = {}
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        /* non-JSON body */
      }
    }
    return { status: res.status, data: parsed as T, text }
  }

  /** Go Init(): cookie required, then the islogin check */
  async init(): Promise<void> {
    if (!this.cookie) {
      throw new Error("[WPS] cookie is empty")
    }
    const { status, data, text } = await this.request<WpsLoginState & any>(
      "GET",
      "https://account.kdocs.cn/api/v3/islogin",
    )
    if (status >= 400) {
      throw new Error(
        `[WPS] failed to check login status, status code: ${status}, body: ${text.slice(0, 200)}`,
      )
    }
    // some responses wrap the payload in "data"
    this.login =
      data && typeof data.userid === "undefined" && data.data
        ? (data.data as WpsLoginState)
        : (data as WpsLoginState)
  }

  /** Go util.go getGroups() — different APIs per configured Mode */
  async getGroups(): Promise<WpsGroup[]> {
    if (this.groupsCache) return this.groupsCache
    switch (this.getMode()) {
      case "Personal": {
        const { status, data } = await this.request<WpsPersonalGroupsResp>(
          "GET",
          this.driveURL("/api/v3/groups"),
        )
        checkAPI(status, data)
        const groups: WpsGroup[] = (data.groups || []).map((g) => ({
          group_id: g.id,
          name: g.name,
        }))
        this.groupsCache = groups
        return groups
      }
      case "Business": {
        const companyID = this.login?.companyid || 0
        const url = `${ENDPOINT_BUSINESS}/3rd/plus/groups/v1/companies/${companyID}/users/self/groups/private`
        const { status, data } = await this.request<WpsGroupsResp>("GET", url)
        if (status >= 400) {
          throw new Error(`[WPS] http error: ${status}`)
        }
        this.groupsCache = data.groups || []
        return this.groupsCache
      }
    }
    throw new Error(`[WPS] unsupported mode: ${this.getMode()}`)
  }

  /** Go util.go getFiles(): paginated by next_offset (-1 = done), 50 pages max */
  async getFiles(groupID: number, parentID: number): Promise<WpsFileInfo[]> {
    const cacheKey = `${groupID}:${parentID}`
    const cached = this.filesCache.get(cacheKey)
    if (cached) return cached

    const files: WpsFileInfo[] = []
    let nextOffset = 0
    for (let i = 0; i < 50; i++) {
      const url = new URL(`${this.driveURL("")}/api/v5/groups/${groupID}/files`)
      url.searchParams.set("parentid", String(parentID))
      url.searchParams.set("offset", String(nextOffset))
      const { status, data } = await this.request<WpsFilesResp>(
        "GET",
        url.toString(),
      )
      if (status >= 400) {
        throw new Error(`[WPS] http error: ${status}`)
      }
      files.push(...(data.files || []))
      const no = typeof data.next_offset === "number" ? data.next_offset : -1
      if (no === -1) break
      nextOffset = no
    }
    this.filesCache.set(cacheKey, files)
    return files
  }

  /** Go Link(): GET download url (requires the session cookie) */
  async getDownloadUrl(
    groupID: number,
    fileID: number,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const url = `${this.driveURL("")}/api/v5/groups/${groupID}/files/${fileID}/download?support_checksums=sha1`
    const { status, data } = await this.request<WpsDownloadResp>("GET", url)
    if (status >= 400) {
      throw new Error(`[WPS] http error: ${status}`)
    }
    if (!data.url) {
      throw new Error("[WPS] empty download url")
    }
    return {
      url: data.url,
      headers: {
        "User-Agent": this.getUA(),
        Referer: this.driveHost(),
      },
    }
  }

  /** Go MakeDir(): POST /api/v5/files/folder */
  async makeDir(
    groupID: number,
    parentID: number,
    name: string,
  ): Promise<void> {
    const { status, data } = await this.request<WpsApiResult>(
      "POST",
      this.driveURL("/api/v5/files/folder"),
      { body: { groupid: groupID, name, parentid: parentID } },
    )
    checkAPI(status, data)
  }

  /** Go Rename(): PUT /api/v3/groups/{gid}/files/{fid} */
  async rename(
    groupID: number,
    fileID: number,
    newName: string,
  ): Promise<void> {
    const { status, data } = await this.request<WpsApiResult>(
      "PUT",
      this.driveURL(`/api/v3/groups/${groupID}/files/${fileID}`),
      { body: { fname: newName } },
    )
    checkAPI(status, data)
  }

  /** Go Move(): batch/move with the fileTaskDuplicated retry loop */
  async move(src: WpsNode, dst: WpsNode): Promise<void> {
    const targetParentID = dst.kind === "folder" ? dst.fileID : 0
    const body = {
      fileids: [src.fileID],
      target_groupid: dst.groupID,
      target_parentid: targetParentID,
    }
    await this.postWithDuplicatedRetry(
      this.driveURL(`/api/v3/groups/${src.groupID}/files/batch/move`),
      body,
    )
  }

  /** Go Copy(): batch/copy with the fileTaskDuplicated retry loop */
  async copy(src: WpsNode, dst: WpsNode): Promise<void> {
    const targetParentID = dst.kind === "folder" ? dst.fileID : 0
    const body = {
      fileids: [src.fileID],
      groupid: src.groupID,
      target_groupid: dst.groupID,
      target_parentid: targetParentID,
      duplicated_name_model: 1,
    }
    await this.postWithDuplicatedRetry(
      this.driveURL(`/api/v3/groups/${src.groupID}/files/batch/copy`),
      body,
    )
  }

  /** Go Remove(): batch/delete with the fileTaskDuplicated retry loop */
  async remove(node: WpsNode): Promise<void> {
    const body = { fileids: [node.fileID] }
    await this.postWithDuplicatedRetry(
      this.driveURL(`/api/v3/groups/${node.groupID}/files/batch/delete`),
      body,
    )
  }

  /**
   * Go Move/Copy/Remove retry pattern: HTTP 403 + result "fileTaskDuplicated"
   * means the previous task on the same files is still running — wait 0.5s
   * and retry (Go loops forever, capped here for the stateless runtime).
   */
  private async postWithDuplicatedRetry(
    url: string,
    body: unknown,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { status, data } = await this.request<WpsApiResult>("POST", url, {
        body,
      })
      if (
        status === 403 &&
        (data.result || "").trim() === "fileTaskDuplicated"
      ) {
        if (attempt >= DUPLICATED_RETRY_MAX) {
          throw new Error("[WPS] fileTaskDuplicated: retry limit exceeded")
        }
        await sleep(500)
        continue
      }
      checkAPI(status, data)
      return
    }
  }

  /** Go put.go createUpload(): PUT /api/v5/files/upload/create_update */
  async createUpload(
    groupID: number,
    parentID: number,
    name: string,
    size: number,
    sha1Hex: string,
    sha256Hex: string,
  ): Promise<WpsUploadCreateResp> {
    const body = {
      group_id: String(groupID),
      name,
      parent_id: String(parentID),
      sha1: sha1Hex,
      sha256: sha256Hex,
      size: String(size),
    }
    const { status, data } = await this.request<WpsUploadCreateResp>(
      "PUT",
      this.driveURL("/api/v5/files/upload/create_update"),
      { body },
    )
    checkAPI(status, data)
    if (!data.url) {
      throw new Error("[WPS] empty upload url")
    }
    return data
  }

  /**
   * Go put.go upload step: single PUT/POST of the whole file to the
   * presigned URL (optionally multipart/form-data), then extract
   * etag / store key / server-side sha1 from the response.
   */
  async uploadToUrl(
    info: WpsUploadCreateResp,
    uploadName: string,
    data: Uint8Array,
    localSha1: string,
  ): Promise<WpsUploadResult> {
    const method = (info.method || "").trim().toUpperCase() || "PUT"
    const extraHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(info.request?.headers || {})) {
      extraHeaders[k] = v
    }

    let body: BodyInit
    if (
      method === "POST" &&
      Object.keys(info.request?.formData || {}).length > 0
    ) {
      // Go builds multipart form data with the extra fields + "file" part
      const form = new FormData()
      for (const [k, v] of Object.entries(info.request!.formData!)) {
        form.append(k, v)
      }
      form.append(
        "file",
        new Blob([new Uint8Array(data)], { type: "application/octet-stream" }),
        uploadName,
      )
      // the boundary Content-Type must come from fetch itself
      delete extraHeaders["Content-Type"]
      delete extraHeaders["content-type"]
      body = form
    } else {
      body = new Uint8Array(data)
    }

    let res: Response
    try {
      res = await fetch(info.url!, {
        method,
        headers: extraHeaders,
        body,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
      })
    } catch (e) {
      throw new Error(`[WPS] upload request failed: ${(e as Error).message}`)
    }

    if (!statusOK(res.status, info.response?.expect_code)) {
      throw new Error(`[WPS] upload http error: ${res.status}`)
    }

    const text = await res.text()

    let etag = normalizeETag(respArg(info.response?.args_etag || "", res, text))
    if (!etag) {
      etag = normalizeETag(res.headers.get("etag") || "")
    }

    let key = respArg(info.response?.args_key || "", res, text).trim()
    if (!key) {
      key = (res.headers.get("x-obs-save-key") || "").trim()
    }

    // Go: some endpoints answer JSON {newfilename|sha1|md5}
    let sha1FromServer = ""
    try {
      const pr = JSON.parse(text) as WpsUploadPutResp
      sha1FromServer = (pr.newfilename || "").trim()
      if (!sha1FromServer) {
        sha1FromServer = (pr.sha1 || "").trim()
      }
      if (!etag && pr.md5) {
        etag = (pr.md5 || "").trim()
      }
    } catch {
      /* non-JSON body (e.g. OBS XML) */
    }
    if (!sha1FromServer) {
      const v = extractXMLTag(text, "ETag")
      if (v) {
        sha1FromServer = v
        if (!etag) etag = v
      }
    }
    if (!sha1FromServer && key && key.length === 40) {
      sha1FromServer = key
    }
    if (!sha1FromServer) {
      sha1FromServer = localSha1
    }

    if (!etag) {
      throw new Error("[WPS] empty etag")
    }
    if (!sha1FromServer) {
      throw new Error("[WPS] empty sha1")
    }
    return { etag, key, sha1: sha1FromServer }
  }

  /** Go put.go commitUpload(): POST /api/v5/files/file */
  async commitUpload(params: {
    etag: string
    key: string
    sha1: string
    groupID: number
    parentID: number
    name: string
    size: number
    store: string
  }): Promise<void> {
    const store = (params.store || "").trim() || "ks3"
    const body = {
      etag: params.etag,
      groupid: params.groupID,
      key: params.key,
      name: params.name,
      parentid: params.parentID,
      sha1: params.sha1,
      size: params.size,
      store,
      storekey: params.key,
    }
    const { status, data } = await this.request<WpsApiResult>(
      "POST",
      this.driveURL("/api/v5/files/file"),
      { body },
    )
    checkAPI(status, data)
  }
}
