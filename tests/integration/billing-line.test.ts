import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// src/ resolves its paths from the home directory at import time, so redirect it before importing.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-billing-line-"))
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

type UpstreamRequest = { path: string; raw: string; body: Record<string, any> }

const billingLine = "x-anthropic-billing-header: cc_version=2.1.288.976; cc_entrypoint=sdk-cli;"
const identity = "You are Claude Code, Anthropic's official CLI for Claude."
const instructions = "The secret word is HERON-12010."
const answer = "HERON-12010"

// The shape Claude Code 2.1.288 sends: the billing line first, then the cached system prompt.
const claudeRequest = {
  model: "claude-sonnet-5",
  max_tokens: 256,
  system: [
    { type: "text", text: billingLine },
    { type: "text", text: identity, cache_control: { type: "ephemeral" } },
    { type: "text", text: instructions, cache_control: { type: "ephemeral" } },
  ],
  messages: [{ role: "user", content: "What is the secret word?" }],
}

// Starts a mock Copilot that advertises `endpoints` for `model`, and a relay in front of it.
const startRelay = async (
  t: import("node:test").TestContext,
  model: string,
  endpoints: Array<string>,
  claudeUpstreamApi?: "messages",
) => {
  const requests: Array<UpstreamRequest> = []
  const upstream = createHttpServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
    }

    requests.push({ path: req.url ?? "", raw, body: raw ? JSON.parse(raw) : {} })
    res.setHeader("content-type", "application/json")

    if (req.url === "/v1/messages") {
      res.end(JSON.stringify({
        id: "msg_billing_line",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: answer }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      }))
      return
    }

    if (req.url === "/responses") {
      res.end(JSON.stringify({
        id: "resp_billing_line",
        model,
        created_at: 1,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }))
      return
    }

    res.end(JSON.stringify({
      id: "chat_billing_line",
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
    ...(claudeUpstreamApi && { claudeUpstreamApi }),
    modelCatalog: { baseUrl, models: new Map([[model, { supportedEndpoints: endpoints }]]) },
  })

  const post = (route: string, body: unknown) => app.fetch(new Request(`http://localhost${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))

  return { requests, post }
}

// Sends claudeRequest through the relay and returns the one request it sent upstream.
const relayOnce = async (
  t: import("node:test").TestContext,
  model: string,
  endpoints: Array<string>,
  claudeUpstreamApi?: "messages",
): Promise<UpstreamRequest> => {
  const { requests, post } = await startRelay(t, model, endpoints, claudeUpstreamApi)
  const response = await post("/v1/messages", claudeRequest)

  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json() as { content: Array<{ text?: string }> }).content[0]?.text, answer)
  assert.equal(requests.length, 1)

  const [request] = requests
  assert(request)
  assert.equal(request.raw.includes("x-anthropic-billing-header"), false)
  return request
}

test("a Claude model on the chat route gets its system prompt without the billing line", async (t) => {
  const request = await relayOnce(t, "claude-opus-5.5", ["/chat/completions"])

  assert.equal(request.path, "/chat/completions")
  assert.deepEqual(request.body.messages[0], {
    role: "system",
    content: `${identity}\n\n${instructions}`,
    copilot_cache_control: { type: "ephemeral" },
  })
})

test("a /responses model gets its system prompt without the billing line", async (t) => {
  const request = await relayOnce(t, "gpt-6-astra", ["/responses"])

  assert.equal(request.path, "/responses")
  assert.ok(request.raw.includes(identity))
  assert.ok(request.raw.includes(instructions))
})

test("the native route forwards the other system blocks with their cache marks", async (t) => {
  const request = await relayOnce(t, "claude-opus-5.5", ["/v1/messages"], "messages")

  assert.equal(request.path, "/v1/messages")
  assert.deepEqual(request.body.system, claudeRequest.system.slice(1))
})

test("count_tokens counts the system prompt without the billing line", async (t) => {
  const { requests, post } = await startRelay(t, "claude-opus-5.5", ["/chat/completions"])
  const count = async (body: unknown): Promise<number> => {
    const response = await post("/v1/messages/count_tokens", body)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json() as { input_tokens: number }).input_tokens
  }

  const withLine = await count(claudeRequest)
  const withoutLine = await count({ ...claudeRequest, system: claudeRequest.system.slice(1) })
  const withoutSystem = await count({ ...claudeRequest, system: undefined })

  assert.equal(withLine, withoutLine)
  assert.ok(withLine > withoutSystem)
  assert.equal(requests.length, 0)
})
