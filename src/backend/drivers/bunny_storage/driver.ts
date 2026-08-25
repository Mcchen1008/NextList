// Bunny Storage (Bunny.net Storage Zone) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/bunny_storage
//
// Go Config(): { Name: "Bunny Storage", LocalSort: true, DefaultRoot: "/",
// CheckStatus: true }. Without cdn_base_url the raw link is the storage URL
// which needs the AccessKey header — such downloads must go through the
// proxy route (Go flips OnlyProxy/PreferProxy on dynamically; a static config
// flag cannot express that per storage here).
//
// The Go driver implements List/Link/MakeDir/Remove/Put/Get only — it has no
// Rename/Move/Copy, so those throw here as well (AList answers NotSupport).
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { BunnyObject, BunnyStorageAddition } from "./types"
import { BunnyStorageClient } from "./util"

export class BunnyStorageDriver implements StorageDriver {
  private client: BunnyStorageClient
  private addition: BunnyStorageAddition

  /**
   * @param mountPath storage mount path (Go GetStorage().MountPath), used to
   * strip the mount prefix from CDN link paths — optional; pass
   * `storageConfig.mount_path` when wiring the driver in storage.ts.
   */
  constructor(addition: BunnyStorageAddition, mountPath?: string) {
    this.addition = addition
    this.client = new BunnyStorageClient(addition, mountPath)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  /** Go toObj() */
  private toFileItem(item: BunnyObject): FileItem {
    const times = this.client.parseTimes(item)
    const fileItem: FileItem = {
      name: item.ObjectName,
      size: item.Length || 0,
      is_dir: !!item.IsDirectory,
      modified: new Date(times.modified).toISOString(),
      sign: item.Guid || "",
      type: calcFileType(item.ObjectName, !!item.IsDirectory),
    }
    if (times.created > 0) {
      fileItem.created = new Date(times.created).toISOString()
    }
    return fileItem
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const items = await this.client.listDir(physicalPath, false)
    const result = items
      .filter((it) => it.ObjectName !== "")
      .map((it) => this.toFileItem(it))
    // Go LocalSort=true → AList sorts locally; NextList sorts in the driver.
    return sortFileItems(
      result,
      this.addition.order_by || "name",
      this.addition.order_desc ? "desc" : "asc",
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) {
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
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    // Go Get() lists the parent with S3ShowPlaceholder: true
    const items = await this.client.listDir(parentPath, true)
    const item = items.find((it) => it.ObjectName === name)
    if (!item) {
      throw new Error(`[BunnyStorage] object not found: ${physicalPath}`)
    }
    const fileItem = this.toFileItem(item)
    if (!item.IsDirectory) {
      const link = await this.client.getLink(physicalPath)
      fileItem.raw_url = link.url
      fileItem.raw_url_headers = link.headers
    }
    return fileItem
  }

  /**
   * Go MakeDir(): Bunny has no real directories — an empty placeholder object
   * ("{dir}/.openlist" by default) is PUT to materialize the folder.
   */
  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const dirName = parts.pop() || "new_folder"
    const placeholderPath =
      "/" + [...parts, dirName, this.client.placeholderName()].join("/")
    await this.client.putObject(placeholderPath, new Uint8Array(0))
  }

  async rename(): Promise<void> {
    throw new Error(
      "[BunnyStorage] rename not supported (Go driver does not implement Rename)",
    )
  }

  async move(): Promise<void> {
    throw new Error(
      "[BunnyStorage] move not supported (Go driver does not implement Move)",
    )
  }

  async copy(): Promise<void> {
    throw new Error(
      "[BunnyStorage] copy not supported (Go driver does not implement Copy)",
    )
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, parts.length - 1).join("/")
    // resolve is_dir via the parent listing (the Go fs layer hands the driver
    // a model.Obj that already carries IsFolder)
    const items = await this.client.listDir(parentPath, true)
    const item = items.find((it) => it.ObjectName === name)
    if (!item) {
      throw new Error(`[BunnyStorage] object not found: ${physicalPath}`)
    }
    await this.client.deleteObject(physicalPath, !!item.IsDirectory)
  }

  /** Go Put(): plain PUT of the object content to /{zone}/{path} */
  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    await this.client.putObject(
      physicalPath,
      new Uint8Array(content) as Uint8Array<ArrayBuffer>,
    )
  }
}
