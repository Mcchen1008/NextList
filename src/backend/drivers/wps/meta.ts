// WPS driver config (admin frontend form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/wps/meta.go
//
// `additional` mirrors Go meta.go Addition (json tags preserved):
//   driver.RootPath → root_folder_path, Cookie → cookie, Mode → mode
//   (select Personal/Business, default Personal), CustomUA → custom_ua.

export const wpsDriverConfig = {
  name: "WPS",
  default_mount_path: "/wps",
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
      name: "root_folder_path",
      type: "string",
      default: "/", // Go Config().DefaultRoot = "/"
      required: false,
      help: "Root path, e.g. /<group name>/subfolder (first segment must be a group name)",
    },
    {
      name: "cookie",
      type: "text",
      default: "",
      required: true, // Go `required:"true"`
      help: "WPS 云盘网页 Cookie（登录 account.kdocs.cn 后从浏览器复制）",
    },
    {
      name: "mode",
      type: "select",
      options: "Personal,Business", // Go meta.go options
      default: "Personal",
      required: false,
      help: "",
    },
    {
      name: "custom_ua",
      type: "string",
      default: "",
      required: false,
      help: "Custom User-Agent for API and download link requests",
    },
  ],
  config: {
    name: "WPS",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // put() ported (single-request presigned upload pipeline)
    need_ms: false,
    default_root: "/", // Go Config().DefaultRoot
    // Go Config().CheckStatus = true has no counterpart here (init() already
    // validates the cookie via the islogin API).
  },
}
