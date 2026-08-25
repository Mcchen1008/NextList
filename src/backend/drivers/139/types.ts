// 139 云盘 (Mcloud / 和彩云) driver types — simplified to "personal_new" variant
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/139
export interface Cloud139Addition {
  authorization: string // Base64 of "type:account:token|timestamp|..."
  username?: string
  password?: string
  mail_cookies?: string
  root_id?: string
  type?: "personal_new" | "personal" | "family" | "group" | "share"
}

export interface Cloud139File {
  contentID?: string
  contentName?: string
  contentSize?: number
  updateTime?: string
  createTime?: string
  thumbnailURL?: string
  digest?: string
  // For new personal API:
  file_id?: string
  name?: string
  size?: number
  updated_at?: string
  created_at?: string
  type?: string // "folder" or "file"
}

export interface Cloud139ListResp {
  success?: boolean
  code?: string
  message?: string
  data?: {
    getTotalDiskResult?: {
      catalogList?: any[]
      contentList?: any[]
      nodeCount?: number
    }
    fileList?: Cloud139File[]
    total?: number
  }
}
