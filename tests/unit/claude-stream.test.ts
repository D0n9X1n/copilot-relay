import assert from "node:assert/strict"
import test from "node:test"

import { translateChunkToClaudeEvents } from "../../src/claude/stream"
import type { ClaudeStreamState } from "../../src/claude/types"

// Why: Copilot stream chunks carry the canonical upstream ID, but Claude Code
// must see the context-selector identity in its message_start metadata.
test("exposes the 1M GPT identity in Claude stream metadata", () => {
  const state: ClaudeStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    thinkingBlockOpen: false,
    toolCalls: {},
  }
  const events = translateChunkToClaudeEvents({
    id: "chat_stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.6-sol",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "OK" },
        finish_reason: null,
        logprobs: null,
      },
    ],
  }, state)
  const start = events.find((event) => event.type === "message_start")

  assert.equal(
    start?.type === "message_start" ? start.message.model : undefined,
    "gpt-5.6-sol[1m]",
  )
})
