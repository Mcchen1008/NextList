// Bunny Storage (Bunny.net Storage Zone) HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/bunny_storage
import { BunnyApiError, BunnyObject, BunnyStorageAddition } from "./types"

const DEFAULT_ENDPOINT = "storage.bunnycdn.com"
const DEFAULT_PLACEHOLDER = ".openlist"
const CDN_TOKEN_METHOD_SHA256 = "sha256"
const CDN_TOKEN_METHOD_HMAC_SHA256 = "hmac_sha256"

const REQUEST_TIMEOUT = 30_000
const UPLOAD_TIMEOUT = 300_000

// ─── path helpers (ports of util.go) ─────────────────────────────────────────

/** Go cleanObjectPath(): stdpath.Clean("/" + TrimPrefix(path, "/")) */
export function cleanObjectPath(path: string): string {
  if (!path) return "/"
  const p = "/" + path.replace(/^\/+/, "")
  const parts: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return "/" + parts.join("/")
}

/** Go stripObjectPathPrefix(): (stripped, ok) */
export function stripObjectPathPrefix(
  path: string,
  prefix: string,
): { path: string; ok: boolean } {
  const p = cleanObjectPath(path)
  const pre = cleanObjectPath(prefix)
  if (pre === "/") return { path: p, ok: false }
  if (p === pre) return { path: "/", ok: true }
  if (p.startsWith(pre + "/")) {
    return { path: cleanObjectPath(p.slice(pre.length)), ok: true }
  }
  return { path: p, ok: false }
}

/** Go isObjectPathOrChild() */
export function isObjectPathOrChild(path: string, parent: string): boolean {
  const p = cleanObjectPath(path)
  const par = cleanObjectPath(parent)
  return p === par || p.startsWith(par + "/")
}

/** Go trimCDNBasePath(): CDN base path without mount-path prefix / slashes */
export function trimCDNBasePath(path: string, mountPath: string): string {
  let p = cleanObjectPath(path)
  if (p === "/") return ""
  const stripped = stripObjectPathPrefix(p, mountPath)
  if (stripped.ok) p = stripped.path
  if (p === "/") return ""
  return p.replace(/\/+$/, "")
}

/** Go normalizeBaseURL(): add scheme, strip trailing slashes, require a host */
function normalizeBaseURL(raw: string, fallback: string): URL {
  let s = (raw || "").trim()
  if (!s) s = fallback
  if (!s) throw new Error("[BunnyStorage] empty url")
  if (!s.includes("://")) s = "https://" + s
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error(`[BunnyStorage] invalid url: ${s}`)
  }
  if (!u.host) throw new Error(`[BunnyStorage] invalid url: ${s}`)
  u.pathname = u.pathname.replace(/\/+$/, "")
  return u
}

/** base64url without padding (Go base64.RawURLEncoding) */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** lenient bool parse (form stores booleans; manual additions may carry strings) */
function boolValue(v: unknown): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "string") return v === "true" || v === "1"
  return !!v
}

/**
 * Go parseBunnyTime(): accepts RFC3339(Nano) and timezone-less timestamps
 * ("2006-01-02T15:04:05[.fffffff]"); the latter parse as UTC in Go, so "Z"
 * is appended here before Date parsing. Returns ms epoch or the fallback.
 */
export function parseBunnyTime(
  value: string | undefined,
  fallbackMs: number,
): number {
  if (!value) return fallbackMs
  const v = value.trim()
  if (!v) return fallbackMs
  const m =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})?$/.exec(
      v,
    )
  if (m) {
    const t = Date.parse(`${m[1]}T${m[2]}${m[3] || "Z"}`)
    if (!isNaN(t)) return t
  }
  return fallbackMs
}

/** Go canonicalQuery(): sorted "k=v" pairs (decoded values), no token/expires */
function canonicalQuery(u: URL): string {
  const seen = new Map<string, string[]>()
  for (const [k, v] of Array.from(u.searchParams.entries())) {
    if (k === "token" || k === "expires") continue
    const vals = seen.get(k) || []
    vals.push(v)
    seen.set(k, vals)
  }
  const keys = Array.from(seen.keys()).sort()
  const parts: string[] = []
  for (const key of keys) {
    const vals = seen.get(key)!
    if (vals.length > 1) {
      throw new Error(
        `[BunnyStorage] duplicate query parameter "${key}" is not supported`,
      )
    }
    parts.push(key + "=" + (vals[0] || ""))
  }
  return parts.join("&")
}

/**
 * Bunny Storage zone client — path-style API with the `AccessKey` header:
 *   GET    /{zone}/{path}/  → listing (JSON array)
 *   PUT    /{zone}/{path}   → upload (body = object content)
 *   DELETE /{zone}/{path}/  → recursive delete (dir) / object delete (file)
 */
export class BunnyStorageClient {
  private addition: BunnyStorageAddition
  /** storage endpoint (normalized) */
  private endpoint: URL
  /** optional CDN base URL (normalized) */
  private cdnBase: URL | null = null
  /** storage mount path, used to strip it from CDN paths (Go GetStorage().MountPath) */
  private mountPath: string
  private rootFolderPath: string
  private signUrlExpire: number
  private cdnTokenMethod: string

  constructor(addition: BunnyStorageAddition, mountPath?: string) {
    this.addition = addition
    this.mountPath = mountPath || "/"
    this.rootFolderPath = addition.root_folder_path || "/"
    // the admin form stores number fields as JSON numbers, but stay lenient
    // for manually written additions carrying numeric strings
    const expireRaw: unknown = addition.sign_url_expire
    this.signUrlExpire =
      expireRaw === undefined || expireRaw === null || expireRaw === ""
        ? 0
        : Number(expireRaw) || 0
    this.cdnTokenMethod = addition.cdn_token_method || CDN_TOKEN_METHOD_SHA256
    this.endpoint = normalizeBaseURL(addition.endpoint || "", DEFAULT_ENDPOINT)
    if (addition.cdn_base_url) {
      this.cdnBase = normalizeBaseURL(addition.cdn_base_url, "")
    }
  }

  /**
   * Go Init(): normalize endpoint/CDN base and defaults. The root listing is
   * an addition (Go leaves validation to CheckStatus): it fails fast on a bad
   * zone name / access key when the storage is saved or loaded.
   */
  async init(): Promise<void> {
    if (this.signUrlExpire <= 0) this.signUrlExpire = 4
    if (!this.cdnTokenMethod) this.cdnTokenMethod = CDN_TOKEN_METHOD_SHA256
    await this.listDir("/", true)
  }

  /** Go placeholderName() */
  placeholderName(): string {
    return this.addition.placeholder || DEFAULT_PLACEHOLDER
  }

  /** Go storageURL(): https://{endpoint}/{zone}/{path} (+ trailing "/" for dirs) */
  storageURL(path: string, dir: boolean): string {
    const u = new URL(this.endpoint.toString())
    const cleanPath = cleanObjectPath(path)
    const zone = (this.addition.storage_zone_name || "").replace(
      /^\/+|\/+$/g,
      "",
    )
    u.pathname = "/" + zone + "/" + cleanPath.replace(/^\//, "")
    if (dir && !u.pathname.endsWith("/")) u.pathname += "/"
    return u.toString()
  }

  /** Go cdnURL(): CDN base + basePath + object path */
  cdnURL(path: string): string {
    if (!this.cdnBase)
      throw new Error("[BunnyStorage] cdn_base_url is not configured")
    const u = new URL(this.cdnBase.toString())
    const cleanPath = cleanObjectPath(path)
    const basePath = trimCDNBasePath(this.cdnBase.pathname, this.mountPath)
    if (cleanPath === "/") {
      u.pathname = basePath === "" ? "/" : basePath + "/"
      return u.toString()
    }
    u.pathname = basePath + "/" + cleanPath.replace(/^\//, "")
    return u.toString()
  }

  /**
   * Go cdnObjectPath(): object path for CDN links. The mount-path prefix is
   * stripped when present (Go passes virtual-looking paths through here);
   * the root folder path is re-joined when the path falls outside it.
   */
  cdnObjectPath(path: string): string {
    let objectPath = cleanObjectPath(path)
    const stripped = stripObjectPathPrefix(objectPath, this.mountPath)
    if (stripped.ok) objectPath = stripped.path
    const rootPath = cleanObjectPath(this.rootFolderPath)
    if (rootPath !== "/" && !isObjectPathOrChild(objectPath, rootPath)) {
      objectPath = cleanObjectPath(
        rootPath + "/" + objectPath.replace(/^\//, ""),
      )
    }
    return objectPath
  }

  /** Parse LastChanged/DateCreated (Go parseTimes) */
  parseTimes(item: BunnyObject): { modified: number; created: number } {
    return {
      // Go falls back to the storage record's Modified time; not available
      // here, so "now" is used for a missing LastChanged (never happens in
      // practice — Bunny always returns the field).
      modified: parseBunnyTime(item.LastChanged, Date.now()),
      created: parseBunnyTime(item.DateCreated, 0),
    }
  }

  private authHeaders(): Record<string, string> {
    return { AccessKey: this.addition.access_key || "" }
  }

  /** Go handleResponseError(): map non-2xx responses to typed errors */
  private handleResponseError(res: Response, text: string): void {
    if (res.status >= 200 && res.status < 300) return
    let message = text.trim()
    try {
      const apiErrors = JSON.parse(text) as BunnyApiError[]
      if (
        Array.isArray(apiErrors) &&
        apiErrors.length > 0 &&
        apiErrors[0].Message
      ) {
        message = apiErrors[0].Message
      }
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`[BunnyStorage] permission denied: ${message}`)
    }
    if (res.status === 404) {
      throw new Error(`[BunnyStorage] object not found: ${message}`)
    }
    throw new Error(
      `[BunnyStorage] request failed: ${res.status} ${res.statusText}: ${message}`,
    )
  }

  /** Go List(): GET /{zone}/{path}/ (dir=true) → BunnyObject[] */
  async listDir(path: string, showPlaceholder = false): Promise<BunnyObject[]> {
    const res = await fetch(this.storageURL(path, true), {
      method: "GET",
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const text = await res.text()
    this.handleResponseError(res, text)
    let items: BunnyObject[]
    try {
      items = JSON.parse(text) as BunnyObject[]
    } catch {
      throw new Error(
        `[BunnyStorage] non-JSON listing response: ${text.slice(0, 300)}`,
      )
    }
    if (!Array.isArray(items)) return []
    if (showPlaceholder) return items
    const placeholder = this.placeholderName()
    return items.filter(
      (it) =>
        it.ObjectName !== "" &&
        !(!it.IsDirectory && it.ObjectName === placeholder),
    )
  }

  /** Go putReader(): PUT /{zone}/{path} with the raw object content */
  async putObject(path: string, body: Uint8Array): Promise<void> {
    const res = await fetch(this.storageURL(path, false), {
      method: "PUT",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/octet-stream",
      },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
    })
    const text = await res.text()
    this.handleResponseError(res, text)
  }

  /** Go Remove(): DELETE /{zone}/{path} (trailing slash for dirs) */
  async deleteObject(path: string, isDir: boolean): Promise<void> {
    const res = await fetch(this.storageURL(path, isDir), {
      method: "DELETE",
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const text = await res.text()
    this.handleResponseError(res, text)
  }

  /**
   * Go Link(): CDN URL (optionally token-signed) when cdn_base_url is set,
   * otherwise the storage URL — which requires the AccessKey header, so the
   * caller must download through the proxy route (Go OnlyProxy).
   */
  async getLink(
    path: string,
  ): Promise<{ url: string; headers?: Record<string, string> }> {
    if (this.cdnBase) {
      let linkURL = this.cdnURL(this.cdnObjectPath(path))
      if (this.addition.cdn_token_key) {
        // NextList drivers have no access to the downloader's IP, so the IP
        // component of the token is empty — cdn_token_include_ip tokens will
        // therefore not validate per-client (Go LinkCacheIP is not portable).
        linkURL = await this.signCDNURL(linkURL, "")
      }
      return { url: linkURL }
    }
    return {
      url: this.storageURL(path, false),
      headers: { AccessKey: this.addition.access_key || "" },
    }
  }

  /** Go signCDNURL() */
  async signCDNURL(rawURL: string, clientIP: string): Promise<string> {
    return this.signCDNURLAt(rawURL, clientIP, Date.now())
  }

  /** Go signCDNURLAt() — `nowMs` parameter mirrors the test seam */
  async signCDNURLAt(
    rawURL: string,
    clientIP: string,
    nowMs: number,
  ): Promise<string> {
    const expireHours = this.signUrlExpire > 0 ? this.signUrlExpire : 4
    const expires = Math.floor(nowMs / 1000) + expireHours * 3600
    const u = new URL(rawURL)
    const parameterData = canonicalQuery(u)
    // signature path = the *decoded* path (Go PathUnescape(EscapedPath()));
    // decodeURIComponent keeps '+' literal, matching Go PathUnescape
    let signaturePath = u.pathname
    try {
      signaturePath = decodeURIComponent(u.pathname)
    } catch {
      /* keep escaped form, Go falls back to u.Path */
    }
    const token = await this.signCDNToken(
      signaturePath,
      String(expires),
      parameterData,
      boolValue(this.addition.cdn_token_include_ip) ? clientIP : "",
    )
    u.searchParams.set("token", token)
    u.searchParams.set("expires", String(expires))
    return u.toString()
  }

  /** Go signCDNToken(): sha256 (default) or HS256-prefixed HMAC-SHA256 */
  private async signCDNToken(
    signaturePath: string,
    expires: string,
    parameterData: string,
    clientIP: string,
  ): Promise<string> {
    const encoder = new TextEncoder()
    const method = (this.cdnTokenMethod || "").trim().toLowerCase()
    if (method === CDN_TOKEN_METHOD_HMAC_SHA256) {
      const message = signaturePath + expires + parameterData + clientIP
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(this.addition.cdn_token_key || ""),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message))
      return "HS256-" + base64UrlEncode(new Uint8Array(sig))
    }
    const hashableBase =
      (this.addition.cdn_token_key || "") +
      signaturePath +
      expires +
      parameterData +
      clientIP
    const sum = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(hashableBase),
    )
    return base64UrlEncode(new Uint8Array(sum))
  }
}
