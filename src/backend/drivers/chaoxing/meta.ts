// ChaoXing (超星学习通小组网盘) driver config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/chaoxing/meta.go

export const chaoxingDriverConfig = {
  name: "ChaoXingGroupDrive",
  default_mount_path: "/chaoxing",
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
    // mirrors Go meta.go Addition (incl. embedded driver.RootID)
    {
      name: "user_name",
      type: "string",
      default: "",
      required: true,
      help: "超星账号（手机号/用户名）",
    },
    {
      name: "password",
      type: "string",
      default: "",
      required: true,
      help: "超星密码",
    },
    {
      name: "bbsid",
      type: "string",
      default: "",
      required: true,
      help: "从自己新建的小组 url 里获取（登录超星 → 个人空间 → 小组 → 新建小组，url 中的 bbsid 参数）",
    },
    {
      name: "root_folder_id",
      type: "string",
      default: "-1",
      required: false,
      help: 'Go Config().DefaultRoot is "-1"',
    },
    {
      name: "cookie",
      type: "text",
      default: "",
      required: false,
      help: "可不填，填写 user_name/password 后程序会自动登录获取并刷新",
    },
    {
      name: "order_by",
      type: "select",
      options: "name,size,modified",
      default: "name",
      required: false,
      help: "",
    },
    {
      name: "order_desc",
      type: "bool",
      default: "false",
      required: false,
      help: "",
    },
  ],
  config: {
    name: "ChaoXingGroupDrive",
    local_sort: false, // Go Config().LocalSort is false (AList server-side sort)
    only_local: false,
    only_proxy: true, // Go Config().OnlyProxy — links need Cookie/Referer/UA headers
    no_cache: false,
    no_upload: false, // put() upload pipeline is ported
    need_ms: false,
    default_root: "-1", // Go Config().DefaultRoot
    // (Go NoOverwriteUpload = true has no counterpart in this config shape)
  },
}
