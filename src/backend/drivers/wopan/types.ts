// WoPan (联通云盘) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/wopan
// (API wire format mirrors github.com/OpenListTeam/wopan-sdk-go v0.1.5)

export type WopanSortRule =
  | "name_asc"
  | "name_desc"
  | "time_asc"
  | "time_desc"
  | "size_asc"
  | "size_desc"

export interface WopanAddition {
  /** Root directory id, defaults to "0" (Go Config().DefaultRoot) */
  root_folder_id?: string
  /** Refresh token (required) */
  refresh_token: string
  /** Family id; empty → personal drive */
  family_id?: string
  /** Server-side sort rule */
  sort_rule?: WopanSortRule
  /** Access token (auto-refreshed from refresh_token when missing/expired) */
  access_token?: string
}

/** File entry returned by QueryAllFiles */
export interface WopanFile {
  familyId?: number
  fid: string
  creator?: string
  size?: number
  createTime?: string // "yyyyMMddHHmmss" in UTC+8
  name: string
  shootingTime?: string
  id: string
  type: number // 0 → folder
  thumbUrl?: string
  fileType?: string
}

export interface QueryAllFilesData {
  files?: WopanFile[] | null
}

export interface GetDownloadUrlV2Data {
  type?: number
  list?: {
    fid?: string
    downloadUrl?: string
  }[]
}

export interface FamilyUserCurrentEncodeData {
  count?: string
  defaultHomeId?: number
  defaultHomeName?: string
  groupName?: string
  id?: number
  memberRole?: string
}

export interface AppQueryUserData {
  userId?: string
  userName?: string
}

export interface AppRefreshTokenData {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

export interface ClassifyRuleData {
  fileTypes?: Record<
    string,
    { subType?: string; ability?: string; type?: string }
  >
}

export interface CreateDirectoryData {
  id?: string
}

/** Envelope of POST /{channel}/dispatcher (wopan-sdk-go types.go Resp) */
export interface WopanResp {
  STATUS?: string
  MSG?: string
  LOGID?: string
  RSP?: {
    RSP_CODE?: string
    RSP_DESC?: string
    DATA?: any
  }
}
