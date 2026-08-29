import { MountDetails } from "./obj"

export enum OrderBy {
  Name = "name",
  Size = "size",
  Modified = "modified",
  None = "",
}

export enum OrderDirection {
  Asc = "ASC",
  Desc = "DESC",
  None = "",
}

export enum ExtractFolder {
  Front = "front",
  Back = "back",
  None = "",
}

export enum WebdavPolicy {
  Redirect = "302_redirect",
  UseProxyUrl = "use_proxy_url",
  NativeProxy = "native_proxy",
}

export interface Storage {
  id: number
  mount_path: string
  order: number
  driver: string
  status: string
  /** Error message when status === "exception"; empty otherwise. */
  status_message?: string
  /** ISO timestamp of the last health check; empty = never probed. */
  checked_at?: string
  addition: string
  remark: string
  modified: string
  order_by: OrderBy
  order_direction: OrderDirection
  extract_folder: ExtractFolder
  web_proxy: boolean
  webdav_policy: WebdavPolicy
  disabled: boolean
  mount_details?: MountDetails
}

export type Addition = Record<string, string | boolean | number>
