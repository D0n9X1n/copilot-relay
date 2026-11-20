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
const { getRequestTrace, withRecordedTransport, withTraceObserver } = await import("../../src/lib/request-trace")
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

// A catalog that predates the request and lacks its model, so admission refreshes it.
const staleCatalogConfig = (upstreamTimeoutMs: number): ProxyConfig => ({
  ...configFor(upstreamTimeoutMs),
  modelCatalog: { baseUrl: provider, models: new Map([["claude-opus-5.5", { type: "chat" }]]), fetchedAt: 0 },
})

const encoder = new TextEncoder()
const sse = (event: Record<string, unknown>) => encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)

// A Responses stream that sends text the relay forwards to the client, then stalls until its
// request's signal aborts; `aborted` records why.
const stallingTextStream = (signal: AbortSignal | undefined, aborted: Array<string>) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(sse({ type: "response.created", response: { id: "r", model, status: "in_progress", output: [] } }))
    controller.enqueue(sse({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } }))
    controller.enqueue(sse({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "m", delta: "Hel" }))
    signal?.addEventListener("abort", () => {
      aborted.push((signal.reason as Error).name)
      controller.error(signal.reason)
    }, { once: true })
  },
}), { status: 200, headers: { "content-type": "text/event-stream" } })

// Resolves after `ms`, or rejects when `signal` aborts first, as an upstream reply in flight does.
const after = (ms: number, signal: AbortSignal | undefined) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener("abort", () => {
    clearTimeout(timer)
    reject(signal.reason)
  }, { once: true })
})

const streamRequest = () => new Request("http://127.0.0.1/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hello" }] }),
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
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const app = createServer(staleCatalogConfig(5000))
  const paths: Array<string> = []
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async (request) => {
      paths.push(request.path)
      return request.path === "/models" ? catalog() : completed()
    },
    refresh: noRefresh,
  }, async () => {
    const response = await post(app)
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
  })

  const after = upstreamDeadlineCounts()
  assert.deepEqual(paths, ["/models", "/responses"])
  assert.equal(after.created - before.created, 1, "one deadline for the request, catalog included")
  assert.equal(after.disposed - before.disposed, 1, "disposed when the client body ended")
})

test("a client that cancels after the headers releases the request's deadline at once", async () => {
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  // A deadline far beyond the test, so only the cancel can release it.
  const app = createServer(probeConfig(60_000))
  const aborted: Array<string> = []
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async (request) => stallingTextStream(request.signal, aborted),
    refresh: noRefresh,
  }, async () => {
    const response = await app.fetch(streamRequest())
    const reader = response.body!.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value), /message_start/)

    const started = performance.now()
    await reader.cancel()
    assert.ok(performance.now() - started < 1000, "the cancel did not wait for the deadline")
  })

  await new Promise((resolve) => setImmediate(resolve))
  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1)
  assert.equal(after.disposed - before.disposed, 1)
  assert.deepEqual(aborted, ["AbortError"], "the cancel, not the deadline, ended the upstream call")
})

test("a stream that stalls after its headers is cut off at the request's deadline as a timeout", async () => {
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const app = createServer(probeConfig(150))
  const aborted: Array<string> = []
  const traces: Array<{ signal: AbortSignal }> = []
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async (request) => stallingTextStream(request.signal, aborted),
    refresh: noRefresh,
  }, () => withTraceObserver((trace) => traces.push(trace), async () => {
    const response = await app.fetch(streamRequest())
    const started = Date.now()
    const text = await response.text()

    assert.ok(Date.now() - started < 5000, "the stalled stream ended at the deadline")
    // The streamed error event's text is generic for any failure after the stream opens; what ended
    // this one is pinned below by the reason the upstream call was aborted with.
    assert.match(text, /event: error\n/)
  }))

  const after = upstreamDeadlineCounts()
  assert.deepEqual(aborted, ["TimeoutError"], "the deadline, not a cancel, ended the upstream call")
  assert.equal(traces[0]?.signal.aborted, false, "the deadline ends the upstream call, not the client trace")
  assert.equal(after.created - before.created, 1)
  assert.equal(after.disposed - before.disposed, 1)
})

test("a request rejected before any upstream call disposes its deadline with its response", async () => {
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const app = createServer(probeConfig(60_000))
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async () => assert.fail("no upstream call"),
    refresh: noRefresh,
  }, async () => {
    const response = await app.fetch(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 64, output_config: { effort: "loudest" }, messages: [{ role: "user", content: "hello" }] }),
    }))
    assert.equal(response.status, 400)
    await response.text()
  })

  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1)
  assert.equal(after.disposed - before.disposed, 1)
})

test("the WebSearch passes share one deadline, and a turn that crosses it times out", async () => {
  const opus = "claude-opus-4.8"
  runtimeState.modelRouting = { gptModel: model, opusModel: opus }
  runtimeState.upstreamBaseUrl = provider
  // Each pass alone fits in 400 ms; together they do not.
  const app = createServer({
    ...configFor(400),
    claudeUpstreamApi: undefined,
    modelCatalog: { baseUrl: provider, models: new Map([
      [opus, { type: "chat", supportedEndpoints: ["/chat/completions"] }],
      [model, { type: "chat", supportedEndpoints: ["/responses"] }],
    ]) },
  })
  const paths: Array<string> = []
  const traces: Array<{ signal: AbortSignal }> = []
  const before = upstreamDeadlineCounts()

  const response = await withRecordedTransport({
    fetch: async (request) => {
      paths.push(request.path)
      const pass = paths.length
      await after(pass < 3 ? 150 : 300, request.signal)
      if (request.path === "/responses") {
        return Response.json({
          id: "resp_web_search",
          created_at: 1,
          model,
          output: [
            { type: "web_search_call", action: { type: "search", query: "copilot docs", queries: ["copilot docs"] } },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "1. Docs - https://docs.github.com/en/copilot" }] },
          ],
          usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        })
      }

      const payload = JSON.parse(request.body ?? "{}") as { tools?: Array<{ function?: { name?: string } }> }
      const search = payload.tools?.find((tool) => /web_search|WebSearch/.test(tool.function?.name ?? ""))
      return Response.json({
        id: "chat",
        created: 1,
        model: opus,
        choices: [{
          index: 0,
          message: search
            ? { role: "assistant", content: null, tool_calls: [{ id: "call_search", type: "function", function: { name: search.function?.name, arguments: JSON.stringify({ query: "copilot docs" }) } }] }
            : { role: "assistant", content: "Found it." },
          finish_reason: search ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
    refresh: noRefresh,
  }, () => withTraceObserver((trace) => traces.push(trace), () => app.fetch(new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus",
      max_tokens: 64,
      messages: [{ role: "user", content: "search the web for copilot docs" }],
      tools: [{ name: "web_search", type: "web_search_20250305", max_uses: 1 }],
    }),
  }))))
  const body = await response.text()

  assert.deepEqual(paths, ["/chat/completions", "/responses", "/chat/completions"])
  assert.equal(response.status, 504, body)
  assert.match(body, /upstream_timeout/)
  assert.equal(traces[0]?.signal.aborted, false)
  const counts = upstreamDeadlineCounts()
  assert.equal(counts.created - before.created, 1, "one deadline for all three passes")
  assert.equal(counts.disposed - before.disposed, 1)
})

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

test("two concurrent requests discover separately, and cancelling one leaves the other intact", async () => {
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const app = createServer(staleCatalogConfig(5000))
  // Each /models reply sends its headers at once and holds its body until released.
  const catalogs: Array<{ release: () => void }> = []
  const bothHeadersSent = Promise.withResolvers<void>()
  const before = upstreamDeadlineCounts()

  await withRecordedTransport({
    fetch: async (request) => {
      if (request.path !== "/models") {
        return completed()
      }

      const payload = await catalog().text()
      let release = () => {}
      const response = new Response(new ReadableStream({
        start(controller) {
          release = () => {
            controller.enqueue(encoder.encode(payload))
            controller.close()
          }

          request.signal?.addEventListener("abort", () => controller.error(request.signal?.reason), { once: true })
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
      catalogs.push({ release })
      if (catalogs.length === 2) {
        bothHeadersSent.resolve()
      }

      return response
    },
    refresh: noRefresh,
  }, async () => {
    const first = new AbortController()
    // The cancelled request ends either before its response or while its body is read.
    const cancelled = post(app, first.signal).then((response) => response.text()).catch(() => {})
    const kept = post(app)

    await bothHeadersSent.promise
    first.abort(new DOMException("client went away", "AbortError"))
    await cancelled
    catalogs[1]?.release()

    const response = await kept
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
  })

  await new Promise((resolve) => setImmediate(resolve))
  const after = upstreamDeadlineCounts()
  assert.equal(catalogs.length, 2, "one catalog fetch per request")
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
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    growthBytes: number
    sampled: number
    reachable: number
    deadlines: { created: number; disposed: number }
  }

  // A request that kept its trace until a 180-second timer fired held about 11 KB each: 2,000
  // requests grew the heap by over 20 MiB. Freed traces leave at most 1 MiB.
  assert.equal(result.sampled, 20)
  assert.equal(result.reachable, 0, "no finished request's trace is still reachable")
  assert.ok(result.growthBytes <= 1024 * 1024, `heap grew ${result.growthBytes} bytes over 2,000 requests`)
  // Every request of the mixed run, warm-up included, owned one deadline and disposed it at the end
  // of its response, streamed or not: no timer is left pending.
  assert.equal(result.deadlines?.created, 3000, "one deadline per request")
  assert.equal(result.deadlines.disposed, result.deadlines.created, "every deadline disposed")
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

for (const route of ["/v1/messages", "/v1/responses"] as const) {
  test(`${route} answers a discovery error body that stalls past the deadline with its timeout`, async () => {
    runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
    runtimeState.upstreamBaseUrl = provider
    const app = createServer(staleCatalogConfig(80))
    const observed = { cancelled: false }
    const traces: Array<{ signal: AbortSignal }> = []

    const response = await withRecordedTransport({
      fetch: async (request) => {
        assert.equal(request.path, "/models", "only discovery is sent")
        return stalledError(request.signal, observed)
      },
      refresh: noRefresh,
    }, () => withTraceObserver((trace) => traces.push(trace), async () => app.fetch(new Request(`http://127.0.0.1${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(route === "/v1/messages"
        ? { model, max_tokens: 64, messages: [{ role: "user", content: "hello" }] }
        : { model, input: "hello" }),
    }))))

    const body = await response.text()
    assert.equal(response.status, 504, body)
    assert.match(body, /upstream_timeout/)
    assert.equal(traces.length, 1)
    assert.equal(traces[0]?.signal.aborted, false, "the client trace is not aborted")
  })
}

test("a deep run holds one catalog deadline, then one per probe, even a probe that never reaches the relay", async (t) => {
  t.mock.method(console, "log", () => {})
  const ids = [model, "gpt-6-nova"]
  const traces: Array<{ signal: AbortSignal }> = []
  const before = upstreamDeadlineCounts()

  const config = configFor(5000)
  const loaded = await withRecordedTransport({
    fetch: async () => Response.json({ data: ids.map((id) => ({ id, supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { reasoning_effort: ["low"] } } })) }),
    refresh: noRefresh,
  }, () => loadStandaloneModelCatalog(config))
  let counts = upstreamDeadlineCounts()
  assert.equal(counts.created - before.created, 1, "the catalog load's deadline")
  assert.equal(counts.disposed - before.disposed, 1, "disposed before any probe starts")

  await withRecordedTransport({
    fetch: async (request) => {
      const trace = getRequestTrace()
      if (trace) {
        traces.push(trace)
      }

      return Response.json({ ...JSON.parse(await completed().text()), model: (JSON.parse(request.body ?? "{}") as { model: string }).model })
    },
    refresh: noRefresh,
  }, () => probeModels(config, [...loaded.models], { maxTokens: 64, timeoutMs: 1000, totalTimeoutMs: 5000 }))
  counts = upstreamDeadlineCounts()
  assert.equal(traces.length, 2)
  assert.ok(traces.every((trace) => !trace.signal.aborted), "a finished probe leaves its client trace un-aborted")
  assert.equal(counts.created - before.created, 3, "one deadline per probe")
  assert.equal(counts.disposed - before.disposed, 3)

  // A header the probe cannot send ends it before the relay admits it.
  await withRecordedTransport({
    fetch: async () => assert.fail("no upstream call"),
    refresh: noRefresh,
  }, () => probeModels({ ...config, apiKey: "relay\nkey" }, [[model, loaded.models.get(model)!]], { maxTokens: 64, timeoutMs: 1000, totalTimeoutMs: 5000 }))
  counts = upstreamDeadlineCounts()
  assert.equal(counts.created - before.created, 4)
  assert.equal(counts.disposed - before.disposed, 4, "a probe that never reached the relay disposes its deadline")
})

test("preflight disposes its deadline when a model check fails", async () => {
  runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
  runtimeState.upstreamBaseUrl = provider
  const before = upstreamDeadlineCounts()

  await assert.rejects(withRecordedTransport({
    fetch: async (request) => request.path === "/models" ? catalog() : Response.json({ error: { message: "bad" } }, { status: 400 }),
    refresh: noRefresh,
  }, () => validateUpstream(configFor(5000), "low")), /Preflight failed for model=gpt-6-astra/)

  const after = upstreamDeadlineCounts()
  assert.equal(after.created - before.created, 1)
  assert.equal(after.disposed - before.disposed, 1)
})

test("a request whose rejected token triggers the shared refresh leaves its trace unreachable", async () => {
  const { execFile } = await import("node:child_process")
  const fixture = path.join(import.meta.dirname, "..", "fixtures", "refresh-trace-heap.ts")
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--expose-gc", "--import", "tsx", fixture], {
      cwd: path.join(import.meta.dirname, "..", ".."),
      timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }, (error, out) => {
      if (error) {
        reject(error)
        return
      }

      resolve(out)
    })
  })
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    exchanges: number
    ordinaryReachable: boolean
    refreshedReachable: boolean
    deadlines: { created: number; disposed: number }
  }

  // The second request's 401 ran the real token exchange once and was retried with the new token.
  assert.equal(result.exchanges, 1)
  assert.deepEqual(result.deadlines, { created: 2, disposed: 2 })
  assert.equal(result.ordinaryReachable, false, "an ordinary finished trace is collected")
  // The exchange reschedules the periodic refresh timer; that timer must not hold the request.
  assert.equal(result.refreshedReachable, false, "the refreshed request's finished trace is collected")
})
