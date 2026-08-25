// LenovoNasShare driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/lenovonas_share
//
// Read-only browser for Lenovo NAS share links (share id + share password,
// stoken-based). Implemented: init / list / get (link). All write operations
// throw — the Go driver returns errs.NotImplement for every write method
// (Config().NoUpload = true).
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { LenovoNasShareAddition, LenovoNasFile } from "./types"
import { LenovoNasShareClient, LENOVO_NAS_DOWNLOAD_REFERER } from "./util"

export class LenovoNasShareDriver implements StorageDriver {
  private client: LenovoNasShareClient
  private addition: LenovoNasShareAddition

  constructor(addition: LenovoNasShareAddition) {
    this.addition = addition
    this.client = new LenovoNasShareClient(addition)
  }

  async init(): Promise<void> {
    // Go Init(): shareId = path.Base(shareId) + getStoken()
    await this.client.init()

    // Go Init(): when the root folder should be hidden and no root path is
    // configured, list the share root and mount the first entry instead.
    // (Go would panic on an empty listing; we fall back to showing the root.)
    if (!this.addition.show_root_folder && !this.addition.root_folder_path) {
      try {
        const files = await this.client.listFiles("/")
        if (files.length > 0 && files[0].path) {
          this.client.setEffectiveRoot(files[0].path)
        }
      } catch (e: any) {
        console.warn(
          "[LenovoNasShare] auto-detect root folder failed:",
          e.message,
        )
      }
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const apiPath = this.client.toApiPath(physicalPath)
    const files = await this.client.listFiles(apiPath)
    const items = files.map((f) => this.fileToFileItem(f))
    // Go Config().LocalSort = true
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    if (!parts.length) {
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

    const parentPhysical = "/" + parts.slice(0, -1).join("/")
    const parentApiPath = this.client.toApiPath(parentPhysical)
    const files = await this.client.listFiles(parentApiPath)
    const found = files.find((f) => f.name === name)

    if (found) {
      const item = this.fileToFileItem(found)
      if (found.type !== "dir") {
        // Go Link() receives the obj whose path came from the API listing
        try {
          item.raw_url = await this.client.getFileLink(found.path || "")
          // Go Link() sets a Referer header on the download link
          item.raw_url_headers = { Referer: LENOVO_NAS_DOWNLOAD_REFERER }
        } catch (e: any) {
          console.warn(
            `[LenovoNasShare] getFileLink warning for ${name}:`,
            e.message,
          )
        }
      }
      return item
    }

    // Fallback: probe by listing — if it lists, it is a folder.
    const apiPath = this.client.toApiPath(physicalPath)
    try {
      await this.client.listFiles(apiPath)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: apiPath,
        type: 1,
        raw_url: "",
      }
    } catch {}

    throw new Error(
      `[LenovoNasShare] failed to get obj: ${physicalPath} not found`,
    )
  }

  async mkdir(): Promise<void> {
    // Go MakeDir returns errs.NotImplement (NoUpload = true)
    throw new Error("[LenovoNasShare] read-only driver")
  }

  async rename(): Promise<void> {
    throw new Error("[LenovoNasShare] read-only driver")
  }

  async remove(): Promise<void> {
    throw new Error("[LenovoNasShare] read-only driver")
  }

  async move(): Promise<void> {
    throw new Error("[LenovoNasShare] read-only driver")
  }

  async copy(): Promise<void> {
    throw new Error("[LenovoNasShare] read-only driver")
  }

  async put(): Promise<void> {
    // Go Put returns errs.NotImplement — no upload pipeline on a share link
    throw new Error("[LenovoNasShare] read-only driver")
  }

  /**
   * Go List() conversion: dirs pass through as plain objects, files get a
   * thumbnail built from code/stoken/path. Size is 0 for dirs (File.GetSize).
   */
  private fileToFileItem(f: LenovoNasFile): FileItem {
    const isDir = f.type === "dir"
    const modTs = (f.chtime || f.time || 0) * 1000
    const createTs = (f.time || 0) * 1000
    return {
      name: f.name,
      size: isDir ? 0 : f.size || 0,
      is_dir: isDir,
      modified:
        modTs > 0 ? new Date(modTs).toISOString() : new Date().toISOString(),
      created: createTs > 0 ? new Date(createTs).toISOString() : undefined,
      // path acts as the object id (Go File.GetID() returns the path)
      sign: f.path || "",
      type: calcFileType(f.name || "", isDir),
      thumb: isDir ? "" : this.client.buildThumbUrl(f.path || ""),
      raw_url: "",
    }
  }
}
