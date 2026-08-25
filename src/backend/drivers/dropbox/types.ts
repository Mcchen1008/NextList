// Dropbox driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/dropbox

export interface DropboxAddition {
  /**
   * Go driver.RootPath → root_folder_path. Dropbox paths are "/"-rooted and
   * "" (empty) means the Dropbox root, so the default is empty (Go
   * Config().DefaultRoot is "").
   */
  root_folder_path?: string
  use_online_api?: boolean
  api_url_address?: string
  client_id?: string
  client_secret?: string
  /**
   * Internal access token. Go declares `AccessToken string` without a json
   * tag, so it is hidden from the admin form (op.getAdditionalItems skips
   * untagged fields) and is only persisted inside the storage addition.
   * Auto-refreshed from refresh_token; not part of the form.
   */
  access_token?: string
  refresh_token: string
  /** Go json tag is exactly "RootNamespaceId" (capital R and N) */
  RootNamespaceId?: string
  // Local sort controls (Go relies on the AList server-side sort because
  // Config().LocalSort is false; NextList has no server-side sort, so the
  // driver sorts locally with these).
  order_by?: string
  order_direction?: string
}

/** Go types.go TokenResp */
export interface TokenResp {
  access_token?: string
  token_type?: string
  expires_in?: number
}

/** Go types.go ErrorResp */
export interface ErrorResp {
  error?: { ".tag"?: string }
  error_summary?: string
}

/** Go types.go RefreshTokenErrorResp */
export interface RefreshTokenErrorResp {
  error?: string
  error_description?: string
}

/** Online API relay response (Go util.go refreshToken online branch) */
export interface OnlineApiResp {
  refresh_token?: string
  access_token?: string
  text?: string
}

/** Go types.go CurrentAccountResp */
export interface CurrentAccountResp {
  root_info?: {
    root_namespace_id?: string
    home_namespace_id?: string
  }
}

/** Go types.go File — a list_folder entry (".tag" is "file" or "folder") */
export interface DropboxFile {
  ".tag"?: string
  name: string
  path_lower?: string
  path_display?: string
  id?: string
  client_modified?: string
  server_modified?: string
  rev?: string
  size?: number
  is_downloadable?: boolean
  content_hash?: string
}

/** Go types.go ListResp */
export interface ListResp {
  entries?: DropboxFile[]
  cursor?: string
  has_more?: boolean
}

/** Go types.go UploadCursor */
export interface UploadCursor {
  offset: number
  session_id: string
}

/** Go types.go UploadAppendArgs */
export interface UploadAppendArgs {
  close: boolean
  cursor: UploadCursor
}

/** Go types.go UploadFinishArgs */
export interface UploadFinishArgs {
  commit: {
    autorename: boolean
    mode: string
    mute: boolean
    path: string
    strict_conflict: boolean
  }
  cursor: UploadCursor
}
