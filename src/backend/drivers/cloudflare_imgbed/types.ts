// CloudflareImgBed (Cloudflare 图床) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudflare_imgbed
// Target: MarSeventh/CloudFlare-ImgBed style image hosting on Cloudflare Workers/Pages.

export interface CloudflareImgBedAddition {
  /** driver.RootPath — root folder path inside the image bed */
  root_folder_path?: string
  /** Backend API address of the image hosting service, e.g. https://img.example.com */
  address: string
  /** Bearer authentication token */
  token: string
  /** Channel name for regular files (typically <20MB) */
  smallChannelName?: string
  /** Channel name for large files */
  largeChannelName?: string
  /** "" | huggingface | telegram | cfr2 | s3 | discord */
  largeChannelType?: string
  /** Concurrent thread count for HuggingFace chunked direct upload */
  uploadThread?: number
}

/** GET /api/manage/list response */
export interface ImgBedListResponse {
  /** file paths relative to the image bed root (e.g. "dir/pic.png") */
  files?: ImgBedFileItem[]
  /** directory paths relative to the image bed root (may carry trailing "/") */
  directories?: string[]
}

export interface ImgBedFileItem {
  name: string
  /** stores file size, hash, timestamps, ... */
  metadata?: Record<string, unknown>
}

/** error envelope returned by the manage API */
export interface ImgBedApiError {
  error?: string
  message?: string
}

/** POST /upload (returnFormat=default) success item */
export interface ImgBedUploadResult {
  src: string
  publicUrl?: string
}

/** POST /upload?initChunked=true response */
export interface ImgBedInitChunkedResp {
  success?: boolean
  uploadId?: string
}

/** POST /upload/huggingface/getUploadUrl response */
export interface HfGetUrlResp {
  success?: boolean
  fullId?: string
  filePath?: string
  channelName?: string
  repo?: string
  /** whether a physical Git LFS upload is required */
  needsLfs?: boolean
  /** instant-upload already succeeded */
  alreadyExists?: boolean
  /** Git LFS object id (SHA256) */
  oid?: string
  uploadAction?: {
    href: string
    header: Record<string, string>
  }
}

/** POST /upload/huggingface/commitUpload response */
export interface HfCommitResp {
  success?: boolean
  src?: string
  publicUrl?: string
  fileUrl?: string
  fullId?: string
}

/** A file entry after client-side parsing of list responses (Go parseFile) */
export interface ImgBedListedFile {
  /** normalized absolute path with leading "/" (Go model.Object.Path) */
  path: string
  /** Go path.Base(item.Name) */
  name: string
  size: number
  /** unix milliseconds from metadata.TimeStamp (0 = unknown) */
  modifiedMs: number
}
