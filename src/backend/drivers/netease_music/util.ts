/**
 * NetEaseMusic HTTP client & business logic.
 * Ported from OpenList drivers/netease_music/{util,upload}.go.
 *
 * Covers: cloud song listing, song play URL (linuxapi), lyric fetch,
 * song deletion and the cloud-disk upload pipeline
 * (check → alloc token → nos upload → publish).
 */

import { md5 } from "../../pkg/crypto"
import { FileItem, calcFileType } from "../../internal/driver/base"
import { weapi, linuxapi, eapi, buildCharacteristic } from "./crypto"
import {
  NeteaseMusicAddition,
  NeteaseListResp,
  NeteaseSongResp,
  NeteaseHostsResp,
  NeteaseLyricResp,
  NeteaseTokenResp,
  NeteaseSongMeta,
  NeteaseUploadToken,
} from "./types"

const CLOUD_BUCKET = "jd-musicrep-privatecloud-audio-public"
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36"

interface ReqOptions {
  crypto?: "weapi" | "linuxapi" | "eapi"
  data?: Record<string, any>
  cookies?: Record<string, string>
  headers?: Record<string, string>
  /** Raw binary body (upload); skips form encoding */
  body?: Uint8Array
}

/** Replace the API segment (`/weapi/`, `/api/`, `/eapi/`) with `replacement`. */
function rewriteApiPath(url: string, replacement: string): string {
  return url.replace(/\/(\w*api)\//, "/" + replacement + "/")
}

function getCookieValue(cookieStr: string, key: string): string {
  const parts = cookieStr.split(";").map((p) => p.trim())
  for (const part of parts) {
    const idx = part.indexOf("=")
    if (idx !== -1 && part.substring(0, idx).trim() === key) {
      return part.substring(idx + 1).trim()
    }
  }
  return ""
}

function appendCookies(
  cookieStr: string,
  extra: Record<string, string>,
): string {
  const parts = cookieStr
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
  for (const [k, v] of Object.entries(extra)) {
    const existing = parts.findIndex((p) => p.startsWith(k + "="))
    const kv = `${k}=${v}`
    if (existing !== -1) parts[existing] = kv
    else parts.push(kv)
  }
  return parts.join("; ")
}

export class NeteaseClient {
  private addition: NeteaseMusicAddition
  private cookie: string
  private csrfToken: string
  private musicU: string
  /** fileName → song meta (populated by listSongs) */
  private songByName = new Map<string, NeteaseSongMeta>()
  /** lrcName → song meta */
  private lrcByName = new Map<string, NeteaseSongMeta>()

  constructor(addition: NeteaseMusicAddition) {
    this.addition = addition
    this.cookie = addition.cookie || ""
    this.csrfToken = getCookieValue(this.cookie, "__csrf")
    this.musicU = getCookieValue(this.cookie, "MUSIC_U")
  }

  init(): void {
    if (!this.csrfToken || !this.musicU) {
      throw new Error(
        "[NeteaseMusic] empty token: cookie must contain __csrf and MUSIC_U",
      )
    }
  }

  // ─── Core request ──────────────────────────────────────────────────────────

  private async request<T = any>(
    url: string,
    method: "GET" | "POST",
    opts: ReqOptions = {},
  ): Promise<T> {
    let finalUrl = url
    const headers: Record<string, string> = {}
    if (this.cookie) headers["Cookie"] = this.cookie
    if (url.includes("music.163.com")) {
      headers["Referer"] = "https://music.163.com"
    }

    let body: BodyInit | undefined
    if (opts.crypto === "weapi") {
      finalUrl = rewriteApiPath(url, "weapi")
      const enc = await weapi((opts.data || {}) as Record<string, string>)
      body = new URLSearchParams(enc)
    } else if (opts.crypto === "linuxapi") {
      finalUrl = "https://music.163.com/api/linux/forward"
      const apiUrl = rewriteApiPath(url, "api")
      const enc = await linuxapi({
        url: apiUrl,
        method,
        params: opts.data || {},
      })
      headers["User-Agent"] = LINUX_UA
      body = new URLSearchParams(enc)
    } else if (opts.crypto === "eapi") {
      finalUrl = rewriteApiPath(url, "eapi")
      const ch = buildCharacteristic(this.musicU)
      const enc = await eapi(url, {
        header: ch,
        ...(opts.data || {}),
      })
      // characteristic fields travel as cookies
      headers["Cookie"] = appendCookies(headers["Cookie"] || "", ch)
      body = new URLSearchParams(enc)
    } else if (opts.body) {
      body = opts.body as any
      headers["Content-Length"] = String(opts.body.length)
    } else if (opts.data) {
      body = new URLSearchParams(opts.data as Record<string, string>)
    }

    if (opts.cookies) {
      headers["Cookie"] = appendCookies(headers["Cookie"] || "", opts.cookies)
    }
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        headers[k] = v
      }
    }

    const res = await fetch(finalUrl, { method, headers, body })
    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      throw new Error(
        `[NeteaseMusic] HTTP ${res.status} ${res.statusText} for ${finalUrl}` +
          (errBody ? `: ${errBody.slice(0, 200)}` : ""),
      )
    }
    const text = await res.text()
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  // ─── Cloud song listing ────────────────────────────────────────────────────

  async listSongs(): Promise<FileItem[]> {
    const limit = Math.max(
      1,
      Math.min(10000, Number(this.addition.song_limit) || 200),
    )
    const resp = await this.request<NeteaseListResp>(
      "https://music.163.com/weapi/v1/cloud/get",
      "POST",
      {
        crypto: "weapi",
        data: { limit: String(limit), offset: "0" },
        cookies: { os: "pc" },
      },
    )

    this.songByName.clear()
    this.lrcByName.clear()
    const files: FileItem[] = []
    for (const f of resp.data || []) {
      const name = f.fileName
      const meta: NeteaseSongMeta = {
        songId: String(f.songId),
        name,
        size: f.fileSize || 0,
        addTime: f.addTime,
        picUrl: f.simpleSong?.al?.picUrl || "",
      }
      this.songByName.set(name, meta)
      this.lrcByName.set(name.replace(/\.[^.]+$/, "") + ".lrc", meta)
      files.push({
        name,
        size: meta.size,
        is_dir: false,
        modified: new Date(f.addTime).toISOString(),
        sign: "",
        type: calcFileType(name, false),
        thumb: meta.picUrl,
        raw_url: "",
      })
    }
    return files
  }

  private async ensureSongs(): Promise<void> {
    if (this.songByName.size === 0) {
      await this.listSongs()
    }
  }

  async findByName(name: string): Promise<NeteaseSongMeta | null> {
    await this.ensureSongs()
    let meta = this.songByName.get(name)
    if (!meta) {
      // The name may not be in the cached snapshot — refresh once.
      await this.listSongs()
      meta = this.songByName.get(name)
    }
    return meta || null
  }

  async findByLrcName(lrcName: string): Promise<NeteaseSongMeta | null> {
    await this.ensureSongs()
    let meta = this.lrcByName.get(lrcName)
    if (!meta) {
      await this.listSongs()
      meta = this.lrcByName.get(lrcName)
    }
    return meta || null
  }

  // ─── Song link / lyric / delete ────────────────────────────────────────────

  async getSongLink(songId: string): Promise<string> {
    const resp = await this.request<NeteaseSongResp>(
      "https://music.163.com/api/song/enhance/player/url",
      "POST",
      {
        crypto: "linuxapi",
        data: { ids: `[${songId}]`, br: "999000" },
        cookies: { os: "pc" },
      },
    )
    return resp.data?.[0]?.url || ""
  }

  async getLyric(songId: string): Promise<string> {
    const resp = await this.request<NeteaseLyricResp>(
      "https://music.163.com/api/song/lyric?_nmclf=1",
      "POST",
      {
        data: { id: songId, tv: "-1", lv: "-1", rv: "-1", kv: "-1" },
        cookies: { os: "ios" },
      },
    )
    return resp.lrc?.lyric || ""
  }

  async removeSong(songId: string): Promise<void> {
    await this.request("https://music.163.com/weapi/cloud/del", "POST", {
      crypto: "weapi",
      data: { songIds: `[${songId}]` },
    })
  }

  // ─── Upload pipeline (Go putSongStream / uploader) ─────────────────────────

  async upload(content: Uint8Array, filename: string): Promise<void> {
    const size = String(content.length)
    const ext = filename.toLowerCase().endsWith(".flac") ? "flac" : "mp3"
    const contentMd5 = md5(content)

    // Audio tags (ID3v2 for mp3); fall back to filename/unknown like upstream.
    const tags = readId3Tags(content)
    const song = (tags?.title || "").trim() || filename
    const artist = (tags?.artist || "").trim() || "未知艺术家"
    const album = (tags?.album || "").trim() || "未知专辑"

    // Step 1: check existence (dedupe by md5) → songId / needUpload
    const check = await this.request<any>(
      "https://interface.music.163.com/api/cloud/upload/check",
      "POST",
      {
        crypto: "weapi",
        data: {
          ext: "",
          songId: "0",
          version: "1",
          bitrate: "999000",
          length: size,
          md5: contentMd5,
        },
        cookies: { os: "pc", appver: "2.9.7" },
      },
    )
    const songId = String(check?.songId ?? "")
    const needUpload = Boolean(check?.needUpload)

    // Step 2: alloc publish token (empty bucket)
    const token = await this.allocToken("", filename, contentMd5, ext)

    // Step 3: upload the file body when the cloud does not already have it
    if (needUpload) {
      await this.uploadFile(content, contentMd5, size, filename, ext)
    }

    // Step 4: publish metadata, then publish the song
    const info = await this.request<any>(
      "https://music.163.com/api/upload/cloud/info/v2",
      "POST",
      {
        crypto: "weapi",
        data: {
          md5: contentMd5,
          filename,
          song,
          album,
          artist,
          songid: songId,
          resourceId: token.resourceId,
          bitrate: "999000",
        },
      },
    )
    await this.request<any>(
      "https://interface.music.163.com/api/cloud/pub/v2",
      "POST",
      {
        crypto: "weapi",
        data: { songid: String(info?.songId ?? "") },
      },
    )
  }

  private async allocToken(
    bucket: string,
    filename: string,
    contentMd5: string,
    ext: string,
  ): Promise<NeteaseUploadToken> {
    const resp = await this.request<NeteaseTokenResp>(
      "https://music.163.com/weapi/nos/token/alloc",
      "POST",
      {
        crypto: "weapi",
        data: {
          bucket,
          local: "false",
          type: "audio",
          nos_product: "3",
          filename,
          md5: contentMd5,
          ext,
        },
      },
    )
    const result = resp?.result
    if (!result?.resourceId) {
      throw new Error("[NeteaseMusic] allocToken failed: no resourceId")
    }
    return {
      resourceId: result.resourceId,
      objectKey: result.objectKey,
      token: result.token,
    }
  }

  private async uploadFile(
    content: Uint8Array,
    contentMd5: string,
    size: string,
    filename: string,
    ext: string,
  ): Promise<void> {
    const token = await this.allocToken(CLOUD_BUCKET, filename, contentMd5, ext)

    const hosts = await this.request<NeteaseHostsResp>(
      "https://wanproxy.127.net/lbs?version=1.0&bucketname=" + CLOUD_BUCKET,
      "GET",
    )
    const host = hosts?.upload?.[0]
    if (!host) {
      throw new Error("[NeteaseMusic] upload failed: no upload host from lbs")
    }

    const objectKey = token.objectKey.replace(/\//g, "%2F")
    await this.request(
      `${host}/${CLOUD_BUCKET}/${objectKey}?offset=0&complete=true&version=1.0`,
      "POST",
      {
        body: content,
        headers: {
          "x-nos-token": token.token,
          "Content-Type": "audio/mpeg",
          "Content-Length": size,
          "Content-MD5": contentMd5,
        },
      },
    )
  }
}

// ─── Minimal ID3v2 tag reader (title/artist/album for mp3 uploads) ──────────

function syncsafeInt(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  )
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

function decodeTextFrame(data: Uint8Array): string {
  if (data.length < 1) return ""
  const encoding = data[0]
  const raw = data.subarray(1)
  try {
    let text: string
    if (encoding === 1 || encoding === 2) {
      // UTF-16 with BOM, or UTF-16BE (no BOM)
      if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        text = new TextDecoder("utf-16le").decode(raw.subarray(2))
      } else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
        text = new TextDecoder("utf-16be").decode(raw.subarray(2))
      } else {
        text = new TextDecoder("utf-16be").decode(raw)
      }
    } else if (encoding === 3) {
      text = new TextDecoder("utf-8").decode(raw)
    } else {
      text = new TextDecoder("latin1").decode(raw)
    }
    return text.replace(/\u0000+$/, "").trim()
  } catch {
    return ""
  }
}

export function readId3Tags(
  content: Uint8Array,
): { title: string; artist: string; album: string } | null {
  try {
    if (content.length < 10) return null
    if (content[0] !== 0x49 || content[1] !== 0x44 || content[2] !== 0x33) {
      return null // not "ID3"
    }
    const major = content[3]
    if (major !== 3 && major !== 4) return null

    const tagSize = syncsafeInt(content, 6)
    const tagEnd = Math.min(10 + tagSize, content.length)
    let pos = 10

    // Skip extended header if flagged
    if (content[5] & 0x40) {
      if (major === 3) {
        const extSize = readUint32BE(content, pos)
        pos += 4 + extSize
      } else {
        const extSize = syncsafeInt(content, pos)
        pos += extSize
      }
    }

    const result: { title: string; artist: string; album: string } = {
      title: "",
      artist: "",
      album: "",
    }
    const wanted: Record<string, keyof typeof result> = {
      TIT2: "title",
      TPE1: "artist",
      TALB: "album",
    }

    while (pos + 10 <= tagEnd) {
      const frameId = String.fromCharCode(
        content[pos],
        content[pos + 1],
        content[pos + 2],
        content[pos + 3],
      )
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break // padding / end of frames

      const frameSize =
        major === 4
          ? syncsafeInt(content, pos + 4)
          : readUint32BE(content, pos + 4)
      const dataStart = pos + 10
      const dataEnd = Math.min(dataStart + frameSize, tagEnd)
      if (frameSize <= 0) {
        pos = dataEnd
        continue
      }

      const key = wanted[frameId]
      if (key) {
        const value = decodeTextFrame(content.subarray(dataStart, dataEnd))
        if (value) result[key] = value
      }
      pos = dataEnd
    }

    return result.title || result.artist || result.album ? result : null
  } catch {
    return null
  }
}
