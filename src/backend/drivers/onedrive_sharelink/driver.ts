// OnedriveSharelink driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/onedrive_sharelink
//
// Read-only port: Go implements MakeDir (POST {driveUrl}/root:{path}:/children
// with a query access_token, conflictBehavior=fail), Put (simple PUT
// /content up to 250MiB, or createUploadSession + 10MiB Content-Range
// chunks) and GetDirectUploadTools ("HttpDirect"); none of them are ported —
// every write method throws. GetDetails (driveItemSize) has no NextList
// counterpart. The RangeReader proxy path of Go Link() is represented by
// raw_url + raw_url_headers on files.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { OnedriveSharelinkAddition, SPListItem } from "./types"
import { OnedriveSharelinkClient, cleanPath } from "./util"

function dirname(p: string): string {
  const cleaned = cleanPath(p)
  if (cleaned === "/") return "/"
  const parts = cleaned.split("/").filter(Boolean)
  parts.pop()
  return parts.length ? "/" + parts.join("/") : "/"
}

function basename(p: string): string {
  const cleaned = cleanPath(p)
  if (cleaned === "/") return ""
  const parts = cleaned.split("/").filter(Boolean)
  return parts[parts.length - 1] || ""
}

/**
 * SharePoint rows carry "Modified." either as "2006-01-02 15:04:05" or as an
 * RFC3339 timestamp; accept both (Go json-decodes time.Time which only
 * accepts RFC3339 — invalid values end up as the zero time there).
 */
function parseSharePointTime(s?: string): string {
  if (!s) return new Date().toISOString()
  const t = new Date(s)
  return isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString()
}

/** Go types.go fileToObj(): SPListItem → FileItem (sign = UniqueId) */
function itemToFileItem(f: SPListItem): FileItem {
  const name = f.FileLeafRef || ""
  const isDir = parseInt(f.FSObjType || "0", 10) === 1
  const size = parseInt(f.File_x0020_Size || "0", 10) || 0
  return {
    name,
    size,
    is_dir: isDir,
    modified: parseSharePointTime(f["Modified."]),
    sign: f.UniqueId || "",
    type: calcFileType(name, isDir),
  }
}

export class OnedriveSharelinkDriver implements StorageDriver {
  private client: OnedriveSharelinkClient

  constructor(addition: OnedriveSharelinkAddition) {
    this.client = new OnedriveSharelinkClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    // Go List(): rows come from the GraphQL listing; folder sizes are filled
    // from the drive api on a best-effort basis (failures only warn)
    const files = await this.client.getFiles(physicalPath)
    let folderSizes = new Map<string, number>()
    try {
      folderSizes = await this.client.getFolderSizes(physicalPath)
    } catch (e: any) {
      console.warn(
        `[OnedriveSharelink] failed to get folder sizes for ${physicalPath}: ${e?.message || e}`,
      )
    }

    const items = files.map(itemToFileItem)
    for (const item of items) {
      const size = folderSizes.get(item.name)
      if (size !== undefined) {
        item.size = size
      }
    }
    // Go Config().LocalSort = true; no order_by field in the Addition
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
    const parentPath = dirname(path)
    const files = await this.client.getFiles(parentPath)
    const found = files.find((f) => (f.FileLeafRef || "") === name)

    if (!found) {
      // Fall back to probing the path itself — if it lists, it is a folder
      try {
        await this.client.getFiles(path)
        return {
          name,
          size: 0,
          is_dir: true,
          modified: new Date().toISOString(),
          sign: "",
          type: 1,
          raw_url: "",
        }
      } catch {
        throw new Error(`[OnedriveSharelink] object not found: ${path}`)
      }
    }

    const item = itemToFileItem(found)
    if (!item.is_dir) {
      const downloadUrl = this.client.buildDownloadUrl(found.UniqueId || "")
      try {
        // cookie-free direct url (Go Link() with args.Redirect):
        // .spItemUrl metadata → @content.downloadUrl → download.aspx Location
        item.raw_url = await this.client.resolveDirectDownloadURL(
          found,
          downloadUrl,
        )
      } catch {
        // Fall back to the cookie-authenticated download.aspx url
        // (Go Link() proxy mode: url + share headers)
        item.raw_url = downloadUrl
        try {
          item.raw_url_headers = { ...(await this.client.getValidHeaders()) }
        } catch {
          // no valid headers available — keep the bare url
        }
      }
    }
    return item
  }

  // Go MakeDir() posts to {driveUrl}/root:{path}:/children — read-only here
  async mkdir(): Promise<void> {
    throw new Error("[OnedriveSharelink] read-only driver")
  }

  // Go Rename() → errs.NotImplement
  async rename(): Promise<void> {
    throw new Error("[OnedriveSharelink] read-only driver")
  }

  // Go Remove() → errs.NotImplement
  async remove(): Promise<void> {
    throw new Error("[OnedriveSharelink] read-only driver")
  }

  // Go Move() → errs.NotImplement
  async move(): Promise<void> {
    throw new Error("[OnedriveSharelink] read-only driver")
  }

  // Go Copy() → errs.NotImplement
  async copy(): Promise<void> {
    throw new Error("[OnedriveSharelink] read-only driver")
  }

  // Go Put() uploads via the OneDrive Graph api: simple PUT /content for
  // files <= 250MiB, otherwise createUploadSession + 10MiB Content-Range
  // chunks (uploadSessionChunk) — not ported to this stateless environment
  async put(): Promise<void> {
    throw new Error(
      "[OnedriveSharelink] read-only driver (Go Put() uploads via OneDrive Graph upload sessions — not ported)",
    )
  }
}
