// WPS driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/wps
//
// Mirrors Go drivers/wps/types.go + meta.go Addition:
//   driver.RootPath → root_folder_path (flattened), Cookie → cookie,
//   Mode → mode (select Personal/Business), CustomUA → custom_ua.

/** Go meta.go Addition */
export interface WpsAddition {
  root_folder_path?: string
  cookie: string
  mode?: string // "Personal" | "Business"
  custom_ua?: string
}

/** Go types.go apiResult */
export interface WpsApiResult {
  result?: string
  msg?: string
}

/** Go types.go loginState — account.kdocs.cn/api/v3/islogin response */
export interface WpsLoginState {
  account_num?: number
  companyid?: number
  current_companyid?: number
  is_company_account?: boolean
  is_plus?: boolean
  loginmode?: string
  userid?: number
}

/** Go types.go Group */
export interface WpsGroup {
  company_id?: number
  group_id: number
  name: string
  type?: string
}

/** Go types.go groupsResp (Business mode) */
export interface WpsGroupsResp {
  groups?: WpsGroup[]
}

/** Go types.go personalGroupsResp (Personal mode) */
export interface WpsPersonalGroupsResp extends WpsApiResult {
  groups?: Array<{ id: number; name: string }>
}

/** Go types.go filePerms */
export interface WpsFilePerms {
  download?: number
}

/** Go types.go FileInfo */
export interface WpsFileInfo {
  groupid: number
  parentid: number
  fname: string
  fsize: number
  ftype: string // "folder" or a file marker
  ctime: number // unix seconds
  mtime: number // unix seconds
  id: number
  deleted?: boolean
  file_perms_acl?: WpsFilePerms
}

/** Go types.go filesResp */
export interface WpsFilesResp {
  files?: WpsFileInfo[]
  next_offset?: number
}

/** Go types.go downloadResp */
export interface WpsDownloadResp extends WpsApiResult {
  url?: string
}

/** Go types.go uploadCreateUpdateResp */
export interface WpsUploadCreateResp extends WpsApiResult {
  method?: string
  url?: string
  store?: string
  request?: {
    headers?: Record<string, string>
    formData?: Record<string, string>
  }
  response?: {
    expect_code?: number[]
    args_etag?: string
    args_key?: string
  }
}

/** Go types.go uploadPutResp */
export interface WpsUploadPutResp {
  newfilename?: string
  sha1?: string
  md5?: string
}

/**
 * Go types.go Obj — resolved node for a physical (name) path.
 * kind mirrors the Go field: "root" | "group" | "folder" | "file".
 */
export interface WpsNode {
  kind: "root" | "group" | "folder" | "file"
  name: string
  groupID: number
  /** file id within the group (0 for groups / root) */
  fileID: number
  /** parent file id within the group (0 = group root) */
  parentID: number
  /** only FileInfo-backed nodes have a file id */
  hasFile: boolean
  canDownload: boolean
  size: number
  mtime: number
  ctime: number
}
