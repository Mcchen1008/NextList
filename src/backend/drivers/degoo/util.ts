// Degoo HTTP client (REST login + GraphQL API)
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/degoo
// API research credit: https://github.com/bernd-wechner/Degoo
import {
  DegooAddition,
  DegooAccessTokenRequest,
  DegooAccessTokenResponse,
  DegooFileItem,
  DegooGetChildren5Data,
  DegooGetOverlay4Data,
  DegooGetUserInfo3Data,
  DegooGraphqlResponse,
  DegooJWTPayload,
  DegooLoginRequest,
  DegooLoginResponse,
} from "./types"

// API endpoints (Go util.go constants)
const LOGIN_URL = "https://rest-api.degoo.com/login"
const ACCESS_TOKEN_URL = "https://rest-api.degoo.com/access-token/v2"
const API_URL = "https://production-appsync.degoo.com/graphql"

// API configuration
const API_KEY = "da2-vs6twz5vnjdavpqndtbzg3prra"
export const FOLDER_CHECKSUM = "CgAQAg"

// Token management: refresh when expiring within 5 minutes
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000

// Rate limiting: minimum interval between API requests (Go: global)
const MIN_REQUEST_INTERVAL_MS = 1000

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Global rate limiting (Go: package-level lastRequestTime + mutex) ---

let lastRequestTime = 0
let rateQueue: Promise<void> = Promise.resolve()

/** Serialize calls so that at least 1s elapses between API requests */
function applyRateLimit(): Promise<void> {
  const run = async (): Promise<void> => {
    if (lastRequestTime > 0) {
      const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestTime)
      if (wait > 0) await sleep(wait)
    }
    lastRequestTime = Date.now()
  }
  rateQueue = rateQueue.then(run, run)
  return rateQueue
}

/** GraphQL error carrying its errorType (used for Unauthorized retry) */
class DegooGraphQLError extends Error {
  errorType?: string
  constructor(message: string, errorType?: string) {
    super(message)
    this.errorType = errorType
  }
}

/** Go extractJWTPayload: decode the payload segment of a JWT */
export function extractJWTPayload(token: string): DegooJWTPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    while (b64.length % 4) b64 += "="
    return JSON.parse(atob(b64)) as DegooJWTPayload
  } catch {
    return null
  }
}

/**
 * Go humanReadableTimes: CreationTime is RFC3339, LastModificationTime /
 * LastUploadTime are unix-millisecond strings.
 */
export function humanReadableTimes(
  creation: string,
  modification: string,
  upload: string,
): { created: string; modified: string } {
  let created = new Date().toISOString()
  if (creation) {
    const d = new Date(creation)
    if (!isNaN(d.getTime())) created = d.toISOString()
  }
  // Go uses only LastModificationTime for Modified (zero time when empty);
  // here we fall back to upload time, then creation time, then now.
  let modified = ""
  const millis = modification || upload
  if (millis) {
    const n = parseInt(millis, 10)
    if (!isNaN(n)) modified = new Date(n).toISOString()
  }
  if (!modified) modified = created
  return { created, modified }
}

export interface DegooTokenState {
  access_token: string
  refresh_token: string
}

export interface DegooPersistState extends DegooTokenState {
  root_folder_id?: string
}

export class DegooClient {
  private addition: DegooAddition
  private accessToken = ""
  private refreshToken = ""
  private rootFolderId: string
  /** Persists token / root id updates back to storage (Go op.MustSaveDriverStorage) */
  private onStateUpdate?: (state: DegooPersistState) => void

  constructor(
    addition: DegooAddition,
    onStateUpdate?: (state: DegooPersistState) => void,
  ) {
    this.addition = addition
    this.accessToken = addition.access_token || ""
    this.refreshToken = addition.refresh_token || ""
    this.rootFolderId = (addition.root_folder_id || "0").trim() || "0"
    this.onStateUpdate = onStateUpdate
  }

  public getRootFolderId(): string {
    return this.rootFolderId
  }

  private persist(): void {
    this.addition.access_token = this.accessToken
    this.addition.refresh_token = this.refreshToken
    this.addition.root_folder_id = this.rootFolderId
    this.onStateUpdate?.({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      root_folder_id: this.rootFolderId,
    })
  }

  // --- Token management ---

  /** Go isTokenExpired: expired or expiring within the refresh threshold */
  public isTokenExpired(): boolean {
    if (!this.accessToken) return true
    const payload = extractJWTPayload(this.accessToken)
    if (!payload || !payload.exp) return true
    return Date.now() + TOKEN_REFRESH_THRESHOLD_MS > payload.exp * 1000
  }

  /**
   * Go refreshToken: exchange the refresh token for a new access token.
   * (renamed vs. Go to avoid clashing with the refreshToken field)
   */
  public async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("[Degoo] no refresh token available")
    }
    const body: DegooAccessTokenRequest = { RefreshToken: this.refreshToken }
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    if (res.status === 429) {
      throw new Error(
        "[Degoo] refresh token rate limited (429), please try again later",
      )
    }
    if (res.status !== 200) {
      throw new Error(`[Degoo] refresh token failed: HTTP ${res.status}`)
    }
    const resp = (await res.json()) as DegooAccessTokenResponse
    if (!resp.AccessToken) {
      throw new Error("[Degoo] empty access token received")
    }
    this.accessToken = resp.AccessToken
    this.persist()
  }

  /** Go login(): email+password login, then exchange refresh token for access token */
  public async login(): Promise<void> {
    if (!this.addition.username || !this.addition.password) {
      throw new Error("[Degoo] username or password not provided")
    }
    const creds: DegooLoginRequest = {
      GenerateToken: true,
      Username: this.addition.username,
      Password: this.addition.password,
    }
    const res = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Origin: "https://app.degoo.com",
      },
      body: JSON.stringify(creds),
      signal: AbortSignal.timeout(30000),
    })
    if (res.status === 429) {
      throw new Error(
        "[Degoo] login rate limited (429), please try again later",
      )
    }
    if (res.status !== 200) {
      throw new Error(`[Degoo] login failed: HTTP ${res.status}`)
    }
    const loginResp = (await res.json()) as DegooLoginResponse

    if (loginResp.RefreshToken) {
      // Exchange refresh token for an access token (Go login flow)
      this.refreshToken = loginResp.RefreshToken
      const tokenReq: DegooAccessTokenRequest = {
        RefreshToken: loginResp.RefreshToken,
      }
      const tokenResp = await fetch(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT },
        body: JSON.stringify(tokenReq),
        signal: AbortSignal.timeout(30000),
      })
      if (tokenResp.status !== 200) {
        throw new Error(
          `[Degoo] failed to get access token: HTTP ${tokenResp.status}`,
        )
      }
      const accessResp = (await tokenResp.json()) as DegooAccessTokenResponse
      this.accessToken = accessResp.AccessToken || ""
    } else if (loginResp.Token) {
      // Direct token, no refresh token available
      this.accessToken = loginResp.Token
      this.refreshToken = ""
    } else {
      throw new Error("[Degoo] login failed, no valid token returned")
    }
    this.persist()
  }

  /** Go ensureValidToken: refresh or re-login when the token is (almost) expired */
  public async ensureValidToken(): Promise<void> {
    if (this.isTokenExpired()) {
      if (this.refreshToken) {
        try {
          await this.refreshAccessToken()
          return
        } catch (e: any) {
          console.warn(
            `[Degoo] token refresh failed, falling back to full login: ${e?.message || e}`,
          )
        }
      }
      if (this.addition.username && this.addition.password) {
        await this.login()
        return
      }
      // Nothing we can do — let the API call surface the auth error.
    }
  }

  // --- GraphQL ---

  /** Go updateTokenInVariables */
  private updateTokenInVariables(variables: Record<string, any>): void {
    if (variables && "Token" in variables) {
      variables.Token = this.accessToken
    }
  }

  /** Go executeGraphQLRequest */
  private async executeGraphQLRequest<T = any>(
    operationName: string,
    query: string,
    variables: Record<string, any>,
  ): Promise<T> {
    const reqBody = { operationName, query, variables }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "x-api-key": API_KEY,
    }
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`
    }
    const res = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(30000),
    })
    if (res.status === 429) {
      throw new Error(
        "[Degoo] GraphQL API rate limited (429), please try again later",
      )
    }
    if (res.status !== 200) {
      throw new Error(`[Degoo] GraphQL API failed: HTTP ${res.status}`)
    }
    let resp: DegooGraphqlResponse<T>
    try {
      resp = (await res.json()) as DegooGraphqlResponse<T>
    } catch {
      throw new Error("[Degoo] failed to decode GraphQL response")
    }
    if (resp.errors && resp.errors.length > 0) {
      const gqlError = resp.errors[0]
      throw new DegooGraphQLError(
        `[Degoo] GraphQL API error: ${gqlError.message}`,
        gqlError.errorType,
      )
    }
    return (resp.data ?? ({} as T)) as T
  }

  /**
   * Go apiCall: rate limit → ensure valid token → execute GraphQL request.
   * On "Unauthorized" GraphQL errors it re-logins and retries once.
   */
  public async apiCall<T = any>(
    operationName: string,
    query: string,
    variables: Record<string, any>,
    retryOnUnauthorized = true,
  ): Promise<T> {
    await applyRateLimit()
    await this.ensureValidToken()
    this.updateTokenInVariables(variables)
    try {
      return await this.executeGraphQLRequest<T>(
        operationName,
        query,
        variables,
      )
    } catch (e) {
      if (
        retryOnUnauthorized &&
        e instanceof DegooGraphQLError &&
        e.errorType === "Unauthorized"
      ) {
        await this.login()
        return this.apiCall<T>(operationName, query, variables, false)
      }
      throw e
    }
  }

  // --- API operations ---

  /** Go getDevices(): probe the top-level device list; auto-detect root id */
  public async getDevices(): Promise<void> {
    const query =
      "query GetFileChildren5($Token: String! $ParentID: String $AllParentIDs: [String] $Limit: Int! $Order: Int! $NextToken: String ) " +
      "{ getFileChildren5(Token: $Token ParentID: $ParentID AllParentIDs: $AllParentIDs Limit: $Limit Order: $Order NextToken: $NextToken) { Items { ParentID } NextToken } }"
    const variables: Record<string, any> = {
      Token: this.accessToken,
      ParentID: "0",
      Limit: 10,
      Order: 3,
    }
    const data = await this.apiCall<DegooGetChildren5Data>(
      "GetFileChildren5",
      query,
      variables,
    )
    if (this.rootFolderId === "0") {
      const items = data.getFileChildren5?.Items || []
      if (items.length > 0) {
        this.rootFolderId = items[0].ParentID
        this.persist()
      }
    }
  }

  /** Go getAllFileChildren5(): paginated directory listing */
  public async getAllFileChildren5(parentId: string): Promise<DegooFileItem[]> {
    const query =
      "query GetFileChildren5($Token: String! $ParentID: String $AllParentIDs: [String] $Limit: Int! $Order: Int! $NextToken: String ) " +
      "{ getFileChildren5(Token: $Token ParentID: $ParentID AllParentIDs: $AllParentIDs Limit: $Limit Order: $Order NextToken: $NextToken) " +
      "{ Items { ID ParentID Name Category Size CreationTime LastModificationTime LastUploadTime FilePath IsInRecycleBin DeviceID MetadataID } NextToken } }"
    const allItems: DegooFileItem[] = []
    let nextToken = ""
    // safety cap for paginated listing (Cloudflare Workers subrequest budget)
    let pages = 0
    for (;;) {
      if (++pages > 50) {
        console.warn("[Degoo] pagination exceeded 50 pages, result truncated")
        break
      }
      const variables: Record<string, any> = {
        Token: this.accessToken,
        ParentID: parentId,
        Limit: 1000,
        Order: 3,
      }
      if (nextToken) variables["NextToken"] = nextToken
      const data = await this.apiCall<DegooGetChildren5Data>(
        "GetFileChildren5",
        query,
        variables,
      )
      const resp = data.getFileChildren5
      allItems.push(...(resp?.Items || []))
      if (!resp || !resp.NextToken) break
      nextToken = resp.NextToken
    }
    return allItems
  }

  /** Go getOverlay4(): metadata (incl. download URL) of a single item by id */
  public async getOverlay4(id: string): Promise<DegooFileItem> {
    const query =
      "query GetOverlay4($Token: String!, $ID: IDType!) " +
      "{ getOverlay4(Token: $Token, ID: $ID) { ID ParentID Name Category Size CreationTime LastModificationTime LastUploadTime URL FilePath IsInRecycleBin DeviceID MetadataID } }"
    const variables: Record<string, any> = {
      Token: this.accessToken,
      ID: { FileID: id },
    }
    const data = await this.apiCall<DegooGetOverlay4Data>(
      "GetOverlay4",
      query,
      variables,
    )
    return data.getOverlay4
  }

  /** Go getUserInfo(): quota info */
  public async getUserInfo(): Promise<DegooGetUserInfo3Data> {
    const query =
      "query GetUserInfo3($Token: String!) { getUserInfo3(Token: $Token) { UsedQuota TotalQuota } }"
    const variables: Record<string, any> = { Token: this.accessToken }
    return this.apiCall<DegooGetUserInfo3Data>("GetUserInfo3", query, variables)
  }

  /** Go MakeDir(): folders are created via setUploadFile3 with a special checksum */
  public async makeDir(parentId: string, dirName: string): Promise<void> {
    const query =
      "mutation SetUploadFile3($Token: String!, $FileInfos: [FileInfoUpload3]!) { setUploadFile3(Token: $Token, FileInfos: $FileInfos) }"
    const variables: Record<string, any> = {
      Token: this.accessToken,
      FileInfos: [
        {
          Checksum: FOLDER_CHECKSUM,
          Name: dirName,
          CreationTime: Date.now(),
          ParentID: parentId,
          Size: 0,
        },
      ],
    }
    await this.apiCall("SetUploadFile3", query, variables)
  }

  /** Go Move(): setMoveFile (Copy=false) */
  public async move(fileIds: string[], newParentId: string): Promise<void> {
    const query =
      "mutation SetMoveFile($Token: String!, $Copy: Boolean, $NewParentID: String!, $FileIDs: [String]!) " +
      "{ setMoveFile(Token: $Token, Copy: $Copy, NewParentID: $NewParentID, FileIDs: $FileIDs) }"
    const variables: Record<string, any> = {
      Token: this.accessToken,
      Copy: false,
      NewParentID: newParentId,
      FileIDs: fileIds,
    }
    await this.apiCall("SetMoveFile", query, variables)
  }

  /** Go Rename(): setRenameFile */
  public async rename(id: string, newName: string): Promise<void> {
    const query =
      "mutation SetRenameFile($Token: String!, $FileRenames: [FileRenameInfo]!) " +
      "{ setRenameFile(Token: $Token, FileRenames: $FileRenames) }"
    const variables: Record<string, any> = {
      Token: this.accessToken,
      FileRenames: [{ ID: id, NewName: newName }],
    }
    await this.apiCall("SetRenameFile", query, variables)
  }

  /** Go Remove(): setDeleteFile5 (moves to trash) */
  public async remove(id: string): Promise<void> {
    const query =
      "mutation SetDeleteFile5($Token: String!, $IsInRecycleBin: Boolean!, $IDs: [IDType]!) " +
      "{ setDeleteFile5(Token: $Token, IsInRecycleBin: $IsInRecycleBin, IDs: $IDs) }"
    const variables: Record<string, any> = {
      Token: this.accessToken,
      IsInRecycleBin: false,
      IDs: [{ FileID: id }],
    }
    await this.apiCall("SetDeleteFile5", query, variables)
  }

  /** Go Init(): ensure a valid token, then resolve the device root */
  public async init(): Promise<void> {
    try {
      await this.ensureValidToken()
    } catch (e: any) {
      throw new Error(`[Degoo] failed to initialize token: ${e?.message || e}`)
    }
    await this.getDevices()
  }
}
