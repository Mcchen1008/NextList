// OnedriveSharelink driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/onedrive_sharelink

/** Go meta.go Addition (incl. embedded driver.RootPath) */
export interface OnedriveSharelinkAddition {
  /** driver.RootPath — path inside the share used as the mount root */
  root_folder_path?: string
  /** ShareLinkURL (json: url) — the OneDrive/SharePoint share link */
  url: string
  /** ShareLinkPassword (json: password) — empty for public links */
  password?: string
  /** DisableDiskUsage (json: disable_disk_usage) — disk usage queries not ported */
  disable_disk_usage?: boolean
  /**
   * EnableDirectUpload (json: enable_direct_upload) — Go exposes an
   * "HttpDirect" upload tool; direct upload is not ported (read-only driver),
   * so this field is a no-op kept for config compatibility.
   */
  enable_direct_upload?: boolean
}

/**
 * Go types.go Item — one row of the SharePoint renderListDataAsStream result.
 * Field names are the quirky server-side column names.
 */
export interface SPListItem {
  /** FSObjType: "1" = folder, "0" = file */
  FSObjType?: string
  /** FileLeafRef: display name */
  FileLeafRef?: string
  /** "Modified." — last modified time */
  "Modified."?: string
  /** File_x0020_Size — size in bytes (string) */
  File_x0020_Size?: string
  /** UniqueId — unique id, wrapped in braces like "{GUID}" */
  UniqueId?: string
  /** ".spItemUrl" — SharePoint item metadata API URL */
  ".spItemUrl"?: string
  /** "@content.downloadUrl" — temporary cookie-free download URL */
  "@content.downloadUrl"?: string
}

/** Go types.go GraphQLRequest */
export interface GraphQLResp {
  data?: {
    legacy?: {
      renderListDataAsStream?: {
        ListData?: {
          NextHref?: string
          Row?: SPListItem[]
        }
        ViewMetadata?: {
          ListViewXml?: string
        }
      }
    }
  }
}

/** Go types.go GraphQLNEWRequest — RenderListDataAsStream pagination response */
export interface RenderListDataResp {
  ListData?: {
    NextHref?: string
    Row?: SPListItem[]
  }
}

/** Go types.go pageContextInfo — _spPageContextInfo JSON embedded in the share page */
export interface PageContextInfo {
  listUrl?: string
  driveInfo?: {
    ".driveUrl"?: string
    ".driveAccessToken"?: string
    ".driveAccessTokenV21"?: string
  }
}

/** Graph-style children listing used for folder sizes (Go driveChildrenFolderSizes) */
export interface DriveChildrenResp {
  value?: Array<{
    name?: string
    size?: number
    folder?: unknown
  }>
  "@odata.nextLink"?: string
}

/** Normalized header map used across the client */
export type HeaderMap = Record<string, string>
