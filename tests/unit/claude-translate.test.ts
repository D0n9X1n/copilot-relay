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

// Why: the relay synthesizes web-search blocks with `encrypted_content: ""`,
// because valid values are Anthropic-signed and cannot be minted locally.
// Anthropic rejects a replayed search block whose encrypted_content is missing
// or modified with a 400. That is safe here only because these blocks are
// dropped before going upstream — Claude Code replays them in assistant history
// once a search turn can continue. If a future change forwards them instead,
// this test should fail loudly rather than produce unexplained 400s.
test("drops synthesized web-search blocks from replayed assistant history", () => {
  const payload = translateToOpenAI({
    max_tokens: 16,
    messages: [
      { role: "user", content: "compare rust async runtimes" },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { query: "rust async runtimes" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                title: "Tokio",
                url: "https://tokio.rs",
                encrypted_content: "",
                page_age: null,
              },
            ],
          },
          { type: "text", text: "Tokio is the most widely used." },
        ],
      },
      { role: "user", content: "now write that to a file" },
    ],
    model: "claude-opus-4.8",
  })

  const serialized = JSON.stringify(payload.messages)

  assert.equal(serialized.includes("server_tool_use"), false)
  assert.equal(serialized.includes("web_search_tool_result"), false)
  assert.equal(serialized.includes("encrypted_content"), false)
  assert.equal(payload.messages.at(-2)?.content, "Tokio is the most widely used.")
})
