// OpenListShare driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/openlist_share
//
// Browses files shared by another OpenList/AList instance through a share
// link (share id + optional share password) — no account needed.
// Read-only: the Go driver sets NoUpload and implements no write methods;
// archive preview (GetArchiveMeta/ListArchive/Extract) is not ported.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { OpenListShareAddition, OpenListShareObj } from "./types"
import { OpenListShareClient } from "./util"

function objToFileItem(f: OpenListShareObj): FileItem {
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: !!f.is_dir,
    modified: f.modified || new Date().toISOString(),
    created: f.created || undefined,
    sign: "",
    type: calcFileType(f.name, !!f.is_dir),
    thumb: f.thumb || "",
    raw_url: "",
  }
}

export class OpenListShareDriver implements StorageDriver {
  private client: OpenListShareClient

  constructor(addition: OpenListShareAddition) {
    this.client = new OpenListShareClient(addition)
  }

  async init(): Promise<void> {
    // Go Init(): GET /public/settings (validates the address and reads the
    // share_archive_preview setting)
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const objs = await this.client.listDir(physicalPath || "/")
    const items = objs.map(objToFileItem)
    // Go Config().LocalSort = true: OpenList sorts driver results locally
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const path = physicalPath || "/"
    const parts = path.split("/").filter(Boolean)
    if (parts.length === 0) {
      // storage root (Go: IRootPath root object)
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }
    // The Go driver implements no Getter, so OpenList falls back to listing
    // the parent directory and matching the entry by name.
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const objs = await this.client.listDir(parentPath)
    const found = objs.find((f) => f.name === name)
    if (!found) {
      throw new Error(`[OpenListShare] failed to get obj: ${path} not found`)
    }
    const item = objToFileItem(found)
    if (!found.is_dir) {
      // Go Link(): {address}/sd/{sid}{path}?pwd={pwd}
      item.raw_url = this.client.buildDownloadUrl(path)
    }
    return item
  }

  async mkdir(): Promise<void> {
    // Go config: NoUpload = true, no write methods on a share link
    throw new Error("[OpenListShare] read-only driver")
  }

  async rename(): Promise<void> {
    throw new Error("[OpenListShare] read-only driver")
  }

  async remove(): Promise<void> {
    throw new Error("[OpenListShare] read-only driver")
  }

  async move(): Promise<void> {
    throw new Error("[OpenListShare] read-only driver")
  }

  async copy(): Promise<void> {
    throw new Error("[OpenListShare] read-only driver")
  }

  async put(): Promise<void> {
    // Go side cannot upload into a share either (NoUpload = true)
    throw new Error("[OpenListShare] read-only driver")
  }
}
