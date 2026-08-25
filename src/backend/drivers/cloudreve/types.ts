// Cloudreve driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudreve
//
// Cloudreve v3 self-hosted cloud disk. Session-cookie auth, REST API under
// /api/v3. Path-based listing (uri = root_folder_path + virtual path), while
// object write/link operations address objects by id (resolved by listing the
// parent directory).

export interface CloudreveAddition {
  /** driver.RootPath — json "root_folder_path" */
  root_folder_path?: string
  address: string
  username?: string
  password?: string
  /** cloudreve-session cookie value; auto-refreshed on login */
  cookie?: string
  custom_ua?: string
  enable_thumb_and_folder_size?: boolean
}

/** Envelope of every /api/v3 response */
export interface CloudreveResp {
  code: number
  msg: string
  data?: any
}

export interface CloudrevePolicy {
  id: string
  name: string
  type: string // "local" | "remote" | "onedrive" | "s3" | ...
  max_size?: number
  file_type?: string[]
}

export interface CloudreveUploadInfo {
  /** json tag "sessionID" (capital) in Go */
  sessionID: string
  chunkSize: number
  expires?: number
  uploadURLs?: string[]
  /** local policy: chunk credential */
  credential?: string
  /** s3 policy: multipart completion URL */
  completeURL?: string
}

export interface CloudreveObject {
  id: string
  name: string
  path?: string
  pic?: string
  size?: number
  type: string // "dir" | "file"
  date?: string
  create_date?: string
  source_enabled?: boolean
}

export interface CloudreveDirectoryResp {
  parent?: string
  objects?: CloudreveObject[]
  policy?: CloudrevePolicy
}

export interface CloudreveDirectoryProp {
  size?: number
}

export interface CloudreveSiteConfig {
  loginCaptcha?: boolean
  captcha_type?: string
}

export interface CloudreveStorageDetails {
  used?: number
  free?: number
  total?: number
}
