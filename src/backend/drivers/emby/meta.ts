// Emby driver form config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/emby/meta.go

export const embyDriverConfig = {
  name: "Emby",
  default_mount_path: "/emby",
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
      name: "root_folder_id",
      type: "string",
      default: "1",
      required: false,
      help: "true",
    },
    {
      name: "url",
      type: "string",
      default: "",
      required: true,
      help: "e.g. http://127.0.0.1:8096",
    },
    {
      name: "api_key",
      type: "string",
      default: "",
      required: false,
      help: "true",
    },
    { name: "user_id", type: "string", default: "", required: false },
    { name: "username", type: "string", default: "", required: false },
    { name: "password", type: "string", default: "", required: false },
    {
      name: "link_method",
      type: "select",
      options: "stream,download",
      default: "stream",
      required: false,
    },
  ],
  config: {
    name: "Emby",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // Go Config().NoUpload
    need_ms: false,
    default_root: "1", // Go Config().DefaultRoot
  },
}
