import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-leak-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const consola = (await import("consola")).default
const { log, setLogLevel } = await import("../../src/lib/log")
const { registerSensitiveOrigin } = await import("../../src/lib/redact")
const { getLogPath, paths } = await import("../../src/lib/paths")
const { createChatCompletions } = await import("../../src/copilot/chat")
const { validateUpstream } = await import("../../src/lib/preflight")

/**
 * Captures what the console sink would render, without writing to stdout.
 *
 * Non-string args are inspected the way a real reporter would, so a secret
 * reaching the console inside an object fails the assertion rather than being
 * flattened to "[object Object]" and passing.
 */
const consoleOutput: Array<string> = []
consola.setReporters([
  {
    log: (logObject: { args: Array<unknown> }) => {
      consoleOutput.push(
        logObject.args
          .map((arg) => (typeof arg === "string" ? arg : inspect(arg)))
          .join(" "),
      )
    },
  },
])

const readActiveLog = async (): Promise<string> => {
  // File writes are fire-and-forget so logging never blocks a request.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const content = await fs.readFile(getLogPath(), "utf8").catch(() => "")
    if (content) {
      return content
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("log file was never written")
}

/** Both sinks, as one string, after giving the fire-and-forget write time. */
const bothSinks = async (): Promise<string> =>
  `${await readActiveLog()}\n${consoleOutput.join("\n")}`

/**
 * A local stand-in for Copilot. Never the real service: these drive the real
 * client, preflight and chat paths, and the whole point is the URL they log.
 */
const startMockUpstream = async (
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
): Promise<{ close: () => Promise<void>; port: number }> => {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("mock upstream did not bind a port")
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        // close() alone waits for existing connections, and the undici client
        // under test keeps its socket alive between requests - the same trap
        // #35 hit in the relay's own shutdown path. Without this the suite
        // hangs instead of finishing.
        server.closeAllConnections()
      }),
    port: address.port,
  }
}

/**
 * Runs a test body against a mock upstream and always closes it.
 *
 * The close must survive a failed assertion. Closing at the end of the test
 * body instead would leave the server listening whenever an assertion throws,
 * holding the event loop open so the runner hangs rather than reporting the
 * failure - which on CI is a job timeout instead of a red test.
 */
const withMockUpstream = async (
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
  body: (port: number) => Promise<void>,
): Promise<void> => {
  const upstream = await startMockUpstream(handler)
  try {
    await body(upstream.port)
  } finally {
    await upstream.close()
  }
}

const proxyConfig = (copilotBaseUrl: string) => ({
  copilotBaseUrl,
  copilotToken: "test-token-never-logged",
  host: "127.0.0.1",
  port: 4142,
  upstreamTimeoutMs: 5_000,
  vsCodeVersion: "1.99.3",
})

test.beforeEach(async () => {
  await fs.rm(paths.logsDir, { force: true, recursive: true })
  consoleOutput.length = 0
  setLogLevel("debug")
})

// Why (#47): the /models preflight is the first upstream call a relay makes, so
// a credential-bearing base URL reaches the log before anything else. This
// drives the real preflight -> client -> HTTPError path against a mock 500.
test("does not leak the base url path when /models fails upstream", async () => {
  await withMockUpstream(
    (_request, response) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "upstream exploded" } }))
    },
    async (port) => {
      const baseUrl = `http://127.0.0.1:${port}/tenant/PREFLIGHT_SENTINEL`
      registerSensitiveOrigin(baseUrl)

      await assert.rejects(
        validateUpstream(proxyConfig(baseUrl), "max"),
        /Failed to validate upstream models|Required Copilot model/,
      )

      // The HTTPError carries the Response, whose url is the full base URL.
      log.error("Startup preflight failed:", new Error("preflight wrapper"), {
        response: { status: 500, url: `${baseUrl}/models` },
      })

      const output = await bothSinks()
      assert.ok(
        !output.includes("PREFLIGHT_SENTINEL"),
        `preflight path leaked the sentinel:\n${output}`,
      )
      assert.ok(output.includes("[redacted]"))
      // The diagnostic that makes the entry useful survives.
      assert.ok(output.includes("500"))
    },
  )
})

// Why: a refused connection is the other common startup failure. Node puts the
// host and port in the error and its cause, and callers quote the URL they
// tried, so this path needs the same protection.
test("does not leak the base url path on a refused connection", async () => {
  // Bind then immediately release, so the port is almost certainly closed.
  const closed = await startMockUpstream(() => undefined)
  const port = closed.port
  await closed.close()

  const baseUrl = `http://127.0.0.1:${port}/tenant/REFUSED_SENTINEL`
  registerSensitiveOrigin(baseUrl)

  await assert.rejects(validateUpstream(proxyConfig(baseUrl), "max"))

  const output = await bothSinks()
  assert.ok(
    !output.includes("REFUSED_SENTINEL"),
    `refused-connection path leaked the sentinel:\n${output}`,
  )
  // The class of failure must still be identifiable.
  assert.match(output, /fetch failed|ECONNREFUSED|upstream failed/)
})
// Why: this is the exact shape src/copilot/chat.ts logUpstreamError builds -
// a nested { response: { status, url, headers, body } } - driven through the
// real createChatCompletions rather than reconstructed by hand.
test("does not leak the base url from the chat nested response shape", async () => {
  await withMockUpstream(
    (_request, response) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "chat upstream boom" } }))
    },
    async (port) => {
      const baseUrl = `http://127.0.0.1:${port}/tenant/CHAT_SENTINEL`
      registerSensitiveOrigin(baseUrl)

      await assert.rejects(
        createChatCompletions(
          proxyConfig(baseUrl),
          {
            max_tokens: 16,
            messages: [{ content: "hi", role: "user" }],
            // Routes through /chat/completions, not the Responses API, which
            // is the branch that calls logUpstreamError.
            model: "claude-opus-5",
            stream: false,
          },
          {
            client: "generic",
            requestedModel: "claude-opus-5",
            timeoutMs: 5_000,
          },
        ),
      )

      const output = await bothSinks()
      assert.ok(
        !output.includes("CHAT_SENTINEL"),
        `chat error path leaked the sentinel:\n${output}`,
      )
      assert.ok(output.includes("[redacted]"))
      // Status and body are the diagnostics worth keeping.
      assert.ok(output.includes("500"))
      assert.ok(output.includes("chat upstream boom"))
    },
  )
})

// Why: fetch reports back a canonicalized URL - host case-folded, default port
// dropped - and strips the fragment before sending. Anchoring on the parsed
// origin is what makes those variants match a policy registered from the
// original config string.
test("redacts canonicalized and fragment-dropped variants", async () => {
  registerSensitiveOrigin(
    "https://CANON-LEAK.test.invalid:443/tenant/CANON_SENTINEL#FRAG_SENTINEL",
  )

  log.error("Failed to create chat completions", {
    response: {
      status: 502,
      // What fetch would report: lowercased host, no :443, no fragment.
      url: "https://canon-leak.test.invalid/tenant/CANON_SENTINEL/chat/completions",
    },
  })

  const output = await bothSinks()
  for (const sentinel of ["CANON_SENTINEL", "FRAG_SENTINEL"]) {
    assert.ok(!output.includes(sentinel), `leaked ${sentinel}:\n${output}`)
  }
  assert.ok(output.includes("[redacted]"))
  assert.ok(output.includes("502"))
})

// Why: hot reload registers the new base URL without removing the old one. A
// request against the previous URL can still be in flight, and its error must
// stay redacted on the way to the log. See #47.
test("keeps redacting the old base url after a new one is registered", async () => {
  registerSensitiveOrigin("https://old-gateway.test.invalid/tenant/OLD_SECRET")
  registerSensitiveOrigin("https://new-gateway.test.invalid/tenant/NEW_SECRET")

  log.error("Failed to create chat completions", {
    inFlight: {
      status: 500,
      url: "https://old-gateway.test.invalid/tenant/OLD_SECRET/chat/completions",
    },
    reloaded: {
      status: 503,
      url: "https://new-gateway.test.invalid/tenant/NEW_SECRET/models",
    },
  })

  const output = await bothSinks()
  for (const sentinel of ["OLD_SECRET", "NEW_SECRET"]) {
    assert.ok(!output.includes(sentinel), `leaked ${sentinel}:\n${output}`)
  }
  // Both origins survive as origins, so the entry still says which gateway.
  assert.ok(output.includes("https://old-gateway.test.invalid[redacted]"))
  assert.ok(output.includes("https://new-gateway.test.invalid[redacted]"))
  assert.ok(output.includes("500"))
  assert.ok(output.includes("503"))
})

// Why: redaction must stay scoped. A public endpoint with no registered policy
// is ordinary diagnostic data and must read back exactly.
test("leaves an unrelated upstream url intact", async () => {
  log.error("Failed to create chat completions", {
    response: {
      status: 500,
      url: "https://api.githubcopilot.com/chat/completions",
    },
  })

  const output = await bothSinks()
  assert.ok(output.includes("https://api.githubcopilot.com/chat/completions"))
})

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})
