/**
 * 初始安装向导（Install Wizard）
 *
 * 全新部署（数据库为空、管理员密码仍为默认值）时，前端把访客引导到
 * /install 分步完成：同意协议 → 设置管理员密码（或导入备份）→ 完成。
 *
 *   GET  /api/install/status    是否需要安装
 *   POST /api/install/complete  提交安装（协议确认 + 管理员密码 / 备份导入）
 *
 * 安全设计：
 * - 「需要安装」与「完成安装」共用同一判定：管理员一旦拥有非默认密码，
 *   或 db.install_completed === true，即视为已安装，complete 直接 403，
 *   已上线的实例无法借本接口重置管理员密码。
 * - complete 校验 Origin（浏览器跨站写请求直接拒绝），并对并发安装请求
 *   做进程内互斥，避免同一实例被同时初始化两次。
 * - 管理员密码强制 8~128 位，经 setUserPassword（带盐双层 SHA256）落库；
 *   备份导入不迁移口令（OpenList/NextList 备份均只含哈希），因此无论
 *   哪种安装方式都必须重新设置密码。
 */

import { Hono } from "hono"
import { getDb, saveDb, defaultDb } from "../internal/model/db"
import {
  setUserPassword,
  staticHash,
  verifyUserPassword,
} from "../pkg/password"
import {
  decryptPayload,
  settingsFromOpenList,
  usersFromOpenList,
  metasFromOpenList,
  normMountPath,
  normPath,
  EXCLUDED_SETTING_KEYS,
  type BackupPayload,
} from "../compat/openlist"
import { convertImportStorage } from "./compat"
import { checkAllStorages } from "../internal/op/health"

interface LogEntry {
  type: "success" | "error" | "info"
  msg: string
}

/** 进程内互斥标记：防止同一实例上的并发 complete 请求双写 */
let installInFlight = false

/** 管理员密码是否仍处于出厂默认状态（"" / "admin" / 其哈希）。 */
export async function isAdminPasswordDefault(user: any): Promise<boolean> {
  const stored = String(user?.password || "")
  if (stored === "" || stored === "admin") return true
  try {
    if (user.salt) {
      // getOrInitUsers 会把全新 admin 初始化为带盐哈希的 "admin"
      if (await verifyUserPassword("admin", user)) return true
    } else if (stored === (await staticHash("admin"))) {
      return true
    }
  } catch {
    // 校验异常时按非默认处理，避免误判已用实例为未安装
  }
  return false
}

/**
 * 是否需要进入安装向导：未显式标记完成，且管理员密码仍为默认值。
 * 存量实例升级后管理员已有真实密码，此判定返回 false，不会弹出向导。
 */
export async function isInstallRequired(env: any): Promise<boolean> {
  const db: any = await getDb(env)
  if (db?.install_completed === true) return false
  const admin = (db.users || []).find((u: any) => u.username === "admin")
  if (!admin) return true
  return await isAdminPasswordDefault(admin)
}

function parseHostOf(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    return new URL(value).host || null
  } catch {
    return null
  }
}

/**
 * 浏览器跨站写请求防御：Origin 头存在时必须与站点同源
 * （比对请求 URL / Host / X-Forwarded-Host，兼容反向代理场景）。
 * 非浏览器客户端（curl、服务端调用）不携带 Origin，不受影响。
 */
function originAllowed(c: any): boolean {
  const origin = c.req.header("Origin")
  if (!origin) return true
  const originHost = parseHostOf(origin)
  if (!originHost) return false // 显式非法 Origin（含 "null"）一律拒绝
  const candidates = [
    parseHostOf(c.req.url),
    c.req.header("host"),
    c.req.header("x-forwarded-host"),
  ]
  return candidates.some((h) => !!h && h === originHost)
}

export const installRouter = new Hono()

installRouter.get("/status", async (c) => {
  const required = await isInstallRequired(c.env)
  return c.json({ code: 200, message: "success", data: { required } })
})

installRouter.post("/complete", async (c) => {
  // 1. 已安装的实例直接拒绝 —— 防止重复安装 / 重置管理员密码
  if (!(await isInstallRequired(c.env))) {
    return c.json(
      { code: 403, message: "NextList is already installed", data: null },
      403,
    )
  }
  // 2. 浏览器跨站请求防御 + 进程内互斥
  if (!originAllowed(c)) {
    return c.json(
      { code: 403, message: "Cross-origin request rejected", data: null },
      403,
    )
  }
  if (installInFlight) {
    return c.json(
      {
        code: 409,
        message: "Another install request is in progress",
        data: null,
      },
      409,
    )
  }

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json(
      { code: 400, message: "invalid request body", data: null },
      400,
    )
  }
  if (body.agree !== true) {
    return c.json(
      { code: 400, message: "license agreement not accepted", data: null },
      400,
    )
  }

  const password = String(body.password || "")
  if (password.length < 8 || password.length > 128) {
    return c.json(
      {
        code: 400,
        message: "admin password must be 8-128 characters",
        data: null,
      },
      400,
    )
  }

  installInFlight = true
  try {
    const log: LogEntry[] = []
    const push = (type: LogEntry["type"], msg: string) =>
      log.push({ type, msg })
    const counts = { settings: 0, users: 0, storages: 0, metas: 0, shares: 0 }

    // 深拷贝后修改：导入中途失败不会污染内存中的当前数据库
    const db: any = JSON.parse(JSON.stringify(await getDb(c.env)))
    if (!db.users) db.users = []

    const admin: any =
      db.users.find((u: any) => u.username === "admin") ||
      (() => {
        const u: any = {
          id: 1,
          username: "admin",
          password: "",
          role: 2,
          permission: 0,
          base_path: "/",
          disabled: false,
          sso_id: "",
          allow_ldap: false,
          pwd_update_at: new Date().toISOString(),
        }
        db.users.unshift(u)
        return u
      })()

    // 备份导入（可选）：兼容 NextList 原生备份与 OpenList 备份两种格式
    if (body.mode === "backup") {
      const payload = body.backup
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return c.json(
          { code: 400, message: "invalid backup payload", data: null },
          400,
        )
      }
      try {
        const data: BackupPayload = payload.encrypted
          ? decryptPayload(payload, String(body.backup_password || ""))
          : payload

        // 格式探测：原生备份包含 admin/guest 内置账号，OpenList 备份没有
        const incomingUsers: any[] = Array.isArray(data.users) ? data.users : []
        const isNextlistFormat = incomingUsers.some((u) =>
          ["admin", "guest"].includes(String(u?.username || "").toLowerCase()),
        )

        // ---- 1. settings ----
        const incomingSettings: any[] = Array.isArray(data.settings)
          ? data.settings
          : []
        const settings = isNextlistFormat
          ? incomingSettings.filter(
              (s) => s && s.key && !EXCLUDED_SETTING_KEYS.includes(s.key),
            )
          : settingsFromOpenList(incomingSettings, defaultDb.settings)
        if (!db.settings) db.settings = []
        for (const item of settings) {
          const idx = db.settings.findIndex((s: any) => s.key === item.key)
          if (idx !== -1) {
            db.settings[idx].value = item.value
          } else {
            db.settings.push(item)
          }
          counts.settings++
        }
        push(
          counts.settings ? "success" : "info",
          counts.settings
            ? `${counts.settings} setting(s) applied`
            : "no settings in backup",
        )

        // ---- 2. users（仅普通用户；口令不可迁移，需安装后重置）----
        for (const u of usersFromOpenList(incomingUsers)) {
          if (db.users.some((x: any) => x.username === u.username)) {
            push("info", `user [${u.username}] exists, skipped`)
            continue
          }
          const maxId = db.users.reduce(
            (m: number, x: any) => Math.max(m, x.id || 0),
            0,
          )
          const pu: any = {
            id: maxId + 1,
            username: u.username,
            password: "",
            salt: "",
            role: 0,
            permission: u.permission ?? 0,
            base_path: u.base_path || "/",
            disabled: !!u.disabled,
            sso_id: u.sso_id || "",
            allow_ldap: !!u.allow_ldap,
            pwd_update_at: new Date().toISOString(),
          }
          await setUserPassword(pu, u.password || "123456")
          db.users.push(pu)
          counts.users++
          push(
            "success",
            `user [${u.username}] created (password reset required)`,
          )
        }
        if (!incomingUsers.length) push("info", "no users in backup")

        // ---- 3. storages ----
        const storages: any[] = Array.isArray(data.storages)
          ? data.storages
          : []
        if (!db.storages) db.storages = []
        for (const st of storages) {
          const mountPath = normMountPath(st.mount_path || "")
          if (!mountPath || mountPath === "/" || !st.driver) {
            push("error", `storage [${st.mount_path}] invalid, skipped`)
            continue
          }
          try {
            const { storage: converted, supported } = convertImportStorage(st)
            if (
              db.storages.some(
                (s: any) => normMountPath(s.mount_path) === mountPath,
              )
            ) {
              push("info", `storage [${mountPath}] exists, skipped`)
              continue
            }
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
          } catch (e: any) {
            push("error", `storage [${mountPath}] failed: ${e.message}`)
          }
        }
        if (!storages.length) push("info", "no storages in backup")

        // ---- 4. metas ----
        const metas = metasFromOpenList(
          Array.isArray(data.metas) ? data.metas : [],
        )
        if (!db.metas) db.metas = []
        for (const m of metas) {
          const path = normPath(m.path || "")
          if (!path || path === "/") {
            push("error", `meta [${m.path}] invalid, skipped`)
            continue
          }
          if (db.metas.some((x: any) => normPath(x.path) === path)) {
            push("info", `meta [${path}] exists, skipped`)
            continue
          }
          const id = db.metas.length
            ? Math.max(...db.metas.map((x: any) => x.id || 0)) + 1
            : 1
          db.metas.push({ ...m, id, path })
          counts.metas++
          push("success", `meta [${path}] created`)
        }
        if (!metas.length) push("info", "no metas in backup")

        // ---- 5. shares（仅原生备份携带）----
        const shares: any[] = Array.isArray(data.shares) ? data.shares : []
        if (shares.length && isNextlistFormat) {
          if (!db.shares) db.shares = []
          for (const s of shares) {
            if (!s?.id || db.shares.some((x: any) => x.id === s.id)) {
              push("info", `share [${s?.id}] exists or invalid, skipped`)
              continue
            }
            db.shares.push(s)
            counts.shares++
            push("success", `share [${s.id}] created`)
          }
        }
      } catch (e: any) {
        return c.json(
          {
            code: 400,
            message: e.message || "backup import failed",
            data: null,
          },
          400,
        )
      }
    }

    // 管理员密码：无论哪种安装方式都必须重新设置
    admin.disabled = false
    admin.role = 2
    await setUserPassword(admin, password)

    db.install_completed = true
    await saveDb(db, c.env)

    // 备份导入后尽力探测存储状态（与后台导入行为一致，不阻塞响应）
    if (body.mode === "backup" && counts.storages > 0) {
      try {
        const ctx = (c as any).executionCtx
        if (ctx?.waitUntil) {
          ctx.waitUntil(checkAllStorages(c.env).catch(() => {}))
        } else {
          void checkAllStorages(c.env).catch(() => {})
        }
      } catch {
        // best-effort
      }
    }

    return c.json({ code: 200, message: "success", data: { log, counts } })
  } finally {
    installInFlight = false
  }
})
