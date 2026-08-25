// Yandex Disk driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/yandex_disk

export interface YandexDiskAddition {
  refresh_token: string
  order_by?: "name" | "path" | "created" | "modified" | "size"
  order_direction?: "asc" | "desc"
  root_folder_path?: string
  use_online_api?: boolean
  api_url_address?: string
  client_id?: string
  client_secret?: string
  /** Persisted after refresh */
  access_token?: string
}

export interface YandexErrResp {
  message?: string
  description?: string
  error?: string
}

export interface YandexTokenErrResp {
  error?: string
  error_description?: string
}

export interface YandexFile {
  name: string
  size: number
  modified: string
  file: string
  preview: string
  path: string
  type: string // "dir" or "file"
}

export interface YandexFilesResp {
  _embedded: {
    sort: string
    items: YandexFile[]
    limit: number
    offset: number
    path: string
    total: number
  }
  name: string
  created: string
  modified: string
  path: string
  type: string
  revision: number
}

export interface YandexDownResp {
  href: string
  method: string
  templated: boolean
}

export interface YandexUploadResp {
  operation_id: string
  href: string
  method: string
  templated: boolean
}
