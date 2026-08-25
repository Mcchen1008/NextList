// MediaTrack (分秒帧) driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/mediatrack

export const mediatrackDriverConfig = {
  name: "MediaTrack",
  default_mount_path: "/mediatrack",
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
    { name: "access_token", type: "text", default: "", required: true },
    { name: "project_id", type: "string", default: "", required: false },
    { name: "root_id", type: "string", default: "", required: false },
    {
      name: "order_by",
      type: "select",
      options: "updated_at,title,size",
      default: "title",
      required: false,
    },
    { name: "order_desc", type: "bool", default: "false", required: false },
  ],
  config: {
    name: "MediaTrack",
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true,
    need_ms: false,
    default_root: "",
  },
}
