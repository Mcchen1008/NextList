// 139 Cloud (和彩云) HTTP client — simplified personal_new variant
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/139
import { Cloud139Addition, Cloud139File, Cloud139ListResp } from "./types"

const ROUTE_API = "https://user-njs.yun.139.com/user/route/qryRoutePolicy"
const PERSONAL_HOST_DEFAULT = "https://yun.139.com"

export class Cloud139Client {
  private addition: Cloud139Addition
  private account = ""
  private personalCloudHost = PERSONAL_HOST_DEFAULT
  private onTokenUpdate?: (auth: string) => void

  constructor(
    addition: Cloud139Addition,
    onTokenUpdate?: (auth: string) => void,
  ) {
    this.addition = addition
    this.onTokenUpdate = onTokenUpdate
    // Parse account from authorization
    try {
      const decoded = atob(this.addition.authorization)
      const parts = decoded.split(":")
      if (parts.length >= 2) {
        this.account = parts[1]
      }
    } catch {}
  }

  public getRootFolderId(): string {
    return this.addition.root_id || "/"
  }

  public getAccount(): string {
    return this.account
  }

  public async init(): Promise<void> {
    // Try to refresh token if needed
    await this.refreshToken()
    // Query route policy
    try {
      await this.queryRoutePolicy()
    } catch (e: any) {
      console.warn(
        `[139] route policy query failed, using default host:`,
        e.message,
      )
    }
  }

  public async refreshToken(): Promise<void> {
    if (!this.addition.authorization) {
      throw new Error("139: authorization is empty")
    }
    let decoded: string
    try {
      decoded = atob(this.addition.authorization)
    } catch {
      throw new Error("139: authorization is not valid base64")
    }
    const splits = decoded.split(":")
    if (splits.length < 3) {
      throw new Error(
        "139: authorization is invalid, expected type:account:token",
      )
    }
    this.account = splits[1]
    const strs = splits[2].split("|")
    if (strs.length < 4) {
      throw new Error("139: authorization token format invalid")
    }
    const expiration = parseInt(strs[3], 10)
    const now = Date.now()
    if (expiration - now > 1000 * 60 * 60 * 24 * 15) {
      // Still valid (>15 days)
      return
    }
    if (expiration - now < 0) {
      throw new Error("139: authorization has expired")
    }
    // Try to refresh
    const reqBody = `<root><token>${splits[2]}</token><account>${splits[1]}</account><clienttype>656</clienttype></root>`
    const res = await fetch(
      "https://aas.caiyun.feixin.10086.cn:443/tellin/authTokenRefresh.do",
      {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: reqBody,
      },
    )
    const text = await res.text()
    // Parse XML response (very crude)
    const tokenMatch = text.match(/<token>([^<]+)<\/token>/)
    const returnMatch = text.match(/<return>([^<]+)<\/return>/)
    if (returnMatch && returnMatch[1] === "0" && tokenMatch) {
      const newAuth = btoa(splits[0] + ":" + splits[1] + ":" + tokenMatch[1])
      this.addition.authorization = newAuth
      this.onTokenUpdate?.(newAuth)
    } else {
      throw new Error(`139: token refresh failed: ${text}`)
    }
  }

  public async queryRoutePolicy(): Promise<void> {
    const body = {
      userInfo: {
        userType: 1,
        accountType: 1,
        accountName: this.account,
      },
      modAddrType: 1,
    }
    const res = await fetch(ROUTE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + this.addition.authorization,
        "CMS-DEVICE": "default",
        "mcloud-channel": "1000101",
        "mcloud-client": "10701",
        "mcloud-version": "7.14.0",
        Origin: "https://yun.139.com",
        Referer: "https://yun.139.com/w/",
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as any
    if (data?.data?.routePolicyList) {
      for (const policy of data.data.routePolicyList) {
        if (policy.modName === "personal") {
          this.personalCloudHost = policy.httpsUrl
        }
      }
    }
  }

  public getAuthorization(): string {
    return this.addition.authorization
  }

  public async request<T = any>(
    pathname: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: any,
    retry = true,
  ): Promise<T> {
    const url = this.personalCloudHost + pathname
    const randStr = randomString(16)
    const ts = formatBeijingTime(new Date())
    const bodyStr = body !== undefined ? JSON.stringify(body) : ""
    const sign = calSign(bodyStr, ts, randStr)
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "CMS-DEVICE": "default",
        Authorization: "Basic " + this.addition.authorization,
        "mcloud-channel": "1000101",
        "mcloud-client": "10701",
        "mcloud-sign": `${ts},${randStr},${sign}`,
        "mcloud-version": "7.14.0",
        Origin: "https://yun.139.com",
        Referer: "https://yun.139.com/w/",
        "x-DeviceInfo": "||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||",
        "x-huawei-channelSrc": "10000034",
        "x-inner-ntwk": "2",
        "x-m4c-caller": "PC",
        "x-m4c-src": "10002",
        "x-SvcType": "1",
        "Inner-Hcy-Router-Https": "1",
      },
    }
    if (body !== undefined) init.body = bodyStr
    const res = await fetch(url, init)
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON */
      }
    }
    if (data?.success === false) {
      throw new Error(data.message || `139 request failed`)
    }
    return data as T
  }

  public async getFiles(catalogId: string): Promise<Cloud139File[]> {
    // Personal new API: /orchestration/personalCloud/catalog/v1.0/getDisk
    if (this.addition.type === "personal_new" || !this.addition.type) {
      return this.personalNewGetFiles(catalogId)
    }
    // Personal old API
    return this.personalOldGetFiles(catalogId)
  }

  private async personalNewGetFiles(parentId: string): Promise<Cloud139File[]> {
    const result: Cloud139File[] = []
    let start = 0
    const limit = 100
    for (;;) {
      const body = {
        parentFileId: parentId,
        page: { pageNum: Math.floor(start / limit) + 1, pageSize: limit },
        sortDirection: 1,
        sortType: 0,
      }
      const resp = await this.request<Cloud139ListResp>(
        "/orchestration/personalCloud/file/v1.0/files",
        "POST",
        body,
      )
      const files = resp.data?.fileList || []
      result.push(...files)
      if (files.length < limit) break
      start += limit
      if (start > 10000) break
    }
    return result
  }

  private async personalOldGetFiles(
    catalogId: string,
  ): Promise<Cloud139File[]> {
    const result: Cloud139File[] = []
    let start = 0
    const limit = 100
    for (;;) {
      const body = {
        catalogID: catalogId,
        sortDirection: 1,
        startNumber: start + 1,
        endNumber: start + limit,
        filterType: 0,
        catalogSortType: 0,
        contentSortType: 0,
        commonAccountInfo: {
          account: this.account,
          accountType: 1,
        },
      }
      const resp = await this.request<Cloud139ListResp>(
        "/orchestration/personalCloud/catalog/v1.0/getDisk",
        "POST",
        body,
      )
      const disk = resp.data?.getTotalDiskResult
      if (!disk) break
      const catalogs = disk.catalogList || []
      const contents = disk.contentList || []
      for (const c of catalogs) {
        result.push({
          contentID: c.catalogID,
          contentName: c.catalogName,
          contentSize: 0,
          updateTime: c.updateTime,
          createTime: c.createTime,
          thumbnailURL: "",
        } as Cloud139File)
      }
      for (const c of contents) {
        result.push({
          contentID: c.contentID,
          contentName: c.contentName,
          contentSize: c.contentSize,
          updateTime: c.updateTime,
          createTime: c.createTime,
          thumbnailURL: c.thumbnailURL,
          digest: c.digest,
        } as Cloud139File)
      }
      if (start + limit >= (disk.nodeCount || 0)) break
      start += limit
      if (start > 10000) break
    }
    return result
  }

  public async getDownloadUrl(fileId: string): Promise<string> {
    const body = {
      contentID: fileId,
      commonAccountInfo: { account: this.account, accountType: 1 },
    }
    const resp = await this.request<any>(
      "/orchestration/personalCloud/content/v1.0/getContentURL",
      "POST",
      body,
    )
    return resp?.data?.contentURL || ""
  }

  public async mkdir(parentId: string, dirName: string): Promise<void> {
    const body = {
      parentFileId: parentId,
      name: dirName,
      description: "",
      type: "folder",
      fileRenameMode: "force_rename",
    }
    await this.request("/file/create", "POST", body)
  }

  public async move(fileIds: string[], dstParentId: string): Promise<void> {
    await this.request("/file/batchMove", "POST", {
      fileIds: fileIds,
      toParentFileId: dstParentId,
    })
  }

  public async rename(fileId: string, newName: string): Promise<void> {
    await this.request("/file/rename", "POST", {
      fileId: fileId,
      name: newName,
    })
  }

  public async copy(fileIds: string[], dstParentId: string): Promise<void> {
    await this.request("/file/batchCopy", "POST", {
      fileIds: fileIds,
      toParentFileId: dstParentId,
    })
  }

  public async remove(fileIds: string[]): Promise<void> {
    await this.request("/file/batchDelete", "POST", { fileIds })
  }
}

function formatBeijingTime(d: Date): string {
  // UTC+8
  const beijing = new Date(d.getTime() + 8 * 3600000)
  const y = beijing.getUTCFullYear()
  const mo = String(beijing.getUTCMonth() + 1).padStart(2, "0")
  const da = String(beijing.getUTCDate()).padStart(2, "0")
  const h = String(beijing.getUTCHours()).padStart(2, "0")
  const mi = String(beijing.getUTCMinutes()).padStart(2, "0")
  const s = String(beijing.getUTCSeconds()).padStart(2, "0")
  return `${y}-${mo}-${da} ${h}:${mi}:${s}`
}

function randomString(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let s = ""
  for (let i = 0; i < length; i++) {
    s += chars[Math.floor(Math.random() * chars.length)]
  }
  return s
}

function encodeURIComponent139(str: string): string {
  return encodeURIComponent(str)
    .replace(/%20/g, " ")
    .replace(/%21/g, "!")
    .replace(/%27/g, "'")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%2A/g, "*")
}

// Pure-JS MD5 (synchronous, RFC 1321)
function md5Hex(input: string): string {
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

function calSign(body: string, ts: string, randStr: string): string {
  const enc = encodeURIComponent139(body)
  const strs = enc.split("").sort().join("")
  const b64 = btoa(strs)
  const m1 = md5Hex(b64)
  const m2 = md5Hex(ts + ":" + randStr)
  return md5Hex(m1 + m2).toUpperCase()
}
