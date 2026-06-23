import assert from "node:assert/strict"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import test from "node:test"

import { createClaudeWebSearchExecution } from "../../src/claude/web-search"
import type { ClaudeMessagesPayload } from "../../src/claude/types"
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
