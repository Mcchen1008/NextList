// Bunny Storage (Bunny.net Storage Zone) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/bunny_storage
//
// NOTE: the task brief mentions "DirectUpload" logic in the Go source — the
// Go version ported here (driver.go/util.go/meta.go/types.go, 2025) contains
// no DirectUpload code path, so nothing was skipped on that front.

export interface BunnyStorageAddition {
  /** driver.RootPath — path inside the zone to mount */
  root_folder_path?: string
  storage_zone_name: string
  access_key: string
  /** storage endpoint host, e.g. storage.bunnycdn.com or ny.storage.bunnycdn.com */
  endpoint?: string
  /** optional pull-zone CDN base URL; when set, links point at the CDN */
  cdn_base_url?: string
  /** CDN token signing key (enables token authentication on CDN links) */
  cdn_token_key?: string
  /** "sha256" (default) or "hmac_sha256" */
  cdn_token_method?: string
  /** include the client IP in the CDN token (Go LinkCacheIP) */
  cdn_token_include_ip?: boolean
  /** CDN token lifetime in hours */
  sign_url_expire?: number
  /** placeholder object name used to emulate empty folders */
  placeholder?: string
  /** local sort (NextList addition; Go LocalSort=true means AList sorts) */
  order_by?: string
  order_desc?: boolean
}

/** GET /{zone}/{path}/ item (storage API JSON) */
export interface BunnyObject {
  Guid: string
  StorageZoneName: string
  Path: string
  ObjectName: string
  Length: number
  LastChanged: string
  IsDirectory: boolean
  ServerId: number
  UserId: string
  DateCreated: string
  StorageZoneId: number
}

/** error body item: [{"HttpCode":401,"Message":"..."}] */
export interface BunnyApiError {
  HttpCode: number
  Message: string
}
