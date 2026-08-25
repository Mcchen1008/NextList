// Google Photo driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/google_photo
//
// Read-only driver: the Go driver returns errs.NotSupport for every write op
// and its config declares NoUpload=true, so mkdir/rename/move/copy/remove/put
// all throw here.
//
// ID-style API: the Go driver navigates with album/media ids ("root" is a
// pseudo id that yields the virtual folders all / albums / share_albums).
// NextList only hands us name paths, so ids are resolved level by level
// (quark / google_drive pattern) with a path → MediaItem cache.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { GooglePhotoAddition, MediaItem } from "./types"
import { GooglePhotoClient } from "./util"

/**
 * Go types.go fileToObj(): an item whose mediaMetadata is non-zero is a
 * media file (name = filename, modified = creationTime), otherwise it is an
 * album folder (name = title).
 */
function hasMediaMetadata(f: MediaItem): boolean {
  return !!f.mediaMetadata && Object.keys(f.mediaMetadata).length > 0
}

function mediaItemName(f: MediaItem): string {
  return hasMediaMetadata(f) ? f.filename || "" : f.title || ""
}

function parseIsoTime(s?: string): string {
  if (!s) return new Date(0).toISOString()
  const t = new Date(s)
  return isNaN(t.getTime()) ? new Date(0).toISOString() : t.toISOString()
}

function mediaItemToFileItem(f: MediaItem): FileItem {
  const isDir = !hasMediaMetadata(f)
  const name = mediaItemName(f) || f.id
  return {
    name,
    size: 0, // Google Photos Library API reports no sizes (Go: Size 0)
    is_dir: isDir,
    modified: parseIsoTime(f.mediaMetadata?.creationTime),
    sign: f.id || "",
    type: calcFileType(name, isDir),
    thumb: !isDir && f.baseUrl ? f.baseUrl + "=w100-h100-c" : "",
    raw_url: "",
  }
}

export class GooglePhotoDriver implements StorageDriver {
  private client: GooglePhotoClient
  private addition: GooglePhotoAddition
  /** physical name path → resolved MediaItem cache (quark pattern) */
  private itemCache = new Map<string, MediaItem>()

  constructor(addition: GooglePhotoAddition) {
    this.addition = addition
    this.client = new GooglePhotoClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const id = await this.resolveId(physicalPath)
    const files = await this.client.getFiles(id)
    const items = files.map(mediaItemToFileItem)
    // Go Config().LocalSort = true
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const item = await this.resolveItem(physicalPath)
    if (!item) {
      // storage root
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.client.getRootId(),
        type: 1,
        raw_url: "",
      }
    }
    const fileItem = mediaItemToFileItem(item)
    if (!fileItem.is_dir) {
      // Go driver.go Link(): fetch a fresh baseUrl (they expire) and append
      // "=d" for images / "=dv" for videos. The signed baseUrls need no
      // extra headers.
      try {
        fileItem.raw_url = await this.mediaLink(item.id)
      } catch (e: any) {
        console.warn("[GooglePhoto] get link:", e?.message || e)
      }
    }
    return fileItem
  }

  /** Go driver.go Link(): baseUrl + "=d" (image) / "=dv" (video) */
  private async mediaLink(id: string): Promise<string> {
    const f = await this.client.getMedia(id)
    const mime = f.mimeType || ""
    if (mime.includes("image/")) return (f.baseUrl || "") + "=d"
    if (mime.includes("video/")) return (f.baseUrl || "") + "=dv"
    return ""
  }

  /** Resolve a physical name path to a MediaItem (null = storage root) */
  private async resolveItem(physicalPath: string): Promise<MediaItem | null> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) return null
    const clean = parts.join("/")
    const cached = this.itemCache.get(clean)
    if (cached) return cached

    let currentId = this.client.getRootId()
    let current: MediaItem | null = null
    for (let i = 0; i < parts.length; i++) {
      const subPath = parts.slice(0, i + 1).join("/")
      const cachedSub = this.itemCache.get(subPath)
      if (cachedSub) {
        current = cachedSub
        currentId = cachedSub.id
        continue
      }
      const siblings = await this.client.getFiles(currentId)
      const target = siblings.find((s) => mediaItemName(s) === parts[i])
      if (!target) {
        throw new Error(`[GooglePhoto] path not found: /${clean}`)
      }
      current = target
      currentId = target.id
      this.itemCache.set(subPath, target)
    }
    return current
  }

  private async resolveId(physicalPath: string): Promise<string> {
    const item = await this.resolveItem(physicalPath)
    return item ? item.id : this.client.getRootId()
  }

  // ==== write ops: Go returns errs.NotSupport for all of them ====

  async mkdir(): Promise<void> {
    throw new Error(
      "[GooglePhoto] mkdir not supported (Google Photos API is read-only; Go driver returns errs.NotSupport)",
    )
  }

  async rename(): Promise<void> {
    throw new Error(
      "[GooglePhoto] rename not supported (Google Photos API is read-only; Go driver returns errs.NotSupport)",
    )
  }

  async remove(): Promise<void> {
    throw new Error(
      "[GooglePhoto] remove not supported (Google Photos API is read-only; Go driver returns errs.NotSupport)",
    )
  }

  async move(): Promise<void> {
    throw new Error(
      "[GooglePhoto] move not supported (Google Photos API is read-only; Go driver returns errs.NotSupport)",
    )
  }

  async copy(): Promise<void> {
    throw new Error(
      "[GooglePhoto] copy not supported (Google Photos API is read-only; Go driver returns errs.NotSupport)",
    )
  }

  async put(): Promise<void> {
    // Go Config().NoUpload = true — OpenList refuses uploads for this driver
    // even though driver.go carries a resumable-upload implementation
    // (X-Goog-Upload-* headers against /v1/uploads + mediaItems:batchCreate).
    // Read-only per porting task; not ported.
    throw new Error(
      "[GooglePhoto] Direct put not supported (Go marks NoUpload=true; upload would use the X-Goog-Upload resumable protocol on photoslibrary.googleapis.com/v1/uploads + mediaItems:batchCreate)",
    )
  }
}
