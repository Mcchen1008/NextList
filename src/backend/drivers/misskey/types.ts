// Misskey driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/misskey

/** Mirrors Go meta.go `Addition` (including embedded driver.RootPath) */
export interface MisskeyAddition {
  /** embedded driver.RootPath in Go — sub folder inside the Misskey drive */
  root_folder_path: string
  /** Go: Endpoint `json:"endpoint"` — instance origin, e.g. https://misskey.io */
  endpoint: string
  /** Go: AccessToken `json:"access_token"` — Misskey access token */
  access_token: string
}

/** Go Properties */
export interface MisskeyFileProperties {
  width: number
  height: number
}

/** Go MFile — a drive file */
export interface MisskeyFile {
  id: string
  createdAt: string
  name: string
  type: string
  md5: string
  size: number
  isSensitive: boolean
  blurhash: string
  properties: MisskeyFileProperties
  url: string
  thumbnailUrl: string
  comment: string | null
  folderId: string | null
  folder: MisskeyFolder | null
}

/** Go MFolder — a drive folder */
export interface MisskeyFolder {
  id: string
  createdAt: string
  name: string
  parentId: string | null
}
