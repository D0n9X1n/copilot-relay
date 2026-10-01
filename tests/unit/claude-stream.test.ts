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
    model: "gpt-6-astra",
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
    "gpt-6-astra[1m]",
  )
})

// #114: a zero-parameter tool streams its id and name with empty arguments.
const toolStream = (calls: Array<{ name: string; argumentDeltas: string[] }>) => {
  const state: ClaudeStreamState = {
    messageStartSent: false, contentBlockIndex: 0, contentBlockOpen: false, thinkingBlockOpen: false, toolCalls: {},
  }
  const chunk = (delta: object, finish_reason: "tool_calls" | null = null) => ({
    id: "chat_stream", object: "chat.completion.chunk" as const, created: 1, model: "test-model",
    choices: [{ index: 0, delta, finish_reason, logprobs: null }],
  })
  const events = []
  calls.forEach((call, index) => {
    events.push(...translateChunkToClaudeEvents(chunk({ role: "assistant", tool_calls: [{
      index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: "" },
    }] }), state))
    for (const argumentsDelta of call.argumentDeltas) {
      events.push(...translateChunkToClaudeEvents(chunk({ tool_calls: [{ index, function: { arguments: argumentsDelta } }] }), state))
    }
  })
  events.push(...translateChunkToClaudeEvents(chunk({}, "tool_calls"), state))
  return events
}

test("streams a zero-argument tool call as an empty JSON object and completes", () => {
  const events = toolStream([
    { name: "noop", argumentDeltas: [] },
    { name: "echo", argumentDeltas: ['{"text"', ':"hi"}'] },
  ])
  const starts = events.filter((event) => event.type === "content_block_start")
  assert.deepEqual(starts.map((event) => event.type === "content_block_start" && event.content_block.type === "tool_use"
    ? event.content_block.name : undefined), ["noop", "echo"])
  const partials = events.flatMap((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta"
    ? [event.delta.partial_json] : [])
  assert.deepEqual(partials, ["{}", '{"text":"hi"}'])
  for (const partial of partials) assert.equal(typeof JSON.parse(partial), "object")
  assert.equal(events.at(-1)?.type, "message_stop")
})

test("streams whitespace-only tool arguments as an empty JSON object", () => {
  const events = toolStream([{ name: "noop", argumentDeltas: [" ", "\n"] }])
  const partials = events.flatMap((event) => event.type === "content_block_delta" && event.delta.type === "input_json_delta"
    ? [event.delta.partial_json] : [])
  assert.deepEqual(partials, ["{}"])
})

test("invalid streamed tool arguments surface a client-safe error naming the tool", async () => {
  const { translateErrorToClaudeErrorEvent } = await import("../../src/claude/stream")
  let caught: unknown
  try { toolStream([{ name: "noop", argumentDeltas: ['{"secret":'] }]) } catch (error) { caught = error }
  const event = translateErrorToClaudeErrorEvent(caught)
  assert.deepEqual(event, { type: "error", error: { type: "api_error",
    message: 'Upstream returned tool input for "noop" that is not valid JSON.' } })
  assert.deepEqual(translateErrorToClaudeErrorEvent(new Error("internal detail")), { type: "error", error: {
    type: "api_error", message: "An unexpected error occurred during streaming." } })
})
