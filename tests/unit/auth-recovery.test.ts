import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-auth-test-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"
const { setupProxyAuth } = await import("../../src/lib/auth")
const { fetchCopilot, getCopilotProviderContext } = await import("../../src/copilot/client")
const { paths } = await import("../../src/lib/paths")
const { HTTPError } = await import("../../src/lib/error")
const { log } = await import("../../src/lib/log")
const { validateUpstream } = await import("../../src/lib/preflight")
const { runtimeState } = await import("../../src/lib/state")
const { createClaudeWebSearchExecution } = await import("../../src/claude/web-search")
type ProxyConfig = import("../../src/lib/config").ProxyConfig

test.after(async () => { await fs.rm(home, { recursive: true, force: true }) })

const makeConfig = (baseUrl: string): ProxyConfig => ({
  copilotBaseUrl: baseUrl, copilotToken: undefined, host: "127.0.0.1", port: 0,
  upstreamTimeoutMs: 3000, vsCodeVersion: "1.99.3",
})

const upstream = async (handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) => {
  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

const seed = async () => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.writeFile(paths.githubTokenPath, "github-private-sentinel\n")
  await fs.writeFile(paths.copilotTokenPath, JSON.stringify({
    token: "old-private-sentinel", refreshedAt: Date.now(), refreshIn: 86400,
  }))
}

const mockAuth = (t: import("node:test").TestContext, exchange: (init?: RequestInit) => Promise<Response> | Response) => {
  let exchanges = 0
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === "https://api.github.com/user") return Response.json({ login: "test" })
    assert.equal(url, "https://api.github.com/copilot_internal/v2/token", "No device authorization or unexpected network call")
    exchanges++
    return exchange(init)
  })
  return () => exchanges
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

for (const status of [401, 403]) {
  test(`unexpired cached token recovers once from HTTP ${status}`, async (t) => {
    await seed()
    const count = mockAuth(t, () => Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
    const headers: string[] = []
    const server = await upstream((req, res) => {
      headers.push(req.headers.authorization ?? "")
      res.writeHead(headers.length === 1 ? status : 200)
      res.end(headers.length === 1 ? "forbidden\n" : '{"data":[]}')
    })
    try {
      const config = makeConfig(server.url)
      await setupProxyAuth(config)
      assert.equal(count(), 0)
      const response = await fetchCopilot(getCopilotProviderContext(config), "/models", { method: "GET" })
      assert.equal(response.status, 200)
      await response.text()
      assert.equal(count(), 1)
      assert.deepEqual(headers, ["Bearer old-private-sentinel", "Bearer new-private-sentinel"])
      assert.equal(config.copilotToken, "new-private-sentinel")
      const saved = JSON.parse(await fs.readFile(paths.copilotTokenPath, "utf8"))
      assert.equal(saved.token, "new-private-sentinel")
      if (process.platform !== "win32") assert.equal((await fs.stat(paths.copilotTokenPath)).mode & 0o777, 0o600)
      const next = makeConfig(server.url)
      await setupProxyAuth(next)
      assert.equal(next.copilotToken, "new-private-sentinel")
      assert.equal(count(), 1)
    } finally { await server.close() }
  })
}

for (const rejection of [
  { status: 401, body: "unauthorized", exchanges: 1, attempts: 2 },
  { status: 403, body: "forbidden\n", exchanges: 1, attempts: 2 },
  { status: 403, body: '{"error":{"code":"unsupported_api_for_model"}}', exchanges: 0, attempts: 1 },
  { status: 403, body: "Policy access denied", exchanges: 0, attempts: 1 },
  { status: 403, body: "forbidden" + " ".repeat(200), exchanges: 0, attempts: 1 },
  { status: 429, body: "quota exceeded", exchanges: 0, attempts: 1 },
]) {
  test(`persistent or explicit rejection stays bounded: ${rejection.status} ${rejection.body.slice(0, 30)}`, async (t) => {
    await seed()
    const count = mockAuth(t, () => Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
    let attempts = 0
    const server = await upstream((_req, res) => { attempts++; res.writeHead(rejection.status); res.end(rejection.body) })
    try {
      const config = makeConfig(server.url)
      await setupProxyAuth(config)
      const response = await fetchCopilot(getCopilotProviderContext(config), "/responses", { method: "POST", body: "{}" })
      assert.equal(response.status, rejection.status)
      assert.equal(await response.text(), rejection.body)
      assert.equal(attempts, rejection.attempts)
      assert.equal(count(), rejection.exchanges)
    } finally { await server.close() }
  })
}

test("exchange failure is redacted and never retried as transport or device auth", async (t) => {
  await seed()
  const count = mockAuth(t, () => new Response("github-private-sentinel", { status: 403 }))
  const messages: string[] = []
  t.mock.method(log, "info", (...args: unknown[]) => messages.push(args.join(" ")))
  t.mock.method(log, "error", (...args: unknown[]) => messages.push(args.join(" ")))
  let attempts = 0
  const server = await upstream((_req, res) => { attempts++; res.writeHead(401); res.end("unauthorized") })
  try {
    const config = makeConfig(server.url)
    await setupProxyAuth(config)
    await assert.rejects(fetchCopilot(getCopilotProviderContext(config), "/models", {}), /token recovery failed/)
    assert.equal(count(), 1)
    assert.equal(attempts, 1)
    assert.equal(config.copilotToken, "old-private-sentinel")
    assert.doesNotMatch(messages.join("\n"), /old-private|new-private|github-private/)
  } finally { await server.close() }
})

test("late old-generation rejection reuses a byte-identical refreshed token", async (t) => {
  await seed()
  const count = mockAuth(t, () => Response.json({ token: "old-private-sentinel", refresh_in: 86400 }))
  const firstReceived = deferred<void>()
  const secondReceived = deferred<void>()
  const releaseFirst = deferred<void>()
  const releaseSecond = deferred<void>()
  let attempts = 0
  const server = await upstream(async (_req, res) => {
    const attempt = ++attempts
    if (attempt === 1) { firstReceived.resolve(); await releaseFirst.promise }
    if (attempt === 2) { secondReceived.resolve(); await releaseSecond.promise }
    res.writeHead(attempt <= 2 ? 401 : 200)
    res.end(attempt <= 2 ? "unauthorized" : "OK")
  })
  try {
    const config = makeConfig(server.url)
    await setupProxyAuth(config)
    const provider = getCopilotProviderContext(config)
    const first = fetchCopilot(provider, "/models", {})
    await firstReceived.promise
    const second = fetchCopilot(provider, "/models", {})
    await secondReceived.promise
    releaseFirst.resolve()
    assert.equal(await (await first).text(), "OK")
    releaseSecond.resolve()
    assert.equal(await (await second).text(), "OK")
    assert.equal(count(), 1)
    assert.equal(attempts, 4)
    assert.equal(config.copilotTokenGeneration, 1)
  } finally { releaseFirst.resolve(); releaseSecond.resolve(); await server.close() }
})

for (const timedOut of [false, true]) {
  test(`cancelled refresh waiter does not cancel another request: timeout=${timedOut}`, async (t) => {
    await seed()
    const exchange = deferred<Response>()
    const started = deferred<void>()
    const count = mockAuth(t, () => { started.resolve(); return exchange.promise })
    const server = await upstream((req, res) => {
      const accepted = req.headers.authorization === "Bearer new-private-sentinel"
      res.writeHead(accepted ? 200 : 401)
      res.end(accepted ? "OK" : "unauthorized")
    })
    try {
      const config = makeConfig(server.url)
      await setupProxyAuth(config)
      const controller = new AbortController()
      const request = fetchCopilot(getCopilotProviderContext(config), "/models", {}, {
        signal: controller.signal, timeoutMs: timedOut ? 50 : 3000,
      })
      const rejected = assert.rejects(request, (error: unknown) => error instanceof HTTPError && error.response.status === (timedOut ? 504 : 499))
      await started.promise
      const another = fetchCopilot(getCopilotProviderContext(config), "/models", {})
      if (!timedOut) controller.abort()
      await rejected
      exchange.resolve(Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
      assert.equal(await (await another).text(), "OK")
      assert.equal(count(), 1)
    } finally {
      exchange.resolve(Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
      await server.close()
    }
  })
}

test("proactive timer and concurrent rejected requests share one refresh and renewal", async (t) => {
  await seed()
  const exchange = deferred<Response>()
  const count = mockAuth(t, () => exchange.promise)
  const timers: Array<{ callback: () => Promise<void>; delay: number }> = []
  t.mock.method(globalThis, "setTimeout", (callback: () => Promise<void>, delay: number) => {
    timers.push({ callback, delay })
    return { unref() {} } as ReturnType<typeof setTimeout>
  })
  t.mock.method(globalThis, "clearTimeout", () => {})
  const config = makeConfig("http://127.0.0.1:1")
  await setupProxyAuth(config)
  assert.equal(timers.length, 1)
  const timer = timers[0]!.callback()
  const first = config.refreshCopilotToken!(config.copilotToken!, 0)
  const second = config.refreshCopilotToken!(config.copilotToken!, 0)
  assert.equal(count(), 1)
  exchange.resolve(Response.json({ token: "new-private-sentinel", refresh_in: 7200 }))
  await Promise.all([timer, first, second])
  assert.equal(timers.length, 2)
  assert.equal(timers[1]?.delay, 7140000)
})

for (const route of ["/chat/completions", "/responses"]) {
  for (const stream of [false, true]) {
    test(`runtime auth recovery preserves payload and stream: ${route} stream=${stream}`, async (t) => {
      await seed()
      const count = mockAuth(t, () => Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
      const bodies: string[] = []
      const server = await upstream(async (req, res) => {
        let body = ""
        for await (const chunk of req) body += String(chunk)
        bodies.push(body)
        if (bodies.length === 1) { res.writeHead(401); res.end("unauthorized"); return }
        res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" })
        res.end(stream ? 'data: {"ok":true}\n\ndata: [DONE]\n\n' : '{"ok":true}')
      })
      try {
        const config = makeConfig(server.url)
        await setupProxyAuth(config)
        const body = JSON.stringify({ model: "test", stream, messages: [{ role: "user", content: "synthetic" }] })
        const response = await fetchCopilot(getCopilotProviderContext(config), route, { method: "POST", body })
        assert.equal(response.status, 200)
        assert.match(await response.text(), /"ok":true/)
        assert.deepEqual(bodies, [body, body])
        assert.equal(count(), 1)
      } finally { await server.close() }
    })
  }
}

test("preflight recovers model discovery then validates both configured APIs", async (t) => {
  await seed()
  const count = mockAuth(t, () => Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
  const routes: string[] = []
  const server = await upstream(async (req, res) => {
    routes.push(req.url!)
    if (req.headers.authorization === "Bearer old-private-sentinel") { res.writeHead(403); res.end("forbidden\n"); return }
    let body = ""
    for await (const chunk of req) body += String(chunk)
    const model = body ? JSON.parse(body).model : undefined
    res.setHeader("content-type", "application/json")
    const reply = req.url === "/models" ? { data: [{ id: "gpt-6-astra" }, { id: "claude-opus-5" }] }
      : req.url === "/responses" ? { id: "resp", created_at: 1, model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }] }
      : { id: "chat", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }
    res.end(JSON.stringify(reply))
  })
  try {
    runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5" }
    const config = makeConfig(server.url)
    await setupProxyAuth(config)
    await validateUpstream(config, "low")
    assert.equal(count(), 1)
    assert.deepEqual(routes, ["/models", "/models", "/responses", "/chat/completions"])
  } finally { delete runtimeState.modelRouting; await server.close() }
})

test("WebSearch shares authentication recovery without changing built-in tools", async (t) => {
  await seed()
  const count = mockAuth(t, () => Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
  const server = await upstream(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += String(chunk)
    assert.deepEqual(JSON.parse(body).tools, [{ type: "web_search_preview" }])
    if (req.headers.authorization === "Bearer old-private-sentinel") { res.writeHead(401); res.end("unauthorized"); return }
    res.end(JSON.stringify({ id: "search", model: "gpt-6-astra", output: [{ type: "message", content: [{ type: "output_text", text: "1. Docs - https://example.com/docs" }] }] }))
  })
  try {
    const config = makeConfig(server.url)
    await setupProxyAuth(config)
    const search = await createClaudeWebSearchExecution(config, { model: "default", messages: [{ role: "user", content: "synthetic" }], max_tokens: 64 }, "public query")
    assert.equal(count(), 1)
    assert.equal(search.results[0]?.url, "https://example.com/docs")
  } finally { await server.close() }
})

test("valid successful streams are never replayed after their body fails", async (t) => {
  await seed()
  const count = mockAuth(t, () => { throw new Error("unexpected refresh") })
  let attempts = 0
  const cut = deferred<void>()
  const server = await upstream(async (_req, res) => {
    attempts++
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('data: {"delta":"started"}\n\n')
    await cut.promise
    res.destroy()
  })
  try {
    const config = makeConfig(server.url)
    await setupProxyAuth(config)
    const response = await fetchCopilot(getCopilotProviderContext(config), "/responses", { method: "POST", body: "{}" })
    const reader = response.body!.getReader()
    assert.equal((await reader.read()).done, false)
    cut.resolve()
    await assert.rejects(reader.read())
    assert.equal(attempts, 1)
    assert.equal(count(), 0)
  } finally { cut.resolve(); await server.close() }
})

test("incomplete forbidden body obeys original deadline without refreshing", async (t) => {
  await seed()
  const count = mockAuth(t, () => { throw new Error("unexpected refresh") })
  const server = await upstream((_req, res) => { res.writeHead(403); res.write("forbidden") })
  try {
    const config = makeConfig(server.url)
    await setupProxyAuth(config)
    await assert.rejects(fetchCopilot(getCopilotProviderContext(config), "/models", {}, { timeoutMs: 50 }),
      (error: unknown) => error instanceof HTTPError && error.response.status === 504)
    assert.equal(count(), 0)
  } finally { await server.close() }
})

test("shared exchange has a finite timeout and can recover after failure", async (t) => {
  await seed()
  let hung = true
  const count = mockAuth(t, (init) => {
    if (!hung) return Response.json({ token: "new-private-sentinel", refresh_in: 86400 })
    return new Promise<Response>((_resolve, reject) => {
      assert(init?.signal)
      init.signal.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
    })
  })
  const server = await upstream((req, res) => {
    const accepted = req.headers.authorization === "Bearer new-private-sentinel"
    res.writeHead(accepted ? 200 : 401); res.end(accepted ? "OK" : "unauthorized")
  })
  try {
    const config = { ...makeConfig(server.url), upstreamTimeoutMs: 50 }
    await setupProxyAuth(config)
    await assert.rejects(fetchCopilot(getCopilotProviderContext(config), "/models", {}, { timeoutMs: 1000 }), /recovery failed/)
    assert.equal(count(), 1)
    hung = false
    assert.equal(await (await fetchCopilot(getCopilotProviderContext(config), "/models", {})).text(), "OK")
    assert.equal(count(), 2)
  } finally { await server.close() }
})

test("failed cache persistence keeps the old live token and removes temporary files", async (t) => {
  await seed()
  mockAuth(t, () => Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
  const config = makeConfig("http://127.0.0.1:1")
  await setupProxyAuth(config)
  t.mock.method(fs, "rename", async () => { throw new Error("synthetic cache failure") })
  await assert.rejects(config.refreshCopilotToken!(config.copilotToken!, 0), /refresh failed/)
  assert.equal(config.copilotToken, "old-private-sentinel")
  assert.equal(JSON.parse(await fs.readFile(paths.copilotTokenPath, "utf8")).token, "old-private-sentinel")
  assert.equal((await fs.readdir(paths.appDir)).some((file) => file.endsWith(".tmp")), false)
})

test("auth and transient retry budgets are separate and finite", async (t) => {
  await seed()
  const count = mockAuth(t, () => Response.json({ token: "new-private-sentinel", refresh_in: 86400 }))
  let attempts = 0
  const server = await upstream((_req, res) => { res.writeHead([503, 401, 503][attempts++]!); res.end("rejected") })
  try {
    const config = makeConfig(server.url)
    await setupProxyAuth(config)
    const response = await fetchCopilot(getCopilotProviderContext(config), "/responses", { method: "POST", body: "{}" })
    assert.equal(response.status, 503)
    await response.text()
    assert.equal(attempts, 3)
    assert.equal(count(), 1)
  } finally { await server.close() }
})
