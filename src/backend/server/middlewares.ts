import { Context } from "hono"
import { verify } from "hono/jwt"
import { checkAdminAuth } from "../pkg/utils"
import { getDb } from "../internal/model/db"

// 动态 JWT 密钥。优先使用环境变量 JWT_SECRET（生产配置推荐），
// 否则从 KV 持久化一个随机密钥（首次生成后复用，重启不失效），
// 开发环境（无 KV）回退到进程内随机密钥。不再硬编码默认值。
let cachedJwtSecret: string | null = null
const JWT_SECRET_KV_KEY = "nextlist_jwt_secret"

/**
 * 清除进程内 JWT secret 缓存。
 * 对应 Go 的 sign.Instance()：reset_token 后调用此函数，
 * 强制下次请求从 KV/env 重新加载新密钥，使旧 token 全部失效。
 */
export function resetJwtSecretCache(): void {
  cachedJwtSecret = null
}

function generateRandomSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

async function readKvSecret(env: any): Promise<string | null> {
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return null
    const { binding, mode } = kvInfo
    let val: any = null
    if (mode === "blob") {
      val = await binding.get(JWT_SECRET_KV_KEY)
    } else {
      try {
        val = await binding.get(JWT_SECRET_KV_KEY, "text")
      } catch {
        val = await binding.get(JWT_SECRET_KV_KEY)
      }
    }
    if (val && typeof val.text === "function") {
      val = await val.text()
    }
    return val ? String(val) : null
  } catch (e) {
    console.warn("[JWT] Failed to read secret from KV:", e)
    return null
  }
}

async function writeKvSecret(env: any, secret: string): Promise<boolean> {
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return false
    const { binding, mode } = kvInfo
    if (mode === "blob") {
      if (typeof binding.set === "function")
        await binding.set(JWT_SECRET_KV_KEY, secret)
      else if (typeof binding.put === "function")
        await binding.put(JWT_SECRET_KV_KEY, secret)
    } else {
      if (typeof binding.put === "function")
        await binding.put(JWT_SECRET_KV_KEY, secret)
      else if (typeof binding.set === "function")
        await binding.set(JWT_SECRET_KV_KEY, secret)
    }
    return true
  } catch (e) {
    console.warn("[JWT] Failed to persist secret to KV:", e)
    return false
  }
}

/**
 * 获取 JWT 签名密钥。
 * 优先级：env.JWT_SECRET > KV 持久化随机密钥 > 进程内随机密钥（仅开发环境）。
 * 兼容旧版静态密钥：若旧进程使用了固定密钥登录，升级后 token 会因密钥更换而失效，
 * 通常需要重新登录（符合安全迁移预期）。
 */
export async function getJwtSecret(c?: Context | any): Promise<string> {
  const env =
    c?.env || (typeof process !== "undefined" ? (process as any).env : {}) || {}

  // 1. 环境变量显式配置（最优先，建议长度 >= 32）
  const envSecret = env.JWT_SECRET
  if (envSecret && envSecret.length >= 32) {
    return envSecret
  }
  if (envSecret && envSecret.length >= 16) {
    console.warn(
      "[JWT] JWT_SECRET 长度不足 32 字符，建议使用更长的密钥以提高安全性。",
    )
    return envSecret
  }

  // 2. KV 持久化密钥（跨实例/重启稳定）
  const kvSecret = await readKvSecret(env)
  if (kvSecret && kvSecret.length >= 32) {
    return kvSecret
  }

  // 3. 检查是否为生产环境
  const isProduction =
    env.NODE_ENV === "production" ||
    env.ENVIRONMENT === "production" ||
    env.CF_PAGES === "1" ||
    env.WORKERS_ENV === "production"

  // 4. 生成随机密钥并尝试持久化到 KV
  if (!cachedJwtSecret) {
    cachedJwtSecret = generateRandomSecret()
    const persisted = await writeKvSecret(env, cachedJwtSecret)
    if (isProduction) {
      console.error(
        "[JWT] 生产环境安全警告：JWT_SECRET 未配置！" +
          (persisted
            ? " 已自动生成密钥并持久化到 KV，强烈建议手动配置 >=32 字符的 JWT_SECRET。"
            : " 无法持久化密钥到 KV，重启后所有 token 将失效，请立即配置 JWT_SECRET。"),
      )
    } else {
      console.warn(
        "[JWT] 开发环境警告：JWT_SECRET 未配置，使用临时随机密钥。" +
          (persisted
            ? " 密钥已持久化到 KV。"
            : " 密钥仅存于内存，重启后所有 token 将失效。"),
      )
    }
  }
  return cachedJwtSecret
}

// ---- JWT 注销黑名单（进程内 Set + KV 持久化）----
// Serverless 多实例下各实例独立缓存，KV 持久化在冷启动时加载一次，
// 因此跨实例「即时」失效无法绝对保证，但单实例内立即生效，并随新实例冷启动收敛。
const REVOKED_KV_KEY = "nextlist_revoked_tokens"
const revokedJtis = new Set<string>()
let revokedLoaded = false

async function ensureRevokedLoaded(env: any): Promise<void> {
  if (revokedLoaded) return
  revokedLoaded = true
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return
    const { binding, mode } = kvInfo
    let val: any = null
    if (mode === "blob") {
      val = await binding.get(REVOKED_KV_KEY)
    } else {
      try {
        val = await binding.get(REVOKED_KV_KEY, "text")
      } catch {
        val = await binding.get(REVOKED_KV_KEY)
      }
    }
    if (val && typeof val.text === "function") val = await val.text()
    if (!val) return
    const arr = JSON.parse(String(val))
    const now = Math.floor(Date.now() / 1000)
    for (const item of arr) {
      if (item && item.jti && item.exp > now) revokedJtis.add(item.jti)
    }
  } catch {
    // 黑名单加载失败时降级为不拦截（不影响登录）
  }
}

export async function revokeToken(
  jti: string,
  exp: number,
  env: any,
): Promise<void> {
  if (!jti) return
  revokedJtis.add(jti)
  try {
    const { getKvBinding } = await import("../internal/model/db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return
    const { binding, mode } = kvInfo
    let arr: Array<{ jti: string; exp: number }> = []
    if (mode === "blob") {
      const val = await binding.get(REVOKED_KV_KEY)
      if (val) arr = typeof val === "string" ? JSON.parse(val) : val
    } else {
      try {
        const val = await binding.get(REVOKED_KV_KEY, "text")
        if (val) arr = JSON.parse(String(val))
      } catch {
        const val = await binding.get(REVOKED_KV_KEY)
        if (val) arr = typeof val === "string" ? JSON.parse(val) : val
      }
    }
    const now = Math.floor(Date.now() / 1000)
    arr = arr.filter((i) => i && i.exp > now)
    arr.push({ jti, exp })
    const payload = JSON.stringify(arr)
    if (mode === "blob") {
      if (typeof binding.set === "function")
        await binding.set(REVOKED_KV_KEY, payload)
      else if (typeof binding.put === "function")
        await binding.put(REVOKED_KV_KEY, payload)
    } else {
      if (typeof binding.put === "function")
        await binding.put(REVOKED_KV_KEY, payload)
      else if (typeof binding.set === "function")
        await binding.set(REVOKED_KV_KEY, payload)
    }
  } catch (e) {
    console.warn("[JWT] Failed to persist revoked token to KV:", e)
  }
}

export async function isTokenRevoked(jti: string, env: any): Promise<boolean> {
  if (!jti) return false
  await ensureRevokedLoaded(env)
  return revokedJtis.has(jti)
}

export async function adminAuthMiddleware(
  c: Context,
  next: () => Promise<void>,
) {
  const isAdmin = await checkAdminAuth(c)
  if (!isAdmin) {
    return c.json(
      {
        code: 401,
        message: "Unauthorized admin privilege required",
        data: null,
      },
      401,
    )
  }
  await next()
}

// ============ CSRF 防护 ============
/**
 * 生成 CSRF Token（短期有效，1 小时过期），基于 JWT 签名。
 */
export async function generateCSRFToken(c: Context): Promise<string> {
  const { sign } = await import("hono/jwt")
  const secret = await getJwtSecret(c)
  const token = await sign(
    {
      type: "csrf",
      jti: crypto.randomUUID
        ? crypto.randomUUID()
        : generateRandomSecret().slice(0, 16),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 小时过期
    },
    secret,
  )
  return token
}

/**
 * CSRF 保护中间件：对 POST/PUT/DELETE/PATCH 请求验证 CSRF token。
 * GET/HEAD/OPTIONS 请求豁免。仅允许从 HTTP Header 获取 token
 * （移除 Query 和 Body 来源，防止 JSON 劫持与 URL 泄露绕过）。
 * 纯公开端点（/api/public、/api/auth/login 等）由调用方自行豁免或走独立路由。
 */
export async function csrfProtection(c: Context, next: () => Promise<void>) {
  const method = c.req.method.toUpperCase()
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return next()
  }
  const token = c.req.header("x-csrf-token") || c.req.header("X-CSRF-Token")
  if (!token) {
    return c.json(
      {
        code: 403,
        message: "CSRF token missing. Please include X-CSRF-Token header.",
        data: null,
      },
      403,
    )
  }
  try {
    const { verify: verifyJwt } = await import("hono/jwt")
    const secret = await getJwtSecret(c)
    const payload: any = await verifyJwt(token, secret, "HS256")
    if (payload.type !== "csrf") {
      throw new Error("Invalid token type")
    }
    await next()
  } catch {
    return c.json(
      {
        code: 403,
        message: "Invalid or expired CSRF token",
        data: null,
      },
      403,
    )
  }
}

// ============ 审计日志中间件 ============
/**
 * 记录所有状态修改操作（POST/PUT/DELETE/PATCH）。
 * 审计写入失败不影响主业务。
 */
export async function auditMiddleware(c: Context, next: () => Promise<void>) {
  const startTime = Date.now()
  const method = c.req.method.toUpperCase()
  const path = c.req.path
  const shouldAudit = ["POST", "PUT", "DELETE", "PATCH"].includes(method)

  await next()

  if (shouldAudit) {
    try {
      const { logAudit } = await import("../internal/model/audit")
      const user = await getUserFromContext(c).catch(() => null)
      const duration = Date.now() - startTime
      const statusCode = c.res.status || 200
      const status =
        statusCode >= 200 && statusCode < 400 ? "success" : "failure"
      const ip =
        c.req.header("cf-connecting-ip") ||
        c.req.header("x-real-ip") ||
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown"

      await logAudit(
        {
          user_id: user?.id,
          username: user?.username || "anonymous",
          ip,
          action: `${method} ${path}`,
          resource: path,
          method,
          status,
          status_code: statusCode,
          details: JSON.stringify({ duration_ms: duration }),
          user_agent: c.req.header("user-agent"),
          duration_ms: duration,
        },
        c.env,
      )
    } catch (err) {
      console.warn("[Audit] Failed to log:", err)
    }
  }
}

/**
 * 从请求上下文解析当前用户：
 * - 静态 API Token（与 checkAdminAuth 同源）→ 视为管理员
 * - JWT（Authorization header 或 query 参数 token/access_token）→ 查询 DB 用户
 * - 无凭证时若存在且未禁用的 guest 用户才返回游客信息；否则返回 null。
 */
export async function getUserFromContext(c: Context): Promise<{
  id?: number
  role: number
  permission: number
  disabled?: boolean
  username?: string
  base_path?: string
  sso_id?: string
  allow_ldap?: boolean
  otp_secret?: string
} | null> {
  // 静态 API token（settings.token）命中才视为匿名管理员
  if (await isStaticApiToken(c)) {
    return {
      role: 2,
      permission: 0,
      disabled: false,
      username: "api-token",
      base_path: "/",
    }
  }

  let authHeader = c.req.header("Authorization")
  if (!authHeader) {
    const queryToken = c.req.query("token") || c.req.query("access_token")
    if (queryToken) {
      authHeader = `Bearer ${queryToken}`
    }
  }

  if (!authHeader) {
    try {
      const db = await getDb(c.env)
      const guest = (db.users || []).find((u: any) => u.username === "guest")
      if (guest && !guest.disabled) {
        return {
          id: guest.id,
          role: guest.role ?? 1,
          permission: guest.permission ?? 0,
          disabled: !!guest.disabled,
          username: guest.username,
          base_path: guest.base_path || "/",
          sso_id: guest.sso_id || "",
          allow_ldap: !!guest.allow_ldap,
          otp_secret: guest.otp_secret,
        }
      }
    } catch {}
    return null
  }

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  try {
    const secret = await getJwtSecret(c)
    const payload: any = await verify(token, secret, "HS256")
    if (await isTokenRevoked(payload?.jti, c.env)) return null
    const db = await getDb(c.env)
    const user = (db.users || []).find(
      (u: any) => u.id === payload.id || u.username === payload.username,
    )
    if (!user || user.disabled) return null
    return {
      id: user.id,
      role: user.role,
      permission: user.permission ?? 0,
      disabled: !!user.disabled,
      username: user.username,
      base_path: user.base_path || "/",
      sso_id: user.sso_id || "",
      allow_ldap: !!user.allow_ldap,
      otp_secret: user.otp_secret,
    }
  } catch {
    return null
  }
}

/**
 * 判断请求是否通过了静态 API token 认证（与 checkAdminAuth 同源）。
 */
async function isStaticApiToken(c: Context): Promise<boolean> {
  const authHeader = c.req.header("Authorization")
  if (!authHeader) return false
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : authHeader
  try {
    const db = await getDb(c.env)
    const tokenSetting = (db.settings || []).find((s: any) => s.key === "token")
    return !!(
      tokenSetting &&
      tokenSetting.value &&
      token === tokenSetting.value
    )
  } catch {
    return false
  }
}
