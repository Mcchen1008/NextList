/**
 * XML generation utilities for NextList protocols (WebDAV, S3).
 */

/** Escape a string for safe inclusion in XML text / attribute values. */
export function xmlEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** Percent-encode a path segment for use inside a WebDAV href. */
export function davHrefEncode(name: string): string {
  return encodeURIComponent(String(name ?? "")).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  )
}

export interface WebDavXmlItem {
  name: string
  size: number
  isFolder: boolean
  modified: string
  created?: string
}

/** Map common file extensions to MIME types for getcontenttype. */
const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/plain",
  json: "application/json",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
}

export function mimeByExt(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase()
  return MIME_BY_EXT[ext] || "application/octet-stream"
}

function toHttpDate(input?: string): string {
  const d = input ? new Date(input) : new Date()
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString()
}

/** Build the <d:prop> element for one item. */
function buildPropXml(item: WebDavXmlItem): string {
  let xml = ``
  xml += `        <d:displayname>${xmlEscape(item.name)}</d:displayname>\n`
  if (item.isFolder) {
    xml += `        <d:resourcetype><d:collection/></d:resourcetype>\n`
  } else {
    xml += `        <d:resourcetype/>\n`
    xml += `        <d:getcontentlength>${Number(item.size) || 0}</d:getcontentlength>\n`
    xml += `        <d:getcontenttype>${mimeByExt(item.name)}</d:getcontenttype>\n`
  }
  xml += `        <d:getlastmodified>${toHttpDate(item.modified)}</d:getlastmodified>\n`
  xml += `        <d:creationdate>${toHttpDate(item.created || item.modified)}</d:creationdate>\n`
  return xml
}

/**
 * Build a PROPFIND multistatus response body.
 *
 * @param reqPath the decoded request path (e.g. `/` or `/docs/a.txt`) — used
 *   for the self href.
 * @param self the item the request addressed.
 * @param items when Depth: 1 was requested, the children of `self`.
 */
export function generateWebDavPropfindXml(
  reqPath: string,
  self: WebDavXmlItem,
  items: WebDavXmlItem[] = [],
): string {
  const selfHref = encodeHref(reqPath, self.isFolder)
  let xml = `<?xml version="1.0" encoding="utf-8"?>\n`
  xml += `<d:multistatus xmlns:d="DAV:">\n`
  xml += `  <d:response>\n`
  xml += `    <d:href>${xmlEscape(selfHref)}</d:href>\n`
  xml += `    <d:propstat>\n`
  xml += `      <d:prop>\n`
  xml += buildPropXml(self)
  xml += `      </d:prop>\n`
  xml += `      <d:status>HTTP/1.1 200 OK</d:status>\n`
  xml += `    </d:propstat>\n`
  xml += `  </d:response>\n`

  const base = reqPath.endsWith("/") ? reqPath : reqPath + "/"
  for (const item of items) {
    const itemHref = encodeHref(base + item.name, item.isFolder)
    xml += `  <d:response>\n`
    xml += `    <d:href>${xmlEscape(itemHref)}</d:href>\n`
    xml += `    <d:propstat>\n`
    xml += `      <d:prop>\n`
    xml += buildPropXml(item)
    xml += `      </d:prop>\n`
    xml += `      <d:status>HTTP/1.1 200 OK</d:status>\n`
    xml += `    </d:propstat>\n`
    xml += `  </d:response>\n`
  }

  xml += `</d:multistatus>`
  return xml
}

function encodeHref(path: string, isFolder: boolean): string {
  const segments = path.split("/").filter(Boolean).map(davHrefEncode)
  const encoded = "/" + segments.join("/")
  return (
    (encoded === "/" ? "/" : encoded) +
    (isFolder && !encoded.endsWith("/") ? "/" : "")
  )
}

/**
 * Legacy helper kept for backwards compatibility — builds a PROPFIND response
 * for a folder and its children.
 */
export function generateWebDavXml(
  path: string,
  items: WebDavXmlItem[],
): string {
  return generateWebDavPropfindXml(
    path,
    {
      name: path === "/" ? "/" : path.split("/").filter(Boolean).pop() || "/",
      size: 0,
      isFolder: true,
      modified: new Date().toISOString(),
    },
    items,
  )
}

/**
 * Build a PROPPATCH multistatus response echoing the requested property
 * names. `lastmodified` is rejected with 403 (read-only), others with 200.
 */
export function generateWebDavProppatchXml(
  reqPath: string,
  propNames: string[],
  isFolder: boolean,
): string {
  const selfHref = encodeHref(reqPath, isFolder)
  const names = propNames.length > 0 ? propNames : ["Z"]
  let xml = `<?xml version="1.0" encoding="utf-8"?>\n`
  xml += `<d:multistatus xmlns:d="DAV:">\n`
  xml += `  <d:response>\n`
  xml += `    <d:href>${xmlEscape(selfHref)}</d:href>\n`
  for (const name of names) {
    // Read-only server-managed properties (mtime/size/creation) are rejected
    const lower = name.toLowerCase()
    const isReadOnly =
      lower.endsWith("lastmodified") ||
      lower.endsWith("creationdate") ||
      lower.endsWith("creationtime") ||
      lower === "getcontentlength" ||
      lower === "getetag"
    const status = isReadOnly ? "HTTP/1.1 403 Forbidden" : "HTTP/1.1 200 OK"
    xml += `    <d:propstat>\n`
    xml += `      <d:prop><${name}/></d:prop>\n`
    xml += `      <d:status>${status}</d:status>\n`
    xml += `    </d:propstat>\n`
  }
  xml += `  </d:response>\n`
  xml += `</d:multistatus>`
  return xml
}

/** Build a LOCK response body with an exclusive write lock token. */
export function generateWebDavLockXml(
  reqPath: string,
  token: string,
  owner: string,
): string {
  const selfHref = encodeHref(reqPath, false)
  return `<?xml version="1.0" encoding="utf-8"?>
<d:prop xmlns:d="DAV:">
 <d:lockdiscovery>
  <d:activelock>
   <d:locktype><d:write/></d:locktype>
   <d:lockscope><d:exclusive/></d:lockscope>
   <d:depth>infinity</d:depth>
   <d:owner>${xmlEscape(owner || "webdav-client")}</d:owner>
   <d:timeout>Second-3600</d:timeout>
   <d:locktoken><d:href>${xmlEscape(token)}</d:href></d:locktoken>
   <d:lockroot><d:href>${xmlEscape(selfHref)}</d:href></d:lockroot>
  </d:activelock>
 </d:lockdiscovery>
</d:prop>`
}
