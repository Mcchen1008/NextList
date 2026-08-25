// OpenListShare driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/openlist_share
//
// Note: the Go-side archive preview methods (GetArchiveMeta / ListArchive /
// Extract, gated by `forward_archive_requests`) are NOT ported because
// NextList's StorageDriver interface has no archive support. The config
// field is kept for parity with the Go Addition.

/** Mirrors Go meta.go `Addition` (including embedded driver.RootPath) */
export interface OpenListShareAddition {
  /** embedded driver.RootPath in Go — sub path inside the share */
  root_folder_path: string
  /** Go: Address `json:"url"` — base address of the remote OpenList instance */
  url: string
  /** Go: ShareId `json:"sid"` — share id (the part after /s/ in a share link) */
  sid: string
  /** Go: Pwd `json:"pwd"` — share password (empty when the share is public) */
  pwd: string
  /**
   * Go: ForwardArchiveReq `json:"forward_archive_requests"` (default true).
   * Only relevant for archive preview, which is not ported.
   */
  forward_archive_requests?: boolean
}

/** Body of POST /api/fs/list — Go ListReq (model.PageReq embedded) */
export interface FsListReq {
  page: number
  per_page: number
  path: string
  refresh: boolean
  password: string
}

/** Entry of fs/list content — Go ObjResp */
export interface OpenListShareObj {
  name: string
  size: number
  is_dir: boolean
  modified: string
  created: string
  sign: string
  thumb: string
  type: number
  hashinfo: string
}

/** Data of POST /api/fs/list — Go FsListResp */
export interface FsListResp {
  content: OpenListShareObj[]
  total: number
  readme: string
  write: boolean
  provider: string
}

/** Uniform API envelope — Go server/common.Resp[T] */
export interface OpenListResp<T> {
  code: number
  message: string
  data: T
}
