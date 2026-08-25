// PikPakShare driver form config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/pikpak_share/meta.go

export const pikPakShareDriverConfig = {
  name: "PikPakShare",
  default_mount_path: "/pikpak_share",
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
      name: "root_folder_id",
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
      help: "",
    },
    {
      name: "share_pwd",
      type: "string",
      default: "",
      required: false,
      help: "",
    },
    {
      name: "platform",
      type: "select",
      options: "android,web,pc",
      default: "web",
      required: true,
      help: "",
    },
    {
      name: "device_id",
      type: "string",
      default: "",
      required: false,
      help: "",
    },
    {
      name: "use_transcoding_address",
      type: "bool",
      default: "false",
      required: true,
      help: "",
    },
  ],
  config: {
    name: "PikPakShare",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // Go Config().NoUpload
    need_ms: false,
    default_root: "", // Go Config().DefaultRoot is empty (share root)
  },
}
