import esbuild from "esbuild"

/**
 * 边缘与 Serverless 构建脚本（移植自 OpenListNext，适配 NextList）：
 *
 * 1. dist/api/[...route].js —— Vercel / 边缘 Serverless 通用入口
 *    （platform: neutral，纯 Web 标准，保持原有部署能力不变）
 *
 * 2. cloud-functions/[[default]].js —— 腾讯云 EdgeOne Makers Node 云函数入口
 *    （platform: node, target: node22）
 *    ⚠️ EdgeOne Makers 在检出仓库时即扫描根目录 cloud-functions/[[default]].js
 *    决定是否启用 Node 函数，因此该产物必须提交进仓库；若缺失，CLI 会报
 *    "No server-handler detected" 并退化为纯静态项目（/api 全部 404）。
 *    构建时将 dist/index.html 内联进函数包作为 SPA 兜底壳（Node 函数内
 *    没有 ASSETS 绑定，前端路由需由函数直接返回页面壳）。
 *
 * 注：NextList 后端无 ssh2 / cpu-features / iconv-lite 等 Node-only 依赖
 * （未移植 SFTP/FTP 驱动），此处仅保留 external 声明与 ".node": "empty"
 * loader 作为防御性兜底，确保未来引入原生模块依赖时构建不至于直接失败。
 */
const commonExternal = ["ssh2", "cpu-features", "iconv-lite"]

async function build() {
  // 1. Vercel / Edge Serverless 入口（与旧版 build:edge 命令产物等价）
  await esbuild.build({
    entryPoints: ["api/[...route].ts"],
    bundle: true,
    platform: "neutral",
    outfile: "dist/api/[...route].js",
    minify: true,
    format: "esm",
    external: commonExternal,
    loader: { ".node": "empty" },
  })

  // 2. EdgeOne Makers Node 云函数入口（内联 dist/index.html 作为 SPA 兜底壳，
  //    需在 vite build 之后运行）
  await esbuild.build({
    entryPoints: ["api/_makers.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    outfile: "cloud-functions/[[default]].js",
    minify: true,
    format: "esm",
    external: commonExternal,
    loader: { ".html": "text", ".node": "empty" },
  })

  console.log(
    "✓ Edge build complete -> dist/api/[...route].js & cloud-functions/[[default]].js",
  )
}

build().catch((err) => {
  console.error(err)
  process.exit(1)
})
