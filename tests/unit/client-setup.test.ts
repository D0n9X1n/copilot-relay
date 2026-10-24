import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { applyClaudeAppSetup, appModelName, claudeAppDataDir, inferenceModel } from "../../src/lib/claude-app"
import { parseSetupTargets } from "../../src/setup"

test("the Claude app's third-party directory follows each OS", () => {
  assert.equal(
    claudeAppDataDir({ platform: "darwin", env: {}, home: "/Users/u" }),
    "/Users/u/Library/Application Support/Claude-3p",
  )
  assert.equal(
    claudeAppDataDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, home: "C:\\Users\\u" }),
    "C:\\Users\\u\\AppData\\Local\\Claude-3p",
  )
  assert.equal(
    claudeAppDataDir({ platform: "win32", env: {}, home: "C:\\Users\\u" }),
    "C:\\Users\\u\\AppData\\Local\\Claude-3p",
  )
  assert.equal(claudeAppDataDir({ platform: "linux", env: {}, home: "/home/u" }), "/home/u/.config/Claude-3p")
  assert.equal(claudeAppDataDir({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/u" }), "/xdg/Claude-3p")
})

test("a model entry carries its Copilot name, 1M support and tier", () => {
  assert.deepEqual(
    inferenceModel({ id: "gpt-6-astra", tier: "sonnet", capabilities: { name: "GPT-6 Astra", limits: { max_prompt_tokens: 1_000_000 } } as never }),
    { name: "claude-sonnet-relay", labelOverride: "GPT-6 Astra", supports1m: true, anthropicFamilyTier: "sonnet" },
  )
  assert.deepEqual(inferenceModel({ id: "claude-opus-5.5", tier: "opus" }), { name: "claude-opus-5.5", anthropicFamilyTier: "opus" })
})

const models = [
  { id: "claude-opus-5.5", tier: "opus" as const },
  { id: "gpt-6-astra", tier: "sonnet" as const },
]

test("app setup skips a machine where the app never ran, and forced setup creates a working configuration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-claude-app-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, "Claude-3p")

  const skipped = await applyClaudeAppSetup({ baseUrl: "http://127.0.0.1:4142", models, dataDir })
  assert.equal(skipped.skipped, true)
  await assert.rejects(fs.stat(dataDir))

  const forced = await applyClaudeAppSetup({ baseUrl: "http://127.0.0.1:4142", models, dataDir, force: true, apiKey: "relay-key-123456" })
  assert.deepEqual([forced.skipped, forced.changed], [false, true])

  const meta = JSON.parse(await fs.readFile(path.join(dataDir, "configLibrary", "_meta.json"), "utf8"))
  assert.match(meta.appliedId, /^[a-f0-9-]{36}$/)
  assert.deepEqual(meta.entries, [{ id: meta.appliedId, name: "copilot-relay" }])

  const entry = JSON.parse(await fs.readFile(path.join(dataDir, "configLibrary", `${meta.appliedId}.json`), "utf8"))
  assert.equal(entry.inferenceProvider, "gateway")
  assert.equal(entry.inferenceGatewayBaseUrl, "http://127.0.0.1:4142")
  assert.equal(entry.inferenceGatewayApiKey, "relay-key-123456")
  assert.deepEqual(entry.inferenceModels.map((model: { name: string }) => model.name), ["claude-opus-5.5", "claude-sonnet-relay"])
  assert.equal(entry.inferenceModels[1].labelOverride, "gpt-6-astra")
  assert.equal(entry.modelDiscoveryEnabled, false)

  const desktop = JSON.parse(await fs.readFile(path.join(dataDir, "claude_desktop_config.json"), "utf8"))
  assert.equal(desktop.deploymentMode, "3p")

  const again = await applyClaudeAppSetup({ baseUrl: "http://127.0.0.1:4142", models, dataDir, apiKey: "relay-key-123456" })
  assert.equal(again.changed, false)
})

test("app setup updates the applied configuration and keeps the user's other settings", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-claude-app-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, "Claude-3p")
  const id = "8fa0651d-cbb9-4d13-808e-e787cbda4939"
  await fs.mkdir(path.join(dataDir, "configLibrary"), { recursive: true })
  await fs.writeFile(path.join(dataDir, "configLibrary", "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "Default" }] }))
  await fs.writeFile(path.join(dataDir, "configLibrary", `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: "http://127.0.0.1:9999",
    inferenceGatewayApiKey: "kept-key",
    modelPrefer1mContext: true,
    defaultModelEffort: "high",
  }))
  await fs.writeFile(path.join(dataDir, "claude_desktop_config.json"), JSON.stringify({ preferences: { theme: "dark" } }))

  const result = await applyClaudeAppSetup({ baseUrl: "http://127.0.0.1:4142", models, dataDir })
  assert.equal(result.changed, true)

  const meta = JSON.parse(await fs.readFile(path.join(dataDir, "configLibrary", "_meta.json"), "utf8"))
  assert.equal(meta.appliedId, id)
  assert.equal(meta.entries.length, 1)

  const entry = JSON.parse(await fs.readFile(path.join(dataDir, "configLibrary", `${id}.json`), "utf8"))
  assert.equal(entry.inferenceGatewayBaseUrl, "http://127.0.0.1:4142")
  assert.equal(entry.inferenceGatewayApiKey, "kept-key")
  assert.equal(entry.modelPrefer1mContext, true)
  assert.equal(entry.defaultModelEffort, "high")
  assert.equal(entry.inferenceModels.length, 2)

  const desktop = JSON.parse(await fs.readFile(path.join(dataDir, "claude_desktop_config.json"), "utf8"))
  assert.deepEqual(desktop, { preferences: { theme: "dark" }, deploymentMode: "3p" })
})

test("app setup refuses a configuration file that is not JSON", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-claude-app-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, "Claude-3p")
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(dataDir, "claude_desktop_config.json"), "{ not json")

  await assert.rejects(applyClaudeAppSetup({ baseUrl: "http://127.0.0.1:4142", models, dataDir }), /not valid JSON/)
})

test("setup targets default to all and reject unknown names", () => {
  assert.deepEqual(parseSetupTargets([]), ["claude-code-cli", "claude-code-app", "codex-cli", "codex-app"])
  assert.deepEqual(parseSetupTargets(["codex-app"]), ["codex-app"])
  assert.throws(() => parseSetupTargets(["claude-desktop"]), /Unknown target claude-desktop/)
})

test("app setup makes a key-bearing entry owner-only again even when its content is current", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-claude-app-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, "Claude-3p")
  const input = { baseUrl: "http://127.0.0.1:4142", models, dataDir, force: true, apiKey: "relay-key-123456" }
  await applyClaudeAppSetup(input)

  const meta = JSON.parse(await fs.readFile(path.join(dataDir, "configLibrary", "_meta.json"), "utf8"))
  const entryPath = path.join(dataDir, "configLibrary", `${meta.appliedId}.json`)
  await fs.chmod(entryPath, 0o644)

  const again = await applyClaudeAppSetup(input)
  assert.equal(again.changed, true)
  assert.equal((await fs.stat(entryPath)).mode & 0o777, 0o600)
})

test("Claude Code CLI setup reports a settings file it will not touch as a failure", async (t) => {
  const { setupClaudeCodeCli } = await import("../../src/lib/client-setup")
  const dir = process.env.CLAUDE_CONFIG_DIR!
  await fs.mkdir(dir, { recursive: true })
  const settings = path.join(dir, "settings.json")
  await fs.writeFile(settings, "{ not json")
  t.after(() => fs.rm(settings, { force: true }))

  const outcome = await setupClaudeCodeCli({
    appConfig: { apiKey: "", gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" } as never,
    baseUrl: "http://127.0.0.1:4142",
    catalog: undefined,
    force: false,
  })

  assert.match(outcome.status, /^failed: left unchanged because it is not valid JSON/)
  assert.equal(await fs.readFile(settings, "utf8"), "{ not json")
})

test("app setup refuses a configuration file that is JSON but not an object", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-claude-app-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, "Claude-3p")
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(dataDir, "claude_desktop_config.json"), "[1, 2]\n")

  await assert.rejects(applyClaudeAppSetup({ baseUrl: "http://127.0.0.1:4142", models, dataDir }), /not a JSON object/)
  assert.equal(await fs.readFile(path.join(dataDir, "claude_desktop_config.json"), "utf8"), "[1, 2]\n")
})

test("Claude Code CLI setup skips a machine where Claude Code never ran, unless forced", async (t) => {
  const { setupClaudeCodeCli } = await import("../../src/lib/client-setup")
  const dir = process.env.CLAUDE_CONFIG_DIR!
  await fs.rm(dir, { recursive: true, force: true })
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const context = {
    appConfig: { apiKey: "", gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" } as never,
    baseUrl: "http://127.0.0.1:4142",
    catalog: undefined,
  }

  assert.match((await setupClaudeCodeCli({ ...context, force: false })).status, /^skipped/)
  await assert.rejects(fs.stat(dir))
  assert.equal((await setupClaudeCodeCli({ ...context, force: true })).status, "updated")
})

test("a model the app would refuse is listed under a Claude route name for its tier", () => {
  assert.equal(appModelName({ id: "claude-opus-5.5", tier: "opus" }), "claude-opus-5.5")
  assert.equal(appModelName({ id: "gpt-6-astra", tier: "sonnet" }), "claude-sonnet-relay")
  assert.equal(appModelName({ id: "gpt-6-astra", tier: "haiku" }), "claude-haiku-relay")
  assert.equal(appModelName({ id: "gemini-3-pro", tier: "sonnet" }), "claude-sonnet-relay")
  // A route without "opus" reaches gptModel at the relay; one with it reaches opusModel.
  assert.doesNotMatch(appModelName({ id: "gpt-6-astra", tier: "sonnet" }), /opus/)
  // An accepted ID that the relay would send to the other slot is renamed too.
  assert.equal(appModelName({ id: "claude-opus-4.6", tier: "sonnet" }), "claude-sonnet-relay")
  assert.equal(appModelName({ id: "claude-sonnet-5", tier: "opus" }), "claude-opus-relay")
  assert.equal(appModelName({ id: "fable-5", tier: "sonnet" }), "fable-5")
})

test("the two tiers always get two different names", () => {
  for (const [opus, gpt] of [["claude-opus-5.5", "gpt-6-astra"], ["claude-sonnet-5", "gpt-6-astra"], ["claude-opus-5.5", "claude-opus-4.6"], ["gpt-6-astra", "gpt-6-astra"]]) {
    const names = [appModelName({ id: opus!, tier: "opus" }), appModelName({ id: gpt!, tier: "sonnet" })]
    assert.notEqual(names[0], names[1], `${opus} / ${gpt}`)
  }
})
