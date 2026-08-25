// KodBox driver config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/kodbox/meta.go

export const kodboxDriverConfig = {
  name: "KodBox",
  default_mount_path: "/kodbox",
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
      default: "",
      required: false,
      help: "",
    },
    {
      name: "address",
      type: "string",
      default: "",
      required: true,
      help: "KodBox address, e.g. http://127.0.0.1:8080",
    },
    { name: "username", type: "string", default: "", required: false },
    { name: "password", type: "string", default: "", required: false },
  ],
  config: {
    name: "KodBox",
    local_sort: false, // Go Config() only sets Name
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: "", // Go Config().DefaultRoot (unset)
  },
}
