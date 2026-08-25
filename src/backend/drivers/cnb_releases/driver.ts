// CNB Releases driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cnb_releases
//
// Read-only browsing of a cnb.cool (gitcode/CNB) repository's Releases:
// virtual two-level tree — root lists releases (as folders, named by
// release name or tag_name per use_tag_name), each release folder lists
// its asset attachments (files). Physical path == virtual path.
// Auth: Bearer token against https://api.cnb.cool.
//
// The Go driver also implements release create/rename/delete and asset
// upload/delete; this port is read-only per the porting plan, so every
// write method throws.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { CnbReleasesAddition, CnbRelease, CnbReleaseAsset } from "./types"
import { CnbReleasesClient, sumAssetsSize } from "./util"

/** cnb.cool download origin (Go Link(): "https://cnb.cool" + asset path) */
const DOWNLOAD_ORIGIN = "https://cnb.cool"

function toIso(s?: string): string {
  if (!s) return new Date().toISOString()
  const t = new Date(s).getTime()
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString()
}

function assetToFileItem(a: CnbReleaseAsset): FileItem {
  return {
    name: a.name,
    size: a.size || 0,
    is_dir: false,
    modified: toIso(a.updated_at),
    created: a.created_at ? toIso(a.created_at) : undefined,
    sign: a.id || "",
    type: calcFileType(a.name, false),
    thumb: "",
    raw_url: a.path ? DOWNLOAD_ORIGIN + a.path : "",
  }
}

export class CnbReleasesDriver implements StorageDriver {
  private client: CnbReleasesClient
  private addition: CnbReleasesAddition

  constructor(addition: CnbReleasesAddition) {
    this.addition = addition
    this.client = new CnbReleasesClient(addition)
  }

  async init(): Promise<void> {
    // Go Init() is a no-op; validate the required addition fields so a
    // mis-configured storage fails fast
    if (!(this.addition.repo || "").trim()) {
      throw new Error("[CnbReleases] repo is required (e.g. group/repo)")
    }
    if (!(this.addition.token || "").trim()) {
      throw new Error("[CnbReleases] token is required")
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const segments = this.relSegments(physicalPath)

    // Go embeds driver.RootID: with root_folder_id set, the op layer hands
    // List() a root dir whose ID is that release — its assets become the
    // root listing
    const rootReleaseId = (this.addition.root_folder_id || "").trim()
    if (rootReleaseId) {
      if (segments.length === 0) {
        const release = await this.client.getRelease(rootReleaseId)
        const items = (release.assets || []).map(assetToFileItem)
        return sortFileItems(items, "name", "asc")
      }
      throw new Error(
        `[CnbReleases] unexpected path under single-release root: ${physicalPath}`,
      )
    }

    if (segments.length === 0) {
      // root: every release becomes a folder
      const releases = await this.client.listReleases()
      const items = releases.map((r) => this.releaseToFileItem(r))
      return sortFileItems(items, "name", "asc")
    }

    // <release name> → the release's assets
    if (segments.length > 1) {
      throw new Error(`[CnbReleases] invalid path: ${physicalPath}`)
    }
    const release = await this.findReleaseByName(segments[0])
    // Go List() fetches the single release detail for asset listings
    const detail = release.id
      ? await this.client.getRelease(release.id)
      : release
    const items = (detail.assets || []).map(assetToFileItem)
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const segments = this.relSegments(physicalPath)

    const rootReleaseId = (this.addition.root_folder_id || "").trim()
    if (rootReleaseId) {
      const release = await this.client.getRelease(rootReleaseId)
      if (segments.length === 0) {
        return {
          name: "root",
          size: sumAssetsSize(release.assets),
          is_dir: true,
          modified: toIso(release.updated_at),
          sign: release.id || "",
          type: 1,
          raw_url: "",
        }
      }
      const assetName = segments[segments.length - 1]
      const asset = (release.assets || []).find((a) => a.name === assetName)
      if (!asset) {
        throw new Error(`[CnbReleases] asset not found: ${assetName}`)
      }
      return assetToFileItem(asset)
    }

    if (segments.length === 0) {
      // storage root
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

    if (segments.length === 1) {
      // a release folder
      const release = await this.findReleaseByName(segments[0])
      return this.releaseToFileItem(release)
    }

    // <release name>/<asset name>
    const releaseName = segments[0]
    const assetName = segments[segments.length - 1]
    const release = await this.findReleaseByName(releaseName)
    const asset = (release.assets || []).find((a) => a.name === assetName)
    if (!asset) {
      throw new Error(
        `[CnbReleases] asset not found: ${assetName} in release ${releaseName}`,
      )
    }
    return assetToFileItem(asset)
  }

  async mkdir(): Promise<void> {
    // Go creates a new release via POST /{repo}/-/releases — not ported
    throw new Error("[CnbReleases] read-only driver")
  }

  async rename(): Promise<void> {
    // Go renames a release via PATCH /{repo}/-/releases/{id} — not ported
    throw new Error("[CnbReleases] read-only driver")
  }

  async remove(): Promise<void> {
    // Go deletes releases/assets via DELETE endpoints — not ported
    throw new Error("[CnbReleases] read-only driver")
  }

  async move(): Promise<void> {
    throw new Error("[CnbReleases] read-only driver")
  }

  async copy(): Promise<void> {
    throw new Error("[CnbReleases] read-only driver")
  }

  async put(): Promise<void> {
    // Go uploads assets via asset-upload-url + multipart + verify — not ported
    throw new Error("[CnbReleases] read-only driver")
  }

  /** Display name of a release (Go List(): name, or tag_name when use_tag_name) */
  private releaseDisplayName(r: CnbRelease): string {
    const name = this.addition.use_tag_name ? r.tag_name : r.name
    // releases may carry an empty name — fall back to the tag so the entry
    // stays reachable in the name-based virtual tree (Go shows "" instead)
    return name && name.trim() ? name : r.tag_name || ""
  }

  private releaseToFileItem(r: CnbRelease): FileItem {
    return {
      name: this.releaseDisplayName(r),
      size: sumAssetsSize(r.assets),
      is_dir: true,
      modified: toIso(r.updated_at),
      created: r.created_at ? toIso(r.created_at) : undefined,
      sign: r.id || "",
      type: 1,
      thumb: "",
      raw_url: "",
    }
  }

  /**
   * Resolve a release by its display name. The Go driver addresses releases
   * by ID (model.Obj.ID); NextList only provides name paths, so list all
   * releases and match by name/tag_name (first match wins).
   */
  private async findReleaseByName(name: string): Promise<CnbRelease> {
    const releases = await this.client.listReleases()
    const found = releases.find((r) => this.releaseDisplayName(r) === name)
    if (!found) {
      throw new Error(`[CnbReleases] release not found: ${name}`)
    }
    return found
  }

  /**
   * Split a physical path into virtual segments, stripping a manual
   * root_folder_path prefix if one was set (Go's Addition has none — the
   * normal NextList case is physicalPath == relative virtual path).
   */
  private relSegments(physicalPath: string): string[] {
    let p = (physicalPath || "").replace(/\\/g, "/")
    const root = (this.addition.root_folder_path || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
    if (root && (p === root || p.startsWith(root + "/"))) {
      p = p.slice(root.length)
    }
    return p.split("/").filter(Boolean)
  }
}
