import assert from "node:assert/strict"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import test from "node:test"

import {
  createClaudeWebSearchExecution,
  createClaudeWebSearchResponse,
  createFinalWebSearchPayload,
  getWebSearchBackendModel,
  type WebSearchExecutionResult,
} from "../../src/claude/web-search"
import { createClaudeToolNameMapper } from "../../src/claude/tool-names"
import type { ClaudeMessagesPayload, ClaudeTool } from "../../src/claude/types"
import type { ChatCompletionsPayload, Message } from "../../src/copilot/types"
import type { ProxyConfig } from "../../src/lib/config"
import { HTTPError } from "../../src/lib/error"

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

// Regression coverage for #37. The final-answer pass used to send
// `tools: undefined`, so the model could not emit a tool_use block and every
// web-search turn ended with a stated plan and no action.
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
  // turn ends as an unactioned plan (#37).
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
