// YandexDisk driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/yandex_disk

export const yandexDiskDriverConfig = {
  name: "YandexDisk",
  default_mount_path: "/yandex-disk",
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
    { name: "refresh_token", type: "text", default: "", required: true },
    {
      name: "order_by",
      type: "select",
      options: "name,path,created,modified,size",
      default: "name",
      required: false,
    },
    {
      name: "order_direction",
      type: "select",
      options: "asc,desc",
      default: "asc",
      required: false,
    },
    {
      name: "root_folder_path",
      type: "string",
      default: "/",
      required: true,
    },
    { name: "use_online_api", type: "bool", default: "true", required: false },
    {
      name: "api_url_address",
      type: "string",
      default: "https://api.oplist.org/yandexui/renewapi",
      required: false,
      help: "true",
    },
    { name: "client_id", type: "string", default: "", required: false },
    { name: "client_secret", type: "string", default: "", required: false },
  ],
  config: {
    name: "YandexDisk",
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: "/",
  },
}
