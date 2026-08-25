// AliyundriveShare driver form config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/aliyundrive_share/meta.go

export const aliyundriveShareDriverConfig = {
  name: "AliyundriveShare",
  default_mount_path: "/aliyundrive_share",
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
      name: "refresh_token",
      type: "string",
      default: "",
      required: true,
      help: "true",
    },
    {
      name: "share_id",
      type: "string",
      default: "",
      required: true,
      help: "share id, the part after /s/ in the share link",
    },
    { name: "share_pwd", type: "string", default: "", required: false },
    {
      name: "root_folder_id",
      type: "string",
      default: "root",
      required: false,
      help: "true",
    },
    {
      name: "order_by",
      type: "select",
      options: "name,size,updated_at,created_at",
      default: "",
      required: false,
    },
    {
      name: "order_direction",
      type: "select",
      options: "ASC,DESC",
      default: "",
      required: false,
    },
  ],
  config: {
    name: "AliyundriveShare",
    local_sort: false, // Go Config().LocalSort — order_by applied server-side
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // Go Config().NoUpload
    need_ms: false,
    default_root: "root", // Go Config().DefaultRoot
  },
}
