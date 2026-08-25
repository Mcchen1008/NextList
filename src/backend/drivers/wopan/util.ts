// WoPan (联通云盘) HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/wopan
// Wire protocol 1:1 with github.com/OpenListTeam/wopan-sdk-go v0.1.5
// (request.go / header.go / crypto.go / api-*.go), using pure fetch +
// Web Crypto AES-CBC and the pure-JS md5 from pkg/crypto.
import { md5 } from "../../pkg/crypto"
import {
  AppQueryUserData,
  AppRefreshTokenData,
  ClassifyRuleData,
  CreateDirectoryData,
  FamilyUserCurrentEncodeData,
  GetDownloadUrlV2Data,
  QueryAllFilesData,
  WopanAddition,
  WopanFile,
  WopanResp,
} from "./types"

// ─── Constants (wopan-sdk-go consts.go) ──────────────────────────────────────

const BASE_URL = "https://panservice.mail.wo.cn"
const CLIENT_ID = "1001000021"
const CLIENT_SECRET = "XFmi9GS2hzk98jGX" // 16-byte AES-128 key
const IV = "wNSOYIB1k1DjY5lA"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.37"

export const SPACE_TYPE_PERSONAL = "0"
export const SPACE_TYPE_FAMILY = "1"

const CHANNEL_API_USER = "api-user"
const CHANNEL_WOHOME = "wohome"

// api-user / wohome method keys (consts.go)
const KEY_APP_QUERY_USER = "AppQueryUser"
const KEY_APP_REFRESH_TOKEN = "AppRefreshToken"
const KEY_FAMILY_USER_CURRENT = "FamilyUserCurrentEncode"
const KEY_QUERY_ALL_FILES = "QueryAllFiles"
const KEY_GET_DOWNLOAD_URL_V2 = "GetDownloadUrlV2"
const KEY_CREATE_DIRECTORY = "CreateDirectory"
const KEY_RENAME_FILE_OR_DIRECTORY = "RenameFileOrDirectory"
const KEY_MOVE_FILE = "MoveFile"
const KEY_COPY_FILE = "CopyFile"
const KEY_DELETE_FILE = "DeleteFile"
const KEY_CLASSIFY_RULE = "ClassifyRule"

// ─── Base64 helpers ──────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ─── AES-128-CBC (crypto.go: key = client secret for api-user, else the
// first 16 chars of the access token; fixed IV; PKCS7 via Web Crypto) ────────

async function aesCbcEncrypt(plain: string, key: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key) as any,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  )
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: enc.encode(IV) as any },
    cryptoKey,
    enc.encode(plain) as any,
  )
  return bytesToBase64(new Uint8Array(cipher))
}

async function aesCbcDecrypt(b64: string, key: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key) as any,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  )
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: enc.encode(IV) as any },
    cryptoKey,
    base64ToBytes(b64) as any,
  )
  return new TextDecoder().decode(plain)
}

/** Go path.Ext → ".mp4"; returns "" when there is no extension. */
function pathExt(name: string): string {
  const i = name.lastIndexOf(".")
  if (i === -1) return ""
  return name.slice(i)
}

/**
 * Parse WoPan createTime ("yyyyMMddHHmmss" in UTC+8, e.g. "20230607214351")
 * into an ISO string. Falls back to the current time when unparsable
 * (Go fails the whole listing instead — softened here).
 */
export function parseWopanTime(str?: string): string {
  if (str && str.length === 14 && /^\d{14}$/.test(str)) {
    const ms =
      Date.UTC(
        +str.slice(0, 4),
        +str.slice(4, 6) - 1,
        +str.slice(6, 8),
        +str.slice(8, 10),
        +str.slice(10, 12),
        +str.slice(12, 14),
      ) -
      8 * 3600 * 1000 // FixedZone("UTC+8", 8*60*60)
    if (!isNaN(ms)) return new Date(ms).toISOString()
  }
  return new Date().toISOString()
}

// ─── WoPanClient ─────────────────────────────────────────────────────────────

export class WopanClient {
  readonly addition: WopanAddition
  private accessToken = ""
  private refreshTokenStr = ""
  private phone = ""
  private classifyRuleData: ClassifyRuleData | null = null
  defaultFamilyID = ""

  /** Called whenever tokens are refreshed (mirrors wopan-sdk OnRefreshToken +
   * op.MustSaveDriverStorage in the Go driver). */
  private onTokenRefresh?: (accessToken: string, refreshToken: string) => void

  constructor(
    addition: WopanAddition,
    onTokenRefresh?: (accessToken: string, refreshToken: string) => void,
  ) {
    this.addition = addition
    this.onTokenRefresh = onTokenRefresh
    this.accessToken = (addition.access_token || "").trim()
    this.refreshTokenStr = (addition.refresh_token || "").trim()
  }

  public getRootFolderId(): string {
    return (this.addition.root_folder_id || "").trim() || "0"
  }

  public getSpaceType(): string {
    return (this.addition.family_id || "").trim() !== ""
      ? SPACE_TYPE_FAMILY
      : SPACE_TYPE_PERSONAL
  }

  /** Raw family id (may be empty → personal space). */
  public getFamilyId(): string {
    return (this.addition.family_id || "").trim()
  }

  /** util.go getSortRule(): server-side sort rule id. */
  public getSortRule(): number {
    switch (this.addition.sort_rule) {
      case "name_desc":
        return 2
      case "size_asc":
        return 3
      case "size_desc":
        return 4
      case "time_asc":
        return 5
      case "time_desc":
        return 6
      case "name_asc":
      default:
        return 1
    }
  }

  /** AES key for the given channel (crypto.go EncryptBytes). */
  private channelKey(channel: string): string {
    if (channel === CHANNEL_API_USER) return CLIENT_SECRET
    return this.accessToken.slice(0, 16)
  }

  /**
   * Core dispatcher call (request.go).
   * POST {BASE_URL}/{channel}/dispatcher with
   *   { header: {key, resTime, reqSeq, channel, sign, version},
   *     body: {...other, param: <AES-CBC(json(param))> } }
   * RSP_CODE "9999" on non-auth channels triggers one token refresh + retry.
   */
  private async request<T>(
    channel: string,
    key: string,
    param: Record<string, any> | null,
    other: Record<string, any>,
    retry = true,
  ): Promise<T | undefined> {
    // header.go calHeader()
    const resTime = Date.now()
    const reqSeq = 100000 + Math.floor(Math.random() * 8999)
    const version = ""
    const sign = md5(`${key}${resTime}${reqSeq}${channel}${version}`)

    const body: Record<string, any> = { ...other }
    if (param !== null) {
      const ck = this.channelKey(channel)
      if (!ck || ck.length < 16) {
        throw new Error("[WoPan] invalid access token (need at least 16 chars)")
      }
      body.param = await aesCbcEncrypt(JSON.stringify(param), ck)
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Origin: "https://pan.wo.cn",
      Referer: "https://pan.wo.cn/",
      "User-Agent": UA,
    }
    if (this.accessToken) {
      headers["Accesstoken"] = this.accessToken
    }

    let res: Response
    try {
      res = await fetch(`${BASE_URL}/${channel}/dispatcher`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          header: {
            key,
            resTime,
            reqSeq,
            channel,
            sign,
            version,
          },
          body,
        }),
      })
    } catch (e: any) {
      throw new Error(`[WoPan] request failed: ${e?.message || e}`)
    }
    if (res.status < 200 || res.status >= 300) {
      const text = (await res.text().catch(() => "")).trim()
      throw new Error(
        `[WoPan] request failed with status: ${res.status} ${text.slice(0, 200)}`,
      )
    }
    const resp = (await res.json().catch(() => ({}))) as WopanResp

    if (resp.STATUS !== "200") {
      throw new Error(
        `[WoPan] request failed with status: ${resp.STATUS || ""}, msg: ${resp.MSG || ""}`,
      )
    }
    const rspCode = resp.RSP?.RSP_CODE || ""
    if (rspCode !== "0000") {
      if (channel !== CHANNEL_API_USER && retry && rspCode === "9999") {
        await this.refreshToken()
        return this.request<T>(channel, key, param, other, false)
      }
      throw new Error(
        `[WoPan] request failed with rsp_code: ${rspCode}, rep_desc: ${resp.RSP?.RSP_DESC || ""}`,
      )
    }

    let data = resp.RSP?.DATA
    if (typeof data === "string") {
      // DATA is a quoted AES-CBC payload (request.go Decrypt branch)
      const ck = this.channelKey(channel)
      if (!ck || ck.length < 16) {
        throw new Error("[WoPan] invalid access token (need at least 16 chars)")
      }
      try {
        data = JSON.parse(await aesCbcDecrypt(data, ck))
      } catch (e: any) {
        throw new Error(
          `[WoPan] failed to decrypt response: ${e?.message || e}`,
        )
      }
    }
    return data as T
  }

  // ─── api-user ─────────────────────────────────────────────────────────────

  /** api-user AppQueryUser (api-user.go) */
  public async appQueryUser(): Promise<AppQueryUserData> {
    const resp = await this.request<AppQueryUserData>(
      CHANNEL_API_USER,
      KEY_APP_QUERY_USER,
      { accessToken: this.accessToken },
      { clientId: CLIENT_ID, secret: true },
    )
    return resp || {}
  }

  /** api-user AppRefreshToken (operation.go RefreshToken) */
  public async refreshToken(): Promise<void> {
    if (!this.refreshTokenStr) {
      throw new Error("[WoPan] refresh token is empty")
    }
    const resp = await this.request<AppRefreshTokenData>(
      CHANNEL_API_USER,
      KEY_APP_REFRESH_TOKEN,
      { refreshToken: this.refreshTokenStr, clientSecret: CLIENT_SECRET },
      { clientId: CLIENT_ID, secret: true },
    )
    const accessToken = (resp?.access_token || "").trim()
    const refreshTokenNew = (resp?.refresh_token || "").trim()
    if (!accessToken || !refreshTokenNew) {
      throw new Error("[WoPan] refresh token response missing tokens")
    }
    this.accessToken = accessToken
    this.refreshTokenStr = refreshTokenNew
    this.addition.access_token = accessToken
    this.addition.refresh_token = refreshTokenNew
    this.onTokenRefresh?.(accessToken, refreshTokenNew)
  }

  private async initPhone(): Promise<void> {
    if (this.phone) return
    const resp = await this.appQueryUser()
    this.phone = resp.userId || ""
  }

  // ─── wohome ───────────────────────────────────────────────────────────────

  /** wohome FamilyUserCurrentEncode (api-wohome.go) */
  public async familyUserCurrentEncode(): Promise<FamilyUserCurrentEncodeData> {
    const resp = await this.request<FamilyUserCurrentEncodeData>(
      CHANNEL_WOHOME,
      KEY_FAMILY_USER_CURRENT,
      { clientId: CLIENT_ID },
      { secret: true },
    )
    return resp || {}
  }

  /** wohome QueryAllFiles — one page (api-fs.go) */
  public async queryAllFiles(
    spaceType: string,
    parentDirectoryId: string,
    pageNum: number,
    pageSize: number,
    sortRule: number,
    familyId: string,
  ): Promise<QueryAllFilesData> {
    const param: Record<string, any> = {
      spaceType,
      parentDirectoryId,
      pageNum,
      pageSize,
      sortRule,
      clientId: CLIENT_ID,
    }
    if (spaceType === SPACE_TYPE_FAMILY) {
      param.familyId = familyId
    }
    const resp = await this.request<QueryAllFilesData>(
      CHANNEL_WOHOME,
      KEY_QUERY_ALL_FILES,
      param,
      { secret: true },
    )
    return resp || {}
  }

  /** All pages of a directory (Go List pagination loop). */
  public async getAllFiles(parentDirectoryId: string): Promise<WopanFile[]> {
    const spaceType = this.getSpaceType()
    const sortRule = this.getSortRule()
    const familyId = this.getFamilyId()
    const res: WopanFile[] = []
    const pageSize = 100
    let pageNum = 0
    for (;;) {
      const data = await this.queryAllFiles(
        spaceType,
        parentDirectoryId,
        pageNum,
        pageSize,
        sortRule,
        familyId,
      )
      const files = data.files || []
      res.push(...files)
      if (files.length < pageSize) break
      pageNum++
      if (pageNum > 1000) break // safety cap
    }
    return res
  }

  /** wohome GetDownloadUrlV2 (api-fs.go) */
  public async getDownloadUrlV2(fidList: string[]): Promise<string> {
    const resp = await this.request<GetDownloadUrlV2Data>(
      CHANNEL_WOHOME,
      KEY_GET_DOWNLOAD_URL_V2,
      { type: "1", fidList, clientId: CLIENT_ID },
      { secret: true },
    )
    const url = resp?.list?.[0]?.downloadUrl || ""
    if (!url) {
      throw new Error("[WoPan] no download url returned")
    }
    return url
  }

  /** wohome CreateDirectory (api-fs.go) */
  public async createDirectory(
    spaceType: string,
    parentDirectoryId: string,
    directoryName: string,
    familyId: string,
  ): Promise<CreateDirectoryData> {
    const resp = await this.request<CreateDirectoryData>(
      CHANNEL_WOHOME,
      KEY_CREATE_DIRECTORY,
      {
        spaceType,
        familyId,
        parentDirectoryId,
        directoryName,
        clientId: CLIENT_ID,
      },
      { secret: true },
    )
    return resp || {}
  }

  /**
   * wohome RenameFileOrDirectory (api-fs.go).
   * @param _type 1: file, 0: directory
   */
  public async renameFileOrDirectory(
    spaceType: string,
    _type: number,
    id: string,
    name: string,
    familyId: string,
  ): Promise<void> {
    let fileType = "0"
    if (_type !== 0) {
      fileType = await this.getFileType(name)
    }
    const param: Record<string, any> = {
      spaceType,
      type: _type,
      fileType,
      id,
      name,
      clientId: CLIENT_ID,
    }
    if (spaceType === SPACE_TYPE_FAMILY) {
      param.familyId = familyId
    }
    await this.request(CHANNEL_WOHOME, KEY_RENAME_FILE_OR_DIRECTORY, param, {
      secret: true,
    })
  }

  /** wohome MoveFile (api-fs.go) */
  public async moveFile(
    dirList: string[],
    fileList: string[],
    targetDirId: string,
    sourceType: string,
    targetType: string,
    fromFamilyId: string,
    targetFamilyId: string,
  ): Promise<void> {
    const param: Record<string, any> = {
      targetDirId,
      sourceType,
      targetType,
      dirList,
      fileList,
      secret: false,
      clientId: CLIENT_ID,
    }
    if (sourceType === SPACE_TYPE_FAMILY) {
      param.fromFamilyId = fromFamilyId
    }
    if (targetType === SPACE_TYPE_FAMILY) {
      param.familyId = targetFamilyId
    }
    await this.request(CHANNEL_WOHOME, KEY_MOVE_FILE, param, { secret: true })
  }

  /** wohome CopyFile (api-fs.go) */
  public async copyFile(
    dirList: string[],
    fileList: string[],
    targetDirId: string,
    sourceType: string,
    targetType: string,
    fromFamilyId: string,
    targetFamilyId: string,
  ): Promise<void> {
    const param: Record<string, any> = {
      targetDirId,
      sourceType,
      targetType,
      dirList,
      fileList,
      secret: false,
      clientId: CLIENT_ID,
    }
    if (sourceType === SPACE_TYPE_FAMILY) {
      param.fromFamilyId = fromFamilyId
    }
    if (targetType === SPACE_TYPE_FAMILY) {
      param.familyId = targetFamilyId
    }
    await this.request(CHANNEL_WOHOME, KEY_COPY_FILE, param, { secret: true })
  }

  /** wohome DeleteFile (api-fs.go) */
  public async deleteFile(
    spaceType: string,
    dirList: string[],
    fileList: string[],
  ): Promise<void> {
    await this.request(
      CHANNEL_WOHOME,
      KEY_DELETE_FILE,
      {
        spaceType,
        vipLevel: "0",
        dirList,
        fileList,
        clientId: CLIENT_ID,
      },
      { secret: true },
    )
  }

  /** wohome ClassifyRule (api-wohome.go) — file extension → type map */
  public async classifyRule(): Promise<ClassifyRuleData> {
    // Go passes an empty (non-nil) Json{} param → it IS encrypted
    const resp = await this.request<ClassifyRuleData>(
      CHANNEL_WOHOME,
      KEY_CLASSIFY_RULE,
      {},
      { key: true },
    )
    return resp || {}
  }

  private async initClassifyRule(): Promise<void> {
    if (this.classifyRuleData) return
    try {
      this.classifyRuleData = await this.classifyRule()
    } catch (e: any) {
      // Go GetFileType falls back to "5" when the rule is unavailable
      console.warn("[WoPan] failed to load classify rule:", e?.message)
    }
  }

  /** client.go GetFileType: extension → server file type, "5" fallback. */
  public async getFileType(filename: string): Promise<string> {
    const ext = pathExt(filename)
    if (!ext) return "5"
    await this.initClassifyRule()
    if (!this.classifyRuleData) return "5"
    const extNoDot = ext.slice(1)
    const ft =
      this.classifyRuleData.fileTypes?.[extNoDot] ||
      this.classifyRuleData.fileTypes?.[extNoDot.toLowerCase()]
    return ft?.type || "5"
  }

  /**
   * Go Init(): resolve default family id + InitData (token refresh, phone,
   * classify rule). The Go flow calls FamilyUserCurrentEncode before any
   * refresh — it relies on a persisted access_token; here we refresh first
   * so refresh-token-only configurations work.
   * (InitZoneURL is upload-only and skipped since put() is not supported.)
   */
  public async init(): Promise<void> {
    if (!this.accessToken && this.refreshTokenStr) {
      await this.refreshToken()
    }
    if (this.accessToken.length < 16) {
      throw new Error(
        "[WoPan] access token is required (provide access_token or a valid refresh_token)",
      )
    }

    const fml = await this.familyUserCurrentEncode()
    this.defaultFamilyID = String(fml.defaultHomeId ?? "")

    // InitData(): phone + classify rule (zone URL is upload-only, skipped)
    await this.initPhone()
    await this.initClassifyRule()
  }
}
