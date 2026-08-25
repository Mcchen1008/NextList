// Emby driver — read-only media library browser
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/emby
//
// The Emby driver is read-only: the Go driver only implements Init/List/Link,
// so every write operation below throws. Virtual paths are made of display
// names that embed the Emby item id ("Name (ID123)"), which is how the
// virtual path is re-resolved to item ids level by level.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { EmbyAddition, EmbyItem } from "./types"
import { EmbyClient, formatItemName } from "./util"

function itemToFileItem(it: EmbyItem, name: string): FileItem {
  const isDir = !!it.IsFolder
  let modified = new Date().toISOString()
  if (it.DateCreated) {
    const t = new Date(it.DateCreated).getTime()
    if (!isNaN(t)) modified = new Date(t).toISOString()
  }
  return {
    name,
    size: isDir ? 0 : it.Size || 0,
    is_dir: isDir,
    modified,
    sign: (it.Id || "").trim(),
    type: calcFileType(name, isDir),
    raw_url: "",
  }
}

export class EmbyDriver implements StorageDriver {
  private client: EmbyClient
  /** physical path (name path) → Emby item, filled while walking directories */
  private itemCache = new Map<string, EmbyItem>()

  constructor(
    addition: EmbyAddition,
    onCredentials?: (apiKey: string, userId: string) => void,
  ) {
    this.client = new EmbyClient(addition, onCredentials)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const parentId = await this.resolveItemId(physicalPath)
    const items = await this.client.getItems(parentId)

    const parentClean = physicalPath.split("/").filter(Boolean).join("/")
    const result: FileItem[] = []
    for (const it of items) {
      const name = formatItemName(it)
      if (!name) continue
      // cache child item by its virtual path for later resolution
      const childPath = parentClean ? `${parentClean}/${name}` : name
      this.itemCache.set(childPath, it)
      result.push(itemToFileItem(it, name))
    }
    // Go Config().LocalSort = true → sort locally by name
    return sortFileItems(result, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"

    const item = await this.resolveItem(physicalPath)
    if (!item) {
      // storage root
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: this.client.getRootFolderId(),
        type: 1,
        raw_url: "",
      }
    }

    const fileItem = itemToFileItem(item, name)
    if (!item.IsFolder) {
      try {
        const link = await this.client.getLinkUrl((item.Id || "").trim())
        fileItem.raw_url = link.url
        fileItem.raw_url_headers = link.headers
      } catch (e: any) {
        console.warn(`[Emby] getLinkUrl warning for ${name}:`, e?.message)
      }
    }
    return fileItem
  }

  async mkdir(_virtualPath: string, _physicalPath: string): Promise<void> {
    throw new Error(
      "[Emby] mkdir not supported (read-only media library driver)",
    )
  }

  async rename(
    _virtualPath: string,
    _physicalPath: string,
    _newName: string,
  ): Promise<void> {
    throw new Error(
      "[Emby] rename not supported (read-only media library driver)",
    )
  }

  async remove(
    _virtualPath: string,
    _physicalPath: string,
    _names: string[],
  ): Promise<void> {
    throw new Error(
      "[Emby] remove not supported (read-only media library driver)",
    )
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    _srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    throw new Error(
      "[Emby] move not supported (read-only media library driver)",
    )
  }

  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    _srcPhys: string,
    _dstPhys: string,
  ): Promise<void> {
    throw new Error(
      "[Emby] copy not supported (read-only media library driver)",
    )
  }

  async put(
    _virtualPath: string,
    _physicalPath: string,
    _content: Buffer,
  ): Promise<void> {
    throw new Error(
      "[Emby] put not supported (read-only media library driver; the Go driver has no upload either — NoUpload)",
    )
  }

  /** Resolve a physical (name) path to its Emby item; null for the root. */
  private async resolveItem(physicalPath: string): Promise<EmbyItem | null> {
    const clean = physicalPath.split("/").filter(Boolean).join("/")
    if (!clean) return null
    if (this.itemCache.has(clean)) return this.itemCache.get(clean)!

    const parts = clean.split("/")
    let parentId = this.client.getRootFolderId()
    let found: EmbyItem | null = null

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const subPath = parts.slice(0, i + 1).join("/")
      if (this.itemCache.has(subPath)) {
        const cached = this.itemCache.get(subPath)!
        parentId = (cached.Id || "").trim()
        found = cached
        continue
      }
      const items = await this.client.getItems(parentId)
      const target = items.find((it) => formatItemName(it) === part)
      if (!target) {
        throw new Error(
          `[Emby] path '${part}' not found under parent id '${parentId}'`,
        )
      }
      this.itemCache.set(subPath, target)
      parentId = (target.Id || "").trim()
      found = target
    }
    return found
  }

  private async resolveItemId(physicalPath: string): Promise<string> {
    const item = await this.resolveItem(physicalPath)
    return item ? (item.Id || "").trim() : this.client.getRootFolderId()
  }
}
