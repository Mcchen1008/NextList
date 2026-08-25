// Seafile driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/seafile

export interface SeafileAddition {
  address: string
  username?: string
  password?: string
  token?: string
  repo_id?: string
  root_folder_path?: string
  repo_pwd?: string
}

export interface SeafileAuthTokenResp {
  token: string
}

export interface SeafileRepoItem {
  id: string
  type: string // "repo" | "dir" | "file"
  name: string
  size: number
  mtime: number
  permission: string
}

export interface SeafileLibraryItem extends SeafileRepoItem {
  owner_contact_email?: string
  owner_name?: string
  owner?: string
  modifier_email?: string
  modifier_contact_email?: string
  modifier_name?: string
  virtual?: boolean
  mtime_relative?: string
  encrypted?: boolean
  version?: number
  head_commit_id?: string
  root?: string
  salt?: string
  size_formatted?: string
}
