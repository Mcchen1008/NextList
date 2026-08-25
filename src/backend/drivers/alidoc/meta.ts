// AliDoc driver config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/alidoc/meta.go
//
// `additional` mirrors Go meta.go Addition (json tags preserved), with the
// embedded driver.RootID flattened first (getAdditionalItems recursion
// order). root_folder_id default "" comes from Config().DefaultRoot —
// note Go Init() fails when it is left empty.

export const aliDocDriverConfig = {
  name: "AliDoc",
  default_mount_path: "/alidoc",
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
      default: "",
      required: false,
      help: "root folder dentry UUID (required — Init fails when empty; copy it from the DingTalk docs URL)",
    },
    {
      name: "cookie",
      type: "text",
      default: "",
      required: true,
      help: "钉钉文档网页 Cookie",
    },
  ],
  config: {
    name: "AliDoc",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // Go implements Put (OSS pipeline); TS put throws explicitly
    need_ms: false,
    default_root: "", // Go Config().DefaultRoot
  },
}
