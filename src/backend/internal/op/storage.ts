import { resolvePath, getDb, saveDb } from "../model/db"
import { FileItem, StorageDriver, calcFileType } from "../driver/base"
import { Onedrive } from "../../drivers/onedrive/driver"
import { AliyundriveOpen } from "../../drivers/aliyundrive_open/driver"
import { GoogleDrive } from "../../drivers/google_drive/driver"
import { QuarkDriver } from "../../drivers/quark/driver"
import { Pan123Driver } from "../../drivers/123pan/driver"
import {
  BaiduDriver,
  normalizeBaiduAddition,
} from "../../drivers/baidu_netdisk/driver"
import { Pan115Driver } from "../../drivers/115open/driver"
import { GithubDriver } from "../../drivers/github/driver"
import {
  ThunderDriver,
  ThunderExpertDriver,
} from "../../drivers/thunder/driver"
import { Cloud189Driver } from "../../drivers/189/driver"
import { LanzouDriver } from "../../drivers/lanzou/driver"
import { WebdavDriver } from "../../drivers/webdav/driver"
import { NeteaseMusicDriver } from "../../drivers/netease_music/driver"
import { PikPakDriver } from "../../drivers/pikpak/driver"
import { SeafileDriver } from "../../drivers/seafile/driver"
import { UssDriver } from "../../drivers/uss/driver"
import { TeambitionDriver } from "../../drivers/teambition/driver"
import { MediaTrackDriver } from "../../drivers/mediatrack/driver"
import { YandexDiskDriver } from "../../drivers/yandex_disk/driver"
import { TeraboxDriver } from "../../drivers/terabox/driver"
import { UcDriver } from "../../drivers/uc/driver"
import { Cloud139Driver } from "../../drivers/139/driver"
import { MediaFireDriver } from "../../drivers/mediafire/driver"
import { AListV3Driver } from "../../drivers/alist_v3/driver"
import { OpenListShareDriver } from "../../drivers/openlist_share/driver"
import { MisskeyDriver } from "../../drivers/misskey/driver"
import { EmbyDriver } from "../../drivers/emby/driver"
import { WopanDriver } from "../../drivers/wopan/driver"
import { KodBoxDriver } from "../../drivers/kodbox/driver"
import { CnbReleasesDriver } from "../../drivers/cnb_releases/driver"
import { AliyundriveShareDriver } from "../../drivers/aliyundrive_share/driver"
import { GithubReleasesDriver } from "../../drivers/github_releases/driver"
import { GooglePhotoDriver } from "../../drivers/google_photo/driver"
import { DropboxDriver } from "../../drivers/dropbox/driver"
import { FebBoxDriver } from "../../drivers/febbox/driver"
import { PikPakShareDriver } from "../../drivers/pikpak_share/driver"
import { LenovoNasShareDriver } from "../../drivers/lenovonas_share/driver"
import { CloudflareImgBedDriver } from "../../drivers/cloudflare_imgbed/driver"
import { AliDocDriver } from "../../drivers/alidoc/driver"
import { CloudreveDriver } from "../../drivers/cloudreve/driver"
import { CloudreveV4Driver } from "../../drivers/cloudreve_v4/driver"
import { ChaoxingDriver } from "../../drivers/chaoxing/driver"
import { BunnyStorageDriver } from "../../drivers/bunny_storage/driver"
import { OnedriveSharelinkDriver } from "../../drivers/onedrive_sharelink/driver"
import { TeldriveDriver } from "../../drivers/teldrive/driver"
import { Pan123ShareDriver } from "../../drivers/123_share/driver"
import { DegooDriver } from "../../drivers/degoo/driver"
import { WpsDriver } from "../../drivers/wps/driver"
import { GuangYaPanDriver } from "../../drivers/guangyapan/driver"
import { DoubaoDriver } from "../../drivers/doubao/driver"

// LocalDriver is not available in Cloudflare Workers (no fs module).
// When running in Node.js container mode, import dynamically on first use.
let _localDriver: StorageDriver | null = null
async function getLocalDriver(): Promise<StorageDriver> {
  if (!_localDriver) {
    const { LocalDriver } = await import("../../drivers/local")
    _localDriver = new LocalDriver()
  }
  return _localDriver
}

const driverCache = new Map<string, StorageDriver>()

/** Persist a set of addition fields back into the storage config in the DB. */
async function persistAdditionFields(
  storageConfig: any,
  fields: Record<string, any>,
): Promise<void> {
  const storageId = storageConfig?.id
  if (!storageId) return
  try {
    const db = await getDb()
    const st = (db.storages || []).find(
      (s: any) => String(s.id) === String(storageId),
    )
    if (!st) return
    const stAddition =
      typeof st.addition === "string"
        ? JSON.parse(st.addition || "{}")
        : st.addition || {}
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) {
        stAddition[key] = value
      }
    }
    st.addition = JSON.stringify(stAddition)
    if (String(storageConfig.id) === String(storageId)) {
      storageConfig.addition = st.addition
    }
    await saveDb(db)
  } catch (e) {
    console.warn("[storage] failed to persist driver state:", e)
  }
}

/** Persister for drivers whose callback is (accessToken, refreshToken). */
function makeTokenPersister(
  storageConfig: any,
): (accessToken: string, refreshToken: string) => Promise<void> {
  return async (accessToken: string, refreshToken: string) => {
    await persistAdditionFields(storageConfig, {
      access_token: accessToken,
      refresh_token: refreshToken,
    })
  }
}

/** Persister for drivers whose callback receives a token object. */
function makeTokenObjectPersister(
  storageConfig: any,
  keys?: string[],
): (tokens: Record<string, any>) => void | Promise<void> {
  return async (tokens: Record<string, any>) => {
    const fields: Record<string, any> = {}
    for (const key of keys || Object.keys(tokens || {})) {
      if (tokens && tokens[key] !== undefined) fields[key] = tokens[key]
    }
    await persistAdditionFields(storageConfig, fields)
  }
}

/** Persister for drivers that refresh a cookie (cloudreve / chaoxing). */
function makeCookiePersister(
  storageConfig: any,
): (cookie: string) => void | Promise<void> {
  return async (cookie: string) => {
    await persistAdditionFields(storageConfig, { cookie })
  }
}

/** Persister for emby (api_key + user_id after username login). */
function makeCredentialsPersister(
  storageConfig: any,
): (apiKey: string, userId: string) => void | Promise<void> {
  return async (apiKey: string, userId: string) => {
    await persistAdditionFields(storageConfig, {
      api_key: apiKey,
      user_id: userId,
    })
  }
}

/** Persister for degoo (tokens + auto-detected root folder id). */
function makeDegooStatePersister(
  storageConfig: any,
): (state: {
  access_token: string
  refresh_token: string
  root_folder_id?: string
}) => void {
  return (state) => {
    void persistAdditionFields(storageConfig, {
      access_token: state.access_token,
      refresh_token: state.refresh_token,
      root_folder_id: state.root_folder_id,
    })
  }
}

function parseAddition(storageConfig?: any): any {
  const additionStr = storageConfig?.addition
  if (!additionStr) return {}
  return typeof additionStr === "string"
    ? JSON.parse(additionStr || "{}")
    : additionStr
}

export async function getDriver(
  driverName: string,
  storageConfig?: any,
): Promise<StorageDriver> {
  const normDriver = (driverName || "").toLowerCase().replace(/_/g, "")
  if (normDriver === "local") {
    // Only available in Node.js container — not in Cloudflare Workers
    if (typeof process !== "undefined" && process.release?.name === "node") {
      return getLocalDriver()
    }
    throw new Error(
      "Local storage driver requires Node.js runtime (not available in Cloudflare Workers)",
    )
  }

  if (!storageConfig) {
    throw new Error(
      "failed get driver: storage config not found for driver " + driverName,
    )
  }

  const cacheKey = `${storageConfig.id}_${storageConfig.modified}`

  if (driverCache.has(cacheKey)) {
    return driverCache.get(cacheKey)!
  }

  let driver: StorageDriver
  if (
    normDriver === "onedrive" ||
    normDriver === "onedriveapp" ||
    normDriver === "onedrivesb"
  ) {
    driver = new Onedrive(
      parseAddition(storageConfig),
      async (refreshToken) => {
        try {
          const db = await getDb()
          const st = (db.storages || []).find(
            (s: any) => s.id === storageConfig?.id,
          )
          if (!st) return
          const stAddition =
            typeof st.addition === "string"
              ? JSON.parse(st.addition || "{}")
              : st.addition || {}
          stAddition.refresh_token = refreshToken
          st.addition = JSON.stringify(stAddition)
          await saveDb(db)
        } catch (e) {
          console.warn("[Onedrive] failed to persist refresh token:", e)
        }
      },
    )
    try {
      await driver.init?.()
    } catch (e) {
      console.error("onedrive init failed:", e)
      throw e
    }
  } else if (
    normDriver === "aliyundrive" ||
    normDriver === "aliyundriveopen" ||
    normDriver === "aliyun"
  ) {
    // 统一只保留阿里云盘 OAuth2 (AliyundriveOpen)
    // Note: "AliyundriveShare" now maps to the dedicated share driver below.
    driver = new AliyundriveOpen(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "googledrive") {
    driver = new GoogleDrive(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "quark" || normDriver === "quarkuc") {
    driver = new QuarkDriver(parseAddition(storageConfig))
    await driver.init?.()
  } else if (normDriver === "123pan" || normDriver === "123") {
    const addition = parseAddition(storageConfig)
    driver = new Pan123Driver(addition, async (token: string) => {
      // Persist the refreshed 123Pan access_token back to the storage config
      // so subsequent cold starts skip password login (avoiding overseas-IP
      // risk control in Cloudflare Workers).
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = token
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[123Pan] failed to persist access_token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "baidunetdisk" ||
    normDriver === "baidu" ||
    normDriver === "baiduyun"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new BaiduDriver(addition, async (tokens) => {
      // Persist refreshed tokens (and normalized defaults) back to the
      // storage config so cold starts skip OAuth entirely.
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = tokens.access_token
        stAddition.refresh_token = tokens.refresh_token
        st.addition = JSON.stringify(normalizeBaiduAddition(stAddition))
        await saveDb(db)
      } catch (e) {
        console.warn("[baidu_netdisk] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "115open" ||
    normDriver === "115" ||
    normDriver === "115pan"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Pan115Driver(addition, async (tokens) => {
      // 持久化刷新后的 access_token / refresh_token，避免冷启动重复刷新
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.access_token = tokens.access_token
        stAddition.refresh_token = tokens.refresh_token
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[115open] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "github" ||
    normDriver === "githubapi" ||
    normDriver === "github_api"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new GithubDriver(addition)
    await driver.init?.()
  } else if (normDriver === "thunderexpert") {
    const addition = parseAddition(storageConfig)
    driver = new ThunderExpertDriver(addition, async (tokens) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        if (tokens.refresh_token)
          stAddition.refresh_token = tokens.refresh_token
        if (tokens.captcha_token)
          stAddition.captcha_token = tokens.captcha_token
        if (tokens.device_id) stAddition.device_id = tokens.device_id
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[thunderexpert] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (normDriver === "thunder" || normDriver === "xunlei") {
    const addition = parseAddition(storageConfig)
    driver = new ThunderDriver(addition, async (tokens) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        if (tokens.refresh_token)
          stAddition.refresh_token = tokens.refresh_token
        if (tokens.captcha_token)
          stAddition.captcha_token = tokens.captcha_token
        if (tokens.device_id) stAddition.device_id = tokens.device_id
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[thunder] failed to persist token:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "189" ||
    normDriver === "189cloud" ||
    normDriver === "cloud189" ||
    normDriver === "ctyun" ||
    normDriver === "189pan"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Cloud189Driver(addition)
    await driver.init?.()
  } else if (
    normDriver === "lanzou" ||
    normDriver === "lanzoupan" ||
    normDriver === "ilanzou" ||
    normDriver === "lanzoui" ||
    normDriver === "lanzous"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new LanzouDriver(addition, async (cookie) => {
      try {
        const db = await getDb()
        const st = (db.storages || []).find(
          (s: any) => s.id === storageConfig?.id,
        )
        if (!st) return
        const stAddition =
          typeof st.addition === "string"
            ? JSON.parse(st.addition || "{}")
            : st.addition || {}
        stAddition.cookie = cookie
        st.addition = JSON.stringify(stAddition)
        await saveDb(db)
      } catch (e) {
        console.warn("[Lanzou] failed to persist cookie:", e)
      }
    })
    await driver.init?.()
  } else if (
    normDriver === "webdav" ||
    normDriver === "webdavshare" ||
    normDriver === "dav"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new WebdavDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "neteasemusic" ||
    normDriver === "netease" ||
    normDriver === "neteasecloud" ||
    normDriver === "cloudmusic"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new NeteaseMusicDriver(addition)
    await driver.init?.()
  } else if (normDriver === "pikpak") {
    const addition = parseAddition(storageConfig)
    driver = new PikPakDriver(addition)
    await driver.init?.()
  } else if (normDriver === "seafile") {
    const addition = parseAddition(storageConfig)
    driver = new SeafileDriver(addition)
    await driver.init?.()
  } else if (normDriver === "uss" || normDriver === "upyun") {
    const addition = parseAddition(storageConfig)
    driver = new UssDriver(addition)
    await driver.init?.()
  } else if (normDriver === "teambition") {
    const addition = parseAddition(storageConfig)
    driver = new TeambitionDriver(addition)
    await driver.init?.()
  } else if (normDriver === "mediatrack" || normDriver === "fenmiao") {
    const addition = parseAddition(storageConfig)
    driver = new MediaTrackDriver(addition)
    await driver.init?.()
  } else if (normDriver === "yandexdisk" || normDriver === "yandex") {
    const addition = parseAddition(storageConfig)
    driver = new YandexDiskDriver(addition)
    await driver.init?.()
  } else if (normDriver === "terabox") {
    const addition = parseAddition(storageConfig)
    driver = new TeraboxDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "uc" ||
    normDriver === "ucdrive" ||
    normDriver === "ucpan"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new UcDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "139" ||
    normDriver === "139yun" ||
    normDriver === "139cloud" ||
    normDriver === "mcloud" ||
    normDriver === "caiyun"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Cloud139Driver(addition)
    await driver.init?.()
  } else if (normDriver === "mediafire") {
    const addition = parseAddition(storageConfig)
    driver = new MediaFireDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "alistv3" ||
    normDriver === "alist" ||
    normDriver === "alistv2"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new AListV3Driver(addition)
    await driver.init?.()
  } else if (normDriver === "openlistshare" || normDriver === "alistshare") {
    const addition = parseAddition(storageConfig)
    driver = new OpenListShareDriver(addition)
    await driver.init?.()
  } else if (normDriver === "misskey") {
    const addition = parseAddition(storageConfig)
    driver = new MisskeyDriver(addition)
    await driver.init?.()
  } else if (normDriver === "emby") {
    const addition = parseAddition(storageConfig)
    driver = new EmbyDriver(addition, makeCredentialsPersister(storageConfig))
    await driver.init?.()
  } else if (
    normDriver === "wopan" ||
    normDriver === "unicom" ||
    normDriver === "wopanunicom"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new WopanDriver(addition, makeTokenPersister(storageConfig))
    await driver.init?.()
  } else if (normDriver === "kodbox") {
    const addition = parseAddition(storageConfig)
    driver = new KodBoxDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "cnbreleases" ||
    normDriver === "cnb" ||
    normDriver === "cnbrelease"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new CnbReleasesDriver(addition)
    await driver.init?.()
  } else if (normDriver === "aliyundriveshare") {
    const addition = parseAddition(storageConfig)
    driver = new AliyundriveShareDriver(
      addition,
      makeTokenPersister(storageConfig),
    )
    await driver.init?.()
  } else if (
    normDriver === "githubreleases" ||
    normDriver === "githubrelease"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new GithubReleasesDriver(addition)
    await driver.init?.()
  } else if (normDriver === "googlephoto" || normDriver === "googlephotos") {
    const addition = parseAddition(storageConfig)
    driver = new GooglePhotoDriver(addition)
    await driver.init?.()
  } else if (normDriver === "dropbox") {
    const addition = parseAddition(storageConfig)
    driver = new DropboxDriver(addition, makeTokenPersister(storageConfig))
    await driver.init?.()
  } else if (normDriver === "febbox") {
    const addition = parseAddition(storageConfig)
    driver = new FebBoxDriver(addition, makeTokenObjectPersister(storageConfig))
    await driver.init?.()
  } else if (normDriver === "pikpakshare" || normDriver === "pikpaksharing") {
    const addition = parseAddition(storageConfig)
    driver = new PikPakShareDriver(addition)
    await driver.init?.()
  } else if (normDriver === "lenovonasshare" || normDriver === "lenovonas") {
    const addition = parseAddition(storageConfig)
    driver = new LenovoNasShareDriver(addition)
    await driver.init?.()
  } else if (normDriver === "cloudflareimgbed" || normDriver === "cfimgbed") {
    const addition = parseAddition(storageConfig)
    driver = new CloudflareImgBedDriver(addition)
    await driver.init?.()
  } else if (normDriver === "alidoc" || normDriver === "dingtalkdoc") {
    const addition = parseAddition(storageConfig)
    driver = new AliDocDriver(addition)
    await driver.init?.()
  } else if (normDriver === "cloudreve" || normDriver === "cloudrevev3") {
    const addition = parseAddition(storageConfig)
    driver = new CloudreveDriver(addition, makeCookiePersister(storageConfig))
    await driver.init?.()
  } else if (normDriver === "cloudrevev4" || normDriver === "cloudrevepro") {
    const addition = parseAddition(storageConfig)
    driver = new CloudreveV4Driver(
      addition,
      makeTokenObjectPersister(storageConfig, [
        "access_token",
        "refresh_token",
        "access_expires",
        "refresh_expires",
      ]),
    )
    await driver.init?.()
  } else if (
    normDriver === "chaoxing" ||
    normDriver === "chaoxinggroupdrive" ||
    normDriver === "xuexitong"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new ChaoxingDriver(addition, makeCookiePersister(storageConfig))
    await driver.init?.()
  } else if (normDriver === "bunnystorage" || normDriver === "bunny") {
    const addition = parseAddition(storageConfig)
    const mountPath =
      "/" +
      String(storageConfig?.mount_path || "")
        .split("/")
        .filter(Boolean)
        .join("/")
    driver = new BunnyStorageDriver(addition, mountPath)
    await driver.init?.()
  } else if (
    normDriver === "onedrivesharelink" ||
    normDriver === "onedriveshare"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new OnedriveSharelinkDriver(addition)
    await driver.init?.()
  } else if (normDriver === "teldrive") {
    const addition = parseAddition(storageConfig)
    driver = new TeldriveDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "123share" ||
    normDriver === "123panshare" ||
    normDriver === "123panlink"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new Pan123ShareDriver(addition)
    await driver.init?.()
  } else if (normDriver === "degoo") {
    const addition = parseAddition(storageConfig)
    driver = new DegooDriver(addition, makeDegooStatePersister(storageConfig))
    await driver.init?.()
  } else if (normDriver === "wps" || normDriver === "kdocs") {
    const addition = parseAddition(storageConfig)
    driver = new WpsDriver(addition)
    await driver.init?.()
  } else if (
    normDriver === "guangyapan" ||
    normDriver === "gsp" ||
    normDriver === "lightspeedpan"
  ) {
    const addition = parseAddition(storageConfig)
    driver = new GuangYaPanDriver(addition)
    await driver.init?.()
  } else if (normDriver === "doubao" || normDriver === "doubaoDrive") {
    const addition = parseAddition(storageConfig)
    driver = new DoubaoDriver(addition)
    await driver.init?.()
  } else {
    throw new Error(
      "failed get driver: unsupported driver '" + driverName + "'",
    )
  }

  driverCache.set(cacheKey, driver)
  return driver
}

export interface StorageRequestContext {
  waitUntil?: (promise: Promise<unknown>) => void
}

const cookiePersistenceCache = new Map<string, Promise<void>>()

function isCloud189Driver(driverName: string): boolean {
  const normDriver = (driverName || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    normDriver === "189" ||
    normDriver === "189cloud" ||
    normDriver === "cloud189" ||
    normDriver === "ctyun" ||
    normDriver === "189pan"
  )
}

export async function scheduleStoragePersistence(
  waitUntil: StorageRequestContext["waitUntil"],
  persistence: Promise<unknown>,
): Promise<void> {
  if (waitUntil) {
    try {
      waitUntil(persistence)
      return
    } catch {
      // Fall back to awaiting when the execution context is unavailable.
    }
  }
  await persistence
}

async function persistStorageCookie(
  storageConfig: any,
  cookie: string,
): Promise<void> {
  const storageId = String(storageConfig?.id || "")
  if (!storageId) return

  const previous = cookiePersistenceCache.get(storageId)
  const task = (previous || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const db = await getDb()
      const st = (db.storages || []).find(
        (candidate: any) => String(candidate.id) === storageId,
      )
      if (!st) return

      const stAddition =
        typeof st.addition === "string"
          ? JSON.parse(st.addition || "{}")
          : st.addition || {}
      stAddition.cookie = cookie
      st.addition = JSON.stringify(stAddition)
      if (String(storageConfig?.id) === storageId) {
        storageConfig.addition = st.addition
      }
      await saveDb(db)
    })

  cookiePersistenceCache.set(storageId, task)
  try {
    await task
  } finally {
    if (cookiePersistenceCache.get(storageId) === task) {
      cookiePersistenceCache.delete(storageId)
    }
  }
}

/**
 * One-shot flush of driver state that was refreshed during a request
 * (e.g. 189Cloud Set-Cookie). The driver keeps the live cookie in memory;
 * here it is persisted outside the request's critical path when a
 * `waitUntil` execution context is available.
 */
export async function flushPendingDriverState(
  driverName: string,
  storageConfig: any,
  driver: StorageDriver,
  requestContext?: StorageRequestContext,
): Promise<void> {
  if (!isCloud189Driver(driverName)) return

  const consumePendingCookie = (
    driver as StorageDriver & {
      consumePendingCookie?: () => string | null
    }
  ).consumePendingCookie
  const cookie = consumePendingCookie?.call(driver)
  if (!cookie) return

  const persistence = persistStorageCookie(storageConfig, cookie).catch((e) => {
    console.warn("[189Cloud] failed to persist cookie:", e)
  })
  await scheduleStoragePersistence(requestContext?.waitUntil, persistence)
}

export async function listItems(
  virtualPath: string,
): Promise<{ content: FileItem[]; provider: string }> {
  const resolved = await resolvePath(virtualPath)
  let items: FileItem[] = []
  let driverName = "Virtual"

  if (resolved.storage) {
    driverName = resolved.storage.driver
    const driver = await getDriver(driverName, resolved.storage)
    try {
      // Get raw items from driver
      items = await driver.list(virtualPath, resolved.physical!)
    } finally {
      await flushPendingDriverState(driverName, resolved.storage, driver)
    }
  } else if (!resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }

  // Merge virtual child storage mounts if we are listing a directory that contains mount points
  const db = await getDb()
  const activeStorages = (db.storages || []).filter((s: any) => !s.disabled)
  const cleanListedPath = resolved.cleanPath

  activeStorages.forEach((s: any) => {
    const mount =
      "/" + (s.mount_path || "").split("/").filter(Boolean).join("/")
    if (mount === cleanListedPath || mount === "/") return

    const prefix = cleanListedPath === "/" ? "/" : cleanListedPath + "/"
    if (mount.startsWith(prefix)) {
      const name = mount.slice(prefix.length).split("/").filter(Boolean)[0]
      if (name && !items.some((f) => f.name === name)) {
        items.push({
          name,
          size: 0,
          is_dir: true,
          modified: s.modified || new Date().toISOString(),
          sign: "",
          type: 1,
        })
      }
    }
  })

  // Ensure all items have calculated types
  items.forEach((item) => {
    if (!item.type) {
      item.type = calcFileType(item.name, item.is_dir)
    }
  })

  return { content: items, provider: driverName }
}

export async function getItem(
  virtualPath: string,
): Promise<{ item: FileItem; provider: string; rawUrl: string }> {
  const resolved = await resolvePath(virtualPath)
  if (resolved.isVirtual) {
    const name = resolved.cleanPath.split("/").filter(Boolean).pop() || "root"
    return {
      item: {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
      },
      provider: "Virtual",
      rawUrl: "",
    }
  }

  const driverName = resolved.storage ? resolved.storage.driver : "Local"
  const driver = await getDriver(driverName, resolved.storage)
  let item: FileItem
  try {
    item = await driver.get(virtualPath, resolved.physical!)
  } finally {
    await flushPendingDriverState(driverName, resolved.storage, driver)
  }
  if (!item.type) {
    item.type = calcFileType(item.name, item.is_dir)
  }
  return {
    item,
    provider: driverName,
    rawUrl: `/api/p${virtualPath.startsWith("/") ? "" : "/"}${virtualPath}`,
  }
}

export async function makeDirectory(virtualPath: string): Promise<void> {
  const resolved = await resolvePath(virtualPath)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.mkdir(virtualPath, resolved.physical!)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
    )
  }
}

export async function renameItem(
  virtualPath: string,
  newName: string,
): Promise<void> {
  const resolved = await resolvePath(virtualPath)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.rename(virtualPath, resolved.physical!, newName)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
    )
  }
}

export async function removeItems(dir: string, names: string[]): Promise<void> {
  for (const name of names) {
    const itemVirtual = `${dir}/${name}`
    const resolved = await resolvePath(itemVirtual)
    if (resolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }
    const driver = await getDriver(resolved.storage!.driver, resolved.storage)
    try {
      await driver.remove(itemVirtual, resolved.physical!, [name])
    } finally {
      await flushPendingDriverState(
        resolved.storage!.driver,
        resolved.storage,
        driver,
      )
    }
  }
}

export async function moveItems(
  srcDir: string,
  dstDir: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    const srcVirtual = `${srcDir}/${name}`
    const dstVirtual = `${dstDir}/${name}`
    const srcResolved = await resolvePath(srcVirtual)
    const dstResolved = await resolvePath(dstVirtual)
    if (srcResolved.isVirtual || dstResolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }

    const driver = await getDriver(
      srcResolved.storage!.driver,
      srcResolved.storage,
    )
    try {
      await driver.move(
        srcDir,
        dstDir,
        [name],
        srcResolved.physical!,
        dstResolved.physical!,
      )
    } finally {
      await flushPendingDriverState(
        srcResolved.storage!.driver,
        srcResolved.storage,
        driver,
      )
    }
  }
}

export async function copyItems(
  srcDir: string,
  dstDir: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    const srcVirtual = `${srcDir}/${name}`
    const dstVirtual = `${dstDir}/${name}`
    const srcResolved = await resolvePath(srcVirtual)
    const dstResolved = await resolvePath(dstVirtual)
    if (srcResolved.isVirtual || dstResolved.isVirtual) {
      throw new Error("failed get storage: storage not found")
    }

    const driver = await getDriver(
      srcResolved.storage!.driver,
      srcResolved.storage,
    )
    try {
      await driver.copy(
        srcDir,
        dstDir,
        [name],
        srcResolved.physical!,
        dstResolved.physical!,
      )
    } finally {
      await flushPendingDriverState(
        srcResolved.storage!.driver,
        srcResolved.storage,
        driver,
      )
    }
  }
}

export async function putItem(
  virtualPath: string,
  content: Buffer,
): Promise<void> {
  const resolved = await resolvePath(virtualPath)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  try {
    await driver.put(virtualPath, resolved.physical!, content)
  } finally {
    await flushPendingDriverState(
      resolved.storage!.driver,
      resolved.storage,
      driver,
    )
  }
}

/**
 * Driver-specific extended operations (e.g. Aliyun video preview).
 * Dispatches to the driver's optional `other(method, params)` hook.
 */
export async function otherOperation(
  virtualPath: string,
  method: string,
  params: any = {},
): Promise<any> {
  const resolved = await resolvePath(virtualPath)
  if (resolved.isVirtual) {
    throw new Error("failed get storage: storage not found")
  }
  const driver = await getDriver(resolved.storage!.driver, resolved.storage)
  const other = (driver as any).other
  if (typeof other !== "function") {
    throw new Error(
      `driver '${resolved.storage.driver}' does not support other method '${method}'`,
    )
  }
  return other.call(driver, method, {
    ...params,
    path: virtualPath,
    physicalPath: resolved.physical,
  })
}

function joinVirtualPath(dir: string, name: string): string {
  const base =
    "/" +
    String(dir || "/")
      .split("/")
      .filter(Boolean)
      .join("/")
  const cleanName = String(name || "")
    .split("/")
    .filter(Boolean)
    .join("/")
  if (!cleanName) return base || "/"
  return (base === "/" ? "/" : base + "/") + cleanName
}

/**
 * Batch rename objects under src_dir.
 * `renameObjects`: [{ src_name, new_name }] (frontend RenameObj shape).
 * Each item is attempted independently; failures are collected and reported
 * together so one bad item does not abort the whole batch.
 */
export async function batchRenameItems(
  srcDir: string,
  renameObjects: Array<{ src_name: string; new_name: string }>,
): Promise<{ renamed: number; errors: string[] }> {
  const objects = Array.isArray(renameObjects) ? renameObjects : []
  const errors: string[] = []
  let renamed = 0
  for (const obj of objects) {
    const srcName = obj?.src_name
    const newName = obj?.new_name
    if (!srcName || !newName) {
      errors.push(`Invalid rename object: ${JSON.stringify(obj)}`)
      continue
    }
    try {
      await renameItem(joinVirtualPath(srcDir, srcName), newName)
      renamed++
    } catch (e: any) {
      errors.push(`"${srcName}" -> "${newName}": ${e?.message || e}`)
    }
  }
  return { renamed, errors }
}

/**
 * Recursively remove empty directories under srcDir (bottom-up, so nested
 * empty folders collapse fully). The requested srcDir itself is kept, and
 * storage mount points are never removed. Bounded by MAX_VISITED / MAX_DEPTH
 * to avoid runaway traversal on large trees.
 */
export async function removeEmptyDirectories(srcDir: string): Promise<number> {
  const MAX_VISITED = 2000
  const MAX_DEPTH = 50
  const root =
    "/" +
      String(srcDir || "/")
        .split("/")
        .filter(Boolean)
        .join("/") || "/"
  let visited = 0
  let removed = 0

  async function isMountPoint(dir: string): Promise<boolean> {
    try {
      const db = await getDb()
      const cleanDir =
        "/" + String(dir).split("/").filter(Boolean).join("/") || "/"
      return (db.storages || []).some((s: any) => {
        if (s.disabled) return false
        const mount =
          "/" + (s.mount_path || "").split("/").filter(Boolean).join("/")
        return mount === cleanDir
      })
    } catch {
      return true // be conservative: treat as mount when db is unavailable
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (visited >= MAX_VISITED || depth > MAX_DEPTH) return
    visited++

    let items: any[]
    try {
      const res = await listItems(dir)
      items = res.content || []
    } catch {
      return // unlistable directory — treat as non-empty
    }

    // Recurse first (bottom-up)
    for (const item of items) {
      if (item.is_dir) {
        await walk(joinVirtualPath(dir, item.name), depth + 1)
      }
    }

    // Remove this directory only if it is a descendant of the requested root
    if (dir === root) return
    if (await isMountPoint(dir)) return

    try {
      const res = await listItems(dir)
      if ((res.content || []).length === 0) {
        const segments = dir.split("/").filter(Boolean)
        const name = segments.pop() || ""
        if (!name) return
        const parent = "/" + segments.join("/") || "/"
        await removeItems(parent, [name])
        removed++
      }
    } catch {
      // skip directories we cannot re-list
    }
  }

  await walk(root, 0)
  return removed
}
