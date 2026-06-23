import assert from "node:assert/strict"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import test from "node:test"

import { createChatCompletions } from "../../src/copilot/chat"
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

const startMockCopilot = async () => {
  const requests: Array<CapturedRequest> = []
  const server = createHttpServer(async (request, response) => {
    const path = request.url ?? "/"
    const body = await readJsonBody(request)
    requests.push({ body, path })

    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      id: "chat_completion",
      created: 1,
      model: "claude-opus-4.8",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
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

// Why: timeout retries can replay a partial assistant answer directly through
// the shared Copilot chat wrapper. Keep the upstream /chat/completions payload
// valid even if a caller bypasses the Claude translation layer's prefill guard.
test("normalizes final assistant prefill before chat completions upstream calls", async () => {
  const mock = await startMockCopilot()
  try {
    const config: ProxyConfig = {
      copilotBaseUrl: mock.baseUrl,
      copilotToken: "test-token",
      host: "127.0.0.1",
      port: 0,
      upstreamTimeoutMs: 180_000,
      vsCodeVersion: "1.99.3",
    }

    await createChatCompletions(config, {
      max_tokens: 16,
      messages: [
        { role: "user", content: "Continue this answer." },
        { role: "assistant", content: "partial answer  \n" },
      ],
      model: "claude-opus-4.8",
      stream: false,
    }, { client: "claude", requestedModel: "opus" })

    const request = mock.requests[0]?.body as {
      messages?: Array<{ content?: string; role?: string }>
    }

    assert.equal(mock.requests[0]?.path, "/chat/completions")
    assert.equal(request.messages?.at(-2)?.role, "assistant")
    assert.equal(request.messages?.at(-2)?.content, "partial answer")
    assert.equal(request.messages?.at(-1)?.role, "user")
    assert.match(
      request.messages?.at(-1)?.content ?? "",
      /Continue the assistant response/,
    )
  } finally {
    await mock.close()
  }
})

// Why: a hung upstream fetch should be aborted instead of leaving the Claude
// request open forever. Production uses a 180s timeout; this uses a tiny timeout
// so the regression stays fast.
test("times out hung chat completions upstream calls", async () => {
  const mock = await startHangingMockCopilot()
  try {
    const config: ProxyConfig = {
      copilotBaseUrl: mock.baseUrl,
      copilotToken: "test-token",
      host: "127.0.0.1",
      port: 0,
      upstreamTimeoutMs: 180_000,
      vsCodeVersion: "1.99.3",
    }

    await assert.rejects(
      createChatCompletions(config, {
        max_tokens: 16,
        messages: [{ role: "user", content: "hang" }],
        model: "claude-opus-4.8",
        stream: false,
      }, { client: "claude", requestedModel: "opus", timeoutMs: 500 }),
      (error: unknown) =>
        error instanceof HTTPError && error.response.status === 504,
    )

    assert.equal(mock.requests[0]?.path, "/chat/completions")
  } finally {
    await mock.close()
  }
})
