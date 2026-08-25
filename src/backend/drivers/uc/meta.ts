// UC 网盘 driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/quark_uc (UC variant)

export const ucDriverConfig = {
  name: "UC",
  default_mount_path: "/uc",
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
    { name: "root_id", type: "string", default: "0", required: false },
    {
      name: "order_by",
      type: "select",
      options: "none,file_type,file_name,updated_at",
      default: "none",
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
      name: "use_transcoding_address",
      type: "bool",
      default: "false",
      required: true,
      help: "You can watch the transcoded video and support 302 redirection",
    },
    {
      name: "only_list_video_file",
      type: "bool",
      default: "false",
      required: false,
    },
  ],
  config: {
    name: "UC",
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true,
    need_ms: false,
    default_root: "0",
  },
}
