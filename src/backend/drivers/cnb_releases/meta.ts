// CNB Releases driver config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cnb_releases/meta.go
// (Go Config().Name is "CNB Releases"; "CnbReleases" is used here to keep the
// registration name a single token like the other NextList drivers)

export const cnbReleasesDriverConfig = {
  name: "CnbReleases",
  default_mount_path: "/cnbreleases",
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
      default: "",
      required: false,
      help: "Optional: a single release id — the storage root then lists that release's assets directly",
    },
    {
      name: "repo",
      type: "string",
      default: "",
      required: true,
      help: "Repository path, e.g. group/repo",
    },
    {
      name: "token",
      type: "string",
      default: "",
      required: true,
      help: "true",
    },
    {
      name: "use_tag_name",
      type: "bool",
      default: "false",
      required: false,
      help: "Use tag name instead of release name",
    },
    {
      name: "default_branch",
      type: "string",
      default: "main",
      required: false,
      help: "Default branch for new releases (release creation not ported — read-only driver)",
    },
  ],
  config: {
    name: "CnbReleases",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // TS port is read-only; Go driver supports release/asset write APIs
    need_ms: false,
    default_root: "", // Go Config().DefaultRoot (unset)
  },
}
