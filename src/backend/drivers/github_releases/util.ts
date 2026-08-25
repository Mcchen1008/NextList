// GitHub Releases HTTP client + virtual tree helpers
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/github_releases
//
// API (Go util.go GetRequest):
//   GET https://api.github.com/repos/{repo}/releases/latest
//   GET https://api.github.com/repos/{repo}/releases?per_page=&page=
//   GET https://api.github.com/repos/{repo}/contents          (README/LICENSE)
// Headers: Accept: application/vnd.github+json, X-GitHub-Api-Version:
// 2022-11-28, optional Authorization: Bearer <token>.
// Asset browser download URLs (github.com/{owner}/{repo}/releases/download/
// {tag}/{file}) can be rewritten through gh_proxy.
import {
  FileInfo,
  GhReleaseFile,
  GithubReleasesAddition,
  MountPoint,
  Release,
} from "./types"

const GITHUB_API = "https://api.github.com"

// OpenList drivers/base/client.go UserAgent
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

export class GithubReleasesClient {
  private addition: GithubReleasesAddition

  constructor(addition: GithubReleasesAddition) {
    this.addition = addition
  }

  /** Go GetRequest(): GET with GitHub headers + optional bearer token */
  private async getRequest<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    }
    if (this.addition.token && this.addition.token.trim()) {
      headers["Authorization"] = `Bearer ${this.addition.token.trim()}`
    }
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status !== 200) {
      // Go: fmt.Errorf("github api error: status %d", res.StatusCode())
      throw new Error(`[GitHubReleases] github api error: status ${res.status}`)
    }
    return (await res.json()) as T
  }

  /** Go getLatestRelease() */
  async getLatestRelease(repo: string): Promise<Release | null> {
    return this.getRequest<Release>(
      `${GITHUB_API}/repos/${repo}/releases/latest`,
    )
  }

  /** Go getAllReleases() — automatic pagination honoring per_page/max_page */
  async getAllReleases(repo: string): Promise<Release[]> {
    let perPage = this.addition.per_page || 0
    if (perPage < 1) {
      perPage = 30
    } else if (perPage > 100) {
      perPage = 100
    }

    let maxPage = this.addition.max_page || 0
    if (maxPage < 0) {
      maxPage = 0
    }

    const allReleases: Release[] = []
    let page = 1
    for (;;) {
      const releases = await this.getRequest<Release[]>(
        `${GITHUB_API}/repos/${repo}/releases?per_page=${perPage}&page=${page}`,
      )
      if (!releases || releases.length === 0) {
        break
      }
      allReleases.push(...releases)
      // 达到最大页数限制
      if (maxPage > 0 && page >= maxPage) {
        break
      }
      // 如果返回数量小于 perPage，说明是最后一页
      if (releases.length < perPage) {
        break
      }
      page++
    }
    return allReleases
  }

  /** Go fetchRepoFiles() — repo root contents (README/LICENSE files) */
  async fetchRepoFiles(repo: string): Promise<FileInfo[]> {
    return this.getRequest<FileInfo[]>(`${GITHUB_API}/repos/${repo}/contents`)
  }
}

// ---------------------------------------------------------------------------
// Virtual tree helpers — port of Go util.go / types.go
// ---------------------------------------------------------------------------

/**
 * Go ParseRepos(): parse the repo_structure text into mount points.
 * Each non-empty line is "owner/repo" (mounted at "/") or "path:owner/repo".
 */
export function parseRepos(text: string): MountPoint[] {
  const points: MountPoint[] = []
  for (const rawLine of (text || "").split("\n")) {
    const line = rawLine.trim()
    if (!line) continue

    const parts = line.split(":")
    let point = ""
    let repo = ""
    if (parts.length === 1) {
      point = "/"
      repo = parts[0]
    } else if (parts.length === 2) {
      // Go: fmt.Sprintf("/%s", strings.Trim(parts[0], "/"))
      point = "/" + parts[0].replace(/^\/+/, "").replace(/\/+$/, "")
      repo = parts[1]
    } else {
      throw new Error(
        `[GitHubReleases] invalid repo_structure line: ${line} (format: [path:]org/repo)`,
      )
    }
    points.push({ point, repo })
  }
  return points
}

/** Go GetNextDir(): first path segment of wholePath below basePath ("" if none) */
export function getNextDir(wholePath: string, basePath: string): string {
  const trimmedBase = basePath.replace(/\/+$/, "")
  const base = trimmedBase + "/"
  if (!wholePath.startsWith(base)) {
    return ""
  }
  const remainingPath = wholePath.slice(base.length).replace(/^\/+/, "")
  if (remainingPath !== "") {
    const nextDir = remainingPath.split("/")[0]
    if (wholePath.startsWith(trimmedBase + "/" + nextDir)) {
      return nextDir
    }
  }
  return ""
}

/** Go path.Join(dir, name) for already-clean absolute dirs */
export function joinPath(dir: string, name: string): string {
  if (!dir || dir === "/") return "/" + name
  return dir.replace(/\/+$/, "") + "/" + name
}

/** Go releaseToFiles(): latest release assets as files at the mount point */
export function releaseToFiles(
  point: string,
  release: Release | null,
): GhReleaseFile[] {
  if (!release) return []
  const files: GhReleaseFile[] = []
  for (const asset of release.assets || []) {
    files.push({
      path: joinPath(point, asset.name),
      fileName: asset.name,
      size: asset.size,
      type: "file",
      updateAt: asset.updated_at || "",
      createAt: asset.created_at || "",
      url: asset.browser_download_url || "",
    })
  }
  return files
}

/** Go releaseSize(): total asset size of a release */
export function releaseSize(release: Release | null): number {
  if (!release) return 0
  let size = 0
  for (const asset of release.assets || []) {
    size += asset.size
  }
  return size
}

/** Go releasesToVersionDirs(): one dir per release tag */
export function releasesToVersionDirs(
  point: string,
  releases: Release[],
): GhReleaseFile[] {
  const files: GhReleaseFile[] = []
  for (const release of releases) {
    files.push({
      path: joinPath(point, release.tag_name),
      fileName: release.tag_name,
      size: releaseSize(release),
      type: "dir",
      updateAt: release.published_at || "",
      createAt: release.created_at || "",
      url: release.html_url || "",
    })
  }
  return files
}

/** Go releaseAssetsByTag(): assets of the release with the given tag */
export function releaseAssetsByTag(
  point: string,
  tagName: string,
  releases: Release[],
): GhReleaseFile[] {
  for (const item of releases) {
    if (item.tag_name === tagName) {
      const files: GhReleaseFile[] = []
      for (const asset of item.assets || []) {
        files.push({
          path: joinPath(joinPath(point, tagName), asset.name),
          fileName: asset.name,
          size: asset.size,
          type: "file",
          updateAt: asset.updated_at || "",
          createAt: asset.created_at || "",
          url: asset.browser_download_url || "",
        })
      }
      return files
    }
  }
  return []
}

/** Go releasesTotalSize(): total asset size across all releases */
export function releasesTotalSize(releases: Release[]): number {
  let size = 0
  for (const release of releases) {
    size += releaseSize(release)
  }
  return size
}

/** Go sourceCodeFiles(): Source code (zip) / (tar.gz) pseudo files */
export function sourceCodeFiles(
  point: string,
  release: Release | null,
): GhReleaseFile[] {
  if (!release) return []
  return [
    {
      path: joinPath(point, "Source code (zip)"),
      fileName: "Source code (zip)",
      size: 1,
      type: "file",
      updateAt: release.created_at || "",
      createAt: release.created_at || "",
      url: release.zipball_url || "",
    },
    {
      path: joinPath(point, "Source code (tar.gz)"),
      fileName: "Source code (tar.gz)",
      size: 1,
      type: "file",
      updateAt: release.created_at || "",
      createAt: release.created_at || "",
      url: release.tarball_url || "",
    },
  ]
}

/** Go sourceCodeFilesByTag() */
export function sourceCodeFilesByTag(
  point: string,
  releases: Release[],
  tagName: string,
): GhReleaseFile[] {
  for (const item of releases) {
    if (item.tag_name === tagName) {
      return sourceCodeFiles(point, item)
    }
  }
  return []
}

/**
 * Go otherFiles(): README.md / LICENSE* files from the repo root.
 * (Go hardcodes the 1970 epoch as their timestamp.)
 */
export function otherFiles(
  point: string,
  fileInfos: FileInfo[],
): GhReleaseFile[] {
  const files: GhReleaseFile[] = []
  const defaultTime = "1970-01-01T00:00:00Z"
  for (const file of fileInfos) {
    if (file.type === "dir") {
      continue
    }
    const name = file.name
    // Go: strings.EqualFold(name, "README.md") || strings.HasPrefix(name, "LICENSE")
    if (name.toLowerCase() === "readme.md" || name.startsWith("LICENSE")) {
      files.push({
        path: joinPath(point, file.name),
        fileName: file.name,
        size: file.size || 0,
        type: "file",
        updateAt: defaultTime,
        createAt: defaultTime,
        url: file.download_url || "",
      })
    }
  }
  return files
}

/** RFC3339 → ISO string, falling back to the epoch (Go zero time behavior) */
export function toIsoTime(t?: string | null): string {
  if (t) {
    const d = new Date(t)
    if (!isNaN(d.getTime())) {
      return d.toISOString()
    }
  }
  return "1970-01-01T00:00:00.000Z"
}
