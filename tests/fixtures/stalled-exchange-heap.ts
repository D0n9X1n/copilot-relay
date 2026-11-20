// Runs in a child started with --expose-gc. One relay request goes through the in-process app with
// a cached Copilot token that Copilot rejects with 401. The shared token exchange it triggers gets
// HTTP 200 headers and part of a JSON body from GitHub, then nothing more: it stays pending under its
// own long bound. The request's shorter deadline ends it with a 504. The fixture prints whether that
// finished request's trace is still reachable while the exchange is still open.
import fs from "node:fs/promises"
import { createServer as createHttpServer, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"

import type { ProxyConfig } from "../../src/lib/config"
import { redirectGitHubTo, refuseExternalConnections, replyJson, startFakeGitHub , waitForNoConnections } from "./network"

// src/lib/paths reads the home directory on import, so redirect HOME and USERPROFILE (Windows) first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-stalled-exchange-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { setupProxyAuth } = await import("../../src/lib/auth")
const { paths } = await import("../../src/lib/paths")
const { createServer } = await import("../../src/server")
const { withTraceObserver } = await import("../../src/lib/request-trace")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs } = await import("../../src/lib/log")
const { createUpstreamDeadline } = await import("../../src/lib/deadline")
const { getUpstreamDispatcher } = await import("../../src/lib/upstream-dispatcher")

const gc = (globalThis as { gc?: () => void }).gc
if (gc === undefined) {
  throw new Error("Run with --expose-gc.")
}

const model = "gpt-6-astra"

// The token exchange sends its headers and a partial body, then stalls; the response is kept open.
let stalledExchange: ServerResponse | undefined
const exchangeStarted = Promise.withResolvers<void>()
const github = await startFakeGitHub((url, _request, response) => {
  if (url.href === "https://api.github.com/copilot_internal/v2/token") {
    response.writeHead(200, { "content-type": "application/json" })
    response.write("{\"token\":")
    stalledExchange = response
    exchangeStarted.resolve()
    return
  }

  replyJson(response, url.href === "https://api.github.com/user" ? { login: "test" } : {}, url.href === "https://api.github.com/user" ? 200 : 404)
})
const redirect = redirectGitHubTo(github.origin)
const restoreConnections = refuseExternalConnections()

// Copilot rejects every token, so the request asks for a refresh.
const copilot = createHttpServer((request, response) => {
  request.resume()
  request.on("end", () => {
    replyJson(response, { error: { message: "unauthorized" } }, 401)
  })
})
await new Promise<void>((resolve) => copilot.listen(0, "127.0.0.1", resolve))
const address = copilot.address()
if (address === null || typeof address !== "object") {
  throw new Error("Copilot mock did not bind")
}

const copilotBaseUrl = `http://127.0.0.1:${address.port}`

// A stored GitHub token and an unexpired cached Copilot token, so setup reuses the cache and the
// only exchange is the one the rejected request triggers.
await fs.mkdir(paths.appDir, { recursive: true })
await fs.writeFile(paths.githubTokenPath, "github-fixture-token\n")
await fs.writeFile(paths.copilotTokenPath, JSON.stringify({ token: "cached-fixture-copilot-token", refreshedAt: Date.now(), refreshIn: 86400 }))

// The exchange's own bound is the configured 180 seconds, far beyond this fixture.
const config: ProxyConfig = {
  host: "127.0.0.1",
  port: 0,
  copilotBaseUrl,
  copilotToken: undefined,
  upstreamTimeoutMs: 180_000,
  vsCodeVersion: "test",
  claudeUpstreamApi: "auto",
  modelCatalog: { baseUrl: copilotBaseUrl, models: new Map([[model, { type: "chat", supportedEndpoints: ["/responses"] }]]) },
}
await setupProxyAuth(config)
runtimeState.modelRouting = { gptModel: model, opusModel: model }
runtimeState.upstreamBaseUrl = copilotBaseUrl
const app = createServer(config)

// The request is admitted with a 250 ms deadline of its own, shorter than the exchange's bound.
const deadline = createUpstreamDeadline(250)
const send = async (): Promise<{ status: number; reference: WeakRef<object> }> => {
  let trace: { finished: Promise<void> } | undefined
  const response = await withTraceObserver((observed) => {
    trace = observed
  }, () => app.fetch(new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
  }), { upstreamDeadline: deadline.signal }))
  await response.text()
  if (trace === undefined) {
    throw new Error("No trace was observed")
  }

  await trace.finished
  const reference = new WeakRef(trace)
  trace = undefined
  return { status: response.status, reference }
}

const { status, reference } = await send()
deadline.dispose()
await exchangeStarted.promise

// Copilot's keep-alive sockets were opened inside the request; the GitHub response stays open. A
// socket's close reaches the client later on Windows, so wait for it and give each round a timer turn.
copilot.closeAllConnections()
await waitForNoConnections(copilot)
await flushLogs()
for (let round = 0; round < 20; round++) {
  await new Promise((resolve) => setTimeout(resolve, 10))
  gc()
}

process.stdout.write(`${JSON.stringify({
  status,
  exchangeStillOpen: stalledExchange !== undefined && !stalledExchange.writableEnded,
  finishedTraceReachable: reference.deref() !== undefined,
})}\n`)

stalledExchange?.end()
await getUpstreamDispatcher().close().catch(() => {})
copilot.close()
await github.close()
restoreConnections()
redirect.restore()
await fs.rm(home, { recursive: true, force: true })
process.exit(0)
