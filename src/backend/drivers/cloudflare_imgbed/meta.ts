// CloudflareImgBed driver config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/cloudflare_imgbed/meta.go
//
// `additional` mirrors Go meta.go Addition (json tags preserved), with the
// embedded driver.RootPath flattened first (getAdditionalItems recursion
// order). root_folder_path default "/" comes from Config().DefaultRoot.

export const cloudflareImgBedDriverConfig = {
  name: "CloudflareImgBed", // Go Config().Name: "cloudflare_imgbed"
  default_mount_path: "/cloudflare_imgbed",
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
      required: true,
      help: "",
    },
    {
      name: "address",
      type: "string",
      default: "",
      required: true,
      help: "Backend API address of the image hosting service, e.g., https://img.example.com",
    },
    {
      name: "token",
      type: "string",
      default: "",
      required: true,
      help: "Authentication Token",
    },
    {
      name: "smallChannelName",
      type: "string",
      default: "",
      required: false,
      help: "Channel name for regular files (typically <20MB)",
    },
    {
      name: "largeChannelName",
      type: "string",
      default: "",
      required: false,
      help: "Channel name for large files",
    },
    {
      name: "largeChannelType",
      type: "select",
      options: ",huggingface,telegram,cfr2,s3,discord",
      default: "",
      required: false,
      help: "Large File Channel Type: Hugging Face (Direct Upload)、telegram/cfr2/s3/discord(Multipart Upload)",
    },
    {
      name: "uploadThread",
      type: "number",
      default: "3",
      required: false,
      help: "Concurrent thread count for HuggingFace chunked direct upload",
    },
  ],
  config: {
    name: "CloudflareImgBed",
    local_sort: true, // Go Config().LocalSort
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // uploads supported (standard / chunked / HF direct)
    need_ms: false,
    default_root: "/", // Go Config().DefaultRoot
  },
}
