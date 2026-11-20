import { execFileSync } from "node:child_process"
import test from "node:test"
import assert from "node:assert/strict"

import {
  configurableReasoningEfforts,
  defaultModelRouting,
  defaultReasoningEffort,
  getSlotModelIds,
  getUpstreamModelIds,
  isReasoningEffort,
  isConfiguredReasoningEffort,
  normalizeClaudeModelId,
  normalizeCopilotModelId,
  modelNormalizations,
  routeModelId,
  slotPreparations,
} from "../../src/lib/models"
import { runtimeState, snapshotRuntimeState, withRuntimeState } from "../../src/lib/state"

test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
})

// A runtime catalog for the current upstream; an undefined window leaves the model without limits.
const useCatalog = (entries: Array<[string, number | undefined]>) => {
  runtimeState.upstreamBaseUrl = "https://fixture.invalid"
  runtimeState.modelCatalog = {
    baseUrl: "https://fixture.invalid",
    models: new Map(entries.map(([id, window]) => [
      id,
      window === undefined ? {} : { limits: { max_context_window_tokens: window, max_prompt_tokens: 1000, max_output_tokens: 1000 } },
    ])),
  }
}

test("configured effort choices exclude none without removing request-level support", () => {
  assert.deepEqual([...configurableReasoningEfforts], ["low", "medium", "high", "xhigh", "max"])
  for (const effort of configurableReasoningEfforts) {
    assert.equal(isConfiguredReasoningEffort(effort), true)
    assert.equal(isReasoningEffort(effort), true)
  }

  assert.equal(isConfiguredReasoningEffort("none"), false)
  assert.equal(isReasoningEffort("none"), true)
})

// Why: a model whose own catalog window reaches 1M is offered only as its 1M version, Claude
// models included; Copilot always receives the plain catalog ID.
test("offers a model with a known 1M window only as its [1m] version", () => {
  useCatalog([
    ["gpt-6.2-astra", 1_050_000],
    ["grok-4.7", 500_000],
    ["mai-code-2", undefined],
    ["claude-opus-5.5", 1_000_000],
    ["claude-haiku-4.5", 200_000],
  ])

  assert.equal(normalizeClaudeModelId("GPT-6.2-ASTRA[1M][1m]"), "gpt-6.2-astra[1m]")
  assert.equal(normalizeClaudeModelId("grok-4.7[1m]"), "grok-4.7")
  assert.equal(normalizeClaudeModelId("mai-code-2"), "mai-code-2")
  assert.equal(normalizeClaudeModelId("not-listed[1m]"), "not-listed[1m]")
  assert.equal(normalizeClaudeModelId("claude-opus-5.5"), "claude-opus-5.5[1m]")
  assert.equal(normalizeClaudeModelId("claude-haiku-4.5[1m]"), "claude-haiku-4.5")
  assert.equal(normalizeCopilotModelId("GROK-4.7[1M][1m]"), "grok-4.7")
  assert.equal(normalizeCopilotModelId("gpt-6-astra[2m]"), "gpt-6-astra[2m]")

  for (const model of ["GPT-6.2-ASTRA[1M][1m]", "grok-4.7[1m]", "mai-code-2", "not-listed[1m]", "claude-opus-5.5"]) {
    assert.equal(normalizeClaudeModelId(normalizeClaudeModelId(model)), normalizeClaudeModelId(model))
  }
})

// Why: Copilot catalog IDs are lowercase, so a Copilot ID is stripped of every [1m] and takes
// the catalog's casing, or is lowercased when no catalog lists it.
test("canonicalizes Copilot IDs with and without a catalog", () => {
  assert.equal(normalizeCopilotModelId("GPT-5.6-SOL[1M][1m]"), "gpt-5.6-sol")
  assert.equal(normalizeCopilotModelId("GROK-4.7[1m]"), "grok-4.7")

  useCatalog([["gpt-5.6-sol", 1_050_000]])
  assert.equal(normalizeCopilotModelId("GPT-5.6-SOL[1M][1m]"), "gpt-5.6-sol")
  assert.equal(normalizeCopilotModelId("GROK-4.7[1m]"), "grok-4.7")
})

test("keeps the verified Opus 5.5 upstream ID without context aliases", () => {
  assert.equal(routeModelId("opus"), "claude-opus-5.5")
  assert.equal(routeModelId("claude-opus-5.5"), "claude-opus-5.5")
  assert.equal(normalizeCopilotModelId("claude-opus-5.5"), "claude-opus-5.5")
  assert.equal(normalizeClaudeModelId("claude-opus-5.5"), "claude-opus-5.5")
})

test("defaults to GPT-6.2 Astra and keeps the Opus lane separate", () => {
  assert.deepEqual(defaultModelRouting, {
    gptModel: "gpt-6.2-astra",
    opusModel: "claude-opus-5.5",
  })
  assert.deepEqual(getSlotModelIds(), ["gpt-6.2-astra", "claude-opus-5.5"])
  assert.deepEqual(getUpstreamModelIds(), ["gpt-6.2-astra", "claude-opus-5.5"])

  useCatalog([["gpt-6.2-astra", 1_050_000], ["claude-opus-5.5", 1_000_000]])
  assert.deepEqual(getSlotModelIds(), ["gpt-6.2-astra[1m]", "claude-opus-5.5[1m]"])
})

// Why: a configured [1m] is the user's statement about the window, so it survives while the
// catalog does not know the window; a known window below 1M still removes it.
test("keeps a configured [1m] until the catalog reports the window", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-6-astra[1m]",
    opusModel: "claude-opus-5.5",
  }

  assert.deepEqual(getSlotModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5"])
  assert.deepEqual(getUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5"])

  useCatalog([["gpt-6-astra", 500_000], ["claude-opus-5.5", 1_000_000]])
  assert.deepEqual(getSlotModelIds(), ["gpt-6-astra", "claude-opus-5.5[1m]"])
})

// Why: model discovery is consumed by Claude Code while availability checks are
// sent to Copilot. The two lists must expose and canonicalize the GPT ID at one
// shared model boundary rather than relying on endpoint-specific fixes.
test("splits Claude-facing and upstream configured model ids", () => {
  runtimeState.modelRouting = {
    gptModel: "GPT-5.6-SOL[1M][1m]",
    opusModel: "claude-opus-4.8",
  }
  useCatalog([["gpt-5.6-sol", 1_000_000], ["claude-opus-4.8", 200_000]])

  assert.deepEqual(getSlotModelIds(), [
    "gpt-5.6-sol[1m]",
    "claude-opus-4.8",
  ])
  assert.deepEqual(getUpstreamModelIds(), [
    "gpt-5.6-sol",
    "claude-opus-4.8",
  ])
  assert.equal(routeModelId("gpt-5.6-sol[1m]"), "gpt-5.6-sol")
  assert.equal(routeModelId("default"), "gpt-5.6-sol")
})

// Why: Claude Code users may send many model aliases, but copilot-relay's
// core contract is simple: anything containing "opus" must use the Opus
// upstream, and everything else must fall back to GPT.
test("routes requests containing opus to configured opus model", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-test",
    opusModel: "opus-test",
  }

  assert.equal(routeModelId("opus"), "opus-test")
  assert.equal(routeModelId("claude-opus-4.8"), "opus-test")
  assert.equal(routeModelId("  Claude-OPUS-4.8  "), "opus-test")
  assert.equal(routeModelId("anything else"), "gpt-test")
})

// Why: Claude Code may keep showing built-in Haiku, Sonnet, and Fable picker
// choices even when the managed startup default is GPT. They are display
// aliases only here: every non-Opus selection must use the configured GPT route.
test("routes Claude picker aliases through the configured model pair", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-test",
    opusModel: "opus-test",
  }

  for (const model of [
    "default",
    "haiku",
    "claude-haiku-4.5",
    "sonnet",
    "sonnet[1m]",
    "claude-sonnet-5",
    "fable",
  ]) {
    assert.equal(routeModelId(model), "gpt-test")
  }

  for (const model of ["opus", "opus[1m]", "claude-opus-4.8"]) {
    assert.equal(routeModelId(model), "opus-test")
  }

  assert.deepEqual(getSlotModelIds(), ["gpt-test", "opus-test"])
})

// Why: only the two slots are offered and routed; a catalog model that v0.7.x exposed as an extra
// now follows the opus/gpt split like any other name.
test("routes a catalog model that is not a slot by the opus rule", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-6-astra",
    opusModel: "claude-opus-5.5",
  }
  useCatalog([
    ["gpt-6-astra", 1_050_000],
    ["claude-opus-5.5", 1_000_000],
    ["grok-4.7", 500_000],
    ["claude-sonnet-5", 200_000],
  ])

  assert.equal(routeModelId("grok-4.7"), "gpt-6-astra")
  assert.equal(routeModelId("GROK-4.7[1M][1m]"), "gpt-6-astra")
  assert.equal(routeModelId("claude-sonnet-5"), "gpt-6-astra")
  assert.equal(routeModelId("opus[1m]"), "claude-opus-5.5")
  assert.equal(routeModelId("claude-opus-4-5-20251101"), "claude-opus-5.5")
  for (const alias of ["sonnet", "haiku", "claude-haiku-4-5-20251001", "codex-auto-review"]) {
    assert.equal(routeModelId(alias), "gpt-6-astra")
  }

  assert.deepEqual(getSlotModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5[1m]"])
  assert.deepEqual(getUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5"])
})

// Why: a slot's own name always reaches that slot, even when the opus rule would send it to the
// other one, with or without [1m].
test("an exact slot name wins over the opus rule in both directions", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-opus-lab",
    opusModel: "claude-sonnet-5",
  }

  for (const model of ["gpt-opus-lab", "gpt-opus-lab[1m]", "GPT-OPUS-LAB"]) {
    assert.equal(routeModelId(model), "gpt-opus-lab")
  }

  for (const model of ["claude-sonnet-5", "claude-sonnet-5[1m]"]) {
    assert.equal(routeModelId(model), "claude-sonnet-5")
  }

  assert.equal(routeModelId("opus"), "claude-sonnet-5")
  assert.equal(routeModelId("haiku"), "gpt-opus-lab")
  assert.deepEqual(getSlotModelIds(), ["gpt-opus-lab", "claude-sonnet-5"])
})

test("offers one entry when both slots name the same model", () => {
  runtimeState.modelRouting = {
    gptModel: "claude-opus-5.5",
    opusModel: "CLAUDE-OPUS-5.5[1m]",
  }

  assert.deepEqual(getSlotModelIds(), ["claude-opus-5.5"])
})

// Why: slots are normalized once per routing generation and catalog, not per request. Every
// request routes on a copy of the routing object, so the copies must share one preparation.
test("prepares the slots once per routing generation and catalog", () => {
  runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" }
  const before = slotPreparations()

  for (let index = 0; index < 100; index++) {
    withRuntimeState(snapshotRuntimeState(), () => routeModelId("sonnet"))
  }

  assert.equal(slotPreparations() - before, 1)

  useCatalog([["gpt-6-astra", 1_050_000], ["claude-opus-5.5", 1_000_000]])
  for (let index = 0; index < 100; index++) {
    withRuntimeState(snapshotRuntimeState(), () => routeModelId("opus"))
  }

  assert.equal(slotPreparations() - before, 2)
})

test("three live routing generations each prepare once", () => {
  useCatalog([["gpt-a", 1_000], ["gpt-b", 1_000], ["gpt-c", 1_000], ["claude-opus-5.5", 1_000]])
  const snapshots = ["gpt-a", "gpt-b", "gpt-c"].map((gptModel) => {
    runtimeState.modelRouting = { gptModel, opusModel: "claude-opus-5.5" }
    return snapshotRuntimeState()
  })
  const before = slotPreparations()

  for (let index = 0; index < 100; index++) {
    const snapshot = snapshots[index % 3]
    withRuntimeState({ ...snapshot }, () => routeModelId("sonnet"))
  }

  assert.equal(slotPreparations() - before, 3)
  assert.equal(withRuntimeState(snapshots[1], () => routeModelId("haiku")), "gpt-b")
})

test("a cold routing source snapshotted many times prepares once", () => {
  runtimeState.modelRouting = { gptModel: "gpt-cold", opusModel: "claude-opus-5.5" }
  const before = slotPreparations()

  for (let index = 0; index < 100; index++) {
    withRuntimeState(snapshotRuntimeState(), () => routeModelId("sonnet"))
  }

  assert.equal(slotPreparations() - before, 1)
})

test("a slot the warm catalog omits is normalized once per generation and catalog", () => {
  runtimeState.modelRouting = { gptModel: "GPT-NOT-LISTED[1m]", opusModel: "claude-opus-5.5" }
  useCatalog([["claude-opus-5.5", 1_000_000]])
  withRuntimeState(snapshotRuntimeState(), () => routeModelId("sonnet"))
  const before = modelNormalizations()

  for (let index = 0; index < 100; index++) {
    assert.equal(withRuntimeState(snapshotRuntimeState(), () => routeModelId("sonnet")), "gpt-not-listed")
  }

  assert.equal(modelNormalizations() - before, 0)

  // Without a catalog, the same: the slot is computed once for this generation, then never again.
  delete runtimeState.modelCatalog
  runtimeState.modelRouting = { gptModel: "GPT-NO-CATALOG[1m]", opusModel: "claude-opus-5.5" }
  withRuntimeState(snapshotRuntimeState(), () => routeModelId("sonnet"))
  const beforeWithout = modelNormalizations()
  for (let index = 0; index < 100; index++) {
    assert.equal(withRuntimeState(snapshotRuntimeState(), () => routeModelId("sonnet")), "gpt-no-catalog")
  }

  assert.equal(modelNormalizations() - beforeWithout, 0)
})

test("the slots are canonicalized once per catalog and other names every time", () => {
  runtimeState.modelRouting = { gptModel: "GPT-6-ASTRA[1m]", opusModel: "claude-opus-5.5" }
  useCatalog([["gpt-6-astra", 1_050_000], ["claude-opus-5.5", 1_000_000]])
  withRuntimeState(snapshotRuntimeState(), () => routeModelId("sonnet"))
  const before = modelNormalizations()

  for (const spelling of ["GPT-6-ASTRA[1m]", "gpt-6-astra", "gpt-6-astra[1m]", "claude-opus-5.5"]) {
    assert.equal(normalizeCopilotModelId(spelling), spelling.startsWith("claude") ? "claude-opus-5.5" : "gpt-6-astra")
  }

  assert.equal(modelNormalizations() - before, 0)

  assert.equal(normalizeCopilotModelId("Unknown-Model[1m]"), "unknown-model")
  assert.equal(normalizeCopilotModelId("Unknown-Model[1m]"), "unknown-model")
  assert.equal(modelNormalizations() - before, 2)

  // A refreshed catalog is a new map, so its spelling is computed afresh.
  useCatalog([["GPT-6-Astra", 1_050_000]])
  assert.equal(normalizeCopilotModelId("gpt-6-astra"), "GPT-6-Astra")
})

// Why: no cache is keyed by client-supplied names, so an oversized model name is gone once its
// request settles.
test("an oversized model name is not retained after its request", () => {
  const script = `
    const { normalizeCopilotModelId, routeModelId } = await import(${JSON.stringify(new URL("../../src/lib/models.ts", import.meta.url).href)})
    const { runtimeState, snapshotRuntimeState, withRuntimeState } = await import(${JSON.stringify(new URL("../../src/lib/state.ts", import.meta.url).href)})
    runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" }
    runtimeState.upstreamBaseUrl = "https://fixture.invalid"
    runtimeState.modelCatalog = { baseUrl: "https://fixture.invalid", models: new Map([["gpt-6-astra", {}], ["claude-opus-5.5", {}]]) }
    withRuntimeState(snapshotRuntimeState(), () => routeModelId("sonnet"))
    const sample = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed }
    const before = sample()
    withRuntimeState(snapshotRuntimeState(), () => {
      const name = "x".repeat(1024 * 1024) + "-model"
      routeModelId(name)
      normalizeCopilotModelId(name)
    })
    process.stdout.write(String(sample() - before))
  `
  const output = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", script], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
  })

  assert.ok(Number(output) < 64 * 1024, `heap grew by ${output} bytes`)
})

test("a snapshot keeps the two-field routing shape", () => {
  runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" }
  withRuntimeState(snapshotRuntimeState(), () => routeModelId("opus"))

  assert.deepEqual(Object.keys(snapshotRuntimeState().modelRouting ?? {}), ["gptModel", "opusModel"])
  assert.deepEqual(JSON.parse(JSON.stringify(snapshotRuntimeState().modelRouting)), {
    gptModel: "gpt-6-astra",
    opusModel: "claude-opus-5.5",
  })
})

// Why: /v1/models is a user-visible Claude Code discovery endpoint. This
// scenario verifies the list reflects hot-loaded routing config, not stale
// hardcoded defaults.
test("exposes configured model ids in stable order", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-test",
    opusModel: "opus-test",
  }

  assert.deepEqual(getSlotModelIds(), ["gpt-test", "opus-test"])
})

// Why: startup and tests often call model helpers before config hot reload has
// populated runtime state. This scenario guarantees safe defaults are always
// available.
test("falls back to default routing when runtime config is unset", () => {
  assert.deepEqual(getSlotModelIds(), [
    normalizeClaudeModelId(defaultModelRouting.gptModel),
    defaultModelRouting.opusModel,
  ])
  assert.deepEqual(getUpstreamModelIds(), [
    defaultModelRouting.gptModel,
    defaultModelRouting.opusModel,
  ])
})

// Request-level none remains valid for models that support it, even though the
// configured fallback has a narrower set of choices.
test("accepts every valid reasoning effort tier and rejects the rest", () => {
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(isReasoningEffort(effort), true)
  }

  for (const value of ["", "ultra", "maximum", "MAX", 5, null, undefined, {}]) {
    assert.equal(isReasoningEffort(value), false)
  }
})

// Why: the shipped default reasoning effort is a user-facing contract. Pin it so
// a change to the default is a deliberate, reviewed edit rather than an accident.
test("defaults reasoning effort to max", () => {
  assert.equal(defaultReasoningEffort, "max")
  assert.equal(isReasoningEffort(defaultReasoningEffort), true)
})
