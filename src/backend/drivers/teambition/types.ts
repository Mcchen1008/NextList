// Teambition driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/teambition

export interface TeambitionAddition {
  region?: "china" | "international"
  cookie: string
  project_id: string
  root_id?: string
  order_by?: "fileName" | "fileSize" | "updated" | "created"
  order_direction?: "Asc" | "Desc"
  use_s3_upload_method?: boolean
}

export interface TeambitionCollection {
  _id: string
  title: string
  updated: string
}

export interface TeambitionWork {
  _id: string
  fileName: string
  fileSize: number
  fileKey?: string
  fileCategory?: string
  downloadUrl?: string
  thumbnailUrl?: string
  thumbnail?: string
  updated: string
  previewUrl?: string
}

export interface TeambitionErrResp {
  name?: string
  message?: string
}
