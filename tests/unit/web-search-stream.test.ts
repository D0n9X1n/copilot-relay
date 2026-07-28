import assert from "node:assert/strict"
import test from "node:test"

import {
  accumulateChunks,
  resolveWebSearchStreamDecision,
} from "../../src/claude/web-search-stream"
import { createClaudeToolNameMapper } from "../../src/claude/tool-names"
import type { ChatCompletionChunk } from "../../src/copilot/types"

const mapper = createClaudeToolNameMapper([
  { name: "WebSearch", input_schema: { type: "object" } },
  { name: "Write", input_schema: { type: "object" } },
])

const isWebSearchToolName = (name: string): boolean =>
  name === "web_search" || name === "WebSearch"

const sse = (chunks: Array<unknown>): AsyncIterable<{ data?: string }> => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) {
      yield { data: JSON.stringify(chunk) }
    }
    yield { data: "[DONE]" }
  },
})

const textChunk = (text: string, finish: string | null = null) => ({
  id: "chunk",
  object: "chat.completion.chunk",
  created: 1,
  model: "claude-opus-5",
  choices: [
    { index: 0, delta: { role: "assistant", content: text }, finish_reason: finish },
  ],
})

const toolChunk = (name: string, args = '{"query":"rust"}') => ({
  id: "chunk",
  object: "chat.completion.chunk",
  created: 1,
  model: "claude-opus-5",
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name, arguments: args } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
})

// Why: this is the bug that shipped past a green suite. Copilot writes a
// preamble ("I'll search for that now.") before calling the tool. A classifier
// that treats text as proof no search is coming settles early, streams live, and
// lets the later web_search call reach the client as a client tool_use named
// WebSearch — a malformed turn, since Claude Code expects the server to have
// executed it. Verified against live Copilot before and after the fix.
test("detects a web search that arrives after a text preamble", async () => {
  const { decision } = await resolveWebSearchStreamDecision(
    sse([textChunk("I'll search for that now."), toolChunk("WebSearch")]),
    mapper,
    isWebSearchToolName,
  )

  assert.equal(decision.kind, "webSearch")
})

// Why: the common Claude Code turn. WebSearch is advertised on every request and
// used on few, so a turn that never calls it must not be buffered.
test("classifies a turn with no tool call as streamable", async () => {
  const { decision } = await resolveWebSearchStreamDecision(
    sse([textChunk("OK"), textChunk("", "stop")]),
    mapper,
    isWebSearchToolName,
  )

  assert.equal(decision.kind, "streamed")
})

// Why: a non-search tool call is the client's own, and must stream through
// untouched rather than triggering the bridge path.
test("treats a non-search tool call as streamable", async () => {
  const { decision } = await resolveWebSearchStreamDecision(
    sse([textChunk("writing"), toolChunk("Write", '{"file_path":"a.md"}')]),
    mapper,
    isWebSearchToolName,
  )

  assert.equal(decision.kind, "streamed")
})

// Why: chunks handed to onChunk are already on the wire. Returning them again
// as `buffered` would make the caller replay them and double the content.
test("does not return chunks that were already streamed", async () => {
  const streamed: Array<ChatCompletionChunk> = []
  const { decision, alreadyStreamed } = await resolveWebSearchStreamDecision(
    sse([textChunk("OK"), textChunk("", "stop")]),
    mapper,
    isWebSearchToolName,
    async (chunk) => {
      streamed.push(chunk)
    },
  )

  assert.equal(alreadyStreamed, true)
  assert.ok(streamed.length > 0)
  assert.equal(decision.kind, "streamed")
  assert.deepEqual(
    decision.kind === "streamed" ? decision.buffered : undefined,
    [],
  )
})

// Why: a preamble streamed before the search is detected means message_start and
// some block indices are already spent, so the caller must continue that message
// instead of starting a second one.
test("reports that content was streamed before a late web search", async () => {
  const { decision, alreadyStreamed } = await resolveWebSearchStreamDecision(
    sse([textChunk("I'll search for that now."), toolChunk("WebSearch")]),
    mapper,
    isWebSearchToolName,
    async () => {},
  )

  assert.equal(decision.kind, "webSearch")
  assert.equal(alreadyStreamed, true)
})

// Why: the bridge path takes a non-streaming response, so a search turn has to
// be rebuilt from its chunks with tool call arguments reassembled in order.
test("reassembles split tool call arguments when accumulating", () => {
  const response = accumulateChunks([
    textChunk("thinking") as unknown as ChatCompletionChunk,
    {
      id: "chunk",
      object: "chat.completion.chunk",
      created: 1,
      model: "claude-opus-5",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "WebSearch", arguments: '{"que' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    } as unknown as ChatCompletionChunk,
    {
      id: "chunk",
      object: "chat.completion.chunk",
      created: 1,
      model: "claude-opus-5",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'ry":"rust"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    } as unknown as ChatCompletionChunk,
  ])

  const toolCall = response.choices[0]?.message.tool_calls?.[0]

  assert.equal(toolCall?.function.name, "WebSearch")
  assert.equal(toolCall?.function.arguments, '{"query":"rust"}')
  assert.equal(response.choices[0]?.message.content, "thinking")
  assert.equal(response.choices[0]?.finish_reason, "tool_calls")
})
