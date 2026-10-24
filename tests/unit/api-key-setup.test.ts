import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// paths.ts resolves the home directory at import time, so it is redirected first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-api-key-"))
process.env.HOME = home
process.env.USERPROFILE = home

const { ensureApiKey, readAppConfig } = await import("../../src/lib/app-config")
const { paths } = await import("../../src/lib/paths")

test.after(() => fs.rm(home, { recursive: true, force: true }))

test("setup creates an apiKey in the empty line and keeps every other line", async () => {
  await readAppConfig()
  const before = await fs.readFile(paths.configPath, "utf8")
  assert.match(before, /^apiKey:[ \t]*$/m)

  const created = await ensureApiKey()
  assert.equal(created.created, true)
  assert.match(created.apiKey, /^cr-[A-Za-z0-9_-]{32}$/)

  const after = await fs.readFile(paths.configPath, "utf8")
  assert.equal(after.replace(/^apiKey: "cr-[A-Za-z0-9_-]{32}"$/m, "apiKey:"), before.replace(/^apiKey:[ \t]*$/m, "apiKey:"))
  assert.equal((await readAppConfig()).apiKey, created.apiKey)
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(paths.configPath)).mode & 0o777, 0o600)
  }

  const again = await ensureApiKey()
  assert.deepEqual(again, { apiKey: created.apiKey, created: false })
})
