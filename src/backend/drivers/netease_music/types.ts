/**
 * NetEaseMusic driver types.
 * Ported from OpenList drivers/netease_music (Go v4).
 */

export interface NeteaseMusicAddition {
  cookie: string
  /** Max number of cloud songs to list (default 200) */
  song_limit?: number | string
  /** Sort field: name | size | updated_at */
  order_by?: string
  /** Sort direction: asc | desc */
  order_direction?: string
}

/** POST /weapi/v1/cloud/get */
export interface NeteaseListResp {
  size?: number
  maxSize?: number
  data: Array<{
    addTime: number
    fileName: string
    fileSize: number
    songId: number
    simpleSong: {
      al: {
        picUrl: string
      }
    }
  }>
}

/** POST /api/song/enhance/player/url (linuxapi) */
export interface NeteaseSongResp {
  data: Array<{
    url: string
  }>
}

/** GET /lbs?version=1.0&bucketname=... (upload host) */
export interface NeteaseHostsResp {
  upload: string[]
}

/** POST /api/song/lyric */
export interface NeteaseLyricResp {
  lrc?: {
    lyric?: string
  }
}

/** POST /weapi/nos/token/alloc */
export interface NeteaseTokenResp {
  result: {
    resourceId: string
    objectKey: string
    token: string
  }
}

/** POST /weapi/cloud/upload/check */
export interface NeteaseCheckResp {
  songId?: number | string
  needUpload?: boolean
}

export interface NeteaseUploadToken {
  resourceId: string
  objectKey: string
  token: string
}

/** Metadata of a cloud song (kept in the driver's name → songId index). */
export interface NeteaseSongMeta {
  songId: string
  name: string
  size: number
  addTime: number
  picUrl: string
}
