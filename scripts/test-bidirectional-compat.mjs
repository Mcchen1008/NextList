/**
 * Live bidirectional compatibility test between NextList and OpenList.
 *
 *   phase1: seed NextList → export (OpenList format) → import into OpenList
 *           via its own admin create APIs (exactly what OpenList's web UI
 *           backup-restore does) → verify rows + fs semantics on both sides
 *           → build an OpenList-side snapshot (frontend-equivalent backup).
 *   phase2: import the OpenList snapshot into a FRESH NextList via
 *           POST /api/admin/import → verify conversions; encrypted backup
 *           round-trip (OpenSSL/crypto-js format).
 *
 * Run: node scripts/test-bidirectional-compat.mjs phase1|phase2
 */

import fs from "node:fs"
import nodeCrypto from "node:crypto"

const NL = "http://127.0.0.1:3000"
const OL = "http://127.0.0.1:5244"
const NL_DATA = "/tmp/nl-data"
const phase = process.argv[2] || "phase1"

let passed = 0
let failed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra)?.slice(0, 300) : "")
  }
}
function section(name) {
  console.log(`\n== ${name} ==`)
}

async function login(base, username, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  const j = await r.json()
  if (j.code !== 200) throw new Error(`login failed on ${base}: ${JSON.stringify(j)}`)
  return j.data.token
}

async function api(base, token, method, path, body) {
  const headers = { "Content-Type": "application/json" }
  if (token) headers.Authorization = token
  const r = await fetch(`${base}${path}`, {
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

/** crypto-js OpenSSL-compatible decrypt (EVP_BytesToKey(MD5) + AES-128-CBC). */
function decryptOpenSSL(b64Outer, password) {
  const inner = Buffer.from(b64Outer, "base64").toString("utf8")
  const raw = Buffer.from(inner, "base64")
  if (raw.subarray(0, 8).toString("utf8") !== "Salted__") {
    throw new Error("not an OpenSSL salted blob")
  }
  const salt = raw.subarray(8, 16)
  const data = raw.subarray(16)
  let d = Buffer.alloc(0)
  let prev = Buffer.alloc(0)
  // crypto-js EvpKDF defaults: MD5, 1 iteration, keySize=256bit + iv 128bit
  while (d.length < 48) {
    prev = nodeCrypto
      .createHash("md5")
      .update(Buffer.concat([prev, Buffer.from(password, "utf8"), salt]))
      .digest()
    d = Buffer.concat([d, prev])
  }
  const decipher = nodeCrypto.createDecipheriv(
    "aes-256-cbc",
    d.subarray(0, 32),
    d.subarray(32, 48),
  )
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

// ---------------------------------------------------------------------------

if (phase === "phase1") {
  section("PHASE 1-A: seed NextList")
  const token = await login(NL, "admin", "admin")

  // Local test dataset: 30 files + 2 dirs (protected + sub with 5 files)
  fs.rmSync(NL_DATA, { recursive: true, force: true })
  fs.mkdirSync(`${NL_DATA}/protected`, { recursive: true })
  fs.mkdirSync(`${NL_DATA}/sub`, { recursive: true })
  for (let i = 1; i <= 30; i++) {
    fs.writeFileSync(`${NL_DATA}/file_${String(i).padStart(2, "0")}.txt`, `content ${i}`)
  }
  for (let i = 1; i <= 5; i++) fs.writeFileSync(`${NL_DATA}/sub/s${i}.txt`, `s ${i}`)
  fs.writeFileSync(`${NL_DATA}/protected/inner.txt`, "top secret")

  // Seed storages (drivers that exist on both sides)
  const storages = [
    ["/local", "local", { root_folder_path: NL_DATA }],
    ["/webdav", "WebDav", { address: "http://127.0.0.1:9/dav", username: "u", password: "p", root_folder_path: "/" }],
    ["/aliyun", "AliyundriveOpen", { refresh_token: "rt_test", root_folder_id: "root", drive_type: "resource" }],
    ["/123", "123Pan", { username: "u1", password: "p1", root_id: "7", access_token: "tk_test", upload_thread: "3", platform: "web" }],
    ["/od", "Onedrive", { refresh_token: "rt_od", region: "global", root_folder_path: "/" }],
    ["/seafile", "Seafile", { address: "http://127.0.0.1:9", repo_id: "rid1", repo_pwd: "rpw" }],
    ["/139", "139Cloud", { root_id: "cid", username: "u", password: "p" }],
  ]
  for (const [mount, driver, addition] of storages) {
    const r = await api(NL, token, "POST", "/api/admin/storage/create", {
      mount_path: mount,
      driver,
      addition: JSON.stringify(addition),
      remark: "",
    })
    check(`NextList storage create ${mount} (${driver})`, r.json?.code === 200, r.json)
  }

  // settings / users / metas
  let r = await api(NL, token, "POST", "/api/admin/setting/save", [
    { key: "site_title", value: "NextList Compat Test" },
    { key: "announcement", value: "compat-announcement" },
  ])
  check("NextList seed settings", r.json?.code === 200, r.json)
  r = await api(NL, token, "POST", "/api/admin/user/create", {
    username: "alice", password: "alicepw", role: 0, base_path: "/alice", permission: 8,
  })
  check("NextList seed user alice", r.json?.code === 200, r.json)
  r = await api(NL, token, "POST", "/api/admin/user/create", {
    username: "bob", password: "bobpw", role: 0, base_path: "/", permission: 31,
  })
  check("NextList seed user bob", r.json?.code === 200, r.json)
  r = await api(NL, token, "POST", "/api/admin/meta/create", {
    path: "/local/protected", password: "pw123", readme: "secret readme", hide: "",
  })
  check("NextList seed meta", r.json?.code === 200, r.json)

  section("PHASE 1-B: NextList fs/list semantics (OpenList parity)")
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local" })
  check("full list ok", r.json?.code === 200 && r.json.data.content.length === 32 && r.json.data.total === 32, r.json?.data?.total)
  check("content item shape", (() => {
    const it = r.json.data.content.find((x) => x.name === "file_01.txt")
    return it && ["name","size","is_dir","created","modified","sign","thumb","type"].every((k) => k in it) && it.is_dir === false
  })(), r.json?.data?.content?.[0])
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local", page: 2, per_page: 10 })
  check("page2/per_page10 → 10 items + total 32", r.json?.data?.content?.length === 10 && r.json?.data?.total === 32, r.json?.data?.total)
  check("page2 starts at 11th item", r.json?.data?.content?.[0]?.name === "file_11.txt", r.json?.data?.content?.[0]?.name)
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local", page: 4, per_page: 10 })
  check("page4 → 2 items", r.json?.data?.content?.length === 2, r.json?.data?.content?.length)
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local", page: 9, per_page: 10 })
  check("beyond last page → empty content, total kept", r.json?.data?.content?.length === 0 && r.json?.data?.total === 32)
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local/protected" })
  check("meta password wrong → 403", r.json?.code === 403, r.json)
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local/protected", password: "pw123" })
  check("meta password right → 200", r.json?.code === 200 && r.json.data.content.length === 1, r.json)
  r = await api(NL, null, "POST", "/api/fs/get", { path: "/local/file_01.txt" })
  check("fs/get raw_url present", r.json?.code === 200 && !!r.json?.data?.raw_url && r.json.data.name === "file_01.txt", r.json?.data?.name)

  section("PHASE 1-C: NextList export (OpenList format)")
  r = await api(NL, token, "POST", "/api/admin/export", { format: "openlist" })
  check("export ok", r.json?.code === 200, r.json?.message)
  const exp = r.json.data
  fs.writeFileSync("/tmp/nl_export.json", JSON.stringify(exp, null, 2))
  check("envelope keys", ["encrypted","settings","users","storages","metas","shares"].every((k) => k in exp))
  const byMount = Object.fromEntries(exp.storages.map((s) => [s.mount_path, s]))
  check("storage count", exp.storages.length === 7, exp.storages.length)
  check("Local name + addition string", byMount["/local"]?.driver === "Local" && JSON.parse(byMount["/local"].addition).root_folder_path === NL_DATA)
  const s123 = JSON.parse(byMount["/123"]?.addition || "{}")
  check("123Pan addition root_folder_id", s123.root_folder_id === "7", s123)
  check("123Pan addition AccessToken", s123.AccessToken === "tk_test", s123)
  check("123Pan UploadThread numeric", s123.UploadThread === 3, s123)
  check("Seafile repoId", JSON.parse(byMount["/seafile"]?.addition || "{}").repoId === "rid1")
  check("139Cloud→139Yun + root_folder_id", byMount["/139"]?.driver === "139Yun" && JSON.parse(byMount["/139"].addition).root_folder_id === "cid")
  check("WebDav name kept", byMount["/webdav"]?.driver === "WebDav")
  check("AliyundriveOpen name kept", byMount["/aliyun"]?.driver === "AliyundriveOpen")
  check("OpenList-only storage fields present", exp.storages.every((s) =>
    ["cache_expiration","custom_cache_policies","disable_index","enable_sign","proxy_range","down_proxy_url","disable_proxy_sign","webdav_policy","extract_folder","order_by","order_direction"].every((k) => k in s)))
  check("addition serialized as string", exp.storages.every((s) => typeof s.addition === "string"))
  check("no secret settings exported", !exp.settings.some((s) => ["token","version","index_progress"].includes(s.key)))
  check("site_title exported with group 1", exp.settings.some((s) => s.key === "site_title" && s.group === 1 && s.value === "NextList Compat Test"))
  check("users: only alice+bob, empty passwords", exp.users.length === 2 && exp.users.every((u) => u.password === "" && u.role === 0) && exp.users.map((u) => u.username).sort().join(",") === "alice,bob")
  check("meta exported", exp.metas.some((m) => m.path === "/local/protected" && m.password === "pw123"))

  section("PHASE 1-D: import NextList export into OpenList (frontend-equivalent)")
  const olt = await login(OL, "admin", "admin")
  let allAccepted = true
  for (const st of exp.storages) {
    const rr = await api(OL, olt, "POST", "/api/admin/storage/create", st)
    const ok = rr.json?.code === 200 || !!rr.json?.data?.id
    if (!ok) { allAccepted = false; console.error("   create fail", st.mount_path, JSON.stringify(rr.json)) }
  }
  check("OpenList accepted all 7 storages", allAccepted)
  r = await api(OL, olt, "POST", "/api/admin/setting/save", exp.settings)
  check("OpenList setting/save", r.json?.code === 200, r.json)
  let usersOk = true
  for (const u of exp.users) {
    const rr = await api(OL, olt, "POST", "/api/admin/user/create", u)
    if (rr.json?.code !== 200) { usersOk = false; console.error("   user fail", u.username, JSON.stringify(rr.json)) }
  }
  check("OpenList created alice+bob", usersOk)
  let metasOk = true
  for (const m of exp.metas) {
    const rr = await api(OL, olt, "POST", "/api/admin/meta/create", m)
    if (rr.json?.code !== 200) { metasOk = false; console.error("   meta fail", m.path, JSON.stringify(rr.json)) }
  }
  check("OpenList created metas", metasOk)

  section("PHASE 1-E: verify rows inside OpenList")
  r = await api(OL, olt, "GET", "/api/admin/storage/list")
  const olStorages = Object.fromEntries((r.json?.data?.content || []).map((s) => [s.mount_path, s]))
  const ol123 = JSON.parse(olStorages["/123"]?.addition || "{}")
  check("OpenList /123 root_folder_id", ol123.root_folder_id === "7", ol123)
  check("OpenList /123 AccessToken", ol123.AccessToken === "tk_test")
  check("OpenList /123 UploadThread int", ol123.UploadThread === 3 && typeof ol123.UploadThread === "number")
  check("OpenList /seafile repoId", JSON.parse(olStorages["/seafile"]?.addition || "{}").repoId === "rid1")
  check("OpenList /139Yun root_folder_id", olStorages["/139"]?.driver === "139Yun" && JSON.parse(olStorages["/139"].addition).root_folder_id === "cid")
  check("OpenList /local root_folder_path", JSON.parse(olStorages["/local"]?.addition || "{}").root_folder_path === NL_DATA)
  check("OpenList storage model fields", ["cache_expiration","enable_sign","proxy_range","down_proxy_url"].every((k) => k in (olStorages["/local"] || {})))
  r = await api(OL, olt, "GET", "/api/admin/user/list")
  const olUsers = (r.json?.data?.content || []).map((u) => u.username).sort().join(",")
  check("OpenList users list", olUsers === "admin,alice,bob,guest", olUsers)
  r = await api(OL, olt, "GET", "/api/admin/setting/list")
  check("OpenList site_title imported", (r.json?.data || []).some((s) => s.key === "site_title" && s.value === "NextList Compat Test"))
  check("OpenList no NextList-only keys", !(r.json?.data || []).some((s) => s.key === "nextlist_only_key"))

  section("PHASE 1-F: OpenList fs semantics parity")
  r = await api(OL, olt, "POST", "/api/fs/list", { path: "/local", page: 2, per_page: 10 })
  check("OpenList page2 → 10 + total 32", r.json?.code === 200 && r.json.data.content.length === 10 && r.json.data.total === 32, r.json?.data?.total)
  // OpenList admins bypass directory passwords (upstream behavior), so the
  // password check is verified as a guest — the same identity NextList's
  // unauthenticated fs router effectively uses.
  r = await api(OL, olt, "POST", "/api/admin/user/update", { id: 2, username: "guest", role: 1, disabled: false })
  check("OpenList guest enabled", r.json?.code === 200, r.json)
  r = await api(OL, null, "POST", "/api/fs/list", { path: "/local/protected" })
  check("OpenList meta password wrong (guest) → 403", r.json?.code === 403, r.json)
  r = await api(OL, null, "POST", "/api/fs/list", { path: "/local/protected", password: "pw123" })
  check("OpenList meta password right (guest) → 200", r.json?.code === 200 && r.json.data.content.length === 1, r.json)

  section("PHASE 1-G: OpenList-side changes for reverse test")
  r = await api(OL, olt, "POST", "/api/admin/setting/save", [
    { key: "site_title", value: "OpenList Side Title" },
    { key: "s3_access_key_id", value: "ak-test" },
  ])
  check("OpenList update settings", r.json?.code === 200, r.json)
  r = await api(OL, olt, "POST", "/api/admin/storage/create", {
    mount_path: "/s3bucket", driver: "S3",
    addition: JSON.stringify({ bucket: "b", endpoint: "e", access_key_id: "a", secret_access_key: "s" }),
  })
  check("OpenList S3 storage created", r.json?.code === 200 || !!r.json?.data?.id, r.json)
  r = await api(OL, olt, "POST", "/api/admin/storage/create", {
    mount_path: "/tianyi", driver: "139Yun",
    addition: JSON.stringify({ root_folder_id: "cid2", username: "u", password: "p" }),
  })
  check("OpenList 139Yun storage created", r.json?.code === 200 || !!r.json?.data?.id, r.json)

  // OpenList frontend-equivalent backup snapshot
  const [st, us, sto, me] = await Promise.all([
    api(OL, olt, "GET", "/api/admin/setting/list"),
    api(OL, olt, "GET", "/api/admin/user/list"),
    api(OL, olt, "GET", "/api/admin/storage/list"),
    api(OL, olt, "GET", "/api/admin/meta/list"),
  ])
  const snapshot = {
    encrypted: "",
    settings: st.json?.data || [],
    users: us.json?.data?.content || [],
    storages: sto.json?.data?.content || [],
    metas: me.json?.data?.content || [],
    shares: [],
  }
  fs.writeFileSync("/tmp/ol_snapshot.json", JSON.stringify(snapshot, null, 2))
  check("OpenList snapshot built", snapshot.storages.length >= 9 && snapshot.users.length === 4)
  console.log(`\nPHASE1 RESULT: ${passed} passed, ${failed} failed`)
  if (failures.length) console.log("failures:", failures.join(" | "))
  process.exit(failed ? 1 : 0)
}

// ---------------------------------------------------------------------------

if (phase === "phase2") {
  section("PHASE 2-A: fresh NextList imports OpenList snapshot")
  const token = await login(NL, "admin", "admin")
  const snapshot = JSON.parse(fs.readFileSync("/tmp/ol_snapshot.json", "utf8"))
  let r = await api(NL, token, "POST", "/api/admin/import?override=true", snapshot)
  check("import ok", r.json?.code === 200, r.json?.message)
  const counts = r.json?.data?.counts || {}
  const log = r.json?.data?.log || []
  check("no error entries in import log", !log.some((l) => l.type === "error"), log.filter((l) => l.type === "error"))
  check("storages imported >= 9", counts.storages >= 9, counts)
  check("users imported (alice,bob)", counts.users === 2, counts)
  check("metas imported", counts.metas >= 1, counts)
  check("settings applied", counts.settings >= 5, counts)

  section("PHASE 2-B: verify converted rows in NextList")
  r = await api(NL, token, "GET", "/api/admin/storage/list")
  const nlSt = Object.fromEntries((r.json?.data?.content || []).map((s) => [s.mount_path, s]))
  check("/tianyi → 139Cloud", nlSt["/tianyi"]?.driver === "139Cloud", nlSt["/tianyi"]?.driver)
  check("/tianyi root_id", JSON.parse(nlSt["/tianyi"]?.addition || "{}").root_id === "cid2")
  check("/s3bucket kept disabled", nlSt["/s3bucket"]?.disabled === true && nlSt["/s3bucket"]?.driver === "S3")
  check("/s3bucket remark explains", String(nlSt["/s3bucket"]?.remark || "").includes("not supported"))
  const nl123 = JSON.parse(nlSt["/123"]?.addition || "{}")
  check("/123 AccessToken→access_token", nl123.access_token === "tk_test", nl123)
  check("/123 root_folder_id→root_id", nl123.root_id === "7", nl123)
  check("/seafile repoId→repo_id", JSON.parse(nlSt["/seafile"]?.addition || "{}").repo_id === "rid1")
  check("/local driver + root", nlSt["/local"]?.driver === "local" && JSON.parse(nlSt["/local"].addition).root_folder_path === NL_DATA)
  check("OpenList-only fields preserved (cache_expiration)", nlSt["/local"]?.cache_expiration !== undefined)

  r = await api(NL, token, "GET", "/api/admin/setting/list")
  const nlSet = Object.fromEntries((r.json?.data || []).map((s) => [s.key, s.value]))
  check("site_title from OpenList", nlSet.site_title === "OpenList Side Title", nlSet.site_title)
  check("OpenList-only setting dropped (s3_access_key_id)", !("s3_access_key_id" in nlSet))
  const olTokenValue = snapshot.settings.find((s) => s.key === "token")?.value
  check("NextList token NOT overwritten", nlSet.token !== olTokenValue, { nl: nlSet.token, ol: olTokenValue })

  r = await api(NL, token, "GET", "/api/admin/user/list")
  const nlUsers = Object.fromEntries((r.json?.data?.content || []).map((u) => [u.username, u]))
  check("alice imported", nlUsers.alice?.base_path === "/alice" && nlUsers.alice?.role === 0)
  check("bob imported", !!nlUsers.bob)
  check("no admin/guest duplicates", r.json?.data?.content?.filter((u) => u.username === "admin").length === 1)

  r = await api(NL, token, "GET", "/api/admin/meta/list")
  const nlMeta = (r.json?.data?.content || []).find((m) => m.path === "/local/protected")
  check("meta imported with password", nlMeta?.password === "pw123")

  section("PHASE 2-C: fs semantics after import")
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local/protected" })
  check("meta password enforced after import → 403", r.json?.code === 403, r.json)
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local/protected", password: "pw123" })
  check("meta password accepted after import", r.json?.code === 200, r.json)
  r = await api(NL, null, "POST", "/api/fs/list", { path: "/local", page: 2, per_page: 10 })
  check("pagination after import", r.json?.code === 200 && r.json.data.total === 32, r.json?.data?.total)

  section("PHASE 2-D: encrypted export (crypto-js/OpenSSL format) round trip")
  r = await api(NL, token, "POST", "/api/admin/export", { format: "openlist", password: "pw12345" })
  check("encrypted export ok", r.json?.code === 200 && !!r.json?.data?.encrypted, r.json?.message)
  const enc = r.json.data
  fs.writeFileSync("/tmp/nl_export_enc.json", JSON.stringify(enc, null, 2))
  let markerOk = false
  try {
    markerOk = decryptOpenSSL(enc.encrypted, "pw12345") === '"encrypted"'
  } catch (e) {
    console.error("   decrypt error:", e.message)
  }
  check("OpenSSL decrypt marker (frontend-compatible)", markerOk)
  const decStorages = enc.storages.map((s) => {
    const out = {}
    for (const k in s) out[k] = JSON.parse(decryptOpenSSL(s[k], "pw12345"))
    return out
  })
  check("decrypt storage fields", decStorages.some((s) => s.mount_path === "/tianyi" && s.driver === "139Yun"))
  const decSettings = enc.settings.map((s) => {
    const out = {}
    for (const k in s) out[k] = JSON.parse(decryptOpenSSL(s[k], "pw12345"))
    return out
  })
  check("decrypt settings fields", decSettings.some((s) => s.key === "site_title" && s.value === "OpenList Side Title"))

  r = await api(NL, token, "POST", "/api/admin/import?override=true&password=pw12345", enc)
  check("encrypted import into NextList ok", r.json?.code === 200, r.json?.message)
  r = await api(NL, token, "POST", "/api/admin/import?override=true&password=WRONG", enc)
  check("wrong password rejected", r.json?.code === 400, r.json?.code)

  section("PHASE 2-E: round-trip closure (NextList → OpenList format again)")
  r = await api(NL, token, "POST", "/api/admin/export", { format: "openlist" })
  const exp2 = r.json.data
  const exp2ByMount = Object.fromEntries(exp2.storages.map((s) => [s.mount_path, s]))
  check("139Cloud→139Yun again", exp2ByMount["/tianyi"]?.driver === "139Yun")
  check("S3 preserved verbatim + disabled", exp2ByMount["/s3bucket"]?.driver === "S3" && exp2ByMount["/s3bucket"]?.disabled === true)
  check("root_id→root_folder_id again", JSON.parse(exp2ByMount["/tianyi"]?.addition || "{}").root_folder_id === "cid2")
  check("mount paths survive full cycle", ["/local","/123","/od","/seafile","/139","/webdav","/aliyun","/tianyi","/s3bucket"].every((m) => m in exp2ByMount))

  console.log(`\nPHASE2 RESULT: ${passed} passed, ${failed} failed`)
  if (failures.length) console.log("failures:", failures.join(" | "))
  process.exit(failed ? 1 : 0)
}
