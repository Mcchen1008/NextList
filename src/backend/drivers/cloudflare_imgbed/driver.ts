// CloudflareImgBed (Cloudflare 图床) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudflare_imgbed
//
// Browses / manages a MarSeventh/CloudFlare-ImgBed style image hosting service
// (Cloudflare Workers/Pages) through its manage API:
//   - list:  GET  /api/manage/list?dir=&start=&count=
//   - link:  {address}/file/<path> (or the publicUrl prefix learned from uploads)
//   - mkdir: purely virtual (folders materialize server-side on upload via
//            the uploadFolder query param), kept in a local cache like Go's
//            WeakCacheMap + model.Virtual mask
//   - remove: POST /api/manage/delete/<path>?folder=<bool>
//   - put:   POST /upload multipart (standard), chunked (telegram/cfr2/s3/discord)
//            or HuggingFace LFS direct upload for files >= 20MB
// rename/move/copy are not implemented in the Go driver either (NotSupport).
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import { CloudflareImgBedAddition } from "./types"
import {
  CloudflareImgBedClient,
  encodePath,
  guessMimeType,
  HF_DIRECT_THRESHOLD,
} from "./util"

/** normalize to "/a/b" form; "/" for the root */
function normalizeImgBedPath(p: string): string {
  const clean = (p || "/").split("/").filter(Boolean).join("/")
  return clean ? "/" + clean : "/"
}

/** Go path.Dir equivalent for "/a/b" style paths */
function parentPath(p: string): string {
  const idx = p.lastIndexOf("/")
  if (idx <= 0) return "/"
  return p.slice(0, idx)
}

/** Go path.Base equivalent */
function baseName(p: string): string {
  const segs = p.split("/").filter(Boolean)
  return segs.length ? segs[segs.length - 1] : "/"
}

/** unix millis → ISO string (0/undefined → epoch, Go zero-time proxy) */
function msToIso(ms: number): string {
  if (!ms || ms <= 0) return "1970-01-01T00:00:00.000Z"
  return new Date(ms).toISOString()
}

export class CloudflareImgBedDriver implements StorageDriver {
  private client: CloudflareImgBedClient
  private addition: CloudflareImgBedAddition
  /**
   * Go virtualDir cache: full physical path → virtual directory object.
   * Virtual dirs exist only client-side until a file is uploaded into them.
   */
  private virtualDirs = new Map<string, FileItem>()
  /** proxy for Go d.Modified (storage modified time) used for dir objects */
  private storageModified = new Date().toISOString()

  constructor(addition: CloudflareImgBedAddition) {
    this.addition = addition
    this.client = new CloudflareImgBedClient(addition)
  }

  /** Go Init(): connectivity test via a single-item root listing */
  async init(): Promise<void> {
    this.storageModified = new Date().toISOString()
    try {
      await this.client.verifyConnection()
    } catch (e) {
      throw new Error(
        `[CloudflareImgBed] init verification failed: ${(e as Error).message}`,
      )
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const dirPath = normalizeImgBedPath(physicalPath)
    const items: FileItem[] = []

    // A purely virtual directory has no server-side content yet (Go keeps
    // such objects only in the local cache) — skip the API call for them.
    if (!this.virtualDirs.has(dirPath)) {
      const { dirs, files } = await this.client.listDir(dirPath)
      for (const dir of dirs) {
        items.push({
          name: baseName(dir),
          size: 0,
          is_dir: true,
          modified: this.storageModified, // Go: d.Modified
          sign: dir,
          type: 1,
        })
      }
      for (const f of files) {
        items.push({
          name: f.name,
          size: f.size,
          is_dir: false,
          modified: msToIso(f.modifiedMs),
          sign: f.path,
          type: calcFileType(f.name, false),
          thumb: "",
          raw_url: this.linkUrl(f.path),
        })
      }
    }

    // Inject virtual child dirs so mkdir'ed folders stay visible in
    // listings (AList's op layer caches new objects in the parent listing;
    // NextList has no such cache, so the driver does it itself).
    for (const [key, item] of this.virtualDirs) {
      if (parentPath(key) === dirPath) items.push(item)
    }

    // Go Config().LocalSort = true
    return sortFileItems(items, "name", "asc")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const fullPath = normalizeImgBedPath(physicalPath)
    if (fullPath === "/") {
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: this.storageModified,
        sign: "/",
        type: 1,
        raw_url: "",
      }
    }
    // Go Get(): virtual dir cache hit
    const virtual = this.virtualDirs.get(fullPath)
    if (virtual) return virtual

    // Go Get() returns errs.NotSupport; the fs layer then falls back to
    // listing the parent directory and matching by name — do the same.
    const name = baseName(fullPath)
    const items = await this.list("", parentPath(fullPath))
    const found = items.find((i) => i.name === name)
    if (!found) {
      throw new Error(
        `[CloudflareImgBed] failed to get obj: ${fullPath} not found`,
      )
    }
    return found
  }

  /**
   * Go MakeDir(): virtual only — returns a model.Virtual object so uploads
   * into it can reference the folder path; no server-side call is made.
   */
  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const fullPath = normalizeImgBedPath(physicalPath)
    this.virtualDirs.set(fullPath, {
      name: baseName(fullPath),
      size: 0,
      is_dir: true,
      modified: this.storageModified,
      sign: fullPath,
      type: 1,
    })
  }

  async rename(): Promise<void> {
    // no Rename in the Go driver (errs.NotSupport)
    throw new Error(
      "[CloudflareImgBed] rename not supported (image bed manage API has no rename endpoint)",
    )
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fullPath = normalizeImgBedPath(physicalPath)
    // Go Remove(): virtual dirs are dropped from the local cache only
    if (this.virtualDirs.has(fullPath)) {
      this.virtualDirs.delete(fullPath)
      return
    }
    // resolve the object to learn is_dir (Go receives model.Obj)
    const obj = await this.get("", fullPath)
    await this.client.deletePath(fullPath, obj.is_dir)
  }

  async move(): Promise<void> {
    // no Move in the Go driver (errs.NotSupport)
    throw new Error(
      "[CloudflareImgBed] move not supported (image bed manage API has no move endpoint)",
    )
  }

  async copy(): Promise<void> {
    // no Copy in the Go driver (errs.NotSupport)
    throw new Error(
      "[CloudflareImgBed] copy not supported (image bed manage API has no copy endpoint)",
    )
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const fullPath = normalizeImgBedPath(physicalPath)
    const uploadFolder = parentPath(fullPath) // Go: dstDir.GetPath()
    const fileName = baseName(fullPath)
    const body = new Uint8Array(content)
    const size = body.length
    const params = {
      fileName,
      mimeType: guessMimeType(fileName),
      content: body,
      size,
      uploadFolder,
    }

    // Go Put(): size < 20MB → standard upload; otherwise by LargeChannelType
    if (size < HF_DIRECT_THRESHOLD) {
      await this.client.standardUpload(params)
    } else {
      switch (this.client.getLargeChannelType()) {
        case "huggingface":
          await this.client.hfDirectUpload(params)
          break
        case "telegram":
        case "cfr2":
        case "s3":
        case "discord":
          await this.client.chunkedUpload(
            params,
            this.client.getLargeChannelType(),
            this.addition.largeChannelName || "",
          )
          break
        default:
          await this.client.standardUpload(params)
      }
    }

    // Go Put(): once the server has real data, drop the virtual dir chain
    // (dstDir and its virtual ancestors)
    if (this.virtualDirs.has(uploadFolder)) {
      let key = uploadFolder
      while (this.virtualDirs.delete(key)) {
        key = parentPath(key)
      }
    }
  }

  /** Go Link(): publicUrlPrefix + EncodePath(path) or Address + "/file" + path */
  private linkUrl(path: string): string {
    const prefix =
      this.client.publicUrlPrefix || this.client.getAddress() + "/file"
    return prefix + encodePath(path)
  }
}
