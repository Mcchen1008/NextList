// AliDoc (阿里云文档/钉钉文档) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/alidoc
//
// Browses a DingTalk docs (alidocs.dingtalk.com) knowledge base with the
// web cookie + root folder dentry UUID. Listing goes through
// /box/api/v2/dentry/list, downloads via /box/api/v2/file/download
// (pre-signed OSS url + Referer/UA headers).
// The Go driver implements no Getter — the fs layer falls back to listing
// the parent directory; the same strategy is used in get() here.
// Uploads are NOT ported: Go Put() uses an Aliyun OSS STS-signature
// single/multipart pipeline (see OpenList drivers/alidoc/upload.go).
// ID-based API: physical name paths are resolved to dentry UUIDs level by
// level (quark-style resolveFileId with a Map cache, cleared after writes).
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { AliDocAddition, AliDocDentry } from "./types"
import { AliDocClient, API_BASE, USER_AGENT } from "./util"

/** Go msToTime: <=0 → zero time (epoch proxy in TS) */
function msToIso(ms?: number): string {
  if (!ms || ms <= 0) return "1970-01-01T00:00:00.000Z"
  return new Date(ms).toISOString()
}

/** Go toObj() */
function dentryToFileItem(d: AliDocDentry): FileItem {
  const isDir = d.dentryType === "folder"
  return {
    name: d.name || "",
    size: d.fileSize || 0,
    is_dir: isDir,
    modified: msToIso(d.updatedTime),
    created: msToIso(d.createdTime),
    sign: d.dentryUuid || "",
    type: calcFileType(d.name || "", isDir),
  }
}

/** physical path ("/a/b") → parent physical path ("/a") */
function parentOf(physicalPath: string): string {
  const parts = (physicalPath || "/").split("/").filter(Boolean)
  parts.pop()
  return "/" + parts.join("/")
}

export class AliDocDriver implements StorageDriver {
  private client: AliDocClient
  /** physical path → dentry UUID (invalidated after every write) */
  private pathIdCache = new Map<string, string>()

  constructor(addition: AliDocAddition) {
    this.client = new AliDocClient(addition)
  }

  /** Go Init(): require cookie + root folder id, then checkCookie() */
  async init(): Promise<void> {
    if (!this.client.getCookie()) {
      throw new Error("[AliDoc] cookie is empty")
    }
    if (!this.client.getRootFolderId()) {
      throw new Error("[AliDoc] root folder id is empty")
    }
    await this.client.checkCookie()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFileId(physicalPath)
    const entries = await this.client.list(folderId)
    const items: FileItem[] = []
    for (const entry of entries) {
      // Go List(): skip entries without dentryUuid or name
      if (!(entry.dentryUuid || "").trim() || !(entry.name || "").trim()) {
        continue
      }
      items.push(dentryToFileItem(entry))
    }
    // Go Config().LocalSort = true
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = (physicalPath || "/").split("/").filter(Boolean)
    if (parts.length === 0) {
      // storage root
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.client.getRootFolderId(),
        type: 1,
        raw_url: "",
      }
    }
    const name = parts[parts.length - 1]

    // Go has no Getter: list the parent directory and match by name
    const parentId = await this.resolveFileId(parentOf(physicalPath))
    const children = await this.client.list(parentId)
    const found = children.find(
      (c) => (c.name || "") === name && (c.dentryUuid || "").trim() !== "",
    )
    if (!found) {
      throw new Error(`[AliDoc] failed to get obj: ${physicalPath} not found`)
    }

    const item = dentryToFileItem(found)
    if (found.dentryType !== "folder") {
      // Go Link(): pre-signed OSS url + User-Agent/Referer headers
      try {
        item.raw_url = await this.client.download(found.dentryUuid!)
        item.raw_url_headers = {
          "User-Agent": USER_AGENT,
          Referer: API_BASE + "/",
        }
      } catch (e) {
        console.warn(
          `[AliDoc] getDownloadUrl for ${name}: ${(e as Error).message}`,
        )
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = (physicalPath || "/").split("/").filter(Boolean)
    const name = parts.pop()
    if (!name) {
      throw new Error("[AliDoc] mkdir: empty directory name")
    }
    const parentId = await this.resolveFileId("/" + parts.join("/"))
    await this.client.makeDir(parentId, name)
    this.pathIdCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const dentryUuid = await this.resolveFileId(physicalPath)
    await this.client.rename(dentryUuid, newName)
    this.pathIdCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const dentryUuid = await this.resolveFileId(physicalPath)
    await this.client.remove(dentryUuid)
    this.pathIdCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const srcId = await this.resolveFileId(srcPhysical)
    const dstParentId = await this.resolveFileId(parentOf(dstPhysical))
    await this.client.move(srcId, dstParentId)
    this.pathIdCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const srcId = await this.resolveFileId(srcPhysical)
    const dstParentId = await this.resolveFileId(parentOf(dstPhysical))
    await this.client.copy(srcId, dstParentId)
    this.pathIdCache.clear()
  }

  async put(): Promise<void> {
    // Go Put(): getUploadInfo (STS signature) → Aliyun OSS single/multipart
    // upload → commitUpload — not portable without the OSS SDK pipeline.
    throw new Error(
      "[AliDoc] Direct put not supported (Go uploads via Aliyun OSS STS-signature single/multipart pipeline, see OpenList drivers/alidoc/upload.go)",
    )
  }

  /**
   * Resolve a physical name path to its dentry UUID by walking down from
   * root_folder_id (quark-style; cached per path segment).
   */
  private async resolveFileId(physicalPath: string): Promise<string> {
    const parts = (physicalPath || "/").split("/").filter(Boolean)
    if (parts.length === 0) return this.client.getRootFolderId()
    const clean = parts.join("/")
    if (this.pathIdCache.has(clean)) {
      return this.pathIdCache.get(clean)!
    }

    let currentId = this.client.getRootFolderId()
    for (let i = 0; i < parts.length; i++) {
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathIdCache.has(subPath)) {
        currentId = this.pathIdCache.get(subPath)!
        continue
      }
      const children = await this.client.list(currentId)
      const found = children.find((c) => (c.name || "") === parts[i])
      if (!found || !(found.dentryUuid || "").trim()) {
        throw new Error(`[AliDoc] failed to get obj: /${subPath} not found`)
      }
      currentId = found.dentryUuid!
      this.pathIdCache.set(subPath, currentId)
    }
    return currentId
  }
}
