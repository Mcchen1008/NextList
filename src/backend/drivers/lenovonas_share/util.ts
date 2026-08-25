// LenovoNasShare HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/lenovonas_share
//
// Auth: GET {host}/oneproxy/api/share/v1/access?code={share_id}&password={share_pwd}
// → { result, data: { stoken, expires_in } }. The stoken is cached until
// expires_in seconds (minus a 60s safety margin) and re-fetched transparently.
//
// All requests carry the browser-ish headers Go sets (origin / referer /
// user-agent / platform / app-version) and fail when body.result is falsy
// (error message from body.error.msg).
import {
  LenovoNasShareAddition,
  LenovoNasFile,
  LenovoNasFilesResp,
  LenovoNasAccessResp,
  LenovoNasLinkResp,
} from "./types"

const DEFAULT_HOST = "https://siot-share.lenovo.com.cn"

/** Referer required when fetching the download link (Go Link() Header) */
export const LENOVO_NAS_DOWNLOAD_REFERER = "https://siot-share.lenovo.com.cn"

/** Go stdpath.Clean equivalent (lexical) */
function cleanPath(path: string): string {
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

/** Go stdpath.Base equivalent */
function baseName(p: string): string {
  const segs = (p || "").split("/").filter(Boolean)
  return segs.length ? segs[segs.length - 1] : "."
}

export class LenovoNasShareClient {
  private addition: LenovoNasShareAddition
  /** Go: d.ShareId = stdpath.Base(d.ShareId) in Init() */
  public shareId: string
  /** normalized host (no trailing slash) */
  public host: string
  private stoken = ""
  /** epoch seconds when the stoken expires */
  private expireAt = 0
  /**
   * Effective API root path. Normally the configured root_folder_path; when
   * show_root_folder=false and root_folder_path is empty, Go Init() lists the
   * share root and uses the first entry's path as the root folder.
   */
  private effectiveRoot = ""

  constructor(addition: LenovoNasShareAddition) {
    this.addition = addition
    this.shareId = addition.share_id || ""
    this.host = (addition.host || DEFAULT_HOST).replace(/\/+$/, "")
    const root = addition.root_folder_path || ""
    this.effectiveRoot = root && root !== "/" ? cleanPath(root) : ""
  }

  public setEffectiveRoot(path: string): void {
    this.effectiveRoot = cleanPath(path || "")
  }

  public getEffectiveRoot(): string {
    return this.effectiveRoot
  }

  /**
   * Map a NextList physicalPath (configured root_folder_path + virtual rel
   * path) onto the share API path: strip the configured root prefix, then
   * join with the effective root. Go: dir.GetPath() = RootFolderPath + rel.
   */
  public toApiPath(physicalPath: string): string {
    const configuredRoot = this.addition.root_folder_path || ""
    let rel = physicalPath || "/"
    if (configuredRoot && configuredRoot !== "/") {
      const cleaned = cleanPath(configuredRoot)
      if (rel === cleaned) {
        rel = "/"
      } else if (rel.startsWith(cleaned + "/")) {
        rel = rel.slice(cleaned.length)
      }
    }
    const joined = joinPath(this.effectiveRoot, rel)
    return "/" + joined.split("/").filter(Boolean).join("/")
  }

  /** Go request(): fixed headers + result/error envelope check */
  private async request<T>(
    apiPath: string,
    query: Record<string, string>,
  ): Promise<T> {
    const u = new URL(this.host + apiPath)
    for (const [k, v] of Object.entries(query)) {
      u.searchParams.set(k, v)
    }
    const res = await fetch(u.toString(), {
      method: "GET",
      headers: {
        origin: "https://siot-share.lenovo.com.cn",
        referer: "https://siot-share.lenovo.com.cn/",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client",
        platform: "web",
        "app-version": "3",
      },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(
          `[LenovoNasShare] invalid response (HTTP ${res.status}): ${text.slice(0, 200)}`,
        )
      }
    }
    if (!data.result) {
      throw new Error(
        `[LenovoNasShare] ${data?.error?.msg || `request failed (HTTP ${res.status})`}`,
      )
    }
    return data as T
  }

  /** Go getStoken(): exchange share id + password for an stoken */
  public async getStoken(): Promise<void> {
    const resp = await this.request<LenovoNasAccessResp>(
      "/oneproxy/api/share/v1/access",
      {
        code: this.shareId,
        password: this.addition.share_pwd || "",
      },
    )
    this.stoken = (resp.data && resp.data.stoken) || ""
    // Go: expireAt = expires_in + now - 60
    const expiresIn = (resp.data && resp.data.expires_in) || 0
    this.expireAt = expiresIn + Math.floor(Date.now() / 1000) - 60
    if (!this.stoken) {
      throw new Error("[LenovoNasShare] no stoken returned by share access api")
    }
  }

  /** Go checkStoken(): re-fetch the stoken once it has expired */
  private async checkStoken(): Promise<void> {
    if (this.expireAt < Math.floor(Date.now() / 1000)) {
      await this.getStoken()
    }
  }

  /** Go Init(): shareId = path.Base(shareId), then getStoken() */
  public async init(): Promise<void> {
    this.shareId = baseName(this.shareId)
    await this.getStoken()
  }

  /** Go List(): GET /oneproxy/api/share/v1/files under an API path */
  public async listFiles(apiPath: string): Promise<LenovoNasFile[]> {
    await this.checkStoken()
    const resp = await this.request<LenovoNasFilesResp>(
      "/oneproxy/api/share/v1/files",
      {
        code: this.shareId,
        num: "5000",
        stoken: this.stoken,
        path: apiPath,
      },
    )
    return (resp.data && resp.data.list) || []
  }

  /** Go Link(): dtoken → download url (Referer header required) */
  public async getFileLink(apiPath: string): Promise<string> {
    await this.checkStoken()
    const resp = await this.request<LenovoNasLinkResp>(
      "/oneproxy/api/share/v1/file/link",
      {
        code: this.shareId,
        stoken: this.stoken,
        path: apiPath,
      },
    )
    const dtoken =
      (resp.data && resp.data.param && resp.data.param.dtoken) || ""
    return `${this.host}/oneproxy/api/share/v1/file/download?code=${this.shareId}&dtoken=${dtoken}`
  }

  /** Go List() thumbnail url for files */
  public buildThumbUrl(apiPath: string): string {
    return (
      `${this.host}/oneproxy/api/share/v1/file/thumb?code=${this.shareId}` +
      `&stoken=${this.stoken}&path=${encodeURIComponent(apiPath)}`
    )
  }
}
