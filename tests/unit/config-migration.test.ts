import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-cfg-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { readAppConfig } = await import("../../src/lib/app-config")
const { paths } = await import("../../src/lib/paths")

const writeConfigFile = async (content: string): Promise<void> => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.writeFile(paths.configPath, content)
}

const readConfigFile = (): Promise<string> =>
  fs.readFile(paths.configPath, "utf8")

test.beforeEach(async () => {
  await fs.rm(paths.configPath, { force: true })
})

// Why: readAppConfig writes the resolved config back to disk, so every install
// that ran an older build has the superseded opus default persisted. Changing
// defaultConfig alone would reach fresh installs only.
test("migrates a superseded opus default on an unversioned config", async () => {
  await writeConfigFile("opusModel: claude-opus-4.8\nport: 4142\n")

  const config = await readAppConfig()

  assert.equal(config.opusModel, "claude-opus-5")
  assert.equal(config.configVersion, 2)
})

// Why: this is the gate. Without it the rewrite runs on every start, and a user
// who deliberately pins the previous model has that edit reverted underneath
// them on the next launch - an un-settable setting.
test("leaves a deliberately pinned superseded model alone once versioned", async () => {
  await writeConfigFile("configVersion: 2\nopusModel: claude-opus-4.8\n")

  const config = await readAppConfig()

  assert.equal(config.opusModel, "claude-opus-4.8")
})

// Why: the migration must rewrite exactly one known value. Any other model is a
// deliberate choice, versioned or not.
test("never rewrites a model that was never a shipped default", async () => {
  await writeConfigFile("opusModel: claude-opus-4.6\n")

  const config = await readAppConfig()

  assert.equal(config.opusModel, "claude-opus-4.6")
})

// Why: one-time means one time. The persisted configVersion is what makes the
// second start a no-op, so it has to survive the write-back.
test("persists configVersion so the migration cannot repeat", async () => {
  await writeConfigFile("opusModel: claude-opus-4.8\n")

  await readAppConfig()
  assert.match(await readConfigFile(), /configVersion: 2/)

  // Simulate the user pinning the old model again after upgrading.
  const pinned = (await readConfigFile()).replace(
    "opusModel: claude-opus-5",
    "opusModel: claude-opus-4.8",
  )
  await fs.writeFile(paths.configPath, pinned)

  const second = await readAppConfig()
  assert.equal(second.opusModel, "claude-opus-4.8")
})

// Why: a migration that also disturbs unrelated keys is a data-loss bug. Only
// opusModel may change.
test("preserves unrelated settings across the migration", async () => {
  await writeConfigFile(
    [
      "opusModel: claude-opus-4.8",
      "gptModel: gpt-5.5",
      "port: 5000",
      "logLevel: debug",
      "logRetentionDays: 7",
      "thinkEffort: low",
      "upstreamTimeoutSeconds: 90",
      "",
    ].join("\n"),
  )

  const config = await readAppConfig()

  assert.equal(config.opusModel, "claude-opus-5")
  assert.equal(config.gptModel, "gpt-5.5")
  assert.equal(config.port, 5000)
  assert.equal(config.logLevel, "debug")
  assert.equal(config.logRetentionDays, 7)
  assert.equal(config.thinkEffort, "low")
  assert.equal(config.upstreamTimeoutSeconds, 90)
})

// Why: a fresh install has nothing to migrate and must land on the new default
// directly, at the current schema version.
test("uses the new default for a fresh install", async () => {
  const config = await readAppConfig()

  assert.equal(config.opusModel, "claude-opus-5")
  assert.equal(config.configVersion, 2)
})

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})
