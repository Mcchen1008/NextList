/**
 * WebDAV protocol helpers (pure functions, no server dependencies).
 *
 * The actual HTTP routing lives in `src/backend/server/webdav.ts`.
 */
import {
  generateWebDavPropfindXml,
  generateWebDavProppatchXml,
  generateWebDavLockXml,
  xmlEscape,
  type WebDavXmlItem,
} from "../../pkg/xml"

export interface WebDavItem {
  name: string
  size: number
  isFolder: boolean
  modified: string
  created?: string
}

export function buildWebDavPropfindResponse(
  reqPath: string,
  self: WebDavItem,
  items: WebDavItem[] = [],
): string {
  return generateWebDavPropfindXml(reqPath, self, items)
}

export function buildWebDavProppatchResponse(
  reqPath: string,
  propNames: string[],
  isFolder: boolean,
): string {
  return generateWebDavProppatchXml(reqPath, propNames, isFolder)
}

export function buildWebDavLockResponse(
  reqPath: string,
  token: string,
  owner: string,
): string {
  return generateWebDavLockXml(reqPath, token, owner)
}

/**
 * Normalize a raw request pathname into a clean virtual path:
 * - strips the `/dav` mount prefix (when present)
 * - percent-decodes each segment
 * - collapses duplicate slashes
 * Always returns a path starting with `/` (root = `/`).
 */
export function normalizeDavPath(rawPathname: string): string {
  let p = String(rawPathname || "/")
  // Strip the dav mount prefix (both "/dav" and "/dav/...")
  p = p.replace(/^\/dav(?=\/|$)/, "")
  // Decode per-segment so encoded slashes (%2F) survive as data
  const segments = p.split("/").map((seg) => {
    try {
      return decodeURIComponent(seg)
    } catch {
      return seg
    }
  })
  const clean = "/" + segments.filter((s) => s !== "" && s !== ".").join("/")
  return clean === "" ? "/" : clean
}

/**
 * Parse a `Destination` header (absolute URL or absolute path) into a clean
 * virtual path, mirroring normalizeDavPath. Returns null when unparseable.
 */
export function parseDestination(
  destinationHeader: string | undefined,
): string | null {
  if (!destinationHeader) return null
  let dest = destinationHeader.trim()
  if (!dest) return null
  if (/^https?:\/\//i.test(dest)) {
    try {
      dest = new URL(dest).pathname
    } catch {
      return null
    }
  }
  // Reject out-of-app destinations (different host is fine because we only
  // look at the path; but a path outside /dav is not addressable)
  return normalizeDavPath(dest)
}

/** Join a user base_path with a dav-relative path. */
export function joinUserBasePath(
  basePath: string | undefined,
  davPath: string,
): string {
  const base =
    "/" +
    String(basePath || "/")
      .split("/")
      .filter(Boolean)
      .join("/")
  const rest =
    "/" +
    String(davPath || "/")
      .split("/")
      .filter(Boolean)
      .join("/")
  if (base === "/") return rest
  return base + (rest === "/" ? "" : rest)
}

/** Split `/a/b/c` into `/a/b` + `c`. Root has no parent. */
export function splitParentPath(p: string): { parent: string; name: string } {
  const segments = p.split("/").filter(Boolean)
  if (segments.length === 0) return { parent: "/", name: "/" }
  const name = segments[segments.length - 1]
  const parent = "/" + segments.slice(0, -1).join("/")
  return { parent: parent === "" ? "/" : parent, name }
}

/** Parse HTTP Basic authorization header. */
export function parseBasicAuth(
  authHeader: string | undefined,
): { username: string; password: string } | null {
  if (!authHeader || !/^Basic\s+/i.test(authHeader)) return null
  try {
    const decoded = atob(authHeader.replace(/^Basic\s+/i, "").trim())
    const idx = decoded.indexOf(":")
    if (idx === -1) return null
    return {
      username: decoded.slice(0, idx),
      password: decoded.slice(idx + 1),
    }
  } catch {
    return null
  }
}

/** Generate an opaque lock token URL. */
export function generateLockToken(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `opaquelocktoken:${uuid}`
}

/** Extract the local names of properties targeted by a PROPPATCH body. */
export function extractProppatchProps(body: string): string[] {
  if (!body) return []
  const names: string[] = []
  // Match elements inside <set><prop> ... </prop></set> (any ns prefix)
  const setPropMatch = body.match(
    /<(?:\w+:)?set[^>]*>[\s\S]*?<(?:\w+:)?prop[^>]*>([\s\S]*?)<\/(?:\w+:)?prop>/i,
  )
  const scope = setPropMatch ? setPropMatch[1] : body
  // <ns:Name> → "Name"; <Name> → "Name" (closing tags can't match: "/" ≠ \w)
  const tagRegex = /<(?:(\w+):)?(\w+)/g
  let m: RegExpExecArray | null
  while ((m = tagRegex.exec(scope)) !== null) {
    const local = m[2] || m[1]
    if (
      local &&
      !names.includes(local) &&
      !/^(prop|set|remove|propertyupdate)$/i.test(local)
    ) {
      names.push(local)
    }
  }
  return names
}

/** Extract <D:owner>…</D:owner> from a LOCK body (best effort). */
export function extractLockOwner(body: string): string {
  const m = body.match(/<(?:\w+:)?owner[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/i)
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : ""
}

export { xmlEscape, type WebDavXmlItem }
