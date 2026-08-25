// E2E verification: mount the real backend Hono app, call the admin driver
// endpoints with a valid JWT, and assert every driver in /driver/names has
// a complete form config in /driver/list and /driver/info.
import { Hono } from "hono"
import { sign } from "hono/jwt"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import backendApp from "../src/backend/index"
import { JWT_SECRET } from "../src/backend/server/middlewares"

const app = new Hono()
app.route("/", backendApp)

async function main() {
  // Mint an admin JWT the same way the auth route does.
  const now = Math.floor(Date.now() / 1000)
  const token = await sign(
    { id: 1, username: "admin", role: 2, iat: now, exp: now + 600 },
    JWT_SECRET,
    "HS256",
  )
  const headers = { Authorization: `Bearer ${token}` }

  let failures = 0
  const fail = (msg: string) => {
    console.error("FAIL:", msg)
    failures++
  }

  // --- 1. GET /api/admin/driver/names ---
  const namesRes = await app.request("/api/admin/driver/names", { headers })
  const namesBody = await namesRes.json()
  if (namesBody.code !== 200) {
    console.error("driver/names error:", namesBody)
    process.exit(1)
  }
  const names: string[] = namesBody.data
  console.log(`driver/names: ${names.length} drivers`)

  // --- 2. GET /api/admin/driver/list ---
  const listRes = await app.request("/api/admin/driver/list", { headers })
  const listBody = await listRes.json()
  if (listBody.code !== 200) {
    console.error("driver/list error:", listBody)
    process.exit(1)
  }
  const configs: Record<string, any> = listBody.data
  console.log(`driver/list: ${Object.keys(configs).length} configs`)

  // --- 3. Every name must have a config (and vice versa for ported) ---
  for (const name of names) {
    const cfg = configs[name]
    if (!cfg) {
      fail(
        `driver/names contains '${name}' but driver/list has NO config for it`,
      )
      continue
    }
    if (cfg.name !== name) {
      fail(`config '${name}' has internal name '${cfg.name}'`)
    }
    if (!Array.isArray(cfg.common) || cfg.common.length === 0) {
      fail(`config '${name}' has no common fields`)
    }
    if (!Array.isArray(cfg.additional)) {
      fail(`config '${name}' has no additional fields`)
    } else if (cfg.additional.length === 0) {
      fail(
        `config '${name}' has EMPTY additional fields (form would render nothing)`,
      )
    }
    if (!cfg.config || typeof cfg.config.name !== "string") {
      fail(`config '${name}' missing .config block`)
    }
    if (!cfg.default_mount_path) {
      fail(`config '${name}' missing default_mount_path`)
    }
  }

  // --- 4. Orphan configs (in list but not in names) ---
  for (const key of Object.keys(configs)) {
    if (!names.includes(key)) {
      console.warn(
        `WARN: driver/list has config '${key}' but it is not in driver/names (unreachable from dropdown)`,
      )
    }
  }

  // --- 5. /driver/info for every name ---
  for (const name of names) {
    const res = await app.request(
      `/api/admin/driver/info?driver=${encodeURIComponent(name)}`,
      { headers },
    )
    const body = await res.json()
    if (body.code !== 200) {
      fail(`driver/info failed for '${name}': ${body.message}`)
      continue
    }
    if (body.data?.name !== name) {
      fail(
        `driver/info('${name}') returned config for '${body.data?.name}' — falls back to AliyundriveOpen?`,
      )
    }
  }

  // --- 6. Storage-layer mapping: every config name must be accepted by getDriver() ---
  // (normalized name check against the if/else chain in op/storage.ts)
  const normalize = (s: string) =>
    (s || "").toLowerCase().replace(/[^a-z0-9]/g, "")
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(
    path.resolve(__dirname, "../src/backend/internal/op/storage.ts"),
    "utf8",
  )
  for (const name of names) {
    if (name === "Local") continue
    const norm = normalize(name)
    if (!source.includes(`"${norm}"`)) {
      fail(
        `getDriver() chain has no alias for normalized name '${norm}' (from '${name}')`,
      )
    }
  }

  console.log("")
  if (failures > 0) {
    console.error(`${failures} FAILURES`)
    process.exit(1)
  }
  console.log(
    "ALL CHECKS PASSED ✓ — every driver name has a complete form config",
  )
}

main().catch((e) => {
  console.error("fatal:", e)
  process.exit(1)
})
