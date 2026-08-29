import { getDb, saveDb, resolvePath } from "../model/db"
import { getDriver } from "./storage"

/**
 * Storage health-check module.
 *
 * The admin UI used to show a hardcoded `status: "work"` for every storage
 * regardless of the real driver state (broken token, dead endpoint, disabled
 * storage, ...). This module performs an actual round-trip against the
 * configured driver — getDriver() (which runs driver-specific init, e.g.
 * OAuth token refresh) followed by a real `list()` of the mount root — and
 * derives a truthful status:
 *
 *   - "disabled"  storage is disabled (no network call performed)
 *   - "work"      driver init + root listing succeeded
 *   - "exception" anything failed; the trimmed error message is recorded
 */

export type StorageHealthStatus = "work" | "exception" | "disabled"

export interface StorageHealthResult {
  id: number
  mount_path: string
  driver: string
  status: StorageHealthStatus
  message: string
  checked_at: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_MESSAGE_LEN = 300

/** Reject slow drivers so a hanging endpoint cannot stall admin requests. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    )
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export function normalizeErrorMessage(e: unknown): string {
  let msg: string
  if (e instanceof Error) msg = e.message
  else if (typeof e === "string") msg = e
  else {
    try {
      msg = JSON.stringify(e)
    } catch {
      msg = String(e)
    }
  }
  msg = (msg || "unknown error").trim()
  if (msg.length > MAX_MESSAGE_LEN) msg = msg.slice(0, MAX_MESSAGE_LEN) + "…"
  return msg
}

/**
 * Run a real health probe against one storage row. Never throws — every
 * failure mode is folded into a StorageHealthResult.
 */
export async function checkStorageHealth(
  storage: any,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<StorageHealthResult> {
  const base = {
    id: storage.id,
    mount_path: storage.mount_path,
    driver: storage.driver,
    checked_at: new Date().toISOString(),
  }

  if (storage.disabled) {
    return { ...base, status: "disabled", message: "" }
  }

  try {
    // resolvePath only matches enabled storages; the probe therefore also
    // verifies the mount path is actually reachable in the routing table.
    const resolved = await withTimeout(
      resolvePath(storage.mount_path),
      timeoutMs,
      "resolving mount path",
    )
    const storageCfg = resolved.storage ?? storage
    // getDriver runs driver init (token refresh, login, ...) and throws on
    // bad credentials/config.
    const driver = await withTimeout(
      getDriver(storage.driver, storageCfg),
      timeoutMs,
      "driver init",
    )
    const physical = resolved.physical ?? "/"
    await withTimeout(
      driver.list(storage.mount_path, physical),
      timeoutMs,
      "listing mount root",
    )
    return { ...base, status: "work", message: "" }
  } catch (e) {
    return {
      ...base,
      status: "exception",
      message: normalizeErrorMessage(e),
    }
  }
}

/** Write a probe result back onto a storage row (mutates in place). */
export function applyHealthResult(storage: any, r: StorageHealthResult): void {
  storage.status = r.status
  storage.status_message = r.message || ""
  storage.checked_at = r.checked_at
}

/**
 * Probe a single storage by id, persist the outcome and return the result.
 * Returns null when the id does not exist.
 */
export async function checkStorageById(
  id: number,
  envCtx?: any,
  timeoutMs?: number,
): Promise<StorageHealthResult | null> {
  const db = await getDb(envCtx)
  const storage = (db.storages || []).find((s: any) => s.id === id)
  if (!storage) return null
  const result = await checkStorageHealth(storage, timeoutMs)
  applyHealthResult(storage, result)
  await saveDb(db, envCtx)
  return result
}

/**
 * Probe every storage sequentially (network drivers are talkative — no need
 * to hammer them in parallel), persist all outcomes and return the list.
 */
export async function checkAllStorages(
  envCtx?: any,
  timeoutMs?: number,
): Promise<StorageHealthResult[]> {
  const db = await getDb(envCtx)
  const results: StorageHealthResult[] = []
  for (const storage of db.storages || []) {
    const r = await checkStorageHealth(storage, timeoutMs)
    applyHealthResult(storage, r)
    results.push(r)
  }
  await saveDb(db, envCtx)
  return results
}
