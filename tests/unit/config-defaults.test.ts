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

// Why: the whole rule in one test. readAppConfig() writes the resolved config
// back to disk, so an existing install has every key materialized; a shipped
// default must never overwrite what the user's file already holds.
test("returns persisted values unchanged", async () => {
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

  assert.equal(config.opusModel, "claude-opus-4.8")
  assert.equal(config.gptModel, "gpt-5.5")
  assert.equal(config.port, 5000)
  assert.equal(config.logLevel, "debug")
  assert.equal(config.logRetentionDays, 7)
  assert.equal(config.thinkEffort, "low")
  assert.equal(config.upstreamTimeoutSeconds, 90)
})

// Why: this is the behavior the removed migration used to change. Asserting it
// directly records the accepted tradeoff - a superseded model stays until the
// user edits it, and no start silently moves them off it.
test("never rewrites a superseded model on repeated reads", async () => {
  await writeConfigFile("opusModel: claude-opus-4.8\n")

  assert.equal((await readAppConfig()).opusModel, "claude-opus-4.8")
  assert.equal((await readAppConfig()).opusModel, "claude-opus-4.8")
  assert.match(await readConfigFile(), /opusModel: claude-opus-4\.8/)
})

// Why: a default applies exactly where a key is absent, and nowhere else.
test("applies defaults only to absent keys", async () => {
  await writeConfigFile("port: 5000\n")

  const config = await readAppConfig()

  assert.equal(config.port, 5000)
  assert.equal(config.opusModel, "claude-opus-5")
  assert.equal(config.gptModel, "gpt-5.6-sol")
  assert.equal(config.logRetentionDays, 3)
})

// Why: a fresh install has no file at all and must land on current defaults.
test("uses shipped defaults for a fresh install", async () => {
  const config = await readAppConfig()

  assert.equal(config.opusModel, "claude-opus-5")
  assert.equal(config.gptModel, "gpt-5.6-sol")
})

// Why: v0.2.3 wrote configVersion into real user configs. Removing the parser
// case makes it an unrecognized key, so this pins that it is inert rather than
// a startup error, and that it drops out on the next write-back.
test("ignores a leftover configVersion line from v0.2.3", async () => {
  await writeConfigFile("configVersion: 2\nopusModel: claude-opus-4.8\n")

  const config = await readAppConfig()

  assert.equal(config.opusModel, "claude-opus-4.8")
  assert.ok(!("configVersion" in config))
  assert.doesNotMatch(await readConfigFile(), /configVersion/)
})

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})
