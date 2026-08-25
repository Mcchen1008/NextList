// GitHub Releases driver form config
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/github_releases/meta.go
//
// Go Config().Name is "GitHub Releases"; registered here without the space
// to match the admin form naming convention (cf. AliyundriveOpen).

export const githubReleasesDriverConfig = {
  name: "GitHubReleases",
  default_mount_path: "/github_releases",
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
      name: "repo_structure",
      type: "text",
      default: "OpenListTeam/OpenList",
      required: true,
      help: "structure:[path:]org/repo",
    },
    {
      name: "show_readme",
      type: "bool",
      default: "true",
      required: false,
      help: "show README、LICENSE file",
    },
    {
      name: "token",
      type: "string",
      default: "",
      required: false,
      help: "GitHub token, if you want to access private repositories or increase the rate limit",
    },
    {
      name: "show_source_code",
      type: "bool",
      default: "false",
      required: false,
      help: "show Source code (zip/tar.gz)",
    },
    {
      name: "show_all_version",
      type: "bool",
      default: "false",
      required: false,
      help: "show all versions",
    },
    {
      name: "per_page",
      type: "number",
      default: "30",
      required: false,
      help: "releases per page (max 100), only works when show all versions",
    },
    {
      name: "max_page",
      type: "number",
      default: "0",
      required: false,
      help: "max pages to fetch (0 = unlimited), only works when show all versions",
    },
    {
      name: "gh_proxy",
      type: "string",
      default: "",
      required: false,
      help: "GitHub proxy, e.g. https://ghproxy.net/https://github.com or https://gh-proxy.com/https://github.com",
    },
  ],
  config: {
    name: "GitHubReleases",
    local_sort: false, // Go Config().LocalSort unset — insertion order kept
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: true, // Go Config().NoUpload
    need_ms: false,
    default_root: "/", // Go driver.RootPath with no DefaultRoot
  },
}
