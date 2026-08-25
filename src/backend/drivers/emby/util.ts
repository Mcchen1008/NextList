// Emby HTTP client & helpers
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/emby
// (driver.go + util.go; the Go side mixes net/http and resty — here pure fetch)
import {
  EmbyAddition,
  EmbyAuthResp,
  EmbyItem,
  EmbyItemDetailResp,
  EmbyListResp,
} from "./types"

// base.UserAgent from OpenList drivers/base/client.go
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

// (?i)\bS\d{1,2}E\d{1,2}\b from util.go
const EPISODE_CODE_RE = /\bS\d{1,2}E\d{1,2}\b/gi
const EPISODE_CODE_RE_ONCE = /\bS\d{1,2}E\d{1,2}\b/i
// strings.Trim(title, "-_:[]() ")
const TRIM_EDGES_RE = /^[-_:.[\]() ]+|[-_:.[\]() ]+$/g

/** Go path.Ext: suffix beginning at the final dot ("" when absent). */
export function pathExt(name: string): string {
  const i = name.lastIndexOf(".")
  if (i === -1) return ""
  return name.slice(i)
}

function trimSuffix(s: string, suffix: string): string {
  if (suffix && s.endsWith(suffix)) return s.slice(0, s.length - suffix.length)
  return s
}

/**
 * Go path.Join: join non-empty elements with "/" and Clean the result.
 * Used to build request paths on top of an optional base path (e.g. "/emby").
 */
export function pathJoin(...parts: string[]): string {
  const joined = parts.filter((p) => p !== "").join("/")
  const absolute = joined.startsWith("/")
  const segs: string[] = []
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      segs.pop()
      continue
    }
    segs.push(seg)
  }
  return (absolute ? "/" : "") + segs.join("/")
}

/**
 * Format an Emby item into its virtual display name (1:1 with Go List()).
 * The item id is embedded in the name ("xxx (ID123)") so that names stay
 * unique across libraries/seasons and can be re-resolved to ids.
 */
export function formatItemName(it: EmbyItem): string {
  const name = (it.Name || "").trim()
  const id = (it.Id || "").trim()
  if (!name || !id) return name
  if (it.IsFolder) return `${name} (ID${id})`

  let ext = pathExt((it.Path || "").trim())
  if (!ext) ext = pathExt(name)
  const base = trimSuffix(name, ext).trim()

  let episodeCode = ""
  const m = base.match(EPISODE_CODE_RE_ONCE)
  if (m) {
    episodeCode = m[0].toUpperCase()
  } else if ((it.ParentIndexNumber || 0) > 0 && (it.IndexNumber || 0) > 0) {
    episodeCode =
      "S" +
      String(it.ParentIndexNumber).padStart(2, "0") +
      "E" +
      String(it.IndexNumber).padStart(2, "0")
  }

  let title = base
  if (episodeCode) {
    title = title.replace(EPISODE_CODE_RE, "").trim()
    title = title.replace(TRIM_EDGES_RE, "")
  }

  let series = (it.SeriesName || "").trim()
  if (!series && episodeCode) {
    const idx = title.indexOf(" - ")
    if (idx > 0) {
      series = title.slice(0, idx).trim()
      title = title.slice(idx + 3).trim()
    }
  }

  let core = title
  if (series) {
    if (!title || series.toLowerCase() === title.toLowerCase()) {
      core = series
    } else {
      core = series + " " + title
    }
  }
  if (!core) core = base

  if (episodeCode) core = `${core} - [${episodeCode}]`
  return ext ? `${core} (ID${id})${ext}` : `${core} (ID${id})`
}

export class EmbyClient {
  readonly addition: EmbyAddition
  private url = ""
  private token = ""
  private userID = ""

  /** Called after a successful username/password login so the caller can
   * persist api_key/user_id back into storage (mirrors op.MustSaveDriverStorage). */
  private onCredentials?: (apiKey: string, userId: string) => void

  constructor(
    addition: EmbyAddition,
    onCredentials?: (apiKey: string, userId: string) => void,
  ) {
    this.addition = addition
    this.onCredentials = onCredentials
  }

  public getUrl(): string {
    return this.url
  }

  public getRootFolderId(): string {
    return (this.addition.root_folder_id || "").trim() || "1"
  }

  /** Go Init(): validate config, default root id, login when no api_key. */
  public async init(): Promise<void> {
    this.url = (this.addition.url || "").trim().replace(/\/+$/, "")
    if (!this.url) {
      throw new Error("[Emby] url is required")
    }

    if (!(this.addition.root_folder_id || "").trim()) {
      this.addition.root_folder_id = "1"
    }

    this.token = (this.addition.api_key || "").trim()
    this.userID = (this.addition.user_id || "").trim()

    if (this.token) {
      if (!this.userID) {
        throw new Error("[Emby] user_id is required when api_key is set")
      }
      return
    }

    if (!(this.addition.username || "").trim()) {
      throw new Error(
        "[Emby] please provide api_key+user_id or username(+password)",
      )
    }

    await this.login()

    // persist credentials (Go: d.ApiKey = d.token; d.UserID = d.userID; MustSaveDriverStorage)
    this.addition.api_key = this.token
    this.addition.user_id = this.userID
    this.onCredentials?.(this.token, this.userID)
  }

  /** POST /Users/AuthenticateByName (username may be used without password). */
  public async login(): Promise<void> {
    const endpoint = `${this.url}/Users/AuthenticateByName`
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Emby-Authorization":
          'MediaBrowser Client="OpenList", Device="OpenList", DeviceId="openlist-emby", Version="1.0.0"',
      },
      body: JSON.stringify({
        Username: this.addition.username || "",
        Pw: this.addition.password || "",
      }),
    })
    if (res.status < 200 || res.status >= 300) {
      const body = (await res.text()).trim()
      throw new Error(
        `[Emby] auth failed: status=${res.status} body=${body.slice(0, 300)}`,
      )
    }
    const data = (await res.json()) as EmbyAuthResp
    const token = (data.AccessToken || "").trim()
    const userId = (data.User?.Id || "").trim()
    if (!token || !userId) {
      throw new Error("[Emby] auth response missing access token or user id")
    }
    this.token = token
    this.userID = userId
  }

  /** GET /Users/{userId}/Items?ParentId=... (util.go getItems). */
  public async getItems(parentId: string): Promise<EmbyItem[]> {
    const u = new URL(
      `${this.url}/Users/${encodeURIComponent(this.userID)}/Items`,
    )
    u.searchParams.set("ParentId", parentId)
    u.searchParams.set("Recursive", "false")
    u.searchParams.set(
      "Fields",
      "Path,Size,DateCreated,SeriesName,IndexNumber,ParentIndexNumber",
    )
    u.searchParams.set("api_key", this.token)

    const res = await fetch(u.toString(), {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    })
    if (res.status < 200 || res.status >= 300) {
      const body = (await res.text()).trim()
      throw new Error(
        `[Emby] list failed: status=${res.status} body=${body.slice(0, 300)}`,
      )
    }
    const data = (await res.json()) as EmbyListResp
    return data.Items || []
  }

  /** GET /Users/{userId}/Items/{itemId}?Fields=MediaSources — returns null on
   * any failure (the Go Link() silently ignores detail errors). */
  public async getItemDetail(
    fileId: string,
  ): Promise<EmbyItemDetailResp | null> {
    try {
      const u = new URL(
        `${this.url}/Users/${encodeURIComponent(this.userID)}/Items/${encodeURIComponent(fileId)}`,
      )
      u.searchParams.set("Fields", "MediaSources")
      u.searchParams.set("api_key", this.token)
      const res = await fetch(u.toString(), {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      })
      if (res.status < 200 || res.status >= 300) return null
      return (await res.json()) as EmbyItemDetailResp
    } catch {
      return null
    }
  }

  /**
   * Build the direct link for a file item (Go Link()).
   * - link_method "download": {url}/Items/{id}/Download?api_key=...
   * - otherwise: {url}/Videos/{id}/stream[.container]?Static=true&api_key=...
   *   with MediaSourceId taken from the item's MediaSources when available.
   */
  public async getLinkUrl(fileId: string): Promise<{
    url: string
    headers: Record<string, string>
  }> {
    const fileID = (fileId || "").trim()
    if (!fileID) throw new Error("[Emby] invalid file id")

    const u = new URL(this.url)
    const linkMethod = (this.addition.link_method || "").trim().toLowerCase()
    const useDownload = linkMethod === "download"

    let mediaSourceID = ""
    let mediaContainer = ""
    if (!useDownload) {
      const detail = await this.getItemDetail(fileID)
      const sources = detail?.MediaSources || []
      if (sources.length > 0) {
        const pick =
          sources.find(
            (s) => (s.Id || "").trim() !== "" && s.SupportsDirectStream,
          ) || sources.find((s) => (s.Id || "").trim() !== "")
        if (pick) {
          mediaSourceID = (pick.Id || "").trim()
          mediaContainer = (pick.Container || "").trim()
        }
      }
    }

    let pathname: string
    if (useDownload) {
      pathname = pathJoin(u.pathname, "/Items", fileID, "Download")
    } else if (mediaContainer) {
      pathname = pathJoin(
        u.pathname,
        "/Videos",
        fileID,
        "stream." + mediaContainer,
      )
    } else {
      pathname = pathJoin(u.pathname, "/Videos", fileID, "stream")
    }
    u.pathname = pathname
    u.searchParams.set("api_key", this.token)
    if (mediaSourceID) {
      u.searchParams.set("MediaSourceId", mediaSourceID)
    }
    if (!useDownload) {
      u.searchParams.set("Static", "true")
    }
    return { url: u.toString(), headers: { "User-Agent": USER_AGENT } }
  }
}
