// Runs in a child started with --expose-gc. Two relay requests go through the in-process app: one
// served with the cached Copilot token, and one whose token Copilot rejects with 401, so the real
// shared token exchange runs and the request is retried. It prints whether either finished
// request's trace is still reachable once both have ended.
import fs from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import os from "node:os"
import path from "node:path"

import type { ProxyConfig } from "../../src/lib/config"
import { redirectGitHubTo, refuseExternalConnections, replyJson, startFakeGitHub } from "./network"

// src/lib/paths reads the home directory on import, so redirect HOME and USERPROFILE (Windows) first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-refresh-trace-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { setupProxyAuth } = await import("../../src/lib/auth")
const { paths } = await import("../../src/lib/paths")
const { createServer } = await import("../../src/server")
const { withTraceObserver } = await import("../../src/lib/request-trace")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs } = await import("../../src/lib/log")
const { upstreamDeadlineCounts } = await import("../../src/lib/deadline")
const { getUpstreamDispatcher } = await import("../../src/lib/upstream-dispatcher")

const gc = (globalThis as { gc?: () => void }).gc
if (gc === undefined) {
  throw new Error("Run with --expose-gc.")
}

const oldToken = "old-fixture-copilot-token"
const newToken = "new-fixture-copilot-token"
const model = "gpt-6-astra"

// GitHub answers the user lookup and the token exchange; nothing else is expected.
let exchanges = 0
const github = await startFakeGitHub((url, _request, response) => {
  if (url.href === "https://api.github.com/copilot_internal/v2/token") {
    exchanges++
    replyJson(response, { token: newToken, refresh_in: 86400 })
    return
  }

  replyJson(response, url.href === "https://api.github.com/user" ? { login: "test" } : {}, url.href === "https://api.github.com/user" ? 200 : 404)
})
const redirect = redirectGitHubTo(github.origin)
const restoreConnections = refuseExternalConnections()

// Copilot accepts the old token until `rejectOld` is set, and the new token always.
let rejectOld = false
const copilot = createHttpServer((request, response) => {
  request.resume()
  request.on("end", () => {
    const token = request.headers.authorization?.replace(/^Bearer /, "")
    if (token !== newToken && (rejectOld || token !== oldToken)) {
      replyJson(response, { error: { message: "unauthorized" } }, 401)
      return
    }

    replyJson(response, {
      id: "resp_ok",
      model,
      created_at: 1,
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
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
await fs.writeFile(paths.copilotTokenPath, JSON.stringify({ token: oldToken, refreshedAt: Date.now(), refreshIn: 86400 }))

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

// Sends one request, reads its response to the end and waits for its trace to finish; only a
// WeakRef to the trace is kept.
const send = async (): Promise<WeakRef<object>> => {
  let trace: { finished: Promise<void> } | undefined
  const response = await withTraceObserver((observed) => {
    trace = observed
  }, () => app.fetch(new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
  })))
  const text = await response.text()
  if (response.status !== 200 || trace === undefined) {
    throw new Error(`Relay answered ${response.status}: ${text.slice(0, 300)}`)
  }

  await trace.finished
  const reference = new WeakRef(trace)
  trace = undefined
  return reference
}

const before = upstreamDeadlineCounts()
const ordinary = await send()
rejectOld = true
const refreshed = await send()
const after = upstreamDeadlineCounts()

// Keep-alive sockets were opened inside a request; closing them leaves only what the relay holds.
await getUpstreamDispatcher().close()
copilot.closeAllConnections()
await flushLogs()
for (let round = 0; round < 20; round++) {
  await new Promise((resolve) => setImmediate(resolve))
  gc()
}

process.stdout.write(`${JSON.stringify({
  exchanges,
  ordinaryReachable: ordinary.deref() !== undefined,
  refreshedReachable: refreshed.deref() !== undefined,
  deadlines: { created: after.created - before.created, disposed: after.disposed - before.disposed },
})}\n`)

copilot.close()
await github.close()
restoreConnections()
redirect.restore()
await fs.rm(home, { recursive: true, force: true })
process.exit(0)
