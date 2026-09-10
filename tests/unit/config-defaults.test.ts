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

const { readAppConfig, watchAppConfig } = await import("../../src/lib/app-config")
const { paths } = await import("../../src/lib/paths")
const { log } = await import("../../src/lib/log")

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
  assert.equal(config.gptModel, "gpt-6-astra")
  assert.equal(config.logRetentionDays, 3)
})

// Why: a fresh install has no file at all and must land on current defaults.
test("uses shipped defaults for a fresh install", async () => {
  const config = await readAppConfig()

  assert.equal(config.opusModel, "claude-opus-5")
  assert.equal(config.gptModel, "gpt-6-astra")
})

test("keeps an existing Sol model through repeated reads", async () => {
  await writeConfigFile("gptModel: gpt-5.6-sol\n")

  assert.equal((await readAppConfig()).gptModel, "gpt-5.6-sol")
  assert.equal((await readAppConfig()).gptModel, "gpt-5.6-sol")
  assert.match(await readConfigFile(), /gptModel: gpt-5\.6-sol/)
})

test("materializes an explicitly disabled deadline without restoring the default", async () => {
  await writeConfigFile("upstreamTimeoutSeconds: 0\n")
  assert.equal((await readAppConfig()).upstreamTimeoutSeconds, 0)
  assert.equal((await readAppConfig()).upstreamTimeoutSeconds, 0)
  assert.match(await readConfigFile(), /upstreamTimeoutSeconds: 0/)
})

test("invalid effort is rejected without rewriting the user's config", async () => {
  for (const value of ["none", "NONE", "ultra", "\"\"", "42"]) {
    const original = `# preserve this file\nthinkEffort: ${value}\nport: 5000\n`
    await writeConfigFile(original)
    await assert.rejects(readAppConfig(), /Invalid thinkEffort/)
    assert.equal(await readConfigFile(), original)
  }
})

test("generated effort guidance lists only valid fallback choices", async () => {
  await writeConfigFile("thinkEffort: minimal\n")
  assert.equal((await readAppConfig()).thinkEffort, "low")
  const written = await readConfigFile()
  assert.match(written, /# Fallback effort when the request omits it: low, medium, high, xhigh, max\./)
  assert.doesNotMatch(written, /# Fallback effort[^\n]*none/)
})

test("invalid effort reload reports an error, keeps runtime settings, and can recover", async (t) => {
  await writeConfigFile("thinkEffort: high\n")
  let active = await readAppConfig()
  let mtime = 1
  const stats = await fs.stat(paths.configPath)
  t.mock.method(fs, "stat", async () => Object.assign(stats, { mtimeMs: mtime }))
  const errors: string[] = []
  t.mock.method(log, "error", (...values: unknown[]) => { errors.push(values.join(" ")) })
  t.mock.timers.enable({ apis: ["setInterval"] })
  const timer = watchAppConfig((next) => { active = next })
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(predicate(), "Config reload did not finish")
  }
  try {
    await new Promise((resolve) => setImmediate(resolve))
    const invalid = "thinkEffort: none\n"
    await writeConfigFile(invalid)
    mtime++
    t.mock.timers.tick(1000)
    await waitFor(() => errors.length > 0)
    assert.match(errors[0], /Invalid thinkEffort.*Valid values: low, medium, high, xhigh, max/)
    assert.equal(active.thinkEffort, "high")
    assert.equal(await readConfigFile(), invalid)

    errors.length = 0
    await writeConfigFile("malformed PRIVATE_CONFIG_SENTINEL\n")
    mtime++
    t.mock.timers.tick(1000)
    await waitFor(() => errors.length > 0)
    assert.match(errors[0], /Could not reload config/)
    assert.doesNotMatch(errors[0], /PRIVATE_CONFIG_SENTINEL/)
    assert.equal(active.thinkEffort, "high")

    await writeConfigFile("thinkEffort: low\n")
    mtime++
    t.mock.timers.tick(1000)
    await waitFor(() => active.thinkEffort === "low")
  } finally {
    clearInterval(timer)
  }
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
