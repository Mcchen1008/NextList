// GitHub Releases driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/github_releases

/** Mirrors Go meta.go `Addition` (including embedded driver.RootPath) */
export interface GithubReleasesAddition {
  /** embedded driver.RootPath in Go — sub path inside this virtual tree */
  root_folder_path?: string
  /**
   * Go: RepoStructure `json:"repo_structure"` — one repo per line,
   * format "[path:]org/repo" (path defaults to "/")
   */
  repo_structure: string
  /** Go: ShowReadme `json:"show_readme"` — show README / LICENSE files */
  show_readme?: boolean
  /** Go: Token `json:"token"` — GitHub token (private repos / rate limit) */
  token?: string
  /** Go: ShowSourceCode `json:"show_source_code"` — show Source code (zip/tar.gz) */
  show_source_code?: boolean
  /** Go: ShowAllVersion `json:"show_all_version"` — tag dirs per release */
  show_all_version?: boolean
  /** Go: PerPage `json:"per_page"` — releases per page, 1..100 */
  per_page?: number
  /** Go: MaxPage `json:"max_page"` — max pages to fetch (0 = unlimited) */
  max_page?: number
  /** Go: GitHubProxy `json:"gh_proxy"` — prefix replacing https://github.com */
  gh_proxy?: string
}

/** Go MountPoint — a repo mounted at a virtual path */
export interface MountPoint {
  /** mount path, "/" or "/xxx" */
  point: string
  /** repo name "owner/repo" */
  repo: string
}

/** Go Asset — subset of the fields used by this driver */
export interface Asset {
  name: string
  size: number
  created_at?: string | null
  updated_at?: string | null
  browser_download_url?: string
}

/** Go Release — subset of the fields used by this driver */
export interface Release {
  tag_name: string
  name?: string
  draft?: boolean
  prerelease?: boolean
  created_at?: string | null
  published_at?: string | null
  assets?: Asset[]
  html_url?: string
  tarball_url?: string
  zipball_url?: string
}

/** Go FileInfo — entry of GET /repos/{owner}/{repo}/contents */
export interface FileInfo {
  name: string
  path?: string
  sha?: string
  size?: number
  download_url?: string | null
  type?: string
}

/**
 * Go File — the driver's virtual file/dir object. Note Go's ModTime()
 * implementation parses CreateAt (sic), so `createAt` is the displayed
 * modified time.
 */
export interface GhReleaseFile {
  path: string
  fileName: string
  size: number
  type: "dir" | "file"
  updateAt: string
  createAt: string
  url: string
}
