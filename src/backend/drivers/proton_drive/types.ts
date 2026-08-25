// ProtonDrive driver types — placeholder for future port
// Based on: https://github.com/OpenListTeam/OpenList/tree/main/drivers/proton_drive
//
// ⚠️ STATUS: NOT IMPLEMENTED
//
// ProtonDrive is a zero-knowledge encrypted cloud drive. To port it
// faithfully to TypeScript (without the `@pdrive/sdk` npm package),
// we would need to implement the full ProtonMail crypto stack:
//
//   1. SRP-6a authentication (Secure Remote Password)
//   2. bcrypt + Argon2id for password verification
//   3. Curve25519 / X25519 key exchange
//   4. Ed25519 signature verification
//   5. AES-256-GCM + Poly1305 for file/key encryption
//   6. RSA-OAEP for sharing keys
//   7. OpenPGP packet format parsing (for filesystem metadata)
//   8. Full Merkle-tree based block hash verification
//
// The Go upstream uses `github.com/hunyxv/protondrive` (~3000 LOC of
// crypto + API glue). A pure-TypeScript re-implementation that stays
// Cloudflare-Workers-compatible (Web Crypto only) would be ~3000+ lines.
//
// RECOMMENDED PATH:
//   - Skip for now in this porting effort.
//   - For ProtonDrive support, install `@pdrive/sdk` as an npm dependency
//     and use the Node.js container backend (will break CF Workers compat).
//   - Or wait until a pure-JS Web Crypto implementation of Proton's auth
//     stack is extracted to a reusable library.
//
// See: https://github.com/ProtonMail/WebClients/ for reference.

export interface ProtonDriveAddition {
  refresh_token: string
  root_folder_path?: string
}
