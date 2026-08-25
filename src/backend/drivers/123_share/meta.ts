// 123PanShare driver form config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/123_share/meta.go

export const pan123ShareDriverConfig = {
  name: "123PanShare",
  default_mount_path: "/123_share",
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
    // mirrors Go meta.go Addition (incl. embedded driver.RootID).
    // Go OrderBy / OrderDirection fields are commented out in meta.go → omitted.
    {
      name: "root_folder_id",
      type: "string",
      default: "0", // Go Config().DefaultRoot = "0"
      required: true, // getAdditionalItems: Required = (default != "")
      help: "",
    },
    {
      name: "sharekey",
      type: "string",
      default: "",
      required: true, // Go: required:"true"
      help: "",
    },
    {
      name: "sharepassword",
      type: "string",
      default: "",
      required: false,
      help: "",
    },
    {
      name: "accesstoken",
      type: "text",
      default: "",
      required: false,
      help: "",
    },
  ],
  config: {
    name: "123PanShare",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // Go Config().NoUpload
    need_ms: false,
    default_root: "0", // Go Config().DefaultRoot
    // Go Config().PreferProxy = true (no counterpart field in this schema)
  },
}
