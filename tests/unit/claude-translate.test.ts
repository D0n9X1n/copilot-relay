import assert from "node:assert/strict"
import test from "node:test"

import {
  translateToClaude,
  translateToOpenAI,
} from "../../src/claude/translate"
import type { ChatCompletionResponse } from "../../src/copilot/types"

const createChatResponse = (model: string): ChatCompletionResponse => ({
  id: "chat_test",
  created: 1,
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "OK" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
})

// Why: completed Copilot responses carry canonical upstream IDs. Claude Code
// must receive the client-facing context identity without rewriting unrelated
// model names.
test("normalizes completed response model metadata for Claude", () => {
  assert.equal(
    translateToClaude(createChatResponse("gpt-5.6-sol")).model,
    "gpt-5.6-sol[1m]",
  )
  assert.equal(
    translateToClaude(createChatResponse("claude-opus-4.8")).model,
    "claude-opus-4.8",
  )
})

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
