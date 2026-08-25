// Teambition driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/teambition

export const teambitionDriverConfig = {
  name: "Teambition",
  default_mount_path: "/teambition",
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
      name: "region",
      type: "select",
      options: "china,international",
      default: "china",
      required: true,
    },
    { name: "cookie", type: "text", default: "", required: true },
    { name: "project_id", type: "string", default: "", required: true },
    { name: "root_id", type: "string", default: "", required: false },
    {
      name: "order_by",
      type: "select",
      options: "fileName,fileSize,updated,created",
      default: "fileName",
      required: false,
    },
    {
      name: "order_direction",
      type: "select",
      options: "Asc,Desc",
      default: "Asc",
      required: false,
    },
    {
      name: "use_s3_upload_method",
      type: "bool",
      default: "true",
      required: false,
    },
  ],
  config: {
    name: "Teambition",
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: "",
  },
}
