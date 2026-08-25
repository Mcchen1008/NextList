// MediaFire driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mediafire

export const mediafireDriverConfig = {
  name: "MediaFire",
  default_mount_path: "/mediafire",
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
      name: "session_token",
      type: "string",
      default: "",
      required: false,
      help: "Optional for MediaFire API, can be auto-acquired from cookie",
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
    { name: "chunk_size", type: "number", default: "100", required: false },
    {
      name: "root_folder_path",
      type: "string",
      default: "/",
      required: true,
    },
  ],
  config: {
    name: "MediaFire",
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true,
    need_ms: false,
    default_root: "/",
  },
}
