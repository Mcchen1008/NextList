// KodBox HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/kodbox
import {
  KodBoxAddition,
  KodBoxCommonResp,
  KodBoxFolderOrFile,
  KodBoxListPathData,
} from "./types"

// OpenList drivers/base client.go UserAgent
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

const REQUEST_TIMEOUT = 30_000
const UPLOAD_TIMEOUT = 300_000

/** Error code returned by KodBox when the accessToken has expired */
const TOKEN_EXPIRED_CODE = "10001"

function stringifyAny(v: unknown): string {
  if (v === undefined || v === null) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * Normalize a NextList physical path into the path form KodBox expects.
 * Go Init() does strings.TrimPrefix(utils.FixAndCleanPath(RootFolderPath), "/"),
 * i.e. root path "" and children paths without a leading slash.
 */
export function normalizeKodboxPath(physicalPath: string): string {
  return (physicalPath || "").split("/").filter(Boolean).join("/")
}

export class KodBoxClient {
  private addition: KodBoxAddition
  /** trimmed in constructor like Go Init(): strings.TrimSuffix(Address, "/") */
  private address: string
  /** session/token returned by loginSubmit (Go: d.authorization) */
  private authorization = ""

  constructor(addition: KodBoxAddition) {
    this.addition = addition
    this.address = (addition.address || "").replace(/\/+$/, "")
  }

  public getAuthorization(): string {
    return this.authorization
  }

  /**
   * Go getToken(): POST {address}/?user/index/loginSubmit with name/password
   * as URL query params (resty SetQueryParams appends them after the route
   * key, producing "...loginSubmit&name=..&password=..").
   * Response body: CommonResp with code=true and info=<token string>.
   */
  async getToken(): Promise<void> {
    const params = new URLSearchParams()
    params.set("name", this.addition.username || "")
    params.set("password", this.addition.password || "")
    const url = `${this.address}/?user/index/loginSubmit&${params.toString()}`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
    const text = await res.text()
    if (res.status >= 400) {
      throw new Error(
        `[KodBox] get token failed: ${res.status} ${text.slice(0, 300)}`,
      )
    }
    let resp: KodBoxCommonResp
    try {
      resp = JSON.parse(text) as KodBoxCommonResp
    } catch {
      throw new Error(`[KodBox] get token failed: ${text.slice(0, 300)}`)
    }
    if (resp.code !== true) {
      throw new Error(`[KodBox] get token failed: ${text.slice(0, 300)}`)
    }
    this.authorization = stringifyAny(resp.info)
  }

  /**
   * Go request(): POST form-urlencoded to {address}{pathname} with the
   * accessToken merged into the form data. When the API answers
   * code="10001" the token is refreshed and the request retried once.
   * Throws when the final code is not `true`.
   *
   * `noRedirect` mirrors Go's NoRedirectClient usage (List/Move/Rename).
   */
  async request(
    pathname: string,
    formData: Record<string, string>,
    noRedirect = false,
  ): Promise<KodBoxCommonResp> {
    const url = pathname.startsWith("http") ? pathname : this.address + pathname

    let resp: KodBoxCommonResp | null = null
    for (let attempt = 0; ; attempt++) {
      const body = new URLSearchParams({
        ...formData,
        accessToken: this.authorization,
      })
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: body.toString(),
        redirect: noRedirect ? "manual" : "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      })
      const text = await res.text()
      let parsed: KodBoxCommonResp
      try {
        parsed = JSON.parse(text) as KodBoxCommonResp
      } catch {
        throw new Error(
          `[KodBox] request failed: ${res.status} non-JSON response: ${text.slice(0, 300)}`,
        )
      }
      resp = parsed
      if (parsed.code === TOKEN_EXPIRED_CODE && attempt === 0) {
        // access token expired — refresh and retry once (Go request loop)
        await this.getToken()
        continue
      }
      break
    }

    const finalResp = resp as KodBoxCommonResp
    if (finalResp.code !== true) {
      throw new Error(
        `[KodBox] request failed: ${stringifyAny(finalResp.data) || stringifyAny(finalResp.code)}`,
      )
    }
    return finalResp
  }

  /** Go List(): POST /?explorer/list/path (noRedirect) → folderList + fileList */
  async listPath(path: string): Promise<KodBoxFolderOrFile[]> {
    const resp = await this.request("/?explorer/list/path", { path }, true)
    const data = (resp.data || {}) as KodBoxListPathData
    const folders = data.folderList || []
    const files = data.fileList || []
    return [...folders, ...files]
  }

  /** Go Link(): direct download url via fileOut */
  buildFileOutUrl(path: string): string {
    // Go interpolates the path raw; encodeURIComponent only fixes names with
    // "&"/"/"/spaces/non-ASCII which would otherwise corrupt the query string
    return (
      `${this.address}/?explorer/index/fileOut` +
      `&path=${encodeURIComponent(path)}` +
      `&download=1&accessToken=${encodeURIComponent(this.authorization)}`
    )
  }

  /** Go MakeDir(): POST /?explorer/index/mkdir, info = new dir path */
  async makeDir(path: string): Promise<string> {
    const resp = await this.request("/?explorer/index/mkdir", { path })
    return stringifyAny(resp.info) || path
  }

  /** Go Rename(): POST /?explorer/index/pathRename (noRedirect) */
  async rename(path: string, newName: string): Promise<void> {
    await this.request("/?explorer/index/pathRename", { path, newName }, true)
  }

  /** Go Move(): POST /?explorer/index/pathCuteTo (noRedirect) */
  async move(
    srcPath: string,
    srcName: string,
    dstDirPath: string,
  ): Promise<void> {
    await this.request(
      "/?explorer/index/pathCuteTo",
      {
        dataArr: JSON.stringify([{ path: srcPath, name: srcName }]),
        path: dstDirPath,
      },
      true,
    )
  }

  /** Go Copy(): POST /?explorer/index/pathCopyTo */
  async copy(
    srcPath: string,
    srcName: string,
    dstDirPath: string,
  ): Promise<void> {
    await this.request("/?explorer/index/pathCopyTo", {
      dataArr: JSON.stringify([{ path: srcPath, name: srcName }]),
      path: dstDirPath,
    })
  }

  /** Go Remove(): POST /?explorer/index/pathDelete with shiftDelete=1 */
  async remove(path: string, name: string): Promise<void> {
    await this.request("/?explorer/index/pathDelete", {
      dataArr: JSON.stringify([{ path, name }]),
      shiftDelete: "1",
    })
  }

  /**
   * Go Put(): multipart POST /?explorer/upload/fileUpload with the
   * accessToken + path form fields and the raw file content as the "file"
   * part. Retries once with a fresh token on code "10001" (Go's request
   * loop applied here too — with an in-memory buffer the retry is safe).
   * Returns the uploaded file path (resp.info).
   */
  async upload(
    dirPath: string,
    fileName: string,
    content: Buffer,
  ): Promise<string> {
    const url = this.address + "/?explorer/upload/fileUpload"

    const doUpload = async (): Promise<KodBoxCommonResp> => {
      const form = new FormData()
      form.set("accessToken", this.authorization)
      form.set("path", dirPath)
      form.set("file", new Blob([new Uint8Array(content)]), fileName)

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
        },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
      })
      const text = await res.text()
      let parsed: KodBoxCommonResp
      try {
        parsed = JSON.parse(text) as KodBoxCommonResp
      } catch {
        throw new Error(
          `[KodBox] upload failed: ${res.status} non-JSON response: ${text.slice(0, 300)}`,
        )
      }
      return parsed
    }

    let resp = await doUpload()
    if (resp.code === TOKEN_EXPIRED_CODE) {
      await this.getToken()
      resp = await doUpload()
    }
    if (resp.code !== true) {
      throw new Error(
        `[KodBox] upload failed: ${stringifyAny(resp.data) || stringifyAny(resp.code)}`,
      )
    }
    return stringifyAny(resp.info)
  }
}
