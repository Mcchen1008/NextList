// UC网盘 (UC Drive) driver types — variant of quark_uc with different API config
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/quark_uc
export interface UcAddition {
  cookie: string
  root_id?: string
  order_by?: "none" | "file_type" | "file_name" | "updated_at"
  order_direction?: "asc" | "desc"
  use_transcoding_address?: boolean
  only_list_video_file?: boolean
}

export interface UcFile {
  fid: string
  pdir_fid: string
  file_name: string
  size: number
  updated_at: string
  category: number
  file_type: number
  thumbnail: string
  file?: boolean // present = file, absent = folder
  obj_category?: string
  status?: number
}

export interface UcSortResp {
  status: number
  code: number
  message: string
  data: {
    list: UcFile[]
    total: number
  }
}

export interface UcDownloadResp {
  status: number
  code: number
  message: string
  data: string
}
