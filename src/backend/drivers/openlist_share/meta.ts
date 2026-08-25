// OpenListShare driver config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/openlist_share
export const openListShareDriverConfig = {
  name: "OpenListShare",
  default_mount_path: "/openlist_share",
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
      name: "url",
      type: "string",
      default: "",
      required: true,
      help: "OpenList instance address, e.g. https://example.com",
    },
    {
      name: "sid",
      type: "string",
      default: "",
      required: true,
      help: "Share ID, the part after /s/ in the share link",
    },
    { name: "pwd", type: "string", default: "", required: false, help: "" },
    {
      name: "forward_archive_requests",
      type: "bool",
      default: "true",
      required: false,
      help: "",
    },
  ],
  config: {
    name: "OpenListShare",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // Go Config().NoUpload
    need_ms: false,
    default_root: "/", // Go Config().DefaultRoot
  },
}
