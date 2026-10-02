import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ProxyConfig } from "../../src/lib/config"

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-preflight-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { validateUpstream } = await import("../../src/lib/preflight")
const { runtimeState } = await import("../../src/lib/state")

const { flushLogs } = await import("../../src/lib/log")
test.after(async () => {
  await flushLogs()
  await fs.rm(tempHome, { force: true, recursive: true })
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

const startMockCopilot = async (
  modelIds = ["gpt-6-astra", "claude-opus-4.8"],
  options: { supportedEndpoints?: string[]; nativeStatus?: number; nativeBody?: unknown } = {},
) => {
  const requests: Array<CapturedRequest> = []
  const server = createHttpServer(async (request, response) => {
    const path = request.url ?? "/"
    const body = await readJsonBody(request)
    requests.push({ body, path })
    response.setHeader("content-type", "application/json")

    if (path === "/models") {
      response.end(JSON.stringify({
        data: modelIds.map((id) => ({
          id,
          ...(id.startsWith("claude-") && options.supportedEndpoints && { supported_endpoints: options.supportedEndpoints }),
        })),
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

    if (path === "/v1/messages") {
      const payload = body as { model?: string }
      response.statusCode = options.nativeStatus ?? 200
      response.end(JSON.stringify(options.nativeBody ?? {
        id: "msg_preflight", type: "message", role: "assistant", model: payload.model,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
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
    gptModel: "GPT-6-ASTRA[1M][1m]",
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
    assert.deepEqual(upstreamModels, ["gpt-6-astra", "claude-opus-4.8"])
    assert.equal(upstreamModels.some((model) => model?.includes("[1m]")), false)
    const responsesRequest = mock.requests.find((request) => request.path === "/responses")
    assert.equal(
      (responsesRequest?.body as { reasoning?: { effort?: string } }).reasoning?.effort,
      "max",
    )
  } finally {
    await mock.close()
  }
})

test("fresh default preflight probes Opus 5.5 without a context alias", async () => {
  const mock = await startMockCopilot(["gpt-6-astra", "claude-opus-5.5"])
  runtimeState.thinkEffort = "max"
  try {
    await validateUpstream({
      copilotBaseUrl: mock.baseUrl, copilotToken: "test-token", host: "127.0.0.1",
      port: 0, upstreamTimeoutMs: 1000, vsCodeVersion: "1.99.3",
    }, "max")
    assert.deepEqual(mock.requests.map((request) => request.path), ["/models", "/responses", "/chat/completions"])
    const opus = mock.requests[2]?.body as { model: string; reasoning_effort: string }
    assert.equal(opus.model, "claude-opus-5.5")
    assert.equal(opus.reasoning_effort, "max")
  } finally {
    await mock.close()
  }
})

for (const claudeUpstreamApi of ["auto", "messages"] as const) {
  test(`preflight probes native Claude with configured effort and 16 tokens in ${claudeUpstreamApi} mode`, async () => {
    const mock = await startMockCopilot(["gpt-6-astra", "claude-opus-5.5"], {
      supportedEndpoints: claudeUpstreamApi === "auto" ? ["/v1/messages"] : ["/chat/completions"],
    })
    runtimeState.thinkEffort = "max"
    try {
      await validateUpstream({
        copilotBaseUrl: mock.baseUrl, copilotToken: "test-token", host: "127.0.0.1",
        port: 0, upstreamTimeoutMs: 1000, vsCodeVersion: "1.99.3", claudeUpstreamApi,
      }, "high")
      assert.deepEqual(mock.requests.map((request) => request.path), ["/models", "/responses", "/v1/messages"])
      assert.deepEqual(mock.requests[2]?.body, {
        model: "claude-opus-5.5", max_tokens: 16, stream: false,
        messages: [{ role: "user", content: "Reply with OK only." }],
        output_config: { effort: "high" },
      })
    } finally {
      await mock.close()
    }
  })
}

for (const failure of [
  { name: "HTTP rejection", nativeStatus: 403, nativeBody: { error: { message: "native access denied" } }, expected: /Preflight failed for model=claude-opus-5\.5 think_effort=high: 403 .*native access denied/ },
  { name: "malformed success", nativeStatus: 200, nativeBody: { choices: [] }, expected: /Invalid native message response/ },
]) {
  test(`preflight preserves native ${failure.name} instead of passing the chat endpoint`, async () => {
    const mock = await startMockCopilot(["gpt-6-astra", "claude-opus-5.5"], {
      ...failure, supportedEndpoints: ["/v1/messages"],
    })
    try {
      await assert.rejects(validateUpstream({
        copilotBaseUrl: mock.baseUrl, copilotToken: "test-token", host: "127.0.0.1",
        port: 0, upstreamTimeoutMs: 1000, vsCodeVersion: "1.99.3", claudeUpstreamApi: "auto",
      }, "high"), failure.expected)
      assert.deepEqual(mock.requests.map((request) => request.path), ["/models", "/responses", "/v1/messages"])
    } finally {
      await mock.close()
    }
  })
}

for (const missing of ["gpt-6-astra", "claude-opus-5.5"]) {
  test(`preflight rejects unavailable ${missing} without changing models`, async () => {
    const models = ["gpt-6-astra", "claude-opus-5.5", "gpt-5.6-sol"]
    const mock = await startMockCopilot(models.filter((model) => model !== missing))
    const routing = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5" }
    runtimeState.modelRouting = { ...routing }
    runtimeState.thinkEffort = "max"

    try {
      await assert.rejects(validateUpstream({
        copilotBaseUrl: mock.baseUrl,
        copilotToken: "test-token",
        host: "127.0.0.1",
        port: 0,
        upstreamTimeoutMs: 1_000,
        vsCodeVersion: "1.99.3",
      }, "max"), {
        message: `Required Copilot model(s) unavailable upstream: ${missing}`,
      })
      assert.deepEqual(mock.requests.map((request) => request.path), ["/models"])
      assert.deepEqual(runtimeState.modelRouting, routing)
    } finally {
      await mock.close()
    }
  })
}
