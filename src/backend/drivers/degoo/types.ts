// Degoo driver types
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/degoo

/** Mirrors Go meta.go `Addition` (including embedded driver.RootID) */
export interface DegooAddition {
  /** embedded driver.RootID in Go — "0" triggers auto-detection of the device root */
  root_folder_id?: string
  /** Go: Username `json:"username"` — Degoo account email */
  username: string
  /** Go: Password `json:"password"` — Degoo account password */
  password: string
  /** Go: RefreshToken `json:"refresh_token"` — obtained automatically after login */
  refresh_token?: string
  /** Go: AccessToken `json:"access_token"` — obtained automatically after login */
  access_token?: string
}

/** Go types.go DegooLoginRequest */
export interface DegooLoginRequest {
  GenerateToken: boolean
  Username: string
  Password: string
}

/** Go types.go DegooLoginResponse */
export interface DegooLoginResponse {
  Token?: string
  RefreshToken?: string
}

/** Go types.go DegooAccessTokenRequest */
export interface DegooAccessTokenRequest {
  RefreshToken: string
}

/** Go types.go DegooAccessTokenResponse */
export interface DegooAccessTokenResponse {
  AccessToken: string
}

/** Go types.go DegooFileItem — a Degoo file or folder */
export interface DegooFileItem {
  ID: string
  ParentID: string
  Name: string
  /** folder categories: 1, 2, 10 */
  Category: number
  /** size in bytes, as a decimal string */
  Size: string
  /** download url (getOverlay4 only) */
  URL?: string
  /** RFC3339 timestamp */
  CreationTime: string
  /** unix milliseconds, as a decimal string */
  LastModificationTime: string
  /** unix milliseconds, as a decimal string */
  LastUploadTime: string
  MetadataID?: string
  DeviceID?: number
  FilePath?: string
  IsInRecycleBin?: boolean
}

/** Go types.go DegooErrors — GraphQL error entry */
export interface DegooGraphqlError {
  path?: string[]
  data?: any
  errorType?: string
  errorInfo?: any
  message: string
}

/** Go types.go DegooGraphqlResponse */
export interface DegooGraphqlResponse<T = any> {
  data?: T
  errors?: DegooGraphqlError[]
}

/** Go types.go DegooGetChildren5Data */
export interface DegooGetChildren5Data {
  getFileChildren5: {
    Items: DegooFileItem[]
    NextToken: string
  }
}

/** Go types.go DegooGetOverlay4Data */
export interface DegooGetOverlay4Data {
  getOverlay4: DegooFileItem
}

/** Go types.go DegooFileRenameInfo */
export interface DegooFileRenameInfo {
  ID: string
  NewName: string
}

/** Go types.go DegooGetUserInfo3Data */
export interface DegooGetUserInfo3Data {
  getUserInfo3: {
    UsedQuota: string
    TotalQuota: string
  }
}

/** Go util.go JWTPayload — used for token expiry checks */
export interface DegooJWTPayload {
  userID?: string
  exp?: number
  iat?: number
}
