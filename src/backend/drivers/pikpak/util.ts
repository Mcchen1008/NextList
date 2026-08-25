// PikPak HTTP client (Web platform only — simpler than android/pc)
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/pikpak
import {
  PikPakAddition,
  PikPakFile,
  PikPakFilesResp,
  PikPakErrResp,
  PikPakTokenResp,
  PikPakCaptchaTokenResp,
} from "./types"

const WebClientID = "YUMx5nI8ZU8Ap8pm"
const WebClientSecret = "dbw2OtmVEeuUvIptb1Coyg"
const WebClientVersion = "2.0.0"
const WebPackageName = "mypikpak.com"
const WebAlgorithms = [
  "C9qPpZLN8ucRTaTiUMWYS9cQvWOE",
  "+r6CQVxjzJV6LCV",
  "F",
  "pFJRC",
  "9WXYIDGrwTCz2OiVlgZa90qpECPD6olt",
  "/750aCr4lm/Sly/c",
  "RB+DT/gZCrbV",
  "",
  "CyLsf7hdkIRxRm215hl",
  "7xHvLi2tOYP0Y92b",
  "ZGTXXxu8E/MIWaEDB+Sm/",
  "1UI3",
  "E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO",
  "ihtqpG6FMt65+Xk+tWUH2",
  "NhXXU9rg4XXdzo7u5o",
]
const WebUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36"

export class PikPakClient {
  private addition: PikPakAddition
  private accessToken = ""
  private refreshToken = ""
  private captchaToken = ""
  private deviceId = ""
  private userId = ""
  private onTokenUpdate?: (tokens: {
    access_token: string
    refresh_token: string
  }) => void

  constructor(
    addition: PikPakAddition,
    onTokenUpdate?: (tokens: {
      access_token: string
      refresh_token: string
    }) => void,
  ) {
    this.addition = addition
    this.refreshToken = addition.refresh_token || ""
    this.onTokenUpdate = onTokenUpdate
    // DeviceID: stable MD5 of username+password
    this.deviceId =
      addition.device_id || md5HexStr(addition.username + addition.password)
  }

  public getRootId(): string {
    return this.addition.root_id || ""
  }

  public async init(): Promise<void> {
    if (this.refreshToken) {
      await this.refreshAccessToken()
    } else {
      await this.login()
    }
    await this.refreshCaptchaTokenAtLogin("GET:/drive/v1/files", this.userId)
  }

  public async login(): Promise<void> {
    if (!this.addition.username || !this.addition.password) {
      throw new Error("PikPak: username/password required")
    }
    if (!this.captchaToken) {
      await this.refreshCaptchaTokenInLogin(
        "POST:/v1/auth/signin",
        this.addition.username,
      )
    }
    const body = {
      captcha_token: this.captchaToken,
      client_id: WebClientID,
      client_secret: WebClientSecret,
      username: this.addition.username,
      password: this.addition.password,
    }
    const url = new URL("https://user.mypikpak.net/v1/auth/signin")
    url.searchParams.set("client_id", WebClientID)
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WebUserAgent,
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as PikPakTokenResp & PikPakErrResp
    if (data.error_code) {
      throw new Error(
        `PikPak login failed: ${data.error} ${data.error_description}`,
      )
    }
    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token
    this.userId = data.sub || ""
    this.onTokenUpdate?.({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
    })
  }

  public async refreshAccessToken(): Promise<void> {
    const body = {
      client_id: WebClientID,
      client_secret: WebClientSecret,
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
    }
    const url = new URL("https://user.mypikpak.net/v1/auth/token")
    url.searchParams.set("client_id", WebClientID)
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "",
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as PikPakTokenResp & PikPakErrResp
    if (data.error_code) {
      if (data.error_code === 4126) {
        // refresh_token invalid, fall back to login
        await this.login()
        return
      }
      throw new Error(
        `PikPak refresh failed: ${data.error} ${data.error_description}`,
      )
    }
    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token
    this.userId = data.sub || ""
    this.onTokenUpdate?.({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
    })
  }

  public async refreshCaptchaTokenInLogin(
    action: string,
    username: string,
  ): Promise<void> {
    const metas: Record<string, string> = {}
    if (/^\w+([-.]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*$/.test(username)) {
      metas["email"] = username
    } else if (username.length >= 11 && username.length <= 18) {
      metas["phone_number"] = username
    } else {
      metas["username"] = username
    }
    await this.refreshCaptchaToken(action, metas)
  }

  public async refreshCaptchaTokenAtLogin(
    action: string,
    userId: string,
  ): Promise<void> {
    const metas: Record<string, string> = {
      client_version: WebClientVersion,
      package_name: WebPackageName,
      user_id: userId,
    }
    const { timestamp, captcha_sign } = this.getCaptchaSign()
    metas["timestamp"] = timestamp
    metas["captcha_sign"] = captcha_sign
    await this.refreshCaptchaToken(action, metas)
  }

  private getCaptchaSign(): { timestamp: string; captcha_sign: string } {
    const timestamp = String(Date.now())
    let str =
      WebClientID +
      WebClientVersion +
      WebPackageName +
      this.deviceId +
      timestamp
    for (const alg of WebAlgorithms) {
      str = md5HexStr(str + alg)
    }
    return { timestamp, captcha_sign: "1." + str }
  }

  private async refreshCaptchaToken(
    action: string,
    metas: Record<string, string>,
  ): Promise<void> {
    const body = {
      action,
      captcha_token: this.captchaToken,
      client_id: WebClientID,
      device_id: this.deviceId,
      meta: metas,
      redirect_uri: "xlaccsdk01://xbase.cloud/callback?state=harbor",
    }
    const url = new URL("https://user.mypikpak.net/v1/shield/captcha/init")
    url.searchParams.set("client_id", WebClientID)
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WebUserAgent,
        "X-Device-ID": this.deviceId,
        "X-Captcha-Token": this.captchaToken,
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as PikPakCaptchaTokenResp & PikPakErrResp
    if (data.error_code) {
      throw new Error(
        `PikPak captcha refresh failed: ${data.error} ${data.error_description}`,
      )
    }
    if (data.url) {
      throw new Error(
        `PikPak: captcha verification required — visit ${data.url}`,
      )
    }
    this.captchaToken = data.captcha_token
  }

  public async request<T = any>(
    url: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    opts?: { query?: Record<string, string>; body?: any },
    retry = true,
  ): Promise<T> {
    const u = new URL(url)
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        u.searchParams.set(k, v)
      }
    }
    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.accessToken ? "Bearer " + this.accessToken : "",
        "User-Agent": WebUserAgent,
        "X-Device-ID": this.deviceId,
        "X-Captcha-Token": this.captchaToken,
        Accept: "application/json",
      },
    }
    if (opts?.body !== undefined) {
      ;(init.headers as Record<string, string>)["Content-Type"] =
        "application/json"
      init.body = JSON.stringify(opts.body)
    }
    const res = await fetch(u.toString(), init)
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON */
      }
    }
    const err = data as PikPakErrResp
    if (err.error_code) {
      if ([4122, 4121, 16].includes(err.error_code) && retry) {
        await this.refreshAccessToken()
        return this.request<T>(url, method, opts, false)
      }
      if (err.error_code === 9 && retry) {
        await this.refreshCaptchaTokenAtLogin(
          method + ":" + u.pathname,
          this.userId,
        )
        return this.request<T>(url, method, opts, false)
      }
      throw new Error(
        `PikPak error ${err.error_code}: ${err.error} ${err.error_description}`,
      )
    }
    return data as T
  }

  public async getFiles(parentId: string): Promise<PikPakFile[]> {
    const result: PikPakFile[] = []
    let pageToken = "first"
    while (pageToken) {
      if (pageToken === "first") pageToken = ""
      const query: Record<string, string> = {
        parent_id: parentId,
        thumbnail_size: "SIZE_LARGE",
        with_audit: "true",
        limit: "100",
        filters: JSON.stringify({
          phase: { eq: "PHASE_TYPE_COMPLETE" },
          trashed: { eq: false },
        }),
        page_token: pageToken,
      }
      const resp = await this.request<PikPakFilesResp>(
        "https://api-drive.mypikpak.net/drive/v1/files",
        "GET",
        { query },
      )
      result.push(...(resp.files || []))
      pageToken = resp.next_page_token || ""
      if (result.length > 10000) break // safety cap
    }
    return result
  }

  public async getDownloadUrl(fileId: string): Promise<string> {
    const query: Record<string, string> = {
      _magic: "2021",
      usage: "FETCH",
      thumbnail_size: "SIZE_LARGE",
    }
    if (!this.addition.disable_media_link) {
      query["usage"] = "CACHE"
    }
    const resp = await this.request<{
      web_content_link?: string
      medias?: any[]
    }>(`https://api-drive.mypikpak.net/drive/v1/files/${fileId}`, "GET", {
      query,
    })
    let url = resp.web_content_link || ""
    if (
      !this.addition.disable_media_link &&
      resp.medias &&
      resp.medias.length > 0 &&
      resp.medias[0].link?.url
    ) {
      url = resp.medias[0].link.url
    }
    return url
  }

  public async makeDir(parentId: string, name: string): Promise<void> {
    await this.request(
      "https://api-drive.mypikpak.net/drive/v1/files",
      "POST",
      {
        body: { kind: "drive#folder", parent_id: parentId, name },
      },
    )
  }

  public async move(fileId: string, dstParentId: string): Promise<void> {
    await this.request(
      "https://api-drive.mypikpak.net/drive/v1/files:batchMove",
      "POST",
      { body: { ids: [fileId], to: { parent_id: dstParentId } } },
    )
  }

  public async rename(fileId: string, newName: string): Promise<void> {
    await this.request(
      `https://api-drive.mypikpak.net/drive/v1/files/${fileId}`,
      "PATCH",
      { body: { name: newName } },
    )
  }

  public async copy(fileId: string, dstParentId: string): Promise<void> {
    await this.request(
      "https://api-drive.mypikpak.net/drive/v1/files:batchCopy",
      "POST",
      { body: { ids: [fileId], to: { parent_id: dstParentId } } },
    )
  }

  public async remove(fileId: string): Promise<void> {
    await this.request(
      "https://api-drive.mypikpak.net/drive/v1/files:batchTrash",
      "POST",
      { body: { ids: [fileId] } },
    )
  }
}

// ---- MD5 (RFC 1321) for sign computation ----
// Reuse a tiny implementation
function md5HexStr(s: string): string {
  // Synchronous MD5 — re-implement compactly
  // (Same algorithm as uss/util.ts md5PureJs but sync — easier for sign calc)
  // We re-use the async one wrapped synchronously by reading cached value
  // Since sign must be sync, we implement a compact sync MD5.
  return md5Sync(s)
}

function safeAdd(x: number, y: number): number {
  const lsw = (x & 0xffff) + (y & 0xffff)
  const msw = (x >> 16) + (y >> 16) + (lsw >> 16)
  return (msw << 16) | (lsw & 0xffff)
}
function rol(num: number, cnt: number): number {
  return (num << cnt) | (num >>> (32 - cnt))
}
function cmn(
  q: number,
  a: number,
  b: number,
  x: number,
  s: number,
  t: number,
): number {
  return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b)
}
function ff(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number,
): number {
  return cmn((b & c) | (~b & d), a, b, x, s, t)
}
function gg(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number,
): number {
  return cmn((b & d) | (c & ~d), a, b, x, s, t)
}
function hh(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number,
): number {
  return cmn(b ^ c ^ d, a, b, x, s, t)
}
function ii(
  a: number,
  b: number,
  c: number,
  d: number,
  x: number,
  s: number,
  t: number,
): number {
  return cmn(c ^ (b | ~d), a, b, x, s, t)
}
function md5Sync(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const n = bytes.length
  const bitLen = n * 8
  const padLen = Math.ceil((n + 1 + 8) / 64) * 64
  const padded = new Uint8Array(padLen)
  padded.set(bytes)
  padded[n] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padLen - 8, bitLen >>> 0, true)
  view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000), true)
  let a = 0x67452301,
    b = 0xefcdab89,
    c = 0x98badcfe,
    d = 0x10325476
  for (let i = 0; i < padLen; i += 64) {
    const x = new Array(16)
    for (let j = 0; j < 16; j++) x[j] = view.getUint32(i + j * 4, true)
    const oA = a,
      oB = b,
      oC = c,
      oD = d
    a = ff(a, b, c, d, x[0], 7, 0xd76aa478)
    d = ff(d, a, b, c, x[1], 12, 0xe8c7b756)
    c = ff(c, d, a, b, x[2], 17, 0x242070db)
    b = ff(b, c, d, a, x[3], 22, 0xc1bdceee)
    a = ff(a, b, c, d, x[4], 7, 0xf57c0faf)
    d = ff(d, a, b, c, x[5], 12, 0x4787c62a)
    c = ff(c, d, a, b, x[6], 17, 0xa8304613)
    b = ff(b, c, d, a, x[7], 22, 0xfd469501)
    a = ff(a, b, c, d, x[8], 7, 0x698098d8)
    d = ff(d, a, b, c, x[9], 12, 0x8b44f7af)
    c = ff(c, d, a, b, x[10], 17, 0xffff5bb1)
    b = ff(b, c, d, a, x[11], 22, 0x895cd7be)
    a = ff(a, b, c, d, x[12], 7, 0x6b901122)
    d = ff(d, a, b, c, x[13], 12, 0xfd987193)
    c = ff(c, d, a, b, x[14], 17, 0xa679438e)
    b = ff(b, c, d, a, x[15], 22, 0x49b40821)
    a = gg(a, b, c, d, x[1], 5, 0xf61e2562)
    d = gg(d, a, b, c, x[6], 9, 0xc040b340)
    c = gg(c, d, a, b, x[11], 14, 0x265e5a51)
    b = gg(b, c, d, a, x[0], 20, 0xe9b6c7aa)
    a = gg(a, b, c, d, x[5], 5, 0xd62f105d)
    d = gg(d, a, b, c, x[10], 9, 0x02441453)
    c = gg(c, d, a, b, x[15], 14, 0xd8a1e681)
    b = gg(b, c, d, a, x[4], 20, 0xe7d3fbc8)
    a = gg(a, b, c, d, x[9], 5, 0x21e1cde6)
    d = gg(d, a, b, c, x[14], 9, 0xc33707d6)
    c = gg(c, d, a, b, x[3], 14, 0xf4d50d87)
    b = gg(b, c, d, a, x[8], 20, 0x455a14ed)
    a = gg(a, b, c, d, x[13], 5, 0xa9e3e905)
    d = gg(d, a, b, c, x[2], 9, 0xfcefa3f8)
    c = gg(c, d, a, b, x[7], 14, 0x676f02d9)
    b = gg(b, c, d, a, x[12], 20, 0x8d2a4c8a)
    a = hh(a, b, c, d, x[5], 4, 0xfffa3942)
    d = hh(d, a, b, c, x[8], 11, 0x8771f681)
    c = hh(c, d, a, b, x[11], 16, 0x6d9d6122)
    b = hh(b, c, d, a, x[14], 23, 0xfde5380c)
    a = hh(a, b, c, d, x[1], 4, 0xa4beea44)
    d = hh(d, a, b, c, x[4], 11, 0x4bdecfa9)
    c = hh(c, d, a, b, x[7], 16, 0xf6bb4b60)
    b = hh(b, c, d, a, x[10], 23, 0xbebfbc70)
    a = hh(a, b, c, d, x[13], 4, 0x289b7ec6)
    d = hh(d, a, b, c, x[0], 11, 0xeaa127fa)
    c = hh(c, d, a, b, x[3], 16, 0xd4ef3085)
    b = hh(b, c, d, a, x[6], 23, 0x04881d05)
    a = hh(a, b, c, d, x[9], 4, 0xd9d4d039)
    d = hh(d, a, b, c, x[12], 11, 0xe6db99e5)
    c = hh(c, d, a, b, x[15], 16, 0x1fa27cf8)
    b = hh(b, c, d, a, x[2], 23, 0xc4ac5665)
    a = ii(a, b, c, d, x[0], 6, 0xf4292244)
    d = ii(d, a, b, c, x[7], 10, 0x432aff97)
    c = ii(c, d, a, b, x[14], 15, 0xab9423a7)
    b = ii(b, c, d, a, x[5], 21, 0xfc93a039)
    a = ii(a, b, c, d, x[12], 6, 0x655b59c3)
    d = ii(d, a, b, c, x[3], 10, 0x8f0ccc92)
    c = ii(c, d, a, b, x[10], 15, 0xffeff47d)
    b = ii(b, c, d, a, x[1], 21, 0x85845dd1)
    a = ii(a, b, c, d, x[8], 6, 0x6fa87e4f)
    d = ii(d, a, b, c, x[15], 10, 0xfe2ce6e0)
    c = ii(c, d, a, b, x[6], 15, 0xa3014314)
    b = ii(b, c, d, a, x[13], 21, 0x4e0811a1)
    a = ii(a, b, c, d, x[4], 6, 0xf7537e82)
    d = ii(d, a, b, c, x[11], 10, 0xbd3af235)
    c = ii(c, d, a, b, x[2], 15, 0x2ad7d2bb)
    b = ii(b, c, d, a, x[9], 21, 0xeb86d391)
    a = safeAdd(a, oA)
    b = safeAdd(b, oB)
    c = safeAdd(c, oC)
    d = safeAdd(d, oD)
  }
  const toHexStr = (n: number): string => {
    let s = ""
    for (let i = 0; i < 4; i++) {
      const b = (n >>> (i * 8)) & 0xff
      s += b.toString(16).padStart(2, "0")
    }
    return s
  }
  return toHexStr(a) + toHexStr(b) + toHexStr(c) + toHexStr(d)
}
