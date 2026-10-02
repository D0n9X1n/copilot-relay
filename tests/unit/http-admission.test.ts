import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer, request as httpRequest } from "node:http"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-http-admission-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.CONSOLA_LEVEL = "0"

const { createServer, startServer } = await import("../../src/server")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs, withoutLogging } = await import("../../src/lib/log")
type ProxyConfig = import("../../src/lib/config").ProxyConfig

const configFor = (fields: Partial<ProxyConfig> = {}): ProxyConfig => ({
  host: "127.0.0.1",
  port: 0,
  copilotBaseUrl: "http://127.0.0.1:1",
  copilotToken: "test-token",
  upstreamTimeoutMs: 1_000,
  vsCodeVersion: "1.99.3",
  ...fields,
})

const payload = JSON.stringify({
  model: "claude-opus-5.5",
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply OK" }],
})

test.after(async () => {
  await flushLogs()
  await fs.rm(tempHome, { force: true, recursive: true })
})
test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
})

async function fakeUpstream(t: TestContext) {
  const requests: string[] = []
  const server = createHttpServer(async (request, response) => {
    requests.push(request.url ?? "")
    let body = ""
    for await (const chunk of request) {
      body += String(chunk)
    }

    response.setHeader("content-type", "application/json")
    if (request.url === "/models") {
      response.end(JSON.stringify({ data: [{ id: "claude-opus-5.5" }] }))
      return
    }

    const sent = JSON.parse(body) as { model: string }
    response.end(JSON.stringify({
      id: "chat_admission", created: 1, model: sent.model,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests }
}

test("accepts loopback literals and the explicit configured host, including IPv6", async () => {
  for (const [host, authority, header] of [
    ["127.0.0.1", "127.0.0.1:4142", "127.0.0.1:4142"],
    ["127.0.0.1", "127.42.0.2:32123", "127.42.0.2:32123"],
    ["127.0.0.1", "localhost", "LOCALHOST:80"],
    ["127.0.0.1", "[::1]:4142", "[0:0:0:0:0:0:0:1]:4142"],
    ["relay.example", "ReLaY.Example:4142", "relay.example:4142"],
    ["192.0.2.8", "192.0.2.8:4142", "192.0.2.8:4142"],
    ["2001:db8::5", "[2001:db8::5]:4142", "[2001:0db8::5]:4142"],
    ["[2001:db8::5]", "[2001:db8::5]:4142", "[2001:db8::5]:4142"],
    ["0.0.0.0", "localhost:4142", "localhost:4142"],
    ["::", "[::1]:4142", "[::1]:4142"],
    ["0:0:0:0:0:0:0:0", "127.0.0.1:4142", "127.0.0.1:4142"],
  ]) {
    const app = createServer(configFor({ host }))
    const response = await app.fetch(new Request(`http://${authority}/healthz`, { headers: { host: header } }))
    assert.equal(response.status, 200, `${host} / ${authority} / ${header}`)
  }
})

test("rejects mismatched and malformed Host headers rather than trusting forwarding headers", async () => {
  const app = createServer(configFor())
  for (const host of [
    "unexpected.example", "127.0.0.1", "localhost:4143", "localhost:",
    "localhost:bad", "localhost:65536", "localhost:0", "localhost:80, localhost:80",
    "localhost/path", "localhost?query", "localhost#hash", "user@localhost",
    "localhost\\\\unexpected.example", "%6cocalhost", "::1", "[::1", "localhost localhost",
  ]) {
    const response = await app.fetch(new Request("http://localhost/healthz", {
      headers: { host, "x-forwarded-host": "localhost", "x-forwarded-port": "80", "x-forwarded-proto": "http" },
    }))
    assert.equal(response.status, 403, host)
  }

  for (const host of ["127.1", "2130706433", "0x7f000001", "127.000.000.001"]) {
    const response = await app.fetch(new Request("http://127.0.0.1/healthz", { headers: { host } }))
    assert.equal(response.status, 403, `noncanonical IPv4 Host ${host}`)
  }
})

test("wildcard binds do not authorize wildcard or arbitrary request authorities", async () => {
  for (const host of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]) {
    const app = createServer(configFor({ host }))
    // Neither a mismatched Host nor forwarded headers can authorize an
    // untrusted URL, even when the listener was bound to every interface.
    assert.equal((await app.fetch(new Request("http://localhost/healthz", {
      headers: { host: "arbitrary.example" },
    }))).status, 403)
    for (const authority of ["arbitrary.example", "0.0.0.0", "[::]", "192.0.2.1", "127.0.0.1.example", "[::ffff:127.0.0.1]"]) {
      const response = await app.fetch(new Request(`http://${authority}/healthz`, {
        headers: { "x-forwarded-host": "localhost" },
      }))
      assert.equal(response.status, 403, `${host} / ${authority}`)
    }
  }
})

test("enforces a nonzero bound port and snapshots host and port across hot reload", async () => {
  const config = configFor({ host: "relay.example", port: 4142 })
  const app = createServer(config)
  config.host = "changed.example"
  config.port = 4143
  assert.equal((await app.fetch(new Request("http://localhost:4143/healthz"))).status, 403)
  assert.equal((await app.fetch(new Request("http://localhost/healthz"))).status, 403)
  assert.equal((await app.fetch(new Request("http://localhost:4142/healthz"))).status, 200)
  assert.equal((await app.fetch(new Request("http://relay.example:4142/healthz"))).status, 200)
  assert.equal((await app.fetch(new Request("http://changed.example:4142/healthz"))).status, 403)
  assert.equal((await app.fetch(new Request("http://changed.example:4143/healthz"))).status, 403)
})

test("rejects unexpected, opaque and malformed browser Origins before body parsing", async (t) => {
  const upstream = await fakeUpstream(t)
  const app = createServer(configFor({ copilotBaseUrl: upstream.baseUrl }))
  for (const origin of [
    "https://unexpected.example", "null", "", "*", "http://127.0.0.1:4142",
    "http://localhost:4143", "https://localhost:4142", "http://localhost:4142/",
    "http://localhost:4142/path", "http://localhost:4142?query", "http://localhost:4142#hash",
    "http://user@localhost:4142", "http://localhost:4142 http://localhost:4142",
    "http://localhost:4142,http://localhost:4142", "http://%6cocalhost:4142",
  ]) {
    const request = new Request("http://localhost:4142/v1/messages", {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: "not JSON",
    })
    const response = await app.fetch(request)
    assert.equal(response.status, 403, origin)
    assert.equal(request.bodyUsed, false, origin)
  }

  assert.deepEqual(upstream.requests, [])
})

test("same-origin and absent-Origin clients work without permissive CORS", async (t) => {
  const upstream = await fakeUpstream(t)
  const app = createServer(configFor({ copilotBaseUrl: upstream.baseUrl, host: "relay.example" }))
  for (const [authority, origin] of [
    ["localhost", undefined],
    ["localhost", "HTTP://LOCALHOST:80"],
    ["localhost:4142", "http://LOCALHOST:4142"],
    ["[::1]:4142", "http://[0:0:0:0:0:0:0:1]:4142"],
    ["relay.example:4142", "http://RELAY.EXAMPLE:4142"],
  ]) {
    const response = await app.fetch(new Request(`http://${authority}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", ...(origin !== undefined && { origin }) }, body: payload,
    }))
    assert.equal(response.status, 200, authority)
    assert.equal(response.headers.get("access-control-allow-origin"), null, authority)
    assert.equal(response.headers.get("access-control-allow-credentials"), null)
    const body = await response.json() as { content: Array<{ type: string; text: string }> }
    assert.deepEqual(body.content, [{ type: "text", text: "OK" }])
  }

  assert.equal(upstream.requests.filter((path) => path === "/chat/completions").length, 5)
})

test("browser preflight cannot bypass admission or receive wildcard CORS", async () => {
  const app = createServer(configFor())
  const response = await app.fetch(new Request("http://localhost:4142/v1/messages", {
    method: "OPTIONS", headers: {
      origin: "https://unexpected.example", "access-control-request-method": "POST",
      "access-control-request-headers": "content-type", "access-control-request-private-network": "true",
    },
  }))
  assert.equal(response.status, 403)
  assert.equal(response.headers.get("access-control-allow-origin"), null)
  assert.equal(response.headers.get("access-control-allow-private-network"), null)
})

test("body-bearing inference POSTs require application/json before parsing or upstream", async (t) => {
  const upstream = await fakeUpstream(t)
  const app = createServer(configFor({ copilotBaseUrl: upstream.baseUrl }))
  for (const route of ["/v1/messages", "/v1/messages/count_tokens"]) {
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=test", "application/jsonp", "application/json, text/plain"]) {
      const request = new Request(`http://localhost${route}`, {
        method: "POST", headers: contentType ? { "content-type": contentType } : {}, body: payload,
      })
      // Request supplies text/plain for strings. Remove it to also pin absence.
      if (contentType === undefined) {
        request.headers.delete("content-type")
      }

      const response = await app.fetch(request)
      assert.equal(response.status, 415, `${route}: ${contentType}`)
      assert.equal(request.bodyUsed, false)
    }
  }

  assert.deepEqual(upstream.requests, [])
})

test("JSON media types with parameters and casing remain compatible without CORS", async (t) => {
  const upstream = await fakeUpstream(t)
  const app = createServer(configFor({ copilotBaseUrl: upstream.baseUrl }))
  for (const route of ["/v1/messages", "/v1/messages/count_tokens"]) {
    const unsupported = await app.fetch(new Request(`http://localhost${route}`, {
      method: "POST", headers: { "content-type": "application/jsonp" }, body: payload,
    }))
    assert.equal(unsupported.status, 415)
    for (const contentType of ["application/json", "Application/JSON; Charset=UTF-8", "application/json ; charset=\"utf-8\""]) {
      const response = await app.fetch(new Request(`http://localhost${route}`, {
        method: "POST", headers: { "content-type": contentType }, body: payload,
      }))
      assert.equal(response.headers.get("access-control-allow-origin"), null)
      assert.equal(response.status, 200, `${route}: ${contentType}`)
      await response.json()
    }
  }

  assert.equal(upstream.requests.filter((path) => path === "/chat/completions").length, 3)
})

test("cheap GET/HEAD and unsupported-route contracts do not acquire a JSON requirement", async (t) => {
  const upstream = await fakeUpstream(t)
  const app = createServer(configFor({ copilotBaseUrl: upstream.baseUrl }))
  const rejected = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "text/plain" }, body: payload,
  }))
  assert.equal(rejected.status, 415)
  for (const route of ["/api/hello", "/healthz", "/v1/models"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await app.fetch(new Request(`http://localhost${route}`, {
        method, headers: { "content-type": "text/plain" },
      }))
      assert.equal(response.status, 200, `${method} ${route}`)
      assert.equal(response.headers.get("access-control-allow-origin"), null)
      if (method === "HEAD" || route === "/api/hello") {
        assert.equal(await response.text(), "")
      }
    }
  }

  for (const [route, method, body] of [
    ["/unknown", "POST", "not JSON"],
    ["/v1/messages", "GET", undefined],
    ["/v1/messages", "OPTIONS", undefined],
  ]) {
    const response = await withoutLogging(() => app.fetch(new Request(`http://localhost${route}`, {
      method, headers: { "content-type": "text/plain" }, ...(body !== undefined && { body }),
    })))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: { message: "Unsupported Claude API route" } })
  }

  // A truly absent body is the route's concern, not a media-type rejection.
  const empty = await withoutLogging(() => app.fetch(new Request("http://localhost/v1/messages", { method: "POST" })))
  assert.equal(empty.status, 500)
  assert.deepEqual(upstream.requests, [])
})

test("the HTTP adapter enforces its actual ephemeral port and rejects absolute-target Host mismatches", async (t) => {
  const server = await withoutLogging(() => startServer(configFor()))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  const send = (host: string, target = "/healthz", method = "GET") => new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port, path: target, method,
      headers: { host, connection: "close" },
    }, (response) => {
      response.resume()
      response.on("end", () => resolve(response.statusCode!))
    })
    request.on("error", reject)
    request.end()
  })
  assert.equal(await send("localhost:1"), 403)
  assert.equal(await send(`localhost:${port}`), 200)
  assert.equal(await send(`127.0.0.1:${port}`, `http://localhost:${port}/healthz`), 403)
  assert.equal(await send(`localhost:${port}`, `https://localhost:${port}/healthz`), 403)
  assert.equal(await send(`localhost:${port}`, `http://%6cocalhost:${port}/healthz`), 403)
  assert.equal(await send(`127.0.0.1:${port}`, `http://127.1:${port}/healthz`), 403)
  assert.equal(await send(`127.0.0.1:${port}`, `http:///127.1:${port}/healthz`), 403)
  const emptyPost = await withoutLogging(() => send(`localhost:${port}`, "/v1/messages", "POST"))
  assert.equal(emptyPost, 500)
})

test("isolated model probes use an admitted local authority for zero and nonzero configured ports", async (t) => {
  const upstream = await fakeUpstream(t)
  const { probeModels } = await import("../../src/lib/model-probe")
  for (const port of [0, 4142]) {
    const result = await probeModels(configFor({ copilotBaseUrl: upstream.baseUrl, port }), [["claude-opus-5.5", {}]], {
      maxTokens: 16, timeoutMs: 1_000, totalTimeoutMs: 2_000,
    })
    assert.equal(result, 0, `port ${port}`)
  }

  assert.equal(upstream.requests.filter((path) => path === "/chat/completions").length, 2)
})

test("rejects an unexpected authority before reading its body or reaching upstream", async (t) => {
  const upstream = await fakeUpstream(t)
  const app = createServer(configFor({ copilotBaseUrl: upstream.baseUrl }))
  const request = new Request("http://unexpected.example/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" }, body: payload,
  })
  const response = await app.fetch(request)
  assert.equal(response.status, 403)
  assert.equal(request.bodyUsed, false)
  assert.deepEqual(upstream.requests, [])
})
