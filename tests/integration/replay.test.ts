import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs/promises"
import { createServer as createHttpServer, type IncomingHttpHeaders, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import test, { type TestContext } from "node:test"
import { isDeepStrictEqual } from "node:util"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-replay-integration-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"
const { replayCapture } = await import("../../src/replay")
const { createServer } = await import("../../src/server")
const { withRecordedTransport, flushCaptures } = await import("../../src/lib/request-trace")
const { withRuntimeState, runtimeState } = await import("../../src/lib/state")
const { withoutLogging, flushLogs, setLogLevel } = await import("../../src/lib/log")
const { paths } = await import("../../src/lib/paths")
type CaptureManifest = import("../../src/lib/request-trace").CaptureManifest
type CapturedBody = import("../../src/lib/request-trace").CapturedBody
type RecordedRequest = import("../../src/lib/request-trace").RecordedRequest
type RuntimeState = import("../../src/lib/state").RuntimeState
type ProxyConfig = import("../../src/lib/config").ProxyConfig

test.after(async () => {
  await withinDeadline(flushCaptures(), "Final capture flush")
  await withinDeadline(flushLogs(), "Final log flush")
  await fs.rm(home, { recursive: true, force: true })
})

const requestId = "10000000-0000-4000-8000-000000000088"
const baseUrl = "https://fixture.invalid"
const clientPayload = { model: "opus", max_tokens: 32, messages: [{ role: "user", content: "PRIVATE_PROMPT" }] }
const chatResponse = (text = "PRIVATE_RESPONSE") => ({
  id: "chat_provider_id", object: "chat.completion", created: 123,
  model: "claude-test", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
})

const fixture = async (options: {
  payload?: unknown
  runtime?: RuntimeState
  respond?: (request: RecordedRequest, attempt: number) => Response
  refresh?: "success" | "failure" | "cancelled"
} = {}) => {
  const directory = await fs.mkdtemp(path.join(home, "capture-"))
  const config = { host: "localhost", port: 0, copilotBaseUrl: baseUrl, copilotToken: "fixture-not-a-credential", upstreamTimeoutMs: 1000, vsCodeVersion: "test", modelCatalog: options.runtime?.modelCatalog, refreshCopilotToken: async () => {
    throw new Error("Actual refresh is forbidden")
  } }
  const runtime: RuntimeState = { modelRouting: { gptModel: "gpt-test", opusModel: "claude-test" }, thinkEffort: "low", upstreamBaseUrl: baseUrl, ...options.runtime }
  const payload = JSON.stringify(options.payload ?? clientPayload)
  const writeBody = async (file: string, bytes: Uint8Array): Promise<CapturedBody> => {
    await fs.writeFile(path.join(directory, file), bytes)
    return { file, bytes: bytes.length, chunks: [bytes.length], state: "complete" }
  }

  const manifest: CaptureManifest = {
    format: 1, relayVersion: "0.4.0", requestId,
    method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    startedAt: "2026-09-30T00:00:00.000Z", captureState: "complete", handlerSettled: true,
    request: await writeBody("client-request.bin", Buffer.from(payload)), exchanges: [], refreshes: [],
    config: { host: config.host, port: config.port, upstreamTimeoutMs: config.upstreamTimeoutMs, vsCodeVersion: config.vsCodeVersion },
    runtime: { modelRouting: runtime.modelRouting, thinkEffort: runtime.thinkEffort,
      ...(runtime.modelCatalog && { models: [...runtime.modelCatalog.models], catalogCurrent: runtime.modelCatalog.baseUrl === baseUrl }) },
  }
  const requests: RecordedRequest[] = []
  let operation = 0
  const response = await withoutLogging(() => withRuntimeState(runtime, () => withRecordedTransport({
    fetch: async (request) => {
      requests.push(request)
      const order = ++operation
      const exchange: CaptureManifest["exchanges"][number] = { order, method: request.method, path: request.path, upstreamRequestId: request.upstreamRequestId,
        requestHeaders: { accept: new Headers(request.headers).get("accept") ?? "application/json" },
        request: await writeBody(`upstream-${order}-request.bin`, Buffer.from(request.body ?? "")),
      }
      manifest.exchanges.push(exchange)
      try {
        const response = options.respond?.(request, requests.length) ?? Response.json(chatResponse())
        const bytes = new Uint8Array(await response.clone().arrayBuffer())
        exchange.response = await writeBody(`upstream-${order}-response.bin`, bytes)
        exchange.status = response.status
        exchange.responseHeaders = Object.fromEntries(response.headers)
        return response
      } catch (error) {
        exchange.error = (error as Error).name
        throw error
      }
    },
    refresh: async () => {
      if (!options.refresh) {
        throw new Error("Unexpected fixture refresh")
      }

      const error = options.refresh === "cancelled" ? "AbortError" : "Error"
      manifest.refreshes.push({ order: ++operation, outcome: options.refresh, ...(options.refresh !== "success" && { error }) })
      if (options.refresh !== "success") {
        throw Object.assign(new Error("Recorded refresh failed"), { name: error })
      }
    },
  }, async () => {
    const response = await createServer(config).fetch(new Request("http://localhost/v1/messages", { method: "POST", headers: manifest.headers, body: payload }))
    const bytes = new Uint8Array(await response.arrayBuffer())
    manifest.requestId = response.headers.get("x-copilot-relay-request-id")!
    manifest.status = response.status
    manifest.responseHeaders = { "content-type": response.headers.get("content-type")! }
    manifest.response = await writeBody("client-response.bin", bytes)
    return Buffer.from(bytes).toString()
  })))
  const save = async () => fs.writeFile(path.join(directory, "meta.json"), JSON.stringify(manifest))
  await save()
  return { directory, manifest, response, requests, save }
}

for (const current of [true, false]) {
  test(`reconstructs ${current ? "current" : "stale"} catalog and consumes recorded discovery only when needed`, async () => {
    const f = await fixture({
      runtime: { modelCatalog: { baseUrl: current ? baseUrl : "https://old.invalid", models: new Map([["claude-test", { limits: { max_context_window_tokens: 1000, max_prompt_tokens: 900, max_output_tokens: 8 } }]]) } },
      respond: (request) => request.path === "/models" ? Response.json({ data: [{ id: "claude-test", capabilities: { limits: { max_context_window_tokens: 1000, max_prompt_tokens: 900, max_output_tokens: 8 } } }] }) : Response.json(chatResponse()),
    })
    assert.deepEqual(f.requests.map((request) => request.path), current ? ["/chat/completions"] : ["/models", "/chat/completions"])
    assert.equal((await replayCapture(f.directory)).verdict, "MATCH")
  })
}

for (const outcome of ["success", "failure", "cancelled"] as const) {
  test(`replays ordered authentication refresh ${outcome} without auth callbacks`, async () => {
    const f = await fixture({ refresh: outcome, respond: (_request, attempt) => attempt === 1 ? new Response("Forbidden", { status: 401 }) : Response.json(chatResponse()) })
    assert.equal(f.manifest.refreshes[0].outcome, outcome)
    assert.equal(f.manifest.refreshes[0].order, 2)
    const result = await replayCapture(f.directory)
    assert.equal(result.verdict, "MATCH")
    assert.equal(result.exitCode, 0)
  })
}

test("preserves recorded transport error names and retry order", async () => {
  const f = await fixture({ respond: (_request, attempt) => {
    if (attempt === 1) {
      throw new TypeError("PRIVATE_TRANSPORT_ERROR")
    }

    return Response.json(chatResponse())
  } })
  assert.equal(f.manifest.exchanges[0].error, "TypeError")
  assert.equal((await replayCapture(f.directory)).verdict, "MATCH")
  const timedOut = await fixture({ respond: () => {
    throw new DOMException("PRIVATE_TIMEOUT", "TimeoutError")
  } })
  assert.equal(timedOut.manifest.status, 504)
  assert.equal(timedOut.requests.length, 1)
  assert.equal((await replayCapture(timedOut.directory)).verdict, "MATCH")
})

test("client SSE comparison ignores framing but checks ordered semantic events", async () => {
  const upstream = [
    { id: "chat_stream", created: 123, model: "claude-test", choices: [{ index: 0, delta: { role: "assistant", content: "PRIVATE_RESPONSE" }, finish_reason: null }] },
    { id: "chat_stream", created: 123, model: "claude-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
  const f = await fixture({ payload: { ...clientPayload, stream: true }, respond: () => new Response(upstream, { headers: { "content-type": "text/event-stream" } }) })
  const expected = f.response.replaceAll("\n", "\r\n")
  await fs.writeFile(path.join(f.directory, "client-response.bin"), expected)
  f.manifest.response!.bytes = Buffer.byteLength(expected)
  f.manifest.response!.chunks = [1, f.manifest.response!.bytes - 1]
  f.manifest.exchanges[0].response!.chunks = [3, 1, f.manifest.exchanges[0].response!.bytes - 4]
  await f.save()
  assert.equal((await replayCapture(f.directory)).verdict, "MATCH")
  const changed = expected.replace("PRIVATE_RESPONSE", "PRIVATE_DIFFERENT")
  await fs.writeFile(path.join(f.directory, "client-response.bin"), changed)
  f.manifest.response!.bytes = Buffer.byteLength(changed)
  f.manifest.response!.chunks = [f.manifest.response!.bytes]
  await f.save()
  const result = await replayCapture(f.directory)
  assert.equal(result.verdict, "DIFF")
  assert.match(result.differences.map((difference) => difference.path).join(" "), /client\.body\[\d+\]\.data\.delta\.text/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RESPONSE|PRIVATE_DIFFERENT/)
})

test("replay reports bounded per-exchange outcome and usage without trusting arbitrary metadata", async () => {
  const f = await fixture()
  f.manifest.exchanges[0].outcome = { finish_reason: "stop", input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 5, refusal_category: "PRIVATE_METADATA", message_id: "PRIVATE_METADATA" }
  f.manifest.outcome = { stop_reason: "end_turn", input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 }
  await f.save()
  const result = await runCli(f.directory)
  assert.equal(result.code, 0)
  assert.match(result.output, /exchange=1 .*outcome=stop .*input_tokens=7 .*output_tokens=3 .*cache_read_input_tokens=5/)
  assert.match(result.output, /client_blocks=text tool_calls=0/)
  assert.doesNotMatch(result.output, /PRIVATE_METADATA|PRIVATE_PROMPT|PRIVATE_RESPONSE/)
})

test("upstream request differences identify semantic field paths, not content", async () => {
  const f = await fixture()
  const exchange = f.manifest.exchanges[0]
  const expected = JSON.parse(await fs.readFile(path.join(f.directory, exchange.request.file), "utf8"))
  expected.messages[0].role = "assistant"
  expected.messages[0].content = "PRIVATE_DIFFERENCE"
  const bytes = Buffer.from(JSON.stringify(expected))
  await fs.writeFile(path.join(f.directory, exchange.request.file), bytes)
  exchange.request.bytes = bytes.length
  exchange.request.chunks = [bytes.length]
  await f.save()
  const result = await replayCapture(f.directory)
  assert.equal(result.verdict, "DIFF")
  assert.equal(result.exitCode, 2)
  assert.ok(result.differences.some((difference) => difference.path.endsWith(".messages[0].role")))
  assert.ok(result.differences.some((difference) => difference.path.endsWith(".messages[0].content")))
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|PRIVATE_DIFFERENCE/)
})

const runCli = async (target: string) => {
  const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url))
  const script = `
    import net from 'node:net';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const forbidden = () => { throw new Error('NETWORK_OR_AUTH_FORBIDDEN'); };
    globalThis.fetch = forbidden;
    net.Socket.prototype.connect = forbidden;
    net.Server.prototype.listen = forbidden;
    const readFile = fs.readFile.bind(fs);
    fs.readFile = async (file, ...rest) => {
      if (/(?:config\\.yaml|copilot_token\\.json|github_token)$/.test(String(file))) forbidden();
      return readFile(file, ...rest);
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(entry)}, 'replay', ${JSON.stringify(target)}];
    await import(${JSON.stringify(new URL("../../src/main.ts", import.meta.url).href)});
  `
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 15_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", FORCE_COLOR: "0" },
    }, (error, stdout, stderr) => {
      const code = error ? error.code : 0
      if (error?.killed || typeof code !== "number") {
        reject(error)
      } else {
        resolve({ code, output: stdout + stderr })
      }
    })
  })
}

test("CLI exits 0 MATCH, 1 missing/malformed, and 2 DIFF/INCOMPLETE without config or sockets", async () => {
  const f = await fixture()
  let result = await runCli(f.directory)
  assert.equal(result.code, 0)
  assert.match(result.output, /MATCH/)
  assert.match(result.output, /POST \/v1\/messages/)
  assert.match(result.output, /\/chat\/completions/)
  assert.doesNotMatch(result.output, /PRIVATE_PROMPT|PRIVATE_RESPONSE|NETWORK_OR_AUTH_FORBIDDEN/)
  f.manifest.status = 201
  await f.save()
  result = await runCli(f.directory)
  assert.equal(result.code, 2)
  assert.match(result.output, /DIFF/)
  f.manifest.captureState = "incomplete"
  await f.save()
  result = await runCli(f.directory)
  assert.equal(result.code, 2)
  assert.match(result.output, /INCOMPLETE/)
  await fs.writeFile(path.join(f.directory, "meta.json"), "invalid")
  result = await runCli(f.directory)
  assert.equal(result.code, 1)
  assert.match(result.output, /MALFORMED/)
  result = await runCli(path.join(home, "PRIVATE_MISSING_DIRECTORY"))
  assert.equal(result.code, 1)
  assert.match(result.output, /MISSING/)
  assert.doesNotMatch(result.output, /PRIVATE_MISSING_DIRECTORY/)
})

test("only intentional discarded retry bodies can be replayed when cancelled", async () => {
  const f = await fixture({ respond: (_request, attempt) => attempt === 1 ? new Response("partial", { status: 503 }) : Response.json(chatResponse()) })
  f.manifest.exchanges[0].response!.state = "cancelled"
  await f.save()
  assert.equal((await replayCapture(f.directory)).verdict, "INCOMPLETE")
  Object.assign(f.manifest.exchanges[0], { discarded: true })
  await f.save()
  assert.equal((await replayCapture(f.directory)).verdict, "MATCH")
})

for (const stream of [false, true]) {
  test(`normalizes only bridge-generated WebSearch IDs (${stream ? "SSE" : "JSON"}) and keeps tool references bijective`, async () => {
    let chat = 0
    const f = await fixture({ payload: { ...clientPayload, stream, tools: [{ name: "WebSearch", input_schema: { type: "object", properties: { query: { type: "string" } } } }] }, respond: (request) => {
      if (request.path === "/responses") {
        return Response.json({ status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 } })
      }

      chat++
      const message = { role: "assistant", content: null, tool_calls: [{ id: "call_provider_search", type: "function", function: { name: "WebSearch", arguments: '{"query":"PRIVATE_QUERY"}' } }] }
      const response = { ...chatResponse(), choices: [{ index: 0, message, finish_reason: "tool_calls" }] }
      if (!stream) {
        return Response.json(response)
      }

      return new Response(`data: ${JSON.stringify({ ...response, choices: [{ index: 0, delta: { ...message, tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    } })
    assert.equal(chat, 1)
    assert.match(f.response, /srvtoolu_[a-f0-9]{32}/)
    assert.equal((await replayCapture(f.directory)).verdict, "MATCH")
    const collision = f.response.replace(/srvtoolu_[a-f0-9]{32}/g, `srvtoolu_replay_${stream ? 0 : 1}`)
    await fs.writeFile(path.join(f.directory, "client-response.bin"), collision)
    f.manifest.response!.bytes = Buffer.byteLength(collision)
    f.manifest.response!.chunks = [f.manifest.response!.bytes]
    await f.save()
    assert.equal((await replayCapture(f.directory)).verdict, "DIFF")
    const changed = f.response.replace(/("tool_use_id"\s*:\s*")srvtoolu_[a-f0-9]{32}/, "$1srvtoolu_ffffffffffffffffffffffffffffffff")
    assert.notEqual(changed, f.response)
    await fs.writeFile(path.join(f.directory, "client-response.bin"), changed)
    f.manifest.response!.bytes = Buffer.byteLength(changed)
    f.manifest.response!.chunks = [f.manifest.response!.bytes]
    await f.save()
    assert.equal((await replayCapture(f.directory)).verdict, "DIFF")
  })
}

test("provider IDs stay significant even when upstream JSON escapes their characters", async () => {
  const providerId = `msg_${"a".repeat(32)}`
  const f = await fixture({ payload: { ...clientPayload, tools: [{ name: "WebSearch" }] }, respond: (request) => {
    if (request.path === "/responses") {
      return new Response(JSON.stringify({ id: providerId, status: "completed", output: [] }).replace("a".repeat(32), "\\u0061".repeat(32)), { headers: { "content-type": "application/json" } })
    }

    return Response.json({ ...chatResponse(), choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "provider-call", type: "function", function: { name: "WebSearch", arguments: '{"query":"test"}' } }] }, finish_reason: "tool_calls" }] })
  } })
  assert.equal(JSON.parse(f.response).id, providerId)
  const changed = f.response.replace(providerId, `msg_${"b".repeat(32)}`)
  await fs.writeFile(path.join(f.directory, "client-response.bin"), changed)
  await f.save()
  assert.equal((await replayCapture(f.directory)).verdict, "DIFF")
})

test("an absent upstream body differs from a JSON null body", async () => {
  const f = await fixture({ runtime: { modelCatalog: { baseUrl: "https://old.invalid", models: new Map() } }, respond: (request) => request.path === "/models" ? Response.json({ data: [{ id: "claude-test" }] }) : Response.json(chatResponse()) })
  const request = f.manifest.exchanges[0].request
  assert.equal(request.bytes, 0)
  await fs.writeFile(path.join(f.directory, request.file), "null")
  request.bytes = 4
  request.chunks = [4]
  await f.save()
  assert.equal((await replayCapture(f.directory)).verdict, "DIFF")
})

test("complete captures replay the current handler without network, sockets, or ambient policy", async (t) => {
  const f = await fixture()
  assert.equal(JSON.parse(f.response).content[0].text, "PRIVATE_RESPONSE")
  let networkCalls = 0
  t.mock.method(globalThis, "fetch", () => {
    networkCalls++
    throw new Error("Network forbidden")
  })
  t.mock.method(net.Socket.prototype, "connect", () => {
    networkCalls++
    throw new Error("Socket forbidden")
  })
  runtimeState.modelRouting = { gptModel: "WRONG_AMBIENT_MODEL", opusModel: "WRONG_AMBIENT_MODEL" }
  runtimeState.thinkEffort = "max"
  try {
    const result = await replayCapture(f.directory)
    assert.equal(result.verdict, "MATCH")
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.differences, [])
    assert.equal(networkCalls, 0)
    assert.equal(runtimeState.thinkEffort, "max")
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|PRIVATE_RESPONSE/)
  } finally {
    delete runtimeState.modelRouting
    delete runtimeState.thinkEffort
  }
})

interface HttpCopilotRequest {
  method: string
  path: string
  body: string
  headers: IncomingHttpHeaders
}

const withinDeadline = async <T>(promise: Promise<T>, operation: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} did not settle within 5 seconds`)), 5_000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

// Unlike fixture(), this path never writes a manifest or injects a transport:
// the real HTTP client and debug-level RequestTrace must produce replay's input.
const captureWithHttpCopilot = async (options: {
  payload?: unknown
  configure?: (config: ProxyConfig, runtime: RuntimeState) => void
  respond: (request: HttpCopilotRequest, response: ServerResponse, attempt: number) => void
}) => {
  const requests: HttpCopilotRequest[] = []
  let handlerError: unknown
  const upstream = createHttpServer((request, response) => {
    void (async () => {
      let body = ""
      for await (const chunk of request) {
        body += String(chunk)
      }

      const recorded = { method: request.method ?? "GET", path: request.url ?? "/", body, headers: request.headers }
      requests.push(recorded)
      options.respond(recorded, response, requests.length)
    })().catch((error: unknown) => {
      handlerError = error
      response.destroy()
    })
  })
  try {
    await withinDeadline(new Promise<void>((resolve, reject) => {
      upstream.once("error", reject)
      upstream.listen(0, "127.0.0.1", () => {
        upstream.off("error", reject)
        resolve()
      })
    }), "Mock Copilot listen")
    const address = upstream.address()
    assert.ok(address && typeof address === "object")
    const config: ProxyConfig = {
      host: "127.0.0.1", port: 0, copilotBaseUrl: `http://127.0.0.1:${address.port}`,
      copilotToken: "fake-capture-token-before", copilotTokenGeneration: 0,
      upstreamTimeoutMs: 2_000, vsCodeVersion: "test", claudeUpstreamApi: "chat-completions",
      refreshCopilotToken: async () => {
        throw new Error("Unexpected capture refresh")
      },
    }
    const runtime: RuntimeState = {
      modelRouting: { gptModel: "gpt-test", opusModel: "claude-test" },
      thinkEffort: "low", upstreamBaseUrl: config.copilotBaseUrl,
    }
    options.configure?.(config, runtime)
    assert.equal(paths.appDir, path.join(home, ".copilot-relay"))
    const payload = JSON.stringify(options.payload ?? clientPayload)
    setLogLevel("debug")
    const recorded = await withinDeadline(withoutLogging(() => withRuntimeState(runtime, async () => {
      const response = await createServer(config).fetch(new Request("http://127.0.0.1/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: payload, signal: AbortSignal.timeout(5_000),
      }))
      return {
        requestId: response.headers.get("x-copilot-relay-request-id"), status: response.status,
        contentType: response.headers.get("content-type"), response: await response.text(),
      }
    })), "Capture response consumption")
    await withinDeadline(flushCaptures(), "Capture flush")
    assert.equal(handlerError, undefined, "Mock Copilot request failed")
    assert.equal(recorded.status, 200)
    assert.ok(recorded.requestId)
    assert.match(recorded.requestId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    const root = path.join(paths.appDir, "captures")
    const directories = (await Promise.all((await fs.readdir(root, { withFileTypes: true }))
      .filter((date) => date.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(date.name))
      .map(async (date) => {
        const directory = path.join(root, date.name, recorded.requestId!)
        return await fs.stat(directory).then(() => directory, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return undefined
          }

          throw error
        })
      }))).filter((directory): directory is string => directory !== undefined)
    assert.equal(directories.length, 1, "Response request ID must locate exactly one real capture")
    const directory = directories[0]
    const manifest: CaptureManifest = JSON.parse(await fs.readFile(path.join(directory, "meta.json"), "utf8"))
    assert.equal(manifest.requestId, recorded.requestId)
    assert.equal(manifest.captureState, "complete", `Capture error: ${manifest.captureError ?? "none"}`)
    assert.equal(manifest.handlerSettled, true)
    assert.equal(manifest.request.state, "complete")
    assert.equal(manifest.response?.state, "complete")
    assert.equal(manifest.status, recorded.status)
    assert.ok(isDeepStrictEqual(await fs.readFile(path.join(directory, manifest.request.file)), Buffer.from(payload)), "Captured client request changed")
    assert.ok(isDeepStrictEqual(await fs.readFile(path.join(directory, manifest.response!.file)), Buffer.from(recorded.response)), "Captured client response changed")
    assert.equal(manifest.exchanges.length, requests.length)
    for (const [index, exchange] of manifest.exchanges.entries()) {
      assert.equal(exchange.method, requests[index].method)
      assert.equal(exchange.path, requests[index].path)
      assert.equal(exchange.upstreamRequestId, requests[index].headers["x-request-id"])
      // A real GET /models has no body; RequestTrace may omit its empty file.
      const body = await fs.readFile(path.join(directory, exchange.request.file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && exchange.request.bytes === 0) {
          return Buffer.alloc(0)
        }

        throw error
      })
      assert.ok(isDeepStrictEqual(body, Buffer.from(requests[index].body)), `Captured upstream request ${index} changed`)
    }

    return { ...recorded, requestId: recorded.requestId, directory, manifest, requests }
  } finally {
    setLogLevel("info")
    if (upstream.listening) {
      const closed = new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()))
      upstream.closeAllConnections()
      await withinDeadline(closed, "Mock Copilot close")
    }

    await withinDeadline(flushCaptures(), "Capture teardown flush")
    await withinDeadline(flushLogs(), "Capture log flush")
  }
}

test("captured relay stream errors keep their request ID during offline replay", async (t) => {
  const capture = await captureWithHttpCopilot({
    payload: { model: "opus", stream: true, max_tokens: 32, messages: [{ role: "user", content: "Fixture" }] },
    respond: (request, response) => {
      const body = JSON.parse(request.body)
      response.setHeader("content-type", "text/event-stream")
      response.end(`data: ${JSON.stringify({ id: "msg_error_fixture", model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "Read", arguments: '{"private":' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`)
    },
  })
  assert.match(capture.response, new RegExp(`request_id=${capture.requestId}`))
  assert.match(capture.response, /event: error/)
  await assertRealCaptureReplaysOffline(t, capture, "unreported")
})

const assertRealCaptureReplaysOffline = async (t: TestContext, capture: Awaited<ReturnType<typeof captureWithHttpCopilot>>, outcome = "end_turn") => {
  let forbiddenCalls = 0
  const forbidden = () => {
    forbiddenCalls++
    throw new Error("NETWORK_OR_AUTH_FORBIDDEN")
  }

  t.mock.method(globalThis, "fetch", forbidden)
  t.mock.method(net.Socket.prototype, "connect", forbidden)
  t.mock.method(net.Server.prototype, "listen", forbidden)
  const readFile = fs.readFile.bind(fs)
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (/(?:config\.yaml|copilot_token\.json|github_token)$/.test(String(args[0]))) {
      forbidden()
    }

    return readFile(...args)
  })
  try {
    const result = await withinDeadline(replayCapture(capture.directory), "Offline replay")
    assert.deepEqual({ verdict: result.verdict, exitCode: result.exitCode, differences: result.differences }, {
      verdict: "MATCH", exitCode: 0, differences: [],
    })
    assert.equal(forbiddenCalls, 0)
    assert.deepEqual(result.summary?.routes, capture.manifest.exchanges.map((exchange) => exchange.path))
    assert.equal(result.summary?.outcome, outcome)
    assert.ok(!/PRIVATE_|fake-capture-token/.test(JSON.stringify(result)), "Replay exposed capture content")
  } finally {
    t.mock.restoreAll()
  }

  const result = await runCli(capture.requestId)
  assert.ok(!/PRIVATE_|fake-capture-token|NETWORK_OR_AUTH_FORBIDDEN/.test(result.output), "CLI exposed capture content or attempted network/auth")
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /^MATCH\r?\n/)
  assert.ok(result.output.includes(`POST /v1/messages status=200 outcome=${outcome}`))
  assert.ok(result.output.includes(`upstream=${capture.manifest.exchanges.map((exchange) => exchange.path).join(" -> ")}`), "CLI must report recorded upstream routes")
}

test("real debug capture replays a 401 refresh retry with an intentionally cancelled discarded body", { timeout: 25_000 }, async (t) => {
  const refreshes: Array<{ rejectedToken: string; generation: number }> = []
  const capture = await captureWithHttpCopilot({
    configure: (config) => {
      config.refreshCopilotToken = async (rejectedToken, generation) => {
        refreshes.push({ rejectedToken, generation })
        config.copilotToken = "fake-capture-token-after"
        config.copilotTokenGeneration = generation + 1
      }
    },
    respond: (_request, response, attempt) => {
      response.writeHead(attempt === 1 ? 401 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify(attempt === 1 ? { error: "PRIVATE_DISCARDED_AUTH_BODY" } : chatResponse()))
    },
  })
  assert.ok(isDeepStrictEqual(refreshes, [{ rejectedToken: "fake-capture-token-before", generation: 0 }]), "Refresh must use only the rejected fake token")
  assert.ok(isDeepStrictEqual(capture.requests.map((request) => request.headers.authorization), ["Bearer fake-capture-token-before", "Bearer fake-capture-token-after"]), "Retry must use the refreshed in-memory fake token")
  assert.deepEqual(capture.requests.map((request) => request.path), ["/chat/completions", "/chat/completions"])
  assert.deepEqual(capture.manifest.exchanges.map((exchange) => [exchange.order, exchange.status]), [[1, 401], [3, 200]])
  assert.deepEqual(capture.manifest.refreshes, [{ order: 2, outcome: "success" }])
  assert.equal(capture.manifest.exchanges[0].discarded, true)
  assert.equal(capture.manifest.exchanges[0].response?.state, "cancelled")
  assert.equal(capture.manifest.exchanges[1].response?.state, "complete")
  assert.ok(!/fake-capture-token|PRIVATE_DISCARDED_AUTH_BODY/.test(JSON.stringify(capture.manifest)), "Metadata retained auth data")
  await assertRealCaptureReplaysOffline(t, capture)
  assert.equal(refreshes.length, 1, "Replay must not invoke the original refresh callback")
})

for (const mode of ["catalog", "fallback", "discovered-no-effort"] as const) {
  test(`catalog-driven Responses ${mode} captures and replays offline`, { timeout: 25_000 }, async (t) => {
    const id = "grok-4.7"

    const capture = await captureWithHttpCopilot({
      configure: (config, runtime) => {
        runtime.modelRouting = { gptModel: id, opusModel: id }

        // "fallback" has no catalog: legacy Chat preference, then the coded Responses recovery.
        if (mode === "catalog") {
          config.modelCatalog = {
            baseUrl: config.copilotBaseUrl,
            models: new Map([[id, { supportedEndpoints: ["/responses"], reasoningEfforts: [] }]]),
          }
        }

        // A stale provider's catalog forces discovery of the explicit no-effort capability.
        if (mode === "discovered-no-effort") {
          config.modelCatalog = { baseUrl: "https://previous.invalid", models: new Map() }
        }

        runtime.modelCatalog = config.modelCatalog
      },
      respond: (request, response) => {
        response.setHeader("content-type", "application/json")

        if (request.path === "/models") {
          response.end(JSON.stringify({ data: [{
            id,
            supported_endpoints: ["/responses"],
            capabilities: { type: "chat", supports: { reasoning_effort: false } },
          }] }))
          return
        }

        if (request.path === "/chat/completions") {
          response.statusCode = 400
          response.end(JSON.stringify({ error: { code: "unsupported_api_for_model" } }))
          return
        }

        assert.equal(request.path, "/responses")

        const body = JSON.parse(request.body)
        assert.equal(body.model, id)
        assert.equal(body.reasoning?.effort, mode === "fallback" ? "low" : undefined)

        response.end(JSON.stringify({
          id: "resp_catalog_replay",
          model: id,
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "PRIVATE_RESPONSE" }] }],
          usage: { input_tokens: 7, output_tokens: 3 },
        }))
      },
    })

    const expectedPaths = {
      catalog: ["/responses"],
      fallback: ["/chat/completions", "/responses"],
      "discovered-no-effort": ["/models", "/responses"],
    }[mode]

    assert.deepEqual(capture.requests.map((request) => request.path), expectedPaths)

    if (mode === "fallback") {
      assert.equal(capture.manifest.exchanges[0].discarded, true)
    }

    await assertRealCaptureReplaysOffline(t, capture)
  })
}

const capturedEvents = (body: string): import("../../src/claude/types").ClaudeStreamEventData[] => body
  .split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))

for (const stream of [false, true]) {
  test(`real debug capture replays chat ${stream ? "SSE" : "JSON"} through the handler and CLI`, { timeout: 25_000 }, async (t) => {
    const upstream = stream ? [
      { id: "chat_provider_id", created: 123, model: "claude-test", choices: [{ index: 0, delta: { role: "assistant", content: "PRIVATE_RESPONSE" }, finish_reason: null }] },
      { id: "chat_provider_id", created: 123, model: "claude-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n" : JSON.stringify(chatResponse())
    const capture = await captureWithHttpCopilot({
      payload: { ...clientPayload, stream },
      respond: (_request, response) => {
        response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" })
        response.end(upstream)
      },
    })
    assert.deepEqual(capture.requests.map((request) => [request.method, request.path]), [["POST", "/chat/completions"]])
    assert.equal(capture.manifest.config.claudeUpstreamApi, "chat-completions")
    assert.equal(capture.manifest.exchanges[0].response?.state, "complete")
    assert.ok(isDeepStrictEqual(await fs.readFile(path.join(capture.directory, capture.manifest.exchanges[0].response!.file)), Buffer.from(upstream)), "Captured upstream chat response changed")
    assert.equal(capture.manifest.outcome?.stop_reason, "end_turn")
    assert.equal(capture.manifest.outcome?.input_tokens, 7)
    assert.equal(capture.manifest.outcome?.output_tokens, 3)
    if (stream) {
      assert.match(capture.contentType!, /text\/event-stream/)
      const events = capturedEvents(capture.response)
      assert.equal(events[0].type, "message_start")
      assert.equal(events.at(-1)?.type, "message_stop")
      assert.equal(events.filter((event) => event.type === "error").length, 0)
      assert.deepEqual(events.find((event) => event.type === "message_delta")?.usage, { input_tokens: 7, output_tokens: 3 })
      assert.ok(events.some((event) => event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text === "PRIVATE_RESPONSE"), "Chat SSE lost response text")
    } else {
      assert.match(capture.contentType!, /application\/json/)
      const response = JSON.parse(capture.response)
      assert.equal(response.stop_reason, "end_turn")
      assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 3 })
      assert.ok(response.content[0].text === "PRIVATE_RESPONSE", "Chat JSON lost response text")
    }

    await assertRealCaptureReplaysOffline(t, capture)
  })
}

for (const stream of [false, true]) {
  test(`real debug capture replays native Messages ${stream ? "SSE" : "JSON"} with signed thinking and complete usage`, { timeout: 25_000 }, async (t) => {
    const usage = {
      input_tokens: 17, output_tokens: 5, cache_read_input_tokens: 11, cache_creation_input_tokens: 6,
      cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 },
      service_tier: "standard", server_tool_use: { web_search_requests: 0 },
    }
    const message = {
      id: "msg_native_capture", type: "message", role: "assistant", model: "claude-test",
      content: [{ type: "thinking", thinking: "PRIVATE_NATIVE_THINKING", signature: "PRIVATE_NATIVE_SIGNATURE" }, { type: "text", text: "PRIVATE_NATIVE_RESPONSE" }],
      stop_reason: "end_turn", stop_sequence: null, usage,
    }
    const upstream = stream ? [
      { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "PRIVATE_NATIVE_THINKING" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "PRIVATE_NATIVE_" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIGNATURE" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "PRIVATE_NATIVE_RESPONSE" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_delta", delta: {}, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") : JSON.stringify(message)
    const payload = {
      ...clientPayload, stream,
      messages: [
        ...clientPayload.messages,
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "PRIVATE_HISTORY_SIGNATURE" }, { type: "text", text: "PRIVATE_HISTORY_RESPONSE" }] },
        { role: "user", content: "PRIVATE_CONTINUATION" },
      ],
    }
    const capture = await captureWithHttpCopilot({
      payload,
      configure: (config) => {
        config.claudeUpstreamApi = "messages"
      },
      respond: (_request, response) => {
        response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" })
        response.end(upstream)
      },
    })
    assert.deepEqual(capture.requests.map((request) => [request.method, request.path]), [["POST", "/v1/messages"]])
    const request = JSON.parse(capture.requests[0].body)
    assert.equal(request.stream, stream)
    assert.equal(request.model, "claude-test")
    assert.ok(isDeepStrictEqual(request.messages, payload.messages), "Native request lost signed history")
    assert.equal(capture.manifest.config.claudeUpstreamApi, "messages")
    assert.ok(isDeepStrictEqual(await fs.readFile(path.join(capture.directory, capture.manifest.exchanges[0].response!.file)), Buffer.from(upstream)), "Captured upstream native response changed")
    for (const outcome of [capture.manifest.outcome, capture.manifest.exchanges[0].outcome]) {
      assert.equal(outcome?.stop_reason, "end_turn")
      assert.equal(outcome?.input_tokens, usage.input_tokens)
      assert.equal(outcome?.output_tokens, usage.output_tokens)
      assert.equal(outcome?.cache_read_input_tokens, usage.cache_read_input_tokens)
      assert.equal(outcome?.cache_creation_input_tokens, usage.cache_creation_input_tokens)
    }

    if (stream) {
      const events = capturedEvents(capture.response)
      const signatures = events.flatMap((event) => event.type === "content_block_delta" && event.index === 0 && event.delta.type === "signature_delta" ? [event.delta.signature] : [])
      assert.ok(signatures.join("") === message.content[0].signature, "Native SSE lost the thinking signature")
      assert.ok(events.some((event) => event.type === "content_block_delta" && event.delta.type === "thinking_delta" && event.delta.thinking === message.content[0].thinking), "Native SSE lost thinking text")
      assert.ok(events.some((event) => event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text === message.content[1].text), "Native SSE lost response text")
      const terminal = events.findLast((event) => event.type === "message_delta")
      assert.equal(terminal?.delta.stop_reason, "end_turn")
      assert.deepEqual(terminal?.usage, usage)
      assert.equal(events.at(-1)?.type, "message_stop")
      assert.equal(events.filter((event) => event.type === "error").length, 0)
    } else {
      const response = JSON.parse(capture.response)
      assert.ok(isDeepStrictEqual(response.content, message.content), "Native JSON lost signed thinking")
      assert.deepEqual(response.usage, usage)
      assert.equal(response.stop_reason, "end_turn")
    }

    await assertRealCaptureReplaysOffline(t, capture)
  })
}

test("real debug capture replays lazy catalog discovery before the bounded chat request", { timeout: 25_000 }, async (t) => {
  const limits = { max_context_window_tokens: 1000, max_prompt_tokens: 900, max_output_tokens: 8 }
  const capture = await captureWithHttpCopilot({
    configure: (config, runtime) => {
      config.modelCatalog = { baseUrl: "https://old.invalid", models: new Map([["claude-test", { limits }]]) }
      runtime.modelCatalog = config.modelCatalog
    },
    respond: (request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(request.path === "/models" ? { data: [{ id: "claude-test", capabilities: { limits } }] } : chatResponse()))
    },
  })
  assert.deepEqual(capture.requests.map((request) => [request.method, request.path]), [["GET", "/models"], ["POST", "/chat/completions"]])
  assert.equal(capture.requests[0].body, "")
  assert.equal(JSON.parse(capture.requests[1].body).max_tokens, 8)
  assert.equal(capture.manifest.runtime.catalogCurrent, false, "Capture must retain the catalog state before discovery")
  assert.deepEqual(capture.manifest.exchanges.map((exchange) => [exchange.order, exchange.path]), [[1, "/models"], [2, "/chat/completions"]])
  assert.equal(capture.manifest.exchanges[0].request.bytes, 0)
  assert.equal(capture.manifest.exchanges[0].response?.state, "complete")
  await assertRealCaptureReplaysOffline(t, capture)
})
