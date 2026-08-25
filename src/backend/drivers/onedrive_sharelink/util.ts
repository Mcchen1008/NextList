// OnedriveSharelink HTTP client
// Ported from: https://github.com/OpenListTeam/OpenList/tree/main/drivers/onedrive_sharelink
//
// Porting notes (Go driver.go / util.go):
// - Auth is cookie based: an anonymous GET of the share link returns a 302
//   whose Set-Cookie (rtFa/FedAuth) + Location feed the request headers.
//   Password-protected links additionally submit an ASP.NET form
//   (txtPassword/__VIEWSTATE/__EVENTVALIDATION) to obtain a FedAuth cookie.
// - Listing goes through the SharePoint GraphQL endpoint
//   POST {site}/_api/v2.1/graphql (renderListDataAsStream) with pagination
//   via /_api/web/GetListUsingPath(DecodedUrl=@a1)/RenderListDataAsStream.
// - Folder sizes are fetched from the Graph-style drive API whose base url +
//   access token are scraped from the `_spPageContextInfo` JSON on the share
//   page (refreshDriveContext). This only exists on SharePoint pages; for
//   OneDrive personal ("-my") links it fails and folder sizes stay 0
//   (Go only logs a warning in that case).
// - The hourly header-refresh cron of Go Init() cannot be ported; the TTL
//   based lazy refresh in getValidHeaders() (25 min, headerTTL) covers it.
// - MakeDir/Put/GetDirectUploadTools of the Go driver are NOT ported
//   (read-only driver, see driver.ts).
import {
  OnedriveSharelinkAddition,
  SPListItem,
  GraphQLResp,
  RenderListDataResp,
  PageContextInfo,
  DriveChildrenResp,
  HeaderMap,
} from "./types"

// OpenList drivers/base client.go UserAgent
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Apple macOS 26_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30"
const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6"

// Go driver.go constants
const HEADER_TTL_MS = 25 * 60 * 1000 // headerTTL = 25 * time.Minute
const DRIVE_TOKEN_TTL_MS = 20 * 60 * 1000 // driveTokenTTL = 20 * time.Minute

const REQUEST_TIMEOUT_MS = 30_000

// ─── pure path / url helpers (Go stdpath + net/url equivalents) ─────────────

/** Go stdpath.Clean equivalent */
export function cleanPath(path: string): string {
  const isAbs = path.startsWith("/")
  const out: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop()
      } else if (!isAbs) {
        out.push("..")
      }
      continue
    }
    out.push(part)
  }
  const cleaned = out.join("/")
  if (isAbs) return "/" + cleaned
  return cleaned === "" ? "." : cleaned
}

/** Go stdpath.Join equivalent */
export function joinPath(...elems: string[]): string {
  const joined = elems.filter((e) => e !== "").join("/")
  if (joined === "") return ""
  return cleanPath(joined)
}

/** Go utils.FixAndCleanPath equivalent: fix backslashes, ensure leading "/", then Clean */
export function fixAndCleanPath(path: string): string {
  let p = path.split("\\").join("/")
  if (!p.startsWith("/")) p = "/" + p
  return cleanPath(p)
}

function isAlnum(b: number): boolean {
  return (
    (b >= 0x61 && b <= 0x7a) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x30 && b <= 0x39)
  )
}

function hexUpper(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, "0")
}

/** Go url.PathEscape (encodePathSegment mode) equivalent */
export function goPathEscape(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ""
  for (const b of bytes) {
    if (isAlnum(b)) {
      out += String.fromCharCode(b)
    } else if (
      b === 0x2d || // -
      b === 0x5f || // _
      b === 0x2e || // .
      b === 0x7e || // ~
      // path-segment safe reserved chars (Go shouldEscape/encodePathSegment)
      b === 0x24 || // $
      b === 0x26 || // &
      b === 0x2b || // +
      b === 0x3a || // :
      b === 0x3d || // =
      b === 0x40 // @
    ) {
      out += String.fromCharCode(b)
    } else {
      out += "%" + hexUpper(b)
    }
  }
  return out
}

/** Go url.QueryEscape equivalent (space → "+", uppercase hex) */
export function goQueryEscape(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ""
  for (const b of bytes) {
    if (isAlnum(b) || b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e) {
      out += String.fromCharCode(b)
    } else if (b === 0x20) {
      out += "+"
    } else {
      out += "%" + hexUpper(b)
    }
  }
  return out
}

/** Go url.QueryUnescape equivalent ("+" → " ", %XX decoded) */
export function goQueryUnescape(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, " "))
}

// ─── tiny HTML scraping helpers (Go parses with x/net/html; regex based here) ─

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&amp;/g, "&")
}

function parseTagAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRe =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(tag)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ""
  }
  return attrs
}

/** find <input id="..."> and return its value attribute */
function findInputValue(html: string, id: string): string {
  const inputRe = /<input\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = inputRe.exec(html)) !== null) {
    const attrs = parseTagAttrs(m[0])
    if (attrs["id"] === id) {
      return decodeHtmlEntities(attrs["value"] || "")
    }
  }
  return ""
}

/** find <form id="..."> and return its action attribute */
function findFormAction(html: string, id: string): string {
  const formRe = /<form\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = formRe.exec(html)) !== null) {
    const attrs = parseTagAttrs(m[0])
    if (attrs["id"] === id) {
      return decodeHtmlEntities(attrs["action"] || "")
    }
  }
  return ""
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof withGetSetCookie.getSetCookie === "function") {
    const values = withGetSetCookie.getSetCookie()
    if (values.length > 0) return values
  }
  const combined = headers.get("set-cookie")
  return combined ? [combined] : []
}

// ─── client ──────────────────────────────────────────────────────────────────

export class OnedriveSharelinkClient {
  private addition: OnedriveSharelinkAddition
  /** Go Addition.IsSharepoint: no "-my" in the url → SharePoint link */
  private isSharepoint = false
  /** Go Addition.Headers / HeaderTime */
  private headers: HeaderMap | null = null
  private headerTime = 0
  /** Go Addition.downloadLinkPrefix */
  private downloadLinkPrefix = ""
  /** Go Addition.DriveURL / DriveAccessToken / DriveTokenTime / driveRootPath */
  private driveUrl = ""
  private driveAccessToken = ""
  private driveTokenTime = 0
  private driveRootPath = "/"
  /** singleflight replacement for Go d.sg.Do("refresh", ...) */
  private headerRefreshInFlight: Promise<HeaderMap> | null = null

  constructor(addition: OnedriveSharelinkAddition) {
    this.addition = addition
  }

  /** Go Init(): detect the sharepoint variant, then fetch initial headers */
  async init(): Promise<void> {
    // If there is "-my" in the URL, it is NOT a SharePoint link
    this.isSharepoint = !(this.addition.url || "").includes("-my")
    const h = await this.getHeaders()
    this.storeHeaders(h)
  }

  getIsSharepoint(): boolean {
    return this.isSharepoint
  }

  // ─── share headers (Go util.go getHeaders) ────────────────────────────────

  private storeHeaders(header: HeaderMap): void {
    this.headers = header
    this.headerTime = Date.now()
  }

  private headersExpired(): boolean {
    return Date.now() - this.headerTime > HEADER_TTL_MS
  }

  private async refreshHeaders(): Promise<HeaderMap> {
    // Go uses a singleflight group; dedup concurrent refreshes with one promise
    if (this.headerRefreshInFlight) return this.headerRefreshInFlight
    this.headerRefreshInFlight = (async () => {
      try {
        const h = await this.getHeaders()
        this.storeHeaders(h)
        return h
      } finally {
        this.headerRefreshInFlight = null
      }
    })()
    return this.headerRefreshInFlight
  }

  async getValidHeaders(): Promise<HeaderMap> {
    if (this.headers && !this.headersExpired()) return this.headers
    try {
      return await this.refreshHeaders()
    } catch (e) {
      // Go: use cached headers after refresh failure
      if (this.headers) return this.headers
      throw e
    }
  }

  /**
   * Go util.go getHeaders(): build the Cookie/Referer/Authority headers
   * needed to access the share link anonymously.
   */
  private async getHeaders(): Promise<HeaderMap> {
    const header: HeaderMap = {
      "User-Agent": USER_AGENT,
      "Accept-Language": ACCEPT_LANGUAGE,
    }

    if (!this.addition.password) {
      const res = await fetch(this.addition.url, {
        method: "GET",
        headers: header,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const redirectUrl = res.headers.get("location") || ""
      if (!redirectUrl) {
        throw new Error(
          "[OnedriveSharelink] password protected link. Please provide password",
        )
      }
      // Go: header.Set("Cookie", resp.Header.Get("Set-Cookie")) — the raw
      // value of the FIRST Set-Cookie header (quirk kept on purpose)
      const setCookies = getSetCookieHeaders(res.headers)
      header["Cookie"] = setCookies[0] || ""
      header["Referer"] = redirectUrl
      header["Authority"] = new URL(redirectUrl).host
      return header
    }

    const cookie = await getCookiesWithPassword(
      this.addition.url,
      this.addition.password,
    )
    header["Cookie"] = cookie
    header["Referer"] = this.addition.url
    header["Authority"] = new URL(this.addition.url).host
    return header
  }

  // ─── listing (Go util.go getFiles) ────────────────────────────────────────

  /**
   * List the share contents at `path` (physical path under the share root,
   * including root_folder_path). On request failure the headers are
   * refreshed and the listing retried once (Go recurses unbounded; capped
   * here to a single retry).
   */
  async getFiles(path: string): Promise<SPListItem[]> {
    try {
      return await this.getFilesOnce(path)
    } catch (e) {
      await this.refreshHeaders() // propagate refresh error like Go
      return await this.getFilesOnce(path)
    }
  }

  private async getFilesOnce(path: string): Promise<SPListItem[]> {
    // 1. anonymous no-redirect GET of the share link to get the redirect url
    const initialHeaders: HeaderMap = this.addition.password
      ? this.headers || {}
      : { "User-Agent": USER_AGENT, "Accept-Language": ACCEPT_LANGUAGE }
    const first = await fetch(this.addition.url, {
      method: "GET",
      headers: initialHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const redirectUrl = first.headers.get("location") || ""
    const header = this.headers || {}
    const redirectSplitURL = redirectUrl.split("/")
    let downloadLinkPrefix = ""
    let rootFolderPre = ""

    const queryIdx = redirectUrl.indexOf("?")
    const params = new URLSearchParams(
      queryIdx >= 0 ? redirectUrl.slice(queryIdx + 1) : "",
    )

    if (this.isSharepoint) {
      // 2a. SharePoint variant: load the redirected page (without following
      // further redirects) and extract templateUrl from the embedded JSON
      const answer = await fetch(redirectUrl, {
        method: "GET",
        headers: header,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await answer.text()
      const m = body.match(/templateUrl":"(.*?)"/)
      if (!m) {
        throw new Error(
          "[OnedriveSharelink] failed to find templateUrl in share page",
        )
      }
      let template = m[0]
      const prefix = 'templateUrl":"'
      template = template.slice(template.indexOf(prefix) + prefix.length)
      const idIdx = template.indexOf("?id=")
      if (idIdx < 0) {
        throw new Error("[OnedriveSharelink] templateUrl has no ?id= part")
      }
      template = template.slice(0, idIdx)
      const slashIdx = template.lastIndexOf("/")
      if (slashIdx < 0) {
        throw new Error("[OnedriveSharelink] templateUrl has no / separator")
      }
      template = template.slice(0, slashIdx)
      downloadLinkPrefix = template + "/download.aspx?UniqueId="
      rootFolderPre = params.get("id") || ""
    } else {
      // 2b. OneDrive personal variant: derive the prefix from the redirect url
      const cutIdx = redirectUrl.lastIndexOf("/")
      if (cutIdx < 0) {
        throw new Error(
          `[OnedriveSharelink] unexpected share redirect url: ${redirectUrl}`,
        )
      }
      downloadLinkPrefix =
        redirectUrl.slice(0, cutIdx) + "/download.aspx?UniqueId="
      rootFolderPre = params.get("id") || ""
    }
    this.downloadLinkPrefix = downloadLinkPrefix

    if (redirectSplitURL.length < 4) {
      throw new Error(
        `[OnedriveSharelink] unexpected share redirect url: ${redirectUrl}`,
      )
    }
    const apiBase = redirectSplitURL
      .slice(0, redirectSplitURL.length - 3)
      .join("/")

    // 3. build the GraphQL request against the share's list
    // NOTE: Go QueryUnescapes the already-decoded id param (double decode,
    // "+" becomes " ") — quirk kept for byte-compatibility
    let rootFolder = goQueryUnescape(rootFolderPre)
    // relative path up to and including "Documents"
    const relativePath = rootFolder.split("Documents")[0] + "Documents"
    let relativeUrl = goQueryEscape(relativePath)
    relativeUrl = relativeUrl.split("_").join("%5F").split("-").join("%2D")
    // if the path is not the root, append it to the root folder
    if (path !== "/") {
      rootFolder = rootFolder + path
    }
    let rootFolderUrl = goQueryEscape(rootFolder)
    rootFolderUrl = rootFolderUrl.split("_").join("%5F").split("-").join("%2D")

    // byte-identical port of the Go fmt.Sprintf graphqlVar payload
    const graphqlVar = String.raw`{"query":"query (\n        $listServerRelativeUrl: String!,$renderListDataAsStreamParameters: RenderListDataAsStreamParameters!,$renderListDataAsStreamQueryString: String!\n        )\n      {\n      \n      legacy {\n      \n      renderListDataAsStream(\n      listServerRelativeUrl: $listServerRelativeUrl,\n      parameters: $renderListDataAsStreamParameters,\n      queryString: $renderListDataAsStreamQueryString\n      )\n    }\n      \n      \n  perf {\n    executionTime\n    overheadTime\n    parsingTime\n    queryCount\n    validationTime\n    resolvers {\n      name\n      queryCount\n      resolveTime\n      waitTime\n    }\n  }\n    }","variables":{"listServerRelativeUrl":"${relativePath}","renderListDataAsStreamParameters":{"renderOptions":5707527,"allowMultipleValueFilterForTaxonomyFields":true,"addRequiredFields":true,"folderServerRelativeUrl":"${rootFolder}"},"renderListDataAsStreamQueryString":"@a1=\'${relativeUrl}\'&RootFolder=${rootFolderUrl}&TryNewExperienceSingle=TRUE"}}`

    const tempHeader: HeaderMap = {
      ...header,
      "Content-Type": "application/json;odata=verbose",
    }
    let postUrl = apiBase + "/_api/v2.1/graphql"

    const res = await fetch(postUrl, {
      method: "POST",
      headers: tempHeader,
      body: graphqlVar,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    let graphqlReq: GraphQLResp
    try {
      graphqlReq = JSON.parse(text) as GraphQLResp
    } catch {
      // Go silently ignores the json decode error and returns an empty list;
      // surfacing the failure instead makes broken shares debuggable
      throw new Error(
        `[OnedriveSharelink] graphql request failed, status: ${res.status}, body: ${text.slice(0, 200)}`,
      )
    }
    const listData = graphqlReq.data?.legacy?.renderListDataAsStream
    let filesData: SPListItem[] = listData?.ListData?.Row || []
    let nextHref = listData?.ListData?.NextHref || ""

    // 4. paginate via RenderListDataAsStream while NextHref is present
    if (nextHref !== "") {
      const listViewXml = (listData?.ViewMetadata?.ListViewXml || "")
        .split('"')
        .join('\\"')
      const renderListDataAsStreamVar = `{"parameters":{"__metadata":{"type":"SP.RenderListDataParameters"},"RenderOptions":1216519,"ViewXml":"${listViewXml}","AllowMultipleValueFilterForTaxonomyFields":true,"AddRequiredFields":true}}`

      while (nextHref !== "") {
        let href = nextHref + "&@a1=REPLACEME&TryNewExperienceSingle=TRUE"
        href = href.split("REPLACEME").join("%27" + relativeUrl + "%27")
        postUrl =
          apiBase +
          "/_api/web/GetListUsingPath(DecodedUrl=@a1)/RenderListDataAsStream" +
          href
        const pageRes = await fetch(postUrl, {
          method: "POST",
          headers: tempHeader,
          body: renderListDataAsStreamVar,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        const pageText = await pageRes.text()
        let pageResp: RenderListDataResp
        try {
          pageResp = JSON.parse(pageText) as RenderListDataResp
        } catch {
          throw new Error(
            `[OnedriveSharelink] RenderListDataAsStream request failed, status: ${pageRes.status}, body: ${pageText.slice(0, 200)}`,
          )
        }
        filesData = filesData.concat(pageResp.ListData?.Row || [])
        nextHref = pageResp.ListData?.NextHref || ""
      }
    }
    return filesData
  }

  // ─── download urls (Go driver.go Link / resolveDirectDownloadURL) ─────────

  /**
   * Build the cookie-authenticated download.aspx url for an item.
   * Go Link(): uniqueId = uniqueId[1 : len(uniqueId)-1] strips the braces
   * around the SharePoint UniqueId.
   */
  buildDownloadUrl(uniqueId: string): string {
    const trimmed =
      uniqueId.length >= 2 ? uniqueId.slice(1, uniqueId.length - 1) : uniqueId
    return this.downloadLinkPrefix + trimmed
  }

  /**
   * Go resolveDirectDownloadURL(): resolve a cookie-free direct url.
   * Order: ".spItemUrl" metadata → "@content.downloadUrl" → the
   * download.aspx redirect Location.
   */
  async resolveDirectDownloadURL(
    item: SPListItem,
    rawURL: string,
  ): Promise<string> {
    const header = await this.getValidHeaders()
    if (item[".spItemUrl"]) {
      try {
        return await this.resolveSPItemDownloadURL(item[".spItemUrl"], header)
      } catch {
        // Go collects the error but only reports it when everything fails
      }
    }
    if (item["@content.downloadUrl"]) {
      return item["@content.downloadUrl"]
    }

    const res = await fetch(rawURL, {
      method: "GET",
      headers: header,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const location = res.headers.get("location") || ""
    if (!location) {
      throw new Error(
        `[OnedriveSharelink] direct download URL unavailable: download.aspx returned no redirect location, status code: ${res.status}`,
      )
    }
    return new URL(location, rawURL).toString()
  }

  /** Go resolveSPItemDownloadURL(): GET the item metadata api for @content.downloadUrl */
  private async resolveSPItemDownloadURL(
    spItemURL: string,
    header: HeaderMap,
  ): Promise<string> {
    const res = await fetch(spItemURL, {
      method: "GET",
      headers: {
        ...header,
        Accept: "application/json;odata.metadata=minimal",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `[OnedriveSharelink] sp item metadata request failed, status code: ${res.status}`,
      )
    }
    const text = await res.text()
    let data: { "@content.downloadUrl"?: string }
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(
        "[OnedriveSharelink] failed to parse sp item metadata response",
      )
    }
    if (!data["@content.downloadUrl"]) {
      throw new Error(
        "[OnedriveSharelink] sp item metadata response missing @content.downloadUrl",
      )
    }
    return data["@content.downloadUrl"]
  }

  // ─── drive api (folder sizes, Go driver.go drive*) ────────────────────────

  /**
   * Go driveChildrenFolderSizes(): sizes of the child folders of `path`,
   * fetched from the Graph-style drive api. Only available on SharePoint
   * shares (the drive url/token come from _spPageContextInfo).
   */
  async getFolderSizes(path: string): Promise<Map<string, number>> {
    const token = await this.getValidDriveAccessToken()
    const sizes = new Map<string, number>()
    let rawURL =
      this.drivePathAPIURL(path) + "/children?$select=name,size,folder"
    while (rawURL !== "") {
      const data = await this.doJSON<DriveChildrenResp>(
        "GET",
        injectAccessToken(rawURL, token),
      )
      for (const item of data.value || []) {
        if (item.folder != null && item.folder !== undefined) {
          sizes.set(item.name || "", item.size || 0)
        }
      }
      rawURL = data["@odata.nextLink"] || ""
    }
    return sizes
  }

  /** Go drivePathAPIURL(): {driveUrl}/root or {driveUrl}/root:{encodedPath}: */
  private drivePathAPIURL(path: string): string {
    const drivePath = fixAndCleanPath(joinPath(this.driveRootPath, path) || "/")
    if (drivePath === "/") {
      return this.driveUrl + "/root"
    }
    return `${this.driveUrl}/root:${goPathEscape(drivePath)}:`
  }

  /** Go getValidDriveAccessToken(): cached drive token with 20 min TTL */
  private async getValidDriveAccessToken(): Promise<string> {
    const token = this.driveAccessToken
    const expired = Date.now() - this.driveTokenTime > DRIVE_TOKEN_TTL_MS
    if (token && !expired) {
      return token
    }
    try {
      await this.refreshDriveContext()
    } catch (e) {
      // Go: use cached drive access token after refresh failure
      if (this.driveAccessToken) return this.driveAccessToken
      throw e
    }
    return this.driveAccessToken
  }

  /** Go refreshDriveContext(): follow the share link redirect and scrape the drive context */
  private async refreshDriveContext(): Promise<void> {
    const header = await this.getValidHeaders()
    const res = await fetch(this.addition.url, {
      method: "GET",
      headers: header,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    let redirectURL = res.headers.get("location") || ""
    if (redirectURL === "") {
      // Go falls back to resp.Request.URL (the share link url itself)
      redirectURL = this.addition.url
    }
    await this.refreshDriveContextFromRedirect(redirectURL, header)
  }

  /** Go refreshDriveContextFromRedirect(): parse _spPageContextInfo off the share page */
  private async refreshDriveContextFromRedirect(
    redirectURL: string,
    header: HeaderMap,
  ): Promise<void> {
    const res = await fetch(redirectURL, {
      method: "GET",
      headers: header,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `[OnedriveSharelink] onedrive page request failed, status code: ${res.status}`,
      )
    }
    const body = await res.text()
    const ctxInfo = parsePageContext(body)
    const rootPath = driveRootPathFromRedirect(
      redirectURL,
      ctxInfo.listUrl || "",
    )
    this.driveUrl = ctxInfo.driveInfo?.[".driveUrl"] || ""
    this.driveAccessToken = ctxInfo.driveInfo?.[".driveAccessToken"] || ""
    this.driveTokenTime = Date.now()
    this.driveRootPath = rootPath
  }

  /** Go doJSON(): json request with the odata Accept header */
  private async doJSON<T>(
    method: string,
    rawURL: string,
    body?: unknown,
  ): Promise<T> {
    const headers: HeaderMap = {
      Accept: "application/json;odata.metadata=minimal",
    }
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
    if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json"
      init.body = JSON.stringify(body)
    }
    const res = await fetch(rawURL, init)
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text()
      throw new Error(
        `[OnedriveSharelink] request failed, status code: ${res.status}, body: ${text.slice(0, 200)}`,
      )
    }
    return (await res.json()) as T
  }
}

// ─── module level helpers ────────────────────────────────────────────────────

/**
 * Go util.go getCookiesWithPassword(): submit the share password through the
 * ASP.NET login form and return the FedAuth cookie header value.
 */
async function getCookiesWithPassword(
  link: string,
  password: string,
): Promise<string> {
  // 1. GET the login page (redirects followed, like Go http.Get)
  const res = await fetch(link, {
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const html = await res.text()

  // 2. scrape the ASP.NET form fields (Go walks the html DOM)
  const viewstate = findInputValue(html, "__VIEWSTATE")
  const eventvalidation = findInputValue(html, "__EVENTVALIDATION")
  const postAction = findFormAction(html, "inputForm")

  const linkUrl = new URL(link)
  const newURL = `${linkUrl.protocol}//${linkUrl.host}${postAction}`

  // 3. POST the password form without following the redirect
  const form = new URLSearchParams()
  form.set("txtPassword", password)
  form.set("__EVENTVALIDATION", eventvalidation)
  form.set("__VIEWSTATE", viewstate)
  form.set("__VIEWSTATEENCRYPTED", "")

  const postRes = await fetch(newURL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  // 4. extract the FedAuth cookie
  const setCookies = getSetCookieHeaders(postRes.headers)
  let fedAuth = ""
  for (const c of setCookies) {
    const pair = c.split(";")[0].trim()
    if (pair.startsWith("FedAuth=")) {
      fedAuth = pair.slice("FedAuth=".length)
      break
    }
  }
  if (fedAuth === "") {
    throw new Error("[OnedriveSharelink] wrong password")
  }
  return `FedAuth=${fedAuth};`
}

/** Go driver.go parsePageContext(): scrape the _spPageContextInfo JSON */
const PAGE_CONTEXT_RE = /var _spPageContextInfo=(\{.*?\});_spPageContextInfo/s

function parsePageContext(body: string): PageContextInfo {
  const m = body.match(PAGE_CONTEXT_RE)
  if (!m) {
    throw new Error("[OnedriveSharelink] failed to find _spPageContextInfo")
  }
  let info: PageContextInfo
  try {
    info = JSON.parse(m[1]) as PageContextInfo
  } catch {
    throw new Error("[OnedriveSharelink] failed to parse _spPageContextInfo")
  }
  if (!info.driveInfo?.[".driveUrl"]) {
    throw new Error(
      "[OnedriveSharelink] failed to get drive URL from page context",
    )
  }
  if (!info.driveInfo?.[".driveAccessToken"]) {
    throw new Error(
      "[OnedriveSharelink] failed to get drive access token from page context",
    )
  }
  return info
}

/** Go driver.go driveRootPathFromRedirect() */
function driveRootPathFromRedirect(
  redirectURL: string,
  listURL: string,
): string {
  const u = new URL(redirectURL)
  const id = u.searchParams.get("id") || ""
  if (id === "") return "/"
  if (listURL === "") return "/"
  if (id === listURL) return "/"
  const trimmedListUrl = listURL.replace(/\/+$/, "")
  const prefix = trimmedListUrl + "/"
  if (id.startsWith(prefix)) {
    return fixAndCleanPath(id.slice(trimmedListUrl.length))
  }
  return "/"
}

/** Go driver.go injectAccessToken(): add ?access_token=... to an url */
function injectAccessToken(rawURL: string, token: string): string {
  if (token === "") {
    return rawURL
  }
  const u = new URL(rawURL)
  let t = token
  if (t.startsWith("access_token=")) {
    t = t.slice("access_token=".length)
  }
  u.searchParams.set("access_token", t)
  return u.toString()
}
