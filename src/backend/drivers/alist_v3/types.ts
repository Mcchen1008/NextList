// AList V3 driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/alist_v3
// Also compatible with OpenList servers (same API).

/**
 * Driver addition config — mirrors Go meta.go `Addition` field-by-field
 * (including json tags). `root_folder_path` comes from Go `driver.RootPath`.
 */
export interface AListV3Addition {
  /** Remote server address (Go: `Address`, json tag "url") */
  url: string
  /** Password for meta/directory access (Go: `MetaPassword`, json "meta_password") */
  meta_password?: string
  /** Login username (Go: `Username`, json "username") */
  username?: string
  /** Login password (Go: `Password`, json "password") */
  password?: string
  /** Access token; auto-refreshed via /api/auth/login when username is set */
  token?: string
  /**
   * Pass client IP to the upstream server (X-Forwarded-For / X-Real-Ip).
   * Kept for config parity with Go; no-op in this port because NextList
   * drivers do not receive the client request context.
   */
  pass_ip_to_upsteam?: boolean
  /**
   * Pass client User-Agent to the upstream server.
   * Kept for config parity with Go; no-op in this port (same reason).
   */
  pass_ua_to_upsteam?: boolean
  /**
   * Forward archive (compressed file) requests to the upstream server.
   * Kept for config parity with Go; archive features are not ported.
   */
  forward_archive_requests?: boolean
  /** Root path on the remote server (Go `driver.RootPath`) */
  root_folder_path?: string
  /** Local sort field (NextList common addition; Go uses LocalSort) */
  order_by?: string
  /** Local sort direction (NextList common addition) */
  order_direction?: string
}

/** Go types.go `ObjResp` */
export interface AListV3ObjResp {
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

/** Go types.go `FsListResp` */
export interface AListV3FsListResp {
  /** null when the directory is empty */
  content: AListV3ObjResp[] | null
  total: number
  readme: string
  write: boolean
  provider: string
}

/** Go types.go `FsGetResp` (ObjResp + link fields) */
export interface AListV3FsGetResp extends AListV3ObjResp {
  raw_url: string
  readme: string
  provider: string
  related?: AListV3ObjResp[] | null
}

/** Go types.go `LoginResp` */
export interface AListV3LoginResp {
  token: string
}

/**
 * Go types.go `MeResp`. `role` is an `IntSlice` in Go — it may arrive as a
 * single int (older servers) or an array of ints.
 */
export interface AListV3MeResp {
  id: number
  username: string
  password: string
  base_path: string
  role: number | number[]
  disabled: boolean
  permission: number
  sso_id: string
  otp: boolean
}

/** Unified `{ code, message, data }` response envelope (Go server/common.Resp) */
export interface AListV3Resp<T = any> {
  code: number
  message: string
  data?: T
}

/** Go model.PageReq + ListReq body for POST /api/fs/list */
export interface AListV3ListReq {
  page: number
  per_page: number
  path: string
  password: string
  refresh: boolean
}
