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

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

const startMockCopilot = async () => {
  const requests: Array<CapturedRequest> = []
  let webSearchChatCalls = 0
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
      const payload = body as {
        model?: string
        tools?: Array<{ function?: { name?: string } }>
      }
      const webSearchTool = payload.tools?.find(
        (tool) =>
          tool.function?.name === "web_search"
          || tool.function?.name === "WebSearch",
      )
      if (webSearchTool) {
        webSearchChatCalls += 1
        response.end(JSON.stringify({
          id: "chat_web_search_call",
          created: 1,
          model: payload.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_web_search_${webSearchChatCalls}`,
                    type: "function",
                    function: {
                      name: webSearchTool.function?.name,
                      arguments: JSON.stringify({ query: "GitHub Copilot docs" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
        return
      }

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
      const payload = body as {
        model?: string
        tools?: Array<{ type?: string }>
      }
      if (payload.tools?.some((tool) => tool.type === "web_search_preview")) {
        response.end(JSON.stringify({
          id: "resp_web_search",
          created_at: 1,
          model: payload.model,
          output: [
            {
              type: "web_search_call",
              action: {
                type: "search",
                query: "GitHub Copilot docs",
                queries: ["GitHub Copilot docs"],
              },
            },
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text:
                    "1. GitHub Copilot documentation - https://docs.github.com/en/copilot",
                },
              ],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
        }))
        return
      }

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

// Why: one slow upstream request must not serialize the relay. Claude Code can
// issue multiple model requests at once, so the server needs to accept and
// forward later requests even while an earlier upstream response is still open.
test("POST /v1/messages forwards concurrent requests without waiting for earlier responses", async () => {
  const requests: Array<CapturedRequest> = []
  let releaseFirstResponse: () => void = () => {}
  let sawSecondRequest: () => void = () => {}
  const firstResponseCanFinish = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve
  })
  const secondRequestArrived = new Promise<void>((resolve) => {
    sawSecondRequest = resolve
  })
  let chatRequestCount = 0
  const server = createHttpServer(async (request, response) => {
    const path = request.url ?? "/"
    const body = await readJsonBody(request)
    requests.push({ body, path })
    response.setHeader("content-type", "application/json")

    if (path !== "/chat/completions") {
      response.statusCode = 404
      response.end(JSON.stringify({ error: "not found" }))
      return
    }

    chatRequestCount += 1
    const requestNumber = chatRequestCount
    const payload = body as { model?: string }
    if (requestNumber === 1) {
      await firstResponseCanFinish
    } else if (requestNumber === 2) {
      sawSecondRequest()
    }

    response.end(JSON.stringify({
      id: `chat_${requestNumber}`,
      created: 1,
      model: payload.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: `OK ${requestNumber}` },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")

  const close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })

  try {
    const app = createTestProxy(`http://127.0.0.1:${address.port}`)
    const makeRequest = (content: string) =>
      app.fetch(new Request("http://localhost/v1/messages", {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [{ role: "user", content }],
          model: "opus",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))

    const first = makeRequest("first request waits upstream")
    const second = makeRequest("second request should still forward")

    await withTimeout(
      secondRequestArrived,
      1000,
      "Second request was not forwarded while the first upstream response was pending",
    )

    const secondBody = await (await second).json() as {
      content: Array<{ text?: string }>
    }
    assert.equal(secondBody.content[0]?.text, "OK 2")

    releaseFirstResponse()
    const firstBody = await (await first).json() as {
      content: Array<{ text?: string }>
    }
    assert.equal(firstBody.content[0]?.text, "OK 1")
    assert.equal(requests.filter((entry) => entry.path === "/chat/completions").length, 2)
  } finally {
    releaseFirstResponse()
    await close()
  }
})

// Why: Anthropic server-side WebSearch must be executed by the relay because
// Copilot cannot handle that Claude server-side tool directly. The route should
// run search through Copilot Responses web_search_preview, then send the
// retrieved context through a final model pass and return Claude-shaped server
// tool blocks.
test("POST /v1/messages handles Claude server-side WebSearch", async () => {
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
    const body = await response.json() as {
      content: Array<{
        content?: Array<{ title?: string; type?: string; url?: string }>
        input?: { query?: string }
        name?: string
        text?: string
        type: string
      }>
      usage?: { server_tool_use?: { web_search_requests?: number } }
    }
    const decisionRequest = mock.requests[0]?.body as {
      stream?: boolean
      tools?: Array<{ function?: { name?: string } }>
    }
    const searchRequest = mock.requests[1]?.body as {
      model?: string
      tools?: Array<{ type?: string }>
    }
    const finalRequest = mock.requests[2]?.body as {
      messages?: Array<{ content?: string; role?: string }>
      tools?: unknown
    }

    assert.equal(response.status, 200)
    assert.equal(mock.requests.length, 3)
    assert.equal(mock.requests[0]?.path, "/chat/completions")
    assert.equal(decisionRequest.stream, false)
    assert.equal(decisionRequest.tools?.[0]?.function?.name, "web_search")
    assert.equal(mock.requests[1]?.path, "/responses")
    assert.equal(searchRequest.model, "gpt-5.5")
    assert.deepEqual(searchRequest.tools, [{ type: "web_search_preview" }])
    assert.equal(mock.requests[2]?.path, "/chat/completions")
    assert.equal(finalRequest.tools, undefined)
    assert.equal(finalRequest.messages?.at(-1)?.role, "system")
    assert.match(finalRequest.messages?.at(-1)?.content ?? "", /Trusted bridge retrieval context/)
    assert.equal(body.content[0]?.type, "server_tool_use")
    assert.equal(body.content[0]?.name, "web_search")
    assert.equal(body.content[0]?.input?.query, "GitHub Copilot docs")
    assert.equal(body.content[1]?.type, "web_search_tool_result")
    assert.deepEqual(body.content[1]?.content, [
      {
        type: "web_search_result",
        title: "GitHub Copilot documentation",
        url: "https://docs.github.com/en/copilot",
        encrypted_content: "",
        page_age: null,
      },
    ])
    assert.equal(body.content[2]?.text, "OK")
    assert.equal(body.usage?.server_tool_use?.web_search_requests, 1)
  } finally {
    await mock.close()
  }
})

test("POST /v1/messages streams Claude WebSearch response events", async () => {
  const mock = await startMockCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      body: JSON.stringify({
        max_tokens: 16,
        messages: [{ role: "user", content: "search the web for copilot docs" }],
        model: "opus",
        stream: true,
        tools: [
          {
            name: "WebSearch",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const text = await response.text()

    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    assert.match(text, /"type":"server_tool_use"/)
    assert.match(text, /"type":"web_search_tool_result"/)
    assert.match(text, /"type":"input_json_delta"/)
  } finally {
    await mock.close()
  }
})

// Why: Claude Code may probe new Anthropic-compatible endpoints before the
// relay implements them. Returning a structured 500 while logging the payload
// makes unsupported API usage explicit and gives us the shape needed later.
test("unsupported Claude API routes return structured 500", async () => {
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

  assert.equal(response.status, 500)
  assert.equal(body.error?.message, "Unsupported Claude API route")
})
