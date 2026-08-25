// AliyundriveShare HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/aliyundrive_share
//
// Auth flow (Go driver.go Init / util.go):
//   1. refreshToken()  — POST https://auth.alipan.com/v2/account/token
//                        (body {refresh_token, grant_type:"refresh_token"}),
//                        refresh_token rotates with the response (Go persists
//                        it via op.MustSaveDriverStorage → here an optional
//                        onTokenRefresh callback)
//   2. getShareToken() — POST https://api.alipan.com/v2/share_link/get_share_token
//                        (body {share_id[, share_pwd]})
// Listing (Go util.go getFiles):
//   POST https://api.alipan.com/adrive/v3/file/list with the x-share-token
//   header (no Authorization header), marker pagination.
// Download (Go driver.go Link):
//   POST https://api.alipan.com/v2/file/get_share_link_download_url with
//   Authorization + x-share-token, requires the drive_id harvested from the
//   first listed file.
//
// limiter.go (golang.org/x/time/rate, burst 1: list 3.9/s, link 0.9/s,
// other 14.9/s — see OpenList issue #724) is simplified to a per-client
// in-memory minimum-interval limiter below.
import {
  AliyundriveShareAddition,
  ShareFile,
  ShareLinkResp,
  ShareListResp,
  ShareTokenResp,
  TokenResp,
} from "./types"

const AUTH_API = "https://auth.alipan.com"
const API_URL = "https://api.alipan.com"

// Go util.go: CanaryHeaderKey / CanaryHeaderValue for lifting rate limit restrictions
const CANARY_HEADER_KEY = "X-Canary"
const CANARY_HEADER_VALUE = "client=web,app=share,version=v2.3.1"

// OpenList drivers/base/client.go UserAgent
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

/** limiter.go limiterType */
export type LimiterType = "list" | "link" | "other"

/** limiter.go rate constants */
const RATE_LIMITS: Record<LimiterType, number> = {
  list: 3.9, // 4/s in the doc, Go uses 3.9 to be safe
  link: 0.9, // 1/s in the doc
  other: 14.9, // 15/s in the doc
}

/**
 * Simplified port of Go's rate.NewLimiter(rate, 1) (burst 1): every call
 * reserves the next slot `1000/rate` ms in the future and sleeps until then.
 * Single-instance / best-effort — a Worker isolate keeps one of these.
 */
class RateLimiter {
  private nextAllowedAt = 0
  private readonly intervalMs: number

  constructor(ratePerSecond: number) {
    this.intervalMs = 1000 / ratePerSecond
  }

  async wait(): Promise<void> {
    const now = Date.now()
    const start = Math.max(now, this.nextAllowedAt)
    this.nextAllowedAt = start + this.intervalMs
    const delay = start - now
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

export class AliyundriveShareClient {
  private addition: AliyundriveShareAddition
  private limiters: Record<LimiterType, RateLimiter>
  private refreshTokenVal: string
  private accessToken = ""
  private accessTokenExpiresAt = 0
  private shareToken = ""
  /** Go: d.DriveId — harvested from the first listed share file */
  public driveId = ""
  /**
   * Mirrors Go op.MustSaveDriverStorage(d) after refreshToken: lets the host
   * persist the rotated refresh_token back into the storage config.
   */
  private onTokenRefresh?: (accessToken: string, refreshToken: string) => void

  constructor(
    addition: AliyundriveShareAddition,
    onTokenRefresh?: (accessToken: string, refreshToken: string) => void,
  ) {
    this.addition = addition
    this.refreshTokenVal = addition.refresh_token || ""
    this.onTokenRefresh = onTokenRefresh
    this.limiters = {
      list: new RateLimiter(RATE_LIMITS.list),
      link: new RateLimiter(RATE_LIMITS.link),
      other: new RateLimiter(RATE_LIMITS.other),
    }
  }

  /** Go driver.RootID — share root is "root" (Config().DefaultRoot) */
  public getRootFolderId(): string {
    return this.addition.root_folder_id?.trim() || "root"
  }

  /** Go Init(): refreshToken then getShareToken */
  public async init(): Promise<void> {
    await this.refreshToken()
    await this.getShareToken()
  }

  /**
   * Go refreshToken(): POST auth.alipan.com/v2/account/token.
   * Go re-refreshes on a 2h cron; a Worker has no cron, so we additionally
   * refresh lazily when the (optional) expires_in has passed.
   */
  public async refreshToken(): Promise<void> {
    await this.limiters.other.wait()
    const res = await fetch(`${AUTH_API}/v2/account/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        refresh_token: this.refreshTokenVal,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(30_000),
    })

    const data = await this.parseBody<TokenResp>(res)
    if (data.code) {
      // Go: fmt.Errorf("failed to refresh token: %s", e.Message)
      throw new Error(
        `[AliyundriveShare] failed to refresh token: ${data.message || data.code}`,
      )
    }
    if (!data.access_token) {
      throw new Error(
        "[AliyundriveShare] failed to refresh token: empty access_token",
      )
    }
    this.accessToken = data.access_token
    if (data.refresh_token) {
      this.refreshTokenVal = data.refresh_token
    }
    this.accessTokenExpiresAt =
      Date.now() + (data.expires_in || 7200) * 1000 - 60_000
    this.onTokenRefresh?.(this.accessToken, this.refreshTokenVal)
  }

  /** Go getShareToken(): POST /v2/share_link/get_share_token */
  public async getShareToken(): Promise<void> {
    await this.limiters.other.wait()
    const data: Record<string, string> = {
      share_id: this.addition.share_id,
    }
    if (this.addition.share_pwd) {
      data.share_pwd = this.addition.share_pwd
    }
    const res = await fetch(`${API_URL}/v2/share_link/get_share_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30_000),
    })
    const resp = await this.parseBody<ShareTokenResp>(res)
    if (resp.code) {
      // Go: errors.New(e.Message)
      throw new Error(`[AliyundriveShare] ${resp.message || resp.code}`)
    }
    if (!resp.share_token) {
      throw new Error("[AliyundriveShare] empty share_token")
    }
    this.shareToken = resp.share_token
  }

  /**
   * Go request(): authorized request with Authorization + x-share-token +
   * X-Canary headers. On AccessTokenInvalid / ShareLinkTokenInvalid the token
   * is refreshed and the request retried once.
   */
  private async request<T>(
    url: string,
    method: string,
    body: unknown,
    limitType: LimiterType,
    retry = true,
  ): Promise<T> {
    await this.ensureAccessToken()
    await this.limiters[limitType].wait()
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        // Go: "Bearer\t"+d.AccessToken (tab, sic) — kept byte-for-byte
        Authorization: "Bearer\t" + this.accessToken,
        [CANARY_HEADER_KEY]: CANARY_HEADER_VALUE,
        "x-share-token": this.shareToken,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await this.parseBody<T>(res)
    const code = data.code || ""
    if (code) {
      if (
        retry &&
        (code === "AccessTokenInvalid" || code === "ShareLinkTokenInvalid")
      ) {
        if (code === "AccessTokenInvalid") {
          await this.refreshToken()
        } else {
          await this.getShareToken()
        }
        return this.request<T>(url, method, body, limitType, false)
      }
      // Go: errors.New(e.Code + ": " + e.Message)
      throw new Error(`[AliyundriveShare] ${code}: ${data.message || ""}`)
    }
    return data
  }

  /**
   * Go getFiles(): POST /adrive/v3/file/list with x-share-token only (no
   * Authorization header), marker pagination ("first" marker trick).
   * AccessTokenInvalid / ShareLinkTokenInvalid → getShareToken + one retry
   * (Go retries recursively; bounded to one retry here).
   */
  public async getFiles(fileId: string): Promise<ShareFile[]> {
    return this.getFilesInner(fileId, true)
  }

  private async getFilesInner(
    fileId: string,
    allowRetry: boolean,
  ): Promise<ShareFile[]> {
    const files: ShareFile[] = []
    const data: Record<string, unknown> = {
      image_thumbnail_process: "image/resize,w_160/format,jpeg",
      image_url_process: "image/resize,w_1920/format,jpeg",
      limit: 200,
      order_by: this.addition.order_by || "",
      order_direction: this.addition.order_direction || "",
      parent_file_id: fileId,
      share_id: this.addition.share_id,
      video_thumbnail_process: "video/snapshot,t_1000,f_jpg,ar_auto,w_300",
      marker: "first",
    }

    while ((data.marker as string) !== "") {
      if (data.marker === "first") {
        data.marker = ""
      }
      await this.limiters.list.wait()
      const res = await fetch(`${API_URL}/adrive/v3/file/list`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          [CANARY_HEADER_KEY]: CANARY_HEADER_VALUE,
          "x-share-token": this.shareToken,
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(30_000),
      })
      const resp = await this.parseBody<ShareListResp>(res)
      if (resp.code) {
        if (
          allowRetry &&
          (resp.code === "AccessTokenInvalid" ||
            resp.code === "ShareLinkTokenInvalid")
        ) {
          await this.getShareToken()
          return this.getFilesInner(fileId, false)
        }
        // Go: errors.New(e.Message)
        throw new Error(`[AliyundriveShare] ${resp.message || resp.code}`)
      }
      data.marker = resp.next_marker || ""
      files.push(...(resp.items || []))
    }

    // Go: if len(files) > 0 && d.DriveId == "" { d.DriveId = files[0].DriveId }
    if (files.length > 0 && !this.driveId && files[0].drive_id) {
      this.driveId = files[0].drive_id
    }
    return files
  }

  /**
   * Go Link(): POST /v2/file/get_share_link_download_url (10 min lifetime).
   * The download must be requested with Referer https://www.alipan.com/.
   */
  public async getDownloadUrl(
    fileId: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const resp = await this.request<ShareLinkResp>(
      `${API_URL}/v2/file/get_share_link_download_url`,
      "POST",
      {
        drive_id: this.driveId,
        file_id: fileId,
        // Only ten minutes lifetime
        expire_sec: 600,
        share_id: this.addition.share_id,
      },
      "link",
    )
    return {
      url: resp.download_url || resp.url || "",
      headers: { Referer: "https://www.alipan.com/" },
    }
  }

  /** Go Other() "doc_preview": POST /v2/file/get_office_preview_url */
  public async docPreview(fileId: string): Promise<any> {
    return this.request<any>(
      `${API_URL}/v2/file/get_office_preview_url`,
      "POST",
      { share_id: this.addition.share_id, file_id: fileId },
      "other",
    )
  }

  /** Go Other() "video_preview": POST /v2/file/get_video_preview_play_info */
  public async videoPreview(fileId: string): Promise<any> {
    return this.request<any>(
      `${API_URL}/v2/file/get_video_preview_play_info`,
      "POST",
      {
        share_id: this.addition.share_id,
        file_id: fileId,
        category: "live_transcoding",
      },
      "other",
    )
  }

  /** Lazy token refresh standing in for Go's 2h refresh cron */
  private async ensureAccessToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.accessTokenExpiresAt) {
      await this.refreshToken()
    }
  }

  /**
   * resty parses the body into both Result and Error (Go checks e.Code even
   * on HTTP 200 responses), so parse JSON regardless of status and let
   * callers inspect the optional `code` / `message` fields.
   */
  private async parseBody<T>(
    res: Response,
  ): Promise<T & { code?: string; message?: string }> {
    const text = await res.text().catch(() => "")
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(
        `[AliyundriveShare] request failed, status: ${res.status}, body: ${text.slice(0, 200)}`,
      )
    }
    if (!res.ok && !json.code) {
      throw new Error(
        `[AliyundriveShare] request failed, status: ${res.status} ${res.statusText}`,
      )
    }
    return json as T & { code?: string; message?: string }
  }
}
