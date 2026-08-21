import { WebdavPropfindEntry } from "./types"

/**
 * Path helpers (mirror the GitHub driver conventions):
 * paths are always canonicalized to `/foo/bar` form (no trailing slash).
 */
export function cleanPath(p: string): string {
  if (!p) return "/"
  const normalized = p.replace(/\\/g, "/").replace(/\/+/g, "/")
  const trimmed = normalized.replace(/^\/+|\/+$/g, "")
  return trimmed ? "/" + trimmed : "/"
}

export function dirname(p: string): string {
  const cleaned = cleanPath(p)
  if (cleaned === "/") return "/"
  const parts = cleaned.split("/").filter(Boolean)
  parts.pop()
  return parts.length ? "/" + parts.join("/") : "/"
}

export function basename(p: string): string {
  const cleaned = cleanPath(p)
  if (cleaned === "/") return ""
  const parts = cleaned.split("/").filter(Boolean)
  return parts[parts.length - 1] || ""
}

export function joinPath(...parts: string[]): string {
  return cleanPath(parts.join("/"))
}

/**
 * Percent-encode each path segment while preserving the `/` separators.
 * WebDAV servers expect a properly encoded request path (e.g. CJK names,
 * spaces, `#`, `?`, etc.).
 */
export function encodePath(p: string): string {
  return p
    .split("/")
    .map((seg) => {
      // Keep segments that are already percent-encoded intact.
      if (/%[0-9a-fA-F]{2}/.test(seg)) return seg
      return encodeURIComponent(seg)
    })
    .join("/")
}

/**
 * Build a UTF-8 safe `Basic` auth token. `btoa` only handles Latin-1, so we
 * first encode the raw string into a binary-safe byte string via TextEncoder.
 */
export function basicAuth(username: string, password: string): string {
  const raw = `${username}:${password}`
  const bytes = new TextEncoder().encode(raw)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** Decode the few XML entities commonly found in WebDAV responses. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * Normalize a decoded href/path for equality comparison:
 * strip the scheme+host, percent-decode, collapse slashes and drop the
 * trailing slash so `/dav/folder` and `/dav/folder/` compare equal.
 */
export function decodeHref(href: string): string {
  let decoded = href
  try {
    decoded = decodeURIComponent(href)
  } catch {
    // keep raw value on malformed input
  }
  try {
    if (/^https?:\/\//i.test(decoded)) {
      decoded = new URL(decoded).pathname
    }
  } catch {
    // not a valid absolute URL — treat as a relative path
  }
  return cleanPath(decoded)
}

/** Extract the text content of a namespaced tag (e.g. `d:getlastmodified`). */
function getTagContent(block: string, tag: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}>`,
    "i",
  )
  const m = block.match(re)
  return m ? m[1].trim() : null
}

function parseResponseBlock(block: string): WebdavPropfindEntry | null {
  const href = getTagContent(block, "href")
  if (href === null) return null
  // `<collection/>` inside `resourcetype` marks a directory.
  const isDir = /<(?:[A-Za-z_][\w.-]*:)?collection\b/.test(block)
  const sizeStr = getTagContent(block, "getcontentlength")
  const modified = getTagContent(block, "getlastmodified") || ""
  const size = sizeStr ? parseInt(sizeStr, 10) || 0 : 0
  return {
    href: decodeXmlEntities(href),
    isDir,
    size,
    modified,
  }
}

/**
 * Parse a WebDAV `multistatus` (PROPFIND) response. Namespace prefixes vary
 * across servers (`d:`, `D:`, `ns0:`, or none), so all tag matching is
 * prefix-agnostic.
 */
export function parsePropfind(xml: string): WebdavPropfindEntry[] {
  const entries: WebdavPropfindEntry[] = []
  const responseRe =
    /<(?:[A-Za-z_][\w.-]*:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?response>/gi
  let m: RegExpExecArray | null
  while ((m = responseRe.exec(xml)) !== null) {
    const entry = parseResponseBlock(m[1])
    if (entry) entries.push(entry)
  }
  return entries
}
