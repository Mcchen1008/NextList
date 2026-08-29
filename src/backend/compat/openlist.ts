/**
 * OpenList compatibility adapter layer.
 *
 * This module converts NextList admin data (storages / settings / users /
 * metas) into the exact shapes produced by OpenList (https://github.com/
 * OpenListTeam/OpenList) and vice versa, so that a backup file exported from
 * one system can be imported into the other without data loss.
 *
 * Both projects descend from the same lineage, so the outer backup envelope
 * is shared:
 *
 *   { encrypted, settings, users, storages, metas, shares }
 *
 * The differences live in the details, and this file normalizes all of them:
 *
 *  1. Driver names        ("139Yun" vs "139Cloud", "Bunny Storage" vs
 *                          "BunnyStorage", "AList V3" vs "AListV3", ...)
 *  2. Driver `addition`   (per-driver JSON field renames, e.g. NextList's
 *                          `root_id` vs OpenList's `root_folder_id`,
 *                          `access_token` vs Go's tag-less `AccessToken`)
 *  3. Storage model       (OpenList carries extra columns: cache_expiration,
 *                          custom_cache_policies, disable_index, enable_sign,
 *                          proxy_range, down_proxy_url, disable_proxy_sign)
 *  4. Settings groups     (OpenList: OFFLINE_DOWNLOAD=5, S3=9, FTP=10,
 *                          TRAFFIC=11 vs NextList: ARIA2=5, FTP=9, TRAFFIC=10)
 *  5. Users               (passwords are never portable — both systems store
 *                          hashes; exported users carry an empty password)
 *  6. Backup encryption   (crypto-js AES, byte-compatible with the format
 *                          produced/consumed by the OpenList & NextList web
 *                          UIs so encrypted files stay interchangeable)
 *
 * Everything in this module is pure data transformation (no Hono, no Node
 * APIs) so it also runs on edge runtimes (Cloudflare Workers / EdgeOne).
 */

import crypto from "crypto-js"

// ---------------------------------------------------------------------------
// Driver name mapping
// ---------------------------------------------------------------------------

/** Lowercase + strip underscores — mirrors internal/op/storage.ts getDriver. */
export function normDriverName(name: string): string {
  return (name || "").toLowerCase().replace(/_/g, "")
}

/** Normalize a mount path the same way both systems do. */
export function normMountPath(p: string): string {
  return (
    "/" +
    String(p || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  )
}

/** Segment-wise path normalize (metas / user base_path). */
export function normPath(p: string): string {
  return (
    "/" +
    String(p || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  )
}

/**
 * NextList canonical driver name (normalized key) → OpenList driver name.
 * Only drivers that exist on BOTH sides are listed; anything absent from
 * this table is preserved verbatim on export (OpenList simply reports an
 * unknown driver gracefully and the entry stays re-importable).
 */
const NEXTLIST_TO_OPENLIST_DRIVER: Record<string, string> = {
  local: "Local",
  aliyundriveopen: "AliyundriveOpen",
  aliyundriveshare: "AliyundriveShare",
  onedrive: "Onedrive",
  onedrivesharelink: "Onedrive Sharelink",
  googledrive: "GoogleDrive",
  googlephoto: "GooglePhoto",
  quark: "Quark",
  uc: "UC",
  "123pan": "123Pan",
  "123panshare": "123PanShare",
  baidunetdisk: "BaiduNetdisk",
  "115open": "115 Open",
  github: "GitHub API",
  githubreleases: "GitHub Releases",
  thunder: "Thunder",
  thunderexpert: "ThunderExpert",
  "189cloud": "189Cloud",
  lanzou: "Lanzou",
  webdav: "WebDav",
  neteasemusic: "NeteaseMusic",
  pikpak: "PikPak",
  pikpakshare: "PikPakShare",
  seafile: "Seafile",
  uss: "USS",
  teambition: "Teambition",
  mediatrack: "MediaTrack",
  yandexdisk: "YandexDisk",
  terabox: "Terabox",
  "139cloud": "139Yun",
  mediafire: "MediaFire",
  alistv3: "AList V3",
  openlistshare: "OpenListShare",
  misskey: "Misskey",
  emby: "Emby",
  wopan: "WoPan",
  kodbox: "KodBox",
  cnbreleases: "CNB Releases",
  dropbox: "Dropbox",
  febbox: "FebBox",
  lenovonasshare: "LenovoNasShare",
  cloudflareimgbed: "cloudflare_imgbed",
  alidoc: "AliDoc",
  cloudreve: "Cloudreve",
  cloudrevev4: "Cloudreve V4",
  chaoxing: "ChaoXingGroupDrive",
  chaoxinggroupdrive: "ChaoXingGroupDrive",
  bunnystorage: "Bunny Storage",
  teldrive: "Teldrive",
  degoo: "Degoo",
  wps: "WPS",
  guangyapan: "GuangYaPan",
  doubao: "Doubao",
}

/**
 * OpenList driver name → NextList canonical driver name (as registered in
 * src/backend/drivers/registry.ts). Drivers without an entry here are NOT
 * supported by NextList; the importer keeps their config (disabled) so no
 * data is lost and the entry can be exported back unchanged.
 */
const OPENLIST_TO_NEXTLIST_DRIVER: Record<string, string> = {
  Local: "local",
  AliyundriveOpen: "AliyundriveOpen",
  Aliyundrive: "AliyundriveOpen", // legacy OpenList driver, same protocol
  AliyundriveShare: "AliyundriveShare",
  Onedrive: "Onedrive",
  OnedriveAPP: "Onedrive", // NextList Onedrive handles the app-only flow
  "Onedrive Sharelink": "OnedriveSharelink",
  GoogleDrive: "GoogleDrive",
  GooglePhoto: "GooglePhoto",
  Quark: "Quark",
  UC: "UC",
  "123Pan": "123Pan",
  "123PanShare": "123PanShare",
  BaiduNetdisk: "BaiduNetdisk",
  "115 Open": "115Open",
  "GitHub API": "GitHub API",
  "GitHub Releases": "GitHubReleases",
  Thunder: "Thunder",
  ThunderExpert: "ThunderExpert",
  "189Cloud": "189Cloud",
  Lanzou: "Lanzou",
  WebDav: "WebDav",
  NeteaseMusic: "NeteaseMusic",
  PikPak: "PikPak",
  PikPakShare: "PikPakShare",
  Seafile: "Seafile",
  USS: "USS",
  Teambition: "Teambition",
  MediaTrack: "MediaTrack",
  YandexDisk: "YandexDisk",
  Terabox: "Terabox",
  "139Yun": "139Cloud",
  MediaFire: "MediaFire",
  "AList V3": "AListV3",
  OpenList: "AListV3", // OpenList remote driver == NextList alist_v3 driver
  OpenListShare: "OpenListShare",
  Misskey: "Misskey",
  Emby: "Emby",
  WoPan: "WoPan",
  KodBox: "KodBox",
  "CNB Releases": "CnbReleases",
  Dropbox: "Dropbox",
  FebBox: "FebBox",
  LenovoNasShare: "LenovoNasShare",
  cloudflare_imgbed: "CloudflareImgBed",
  AliDoc: "AliDoc",
  Cloudreve: "Cloudreve",
  "Cloudreve V4": "CloudreveV4",
  ChaoXingGroupDrive: "ChaoXingGroupDrive",
  "Bunny Storage": "BunnyStorage",
  Teldrive: "Teldrive",
  Degoo: "Degoo",
  WPS: "WPS",
  GuangYaPan: "GuangYaPan",
  Doubao: "Doubao",
}

/** Resolve the OpenList driver name for a NextList storage row. */
export function toOpenListDriverName(nextlistDriver: string): string {
  const norm = normDriverName(nextlistDriver)
  return NEXTLIST_TO_OPENLIST_DRIVER[norm] || nextlistDriver
}

/**
 * Resolve the NextList driver name for an OpenList storage row.
 * Returns `undefined` when NextList has no equivalent driver.
 */
export function toNextListDriverName(
  openlistDriver: string,
): string | undefined {
  return OPENLIST_TO_NEXTLIST_DRIVER[openlistDriver]
}

/** Whether an OpenList driver can be served by NextList. */
export function isDriverSupportedByNextList(openlistDriver: string): boolean {
  return !!OPENLIST_TO_NEXTLIST_DRIVER[openlistDriver]
}

// ---------------------------------------------------------------------------
// Driver `addition` field renames
// ---------------------------------------------------------------------------

/**
 * Per-driver addition renames between NextList field names and OpenList
 * field names. Key = normalized NextList driver name. Each pair is
 * [nextlistField, openlistField, coerce?]: when coerce === "number" the
 * value is converted to a number on export (NextList stores it as string,
 * OpenList's Go struct expects an int). Fields absent from the pair list
 * keep their names; unknown extra keys survive untouched (both sides
 * ignore unknown keys when deserializing additions).
 */
const ADDITION_RENAMES: Record<string, [string, string, "number"?][]> = {
  // NextList Pan123 reads root_id/access_token/upload_thread while OpenList
  // 123Pan uses root_folder_id / tag-less AccessToken / UploadThread(int).
  "123pan": [
    ["root_id", "root_folder_id"],
    ["access_token", "AccessToken"],
    ["upload_thread", "UploadThread", "number"],
  ],
  "115open": [["root_id", "root_folder_id"]],
  uc: [["root_id", "root_folder_id"]],
  "139cloud": [["root_id", "root_folder_id"]],
  pikpak: [["root_id", "root_folder_id"]],
  teambition: [["root_id", "root_folder_id"]],
  mediatrack: [["root_id", "root_folder_id"]],
  // OpenList seafile uses literal Go tags repoId / repoPwd.
  seafile: [
    ["repo_id", "repoId"],
    ["repo_pwd", "repoPwd"],
  ],
  // OpenList febbox declares RefreshToken without a json tag.
  febbox: [["refresh_token", "RefreshToken"]],
  // Tag-less Go AccessToken write-back fields.
  dropbox: [["access_token", "AccessToken"]],
  baidunetdisk: [["access_token", "AccessToken"]],
}

/** Parse a storage addition that may be a JSON string or an object. */
export function parseAddition(addition: any): Record<string, any> {
  if (!addition) return {}
  if (typeof addition === "string") {
    try {
      return JSON.parse(addition)
    } catch {
      return {}
    }
  }
  return addition
}

function applyRenames(
  addition: Record<string, any>,
  pairs: [string, string, "number"?][],
  fromOpenList: boolean,
): Record<string, any> {
  const out = { ...addition }
  for (const [nextlistField, openlistField, coerce] of pairs) {
    const from = fromOpenList ? openlistField : nextlistField
    const to = fromOpenList ? nextlistField : openlistField
    if (from in out) {
      let value = out[from]
      if (!fromOpenList && coerce === "number" && typeof value === "string") {
        const n = Number(value)
        if (!Number.isNaN(n)) value = n
      }
      out[to] = value
      if (to !== from) delete out[from]
    }
  }
  return out
}

/** NextList addition → OpenList addition (object form). */
export function additionToOpenList(
  normNextListDriver: string,
  addition: Record<string, any>,
): Record<string, any> {
  const pairs = ADDITION_RENAMES[normNextListDriver]
  if (!pairs) return addition
  return applyRenames(addition, pairs, false)
}

/** OpenList addition → NextList addition (object form). */
export function additionFromOpenList(
  normNextListDriver: string,
  addition: Record<string, any>,
): Record<string, any> {
  const pairs = ADDITION_RENAMES[normNextListDriver]
  if (!pairs) return addition
  return applyRenames(addition, pairs, true)
}

// ---------------------------------------------------------------------------
// Storage conversion
// ---------------------------------------------------------------------------

/** Convert a NextList storage row into OpenList's Storage shape. */
export function storageToOpenList(st: any): Record<string, any> {
  const normDriver = normDriverName(st.driver)
  const addition = additionToOpenList(normDriver, parseAddition(st.addition))
  return {
    id: st.id,
    mount_path: normMountPath(st.mount_path),
    order: st.order ?? 0,
    driver: toOpenListDriverName(st.driver),
    cache_expiration: st.cache_expiration ?? 30,
    custom_cache_policies: st.custom_cache_policies ?? "",
    status: "work",
    addition: JSON.stringify(addition),
    remark: st.remark ?? "",
    modified: st.modified || new Date().toISOString(),
    disabled: !!st.disabled,
    disable_index: !!st.disable_index,
    enable_sign: !!st.enable_sign,
    order_by: st.order_by ?? "",
    order_direction: st.order_direction ?? "",
    extract_folder: st.extract_folder ?? "",
    web_proxy: !!st.web_proxy,
    webdav_policy: st.webdav_policy || "302_redirect",
    proxy_range: !!st.proxy_range,
    down_proxy_url: st.down_proxy_url ?? "",
    disable_proxy_sign: !!st.disable_proxy_sign,
  }
}

/**
 * Convert an OpenList storage row into NextList's Storage shape.
 * `supported === false` keeps the original driver name and disables the
 * storage (NextList validates drivers lazily — an unsupported driver would
 * otherwise surface as broken mounts).
 */
export function storageFromOpenList(
  st: any,
  supported: boolean,
): Record<string, any> {
  const nextlistDriver = supported
    ? toNextListDriverName(st.driver)!
    : String(st.driver || "")
  const normDriver = normDriverName(nextlistDriver)
  const addition = supported
    ? additionFromOpenList(normDriver, parseAddition(st.addition))
    : parseAddition(st.addition)
  return {
    ...st,
    mount_path: normMountPath(st.mount_path),
    driver: nextlistDriver,
    addition: JSON.stringify(addition),
    status: supported ? "work" : "disabled",
    disabled: supported ? !!st.disabled : true,
    remark: supported
      ? (st.remark ?? "")
      : `[OpenList import] driver "${st.driver}" is not supported by NextList yet — config kept disabled for round-trip export. ${
          st.remark ?? ""
        }`.trim(),
  }
}

// ---------------------------------------------------------------------------
// Settings conversion
// ---------------------------------------------------------------------------

/** Settings keys that must never leave (or enter) an instance. */
export const EXCLUDED_SETTING_KEYS = ["token", "version", "index_progress"]

/**
 * OpenList-known setting keys → their OpenList group number
 * (internal/conf/const.go Group iota values). Export keeps only these keys
 * so OpenList's setting/save does not accumulate NextList-only entries.
 */
export const OPENLIST_SETTING_GROUPS: Record<string, number> = {
  // SITE (1)
  site_title: 1,
  announcement: 1,
  pagination_type: 1,
  default_page_size: 1,
  allow_indexed: 1,
  allow_mounted: 1,
  robots_txt: 1,
  // STYLE (2)
  logo: 2,
  favicon: 2,
  main_color: 2,
  home_icon: 2,
  share_icon: 2,
  home_container: 2,
  settings_layout: 2,
  hide_storage_details: 2,
  hide_storage_details_in_manage_page: 2,
  show_disk_usage_in_plain_text: 2,
  // PREVIEW (3)
  text_types: 3,
  audio_types: 3,
  video_types: 3,
  image_types: 3,
  proxy_types: 3,
  proxy_ignore_headers: 3,
  external_previews: 3,
  iframe_previews: 3,
  audio_cover: 3,
  audio_autoplay: 3,
  video_autoplay: 3,
  preview_download_by_default: 3,
  preview_archives_by_default: 3,
  share_preview_download_by_default: 3,
  share_preview_archives_by_default: 3,
  readme_autorender: 3,
  filter_readme_scripts: 3,
  non_efs_zip_encoding: 3,
  // GLOBAL (4)
  hide_files: 4,
  package_download: 4,
  customize_head: 4,
  customize_body: 4,
  link_expiration: 4,
  sign_all: 4,
  privacy_regs: 4,
  ocr_api: 4,
  filename_char_mapping: 4,
  forward_direct_link_params: 4,
  ignore_direct_link_params: 4,
  webauthn_login_enabled: 4,
  share_preview: 4,
  share_archive_preview: 4,
  share_force_proxy: 4,
  share_summary_content: 4,
  handle_hook_after_writing: 4,
  handle_hook_rate_limit: 4,
  ignore_system_files: 4,
  // OFFLINE_DOWNLOAD (5) — NextList group ARIA2 shares these keys
  aria2_uri: 5,
  aria2_secret: 5,
  qbittorrent_url: 5,
  qbittorrent_seedtime: 5,
  transmission_uri: 5,
  transmission_seedtime: 5,
  "115_temp_dir": 5,
  "123_temp_dir": 5,
  "123_open_temp_dir": 5,
  "123_open_callback_url": 5,
  "115_open_temp_dir": 5,
  pikpak_temp_dir: 5,
  thunder_temp_dir: 5,
  thunderx_temp_dir: 5,
  thunder_browser_temp_dir: 5,
  guangyapan_temp_dir: 5,
  // INDEX (6)
  search_index: 6,
  auto_update_index: 6,
  ignore_paths: 6,
  max_index_depth: 6,
  // SSO (7)
  sso_login_enabled: 7,
  sso_login_platform: 7,
  sso_client_id: 7,
  sso_client_secret: 7,
  sso_oidc_username_key: 7,
  sso_organization_name: 7,
  sso_application_name: 7,
  sso_endpoint_name: 7,
  sso_jwt_public_key: 7,
  sso_extra_scopes: 7,
  sso_auto_register: 7,
  sso_default_dir: 7,
  sso_default_permission: 7,
  sso_compatibility_mode: 7,
  // LDAP (8)
  ldap_login_enabled: 8,
  ldap_server: 8,
  ldap_skip_tls_verify: 8,
  ldap_manager_dn: 8,
  ldap_manager_password: 8,
  ldap_user_search_base: 8,
  ldap_user_search_filter: 8,
  ldap_default_dir: 8,
  ldap_default_permission: 8,
  ldap_login_tips: 8,
  // FTP (10)
  ftp_public_host: 10,
  ftp_pasv_port_map: 10,
  ftp_mandatory_tls: 10,
  ftp_implicit_tls: 10,
  ftp_tls_private_key_path: 10,
  ftp_tls_public_cert_path: 10,
  sftp_disable_password_login: 10,
  // TRAFFIC (11)
  offline_download_task_threads_num: 11,
  offline_download_transfer_task_threads_num: 11,
  upload_task_threads_num: 11,
  copy_task_threads_num: 11,
  move_task_threads_num: 11,
  decompress_download_task_threads_num: 11,
  decompress_upload_task_threads_num: 11,
  max_client_download_speed: 11,
  max_client_upload_speed: 11,
  max_server_download_speed: 11,
  max_server_upload_speed: 11,
  multipart_enabled: 11,
  multipart_chunk_size: 11,
}

/** NextList setting → OpenList SettingItem (drop unknown/secret keys). */
export function settingsToOpenList(items: any[]): any[] {
  return (items || [])
    .filter(
      (s) =>
        s &&
        !EXCLUDED_SETTING_KEYS.includes(s.key) &&
        s.key in OPENLIST_SETTING_GROUPS,
    )
    .map((s) => ({
      key: s.key,
      value: String(s.value ?? ""),
      help: s.help ?? "",
      type: s.type ?? "string",
      options: s.options ?? "",
      group: OPENLIST_SETTING_GROUPS[s.key],
      flag: s.flag ?? 0,
      index: s.index ?? 0,
    }))
}

/**
 * OpenList SettingItem → NextList setting. Only keys NextList itself knows
 * (present in its default settings table) are imported so OpenList-only
 * groups (S3 etc.) never pollute NextList's settings UI.
 */
export function settingsFromOpenList(
  items: any[],
  nextlistDefaultSettings: any[],
): any[] {
  const knownGroups: Record<string, number> = {}
  const knownTypes: Record<string, string> = {}
  for (const s of nextlistDefaultSettings || []) {
    knownGroups[s.key] = s.group
    knownTypes[s.key] = s.type
  }
  return (items || [])
    .filter(
      (s) =>
        s &&
        s.key &&
        !EXCLUDED_SETTING_KEYS.includes(s.key) &&
        s.key in knownGroups,
    )
    .map((s) => ({
      key: s.key,
      value: String(s.value ?? ""),
      help: s.help ?? "",
      type: knownTypes[s.key] || s.type || "string",
      options: s.options ?? "",
      group: knownGroups[s.key],
      flag: s.flag ?? 0,
      index: s.index ?? 0,
    }))
}

// ---------------------------------------------------------------------------
// Users conversion
// ---------------------------------------------------------------------------

const BUILTIN_USERNAMES = ["admin", "guest"]

/**
 * NextList user row → OpenList user. Only general users (role 0) are
 * exported: both systems refuse to create admin/guest accounts through the
 * API, and passwords are stored as hashes so they are never portable — the
 * exported password stays empty and must be re-set after import.
 */
export function usersToOpenList(users: any[]): any[] {
  return (users || [])
    .filter(
      (u) =>
        u &&
        Number(u.role) === 0 &&
        !BUILTIN_USERNAMES.includes(String(u.username)),
    )
    .map((u) => ({
      id: u.id,
      username: u.username,
      password: "",
      base_path: u.base_path || "/",
      role: 0,
      permission: u.permission ?? 0,
      disabled: !!u.disabled,
      sso_id: u.sso_id || "",
      allow_ldap: u.allow_ldap === undefined ? true : !!u.allow_ldap,
    }))
}

/** OpenList user → NextList user (general users only, same rationale). */
export function usersFromOpenList(users: any[]): any[] {
  return (users || [])
    .filter(
      (u) =>
        u &&
        Number(u.role) === 0 &&
        !BUILTIN_USERNAMES.includes(String(u.username)),
    )
    .map((u) => ({
      id: u.id,
      username: u.username,
      password: u.password || "",
      base_path: u.base_path || "/",
      role: 0,
      permission: u.permission ?? 0,
      disabled: !!u.disabled,
      sso_id: u.sso_id || "",
      allow_ldap: u.allow_ldap === undefined ? true : !!u.allow_ldap,
    }))
}

// ---------------------------------------------------------------------------
// Metas conversion — identical field names on both sides, pass through.
// ---------------------------------------------------------------------------

export function metasToOpenList(metas: any[]): any[] {
  return (metas || []).map((m) => ({ ...m, path: normPath(m.path) }))
}

export function metasFromOpenList(metas: any[]): any[] {
  return (metas || []).map((m) => ({ ...m, path: normPath(m.path) }))
}

// ---------------------------------------------------------------------------
// Backup envelope + crypto-js compatible encryption
// ---------------------------------------------------------------------------

export interface BackupPayload {
  encrypted: string
  settings: any[]
  users: any[]
  storages: any[]
  metas: any[]
  shares: any[]
  [key: string]: any
}

/**
 * Encrypt one field exactly the way the OpenList / NextList web UIs do:
 *   AES.encrypt(JSON.stringify(value), password).toString()   (OpenSSL
 *   "Salted__" blob, base64) → outer Base64 of that string.
 */
function encryptField(value: any, password: string): string {
  const encJson = crypto.AES.encrypt(JSON.stringify(value), password).toString()
  return crypto.enc.Base64.stringify(crypto.enc.Utf8.parse(encJson))
}

/** Decrypt one field produced by encryptField. Returns the parsed value. */
function decryptField(value: string, password: string): any {
  const decData = crypto.enc.Base64.parse(value).toString(crypto.enc.Utf8)
  return JSON.parse(
    crypto.AES.decrypt(decData, password).toString(crypto.enc.Utf8),
  )
}

/** Decrypt the encrypted-marker (raw string, no JSON.parse). */
function decryptMarker(value: string, password: string): string {
  const decData = crypto.enc.Base64.parse(value).toString(crypto.enc.Utf8)
  return crypto.AES.decrypt(decData, password).toString(crypto.enc.Utf8)
}

/**
 * Take an assembled plaintext payload and encrypt every field of every item
 * (plus the marker) with the given password — byte-compatible with the
 * NextList/OpenList frontend restore flows.
 */
export function encryptPayload(
  payload: BackupPayload,
  password: string,
): BackupPayload {
  const out: BackupPayload = {
    ...payload,
    encrypted: encryptField("encrypted", password),
  }
  for (const key of ["settings", "users", "storages", "metas", "shares"]) {
    out[key] = (payload[key] || []).map((obj: any) => {
      const clone: any = {}
      for (const k in obj) {
        clone[k] = obj[k] === undefined ? "" : encryptField(obj[k], password)
      }
      return clone
    })
  }
  return out
}

/**
 * Decrypt a payload whose item fields were encrypted with `password`.
 * Validates the marker first and throws on mismatch.
 */
export function decryptPayload(
  payload: BackupPayload,
  password: string,
): BackupPayload {
  if (!payload.encrypted) return payload
  if (decryptMarker(payload.encrypted, password) !== '"encrypted"') {
    throw new Error("wrong encryption password")
  }
  const out: BackupPayload = { ...payload, encrypted: "" }
  for (const key of ["settings", "users", "storages", "metas", "shares"]) {
    out[key] = (payload[key] || []).map((obj: any) => {
      const clone: any = {}
      for (const k in obj) {
        clone[k] =
          typeof obj[k] === "string" ? decryptField(obj[k], password) : obj[k]
      }
      return clone
    })
  }
  return out
}

/**
 * Assemble a NextList database snapshot into the shared backup envelope.
 *
 * @param format "openlist" converts every section into OpenList-compatible
 *               shapes (shares are dropped — OpenList has no equivalent);
 *               "nextlist" keeps the raw rows (same as the web UI backup).
 */
export function assembleExport(
  db: any,
  format: "openlist" | "nextlist",
): BackupPayload {
  if (format === "nextlist") {
    return {
      encrypted: "",
      settings: db.settings || [],
      users: db.users || [],
      storages: db.storages || [],
      metas: db.metas || [],
      shares: db.shares || [],
    }
  }
  return {
    encrypted: "",
    settings: settingsToOpenList(db.settings || []),
    users: usersToOpenList(db.users || []),
    storages: (db.storages || []).map(storageToOpenList),
    metas: metasToOpenList(db.metas || []),
    shares: [],
  }
}
