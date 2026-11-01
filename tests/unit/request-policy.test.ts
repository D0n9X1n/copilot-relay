import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ProxyConfig } from "../../src/lib/config"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-policy-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { runtimeState, withRuntimeState, snapshotRuntimeState } = await import("../../src/lib/state")
const { routeModelId, resolveReasoningEffort } = await import("../../src/lib/models")
const { snapshotProxyConfig } = await import("../../src/lib/config")
const { ensureCopilotModelCatalog, boundModelOutputTokens } = await import("../../src/copilot/models")
const { shouldUseNativeMessages } = await import("../../src/copilot/native")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const { flushLogs } = await import("../../src/lib/log")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.thinkEffort
})

test("request policy stays fixed across a concurrent config reload", async () => {
  runtimeState.modelRouting = { gptModel: "gpt-before", opusModel: "opus-before" }
  runtimeState.thinkEffort = "low"
  const snapshot = snapshotRuntimeState()

  await withRuntimeState(snapshot, async () => {
    assert.equal(routeModelId("opus"), "opus-before")

    // A config reload lands while the request is still in flight.
    runtimeState.modelRouting = { gptModel: "gpt-after", opusModel: "opus-after" }
    runtimeState.thinkEffort = "max"
    await Promise.resolve()

    assert.equal(routeModelId("opus"), "opus-before")
    assert.equal(resolveReasoningEffort(), "low")
  })

  assert.equal(routeModelId("opus"), "opus-after")
})

test("frozen request policy still reads refreshed credentials from the provider", async () => {
  const source = {
    host: "127.0.0.1", port: 0, copilotBaseUrl: "http://provider-before.invalid",
    copilotToken: "fixture-old", copilotTokenGeneration: 1, upstreamTimeoutMs: 3000, vsCodeVersion: "test",
    refreshCopilotToken: async () => {
      source.copilotToken = "fixture-new"
      source.copilotTokenGeneration++
    },
  }
  const snapshot = snapshotProxyConfig(source)
  source.copilotBaseUrl = "http://provider-after.invalid"
  source.upstreamTimeoutMs = 9000
  await snapshot.refreshCopilotToken?.("fixture-old", 1)

  assert.equal(snapshot.copilotBaseUrl, "http://provider-before.invalid")
  assert.equal(snapshot.upstreamTimeoutMs, 3000)
  assert.equal(snapshot.copilotToken, "fixture-new")
  assert.equal(snapshot.copilotTokenGeneration, 2)
})

test("catalog assurance preserves optional discovery and refreshes before native policy selection", async () => {
  const baseUrl = "https://catalog-policy.invalid"
  const model = "claude-policy-model"
  const limits = { max_context_window_tokens: 1000, max_prompt_tokens: 900, max_output_tokens: 128 }
  const config: ProxyConfig = {
    host: "127.0.0.1", port: 0, copilotBaseUrl: baseUrl, copilotToken: "fixture-policy-token",
    upstreamTimeoutMs: 1000, vsCodeVersion: "test", claudeUpstreamApi: "auto",
  }
  let discoveries = 0
  const runtime = { upstreamBaseUrl: baseUrl }

  await withRuntimeState(runtime, () => withRecordedTransport({
    fetch: async (request) => {
      assert.equal(request.method, "GET")
      assert.equal(request.path, "/models")
      discoveries++
      return Response.json({ data: [{ id: model, supported_endpoints: ["/v1/messages"], capabilities: { limits } }] })
    },
    refresh: async () => {
      throw new Error("Unexpected credential refresh")
    },
  }, async () => {
    // Embedders without preflight must not trigger discovery.
    await ensureCopilotModelCatalog(config, model)
    assert.equal(await boundModelOutputTokens(config, model, 256), 256)
    assert.equal(discoveries, 0)
    assert.equal(config.modelCatalog, undefined)

    // A current catalog that already lists the model is used as is.
    config.modelCatalog = { baseUrl, models: new Map([[model, {}]]) }
    const current = config.modelCatalog
    await ensureCopilotModelCatalog(config, model)
    assert.equal(config.modelCatalog, current)
    assert.equal(discoveries, 0)

    // A catalog from another base URL, or one that lacks the model, is
    // rediscovered before native selection.
    for (const stale of [true, false]) {
      config.modelCatalog = {
        baseUrl: stale ? "https://old-policy.invalid" : baseUrl,
        models: stale ? new Map([[model, {}]]) : new Map(),
      }
      assert.equal(shouldUseNativeMessages(config, model), false)
      await ensureCopilotModelCatalog(config, model)
      assert.equal(shouldUseNativeMessages(config, model), true)
      assert.equal(await boundModelOutputTokens(config, model, 256), limits.max_output_tokens)
      assert.equal(discoveries, stale ? 1 : 2)
    }
  }))
})

test("a freshly discovered catalog that lacks a model is trusted for a minute before rediscovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 })
  const baseUrl = "https://catalog-unlisted.invalid"
  const config: ProxyConfig = {
    host: "127.0.0.1", port: 0, copilotBaseUrl: baseUrl, copilotToken: "fixture-unlisted-token",
    upstreamTimeoutMs: 1000, vsCodeVersion: "test",
    modelCatalog: { baseUrl, models: new Map() },
  }
  let discoveries = 0

  await withRuntimeState({ upstreamBaseUrl: baseUrl }, () => withRecordedTransport({
    fetch: async () => {
      discoveries++
      return Response.json({ data: [{ id: "listed-model" }] })
    },
    refresh: async () => {
      throw new Error("Unexpected credential refresh")
    },
  }, async () => {
    // A catalog the relay did not fetch itself carries no fetch time, so it is rediscovered.
    await ensureCopilotModelCatalog(config, "unlisted-model")
    assert.equal(discoveries, 1)

    // The catalog just fetched does not list the model either: no second round trip.
    await ensureCopilotModelCatalog(snapshotProxyConfig(config), "unlisted-model")
    assert.equal(discoveries, 1)

    t.mock.timers.tick(59_999)
    await ensureCopilotModelCatalog(config, "unlisted-model")
    assert.equal(discoveries, 1)

    // Once it is a minute old, a missing model is looked for again, so a newly added one is found.
    t.mock.timers.tick(1)
    await ensureCopilotModelCatalog(config, "unlisted-model")
    assert.equal(discoveries, 2)
  }))
})

// Why: one request judges catalog freshness once, at admission. Judging it whenever a later pass
// asks would let a capture and its faster offline replay disagree on whether to rediscover.
test("catalog freshness is judged when the request was admitted, not when a later pass asks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 5_000_000 })
  const baseUrl = "https://catalog-admitted.invalid"
  const root: ProxyConfig = {
    host: "127.0.0.1", port: 0, copilotBaseUrl: baseUrl, copilotToken: "fixture-admitted-token",
    upstreamTimeoutMs: 1000, vsCodeVersion: "test",
    modelCatalog: { baseUrl, models: new Map(), fetchedAt: 5_000_000 - 59_999 },
  }
  let discoveries = 0

  await withRuntimeState({ upstreamBaseUrl: baseUrl }, () => withRecordedTransport({
    fetch: async () => {
      discoveries++
      return Response.json({ data: [] })
    },
    refresh: async () => {
      throw new Error("Unexpected credential refresh")
    },
  }, async () => {
    const admitted = snapshotProxyConfig(root)
    assert.equal(admitted.admittedAt, 5_000_000)

    // The catalog turns a minute old while the request is in flight; the request still trusts it.
    t.mock.timers.tick(10)
    await ensureCopilotModelCatalog(admitted, "unlisted-model")
    assert.equal(discoveries, 0)

    // A request admitted now finds it too old and looks again.
    await ensureCopilotModelCatalog(snapshotProxyConfig(root), "unlisted-model")
    assert.equal(discoveries, 1)
  }))
})
