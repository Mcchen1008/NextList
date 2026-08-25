// 139 Cloud (和彩云 / Mcloud) driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/139
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { Cloud139Addition, Cloud139File } from "./types"
import { Cloud139Client } from "./util"

function fileToFileItem(f: Cloud139File): FileItem {
  const isDir = !f.contentID || f.type === "folder"
  const name = f.contentName || f.name || ""
  return {
    name,
    size: f.contentSize || f.size || 0,
    is_dir: isDir,
    modified: f.updateTime || f.updated_at || new Date().toISOString(),
    sign: f.contentID || f.file_id || "",
    type: calcFileType(name, isDir),
    thumb: f.thumbnailURL || "",
    raw_url: "",
  }
}

export class Cloud139Driver implements StorageDriver {
  private client: Cloud139Client
  private addition: Cloud139Addition
  private pathFileIdCache = new Map<string, string>()

  constructor(addition: Cloud139Addition) {
    this.addition = addition
    this.client = new Cloud139Client(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private async resolveFolderId(physicalPath: string): Promise<string> {
    const clean = (physicalPath || "").split("/").filter(Boolean).join("/")
    if (!clean) return this.client.getRootFolderId()
    if (this.pathFileIdCache.has(clean)) return this.pathFileIdCache.get(clean)!
    // 139 uses path-based addressing for personal_new; pass path directly
    return clean
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFolderId(physicalPath)
    const files = await this.client.getFiles(folderId)
    const items = files.map(fileToFileItem)
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    try {
      const files = await this.client.getFiles(parentPath)
      const file = files.find((f) => (f.contentName || f.name) === name)
      if (file) {
        const item = fileToFileItem(file)
        if (file.contentID) {
          try {
            item.raw_url = await this.client.getDownloadUrl(file.contentID)
          } catch (e: any) {
            console.warn(`[139] getDownloadUrl:`, e.message)
          }
        }
        return item
      }
    } catch (e: any) {
      console.warn(`[139] get warning:`, e.message)
    }
    return {
      name,
      size: 0,
      is_dir: true,
      modified: new Date().toISOString(),
      sign: "",
      type: 1,
      raw_url: "",
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts.pop() || "新文件夹"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    await this.client.mkdir(parentId, name)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const files = await this.client.getFiles(parentPath)
    const file = files.find((f) => (f.contentName || f.name) === name)
    if (!file || !file.contentID) {
      throw new Error(`[139] file not found: ${name}`)
    }
    await this.client.rename(file.contentID, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const files = await this.client.getFiles(parentPath)
    const file = files.find((f) => (f.contentName || f.name) === name)
    if (!file || !file.contentID) {
      throw new Error(`[139] file not found: ${name}`)
    }
    await this.client.remove([file.contentID])
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const files = await this.client.getFiles(parentPath)
    const file = files.find((f) => (f.contentName || f.name) === name)
    if (!file || !file.contentID) {
      throw new Error(`[139] file not found: ${name}`)
    }
    const dstParts = (dstDir || "").split("/").filter(Boolean)
    const dstParentId = dstParts.join("/")
    await this.client.move([file.contentID], dstParentId)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const files = await this.client.getFiles(parentPath)
    const file = files.find((f) => (f.contentName || f.name) === name)
    if (!file || !file.contentID) {
      throw new Error(`[139] file not found: ${name}`)
    }
    const dstParts = (dstDir || "").split("/").filter(Boolean)
    const dstParentId = dstParts.join("/")
    await this.client.copy([file.contentID], dstParentId)
  }

  async put(): Promise<void> {
    throw new Error(
      "[139] Direct put not supported (requires chunked upload pipeline)",
    )
  }
}
