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

test("a model entry carries its Copilot name, tier, and only the 1M option when Copilot reports a 1M window", () => {
  assert.deepEqual(
    inferenceModel({ id: "gpt-6-astra", tier: "sonnet", capabilities: { name: "GPT-6 Astra", limits: { max_prompt_tokens: 1_000_000 } } as never }),
    { name: "claude-sonnet-relay", labelOverride: "GPT-6 Astra", supports1m: true, prefer1m: true, anthropicFamilyTier: "sonnet" },
  )
  assert.deepEqual(
    inferenceModel({ id: "claude-haiku-4.5", tier: "sonnet", capabilities: { limits: { max_prompt_tokens: 136_000 } } as never }),
    { name: "claude-haiku-4.5", anthropicFamilyTier: "sonnet" },
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

test("when the shared Codex config is skipped, the Codex app is reported skipped too, not up to date", async (t) => {
  const { runSetup } = await import("../../src/lib/client-setup")
  const { renderSetupOutcomes } = await import("../../src/setup")
  const codexHome = process.env.CODEX_HOME!
  await fs.rm(codexHome, { recursive: true, force: true })
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }))
  const context = {
    appConfig: { apiKey: "", gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" } as never,
    baseUrl: "http://127.0.0.1:4142",
    catalog: undefined,
    force: false,
  }

  const outcomes = await runSetup(["codex-cli", "codex-app"], context)

  assert.deepEqual(outcomes.map((outcome) => outcome.status.split(":")[0]), ["skipped", "skipped"])
  const rows = renderSetupOutcomes(outcomes, context.baseUrl, false, true).slice(3)
  assert.match(rows[0], /^ {2}codex-cli +– skipped /)
  assert.match(rows[1], /^ {2}codex-app +– skipped /)
  await assert.rejects(fs.stat(codexHome))
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

const codexCatalog = {
  baseUrl: "https://fixture.invalid",
  models: new Map([
    ["gpt-6-astra", { limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 922_000, max_output_tokens: 128_000 } }],
    ["claude-opus-5.5", {}],
    ["grok-4.7", { name: "Grok 4.7" }],
  ]),
} as never

const useCodexHome = async (t: { after: (fn: () => Promise<void>) => void }, config?: string): Promise<string> => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-codex-models-"))
  const previous = process.env.CODEX_HOME
  t.after(async () => {
    process.env.CODEX_HOME = previous
    await fs.rm(codexHome, { recursive: true, force: true })
  })
  process.env.CODEX_HOME = codexHome
  if (config !== undefined) {
    await fs.writeFile(path.join(codexHome, "config.toml"), config)
  }

  return codexHome
}

const readCodexSlugs = async (): Promise<Array<{ slug: string; description: string }>> => {
  const { paths } = await import("../../src/lib/paths")
  const written = JSON.parse(await fs.readFile(paths.codexCatalogPath, "utf8")) as { models: Array<{ slug: string; description: string }> }
  return written.models
}

test("codexModels lists the two slots without [1m], gptModel first, one entry when equal", async () => {
  const { codexModels } = await import("../../src/lib/client-setup")
  const appConfig = { gptModel: "GPT-6-ASTRA[1m]", opusModel: "claude-opus-5.5" } as never

  const listed = codexModels(appConfig, codexCatalog)

  assert.deepEqual(listed.map((model) => model.id), ["gpt-6-astra", "claude-opus-5.5"])
  assert.equal(listed[0]?.capabilities?.limits?.max_context_window_tokens, 1_050_000)
  assert.deepEqual(
    codexModels({ gptModel: "gpt-6-astra[1m]", opusModel: "claude-opus-5.5" } as never, undefined).map((model) => model.id),
    ["gpt-6-astra", "claude-opus-5.5"],
  )
  assert.deepEqual(
    codexModels({ gptModel: "claude-opus-5.5", opusModel: "CLAUDE-OPUS-5.5[1m]" } as never, codexCatalog).map((model) => model.id),
    ["claude-opus-5.5"],
  )
})

test("Codex setup lists the two slots, keeps a listed selection and the bundled Astra entry", async (t) => {
  const { setupCodex } = await import("../../src/lib/client-setup")
  const codexHome = await useCodexHome(t, "model = \"claude-opus-5.5\"\n")
  const appConfig = { apiKey: "", gptModel: "GPT-6-ASTRA[1m]", opusModel: "claude-opus-5.5" } as never

  const outcome = await setupCodex({ appConfig, baseUrl: "http://127.0.0.1:4142", catalog: codexCatalog, force: false }, "codex-cli")
  const written = await readCodexSlugs()

  assert.equal(outcome.status, "updated")
  assert.deepEqual(written.map((entry) => entry.slug), ["gpt-6-astra", "claude-opus-5.5"])
  assert.notEqual(written[0]?.description, "gpt-6-astra through copilot-relay")
  assert.match(await fs.readFile(path.join(codexHome, "config.toml"), "utf8"), /^model = "claude-opus-5\.5"$/m)
})

test("startup's Codex setup writes the two slots, replaces a model they do not list, and logs the outcome", async (t) => {
  const { startupCodexSetup } = await import("../../src/lib/client-setup")
  const { log } = await import("../../src/lib/log")
  const codexHome = await useCodexHome(t, "model = \"grok-4.7\"\n")
  const logged: Array<string> = []
  t.mock.method(log, "info", (...values: Array<unknown>) => {
    logged.push(values.join(" "))
  })
  const appConfig = { apiKey: "", gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" } as never

  await startupCodexSetup(appConfig, codexCatalog, "http://127.0.0.1:4142")
  const written = await readCodexSlugs()

  assert.deepEqual(written.map((entry) => entry.slug), ["gpt-6-astra", "claude-opus-5.5"])
  assert.match(await fs.readFile(path.join(codexHome, "config.toml"), "utf8"), /^model = "gpt-6-astra"$/m)
  assert.deepEqual(logged, [`codex settings updated: ${path.join(codexHome, "config.toml")}`])

  await startupCodexSetup(appConfig, codexCatalog, "http://127.0.0.1:4142")
  assert.equal(logged[1], `codex settings already up to date: ${path.join(codexHome, "config.toml")}`)
})

test("startup's Codex setup skips a machine without Codex and logs a failure instead of throwing", async (t) => {
  const { startupCodexSetup } = await import("../../src/lib/client-setup")
  const { log } = await import("../../src/lib/log")
  const codexHome = await useCodexHome(t)
  const logged: Array<string> = []
  for (const level of ["info", "error"] as const) {
    t.mock.method(log, level, (...values: Array<unknown>) => {
      logged.push(`${level}: ${values.map(String).join(" ")}`)
    })
  }

  const appConfig = { apiKey: "", gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" } as never
  const missingHome = path.join(codexHome, "absent")
  process.env.CODEX_HOME = missingHome
  await startupCodexSetup(appConfig, undefined, "http://127.0.0.1:4142")
  assert.deepEqual(logged, [`info: codex setup skipped: ${missingHome} does not exist`])
  await assert.rejects(fs.stat(missingHome))

  process.env.CODEX_HOME = codexHome
  await fs.writeFile(path.join(codexHome, "config.toml"), "model_providers = { copilot-relay = {} }\n")
  await startupCodexSetup(appConfig, undefined, "http://127.0.0.1:4142")
  const failure = logged[1] ?? ""
  assert.equal(failure.startsWith(`error: Could not update codex settings (${codexHome}): CodexConfigError:`), true, failure)
  assert.equal(logged.length, 2)
})

test("start sets up Codex only through startupCodexSetup", async () => {
  const source = await fs.readFile(path.join(import.meta.dirname, "..", "..", "src", "start.ts"), "utf8")

  assert.equal(/startupCodexSetup\(/.test(source), true, "src/start.ts calls startupCodexSetup")
  assert.equal(/applyCodexSetup\(/.test(source), false, "src/start.ts does not call applyCodexSetup")
  assert.equal(/codexModels\(/.test(source), false, "src/start.ts does not call codexModels")
})
