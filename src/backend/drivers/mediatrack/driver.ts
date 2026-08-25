// MediaTrack driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mediatrack
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { MediaTrackAddition, MediaTrackFile } from "./types"
import { MediaTrackClient } from "./util"

function fileToFileItem(f: MediaTrackFile): FileItem {
  const isDir = !f.file
  let thumb = ""
  if (f.file && f.file.cover) {
    thumb = "https://nano.mtres.cn/" + f.file.cover
  }
  return {
    name: f.title,
    size: parseInt(f.size || "0", 10) || 0,
    is_dir: isDir,
    modified: f.updated_at || new Date().toISOString(),
    sign: f.id || "",
    type: calcFileType(f.title, isDir),
    thumb,
    raw_url: f.file?.src || "",
  }
}

export class MediaTrackDriver implements StorageDriver {
  private client: MediaTrackClient
  private addition: MediaTrackAddition

  constructor(addition: MediaTrackAddition) {
    this.addition = addition
    this.client = new MediaTrackClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId =
      physicalPath.split("/").filter(Boolean).join("/") ||
      this.client.getRootId()
    const files = await this.client.getFiles(parentId || "")
    const items = files.map(fileToFileItem)
    return sortFileItems(
      items,
      this.addition.order_by || "title",
      this.addition.order_desc ? "desc" : "asc",
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
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
    // Try to get by listing parent
    const parentParts = parts.slice(0, parts.length - 1)
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    try {
      const files = await this.client.getFiles(parentId || "")
      const file = files.find((f) => f.id === id)
      if (file) {
        const item = fileToFileItem(file)
        if (file.file) {
          try {
            item.raw_url = await this.client.getDownloadUrl(file.id)
          } catch (e: any) {
            console.warn(`[MediaTrack] getDownloadUrl:`, e.message)
          }
        }
        return item
      }
    } catch (e: any) {
      console.warn(`[MediaTrack] get warning:`, e.message)
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
    const parts = physicalPath.split("/").filter(Boolean)
    const dirName = parts.pop() || "new_folder"
    const parentParts = parts
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    await this.client.makeDir(parentId || "", dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    await this.client.rename(id, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    const parentParts = parts.slice(0, parts.length - 1)
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    await this.client.remove(id, parentId || "")
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = srcPhysical.split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    const dstParts = dstDir.split("/").filter(Boolean)
    const dstParentId = dstParts[dstParts.length - 1] || this.client.getRootId()
    await this.client.move(id, dstParentId || "")
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = srcPhysical.split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    const dstParts = dstDir.split("/").filter(Boolean)
    const dstParentId = dstParts[dstParts.length - 1] || this.client.getRootId()
    await this.client.copy(id, dstParentId || "")
  }

  async put(): Promise<void> {
    throw new Error(
      "[MediaTrack] Direct put not supported (requires COS S3 upload pipeline)",
    )
  }
}
