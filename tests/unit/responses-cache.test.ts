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

// Why: gpt-5.6-sol (the default gptModel) rejects /chat/completions with
// unsupported_api_for_model, so it must be classified as Responses-only up front
// instead of relying on the failed-chat retry fallback.
test("gpt-5.6 family routes to the /responses endpoint", () => {
  assert.equal(shouldUseResponsesApiForModel("gpt-5.6-sol"), true)
  assert.equal(shouldUseResponsesApiForModel("gpt-5.6-luna"), true)
  assert.equal(shouldUseResponsesApiForModel("gpt-5.6-terra"), true)
})

// Why: /responses only returns prompt cache hits when a STABLE prompt_cache_key
// pins repeated requests to the same backend. Without it, cached_tokens randomly
// drops to 0 across turns even for identical prefixes (measured live). The relay
// must always emit a key for /responses requests.
test("buildResponsesRequestPayload always sets a prompt_cache_key", () => {
  const payload = buildResponsesRequestPayload(basePayload(), "low")
  assert.equal(typeof payload.prompt_cache_key, "string")
  assert.ok((payload.prompt_cache_key as string).length > 0)
})

// Why: a Claude Code session sends a stable metadata.user_id (surfaced as
// payload.user). The same user must yield the same key across turns so the whole
// session shares one warm cache, and different users must not collide.
test("prompt_cache_key is stable per user and isolates different users", () => {
  const a1 = buildResponsesRequestPayload(basePayload({ user: "session-AAA" }), "low")
  const a2 = buildResponsesRequestPayload(basePayload({ user: "session-AAA" }), "low")
  const b1 = buildResponsesRequestPayload(basePayload({ user: "session-BBB" }), "low")

  assert.equal(a1.prompt_cache_key, a2.prompt_cache_key)
  assert.notEqual(a1.prompt_cache_key, b1.prompt_cache_key)
})

// Why: clients without a user id still benefit from caching when their system
// prompt is identical, so fall back to a system-prompt hash rather than dropping
// the key entirely.
test("prompt_cache_key falls back to system prompt when no user id", () => {
  const noUser = buildResponsesRequestPayload(basePayload(), "low")
  const sameSystem = buildResponsesRequestPayload(basePayload(), "low")
  assert.equal(noUser.prompt_cache_key, sameSystem.prompt_cache_key)
  assert.ok((noUser.prompt_cache_key as string).startsWith("cr-sys-"))
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
