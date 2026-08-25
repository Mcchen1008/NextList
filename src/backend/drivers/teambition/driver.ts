// Teambition driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/teambition
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import {
  TeambitionAddition,
  TeambitionCollection,
  TeambitionWork,
} from "./types"
import { TeambitionClient } from "./util"

function collectionToFileItem(c: TeambitionCollection): FileItem {
  return {
    name: c.title,
    size: 0,
    is_dir: true,
    modified: c.updated || new Date().toISOString(),
    sign: c._id || "",
    type: 1,
    thumb: "",
    raw_url: "",
  }
}

function workToFileItem(w: TeambitionWork): FileItem {
  return {
    name: w.fileName,
    size: w.fileSize || 0,
    is_dir: false,
    modified: w.updated || new Date().toISOString(),
    sign: w._id || "",
    type: calcFileType(w.fileName, false),
    thumb: w.thumbnailUrl || w.thumbnail || "",
    raw_url: w.downloadUrl || "",
  }
}

export class TeambitionDriver implements StorageDriver {
  private client: TeambitionClient
  private addition: TeambitionAddition

  constructor(addition: TeambitionAddition) {
    this.addition = addition
    this.client = new TeambitionClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId =
      physicalPath.split("/").filter(Boolean).join("/") ||
      this.client.getRootId()
    const collections = await this.client.getCollections(parentId || "")
    const works = await this.client.getWorks(parentId || "")
    const items: FileItem[] = [
      ...collections.map(collectionToFileItem),
      ...works.map(workToFileItem),
    ]
    return sortFileItems(items, "file_name", "asc")
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
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    try {
      const collections = await this.client.getCollections(parentId || "")
      const col = collections.find((c) => c._id === id)
      if (col) return collectionToFileItem(col)
      const works = await this.client.getWorks(parentId || "")
      const work = works.find((w) => w._id === id)
      if (work) {
        const item = workToFileItem(work)
        try {
          item.raw_url = await this.client.getDownloadUrl(work)
        } catch (e: any) {
          console.warn(`[Teambition] getDownloadUrl:`, e.message)
        }
        return item
      }
    } catch (e: any) {
      console.warn(`[Teambition] get warning:`, e.message)
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
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    await this.client.makeDir(parentId || "", dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const id = parts[parts.length - 1]
    const parentParts = parts.slice(0, parts.length - 1)
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    let isDir = false
    try {
      const cols = await this.client.getCollections(parentId || "")
      isDir = cols.some((c) => c._id === id)
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
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    let isDir = false
    try {
      const cols = await this.client.getCollections(parentId || "")
      isDir = cols.some((c) => c._id === id)
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
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    let isDir = false
    try {
      const cols = await this.client.getCollections(parentId || "")
      isDir = cols.some((c) => c._id === id)
    } catch {}
    const dstParts = (dstDir || "").split("/").filter(Boolean)
    const dstParentId = dstParts[dstParts.length - 1] || this.client.getRootId()
    await this.client.move(id, isDir, dstParentId || "")
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
    const parentId =
      parentParts[parentParts.length - 1] || this.client.getRootId()
    let isDir = false
    try {
      const cols = await this.client.getCollections(parentId || "")
      isDir = cols.some((c) => c._id === id)
    } catch {}
    const dstParts = (dstDir || "").split("/").filter(Boolean)
    const dstParentId = dstParts[dstParts.length - 1] || this.client.getRootId()
    await this.client.copy(id, isDir, dstParentId || "")
  }

  async put(): Promise<void> {
    throw new Error(
      "[Teambition] Direct put not supported (requires S3 upload token)",
    )
  }
}
