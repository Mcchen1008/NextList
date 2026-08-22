/**
 * SSH public key CRUD helpers operating on a user record.
 * Keys are stored on the user object as `ssh_keys`:
 *   { id, title, key, fingerprint, added_time, last_used_time }
 */
import { parseSshKey, sshKeyFingerprint, newSshKeyId } from "../../pkg/sshkey"

export interface StoredSshKey {
  id: string
  title: string
  key: string
  fingerprint: string
  added_time: string
  last_used_time: string
}

export interface SshKeyFrontend {
  id: string
  title: string
  fingerprint: string
  added_time: string
  last_used_time: string
}

export function getUserSshKeys(user: any): StoredSshKey[] {
  if (!user || !Array.isArray(user.ssh_keys)) return []
  return user.ssh_keys
}

export function serializeSshKey(k: StoredSshKey): SshKeyFrontend {
  return {
    id: k.id,
    title: k.title,
    fingerprint: k.fingerprint,
    added_time: k.added_time,
    last_used_time: k.last_used_time,
  }
}

export type AddKeyResult =
  | { ok: true; key: StoredSshKey }
  | { ok: false; error: string }

/**
 * Validate & append a public key to a user. Returns the created key or an
 * error message. Mutates `user.ssh_keys` (caller must saveDb).
 */
export async function addUserSshKey(
  user: any,
  title: string,
  keyText: string,
): Promise<AddKeyResult> {
  const parsed = parseSshKey(keyText)
  if (!parsed) {
    return {
      ok: false,
      error:
        "Invalid SSH public key. Expected format: '<key-type> <base64-key> [comment]'",
    }
  }
  const fingerprint = await sshKeyFingerprint(keyText)
  if (!fingerprint) {
    return { ok: false, error: "Invalid SSH public key (fingerprint failed)" }
  }
  if (!user.ssh_keys) user.ssh_keys = []
  const now = new Date().toISOString()
  const key: StoredSshKey = {
    id: newSshKeyId(),
    title: (title || "").trim() || parsed.comment || parsed.type,
    key: keyText.trim(),
    fingerprint,
    added_time: now,
    last_used_time: now,
  }
  user.ssh_keys.push(key)
  return { ok: true, key }
}

/**
 * Remove a key by id. Returns true when a key was removed (caller must
 * saveDb when true).
 */
export function deleteUserSshKey(user: any, id: string): boolean {
  if (!user || !Array.isArray(user.ssh_keys)) return false
  const before = user.ssh_keys.length
  user.ssh_keys = user.ssh_keys.filter((k: any) => String(k.id) !== String(id))
  return user.ssh_keys.length !== before
}
