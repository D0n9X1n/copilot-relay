import assert from "node:assert/strict"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import test from "node:test"

import { createServer } from "../../src/server"
import type { ProxyConfig } from "../../src/lib/config"
import { runtimeState } from "../../src/lib/state"

interface CapturedRequest {
  body: unknown
  path: string
}

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  let body = ""
  for await (const chunk of request) {
    body += String(chunk)
  }
  return body ? JSON.parse(body) as unknown : undefined
}

const startMockCopilot = async () => {
  const requests: Array<CapturedRequest> = []
  const server = createHttpServer(async (request, response) => {
    const path = request.url ?? "/"
    const body = await readJsonBody(request)
    requests.push({ body, path })

    response.setHeader("content-type", "application/json")

    if (path === "/models") {
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: "gpt-5.5" }, { id: "claude-opus-4.8" }],
      }))
      return
    }

    if (path === "/chat/completions") {
      const payload = body as { model?: string }
      response.end(JSON.stringify({
        id: "chat_1",
        created: 1,
        model: payload.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
      return
    }

    if (path === "/responses") {
      const payload = body as { model?: string }
      response.end(JSON.stringify({
        id: "resp_1",
        created_at: 1,
        model: payload.model,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "OK" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }))
      return
    }

    response.statusCode = 404
    response.end(JSON.stringify({ error: "not found" }))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  assert.ok(address && typeof address === "object")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
    requests,
  }
}

const createTestProxy = (baseUrl: string) => {
  const config: ProxyConfig = {
    copilotBaseUrl: baseUrl,
    copilotToken: "test-token",
    host: "127.0.0.1",
    port: 0,
    vsCodeVersion: "1.99.3",
  }
  return createServer(config)
}

test.beforeEach(() => {
  runtimeState.thinkEffort = "xhigh"
  runtimeState.modelRouting = {
    gptModel: "gpt-5.5",
    opusModel: "claude-opus-4.8",
  }
})

test.afterEach(() => {
  delete runtimeState.thinkEffort
  delete runtimeState.modelRouting
})

// Why: Claude Code and humans can probe available models before sending a
// message. This scenario verifies the public model list is served locally from
// runtime config and does not need a real Copilot network call.
test("GET /v1/models returns configured Claude Code models", async () => {
  const mock = await startMockCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)
    const response = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await response.json() as { data: Array<{ id: string }> }

    assert.equal(response.status, 200)
    assert.deepEqual(body.data.map((model) => model.id), [
      "gpt-5.5",
      "claude-opus-4.8",
    ])
  } finally {
    await mock.close()
  }
})

// Why: Opus is the special Claude Code path. This scenario exercises the full
// local HTTP route, Claude-to-Copilot translation, upstream mock, and response
// translation while asserting the upstream model and effective effort.
test("POST /v1/messages routes opus requests to configured opus model", async () => {
  const mock = await startMockCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      body: JSON.stringify({
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply OK only." }],
        model: "opus",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const body = await response.json() as { content: Array<{ text?: string }> }

    assert.equal(response.status, 200)
    assert.equal(body.content[0]?.text, "OK")

    const upstream = mock.requests.find((request) => request.path === "/chat/completions")
    if (!upstream) {
      throw new Error("Expected /chat/completions upstream request")
    }
    assert.equal((upstream.body as { model?: string }).model, "claude-opus-4.8")
    assert.equal((upstream.body as { reasoning_effort?: string }).reasoning_effort, "xhigh")
  } finally {
    await mock.close()
  }
})

// Why: every non-Opus requested model should still work by routing to GPT.
// This scenario protects the default fallback path and verifies GPT requests
// use Copilot's Responses API shape with reasoning.effort.
test("POST /v1/messages routes non-opus requests to configured gpt model", async () => {
  const mock = await startMockCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      body: JSON.stringify({
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply OK only." }],
        model: "default",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const body = await response.json() as { content: Array<{ text?: string }> }

    assert.equal(response.status, 200)
    assert.equal(body.content[0]?.text, "OK")

    const upstream = mock.requests.find((request) => request.path === "/responses")
    if (!upstream) {
      throw new Error("Expected /responses upstream request")
    }
    assert.equal((upstream.body as { model?: string }).model, "gpt-5.5")
    assert.equal(
      ((upstream.body as { reasoning?: { effort?: string } }).reasoning)?.effort,
      "xhigh",
    )
  } finally {
    await mock.close()
  }
})

// Why: Anthropic server-side WebSearch cannot be executed by the Copilot
// upstream. The relay must fail loudly before the model can fabricate search
// results that look like a successful tool response.
test("POST /v1/messages rejects unsupported Claude server-side WebSearch", async () => {
  const mock = await startMockCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      body: JSON.stringify({
        max_tokens: 16,
        messages: [{ role: "user", content: "search the web for copilot docs" }],
        model: "opus",
        tools: [
          {
            name: "web_search",
            type: "web_search_20250305",
            max_uses: 1,
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const body = await response.json() as { error?: { message?: string } }

    assert.equal(response.status, 501)
    assert.match(body.error?.message ?? "", /WebSearch/)
    assert.equal(mock.requests.length, 0)
  } finally {
    await mock.close()
  }
})

// Why: Claude Code may probe new Anthropic-compatible endpoints before the
// relay implements them. Returning a structured 404 while logging the payload
// gives us the API shape needed for a later implementation.
test("unknown Claude API routes return structured 404", async () => {
  const app = createTestProxy("http://127.0.0.1:1")
  const response = await app.fetch(new Request("http://localhost/v1/unknown_endpoint", {
    body: JSON.stringify({ model: "opus", input: "capture this shape" }),
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    method: "POST",
  }))
  const body = await response.json() as { error?: { message?: string } }

  assert.equal(response.status, 404)
  assert.equal(body.error?.message, "Unknown Claude API route")
})
