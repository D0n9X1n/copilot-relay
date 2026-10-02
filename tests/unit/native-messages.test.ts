import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-native-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"
const { createNativeMessages, shouldUseNativeMessages, handleNativeMessages } = await import("../../src/copilot/native")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const { flushLogs } = await import("../../src/lib/log")
type ProxyConfig = import("../../src/lib/config").ProxyConfig
const base = "https://fixture.invalid"
const config: ProxyConfig = {
  host: "127.0.0.1", port: 0, copilotBaseUrl: base, copilotToken: "fake-only", upstreamTimeoutMs: 3000,
  vsCodeVersion: "test", claudeUpstreamApi: "auto",
  modelCatalog: { baseUrl: base, models: new Map([["claude-opus-5.5", { supportedEndpoints: ["/v1/messages", "/chat/completions"] }]]) },
}

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test("native selection requires advertised support in auto mode", () => {
  assert.equal(shouldUseNativeMessages(config, "claude-opus-5.5"), true)
  assert.equal(shouldUseNativeMessages({ ...config, claudeUpstreamApi: "chat-completions" }, "claude-opus-5.5"), false)
  assert.equal(shouldUseNativeMessages({ ...config, modelCatalog: undefined }, "claude-opus-5.5"), false)
})

test("native request preserves signed blocks, cache markers and in-place operator turns", async () => {
  const messages = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "fixture-signature" }, { type: "text", text: "Hi" }] },
    { role: "user", content: [{ type: "text", text: "Continue", cache_control: { type: "ephemeral" } }] },
    { role: "system", content: "Operator note" },
  ]
  let sent: unknown
  await withRecordedTransport({
    fetch: async (request) => {
      assert.equal(request.path, "/v1/messages")
      sent = JSON.parse(request.body!)
      assert.equal(new Headers(request.headers).get("anthropic-version"), "2023-06-01")
      return Response.json({ id: "msg_native", type: "message", role: "assistant", model: "claude-opus-5.5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
    },
    refresh: async () => {
      throw new Error("Unexpected refresh")
    },
  }, () => createNativeMessages(config, { model: "claude-opus-5.5", max_tokens: 512, messages, output_config: { effort: "low" } } as never, { requestId: "native-test" }))
  assert.deepEqual((sent as { messages: unknown }).messages, messages)
  assert.deepEqual((sent as { output_config: unknown }).output_config, { effort: "low" })
})

const message = (content: unknown[], stop_reason = "end_turn") => ({
  id: "msg_fixture", type: "message", role: "assistant", model: "claude-opus-5.5", content,
  stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 },
})
const streamResponse = (values: unknown[]) => new Response(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })

for (const stream of [false, true]) {
  test(`native effort switches preserve initial config and controls (stream=${stream})`, async () => {
    const messages = [
      { role: "user" as const, content: "First turn." },
      { role: "assistant" as const, content: [{ type: "thinking", thinking: "", signature: "fixture-signature" }, { type: "text", text: "OK" }] },
      { role: "system" as const, content: [], output_config: { effort: "high" as const } },
      { role: "user" as const, content: [{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } }] },
    ]
    const payload = { model: "claude-opus-5.5", max_tokens: 32, stream, output_config: { effort: "low" as const }, messages }
    const original = structuredClone(payload)
    const emitted: import("../../src/claude/types").ClaudeStreamEventData[] = []
    await withRecordedTransport({ fetch: async (request) => {
      assert.equal(request.path, "/v1/messages")
      const sent = JSON.parse(request.body!)
      assert.deepEqual(sent.output_config, { effort: "low" })
      assert.deepEqual(sent.messages, original.messages)
      assert.equal(new Headers(request.headers).get("anthropic-beta"), "mid-conversation-output-config-2026-07-01")
      return stream ? streamResponse([
        { type: "message_start", message: message([], null as never) },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]) : Response.json(message([{ type: "text", text: "OK" }]))
    }, refresh: async () => {
      throw new Error("Unexpected refresh")
    } }, () => handleNativeMessages(config, payload as never, {
      requestId: "native-effort-switch", headers: new Headers({ "anthropic-beta": "mid-conversation-output-config-2026-07-01" }),
    }, stream ? async (event) => {
      emitted.push(event)
    } : undefined))
    if (stream) {
      assert.equal(emitted.filter((event) => event.type === "message_stop").length, 1)
    }

    assert.deepEqual(payload, original)
  })
}

test("native search retrieval honors an active inline effort without flattening history", async () => {
  const messages = [
    { role: "user" as const, content: "First turn." },
    { role: "assistant" as const, content: "OK" },
    { role: "system" as const, content: [{ type: "text" as const, text: "" }, { type: "text" as const, text: "" }], output_config: { effort: "high" as const } },
    { role: "user" as const, content: "Look up a reference." },
  ]
  const payload = { model: "claude-opus-5.5", max_tokens: 32, output_config: { effort: "low" as const }, messages,
    tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
  }
  const original = structuredClone(payload)
  const paths: string[] = []
  await withRecordedTransport({ fetch: async (request) => {
    paths.push(request.path)
    const sent = JSON.parse(request.body!)
    if (request.path === "/responses") {
      assert.equal(sent.reasoning.effort, "high")
      assert.doesNotMatch(sent.input, /^system:/m)
      return Response.json({ id: "resp_search", model: sent.model, status: "completed", output: [
        { type: "message", content: [{ type: "output_text", text: "Reference https://example.com/reference" }] },
      ], usage: { input_tokens: 1, output_tokens: 1 } })
    }

    assert.equal(request.path, "/v1/messages")
    assert.deepEqual(sent.output_config, { effort: "low" })
    assert.deepEqual(sent.messages.slice(0, messages.length), messages)
    return Response.json(message(paths.length === 1 ? [
      { type: "tool_use", id: "toolu_search", name: "WebSearch", input: { query: "reference" } },
    ] : [{ type: "text", text: "Answer" }], paths.length === 1 ? "tool_use" : "end_turn"))
  }, refresh: async () => {
    throw new Error("Unexpected refresh")
  } }, () => handleNativeMessages(config, payload, { requestId: "native-search-effort" }))
  assert.deepEqual(paths, ["/v1/messages", "/responses", "/v1/messages"])
  assert.deepEqual(payload, original)
})

test("native search resolves effort against restored tool-result user turns", async () => {
  const id = "srvtoolu_relay_" + Buffer.from(JSON.stringify(["toolu_prior", "WebSearch", 1, 0])).toString("base64url")
  const payload = {
    model: "claude-opus-5.5", max_tokens: 32, output_config: { effort: "low" },
    tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "Earlier lookup." },
      { role: "system", content: [], output_config: { effort: "high" } },
      { role: "assistant", content: [
        { type: "server_tool_use", id, name: "web_search", input: { query: "earlier" } },
        { type: "web_search_tool_result", tool_use_id: id, content: [] },
      ] },
    ],
  }
  const original = structuredClone(payload)
  const calls: Array<{ path: string; body: any }> = []
  await withRecordedTransport({ fetch: async (request) => {
    const body = JSON.parse(request.body!)
    calls.push({ path: request.path, body })
    if (request.path === "/responses") {
      return Response.json({ id: "resp_empty", model: body.model, status: "completed", output: [] })
    }

    assert.deepEqual(body.messages.map((turn: { role: string }) => turn.role), ["user", "system", "assistant", "user"])
    assert.deepEqual(body.output_config, { effort: "low" })
    return Response.json(message([{ type: "tool_use", id: "toolu_next", name: "WebSearch", input: { query: "next" } }], "tool_use"))
  }, refresh: async () => {} }, () => handleNativeMessages(config, payload as never, { requestId: "native-restored-effort" }))
  assert.deepEqual(calls.map((call) => call.path), ["/v1/messages", "/responses"])
  assert.equal(calls[1].body.reasoning.effort, "high")
  assert.deepEqual(payload, original)
})

test("native output limit uses SSE and preserves signed blocks for JSON callers", async () => {
  const limited = { ...config, modelCatalog: { baseUrl: base, models: new Map([["claude-opus-5.5", { limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 900000, max_output_tokens: 128000, max_non_streaming_output_tokens: 8192 } }]]) } }
  let streaming = false
  const result = await withRecordedTransport({
    fetch: async (request) => {
      const sent = JSON.parse(request.body!)
      streaming = sent.stream
      assert.equal(sent.max_tokens, 32000)
      return streamResponse([
        { type: "message_start", message: message([], null as never) },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
        { type: "message_delta", delta: {}, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ])
    }, refresh: async () => {},
  }, () => handleNativeMessages(limited, { model: "claude-opus-5.5", max_tokens: 32000, messages: [{ role: "user", content: "Hi" }] }, { requestId: "native-limit" }))
  assert.equal(streaming, true)
  assert.equal(result?.stop_reason, "end_turn")
  assert.equal(result?.usage.output_tokens, 5)
  assert.equal((result?.content[0] as unknown as { signature: string }).signature, "fixture-signature")
})

test("native streamed trailing usage cannot erase refusal reason or category", async () => {
  const emitted: import("../../src/claude/types").ClaudeStreamEventData[] = []
  await withRecordedTransport({
    fetch: async () => streamResponse([
      { type: "message_start", message: message([], null as never) },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } }, usage: { output_tokens: 4 } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]), refresh: async () => {},
  }, () => handleNativeMessages(config, { model: "claude-opus-5.5", max_tokens: 32, messages: [{ role: "user", content: "Hi" }] }, { requestId: "native-refusal" }, async (event) => {
    emitted.push(event)
  }))
  const final = emitted.findLast((event) => event.type === "message_delta")
  assert.equal(final?.type === "message_delta" ? final.delta.stop_reason : undefined, "refusal")
  assert.equal(final?.type === "message_delta" ? final.usage?.output_tokens : undefined, 5)
  assert.equal(emitted.filter((event) => event.type === "message_stop").length, 1)
})

test("native search history reconstructs the exact signed continuation prefix", async () => {
  const history = [{ role: "user" as const, content: "Look up a reference." }]
  const tool = { name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } }
  const decision = message([
    { type: "thinking", thinking: "", signature: "original-signature" },
    { type: "tool_use", id: "toolu_search", name: "WebSearch", input: { query: "  original query  " } },
    { type: "text", text: "Trailing decision text." },
  ], "tool_use")
  const calls: Array<{ path: string; body: any }> = []
  await withRecordedTransport({
    fetch: async (request) => {
      const body = JSON.parse(request.body!)
      calls.push({ path: request.path, body })
      if (calls.length === 1) {
        return Response.json(decision)
      }

      if (request.path === "/responses") {
        return Response.json({ id: "resp_search", model: "gpt-test", status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: "Reference https://example.com/reference" }] }], usage: { input_tokens: 1, output_tokens: 1 } })
      }

      return Response.json(message([{ type: "thinking", thinking: "", signature: "final-signature" }, { type: "text", text: "Answer" }]))
    }, refresh: async () => {},
  }, async () => {
    const response = await handleNativeMessages(config, { model: "claude-opus-5.5", max_tokens: 512, messages: history, tools: [tool] }, { requestId: "native-search" })
    assert(response)
    assert.equal(calls.length, 3)
    await createNativeMessages(config, { model: "claude-opus-5.5", max_tokens: 512, messages: [...history, { role: "assistant", content: response.content }, { role: "user", content: "Continue" }], tools: [tool] }, { requestId: "native-next" })
    assert.deepEqual(calls[3].body.messages.slice(0, calls[2].body.messages.length), calls[2].body.messages)
    assert.deepEqual(calls[2].body.messages[1].content, decision.content)
    assert.deepEqual(calls[2].body.tools, calls[3].body.tools)
    assert.equal(JSON.stringify(calls[3].body.messages).includes("server_tool_use"), false)
    assert.equal(calls[3].body.messages.at(-2).content[0].signature, "final-signature")
  })
})

test("native forced search is rejected before retrieval", async () => {
  let calls = 0
  await withRecordedTransport({ fetch: async () => {
    calls++
    throw new Error("unexpected")
  }, refresh: async () => {} }, async () => {
    await assert.rejects(handleNativeMessages(config, { model: "claude-opus-5.5", max_tokens: 32, messages: [{ role: "user", content: "Hi" }], tools: [{ name: "WebSearch", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "WebSearch" } }, { requestId: "forced" }))
  })
  assert.equal(calls, 0)
})

test("native mixed search and client tools share the immediate result turn", async () => {
  const calls: Array<{ path: string; body: any }> = []
  const decision = message([
    { type: "thinking", thinking: "", signature: "decision-signature" },
    { type: "tool_use", id: "toolu_search", name: "WebSearch", input: { query: "reference" }, cache_control: { type: "ephemeral" } },
    { type: "tool_use", id: "toolu_client", name: "Read", input: { file_path: "/fixture" } },
  ], "tool_use")
  const payload = { model: "claude-opus-5.5", max_tokens: 512, messages: [{ role: "user" as const, content: "Find and read." }], tools: [{ name: "WebSearch", input_schema: { type: "object" } }, { name: "Read", input_schema: { type: "object" } }] }
  await withRecordedTransport({
    fetch: async (request) => {
      calls.push({ path: request.path, body: JSON.parse(request.body!) })
      return request.path === "/responses" ? Response.json({ id: "resp_search", model: "gpt-test", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }) : Response.json(decision)
    }, refresh: async () => {},
  }, async () => {
    const response = await handleNativeMessages(config, payload, { requestId: "mixed" })
    assert.equal(response?.stop_reason, "tool_use")
    const content = [{ type: "tool_result", tool_use_id: "toolu_client", content: "Fixture", cache_control: { type: "ephemeral" } }]
    await createNativeMessages(config, { ...payload, messages: [...payload.messages, { role: "assistant", content: response!.content }, { role: "user", content } as never] }, { requestId: "mixed-next" })
    const sent = calls.at(-1)!.body.messages
    assert.deepEqual(sent[1].content, decision.content)
    assert.equal(sent.length, 3)
    assert.deepEqual(sent[2].content.map((block: any) => block.tool_use_id), ["toolu_search", "toolu_client"])
    assert.deepEqual(sent[2].content[1], content[0])
  })
})

for (const stream of [false, true]) {
  test(`native partial tool input is not fabricated as an executable empty object (${stream ? "SSE" : "JSON"})`, async () => {
    const emitted: import("../../src/claude/types").ClaudeStreamEventData[] = []
    const limited = { ...config, modelCatalog: { baseUrl: base, models: new Map([["claude-opus-5.5", { limits: { max_context_window_tokens: 1000, max_prompt_tokens: 900, max_output_tokens: 512, max_non_streaming_output_tokens: 16 } }]]) } }
    const result = await withRecordedTransport({ fetch: async () => streamResponse([
      { type: "message_start", message: message([], null as never) },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_partial", name: "Read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 32 } },
      { type: "message_stop" },
    ]), refresh: async () => {} }, () => handleNativeMessages(limited, { model: "claude-opus-5.5", max_tokens: 32, messages: [{ role: "user", content: "Read" }] }, { requestId: "partial" }, stream ? async (event) => {
      emitted.push(event)
    } : undefined))
    if (stream) {
      assert.equal(emitted.some((event) => event.type === "content_block_start" && event.content_block.type === "tool_use"), false)
      assert.equal(emitted.find((event) => event.type === "message_delta")?.delta.stop_reason, "max_tokens")
    } else {
      assert.equal(result?.stop_reason, "max_tokens")
      assert.equal(result?.content.some((block) => block.type === "tool_use"), false)
    }
  })
}

const emptyContentFor = (type: string) => {
  if (type === "thinking") {
    return { thinking: "", signature: undefined }
  }

  if (type === "text") {
    return { text: "" }
  }

  return { input: {} }
}

const streamedNative = (response: ReturnType<typeof message>) => {
  const values: unknown[] = [{ type: "message_start", message: { ...response, content: [], stop_reason: null } }]
  for (const [index, value] of response.content.entries()) {
    const block = value as Record<string, any>
    const start = { ...block, ...emptyContentFor(block.type) }
    values.push({ type: "content_block_start", index, content_block: start })
    if (block.type === "thinking") {
      values.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } })
    } else if (block.type === "text") {
      values.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } })
    } else {
      values.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
    }

    values.push({ type: "content_block_stop", index })
  }

  values.push({ type: "message_delta", delta: { stop_reason: response.stop_reason }, usage: response.usage }, { type: "message_stop" })
  return streamResponse(values)
}

const collectClientBlocks = (events: import("../../src/claude/types").ClaudeStreamEventData[]) => {
  const content: Record<string, any>[] = []
  const inputs = new Map<number, string>()
  const closed = new Set<number>()
  for (const event of events) {
    if (event.type === "content_block_start") {
      assert.equal(event.index, content.length)
      content.push(structuredClone(event.content_block))
    }

    if (event.type === "content_block_delta") {
      assert.equal(closed.has(event.index), false)
      const block = content[event.index]
      if (event.delta.type === "text_delta") {
        block.text += event.delta.text
      }

      if (event.delta.type === "thinking_delta") {
        block.thinking += event.delta.thinking
      }

      if (event.delta.type === "signature_delta") {
        block.signature = (block.signature ?? "") + event.delta.signature
      }

      if (event.delta.type === "input_json_delta") {
        inputs.set(event.index, (inputs.get(event.index) ?? "") + event.delta.partial_json)
      }
    }

    if (event.type === "content_block_stop") {
      closed.add(event.index)
    }
  }

  for (const [index, input] of inputs) {
    content[index].input = JSON.parse(input)
  }

  assert.equal(closed.size, content.length)
  return content
}

for (const sibling of [false, true]) {
  test(`native streamed search keeps exact signed history with sibling=${sibling}`, async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "signed-search-prefix" },
      { type: "text", text: "Checking" },
      { type: "tool_use", id: "toolu_search", name: "WebSearch", input: { query: "reference" }, cache_control: { type: "ephemeral" } },
      ...(sibling ? [{ type: "tool_use", id: "toolu_client", name: "Read", input: { file_path: "/fixture" } }] : []),
    ]
    const payload = { model: "claude-opus-5.5", max_tokens: 512, messages: [{ role: "user" as const, content: "Look up a reference." }], tools: [{ name: "WebSearch", input_schema: { type: "object" } }, { name: "Read", input_schema: { type: "object" } }] }
    const calls: Array<{ path: string; body: any }> = []
    const emitted: import("../../src/claude/types").ClaudeStreamEventData[] = []
    await withRecordedTransport({ fetch: async (request) => {
      calls.push({ path: request.path, body: JSON.parse(request.body!) })
      if (calls.length === 1) {
        return streamedNative(message(content, "tool_use"))
      }

      if (request.path === "/responses") {
        return Response.json({ id: "resp_search", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Reference https://example.com/reference" }] }], usage: { input_tokens: 1, output_tokens: 1 } })
      }

      return streamedNative(message([{ type: "thinking", thinking: "", signature: "signed-final-prefix" }, { type: "text", text: "Answer" }]))
    }, refresh: async () => {} }, async () => {
      await handleNativeMessages(config, payload, { requestId: "streamed-search" }, async (event) => {
        emitted.push(event)
      })
      assert.equal(emitted.filter((event) => event.type === "message_start").length, 1)
      assert.equal(emitted.filter((event) => event.type === "message_stop").length, 1)
      const reconstructed = collectClientBlocks(emitted)
      const nextContent = sibling ? [{ type: "tool_result", tool_use_id: "toolu_client", content: "Fixture" }] : "Continue"
      await createNativeMessages(config, { ...payload, messages: [...payload.messages, { role: "assistant", content: reconstructed } as never, { role: "user", content: nextContent } as never] }, { requestId: "streamed-next" })
      const nextRequest = calls.at(-1)!.body
      assert.deepEqual(nextRequest.messages[1].content, content)
      assert.equal(JSON.stringify(nextRequest.messages).includes("server_tool_use"), false)
      if (sibling) {
        assert.deepEqual(nextRequest.messages[2].content.map((block: any) => block.tool_use_id), ["toolu_search", "toolu_client"])
      } else {
        assert.deepEqual(nextRequest.messages.slice(0, calls[2].body.messages.length), calls[2].body.messages)
      }

      assert.equal(reconstructed[0].signature, "signed-search-prefix")
    })
  })
}

test("native redacted thinking survives request and streamed response unchanged", async () => {
  const redacted = { type: "redacted_thinking", data: "opaque-fixture" }
  const emitted: import("../../src/claude/types").ClaudeStreamEventData[] = []
  await withRecordedTransport({ fetch: async (request) => {
    const sent = JSON.parse(request.body!)
    assert.deepEqual(sent.messages[1].content[0], redacted)
    return streamResponse([{ type: "message_start", message: message([], null as never) }, { type: "content_block_start", index: 0, content_block: redacted }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }])
  }, refresh: async () => {} }, () => handleNativeMessages(config, { model: "claude-opus-5.5", max_tokens: 32, messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: [redacted] } as never, { role: "user", content: "Continue" }] }, { requestId: "redacted-thinking" }, async (event) => {
    emitted.push(event)
  }))
  assert.deepEqual(collectClientBlocks(emitted)[0], redacted)
})

test("native rejects a delta targeting an already closed content block", async () => {
  await withRecordedTransport({ fetch: async () => streamResponse([
    { type: "message_start", message: message([], null as never) },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]), refresh: async () => {} }, () => assert.rejects(handleNativeMessages(config, { model: "claude-opus-5.5", max_tokens: 32, messages: [{ role: "user", content: "Hello" }] }, { requestId: "late" })))
})
