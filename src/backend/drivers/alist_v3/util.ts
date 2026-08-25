// AList V3 HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/alist_v3
// Also compatible with OpenList servers (same API).
//
// Cloudflare Workers compatible: plain `fetch` only, no Node-specific APIs.

import { md5 } from "../../pkg/crypto"
import {
  AListV3Addition,
  AListV3FsGetResp,
  AListV3FsListResp,
  AListV3LoginResp,
  AListV3MeResp,
  AListV3Resp,
} from "./types"

/** Go internal/model/user.go: GENERAL=0, GUEST=1, ADMIN=2 */
const ROLE_GUEST = 1

/** Default timeout for JSON API calls */
const API_TIMEOUT_MS = 30_000
/** Timeout for streaming uploads (Go commented out a 6h timeout; be generous) */
const PUT_TIMEOUT_MS = 10 * 60_000

/** Error carrying the AList business code (HTTP status or body `code`). */
class AListV3ApiError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = "AListV3ApiError"
    this.code = code
  }
}

/**
 * Normalize a physical path into an absolute AList path:
 * leading "/", no trailing "/" (except the root itself). Mirrors the way Go
 * `path.Join` cleans paths before sending them to the remote server.
 */
export function normalizeRemotePath(p: string | undefined | null): string {
  const parts = String(p || "")
    .split("/")
    .filter(Boolean)
  return "/" + parts.join("/")
}

/** Go `path.Dir` semantics on an already-normalized remote path. */
export function dirName(p: string): string {
  const norm = normalizeRemotePath(p)
  if (norm === "/") return "/"
  const idx = norm.lastIndexOf("/")
  return idx <= 0 ? "/" : norm.slice(0, idx)
}

/** Go `path.Base` semantics on an already-normalized remote path. */
export function baseName(p: string): string {
  const norm = normalizeRemotePath(p)
  if (norm === "/") return "/"
  return norm.slice(norm.lastIndexOf("/") + 1)
}

/** Coerce loosely-typed addition booleans (may arrive as "true"/"false"). */
function asBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback
  if (typeof v === "boolean") return v
  const s = String(v).toLowerCase()
  if (s === "true" || s === "1") return true
  if (s === "false" || s === "0") return false
  return fallback
}

export function normalizeAListV3Addition(a: any): AListV3Addition {
  const raw = { ...(a || {}) } as any
  return {
    url: String(raw.url ?? "").trim(),
    meta_password: String(raw.meta_password ?? ""),
    username: String(raw.username ?? ""),
    password: String(raw.password ?? ""),
    token: String(raw.token ?? ""),
    // Go defaults: pass_ip_to_upsteam / pass_ua_to_upsteam / forward_archive_requests = true
    pass_ip_to_upsteam: asBool(raw.pass_ip_to_upsteam, true),
    pass_ua_to_upsteam: asBool(raw.pass_ua_to_upsteam, true),
    forward_archive_requests: asBool(raw.forward_archive_requests, true),
    root_folder_path: String(raw.root_folder_path ?? "/"),
    order_by: raw.order_by || "name",
    order_direction: raw.order_direction === "desc" ? "desc" : "asc",
  }
}

/**
 * Client for the AList V3 / OpenList HTTP API (`/api/*` endpoints).
 *
 * Auth model (ported from Go util.go):
 *  - `Authorization: <token>` header on every request (token from config or login)
 *  - responses use the `{ code, message, data }` envelope; `code !== 200` is an error
 *  - on code 401/403 the client re-logins once (when username is configured)
 *    and retries the original request
 */
export class AListV3Client {
  private addition: AListV3Addition
  /** Server address without trailing slash (Go Init trims it too). */
  private address: string
  private token: string

  constructor(addition: AListV3Addition) {
    this.addition = addition
    this.address = (addition.url || "").replace(/\/+$/, "")
    this.token = addition.token || ""
  }

  getAddress(): string {
    return this.address
  }

  getToken(): string {
    return this.token
  }

  // ── Low-level request ─────────────────────────────────────────────────────

  /**
   * Single-shot request (no re-login retry). Validates HTTP status and the
   * `{code,message,data}` envelope, mirrors Go `request()` error strings.
   */
  private async doRequest<T>(
    api: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>,
    timeoutMs = API_TIMEOUT_MS,
  ): Promise<AListV3Resp<T>> {
    const url = this.address + "/api" + api
    const h: Record<string, string> = {
      Authorization: this.token,
      Accept: "application/json",
      ...headers,
    }
    const init: RequestInit = {
      method,
      headers: h,
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (body !== undefined) {
      h["Content-Type"] = "application/json"
      init.body = JSON.stringify(body)
    }

    const res = await fetch(url, init)
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON body → treated as code 0 below */
      }
    }

    if (res.status >= 400) {
      throw new AListV3ApiError(
        res.status,
        `[AListV3] request failed, status: ${res.status} ${res.statusText}`.trim(),
      )
    }

    const code = Number(data?.code) || 0
    if (code !== 200) {
      const message = String(data?.message || "")
      throw new AListV3ApiError(
        code,
        `[AListV3] request failed, code: ${code}, message: ${message}`,
      )
    }
    return data as AListV3Resp<T>
  }

  /**
   * Request with a single re-login retry on 401/403 (token expired/invalid),
   * mirroring the retry branch of Go `request(api, method, callback, retry...)`.
   */
  async request<T>(
    api: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<AListV3Resp<T>> {
    try {
      return await this.doRequest<T>(api, method, body, headers)
    } catch (e) {
      if (e instanceof AListV3ApiError && (e.code === 401 || e.code === 403)) {
        // Re-login and retry once. Without a configured username the token
        // cannot be refreshed, so surface the original auth error instead.
        if (this.addition.username) {
          await this.login()
          return this.doRequest<T>(api, method, body, headers)
        }
      }
      throw e
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /** POST /api/auth/login → token (Go util.go `login()`). */
  async login(): Promise<void> {
    // Go: no username → nothing to do (guest access)
    if (!this.addition.username) return

    const resp = await this.doRequest<AListV3LoginResp>("/auth/login", "POST", {
      username: this.addition.username,
      password: this.addition.password || "",
    })
    const token = resp.data?.token
    if (!token) {
      throw new Error("[AListV3] login succeeded but no token returned")
    }
    this.token = token
  }

  /** GET /api/me */
  async me(): Promise<AListV3MeResp> {
    const resp = await this.request<AListV3MeResp>("/me", "GET")
    return resp.data as AListV3MeResp
  }

  /**
   * Go driver.go `Init()`:
   *  1. GET /me with the current token
   *  2. if the configured username differs from the logged-in one → login again
   *  3. GET /me again
   *  4. guest accounts are only allowed when the site enables `allow_mounted`
   */
  async init(): Promise<void> {
    if (!this.address) {
      throw new Error("[AListV3] server address (url) is required")
    }

    const first = await this.me()
    if ((this.addition.username || "") !== (first.username || "")) {
      await this.login()
    }
    const me = await this.me()

    // Role is an IntSlice in Go: a bare int or an int array.
    const roles = Array.isArray(me.role) ? me.role : [me.role]
    if (roles.includes(ROLE_GUEST)) {
      const allowed = await this.checkAllowMounted()
      if (!allowed) {
        throw new Error("[AListV3] the site does not allow mounted")
      }
    }
  }

  /** GET /api/public/settings → data.allow_mounted == "true" (guest check). */
  private async checkAllowMounted(): Promise<boolean> {
    try {
      const res = await fetch(this.address + "/api/public/settings", {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
      const data: any = await res.json().catch(() => null)
      const v = data?.data?.allow_mounted
      return v === "true" || v === true
    } catch {
      return false
    }
  }

  // ── Fs operations ─────────────────────────────────────────────────────────

  /** POST /api/fs/list (page 1, per_page 0 = all entries). */
  async list(path: string): Promise<AListV3FsListResp> {
    const resp = await this.request<AListV3FsListResp>("/fs/list", "POST", {
      page: 1,
      per_page: 0,
      path,
      password: this.addition.meta_password || "",
      refresh: false,
    })
    return resp.data as AListV3FsListResp
  }

  /** POST /api/fs/get → object info + raw_url. */
  async get(path: string): Promise<AListV3FsGetResp> {
    const resp = await this.request<AListV3FsGetResp>("/fs/get", "POST", {
      path,
      password: this.addition.meta_password || "",
    })
    return resp.data as AListV3FsGetResp
  }

  /** POST /api/fs/mkdir */
  async mkdir(path: string): Promise<void> {
    await this.request("/fs/mkdir", "POST", { path })
  }

  /** POST /api/fs/rename */
  async rename(path: string, name: string): Promise<void> {
    await this.request("/fs/rename", "POST", { path, name })
  }

  /** POST /api/fs/move */
  async move(srcDir: string, dstDir: string, names: string[]): Promise<void> {
    await this.request("/fs/move", "POST", {
      src_dir: srcDir,
      dst_dir: dstDir,
      names,
    })
  }

  /** POST /api/fs/copy */
  async copy(srcDir: string, dstDir: string, names: string[]): Promise<void> {
    await this.request("/fs/copy", "POST", {
      src_dir: srcDir,
      dst_dir: dstDir,
      names,
    })
  }

  /** POST /api/fs/remove */
  async remove(dir: string, names: string[]): Promise<void> {
    await this.request("/fs/remove", "POST", { dir, names })
  }

  /**
   * PUT /api/fs/put — streaming upload (Go driver.go `Put()`).
   *
   * The remote file path travels in the URL-encoded `File-Path` header (the
   * server side does `url.PathUnescape`, see OpenList server/middlewares/fsup.go).
   * On 401/403 the client re-logins and retries once (Go only re-logged in and
   * failed; retrying immediately is a strict improvement).
   */
  async put(
    remotePath: string,
    content: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const doPut = async (): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: this.token,
        "File-Path": encodeURIComponent(remotePath),
        Password: this.addition.meta_password || "",
        "Content-Type": "application/octet-stream",
        // Go forwards MD5/SHA1/SHA256 when the upload stream carries them;
        // NextList hands us a plain buffer, so provide the cheap MD5.
        "X-File-Md5": md5(content),
      }
      return fetch(this.address + "/api/fs/put", {
        method: "PUT",
        headers,
        body: content,
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
      })
    }

    let res = await doPut()
    let text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON */
      }
    }
    const code = Number(data?.code) || 0

    // Auth expired → re-login and retry once (only possible with a username).
    if (
      (res.status === 401 ||
        res.status === 403 ||
        code === 401 ||
        code === 403) &&
      this.addition.username
    ) {
      await this.login()
      res = await doPut()
      text = await res.text()
      data = {}
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          /* non-JSON */
        }
      }
    }

    if (res.status >= 400) {
      throw new Error(
        `[AListV3] put failed, status: ${res.status} ${res.statusText}`.trim(),
      )
    }
    const finalCode = Number(data?.code) || 0
    if (finalCode !== 200) {
      throw new Error(
        `[AListV3] put failed, code: ${finalCode}, message: ${String(data?.message || "")}`,
      )
    }
  }
}
