// PikPak driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/pikpak

export const pikpakDriverConfig = {
  name: "PikPak",
  default_mount_path: "/pikpak",
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
    { name: "username", type: "string", default: "", required: true },
    { name: "password", type: "string", default: "", required: true },
    {
      name: "platform",
      type: "select",
      options: "android,web,pc",
      default: "web",
      required: true,
    },
    { name: "refresh_token", type: "text", default: "", required: true },
    { name: "captcha_token", type: "text", default: "", required: false },
    { name: "device_id", type: "string", default: "", required: false },
    {
      name: "disable_media_link",
      type: "bool",
      default: "true",
      required: false,
    },
    { name: "root_id", type: "string", default: "", required: false },
    {
      name: "order_by",
      type: "select",
      options: "name,size,created,updated",
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
  ],
  config: {
    name: "PikPak",
    local_sort: true,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: "",
  },
}
