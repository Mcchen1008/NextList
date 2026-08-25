// 123PanShare (123云盘分享) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/123_share
//
// Read-only browser for 123Pan share links (share key + optional password,
// no account required). Implemented: init / list / get (link with Referer
// header). All write operations throw — the Go driver sets Config().NoUpload
// and returns errs.NotSupport for every write method.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { Pan123ShareAddition, Pan123ShareFile } from "./types"
import { Pan123ShareClient } from "./util"

/** Go types.go File.Thumb(): 70x70 thumbnail url derived from DownloadUrl */
function fileThumb(f: Pan123ShareFile): string {
  if (!f.DownloadUrl) return ""
  try {
    const du = new URL(f.DownloadUrl)
    const suffix = "_24_24"
    const p = du.pathname
    du.pathname =
      (p.endsWith(suffix) ? p.slice(0, p.length - suffix.length) : p) + "_70_70"
    du.searchParams.set("w", "70")
    du.searchParams.set("h", "70")
    if (!du.searchParams.get("type")) {
      // Go: strings.TrimPrefix(path.Base(f.FileName), ".")
      const base = f.FileName.split("/").pop() || f.FileName
      du.searchParams.set("type", base.startsWith(".") ? base.slice(1) : base)
    }
    if (!du.searchParams.get("trade_key")) {
      du.searchParams.set("trade_key", "123pan-thumbnail")
    }
    return du.toString()
  } catch {
    return ""
  }
}

function fileToFileItem(f: Pan123ShareFile): FileItem {
  const isDir = f.Type === 1
  let modified = new Date().toISOString()
  if (f.UpdateAt) {
    const d = new Date(f.UpdateAt)
    if (!isNaN(d.getTime())) modified = d.toISOString()
  }
  return {
    name: f.FileName,
    size: f.Size || 0,
    is_dir: isDir,
    modified,
    sign: String(f.FileId ?? ""),
    type: calcFileType(f.FileName || "", isDir),
    thumb: fileThumb(f),
    raw_url: "",
  }
}

export class Pan123ShareDriver implements StorageDriver {
  private client: Pan123ShareClient
  private addition: Pan123ShareAddition
  /** physical path (name-based) → file/folder id cache (quark resolveFileId pattern) */
  private pathIdCache = new Map<string, string>()

  constructor(addition: Pan123ShareAddition) {
    this.addition = addition
    this.client = new Pan123ShareClient(addition)
  }

  async init(): Promise<void> {
    // Go Init() is a no-op (TODO comment); only validate the share key here
    // so configuration problems surface early.
    if (!this.addition.sharekey) {
      throw new Error("[123PanShare] sharekey is required")
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId = await this.resolveFileId(physicalPath)
    const files = await this.client.getFiles(parentId)
    const items = files.map(fileToFileItem)
    // Go Config().LocalSort = true
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (!parts.length) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.client.getRootId(),
        type: 1,
        raw_url: "",
      }
    }
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveFileId(parentPath)
    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.FileName === name)
    if (!file) {
      throw new Error(`[123PanShare] failed to get '${name}'`)
    }
    const item = fileToFileItem(file)
    if (file.Type !== 1) {
      try {
        const { url, headers } = await this.client.getDownloadUrl(file)
        item.raw_url = url
        item.raw_url_headers = headers
      } catch (e: any) {
        console.warn(
          `[123PanShare] getDownloadUrl warning for ${name}: ${e?.message || e}`,
        )
      }
    }
    return item
  }

  async mkdir(): Promise<void> {
    // Go: errs.NotSupport — share links are read-only
    throw new Error("[123PanShare] read-only driver")
  }

  async rename(): Promise<void> {
    throw new Error("[123PanShare] read-only driver")
  }

  async remove(): Promise<void> {
    throw new Error("[123PanShare] read-only driver")
  }

  async move(): Promise<void> {
    throw new Error("[123PanShare] read-only driver")
  }

  async copy(): Promise<void> {
    throw new Error("[123PanShare] read-only driver")
  }

  async put(): Promise<void> {
    // Go: errs.NotSupport (Config().NoUpload = true)
    throw new Error("[123PanShare] read-only driver")
  }

  /**
   * Resolve a name-based physical path to a 123Pan share file id by walking
   * the share tree level by level (quark resolveFileId pattern, Map cache).
   */
  private async resolveFileId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return this.client.getRootId()
    if (this.pathIdCache.has(clean)) return this.pathIdCache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.client.getRootId()

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathIdCache.has(subPath)) {
        currentId = this.pathIdCache.get(subPath)!
        continue
      }
      const items = await this.client.getFiles(currentId)
      const target = items.find((f) => f.FileName === part)
      if (!target) {
        throw new Error(
          `[123PanShare] path '${part}' not found in folder '${currentId}'`,
        )
      }
      currentId = String(target.FileId)
      this.pathIdCache.set(subPath, currentId)
    }
    return currentId
  }
}
