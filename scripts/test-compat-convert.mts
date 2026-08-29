/**
 * Unit tests for the OpenList compatibility conversion layer.
 * Run: npx tsx scripts/test-compat-convert.mts
 */
import {
  normDriverName,
  toOpenListDriverName,
  toNextListDriverName,
  isDriverSupportedByNextList,
  additionToOpenList,
  additionFromOpenList,
  storageToOpenList,
  storageFromOpenList,
  settingsToOpenList,
  settingsFromOpenList,
  usersToOpenList,
  usersFromOpenList,
  encryptPayload,
  decryptPayload,
  assembleExport,
} from "../src/backend/compat/openlist"
import { defaultDb } from "../src/backend/internal/model/db"

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra?: any) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`✗ ${name}`, extra ?? "")
  }
}

// ---------------------------------------------------------------------------
// 1. Driver name mapping (all OpenList-canonical names used by the tests)
// ---------------------------------------------------------------------------
const driverPairs: [string, string][] = [
  ["local", "Local"],
  ["AliyundriveOpen", "AliyundriveOpen"],
  ["AliyundriveShare", "AliyundriveShare"],
  ["Onedrive", "Onedrive"],
  ["OnedriveSharelink", "Onedrive Sharelink"],
  ["GoogleDrive", "GoogleDrive"],
  ["GooglePhoto", "GooglePhoto"],
  ["Quark", "Quark"],
  ["UC", "UC"],
  ["123Pan", "123Pan"],
  ["123PanShare", "123PanShare"],
  ["BaiduNetdisk", "BaiduNetdisk"],
  ["115Open", "115 Open"],
  ["GitHub API", "GitHub API"],
  ["GitHubReleases", "GitHub Releases"],
  ["Thunder", "Thunder"],
  ["ThunderExpert", "ThunderExpert"],
  ["189Cloud", "189Cloud"],
  ["Lanzou", "Lanzou"],
  ["WebDav", "WebDav"],
  ["NeteaseMusic", "NeteaseMusic"],
  ["PikPak", "PikPak"],
  ["PikPakShare", "PikPakShare"],
  ["Seafile", "Seafile"],
  ["USS", "USS"],
  ["Teambition", "Teambition"],
  ["MediaTrack", "MediaTrack"],
  ["YandexDisk", "YandexDisk"],
  ["Terabox", "Terabox"],
  ["139Cloud", "139Yun"],
  ["MediaFire", "MediaFire"],
  ["AListV3", "AList V3"],
  ["OpenListShare", "OpenListShare"],
  ["Misskey", "Misskey"],
  ["Emby", "Emby"],
  ["WoPan", "WoPan"],
  ["KodBox", "KodBox"],
  ["CnbReleases", "CNB Releases"],
  ["Dropbox", "Dropbox"],
  ["FebBox", "FebBox"],
  ["LenovoNasShare", "LenovoNasShare"],
  ["CloudflareImgBed", "cloudflare_imgbed"],
  ["AliDoc", "AliDoc"],
  ["Cloudreve", "Cloudreve"],
  ["CloudreveV4", "Cloudreve V4"],
  ["ChaoXingGroupDrive", "ChaoXingGroupDrive"],
  ["BunnyStorage", "Bunny Storage"],
  ["Teldrive", "Teldrive"],
  ["Degoo", "Degoo"],
  ["WPS", "WPS"],
  ["GuangYaPan", "GuangYaPan"],
  ["Doubao", "Doubao"],
]
for (const [nl, ol] of driverPairs) {
  check(
    `driver ${nl} → ${ol}`,
    toOpenListDriverName(nl) === ol &&
      toNextListDriverName(ol) !== undefined,
    toOpenListDriverName(nl),
  )
}
check("OpenList OpenList → AListV3", toNextListDriverName("OpenList") === "AListV3")
check("OpenList Aliyundrive → AliyundriveOpen", toNextListDriverName("Aliyundrive") === "AliyundriveOpen")
check("OpenList OnedriveAPP → Onedrive", toNextListDriverName("OnedriveAPP") === "Onedrive")
check("OpenList S3 unsupported", isDriverSupportedByNextList("S3") === false)
check("OpenList FTP unsupported", isDriverSupportedByNextList("FTP") === false)
check("OpenList Local supported", isDriverSupportedByNextList("Local") === true)
check("norm strips underscores", normDriverName("cloudflare_imgbed") === "cloudflareimgbed")

// ---------------------------------------------------------------------------
// 2. Addition renames
// ---------------------------------------------------------------------------
const nl123 = { root_id: "5", access_token: "tok", platform: "web", username: "u", upload_thread: "3" }
const ol123 = additionToOpenList("123pan", nl123)
check("123pan export root_folder_id", ol123.root_folder_id === "5")
check("123pan export AccessToken", ol123.AccessToken === "tok")
check("123pan export UploadThread coerced to number", ol123.UploadThread === 3)
check("123pan export keeps platform", ol123.platform === "web" && ol123.username === "u")
check("123pan export removes root_id", !("root_id" in ol123) && !("access_token" in ol123))
const back123 = additionFromOpenList("123pan", ol123)
check("123pan import round-trip", back123.root_id === "5" && back123.access_token === "tok" && back123.platform === "web")

const olSea = { repoId: "r1", repoPwd: "p1", address: "https://s.example" }
const nlSea = additionFromOpenList("seafile", olSea)
check("seafile import repo_id/repo_pwd", nlSea.repo_id === "r1" && nlSea.repo_pwd === "p1")
check("seafile round-trip", additionToOpenList("seafile", nlSea).repoId === "r1")

const olFeb = { RefreshToken: "rt", client_id: "c" }
check("febbox import refresh_token", additionFromOpenList("febbox", olFeb).refresh_token === "rt")

const olBaidu = { AccessToken: "at", refresh_token: "rt" }
const nlBaidu = additionFromOpenList("baidunetdisk", olBaidu)
check("baidu import access_token", nlBaidu.access_token === "at" && nlBaidu.refresh_token === "rt")

// ---------------------------------------------------------------------------
// 3. Storage model conversion
// ---------------------------------------------------------------------------
const nlStorage = {
  id: 3,
  mount_path: "/onedrive",
  order: 2,
  driver: "Onedrive",
  status: "work",
  addition: JSON.stringify({ root_folder_path: "/", refresh_token: "rt", region: "global" }),
  remark: "test",
  modified: "2026-01-01T00:00:00.000Z",
  disabled: false,
  order_by: "name",
  order_direction: "asc",
  extract_folder: "front",
  web_proxy: false,
  webdav_policy: "302_redirect",
}
const olStorage = storageToOpenList(nlStorage)
check("storage export driver name", olStorage.driver === "Onedrive")
check("storage export fills cache_expiration", olStorage.cache_expiration === 30)
check("storage export fills enable_sign", olStorage.enable_sign === false)
check("storage export fills proxy_range", olStorage.proxy_range === false)
check("storage export fills down_proxy_url", olStorage.down_proxy_url === "")
check("storage export fills disable_proxy_sign", olStorage.disable_proxy_sign === false)
check("storage export fills custom_cache_policies", olStorage.custom_cache_policies === "")
check("storage export fills disable_index", olStorage.disable_index === false)
check("storage export addition is string", typeof olStorage.addition === "string")
check("storage export keeps sort", olStorage.order_by === "name" && olStorage.extract_folder === "front")
check("storage export has no mount_details", !("mount_details" in olStorage))
// Round-trip back to NextList
const nlBack = storageFromOpenList(olStorage, true)
check("storage round-trip driver", nlBack.driver === "Onedrive")
check("storage round-trip addition", JSON.parse(nlBack.addition).refresh_token === "rt")

// mount path normalization
const sloppy = storageToOpenList({ ...nlStorage, mount_path: "onedrive//sub/" })
check("mount path normalized", sloppy.mount_path === "/onedrive/sub")

// 139Yun import with rename
const ol139 = {
  mount_path: "/tianyi",
  driver: "139Yun",
  addition: JSON.stringify({ root_folder_id: "x", username: "a" }),
  disabled: false,
}
const nl139 = storageFromOpenList(ol139, true)
check("139Yun → 139Cloud", nl139.driver === "139Cloud")
check("139 root_folder_id → root_id", JSON.parse(nl139.addition).root_id === "x")

// Unsupported driver kept disabled
const olS3 = { mount_path: "/s3", driver: "S3", addition: JSON.stringify({ bucket: "b" }) }
const nlS3 = storageFromOpenList(olS3, false)
check("S3 kept disabled", nlS3.disabled === true && nlS3.status === "disabled")
check("S3 remark explains", String(nlS3.remark).includes("not supported"))
check("S3 addition untouched", JSON.parse(nlS3.addition).bucket === "b")

// ---------------------------------------------------------------------------
// 4. Settings conversion
// ---------------------------------------------------------------------------
const nlSettings = [
  { key: "site_title", value: "My Site", type: "string", help: "", group: 1, flag: 0 },
  { key: "version", value: "alpha0.1.2", type: "string", help: "", group: 1, flag: 1 },
  { key: "token", value: "secret", type: "string", help: "", group: 5, flag: 1 },
  { key: "index_progress", value: "", type: "text", help: "", group: 0, flag: 1 },
  { key: "ftp_public_host", value: "ftp://x", type: "string", help: "", group: 9, flag: 0 },
  { key: "max_client_download_speed", value: "0", type: "number", help: "", group: 10, flag: 0 },
  { key: "nextlist_only_key", value: "x", type: "string", help: "", group: 14, flag: 0 },
  { key: "aria2_uri", value: "ws://a", type: "string", help: "", group: 5, flag: 0 },
]
const olSettings = settingsToOpenList(nlSettings as any)
check("settings excludes token", !olSettings.some((s) => s.key === "token"))
check("settings excludes version", !olSettings.some((s) => s.key === "version"))
check("settings excludes index_progress", !olSettings.some((s) => s.key === "index_progress"))
check("settings excludes unknown keys", !olSettings.some((s) => s.key === "nextlist_only_key"))
check("settings ftp group 9→10", olSettings.find((s) => s.key === "ftp_public_host")?.group === 10)
check(
  "settings traffic group 10→11",
  olSettings.find((s) => s.key === "max_client_download_speed")?.group === 11,
)
check("settings aria2 group stays 5", olSettings.find((s) => s.key === "aria2_uri")?.group === 5)
check("settings keeps site_title group 1", olSettings.find((s) => s.key === "site_title")?.group === 1)

// Import: OpenList settings → NextList known keys only
const olSettingsIn = [
  { key: "site_title", value: "From OpenList", type: "string", help: "", group: 1, flag: 0, index: 1 },
  { key: "s3_access_key_id", value: "ak", type: "string", help: "", group: 9, flag: 2 },
  { key: "aria2_uri", value: "ws://from-openlist", type: "string", help: "", group: 5, flag: 0 },
  { key: "hide_files", value: "[]", type: "text", help: "", group: 4, flag: 0 },
  { key: "ftp_public_host", value: "ftp://y", type: "string", help: "", group: 10, flag: 0 },
  { key: "token", value: "leak", type: "string", help: "", group: 0, flag: 1 },
  { key: "brand_new_openlist_key", value: "v", type: "string", help: "", group: 4, flag: 0 },
]
const nlSettingsIn = settingsFromOpenList(olSettingsIn, defaultDb.settings)
check("import drops s3 keys", !nlSettingsIn.some((s) => s.key === "s3_access_key_id"))
check("import drops token", !nlSettingsIn.some((s) => s.key === "token"))
check("import drops unknown OpenList keys", !nlSettingsIn.some((s) => s.key === "brand_new_openlist_key"))
check(
  "import drops keys NextList lacks (ftp)",
  !nlSettingsIn.some((s) => s.key === "ftp_public_host"),
)
check("import site_title group from NextList table", nlSettingsIn.find((s) => s.key === "site_title")?.group === 1)
check(
  "import aria2_uri group from NextList table (OTHER=14)",
  nlSettingsIn.find((s) => s.key === "aria2_uri")?.group === 14,
)

// ---------------------------------------------------------------------------
// 5. Users conversion
// ---------------------------------------------------------------------------
const nlUsers = [
  { id: 1, username: "admin", role: 2, permission: 29183, base_path: "/" },
  { id: 2, username: "guest", role: 1, permission: 0, base_path: "/" },
  { id: 3, username: "alice", role: 0, permission: 8, base_path: "/alice", disabled: false, sso_id: "", allow_ldap: true },
]
const olUsers = usersToOpenList(nlUsers as any)
check("users export skips admin/guest", olUsers.length === 1 && olUsers[0].username === "alice")
check("users export empty password", olUsers[0].password === "" && olUsers[0].role === 0)
check("users round-trip", usersFromOpenList(olUsers as any)[0].username === "alice")
check(
  "users import skips admin/guest & roles",
  usersFromOpenList([
    { username: "admin", role: 2 },
    { username: "bob", role: 0 },
    { username: "carol", role: 1 },
  ] as any).length === 1,
)

// ---------------------------------------------------------------------------
// 6. Payload encryption round-trip (crypto-js compatible)
// ---------------------------------------------------------------------------
const db = {
  settings: nlSettings,
  users: nlUsers,
  storages: [nlStorage],
  metas: [{ id: 1, path: "/secret", password: "pw", hide: "", readme: "hi" }],
  shares: [{ id: "abc123", files: ["/x"] }],
}
const payload = assembleExport(db as any, "openlist")
const enc = encryptPayload(payload, "hunter2")
check("encrypt sets marker", typeof enc.encrypted === "string" && enc.encrypted.length > 0)
check("encrypt covers storages", typeof enc.storages[0].mount_path === "string" && enc.storages[0].mount_path.includes("Salted__") === false)
const dec = decryptPayload(enc, "hunter2")
check("decrypt round-trip storage", dec.storages[0].mount_path === payload.storages[0].mount_path)
check("decrypt round-trip settings", dec.settings[0].value === payload.settings[0].value)
check("decrypt round-trip metas", dec.metas[0].password === "pw")
let threw = false
try {
  decryptPayload(enc, "wrong")
} catch {
  threw = true
}
check("decrypt rejects wrong password", threw)

// ---------------------------------------------------------------------------
// 7. Full assembleExport shape
// ---------------------------------------------------------------------------
check(
  "assembleExport shape",
  ["encrypted", "settings", "users", "storages", "metas", "shares"].every(
    (k) => k in payload,
  ),
)
check("assembleExport drops shares for openlist", payload.shares.length === 0)
const nlPayload = assembleExport(db as any, "nextlist")
check("assembleExport keeps shares for nextlist", nlPayload.shares.length === 1)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
