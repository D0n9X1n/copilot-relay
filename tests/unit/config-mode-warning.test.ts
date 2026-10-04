import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// paths resolves the home directory on import, so it is redirected first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-config-mode-"))
process.env.HOME = home
process.env.USERPROFILE = home

const { exposedConfigWarning } = await import("../../src/start")
const { paths } = await import("../../src/lib/paths")

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

// Windows has no POSIX mode bits.
const posixOnly = { skip: process.platform === "win32" }
const apiKey = "relay-fixture-key-0001"

// chmod after the write, so the umask cannot narrow the mode under test.
const writeConfig = async (mode: number): Promise<void> => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.writeFile(paths.configPath, `apiKey: ${apiKey}\n`)
  await fs.chmod(paths.configPath, mode)
}

// Why: config.yaml holds the apiKey and an existing one keeps the mode it had, so on a
// shared Linux or macOS machine a 0644 file let other local users read the key.
for (const mode of [0o644, 0o640]) {
  const octal = mode.toString(8).padStart(4, "0")

  test(`warns when config.yaml holding the apiKey has mode ${octal}`, posixOnly, async () => {
    await writeConfig(mode)
    const warning = exposedConfigWarning({ apiKey })

    assert.ok(warning)
    assert.ok(warning.includes(`${paths.configPath} holds the apiKey and has mode ${octal}`))
    assert.ok(warning.includes(`Run chmod 600 ${paths.configPath}.`))
    assert.ok(!warning.includes(apiKey), "the warning repeated the key")
  })
}

test("stays quiet for an owner-only config.yaml or an empty apiKey", posixOnly, async () => {
  await writeConfig(0o600)
  assert.equal(exposedConfigWarning({ apiKey }), undefined)

  await writeConfig(0o644)
  assert.equal(exposedConfigWarning({ apiKey: "" }), undefined)
})

test("checks the file a symlinked config.yaml points to", posixOnly, async () => {
  const target = path.join(home, "dotfiles-config.yaml")
  await fs.writeFile(target, `apiKey: ${apiKey}\n`)
  await fs.chmod(target, 0o644)
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.rm(paths.configPath, { force: true })
  await fs.symlink(target, paths.configPath)

  assert.match(exposedConfigWarning({ apiKey }) ?? "", /has mode 0644/)

  await fs.chmod(target, 0o600)
  assert.equal(exposedConfigWarning({ apiKey }), undefined)
})
