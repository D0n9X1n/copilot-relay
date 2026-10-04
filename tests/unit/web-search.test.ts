import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { WebSearchExecutionResult } from "../../src/claude/web-search"
import type { ClaudeMessagesPayload, ClaudeTool } from "../../src/claude/types"
import type { ChatCompletionsPayload, Message } from "../../src/copilot/types"
import type { CopilotModel } from "../../src/copilot/models"
import type { ProxyConfig } from "../../src/lib/config"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-search-test-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.CONSOLA_LEVEL = "0"

const {
  createClaudeWebSearchExecution,
  createClaudeWebSearchResponse,
  createFinalWebSearchPayload,
  getWebSearchBackendModel,
} = await import("../../src/claude/web-search")
const { createClaudeToolNameMapper } = await import("../../src/claude/tool-names")
const { HTTPError } = await import("../../src/lib/error")
const { registerSensitiveOrigin } = await import("../../src/lib/redact")
const { log, setLogLevel, flushLogs } = await import("../../src/lib/log")
const { getLogPath } = await import("../../src/lib/paths")

test.after(async () => {
  await flushLogs()
  await fs.rm(tempHome, { recursive: true, force: true })
})

test("search retrieval honors its backend capabilities without turning into ordinary chat", async () => {
  const { withRecordedTransport } = await import("../../src/lib/request-trace")
  const config = { ...createConfig("https://search-capabilities.invalid"), webSearchBackend: "future-search" }
  const withBackend = (capabilities: CopilotModel) => ({
    ...config,
    modelCatalog: { baseUrl: config.copilotBaseUrl, models: new Map([["future-search", capabilities]]) },
  })
  const sent: Array<{ path: string; body: Record<string, any> }> = []

  await withRecordedTransport({
    fetch: async (request) => {
      sent.push({ path: request.path, body: JSON.parse(request.body!) })
      return Response.json({ id: "resp_search", model: "future-search", status: "completed", output: [] })
    },
    refresh: async () => {},
  }, async () => {
    // Backends without the Responses endpoint fail locally instead of becoming ordinary chat.
    for (const supportedEndpoints of [["/chat/completions"], [], ["/future"]]) {
      const result = await createClaudeWebSearchExecution(withBackend({ supportedEndpoints }), payload, "fixture query")
      assert.match(result.text, /Responses endpoint/)
    }

    assert.equal(sent.length, 0)

    // A no-effort backend omits the implicit default but still rejects explicit effort.
    const noEffortBackend = withBackend({ supportedEndpoints: ["/responses"], reasoningEfforts: [] })
    await createClaudeWebSearchExecution(noEffortBackend, payload, "fixture query")

    assert.equal(sent.length, 1)
    assert.equal(sent[0].path, "/responses")
    assert.deepEqual(sent[0].body.tools, [{ type: "web_search_preview" }])
    assert.equal(sent[0].body.reasoning, undefined)

    const explicitPayload: ClaudeMessagesPayload = { ...payload, output_config: { effort: "low" } }
    const explicit = await createClaudeWebSearchExecution(noEffortBackend, explicitPayload, "fixture query")

    assert.match(explicit.text, /reasoning effort/)
    assert.equal(sent.length, 1)
  })
})

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

const createConfig = (baseUrl: string): ProxyConfig => ({
  copilotBaseUrl: baseUrl,
  copilotToken: "test-token",
  host: "127.0.0.1",
  port: 0,
  upstreamTimeoutMs: 180_000,
  vsCodeVersion: "1.99.3",
})

const payload: ClaudeMessagesPayload = {
  max_tokens: 64,
  messages: [{ role: "user", content: "search the web for copilot docs" }],
  model: "opus",
}

const startWebSearchMockCopilot = async () => {
  const requests: Array<CapturedRequest> = []
  const server = createHttpServer(async (request, response) => {
    const path = request.url ?? "/"
    const body = await readJsonBody(request)
    requests.push({ body, path })

    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      id: "resp_web_search",
      created_at: 1,
      model: "gpt-5.5",
      output: [
        {
          type: "web_search_call",
          action: {
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
              text: "1. GitHub Copilot docs - https://docs.github.com/en/copilot",
            },
          ],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    }))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      }),
    requests,
  }
}

// Serves the replies in order, repeating the last one, and counts attempts so a
// test can see whether the client retried.
const withSearchResponses = async (
  replies: Array<{ status: number; body: string }>,
  run: (baseUrl: string, attempts: () => number) => Promise<void>,
) => {
  let attempts = 0
  const server = createHttpServer(async (request, response) => {
    await readJsonBody(request)
    const reply = replies[Math.min(attempts++, replies.length - 1)]!
    response.writeHead(reply.status)
    response.end(reply.body)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")

  try {
    await run(`http://127.0.0.1:${address.port}`, () => attempts)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

for (const [status, category] of [
  [503, "service unavailable"],
  [500, "server failure"],
  [429, "rate limited"],
  [401, "authentication rejected"],
  [403, "access denied"],
  [400, "request failed"],
  [404, "request failed"],
] as const) {
  test(`WebSearch preserves HTTP ${status} without guessing model support`, async () => {
    await withSearchResponses([{ status, body: "Please try again later." }], async (baseUrl, attempts) => {
      const search = await createClaudeWebSearchExecution(
        { ...createConfig(baseUrl), webSearchBackend: "gpt-6-astra" }, payload, "public query",
      )

      assert.match(search.text, new RegExp(`HTTP ${status}`))
      assert.ok(search.text.includes(category))
      assert.match(search.text, /gpt-6-astra/)
      assert.match(search.text, /Please try again later\./)
      assert.doesNotMatch(search.text, /not available for model|token expired/)
      // Only a server error is retried, and only once.
      assert.equal(attempts(), status >= 500 ? 2 : 1)
      assert.deepEqual(search.results, [])

      const result = createClaudeWebSearchResponse(search).content[1]
      assert.deepEqual(result && "content" in result ? result.content : undefined, {
        type: "web_search_tool_result_error", error_code: "unavailable",
      })
    })
  })
}

for (const [name, body, expected] of [
  ["JSON message", JSON.stringify({ error: { message: "web_search_preview is unsupported", code: "unknown_capability" }, request: { prompt: "PRIVATE_CONTEXT" } }), "web_search_preview is unsupported"],
  ["JSON code", JSON.stringify({ error: { code: "invalid_request" } }), "invalid_request"],
  ["empty", "", ""],
  ["malformed JSON", '{"error": PRIVATE_CONTEXT', ""],
  ["unrecognized JSON", JSON.stringify({ request: { prompt: "PRIVATE_CONTEXT" } }), ""],
  ["non-string message", JSON.stringify({ error: { message: { prompt: "PRIVATE_CONTEXT" } } }), ""],
  ["terminal controls", "\x1b[31mBusy\x1b[0m\nTry later", "BusyTry later"],
  ["bounded text", "x".repeat(400), "x".repeat(240)],
  ["credential after display limit", `${"x".repeat(300)} Authorization: Bearer PRIVATE_CONTEXT`, ""],
  ["JSON credential", JSON.stringify({ error: { message: "Authorization: Bearer PRIVATE_CONTEXT" } }), ""],
  ["configured token", "Rejected test-token", "Rejected [redacted]"],
  ["authorization", "Authorization: Bearer PRIVATE_CONTEXT", ""],
  ["token assignment", "api_key=PRIVATE_CONTEXT", ""],
  ["GitHub token", "Rejected ghp_PRIVATE_CONTEXT", ""],
  ["request echo", 'Request payload: {"messages":[{"content":"PRIVATE_CONTEXT"}]}', ""],
  ["credential URL", "See https://user:PRIVATE_CONTEXT@example.com/help?token=PRIVATE_CONTEXT", "See https://example.com/[redacted]"],
  ["sensitive origin", "See https://search-secret.example/PRIVATE_CONTEXT", "See [redacted]"],
] as const) {
  test(`WebSearch safely renders ${name} diagnostics`, async () => {
    registerSensitiveOrigin("https://search-secret.example/secret")
    await withSearchResponses([{ status: 400, body }], async (baseUrl) => {
      const search = await createClaudeWebSearchExecution(createConfig(baseUrl), payload, "public query")

      assert.match(search.text, /HTTP 400/)
      assert.doesNotMatch(search.text, /PRIVATE_CONTEXT|test-token|\x1b/)
      const detail = search.text.split("\nUpstream response: ")[1] ?? ""
      assert.equal(detail, expected)
      assert.doesNotMatch(search.text, /not available for model/)
    })
  })
}

test("WebSearch recovers after a transient HTTP 503 with its existing retry", async () => {
  await withSearchResponses([
    { status: 503, body: "Busy" },
    {
      status: 200,
      body: JSON.stringify({
        id: "search_recovered", model: "gpt-6-astra",
        output: [{ type: "message", content: [{ type: "output_text", text: "1. Docs - https://example.com/docs" }] }],
      }),
    },
  ], async (baseUrl, attempts) => {
    const search = await createClaudeWebSearchExecution(createConfig(baseUrl), payload, "public query")

    assert.equal(attempts(), 2)
    assert.equal(search.results[0]?.url, "https://example.com/docs")
    assert.doesNotMatch(search.text, /HTTP 503/)
  })
})

test("successful empty WebSearch remains distinct from an HTTP error", async () => {
  await withSearchResponses([{ status: 200, body: JSON.stringify({ id: "empty", model: "gpt-6-astra", output: [] }) }], async (baseUrl, attempts) => {
    const search = await createClaudeWebSearchExecution(createConfig(baseUrl), payload, "public query")

    assert.equal(search.text, "Copilot web search returned no usable results (response status unreported; no extractable text or sources).")
    assert.equal(attempts(), 1)
  })
})

const searchMessage = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] })

for (const [name, fields, diagnostic] of [
  ["completed empty", { status: "completed", output: [] }, /completed without extractable text or sources/],
  ["reasoning only", { status: "completed", output: [{ type: "reasoning", summary: [{ text: "PRIVATE_REASONING" }] }] }, /completed without extractable text or sources/],
  ["search call only", { status: "completed", output: [{ type: "web_search_call", status: "completed" }] }, /completed without extractable text or sources/],
  ["incomplete budget", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [searchMessage("Partial - https://example.com/partial")] }, /incomplete \(max_output_tokens\)/],
  ["incomplete unknown reason", { status: "incomplete", incomplete_details: { reason: "PRIVATE_REASON" }, output: [] }, /incomplete \(unknown\)/],
  ["failed", { status: "failed", error: { message: "PRIVATE_ERROR" }, output: [searchMessage("Partial - https://example.com/partial")] }, /response failed/],
  ["cancelled", { status: "cancelled", output: [] }, /response cancelled/],
  ["nonterminal", { status: "in_progress", output: [] }, /response not complete \(in_progress\)/],
  ["text without URLs", { status: "completed", output: [searchMessage("PRIVATE_TEXT_WITHOUT_RESULTS")] }, /returned text without usable source URLs/],
  ["search failed", { status: "completed", output: [{ type: "web_search_call", status: "failed" }, searchMessage("Partial - https://example.com/partial")] }, /search call did not complete/],
] as const) {
  test(`WebSearch classifies ${name} and preserves reported ID and usage`, async () => {
    const body = JSON.stringify({
      id: "resp_failure",
      model: "gpt-6-astra",
      ...fields,
      usage: { input_tokens: 40, output_tokens: 1200, output_tokens_details: { reasoning_tokens: 1195 } },
    })

    await withSearchResponses([{ status: 200, body }], async (baseUrl, attempts) => {
      const search = await createClaudeWebSearchExecution(createConfig(baseUrl), payload, "public query")

      assert.match(search.text, diagnostic)
      assert.doesNotMatch(search.text, /PRIVATE_|https:\/\/example.com\/partial/)
      assert.equal(search.id, "resp_failure")
      assert.equal(search.inputTokens, 40)
      assert.equal(search.outputTokens, 1200)
      assert.deepEqual(search.results, [])

      const result = createClaudeWebSearchResponse(search)
      assert.equal(result.usage.output_tokens, 1200)
      assert.equal(result.id, "resp_failure")
      assert.equal(attempts(), 1)
    })
  })
}

for (const body of ["null", "[]", '{"output":{}}', '{"output":[null]}']) {
  test(`WebSearch classifies malformed successful body ${body}`, async () => {
    await withSearchResponses([{ status: 200, body }], async (baseUrl, attempts) => {
      const search = await createClaudeWebSearchExecution(createConfig(baseUrl), payload, "public query")

      assert.match(search.text, /malformed response/)
      assert.deepEqual(search.results, [])
      assert.equal(attempts(), 1)
    })
  })
}

// The final context may claim only the verification the backend reported: a completed
// web_search_call, a call without a status, or no call at all.
const expectedProvenance = (source: string) => {
  if (source === "action") {
    return /reported a completed web_search_call/
  }

  if (source === "call-unreported") {
    return /reported a web_search_call but omitted its completion status/
  }

  return /Search execution is unverified/
}

for (const source of ["annotation", "action", "text", "call-unreported"] as const) {
  test(`WebSearch accepts ${source} results and carries evidence into final context`, async () => {
    const output: Array<Record<string, unknown>> = source === "action"
      ? [{
        type: "web_search_call",
        status: "completed",
        action: {
          sources: [{ type: "url", title: "Actual source", url: "https://example.com/source" }],
        },
      }]
      : [{
        type: "message",
        content: [{
          type: "output_text",
          text: "Text fallback - https://example.com/fallback",
          ...(source === "annotation" && { annotations: [{ type: "url_citation", title: "Actual source", url: "https://example.com/source" }] }),
        }],
      }]

    // A web_search_call without a status reports a search but not its completion.
    if (source === "call-unreported") {
      output.unshift({ type: "web_search_call" })
    }

    await withSearchResponses([{ status: 200, body: JSON.stringify({ id: "resp_sources", status: "completed", output }) }], async (baseUrl) => {
      const search = await createClaudeWebSearchExecution(createConfig(baseUrl), payload, "public query")
      assert.equal(search.results[0]?.url, `https://example.com/${source === "text" || source === "call-unreported" ? "fallback" : "source"}`)

      const mapper = createClaudeToolNameMapper([])
      const final = createFinalWebSearchPayload({ model: "opus", messages: [] }, search, mapper)
      assert.equal(final.messages.at(-1)?.role, "user")
      const context = String(final.messages.at(-1)?.content)
      assert.match(context, expectedProvenance(source))
      assert.doesNotMatch(context, /Trusted bridge retrieval context|copilot-relay executed it/)
    })
  })
}

test("WebSearch logs bounded metadata with tool correlation and no response content", async () => {
  const messages: string[] = []
  log.setReporters([{
    log: (entry) => {
      messages.push(entry.args.join(" "))
    },
  }])
  setLogLevel("info")
  const requestId = "c11bb174-4235-4c3e-b284-18a78bd44e82"
  const body = JSON.stringify({
    id: "resp_evidence",
    model: "PRIVATE_UPSTREAM_MODEL",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    error: { message: "PRIVATE_ERROR" },
    output: [
      { type: "reasoning", summary: [{ text: "PRIVATE_REASONING" }] },
      { type: "web_search_call", status: "completed", action: { query: "PRIVATE_QUERY" } },
    ],
    usage: { input_tokens: 20, output_tokens: 1200, output_tokens_details: { reasoning_tokens: 1190 } },
  })

  try {
    await withSearchResponses([{ status: 200, body }], async (baseUrl) => {
      const search = await createClaudeWebSearchExecution(
        createConfig(baseUrl),
        { ...payload, max_tokens: 4000, output_config: { effort: "max" } },
        "PRIVATE_QUERY",
        { requestId },
      )
      const result = createClaudeWebSearchResponse(search)
      const tool = result.content[0]
      assert(tool?.type === "server_tool_use")

      const summary = messages.find((message) => message.includes("Copilot web search completion")) ?? ""
      assert.match(summary, /upstream_response_id=resp_evidence/)
      assert.match(summary, /requested_effort=max effective_effort=max output_cap=1200/)
      assert.match(summary, /status=incomplete incomplete_reason=max_output_tokens/)
      assert.match(summary, /reasoning:1/)
      assert.match(summary, /completed:1/)
      assert.match(summary, /input_tokens=20 output_tokens=1200 reasoning_tokens=1190/)

      const correlation = messages.find((message) => message.includes(`tool_use_id=${tool.id}`)) ?? ""
      assert.match(correlation, new RegExp(`request_id=${requestId}.*upstream_response_id=resp_evidence`))

      // Every web search entry is one bounded line that carries no upstream content.
      for (const message of messages.filter((line) => line.includes("Copilot web search"))) {
        assert(message.length < 1600)
        assert.doesNotMatch(message, /[\r\n\x1b]|PRIVATE_/)
      }

      // File writes are fire-and-forget, so poll until the correlated entry lands.
      let logText = ""
      for (let attempt = 0; attempt < 50; attempt++) {
        logText = await fs.readFile(getLogPath(), "utf8").catch(() => "")
        if (logText.includes(`tool_use_id=${tool.id}`)) {
          break
        }

        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      assert.match(logText, /upstream_response_id=resp_evidence/)
      assert.doesNotMatch(logText, /PRIVATE_/)
    })
  } finally {
    setLogLevel("error")
  }
})

test("WebSearch omits hostile metadata and distinguishes missing usage from zero", async () => {
  const messages: string[] = []
  log.setReporters([{
    log: (entry) => {
      messages.push(entry.args.join(" "))
    },
  }])
  setLogLevel("info")

  try {
    await withSearchResponses([{
      status: 200,
      body: JSON.stringify({
        id: "resp_bad\nPRIVATE_ID", model: "PRIVATE_MODEL", status: "PRIVATE_STATUS",
        incomplete_details: { reason: "PRIVATE_REASON" }, output: [{ type: "PRIVATE_TYPE", status: "PRIVATE_CALL" }],
        usage: { input_tokens: -1, output_tokens: "PRIVATE_USAGE", output_tokens_details: { reasoning_tokens: 0 } },
      }),
    }], async (baseUrl) => {
      const search = await createClaudeWebSearchExecution(createConfig(baseUrl), payload, "PRIVATE_QUERY")

      assert.match(search.id, /^msg_/)
      assert.equal(search.inputTokens, 0)
      assert.equal(search.outputTokens, 0)
      assert.doesNotMatch(search.text, /PRIVATE_/)

      // Invalid counts log as unknown rather than passing as a real zero.
      const summary = messages.find((line) => line.includes("Copilot web search completion")) ?? ""
      assert.match(summary, /status=unknown/)
      assert.match(summary, /input_tokens=unknown output_tokens=unknown reasoning_tokens=0/)
      assert.doesNotMatch(messages.join("\n"), /PRIVATE_/)
    })
  } finally {
    setLogLevel("error")
  }
})

const startHangingMockCopilot = async () => {
  const requests: Array<CapturedRequest> = []
  const server = createHttpServer(async (request) => {
    const path = request.url ?? "/"
    const body = await readJsonBody(request)
    requests.push({ body, path })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address && typeof address === "object")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => error ? reject(error) : resolve())
      }),
    requests,
  }
}

// Why: WebSearch is a direct Copilot Responses call, so an explicitly configured
// Claude-facing context suffix must never survive into its model field.
test("canonicalizes the configured WebSearch backend model", () => {
  assert.equal(
    getWebSearchBackendModel({
      ...createConfig("http://127.0.0.1:1"),
      webSearchBackend: "GPT-5.6-SOL[1M][1m]",
    }),
    "gpt-5.6-sol",
  )
})

// Why: WebSearch response metadata returns to Claude Code, so the canonical
// Copilot ID must be restored to the Claude-facing context-selector identity.
test("exposes the 1M identity in Claude WebSearch responses", () => {
  const response = createClaudeWebSearchResponse({
    id: "resp_web_search",
    inputTokens: 1,
    model: "gpt-5.6-sol",
    outputTokens: 1,
    query: "test",
    results: [],
    text: "unavailable",
  })

  assert.equal(response.model, "gpt-5.6-sol[1m]")
})

// Why: bridge-managed Claude WebSearch depends on Copilot /responses
// web_search_preview. Keep direct coverage for that upstream payload and result
// parsing so timeout/cancellation changes do not break WebSearch.
test("executes Claude WebSearch through Copilot responses", async () => {
  const mock = await startWebSearchMockCopilot()
  try {
    const search = await createClaudeWebSearchExecution(
      createConfig(mock.baseUrl),
      payload,
      "GitHub Copilot docs",
    )
    const request = mock.requests[0]?.body as {
      input?: string
      tools?: Array<{ type?: string }>
    }

    assert.equal(mock.requests[0]?.path, "/responses")
    assert.deepEqual(request.tools, [{ type: "web_search_preview" }])
    assert.match(request.input ?? "", /GitHub Copilot docs/)
    assert.equal(search.query, "GitHub Copilot docs")
    assert.deepEqual(search.results, [
      {
        title: "GitHub Copilot docs",
        url: "https://docs.github.com/en/copilot",
      },
    ])
  } finally {
    await mock.close()
  }
})

// Why: if the WebSearch /responses call hangs, it must use the same abort path
// as model calls rather than keeping the whole Claude request open indefinitely.
test("times out hung Claude WebSearch upstream calls", async () => {
  const mock = await startHangingMockCopilot()
  try {
    await assert.rejects(
      createClaudeWebSearchExecution(
        createConfig(mock.baseUrl),
        payload,
        "GitHub Copilot docs",
        { timeoutMs: 500 },
      ),
      (error: unknown) =>
        error instanceof HTTPError && error.response.status === 504,
    )

    assert.equal(mock.requests[0]?.path, "/responses")
  } finally {
    await mock.close()
  }
})

// The final-answer pass keeps the client's tools: with `tools: undefined`
// the model cannot emit a tool_use block, and every web-search turn ends with
// a stated plan and no action.
const searchExecution: WebSearchExecutionResult = {
  id: "msg_final",
  inputTokens: 10,
  model: "gpt-5.6-sol",
  outputTokens: 20,
  query: "rust async runtimes",
  results: [{ title: "Tokio", url: "https://tokio.rs" }],
  text: "1. Tokio - https://tokio.rs",
}

const clientTools: Array<ClaudeTool> = [
  { name: "Read", input_schema: { type: "object" } },
  { name: "Bash", input_schema: { type: "object" } },
  { name: "WebSearch", input_schema: { type: "object" } },
]

const createFinalPayloadFixture = (
  overrides: Partial<ChatCompletionsPayload> = {},
  tools: Array<ClaudeTool> = clientTools,
) => {
  const mapper = createClaudeToolNameMapper(tools)
  const basePayload: ChatCompletionsPayload = {
    max_tokens: 64,
    messages: [{ role: "user", content: "compare rust async runtimes" }],
    model: "claude-opus-5",
    tools: tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: mapper.toOpenAI(tool.name),
        parameters: tool.input_schema ?? {},
      },
    })),
    ...overrides,
  }

  return {
    mapper,
    result: createFinalWebSearchPayload(basePayload, searchExecution, mapper),
  }
}

test("keeps client tools on the WebSearch final-answer request", () => {
  // Why: with no tools upstream the model cannot emit tool_use at all, so the
  // turn ends as an unactioned plan.
  const { mapper, result } = createFinalPayloadFixture()
  const names = result.tools?.map((tool) => mapper.toClaude(tool.function.name))

  assert.deepEqual(names, ["Read", "Bash"])
})

test("drops only the WebSearch tool from the final-answer request", () => {
  // Why: the search already ran and the final response is never re-checked for
  // a web-search call, so re-advertising it would surface a client tool_use
  // named WebSearch instead of a server_tool_use block. Asserted through the
  // mapper so the test fails if name round-tripping breaks.
  const { mapper, result } = createFinalPayloadFixture()

  assert.equal(
    result.tools?.some(
      (tool) => mapper.toClaude(tool.function.name) === "WebSearch",
    ),
    false,
  )
})

test("omits the tools field when WebSearch was the only tool", () => {
  // Why: an empty array is not the same as an absent field upstream.
  const { result } = createFinalPayloadFixture({}, [
    { name: "WebSearch", input_schema: { type: "object" } },
  ])

  assert.equal(result.tools, undefined)
  assert.equal(result.tool_choice, undefined)
})

test("relaxes a tool_choice that pinned the removed WebSearch tool", () => {
  // Why: a choice pinned to a tool that is no longer advertised is
  // unsatisfiable, and "required" would force a tool call on a pass whose job
  // is to answer.
  const mapper = createClaudeToolNameMapper(clientTools)
  const forcedAtSearch = createFinalPayloadFixture({
    tool_choice: {
      type: "function",
      function: { name: mapper.toOpenAI("WebSearch") },
    },
  })
  const required = createFinalPayloadFixture({ tool_choice: "required" })
  const forcedAtRead = createFinalPayloadFixture({
    tool_choice: {
      type: "function",
      function: { name: mapper.toOpenAI("Read") },
    },
  })

  assert.equal(forcedAtSearch.result.tool_choice, "auto")
  assert.equal(required.result.tool_choice, "auto")
  assert.deepEqual(forcedAtRead.result.tool_choice, {
    type: "function",
    function: { name: mapper.toOpenAI("Read") },
  })
})

test("ends the WebSearch final-answer request on a user message", () => {
  // Why: Copilot's Claude-family models reject a conversation that does not end
  // with a user message. The retrieval context is appended last, so its role
  // decides whether the request 400s.
  const { result } = createFinalPayloadFixture()

  assert.equal(result.messages.at(-1)?.role, "user")
})

test("passes prior conversation history through unchanged", () => {
  // Why: an earlier version rewrote tool messages to developer messages and
  // stripped assistant tool_calls, which was only needed while tool definitions
  // were being removed. Keeping history byte-identical preserves the
  // prompt-cache prefix shared with the decision pass.
  const history: Array<Message> = [
    { role: "user", content: "compare rust async runtimes" },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "file contents" },
  ]
  const { result } = createFinalPayloadFixture({ messages: history })

  assert.deepEqual(result.messages.slice(0, -1), history)
})

// A tool result can hold an array of blocks, such as text and an image. Its text reaches the
// search request as text, not as "[object Object]".
test("a tool result with array content reaches the search request as text", async () => {
  const { withRecordedTransport } = await import("../../src/lib/request-trace")
  const baseUrl = "https://search-tool-result.invalid"
  const backend: CopilotModel = { supportedEndpoints: ["/responses"], reasoningEfforts: [] }
  const config = {
    ...createConfig(baseUrl),
    webSearchBackend: "future-search",
    modelCatalog: { baseUrl, models: new Map([["future-search", backend]]) },
  }
  const toolResultPayload: ClaudeMessagesPayload = {
    ...payload,
    messages: [
      { role: "user", content: "List the fixtures." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*.ts" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "Found 2 files" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            ],
          },
          { type: "text", text: "search the web for copilot docs" },
        ],
      },
    ],
  }
  const inputs: Array<string> = []

  await withRecordedTransport({
    fetch: async (request) => {
      const { input } = JSON.parse(request.body!) as { input: unknown }
      assert.equal(typeof input, "string")
      inputs.push(input as string)
      return Response.json({ id: "resp_search", model: "future-search", status: "completed", output: [] })
    },
    refresh: async () => {},
  }, async () => {
    await createClaudeWebSearchExecution(config, toolResultPayload, "copilot docs")
  })

  assert.equal(inputs.length, 1)
  assert.ok(inputs[0].includes("user: Found 2 files\n\n[image]\n\nsearch the web for copilot docs"))
  assert.equal(inputs[0].includes("[object Object]"), false)
})
