import assert from "node:assert/strict"
import test from "node:test"

import { translateToOpenAI } from "../../src/claude/translate"

// Why: Claude supports final assistant prefill, but GitHub Copilot rejects
// conversations ending with assistant content, so the bridge must preserve the
// prefix while making the upstream conversation end with a user turn.
test("normalizes final assistant prefill before sending upstream", () => {
  const payload = translateToOpenAI({
    max_tokens: 16,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial answer  \n" },
    ],
    model: "claude-opus-4.8",
  })

  assert.equal(payload.messages.at(-2)?.role, "assistant")
  assert.equal(payload.messages.at(-2)?.content, "partial answer")
  assert.equal(payload.messages.at(-1)?.role, "user")
})

// Why: normal assistant turns in the middle of history are valid context and
// must not be rewritten as prefill.
test("keeps non-final assistant history unchanged", () => {
  const payload = translateToOpenAI({
    max_tokens: 16,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "historical answer  " },
      { role: "user", content: "continue" },
    ],
    model: "claude-opus-4.8",
  })

  assert.equal(payload.messages[1]?.role, "assistant")
  assert.equal(payload.messages[1]?.content, "historical answer  ")
  assert.equal(payload.messages.at(-1)?.role, "user")
})

// Why: an empty final assistant prefill has no useful prefix to preserve and
// would be rejected upstream if left as the last message.
test("drops empty final assistant prefill", () => {
  const payload = translateToOpenAI({
    max_tokens: 16,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "   \n" },
    ],
    model: "claude-opus-4.8",
  })

  assert.equal(payload.messages.length, 1)
  assert.equal(payload.messages.at(-1)?.role, "user")
})
