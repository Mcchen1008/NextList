// PikPak driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/pikpak
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { PikPakAddition, PikPakFile } from "./types"
import { PikPakClient } from "./util"

function fileToFileItem(f: PikPakFile): FileItem {
  const isDir = f.kind === "drive#folder"
  return {
    name: f.name,
    size: parseInt(f.size || "0", 10) || 0,
    is_dir: isDir,
    modified: f.modified_time || f.created_time || new Date().toISOString(),
    sign: f.id || "",
    type: calcFileType(f.name, isDir),
    thumb: f.thumbnail_link || "",
    raw_url: f.web_content_link || "",
  }
}

export class PikPakDriver implements StorageDriver {
  private client: PikPakClient
  private addition: PikPakAddition
  private pathFileIdCache = new Map<string, string>()

  constructor(addition: PikPakAddition) {
    this.addition = addition
    this.client = new PikPakClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private async resolveFolderId(physicalPath: string): Promise<string> {
    const clean = (physicalPath || "").split("/").filter(Boolean).join("/")
    if (!clean) return this.client.getRootId() || ""
    if (this.pathFileIdCache.has(clean)) return this.pathFileIdCache.get(clean)!
    const parts = clean.split("/")
    let currentId = this.client.getRootId() || ""
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathFileIdCache.has(subPath)) {
        currentId = this.pathFileIdCache.get(subPath)!
        continue
      }
      const files = await this.client.getFiles(currentId)
      const target = files.find((f) => f.name === part)
      if (!target) throw new Error(`[PikPak] Path '${part}' not found`)
      currentId = target.id
      this.pathFileIdCache.set(subPath, currentId)
    }
    return currentId
  }

  private async resolveFile(
    physicalPath: string,
  ): Promise<{ file: PikPakFile; parentId: string; name: string }> {
    const segs = (physicalPath || "").split("/").filter(Boolean)
    if (segs.length === 0) throw new Error("[PikPak] invalid path")
    const name = segs[segs.length - 1]
    const parentPath = "/" + segs.slice(0, segs.length - 1).join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.name === name)
    if (!file) throw new Error(`[PikPak] file not found: ${name}`)
    return { file, parentId, name }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId = await this.resolveFolderId(physicalPath)
    const files = await this.client.getFiles(parentId)
    const items = files.map(fileToFileItem)
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const segs = (physicalPath || "").split("/").filter(Boolean)
    const name = segs[segs.length - 1] || "root"
    if (segs.length === 0) {
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
    try {
      const { file } = await this.resolveFile(physicalPath)
      const item = fileToFileItem(file)
      if (file.kind !== "drive#folder") {
        try {
          item.raw_url = await this.client.getDownloadUrl(file.id)
        } catch (e: any) {
          console.warn(`[PikPak] getDownloadUrl:`, e.message)
        }
      }
      return item
    } catch (e: any) {
      console.warn(`[PikPak] get warning:`, e.message)
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
    const segs = (physicalPath || "").split("/").filter(Boolean)
    const dirName = segs.pop() || "新文件夹"
    const parentPath = "/" + segs.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    await this.client.makeDir(parentId, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const { file } = await this.resolveFile(physicalPath)
    await this.client.rename(file.id, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const { file } = await this.resolveFile(physicalPath)
    await this.client.remove(file.id)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const { file } = await this.resolveFile(srcPhysical)
    const dstId = await this.resolveFolderId(dstDir)
    await this.client.move(file.id, dstId)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const { file } = await this.resolveFile(srcPhysical)
    const dstId = await this.resolveFolderId(dstDir)
    await this.client.copy(file.id, dstId)
  }

  async put(): Promise<void> {
    throw new Error(
      "[PikPak] Direct put not supported (requires OSS multipart upload)",
    )
  }
}
