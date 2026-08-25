// PikPakShare driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/pikpak_share
//
// Read-only browser for PikPak share links (share id + optional pass code).
// Implemented: init / list / get (link). All write operations throw — the Go
// driver sets Config().NoUpload = true and implements no write methods.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { PikPakShareAddition, PikPakShareFile } from "./types"
import { PikPakShareClient } from "./util"

function fileToFileItem(f: PikPakShareFile): FileItem {
  const isDir = f.kind === "drive#folder"
  let modified = new Date().toISOString()
  if (f.modified_time) {
    const d = new Date(f.modified_time)
    if (!isNaN(d.getTime())) modified = d.toISOString()
  }
  return {
    name: f.name,
    size: parseInt(f.size || "0", 10) || 0,
    is_dir: isDir,
    modified,
    sign: f.id || "",
    type: calcFileType(f.name || "", isDir),
    thumb: f.thumbnail_link || "",
    raw_url: "",
  }
}

export class PikPakShareDriver implements StorageDriver {
  private client: PikPakShareClient
  /** physical path (name-based) → file/folder id cache (quark resolveFileId pattern) */
  private pathFileIdCache = new Map<string, string>()

  constructor(
    addition: PikPakShareAddition,
    onDeviceId?: (deviceId: string) => void,
  ) {
    this.client = new PikPakShareClient(addition, onDeviceId)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFileId(physicalPath)
    const files = await this.client.getFiles(folderId)
    const items = files.map(fileToFileItem)
    // Go Config().LocalSort = true
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    if (!parts.length) {
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
    const fileId = await this.resolveFileId(physicalPath)
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveFileId(parentPath)

    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.id === fileId || f.name === name)

    if (file) {
      const item = fileToFileItem(file)
      if (file.kind !== "drive#folder") {
        try {
          item.raw_url = await this.client.getShareFileLink(file.id)
        } catch (e: any) {
          console.warn(
            `[PikPakShare] getShareFileLink warning for ${name}:`,
            e.message,
          )
        }
      }
      return item
    }

    // Fallback: probe by listing — if the id lists, it is a folder.
    try {
      await this.client.getFiles(fileId)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: fileId,
        type: 1,
        raw_url: "",
      }
    } catch {}

    let rawUrl = ""
    try {
      rawUrl = await this.client.getShareFileLink(fileId)
    } catch (e: any) {
      console.warn(
        `[PikPakShare] getShareFileLink warning for ${name}:`,
        e.message,
      )
    }
    return {
      name,
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: fileId,
      type: 0,
      raw_url: rawUrl,
    }
  }

  async mkdir(): Promise<void> {
    // Go config: NoUpload = true, no write methods on a share link
    throw new Error("[PikPakShare] read-only driver")
  }

  async rename(): Promise<void> {
    throw new Error("[PikPakShare] read-only driver")
  }

  async remove(): Promise<void> {
    throw new Error("[PikPakShare] read-only driver")
  }

  async move(): Promise<void> {
    throw new Error("[PikPakShare] read-only driver")
  }

  async copy(): Promise<void> {
    throw new Error("[PikPakShare] read-only driver")
  }

  async put(): Promise<void> {
    // Go side cannot upload into a share either (NoUpload = true)
    throw new Error("[PikPakShare] read-only driver")
  }

  /**
   * Resolve a name-based physical path to a PikPak share file id by walking
   * the share tree level by level (quark resolveFileId pattern, Map cache).
   */
  private async resolveFileId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return this.client.getRootFolderId()
    if (this.pathFileIdCache.has(clean)) return this.pathFileIdCache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.client.getRootFolderId()

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathFileIdCache.has(subPath)) {
        currentId = this.pathFileIdCache.get(subPath)!
        continue
      }

      const items = await this.client.getFiles(currentId)
      const target = items.find((f) => f.name === part)
      if (!target) {
        throw new Error(
          `[PikPakShare] Path '${part}' not found in folder '${currentId}'`,
        )
      }
      currentId = target.id
      this.pathFileIdCache.set(subPath, currentId)
    }

    return currentId
  }
}
