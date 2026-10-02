import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-terminals-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { translateResponsesStreamToChatCompletionStream, translateResponsesToChatCompletion } = await import("../../src/copilot/responses")
const { collectChatCompletionStream, normalizeChatCompletionStream } = await import("../../src/copilot/stream")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const { createServer } = await import("../../src/server")
const { withoutLogging, flushLogs } = await import("../../src/lib/log")
const { translateChunkToClaudeEvents } = await import("../../src/claude/stream")
type ChatCompletionChunk = import("../../src/copilot/types").ChatCompletionChunk
type ClaudeStreamState = import("../../src/claude/types").ClaudeStreamState

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

// SSE events for the given payloads; a string such as "[DONE]" passes through as raw data.
async function* events(...values: unknown[]) {
  for (const value of values) {
    yield { data: typeof value === "string" ? value : JSON.stringify(value) }
  }
}

for (const [reason, expected] of [["max_output_tokens", "length"], ["content_filter", "content_filter"]] as const) {
  test(`Responses ${reason} terminal retains its stop reason`, async () => {
    const response = {
      id: "resp_terminal",
      model: "gpt-6-astra",
      created_at: 1,
      status: "incomplete",
      incomplete_details: { reason },
      output: [],
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
    }

    const output = []
    for await (const event of translateResponsesStreamToChatCompletionStream(events({ type: "response.incomplete", response }))) {
      if (event.data && event.data !== "[DONE]") {
        output.push(JSON.parse(event.data))
      }
    }

    assert.equal(output.at(-1)?.choices[0]?.finish_reason, expected)
    assert.equal(output.at(-1)?.usage.prompt_tokens, 100)
  })
}

test("incomplete Responses function calls cannot become tool-use completion", () => {
  const response = translateResponsesToChatCompletion({
    id: "resp_incomplete_tool", model: "gpt-6-astra", created_at: 1, status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", call_id: "call_1", name: "Read", arguments: '{"file_path":' }],
  })

  assert.equal(response.choices[0]?.finish_reason, "length")
})

for (const type of ["response.failed", "error"]) {
  test(`Responses ${type} terminal fails rather than silently disappearing`, async () => {
    await assert.rejects(async () => {
      for await (const event of translateResponsesStreamToChatCompletionStream(events({
        type,
        response: { id: "resp_failed", model: "gpt-6-astra", created_at: 1, status: "failed", output: [] },
        error: { message: "fixture failure" },
      }))) {
        void event
      }
    })
  })
}

test("collector retains usage after terminal choice", async () => {
  const base = { id: "chat_usage", object: "chat.completion.chunk", model: "claude-opus-5.5", created: 1 }

  const result = await collectChatCompletionStream(events(
    { ...base, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop", logprobs: null }] },
    { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 90 } } },
    "[DONE]",
  ))

  assert.equal(result.usage?.prompt_tokens_details?.cached_tokens, 90)
})

test("interleaved tool arguments never target a closed Claude content block", () => {
  const state: ClaudeStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    thinkingBlockOpen: false,
    toolCalls: {},
  }
  const base = { id: "chat_tools", object: "chat.completion.chunk" as const, model: "claude-opus-5.5", created: 1 }

  // call_a's last argument chunk arrives after call_b has already started.
  const chunks: ChatCompletionChunk[] = [
    { ...base, choices: [{ index: 0, logprobs: null, finish_reason: null, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: '{"file_path":' } }] } }] },
    { ...base, choices: [{ index: 0, logprobs: null, finish_reason: null, delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "Read", arguments: '{"file_path":"/b"}' } }] } }] },
    { ...base, choices: [{ index: 0, logprobs: null, finish_reason: null, delta: { tool_calls: [{ index: 0, function: { arguments: '"/a"}' } }] } }] },
    { ...base, choices: [{ index: 0, logprobs: null, finish_reason: "tool_calls", delta: {} }] },
  ]
  const closed = new Set<number>()

  for (const chunk of chunks) {
    for (const event of translateChunkToClaudeEvents(chunk, state)) {
      if (event.type === "content_block_stop") {
        closed.add(event.index)
      }

      if (event.type === "content_block_delta") {
        assert.equal(closed.has(event.index), false, `delta for closed block ${event.index}`)
      }
    }
  }
})

test("search-shaped refusal emits preamble and later text exactly once", async () => {
  const base = { id: "chat_preamble", created: 1, model: "claude-opus-5.5" }
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { content: "Checking", reasoning_text: "First thought" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_search", type: "function", function: { name: "WebSearch", arguments: '{"query":"fixture"}' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: " declined", refusal: "Declined" }, finish_reason: "content_filter" }] },
  ]
  let calls = 0

  const text = await withoutLogging(() => withRecordedTransport({
    fetch: async () => {
      calls++
      return new Response(
        chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
    refresh: async () => {},
  }, async () => {
    const response = await createServer({
      host: "localhost",
      port: 0,
      copilotBaseUrl: "https://fixture.invalid",
      copilotToken: "fixture",
      upstreamTimeoutMs: 1000,
      vsCodeVersion: "test",
    }).fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opus",
        stream: true,
        max_tokens: 32,
        messages: [{ role: "user", content: "Search" }],
        tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
      }),
    }))
    return response.text()
  }))

  const clientEvents = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
  // The refusal ends the turn, so the streamed WebSearch call is never executed.
  assert.equal(calls, 1)
  assert.equal(clientEvents.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text).join(""), "Checking declined")
  assert.equal(clientEvents.filter((event) => event.delta?.type === "thinking_delta").map((event) => event.delta.thinking).join(""), "First thought")
  assert.equal(clientEvents.find((event) => event.type === "message_delta").delta.stop_reason, "refusal")
})

for (const stream of [false, true]) {
  test(`WebSearch accounts for every pass and cached input (${stream ? "SSE" : "JSON"})`, async () => {
    const base = { id: "chat_usage", created: 1, model: "claude-opus-5.5" }
    const tool_calls = [{ id: "call_search", type: "function", function: { name: "WebSearch", arguments: '{"query":"fixture"}' } }]
    let calls = 0

    const result = await withoutLogging(() => withRecordedTransport({
      fetch: async (request) => {
        calls++
        if (request.path === "/responses") {
          return Response.json({
            id: "resp_search",
            model: "gpt-test",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "Source https://example.com/reference" }] }],
            usage: { input_tokens: 50, output_tokens: 2, input_tokens_details: { cached_tokens: 40 } },
          })
        }

        if (calls === 3) {
          return Response.json({
            ...base,
            choices: [{ index: 0, message: { role: "assistant", content: "Answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 200, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 180 } },
          })
        }

        const usage = { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90 } }
        if (!stream) {
          return Response.json({
            ...base,
            choices: [{ index: 0, message: { role: "assistant", content: "Checking", tool_calls }, finish_reason: "tool_calls" }],
            usage,
          })
        }

        return new Response(
          [
            { ...base, choices: [{ index: 0, delta: { content: "Checking" }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: { tool_calls: tool_calls.map((call, index) => ({ ...call, index })) }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
          ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      refresh: async () => {},
    }, async () => {
      const response = await createServer({
        host: "localhost",
        port: 0,
        copilotBaseUrl: "https://fixture.invalid",
        copilotToken: "fixture",
        upstreamTimeoutMs: 1000,
        vsCodeVersion: "test",
      }).fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "opus",
          stream,
          max_tokens: 32,
          messages: [{ role: "user", content: "Search" }],
          tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
        }),
      }))
      return response.text()
    }))

    assert.equal(calls, 3)
    const usage = stream
      ? result.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
        .findLast((event) => event.type === "message_delta").usage
      : JSON.parse(result).usage

    // Usage sums the decision, search and answer passes: 10 + 10 + 20 uncached
    // input, 90 + 40 + 180 cache reads, and 5 + 2 + 3 output tokens.
    assert.equal(usage.input_tokens, 40)
    assert.equal(usage.cache_read_input_tokens, 310)
    assert.equal(usage.output_tokens, 10)
    assert.equal(usage.server_tool_use.web_search_requests, 1)
  })
}

test("streamed explicit refusal overrides a tool-call finish reason", async () => {
  const base = { id: "chat_refusal", created: 1, model: "claude-opus-5.5" }

  const response = await collectChatCompletionStream(normalizeChatCompletionStream(events(
    { ...base, choices: [{ index: 0, delta: { refusal: "Declined", tool_calls: [{ index: 0, id: "call_search", type: "function", function: { name: "WebSearch", arguments: '{"query":"fixture"}' } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  )))

  assert.equal(response.choices[0].finish_reason, "content_filter")
  assert.equal(response.choices[0].message.refusal, "Declined")
})

for (const stream of [false, true]) {
  test(`explicit refusal cannot execute the WebSearch bridge (${stream ? "SSE" : "JSON"})`, async () => {
    const paths: string[] = []
    const base = { id: "chat_refusal", created: 1, model: "claude-opus-5.5" }
    const message = {
      role: "assistant",
      content: null,
      refusal: "Declined",
      tool_calls: [{ id: "call_search", type: "function", function: { name: "WebSearch", arguments: '{"query":"fixture"}' } }],
    }

    const text = await withoutLogging(() => withRecordedTransport({
      fetch: async (request) => {
        paths.push(request.path)
        assert.equal(request.path, "/chat/completions")
        if (!stream) {
          return Response.json({
            ...base,
            choices: [{ index: 0, message, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 1 },
          })
        }

        return new Response(
          [
            { ...base, choices: [{ index: 0, delta: { ...message, tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      refresh: async () => {},
    }, async () => {
      const response = await createServer({
        host: "localhost",
        port: 0,
        copilotBaseUrl: "https://fixture.invalid",
        copilotToken: "fixture",
        upstreamTimeoutMs: 1000,
        vsCodeVersion: "test",
      }).fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "opus",
          stream,
          max_tokens: 32,
          messages: [{ role: "user", content: "Search" }],
          tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
        }),
      }))
      assert.equal(response.status, 200)
      return response.text()
    }))

    assert.deepEqual(paths, ["/chat/completions"])
    if (stream) {
      const clientEvents = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
      assert.equal(clientEvents.find((event) => event.type === "message_delta").delta.stop_reason, "refusal")
      assert.equal(clientEvents.some((event) => event.type === "content_block_start" && ["tool_use", "server_tool_use"].includes(event.content_block.type)), false)
    } else {
      assert.equal(JSON.parse(text).stop_reason, "refusal")
      assert.equal(JSON.parse(text).content.some((block: { type: string }) => ["tool_use", "server_tool_use"].includes(block.type)), false)
    }
  })
}
