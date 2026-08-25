// Google Photo driver config (admin frontend form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/google_photo
//
// `additional` fields mirror Go meta.go Addition json tags:
//   driver.RootID.RootFolderID → root_folder_id (default/required derived
//     from Config().DefaultRoot "root"),
//   RefreshToken → refresh_token, ClientID → client_id,
//   ClientSecret → client_secret, ShowArchive → show_archive (unused by Go).
// order_by / order_direction back the local sort (Go Config().LocalSort).

export const googlePhotoDriverConfig = {
  name: "GooglePhoto",
  default_mount_path: "/google_photo",
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
    {
      name: "root_folder_id",
      type: "string",
      default: "root",
      required: true,
      help: '"root" shows the virtual root (all / albums / share_albums); set an album id to open one album directly',
    },
    {
      name: "refresh_token",
      type: "text",
      default: "",
      required: true,
      help: "true",
    },
    {
      name: "client_id",
      type: "string",
      default: "202264815644.apps.googleusercontent.com",
      required: true,
      help: "",
    },
    {
      name: "client_secret",
      type: "string",
      default: "X4Z3ca8xfWDb1Voo-F9a7ZxJ",
      required: true,
      help: "",
    },
    {
      name: "show_archive",
      type: "bool",
      default: "false",
      required: false,
      help: "Kept for Go form parity; the Go driver never reads it",
    },
    {
      name: "order_by",
      type: "select",
      options: "name,size,modified",
      default: "name",
      required: false,
      help: "",
    },
    {
      name: "order_direction",
      type: "select",
      options: "asc,desc",
      default: "asc",
      required: false,
      help: "",
    },
  ],
  config: {
    name: "GooglePhoto",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: true, // Go Config().OnlyProxy — links must be proxied
    no_cache: false,
    no_upload: true, // Go Config().NoUpload — read-only driver
    need_ms: false,
    default_root: "root", // Go Config().DefaultRoot
  },
}
