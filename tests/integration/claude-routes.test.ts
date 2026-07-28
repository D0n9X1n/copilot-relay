import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// paths.ts resolves the log directory from os.homedir() at import time, and
// these tests exercise the real server, which logs. Without this redirect the
// suite appends to the developer's live ~/.copilot-relay/logs on every run.
// Static imports hoist above assignments, so the module graph must load via
// dynamic import after the home directory is set. Node reads HOME on POSIX and
// USERPROFILE on Windows, and CI runs windows-latest, so both are set.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-itest-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { createServer } = await import("../../src/server")
const { runtimeState } = await import("../../src/lib/state")
type ProxyConfig = import("../../src/lib/config").ProxyConfig

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})

interface CapturedRequest {
  body: unknown
  path: string
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

const startDelayedStreamingCopilot = async () => {
  let releaseResponse: () => void = () => {}
  const responseCanFinish = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  const requests: Array<CapturedRequest> = []
  const server = createHttpServer(async (request, response) => {
    const path = request.url ?? "/"
    const body = await readJsonBody(request)
    requests.push({ body, path })

    if (path !== "/chat/completions") {
      response.statusCode = 404
      response.end(JSON.stringify({ error: "not found" }))
      return
    }

    await responseCanFinish
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(`data: ${JSON.stringify({
      id: "chat_stream_1",
      created: 1,
      model: "claude-opus-4.8",
      choices: [
        {
          index: 0,
          delta: { content: "OK" },
          finish_reason: null,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: "chat_stream_1",
      created: 1,
      model: "claude-opus-4.8",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`)
    response.write("data: [DONE]\n\n")
    response.end()
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
    releaseResponse,
    requests,
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
        stream?: boolean
        tools?: Array<{ function?: { name?: string } }>
      }
      // Real Copilot honors the stream flag. The relay branches on what it
      // asked for, not on what came back, so a mock that always returns JSON
      // would make a streamed request silently yield nothing.
      const writeSse = (...payloadObjects: Array<unknown>) => {
        response.setHeader("content-type", "text/event-stream")
        for (const payloadObject of payloadObjects) {
          response.write(`data: ${JSON.stringify(payloadObject)}\n\n`)
        }
        response.write("data: [DONE]\n\n")
        response.end()
      }
      // A real model selects web_search based on intent, not on the tool merely
      // being advertised. Gating on intent lets a test represent the common
      // Claude Code case: WebSearch is offered every turn and used on few.
      const messagesText = JSON.stringify(
        (body as { messages?: unknown }).messages ?? [],
      )
      const webSearchTool =
        /search/i.test(messagesText) ?
          payload.tools?.find(
            (tool) =>
              tool.function?.name === "web_search"
              || tool.function?.name === "WebSearch",
          )
        : undefined
      if (webSearchTool) {
        webSearchChatCalls += 1
        const toolCallId = `call_web_search_${webSearchChatCalls}`
        if (payload.stream) {
          // Real Copilot writes a preamble before calling the tool. Emitting the
          // tool call alone would let a classifier that mistakes text for "no
          // search coming" pass this test while leaking a client tool_use named
          // WebSearch on live traffic.
          writeSse(
            {
              id: "chat_web_search_call",
              object: "chat.completion.chunk",
              created: 1,
              model: payload.model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "I'll search for that now." },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chat_web_search_call",
              object: "chat.completion.chunk",
              created: 1,
              model: payload.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: toolCallId,
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
            },
          )
          return
        }
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

      // The recompose pass after a search. Emitting a client tool call here is
      // the behavior #37 made impossible: with no tools on the wire the model
      // could only describe what it intended to do. Non-streaming only: the
      // recompose pass is always buffered, so a streamed request that reaches
      // here is an ordinary turn and should fall through to the text response.
      const clientTool =
        payload.stream ? undefined : (
          payload.tools?.find((tool) => tool.function?.name === "Write")
        )
      if (clientTool) {
        response.end(JSON.stringify({
          id: "chat_client_tool_call",
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
                    id: "call_write_1",
                    type: "function",
                    function: {
                      name: "Write",
                      arguments: JSON.stringify({ path: "out.md" }),
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

      if (payload.stream) {
        writeSse({
          id: "chat_1",
          object: "chat.completion.chunk",
          created: 1,
          model: payload.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
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
    upstreamTimeoutMs: 180_000,
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
    assert.match(
      response.headers.get("x-copilot-relay-request-id") ?? "",
      uuidPattern,
    )
    assert.deepEqual(body.data.map((model) => model.id), [
      "gpt-5.5",
      "claude-opus-4.8",
    ])
  } finally {
    await mock.close()
  }
})

// Why: [1m] is a Claude Code context selector, not a Copilot model ID. The
// public list should expose it, while the full Messages-to-Responses path must
// strip it and preserve the configured max effort before touching Copilot.
test("advertises the 1M GPT identity but sends its canonical model upstream", async () => {
  const mock = await startMockCopilot()
  runtimeState.thinkEffort = "max"
  runtimeState.modelRouting = {
    gptModel: "gpt-5.6-sol",
    opusModel: "claude-opus-4.8",
  }

  try {
    const app = createTestProxy(mock.baseUrl)
    const modelsResponse = await app.fetch(new Request("http://localhost/v1/models"))
    const models = await modelsResponse.json() as { data: Array<{ id: string }> }
    assert.deepEqual(models.data.map((model) => model.id), [
      "gpt-5.6-sol[1m]",
      "claude-opus-4.8",
    ])

    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      body: JSON.stringify({
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply OK only." }],
        model: "gpt-5.6-sol[1m]",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const body = await response.json() as {
      content: Array<{ text?: string }>
      model?: string
    }

    assert.equal(response.status, 200)
    assert.equal(body.content[0]?.text, "OK")
    assert.equal(body.model, "gpt-5.6-sol[1m]")
    const upstreamModels = mock.requests.flatMap((request) => {
      if (request.path !== "/responses" && request.path !== "/chat/completions") {
        return []
      }
      return [(request.body as { model?: string }).model]
    })
    assert.deepEqual(upstreamModels, ["gpt-5.6-sol"])
    assert.equal(
      ((mock.requests.find((request) => request.path === "/responses")?.body as {
        reasoning?: { effort?: string }
      })?.reasoning)?.effort,
      "max",
    )
    assert.equal(upstreamModels.some((model) => model?.includes("[1m]")), false)

    const plainResponse = await app.fetch(new Request("http://localhost/v1/messages", {
      body: JSON.stringify({
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply OK only." }],
        model: "gpt-5.6-sol",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    assert.equal(plainResponse.status, 200)
    assert.equal(
      (mock.requests.at(-1)?.body as { model?: string }).model,
      "gpt-5.6-sol",
    )
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
    const makeRequest = (content: string, includeAssistantPrefill = false) =>
      app.fetch(new Request("http://localhost/v1/messages", {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [
            { role: "user", content },
            ...includeAssistantPrefill ?
              [{ role: "assistant" as const, content: "partial retry answer" }]
            : [],
          ],
          model: "opus",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))

    const first = makeRequest("first request waits upstream")
    const second = makeRequest("second request should still forward", true)

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
    const secondUpstreamRequest = requests.filter(
      (entry) => entry.path === "/chat/completions",
    )[1]?.body as {
      messages?: Array<{ content?: string; role?: string }>
    }
    assert.equal(secondUpstreamRequest.messages?.at(-2)?.role, "assistant")
    assert.equal(secondUpstreamRequest.messages?.at(-1)?.role, "user")
    assert.match(
      secondUpstreamRequest.messages?.at(-1)?.content ?? "",
      /Continue the assistant response/,
    )
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
    // The native web_search schema arrives on Claude Code's nested search call,
    // which carries no other tools, so there is nothing left to advertise here.
    assert.equal(finalRequest.tools, undefined)
    assert.equal(finalRequest.messages?.at(-1)?.role, "user")
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

// Why: Claude Code can cancel requests after 60s before response headers. The
// relay should open local SSE immediately, but it must not emit synthetic ping
// events before real upstream content because some clients reject them.
test("POST /v1/messages streaming opens before delayed upstream without ping", async () => {
  const mock = await startDelayedStreamingCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)
    const response = await withTimeout(
      Promise.resolve(app.fetch(new Request("http://localhost/v1/messages", {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply OK only." }],
          model: "opus",
          stream: true,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))),
      500,
      "Streaming response did not open before upstream responded",
    )

    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)

    const reader = response.body?.getReader()
    assert.ok(reader)
    const pendingRead = reader.read()
    await assert.rejects(
      withTimeout(
        pendingRead,
        100,
        "No early SSE payload before upstream responded",
      ),
      /No early SSE payload/,
    )

    mock.releaseResponse()
    const firstChunk = await withTimeout(
      pendingRead,
      1_000,
      "Streaming response did not send upstream content after upstream responded",
    )
    assert.equal(firstChunk.done, false)
    const chunks: Array<string> = [new TextDecoder().decode(firstChunk.value)]
    while (true) {
      const chunk = await withTimeout(
        reader.read(),
        1_000,
        "Streaming response did not finish after upstream responded",
      )
      if (chunk.done) {
        break
      }
      chunks.push(new TextDecoder().decode(chunk.value))
    }

    assert.match(chunks.join(""), /event: message_stop/)
    assert.equal(mock.requests[0]?.path, "/chat/completions")
  } finally {
    mock.releaseResponse()
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

// Why: regression coverage for #37. Claude Code advertises WebSearch alongside
// its own tools, and the relay's recompose pass used to send `tools: undefined`,
// so the model could not emit a tool_use block and every search turn ended as an
// unactioned plan. The recompose request must keep the client's tools, drop only
// the search tool, and end on a user message so Copilot's Claude-family models
// accept it.
test("POST /v1/messages keeps client tools usable after a WebSearch turn", async () => {
  const mock = await startMockCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      body: JSON.stringify({
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content: "search the web for copilot docs then write a summary file",
          },
        ],
        model: "opus",
        tools: [
          { name: "WebSearch", input_schema: { type: "object" } },
          { name: "Write", input_schema: { type: "object" } },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const body = await response.json() as {
      content: Array<{ name?: string; type: string }>
      stop_reason?: string
    }
    const finalRequest = mock.requests[2]?.body as {
      messages?: Array<{ content?: string; role?: string }>
      tool_choice?: unknown
      tools?: Array<{ function?: { name?: string } }>
    }

    assert.equal(response.status, 200)
    assert.equal(mock.requests.length, 3)

    // The recompose pass keeps Write and drops only WebSearch.
    assert.deepEqual(
      finalRequest.tools?.map((tool) => tool.function?.name),
      ["Write"],
    )
    assert.equal(finalRequest.messages?.at(-1)?.role, "user")
    assert.match(
      finalRequest.messages?.at(-1)?.content ?? "",
      /Trusted bridge retrieval context/,
    )

    // The model can now act on what it found, in the same turn.
    assert.equal(body.content.at(-1)?.type, "tool_use")
    assert.equal(body.content.at(-1)?.name, "Write")
    assert.equal(body.stop_reason, "tool_use")
    assert.equal(body.content[0]?.type, "server_tool_use")
    assert.equal(body.content[1]?.type, "web_search_tool_result")
  } finally {
    await mock.close()
  }
})

// Why: Claude Code probes /api/hello on startup and around real traffic. The
// relay used to answer 500 from the unsupported-route handler. The call site
// that reaches us discards its result, but a sibling call site in the same CLI
// gates on status !== 200 and exits the process, so answering 200 removes a
// hard-failure mode that is one refactor away. Static by design: it must not
// contact Copilot, for the same reason /healthz does not.
test("HEAD and GET /api/hello return 200 without contacting upstream", async () => {
  const mock = await startMockCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)

    const head = await app.fetch(new Request("http://localhost/api/hello", {
      method: "HEAD",
    }))
    const get = await app.fetch(new Request("http://localhost/api/hello"))

    assert.equal(head.status, 200)
    assert.equal(get.status, 200)
    assert.equal(mock.requests.length, 0)
  } finally {
    await mock.close()
  }
})

// Why: regression coverage for #40. Advertising WebSearch used to force
// `stream: false` on the decision pass, even when the model never selected it.
// Claude Code advertises WebSearch by default, so most streaming turns paid for
// a full non-streaming completion that was then replayed as synthetic SSE. The
// decision pass must now go upstream as a real stream.
test("POST /v1/messages streams turns that advertise WebSearch but do not use it", async () => {
  const mock = await startMockCopilot()
  try {
    const app = createTestProxy(mock.baseUrl)
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      body: JSON.stringify({
        max_tokens: 16,
        // WebSearch is advertised, as Claude Code does on every turn, but the
        // prompt carries no search intent so the model never selects it.
        messages: [{ role: "user", content: "say OK" }],
        model: "opus",
        stream: true,
        tools: [
          { name: "WebSearch", input_schema: { type: "object" } },
          { name: "Write", input_schema: { type: "object" } },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    const text = await response.text()
    const upstream = mock.requests[0]?.body as { stream?: boolean }

    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    // The decision pass went upstream as a stream, not a buffered completion.
    assert.equal(upstream.stream, true)
    // Exactly one upstream call: no search, no recompose pass.
    assert.equal(mock.requests.length, 1)
    assert.match(text, /"type":"message_start"/)
    assert.match(text, /"type":"message_stop"/)
  } finally {
    await mock.close()
  }
})
