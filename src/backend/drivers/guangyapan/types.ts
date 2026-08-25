// GuangYaPan (光速盘) driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/guangyapan
//
// offline.go (offline download tasks) is not ported — see driver header notes.

export interface GuangYaPanAddition {
  /** Full path in GuangYaPan cloud drive (name path, resolved to folder id) */
  root_path: string
  /** Phone number for SMS login, e.g. +86 13800000000 */
  phone_number: string
  /** Captcha token required by /v1/auth/verification */
  captcha_token: string
  /** Set true and save to send SMS code */
  send_code: boolean
  /** SMS verification code used with phone_number */
  verify_code: string
  /** Auto-generated after sending SMS code */
  verification_id: string
  /** Bearer access token (optional if refresh_token is provided) */
  access_token: string
  /** Refresh token for auto-login/auto-refresh */
  refresh_token: string
  /** Client ID for GuangYaPan API */
  client_id: string
  /** Optional custom device id (32 hex chars) */
  device_id: string
  /** Optional custom X-Device-Sign header */
  device_sign: string
  page_size: number
  /** Sort field used by the file list API (0..4) */
  order_by: number
  /** Sort direction used by the file list API (0 asc / 1 desc) */
  sort_type: number
}

/** Go: tokenResp */
export interface GuangYaPanTokenResp {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  sub: string
  error: string
  error_code: number
  error_description: string
}

/** Go: verificationResp */
export interface GuangYaPanVerificationResp {
  verification_id: string
  error: string
  error_code: number
  error_description: string
}

/** Go: captchaInitResp */
export interface GuangYaPanCaptchaInitResp {
  captcha_token: string
  expires_in: number
  error: string
  error_code: number
  error_description: string
}

/** Go: verifyResp */
export interface GuangYaPanVerifyResp {
  verification_token: string
  error: string
  error_code: number
  error_description: string
}

/** Go: userMeResp */
export interface GuangYaPanUserMeResp {
  sub: string
}

/** Go: fileItem (api file list entry) */
export interface GuangYaPanFile {
  fileId: string
  parentId: string
  fileName: string
  fileSize: number
  /** 2 = folder */
  resType: number
  ctime: number
  utime: number
}

/** Go: listResp */
export interface GuangYaPanListResp {
  code: number
  msg: string
  data: {
    total: number
    list: GuangYaPanFile[]
  }
}

/** Go: downloadResp */
export interface GuangYaPanDownloadResp {
  code: number
  msg: string
  data: {
    signedURL: string
    downloadUrl: string
  }
}

/** Go: createDirResp */
export interface GuangYaPanCreateDirResp {
  code: number
  msg: string
  data: {
    fileId: string
    fileName: string
    resType: number
    ctime: number
    utime: number
  }
}

/** Go: commonResp */
export interface GuangYaPanCommonResp {
  code: number
  msg: string
}

/** Go: taskResp — async delete/move/copy return a task id */
export interface GuangYaPanTaskResp {
  code: number
  msg: string
  data: {
    taskId: string
  }
}

/** Go: taskStatusResp */
export interface GuangYaPanTaskStatusResp {
  code: number
  msg: string
  data: {
    status: number
  }
}

/** Go: assetsInfoResp — storage usage */
export interface GuangYaPanAssetsInfoResp {
  code: number
  msg: string
  data: {
    totalSpaceSize: number
    usedSpaceSize: number
  }
}
