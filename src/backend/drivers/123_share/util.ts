// 123PanShare HTTP client (share link browsing, no account required)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/123_share
//
// Share endpoints differ from the regular 123Pan (123) driver:
//   GET  {MAIN_API}/share/get            — list share files (paginated)
//   POST {MAIN_API}/share/download/info  — get share file download url
// Requests are signed with the same CRC32-based query signature as the 123pan
// driver (Go signPath / GetApi in util.go).
import {
  Pan123ShareAddition,
  Pan123ShareDownloadResp,
  Pan123ShareFile,
  Pan123ShareFilesResp,
} from "./types"

const MAIN_API = "https://yun.123pan.com/b/api"
const FileList = MAIN_API + "/share/get"
const DownloadInfo = MAIN_API + "/share/download/info"

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client"

// --- CRC32-based API path signing (Go signPath equivalent) ---

const CRC32_TABLE: number[] = (() => {
  const table = new Array<number>(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
})()

function crc32(data: string): number {
  const bytes = new TextEncoder().encode(data)
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Go: table used to map each digit of the CST "YYYYMMDDhhmm" string
const SIGN_TABLE = [
  "a",
  "d",
  "e",
  "f",
  "g",
  "h",
  "l",
  "m",
  "y",
  "i",
  "j",
  "n",
  "o",
  "p",
  "k",
  "q",
  "r",
  "s",
  "t",
  "u",
  "b",
  "c",
  "v",
  "w",
  "s",
  "z",
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Go signPath: builds the "k=v" query signature for an API path.
 * k = crc32(mapped CST time string), v = "timestamp-random-dataSign".
 */
function signPath(path: string, os = "web", version = "3"): string {
  const random = String(Math.round(1e7 * Math.random()))
  const nowMs = Date.now()
  const timestamp = String(Math.floor(nowMs / 1000))
  // CST (UTC+8) wall clock via shifted UTC fields
  const cst = new Date(nowMs + 8 * 3600000)
  const pad = (n: number) => String(n).padStart(2, "0")
  const nowStr =
    `${cst.getUTCFullYear()}${pad(cst.getUTCMonth() + 1)}` +
    `${pad(cst.getUTCDate())}${pad(cst.getUTCHours())}${pad(cst.getUTCMinutes())}`
  const mapped = nowStr
    .split("")
    .map((ch) => SIGN_TABLE[ch.charCodeAt(0) - 48])
    .join("")
  const timeSign = String(crc32(mapped))
  const data = [timestamp, random, path, os, version, timeSign].join("|")
  const dataSign = String(crc32(data))
  return `${timeSign}=${timestamp}-${random}-${dataSign}`
}

/** Go GetApi: append the signature query pair to a raw url */
function getApi(rawUrl: string): string {
  const u = new URL(rawUrl)
  const sig = signPath(u.pathname)
  const eq = sig.indexOf("=")
  u.searchParams.append(sig.slice(0, eq), sig.slice(eq + 1))
  return u.toString()
}

// --- Client ---

export class Pan123ShareClient {
  private addition: Pan123ShareAddition
  /** Go apiRateLimit sync.Map — per-API limiter, 1 call every 700ms */
  private rateNext = new Map<string, number>()

  constructor(addition: Pan123ShareAddition) {
    this.addition = addition
  }

  public getRootId(): string {
    return (this.addition.root_folder_id || "0").trim() || "0"
  }

  /** Go APIRateLimit: rate.Every(700ms) with burst 1, per api key */
  private async rateLimit(api: string): Promise<void> {
    const interval = 700
    const now = Date.now()
    const next = this.rateNext.get(api) ?? now
    const wait = next - now
    this.rateNext.set(api, Math.max(now, next) + interval)
    if (wait > 0) await sleep(wait)
  }

  /** Go request(): signed request with code != 0 check */
  public async request<T = any>(
    url: string,
    method: "GET" | "POST",
    body?: any,
  ): Promise<T> {
    const headers: Record<string, string> = {
      origin: "https://yun.123pan.com",
      referer: "https://yun.123pan.com/",
      authorization: "Bearer " + (this.addition.accesstoken || ""),
      "user-agent": USER_AGENT,
      platform: "web",
      "app-version": "3",
      Accept: "application/json",
    }
    const init: RequestInit = { method, headers }
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(body)
    }
    const res = await fetch(getApi(url), init)
    let data: any = {}
    try {
      data = await res.json()
    } catch {
      throw new Error(
        `[123PanShare] unexpected non-JSON response (HTTP ${res.status})`,
      )
    }
    // Go: code != 0 → error with message
    if (data && typeof data.code === "number" && data.code !== 0) {
      throw new Error(
        `[123PanShare] ${data.message || `api error: code ${data.code}`}`,
      )
    }
    return data as T
  }

  /** Go getFiles(): paginated share file listing */
  public async getFiles(parentId: string): Promise<Pan123ShareFile[]> {
    const files: Pan123ShareFile[] = []
    let page = 1
    // safety cap (Cloudflare Workers subrequest budget)
    const maxPages = 50
    for (;;) {
      if (page > maxPages) {
        console.warn(
          `[123PanShare] pagination exceeded ${maxPages} pages, result truncated`,
        )
        break
      }
      await this.rateLimit(FileList)
      const query = new URLSearchParams({
        limit: "100",
        next: "0",
        orderBy: "file_id",
        orderDirection: "desc",
        parentFileId: parentId,
        Page: String(page),
        shareKey: this.addition.sharekey,
        SharePwd: this.addition.sharepassword || "",
      })
      const resp = await this.request<Pan123ShareFilesResp>(
        `${FileList}?${query.toString()}`,
        "GET",
      )
      const list = resp.data?.InfoList || []
      page++
      files.push(...list)
      if (list.length === 0 || resp.data?.Next === "-1") break
    }
    return files
  }

  /**
   * Go Link(): resolve the actual download url of a share file.
   * Returns the final url plus the Referer header that must accompany it.
   */
  public async getDownloadUrl(
    file: Pan123ShareFile,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const body = {
      shareKey: this.addition.sharekey,
      SharePwd: this.addition.sharepassword || "",
      etag: file.Etag,
      fileId: file.FileId,
      s3keyFlag: file.S3KeyFlag,
      size: file.Size,
    }
    const resp = await this.request<Pan123ShareDownloadResp>(
      DownloadInfo,
      "POST",
      body,
    )
    const downloadUrl = resp.data?.DownloadURL || ""
    if (!downloadUrl) {
      throw new Error("[123PanShare] no download url returned")
    }

    // Some download urls carry a base64 "params" query holding the real url
    let ou: URL
    try {
      ou = new URL(downloadUrl)
    } catch {
      throw new Error("[123PanShare] failed to parse download url")
    }
    let u_ = ou.toString()
    const nu = ou.searchParams.get("params")
    if (nu) {
      try {
        u_ = new URL(atob(nu)).toString()
      } catch {
        // keep original url when params is not a valid base64 url
      }
    }

    // Follow the redirect chain manually (Go NoRedirectClient + Referer)
    let finalUrl = u_
    try {
      const res = await fetch(u_, {
        method: "GET",
        redirect: "manual",
        headers: { Referer: "https://yun.123pan.com/" },
      })
      if (res.status === 302) {
        finalUrl = res.headers.get("location") || u_
      } else if (res.status < 300) {
        const text = await res.text()
        try {
          const data = JSON.parse(text)
          if (data?.data?.redirect_url) finalUrl = data.data.redirect_url
        } catch {
          /* non-JSON body — keep u_ */
        }
      }
    } catch (e: any) {
      console.warn(`[123PanShare] redirect follow failed: ${e?.message || e}`)
    }

    // Referer derived from the ORIGINAL download url host (Go behavior)
    const headers: Record<string, string> = {
      Referer: `${ou.protocol}//${ou.host}/`,
    }
    return { url: finalUrl, headers }
  }
}
