// Teldrive HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/teldrive
//
// Porting notes (Go driver.go / util.go / copy.go):
// - Auth is a raw session cookie that must start with "access_token="
//   (JWT obtained from the teldrive web login) — sent verbatim as the
//   Cookie header on every request.
// - Listing is path based: GET /api/files?path=&limit=500&page=N with
//   totalPages-driven pagination (Go fetches remaining pages concurrently
//   with an errgroup limit of 8 — mirrored here).
// - Download links: {url}/api/files/{id}/{name} (needs the Cookie) or, when
//   use_share_link is on, an auto-created share link
//   {url}/api/shares/{shareId}/files/{id}/{name} (cookie-free).
// - The upload pipeline (upload.go: /api/uploads chunked part uploads with
//   random md5 chunk names, retry/backoff and a final create-file-from-parts
//   commit) is NOT ported — see driver.ts put().
import {
  TeldriveAddition,
  TeldriveObject,
  TeldriveListResp,
  TeldriveErrResp,
  TeldriveShareObj,
} from "./types"

const REQUEST_TIMEOUT_MS = 60_000
/** Go driver.go List(): limit=500 per page */
const PAGE_SIZE = 500
/** Go driver.go List(): errgroup.SetLimit(8) for page fetching */
const PAGE_CONCURRENCY = 8

/** Go stdpath.Clean equivalent */
export function cleanPath(path: string): string {
  const isAbs = path.startsWith("/")
  const out: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop()
      } else if (!isAbs) {
        out.push("..")
      }
      continue
    }
    out.push(part)
  }
  const cleaned = out.join("/")
  if (isAbs) return "/" + cleaned
  return cleaned === "" ? "." : cleaned
}

/** Go stdpath.Join equivalent */
export function joinPath(...elems: string[]): string {
  const joined = elems.filter((e) => e !== "").join("/")
  if (joined === "") return ""
  return cleanPath(joined)
}

export function dirname(p: string): string {
  const cleaned = cleanPath(p)
  if (cleaned === "/") return "/"
  const parts = cleaned.split("/").filter(Boolean)
  parts.pop()
  return parts.length ? "/" + parts.join("/") : "/"
}

export function basename(p: string): string {
  const cleaned = cleanPath(p)
  if (cleaned === "/") return ""
  const parts = cleaned.split("/").filter(Boolean)
  return parts[parts.length - 1] || ""
}

function isAlnum(b: number): boolean {
  return (
    (b >= 0x61 && b <= 0x7a) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x30 && b <= 0x39)
  )
}

/** Go url.PathEscape equivalent — resty SetPathParam escapes path params this way */
export function goPathEscape(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ""
  for (const b of bytes) {
    if (isAlnum(b)) {
      out += String.fromCharCode(b)
    } else if (
      b === 0x2d || // -
      b === 0x5f || // _
      b === 0x2e || // .
      b === 0x7e || // ~
      b === 0x24 || // $
      b === 0x26 || // &
      b === 0x2b || // +
      b === 0x3a || // :
      b === 0x3d || // =
      b === 0x40 // @
    ) {
      out += String.fromCharCode(b)
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0")
    }
  }
  return out
}

/**
 * Go util.go getDateTime(): now UTC + 1 hour formatted with the layout
 * "2006-01-02T15:04:05.000Z" — millisecond precision with a literal Z.
 * Date.toISOString() produces exactly that shape.
 */
export function shareExpiresAt(): string {
  return new Date(Date.now() + 3600_000).toISOString()
}

export class TeldriveClient {
  private addition: TeldriveAddition

  constructor(addition: TeldriveAddition) {
    // Go Init(): strings.TrimSuffix(d.Address, "/")
    this.addition = {
      ...addition,
      url: (addition.url || "").replace(/\/+$/, ""),
    }
  }

  /** Go Init(): validate the cookie and apply upload defaults */
  async init(): Promise<void> {
    if (!this.addition.url) {
      throw new Error("[Teldrive] url is required")
    }
    if (
      !this.addition.cookie ||
      !this.addition.cookie.startsWith("access_token=")
    ) {
      throw new Error("[Teldrive] cookie must start with 'access_token='")
    }
    // Go Init() defaults (upload only; op.MustSaveDriverStorage persistence
    // is skipped — the values are only relevant for put(), which throws)
    if (!this.addition.upload_concurrency) {
      this.addition.upload_concurrency = 4
    }
    if (!this.addition.chunk_size) {
      this.addition.chunk_size = 10
    }
  }

  isUseShareLink(): boolean {
    return !!this.addition.use_share_link
  }

  getCookie(): string {
    return this.addition.cookie
  }

  /**
   * Go util.go request(): Cookie-authenticated JSON request against
   * {address}{pathname}. Non-2xx responses raise the ErrResp error
   * ("[Teldrive] message:%s Error code:%d").
   */
  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<T | null> {
    const init: RequestInit = {
      method,
      headers: {
        Cookie: this.addition.cookie,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
    if (body !== undefined) {
      ;(init.headers as Record<string, string>)["Content-Type"] =
        "application/json"
      init.body = JSON.stringify(body)
    }

    const res = await fetch(this.addition.url + pathname, init)
    if (res.status >= 400) {
      // resty SetError(&e): decode the error body when it is JSON
      let e: TeldriveErrResp = {}
      try {
        e = (await res.json()) as TeldriveErrResp
      } catch {
        /* non-JSON error body */
      }
      throw new Error(
        `[Teldrive] message:${e.message || ""} Error code:${e.code ?? 0}`,
      )
    }
    const text = await res.text()
    if (!text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(
        `[Teldrive] invalid response from ${pathname}: ${text.slice(0, 200)}`,
      )
    }
  }

  // ─── listing (Go driver.go List / util.go getFile) ────────────────────────

  private buildFilesUrl(path: string, page: number): string {
    const params = new URLSearchParams()
    params.set("path", path)
    params.set("limit", String(PAGE_SIZE))
    params.set("page", String(page))
    return `/api/files?${params.toString()}`
  }

  /** Go driver.go List(): paginated directory listing (path based) */
  async listDir(path: string): Promise<TeldriveObject[]> {
    const first = await this.request<TeldriveListResp>(
      "GET",
      this.buildFilesUrl(path, 1),
    )
    const totalPages = first?.meta?.totalPages || 0
    // An empty directory reports totalPages == 0 (Go returns early too)
    if (totalPages < 1) {
      return first?.items || []
    }

    const pages: TeldriveObject[][] = new Array(totalPages)
    pages[0] = first?.items || []

    if (totalPages > 1) {
      // fetch remaining pages with PAGE_CONCURRENCY workers in parallel
      const queue: number[] = []
      for (let i = 2; i <= totalPages; i++) queue.push(i)
      let cursor = 0
      const workers = Array.from(
        { length: Math.min(PAGE_CONCURRENCY, queue.length) },
        async () => {
          while (cursor < queue.length) {
            const page = queue[cursor++]
            const resp = await this.request<TeldriveListResp>(
              "GET",
              this.buildFilesUrl(path, page),
            )
            pages[page - 1] = resp?.items || []
          }
        },
      )
      await Promise.all(workers)
    }

    const all: TeldriveObject[] = []
    for (const p of pages) {
      if (p) all.push(...p)
    }
    return all
  }

  /**
   * Go util.go getFile(): find an entry by parent path + name + type.
   * Returns null when not found (Go returns an error in that case).
   */
  async findFile(
    path: string,
    name: string,
    isFolder: boolean,
  ): Promise<TeldriveObject | null> {
    const params = new URLSearchParams()
    params.set("path", path)
    params.set("name", name)
    params.set("type", isFolder ? "folder" : "file")
    params.set("operation", "find")
    const resp = await this.request<TeldriveListResp>(
      "GET",
      `/api/files?${params.toString()}`,
    )
    const items = resp?.items || []
    return items.length > 0 ? items[0] : null
  }

  // ─── write operations (Go driver.go) ──────────────────────────────────────

  /** Go MakeDir(): POST /api/files/mkdir with the full new folder path */
  async makeDir(path: string): Promise<void> {
    await this.request("POST", "/api/files/mkdir", { path })
  }

  /** Go Move(): POST /api/files/move */
  async moveFiles(ids: string[], destinationParent: string): Promise<void> {
    await this.request("POST", "/api/files/move", {
      ids,
      destinationParent,
    })
  }

  /** Go Rename(): PATCH /api/files/{id} */
  async renameFile(id: string, newName: string): Promise<void> {
    await this.request("PATCH", `/api/files/${goPathEscape(id)}`, {
      name: newName,
    })
  }

  /** Go Remove(): POST /api/files/delete */
  async deleteFiles(ids: string[]): Promise<void> {
    await this.request("POST", "/api/files/delete", { ids })
  }

  /** Go copy.go copySingleFile(): POST /api/files/{id}/copy (server-side copy) */
  async copyFile(
    id: string,
    newName: string,
    destination: string,
  ): Promise<void> {
    await this.request("POST", `/api/files/${goPathEscape(id)}/copy`, {
      newName,
      destination,
    })
  }

  // ─── share links (Go util.go createShareFile / getShareFileById) ──────────

  /** Go getShareFileById(): GET /api/files/{id}/share */
  async getShare(fileId: string): Promise<TeldriveShareObj | null> {
    return await this.request<TeldriveShareObj>(
      "GET",
      `/api/files/${goPathEscape(fileId)}/share`,
    )
  }

  /**
   * Go createShareFile(): POST /api/files/{id}/share with expiresAt = now+1h.
   * The response body is decoded into ErrResp; a non-empty message is an error.
   */
  async createShare(fileId: string): Promise<void> {
    const errResp = await this.request<TeldriveErrResp>(
      "POST",
      `/api/files/${goPathEscape(fileId)}/share`,
      { expiresAt: shareExpiresAt() },
    )
    if (errResp && errResp.message) {
      throw new Error(
        `[Teldrive] message:${errResp.message} Error code:${errResp.code ?? 0}`,
      )
    }
  }

  // ─── download urls (Go driver.go Link) ────────────────────────────────────

  /** Go Link() without share links: {address}/api/files/{id}/{name} */
  buildDownloadUrl(fileId: string, name: string): string {
    return (
      this.addition.url +
      "/api/files/" +
      goPathEscape(fileId) +
      "/" +
      goPathEscape(name)
    )
  }

  /** Go Link() with use_share_link: {address}/api/shares/{shareId}/files/{id}/{name} */
  buildShareDownloadUrl(shareId: string, fileId: string, name: string): string {
    return (
      this.addition.url +
      "/api/shares/" +
      goPathEscape(shareId) +
      "/files/" +
      goPathEscape(fileId) +
      "/" +
      goPathEscape(name)
    )
  }

  /**
   * Go Link(): resolve the download url for a file. When use_share_link is
   * enabled, an existing share is reused, otherwise one is created (expires
   * in 1 hour) and fetched back.
   */
  async resolveDownloadUrl(obj: TeldriveObject): Promise<string> {
    if (!this.isUseShareLink()) {
      return this.buildDownloadUrl(obj.id, obj.name)
    }
    let share: TeldriveShareObj | null = null
    try {
      share = await this.getShare(obj.id)
    } catch {
      share = null
    }
    if (!share) {
      await this.createShare(obj.id)
      share = await this.getShare(obj.id)
    }
    return this.buildShareDownloadUrl(share?.id || "", obj.id, obj.name)
  }
}
