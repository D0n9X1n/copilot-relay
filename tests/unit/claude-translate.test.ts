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

test("filtered chat output is a refusal, not normal completion", () => {
  const response = createChatResponse("test-model")
  response.choices[0]!.finish_reason = "content_filter"

  assert.equal(translateToClaude(response).stop_reason, "refusal")
})

// Why: completed Copilot responses carry canonical upstream IDs. Claude Code
// must receive the client-facing context identity without rewriting unrelated
// model names.
test("normalizes completed response model metadata for Claude", () => {
  assert.equal(
    translateToClaude(createChatResponse("gpt-6-astra")).model,
    "gpt-6-astra[1m]",
  )
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

// Upstream sends `arguments: ""` for zero-parameter tools (e.g.
// mcp__playwright__browser_close). That is `{}`, not a 500.
const toolCallResponse = (argumentsText: string): ChatCompletionResponse => {
  const response = createChatResponse("test-model")
  response.choices[0] = {
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "noop", arguments: argumentsText }
      }],
    },
    finish_reason: "tool_calls",
  }

  return response
}

for (const argumentsText of ["", "   ", "\n"]) {
  test(`blank tool arguments ${JSON.stringify(argumentsText)} translate to an empty input object`, () => {
    const result = translateToClaude(toolCallResponse(argumentsText))

    assert.equal(result.stop_reason, "tool_use")
    assert.deepEqual(
      result.content.filter((block) => block.type === "tool_use"),
      [{ type: "tool_use", id: "call_1", name: "noop", input: {} }]
    )
  })
}

test("tool arguments with content still parse as before", () => {
  const result = translateToClaude(toolCallResponse('{"text":"hi"}'))

  assert.deepEqual(
    result.content.find((block) => block.type === "tool_use"),
    { type: "tool_use", id: "call_1", name: "noop", input: { text: "hi" } }
  )
})

for (const [argumentsText, reason] of [
  ["{\"text\":", "is not valid JSON"],
  ["[1]", "is not a JSON object"],
  ["null", "is not a JSON object"]
] as const) {
  test(`invalid tool arguments ${argumentsText} map to a 502 naming the tool`, async () => {
    const { UpstreamToolInputError } = await import("../../src/claude/utils")

    let caught: unknown
    try {
      translateToClaude(toolCallResponse(argumentsText))
    } catch (error) {
      caught = error
    }

    assert.ok(caught instanceof UpstreamToolInputError)
    assert.equal(caught.message, `Upstream returned tool input for "noop" that ${reason}.`)
    assert.equal(caught.response.status, 502)

    const body = await caught.response.json() as { error: { type: string; message: string } }
    assert.equal(body.error.type, "api_error")
    assert.equal(body.error.message, caught.message)
    assert.ok(!caught.message.includes(argumentsText), "argument text must not be echoed")
  })
}
