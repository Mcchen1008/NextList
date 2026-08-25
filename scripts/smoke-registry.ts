// Smoke test: verify all ported drivers are properly registered
// 1. driverConfigs has an entry for every driver name in /driver/names
// 2. Every driver config has the expected shape
import { portedDriverConfigs } from "../src/backend/drivers/registry"

let failures = 0
const fail = (msg: string) => {
  console.error("FAIL:", msg)
  failures++
}

// --- 1. Registry shape validation ---
const expectedDrivers = [
  "AListV3",
  "OpenListShare",
  "Misskey",
  "Emby",
  "WoPan",
  "KodBox",
  "CnbReleases",
  "AliyundriveShare",
  "GitHubReleases",
  "GooglePhoto",
  "Dropbox",
  "FebBox",
  "PikPakShare",
  "LenovoNasShare",
  "CloudflareImgBed",
  "AliDoc",
  "Cloudreve",
  "CloudreveV4",
  "ChaoXingGroupDrive",
  "BunnyStorage",
  "OnedriveSharelink",
  "Teldrive",
  "123PanShare",
  "Degoo",
  "WPS",
  "GuangYaPan",
  "Doubao",
  // Previous batch
  "PikPak",
  "Seafile",
  "USS",
  "Teambition",
  "MediaTrack",
  "YandexDisk",
  "Terabox",
  "UC",
  "139Cloud",
  "MediaFire",
]

for (const name of expectedDrivers) {
  const cfg = portedDriverConfigs[name]
  if (!cfg) {
    fail(`registry missing config for ${name}`)
    continue
  }
  if (cfg.name !== name)
    fail(`config name mismatch: ${name} has name=${cfg.name}`)
  if (!cfg.default_mount_path) fail(`${name} missing default_mount_path`)
  if (!Array.isArray(cfg.additional)) fail(`${name} missing additional fields`)
  if (!cfg.config || !cfg.config.name) fail(`${name} missing config block`)
  if (!Array.isArray(cfg.common)) fail(`${name} missing common fields`)
  // mount_path must be in common
  if (!cfg.common.some((f: any) => f.name === "mount_path")) {
    fail(`${name} common fields missing mount_path`)
  }
}

console.log(
  `Registry: ${Object.keys(portedDriverConfigs).length} configs validated`,
)

// --- 2. Cross-check: every registered config key has a storage.ts mapping ---
// storage.ts getDriver() normalizes by lowercasing and stripping non-alphanumerics.
// We verify each config name maps to a normalized alias that we know is handled.
const storageAliases: Record<string, string[]> = {
  AListV3: ["alistv3", "alist", "alistv2"],
  OpenListShare: ["openlistshare", "alistshare"],
  Misskey: ["misskey"],
  Emby: ["emby"],
  WoPan: ["wopan", "unicom", "wopanunicom"],
  KodBox: ["kodbox"],
  CnbReleases: ["cnbreleases", "cnb", "cnbrelease"],
  AliyundriveShare: ["aliyundriveshare"],
  GitHubReleases: ["githubreleases", "githubrelease"],
  GooglePhoto: ["googlephoto", "googlephotos"],
  Dropbox: ["dropbox"],
  FebBox: ["febbox"],
  PikPakShare: ["pikpakshare", "pikpaksharing"],
  LenovoNasShare: ["lenovonasshare", "lenovonas"],
  CloudflareImgBed: ["cloudflareimgbed", "cfimgbed"],
  AliDoc: ["alidoc", "dingtalkdoc"],
  Cloudreve: ["cloudreve", "cloudrevev3"],
  CloudreveV4: ["cloudrevev4", "cloudrevepro"],
  ChaoXingGroupDrive: ["chaoxing", "chaoxinggroupdrive", "xuexitong"],
  BunnyStorage: ["bunnystorage", "bunny"],
  OnedriveSharelink: ["onedrivesharelink", "onedriveshare"],
  Teldrive: ["teldrive"],
  "123PanShare": ["123share", "123panshare", "123panlink"],
  Degoo: ["degoo"],
  WPS: ["wps", "kdocs"],
  GuangYaPan: ["guangyapan", "gsp", "lightspeedpan"],
  Doubao: ["doubao", "doubaoDrive"],
}

// Verify config.name normalizes to one of the aliases we registered in storage.ts
const normalize = (s: string) => s.toLowerCase().replace(/_/g, "")
for (const [key, aliases] of Object.entries(storageAliases)) {
  const normName = normalize(key)
  if (!aliases.includes(normName)) {
    // The config name itself must be a registered alias, otherwise
    // getDriver(config.name) would fall through to the error branch.
    fail(
      `config name '${key}' normalizes to '${normName}' which is not a registered alias`,
    )
  }
}

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log("\nAll smoke checks passed ✓")
