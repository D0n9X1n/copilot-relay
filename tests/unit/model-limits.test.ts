import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  astraLimits,
  modelCatalogPayload,
  opusLimits,
  opus55Limits,
  solLimits
} from "../fixtures/model-limits"
import type { ProxyConfig } from "../../src/lib/config"
import type { ChatCompletionChunk } from "../../src/copilot/types"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-model-limits-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.CONSOLA_LEVEL = "0"

const {
  boundModelOutputTokens,
  getCachedCopilotModel,
  loadCopilotModelCatalog,
  parseModelTokenLimits,
} = await import("../../src/copilot/models")
const { collectChatCompletionStream } = await import("../../src/copilot/stream")
const { HTTPError } = await import("../../src/lib/error")
const { normalizeClaudeModelId } = await import("../../src/lib/models")
const { runtimeState } = await import("../../src/lib/state")
const { probeModels } = await import("../../src/lib/model-probe")
const { flushLogs } = await import("../../src/lib/log")

test.after(async () => {
  await flushLogs()
  await fs.rm(tempHome, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
})

const configFor = (baseUrl: string): ProxyConfig => ({
  copilotBaseUrl: baseUrl,
  copilotToken: "test-token",
  host: "127.0.0.1",
  port: 0,
  upstreamTimeoutMs: 10_000,
  vsCodeVersion: "1.99.3",
})

const startModels = async (
  payload: unknown = modelCatalogPayload,
  wait?: () => Promise<void>,
) => {
  let calls = 0
  const server = createServer(async (_request, response) => {
    calls++
    if (wait) {
      await wait()
    }

    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(payload))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      )
    },
  }
}

test("retains exact advertised limits and does not invent missing capacities", () => {
  assert.deepEqual(parseModelTokenLimits(astraLimits), astraLimits)
  assert.deepEqual(parseModelTokenLimits(opusLimits), opusLimits)
  assert.deepEqual(parseModelTokenLimits(opus55Limits), opus55Limits)
  assert.deepEqual(parseModelTokenLimits(solLimits), solLimits)

  // A missing required field, a malformed field, or a limit larger than the one
  // bounding it rejects the whole set rather than keeping its valid part. Only
  // max_non_streaming_output_tokens may be absent.
  for (const limits of [
    undefined,
    null,
    {},
    { max_output_tokens: 128_000 },
    { ...astraLimits, max_output_tokens: "128000" },
    { ...astraLimits, max_prompt_tokens: 1_000_001 },
    { ...astraLimits, max_output_tokens: 0 },
    { ...astraLimits, max_output_tokens: 1.5 },
    { ...astraLimits, max_context_window_tokens: Infinity },
    { ...opusLimits, max_non_streaming_output_tokens: 64_001 },
  ]) {
    assert.equal(parseModelTokenLimits(limits), undefined)
  }
})

test("catalog requests are deduplicated and retain model limits and tokenizer", async () => {
  const mock = await startModels()
  const config = configFor(mock.baseUrl)
  runtimeState.upstreamBaseUrl = mock.baseUrl

  try {
    const [first, second] = await Promise.all([
      loadCopilotModelCatalog(config),
      loadCopilotModelCatalog(config),
    ])

    assert.equal(first, second)
    assert.equal(mock.calls(), 1)
    assert.equal(config.modelCatalog, first)
    assert.equal(runtimeState.modelCatalog, first)
    assert.deepEqual(getCachedCopilotModel(config, "gpt-6-astra[1m]"), {
      limits: astraLimits, tokenizer: "o200k_base",
    })
    assert.equal(normalizeClaudeModelId("gpt-6-astra"), "gpt-6-astra[1m]")
    assert.equal(normalizeClaudeModelId("gpt-5.6-sol[1m]"), "gpt-5.6-sol")
    assert.deepEqual(
      getCachedCopilotModel(config, "claude-opus-5.5"),
      { limits: opus55Limits, tokenizer: "o200k_base" }
    )
    assert.equal(normalizeClaudeModelId("claude-opus-5.5"), "claude-opus-5.5")

    for (const [model, maximum] of [
      ["gpt-6-astra", 128_000],
      ["claude-opus-5", 64_000],
      ["claude-opus-5.5", 128_000]
    ] as const) {
      assert.equal(await boundModelOutputTokens(config, model, maximum), maximum)
      assert.equal(await boundModelOutputTokens(config, model, maximum + 1), maximum)
      assert.equal(await boundModelOutputTokens(config, model, 16), 16)
    }

    for (const budget of [null, undefined, 0, -1, 1.5]) {
      assert.equal(await boundModelOutputTokens(config, "gpt-6-astra", budget), budget)
    }

    // Every lookup above was served by the one catalog request.
    assert.equal(mock.calls(), 1)
  } finally {
    await mock.close()
  }
})

test("deep probes restore process routing and catalog state after a failed response", async (t) => {
  const mock = await startModels({ error: "not a completion" })
  const config = configFor(mock.baseUrl)
  const routing = { gptModel: "before-gpt", opusModel: "before-opus" }
  const catalog = { baseUrl: "before", models: new Map() }
  runtimeState.modelRouting = routing
  runtimeState.modelCatalog = catalog
  runtimeState.upstreamBaseUrl = "before"
  const sigintListeners = process.listenerCount("SIGINT")
  const sigtermListeners = process.listenerCount("SIGTERM")
  t.mock.method(console, "log", () => {})

  try {
    assert.equal(await probeModels(config, [["exact-model", {}]], {
      maxTokens: 64,
      timeoutMs: 1000,
      totalTimeoutMs: 2000
    }), 2)

    assert.equal(runtimeState.modelRouting, routing)
    assert.equal(runtimeState.modelCatalog, catalog)
    assert.equal(runtimeState.upstreamBaseUrl, "before")
    assert.equal(process.listenerCount("SIGINT"), sigintListeners)
    assert.equal(process.listenerCount("SIGTERM"), sigtermListeners)
  } finally {
    delete runtimeState.modelRouting
    await mock.close()
  }
})

for (const claudeUpstreamApi of ["auto", "messages"] as const) {
  test(`deep probes use the native-only exact Claude model in ${claudeUpstreamApi} mode`, async (t) => {
    const id = "claude-sonnet-probe"
    const model = {
      type: "chat",
      supportedEndpoints: ["/v1/messages"],
      reasoningEfforts: ["low", "high"],
      limits: {
        max_context_window_tokens: 1000,
        max_prompt_tokens: 968,
        max_output_tokens: 32,
        max_non_streaming_output_tokens: 12
      },
    }
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    let reportedModel = id
    const upstream = createServer(async (request, response) => {
      let raw = ""
      for await (const chunk of request) {
        raw += chunk
      }

      requests.push({
        path: request.url ?? "/",
        body: raw ? JSON.parse(raw) as Record<string, unknown> : {}
      })
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        id: "msg_probe",
        type: "message",
        role: "assistant",
        model: reportedModel,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }))
    })

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    assert.ok(address && typeof address === "object")
    const config = { ...configFor(`http://127.0.0.1:${address.port}`), claudeUpstreamApi }
    config.modelCatalog = { baseUrl: config.copilotBaseUrl, models: new Map([[id, model]]) }

    const lines: string[] = []
    t.mock.method(console, "log", (line: string) => {
      lines.push(line)
    })
    const options = { maxTokens: 64, timeoutMs: 1000, totalTimeoutMs: 2000, effort: "high" as const }

    try {
      assert.equal(await probeModels(config, [[id, model]], options), 0, lines.join("\n"))
      // max_tokens is the smallest of the requested 64 and the model's caps:
      // 32 for output and 12 for a non-streaming reply.
      assert.deepEqual(requests, [{
        path: "/v1/messages",
        body: {
          model: id,
          max_tokens: 12,
          stream: false,
          output_config: { effort: "high" },
          messages: [{ role: "user", content: "Reply with OK only." }],
        }
      }])
      assert.match(lines.join("\n"), /Summary: 1 passed/)

      // The default and chat-completions policies skip this native-only model
      // without sending a request.
      for (const mode of [undefined, "chat-completions"] as const) {
        assert.equal(await probeModels({ ...config, claudeUpstreamApi: mode }, [[id, model]], options), 2)
        assert.equal(requests.length, 1)
      }

      assert.match(lines.join("\n"), /SKIPPED.*Protocol policy conflict/)

      // The model advertises only low and high effort.
      assert.equal(await probeModels(config, [[id, model]], { ...options, effort: "max" }), 2)
      assert.equal(requests.length, 1)
      assert.match(lines.join("\n"), /SKIPPED.*Unsupported effort/)

      reportedModel = "claude-other-model"
      assert.equal(await probeModels(config, [[id, model]], { ...options, maxTokens: 8 }), 2)
      assert.equal(requests[1]?.body.max_tokens, 8)
      assert.equal(requests[1]?.body.model, id)
      assert.match(lines.join("\n"), /FAIL.*Model mismatch/)
    } finally {
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
}

test("native deep probe accepts only the verified Opus 5.5 provider spelling", async (t) => {
  const { withRecordedTransport } = await import("../../src/lib/request-trace")
  const id = "claude-opus-5.5"
  const model = { type: "chat", supportedEndpoints: ["/v1/messages"], reasoningEfforts: ["low"] }
  const config = {
    ...configFor("https://fixture.invalid"),
    claudeUpstreamApi: "messages" as const,
    modelCatalog: { baseUrl: "https://fixture.invalid", models: new Map([[id, model]]) }
  }
  t.mock.method(console, "log", () => {})

  // A native reply may spell claude-opus-5.5 as claude-opus-5-5. That verified
  // alternative passes, as the canonical ID does; near misses like these fail.
  for (const [reported, expected] of [
    ["claude-opus-5-5", 0],
    ["claude-opus-5-5-preview", 2],
    ["claude-opus-5", 2]
  ] as const) {
    await withRecordedTransport({
      fetch: async () => Response.json({
        id: "msg_native",
        model: reported,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      refresh: async () => {}
    }, async () => {
      assert.equal(
        await probeModels(config, [[id, model]], { maxTokens: 16, timeoutMs: 1000, totalTimeoutMs: 2000 }),
        expected
      )
    })
  }
})

// Copilot answers some undated IDs with a dated snapshot of the same model: gpt-5.5 reported
// gpt-5.5-2026-04-23. Only the requested ID plus one -YYYY-MM-DD date matches; a dated
// request must match exactly, and an alias served by another model is still a mismatch.
test("deep probe accepts a dated snapshot of the requested undated ID and nothing looser", async (t) => {
  const { withRecordedTransport } = await import("../../src/lib/request-trace")
  const cases: Array<[id: string, reported: string, expected: number]> = [
    ["gpt-5.5", "gpt-5.5-2026-04-23", 0],
    ["gpt-4o", "gpt-4o-2024-11-20", 0],
    ["gpt-5.5", "gpt-5.5-preview", 2],
    ["gpt-5.5", "gpt-5.5-2026-04", 2],
    ["gpt-5.4", "gpt-5.4-mini-2026-03-17", 2],
    ["gpt-4o-2024-05-13", "gpt-4o-2024-11-20", 2],
    ["gpt-4o-2024-05-13", "gpt-4.1-2025-04-14", 2],
    ["gpt-3.5-turbo", "gpt-4o-mini-2024-07-18", 2],
  ]
  t.mock.method(console, "log", () => {})

  for (const [id, reported, expected] of cases) {
    const model = { type: "chat", supportedEndpoints: ["/chat/completions"], reasoningEfforts: [] }
    const config = {
      ...configFor("https://fixture.invalid"),
      modelCatalog: { baseUrl: "https://fixture.invalid", models: new Map([[id, model]]) }
    }

    await withRecordedTransport({
      fetch: async () => Response.json({
        id: "chat_probe",
        created: 1,
        model: reported,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      refresh: async () => {}
    }, async () => {
      assert.equal(
        await probeModels(config, [[id, model]], { maxTokens: 16, timeoutMs: 1000, totalTimeoutMs: 2000 }),
        expected,
        `${id} reported as ${reported}`
      )
    })
  }
})

// trajectory-compaction is listed in the catalog, yet upstream answers HTTP 400
// model_not_supported. That gets its own result, apart from payload rejections.
test("deep probe labels an upstream model_not_supported apart from other HTTP 400s", async (t) => {
  const { withRecordedTransport } = await import("../../src/lib/request-trace")
  const id = "listed-model"
  const model = { type: "chat", supportedEndpoints: ["/chat/completions"], reasoningEfforts: [] }
  const config = {
    ...configFor("https://fixture.invalid"),
    modelCatalog: { baseUrl: "https://fixture.invalid", models: new Map([[id, model]]) }
  }
  const lines: string[] = []
  t.mock.method(console, "log", (line: unknown) => {
    lines.push(String(line))
  })

  for (const code of ["model_not_supported", "invalid_request_body"]) {
    lines.length = 0

    await withRecordedTransport({
      fetch: async () => Response.json({ error: { code, message: "fixture rejection" } }, { status: 400 }),
      refresh: async () => {}
    }, async () => {
      assert.equal(
        await probeModels(config, [[id, model]], { maxTokens: 16, timeoutMs: 1000, totalTimeoutMs: 2000 }),
        2
      )
    })

    const output = lines.join("\n")

    if (code === "model_not_supported") {
      assert.match(output, /FAIL.*Model not supported/)
      assert.match(output, /upstream lists this ID but rejects inference for it/)
    } else {
      assert.match(output, /FAIL.*HTTP 400/)
      assert.doesNotMatch(output, /Model not supported/)
    }
  }
})

test("a changed upstream never reuses the previous provider's capacities", async () => {
  const first = await startModels()
  const second = await startModels({
    data: [{
      id: "gpt-6-astra",
      capabilities: { limits: { ...astraLimits, max_output_tokens: 48_000 } },
    }],
  })
  const config = configFor(first.baseUrl)

  try {
    await loadCopilotModelCatalog(config)
    config.copilotBaseUrl = second.baseUrl
    runtimeState.upstreamBaseUrl = second.baseUrl

    assert.equal(getCachedCopilotModel(config, "gpt-6-astra"), undefined)
    assert.equal(await boundModelOutputTokens(config, "gpt-6-astra", 128_000), 48_000)
    assert.equal(second.calls(), 1)
    assert.equal(config.modelCatalog?.baseUrl, second.baseUrl)
  } finally {
    await first.close()
    await second.close()
  }
})

test("a late catalog response cannot replace a newer provider's catalog", async () => {
  let release = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = await startModels(modelCatalogPayload, () => waiting)
  const second = await startModels()
  const config = configFor(first.baseUrl)

  try {
    // The first provider's catalog is held until the second one has loaded.
    const old = loadCopilotModelCatalog(config)
    config.copilotBaseUrl = second.baseUrl
    runtimeState.upstreamBaseUrl = second.baseUrl
    const current = await loadCopilotModelCatalog(config)
    release()
    await old

    assert.equal(config.modelCatalog, current)
    assert.equal(runtimeState.modelCatalog, current)
  } finally {
    release()
    await first.close()
    await second.close()
  }
})

test("invalid catalogs fail explicitly", async () => {
  const mock = await startModels({ data: "invalid" })
  try {
    await assert.rejects(loadCopilotModelCatalog(configFor(mock.baseUrl)), /invalid model catalog/)
  } finally {
    await mock.close()
  }
})

test("unreported limits preserve explicit budgets and omit capacity claims", async () => {
  const mock = await startModels({ data: [{ id: "gpt-6-astra" }] })
  const config = configFor(mock.baseUrl)

  try {
    await loadCopilotModelCatalog(config)

    assert.equal(getCachedCopilotModel(config, "gpt-6-astra")?.limits, undefined)
    assert.equal(await boundModelOutputTokens(config, "gpt-6-astra", 32_000), 32_000)
    assert.equal(mock.calls(), 1)
  } finally {
    await mock.close()
  }
})

const chunk = (
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk => ({
  id: "chat_large",
  object: "chat.completion.chunk",
  created: 1,
  model: "claude-opus-5",
  choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
})

const streamOf = async function* (chunks: Array<ChatCompletionChunk>) {
  for (const value of chunks) {
    yield { data: JSON.stringify(value) }
  }

  yield { data: "[DONE]" }
}

test("buffered output retains reasoning, tool fragments, usage, and exhaustion", async () => {
  const result = await collectChatCompletionStream(streamOf([
    chunk({ reasoning_content: "thinking " }),
    chunk({ reasoning_text: "continued", content: "long " }),
    chunk({
      content: "answer",
      tool_calls: [{
        index: 0,
        id: "call_large",
        type: "function",
        function: { name: "Write", arguments: '{"text":' },
      }]
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"complete"}' } }] }, "length"),
    // Usage arrives in a final chunk that carries no choices.
    {
      ...chunk({}),
      choices: [],
      usage: { prompt_tokens: 936_000, completion_tokens: 64_000, total_tokens: 1_000_000 }
    },
  ]))

  assert.equal(result.choices[0]?.message.content, "long answer")
  assert.equal(result.choices[0]?.message.reasoning_text, "thinking continued")
  assert.equal(result.choices[0]?.message.tool_calls?.[0]?.function.arguments, '{"text":"complete"}')
  assert.equal(result.choices[0]?.finish_reason, "length")
  assert.equal(result.usage?.completion_tokens, 64_000)
})

test("buffered output never turns an incomplete stream into success", async () => {
  await assert.rejects(
    collectChatCompletionStream(streamOf([chunk({ content: "partial" })])),
    (error: unknown) => error instanceof HTTPError && error.response.status === 502,
  )
})

test("buffered output preserves timeout and cancellation errors", async () => {
  for (const [name, status] of [["TimeoutError", 504], ["AbortError", 499]] as const) {
    const reason = new DOMException("request interrupted", name)
    const stream = (async function* () {
      yield { data: JSON.stringify(chunk({ content: "partial" })) }
      throw reason
    })()

    await assert.rejects(
      collectChatCompletionStream(stream, AbortSignal.abort(reason), 1000),
      (error: unknown) => error instanceof HTTPError && error.response.status === status,
    )
  }
})
