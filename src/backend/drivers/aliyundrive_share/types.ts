// AliyundriveShare (阿里云盘分享) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/aliyundrive_share

/** Mirrors Go meta.go `Addition` (including embedded driver.RootID) */
export interface AliyundriveShareAddition {
  /** Go: RefreshToken `json:"refresh_token"` — aliyun account refresh token */
  refresh_token: string
  /** Go: ShareId `json:"share_id"` — share id, part after /s/ in the share link */
  share_id: string
  /** Go: SharePwd `json:"share_pwd"` — share password (empty for public shares) */
  share_pwd?: string
  /** embedded driver.RootID in Go — sub folder id inside the share ("root" = share root) */
  root_folder_id?: string
  /** Go: OrderBy `json:"order_by"` — applied server-side by the alipan API */
  order_by?: "name" | "size" | "updated_at" | "created_at"
  /** Go: OrderDirection `json:"order_direction"` — applied server-side by the alipan API */
  order_direction?: "ASC" | "DESC"
}

/** Go base.TokenResp — response of POST /v2/account/token */
export interface TokenResp {
  access_token: string
  refresh_token?: string
  /** not read by the Go driver, used here to emulate its 2h refresh cron */
  expires_in?: number
}

/** Go ErrorResp — alipan error body {"code": "...", "message": "..."} */
export interface ErrorResp {
  code: string
  message: string
}

/** Go ShareTokenResp — response of POST /v2/share_link/get_share_token */
export interface ShareTokenResp {
  share_token: string
  expire_time?: string
  expires_in?: number
}

/** Go File — item of POST /adrive/v3/file/list on a share link */
export interface ShareFile {
  drive_id?: string
  domain_id?: string
  file_id: string
  share_id?: string
  name: string
  type: "file" | "folder"
  created_at?: string
  updated_at?: string
  parent_file_id?: string
  size?: number
  thumbnail?: string
}

/** Go ListResp */
export interface ShareListResp {
  items?: ShareFile[]
  next_marker?: string
  punished_file_count?: number
}

/** Go ShareLinkResp — response of POST /v2/file/get_share_link_download_url */
export interface ShareLinkResp {
  download_url: string
  url?: string
  thumbnail?: string
}
