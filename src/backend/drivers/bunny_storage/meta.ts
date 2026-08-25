// Bunny Storage (Bunny.net Storage Zone) driver config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/bunny_storage/meta.go

export const bunnyStorageDriverConfig = {
  // Go Config().Name is "Bunny Storage"; single-token name per NextList
  // driver naming conventions (matches cnb_releases handling).
  name: "BunnyStorage",
  default_mount_path: "/bunny",
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
    // mirrors Go meta.go Addition (incl. embedded driver.RootPath)
    {
      name: "root_folder_path",
      type: "string",
      default: "/",
      required: false,
      help: 'Path inside the storage zone to mount, e.g. /backup; "/" is the zone root',
    },
    {
      name: "storage_zone_name",
      type: "string",
      default: "",
      required: true,
      help: "Bunny.net storage zone name",
    },
    {
      name: "access_key",
      type: "string",
      default: "",
      required: true,
      help: "true",
    },
    {
      name: "endpoint",
      type: "string",
      default: "storage.bunnycdn.com",
      required: true,
      help: "Storage endpoint host, e.g. storage.bunnycdn.com or ny.storage.bunnycdn.com",
    },
    {
      name: "cdn_base_url",
      type: "string",
      default: "",
      required: false,
      help: "Optional pull-zone CDN URL; when empty, downloads are proxied with the AccessKey header",
    },
    {
      name: "cdn_token_key",
      type: "string",
      default: "",
      required: false,
      help: "CDN token authentication key (leave empty to disable URL signing)",
    },
    {
      name: "cdn_token_method",
      type: "select",
      options: "sha256,hmac_sha256",
      default: "sha256",
      required: false,
      help: "",
    },
    {
      name: "cdn_token_include_ip",
      type: "bool",
      default: "false",
      required: false,
      help: "Include the client IP in the CDN token (not fully supported: NextList drivers cannot see the downloader IP)",
    },
    {
      name: "sign_url_expire",
      type: "number",
      default: "4",
      required: false,
      help: "CDN token lifetime in hours",
    },
    {
      name: "placeholder",
      type: "string",
      default: ".openlist",
      required: false,
      help: "Placeholder object name used to emulate empty folders",
    },
    {
      name: "order_by",
      type: "select",
      options: "name,size,modified",
      default: "name",
      required: false,
      help: "",
    },
    {
      name: "order_desc",
      type: "bool",
      default: "false",
      required: false,
      help: "",
    },
  ],
  config: {
    name: "BunnyStorage",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false, // Go flips OnlyProxy dynamically when no cdn_base_url is set
    no_cache: false,
    no_upload: false, // put() is a plain PUT — fully ported
    need_ms: false,
    default_root: "/", // Go Config().DefaultRoot
  },
}
