/**
 * OpenList-compatible export / import endpoints.
 *
 *   POST /api/admin/export          body { format?, password? }
 *   GET  /api/admin/export?format=&password=&download=1
 *   POST /api/admin/import?override=&password=&format=
 *
 * Both endpoints live under the admin router so the existing JWT admin
 * middleware applies. The exported payload is byte-compatible with the
 * backup file the OpenList web UI produces, which means it can be imported
 * straight from OpenList's own "Backup & Restore" page — and files exported
 * by OpenList can be imported here without any manual editing.
 *
 * Only standard HTTP + JSON is involved; no local file or database access
 * is shared between the two systems.
 */

import type { Hono } from "hono"
import { getDb, saveDb, defaultDb } from "../internal/model/db"
import { checkAllStorages } from "../internal/op/health"
import { hashPassword } from "./auth"
import {
  assembleExport,
  encryptPayload,
  decryptPayload,
  storageFromOpenList,
  isDriverSupportedByNextList,
  settingsFromOpenList,
  usersFromOpenList,
  metasFromOpenList,
  toNextListDriverName,
  normDriverName,
  normMountPath,
  normPath,
  parseAddition,
  EXCLUDED_SETTING_KEYS,
  type BackupPayload,
} from "../compat/openlist"

interface LogEntry {
  type: "success" | "error" | "info"
  msg: string
}

/**
 * Convert an incoming storage row (OpenList canonical name or NextList
 * native name) into NextList's storage shape. Tolerant of both formats:
 * exact OpenList names are mapped & field-renamed, NextList-native names
 * (e.g. from a raw NextList backup) are kept as-is.
 */
function convertImportStorage(st: any): {
  storage: any
  supported: boolean
} {
  const nextlistDriver = toNextListDriverName(String(st.driver || ""))
  if (nextlistDriver) {
    return { storage: storageFromOpenList(st, true), supported: true }
  }
  // NextList-native driver (raw NextList backup) — keep addition verbatim.
  if (normDriverName(st.driver) === "local") {
    return {
      storage: {
        ...st,
        mount_path: normMountPath(st.mount_path),
        addition: JSON.stringify(parseAddition(st.addition)),
        status: "work",
      },
      supported: true,
    }
  }
  if (isDriverSupportedByNextList(String(st.driver || ""))) {
    // Covered above; kept for safety with future table changes.
    return { storage: storageFromOpenList(st, true), supported: true }
  }
  return { storage: storageFromOpenList(st, false), supported: false }
}

export function registerCompatRoutes(adminRouter: Hono) {
  // -----------------------------------------------------------------------
  // POST /api/admin/export — body: { format?: "openlist"|"nextlist", password? }
  // -----------------------------------------------------------------------
  adminRouter.post("/export", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const format = body?.format === "nextlist" ? "nextlist" : "openlist"
    const password = typeof body?.password === "string" ? body.password : ""
    const db = await getDb(c.env)
    let payload = assembleExport(db, format)
    if (password) payload = encryptPayload(payload, password)
    return c.json({ code: 200, message: "success", data: payload })
  })

  // -----------------------------------------------------------------------
  // GET /api/admin/export?format=openlist&password=&download=1
  // Convenience variant for curl / direct download links.
  // -----------------------------------------------------------------------
  adminRouter.get("/export", async (c) => {
    const format =
      c.req.query("format") === "nextlist" ? "nextlist" : "openlist"
    const password = c.req.query("password") || ""
    const db = await getDb(c.env)
    let payload = assembleExport(db, format)
    if (password) payload = encryptPayload(payload, password)
    if (c.req.query("download")) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      const name =
        format === "nextlist"
          ? `nextlist_backup_${stamp}.json`
          : `openlist_backup_${stamp}.json`
      c.header("Content-Disposition", `attachment; filename="${name}"`)
    }
    return c.json(payload)
  })

  // -----------------------------------------------------------------------
  // POST /api/admin/import?override=&password=&format=
  // Body: the backup payload ({encrypted, settings, users, storages, ...}).
  // -----------------------------------------------------------------------
  adminRouter.post("/import", async (c) => {
    const override = ["true", "1", "yes"].includes(
      (c.req.query("override") || "").toLowerCase(),
    )
    const password = c.req.query("password") || ""
    const format =
      c.req.query("format") === "nextlist" ? "nextlist" : "openlist"
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({
        code: 400,
        message: "invalid backup payload",
        data: null,
      })
    }

    const log: LogEntry[] = []
    const push = (type: LogEntry["type"], msg: string) =>
      log.push({ type, msg })
    const counts = {
      settings: 0,
      users: 0,
      storages: 0,
      metas: 0,
      shares: 0,
      skipped: 0,
      failed: 0,
    }

    try {
      const data: BackupPayload = body.encrypted
        ? decryptPayload(body, password)
        : body

      const db = await getDb(c.env)
      if (!db.storages) db.storages = []
      if (!db.metas) db.metas = []
      if (!db.users) db.users = []
      if (!db.settings) db.settings = []

      // ---------------------------------------------------------------
      // 1. settings — OpenList format: filter to keys NextList knows and
      //    re-map groups; nextlist format: apply raw (minus secret keys).
      // ---------------------------------------------------------------
      const incomingSettings: any[] = Array.isArray(data.settings)
        ? data.settings
        : []
      const settings =
        format === "nextlist"
          ? incomingSettings.filter(
              (s) => s && s.key && !EXCLUDED_SETTING_KEYS.includes(s.key),
            )
          : settingsFromOpenList(incomingSettings, defaultDb.settings)
      for (const item of settings) {
        try {
          const idx = db.settings.findIndex((s: any) => s.key === item.key)
          if (idx !== -1) {
            if (override || db.settings[idx].value !== item.value) {
              db.settings[idx].value = item.value
            }
            counts.settings++
            push("success", `setting [${item.key}] applied`)
          } else {
            db.settings.push(item)
            counts.settings++
            push("success", `setting [${item.key}] created`)
          }
        } catch (e: any) {
          counts.failed++
          push("error", `setting [${item.key}] failed: ${e.message}`)
        }
      }
      if (!settings.length) push("info", "no settings in backup")

      // ---------------------------------------------------------------
      // 2. users — general users only; passwords are never portable so a
      //    fresh import gets the NextList default password (123456).
      // ---------------------------------------------------------------
      const users = usersFromOpenList(
        Array.isArray(data.users) ? data.users : [],
      )
      for (const u of users) {
        try {
          const exists = db.users.find((x: any) => x.username === u.username)
          if (!exists) {
            const maxId = db.users.reduce(
              (m: number, x: any) => Math.max(m, x.id || 0),
              0,
            )
            db.users.push({
              id: maxId + 1,
              username: u.username,
              password: await hashPassword(u.password || "123456"),
              role: 0,
              permission: u.permission ?? 0,
              base_path: u.base_path || "/",
              disabled: !!u.disabled,
              sso_id: u.sso_id || "",
              allow_ldap: !!u.allow_ldap,
              pwd_update_at: new Date().toISOString(),
            })
            counts.users++
            push(
              "success",
              `user [${u.username}] created (password reset required)`,
            )
          } else if (override) {
            exists.base_path = u.base_path || exists.base_path
            exists.permission = u.permission ?? exists.permission
            exists.disabled = !!u.disabled
            exists.sso_id = u.sso_id || exists.sso_id
            counts.users++
            push("success", `user [${u.username}] updated`)
          } else {
            counts.skipped++
            push("info", `user [${u.username}] exists, skipped`)
          }
        } catch (e: any) {
          counts.failed++
          push("error", `user [${u.username}] failed: ${e.message}`)
        }
      }
      if (!users.length) push("info", "no importable users in backup")

      // ---------------------------------------------------------------
      // 3. storages — driver name + addition field normalization, mount
      //    path dedupe. Unsupported drivers are kept disabled so nothing
      //    is lost and the entry can be exported back to OpenList.
      // ---------------------------------------------------------------
      const storages: any[] = Array.isArray(data.storages) ? data.storages : []
      for (const st of storages) {
        const mountPath = normMountPath(st.mount_path || "")
        if (!mountPath || mountPath === "/" || !st.driver) {
          counts.failed++
          push(
            "error",
            `storage [${mountPath || st.mount_path}] invalid, skipped`,
          )
          continue
        }
        try {
          const { storage: converted, supported } = convertImportStorage(st)
          const existing = db.storages.find(
            (s: any) => normMountPath(s.mount_path) === mountPath,
          )
          if (!existing) {
            const id = db.storages.length
              ? Math.max(...db.storages.map((s: any) => s.id || 0)) + 1
              : 1
            db.storages.push({
              ...converted,
              id,
              mount_path: mountPath,
              modified: new Date().toISOString(),
            })
            counts.storages++
            push(
              supported ? "success" : "info",
              `storage [${mountPath}] (${st.driver}) imported` +
                (supported
                  ? ""
                  : " as disabled — driver unsupported by NextList"),
            )
          } else if (override) {
            db.storages[db.storages.indexOf(existing)] = {
              ...existing,
              ...converted,
              id: existing.id,
              mount_path: existing.mount_path,
              modified: new Date().toISOString(),
            }
            counts.storages++
            push("success", `storage [${mountPath}] updated`)
          } else {
            counts.skipped++
            push("info", `storage [${mountPath}] exists, skipped`)
          }
        } catch (e: any) {
          counts.failed++
          push("error", `storage [${mountPath}] failed: ${e.message}`)
        }
      }
      if (!storages.length) push("info", "no storages in backup")

      // ---------------------------------------------------------------
      // 4. metas — field names are identical on both sides.
      // ---------------------------------------------------------------
      const metas = metasFromOpenList(
        Array.isArray(data.metas) ? data.metas : [],
      )
      for (const m of metas) {
        try {
          const path = normPath(m.path || "")
          if (!path || path === "/") {
            counts.failed++
            push("error", `meta [${m.path}] invalid, skipped`)
            continue
          }
          const exists = db.metas.find((x: any) => normPath(x.path) === path)
          if (!exists) {
            const id = db.metas.length
              ? Math.max(...db.metas.map((x: any) => x.id || 0)) + 1
              : 1
            db.metas.push({ ...m, id, path })
            counts.metas++
            push("success", `meta [${path}] created`)
          } else if (override) {
            db.metas[db.metas.indexOf(exists)] = {
              ...exists,
              ...m,
              id: exists.id,
              path: exists.path,
            }
            counts.metas++
            push("success", `meta [${path}] updated`)
          } else {
            counts.skipped++
            push("info", `meta [${path}] exists, skipped`)
          }
        } catch (e: any) {
          counts.failed++
          push("error", `meta [${m.path}] failed: ${e.message}`)
        }
      }
      if (!metas.length) push("info", "no metas in backup")

      // ---------------------------------------------------------------
      // 5. shares — NextList-specific; only raw nextlist-format files
      //    carry them (OpenList has no equivalent object).
      // ---------------------------------------------------------------
      const shares = Array.isArray(data.shares) ? data.shares : []
      if (shares.length && format === "nextlist") {
        if (!db.shares) db.shares = []
        for (const s of shares) {
          try {
            if (!s?.id || db.shares.find((x: any) => x.id === s.id)) {
              counts.skipped++
              push("info", `share [${s?.id}] exists or invalid, skipped`)
              continue
            }
            db.shares.push(s)
            counts.shares++
            push("success", `share [${s.id}] created`)
          } catch (e: any) {
            counts.failed++
            push("error", `share [${s?.id}] failed: ${e.message}`)
          }
        }
      } else if (shares.length) {
        push(
          "info",
          `${shares.length} share(s) present but not importable from OpenList format — skipped`,
        )
      }

      await saveDb(db, c.env)
      // Fire-and-forget: probe every storage (including freshly imported
      // ones) so the admin UI shows truthful statuses without user action.
      // Kept off the response path — cloud drivers can take seconds each.
      try {
        const ctx = (c as any).executionCtx
        if (ctx?.waitUntil) {
          ctx.waitUntil(checkAllStorages(c.env).catch(() => {}))
        } else {
          void checkAllStorages(c.env).catch(() => {})
        }
      } catch {
        // status probing is best-effort; never break the import response
      }
      return c.json({ code: 200, message: "success", data: { log, counts } })
    } catch (e: any) {
      return c.json({
        code: 400,
        message: e.message || "import failed",
        data: { log, counts },
      })
    }
  })
}
