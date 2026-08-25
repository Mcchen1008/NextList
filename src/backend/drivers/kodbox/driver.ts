// KodBox (可道云) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/kodbox
//
// Path-based driver: KodBox's PHP API addresses files by "root/child/..."
// paths (no leading slash, Go Init() strips it from root_folder_path), so
// NextList's physicalPath maps directly onto the API `path` parameter.
// Auth: username/password → POST /?user/index/loginSubmit → accessToken
// (session token) which is sent with every form-urlencoded request; code
// "10001" triggers a re-login + single retry.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { KodBoxAddition, KodBoxFolderOrFile } from "./types"
import { KodBoxClient, normalizeKodboxPath } from "./util"

function toIso(unixSeconds?: number): string {
  if (!unixSeconds || unixSeconds <= 0) return new Date().toISOString()
  return new Date(unixSeconds * 1000).toISOString()
}

function entryToFileItem(f: KodBoxFolderOrFile): FileItem {
  const isDir = f.type === "folder"
  return {
    name: f.name,
    size: f.size || 0,
    is_dir: isDir,
    modified: toIso(f.modifyTime),
    created: f.createTime ? toIso(f.createTime) : undefined,
    // KodBox object identity is its API-returned path
    sign: f.path || "",
    type: calcFileType(f.name, isDir),
    thumb: "",
    raw_url: "",
  }
}

export class KodBoxDriver implements StorageDriver {
  private client: KodBoxClient
  private addition: KodBoxAddition

  constructor(addition: KodBoxAddition) {
    this.addition = addition
    this.client = new KodBoxClient(addition)
  }

  async init(): Promise<void> {
    // Go Init(): trim address suffix "/", clean RootFolderPath, then login
    // to obtain the accessToken (address normalization lives in the client)
    await this.client.getToken()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const path = normalizeKodboxPath(physicalPath)
    const entries = await this.client.listPath(path)
    const items = entries.map(entryToFileItem)
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const path = normalizeKodboxPath(physicalPath)
    if (!path) {
      // storage root (Go: IRootPath root object)
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
    // The Go driver implements no Getter, so OpenList falls back to listing
    // the parent directory and matching the entry by name — mirror that.
    const parts = path.split("/")
    const name = parts[parts.length - 1]
    const parentPath = parts.slice(0, -1).join("/")
    const entries = await this.client.listPath(parentPath)
    const found = entries.find((e) => e.name === name)
    if (!found) {
      throw new Error(`[KodBox] failed to get obj: ${path} not found`)
    }
    const item = entryToFileItem(found)
    if (found.type !== "folder") {
      // Go Link(): {address}/?explorer/index/fileOut&path=..&download=1&accessToken=..
      item.raw_url = this.client.buildFileOutUrl(found.path || path)
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    // physicalPath is the full path of the new dir, matching Go's
    // filepath.Join(parentDir.GetPath(), dirName)
    await this.client.makeDir(normalizeKodboxPath(physicalPath))
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await this.client.rename(normalizeKodboxPath(physicalPath), newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    // NextList calls remove() once per name with the item's full physical path
    const path = normalizeKodboxPath(physicalPath)
    const parts = path.split("/")
    const name = parts[parts.length - 1]
    await this.client.remove(path, name)
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcPath = normalizeKodboxPath(srcPhys)
    const srcParts = srcPath.split("/")
    const srcName = srcParts[srcParts.length - 1]
    // dstPhys is the destination item path (dstDir + "/" + name) — the API
    // wants the destination directory
    const dstDirPath = normalizeKodboxPath(dstPhys)
      .split("/")
      .slice(0, -1)
      .join("/")
    await this.client.move(srcPath, srcName, dstDirPath)
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    const srcPath = normalizeKodboxPath(srcPhys)
    const srcParts = srcPath.split("/")
    const srcName = srcParts[srcParts.length - 1]
    const dstDirPath = normalizeKodboxPath(dstPhys)
      .split("/")
      .slice(0, -1)
      .join("/")
    // Go additionally resolves the copied object's name via
    // /?explorer/index/pathInfo to return the new model.Obj — the TS
    // interface's copy() returns void, so that lookup is not needed
    await this.client.copy(srcPath, srcName, dstDirPath)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    // Go Put(): multipart POST /?explorer/upload/fileUpload with the file
    // part + path/accessToken form fields — supported with fetch FormData
    const path = normalizeKodboxPath(physicalPath)
    const parts = path.split("/")
    const fileName = parts.pop()
    if (!fileName) {
      throw new Error("[KodBox] put: empty file name")
    }
    const dirPath = parts.join("/")
    await this.client.upload(dirPath, fileName, content)
  }
}
