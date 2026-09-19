import {
  Badge,
  Box,
  Button,
  Grid,
  HStack,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Spinner,
  Text,
  useColorModeValue,
  VStack,
} from "@hope-ui/solid"
import { createResource, createSignal, For, Show } from "solid-js"
import { FaSolidPuzzlePiece } from "solid-icons/fa"
import { FiBookOpen, FiDownload, FiGithub, FiRefreshCw } from "solid-icons/fi"
import { useManageTitle, useT } from "~/hooks"
import { Markdown } from "~/components"
import { PluginItem, Resp } from "~/types"
import {
  api,
  handleResp,
  notify,
  parsePluginZip,
  pluginEngine,
  r,
} from "~/utils"

/** 远程市场插件元数据（NextListWeb /api/plugins 返回结构） */
interface MarketPlugin {
  id: string
  name: string
  description: string
  owner: string
  ownerAvatar: string
  repoUrl: string
  icon: string | null
  stars: number
  topics: string[]
  updatedAt: string
  downloadUrl: string
}

/**
 * 插件市场：浏览 / 按名称搜索远程市场（NextListWeb）插件并一键安装。
 * 列表与搜索经后端 /admin/plugin/market/* 代理，安装复用现有
 * parsePluginZip + /admin/plugin/install 链路（ZIP 由后端代理下载）。
 */
const Market = () => {
  const t = useT()
  useManageTitle("plugins.market.title")

  const [inputValue, setInputValue] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [installing, setInstalling] = createSignal("")
  const [readmeOpen, setReadmeOpen] = createSignal(false)
  const [readmeLoading, setReadmeLoading] = createSignal(false)
  const [readmeTitle, setReadmeTitle] = createSignal("")
  const [readmeText, setReadmeText] = createSignal("")

  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  // 市场列表 / 搜索（query 变化时重新请求）
  const [data, { refetch }] = createResource(query, async (q: string) => {
    const resp: Resp<{ plugins: MarketPlugin[]; total: number }> = await r.get(
      "/admin/plugin/market/list",
      { params: { q, limit: 60 } },
    )
    if (resp.code !== 200) throw new Error(resp.message || "加载失败")
    return resp.data
  })

  // 本机已安装插件（id / name 集合，用于"已安装"标记）
  const [installed, { refetch: refetchInstalled }] = createResource(
    async () => {
      try {
        const resp: Resp<{ content: PluginItem[] }> =
          await r.get("/admin/plugin/list")
        if (resp.code !== 200) return new Set<string>()
        const keys = new Set<string>()
        for (const p of resp.data.content || []) {
          if (p.id) keys.add(p.id.toLowerCase())
          if (p.name) keys.add(p.name.toLowerCase())
        }
        return keys
      } catch {
        return new Set<string>()
      }
    },
  )

  const isInstalled = (mp: MarketPlugin) => {
    const keys = installed()
    if (!keys) return false
    return keys.has(mp.name.toLowerCase()) || keys.has(mp.id.toLowerCase())
  }

  const handleInput = (value: string) => {
    setInputValue(value)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setQuery(value.trim()), 300)
  }

  const refreshAll = () => {
    refetch()
    refetchInstalled()
  }

  const showReadme = async (mp: MarketPlugin) => {
    setReadmeTitle(mp.name)
    setReadmeText("")
    setReadmeOpen(true)
    setReadmeLoading(true)
    try {
      const resp: Resp<{ readme: string }> = await r.get(
        "/admin/plugin/market/readme",
        {
          params: { id: mp.id },
        },
      )
      if (resp.code === 200) {
        setReadmeText(resp.data?.readme || "")
      } else {
        notify.error(resp.message || "README 获取失败")
      }
    } catch (err: any) {
      notify.error(err?.message || "README 获取失败")
    } finally {
      setReadmeLoading(false)
    }
  }

  const install = async (mp: MarketPlugin) => {
    if (installing()) return
    setInstalling(mp.id)
    try {
      // 1. 经后端代理下载插件 ZIP（规避浏览器跨域与直链 302）
      const token = localStorage.getItem("token") || ""
      const downloadResp = await fetch(
        `${api}/api/admin/plugin/market/download?id=${encodeURIComponent(mp.id)}`,
        { headers: { Authorization: token } },
      )
      if (!downloadResp.ok) {
        let message = `下载失败（HTTP ${downloadResp.status}）`
        try {
          const errJson = await downloadResp.json()
          if (errJson?.message) message = errJson.message
        } catch {
          /* 非 JSON 错误体，忽略 */
        }
        notify.error(message)
        return
      }
      const buffer = await downloadResp.arrayBuffer()

      // 2. 浏览器端解析 ZIP（与"上传安装"同一套逻辑）
      const extracted = await parsePluginZip(buffer)
      const manifest = extracted.manifest
      if (!manifest || !manifest.id) {
        notify.error("插件包缺少有效清单（plugin.json）")
        return
      }

      // 3. 复用现有安装接口并热加载
      const resp: Resp<PluginItem> = await r.post("/admin/plugin/install", {
        ...manifest,
        enabled: true,
      })
      handleResp(resp, (installedPlugin) => {
        if (installedPlugin.enabled) {
          pluginEngine.loadPlugin(installedPlugin)
        }
        notify.success(t("plugins.market.install_success"))
        refetchInstalled()
      })
    } catch (err: any) {
      notify.error(err?.message || "安装失败")
    } finally {
      setInstalling("")
    }
  }

  const cardBg = useColorModeValue("$white", "$neutral3")
  const cardBorder = useColorModeValue("$neutral4", "$neutral5")
  const shadow = useColorModeValue("$sm", "$none")

  const formatDate = (iso: string) => {
    const ms = Date.parse(iso ?? "")
    if (!Number.isFinite(ms)) return ""
    return new Date(ms).toLocaleDateString()
  }

  return (
    <VStack spacing="$3" alignItems="start" w="$full">
      {/* 顶部：搜索 + 刷新 */}
      <HStack spacing="$2" w="$full" wrap={"wrap" as any}>
        <Input
          flex={1}
          minW="$56"
          type="search"
          placeholder={t("plugins.market.search_placeholder")}
          value={inputValue()}
          onInput={(e: any) => handleInput(e.currentTarget.value)}
        />
        <Button
          colorScheme="accent"
          loading={data.loading}
          onClick={refreshAll}
        >
          <FiRefreshCw />
          {t("plugins.market.refresh")}
        </Button>
      </HStack>
      <Text fontSize="$sm" color="$neutral10">
        {t("plugins.market.desc_hint")}
      </Text>

      {/* 内容区 */}
      <Show
        when={!data.loading}
        fallback={
          <HStack w="$full" justifyContent="center" py="$20">
            <Spinner color="$accent9" />
            <Text>{t("plugins.market.loading")}</Text>
          </HStack>
        }
      >
        <Show
          when={!data.error}
          fallback={
            <VStack w="$full" py="$16" spacing="$3">
              <Text color="$danger10">{t("plugins.market.load_failed")}</Text>
              <Button colorScheme="accent" size="sm" onClick={() => refetch()}>
                {t("plugins.market.retry")}
              </Button>
            </VStack>
          }
        >
          <Show
            when={(data()?.plugins?.length ?? 0) > 0}
            fallback={
              <VStack w="$full" py="$16">
                <Text color="$neutral10">{t("plugins.market.empty")}</Text>
              </VStack>
            }
          >
            <Grid
              w="$full"
              gap="$3"
              gridTemplateColumns={{
                "@initial": "1fr",
                "@md": "repeat(2, 1fr)",
                "@xl": "repeat(3, 1fr)",
              }}
            >
              <For each={data()?.plugins ?? []}>
                {(mp) => (
                  <VStack
                    p="$3"
                    spacing="$2"
                    rounded="$lg"
                    border="1px solid"
                    borderColor={cardBorder()}
                    bgColor={cardBg()}
                    shadow={shadow()}
                    alignItems="start"
                    justifyContent="space-between"
                  >
                    <HStack spacing="$2" w="$full" alignItems="center">
                      <Box
                        w="$9"
                        h="$9"
                        rounded="$md"
                        bgColor="$neutral3"
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        flexShrink={0}
                        overflow="hidden"
                      >
                        <Show
                          when={mp.icon || mp.ownerAvatar}
                          fallback={<FaSolidPuzzlePiece size={16} />}
                        >
                          <img
                            src={mp.icon || mp.ownerAvatar}
                            alt="icon"
                            style={{
                              width: "22px",
                              height: "22px",
                              "object-fit": "contain",
                            }}
                          />
                        </Show>
                      </Box>
                      <VStack
                        alignItems="start"
                        spacing="$0_5"
                        flex={1}
                        minW={"0" as any}
                      >
                        <Text
                          fontWeight="$bold"
                          fontSize="$sm"
                          noOfLines={1}
                          title={mp.name}
                        >
                          {mp.name}
                        </Text>
                        <Text fontSize="$xs" color="$neutral10" noOfLines={1}>
                          {mp.owner} · ⭐ {mp.stars} ·{" "}
                          {formatDate(mp.updatedAt)}
                        </Text>
                      </VStack>
                      <Show when={isInstalled(mp)}>
                        <Badge colorScheme="success" variant="subtle">
                          {t("plugins.market.installed")}
                        </Badge>
                      </Show>
                    </HStack>

                    <Show
                      when={mp.description}
                      fallback={<Box minH={"$4" as any} />}
                    >
                      <Text
                        fontSize="$xs"
                        color="$neutral11"
                        noOfLines={2}
                        w="$full"
                      >
                        {mp.description}
                      </Text>
                    </Show>

                    <Show
                      when={
                        (mp.topics ?? []).filter((x) => x !== "nextlist-plugin")
                          .length > 0
                      }
                    >
                      <HStack spacing="$1" wrap={"wrap" as any}>
                        <For
                          each={(mp.topics ?? [])
                            .filter((x) => x !== "nextlist-plugin")
                            .slice(0, 3)}
                        >
                          {(topic) => (
                            <Badge
                              colorScheme="neutral"
                              variant="outline"
                              fontSize="$2xs"
                            >
                              {topic}
                            </Badge>
                          )}
                        </For>
                      </HStack>
                    </Show>

                    <HStack
                      spacing="$2"
                      w="$full"
                      justifyContent="space-between"
                    >
                      <HStack spacing="$2">
                        <Button
                          size="sm"
                          colorScheme="accent"
                          disabled={isInstalled(mp)}
                          loading={installing() === mp.id}
                          onClick={() => install(mp)}
                        >
                          <FiDownload />
                          {isInstalled(mp)
                            ? t("plugins.market.installed")
                            : installing() === mp.id
                              ? t("plugins.market.installing")
                              : t("plugins.market.install")}
                        </Button>
                        <Button
                          size="sm"
                          colorScheme="neutral"
                          variant="outline"
                          onClick={() => showReadme(mp)}
                        >
                          <FiBookOpen />
                          {t("plugins.market.view_readme")}
                        </Button>
                      </HStack>
                      <a
                        href={mp.repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="GitHub"
                      >
                        <Button size="sm" variant="ghost" px="$2">
                          <FiGithub />
                        </Button>
                      </a>
                    </HStack>
                  </VStack>
                )}
              </For>
            </Grid>
            <Text fontSize="$xs" color="$neutral10">
              {t("plugins.market.count")}: {data()?.total ?? 0}
            </Text>
          </Show>
        </Show>
      </Show>

      {/* README 详情弹窗 */}
      <Modal
        opened={readmeOpen()}
        onClose={() => setReadmeOpen(false)}
        size={"4xl" as any}
        scrollBehavior="inside"
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{readmeTitle()}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Show
              when={!readmeLoading()}
              fallback={
                <HStack w="$full" justifyContent="center" py="$12">
                  <Spinner color="$accent9" />
                </HStack>
              }
            >
              <Show
                when={readmeText()}
                fallback={
                  <Text color="$neutral10">
                    {t("plugins.market.readme_empty")}
                  </Text>
                }
              >
                <Box fontSize="$sm" pb="$4">
                  <Markdown>{readmeText()}</Markdown>
                </Box>
              </Show>
            </Show>
          </ModalBody>
          <ModalFooter />
        </ModalContent>
      </Modal>
    </VStack>
  )
}

export default Market
