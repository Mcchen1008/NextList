// Cloudreve V4 driver form config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudreve_v4/meta.go
//
// `additional` fields mirror the Go Addition struct (json tags preserved):
// driver.RootPath → root_folder_path, Address → address, Username → username,
// Password → password, AccessToken → access_token, RefreshToken → refresh_token,
// CustomUA → custom_ua, EnableFolderSize → enable_folder_size,
// EnableThumb → enable_thumb, EnableVersionUpload → enable_version_upload,
// HideUploading → hide_uploading, OrderBy → order_by, OrderDirection → order_direction.

export const cloudreveV4DriverConfig = {
  // Go Config().Name is "Cloudreve V4"; single-token name per NextList
  // driver naming convention (see cnb_releases precedent)
  name: "CloudreveV4",
  default_mount_path: "/cloudreve_v4",
  common: [
    {
      name: "mount_path",
      type: "string",
      default: "",
      required: true,
      help: "1",
    },
    { name: "order", type: "number", default: "0", required: false, help: "" },
    { name: "remark", type: "string", default: "", required: false, help: "" },
  ],
  additional: [
    {
      name: "root_folder_path",
      type: "string",
      default: "cloudreve://my",
      required: false,
      help: "Root URI on the Cloudreve v4 site (Go Config().DefaultRoot); a path ending with @share mounts an anonymous share",
    },
    {
      name: "address",
      type: "string",
      default: "",
      required: true,
      help: "Address of the Cloudreve v4 site, e.g. https://cloudreve.example.com",
    },
    {
      name: "username",
      type: "string",
      default: "",
      required: false,
      help: "Login email (used to obtain/refresh tokens)",
    },
    {
      name: "password",
      type: "string",
      default: "",
      required: false,
      help: "Login password (used to obtain/refresh tokens)",
    },
    {
      name: "access_token",
      type: "text",
      default: "",
      required: false,
      help: "Bearer access token (JWT); auto-refreshed via refresh_token or login",
    },
    {
      name: "refresh_token",
      type: "text",
      default: "",
      required: false,
      help: "Refresh token; auto-rotated on access-token refresh",
    },
    {
      name: "custom_ua",
      type: "string",
      default: "",
      required: false,
      help: "Custom User-Agent for requests to the Cloudreve site",
    },
    {
      name: "enable_folder_size",
      type: "bool",
      default: "false",
      required: false,
      help: "Fetch folder sizes via folder summaries (extra request per folder)",
    },
    {
      name: "enable_thumb",
      type: "bool",
      default: "false",
      required: false,
      help: "Fetch file thumbnails (extra request per file)",
    },
    {
      name: "enable_version_upload",
      type: "bool",
      default: "false",
      required: false,
      help: "Upload new versions instead of overwriting (disables Go NoOverwriteUpload)",
    },
    {
      name: "hide_uploading",
      type: "bool",
      default: "false",
      required: false,
      help: "Hide entries of unfinished upload sessions",
    },
    {
      name: "order_by",
      type: "select",
      options: "name,size,updated_at,created_at",
      default: "name",
      required: true,
      help: "Server-side sort field",
    },
    {
      name: "order_direction",
      type: "select",
      options: "asc,desc",
      default: "asc",
      required: true,
      help: "Server-side sort direction",
    },
  ],
  config: {
    name: "CloudreveV4",
    local_sort: false, // Go Config().LocalSort — ordering done server-side
    only_local: false, // OnlyLocal
    only_proxy: false, // OnlyProxy
    no_cache: false, // NoCacheURL
    no_upload: false, // NoUpload — full upload pipeline ported
    need_ms: false, // NeedMs
    default_root: "cloudreve://my", // Go Config().DefaultRoot
    // Go Config().NoOverwriteUpload = true (disabled when enable_version_upload
    // is set); NextList has no counterpart field in this config shape
  },
}
