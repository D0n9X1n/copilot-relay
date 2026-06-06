import test from "node:test"
import assert from "node:assert/strict"

import {
  defaultModelRouting,
  getExposedModelIds,
  routeModelId,
} from "../../src/lib/models"
import { runtimeState } from "../../src/lib/state"

test.afterEach(() => {
  delete runtimeState.modelRouting
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
  assert.equal(routeModelId("anything else"), "gpt-test")
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
    defaultModelRouting.gptModel,
    defaultModelRouting.opusModel,
  ])
})
