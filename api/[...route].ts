import { Hono } from "hono"
import { handle } from "hono/vercel"
import backendApp from "../src/backend/index"

const app = new Hono()

// 挂载整个后端 API 应用
app.route("/", backendApp)

// 导出符合 Vercel/EdgeOne 规范的 Serverless 句柄
export const GET = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const DELETE = handle(app)
export const PATCH = handle(app)
export const OPTIONS = handle(app)
// WebDAV (RFC 4918) 自定义方法 —— /dav 端点需要它们才能被 Vercel 路由到
export const PROPFIND = handle(app)
export const PROPPATCH = handle(app)
export const MKCOL = handle(app)
export const MOVE = handle(app)
export const COPY = handle(app)
export const LOCK = handle(app)
export const UNLOCK = handle(app)

// 导出 Cloudflare Workers 原生 Fetch 句柄
export default {
  fetch: app.fetch,
}
