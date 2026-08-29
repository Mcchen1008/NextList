// End-to-end test: storage health-check status display.
// Usage: node scripts/test-status-display.mjs [base]
// The NextList dev server must already be running (see run-status-test.sh).
import assert from "node:assert/strict"

const NL = process.argv[2] || "http://127.0.0.1:3000"
let passed = 0
let failed = 0
function check(name, cond, extra = "") {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name} ${extra}`)
  }
}

async function login(username, password) {
  const r = await fetch(`${NL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  const j = await r.json()
  if (j.code !== 200) throw new Error(`login failed: ${JSON.stringify(j)}`)
  return j.data.token
}

async function api(token, method, path, body) {
  const headers = { "Content-Type": "application/json" }
  if (token) headers.Authorization = token
  const r = await fetch(`${NL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let j = null
  try {
    j = await r.json()
  } catch {}
  return { http: r.status, json: j }
}

async function main() {
  console.log("== login ==")
  const token = await login("admin", "admin")

  // Clean slate: remove leftovers from previous runs.
  let r = await api(token, "GET", "/api/admin/storage/list")
  for (const s of r.json.data?.content || []) {
    if (s.mount_path?.startsWith("/t-")) {
      await api(token, "POST", `/api/admin/storage/delete?id=${s.id}`)
    }
  }

  // ------------------------------------------------------------------
  console.log("\n== T1 create healthy Local storage -> status work ==")
  r = await api(token, "POST", "/api/admin/storage/create", {
    mount_path: "/t-local",
    driver: "Local",
    order: 0,
    remark: "e2e",
    addition: JSON.stringify({ root_folder_path: "/tmp" }),
  })
  check("create ok", r.json?.code === 200, JSON.stringify(r.json))
  const localId = r.json?.data?.id
  check(
    "immediate probe: work",
    r.json?.data?.status === "work",
    `status=${r.json?.data?.status} msg=${r.json?.data?.status_message}`,
  )

  // ------------------------------------------------------------------
  console.log("\n== T2 create dead-endpoint WebDav -> status exception ==")
  r = await api(token, "POST", "/api/admin/storage/create", {
    mount_path: "/t-dead",
    driver: "WebDav",
    order: 0,
    remark: "e2e",
    addition: JSON.stringify({
      address: "http://127.0.0.1:59999",
      username: "",
      password: "",
      root_folder_path: "/",
    }),
  })
  check("create ok (kept despite error)", r.json?.code === 200)
  const deadId = r.json?.data?.id
  check(
    "immediate probe: exception",
    r.json?.data?.status === "exception",
    `status=${r.json?.data?.status}`,
  )
  check(
    "error message recorded",
    typeof r.json?.data?.status_message === "string" &&
      r.json.data.status_message.length > 0,
    `msg=${r.json?.data?.status_message}`,
  )

  // ------------------------------------------------------------------
  console.log("\n== T3 list derives statuses ==")
  r = await api(token, "GET", "/api/admin/storage/list")
  const rows = Object.fromEntries(
    (r.json?.data?.content || []).map((s) => [s.mount_path, s]),
  )
  check("local row work", rows["/t-local"]?.status === "work")
  check("dead row exception", rows["/t-dead"]?.status === "exception")

  // ------------------------------------------------------------------
  console.log("\n== T4 single check endpoint ==")
  r = await api(token, "POST", `/api/admin/storage/check?id=${deadId}`)
  check("check dead -> exception", r.json?.data?.status === "exception")
  check(
    "check result carries fields",
    r.json?.data?.id === deadId &&
      r.json?.data?.mount_path === "/t-dead" &&
      !!r.json?.data?.checked_at,
  )
  r = await api(token, "POST", `/api/admin/storage/check?id=${localId}`)
  check("check local -> work", r.json?.data?.status === "work")
  r = await api(token, "POST", "/api/admin/storage/check?id=999999")
  check("unknown id -> 404", r.json?.code === 404)

  // ------------------------------------------------------------------
  console.log("\n== T5 disable / enable transitions ==")
  await api(token, "POST", `/api/admin/storage/disable?id=${deadId}`)
  r = await api(token, "GET", "/api/admin/storage/list")
  let row = (r.json.data.content || []).find((s) => s.id === deadId)
  check("disabled row shows disabled", row?.status === "disabled")
  check("message cleared on disable", !row?.status_message)

  await api(token, "POST", `/api/admin/storage/enable?id=${deadId}`)
  r = await api(token, "GET", "/api/admin/storage/list")
  row = (r.json.data.content || []).find((s) => s.id === deadId)
  check(
    "enable re-probes -> exception again",
    row?.status === "exception",
    `status=${row?.status}`,
  )

  // ------------------------------------------------------------------
  console.log("\n== T6 update re-probes ==")
  // Point Local at a nonexistent directory -> must flip to exception.
  await api(token, "POST", "/api/admin/storage/update", {
    id: localId,
    mount_path: "/t-local",
    driver: "Local",
    addition: JSON.stringify({ root_folder_path: "/nonexistent-e2e-dir-xyz" }),
  })
  r = await api(token, "GET", "/api/admin/storage/list")
  row = (r.json.data.content || []).find((s) => s.id === localId)
  check(
    "broken root -> exception",
    row?.status === "exception",
    `status=${row?.status} msg=${row?.status_message}`,
  )
  // Fix it back -> must flip to work.
  await api(token, "POST", "/api/admin/storage/update", {
    id: localId,
    mount_path: "/t-local",
    driver: "Local",
    addition: JSON.stringify({ root_folder_path: "/tmp" }),
  })
  r = await api(token, "GET", "/api/admin/storage/list")
  row = (r.json.data.content || []).find((s) => s.id === localId)
  check("fixed root -> work", row?.status === "work", `status=${row?.status}`)

  // Client cannot forge status fields.
  await api(token, "POST", "/api/admin/storage/update", {
    id: localId,
    mount_path: "/t-local",
    driver: "Local",
    status: "exception",
    status_message: "forged",
    addition: JSON.stringify({ root_folder_path: "/tmp" }),
  })
  r = await api(token, "GET", "/api/admin/storage/list")
  row = (r.json.data.content || []).find((s) => s.id === localId)
  check("status field forgery ignored", row?.status === "work")

  // ------------------------------------------------------------------
  console.log("\n== T7 check_all ==")
  r = await api(token, "POST", "/api/admin/storage/check_all")
  const results = r.json?.data || []
  check("check_all ok", r.json?.code === 200 && Array.isArray(results))
  check(
    "covers all storages",
    results.length === (await api(token, "GET", "/api/admin/storage/list")).json
      .data.content.length,
    `results=${results.length}`,
  )
  const deadRes = results.find((x) => x.mount_path === "/t-dead")
  const localRes = results.find((x) => x.mount_path === "/t-local")
  check("dead exception in batch", deadRes?.status === "exception")
  check("local work in batch", localRes?.status === "work")

  // ------------------------------------------------------------------
  console.log("\n== T8 cleanup ==")
  for (const id of [localId, deadId]) {
    await api(token, "POST", `/api/admin/storage/delete?id=${id}`)
  }
  r = await api(token, "GET", "/api/admin/storage/list")
  check(
    "cleanup done",
    !(r.json.data.content || []).some((s) => s.mount_path?.startsWith("/t-")),
  )

  console.log(`\n======== RESULT: ${passed} passed, ${failed} failed ========`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
