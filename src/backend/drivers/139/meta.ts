// 139 云盘 (和彩云) driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/139

export const cloud139DriverConfig = {
  name: "139Cloud",
  default_mount_path: "/139",
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
    { name: "authorization", type: "text", default: "", required: true },
    { name: "username", type: "string", default: "", required: true },
    { name: "password", type: "string", default: "", required: true },
    {
      name: "mail_cookies",
      type: "text",
      default: "",
      required: true,
      help: "Cookies from mail.139.com used for login authentication.",
    },
    { name: "root_id", type: "string", default: "", required: false },
    {
      name: "type",
      type: "select",
      options: "personal_new,family,group,personal,share",
      default: "personal_new",
      required: false,
    },
  ],
  config: {
    name: "139Cloud",
    local_sort: true,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true,
    need_ms: false,
    default_root: "",
  },
}
