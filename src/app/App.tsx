import { Progress, ProgressIndicator } from "@hope-ui/solid"
import { Route, Routes, useIsRouting } from "@solidjs/router"
import {
  Component,
  createEffect,
  createSignal,
  lazy,
  Match,
  onCleanup,
  Switch,
} from "solid-js"
import { Portal } from "solid-js/web"
import { Error, FullScreenLoading } from "~/components"
import { useLoading, useRouter, useT } from "~/hooks"
import { installRequired, setInstallRequired, setSettings } from "~/store"
import { Resp } from "~/types"
import { base_path, bus, initPluginEngine, r } from "~/utils"
import { MustUser, UserOrGuest } from "./MustUser"
import "./index.css"
import { globalStyles } from "./theme"

const Home = lazy(() => import("~/pages/home/Layout"))
const Manage = lazy(() => import("~/pages/manage"))
const Login = lazy(() => import("~/pages/login"))
const Install = lazy(() => import("~/pages/install"))

const App: Component = () => {
  const t = useT()
  globalStyles()
  initPluginEngine()
  const isRouting = useIsRouting()
  const { to, pathname } = useRouter()
  const onTo = (path: string) => {
    to(path)
  }
  bus.on("to", onTo)
  onCleanup(() => {
    bus.off("to", onTo)
  })

  createEffect(() => {
    bus.emit("pathname", pathname())
  })

  const [err, setErr] = createSignal<string[]>([])
  const [loading, data] = useLoading(() =>
    Promise.all([
      (async () => {
        const resp = (await r.get("/public/settings")) as Resp<
          Record<string, string>
        >
        if (resp && resp.code === 200) {
          setSettings(resp.data)
        } else {
          console.warn(
            "Using client-side fallback settings due to API failure:",
            resp?.message || "unknown",
          )
          const defaultSettings = {
            site_title: "NextList",
            logo: "/logo.png",
            favicon: "/favicon.png",
            announcement:
              "欢迎使用 NextList! (运行于 Serverless 离线 fallback 模式)",
            main_color: "#1890ff",
            home_container: "hope_container",
            home_icon: "nextlist",
            settings_layout: "simple",
            version: "alpha0.1.2",
          }
          setSettings(defaultSettings)
        }
      })(),
      (async () => {
        // 安装状态独立获取：失败时不阻塞主流程（保持未知，不触发跳转）
        try {
          const resp = (await r.get("/install/status")) as Resp<{
            required: boolean
          }>
          if (resp && resp.code === 200) {
            setInstallRequired(!!resp.data?.required)
          }
        } catch {
          // 状态未知时不做任何跳转
        }
      })(),
    ]),
  )
  data()

  // 安装向导路由守卫：全新实例把所有入口引到 /install；
  // 已完成的实例访问 /install 自动回主页。
  createEffect(() => {
    const required = installRequired()
    if (required === null) return
    const current = pathname()
    if (required && current !== "/install") {
      to("/install")
    } else if (!required && current === "/install") {
      to("/")
    }
  })
  return (
    <>
      <Portal>
        <Progress
          indeterminate
          size="xs"
          position="fixed"
          top="0"
          left="0"
          right="0"
          zIndex="$banner"
          d={isRouting() ? "block" : "none"}
        >
          <ProgressIndicator />
        </Progress>
      </Portal>
      <Switch
        fallback={
          <Routes base={base_path}>
            <Route path="/install" component={Install} />
            <Route path="/@login" component={Login} />
            <Route
              path="/@manage/*"
              element={
                <MustUser>
                  <Manage />
                </MustUser>
              }
            />
            <Route
              path={["/@s/*", "/%40s/*"]}
              element={
                <UserOrGuest>
                  <Home />
                </UserOrGuest>
              }
            />
            <Route
              path="*"
              element={
                // Main site: without login, visitors are redirected to the
                // login page unless the guest account is enabled by admin.
                <UserOrGuest forceLogin>
                  <Home />
                </UserOrGuest>
              }
            />
          </Routes>
        }
      >
        <Match when={err().length > 0}>
          <Error
            h="100vh"
            msg={
              t("home.fetching_settings_failed") +
              err()
                .map((e) => t("home." + e))
                .join(", ")
            }
          />
        </Match>
        <Match when={loading()}>
          <FullScreenLoading />
        </Match>
        {/* 需要安装时先挡住其他页面，等守卫跳到 /install */}
        <Match when={installRequired() === true && pathname() !== "/install"}>
          <FullScreenLoading />
        </Match>
        {/* 已完成安装时挡住向导页，等守卫跳回主页 */}
        <Match when={installRequired() === false && pathname() === "/install"}>
          <FullScreenLoading />
        </Match>
      </Switch>
    </>
  )
}

export default App
