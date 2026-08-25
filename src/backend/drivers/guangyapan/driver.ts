// GuangYaPan (光速盘) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/guangyapan
//
// Scope notes:
// - offline.go (offline download: resolve/create/list/delete tasks) is NOT
//   ported — NextList has no offline-download plumbing for this driver.
// - Go Put() uploads via a temp OSS STS token from
//   /nd.bizuserres.s/v1/get_res_center_token followed by an aliyun-oss-go-sdk
//   multipart upload — not portable to the stateless fetch environment, see
//   put() below.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { GuangYaPanAddition, GuangYaPanFile } from "./types"
import { GuangYaPanClient, unixToIso } from "./util"

function fileToFileItem(f: GuangYaPanFile): FileItem {
  const isDir = f.resType === 2
  return {
    name: f.fileName,
    size: f.fileSize || 0,
    is_dir: isDir,
    modified: unixToIso(f.utime) || new Date().toISOString(),
    sign: f.fileId || "",
    type: calcFileType(f.fileName, isDir),
    raw_url: "",
  }
}

export class GuangYaPanDriver implements StorageDriver {
  private client: GuangYaPanClient
  /** cache: name path (relative to the mounted root folder) → file id */
  private pathIdCache = new Map<string, string>()

  constructor(addition: GuangYaPanAddition) {
    this.client = new GuangYaPanClient(addition)
  }

  async init(): Promise<void> {
    // client.init() resolves the root folder on the success paths; when only
    // send_code=true is set (SMS stage 1) init succeeds without tokens and the
    // root folder is resolved lazily by resolveFileId().
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFileId(physicalPath)
    const files = await this.client.getFiles(folderId)
    // server-side ordering via addition.order_by / sort_type API params
    // (Go Config has no LocalSort)
    return files.map(fileToFileItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const fileId = await this.resolveFileId(physicalPath)
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const parentId = await this.resolveFileId(parentPath)

    const files = await this.client.getFiles(parentId)
    const file = files.find((f) => f.fileId === fileId)

    let rawUrl = ""
    if (file && file.resType !== 2) {
      try {
        rawUrl = await this.client.getDownloadUrl(fileId)
      } catch (e: any) {
        console.warn(
          `[GuangYaPan] getDownloadUrl warning for ${name}:`,
          e.message,
        )
      }
    }

    if (file) {
      const item = fileToFileItem(file)
      item.raw_url = rawUrl
      return item
    }

    // Fallback: probe the path as a folder (e.g. storage root itself).
    try {
      await this.client.getFiles(fileId)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: fileId,
        type: 1,
        raw_url: "",
      }
    } catch {
      // fall through
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
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveFileId(parentPath)
    await this.client.makeDir(parentId, name)
    this.pathIdCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(physicalPath)
    await this.client.rename(fileId, newName)
    this.pathIdCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fileId = await this.resolveFileId(physicalPath)
    await this.client.remove(fileId)
    this.pathIdCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(srcPhysical)
    // dstPhysical points at the destination *item* path — its parent is the
    // target folder.
    const dstParts = dstPhysical.split("/").filter(Boolean)
    dstParts.pop()
    const dstId = await this.resolveFileId("/" + dstParts.join("/"))
    await this.client.move(fileId, dstId)
    this.pathIdCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.resolveFileId(srcPhysical)
    const dstParts = dstPhysical.split("/").filter(Boolean)
    dstParts.pop()
    const dstId = await this.resolveFileId("/" + dstParts.join("/"))
    await this.client.copy(fileId, dstId)
    this.pathIdCache.clear()
  }

  async put(): Promise<void> {
    // Go Put(): fetches a temp STS upload token from
    // /nd.bizuserres.s/v1/get_res_center_token then performs an
    // aliyun-oss-go-sdk (multipart) upload of the object to the granted OSS
    // bucket and polls /file/get_info_by_task_id until the task completes.
    throw new Error(
      "[GuangYaPan] Direct put not supported (Go uploads via aliyun OSS STS token + multipart upload, not portable to a stateless fetch environment)",
    )
  }

  /**
   * ID 逐级解析: physicalPath is the virtual name path relative to the
   * mounted root folder (addition.root_path — a cloud-drive name path that is
   * resolved to its folder id once at init). Walk each segment below the root
   * folder id with a Map cache (quark-style).
   */
  private async resolveFileId(physicalPath: string): Promise<string> {
    await this.client.prepareRootFolder()
    const clean = (physicalPath || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .join("/")
    if (!clean) return this.client.getRootFolderId()
    if (this.pathIdCache.has(clean)) return this.pathIdCache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.client.getRootFolderId()
    for (let i = 0; i < parts.length; i++) {
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathIdCache.has(subPath)) {
        currentId = this.pathIdCache.get(subPath)!
        continue
      }
      const items = await this.client.getFiles(currentId)
      const target = items.find((f) => f.fileName === parts[i])
      if (!target) {
        throw new Error(
          `[GuangYaPan] Path '${parts[i]}' not found in folder '${currentId}'`,
        )
      }
      currentId = target.fileId
      this.pathIdCache.set(subPath, currentId)
    }
    return currentId
  }
}
