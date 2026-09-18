import {
  Box,
  Button,
  Center,
  Checkbox,
  Flex,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  Icon,
  Image,
  Input,
  Radio,
  RadioGroup,
  Text,
  useColorModeValue,
  VStack,
} from "@hope-ui/solid"
import { FiCheck } from "solid-icons/fi"
import { createSignal, Match, onMount, Show, Switch } from "solid-js"
import { SwitchColorMode, SwitchLanguageWhite } from "~/components"
import { useT, useTitle, useRouter } from "~/hooks"
import { getSetting, installRequired, setInstallRequired } from "~/store"
import { handleRespWithoutAuthAndNotify, notify, r } from "~/utils"
import { Resp } from "~/types"
import LoginBg from "~/pages/login/LoginBg"

type Mode = "password" | "backup"

interface DoneCounts {
  settings: number
  users: number
  storages: number
  metas: number
  shares: number
}

const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html"

const StepDot = (props: { step: number; label: string; current: number }) => {
  const done = () => props.step < props.current
  const active = () => props.step === props.current
  return (
    <HStack spacing="$1_5">
      <Box
        w="$5"
        h="$5"
        rounded="$full"
        flexShrink={0}
        display="flex"
        alignItems="center"
        justifyContent="center"
        bg={done() || active() ? "$info9" : "$neutral4"}
        color={done() || active() ? "white" : "$neutral10"}
        fontSize="$xs"
      >
        <Show when={done()} fallback={props.step}>
          <Icon as={FiCheck} boxSize="$3_5" />
        </Show>
      </Box>
      <Text fontSize="$xs" color={active() ? "$neutral12" : "$neutral10"}>
        {props.label}
      </Text>
    </HStack>
  )
}

const Install = () => {
  const t = useT()
  useTitle(() => `${t("install.title")} - ${getSetting("site_title")}`)
  const { to } = useRouter()
  const bgColor = useColorModeValue("white", "$neutral1")
  const logos = getSetting("logo").split("\n")
  const logo = useColorModeValue(logos[0], logos.pop())

  const [step, setStep] = createSignal(1)
  const [agreed, setAgreed] = createSignal(false)

  const [mode, setMode] = createSignal<Mode>("password")
  const [pwd, setPwd] = createSignal("")
  const [pwd2, setPwd2] = createSignal("")
  const [backupFile, setBackupFile] = createSignal<File | null>(null)
  const [backupPwd, setBackupPwd] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [statusError, setStatusError] = createSignal(false)
  const [doneCounts, setDoneCounts] = createSignal<DoneCounts | null>(null)

  let fileInput: HTMLInputElement | undefined

  // 已安装的实例不允许停留在 /install，App 的路由守卫会跳回主页；
  // 这里兜底处理 App 初始化时状态获取失败（仍为 null）的情况。
  onMount(async () => {
    if (installRequired() !== null) return
    try {
      const resp = (await r.get("/install/status")) as Resp<{
        required: boolean
      }>
      if (resp && resp.code === 200) {
        setInstallRequired(!!resp.data?.required)
      } else {
        setStatusError(true)
      }
    } catch {
      setStatusError(true)
    }
  })

  const onFileChange = (e: Event) => {
    const files = (e.currentTarget as HTMLInputElement).files
    setBackupFile(files && files.length > 0 ? files[0] : null)
  }

  const submit = async () => {
    if (submitting()) return
    if (pwd().length < 8) {
      notify.warning(t("install.password_too_short"))
      return
    }
    if (pwd() !== pwd2()) {
      notify.warning(t("install.password_mismatch"))
      return
    }
    let backup: any
    if (mode() === "backup") {
      const file = backupFile()
      if (!file) {
        notify.warning(t("install.no_backup_file"))
        return
      }
      try {
        backup = JSON.parse(await file.text())
      } catch {
        notify.error(t("install.invalid_backup"))
        return
      }
    }
    setSubmitting(true)
    const resp = (await r.post("/install/complete", {
      agree: true,
      mode: mode(),
      password: pwd(),
      backup,
      backup_password: backupPwd(),
    })) as Resp<{ counts?: DoneCounts }>
    handleRespWithoutAuthAndNotify(
      resp,
      (data: any) => {
        if (data?.counts) setDoneCounts(data.counts)
        setPwd("")
        setPwd2("")
        setBackupPwd("")
        setBackupFile(null)
        // 不在此处更新 installRequired：否则路由守卫会把“返回主页”
        // 之前的完成页一并跳走。goHome 时再同步状态。
        setStep(3)
      },
      (msg, code) => {
        if (code === 403) {
          // 安装期间被他人抢先完成：同步状态，由守卫带回主页
          notify.error(t("install.already_installed"))
          setInstallRequired(false)
        } else {
          notify.error(msg)
        }
      },
    )
    setSubmitting(false)
  }

  const goHome = () => {
    setInstallRequired(false)
    to("/")
  }

  return (
    <Center zIndex="$docked" w="$full" minH="100vh" py="$6">
      <VStack
        bgColor={bgColor()}
        rounded="$xl"
        p="24px"
        w={{
          "@initial": "90%",
          "@sm": "364px",
        }}
        spacing="$4"
      >
        <Flex alignItems="center" justifyContent="space-around">
          <Image mr="$2" boxSize="$12" src={logo()} />
          <Heading color="$info9" fontSize="$2xl">
            {t("install.title")}
          </Heading>
        </Flex>
        <HStack w="$full" spacing="$1">
          <StepDot
            step={1}
            label={t("install.step_agreement")}
            current={step()}
          />
          <Box flex="1" h="1px" bg="$neutral6" />
          <StepDot step={2} label={t("install.step_admin")} current={step()} />
          <Box flex="1" h="1px" bg="$neutral6" />
          <StepDot step={3} label={t("install.step_done")} current={step()} />
        </HStack>
        <Switch>
          <Match when={step() === 1}>
            <Text w="$full" fontWeight="$semibold">
              {t("install.agreement_title")}
            </Text>
            <Box
              w="$full"
              h="220px"
              p="$2"
              rounded="$md"
              bg="$neutral3"
              overflowY="auto"
            >
              <Text
                fontSize="$sm"
                style={{ "white-space": "pre-line" }}
                color="$neutral11"
              >
                {t("install.agreement_content")}
              </Text>
            </Box>
            <Checkbox
              w="$full"
              checked={agreed()}
              onChange={() => setAgreed(!agreed())}
            >
              {t("install.agree_label")}
            </Checkbox>
            <Text
              as="a"
              href={LICENSE_URL}
              target="_blank"
              fontSize="$sm"
              color="$info9"
              _hover={{ textDecoration: "underline" }}
            >
              {t("install.view_full_license")}
            </Text>
            <Button w="$full" disabled={!agreed()} onClick={() => setStep(2)}>
              {t("install.next")}
            </Button>
          </Match>
          <Match when={step() === 2}>
            <FormControl w="$full">
              <FormLabel>{t("install.mode_label")}</FormLabel>
              <RadioGroup
                value={mode()}
                onChange={(value: string) => setMode(value as Mode)}
              >
                <HStack spacing="$4">
                  <Radio value="password">{t("install.mode_password")}</Radio>
                  <Radio value="backup">{t("install.mode_backup")}</Radio>
                </HStack>
              </RadioGroup>
            </FormControl>
            <Show when={mode() === "backup"}>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={onFileChange}
              />
              <Button
                variant="outline"
                w="$full"
                onClick={() => fileInput?.click()}
              >
                {backupFile()
                  ? backupFile()!.name
                  : t("install.choose_backup_file")}
              </Button>
              <Input
                type="password"
                placeholder={t("install.backup_password_optional")}
                value={backupPwd()}
                onInput={(e) => setBackupPwd(e.currentTarget.value)}
              />
              <Text w="$full" fontSize="$xs" color="$neutral10">
                {t("install.backup_note")}
              </Text>
            </Show>
            <Input
              type="password"
              name="admin_password"
              autocomplete="new-password"
              placeholder={t("install.admin_password")}
              value={pwd()}
              onInput={(e) => setPwd(e.currentTarget.value)}
            />
            <Input
              type="password"
              name="confirm_password"
              autocomplete="new-password"
              placeholder={t("install.confirm_password")}
              value={pwd2()}
              onInput={(e) => setPwd2(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  submit()
                }
              }}
            />
            <Text w="$full" fontSize="$xs" color="$neutral10">
              {t("install.password_hint")}
            </Text>
            <HStack w="$full" spacing="$2">
              <Button
                w="$full"
                variant="outline"
                disabled={submitting()}
                onClick={() => setStep(1)}
              >
                {t("install.prev")}
              </Button>
              <Button w="$full" loading={submitting()} onClick={submit}>
                {t("install.step_done")}
              </Button>
            </HStack>
          </Match>
          <Match when={step() === 3}>
            <Text w="$full" fontSize="$lg" fontWeight="$semibold">
              {t("install.done_title")}
            </Text>
            <Text w="$full" color="$neutral10" fontSize="$sm">
              {t("install.done_msg")}
            </Text>
            <Show when={doneCounts()}>
              <Text w="$full" fontSize="$sm" color="$neutral10">
                {t("install.imported_summary") +
                  [
                    doneCounts()!.settings,
                    doneCounts()!.users,
                    doneCounts()!.storages,
                    doneCounts()!.metas,
                    doneCounts()!.shares,
                  ]
                    .map((n: number, i: number) =>
                      n > 0
                        ? t(
                            [
                              "install.count_settings",
                              "install.count_users",
                              "install.count_storages",
                              "install.count_metas",
                              "install.count_shares",
                            ][i],
                            { count: n },
                          )
                        : "",
                    )
                    .filter(Boolean)
                    .join(" / ")}
              </Text>
            </Show>
            <Button w="$full" colorScheme="primary" onClick={goHome}>
              {t("install.back_home")}
            </Button>
          </Match>
        </Switch>
        <Show when={statusError()}>
          <Text w="$full" fontSize="$sm" color="$danger9">
            {t("install.status_error")}
          </Text>
        </Show>
        <Flex
          mt="$2"
          justifyContent="space-evenly"
          alignItems="center"
          color="$neutral10"
          w="$full"
        >
          <SwitchLanguageWhite />
          <SwitchColorMode />
        </Flex>
      </VStack>
      <LoginBg />
    </Center>
  )
}

export default Install
