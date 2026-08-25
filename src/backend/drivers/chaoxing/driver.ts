// ChaoXing (超星学习通小组网盘) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/chaoxing
//
// Go Config(): { Name: "ChaoXingGroupDrive", OnlyProxy: true, DefaultRoot: "-1",
// NoOverwriteUpload: true } — links require Cookie/Referer/UA headers, so
// downloads must go through the proxy route.
// The Go driver's Copy() returns errs.NotImplement → copy() throws here too.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { ChaoxingAddition, ChaoxingEntry, ChaoxingFile } from "./types"
import { ChaoxingClient, toInt, parseChaoxingTime } from "./util"

/** Go fileToObj() → ChaoxingEntry (id: dir "<id>", file "<id>$<fileId>") */
export function fileToEntry(f: ChaoxingFile): ChaoxingEntry {
  if (f.content && (f.content.folderName || "").length > 0) {
    return {
      name: f.content.folderName,
      id: String(f.id),
      isDir: true,
      size: 0,
      modified: toInt(f.inserttime),
    }
  }
  return {
    name: f.content?.name || "",
    id: `${f.id}$${f.content?.fileId || ""}`,
    isDir: false,
    size: toInt(f.content?.size),
    modified: parseChaoxingTime(f.content?.uploadDate),
  }
}

function entryToFileItem(e: ChaoxingEntry): FileItem {
  const modified =
    e.modified > 0
      ? new Date(e.modified).toISOString()
      : new Date().toISOString()
  return {
    name: e.name,
    size: e.size,
    is_dir: e.isDir,
    modified,
    sign: e.id,
    type: calcFileType(e.name, e.isDir),
  }
}

export class ChaoxingDriver implements StorageDriver {
  private client: ChaoxingClient
  private addition: ChaoxingAddition
  /** physical dir path (clean, no leading slash) → entries cache */
  private entriesCache = new Map<string, ChaoxingEntry[]>()

  constructor(
    addition: ChaoxingAddition,
    onCookieRefresh?: (cookie: string) => void,
  ) {
    this.addition = addition
    this.client = new ChaoxingClient(addition, onCookieRefresh)
  }

  async init(): Promise<void> {
    // Go Init() always re-logins and keeps the old cookie on failure;
    // a 12h cron keeps it fresh — mirrored by the lazy TTL refresh inside
    // ensureCookie() on every operation below.
    await this.client.ensureCookie(true)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    await this.client.ensureCookie()
    const entries = await this.dirEntries(physicalPath)
    const items = entries.map(entryToFileItem)
    // Go LocalSort is false (AList sorts server-side); NextList has no
    // server-side sorting, so sort locally for deterministic order.
    return sortFileItems(
      items,
      this.addition.order_by || "name",
      this.addition.order_desc ? "desc" : "asc",
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    await this.client.ensureCookie()
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.client.getRootId(),
        type: 1,
        raw_url: "",
      }
    }
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const parentEntries = await this.dirEntries(parentPath)
    const entry = parentEntries.find((e) => e.name === name)
    if (!entry) {
      throw new Error(`[ChaoXing] object not found: ${physicalPath}`)
    }
    const item = entryToFileItem(entry)
    if (!entry.isDir) {
      // Go Link(): fileId part of "<id>$<fileId>"
      const fileId = entry.id.split("$")[1] || ""
      if (fileId) {
        try {
          item.raw_url = await this.client.getDownloadUrl(fileId)
          item.raw_url_headers = this.client.getDownloadHeaders()
        } catch (e: any) {
          console.warn(`[ChaoXing] getDownloadUrl for ${name}:`, e.message)
        }
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.ensureCookie()
    const parts = physicalPath.split("/").filter(Boolean)
    const dirName = parts.pop() || "new_folder"
    const parentId = await this.resolveDirId("/" + parts.join("/"))
    await this.client.makeDir(parentId, dirName)
    this.entriesCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await this.client.ensureCookie()
    const entry = await this.resolveEntry(physicalPath)
    if (!entry.isDir) {
      // Go Rename(): "此网盘不支持修改文件名"
      throw new Error("[ChaoXing] 此网盘不支持修改文件名")
    }
    await this.client.renameFolder(entry.id, newName)
    this.entriesCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    await this.client.ensureCookie()
    const entry = await this.resolveEntry(physicalPath)
    await this.client.remove(entry.id, entry.isDir)
    this.entriesCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    await this.client.ensureCookie()
    const entry = await this.resolveEntry(srcPhysical)
    // dstPhysical points at the (not yet existing) destination item; its
    // parent directory is the move target (Go: dstDir.GetID())
    const dstParts = dstPhysical.split("/").filter(Boolean)
    dstParts.pop()
    const dstDirId = await this.resolveDirId("/" + dstParts.join("/"))
    await this.client.move(entry.id, entry.isDir, dstDirId)
    this.entriesCache.clear()
  }

  async copy(): Promise<void> {
    // Go Copy(): return errs.NotImplement
    throw new Error(
      "[ChaoXing] copy not supported (Go driver returns NotImplement)",
    )
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    await this.client.ensureCookie()
    const parts = physicalPath.split("/").filter(Boolean)
    const fileName = parts.pop()
    if (!fileName) {
      throw new Error("[ChaoXing] put: empty file name")
    }
    const parentId = await this.resolveDirId("/" + parts.join("/"))
    await this.client.upload(
      parentId,
      fileName,
      new Uint8Array(content) as Uint8Array<ArrayBuffer>,
    )
    this.entriesCache.clear()
  }

  /** Resolve a physical path to its entry (file or dir). */
  private async resolveEntry(physicalPath: string): Promise<ChaoxingEntry> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) {
      return {
        name: "root",
        id: this.client.getRootId(),
        isDir: true,
        size: 0,
        modified: 0,
      }
    }
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    const parentEntries = await this.dirEntries(parentPath)
    const entry = parentEntries.find((e) => e.name === name)
    if (!entry) {
      throw new Error(`[ChaoXing] object not found: ${physicalPath}`)
    }
    return entry
  }

  /** Resolve a physical path to a folder id (quark-style walk + cache). */
  private async resolveDirId(physicalPath: string): Promise<string> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) return this.client.getRootId()
    const entry = await this.resolveEntry(physicalPath)
    if (!entry.isDir) {
      throw new Error(`[ChaoXing] not a folder: ${physicalPath}`)
    }
    return entry.id
  }

  /**
   * Entries of the directory at physicalPath, cached per path. Each level is
   * fetched with the parent's id (ID-per-level resolution like quark's
   * resolveFileId) and the walk populates the cache along the way.
   */
  private async dirEntries(physicalPath: string): Promise<ChaoxingEntry[]> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    const cached = this.entriesCache.get(clean)
    if (cached) return cached

    let dirId: string
    if (clean === "") {
      dirId = this.client.getRootId()
    } else {
      const parts = clean.split("/")
      const name = parts[parts.length - 1]
      const parentEntries = await this.dirEntries(parts.slice(0, -1).join("/"))
      const self = parentEntries.find((e) => e.name === name && e.isDir)
      if (!self) {
        throw new Error(`[ChaoXing] folder not found: ${clean}`)
      }
      dirId = self.id
    }
    const files = await this.client.getFiles(dirId)
    const entries = files.map(fileToEntry).filter((e) => e.name !== "")
    this.entriesCache.set(clean, entries)
    return entries
  }
}
