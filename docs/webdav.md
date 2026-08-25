# WebDAV 使用指南

NextList 内置完整的 **WebDAV 服务端**（RFC 4918 Class 1 / Class 2），把所有已挂载的存储统一暴露在 `/dav` 端点下。你可以用 Windows 资源管理器、macOS Finder、rclone、RaiDrive、Cyberduck 等任意标准 WebDAV 客户端直接挂载并管理文件。

---

## 快速开始

服务端地址（把 `https://your-domain.com` 换成你的部署地址）：

```text
https://your-domain.com/dav
```

认证方式与网页登录完全一致 —— **用户名 + 密码**（HTTP Basic）。

```bash
# 快速自检：列出根目录
curl -X PROPFIND -H "Depth: 1" -u admin:admin https://your-domain.com/dav/
```

> ⚠️ 默认账号为 `admin` / `admin`，正式环境请先在后台修改密码。

---

## 认证与权限

| 项目                   | 说明                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Basic 认证             | 用户名 + 密码，与网页登录凭证一致（支持明文与哈希存储）                                     |
| Bearer 认证            | `POST /api/auth/login` 返回的 JWT Token，可直接用于 `Authorization: Bearer <token>`         |
| `webdav_read` 权限位   | 允许 `PROPFIND` / `GET` / `HEAD` / `OPTIONS`（只读）                                        |
| `webdav_manage` 权限位 | 允许 `PUT` / `MKCOL` / `MOVE` / `COPY` / `DELETE` / `PROPPATCH` / `LOCK` / `UNLOCK`（读写） |
| 管理员（role=2）       | 隐式拥有全部 WebDAV 权限                                                                    |
| 访客（role=1）         | 无任何 WebDAV 权限（匿名请求一律返回 401）                                                  |
| `base_path` 目录监禁   | 每个用户只能看到并操作自己 `base_path` 之内的路径；`/dav` 的根即该用户的 `base_path`        |

权限在 **后台管理 → 用户 → 编辑 → 权限** 中勾选（"WebDAV 读取" / "WebDAV 管理"）。

---

## 支持的方法

| 方法              | 行为                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `OPTIONS`         | 能力协商（`DAV: 1, 2`），无需认证                                                           |
| `PROPFIND`        | 列目录 / 查属性；支持 `Depth: 0` 与 `Depth: 1`（`infinity` 按 1 处理），207 多状态 XML 响应 |
| `PROPPATCH`       | 尽力而为的属性应答；`lastmodified` / `creationdate` 等只读属性返回 403                      |
| `MKCOL`           | 新建目录（201）；已存在 405；带请求体 415                                                   |
| `GET` / `HEAD`    | 下载文件，支持 `Range` 断点续传（206）；远程网盘走服务端代理流式转发，本地存储直读文件系统  |
| `PUT`             | 上传 / 覆盖文件（新建 201，覆盖 204）                                                       |
| `DELETE`          | 删除文件或目录（含递归，204）                                                               |
| `MOVE`            | 重命名（同目录）或移动（跨目录），遵循 `Destination` 与 `Overwrite` 头                      |
| `COPY`            | 复制文件 / 目录，支持同目录改名（自动经临时目录中转）与跨目录复制                           |
| `LOCK` / `UNLOCK` | Class 2 兼容：返回独占写锁令牌（无状态假锁，满足 Windows / macOS 客户端写入前的探测）       |

错误码遵循 RFC 4918：未认证 401、权限不足 403、目标不存在 404、目录冲突 409、`Overwrite: F` 且目标存在 412 等。

---

## 客户端配置示例

### Windows 资源管理器

1. 打开「此电脑」→ 点击顶部「映射网络驱动器」
2. 文件夹填：`https://your-domain.com/dav`
3. 勾选「使用其他凭据」，输入 NextList 用户名密码
4. 完成后像本地磁盘一样拖拽上传 / 删除 / 重命名

> 若映射失败，请确认 Windows 的 **WebClient 服务** 已启动（`services.msc`）。
> 部分 Windows 版本对 HTTPS 自签名证书敏感，建议使用有效证书。

### macOS Finder

`Finder` → `前往` → `连接服务器`（⌘K）→ 输入：

```text
https://your-domain.com/dav
```

输入用户名密码后挂载为网络卷。

### rclone

```bash
rclone config
# 选择 new remote → 类型选 webdav
# url:        https://your-domain.com/dav
# vendor:     other
# user:       你的用户名
# pass:       你的密码

# 之后即可
rclone lsl remote:            # 列根目录
rclone copy ./local-file remote:docs/   # 上传
rclone copy remote:docs/ ./backup/      # 下载
```

### Linux（davfs2）

```bash
sudo apt install davfs2
sudo mount -t davfs https://your-domain.com/dav /mnt/nextlist
# 按 davfs2 提示输入用户名密码；凭据也可写入 /etc/davfs2/secrets
```

### 移动端

- iOS：文档 App「连接服务器」填 `https://your-domain.com/dav`，或使用 Fileball / Documents 等应用
- Android：ES 文件浏览器 / CX 文件管理器 → 添加 WebDAV

---

## 行为细节与已知限制

1. **上传缓冲**：Serverless / 边缘环境（Cloudflare Workers 等）下 `PUT` 请求体在内存中缓冲后转发给存储驱动，超大数据集请分批上传；Node 容器模式无实质限制。
2. **锁是无状态的**：`LOCK` 返回的令牌不会在服务端登记 —— 单用户场景无感知；多客户端同时写同一文件时不会互斥，请自行避免并发写。
3. **跨存储移动 / 复制**：依赖源存储驱动的能力。本地存储之间正常；云端网盘之间的跨盘移动可能因驱动不支持而失败（与网页端行为一致）。
4. **目录递归操作**：`DELETE` / `MOVE` / `COPY` 作用于目录时递归处理，由各存储驱动在远端执行。
5. **EdgeOne 部署**：`middleware.js` 已放行 `/dav` 路径，无需额外配置。
6. **Vercel 部署**：`api/[...route].ts` 已导出 `PROPFIND` / `PROPPATCH` / `MKCOL` / `MOVE` / `COPY` / `LOCK` / `UNLOCK` 方法句柄。
7. **开发模式**：`pnpm dev` 下 Vite 已配置直通 `/dav`（关闭了 Vite 内置 CORS 预检拦截），可直接在本机挂载 `http://localhost:3000/dav` 测试。

---

## 开发与测试

```bash
pnpm test:webdav          # 42 项端到端用例：认证 / 权限 / 全部方法 / base_path
pnpm lint                 # TypeScript 类型检查
```

相关源码：

| 文件                                    | 职责                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| `src/backend/server/webdav.ts`          | WebDAV 路由：认证、权限、12 个 HTTP 方法处理器                |
| `src/backend/internal/webdav/webdav.ts` | 协议助手：路径 / Destination / Depth 解析、Basic 解析、锁令牌 |
| `src/backend/pkg/xml.ts`                | PROPFIND / PROPPATCH / LOCK 响应 XML 生成（含转义）           |
| `scripts/test-webdav.mts`               | 端到端回归测试                                                |
