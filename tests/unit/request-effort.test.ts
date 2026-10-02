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

test.afterEach(() => {
  delete runtimeState.thinkEffort
})

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

test("inline effort changes activate at the next user turn without mutating history", () => {
  const user = { role: "user" as const, content: "Continue." }
  const assistant = { role: "assistant" as const, content: "OK" }
  const low = { role: "system" as const, content: [], output_config: { effort: "low" as const } }
  const high = { role: "system" as const, content: [], output_config: { effort: "high" as const } }
  const max = { role: "system" as const, content: [], output_config: { effort: "max" as const } }
  const cases = [
    { messages: [low, user], expected: "low" },
    { messages: [user, assistant, high, user], expected: "high" },
    { messages: [low, user, assistant, high, user], expected: "high" },
    { messages: [low, user, assistant, high, user, assistant, max, user], expected: "max" },
    { messages: [high, user, assistant, low, user], expected: "low" },
    { messages: [low, high, user], expected: "high" },
    { messages: [user, assistant, high], expected: "medium" },
    { messages: [high, user, assistant, low], expected: "high" },
    { messages: [high], expected: "medium" },
    { messages: [user, assistant, high, assistant], expected: "medium" },
    { messages: [high, user, assistant, low, assistant], expected: "high" },
  ]
  for (const { messages, expected } of cases) {
    const payload = { model: "opus", max_tokens: 16, output_config: { effort: "medium" as const }, messages }
    const original = structuredClone(payload)
    assert.equal(translateToOpenAI(payload).reasoning_effort, expected)
    assert.deepEqual(payload, original)
  }
})

test("an active inline effort overrides initial request fields and defaults", () => {
  runtimeState.thinkEffort = "max"
  for (const fields of [
    {}, { output_config: null }, { output_config: { effort: null } },
    { reasoning_effort: "low" as const },
    { output_config: { effort: "none" as const } },
    { output_config: { effort: "medium" as const }, reasoning_effort: "low" as const },
  ]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const payload = {
        model: "opus", max_tokens: 16, ...fields,
        messages: [
          { role: "user" as const, content: "First turn." },
          { role: "assistant" as const, content: "OK" },
          { role: "system" as const, content: [], output_config: { effort } },
          { role: "user" as const, content: "Next turn." },
        ],
      }
      assert.equal(translateToOpenAI(payload).reasoning_effort, effort)
      assert.equal(runtimeState.thinkEffort, "max")
    }
  }
})

test("a valid inline switch does not conceal malformed initial effort", () => {
  assert.throws(() => translateToOpenAI({
    model: "opus", max_tokens: 16, output_config: { effort: "invalid" },
    messages: [
      { role: "system", content: [], output_config: { effort: "high" } },
      { role: "user", content: "Continue." },
    ],
  } as never), (error: unknown) => error instanceof HTTPError && error.response.status === 400)
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
