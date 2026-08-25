// GitHub Releases driver
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/github_releases
//
// Lists release assets of GitHub repositories as a virtual tree. The
// repo_structure config holds one repo per line ("[path:]org/repo"); repos can
// be nested under arbitrary virtual paths, parent dirs aggregate the sizes of
// their repos' releases.
//   latest mode (show_all_version = false, default):
//     /                 → aggregate dir per repo mount point
//     /<mount point>    → latest release assets (+ README/LICENSE, source code)
//   all versions mode (show_all_version = true):
//     /<mount point>    → one dir per release tag (+ README/LICENSE)
//     /<mount point>/<tag> → that release's assets (+ source code)
// Downloads use the browser_download_url
// (github.com/{owner}/{repo}/releases/download/{tag}/{file}), optionally
// rewritten through gh_proxy.
// Read-only: the Go driver returns errs.NotImplement for all write methods
// and sets NoUpload.
import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import {
  GithubReleasesAddition,
  GhReleaseFile,
  MountPoint,
  Release,
} from "./types"
import {
  GithubReleasesClient,
  getNextDir,
  joinPath,
  otherFiles,
  parseRepos,
  releaseAssetsByTag,
  releaseSize,
  releaseToFiles,
  releasesToVersionDirs,
  releasesTotalSize,
  sourceCodeFiles,
  sourceCodeFilesByTag,
  toIsoTime,
} from "./util"

const GITHUB_ORIGIN = "https://github.com"

export class GithubReleasesDriver implements StorageDriver {
  private addition: GithubReleasesAddition
  private client: GithubReleasesClient
  private points: MountPoint[] = []

  constructor(addition: GithubReleasesAddition) {
    this.addition = addition
    this.client = new GithubReleasesClient(addition)
  }

  /** Go Init(): ParseRepos(repo_structure). Malformed lines error here so a
   *  bad config surfaces at save time (Go silently ignored the error). */
  async init(): Promise<void> {
    this.points = parseRepos(this.addition.repo_structure || "")
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    // Go: path := fmt.Sprintf("/%s", strings.Trim(dir.GetPath(), "/"))
    const path = "/" + (physicalPath || "").split("/").filter(Boolean).join("/")
    const files: GhReleaseFile[] = []

    for (const point of this.points) {
      if (!this.addition.show_all_version) {
        // latest version mode
        let release: Release | null = null
        try {
          release = await this.client.getLatestRelease(point.repo)
        } catch (e: any) {
          console.warn(
            `[GitHubReleases] failed to request release for ${point.repo}: ${e.message}`,
          )
          continue
        }
        if (!release) continue

        if (point.point === path) {
          // 当前目录就是仓库挂载点
          files.push(...releaseToFiles(point.point, release))
          if (this.addition.show_readme) {
            await this.appendRepoFiles(point, files)
          }
          if (this.addition.show_source_code) {
            files.push(...sourceCodeFiles(point.point, release))
          }
        } else if (point.point.startsWith(path)) {
          // 仓库目录的父目录，需要聚合显示
          const nextDir = getNextDir(point.point, path)
          if (!nextDir) continue
          this.aggregateDir(files, path, nextDir, releaseSize(release), release)
        }
      } else {
        // all versions mode
        let releases: Release[] = []
        try {
          releases = await this.client.getAllReleases(point.repo)
        } catch (e: any) {
          console.warn(
            `[GitHubReleases] failed to request releases for ${point.repo}: ${e.message}`,
          )
          continue
        }
        if (releases.length === 0) {
          // no releases but may still have repo files (e.g. README)
          if (point.point === path && this.addition.show_readme) {
            await this.appendRepoFiles(point, files)
          }
          continue
        }

        if (point.point === path) {
          // 当前目录就是仓库挂载点
          files.push(...releasesToVersionDirs(point.point, releases))
          if (this.addition.show_readme) {
            await this.appendRepoFiles(point, files)
          }
        } else if (point.point.startsWith(path)) {
          // 仓库目录的父目录
          const nextDir = getNextDir(point.point, path)
          if (!nextDir) continue
          this.aggregateDir(
            files,
            path,
            nextDir,
            releasesTotalSize(releases),
            releases[0],
          )
        } else if (path.startsWith(point.point)) {
          // 仓库目录的子目录（某个版本）
          const tagName = getNextDir(path, point.point)
          if (!tagName) continue
          files.push(...releaseAssetsByTag(point.point, tagName, releases))
          if (this.addition.show_source_code) {
            files.push(...sourceCodeFilesByTag(point.point, releases, tagName))
          }
        }
      }
    }

    // Go Config().LocalSort is unset (false): results keep insertion order
    return files.map((f) => this.fileToFileItem(f))
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const path = "/" + (physicalPath || "").split("/").filter(Boolean).join("/")
    const parts = path.split("/").filter(Boolean)
    if (parts.length === 0) {
      // storage root
      return {
        name: "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    }
    // The Go driver implements no Getter, so OpenList falls back to listing
    // the parent directory and matching the entry by name.
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const siblings = await this.list(_virtualPath, parentPath)
    const found = siblings.find((f) => f.name === name)
    if (!found) {
      throw new Error(`[GitHubReleases] failed to get obj: ${path} not found`)
    }
    return found
  }

  async mkdir(): Promise<void> {
    // Go MakeDir: errs.NotImplement
    throw new Error("[GitHubReleases] read-only driver")
  }

  async rename(): Promise<void> {
    // Go Rename: errs.NotImplement
    throw new Error("[GitHubReleases] read-only driver")
  }

  async remove(): Promise<void> {
    // Go Remove: errs.NotImplement
    throw new Error("[GitHubReleases] read-only driver")
  }

  async move(): Promise<void> {
    // Go Move: errs.NotImplement
    throw new Error("[GitHubReleases] read-only driver")
  }

  async copy(): Promise<void> {
    // Go Copy: errs.NotImplement
    throw new Error("[GitHubReleases] read-only driver")
  }

  async put(): Promise<void> {
    // Go Config(): NoUpload = true
    throw new Error("[GitHubReleases] read-only driver")
  }

  // -----------------------------------------------------------------------
  // helpers
  // -----------------------------------------------------------------------

  /** fetchRepoFiles + otherFiles, warning on failure (Go List does the same) */
  private async appendRepoFiles(
    point: MountPoint,
    files: GhReleaseFile[],
  ): Promise<void> {
    try {
      const other = await this.client.fetchRepoFiles(point.repo)
      files.push(...otherFiles(point.point, other))
    } catch (e: any) {
      console.warn(
        `[GitHubReleases] failed to get other files for ${point.repo}: ${e.message}`,
      )
    }
  }

  /** parent-dir aggregation: create or grow the aggregated repo dir */
  private aggregateDir(
    files: GhReleaseFile[],
    path: string,
    nextDir: string,
    size: number,
    release: { published_at?: string | null; created_at?: string | null },
  ): void {
    const existing = files.find((f) => f.fileName === nextDir)
    if (existing) {
      existing.size += size
      return
    }
    files.push({
      path: joinPath(path, nextDir),
      fileName: nextDir,
      size,
      type: "dir",
      updateAt: release.published_at || "",
      createAt: release.created_at || "",
      url: "",
    })
  }

  /**
   * Go Link(): url = file.GetID() (= the download url); when gh_proxy is set,
   * "https://github.com" is replaced with it (first occurrence only).
   */
  private formatDownloadUrl(url: string): string {
    if (!url) return ""
    const ghProxy = (this.addition.gh_proxy || "").trim()
    if (ghProxy && url.startsWith(GITHUB_ORIGIN)) {
      return ghProxy + url.slice(GITHUB_ORIGIN.length)
    }
    return url
  }

  private fileToFileItem(f: GhReleaseFile): FileItem {
    const isDir = f.type === "dir"
    return {
      name: f.fileName,
      size: f.size,
      is_dir: isDir,
      // Go File.ModTime() parses CreateAt (sic) — kept for parity
      modified: toIsoTime(f.createAt),
      created: toIsoTime(f.createAt),
      sign: "",
      type: calcFileType(f.fileName, isDir),
      raw_url: isDir ? "" : this.formatDownloadUrl(f.url),
    }
  }
}
