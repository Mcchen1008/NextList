// Terabox driver
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/terabox
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { TeraboxAddition, TeraboxFile } from "./types"
import { TeraboxClient } from "./util"

function fileToFileItem(f: TeraboxFile, parentPath: string): FileItem {
  const isDir = f.isdir === 1
  return {
    name: f.server_filename,
    size: f.size || 0,
    is_dir: isDir,
    modified: f.server_mtime
      ? new Date(f.server_mtime * 1000).toISOString()
      : new Date().toISOString(),
    sign: String(f.fs_id),
    type: calcFileType(f.server_filename, isDir),
    thumb: f.thumbs?.url3 || "",
    raw_url: "",
  }
  void parentPath
}

export class TeraboxDriver implements StorageDriver {
  private client: TeraboxClient
  private addition: TeraboxAddition

  constructor(addition: TeraboxAddition) {
    this.addition = addition
    this.client = new TeraboxClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const files = await this.client.getFiles(physicalPath || "/")
    const items = files.map((f) => fileToFileItem(f, physicalPath))
    return sortFileItems(
      items,
      this.addition.order_by || "name",
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    try {
      const files = await this.client.getFiles(parentPath || "/")
      const file = files.find((f) => f.server_filename === name)
      if (file) {
        const item = fileToFileItem(file, parentPath)
        if (file.isdir !== 1) {
          try {
            item.raw_url = await this.client.getDownloadLink(String(file.fs_id))
            item.raw_url_headers = {
              "User-Agent": this.client.getUserAgent(),
              Cookie: this.addition.cookie,
            }
          } catch (e: any) {
            console.warn(`[Terabox] getDownloadLink:`, e.message)
          }
        }
        return item
      }
    } catch (e: any) {
      console.warn(`[Terabox] get warning:`, e.message)
    }
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

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts.pop() || "新文件夹"
    const parentPath = "/" + parts.join("/")
    await this.client.makeDir(parentPath, name)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await this.client.rename(physicalPath, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    await this.client.remove(physicalPath)
  }

  async move(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const fileName = parts[parts.length - 1] || "file"
    await this.client.move(srcPhysical, dstDir, fileName)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const parts = (srcPhysical || "").split("/").filter(Boolean)
    const fileName = parts[parts.length - 1] || "file"
    await this.client.copy(srcPhysical, dstDir, fileName)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    // Simplified upload: single chunk (small files only — large files need chunking + MD5)
    const host = await this.client.getUploadHost()
    const dstDir = (physicalPath || "").split("/").slice(0, -1).join("/") || "/"
    const fileName = (physicalPath || "").split("/").pop() || "upload"
    const mtime = Math.floor(Date.now() / 1000)
    const md5 = await md5Hex(content)
    const blockList = [md5]
    const pre = await this.client.precreate(
      physicalPath,
      dstDir,
      mtime,
      blockList,
    )
    if (pre.errno !== 0) {
      throw new Error(`Terabox precreate failed: errno ${pre.errno}`)
    }
    if (pre.return_type === 2) return // 秒传
    const params = {
      method: "upload",
      path: encodeURIComponent(physicalPath),
      uploadid: pre.uploadid,
      partseq: "0",
    }
    const upResp = await this.client.uploadChunk(
      host,
      params,
      fileName,
      content,
    )
    if (upResp.md5 !== md5) {
      console.warn(`[Terabox] MD5 mismatch: local=${md5} server=${upResp.md5}`)
    }
    const createResp = await this.client.createFile(
      physicalPath,
      content.length,
      pre.uploadid,
      dstDir,
      blockList,
      mtime,
    )
    if (createResp.errno !== 0) {
      throw new Error(`Terabox create file failed: errno ${createResp.errno}`)
    }
  }
}

async function md5Hex(buf: Buffer): Promise<string> {
  // Use SubtleCrypto SHA-256? No, we need MD5. Use a pure-JS implementation.
  // Reuse the one from uss/util.ts inline for simplicity.
  const { md5Hex: ussMd5 } = await import("../uss/util")
  // Convert Buffer to string for hashing (binary-safe via latin1)
  const s = buf.toString("latin1")
  return ussMd5(s)
}
