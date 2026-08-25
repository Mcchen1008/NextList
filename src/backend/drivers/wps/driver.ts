// WPS driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/wps
//
// WPS 云盘 (KDocs / 金山) — cookie-authenticated web API. Hierarchy:
// root → groups (团队) → files/folders inside each group (parent-id tree).
// Personal accounts use https://drive.wps.cn, business accounts
// https://365.kdocs.cn/3rd/drive (Go util.go driveHost/drivePrefix).
// ID-based API: physical name paths are resolved to {groupID, fileID} nodes
// level by level (quark-style resolveNode with a Map cache, cleared after
// writes). Downloads need the session cookie to obtain the presigned URL,
// then UA + Referer headers on the link itself (raw_url_headers).
// Uploads ARE ported: Go put.go is a single-request presigned-URL pipeline
// (create_update → PUT/POST whole file → commit), not a chunked OSS one.
// Go GetDetails (space usage) has no counterpart in the StorageDriver
// interface and is not ported.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { sha1, sha256 } from "../../pkg/crypto"
import { WpsAddition, WpsFileInfo, WpsGroup, WpsNode } from "./types"
import { WpsClient } from "./util"

/** Go parseTime(): <= 0 → zero time (epoch proxy in TS) */
function unixToIso(v: number): string {
  if (!v || v <= 0) return "1970-01-01T00:00:00.000Z"
  return new Date(v * 1000).toISOString()
}

/** Go types.go Group.groupToObj */
function groupToNode(g: WpsGroup): WpsNode {
  return {
    kind: "group",
    name: g.name,
    groupID: g.group_id,
    fileID: 0,
    parentID: 0,
    hasFile: false,
    canDownload: false,
    size: 0,
    mtime: 0,
    ctime: 0,
  }
}

/** Go types.go FileInfo.canDownload */
function fileInfoCanDownload(f: WpsFileInfo, isPersonal: boolean): boolean {
  if (f.ftype === "folder") return false
  if ((f.file_perms_acl?.download || 0) !== 0) return true
  return isPersonal
}

/** Go types.go FileInfo.fileToObj */
function fileInfoToNode(f: WpsFileInfo, isPersonal: boolean): WpsNode {
  const isFolder = f.ftype === "folder"
  return {
    kind: isFolder ? "folder" : "file",
    name: f.fname,
    groupID: f.groupid,
    fileID: f.id,
    parentID: f.parentid,
    hasFile: true,
    canDownload: fileInfoCanDownload(f, isPersonal),
    size: f.fsize || 0,
    mtime: f.mtime || 0,
    ctime: f.ctime || 0,
  }
}

function nodeToFileItem(n: WpsNode): FileItem {
  const isDir = n.kind !== "file"
  const sign =
    n.kind === "group"
      ? String(n.groupID)
      : n.kind === "root"
        ? ""
        : String(n.fileID)
  return {
    name: n.name,
    size: n.size || 0,
    is_dir: isDir,
    modified: unixToIso(n.mtime),
    created: n.ctime > 0 ? unixToIso(n.ctime) : undefined,
    sign,
    type: calcFileType(n.name, isDir),
    raw_url: "",
  }
}

/** physical path ("/a/b") → parent physical path ("/a") */
function parentOf(physicalPath: string): string {
  const parts = (physicalPath || "/").split("/").filter(Boolean)
  parts.pop()
  return "/" + parts.join("/")
}

function joinPath(dir: string, name: string): string {
  const parts = (dir || "/").split("/").filter(Boolean)
  parts.push(name)
  return "/" + parts.join("/")
}

const ROOT_NODE: WpsNode = {
  kind: "root",
  name: "root",
  groupID: 0,
  fileID: 0,
  parentID: 0,
  hasFile: false,
  canDownload: false,
  size: 0,
  mtime: 0,
  ctime: 0,
}

export class WpsDriver implements StorageDriver {
  private client: WpsClient
  /** physical path (name-based) → resolved node (cleared after writes) */
  private pathNodeCache = new Map<string, WpsNode>()

  constructor(addition: WpsAddition) {
    this.client = new WpsClient(addition)
  }

  /** Go Init(): cookie required + islogin check */
  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const node = await this.resolveNode(physicalPath)

    // Go List(): root lists the groups
    if (node.kind === "root") {
      const groups = await this.client.getGroups()
      const items = groups.map((g) => nodeToFileItem(groupToNode(g)))
      return sortFileItems(items, "name", "asc") // Go Config().LocalSort
    }
    // Go List(): a file node yields no children
    if (node.kind !== "group" && node.kind !== "folder") {
      return []
    }
    const parentID = node.kind === "folder" ? node.fileID : 0
    const files = await this.client.getFiles(node.groupID, parentID)
    const isPersonal = this.client.isPersonal()
    return sortFileItems(
      files.map((f) => nodeToFileItem(fileInfoToNode(f, isPersonal))),
      "name",
      "asc",
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const node = await this.resolveNode(physicalPath)
    if (node.kind === "root") {
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

    const item = nodeToFileItem(node)

    // Go Link(): only files with download permission expose a raw url
    if (node.kind === "file" && node.hasFile && node.canDownload) {
      try {
        const link = await this.client.getDownloadUrl(node.groupID, node.fileID)
        item.raw_url = link.url
        item.raw_url_headers = link.headers
      } catch (e) {
        console.warn(
          `[WPS] getDownloadUrl for ${node.name}: ${(e as Error).message}`,
        )
      }
    }
    return item
  }

  /** Go MakeDir(): creating groups at the storage root is not supported */
  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = (physicalPath || "/").split("/").filter(Boolean)
    const name = parts.pop()
    if (!name) {
      throw new Error("[WPS] mkdir: empty directory name")
    }
    const parent = await this.resolveNode("/" + parts.join("/"))
    if (parent.kind !== "group" && parent.kind !== "folder") {
      throw new Error(
        "[WPS] mkdir: parent must be a group or folder (groups cannot be created)",
      )
    }
    const parentID = parent.kind === "folder" ? parent.fileID : 0
    await this.client.makeDir(parent.groupID, parentID, name)
    this.invalidateCaches()
  }

  /** Go Rename() */
  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const node = await this.resolveNode(physicalPath)
    if (node.kind !== "file" && node.kind !== "folder") {
      throw new Error("[WPS] rename: not a file or folder")
    }
    await this.client.rename(node.groupID, node.fileID, newName)
    this.invalidateCaches()
  }

  /**
   * Go Remove(). The op layer calls this once per name with the item's own
   * physical path; a directory path + multiple names is also accepted.
   */
  async remove(
    _virtualPath: string,
    physicalPath: string,
    names: string[],
  ): Promise<void> {
    const parts = (physicalPath || "/").split("/").filter(Boolean)
    const last = parts[parts.length - 1] || ""
    let itemPaths: string[]
    if (names && names.length > 0 && names.includes(last)) {
      itemPaths = [physicalPath]
      for (const n of names) {
        if (n !== last) itemPaths.push(joinPath(parentOf(physicalPath), n))
      }
    } else if (names && names.length > 0) {
      itemPaths = names.map((n) => joinPath(physicalPath, n))
    } else {
      itemPaths = [physicalPath]
    }

    for (const p of itemPaths) {
      const node = await this.resolveNode(p)
      if (node.kind !== "file" && node.kind !== "folder") {
        throw new Error(`[WPS] remove: not a file or folder: ${p}`)
      }
      await this.client.remove(node)
    }
    this.invalidateCaches()
  }

  /** Go Move(): cross-group moves supported via target_groupid */
  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const src = await this.resolveNode(srcPhysical)
    if (src.kind !== "file" && src.kind !== "folder") {
      throw new Error(
        `[WPS] move: source is not a file or folder: ${srcPhysical}`,
      )
    }
    // op layer passes the destination ITEM path (dstDir + name)
    const dst = await this.resolveNode(parentOf(dstPhysical))
    if (dst.kind !== "group" && dst.kind !== "folder") {
      throw new Error("[WPS] move: destination must be a group or folder")
    }
    await this.client.move(src, dst)
    this.invalidateCaches()
  }

  /** Go Copy() */
  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const src = await this.resolveNode(srcPhysical)
    if (src.kind !== "file" && src.kind !== "folder") {
      throw new Error(
        `[WPS] copy: source is not a file or folder: ${srcPhysical}`,
      )
    }
    const dst = await this.resolveNode(parentOf(dstPhysical))
    if (dst.kind !== "group" && dst.kind !== "folder") {
      throw new Error("[WPS] copy: destination must be a group or folder")
    }
    await this.client.copy(src, dst)
    this.invalidateCaches()
  }

  /**
   * Go Put(): portable single-request upload pipeline —
   * sha1/sha256 hashes → create_update (presigned URL) → whole-file
   * PUT/POST (optional multipart form) → commit.
   */
  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const parts = (physicalPath || "/").split("/").filter(Boolean)
    const name = parts.pop()
    if (!name) {
      throw new Error("[WPS] put: empty file name")
    }
    const parent = await this.resolveNode("/" + parts.join("/"))
    if (parent.kind !== "group" && parent.kind !== "folder") {
      throw new Error("[WPS] put: parent must be a group or folder")
    }
    const parentID = parent.kind === "folder" ? parent.fileID : 0

    // copy out of the Node Buffer into a plain Uint8Array (Workers-safe)
    const data = new Uint8Array(content)
    const size = data.byteLength
    const sha1Hex = await sha1(data)
    const sha256Hex = await sha256(data)

    // WPS cannot upload hidden (dot-prefixed) files — Go prefixes "_"
    const uploadName = name.startsWith(".") ? "_" + name : name

    const info = await this.client.createUpload(
      parent.groupID,
      parentID,
      uploadName,
      size,
      sha1Hex,
      sha256Hex,
    )
    const uploaded = await this.client.uploadToUrl(
      info,
      uploadName,
      data,
      sha1Hex,
    )

    // Go put.go: only pass a store key when the server declared args_key
    const argsKey = (info.response?.args_key || "").trim()
    const commitKey = argsKey !== "" ? uploaded.key || uploaded.sha1 : ""

    await this.client.commitUpload({
      etag: uploaded.etag,
      key: commitKey,
      sha1: uploaded.sha1,
      groupID: parent.groupID,
      parentID,
      name: uploadName,
      size,
      store: info.store || "",
    })
    this.invalidateCaches()
  }

  private invalidateCaches(): void {
    this.pathNodeCache.clear()
    this.client.invalidateCaches()
  }

  /**
   * Resolve a physical name path to a WpsNode (Go GetRoot + unwrapWpsObj):
   * first segment must be a group name, the rest are walked down through
   * getFiles (parent-id tree). Cached per path segment (quark pattern).
   */
  private async resolveNode(physicalPath: string): Promise<WpsNode> {
    const parts = (physicalPath || "/").split("/").filter(Boolean)
    if (parts.length === 0) return ROOT_NODE

    const clean = parts.join("/")
    const cached = this.pathNodeCache.get(clean)
    if (cached) return cached

    // Go GetRoot(): parts[0] must match a group name
    const groups = await this.client.getGroups()
    const group = groups.find((g) => (g.name || "") === parts[0])
    if (!group) {
      throw new Error(`[WPS] root path "/${clean}" not found`)
    }
    let current = groupToNode(group)
    this.pathNodeCache.set(parts[0], current)

    for (let i = 1; i < parts.length; i++) {
      const subPath = parts.slice(0, i + 1).join("/")
      const subCached = this.pathNodeCache.get(subPath)
      if (subCached) {
        current = subCached
        continue
      }
      const parentID = current.kind === "folder" ? current.fileID : 0
      const files = await this.client.getFiles(current.groupID, parentID)
      const found = files.find((f) => (f.fname || "") === parts[i])
      if (!found) {
        throw new Error(`[WPS] failed to get obj: /${subPath} not found`)
      }
      current = fileInfoToNode(found, this.client.isPersonal())
      this.pathNodeCache.set(subPath, current)
    }
    return current
  }
}
