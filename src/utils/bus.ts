import mitt from "mitt"

type Events = {
  to: string
  gallery: string
  tool: string
  pathname: string
  extract: string
  "plugin:file_action_registered": any
  "plugin:header_action_registered": any
  [key: string]: any
}

export const bus = mitt<Events>()
