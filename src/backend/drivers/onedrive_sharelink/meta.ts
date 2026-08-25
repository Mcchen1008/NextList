// OnedriveSharelink driver config (admin frontend form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/onedrive_sharelink
//
// `additional` fields mirror Go meta.go Addition json tags:
//   driver.RootPath → root_folder_path (Config().DefaultRoot is "/"),
//   ShareLinkURL → url, ShareLinkPassword → password,
//   DisableDiskUsage → disable_disk_usage, EnableDirectUpload →
//   enable_direct_upload (direct upload is not ported — no-op field).
// Go's untagged internal fields (IsSharepoint, Headers, DriveURL,
// DriveAccessToken, ...) are runtime state, not form fields.

export const onedriveSharelinkDriverConfig = {
  name: "OnedriveSharelink",
  default_mount_path: "/onedrive_sharelink",
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
      default: "/",
      required: false,
      help: "Path inside the share to mount; empty or / mounts the share root",
    },
    {
      name: "url",
      type: "string",
      default: "",
      required: true,
      help: "OneDrive/SharePoint share link URL",
    },
    {
      name: "password",
      type: "string",
      default: "",
      required: false,
      help: "Share link password (leave empty for public links)",
    },
    {
      name: "disable_disk_usage",
      type: "bool",
      default: "false",
      required: false,
      help: "",
    },
    {
      name: "enable_direct_upload",
      type: "bool",
      default: "false",
      required: false,
      help: "Allow uploading directly to OneDrive without going through OpenList",
    },
  ],
  config: {
    name: "OnedriveSharelink",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // writes are rejected by the driver itself (read-only)
    need_ms: false,
    default_root: "/", // Go Config().DefaultRoot
  },
}
