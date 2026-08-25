// OpenListShare HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/openlist_share
import {
  OpenListShareAddition,
  OpenListShareObj,
  FsListReq,
  FsListResp,
  OpenListResp,
} from "./types"

// OpenList drivers/base client.go UserAgent
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

/** Lexical path cleaning — Go stdpath.Clean equivalent */
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

/** Go utils.FixAndCleanPath equivalent: fix backslashes, ensure leading "/", then Clean */
export function fixAndCleanPath(path: string): string {
  let p = path.split("\\").join("/")
  if (!p.startsWith("/")) p = "/" + p
  return cleanPath(p)
}

/** Go stdpath.Join equivalent: join non-empty elements then Clean */
export function joinPath(...elems: string[]): string {
  const joined = elems.filter((e) => e !== "").join("/")
  if (joined === "") return ""
  return cleanPath(joined)
}

export class OpenListShareClient {
  private addition: OpenListShareAddition
  /** Go: d.serverArchivePreview — remote "share_archive_preview" setting (archive APIs not ported) */
  public serverArchivePreview = false

  constructor(addition: OpenListShareAddition) {
    this.addition = {
      ...addition,
      // Go Init(): strings.TrimSuffix(d.Addition.Address, "/")
      url: (addition.url || "").replace(/\/+$/, ""),
    }
  }

  /**
   * Go request(api, method, ...): url = Address + "/api" + api.
   * Fails on HTTP status >= 400 or when body.code != 200.
   */
  private async request<T>(
    api: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    const url = this.addition.url + "/api" + api
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(30_000),
    }
    if (body !== undefined) init.body = JSON.stringify(body)

    const res = await fetch(url, init)
    if (res.status >= 400) {
      throw new Error(
        `[OpenListShare] request failed, status: ${res.status} ${res.statusText}`,
      )
    }
    const text = await res.text()
    let json: OpenListResp<T>
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(
        `[OpenListShare] invalid response from ${api}: ${text.slice(0, 200)}`,
      )
    }
    if (json.code !== 200) {
      throw new Error(
        `[OpenListShare] request failed, code: ${json.code}, message: ${json.message || ""}`,
      )
    }
    return json.data
  }

  /**
   * Go Init(): GET /public/settings, remember whether the remote server
   * enables archive preview for shares.
   */
  async init(): Promise<void> {
    const settings = await this.request<Record<string, string>>(
      "/public/settings",
      "GET",
    )
    this.serverArchivePreview = settings["share_archive_preview"] === "true"
  }

  /**
   * Go List(): POST /fs/list with path "/@s/<shareId>" joined with the
   * physical path (path inside the share, including root_folder_path).
   * PageReq{Page: 1, PerPage: 0} lists everything in one shot.
   */
  async listDir(physicalPath: string): Promise<OpenListShareObj[]> {
    const req: FsListReq = {
      page: 1,
      per_page: 0,
      path: joinPath("/@s/" + this.addition.sid, physicalPath || "/"),
      password: this.addition.pwd || "",
      refresh: false,
    }
    const data = await this.request<FsListResp>("/fs/list", "POST", req)
    return (data && data.content) || []
  }

  /**
   * Go Link(): direct download url of a shared file:
   *   {address}/sd/{sid}{path}?pwd={pwd}
   * The remote /sd/:sid/*path route serves the file. pwd is URL-encoded
   * (Go interpolates it raw).
   */
  buildDownloadUrl(physicalPath: string): string {
    const path = fixAndCleanPath(
      joinPath(this.addition.sid, physicalPath || "/"),
    )
    const pwd = encodeURIComponent(this.addition.pwd || "")
    return `${this.addition.url}/sd${path}?pwd=${pwd}`
  }
}
