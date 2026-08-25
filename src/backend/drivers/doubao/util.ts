// Doubao (豆包网盘, ByteDance) HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/doubao
//
// Auth: plain browser Cookie against https://www.doubao.com — every request
// carries the `Cookie` header configured in Addition (Go: req.SetHeader
// ("Cookie", d.Cookie)). There is no token refresh; a user info probe in
// init() validates the cookie.
//
// The Go upload pipeline (SigV4-signed VOD/ImageX upload + CRC32 + multipart)
// is NOT ported — see driver.put().
import {
  DoubaoAddition,
  DoubaoFile,
  DoubaoNodeInfoResp,
  DoubaoGetDownloadInfoResp,
  DoubaoGetFileUrlResp,
  DoubaoGetVideoFileUrlResp,
  DoubaoUploadNodeResp,
  DoubaoUserInfoResp,
  DoubaoBaseResp,
  FILE_NODE_TYPE,
  NODE_TYPE,
} from "./types"

const BASE_URL = "https://www.doubao.com"
/** Go: base.UserAgentNT */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Go: encodeRFC5987 (utils/http.go) */
function encodeRFC5987(s: string): string {
  let out = ""
  for (const b of new TextEncoder().encode(s)) {
    if (
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || // -
      b === 0x2e || // .
      b === 0x5f || // _
      b === 0x7e // ~
    ) {
      out += String.fromCharCode(b)
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0")
    }
  }
  return out
}

/** Go: urlEncode (QueryEscape with %20 instead of +) */
function urlEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/** Go: utils.GenerateContentDisposition */
export function generateContentDisposition(fileName: string): string {
  const encodedName = urlEncode(fileName)
  const encodedNameRFC5987 = encodeRFC5987(fileName)
  return `attachment; filename="${encodedName}"; filename*=utf-8''${encodedNameRFC5987}`
}

/** uuid v4 (Go: github.com/google/uuid) */
function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface DoubaoDownloadLink {
  url: string
  headers?: Record<string, string>
}

export class DoubaoClient {
  private addition: DoubaoAddition
  /** simple rate limiter state (Go: rate.NewLimiter(rate.Limit(LimitRate), 1)) */
  private lastRequestAt = 0

  constructor(addition: DoubaoAddition) {
    this.addition = addition
  }

  public getRootFolderId(): string {
    // Go Config().DefaultRoot = "0"
    return this.addition.root_folder_id || "0"
  }

  public getDownloadApi(): string {
    return this.addition.download_api || "get_file_url"
  }

  /** Go: WaitLimit — [limit_rate] requests per second, sequential gate */
  private async waitLimit(): Promise<void> {
    const rate = Number(this.addition.limit_rate) || 0
    if (rate <= 0) return
    const interval = 1000 / rate
    const wait = this.lastRequestAt + interval - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastRequestAt = Date.now()
  }

  /**
   * Go: request() — execute a request against www.doubao.com with the Cookie
   * header; responses use the CommonResp { code, msg/message, error } shape.
   * A response without a `code` field counts as success (Go json.Unmarshal
   * leaves Code at its zero value 0).
   */
  public async request<T = any>(
    path: string,
    method: "GET" | "POST",
    body?: any,
  ): Promise<T> {
    await this.waitLimit()
    const headers: Record<string, string> = {
      Cookie: this.addition.cookie || "",
      "User-Agent": USER_AGENT,
    }
    if (body !== undefined && method === "POST") {
      headers["Content-Type"] = "application/json"
    }
    const res = await fetch(BASE_URL + path, {
      method,
      headers,
      body:
        body !== undefined && method === "POST"
          ? JSON.stringify(body)
          : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `[Doubao] request failed: status=${res.status} body=${text.slice(0, 200)}`,
      )
    }
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`[Doubao] invalid JSON response: ${text.slice(0, 200)}`)
    }
    // Go: CommonResp.IsSuccess / GetError — code == 0 means success
    const code = data?.code ?? 0
    if (code !== 0) {
      let errMsg = data?.message || data?.msg || ""
      if (data?.error?.message) errMsg = data.error.message
      throw new Error(
        `[Doubao] API error (code: ${code}): ${errMsg || "unknown error"}`,
      )
    }
    return data as T
  }

  /** Go: getFiles — POST /samantha/aispace/node_info with cursor pagination */
  public async getFiles(dirId: string, cursor = ""): Promise<DoubaoFile[]> {
    const result: DoubaoFile[] = []
    let currentCursor = cursor
    // safety cap against endless cursor loops
    for (let page = 0; page < 10000; page++) {
      const body: Record<string, any> = { node_id: dirId }
      if (currentCursor) {
        body["cursor"] = currentCursor
        body["size"] = 50
      } else {
        body["need_full_path"] = false
      }
      const r = await this.request<DoubaoNodeInfoResp>(
        "/samantha/aispace/node_info",
        "POST",
        body,
      )
      if (r.data?.children) result.push(...r.data.children)
      const next = r.data?.next_cursor
      if (!next || next === "-1") break
      currentCursor = next
    }
    return result
  }

  /** Go: getUserInfo — GET /passport/account/info/v2/ (cookie validation) */
  public async getUserInfo(): Promise<{
    user_id: number
    user_id_str: string
  }> {
    const r = await this.request<DoubaoUserInfoResp>(
      "/passport/account/info/v2/",
      "GET",
    )
    return { user_id: r.data?.user_id, user_id_str: r.data?.user_id_str || "" }
  }

  /**
   * Go: Link — resolve a download url for a file node.
   * - download_api=get_download_info → /samantha/aispace/get_download_info
   * - download_api=get_file_url (default):
   *     video/audio nodes → /samantha/media/get_play_info (original media)
   *     everything else   → /alice/message/get_file_url (uris=[key])
   * The link must be fetched with the browser UA and carries a
   * Content-Disposition header naming the file.
   */
  public async getDownloadUrl(file: DoubaoFile): Promise<DoubaoDownloadLink> {
    let downloadUrl = ""
    const api = this.getDownloadApi()

    if (api === "get_download_info") {
      const r = await this.request<DoubaoGetDownloadInfoResp>(
        "/samantha/aispace/get_download_info",
        "POST",
        { requests: [{ node_id: file.id }] },
      )
      const infos = r.data?.download_infos || []
      if (!infos.length || !infos[0].main_url) {
        throw new Error("[Doubao] empty download url (get_download_info)")
      }
      downloadUrl = infos[0].main_url
    } else {
      if (
        file.node_type === NODE_TYPE.VIDEO ||
        file.node_type === NODE_TYPE.AUDIO
      ) {
        const r = await this.request<DoubaoGetVideoFileUrlResp>(
          "/samantha/media/get_play_info",
          "POST",
          { key: file.key, node_id: file.id },
        )
        downloadUrl = r.data?.original_media_info?.main_url || ""
      } else {
        const r = await this.request<DoubaoGetFileUrlResp>(
          "/alice/message/get_file_url",
          "POST",
          {
            uris: [file.key],
            type: FILE_NODE_TYPE[file.node_type] || "file",
          },
        )
        const urls = r.data?.file_urls || []
        downloadUrl = urls.length ? urls[0].main_url : ""
      }
      if (!downloadUrl) {
        throw new Error("[Doubao] empty download url (get_file_url)")
      }
    }

    return {
      url: downloadUrl,
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Disposition": generateContentDisposition(file.name),
      },
    }
  }

  /** Go: MakeDir — POST /samantha/aispace/upload_node (node_type=1) */
  public async makeDir(parentId: string, dirName: string): Promise<void> {
    await this.request<DoubaoUploadNodeResp>(
      "/samantha/aispace/upload_node",
      "POST",
      {
        node_list: [
          {
            local_id: uuid(),
            name: dirName,
            parent_id: parentId,
            node_type: 1,
          },
        ],
      },
    )
  }

  /** Go: Move — POST /samantha/aispace/move_node */
  public async move(
    nodeId: string,
    currentParentId: string,
    targetParentId: string,
  ): Promise<void> {
    await this.request<DoubaoUploadNodeResp>(
      "/samantha/aispace/move_node",
      "POST",
      {
        node_list: [{ id: nodeId }],
        current_parent_id: currentParentId,
        target_parent_id: targetParentId,
      },
    )
  }

  /** Go: Rename — POST /samantha/aispace/rename_node */
  public async rename(nodeId: string, newName: string): Promise<void> {
    await this.request<DoubaoBaseResp>(
      "/samantha/aispace/rename_node",
      "POST",
      { node_id: nodeId, node_name: newName },
    )
  }

  /** Go: Remove — POST /samantha/aispace/delete_node */
  public async remove(nodeId: string): Promise<void> {
    await this.request<DoubaoBaseResp>(
      "/samantha/aispace/delete_node",
      "POST",
      { node_list: [{ id: nodeId }] },
    )
  }

  /** init(): validate cookie (Go also pre-fetches upload tokens — upload only) */
  public async init(): Promise<void> {
    if (!(this.addition.cookie || "").trim()) {
      throw new Error("[Doubao] cookie is required")
    }
    const info = await this.getUserInfo()
    if (!info.user_id && !info.user_id_str) {
      throw new Error("[Doubao] cookie validation failed: empty user id")
    }
  }
}
