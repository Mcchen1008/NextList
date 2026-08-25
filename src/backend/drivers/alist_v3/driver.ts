// AList V3 driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/alist_v3
// Also compatible with OpenList servers (same API).
//
// Path-based driver: `physicalPath` (root_folder_path + virtual relative path)
// is the real path on the remote AList/OpenList server and is passed straight
// to the /api/fs/* endpoints, like Go does with model.Obj.GetPath().
// Archive features (GetArchiveMeta/ListArchive/Extract/ArchiveDecompress) are
// not ported.

import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { AListV3Addition, AListV3ObjResp } from "./types"
import {
  AListV3Client,
  baseName,
  dirName,
  normalizeAListV3Addition,
  normalizeRemotePath,
} from "./util"

/**
 * Parse AList timestamps (Go time.Time → RFC3339Nano, e.g.
 * "2024-01-02T15:04:05.123456789+08:00") into ISO strings. Falls back
 * gracefully for engines that reject sub-millisecond precision.
 */
function parseTime(s?: string): string {
  if (!s) return new Date(0).toISOString()
  let d = new Date(s)
  if (isNaN(d.getTime())) {
    d = new Date(s.replace(/(\.\d{3})\d+/, "$1"))
  }
  return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
}

/** Go List(): model.ObjThumb ← types.go ObjResp */
function objToFileItem(f: AListV3ObjResp): FileItem {
  const name = f.name || ""
  const isDir = !!f.is_dir
  return {
    name,
    size: isDir ? 0 : f.size || 0,
    is_dir: isDir,
    created: parseTime(f.created),
    modified: parseTime(f.modified),
    // AList per-object sign (used for /d links); kept as the item id
    sign: f.sign || "",
    // AList `type` uses different constants (1=folder,2=file) than NextList,
    // so classify from the name ourselves.
    type: calcFileType(name, isDir),
    thumb: f.thumb || "",
    raw_url: "",
  }
}

export class AListV3Driver implements StorageDriver {
  private client: AListV3Client
  private addition: AListV3Addition

  constructor(addition: AListV3Addition) {
    this.addition = normalizeAListV3Addition(addition)
    this.client = new AListV3Client(this.addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const path = normalizeRemotePath(physicalPath)
    const resp = await this.client.list(path)
    const content = resp?.content || []
    const items = content.map(objToFileItem)
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const path = normalizeRemotePath(physicalPath)
    if (path === "/") {
      // Storage root — synthesized like Go's model.Obj for the root path
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date(0).toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }

    const resp = await this.client.get(path)
    const item = objToFileItem(resp)
    item.name = resp.name || baseName(path)
    // Go Link(): the raw_url returned by /api/fs/get is used as-is; the remote
    // server already resolved proxy/direct links, so no extra headers needed.
    if (!item.is_dir) {
      item.raw_url = resp.raw_url || ""
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.mkdir(normalizeRemotePath(physicalPath))
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await this.client.rename(normalizeRemotePath(physicalPath), newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    // NextList calls remove() per item with physicalPath = dir + name and
    // names = [name]; Go Remove() sends {dir: path.Dir(obj), names: [name]}.
    const path = normalizeRemotePath(physicalPath)
    const list = names && names.length > 0 ? names : [baseName(path)]
    await this.client.remove(dirName(path), list)
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // Go Move(): {src_dir: path.Dir(src), dst_dir: dstDir, names: [name]}.
    // srcPhys/dstPhys include the object name, so strip the last segment.
    const srcPath = normalizeRemotePath(srcPhys)
    const dstPath = normalizeRemotePath(dstPhys)
    const list = names && names.length > 0 ? names : [baseName(srcPath)]
    await this.client.move(dirName(srcPath), dirName(dstPath), list)
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcPath = normalizeRemotePath(srcPhys)
    const dstPath = normalizeRemotePath(dstPhys)
    const list = names && names.length > 0 ? names : [baseName(srcPath)]
    await this.client.copy(dirName(srcPath), dirName(dstPath), list)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    // Go Put(): streaming PUT to /api/fs/put with File-Path/Password headers.
    // physicalPath already is dstDir + filename on the remote server.
    const path = normalizeRemotePath(physicalPath)
    const body = new Uint8Array(content)
    await this.client.put(path, body)
  }
}
