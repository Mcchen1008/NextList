// FebBox HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/febbox
//
// Auth (Go oauth2.go customTokenSource): POST https://api.febbox.com/oauth/token
// with client_credentials grant (client_id + client_secret) or refresh_token
// grant when a refresh token is available. The API returns
// { code: 1, data: { access_token, expires_in, token_type, refresh_token } }.
// Tokens are cached until ~10s before expiry (oauth2.ReuseTokenSource).
//
// All API calls (Go util.go): multipart/form-data POST to
// https://api.febbox.com/oauth with a `module` selector and params.
import {
  FebBoxAddition,
  FebBoxFile,
  FebBoxFileListResp,
  FebBoxDownloadResp,
  FebBoxErrResp,
  FebBoxTokenResp,
} from "./types"

const API_URL = "https://api.febbox.com/oauth"
const TOKEN_URL = "https://api.febbox.com/oauth/token"

/** go-resty ErrResp.Error() format */
function errRespError(e: FebBoxErrResp): string {
  return (
    `ErrorCode: ${e.code ?? 0} ,Error: ${e.msg || ""} ,` +
    `ServerRunTime: ${e.server_runtime ?? 0} ,ServerName: ${e.server_name || ""}`
  )
}

export class FebBoxClient {
  private addition: FebBoxAddition
  /** Go: d.Addition.RefreshToken (rotated by the token endpoint) */
  private refreshToken: string
  private accessToken = ""
  private tokenType = ""
  /** epoch ms when the cached token expires */
  private tokenExpiry = 0
  /** Optional persistence hook — mirrors Go op.MustSaveDriverStorage(d) */
  private onTokenRefresh?: (tokens: {
    access_token: string
    refresh_token: string
  }) => void

  constructor(
    addition: FebBoxAddition,
    onTokenRefresh?: (tokens: {
      access_token: string
      refresh_token: string
    }) => void,
  ) {
    this.addition = addition
    this.refreshToken = addition.refresh_token || ""
    this.onTokenRefresh = onTokenRefresh
  }

  public getRootFolderId(): string {
    // Go Config().DefaultRoot = "0"
    return this.addition.root_folder_id || "0"
  }

  public getUserIp(): string {
    // Go Link(): ip = addition.user_ip if set, else the requester's IP
    // (NextList drivers have no access to the client IP → empty)
    return this.addition.user_ip || ""
  }

  /**
   * Go customTokenSource.Token(): exchange client credentials (or a refresh
   * token) for an access token.
   */
  private async fetchToken(): Promise<void> {
    const params = new URLSearchParams()
    if (this.refreshToken) {
      params.set("grant_type", "refresh_token")
      params.set("refresh_token", this.refreshToken)
    } else {
      params.set("grant_type", "client_credentials")
    }
    params.set("client_id", this.addition.client_id || "")
    params.set("client_secret", this.addition.client_secret || "")

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status !== 200) {
      throw new Error(
        `[FebBox] oauth2: cannot fetch token (HTTP ${res.status})`,
      )
    }
    let data: FebBoxTokenResp
    try {
      data = (await res.json()) as FebBoxTokenResp
    } catch {
      throw new Error("[FebBox] oauth2: invalid token response")
    }
    if (data.code !== 1) {
      throw new Error(
        `[FebBox] oauth2: server response error: ${data.msg || ""}`,
      )
    }
    if (!data.data || !data.data.access_token) {
      throw new Error("[FebBox] oauth2: empty access_token in response")
    }
    this.accessToken = data.data.access_token
    this.tokenType = data.data.token_type || "Bearer"
    this.tokenExpiry = Date.now() + (data.data.expires_in || 0) * 1000
    // Go: d.Addition.RefreshToken = token.RefreshToken; op.MustSaveDriverStorage(d)
    // (only overwrite when non-empty so a client_credentials-only setup never
    // wipes a previously issued refresh token)
    if (data.data.refresh_token) {
      this.refreshToken = data.data.refresh_token
      this.addition.refresh_token = this.refreshToken
      this.onTokenRefresh?.({
        access_token: this.accessToken,
        refresh_token: this.refreshToken,
      })
    }
  }

  /**
   * Go oauth2.ReuseTokenSource semantics: return the cached token while it is
   * still valid (default 10s expiry delta). `force` bypasses the cache — used
   * by Init (ReuseTokenSource starts with a nil token) and by the -10001
   * access-token-expired retry.
   */
  private async getToken(force = false): Promise<void> {
    if (!force && this.accessToken && Date.now() < this.tokenExpiry - 10_000) {
      return
    }
    await this.fetchToken()
  }

  /**
   * Go request(): multipart POST to https://api.febbox.com/oauth with a
   * bearer token. Error codes:
   *   0 / 1      → success
   *   -10001     → access_token expired (server_name set) → refresh + retry once
   *   otherwise  → error
   */
  private async request<T>(
    params: Record<string, string>,
    retry = true,
  ): Promise<T> {
    await this.getToken()
    const form = new FormData()
    for (const [k, v] of Object.entries(params)) {
      form.append(k, v)
    }
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `${this.tokenType} ${this.accessToken}`,
        Accept: "application/json",
      },
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let data: any
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(
        `[FebBox] invalid response (HTTP ${res.status}): ${text.slice(0, 200)}`,
      )
    }
    const e = data as FebBoxErrResp
    const code = Number(e.code ?? 0)
    if (code === 0 || code === 1) {
      return data as T
    }
    if (code === -10001 && e.server_name && retry) {
      // access_token expired — force a fresh token and retry once.
      // (Go relies on ReuseTokenSource noticing the expiry; forcing here also
      // recovers from tokens rejected before their nominal expiry.)
      await this.getToken(true)
      return this.request<T>(params, false)
    }
    throw new Error(`[FebBox] ${errRespError(e)}`)
  }

  public async init(): Promise<void> {
    // Go Init(): fresh ReuseTokenSource(nil, …) → Token() always fetches
    await this.getToken(true)
  }

  /** Go getFiles(): one page of the file_list module */
  private async getFiles(
    dirId: string,
    page: number,
    pageLimit: number,
  ): Promise<FebBoxFile[]> {
    const resp = await this.request<FebBoxFileListResp>({
      module: "file_list",
      parent_id: dirId,
      page: String(page),
      pagelimit: String(pageLimit),
      order: this.addition.sort_rule || "name_asc",
    })
    return (resp.data && resp.data.file_list) || []
  }

  /** Go listWithLimit(): paginate until a short page arrives */
  public async getFilesList(dirId: string): Promise<FebBoxFile[]> {
    // Go getFilesList(): PageSize <= 0 → 100
    const pageLimit =
      this.addition.page_size && this.addition.page_size > 0
        ? Math.floor(this.addition.page_size)
        : 100
    const files: FebBoxFile[] = []
    let page = 1
    for (;;) {
      const result = await this.getFiles(dirId, page, pageLimit)
      files.push(...result)
      if (result.length < pageLimit) break
      page++
      if (page > 1000) break // safety cap (Go loops unbounded)
    }
    return files
  }

  public async getDownloadLink(id: string, ip: string): Promise<string> {
    const resp = await this.request<FebBoxDownloadResp>({
      module: "file_get_download_url",
      "fids[]": id,
      ip,
    })
    if (!resp.data || resp.data.length === 0) {
      throw new Error(
        `[FebBox] can not get download link, code:${resp.code}, msg:${resp.msg || ""}`,
      )
    }
    return resp.data[0].download_url
  }

  public async makeDir(parentId: string, name: string): Promise<void> {
    await this.request({
      module: "create_dir",
      parent_id: parentId,
      name,
    })
  }

  public async move(id: string, toId: string): Promise<void> {
    await this.request({
      module: "file_move",
      "fids[]": id,
      to: toId,
    })
  }

  public async rename(id: string, name: string): Promise<void> {
    await this.request({
      module: "file_rename",
      fid: id,
      name,
    })
  }

  public async copy(id: string, toId: string): Promise<void> {
    await this.request({
      module: "file_copy",
      "fids[]": id,
      to: toId,
    })
  }

  public async remove(id: string): Promise<void> {
    await this.request({
      module: "file_delete",
      "fids[]": id,
    })
  }
}
