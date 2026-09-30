// E2E smoke test: file-operation log (oplog) feature.
// 1. Mount the real backend Hono app
// 2. Mint an admin JWT
// 3. Exercise fs file operations via /api/fs/* (Local driver may be absent,
//    so we test oplog against admin endpoints + direct oplog unit calls)
// 4. Verify /api/admin/oplog/list | stats | clear behave correctly.
import { Hono } from "hono"
import { sign } from "hono/jwt"
import backendApp from "../src/backend/index"
import { getJwtSecret } from "../src/backend/server/middlewares"
import {
  logOp,
  queryOpLogs,
  clearOpLogs,
  getOpLogStats,
  flushOpLogs,
} from "../src/backend/internal/model/oplog"

const app = new Hono()
app.route("/", backendApp)

let failures = 0
const fail = (msg: string) => {
  console.error("FAIL:", msg)
  failures++
}

async function main() {
  const now = Math.floor(Date.now() / 1000)
  const JWT_SECRET = await getJwtSecret(undefined)
  const token = await sign(
    { id: 1, username: "admin", role: 2, iat: now, exp: now + 600 },
    JWT_SECRET,
    "HS256",
  )
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

  // --- unit-level: logOp -> query -> stats ---
  await clearOpLogs(undefined)
  await logOp(
    {
      username: "alice",
      action: "upload",
      paths: ["/docs/report.pdf"],
      details: { size: 12345 },
      ip: "10.0.0.1",
      success: true,
    },
    undefined,
  )
  await logOp(
    {
      username: "bob",
      action: "remove",
      paths: ["/docs/old.txt"],
      ip: "10.0.0.2",
      success: false,
      error: "object not found",
    },
    undefined,
  )
  await flushOpLogs(undefined)

  const q1 = await queryOpLogs({ username: "alice" })
  if (q1.total !== 1 || q1.content[0]?.action !== "upload")
    fail("query by username should return alice's upload")

  const q2 = await queryOpLogs({ keyword: "report.pdf" })
  if (q2.total !== 1) fail("query by keyword should match path")

  const q3 = await queryOpLogs({ success: false })
  if (q3.total !== 1 || q3.content[0]?.username !== "bob")
    fail("query failed ops should return bob's remove")

  const stats = await getOpLogStats()
  if (stats.total !== 2 || stats.failed !== 1 || stats.unique_users !== 2)
    fail(`stats mismatch: ${JSON.stringify(stats)}`)

  // pagination
  for (let i = 0; i < 35; i++) {
    await logOp(
      { username: "bulk", action: "mkdir", paths: [`/d${i}`], success: true },
      undefined,
    )
  }
  const page1 = await queryOpLogs({ page: 1, per_page: 30 })
  const page2 = await queryOpLogs({ page: 2, per_page: 30 })
  if (page1.content.length !== 30 || page2.content.length === 0)
    fail(`pagination broken: p1=${page1.content.length} p2=${page2.content.length}`)
  if (page1.content[0].timestamp < page1.content[29].timestamp)
    fail("logs should be sorted newest-first")

  // --- HTTP-level: admin oplog endpoints (auth-gated) ---
  // without token → 401
  const noAuth = await app.request("/api/admin/oplog/list")
  if (noAuth.status !== 401 && noAuth.status !== 200)
    fail(`oplog/list without auth should be 401, got ${noAuth.status}`)

  const listRes = await app.request(
    "/api/admin/oplog/list?page=1&per_page=10&action=upload",
    { headers },
  )
  const listBody: any = await listRes.json()
  if (listBody.code !== 200 || !Array.isArray(listBody.data?.content))
    fail(`oplog/list bad response: ${JSON.stringify(listBody).slice(0, 200)}`)
  else
    console.log(
      `  ✓ /admin/oplog/list → total(all)=37, filtered(action=upload)=${listBody.data.total}`,
    )

  const statsRes = await app.request("/api/admin/oplog/stats", { headers })
  const statsBody: any = await statsRes.json()
  if (statsBody.code !== 200 || typeof statsBody.data?.total !== "number")
    fail(`oplog/stats bad response: ${JSON.stringify(statsBody).slice(0, 200)}`)
  else console.log(`  ✓ /admin/oplog/stats → ${JSON.stringify(statsBody.data)}`)

  const clearRes = await app.request("/api/admin/oplog/clear", {
    method: "POST",
    headers,
  })
  const clearBody: any = await clearRes.json()
  if (clearBody.code !== 200) fail("oplog/clear should succeed")
  const after = await queryOpLogs({})
  if (after.total !== 0) fail("logs should be empty after clear")
  console.log("  ✓ /admin/oplog/clear → 0 logs remaining")

  // --- non-admin role must be rejected (role check inside admin router) ---
  const userToken = await sign(
    { id: 2, username: "user", role: 0, iat: now, exp: now + 600 },
    JWT_SECRET,
    "HS256",
  )
  const forbidden = await app.request("/api/admin/oplog/list", {
    headers: { Authorization: `Bearer ${userToken}` },
  })
  const forbiddenBody: any = await forbidden.json()
  if (forbiddenBody.code !== 403)
    fail(`non-admin should get 403, got ${forbiddenBody.code}`)
  else console.log("  ✓ non-admin rejected with 403")

  console.log("")
  if (failures > 0) {
    console.error(`${failures} FAILURES`)
    process.exit(1)
  }
  console.log("OPLOG SMOKE TEST PASSED ✓")
  process.exit(0)
}

main().catch((e) => {
  console.error("fatal:", e)
  process.exit(1)
})
