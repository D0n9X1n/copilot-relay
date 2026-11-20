import test from "node:test"
import assert from "node:assert/strict"

import {
  configurableReasoningEfforts,
  defaultModelRouting,
  defaultReasoningEffort,
  getExposedModelIds,
  getUpstreamModelIds,
  isReasoningEffort,
  isConfiguredReasoningEffort,
  normalizeClaudeModelId,
  normalizeCopilotModelId,
  routeModelId,
} from "../../src/lib/models"
import { runtimeState } from "../../src/lib/state"

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

test("defaults to Astra and keeps the Opus lane separate", () => {
  assert.deepEqual(defaultModelRouting, {
    gptModel: "gpt-6-astra",
    opusModel: "claude-opus-5.5",
  })
  assert.deepEqual(getExposedModelIds(), ["gpt-6-astra", "claude-opus-5.5"])
  assert.deepEqual(getUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5"])

  useCatalog([["gpt-6-astra", 1_050_000], ["claude-opus-5.5", 1_000_000]])
  assert.deepEqual(getExposedModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5[1m]"])
})

// Why: a configured [1m] is the user's statement about the window, so it survives while the
// catalog does not know the window; a known window below 1M still removes it.
test("keeps a configured [1m] until the catalog reports the window", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-6-astra[1m]",
    opusModel: "claude-opus-5.5",
    models: [],
  }

  assert.deepEqual(getExposedModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5"])
  assert.deepEqual(getUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5"])

  useCatalog([["gpt-6-astra", 500_000], ["claude-opus-5.5", 1_000_000]])
  assert.deepEqual(getExposedModelIds(), ["gpt-6-astra", "claude-opus-5.5[1m]"])
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

  assert.deepEqual(getExposedModelIds(), [
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

  assert.deepEqual(getExposedModelIds(), ["gpt-test", "opus-test"])
})

// Why: an exposed model is a real choice in the picker, so it reaches Copilot as itself;
// a catalog model nobody exposed still follows the opus/gpt split.
test("routes exposed IDs to themselves and strips every [1m]", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-6-astra",
    opusModel: "claude-opus-5.5",
    models: ["grok-4.7"],
  }
  useCatalog([
    ["gpt-6-astra", 1_050_000],
    ["claude-opus-5.5", 1_000_000],
    ["grok-4.7", 500_000],
    ["claude-sonnet-5", 200_000],
  ])

  assert.equal(routeModelId("grok-4.7"), "grok-4.7")
  assert.equal(routeModelId("GROK-4.7[1M][1m]"), "grok-4.7")
  assert.equal(routeModelId("claude-sonnet-5"), "gpt-6-astra")
  assert.equal(routeModelId("opus[1m]"), "claude-opus-5.5")
  assert.deepEqual(getExposedModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5[1m]", "grok-4.7"])
  // Startup preflight and the tokenizer preload read this list: the two slots, never the extras.
  assert.deepEqual(getUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5"])
})

// Why: with no extra models the opus/gpt split is unchanged, except that a slot's own
// name always reaches that slot even when it contains "opus".
test("an empty selection routes as before except exact slot names", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-opus-lab",
    opusModel: "claude-opus-5.5",
    models: [],
  }

  assert.equal(routeModelId("gpt-opus-lab"), "gpt-opus-lab")
  assert.equal(routeModelId("opus"), "claude-opus-5.5")
  assert.equal(routeModelId("haiku"), "gpt-opus-lab")
  assert.deepEqual(getExposedModelIds(), ["gpt-opus-lab", "claude-opus-5.5"])
})

// Why: /v1/models is a user-visible Claude Code discovery endpoint. This
// scenario verifies the list reflects hot-loaded routing config, not stale
// hardcoded defaults.
test("exposes configured model ids in stable order", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-test",
    opusModel: "opus-test",
  }

  assert.deepEqual(getExposedModelIds(), ["gpt-test", "opus-test"])
})

// Why: startup and tests often call model helpers before config hot reload has
// populated runtime state. This scenario guarantees safe defaults are always
// available.
test("falls back to default routing when runtime config is unset", () => {
  assert.deepEqual(getExposedModelIds(), [
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
