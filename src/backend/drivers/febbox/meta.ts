// FebBox driver form config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/febbox/meta.go

export const febBoxDriverConfig = {
  name: "FebBox",
  default_mount_path: "/febbox",
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
    // `RefreshToken` has no json tag in Go → not part of the form; it is
    // populated/persisted automatically after the first token fetch.
    {
      name: "root_folder_id",
      type: "string",
      default: "0", // Go Config().DefaultRoot = "0"
      required: true,
      help: "",
    },
    {
      name: "client_id",
      type: "string",
      default: "",
      required: true,
      help: "",
    },
    {
      name: "client_secret",
      type: "string",
      default: "",
      required: true,
      help: "",
    },
    {
      name: "sort_rule",
      type: "select",
      options:
        "size_asc,size_desc,name_asc,name_desc,update_asc,update_desc,ext_asc,ext_desc",
      default: "name_asc",
      required: true,
      help: "",
    },
    {
      name: "page_size",
      type: "number",
      default: "100",
      required: true,
      help: "list api per page size of FebBox driver",
    },
    {
      name: "user_ip",
      type: "string",
      default: "",
      required: false,
      help: "user ip address for download link which can speed up the download",
    },
  ],
  config: {
    name: "FebBox",
    local_sort: false, // server-side sorting via sort_rule (Go LocalSort not set)
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // Go Config().NoUpload
    need_ms: false,
    default_root: "0", // Go Config().DefaultRoot
    // Go Config().LinkCacheMode = driver.LinkCacheIP has no counterpart here
  },
}
