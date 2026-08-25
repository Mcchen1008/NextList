// Dropbox HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/dropbox
import {
  CurrentAccountResp,
  DropboxAddition,
  DropboxFile,
  ErrorResp,
  ListResp,
  OnlineApiResp,
  TokenResp,
  UploadFinishArgs,
} from "./types"

const API_BASE = "https://api.dropboxapi.com"
const CONTENT_BASE = "https://content.dropboxapi.com"

/** Response-body keywords that trigger a token refresh + retry (Go util.go) */
const TOKEN_ERROR_KEYWORDS = [
  "expired_access_token",
  "invalid_access_token",
  "authorization",
]

/**
 * 20MB per upload_session/append call — a multiple of the 4MB granularity
 * requirement and below the 150MB per-request cap (Go driver.go Put).
 */
const UPLOAD_PART_SIZE = 20971520

/**
 * JSON.stringify with all non-ASCII characters \u-escaped. The
 * Dropbox-API-Arg / Dropbox-API-Path-Root headers must stay ASCII-only;
 * Go's json.Marshal emits raw UTF-8 (which happens to work), but the
 * escaped form is always safe.
 */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  )
}

export class DropboxClient {
  private addition: DropboxAddition
  private accessToken = ""
  private refreshTokenVal = ""
  private rootNamespaceId = ""
  private onTokenRefresh?: (
    accessToken: string,
    refreshToken: string,
  ) => void | Promise<void>

  constructor(
    addition: DropboxAddition,
    onTokenRefresh?: (
      accessToken: string,
      refreshToken: string,
    ) => void | Promise<void>,
  ) {
    this.addition = addition
    this.onTokenRefresh = onTokenRefresh
    this.accessToken = addition.access_token || ""
    this.refreshTokenVal = addition.refresh_token || ""
    this.rootNamespaceId = addition.RootNamespaceId || ""
  }

  /** Go driver.go Init(): /2/check/user round trip + root namespace lookup */
  async init(): Promise<void> {
    const query = "foo"
    const res = await this.request<{ result?: string }>(
      "/2/check/user",
      "POST",
      { query },
    )
    if (res?.result !== query) {
      throw new Error(`[Dropbox] failed to check user: ${JSON.stringify(res)}`)
    }
    this.rootNamespaceId = await this.getRootNamespaceId()
  }

  /** Go GetRootNamespaceId(): POST /2/users/get_current_account (no body) */
  async getRootNamespaceId(): Promise<string> {
    const res = await this.request<CurrentAccountResp>(
      "/2/users/get_current_account",
      "POST",
    )
    return res?.root_info?.root_namespace_id || ""
  }

  /**
   * Go util.go refreshToken().
   * Online mode: GET the configured relay (api.oplist.org by default) with
   * refresh_ui / server_use / driver_txt=dropboxs_go — no client id/secret
   * needed, and the relay may rotate the refresh token.
   * Direct mode: POST /oauth2/token with the client credentials.
   * Persisted tokens flow back through the onTokenRefresh callback (Go:
   * op.MustSaveDriverStorage).
   */
  async refreshToken(): Promise<void> {
    const apiAddress = (this.addition.api_url_address || "").trim()
    if (this.addition.use_online_api && apiAddress) {
      const params = new URLSearchParams({
        refresh_ui: this.refreshTokenVal,
        server_use: "true",
        driver_txt: "dropboxs_go",
      })
      const res = await fetch(`${apiAddress}?${params.toString()}`, {
        method: "GET",
      })
      const text = await res.text()
      let data: any = {}
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          /* non-JSON body */
        }
      }
      const resp = data as OnlineApiResp
      if (!resp.refresh_token || !resp.access_token) {
        if (resp.text) {
          throw new Error(`[Dropbox] failed to refresh token: ${resp.text}`)
        }
        throw new Error(
          "[Dropbox] empty token returned from official API, a wrong refresh token may have been used",
        )
      }
      this.accessToken = resp.access_token
      this.refreshTokenVal = resp.refresh_token
      await this.onTokenRefresh?.(this.accessToken, this.refreshTokenVal)
      return
    }

    const res = await fetch(`${API_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshTokenVal,
        client_id: this.addition.client_id || "",
        client_secret: this.addition.client_secret || "",
      }).toString(),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`[Dropbox] failed to refresh token: ${text}`)
    }
    let data: any = {}
    try {
      data = JSON.parse(text)
    } catch {
      /* non-JSON body */
    }
    const tokenResp = data as TokenResp
    if (!tokenResp.access_token) {
      throw new Error(`[Dropbox] failed to refresh token: ${text}`)
    }
    this.accessToken = tokenResp.access_token
    await this.onTokenRefresh?.(this.accessToken, this.refreshTokenVal)
  }

  /**
   * Go util.go request(): JSON-RPC call against api.dropboxapi.com with the
   * Dropbox-API-Path-Root header. One refresh + retry when the body mentions
   * an auth keyword (or the access token was empty); other failures raise
   * `error.tag:error_summary` like the Go driver.
   */
  async request<T = any>(
    uri: string,
    method: string,
    body?: Record<string, unknown>,
    retry = true,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: "Bearer " + this.accessToken,
    }
    if (this.rootNamespaceId) {
      headers["Dropbox-API-Path-Root"] = asciiJson({
        ".tag": "root",
        root: this.rootNamespaceId,
      })
    }
    let payload: string | undefined
    if (method === "POST" && body !== undefined) {
      headers["Content-Type"] = "application/json"
      payload = JSON.stringify(body)
    }
    const res = await fetch(API_BASE + uri, { method, headers, body: payload })
    const text = await res.text()
    let data: any = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    const errResp = (data || {}) as ErrorResp

    if (!res.ok) {
      const tokenRelated = TOKEN_ERROR_KEYWORDS.some((k) => text.includes(k))
      if (retry && (tokenRelated || !this.accessToken)) {
        await this.refreshToken()
        return this.request<T>(uri, method, body, false)
      }
      const tag = errResp.error?.[".tag"] || ""
      const summary = errResp.error_summary || ""
      throw new Error(
        `[Dropbox] ${tag ? tag + ":" : ""}${summary || `request failed: HTTP ${res.status} ${text.slice(0, 200)}`}`,
      )
    }
    return (data ?? {}) as T
  }

  /** Go util.go list(): list_folder (+ /continue) */
  private async listFolder(
    data: Record<string, unknown>,
    isContinue: boolean,
  ): Promise<ListResp> {
    const uri = isContinue
      ? "/2/files/list_folder/continue"
      : "/2/files/list_folder"
    return this.request<ListResp>(uri, "POST", data)
  }

  /** Go util.go getFiles(): full listing with cursor-based pagination */
  async getFiles(path: string): Promise<DropboxFile[]> {
    const result: DropboxFile[] = []
    const data: Record<string, unknown> = {
      include_deleted: false,
      include_has_explicit_shared_members: false,
      include_mounted_folders: false,
      include_non_downloadable_files: false,
      limit: 2000,
      path,
      recursive: false,
    }
    const first = await this.listFolder(data, false)
    result.push(...(first.entries || []))
    let cursor = first.cursor || ""
    let hasMore = !!first.has_more
    while (hasMore) {
      const resp = await this.listFolder({ cursor }, true)
      result.push(...(resp.entries || []))
      cursor = resp.cursor || ""
      hasMore = !!resp.has_more
    }
    return result
  }

  /** Go driver.go Link(): temporary download link (Go marks it 1h valid) */
  async getTemporaryLink(path: string): Promise<string> {
    const res = await this.request<{ link?: string }>(
      "/2/files/get_temporary_link",
      "POST",
      { path },
    )
    if (!res.link) {
      throw new Error("[Dropbox] no temporary link returned")
    }
    return res.link
  }

  /** Go driver.go MakeDir() */
  async makeDir(path: string): Promise<void> {
    await this.request("/2/files/create_folder_v2", "POST", {
      autorename: false,
      path,
    })
  }

  /** Go driver.go Move()/Rename(): move_v2 (from_path may be a file id) */
  async move(fromPath: string, toPath: string): Promise<void> {
    await this.request("/2/files/move_v2", "POST", {
      allow_ownership_transfer: false,
      allow_shared_folder: false,
      autorename: false,
      from_path: fromPath,
      to_path: toPath,
    })
  }

  /** Go driver.go Copy(): copy_v2 */
  async copy(fromPath: string, toPath: string): Promise<void> {
    await this.request("/2/files/copy_v2", "POST", {
      allow_ownership_transfer: false,
      allow_shared_folder: false,
      autorename: false,
      from_path: fromPath,
      to_path: toPath,
    })
  }

  /** Go driver.go Remove(): delete_v2 (path may be a file id) */
  async remove(path: string): Promise<void> {
    await this.request("/2/files/delete_v2", "POST", { path })
  }

  // ==== upload session pipeline (content.dropboxapi.com) ====

  /** Headers shared by the content endpoints (start/append/finish) */
  private contentHeaders(dropboxApiArg: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      Authorization: "Bearer " + this.accessToken,
      "Dropbox-API-Arg": dropboxApiArg,
    }
    if (this.rootNamespaceId) {
      headers["Dropbox-API-Path-Root"] = asciiJson({
        ".tag": "root",
        root: this.rootNamespaceId,
      })
    }
    return headers
  }

  private parseContentError(status: number, text: string): Error {
    let tag = ""
    let summary = ""
    try {
      const parsed = JSON.parse(text) as ErrorResp
      tag = parsed.error?.[".tag"] || ""
      summary = parsed.error_summary || ""
    } catch {
      /* non-JSON body */
    }
    return new Error(
      `[Dropbox] ${tag ? tag + ":" : ""}${summary || `upload failed: HTTP ${status} ${text.slice(0, 200)}`}`,
    )
  }

  /** Go util.go startUploadSession() */
  private async startUploadSession(): Promise<string> {
    const res = await fetch(`${CONTENT_BASE}/2/files/upload_session/start`, {
      method: "POST",
      headers: this.contentHeaders('{"close":false}'),
    })
    const text = await res.text()
    if (!res.ok) throw this.parseContentError(res.status, text)
    let sessionId = ""
    try {
      sessionId = (JSON.parse(text) as { session_id?: string }).session_id || ""
    } catch {
      /* non-JSON body */
    }
    if (!sessionId) {
      throw new Error(
        `[Dropbox] failed to start upload session: ${text.slice(0, 200)}`,
      )
    }
    return sessionId
  }

  /**
   * Go Put() step 2 — append_v2 with a 20MB chunk. The Go code ignores the
   * HTTP status here (it only closes the body); the TS port checks it so
   * failures surface instead of silently corrupting the session.
   */
  private async appendUploadSession(
    sessionId: string,
    offset: number,
    chunk: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const arg = asciiJson({
      close: false,
      cursor: { offset, session_id: sessionId },
    })
    const res = await fetch(
      `${CONTENT_BASE}/2/files/upload_session/append_v2`,
      {
        method: "POST",
        headers: this.contentHeaders(arg),
        body: chunk,
      },
    )
    const text = await res.text().catch(() => "")
    if (!res.ok) throw this.parseContentError(res.status, text)
  }

  /**
   * Go util.go finishUploadSession() — commit with autorename:true and
   * mode:"add" (Go Config().NoOverwriteUpload: uploads never overwrite).
   * (Go ignores the HTTP status here too; the TS port checks it.)
   */
  private async finishUploadSession(
    toPath: string,
    offset: number,
    sessionId: string,
  ): Promise<void> {
    const args: UploadFinishArgs = {
      commit: {
        autorename: true,
        mode: "add",
        mute: false,
        path: toPath,
        strict_conflict: false,
      },
      cursor: { offset, session_id: sessionId },
    }
    const res = await fetch(`${CONTENT_BASE}/2/files/upload_session/finish`, {
      method: "POST",
      headers: this.contentHeaders(asciiJson(args)),
    })
    const text = await res.text().catch(() => "")
    if (!res.ok) throw this.parseContentError(res.status, text)
  }

  /**
   * Go driver.go Put(): upload-session pipeline
   * (start → 20MB append_v2 chunks → finish). Portable because NextList
   * hands the driver the whole buffer instead of a stream.
   */
  async uploadFile(
    toPath: string,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    // The content endpoints bypass request(), so make sure we hold a token
    // before starting (Go relies on init having refreshed it).
    if (!this.accessToken) {
      await this.refreshToken()
    }
    const sessionId = await this.startUploadSession()
    const total = content.byteLength
    const count = Math.max(1, Math.ceil(total / UPLOAD_PART_SIZE))
    let offset = 0
    for (let i = 0; i < count; i++) {
      const start = i * UPLOAD_PART_SIZE
      const byteSize = Math.min(total - start, UPLOAD_PART_SIZE)
      const chunk = content.subarray(start, start + byteSize)
      await this.appendUploadSession(sessionId, offset, chunk)
      offset += byteSize
    }
    await this.finishUploadSession(toPath, offset, sessionId)
  }
}
