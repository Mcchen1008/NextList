import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { WebdavAddition } from "./types"
import {
  basicAuth,
  basename,
  cleanPath,
  decodeHref,
  dirname,
  encodePath,
  joinPath,
  parsePropfind,
} from "./util"

/**
 * WebDAV storage driver.
 *
 * Implements the `StorageDriver` contract on top of the standard WebDAV
 * HTTP verbs (PROPFIND / GET / PUT / MKCOL / MOVE / COPY / DELETE), so any
 * WebDAV server (Nextcloud, ownCloud, Apache mod_dav, Synology, Alist's own
 * WebDAV endpoint, etc.) can be mounted as a storage backend.
 *
 * Downloads are served through the `/d` proxy: `get()` returns the direct
 * WebDAV URL plus the `Authorization` header in `raw_url_headers`, which the
 * raw router forwards upstream.
 */
export class WebdavDriver implements StorageDriver {
  private addition: WebdavAddition
  private address = ""
  private rootFolderPath = "/"

  constructor(addition: WebdavAddition) {
    this.addition = addition
  }

  async init(): Promise<void> {
    let addr = (this.addition.address || "").trim()
    if (!addr) {
      throw new Error("WebDAV address is required")
    }
    if (!/^https?:\/\//i.test(addr)) {
      // Be forgiving: auto-prefix the scheme when the user omits it.
      addr = "https://" + addr
    }
    this.address = addr.replace(/\/+$/, "")
    this.rootFolderPath = cleanPath(this.addition.root_folder_path || "/")
  }

  /** Absolute, percent-encoded URL for a storage-relative physical path. */
  private buildUrl(physicalPath: string): string {
    const full = joinPath(this.rootFolderPath, cleanPath(physicalPath))
    return this.address + encodePath(full)
  }

  /** Headers for the proxy GET download (auth + Translate, no Depth). */
  private downloadHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      // Some WebDAV servers (e.g. SharePoint) reject downloads with a 554
      // unless `Translate: f` is set. Keep it for the proxy GET too.
      Translate: "f",
    }
    if (this.addition.username) {
      headers["Authorization"] =
        "Basic " +
        basicAuth(this.addition.username, this.addition.password || "")
    }
    return headers
  }

  /** Headers used for every WebDAV request (auth + common extras). */
  private baseHeaders(): Record<string, string> {
    return this.downloadHeaders()
  }

  private async propfind(url: string, depth: "0" | "1"): Promise<Response> {
    const headers = this.baseHeaders()
    headers["Depth"] = depth
    const res = await fetch(url, { method: "PROPFIND", headers })
    if (res.status === 404) return res
    if (!res.ok) {
      // Allow 404 (handled by callers), but surface other failures.
      throw new Error(`WebDAV PROPFIND failed: ${res.status} ${res.statusText}`)
    }
    return res
  }

  private parseModified(s: string): string {
    if (!s) return new Date(0).toISOString()
    const d = new Date(s)
    return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const url = this.buildUrl(physicalPath)
    const res = await this.propfind(url, "1")
    if (res.status === 404) return []
    const xml = await res.text()
    const entries = parsePropfind(xml)

    const selfPath = cleanPath(physicalPath)
    const items: FileItem[] = []
    for (const entry of entries) {
      const itemPath = decodeHref(entry.href)
      if (itemPath === selfPath || itemPath === this.rootFolderPath) continue
      const name = basename(itemPath) || entry.href
      items.push({
        name,
        size: entry.isDir ? 0 : entry.size,
        is_dir: entry.isDir,
        modified: this.parseModified(entry.modified),
        sign: "",
        type: calcFileType(name, entry.isDir),
      })
    }
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const url = this.buildUrl(physicalPath)
    const res = await this.propfind(url, "0")
    if (res.status === 404) {
      throw new Error(`not found: ${physicalPath}`)
    }
    const xml = await res.text()
    const entries = parsePropfind(xml)
    const entry = entries[0]
    if (!entry) {
      throw new Error(`empty PROPFIND response for ${physicalPath}`)
    }

    const name = basename(physicalPath) || "root"

    return {
      name,
      size: entry.isDir ? 0 : entry.size,
      is_dir: entry.isDir,
      modified: this.parseModified(entry.modified),
      sign: "",
      type: calcFileType(name, entry.isDir),
      raw_url: entry.isDir ? "" : url,
      // Reuse downloadHeaders() so the proxy GET carries the same
      // `Translate: f` / `Authorization` as the PROPFIND request. Lazily
      // built only for files (directories have no download URL).
      raw_url_headers: entry.isDir ? undefined : this.downloadHeaders(),
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const url = this.buildUrl(physicalPath)
    const res = await fetch(url, {
      method: "MKCOL",
      headers: this.baseHeaders(),
    })
    // 201 Created is success; 405 means the folder already exists.
    if (!res.ok && res.status !== 201 && res.status !== 405) {
      throw new Error(`WebDAV MKCOL failed: ${res.status} ${res.statusText}`)
    }
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const src = this.buildUrl(physicalPath)
    const dst = this.buildUrl(joinPath(dirname(physicalPath), newName))
    await this.moveOrCopy(src, dst, "MOVE")
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    for (const name of names) {
      const url = this.buildUrl(joinPath(physicalPath, name))
      const res = await fetch(url, {
        method: "DELETE",
        headers: this.baseHeaders(),
      })
      // 204/200/207 are all acceptable; 404 means already gone.
      if (!res.ok && res.status !== 404) {
        throw new Error(`WebDAV DELETE failed: ${res.status} ${res.statusText}`)
      }
    }
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    for (const name of names) {
      const src = this.buildUrl(joinPath(srcPhys, name))
      const dst = this.buildUrl(joinPath(dstPhys, name))
      await this.moveOrCopy(src, dst, "MOVE")
    }
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    for (const name of names) {
      const src = this.buildUrl(joinPath(srcPhys, name))
      const dst = this.buildUrl(joinPath(dstPhys, name))
      await this.moveOrCopy(src, dst, "COPY")
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const url = this.buildUrl(physicalPath)
    const body = new Uint8Array(content)
    const res = await fetch(url, {
      method: "PUT",
      headers: this.baseHeaders(),
      body,
    })
    // 200 / 201 / 204 all indicate a successful upload.
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`WebDAV PUT failed: ${res.status} ${res.statusText}`)
    }
  }

  private async moveOrCopy(
    src: string,
    dst: string,
    method: "MOVE" | "COPY",
  ): Promise<void> {
    const headers = this.baseHeaders()
    headers["Destination"] = dst
    headers["Overwrite"] = "T"
    const res = await fetch(src, { method, headers })
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(
        `WebDAV ${method} failed: ${res.status} ${res.statusText}`,
      )
    }
  }
}
