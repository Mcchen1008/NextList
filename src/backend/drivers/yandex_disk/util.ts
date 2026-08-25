// Yandex Disk HTTP client
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/yandex_disk
import {
  YandexDiskAddition,
  YandexFile,
  YandexFilesResp,
  YandexDownResp,
  YandexUploadResp,
  YandexErrResp,
  YandexTokenErrResp,
} from "./types"

const API_BASE = "https://cloud-api.yandex.net/v1/disk/resources"

export class YandexDiskClient {
  private addition: YandexDiskAddition
  private accessToken = ""
  private refreshToken = ""
  private onTokenUpdate?: (tokens: {
    access_token: string
    refresh_token: string
  }) => void

  constructor(
    addition: YandexDiskAddition,
    onTokenUpdate?: (tokens: {
      access_token: string
      refresh_token: string
    }) => void,
  ) {
    this.addition = addition
    this.refreshToken = addition.refresh_token
    this.onTokenUpdate = onTokenUpdate
  }

  public getRootPath(): string {
    return this.addition.root_folder_path || "/"
  }

  public async init(): Promise<void> {
    await this.refreshAccessToken()
  }

  public async refreshAccessToken(): Promise<void> {
    // Use online API if enabled (no client_id/secret needed)
    if (
      this.addition.use_online_api !== false &&
      this.addition.api_url_address
    ) {
      const u =
        this.addition.api_url_address +
        `?refresh_ui=${encodeURIComponent(this.refreshToken)}&server_use=true&driver_txt=yandexui_go`
      const res = await fetch(u, { method: "GET" })
      const data = (await res.json()) as {
        refresh_token?: string
        access_token?: string
        text?: string
      }
      if (!data.refresh_token || !data.access_token) {
        throw new Error(
          data.text ||
            "empty token returned from online API, wrong refresh token?",
        )
      }
      this.accessToken = data.access_token
      this.refreshToken = data.refresh_token
      this.onTokenUpdate?.({
        access_token: this.accessToken,
        refresh_token: this.refreshToken,
      })
      return
    }
    if (!this.addition.client_id || !this.addition.client_secret) {
      throw new Error(
        "YandexDisk: empty client_id or client_secret (set use_online_api=true or provide credentials)",
      )
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.addition.client_id,
      client_secret: this.addition.client_secret,
    })
    const res = await fetch("https://oauth.yandex.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    const data = (await res.json()) as {
      access_token?: string
      refresh_token?: string
    } & YandexTokenErrResp
    if (data.error) {
      throw new Error(`${data.error}: ${data.error_description}`)
    }
    this.accessToken = data.access_token || ""
    this.refreshToken = data.refresh_token || this.refreshToken
    this.onTokenUpdate?.({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
    })
  }

  public async request<T = any>(
    pathname: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    callback?: (url: URL, init: RequestInit) => void,
    retry = true,
  ): Promise<T> {
    const u = new URL(API_BASE + pathname)
    const init: RequestInit = {
      method,
      headers: {
        Authorization: "OAuth " + this.accessToken,
        Accept: "application/json",
      },
    }
    if (callback) callback(u, init)
    const res = await fetch(u.toString(), init)
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON */
      }
    }
    const err = data as YandexErrResp
    if (err.error) {
      if (err.error === "UnauthorizedError" && retry) {
        await this.refreshAccessToken()
        return this.request<T>(pathname, method, callback, false)
      }
      throw new Error(err.description || err.message || err.error)
    }
    return data as T
  }

  public async getFiles(
    path: string,
    orderBy?: string,
    orderDirection?: string,
  ): Promise<YandexFile[]> {
    const limit = 100
    let page = 1
    const result: YandexFile[] = []
    for (;;) {
      const offset = (page - 1) * limit
      const params: Record<string, string> = {
        path,
        limit: String(limit),
        offset: String(offset),
      }
      if (orderBy) {
        params["sort"] = orderDirection === "desc" ? "-" + orderBy : orderBy
      }
      const resp = await this.request<YandexFilesResp>("", "GET", (url) => {
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      })
      result.push(...resp._embedded.items)
      if (resp._embedded.total <= offset + limit) break
      page++
      if (page > 50) break // safety cap
    }
    return result
  }

  public async getDownloadUrl(path: string): Promise<string> {
    const resp = await this.request<YandexDownResp>(
      "/download",
      "GET",
      (url) => {
        url.searchParams.set("path", path)
      },
    )
    return resp.href
  }

  public async getUploadUrl(path: string): Promise<string> {
    const resp = await this.request<YandexUploadResp>(
      "/upload",
      "GET",
      (url) => {
        url.searchParams.set("path", path)
        url.searchParams.set("overwrite", "true")
      },
    )
    return resp.href
  }

  public async makeDir(path: string): Promise<void> {
    await this.request("", "PUT", (url) => {
      url.searchParams.set("path", path)
    })
  }

  public async move(from: string, to: string): Promise<void> {
    await this.request("/move", "POST", (url) => {
      url.searchParams.set("from", from)
      url.searchParams.set("path", to)
      url.searchParams.set("overwrite", "true")
    })
  }

  public async copy(from: string, to: string): Promise<void> {
    await this.request("/copy", "POST", (url) => {
      url.searchParams.set("from", from)
      url.searchParams.set("path", to)
      url.searchParams.set("overwrite", "true")
    })
  }

  public async remove(path: string): Promise<void> {
    await this.request("", "DELETE", (url) => {
      url.searchParams.set("path", path)
    })
  }

  public async upload(href: string, content: Buffer): Promise<void> {
    const res = await fetch(href, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
      },
      body: new Uint8Array(content),
    })
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(
        `YandexDisk upload failed: ${res.status} ${await res.text()}`,
      )
    }
  }
}
