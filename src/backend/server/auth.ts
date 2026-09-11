import { Hono } from "hono"
import { sign, verify } from "hono/jwt"
import { getDb, saveDb } from "../internal/model/db"
import {
  getUserSshKeys,
  addUserSshKey,
  deleteUserSshKey,
  serializeSshKey,
} from "../internal/op/sshkey"
import {
  generateTotpSecret,
  verifyTotpCode,
  buildOtpauthUrl,
  buildQrImageUrl,
} from "../pkg/totp"
import { getJwtSecret, revokeToken, isTokenRevoked } from "./middlewares"
import { staticHash, setUserPassword } from "../pkg/password"
import { setCSRFToken, clearCSRFToken } from "../pkg/csrf"
import { getAuditLogger } from "../pkg/audit"

export const authRouter = new Hono()

// Router mounted at /me by router.ts (handles /me/sshkey/*)
type MeVariables = {
  authUser: { db: any; user: any }
}
export const meRouter = new Hono<{ Variables: MeVariables }>()

// --- 登录防爆破（KV 共享 + 指数退避）---
// 失败计数跨多实例共享（KV 持久化），并对同一 IP+用户名连续失败进行指数退避锁定。
const LOGIN_MAX_FAILURES = 5
const LOGIN_MAX_FAILURES_GLOBAL = 20
const LOGIN_LOCK_MS = 15 * 60 * 1000
const LOGIN_MAX_LOCK_MS = 24 * 60 * 60 * 1000 // 最长锁定 24 小时
const loginFailures = new Map<
  string,
  { count: number; lockedUntil: number; attempts: number }
>()

function clientIpOf(c: any): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  )
}

function loginKey(c: any, username: string): string {
  return `${clientIpOf(c)}|${String(username || "").toLowerCase()}`
}

function globalLoginKey(username: string): string {
  return `__global__|${String(username || "").toLowerCase()}`
}

function calculateLockDuration(attempts: number): number {
  const baseTime = LOGIN_LOCK_MS
  const multiplier = Math.pow(2, Math.floor(attempts / 5))
  return Math.min(baseTime * multiplier, LOGIN_MAX_LOCK_MS)
}

async function bumpLoginFailure(
  key: string,
  maxFailures: number,
  env: any,
): Promise<void> {
  const now = Date.now()
  let rec = loginFailures.get(key) || {
    count: 0,
    lockedUntil: 0,
    attempts: 0,
  }
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      const kvKey = `login_fail:${key}`
      let val: any = null
      try {
        val = await kvInfo.binding.get(kvKey, "text")
      } catch {
        val = await kvInfo.binding.get(kvKey)
      }
      if (val && typeof val.text === "function") {
        val = await val.text()
      }
      if (val) {
        try {
          rec = JSON.parse(String(val))
        } catch {
          // 解析失败，使用默认值
        }
      }
    }
  } catch {
    // KV 不可用，回退到内存模式
  }

  if (rec.lockedUntil > now) return // already locked

  rec.count += 1
  rec.attempts += 1

  if (rec.count >= maxFailures) {
    const lockDuration = calculateLockDuration(rec.attempts)
    rec.lockedUntil = now + lockDuration
    rec.count = 0
    console.warn(
      `[Auth] Login attempts exceeded for ${key}. Locked for ${Math.round(lockDuration / 60000)} minutes (attempt #${rec.attempts}).`,
    )
  }

  loginFailures.set(key, rec)

  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      const kvKey = `login_fail:${key}`
      const payload = JSON.stringify(rec)
      const ttl = Math.ceil((LOGIN_MAX_LOCK_MS + 3600000) / 1000)
      if (typeof kvInfo.binding.put === "function") {
        await kvInfo.binding.put(kvKey, payload, { expirationTtl: ttl })
      }
    }
  } catch (err) {
    console.warn("[Auth] Failed to persist login failure to KV:", err)
  }
}

async function isLoginLocked(
  c: any,
  username: string,
  env: any,
): Promise<boolean> {
  if (loginFailures.size > 10000) {
    const now = Date.now()
    for (const [k, v] of loginFailures) {
      if (v.lockedUntil < now && v.count === 0) loginFailures.delete(k)
    }
  }
  const now = Date.now()
  const ipKey = loginKey(c, username)
  const globalKey = globalLoginKey(username)
  let rec = loginFailures.get(ipKey)
  let grec = loginFailures.get(globalKey)

  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      for (const key of [ipKey, globalKey]) {
        const kvKey = `login_fail:${key}`
        let val: any = null
        try {
          val = await kvInfo.binding.get(kvKey, "text")
        } catch {
          val = await kvInfo.binding.get(kvKey)
        }
        if (val && typeof val.text === "function") {
          val = await val.text()
        }
        if (val) {
          try {
            const data = JSON.parse(String(val))
            if (key === ipKey) rec = data
            if (key === globalKey) grec = data
            loginFailures.set(key, data)
          } catch {
            // 解析失败
          }
        }
      }
    }
  } catch {
    // KV 不可用，使用内存数据
  }

  if (rec && rec.lockedUntil > now) return true
  if (grec && grec.lockedUntil > now) return true
  return false
}

async function recordLoginFailure(
  c: any,
  username: string,
  env: any,
): Promise<void> {
  await bumpLoginFailure(loginKey(c, username), LOGIN_MAX_FAILURES, env)
  await bumpLoginFailure(
    globalLoginKey(username),
    LOGIN_MAX_FAILURES_GLOBAL,
    env,
  )
}

async function clearLoginFailures(
  c: any,
  username: string,
  env: any,
): Promise<void> {
  const ipKey = loginKey(c, username)
  const globalKey = globalLoginKey(username)
  loginFailures.delete(ipKey)
  loginFailures.delete(globalKey)
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode !== "none" && kvInfo.binding) {
      for (const key of [ipKey, globalKey]) {
        const kvKey = `login_fail:${key}`
        if (typeof kvInfo.binding.delete === "function") {
          await kvInfo.binding.delete(kvKey)
        }
      }
    }
  } catch (err) {
    console.warn("[Auth] Failed to clear login failures from KV:", err)
  }
}

/** 生成 JWT 唯一标识（jti），用于注销黑名单精确失效单个 token */
function generateJti(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Resolve the authenticated user from the request, or return null. */
async function authUserFromReq(c: any): Promise<{
  db: any
  user: any
} | null> {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) return null
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  try {
    const secret = await getJwtSecret(c)
    const payload: any = await verify(token, secret, "HS256")
    if (await isTokenRevoked(payload?.jti, c.env)) return null
    const db = await getDb(c.env)
    if (!db.users) db.users = []
    const user = db.users.find(
      (u: any) => u.id === payload.id || u.username === payload.username,
    )
    return user ? { db, user } : null
  } catch {
    return null
  }
}

// Helper to hash password matching NextList/AList specification.
// 保留导出以兼容 user.ts / compat.ts。单层兼容格式；登录校验走 verifyUserPassword，
// 同时兼容带 salt 的双层格式。
export async function hashPassword(plainPassword: string): Promise<string> {
  return staticHash(plainPassword)
}

/**
 * Validate a plain password against a stored user password.
 * 兼容单层静态哈希、双层（salt）哈希，以及 bootstrap admin/admin 默认值。
 * Shared by the login endpoint /login/hash and the WebDAV Basic auth.
 */
export async function validateUserPassword(
  user: any,
  rawPassword: string,
): Promise<boolean> {
  const stored = String(user?.password || "")
  if (stored === rawPassword) return true
  if (await verifyUserPasswordFromPlain(user, rawPassword)) return true
  // bootstrap admin/admin 默认值兼容
  const defaultAdminHash = await staticHash("admin")
  if (stored === "" || stored === "admin" || stored === defaultAdminHash) {
    return rawPassword === "admin"
  }
  return false
}

/** 复用 pkg/password：兼容带 salt 双层与无 salt 单层存储 */
async function verifyUserPasswordFromPlain(
  user: any,
  plain: string,
): Promise<boolean> {
  try {
    const { verifyUserPassword } = await import("../pkg/password")
    return await verifyUserPassword(plain, {
      password: user?.password || "",
      salt: user?.salt,
    })
  } catch {
    return false
  }
}

meRouter.use("*", async (c, next) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  c.set("authUser", auth)
  await next()
})

// Ensure admin/guest users exist in DB KV space with a default password if unset.
async function getOrInitUsers(envCtx: any) {
  const db = await getDb(envCtx)
  if (!db.users || db.users.length === 0) {
    const admin: any = {
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
    await setUserPassword(admin, "admin")
    db.users = [
      admin,
      {
        id: 2,
        username: "guest",
        password: "",
        role: 1,
        permission: 0,
        base_path: "/",
        // Guest (anonymous browsing) is disabled by default so that
        // unauthenticated visitors are sent to the login page.
        disabled: true,
        sso_id: "",
        allow_ldap: false,
        pwd_update_at: new Date().toISOString(),
      },
    ]
    await saveDb(db, envCtx)
  }
  return { db, users: db.users }
}

// If the user has 2FA enabled, verify the provided OTP code.
// - No code sent → 402 (frontend switches to the TOTP input)
// - Wrong code   → 401
async function checkUserOtp(
  user: any,
  body: any,
): Promise<
  | { ok: true }
  | { ok: false; httpStatus: 401 | 402; code: 401 | 402; message: string }
> {
  if (!user.otp_secret) return { ok: true }
  const otpCode = String(body.otp_code || "").trim()
  if (!otpCode) {
    return {
      ok: false,
      httpStatus: 402,
      code: 402,
      message: "2FA code required",
    }
  }
  const valid = await verifyTotpCode(user.otp_secret, otpCode)
  if (!valid) {
    return {
      ok: false,
      httpStatus: 401,
      code: 401,
      message: "Invalid 2FA code",
    }
  }
  return { ok: true }
}

// 签发会话：生成带 jti 的 JWT（jti 用于注销黑名单精确失效），
// 设置 CSRF Cookie，并返回 token + csrf_token。
async function issueSession(c: any, user: any) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
    jti: generateJti(),
  }
  const secret = await getJwtSecret(c)
  const token = await sign(payload, secret)
  const csrfToken = setCSRFToken(c)
  return { token, csrf_token: csrfToken, role: user.role }
}

// 登录成功后：清除防爆破计数，并将旧单层哈希迁移为带 salt 的双层哈希。
async function finalizeLoginSuccess(
  c: any,
  matchedUser: any,
  rawPassword: string,
) {
  await clearLoginFailures(c, matchedUser.username, c.env)
  // 无 salt 的历史单层格式 -> 迁移为双层（带 per-user 盐）
  if (!matchedUser.salt) {
    await setUserPassword(matchedUser, rawPassword)
    const db = await getDb(c.env)
    const idx = (db.users || []).findIndex((u: any) => u.id === matchedUser.id)
    if (idx !== -1) {
      db.users[idx] = matchedUser
      await saveDb(db, c.env)
    }
  }
}

// 统一登录处理（/login 走明文，/login/hash 走前端静态哈希）
async function handleLogin(c: any, credential: string) {
  const body = await c.req.json().catch(() => ({}))
  const username = (body.username || "").trim()

  // 防爆破：IP+用户名 / 全局用户名双维度锁定
  if (await isLoginLocked(c, username, c.env)) {
    await getAuditLogger().logLoginFailure(
      c,
      username,
      "account locked (too many attempts)",
    )
    return c.json(
      {
        code: 429,
        message: "Too many login attempts. Please try again later.",
        data: null,
      },
      429,
    )
  }

  const { users } = await getOrInitUsers(c.env)
  const matchedUser = users.find(
    (u: any) => u.username === username && !u.disabled,
  )

  const passwordOk = matchedUser
    ? await validateUserPassword(matchedUser, credential)
    : false

  if (!passwordOk) {
    await recordLoginFailure(c, username, c.env)
    await getAuditLogger().logLoginFailure(c, username, "invalid credentials")
    return c.json(
      { code: 401, message: "Invalid credentials", data: null },
      401,
    )
  }

  await finalizeLoginSuccess(c, matchedUser, credential)

  const otpCheck = await checkUserOtp(matchedUser, body)
  if (!otpCheck.ok) {
    return c.json(
      { code: otpCheck.code, message: otpCheck.message, data: null },
      otpCheck.httpStatus,
    )
  }

  await getAuditLogger().logLoginSuccess(c, username)

  const session = await issueSession(c, matchedUser)
  return c.json({ code: 200, message: "success", data: session })
}

// POST /api/auth/login —— 明文密码登录
authRouter.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const rawPassword = body.password || ""
  return handleLogin(c, rawPassword)
})

// POST /api/auth/login/hash —— 前端静态哈希（StaticHash）登录
authRouter.post("/login/hash", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const inputHash = body.password || ""
  return handleLogin(c, inputHash)
})

// POST /api/me/update or /me/update
export const meUpdateHandler = async (c: any) => {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  try {
    const secret = await getJwtSecret(c)
    const payload: any = await verify(token, secret, "HS256")
    if (await isTokenRevoked(payload?.jti, c.env)) {
      return c.json({ code: 401, message: "Token revoked", data: null }, 401)
    }
    const body = await c.req.json().catch(() => ({}))
    const db = await getDb(c.env)
    if (!db.users) db.users = []

    const userIdx = db.users.findIndex(
      (u: any) => u.id === payload.id || u.username === payload.username,
    )
    if (userIdx === -1) {
      return c.json({ code: 404, message: "User not found", data: null }, 404)
    }

    const user = db.users[userIdx]
    if (body.username && body.username.trim() !== "") {
      const newUsername = body.username.trim()
      const exists = db.users.some(
        (u: any) => u.id !== user.id && u.username === newUsername,
      )
      if (exists) {
        return c.json(
          { code: 400, message: "Username already exists", data: null },
          400,
        )
      }
      user.username = newUsername
    }

    if (body.password && body.password.trim() !== "") {
      // 带 per-user 盐的双层哈希存储
      await setUserPassword(user, body.password.trim())
    }

    db.users[userIdx] = user
    await saveDb(db, c.env)

    return c.json({ code: 200, message: "success", data: null })
  } catch (e: any) {
    return c.json(
      {
        code: 401,
        message: `Unauthorized: ${e.message || "Invalid token"}`,
        data: null,
      },
      401,
    )
  }
}

// GET /api/me
export const meHandler = async (c: any) => {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) {
    return c.json(
      {
        code: 401,
        message: "Unauthorized: Missing Authorization header",
        data: null,
      },
      401,
    )
  }
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  try {
    const secret = await getJwtSecret(c)
    const payload: any = await verify(token, secret, "HS256")
    if (await isTokenRevoked(payload?.jti, c.env)) {
      return c.json({ code: 401, message: "Token revoked", data: null }, 401)
    }
    const { users } = await getOrInitUsers(c.env)
    const dbUser = users.find(
      (u: any) => u.id === payload.id || u.username === payload.username,
    )

    if (dbUser) {
      return c.json({
        code: 200,
        message: "success",
        data: {
          id: dbUser.id,
          username: dbUser.username,
          role: dbUser.role,
          permission: dbUser.permission ?? 0,
          base_path: dbUser.base_path || "/",
          disabled: !!dbUser.disabled,
          sso_id: dbUser.sso_id || "",
          allow_ldap: !!dbUser.allow_ldap,
          otp: !!dbUser.otp_secret,
        },
      })
    }

    return c.json({
      code: 200,
      message: "success",
      data: {
        id: payload.id,
        username: payload.username,
        role: payload.role,
        permission: 0,
        base_path: "/",
        disabled: false,
        sso_id: "",
        allow_ldap: false,
        otp: false,
      },
    })
  } catch (e: any) {
    return c.json(
      {
        code: 401,
        message: `Unauthorized: ${e.message || "Invalid token"}`,
        data: null,
      },
      401,
    )
  }
}

authRouter.get("/me", meHandler)
authRouter.post("/me/update", meUpdateHandler)

export const logoutHandler = async (c: any) => {
  // 通过 JWT 的 jti 将 token 加入注销黑名单，实现真正失效（含 CSRF 清除）。
  const authHeader = c.req.header("Authorization")
  if (authHeader) {
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.substring(7)
      : authHeader
    try {
      const secret = await getJwtSecret(c)
      const payload: any = await verify(token, secret, "HS256")
      if (payload?.jti) {
        await revokeToken(payload.jti, payload.exp || 0, c.env)
      }
    } catch {
      // token 已失效则无需撤销
    }
  }
  clearCSRFToken(c)
  await getAuditLogger().logLogout(c)
  return c.json({
    code: 200,
    message: "success",
    data: null,
  })
}

export const logoutGetHandler = (c: any) => {
  return c.json({
    code: 200,
    message: "success",
    data: null,
  })
}

authRouter.post("/logout", logoutHandler)
authRouter.get("/logout", logoutGetHandler)

// GET /api/me/sshkey/list
meRouter.get("/sshkey/list", async (c) => {
  const { user } = c.get("authUser")
  const keys = getUserSshKeys(user).map(serializeSshKey)
  return c.json({
    code: 200,
    message: "success",
    data: { content: keys, total: keys.length },
  })
})

// POST /api/me/sshkey/add  body: { title, key }
meRouter.post("/sshkey/add", async (c) => {
  const { db, user } = c.get("authUser")
  const body = await c.req.json().catch(() => ({}))
  const result = await addUserSshKey(user, body.title || "", body.key || "")
  if (!result.ok) {
    return c.json({ code: 400, message: result.error, data: null }, 400)
  }
  await saveDb(db, c.env)
  return c.json({
    code: 200,
    message: "success",
    data: serializeSshKey(result.key),
  })
})

// POST /api/me/sshkey/delete?id=...
meRouter.post("/sshkey/delete", async (c) => {
  const { db, user } = c.get("authUser")
  const id = c.req.query("id")
  if (!id) {
    return c.json(
      { code: 400, message: "Missing id parameter", data: null },
      400,
    )
  }
  const removed = deleteUserSshKey(user, id)
  if (!removed) {
    return c.json({ code: 404, message: "SSH key not found", data: null }, 404)
  }
  await saveDb(db, c.env)
  return c.json({
    code: 200,
    message: "success",
    data: getUserSshKeys(user).map(serializeSshKey),
  })
})

// POST /api/auth/2fa/generate — returns a fresh TOTP secret + QR image
authRouter.post("/2fa/generate", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { user } = auth
  if (user.otp_secret) {
    return c.json(
      { code: 400, message: "2FA already enabled", data: null },
      400,
    )
  }
  const secret = generateTotpSecret()
  const otpauth = buildOtpauthUrl(secret, user.username)
  return c.json({
    code: 200,
    message: "success",
    data: { qr: buildQrImageUrl(otpauth), secret },
  })
})

// POST /api/auth/2fa/verify — validate a code against the generated secret,
// then persist it on the user so future logins require the TOTP code.
authRouter.post("/2fa/verify", async (c) => {
  const auth = await authUserFromReq(c)
  if (!auth) {
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  }
  const { db, user } = auth
  const body = await c.req.json().catch(() => ({}))
  const code = String(body.code || "").trim()
  const secret = String(body.secret || "").trim()
  if (!secret) {
    return c.json(
      { code: 400, message: "Missing secret parameter", data: null },
      400,
    )
  }
  if (!/^[A-Z2-7]+$/i.test(secret)) {
    return c.json(
      { code: 400, message: "Invalid secret format", data: null },
      400,
    )
  }
  const valid = await verifyTotpCode(secret, code)
  if (!valid) {
    return c.json({ code: 400, message: "Invalid code", data: null }, 400)
  }
  user.otp_secret = secret.toUpperCase()
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "success", data: null })
})
