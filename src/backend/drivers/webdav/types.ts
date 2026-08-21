export interface WebdavAddition {
  address: string
  username?: string
  password?: string
  root_folder_path?: string
  tls_insecure_skip_verify?: string | boolean
  proxy_download?: string | boolean
  order_by?: string
  order_direction?: string
}

export interface WebdavPropfindEntry {
  href: string
  isDir: boolean
  size: number
  modified: string
}
