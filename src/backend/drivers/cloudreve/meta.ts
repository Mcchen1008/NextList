// Cloudreve driver form config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudreve/meta.go
//
// `additional` fields mirror the Go Addition struct (json tags preserved):
// driver.RootPath → root_folder_path, Address → address, Username → username,
// Password → password, Cookie → cookie, CustomUA → custom_ua,
// EnableThumbAndFolderSize → enable_thumb_and_folder_size.

export const cloudreveDriverConfig = {
  name: "Cloudreve",
  default_mount_path: "/cloudreve",
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
      help: "Root path on the Cloudreve site (Go Config().DefaultRoot)",
    },
    {
      name: "address",
      type: "string",
      default: "",
      required: true,
      help: "Address of the Cloudreve site, e.g. https://cloudreve.example.com",
    },
    {
      name: "username",
      type: "string",
      default: "",
      required: false,
      help: "Login username (used to refresh the session cookie)",
    },
    {
      name: "password",
      type: "string",
      default: "",
      required: false,
      help: "Login password (used to refresh the session cookie)",
    },
    {
      name: "cookie",
      type: "text",
      default: "",
      required: false,
      help: "cloudreve-session cookie value; auto-refreshed via login when username/password are set",
    },
    {
      name: "custom_ua",
      type: "string",
      default: "",
      required: false,
      help: "Custom User-Agent for requests to the Cloudreve site",
    },
    {
      name: "enable_thumb_and_folder_size",
      type: "bool",
      default: "false",
      required: false,
      help: "Fetch thumbnails (via redirect probe) and folder sizes (extra requests per listing)",
    },
  ],
  config: {
    name: "Cloudreve",
    local_sort: true, // Go Config().LocalSort
    only_local: false, // OnlyLocal
    only_proxy: false, // OnlyProxy
    no_cache: false, // NoCacheURL
    no_upload: false, // NoUpload — full upload pipeline ported
    need_ms: false, // NeedMs
    default_root: "/", // Go Config().DefaultRoot
  },
}
