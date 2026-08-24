// Simulate Cloudflare Workers environment: no process.release (no Node.js runtime)
import app from "../src/backend/index"

// Simulate Workers: process.release is undefined (even with nodejs_compat)
Object.defineProperty(process, "release", { value: undefined, configurable: true })

let pass = 0
let fail = 0

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    pass++
    console.log(`✅ ${name}`)
  } catch (e: any) {
    fail++
    console.error(`❌ ${name}:`, e.message)
  }
}

async function req(method: string, path: string, body?: any) {
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

await test("健康检查 /api/health", async () => {
  const { status } = await req("GET", "/api/health")
  if (status !== 200) throw new Error(`status ${status}`)
})

await test("任务列表 /api/task/upload/undone", async () => {
  const { status, json } = await req("GET", "/api/task/upload/undone")
  if (status !== 200 || json.code !== 200) throw new Error(`status ${status}`)
})

await test("任务操作 /api/task/upload/clear_done", async () => {
  const { status, json } = await req("POST", "/api/task/upload/clear_done")
  if (status !== 200 || json.code !== 200) throw new Error(`status ${status}`)
})

await test("分享列表 /api/share/list", async () => {
  const { status, json } = await req("GET", "/api/share/list")
  if (status !== 200 || json.code !== 200) throw new Error(`status ${status}`)
})

await test("存储列表 /api/admin/storage/list (无auth应code401)", async () => {
  const { status, json } = await req("GET", "/api/admin/storage/list")
  if (status !== 200) throw new Error(`status ${status}`)
  if (json.code !== 401) throw new Error(`expected code 401, got ${json.code}`)
})

await test("索引进度 /api/admin/index/progress (无auth应code401)", async () => {
  const { status, json } = await req("GET", "/api/admin/index/progress")
  if (status !== 200) throw new Error(`status ${status}`)
  if (json.code !== 401) throw new Error(`expected code 401, got ${json.code}`)
})

await test("扫描进度 /api/admin/scan/progress (无auth应code401)", async () => {
  const { status, json } = await req("GET", "/api/admin/scan/progress")
  if (status !== 200) throw new Error(`status ${status}`)
  if (json.code !== 401) throw new Error(`expected code 401, got ${json.code}`)
})

await test("公开设置 /api/public/settings", async () => {
  const { status } = await req("GET", "/api/public/settings")
  if (status !== 200) throw new Error(`status ${status}`)
})

await test("raw 下载（无存储时404）", async () => {
  const { status } = await req("GET", "/api/p/test.txt")
  // 无存储时应返回错误而非崩溃
  if (status === 500) throw new Error("server error, should be 4xx")
})

await test("raw 代理路径前缀只剥离一次（/api/p/dav/... 挂载点以 d 开头）", async () => {
  // Regression: the sequential prefix-strip chain in raw.ts double-stripped
  // `/api/p/dav/a.txt` → `/dav/a.txt` → `av/a.txt` (the leftover `/d` hit
  // the `/d` rule again), so any mount path starting with `d`/`p`/`sd`
  // (e.g. WebDAV mounted at `/dav`) failed in proxy mode with
  // "failed get storage: storage not found".
  const login = await req("POST", "/api/auth/login", {
    username: "admin",
    password: "admin",
  })
  const token = login.json?.data?.token
  if (!token) throw new Error("login failed, cannot run regression")

  const createRes = await app.request("/api/admin/storage/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      driver: "Local",
      mount_path: "/dav",
      addition: "{}",
    }),
  })
  const created: any = await createRes.json()
  if (created.code !== 200) {
    throw new Error(`storage create failed: ${JSON.stringify(created)}`)
  }

  const res = await app.request("/api/p/dav/regression.txt")
  const text = await res.text()
  if (text.includes("failed get storage")) {
    throw new Error(`mount /dav was not resolved (path double-stripped): ${text}`)
  }
})

await test("登录 /api/auth/login", async () => {
  const { status, json } = await req("POST", "/api/auth/login", {
    username: "admin",
    password: "admin",
  })
  if (status !== 200 || json.code !== 200) throw new Error(`status ${status} code ${json.code}`)
})

await test("驱动注册包含 NeteaseMusic（/api/admin/driver/names）", async () => {
  const login = await req("POST", "/api/auth/login", {
    username: "admin",
    password: "admin",
  })
  const token = login.json?.data?.token
  if (!token) throw new Error("login failed, cannot check driver list")

  const res = await app.request("/api/admin/driver/names", {
    headers: { Authorization: `Bearer ${token}` },
  })
  const json: any = await res.json()
  if (json.code !== 200 || !Array.isArray(json.data)) {
    throw new Error(`driver/names failed: ${JSON.stringify(json)}`)
  }
  if (!json.data.includes("NeteaseMusic")) {
    throw new Error(`NeteaseMusic missing from driver names: ${json.data}`)
  }

  const infoRes = await app.request(
    "/api/admin/driver/info?driver=NeteaseMusic",
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const info: any = await infoRes.json()
  if (
    info.code !== 200 ||
    !info.data?.additional?.some((f: any) => f.name === "cookie")
  ) {
    throw new Error(
      `NeteaseMusic driver config missing cookie field: ${JSON.stringify(info)}`,
    )
  }
})

await test("debug 信息 /api/debug/info", async () => {
  const { status } = await req("GET", "/api/debug/info")
  if (status !== 200) throw new Error(`status ${status}`)
})

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
