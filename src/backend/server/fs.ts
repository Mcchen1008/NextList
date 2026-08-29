import { Hono } from "hono"
import {
  listItems,
  getItem,
  makeDirectory,
  renameItem,
  removeItems,
  moveItems,
  copyItems,
  putItem,
  batchRenameItems,
  removeEmptyDirectories,
  otherOperation,
} from "../internal/op/storage"
import { searchItems } from "../internal/op/search"
import { resolveShare } from "../internal/op/share"
import { getDb } from "../internal/model/db"
import { normPath } from "../compat/openlist"

export const fsRouter = new Hono()

/**
 * OpenList-compatible meta (directory) password check.
 * Finds the meta whose path is the longest segment-wise prefix of the
 * request path; if it carries a password, the request password must match.
 * Returns an error message when access is denied, null otherwise — the
 * 403 code/message matches OpenList fs/list & fs/get exactly.
 */
async function metaPasswordError(
  reqPath: string,
  password: string,
  env?: any,
): Promise<string | null> {
  const db = await getDb(env)
  const target = normPath(reqPath)
  let best: any = null
  let bestLen = -1
  for (const m of db.metas || []) {
    const mp = normPath(m.path)
    if (
      (target === mp || target.startsWith(mp === "/" ? "/" : mp + "/")) &&
      mp.length > bestLen
    ) {
      best = m
      bestLen = mp.length
    }
  }
  if (best && best.password && best.password !== password) {
    return "password is incorrect or you have no permission"
  }
  return null
}

// GET sub-directories of a path (used by FolderTree in metas/storages editors)
fsRouter.post("/dirs", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"
  try {
    // Share path support for completeness
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return c.json({ code: 400, message: shareRes.error, data: null })
      }
      if (shareRes.virtualList) {
        const dirs = []
        for (const f of shareRes.share.files || []) {
          try {
            const { item } = await getItem(f)
            if (item.is_dir) {
              const segs = String(f).split("/").filter(Boolean)
              dirs.push({
                name: segs[segs.length - 1] || f,
                size: 0,
                is_dir: true,
                modified: item.modified || new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 1,
              })
            }
          } catch {
            // skip unlistable share items
          }
        }
        return c.json({ code: 200, message: "success", data: dirs })
      }
      const { content } = await listItems(shareRes.realPath!)
      const dirs = content
        .filter((item: any) => item.is_dir)
        .map((item: any) => ({
          name: item.name,
          size: 0,
          is_dir: true,
          modified: item.modified || new Date().toISOString(),
          sign: item.sign || "",
          thumb: item.thumb || "",
          type: 1,
        }))
      return c.json({ code: 200, message: "success", data: dirs })
    }

    const { content } = await listItems(reqPath)
    const dirs = content
      .filter((item: any) => item.is_dir)
      .map((item: any) => ({
        name: item.name,
        size: 0,
        is_dir: true,
        modified: item.modified || new Date().toISOString(),
        sign: item.sign || "",
        thumb: item.thumb || "",
        type: 1,
      }))
    return c.json({ code: 200, message: "success", data: dirs })
  } catch (err: any) {
    return c.json({ code: 500, message: err.message, data: null })
  }
})

fsRouter.post("/list", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"

  try {
    // Share path: /@s/{shareId}/...
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return c.json({ code: 400, message: shareRes.error, data: null })
      }

      // Multi-file share root → virtual list of the shared items
      if (shareRes.virtualList) {
        const items = []
        for (const f of shareRes.share.files || []) {
          const segs = String(f).split("/").filter(Boolean)
          const name = segs[segs.length - 1] || f
          try {
            const { item } = await getItem(f)
            items.push({
              name,
              size: item.size || 0,
              is_dir: !!item.is_dir,
              modified: item.modified || new Date().toISOString(),
              sign: "",
              thumb: item.thumb || "",
              type: item.type ?? 0,
            })
          } catch {
            // If getItem failed, probe by listing — a listable path is a folder
            try {
              await listItems(f)
              items.push({
                name,
                size: 0,
                is_dir: true,
                modified: new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 1,
              })
            } catch {
              items.push({
                name,
                size: 0,
                is_dir: false,
                modified: new Date().toISOString(),
                sign: "",
                thumb: "",
                type: 0,
              })
            }
          }
        }
        return c.json({
          code: 200,
          message: "success",
          data: {
            content: items,
            total: items.length,
            readme: shareRes.share.readme || "",
            header: shareRes.share.header || "",
            write: false,
            write_content_bypass: false,
            provider: "Share",
          },
        })
      }

      // Mapped to a real path — fall through to normal listing
      const { content, provider } = await listItems(shareRes.realPath!)
      const normalized = content.map((item: any) => ({
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        created: item.created || item.modified || new Date().toISOString(),
        modified: item.modified || new Date().toISOString(),
        sign: item.sign || "",
        thumb: item.thumb || "",
        type: item.type ?? 0,
      }))
      return c.json({
        code: 200,
        message: "success",
        data: {
          content: normalized,
          total: normalized.length,
          readme: shareRes.share.readme || "",
          header: shareRes.share.header || "",
          write: false,
          write_content_bypass: false,
          provider,
        },
      })
    }

    // OpenList-compatible directory password enforcement (meta).
    const metaErr = await metaPasswordError(reqPath, body.password || "", c.env)
    if (metaErr) {
      return c.json({ code: 403, message: metaErr, data: null })
    }

    const { content, provider } = await listItems(reqPath)
    // Normalize each item to the full Obj shape expected by the frontend
    const normalized = content.map((item: any) => ({
      name: item.name,
      size: item.size,
      is_dir: item.is_dir,
      created: item.created || item.modified || new Date().toISOString(),
      modified: item.modified || new Date().toISOString(),
      sign: item.sign || "",
      thumb: item.thumb || "",
      type: item.type ?? 0,
    }))
    // OpenList-compatible server-side pagination:
    // page < 1 → 1; per_page < 1 → return everything; total is the full
    // count BEFORE slicing (same semantics as OpenList fs/list).
    const page = Math.max(parseInt(body.page, 10) || 1, 1)
    const perPage = parseInt(body.per_page, 10) || 0
    const total = normalized.length
    const contentPage =
      perPage > 0
        ? normalized.slice((page - 1) * perPage, (page - 1) * perPage + perPage)
        : normalized
    return c.json({
      code: 200,
      message: "success",
      data: {
        content: contentPage,
        total,
        readme: "",
        header: "",
        write: true,
        write_content_bypass: false,
        provider,
      },
    })
  } catch (err: any) {
    return c.json({ code: 500, message: err.message, data: null })
  }
})

fsRouter.post("/get", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"
  try {
    // Share path: /@s/{shareId}/...
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return c.json({ code: 400, message: shareRes.error, data: null })
      }

      // Multi-file share root: report as a virtual folder so the frontend lists it
      if (shareRes.virtualList) {
        const shareId = reqPath.split("/").filter(Boolean)[1] || "share"
        return c.json({
          code: 200,
          message: "success",
          data: {
            name: shareId,
            size: 0,
            is_dir: true,
            modified: new Date().toISOString(),
            sign: "",
            thumb: "",
            type: 1,
            raw_url: "",
            readme: shareRes.share.readme || "",
            header: shareRes.share.header || "",
            provider: "Share",
            related: [],
            write: false,
            write_content_bypass: false,
          },
        })
      }

      // Mapped to a real path — get with share-aware raw_url (/sd/{shareId}...)
      const shareId = reqPath.split("/").filter(Boolean)[1] || ""
      const { item, provider } = await getItem(shareRes.realPath!)
      const subPath = reqPath.replace(/^\/@s\/[^/]+/, "")
      return c.json({
        code: 200,
        message: "success",
        data: {
          name: item.name,
          size: item.size,
          is_dir: item.is_dir,
          created:
            (item as any).created || item.modified || new Date().toISOString(),
          modified: item.modified,
          sign: item.sign || "",
          thumb: (item as any).thumb || "",
          type: item.type ?? 0,
          raw_url: `/api/sd/${shareId}${subPath}`,
          readme: shareRes.share.readme || "",
          header: shareRes.share.header || "",
          provider,
          related: [],
          write: false,
          write_content_bypass: false,
        },
      })
    }

    // OpenList-compatible directory password enforcement (meta).
    const metaErr = await metaPasswordError(reqPath, body.password || "", c.env)
    if (metaErr) {
      return c.json({ code: 403, message: metaErr, data: null })
    }

    const { item, provider, rawUrl } = await getItem(reqPath)
    return c.json({
      code: 200,
      message: "success",
      data: {
        name: item.name,
        size: item.size,
        is_dir: item.is_dir,
        created:
          (item as any).created || item.modified || new Date().toISOString(),
        modified: item.modified,
        sign: item.sign || "",
        thumb: (item as any).thumb || "",
        type: item.type ?? 0,
        raw_url: rawUrl,
        readme: "",
        header: "",
        provider,
        related: [],
        write: true,
        write_content_bypass: false,
      },
    })
  } catch (err: any) {
    return c.json({ code: 500, message: err.message, data: null })
  }
})

fsRouter.post("/mkdir", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"
  try {
    await makeDirectory(reqPath)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/rename", async (c) => {
  const { path: oldPath, name: newName } = await c.req.json().catch(() => ({}))
  try {
    await renameItem(oldPath, newName)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/remove", async (c) => {
  const { dir, names } = await c.req.json().catch(() => ({}))
  try {
    await removeItems(dir, names)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/move", async (c) => {
  const { src_dir, dst_dir, names } = await c.req.json().catch(() => ({}))
  try {
    await moveItems(src_dir, dst_dir, names)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.post("/copy", async (c) => {
  const { src_dir, dst_dir, names } = await c.req.json().catch(() => ({}))
  try {
    await copyItems(src_dir, dst_dir, names)
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

fsRouter.put("/put", async (c) => {
  const reqPath = decodeURIComponent(c.req.header("File-Path") || "")
  try {
    const buffer = await c.req.arrayBuffer()
    await putItem(reqPath, Buffer.from(buffer))
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

// PUT multipart form upload — frontend uploads/form.ts
fsRouter.put("/form", async (c) => {
  const reqPath = decodeURIComponent(c.req.header("File-Path") || "")
  try {
    const body = await c.req.parseBody()
    const file = body["file"] as File | undefined
    if (!file || typeof file.arrayBuffer !== "function") {
      return c.json(
        {
          code: 400,
          message: "Missing 'file' field in multipart form",
          data: null,
        },
        400,
      )
    }
    const buffer = await file.arrayBuffer()
    await putItem(reqPath, Buffer.from(buffer))
    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

// Batch rename — frontend fsBatchRename
fsRouter.post("/batch_rename", async (c) => {
  const { src_dir, rename_objects } = await c.req.json().catch(() => ({}))
  if (
    !src_dir ||
    !Array.isArray(rename_objects) ||
    rename_objects.length === 0
  ) {
    return c.json(
      {
        code: 400,
        message: "src_dir and rename_objects are required",
        data: null,
      },
      400,
    )
  }
  try {
    const { renamed, errors } = await batchRenameItems(src_dir, rename_objects)
    if (errors.length > 0) {
      return c.json({
        code: 400,
        message: `${errors.length} item(s) failed: ${errors.join("; ")}`,
        data: { renamed, errors },
      })
    }
    return c.json({
      code: 200,
      message: "success",
      data: { renamed, errors: [] },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

// Remove empty directories under src_dir — frontend fsRemoveEmptyDirectory
fsRouter.post("/remove_empty_directory", async (c) => {
  const { src_dir } = await c.req.json().catch(() => ({}))
  if (!src_dir) {
    return c.json(
      { code: 400, message: "src_dir is required", data: null },
      400,
    )
  }
  try {
    const removed = await removeEmptyDirectories(src_dir)
    return c.json({ code: 200, message: "success", data: { removed } })
  } catch (e: any) {
    return c.json({ code: 500, message: e.message, data: null })
  }
})

// Traversal search — frontend folder/Search.tsx
// body: { parent, keywords, password, scope (0=all,1=folder,2=file), page, per_page }
fsRouter.post("/search", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parent = body.parent || "/"
  const keywords = body.keywords || ""
  const scope = parseInt(body.scope, 10) || 0
  const page = Math.max(1, parseInt(body.page, 10) || 1)
  const per_page = Math.max(
    1,
    Math.min(200, parseInt(body.per_page, 10) || 100),
  )
  try {
    let searchRoot = parent
    // Search inside a share: resolve to its real path first
    if (parent.startsWith("/@s")) {
      const shareRes = await resolveShare(parent, body.password || "", c.env)
      if (!shareRes.ok) {
        return c.json({ code: 400, message: shareRes.error, data: null })
      }
      if (shareRes.virtualList) {
        return c.json({
          code: 200,
          message: "success",
          data: { content: [], total: 0 },
        })
      }
      searchRoot = shareRes.realPath!
    }
    const matches = await searchItems(searchRoot, keywords, scope)
    const total = matches.length
    const start = (page - 1) * per_page
    const content = matches.slice(start, start + per_page)
    return c.json({ code: 200, message: "success", data: { content, total } })
  } catch (err: any) {
    return c.json({ code: 500, message: err.message, data: null })
  }
})

// Driver-specific extended operations — frontend previews/aliyun_video.tsx
// body: { path, password, method, ...params }
fsRouter.post("/other", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const reqPath = body.path || "/"
  const method = body.method || ""
  if (!method) {
    return c.json(
      { code: 400, message: "Missing 'method' field", data: null },
      400,
    )
  }
  try {
    let realPath = reqPath
    if (reqPath.startsWith("/@s")) {
      const shareRes = await resolveShare(reqPath, body.password || "", c.env)
      if (!shareRes.ok) {
        return c.json({ code: 400, message: shareRes.error, data: null })
      }
      if (shareRes.virtualList) {
        return c.json({
          code: 400,
          message: "not supported for virtual share list",
          data: null,
        })
      }
      realPath = shareRes.realPath!
    }
    const data = await otherOperation(realPath, method, body)
    return c.json({ code: 200, message: "success", data })
  } catch (err: any) {
    return c.json({ code: 500, message: err.message, data: null })
  }
})

fsRouter.post("/add_offline_download", async (c) => {
  const { path: reqPath, urls } = await c.req.json().catch(() => ({}))
  if (!urls || urls.length === 0) {
    return c.json({ code: 400, message: "No URLs provided" })
  }

  /* 
  // Offline download is not supported in stateless Serverless environments 
  // as it requires a long-running background process or specialized task queue.
  downloadOfflineFile(urls, reqPath).catch((err) => {
    console.error("Async offline download background job failed:", err)
  })
  */
  return c.json({
    code: 200,
    message:
      "Offline download task received (Note: background processing limited in Serverless mode)",
    data: null,
  })
})
