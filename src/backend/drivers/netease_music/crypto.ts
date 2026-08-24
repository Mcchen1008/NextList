/**
 * NetEase Music request crypto (weapi / linuxapi / eapi).
 * Ported 1:1 from OpenList drivers/netease_music/crypto.go.
 *
 * - AES-CBC (PKCS7) via Web Crypto — works on Cloudflare Workers & Node 18+.
 * - AES-ECB emulated with per-block AES-CBC + zero IV (ECB is not exposed
 *   by Web Crypto).
 * - Raw RSA (no padding) via BigInt modular exponentiation; the modulus /
 *   exponent are extracted once from the fixed public key embedded in the
 *   upstream source.
 */

import { md5 } from "../../pkg/crypto"

// ─── Constants (from upstream crypto.go) ─────────────────────────────────────

const LINUXAPI_KEY = new TextEncoder().encode("rFgB&h#%2?^eDg:Q")
const EAPI_KEY = new TextEncoder().encode("e82ckenh8dichen8")
const IV = new TextEncoder().encode("0102030405060708")
const PRESET_KEY = new TextEncoder().encode("0CoJUm6Qyw8W8jud")
const STD_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

// RSA public key (PKCS#1 RSAPublicKey values extracted from the PEM in
// upstream crypto.go):
//   MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ3...
const RSA_MODULUS = BigInt(
  "0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b7251" +
    "52b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecb" +
    "da92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813c" +
    "fe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7",
)
const RSA_EXPONENT = BigInt(65537)

// ─── Low-level helpers ───────────────────────────────────────────────────────

function hexEncode(buf: Uint8Array): string {
  let out = ""
  for (const b of buf) out += b.toString(16).padStart(2, "0")
  return out
}

function base64Encode(buf: Uint8Array): string {
  let binary = ""
  for (const b of buf) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** PKCS7 padding (upstream pkcs7Padding). */
function pkcs7Pad(src: Uint8Array, blockSize: number): Uint8Array {
  const padding = blockSize - (src.length % blockSize)
  const out = new Uint8Array(src.length + padding)
  out.set(src)
  out.fill(padding, src.length)
  return out
}

/** Pad a key to 16/24/32 bytes (upstream aesKeyPending). */
function aesKeyPending(key: Uint8Array): Uint8Array {
  const k = key.length
  let count = 0
  if (k <= 16) count = 16 - k
  else if (k <= 24) count = 24 - k
  else if (k <= 32) count = 32 - k
  else return key.slice(0, 32)
  if (count === 0) return key
  const out = new Uint8Array(k + count)
  out.set(key)
  return out
}

/**
 * AES-CBC encrypt. Web Crypto applies PKCS#7 padding itself, so the input
 * is passed unpadded (this matches Go's manual pkcs7Padding + unpadded
 * crypto/cipher output byte-for-byte).
 */
async function aesCbcEncrypt(
  src: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    aesKeyPending(key) as any,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  )
  const out = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: iv as any },
    cryptoKey,
    src as any,
  )
  return new Uint8Array(out)
}

/**
 * AES-ECB emulation: PKCS7-pad once, then encrypt each 16-byte block
 * independently with AES-CBC + zero IV. CBC over a single block equals ECB;
 * Web Crypto appends a full padding block to the single-block input, so only
 * the first 16 bytes of each CBC output are kept.
 */
async function aesEcbEncrypt(
  src: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const zeroIv = new Uint8Array(16)
  const padded = pkcs7Pad(src, 16)
  const out = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) {
    const block = await aesCbcEncrypt(padded.slice(i, i + 16), key, zeroIv)
    out.set(block.subarray(0, 16), i)
  }
  return out
}

/** BigInt helpers for raw RSA. */
function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return hex ? BigInt("0x" + hex) : BigInt(0)
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = "0" + hex
  const bytes = new Uint8Array(length)
  const raw = new Uint8Array(hex.length / 2)
  for (let i = 0; i < raw.length; i++) {
    raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  // right-align into `length` bytes (big-endian)
  bytes.set(raw.subarray(Math.max(0, raw.length - length)))
  return bytes
}

/** Modular exponentiation by squaring (base^exp mod mod). */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = BigInt(1)
  let b = base % mod
  let e = exp
  while (e > 0) {
    if (e & BigInt(1)) result = (result * b) % mod
    b = (b * b) % mod
    e >>= BigInt(1)
  }
  return result
}

/**
 * Raw RSA (upstream rsaEncrypt): 112 zero bytes + 16-byte secret key form a
 * 128-byte message which is exponentiated with e=65537 mod n. This matches
 * Go's `c.Exp(c, big.NewInt(65537), pub.N).Bytes()` (no PKCS#1 padding).
 */
function rsaEncrypt(buffer: Uint8Array): Uint8Array {
  const padded = new Uint8Array(128)
  padded.set(buffer, 128 - buffer.length)
  const c = modPow(bytesToBigInt(padded), RSA_EXPONENT, RSA_MODULUS)
  return bigIntToBytes(c, 128)
}

/** Random 16-char secret key + its reversed twin (upstream getSecretKey). */
function getSecretKey(): { secretKey: Uint8Array; reversedKey: Uint8Array } {
  const key = new Uint8Array(16)
  const reversed = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    const ch = STD_CHARS.charCodeAt(Math.floor(Math.random() * 62))
    key[i] = ch
    reversed[15 - i] = ch
  }
  return { secretKey: key, reversedKey: reversed }
}

// ─── Encryptors (mirror upstream signatures) ─────────────────────────────────

/** weapi(params): `params` + `encSecKey` form fields. */
export async function weapi(
  data: Record<string, string>,
): Promise<{ params: string; encSecKey: string }> {
  const text = new TextEncoder().encode(JSON.stringify(data))
  const { secretKey, reversedKey } = getSecretKey()

  // Layer 1: AES-CBC(plaintext, presetKey, iv) → base64
  const layer1 = await aesCbcEncrypt(text, PRESET_KEY, IV)
  const layer1B64 = base64Encode(layer1)

  // Layer 2: AES-CBC(base64(layer1), reversedKey, iv) → base64
  const layer2 = await aesCbcEncrypt(
    new TextEncoder().encode(layer1B64),
    reversedKey,
    IV,
  )

  return {
    params: base64Encode(layer2),
    encSecKey: hexEncode(rsaEncrypt(secretKey)),
  }
}

/** linuxapi(data): `eparams` (uppercase hex AES-ECB) form field. */
export async function linuxapi(
  data: Record<string, unknown>,
): Promise<{ eparams: string }> {
  const text = new TextEncoder().encode(JSON.stringify(data))
  const encrypted = await aesEcbEncrypt(text, LINUXAPI_KEY)
  return { eparams: hexEncode(encrypted).toUpperCase() }
}

/** eapi(url, data): `params` (hex AES-ECB of `url-36cd479b6b5-json-digest`). */
export async function eapi(
  url: string,
  data: Record<string, unknown>,
): Promise<{ params: string }> {
  const text = JSON.stringify(data)
  const digest = md5("nobody" + url + "use" + text + "md5forencrypt")
  const msg = url + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest
  const encrypted = await aesEcbEncrypt(new TextEncoder().encode(msg), EAPI_KEY)
  return { params: hexEncode(encrypted) }
}

/** NetEase request "characteristic" header (used by eapi; parity with upstream). */
export function buildCharacteristic(musicU: string): Record<string, string> {
  return {
    osver: "",
    deviceId: "",
    mobilename: "",
    appver: "6.1.1",
    versioncode: "140",
    buildver: String(Math.floor(Date.now() / 1000)),
    resolution: "1920x1080",
    os: "android",
    channel: "",
    requestId: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
    MUSIC_U: musicU,
  }
}
