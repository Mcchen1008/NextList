// FebBox driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/febbox

export interface FebBoxAddition {
  /** driver.RootID — Go Config().DefaultRoot is "0" */
  root_folder_id?: string
  client_id: string
  client_secret: string
  /**
   * Internal field — Go meta.go declares `RefreshToken string` WITHOUT a json
   * tag, so OpenList's form generator (getAdditionalItems skips untagged
   * fields) never shows it. It is populated automatically after the first
   * token fetch and persisted by the Go driver. NextList keeps it out of the
   * admin form too; the driver accepts it for persistence round-trips.
   */
  refresh_token?: string
  /** server-side sort rule: size_asc,size_desc,name_asc,name_desc,update_asc,update_desc,ext_asc,ext_desc */
  sort_rule?: string
  page_size?: number
  /** user ip address for download link which can speed up the download */
  user_ip?: string
}

/** Go types.go ErrResp — error envelope of https://api.febbox.com/oauth */
export interface FebBoxErrResp {
  code?: number
  msg?: string
  server_runtime?: number
  server_name?: string
}

/** Response of POST https://api.febbox.com/oauth/token (customTokenSource) */
export interface FebBoxTokenResp {
  code: number
  msg?: string
  data: {
    access_token: string
    expires_in?: number
    token_type?: string
    scope?: string
    refresh_token?: string
  }
}

export interface FebBoxRules {
  allow_copy?: number
  allow_delete?: number
  allow_download?: number
  allow_comment?: number
  hide_location?: number
}

/** Go types.go File (only fields consumed by the driver are kept typed) */
export interface FebBoxFile {
  fid: number
  uid?: number
  file_size?: number
  path?: string
  file_name: string
  ext?: string
  add_time?: number
  file_create_time?: number
  file_update_time?: number
  parent_id?: number
  is_dir?: number
  hash?: string
  hash_type?: string
  thumb?: string
  thumb_small?: string
  thumb_big?: string
  status?: number
  rules?: FebBoxRules
}

export interface FebBoxFileListResp extends FebBoxErrResp {
  data?: {
    file_list?: FebBoxFile[]
    show_type?: string
  }
}

export interface FebBoxDownloadItem {
  error?: number
  download_url: string
  hash?: string
  hash_type?: string
  fid?: number
  file_name?: string
  parent_id?: number
  file_size?: number
  ext?: string
  thumb?: string
  vip_link?: number
}

export interface FebBoxDownloadResp extends FebBoxErrResp {
  data?: FebBoxDownloadItem[]
}
