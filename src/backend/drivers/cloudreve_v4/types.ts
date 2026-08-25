// Cloudreve V4 (Pro) driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudreve_v4
//
// Cloudreve v4 uses a token-based JSON API under /api/v4 with URI-based file
// addressing (default root "cloudreve://my"). Auth is an access/refresh token
// pair obtained via POST /session/token (email + password) or provided
// directly; mounts whose root_folder_path ends with "@share" are anonymous
// share mounts and skip authentication entirely.

export interface CloudreveV4Addition {
  /** driver.RootPath — json "root_folder_path", Go DefaultRoot "cloudreve://my" */
  root_folder_path?: string
  address: string
  username?: string
  password?: string
  access_token?: string
  refresh_token?: string
  custom_ua?: string
  enable_folder_size?: boolean
  enable_thumb?: boolean
  enable_version_upload?: boolean
  hide_uploading?: boolean
  order_by?: string // "name" | "size" | "updated_at" | "created_at"
  order_direction?: string // "asc" | "desc"
}

// API error codes (Go util.go)
export const CODE_LOGIN_REQUIRED = 401
export const CODE_PATH_NOT_EXIST = 40016
export const CODE_CREDENTIAL_INVALID = 40020
export const CODE_OBJECT_EXISTED = 40004

// file metadata keys (Go types.go)
export const METADATA_UPLOAD_SESSION_ID = "sys:upload_session_id"
export const METADATA_THUMB_DISABLED = "thumb:disabled"

export interface CloudreveV4Resp {
  code: number
  msg: string
  data?: any
}

export interface BasicConfigResp {
  instance_id?: string
  user?: {
    id?: string
    group?: { id?: string; name?: string; permission?: string }
  }
  /** only 'normal' is supported by the login flow */
  captcha_type?: string
}

export interface SiteLoginConfigResp {
  login_captcha?: boolean
}

export interface PrepareLoginResp {
  webauthn_enabled?: boolean
  password_enabled?: boolean
}

export interface CaptchaResp {
  image?: string
  ticket?: string
}

export interface AccessJWT {
  token_type?: string
  sub?: string
  exp?: number
  nbf?: number
}

export interface RefreshJWT {
  token_type?: string
  sub?: string
  exp?: number
  nbf?: number
  state_hash?: string
  root_token_id?: string
}

export interface CloudreveV4Token {
  access_token: string
  refresh_token: string
  access_expires?: string
  refresh_expires?: string
}

export interface TokenResponse {
  user?: {
    id?: string
    status?: string
    group?: { id?: string; name?: string; permission?: string }
  }
  token: CloudreveV4Token
}

export interface CloudreveV4File {
  /** 0: file, 1: folder */
  type: number
  id: string
  name: string
  created_at?: string
  updated_at?: string
  size?: number
  metadata?: Record<string, any>
  path?: string
  capability?: string
  owned?: boolean
  primary_entity?: string
}

export interface StoragePolicy {
  id?: string
  name?: string
  type?: string
  max_size?: number
  relay?: boolean
}

export interface Pagination {
  page?: number
  page_size?: number
  is_cursor?: boolean
  next_token?: string
}

export interface FileResp {
  files?: CloudreveV4File[]
  parent?: CloudreveV4File
  pagination?: Pagination
  props?: {
    capability?: string
    max_page_size?: number
    order_by_options?: string[]
    order_direction_options?: string[]
  }
  context_hint?: string
  mixed_type?: boolean
  storage_policy?: StoragePolicy
}

export interface FileUrlResp {
  urls?: { url: string }[]
  expires?: string
}

export interface FileUploadResp {
  session_id?: string
  chunk_size?: number
  expires?: number
  storage_policy?: StoragePolicy
  uri?: string
  /** for S3-like */
  completeURL?: string
  /** for S3-like, OneDrive */
  callback_secret?: string
  /** for not-local */
  upload_urls?: string[]
  /** for local */
  credential?: string
}

export interface FileDeleteRespItem {
  path?: string
  token?: string
  type?: number
}

export interface FileDeleteResp {
  code?: number
  msg?: string
  data?: FileDeleteRespItem[]
}

export interface FileThumbResp {
  url?: string
  expires?: string
}

export interface FolderSummaryResp extends CloudreveV4File {
  folder_summary?: {
    size?: number
    files?: number
    folders?: number
    completed?: boolean
    calculated_at?: string
  }
}

export interface CapacityResp {
  total?: number
  used?: number
}
