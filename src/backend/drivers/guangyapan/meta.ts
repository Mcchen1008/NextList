// GuangYaPan (光速盘) driver form config (admin form)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/guangyapan/meta.go

export const guangyapanDriverConfig = {
  name: "GuangYaPan",
  default_mount_path: "/guangyapan",
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
    // mirrors Go meta.go Addition (json tags incl. defaults/options/help)
    {
      name: "root_path",
      type: "string",
      default: "",
      required: false,
      help: "Full path in GuangYaPan cloud drive",
    },
    {
      name: "phone_number",
      type: "text",
      default: "",
      required: false,
      help: "Phone number for SMS login, e.g. +86 13800000000",
    },
    {
      name: "captcha_token",
      type: "string",
      default: "",
      required: false,
      help: "Captcha token required by /v1/auth/verification",
    },
    {
      name: "send_code",
      type: "bool",
      default: "false",
      required: false,
      help: "Set true and save to send SMS code, it auto-resets to false after sending",
    },
    {
      name: "verify_code",
      type: "text",
      default: "",
      required: false,
      help: "SMS verification code used with phone_number; fill then save to finish login",
    },
    {
      name: "verification_id",
      type: "text",
      default: "",
      required: false,
      help: "Auto-generated after sending SMS code; do not edit manually",
    },
    {
      name: "access_token",
      type: "string",
      default: "",
      required: false,
      help: "Bearer access token (optional if refresh_token is provided)",
    },
    {
      name: "refresh_token",
      type: "string",
      default: "",
      required: false,
      help: "Refresh token for auto-login/auto-refresh",
    },
    {
      name: "client_id",
      type: "string",
      default: "",
      required: true,
      help: "Client ID for GuangYaPan API, must be provided",
    },
    {
      name: "device_id",
      type: "string",
      default: "",
      required: false,
      help: "Optional custom device id (32 hex chars), auto-generated when empty",
    },
    {
      name: "device_sign",
      type: "string",
      default: "",
      required: false,
      help: "Optional custom X-Device-Sign header (generated from device_id when empty)",
    },
    {
      name: "page_size",
      type: "number",
      default: "100",
      required: false,
      help: "",
    },
    {
      name: "order_by",
      type: "select",
      options: "0,1,2,3,4",
      default: "3",
      required: false,
      help: "Sort field used by the file list",
    },
    {
      name: "sort_type",
      type: "select",
      options: "0,1",
      default: "1",
      required: false,
      help: "Sort direction used by the file list",
    },
  ],
  config: {
    name: "GuangYaPan",
    local_sort: false, // server-side sorting via order_by/sort_type API params
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false, // Go has NoOverwriteUpload (no direct counterpart here)
    need_ms: false,
    default_root: "", // Go Config().DefaultRoot = ""
    // Go Config().CheckStatus / Alert have no counterpart in NextList;
    // two-stage SMS login: (1) fill phone_number (+ captcha_token if needed),
    // set send_code=true and save; (2) fill verify_code and save to finish
    // login and auto-save access_token/refresh_token.
  },
}
