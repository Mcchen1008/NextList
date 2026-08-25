// USS (又拍云对象存储) driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/uss
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { UssAddition } from "./types"
import { UssClient, UssFileInfo, getKey, joinPath, getParent } from "./util"

function fileToFileItem(f: UssFileInfo, parentPath: string): FileItem {
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: f.is_dir,
    modified: f.modified || new Date().toISOString(),
    sign: getKey(joinPath(parentPath, f.name), f.is_dir),
    type: calcFileType(f.name, f.is_dir),
    thumb: "",
    raw_url: "",
  }
}

export class UssDriver implements StorageDriver {
  private client: UssClient
  private addition: UssAddition

  constructor(addition: UssAddition) {
    this.addition = addition
    this.client = new UssClient(addition)
  }

  async init(): Promise<void> {
    // No-op; auth is per-request
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.list(physicalPath || "/")
    const items = files.map((f) => fileToFileItem(f, physicalPath))
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentPath = getParent(physicalPath)
    const isLikelyDir = !name.includes(".")
    // Try listing parent
    try {
      const files = await this.client.list(parentPath || "/")
      const found = files.find((f) => f.name === name)
      if (found) {
        const item = fileToFileItem(found, parentPath)
        if (!found.is_dir) {
          try {
            item.raw_url = await this.client.getDownloadUrl(physicalPath)
          } catch (e: any) {
            console.warn(`[USS] getDownloadUrl:`, e.message)
          }
        }
        return item
      }
    } catch (e: any) {
      console.warn(`[USS] get warning:`, e.message)
    }
    return {
      name,
      size: 0,
      is_dir: isLikelyDir,
      modified: new Date().toISOString(),
      sign: "",
      type: isLikelyDir ? 1 : 0,
      raw_url: "",
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    await this.client.mkdir(parentPath, name)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const oldName = parts.pop() || ""
    const parentPath = "/" + parts.join("/")
    // Need to determine if dir or file — attempt move with isDir=true first, fallback to false
    let isDir = false
    try {
      const files = await this.client.list(parentPath || "/")
      const found = files.find((f) => f.name === oldName)
      isDir = found?.is_dir || false
    } catch {}
    const dst = joinPath(parentPath, newName)
    await this.client.move(physicalPath, isDir, dst)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts.pop() || ""
    const parentPath = "/" + parts.slice(0, -1).join("/")
    let isDir = false
    try {
      const files = await this.client.list(parentPath || "/")
      const found = files.find((f) => f.name === name)
      isDir = found?.is_dir || false
    } catch {}
    await this.client.remove(physicalPath, isDir)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1] || ""
    const parentPath = "/" + parts.slice(0, -1).join("/")
    let isDir = false
    try {
      const files = await this.client.list(parentPath || "/")
      const found = files.find((f) => f.name === name)
      isDir = found?.is_dir || false
    } catch {}
    const dst = joinPath(dstDir, name)
    await this.client.move(srcPhysical, isDir, dst)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1] || ""
    const parentPath = "/" + parts.slice(0, -1).join("/")
    let isDir = false
    try {
      const files = await this.client.list(parentPath || "/")
      const found = files.find((f) => f.name === name)
      isDir = found?.is_dir || false
    } catch {}
    const dst = joinPath(dstDir, name)
    await this.client.copy(srcPhysical, isDir, dst)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts.pop() || "upload"
    const parentPath = "/" + parts.join("/")
    await this.client.upload(parentPath, name, content)
  }
}
