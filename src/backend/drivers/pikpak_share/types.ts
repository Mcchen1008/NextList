// PikPakShare driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/pikpak_share

export interface PikPakShareAddition {
  /** driver.RootID — Go Config().DefaultRoot is empty for this driver */
  root_folder_id?: string
  share_id: string
  share_pwd?: string
  platform?: "android" | "web" | "pc"
  device_id?: string
  use_transcoding_address?: boolean
}

export interface PikPakShareMedia {
  media_id?: string
  media_name?: string
  video?: {
    height?: number
    width?: number
    duration?: number
    bit_rate?: number
    frame_rate?: number
    video_codec?: string
    audio_codec?: string
    video_type?: string
  }
  link?: {
    url: string
    token?: string
    expire?: string
  }
  need_more_quota?: boolean
  redirect_link?: string
  icon_link?: string
  is_default?: boolean
  priority?: number
  is_origin?: boolean
  resolution_name?: string
  is_visible?: boolean
  category?: string
}

export interface PikPakShareFile {
  id: string
  share_id?: string
  kind: string
  name: string
  modified_time?: string
  size?: string
  thumbnail_link?: string
  web_content_link?: string
  medias?: PikPakShareMedia[]
}

/** Response of share / share/detail / share/file_info endpoints */
export interface PikPakShareResp {
  share_status?: string
  share_status_text?: string
  file_info?: PikPakShareFile
  files?: PikPakShareFile[]
  next_page_token?: string
  pass_code_token?: string
}

export interface PikPakShareCaptchaTokenRequest {
  action: string
  captcha_token: string
  client_id: string
  device_id: string
  meta: Record<string, string>
  redirect_uri?: string
}

export interface PikPakShareCaptchaTokenResp {
  captcha_token: string
  expires_in?: number
  url?: string
}

/** Go types.go ErrResp */
export interface PikPakShareErrResp {
  error_code?: number
  error?: string
  error_description?: string
}
