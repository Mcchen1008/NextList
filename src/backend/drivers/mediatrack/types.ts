// MediaTrack (分秒帧) driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mediatrack

export interface MediaTrackAddition {
  access_token: string
  project_id?: string
  root_id?: string
  order_by?: "updated_at" | "title" | "size"
  order_desc?: boolean
}

export interface MediaTrackFile {
  category: number
  comment_count?: number
  cover_asset_id?: string
  created_at: string
  deleted_at?: string
  description?: string
  file?: {
    cover?: string
    src?: string
  }
  id: string
  size?: string
  thumbnails?: any[]
  title: string
  updated_at: string
}

export interface MediaTrackChildrenResp {
  status: string
  message?: string
  data: {
    total: number
    assets: MediaTrackFile[]
  }
}

export interface MediaTrackBaseResp {
  status: string
  message?: string
}

export interface MediaTrackDownloadTokenResp {
  status: string
  message?: string
  data: {
    token: string
  }
}

export interface MediaTrackUploadResp {
  status: string
  message?: string
  data: {
    credentials: {
      TmpSecretId: string
      TmpSecretKey: string
      Token: string
      ExpiredTime?: number
      Expiration?: string
      StartTime?: number
    }
    object: string
    bucket: string
    region: string
    url: string
    size?: string
  }
}
