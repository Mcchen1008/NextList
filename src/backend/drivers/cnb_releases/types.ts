// CNB Releases driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cnb_releases
//
// The unused Tag/TagList/Commit* types from Go types.go are not ported —
// the driver never references them.

export interface CnbReleasesAddition {
  /**
   * Go driver.RootID (json: root_folder_id): mount a single release at the
   * storage root — when set, the root directory lists that release's assets
   * instead of all releases.
   */
  root_folder_id?: string
  /**
   * Not part of the Go Addition (which embeds RootID, not RootPath), but
   * NextList's resolvePath() reads it from the addition JSON — kept so a
   * manually-set root prefix can be stripped from physical paths.
   */
  root_folder_path?: string
  /** repo path, e.g. "group/repo" */
  repo: string
  /** CNB access token (Bearer) */
  token: string
  /** display releases by tag name instead of release name */
  use_tag_name?: boolean
  /** Go: default branch for new releases (release creation not ported) */
  default_branch?: string
}

export interface CnbUserInfo {
  freeze?: boolean
  nickname?: string
  username?: string
}

export interface CnbRelease {
  assets?: CnbReleaseAsset[]
  author?: CnbUserInfo
  body?: string
  /** RFC3339 */
  created_at?: string
  draft?: boolean
  id: string
  is_latest?: boolean
  name?: string
  prerelease?: boolean
  /** RFC3339 */
  published_at?: string
  tag_commitish?: string
  tag_name?: string
  /** RFC3339 */
  updated_at?: string
}

export interface CnbReleaseAsset {
  content_type?: string
  /** RFC3339 */
  created_at?: string
  id: string
  name: string
  /** download path on cnb.cool, e.g. /{repo}/-/releases/assets/... */
  path?: string
  size?: number
  /** RFC3339 */
  updated_at?: string
  uploader?: CnbUserInfo
}

/** Response of POST /{repo}/-/releases/{release_id}/asset-upload-url (upload not ported) */
export interface CnbReleaseAssetUploadURL {
  upload_url: string
  expires_in_sec: number
  verify_url: string
}
