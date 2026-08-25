// Seafile driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/seafile
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { SeafileAddition, SeafileRepoItem, SeafileLibraryItem } from "./types"
import { SeafileClient } from "./util"

function repoItemToFileItem(f: SeafileRepoItem): FileItem {
  const isDir = f.type === "dir"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: f.mtime
      ? new Date(f.mtime * 1000).toISOString()
      : new Date().toISOString(),
    sign: f.id || "",
    type: calcFileType(f.name, isDir),
    thumb: "",
    raw_url: "",
  }
}

function libraryToFileItem(f: SeafileLibraryItem): FileItem {
  return {
    name: f.name,
    size: 0,
    is_dir: true,
    modified: f.mtime
      ? new Date(f.mtime * 1000).toISOString()
      : new Date().toISOString(),
    sign: f.id || "",
    type: 1,
    thumb: "",
    raw_url: "",
  }
}

export class SeafileDriver implements StorageDriver {
  private client: SeafileClient
  private addition: SeafileAddition

  constructor(addition: SeafileAddition) {
    this.addition = addition
    this.client = new SeafileClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  /**
   * Resolve a physical path to { repoId, path }.
   * If repoId is configured, the first path segment is the directory.
   * Otherwise the first segment is the library name and we resolve by listing libraries.
   */
  private async resolvePath(
    physicalPath: string,
  ): Promise<{ repoId: string; path: string }> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    if (this.addition.repo_id) {
      return { repoId: this.addition.repo_id, path: "/" + parts.join("/") }
    }
    if (parts.length === 0) {
      throw new Error("Seafile: cannot resolve root path without repo_id")
    }
    const libName = parts[0]
    const restParts = parts.slice(1)
    const libraries = await this.client.listLibraries()
    const lib = libraries.find((l) => l.name === libName)
    if (!lib) throw new Error(`Seafile: library '${libName}' not found`)
    return { repoId: lib.id, path: "/" + restParts.join("/") }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    // Root level: list libraries
    if (parts.length === 0 && !this.addition.repo_id) {
      const libs = await this.client.listLibraries()
      return libs.map(libraryToFileItem)
    }
    const { repoId, path } = await this.resolvePath(physicalPath)
    const items = await this.client.listDir(repoId, path)
    return items.map(repoItemToFileItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    if (parts.length === 0 && !this.addition.repo_id) {
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
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const { repoId, path } = await this.resolvePath(physicalPath)
    try {
      const items = await this.client.listDir(repoId, parentPath)
      const file = items.find((f) => f.name === name)
      if (file) {
        const item = repoItemToFileItem(file)
        if (file.type !== "dir") {
          try {
            item.raw_url = await this.client.getFileDownloadUrl(repoId, path)
          } catch (e: any) {
            console.warn(`[Seafile] getDownloadUrl warning:`, e.message)
          }
        }
        return item
      }
    } catch (e: any) {
      console.warn(`[Seafile] get warning:`, e.message)
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
    const dirName = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    const { repoId, path: parentResolved } = await this.resolvePath(parentPath)
    await this.client.mkdir(repoId, parentResolved, dirName)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const { repoId, path } = await this.resolvePath(physicalPath)
    await this.client.rename(repoId, path, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const { repoId, path } = await this.resolvePath(physicalPath)
    await this.client.remove(repoId, path)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const src = await this.resolvePath(srcPhysical)
    const dst = await this.resolvePath(dstDir)
    await this.client.move(src.repoId, src.path, dst.repoId, dst.path)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const src = await this.resolvePath(srcPhysical)
    const dst = await this.resolvePath(dstDir)
    await this.client.copy(src.repoId, src.path, dst.repoId, dst.path)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const fileName = parts.pop() || "upload"
    const parentPath = "/" + parts.join("/")
    const { repoId, path: parentResolved } = await this.resolvePath(parentPath)
    const uploadUrl = await this.client.getUploadUrl(repoId, parentResolved)
    await this.client.upload(uploadUrl, parentResolved, fileName, content)
  }
}
