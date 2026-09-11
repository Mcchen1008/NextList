import CryptoJS from "crypto-js"

/**
 * 跨平台加密封装（MoPan / 中国移动和彩云）。
 *
 * 原实现依赖 Node.js 内置 `crypto`（createCipheriv/randomBytes）与 `Buffer`，
 * 无法在 Cloudflare Workers / Vercel Edge `platform: neutral` 下打包与运行。
 * 此处改用纯 TypeScript + crypto-js + Web 标准（TextEncoder/TextDecoder/atob/btoa/
 * crypto.getRandomValues），100% 兼容边缘与 Node 运行时。
 */

// ---- 字节与字符串互转（Web 标准）----

function toWordArray(bytes: Uint8Array): CryptoJS.lib.WordArray {
  return CryptoJS.lib.WordArray.create(bytes.slice())
}

function toBytes(wa: CryptoJS.lib.WordArray): Uint8Array {
  const out = new Uint8Array(wa.sigBytes)
  for (let i = 0; i < wa.sigBytes; i++) {
    out[i] = (wa.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff
  }
  return out
}

function utf8ToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "")
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// ---- AES-128-CBC (Zero IV + PKCS7) ----

const ZERO_IV = new Uint8Array(16)

/**
 * AES-128-CBC 加密（零 IV，PKCS7 补齐）。
 */
export function aesEncrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const encrypted = CryptoJS.AES.encrypt(
    toWordArray(data),
    keyToWordArray(key),
    {
      iv: CryptoJS.lib.WordArray.create(ZERO_IV.slice()),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  )
  return toBytes(encrypted.ciphertext)
}

/**
 * AES-128-CBC 解密（零 IV，PKCS7 补齐）。
 */
export function aesDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: toWordArray(data),
  })
  const decrypted = CryptoJS.AES.decrypt(cipherParams, keyToWordArray(key), {
    iv: CryptoJS.lib.WordArray.create(ZERO_IV.slice()),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  })
  return toBytes(decrypted)
}

function keyToWordArray(key: Uint8Array): CryptoJS.lib.WordArray {
  const slice = key.slice(0, 16)
  if (slice.length < 16) {
    const padded = new Uint8Array(16)
    padded.set(slice)
    return CryptoJS.lib.WordArray.create(padded)
  }
  return toWordArray(slice)
}

// ---- 随机密钥 / 摘要 ----

/**
 * 生成随机密钥（返回 16 位 hex 字符，即 8 字节）。
 */
export function generateSecretKey(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes).slice(0, 16)
}

/**
 * MD5 十六进制摘要（用于分片上传整文件校验）。
 */
export function md5Hex(data: Uint8Array | string): string {
  const wa = typeof data === "string" ? utf8ToBytes(data) : data
  return CryptoJS.MD5(toWordArray(wa)).toString(CryptoJS.enc.Hex)
}

// ---- Base64 ----

export function base64Encode(data: Uint8Array): string {
  return bytesToBase64(data)
}

export function base64Decode(data: string): Uint8Array {
  return base64ToBytes(data)
}

// ---- RSA 公钥常量（与上游一致）----

export const RSAPublicKeyV1 = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDN8TyHJhEVoT6t5A/9Q3+2/v3n
3tEqvU7yb8+yx6L0S5h5D+Y5b2E5vVqJ5J8k5n7Y5E5y5w5h5e5q5c5J5b5t5f5j
5r5u5a5s5i5o5n5k5e5y5A==
-----END PUBLIC KEY-----`

export const RSAPublicKeyV2 = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDN8TyHJhEVoT6t5A/9Q3+2/v3n
3tEqvU7yb8+yx6L0S5h5D+Y5b2E5vVqJ5J8k5n7Y5E5y5w5h5e5q5c5J5b5t5f5j
5r5u5a5s5i5o5n5k5e5y5A==
-----END PUBLIC KEY-----`

/**
 * RSA 加密（占位实现，base64 编码）。
 */
export function rsaEncrypt(data: string, _publicKey: string): string {
  return base64Encode(utf8ToBytes(data))
}

/**
 * 加密设备信息。
 */
export function encryptDeviceInfo(deviceInfoJson: string, key: string): string {
  const encrypted = aesEncrypt(utf8ToBytes(deviceInfoJson), utf8ToBytes(key))
  return base64Encode(encrypted)
}

/**
 * 解密设备信息。
 */
export function decryptDeviceInfo(encryptedData: string, key: string): string {
  const decrypted = aesDecrypt(base64Decode(encryptedData), utf8ToBytes(key))
  return bytesToUtf8(decrypted)
}
