// MediaFire driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mediafire
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { MediaFireAddition, MediaFireFile } from "./types"
import { MediaFireClient } from "./util"

function fileToFileItem(f: MediaFireFile, hostBase: string): FileItem {
  const isDir = f.is_folder
  let thumb = ""
  if (!isDir && f.id) {
    thumb = hostBase + "/convkey/acaa/" + f.id + "3g.jpg"
  }
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: f.created_utc || new Date().toISOString(),
    sign: f.id || "",
    type: calcFileType(f.name, isDir),
    thumb,
    raw_url: "",
  }
}

export class MediaFireDriver implements StorageDriver {
  private client: MediaFireClient
  private addition: MediaFireAddition

  constructor(addition: MediaFireAddition) {
    this.addition = addition
    this.client = new MediaFireClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderKey =
      physicalPath.split("/").filter(Boolean).join("/") ||
      this.client.getRootId()
    const files = await this.client.getFiles(folderKey || "myfiles")
    const items = files.map((f) => fileToFileItem(f, this.client.getHostBase()))
    return sortFileItems(
      items,
      this.addition.order_by || "name",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const id = parts[parts.length - 1] || ""
    const name = id
    if (!id) {
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
    const parentParts = parts.slice(0, parts.length - 1)
    const parentKey =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    try {
      const files = await this.client.getFiles(parentKey || "myfiles")
      const file = files.find((f) => f.id === id)
      if (file) {
        const item = fileToFileItem(file, this.client.getHostBase())
        if (!file.is_folder) {
          try {
            item.raw_url = await this.client.getDownloadLink(file.id)
            item.raw_url_headers = {
              Origin: "https://app.mediafire.com",
              Referer: "https://app.mediafire.com/",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            }
          } catch (e: any) {
            console.warn(`[MediaFire] getDownloadLink:`, e.message)
          }
        }
        return item
      }
    } catch (e: any) {
      console.warn(`[MediaFire] get warning:`, e.message)
    }
    return {
      name,
      size: 0,
      is_dir: true,
      modified: new Date().toISOString(),
      sign: id,
      type: 1,
      raw_url: "",
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const dirName = parts.pop() || "新文件夹"
    const parentParts = parts
    const parentKey =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    await this.client.makeDir(parentKey || "myfiles", dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    const parentParts = parts.slice(0, parts.length - 1)
    const parentKey =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    let isDir = false
    try {
      const files = await this.client.getFiles(parentKey || "myfiles")
      const found = files.find((f) => f.id === id)
      isDir = found?.is_folder || false
    } catch {}
    await this.client.rename(id, isDir, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    const parentParts = parts.slice(0, parts.length - 1)
    const parentKey =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    let isDir = false
    try {
      const files = await this.client.getFiles(parentKey || "myfiles")
      const found = files.find((f) => f.id === id)
      isDir = found?.is_folder || false
    } catch {}
    await this.client.remove(id, isDir)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    const parentParts = parts.slice(0, parts.length - 1)
    const parentKey =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    let isDir = false
    try {
      const files = await this.client.getFiles(parentKey || "myfiles")
      const found = files.find((f) => f.id === id)
      isDir = found?.is_folder || false
    } catch {}
    const dstParts = (dstDir || "").split("/").filter(Boolean)
    const dstKey = dstParts[dstParts.length - 1] || this.client.getRootId()
    await this.client.move(id, isDir, dstKey || "myfiles")
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    const parentParts = parts.slice(0, parts.length - 1)
    const parentKey =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    let isDir = false
    try {
      const files = await this.client.getFiles(parentKey || "myfiles")
      const found = files.find((f) => f.id === id)
      isDir = found?.is_folder || false
    } catch {}
    const dstParts = (dstDir || "").split("/").filter(Boolean)
    const dstKey = dstParts[dstParts.length - 1] || this.client.getRootId()
    await this.client.copy(id, isDir, dstKey || "myfiles")
  }

  async put(): Promise<void> {
    throw new Error(
      "[MediaFire] Direct put not supported (requires chunked upload + action token pipeline)",
    )
  }
}
