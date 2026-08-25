// Dropbox driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/dropbox
//
// Path-based API: physical paths (root_folder_path + virtual rel path) map
// directly onto Dropbox paths — "" is the Dropbox root, everything else is
// "/"-prefixed. Write ops resolve the source entry by listing its parent so
// they can pass the file id as from_path/path (the Go driver uses
// obj.GetID()), with a path → entry cache cleared after every write.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { DropboxAddition, DropboxFile } from "./types"
import { DropboxClient } from "./util"

/** Normalize a NextList physical path to a Dropbox path ("" = root) */
function toDropboxPath(physicalPath: string): string {
  const parts = String(physicalPath || "")
    .split("/")
    .filter(Boolean)
  return parts.length ? "/" + parts.join("/") : ""
}

/** Parent Dropbox path ("/a/b" → "/a", "/a" → "") */
function dropboxParent(dbPath: string): string {
  const parts = dbPath.split("/").filter(Boolean)
  parts.pop()
  return parts.length ? "/" + parts.join("/") : ""
}

function parseIsoTime(s?: string): string {
  if (!s) return new Date(0).toISOString()
  const t = new Date(s)
  return isNaN(t.getTime()) ? new Date(0).toISOString() : t.toISOString()
}

/** Go types.go fileToObj() */
function dropboxFileToFileItem(f: DropboxFile): FileItem {
  const isDir = f[".tag"] === "folder"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: parseIsoTime(f.server_modified),
    sign: f.id || "",
    type: calcFileType(f.name, isDir),
    thumb: "",
    raw_url: "",
  }
}

export class DropboxDriver implements StorageDriver {
  private client: DropboxClient
  private addition: DropboxAddition
  /** Dropbox path → entry cache (cleared after every write) */
  private fileCache = new Map<string, DropboxFile>()

  constructor(
    addition: DropboxAddition,
    onTokenRefresh?: (
      accessToken: string,
      refreshToken: string,
    ) => void | Promise<void>,
  ) {
    this.addition = addition
    this.client = new DropboxClient(addition, onTokenRefresh)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.getFiles(toDropboxPath(physicalPath))
    for (const f of files) {
      if (f.path_display) this.fileCache.set(f.path_display, f)
    }
    const items = files.map(dropboxFileToFileItem)
    // Go Config().LocalSort is false (AList sorts in its server layer);
    // NextList has no server-side sort, so sort locally for a deterministic
    // order.
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const dbPath = toDropboxPath(physicalPath)
    const parts = dbPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"

    const file = await this.resolveFile(physicalPath)
    if (!file) {
      // storage root
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

    const item = dropboxFileToFileItem(file)
    if (file[".tag"] !== "folder") {
      // Go driver.go Link(): temporary link fetched per request (Go marks it
      // expired after 1h); it needs no extra headers.
      try {
        item.raw_url = await this.client.getTemporaryLink(
          file.path_display || dbPath,
        )
      } catch (e: any) {
        console.warn("[Dropbox] get temporary link:", e?.message || e)
      }
    }
    return item
  }

  /** Resolve a physical path to its Dropbox entry (null = storage root) */
  private async resolveFile(physicalPath: string): Promise<DropboxFile | null> {
    const dbPath = toDropboxPath(physicalPath)
    if (!dbPath) return null
    const cached = this.fileCache.get(dbPath)
    if (cached) return cached

    const parts = dbPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const entries = await this.client.getFiles(dropboxParent(dbPath))
    for (const f of entries) {
      if (f.path_display) this.fileCache.set(f.path_display, f)
    }
    const file = entries.find((f) => f.name === name)
    if (!file) {
      throw new Error(`[Dropbox] file not found: ${physicalPath}`)
    }
    return file
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    // physicalPath already is parent + dirName
    // (Go: parentDir.GetPath() + "/" + dirName)
    await this.client.makeDir(toDropboxPath(physicalPath))
    this.fileCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const dbPath = toDropboxPath(physicalPath)
    const file = await this.resolveFile(physicalPath)
    if (!file) {
      throw new Error(`[Dropbox] file not found: ${physicalPath}`)
    }
    // Go: toPath = path[:len(path)-len(fileName)] + newName
    const parent = dropboxParent(dbPath)
    const toPath = (parent ? parent + "/" : "/") + newName
    await this.client.move(file.id || dbPath, toPath)
    this.fileCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const dbPath = toDropboxPath(physicalPath)
    const file = await this.resolveFile(physicalPath)
    if (!file) {
      throw new Error(`[Dropbox] file not found: ${physicalPath}`)
    }
    // Go Remove(): path = obj.GetID() (Dropbox accepts ids for "path" args)
    await this.client.remove(file.id || dbPath)
    this.fileCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const file = await this.resolveFile(srcPhysical)
    if (!file) {
      throw new Error(`[Dropbox] file not found: ${srcPhysical}`)
    }
    // dstPhysical already is dstDir + name
    // (Go: dstDir.GetPath() + "/" + srcObj.GetName())
    await this.client.move(
      file.id || toDropboxPath(srcPhysical),
      toDropboxPath(dstPhysical),
    )
    this.fileCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const file = await this.resolveFile(srcPhysical)
    if (!file) {
      throw new Error(`[Dropbox] file not found: ${srcPhysical}`)
    }
    await this.client.copy(
      file.id || toDropboxPath(srcPhysical),
      toDropboxPath(dstPhysical),
    )
    this.fileCache.clear()
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    // physicalPath already is dstDir + filename
    // (Go: dstDir.GetPath() + "/" + stream.GetName()).
    // Go Put(): upload session (start → 20MB append_v2 → finish), portable
    // with a plain buffer body.
    const body = new Uint8Array(content)
    await this.client.uploadFile(toDropboxPath(physicalPath), body)
    this.fileCache.clear()
  }
}
