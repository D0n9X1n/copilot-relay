import test from "node:test"
import assert from "node:assert/strict"

import {
  buildResponsesRequestPayload,
  shouldUseResponsesApiForModel,
} from "../../src/copilot/responses"
import type { ChatCompletionsPayload } from "../../src/copilot/types"

const basePayload = (
  overrides: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload => ({
  model: "gpt-5.5",
  messages: [
    { role: "system", content: "You are a helpful senior engineer." },
    { role: "user", content: "Reply OK" },
  ],
  ...overrides,
})

// Why: gpt-5.5 and the gpt-5.6 family only run on Copilot /responses. Pin that
// classification so a model bump can't silently change which endpoint (and
// caching path) is used.
test("gpt-5.5 routes to the /responses endpoint", () => {
  assert.equal(shouldUseResponsesApiForModel("gpt-5.5"), true)
  assert.equal(shouldUseResponsesApiForModel("gpt-5.5-2025-01-01"), true)
})

// Existing GPT-5.6 configurations must still use Responses without a failed chat request.
test("gpt-5.6 family routes to the /responses endpoint", () => {
  assert.equal(shouldUseResponsesApiForModel("gpt-5.6-sol"), true)
  assert.equal(shouldUseResponsesApiForModel("gpt-5.6-luna"), true)
  assert.equal(shouldUseResponsesApiForModel("gpt-5.6-terra"), true)
})

// Why: GPT-6 Astra advertises only /responses upstream. Classifying it before
// the request avoids a guaranteed failed /chat/completions attempt on every turn.
test("gpt-6 Astra routes to the /responses endpoint", () => {
  assert.equal(shouldUseResponsesApiForModel("gpt-6-astra"), true)
  assert.equal(shouldUseResponsesApiForModel("GPT-6-ASTRA"), true)
})

for (const model of ["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra"]) {
  test(`${model} keeps session cache keys stable across turns and effort changes`, () => {
    const first = buildResponsesRequestPayload(basePayload({ model, user: "session-AAA" }), "low")
    const next = buildResponsesRequestPayload(basePayload({
      model,
      user: "session-AAA",
      messages: [
        ...basePayload().messages,
        { role: "assistant", content: "OK" },
        { role: "user", content: "Reply again." },
      ],
    }), "max")
    const other = buildResponsesRequestPayload(basePayload({ model, user: "session-BBB" }), "low")

    assert.match(first.prompt_cache_key ?? "", /^cr-[a-f0-9]{32}$/)
    assert.equal(first.prompt_cache_key, next.prompt_cache_key)
    assert.notEqual(first.prompt_cache_key, other.prompt_cache_key)
    assert.equal(first.model, model)
    assert.deepEqual(next.reasoning, { effort: "max" })
  })

  test(`${model} derives the fallback key from the system prompt`, () => {
    const first = buildResponsesRequestPayload(basePayload({ model }), "low")
    const same = buildResponsesRequestPayload(basePayload({ model }), "low")
    const different = buildResponsesRequestPayload(basePayload({
      model,
      messages: [{ role: "system", content: "A different system prompt." }],
    }), "low")

    assert.match(first.prompt_cache_key ?? "", /^cr-sys-[a-f0-9]{32}$/)
    assert.equal(first.prompt_cache_key, same.prompt_cache_key)
    assert.notEqual(first.prompt_cache_key, different.prompt_cache_key)
  })
}

test("session cache keys do not encode the upstream model", () => {
  const keys = ["gpt-5.5", "gpt-5.6-sol", "gpt-6-astra"].map((model) =>
    buildResponsesRequestPayload(basePayload({ model, user: "session-AAA" }), "low").prompt_cache_key,
  )

  assert.equal(new Set(keys).size, 1)
  assert.match(keys[0] ?? "", /^cr-[a-f0-9]{32}$/)
})

test("omits a cache key without a user identifier or system prompt", () => {
  const payload = buildResponsesRequestPayload(basePayload({
    model: "gpt-6-astra",
    messages: [{ role: "user", content: "Reply OK" }],
  }), "low")

  assert.equal(payload.prompt_cache_key, undefined)
})

// Why: the Responses API expects reasoning effort nested as reasoning.effort,
// not the flat chat-completions reasoning_effort field. The newest "max" tier in
// particular must survive this translation so gpt-5.6 requests actually reason at
// the configured effort upstream.
test("maps reasoning effort into the nested reasoning.effort field", () => {
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
    const payload = buildResponsesRequestPayload(basePayload(), effort)
    assert.deepEqual(payload.reasoning, { effort })
  }
})

// Why: when no effort is resolved the relay must omit the reasoning field
// entirely rather than send reasoning: { effort: undefined }, which Copilot
// would reject.
test("omits reasoning when effort is undefined", () => {
  const payload = buildResponsesRequestPayload(basePayload(), undefined)
  assert.equal(payload.reasoning, undefined)
})
