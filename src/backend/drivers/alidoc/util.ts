// AliDoc HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/alidoc/util.go
// All requests go to https://alidocs.dingtalk.com with the user's web cookie.
import {
  AliDocAddition,
  AliDocDentry,
  AliDocDownloadResp,
  AliDocListResp,
} from "./types"

// OpenList drivers/base client.go UserAgent (set by base.NewRestyClient)
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

/** Go util.go apiBase */
export const API_BASE = "https://alidocs.dingtalk.com"

const API_TIMEOUT = 30_000 // Go base.DefaultTimeout

export class AliDocClient {
  private cookie: string
  private rootFolderId: string

  constructor(addition: AliDocAddition) {
    // Go Init(): strings.TrimSpace on Cookie / RootFolderID
    this.cookie = (addition.cookie || "").trim()
    this.rootFolderId = (addition.root_folder_id || "").trim()
  }

  getCookie(): string {
    return this.cookie
  }

  getRootFolderId(): string {
    return this.rootFolderId
  }

  /**
   * Go request()/post()/checkResp(): Cookie + Accept + Referer + Origin
   * headers (UA from base.NewRestyClient); HTTP errors surface the body's
   * message/msg when present, otherwise isSuccess/status are enforced.
   */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    opts?: {
      query?: Record<string, string>
      /** JSON body (resty SetBody with a map) */
      body?: unknown
    },
  ): Promise<T> {
    const url = new URL(API_BASE + path)
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, v)
      }
    }

    const headers: Record<string, string> = {
      Cookie: this.cookie,
      Accept: "application/json, text/plain, */*",
      Referer: API_BASE + "/",
      Origin: API_BASE,
      "User-Agent": USER_AGENT,
    }
    let body: string | undefined
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(opts.body)
    }

    let res: Response
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(API_TIMEOUT),
      })
    } catch (e) {
      throw new Error(
        `[AliDoc] request ${method} ${path} failed: ${(e as Error).message}`,
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

    // Go checkResp(): message wins over msg, then http code, then generic
    const msg = parsed?.message || parsed?.msg || ""
    if (!res.ok) {
      throw new Error(`[AliDoc] ${msg || `http error: ${res.status}`}`)
    }
    if (!parsed.isSuccess || parsed.status !== 200) {
      throw new Error(`[AliDoc] ${msg || "request failed"}`)
    }
    return parsed as T
  }

  /** Go checkCookie(): GET /portal/api/v1/mine/info */
  async checkCookie(): Promise<void> {
    await this.request("GET", "/portal/api/v1/mine/info")
  }

  /** Go list(): GET /box/api/v2/dentry/list */
  async list(dentryUuid: string): Promise<AliDocDentry[]> {
    const resp = await this.request<AliDocListResp>(
      "GET",
      "/box/api/v2/dentry/list",
      {
        query: {
          dentryUuid,
          withParentAncestors: "true",
          orderType: "SORT_KEY",
          sortType: "desc",
          listDentrySource: "2",
          pageSize: "1000",
        },
      },
    )
    return resp?.data?.children || []
  }

  /** Go download(): first pre-signed OSS url of the file */
  async download(dentryUuid: string): Promise<string> {
    const resp = await this.request<AliDocDownloadResp>(
      "GET",
      "/box/api/v2/file/download",
      {
        query: {
          dentryUuid,
          version: "1",
          supportDownloadTypes: "URL_PRE_SIGNATURE,HTTP_TO_CENTER",
          downloadType: "URL_PRE_SIGNATURE",
        },
      },
    )
    const urls = resp?.data?.ossUrlPreSignatureInfo?.preSignUrls || []
    if (urls.length === 0) {
      throw new Error("[AliDoc] empty download url")
    }
    return urls[0]
  }

  /** Go MakeDir(): POST /box/api/v2/dentry/createfolder */
  async makeDir(parentDentryUuid: string, name: string): Promise<void> {
    await this.request("POST", "/box/api/v2/dentry/createfolder", {
      body: {
        dentryType: "folder",
        name,
        parentDentryUuid,
        conflictHandleStrategy: "auto_rename",
      },
    })
  }

  /** Go Move(): POST /box/api/v2/dentry/move */
  async move(
    sourceDentryUuid: string,
    targetParentDentryUuid: string,
  ): Promise<void> {
    await this.request("POST", "/box/api/v2/dentry/move", {
      body: {
        targetParentDentryUuid,
        sourceDentryUuid,
        operateFrom: 1,
      },
    })
  }

  /** Go Rename(): POST /box/api/v2/dentry/rename */
  async rename(dentryUuid: string, name: string): Promise<void> {
    await this.request("POST", "/box/api/v2/dentry/rename", {
      body: { dentryUuid, name },
    })
  }

  /** Go Copy(): POST /box/api/v2/dentry/copy */
  async copy(
    sourceDentryUuid: string,
    targetParentDentryUuid: string,
  ): Promise<void> {
    await this.request("POST", "/box/api/v2/dentry/copy", {
      body: {
        sourceDentryUuid,
        targetParentDentryUuid,
        operateFrom: 1,
        onlyCopyMeta: false,
      },
    })
  }

  /** Go Remove(): POST /box/api/v1/dentry/recycle */
  async remove(dentryUuid: string): Promise<void> {
    await this.request("POST", "/box/api/v1/dentry/recycle", {
      body: { dentryUuid },
    })
  }
}
