// Misskey HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/misskey
import { MisskeyAddition, MisskeyFile, MisskeyFolder } from "./types"

// OpenList drivers/base client.go UserAgent
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

/** safety cap for untilId pagination (100 pages x 100 items = 10k entries) */
const MAX_PAGES = 100

export class MisskeyClient {
  private endpoint: string
  private accessToken: string

  constructor(addition: MisskeyAddition) {
    // Go Init(): strings.TrimSuffix(d.Endpoint, "/")
    this.endpoint = (addition.endpoint || "").replace(/\/+$/, "")
    this.accessToken = addition.access_token || ""
  }

  getEndpoint(): string {
    return this.endpoint
  }

  getToken(): string {
    return this.accessToken
  }

  /**
   * Go request(path, method, ...): POST {endpoint}/api/drive{path} with an
   * "Authorization: Bearer <token>" header (resty SetAuthToken) and a JSON
   * body. Non-2xx responses raise with the response body, like Go's
   * errors.New(response.String()).
   */
  async request<T>(apiPath: string, body?: unknown): Promise<T> {
    const url = this.endpoint + "/api/drive" + apiPath
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.accessToken,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `[Misskey] request ${apiPath} failed, status: ${res.status}, body: ${text.slice(0, 300)}`,
      )
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(
        `[Misskey] invalid response from ${apiPath}: ${text.slice(0, 200)}`,
      )
    }
  }

  /**
   * POST /files — files of a folder (drive root when folderId is falsy).
   * The Misskey API caps each response at 100 items; the Go driver fetches
   * a single page, here we keep requesting with untilId so that folders
   * with more than 100 files are fully listed.
   */
  async getFiles(folderId: string | null): Promise<MisskeyFile[]> {
    const result: MisskeyFile[] = []
    let untilId: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = {}
      if (folderId) body.folderId = folderId
      if (untilId) body.untilId = untilId
      const files = await this.request<MisskeyFile[]>("/files", body)
      if (!Array.isArray(files) || files.length === 0) break
      result.push(...files)
      const last = files[files.length - 1].id
      if (!last || untilId === last) break
      untilId = last
    }
    return result
  }

  /** POST /folders — folders of a folder (drive root when folderId is falsy) */
  async getFolders(folderId: string | null): Promise<MisskeyFolder[]> {
    const result: MisskeyFolder[] = []
    let untilId: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = {}
      if (folderId) body.folderId = folderId
      if (untilId) body.untilId = untilId
      const folders = await this.request<MisskeyFolder[]>("/folders", body)
      if (!Array.isArray(folders) || folders.length === 0) break
      result.push(...folders)
      const last = folders[folders.length - 1].id
      if (!last || untilId === last) break
      untilId = last
    }
    return result
  }

  /** POST /files/show — Go link() */
  async getFile(fileId: string): Promise<MisskeyFile> {
    return this.request<MisskeyFile>("/files/show", { fileId })
  }

  /** POST /folders/create — Go makeDir(): parentId is null for the root */
  async createFolder(
    parentId: string | null,
    name: string,
  ): Promise<MisskeyFolder> {
    return this.request<MisskeyFolder>("/folders/create", {
      parentId: parentId || null,
      name,
    })
  }

  /** POST /folders/update — Go move()/rename() for folders */
  async updateFolder(
    folderId: string,
    patch: { name?: string; parentId?: string | null },
  ): Promise<MisskeyFolder> {
    return this.request<MisskeyFolder>("/folders/update", {
      folderId,
      ...patch,
    })
  }

  /** POST /files/update — Go move()/rename() for files */
  async updateFile(
    fileId: string,
    patch: { name?: string; folderId?: string | null },
  ): Promise<MisskeyFile> {
    return this.request<MisskeyFile>("/files/update", { fileId, ...patch })
  }

  /** POST /folders/delete — Go remove() for folders */
  async deleteFolder(folderId: string): Promise<void> {
    await this.request("/folders/delete", { folderId })
  }

  /** POST /files/delete — Go remove() for files */
  async deleteFile(fileId: string): Promise<void> {
    await this.request("/files/delete", { fileId })
  }

  /** POST /files/upload-from-url — Go copy() for files */
  async uploadFromUrl(url: string, folderId: string | null): Promise<void> {
    await this.request("/files/upload-from-url", {
      url,
      folderId: folderId || null,
    })
  }

  /**
   * Go put(): multipart form POST {endpoint}/api/drive/files/create with
   * fields name/comment/isSensitive/force (+ folderId when not root) and
   * the raw file content as the "file" part. Uses fetch FormData/Blob only,
   * so it stays Cloudflare Workers compatible.
   */
  async uploadFile(
    name: string,
    folderId: string | null,
    content: Buffer,
  ): Promise<MisskeyFile> {
    const form = new FormData()
    form.append("name", name)
    form.append("comment", "")
    form.append("isSensitive", "false")
    form.append("force", "false")
    if (folderId) form.append("folderId", folderId)
    form.append("file", new Blob([new Uint8Array(content)]), name)

    const res = await fetch(this.endpoint + "/api/drive/files/create", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.accessToken,
        "User-Agent": USER_AGENT,
      },
      body: form,
      signal: AbortSignal.timeout(300_000),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `[Misskey] upload failed, status: ${res.status}, body: ${text.slice(0, 300)}`,
      )
    }
    try {
      return JSON.parse(text) as MisskeyFile
    } catch {
      throw new Error(
        `[Misskey] invalid response from /files/create: ${text.slice(0, 200)}`,
      )
    }
  }
}
