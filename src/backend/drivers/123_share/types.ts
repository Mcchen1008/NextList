// 123PanShare (123云盘分享) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/123_share

/** Mirrors Go meta.go `Addition` (including embedded driver.RootID) */
export interface Pan123ShareAddition {
  /** Go: ShareKey `json:"sharekey" required:"true"` — share key from the share link */
  sharekey: string
  /** Go: SharePwd `json:"sharepassword"` — share password (empty for public shares) */
  sharepassword?: string
  /** embedded driver.RootID in Go — sub folder id inside the share ("0" = share root) */
  root_folder_id?: string
  /**
   * Go: AccessToken `json:"accesstoken" type:"text"` — optional 123Pan account
   * access token (Bearer). The share endpoints usually work without it.
   */
  accesstoken?: string
}

/** Go types.go File — one item of a 123Pan share */
export interface Pan123ShareFile {
  FileName: string
  Size: number
  /** ISO 8601 timestamp, e.g. "2023-08-25T10:00:00.000+08:00" */
  UpdateAt: string
  FileId: number
  /** 0 = file, 1 = folder */
  Type: number
  Etag: string
  S3KeyFlag: string
  /** thumbnail url (only present for images) */
  DownloadUrl?: string
}

/** Go types.go Files — response of GET /b/api/share/get */
export interface Pan123ShareFilesResp {
  code: number
  message?: string
  data: {
    InfoList: Pan123ShareFile[]
    Next: string
  }
}

/** Go driver.go Link — response of POST /b/api/share/download/info */
export interface Pan123ShareDownloadResp {
  code: number
  message?: string
  data: {
    DownloadURL: string
  }
}
