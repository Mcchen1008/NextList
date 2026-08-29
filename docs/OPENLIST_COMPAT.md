# NextList ↔ OpenList 存储驱动兼容改造说明

## 1. 项目背景与目标

NextList 是基于 TypeScript/Hono 重构的 OpenList 分支：前端体验与 OpenList 一脉相承，后端却从 Go 重写为可部署到 Cloudflare Workers / EdgeOne 等边缘环境的 Hono 应用。两者对"存储驱动"的理念相近（挂载路径 + 驱动类型 + JSON 格式的 `addition` 配置），但在具体字段命名、驱动注册名、数据模型和部分 HTTP 语义上存在差异，导致一方的备份数据无法被另一方直接使用。

本次改造的目标是：**NextList 导出的配置/数据文件，可以不经任何手工修改直接导入 OpenList（反之亦然），且全部交互只通过标准 HTTP + JSON 完成**，同时不破坏 NextList 原有功能、不影响其边缘部署能力。

改造基线：

| 项目     | 版本/提交                           | 说明                                        |
| -------- | ----------------------------------- | ------------------------------------------- |
| NextList | `fc0cf9d`（alpha0.1.2）+ 本改造补丁 | TypeScript/Hono，仓库 `Mcchen1008/NextList` |
| OpenList | v4.2.5（官方 Release 二进制）       | Go，仓库 `OpenListTeam/OpenList`            |

两个项目均采用 AGPL-3.0 许可证；本改造仅修改 NextList，未引入任何 OpenList 专有代码，许可合规。

## 2. 兼容性差异分析（改造依据）

改造前对两侧源码做了逐字段比对，结论如下：

1. **备份信封天然同构**：两系统管理界面的"备份/恢复"使用相同的结构 `{encrypted, settings, users, storages, metas, shares}`，恢复动作等价于逐条调用 `storage/create`、`setting/save`、`user/create`、`meta/create` 等管理端 HTTP 接口。因此兼容工作的核心在于让**每一个条目**在对方系统中"长得一样"。
2. **驱动注册名不同**：如 OpenList 的 `139Yun` 在 NextList 中叫 `139Cloud`、`Bunny Storage` ↔ `BunnyStorage`、`AList V3` ↔ `AListV3`、`115 Open` ↔ `115Open`、`cloudflare_imgbed` ↔ `CloudflareImgBed` 等，共整理出 52 对映射。
3. **驱动 `addition` 字段名不同**：NextList 的 `123pan/115open/uc/139cloud/pikpak/teambition/mediatrack` 驱动读取 `root_id`，而 OpenList 用 `root_folder_id`；OpenList Go 结构体中无 json tag 的导出字段（如 `AccessToken`、`RefreshToken`、`repoId`）序列化为首字母大写的键名，与 NextList 的 `access_token` 等不一致；`123Pan` 的 `UploadThread` 在 OpenList 是 int，在 NextList 是字符串。
4. **Storage 模型字段缺失**：OpenList 的存储比 NextList 多 `cache_expiration`、`custom_cache_policies`、`disable_index`、`enable_sign`、`proxy_range`、`down_proxy_url`、`disable_proxy_sign` 七个字段。
5. **设置项分组编号错位**：OpenList 的组号 `OFFLINE_DOWNLOAD=5, S3=9, FTP=10, TRAFFIC=11`，NextList 为 `ARIA2=5, FTP=9, TRAFFIC=10`；且双方各自独有一批设置键。
6. **fs 接口语义差异**：NextList 的 `/api/fs/list` 忽略 `page/per_page`（无服务端分页），也不校验 meta 目录密码；OpenList 两者都支持（分页 `total` 为切片前全量数，密码错误返回 `code:403` 且消息固定）。
7. **一致的 parts（无需改动）**：响应信封 `{code,message,data}`、`fs/get|mkdir|rename|remove|move|copy|put|form` 的请求响应结构、`/api/auth/login` 与 hash 登录、用户密码静态盐哈希规则（`SHA-256(plain + "-https://github.com/alist-org/alist")`）、备份文件口令加密格式（crypto-js OpenSSL "Salted\_\_" 格式）均完全一致。

## 3. 改动点清单

全部改动集中在 NextList 侧，共 10 个文件、约 2000 行（含测试），未删除任何原有功能，未新增存储驱动：

| 文件                                            | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backend/compat/openlist.ts`（新增）        | **兼容适配层（纯函数，无运行时依赖边缘限制）**：52 对驱动名双向映射；按驱动的 addition 字段重命名与类型矫正（含 `UploadThread` 字符串→int）；OpenList Storage 七字段补齐；设置项键过滤 + 组号重映射；用户导出/导入整形（仅 role 0，密码恒空）；crypto-js/OpenSSL 字节级兼容的逐字段 AES 加密与解密                                                                                                                                           |
| `src/backend/server/compat.ts`（新增）          | `POST/GET /api/admin/export`（`format=openlist                                                                                                                                                                                                                                                                                                                                                                                               | nextlist`，可选口令加密）与 `POST /api/admin/import?override=&password=&format=`。导入器对 OpenList 格式与 NextList 原生格式**双容忍**：存储去重按规范化挂载路径，不支持驱动的条目保留为禁用状态（数据不丢失、可再导出回 OpenList），逐条返回日志 |
| `src/backend/server/admin.ts`                   | 仅追加 2 行：挂载 compat 路由（继承原有 admin JWT 中间件保护）                                                                                                                                                                                                                                                                                                                                                                               |
| `src/backend/server/fs.ts`                      | `/api/fs/list`、`/api/fs/get` 增加最长前缀 meta 目录密码校验（403，消息与 OpenList 一致：`password is incorrect or you have no permission`）；`/api/fs/list` 实现 OpenList 语义的服务端分页（`page<1→1`、`per_page<1→全量`、`total` 为切片前全量数）。前端 `usePath/Pager` 本就按服务端分页设计（`Paginator` 消费 `total`、`loadMore` 请求 `page+1`），此改动同时修复了 `load_more/分页` 模式的既有缺口；默认 `pagination_type=all` 行为不变 |
| `src/pages/manage/backup-restore.tsx`           | 新增「导出 OpenList 格式」「导入 OpenList 备份」两个按钮，复用页面既有日志框与加密口令输入框；原「备份/恢复」功能保持不动                                                                                                                                                                                                                                                                                                                    |
| `src/lang/zh-CN/br.json`、`src/lang/en/br.json` | 新增 4 个 i18n 键                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `scripts/test-compat-convert.mts`（新增）       | 适配层单元测试，115 条断言                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scripts/test-bidirectional-compat.mjs`（新增） | 双系统实测脚本（Node fetch，两阶段）                                                                                                                                                                                                                                                                                                                                                                                                         |
| `scripts/run-compat-test.sh`（新增）            | 一键编排：拉起 OpenList + NextList → 阶段 1 → 重启 NextList → 阶段 2                                                                                                                                                                                                                                                                                                                                                                         |

**边缘部署兼容性**：适配层不依赖任何 Node API（加密使用 crypto-js，纯 JS 实现），数据读写全部走 NextList 已有的 `getDb/saveDb`（KV / 内存），fs 改动为纯数组切片与查表，Cloudflare Workers / EdgeOne 部署路径（`api/[...route].ts`、`src/backend/worker.ts`）未被触碰。唯一受限的仍是原有的 Local 驱动（Node 运行时专属，属 NextList 原有限制）。

## 4. 兼容语义约定（与 OpenList 官方行为对齐）

- **备份格式**：`{encrypted, settings, users, storages, metas, shares}`。`encrypted` 非空表示每个条目的每个字段都经 crypto-js AES 口令加密（与两侧 Web UI 的恢复流程字节级兼容，已用独立 OpenSSL 实现交叉验证）。
- **设置项**：导出仅保留 OpenList 已知的键（白名单来自 OpenList `internal/conf/const.go` + `bootstrap/data/setting.go`），`token`、`version`、`index_progress` 三类实例私有项永不导出；导入仅保留 NextList 已知的键，组号按各自默认表归位。因此 OpenList 独有组（如 S3 网关、LDAP 细节键差异）不会污染对方。
- **用户**：仅导出/导入普通用户（role 0），`admin`/`guest` 不参与。两侧密码均为哈希存储、不可迁移——导出的 `password` 恒为空，导入后 NextList 使用其默认口令 `123456`（与 NextList 自身"恢复"流程一致），需管理员重置。
- **元数据（metas）**：两侧字段完全同名，明文密码原样迁移；导入 NextList 后目录密码立即生效。
- **分享（shares）**：OpenList 无对应对象，OpenList 格式导出中恒为 `[]`；NextList 原生格式（`format=nextlist`）导出的 shares 仅在 `format=nextlist` 导入时回填。
- **驱动配置**：`addition` 在导出文件中恒为 JSON 字符串（OpenList 存储形态）。NextList 不支持的 OpenList 驱动（如 `S3`、`FTP`、`SMB`、`Crypt` 等）导入后**保留为禁用状态**并在 remark 中注明，之后可原样再导出，不丢数据。
- **fs 语义**：`/api/fs/list`、`/api/fs/get` 的目录密码校验规则与 OpenList 相同（最长前缀 meta 命中即校验）。差异点：OpenList 管理员登录态可绕过目录密码，NextList 的 fs 路由无会话概念（等同 guest 语义），对所有人要求密码——前端本就内置输错密码弹窗（`code:403 → NeedPassword`），行为自洽。

## 5. 兼容性测试与结果

### 5.1 测试方法

使用同一份测试数据集，在真实运行的两个服务（NextList dev server :3000，OpenList v4.2.5 :5244）之间通过 **HTTP** 完成双向导入导出，全程无任何本地文件/数据库直连（测试脚本仅用文件系统准备 Local 驱动的根目录内容，属于被管理的数据而非通道）。

测试数据集：7 个存储驱动（Local/WebDav/AliyundriveOpen/123Pan/Onedrive/Seafile/139Cloud，addition 覆盖全部重命名路径）、32 个文件（含密码目录 `/local/protected`）、2 个普通用户、2 条设置、1 条 meta；OpenList 侧再补充 S3（NextList 不支持）与 139Yun 存储、修改站点标题，构造完整快照。

### 5.2 结果汇总

| 验证项                                                           | 结果             |
| ---------------------------------------------------------------- | ---------------- |
| 适配层单元测试（`scripts/test-compat-convert.mts`）              | **115/115 通过** |
| Phase 1：NextList 导出 → OpenList 逐条导入（等价其 Web UI 恢复） | **59/59 通过**   |
| Phase 2：OpenList 快照 → 全新 NextList 导入 + 加密回环           | **35/35 通过**   |

关键断言（均通过）：

- 导出文件被 OpenList 原生 `storage/create` 全部接受；`/123` 存储在 OpenList 侧 `addition` 为 `root_folder_id:"7"`、`AccessToken:"tk_test"`、`UploadThread:3`（int）；`/seafile` 为 `repoId`；`/139` 驱动名 `139Yun`。
- OpenList `/api/fs/list` 对 Local 挂载的 `page=2&per_page=10` 返回 10 条 + `total=32`，与 NextList 改造后完全一致；密码目录对 guest 错误密码 403、正确密码 200，两侧一致。
- 反向导入：`/tianyi`(139Yun) → NextList `139Cloud` + `root_id:"cid2"`；`/s3bucket`(S3) 保留为禁用并注明；`AccessToken→access_token`、`repoId→repo_id` 回转正确；`site_title` 取到 OpenList 侧的值；OpenList 独有键 `s3_access_key_id` 被丢弃；`token` 未被覆盖；admin/guest 无重复。
- 加密备份：NextList 口令导出的文件可用独立实现的 OpenSSL EVP_BytesToKey + AES-256-CBC 解密（即 OpenList/NextList Web UI 恢复流程所用格式）；错误口令导入被拒（400）。
- 全循环：`139Cloud → 139Yun → 139Cloud → 139Yun` 往返两次无损，9 个挂载路径全部保留。

### 5.3 复现方式

```bash
cd NextList && pnpm install
npx tsx scripts/test-compat-convert.mts        # 适配层单元测试
# 需要 OpenList 二进制（openlist-linux-amd64）位于 ../openlist-bin/
bash scripts/run-compat-test.sh                # 双向实测（自动拉起/重启服务）
```

## 6. 遗留事项与说明

1. NextList 不支持且未新增的 OpenList 驱动（S3、FTP、SMB/SFTP、115 Cloud/Share、Virtual、Alias、Crypt 等）在导入时保留为禁用配置，字段不丢失；用户明确要求"不新增存储驱动"，故未做实现。
2. 双方 LDAP/SSO/QBittorrent 等设置键名存在分叉差异（如 `ldap_server` vs `ldap_host`），按"仅导入对方已知键"策略自动跳过，不影响核心配置同步。
3. 导入的用户密码因哈希机制不可迁移，导入后需重置（两侧原生备份功能行为一致）。
4. NextList 的 `/d /p /d` 直链与 WebDAV 未做 OpenList 签名兼容（NextList 原本无签名机制，属功能面差异而非数据交换障碍），已在文档中注明。
