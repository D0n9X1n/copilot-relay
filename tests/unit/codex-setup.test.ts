import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildCodexCatalog, readCodexVendorFiles } from "../../src/codex/catalog"
import { applyCodexSetup, CodexConfigError, editCodexConfig } from "../../src/codex/setup"

const input = {
  baseUrl: "http://127.0.0.1:4142",
  catalogPath: "/home/u/.copilot-relay/codex-models.json",
  models: ["gpt-6-astra", "claude-opus-5.5"],
}

test("editCodexConfig writes the provider, model list and default model into an empty file", () => {
  const text = editCodexConfig("", input)

  assert.equal(text, [
    "model_provider = \"copilot-relay\"",
    "model_catalog_json = \"/home/u/.copilot-relay/codex-models.json\"",
    "model = \"gpt-6-astra\"",
    "",
    "[model_providers.copilot-relay]",
    "# Written by copilot-relay start (codexSetup); edits in this table are replaced on the next start.",
    "name = \"copilot-relay\"",
    "base_url = \"http://127.0.0.1:4142/v1\"",
    "wire_api = \"responses\"",
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  ].join("\n"))
})

test("editCodexConfig keeps other keys, tables and comments, and replaces only what it manages", () => {
  const existing = [
    "# my settings",
    "model = \"gpt-5.6-terra\"",
    "model_reasoning_effort = \"medium\"",
    "model_provider = \"openai\"",
    "",
    "[projects.\"/work\"]",
    "trust_level = \"trusted\"",
    "",
    "[model_providers.copilot-relay]",
    "name = \"old\"",
    "base_url = \"http://127.0.0.1:9999/v1\"",
    "",
    "[model_providers.other]",
    "name = \"other\"",
    "",
  ].join("\n")
  const text = editCodexConfig(existing, { ...input, apiKey: "relay-key-1234567890" })

  assert.match(text, /^# my settings\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\nmodel_provider = "copilot-relay"\nmodel_catalog_json = /)
  assert.match(text, /\[projects\."\/work"\]\ntrust_level = "trusted"/)
  assert.match(text, /\[model_providers\.other\]\nname = "other"/)
  assert.equal(text.match(/\[model_providers\.copilot-relay\]/g)?.length, 1)
  assert.doesNotMatch(text, /9999/)
  assert.match(text, /http_headers = \{ "x-api-key" = "relay-key-1234567890" \}\n$/)
})

test("editCodexConfig keeps a model that is one of the catalog's", () => {
  const text = editCodexConfig("model = \"claude-opus-5.5\"\n", input)

  assert.match(text, /^model = "claude-opus-5.5"$/m)
})

test("editCodexConfig is stable: a second run changes nothing, and CRLF files stay CRLF", () => {
  const once = editCodexConfig("model = \"x\"\r\n\r\n[tui]\r\ntheme = \"dark\"\r\n", input)
  const twice = editCodexConfig(once, input)

  assert.equal(twice, once)
  assert.doesNotMatch(once.replaceAll("\r\n", ""), /\n/)
})

test("editCodexConfig refuses a provider defined with dotted keys or an inline table", () => {
  assert.throws(
    () => editCodexConfig("model_providers.copilot-relay.name = \"x\"\n", input),
    CodexConfigError,
  )
  assert.throws(
    () => editCodexConfig("[model_providers]\ncopilot-relay = { name = \"x\" }\n", input),
    CodexConfigError,
  )
})

test("editCodexConfig ignores header-like lines inside multi-line strings", () => {
  const text = editCodexConfig("notes = \"\"\"\n[model_providers.copilot-relay]\n\"\"\"\n", input)

  assert.match(text, /notes = """\n\[model_providers\.copilot-relay\]\n"""/)
})

test("buildCodexCatalog keeps Codex's own entry for a model it ships and builds one for any other", async () => {
  const vendor = await readCodexVendorFiles()
  const catalog = buildCodexCatalog([
    { id: "gpt-6-astra" },
    {
      id: "claude-opus-5.5",
      capabilities: {
        name: "Claude Opus 5.5",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        limits: { max_prompt_tokens: 1_000_000, max_output_tokens: 64_000, max_context_window_tokens: 1_000_000 },
      },
    },
    { id: "gpt-6-astra" },
  ], vendor) as { models: Array<Record<string, any>> }

  assert.deepEqual(catalog.models.map((model) => model.slug), ["gpt-6-astra", "claude-opus-5.5"])

  const [astra, opus] = catalog.models
  const bundled = vendor.bundled.get("gpt-6-astra")!
  assert.deepEqual({ ...astra, priority: bundled.priority }, bundled)
  assert.equal(astra!.priority, 1)

  assert.equal(opus!.display_name, "Claude Opus 5.5")
  assert.equal(opus!.apply_patch_tool_type, "freeform")
  assert.equal(opus!.visibility, "list")
  assert.equal(opus!.priority, 2)
  assert.equal(opus!.default_reasoning_level, "medium")
  assert.deepEqual(opus!.supported_reasoning_levels.map((level: { effort: string }) => level.effort), ["low", "medium", "high", "xhigh", "max"])
  assert.equal(opus!.context_window, 936_000)
  assert.equal(opus!.max_context_window, 1_000_000)
  assert.equal(opus!.model_messages.instructions_template, vendor.prompt)
})

test("buildCodexCatalog gives every model the whole window Copilot allows, a bundled one included", async () => {
  const vendor = await readCodexVendorFiles()
  const catalog = buildCodexCatalog([
    {
      id: "gpt-6-astra",
      capabilities: { limits: { max_prompt_tokens: 1_050_000, max_output_tokens: 128_000, max_context_window_tokens: 1_050_000 } },
    },
    {
      id: "gpt-5.3-codex",
      capabilities: { limits: { max_prompt_tokens: 272_000, max_output_tokens: 128_000, max_context_window_tokens: 400_000 } },
    },
  ], vendor) as { models: Array<Record<string, any>> }

  const [astra, codex] = catalog.models
  const bundled = vendor.bundled.get("gpt-6-astra")!
  assert.equal(astra!.context_window, 922_000)
  assert.equal(astra!.max_context_window, 1_050_000)
  assert.deepEqual(astra!.model_messages, bundled.model_messages)
  assert.equal(codex!.context_window, 272_000)
  assert.equal(codex!.max_context_window, 272_000)
})

test("buildCodexCatalog keeps a window below Copilot's input limit and never publishes an empty one", async () => {
  const vendor = await readCodexVendorFiles()
  const catalog = buildCodexCatalog([
    {
      id: "input-limited",
      capabilities: { limits: { max_prompt_tokens: 100_000, max_output_tokens: 128_000, max_context_window_tokens: 400_000 } },
    },
    {
      id: "reply-fills-window",
      capabilities: { limits: { max_prompt_tokens: 1_000_000, max_output_tokens: 1_000_000, max_context_window_tokens: 1_000_000 } },
    },
    { id: "unknown-limits" },
  ], vendor) as { models: Array<Record<string, any>> }

  const [inputLimited, replyFillsWindow, unknownLimits] = catalog.models
  assert.equal(inputLimited!.context_window, 100_000)
  assert.equal(replyFillsWindow!.context_window, 1_000_000)
  assert.equal(replyFillsWindow!.max_context_window, 1_000_000)
  assert.equal(Object.hasOwn(unknownLimits!, "context_window"), false)
  assert.equal(Object.hasOwn(unknownLimits!, "max_context_window"), false)
})

test("applyCodexSetup skips a machine without Codex and writes both files when Codex is installed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-codex-setup-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const codexHome = path.join(root, ".codex")
  const catalogPath = path.join(root, ".copilot-relay", "codex-models.json")
  const setup = { baseUrl: "http://127.0.0.1:4142", catalogPath, codexHome, models: [{ id: "gpt-6-astra" }, { id: "claude-opus-5.5" }] }

  const skipped = await applyCodexSetup(setup)
  assert.equal(skipped.skipped, true)
  await assert.rejects(fs.stat(catalogPath))

  await fs.mkdir(codexHome)
  const first = await applyCodexSetup(setup)
  const second = await applyCodexSetup(setup)
  assert.deepEqual([first.skipped, first.changed, second.changed], [false, true, false])

  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8")) as { models: Array<{ slug: string }> }
  assert.deepEqual(catalog.models.map((model) => model.slug), ["gpt-6-astra", "claude-opus-5.5"])
  assert.match(await fs.readFile(path.join(codexHome, "config.toml"), "utf8"), /model_provider = "copilot-relay"/)
})

test("editCodexConfig replaces a quoted top-level key instead of adding a second one", () => {
  const text = editCodexConfig("\"model_provider\" = \"openai\"\n", input)

  assert.equal(text.match(/^"?model_provider"? =/gm)?.length, 1)
  assert.match(text, /^model_provider = "copilot-relay"$/m)
})

test("editCodexConfig leaves a key-like line inside a multi-line string alone", () => {
  const existing = "developer_instructions = '''\nmodel = \"other\"\n'''\n"
  const text = editCodexConfig(existing, input)

  assert.match(text, /^developer_instructions = '''\nmodel = "other"\n'''\n/)
  assert.match(text, /^model = "gpt-6-astra"$/m)
})

test("editCodexConfig reads triple quotes in a comment as a comment", () => {
  const existing = "# use \"\"\" for long text\nmodel = \"x\"\n\n[tui]\ntheme = \"dark\"\n"
  const text = editCodexConfig(existing, input)

  assert.match(text, /^model_provider = "copilot-relay"$/m)
  assert.equal(editCodexConfig(text, input), text)
})

test("editCodexConfig keeps a table whose quoted name holds brackets after the managed table", () => {
  const existing = [
    "[model_providers.copilot-relay]",
    "name = \"old\"",
    "",
    "[projects.\"/tmp/Archive [2024]\"]",
    "trust_level = \"trusted\"",
    "",
  ].join("\n")
  const text = editCodexConfig(existing, input)

  assert.match(text, /\[projects\."\/tmp\/Archive \[2024\]"\]\ntrust_level = "trusted"/)
  assert.doesNotMatch(text, /"old"/)
})

test("editCodexConfig refuses an inline model_providers table and a file that is not TOML", () => {
  assert.throws(
    () => editCodexConfig("model_providers = { other = { name = \"Other\" } }\n", input),
    CodexConfigError,
  )
  assert.throws(() => editCodexConfig("model = \n", input), (error: unknown) => {
    return error instanceof CodexConfigError && /line 1/.test(error.message)
  })
})

test("editCodexConfig refuses an edit it cannot make without changing other values", () => {
  const existing = "model = \"\"\"\ngpt-5\n\"\"\"\n"

  assert.throws(() => editCodexConfig(existing, input), CodexConfigError)
})

test("applyCodexSetup makes a config.toml holding the apiKey owner-only again", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-codex-mode-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const codexHome = path.join(root, ".codex")
  await fs.mkdir(codexHome)
  const setup = {
    apiKey: "relay-key-1234567890",
    baseUrl: "http://127.0.0.1:4142",
    catalogPath: path.join(root, ".copilot-relay", "codex-models.json"),
    codexHome,
    models: [{ id: "gpt-6-astra" }, { id: "claude-opus-5.5" }],
  }
  const configPath = path.join(codexHome, "config.toml")

  await applyCodexSetup(setup)
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600)

  await fs.chmod(configPath, 0o644)
  const again = await applyCodexSetup(setup)
  assert.equal(again.changed, true)
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600)
})

test("editCodexConfig compares values with their types, so a string never stands in for a number", () => {
  const existing = "extras = { model = nan }\nmodel = \"number:NaN\"\n"

  assert.match(editCodexConfig(existing, { ...input, models: ["number:NaN"] }), /extras = \{ model = nan \}/)
  // A multi-line inline table hides its keys from the line scanner; the typed comparison catches the edit.
  assert.throws(() => editCodexConfig("extras = {\n  model = nan\n}\nmodel = \"number:NaN\"\n", { ...input, models: ["number:NaN"] }), CodexConfigError)
})

test("editCodexConfig accepts an integer past JavaScript's safe range", () => {
  const text = editCodexConfig("history.max_bytes = 9223372036854775807\n", input)

  assert.match(text, /^history\.max_bytes = 9223372036854775807$/m)
})
