/**
 * 文件操作日志 (Operation Log)
 *
 * 与主配置（nextlist_config）隔离，单独存储在 KV 键 nextlist_op_logs 中。
 * 记录"谁（账号）在什么时候对哪个文件做了什么"，供管理员后台查询。
 *
 * 存储策略：
 * - 内存缓存（进程内快速读取，跨请求共享）
 * - 异步批量持久化到 KV（写合并，避免高频文件操作打爆 KV 配额）
 * - 环形裁剪：最多保留 MAX_ENTRIES 条，防止 KV 值无限膨胀
 */

export interface OpLogEntry {
  id: string
  /** 操作发生时间（ISO 8601，含时区偏移的本地展示由前端处理） */
  timestamp: string
  /** 操作者用户 ID */
  user_id?: number
  /** 操作者账号名（guest / api-token 等虚拟账号同样记录） */
  username: string
  /** 操作类型：mkdir / upload / rename / batch_rename / remove / move / copy / remove_empty_directory */
  action: string
  /** 操作目标路径（可多个，如批量删除） */
  paths: string[]
  /** 附加信息（目标目录、文件大小等） */
  details?: Record<string, any>
  /** 客户端 IP */
  ip?: string
  /** User-Agent */
  user_agent?: string
  /** 操作结果 */
  success: boolean
  /** 失败原因 */
  error?: string
  /** 耗时（毫秒） */
  duration_ms?: number
}

const OPLOG_KV_KEY = "nextlist_op_logs"
const MAX_ENTRIES = 5000
const FLUSH_INTERVAL_MS = 3000

// ---- 进程内缓存 ----
let memoryLogs: OpLogEntry[] = []
let loaded = false
let pendingFlush: Promise<void> | null = null
let dirty = false
let lastFlushAt = 0

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 读取 KV（独立键，与主配置隔离） */
async function loadFromKv(env?: any): Promise<OpLogEntry[]> {
  try {
    const { getKvBinding } = await import("./db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return []
    const { binding, mode } = kvInfo

    let val: any = null
    if (mode === "blob") {
      val = await binding.get(OPLOG_KV_KEY)
    } else {
      try {
        val = await binding.get(OPLOG_KV_KEY, "text")
      } catch {
        val = await binding.get(OPLOG_KV_KEY)
      }
    }
    if (val && typeof val.text === "function") val = await val.text()
    if (!val) return []
    const parsed = typeof val === "string" ? JSON.parse(val) : val
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.warn("[OpLog] Failed to load logs from KV:", err)
    return []
  }
}

/** 整体写回 KV */
async function saveToKv(env?: any): Promise<boolean> {
  try {
    const { getKvBinding } = await import("./db")
    const kvInfo = await getKvBinding(env)
    if (kvInfo.mode === "none" || !kvInfo.binding) return false
    const { binding, mode } = kvInfo
    const payload = JSON.stringify(memoryLogs)

    if (mode === "blob") {
      if (typeof binding.setJSON === "function") {
        await binding.setJSON(OPLOG_KV_KEY, memoryLogs)
        return true
      }
      if (typeof binding.set === "function") {
        await binding.set(OPLOG_KV_KEY, payload)
        return true
      }
    }
    if (typeof binding.put === "function") {
      await binding.put(OPLOG_KV_KEY, payload)
      return true
    }
    if (typeof binding.set === "function") {
      await binding.set(OPLOG_KV_KEY, payload)
      return true
    }
    return false
  } catch (err) {
    console.warn("[OpLog] Failed to persist logs to KV:", err)
    return false
  }
}

/**
 * 带节流的异步落盘：日志写入不阻塞业务请求；
 * 至少间隔 FLUSH_INTERVAL_MS 才真正写一次 KV，中间的写入合并进内存。
 */
function scheduleFlush(env?: any): void {
  dirty = true
  const now = Date.now()
  const elapsed = now - lastFlushAt
  const delay = Math.max(0, FLUSH_INTERVAL_MS - elapsed)
  if (pendingFlush) return
  pendingFlush = new Promise<void>((resolve) => {
    setTimeout(async () => {
      pendingFlush = null
      if (!dirty) return resolve()
      dirty = false
      lastFlushAt = Date.now()
      await saveToKv(env)
      resolve()
    }, delay)
  })
}

/** 确保内存缓存已从 KV 加载（首次访问时拉取一次） */
export async function ensureOpLogsLoaded(env?: any): Promise<void> {
  if (loaded) return
  loaded = true
  const kvLogs = await loadFromKv(env)
  if (kvLogs.length > 0) {
    memoryLogs = kvLogs
  }
}

/**
 * 记录一条文件操作日志（fire-and-forget，绝不抛出异常影响主业务）
 */
export async function logOp(
  entry: Omit<OpLogEntry, "id" | "timestamp"> & { timestamp?: string },
  env?: any,
): Promise<void> {
  try {
    await ensureOpLogsLoaded(env)
    const full: OpLogEntry = {
      id: generateId(),
      timestamp: entry.timestamp || new Date().toISOString(),
      user_id: entry.user_id,
      username: entry.username || "guest",
      action: entry.action,
      paths: entry.paths || [],
      details: entry.details,
      ip: entry.ip,
      user_agent: entry.user_agent,
      success: entry.success,
      error: entry.error,
      duration_ms: entry.duration_ms,
    }
    memoryLogs.push(full)
    if (memoryLogs.length > MAX_ENTRIES) {
      memoryLogs = memoryLogs.slice(-MAX_ENTRIES)
    }
    scheduleFlush(env)
  } catch (err) {
    console.warn("[OpLog] Failed to log operation:", err)
  }
}

export interface OpLogQueryFilters {
  username?: string
  action?: string
  /** 路径/错误信息模糊匹配 */
  keyword?: string
  success?: boolean
  start_time?: string
  end_time?: string
  page?: number
  per_page?: number
}

/**
 * 查询操作日志（内存缓存，最新在前），支持筛选 + 分页
 */
export async function queryOpLogs(
  filters: OpLogQueryFilters = {},
  env?: any,
): Promise<{ content: OpLogEntry[]; total: number }> {
  await ensureOpLogsLoaded(env)
  let results = [...memoryLogs]

  if (filters.username) {
    const u = filters.username.toLowerCase()
    results = results.filter((l) => l.username?.toLowerCase() === u)
  }
  if (filters.action) {
    const a = filters.action.toLowerCase()
    results = results.filter((l) => l.action?.toLowerCase() === a)
  }
  if (filters.keyword) {
    const kw = filters.keyword.toLowerCase()
    results = results.filter(
      (l) =>
        l.paths?.some((p) => p.toLowerCase().includes(kw)) ||
        l.error?.toLowerCase().includes(kw),
    )
  }
  if (filters.success !== undefined && filters.success !== null) {
    results = results.filter((l) => l.success === filters.success)
  }
  if (filters.start_time) {
    results = results.filter((l) => l.timestamp >= filters.start_time!)
  }
  if (filters.end_time) {
    results = results.filter((l) => l.timestamp <= filters.end_time!)
  }

  // 最新在前
  results.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )

  const total = results.length
  const page = Math.max(1, parseInt(String(filters.page)) || 1)
  const perPage = Math.min(
    200,
    Math.max(1, parseInt(String(filters.per_page)) || 30),
  )
  const start = (page - 1) * perPage
  return { content: results.slice(start, start + perPage), total }
}

/** 清空全部日志（含 KV 持久化） */
export async function clearOpLogs(env?: any): Promise<boolean> {
  await ensureOpLogsLoaded(env)
  memoryLogs = []
  dirty = false
  return saveToKv(env)
}

/** 统计信息（仪表盘用） */
export async function getOpLogStats(env?: any): Promise<{
  total: number
  today: number
  failed: number
  unique_users: number
}> {
  await ensureOpLogsLoaded(env)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStr = todayStart.toISOString()
  return {
    total: memoryLogs.length,
    today: memoryLogs.filter((l) => l.timestamp >= todayStr).length,
    failed: memoryLogs.filter((l) => !l.success).length,
    unique_users: new Set(memoryLogs.map((l) => l.username)).size,
  }
}

/** 强制立即落盘（供优雅关闭 / 测试使用） */
export async function flushOpLogs(env?: any): Promise<void> {
  if (pendingFlush) await pendingFlush
  if (dirty) {
    dirty = false
    lastFlushAt = Date.now()
    await saveToKv(env)
  }
}
