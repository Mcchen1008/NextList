// Doubao (豆包网盘, ByteDance) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/doubao
//
// Scope notes:
// - Only the base doubao driver is ported (doubao_new / doubao_share excluded).
// - Go Put() resolves an upload config (VOD ApplyUploadInner / ImageX
//   ApplyImageUpload with AWS SigV4-signed STS requests), uploads via plain or
//   multipart requests with CRC32 checksums and then registers the node via
//   /samantha/aispace/upload_node — too heavy for a stateless fetch
//   environment, see put() below.
// - Go Copy() returns errs.NotImplement → copy() throws accordingly.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DoubaoAddition, DoubaoFile, NODE_TYPE } from "./types"
import { DoubaoClient } from "./util"

function fileToFileItem(f: DoubaoFile): FileItem {
  const isDir = f.node_type === NODE_TYPE.DIRECTORY
  const modified = f.update_time
    ? new Date(f.update_time * 1000).toISOString()
    : new Date().toISOString()
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified,
    sign: f.id || "",
    type: calcFileType(f.name, isDir),
    raw_url: "",
  }
}

export class DoubaoDriver implements StorageDriver {
  private client: DoubaoClient
  /** cache: name path (relative to root_folder_id) → node */
  private pathNodeCache = new Map<string, DoubaoFile>()

  constructor(addition: DoubaoAddition) {
    this.client = new DoubaoClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.resolveNodeId(physicalPath)
    const files = await this.client.getFiles(folderId)
    const items = files.map(fileToFileItem)
    // Go Config().LocalSort = true → local sorting
    return sortDoubaoItems(items)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const node = await this.resolveNode(physicalPath)
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"

    let rawUrl = ""
    let rawUrlHeaders: Record<string, string> | undefined
    if (node && node.node_type !== NODE_TYPE.DIRECTORY) {
      try {
        const link = await this.client.getDownloadUrl(node)
        rawUrl = link.url
        rawUrlHeaders = link.headers
      } catch (e: any) {
        console.warn(`[Doubao] getDownloadUrl warning for ${name}:`, e.message)
      }
    }

    if (node) {
      const item = fileToFileItem(node)
      item.raw_url = rawUrl
      item.raw_url_headers = rawUrlHeaders
      return item
    }

    // Fallback: probe the path as a folder (e.g. storage root itself).
    const folderId = await this.resolveNodeId(physicalPath)
    try {
      await this.client.getFiles(folderId)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: folderId,
        type: 1,
        raw_url: "",
      }
    } catch {
      // fall through
    }

    return {
      name,
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: folderId,
      type: 0,
      raw_url: rawUrl,
      raw_url_headers: rawUrlHeaders,
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new folder"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.resolveNodeId(parentPath)
    await this.client.makeDir(parentId, name)
    this.pathNodeCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const node = await this.resolveNode(physicalPath)
    const nodeId = node ? node.id : await this.resolveNodeId(physicalPath)
    await this.client.rename(nodeId, newName)
    this.pathNodeCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const node = await this.resolveNode(physicalPath)
    const nodeId = node ? node.id : await this.resolveNodeId(physicalPath)
    await this.client.remove(nodeId)
    this.pathNodeCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const node = await this.resolveNode(srcPhysical)
    if (!node) {
      throw new Error(`[Doubao] node not found: ${srcPhysical}`)
    }
    // move_node requires current_parent_id (Go: srcObj.GetPath() = ParentID)
    const currentParentId =
      node.parent_id ||
      (await this.resolveNodeId(
        "/" + srcPhysical.split("/").filter(Boolean).slice(0, -1).join("/"),
      ))
    // dstPhysical points at the destination *item* path — its parent is the
    // target folder.
    const dstParts = dstPhysical.split("/").filter(Boolean)
    dstParts.pop()
    const targetParentId = await this.resolveNodeId("/" + dstParts.join("/"))
    await this.client.move(node.id, currentParentId, targetParentId)
    this.pathNodeCache.clear()
  }

  async copy(): Promise<void> {
    // Go: return errs.NotImplement
    throw new Error(
      "[Doubao] copy is not supported by the upstream API (Go driver returns NotImplement)",
    )
  }

  async put(): Promise<void> {
    // Go Put(): fetches upload auth tokens (/alice/upload/auth_token +
    // /samantha/media/get_upload_token), applies an upload config from VOD
    // ApplyUploadInner / ImageX ApplyImageUpload (AWS SigV4-signed with the
    // STS credentials), uploads the object (plain or CRC32-checked multipart)
    // and finally registers the node via /samantha/aispace/upload_node.
    throw new Error(
      "[Doubao] Direct put not supported (Go uploads via SigV4-signed VOD/ImageX STS upload pipeline, not portable to a stateless fetch environment)",
    )
  }

  // ── ID 逐级解析 (quark-style, with node cache) ────────────────────────────

  /** Resolve the node object for a path (null only when path == root). */
  private async resolveNode(physicalPath: string): Promise<DoubaoFile | null> {
    const rel = this.normalizeRelPath(physicalPath)
    if (!rel) return null
    if (this.pathNodeCache.has(rel)) return this.pathNodeCache.get(rel)!

    const parts = rel.split("/")
    let parentId = this.client.getRootFolderId()
    let current: DoubaoFile | null = null
    for (let i = 0; i < parts.length; i++) {
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.pathNodeCache.has(subPath)) {
        current = this.pathNodeCache.get(subPath)!
        parentId = current.id
        continue
      }
      const items = await this.client.getFiles(parentId)
      const target = items.find((f) => f.name === parts[i])
      if (!target) {
        throw new Error(
          `[Doubao] Path '${parts[i]}' not found in folder '${parentId}'`,
        )
      }
      current = target
      parentId = target.id
      this.pathNodeCache.set(subPath, target)
    }
    return current
  }

  /** Resolve a folder/file id for a path (root path → root_folder_id). */
  private async resolveNodeId(physicalPath: string): Promise<string> {
    const node = await this.resolveNode(physicalPath)
    if (node) return node.id
    return this.client.getRootFolderId()
  }

  /**
   * physicalPath is the virtual name path below the mounted root folder
   * (addition.root_folder_id): just normalize separators/slashes.
   */
  private normalizeRelPath(physicalPath: string): string {
    return (physicalPath || "")
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .join("/")
  }
}

/** Local sort (Go Config().LocalSort = true): folders first, then by name */
function sortDoubaoItems(items: FileItem[]): FileItem[] {
  const sorted = [...items]
  sorted.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
    return String(a.name).localeCompare(String(b.name))
  })
  return sorted
}
