// PikPak driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/pikpak

export interface PikPakAddition {
  username: string
  password: string
  platform?: "android" | "web" | "pc"
  refresh_token?: string
  captcha_token?: string
  device_id?: string
  disable_media_link?: boolean
  root_id?: string
  /** Persisted after refresh */
  access_token?: string
}

export interface PikPakFile {
  id: string
  kind: string
  name: string
  created_time?: string
  modified_time?: string
  hash?: string
  size?: string
  thumbnail_link?: string
  web_content_link?: string
  medias?: PikPakMedia[]
}

export interface PikPakMedia {
  media_id: string
  media_name: string
  link: { url: string; token: string; expire?: string }
}

export interface PikPakFilesResp {
  files: PikPakFile[]
  next_page_token?: string
}

export interface PikPakErrResp {
  error_code?: number
  error?: string
  error_description?: string
}

export interface PikPakTokenResp {
  access_token: string
  refresh_token: string
  sub?: string
  expires_in?: number
}

export interface PikPakCaptchaTokenResp {
  captcha_token: string
  expires_in?: number
  url?: string
}
