import { selectedObjs as _selectedObjs } from "~/store"
import { pathBase } from "~/utils"
import { useRouter, useSelectedLink, useT } from "~/hooks"

export const useDownload = () => {
  const { rawLinks } = useSelectedLink()
  const t = useT()
  const { pathname } = useRouter()
  return {
    batchDownloadSelected: () => {
      const urls = rawLinks(true)
      urls.forEach((url) => {
        window.open(url, "_blank")
      })
    },
    playlistDownloadSelected: () => {
      const selectedObjs = _selectedObjs().filter((obj) => !obj.is_dir)
      let saveName = pathBase(pathname())
      if (selectedObjs.length === 1) {
        saveName = selectedObjs[0].name
      }
      if (!saveName) {
        saveName = t("manage.sidemenu.home")
      }
      const m3u8Content = selectedObjs.reduce(
        (acc, obj, index) =>
          `${acc}#EXTINF:-1,${obj.name}\n${rawLinks(true)[index]}\n`,
        "#EXTM3U\n",
      )
      const m3u8Blob = new Blob([m3u8Content], {
        type: "application/x-mpegURL",
      })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(m3u8Blob)
      a.download = `${saveName}.m3u8`
      a.click()
      URL.revokeObjectURL(a.href)
    },
  }
}
