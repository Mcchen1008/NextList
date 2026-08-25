// FebBox driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/febbox
//
// FebBox netdisk (ID-based API). Auth: OAuth2 client_credentials or
// refresh_token grant (see util.ts). Implemented: list / get (link) / mkdir /
// move / rename / copy / remove. Put is not implemented on the Go side either
// (errs.NotImplement, Config().NoUpload = true).
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { FebBoxAddition, FebBoxFile } from "./types"
import { FebBoxClient } from "./util"

function fileToFileItem(f: FebBoxFile): FileItem {
  const isDir = f.is_dir === 1
  // Go fileToObj(): Modified = file_update_time, Ctime = file_create_time (unix seconds)
  const modTs = (f.file_update_time || f.add_time || 0) * 1000
  const createdTs = (f.file_create_time || 0) * 1000
  return {
    name: f.file_name,
    size: f.file_size || 0,
    is_dir: isDir,
    modified:
      modTs > 0 ? new Date(modTs).toISOString() : new Date().toISOString(),
    created: createdTs > 0 ? new Date(createdTs).toISOString() : undefined,
    sign: String(f.fid ?? ""),
    type: calcFileType(f.file_name || "", isDir),
    thumb: f.thumb || "",
    raw_url: "",
  }
}

export class FebBoxDriver implements StorageDriver {
  private client: FebBoxClient
  /** physical path (name-based) → folder id cache (quark resolveFileId pattern) */
  private pathFileIdCache = new Map<string, string>()

  constructor(
    addition: FebBoxAddition,
    onTokenRefresh?: (tokens: {
      access_token: string
      refresh_token: string
    }) => void,
  ) {
    this.client = new FebBoxClient(addition, onTokenRefresh)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFileId(physicalPath)
    const files = await this.client.getFilesList(folderId)
    // Go Config().LocalSort = false — the API sorts server-side via sort_rule
    return files.map(fileToFileItem)
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
    const files = await this.client.getFilesList(parentId)
    const file = files.find(
      (f) => String(f.fid) === fileId || f.file_name === name,
    )

    if (file) {
      const item = fileToFileItem(file)
      if (file.is_dir !== 1) {
        try {
          item.raw_url = await this.client.getDownloadLink(
            String(file.fid),
            this.client.getUserIp(),
          )
        } catch (e: any) {
          console.warn(
            `[FebBox] getDownloadLink warning for ${name}:`,
            e.message,
          )
        }
      }
      return item
    }

    // Fallback: probe by listing — if the id lists, it is a folder.
    try {
      await this.client.getFilesList(fileId)
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
      rawUrl = await this.client.getDownloadLink(
        fileId,
        this.client.getUserIp(),
      )
    } catch (e: any) {
      console.warn(`[FebBox] getDownloadLink warning for ${name}:`, e.message)
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

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new folder"
    const parentId = await this.resolveFileId("/" + parts.join("/"))
    await this.client.makeDir(parentId, name)
    this.pathFileIdCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(physicalPath)
    await this.client.rename(fileId, newName)
    this.pathFileIdCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fileId = await this.resolveFileId(physicalPath)
    await this.client.remove(fileId)
    this.pathFileIdCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(srcPhysical)
    const dstId = await this.resolveFileId(dstPhysical)
    await this.client.move(fileId, dstId)
    this.pathFileIdCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(srcPhysical)
    const dstId = await this.resolveFileId(dstPhysical)
    await this.client.copy(fileId, dstId)
    this.pathFileIdCache.clear()
  }

  async put(): Promise<void> {
    // Go FebBox.Put returns errs.NotImplement (Config().NoUpload = true)
    throw new Error(
      "[FebBox] Direct put not supported (Go driver does not implement upload)",
    )
  }

  /**
   * Resolve a name-based physical path to a FebBox folder/file id by walking
   * the tree level by level (quark resolveFileId pattern, Map cache).
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

      const items = await this.client.getFilesList(currentId)
      const target = items.find((f) => f.file_name === part)
      if (!target) {
        throw new Error(
          `[FebBox] Path '${part}' not found in folder '${currentId}'`,
        )
      }
      currentId = String(target.fid)
      this.pathFileIdCache.set(subPath, currentId)
    }

    return currentId
  }
}
