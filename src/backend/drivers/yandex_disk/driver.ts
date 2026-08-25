// Yandex Disk driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/yandex_disk
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { YandexDiskAddition, YandexFile } from "./types"
import { YandexDiskClient } from "./util"

function yandexFileToFileItem(f: YandexFile, parentPath: string): FileItem {
  const isDir = f.type === "dir"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: f.modified || new Date().toISOString(),
    sign: "",
    type: calcFileType(f.name, isDir),
    thumb: f.preview || "",
    raw_url: f.file || "",
  }
  void parentPath
}

export class YandexDiskDriver implements StorageDriver {
  private client: YandexDiskClient
  private addition: YandexDiskAddition

  constructor(addition: YandexDiskAddition) {
    this.addition = addition
    this.client = new YandexDiskClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.getFiles(
      physicalPath || "/",
      this.addition.order_by,
      this.addition.order_direction,
    )
    const items = files.map((f) => yandexFileToFileItem(f, physicalPath))
    return sortFileItems(
      items,
      this.addition.order_by || "name",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    try {
      const files = await this.client.getFiles(parentPath)
      const file = files.find((f) => f.name === name)
      if (file) {
        const item = yandexFileToFileItem(file, parentPath)
        if (!file.file) {
          // directory — no download URL needed
          return item
        }
        try {
          item.raw_url = await this.client.getDownloadUrl(physicalPath)
        } catch (e: any) {
          console.warn(
            `[YandexDisk] getDownloadUrl warning for ${name}:`,
            e.message,
          )
        }
        return item
      }
    } catch (e: any) {
      // fall through to fallback
      console.warn(`[YandexDisk] get warning:`, e.message)
    }
    // Fallback: assume folder
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
    await this.client.makeDir(physicalPath)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    parts.pop()
    const newPath = "/" + [...parts, newName].join("/")
    await this.client.move(physicalPath, newPath)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    await this.client.remove(physicalPath)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const fileName = parts[parts.length - 1] || "file"
    const to = (dstDir === "/" ? "" : dstDir) + "/" + fileName
    await this.client.move(srcPhysical, to)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const fileName = parts[parts.length - 1] || "file"
    const to = (dstDir === "/" ? "" : dstDir) + "/" + fileName
    await this.client.copy(srcPhysical, to)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const href = await this.client.getUploadUrl(physicalPath)
    await this.client.upload(href, content)
  }
}
