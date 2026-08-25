// USS (又拍云对象存储) HTTP client — uses pure fetch (no upyun-sdk)
// Based on: https://github.com/upyun-dev/upyun-api-sdk-js & OpenList Go driver
// Signing: HMAC-SHA1 with operator:password auth + Berkeley-style MD5防盗链
import { UssAddition } from "./types"

export interface UssFileInfo {
  name: string
  size: number
  is_dir: boolean
  modified: string
}

function getKey(path: string, dir: boolean): string {
  let p = (path || "").replace(/^\/+/, "")
  if (dir && !p.endsWith("/")) p += "/"
  return p
}

function joinPath(parent: string, name: string): string {
  const p = (parent || "").replace(/\/+$/, "")
  return p + "/" + name
}

function getParent(path: string): string {
  const parts = (path || "").replace(/^\/+/, "").split("/").filter(Boolean)
  parts.pop()
  return "/" + parts.join("/")
}

// MD5 via Web Crypto (subtle). HMAC isn't directly compatible with upyun's password auth.
// Upyun REST: Basic auth with operator:password, returns X-Upyun-List headers.
export class UssClient {
  private addition: UssAddition

  constructor(addition: UssAddition) {
    this.addition = addition
  }

  public getEndpoint(): string {
    let ep = this.addition.endpoint || ""
    if (!ep) ep = "https://v0.api.upyun.com"
    if (!/^https?:\/\//.test(ep)) ep = "https://" + ep
    return ep.replace(/\/+$/, "")
  }

  public getBucket(): string {
    return this.addition.bucket
  }

  public getBasicAuth(): string {
    return (
      "Basic " +
      btoa(this.addition.operator_name + ":" + this.addition.operator_password)
    )
  }

  public async list(dir: string): Promise<UssFileInfo[]> {
    const prefix = getKey(dir, true)
    const url = new URL(
      this.getEndpoint() + "/" + this.getBucket() + "/" + prefix,
    )
    url.searchParams.set("x-list", "true")
    url.searchParams.set("x-list-limit", "200")
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: this.getBasicAuth(),
        Accept: "application/json",
      },
    })
    if (res.status === 404) return []
    if (!res.ok) {
      throw new Error(`USS list failed: ${res.status} ${await res.text()}`)
    }
    // Upyun returns X-Upyun-List header or JSON body
    const listHeader = res.headers.get("x-upyun-list")
    if (listHeader) {
      const result: UssFileInfo[] = []
      for (const line of listHeader.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // Format: name\tF\tsize\ttime  (F=file, N=folder)
        const parts = trimmed.split("\t")
        if (parts.length < 4) continue
        const isDir = parts[1] === "N"
        result.push({
          name: parts[0],
          size: parseInt(parts[2], 10) || 0,
          is_dir: isDir,
          modified: parts[3] || new Date().toISOString(),
        })
      }
      return result
    }
    return []
  }

  public async getDownloadUrl(path: string): Promise<string> {
    const key = getKey(path, false)
    const host = this.getEndpoint() + "/" + this.getBucket() + "/" + key
    // Apply 防盗链 if configured (anti_theft_chain_token or operator_password)
    const expireHours = this.addition.sign_url_expire || 4
    const expireAt = Math.floor(Date.now() / 1000) + expireHours * 3600
    const tokenOrPwd =
      this.addition.anti_theft_chain_token || this.addition.operator_password
    const signStr = [tokenOrPwd, String(expireAt), "/" + key].join("&")
    const md5 = await md5Hex(signStr)
    const upt = md5.substring(12, 20) + String(expireAt)
    const basename = key.split("/").pop() || ""
    return `${host}?_upd=${encodeURIComponent(basename)}&_upt=${upt}`
  }

  public async mkdir(parent: string, name: string): Promise<void> {
    const path = getKey(joinPath(parent, name), true)
    const url = this.getEndpoint() + "/" + this.getBucket() + "/" + path
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.getBasicAuth(),
        Folder: "true",
        "Content-Length": "0",
      },
    })
    if (!res.ok && res.status !== 204 && res.status !== 201) {
      throw new Error(`USS mkdir failed: ${res.status} ${await res.text()}`)
    }
  }

  public async move(
    srcPath: string,
    srcIsDir: boolean,
    dstPath: string,
  ): Promise<void> {
    const src = getKey(srcPath, srcIsDir)
    const dst = getKey(dstPath, srcIsDir)
    const url = this.getEndpoint() + "/" + this.getBucket() + "/" + dst
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: this.getBasicAuth(),
        "X-Upyun-Move-Source": "/" + this.getBucket() + "/" + src,
      },
    })
    if (!res.ok && res.status !== 204 && res.status !== 201) {
      throw new Error(`USS move failed: ${res.status} ${await res.text()}`)
    }
  }

  public async copy(
    srcPath: string,
    srcIsDir: boolean,
    dstPath: string,
  ): Promise<void> {
    const src = getKey(srcPath, srcIsDir)
    const dst = getKey(dstPath, srcIsDir)
    const url = this.getEndpoint() + "/" + this.getBucket() + "/" + dst
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: this.getBasicAuth(),
        "X-Upyun-Copy-Source": "/" + this.getBucket() + "/" + src,
      },
    })
    if (!res.ok && res.status !== 204 && res.status !== 201) {
      throw new Error(`USS copy failed: ${res.status} ${await res.text()}`)
    }
  }

  public async remove(path: string, isDir: boolean): Promise<void> {
    const key = getKey(path, isDir)
    const url = this.getEndpoint() + "/" + this.getBucket() + "/" + key
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: this.getBasicAuth() },
    })
    if (!res.ok && res.status !== 204 && res.status !== 200) {
      throw new Error(`USS delete failed: ${res.status} ${await res.text()}`)
    }
  }

  public async upload(
    parentPath: string,
    name: string,
    content: Buffer,
  ): Promise<void> {
    const key = getKey(joinPath(parentPath, name), false)
    const url = this.getEndpoint() + "/" + this.getBucket() + "/" + key
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: this.getBasicAuth(),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(content.length),
      },
      body: new Uint8Array(content),
    })
    if (!res.ok && res.status !== 204 && res.status !== 201) {
      throw new Error(`USS upload failed: ${res.status} ${await res.text()}`)
    }
  }
}

/**
 * Compute MD5 hex string using Web Crypto Subtle.
 */
export async function md5Hex(s: string): Promise<string> {
  // Subtle Crypto doesn't support MD5 in browsers/Workers — fallback to a pure-JS impl.
  // We implement the standard MD5 algorithm below.
  return md5PureJs(s)
}

// ---- Pure JS MD5 implementation (RFC 1321) ----
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

function md5PureJs(input: string): string {
  // UTF-8 encode
  const bytes = new TextEncoder().encode(input)
  const n = bytes.length

  // Pre-processing: adding padding bits
  const bitLen = n * 8
  const padLen = Math.ceil((n + 1 + 8) / 64) * 64
  const padded = new Uint8Array(padLen)
  padded.set(bytes)
  padded[n] = 0x80
  // Append length (little-endian, 64-bit)
  const view = new DataView(padded.buffer)
  // length is in bits, fits in low 32 bits unless > 2^32
  view.setUint32(padLen - 8, bitLen >>> 0, true)
  view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000), true)

  // Initialize MD5 state
  let a = 0x67452301,
    b = 0xefcdab89,
    c = 0x98badcfe,
    d = 0x10325476

  // Process each 16-word block
  for (let i = 0; i < padLen; i += 64) {
    const x = new Array(16)
    for (let j = 0; j < 16; j++) {
      x[j] = view.getUint32(i + j * 4, true)
    }
    const oldA = a,
      oldB = b,
      oldC = c,
      oldD = d

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

    a = safeAdd(a, oldA)
    b = safeAdd(b, oldB)
    c = safeAdd(c, oldC)
    d = safeAdd(d, oldD)
  }

  // Convert to hex string (little-endian word order)
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

export { getKey, joinPath, getParent }
