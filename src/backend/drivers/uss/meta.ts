// USS (又拍云) driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/uss

export const ussDriverConfig = {
  name: "USS",
  default_mount_path: "/uss",
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
    { name: "bucket", type: "string", default: "", required: true },
    {
      name: "endpoint",
      type: "string",
      default: "",
      required: true,
      help: "e.g. v0.api.upyun.com",
    },
    { name: "operator_name", type: "string", default: "", required: true },
    { name: "operator_password", type: "string", default: "", required: true },
    {
      name: "anti_theft_chain_token",
      type: "string",
      default: "",
      required: false,
      help: "Anti-leech token (防盗链密钥), empty to disable signed URLs",
    },
    {
      name: "sign_url_expire",
      type: "number",
      default: "4",
      required: false,
      help: "Signed URL expiration in hours",
    },
    {
      name: "root_folder_path",
      type: "string",
      default: "/",
      required: true,
    },
    {
      name: "order_by",
      type: "select",
      options: "name,size,time",
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
    name: "USS",
    local_sort: true,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: "/",
  },
}
