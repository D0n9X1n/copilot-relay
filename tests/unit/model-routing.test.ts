import test from "node:test"
import assert from "node:assert/strict"

import {
  defaultModelRouting,
  defaultReasoningEffort,
  getExposedModelIds,
  getUpstreamModelIds,
  isReasoningEffort,
  normalizeClaudeModelId,
  normalizeCopilotModelId,
  routeModelId,
} from "../../src/lib/models"
import { runtimeState } from "../../src/lib/state"

test.afterEach(() => {
  delete runtimeState.modelRouting
})

// Why: the context selector is a Claude-facing identity only. Normalize exact
// gpt-5.6-sol spellings idempotently while leaving similar and other IDs alone.
test("normalizes only exact gpt-5.6-sol identities at each boundary", () => {
  for (const model of [
    "gpt-5.6-sol",
    "GPT-5.6-SOL",
    "gpt-5.6-sol[1m]",
    "GPT-5.6-SOL[1M][1m]",
  ]) {
    assert.equal(normalizeClaudeModelId(model), "gpt-5.6-sol[1m]")
    assert.equal(normalizeCopilotModelId(model), "gpt-5.6-sol")
  }

  assert.equal(
    normalizeClaudeModelId(normalizeClaudeModelId("GPT-5.6-SOL[1M][1m]")),
    "gpt-5.6-sol[1m]",
  )
  assert.equal(
    normalizeCopilotModelId(normalizeCopilotModelId("GPT-5.6-SOL[1M][1m]")),
    "gpt-5.6-sol",
  )

  for (const model of [
    "gpt-5.6-sol-preview",
    "gpt-5.6-sol[2m]",
    "prefix-gpt-5.6-sol",
    "gpt-5.6-luna[1m]",
    " gpt-5.6-sol",
    "gpt-5.6-sol ",
    "gpt-5.6-sol\n",
    "gpt-test",
  ]) {
    assert.equal(normalizeClaudeModelId(model), model)
    assert.equal(normalizeCopilotModelId(model), model)
  }
})

// Why: model discovery is consumed by Claude Code while availability checks are
// sent to Copilot. The two lists must expose and canonicalize the GPT ID at one
// shared model boundary rather than relying on endpoint-specific fixes.
test("splits Claude-facing and upstream configured model ids", () => {
  runtimeState.modelRouting = {
    gptModel: "GPT-5.6-SOL[1M][1m]",
    opusModel: "claude-opus-4.8",
  }

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

// Why: isReasoningEffort is the single guard that validates configured think
// effort. It must accept every documented tier (including "max") and reject
// anything else, so an invalid config value can never reach Copilot upstream.
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
