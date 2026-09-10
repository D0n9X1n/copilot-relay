import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { astraLimits, modelCatalogPayload, opusLimits, solLimits } from "../fixtures/model-limits"
import type { ProxyConfig } from "../../src/lib/config"
import type { ChatCompletionChunk } from "../../src/copilot/types"

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

test.after(async () => {
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
    if (wait) await wait()
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
  assert.deepEqual(parseModelTokenLimits(solLimits), solLimits)
  for (const limits of [
    undefined, null, {}, { max_output_tokens: 128_000 },
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
      loadCopilotModelCatalog(config), loadCopilotModelCatalog(config),
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
    for (const [model, maximum] of [["gpt-6-astra", 128_000], ["claude-opus-5", 64_000]] as const) {
      assert.equal(await boundModelOutputTokens(config, model, maximum), maximum)
      assert.equal(await boundModelOutputTokens(config, model, maximum + 1), maximum)
      assert.equal(await boundModelOutputTokens(config, model, 16), 16)
    }
    for (const budget of [null, undefined, 0, -1, 1.5]) {
      assert.equal(await boundModelOutputTokens(config, "gpt-6-astra", budget), budget)
    }
    assert.equal(mock.calls(), 1)
  } finally {
    await mock.close()
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
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const first = await startModels(modelCatalogPayload, () => waiting)
  const second = await startModels()
  const config = configFor(first.baseUrl)
  try {
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
  for (const value of chunks) yield { data: JSON.stringify(value) }
  yield { data: "[DONE]" }
}

test("buffered output retains reasoning, tool fragments, usage, and exhaustion", async () => {
  const result = await collectChatCompletionStream(streamOf([
    chunk({ reasoning_content: "thinking " }),
    chunk({ reasoning_text: "continued", content: "long " }),
    chunk({ content: "answer", tool_calls: [{
      index: 0, id: "call_large", type: "function", function: { name: "Write", arguments: '{"text":' },
    }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"complete"}' } }] }, "length"),
    { ...chunk({}), choices: [], usage: { prompt_tokens: 936_000, completion_tokens: 64_000, total_tokens: 1_000_000 } },
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
