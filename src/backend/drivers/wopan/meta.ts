// WoPan (联通云盘) driver form config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/wopan/meta.go

export const wopanDriverConfig = {
  name: "WoPan",
  default_mount_path: "/wopan",
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
      default: "0",
      required: false,
      help: "true",
    },
    {
      name: "refresh_token",
      type: "string",
      default: "",
      required: true,
      help: "true",
    },
    {
      name: "family_id",
      type: "string",
      default: "",
      required: false,
      help: "Keep it empty if you want to use your personal drive",
    },
    {
      name: "sort_rule",
      type: "select",
      options: "name_asc,name_desc,time_asc,time_desc,size_asc,size_desc",
      default: "name_asc",
      required: false,
    },
    {
      name: "access_token",
      type: "string",
      default: "",
      required: false,
      help: "true",
    },
  ],
  config: {
    name: "WoPan",
    local_sort: false, // server-side sorting via sort_rule
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: "0", // Go Config().DefaultRoot
    // (Go NoOverwriteUpload has no counterpart in this config shape)
  },
}
