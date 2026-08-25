// LenovoNasShare driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/lenovonas_share

export interface LenovoNasShareAddition {
  /** driver.RootPath */
  root_folder_path?: string
  share_id: string
  share_pwd: string
  host?: string
  show_root_folder?: boolean
}

/**
 * Go types.go File — the API reports times as unix seconds under the
 * `time` (create) / `chtime` (update) keys; `type` is "dir" for folders.
 */
export interface LenovoNasFile {
  name: string
  size: number
  /** create time, unix seconds */
  time?: number
  /** update time, unix seconds */
  chtime?: number
  path: string
  type?: string
}

/** Response of GET /oneproxy/api/share/v1/files */
export interface LenovoNasFilesResp {
  result?: boolean
  data?: {
    list?: LenovoNasFile[]
    has_more?: boolean
  }
  error?: { msg?: string }
}

/** Response of GET /oneproxy/api/share/v1/access */
export interface LenovoNasAccessResp {
  result?: boolean
  data?: {
    stoken?: string
    expires_in?: number
  }
  error?: { msg?: string }
}

/** Response of GET /oneproxy/api/share/v1/file/link */
export interface LenovoNasLinkResp {
  result?: boolean
  data?: {
    param?: {
      dtoken?: string
    }
  }
  error?: { msg?: string }
}
