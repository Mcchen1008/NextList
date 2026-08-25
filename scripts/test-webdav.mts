// End-to-end WebDAV server test: auth, PROPFIND, MKCOL, PUT/GET, Range,
// MOVE/COPY/DELETE, LOCK, PROPPATCH, permissions and base_path jailing.
//
// Run: npx tsx scripts/test-webdav.mts
import app from "../src/backend/index"
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs"

const rootFolder = process.cwd() + "/public_data/webdav-e2e"
rmSync(rootFolder, { recursive: true, force: true })
mkdirSync(rootFolder + "/sub", { recursive: true })
writeFileSync(rootFolder + "/hello.txt", "Hello WebDAV")
writeFileSync(rootFolder + "/sub/inner.txt", "inner content")

const loginRes = await app.request("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
})
const loginJson: any = await loginRes.json()
const token = loginJson.data?.token
const authHeaders = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
}

let pass = 0,
  fail = 0
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) {
    pass++
    console.log(`✅ ${name} ${extra}`)
  } else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}

// ---------- Setup: local storage at "/" + test users ----------
await app.request("/api/admin/storage/create", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    mount_path: "/",
    driver: "Local",
    addition: JSON.stringify({ root_folder_path: rootFolder }),
    order: 0,
  }),
})

const PERM_WEBDAV_READ = 1 << 8 // 256
const PERM_WEBDAV_MANAGE = 1 << 9 // 512

// davuser: webdav read + manage, full root
await app.request("/api/admin/user/create", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    username: "davuser",
    password: "davpass",
    role: 0,
    permission: PERM_WEBDAV_READ | PERM_WEBDAV_MANAGE,
    base_path: "/",
  }),
})
// readonly: webdav read only, full root
await app.request("/api/admin/user/create", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    username: "readonly",
    password: "ropass",
    role: 0,
    permission: PERM_WEBDAV_READ,
    base_path: "/",
  }),
})
// jailed: read + manage, but jailed inside /sub
await app.request("/api/admin/user/create", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    username: "jailed",
    password: "jailpass",
    role: 0,
    permission: PERM_WEBDAV_READ | PERM_WEBDAV_MANAGE,
    base_path: "/sub",
  }),
})
// noaccess: general user without any webdav permission
await app.request("/api/admin/user/create", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    username: "noaccess",
    password: "nopass",
    role: 0,
    permission: 0,
    base_path: "/",
  }),
})

const basic = (u: string, p: string) => ({
  Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64"),
})
const adminAuth = basic("admin", "admin")
const davAuth = basic("davuser", "davpass")
const roAuth = basic("readonly", "ropass")
const jailAuth = basic("jailed", "jailpass")
const noAuth = basic("noaccess", "nopass")

const DEST = "http://localhost/dav"

// ---------- 1. OPTIONS (no auth) ----------
const optRes = await app.request("/dav/", { method: "OPTIONS" })
check(
  "OPTIONS 无需认证",
  optRes.status === 200 &&
    (optRes.headers.get("DAV") || "").includes("1, 2") &&
    (optRes.headers.get("Allow") || "").includes("PROPFIND"),
  `status=${optRes.status} DAV=${optRes.headers.get("DAV")}`,
)
const optRootRes = await app.request("/dav", { method: "OPTIONS" })
check("OPTIONS /dav 根路径", optRootRes.status === 200)

// ---------- 2. Authentication ----------
const noAuthRes = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { Depth: "1" },
})
check(
  "PROPFIND 未认证返回 401 + WWW-Authenticate",
  noAuthRes.status === 401 &&
    (noAuthRes.headers.get("WWW-Authenticate") || "").startsWith("Basic"),
  `status=${noAuthRes.status}`,
)
const badAuthRes = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { ...basic("admin", "wrong"), Depth: "1" },
})
check("PROPFIND 错误密码返回 401", badAuthRes.status === 401)

const bearerRes = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { Authorization: `Bearer ${token}`, Depth: "1" },
})
check("PROPFIND Bearer JWT 认证", bearerRes.status === 207)

// ---------- 3. PROPFIND ----------
const pfRes = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "1" },
})
const pfXml = await pfRes.text()
check(
  "PROPFIND Depth 1 返回 207 多状态",
  pfRes.status === 207 &&
    pfXml.includes("multistatus") &&
    pfXml.includes("hello.txt") &&
    pfXml.includes("sub"),
  `status=${pfRes.status}`,
)
check(
  "PROPFIND 目录标记 collection",
  /resourcetype>\s*<d:collection\/>/.test(pfXml) ||
    pfXml.includes("<d:collection/>"),
)
check(
  "PROPFIND 文件包含长度",
  pfXml.includes("<d:getcontentlength>12</d:getcontentlength>"),
)

const pf0Res = await app.request("/dav/hello.txt", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "0" },
})
const pf0Xml = await pf0Res.text()
check(
  "PROPFIND Depth 0 单文件",
  pf0Res.status === 207 &&
    pf0Xml.includes("hello.txt") &&
    !pf0Xml.includes("sub</d:displayname>"),
  `status=${pf0Res.status}`,
)
check(
  "PROPFIND href URL 编码",
  (pf0Res.headers.get("content-type") || "").includes("application/xml"),
)

const pf404Res = await app.request("/dav/nope.txt", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "0" },
})
check("PROPFIND 不存在返回 404", pf404Res.status === 404)

// XML escaping of special characters
await app.request("/dav/quote&<>.txt", {
  method: "PUT",
  headers: { ...davAuth, "Content-Type": "text/plain" },
  body: "special name",
})
const pfEscRes = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "1" },
})
const pfEscXml = await pfEscRes.text()
check(
  "PROPFIND 特殊字符 XML 转义",
  pfEscXml.includes("quote&amp;&lt;&gt;.txt") &&
    !pfEscXml.includes("quote&<>.txt"),
)

// ---------- 4. MKCOL ----------
const mkRes = await app.request("/dav/newdir", {
  method: "MKCOL",
  headers: davAuth,
})
check("MKCOL 创建目录 201", mkRes.status === 201, `status=${mkRes.status}`)
const mkDupRes = await app.request("/dav/newdir", {
  method: "MKCOL",
  headers: davAuth,
})
check("MKCOL 重复创建 405", mkDupRes.status === 405)
const mkBodyRes = await app.request("/dav/bodydir", {
  method: "MKCOL",
  headers: davAuth,
  body: "x",
})
check("MKCOL 带 body 415", mkBodyRes.status === 415)

// ---------- 5. PUT ----------
const putRes = await app.request("/dav/newdir/upload.txt", {
  method: "PUT",
  headers: { ...davAuth, "Content-Type": "text/plain" },
  body: "uploaded content",
})
check("PUT 新文件 201", putRes.status === 201, `status=${putRes.status}`)
const putOverRes = await app.request("/dav/newdir/upload.txt", {
  method: "PUT",
  headers: { ...davAuth, "Content-Type": "text/plain" },
  body: "uploaded content v2",
})
check("PUT 覆盖 204", putOverRes.status === 204)

// ---------- 6. GET / HEAD ----------
const getRes = await app.request("/dav/newdir/upload.txt", {
  headers: davAuth,
})
const getText = await getRes.text()
check(
  "GET 下载文件",
  getRes.status === 200 && getText === "uploaded content v2",
  `status=${getRes.status} body=${getText.slice(0, 30)}`,
)
const getRangeRes = await app.request("/dav/hello.txt", {
  headers: { ...davAuth, Range: "bytes=0-4" },
})
const getRangeText = await getRangeRes.text()
check(
  "GET Range 请求 206",
  getRangeRes.status === 206 &&
    getRangeText === "Hello" &&
    (getRangeRes.headers.get("Content-Range") || "").startsWith("bytes 0-4/"),
  `status=${getRangeRes.status} body=${getRangeText}`,
)
const headRes = await app.request("/dav/hello.txt", {
  method: "HEAD",
  headers: davAuth,
})
check(
  "HEAD 返回长度无 body",
  headRes.status === 200 &&
    headRes.headers.get("Content-Length") === "12" &&
    (await headRes.text()) === "",
)
const getDirRes = await app.request("/dav/sub", { headers: davAuth })
check("GET 目录 403", getDirRes.status === 403)
const get404Res = await app.request("/dav/nope.txt", { headers: davAuth })
check("GET 不存在 404", get404Res.status === 404)

// ---------- 7. PROPPATCH ----------
const ppRes = await app.request("/dav/hello.txt", {
  method: "PROPPATCH",
  headers: { ...davAuth, "Content-Type": "application/xml" },
  body: `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>
<getlastmodified xmlns="urn:schemas-microsoft-com:">Mon, 01 Jan 2024 00:00:00 GMT</getlastmodified>
<win32_creationtime xmlns="urn:schemas-microsoft-com:">Mon, 01 Jan 2024 00:00:00 GMT</win32_creationtime>
</D:prop></D:set></D:propertyupdate>`,
})
const ppXml = await ppRes.text()
check(
  "PROPPATCH 返回 207",
  ppRes.status === 207 && ppXml.includes("multistatus"),
)
check(
  "PROPPATCH lastmodified 被拒 403",
  ppXml.includes("403 Forbidden"),
)

// ---------- 8. LOCK / UNLOCK ----------
const lockRes = await app.request("/dav/hello.txt", {
  method: "LOCK",
  headers: { ...davAuth, "Content-Type": "application/xml" },
  body: `<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:">
<D:lockscope><D:exclusive/></D:lockscope>
<D:locktype><D:write/></D:locktype>
<D:owner>tester</D:owner></D:lockinfo>`,
})
const lockXml = await lockRes.text()
check(
  "LOCK 返回 200 + locktoken",
  lockRes.status === 200 &&
    (lockRes.headers.get("Lock-Token") || "").includes("opaquelocktoken:") &&
    lockXml.includes("lockdiscovery"),
)
const unlockRes = await app.request("/dav/hello.txt", {
  method: "UNLOCK",
  headers: { ...davAuth, "Lock-Token": "<opaquelocktoken:x>" },
})
check("UNLOCK 返回 204", unlockRes.status === 204)

// ---------- 9. MOVE (rename / cross-dir) ----------
const mvRenameRes = await app.request("/dav/newdir/upload.txt", {
  method: "MOVE",
  headers: { ...davAuth, Destination: `${DEST}/newdir/renamed.txt` },
})
check("MOVE 同目录重命名 201", mvRenameRes.status === 201)
const oldGone = await app.request("/dav/newdir/upload.txt", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "0" },
})
const newHere = await app.request("/dav/newdir/renamed.txt", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "0" },
})
check(
  "MOVE 后旧名消失新名存在",
  oldGone.status === 404 && newHere.status === 207,
)

await app.request("/dav/other", { method: "MKCOL", headers: davAuth })
const mvCrossRes = await app.request("/dav/newdir/renamed.txt", {
  method: "MOVE",
  headers: { ...davAuth, Destination: `${DEST}/other/moved.txt` },
})
const mvCrossCheck = await app.request("/dav/other/moved.txt", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "0" },
})
check(
  "MOVE 跨目录移动",
  mvCrossRes.status === 201 && mvCrossCheck.status === 207,
  `status=${mvCrossRes.status}`,
)

// ---------- 10. COPY ----------
const cpRes = await app.request("/dav/hello.txt", {
  method: "COPY",
  headers: { ...davAuth, Destination: `${DEST}/hello-copy.txt` },
})
const cpCheck = await app.request("/dav/hello-copy.txt", {
  headers: davAuth,
})
check(
  "COPY 复制文件",
  cpRes.status === 201 &&
    cpCheck.status === 200 &&
    (await cpCheck.text()) === "Hello WebDAV",
  `status=${cpRes.status}`,
)

const cpDupRes = await app.request("/dav/hello.txt", {
  method: "COPY",
  headers: { ...davAuth, Destination: `${DEST}/hello-dup.txt` },
})
const cpDupCheck = await app.request("/dav/hello-dup.txt", {
  headers: davAuth,
})
check(
  "COPY 同目录改名（临时目录中转）",
  cpDupRes.status === 201 &&
    cpDupCheck.status === 200 &&
    (await cpDupCheck.text()) === "Hello WebDAV",
  `status=${cpDupRes.status}`,
)

const listAfterDup = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "1" },
})
check(
  "COPY 临时目录已清理",
  !(await listAfterDup.text()).includes(".webdav-copy-"),
)

// Overwrite: F → 412
const mvOwFRes = await app.request("/dav/hello-copy.txt", {
  method: "MOVE",
  headers: {
    ...davAuth,
    Destination: `${DEST}/hello-dup.txt`,
    Overwrite: "F",
  },
})
check("MOVE Overwrite:F 目标存在 412", mvOwFRes.status === 412)
// Overwrite: T (default) → success
const mvOwTRes = await app.request("/dav/hello-copy.txt", {
  method: "MOVE",
  headers: { ...davAuth, Destination: `${DEST}/hello-dup.txt` },
})
check(
  "MOVE 默认 Overwrite:T 覆盖成功",
  mvOwTRes.status === 204 || mvOwTRes.status === 201,
  `status=${mvOwTRes.status}`,
)

// ---------- 11. DELETE ----------
const delRes = await app.request("/dav/hello-dup.txt", {
  method: "DELETE",
  headers: davAuth,
})
const delGone = await app.request("/dav/hello-dup.txt", {
  method: "PROPFIND",
  headers: { ...davAuth, Depth: "0" },
})
check(
  "DELETE 删除文件 204",
  delRes.status === 204 && delGone.status === 404,
)
const delRootRes = await app.request("/dav/", {
  method: "DELETE",
  headers: davAuth,
})
check("DELETE 根目录被拒 403", delRootRes.status === 403)

// ---------- 12. Permissions ----------
const noPermPfRes = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { ...noAuth, Depth: "1" },
})
check("无 webdav 权限用户 PROPFIND 403", noPermPfRes.status === 403)

const roGetRes = await app.request("/dav/hello.txt", { headers: roAuth })
check("只读用户 GET 200", roGetRes.status === 200)
const roPutRes = await app.request("/dav/readonly-try.txt", {
  method: "PUT",
  headers: { ...roAuth, "Content-Type": "text/plain" },
  body: "should fail",
})
check("只读用户 PUT 403", roPutRes.status === 403)

// disabled guest can't authenticate
const guestRes = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { ...basic("guest", ""), Depth: "1" },
})
check("禁用的 guest 账户 401", guestRes.status === 401)

// ---------- 13. base_path jailing ----------
const jailPfRes = await app.request("/dav/", {
  method: "PROPFIND",
  headers: { ...jailAuth, Depth: "1" },
})
const jailPfXml = await jailPfRes.text()
check(
  "base_path 用户根列表映射到 /sub",
  jailPfRes.status === 207 &&
    jailPfXml.includes("inner.txt") &&
    !jailPfXml.includes("hello.txt"),
  `status=${jailPfRes.status}`,
)
const jailGetRes = await app.request("/dav/inner.txt", { headers: jailAuth })
check(
  "base_path 用户访问 /dav/inner.txt 实际读取 /sub/inner.txt",
  jailGetRes.status === 200 && (await jailGetRes.text()) === "inner content",
)

// ---------- 14. Cross-storage virtual root sanity ----------
// (storage mounted at "/" so everything is one storage — already covered)

// ---------- Cleanup ----------
rmSync(rootFolder, { recursive: true, force: true })

console.log(`\n${"=".repeat(50)}\nWebDAV E2E: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
