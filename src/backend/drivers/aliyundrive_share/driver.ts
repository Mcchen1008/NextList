// AliyundriveShare (阿里云盘分享) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/aliyundrive_share
//
// Browses the files of an alipan (Aliyun Drive) share link: an aliyun account
// refresh_token is exchanged for an access_token, then a share_token is
// obtained for the share_id (with optional share_pwd). Listing uses the
// /adrive/v3/file/list share API, downloads go through
// /v2/file/get_share_link_download_url (Referer required).
// Read-only: the Go driver sets NoUpload and implements no write methods.
// ID-based API: physical paths (name paths under root_folder_id) are resolved
// to share file ids level by level, quark-style (see resolveFile).
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { AliyundriveShareAddition, ShareFile } from "./types"
import { AliyundriveShareClient } from "./util"

function shareFileToFileItem(f: ShareFile): FileItem {
  const isDir = f.type === "folder"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    // Go fileToObj: Modified = UpdatedAt, Ctime = CreatedAt
    modified: f.updated_at || f.created_at || new Date().toISOString(),
    created: f.created_at || undefined,
    sign: f.file_id || "",
    type: calcFileType(f.name, isDir),
    thumb: f.thumbnail || "",
    raw_url: "",
  }
}

export class AliyundriveShareDriver implements StorageDriver {
  private client: AliyundriveShareClient
  /** physical path → resolved share file cache (read-only driver, no invalidation) */
  private pathFileCache = new Map<string, ShareFile>()

  constructor(
    addition: AliyundriveShareAddition,
    onTokenRefresh?: (accessToken: string, refreshToken: string) => void,
  ) {
    this.client = new AliyundriveShareClient(addition, onTokenRefresh)
  }

  /** Go Init(): refreshToken + getShareToken (failures propagate) */
  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const dir = await this.resolveFile(physicalPath)
    const parentId = dir ? dir.file_id : this.client.getRootFolderId()
    const files = await this.client.getFiles(parentId)
    // Go Config().LocalSort = false — order_by / order_direction are applied
    // server-side by the alipan API, results keep the API order.
    return files.map(shareFileToFileItem)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = (physicalPath || "/").split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"

    const file = await this.resolveFile(physicalPath)
    if (!file) {
      // storage root (share root / root_folder_id)
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

    const item = shareFileToFileItem(file)
    if (file.type !== "folder") {
      // Go Link(): get_share_link_download_url + Referer header
      try {
        const link = await this.client.getDownloadUrl(file.file_id)
        item.raw_url = link.url
        item.raw_url_headers = link.headers
      } catch (e: any) {
        console.warn(`[AliyundriveShare] getDownloadUrl: ${e.message}`)
      }
    }
    return item
  }

  /**
   * Go Other(): doc_preview / video_preview extended operations, dispatched
   * via POST /fs/other with { method, path, physicalPath }.
   */
  async other(method: string, params: any): Promise<any> {
    switch (method) {
      case "doc_preview":
      case "video_preview": {
        let fileId = ""
        const physicalPath = params?.physicalPath || params?.path || ""
        if (physicalPath) {
          const file = await this.resolveFile(physicalPath)
          fileId = file ? file.file_id : ""
        }
        if (!fileId) {
          fileId = String(params?.file_id || "")
        }
        if (!fileId) {
          throw new Error(
            `[AliyundriveShare] ${method}: file_id required (pass physicalPath)`,
          )
        }
        return method === "doc_preview"
          ? this.client.docPreview(fileId)
          : this.client.videoPreview(fileId)
      }
      default:
        throw new Error(
          `[AliyundriveShare] unsupported other method: ${method}`,
        )
    }
  }

  async mkdir(): Promise<void> {
    // Go: NoUpload = true, no write methods on a share link
    throw new Error("[AliyundriveShare] read-only driver")
  }

  async rename(): Promise<void> {
    throw new Error("[AliyundriveShare] read-only driver")
  }

  async remove(): Promise<void> {
    throw new Error("[AliyundriveShare] read-only driver")
  }

  async move(): Promise<void> {
    throw new Error("[AliyundriveShare] read-only driver")
  }

  async copy(): Promise<void> {
    throw new Error("[AliyundriveShare] read-only driver")
  }

  async put(): Promise<void> {
    // Go: NoUpload = true — shares cannot be written
    throw new Error("[AliyundriveShare] read-only driver")
  }

  /** Resolve a physical path to its share file (null = storage root). */
  private async resolveFile(physicalPath: string): Promise<ShareFile | null> {
    const clean = (physicalPath || "/").split("/").filter(Boolean).join("/")
    if (!clean) return null
    if (this.pathFileCache.has(clean)) {
      return this.pathFileCache.get(clean)!
    }

    const parts = clean.split("/")
    let current: ShareFile | null = null
    for (let i = 0; i < parts.length; i++) {
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathFileCache.has(subPath)) {
        current = this.pathFileCache.get(subPath)!
        continue
      }
      const parentId = current ? current.file_id : this.client.getRootFolderId()
      const children = await this.client.getFiles(parentId)
      const found = children.find((f) => f.name === parts[i])
      if (!found) {
        throw new Error(
          `[AliyundriveShare] failed to get obj: /${subPath} not found`,
        )
      }
      this.pathFileCache.set(subPath, found)
      current = found
    }
    return current
  }
}
