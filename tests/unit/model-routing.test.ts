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

test("routes requests containing opus to configured opus model", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-test",
    opusModel: "opus-test",
  }

  assert.equal(routeModelId("opus"), "opus-test")
  assert.equal(routeModelId("claude-opus-4.8"), "opus-test")
  assert.equal(routeModelId("anything else"), "gpt-test")
})

test("exposes configured model ids in stable order", () => {
  runtimeState.modelRouting = {
    gptModel: "gpt-test",
    opusModel: "opus-test",
  }

  assert.deepEqual(getExposedModelIds(), ["gpt-test", "opus-test"])
})

test("falls back to default routing when runtime config is unset", () => {
  assert.deepEqual(getExposedModelIds(), [
    defaultModelRouting.gptModel,
    defaultModelRouting.opusModel,
  ])
})
