import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"

import { fetch as undiciFetch, type Dispatcher } from "undici"

import {
  closedPort,
  refuseExternalConnections,
  startEchoingProxy,
  startRecordingProxy,
  withProxyEnvironment,
  withoutProxyVariables,
} from "../fixtures/network"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-upstream-proxy-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { fetchCopilot } = await import("../../src/copilot/client")
const { flushLogs } = await import("../../src/lib/log")
const { checkDeep } = await import("../../src/status")
const { buildUpstreamDispatcher, configureUpstreamDispatcher } = await import("../../src/lib/upstream-dispatcher")

const entry = new URL("../../src/main.ts", import.meta.url)
const networkFixture = new URL("../fixtures/network.ts", import.meta.url)
const statusModule = new URL("../../src/status.ts", import.meta.url)
const cwd = fileURLToPath(new URL("../../", import.meta.url))

// A safety net: a connection off this machine fails the test instead of reaching GitHub or Copilot.
const restoreConnections = refuseExternalConnections()

test.afterEach(() => {
  configureUpstreamDispatcher(undefined)
})

test.after(async () => {
  restoreConnections()
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

const listen = async (server: net.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === "object")
  return address.port
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface ReceivedRequest {
  authorization: string | undefined
  method: string | undefined
  proxyAuthorization: string | undefined
  url: string | undefined
}

// A local server that answers every request with `payload`: the Copilot stand-in, and for the
// status probe the relay's own listener. Like Copilot, it sends no Keep-Alive hint, and it never
// closes an idle connection itself.
const startJsonServer = async (payload: unknown) => {
  const requests: Array<ReceivedRequest> = []
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      proxyAuthorization: request.headers["proxy-authorization"],
      url: request.url,
    })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(payload))
  })
  server.keepAliveTimeout = 0
  const port = await listen(server)

  return {
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    requests,
  }
}

// One catalog request through the relay's own client, as every Copilot request is sent.
const getModels = async (origin: string): Promise<void> => {
  const response = await fetchCopilot(
    { baseUrl: origin, token: "copilot-fixture-token", vsCodeVersion: "1.99.3" },
    "/models",
    { method: "GET" },
  )
  assert.equal(response.status, 200)
  await response.text()
}

// Why (#153): where only a proxy reaches the internet, every Copilot call has to go through it. A
// URL's user name and password become the tunnel's Proxy-Authorization and never reach Copilot.
test("upstreamProxy as a URL sends Copilot calls through the proxy with its credentials", async (t) => {
  const copilot = await startJsonServer({ data: [] })
  const proxy = await startRecordingProxy()
  t.after(async () => {
    await proxy.close()
    await copilot.close()
  })

  configureUpstreamDispatcher(proxy.url.replace("http://", "http://relay-user:p%40ss@"))
  await getModels(copilot.origin)

  assert.deepEqual(proxy.records, [{
    authorization: `Basic ${Buffer.from("relay-user:p@ss").toString("base64")}`,
    method: "CONNECT",
    target: copilot.host,
  }])
  assert.deepEqual(copilot.requests, [{
    authorization: "Bearer copilot-fixture-token",
    method: "GET",
    proxyAuthorization: undefined,
    url: "/models",
  }])
})

// Why: the default. An empty upstreamProxy connects directly, as before #153, even when the shell
// has proxy variables set; only upstreamProxy: env reads them.
test("an empty upstreamProxy connects directly even when proxy variables are set", async (t) => {
  const copilot = await startJsonServer({ data: [] })
  const proxy = await startRecordingProxy()
  t.after(async () => {
    await proxy.close()
    await copilot.close()
  })

  await withProxyEnvironment({ HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url }, async () => {
    configureUpstreamDispatcher(undefined)
    await getModels(copilot.origin)
  })

  assert.deepEqual(proxy.records, [])
  assert.equal(copilot.requests.length, 1)
})

// Why: upstreamProxy: env takes the proxy from HTTPS_PROXY or HTTP_PROXY, and NO_PROXY exempts a
// host from it.
test("upstreamProxy env uses the proxy variables and honours NO_PROXY", async (t) => {
  const proxied = await startJsonServer({ data: [] })
  const exempt = await startJsonServer({ data: [] })
  const proxy = await startRecordingProxy()
  t.after(async () => {
    await proxy.close()
    await proxied.close()
    await exempt.close()
  })

  await withProxyEnvironment({ HTTP_PROXY: proxy.url, NO_PROXY: exempt.host }, async () => {
    configureUpstreamDispatcher("env")
    await getModels(proxied.origin)
    await getModels(exempt.origin)
  })

  assert.deepEqual(proxy.records, [{ authorization: undefined, method: "CONNECT", target: proxied.host }])
  assert.equal(proxied.requests.length, 1)
  assert.equal(exempt.requests.length, 1)
})

// Why (#141): Copilot sends no Keep-Alive hint, so undici's 4 s default would close a connection
// idle for longer, and the next request would pay for a new handshake. Through a proxy that also
// means a new tunnel, so both proxy kinds must keep the relay's 50 s keep-alive.
test("a proxied connection idle for longer than undici's 4 s default is reused", async (t) => {
  const copilot = await startJsonServer({ data: [] })
  const proxy = await startRecordingProxy()
  const dispatchers: Array<Dispatcher> = []
  t.after(async () => {
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()))
    await proxy.close()
    await copilot.close()
  })

  const fetchThrough = async (dispatcher: Dispatcher) => {
    const response = await undiciFetch(`${copilot.origin}/models`, { dispatcher })
    await response.text()
  }

  await withProxyEnvironment({ HTTP_PROXY: proxy.url }, async () => {
    dispatchers.push(buildUpstreamDispatcher(proxy.url), buildUpstreamDispatcher("env"))
    await Promise.all(dispatchers.map(fetchThrough))
    await sleep(5_500)
    await Promise.all(dispatchers.map(fetchThrough))
  })

  // One tunnel per dispatcher, each reused for its second request.
  assert.equal(copilot.requests.length, 4)
  assert.deepEqual(proxy.records.map((record) => record.method), ["CONNECT", "CONNECT"])
})

// Why: upstreamProxy is for Copilot and GitHub. The status probes call the relay's own listener on
// this machine, so they use their own direct dispatcher whatever upstreamProxy says.
test("status probes connect to the relay directly while upstreamProxy is set", async (t) => {
  const relay = await startJsonServer({
    content: [{ text: "ok", type: "text" }],
    role: "assistant",
    stop_reason: "end_turn",
    type: "message",
  })
  const proxy = await startRecordingProxy()
  t.after(async () => {
    await proxy.close()
    await relay.close()
  })

  configureUpstreamDispatcher(proxy.url)
  const result = await checkDeep(relay.origin, "claude-opus-5.5", "")

  assert.equal(result.ok, true, result.detail)
  assert.deepEqual(proxy.records, [])
  assert.deepEqual(relay.requests.map((request) => `${request.method} ${request.url}`), ["POST /v1/messages"])
})

// Why (#168): with NODE_USE_ENV_PROXY=1, Node's own fetch sends even a request to localhost through
// HTTP_PROXY when NO_PROXY does not exempt it. Through a proxy that refuses, status would report a
// healthy relay as unusable. The probes use a direct dispatcher of their own. On a Node without
// that mode, this passes trivially.
test("status probes reach the relay directly under NODE_USE_ENV_PROXY with HTTP_PROXY set", async (t) => {
  const relay = await startJsonServer({
    content: [{ text: "ok", type: "text" }],
    data: [{ id: "claude-opus-5.5" }],
    role: "assistant",
    stop_reason: "end_turn",
    type: "message",
  })
  const proxy = await startRecordingProxy({ refuseAll: true })
  const childHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-env-proxy-status-"))
  t.after(async () => {
    await proxy.close()
    await relay.close()
    await fs.rm(childHome, { recursive: true, force: true })
  })

  // The probes status makes, run in a child so that Node reads NODE_USE_ENV_PROXY at startup.
  const script = `
    const network = await import(${JSON.stringify(networkFixture.href)});
    network.refuseExternalConnections();
    const { checkDeep, readModels } = await import(${JSON.stringify(statusModule.href)});
    const deep = await checkDeep(${JSON.stringify(relay.origin)}, "claude-opus-5.5", "");
    const models = await readModels(${JSON.stringify(relay.origin)}, "");
    console.log("PROBES=" + JSON.stringify({ deep, models }));
  `
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd,
      env: {
        ...withoutProxyVariables(process.env),
        HOME: childHome,
        HTTP_PROXY: proxy.url,
        NODE_USE_ENV_PROXY: "1",
        USERPROFILE: childHome,
      },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stdout}${stderr}`))
        return
      }

      resolve(stdout)
    })
    child.stdin?.end()
  })

  const line = output.split("\n").find((entry) => entry.startsWith("PROBES="))
  assert.ok(line, output)
  const probes = JSON.parse(line.slice("PROBES=".length)) as {
    deep: { detail?: string; ok: boolean }
    models: Array<string>
  }
  assert.equal(probes.deep.ok, true, probes.deep.detail)
  assert.deepEqual(probes.models, ["claude-opus-5.5"])
  assert.deepEqual(proxy.records, [])
  assert.deepEqual(
    relay.requests.map((request) => `${request.method} ${request.url}`),
    ["POST /v1/messages", "GET /v1/models"],
  )
})

interface RelayRun {
  code: number
  output: string
}

// Runs `copilot-relay <args>` with its own home and any extra environment variables. A connection
// off this machine throws, and so does the global fetch, so the only way out is through the
// configured proxy.
const runRelay = async (
  childHome: string,
  args: Array<string>,
  env: Record<string, string> = {},
): Promise<RelayRun> => {
  const script = `
    const network = await import(${JSON.stringify(networkFixture.href)});
    network.refuseExternalConnections();
    globalThis.fetch = async () => {
      throw new Error("UNEXPECTED_NETWORK_ACCESS");
    };
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(entry.href)});
  `

  return new Promise<RelayRun>((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd,
      env: {
        ...withoutProxyVariables(process.env),
        ...env,
        CONSOLA_LEVEL: undefined,
        HOME: childHome,
        NO_COLOR: "1",
        USERPROFILE: childHome,
      },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      const code = error ? error.code : 0

      // A timeout, a signal or a spawn failure leaves no exit code to check.
      if (error?.killed || typeof code !== "number") {
        reject(error ?? new Error("Missing CLI exit code"))
        return
      }

      resolve({ code, output: stripVTControlCharacters(stdout + stderr) })
    })

    child.stdin?.end()
  })
}

// An isolated install whose config sends upstream calls through `proxyUrl`, with cached tokens so
// that start and models need no sign-in.
const prepareHome = async (t: TestContext, proxyUrl: string, copilotBaseUrl: string): Promise<string> => {
  const childHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-upstream-proxy-child-"))
  t.after(() => fs.rm(childHome, { recursive: true, force: true }))

  const appDir = path.join(childHome, ".copilot-relay")
  await fs.mkdir(appDir)
  // start fails its preflight before it would listen. A free port rather than the default 4142,
  // which a developer's own relay may be using, keeps it clear even so.
  await fs.writeFile(path.join(appDir, "config.yaml"), [
    `copilotBaseUrl: ${copilotBaseUrl}`,
    `upstreamProxy: ${proxyUrl}`,
    `port: ${await closedPort()}`,
    "claudeSetup: false",
    "upstreamTimeoutSeconds: 5",
    "",
  ].join("\n"))
  await fs.writeFile(path.join(appDir, "github_token"), "github-fixture-token\n")
  await fs.writeFile(path.join(appDir, "copilot_token.json"), JSON.stringify({
    refreshIn: 86400,
    refreshedAt: Date.now(),
    token: "copilot-fixture-token",
  }))

  return childHome
}

// Why (#153): start builds the dispatcher from its config before its first upstream call, so the
// GitHub user lookup and the startup preflight both go through the proxy. The proxy refuses both,
// so start stops at the preflight and never listens.
test("start sends its GitHub and Copilot calls through upstreamProxy", async (t) => {
  const proxy = await startRecordingProxy()
  t.after(() => proxy.close())
  const childHome = await prepareHome(t, proxy.url, "https://copilot-fixture.invalid")

  const result = await runRelay(childHome, ["start"])

  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /Startup preflight failed/)
  assert.doesNotMatch(result.output, /UNEXPECTED_NETWORK_ACCESS|copilot-relay listening/)
  assert.deepEqual(
    [...new Set(proxy.records.map((record) => `${record.method} ${record.target}`))],
    ["CONNECT api.github.com:443", "CONNECT copilot-fixture.invalid:443"],
  )
})

// Why (#153): device login is the first call auth makes, and a user behind a proxy signs in this
// way first. Had auth bypassed the proxy, the connection guard would have thrown
// UNEXPECTED_NETWORK_ACCESS and the proxy would have recorded nothing.
test("auth starts device login through upstreamProxy", async (t) => {
  const proxy = await startRecordingProxy()
  t.after(() => proxy.close())
  const childHome = await prepareHome(t, proxy.url, "https://copilot-fixture.invalid")

  const result = await runRelay(childHome, ["auth"])

  // The proxy refuses github.com, so device login fails here.
  assert.notEqual(result.code, 0)
  assert.doesNotMatch(result.output, /UNEXPECTED_NETWORK_ACCESS/)
  assert.deepEqual(proxy.records.map((record) => `${record.method} ${record.target}`), ["CONNECT github.com:443"])
})

// Why (#153): models runs in its own process and builds its own dispatcher. Its GitHub user lookup
// and the catalog request both go through the proxy. The proxy refuses only GitHub, and a failed
// user lookup does not stop the listing.
test("models reads the catalog through upstreamProxy", async (t) => {
  const copilot = await startJsonServer({ data: [{ id: "proxied-model" }] })
  const proxy = await startRecordingProxy()
  t.after(async () => {
    await proxy.close()
    await copilot.close()
  })
  const childHome = await prepareHome(t, proxy.url, copilot.origin)

  const result = await runRelay(childHome, ["models"])

  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /Upstream-advertised models \(1\):\nproxied-model\n/)
  assert.deepEqual(
    proxy.records.map((record) => `${record.method} ${record.target}`),
    ["CONNECT api.github.com:443", `CONNECT ${copilot.host}`],
  )
  assert.deepEqual(copilot.requests.map((request) => `${request.method} ${request.url}`), ["GET /models"])
})

// Every log file a child wrote under its home.
const readLogs = async (childHome: string): Promise<string> => {
  const logsDir = path.join(childHome, ".copilot-relay", "logs")
  const names = await fs.readdir(logsDir).catch(() => [])
  const contents = await Promise.all(names.map((name) => fs.readFile(path.join(logsDir, name), "utf8")))
  return contents.join("\n")
}

// Why (#168): a proxy that answers CONNECT with a reply undici cannot parse leaves the unparsed rest
// in the error, and start logs that error for the GitHub user lookup and for the startup
// preflight. A reply that echoes Proxy-Authorization must not carry the password, raw or in Basic
// form, to the terminal or the log, whether the proxy comes from config.yaml or HTTPS_PROXY.
test("start never prints or logs the proxy password a malformed CONNECT reply echoes", async (t) => {
  const proxy = await startEchoingProxy()
  t.after(() => proxy.close())
  const proxyUrl = proxy.url.replace("http://", "http://relay-echo-user:relay-echo-secret@")
  const basic = Buffer.from("relay-echo-user:relay-echo-secret").toString("base64")
  const modes: Array<{ label: string; upstreamProxy: string; env: Record<string, string> }> = [
    { label: "config.yaml", upstreamProxy: proxyUrl, env: {} },
    { label: "HTTPS_PROXY", upstreamProxy: "env", env: { HTTPS_PROXY: proxyUrl } },
  ]

  for (const { label, upstreamProxy, env } of modes) {
    const childHome = await prepareHome(t, upstreamProxy, "https://copilot-fixture.invalid")
    const result = await runRelay(childHome, ["start"], env)
    const logs = await readLogs(childHome)

    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /Startup preflight failed/)
    // The failure itself is still reported.
    assert.match(result.output + logs, /does not match the HTTP\/1\.1 protocol/)
    for (const secret of ["relay-echo-secret", basic]) {
      assert.ok(!result.output.includes(secret), `${label}: the terminal shows the proxy password`)
      assert.ok(!logs.includes(secret), `${label}: the log holds the proxy password`)
    }
  }

  assert.deepEqual([...new Set(proxy.targets)], ["api.github.com:443", "copilot-fixture.invalid:443"])
})
