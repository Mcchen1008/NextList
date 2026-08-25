// PikPakShare HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/pikpak_share
//
// Browses a PikPak share link (share_id + optional share password) without an
// account. Auth flow (Go util.go Common):
//   1. device_id = md5(share_id + share_pwd + time) unless configured
//   2. captcha token via POST https://user.mypikpak.net/v1/shield/captcha/init
//      (captcha_sign = chained md5 of clientID+clientVersion+packageName+
//       deviceID+timestamp over the platform algorithm list)
//   3. pass_code_token via GET https://api-drive.mypikpak.net/drive/v1/share
//      (only when the share is password protected)
//
// API base / signing logic follows the existing NextList pikpak driver; the
// share endpoints (/drive/v1/share*) differ from the account endpoints.
import { md5, sha1 } from "../../pkg/crypto"
import {
  PikPakShareAddition,
  PikPakShareCaptchaTokenResp,
  PikPakShareErrResp,
  PikPakShareFile,
  PikPakShareResp,
} from "./types"

const AndroidAlgorithms = [
  "SOP04dGzk0TNO7t7t9ekDbAmx+eq0OI1ovEx",
  "nVBjhYiND4hZ2NCGyV5beamIr7k6ifAsAbl",
  "Ddjpt5B/Cit6EDq2a6cXgxY9lkEIOw4yC1GDF28KrA",
  "VVCogcmSNIVvgV6U+AochorydiSymi68YVNGiz",
  "u5ujk5sM62gpJOsB/1Gu/zsfgfZO",
  "dXYIiBOAHZgzSruaQ2Nhrqc2im",
  "z5jUTBSIpBN9g4qSJGlidNAutX6",
  "KJE2oveZ34du/g1tiimm",
]

const WebAlgorithms = [
  "C9qPpZLN8ucRTaTiUMWYS9cQvWOE",
  "+r6CQVxjzJV6LCV",
  "F",
  "pFJRC",
  "9WXYIDGrwTCz2OiVlgZa90qpECPD6olt",
  "/750aCr4lm/Sly/c",
  "RB+DT/gZCrbV",
  "",
  "CyLsf7hdkIRxRm215hl",
  "7xHvLi2tOYP0Y92b",
  "ZGTXXxu8E/MIWaEDB+Sm/",
  "1UI3",
  "E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO",
  "ihtqpG6FMt65+Xk+tWUH2",
  "NhXXU9rg4XXdzo7u5o",
]

const PCAlgorithms = [
  "KHBJ07an7ROXDoK7Db",
  "G6n399rSWkl7WcQmw5rpQInurc1DkLmLJqE",
  "JZD1A3M4x+jBFN62hkr7VDhkkZxb9g3rWqRZqFAAb",
  "fQnw/AmSlbbI91Ik15gpddGgyU7U",
  "/Dv9JdPYSj3sHiWjouR95NTQff",
  "yGx2zuTjbWENZqecNI+edrQgqmZKP",
  "ljrbSzdHLwbqcRn",
  "lSHAsqCkGDGxQqqwrVu",
  "TsWXI81fD1",
  "vk7hBjawK/rOSrSWajtbMk95nfgf3",
]

const AndroidClientID = "YNxT9w7GMdWvEOKa"
const AndroidClientVersion = "1.53.2"
const AndroidPackageName = "com.pikcloud.pikpak"
const AndroidSdkVersion = "2.0.6.206003"

const WebClientID = "YUMx5nI8ZU8Ap8pm"
const WebClientVersion = "2.0.0"
const WebPackageName = "mypikpak.com"

const PCClientID = "YvtoWO6GNHiuCl7x"
const PCClientVersion = "undefined" // 2.6.11.4955
const PCPackageName = "mypikpak.com"

const WebUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36"
const PCUserAgent =
  "MainWindow Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) PikPak/2.6.11.4955 Chrome/100.0.4896.160 Electron/18.3.15 Safari/537.36"

/** Go GetAction(): "METHOD:" + path part of the url (query/fragment stripped) */
export function getAction(method: string, url: string): string {
  const m = url.match(/:\/\/[^/]+((\/[^/\s?#]+)*)/)
  return method + ":" + (m ? m[1] : "")
}

/** Go generateDeviceSign(): div101.{deviceID}{md5(sha1(deviceID+pkg+"1"+"appkey"))} */
async function generateDeviceSign(
  deviceID: string,
  packageName: string,
): Promise<string> {
  const signatureBase = `${deviceID}${packageName}1appkey`
  const sha1String = await sha1(signatureBase)
  const md5String = md5(sha1String)
  return `div101.${deviceID}${md5String}`
}

/** Go BuildCustomUserAgent() — android platform UA */
async function buildCustomUserAgent(
  deviceID: string,
  clientID: string,
  appName: string,
  sdkVersion: string,
  clientVersion: string,
  packageName: string,
  userID: string,
): Promise<string> {
  const deviceSign = await generateDeviceSign(deviceID, packageName)
  return (
    `ANDROID-${appName}/${clientVersion} ` +
    `protocolVersion/200 ` +
    `accesstype/ ` +
    `clientid/${clientID} ` +
    `clientversion/${clientVersion} ` +
    `action_type/ ` +
    `networktype/WIFI ` +
    `sessionid/ ` +
    `deviceid/${deviceID} ` +
    `providername/NONE ` +
    `devicesign/${deviceSign} ` +
    `refresh_token/ ` +
    `sdkversion/${sdkVersion} ` +
    `datetime/${Date.now()} ` +
    `usrno/${userID} ` +
    `appname/android-${appName} ` +
    `session_origin/ ` +
    `grant_type/ ` +
    `appid/ ` +
    `clientip/ ` +
    `devicename/Xiaomi_M2004j7ac ` +
    `osversion/13 ` +
    `platformversion/10 ` +
    `accessmode/ ` +
    `devicemodel/M2004J7AC `
  )
}

function errRespError(e: PikPakShareErrResp): string {
  return `ErrorCode: ${e.error_code ?? 0} ,Error: ${e.error || ""} ,ErrorDescription: ${e.error_description || ""}`
}

export class PikPakShareClient {
  private addition: PikPakShareAddition
  /** Go Common.CaptchaToken (runtime only) */
  private captchaToken = ""
  /** Go PikPakShare.PassCodeToken (runtime only) */
  private passCodeToken = ""
  private deviceId = ""
  private clientID = ""
  private clientVersion = ""
  private packageName = ""
  private algorithms: string[] = []
  private userAgent = ""
  /** Optional persistence hook — mirrors Go op.MustSaveDriverStorage(d) for Addition.DeviceID */
  private onDeviceId?: (deviceId: string) => void

  constructor(
    addition: PikPakShareAddition,
    onDeviceId?: (deviceId: string) => void,
  ) {
    this.addition = addition
    this.onDeviceId = onDeviceId
  }

  public getRootFolderId(): string {
    // Go Config().DefaultRoot is empty — share root is the empty parent_id
    return this.addition.root_folder_id || ""
  }

  /** Go Init() */
  public async init(): Promise<void> {
    if (this.addition.device_id) {
      this.deviceId = this.addition.device_id
    } else {
      // utils.GetMD5EncodeStr(shareId + sharePwd + time.Now().String())
      this.deviceId = md5(
        `${this.addition.share_id}${this.addition.share_pwd || ""}${new Date().toString()}`,
      )
      this.addition.device_id = this.deviceId
      this.onDeviceId?.(this.deviceId)
    }

    await this.setupPlatform()

    // Get captcha token for the share API (Go uses the batch_file_info action)
    await this.refreshCaptchaToken(
      getAction(
        "GET",
        "https://api-drive.mypikpak.net/drive/v1/share:batch_file_info",
      ),
      "",
    )

    if (this.addition.share_pwd) {
      await this.getSharePassToken()
    }
  }

  private async setupPlatform(): Promise<void> {
    const platform = this.addition.platform || "web"
    if (platform === "android") {
      this.clientID = AndroidClientID
      this.clientVersion = AndroidClientVersion
      this.packageName = AndroidPackageName
      this.algorithms = AndroidAlgorithms
      this.userAgent = await buildCustomUserAgent(
        this.deviceId,
        AndroidClientID,
        AndroidPackageName,
        AndroidSdkVersion,
        AndroidClientVersion,
        AndroidPackageName,
        "",
      )
    } else if (platform === "pc") {
      this.clientID = PCClientID
      this.clientVersion = PCClientVersion
      this.packageName = PCPackageName
      this.algorithms = PCAlgorithms
      this.userAgent = PCUserAgent
    } else {
      this.clientID = WebClientID
      this.clientVersion = WebClientVersion
      this.packageName = WebPackageName
      this.algorithms = WebAlgorithms
      this.userAgent = WebUserAgent
    }
  }

  /** Go Common.GetCaptchaSign() */
  private getCaptchaSign(): { timestamp: string; captcha_sign: string } {
    const timestamp = String(Date.now())
    let str =
      this.clientID +
      this.clientVersion +
      this.packageName +
      this.deviceId +
      timestamp
    for (const algorithm of this.algorithms) {
      str = md5(str + algorithm)
    }
    return { timestamp, captcha_sign: "1." + str }
  }

  /** Go RefreshCaptchaToken(action, userID) */
  public async refreshCaptchaToken(
    action: string,
    userID: string,
  ): Promise<void> {
    const metas: Record<string, string> = {
      client_version: this.clientVersion,
      package_name: this.packageName,
      user_id: userID,
    }
    const { timestamp, captcha_sign } = this.getCaptchaSign()
    metas["timestamp"] = timestamp
    metas["captcha_sign"] = captcha_sign
    await this.refreshCaptchaTokenReq(action, metas)
  }

  /** Go refreshCaptchaToken(action, metas) */
  private async refreshCaptchaTokenReq(
    action: string,
    metas: Record<string, string>,
  ): Promise<void> {
    const body = {
      action,
      captcha_token: this.captchaToken,
      client_id: this.clientID,
      device_id: this.deviceId,
      meta: metas,
      redirect_uri: "",
    }
    // retry=false: a failing captcha/init must not re-enter the refresh path
    // (the Go code would recurse; we surface the error instead)
    const resp = await this.request<PikPakShareCaptchaTokenResp>(
      "https://user.mypikpak.net/v1/shield/captcha/init",
      "POST",
      { body },
      false,
    )
    this.captchaToken = resp.captcha_token || ""
  }

  /**
   * Go request(): error_code
   *   0 → ok; 9 → captcha token expired (refresh + retry);
   *   10 → operate too frequently; otherwise error
   */
  async request<T = any>(
    url: string,
    method: "GET" | "POST",
    opts?: { query?: Record<string, string>; body?: unknown },
    retry = true,
  ): Promise<T> {
    const u = new URL(url)
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        u.searchParams.set(k, v)
      }
    }
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      "X-Client-ID": this.clientID,
      "X-Device-ID": this.deviceId,
      "X-Captcha-Token": this.captchaToken,
      Accept: "application/json",
    }
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(30_000),
    }
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(opts.body)
    }
    const res = await fetch(u.toString(), init)
    const text = await res.text()
    let data: any = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON */
      }
    }
    const e = data as PikPakShareErrResp
    if (e.error_code) {
      if (e.error_code === 9 && retry) {
        // captcha token expired — refresh and retry once
        await this.refreshCaptchaToken(getAction(method, url), "")
        return this.request<T>(url, method, opts, false)
      }
      if (e.error_code === 10) {
        // 操作频繁 (operate too frequently)
        throw new Error(
          `[PikPakShare] ${e.error_description || errRespError(e)}`,
        )
      }
      throw new Error(`[PikPakShare] ${errRespError(e)}`)
    }
    return data as T
  }

  /** Go getSharePassToken(): exchange share password for a pass_code_token */
  public async getSharePassToken(): Promise<void> {
    const resp = await this.request<PikPakShareResp>(
      "https://api-drive.mypikpak.net/drive/v1/share",
      "GET",
      {
        query: {
          share_id: this.addition.share_id,
          pass_code: this.addition.share_pwd || "",
          thumbnail_size: "SIZE_LARGE",
          limit: "100",
        },
      },
    )
    this.passCodeToken = resp.pass_code_token || ""
  }

  /** Go getFiles(): paginate /drive/v1/share/detail under a parent id */
  public async getFiles(
    parentId: string,
    retried = false,
  ): Promise<PikPakShareFile[]> {
    const res: PikPakShareFile[] = []
    let pageToken = "first"
    while (pageToken) {
      if (pageToken === "first") pageToken = ""
      const resp = await this.request<PikPakShareResp>(
        "https://api-drive.mypikpak.net/drive/v1/share/detail",
        "GET",
        {
          query: {
            parent_id: parentId,
            share_id: this.addition.share_id,
            thumbnail_size: "SIZE_LARGE",
            with_audit: "true",
            limit: "100",
            filters:
              '{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}',
            page_token: pageToken,
            pass_code_token: this.passCodeToken,
          },
        },
      )
      if (resp.share_status && resp.share_status !== "OK") {
        if (
          (resp.share_status === "PASS_CODE_EMPTY" ||
            resp.share_status === "PASS_CODE_ERROR") &&
          !retried
        ) {
          await this.getSharePassToken()
          return this.getFiles(parentId, true)
        }
        throw new Error(
          `[PikPakShare] ${resp.share_status_text || resp.share_status}`,
        )
      }
      pageToken = resp.next_page_token || ""
      res.push(...(resp.files || []))
      if (res.length > 100000) break // safety cap
    }
    return res
  }

  /** Go Link(): web_content_link, falling back to transcoded media links */
  public async getShareFileLink(fileId: string): Promise<string> {
    const resp = await this.request<PikPakShareResp>(
      "https://api-drive.mypikpak.net/drive/v1/share/file_info",
      "GET",
      {
        query: {
          share_id: this.addition.share_id,
          file_id: fileId,
          pass_code_token: this.passCodeToken,
        },
      },
    )
    const fileInfo = resp.file_info
    let downloadUrl = (fileInfo && fileInfo.web_content_link) || ""
    if (
      !downloadUrl &&
      fileInfo &&
      fileInfo.medias &&
      fileInfo.medias.length > 0
    ) {
      // 使用转码后的链接 (use transcoded link)
      if (this.addition.use_transcoding_address && fileInfo.medias.length > 1) {
        downloadUrl = fileInfo.medias[1].link?.url || ""
      } else {
        downloadUrl = fileInfo.medias[0].link?.url || ""
      }
    }
    return downloadUrl
  }
}
