// Misskey driver config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/misskey
export const misskeyDriverConfig = {
  name: "Misskey",
  default_mount_path: "/misskey",
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
    // mirrors Go meta.go Addition (incl. embedded driver.RootPath)
    {
      name: "root_folder_path",
      type: "string",
      default: "/",
      required: false,
      help: "",
    },
    {
      name: "endpoint",
      type: "string",
      default: "https://misskey.io",
      required: true,
      help: "Misskey instance address, e.g. https://misskey.io",
    },
    {
      name: "access_token",
      type: "text",
      default: "",
      required: true,
      help: "true",
    },
  ],
  config: {
    name: "Misskey",
    local_sort: false, // Go Config() does not set LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: "/", // Go Config().DefaultRoot
  },
}
