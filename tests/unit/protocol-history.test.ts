import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-history-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"
const { translateToOpenAI } = await import("../../src/claude/translate")
const { createChatCompletions } = await import("../../src/copilot/chat")
const { buildResponsesRequestPayload } = await import("../../src/copilot/responses")
const { runtimeState } = await import("../../src/lib/state")
const { createServer: createRelay } = await import("../../src/server")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const { flushLogs } = await import("../../src/lib/log")
type ClaudeMessage = import("../../src/claude/types").ClaudeMessage
type ClaudeMessagesPayload = import("../../src/claude/types").ClaudeMessagesPayload

test.after(async () => { await flushLogs(); await fs.rm(home, { recursive: true, force: true }) })
test.afterEach(() => { delete runtimeState.modelRouting })

test("mid-conversation operator text keeps its role without assistant continuation", () => {
  const payload = translateToOpenAI({
    model: "opus", max_tokens: 32,
    messages: [
      { role: "user", content: "Review a layout." },
      { role: "system", content: "Operator notice." },
    ],
  })
  assert.deepEqual(payload.messages, [
    { role: "user", content: "Review a layout." },
    { role: "system", content: "Operator notice." },
  ])
  const responses = buildResponsesRequestPayload(payload, "low")
  assert(Array.isArray(responses.input))
  const last = responses.input.at(-1)
  assert(last && "role" in last)
  assert.equal(last.role, "system")
})

test("operator text after a tool result never becomes model speech", () => {
  const payload = translateToOpenAI({
    model: "opus", max_tokens: 32,
    messages: [
      { role: "user", content: "Read the fixture." },
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "/fixture" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "Fixture." }] },
      { role: "system", content: [{ type: "text", text: "New operator note." }] },
    ],
  })
  assert.deepEqual(payload.messages.map((message) => message.role), ["user", "assistant", "tool", "system"])
  assert.equal(payload.messages.at(-1)?.content, "New operator note.")
})

test("unsupported message-level controls and unknown roles fail explicitly", () => {
  for (const message of [
    { role: "system", content: [], output_config: { effort: "ultra" } },
    { role: "system", content: "Temporary notice", clear_at: "next_user_message" },
    { role: "unexpected", content: "Untrusted text" },
  ]) {
    assert.throws(() => translateToOpenAI({
      model: "opus", max_tokens: 32, messages: [{ role: "user", content: "Hi" }, message as never],
    }), (error: unknown) => {
      assert(error instanceof Error && "response" in error)
      assert(error.response instanceof Response)
      assert.equal(error.response.status, 400)
      return true
    })
  }
})

test("redundant inline effort preserves system text and effective effort", async () => {
  const messages = [{ role: "user" as const, content: "Hi" }, { role: "system" as const, content: [{ type: "text" as const, text: "Use the current effort." }], output_config: { effort: "low" as const } }]
  const payload = { model: "opus", max_tokens: 32, output_config: { effort: "low" as const }, messages }
  const original = structuredClone(payload)
  const translated = translateToOpenAI(payload)
  assert.deepEqual(translated.messages, [{ role: "user", content: "Hi" }, { role: "system", content: "Use the current effort." }])
  assert.equal(translated.reasoning_effort, "low")
  assert.deepEqual(payload, original)
  for (const stream of [false, true]) {
    let called = false
    await withRecordedTransport({ fetch: async (request) => {
      called = true
      const sent = JSON.parse(request.body!)
      assert.equal(sent.reasoning_effort, "low")
      assert.equal(sent.messages[1].role, "system")
      const choice = { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }
      return stream ? new Response(`data: ${JSON.stringify({ id: "chat_fixture", model: "claude-opus-5.5", created: 1, choices: [{ ...choice, message: undefined, delta: { content: "OK" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json({ id: "chat_fixture", model: "claude-opus-5.5", created: 1, choices: [choice] })
    }, refresh: async () => {} }, async () => {
      const app = createRelay({ host: "localhost", port: 0, copilotBaseUrl: "https://fixture.invalid", copilotToken: "fixture", vsCodeVersion: "test", upstreamTimeoutMs: 1000 })
      const response = await app.fetch(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, stream }) }))
      assert.equal(response.status, 200)
      await response.text()
    })
    assert.equal(called, true)
  }
  const pending = translateToOpenAI({ ...payload, messages: [{ role: "system", content: "Use the next effort.", output_config: { effort: "high" } }] })
  assert.equal(pending.reasoning_effort, "low")
  for (const output_config of [{ effort: "low", format: {} }, { effort: "none" }, { effort: "ultra" }, {}, null, []]) {
    assert.throws(() => translateToOpenAI({ ...payload, messages: [{ ...messages[1], output_config } as never] }))
  }
})

test("effort-only controls preserve tool adjacency and translated prefixes", () => {
  const prefix: ClaudeMessage[] = [
    { role: "user", content: "Read the fixture." },
    { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "/fixture" } }] },
  ]
  const result: ClaudeMessage = { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "Fixture." }] }
  const before: ClaudeMessagesPayload = { model: "opus", max_tokens: 32, output_config: { effort: "low" }, messages: [...prefix, result] }
  for (const content of [[], "", [{ type: "text" as const, text: "" }]]) {
    const switched: ClaudeMessagesPayload = { ...before, messages: [...prefix, { role: "system", content, output_config: { effort: "high" } }, result] }
    const original: ClaudeMessagesPayload = structuredClone(switched)
    const translated = translateToOpenAI(switched)
    assert.equal(translated.reasoning_effort, "high")
    assert.deepEqual(translated.messages, translateToOpenAI(before).messages)
    assert.deepEqual(translated.messages.map((message) => message.role), ["user", "assistant", "tool"])
    assert.deepEqual(switched, original)
    const next = translateToOpenAI({ ...switched, messages: [
      ...switched.messages, { role: "assistant", content: "Done." },
      { role: "system", content: [], output_config: { effort: "max" } },
      { role: "user", content: "Next task." },
    ] })
    assert.equal(next.reasoning_effort, "max")
    assert.deepEqual(next.messages.slice(0, translated.messages.length), translated.messages)
    assert.equal(buildResponsesRequestPayload({ ...translated, user: "session-effort" }, "high").prompt_cache_key,
      buildResponsesRequestPayload({ ...next, user: "session-effort" }, "max").prompt_cache_key)
  }
})

test("text-bearing effort switches preserve operator roles and message order", () => {
  const payload = { model: "opus", max_tokens: 32, output_config: { effort: "low" as const }, messages: [
    { role: "user" as const, content: "Hi" },
    { role: "assistant" as const, content: "Hello" },
    { role: "system" as const, content: [{ type: "text" as const, text: "Review carefully." }], output_config: { effort: "high" as const } },
    { role: "user" as const, content: "Continue" },
  ] }
  const translated = translateToOpenAI(payload)
  assert.equal(translated.reasoning_effort, "high")
  assert.deepEqual(translated.messages, [
    { role: "user", content: "Hi" }, { role: "assistant", content: "Hello" },
    { role: "system", content: "Review carefully." }, { role: "user", content: "Continue" },
  ])
})

test("appending an operator turn keeps earlier request messages unchanged", () => {
  const prefix = [{ role: "user" as const, content: "Hi" }, { role: "assistant" as const, content: "Hello" }, { role: "user" as const, content: "Continue" }]
  const before = translateToOpenAI({ model: "opus", max_tokens: 32, system: "Stable prompt", messages: prefix })
  const after = translateToOpenAI({ model: "opus", max_tokens: 32, system: "Stable prompt", messages: [...prefix, { role: "system", content: "New note" }] })
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages)
})

test("shared upstream client preserves an already resolved non-Opus target", async (t) => {
  const models: string[] = []
  const upstream = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    models.push(payload.model)
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      id: "chat_fixture", model: payload.model, created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })
  const address = upstream.address()
  assert(address && typeof address !== "string")
  runtimeState.modelRouting = { gptModel: "gpt-4.1", opusModel: "claude-sonnet-4.6" }
  const payload = translateToOpenAI({ model: "opus", max_tokens: 32, messages: [{ role: "user", content: "OK" }] })
  assert.equal(payload.model, "claude-sonnet-4.6")
  await createChatCompletions({
    host: "127.0.0.1", port: 0, copilotBaseUrl: `http://127.0.0.1:${address.port}`,
    copilotToken: "fixture-only", upstreamTimeoutMs: 3000, vsCodeVersion: "1.99.3",
  }, payload)
  assert.deepEqual(models, ["claude-sonnet-4.6"])
})

for (const stream of [false, true]) {
  for (const native of [false, true]) {
    test(`unsupported history fails before ${stream ? "SSE" : "JSON"} on ${native ? "native" : "translated"} requests`, async () => {
      let upstreamCalls = 0
      const base = "https://fixture.invalid"
      const app = createRelay({ host: "localhost", port: 0, copilotBaseUrl: base, copilotToken: "fixture", vsCodeVersion: "test", upstreamTimeoutMs: 1000,
        claudeUpstreamApi: native ? "messages" : "chat-completions",
        modelCatalog: { baseUrl: base, models: new Map() },
      })
      const messages = native ? [
        { role: "unexpected", content: "Hi" },
        { role: "assistant", content: [{ type: "server_tool_use", id: "srvtoolu_unknown", name: "web_search", input: { query: "Hi" } }] },
      ] : [
        { role: "system", content: "Hi", output_config: { effort: "low", format: {} } },
        { role: "system", content: "Hi", clear_at: "next_user_message" },
        { role: "unexpected", content: "Hi" },
        { role: "system", content: [{ type: "image" }] },
      ]
      await withRecordedTransport({ fetch: async () => { upstreamCalls++; throw new Error("Unexpected upstream") }, refresh: async () => {} }, async () => {
        for (const message of messages) {
          const response = await app.fetch(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "opus", max_tokens: 32, stream, messages: [{ role: "user", content: "Hello" }, message] }),
          }))
          const body = await response.text()
          assert.equal(response.status, 400)
          assert.match(response.headers.get("content-type") ?? "", /application\/json/)
          assert.equal(JSON.parse(body).error.type, "invalid_request_error")
        }
      })
      assert.equal(upstreamCalls, 0)
    })
  }
  test(`forced native search returns HTTP400 before ${stream ? "SSE" : "JSON"}`, async () => {
    let upstreamCalls = 0
    const app = createRelay({ host: "localhost", port: 0, copilotBaseUrl: "https://fixture.invalid", copilotToken: "fixture", vsCodeVersion: "test", upstreamTimeoutMs: 1000, claudeUpstreamApi: "messages" })
    await withRecordedTransport({ fetch: async () => { upstreamCalls++; throw new Error("Unexpected upstream") }, refresh: async () => {} }, async () => {
      for (const tool_choice of [{ type: "any" }, { type: "tool", name: "WebSearch" }]) {
        const response = await app.fetch(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          model: "opus", max_tokens: 32, stream, messages: [{ role: "user", content: "Hi" }], tools: [{ name: "WebSearch", input_schema: { type: "object" } }], tool_choice,
        }) }))
        await response.text()
        assert.equal(response.status, 400)
      }
    })
    assert.equal(upstreamCalls, 0)
  })
}
