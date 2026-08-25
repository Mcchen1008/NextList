// Degoo driver form config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/degoo/meta.go

export const degooDriverConfig = {
  name: "Degoo",
  default_mount_path: "/degoo",
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
      default: "0", // Go Config().DefaultRoot = "0" (auto-detects device root)
      required: true, // getAdditionalItems: Required = (default != "")
      help: "",
    },
    {
      name: "username",
      type: "string",
      default: "",
      required: false,
      help: "Your Degoo account email",
    },
    {
      name: "password",
      type: "string",
      default: "",
      required: false,
      help: "Your Degoo account password",
    },
    {
      name: "refresh_token",
      type: "string",
      default: "",
      required: false,
      help: "Refresh token for automatic token renewal, obtained automatically",
    },
    {
      name: "access_token",
      type: "string",
      default: "",
      required: false,
      help: "Access token for Degoo API, obtained automatically",
    },
  ],
  config: {
    name: "Degoo",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // Go implements Put (S3 pipeline); TS put throws explicitly
    need_ms: false,
    default_root: "0", // Go Config().DefaultRoot
    // Go Config().NoOverwriteUpload = true (no counterpart field in this schema)
  },
}
