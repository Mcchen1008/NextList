// Terabox HTTP client
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/terabox
import {
  TeraboxAddition,
  TeraboxFile,
  TeraboxListResp,
  TeraboxDownloadResp,
  TeraboxDownloadResp2,
  TeraboxHomeInfoResp,
  TeraboxCheckLoginResp,
  TeraboxLocateUploadResp,
  TeraboxPrecreateResp,
  TeraboxCreateResp,
} from "./types"

const UA = "terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox"

export class TeraboxClient {
  private addition: TeraboxAddition
  private jsToken = ""
  private urlDomainPrefix = "jp"
  private baseUrl = "https://www.terabox.com"
  private onCookieUpdate?: (cookie: string) => void

  constructor(
    addition: TeraboxAddition,
    onCookieUpdate?: (cookie: string) => void,
  ) {
    this.addition = addition
    this.onCookieUpdate = onCookieUpdate
  }

  public getRootPath(): string {
    return this.addition.root_folder_path || "/"
  }

  public getUserAgent(): string {
    return UA
  }

  public async init(): Promise<void> {
    const resp = await this.get<TeraboxCheckLoginResp>("/api/check/login")
    if (resp.errno !== 0) {
      if (resp.errno === 9000) {
        throw new Error("Terabox is not available in this area")
      }
      throw new Error("Terabox login failed — check cookie")
    }
  }

  public async resetJsToken(): Promise<void> {
    const res = await fetch(this.baseUrl, {
      method: "GET",
      headers: {
        Cookie: this.addition.cookie,
        Accept: "application/json, text/plain, */*",
        Referer: this.baseUrl,
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
      },
    })
    const html = await res.text()
    const startStr =
      "`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28%22"
    const endStr = "%22%29`"
    const startIdx = html.indexOf(startStr)
    if (startIdx < 0) throw new Error("Terabox: jsToken not found in HTML")
    const start = startIdx + startStr.length
    const end = html.indexOf(endStr, start)
    if (end < 0) throw new Error("Terabox: jsToken end not found")
    this.jsToken = html.substring(start, end)
  }

  public async request<T = any>(
    rurl: string,
    method: "GET" | "POST" | "DELETE" | "PUT",
    opts?: {
      query?: Record<string, string>
      body?: any
      form?: Record<string, string>
      contentType?: string
      multipart?: { field: string; filename: string; content: Buffer | string }
    },
    retry = true,
  ): Promise<T> {
    const fullUrl = rurl.startsWith("https://") ? rurl : this.baseUrl + rurl
    const url = new URL(fullUrl)
    // default query params
    url.searchParams.set("app_id", "250528")
    url.searchParams.set("web", "1")
    url.searchParams.set("channel", "dubox")
    url.searchParams.set("clienttype", "0")
    if (this.jsToken) url.searchParams.set("jsToken", this.jsToken)
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, v)
      }
    }
    const init: RequestInit = {
      method,
      headers: {
        Cookie: this.addition.cookie,
        Accept: "application/json, text/plain, */*",
        Referer: this.baseUrl,
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
      },
    }
    if (opts?.body !== undefined) {
      ;(init.headers as Record<string, string>)["Content-Type"] =
        opts.contentType || "application/json"
      init.body =
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)
    } else if (opts?.form) {
      const form = new URLSearchParams(opts.form)
      ;(init.headers as Record<string, string>)["Content-Type"] =
        "application/x-www-form-urlencoded"
      init.body = form.toString()
    } else if (opts?.multipart) {
      const form = new FormData()
      const content = opts.multipart.content
      // Copy bytes into a fresh Uint8Array (Buffer.buffer may be SharedArrayBuffer,
      // which is incompatible with Blob's ArrayBuffer requirement).
      const buf =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : new Uint8Array(new ArrayBuffer(content.byteLength))
      if (typeof content !== "string") {
        new Uint8Array(buf).set(
          new Uint8Array(
            content.buffer,
            content.byteOffset,
            content.byteLength,
          ),
        )
      }
      form.append(
        opts.multipart.field,
        new Blob([buf]),
        opts.multipart.filename,
      )
      init.body = form
    }
    const res = await fetch(url.toString(), init)
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON */
      }
    }
    const errno = data?.errno
    if ((errno === 4000023 || errno === 450016) && retry) {
      await this.resetJsToken()
      return this.request<T>(rurl, method, opts, false)
    }
    if (errno === -6) {
      const urlDomainPrefix = res.headers.get("Url-Domain-Prefix")
      if (urlDomainPrefix) {
        this.urlDomainPrefix = urlDomainPrefix
        this.baseUrl = "https://" + urlDomainPrefix + ".terabox.com"
        return this.request<T>(rurl, method, opts, retry)
      }
    }
    return data as T
  }

  public async get<T = any>(
    pathname: string,
    params?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>(pathname, "GET", { query: params })
  }

  public async postForm<T = any>(
    pathname: string,
    params: Record<string, string>,
    data: Record<string, string>,
  ): Promise<T> {
    return this.request<T>(pathname, "POST", { query: params, form: data })
  }

  public async postMultipart<T = any>(
    url: string,
    params: Record<string, string>,
    fieldName: string,
    fileName: string,
    content: Buffer,
  ): Promise<T> {
    return this.request<T>(url, "POST", {
      query: params,
      multipart: { field: fieldName, filename: fileName, content },
    })
  }

  public async getFiles(dir: string): Promise<TeraboxFile[]> {
    const result: TeraboxFile[] = []
    let page = 1
    const num = 100
    for (;;) {
      const params: Record<string, string> = {
        dir,
        page: String(page),
        num: String(num),
      }
      if (this.addition.order_by) {
        params["order"] = this.addition.order_by
        if (this.addition.order_direction === "desc") params["desc"] = "1"
      }
      const resp = await this.get<TeraboxListResp>("/api/list", params)
      if (resp.errno === 9000) {
        throw new Error("Terabox is not yet available in this area")
      }
      if (!resp.list || resp.list.length === 0) break
      result.push(...resp.list)
      page++
      if (page > 200) break
    }
    return result
  }

  public async genSign(): Promise<string> {
    const resp = await this.get<TeraboxHomeInfoResp>("/api/home/info", {})
    return sign(resp.data.sign3, resp.data.sign1)
  }

  public async getDownloadLink(fileId: string): Promise<string> {
    if (this.addition.download_api === "crack") {
      return this.getDownloadLinkCrack(fileId)
    }
    return this.getDownloadLinkOfficial(fileId)
  }

  private async getDownloadLinkOfficial(fileId: string): Promise<string> {
    const signString = await this.genSign()
    const params: Record<string, string> = {
      type: "dlink",
      fidlist: `[${fileId}]`,
      sign: signString,
      vip: "2",
      timestamp: String(Math.floor(Date.now() / 1000)),
    }
    const resp = await this.get<TeraboxDownloadResp>("/api/download", params)
    if (!resp.dlink || resp.dlink.length === 0) {
      throw new Error(`Terabox: no dlink found, errno ${resp.errno}`)
    }
    // Follow redirect to get the real URL
    const res = await fetch(resp.dlink[0].dlink, {
      method: "GET",
      redirect: "manual",
      headers: { Cookie: this.addition.cookie, "User-Agent": UA },
    })
    if (res.status === 302 || res.status === 301) {
      return res.headers.get("location") || resp.dlink[0].dlink
    }
    return resp.dlink[0].dlink
  }

  private async getDownloadLinkCrack(fileId: string): Promise<string> {
    const params: Record<string, string> = {
      target: `["${fileId}"]`,
      dlink: "1",
      origin: "dlna",
    }
    const resp = await this.get<TeraboxDownloadResp2>("/api/filemetas", params)
    if (!resp.info || resp.info.length === 0) {
      throw new Error("Terabox: no dlink found (crack)")
    }
    return resp.info[0].dlink
  }

  public async manage(opera: string, filelist: any): Promise<void> {
    const filelistStr = JSON.stringify(filelist)
    const data = `async=0&filelist=${encodeURIComponent(filelistStr)}&ondup=newcopy`
    await this.request("/api/filemanager", "POST", {
      query: { onnest: "fail", opera },
      body: data,
      contentType: "application/x-www-form-urlencoded",
    })
  }

  public async makeDir(parentPath: string, dirName: string): Promise<void> {
    const path = joinPath(parentPath, dirName)
    await this.postForm(
      "/api/create",
      { a: "commit" },
      {
        path,
        isdir: "1",
        block_list: "[]",
      },
    )
  }

  public async move(
    srcPath: string,
    dstPath: string,
    fileName: string,
  ): Promise<void> {
    await this.manage("move", [
      { path: srcPath, dest: dstPath, newname: fileName },
    ])
  }

  public async rename(srcPath: string, newName: string): Promise<void> {
    await this.manage("rename", [{ path: srcPath, newname: newName }])
  }

  public async copy(
    srcPath: string,
    dstPath: string,
    fileName: string,
  ): Promise<void> {
    await this.manage("copy", [
      { path: srcPath, dest: dstPath, newname: fileName },
    ])
  }

  public async remove(path: string): Promise<void> {
    await this.manage("delete", [path])
  }

  public async getUploadHost(): Promise<string> {
    const res = await fetch(
      `https://${this.urlDomainPrefix}-data.terabox.com/rest/2.0/pcs/file?method=locateupload`,
      { method: "GET" },
    )
    const data = (await res.json()) as TeraboxLocateUploadResp
    return data.host
  }

  public async precreate(
    rawPath: string,
    dstPath: string,
    mtime: number,
    blockList: string[],
  ): Promise<TeraboxPrecreateResp> {
    return this.postForm<TeraboxPrecreateResp>(
      "/api/precreate",
      {},
      {
        path: rawPath,
        autoinit: "1",
        target_path: dstPath,
        block_list: JSON.stringify(blockList),
        local_mtime: String(mtime),
        file_limit_switch_v34: "true",
      },
    )
  }

  public async uploadChunk(
    host: string,
    params: Record<string, string>,
    fileName: string,
    chunk: Buffer,
  ): Promise<{ md5: string }> {
    return this.postMultipart<{ md5: string }>(
      `https://${host}/rest/2.0/pcs/superfile2`,
      params,
      "file",
      fileName,
      chunk,
    )
  }

  public async createFile(
    rawPath: string,
    size: number,
    uploadId: string,
    targetPath: string,
    blockList: string[],
    mtime: number,
  ): Promise<TeraboxCreateResp> {
    return this.postForm<TeraboxCreateResp>(
      "/api/create",
      { isdir: "0", rtype: "1" },
      {
        path: rawPath,
        size: String(size),
        uploadid: uploadId,
        target_path: targetPath,
        block_list: JSON.stringify(blockList),
        local_mtime: String(mtime),
      },
    )
  }
}

// --- RC4-like signing (Go sign function equivalent) ---
function sign(s1: string, s2: string): string {
  const a: number[] = new Array(256)
  const p: number[] = new Array(256)
  const out: number[] = []
  const v = s1.length
  for (let q = 0; q < 256; q++) {
    a[q] = s1.charCodeAt(q % v)
    p[q] = q
  }
  for (let u = 0, q = 0; q < 256; q++) {
    u = (u + p[q] + a[q]) % 256
    ;[p[q], p[u]] = [p[u], p[q]]
  }
  for (let i = 0, u = 0, q = 0; q < s2.length; q++) {
    i = (i + 1) % 256
    u = (u + p[i]) % 256
    ;[p[i], p[u]] = [p[u], p[i]]
    const k = p[(p[i] + p[u]) % 256]
    out.push(s2.charCodeAt(q) ^ k)
  }
  // base64 encode
  let bin = ""
  for (const b of out) bin += String.fromCharCode(b)
  return btoa(bin)
}

function joinPath(parent: string, name: string): string {
  const p = (parent || "").replace(/\/+$/, "")
  return p + "/" + name
}
