// Cloudreve V4 (Pro) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudreve_v4
//
// URI-based API: Cloudreve v4 addresses files with URIs rooted at the
// configured root_folder_path (Go DefaultRoot "cloudreve://my"). physicalPath
// (= root_folder_path + virtual rel path) maps 1:1 onto those URIs — except
// that NextList's resolvePath() collapses "//" → "/", mangling the
// "cloudreve://" scheme prefix, so toUri() restores it.
//
// Go Put() is fully ported: session creation via PUT /file/upload plus the
// local/remote/onedrive/s3/ks3 chunk pipelines (relay policies included).
// Empty files go through POST /file/create. Archive hooks
// (GetArchiveMeta/ListArchive/Extract/ArchiveDecompress) are NotImplement in
// Go and not ported.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import {
  CloudreveV4Addition,
  CloudreveV4File,
  METADATA_THUMB_DISABLED,
  METADATA_UPLOAD_SESSION_ID,
} from "./types"
import { CloudreveV4Client, CloudreveV4Tokens } from "./util"

/**
 * Normalize a NextList physical path to a Cloudreve v4 URI.
 * resolvePath() collapses consecutive slashes, turning "cloudreve://my/x"
 * into "cloudreve:/my/x" — restore the scheme prefix here.
 */
export function toUri(physicalPath: string): string {
  let p = String(physicalPath || "/")
  if (p.startsWith("cloudreve:/") && !p.startsWith("cloudreve://")) {
    p = "cloudreve://" + p.slice("cloudreve:/".length)
  }
  return p
}

function parentPathOf(p: string): string {
  const idx = p.lastIndexOf("/")
  if (idx < 0) return ""
  return p.slice(0, idx) || "/"
}

function baseNameOf(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx >= 0 ? p.slice(idx + 1) : p
}

function parseTime(s?: string): string {
  if (!s) return new Date().toISOString()
  const t = new Date(s).getTime()
  return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString()
}

/** Go types.go fileToObject() */
function fileToFileItem(
  f: CloudreveV4File,
  size = f.size || 0,
  thumb = "",
): FileItem {
  const isDir = f.type === 1
  return {
    name: f.name,
    size,
    is_dir: isDir,
    modified: parseTime(f.updated_at),
    created: parseTime(f.created_at),
    sign: f.id || "",
    type: calcFileType(f.name, isDir),
    thumb,
    raw_url: "",
  }
}

export class CloudreveV4Driver implements StorageDriver {
  private client: CloudreveV4Client
  private addition: CloudreveV4Addition

  constructor(
    addition: CloudreveV4Addition,
    onTokenUpdate?: (tokens: CloudreveV4Tokens) => void | Promise<void>,
  ) {
    this.addition = addition
    this.client = new CloudreveV4Client(addition, onTokenUpdate)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const uri = toUri(physicalPath)
    let files = await this.client.getFiles(uri)

    if (this.addition.hide_uploading) {
      // hide entries that still belong to an unfinished upload session
      files = files.filter(
        (f) => !f.metadata || f.metadata[METADATA_UPLOAD_SESSION_ID] == null,
      )
    }

    const items: FileItem[] = []
    for (const src of files) {
      let size = src.size || 0
      if (this.addition.enable_folder_size && src.type === 1) {
        // Go swallows folder-summary errors (err == nil && size > 0)
        try {
          const ds = await this.client.getFolderSummary(src.path || "")
          const s = ds.folder_summary?.size || 0
          if (s > 0) size = s
        } catch {
          /* ignore */
        }
      }
      let thumb = ""
      if (
        this.addition.enable_thumb &&
        src.type === 0 &&
        // Go quirk kept byte-for-byte: a present metadata map WITHOUT the
        // "thumb:disabled" key disables thumbs (nil map lookup != ""),
        // while an explicit "" value keeps them enabled
        (!src.metadata || src.metadata[METADATA_THUMB_DISABLED] === "")
      ) {
        // Go swallows thumb errors (err == nil && url != "")
        try {
          const t = await this.client.getFileThumb(src.path || "")
          if (t.url) thumb = t.url
        } catch {
          /* ignore */
        }
      }
      items.push(fileToFileItem(src, size, thumb))
    }
    // Go Config().LocalSort is false — ordering comes from the server via
    // the order_by / order_direction query parameters
    return items
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const uri = toUri(physicalPath)
    // data may be null → zero File, like Go's zero-value FileResp
    const info =
      (await this.client.getFileInfo(uri)) ||
      ({ type: 0, id: "", name: "" } as CloudreveV4File)
    const item = fileToFileItem(info)
    if (info.type !== 1) {
      try {
        const link = await this.client.getFileUrl(info.path || uri)
        item.raw_url = link.url
        item.raw_url_headers = link.headers
      } catch (e: any) {
        console.warn(
          `[CloudreveV4] getFileUrl warning for ${info.name}:`,
          e?.message,
        )
      }
    }
    return item
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    await this.client.makeDir(toUri(physicalPath))
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    await this.client.rename(toUri(physicalPath), newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    await this.client.remove(toUri(physicalPath))
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    await this.client.move([toUri(srcPhys)], toUri(dstPhys), false)
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhys: string,
    dstPhys: string,
  ): Promise<void> {
    await this.client.move([toUri(srcPhys)], toUri(dstPhys), true)
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const p = String(physicalPath || "/")
    const name = baseNameOf(p)
    if (!name) throw new Error("[CloudreveV4] cannot upload to root")
    const dstDir = toUri(parentPathOf(p))
    const bytes = new Uint8Array(content)
    await this.client.upload(dstDir, name, bytes)
  }
}
