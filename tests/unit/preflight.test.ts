import assert from "node:assert/strict"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import test from "node:test"

import type { ProxyConfig } from "../../src/lib/config"
import { validateUpstream } from "../../src/lib/preflight"
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
        data: [{ id: "gpt-5.6-sol" }, { id: "claude-opus-4.8" }],
      }))
      return
    }

    if (path === "/responses") {
      const payload = body as { model?: string }
      response.end(JSON.stringify({
        id: "resp_preflight",
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

    if (path === "/chat/completions") {
      const payload = body as { model?: string }
      response.end(JSON.stringify({
        id: "chat_preflight",
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

test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.thinkEffort
})

// Why: Copilot knows only the canonical model ID. Startup must compare and
// probe with that ID even if configured input contains repeated/case-varied
// Claude context suffixes.
test("preflight uses canonical upstream model ids", async () => {
  const mock = await startMockCopilot()
  runtimeState.modelRouting = {
    gptModel: "GPT-5.6-SOL[1M][1m]",
    opusModel: "claude-opus-4.8",
  }
  runtimeState.thinkEffort = "max"
  const config: ProxyConfig = {
    copilotBaseUrl: mock.baseUrl,
    copilotToken: "test-token",
    host: "127.0.0.1",
    port: 0,
    upstreamTimeoutMs: 180_000,
    vsCodeVersion: "1.99.3",
  }

  try {
    await validateUpstream(config, "max")

    assert.deepEqual(mock.requests.map((request) => request.path), [
      "/models",
      "/responses",
      "/chat/completions",
    ])
    const upstreamModels = mock.requests.flatMap((request) =>
      request.path === "/models" ? [] : [(request.body as { model?: string }).model]
    )
    assert.deepEqual(upstreamModels, ["gpt-5.6-sol", "claude-opus-4.8"])
    assert.equal(upstreamModels.some((model) => model?.includes("[1m]")), false)
  } finally {
    await mock.close()
  }
})
