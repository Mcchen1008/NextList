// LenovoNasShare driver form config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/lenovonas_share/meta.go

export const lenovoNasShareDriverConfig = {
  name: "LenovoNasShare",
  default_mount_path: "/lenovonas_share",
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
      default: "", // Go Config().DefaultRoot is empty
      required: false,
      help: "",
    },
    {
      name: "share_id",
      type: "string",
      default: "",
      required: true,
      help: "The part after the last / in the shared link",
    },
    {
      name: "share_pwd",
      type: "string",
      default: "",
      required: true,
      help: "The password of the shared link",
    },
    {
      name: "host",
      type: "string",
      default: "https://siot-share.lenovo.com.cn",
      required: true,
      help: "You can change it to your local area network",
    },
    {
      name: "show_root_folder",
      type: "bool",
      default: "true",
      required: false,
      help: "",
    },
  ],
  config: {
    name: "LenovoNasShare",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // Go Config().NoUpload
    need_ms: false,
    default_root: "", // Go Config().DefaultRoot is empty
  },
}
