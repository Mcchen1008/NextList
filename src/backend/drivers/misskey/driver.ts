// Misskey driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/misskey
//
// Lists and manages the drive (files & folders) of the authenticated
// Misskey user via the /api/drive/* endpoints. Folder ids are resolved by
// walking the physical path from the drive root (the Go driver relies on
// OpenList's obj cache doing the same walk implicitly).
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { MisskeyAddition, MisskeyFile, MisskeyFolder } from "./types"
import { MisskeyClient } from "./util"

function toIso(v?: string): string {
  if (!v) return new Date().toISOString()
  const t = Date.parse(v)
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString()
}

/** Go mFile2Object */
function fileItem(f: MisskeyFile): FileItem {
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: false,
    modified: toIso(f.createdAt), // Misskey files only expose createdAt
    created: toIso(f.createdAt),
    sign: f.id || "",
    type: calcFileType(f.name, false),
    thumb: f.thumbnailUrl || "",
    raw_url: f.url || "",
  }
}

/** Go mFolder2Object */
function folderItem(f: MisskeyFolder): FileItem {
  return {
    name: f.name,
    size: 0,
    is_dir: true,
    modified: toIso(f.createdAt),
    created: toIso(f.createdAt),
    sign: f.id || "",
    type: 1,
    thumb: "",
    raw_url: "",
  }
}

type MisskeyEntry =
  | { type: "folder"; folder: MisskeyFolder }
  | { type: "file"; file: MisskeyFile }

export class MisskeyDriver implements StorageDriver {
  private client: MisskeyClient
  /** physical path -> folder id cache (root maps to "") */
  private folderIdCache = new Map<string, string>()

  constructor(addition: MisskeyAddition) {
    this.client = new MisskeyClient(addition)
  }

  async init(): Promise<void> {
    // Go Init(): endpoint/access_token must be non-empty (errs.EmptyToken)
    if (!this.client.getEndpoint() || !this.client.getToken()) {
      throw new Error(
        "[Misskey] empty token: endpoint and access_token are required",
      )
    }
  }

  /**
   * Resolve a physical path to a Misskey folder id by walking the path
   * segments from the drive root (Go isRootFolder: "" id means root).
   * Returns "" for the drive root.
   */
  private async resolveFolderId(physicalPath: string): Promise<string> {
    const path = physicalPath || "/"
    const cached = this.folderIdCache.get(path)
    if (cached !== undefined) return cached

    let folderId: string | null = null
    let current = ""
    for (const seg of path.split("/").filter(Boolean)) {
      current = current + "/" + seg
      const hit = this.folderIdCache.get(current)
      if (hit !== undefined) {
        folderId = hit
        continue
      }
      const folders = await this.client.getFolders(folderId)
      const found = folders.find((f) => f.name === seg)
      if (!found) {
        throw new Error(`[Misskey] folder not found: ${current}`)
      }
      folderId = found.id
      this.folderIdCache.set(current, folderId)
    }
    return folderId || ""
  }

  /** Find the file/folder entry of a physical path by listing its parent. */
  private async findEntry(physicalPath: string): Promise<MisskeyEntry> {
    const path = physicalPath || "/"
    const parts = path.split("/").filter(Boolean)
    if (parts.length === 0) {
      return {
        type: "folder",
        folder: { id: "", createdAt: "", name: "root", parentId: null },
      }
    }
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.resolveFolderId(parentPath)
    const [files, folders] = await Promise.all([
      this.client.getFiles(parentId || null),
      this.client.getFolders(parentId || null),
    ])
    const file = files.find((f) => f.name === name)
    if (file) return { type: "file", file }
    const folder = folders.find((f) => f.name === name)
    if (folder) return { type: "folder", folder }
    throw new Error(`[Misskey] object not found: ${path}`)
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveFolderId(physicalPath)
    // Go list(): files of the dir + folders of the dir
    const [files, folders] = await Promise.all([
      this.client.getFiles(folderId || null),
      this.client.getFolders(folderId || null),
    ])
    const items = [...folders.map(folderItem), ...files.map(fileItem)]
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const path = physicalPath || "/"
    const parts = path.split("/").filter(Boolean)
    if (parts.length === 0) {
      // drive root
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
    const entry = await this.findEntry(path)
    if (entry.type === "file") {
      // Go link(): POST /files/show → file.url; the freshly listed entry
      // already carries the same url, so no extra round-trip is needed.
      return fileItem(entry.file)
    }
    return folderItem(entry.folder)
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts.pop()
    if (!name) throw new Error("[Misskey] mkdir: empty folder name")
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveFolderId(parentPath)
    await this.client.createFolder(parentId || null, name)
    this.folderIdCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const entry = await this.findEntry(physicalPath)
    if (entry.type === "folder") {
      if (!entry.folder.id) {
        throw new Error("[Misskey] cannot rename the drive root")
      }
      await this.client.updateFolder(entry.folder.id, { name: newName })
    } else {
      await this.client.updateFile(entry.file.id, { name: newName })
    }
    this.folderIdCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const entry = await this.findEntry(physicalPath)
    if (entry.type === "folder") {
      if (!entry.folder.id) {
        throw new Error("[Misskey] cannot remove the drive root")
      }
      await this.client.deleteFolder(entry.folder.id)
    } else {
      await this.client.deleteFile(entry.file.id)
    }
    this.folderIdCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    // dstPhys is the physical path of the destination OBJECT (dstDir+name),
    // so the destination folder is its parent directory.
    const dstParts = (dstPhys || "").split("/").filter(Boolean)
    dstParts.pop()
    const dstParentId = await this.resolveFolderId("/" + dstParts.join("/"))
    const entry = await this.findEntry(srcPhys)
    if (entry.type === "folder") {
      await this.client.updateFolder(entry.folder.id, {
        parentId: dstParentId || null,
      })
    } else {
      await this.client.updateFile(entry.file.id, {
        folderId: dstParentId || null,
      })
    }
    this.folderIdCache.clear()
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const dstParts = (dstPhys || "").split("/").filter(Boolean)
    dstParts.pop()
    const dstParentId = await this.resolveFolderId("/" + dstParts.join("/"))
    const entry = await this.findEntry(srcPhys)
    if (entry.type === "folder") {
      // Go copy(): folders are duplicated recursively
      await this.copyFolderRecursive(entry.folder, dstParentId)
    } else {
      // Go copy(): files are copied via /files/upload-from-url
      await this.client.uploadFromUrl(entry.file.url, dstParentId || null)
    }
    this.folderIdCache.clear()
  }

  private async copyFolderRecursive(
    folder: MisskeyFolder,
    dstParentId: string,
  ): Promise<void> {
    const created = await this.client.createFolder(
      dstParentId || null,
      folder.name,
    )
    const [files, subFolders] = await Promise.all([
      this.client.getFiles(folder.id),
      this.client.getFolders(folder.id),
    ])
    for (const f of files) {
      await this.client.uploadFromUrl(f.url, created.id)
    }
    for (const sub of subFolders) {
      await this.copyFolderRecursive(sub, created.id)
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    // Go put(): multipart upload to /api/drive/files/create
    const parts = (physicalPath || "").split("/").filter(Boolean)
    const name = parts.pop()
    if (!name) throw new Error("[Misskey] put: empty file name")
    const parentPath = "/" + parts.join("/")
    const folderId = await this.resolveFolderId(parentPath)
    await this.client.uploadFile(name, folderId || null, content)
  }
}
