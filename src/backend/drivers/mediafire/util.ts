// MediaFire HTTP client
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mediafire
import {
  MediaFireAddition,
  MediaFireFile,
  MediaFireFolder,
  MediaFireFileResp,
  MediaFireResponse,
  MediaFireFolderContentResp,
  MediaFireDirectDownloadResp,
  MediaFireFolderCreateResp,
} from "./types"

const API_BASE = "https://www.mediafire.com/api/1.5"
const APP_BASE = "https://app.mediafire.com"
const HOST_BASE = "https://www.mediafire.com"

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

export class MediaFireClient {
  private addition: MediaFireAddition
  private sessionToken = ""
  private cookie = ""
  private onTokenUpdate?: (token: string, cookie: string) => void

  constructor(
    addition: MediaFireAddition,
    onTokenUpdate?: (token: string, cookie: string) => void,
  ) {
    this.addition = addition
    this.sessionToken = addition.session_token || ""
    this.cookie = addition.cookie || ""
    this.onTokenUpdate = onTokenUpdate
  }

  public getRootId(): string {
    return this.addition.root_folder_path || "myfiles"
  }

  public getHostBase(): string {
    return HOST_BASE
  }

  public getHeaders(): Record<string, string> {
    return {
      Cookie: this.cookie,
      "User-Agent": USER_AGENT,
      Origin: APP_BASE,
      Referer: APP_BASE + "/",
      Accept: "application/json",
    }
  }

  public async init(): Promise<void> {
    if (!this.cookie) {
      throw new Error("MediaFire: cookie is required")
    }
    if (!this.sessionToken) {
      await this.getSessionToken()
    }
  }

  public async getSessionToken(): Promise<string> {
    const url = HOST_BASE + "/application/get_session_token.php"
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
    })
    if (!res.ok) {
      throw new Error(`MediaFire: get_session_token failed: ${res.status}`)
    }
    const data = (await res.json()) as MediaFireResponse<{
      sessionToken: string
    }>
    if (data.response.result !== "Success" || !data.response.sessionToken) {
      throw new Error(
        `MediaFire: ${data.response.message || data.response.result}`,
      )
    }
    this.sessionToken = data.response.sessionToken
    // Capture Set-Cookie
    const setCookie = res.headers.get("set-cookie")
    if (setCookie) {
      // Combine new cookies with existing
      const newCookies = parseCookies(setCookie)
      const existingMap: Record<string, string> = {}
      for (const part of this.cookie.split(";").map((s) => s.trim())) {
        if (!part) continue
        const eq = part.indexOf("=")
        if (eq > 0)
          existingMap[part.substring(0, eq).trim()] = part
            .substring(eq + 1)
            .trim()
      }
      for (const [k, v] of Object.entries(newCookies)) existingMap[k] = v
      this.cookie = Object.entries(existingMap)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
    }
    this.onTokenUpdate?.(this.sessionToken, this.cookie)
    return this.sessionToken
  }

  public async renewToken(): Promise<void> {
    const data: Record<string, string> = {
      session_token: this.sessionToken,
      response_format: "json",
    }
    const resp = await this.postForm<
      MediaFireResponse<{ sessionToken: string }>
    >("/user/renew_session_token.php", data)
    if (resp.response.result !== "Success") {
      // Try to re-login
      await this.getSessionToken()
      return
    }
    this.sessionToken = resp.response.sessionToken
    this.onTokenUpdate?.(this.sessionToken, this.cookie)
  }

  public async getForm<T = any>(
    endpoint: string,
    query: Record<string, string>,
  ): Promise<T> {
    const url = new URL(API_BASE + endpoint)
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v)
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: this.getHeaders(),
    })
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON */
      }
    }
    return data as T
  }

  public async postForm<T = any>(
    endpoint: string,
    data: Record<string, string>,
  ): Promise<T> {
    const url = API_BASE + endpoint
    const form = new URLSearchParams(data)
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.getHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    })
    const text = await res.text()
    let result: any = {}
    if (text) {
      try {
        result = JSON.parse(text)
      } catch {
        /* non-JSON */
      }
    }
    return result as T
  }

  public async getFiles(folderKey: string): Promise<MediaFireFile[]> {
    const chunkSize = this.addition.chunk_size || 100
    const result: MediaFireFile[] = []
    let chunk = 1
    let hasMore = true
    while (hasMore) {
      // Fetch folders and files separately
      const folderResp = await this.getForm<MediaFireFolderContentResp>(
        "/folder/get_content.php",
        {
          session_token: this.sessionToken,
          response_format: "json",
          folder_key: folderKey,
          content_type: "folders",
          chunk: String(chunk),
          chunk_size: String(chunkSize),
          details: "yes",
          order_direction: this.addition.order_direction || "asc",
          order_by: this.addition.order_by || "name",
          filter: "",
        },
      )
      if (folderResp.response.result !== "Success") {
        throw new Error(
          `MediaFire get_content (folders) failed: ${folderResp.response.result}`,
        )
      }
      const folders: MediaFireFolder[] =
        folderResp.response.folderContent.folders || []
      for (const f of folders) {
        result.push({
          id: f.folderKey,
          name: f.name,
          size: 0,
          created_utc: f.createdUTC,
          is_folder: true,
        })
      }
      const fileResp = await this.getForm<MediaFireFolderContentResp>(
        "/folder/get_content.php",
        {
          session_token: this.sessionToken,
          response_format: "json",
          folder_key: folderKey,
          content_type: "files",
          chunk: String(chunk),
          chunk_size: String(chunkSize),
          details: "yes",
          order_direction: this.addition.order_direction || "asc",
          order_by: this.addition.order_by || "name",
          filter: "",
        },
      )
      if (fileResp.response.result !== "Success") {
        throw new Error(
          `MediaFire get_content (files) failed: ${fileResp.response.result}`,
        )
      }
      const files: MediaFireFileResp[] =
        fileResp.response.folderContent.files || []
      for (const f of files) {
        result.push({
          id: f.quickKey,
          name: f.filename,
          size: parseInt(f.size, 10) || 0,
          created_utc: f.createdUTC,
          is_folder: false,
        })
      }
      hasMore =
        folderResp.response.folderContent.moreChunks === "yes" ||
        fileResp.response.folderContent.moreChunks === "yes"
      chunk++
      if (chunk > 100) break
    }
    return result
  }

  public async getDownloadLink(fileId: string): Promise<string> {
    const resp = await this.getForm<MediaFireDirectDownloadResp>(
      "/file/get_links.php",
      {
        session_token: this.sessionToken,
        quick_key: fileId,
        link_type: "direct_download",
        response_format: "json",
      },
    )
    if (resp.response.result !== "Success" || !resp.response.links?.length) {
      throw new Error(`MediaFire get_links failed: ${resp.response.result}`)
    }
    let url = resp.response.links[0].directDownload
    // Follow redirect to get final URL
    const res = await fetch(url, { method: "HEAD", redirect: "manual" })
    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.get("location")
      if (loc) url = loc
    }
    return url
  }

  public async makeDir(
    parentKey: string,
    dirName: string,
  ): Promise<MediaFireFolderCreateResp> {
    return this.postForm<MediaFireFolderCreateResp>("/folder/create.php", {
      session_token: this.sessionToken,
      response_format: "json",
      parent_key: parentKey,
      foldername: dirName,
    })
  }

  public async move(
    fileId: string,
    isDir: boolean,
    dstFolderKey: string,
  ): Promise<void> {
    if (isDir) {
      const resp = await this.postForm<MediaFireResponse>("/folder/move.php", {
        session_token: this.sessionToken,
        response_format: "json",
        folder_key_src: fileId,
        folder_key_dst: dstFolderKey,
      })
      if (resp.response.result !== "Success") {
        throw new Error(`MediaFire folder/move failed: ${resp.response.result}`)
      }
    } else {
      const resp = await this.postForm<MediaFireResponse>("/file/move.php", {
        session_token: this.sessionToken,
        response_format: "json",
        quick_key: fileId,
        folder_key: dstFolderKey,
      })
      if (resp.response.result !== "Success") {
        throw new Error(`MediaFire file/move failed: ${resp.response.result}`)
      }
    }
  }

  public async rename(
    fileId: string,
    isDir: boolean,
    newName: string,
  ): Promise<void> {
    if (isDir) {
      const resp = await this.postForm<MediaFireResponse>(
        "/folder/update.php",
        {
          session_token: this.sessionToken,
          response_format: "json",
          folder_key: fileId,
          foldername: newName,
        },
      )
      if (resp.response.result !== "Success") {
        throw new Error(
          `MediaFire folder/update failed: ${resp.response.result}`,
        )
      }
    } else {
      const resp = await this.postForm<MediaFireResponse>("/file/update.php", {
        session_token: this.sessionToken,
        response_format: "json",
        quick_key: fileId,
        filename: newName,
      })
      if (resp.response.result !== "Success") {
        throw new Error(`MediaFire file/update failed: ${resp.response.result}`)
      }
    }
  }

  public async copy(
    fileId: string,
    isDir: boolean,
    dstFolderKey: string,
  ): Promise<void> {
    if (isDir) {
      const resp = await this.postForm<MediaFireResponse>("/folder/copy.php", {
        session_token: this.sessionToken,
        response_format: "json",
        folder_key_src: fileId,
        folder_key_dst: dstFolderKey,
      })
      if (resp.response.result !== "Success") {
        throw new Error(`MediaFire folder/copy failed: ${resp.response.result}`)
      }
    } else {
      const resp = await this.postForm<MediaFireResponse>("/file/copy.php", {
        session_token: this.sessionToken,
        response_format: "json",
        quick_key: fileId,
        folder_key: dstFolderKey,
      })
      if (resp.response.result !== "Success") {
        throw new Error(`MediaFire file/copy failed: ${resp.response.result}`)
      }
    }
  }

  public async remove(fileId: string, isDir: boolean): Promise<void> {
    if (isDir) {
      const resp = await this.postForm<MediaFireResponse>(
        "/folder/delete.php",
        {
          session_token: this.sessionToken,
          response_format: "json",
          folder_key: fileId,
        },
      )
      if (resp.response.result !== "Success") {
        throw new Error(
          `MediaFire folder/delete failed: ${resp.response.result}`,
        )
      }
    } else {
      const resp = await this.postForm<MediaFireResponse>("/file/delete.php", {
        session_token: this.sessionToken,
        response_format: "json",
        quick_key: fileId,
      })
      if (resp.response.result !== "Success") {
        throw new Error(`MediaFire file/delete failed: ${resp.response.result}`)
      }
    }
  }
}

function parseCookies(setCookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {}
  // Set-Cookie header can contain multiple cookies separated by comma
  // Each cookie looks like: name=value; Path=/; HttpOnly; ...
  const parts = setCookieHeader.split(/,(?=[^;]+;)/)
  for (const p of parts) {
    const first = p.split(";")[0].trim()
    const eq = first.indexOf("=")
    if (eq > 0) {
      result[first.substring(0, eq).trim()] = first.substring(eq + 1).trim()
    }
  }
  return result
}
