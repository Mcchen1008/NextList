<p align="center">
  <img src="/logo.png" width="128" alt="NextList" />
</p>

<h1 align="center">NextList</h1>

<p align="center">
  <b>一个现代化的全栈文件列表 / 网盘管理系统</b><br/>
  OpenList 的全栈 TypeScript 分支：用轻量级 Node.js（Hono）后端替代原版 Go 二进制，<br/>
  部署更轻、启动更快。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

---

## ✨ 项目简介

NextList 把本地目录、网盘和 WebDAV 服务器统一挂载到一个现代网页界面中，开箱即用地提供浏览、预览、上传下载、分享与后台管理。

- **全栈 TypeScript** —— 前端 SolidJS + 后端 Hono 同语言、类型共享，无 Go 编译链
- **边缘优先** —— 后端只用 Web 标准 API（`fetch` / `Web Crypto` / `ReadableStream`），同一套代码可运行在 Cloudflare Workers、腾讯云 EdgeOne、阿里云 ESA、Vercel、AWS Lambda 与 Node 容器
- **60+ 存储驱动** —— 统一的 `StorageDriver` 接口，覆盖国内外网盘、对象存储、自托管服务与代码托管
- **零数据库依赖** —— 配置持久化到 Cloudflare KV（边缘）或 JSON 文件（`public_data/db.json`，容器）

> [!NOTE]
> 本项目是 [OpenList](https://github.com/OpenListTeam/OpenList) 的分支 / 衍生实现，完整保留其前端体验，并重写了后端与存储驱动层。

---

## 🚀 功能特性

- **浏览与预览** —— 列表 / 网格、搜索、排序、分页、目录树；PDF、Markdown（公式 / Mermaid）、Monaco 代码、Office（docx / pptx / xlsx）、图片画廊、视频音频（字幕 / HLS）
- **文件管理** —— 上传、下载、新建文件夹、重命名、移动、复制、批量重命名、ZIP 打包下载（浏览器流式生成）
- **分享** —— 提取码 / 密码 / 过期时间，分享页 `/@s/`、分享直链 `/sd/`
- **下载加速** —— 直链下载、HTTP Range 断点续传、代理下载 `/d` `/p`
- **账户与安全** —— JWT 认证、用户管理、密码保护路由、两步验证（TOTP）、后台管理
- **插件系统** —— ZIP / URL 安装、可视化配置，兼容 OpenListNext 插件格式
- **AI 集成** —— 内置 MCP 服务端（`/api/mcp`，Streamable HTTP + SSE）
- **WebDAV** —— 完整 RFC 4918 Class 1/2 服务端（`/dav`）
- **备份恢复** —— JSON 导出 / 导入（兼容 OpenList）

完整功能清单见[文档站](https://nextlist-web.pages.dev/)。

---

## 🗺️ 部署平台

| 平台                    | 方式                          | 指南                                                                        |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| **Cloudflare Workers** ⭐ | `pnpm deploy`（自动创建 KV） | [Cloudflare Workers 部署](https://nextlist-web.pages.dev/deploy/workers)    |
| **腾讯云 EdgeOne**      | Makers 控制台导入仓库         | [EdgeOne 部署](https://nextlist-web.pages.dev/deploy/edgeone)               |
| **阿里云 ESA**          | Edge Routine + 远程 KV        | [阿里云 ESA 部署](https://nextlist-web.pages.dev/deploy/esa)                |
| **Vercel**              | 平台导入（`api/[...route].ts`）| —                                                                           |
| **AWS Lambda**          | `pnpm sls:deploy`             | —                                                                           |
| **Node 容器**           | 构建后经 `@hono/node-server` 自托管 | —                                                                     |

---

## 🚀 快速开始

环境要求：Node.js ≥ 20.19（推荐 22 LTS）与 pnpm 9+。

```bash
git clone https://github.com/Mcchen1008/NextList.git
cd NextList
pnpm install
pnpm dev            # Vite + Hono 开发服务器 → http://localhost:3000
```

一键部署到 Cloudflare Workers：

```bash
pnpm deploy         # 自动检测 / 创建 NEXTLIST_KV → 构建 → wrangler deploy
```

默认管理账号 `admin` / `admin`，**首次登录后请立即修改密码**。

---

## ⚙️ 环境变量

| 变量             | 默认值  | 说明                          |
| ---------------- | ------- | ----------------------------- |
| `VITE_API_URL`   | `/api`  | 前端请求的后端 API 地址       |
| `ADMIN_USERNAME` | `admin` | 管理员初始用户名              |
| `ADMIN_PASSWORD` | `admin` | 管理员初始密码                |
| `DATABASE_JSON`  | —       | 可选：注入 JSON 数据库状态    |

完整变量清单见[环境变量与绑定](https://nextlist-web.pages.dev/deploy/env)。

---

## 🔄 Fork 自动同步上游

仓库内置 **Sync with Upstream** 工作流（[.github/workflows/sync_upstream.yml](.github/workflows/sync_upstream.yml)）。Fork 后在 **Actions** 页运行即可合并上游最新代码（`method`：`merge` 或 `rebase`）；工作流失败时请手动解决冲突。

---

## 📚 文档

完整文档见 **[nextlist-web.pages.dev](https://nextlist-web.pages.dev/)**：

- [快速开始](https://nextlist-web.pages.dev/guide/quick-start)
- [部署：Cloudflare Workers / EdgeOne / 阿里云 ESA](https://nextlist-web.pages.dev/deploy/workers)
- [添加存储（驱动凭证）](https://nextlist-web.pages.dev/storage/)
- [REST API 参考](https://nextlist-web.pages.dev/advanced/api) · [MCP 接入](https://nextlist-web.pages.dev/advanced/mcp)
- [常见问题](https://nextlist-web.pages.dev/faq) · [OpenList 兼容性](https://nextlist-web.pages.dev/advanced/compat)

---

## 🤝 相关项目

| 项目             | 说明                                                             | 链接                                             |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| **OpenListNext** | JS/TS 内核上游（OpenList 的 Serverless 重构版），插件格式双向兼容 | <https://github.com/Polonium-salts/openlistnext> |
| **OpenList**     | 上游原版（Go 后端）                                              | <https://github.com/OpenListTeam/OpenList>       |
| **AList**        | OpenList 的前身                                                  | <https://github.com/alist-org/alist>             |
| **OpenList API** | 部分网盘驱动的 token 获取服务                                    | <https://api.oplist.org/>                        |

---

## 📄 许可证

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)
