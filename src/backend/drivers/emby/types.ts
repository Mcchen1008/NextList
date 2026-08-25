// Emby driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/emby

export interface EmbyAddition {
  /** Root item id to mount ("1" lists all libraries). Defaults to "1". */
  root_folder_id?: string
  /** Emby server base URL, e.g. http://127.0.0.1:8096 */
  url: string
  /** Emby API key; when set, user_id must also be provided */
  api_key?: string
  /** Emby user id (required when api_key is set) */
  user_id?: string
  /** Username for AuthenticateByName login (alternative to api_key) */
  username?: string
  /** Password for AuthenticateByName login (may be empty for username-only) */
  password?: string
  /** Link method: "stream" (/Videos/{id}/stream) or "download" (/Items/{id}/Download) */
  link_method?: "stream" | "download"
}

/** GET /Users/{userId}/Items — single entry */
export interface EmbyItem {
  Name?: string
  Id?: string
  Type?: string
  Path?: string
  SeriesName?: string
  IndexNumber?: number
  ParentIndexNumber?: number
  IsFolder?: boolean
  Size?: number
  DateCreated?: string
}

/** GET /Users/{userId}/Items */
export interface EmbyListResp {
  Items?: EmbyItem[] | null
  TotalRecordCount?: number
}

/** POST /Users/AuthenticateByName */
export interface EmbyAuthResp {
  AccessToken?: string
  User?: {
    Id?: string
  }
}

/** GET /Users/{userId}/Items/{itemId}?Fields=MediaSources */
export interface EmbyItemDetailResp {
  MediaSources?: EmbyMediaSource[] | null
}

export interface EmbyMediaSource {
  Id?: string
  Container?: string
  SupportsDirectStream?: boolean
}
