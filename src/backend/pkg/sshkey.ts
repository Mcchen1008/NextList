/**
 * SSH public key parsing & fingerprint helpers.
 * Pure Web Standard (TextEncoder / Web Crypto / atob-btoa-style base64),
 * works in both Node.js and Cloudflare Workers.
 */

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function base64Encode(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += BASE64_CHARS[b0 >> 2]
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]
    out +=
      i + 1 < bytes.length ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : "="
    out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 0x3f] : "="
  }
  return out
}

function base64Decode(input: string): Uint8Array | null {
  const clean = input.replace(/[\s\r\n]/g, "")
  if (clean.length % 4 === 1) return null
  let out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let outIdx = 0
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    if (ch === "=") break
    const idx = BASE64_CHARS.indexOf(ch)
    if (idx === -1) return null
    buffer = (buffer << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[outIdx++] = (buffer >> bits) & 0xff
    }
  }
  return out.slice(0, outIdx)
}

/** Known SSH public key algorithm prefixes (RFC 4253 + common extensions). */
const KNOWN_KEY_TYPES = [
  "ssh-rsa",
  "ssh-dss",
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "sk-ssh-ed25519@openssh.com.webauthn",
  "sk-ecdsa-sha2-nistp256@openssh.com.webauthn",
]

export interface ParsedSshKey {
  type: string
  /** Raw base64 blob (the key material, without padding issues). */
  blobBase64: string
  comment: string
}

/**
 * Parse an OpenSSH authorized_keys line like
 * `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@host`.
 * Returns null when the line is not a valid public key.
 */
export function parseSshKey(keyText: string): ParsedSshKey | null {
  const parts = String(keyText || "")
    .trim()
    .split(/\s+/)
  if (parts.length < 2) return null
  const type = parts[0]
  if (!KNOWN_KEY_TYPES.includes(type)) return null
  const blob = base64Decode(parts[1])
  if (!blob || blob.length < 16) return null
  return {
    type,
    blobBase64: parts[1].replace(/[\s\r\n]/g, ""),
    comment: parts.slice(2).join(" ") || "",
  }
}

/**
 * Compute the OpenSSH-style SHA256 fingerprint: `SHA256:<base64-no-padding>`.
 */
export async function sshKeyFingerprint(
  keyText: string,
): Promise<string | null> {
  const parsed = parseSshKey(keyText)
  if (!parsed) return null
  const bytes = base64Decode(parsed.blobBase64)
  if (!bytes) return null
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  const hash = new Uint8Array(digest)
  // OpenSSH fingerprint base64 has no padding
  return "SHA256:" + base64Encode(hash).replace(/=+$/, "")
}

/** Generate a short unique key id (string, matching the frontend type). */
export function newSshKeyId(): string {
  const g = globalThis as any
  if (typeof g.crypto?.randomUUID === "function") {
    return g.crypto.randomUUID()
  }
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  )
}
