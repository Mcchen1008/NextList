// Doubao (豆包网盘, ByteDance) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/doubao
//
// Only the base doubao driver is ported — doubao_new (open platform) and
// doubao_share are out of scope.

export interface DoubaoAddition {
  /** embedded Go driver.RootID */
  root_folder_id: string
  /** browser cookie for www.doubao.com auth */
  cookie: string
  upload_thread: string
  download_api: "get_file_url" | "get_download_info"
  /** limit all api request rate ([limit]r/1s) */
  limit_rate: number
}

/** node_type constants (Go util.go) */
export const NODE_TYPE = {
  DIRECTORY: 1,
  FILE: 2,
  LINK: 3,
  IMAGE: 4,
  PAGES: 5,
  VIDEO: 6,
  AUDIO: 7,
  MEETING_MINUTES: 8,
} as const

/** Go: FileNodeType — node_type → type string for get_file_url */
export const FILE_NODE_TYPE: Record<number, string> = {
  1: "directory",
  2: "file",
  3: "link",
  4: "image",
  5: "pages",
  6: "video",
  7: "audio",
  8: "meeting_minutes",
}

/** Go: BaseResp / CommonResp */
export interface DoubaoBaseResp {
  code: number
  msg?: string
  message?: string
  error?: {
    code: number
    message: string
    locale: string
  }
}

/** Go: File */
export interface DoubaoFile {
  id: string
  name: string
  /** object key (uri) needed by download APIs */
  key: string
  /** 0: file, 1: folder (per API); see NODE_TYPE for full range */
  node_type: number
  size: number
  source: number
  parent_id: string
  create_time: number
  update_time: number
}

/** Go: NodeInfoResp */
export interface DoubaoNodeInfoResp extends DoubaoBaseResp {
  data: {
    node_info: DoubaoFile
    children: DoubaoFile[]
    next_cursor: string
    has_more: boolean
  }
}

/** Go: GetDownloadInfoResp */
export interface DoubaoGetDownloadInfoResp extends DoubaoBaseResp {
  data: {
    download_infos: Array<{
      node_id: string
      main_url: string
      backup_url: string
    }>
  }
}

/** Go: GetFileUrlResp */
export interface DoubaoGetFileUrlResp extends DoubaoBaseResp {
  data: {
    file_urls: Array<{
      uri: string
      main_url: string
      back_url: string
    }>
  }
}

/** Go: GetVideoFileUrlResp (only the fields used for the download link) */
export interface DoubaoGetVideoFileUrlResp extends DoubaoBaseResp {
  data: {
    media_type: string
    media_info: Array<{
      meta: {
        height: string
        width: string
        format: string
        duration: number
        codec_type: string
        definition: string
      }
      main_url: string
      backup_url: string
    }>
    original_media_info: {
      meta: {
        height: string
        width: string
        format: string
        duration: number
        codec_type: string
        definition: string
      }
      main_url: string
      backup_url: string
    }
    poster_url: string
    playable_status: number
  }
}

/** Go: UploadNodeResp — also used by MakeDir/Move */
export interface DoubaoUploadNodeResp extends DoubaoBaseResp {
  data: {
    node_list: Array<{
      local_id: string
      id: string
      parent_id: string
      name: string
      key: string
      node_type: number
    }>
  }
}

/** Go: UserInfoResp (trimmed to the fields we consume) */
export interface DoubaoUserInfoResp {
  data: {
    user_id: number
    user_id_str: string
    screen_name: string
    name: string
  }
  message: string
}
