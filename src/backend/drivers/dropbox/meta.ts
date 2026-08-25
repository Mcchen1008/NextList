// Dropbox driver config (admin frontend form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/dropbox
//
// `additional` fields mirror Go meta.go Addition json tags:
//   driver.RootPath → root_folder_path (Config().DefaultRoot is "" → empty
//     default, not required),
//   UseOnlineAPI → use_online_api, APIAddress → api_url_address,
//   ClientID → client_id, ClientSecret → client_secret,
//   RefreshToken → refresh_token, RootNamespaceId → RootNamespaceId
//     (exact Go json tag, capital R and N).
//   Go's untagged `AccessToken` field is hidden from the form (internal,
//   auto-refreshed); the TS addition persists it as access_token.

export const dropboxDriverConfig = {
  name: "Dropbox",
  default_mount_path: "/dropbox",
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
      default: "",
      required: false,
      help: "Dropbox path to mount, e.g. /backup; empty means the Dropbox root",
    },
    {
      name: "use_online_api",
      type: "bool",
      default: "false",
      required: false,
      help: "Refresh tokens via the online API relay instead of client_id/client_secret",
    },
    {
      name: "api_url_address",
      type: "string",
      default: "https://api.oplist.org/dropboxs/renewapi",
      required: false,
      help: "Online API relay used when use_online_api is enabled",
    },
    {
      name: "client_id",
      type: "string",
      default: "",
      required: false,
      help: "Keep it empty if you don't have one",
    },
    {
      name: "client_secret",
      type: "string",
      default: "",
      required: false,
      help: "Keep it empty if you don't have one",
    },
    {
      name: "refresh_token",
      type: "text",
      default: "",
      required: true,
      help: "true",
    },
    {
      name: "RootNamespaceId",
      type: "string",
      default: "",
      required: false,
      help: "Auto-detected on init; only relevant for team accounts",
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
      name: "order_direction",
      type: "select",
      options: "asc,desc",
      default: "asc",
      required: false,
      help: "",
    },
  ],
  config: {
    name: "Dropbox",
    local_sort: false, // Go Config().LocalSort is false
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // upload-session put() is ported
    need_ms: false,
    default_root: "", // Go Config().DefaultRoot is empty
    // (Go NoOverwriteUpload = true: uploads commit with mode "add" +
    //  autorename, never overwriting; no counterpart in this config shape)
  },
}
