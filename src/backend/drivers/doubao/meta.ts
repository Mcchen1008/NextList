// Doubao (豆包网盘, ByteDance) driver form config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/doubao/meta.go

export const doubaoDriverConfig = {
  name: "Doubao",
  default_mount_path: "/doubao",
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
    // mirrors Go meta.go Addition (embedded driver.RootID + json tags)
    {
      name: "root_folder_id",
      type: "string",
      default: "0", // Go Config().DefaultRoot = "0"
      required: false,
      help: "",
    },
    {
      name: "cookie",
      type: "text",
      default: "",
      required: true,
      help: "",
    },
    {
      name: "upload_thread",
      type: "string",
      default: "3",
      required: false,
      help: "",
    },
    {
      name: "download_api",
      type: "select",
      options: "get_file_url,get_download_info",
      default: "get_file_url",
      required: false,
      help: "",
    },
    {
      name: "limit_rate",
      type: "number",
      default: "2",
      required: false,
      help: "limit all api request rate ([limit]r/1s)",
    },
  ],
  config: {
    name: "Doubao",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // Go implements upload; NextList put() throws (see driver.ts)
    need_ms: false,
    default_root: "0", // Go Config().DefaultRoot
  },
}
