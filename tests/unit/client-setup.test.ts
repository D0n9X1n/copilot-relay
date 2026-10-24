import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { applyClaudeAppSetup, claudeAppDataDir, inferenceModel } from "../../src/lib/claude-app"
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
    { name: "gpt-6-astra", labelOverride: "GPT-6 Astra", supports1m: true, anthropicFamilyTier: "sonnet" },
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
  assert.deepEqual(entry.inferenceModels.map((model: { name: string }) => model.name), ["claude-opus-5.5", "gpt-6-astra"])

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
