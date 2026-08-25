// MediaTrack HTTP client
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mediatrack
import {
  MediaTrackAddition,
  MediaTrackFile,
  MediaTrackChildrenResp,
  MediaTrackBaseResp,
  MediaTrackDownloadTokenResp,
} from "./types"

const API_BASE_JAYCE = "https://jayce.api.mediatrack.cn"
const API_BASE_KAYLE = "https://kayle.api.mediatrack.cn"
const API_BASE_KAYN = "https://kayn.api.mediatrack.cn"

export class MediaTrackClient {
  private addition: MediaTrackAddition

  constructor(addition: MediaTrackAddition) {
    this.addition = addition
  }

  public getRootId(): string {
    return this.addition.root_id || this.addition.project_id || ""
  }

  public async request<T = any>(
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: any,
    retry = true,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: "Bearer " + this.addition.access_token,
        Accept: "application/json",
      },
    }
    if (body !== undefined) {
      ;(init.headers as Record<string, string>)["Content-Type"] =
        "application/json"
      init.body = JSON.stringify(body)
    }
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
    const base = data as MediaTrackBaseResp
    if (base.status && base.status !== "SUCCESS") {
      throw new Error(base.message || `mediatrack error: ${res.status}`)
    }
    return data as T
  }

  public async getFiles(parentId: string): Promise<MediaTrackFile[]> {
    const sort = this.addition.order_by
      ? (this.addition.order_desc ? "-" : "") + this.addition.order_by
      : ""
    const result: MediaTrackFile[] = []
    let page = 1
    for (;;) {
      const url = new URL(`${API_BASE_JAYCE}/v4/assets/${parentId}/children`)
      url.searchParams.set("page", String(page))
      url.searchParams.set("size", "50")
      if (sort) url.searchParams.set("sort", sort)
      const resp = await this.request<MediaTrackChildrenResp>(
        url.toString(),
        "GET",
      )
      if (!resp.data || resp.data.assets.length === 0) break
      result.push(...resp.data.assets)
      page++
      if (page > 200) break // safety cap
    }
    return result
  }

  public async getDownloadUrl(fileId: string): Promise<string> {
    const url =
      `${API_BASE_KAYN}/v1/download_token/asset?asset_id=${encodeURIComponent(fileId)}` +
      `&source_type=project&password=&source_id=${encodeURIComponent(this.addition.project_id || "")}`
    const resp = await this.request<MediaTrackDownloadTokenResp>(url, "GET")
    const token = resp.data?.token
    if (!token) throw new Error("MediaTrack: no download token returned")
    // Follow redirect to get actual URL
    const redirectUrl = `${API_BASE_KAYN}/v1/download/redirect?token=${token}`
    const res = await fetch(redirectUrl, { method: "GET", redirect: "manual" })
    if (res.status === 302 || res.status === 301) {
      return res.headers.get("location") || redirectUrl
    }
    return redirectUrl
  }

  public async makeDir(parentId: string, dirName: string): Promise<void> {
    await this.request(
      `${API_BASE_JAYCE}/v3/assets/${parentId}/children`,
      "POST",
      {
        type: 1,
        title: dirName,
      },
    )
  }

  public async move(srcId: string, dstParentId: string): Promise<void> {
    await this.request(`${API_BASE_JAYCE}/v4/assets/batch/move`, "POST", {
      parent_id: dstParentId,
      ids: [srcId],
    })
  }

  public async rename(srcId: string, newName: string): Promise<void> {
    await this.request(`${API_BASE_JAYCE}/v3/assets/${srcId}`, "PUT", {
      title: newName,
    })
  }

  public async copy(srcId: string, dstParentId: string): Promise<void> {
    await this.request(`${API_BASE_JAYCE}/v4/assets/batch/clone`, "POST", {
      parent_id: dstParentId,
      ids: [srcId],
    })
  }

  public async remove(srcId: string, parentID: string): Promise<void> {
    await this.request(`${API_BASE_JAYCE}/v4/assets/batch/delete`, "DELETE", {
      origin_id: parentID,
      ids: [srcId],
    })
  }

  public async init(): Promise<void> {
    await this.request(`${API_BASE_KAYLE}/users`, "GET")
  }
}
