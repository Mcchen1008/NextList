// ChaoXing (超星学习通小组网盘) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/chaoxing
//
// NOTE: despite the "pan-yz.chaoxing.com personal cloud" description sometimes
// attached to this driver, the Go source mounts the ChaoXing *group* drive
// (groupweb.chaoxing.com, identified by `bbsid`); pan-yz.chaoxing.com is only
// the raw upload endpoint used by Put(). This port follows the Go source.

export interface ChaoxingAddition {
  /** 超星账号（手机号/用户名） */
  user_name: string
  password: string
  /** 小组 id，从小组页面 URL 的 bbsid 参数获取 */
  bbsid: string
  /** 根目录 id（Go driver.RootID，Config().DefaultRoot = "-1"） */
  root_folder_id?: string
  /** 可不填：填写了 user_name/password 会自动登录刷新 */
  cookie?: string
  /** local sort (NextList addition; Go has no such field — server sorted) */
  order_by?: "name" | "size" | "modified"
  order_desc?: boolean
}

/** Common `{result, msg, status, list}` envelope of groupweb.chaoxing.com */
export interface ChaoxingListResp {
  msg: string
  result: number
  status: boolean
  list?: ChaoxingFile[]
}

/**
 * File entry of /pc/resource/getResourceList.
 *
 * 网页端上传的文件 content 里 puid/size/uploadDate 是数字，
 * 手机端上传的是字符串（"puid": "54321"），解析时统一兼容。
 * uploadDate 还有第三种形式：日期字符串 "2024-11-06 07:49"。
 */
export interface ChaoxingFile {
  cataid: number
  cfid: number
  content: {
    cfid: number
    pid: number
    folderName: string
    shareType: number
    preview: string
    filetype: string
    previewUrl: string
    isImg: boolean
    parentPath: string
    icon: string
    suffix: string
    duration: number
    pantype: string
    /** int | numeric-string */
    puid: number | string
    filepath: string
    crc: string
    isfile: boolean
    residstr: string
    objectId: string
    extinfo: string
    thumbnail: string
    creator: number
    resTypeValue: number
    uploadDateFormat: string
    disableOpt: boolean
    downPath: string
    sort: number
    topsort: number
    restype: string
    /** int | numeric-string (bytes) */
    size: number | string
    /** ms timestamp (number | numeric-string) or "yyyy-MM-dd HH:mm[:ss]" */
    uploadDate: number | string
    fileSize: string
    name: string
    fileId: string
  }
  creatorId: number
  des_id: string
  id: number
  /** ms timestamp */
  inserttime: number | string
  key: string
  norder: number
  ownerId: number
  ownerType: number
  path: string
  rid: number
  status: number
  topsign: number
}

/** noteyd.chaoxing.com /screen/note_note/files/status/{fileId} response */
export interface ChaoxingDownResp {
  msg: string
  duration: number
  download: string
  fileStatus: string
  url: string
  status: boolean
}

/** pan-yz.chaoxing.com/pc/files/getUploadConfig response */
export interface ChaoxingUploadConfigResp {
  result: number
  msg: {
    puid: number
    token: string
  }
}

/** pan-yz.chaoxing.com/upload response */
export interface ChaoxingUploadFileResp {
  result: boolean
  msg: string
  crc: string
  objectId: string
  resid: number
  puid: number
  data: Record<string, unknown>
}

/**
 * Resolved chaoxing object: dir id is `String(f.ID)`, file id is
 * `fmt.Sprintf("%d$%s", f.ID, f.Content.FileID)` (Go fileToObj()).
 */
export interface ChaoxingEntry {
  name: string
  /** dir: "<id>"; file: "<id>$<fileId>" */
  id: string
  isDir: boolean
  size: number
  /** ms epoch */
  modified: number
}
