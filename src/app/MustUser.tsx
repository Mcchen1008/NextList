import { createSignal, JSXElement, Match, onMount, Switch } from "solid-js"
import { Error, FullScreenLoading } from "~/components"
import { useFetch, useT } from "~/hooks"
import { Me, setMe } from "~/store"
import { PResp, Resp } from "~/types"
import { r, handleResp, handleRespWithoutAuthAndNotify, bus } from "~/utils"

const MustUser = (props: { children: JSXElement }) => {
  const t = useT()
  const [loading, data] = useFetch((): PResp<Me> => r.get("/me"), true)
  const [err, setErr] = createSignal<string>()
  onMount(async () => {
    handleResp(await data(), setMe, setErr)
  })
  return (
    <Switch fallback={props.children}>
      <Match when={loading()}>
        <FullScreenLoading />
      </Match>
      <Match when={err() !== undefined}>
        <Error msg={t("home.get_current_user_failed") + err()} />
      </Match>
    </Switch>
  )
}

const UserOrGuest = (props: { children: JSXElement; forceLogin?: boolean }) => {
  // 将loading默认设置为true，修复children被提前渲染，明显症状：两个公告
  const [loading, data] = useFetch((): PResp<Me> => r.get("/me"), true)
  const [skipLogin, setSkipLogin] = createSignal(false)
  const [loginRequired, setLoginRequired] = createSignal(false)
  onMount(async () => {
    handleRespWithoutAuthAndNotify(await data(), setMe, async (_msg, _code) => {
      // Not logged in. When the route requires login (forceLogin), ask the
      // backend whether anonymous (guest) browsing is enabled:
      // - enabled  → keep the current guest fallback (browse without login)
      // - disabled → redirect to the login page
      if (props.forceLogin) {
        const resp = (await r.get("/public/guest")) as Resp<{
          enabled: boolean
        }>
        const guestEnabled = resp?.code === 200 && !!resp.data?.enabled
        if (!guestEnabled) {
          setLoginRequired(true)
          bus.emit(
            "to",
            `/@login?redirect=${encodeURIComponent(location.pathname)}`,
          )
          return
        }
      }
      setMe({
        id: 2,
        username: "guest",
        password: "",
        base_path: "/",
        role: 1,
        disabled: false,
        permission: 0,
        sso_id: "",
        otp: false,
        allow_ldap: false,
      })
      setSkipLogin(true)
    })
  })
  return (
    <Switch fallback={props.children}>
      <Match when={loginRequired()}>
        <FullScreenLoading />
      </Match>
      <Match when={!skipLogin() && loading()}>
        <FullScreenLoading />
      </Match>
    </Switch>
  )
}

export { MustUser, UserOrGuest }
