// MediaFire driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mediafire

export interface MediaFireAddition {
  cookie: string
  session_token?: string
  order_by?: "name" | "time" | "size"
  order_direction?: "asc" | "desc"
  chunk_size?: number
  root_folder_path?: string
}

export interface MediaFireFile {
  id: string
  name: string
  size: number
  created_utc: string
  is_folder: boolean
}

export interface MediaFireFolder {
  folderKey: string
  name: string
  createdUTC: string
}

export interface MediaFireFileResp {
  quickKey: string
  filename: string
  size: string
  createdUTC: string
}

export interface MediaFireResponse<T = any> {
  response: T & {
    result: string
    message?: string
  }
}

export interface MediaFireFolderContentResp {
  response: {
    result: string
    folderContent: {
      folders: MediaFireFolder[]
      files: MediaFireFileResp[]
      moreChunks: "yes" | "no"
    }
  }
}

export interface MediaFireDirectDownloadResp {
  response: {
    result: string
    links: { directDownload: string }[]
  }
}

export interface MediaFireFolderCreateResp {
  response: {
    result: string
    folderKey: string
    name: string
    createdUTC: string
  }
}
