import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer, type IncomingHttpHeaders, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"

// src/ resolves its paths from the home directory at import time, so redirect it before importing.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-codex-responses-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs } = await import("../../src/lib/log")
const { readLogs } = await import("../fixtures/logs")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelRouting
})

type UpstreamRequest = { method: string; path: string; headers: IncomingHttpHeaders; body: Record<string, any> }
type Reply = (response: ServerResponse, request: UpstreamRequest) => void

const astra = {
  supportedEndpoints: ["/responses", "ws:/responses"],
  type: "chat",
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
}

// The SSE Copilot sends for one text answer, in the order it sends it, with no [DONE].
const sseEvents = [
  { type: "response.created", response: { id: "resp_codex_1", status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_codex_1",
      model: "gpt-6-astra",
      status: "completed",
      output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 1203,
      },
    },
  },
]
const sseBody = sseEvents.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const replySse: Reply = (response) => {
  response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "copilot-req-1" })
  response.end(sseBody)
}

const replyJson = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => (response) => {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(body))
}

const userTurn = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })

// A request body shaped like the ones Codex 0.164 sends to a custom provider.
const codexBody = (overrides: Record<string, unknown> = {}) => ({
  model: "gpt-6-astra",
  stream: true,
  input: [userTurn("Reply with ok.")],
  tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } }],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "medium", summary: "auto" },
  store: false,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "thread-fixture",
  client_metadata: { session_id: "session-fixture" },
  ...overrides,
})

interface Relay {
  requests: Array<UpstreamRequest>
  send: (body: unknown, headers?: Record<string, string>) => Promise<Response>
}

// Starts a mock Copilot that answers /responses with `reply` and /models with `catalog`, and a relay
// app pointed at it.
const startRelay = async (
  t: TestContext,
  reply: Reply,
  options: { models?: Array<[string, Record<string, unknown>]>; catalog?: unknown; apiKey?: string } = {},
): Promise<Relay> => {
  const requests: Array<UpstreamRequest> = []
  const upstream = createHttpServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
    }

    const request = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} }
    requests.push(request)

    if (req.url === "/models") {
      replyJson(200, options.catalog ?? { data: [] })(res, request)
      return
    }

    reply(res, request)
  })

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  const address = upstream.address()
  assert(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}`

  runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" }
  const app = createServer({
    copilotBaseUrl: baseUrl,
    copilotToken: "fixture-only",
    host: "127.0.0.1",
    port: 0,
    upstreamTimeoutMs: 3000,
    vsCodeVersion: "1.99.3",
    apiKey: options.apiKey,
    modelCatalog: { baseUrl, models: new Map(options.models ?? [["gpt-6-astra", astra]]) },
  })

  const send = async (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    await app.fetch(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }))

  return { requests, send }
}

const responsesCalls = (relay: Relay) => relay.requests.filter((request) => request.path === "/responses")

test("a streamed Codex request reaches Copilot /responses and its SSE comes back unchanged", async (t) => {
  const relay = await startRelay(t, replySse)
  const response = await relay.send(codexBody())

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  assert.equal(response.headers.get("x-request-id"), "copilot-req-1")
  assert.equal(await response.text(), sseBody)

  const [upstream] = responsesCalls(relay)
  assert.equal(upstream?.method, "POST")
  assert.equal(upstream?.headers.accept, "text/event-stream")
  assert.equal(upstream?.headers.authorization, "Bearer fixture-only")
  assert.equal(upstream?.headers["x-initiator"], "user")
  assert.equal(upstream?.headers["copilot-vision-request"], undefined)
  assert.deepEqual(upstream?.body, codexBody())
})

test("the completion of a Codex request is logged for the cache report", async (t) => {
  const relay = await startRelay(t, replySse)
  const response = await relay.send(codexBody())
  await response.text()
  await flushLogs()

  const requestId = response.headers.get("x-copilot-relay-request-id")
  const logs = await readLogs()
  const request = logs.split("\n").find((line) => line.includes(`request_id=${requestId} Model request client=codex`))
  const completion = logs.split("\n").find((line) => line.includes(`request_id=${requestId}`) && line.includes(" completion path=/responses"))

  assert.match(request ?? "", /requested_model=gpt-6-astra upstream_model=gpt-6-astra upstream_api=responses requested_think_effort=medium effective_think_effort=medium initiator=user/)
  assert.match(completion ?? "", /http_status=200 body=complete/)
  assert.match(completion ?? "", /input_tokens=1200/)
  assert.match(completion ?? "", /cache_read_input_tokens=1024/)
})

test("a non-streamed Codex request returns Copilot's JSON", async (t) => {
  const answer = { id: "resp_json", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } }
  const relay = await startRelay(t, replyJson(200, answer))
  const response = await relay.send(codexBody({ stream: false }))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "application/json")
  assert.deepEqual(await response.json(), answer)
  assert.equal(responsesCalls(relay)[0]?.headers.accept, "application/json")
})

test("only the fields Copilot rejects are changed", async (t) => {
  const relay = await startRelay(t, replySse)
  const body = codexBody({
    service_tier: "priority",
    reasoning: { effort: "ultra", summary: "auto" },
    tools: [{ type: "web_search" }, { type: "image_generation", output_format: "png" }],
  })
  await (await relay.send(body)).text()

  const sent = responsesCalls(relay)[0]?.body
  assert.equal(Object.hasOwn(sent ?? {}, "service_tier"), false)
  assert.deepEqual(sent?.reasoning, { effort: "max", summary: "auto" })
  assert.deepEqual(sent?.tools, [{ type: "web_search" }])
  assert.equal(sent?.prompt_cache_key, "thread-fixture")
  assert.deepEqual(sent?.include, ["reasoning.encrypted_content"])
})

test("a tool output or a Codex subagent is sent as the agent, and an image turns on vision", async (t) => {
  const relay = await startRelay(t, replySse)
  const image = { type: "input_image", image_url: "data:image/png;base64,AA" }
  const toolTurn = [
    userTurn("Look at a.png"),
    { type: "function_call", call_id: "call_1", name: "view_image", arguments: "{\"path\":\"a.png\"}" },
    { type: "function_call_output", call_id: "call_1", output: [image] },
  ]

  await (await relay.send(codexBody({ input: toolTurn }))).text()
  await (await relay.send(codexBody(), { "x-openai-subagent": "compact" })).text()

  const [toolCall, compaction] = responsesCalls(relay)
  assert.equal(toolCall?.headers["x-initiator"], "agent")
  assert.equal(toolCall?.headers["copilot-vision-request"], "true")
  assert.equal(compaction?.headers["x-initiator"], "agent")
})

test("a model the catalog does not list goes to the configured gptModel", async (t) => {
  const catalog = {
    data: [{
      id: "gpt-6-astra",
      supported_endpoints: ["/responses"],
      capabilities: { type: "chat", supports: { reasoning_effort: ["low", "medium", "high", "xhigh", "max"] } },
    }],
  }
  const relay = await startRelay(t, replySse, { catalog })
  await (await relay.send(codexBody({ model: "codex-auto-review" }))).text()

  // The relay refreshes the catalog once for the unknown name before falling back.
  assert.deepEqual(relay.requests.map((request) => request.path), ["/models", "/responses"])
  assert.equal(responsesCalls(relay)[0]?.body.model, "gpt-6-astra")
})

test("a Claude model or a model without /responses is refused before any upstream call", async (t) => {
  const relay = await startRelay(t, replySse, {
    models: [
      ["gpt-6-astra", astra],
      ["claude-opus-5.5", { supportedEndpoints: ["/v1/messages", "/chat/completions"], type: "chat" }],
      ["gpt-4o", { supportedEndpoints: ["/chat/completions"], type: "chat" }],
    ],
  })

  const claude = await relay.send(codexBody({ model: "claude-opus-5.5" }))
  const chatOnly = await relay.send(codexBody({ model: "gpt-4o" }))

  assert.equal(claude.status, 400)
  assert.equal((await claude.json() as { error: { code: string } }).error.code, "relay_unsupported_model")
  assert.equal(chatOnly.status, 400)
  assert.equal((await chatOnly.json() as { error: { code: string } }).error.code, "relay_unsupported_endpoint")
  assert.deepEqual(relay.requests, [])
})

test("an upstream error keeps its status, body and retry-after", async (t) => {
  const error = { error: { message: "Rate limit exceeded", code: "rate_limit_exceeded", type: "rate_limit_error" } }
  const relay = await startRelay(t, replyJson(429, error, { "retry-after": "7" }))
  const response = await relay.send(codexBody())

  assert.equal(response.status, 429)
  assert.equal(response.headers.get("retry-after"), "7")
  assert.deepEqual(await response.json(), error)
})

test("a streamed prompt over the input limit becomes response.failed with context_length_exceeded", async (t) => {
  const overflow = {
    error: {
      message: "prompt token count of 1100000 exceeds the limit of 1050000",
      code: "model_max_prompt_tokens_exceeded",
    },
  }
  const relay = await startRelay(t, replyJson(400, overflow))

  const streamed = await relay.send(codexBody())
  assert.equal(streamed.status, 200)
  assert.equal(streamed.headers.get("content-type"), "text/event-stream")

  const text = await streamed.text()
  const event = JSON.parse(text.split("\n")[1]!.slice("data: ".length))
  assert.equal(event.type, "response.failed")
  assert.equal(event.response.error.code, "context_length_exceeded")
  assert.match(event.response.error.message, /1100000 tokens > 1050000 maximum/)

  const json = await relay.send(codexBody({ stream: false }))
  assert.equal(json.status, 400)
  assert.deepEqual(await json.json(), overflow)
})

test("a body that is not JSON, or not declared as JSON, is refused", async (t) => {
  const relay = await startRelay(t, replySse)

  const invalid = await relay.send("{")
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json() as { error: { code: string } }).error.code, "invalid_json")

  const plain = await relay.send(codexBody(), { "content-type": "text/plain" })
  assert.equal(plain.status, 415)
  assert.deepEqual(relay.requests, [])
})

test("with an apiKey, Codex must send it as a bearer token or x-api-key", async (t) => {
  const relay = await startRelay(t, replySse, { apiKey: "codex-fixture-key" })

  assert.equal((await relay.send(codexBody())).status, 401)
  assert.equal((await relay.send(codexBody(), { authorization: "Bearer wrong" })).status, 401)

  const bearer = await relay.send(codexBody(), { authorization: "Bearer codex-fixture-key" })
  assert.equal(bearer.status, 200)
  await bearer.text()

  const header = await relay.send(codexBody(), { "x-api-key": "codex-fixture-key" })
  assert.equal(header.status, 200)
  await header.text()

  assert.equal(responsesCalls(relay).length, 2)
})
