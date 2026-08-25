/**
 * WebDAV server — exposes all mounted storages at `/dav`.
 *
 * Protocol compatibility targets (same as AList/OpenList):
 * - RFC 4918 (WebDAV) class 1 + class 2 (fake exclusive locks)
 * - Microsoft's MS-Author-Via / "Microsoft-IIS-Server" style PROPFIND replies
 *   so Windows Explorer, macOS Finder, rclone, Cyberduck, RaiDrive etc. work.
 *
 * Authentication:
 * - HTTP Basic (username + password, same credentials as the web login)
 * - Bearer JWT (token from POST /api/auth/login)
 *
 * Authorization:
 * - read methods (PROPFIND / GET / HEAD / OPTIONS) → `webdav_read` permission
 * - write methods (PUT / MKCOL / MOVE / COPY / DELETE / PROPPATCH / LOCK /
 *   UNLOCK) → `webdav_manage` permission
 * - admins implicitly have both; guests have neither
 * - every user is jailed inside their `base_path`
 */
import { Hono } from "hono"
import { verify } from "hono/jwt"
import { getDb, resolvePath } from "../internal/model/db"
import {
  getDriver,
  flushPendingDriverState,
  listItems,
  getItem,
  makeDirectory,
  renameItem,
  removeItems,
  moveItems,
  copyItems,
  putItem,
} from "../internal/op/storage"
import { validateUserPassword } from "./auth"
import { JWT_SECRET } from "./middlewares"
import { can, PermissionBit } from "../pkg/permission"
import { parseRangeHeader } from "../internal/stream/stream"
import { mimeByExt } from "../pkg/xml"
import {
  normalizeDavPath,
  parseDestination,
  joinUserBasePath,
  splitParentPath,
  parseBasicAuth,
  generateLockToken,
  extractProppatchProps,
  extractLockOwner,
  buildWebDavPropfindResponse,
  buildWebDavProppatchResponse,
  buildWebDavLockResponse,
} from "../internal/webdav/webdav"

type DavVariables = {
  davUser: any
}

export const webdavRouter = new Hono<{ Variables: DavVariables }>()

const READ_METHODS = new Set(["OPTIONS", "PROPFIND", "GET", "HEAD"])
const XML_CONTENT_TYPE = 'application/xml; charset="utf-8"'
const ALLOW_METHODS =
  "OPTIONS, GET, HEAD, PROPFIND, PROPPATCH, MKCOL, PUT, DELETE, MOVE, COPY, LOCK, UNLOCK"

// Node fs access is lazily loaded (unavailable on edge runtimes)
let fsPromises: any = null
let createReadStream: any = null
async function initNodeModules() {
  if (
    typeof process !== "undefined" &&
    process.release?.name === "node" &&
    !fsPromises
  ) {
    try {
      fsPromises = await import("fs/promises")
      createReadStream = (await import("fs")).createReadStream
    } catch (e) {}
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** The cleaned dav-relative path of the request (before base_path mapping). */
function davRequestPath(c: any): string {
  return normalizeDavPath(c.req.path)
}

/** The storage virtual path = user base_path + dav path. */
function davVirtualPath(c: any): string {
  const user = c.get("davUser")
  return joinUserBasePath(user?.base_path, davRequestPath(c))
}

function unauthorized(c: any) {
  return c.body("401 Unauthorized: WebDAV authentication required", 401, {
    "WWW-Authenticate": 'Basic realm="NextList WebDAV", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
  })
}

/* ------------------------------------------------------------------ */
/* Authentication & authorization                                      */
/* ------------------------------------------------------------------ */

webdavRouter.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase()

  // OPTIONS advertises capabilities without authentication (Windows probe)
  if (method === "OPTIONS") return next()

  const authHeader = c.req.header("Authorization")
  let user: any = null

  if (authHeader && /^Basic\s+/i.test(authHeader)) {
    const creds = parseBasicAuth(authHeader)
    if (creds) {
      const db = await getDb(c.env)
      const candidate = (db.users || []).find(
        (u: any) => u.username === creds.username && !u.disabled,
      )
      if (
        candidate &&
        (await validateUserPassword(candidate, creds.password))
      ) {
        user = candidate
      }
    }
  } else if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    try {
      const payload = await verify(
        authHeader.replace(/^Bearer\s+/i, ""),
        JWT_SECRET,
        "HS256",
      )
      const db = await getDb(c.env)
      user =
        (db.users || []).find(
          (u: any) =>
            !u.disabled &&
            (u.id === payload.id || u.username === payload.username),
        ) || null
    } catch {
      user = null
    }
  }

  if (!user) return unauthorized(c)

  const needManage = !READ_METHODS.has(method)
  const allowed = needManage
    ? can(user, PermissionBit.WEBDAV_MANAGE)
    : can(user, PermissionBit.WEBDAV_READ)
  if (!allowed) {
    return c.body(
      `403 Forbidden: missing ${needManage ? "webdav_manage" : "webdav_read"} permission`,
      403,
    )
  }

  c.set("davUser", user)
  await next()
})

/* ------------------------------------------------------------------ */
/* OPTIONS — capability discovery                                      */
/* ------------------------------------------------------------------ */

webdavRouter.on("OPTIONS", "*", (c) => {
  c.header("Allow", ALLOW_METHODS)
  c.header("DAV", "1, 2")
  c.header("MS-Author-Via", "DAV")
  c.header("Accept-Ranges", "bytes")
  return c.body(null, 200)
})

/* ------------------------------------------------------------------ */
/* PROPFIND — directory listing / resource properties                   */
/* ------------------------------------------------------------------ */

webdavRouter.on("PROPFIND", "*", async (c) => {
  const davPath = davRequestPath(c)
  const virtualPath = davVirtualPath(c)
  const depth = (c.req.header("Depth") || "1").toLowerCase()

  let item: any = null
  try {
    item = (await getItem(virtualPath)).item
  } catch {
    item = null
  }

  // The (virtual) root is always listable even without any storage
  const isRoot = virtualPath === "/"
  if (!item && !isRoot) {
    return c.body("Not Found", 404)
  }

  const isFolder = item ? !!item.is_dir : true
  // The self displayname comes from the *virtual* path segment — driver
  // items may report the physical folder name (e.g. LocalDriver basename),
  // which would leak server internals into client listings.
  const self = {
    name: isRoot ? "/" : splitParentPath(davPath).name,
    size: item?.size || 0,
    isFolder,
    modified: item?.modified || new Date().toISOString(),
    created: item?.created,
  }

  let children: any[] = []
  if (isFolder && depth !== "0") {
    try {
      children = (await listItems(virtualPath)).content
    } catch {
      children = []
    }
  }

  const xml = buildWebDavPropfindResponse(
    davPath,
    self,
    children.map((it: any) => ({
      name: it.name,
      size: it.size || 0,
      isFolder: !!it.is_dir,
      modified: it.modified,
      created: it.created,
    })),
  )
  return c.body(xml, 207, { "Content-Type": XML_CONTENT_TYPE })
})

/* ------------------------------------------------------------------ */
/* PROPPATCH — property updates (read-only backend, best-effort 207)   */
/* ------------------------------------------------------------------ */

webdavRouter.on("PROPPATCH", "*", async (c) => {
  const davPath = davRequestPath(c)
  const virtualPath = davVirtualPath(c)
  const body = await c.req.text().catch(() => "")

  let isFolder = false
  try {
    isFolder = !!(await getItem(virtualPath)).item?.is_dir
  } catch {}

  const propNames = extractProppatchProps(body)
  const xml = buildWebDavProppatchResponse(davPath, propNames, isFolder)
  return c.body(xml, 207, { "Content-Type": XML_CONTENT_TYPE })
})

/* ------------------------------------------------------------------ */
/* MKCOL — create directory                                            */
/* ------------------------------------------------------------------ */

webdavRouter.on("MKCOL", "*", async (c) => {
  const virtualPath = davVirtualPath(c)
  if (virtualPath === "/") return c.body("Forbidden: cannot create root", 403)

  // RFC 4918 §9.3.1: a body means extended MKCOL which we don't support
  const rawBody = await c.req.arrayBuffer().catch(() => new ArrayBuffer(0))
  if (rawBody && rawBody.byteLength > 0) {
    return c.body("Unsupported Media Type: MKCOL body not supported", 415)
  }

  try {
    if ((await getItem(virtualPath)).item) {
      return c.body("Method Not Allowed: resource already exists", 405)
    }
  } catch {}

  try {
    await makeDirectory(virtualPath)
    return c.body(null, 201)
  } catch (e: any) {
    return c.body(`Conflict: ${e?.message || e}`, 409)
  }
})

/* ------------------------------------------------------------------ */
/* GET / HEAD — download (proxy for remote drivers, stream for local)  */
/* ------------------------------------------------------------------ */

async function davDownloadHandler(c: any) {
  const virtualPath = davVirtualPath(c)
  const isHead = c.req.method === "HEAD"

  let item: any
  try {
    item = (await getItem(virtualPath)).item
  } catch (e: any) {
    return c.body(`Not Found: ${e?.message || e}`, 404)
  }
  if (item.is_dir) {
    return c.body("Forbidden: cannot GET a collection", 403)
  }

  // Inline virtual content (e.g. NetEase .lrc lyrics)
  if (item.raw_content != null) {
    const bytes = new TextEncoder().encode(String(item.raw_content))
    return c.body(isHead ? null : (bytes as any), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(bytes.length),
      "Accept-Ranges": "bytes",
    })
  }

  // Remote cloud drivers: proxy the upstream raw_url (honors Range)
  if (item.raw_url) {
    const headers: Record<string, string> = {
      ...(item.raw_url_headers || {}),
    }
    if (!headers["User-Agent"]) {
      headers["User-Agent"] =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    const rangeReq = c.req.header("Range")
    if (rangeReq) headers["Range"] = rangeReq

    let upstream: Response
    try {
      upstream = await fetch(item.raw_url, { headers })
      // Strict OSS endpoints reject Range probes with 412 — retry plain GET
      if (upstream.status === 412) {
        delete headers["Range"]
        upstream = await fetch(item.raw_url, { headers })
      }
    } catch (e: any) {
      return c.body(`Upstream fetch failed: ${e?.message || e}`, 502)
    }

    if (!upstream.ok && upstream.status !== 206) {
      return c.body(
        `Upstream error: ${upstream.status} ${upstream.statusText}`,
        502,
      )
    }

    const respHeaders = new Headers()
    respHeaders.set(
      "Content-Type",
      upstream.headers.get("content-type") || mimeByExt(item.name),
    )
    const passthrough = [
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
      "cache-control",
    ]
    for (const h of passthrough) {
      const v = upstream.headers.get(h)
      if (v) respHeaders.set(h, v)
    }
    if (!respHeaders.has("Accept-Ranges")) {
      respHeaders.set("Accept-Ranges", "bytes")
    }
    return new Response(isHead ? null : upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    })
  }

  // Local driver: stream from the file system with Range support
  await initNodeModules()
  if (!fsPromises || !createReadStream) {
    return c.body("Local file streaming not supported in Edge Runtime", 500)
  }
  try {
    const resolved = await resolvePath(virtualPath)
    if (resolved.isVirtual || !resolved.physical) {
      return c.body("Not Found: virtual path has no content", 404)
    }
    const stat = await fsPromises.stat(resolved.physical)
    if (stat.isDirectory()) {
      return c.body("Forbidden: cannot GET a collection", 403)
    }

    const contentType = mimeByExt(item.name)
    const rangeHeader = c.req.header("Range")
    if (rangeHeader) {
      const { start, end, chunksize } = parseRangeHeader(rangeHeader, stat.size)
      const stream = isHead
        ? null
        : createReadStream(resolved.physical, { start, end })
      return new Response(stream as any, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Length": String(chunksize),
          "Accept-Ranges": "bytes",
        },
      })
    }
    const stream = isHead ? null : createReadStream(resolved.physical)
    return new Response(stream as any, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Last-Modified": new Date(stat.mtime).toUTCString(),
      },
    })
  } catch (e: any) {
    return c.body(`Not Found: ${e?.message || e}`, 404)
  }
}

webdavRouter.on(["GET", "HEAD"], "*", davDownloadHandler)

/* ------------------------------------------------------------------ */
/* PUT — upload                                                        */
/* ------------------------------------------------------------------ */

webdavRouter.on("PUT", "*", async (c) => {
  const virtualPath = davVirtualPath(c)
  if (virtualPath === "/") return c.body("Forbidden: cannot PUT to root", 403)

  let existed = false
  try {
    const item = (await getItem(virtualPath)).item
    if (item?.is_dir) {
      return c.body("Conflict: target is a collection", 409)
    }
    existed = true
  } catch {}

  try {
    const buffer = Buffer.from(await c.req.arrayBuffer())
    await putItem(virtualPath, buffer)
    return c.body(null, existed ? 204 : 201)
  } catch (e: any) {
    return c.body(`Upload failed: ${e?.message || e}`, 500)
  }
})

/* ------------------------------------------------------------------ */
/* DELETE — remove file or folder                                      */
/* ------------------------------------------------------------------ */

webdavRouter.on("DELETE", "*", async (c) => {
  const davPath = davRequestPath(c)
  const virtualPath = davVirtualPath(c)
  if (davPath === "/") {
    return c.body("Forbidden: cannot delete the root collection", 403)
  }

  try {
    await getItem(virtualPath)
  } catch (e: any) {
    return c.body(`Not Found: ${e?.message || e}`, 404)
  }

  const { parent, name } = splitParentPath(virtualPath)
  try {
    await removeItems(parent, [name])
    return c.body(null, 204)
  } catch (e: any) {
    return c.body(`Delete failed: ${e?.message || e}`, 500)
  }
})

/* ------------------------------------------------------------------ */
/* MOVE / COPY — rename, move and copy via Destination header           */
/* ------------------------------------------------------------------ */

webdavRouter.on(["MOVE", "COPY"], "*", async (c) => {
  const isMove = c.req.method === "MOVE"
  const davPath = davRequestPath(c)
  if (davPath === "/") {
    return c.body("Forbidden: cannot move/copy the root collection", 403)
  }
  const virtualPath = davVirtualPath(c)
  const user = c.get("davUser")

  const dstDavPath = parseDestination(c.req.header("Destination"))
  if (!dstDavPath || dstDavPath === "/") {
    return c.body("Bad Request: missing or invalid Destination header", 400)
  }
  const dstVirtual = joinUserBasePath(user?.base_path, dstDavPath)
  const overwrite = (c.req.header("Overwrite") || "T").toUpperCase() !== "F"

  if (dstVirtual === virtualPath) {
    return c.body("Forbidden: source and destination are the same", 403)
  }

  try {
    await getItem(virtualPath)
  } catch (e: any) {
    return c.body(`Not Found: ${e?.message || e}`, 404)
  }

  // Handle pre-existing destination (Overwrite: F → 412, T → remove first)
  let overwritten = false
  try {
    await getItem(dstVirtual)
    overwritten = true
    if (!overwrite) {
      return c.body("Precondition Failed: destination exists", 412)
    }
    const dstSplit = splitParentPath(dstVirtual)
    await removeItems(dstSplit.parent, [dstSplit.name])
  } catch {}

  const { parent: srcDir, name: srcName } = splitParentPath(virtualPath)
  const { parent: dstDir, name: dstName } = splitParentPath(dstVirtual)

  try {
    if (srcDir === dstDir) {
      if (isMove) {
        // Same parent → plain rename
        await renameItem(virtualPath, dstName)
      } else {
        // COPY inside the same folder under a new name (e.g. "Copy of
        // a.txt"): copyItems cannot rename, so bounce through a temp
        // sibling directory: copy → rename → move back → cleanup.
        const tmpName = `.webdav-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const tmpDir = `${srcDir}/${tmpName}`
        await makeDirectory(tmpDir)
        try {
          await copyItems(srcDir, tmpDir, [srcName])
          await renameItem(`${tmpDir}/${srcName}`, dstName)
          await moveItems(tmpDir, srcDir, [dstName])
        } finally {
          await removeItems(srcDir, [tmpName]).catch(() => {})
        }
      }
    } else if (isMove) {
      await moveItems(srcDir, dstDir, [srcName])
      if (dstName !== srcName) {
        await renameItem(`${dstDir}/${srcName}`, dstName)
      }
    } else {
      // COPY across directories (optionally renaming on the way)
      await copyItems(srcDir, dstDir, [srcName])
      if (dstName !== srcName) {
        await renameItem(`${dstDir}/${srcName}`, dstName)
      }
    }
    return c.body(null, overwritten ? 204 : 201)
  } catch (e: any) {
    return c.body(`${isMove ? "Move" : "Copy"} failed: ${e?.message || e}`, 500)
  }
})

/* ------------------------------------------------------------------ */
/* LOCK / UNLOCK — class 2 compatibility (stateless fake locks)         */
/* ------------------------------------------------------------------ */

webdavRouter.on("LOCK", "*", async (c) => {
  const davPath = davRequestPath(c)
  const body = await c.req.text().catch(() => "")
  const token = generateLockToken()
  const owner = extractLockOwner(body)
  const xml = buildWebDavLockResponse(davPath, token, owner)
  return c.body(xml, 200, {
    "Content-Type": XML_CONTENT_TYPE,
    "Lock-Token": `<${token}>`,
  })
})

webdavRouter.on("UNLOCK", "*", (c) => {
  return c.body(null, 204)
})
