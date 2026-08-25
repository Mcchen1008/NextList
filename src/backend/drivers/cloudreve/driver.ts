// Cloudreve driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudreve
//
// Path-based API: physicalPath (root_folder_path + virtual rel path, e.g.
// "/a/b") maps 1:1 onto Cloudreve's directory paths. Write ops and the
// download link address objects by id — ids are resolved by listing the
// parent directory (Go passes obj.GetID() from a previous List; NextList
// only has name paths, so a path → object cache is filled during listings
// and cleared after every write, following the dropbox/quark porting pattern).
//
// Go Put() is fully ported: session creation via PUT /file/upload plus the
// local/remote/onedrive/s3 chunk pipelines (content is fully in memory here,
// so no stream sectioning is needed). Empty files go through POST /file/create.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { CloudreveAddition, CloudreveObject } from "./types"
import { CloudreveClient, CloudreveSrcBody, joinPath } from "./util"

function normalizePath(p: string): string {
  return (
    "/" +
    String(p || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  )
}

function parentPathOf(p: string): string {
  const parts = normalizePath(p).split("/").filter(Boolean)
  parts.pop()
  return "/" + parts.join("/")
}

function baseNameOf(p: string): string {
  const parts = normalizePath(p).split("/").filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ""
}

function parseTime(s?: string): string {
  if (!s) return new Date().toISOString()
  const t = new Date(s).getTime()
  return isNaN(t) ? new Date().toISOString() : new Date(s).toISOString()
}

/** Go types.go objectToObj() */
function objectToFileItem(f: CloudreveObject, thumb = ""): FileItem {
  const isDir = f.type === "dir"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: parseTime(f.date),
    sign: f.id || "",
    type: calcFileType(f.name, isDir),
    thumb,
    raw_url: "",
  }
}

/** Go util.go convertSrc() */
function convertSrc(obj: CloudreveObject): CloudreveSrcBody {
  return obj.type === "dir"
    ? { dirs: [obj.id], items: [] }
    : { dirs: [], items: [obj.id] }
}

export class CloudreveDriver implements StorageDriver {
  private client: CloudreveClient
  private addition: CloudreveAddition
  /** physical path → object cache (cleared after every write) */
  private objectCache = new Map<string, CloudreveObject>()

  constructor(
    addition: CloudreveAddition,
    onCookieUpdate?: (cookie: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.client = new CloudreveClient(addition, onCookieUpdate)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const dirPath = normalizePath(physicalPath)
    const resp = await this.client.getDirectory(dirPath)
    const items: FileItem[] = []
    for (const src of resp.objects || []) {
      // Go propagates thumb / folder-size errors to the whole listing
      const thumb = await this.client.getThumb(src.id)
      let size = src.size || 0
      if (src.type === "dir" && this.addition.enable_thumb_and_folder_size) {
        const dprop = await this.client.getDirectoryProp(src.id)
        size = dprop.size || 0
      }
      const obj: CloudreveObject = {
        ...src,
        size,
        // Go: src.Path = path.Join(dir.GetPath(), src.Name)
        path: joinPath(dirPath, src.name),
      }
      this.objectCache.set(normalizePath(obj.path || ""), obj)
      items.push(objectToFileItem(obj, thumb))
    }
    // Go Config().LocalSort = true → sort locally (folders-first/name)
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const p = normalizePath(physicalPath)
    const name = baseNameOf(p)
    if (!name) {
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
    // Go has no Getter — OpenList falls back to listing the parent and
    // matching by name
    const obj = await this.resolveObject(p)
    const item = objectToFileItem(obj)
    if (obj.type !== "dir") {
      try {
        const link = await this.client.getDownloadUrl(obj.id)
        item.raw_url = link.url
        item.raw_url_headers = link.headers
      } catch (e: any) {
        console.warn(
          `[Cloudreve] getDownloadUrl warning for ${name}:`,
          e?.message,
        )
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.makeDir(normalizePath(physicalPath))
    this.objectCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const obj = await this.resolveObject(normalizePath(physicalPath))
    await this.client.rename(convertSrc(obj), newName)
    this.objectCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const obj = await this.resolveObject(normalizePath(physicalPath))
    await this.client.remove(convertSrc(obj))
    this.objectCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcPath = normalizePath(srcPhys)
    const obj = await this.resolveObject(srcPath)
    await this.client.move(
      parentPathOf(srcPath),
      normalizePath(dstPhys),
      convertSrc(obj),
    )
    this.objectCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcPath = normalizePath(srcPhys)
    const obj = await this.resolveObject(srcPath)
    await this.client.copy(
      parentPathOf(srcPath),
      normalizePath(dstPhys),
      convertSrc(obj),
    )
    this.objectCache.clear()
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const p = normalizePath(physicalPath)
    const name = baseNameOf(p)
    if (!name) throw new Error("[Cloudreve] cannot upload to root")
    const dstDir = parentPathOf(p)
    const bytes = new Uint8Array(content)
    await this.client.upload(dstDir, name, bytes)
    this.objectCache.clear()
  }

  /** Resolve the object for a physical path by listing its parent dir */
  private async resolveObject(physicalPath: string): Promise<CloudreveObject> {
    const p = normalizePath(physicalPath)
    const cached = this.objectCache.get(p)
    if (cached) return cached
    const name = baseNameOf(p)
    const parent = parentPathOf(p)
    const resp = await this.client.getDirectory(parent)
    const found = (resp.objects || []).find((o) => o.name === name)
    if (!found) throw new Error(`[Cloudreve] object not found: ${p}`)
    const obj: CloudreveObject = { ...found, path: p }
    this.objectCache.set(p, obj)
    return obj
  }
}
