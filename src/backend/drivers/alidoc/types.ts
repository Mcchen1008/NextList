// AliDoc (阿里云文档/钉钉文档) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/alidoc
// API base: https://alidocs.dingtalk.com (DingTalk docs web API, cookie auth).

export interface AliDocAddition {
  /** driver.RootID — root folder dentry UUID (required by Go Init()) */
  root_folder_id?: string
  /** DingTalk docs web cookie */
  cookie: string
}

/** common response envelope (Go apiResp) */
export interface AliDocApiResp {
  status?: number
  isSuccess?: boolean
  message?: string
  msg?: string
}

/** GET /box/api/v2/dentry/list response */
export interface AliDocListResp extends AliDocApiResp {
  data?: {
    children?: AliDocDentry[]
  }
}

/** GET /box/api/v2/file/download response */
export interface AliDocDownloadResp extends AliDocApiResp {
  data?: {
    ossUrlPreSignatureInfo?: {
      preSignUrls?: string[]
    }
  }
}

export interface AliDocDentry {
  dentryType?: string
  dentryUuid?: string
  parentDentryUuid?: string
  name?: string
  path?: string
  fileSize?: number
  /** unix milliseconds */
  createdTime?: number
  /** unix milliseconds */
  updatedTime?: number
  contentType?: string
  extension?: string
  dentryStatistic?: {
    childrenCount?: number
  }
  url?: {
    pcChildAppPreviewUrl?: string
    pcChildAppUrl?: string
  }
}
