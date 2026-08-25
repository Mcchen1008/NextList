// Teldrive driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/teldrive

/** Go meta.go Addition (incl. embedded driver.RootPath) */
export interface TeldriveAddition {
  /** driver.RootPath — path inside the teldrive drive used as mount root */
  root_folder_path?: string
  /** Address (json: url) — teldrive instance address, e.g. https://teldrive.com */
  url: string
  /** Cookie (json: cookie) — must start with "access_token=" (JWT session) */
  cookie: string
  /** UseShareLink (json: use_share_link) — create share links for downloads */
  use_share_link?: boolean
  /** ChunkSize (json: chunk_size) — upload chunk size in MiB (put not ported) */
  chunk_size?: number
  /** RandomChunkName (json: random_chunk_name) — upload only (put not ported) */
  random_chunk_name?: boolean
  /** UploadConcurrency (json: upload_concurrency) — upload only (put not ported) */
  upload_concurrency?: number
}

/** Go types.go Object */
export interface TeldriveObject {
  id: string
  name: string
  /** "folder" | "file" */
  type: string
  mimeType?: string
  parentId?: string
  size: number
  encrypted?: boolean
  updatedAt?: string
}

/** Go types.go ListResp */
export interface TeldriveListResp {
  items?: TeldriveObject[]
  meta?: {
    count?: number
    totalPages?: number
    currentPage?: number
  }
}

/** Go types.go ErrResp */
export interface TeldriveErrResp {
  code?: number
  message?: string
}

/** Go types.go ShareObj */
export interface TeldriveShareObj {
  id?: string
  protected?: boolean
  userId?: number
  type?: string
  name?: string
  expiresAt?: string
}

/** Go types.go FilePart (upload pipeline — kept for reference, put not ported) */
export interface TeldriveFilePart {
  name: string
  partId: number
  partNo: number
  channelId: number
  size: number
  encrypted: boolean
  salt: string
}
