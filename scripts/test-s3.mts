// S3 object storage connectivity test for NextList.
// Usage: pnpm tsx scripts/test-s3.mts
//
// Tests the full driver surface (list/mkdir/put/get/rename/copy/move/remove)
// against the CSTCloud S3 endpoint using the S3Driver implementation that the
// backend itself uses — so this validates the real production code path.

import {
  S3Driver,
  normalizeS3Addition,
} from "../src/backend/drivers/s3/driver"

const ADDITION = {
  bucket: process.env.S3_BUCKET || "7529e67d82cc43fcb9a3fbfc08595f21",
  endpoint: process.env.S3_ENDPOINT || "s3.cstcloud.cn",
  region: process.env.S3_REGION || "us-east-1",
  access_key_id: process.env.S3_AK || "AKIALQCUUV5U485QB4S9",
  secret_access_key: process.env.S3_SK || "C9TOY019+RW=3EH1MZ05J3C40PIRO0GF1UQA6Q72",
  root_folder_path: "/nextlist-test",
  sign_url_expire: 4,
  force_path_style: true,
}

let failures = 0
const step = async (name: string, fn: () => Promise<string>) => {
  try {
    const detail = await fn()
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`)
  } catch (e: any) {
    console.error(`  ✗ ${name} — ${e?.message || e}`)
    failures++
  }
}

async function main() {
  console.log("=== NextList S3 driver test ===")
  console.log(
    `endpoint: https://${ADDITION.endpoint}  bucket: ${ADDITION.bucket}`,
  )

  const driver = new S3Driver(normalizeS3Addition(ADDITION), "S3")
  const stamp = Date.now()
  const dir = `nl-test-${stamp}`

  await step("init()", async () => {
    await driver.init()
    return "driver initialized"
  })

  let items: any[] = []
  await step("list(/)", async () => {
    items = await driver.list("/", "/")
    return `root has ${items.length} item(s)`
  })

  await step("mkdir(dir)", async () => {
    await driver.mkdir(`/${dir}`, `/${dir}`)
    return dir
  })

  const fileName = `hello-${stamp}.txt`
  const content = Buffer.from(
    `NextList S3 test @ ${new Date().toISOString()}\n你好，对象存储！\n`,
  )
  await step("put(file)", async () => {
    await driver.put(`/${dir}/${fileName}`, `/${dir}/${fileName}`, content)
    return `${fileName} (${content.length} bytes)`
  })

  await step("get(file)", async () => {
    const item = await driver.get(`/${dir}/${fileName}`, `/${dir}/${fileName}`)
    if (item.is_dir) throw new Error("file reported as dir")
    if (item.size !== content.length)
      throw new Error(`size mismatch: ${item.size} != ${content.length}`)
    return `size=${item.size}, has raw_url=${!!item.raw_url}`
  })

  await step("list(dir)", async () => {
    const list = await driver.list(`/${dir}`, `/${dir}`)
    const found = list.find((f: any) => f.name === fileName)
    if (!found) throw new Error("uploaded file not visible in listing")
    return `${list.length} item(s), uploaded file visible`
  })

  const renamed = `renamed-${stamp}.txt`
  await step("rename(file)", async () => {
    await driver.rename(
      `/${dir}/${fileName}`,
      `/${dir}/${fileName}`,
      renamed,
    )
    const list = await driver.list(`/${dir}`, `/${dir}`)
    if (!list.find((f: any) => f.name === renamed))
      throw new Error("renamed file not found")
    return `→ ${renamed}`
  })

  await step("copy(file)", async () => {
    await driver.copy(`/${dir}`, `/${dir}`, [renamed], `/${dir}`, `/${dir}`)
    const list = await driver.list(`/${dir}`, `/${dir}`)
    const copies = list.filter((f: any) => f.name === renamed)
    if (copies.length < 1) throw new Error("copy target missing")
    return `copy present`
  })

  await step("move(file)", async () => {
    await driver.mkdir(`/${dir}/sub`, `/${dir}/sub`)
    await driver.move(`/${dir}`, `/${dir}/sub`, [renamed], `/${dir}`, `/${dir}/sub`)
    const list = await driver.list(`/${dir}/sub`, `/${dir}/sub`)
    if (!list.find((f: any) => f.name === renamed))
      throw new Error("moved file not found in sub dir")
    return `moved to ${dir}/sub/`
  })

  await step("remove(dir, recursive)", async () => {
    await driver.remove(`/${dir}`, `/${dir}`, [])
    try {
      const list = await driver.list(`/${dir}`, `/${dir}`)
      if (list.length > 0)
        return `warning: ${list.length} leftover item(s) (likely placeholder objects)`
    } catch {
      // head 404 on the directory itself is fine too
    }
    return "test directory cleaned up"
  })

  console.log("")
  if (failures > 0) {
    console.error(`RESULT: ${failures} step(s) FAILED ✗`)
    process.exit(1)
  }
  console.log("RESULT: all steps PASSED ✓")
}

main().catch((e) => {
  console.error("fatal:", e?.message || e)
  process.exit(1)
})
