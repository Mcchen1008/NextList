// CNB Releases HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cnb_releases
import { CnbReleasesAddition, CnbRelease, CnbReleaseAsset } from "./types"

// OpenList drivers/base client.go UserAgent
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

const API_BASE = "https://api.cnb.cool"

/** Go utils: sumAssetsSize */
export function sumAssetsSize(assets?: CnbReleaseAsset[]): number {
  return (assets || []).reduce((sum, a) => sum + (a.size || 0), 0)
}

export class CnbReleasesClient {
  private addition: CnbReleasesAddition

  constructor(addition: CnbReleasesAddition) {
    this.addition = addition
  }

  /**
   * Go Request(): executes {method} against https://api.cnb.cool{path}
   * (absolute http(s) paths pass through) with `Accept: application/json`
   * and `Authorization: Bearer {token}`. Accepts 200/201/204, otherwise
   * throws. Returns the parsed JSON body (or null for 204/empty bodies).
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const url = path.startsWith("http") ? path : API_BASE + path
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: "Bearer " + (this.addition.token || ""),
      "User-Agent": USER_AGENT,
    }
    let bodyInit: string | undefined
    if (body !== undefined) {
      headers["Content-Type"] = "application/json"
      bodyInit = JSON.stringify(body)
    }
    const res = await fetch(url, {
      method,
      headers,
      body: bodyInit,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      throw new Error(
        `[CnbReleases] failed to request ${url}, status code: ${res.status}, message: ${text.slice(0, 300)}`,
      )
    }
    if (res.status === 204 || !text) return null
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(
        `[CnbReleases] invalid JSON response from ${url}: ${text.slice(0, 300)}`,
      )
    }
  }

  /**
   * GET /{repo}/-/releases — all releases of the repo.
   * Note: like the Go driver this is a single un-paginated request.
   * The repo slug is interpolated with its literal "/" (the documented API
   * form; Go resty path-escapes it to %2F which the same route accepts).
   */
  async listReleases(): Promise<CnbRelease[]> {
    const resp = await this.request<CnbRelease[]>(
      "GET",
      `/${this.addition.repo}/-/releases`,
    )
    return Array.isArray(resp) ? resp : []
  }

  /** GET /{repo}/-/releases/{release_id} — single release with assets */
  async getRelease(releaseId: string): Promise<CnbRelease> {
    const resp = await this.request<CnbRelease>(
      "GET",
      `/${this.addition.repo}/-/releases/${encodeURIComponent(releaseId)}`,
    )
    return resp as CnbRelease
  }
}
