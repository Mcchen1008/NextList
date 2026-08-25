// Teldrive driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/teldrive
//
// Path-based API: physicalPath maps 1:1 onto the teldrive `path` query param
// (Go List passes dir.GetPath(), which equals root_folder_path + rel path).
// Objects also carry an id (sign) — writes address objects by id, which is
// resolved by listing the parent directory and matching names.
//
// copy.go is ported as a client-side recursive copy: folders are recreated
// with mkdir and files are copied server-side via POST /api/files/{id}/copy
// ({newName, destination}) — the Go CopyManager (4 workers) is walked
// sequentially here. upload.go (Telegram chunk pipeline) is NOT ported —
// put() throws.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { TeldriveAddition, TeldriveObject } from "./types"
import { TeldriveClient, cleanPath, joinPath, dirname, basename } from "./util"

/** Go driver.go List(): Object → model.Obj mapping */
function objToFileItem(o: TeldriveObject): FileItem {
  const isDir = o.type === "folder"
  return {
    name: o.name,
    // Go List(): folders report size 0
    size: isDir ? 0 : o.size || 0,
    is_dir: isDir,
    modified: o.updatedAt
      ? new Date(o.updatedAt).toISOString()
      : new Date().toISOString(),
    sign: o.id || "",
    type: calcFileType(o.name, isDir),
  }
}

export class TeldriveDriver implements StorageDriver {
  private client: TeldriveClient
  private addition: TeldriveAddition

  constructor(addition: TeldriveAddition) {
    this.addition = addition
    this.client = new TeldriveClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const objects = await this.client.listDir(cleanPath(physicalPath || "/"))
    const items = objects.map(objToFileItem)
    // Go Config() has no LocalSort (AList sorts server-side); NextList has no
    // server-side sort, so apply the default local ordering for determinism
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const path = cleanPath(physicalPath || "/")
    if (path === "/") {
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

    const name = basename(path)
    const objects = await this.client.listDir(dirname(path))
    const obj = objects.find((o) => o.name === name)
    if (!obj) {
      throw new Error(`[Teldrive] object not found: ${path}`)
    }

    const item = objToFileItem(obj)
    if (!item.is_dir) {
      // Go Link(): download url with optional share-link indirection
      item.raw_url = await this.client.resolveDownloadUrl(obj)
      if (!this.client.isUseShareLink()) {
        // the direct file url requires the session cookie
        item.raw_url_headers = { Cookie: this.client.getCookie() }
      }
    }
    return item
  }

  /** Go MakeDir(): POST /api/files/mkdir with the full new folder path */
  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.makeDir(cleanPath(physicalPath))
  }

  /** Go Rename(): PATCH /api/files/{id} */
  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const obj = await this.resolveObject(physicalPath)
    await this.client.renameFile(obj.id, newName)
  }

  /** Go Remove(): POST /api/files/delete */
  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const obj = await this.resolveObject(physicalPath)
    await this.client.deleteFiles([obj.id])
  }

  /** Go Move(): POST /api/files/move with destinationParent = dst dir id */
  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const srcObj = await this.resolveObject(srcPhysical)
    // dstPhysical is the destination ITEM path (dstDir + "/" + name);
    // the destination directory is its parent
    const dstDirPhys = dirname(cleanPath(dstPhysical))
    const dstParentId = await this.resolveDirId(dstDirPhys)
    await this.client.moveFiles([srcObj.id], dstParentId)
  }

  /**
   * Go copy.go Copy(): client-side recursive copy — mkdir for folders,
   * server-side POST /api/files/{id}/copy for files. The Go CopyManager
   * processes tasks with 4 workers; this port walks the tree sequentially.
   */
  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const dstDirPhys = dirname(cleanPath(dstPhysical))
    await this.copyObject(cleanPath(srcPhysical), dstDirPhys)
  }

  /**
   * Go upload.go Put(): streams the file into Telegram through the teldrive
   * /api/uploads pipeline (fileId allocation, partName/partNo chunk uploads
   * with retry + concurrency, create-file-from-parts commit) — not ported.
   */
  async put(): Promise<void> {
    throw new Error(
      "[Teldrive] Direct put not supported (Go Put() uploads via the teldrive /api/uploads Telegram chunk pipeline: allocate fileId, upload partName/partNo chunks with retry+concurrency, then create the file from uploaded parts — not ported to this stateless environment)",
    )
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** resolve an object (id + type) by listing its parent and matching names */
  private async resolveObject(physicalPath: string): Promise<TeldriveObject> {
    const path = cleanPath(physicalPath)
    if (path === "/") {
      throw new Error("[Teldrive] cannot resolve the storage root as an object")
    }
    const name = basename(path)
    const objects = await this.client.listDir(dirname(path))
    const obj = objects.find((o) => o.name === name)
    if (!obj) {
      throw new Error(`[Teldrive] object not found: ${path}`)
    }
    return obj
  }

  /**
   * Resolve the teldrive folder id of a physical directory path.
   * Go: the storage root object (driver.IRootPath) carries no id, so moves
   * into the mount root send destinationParent: "" (kept faithful here).
   */
  private async resolveDirId(dirPhys: string): Promise<string> {
    const rootPhys = this.addition.root_folder_path
      ? cleanPath(this.addition.root_folder_path)
      : "/"
    if (dirPhys === "/" || dirPhys === rootPhys) {
      return ""
    }
    const name = basename(dirPhys)
    const parent = dirname(dirPhys)
    const obj = await this.client.findFile(parent, name, true)
    if (!obj) {
      throw new Error(`[Teldrive] destination folder not found: ${dirPhys}`)
    }
    return obj.id
  }

  /** Go copy.go generateTasks/generateFolderTasks/copySingleFile */
  private async copyObject(srcPhys: string, dstDirPhys: string): Promise<void> {
    const srcObj = await this.resolveObject(srcPhys)

    if (srcObj.type === "folder") {
      // Go generateFolderTasks(): list the source, then mkdir the target
      // folder, then recurse into the children with the new destination
      const children = await this.client.listDir(srcPhys)
      await this.client.makeDir(joinPath(dstDirPhys, srcObj.name))
      if (children.length === 0) return
      const newDstDir = joinPath(dstDirPhys, srcObj.name)
      for (const child of children) {
        await this.copyObject(joinPath(srcPhys, child.name), newDstDir)
      }
      return
    }

    // `override copy mode` should delete the existing file first
    const existing = await this.client.findFile(dstDirPhys, srcObj.name, false)
    if (existing) {
      await this.client.deleteFiles([existing.id])
    }
    // server-side copy
    await this.client.copyFile(srcObj.id, srcObj.name, dstDirPhys)
  }
}
