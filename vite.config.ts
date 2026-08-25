import path from "path"
import { defineConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import legacy from "@vitejs/plugin-legacy"
import { viteStaticCopy } from "vite-plugin-static-copy"
import devServer from "@hono/vite-dev-server"

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(import.meta.dirname, "src"),
      // "@solidjs/router": path.resolve(import.meta.dirname, "solid-router/src"),
      "solid-icons": path.resolve(
        import.meta.dirname,
        "node_modules/solid-icons",
      ),
    },
  },
  plugins: [
    solidPlugin(),
    devServer({
      entry: "src/backend/index.ts",
      exclude: [
        // WebDAV (/dav) and download paths are handled by the backend;
        // everything else falls through to the Vite frontend
        /^\/(?!api\/|d\/|sd\/|p\/|dav(?:\/|$)).*/,
        /^\/assets\/.*/,
        /^\/favicon.ico$/,
        /^\/manifest.json$/,
      ],
    }),
    legacy({
      targets: ["defaults"],
    }),
    process.env.VITE_LITE !== "true"
      ? viteStaticCopy({
          targets: [
            {
              src: "node_modules/monaco-editor/min/*",
              dest: "static/monaco-editor",
            },
            {
              src: "node_modules/katex/dist/katex.min.css",
              dest: "static/katex",
            },
            {
              src: "node_modules/katex/dist/fonts/*",
              dest: "static/katex/fonts",
            },
            {
              src: "node_modules/mermaid/dist/mermaid.min.js",
              dest: "static/mermaid",
            },
            {
              src: "node_modules/libheif-js/libheif-wasm/libheif.{js,wasm}",
              dest: "static/libheif",
            },
            {
              src: "node_modules/@jellyfin/libass-wasm/dist/js/subtitles-octopus-worker.{js,wasm}",
              dest: "static/libass-wasm",
            },
            {
              src: "src/components/artplayer-plugin-ass/fonts/*",
              dest: "static/fonts",
            },
          ],
        })
      : null,
  ],
  base: "/",
  build: {
    // target: "es2015", //next
    // polyfillDynamicImport: false,
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    // 关闭 Vite 自带 CORS：其预检中间件会拦截所有 OPTIONS 请求并返回
    // 204（无 DAV 头），导致 WebDAV 客户端在开发模式下无法探测 /dav。
    // /api 已由后端 Hono cors() 中间件处理；前端同源无需 CORS；
    // WebDAV 客户端（Windows/macOS/rclone）不走 CORS 机制。
    cors: false,
  },
})
