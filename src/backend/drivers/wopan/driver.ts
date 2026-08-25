// WoPan (联通云盘) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/wopan
//
// ID-based API: physical paths (name paths under root_folder_path) are
// resolved to wopan ids level by level, quark-style (see resolveFile).
// Item navigation uses `file.id`; download links use `file.fid` (Go types.go
// Object keeps both). Server-side sorting honors addition.sort_rule.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { WopanAddition, WopanFile } from "./types"
import { WopanClient, parseWopanTime } from "./util"

function wopanFileToFileItem(f: WopanFile): FileItem {
  const isDir = f.type === 0
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: parseWopanTime(f.createTime),
    sign: f.id || "",
    type: calcFileType(f.name, isDir),
    thumb: f.thumbUrl || "",
    raw_url: "",
  }
}

export class WopanDriver implements StorageDriver {
  private client: WopanClient
  private addition: WopanAddition
  /** physical path → file object cache for id resolution */
  private pathFileCache = new Map<string, WopanFile>()

  constructor(
    addition: WopanAddition,
    onTokenRefresh?: (accessToken: string, refreshToken: string) => void,
  ) {
    this.addition = addition
    this.client = new WopanClient(addition, onTokenRefresh)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parent = await this.resolveFile(physicalPath)
    const parentId = parent ? parent.id : this.client.getRootFolderId()
    const files = await this.client.getAllFiles(parentId)
    const items = files.map(wopanFileToFileItem)
    // Server-side sort per addition.sort_rule (Go: no local sort)
    return items
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"

    const file = await this.resolveFile(physicalPath)
    if (!file) {
      // storage root
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.client.getRootFolderId(),
        type: 1,
        raw_url: "",
      }
    }

    const item = wopanFileToFileItem(file)
    if (file.type !== 0) {
      // Go Link(): download url is fetched by fid, not id
      try {
        item.raw_url = await this.client.getDownloadUrlV2([file.fid || ""])
      } catch (e: any) {
        console.warn(
          `[WoPan] getDownloadUrlV2 warning for ${name}:`,
          e?.message,
        )
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const dirName = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    const parent = await this.resolveFile(parentPath)
    const parentId = parent ? parent.id : this.client.getRootFolderId()

    // Go MakeDir: fall back to the default family id when none configured
    let familyID = this.client.getFamilyId()
    if (!familyID) familyID = this.client.defaultFamilyID

    await this.client.createDirectory(
      this.client.getSpaceType(),
      parentId,
      dirName,
      familyID,
    )
    this.pathFileCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const file = await this.resolveRequired(physicalPath)
    const type = file.type === 0 ? 0 : 1 // Go: 1 file, 0 directory
    await this.client.renameFileOrDirectory(
      this.client.getSpaceType(),
      type,
      file.id,
      newName,
      this.client.getFamilyId(),
    )
    this.pathFileCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const file = await this.resolveRequired(physicalPath)
    const dirList: string[] = []
    const fileList: string[] = []
    if (file.type === 0) {
      dirList.push(file.id)
    } else {
      fileList.push(file.id)
    }
    await this.client.deleteFile(this.client.getSpaceType(), dirList, fileList)
    this.pathFileCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const file = await this.resolveRequired(srcPhysical)
    // dstPhysical points at the destination item path (dstDir + name) —
    // resolve its parent directory instead
    const dstParts = dstPhysical.split("/").filter(Boolean)
    dstParts.pop()
    const dstParent = await this.resolveFile("/" + dstParts.join("/"))
    const targetDirId = dstParent ? dstParent.id : this.client.getRootFolderId()

    const dirList: string[] = []
    const fileList: string[] = []
    if (file.type === 0) {
      dirList.push(file.id)
    } else {
      fileList.push(file.id)
    }
    const spaceType = this.client.getSpaceType()
    const familyID = this.client.getFamilyId()
    await this.client.moveFile(
      dirList,
      fileList,
      targetDirId,
      spaceType,
      spaceType,
      familyID,
      familyID,
    )
    this.pathFileCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const file = await this.resolveRequired(srcPhysical)
    const dstParts = dstPhysical.split("/").filter(Boolean)
    dstParts.pop()
    const dstParent = await this.resolveFile("/" + dstParts.join("/"))
    const targetDirId = dstParent ? dstParent.id : this.client.getRootFolderId()

    const dirList: string[] = []
    const fileList: string[] = []
    if (file.type === 0) {
      dirList.push(file.id)
    } else {
      fileList.push(file.id)
    }
    const spaceType = this.client.getSpaceType()
    const familyID = this.client.getFamilyId()
    await this.client.copyFile(
      dirList,
      fileList,
      targetDirId,
      spaceType,
      spaceType,
      familyID,
      familyID,
    )
    this.pathFileCache.clear()
  }

  async put(
    _virtualPath: string,
    _physicalPath: string,
    _content: Buffer,
  ): Promise<void> {
    // Go Put uses wopan Upload2C: zone server (tjupload.pan.wo.cn) multipart
    // upload with 8MB parts — not portable to the stateless proxy pipeline.
    throw new Error(
      "[WoPan] Direct put not supported (Go uses Upload2C zone-server multipart upload, e.g. https://tjupload.pan.wo.cn)",
    )
  }

  /** Resolve a physical path to its file object; null for the storage root. */
  private async resolveFile(physicalPath: string): Promise<WopanFile | null> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return null
    if (this.pathFileCache.has(clean)) return this.pathFileCache.get(clean)!

    const parts = clean.split("/")
    let parentId = this.client.getRootFolderId()
    let found: WopanFile | null = null

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathFileCache.has(subPath)) {
        const cached = this.pathFileCache.get(subPath)!
        parentId = cached.id
        found = cached
        continue
      }
      const files = await this.client.getAllFiles(parentId)
      const target = files.find((f) => f.name === part)
      if (!target) {
        throw new Error(
          `[WoPan] path '${part}' not found in folder '${parentId}'`,
        )
      }
      this.pathFileCache.set(subPath, target)
      parentId = target.id
      found = target
    }
    return found
  }

  private async resolveRequired(physicalPath: string): Promise<WopanFile> {
    const file = await this.resolveFile(physicalPath)
    if (!file) {
      throw new Error(
        `[WoPan] cannot operate on storage root '${physicalPath}'`,
      )
    }
    return file
  }
}
