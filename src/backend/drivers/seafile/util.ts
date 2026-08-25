// Seafile HTTP client
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/seafile
import {
  SeafileAddition,
  SeafileAuthTokenResp,
  SeafileRepoItem,
  SeafileLibraryItem,
} from "./types"

export class SeafileClient {
  private addition: SeafileAddition
  private authorization = ""
  private onTokenUpdate?: (token: string) => void

  constructor(
    addition: SeafileAddition,
    onTokenUpdate?: (token: string) => void,
  ) {
    this.addition = addition
    this.onTokenUpdate = onTokenUpdate
  }

  public getAddress(): string {
    return (this.addition.address || "").replace(/\/+$/, "")
  }

  public async init(): Promise<void> {
    await this.getToken()
  }

  public async getToken(): Promise<void> {
    if (this.addition.token) {
      this.authorization = "Token " + this.addition.token
      return
    }
    if (!this.addition.username || !this.addition.password) {
      throw new Error(
        "Seafile: username/password required when token is not set",
      )
    }
    const body = new URLSearchParams({
      username: this.addition.username,
      password: this.addition.password,
    })
    const res = await fetch(this.getAddress() + "/api2/auth-token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    if (!res.ok) {
      throw new Error(`Seafile auth failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as SeafileAuthTokenResp
    this.authorization = "Token " + data.token
    this.onTokenUpdate?.(data.token)
  }

  public async request<T = any>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    pathname: string,
    opts?: {
      query?: Record<string, string>
      form?: Record<string, string>
      json?: any
      noRedirect?: boolean
    },
    retry = true,
  ): Promise<T> {
    const full = pathname.startsWith("http")
      ? pathname
      : this.getAddress() + pathname
    const url = new URL(full)
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, v)
      }
    }
    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
      },
      redirect: opts?.noRedirect ? "manual" : "follow",
    }
    if (opts?.form) {
      const form = new URLSearchParams(opts.form)
      ;(init.headers as Record<string, string>)["Content-Type"] =
        "application/x-www-form-urlencoded"
      init.body = form.toString()
    } else if (opts?.json !== undefined) {
      ;(init.headers as Record<string, string>)["Content-Type"] =
        "application/json"
      init.body = JSON.stringify(opts.json)
    }
    const res = await fetch(url.toString(), init)
    if (res.status === 401 && retry) {
      await this.getToken()
      return this.request<T>(method, pathname, opts, false)
    }
    if (res.status >= 400) {
      throw new Error(
        `Seafile request failed: ${res.status} ${await res.text()}`,
      )
    }
    const text = await res.text()
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      // Seafile returns quoted strings like "\"https://...\""
      const trimmed = text.trim()
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return JSON.parse(trimmed) as T
      }
      return text as unknown as T
    }
  }

  public async listLibraries(): Promise<SeafileLibraryItem[]> {
    return this.request<SeafileLibraryItem[]>("GET", "/api2/repos/")
  }

  public async listDir(
    repoId: string,
    path: string,
  ): Promise<SeafileRepoItem[]> {
    return this.request<SeafileRepoItem[]>(
      "GET",
      `/api2/repos/${repoId}/dir/`,
      {
        query: { p: path },
      },
    )
  }

  public async getFileDownloadUrl(
    repoId: string,
    path: string,
  ): Promise<string> {
    return this.request<string>("GET", `/api2/repos/${repoId}/file/`, {
      query: { p: path, reuse: "1" },
    })
  }

  public async mkdir(
    repoId: string,
    parentPath: string,
    dirName: string,
  ): Promise<void> {
    const p = joinPath(parentPath, dirName)
    await this.request("POST", `/api2/repos/${repoId}/dir/`, {
      query: { p },
      form: { operation: "mkdir" },
    })
  }

  public async move(
    repoId: string,
    srcPath: string,
    dstRepoId: string,
    dstDir: string,
  ): Promise<void> {
    await this.request("POST", `/api2/repos/${repoId}/file/`, {
      query: { p: srcPath },
      form: { operation: "move", dst_repo: dstRepoId, dst_dir: dstDir },
      noRedirect: true,
    })
  }

  public async rename(
    repoId: string,
    srcPath: string,
    newName: string,
  ): Promise<void> {
    await this.request("POST", `/api2/repos/${repoId}/file/`, {
      query: { p: srcPath },
      form: { operation: "rename", newname: newName },
      noRedirect: true,
    })
  }

  public async copy(
    repoId: string,
    srcPath: string,
    dstRepoId: string,
    dstDir: string,
  ): Promise<void> {
    await this.request("POST", `/api2/repos/${repoId}/file/`, {
      query: { p: srcPath },
      form: { operation: "copy", dst_repo: dstRepoId, dst_dir: dstDir },
    })
  }

  public async remove(repoId: string, path: string): Promise<void> {
    await this.request("DELETE", `/api2/repos/${repoId}/file/`, {
      query: { p: path },
    })
  }

  public async getUploadUrl(repoId: string, dirPath: string): Promise<string> {
    return this.request<string>("GET", `/api2/repos/${repoId}/upload-link/`, {
      query: { p: dirPath },
    })
  }

  public async upload(
    uploadUrl: string,
    parentDir: string,
    fileName: string,
    content: Buffer,
  ): Promise<void> {
    const form = new FormData()
    form.append("parent_dir", parentDir)
    form.append("replace", "1")
    form.append("file", new Blob([new Uint8Array(content)]), fileName)
    const res = await fetch(uploadUrl, {
      method: "POST",
      body: form,
    })
    if (!res.ok) {
      throw new Error(
        `Seafile upload failed: ${res.status} ${await res.text()}`,
      )
    }
  }

  public async decryptLibrary(repoId: string, password: string): Promise<void> {
    await this.request("POST", `/api2/repos/${repoId}/`, {
      form: { password },
    })
  }
}

function joinPath(parent: string, name: string): string {
  const p = (parent || "").replace(/\/+$/, "")
  return p + "/" + name
}
