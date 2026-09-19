<p align="center">
  <img src="/logo.png" width="128" alt="NextList" />
</p>

<h1 align="center">NextList</h1>

<p align="center">
  <b>A modern, full-stack file list &amp; cloud drive manager</b><br/>
  A full-stack TypeScript fork of OpenList — a lightweight Node.js (Hono) backend<br/>
  replaces the original Go binary, so deployment is lighter and startup is faster.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

---

## ✨ Why NextList

NextList mounts local folders, cloud drives and WebDAV servers into one modern web UI, with browsing, previewing, upload/download, sharing and an admin panel out of the box.

- **Full-stack TypeScript** — SolidJS frontend + Hono backend share one language and types; no Go toolchain required
- **Edge-first** — the backend relies only on Web standard APIs (`fetch` / `Web Crypto` / `ReadableStream`); the same code runs on Cloudflare Workers, Tencent EdgeOne, Alibaba ESA, Vercel, AWS Lambda and Node containers
- **60+ storage drivers** — a unified `StorageDriver` interface covers domestic & international drives, object storage, self-hosted services and code hosting
- **Zero database** — everything persists to Cloudflare KV (edge) or a JSON file (`public_data/db.json`, container)

> [!NOTE]
> NextList is a fork / re-implementation of [OpenList](https://github.com/OpenListTeam/OpenList). The frontend experience is preserved; the backend and storage-driver layer are rewritten.

---

## 🚀 Features

- **Browsing & preview** — list / grid views, search, sorting, paging, folder tree; PDF, Markdown (math / Mermaid), Monaco code, Office (docx / pptx / xlsx), image gallery, video / audio (subtitles / HLS)
- **File management** — upload, download, mkdir, rename, move, copy, batch rename, ZIP package download (streamed in the browser)
- **Sharing** — links with password / expiry, share browsing `/@s/`, direct share download `/sd/`
- **Download acceleration** — direct links, HTTP Range resume, proxy download `/d` `/p`
- **Accounts & security** — JWT auth, users, protected routes, 2FA (TOTP), audit-ready admin panel
- **Plugin system** — ZIP / URL install, visual config, OpenListNext-compatible plugin format
- **AI integration** — built-in MCP server at `/api/mcp` (Streamable HTTP + SSE)
- **WebDAV** — full RFC 4918 Class 1/2 server at `/dav`
- **Backup & restore** — JSON export / import (OpenList-compatible)

See the [documentation site](https://nextlist-web.pages.dev/) for the full feature set.

---

## 🗺️ Supported Platforms

| Platform                 | How                                             | Guide                                                        |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| **Cloudflare Workers** ⭐ | `pnpm deploy` (auto-creates KV)                 | [Deploy to Cloudflare Workers](https://nextlist-web.pages.dev/deploy/workers) |
| **Tencent EdgeOne**      | Import the repo in the Makers console           | [Deploy to EdgeOne](https://nextlist-web.pages.dev/deploy/edgeone) |
| **Alibaba Cloud ESA**    | Edge Routine + remote KV                        | [Deploy to ESA](https://nextlist-web.pages.dev/deploy/esa)   |
| **Vercel**               | Platform import (`api/[...route].ts`)           | —                                                            |
| **AWS Lambda**           | `pnpm sls:deploy`                               | —                                                            |
| **Node container**       | Build + self-host via `@hono/node-server`       | —                                                            |

---

## 🚀 Quick Start

Requirements: Node.js ≥ 20.19 (22 LTS recommended) and pnpm 9+.

```bash
git clone https://github.com/Mcchen1008/NextList.git
cd NextList
pnpm install
pnpm dev            # Vite + Hono dev server → http://localhost:3000
```

Deploy to Cloudflare Workers with one command:

```bash
pnpm deploy         # detects / creates NEXTLIST_KV, builds, wrangler deploy
```

Default admin account: `admin` / `admin` — **change the password immediately after the first login**.

---

## ⚙️ Environment Variables

| Variable         | Default | Description                                    |
| ---------------- | ------- | ---------------------------------------------- |
| `VITE_API_URL`   | `/api`  | Backend API base URL used by the frontend      |
| `ADMIN_USERNAME` | `admin` | Initial admin username                         |
| `ADMIN_PASSWORD` | `admin` | Initial admin password                         |
| `DATABASE_JSON`  | —       | Optional: inject JSON database state directly  |

See [Environment Variables & Bindings](https://nextlist-web.pages.dev/deploy/env) for the complete list.

---

## 🔄 Sync a Fork with Upstream

This repo ships a **Sync with Upstream** workflow ([.github/workflows/sync_upstream.yml](.github/workflows/sync_upstream.yml)). After forking, run it from the **Actions** tab to merge the latest upstream code into your fork (`method`: `merge` or `rebase`). Resolve conflicts manually if the workflow fails.

---

## 📚 Documentation

Full documentation lives at **[nextlist-web.pages.dev](https://nextlist-web.pages.dev/)**:

- [Quick Start](https://nextlist-web.pages.dev/guide/quick-start)
- [Deploy to Cloudflare Workers / EdgeOne / ESA](https://nextlist-web.pages.dev/deploy/workers)
- [Add Storage (driver credentials)](https://nextlist-web.pages.dev/storage/)
- [REST API Reference](https://nextlist-web.pages.dev/advanced/api) · [MCP Integration](https://nextlist-web.pages.dev/advanced/mcp)
- [FAQ](https://nextlist-web.pages.dev/faq) · [OpenList Compatibility](https://nextlist-web.pages.dev/advanced/compat)

---

## 🤝 Related Projects

| Project         | Description                                                        | Link                                             |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| **OpenListNext** | JS/TS upstream kernel (Serverless rewrite of OpenList), plugin-compatible | <https://github.com/Polonium-salts/openlistnext> |
| **OpenList**    | Upstream original (Go backend)                                     | <https://github.com/OpenListTeam/OpenList>       |
| **AList**       | Predecessor of OpenList                                            | <https://github.com/alist-org/alist>             |
| **OpenList API** | Token helper service for some drivers                             | <https://api.oplist.org/>                        |

---

## 📄 License

[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)
