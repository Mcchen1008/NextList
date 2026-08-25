// Teambition HTTP client
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/teambition
import {
  TeambitionAddition,
  TeambitionCollection,
  TeambitionWork,
  TeambitionErrResp,
} from "./types"

export class TeambitionClient {
  private addition: TeambitionAddition

  constructor(addition: TeambitionAddition) {
    this.addition = addition
  }

  public getRootId(): string {
    return this.addition.root_id || ""
  }

  public isInternational(): boolean {
    return this.addition.region === "international"
  }

  public getBaseUrl(): string {
    return this.isInternational()
      ? "https://us.teambition.com"
      : "https://www.teambition.com"
  }

  public async init(): Promise<void> {
    await this.request("/api/v2/roles", "GET")
  }

  public async request<T = any>(
    pathname: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    opts?: { query?: Record<string, string>; body?: any },
  ): Promise<T> {
    const full = pathname.startsWith("http")
      ? pathname
      : this.getBaseUrl() + pathname
    const url = new URL(full)
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        url.searchParams.set(k, v)
      }
    }
    const init: RequestInit = {
      method,
      headers: {
        Cookie: this.addition.cookie,
        Accept: "application/json",
      },
    }
    if (opts?.body !== undefined) {
      ;(init.headers as Record<string, string>)["Content-Type"] =
        "application/json"
      init.body = JSON.stringify(opts.body)
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
    const err = data as TeambitionErrResp
    if (err.name && err.message) {
      throw new Error(`Teambition error: ${err.message}`)
    }
    return data as T
  }

  public async getCollections(
    parentId: string,
  ): Promise<TeambitionCollection[]> {
    const result: TeambitionCollection[] = []
    let page = 1
    for (;;) {
      const resp = await this.request<TeambitionCollection[]>(
        "/api/collections",
        "GET",
        {
          query: {
            _parentId: parentId,
            _projectId: this.addition.project_id,
            order:
              (this.addition.order_by || "fileName") +
              (this.addition.order_direction || "Asc"),
            count: "50",
            page: String(page),
          },
        },
      )
      if (!resp || resp.length === 0) break
      result.push(...resp.filter((c) => c.title))
      page++
      if (page > 100) break
    }
    return result
  }

  public async getWorks(parentId: string): Promise<TeambitionWork[]> {
    const result: TeambitionWork[] = []
    let page = 1
    for (;;) {
      const resp = await this.request<TeambitionWork[]>("/api/works", "GET", {
        query: {
          _parentId: parentId,
          _projectId: this.addition.project_id,
          order:
            (this.addition.order_by || "fileName") +
            (this.addition.order_direction || "Asc"),
          count: "50",
          page: String(page),
        },
      })
      if (!resp || resp.length === 0) break
      result.push(...resp)
      page++
      if (page > 100) break
    }
    return result
  }

  public async getDownloadUrl(work: TeambitionWork): Promise<string> {
    if (!work.downloadUrl) return ""
    // Follow redirect to get final URL
    const res = await fetch(work.downloadUrl, {
      method: "GET",
      redirect: "manual",
    })
    if (res.status === 302 || res.status === 301) {
      return res.headers.get("location") || work.downloadUrl
    }
    return work.downloadUrl
  }

  public async makeDir(parentId: string, dirName: string): Promise<void> {
    await this.request("/api/collections", "POST", {
      body: {
        objectType: "collection",
        _projectId: this.addition.project_id,
        _creatorId: "",
        created: "",
        updated: "",
        title: dirName,
        color: "blue",
        description: "",
        workCount: 0,
        collectionType: "",
        recentWorks: [],
        _parentId: parentId,
        subCount: null,
      },
    })
  }

  public async move(
    fileId: string,
    isDir: boolean,
    dstParentId: string,
  ): Promise<void> {
    const pre = isDir ? "/api/collections/" : "/api/works/"
    await this.request(pre + fileId + "/move", "PUT", {
      body: { _parentId: dstParentId },
    })
  }

  public async rename(
    fileId: string,
    isDir: boolean,
    newName: string,
  ): Promise<void> {
    const pre = isDir ? "/api/collections/" : "/api/works/"
    const body = isDir ? { title: newName } : { fileName: newName }
    await this.request(pre + fileId, "PUT", { body })
  }

  public async copy(
    fileId: string,
    isDir: boolean,
    dstParentId: string,
  ): Promise<void> {
    const pre = isDir ? "/api/collections/" : "/api/works/"
    await this.request(pre + fileId + "/fork", "PUT", {
      body: { _parentId: dstParentId },
    })
  }

  public async remove(fileId: string, isDir: boolean): Promise<void> {
    const pre = isDir ? "/api/collections/" : "/api/works/"
    await this.request(pre + fileId + "/archive", "POST")
  }
}
