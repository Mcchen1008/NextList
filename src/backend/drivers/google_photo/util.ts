// Google Photo HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/google_photo
import {
  GoogleApiError,
  GooglePhotoAddition,
  Items,
  MediaItem,
  TokenError,
  TokenResp,
} from "./types"

const TOKEN_URL = "https://www.googleapis.com/oauth2/v4/token"
const API_BASE = "https://photoslibrary.googleapis.com/v1"

/** Public OAuth client defaults (Go meta.go Addition defaults) */
const DEFAULT_CLIENT_ID = "202264815644.apps.googleusercontent.com"
const DEFAULT_CLIENT_SECRET = "X4Z3ca8xfWDb1Voo-F9a7ZxJ"

// Pseudo ids for the virtual root folders (Go util.go consts)
export const FETCH_ALL = "all"
export const FETCH_ALBUMS = "albums"
export const FETCH_ROOT = "root"
export const FETCH_SHARE_ALBUMS = "share_albums"

export class GooglePhotoClient {
  private addition: GooglePhotoAddition
  private accessToken = ""

  constructor(addition: GooglePhotoAddition) {
    this.addition = addition
  }

  /** Go Init(): refresh the access token up front */
  async init(): Promise<void> {
    await this.refreshToken()
  }

  /** Go meta.go DefaultRoot "root" backs the empty root_folder_id */
  getRootId(): string {
    return (this.addition.root_folder_id || "").trim() || FETCH_ROOT
  }

  /**
   * Go util.go refreshToken(): direct OAuth2 refresh with client_id /
   * client_secret (falling back to the public defaults). The Go google_photo
   * driver does NOT use the api.oplist.org relay that google_drive has —
   * it always posts straight to Google's token endpoint.
   */
  async refreshToken(): Promise<void> {
    const refreshToken = (this.addition.refresh_token || "").trim()
    if (!refreshToken) {
      throw new Error("[GooglePhoto] refresh_token is required")
    }
    const clientId = (this.addition.client_id || "").trim() || DEFAULT_CLIENT_ID
    const clientSecret =
      (this.addition.client_secret || "").trim() || DEFAULT_CLIENT_SECRET

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    })
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON body */
      }
    }
    const tokenErr = data as TokenError
    if (tokenErr.error) {
      throw new Error(
        `[GooglePhoto] refresh token failed: ${tokenErr.error}${tokenErr.error_description ? ": " + tokenErr.error_description : ""}`,
      )
    }
    const tokenResp = data as TokenResp
    if (!tokenResp.access_token) {
      throw new Error(
        `[GooglePhoto] refresh token failed: ${text || `status ${res.status}`}`,
      )
    }
    this.accessToken = tokenResp.access_token
  }

  /**
   * Go util.go request(): Bearer-authenticated call. Google error bodies
   * carry `{error:{code,message,errors}}`; code 401 triggers one
   * refresh + retry (the Go recursion is uncapped — capped to a single
   * retry here). Query params ride in the URL even for POST, matching the
   * Go driver (Google's gRPC-transcoded endpoints accept them).
   */
  async request<T = any>(
    url: string,
    method: string,
    query?: Record<string, string>,
    retry = true,
  ): Promise<T> {
    let reqUrl = url
    if (query) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        // Go drops the "first" sentinel and resty sends an empty pageToken,
        // which Google ignores — skipping empty values is equivalent.
        if (v !== "") params.set(k, v)
      }
      const qs = params.toString()
      if (qs) reqUrl += (url.includes("?") ? "&" : "?") + qs
    }

    const res = await fetch(reqUrl, {
      method,
      headers: {
        Authorization: "Bearer " + this.accessToken,
        "Accept-Encoding": "gzip",
      },
    })
    const text = await res.text()
    let data: any = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    const apiErr = (data || {}) as GoogleApiError

    if (res.status === 401 && retry) {
      await this.refreshToken()
      return this.request<T>(url, method, query, false)
    }
    const errCode = apiErr.error?.code || 0
    if (errCode !== 0 || !res.ok) {
      const message = apiErr.error?.message || `status ${res.status}`
      const details = apiErr.error?.errors
        ? JSON.stringify(apiErr.error.errors)
        : ""
      throw new Error(
        `[GooglePhoto] ${message}: ${details || text.slice(0, 200)}`,
      )
    }
    return data as T
  }

  /** Go util.go getFiles(): dispatch on the pseudo ids */
  async getFiles(id: string): Promise<MediaItem[]> {
    switch (id) {
      case FETCH_ALL:
        return this.getAllMedias()
      case FETCH_ALBUMS:
        return this.getAlbums()
      case FETCH_SHARE_ALBUMS:
        return this.getShareAlbums()
      case FETCH_ROOT:
        return this.getFakeRoot()
      default:
        return this.getMedias(id)
    }
  }

  /** Go getFakeRoot(): three virtual folders */
  getFakeRoot(): MediaItem[] {
    return [
      { id: FETCH_ALL, title: FETCH_ALL },
      { id: FETCH_ALBUMS, title: FETCH_ALBUMS },
      { id: FETCH_SHARE_ALBUMS, title: FETCH_SHARE_ALBUMS },
    ]
  }

  /** Go getAlbums(): GET /v1/albums */
  async getAlbums(): Promise<MediaItem[]> {
    return this.fetchItems(
      `${API_BASE}/albums`,
      {
        fields: "albums(id,title,coverPhotoBaseUrl),nextPageToken",
        pageSize: "50",
      },
      "GET",
    )
  }

  /** Go getShareAlbums(): GET /v1/sharedAlbums */
  async getShareAlbums(): Promise<MediaItem[]> {
    return this.fetchItems(
      `${API_BASE}/sharedAlbums`,
      {
        fields: "sharedAlbums(id,title,coverPhotoBaseUrl),nextPageToken",
        pageSize: "50",
      },
      "GET",
    )
  }

  /** Go getMedias(albumId): POST /v1/mediaItems:search */
  async getMedias(albumId: string): Promise<MediaItem[]> {
    return this.fetchItems(
      `${API_BASE}/mediaItems:search`,
      {
        fields:
          "mediaItems(id,baseUrl,mimeType,mediaMetadata,filename),nextPageToken",
        pageSize: "100",
        albumId,
      },
      "POST",
    )
  }

  /** Go getAllMedias(): GET /v1/mediaItems */
  async getAllMedias(): Promise<MediaItem[]> {
    return this.fetchItems(
      `${API_BASE}/mediaItems`,
      {
        fields:
          "mediaItems(id,baseUrl,mimeType,mediaMetadata,filename),nextPageToken",
        pageSize: "100",
      },
      "GET",
    )
  }

  /** Go getMedia(id): single media item with a fresh baseUrl */
  async getMedia(id: string): Promise<MediaItem> {
    const resp = await this.request<MediaItem | null>(
      `${API_BASE}/mediaItems/${encodeURIComponent(id)}`,
      "GET",
      { fields: "mediaMetadata,baseUrl,mimeType" },
    )
    if (!resp) {
      throw new Error(`[GooglePhoto] media item not found: ${id}`)
    }
    return resp
  }

  /** Go util.go fetchItems(): paginated loop with the "first" sentinel */
  private async fetchItems(
    url: string,
    query: Record<string, string>,
    method: string,
  ): Promise<MediaItem[]> {
    const result: MediaItem[] = []
    let pageToken = "first"
    while (pageToken !== "") {
      if (pageToken === "first") {
        pageToken = ""
      }
      const resp = await this.request<Items>(url, method, {
        ...query,
        pageToken,
      })
      pageToken = (resp && resp.nextPageToken) || ""
      if (resp?.mediaItems) result.push(...resp.mediaItems)
      if (resp?.albums) result.push(...resp.albums)
      if (resp?.sharedAlbums) result.push(...resp.sharedAlbums)
    }
    return result
  }
}
