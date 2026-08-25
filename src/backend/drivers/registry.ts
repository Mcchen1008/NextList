// Central driver config registry
// Aggregates admin UI form configs for all ported drivers.
// Each entry is exported from the driver's own meta.ts.

import { alistV3DriverConfig } from "./alist_v3/meta"
import { openListShareDriverConfig } from "./openlist_share/meta"
import { misskeyDriverConfig } from "./misskey/meta"
import { embyDriverConfig } from "./emby/meta"
import { wopanDriverConfig } from "./wopan/meta"
import { kodboxDriverConfig } from "./kodbox/meta"
import { cnbReleasesDriverConfig } from "./cnb_releases/meta"
import { aliyundriveShareDriverConfig } from "./aliyundrive_share/meta"
import { githubReleasesDriverConfig } from "./github_releases/meta"
import { googlePhotoDriverConfig } from "./google_photo/meta"
import { dropboxDriverConfig } from "./dropbox/meta"
import { febBoxDriverConfig } from "./febbox/meta"
import { pikPakShareDriverConfig } from "./pikpak_share/meta"
import { lenovoNasShareDriverConfig } from "./lenovonas_share/meta"
import { cloudflareImgBedDriverConfig } from "./cloudflare_imgbed/meta"
import { aliDocDriverConfig } from "./alidoc/meta"
import { cloudreveDriverConfig } from "./cloudreve/meta"
import { cloudreveV4DriverConfig } from "./cloudreve_v4/meta"
import { chaoxingDriverConfig } from "./chaoxing/meta"
import { bunnyStorageDriverConfig } from "./bunny_storage/meta"
import { onedriveSharelinkDriverConfig } from "./onedrive_sharelink/meta"
import { teldriveDriverConfig } from "./teldrive/meta"
import { pan123ShareDriverConfig } from "./123_share/meta"
import { degooDriverConfig } from "./degoo/meta"
import { wpsDriverConfig } from "./wps/meta"
import { guangyapanDriverConfig } from "./guangyapan/meta"
import { doubaoDriverConfig } from "./doubao/meta"

// Drivers ported in the previous batch (commit 28e3246) — meta.ts added now
import { pikpakDriverConfig } from "./pikpak/meta"
import { seafileDriverConfig } from "./seafile/meta"
import { ussDriverConfig } from "./uss/meta"
import { teambitionDriverConfig } from "./teambition/meta"
import { mediatrackDriverConfig } from "./mediatrack/meta"
import { yandexDiskDriverConfig } from "./yandex_disk/meta"
import { teraboxDriverConfig } from "./terabox/meta"
import { ucDriverConfig } from "./uc/meta"
import { cloud139DriverConfig } from "./139/meta"
import { mediafireDriverConfig } from "./mediafire/meta"

/**
 * All driver form configs for the admin UI (GET /admin/driver/list).
 * Keys must match the driver names accepted by getDriver() in
 * internal/op/storage.ts (the `name` field of each config).
 */
export const portedDriverConfigs: Record<string, any> = {
  AListV3: alistV3DriverConfig,
  OpenListShare: openListShareDriverConfig,
  Misskey: misskeyDriverConfig,
  Emby: embyDriverConfig,
  WoPan: wopanDriverConfig,
  KodBox: kodboxDriverConfig,
  CnbReleases: cnbReleasesDriverConfig,
  AliyundriveShare: aliyundriveShareDriverConfig,
  GitHubReleases: githubReleasesDriverConfig,
  GooglePhoto: googlePhotoDriverConfig,
  Dropbox: dropboxDriverConfig,
  FebBox: febBoxDriverConfig,
  PikPakShare: pikPakShareDriverConfig,
  LenovoNasShare: lenovoNasShareDriverConfig,
  CloudflareImgBed: cloudflareImgBedDriverConfig,
  AliDoc: aliDocDriverConfig,
  Cloudreve: cloudreveDriverConfig,
  CloudreveV4: cloudreveV4DriverConfig,
  ChaoXingGroupDrive: chaoxingDriverConfig,
  BunnyStorage: bunnyStorageDriverConfig,
  OnedriveSharelink: onedriveSharelinkDriverConfig,
  Teldrive: teldriveDriverConfig,
  "123PanShare": pan123ShareDriverConfig,
  Degoo: degooDriverConfig,
  WPS: wpsDriverConfig,
  GuangYaPan: guangyapanDriverConfig,
  Doubao: doubaoDriverConfig,

  // Previous batch (28e3246)
  PikPak: pikpakDriverConfig,
  Seafile: seafileDriverConfig,
  USS: ussDriverConfig,
  Teambition: teambitionDriverConfig,
  MediaTrack: mediatrackDriverConfig,
  YandexDisk: yandexDiskDriverConfig,
  Terabox: teraboxDriverConfig,
  UC: ucDriverConfig,
  "139Cloud": cloud139DriverConfig,
  MediaFire: mediafireDriverConfig,
}
