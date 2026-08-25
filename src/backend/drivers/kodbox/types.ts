// KodBox (可道云) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/kodbox

export interface KodBoxAddition {
  /** Go driver.RootPath: root folder path inside KodBox (json: root_folder_path) */
  root_folder_path?: string
  /** KodBox server address, e.g. http://127.0.0.1:8080 */
  address: string
  username: string
  password: string
}

/**
 * KodBox API envelope (Go types.go CommonResp).
 * `code` is a bool on success/failure, or the string "10001" when the
 * accessToken has expired (see util.ts retry logic).
 */
export interface KodBoxCommonResp {
  code?: boolean | string | number
  timeUse?: string
  timeNow?: string
  data?: unknown
  info?: unknown
}

/** Entry of `explorer/list/path` → data.folderList / data.fileList */
export interface KodBoxFolderOrFile {
  name: string
  path: string
  type: string // "folder" | "file"
  /** file-only field */
  ext?: string
  size?: number
  /** unix seconds */
  createTime?: number
  /** unix seconds */
  modifyTime?: number
}

export interface KodBoxListPathData {
  folderList?: KodBoxFolderOrFile[]
  fileList?: KodBoxFolderOrFile[]
}
