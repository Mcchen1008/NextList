// Degoo driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/degoo
//
// Implemented: init (login/token refresh + device root detection) / list /
// get (link) / mkdir (setUploadFile3 with folder checksum) / rename / move /
// remove. Copy throws (Go: errs.NotImplement). Put throws — the Go driver
// uploads via a signed S3 POST-policy multipart pipeline (getBucketWriteAuth4
// → uploadS3 → setUploadFile3, see drivers/degoo/upload.go) which is not
// ported here.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { DegooAddition, DegooFileItem } from "./types"
import { DegooClient, DegooPersistState, humanReadableTimes } from "./util"

function fileItemToEntry(s: DegooFileItem): FileItem {
  const isDir = s.Category === 2 || s.Category === 1 || s.Category === 10
  const size = parseInt(s.Size || "0", 10) || 0
  const { created, modified } = humanReadableTimes(
    s.CreationTime || "",
    s.LastModificationTime || "",
    s.LastUploadTime || "",
  )
  return {
    name: s.Name,
    size,
    is_dir: isDir,
    modified,
    created,
    sign: s.ID || "",
    type: calcFileType(s.Name || "", isDir),
    raw_url: "",
  }
}

export class DegooDriver implements StorageDriver {
  private client: DegooClient
  /** physical path (name-based) → file/folder id cache (quark resolveFileId pattern) */
  private pathIdCache = new Map<string, string>()

  constructor(
    addition: DegooAddition,
    onStateUpdate?: (state: DegooPersistState) => void,
  ) {
    this.client = new DegooClient(addition, onStateUpdate)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId = await this.resolveFileId(physicalPath)
    const items = await this.client.getAllFileChildren5(parentId)
    // Go Config().LocalSort = true
    return sortFileItems(items.map(fileItemToEntry), "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (!parts.length) {
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
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveFileId(parentPath)
    const items = await this.client.getAllFileChildren5(parentId)
    const item = items.find((s) => s.Name === name)
    if (!item) {
      throw new Error(`[Degoo] failed to get '${name}'`)
    }
    const entry = fileItemToEntry(item)
    const isDir =
      item.Category === 2 || item.Category === 1 || item.Category === 10
    if (!isDir) {
      try {
        // Go Link(): getOverlay4 returns the download url
        const overlay = await this.client.getOverlay4(item.ID)
        entry.raw_url = overlay.URL || ""
      } catch (e: any) {
        console.warn(
          `[Degoo] getOverlay4 warning for ${name}: ${e?.message || e}`,
        )
      }
    }
    return entry
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const dirName = parts.pop()
    if (!dirName) throw new Error("[Degoo] mkdir: empty directory name")
    const parentId = await this.resolveFileId("/" + parts.join("/"))
    await this.client.makeDir(parentId, dirName)
    this.pathIdCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const id = await this.resolveFileId(physicalPath)
    await this.client.rename(id, newName)
    this.pathIdCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const parentId = await this.resolveFileId(physicalPath)
    const items = await this.client.getAllFileChildren5(parentId)
    for (const name of names) {
      const item = items.find((s) => s.Name === name)
      if (!item) {
        throw new Error(`[Degoo] remove: '${name}' not found`)
      }
      await this.client.remove(item.ID)
    }
    this.pathIdCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcParentId = await this.resolveFileId(srcPhys)
    const dstParentId = await this.resolveFileId(dstPhys)
    const items = await this.client.getAllFileChildren5(srcParentId)
    const ids: string[] = []
    for (const name of names) {
      const item = items.find((s) => s.Name === name)
      if (!item) {
        throw new Error(`[Degoo] move: '${name}' not found`)
      }
      ids.push(item.ID)
    }
    await this.client.move(ids, dstParentId)
    this.pathIdCache.clear()
  }

  async copy(): Promise<void> {
    // Go: errs.NotImplement — the Degoo API does not support direct copy
    throw new Error("[Degoo] copy not supported (Degoo API has no copy)")
  }

  async put(): Promise<void> {
    // Go drivers/degoo/upload.go implements upload via a signed S3 POST-policy
    // pipeline (custom SHA1-seeded checksum → getBucketWriteAuth4 → multipart
    // POST upload to S3 → setUploadFile3 metadata registration), which is not
    // ported to this TS driver.
    throw new Error(
      "[Degoo] Direct put not supported (requires Degoo S3 POST-policy multipart upload pipeline)",
    )
  }

  /**
   * Resolve a name-based physical path to a Degoo file id by walking the tree
   * level by level (quark resolveFileId pattern, Map cache). The root comes
   * from the root_folder_id config, auto-detected from the device list on init
   * when left at "0".
   */
  private async resolveFileId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return this.client.getRootFolderId()
    if (this.pathIdCache.has(clean)) return this.pathIdCache.get(clean)!

    const parts = clean.split("/")
    let currentId = this.client.getRootFolderId()

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathIdCache.has(subPath)) {
        currentId = this.pathIdCache.get(subPath)!
        continue
      }
      const items = await this.client.getAllFileChildren5(currentId)
      const target = items.find((s) => s.Name === part)
      if (!target) {
        throw new Error(
          `[Degoo] path '${part}' not found in folder '${currentId}'`,
        )
      }
      currentId = target.ID
      this.pathIdCache.set(subPath, currentId)
    }
    return currentId
  }
}
