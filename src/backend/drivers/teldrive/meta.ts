// Teldrive driver config (admin frontend form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/teldrive
//
// `additional` fields mirror Go meta.go Addition json tags:
//   driver.RootPath → root_folder_path (Config().DefaultRoot is "/"),
//   Address → url, Cookie → cookie, UseShareLink → use_share_link,
//   ChunkSize → chunk_size, RandomChunkName → random_chunk_name,
//   UploadConcurrency → upload_concurrency.
// chunk_size / random_chunk_name / upload_concurrency only affect the Go
// upload pipeline — kept for config compatibility (put() throws here).

export const teldriveDriverConfig = {
  name: "Teldrive",
  default_mount_path: "/teldrive",
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
      help: "Teldrive instance address, e.g. https://teldrive.com",
    },
    {
      name: "cookie",
      type: "string",
      default: "",
      required: true,
      help: "access_token=xxx",
    },
    {
      name: "use_share_link",
      type: "bool",
      default: "false",
      required: false,
      help: "Create share link when getting link to support 302. If disabled, you need to enable web proxy.",
    },
    {
      name: "chunk_size",
      type: "number",
      default: "10",
      required: false,
      help: "Chunk size in MiB",
    },
    {
      name: "random_chunk_name",
      type: "bool",
      default: "true",
      required: false,
      help: "Random chunk name",
    },
    {
      name: "upload_concurrency",
      type: "number",
      default: "4",
      required: false,
      help: "Concurrency upload requests",
    },
  ],
  config: {
    name: "Teldrive",
    local_sort: false, // Go Config() has no LocalSort (AList sorts server-side)
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // put() throws (upload pipeline not ported)
    need_ms: false,
    default_root: "/", // Go Config().DefaultRoot
  },
}
