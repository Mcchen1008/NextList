// Seafile driver config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/seafile

export const seafileDriverConfig = {
  name: "Seafile",
  default_mount_path: "/seafile",
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
      name: "address",
      type: "string",
      default: "",
      required: true,
      help: "Seafile server address, e.g. https://seafile.example.com",
    },
    { name: "username", type: "string", default: "", required: false },
    {
      name: "password",
      type: "string",
      default: "",
      required: false,
      help: "App password / password for token auth",
    },
    {
      name: "token",
      type: "text",
      default: "",
      required: false,
      help: "Optional: use API token directly instead of username/password",
    },
    {
      name: "root_folder_path",
      type: "string",
      default: "/",
      required: true,
    },
    { name: "repo_id", type: "string", default: "", required: false },
    {
      name: "repo_pwd",
      type: "string",
      default: "",
      required: false,
      help: "Password for encrypted libraries",
    },
  ],
  config: {
    name: "Seafile",
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: "/",
  },
}
