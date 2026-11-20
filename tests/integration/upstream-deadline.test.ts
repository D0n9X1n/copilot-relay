import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ProxyConfig } from "../../src/lib/config"

// src/lib/paths reads the home directory on import, so redirect HOME and USERPROFILE (Windows) first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-upstream-deadline-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { createUpstreamDeadline, upstreamDeadlineCounts } = await import("../../src/lib/deadline")
const { loadCopilotModelCatalog, loadStandaloneModelCatalog } = await import("../../src/copilot/models")
const { createServer } = await import("../../src/server")
const { getRequestTrace, withRecordedTransport } = await import("../../src/lib/request-trace")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs } = await import("../../src/lib/log")
const { HTTPError } = await import("../../src/lib/error")

const provider = "https://deadline.invalid"
const model = "gpt-6-astra"
const configFor = (upstreamTimeoutMs: number): ProxyConfig => ({
  host: "127.0.0.1",
  port: 0,
  copilotBaseUrl: provider,
  copilotToken: "fixture-deadline-token",
  upstreamTimeoutMs,
  vsCodeVersion: "test",
  claudeUpstreamApi: "auto",
})

const catalog = () => Response.json({ data: [
  { id: model, supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { reasoning_effort: ["low", "medium", "high"] } } },
  { id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"], capabilities: { type: "chat" } },
] })

const completed = () => Response.json({
  id: "resp_ok",
  model,
  created_at: 1,
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
})

const noRefresh = async () => {
  throw new Error("Unexpected credential refresh")
}

const post = async (app: ReturnType<typeof createServer>, signal?: AbortSignal): Promise<Response> => app.fetch(new Request("http://127.0.0.1/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }),
  ...(signal && { signal }),
}))

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
  delete runtimeState.modelRouting
})

test("a deadline of 0 creates no timer and never aborts", () => {
  const before = upstreamDeadlineCounts()
  const deadline = createUpstreamDeadline(0)

  assert.equal(deadline.signal.aborted, false)
  deadline.dispose()
  assert.deepEqual(upstreamDeadlineCounts(), before)
})

test("a deadline aborts with a TimeoutError, and disposing it clears its timer once", async () => {
  const before = upstreamDeadlineCounts()
  const deadline = createUpstreamDeadline(20)
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(deadline.signal.aborted, true)
  assert.equal((deadline.signal.reason as Error).name, "TimeoutError")
  deadline.dispose()
  deadline.dispose()

  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1)
  assert.equal(after.disposed - before.disposed, 1)
})

test("a relay request that needs discovery owns one deadline, disposed when its body ends", async () => {
  const config = configFor(5000)
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const app = createServer(config)
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async (request) => request.path === "/models" ? catalog() : completed(),
    refresh: noRefresh,
  }, async () => {
    const response = await post(app)
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
  })

  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1, "one deadline for the request, catalog included")
  assert.equal(after.disposed - before.disposed, 1, "disposed when the client body ended")
})

test("a client that cancels after the headers releases the request's deadline", async () => {
  const config = configFor(5000)
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  runtimeState.modelCatalog = undefined
  const app = createServer(config)
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async (request) => {
      if (request.path === "/models") {
        return catalog()
      }

      // A stream that sends one event, then stalls until the request is cancelled.
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"model\":\"gpt-6-astra\",\"status\":\"in_progress\",\"output\":[]}}\n\n"))
          request.signal?.addEventListener("abort", () => controller.error(request.signal?.reason), { once: true })
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } })
    },
    refresh: noRefresh,
  }, async () => {
    const response = await app.fetch(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hello" }] }),
    }))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
  })

  await new Promise((resolve) => setImmediate(resolve))
  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1)
  assert.equal(after.disposed - before.disposed, 1)
})

test("a stream that stalls after its headers is cut off at the request's deadline", async () => {
  const config = configFor(150)
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const app = createServer(config)

  await withRecordedTransport({
    fetch: async (request) => {
      if (request.path === "/models") {
        return catalog()
      }

      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"model\":\"gpt-6-astra\",\"status\":\"in_progress\",\"output\":[]}}\n\n"))
          request.signal?.addEventListener("abort", () => controller.error(request.signal?.reason), { once: true })
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } })
    },
    refresh: noRefresh,
  }, async () => {
    const response = await app.fetch(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hello" }] }),
    }))
    const started = Date.now()
    const text = await response.text()

    assert.ok(Date.now() - started < 5000, "the stalled stream ended at the deadline")
    assert.match(text, /timed out|upstream_timeout|error/)
  })
})

// A failed reply whose body never ends until its request's signal aborts, as a stalled upstream sends it.
// The error a promise rejects with, so a test can read its response body.
const rejection = async (promise: Promise<unknown>): Promise<InstanceType<typeof HTTPError>> => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof HTTPError, `expected an HTTPError, got ${String(error)}`)
    return error
  }

  assert.fail("expected the promise to reject")
}

const stalledError = (signal: AbortSignal | undefined, observed: { cancelled: boolean }) => new Response(new ReadableStream({
  start(controller) {
    signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true })
  },
  cancel() {
    observed.cancelled = true
  },
}), { status: 400, headers: { "content-type": "application/json" } })

test("a catalog load given its caller's signal starts no timer of its own", async (t) => {
  const timeouts = t.mock.method(AbortSignal, "timeout")

  for (const outcome of ["success", "error", "abort"] as const) {
    const config = configFor(5000)
    const cancel = new AbortController()
    const before = upstreamDeadlineCounts()

    const load = withRecordedTransport({
      fetch: async (request) => {
        if (outcome === "abort") {
          queueMicrotask(() => cancel.abort(new DOMException("cancelled", "AbortError")))
          return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true }))
        }

        return outcome === "success" ? catalog() : new Response("boom", { status: 400 })
      },
      refresh: noRefresh,
    }, () => loadCopilotModelCatalog(config, cancel.signal))

    if (outcome === "success") {
      await load
    } else {
      await assert.rejects(load)
    }

    assert.deepEqual(upstreamDeadlineCounts(), before, `${outcome}: the loader creates no deadline of its own`)
  }

  assert.equal(timeouts.mock.callCount(), 0, "no per-call timer")
})

test("a standalone catalog load owns one deadline and disposes it once the load has settled", async (t) => {
  const timeouts = t.mock.method(AbortSignal, "timeout")

  const before = upstreamDeadlineCounts()
  await withRecordedTransport({ fetch: async () => catalog(), refresh: noRefresh }, () => loadStandaloneModelCatalog(configFor(5000)))
  let after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1, "success: one deadline")
  assert.equal(after.disposed - before.disposed, 1, "success: disposed")

  // An error reply's body is read inside the deadline: a stalled one ends at the deadline as a
  // timeout, and the error the command handles holds a settled copy.
  const observed = { cancelled: false }
  let upstreamSignal: AbortSignal | undefined
  const failed = withRecordedTransport({
    fetch: async (request) => {
      upstreamSignal = request.signal
      return stalledError(request.signal, observed)
    },
    refresh: noRefresh,
  }, () => loadStandaloneModelCatalog(configFor(30)))
  const timedOut = await rejection(failed)
  assert.equal(timedOut.response.status, 504)
  assert.match(await timedOut.response.text(), /upstream_timeout/)
  assert.equal(upstreamSignal?.aborted, true, "error: the stalled body was cut off at the deadline")
  after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 2, "error: one deadline")
  assert.equal(after.disposed - before.disposed, 2, "error: disposed after the body settled")

  // A reply that never arrives is aborted at the deadline.
  await assert.rejects(withRecordedTransport({
    fetch: (request) => new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })),
    refresh: noRefresh,
  }, () => loadStandaloneModelCatalog(configFor(30))), (error: InstanceType<typeof HTTPError>) => error.response.status === 504)
  after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 3, "abort: one deadline")
  assert.equal(after.disposed - before.disposed, 3, "abort: disposed")

  assert.equal(timeouts.mock.callCount(), 0)
})

test("a standalone catalog error's readable body is settled before its deadline is disposed", async () => {
  const before = upstreamDeadlineCounts()
  const failed = withRecordedTransport({
    fetch: async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
    refresh: noRefresh,
  }, () => loadStandaloneModelCatalog(configFor(5000)))

  const error = await rejection(failed)
  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1)
  assert.equal(after.disposed - before.disposed, 1, "disposed before the command reads the error")
  assert.equal(error.response.status, 400)
  assert.deepEqual(await error.response.json(), { error: "bad request" })
})

test("two concurrent requests keep their own deadlines when one is cancelled", async () => {
  const config = configFor(5000)
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const app = createServer(config)
  const catalogReleased = Promise.withResolvers<void>()
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async (request) => {
      if (request.path === "/models") {
        // Both requests wait here, so the first is cancelled while discovery is shared.
        await catalogReleased.promise
        return catalog()
      }

      return completed()
    },
    refresh: noRefresh,
  }, async () => {
    const first = new AbortController()
    const cancelled = post(app, first.signal).then(async (response) => {
      await response.text()
    }, () => {})
    const kept = post(app)
    await new Promise((resolve) => setImmediate(resolve))
    first.abort(new DOMException("client went away", "AbortError"))
    catalogReleased.resolve()

    const response = await kept
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
    await cancelled
  })

  await new Promise((resolve) => setImmediate(resolve))
  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 2, "one deadline per request")
  assert.equal(after.disposed - before.disposed, 2, "both released")
})

test("finished requests leave no trace reachable and barely grow the heap", async () => {
  const { execFile } = await import("node:child_process")
  const fixture = path.join(import.meta.dirname, "..", "fixtures", "deadline-heap.ts")
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--expose-gc", "--import", "tsx", fixture], {
      cwd: path.join(import.meta.dirname, "..", ".."),
      timeout: 120_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }, (error, out) => {
      if (error) {
        reject(error)
        return
      }

      resolve(out)
    })
  })
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as { growthBytes: number; sampled: number; reachable: number }

  // A request that kept its trace until a 180-second timer fired held about 11 KB each: 2,000
  // requests grew the heap by over 20 MiB. Freed traces leave only runtime bookkeeping.
  assert.equal(result.sampled, 20)
  assert.equal(result.reachable, 0, "no finished request's trace is still reachable")
  assert.ok(result.growthBytes < 8 * 1024 * 1024, `heap grew ${result.growthBytes} bytes over 2,000 requests`)
})

const { probeModels } = await import("../../src/lib/model-probe")

const probeModel = { type: "chat", supportedEndpoints: ["/responses"], reasoningEfforts: ["low"] }
const probeConfig = (upstreamTimeoutMs: number): ProxyConfig => ({
  ...configFor(upstreamTimeoutMs),
  modelCatalog: { baseUrl: provider, models: new Map([[model, probeModel]]) },
})

const probeOnce = async (
  t: import("node:test").TestContext,
  config: ProxyConfig,
  fetch: Parameters<typeof withRecordedTransport>[0]["fetch"],
): Promise<string> => {
  const lines: Array<string> = []
  t.mock.method(console, "log", (line: string) => {
    lines.push(line)
  })
  await withRecordedTransport({ fetch, refresh: noRefresh }, () => probeModels(config, [[model, probeModel]], {
    maxTokens: 64,
    timeoutMs: 1000,
    totalTimeoutMs: 5000,
  }))
  t.mock.restoreAll()
  return lines.join("\n")
}

test("a probe whose own deadline fires times out without aborting its client trace", async (t) => {
  const seen: Array<{ upstream: string | undefined; traceAborted: boolean }> = []

  const output = await probeOnce(t, probeConfig(60), async (request) => {
    const trace = getRequestTrace()
    await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }))
    seen.push({ upstream: (request.signal?.reason as Error | undefined)?.name, traceAborted: trace?.signal.aborted ?? true })
    throw request.signal?.reason
  })

  assert.deepEqual(seen, [{ upstream: "TimeoutError", traceAborted: false }])
  assert.match(output, /Timed out/)
  assert.doesNotMatch(output, /Upstream timeout \(504\)/)
})

test("a real upstream 504 before the probe's deadline is reported as the upstream's timeout", async (t) => {
  const output = await probeOnce(t, probeConfig(5000), async () => Response.json(
    { error: { message: "gateway timeout", code: "upstream_timeout" } },
    { status: 504 },
  ))

  assert.match(output, /Upstream timeout \(504\)/)
  assert.doesNotMatch(output, /Timed out/)
})

const { validateUpstream } = await import("../../src/lib/preflight")
const { createChatCompletions } = await import("../../src/copilot/chat")

const nativeMessage = () => Response.json({
  id: "msg_ok",
  type: "message",
  role: "assistant",
  model: "claude-opus-5.5",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
})

test("preflight owns one deadline across discovery and every model check", async (t) => {
  const timeouts = t.mock.method(AbortSignal, "timeout")
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const paths: Array<string> = []
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async (request) => {
      paths.push(request.path)
      if (request.path === "/models") {
        return catalog()
      }

      return request.path === "/v1/messages" ? nativeMessage() : completed()
    },
    refresh: noRefresh,
  }, () => validateUpstream(configFor(5000), "low"))

  const after = upstreamDeadlineCounts()
  assert.deepEqual(paths, ["/models", "/responses", "/v1/messages"])
  assert.equal(after.created - before.created, 1, "one deadline for the whole preflight")
  assert.equal(after.disposed - before.disposed, 1)
  assert.equal(timeouts.mock.callCount(), 0, "no per-call timer")
})

test("a Copilot call given its caller's signal starts no timer of its own", async (t) => {
  const timeouts = t.mock.method(AbortSignal, "timeout")
  const config: ProxyConfig = {
    ...configFor(500),
    modelCatalog: { baseUrl: provider, models: new Map([[model, { type: "chat", supportedEndpoints: ["/responses"] }]]) },
  }
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async () => completed(),
    refresh: noRefresh,
  }, () => createChatCompletions(config, {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
  }, { signal: new AbortController().signal, timeoutMs: 500 }))

  assert.deepEqual(upstreamDeadlineCounts(), before)
  assert.equal(timeouts.mock.callCount(), 0)
})

test("preflight reads a failed catalog body inside its deadline and times out a stalled one", async () => {
  const observed = { cancelled: false }
  let upstreamSignal: AbortSignal | undefined
  const before = upstreamDeadlineCounts()

  const error = await rejection(withRecordedTransport({
    fetch: async (request) => {
      upstreamSignal = request.signal
      return stalledError(request.signal, observed)
    },
    refresh: noRefresh,
  }, () => validateUpstream(configFor(30), "low")))

  assert.equal(error.response.status, 504)
  assert.equal(upstreamSignal?.aborted, true, "the stalled body was cut off at the deadline")
  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1)
  assert.equal(after.disposed - before.disposed, 1)
})
