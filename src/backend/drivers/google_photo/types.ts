// Google Photo driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/google_photo

export interface GooglePhotoAddition {
  /**
   * Go driver.RootID → root_folder_id. "root" (the Go Config().DefaultRoot)
   * opens the virtual root (all / albums / share_albums); an album id opens
   * that album directly.
   */
  root_folder_id?: string
  refresh_token: string
  client_id?: string
  client_secret?: string
  /**
   * Present in the Go meta.go Addition but never referenced by the Go driver
   * — kept for form parity only.
   */
  show_archive?: boolean
  // Local sort controls (Go Config().LocalSort = true)
  order_by?: string
  order_direction?: string
}

/** Go types.go TokenResp */
export interface TokenResp {
  access_token?: string
  token_type?: string
  expires_in?: number
}

/** Go types.go TokenError */
export interface TokenError {
  error?: string
  error_description?: string
}

export interface PhotoDetail {}

export interface VideoDetail {}

/** Go types.go MediaMetadata */
export interface MediaMetadata {
  creationTime?: string
  width?: string
  height?: string
  photo?: PhotoDetail
  video?: VideoDetail
}

/**
 * Go types.go MediaItem — used for both albums (id/title/
 * coverPhotoBaseUrl only) and media items (id/baseUrl/mimeType/filename/
 * mediaMetadata). Which flavor you get depends on the `fields` mask of the
 * listing call.
 */
export interface MediaItem {
  id: string
  title?: string
  baseUrl?: string
  coverPhotoBaseUrl?: string
  mimeType?: string
  filename?: string
  mediaMetadata?: MediaMetadata
}

/** Go types.go Items — combined albums / sharedAlbums / mediaItems page */
export interface Items {
  nextPageToken?: string
  mediaItems?: MediaItem[]
  albums?: MediaItem[]
  sharedAlbums?: MediaItem[]
}

export interface GoogleApiErrorDetail {
  domain?: string
  reason?: string
  message?: string
  location_type?: string
  location?: string
}

/** Go types.go Error */
export interface GoogleApiError {
  error?: {
    errors?: GoogleApiErrorDetail[]
    code?: number
    message?: string
  }
}
