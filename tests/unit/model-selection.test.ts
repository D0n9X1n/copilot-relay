import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// Redirected before src/ loads: paths.ts reads the home directory at import time.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-model-selection-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CODEX_HOME = path.join(home, ".codex")
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude")

const { loadCopilotModelCatalog } = await import("../../src/copilot/models")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const models = await import("../../src/lib/models")

test.after(() => fs.rm(home, { recursive: true, force: true }))

test("the catalog keeps vendor, picker flag and picker category, and drops mistyped values", async () => {
  const data = [
    { id: "grok-4.7", vendor: "xAI", model_picker_enabled: true, model_picker_category: "powerful", capabilities: { type: "chat" } },
    { id: "odd", vendor: 7, model_picker_enabled: "yes", model_picker_category: 1, capabilities: { type: "chat" } },
  ]
  const config = { host: "localhost", port: 0, copilotBaseUrl: "https://fixture.invalid", copilotToken: "fixture", vsCodeVersion: "test", upstreamTimeoutMs: 1000 }
  const catalog = await withRecordedTransport({ fetch: async () => Response.json({ data }), refresh: async () => {} }, () => loadCopilotModelCatalog(config))

  assert.deepEqual(catalog.models.get("grok-4.7"), { type: "chat", vendor: "xAI", pickerEnabled: true, pickerCategory: "powerful" })
  assert.deepEqual(catalog.models.get("odd"), { type: "chat" })
})

const entry = (vendor: string, category = "versatile", extra = {}) =>
  ({ type: "chat", vendor, pickerEnabled: true, pickerCategory: category, ...extra })
const catalog = new Map<string, Record<string, unknown>>([
  ["claude-opus-5.5", entry("Anthropic", "powerful")],
  ["gpt-9-nova", entry("OpenAI")],
  ["gpt-10-nova", entry("OpenAI")],
  ["gpt-10-mini", entry("OpenAI", "lightweight")],
  ["off-11", entry("OpenAI", "powerful", { pickerEnabled: false })],
  ["embed-12", entry("OpenAI", "powerful", { type: "embeddings" })],
  ["lab-13", entry("Experimental", "powerful")],
  ["grok", entry("xAI", "powerful")],
  ["zed-b-3", entry("Zed")],
  ["zed-a-3", entry("Zed")],
])

test("auto picks one model per vendor by version, category, then ID", () => {
  assert.deepEqual(models.selectNewestPerVendor(catalog as never), ["claude-opus-5.5", "gpt-10-nova", "zed-a-3"])
})

test("exposed IDs keep slot order, dedupe case-insensitively and use catalog casing", () => {
  const map = new Map([["GPT-10-Nova", {}], ["claude-opus-5.5", {}], ["mai-code-2", {}]]) as never
  assert.deepEqual(models.resolveExposedModels({ gptModel: "gpt-10-nova[1m]", opusModel: "claude-opus-5.5", models: ["mai-code-2", "gpt-10-nova", "missing-1"] }, map), ["GPT-10-Nova", "claude-opus-5.5", "mai-code-2"])
  assert.deepEqual(models.resolveExposedModels({ gptModel: "same", opusModel: "SAME", models: [] }, undefined), ["same"])
  assert.deepEqual(models.resolveExposedModels({ gptModel: "a", opusModel: "b", models: ["z-1", "y-1"] }, undefined), ["a", "b", "z-1", "y-1"])
  assert.deepEqual(models.findMissingModels({ gptModel: "a", opusModel: "b", models: ["mai-code-2", "missing-1"] }, map), ["missing-1"])
})

test("auto adds each vendor's newest model after the two slots, and nothing without a catalog", () => {
  const routing = { gptModel: "gpt-10-nova", opusModel: "claude-opus-5.5", models: "auto" as const }

  assert.deepEqual(models.resolveExposedModels(routing, catalog as never), ["gpt-10-nova", "claude-opus-5.5", "zed-a-3"])
  assert.deepEqual(models.resolveExposedModels(routing, new Map() as never), ["gpt-10-nova", "claude-opus-5.5"])
  assert.deepEqual(models.resolveExposedModels(routing, undefined), ["gpt-10-nova", "claude-opus-5.5"])
})

test("canonical IDs strip every [1m], take catalog casing, and are lowercase otherwise", () => {
  const map = new Map([["GPT-10-Nova", {}]]) as never
  assert.equal(models.canonicalModelId("GPT-5.6-SOL[1M][1m]", undefined), "gpt-5.6-sol")
  assert.equal(models.canonicalModelId("GPT-5.6-SOL[1M][1m]", map), "gpt-5.6-sol")
  assert.equal(models.canonicalModelId("GROK-4.7[1m]", undefined), "grok-4.7")
  assert.equal(models.canonicalModelId("gpt-10-nova[1M]", map), "GPT-10-Nova")
})

test("models accepts auto, empty and an ID list and rejects anything else without echoing it", () => {
  assert.equal(models.parseModelSelection(" Auto "), "auto")
  assert.deepEqual(models.parseModelSelection(""), [])
  assert.deepEqual(models.parseModelSelection("grok-4.7, mai-code-2"), ["grok-4.7", "mai-code-2"])
  for (const bad of ["auto, grok-4.7", "grok-4.7,,x", "gpt-6.2-astra[1m]", "SECRET VALUE"]) {
    assert.throws(() => models.parseModelSelection(bad), (error: Error) => /^Invalid models/.test(error.message) && !error.message.includes(bad))
  }
})
