import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-capture-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"
const { RequestTrace, withRequestTrace, withTraceObserver, recordedFetch, recordedRefresh, cleanupCaptures, flushCaptures } = await import("../../src/lib/request-trace")
const { flushLogs, log } = await import("../../src/lib/log")
const { paths, formatLogDate } = await import("../../src/lib/paths")
const config = { host: "127.0.0.1", port: 0, copilotBaseUrl: "https://fixture.invalid", copilotToken: "PRIVATE_CREDENTIAL", upstreamTimeoutMs: 1000, vsCodeVersion: "test" }

test.after(async () => {
  await flushCaptures()
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test("full captures preserve large bodies but exclude credential headers", async () => {
  const request = new Request("http://localhost/v1/messages", { method: "POST", headers: { authorization: "Bearer CLIENT_SECRET", "content-type": "application/json" }, body: JSON.stringify({ content: "x".repeat(12000) }) })
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000001", request, config, {}, true)
  const wrapped = trace.captureRequest(request)
  const requestBody = await wrapped.text()
  assert.equal(JSON.parse(requestBody).content.length, 12000)
  await withRequestTrace(trace, async () => {
    const response = await recordedFetch({ path: "/chat/completions", method: "POST", body: requestBody, headers: { authorization: "Bearer UPSTREAM_SECRET", "content-type": "application/json" }, upstreamRequestId: "fixture-id" }, async () => new Response(JSON.stringify({ id: "chat_fixture", choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2 } }), { headers: { "content-type": "application/json" } }))
    await response.text()
  })
  trace.handlerSettled()
  await trace.captureResponse(new Response('{"stop_reason":"end_turn"}', { headers: { "content-type": "application/json" } })).text()
  await trace.finished
  const dir = trace.captureDirectory!
  const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"))
  assert.equal(meta.captureState, "complete")
  assert.equal((await fs.readFile(path.join(dir, "client-request.bin"), "utf8")), requestBody)
  assert.equal((await fs.readFile(path.join(dir, "upstream-1-request.bin"), "utf8")), requestBody)
  assert.doesNotMatch(JSON.stringify(meta), /CLIENT_SECRET|UPSTREAM_SECRET|PRIVATE_CREDENTIAL|authorization/i)
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(dir, "meta.json"))).mode & 0o777, 0o600)
  }
})

test("diagnostic snapshots expose safe settled outcomes without bodies or capture files", async () => {
  const observed: Array<Awaited<ReturnType<typeof RequestTrace.create>>> = []
  const trace = await withTraceObserver((value) => {
    observed.push(value)
  }, () => RequestTrace.create(
    "10000000-0000-4000-8000-000000000017", new Request("http://localhost/v1/messages"), config, {}, false,
  ))
  trace.protectCredential("ROTATED_PRIVATE_CREDENTIAL")
  await withRequestTrace(trace, async () => {
    const response = await recordedFetch({ method: "POST", path: "/chat/completions", body: "PRIVATE_PROMPT", headers: {}, upstreamRequestId: "10000000-0000-4000-8000-000000000018" }, async () => Response.json({
      id: "msg_safe", model: "claude-opus-5.5", choices: [{ finish_reason: "content_filter" }],
      error: { code: "PRIVATE_ERROR", message: "PRIVATE_BODY" },
    }, { headers: { "x-request-id": "ROTATED_PRIVATE_CREDENTIAL", "x-github-request-id": "provider-safe-42" } }))
    await response.text()
  })
  trace.handlerSettled()
  await trace.captureResponse(Response.json({ stop_reason: "refusal" })).text()
  await trace.finished
  assert.deepEqual(observed, [trace])
  const result = trace.diagnosticSnapshot()
  assert.equal(result.requestId, trace.requestId)
  assert.equal(result.capture.state, "off")
  assert.equal(result.exchanges[0].path, "/chat/completions")
  assert.equal(result.exchanges[0].status, 200)
  assert.equal(result.exchanges[0].finishReason, "content_filter")
  assert.equal(result.exchanges[0].providerRequestId, "provider-safe-42")
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|ROTATED_|requestHeaders|responseHeaders|authorization/)
  assert.equal(trace.captureDirectory, undefined)
})

test("trace observers are request-scoped and cannot consume a response", async () => {
  const seen: string[][] = [[], []]
  await Promise.all(seen.map((ids, index) => withTraceObserver((trace) => {
    ids.push(trace.requestId)
  }, async () => {
    await Promise.resolve()
    const trace = await RequestTrace.create(`10000000-0000-4000-8000-00000000002${index}`, new Request("http://localhost/v1/messages"), config, {}, false)
    trace.handlerSettled()
    await trace.captureResponse(Response.json({ stop_reason: "end_turn" })).text()
    await trace.finished
  })))
  assert.deepEqual(seen, [["10000000-0000-4000-8000-000000000020"], ["10000000-0000-4000-8000-000000000021"]])
})

test("diagnostics distinguish pending, complete and incomplete private captures", async () => {
  const complete = await RequestTrace.create("10000000-0000-4000-8000-000000000022", new Request("http://localhost/v1/messages"), config, {}, true)
  assert.equal(complete.diagnosticSnapshot().capture.state, "pending")
  complete.handlerSettled()
  await complete.captureResponse(Response.json({ stop_reason: "end_turn" })).text()
  await complete.finished
  assert.equal(complete.diagnosticSnapshot().capture.state, "complete")

  const incomplete = await RequestTrace.create("10000000-0000-4000-8000-000000000023", new Request("http://localhost/v1/messages"), config, {}, true)
  const response = incomplete.captureResponse(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("partial"))
  } })))
  incomplete.handlerSettled()
  await response.body!.cancel()
  await incomplete.finished
  assert.equal(incomplete.diagnosticSnapshot().capture.state, "incomplete")
})

test("nondebug observations create no capture directory", async () => {
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000002", new Request("http://localhost/v1/messages"), config, {}, false)
  trace.handlerSettled()
  await trace.captureResponse(new Response("{}", { headers: { "content-type": "application/json" } })).text()
  await trace.finished
  assert.equal(trace.captureDirectory, undefined)
  const dates = await fs.readdir(path.join(paths.appDir, "captures")).catch(() => [])
  for (const date of dates) {
    assert(!(await fs.readdir(path.join(paths.appDir, "captures", date))).includes(trace.requestId))
  }
})

test("refresh failures are recorded without credentials or a fabricated retry", async () => {
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000003", new Request("http://localhost/v1/messages"), config, {}, true)
  await withRequestTrace(trace, async () => {
    await assert.rejects(recordedRefresh(async () => {
      throw new Error("PRIVATE_REFRESH_DETAIL")
    }))
  })
  trace.handlerSettled()
  await trace.captureResponse(new Response("{}", { headers: { "content-type": "application/json" } })).text()
  await trace.finished
  const meta = JSON.parse(await fs.readFile(path.join(trace.captureDirectory!, "meta.json"), "utf8"))
  assert.deepEqual(meta.refreshes.map((r: { outcome: string }) => r.outcome), ["failure"])
  assert.doesNotMatch(JSON.stringify(meta), /PRIVATE_REFRESH_DETAIL|PRIVATE_CREDENTIAL/)
})

const finishTrace = async (trace: Awaited<ReturnType<typeof RequestTrace.create>>, response = Response.json({ stop_reason: "end_turn" })) => {
  trace.handlerSettled()
  await trace.captureResponse(response).text()
  await trace.finished
  return JSON.parse(await fs.readFile(path.join(trace.captureDirectory!, "meta.json"), "utf8"))
}

test("metadata and completion logs omit query strings and echoed current or refreshed credentials", async (t) => {
  const lines: string[] = []
  t.mock.method(log, "info", (...values: unknown[]) => {
    lines.push(values.join(" "))
  })
  const request = new Request("http://localhost/v1/messages?secret=PRIVATE_QUERY", { headers: {
    authorization: "Bearer CLIENT_SECRET", "x-request-id": "CLIENT_SECRET",
  } })
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000004", request, config, {}, true)
  trace.protectCredential("REFRESHED_CREDENTIAL")
  const body = JSON.stringify({ id: "REFRESHED_CREDENTIAL", model: "PRIVATE_CREDENTIAL", stop_reason: "refusal", stop_details: { category: "PRIVATE_CREDENTIAL" } })
  await withRequestTrace(trace, async () => {
    const response = await recordedFetch({ path: "/v1/messages", method: "POST", headers: { "x-request-id": "REFRESHED_CREDENTIAL" }, upstreamRequestId: "fixture-id" }, async () => new Response(body, {
      headers: { "content-type": "application/json", "x-copilot-service-request-id": "PRIVATE_CREDENTIAL" },
    }))
    await response.text()
  })
  const meta = await finishTrace(trace, new Response(body, { headers: { "content-type": "application/json" } }))
  assert.equal(meta.path, "/v1/messages")
  assert.doesNotMatch(JSON.stringify(meta) + lines.join("\n"), /PRIVATE_QUERY|CLIENT_SECRET|PRIVATE_CREDENTIAL|REFRESHED_CREDENTIAL/)
  assert.equal(await fs.readFile(path.join(trace.captureDirectory!, "upstream-1-response.bin"), "utf8"), body)
})

test("capture queue overflow is explicit without truncating the delivered request", async () => {
  const body = "x".repeat(8 * 1024 * 1024 + 1)
  const request = new Request("http://localhost/v1/messages", { method: "POST", body })
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000005", request, config, {}, true)
  assert.equal(await trace.captureRequest(request).text(), body)
  const meta = await finishTrace(trace)
  assert.equal(meta.captureState, "incomplete")
  assert.equal(meta.captureError, "capture_queue_limit")
  assert.equal(meta.request.bytes, body.length)
})

test("capture appends refuse a replaced body file without touching its symlink target", { skip: process.platform === "win32" }, async (t) => {
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000006", new Request("http://localhost/v1/messages"), config, {}, true)
  const outside = path.join(home, "private-target")
  await fs.writeFile(outside, "untouched", { mode: 0o644 })
  const bodyFile = path.join(trace.captureDirectory!, "client-response.bin")
  const reader = trace.captureResponse(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("first"))
      controller.enqueue(Buffer.from("second"))
      controller.close()
    },
  }))).body!.getReader()
  await reader.read()
  await (trace as unknown as { queue: Promise<void> }).queue
  await fs.unlink(bodyFile)
  await fs.symlink(outside, bodyFile)
  t.after(async () => {
    await fs.unlink(bodyFile).catch(() => {})
    await fs.unlink(outside)
  })
  assert.equal(Buffer.from((await reader.read()).value!).toString(), "second")
  await reader.read()
  trace.handlerSettled()
  await trace.finished
  assert.equal(await fs.readFile(outside, "utf8"), "untouched")
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o644)
  assert.equal(trace.manifest.captureState, "incomplete")
})

test("client cancellation settles capture and prevents subsequent upstream work", async () => {
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000007", new Request("http://localhost/v1/messages"), config, {}, true)
  let upstreamCancelled = false
  await withRequestTrace(trace, () => recordedFetch({ path: "/v1/messages", method: "POST", headers: {}, upstreamRequestId: "fixture-id" }, async () => new Response(new ReadableStream({
    cancel() {
      upstreamCancelled = true
    },
  }))))
  const response = trace.captureResponse(new Response(new ReadableStream()))
  await response.body!.cancel()
  trace.handlerSettled()
  await trace.finished
  assert.equal(trace.signal.aborted, true)
  assert.equal(upstreamCancelled, true)
  assert.equal(trace.manifest.exchanges[0].response?.state, "cancelled")
  assert.equal(trace.manifest.captureState, "incomplete")
  let calls = 0
  await assert.rejects(withRequestTrace(trace, () => recordedFetch({ path: "/responses", method: "POST", headers: {}, upstreamRequestId: "late-id" }, async () => {
    calls++
    return Response.json({})
  })))
  assert.equal(calls, 0)
})

const seedCapture = async (date: string, suffix: string, state: "pending" | "complete", extra: Record<string, unknown> = {}) => {
  const id = `20000000-0000-4000-8000-${suffix.padStart(12, "0")}`
  const directory = path.join(paths.appDir, "captures", date, id)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ format: 1, requestId: id, captureState: state, handlerSettled: state === "complete", ...extra }))
  await fs.writeFile(path.join(directory, "client-request.bin"), "fixture")
  return directory
}

test("capture retention preserves another process's pending capture and unrelated files", async () => {
  const old = "2001-01-01"
  const complete = await seedCapture(old, "1", "complete")
  const active = await seedCapture(old, "2", "pending", { ownerPid: process.pid })
  const unknown = await seedCapture(old, "3", "pending")
  const foreign = await seedCapture(old, "4", "complete")
  await fs.writeFile(path.join(foreign, "notes.txt"), "not relay data")
  await cleanupCaptures(3)
  assert.equal(await fs.stat(complete).then(() => true, () => false), false)
  for (const directory of [active, unknown, foreign]) {
    assert.equal((await fs.stat(directory)).isDirectory(), true)
  }
})

test("capture retention rejects a symlinked root without removing target records", { skip: process.platform === "win32" }, async () => {
  const root = path.join(paths.appDir, "captures")
  const saved = path.join(paths.appDir, "captures-saved")
  const outside = path.join(home, "outside-captures")
  const directory = path.join(outside, "2001-01-01", "20000000-0000-4000-8000-000000000005")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({ format: 1, requestId: path.basename(directory), captureState: "complete", handlerSettled: true }))
  await fs.rename(root, saved)
  await fs.symlink(outside, root, "dir")
  try {
    await cleanupCaptures(3).catch(() => {})
    assert.equal((await fs.stat(path.join(directory, "meta.json"))).isFile(), true)
  } finally {
    await fs.unlink(root)
    await fs.rename(saved, root)
  }
})

test("handler completion cancels an unconsumed upstream body before final capture flush", async () => {
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000008", new Request("http://localhost/v1/messages"), config, {}, true)
  let cancelled = false
  await withRequestTrace(trace, () => recordedFetch({ path: "/responses", method: "POST", headers: {}, upstreamRequestId: "unused" }, async () => new Response(new ReadableStream({ cancel() {
    cancelled = true
  } }))))
  const meta = await finishTrace(trace)
  assert.equal(cancelled, true)
  assert.equal(meta.exchanges[0].response.state, "cancelled")
  assert.equal(meta.captureState, "incomplete")
})

test("finalization preserves a replacement regular metadata file", async () => {
  const trace = await RequestTrace.create("10000000-0000-4000-8000-000000000009", new Request("http://localhost/v1/messages"), config, {}, true)
  const file = path.join(trace.captureDirectory!, "meta.json")
  await fs.rename(file, path.join(trace.captureDirectory!, "meta.original.json"))
  await fs.writeFile(file, "replacement metadata")
  trace.handlerSettled()
  await trace.captureResponse(Response.json({ stop_reason: "end_turn" })).text()
  await trace.finished
  assert.equal(await fs.readFile(file, "utf8"), "replacement metadata")
  assert.equal(trace.manifest.captureState, "incomplete")
})

for (const native of [false, true]) {
  test(`upstream echoed bearer is excluded from ordinary ${native ? "native" : "chat"} error logs`, async () => {
    const { createServer } = await import("../../src/server")
    const { withRecordedTransport } = await import("../../src/lib/request-trace")
    const { setLogLevel } = await import("../../src/lib/log")
    const { getLogPath } = await import("../../src/lib/paths")
    const token = `ECHOED_PRIVATE_BEARER_${native ? "native" : "chat"}`
    setLogLevel("info")
    log.level = -999
    const response = await withRecordedTransport({ fetch: async () => Response.json({ error: { message: `Bearer ${token}` } }, { status: 400, headers: { "x-error-token": token } }), refresh: async () => {} }, () => createServer({ ...config, copilotToken: token, claudeUpstreamApi: native ? "messages" : "chat-completions" }).fetch(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "opus", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] }) })))
    assert.equal(response.status, 400)
    await response.text()
    await flushLogs()
    const logs = await fs.readFile(getLogPath(), "utf8")
    assert.equal(logs.includes(token), false, "An upstream echo disclosed the configured bearer in ordinary logs")
    assert.match(logs, /redacted/)
  })
}

test("capture retention keeps the cutoff local calendar day", async () => {
  const now = new Date(2026, 10, 2, 12)
  const oldest = new Date(now)
  oldest.setDate(oldest.getDate() - 2)
  const old = new Date(oldest)
  old.setDate(old.getDate() - 1)
  const keep = await seedCapture(formatLogDate(oldest), "6", "complete")
  const remove = await seedCapture(formatLogDate(old), "7", "complete")
  await cleanupCaptures(3, now)
  assert.equal((await fs.stat(keep)).isDirectory(), true)
  assert.equal(await fs.stat(remove).then(() => true, () => false), false)
})
