import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ProxyConfig } from "../../src/lib/config"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-request-catalog-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { snapshotProxyConfig } = await import("../../src/lib/config")
const { boundModelOutputTokens, ensureCopilotModelCatalog, loadCopilotModelCatalog } = await import("../../src/copilot/models")
const { createServer } = await import("../../src/server")
const { normalizeClaudeModelId, routeModelId, resolveReasoningEffort } = await import("../../src/lib/models")
const { RequestTrace, withRecordedTransport, withRequestTrace, withTraceObserver } = await import("../../src/lib/request-trace")
const { runtimeState, snapshotRuntimeState, withRuntimeState } = await import("../../src/lib/state")
const { flushLogs } = await import("../../src/lib/log")

const providerA = "https://catalog-a.invalid"
const providerB = "https://catalog-b.invalid"
const model = "gpt-6-astra"
const limits = { max_context_window_tokens: 2000, max_prompt_tokens: 1800, max_output_tokens: 128 }
const configFor = (copilotBaseUrl: string): ProxyConfig => ({
  host: "127.0.0.1", port: 0, copilotBaseUrl, copilotToken: "fixture-catalog-token",
  upstreamTimeoutMs: 1000, vsCodeVersion: "test", claudeUpstreamApi: "auto",
})

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})
test.afterEach(() => {
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
  delete runtimeState.modelRouting
  delete runtimeState.thinkEffort
})

for (const status of [400, 401, 429]) {
  test(`catalog HTTP ${status} is upstream evidence, not local validation`, async () => {
    const config = configFor(providerB)
    config.modelCatalog = { baseUrl: providerA, models: new Map([[model, {}]]) }
    let trace: Awaited<ReturnType<typeof RequestTrace.create>> | undefined
    await withTraceObserver((value) => { trace = value }, () => withRecordedTransport({
      fetch: async (request) => {
        assert.equal(request.path, "/models")
        return Response.json({ error: { message: "fixture" } }, { status })
      }, refresh: async () => { throw new Error("Unexpected refresh") },
    }, async () => {
      const response = await createServer(config).fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          model, max_tokens: 16, messages: [{ role: "user", content: "Fixture" }],
        }),
      }))
      assert.equal(response.status, status)
      assert.deepEqual(await response.json(), { error: { message: "fixture" } })
    }))
    assert(trace)
    await trace.finished
    const snapshot = trace.diagnosticSnapshot()
    assert.equal(snapshot.failure, undefined)
    assert.equal(snapshot.exchanges[0].path, "/models")
    assert.equal(snapshot.exchanges[0].status, status)
    assert.equal(snapshot.exchanges[0].responseState, "complete")
    assert.equal(snapshot.responseState, "complete")
  })
}

test("lazy discovery after hot reload is reused by the next request and publishes runtime limits", async () => {
  const root = configFor(providerA)
  root.modelCatalog = { baseUrl: providerA, models: new Map([[model, {}]]) }
  runtimeState.modelCatalog = root.modelCatalog
  root.copilotBaseUrl = providerB
  runtimeState.upstreamBaseUrl = providerB
  let discoveries = 0

  await withRecordedTransport({
    fetch: async (request) => {
      assert.equal(request.method, "GET")
      assert.equal(request.path, "/models")
      discoveries++
      return Response.json({ data: [{ id: model, capabilities: { limits } }] })
    },
    refresh: async () => { throw new Error("Unexpected credential refresh") },
  }, async () => {
    for (let index = 0; index < 2; index++) {
      const config = snapshotProxyConfig(root)
      const runtime = snapshotRuntimeState()
      await withRuntimeState(runtime, async () => {
        assert.equal(await boundModelOutputTokens(config, model, 256), limits.max_output_tokens)
        assert.equal(runtime.modelCatalog, config.modelCatalog)
        assert.equal(normalizeClaudeModelId(model), model)
      })
    }
  })

  assert.equal(discoveries, 1, "A completed discovery must reach the next admitted config")
  assert.equal(root.modelCatalog?.baseUrl, providerB)
  assert.equal(runtimeState.modelCatalog, root.modelCatalog)
  assert.deepEqual(runtimeState.modelCatalog?.models.get(model)?.limits, limits)
  assert.equal(normalizeClaudeModelId(model), model, "Process model metadata must use the refreshed limits")
})

test("first auto request after provider reload discovers native support before validation and reuses it", async () => {
  const nativeModel = "claude-opus-5.5"
  const root = configFor(providerA)
  root.modelCatalog = { baseUrl: providerA, models: new Map([[nativeModel, { supportedEndpoints: ["/chat/completions"] }]]) }
  runtimeState.modelCatalog = root.modelCatalog
  runtimeState.modelRouting = { gptModel: model, opusModel: nativeModel }
  runtimeState.upstreamBaseUrl = providerA
  const app = createServer(root)
  root.copilotBaseUrl = providerB
  runtimeState.upstreamBaseUrl = providerB
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const payload = { model: "opus", max_tokens: 256, messages: [{ role: "user", content: "hello" }] }
  const post = (body: unknown, route = "/v1/messages") => app.fetch(new Request(`http://127.0.0.1${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }))

  await withRecordedTransport({
    fetch: async (request) => {
      requests.push({ path: request.path, body: request.body ? JSON.parse(request.body) : {} })
      if (request.path === "/models") return Response.json({ data: [{
        id: nativeModel, supported_endpoints: ["/v1/messages"], capabilities: { limits, tokenizer: "o200k_base" },
      }] })
      if (request.path === "/v1/messages") return Response.json({
        id: "msg_catalog", type: "message", role: "assistant", model: nativeModel,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      return Response.json({ error: { message: "Native-only model rejects the chat endpoint" } }, { status: 400 })
    },
    refresh: async () => { throw new Error("Unexpected credential refresh") },
  }, async () => {
    const count = await post(payload, "/v1/messages/count_tokens")
    assert.equal(count.status, 200)
    assert.ok((await count.json() as { input_tokens: number }).input_tokens > 0)
    assert.equal(requests.length, 0, "Counting with a stale catalog must stay local")

    for (let index = 0; index < 2; index++) {
      const response = await post(payload)
      assert.equal(response.status, 200, await response.clone().text())
      assert.equal((await response.json() as { stop_reason: string }).stop_reason, "end_turn")
    }
    assert.deepEqual(requests.map((request) => request.path), ["/models", "/v1/messages", "/v1/messages"])
    assert.deepEqual(requests.slice(1).map((request) => request.body.max_tokens), [128, 128])
    assert.equal(root.modelCatalog?.baseUrl, providerB)
    assert.equal(runtimeState.modelCatalog, root.modelCatalog)
    assert.deepEqual(runtimeState.modelCatalog?.models.get(nativeModel)?.limits, limits)

    // Force another stale snapshot: native-only controls must be validated after discovery,
    // before opening the client's SSE response.
    root.modelCatalog = { baseUrl: providerA, models: new Map() }
    runtimeState.modelCatalog = root.modelCatalog
    const controlled = {
      ...payload, stream: true,
      messages: [{ role: "system", content: "Be brief.", clear_at: "next_user_message" }, ...payload.messages],
    }
    const response = await post(controlled)
    assert.equal(response.status, 200, await response.clone().text())
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
    const body = await response.text()
    assert.match(body, /event: message_stop/)
    assert.doesNotMatch(body, /event: error/)
    assert.deepEqual(requests.slice(3).map((request) => request.path), ["/models", "/v1/messages"])
    assert.deepEqual(requests.at(-1)?.body.messages, controlled.messages)

    const localCount = await post(controlled, "/v1/messages/count_tokens")
    assert.equal(localCount.status, 200)
    assert.ok((await localCount.json() as { input_tokens: number }).input_tokens > 0)
    assert.equal(requests.length, 5, "Counting native controls must not call upstream")
  })
})

test("late provider A discovery updates its admitted request without overwriting provider B policy or catalog", { timeout: 5000 }, async () => {
  const root = configFor(providerA)
  root.modelCatalog = { baseUrl: providerA, models: new Map() }
  root.copilotTokenGeneration = 1
  root.refreshCopilotToken = async () => { root.copilotToken = "fixture-refreshed"; root.copilotTokenGeneration = 2 }
  runtimeState.modelCatalog = root.modelCatalog
  runtimeState.upstreamBaseUrl = providerA
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-before" }
  runtimeState.thinkEffort = "low"
  const admittedA = snapshotProxyConfig(root)
  const runtimeA = snapshotRuntimeState()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const aLimits = { ...limits, max_output_tokens: 64 }
  const discoveringA = withRuntimeState(runtimeA, () => withRecordedTransport({
    fetch: async (request) => {
      assert.equal(request.path, "/models")
      started.resolve()
      await release.promise
      return Response.json({ data: [{ id: model, capabilities: { limits: aLimits } }] })
    },
    refresh: async () => { throw new Error("Unexpected credential refresh") },
  }, () => ensureCopilotModelCatalog(admittedA, model)))

  try {
    await started.promise
    root.copilotBaseUrl = providerB
    root.upstreamTimeoutMs = 9000
    root.claudeUpstreamApi = "chat-completions"
    runtimeState.upstreamBaseUrl = providerB
    runtimeState.modelRouting = { gptModel: "gpt-after", opusModel: "claude-after" }
    runtimeState.thinkEffort = "max"
    await admittedA.refreshCopilotToken?.("fixture-catalog-token", 1)
    const admittedB = snapshotProxyConfig(root)
    const runtimeB = snapshotRuntimeState()
    await withRuntimeState(runtimeB, () => withRecordedTransport({
      fetch: async (request) => {
        assert.equal(request.path, "/models")
        return Response.json({ data: [{ id: model, capabilities: { limits } }] })
      },
      refresh: async () => { throw new Error("Unexpected credential refresh") },
    }, () => ensureCopilotModelCatalog(admittedB, model)))

    assert.equal(root.modelCatalog, admittedB.modelCatalog, "Provider B publishes before provider A finishes")
    assert.equal(runtimeState.modelCatalog, admittedB.modelCatalog)
    release.resolve()
    await discoveringA
    assert.equal(root.modelCatalog, admittedB.modelCatalog)
    assert.equal(runtimeState.modelCatalog, admittedB.modelCatalog)
    assert.equal(runtimeA.modelCatalog, admittedA.modelCatalog)
    assert.equal(admittedA.modelCatalog?.baseUrl, providerA)
    assert.equal(admittedB.modelCatalog?.baseUrl, providerB)
    assert.equal(admittedA.copilotBaseUrl, providerA)
    assert.equal(admittedA.upstreamTimeoutMs, 1000)
    assert.equal(admittedA.claudeUpstreamApi, "auto")
    assert.equal(admittedA.copilotToken, "fixture-refreshed")
    assert.equal(admittedA.copilotTokenGeneration, 2)
    assert.equal(root.upstreamTimeoutMs, 9000)
    assert.equal(root.claudeUpstreamApi, "chat-completions")
    await withRuntimeState(runtimeA, async () => {
      assert.equal(routeModelId("opus"), "claude-before")
      assert.equal(resolveReasoningEffort(), "low")
      assert.equal(await boundModelOutputTokens(admittedA, model, 256), aLimits.max_output_tokens)
    })
    assert.equal(routeModelId("opus"), "claude-after")
    assert.equal(resolveReasoningEffort(), "max")
  } finally {
    release.resolve()
    await discoveringA
  }
})

test("concurrent request traces discover independently while same-config callers share their fetch", { timeout: 5000 }, async () => {
  const root = configFor(providerB)
  root.modelCatalog = { baseUrl: providerA, models: new Map() }
  runtimeState.modelCatalog = root.modelCatalog
  runtimeState.upstreamBaseUrl = providerB
  const first = snapshotProxyConfig(root)
  const second = snapshotProxyConfig(root)
  const firstRuntime = snapshotRuntimeState()
  const secondRuntime = snapshotRuntimeState()
  const firstTrace = await RequestTrace.create(randomUUID(), new Request("http://127.0.0.1/v1/messages"), first, firstRuntime, false)
  const secondTrace = await RequestTrace.create(randomUUID(), new Request("http://127.0.0.1/v1/messages"), second, secondRuntime, false)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let firstSignal: AbortSignal | undefined
  let secondSignal: AbortSignal | undefined
  const abandoned = withRuntimeState(firstRuntime, () => withRequestTrace(firstTrace, () => withRecordedTransport({
    fetch: async (request) => {
      firstSignal = request.signal
      started.resolve()
      await release.promise
      return Response.json({ data: [{ id: model, capabilities: { limits } }] })
    },
    refresh: async () => { throw new Error("Unexpected credential refresh") },
  }, () => Promise.allSettled([loadCopilotModelCatalog(first), loadCopilotModelCatalog(first)]))))

  try {
    await started.promise
    await withRuntimeState(secondRuntime, () => withRequestTrace(secondTrace, () => withRecordedTransport({
      fetch: async (request) => {
        secondSignal = request.signal
        return Response.json({ data: [{ id: model, capabilities: { limits } }] })
      },
      refresh: async () => { throw new Error("Unexpected credential refresh") },
    }, () => ensureCopilotModelCatalog(second, model))))
    assert.deepEqual(firstTrace.manifest.exchanges.map((exchange) => exchange.path), ["/models"])
    assert.deepEqual(secondTrace.manifest.exchanges.map((exchange) => exchange.path), ["/models"])
    assert.ok(firstSignal)
    assert.ok(secondSignal)
    assert.notEqual(firstSignal, secondSignal)
    firstTrace.controller.abort(new DOMException("First request cancelled", "AbortError"))
    assert.equal(firstSignal.aborted, true)
    assert.equal(secondSignal.aborted, false)
    release.resolve()
    for (const result of await abandoned) {
      assert.equal(result.status, "rejected")
      if (result.status === "rejected") assert.equal(result.reason.response.status, 499)
    }
    assert.equal(root.modelCatalog, second.modelCatalog)
    assert.equal(runtimeState.modelCatalog, second.modelCatalog)
    assert.equal(secondRuntime.modelCatalog, second.modelCatalog)
    assert.equal(first.modelCatalog?.baseUrl, providerA)
  } finally {
    release.resolve()
    await abandoned
    for (const trace of [firstTrace, secondTrace]) {
      trace.captureResponse(new Response(null))
      trace.handlerSettled()
    }
    await Promise.all([firstTrace.finished, secondTrace.finished])
  }
})
