// USS (又拍云对象存储) driver types
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/uss

export interface UssAddition {
  bucket: string
  endpoint: string
  operator_name: string
  operator_password: string
  anti_theft_chain_token?: string
  sign_url_expire?: number
  root_folder_path?: string
}
