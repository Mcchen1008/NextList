// UC网盘 HTTP client — variant of quark with different API config
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/quark_uc
import { UcAddition, UcFile, UcSortResp, UcDownloadResp } from "./types"

const UC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch"
const UC_REFERER = "https://drive.uc.cn"
const UC_API = "https://pc-api.uc.cn/1/clouddrive"
const UC_PR = "UCBrowser"

export class UcClient {
  private addition: UcAddition
  private cookie: string
  private onCookieUpdate?: (cookie: string) => void

  constructor(addition: UcAddition, onCookieUpdate?: (cookie: string) => void) {
    this.addition = addition
    this.cookie = addition.cookie
    this.onCookieUpdate = onCookieUpdate
  }

  public getRootFolderId(): string {
    return this.addition.root_id || "0"
  }

  public async init(): Promise<void> {
    // Validate by calling /config
    await this.request("/config", "GET")
  }

  public async request<T = any>(
    pathname: string,
    method: "GET" | "POST",
    opts?: { query?: Record<string, string>; body?: any },
    retry = true,
  ): Promise<T> {
    const url = new URL(UC_API + pathname)
    url.searchParams.set("pr", UC_PR)
    url.searchParams.set("fr", "pc")
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, v)
      }
    }
    const init: RequestInit = {
      method,
      headers: {
        Cookie: this.cookie,
        Accept: "application/json, text/plain, */*",
        Referer: UC_REFERER,
        "User-Agent": UC_UA,
      },
    }
    if (opts?.body !== undefined) {
      ;(init.headers as Record<string, string>)["Content-Type"] =
        "application/json"
      init.body = JSON.stringify(opts.body)
    }
    const res = await fetch(url.toString(), init)
    // Update __puus cookie from Set-Cookie if present
    const setCookie = res.headers.get("set-cookie")
    if (setCookie) {
      const puusMatch = setCookie.match(/__puus=([^;]+)/)
      if (puusMatch) {
        this.cookie = setCookieValue(this.cookie, "__puus", puusMatch[1])
        this.onCookieUpdate?.(this.cookie)
      }
    }
    const data = (await res.json()) as any
    if (
      (data.status && data.status >= 400) ||
      (data.code !== undefined && data.code !== 0)
    ) {
      throw new Error(data.message || `uc error: code ${data.code}`)
    }
    return data as T
  }

  public async getFiles(parentId: string): Promise<UcFile[]> {
    const result: UcFile[] = []
    let page = 1
    const size = 100
    const query: Record<string, string> = {
      pdir_fid: parentId,
      _size: String(size),
      _fetch_total: "1",
      fetch_all_file: "1",
      fetch_risk_file_name: "1",
    }
    if (this.addition.order_by && this.addition.order_by !== "none") {
      query["_sort"] =
        `file_type:asc,${this.addition.order_by}:${this.addition.order_direction || "asc"}`
    }
    for (;;) {
      query["_page"] = String(page)
      const resp = await this.request<UcSortResp>("/file/sort", "GET", {
        query,
      })
      if (!resp.data || !resp.data.list) break
      for (const f of resp.data.list) {
        if (this.addition.only_list_video_file) {
          if (!f.file || f.category === 1) result.push(f)
        } else {
          result.push(f)
        }
      }
      if (resp.data.list.length < size) break
      page++
      if (page > 100) break
    }
    return result
  }

  public async getDownloadUrl(
    fileId: string,
    fileName: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const resp = await this.request<UcDownloadResp>("/file/download", "GET", {
      query: { fid: fileId, fname: fileName, ask: "0" },
    })
    if (resp.code !== 0 && resp.code !== undefined) {
      throw new Error(`uc getDownloadUrl failed: ${resp.message}`)
    }
    return {
      url: resp.data || "",
      headers: {
        Cookie: this.cookie,
        Referer: UC_REFERER,
        "User-Agent": UC_UA,
      },
    }
  }

  public async mkdir(parentId: string, dirName: string): Promise<void> {
    await this.request("/file", "POST", {
      body: {
        dir_init_lock: false,
        dir_path: "",
        file_name: dirName,
        pdir_fid: parentId,
      },
    })
  }

  public async move(fileIds: string[], dstParentId: string): Promise<void> {
    await this.request("/file/move", "POST", {
      body: {
        action_type: 1,
        exclude_fids: [],
        filelist: fileIds,
        to_pdir_fid: dstParentId,
      },
    })
  }

  public async rename(fileId: string, newName: string): Promise<void> {
    await this.request("/file/rename", "POST", {
      body: { fid: fileId, file_name: newName },
    })
  }

  public async copy(fileIds: string[], dstParentId: string): Promise<void> {
    await this.request("/file/copy", "POST", {
      body: {
        action_type: 1,
        exclude_fids: [],
        filelist: fileIds,
        to_pdir_fid: dstParentId,
      },
    })
  }

  public async remove(fileIds: string[]): Promise<void> {
    await this.request("/file/delete", "POST", {
      body: { action_type: 2, filelist: fileIds, exclude_fids: [] },
    })
  }
}

function setCookieValue(cookieStr: string, key: string, value: string): string {
  const parts = cookieStr
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
  const existing = parts.findIndex((p) => {
    const idx = p.indexOf("=")
    return idx !== -1 && p.substring(0, idx).trim() === key
  })
  const newPart = `${key}=${value}`
  if (existing !== -1) parts[existing] = newPart
  else parts.push(newPart)
  return parts.join("; ")
}
