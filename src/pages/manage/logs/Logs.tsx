import {
  Badge,
  Box,
  Button,
  HStack,
  Input,
  Select,
  SelectContent,
  SelectIcon,
  SelectListbox,
  SelectOption,
  SelectOptionIndicator,
  SelectOptionText,
  SelectTrigger,
  SelectValue,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tooltip,
  Tr,
  VStack,
} from "@hope-ui/solid"
import { createSignal, For, Show } from "solid-js"
import { useFetch, useManageTitle, useT } from "~/hooks"
import { handleResp, notify, r } from "~/utils"
import { Resp, PPageResp, PEmptyResp } from "~/types"
import { Paginator } from "~/components"
import { DeletePopover } from "../common/DeletePopover"

interface OpLogEntry {
  id: string
  timestamp: string
  user_id?: number
  username: string
  action: string
  paths: string[]
  details?: Record<string, any>
  ip?: string
  user_agent?: string
  success: boolean
  error?: string
  duration_ms?: number
}

interface OpLogStats {
  total: number
  today: number
  failed: number
  unique_users: number
}

const ACTIONS = [
  "mkdir",
  "upload",
  "rename",
  "batch_rename",
  "remove",
  "move",
  "copy",
  "remove_empty_directory",
] as const

type BadgeScheme =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent"
  | "neutral"
  | "primary"

const actionColor = (action: string): BadgeScheme => {
  switch (action) {
    case "upload":
      return "success"
    case "remove":
    case "remove_empty_directory":
      return "danger"
    case "mkdir":
      return "info"
    case "rename":
    case "batch_rename":
      return "warning"
    default:
      return "neutral"
  }
}

const formatTime = (iso: string): string => {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return iso
  }
}

const Logs = () => {
  const t = useT()
  useManageTitle("manage.sidemenu.logs")
  const PAGE_SIZE = 30

  const [logs, setLogs] = createSignal<OpLogEntry[]>([])
  const [total, setTotal] = createSignal(0)
  const [page, setPage] = createSignal(1)
  const [stats, setStats] = createSignal<OpLogStats | null>(null)

  // filters
  const [fUsername, setFUsername] = createSignal("")
  const [fAction, setFAction] = createSignal("")
  const [fKeyword, setFKeyword] = createSignal("")
  const [fSuccess, setFSuccess] = createSignal("")

  const [loading, getLogs] = useFetch(
    (): PPageResp<OpLogEntry> =>
      r.get(
        `/admin/oplog/list?page=${page()}&per_page=${PAGE_SIZE}` +
          `&username=${encodeURIComponent(fUsername())}` +
          `&action=${encodeURIComponent(fAction())}` +
          `&keyword=${encodeURIComponent(fKeyword())}` +
          `&success=${fSuccess()}`,
      ),
  )

  const loadStats = async () => {
    try {
      const resp: Resp<OpLogStats> = await r.get("/admin/oplog/stats")
      if (resp.code === 200) setStats(resp.data)
    } catch {
      // 统计失败不影响列表
    }
  }

  const refresh = async (resetPage = false) => {
    if (resetPage) setPage(1)
    const resp = await getLogs()
    handleResp(resp, (data) => {
      setLogs(data.content || [])
      setTotal(data.total || 0)
    })
    loadStats()
  }
  refresh()

  const [clearLoading, clearLogs] = useFetch(
    (): PEmptyResp => r.post("/admin/oplog/clear"),
  )

  const StatCard = (props: {
    label: string
    value: number
    danger?: boolean
  }) => (
    <Box
      px="$3"
      py="$2"
      border="1px solid $neutral6"
      rounded="$md"
      minW="110px"
    >
      <Text
        css={{
          fontSize: "$lg",
          fontWeight: "$bold",
          color: props.danger ? "$danger9" : "$primary9",
        }}
      >
        {props.value}
      </Text>
      <Text css={{ fontSize: "$xs", color: "$neutral11" }}>{props.label}</Text>
    </Box>
  )

  return (
    <VStack spacing="$2" alignItems="start" w="$full">
      <HStack spacing="$2" flexWrap="wrap" w="$full">
        <Button
          colorScheme="accent"
          loading={loading()}
          onClick={() => refresh()}
        >
          {t("global.refresh")}
        </Button>
        <DeletePopover
          name={t("logs.all_logs")}
          loading={clearLoading()}
          onClick={async () => {
            const resp = await clearLogs()
            handleResp(resp, () => {
              notify.success(t("global.success"))
              refresh()
            })
          }}
        />
        <Show when={stats()}>
          <HStack spacing="$2" ml="auto">
            <StatCard label={t("logs.stat_total")} value={stats()!.total} />
            <StatCard label={t("logs.stat_today")} value={stats()!.today} />
            <StatCard
              label={t("logs.stat_failed")}
              value={stats()!.failed}
              danger
            />
            <StatCard
              label={t("logs.stat_users")}
              value={stats()!.unique_users}
            />
          </HStack>
        </Show>
      </HStack>

      {/* 筛选栏 */}
      <HStack spacing="$2" flexWrap="wrap" w="$full">
        <Input
          w="$40"
          placeholder={t("logs.filter_username")}
          value={fUsername()}
          onInput={(e) => setFUsername(e.currentTarget.value)}
        />
        <Select value={fAction()} onChange={(v) => setFAction(v || "")}>
          <SelectTrigger as={Button} variant="outline">
            <SelectValue _placeholder={{ color: "$neutral10" }}>
              {fAction() || t("logs.filter_action")}
            </SelectValue>
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectListbox>
              <SelectOption value="">
                <SelectOptionText>
                  {t("logs.filter_all_actions")}
                </SelectOptionText>
                <SelectOptionIndicator />
              </SelectOption>
              <For each={[...ACTIONS]}>
                {(action) => (
                  <SelectOption value={action}>
                    <SelectOptionText>{action}</SelectOptionText>
                    <SelectOptionIndicator />
                  </SelectOption>
                )}
              </For>
            </SelectListbox>
          </SelectContent>
        </Select>
        <Select value={fSuccess()} onChange={(v) => setFSuccess(v || "")}>
          <SelectTrigger as={Button} variant="outline">
            <SelectValue _placeholder={{ color: "$neutral10" }}>
              {fSuccess() === "true"
                ? t("logs.result_success")
                : fSuccess() === "false"
                  ? t("logs.result_failed")
                  : t("logs.filter_result")}
            </SelectValue>
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectListbox>
              <SelectOption value="">
                <SelectOptionText>
                  {t("logs.filter_all_results")}
                </SelectOptionText>
                <SelectOptionIndicator />
              </SelectOption>
              <SelectOption value="true">
                <SelectOptionText>{t("logs.result_success")}</SelectOptionText>
                <SelectOptionIndicator />
              </SelectOption>
              <SelectOption value="false">
                <SelectOptionText>{t("logs.result_failed")}</SelectOptionText>
                <SelectOptionIndicator />
              </SelectOption>
            </SelectListbox>
          </SelectContent>
        </Select>
        <Input
          w="$52"
          placeholder={t("logs.filter_keyword")}
          value={fKeyword()}
          onInput={(e) => setFKeyword(e.currentTarget.value)}
        />
        <Button colorScheme="accent" onClick={() => refresh(true)}>
          {t("logs.search")}
        </Button>
      </HStack>

      {/* 日志表格 */}
      <Box w="$full" overflowX="auto">
        <Table highlightOnHover dense>
          <Thead>
            <Tr>
              <Th>{t("logs.col_time")}</Th>
              <Th>{t("logs.col_user")}</Th>
              <Th>{t("logs.col_action")}</Th>
              <Th>{t("logs.col_paths")}</Th>
              <Th>{t("logs.col_result")}</Th>
              <Th>{t("logs.col_ip")}</Th>
              <Th>{t("logs.col_duration")}</Th>
            </Tr>
          </Thead>
          <Tbody>
            <For each={logs()}>
              {(log) => (
                <Tr>
                  <Td css={{ whiteSpace: "nowrap" }}>
                    {formatTime(log.timestamp)}
                  </Td>
                  <Td css={{ fontWeight: "$semibold" }}>{log.username}</Td>
                  <Td>
                    <Badge colorScheme={actionColor(log.action)}>
                      {log.action}
                    </Badge>
                  </Td>
                  <Td css={{ maxW: "$400px", overflow: "hidden" }}>
                    <VStack spacing="$0_5" alignItems="start">
                      <For each={log.paths || []}>
                        {(p) => (
                          <Text
                            css={{
                              fontSize: "$xs",
                              wordBreak: "break-all",
                            }}
                          >
                            {p}
                          </Text>
                        )}
                      </For>
                    </VStack>
                  </Td>
                  <Td>
                    <Show
                      when={log.success}
                      fallback={
                        <Tooltip label={log.error || ""} disabled={!log.error}>
                          <Badge colorScheme="danger">
                            {t("logs.result_failed")}
                          </Badge>
                        </Tooltip>
                      }
                    >
                      <Badge colorScheme="success">
                        {t("logs.result_success")}
                      </Badge>
                    </Show>
                  </Td>
                  <Td css={{ whiteSpace: "nowrap" }}>{log.ip || "-"}</Td>
                  <Td css={{ whiteSpace: "nowrap" }}>
                    {log.duration_ms !== undefined
                      ? `${log.duration_ms} ms`
                      : "-"}
                  </Td>
                </Tr>
              )}
            </For>
            <Show when={!loading() && logs().length === 0}>
              <Tr>
                <Td colSpan={7}>
                  <Text
                    css={{
                      textAlign: "center",
                      color: "$neutral10",
                      py: "$4",
                    }}
                  >
                    {t("logs.empty")}
                  </Text>
                </Td>
              </Tr>
            </Show>
          </Tbody>
        </Table>
      </Box>

      <Paginator
        total={total()}
        defaultPageSize={PAGE_SIZE}
        onChange={(p) => {
          setPage(p)
          refresh()
        }}
      />
    </VStack>
  )
}

export default Logs
