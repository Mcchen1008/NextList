// Terabox driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/terabox

export const teraboxDriverConfig = {
  name: "Terabox",
  default_mount_path: "/terabox",
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
    { name: "cookie", type: "text", default: "", required: true },
    {
      name: "download_api",
      type: "select",
      options: "official,crack",
      default: "official",
      required: false,
    },
    {
      name: "order_by",
      type: "select",
      options: "name,time,size",
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
  ],
  config: {
    name: "Terabox",
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true,
    need_ms: false,
    default_root: "/",
  },
}
