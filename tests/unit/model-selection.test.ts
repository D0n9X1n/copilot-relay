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
