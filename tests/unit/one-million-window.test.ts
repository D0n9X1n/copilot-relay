import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// src/lib/paths reads the home directory on import, so redirect HOME and USERPROFILE (Windows) first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-one-million-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { applyClaudeConfig } = await import("../../src/lib/claude-settings")
const { inferenceModel } = await import("../../src/lib/claude-app")
const { codexModels } = await import("../../src/lib/client-setup")
const { getSlotModelIds } = await import("../../src/lib/models")
const { runtimeState } = await import("../../src/lib/state")

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
})

const limitsFor = (window: number) => ({
  max_context_window_tokens: window,
  max_prompt_tokens: window,
  max_output_tokens: 1000,
})

// Each client's view of one slot at the threshold: just below 1M, exactly 1M, and unknown.
const cases = [
  { label: "999,999", window: 999_999 as number | undefined },
  { label: "1,000,000", window: 1_000_000 as number | undefined },
  { label: "unknown", window: undefined },
]

for (const { label, window } of cases) {
  const capabilities = window === undefined ? {} : { limits: limitsFor(window) }
  const oneMillion = window !== undefined && window >= 1_000_000

  test(`GET /v1/models offers the slot as ${oneMillion ? "<id>[1m]" : "its plain ID"} at a ${label} window`, () => {
    runtimeState.modelRouting = { gptModel: "gpt-fixture", opusModel: "claude-opus-5.5" }
    runtimeState.upstreamBaseUrl = "https://fixture.invalid"
    runtimeState.modelCatalog = {
      baseUrl: "https://fixture.invalid",
      models: new Map([["gpt-fixture", capabilities], ["claude-opus-5.5", {}]]),
    }

    assert.equal(getSlotModelIds()[0], oneMillion ? "gpt-fixture[1m]" : "gpt-fixture")
  })

  test(`Claude Code CLI settings save the slot as ${oneMillion ? "<id>[1m]" : "its plain ID"} at a ${label} window`, async () => {
    const directory = await fs.mkdtemp(path.join(home, "settings-"))
    const configPath = path.join(directory, ".claude", "settings.json")
    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-fixture",
      contextWindowOf: () => window,
    })
    const settings = JSON.parse(await fs.readFile(configPath, "utf8")) as { model?: string }

    assert.equal(settings.model, oneMillion ? "gpt-fixture[1m]" : "gpt-fixture")
  })

  test(`the Codex catalog lists the bare slot with its own limits at a ${label} window`, () => {
    const catalog = { baseUrl: "https://fixture.invalid", models: new Map([["gpt-fixture", capabilities], ["claude-opus-5.5", {}]]) }
    const listed = codexModels({ gptModel: "gpt-fixture[1m]", opusModel: "claude-opus-5.5" } as never, catalog as never)

    assert.equal(listed[0]?.id, "gpt-fixture")
    assert.equal(listed[0]?.capabilities?.limits?.max_context_window_tokens, window)
  })

  test(`the Claude app marks 1M support from the prompt limit at a ${label} window`, () => {
    const entry = inferenceModel({ id: "gpt-fixture", tier: "sonnet", capabilities: capabilities as never })

    assert.equal(entry.supports1m, oneMillion ? true : undefined)
    assert.equal(entry.prefer1m, oneMillion ? true : undefined)
  })
}
