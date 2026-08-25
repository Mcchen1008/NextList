# 腾讯云 EdgeOne Makers 部署指南

本文档介绍如何将 NextList 部署到 [腾讯云 EdgeOne Makers](https://edgeone.ai/)（边缘函数 / 边缘全栈托管平台）。

---

## 架构适配特性

- **前端托管**：基于 SolidJS + Vite 打包输出到 `dist/`，通过 EdgeOne 边缘 CDN 全球加速。
- **后端执行**：由 **Cloud Functions（Node.js）** 承载，`scripts/build-edge.mjs` 在构建期将 `api/_makers.ts` 打包为仓库根 **`cloud-functions/[[default]].js`**（⚠️ Makers 在检出仓库时即扫描该文件决定是否启用 Node 函数，因此产物必须提交进仓库；若缺失，CLI 会报 `No server-handler detected` 并退化为纯静态项目），以 Handler 模式包裹 Hono 应用统一处理 `/api`、`/d`、`/p`、`/sd`、`/health` 等请求；根路径与前端路由由根级 **`middleware.js`** 将浏览器导航请求（Accept: text/html 且非后端路径）透明改写为 `/index.html`，命中静态 CDN 的 SPA fallback。
- **SPA 兜底双保险**：Node 云函数内没有 `ASSETS` 绑定，因此构建时会把 `dist/index.html` 内联进函数包——即使边缘中间件未生效、或请求直达云函数，前端路由（如 `/@manage/*`）也会由函数直接返回页面壳（`Cache-Control: no-cache`），不会再出现整站 404。
- **配置持久化**：
  - **Blob 存储**（推荐）：自动使用 `@edgeone/pages-blob` SDK（HTTP API），无需手动配置，避免 Redis RESP 协议崩溃。
  - **KV 存储**（兼容）：自动适配 `EDGEONE_KV` / `EO_KV` 命名空间（仅部分环境可用）。
- **其他平台不受影响**：本适配为增量式——Cloudflare Workers（`wrangler.toml` + `NEXTLIST_KV`）、Vercel（`api/[...route].ts`）、AWS Lambda（`handler.ts`）的部署入口与产物保持原样。

---

## 部署步骤

### 方式一：EdgeOne Makers 控制台 Git 导入（推荐）

1. **导入仓库**：登录 [EdgeOne Makers 控制台](https://console.edgeone.ai/makers)，点击 **新建项目** -> **导入 Git 仓库**。
2. **构建设置**（平台将自动读取项目根目录的 `edgeone.json`）：
   - Node 版本：`22.11.0`
   - 安装命令：`pnpm install --no-frozen-lockfile`
   - 构建命令：`pnpm run build`
   - 输出目录：`dist`
3. **存储配置**：无需手动配置。Blob 存储会自动初始化（使用 `@edgeone/pages-blob` SDK），配置数据持久化在 `nextlist_db` 命名空间中。
4. **点击部署**：构建完成后即可通过 EdgeOne 分配的 `*.edgeone.cool` 域名直接访问，默认管理账号为 `admin` / `admin`。

> ⚠️ 若通过 Git 导入部署，请确保 `cloud-functions/[[default]].js` 已提交进仓库（本仓库已提交），否则平台无法识别 Node 函数入口。

### 方式二：EdgeOne CLI 部署

```bash
# 全局安装 EdgeOne CLI
npm install -g edgeone

# 登录账户
edgeone login

# 本地调试开发
edgeone makers dev

# 构建并部署到生产
edgeone makers deploy
```

---

## 数据持久化说明

NextList 的配置数据库（站点设置 / 存储挂载 / 用户 / 分享）在 EdgeOne 环境的持久化优先级：

1. **`@edgeone/pages-blob` Blob 存储**（强一致性，HTTP API）：在 Makers Functions 运行时内由 SDK 自动注入凭证初始化，配置数据存于 `nextlist_db` 命名空间的 `nextlist_config` 键。无需任何手动配置。
2. **EdgeOne KV binding**（`EDGEONE_KV` / `EO_KV`）：若环境注入了 KV 命名空间绑定则自动启用；其 Redis RESP 协议解析器可能抛出未捕获异常，已内置 `process.on("uncaughtException")` 安全网兜底，实例不会被击穿。
3. **内存模式**（兜底）：无上述环境时的降级行为，配置变更仅在函数实例生命周期内有效。

可在后台「设置 → 其他」的 KV 状态面板（`/api/admin/kv/status`）查看当前实际生效的存储平台。
