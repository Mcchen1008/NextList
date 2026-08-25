// AList V3 driver config (admin frontend form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/alist_v3
// Also compatible with OpenList servers (same API).
//
// `additional` fields mirror Go meta.go `Addition` (json tags preserved):
//   Address → url, MetaPassword → meta_password, Username → username,
//   Password → password, Token → token, PassIPToUpsteam → pass_ip_to_upsteam,
//   PassUAToUpsteam → pass_ua_to_upsteam, ForwardArchiveReq → forward_archive_requests,
//   driver.RootPath → root_folder_path

export interface DriverConfigField {
  name: string
  type: "string" | "text" | "number" | "bool" | "select"
  default: string
  required: boolean
  help?: string
  options?: string
}

export const alistV3DriverConfig = {
  name: "AListV3",
  default_mount_path: "/alist",
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
      name: "url",
      type: "string",
      default: "",
      required: true,
      help: "Address of the remote AList/OpenList server, e.g. https://pan.example.com",
    },
    {
      name: "root_folder_path",
      type: "string",
      default: "/",
      required: false,
      help: "Root path on the remote server",
    },
    {
      name: "meta_password",
      type: "string",
      default: "",
      required: false,
      help: "Password for accessing password-protected remote directories",
    },
    {
      name: "username",
      type: "string",
      default: "",
      required: false,
      help: "Leave empty for guest access",
    },
    {
      name: "password",
      type: "string",
      default: "",
      required: false,
      help: "Login password, used to refresh the token automatically",
    },
    {
      name: "token",
      type: "text",
      default: "",
      required: false,
      help: "Access token; auto-refreshed via /api/auth/login when username is set",
    },
    {
      name: "pass_ip_to_upsteam",
      type: "bool",
      default: "true",
      required: false,
      help: "Pass visitor IP to the upstream server (X-Forwarded-For / X-Real-Ip)",
    },
    {
      name: "pass_ua_to_upsteam",
      type: "bool",
      default: "true",
      required: false,
      help: "Pass visitor User-Agent to the upstream server",
    },
    {
      name: "forward_archive_requests",
      type: "bool",
      default: "true",
      required: false,
      help: "Forward archive requests to the upstream server (archive features are not ported in NextList)",
    },
    {
      name: "order_by",
      type: "select",
      options: "name,size,modified,created",
      default: "name",
      required: false,
      help: "Sort files locally by this field (Go Config().LocalSort)",
    },
    {
      name: "order_direction",
      type: "select",
      options: "asc,desc",
      default: "asc",
      required: false,
      help: "",
    },
  ] as DriverConfigField[],
  config: {
    name: "AListV3",
    local_sort: true, // Go Config().LocalSort
    only_local: false, // OnlyLocal
    only_proxy: false, // OnlyProxy
    no_cache: false, // NoCacheURL
    no_upload: false, // NoUpload — /api/fs/put upload is supported
    need_ms: false, // NeedMs
    default_root: "/", // Go Config().DefaultRoot
  },
}
