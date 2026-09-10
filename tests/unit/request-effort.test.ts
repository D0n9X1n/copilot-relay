import assert from "node:assert/strict"
import test from "node:test"

import {
  defaultReasoningEffort,
  getRequestReasoningEffort,
  resolveReasoningEffort,
} from "../../src/lib/models"
import { HTTPError } from "../../src/lib/error"
import { runtimeState } from "../../src/lib/state"
import { translateToOpenAI } from "../../src/claude/translate"

test.afterEach(() => { delete runtimeState.thinkEffort })

test("native and legacy request efforts are honored without mutating the default", () => {
  runtimeState.thinkEffort = "high"
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
    for (const fields of [
      { output_config: { effort }, reasoning_effort: "low" as const },
      { reasoning_effort: effort },
    ]) {
      assert.equal(getRequestReasoningEffort(fields), effort)
      const translated = translateToOpenAI({
        model: "opus", max_tokens: 16, messages: [{ role: "user", content: "hello" }],
        ...fields,
      })
      assert.equal(translated.reasoning_effort, effort)
      assert.equal(runtimeState.thinkEffort, "high")
    }
  }
})

test("missing or null request effort uses the configured then shipped default", () => {
  for (const fields of [
    {}, { output_config: {} }, { output_config: null },
    { output_config: { effort: null }, reasoning_effort: null },
  ]) {
    assert.equal(getRequestReasoningEffort(fields), undefined)
    runtimeState.thinkEffort = "medium"
    assert.equal(resolveReasoningEffort(getRequestReasoningEffort(fields)), "medium")
    delete runtimeState.thinkEffort
    assert.equal(resolveReasoningEffort(getRequestReasoningEffort(fields)), defaultReasoningEffort)
  }
})

test("a null native effort allows a legacy override and explicit none is not absence", () => {
  runtimeState.thinkEffort = "max"
  assert.equal(getRequestReasoningEffort({ output_config: { effort: null }, reasoning_effort: "low" }), "low")
  assert.equal(resolveReasoningEffort(getRequestReasoningEffort({ output_config: { effort: "none" } })), "none")
})

test("malformed selected effort does not silently fall back", () => {
  for (const fields of [
    { output_config: [] }, { output_config: 42 },
    { output_config: { effort: "ultra" }, reasoning_effort: "low" },
    { output_config: { effort: false } },
    { reasoning_effort: "" }, { reasoning_effort: "LOW" }, { reasoning_effort: 0 },
  ]) {
    assert.throws(
      () => getRequestReasoningEffort(fields),
      (error: unknown) => error instanceof HTTPError && error.response.status === 400,
    )
  }
})
