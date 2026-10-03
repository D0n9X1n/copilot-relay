import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// src/ resolves its paths from the home directory at import time, so redirect it before importing.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-tool-images-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs } = await import("../../src/lib/log")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelRouting
})

type UpstreamRequest = { path: string; headers: IncomingHttpHeaders; body: Record<string, any> }

// A 1x1 PNG. Nothing decodes it; each route only has to deliver it.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const pngUrl = `data:image/png;base64,${png}`
const question = "Call read_image on /tmp/test.png, then name the color of its top half."
const toolArguments = JSON.stringify({ path: "/tmp/test.png" })
const answer = "Top half: yellow."

// What Claude Code sends after a tool returns an image: an image block inside the tool_result.
const claudeRequest = {
  model: "claude-sonnet-5",
  max_tokens: 256,
  tools: [{ name: "read_image", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  messages: [
    { role: "user", content: question },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_test_1", name: "read_image", input: { path: "/tmp/test.png" } }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_test_1",
        content: [
          { type: "text", text: "Loaded /tmp/test.png." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        ],
        cache_control: { type: "ephemeral" },
      }],
    },
  ],
}

const assistantToolCall = {
  role: "assistant",
  content: null,
  tool_calls: [{ id: "toolu_test_1", type: "function", function: { name: "read_image", arguments: toolArguments } }],
}

// The input of every /responses request for claudeRequest.
const responsesInput = [
  { role: "user", content: question },
  { type: "function_call", call_id: "toolu_test_1", name: "read_image", arguments: toolArguments },
  {
    type: "function_call_output",
    call_id: "toolu_test_1",
    output: [
      { type: "input_text", text: "Loaded /tmp/test.png." },
      { type: "input_image", image_url: pngUrl },
    ],
  },
]

// The chat messages a non-Claude model receives: the tool message keeps its text, and the image
// follows in a user message.
const movedImageMessages = [
  { role: "user", content: question },
  assistantToolCall,
  { role: "tool", tool_call_id: "toolu_test_1", content: "Loaded /tmp/test.png." },
  {
    role: "user",
    content: [
      { type: "text", text: "Image output of tool call toolu_test_1:" },
      { type: "image_url", image_url: { url: pngUrl } },
    ],
  },
]

// Sends claudeRequest through the relay to a mock Copilot that advertises `endpoints` for `model`,
// and returns every request the relay sent upstream.
const relay = async (
  t: import("node:test").TestContext,
  model: string,
  endpoints: Array<string>,
  rejectChat = false,
): Promise<Array<UpstreamRequest>> => {
  const requests: Array<UpstreamRequest> = []
  const upstream = createHttpServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
    }

    requests.push({ path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} })
    res.setHeader("content-type", "application/json")

    // Copilot can list a model and still refuse its chat endpoint; the relay then retries on /responses.
    if (rejectChat && req.url === "/chat/completions") {
      res.writeHead(400)
      res.end(JSON.stringify({ error: { code: "unsupported_api_for_model" } }))
      return
    }

    if (req.url === "/responses") {
      res.end(JSON.stringify({
        id: "resp_tool_image",
        model,
        created_at: 1,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }))
      return
    }

    res.end(JSON.stringify({
      id: "chat_tool_image",
      model,
      created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }))
  })

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  const address = upstream.address()
  assert(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}`

  // Both routing slots name the model under test, so the requested alias reaches it.
  runtimeState.modelRouting = { gptModel: model, opusModel: model }
  const app = createServer({
    copilotBaseUrl: baseUrl,
    copilotToken: "fake-token",
    host: "127.0.0.1",
    port: 0,
    upstreamTimeoutMs: 3000,
    vsCodeVersion: "1.99.3",
    modelCatalog: { baseUrl, models: new Map([[model, { supportedEndpoints: endpoints }]]) },
  })

  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claudeRequest),
  }))

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json() as { content: Array<{ text?: string }> }).content[0]?.text, answer)
  return requests
}

test("a /responses model receives a tool-result image as an input_image item", async (t) => {
  const requests = await relay(t, "gpt-6-astra", ["/responses"])

  assert.deepEqual(requests.map((request) => request.path), ["/responses"])
  assert.equal(requests[0]?.headers["copilot-vision-request"], "true")
  assert.deepEqual(requests[0]?.body.input, responsesInput)
})

test("a non-Claude chat model receives a tool-result image in the next user message", async (t) => {
  const requests = await relay(t, "gemini-3.8-flash", ["/chat/completions"])

  assert.deepEqual(requests.map((request) => request.path), ["/chat/completions"])
  assert.equal(requests[0]?.headers["copilot-vision-request"], "true")
  assert.deepEqual(requests[0]?.body.messages, movedImageMessages)
})

test("claude-opus-5.5 on the chat route keeps a tool-result image inside the tool message", async (t) => {
  const requests = await relay(t, "claude-opus-5.5", ["/chat/completions"])

  assert.deepEqual(requests.map((request) => request.path), ["/chat/completions"])
  assert.equal(requests[0]?.headers["copilot-vision-request"], "true")
  assert.deepEqual(requests[0]?.body.messages, [
    { role: "user", content: question },
    assistantToolCall,
    {
      role: "tool",
      tool_call_id: "toolu_test_1",
      content: [
        { type: "text", text: "Loaded /tmp/test.png." },
        { type: "image_url", image_url: { url: pngUrl } },
      ],
      copilot_cache_control: { type: "ephemeral" },
    },
    // The shared chat layer appends a user turn after a trailing tool turn, as before.
    { role: "user", content: "Continue based on the context above." },
  ])
})

test("the /responses retry of a refused chat request sends the tool-result image as input_image", async (t) => {
  const requests = await relay(t, "gpt-5-mini", ["/chat/completions", "/responses"], true)

  assert.deepEqual(requests.map((request) => request.path), ["/chat/completions", "/responses"])
  assert.deepEqual(requests[0]?.body.messages, movedImageMessages)
  assert.deepEqual(requests[1]?.body.input, responsesInput)

  for (const request of requests) {
    assert.equal(request.headers["copilot-vision-request"], "true")
  }
})
